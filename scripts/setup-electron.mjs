/**
 * 把 Electron 二进制准备到"干净 ACL"目录。
 *
 * 为什么需要：本机 Electron 默认位于 `<workspace>\...` 之下，而该目录树带有 DSH 工作区
 * 沙箱留下的**孤儿 SID**（S-1-4-85086085-674777630）与 Low integrity 标签，且整条路径链
 * 缺 AppContainer 包 ACE。Chromium 的沙箱子进程在这种 DACL 下会以 STATUS_BREAKPOINT
 * (0x80000003) 崩在应用 JS 加载之前（对应 electron/electron#51761，Windows 11 25H2 可复现）。
 *
 * 做法：复制 dist 到 `%LOCALAPPDATA%\dsk-electron\dist`（该处 ACL 干净），由 launch.mjs 通过
 * 官方 `ELECTRON_OVERRIDE_DIST_PATH` 使用它。**不修改 DSH 工作区的任何 ACL。**
 *
 * 用法：
 *   node scripts/setup-electron.mjs           # 不存在才复制
 *   node scripts/setup-electron.mjs --force   # 强制重新复制
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

function electronPackageDir() {
  try {
    return dirname(require.resolve('electron/package.json'));
  } catch {
    return dirname(require.resolve('electron'));
  }
}

const src = join(electronPackageDir(), 'dist');
const base = process.env.LOCALAPPDATA || process.env.HOME || '.';
const dst = join(base, 'dsk-electron', 'dist');
const force = process.argv.includes('--force');

if (!existsSync(join(src, 'electron.exe'))) {
  console.error(`[setup] 源 dist 不可用（缺少 electron.exe）：${src}`);
  console.error('[setup] 先执行：pnpm install');
  process.exit(1);
}

if (existsSync(join(dst, 'electron.exe')) && !force) {
  console.log(`[setup] 已就绪，跳过复制：${dst}`);
} else {
  mkdirSync(dirname(dst), { recursive: true });
  console.log(`[setup] 复制 dist → ${dst}（约 370 MB，首次需要一分钟左右）`);
  cpSync(src, dst, { recursive: true, force: true });
}

console.log(`[setup] 完成：${dst}（顶层 ${readdirSync(dst).length} 项）`);

// ⚠️ **不要**在这里给 electron.exe 打图标。
// 实测（2026-10-10）：用 resedit 改写 exe 的图标资源后，进程能正常启动、窗口句柄也创建了，
// 但 `win.show()` 之后窗口始终 visible=false（EnumWindows 确认），表现为"应用起来了但没有窗口"；
// 换回干净的 exe 立即恢复正常。结论：任务栏图标留到 **M3 由 electron-builder 正式设置**。

console.log('[setup] launch.mjs 会自动经 ELECTRON_OVERRIDE_DIST_PATH 使用该目录，Chromium 沙箱保持启用。');
