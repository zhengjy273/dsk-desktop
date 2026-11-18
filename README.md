# dsk-desktop

本机自用的 **DeepSeek 免费网页版（chat.deepseek.com）桌面壳**。
当前阶段：**M0–M3 完成** —— 桌面壳（托盘 / 快捷键 / 迷你窗 / 主题 / 代理 / 错误页）
+ 只读网络镜像与**双向结构化归档**（查看器 + 双路导出）+ **多账号**
+ **打包分发**（NSIS 安装包 / 便携版，均已实测运行）。
> 已按用户决定移除：**标签页**（与站点侧边栏重复）与**"回答完成"通知**（DOM 启发式误报多）。
**使用中遇到问题的分类对照见 [docs/KNOWN-LIMITS.md](docs/KNOWN-LIMITS.md)**（哪些是设计决定、哪些是已知限制、哪些该报给我）。

> 完整方案见 [PLAN.md](PLAN.md)；合规约束与证据见 [docs/compliance.md](docs/compliance.md)；可行性验证见 [docs/M0-REPORT.md](docs/M0-REPORT.md)；M1 任务卡见 [docs/M1-TASKS.md](docs/M1-TASKS.md)。

## 这是什么 / 不是什么

- ✅ 一个 **Electron 壳**：用独立持久化分区加载官方站点，用户自行登录，附加桌面能力（托盘/多会话/本地归档/导出 —— M1 起）。
- ❌ **不**逆向站点接口、**不**代持或落盘账号凭据、**不**隐藏站点的 AI 生成标识、**不**做账号共享。
- ❌ 当前**不公开分发**。应用名与协议 6.2 的冲突已登记为「R4 明示例外」，公开分发前必须改名换图标。

## 快速开始

