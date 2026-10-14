/**
 * M0 spike —— 验证 chat.deepseek.com 能否在 Electron 壳内正常使用。
 *
 * 设计约束（对应方案 §1.3 红线）：
 *  - R1 不接触账号凭据：本文件不存在任何读取输入框/表单/localsStorage token 的代码路径；
 *       快照脚本只读 document.title、文本长度、元素计数与"AI 生成"标记命中情况。
 *  - R2 不逆向接口：本文件不 fetch/XHR 任何站点接口，只记录"页面自身已经产生"的请求头与响应头。
 *  - R3 不破坏生成标识：spike 不注入任何 CSS/JS 到站点页面（注入是 M1 的事）。
 *  - cookie 只记录"名字/域/过期时间"，**永不记录值**。
 *
 * 用法：
 *   electron spike/main.mjs --auto     # 跑完自动化检查后自动退出（用独立 userData，可与交互模式并存）
 *   electron spike/main.mjs            # 交互模式：你自己登录，Ctrl+Shift+S 抓页面快照，Ctrl+Shift+C 抓 cookie 名单
 *   electron spike/main.mjs --url=<u>  # 指向本地 mock 站点（后续 M1 回归用）
 */
import { app, BaseWindow, WebContentsView, session, shell, globalShortcut, nativeTheme } from 'electron';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISPLAY_NAME, INTERNAL_APP_ID, SITE_ORIGIN } from './brand.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const EVID = join(ROOT, 'docs', 'm0-evidence');
mkdirSync(EVID, { recursive: true });
const EVENTS = join(EVID, 'events.ndjson');
const REPORT = join(ROOT, 'docs', 'M0-REPORT.md');

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.findIndex((a) => a.startsWith(n + '='));
  return i >= 0 ? argv[i].slice(n.length + 1) : d;
};

const AUTO = has('--auto');
const START_URL = opt('--url', `${SITE_ORIGIN}/`);
const LOAD_TIMEOUT_MS = Number(opt('--timeout', '30000'));

// 自动/交互使用不同的 userData，避免两个进程抢同一个 LevelDB 锁。
// --session=<name> 可显式指定：`--auto --session=main` 复用交互模式已登录的分区，用于验证 V4（登录态持久化）。
const SESSION = opt('--session', AUTO ? 'auto' : 'main');
app.setPath('userData', join(ROOT, `.spike-userdata-${SESSION}`));

