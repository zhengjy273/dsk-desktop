<p align="center"><img src="assets/icon-256.png" width="96" alt="dsk-desktop"></p>

<h1 align="center">dsk-desktop</h1>

<p align="center">把 <a href="https://chat.deepseek.com">chat.deepseek.com</a> 免费网页版装进一个安静、本地优先的 Windows 桌面壳。</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-1.1.5-blue">
  <img alt="electron" src="https://img.shields.io/badge/Electron-44.7-47848F">
  <img alt="license" src="https://img.shields.io/badge/usage-personal%20only-lightgrey">
</p>

> **非官方项目**，与深度求索（DeepSeek）无任何关联。仅个人自用与学习，不提供任何担保。
> 合规边界见 [docs/compliance.md](docs/compliance.md)，已知限制见 [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md)。

---

## 这是什么

一个 Electron 44 壳：用独立的持久化分区加载官方站点，你正常登录，壳本身只额外提供桌面能力 ——
托盘、全局快捷键、迷你窗、多账号、限额可视化、本地归档与导出。

**不做什么**（这些是硬约束，单测与运行期自检都有机器断言）：

- 不逆向站点接口、不新增/重放 API 请求、不构造 `x-ds-pow-response`；
- 不读取输入框内容、不碰 cookie / localStorage / 任何账号凭据；
- 不隐藏或替换站点自带的「内容由 AI 生成，请仔细甄别」标识（只在其**后面追加**会话用量）；
- 不做自动发言、自动点击、账号共享。

## 功能

| 能力 | 说明 |
|---|---|
| 桌面壳 | 单会话视图加载官方站点，托盘常驻，全局快捷键显隐，关窗最小化到托盘 |
| 迷你窗 | 托盘一键切 380×520 逻辑像素小窗（0.8 缩放），退出还原原尺寸与位置 |
| 多账号 | 每个账号独立 `persist:dsk-<account>` 分区；托盘切换 / 新增 / 删除 / 退出登录，切换需重启应用 |
| 限额可视化 | 托盘 tooltip、托盘账号行、输入框右上角浮层展示模型额度、单次输入上限、本会话已用 token |
| 悬浮额度面板 | 六行明细，可拖动、跨会话记忆位置、「恢复默认位置」一键回贴输入框 |
| 会话用量 | 在 AI 生成标识后追加「 · 本会话已用 N tokens」，不遮挡原文 |
| 本地归档 | 只读观测站点自身流量，落盘结构化的消息 / 深度思考 / 引用；内置查看器支持全文检索 |
| 导出 | 归档会话导出 Markdown，首行恒为 AI 生成标识块 |
| 稳定性 | 加载失败/超时切本地错误页（带重试），最大化不再露黑带，迷你窗往返尺寸不漂移 |

## 安装

