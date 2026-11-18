/**
 * 限额可视化：**页面注入层**（两处 UI）。
 *
 * 职责：把主进程算好的 `QuotaView` 贴到页面上的两个位置 ——
 *  1. 输入栏下方：在「内容由 AI 生成，请仔细甄别」**后面接着**显示 `· 本会话已用 N tokens`
 *     （v1.1.2 起改为追加，不再替换原文 —— R3 不再需要折中，AI 生成标识完整保留）
 *  2. 输入框右上方：可折叠浮层（默认收起为小条；额度耗尽/禁言时变色）
 *     可自由拖动、位置在切会话后保持、展开后提供「恢复默认位置」按钮；
 *     迷你窗状态下整块隐藏（用户要求：迷你窗不要浮层）。
 *
 * v1.1.2 移除：每条回答下方的「重新生成/修改剩余次数」徽标。
 * 用户判定"似乎无法获取准确剩余次数"并要求整个去掉；数据通路（请求计数 + 历史分支校准）
 * 保留但不展示，详见 `docs/KNOWN-LIMITS.md`。
 *
 * 设计约束（重要，改动前先读）：
 *  - **纯字符串生成**：本模块只拼出一段自执行 JS，由主进程 `executeJavaScript` 执行。
 *    页面是 `contextIsolation: true` + `sandbox: true`，没有 preload 通道，
 *    所以数据只能**内联**进脚本 —— 因此这里绝不做 I/O，只做字符串拼装。
 *  - **R1 红线**：脚本里不出现 `.value` / `localStorage` / `sessionStorage` / cookie。
 *    有机器断言（`tests/unit/quota-overlay.test.ts`），别绕过。
 *  - **R2 红线**：不 fetch、不 XHR、不发任何请求 —— 数据只由主进程推送进来。
 *  - **R3 红线**：不删改页面原有的 AI 生成标识。token 行是**追加**在标识之后，
 *    原文本节点一个字符都不动，所以卸载时也不需要还原（只摘掉自己插入的 span）。
 *  - **幂等**：脚本可被反复执行（每次额度变化都推一次）。首次执行安装 UI 与观察器，
 *    后续只更新 `state.data` 并重绘；绝不允许元素堆叠。
 *  - **降级**：站点改版导致锚点找不到时，**静默不显示**，不抛错、不破坏页面。
 *
 * 三个踩过的坑（改动时别踩回去）：
 *  - 输入栏那行位于**页面 DOM**，不在 shadow root 里 —— 样式必须**内联**（`cssText`）。
 *    写进 shadow 的 `CSS` 数组对页面 DOM 元素完全无效（曾经不显示）。
 *  - 数据必须存在 `state.data` 上并被渲染函数读取；若渲染函数闭包捕获初始常量，
 *    二次注入时"更新"会渲染旧值（曾经浮层一直显示第一次的数据）。
 *  - 本文件整体是模板字符串，**正则里的反斜杠必须写两个**（`\\s`）。
 *    写一个会被模板转义吃掉（`\\s` 退化成 `s`），曾经导致 ds-message 一个都匹配不到。
 *
 * 写作用域：`src/inject/**`。
 */
import type { QuotaView } from '../shared/ipc-contract.ts';

/** 输入栏下方那行 AI 生成声明（token 用量接在它后面）。 */
const COMPOSER_NOTICE_TEXT = '内容由 AI 生成，请仔细甄别';

/** 浮层宿主元素 id（固定，用于幂等查找）。 */
const HOST_ID = 'dsk-quota-host';

/**
 * 「位置已恢复默认」的 console 标记（页面 → 主进程的单向通知）。
 *
 * 为什么需要：用户点「恢复默认位置」后，页面里 `state.manualPos` 已清空，但主进程
 * `overlayPos` 还留着旧坐标，下一次页面重载会把旧坐标灌回来（实测 bug）。
 * 没有 preload 通道，只能借 `console-message` 这条只读旁路传一个固定字符串。
 */
const POS_RESET_MARK = '[dsk-quota] pos-reset';

