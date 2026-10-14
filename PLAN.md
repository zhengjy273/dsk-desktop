# DeepSeek 免费 C 端桌面版（代号 **DSK Desktop**）— 整体框架与实施流程

> 目标站点：<https://chat.deepseek.com>（DeepSeek 免费 C 端网页版）
> 制作方式：以 **DSH（DeepSeek Harness）** 作为主要开发与验证载体
> 技术路线：**Electron 桌面壳 + 页面注入增强层**（已确认，合规优先）
> 文档版本：v1.1（含合规条款核实与竞品修正） · 状态：待你确认后进入 M0

---

## 0. 结论速览（TL;DR）

| 项 | 结论 |
|---|---|
| 产品形态 | 独立 Windows 桌面应用，用**独立持久化分区**加载 `chat.deepseek.com`，用户自行登录 |
| 技术栈 | Electron：`BaseWindow + WebContentsView`（**BrowserView 自 Electron 29 已废弃**）+ preload 隔离世界注入 |
| 合规红线 | 不逆向接口、不代持凭据、不破坏 AI 生成标识、不建账号共享、不使用 DeepSeek 商标/Logo |
| 首版（M1）范围 | 托盘 + 全局快捷键、多会话标签、本地会话归档与 Markdown 导出、完成通知、深色跟随、代理、置顶/迷你窗 |
| **竞品现状（重要）** | 官方桌面端 = **DeepSeek Harness（DSH 本体，agent 产品）**；官方**聊天**形态只有网页版 + iOS/Android App。**桌面端的"免费聊天客户端"官方没有** ← 本项目的空位 |
| 差异化定位 | 免费额度 + 桌面常驻体验 + 本地会话资产（归档/检索/导出），而不是"更强的模型" |
| 关键风险 | 站点改版致注入失效；Electron 指纹被风控识别；品牌条款与生成标识条款踩线；无代码签名触发 SmartScreen |
| 关键对策 | 选择器注册表 + 诊断 + 降级开关；UA/CH 去痕自检；本地 mock 站点回归；命名与界面零 DeepSeek 品牌特征 |
| 最大前置不确定性 | **M0**：站点在 Electron 内能否正常登录与流式对话。**不通过就换壳（pywebview → Tauri），不继续投入** |
| 与"DSH 桌面端"的关系 | 那 8 个社区桌面端是"给 DSH 做壳"；本项目是"**用 DSH 做给 chat.deepseek.com 的壳**"，产物为纯 Electron 应用，运行时不依赖 DSH |

---

## 1. 目标与边界

### 1.1 产品目标

1. 让 DeepSeek 免费网页版在桌面上拥有**原生客户端体验**：常驻托盘、一键唤起、多会话、置顶/迷你窗、系统通知。
2. 提供网页版**不提供**的本地能力：会话本地归档、全文检索、Markdown/JSON 导出、多身份隔离。
3. 增强层**永不影响**基础可用性：任何注入失败都必须退化为一个干净的浏览器窗口。
4. 全程可被 DSH 自动化开发、验证、打包与回归。

### 1.2 非目标（明确不做）

- ❌ 不实现"免登录""共享账号""账号池""绕过付费与额度"。
- ❌ 不逆向 `chat.deepseek.com` 的内部 API、不破解 PoW 挑战、不伪造设备指纹、不重放请求。
- ❌ 不抓取、不批量导出他人内容、不上传任何会话到第三方。
- ❌ **不删除、不隐藏、不改写站点的 AI 生成内容标识**（协议 3.4(3)/5.3 明令禁止）。
- ❌ 不使用 "DeepSeek" / "深度求索" 商标、Logo、域名等品牌特征（协议 6.2）。
- ❌ 不做移动端；不做浏览器扩展（可作 M4 备选）。

### 1.3 合规红线（写进代码评审清单，附协议条款）

| # | 红线 | 依据 | 落地方式 |
|---|---|---|---|
| R1 | 不接触账号凭据 | 隐私/账号条款；本方案自设 | 登录完全由站点页面完成；**代码中不存在**任何读取输入框/表单值的路径，包括临时调试 |
| R2 | 不逆向内部接口 | 协议 **3.5(3)**：禁止反向工程、以机器人/爬虫/自动设置/镜像等方式抓取复制本服务内容 | 只做"渲染页面 + 观察页面已产生的数据"；禁止 `fetch`/`XHR` 重放站点接口 |
| R3 | 生成标识不可破坏 | 协议 **3.4(3)、5.3** | 注入层不得隐藏/移除任何 AI 生成标识元素；**导出产物必须自带"本内容由 AI 生成"标识**（亦符合 3.1(2)） |
| R4 | 零品牌特征 | 协议 **6.2**：禁止擅自使用"深度求索""DeepSeek"等商标/LOGO/URL/网站名称，禁止暗示有权使用 | 应用名、图标、界面内**不出现** DeepSeek 品牌元素；仅"关于"页做事实性说明并显著标注"非官方"；不注册含该标识的商标/域名 |
| R5 | 只归档自己的内容 | 协议 **4.2**：输入输出的权利归用户，可用于个人使用 | 镜像与导出**仅限用户本人会话**、默认本地、仅个人使用；不做服务端汇总、不做公开分享功能 |
| R6 | 不建账号共享 | 协议 **2.3(4)**：账号不可转让/出借/出租/提供给他人 | "多身份"仅指用户自己合法拥有的账号（如个人/工作），不做账号池、不与第三方共享 |
| R7 | 正常使用不自动化 | 协议 **2.3(3)**、3.5 | 无自动化登录、无批量注册、无并发压测；测试一律打本地 mock 站点 |
| R8 | 条款为最终准绳 | 协议 **10.1**：协议会更新并公示 | 实现前与每次发版前复核最新版；有冲突时以"只用浏览器原生能力、不加自动化、少碰数据"为收敛方向 |

> **合规分水岭**：协议 3.5(3) 打击的是**逆向与自动化抓取**。用 Chromium 正常渲染官方页面、并由用户本人操作，不落入该条字面范围。一旦为了"更好的体验"去调内部接口或伪造指纹，立刻越线——**这正是路线 B 被否决的法律原因**。

### 1.4 差异化定位与竞品现状（已核实）

| 形态 | 官方是否提供 | 说明 |
|---|---|---|
| `chat.deepseek.com` 网页版 | ✅ | 免费额度主入口 |
| iOS / Android App | ✅ | 官方"DeepSeek 客户端" |
| Windows / macOS 桌面客户端 | ⚠️ **是 DSH** | 官方下载页的桌面端是 **DeepSeek Harness**（agent，面向长任务与本地文件读写），**不是聊天客户端** |
| **桌面端免费聊天客户端** | ❌ **没有** | ← 本项目的机会窗口 |
| 开放平台 API | ✅ | 按量付费；能力与网页版是两套体系 |

