/**
 * 调试辅助：通过 CDP 在页面指定坐标派发**真实鼠标事件**（可信点击）。
 *
 * 用法：node scripts/cdp-click.mjs <port> <x> <y>
 *
 * 为什么需要：页面里 `el.click()` 是合成事件，某些组件只监听真实指针事件
 * （pointerdown/mousedown），合成点击会被忽略 —— 表现是"点了没反应"。
 * 只用于本地调试（连着我们自己启动的 Electron 调试端口），不向站点发请求。
 */
const port = process.argv[2] ?? '9222';
const x = Number(process.argv[3]);
const y = Number(process.argv[4]);
if (!Number.isFinite(x) || !Number.isFinite(y)) {
  console.error('usage: node scripts/cdp-click.mjs <port> <x> <y>');
  process.exit(2);
}

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = list.find((t) => t.type === 'page');
if (!page) {
  console.error('没有找到 page target');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
});

await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
try {
  const base = { x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' };
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, buttons: 0 });
  await new Promise((r) => setTimeout(r, 60));
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await new Promise((r) => setTimeout(r, 60));
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base, buttons: 0 });
  console.log(JSON.stringify({ ok: true, x, y }));
} finally {
  ws.close();
}