/** 导出给主进程做 console 旁听匹配（两处要一致，别各写一份字面量）。 */
export const QUOTA_POS_RESET_MARK = POS_RESET_MARK;

/** 注入时追加的 token 片段样式（页面 DOM 里，必须内联）。 */
const TOKEN_STYLE =
  'margin-left:6px;opacity:.62;font-size:12px;white-space:nowrap;' +
  'font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;';

/** 注入选项（不属于展示数据，只影响 UI 行为）。 */
export interface QuotaInjectOptions {
  /** 迷你窗状态下整块隐藏浮层（用户要求）。 */
  hidden?: boolean;
  /** 上次用户拖动后的位置（页面坐标）；null = 用默认位置（贴输入框右上角）。 */
  pos?: { x: number; y: number } | null;
}

/**
 * 把对象安全地内联成 JS 字面量。
 *
 * 为什么不能直接 `JSON.stringify`：结果会被塞进 `<script>` 语义相近的上下文，
 * `</` 与 U+2028/U+2029 都会打断解析。这里统一转义。
 */
function inlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * 生成注入脚本。
 *
 * 返回值直接交给 `webContents.executeJavaScript(script)`；
 * 脚本返回 `{ ok, reused, answers, composer, pos, hidden }`，便于主进程
 * 记录落点（`composer` 为 0 表示站点文案变了）、并把用户拖动后的位置存下来。
 */