```powershell
# 0) 用 DSH 内置的 pnpm（系统 npm 的 .ps1 被执行策略拦截）
$pnpm = "<dsh-install>\resources\runtime\pnpm\bin\pnpm.mjs"
node $pnpm install

# 1) 准备"干净 ACL"的 Electron 二进制（必须，原因见下）
node scripts/setup-electron.mjs

# 2) 自动化可行性检查（约 40 秒，会自动退出）
node scripts/launch.mjs spike/main.mjs --auto

# 3) 交互模式（窗口内登录，Ctrl+Shift+S 抓快照，Ctrl+Shift+D 抓控件结构，关窗自动写报告）
node scripts/launch.mjs spike/main.mjs

# 4) 复用"已登录分区"跑自动检查（验证登录态持久化 V4 + 提取选择器素材）
node scripts/launch.mjs spike/main.mjs --auto --session=main --probe-selectors

# 5) 把 events.ndjson 里的自动判定 + 人工证据汇总成冻结版报告
node spike/m0-freeze.mjs

# 6) 静态检查与单元测试（M1 的 G1/G2 两个 Gate）
pnpm typecheck
pnpm test

# 7) 插件生态侦察（按关键词过滤 4471 个插件的注册表快照）
node spike/registry-scan.mjs webview tray desktop
node spike/registry-show.mjs dsh-deepseek-chat

# 8) 日常使用：双击根目录的「启动 DeepSeek Chat.cmd」（日志写到 logs\app.log，出问题发我）
#    等价命令行（复用已登录数据目录，避免重复登录）：
$env:DSK_USERDATA="$PWD\.spike-userdata-main"; node scripts\launch.mjs src\main\main.ts
#
#    托盘右键菜单（结构已固化为自检断言 trayMenuLabels，改乱会被自检暴露）：
#      显示 / 隐藏 · 迷你窗 · 置顶窗口 · 查看本地归档… · 导出归档(→ 当前会话/历史会话 → Markdown)
#      · 清除本地归档数据… · 诊断（写日志）
#      · 账号：<当前账号> · <额度摘要>(→ 切换 / 添加自定义账号 / 删除指定账号 / 退出登录) · 退出
#      v1.1.4 起：取消「导出页面快照」，原位由「清除本地归档数据…」接替；导出只剩 Markdown，
#      标签不再带"（结构化）"（JSON 出口已去掉）。
#      v1.1.5 起：「清除本地归档数据…」连 `userData/quota/` 的额度缓存一起清。
#
#    账号隔离：登录态按 partition（`persist:dsk-<account>`）、本地归档按 `mirror/<account>/`。
#      切换 / 添加 / 退出登录会**重启应用**（partition 在 app 启动时决定）；删除账号需**两道确认**，
#      且不允许删除当前账号。账号 id 走路径片段校验（防穿越）。
#
#    「查看本地归档…」= 只读查看器（src/shell-ui/archive.html）：
#      左侧会话列表 + 全文检索（空格分隔=AND，含深度思考内容，命中显示片段）
#      + 逐条消息详情（顶部固定 AI 生成标识，R3）+ 导出 Markdown（v1.1.4 起只剩这一个出口）。
#      安全：contextIsolation + sandbox + 仅 4 个白名单 IPC（主进程再校验参数）。
#
#    诊断项会做一次只读的选择器探测 + 结构发现，结果写入 logs\app.log 的 [selectors] / [discover] 行。
#
# 9) 打包（M3）：NSIS 安装包 + 便携版
node scripts/package.mjs          # 等价 pnpm dist
node scripts/package.mjs --dir    # 只解包（快，用于验证）
#
#    产物默认输出到 %LOCALAPPDATA%\dsk-desktop-build —— **刻意不放项目目录**：
#    <workspace> 的 DACL 有问题（孤儿 SID + Low Mandatory Level），产物放里面会让
#    Chromium 沙箱以 0x80000003 崩溃，且 NSIS 生成安装包那步 exit 2；放 %LOCALAPPDATA% 就正常
#    （也正与实际安装位置一致）。打包脚本会自动设置镜像并造 pnpm shim。
#
#    交付物约定位置（**都放项目根**，用户指定）：
#      dsk-desktop-分发包.zip             ← 跨设备分发包（安装包 + 便携版 + 分发说明.txt）
#      dsk-desktop-backup-<时间戳>.zip    ← 源码 + 文档备份
#    安装包本体仍在 %LOCALAPPDATA%\dsk-desktop-build\（electron-builder 的输出**必须**留在那里）。
#    ⚠️ 项目目录里的这些 exe **不要在本机直接双击运行**（<workspace> 的 DACL 会让 Chromium 沙箱
#       以 0x80000003 崩溃）；**复制到别的设备运行完全正常**。
#
#    ⚠️ 安装版**不要手动移动安装目录**：NSIS 的「注册表卸载项 / 卸载器 / 快捷方式」三处
#       都硬编码了安装路径，移动后会表现为「setup 无反应、卸载不掉、快捷方式失效」。
#       想换位置请二选一：重装时在向导里选目录（静默可用 setup.exe /S /D=<路径>），
#       或者直接用便携版（不写注册表，放哪都行）。
#
#    ⚠️ 安装包**未签名**：跨设备分发（U 盘/网盘/拷贝）后会被 Windows 打上"来自网络"标记，
#       SmartScreen 或杀软会拦截 —— 表现为"双击没反应 / 一闪而过 / 弹窗"。
#       在目标设备上：右键 exe → 属性 → 常规页底部勾「解除锁定」→ 确定，再双击
#       （或 PowerShell：Unblock-File -Path <exe>；SmartScreen 弹窗则点「更多信息 → 仍要运行」）。
#       彻底免除该提示需要代码签名证书，本项目自用不购买。
#       跨设备分发可用「分发说明.txt」+ 两个 exe 一起打包（见下文"分发包"）。
```

## 两个本机环境坑（都已修复，勿回退）

### 1. `ELECTRON_RUN_AS_NODE=1`

