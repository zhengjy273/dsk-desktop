/**
 * M1 · T1：**唯一的内容视图**（单会话，无标签页）。
 *
 * 架构决策（用户拍板 2026-10-10，取代"多标签 + 标签栏"）：
 *   站点自带的侧边栏已经承担会话管理，应用层再做一层标签与之**重复**、费内存，
 *   而且会引入大量状态（实测连续出过：黑屏、限流、误报通知、视图可见性等问题）。
 *   因此本应用只做一件事：在窗口里显示**一个** `chat.deepseek.com` 页面。
 *
 * 本模块负责：视图创建与加固（隔离/沙箱/权限/跨源外跳）、导航、**加载失败与超时切本地错误页**。
 *
 * 写作用域：`src/main/**`（T1）。
 */
import { BaseWindow, WebContentsView } from 'electron';
import { pathToFileURL } from 'node:url';
import type { Rectangle } from 'electron';
import { isSameSiteUrl } from '../shared/brand.ts';

export interface ContentViewDeps {
  win: BaseWindow;
  partition: string;
  siteOrigin: string;
  startupUrl: string;
  /** 本地错误页路径（加载失败/超时时显示，带重试按钮） */
  errorPagePath?: string;
  /** 加载超时毫秒数（0 或省略表示不启用） */
  loadTimeoutMs?: number;
  onExternal?: (url: string) => void;
  onLoadFailed?: (info: { code: number; desc: string; url: string; timedOut?: boolean }) => void;
  onTitle?: (title: string) => void;
  onNavigated?: (url: string) => void;
  /**
   * 页面 console 消息（只读旁听）。
   *
   * 用途：注入层没有 preload 通道（contextIsolation + sandbox），某些"页面 → 主进程"
   * 的单向通知只能走 console。目前只有一个消费者：浮层「恢复默认位置」时把主进程
   * 记住的坐标清掉（否则页面重载会把旧坐标灌回来）。
   * **只读**：不拦截、不改写页面输出。
   */
  onConsoleMessage?: (info: { text: string }) => void;
}

export class ContentView {
  private readonly deps: ContentViewDeps;
  private view: WebContentsView | null = null;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRequestedUrl = '';
  private showingErrorPage = false;
  private loadFailures = 0;

  // 注意：不用 TS 的构造函数参数属性（Electron 走 strip-only 类型剥离，不支持该语法）
  constructor(deps: ContentViewDeps) {
    this.deps = deps;
  }

  getView(): WebContentsView | null {
    return this.view;
  }

  webContents(): Electron.WebContents | null {
    return this.view?.webContents ?? null;
  }

  /** 当前实际 URL（错误页时为 file:...，调用方可用 currentSiteUrl 拿站点地址） */
  currentUrl(): string {
    const wc = this.view?.webContents;
    if (!wc || wc.isDestroyed()) return '';
    return wc.getURL();
  }

  /** 最近一次请求的站点地址（错误页时用它显示重试目标） */
  currentSiteUrl(): string {
    return this.lastRequestedUrl || this.deps.startupUrl;
  }

  get failureCount(): number {
    return this.loadFailures;
  }

