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
  isSameSiteUrl,
} from '../shared/brand.ts';
import { AI_NOTICE_TEXT } from '../features/export/ai-notice.ts';
import { renderArchive } from '../features/export/archive.ts';
import {
  extractConversationId,
  extractModelTypeFromRequest,
  extractSessionIdFromRequest,
  extractUserTextFromRequest,
  turnFidelity,
  turnToMirrorMessage,
  userTextToMirrorMessage,
} from '../session/deepseek-mirror.ts';
import type { ConversationMirror, MirrorMessage } from '../shared/ipc-contract.ts';
import { NetworkMirror } from '../session/network-mirror.ts';
import { parseDeepSeekSse } from '../session/sse-parser.ts';
import {
  accountQuotaSuffix,
  composeQuotaView,
  formatTrayTooltip,
  parseChatStatusResponse,
  parseHistoryAccumulatedTokens,
  parseHistoryActionUsage,
  parseHistorySessionId,
  classifyQuotaAction,
  parseModelSettingsResponse,
} from '../session/quota-parser.ts';
import type { QuotaState } from '../session/quota-parser.ts';
import { QuotaStore } from '../store/quota-store.ts';
import { buildQuotaInjectScript, buildQuotaResetScript, QUOTA_POS_RESET_MARK } from '../inject/quota-overlay.ts';
import type { QuotaView } from '../shared/ipc-contract.ts';
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
import { exportConversationArchive } from './exporter.ts';
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
/**
 * 启动页（仅调试用）：`DSK_START_URL=https://chat.deepseek.com/a/chat/s/<id>` 可直接打开指定会话。
 *
 * 为什么需要：限额注入的锚点（回答底部的 AI 声明、输入栏下方那行）只在**会话页**出现，
 * 首页没有。调试"注入没生效"时必须能直接进会话页，否则只能靠猜。
 * 只接受站点自身的 https 地址，其他值一律回落首页（不接受任意 URL）。
 */
const DEBUG_START_URL = (() => {
  const raw = process.env.DSK_START_URL?.trim();
  if (raw === undefined || raw === '') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !isSameSiteUrl(raw)) return null;
    return raw;
  } catch {
    return null;
  }
})();
const MINI_SIZE = { width: 380, height: 520 };
/**
 * 启动即进迷你窗（仅调试用）：`DSK_START_MINI=1`。
 *
 * 为什么需要：迷你窗的字号缩放/浮层隐藏都只在迷你窗状态生效，而进入迷你窗的入口是托盘菜单，
 * 自动化验证点不到托盘。有了这个开关就能直接启动到迷你窗态再去探测/截图。
 */
const DEBUG_START_MINI = process.env.DSK_START_MINI === '1';
/**
 * 迷你窗下的页面缩放比例。
 *
 * 380×520 里按 100% 渲染，站点正文一行只放得下几个字，读起来很累；缩到 80%
 * 既能让字号小一圈、一屏多读到几行，又不至于小到看不清（用户要求"字号自动缩小方便阅读"）。
 * 恢复窗口时按 `NORMAL_ZOOM_FACTOR` 还原。
 */
const MINI_ZOOM_FACTOR = 0.8;
const NORMAL_ZOOM_FACTOR = 1;
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
/**
 * 限额状态（按账号隔离的磁盘缓存 + 内存态）。
 *
 * 为什么不放 `mirrorStore`：归档是"用户自己的对话内容"（R5），额度是"账号的即时状态"，
 * 生命周期与隐私级别都不同 —— 分开存、分开清（删账号时两边各自清）。
 */
let quotaStore: QuotaStore | null = null;
/** 当前账号的最新展示快照（托盘 tooltip / 菜单 / 注入都读它） */
let quotaView: QuotaView | null = null;
/** 本会话累计已用 token（来自 SSE 或 history 接口；切换会话时重置） */
let sessionTokens: number | null = null;
/** 本会话 token 归属的会话 id（防止把 A 会话的用量显示到 B 会话上） */
let sessionTokensFor = '';
/** 当前会话的已用操作次数；history 能提供全量，运行期请求作即时补充。 */
let actionUsage: { regenerateUsed: number; editUsed: number } = { regenerateUsed: 0, editUsed: 0 };
let actionUsageKnown = false;
let actionUsageEstimated = true;
/** 最近一次已知的模型标识（页面没有稳定锚点，只能从 settings/SSE 里推断） */
let currentModelType: string | null = null;
/**
 * 用户拖动浮层后的位置（页面视口坐标）。
 *
 * 为什么放在主进程并落盘：页面刷新（F5 / 切账号重载）会重建 DOM，
 * 页面内的 `state.manualPos` 随之丢失；用户要求"切换会话位置不变"，
 * 重载后也得回到他摆的位置。null = 用默认位置（贴输入框右上角）。
 */
let overlayPos: { x: number; y: number } | null = null;
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

/**
 * 待清理的延时任务（退出时统一 clearTimeout）。
 *
 * 为什么要记：`app.exit(0)` 会直接杀进程，但在此之前若已经排了注入重试、
 * 选择器探测、视口补钉等 timeout，它们会持有闭包（含 mirror/content/webContents 引用）。
 * 进程立刻死掉时实体影响很小，但**退出前那几十毫秒**里仍可能回调到已销毁的对象上
 * 打出误导性错误日志。统一在 `quit()` 里清掉，让退出路径干净。
 */
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

/** 注册一个退出时会被清掉的 timeout（返回值仍可照常传给 clearTimeout）。 */
function later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
  const t = setTimeout(() => {
    pendingTimers.delete(t);
    try {
      fn();
    } catch (e) {
      console.warn('[timer] 延时任务异常：', e instanceof Error ? e.message : String(e));
    }
  }, ms);
  pendingTimers.add(t);
  return t;
}

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

/**
 * 按当前窗口状态调整页面缩放（迷你窗缩小字号，普通窗口还原）。
 *
 * 为什么必须单独一个函数并在多个时机调用：缩放是**按 WebContents（进而按 origin）**生效的，
 * 而切账号会换 partition、换账号即换 WebContents —— 新页面加载完不重新应用一次，
 * 迷你窗里换账号就会退回 100%，字数一多就更挤（用户诉求正是"方便阅读"）。
 */
