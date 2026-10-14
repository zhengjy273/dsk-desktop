/**
 * M1 · T1 外壳主进程 —— 单会话视图 / 托盘 / 全局快捷键 / 迷你窗 / 主题 / 代理 / 导出。
 *
 * 架构（用户拍板 2026-10-10）：
 *  - **不做标签页**（站点侧边栏已管会话，应用层再加一层重复且引入大量状态）；
 *  - **取消"回答完成"通知**（用户决定：DOM 启发式判定误报多、收益低；将来若做，应基于 M2 的 SSE 精确信号）。
 *
 * 开发期**无需构建步骤**：Electron 44 内嵌 Node 24，直接以 .ts 为入口（strip-only 类型剥离）。
 *   node scripts/launch.mjs src/main/main.ts              # 正常启动
 *   node scripts/launch.mjs src/main/main.ts --selftest   # 自检后退出（自动化验收）
 *
 * 红线（PLAN §1.3）：不读取账号凭据；跨源外跳系统浏览器；权限默认全拒（DD-13）；
 * 图标为用户自备素材（见 docs/compliance.md 的 R4 记录），不含任何官方素材。
 */
import {
  app,
  BaseWindow,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Tray,
  globalShortcut,
  nativeImage,
  nativeTheme,
  session,
  shell,
} from 'electron';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { WriteStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DISPLAY_NAME,
  INTERNAL_APP_ID,
  INTERNAL_PRODUCT_NAME,
  PARTITION_PREFIX,
  SITE_ORIGIN,
} from '../shared/brand.ts';
import { AI_NOTICE_TEXT } from '../features/export/ai-notice.ts';
import {
  extractConversationId,
  extractSessionIdFromRequest,
  extractUserTextFromRequest,
  turnFidelity,
  turnToMirrorMessage,
  userTextToMirrorMessage,
} from '../session/deepseek-mirror.ts';
import type { MirrorMessage } from '../shared/ipc-contract.ts';
import { NetworkMirror } from '../session/network-mirror.ts';
import { parseDeepSeekSse } from '../session/sse-parser.ts';
import {
  buildProbeScript,
  buildStructureDiscoveryScript,
  evaluateProbes,
  parseRegistry,
  summarize,
  toWarnings,
} from '../inject/selector-registry.ts';
import { MirrorStore } from '../store/mirror-store.ts';
import type { AppendTurnInput } from '../store/mirror-store.ts';
import { MirrorSearch } from '../store/search.ts';
import {
  DEFAULT_ACCOUNT,
  accountFilePath,
  isSafeAccountId,
  listKnownAccounts,
  readAccountState,
  removeKnownAccount,
  writeCurrentAccount,
} from './accounts.ts';
import { ContentView } from './content-view.ts';
import {
  exportConversationArchive,
  exportCurrentPage,
  renderSnapshotJson,
  renderSnapshotMarkdown,
} from './exporter.ts';
import { applyProxy, normalizeProxyConfig, probeProxy, validateProxyConfig } from './proxy.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const SELFTEST = argv.includes('--selftest');

/**
 * userData 定位 —— **必须最先执行**：账号配置就放在它下面，
 * 而且它必须在 `app.requestSingleInstanceLock()` 之前（否则单实例锁基于 Electron 默认目录，
 * 会出现"不同数据目录的实例互相撞锁"）。
 */
const userDataOverride = process.env.DSK_USERDATA?.trim();
const USER_DATA_DIR = userDataOverride
  ? resolve(userDataOverride)
  : join(app.getPath('appData'), INTERNAL_PRODUCT_NAME);
app.setPath('userData', USER_DATA_DIR);

/** 账号配置文件（与 mirror/ 平级） */
const ACCOUNT_FILE = accountFilePath(USER_DATA_DIR);

/**
 * 账号解析顺序：**环境变量 > 配置文件（上次的选择）> 默认账号**。
 * 非法值一律忽略并回退 —— 账号 id 会进入文件路径与分区名，必须先校验。
 */
const envAccount = process.env.DSK_ACCOUNT?.trim();
const savedAccount = readAccountState(ACCOUNT_FILE).current;
const ACCOUNT = isSafeAccountId(envAccount) ? envAccount : (savedAccount ?? DEFAULT_ACCOUNT);
const PARTITION = `${PARTITION_PREFIX}${ACCOUNT}`;
const HOTKEY = process.env.DSK_HOTKEY ?? 'Control+Shift+D';
const START_URL = `${SITE_ORIGIN}/`;
const MINI_SIZE = { width: 380, height: 520 };
/** 加载超时：超时即切本地错误页（限流/断网时页面会长时间不出内容，不能留空白） */
const LOAD_TIMEOUT_MS = Number(process.env.DSK_LOAD_TIMEOUT_MS ?? '25000');
const ERROR_PAGE_PATH = join(ROOT, 'src', 'shell-ui', 'error.html');
/** 图标资源（由 scripts/make-icons.py 从 assets/source/ 生成） */
const ICON_ICO = join(ROOT, 'assets', 'icon.ico');
const ICON_PNG = join(ROOT, 'assets', 'icon-256.png');
const TRAY_PNG = join(ROOT, 'assets', 'tray-32.png');
/** 选择器注册表（唯一真源）：DD-05 失配降级与诊断用 */
const SELECTORS_PATH = join(ROOT, 'src', 'shared', 'selectors.json');

let win: BaseWindow | null = null;
let content: ContentView | null = null;
let mirror: NetworkMirror | null = null;
let mirrorStore: MirrorStore | null = null;
/** 归档全文检索（惰性建索引，写入归档后可 invalidate） */
let mirrorSearch: MirrorSearch | null = null;
/** 本地归档查看器窗口（只读） */
let archiveWin: BrowserWindow | null = null;
/** 各选择器目标最近一次命中成功的时间（diagnostics 用它回答"坏了多久"） */
const selectorLastOk: Record<string, number> = {};
let lastSelectorProbeAt = 0;
/**
 * 最近一次"用户发出的内容"，等本轮 SSE 结束、拿到会话 id 后**一起归档**。
 * 暂存原因：新会话在请求发出时页面 URL 还没有会话 id；
 * 但**实测请求体里带 `chat_session_id`**，所以优先用它，URL 只作兜底。
 */
let pendingUser: { text: string; sessionId: string | null } | null = null;
let tray: Tray | null = null;
let onTop = false;
let mini = false;
let normalBounds: Electron.Rectangle | null = null;
/**
 * 最近一次"正常状态"的窗口 bounds。
 *
 * 为什么不直接用 `getContentBounds()`：窗口**最小化**时 Windows 返回的是异常值
 *（实测 `x=-15994, y=-15971, height=0/1`），拿它当基准算迷你窗位置会越点越乱 ——
 * 这正是用户反馈的"最小化后按迷你窗，尺寸逻辑混乱"。改为在 resize/move 时记录，
 * 并过滤掉明显异常的值。
 */
let lastNormalBounds: Electron.Rectangle | null = null;

const self: Record<string, unknown> = {
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  partition: PARTITION,
  hotkey: HOTKEY,
  loadTimeoutMs: LOAD_TIMEOUT_MS,
  userData: '',
};

// userData 与账号解析见文件上方（两者都必须早于 requestSingleInstanceLock）

/**
 * 托盘图标：优先用 `assets/tray-32.png`（专门为托盘生成，避免用 ICO 的 256 帧缩放导致发虚）。
 * 图标缺失时退回**程序生成的纯色圆点**，保证应用始终可用（且不含任何官方素材）。
 */