因此本项目的价值主张**不能**是"更强的模型"，只能是：

1. **免费额度 + 桌面常驻**（托盘、快捷键、通知、迷你窗）——网页版与官方移动端都没有的桌面体验；
2. **会话成为本地资产**（归档、检索、导出、可交给 agent 二次加工）；
3. **可控的隐私边界**（数据默认不出本机）。

> ✅ **复查点已自查（M0 · 2026-10-10 · 登录态实测）**：页面实际可见模式为 **「深度思考」+「智能搜索」**（证据：`selectors.probe` 的 `modeHints`）。社区"网页端只剩快速模式"的说法**不成立**，免费网页版能力未明显弱化 → 差异化重点仍应放在**本地资产 + 桌面体验**，而不是模型能力之争。

### 1.5 成功标准（可度量）

- 冷启动到可输入 < 3 s（SSD，热缓存）。
- 单标签稳定内存 < 500 MB；8 标签 < 1.8 GB（含休眠策略）。
- 注入层开/关：站点首屏布局差异 < 1.5%（截图对比），功能无回归。
- 导出 100 条消息 < 2 s，Markdown 结构完整（标题/代码块/列表/公式不丢）且**含 AI 生成标识**。
- 站点改版致选择器失配时：**核心聊天不中断**，仅诊断面板告警，48 h 内可热修。

---

## 2. 选型决策

### 2.1 候选路线对比

| 路线 | 体验上限 | 合规风险 | 维护成本 | 体积 | 结论 |
|---|---|---|---|---|---|
| **A. 网页封装 + 注入增强（Electron）** | 高 | 低 | 中（跟站点 DOM） | 80–150 MB | ✅ **采纳** |
| B. 逆向内部接口 + 自绘 UI | 最高 | **高** | 高 | 小 | ❌ 否决（见下） |
| C. 官方 API + 自绘 UI | 中高 | 低 | 低 | 小 | ⏸ 备选（M4，需自备 Key） |
| D. Python + pywebview(WebView2) + PyInstaller | 中 | 低 | 低 | ~20 MB | ⏸ **M0 不通过时的一号替补**（固定 user data 目录，登录态天然持久） |
| E. Tauri 2 + WebView2 | 中 | 低 | 中 | 3–10 MB | ⏸ 二号替补（**须自管 cookie/localStorage 搬运**，见 2.3） |
| F. DSH 客户端插件（在 DSH 内加面板） | 中 | 低 | 低 | 0 | ❌ 不作主形态（见 2.2） |

**路线 B 为何直接出局（有实证，不是推断）**

- 协议 3.5(3) 明令禁止反向工程与自动化抓取。
- 已知门槛：PoW 挑战（`x-ds-pow-response`，需官方 WASM 算 `DeepSeekHashV1`）、风控令牌、**设备指纹由第三方 SDK 生成且不可伪造**（伪造即返回 `RISK_DEVICE_DETECTED`）、WAF、`x-client-version` 需跟随官网前端版本。
- 后果实证：相关开源实现顶部挂"封号警告"，实测阶梯处罚（1 天 → 3 天 → 8 天 → 永久），免费额度并发极低；其中一个高星逆向项目已 archived。
- 结论：**技术上不可持续，法律上违规，工程上是负资产。**

### 2.2 为什么否掉"做成 DSH 插件"这个看起来最省事的路

DSH 的 GUI 是本地 `http://127.0.0.1:<port>` 的 Web 应用（实测 `HEAD /` → **401**，进程 token + signed cookie 鉴权），客户端插件跑在这个页面里（`dsh.client.platform: "web"`）。

- 想嵌 `chat.deepseek.com`，最自然是 `iframe` —— 目标站点几乎必然用 `X-Frame-Options`/CSP `frame-ancestors` 拒绝（**M0 的 V10 会实测**）。
- 退一步用 `<webview>`/Guest View 则依赖宿主是否开启 `webviewTag`，属不可控内部行为。
- 结论：**不要把自己的产品绑在别人的宿主上。** 正确姿势反过来——把 DSH 当成"开发这个应用的工厂"（§7）；需要联动时再写一个薄的 DSH 插件或 MCP（M4）。

### 2.3 为什么是 Electron 而不是 Tauri（本项目语境）

| 能力 | Electron | Tauri 2（WebView2） |
|---|---|---|
| 持久化分区 / 多账号 cookie 隔离 | ✅ `session.fromPartition('persist:…')` | ⚠️ **分区是进程内、每次运行随机命名**，登录态不自动持久，须自行搬运 localStorage 与（含 HttpOnly 的）cookie 到自有文件 |
| 改写请求头（UA / `sec-ch-ua`） | ✅ `onBeforeSendHeaders` | ⚠️ 能力受限 |
| 读取渲染进程网络响应（本地镜像） | ✅ `webContents.debugger` | ⚠️ 需注入页面 JS（触及 R2 边界） |
| preload 隔离世界注入 DOM | ✅ 成熟 | ⚠️ 初始化脚本可用，生态弱 |
| 托盘 / 全局快捷键 / 置顶 / 通知 | ✅ 一线 API | ✅ |
| 体积 | ❌ 80–150 MB | ✅ 3–10 MB |

判断：本项目的核心难点全在"**精确控制第三方页面的加载环境 + 只读镜像**"，这正是 Electron 的强项区；体积劣势用"不再分发 Node/pnpm（本项目不需要）"部分抵消。

**Electron 侧已知实现坑（提前排雷）**

1. `BrowserView` 自 Electron 29 废弃 → 一律用 `BaseWindow + WebContentsView`。
2. `WebContentsView` 的 `bounds` **不随窗口自动布局**，必须在 `resize` 事件里手动同步。
3. 无边框窗口需自绘拖拽区（`-webkit-app-region: drag`）。
4. Windows 通知必须 `app.setAppUserModelId(...)`，否则通知不显示/不归组。
5. Electron ≥32 移除了 `File.path` → 处理拖拽上传要用 `webUtils.getPathForFile`。
6. 高 DPI 缩放（125%/150%）与多屏需人工验收。

### 2.4 本机既有资产（开发前提，均已实测）

- DSH 内置运行时，**无需另装**：`node 24.21.0`、`pnpm 11.7.0`、`python 3.12.14`（含 numpy/pandas/python-docx/pptx/openpyxl/Pillow/lxml/XlsxWriter），位于 `<dsh-install>\resources\runtime\primary-runtime\dependencies\{node,pnpm,python}`。
- DSH CLI 可脱离 GUI 驱动（§10.1）：`dsh --profile headless "…"`。
- 已装插件市场 `dshmarket@1.66.6`；社区目录 4200+ 插件，注册源 `awesome-dsh-plugin.com`。
- 社区已有 8 个 DSH 桌面客户端先例（Tauri/Electron 皆有）——解决的是"给 DSH 做壳"，**壳的工程做法可参考，产品目标不同**。

