/**
 * 打包：electron-builder 出 **NSIS 安装包 + 便携版**。
 *
 * 为什么需要这一层（两个实测踩过的坑）：
 *  1) **镜像**：本机 GitHub 直连被 DNS 劫持，electron-builder 的辅助二进制
 *     （winCodeSign / nsis / nsis-resources）必须走 npmmirror，否则卡在下载。
 *  2) **不能用 `pnpm exec`**：pnpm 11 在 exec 前会做依赖状态检查，而 `pnpm install` 会因
 *     "存在未批准的 build script"（`electron-winstaller` —— Squirrel 目标用，本项目不需要）
 *     返回非零，把打包一起带崩。所以这里**直接调 electron-builder 的 CLI**。
 *
 * 用法：
 *   node scripts/package.mjs          # NSIS 安装包 + 便携版 → release/
 *   node scripts/package.mjs --dir    # 只解包（不生成安装包），快，用于验证
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??= 'https://npmmirror.com/mirrors/electron-builder-binaries/';
process.env.ELECTRON_MIRROR ??= 'https://npmmirror.com/mirrors/electron/';

/**
 * electron-builder 26 会**调用 PATH 里的 `pnpm`** 来收集依赖树；而本机 pnpm 只存在于
 * DSH 内部路径（只有 `.mjs`/`.cjs`，没有可执行的 `pnpm.cmd`），不在 PATH 里 ——
 * 这样会报 `No JSON content found in output` 并中止打包（实测踩过）。
 * 这里造一个 shim 目录并前置到 PATH 解决。
 */
const pnpmMjs =
  process.env.DSK_PNPM_PATH ?? '<dsh-install>\\resources\\runtime\\pnpm\\bin\\pnpm.mjs';
const shimDir = join(ROOT, '.tools');
try {
  mkdirSync(shimDir, { recursive: true });
  writeFileSync(join(shimDir, 'pnpm.cmd'), `@echo off\r\nnode "${pnpmMjs}" %*\r\n`, 'ascii');
  process.env.PATH = `${shimDir};${process.env.PATH}`;
  console.log(`[package] pnpm shim = ${join(shimDir, 'pnpm.cmd')}`);
} catch (e) {
  console.warn(`[package] 创建 pnpm shim 失败（若报依赖收集错，先修这里）：${String(e?.message ?? e)}`);
}

const cli = join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
if (!existsSync(cli)) {
  console.error(`[package] 找不到 electron-builder CLI：${cli}`);
  console.error('[package] 先安装：pnpm add -D electron-builder');
  process.exit(1);
}

/**
 * 输出目录：默认 `%LOCALAPPDATA%\dsk-desktop-build`，**刻意避开项目所在的磁盘树**。
 *
 * 实测原因：`<workspace>` 目录树的 DACL 有问题（孤儿 SID + Low Mandatory Level + 无 AppContainer ACE），
 * 打包产物放在里面会让 Chromium 沙箱以 `0x80000003`（STATUS_BREAKPOINT）崩溃，
 * 并且 NSIS 生成安装包那一步会 exit 2。放到 `%LOCALAPPDATA%` 下就完全正常
 *（也正好与实际安装位置一致）。
 */
const outDir =
  process.env.DSK_DIST_OUT ?? join(process.env.LOCALAPPDATA ?? ROOT, 'dsk-desktop-build');

const args = [
  cli,
  ...(process.argv.includes('--dir') ? ['--dir'] : ['--win', 'nsis', 'portable']),
  `--config.directories.output=${outDir}`,
];

console.log(`[package] args = ${args.slice(1).join(' ')}`);
console.log(`[package] electron mirror = ${process.env.ELECTRON_MIRROR}`);
console.log(`[package] binaries mirror = ${process.env.ELECTRON_BUILDER_BINARIES_MIRROR}`);

const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
console.log(`[package] electron-builder 退出码 = ${result.status}`);
process.exit(result.status ?? 1);