export function buildQuotaInjectScript(view: QuotaView, opts: QuotaInjectOptions = {}): string {
  const data = inlineJson(view);
  const composerText = inlineJson(COMPOSER_NOTICE_TEXT);
  const hostId = inlineJson(HOST_ID);
  const tokenStyle = inlineJson(TOKEN_STYLE);
  const hidden = opts.hidden === true;
  const initPos = opts.pos === null || opts.pos === undefined ? null : opts.pos;
  const initPosJson = initPos === null ? 'null' : inlineJson({ x: initPos.x, y: initPos.y });

  return `(() => {
  const INITIAL = ${data};
  const COMPOSER_TEXT = ${composerText};
  const HOST_ID = ${hostId};
  const TOKEN_STYLE = ${tokenStyle};
  const INIT_POS = ${initPosJson};
  const HIDDEN = ${hidden ? 'true' : 'false'};
  const POS_RESET_MARK = ${inlineJson(POS_RESET_MARK)};

  /* 唯一的可变状态：渲染函数一律读 state，绝不读 INITIAL */
  const state = {
    data: INITIAL,
    observer: null,
    timer: 0,
    paint: null,
    hidden: HIDDEN,
    /* 用户拖动后的位置；null = 默认位置（贴输入框右上角） */
    manualPos: INIT_POS,
    suppressClick: false,
    /* window 级监听器：存具名引用，卸载时才能逐个 removeEventListener。
       曾用匿名箭头函数注册，导致 reset 脚本摘不掉 —— 反复注入会叠监听器。 */
    winListeners: [],
  };

  /* ------------------------------------------------ 样式（仅浮层用 shadow） */
  const CSS = [
    ':host { all: initial; }',
    '.wrap { font: 12px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;',
    '  position: fixed; left: 0; top: 0; z-index: 2147483000;',
    '  background: rgba(28,28,30,.92); color: #f2f2f7; border-radius: 10px;',
    '  box-shadow: 0 6px 24px rgba(0,0,0,.28); overflow: hidden;',
    '  max-width: 300px; backdrop-filter: blur(8px); }',
    '.wrap.warn { background: rgba(120,32,28,.95); }',
    '.wrap.mute { background: rgba(112,64,10,.95); }',
    '.bar { display: flex; align-items: center; gap: 8px; padding: 7px 11px;',
    '  cursor: grab; user-select: none; white-space: nowrap; }',
    '.bar:active { cursor: grabbing; }',
    '.dot { width: 7px; height: 7px; border-radius: 50%; background: #30d158; flex: 0 0 auto; }',
    '.warn .dot { background: #ff453a; }',
    '.mute .dot { background: #ffd60a; }',
    '.label { font-weight: 600; }',
    '.caret { opacity: .55; font-size: 10px; margin-left: 2px; }',
    '.panel { display: none; padding: 0 11px 10px; }',
    '.wrap.open .panel { display: block; }',
    '.row { display: flex; gap: 6px; padding: 2px 0; }',
    '.k { opacity: .6; flex: 0 0 auto; }',
    '.v { word-break: break-word; }',
    '.sep { height: 1px; background: rgba(255,255,255,.14); margin: 6px 0; }',
    '.msg { padding: 3px 0; opacity: .92; }',
    '.foot { opacity: .45; font-size: 11px; padding-top: 4px; }',
    '.ops { display: flex; gap: 6px; padding-top: 6px; }',
    '.btn { font: inherit; font-size: 11px; padding: 3px 9px; border-radius: 6px;',
    '  border: 1px solid rgba(255,255,255,.22); background: rgba(255,255,255,.08);',
    '  color: inherit; cursor: pointer; }',
    '.btn:hover { background: rgba(255,255,255,.16); }',
  ].join('\\n');

  /* ------------------------------------------------ 工具 */
  const el = (tag, cls) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  };

  /** 收集页面里**可见文本**匹配的文本节点（只读文本，不碰任何表单值）。 */
  const textNodes = (needle, exact) => {
    const out = [];
    if (!document.body) return out;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let n = walker.nextNode();
    let guard = 0;
    while (n && guard < 20000) {
      guard += 1;
      const t = (n.nodeValue || '').trim();
      if (exact ? t === needle : t.indexOf(needle) >= 0) out.push(n);
      n = walker.nextNode();
    }
    return out;
  };

  const clock = (ms) => {
    if (!ms || !isFinite(ms)) return '';
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    const p = (v) => (v < 10 ? '0' + v : String(v));
    return p(d.getHours()) + ':' + p(d.getMinutes());
  };

  /**
   * 注册 window 级监听器并记下具名引用 —— 卸载时才能 removeEventListener。
   * 用匿名函数直接 addEventListener 会摘不掉，反复注入就叠一层。
   */
  const onWin = (type, fn, opts) => {
    window.addEventListener(type, fn, opts);
    state.winListeners.push({ type, fn, opts });
  };
  const offAllWin = () => {
    for (const it of state.winListeners) {
      try { window.removeEventListener(it.type, it.fn, it.opts); } catch (e) { /* 忽略 */ }
    }
    state.winListeners = [];
  };
  state.offAllWin = offAllWin;

  /* ------------------------------------------------ 1. 跟随输入栏的浮层 */
  /**
   * 找输入框的外层容器。
   *
   * 不能直接用 textarea：它是内容编辑区，比整个输入框窄/矮；要沿父链找到同时包住
   * 输入区与发送按钮的那个容器。只读 DOM 几何，不读取任何控件的值（R1）。
   */
  const findComposerBox = () => {
    const area = document.querySelector('textarea');
    if (!area) return null;
    const button = document.querySelector('div[role="button"][class*="primary"]');
    let node = area.parentElement;
    let fallback = null;
    for (let depth = 0; node && depth < 8; depth += 1) {
      const r = node.getBoundingClientRect();
      if (r.width > 180 && r.height > 40 && r.height < 500) fallback = node;
      if (button && node.contains(button)) return node;
      node = node.parentElement;
    }
    return fallback;
  };

  const clampX = (x, width) => Math.max(8, Math.min(x, window.innerWidth - width - 8));
  const clampY = (y, height) => Math.max(8, Math.min(y, window.innerHeight - height - 8));

  /** 直接摆到指定左上角（拖动走这里），并记住这是用户选的位置。 */
  const placeAt = (ui, x, y) => {
    const r = ui.wrap.getBoundingClientRect();
    const width = r.width || 110;
    const height = r.height || 32;
    const nx = clampX(x, width);
    const ny = clampY(y, height);
    ui.wrap.style.left = Math.round(nx) + 'px';
    ui.wrap.style.top = Math.round(ny) + 'px';
    state.manualPos = { x: Math.round(nx), y: Math.round(ny) };
  };

  /*
   * 摆浮层：用户拖动过就用他的位置，否则贴输入框右上角。
   *
   * 必须用 getBoundingClientRect() 而不是 offsetWidth/offsetHeight ——
   * 展开/收起刚切完 class 时 offset 系列可能还是旧值，算出来的位置会让浮层
   * "展开后脱离输入栏"（用户实测问题）。
   */
  const positionPanel = (ui) => {
    const wrap = ui.wrap;
    const rect = wrap.getBoundingClientRect();
    const width = rect.width || 110;
    const height = rect.height || 32;
    if (state.manualPos) {
      wrap.style.left = Math.round(clampX(state.manualPos.x, width)) + 'px';
      wrap.style.top = Math.round(clampY(state.manualPos.y, height)) + 'px';
      return;
    }
    const box = findComposerBox();
    const x = box
      ? box.getBoundingClientRect().right - width
      : window.innerWidth - width - 16;
    const y = box
      ? box.getBoundingClientRect().top - height - 8
      : window.innerHeight - height - 16;
    wrap.style.left = Math.round(clampX(x, width)) + 'px';
    wrap.style.top = Math.round(clampY(y, height)) + 'px';
  };

  /** 尺寸变化后重新摆一次（展开/收起、字体加载、窗口缩放都走这里）。 */
  const reposition = (host) => {
    const ui = host && host.__dskQuotaUi;
    if (!ui) return;
    positionPanel(ui);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        const again = host.__dskQuotaUi;
        if (again) positionPanel(again);
      });
    }
    // 再补一次：CSS 过渡/字体换行可能晚一帧生效，只靠 rAF 会差几像素
    setTimeout(() => {
      const again = host.__dskQuotaUi;
      if (again) positionPanel(again);
    }, 60);
  };

  const buildPanel = (host) => {
    const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    root.textContent = '';
    const style = document.createElement('style');
    style.textContent = CSS;

    const wrap = el('div', 'wrap');
    const bar = el('div', 'bar');
    bar.title = '按住拖动可移动位置';
    const dot = el('span', 'dot');
    const label = el('span', 'label');
    const caret = el('span', 'caret');
    caret.textContent = '▾';
    bar.appendChild(dot);
    bar.appendChild(label);
    bar.appendChild(caret);

    const panel = el('div', 'panel');
    wrap.appendChild(bar);
    wrap.appendChild(panel);
    root.appendChild(style);
    root.appendChild(wrap);

    const ui = { wrap, label, panel };

    /* ---- 拖动：按住 bar 移动整块，松手后记住位置（切会话也不变） ---- */
    let drag = null;
    bar.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      const r = wrap.getBoundingClientRect();
      drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top, moved: false };
      // 阻止拖动时选中页面文字
      if (ev.preventDefault) ev.preventDefault();
    });
    const onMove = (ev) => {
      if (!drag) return;
      const nx = ev.clientX - drag.dx;
      const ny = ev.clientY - drag.dy;
      const r = wrap.getBoundingClientRect();
      // 超过 2px 才算拖动，避免"手抖"把点击变成拖拽、导致无法展开
      if (!drag.moved && Math.abs(nx - r.left) + Math.abs(ny - r.top) < 2) return;
      drag.moved = true;
      placeAt(ui, nx, ny);
    };
    const onUp = () => {
      if (!drag) return;
      // 拖动结束时吞掉这次 click（否则拖动会顺带展开/收起）
      if (drag.moved) state.suppressClick = true;
      drag = null;
    };
    onWin('mousemove', onMove);
    onWin('mouseup', onUp);

    bar.addEventListener('click', () => {
      if (state.suppressClick) { state.suppressClick = false; return; }
      wrap.classList.toggle('open');
      // 展开后尺寸变了（尤其高度），必须重新摆一次；rAF + 60ms 双保险
      reposition(host);
    });

    /* ---- 恢复默认位置：清掉用户位置，回到贴输入框右上角 ---- */
    const ops = el('div', 'ops');
    const resetPos = el('button', 'btn');
    resetPos.type = 'button';
    resetPos.textContent = '恢复默认位置';
    resetPos.addEventListener('click', (ev) => {
      if (ev.stopPropagation) ev.stopPropagation();
      state.manualPos = null;
      reposition(host);
      // 通知主进程"位置已恢复默认"。
      //
      // 为什么必须通知：主进程在 overlayPos 里存着用户拖到的坐标，页面重载后的首次注入
      // 用它恢复位置。只在页面里清 manualPos 的话，下一次重载又会把旧坐标灌回来
      //（用户实测：点完"恢复默认位置"，重载一下浮层又跑回原处）。
      //
      // 没有 preload 通道（contextIsolation + sandbox），所以走 console 消息这一条只读旁路：
      // 主进程监听 console-message，见到这个前缀就把 overlayPos 置 null。
      // 只发一个固定标记，不带任何页面数据。
      try { console.log(POS_RESET_MARK); } catch (e) { /* 忽略 */ }
    });
    ops.appendChild(resetPos);
    wrap.__dskOps = ops;

    return ui;
  };

  const renderPanel = (ui) => {
    const D = state.data;
    const { wrap, label, panel } = ui;
    wrap.classList.toggle('warn', D.exhaustedModels.length > 0 && !D.isMuted);
    wrap.classList.toggle('mute', !!D.isMuted);
    label.textContent = D.isMuted
      ? '已禁言'
      : (D.exhaustedModels.length > 0 ? '额度耗尽' : '额度正常');

    panel.textContent = '';
    const row = (k, v) => {
      if (!v) return;
      const r = el('div', 'row');
      const kk = el('span', 'k');
      kk.textContent = k;
      const vv = el('span', 'v');
      vv.textContent = v;
      r.appendChild(kk);
      r.appendChild(vv);
      panel.appendChild(r);
    };

    // 不显示"（缓存）"：缓存标记只用于托盘里**其他账号**的行；当前账号的浮层永远是实时拉到的
    // 那一份，标"缓存"反而让人以为数据过期（用户 2026-11-17 明确：fromCache 只给托盘用）。
    row('账号', D.accountId);
    row('模型', D.modelLabel);
    row('额度', D.quotaSummary);
    row('输入', D.inputLimit);
    row('会话', D.sessionTokensText);
    /* v1.1.2：不再显示重新生成/修改次数（用户：无法获取准确剩余次数，整个去掉） */

    if (D.isMuted) {
      const sep = el('div', 'sep');
      panel.appendChild(sep);
      const m = el('div', 'msg');
      m.textContent = D.muteMsg || ('已禁言' + (D.muteUntil ? '至 ' + clock(D.muteUntil) : ''));
      panel.appendChild(m);
    }

    if (D.serverMessages.length > 0) {
      const sep = el('div', 'sep');
      panel.appendChild(sep);
      for (const text of D.serverMessages) {
        const m = el('div', 'msg');
        m.textContent = text;
        panel.appendChild(m);
      }
    }

    const foot = el('div', 'foot');
    foot.textContent = '更新于 ' + (clock(D.updatedAt) || '—');
    panel.appendChild(foot);

    if (wrap.__dskOps) panel.appendChild(wrap.__dskOps);
  };

  const mountPanel = () => {
    let host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      (document.body || document.documentElement).appendChild(host);
    }
    // 迷你窗：整块隐藏（用户要求），但不卸载 —— 退出迷你窗后立刻恢复
    host.style.display = state.hidden ? 'none' : '';
    let ui = host.__dskQuotaUi;
    if (!ui) {
      ui = buildPanel(host);
      host.__dskQuotaUi = ui;
    }
    if (state.hidden) return ui;
    renderPanel(ui);
    positionPanel(ui);
    return ui;
  };

  /* ------------------------------------------------ 2. 输入栏下方的会话 token */
  /*
   * 把 token 用量**接在**「内容由 AI 生成，请仔细甄别」后面（不替换原文 —— R3）。
   *
   * 为什么追加而不是替换：v1.1.0/1.1.1 曾经直接改写那个文本节点，靠 title 属性保留原文，
   * 属于对 AI 生成标识的折中；用户现在明确要求"不再遮挡，改为接在标识后面"。
   * 追加后原文本节点一个字符都不动，卸载时只需摘掉自己插入的 span。
   */
  const renderComposerToken = () => {
    const text = state.data.sessionTokensText;
    const existing = document.querySelectorAll('.dsk-quota-token');

    if (!text) {
      // 没有数据就摘掉自己加的片段，界面上不残留空标签或旧会话的数字
      for (const node of existing) node.remove();
      return 0;
    }

    // 已插入过：确认它还挂在锚点旁边（站点重渲染会把它带走），只更新文字。
    // 注意要遍历**全部** existing，不能第一个 isConnected 就 return ——
    // 页面若同时渲染多处相同声明（桌面版/移动版布局、多标签容器），
    // 早退会让其余片段永远停在旧值。
    const want = ' · ' + text;
    let reused = 0;
    for (const node of existing) {
      if (!node.isConnected) continue;
      if (node.textContent !== want) node.textContent = want;
      reused += 1;
    }
    if (reused > 0) return reused;

    const nodes = textNodes(COMPOSER_TEXT, true);
    let placed = 0;
    for (const node of nodes) {
      const parent = node.parentElement;
      if (!parent) continue;
      // 幂等：同一个锚点后只挂一个片段
      if (parent.querySelector(':scope > .dsk-quota-token')) { placed += 1; continue; }
      const span = el('span', 'dsk-quota-token');
      span.style.cssText = TOKEN_STYLE;
      span.textContent = ' · ' + text;
      // 紧接在声明文本之后，同一行继续显示
      const anchor = node.parentNode;
      if (!anchor) continue;
      anchor.insertBefore(span, node.nextSibling);
      placed += 1;
    }
    return placed;
  };

  /* ------------------------------------------------ 安装 / 更新 */
  const paint = () => {
    let composer = 0;
    try { mountPanel(); } catch (e) { /* 降级：浮层失败不影响 token 行 */ }
    try { composer = renderComposerToken(); } catch (e) { composer = 0; }
    // 站点切会话会重建输入框，观察目标可能已脱离文档（首次调用时还没有观察器，判空即可）
    try { if (state.rebindObservers) state.rebindObservers(); } catch (e) { /* 忽略 */ }
    // 诊断：锚点是否存在（用于判断"没显示"是站点改版还是当前页面本来就没有该文案）
    let composerNodes = 0;
    try {
      composerNodes =
        document.querySelectorAll('.dsk-quota-token').length + textNodes(COMPOSER_TEXT, true).length;
    } catch (e) { composerNodes = -1; }
    const host = document.getElementById(HOST_ID);
    const wrap = host && host.__dskQuotaUi && host.__dskQuotaUi.wrap;
    return {
      answers: 0, // v1.1.2 起没有回答徽标，保留字段让主进程日志格式不变
      composer: composer,
      answerNodes: 0,
      composerNodes: composerNodes,
      /* 只上报**用户拖动过**的位置；null = 仍用默认位置（贴输入框右上角）。
         不能上报 wrap 的绝对坐标 —— 那会把"默认跟随"固化成固定坐标，
         输入框一移动浮层就不再跟随（主进程据此判断是否记住位置）。 */
      pos: state.manualPos ? { x: state.manualPos.x, y: state.manualPos.y } : null,
      hidden: state.hidden,
    };
  };
  state.paint = paint;

  if (window.__dskQuota) {
    // 二次注入：只换数据 + 重绘（不重复安装观察器、不堆叠元素）
    const prev = window.__dskQuota;
    prev.data = INITIAL;
    prev.hidden = HIDDEN;
    /* 位置**不**在这里覆盖：页面已存在说明它是活的，页面内的 manualPos 是最新真相
       （用户刚拖动过，主进程手里的还可能是旧值）。只有页面重载后走下面的首次分支，
       才用主进程存的位置恢复 —— 否则拖动会被下一次数据刷新拽回去。 */
    const stats = prev.paint();
    return { ok: true, reused: true, ...stats };
  }

  window.__dskQuota = state;
  const first = paint();

  /**
   * 站点是 SPA：回答是流式渲染出来的，锚点出现时间不确定。
   * 用 MutationObserver + 800ms 节流兜底重绘；页面隐藏时不重绘（省 CPU）。
   */
  const schedule = () => {
    if (document.visibilityState !== 'visible') return;
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = 0;
      try { paint(); } catch (e) { /* 忽略 */ }
    }, 800);
  };

  /*
   * 输入框高度/位置会变（多行输入、窗口缩放），浮层自身展开也会变高。
   * 两者都要重新贴位：只观察输入框的话，"展开后不贴合输入栏"就又回来了。
   */
  let composerObserver = null;
  let wrapObserver = null;
  try {
    const box = findComposerBox();
    if (box && typeof ResizeObserver === 'function') {
      composerObserver = new ResizeObserver(() => {
        const host = document.getElementById(HOST_ID);
        if (host) reposition(host);
      });
      composerObserver.observe(box);
    }
    if (typeof ResizeObserver === 'function') {
      wrapObserver = new ResizeObserver(() => {
        const host = document.getElementById(HOST_ID);
        const ui = host && host.__dskQuotaUi;
        // 防止自激：只在尺寸真的变了才摆位（摆位改的是 left/top，不改尺寸，不会循环）
        if (ui) positionPanel(ui);
      });
      const host = document.getElementById(HOST_ID);
      const wrap = host && host.__dskQuotaUi && host.__dskQuotaUi.wrap;
      if (wrap) wrapObserver.observe(wrap);
    }
  } catch (e) { composerObserver = null; wrapObserver = null; }
  state.resizeObserver = composerObserver;
  state.wrapObserver = wrapObserver;
  /**
   * SPA 切会话会把输入框整块重建 —— 旧的观察目标已经脱离文档，需要重新绑定。
   * 每次重绘时对一下当前目标，不一致就重绑（代价极低，且只在变化时执行）。
   */
  state.rebindObservers = () => {
    if (!state.resizeObserver) return;
    try {
      const box = findComposerBox();
      if (!box) return;
      if (state.obsTarget === box) return;
      state.resizeObserver.disconnect();
      state.resizeObserver.observe(box);
      state.obsTarget = box;
    } catch (e) { /* 忽略 */ }
  };
  onWin('resize', () => {
    const host = document.getElementById(HOST_ID);
    if (host) reposition(host);
    schedule();
  }, { passive: true });
  onWin('scroll', schedule, { passive: true, capture: true });

  try {
    state.observer = new MutationObserver(() => {
      state.rebindObservers();
      schedule();
    });
    state.observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
    });
  } catch (e) {
    state.observer = null;
  }

  return { ok: true, reused: false, ...first };
})()`;
}