---

### 2.5 现成插件与同类项目评估（M0 前置侦察结论）

**结论先行：以 `chat.deepseek.com` 为源、同时具备「独立壳 + 托盘 + 多会话 + 导出」的项目或插件不存在 → 自研成立。**

侦察方式：拉取 DSH 插件注册表快照（4471 个插件 / `awesome-dsh-plugin`）按关键词筛选，再对候选逐个核到 npm registry 元数据与目录页级别。
**可信度说明**：本机 `github.com` / `api.github.com` DNS 被劫持到 127.0.0.1，star / License / 提交时间**无法从 GitHub 本体核实**，改以 npm registry 元数据（含 license、repository 字段）与目录页交叉印证；**未做源码级审计**（候选包分发的均为压缩产物），故机制描述来自 README 原文。

#### A. 能"把 chat.deepseek.com 放进桌面窗口"的插件

| 插件 | 机制 | 判定 | 关键代价 |
|---|---|---|---|
| `@jaychang1989/dsh-webchat`（Apache-2.0，0.7.5） | DSH 宿主原生浏览器访客，渲染在 DSH 窗口**中栏**；无需第三方壳；本机 DSH 0.2.0-rc.2 + desktop profile **严格兼容** | ✅ **今天可用** | **把会话凭据（含 HttpOnly cookie）明文落盘**到 `%USERPROFILE%\.dsh\dsh-webchat\session.json`；无托盘/多窗口/导出 |
| `@zerorigin-studio/dsh-deepseek-chat`（MIT，0.3.5） | 只是侧栏按钮，调 `window.dsh.desktop.openWindow()`；无宿主则降级为开新标签页 | ⚠️ 只能参考 | 真正的窗口依赖另一个第三方壳 `@zerorigin-studio/dsh-desktop-shell`（Wails v3 + WebView2） |
| `dsh-auto-open-web`（MIT，0.1.29） | 包的是 **DSH 自己的 Web GUI**，与目标站点无关 | ❌ 不可用 | — |

> ⚠️ **包名陷阱**：npm 上的 `dsh-webchat` 属于**另一个作者**（Playwright 驱动真实浏览器）。按裸名安装会装到完全不同的实现，必须使用 `@jaychang1989/dsh-webchat`。

#### B. 高热度但走"路线 B（逆向）"的插件 —— 与本方案 R2 直接冲突

| 插件 | 规模 | 说明 |
|---|---|---|
| `dsh-deepseek-web-login` | ★238 / 30 天下载 10808 | 自述："浏览器登录抓取、**PoW 请求签名**、SSE 流式、工具调用" |
| `dsh-deepseek-web` | ★1 | `capabilityRedLines=[reads credentials/secrets AND has network access]` |
| `deepseek-web-import` | ★4 | 同上红线 |

这些插件证明路线 B 在生态里可行且受欢迎，但正对应协议 3.5(3) 禁止的逆向与自动化抓取，并伴随封号风险。**本方案不采用，仅登记为"已评估"。**

#### C. 对开发有直接作用的工具插件（建议 M1 阶段加装）

- `dsh-browser`（30 天下载 16097）：CDP 驱动真实浏览器、任务级会话隔离、**登录态持久化**、人机验证识别 → M1 的 UI 自动化验证
- `dsh-web-fetch-playwright` / Playwright 版 `dsh-browser`：真实浏览器渲染 + Readability 降噪
- `qa-skills`（★37）：E2E(Playwright) / API 自动化 / 回归范围等 10 个测试技能
- `dsh-screenshot` / `dsh-appshots`：外观验收（G7）取证

#### D. 现成桌面壳（"托盘常驻"的备选）

- `RAFOLIE/dsh-desktop-windowos`：Tauri v2，单文件约 4.5 MB 免安装 exe，托盘常驻 + 关闭即隐藏 + 完成通知 + 外链接管 + 单实例 + 自更新 + 崩溃自恢复
- `@zerorigin-studio/dsh-desktop-shell`：Wails v3 + WebView2

**它们包的都是 DSH 自己的 Web GUI，不是 `chat.deepseek.com`**，只在"壳层工程实现"上可参考。

#### E. 值得借鉴的设计（只学设计，不抄代码）

1. **`zcx960/deepseek-desktop`（Tauri 2）**：Chat 视图用**独立 WebView 数据目录**（`data_directory` + epoch 换目录清登录），**Chat 页零宿主命令权限**，导航仅放行同源、其余外跳系统浏览器 → 印证本方案 DD-02 / DD-13。**其 `LICENSE.details` 禁止商业二次开发，代码级复用需另行确认授权。**
2. **`jaychang1989/dsh-webchat`**：cookie 快照/回灌、分区名白名单校验、`tmp→rename` 原子写。
3. **`YiShan-X/deepseek-exporter`（油猴脚本）**：只读页面数据导出 JSON/Markdown/ZIP，零外联零持久化 → 印证导出可只依赖页面数据。

#### F. 一个关键反向印证（支持自研的合规论据）

`dsh-webchat` 之所以必须把凭据搬出来**明文落盘**，根因是 **DSH Desktop 给浏览器访客的分区是进程内随机命名、无 `persist:` 前缀**，重启即失。
而本方案用 `session.fromPartition('persist:...')`，**登录态由 Chromium 自身的加密存储承载，应用层无需读写任何凭据**。在"R1 不接触凭据"这条红线上，**自研壳比现成插件更干净** —— 这是选择自研的合规性论据，不只是功能论据。

## 3. 总体架构

### 3.1 分层架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│ L5 分发层    electron-builder(NSIS/portable) · 自动更新 · 首启引导 · 本地诊断日志│
├──────────────────────────────────────────────────────────────────────────┤
│ L4 外壳 UI   TabBar · MiniWindow · Settings · TrayMenu · CommandPalette    │
│              (轻量 TS + 原生 DOM，独立窗口，contextIsolation)               │
├──────────────────────────────────────────────────────────────────────────┤
│ L3 主进程能力 单实例 · 托盘 · globalShortcut · alwaysOnTop · nativeTheme    │
│              Notification · session.setProxy · 窗口/标签生命周期           │
├──────────────────────────────────────────────────────────────────────────┤
│ L2 会话与观测 SessionManager(partition) · UA/CH 伪装 · NetworkMirror       │
│              (webRequest + debugger) · DomMirror(MutationObserver)        │
├──────────────────────────────────────────────────────────────────────────┤
│ L1 注入增强  preload(隔离世界) · 特性开关 · 选择器注册表 · 主题桥 · 永不抛错守卫│
│              ★ 不得隐藏站点的 AI 生成标识（R3）                             │
├──────────────────────────────────────────────────────────────────────────┤
│ L0 页面      chat.deepseek.com（未修改的第三方页面，独立 WebContentsView）  │
└──────────────────────────────────────────────────────────────────────────┘
        ▲ 跨层通信只走：typed IPC（主进程 ↔ 外壳 UI）+ postMessage 桥（L1↔L2）