DSH 会把它注入 shell 环境，导致 Electron 退化为 Node 模式（`electron --version` 会打印 Node 版本、应用拿不到 Electron API）。
→ `scripts/launch.mjs` 在启动前删除该变量。**任何启动 Electron 的入口都必须走这个启动器，不要直接调 `electron`。**

### 2. Chromium 沙箱在污染目录树中崩溃

本机 Electron 默认装在 `<workspace>\...`，而该目录树带有 **DSH 工作区沙箱**留下的：

- 显式孤儿 ACE `S-1-4-85086085-674777630:(OI)(CI)(W,D,DC)`（该 SID 无法解析）
- `Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)`
- 整条路径链**没有任何 AppContainer 包 ACE**（`S-1-15-2-1` / `S-1-15-2-2`）

Chromium 的沙箱子进程在这种 DACL 下会以 `STATUS_BREAKPOINT (0x80000003)` 崩在应用 JS 加载**之前**
（对应 electron/electron#51761，Windows 11 25H2 可复现；`--disable-gpu` 同样崩）。

→ `scripts/setup-electron.mjs` 把 `dist` 复制到 `%LOCALAPPDATA%\dsk-electron\dist`（ACL 干净），
`scripts/launch.mjs` 用官方 `ELECTRON_OVERRIDE_DIST_PATH` 指过去，**沙箱保持启用**。
**不要去改 `<workspace>` 的 ACL** —— 那是 DSH 自身沙箱机制的一部分。

应急开关（仅在沙箱再次不可用时使用，并须记录原因）：`$env:DSD_NO_SANDBOX='1'`。

### 3. `.ts` 由 Electron 直接运行 → strip-only 语法限制

Electron 44 内嵌 Node 24，`electron src/main/main.ts` 可**直接运行、无需构建步骤**（已实测）。
但它的类型剥离是 **strip-only**：只擦类型，**不支持**以下需要代码转换的语法，运行期会抛
`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`：

- **构造函数参数属性**（在 constructor 的参数上直接写 `private`/`readonly`）← 本项目踩过两次
- `enum` / `namespace` / 装饰器

`tsc` 不会报这类错（类型层面合法），只在运行期炸，所以配了一道独立检查：

```powershell
node scripts\check-strip-only.mjs   # 有违规时退出码 1
pnpm check                          # = strip-only 检查 + typecheck + 全部单元测试
```

## M1 进度（当前）

| 任务 | 状态 |
|---|---|
| T0 契约层（`src/shared/**`） | ✅ 完成 |
| T1 外壳（单会话视图 / 托盘 / 快捷键 / 迷你窗 / 主题 / 代理 / 导出） | ✅ 自动自检全绿 → `docs/m1-evidence/t1-selftest.json` |
| T2 会话与注入（`src/session/**`、`src/inject/**`） | ✅ **网络通道镜像**（SSE / 请求体，只读）+ 选择器注册表（失配降级 / 诊断 / 结构发现）；⚠️ 指纹改写**未接线**（见下方说明） |
| T3 归档与导出（`src/store/**`、`src/features/**`） | ✅ 完成（覆盖率 store 87% / export 96%） |
| T4 打包与更新 | ✅ M3：electron-builder 打包（NSIS 安装包 + 便携版）**均已实测运行**；图标经 `win.icon` 生效，**任务栏图标已确认**为自定义图标；自动更新未做 |
| T5 夹具与回归 | 🚧 mock 站点 ✅、单测 ✅；smoke 与 `.dsh/skills` 待做 |

**导出的现状（v1.1.4，诚实说明）**：只剩**一条**导出路径 —— **导出归档**（结构化：逐条消息 + 深度思考 + 引用，
来自 T2 的网络通道 SSE 观测，产物 AI 生成标识恒为第一块），且**只出 Markdown**。
M1 时期的**页面快照导出**（AI 标识块 + 页面全文）与 JSON 出口已按用户要求在 v1.1.4 整个取消：
快照只是页面文本堆叠、不含消息结构，与归档导出重复且容易被误当成结构化产物。
注意归档来自**运行期流式观测**，历史消息不追溯补档。