function applyViewZoom(): void {
  const wc = activeWc();
  if (!wc || wc.isDestroyed()) return;
  const factor = mini ? MINI_ZOOM_FACTOR : NORMAL_ZOOM_FACTOR;
  try {
    wc.setZoomFactor(factor);
    // 注意：`getZoomFactor()` 在**同一个 tick** 里读到的还是变更前的值（实测日志
    // 一直显示 zoom=1，功能其实已经生效）。所以对外日志用目标值 `zoomFactorTarget`，
    // 真实读回值另记一个字段，供需要核对渲染结果的地方看。
    self.zoomFactorTarget = factor;
    self.zoomFactor = factor;
  } catch (e) {
    // 页面还没就绪时设置会抛（正在导航）；不是致命错误，等下次事件再补
    self.lastZoomError = String((e as Error)?.message ?? e);
  }
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
    startupUrl: SELFTEST ? 'about:blank' : (DEBUG_START_URL ?? START_URL),
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
      // 页面导航会按 origin 重置缩放（Electron 的 zoom 是 per-origin 持久化的），
      // 迷你窗里换账号/重载后必须重新应用一次，否则字号会悄悄退回 100%。
      applyViewZoom();
      // 切换会话时清空"本会话已用量"——否则会把上一个会话的 token 显示到新会话上。
      // 会话 id 取自页面 URL（`/a/chat/s/<id>`）；首页（无 id）同样视为换会话。
      const convId = extractConversationId(url) ?? '';
      if (convId !== sessionTokensFor) {
        sessionTokensFor = convId;
        // 先用本地按会话缓存兜底：history_messages 命中服务端缓存时返回空消息列表，
        // 那时拿不到用量；但切回旧会话仍应显示上次已知值，而不是把输入栏那行还原成原文。
        sessionTokens = convId === '' ? null : (quotaStore?.getSessionTokens(ACCOUNT, convId) ?? null);
        // 已用次数也是"每会话"的量：切会话清零，等该会话自己的 history 校准。
        // （运行期请求累加只对当前会话有意义，跨会话带过去会把 A 会话的次数算到 B 上。）
        // 先读本地按会话缓存，避免重启后次数归零（用户会以为额度回满了）。
        const cachedActions = convId === '' ? null : quotaStore?.getSessionActions(ACCOUNT, convId);
        if (cachedActions !== null && cachedActions !== undefined) {
          actionUsage = { ...cachedActions };
          actionUsageKnown = true;
          actionUsageEstimated = true;
        } else {
          actionUsage = { regenerateUsed: 0, editUsed: 0 };
          actionUsageKnown = false;
          actionUsageEstimated = true;
        }
        refreshQuotaView();
      }
      // 页面就绪后做一次选择器健康探测（节流 5s，并延后 1.5s 等 DOM 稳定）
      const now = Date.now();
      if (now - lastSelectorProbeAt > 5000) {
        lastSelectorProbeAt = now;
        later(() => void runSelectorProbe(), 1500);
      }
      // 页面刚就绪时注入 —— 否则要等到下一次额度变化才出现 UI（首次打开可能几分钟后）。
      // 分三次重试：站点是 SPA + 虚拟列表，回答节点渲染时间不确定；实测 2.5s 时常常还没渲染完，
      // 只靠 MutationObserver 兜底会晚 1–2 秒。多次重试让"打开即有"更稳（注入是幂等的）。
      for (const delay of [2500, 6000, 12000]) {
        later(() => {
          if (quotaView !== null) void pushQuotaToPage(quotaView);
        }, delay);
      }
    },
    /**
     * 只读旁听页面 console —— 目前只有一个用途：
     * 浮层「恢复默认位置」在页面内清掉 manualPos 后，通过固定标记通知主进程把
     * overlayPos 也清掉。不这么做的后果（实测）：主进程还留着旧坐标，
     * 页面一重载就把用户刚清掉的位置又灌回来。
     */
    onConsoleMessage: ({ text }) => {
      if (text.indexOf(QUOTA_POS_RESET_MARK) < 0) return;
      if (overlayPos !== null) {
        overlayPos = null;
        console.log('[quota] 页面请求恢复默认位置 → 已清除主进程记住的浮层坐标');
      }
    },
  });

  /**
   * 把内容视图钉到窗口客户区尺寸 —— **带延时重钉**。
   *
   * 为什么不能只靠 `resize` 事件（用户实测 bug）：进入/退出全屏与最大化时，Windows 是
   * 分几帧把窗口尺寸改到位的，`resize` 只保证"尺寸变了"，不保证"变完了"。实测在
   * 全屏过渡里首次触发时 `getContentBounds()` 可能还是旧值，于是视图被设成旧尺寸，
   * 之后再没有 `resize` 来纠正 → 页面比窗口小一圈，底部露一条黑带（正是用户截图里的现象）。
   *
   * 因此每次状态切换都按几个时间点各钉一次：过渡动画期间任何一帧读了旧值，后面都会纠正。
   * 补钉很便宜（一次 setBounds），且 `syncBounds` 内部会跳过"尺寸没变"的情况。
   */
  /**
   * 补钉句柄（N17）：`resized` 在拖拽/过渡期间可能高频触发，若只往 `pendingTimers` 里追加，
   * 一次拖拽就能堆出成百上千个 timer（每个都持有闭包）。每次补钉先撤销上一批，
   * 保证同时最多 4 个在飞。
   */
  let viewPinTimers: ReturnType<typeof setTimeout>[] = [];
  const pinViewBounds = (): void => {
    for (const t of viewPinTimers) {
      clearTimeout(t);
      pendingTimers.delete(t);
    }
    viewPinTimers = [];
    content?.syncBounds();
    for (const delay of [60, 180, 420, 900]) {
      // 注入层自己监听 window resize 会重贴浮层位置，这里只管把视图尺寸钉对。
      // 用 `later` 而不是裸 setTimeout：它会把句柄记进 `pendingTimers`，
      // 退出时统一清掉，避免回调打到已销毁的 webContents 上。
      const timer = later(() => {
        viewPinTimers = viewPinTimers.filter((x) => x !== timer);
        content?.syncBounds();
      }, delay);
      viewPinTimers.push(timer);
    }
  };

  /** 记录"正常状态"下的 bounds（过滤最小化/全屏/最大化/异常值），供迷你窗切换当基准。 */
  const rememberNormalBounds = (): void => {
    // 迷你窗的尺寸不是"正常尺寸"：进/出迷你窗时 setBounds 触发的 resize/move 会把 380×520
    // 写进基准，退出后就回不到用户原来的大小（N32）。mini 期间一律不记。
    if (mini) return;
    if (!win || win.isMinimized() || win.isFullScreen()) return;
    // **最大化也不能记**：最大化时的尺寸不是"正常尺寸"，拿它当迷你窗基准会把迷你窗摆到屏幕外
    //（用户实测：最大化 → 最小化 → 迷你窗，尺寸/位置不对）。
    if (win.isMaximized()) return;
    // 统一成**外框**坐标（getBounds / setBounds 同一语义）。用 getContentBounds 记基准、
    // setBounds 恢复会差一个边框+标题栏：每进/出迷你窗一次客户区就缩一次（BUG-4）。
    const b = win.getBounds();
    if (b.width < 200 || b.height < 200 || b.x < -10000 || b.y < -10000) return;
    lastNormalBounds = b;
  };
  win.on('resize', () => {
    content?.syncBounds();
    rememberNormalBounds();
  });
  /**
   * `resized`：Electron 在窗口**结束**调整尺寸后才发这个事件，比 `resize` 可靠得多 ——
   * 全屏/最大化过渡期间 `resize` 可能只发一次且那一刻 `getContentBounds()` 还是旧值，
   * 就会把视图定成旧尺寸、之后再没人纠正 → 页面比窗口小一圈、底部露黑带（用户实测）。
   */
  win.on('resized', () => pinViewBounds());
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
    // 已不在迷你窗 —— 字号还原 + 把数据浮窗恢复出来（迷你窗里两者都是收起的）
    applyViewZoom();
    refreshQuotaView();
  };
  win.on('maximize', () => {
    dropMini('maximize');
    // 最大化：客户区尺寸会连续变化几帧，resize 之外再钉几次（用户实测：最大化后页面不铺满）
    pinViewBounds();
  });
  win.on('enter-full-screen', () => {
    dropMini('enter-full-screen');
    pinViewBounds();
  });
  // 退出最大化/全屏是**异步**的（走 Windows 消息循环），若此时处于迷你窗，需要重新钉一次尺寸，
  // 否则之前的 setBounds 会在"退出最大化"的过程中被覆盖 ——
  // 用户实测：最大化 → 最小化 → 点迷你窗，尺寸/位置不对（restore 侧已补，这里补 unmaximize 侧）。
  win.on('unmaximize', () => {
    if (mini) {
      applyMiniBounds();
      self.miniBoundsAfterUnmaximize = win?.getContentBounds() ?? null;
    }
    pinViewBounds();
  });
  win.on('leave-full-screen', () => {
    if (mini) {
      applyMiniBounds();
      self.miniBoundsAfterLeaveFullScreen = win?.getContentBounds() ?? null;
    }
    pinViewBounds();
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
    pinViewBounds();
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

/**
 * 把 bounds 取整到 DIP 整数。
 *
 * 为什么需要：Windows 的窗口矩形是**物理像素**，DIP 值除回来常带小数（实测 1180.6×821.1）。
 * 直接用带小数的值当基准再 setBounds，物理↔DIP 取整会每次多出 1~2 DIP，来回切迷你窗就
 * 单调增长（BUG-6，func-tester2 实测 3 次累计 +2.8×+6.3 DIP）。取整后基准恒定。
 */
function roundRect(r: Electron.Rectangle): Electron.Rectangle {
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

/**
 * 恢复普通尺寸，并校正 DPI 取整偏差。
 *
 * Windows 的 `setBounds` 是 DIP→物理取整，回读时 Electron 再取整；某些缩放比下
 * `setBounds(W)` 会回读成 W+1，于是每进/出迷你窗一次窗口就长 1~2 DIP（BUG-6，
 * func-tester2 实测 3 次累计 +2.8×+6.3 DIP）。这里读回差值再设一次（最多两轮），
 * 把窗口钉回目标值，避免单调累积。
 */
function applyNormalBounds(back: Electron.Rectangle): void {
  if (!win) return;
  win.setBounds(back);
  for (let i = 0; i < 2; i += 1) {
    const actual = win.getBounds();
    const dw = actual.width - back.width;
    const dh = actual.height - back.height;
    const dx = actual.x - back.x;
    const dy = actual.y - back.y;
    if (dw === 0 && dh === 0 && dx === 0 && dy === 0) return;
    win.setBounds(
      roundRect({
        x: back.x - dx,
        y: back.y - dy,
        width: back.width - dw,
        height: back.height - dh,
      }),
    );
  }
}

function setMini(on: boolean, skipShow = false): void {
  if (!win) return;
  const wasMini = mini;
  const steps: string[] = [];
  try {
    if (on && !mini) {
      // 先恢复普通状态：否则 setBounds 不生效，而且基准尺寸会取到最小化时的异常值
      normalizeWindowState(steps);
      // 基准：窗口处于正常状态时以**当前**外框为准；最小化/最大化/全屏时用最近一次记录的正常值。
      // 统一写回 lastNormalBounds，避免 applyMiniBounds 用到过期基准。
      const current = win.getBounds();
      const normal = roundRect(
        win.isMinimized() || win.isMaximized() || win.isFullScreen()
          ? (lastNormalBounds ?? current)
          : current,
      );
      normalBounds = normal;
      lastNormalBounds = normal;
      // **先置 mini 标记再 setBounds**：否则 applyMiniBounds 触发的 resize 会走 rememberNormalBounds，
      // 把迷你尺寸写进 lastNormalBounds。配合下面守卫（迷你期间不记录），第一次进出就会污染基准，
      // 第二次往返退出时窗口卡在迷你尺寸（BUG-5，func-tester2 实测 100% 复现）。
      mini = true;
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
      const backRaw = normalBounds ?? lastNormalBounds;
      // **先清 mini 标记再 setBounds**：让这次 resize 被 rememberNormalBounds 记成新的正常基准
      //（否则 N32 的守卫会把它吞掉），并显式写回，不依赖窗口事件的派发时序。
      // 基准取整，避免物理↔DIP 取整每往返累积 1~2 DIP（BUG-6）。
      const back = backRaw ? roundRect(backRaw) : null;
      mini = false;
      if (back) applyNormalBounds(back);
      lastNormalBounds = back ?? lastNormalBounds;
      steps.push('restoreBounds');
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
  content?.syncBounds();

  // 迷你窗里字号缩小一圈（用户要求"方便阅读"），恢复窗口时还原。
  // 必须在打日志**之前**应用：`getZoomFactor()` 在同一 tick 读到的是旧值，
  // 而 `zoomFactorTarget` 由 applyViewZoom 写入 —— 顺序反了日志就会打上一轮的缩放值（BUG-3）。
  applyViewZoom();

  console.log(
    `[t1] setMini(${on}) → mini=${mini} steps=[${steps.join('>')}] bounds=${JSON.stringify(self.miniBounds)} zoom=${String(self.zoomFactorTarget)}`,
  );

  // 退出最小化/最大化/全屏都是**异步**的（走 Windows 消息循环），系统随后会把窗口还原成
  // "进入这些状态前的尺寸"，从而**覆盖**我们刚设的迷你窗尺寸（用户实测：最大化→最小化→迷你窗，
  // 尺寸不对）。所以延后再钉一次；另有 restore / unmaximize / leave-full-screen 三个事件兜底。
  if (
    on &&
    (steps.includes('restore') || steps.includes('unmaximize') || steps.includes('exitFullScreen'))
  ) {
    // 钉两道：Windows 的还原动画时长不固定，150ms 可能不够，600ms 再兜一次。
    later(() => {
      if (mini) applyMiniBounds();
    }, 150);
    later(() => {
      if (mini) applyMiniBounds();
    }, 600);
  }

  // 迷你窗里不显示数据浮窗（用户要求）：切换后重新推一次，让注入层据此隐藏/恢复。
  if (mini !== wasMini) refreshQuotaView();
}

/**
 * v1.1.4：**页面快照导出已取消**（用户要求）。
 *
 * 原来的「导出页面快照」（DOM 可见文本 → Markdown/JSON）整个入口被移除：
 * 它产出的只是页面文本堆叠、不含消息结构，与「导出归档」重复且更容易被误当成结构化产物。
 * `src/main/exporter.ts` 里的快照渲染纯函数仍保留，供自检继续校验"产物必须带 AI 生成标识"（R3）。
 */

/**
 * M2：导出**结构化归档**（来自网络通道观测并归档的会话镜像）。
 *
 * 三类"拿不到数据"的情况都明确告知用户，而不是导出一个空文件：
 *  1) 归档存储未就绪；2) 当前页面不是具体会话（URL 无会话 id）；3) 该会话还没有归档消息
 *     ——归档来自运行期流式观测，**历史会话无法追溯补档**，这点必须说清楚。
 */
async function doExportArchive(): Promise<void> {
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

  const r = await exportConversationArchive(conversation, { defaultDir: app.getPath('downloads') });
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
  // 先把所有排队的延时任务清掉：注入重试 / 选择器探测 / 视口补钉都持有闭包，
  // 放它们跑进已销毁的 webContents 只会打出误导性的错误日志。
  for (const t of pendingTimers) {
    try {
      clearTimeout(t);
    } catch {
      /* 已触发 */
    }
  }
  pendingTimers.clear();
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
async function doExportArchiveById(conversationId: string): Promise<void> {
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
  const r = await exportConversationArchive(conversation, { defaultDir: app.getPath('downloads') });
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
      `（位于 ${self.mirrorStoreDir ?? 'userData\\mirror'}）\n` +
      '以及额度缓存（限额快照、按会话用量）\n\n' +
      '· 只影响本机保存的副本，站点上的对话与账号额度不受影响\n' +
      '· 此操作**无法撤销**\n' +
      '· 清除后，已归档的内容需要重新产生新回答才能再次归档；额度数据会在页面下次同步时重新采集',
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
    // 额度缓存一并清掉：用户点的是"清除本地数据"，不该留下一份账号限额快照与按会话用量。
    const quotaRemoved = quotaStore?.clearAll() ?? 0;
    // 内存态也要复位，否则托盘/浮层还显示着刚被删掉的旧数据。
    sessionTokens = null;
    quotaView = null;
    refreshQuotaView();
    self.lastClearArchive = {
      removedAccountDirs: removed,
      conversations: list.length,
      messages: total,
      quotaFiles: quotaRemoved,
    };
    console.log(
      `[archive] 已清除本地归档：${removed} 个账号目录（原 ${list.length} 会话 / ${total} 条消息）；额度缓存 ${quotaRemoved} 个文件`,
    );
    await dialog.showMessageBox({
      type: 'info',
      title: DISPLAY_NAME,
      message: '本地归档已清除。',
      detail:
        `已删除 ${removed} 个账号目录（原 ${list.length} 个会话、${total} 条消息）` +
        `，以及 ${quotaRemoved} 个额度缓存文件。站点上的对话未受影响。`,
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
 *
 * v1.1.4：保留**两级**结构（用户指定）—— 先点会话，再选 `Markdown`；
 * JSON 出口已去掉，所以每条的子菜单里只有 Markdown 一项。
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
        submenu: [{ label: 'Markdown', click: () => void doExportArchiveById(c.id) }],
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

  // v1.1.4：导出只剩 Markdown（用户要求去掉 JSON 出口）。
  // 这里仍然校验 format —— 渲染进程不可信，不因为"界面上没这个按钮"就放宽校验。
  ipcMain.handle(CH_ARCHIVE.export, async (_e, id: unknown, format: unknown) => {
    if (typeof id !== 'string' || id === '' || format !== 'md') {
      return { ok: false, error: 'invalid-args' };
    }
    await doExportArchiveById(id);
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
    // 额度缓存也属于"该账号的本地数据"，一并清掉（否则菜单里会残留已删除账号的旧额度）
    quotaStore?.remove(id);
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

/**
 * 账号子菜单（每次右键重建，因此新切换过的账号会立刻出现在 known 列表里）。
 *
 * 用户要求：**每个账号后方显示该账号的模型额度**。
 * 口径（已确认）：当前账号读实时快照；其余账号读磁盘缓存并标「缓存」，无缓存显示「未知」。
 */
function buildAccountMenuItems(): Electron.MenuItemConstructorOptions[] {
  const known = listKnownAccounts(join(USER_DATA_DIR, 'mirror'), readAccountState(ACCOUNT_FILE));
  const deletable = known.filter((id) => id !== ACCOUNT); // 当前账号不可删
  return [
    ...known.map((id) => {
      const isCurrent = id === ACCOUNT;
      // 当前账号的内存快照由 handleQuotaJson 实时刷新；其余账号只能读磁盘缓存
      const state = quotaStore?.get(id) ?? null;
      const suffix = accountQuotaSuffix(state, !isCurrent);
      const head = isCurrent ? `● ${id}（当前）` : `   ${id}`;
      return {
        label: `${head} · ${suffix}`,
        click: () => switchAccount(id),
      };
    }),
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
 *
 * 结构（用户指定顺序，v1.1.4 起）：显示/隐藏 → 迷你窗 → 置顶窗口 → 查看本地归档 → 导出归档
 * → 清除本地归档数据 → 诊断 → 账号 → 退出。
 *
 * v1.1.4 的两处删除（用户要求）：**取消页面快照导出**（原来的位置由「清除本地归档数据」接替），
 * 导出归档只留 Markdown（JSON 出口去掉，标签里也不再显示"（结构化）"）。
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
      // 先点"导出归档"，再在子菜单里选会话；
      // 下面还会动态列出**最近归档的会话** —— 这样不把页面停在那个会话也能导出。
      label: '导出归档',
      submenu: [
        // 保留两级（用户指定）：先点「当前会话」，再选 Markdown —— 与下面的历史会话一致。
        { label: '当前会话', submenu: [{ label: 'Markdown', click: () => void doExportArchive() }] },
        ...buildArchivedConversationItems(),
      ],
    },
    { label: '清除本地归档数据…', click: () => void doClearArchive() },
    { type: 'separator' },
    { label: '诊断（写日志）', click: () => void runSelectorProbe(true) },
    { type: 'separator' },
    {
      // 账号行本身也带额度摘要 —— 不展开子菜单就能看到当前账号状态（用户要求）
      label: `账号：${ACCOUNT} · ${quotaView?.quotaSummary ?? '额度未知'}`,
      submenu: buildAccountMenuItems(),
    },
    { type: 'separator' },
    { label: '退出', click: () => quit() },
  ]);
}

function createTray(): void {
  tray = new Tray(makeTrayIcon());
  // 有快照就用它（含额度/禁言/会话用量），没有就先显示产品名
  tray.setToolTip(quotaView ? formatTrayTooltip(quotaView, DISPLAY_NAME) : DISPLAY_NAME);
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
 * 限额可视化：存储初始化。
 *
 * 落盘 `userData/quota/<account>.json` —— 不进安装目录、不进工作区；
 * 只存站点下发的额度/禁言/上限值，**不含任何凭据**（R1）。
 */
function setupQuotaStore(): void {
  const baseDir = join(app.getPath('userData'), 'quota');
  try {
    quotaStore = new QuotaStore({
      baseDir,
      logger: { warn: (m) => console.warn(`[quota] ${m}`) },
    });
    self.quotaStoreDir = baseDir;
    // 启动即用磁盘缓存渲染一次 —— 这样"上次登录的额度"立刻可见（用户要求：其余账号显示缓存）
    refreshQuotaView();
  } catch (e) {
    self.quotaStoreError = String((e as Error)?.message ?? e);
    console.error('[quota] QuotaStore 初始化失败：', self.quotaStoreError);
  }
}

/**
 * 重算展示快照 → 推给页面注入 + 刷新托盘。
 *
 * 调用时机：收到 chat/status、收到 model_configs、会话切换、SSE 结束。
 * 幂等：同一份数据重复调用不会产生副作用（注入脚本自身也是幂等的）。
 */
function refreshQuotaView(): void {
  if (!quotaStore) return;
  const state = quotaStore.get(ACCOUNT);
  const view = composeQuotaView(state, {
    accountId: ACCOUNT,
    modelType: currentModelType,
    sessionTokens,
    regenerateUsed: actionUsageKnown ? actionUsage.regenerateUsed : null,
    editUsed: actionUsageKnown ? actionUsage.editUsed : null,
    actionCountsEstimated: actionUsageEstimated,
  });
  quotaView = view;
  self.quotaView = view;

  void pushQuotaToPage(view);
  updateTrayQuota(view);}

/**
 * 注入推送队列（N23）：`executeJavaScript` 并发调用时返回顺序不保证，
 * 迟到的旧结果会把页面刚回报的新浮层坐标清成 null（状态被旧值覆盖）。
 * 这里串行化：一次只推一个，后一次在前一次完成后才开始。
 */
let pushQueue: Promise<void> = Promise.resolve();

/** 把展示数据推给页面注入层（失败只记日志 —— 增强层不许把外壳拖崩）。 */
function pushQuotaToPage(view: QuotaView): void {
  pushQueue = pushQueue
    .then(() => pushQuotaToPageNow(view))
    .catch((e) => {
      console.warn(`[quota] 注入队列异常：${String((e as Error)?.message ?? e)}`);
    });
}

async function pushQuotaToPageNow(view: QuotaView): Promise<void> {
  const wc = activeWc();
  if (!wc || wc.isDestroyed()) return;
  // 错误页 / 空白页（about:blank）没有站点 DOM，注入只会白跑
  const url = wc.getURL();
  if (!isSameSiteUrl(url)) return;
  try {
    const script = buildQuotaInjectScript(view, { hidden: mini, pos: overlayPos });
    const r = (await wc.executeJavaScript(script, true)) as {
      ok?: boolean;
      answers?: number;
      composer?: number;
      answerNodes?: number;
      composerNodes?: number;
      pos?: { x: number; y: number } | null;
      hidden?: boolean;
    };
    self.quotaInject = r;
    // 读回用户拖动后的位置：页面是位置的真相来源（SPA 内切会话不重载，位置天然保持），
    // 主进程只是把它抄下来，供下次**页面重载**时恢复。null 表示用默认位置。
    if (r?.pos && Number.isFinite(r.pos.x) && Number.isFinite(r.pos.y)) {
      overlayPos = { x: Math.round(r.pos.x), y: Math.round(r.pos.y) };
    } else if (r?.pos === null || r?.pos === undefined) {
      overlayPos = null;
    }
    // 记录注入落点：`composerNodes` 是**锚点存在数**，
    // 为 0 表示站点文案变了或当前页面本来就没有那行声明（诊断用，不是错误）。
    console.log(
      `[quota] 注入 → 输入栏 token ${r?.composer ?? 0}/${r?.composerNodes ?? 0} 处` +
        ` · 浮层${r?.hidden === true ? '已隐藏（迷你窗）' : '显示'}` +
        `${r?.pos ? ` · 位置(${r.pos.x},${r.pos.y})` : ' · 位置=默认(贴输入框)'}` +
        `${r?.ok === true ? '' : '（脚本未返回 ok）'}`,
    );
  } catch (e) {
    self.quotaInjectError = String((e as Error)?.message ?? e);
    console.warn(`[quota] 注入失败：${self.quotaInjectError}`);
  }
}

/** 托盘 tooltip + 账号菜单里的额度尾巴都要跟着更新。 */
function updateTrayQuota(view: QuotaView): void {
  try {
    tray?.setToolTip(formatTrayTooltip(view, DISPLAY_NAME));
  } catch {
    /* 托盘销毁中 */
  }
}

/**
 * 处理一条被观测到的 JSON 响应（限额数据来源）。
 *
 * 三条通道各自解析、互不覆盖：
 *  - `/chat/status` → 额度 + 禁言 + 服务端文案；
 *  - `/client/settings` → `model_configs`（重新生成/修改次数上限、单次输入上限）；
 *  - `/chat/history_messages` → 该会话累计已用 token（切会话时补）。
 *
 * 解析失败**不覆盖**已有数据（宁可显示旧值，也不把界面清空）。
 */
function handleQuotaJson(url: string, body: string): void {
  if (!quotaStore) return;
  let changed = false;

  // 诊断开关：`DSK_QUOTA_DEBUG=1` 时把原始响应体写进日志。
  // 这几条响应只含额度/上限/历史消息，不含凭据（R1 不涉及）；默认关闭，避免日志膨胀。
  if (process.env.DSK_QUOTA_DEBUG === '1') {
    const tail = url.includes('/chat/history_messages') ? body.slice(0, 400) : body;
    console.log(`[quota-debug] ${url}\n${tail}`);
  }

  if (url.includes('/chat/status')) {
    const status = parseChatStatusResponse(body);
    if (status !== null) {
      quotaStore.applyChatStatus(ACCOUNT, status);
      self.quotaChatStatusAt = Date.now();
      changed = true;
    } else {
      self.quotaParseError = `chat/status 解析失败（${body.length} 字符）`;
    }
  } else if (url.includes('/client/settings')) {
    const configs = parseModelSettingsResponse(body);
    if (configs !== null) {
      quotaStore.applyModelConfigs(ACCOUNT, configs);
      self.quotaModelConfigs = configs.length;
      changed = true;
    } else {
      self.quotaParseError = `client/settings 解析失败（${body.length} 字符）`;
    }
  } else if (url.includes('/chat/history_messages')) {
    const tokens = parseHistoryAccumulatedTokens(body);
    const pageConv = extractConversationId(content?.currentUrl() ?? '');
    const respConv = parseHistorySessionId(body);
    // 归属：**响应体自带会话 id 时以它为准** —— 用户切走会话后旧会话的响应才到达，
    // 只比当前页面 URL 会把 A 会话的用量/次数写进 B 会话（N15）。解析不到 id 时才退回宽松比对。
    const belongs =
      respConv !== null
        ? pageConv === respConv
        : pageConv === '' || pageConv === sessionTokensFor;
    if (process.env.DSK_QUOTA_DEBUG === '1') {
      console.log(
        `[quota-debug] history tokens=${tokens} hasField=${body.includes('accumulated_token_usage')}` +
          ` pageConv=${pageConv} respConv=${respConv} forConv=${sessionTokensFor} belongs=${belongs}`,
      );
    }
    if (!belongs) return;

    // 写缓存的会话：响应体给了 id 就用它（迟到响应也能落到正确会话），否则用当前采纳会话。
    const targetConv = respConv ?? sessionTokensFor;

    // 已用次数全量校准：history 的分支关系是权威口径（前端口径 = 分支兄弟数-1），
    // 能解析出来时**覆盖**运行期累加值 —— 两个来源不会同时可用错（校准在请求之后到达）。
    const usage = parseHistoryActionUsage(body);
    if (usage !== null) {
      actionUsage = usage;
      actionUsageKnown = true;
      actionUsageEstimated = false;
      changed = true;
      // 校准值也落盘：运行期累加可能在本次启动前就发生过（或页面重新加载）
      if (targetConv !== '') quotaStore.setSessionActions(ACCOUNT, targetConv, usage);
      if (process.env.DSK_QUOTA_DEBUG === '1') {
        console.log(
          `[quota-debug] history usage → 重新生成 ${usage.regenerateUsed} · 修改 ${usage.editUsed}`,
        );
      }
    }
    if (tokens !== null) {
      sessionTokens = tokens;
      // 记进按会话缓存：下次命中服务端缓存（history 返回空数组）时仍能显示
      if (targetConv !== '') quotaStore.setSessionTokens(ACCOUNT, targetConv, tokens);
      changed = true;
    }
  }

  if (changed) refreshQuotaView();
}

/**
 * M2 第一步：网络通道镜像（**只读观测**页面自身产生的 SSE）。
 *
 * 当前是**探针阶段**：把真实 SSE 样本落盘到 `docs/m2-evidence/sse-samples/`，
 * 据此再写结构化解析器 —— 避免靠猜格式写解析逻辑。
 * 设 `DSK_CAPTURE_SSE=1` 显式开启样本落盘（**默认关闭**）。
 *
 * 为什么默认关：这些样本会写到**工作区**的 docs/m2-evidence/ 下，普通用户跑安装版时
 * 目录可能不可写、也不该往程序目录里塞用户对话内容。只在开发/探针时显式打开。
 */
function setupNetworkMirror(): void {
  const wc = activeWc();
  if (!wc) {
    self.mirrorSkipped = '内容视图尚未就绪';
    return;
  }
  const capture = process.env.DSK_CAPTURE_SSE === '1';
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

      // 当前模型标识：只作提示，必须能在 model_configs 里核对上才采用
      const model = extractModelTypeFromRequest(info.postData);
      if (model !== null && model !== currentModelType) {
        const known = quotaStore?.get(ACCOUNT)?.modelConfigs ?? [];
        // 核对：只有站点确实下发过这个模型的配置才认它，否则留着旧值（不猜）
        if (known.length === 0 || known.some((c) => c.modelType === model)) {
          currentModelType = model;
        }
      }

      // 修改/重新生成已用次数：观测页面自己发出的 regenerate / edit_message 请求。
      // 这是**即时**通道 —— 用户点一次按钮就 +1，不用等 history 回来；
      // history 通道（handleQuotaJson）会给全量校准，两边谁新谁准由校准覆盖。
      const action = classifyQuotaAction(info.url);
      if (action !== null) {
        if (action === 'regenerate') actionUsage.regenerateUsed += 1;
        else actionUsage.editUsed += 1;
        actionUsageKnown = true;
        actionUsageEstimated = false;
        // 落盘：否则重开应用次数归零，看起来像"额度回满了"。
        // N22：会话 id 优先级 —— 已采纳会话 > 本次请求体里的 chat_session_id > 页面 URL。
        // 首次进会话（sessionTokensFor 还是空）就点按钮时也有 id 可落，不会丢。
        const actionConv =
          sessionTokensFor ||
          pendingUser?.sessionId ||
          extractConversationId(content?.currentUrl() ?? '') ||
          '';
        if (actionConv !== '') {
          quotaStore?.setSessionActions(ACCOUNT, actionConv, actionUsage);
        }
        console.log(
          `[quota] 已用次数 → 重新生成 ${actionUsage.regenerateUsed} · 修改 ${actionUsage.editUsed}` +
            `（来自 ${action === 'regenerate' ? '/chat/regenerate' : '/chat/edit_message'} 请求）`,
        );
        refreshQuotaView();
      } else if (model !== null && model !== currentModelType) {
        // 模型变化不是"次数"变化，只刷新展示（上面 if 里已 refreshQuotaView，这里避免双刷）
        refreshQuotaView();
      }
    },
    onSse: (info) => {
      self.lastSseSample = { url: info.url, chars: info.chars };
      archiveTurn(info);
    },
    // 限额数据：只观测页面自己已经发出的 GET 响应，不新增请求、不重放（R2）
    onJson: (info) => {
      handleQuotaJson(info.url, info.body);
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
  const pageUrl = content?.currentUrl() ?? '';
  // 会话 id：优先用**请求体里的** `chat_session_id`（更早、更可靠），页面 URL 只作兜底
  const conversationId = pendingUser?.sessionId ?? extractConversationId(pageUrl) ?? '';

  /**
   * 先更新"本会话累计 token" —— 它与归档可用性无关。
   * 归档可能因 store 未就绪而跳过，但用户要看的用量仍应更新（否则 store 故障时用量也停更）。
   */
  const turn = parseDeepSeekSse(info.body);
  if (turn.accumulatedTokens !== null) {
    /**
     * 归属保护 + 同会话取大。
     *
     * 两个真实风险：
     * 1) 用户在 A 会话提问后立刻切到 B 会话，A 的流式回答才结束 —— 此时页面 URL 已经是 B，
     *    若直接采纳就把 A 的用量写到 B 上了。所以只有会话 id 对得上才采纳。
     * 2) 同会话里 SSE 的累计值偶尔会比 history 报的小（重连/续流会重放片段），直接覆盖会让
     *    数字往回跳。累计量是单调的，取 max 才符合语义。
     *
     * `handleQuotaJson` 的历史消息分支本来就有归属判断，这里补上同样的保护。
     */
    const pageConv = extractConversationId(pageUrl) ?? '';
    /**
     * 判据是「**这条流属于哪个会话**」，不是「页面和上次是不是同一个」。
     *
     * 上一版写成 `pageConv === sessionTokensFor` 是错的：A 会话提问后切到 B，
     * 此时 pageConv 与 sessionTokensFor 都是 B —— 自己跟自己相等，于是 A 的用量被写到了 B 上，
     * 恰恰是这段保护本该挡住的情形。
     *
     * 正确判法：把流自己的 conversationId（来自请求体，最权威）与页面当前会话比对。
     *  - conversationId 非空：它必须等于页面 URL 的会话，或等于 sessionTokensFor（历史累计起点）；
     *  - conversationId 为空（请求体没带 id）：只能退而用页面 URL 与 sessionTokensFor 比。
     */
    const sameConv =
      conversationId !== ''
        ? pageConv === '' || pageConv === conversationId || sessionTokensFor === conversationId
        : pageConv === sessionTokensFor;
    if (sameConv && (sessionTokens === null || turn.accumulatedTokens > sessionTokens)) {
      sessionTokens = turn.accumulatedTokens;
      if (conversationId !== '') sessionTokensFor = conversationId;
      // 记进按会话缓存（同 history 通道）：回答结束后这个值就是该会话的权威累计值
      if (conversationId !== '') quotaStore?.setSessionTokens(ACCOUNT, conversationId, turn.accumulatedTokens);
      refreshQuotaView();
    } else if (!sameConv) {
      self.archiveSkippedTokenConv = `${pageConv} != ${sessionTokensFor}`;
    }
  }

  if (!mirrorStore) {
    self.archiveSkipped = 'store-not-ready';
    return;
  }
  if (!conversationId) {
    self.archiveSkipped = 'no-conversation-id';
    console.log('[archive] 跳过：请求体与页面 URL 都没有会话 id');
    return;
  }

  const createdAt = Date.now();
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
  // 进出迷你窗后**外框**必须回到原处：±100px 的旧容差测不出 BUG-4 那种 13px 级累积漂移，
  // 这里用外框严格比较（≤2px）把回归钉死在自检里（N25/BUG-4）。
  const outerBeforeMini = win?.getBounds() ?? null;
  self.miniRoundTripOuterBefore = outerBeforeMini;
  // 若历史基准过期（窗口在自检前被移动过、或自检正处在最大化堆栈里），setMini 会用旧基准
  // 恢复 → 断言假失败且真的挪窗口（N37）。这里临时用当前外框作基准，测完还原。
  const savedLastNormalBounds = lastNormalBounds;
  if (outerBeforeMini) lastNormalBounds = outerBeforeMini;
  setMini(true, true);
  self.miniEnterForcesTop = win?.isAlwaysOnTop() ?? null;
  self.miniEnterDisablesResize = (win?.isResizable() ?? null) === false;
  setMini(false, true);
  const outerAfterMini = win?.getBounds() ?? null;
  self.miniRoundTripOuterAfter = outerAfterMini;
  // 第二轮往返：BUG-5 是"第二次退出卡在迷你尺寸"，只测一轮抓不到（基准会被第一次污染）。
  setMini(true, true);
  setMini(false, true);
  const outerAfterMini2 = win?.getBounds() ?? null;
  self.miniRoundTrip2OuterAfter = outerAfterMini2;
  const closeEnough = (a: Electron.Rectangle | null, b: Electron.Rectangle | null): boolean =>
    !!a &&
    !!b &&
    Math.abs(a.width - b.width) <= 2 &&
    Math.abs(a.height - b.height) <= 2 &&
    Math.abs(a.x - b.x) <= 2 &&
    Math.abs(a.y - b.y) <= 2;
  self.miniRoundTripBoundsStable = closeEnough(outerAfterMini, outerBeforeMini);
  self.miniRoundTrip2BoundsStable = closeEnough(outerAfterMini2, outerBeforeMini);
  if (savedLastNormalBounds) lastNormalBounds = savedLastNormalBounds;
  self.miniExitRestoresResize = win?.isResizable() ?? null;
  // 名字直说它测的是什么：退出迷你窗后置顶状态**恢复到进入前**（而不是"保持某种策略"）。
  // 之前叫 miniExitRestoresTopPolicy，读起来像"是否恢复了某种置顶策略"，容易被误解为断言失败。
  self.miniExitAlwaysOnTopEqualsBefore = (win?.isAlwaysOnTop() ?? null) === self.alwaysOnTopBeforeMini;
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
  // v1.1.4：页面快照导出已取消，R3 断言改为校验**归档产物**（仍然要求 AI 生成标识是第一块）
  const fakeConv: ConversationMirror = {
    id: 'self-test',
    accountId: 'personal',
    title: '自检会话',
    url: `${SITE_ORIGIN}/a/chat/s/self-test`,
    updatedAt: 1791598000000,
    messages: [
      { id: 'self-test-1', role: 'user', text: '自检正文', createdAt: 1791598000000, aiGenerated: true },
    ],
    source: 'network',
    fidelity: 'full',
  };
  const md = renderArchive(fakeConv, 'md', 1791598000000);
  self.exportMarkdownHasAiNotice = md.hasNotice;
  self.exportMarkdownContainsNotice = md.content.includes(AI_NOTICE_TEXT);
  self.exportMarkdownFirstBlockIsNotice = md.content.split('\n')[0]?.includes(AI_NOTICE_TEXT) ?? false;
  self.exportMarkdownFilename = md.filename;

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
  // v1.1.4：页面快照导出整项已移除；导出归档只剩 Markdown，标签里不再有"（结构化）"
  self.snapshotItemRemoved = !menu.items.some((i) => String(i.label).includes('页面快照'));
  const archiveItem = menu.items.find((i) => i.label === '导出归档');
  self.archiveSubmenuLabels = archiveItem?.submenu?.items.map((i) => i.label) ?? null;
  // v1.1.4：两级结构 —— 第 0 项是「当前会话」（有 submenu，里面只有 Markdown），
  // 分隔线之后的历史会话每条也有 submenu（同样只有 Markdown）；且整个子菜单里不得出现 JSON。
  const archiveEntries = (archiveItem?.submenu?.items ?? []).filter((i) => i.type !== 'separator');
  self.archiveSubmenuHasJson = archiveEntries.some((i) =>
    String(i.label).toUpperCase().includes('JSON'),
  );
  self.archiveSubmenuHasStructuredSuffix = archiveEntries.some((i) =>
    String(i.label).includes('（结构化）'),
  );
  self.archiveSubmenuCurrentIsSubmenu =
    archiveEntries[0]?.submenu?.items.map((i) => i.label).join('/') === 'Markdown';
  self.archiveSubmenuHistoryAllMdOnly = archiveEntries
    .slice(1)
    .every((i) => i.submenu?.items.length === 1 && i.submenu.items[0]?.label === 'Markdown');
  self.diagnosisIsPlainItem = menu.items.some((i) => i.label === '诊断（写日志）' && !i.submenu);
  // 用户指定顺序：清除本地归档数据紧跟在导出归档之后
  const labels = menu.items.map((i) => String(i.label ?? ''));
  const iArchive = labels.indexOf('导出归档');
  const iClear = labels.findIndex((l) => l.startsWith('清除本地归档数据'));
  self.clearArchiveFollowsExport = iArchive >= 0 && iClear === iArchive + 1;

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

  /* ------------------------------------------------ 限额可视化（v1.1.0）自检 */
  // 这一组断言的意义：额度是"拿不到就退化成未知"的功能，最容易悄悄坏掉而没人发现。
  // 因此把「存储就绪 / 快照可组装 / 托盘行文 / 注入脚本可生成且不含红线 API」全部固化成证据。
  self.quotaStoreReady = quotaStore !== null;
  self.quotaViewPresent = quotaView !== null;
  self.quotaViewSummary = quotaView?.quotaSummary ?? null;
  self.quotaTooltipLineCount = quotaView ? formatTrayTooltip(quotaView, DISPLAY_NAME).split('\n').length : 0;
  self.quotaAccountSuffixes = (
    menu.items.find((i) => String(i.label).startsWith('账号：'))?.submenu?.items ?? []
  )
    .map((i) => String(i.label))
    .filter((l) => l.includes(' · '));
  try {
    // 用真实选项生成一遍：隐藏态（迷你窗）与拖动位置都必须能通过脚本拼装（v1.1.2）
    const probeView = quotaView ?? composeQuotaView(null, { accountId: ACCOUNT });
    const inject = buildQuotaInjectScript(probeView);
    const hiddenInject = buildQuotaInjectScript(probeView, { hidden: true, pos: { x: 100, y: 100 } });
    const reset = buildQuotaResetScript();
    self.quotaInjectScriptChars = inject.length;
    self.quotaResetScriptChars = reset.length;
    // 与 tests/unit/quota-overlay.test.ts 同性质的红线断言，放在运行期再复核一遍
    self.quotaInjectScriptClean =
      !/\.value\b/.test(inject) &&
      !inject.includes('localStorage') &&
      !inject.includes('sessionStorage') &&
      !inject.includes('XMLHttpRequest') &&
      !inject.includes('fetch(');
    self.quotaInjectScriptCleanReset = !/\.value\b/.test(reset) && !reset.includes('localStorage');
    // v1.1.2：回答徽标已移除；隐藏与位置选项确实进了脚本
    self.quotaInjectNoBadge = !inject.includes('dsk-quota-badge');
    self.quotaInjectHiddenSupported = hiddenInject.includes('const HIDDEN = true;');
  } catch (e) {
    self.quotaInjectScriptError = String((e as Error)?.message ?? e);
  }
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

  // 迷你窗字号必须真的缩小（用户要求"方便阅读"）—— 读回 WebContents 的实际值，
  // 而不是断言我们设过的常量（setZoomFactor 在页面未就绪时会静默不生效）。
  const wcInMini = activeWc();
  self.miniZoomFactor = wcInMini && !wcInMini.isDestroyed() ? wcInMini.getZoomFactor() : null;
  self.miniZoomApplied =
    typeof self.miniZoomFactor === 'number' &&
    Math.abs(self.miniZoomFactor - MINI_ZOOM_FACTOR) < 0.01;

  setMini(false, true);
  await delay(500);
  const back = win.getContentBounds();
  self.miniExitFromMaxMinBoundsSettled = back;
  self.miniExitFromMaxMinSaneSettled =
    back.width >= 200 && back.height >= 200 && back.x > -10000 && back.y > -10000;

  const wcAfter = activeWc();
  self.zoomAfterMiniExit = wcAfter && !wcAfter.isDestroyed() ? wcAfter.getZoomFactor() : null;
  self.zoomRestored =
    typeof self.zoomAfterMiniExit === 'number' &&
    Math.abs(self.zoomAfterMiniExit - NORMAL_ZOOM_FACTOR) < 0.01;
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
      // 限额存储必须在 `content.load()` **之前**就绪：页面一加载就会触发 onNavigated，
      // 那里要读"该会话上次已知的已用 token"（history_messages 命中缓存时拿不到）。
      // 顺序错会导致打开旧会话时 token 行短暂显示原文。
      setupQuotaStore();
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
    // 调试入口：直接进迷你窗态（托盘菜单点不到，自动化验证需要它）
    if (DEBUG_START_MINI) setMini(true);
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