```

### 3.2 关键数据流（一轮对话）

```
用户输入(页面) → [L0 站点自身请求] → SSE 流式返回
      │                                    │
      │                          ┌─────────┴──────────┐
      │                          ▼                    ▼
      │                 DomMirror 观察新增节点   NetworkMirror 累积 SSE 字节
      │                          └─────────┬──────────┘
      │                                    ▼
      │                       TurnTracker 判定"本轮结束"
      │                                    │
      │                    ┌───────────────┼────────────────┐
      │                    ▼               ▼                ▼
      │            失焦→系统通知     写入本地镜像库     更新未读角标
      ▼
导出(Markdown/JSON，含 AI 标识) / 本地全文检索 / M4: 交给 DSH Agent
```

### 3.3 关键设计决策（DD）

| ID | 决策 | 理由 | 反面做法 |
|---|---|---|---|
| DD-01 | 站点跑在独立 `WebContentsView`，外壳 UI 是另一个本地页面 | 第三方页面与自家 UI 完全隔离 | 同一页面混合渲染 |
| DD-02 | 用 `persist:dsk-<accountId>` 分区，每身份一个 | 天然隔离；"清除登录态" = 清分区 | 共用默认 session |
| DD-03 | 启动即改写 UA 与 `sec-ch-ua*`，并内置自检页 | 去掉 `Electron/xx` 指纹 | 用默认 UA |
| DD-04 | 注入层走 **preload + 隔离世界**，只操作 DOM 与样式 | 隔离世界拿不到页面 JS 变量，也就天然拿不到凭据（R1） | 注入主世界 / 劫持 fetch |
| DD-05 | 增强一律走特性开关 + 选择器注册表 + try/catch 守卫 | 站点改版时降级而非崩溃 | 硬编码选择器 |
| DD-06 | 镜像**以网络通道为主**（`webContents.debugger` 解析 SSE），DOM 通道仅作兜底 | **M0 实测**：站点用 CSS Modules 哈希类名（如 `_27c9245`），图标按钮无 `aria-label`/`data-testid`/文本 → DOM 选择器天然脆弱；SSE 才是会话数据的权威来源 | 把 DOM 当主通道 |
| DD-07 | 通知 = 网络流结束 ∧ DOM 生成态结束 ∧ 窗口失焦，带去抖 | 单信号误报率高 | 只看标题变化 |
| DD-08 | 主题跟随用 `nativeTheme.themeSource` | 直接改变页面读到的 `prefers-color-scheme`，无需猜色覆盖 | 注入覆盖 CSS |
| DD-09 | 标签上限 8，后台节流 + 超时休眠 | 控内存 | 无限开窗 |
| DD-10 | 回归测试打**本地 mock 站点**，禁止自动化登录真实账号 | 可离线、可重复、合规 | 拿真账号跑 CI |
| DD-11 | 依赖最小化：electron / electron-builder / typescript / vitest / playwright + 少量工具库 | 供应链面小 | 引入大而全框架 |
| DD-12 | 一切"突破站点限制"的需求（去广告、解锁额度、绕过验证）**一律不做** | 合规红线 | — |
| DD-13 | Chat 视图**不挂任何特权命令**；跨源链接一律外跳系统浏览器 | 权限最小化（社区同类项目的成熟做法） | 给页面暴露 preload 特权 API |
| DD-14 | 注入层有**全局熔断开关**（`--no-enhance` + 设置项） | 出问题用户可自救 | 注入失败即白屏 |
| DD-15 | 导出产物强制写入"本内容由 AI 生成"标识与来源说明 | 协议 3.1(2)/5.3 | 裸导出去标识 |
| DD-16 | 品牌零特征：应用名/图标/界面均不含 DeepSeek 元素 | 协议 6.2 | 用官方 Logo 当图标 |
| DD-17 | "多身份"仅限用户本人多账号，无账号池、无共享 | 协议 2.3(4) | 账号共享功能 |

---

### 3.4 真实页面结构（M0 实测，决定 M1 注入策略）

登录态下对 `chat.deepseek.com` 的结构探针结果（只读 UI 属性，**未读任何输入值或对话正文**）：

| 目标 | 实测 | 可用的稳定锚点 | 风险 |
|---|---|---|---|
| 输入框 | 单个 `textarea` | 标签 `textarea` + 设计系统 class（`ds-scroll-area`） | class 含哈希段 `_27c9245`，**不可依赖** |
| 按钮（12 个） | 全是 `div[role="button"]`，**无 text / 无 `aria-label` / 无 `data-testid`** | `[role="button"]` + `ds-button--iconLabelTertiary` 等设计系统修饰类 | 纯图标，无法按文本定位 |
| 可见模式 | **深度思考、智能搜索** | 模式名文本匹配 | 模式名可能改名 |
| 消息节点 | 空会话下 0 个 | 需发消息后再探测 | 消息区选择器**尚未取得**（待 V3 后补齐） |
| AI 生成标识 | 空会话下 0 个 | mock 站点已能检出（`aiMarkHits` 命中） | 真实节点的定位属性待补 |

**结论**

1. **DD-06 调整为网络优先**：站点 DOM 大量使用哈希类名、图标按钮无可访问名称，DOM 解析的长期维护成本高；SSE 流才是会话数据的权威来源（顺带拿到思考过程与引用）。
2. DOM 通道**只承担少量交互**（提交、模式切换、滚动定位），且必须有 `try/catch` + 选择器失配告警（DD-05）与全局熔断（DD-14）。
3. **M1 必须先把"发一条消息之后的 DOM 结构"补齐探测**（即 V3 完成后），否则导出与通知的 DOM 兜底路径无从实现。

## 4. 模块拆分与目录结构

### 4.1 目录树（目标形态）

```
deepseek-desktop/
├─ package.json                  # 仅 Lead 可改依赖
├─ electron-builder.yml          # T4 拥有
├─ tsconfig.json / vitest.config.ts
├─ src/
│  ├─ shared/                    # T0 契约层，其他任务只读
│  │  ├─ ipc-contract.ts         # IPC 通道与载荷类型（唯一真源）
│  │  ├─ mirror-schema.ts        # 镜像 schema + 校验
│  │  └─ selectors.json          # 选择器注册表（version/minAppVersion）
│  ├─ main/                      # T1 外壳
│  │  ├─ app.ts                  # 单实例锁、生命周期、AppUserModelId
│  │  ├─ windows/{main,mini}.ts
│  │  ├─ tray.ts  shortcuts.ts  theme.ts  notifications.ts
│  ├─ session/                   # T2 会话与观测
│  │  ├─ manager.ts              # partition / 身份生命周期
│  │  ├─ fingerprint.ts          # UA + sec-ch-ua 改写 + 自检
│  │  ├─ proxy.ts                # setProxy / PAC / 连通性探测
│  │  ├─ network-mirror.ts       # M2：debugger SSE 累积
│  │  └─ dom-mirror.ts           # M1：MutationObserver
│  ├─ inject/                    # T2 注入层
│  │  ├─ preload.ts  enhancer.ts  styles.css  guard.ts  brand-safety.ts
│  ├─ store/                     # T3 归档
│  │  ├─ mirror-store.ts  search.ts  migrations/
│  ├─ features/export/           # T3 导出
│  │  ├─ markdown.ts  json.ts  html.ts  ai-notice.ts   # DD-15
│  ├─ shell-ui/                  # T1 外壳界面（tabbar/mini/settings）
│  └─ tabbar/                    # T1 标签管理
├─ fixtures/mock-chat/           # T5：本地 mock 站点（复刻 DOM）
├─ tests/{unit,smoke,e2e,golden}/
├─ scripts/{dev,pack,smoke}.mjs
├─ .dsh/skills/dsk-enhancer/SKILL.md   # T5：把本项目约束固化成 DSH 技能
└─ docs/{PLAN.md,ARCHITECTURE.md,SELECTORS.md,compliance.md,RELEASE.md}
```

### 4.2 模块职责与**写作用域**（DSH Agent Teams 分工，互斥原则）

| 任务 | 负责 | 写作用域（排他） | 依赖 |
|---|---|---|---|
| T0 契约与骨架 | Lead | `src/shared/**`, `docs/**`, `package.json`, `tsconfig*` | — |
| T1 外壳与窗口 | shell-agent | `src/main/**`, `src/shell-ui/**`, `src/tabbar/**` | T0 |
| T2 会话与注入 | inject-agent | `src/session/**`, `src/inject/**` | T0 |
| T3 归档与导出 | data-agent | `src/store/**`, `src/features/**` | T0（读 T2 契约） |
| T4 打包与更新 | build-agent | `electron-builder.yml`, `scripts/**` | T1 |
| T5 夹具与回归 | test-agent | `tests/**`, `fixtures/**`, `.dsh/skills/**` | T0 |

> 冲突纪律：`package.json` 与 `src/shared/**` **只由 Lead 改**；其他任务需要新增依赖或改契约时向 Lead 提请求。

### 4.3 IPC 契约（草案，T0 产出）

```ts
// src/shared/ipc-contract.ts
export type AccountId = string;               // "personal" | "work" …（仅用户本人账号）
export type TabId = string;

export interface MirrorMessage {
  id: string; role: 'user' | 'assistant';
  text: string; createdAt: number;
  reasoning?: string;                          // 深度思考内容（若页面展示）
  citations?: { title: string; url: string }[];
  attachments?: { name: string; size: number }[];
  aiGenerated: true;                           // DD-15：恒为 true，导出时必须体现
}

export interface ConversationMirror {
  id: string; accountId: AccountId; title: string;
  url: string; updatedAt: number; messages: MirrorMessage[];
  source: 'dom' | 'network';                   // DD-06 可追溯
  fidelity: 'partial' | 'full';
}

export type MainToShell =
  | { t: 'tabs/changed'; tabs: { id: TabId; title: string; unread: number }[] }
  | { t: 'turn/finished'; tabId: TabId; conversationId: string }
  | { t: 'theme/changed'; dark: boolean }
  | { t: 'diagnostics'; warnings: { selector: string; hits: number; lastOk: number }[] };

export type ShellToMain =
  | { t: 'tab/new'; url?: string } | { t: 'tab/close'; id: TabId }
  | { t: 'tab/activate'; id: TabId } | { t: 'win/mini'; on: boolean }
  | { t: 'export'; conversationId: string; format: 'md' | 'json' }
  | { t: 'account/add'; label: string } | { t: 'account/signOut'; id: AccountId };
```

### 4.4 会话镜像存储

- **写**：追加式 JSONL（`<userData>/mirror/<accountId>/<conversationId>.jsonl`）+ 原子重写索引 `index.json`；体量上来后迁 SQLite（FTS5）。
- **幂等**：`id` = 会话 id + 序号 + 内容哈希，DOM 通道重复观察不产生重复记录。
- **迁移**：`src/store/migrations/` 版本化，参照 DSH 会话日志 v0→v4 迁移器的做法。
- **脱敏**：导出前的诊断日志必须脱敏（参照 dshmarket 的做法）。

---

## 5. M0 可行性验证清单（**先验证，再动手**）

> 出口标准：全部绿色 → 进入 M1；任何一项红 → 触发 §2.1 替补壳（首选 pywebview，次选 Tauri），**不在错误的壳上加码**。

| # | 验证项 | 方法 | 通过判据 |
|---|---|---|---|
| V1 | 页面能否加载 | Electron 载入站点首屏 | 可渲染，无 `ERR_BLOCKED_BY_CLIENT`/证书错误 |
| V2 | **能否登录** | 人工完成手机号/邮箱/扫码登录 | 登录成功进入会话页 |
| V3 | **能否流式对话** | 发一条消息 | 逐字出现，可中断 |
| V4 | 登录态持久化 | 重启应用；并在 24 h 后再验一次 | `persist:` 分区生效；注意凭据（cookie `userToken` + localStorage）**有效期约 24 h**，"记住我"是否续期要实测 |
| V5 | 指纹去痕 | 应用内自检页读 `navigator.userAgent` / `userAgentData.brands` | **不含** `Electron`，Chromium 版本合理 |
| V6 | 风控表现 | 连续 20 轮 + 刷新 | 无验证码、无 403、无静默失败 |
| V7 | 文件上传 | 拖拽 + 选择器上传 | 正常（≥32 需 `webUtils.getPathForFile`） |
| V8 | 注入不破坏页面 | 开/关增强层各跑 20 轮 | 功能一致；截图 diff < 1.5% |
| V9 | 流式可观测 | 记录 DOM 变化时序 | 稳定判定"本轮结束"（≥20 次无漏判） |
| V10 | iframe 假设复核 | 在 DSH 页里试嵌站点 | 记录结果，为 §2.2 结论留档 |
| V11 | **生成标识完好** | 对比增强层开/关时页面上的 AI 生成标识元素 | 完全一致，未被 `display:none`/裁切/覆盖（R3） |
| V12 | 品牌合规复核 | 检查应用名、图标、首启页、托盘菜单文案 | 零 DeepSeek 商标/Logo；"非官方"声明可见（R4） |
| V13 | 页面模式自查 | 记录页面实际可见的模式/模型列表 | 为 §1.4 的复查点给出事实结论 |
| V14 | 跨源外跳 | 点击会话内的外部链接 | 走系统浏览器，不在应用内开新窗口（DD-13） |

**产出**：`spike/` 最小工程 + `docs/M0-REPORT.md`（每项：命令、结果、截图路径、判据、结论），并在 `docs/compliance.md` 记录 R1–R8 的实现证据。

---

## 6. 迭代计划

### 6.1 里程碑总表

| 里程碑 | 目标 | 交付物 | 退出条件 |
|---|---|---|---|
| **M0** | 可行性验证 | `spike/`、`docs/M0-REPORT.md`、`docs/compliance.md` | §5 全部通过 |
| **M1** | 最小可用桌面版 | 可安装运行的开发版 | §6.3 验收清单全过 |
| **M2** | 桌面体验增强 | 网络镜像、迷你窗、检索、上传透传 | §6.4 |
| **M3** | 分发与更新 | NSIS + 便携版 + 自动更新 | §6.5 |
| **M4** | 可选进阶 | DSH 联动 / 官方 API 混合 / 跨平台 | 按需评估 |

### 6.2 M0（0.5–1 天）

- 只写 `spike/`，禁止碰 `src/`。
- 一个 `main.ts`：`BaseWindow + WebContentsView` + `persist:` 分区 + UA 改写 + 自检页；一个脚本跑 V5 断言。

### 6.3 M1（首版范围，已勾选）

1. **托盘常驻 + 全局快捷键**：`Tray` + `globalShortcut.register('CommandOrControl+Shift+D')`；双击托盘切换显示；菜单含"新建会话/迷你窗/退出"。
2. **多会话标签**：TabBar（上限 8，超限提示）；后台节流；关闭即销毁 `WebContentsView`；可选恢复上次标签。
3. **本地会话归档 + Markdown 导出**：M1 走 DOM 通道；导出含标题/时间/角色/代码围栏/列表，**并强制写入 AI 生成标识与来源**（DD-15）。
4. **系统通知**：仅在窗口失焦且本轮结束时通知（DD-07）；`app.setAppUserModelId` 必设。
5. **主题跟随**：`nativeTheme.themeSource = 'system'`；外壳与页面同步；提供手动切换。
6. **网络代理**：`proxyRules`/PAC/绕过列表 → `session.setProxy` + 连通性探测 + 一键直连/代理切换；凭据用 `safeStorage` 加密。
7. **窗口置顶 / 迷你窗**：`setAlwaysOnTop(true,'floating')`；迷你窗无边框、`skipTaskbar`、显示最后一条回答 + 输入框。

**M1 验收清单**

- [ ] 冷启动 → 可输入 < 3 s；托盘出现；快捷键从任意应用唤起并聚焦输入框
- [ ] 开关增强层，20 轮对话功能一致；控制台无未捕获异常
- [ ] 导出 3 个真实会话，Markdown 渲染正确，代码块/列表无破损，**AI 生成标识存在**
- [ ] 失焦时收到完成通知；聚焦时不打扰
- [ ] 系统深浅色切换，页面与外壳同时跟随
- [ ] 代理切换后 `session.resolveProxy` 符合预期；断开代理不崩溃
- [ ] 置顶生效；迷你窗可拖动、可输入、可切回主窗
- [ ] 两个身份分区互不串号；"清除登录态"生效
- [ ] 单实例锁：重复启动唤起已有窗口
- [ ] 站点 AI 生成标识在增强层下无任何视觉变化（V11 回归）

### 6.4 M2（增强）

- **网络通道镜像**（DD-06）：`webContents.debugger` 挂 `Network.enable`，按 `requestId` 累积 `dataReceived` 字节，解析 SSE 得到完整会话（含深度思考段落与引用）。落地前后用 `fidelity: 'partial'→'full'` 标记。
- 会话本地全文检索（FTS5）、收藏、标签、会话置顶。
- 复制单条回答为 Markdown（优先复用站点自带按钮的 DOM，而非自己重写）。
- 快捷键可自定义（`userData/keybindings.json`）。
- 迷你窗升级：多会话快速切换。
- 注入健壮性：选择器诊断面板 + 失配告警 + 注册表热更新（本地文件优先；远端覆写需版本校验）。

### 6.5 M3（打包与分发）

- `electron-builder`：`nsis`（安装/卸载）+ `portable`；`asar: true`；图标/品牌素材**自制**（R4）。
- 自动更新：`electron-updater` + GitHub Releases，或最小自研版本检查。
- 无代码签名 → SmartScreen 会告警：首启页与 README 明确说明；长期维护再考虑 EV 证书。
- 本地诊断日志导出（脱敏）。

### 6.6 M4（可选进阶）

- **DSH 联动**（与本次调研最契合）：
  - 主进程用 `dsh --profile headless "<任务>" --json` 子进程方式把会话交给 DSH agent，NDJSON 事件流式回显；
  - 或写薄的 DSH host 插件，把 `dsk` 当工具/MCP server 暴露给 DSH（`dsh-mcp-client` 在 `cordis.patch.yml` 里一行即可挂载）。
- **官方 API 混合模式**（路线 C）：用户自备 Key，原生 UI 走官方 API，免费网页版作兜底。社区已有"默认 API + 侧栏保留网页版并持久化登录态"的落地实例可参考，但注意该做法需自行搬运含 HttpOnly 的 cookie —— **本方案倾向不搬运凭据，只做同一分区内的正常登录**。
- 跨平台（macOS）与浏览器扩展版本。

---

## 7. 用 DSH 开发的协作流程（核心流程）

### 7.1 总体工作流

```
① 建 goal         create_goal「交付 DSK Desktop M1」        （跨轮次记忆，防跑偏）
② 侦察与计划      /plan → 本文件 → exit_plan_mode 取你确认
③ 拆任务          todo_write + team_task_create（每任务 = 写作用域 + 验收标准）
④ 分工并行        spawn_teammate ×4（T1/T2/T3/T4）+ T5，T0 契约由 Lead 先交付
⑤ 各自实现+自测    每任务完成前跑自己的 check，不跨写作用域写文件
⑥ Lead 集成验收    合代码 → 跑 §7.4 的 Gate → 人工外观/交互验收
⑦ present 交付     文件卡片 + 里程碑报告；/export 归档开发会话
⑧ 风险门          M0 不过即停；站点改版即开"选择器热修"任务
```

### 7.2 角色与依赖顺序

```
T0 契约(Lead) ──┬─→ T1 外壳(shell-agent) ──→ T4 打包(build-agent)
                ├─→ T2 会话与注入(inject-agent)
                ├─→ T3 归档导出(data-agent)
                └─→ T5 夹具回归(test-agent)   ← 与 T1/T2/T3 并行，只写 tests/fixtures
```

- 只有 **T0 完成**后，T1/T2/T3/T5 才被唤醒（依赖即阻塞；唤醒由 Lead 显式 `send_message`）。
- T1/T2/T3 之间**无文件交叠**（§4.2），可真并行；T3 只读 T2 的**契约**，不读其实现。
- 同一时刻**不超过 3 个 writer**，避免验证噪声。

### 7.3 各里程碑的 DSH 启动提示词（可直接复制）

**M0 验证**

> 目标：完成 `docs/M0-REPORT.md` 的 V1–V14。约束：只允许写 `spike/**`、`docs/M0-REPORT.md`、`docs/compliance.md`；**不得逆向站点接口**、不得写任何读取账号/密码/验证码的代码、不得用自动化登录真实账号、不得隐藏站点上的 AI 生成标识。每项给出：执行命令、观测结果、截图路径、通过/不通过。V2/V3/V7 需要我本人操作，请准备好后用 `ask_user_question` 通知我。若 V2 或 V3 不通过，立即停止并输出"壳选型需变更"的结论与证据。

**M1 分工（对每个 teammate 的启动语）**

> 你是 `inject-agent`。读 `docs/PLAN.md` §3、§4、§5 与 `src/shared/ipc-contract.ts`。你的写作用域**仅限** `src/session/**`、`src/inject/**`。请实现：分区管理、UA/CH 去痕与自检、注入层（特性开关 + 选择器注册表 + 守卫）、DOM 镜像事件。判据：`pnpm vitest run tests/unit` 通过；用 `fixtures/mock-chat` 跑通"镜像→导出"链路；**必须证明增强层不会隐藏站点的 AI 生成标识**。不得编辑 `src/shared/**` 或 `package.json`；需要新增依赖或改契约就发消息给 Lead。完成后回报：改动文件清单、执行过的命令与结果、未解决项。

**站点改版抢修（随时可触发）**

> 站点 DOM 变更导致 `src/shared/selectors.json` 中 N 个选择器失配。请：① 用 `fixtures/mock-chat` 更新夹具以复现；② 只改 `selectors.json` 与夹具相关测试；③ 证明"旧版降级不崩溃、新注册表恢复功能"；④ 输出变更对照表（旧→新、命中率、影响的用户可见功能）。

### 7.4 验证 Gate（每个里程碑必须全过）

| Gate | 命令/动作 | 通过判据 |
|---|---|---|
| G1 类型与静态检查 | `pnpm typecheck` + `pnpm lint` | 0 error |
| G2 单元测试 | `pnpm vitest run tests/unit` | 全绿；store/export/fingerprint 覆盖率 ≥70% |
| G3 冒烟（mock 站点） | `pnpm smoke`（Playwright 驱动 Electron，载入 `fixtures/mock-chat`） | 窗口可开、注入生效、导出与 golden 一致、AI 标识存在、无未捕获异常 |
| G4 真实站点人工回归 | 按 §6.3 清单逐条勾选 | 全过，记录站点版本/日期 |
| G5 边界与安全 | 清单：无凭据读取路径、无接口重放、`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`、权限处理器已锁、生成标识未被改动、界面无品牌特征 | 逐条签字 |
| G6 打包可运行 | `pnpm pack` 产物在干净环境启动 | 可登录、可对话、可导出 |
| G7 外观验收 | 截图对比 + 人工看 | 「结构检查不等于外观检查」——必须人眼过一遍 |

### 7.5 本项目会用到哪些 DSH 能力

| DSH 能力 | 在本项目里的用法 |
|---|---|
| `create_goal` / `/goal` | 跨轮次记住"M1 交付"目标，多天开发不跑偏 |
| `/plan` + `exit_plan_mode` | 本方案的评审与冻结 |
| `todo_write` | 里程碑级待办；每个 teammate 各自维护 |
| Agent Teams（`spawn_teammate` + `team_task_*`） | T1–T5 分工与写作用域约束（§4.2） |
| `workflow` 工具 | 批量审计：对 20+ 选择器、10+ 模块并行做对抗性检查；批量生成测试用例 |
| Skills（`.dsh/skills/**`） | 把"注入约束 / 选择器更新流程 / 验证命令 / 红线"固化成 `dsk-enhancer` 技能 |
| MCP client | 可选接 Playwright 或 Chrome DevTools MCP 做 UI 验证；GitHub MCP 做发布 |
| Hooks（`hooks.json`） | 回合结束自动跑 `typecheck`+`lint`，结果回注上下文 |
| 后台作业（`job_output` 等） | 长任务：e2e、打包、站点回归，不阻塞对话 |
| `--profile headless --json` | CI 化：任务交给 DSH，NDJSON 事件流回显（M4 联动的实现方式） |
| 权限沙箱 | 编码期 `workspace-write`；打包/发布等危险动作临时提权并逐次确认 |
| `/export`、会话审计日志 | 每周归档开发会话，作为交付证据 |
| `present` | 里程碑产物（安装包、截图、报告）作为文件卡片交付 |

### 7.6 禁止事项（写进每个 teammate 的启动语）

1. 禁止任何读取站点账号/密码/验证码/token 的代码路径，包括"临时调试"。
2. 禁止对 `chat.deepseek.com` 的接口做重放、压测、批量探测。
3. 禁止在自动化测试中登录真实账号；一律用 `fixtures/mock-chat`。
4. **禁止移除、隐藏、改写站点的 AI 生成内容标识**（含用 CSS 覆盖）。
5. 禁止在应用名、图标、界面、文档中使用 DeepSeek 商标/Logo/域名品牌特征。
6. 禁止实现账号共享/账号池/代持登录。
7. 禁止编辑自己写作用域之外的文件；改动契约/依赖必须经 Lead。
8. 禁止为了让功能"看起来能用"而关闭 `contextIsolation`/`sandbox`/`webSecurity`。
9. 禁止提交真实会话内容或含个人信息的截图到仓库。

---

## 8. 质量与验收

- **DoD（每任务）**：实现 + 自测命令输出 + 文档更新 + 无越界改动 + 已知限制清单 + 合规自检（R1–R8 相关项）。
- **测试策略**：
  - 单元：`store`（幂等、迁移）、`export`（golden 对比，含 AI 标识断言）、`fingerprint`（UA 断言）、`selectors`（命中率）。
  - 冒烟：Playwright `_electron` 启动 → 载入 mock 站点 → 断言注入生效、导出产物、标识保留。
  - 回归：把"站点 DOM 快照"存为 fixture；站点改版时先更新夹具再断言。
  - 视觉：mock 站点开/关增强层截图 diff。
- **人工验收**：§6.3 清单 + 真机连续使用 30 分钟（中文输入法、多屏、休眠唤醒、DPI 125%/150%）。

---

## 9. 风险登记册

| # | 风险 | 概率 | 影响 | 对策 | 触发动作 |
|---|---|---|---|---|---|
| K1 | 站点改版致选择器失效 | 高 | 中 | 注册表 + 诊断 + 守卫降级（DD-05） | 开"选择器热修"任务 |
| K2 | Electron 指纹被风控/验证码拦截 | 中 | 高 | UA/CH 去痕自检（V5）；不自动化登录 | 换 pywebview → Tauri 复测 |
| K3 | 触及协议 3.5(3) 边界 | 低 | 高 | R2：只渲染 + 只读观察，绝不调内部接口 | 立即回滚该特性 |
| K4 | 触及生成标识条款（3.4(3)/5.3） | 低 | 高 | R3 + V11 回归 + DD-15 | 立即回滚注入规则 |
| K5 | 触及品牌条款（6.2） | 中 | 高 | R4 + DD-16 + V12 | 改名/换图标/删素材 |
| K6 | 无代码签名触发 SmartScreen | 高 | 低 | 文档说明 + 可选签名 | 购证书 |
| K7 | 多标签内存膨胀 | 中 | 中 | 标签上限 + 节流 + 休眠（DD-09） | 降上限、加休眠 |
| K8 | 镜像丢数据/重复 | 中 | 中 | 幂等 id + 原子写 + 定期导出备份 | 从站点重新镜像 |
| K9 | 凭据 24 h 过期体验差 | 中 | 中 | 失效时给出明确引导；不做自动静默续期以外的任何"绕过" | 优化登录引导 |
| K10 | 上游 Electron 安全更新滞后 | 低 | 中 | 锁版本 + 每月跟版 | 例行升级周 |
| K11 | 依赖供应链 | 低 | 中 | 最小依赖（DD-11）+ 锁文件 + 仅官方源 | 审计并替换 |
| K12 | DSH 多 agent 并行文件冲突 | 中 | 低 | §4.2 写作用域互斥 + `shared`/`package.json` 归 Lead | 冲突即回滚重做 |
| K13 | 官方产品吞并该场景（如官方出桌面聊天端） | 中 | 高 | 定位在"本地资产 + 桌面体验"，可持续迁移到官方 API 路线 | 转 M4 混合模式 |

---

## 10. 附录

### 10.1 DSH 命令速查（本机实测）

```powershell
$dsh = "<dsh-install>\resources\runtime\cli\bin\dsh.cmd"

& $dsh --version                    # → 0.2.0-rc.2
& $dsh --help
& $dsh --profile headless "任务"     # 一次性非交互；--json 输出 NDJSON；--session-id 续会话
& $dsh --profile web --no-open --port 8080    # 脱离桌面壳自托管 GUI
& $dsh plugin --profile desktop add <pkg>     # 插件安装（走内置 pnpm）
& $dsh --dump-config / --dump-default-config / --dump-config-schema
```

- Profile：`web`（GUI）/ `headless`（脚本、CI）/ `sdk`（stdio JSON-RPC）/ `sdk-minimal` / `acp`；`desktop` **由 Electron 独占**，CLI 拒绝启动。
- `--profile headless` 必须经 `dsh` 启动器启动，否则无法请求进程退出。

### 10.2 本机环境事实（方案前提）

- DSH 版本 `0.2.0-rc.2`（Electron 应用 `<dsh-install>`）；`DSH_HOME=C:\Users\<user>\.dsh`，当前 profile `desktop`。
- 内置运行时：node 24.21.0 / pnpm 11.7.0 / python 3.12.14（Office 库齐全）。
- profile 配置 = `profiles/<name>/package.json` 的 `dsh.profile.bundles` + `cordis.patch.yml`（GUI 设置也写这里）。
- 技能扫描根：`<project>/.dsh/skills`(100) → `<project>/.agents/skills`(200) → `customSkillDirs`(300) → `$DSH_HOME/skills`(400) → `<agentsHome>/skills`(500)；格式 `<name>/SKILL.md` + frontmatter。
- MCP 无独立配置文件，写在 `cordis.patch.yml` 的 loader 行（`dsh-mcp-client`）。
- 权限档位：`read-only` / `workspace-write` / `danger-full-access`，审批 ask/never。

### 10.3 DSH 开发期所需的自定义技能（T5 产出）

`.dsh/skills/dsk-enhancer/SKILL.md`，必须包含：注入层三条铁律（隔离世界、try/catch 守卫、特性开关）；选择器更新五步（复现 → 改夹具 → 改注册表 → 证明降级 → 对照表）；验证命令（G1/G2/G3）；红线 R1–R8；生成标识自检方法。

### 10.4 决策记录（已确认）

| # | 决策项 | 结论 | 影响 |
|---|---|---|---|
| D-01 | 应用名 | **DeepSeek Chat** | ⚠️ 与协议 6.2 冲突，登记为 **R4 明示例外**：仅本机自用、不公开分发、不商业使用、不申请商标/域名。名字集中在 `spike/brand.mjs`（M1 迁至 `src/shared/brand.ts`）单一常量；`INTERNAL_APP_ID=com.local.dskdesktop`、安装包名与更新源均不含品牌特征。**触发条件：一旦考虑公开分发，首个公开构建前必须改名换图标。** |
| D-02 | 分发范围 | **仅自用，暂不公开** | M3 的自动更新可退化为"本地版本检查"，无需 GitHub Releases；公开化后再补 R4/R8 的声明强度 |
| D-03 | 合规约束 | 接受 R1–R8 为不可协商约束 | 已落实为 DD-15/16/17 与 V11/V12，并有 `docs/compliance.md` 台账 |
| D-04 | M1 范围 | §6.3 七项为 M1 终版 | "提示词库""多账号"等留到 M2+ |
| D-05 | 人工配合 | 同意本人完成登录与外观验收 | M0 的 V2/V3/V7 由用户操作；所有自动化测试仍只用本地 mock 站点 |

**仍需你后续确认**：发布通道（影响 M3）、是否预留 macOS（影响窗口与打包抽象层）。

### 10.5 合规来源（截至本文核实）

- 《DeepSeek 用户协议》（更新/生效 2025-09-05）：<https://cdn.deepseek.com/policies/zh-CN/deepseek-terms-of-use.html>
  - 3.4(3)、5.3（生成内容标识不得删除/篡改/规避）
  - 3.5(3)（禁止反向工程与自动化抓取/镜像）
  - 4.2（输入与输出权利归用户，可用于个人使用等）
  - 2.3(3)(4)（禁止恶意/批量注册；账号不可转让出借）
  - 6.2（品牌标识使用限制）
  - 8.1（违规处置：限制功能、暂停、关号、禁止重注册）
  - 10.1（协议会更新，须自行查阅最新版）
- 官方下载页（用于确认桌面端形态）：<https://www.deepseek.com/download/>
- 开放平台协议与定价（M4 官方 API 路线时需要复核）：<https://api-docs.deepseek.com/>

> 上述条款为方案约束来源，不构成法律意见；公开分发前建议做一次正式合规复核。

---

### 附：方案一句话总结

**用 DSH 当工厂，把 `chat.deepseek.com` 包进一个只管"加载、观测、增强、归档"的 Electron 壳**——页面是别人的，能力和数据资产是自己的；先证明壳能用（M0），再谈体验；生成标识与品牌红线一律不碰。
