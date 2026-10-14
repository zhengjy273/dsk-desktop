/**
 * 启动诊断探针：每一步都同步落盘，用于定位 Electron 在本机环境下的崩溃点。
 *
 * 用法：
 *   node scripts/launch.mjs spike/diag.mjs
 *   node scripts/launch.mjs spike/diag.mjs --no-sandbox
 *   node scripts/launch.mjs spike/diag.mjs --no-sandbox --disable-gpu
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const EVID = join(ROOT, 'docs', 'm0-evidence');
mkdirSync(EVID, { recursive: true });
const LOG = join(EVID, 'diag.ndjson');

const w = (step, extra = {}) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), step, ...extra }) + '\n';
  try {
    appendFileSync(LOG, line);
  } catch {}
  try {
    process.stdout.write('[diag] ' + line);
  } catch {}
};

w('module-load', {
  argv: process.argv.slice(2),
  electron: process.versions.electron ?? null,
  chrome: process.versions.chrome ?? null,
  node: process.versions.node,
  runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1',
});

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);

process.on('uncaughtException', (e) => w('uncaught', { message: String((e && e.stack) || e) }));
process.on('unhandledRejection', (e) => w('unhandled-rejection', { message: String((e && e.stack) || e) }));

const { app, BaseWindow, WebContentsView } = await import('electron');
w('electron-imported', { electron: process.versions.electron });

if (has('--no-sandbox')) app.commandLine.appendSwitch('no-sandbox');
if (has('--disable-gpu')) app.commandLine.appendSwitch('disable-gpu');
if (has('--in-process-gpu')) app.commandLine.appendSwitch('in-process-gpu');
if (has('--disable-software-rasterizer')) app.commandLine.appendSwitch('disable-software-rasterizer');

app.setPath('userData', join(ROOT, '.spike-userdata-diag'));
w('userdata-set', { userData: app.getPath('userData'), switches: app.commandLine.getSwitchValue('no-sandbox') });

app
  .whenReady()
  .then(async () => {
    w('app-ready');
    const win = new BaseWindow({ width: 900, height: 600, show: false });
    w('window-created');
    const view = new WebContentsView({
      webPreferences: {
        partition: 'persist:dsk-diag',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: !has('--no-sandbox'),
      },
    });
    w('view-created');
    win.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 900, height: 600 });
    w('view-attached');

    view.webContents.on('render-process-gone', (_e, d) => w('render-gone', d));
    view.webContents.on('did-fail-load', (_e, code, desc, url) =>
      w('page-failed', { code, desc, url: String(url).slice(0, 80) }),
    );
    view.webContents.once('did-finish-load', async () => {
      w('page-loaded', { url: String(view.webContents.getURL()).slice(0, 80) });
      const title = await view.webContents.executeJavaScript('document.title', true).catch((e) => 'ERR ' + e.message);
      w('page-title', { title });
      app.exit(0);
    });

    await view.webContents.loadURL('data:text/html,<title>diag</title><h1>ok</h1>').catch((e) => w('load-rejected', { message: String(e).slice(0, 160) }));
    setTimeout(() => {
      w('timeout-15s');
      app.exit(3);
    }, 15000);
  })
  .catch((e) => w('ready-failed', { message: String((e && e.stack) || e) }));