  /** 创建（仅一次）并挂到窗口。 */
  ensure(): WebContentsView {
    if (this.view) return this.view;
    const view = new WebContentsView({
      webPreferences: {
        partition: this.deps.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true, // 沙箱已修复可用（docs/compliance.md）
        spellcheck: false,
      },
    });
    const wc = view.webContents;

    // 跨源一律外跳系统浏览器，应用内不开新窗口（DD-13 / V14）
    // 用严格 origin 比较：`startsWith` 会把 `https://chat.deepseek.com.evil.com` 当成站内。
    wc.setWindowOpenHandler(({ url }) => {
      if (!isSameSiteUrl(url, this.deps.siteOrigin)) this.deps.onExternal?.(url);
      return { action: 'deny' };
    });

    /*
     * 主框架级的站外跳转也要挡住。
     *
     * `setWindowOpenHandler` 只覆盖 `window.open` / `target=_blank`；而 `location.href = ...`
     * 或站点被劫持后跳外站，走的是**主框架导航** —— 不拦的话外站页面会直接加载进这个壳里，
     * 窗口标题还是 "DeepSeek Chat"，用户看不出已经离开站点。
     * `will-redirect` 同理：站点自身的 3xx 跳转也要过一遍同样的判断。
     */
    // `file:` 只放行本地错误页本身：错误页里的「重试」跳回站点由上面的同源判断放行。
    // 之前放行任意 `file:` 等价于允许页面把本地任意文件加载进壳里（N16）。
    const errorPageUrl = this.deps.errorPagePath
      ? pathToFileURL(this.deps.errorPagePath).href
      : null;
    const isErrorPageUrl = (u: string): boolean =>
      // showErrorPage 生成的 URL 一定带 `?code=&desc=&retry=`，严格相等会让这个闸门对真实错误页
      // 恒失效（N31）：错误页自身若再导航/重试回错误页，会被当成"站外跳转"再弹一次浏览器。
      errorPageUrl !== null && (u === errorPageUrl || u.startsWith(`${errorPageUrl}?`));
    const blockOffsite = (e: Electron.Event, url: string) => {
      const u = String(url);
      if (isSameSiteUrl(u, this.deps.siteOrigin) || isErrorPageUrl(u) || u === 'about:blank') return;
      e.preventDefault();
      this.deps.onExternal?.(u);
    };
    /**
     * `will-navigate` / `will-redirect` 共用的站外拦截。
     *
     * 两种回调签名并存：
     * - 旧版位置参数：`(event, url, isInPlace, isMainFrame, …)`；
     * - 新版单个 `details` 参数：**它本身就是事件对象**（`Event<Params>` 把 preventDefault 与
     *   url/isMainFrame 合并在一起）。
     * 所以先看第一个参数是否自带 `url`，没有再退回位置参数（N35）—— 原先只查第二个参数，
     * 新版分支永不命中；一旦上游移除旧参数，args[1] 变 undefined，所有主框架跳转会被按空 URL
     * 拦掉（比 N26 更严重）。
     */
    const blockNavigation = (...args: unknown[]): void => {
      const first = args[0];
      const details =
        typeof first === 'object' && first !== null && 'url' in (first as object)
          ? (first as { url?: unknown; isMainFrame?: unknown })
          : null;
      const target = details ? String(details.url ?? '') : String(args[1] ?? '');
      const isMainFrame = details ? details.isMainFrame !== false : args[3] !== false;
      if (!isMainFrame) return;
      blockOffsite((details ?? first) as unknown as Electron.Event, target);
    };
    wc.on('will-navigate', blockNavigation);
    // `will-redirect` 会为 iframe 的 3xx 也触发；只拦主框架，避免子框架跳转也弹系统浏览器（N26）。
    wc.on('will-redirect', blockNavigation);

    // 页面 console 只读旁听（注入层的"恢复默认位置"通知走这里）
    // Electron 新版回调签名是 (details)：{ message, level, lineNumber, sourceId }；
    // 旧版是 (event, level, message, line, sourceId)。两种都兼容一下，避免升级后静默失效。
    wc.on('console-message', (...args: unknown[]) => {
      const first = args[0] as { message?: unknown } | undefined;
      const text =
        first && typeof first.message === 'string'
          ? first.message
          : typeof args[2] === 'string'
            ? args[2]
            : '';
      if (text) this.deps.onConsoleMessage?.({ text });
    });

    wc.on('page-title-updated', () => this.deps.onTitle?.(wc.getTitle()));
    wc.on('did-finish-load', () => {
      this.clearLoadTimer();
      const wasErrorPage = this.showingErrorPage;
      this.showingErrorPage = false;
      const url = wc.getURL();
      if (url && !url.startsWith('file:')) {
        this.lastRequestedUrl = url;
        this.deps.onNavigated?.(url);
      } else if (wasErrorPage) {
        // 回到错误页本身也算加载完成；不要覆盖 lastRequestedUrl
      }
      this.deps.onTitle?.(wc.getTitle());
    });
    wc.on('did-navigate', (_e, url) => {
      if (!String(url).startsWith('file:')) {
        this.lastRequestedUrl = String(url);
        this.deps.onNavigated?.(String(url));
      }
    });
    /**
     * 站点是 SPA：点侧栏切会话走的是 `history.pushState`，**不触发 `did-navigate`**，
     * 只会触发 `did-navigate-in-page`。漏掉它会导致会话 id 永远停在上一次加载的地址：
     * 按会话的 token 缓存取不到、拖动的浮层位置也不会按会话重算（用户实测"切会话后用量不对"）。
     */
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return;
      if (!String(url).startsWith('file:')) {
        this.lastRequestedUrl = String(url);
        this.deps.onNavigated?.(String(url));
      }
    });
    wc.on('did-fail-load', (_e, code, desc, target, isMainFrame) => {
      if (!isMainFrame) return;
      // -3 = ABORTED：通常是导航被下一次导航打断，属正常
      if (code === -3) return;
      this.loadFailures += 1;
      console.log(`[view] load-failed code=${code} desc=${desc} url=${String(target).slice(0, 70)}`);
      this.deps.onLoadFailed?.({ code, desc, url: String(target) });
      this.showErrorPage({ code, desc, url: this.lastRequestedUrl || String(target) });
    });

    this.deps.win.contentView.addChildView(view);
    this.view = view;
    this.syncBounds();
    return view;
  }

  /** 导航到指定地址（省略则用启动地址）。 */
  load(url?: string): void {
    const view = this.ensure();
    const target = url ?? this.deps.startupUrl;
    this.lastRequestedUrl = target;
    this.showingErrorPage = false;
    this.startLoadTimer();
    console.log(`[view] navigate -> ${target.slice(0, 90)}`);
    void view.webContents.loadURL(target).catch((e) => {
      const msg = String((e as Error)?.message ?? e);
      if (!msg.includes('-3') && !msg.includes('ABORTED')) console.log(`[view] navigate rejected: ${msg}`);
    });
  }

  /** 重新加载当前站点地址（错误页的"重试"也走这里）。 */
  reload(): void {
    this.load(this.currentSiteUrl());
  }

  /**
   * 窗口尺寸变化时必须调用：WebContentsView 的 bounds 不会自动布局。
   *
   * 返回是否真的改动了视图尺寸 —— 调用方据此判断"这次同步是不是白跑"。
   */
  syncBounds(): boolean {
    if (!this.view || !this.deps.win) return false;
    // 最小化期间**不要**动视图尺寸：Windows 会把最小化窗口的 bounds 报告成异常值
    //（例如坐标 -32000 或 0 尺寸），用它 setBounds 会把视图压成 1×1/异常位置，
    // 恢复后表现为"黑屏"（用户实测：迷你窗+置顶时点任务栏图标）。
    // 恢复时由 main.ts 的 `restore` 事件重新调用本方法。
    if (this.deps.win.isMinimized()) return false;
    const b = this.deps.win.getContentBounds();
    const next = {
      x: 0,
      y: 0,
      width: Math.max(b.width, 1),
      height: Math.max(b.height, 1),
    };
    let prev: Rectangle | null = null;
    try {
      prev = this.view.getBounds();
    } catch {
      prev = null;
    }
    let changed = false;
    try {
      const same =
        prev !== null &&
        prev.x === next.x &&
        prev.y === next.y &&
        prev.width === next.width &&
        prev.height === next.height;
      if (!same) {
        this.view.setBounds(next as Rectangle);
        changed = true;
      }
    } catch {
      /* 窗口销毁中 */
    }
    // 全屏/最大化"页面没同步缩放、底部露黑带"的排查开关（用户实测过）。
    // 只在需要时打开，正常使用不产生噪音日志。
    if (process.env.DSK_VIEW_DEBUG === '1') {
      let parentBounds = 'n/a';
      try {
        const pb = this.deps.win.contentView.getBounds();
        parentBounds = `${pb.width}x${pb.height}`;
      } catch {
        parentBounds = 'err';
      }
      console.log(
        `[view-debug] syncBounds changed=${changed}` +
          ` win=${JSON.stringify(b)}` +
          ` parent=${parentBounds}` +
          ` prev=${prev === null ? 'null' : `${prev.width}x${prev.height}`}` +
          ` next=${next.width}x${next.height}` +
          ` zoom=${String(safeZoom(this.view))}` +
          ` max=${String(this.deps.win.isMaximized())}` +
          ` fs=${String(this.deps.win.isFullScreen())}`,
      );
    }
    return changed;
  }

  destroy(): void {
    this.clearLoadTimer();
    try {
      if (this.view) {
        this.deps.win.contentView.removeChildView(this.view);
        this.view.webContents.close();
      }
    } catch {
      /* 已销毁 */
    }
    this.view = null;
  }

  /* ------------------------------------------------------------ 内部 */

  private startLoadTimer(): void {
    this.clearLoadTimer();
    const ms = this.deps.loadTimeoutMs ?? 0;
    if (!ms) return;
    this.loadTimer = setTimeout(() => {
      this.loadTimer = null;
      const wc = this.view?.webContents;
      if (!wc || wc.isDestroyed() || this.showingErrorPage) return;
      if (wc.isLoading()) {
        this.loadFailures += 1;
        console.log(`[view] load-timeout after ${ms}ms`);
        this.deps.onLoadFailed?.({
          code: -1,
          desc: `加载超时（>${ms / 1000}s）`,
          url: this.lastRequestedUrl,
          timedOut: true,
        });
        this.showErrorPage({ code: -1, desc: `加载超时（超过 ${ms / 1000} 秒）`, url: this.lastRequestedUrl });
      }
    }, ms);
  }

  private clearLoadTimer(): void {
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.loadTimer = null;
  }

  /** 切到本地错误页（带重试按钮）。绝不显示空白。 */
  private showErrorPage(info: { code: number; desc: string; url: string }): void {
    const view = this.view;
    if (!view || !this.deps.errorPagePath) return;
    if (this.showingErrorPage) return;
    this.showingErrorPage = true;
    this.clearLoadTimer();
    const base = pathToFileURL(this.deps.errorPagePath).toString();
    const q =
      `?code=${encodeURIComponent(String(info.code))}` +
      `&desc=${encodeURIComponent(info.desc)}` +
      `&retry=${encodeURIComponent(info.url)}`;
    void view.webContents.loadURL(`${base}${q}`).catch(() => {
      /* 本地页不应失败 */
    });
  }
}

/** 读页面缩放比例（仅诊断日志用，读不到返回 null）。 */
function safeZoom(view: WebContentsView): number | null {
  try {
    return view.webContents.getZoomFactor();
  } catch {
    return null;
  }
}