// ---------- 指纹构造（不硬编码版本，取运行时 Chromium 版本） ----------
const chromeFull = process.versions.chrome;
const chromeMajor = chromeFull.split('.')[0];
const CHROME_UA =
  `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
  `Chrome/${chromeFull} Safari/537.36`;
// 客户端提示（sec-ch-ua*）不再整体伪造：Electron 44 的 navigator.userAgentData.brands 实测只报
// ["Not?A_Brand/24","Chromium/152"]，若请求头写 "Google Chrome" 会与之矛盾、反而成为异常指纹。
// 统一改为"仅剔除 Electron 品牌"的最小改写，见 onBeforeSendHeaders 里的 stripElectron()。
const PARTITION = 'persist:dsk-personal';

// ---------- 证据收集 ----------
const ev = { auto: {}, note: [], consoleErrors: [] };

function safeUrl(u) {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  } catch {
    return String(u).slice(0, 120);
  }
}

function log(type, data = {}) {
  const rec = { ts: new Date().toISOString(), type, ...data };
  try {
    appendFileSync(EVENTS, JSON.stringify(rec) + '\n');
  } catch {}
  // 收集页面侧控制台错误：指纹脚本(fp.min.js)报错或风控提示都可能出现在这里（V16 证据）
  if (type === 'page.console' && Number(data.level) >= 2) {
    ev.consoleErrors.push({ level: data.level, message: String(data.message).slice(0, 200) });
  }
  console.log('[m0]', type, JSON.stringify(data));
}

function run(cmd, payload) {
  return JSON.stringify({ cmd, payload });
}

// ---------- 页面快照：只读结构，不碰输入值（R1） ----------
const SNAPSHOT_SCRIPT = `(() => {
  const body = document.body;
  const text = body ? body.innerText || '' : '';
  const marks = ['AI 生成', '内容由AI生成', '内容由 AI 生成', '本回答由 AI 生成', '人工智能生成', 'AI生成'];
  const clip = (s, n) => (s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  return {
    url: location.origin + location.pathname,
    title: document.title,
    textLen: text.length,
    nodeCount: document.querySelectorAll('*').length,
    aiMarkHits: marks.filter((m) => text.includes(m)),
    riskHints: ['安全验证', '人机验证', '拖动滑块', '操作过于频繁', '请求过于频繁', '请稍后重试', '账号异常', '登录已过期']
      .filter((m) => text.includes(m)),
    editableCount: document.querySelectorAll('textarea, [contenteditable="true"]').length,
    buttons: Array.from(document.querySelectorAll('button, [role="button"]'))
      .map((b) => clip(b.innerText || b.getAttribute('aria-label') || '', 24))
      .filter(Boolean)
      .slice(0, 60),
    headings: Array.from(document.querySelectorAll('h1,h2,h3'))
      .map((h) => clip(h.innerText, 40))
      .filter(Boolean)
      .slice(0, 20),
  };
})()`;

function deepseek() {
  return /(^|\.)deepseek\.com$/.test(new URL(START_URL).hostname) ? true : false;
}

// 选择器素材探针（M1 的 selectors.json 由它产出）：只读 UI 控件的可定位属性与短标签，
// **不读取任何输入值、不读取对话正文**（R1/R5）。文本截断到 24 字符，仅用于识别控件用途。
const SELECTOR_PROBE = `(() => {
  const clip = (s, n) => String(s || '').replace(/\\s+/g, ' ').trim().slice(0, n);
  const info = (el) => ({
    tag: el.tagName.toLowerCase(),
    testid: el.getAttribute('data-testid'),
    aria: el.getAttribute('aria-label'),
    role: el.getAttribute('role'),
    cls: clip(el.className && el.className.toString ? el.className.toString() : '', 70),
    text: clip(el.innerText, 24),
  });
  return {
    url: location.origin + location.pathname,
    editable: Array.from(document.querySelectorAll('textarea,[contenteditable="true"]')).slice(0, 8).map(info),
    buttons: Array.from(document.querySelectorAll('button,[role="button"]')).slice(0, 36).map(info),
    modeHints: Array.from(document.querySelectorAll('*'))
      .filter((el) => el.children.length === 0)
      .map((el) => clip(el.innerText, 12))
      .filter((t) => /快速|深度思考|联网|搜索|R1|模式/.test(t))
      .slice(0, 12),
    counts: {
      buttons: document.querySelectorAll('button,[role="button"]').length,
      editable: document.querySelectorAll('textarea,[contenteditable="true"]').length,
      messagesGuess: document.querySelectorAll('[class*="message"],[class*="chat-item"],[class*="markdown"]').length,
      aiNoticeGuess: document.querySelectorAll('[class*="generated"],[class*="disclaimer"],[class*="notice"]').length,
    },
  };
})()`;

// ---------- 应用启动 ----------
app.userAgentFallback = CHROME_UA;
if (process.platform === 'win32') app.setAppUserModelId(INTERNAL_APP_ID);

const gotLock = AUTO ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  bootstrap().catch((err) => {
    log('fatal', { message: String(err && err.stack ? err.stack : err) });
    finish(1);
  });
}

async function bootstrap() {
  await app.whenReady();
  nativeTheme.themeSource = 'system';

  log('env', {
    app: DISPLAY_NAME,
    internalAppId: INTERNAL_APP_ID,
    electron: process.versions.electron,
    chrome: chromeFull,
    node: process.versions.node,
    platform: `${process.platform}/${process.arch}`,
    userData: app.getPath('userData'),
    auto: AUTO,
  });

  const ses = session.fromPartition(PARTITION);
  ses.setUserAgent(CHROME_UA, 'zh-CN,zh;q=0.9');

  // ---- 请求头：去 Electron 痕迹，并抓首个主框架请求作为 V5 证据 ----
  let headerShot = null;
  // 头字段名大小写不固定（Electron 用 `Sec-CH-UA` 这类规范名），必须大小写不敏感地查/改，
  // 否则"看不到 sec-ch-ua"会是探测自身的 bug 而非站点事实（M0 第二轮曾误判为 null）。
  const hdrKey = (h, name) => Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  const hdr = (h, name) => {
    const k = hdrKey(h, name);
    return k ? h[k] : null;
  };
  const setHdr = (h, name, value) => {
    const k = hdrKey(h, name);
    if (k) h[k] = value;
    else h[name] = value;
  };
  // 只做"最小必要改写"：剔掉客户端提示里可能残留的 Electron 品牌项，
  // 而不是整体替换成 Google Chrome —— 后者会与 navigator.userAgentData.brands 矛盾，
  // 反而制造出更容易被检测的指纹不一致（M0 首轮实测发现并修正）。
  const stripElectron = (v) =>
    String(v || '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !/electron/i.test(s))
      .join(', ');

  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    const before = {
      userAgent: hdr(h, 'user-agent'),
      secChUa: hdr(h, 'sec-ch-ua'),
      secChUaFull: hdr(h, 'sec-ch-ua-full-version-list'),
      headerNames: Object.keys(h).join(','), // 仅头名，不含值
    };
    if (/\.deepseek\.com\//.test(details.url)) {
      setHdr(h, 'user-agent', CHROME_UA);
      // 实测：Electron 44 对主框架导航**根本不发** Sec-CH-UA 系列头（见 before.headerNames），
      // 而真实 Chrome 会发 —— "缺失"本身就是可检测差异。因此这里补发一组与
      // navigator.userAgentData 完全一致的值：不伪造 "Google Chrome" 品牌
      // （Electron 的 userAgentData 只报 Chromium），只保证"请求头 ↔ JS 可见值"自洽。
      // 若原始头确实存在 Electron 残留，则先剔除再用。
      const sc = hdr(h, 'sec-ch-ua');
      setHdr(h, 'sec-ch-ua', sc ? stripElectron(sc) : `"Chromium";v="${chromeMajor}", "Not?A_Brand";v="24"`);
      const scf = hdr(h, 'sec-ch-ua-full-version-list');
      setHdr(
        h,
        'sec-ch-ua-full-version-list',
        scf ? stripElectron(scf) : `"Chromium";v="${chromeFull}", "Not?A_Brand";v="24.0.0.0"`,
      );
      if (!hdr(h, 'sec-ch-ua-mobile')) setHdr(h, 'sec-ch-ua-mobile', '?0');
      if (!hdr(h, 'sec-ch-ua-platform')) setHdr(h, 'sec-ch-ua-platform', '"Windows"');
    }
    if (!headerShot && details.resourceType === 'mainFrame' && details.url.startsWith(SITE_ORIGIN)) {
      headerShot = {
        url: safeUrl(details.url),
        userAgent: hdr(h, 'user-agent'),
        secChUa: hdr(h, 'sec-ch-ua'),
        secChUaFull: hdr(h, 'sec-ch-ua-full-version-list'),
        secChUaPlatform: hdr(h, 'sec-ch-ua-platform'),
        before, // 改写前原值，用于判断 Electron 品牌究竟是否出现在请求头里
      };
      log('v5.request-headers', headerShot);
    }
    cb({ requestHeaders: h });
  });

  // ---- 响应头：X-Frame-Options / CSP 直接回答"能不能被 iframe 嵌入"（V10） ----
  let frameShot = null;
  ses.webRequest.onHeadersReceived((details, cb) => {
    const isDoc = details.resourceType === 'mainFrame' || details.resourceType === 'subFrame';
    if (!frameShot && isDoc && details.url.startsWith(SITE_ORIGIN)) {
      const pick = (name) => {
        const k = Object.keys(details.responseHeaders || {}).find(
          (x) => x.toLowerCase() === name.toLowerCase(),
        );
        return k ? details.responseHeaders[k] : null;
      };
      frameShot = {
        url: safeUrl(details.url),
        status: details.statusLine,
        xFrameOptions: pick('x-frame-options'),
        contentSecurityPolicy: pick('content-security-policy'),
        server: pick('server'),
        cfRay: pick('cf-ray'),
      };
      log('v10.frame-headers', frameShot);
    }
    cb({ responseHeaders: details.responseHeaders });
  });

  // ---- 权限：默认全拒，仅放行剪贴板写入（站点"复制"按钮需要） ----
  const ALLOW = new Set(['clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((wc, permission, cb) => {
    const allow = ALLOW.has(permission);
    log('permission.request', { permission, allow, url: safeUrl(wc.getURL()) });
    cb(allow);
  });
  ses.setPermissionCheckHandler((wc, permission) => ALLOW.has(permission));

  // ---- 窗口 + 视图（BaseWindow + WebContentsView，BrowserView 已废弃） ----
  const win = new BaseWindow({
    width: 1180,
    height: 820,
    show: false,
    title: AUTO ? `${DISPLAY_NAME} — M0 auto` : DISPLAY_NAME,
    backgroundColor: '#0b0b0c',
    autoHideMenuBar: true,
  });
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      // 进程级 --no-sandbox 生效时，此处请求不会真正启用沙箱（根因与权衡见 scripts/launch.mjs 与 docs/compliance.md）
      sandbox: !app.commandLine.hasSwitch('no-sandbox'),
      spellcheck: false,
    },
  });
  win.contentView.addChildView(view);

  // WebContentsView 的 bounds 不自动布局，必须随窗口手动同步（已知坑）
  const syncBounds = () => {
    const b = win.getContentBounds();
    view.setBounds({ x: 0, y: 0, width: Math.max(b.width, 1), height: Math.max(b.height, 1) });
  };
  syncBounds();
  win.on('resize', syncBounds);

  const wc = view.webContents;

  const DRY_EXTERNAL = process.env.DSD_DRY_EXTERNAL === '1'; // 自动测试时不要真的弹出系统浏览器
  wc.setWindowOpenHandler(({ url, disposition }) => {
    const internal = url.startsWith(SITE_ORIGIN);
    log('v14.window-open', {
      url: safeUrl(url),
      disposition,
      internal,
      openedExternally: !internal && !DRY_EXTERNAL,
    });
    ev.auto.V14 = ev.auto.V14 || [];
    ev.auto.V14.push({ url: safeUrl(url), internal });
    if (!internal && !DRY_EXTERNAL) shell.openExternal(url).catch(() => {});
    return { action: 'deny' }; // 一律不在应用内开新窗口（DD-13）
  });

  wc.on('did-start-loading', () => log('nav.start', { url: safeUrl(wc.getURL()) }));
  wc.on('did-navigate', (_e, url, httpResponseCode) =>
    log('nav.did-navigate', { url: safeUrl(url), httpResponseCode }),
  );
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) =>
    log('nav.in-page', { url: safeUrl(url), isMainFrame }),
  );
  let mainLoaded = null;
  // 只把"目标站点"的加载结果计入 V1：自检页等其它页面不算（M0 首轮曾误记为自检页）
  const isSite = (u) => String(u).startsWith(SITE_ORIGIN);
  wc.on('did-finish-load', () => {
    const u = wc.getURL();
    if (!isSite(u) || mainLoaded) return;
    mainLoaded = { url: safeUrl(u), at: Date.now() };
    log('v1.did-finish-load', mainLoaded);
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    log('v1.did-fail-load', { code, desc, url: safeUrl(url), isMainFrame });
    if (isMainFrame && isSite(url) && !mainLoaded) {
      mainLoaded = { url: safeUrl(url), error: `${code} ${desc}` };
    }
  });
  wc.on('render-process-gone', (_e, d) => log('crash', d));
  wc.on('unresponsive', () => log('unresponsive', {}));
  wc.on('console-message', (...a) => {
    // Electron 新旧两种签名都兼容
    if (a.length >= 4 && typeof a[1] === 'number') {
      if (a[1] >= 2) log('page.console', { level: a[1], message: String(a[2]).slice(0, 300) });
    } else if (a[0] && typeof a[0] === 'object' && a[0].level) {
      if (a[0].level === 'error' || a[0].level === 'warning')
        log('page.console', { level: a[0].level, message: String(a[0].message).slice(0, 300) });
    }
  });
  app.on('certificate-error', (_e, _wc, url, error, _cert, cb) => {
    log('certificate-error', { url: safeUrl(url), error });
    cb(false);
  });

  // ---- 快照与 cookie 名单（交互模式手工触发） ----
  async function dumpSnapshot(tag) {
    try {
      const snap = await wc.executeJavaScript(SNAPSHOT_SCRIPT, true);
      log(`snapshot.${tag}`, snap);
      return snap;
    } catch (e) {
      log(`snapshot.${tag}.failed`, { message: String(e).slice(0, 200) });
      return null;
    }
  }
  async function dumpCookieNames(tag) {
    try {
      const list = await ses.cookies.get({ url: SITE_ORIGIN });
      // 只记名字/域/过期，绝不含值（R1）
      log(`cookies.${tag}`, {
        count: list.length,
        names: list.map((c) => c.name),
        domains: [...new Set(list.map((c) => c.domain))],
        expiries: list.map((c) => ({ name: c.name, session: c.session, exp: c.expirationDate ?? null })),
      });
    } catch (e) {
      log(`cookies.${tag}.failed`, { message: String(e).slice(0, 200) });
    }
  }
  ev.dumpSnapshot = dumpSnapshot;
  ev.dumpCookieNames = dumpCookieNames;

  if (!AUTO) {
    globalShortcut.register('Control+Shift+S', () => dumpSnapshot('manual'));
    globalShortcut.register('Control+Shift+C', () => dumpCookieNames('manual'));
    // 发过消息之后按这个：抓消息区/输入区的可定位属性，作为 M1 的 selectors.json 素材
    globalShortcut.register('Control+Shift+D', async () => {
      const s = await wc.executeJavaScript(SELECTOR_PROBE, true).catch(() => null);
      log('selectors.manual', s || { error: 'probe failed' });
    });
    log('interactive.ready', {
      hints: [
        'Ctrl+Shift+S 抓页面快照（含 AI 生成标识命中、可见模式按钮）',
        'Ctrl+Shift+C 抓 cookie 名单（只记名字）',
        'Ctrl+Shift+D 抓控件结构（发过消息后按，用于 M1 选择器）',
        '关闭窗口即写报告',
      ],
    });
  }

  // ---- 第一步：自检页（V5 页面侧证据） ----
  await wc.loadFile(join(__dirname, 'selfcheck.html'));
  let selfcheck = null;
  for (let i = 0; i < 30 && !selfcheck; i++) {
    await new Promise((r) => setTimeout(r, 100));
    selfcheck = await wc.executeJavaScript('window.__selfcheck ?? null', true).catch(() => null);
  }
  ev.auto.selfcheck = selfcheck;
  log('v5.selfcheck', selfcheck || { error: 'no result' });

  // ---- 第二步：加载目标站点（V1） ----
  log('nav.load', { url: safeUrl(START_URL) });
  const loadStart = Date.now();
  wc.loadURL(START_URL).catch((e) => log('v1.loadURL.rejected', { message: String(e).slice(0, 200) }));
  while (!mainLoaded && Date.now() - loadStart < LOAD_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, 250));
  }
  await new Promise((r) => setTimeout(r, 2500)); // 等 SPA 首屏渲染

  let siteSnap = await dumpSnapshot('site-first');
  await dumpCookieNames('after-load');

  ev.auto.v1 = mainLoaded;
  ev.auto.v5 = { ua: CHROME_UA, requestHeaders: headerShot, selfcheck };
  ev.auto.v10 = frameShot;
  ev.auto.siteSnapshot = siteSnap;

  if (AUTO) {
    // V14 自动化：同源链接不得外跳、跨源链接必须外跳、应用内一律不开新窗口
    await wc
      .executeJavaScript(
        `(() => {
           window.open('${SITE_ORIGIN}/a/chat/s/v14-internal-probe', '_blank');
           window.open('https://example.com/v14-external-probe', '_blank');
           return true;
         })()`,
        true,
      )
      .catch((e) => log('v14.probe.failed', { message: String(e).slice(0, 160) }));
    await new Promise((r) => setTimeout(r, 800));
    ev.auto.v14 = ev.auto.V14 || [];
    log('v14.result', { attempts: ev.auto.v14 });

    // V4：登录态持久化 —— **只读 localStorage 的 key 名，不读任何值**（符合 R1），配合最终 URL 判定。
    // 实测登录凭据不在 cookie 里（cookie 只有 WAF/会话 id），而在 localStorage，故必须看这里。
    const lsKeys = await wc
      .executeJavaScript("Object.keys(window.localStorage).join(',')", true)
      .catch(() => '');
    ev.auto.v4 = {
      sessionProfile: SESSION,
      finalUrl: safeUrl(wc.getURL()),
      localStorageKeys: String(lsKeys || '').split(',').filter(Boolean),
      cookieCount: (await ses.cookies.get({ url: SITE_ORIGIN })).length,
    };
    log('v4.session', ev.auto.v4);

    if (has('--probe-selectors')) {
      ev.auto.selectors = await wc.executeJavaScript(SELECTOR_PROBE, true).catch(() => null);
      log('selectors.probe', ev.auto.selectors || { error: 'probe failed' });
    }

    await writeReport('auto');
    finish(0);
  } else {
    win.show();
    log('window.shown', { bounds: win.getContentBounds() });
    win.on('close', (e) => {
      // 必须先拦住关闭：否则 window-all-closed 会让进程先退出，异步抓取与报告写不完
      e.preventDefault();
      if (ev.closing) return;
      ev.closing = true;
      dumpSnapshot('on-close').finally(() =>
        dumpCookieNames('on-close').finally(() =>
          writeReport('interactive').finally(() => {
            try {
              win.destroy();
            } catch {}
            finish(0);
          }),
        ),
      );
    });
  }
}

// ---------- 判定 ----------
function verdicts() {
  const sc = ev.auto.selfcheck || {};
  const reqHeaders = (ev.auto.v5 && ev.auto.v5.requestHeaders) || null;
  const fh = ev.auto.v10 || {};
  const v1 = ev.auto.v1 || {};
  const snap = ev.auto.siteSnapshot || {};
  const v14 = ev.auto.v14 || [];

  const uaClean = !!sc.userAgent && !/Electron/i.test(sc.userAgent);
  const brandsClean = Array.isArray(sc.uaBrands) && !sc.uaBrands.some((b) => /Electron/i.test(b));
  const reqClean = !!reqHeaders && !/Electron/i.test(reqHeaders.userAgent || '') &&
    !/Electron/i.test(reqHeaders.secChUa || '');

  const embedBlocked =
    !!fh.xFrameOptions || /frame-ancestors/i.test(String(fh.contentSecurityPolicy || ''));

  return [
    ['V1', '页面加载', v1.url && !v1.error ? 'PASS' : v1.error ? 'FAIL' : 'UNKNOWN',
      v1.error ? `加载失败：${v1.error}` : `已加载 ${v1.url}`],
    ['V5a', 'navigator.userAgent 无 Electron', uaClean ? 'PASS' : sc.userAgent ? 'FAIL' : 'UNKNOWN',
      sc.userAgent ? `UA = ${sc.userAgent}` : '未取到'],
    ['V5b', 'navigator.userAgentData.brands 无 Electron', brandsClean ? 'PASS' : sc.uaBrands ? 'FAIL' : 'UNKNOWN',
      sc.uaBrands ? JSON.stringify(sc.uaBrands) : '未取到'],
    ['V5c', '主框架请求头无 Electron', reqClean ? 'PASS' : reqHeaders ? 'FAIL' : 'UNKNOWN',
      reqHeaders ? `UA=${reqHeaders.userAgent} ; sec-ch-ua=${reqHeaders.secChUa}` : '未捕获到主框架请求'],
    ['V10', 'iframe 可嵌入性（响应头）', fh.xFrameOptions || fh.contentSecurityPolicy ? (embedBlocked ? 'BLOCKED' : 'MAYBE') : 'UNKNOWN',
      `X-Frame-Options=${JSON.stringify(fh.xFrameOptions)} ; CSP=${String(fh.contentSecurityPolicy || '').slice(0, 160)}`],
    ['V13', '首屏快照（登录前基线）', snap && snap.url ? 'INFO' : 'UNKNOWN',
      snap && snap.url ? `title="${snap.title}" 节点=${snap.nodeCount} 可编辑=${snap.editableCount} 风控提示=${JSON.stringify(snap.riskHints)}` : '未取到'],
    ['V14', '跨源外跳 / 应用内不开新窗口',
      v14.length >= 2 && v14.some((x) => x.internal) && v14.some((x) => !x.internal)
        ? 'PASS'
        : v14.length
          ? 'PARTIAL'
          : 'UNKNOWN',
      v14.length ? JSON.stringify(v14) : '未触发 window.open 探针'],
    ['V4', '登录态持久化（需 --auto --session=main）',
      !ev.auto.v4
        ? 'UNKNOWN'
        : ev.auto.v4.finalUrl.includes('/sign_in')
          ? 'FAIL'
          : ev.auto.v4.localStorageKeys.includes('userToken')
            ? 'PASS'
            : 'PARTIAL',
      !ev.auto.v4
        ? '未运行（需复用已登录分区：--auto --session=main）'
        : `最终 URL=${ev.auto.v4.finalUrl} ; userToken 存在=${ev.auto.v4.localStorageKeys.includes('userToken')}` +
          ` ; 凭据 key 数=${ev.auto.v4.localStorageKeys.length} ; cookies=${ev.auto.v4.cookieCount}` +
          `（仅读 key 名不读值；V4 通过即隐含 V2 登录曾成功）`],
  ];
}

const MANUAL = [
  ['V2', '能否登录（手机号 / 邮箱 / 扫码）'],
  ['V3', '能否流式对话（逐字出现、可中断）'],
  ['V4', '登录态持久化：关掉应用再启动仍是登录状态；并记录是否约 24h 后失效'],
  ['V6', '风控表现：连续 20 轮 + 刷新，无验证码 / 403 / 静默失败'],
  ['V7', '文件上传：拖拽 + 选择器两条路径'],
  ['V8', '注入不破坏页面（需 M1 增强层就绪后复核，当前 spike 未注入）'],
  ['V9', '流式可观测：能稳定判定"本轮结束"（≥20 次无漏判）'],
  ['V11', '站点 AI 生成标识在增强层下无变化（需 M1 后复核）'],
  ['V12', '品牌合规：应用名/图标/界面零 DeepSeek 品牌特征（当前 R4 明示例外，仅自用）'],
  ['V14', '跨源链接外跳系统浏览器，不在应用内开新窗口'],
];

async function writeReport(mode) {
  const rows = verdicts();
  const lines = [];
  lines.push('# M0 可行性验证报告（自动生成）');
  lines.push('');
  lines.push(`- 生成时间：${new Date().toISOString()}`);
  lines.push(`- 运行模式：${mode}`);
  lines.push(`- 目标地址：${START_URL}`);
  lines.push(`- 运行时：Electron ${process.versions.electron} / Chromium ${chromeFull} / Node ${process.versions.node}`);
  lines.push(`- 证据文件：docs/m0-evidence/events.ndjson`);
  lines.push('');
  lines.push('## 自动化检查结果');
  lines.push('');
  lines.push('| 项 | 含义 | 结果 | 证据 |');
  lines.push('|---|---|---|---|');
  for (const [id, name, res, detail] of rows) {
    lines.push(`| ${id} | ${name} | **${res}** | ${String(detail).replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  lines.push('## 人工检查清单（需你本人操作后勾选）');
  lines.push('');
  for (const [id, name] of MANUAL) lines.push(`- [ ] ${id} ${name}`);
  lines.push('');
  lines.push('## 关键结论');
  lines.push('');
  const v5a = rows.find((r) => r[0] === 'V5a');
  const v5b = rows.find((r) => r[0] === 'V5b');
  lines.push(`- 指纹去痕：UA ${v5a[2]}／userAgentData.brands ${v5b[2]}`);
  if (v5b[2] === 'FAIL') {
    lines.push('  - 说明仅改请求头**不足以**去掉 `navigator.userAgentData` 里的 Electron 标记；M1 需要在主世界注入一层只读指纹修正（不触碰凭据，仍符合 R1/R2）。');
  }
  const v10 = rows.find((r) => r[0] === 'V10');
  lines.push(`- iframe 可嵌入性：${v10[2]} —— ${v10[3]}`);
  if (v10[2] === 'BLOCKED') {
    lines.push('  - 结论：**不能**把站点嵌进 DSH 的 Web GUI 面板，方案 §2.2 的判断成立，独立 Electron 壳是正确形态。');
  }
  lines.push('');
  lines.push('## 下一步');
  lines.push('');
  lines.push('1. 在交互模式下完成 V2/V3/V4/V6/V7，并用 Ctrl+Shift+S 抓快照核对 V11/V13。');
  lines.push('2. 若 V2 或 V3 不通过 → 触发方案 §2.1 替补壳（首选 pywebview），不在 Electron 上继续加码。');
  lines.push('3. 全部通过 → 进入 M1：先落 T0 契约（`src/shared/**`），再并行 T1/T2/T3/T5。');
  lines.push('');
  try {
    writeFileSync(REPORT, lines.join('\n'));
    log('report.written', { path: REPORT, verdicts: rows.map((r) => [r[0], r[1], r[2], r[3]]) });
  } catch (e) {
    log('report.failed', { message: String(e) });
  }
}

function finish(code) {
  try {
    globalShortcut.unregisterAll();
  } catch {}
  app.exit(code);
}
