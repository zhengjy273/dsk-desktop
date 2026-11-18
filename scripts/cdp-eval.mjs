/**
 * 调试辅助：通过 CDP 在页面里执行一段 JS 并打印结果。
 *
 * 用法：node scripts/cdp-eval.mjs <port> <file-with-expression>
 *
 * 只用于**本地调试**（开发期检查注入是否命中锚点）。它连的是我们自己启动的
 * Electron 调试端口，不向站点发任何请求、不读取凭据 —— 与 R2/R1 不冲突。
 */
import { readFileSync } from 'node:fs';

const port = process.argv[2] ?? '9222';
const file = process.argv[3];
if (!file) {
  console.error('usage: node scripts/cdp-eval.mjs <port> <expression-file>');
  process.exit(2);
}
const expression = readFileSync(file, 'utf8');

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
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    console.error('EXCEPTION:', JSON.stringify(res.exceptionDetails, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(res.result?.value ?? res.result, null, 2));
  }
} finally {
  ws.close();
}