**指纹改写的现状（v1.1.4，诚实说明）**：`src/session/fingerprint.ts` 是一个**纯函数库**
（`buildUserAgent` / `buildClientHints` / `applyFingerprintHeaders` / `stripElectronBrand`，
单测 `tests/unit/fingerprint.test.ts` 覆盖），但**主进程没有接线** ——
`src/main/main.ts` 的 `setupSession()` 里没有 `session.webRequest.onBeforeSendHeaders`，
全库也搜不到 `setUserAgent`。因此**运行时 UA 仍是 Electron 默认值**（含 `Electron/44.x`），
`Sec-CH-UA` 系列头也照 Electron 原样不发。
M0 时期的 V5a/V5b/V5c 三条 PASS 是在实验脚本 `spike/main.mjs:200` 的 `onBeforeSendHeaders`
里跑出来的（该脚本仍在，改写逻辑完整），**但那段代码没有搬进 M1 的主进程**。
按用户决定（2026-11-17）：**保持现状、只改文档**，不在主进程接线。
若将来需要真正生效，把 `spike/main.mjs` 里那段改写搬进 `setupSession()` 即可，
并应在 `runUtilSelftest()` 加一条"接线存在"的断言，避免文档与代码再次脱节。

**架构要点（M1 最终：无标签页 · 单会话）**：窗口里只显示**一个** `chat.deepseek.com` 页面
（`src/main/content-view.ts`），内容占满窗口。**不做标签页** —— 站点自带的侧边栏已经承担会话管理，
应用层再加一层与之**重复**、费内存，而且会引入大量状态。
配套：**加载失败/超时切本地错误页**（`src/shell-ui/error.html`，带重试按钮，25 秒超时）。

> 决策留痕：曾短暂实现过"多标签 + 标签栏"，随后按用户决定**整体移除**。原因链：
> ①每标签一个视图 → 每个都完整加载站点 → 快速连点新建并发请求被**站点限流** → 新标签空白/黑屏；
> ②改为单视图 + 连点合并仍不够（连点产生连续导航、且标签无实际价值）；
> ③最终结论：标签功能与侧边栏重复，删除。相关文件（`src/main/tabs.ts`、`tabbar.html`、`preload.cjs`）已删除。

**图标**：源图放 `assets/source/`，然后
`python scripts/make-icons.py` → 生成 `icon.ico`（多尺寸）/ `icon-256.png` / `tray-32.png`。
换图只需替换源图后重跑脚本（脚本同时做居中裁方）。

**任务栏图标（开发期限制，留到 M3 解决）**：Windows 的任务栏图标取自 **exe 自身的图标资源**，
而开发期跑的是 `electron.exe`，`BaseWindow({ icon })` 只管窗口标题栏 —— 所以开发期任务栏显示 Electron 图标。

> ⚠️ **不要试图在开发期 patch exe 图标**（这是踩过的坑）：用 resedit 改写 `electron.exe` 的图标资源后，
> 进程正常启动、窗口句柄也创建了，但 `win.show()` 之后窗口**始终 `visible=false`**（EnumWindows 确认），
> 表现为"应用起来了但没有窗口"；换回干净 exe 立即恢复。
> **M3 待办**：由 electron-builder 的 `icon` 配置正式设置（`assets/icon.ico` 已就绪），并确认安装包与卸载项图标。

## 目录

```
spike/             M0 可行性验证（main.mjs 主程序、diag.mjs 启动探针、registry-*.mjs 插件侦察）
scripts/           launch.mjs（统一启动器）、setup-electron.mjs（干净 ACL 的 Electron）
docs/              PLAN 配套：M0-REPORT.md、compliance.md、m0-evidence/（证据与日志）
fixtures/          （M1）本地 mock 站点，所有自动化测试都打它，禁止登录真实账号
src/               （M1）正式实现：shared 契约 / main 外壳 / session 注入 / store 归档
```