从 [Releases](https://github.com/zhengjy273/dsk-desktop/releases) 下载：

- `dsk-desktop-setup-x.y.z.exe` —— NSIS 安装版（可选安装目录、建快捷方式、带卸载器）；
- `dsk-desktop-portable-x.y.z.exe` —— 便携版，不写注册表。

> 安装包**未做代码签名**。从网络下载后若被 SmartScreen 拦截：右键 exe → 属性 → 勾选「解除锁定」，
> 或 PowerShell `Unblock-File -Path <exe>`。安装版**不要手动移动安装目录**（卸载项与快捷方式写死了路径）。

本地数据在 `%APPDATA%\dsk-desktop\`：

```
quota\       各账号额度快照与会话用量（<账号>.json / <账号>.sessions.json）
mirror\      本地归档（mirror\<账号>\）
logs\app.log 运行日志（「诊断」菜单会往里写选择器探测结果）
```

托盘菜单「清除本地归档数据…」会同时清掉归档与额度缓存；两者都会在之后的使用中自然重建。

## 从源码运行

需要 Node 24 运行时（Electron 44 自带）与 pnpm。

```powershell
# 依赖（若没有全局 pnpm，可用任意 pnpm 的 mjs 入口；本项目作者用 DSH 内置的那份）
pnpm install

# 把 Electron 二进制复制到「干净 ACL」目录（本机环境必需，原因见下）
node scripts/setup-electron.mjs

# 启动
node scripts/launch.mjs src/main/main.ts
```

日常也可以双击根目录的「启动 DeepSeek Chat.cmd」（日志写 `logs\app.log`）。

### 两个必须知道的启动坑

1. **`ELECTRON_RUN_AS_NODE=1`**：某些宿主（如 DSH）会注入它，Electron 会退化成 Node 模式
   （`electron --version` 打印 Node 版本、应用拿不到 Electron API）。`scripts/launch.mjs` 启动前会删除它 ——
   **任何启动 Electron 的入口都走这个启动器**。
2. **Chromium 沙箱在污染目录树中崩溃**：若 Electron 二进制位于带 DSH 沙箱 ACL 的目录（孤儿 SID、
   Low Mandatory Level、缺少 AppContainer 包 ACE），沙箱子进程会以 `STATUS_BREAKPOINT (0x80000003)`
   崩在应用 JS 加载之前。`scripts/setup-electron.mjs` 把 dist 复制到 `%LOCALAPPDATA%\dsk-electron\dist`，
   启动器再用官方 `ELECTRON_OVERRIDE_DIST_PATH` 指过去，**沙箱保持启用**，不需要 `--no-sandbox`。
   应急开关 `DSD_NO_SANDBOX=1`（仅沙箱再次不可用时，且须记录原因）。

### TypeScript 直接运行（strip-only）

Electron 44 内嵌 Node 24，`electron src/main/main.ts` 可直接运行、无需构建。但它的类型剥离是
**strip-only**：不支持需要代码转换的语法 —— 构造函数参数属性（`constructor(private x)`）、
`enum`、`namespace`、装饰器。这类写法 `tsc` 不报错，只在运行期抛
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`，所以有独立检查：

```powershell
node scripts/check-strip-only.mjs   # 违规时退出码 1
```

## 开发

```powershell
pnpm typecheck     # tsc --noEmit
pnpm test          # vitest run（17 个测试文件 / 372 个用例）
pnpm check         # strip-only + typecheck + 全部单测
pnpm app:selftest  # 启动自检，JSON 写入 docs/m1-evidence/t1-selftest.json
pnpm dist          # electron-builder：NSIS + 便携版
pnpm dist:dir      # 只解包，用于快速验证
```

打包产物默认输出到 `%LOCALAPPDATA%\dsk-desktop-build`（刻意不放项目目录：若项目位于带 DSH 沙箱 ACL
的目录，产物会让 Chromium 沙箱崩溃、NSIS 生成也会失败）。打包脚本自动配置国内镜像并创建 pnpm shim。

## 架构

```
src/
  main/        主进程：窗口、托盘、快捷键、多账号、注入调度、IPC
  session/     只读网络镜像（SSE / 请求体）、额度解析、指纹纯函数库（未接线）
  inject/      注入页面的额度浮层、选择器注册表
  store/       归档 / 搜索 / 额度持久化（<账号>.json、<账号>.sessions.json）
  features/    导出（Markdown、AI 标识块）
  shared/      契约类型、品牌配置、选择器清单
  shell-ui/    本地页面：错误页、归档查看器、账号输入
scripts/       启动器、Electron 准备、strip-only 检查、打包
tests/         vitest 单测
docs/          合规、已知限制、M0–M2 报告、v1.1.5 审计与功能测试报告
```

关键实现点：站点数据全部来自「页面自己已经发出的请求」的只读镜像；额度浮层通过模板字符串注入，
不读取任何表单值；视图边界在 `resize` 之外还监听 `resized` 并对最大化/全屏路径补钉，避免黑带。

## 版本历史

| 版本 | 内容 |
|---|---|
| **v1.1.5** | 审计修复 13 项：浮层恢复默认位置跨重载、额度缓存删除、会话用量归属、监听器泄漏、外部跳转拦截、坏 `updatedAt` 自愈、迷你窗尺寸漂移（BUG-4/5/6）、历史响应按会话 id 归属、严格 origin 比较等；新增 v1.1.5 审计与两轮功能测试报告 |
| v1.1.4 | 托盘菜单瘦身：取消页面快照导出，导出归档只出 Markdown，查看器同步精简 |
| v1.1.3 | 修复最大化/全屏时页面不跟尺寸、底部露黑带 |
| v1.1.2 | 移除回答下方次数提示；迷你窗隐藏浮层；token 改为追加；浮层可拖动并跨会话保持；修复展开不贴合、token 恒 0、SPA 切会话 id 不刷新 |
| v1.1.1 | 修复额度浮层不跟随、展开后错位 |
| v1.1.0 | 限额可视化：/chat/status 与 /client/settings 只读解析、托盘 tooltip、账号行、输入框浮层、会话 token |

## 已知限制

先看 [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md)。最常被问到的几条：

- 站点不下发「本会话剩余总量」，只显示**已用**；不编造剩余值。
- 重新生成/修改次数没有权威计数，v1.1.2 起整块不再显示。
- 只有窗口可见时站点才轮询额度；窗口隐藏期间的数值会滞后，恢复后约 5 分钟内刷新。
- 归档来自运行期流式观测，**不追溯**补档历史消息。
- `src/session/fingerprint.ts` 是未接线的纯函数库，运行时 UA 仍为 Electron 默认值（文档已如实标注）。

## 免责与合规

本项目仅用于个人学习与自用，按现状（as-is）提供，不承诺维护，不保证与站点未来的任何版本兼容。
若站点服务条款或界面变更导致不可用，属于预期之内。账号、登录状态与内容均由你本人直接在官方站点
产生与持有，本项目不代持、不落盘、不上传。文档目录中的 `compliance.md` 是开发者给自己定的红线清单，
随代码一起公开仅为了说明实现边界。
