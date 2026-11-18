# 合规台账（R1–R8 实现与证据）

> 依据：《DeepSeek 用户协议》（更新/生效 2025-09-05）
> <https://cdn.deepseek.com/policies/zh-CN/deepseek-terms-of-use.html>
> 适用范围：本机自用版本（D-02），不公开分发。条款会更新（协议 10.1），**每次发版前复核**。
> 本文件是工程自检台账，不构成法律意见。

## 状态总览

| # | 红线 | 阶段 | 状态 |
|---|---|---|---|
| R1 | 不接触账号凭据 | M0 | ✅ spike 已自证（见下） |
| R2 | 不逆向内部接口 | M0 | ✅ spike 无任何 fetch/XHR |
| R3 | 不破坏 AI 生成标识 | M1 已落地 | ✅ 注入层只「追加」用量片段，不改写原文（v1.1.2 起）；导出产物首块恒为标识 |
| R4 | 零品牌特征（已登记例外） | M0 | ⚠️ 明示例外（D-01）；内部标识已品牌中性 |
| R5 | 只归档自己的内容 | M2 已落地 | ✅ 仅本机、无遥测；「清除本地归档数据…」已提供（v1.1.5 起一并清额度缓存） |
| R6 | 不建账号共享 | M1 待验 | ⏳ "多身份"仅限本人账号 |
| R7 | 正常使用不自动化 | M0 | ✅ 无自动化登录；测试计划全走本地 mock |
| R8 | 条款为最终准绳 | 持续 | ✅ 已建立复核点 |

## 逐条实现证据

### R1 不接触账号凭据（依据：隐私/账号条款；本方案自设）
- `spike/main.mjs` 中不存在读取 `input`/`textarea` 值、`localStorage`/`sessionStorage` token 的代码路径。
- 页面快照脚本 `SNAPSHOT_SCRIPT` 只读：`document.title`、`body.innerText.length`、元素计数、
  "AI 生成"等标记词的**命中情况**、按钮/标题的截断文本；**不读取任何输入控件的 value**。
- cookie 证据只记录 `name` / `domain` / `session` / `expirationDate`，代码注释明确 **永不记录值**。
- 权限默认全拒，仅放行 `clipboard-sanitized-write`（站点"复制"按钮所需），每次请求都打日志。
- 待补：M1 注入层必须保持"隔离世界"，并加一条自动化断言——注入代码中不出现对
  `document.querySelector('input'|'textarea').value` 与 storage token 的访问（可用静态检查实现）。

### R2 不逆向内部接口（依据：协议 3.5(3)）
- spike 不使用 `fetch`/`XHR` 调用站点接口，不构造 `x-ds-pow-response` 等请求头。
- `onBeforeSendHeaders` 只做**去掉 Electron 指纹**的改写 + 记录首个主框架请求头（观测页面自身发起的请求）。
  - ⚠️ **现状更正（2026-11-17）**：该改写只在实验脚本 `spike/main.mjs:200` 里存在，**M1 主进程未接线**
    （`setupSession()` 无 `onBeforeSendHeaders`，全库无 `setUserAgent`）。这不影响 R2 的"不逆向"判定
    —— 这个钩子本来只允许去指纹、不涉逆向；但 M0 报告里 V5a/V5b/V5c 的 PASS 描述的是实验期能力，
    不是产品现状，已在 `docs/M0-REPORT.md` 顶部加更正说明。
- `onHeadersReceived` 只读取响应头（`x-frame-options`/CSP 等）用于 V10 结论，不改写、不重放。
- 待补：M2 的 `NetworkMirror` 设计为"只读已发生的 SSE 字节"，禁止重放；落地时加代码评审项。

### R3 不破坏 AI 生成标识（依据：协议 3.4(3)、5.3）
- M0 阶段不注入任何 CSS/JS 到站点页面。
- 快照已能检出标识文本（`aiMarkHits`），M1 需加断言：增强层开/关时标识元素**存在性与可见性一致**（V11）。
- 导出与复制功能必须在产物中写入"本内容由 AI 生成"标识（DD-15），不得凭空去标识。

### R4 品牌特征（依据：协议 6.2）
- **已确认例外**：应用名 `DeepSeek Chat`，仅本机自用（D-01）。公开分发前必须改名。
- 品牌中性化已落地：`INTERNAL_APP_ID = com.local.dskdesktop`；包名 `dsk-desktop`；
  项目目录 `deepseek-desktop`（仅本地路径）。
- 不使用官方 Logo 作图标（M3 打包时必须自制素材）；"关于"页需写明"非官方，仅本地自用"。
- **图标（M1 已接入）**：应用与托盘图标使用**用户自备素材** `assets/source/haofeiyu.png`，
  由 `scripts/make-icons.py` 生成 `icon.ico` / `icon-256.png` / `tray-32.png`（可复现，换图只需替换源图重跑）。
  该素材不含 DeepSeek 商标或 LOGO；**公开分发前必须确认素材权利**或换成自有素材。
