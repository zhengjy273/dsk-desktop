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
    wc.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith(this.deps.siteOrigin)) this.deps.onExternal?.(url);
      return { action: 'deny' };
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

  /** 窗口尺寸变化时必须调用：WebContentsView 的 bounds 不会自动布局。 */
  syncBounds(): void {
    if (!this.view || !this.deps.win) return;
    // 最小化期间**不要**动视图尺寸：Windows 会把最小化窗口的 bounds 报告成异常值
    //（例如坐标 -32000 或 0 尺寸），用它 setBounds 会把视图压成 1×1/异常位置，
    // 恢复后表现为"黑屏"（用户实测：迷你窗+置顶时点任务栏图标）。
    // 恢复时由 main.ts 的 `restore` 事件重新调用本方法。
    if (this.deps.win.isMinimized()) return;
    const b = this.deps.win.getContentBounds();
    try {
      this.view.setBounds({
        x: 0,
        y: 0,
        width: Math.max(b.width, 1),
        height: Math.max(b.height, 1),
      } as Rectangle);
    } catch {
      /* 窗口销毁中 */
    }
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