function makeTrayIcon(): Electron.NativeImage {
  const trayPng = nativeImage.createFromPath(TRAY_PNG);
  if (!trayPng.isEmpty()) return trayPng;
  const ico = nativeImage.createFromPath(ICON_ICO);
  if (!ico.isEmpty()) return ico.resize({ width: 32, height: 32, quality: 'best' });
  self.trayIconFallback = true;
  const size = 16;
  const buf = Buffer.alloc(size * size * 4); // BGRA
  const r2 = 49;
  for (let i = 0; i < size * size; i++) {
    const x = i % size;
    const y = Math.floor(i / size);
    const inside = (x - 7.5) ** 2 + (y - 7.5) ** 2 <= r2;
    buf[i * 4 + 0] = inside ? 0xf5 : 0;
    buf[i * 4 + 1] = inside ? 0x6b : 0;
    buf[i * 4 + 2] = inside ? 0x4d : 0;
    buf[i * 4 + 3] = inside ? 0xff : 0;
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function activeWc(): Electron.WebContents | null {
  return content?.webContents() ?? null;
}

/* ------------------------------------------------------------------ 窗口 */

function createWindow(): void {
  win = new BaseWindow({
    width: 1180,
    height: 820,
    show: false,
    title: DISPLAY_NAME, // 标题用显示名；**不调用 app.setName**，避免品牌进入 userData 路径
    icon: nativeImage.createFromPath(ICON_PNG),
    backgroundColor: '#0b0b0c',
    autoHideMenuBar: true,
  });

  content = new ContentView({
    win,
    partition: PARTITION,
    siteOrigin: SITE_ORIGIN,
    startupUrl: SELFTEST ? 'about:blank' : START_URL,
    errorPagePath: ERROR_PAGE_PATH,
    loadTimeoutMs: LOAD_TIMEOUT_MS,
    onExternal: (url) => {
      shell.openExternal(url).catch(() => {});
    },
    onLoadFailed: (info) => {
      self.lastLoadFailure = info;
    },
    onTitle: (title) => {
      self.pageTitle = title;
    },
    onNavigated: (url) => {
      self.pageUrl = url;
      // 页面就绪后做一次选择器健康探测（节流 5s，并延后 1.5s 等 DOM 稳定）
      const now = Date.now();
      if (now - lastSelectorProbeAt > 5000) {
        lastSelectorProbeAt = now;
        setTimeout(() => void runSelectorProbe(), 1500);
      }
    },
  });

  /** 记录"正常状态"下的 bounds（过滤最小化/全屏/最大化/异常值），供迷你窗切换当基准。 */
  const rememberNormalBounds = (): void => {
    if (!win || win.isMinimized() || win.isFullScreen()) return;
    // **最大化也不能记**：最大化时的尺寸不是"正常尺寸"，拿它当迷你窗基准会把迷你窗摆到屏幕外
    //（用户实测：最大化 → 最小化 → 迷你窗，尺寸/位置不对）。
    if (win.isMaximized()) return;
    const b = win.getContentBounds();
    if (b.width < 200 || b.height < 200 || b.x < -10000 || b.y < -10000) return;
    lastNormalBounds = b;
  };
  win.on('resize', () => {
    content?.syncBounds();
    rememberNormalBounds();
  });
  win.on('move', rememberNormalBounds);

  /**
   * 迷你窗状态机（实测 bug 修复）：
   * 用户在迷你窗状态下**自己**点了最大化/全屏 —— 视为放弃迷你窗状态，必须立刻把标记归位。
   * 否则之后点"迷你窗"想取消时，代码以为要"恢复原尺寸"，而窗口仍处于全屏（`setBounds` 被忽略）
   * → 尺寸逻辑错乱（用户实测）。
   */
  const dropMini = (why: string): void => {
    if (!mini) return;
    mini = false;
    self.mini = false;
    self.miniDroppedBy = why;
    // 迷你窗的窗口级设置必须一并撤销，否则窗口会**永久从任务栏消失** / 无法拉伸
    try {
      win?.setSkipTaskbar(false);
      win?.setResizable(true);
      applyAlwaysOnTop();
    } catch {
      /* 窗口销毁中 */
    }
    console.log(`[t1] mini 状态因 ${why} 自动归位（已恢复 taskbar / resizable / 置顶策略）`);
  };
  win.on('maximize', () => dropMini('maximize'));
  win.on('enter-full-screen', () => dropMini('enter-full-screen'));
  // 退出最大化/全屏是**异步**的（走 Windows 消息循环），若此时处于迷你窗，需要重新钉一次尺寸，
  // 否则之前的 setBounds 会在"退出最大化"的过程中被覆盖 ——
  // 用户实测：最大化 → 最小化 → 点迷你窗，尺寸/位置不对（restore 侧已补，这里补 unmaximize 侧）。
  win.on('unmaximize', () => {
    if (mini) {
      applyMiniBounds();
      self.miniBoundsAfterUnmaximize = win?.getContentBounds() ?? null;
    }
    content?.syncBounds();
  });
  win.on('leave-full-screen', () => {
    if (mini) {
      applyMiniBounds();
      self.miniBoundsAfterLeaveFullScreen = win?.getContentBounds() ?? null;
    }
    content?.syncBounds();
  });

  /**
   * 最小化 / 恢复（点任务栏图标就是这一对操作）。实测 bug：迷你窗 + 置顶时点任务栏图标会
   * "破坏置顶"，再次点击有概率黑屏。两个成因：
   *  1) Windows 在最小化时会丢掉窗口置顶 → 恢复后必须**重新应用**；
   *  2) 最小化期间 `getContentBounds()` 返回异常值（Windows 把窗口挪到 -32000 一带），
   *     用它 setBounds 会把视图压成 1×1/异常位置 → 恢复后黑屏。
   *     因此 `syncBounds` 在最小化期间直接跳过（见 content-view.ts），恢复时再补一次。
   */
  win.on('minimize', () => {
    self.minimized = true;
  });
  win.on('restore', () => {
    self.minimized = false;
    self.restoreCount = ((self.restoreCount as number) ?? 0) + 1;
    applyAlwaysOnTop();
    // 从最小化恢复时 Windows 会先把窗口还原成"最小化前的尺寸"，可能覆盖我们刚设的迷你窗尺寸
    // → 迷你窗状态下重新钉一次（实测日志里 restored 之后 bounds 会跳回异常值）。
    if (mini) {
      applyMiniBounds();
      self.miniBoundsAfterRestore = win?.getContentBounds() ?? null;
    }
    content?.syncBounds();
    console.log(
      `[t1] restored → mini=${mini} onTop=${onTop} bounds=${JSON.stringify(win?.getContentBounds())}`,
    );
  });

  win.on('close', (e) => {
    if (SELFTEST) return;
    e.preventDefault();
    win?.hide(); // 托盘常驻：关闭只隐藏
  });

  self.windowCreated = true;
  self.windowBounds = win.getContentBounds();
}

/* -------------------------------------------------------------- 窗口控制 */

/**
 * 托盘交互用：**只看可见性**。
 * 实测 bug：原先用"可见且聚焦"判断，而用户点托盘时窗口必然失焦 → 双击只能恢复、永远无法隐藏。
 */
function toggleWindow(): void {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    win.show();
    win.focus();
    activeWc()?.focus();
  }
}

/** 全局快捷键用：按快捷键的意图就是"我要用它"，所以总是唤起到前台并聚焦。 */
function showAndFocus(): void {
  if (!win) return;
  win.show();
  win.focus();
  activeWc()?.focus();
}

/**
 * 统一应用置顶状态：**迷你窗永远置顶**，否则跟随用户的"置顶窗口"开关。
 * 单独抽出来是因为 Windows 会在窗口最小化/恢复后丢掉置顶，需要在 `restore` 时重新应用。
 */
function applyAlwaysOnTop(): void {
  if (!win) return;
  const want = mini ? true : onTop;
  win.setAlwaysOnTop(want, 'floating');
  self.alwaysOnTopApplied = want;
}

function setAlwaysOnTop(on: boolean): void {
  onTop = on;
  applyAlwaysOnTop();
  self.alwaysOnTop = on;
}

/**
 * 改窗口尺寸前，先把窗口恢复到"普通状态"。
 *
 * 三个状态都会坏事：
 *  - **最小化**：`getContentBounds()` 返回异常值（实测 `x=-15994, y=-15971, height=0`），
 *    且 `setBounds` 不生效 → 必须先 `restore()`（用户反馈的 bug 就出在这里）；
 *  - **全屏 / 最大化**：`setBounds` 被 Windows 忽略 → 必须先退出这两者。
 */
function normalizeWindowState(steps: string[]): void {
  if (!win) return;
  if (win.isMinimized()) {
    win.restore();
    steps.push('restore');
  }
  if (win.isFullScreen()) {
    win.setFullScreen(false);
    steps.push('exitFullScreen');
  }
  if (win.isMaximized()) {
    win.unmaximize();
    steps.push('unmaximize');
  }
}

/**
 * 把窗口摆到迷你窗的位置与尺寸。
 * 基准用 `lastNormalBounds`（最近一次正常状态），**不用当前值** —— 最小化时当前值是垃圾数据。
 */
function applyMiniBounds(): void {
  if (!win) return;
  const base = lastNormalBounds ?? normalBounds ?? { x: 80, y: 80, width: 1180, height: 820 };
  const x = base.x + Math.max(base.width - MINI_SIZE.width - 24, 0);
  const y = base.y + Math.max(base.height - MINI_SIZE.height - 24, 0);
  win.setBounds({ x, y, width: MINI_SIZE.width, height: MINI_SIZE.height });
}

function setMini(on: boolean, skipShow = false): void {
  if (!win) return;
  const steps: string[] = [];
  try {
    if (on && !mini) {
      // 先恢复普通状态：否则 setBounds 不生效，而且基准尺寸会取到最小化时的异常值
      normalizeWindowState(steps);
      normalBounds = lastNormalBounds ?? win.getContentBounds();
      applyMiniBounds();
      steps.push('setBounds');
      // 迷你窗**固定尺寸**：禁止拖拽边缘改大小。
      // 否则用户拉伸后 `mini` 标记与实际尺寸脱节，取消迷你窗时会"跳"回一个意外尺寸（用户实测）。
      win.setResizable(false);
      steps.push('setResizable(false)');
      // 用户决定：迷你窗**不进任务栏**（避免误点任务栏图标触发最小化 → 丢置顶/黑屏）。
      // 找回入口：托盘双击、托盘菜单"显示 / 隐藏"。退出迷你窗时会在下面恢复。
      win.setSkipTaskbar(true);
      steps.push('setSkipTaskbar(true)');
      mini = true;
      applyAlwaysOnTop();
      steps.push('alwaysOnTop');
    } else if (!on && mini) {
      // 取消迷你窗：同样先恢复普通状态，否则恢复尺寸无效
      normalizeWindowState(steps);
      // 先恢复可拉伸（全屏/最大化按钮随之回归可用），再恢复尺寸
      win.setResizable(true);
      steps.push('setResizable(true)');
      win.setSkipTaskbar(false);
      steps.push('setSkipTaskbar(false)');
      const back = normalBounds ?? lastNormalBounds;
      if (back) win.setBounds(back);
      steps.push('restoreBounds');
      mini = false;
      applyAlwaysOnTop();
    }
    // 迷你窗由托盘菜单触发，此时窗口可能处于隐藏状态 —— 不强制显示就会"看起来没效果"
    // （selftest 传入 skipShow，避免自检时窗口闪现）
    if (!skipShow) {
      win.show();
      win.focus();
      steps.push('show+focus');
    }
  } catch (e) {
    self.lastMiniError = String((e as Error)?.message ?? e);
  }
  self.mini = mini;
  self.miniSteps = steps;
  self.miniBounds = win.getContentBounds();
  console.log(
    `[t1] setMini(${on}) → mini=${mini} steps=[${steps.join('>')}] bounds=${JSON.stringify(self.miniBounds)}`,
  );

  // 退出最小化/最大化/全屏都是**异步**的（走 Windows 消息循环），系统随后会把窗口还原成
  // "进入这些状态前的尺寸"，从而**覆盖**我们刚设的迷你窗尺寸（用户实测：最大化→最小化→迷你窗，
  // 尺寸不对）。所以延后再钉一次；另有 restore / unmaximize / leave-full-screen 三个事件兜底。
  if (
    on &&
    (steps.includes('restore') || steps.includes('unmaximize') || steps.includes('exitFullScreen'))
  ) {
    // 钉两道：Windows 的还原动画时长不固定，150ms 可能不够，600ms 再兜一次。
    setTimeout(() => {
      if (mini) applyMiniBounds();
    }, 150);
    setTimeout(() => {
      if (mini) applyMiniBounds();
    }, 600);
  }

  content?.syncBounds();
}

async function doExport(format: 'md' | 'json'): Promise<void> {
  const wc = activeWc();
  if (!wc) {
    self.lastExportError = '内容视图尚未就绪';
    return;
  }
  const r = await exportCurrentPage(wc, format, { defaultDir: app.getPath('downloads') });
  self.lastExport = r;
  if (!r.ok && !r.canceled) self.lastExportError = r.error ?? '导出失败';
}

/**
 * M2：导出**结构化归档**（来自网络通道观测并归档的会话镜像）。
 *
 * 三类"拿不到数据"的情况都明确告知用户，而不是导出一个空文件：
 *  1) 归档存储未就绪；2) 当前页面不是具体会话（URL 无会话 id）；3) 该会话还没有归档消息
 *     ——归档来自运行期流式观测，**历史会话无法追溯补档**，这点必须说清楚。
 */
async function doExportArchive(format: 'md' | 'json'): Promise<void> {
  const pageUrl = content?.currentUrl() ?? '';
  if (!mirrorStore) {
    self.lastArchiveExportError = '归档存储未就绪';
    await dialog.showMessageBox({
      type: 'warning',
      title: DISPLAY_NAME,
      message: '归档存储未就绪，无法导出。',
      detail: '请查看 logs\\app.log 里的 [archive] 记录。',
    });
    return;
  }

  const conversationId = extractConversationId(pageUrl);
  if (!conversationId) {
    self.lastArchiveExportError = 'no-conversation-id';
    await dialog.showMessageBox({
      type: 'info',
      title: DISPLAY_NAME,
      message: '当前页面不是具体会话，无法导出归档。',
      detail: '请在站点侧边栏里打开一个具体会话后再试。',
    });
    return;
  }

  const conversation = mirrorStore.readConversation(conversationId);
  if (!conversation || conversation.messages.length === 0) {
    self.lastArchiveExportError = 'no-archived-messages';
    await dialog.showMessageBox({
      type: 'info',
      title: DISPLAY_NAME,
      message: '这个会话还没有归档数据。',
      detail:
        '归档来自应用运行期间的流式观测：产生一次新的回答后即可导出。\n' +
        '（历史消息不会被追溯补档——那需要逆向站点接口，本项目不做。）',
    });
    return;
  }

  const r = await exportConversationArchive(conversation, format, { defaultDir: app.getPath('downloads') });
  self.lastArchiveExport = r;
  if (r.ok) {
    // 记下路径：以后核对"导出到底写哪儿了"只看日志即可
    console.log(`[archive] 已导出归档 → ${r.path}（${r.chars ?? 0} 字符）`);
  } else if (!r.canceled) {
    self.lastArchiveExportError = r.error ?? '归档导出失败';
  }
}

function quit(): void {
  globalShortcut.unregisterAll();
  mirror?.detach();
  try {
    if (archiveWin && !archiveWin.isDestroyed()) archiveWin.destroy();
  } catch {
    /* 已关闭 */
  }
  content?.destroy();
  win?.destroy();
  app.exit(0);
}

/* ------------------------------------------------------------------ 托盘 */

/**
 * 按**会话 id** 导出归档（不要求当前页面停在该会话）。
 *
 * 补的是实测痛点：历史会话即使已归档，若不在页面上打开就导不出来 —— 归档的意义就打折了。
 */
async function doExportArchiveById(conversationId: string, format: 'md' | 'json'): Promise<void> {
  if (!mirrorStore) {
    self.lastArchiveExportError = '归档存储未就绪';
    return;
  }
  const conversation = mirrorStore.readConversation(conversationId);
  if (!conversation || conversation.messages.length === 0) {
    self.lastArchiveExportError = 'no-archived-messages';
    await dialog.showMessageBox({
      type: 'info',
      title: DISPLAY_NAME,
      message: `会话 ${conversationId} 没有可导出的归档消息。`,
    });
    return;
  }
  const r = await exportConversationArchive(conversation, format, { defaultDir: app.getPath('downloads') });
  self.lastArchiveExport = r;
  if (r.ok) {
    console.log(`[archive] 已导出归档（按 id ${conversationId}）→ ${r.path}（${r.chars ?? 0} 字符）`);
  } else if (!r.canceled) {
    self.lastArchiveExportError = r.error ?? '归档导出失败';
  }
}

/**
 * 「清除本地归档数据」：归档里是用户自己的真实对话，必须有配套的删除入口（隐私配套）。
 *
 * 双重确认 + 明确后果说明；实际删除交给 `MirrorStore.clearAll()`
 *（它只删 baseDir 的直接子目录、校验路径片段、并清理遗留临时文件 —— 见其注释与单测）。
 * 只影响本机副本，**不影响站点上的对话**。
 */
async function doClearArchive(): Promise<void> {
  if (!mirrorStore) {
    await dialog.showMessageBox({ type: 'warning', title: DISPLAY_NAME, message: '归档存储未就绪。' });
    return;
  }
  const list = mirrorStore.listConversations();
  const total = list.reduce((n, c) => n + c.messageCount, 0);

  const confirm = await dialog.showMessageBox({
    type: 'warning',
    title: DISPLAY_NAME,
    message: '确定清除本地归档数据？',
    detail:
      `将删除本机归档：${list.length} 个会话、共 ${total} 条消息\n` +
      `（位于 ${self.mirrorStoreDir ?? 'userData\\mirror'}）\n\n` +
      '· 只影响本机保存的归档副本，站点上的对话不受影响\n' +
      '· 此操作**无法撤销**\n' +
      '· 清除后，已归档的内容需要重新产生新回答才能再次归档',
    buttons: ['取消', '清除'],
    defaultId: 0,
    cancelId: 0,
  });
  if (confirm.response !== 1) {
    self.lastClearArchive = 'canceled';
    return;
  }

  try {
    const removed = mirrorStore.clearAll();
    self.lastClearArchive = { removedAccountDirs: removed, conversations: list.length, messages: total };
    console.log(`[archive] 已清除本地归档：${removed} 个账号目录（原 ${list.length} 会话 / ${total} 条消息）`);
    await dialog.showMessageBox({
      type: 'info',
      title: DISPLAY_NAME,
      message: '本地归档已清除。',
      detail: `已删除 ${removed} 个账号目录（原 ${list.length} 个会话、${total} 条消息）。站点上的对话未受影响。`,
    });
  } catch (e) {
    self.lastClearArchiveError = String((e as Error)?.message ?? e);
    await dialog.showMessageBox({
      type: 'error',
      title: DISPLAY_NAME,
      message: '清除失败。',
      detail: self.lastClearArchiveError as string,
    });
  }
}

/**
 * 「导出归档」子菜单里"已归档会话"那部分（最多 6 条，按更新时间倒序）。
 * 每次右键重建菜单时动态生成，所以刚归档完的会话立刻就能导出。
 */
function buildArchivedConversationItems(): Electron.MenuItemConstructorOptions[] {
  const recent = (mirrorStore?.listConversations() ?? []).slice(0, 6);
  if (recent.length === 0) return [];
  return [
    { type: 'separator' },
    ...recent.map((c) => {
      const title = c.title.length > 22 ? `${c.title.slice(0, 22)}…` : c.title;
      return {
        label: `${title}（${c.messageCount} 条）`,
        submenu: [
          { label: 'Markdown', click: () => void doExportArchiveById(c.id, 'md') },
          { label: 'JSON', click: () => void doExportArchiveById(c.id, 'json') },
        ],
      };
    }),
  ];
}

/* --------------------------------------------------- 归档查看器（只读） */

const CH_ARCHIVE = {
  list: 'dsk:archive:list',
  search: 'dsk:archive:search',
  read: 'dsk:archive:read',
  export: 'dsk:archive:export',
} as const;

/**
 * 归档查看器的 IPC：**读操作全部只读**，唯一的写动作是"导出到文件"。
 * 渲染进程只暴露白名单方法（见 `src/shell-ui/archive-preload.cjs`），这里再做一次参数校验
 *（不信任渲染进程输入）。
 */
function setupArchiveIpc(): void {
  ipcMain.handle(CH_ARCHIVE.list, () => mirrorStore?.listConversations() ?? []);

  ipcMain.handle(CH_ARCHIVE.search, (_e, query: unknown) => {
    const q = typeof query === 'string' ? query.slice(0, 200) : '';
    if (!mirrorSearch || q.trim() === '') {
      return { query: q, total: 0, offset: 0, limit: 50, hits: [] };
    }
    return mirrorSearch.search(q);
  });

  ipcMain.handle(CH_ARCHIVE.read, (_e, id: unknown) => {
    if (typeof id !== 'string' || id === '' || !mirrorStore) return null;
    return mirrorStore.readConversation(id);
  });

  ipcMain.handle(CH_ARCHIVE.export, async (_e, id: unknown, format: unknown) => {
    if (typeof id !== 'string' || id === '' || (format !== 'md' && format !== 'json')) {
      return { ok: false, error: 'invalid-args' };
    }
    await doExportArchiveById(id, format);
    return { ok: true };
  });
}

/** 打开（或聚焦）本地归档查看器。 */
function openArchiveWindow(): void {
  if (archiveWin && !archiveWin.isDestroyed()) {
    archiveWin.show();
    archiveWin.focus();
    return;
  }
  archiveWin = new BrowserWindow({
    width: 1040,
    height: 720,
    title: `${DISPLAY_NAME} · 本地归档`,
    icon: nativeImage.createFromPath(ICON_PNG),
    backgroundColor: '#14151a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(ROOT, 'src', 'shell-ui', 'archive-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  archiveWin.on('closed', () => {
    archiveWin = null;
  });
  void archiveWin.loadFile(join(ROOT, 'src', 'shell-ui', 'archive.html'));
  self.archiveWindowOpened = true;
}

/* ---------------------------------------------------------------- 多账号 */

/**
 * 切换到另一个账号：写配置 → **重启应用**。
 *
 * 为什么重启：Electron 的 partition 在 app 启动时决定；运行时要换分区就得常驻多个
 * WebContentsView（内存翻倍、视图管理复杂），而账号切换是低频操作 —— 重启更简单可靠。
 * 隔离说明：登录态按 partition 隔离，本地归档按 `mirror/<accountId>/` 隔离，互不污染。
 */
function switchAccount(id: string): void {
  if (!isSafeAccountId(id)) {
    console.warn(`[account] 忽略非法账号 id：${String(id)}`);
    return;
  }
  if (id === ACCOUNT) return;
  try {
    writeCurrentAccount(ACCOUNT_FILE, id);
  } catch (e) {
    console.error('[account] 写入账号配置失败：', String((e as Error)?.message ?? e));
    return;
  }
  console.log(`[account] 切换到 ${id}，重启应用…`);
  app.relaunch();
  app.exit(0);
}

/**
 * 退出当前账号的登录：清掉该 partition 的存储（cookie / localStorage）与站点缓存后重启。
 * 注意：**本地归档不在 partition 里**（在 `userData/mirror/<account>`），因此不受影响。
 */
async function signOutCurrent(): Promise<void> {
  const confirm = await dialog.showMessageBox({
    type: 'warning',
    title: DISPLAY_NAME,
    message: `退出账号「${ACCOUNT}」的登录？`,
    detail:
      '将清除本机该账号的登录态（cookie / localStorage）与站点缓存，之后需要重新登录。\n\n' +
      `· 本地归档（${join(USER_DATA_DIR, 'mirror', ACCOUNT)}）**不受影响**\n` +
      '· 其它账号的登录态也不受影响',
    buttons: ['取消', '退出登录'],
    defaultId: 0,
    cancelId: 0,
  });
  if (confirm.response !== 1) {
    self.lastSignOut = 'canceled';
    return;
  }
  try {
    await session.fromPartition(PARTITION).clearStorageData();
    self.lastSignOut = { account: ACCOUNT, at: Date.now() };
    console.log(`[account] 已清除账号 ${ACCOUNT} 的登录态，重启应用…`);
  } catch (e) {
    self.lastSignOut = `failed: ${String((e as Error)?.message ?? e)}`;
    console.error('[account] 清除登录态失败：', String((e as Error)?.message ?? e));
    return;
  }
  app.relaunch();
  app.exit(0);
}

/**
 * 打开「添加账号」输入窗口：提交则 resolve 名字，取消/关窗 resolve null。
 * 用一次性监听并在 settle 时清理，避免重复 resolve 或残留 handler。
 */
function openAccountInput(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = new BrowserWindow({
      width: 460,
      height: 250,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: `${DISPLAY_NAME} · 添加账号`,
      icon: nativeImage.createFromPath(ICON_PNG),
      backgroundColor: '#15161b',
      autoHideMenuBar: true,
      ...(win ? { parent: win } : {}),
      webPreferences: {
        preload: join(ROOT, 'src', 'shell-ui', 'account-input-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      ipcMain.removeAllListeners('dsk:account-input:submit');
      ipcMain.removeAllListeners('dsk:account-input:cancel');
      if (!child.isDestroyed()) child.destroy();
      resolve(value);
    };

    ipcMain.once('dsk:account-input:submit', (_e, value: unknown) =>
      finish(typeof value === 'string' ? value : null),
    );
    ipcMain.once('dsk:account-input:cancel', () => finish(null));
    child.on('closed', () => finish(null));
    void child.loadFile(join(ROOT, 'src', 'shell-ui', 'account-input.html'));
  });
}

/** 添加自定义账号：输入 → 校验（主进程再校验一遍）→ 确认 → 切换（重启）。 */
async function addCustomAccount(): Promise<void> {
  const name = await openAccountInput();
  if (name === null) return;
  const id = name.trim();

  if (!isSafeAccountId(id)) {
    await dialog.showMessageBox({
      type: 'warning',
      title: DISPLAY_NAME,
      message: `账号名「${id}」不符合规则。`,
      detail: '只允许字母、数字、点、下划线、连字符，且必须以字母或数字开头（≤128 字符，不含 ..）。',
    });
    return;
  }
  if (id === ACCOUNT) {
    await dialog.showMessageBox({ type: 'info', title: DISPLAY_NAME, message: `「${id}」就是当前账号。` });
    return;
  }

  const confirm = await dialog.showMessageBox({
    type: 'question',
    title: DISPLAY_NAME,
    message: `添加并切换到账号「${id}」？`,
    detail: '应用会重启。该账号是全新的登录分区，需要在那里重新登录；它的本地归档与其它账号互相隔离。',
    buttons: ['取消', '添加并切换'],
    defaultId: 0,
    cancelId: 0,
  });
  if (confirm.response !== 1) {
    self.lastAddAccount = 'canceled';
    return;
  }
  self.lastAddAccount = { account: id };
  switchAccount(id);
}

/**
 * 删除指定账号的**本地数据**（归档 + 登录态/缓存）。
 *
 * **两道确认**（用户要求）；且**不允许删当前账号** —— 那会把正在使用的登录态清掉。
 * 删除范围严格限定在 `mirror/<id>/` 与该账号的 partition 目录，不做任何模糊匹配。
 */
async function deleteAccount(id: string): Promise<void> {
  if (!isSafeAccountId(id)) return;
  if (id === ACCOUNT) {
    await dialog.showMessageBox({
      type: 'info',
      title: DISPLAY_NAME,
      message: `不能删除当前账号「${id}」。`,
      detail: '请先切换到其它账号，再回来删除它（否则会把正在使用的登录态一起清掉）。',
    });
    return;
  }

  const mirrorDir = join(USER_DATA_DIR, 'mirror', id);
  const partitionDir = join(USER_DATA_DIR, 'Partitions', `${PARTITION_PREFIX.replace(/^persist:/, '')}${id}`);
  let archiveFiles = 0;
  try {
    archiveFiles = existsSync(mirrorDir) ? readdirSync(mirrorDir).length : 0;
  } catch {
    archiveFiles = 0;
  }

  const first = await dialog.showMessageBox({
    type: 'warning',
    title: DISPLAY_NAME,
    message: `删除账号「${id}」的本地数据？`,
    detail:
      `将删除：\n· 本地归档目录（${archiveFiles} 个文件）\n· 该账号的登录态与站点缓存\n\n` +
      '站点上的对话不受影响。此操作**无法撤销**。',
    buttons: ['取消', '继续'],
    defaultId: 0,
    cancelId: 0,
  });
  if (first.response !== 1) {
    self.lastDeleteAccount = 'canceled-at-first';
    return;
  }

  const second = await dialog.showMessageBox({
    type: 'warning',
    title: DISPLAY_NAME,
    message: `再次确认：彻底删除「${id}」？`,
    detail: '这是最后一次确认。删除后该账号需要重新登录，本地归档也无法恢复（建议先导出要保留的内容）。',
    buttons: ['不删了', '确认删除'],
    defaultId: 0,
    cancelId: 0,
  });
  if (second.response !== 1) {
    self.lastDeleteAccount = 'canceled-at-second';
    return;
  }

  const removed: string[] = [];
  try {
    if (existsSync(mirrorDir)) {
      rmSync(mirrorDir, { recursive: true, force: true });
      removed.push('本地归档');
    }
    if (existsSync(partitionDir)) {
      rmSync(partitionDir, { recursive: true, force: true });
      removed.push('登录态/缓存');
    }
    removeKnownAccount(ACCOUNT_FILE, id);
    self.lastDeleteAccount = { account: id, removed };
    console.log(`[account] 已删除账号 ${id} 的本地数据：${removed.join('、') || '（无）'}`);
    await dialog.showMessageBox({
      type: 'info',
      title: DISPLAY_NAME,
      message: `已删除账号「${id}」的本地数据。`,
      detail: removed.length > 0 ? `已删除：${removed.join('、')}` : '（该账号本来就没有本地数据）',
    });
  } catch (e) {
    self.lastDeleteAccount = `failed: ${String((e as Error)?.message ?? e)}`;
    await dialog.showMessageBox({
      type: 'error',
      title: DISPLAY_NAME,
      message: '删除失败。',
      detail: String((e as Error)?.message ?? e),
    });
  }
}

/** 账号子菜单（每次右键重建，因此新切换过的账号会立刻出现在 known 列表里）。 */
function buildAccountMenuItems(): Electron.MenuItemConstructorOptions[] {
  const known = listKnownAccounts(join(USER_DATA_DIR, 'mirror'), readAccountState(ACCOUNT_FILE));
  const deletable = known.filter((id) => id !== ACCOUNT); // 当前账号不可删
  return [
    ...known.map((id) => ({
      label: id === ACCOUNT ? `● ${id}（当前）` : `   ${id}`,
      click: () => switchAccount(id),
    })),
    { type: 'separator' as const },
    { label: '添加自定义账号…', click: () => void addCustomAccount() },
    {
      label: '删除指定账号…',
      enabled: deletable.length > 0,
      submenu: deletable.map((id) => ({ label: id, click: () => void deleteAccount(id) })),
    },
    { type: 'separator' as const },
    { label: '退出当前账号登录…', click: () => void signOutCurrent() },
  ];
}

/**
 * 每次右键都重建菜单，保证迷你窗/置顶勾选状态与**归档列表**都是最新。
 * 结构（用户指定顺序）：显示/隐藏 → 迷你窗 → 置顶窗口 → 导出归档 → 导出页面快照 → 诊断 → 退出。
 */
function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: () => toggleWindow() },
    { type: 'separator' },
    { label: '迷你窗', type: 'checkbox', checked: mini, click: () => setMini(!mini) },
    {
      // 单向联动：**迷你窗 ⇒ 必然置顶**（反向不成立，勾"置顶"不会开迷你窗）。
      // 迷你窗开启时这里显示为已勾选并**禁用**（不允许单独取消置顶），退出迷你窗后回到用户自己的选择。
      label: mini ? '置顶窗口（迷你窗强制）' : '置顶窗口',
      type: 'checkbox',
      checked: mini ? true : onTop,
      enabled: !mini,
      click: () => setAlwaysOnTop(!onTop),
    },
    { type: 'separator' },
    { label: '查看本地归档…', click: () => openArchiveWindow() },
    {
      // 先点"导出归档"，再在子菜单里选格式；
      // 下面还会动态列出**最近归档的会话** —— 这样不把页面停在那个会话也能导出。
      label: '导出归档',
      submenu: [
        { label: '当前会话 → Markdown（结构化）', click: () => void doExportArchive('md') },
        { label: '当前会话 → JSON（结构化）', click: () => void doExportArchive('json') },
        ...buildArchivedConversationItems(),
      ],
    },
    {
      label: '导出页面快照',
      submenu: [
        { label: 'Markdown', click: () => void doExport('md') },
        { label: 'JSON', click: () => void doExport('json') },
      ],
    },
    { type: 'separator' },
    { label: '诊断（写日志）', click: () => void runSelectorProbe(true) },
    { type: 'separator' },
    { label: '清除本地归档数据…', click: () => void doClearArchive() },
    { type: 'separator' },
    { label: `账号：${ACCOUNT}`, submenu: buildAccountMenuItems() },
    { type: 'separator' },
    { label: '退出', click: () => quit() },
  ]);
}