- 待补：M3 前检查安装包名、更新源 URL、文件属性中的品牌字符串。

### R5 只归档自己的内容（依据：协议 4.2）
- 归档仅存本机（`userData/mirror/`），仅限用户本人会话（按 account partition 隔离），无公开分享能力。
- **无任何遥测/上报**：全库无 `fetch`/`XMLHttpRequest` 调用站点，镜像走 `webContents.debugger` 只读旁听。
- **一键清除已提供**：托盘「清除本地归档数据…」（两道确认）；v1.1.5 起同时清除 `userData/quota/` 的额度缓存。
- 导出为显式用户操作（v1.1.4 起只出 Markdown，产物首块恒为 AI 生成标识）。

### R6 不建账号共享（依据：协议 2.3(4)）
- 规划中：多身份 = 用户本人的多个账号（如个人/工作），每身份独立分区。
- 禁止实现账号池、代持登录、账号出借。

### R7 正常使用不自动化（依据：协议 2.3(3)、3.5）
- 无自动化登录脚本；M0 的 V2/V3/V7 全部由用户手动完成。
- 回归测试计划（M1）使用 `fixtures/mock-chat` 本地站点，禁止打真实账号。

### R8 条款复核（依据：协议 10.1）
- 复核时点：M0 开始前（已完成，见 PLAN §10.5）、每次发版前、协议更新后。
- 复核方式：重新抓取协议页面，比对 §1.3 表中条款编号与表述，Diff 记录到本文件。

## Chromium 沙箱：根因与修复（M0 已解决 —— **不需要**禁用沙箱）

**现象**：Electron 在加载应用 JS **之前**以 `0x80000003`(STATUS_BREAKPOINT) 退出（`spike/diag.mjs` 探针 0 行）；
`--enable-logging=stderr` 零输出；`--disable-gpu`、`--disable-gpu-sandbox` 均无效；当时只有 `--no-sandbox` 能启动。

**根因（已实证）**：`electron.exe` 位于被 **DSH 工作区沙箱 ACL** 污染的目录树中：
- `<workspace>`（工作区根）带**显式**孤儿 ACE `S-1-4-85086085-674777630:(OI)(CI)(W,D,DC)` ——
  该 SID 经 `SecurityIdentifier.Translate()` 证实**不可解析（孤儿）**，其下所有子目录继承之；
- 同一处带 `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`（DSH 受限 token 留下的低完整性标签）；
- 整条路径链上 **没有任何 AppContainer 包 ACE**（`S-1-15-2-1` / `S-1-15-2-2`）。

这正是 electron/electron#51761 在 Windows 11 25H2 上描述的组合（DACL 中的 zombie SID + 缺
ALL APPLICATION PACKAGES），也与 hermes-agent 记录的恢复阶梯一致（"只有 --no-sandbox 能活，
--disable-gpu 同样崩"）。

**因果验证（决定性）**：把 `dist` 复制到干净 ACL 目录 `%LOCALAPPDATA%\dsk-electron\dist`
（仅 SYSTEM / Administrators / 当前用户三条 ACE），用官方 `ELECTRON_OVERRIDE_DIST_PATH` 指向它，
在**不加 `--no-sandbox`** 的前提下 `spike/diag.mjs` 9 步全过、exit 0，且 stderr 出现
`js2c/sandbox_bundle` —— 证明沙箱确实处于启用状态。

**修复（已落地）**：
- `scripts/setup-electron.mjs`：把 dist 复制到干净 ACL 目录（幂等，`--force` 可重建）；
- `scripts/launch.mjs`：自动设置 `ELECTRON_OVERRIDE_DIST_PATH`，**默认启用沙箱**；
  应急才用 `DSD_NO_SANDBOX=1`（并须记录原因）。
- **不修改 DSH 工作区（`<workspace>`）的任何 ACL** —— 那是 DSH 自身沙箱机制的一部分。

**残余风险**：无（沙箱保持启用）。注意这只是**开发期路径问题**：M3 打包安装到
`%LOCALAPPDATA%\Programs\...` 后，Electron 不再位于被污染的目录树，问题自然不复现。
公开分发前建议在干净机器上复验一次沙箱状态。

## 变更历史

| 日期 | 变更 | 触发 |
|---|---|---|
| M0 启动 | 建立台账；核实协议 3.4/3.5/4.2/5.3/6.2/8.1/10.1 | 方案 v1.1 |
| M0 启动 | 登记 D-01 品牌明示例外（仅自用） | 用户决策 |