/**
 * 生成"卸载注入"脚本（切账号/关页面时调用）。
 *
 * 只移除我们自己加的元素与标记 —— **不碰页面原文**（token 是追加的，
 * 原 AI 生成声明从未被改写，所以这里没有"恢复原文"的职责）。
 */
export function buildQuotaResetScript(): string {
  const hostId = inlineJson(HOST_ID);

  return `(() => {
  const HOST_ID = ${hostId};
  let removed = 0;
  try {
    const st = window.__dskQuota;
    if (st && st.observer) st.observer.disconnect();
    if (st && st.resizeObserver) st.resizeObserver.disconnect();
    if (st && st.wrapObserver) st.wrapObserver.disconnect();
    if (st && st.offAllWin) st.offAllWin();
    if (st && st.timer) clearTimeout(st.timer);
    delete window.__dskQuota;
  } catch (e) { /* 忽略 */ }

  const host = document.getElementById(HOST_ID);
  if (host) { host.remove(); removed += 1; }

  for (const node of document.querySelectorAll('.dsk-quota-token')) {
    node.remove();
    removed += 1;
  }

  /* 兼容旧版本注入留下的标记（v1.1.1 曾替换原文）：有就还原，没有就算了 */
  for (const node of document.querySelectorAll('[data-dsk-orig]')) {
    const orig = node.getAttribute('data-dsk-orig');
    if (orig) node.textContent = orig;
    node.removeAttribute('data-dsk-orig');
    node.removeAttribute('title');
    node.style.opacity = '';
    removed += 1;
  }

  return { ok: true, removed: removed };
})()`;
}