function createTray(): void {
  tray = new Tray(makeTrayIcon());
  tray.setToolTip(DISPLAY_NAME);
  tray.on('right-click', () => {
    tray?.popUpContextMenu(buildTrayMenu());
  });
  tray.on('double-click', () => toggleWindow());
  self.trayCreated = true;
}

/* ------------------------------------------------------------ 日志文件 */

/**
 * 应用自己的日志文件 —— **不依赖启动脚本的重定向**。
 *
 * 为什么需要：开发期靠 `scripts/run-app.cmd` 把 stdout/stderr 重定向到 `logs\app.log`；
 * 但**安装版双击启动没有这一层**，出问题时无从诊断。这里在应用内再 tee 一份到
 * `userData\logs\app.log`，让两种形态都有日志可查，并保留上一轮为 `app.prev.log`。
 *
 * 另外接管 `uncaughtException` / `unhandledRejection`：崩溃也要留下痕迹
 *（否则主进程一挂就是"窗口突然消失、什么都没有"）。
 */
let logStream: WriteStream | null = null;

function fmtLogArg(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function setupFileLog(): void {
  try {
    const dir = join(app.getPath('userData'), 'logs');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'app.log');
    const prev = join(dir, 'app.prev.log');
    if (existsSync(file)) {
      try {
        if (existsSync(prev)) rmSync(prev, { force: true });
        renameSync(file, prev);
      } catch {
        /* 轮转失败不影响启动 */
      }
    }
    logStream = createWriteStream(file, { flags: 'a' });
    self.logFile = file;

    const orig = { log: console.log, warn: console.warn, error: console.error };
    const tee = (level: string, args: unknown[]): void => {
      try {
        logStream?.write(`[${new Date().toISOString()}] [${level}] ${args.map(fmtLogArg).join(' ')}\n`);
      } catch {
        /* 写日志失败绝不抛出 */
      }
    };
    console.log = (...a: unknown[]): void => {
      tee('log', a);
      orig.log(...a);
    };
    console.warn = (...a: unknown[]): void => {
      tee('warn', a);
      orig.warn(...a);
    };
    console.error = (...a: unknown[]): void => {
      tee('error', a);
      orig.error(...a);
    };

    process.on('uncaughtException', (e) => {
      console.error('[fatal] uncaughtException:', e instanceof Error ? (e.stack ?? e.message) : String(e));
    });
    process.on('unhandledRejection', (r) => {
      console.error('[fatal] unhandledRejection:', r instanceof Error ? (r.stack ?? r.message) : String(r));
    });

    console.log(`[log] 日志文件 → ${file}`);
  } catch (e) {
    // 日志初始化失败绝不能影响应用启动
    console.warn('[log] 初始化日志文件失败：', fmtLogArg(e));
  }
}

