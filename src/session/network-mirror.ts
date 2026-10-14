/**
 * M2：网络通道镜像 —— **只读观测**页面自身产生的 SSE 响应，用于产出结构化会话归档。
 *
 * 为什么需要它（DD-06）：站点 DOM 用 CSS Modules 哈希类名、图标按钮无可访问名称，
 * DOM 解析天然脆弱；而流式回答的 SSE 才是会话数据的权威来源（role / 正文 / 思考过程 / 引用）。
 *
 * 边界（R2「不逆向接口」，务必守住）：
 *  - 本模块**只观察页面已经产生的响应**：不构造请求、不改写请求头、不重放、不做并发探测；
 *  - 只读**用户自己**会话的响应体，且只落本机；
 *  - 走的是 Chromium DevTools Protocol 的只读通道（`Network.enable` + `Network.getResponseBody`），
 *    不安装拦截器、不改变页面行为（不用 `Fetch.enable`）。
 *
 * 当前阶段：**探针**。先把真实 SSE 样本抓下来看清结构，再写解析器（避免靠猜写解析逻辑）。
 * 开关：`DSK_CAPTURE_SSE=0` 可关闭样本落盘（解析器落地后默认会关）。
 *
 * 写作用域：`src/session/**`（T2）。
 */
import type { WebContents } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface SseRequest {
  url: string;
  contentType: string;
  startedAt: number;
}

export interface NetworkMirrorOptions {
  /** SSE 样本落盘目录（探针阶段用）；不填则只在内存里回调 */
  sampleDir?: string;
  /** 请求体样本落盘目录（用于搞清"用户消息"在请求体里的确切位置） */
  requestSampleDir?: string;
  /** 捕获到发往站点的请求体时回调（**只读**；把用户自己发出的消息也纳入归档） */
  onRequest?: (info: { url: string; method: string; postData: string }) => void;
  /** 单个样本上限（字符），避免超大响应把磁盘写爆 */
  maxSampleChars?: number;
  /** 只匹配这些关键字的响应（默认 event-stream 或 URL 含 chat/completion） */
  urlKeywords?: string[];
  onSse?: (info: { url: string; contentType: string; body: string; chars: number }) => void;
  logger?: (message: string) => void;
}

export class NetworkMirror {
  private readonly opts: NetworkMirrorOptions;
  private wc: WebContents | null = null;
  private attached = false;
  private readonly pending = new Map<string, SseRequest>();
  private captured = 0;
  private failures = 0;
  private lastError: string | null = null;
  private requestCount = 0;

  // 注意：不用 TS 的构造函数参数属性（strip-only 不支持）
  constructor(opts: NetworkMirrorOptions = {}) {
    this.opts = opts;
  }

  get stats(): {
    captured: number;
    failures: number;
    lastError: string | null;
    attached: boolean;
    requests: number;
  } {
    return {
      captured: this.captured,
      failures: this.failures,
      lastError: this.lastError,
      attached: this.attached,
      requests: this.requestCount,
    };
  }

  /** 挂到内容视图上（只读）。重复调用是幂等的。 */
  attach(wc: WebContents): boolean {
    if (this.attached && this.wc === wc) return true;
    this.detach();
    this.wc = wc;
    try {
      wc.debugger.attach('1.3');
      this.attached = true;
    } catch (e) {
      this.lastError = `debugger.attach 失败：${String((e as Error)?.message ?? e)}`;
      this.log(this.lastError);
      return false;
    }
    wc.debugger.on('message', (_event, method, params) => {
      void this.onMessage(method, params as Record<string, unknown>);
    });
    wc.debugger.on('detach', (_event, reason) => {
      this.attached = false;
      this.log(`debugger 已分离：${reason}`);
    });
    void wc.debugger
      .sendCommand('Network.enable', {})
      .then(() => this.log('Network.enable 完成（只读观测开始）'))
      .catch((e) => {
        this.lastError = `Network.enable 失败：${String((e as Error)?.message ?? e)}`;
        this.log(this.lastError);
      });
    return true;
  }

  detach(): void {
    if (this.wc && this.attached) {
      try {
        this.wc.debugger.detach();
      } catch {
        /* 已分离 */
      }
    }
    this.attached = false;
    this.pending.clear();
    this.wc = null;
  }

  /* ------------------------------------------------------------ 内部 */

  private log(message: string): void {
    this.opts.logger?.(message);
  }

  private shouldCapture(url: string, contentType: string): boolean {
    const keywords = this.opts.urlKeywords ?? ['/chat/completion'];
    if (contentType.includes('text/event-stream')) return true;
    return keywords.some((k) => url.includes(k));
  }

