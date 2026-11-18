/**
 * 调试用：通过 CDP 抓页面截图存成 PNG。
 *
 *   node scripts/cdp-shot.mjs <port> <out-file>
 *
 * 目的：真机验证"窗口最大化/全屏后 WebContentsView 是否铺满客户区"，
 * 只看数值不够（innerWidth 与客户区换算容易因缩放比例看错），直接看像素。
 */
import { writeFileSync } from 'node:fs';

const port = process.argv[2] ?? '9222';
const out = process.argv[3];
if (!out) {
  console.error('用法：node scripts/cdp-shot.mjs <port> <out-file>');
  process.exit(2);
}

const listUrl = `http://127.0.0.1:${port}/json/list`;
const targets = await (await fetch(listUrl)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) {
  console.error('没有 page target');
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

ws.addEventListener('message', (ev) => {
  let msg;
  try {
    msg = JSON.parse(String(ev.data));
  } catch {
    return;
  }
  const slot = pending.get(msg.id);
  if (!slot) return;
  pending.delete(msg.id);
  if (msg.error) slot.reject(new Error(JSON.stringify(msg.error)));
  else slot.resolve(msg.result);
});

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});

const meta = await send('Page.getLayoutMetrics');
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
writeFileSync(out, Buffer.from(shot.data, 'base64'));
console.log(
  JSON.stringify({
    saved: out,
    cssViewport: meta.cssLayoutViewport,
    contentSize: meta.contentSize,
  }),
);
ws.close();