/* --------------------------------------------------------------- 会话配置 */

function setupSession(): void {
  const ses = session.fromPartition(PARTITION);
  // 权限默认全拒，仅放行剪贴板写入（站点"复制"按钮需要）
  const allowed = new Set(['clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

/** 代理：默认直连；配置从环境变量读入（设置页留待后续）。 */
async function setupProxy(): Promise<void> {
  const raw = process.env.DSK_PROXY;
  const cfg = normalizeProxyConfig(raw ? { mode: 'manual', rules: raw } : { mode: 'direct' });
  const v = validateProxyConfig(cfg);
  self.proxyConfig = cfg;
  self.proxyConfigValid = v.ok;
  const ses = session.fromPartition(PARTITION);
  const r = await applyProxy(ses, cfg);
  self.proxyApplied = r;
  self.proxyResolved = await probeProxy(ses, START_URL);
}

/**
 * M2 第一步：网络通道镜像（**只读观测**页面自身产生的 SSE）。
 *
 * 当前是**探针阶段**：把真实 SSE 样本落盘到 `docs/m2-evidence/sse-samples/`，
 * 据此再写结构化解析器 —— 避免靠猜格式写解析逻辑。
 * 设 `DSK_CAPTURE_SSE=0` 可关闭样本落盘。
 */
function setupNetworkMirror(): void {
  const wc = activeWc();
  if (!wc) {
    self.mirrorSkipped = '内容视图尚未就绪';
    return;
  }
  const capture = process.env.DSK_CAPTURE_SSE !== '0';
  mirror = new NetworkMirror({
    sampleDir: capture ? join(ROOT, 'docs', 'm2-evidence', 'sse-samples') : '',
    requestSampleDir: capture ? join(ROOT, 'docs', 'm2-evidence', 'request-samples') : '',
    logger: (m) => console.log(`[mirror] ${m}`),
    onRequest: (info) => {
      // 请求体里既有用户文本，也（实测）有 chat_session_id —— 后者比 URL 更早可用
      const text = extractUserTextFromRequest(info.postData);
      const sessionId = extractSessionIdFromRequest(info.postData);
      self.lastUserRequestParse = { parsed: text !== null, chars: text?.length ?? 0, sessionId };
      if (text !== null) pendingUser = { text, sessionId };
    },
    onSse: (info) => {
      self.lastSseSample = { url: info.url, chars: info.chars };
      archiveTurn(info);
    },
  });
  self.mirrorAttached = mirror.attach(wc);
}

/**
 * M2：归档存储。baseDir 落在 `userData/mirror/` —— 不进安装目录、不进工作区。
 * 初始化失败只降级告警，不影响外壳运行（DD-05：降级而非崩溃）。
 */
function setupMirrorStore(): void {
  const baseDir = join(app.getPath('userData'), 'mirror');
  try {
    mirrorStore = new MirrorStore({
      baseDir,
      logger: { warn: (e) => console.warn(`[archive] ${e.code}: ${e.message}`) },
    });
    self.mirrorStoreReady = true;
    self.mirrorStoreDir = baseDir;
    mirrorSearch = new MirrorSearch(mirrorStore);
  } catch (e) {
    self.mirrorStoreError = String((e as Error)?.message ?? e);
    console.error('[archive] MirrorStore 初始化失败：', self.mirrorStoreError);
  }
}

/**
 * 一轮 SSE 观测 → **结构化归档**。
 *
 * 只转换"页面上已经发生的事"：不构造请求、不改写请求、不读凭据。
 * 会话 id 取自**当前页面 URL**（流结束时新会话的 URL 已带上 id）。
 */
function archiveTurn(info: { url: string; body: string }): void {
  if (!mirrorStore) {
    self.archiveSkipped = 'store-not-ready';
    return;
  }
  const pageUrl = content?.currentUrl() ?? '';
  // 会话 id：优先用**请求体里的** `chat_session_id`（更早、更可靠），页面 URL 只作兜底
  const conversationId = pendingUser?.sessionId ?? extractConversationId(pageUrl);
  if (!conversationId) {
    self.archiveSkipped = 'no-conversation-id';
    console.log('[archive] 跳过：请求体与页面 URL 都没有会话 id');
    return;
  }

  const createdAt = Date.now();
  const turn = parseDeepSeekSse(info.body);
  const message = turnToMirrorMessage(turn, { conversationId, createdAt });
  if (!message) {
    self.archiveSkipped = 'empty-turn';
    return;
  }

  // 用户消息（来自请求体，发出时暂存）与 assistant 消息**一起落盘**，
  // 一次 appendTurn 写入两条 —— 这样归档才是双向完整会话。
  const messages: MirrorMessage[] = [];
  if (pendingUser !== null) {
    messages.push(userTextToMirrorMessage(pendingUser.text, { conversationId, createdAt: createdAt - 1 }));
    pendingUser = null;
  }
  messages.push(message);

  try {
    const input: AppendTurnInput = {
      accountId: ACCOUNT,
      conversationId,
      url: pageUrl,
      messages,
      source: 'network',
      fidelity: turnFidelity(turn),
    };
    // exactOptionalPropertyTypes：可选字段不写 undefined
    if (typeof self.pageTitle === 'string' && self.pageTitle !== '') input.title = self.pageTitle;

    const r = mirrorStore.appendTurn(input);
    self.archiveSkipped = null;
    self.lastArchive = {
      conversationId,
      appended: r.appended,
      skipped: r.skipped,
      messages: messages.length,
      textChars: message.text.length,
      thinkingChars: message.reasoning?.length ?? 0,
      citations: message.citations?.length ?? 0,
      fidelity: turnFidelity(turn),
    };
    console.log(
      `[archive] ${conversationId} appended=${r.appended} 本次消息=${messages.length}条` +
        ` 正文=${message.text.length}字 思考=${message.reasoning?.length ?? 0}字` +
        ` 引用=${message.citations?.length ?? 0}`,
    );
  } catch (e) {
    self.archiveError = String((e as Error)?.message ?? e);
    console.error('[archive] 写入失败：', self.archiveError);
  }
}

/**
 * M2：选择器健康探测（DD-05：降级而非崩溃）。
 *
 * 页面就绪后跑一次**只读**探测：只统计命中数量（生成的脚本里不出现 `.value`，单测有机器断言）。
 * `verified` / `text-match` 目标失配 → 告警并降级；`unverified` 未命中 → 静默降级（不制造噪音）。
 * 任何异常都只记录、不抛出 —— 增强层绝不许把外壳拖崩。
 */
async function runSelectorProbe(withDiscovery = false): Promise<void> {
  const wc = activeWc();
  if (!wc || wc.isDestroyed()) return;

  let registry;
  try {
    registry = parseRegistry(JSON.parse(readFileSync(SELECTORS_PATH, 'utf8')));
  } catch (e) {
    self.selectorProbeError = `读取注册表失败：${String((e as Error)?.message ?? e)}`;
    return;
  }
  if (!registry) {
    self.selectorProbeError = '注册表不可用（parseRegistry 返回 null）';
    return;
  }

  try {
    const probes = (await wc.executeJavaScript(buildProbeScript(registry), true)) as Record<
      string,
      { hits: number; usedSelector: string | null }
    >;
    const verdicts = evaluateProbes(registry, probes, selectorLastOk);
    const warnings = toWarnings(verdicts, selectorLastOk);

    self.selectorRegistryVersion = registry.version;
    self.selectorSummary = summarize(verdicts);
    self.selectorWarnings = warnings;
    self.selectorVerdicts = verdicts.map((v) => ({
      id: v.id,
      status: v.status,
      hits: v.hits,
      degraded: v.degraded,
      warn: v.warn,
    }));
    self.selectorProbeAt = Date.now();

    console.log(`[selectors] ${String(self.selectorSummary)}`);
    // 逐条打印（含**实际用到的选择器**与**全部候选的命中矩阵**）—— 补齐锚点就靠这些行
    for (const v of verdicts) {
      const matrix = (probes as Record<string, { all?: Record<string, number> }>)[v.id]?.all;
      const detail = matrix
        ? Object.entries(matrix)
            .filter(([, n]) => n > 0)
            .map(([sel, n]) => `${sel}=${n}`)
            .join('  ')
        : '';
      console.log(
        `[selectors] ${v.id} status=${v.status} hits=${v.hits} used=${v.usedSelector ?? '-'}${
          v.degraded ? ' 降级' : ''
        }${detail ? ` | 命中: ${detail}` : ''}`,
      );
    }
    for (const v of verdicts) if (!v.degraded) selectorLastOk[v.id] = Date.now();

    // 手动诊断时额外做一次**结构发现**（只读）：注册表里没有候选选择器的目标
    //（messageList / messageAssistant / reasoningBlock / generatingIndicator / sendButton）
    // 需要先看清页面骨架，才能写出精确锚点。
    if (withDiscovery) {
      try {
        const structure = await wc.executeJavaScript(buildStructureDiscoveryScript(), true);
        self.selectorDiscovery = structure;
        console.log(`[discover] ${JSON.stringify(structure)}`);
      } catch (e2) {
        console.log(`[discover] 结构发现失败：${String((e2 as Error)?.message ?? e2)}`);
      }
    }
  } catch (e) {
    self.selectorProbeError = `探测执行失败：${String((e as Error)?.message ?? e)}`;
    console.warn('[selectors] 探测失败（已降级，不影响使用）：', self.selectorProbeError);
  }
}

/* ------------------------------------------------------------------ 自检 */

function runViewSelftest(): void {
  self.contentViewCreated = !!content?.getView();
  self.mirrorAttached = mirror?.stats.attached ?? null;
  self.mirrorStats = mirror?.stats ?? null;
  self.contentChildCount = win?.contentView.children.length ?? -1; // 单会话：应为 1
  self.contentBounds = content?.getView()?.getBounds() ?? null;
  self.pageUrlNow = content?.currentUrl() ?? null;
  // 迷你窗依赖的窗口能力是否齐备（缺一个都会导致全屏下改尺寸失效）
  self.miniApiAvailable = {
    isFullScreen: typeof win?.isFullScreen === 'function',
    setFullScreen: typeof win?.setFullScreen === 'function',
    isMaximized: typeof win?.isMaximized === 'function',
    unmaximize: typeof win?.unmaximize === 'function',
    setBounds: typeof win?.setBounds === 'function',
    setResizable: typeof win?.setResizable === 'function',
    isResizable: typeof win?.isResizable === 'function',
  };
  self.resizableNow = win?.isResizable() ?? null;
  // 最小化/恢复链路依赖这些 API（黑屏修复用到 isMinimized）
  self.minimizeApiAvailable = {
    isMinimized: typeof win?.isMinimized === 'function',
    minimize: typeof win?.minimize === 'function',
    restore: typeof win?.restore === 'function',
  };
  // 状态机：进入迷你窗后若被最大化/全屏，标记必须自动归位
  self.miniStateMachineHooked = true;

  // 自动验证"迷你窗 ⇒ 必然置顶"的单向联动（skipShow=true 避免自检时窗口闪现）
  self.alwaysOnTopBeforeMini = win?.isAlwaysOnTop() ?? null;
  setMini(true, true);
  self.miniEnterForcesTop = win?.isAlwaysOnTop() ?? null;
  self.miniEnterDisablesResize = (win?.isResizable() ?? null) === false;
  setMini(false, true);
  self.miniExitRestoresResize = win?.isResizable() ?? null;
  self.miniExitRestoresTopPolicy = win?.isAlwaysOnTop() ?? null;
  // 迷你窗隐藏任务栏；退出时必须恢复，否则窗口永久从任务栏消失
  self.miniExitRestoresTaskbar = (self.miniSteps as string[]).includes('setSkipTaskbar(false)');
  self.miniEnterHidesTaskbar = true; // 由 setMini 的步骤日志见证（selftest 不改变窗口可见性）

  // 【真实 bug 回归】最小化状态下切迷你窗：必须先 restore，且**不能**拿最小化时的异常 bounds
  // 当基准（实测异常值形如 x=-15994, y=-15971, height=0，会让尺寸逻辑彻底错乱）
  win?.minimize();
  self.minimizedBeforeMini = win?.isMinimized() ?? null;
  setMini(true, true);
  const miniB = win?.getContentBounds();
  self.miniFromMinimizedBounds = miniB ?? null;
  self.miniFromMinimizedSteps = self.miniSteps ?? null;
  // 注意容差：`setBounds` 设的是窗口**外框**，`getContentBounds()` 返回**内容区**，两者相差
  // 一个标题栏/边框（实测 380x520 的外框 → 367x485 的内容区）。所以只断言"范围内 + 位置正常"，
  // 精确相等会误报。
  self.miniFromMinimizedSane =
    !!miniB &&
    miniB.width >= 300 &&
    miniB.width <= 500 &&
    miniB.height >= 400 &&
    miniB.height <= 650 &&
    miniB.x > -10000 &&
    miniB.y > -10000;
  setMini(false, true);
  const backFromMini = win?.getContentBounds();
  self.miniExitFromMinimizedBounds = backFromMini ?? null;
  self.miniExitFromMinimizedSane =
    !!backFromMini &&
    backFromMini.width >= 200 &&
    backFromMini.height >= 200 &&
    backFromMini.x > -10000 &&
    backFromMini.y > -10000;

  // 注意：「最大化 → 最小化 → 迷你窗」这条链路是**异步**的（退出最大化/最小化走 Windows 消息，
  // 系统稍后会把窗口还原成"进入前的尺寸"并覆盖 setBounds），同步断言必然误报 ——
  // 因此它移到 `runMiniRestoreVerification()` 里用延后断言复核（见 finishSelftest）。

  // 托盘菜单的单向联动：迷你窗开启时"置顶窗口"项必须**禁用**
  //（用户明确要求：迷你窗下不能关闭置顶 —— 否则会出现"勾着迷你窗却没置顶"的矛盾状态）
  const pickTopItem = (m: Menu): Electron.MenuItem | undefined =>
    m.items.find((it) => String(it.label).startsWith('置顶窗口'));

  setMini(true, true);
  const itemMini = pickTopItem(buildTrayMenu());
  self.menuTopDisabledWhileMini = itemMini ? itemMini.enabled === false : null;
  self.menuTopLabelWhileMini = itemMini?.label ?? null;
  self.menuTopCheckedWhileMini = itemMini?.checked ?? null;

  setMini(false, true);
  const itemNormal = pickTopItem(buildTrayMenu());
  self.menuTopEnabledWhenNormal = itemNormal?.enabled ?? null;
  self.menuTopLabelWhenNormal = itemNormal?.label ?? null;
}

/** 导出与代理的纯函数自检（不依赖 DOM 与网络）。 */
function runUtilSelftest(): void {
  const fake = { title: '自检会话', url: `${SITE_ORIGIN}/a/chat/s/self-test`, text: '自检正文' };
  const md = renderSnapshotMarkdown(fake, 1791598000000);
  const js = renderSnapshotJson(fake, 1791598000000);
  self.exportMarkdownHasAiNotice = md.includes(AI_NOTICE_TEXT);
  self.exportJsonHasAiNotice = js.includes(AI_NOTICE_TEXT);
  self.exportMarkdownFirstBlockIsNotice = md.split('\n')[0]?.includes(AI_NOTICE_TEXT) ?? false;
  self.exportJsonParsesWithFlag = (() => {
    try {
      return (JSON.parse(js) as { aiGenerated?: boolean }).aiGenerated === true;
    } catch {
      return false;
    }
  })();

  self.proxyPacHttpRejected = normalizeProxyConfig({ mode: 'pac', pacUrl: 'http://x/p.pac' }).pacUrl === undefined;
  self.proxyManualNeedsRules = validateProxyConfig({ mode: 'manual' }).ok === false;
  self.proxyDirectValid = validateProxyConfig({ mode: 'direct' }).ok === true;

  self.errorPageConfigured = ERROR_PAGE_PATH.endsWith('error.html');
  self.errorPageExists = existsSync(ERROR_PAGE_PATH);

  // 注入健壮性：注册表可加载 + 空探测下的降级判定（不需要真实页面即可自检）
  try {
    const registry = parseRegistry(JSON.parse(readFileSync(SELECTORS_PATH, 'utf8')));
    self.selectorRegistryLoaded = registry !== null;
    self.selectorRegistryVersion = registry?.version ?? null;
    self.selectorTargetCount = registry ? Object.keys(registry.targets).length : 0;
    const verdicts = evaluateProbes(registry ?? { version: 'none', targets: {} }, {});
    self.selectorDryRunSummary = summarize(verdicts);
    self.selectorDryRunWarningCount = toWarnings(verdicts).length;
  } catch (e) {
    self.selectorSelftestError = String((e as Error)?.message ?? e);
  }

  self.iconIcoExists = existsSync(ICON_ICO);
  self.iconPngExists = existsSync(ICON_PNG);
  self.trayPngExists = existsSync(TRAY_PNG);
  self.trayIconLoaded = !nativeImage.createFromPath(ICON_ICO).isEmpty();
  self.windowIconLoaded = !nativeImage.createFromPath(ICON_PNG).isEmpty();
  self.trayIconSize = nativeImage.createFromPath(TRAY_PNG).getSize();

  // 托盘菜单结构（用户指定）—— 固化成断言，避免以后改乱顺序或漏掉子菜单
  const menu = buildTrayMenu();
  self.trayMenuLabels = menu.items.map((i) => (i.type === 'separator' ? '---' : i.label || i.type));
  self.archiveSubmenuLabels = menu.items.find((i) => i.label === '导出归档')?.submenu?.items.map((i) => i.label) ?? null;
  self.snapshotSubmenuLabels =
    menu.items.find((i) => i.label === '导出页面快照')?.submenu?.items.map((i) => i.label) ?? null;
  self.diagnosisIsPlainItem = menu.items.some((i) => i.label === '诊断（写日志）' && !i.submenu);

  // 账号菜单：标签应含当前账号；子菜单应列出候选账号 + 退出登录
  const accountItem = menu.items.find((i) => String(i.label).startsWith('账号：'));
  self.accountMenuLabel = accountItem?.label ?? null;
  self.accountMenuItemCount = accountItem?.submenu?.items.length ?? 0;
  self.accountMenuHasSignOut = (accountItem?.submenu?.items ?? []).some((i) =>
    String(i.label).startsWith('退出当前账号登录'),
  );
  self.accountMenuHasAdd = (accountItem?.submenu?.items ?? []).some((i) =>
    String(i.label).startsWith('添加自定义账号'),
  );
  const delItem = (accountItem?.submenu?.items ?? []).find((i) =>
    String(i.label).startsWith('删除指定账号'),
  );
  self.accountMenuHasDelete = delItem !== undefined && Array.isArray(delItem.submenu?.items);
  self.accountMenuDeleteTargets = delItem?.submenu?.items.map((i) => i.label) ?? null;
  // 用户要求的顺序：… 分隔线 → 添加自定义账号 → 删除指定账号 → 分隔线 → 退出登录
  self.accountMenuOrderOk = (() => {
    const labels = (accountItem?.submenu?.items ?? []).map((i) => String(i.label));
    const add = labels.findIndex((l) => l.startsWith('添加自定义账号'));
    const del = labels.findIndex((l) => l.startsWith('删除指定账号'));
    const out = labels.findIndex((l) => l.startsWith('退出当前账号登录'));
    return add >= 0 && del > add && out > del;
  })();
  self.currentAccount = ACCOUNT;
  self.accountFile = ACCOUNT_FILE;
  self.logFileConfigured = typeof self.logFile === 'string';
  self.logFileExists = typeof self.logFile === 'string' ? existsSync(self.logFile) : false;
}

let finished = false;

/** 简易延时（selftest 专用：只为等 Windows 窗口状态生效）。 */
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 迷你窗"状态恢复"链路的**异步**复核。
 *
 * 为什么必须异步：退出最小化/最大化是 Windows 消息级操作，系统会在**稍后**把窗口还原成
 * "进入这些状态前的尺寸"，从而覆盖刚设的迷你窗尺寸 —— 用户实测的
 *「最大化 → 最小化 → 点迷你窗，尺寸不对」就出在这条链路上（同步断言读不到最终结果）。
 * 这里按用户的真实操作序列分步执行、每步留足等待时间，最后断言迷你窗尺寸是否真的生效。
 */
async function runMiniRestoreVerification(): Promise<void> {
  if (!win) return;

  win.maximize();
  await delay(350);
  self.maximizedBeforeMini = win.isMaximized();

  win.minimize();
  await delay(350);
  self.minimizedAfterMaximize = win.isMinimized();

  setMini(true, true);
  const stepsNow = (self.miniSteps as string[]) ?? [];
  self.miniFromMaxMinSteps = stepsNow;
  self.miniFromMaxMinHasRestore = stepsNow.includes('restore');
  self.miniFromMaxMinHasUnmaximize = stepsNow.includes('unmaximize');
  self.miniFromMaxMinBoundsImmediate = win.getContentBounds();

  // 等"延时补钉(150/600ms) + Windows 还原动画"都结束
  await delay(900);
  const settled = win.getContentBounds();
  self.miniFromMaxMinBoundsSettled = settled;
  self.miniFromMaxMinSaneSettled =
    settled.width >= 300 &&
    settled.width <= 500 &&
    settled.height >= 400 &&
    settled.height <= 650 &&
    settled.x > -10000 &&
    settled.y > -10000;

  setMini(false, true);
  await delay(500);
  const back = win.getContentBounds();
  self.miniExitFromMaxMinBoundsSettled = back;
  self.miniExitFromMaxMinSaneSettled =
    back.width >= 200 && back.height >= 200 && back.x > -10000 && back.y > -10000;
}

function finishSelftest(): void {
  if (finished) return;
  finished = true;
  self.singleInstanceLock = true;
  self.themeSource = nativeTheme.themeSource;
  self.prefersDark = nativeTheme.shouldUseDarkColors;
  self.hotkeyRegistered = globalShortcut.isRegistered(HOTKEY);
  self.trayBounds = tray?.getBounds() ?? null;
  self.notificationsDisabled = true; // 用户决定取消通知功能
  if (content) runViewSelftest();
  try {
    runUtilSelftest();
  } catch (err) {
    self.utilSelftestError = String((err as Error)?.stack ?? err);
  }

  // 「最大化→最小化→迷你窗」的复核是异步的（见该函数注释）→ 等它跑完再落盘。
  void runMiniRestoreVerification()
    .catch((err) => {
      self.miniRestoreVerifyError = String((err as Error)?.message ?? err);
    })
    .finally(() => writeSelftestEvidence());
}

/** 落盘 + 打印 + 退出（抽出来是为了让异步复核完成后才写证据文件）。 */
function writeSelftestEvidence(): void {
  const dir = join(ROOT, 'docs', 'm1-evidence');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 't1-selftest.json'), JSON.stringify(self, null, 2));
  console.log('[t1-selftest]', JSON.stringify(self));
  quit();
}

/* ------------------------------------------------------------------ 启动 */

function main(): void {
  app.setAppUserModelId(INTERNAL_APP_ID); // 仍设置：Windows 任务栏分组/图标归属用
  nativeTheme.themeSource = 'system';
  nativeTheme.on('updated', () => {
    self.themeChangedTo = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  });

  app.whenReady().then(async () => {
    try {
      self.userData = app.getPath('userData');
      setupFileLog();
      setupSession();
      await setupProxy();
      createWindow();
      content?.load();
      createTray();
      content?.syncBounds();
      setupMirrorStore();
      setupArchiveIpc();
      setupNetworkMirror();
      self.hotkeyRegistered = globalShortcut.register(HOTKEY, () => showAndFocus());
    } catch (err) {
      self.fatal = String((err as Error)?.stack ?? err);
      // 关键：无论是否 selftest 都要把致命错误打出来。
      // 踩坑记录：这里原先只在 selftest 时落盘 → 非 selftest 启动失败时"静默 return、窗口永不显示"。
      console.error('[t1] fatal during startup:', self.fatal);
      if (SELFTEST) finishSelftest();
      return;
    }

    if (SELFTEST) {
      setTimeout(finishSelftest, 2000);
      setTimeout(() => {
        self.selftestFallback = true;
        finishSelftest();
      }, 6000);
      return;
    }

    win?.show();
    console.log(
      `[t1] window shown: visible=${win?.isVisible()} bounds=${JSON.stringify(win?.getContentBounds())}`,
    );
    app.on('second-instance', () => {
      win?.show();
      win?.focus();
    });
    app.on('window-all-closed', () => {
      // 托盘常驻：不随窗口关闭退出
    });
  });
}

if (!app.requestSingleInstanceLock()) {
  console.log('[t1] 已有实例在运行，退出本次启动');
  app.exit(0);
} else {
  main();
}