  private async onMessage(method: string, params: Record<string, unknown>): Promise<void> {
    if (method === 'Network.requestWillBeSent') {
      this.handleRequest(params);
      return;
    }
    if (method === 'Network.responseReceived') {
      const requestId = String(params.requestId ?? '');
      const response = (params.response ?? {}) as {
        url?: string;
        mimeType?: string;
        headers?: Record<string, string>;
      };
      const url = String(response.url ?? '');
      const headers = response.headers ?? {};
      const contentType = String(
        headers['content-type'] ?? headers['Content-Type'] ?? response.mimeType ?? '',
      );
      if (!requestId || !this.shouldCapture(url, contentType)) return;
      this.pending.set(requestId, { url, contentType, startedAt: Date.now() });
      this.log(`SSE 开始 → ${url}（${contentType}）`);
      return;
    }

    if (method === 'Network.loadingFinished') {
      const requestId = String(params.requestId ?? '');
      const hit = this.pending.get(requestId);
      if (!hit) return;
      this.pending.delete(requestId);
      await this.collect(requestId, hit);
      return;
    }

    if (method === 'Network.loadingFailed') {
      const requestId = String(params.requestId ?? '');
      const hit = this.pending.get(requestId);
      if (!hit) return;
      this.pending.delete(requestId);
      this.failures += 1;
      this.lastError = `loadingFailed：${String(params.errorText ?? 'unknown')}`;
      this.log(`SSE 失败 → ${hit.url}：${this.lastError}`);
    }
  }

  /**
   * 请求体捕获（**只读**）。
   *
   * 为什么需要：SSE 响应只有 assistant 侧；**用户自己发出的内容在请求体里**。
   * 这里只观察"页面自己已经发出的请求"（`Network.requestWillBeSent`），
   * 不构造请求、不改写请求头、不重放 —— 与 R2 边界一致。
   */
  private handleRequest(params: Record<string, unknown>): void {
    const request = (params.request ?? {}) as {
      url?: string;
      method?: string;
      postData?: string;
      postDataEntries?: { bytes?: string }[];
    };
    const url = String(request.url ?? '');
    if (!this.shouldCapture(url, '')) return;

    let postData = typeof request.postData === 'string' ? request.postData : '';
    if (postData === '' && Array.isArray(request.postDataEntries)) {
      const b64 = request.postDataEntries.find((e) => typeof e?.bytes === 'string')?.bytes;
      if (b64) {
        try {
          postData = Buffer.from(b64, 'base64').toString('utf8');
        } catch {
          /* 解码失败就放弃这条 */
        }
      }
    }
    if (postData === '') return;

    this.requestCount += 1;
    this.log(`请求体捕获 → ${url}（${postData.length} 字符，method=${String(request.method ?? '')}）`);
    this.dumpRequestSample(postData);
    this.opts.onRequest?.({ url, method: String(request.method ?? ''), postData });
  }

  private dumpRequestSample(postData: string): void {
    const dir = this.opts.requestSampleDir;
    if (!dir) return;
    try {
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(dir, `request-${stamp}.json`);
      writeFileSync(file, postData, 'utf8');
      this.log(`请求体样本已落盘：${file}`);
    } catch (e) {
      this.log(`请求体样本落盘失败：${String((e as Error)?.message ?? e)}`);
    }
  }

  /** 取响应体（流已结束，Chromium 此时能给出完整 body）。 */
  private async collect(requestId: string, hit: SseRequest): Promise<void> {
    const wc = this.wc;
    if (!wc) return;
    try {
      const res = (await wc.debugger.sendCommand('Network.getResponseBody', { requestId })) as {
        body?: string;
        base64Encoded?: boolean;
      };
      const raw = String(res?.body ?? '');
      const text = res?.base64Encoded ? Buffer.from(raw, 'base64').toString('utf8') : raw;
      const chars = text.length;
      this.captured += 1;
      this.log(`SSE 完成 → ${hit.url}：${chars} 字符，用时 ${Date.now() - hit.startedAt}ms`);
      this.dumpSample(hit, text);
      this.opts.onSse?.({ url: hit.url, contentType: hit.contentType, body: text, chars });
    } catch (e) {
      this.failures += 1;
      this.lastError = `getResponseBody 失败：${String((e as Error)?.message ?? e)}`;
      this.log(`SSE 取体失败 → ${hit.url}：${this.lastError}`);
    }
  }

  private dumpSample(hit: SseRequest, text: string): void {
    const dir = this.opts.sampleDir;
    if (!dir) return;
    const limit = this.opts.maxSampleChars ?? 2_000_000;
    try {
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = join(dir, `sse-${stamp}.txt`);
      const header =
        `# url: ${hit.url}\n# contentType: ${hit.contentType}\n# chars: ${text.length}` +
        `${text.length > limit ? `（已截断到 ${limit}）` : ''}\n# ---- 原始 SSE ----\n`;
      writeFileSync(file, header + text.slice(0, limit), 'utf8');
      this.log(`样本已落盘：${file}`);
    } catch (e) {
      this.log(`样本落盘失败：${String((e as Error)?.message ?? e)}`);
    }
  }
}
