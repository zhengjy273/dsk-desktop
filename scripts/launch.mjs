/**
 * 统一启动器 —— 解决 DSH 环境注入 ELECTRON_RUN_AS_NODE=1 的问题。
 *
 * 背景（本机实测）：DSH 的 shell 工具进程继承到 ELECTRON_RUN_AS_NODE=1，
 * 直接跑 electron 会把应用当 Node 脚本执行（表现为 `electron --version` 返回 Node 版本，
 * 应用启动后 `import { app } from 'electron'` 拿不到 Electron API）。
 *
 * 用法：node scripts/launch.mjs <app-entry> [...args]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);

// ── Electron 二进制位置（根因修复，详见 docs/compliance.md「Chromium 沙箱」）──────────────
// 本机 Electron 默认位于 <workspace> 之下，而该目录树带有 DSH 沙箱留下的**孤儿 SID**
// (S-1-4-85086085-674777630) 与 Low integrity 标签，且整条路径链缺 AppContainer 包 ACE，
// 会让 Chromium 沙箱子进程以 STATUS_BREAKPOINT (0x80000003) 崩在应用 JS 加载**之前**
// （与 electron/electron#51761 在 Windows 11 25H2 上描述的组合一致）。
// 解法：用 scripts/setup-electron.mjs 把 dist 放到干净 ACL 目录，并在此用 Electron 官方
// ELECTRON_OVERRIDE_DIST_PATH 指过去 —— 沙箱因此得以**保持启用**，无需 --no-sandbox。
// 注意：必须在 require('electron') 之前设置该环境变量。
const CLEAN_DIST = join(process.env.LOCALAPPDATA ?? '', 'dsk-electron', 'dist');
if (!process.env.ELECTRON_OVERRIDE_DIST_PATH && existsSync(join(CLEAN_DIST, 'electron.exe'))) {
  process.env.ELECTRON_OVERRIDE_DIST_PATH = CLEAN_DIST;
}

const electronPath = require('electron'); // 在非 Electron 运行时下返回 electron.exe 绝对路径

if (!args.length) {
  console.error('usage: node scripts/launch.mjs <app-entry> [...args]');
  process.exit(2);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // ← 关键：清掉 DSH 注入的 Node 模式开关
env.ELECTRON_ENABLE_LOGGING = '1';

// ── 沙箱默认保持启用（根因已修复，见上方 ELECTRON_OVERRIDE_DIST_PATH）──────────────
// 应急开关：仅当沙箱再次不可用时才设 DSD_NO_SANDBOX=1 注入 --no-sandbox，并必须记录原因。
const finalArgs = [...args];
if (process.env.DSD_NO_SANDBOX === '1' && !finalArgs.some((a) => a.startsWith('--no-sandbox'))) {
  finalArgs.unshift('--no-sandbox');
}
console.log(
  `[launch] electron=${electronPath}` +
    `\n[launch] sandbox=${finalArgs.some((a) => a.startsWith('--no-sandbox')) ? 'DISABLED (DSD_NO_SANDBOX=1)' : 'ENABLED'}` +
    `\n[launch] dist=${process.env.ELECTRON_OVERRIDE_DIST_PATH ?? '(default / polluted tree)'}` +
    `\n[launch] args=${finalArgs.join(' ')}`,
);

const child = spawn(electronPath, finalArgs, { stdio: 'inherit', env, windowsHide: false });
child.on('error', (e) => {
  console.error('spawn failed:', e);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) console.error(`electron killed by ${signal}`);
  process.exit(code ?? 0);
});
