/**
 * 打包后的 Electron 主入口（`.mjs` 包装层）。
 *
 * 为什么需要这一层：
 *   直接把 `.ts` 作为 `package.json` 的 `main` 字段入口时，Electron 加载主模块**不经过**
 *   Node 的 type-stripping 路径 —— 实测打包版启动后立即退出、无任何输出（排除法确认 exe、
 *   asar、图标、文件完整性都没问题）。
 *   改由本 `.mjs` 去 `import './main.ts'`，走的才是 Node ESM 加载器；Electron 44 内嵌 Node 24
 *   默认支持 strip-types，于是 `.ts` 被正常执行。
 *
 * 开发期完全不受影响：`scripts/launch.mjs` 仍以 `.ts` 作为命令行参数启动。
 */
import './main.ts';
