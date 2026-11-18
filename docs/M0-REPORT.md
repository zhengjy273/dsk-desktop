# M0 可行性验证报告（冻结版）

- 生成时间：2026-10-10T02:24:45.581Z
- 证据来源：docs/m0-evidence/events.ndjson（246 条事件，跨度 2026-10-10T02:00:42.760Z → 2026-10-10T02:14:40.892Z）
- 运行时：Electron 44.7.0 / Chromium 152.0.7977.130 / Node 24.21.0（Windows 11 25H2 26200.9445）
- 沙箱状态：**启用**（经 `ELECTRON_OVERRIDE_DIST_PATH` 指向干净 ACL 目录，**未使用 `--no-sandbox`**）
- 自动化测试策略：只打本地 mock 站点；本报告的自动判定来源于真实站点的只读观测

## 一、逐项判定

| 项 | 含义 | 结果 | 依据 |
|---|---|---|---|
| V1 | 页面加载（自动） | **PASS** |  |
| V2 | 登录（人工） | **PASS** | 微信扫码成功（authorized 跳转 + token change 事件），随后分区保持登录态 |
| V3 | 流式对话（人工） | **PASS** | 已产生真实会话 URL 与会话标题；关窗快照显示结构化 Markdown 回答（4 个标题：一、C++ 的优势 / 二、Python 的优势 / 三、简单对比 / 四、怎么选？），正文长度 3170 字符 |
| V4 | 登录态持久化（自动，--session=main） | **PASS** | 重启后最终 URL=https://chat.deepseek.com/；userToken key 存在=true（仅读 key 名）；cookies=5 |
| V5a | navigator.userAgent 无 Electron（自动） | **PASS** |  |
| V5b | navigator.userAgentData 无 Electron（自动） | **PASS** |  |
| V5c | 请求头无 Electron 且 Sec-CH-UA 自洽（自动） | **PASS** |  |
| V6 | 风控表现：无验证码 / 限流（人工） | **PASS** | 5 次快照 + 关窗快照**均无风控提示**（无验证码 / 限流 / 账号异常）；观察到约 2 条 AI 回答，最长单次正文 3170 字符 |
| V7 | 文件上传：拖拽 + 选择器（人工） | **PASS** | 【用户确认】文件上传测试通过（拖拽 + 选择器两条路径）（2026-10-10；无自动化证据留存） 备注：无自动化证据留存；M1/M2 回归时应改用 fixtures/mock-chat 补自动化覆盖，避免依赖人工复述 |
| V8 | 注入不破坏页面（需 M1 注入层） | **待 M1** | 需注入层就绪后用 mock 站点做开/关对比 |
| V9 | 流式结束可判定（人工 / 需 M1） | **PASS** | 【用户确认】流式结束判定测试通过（2026-10-10；无自动化证据留存） 备注：M1 已用「DOM 静默启发式」实现完成通知（src/main/turn-watcher.ts，idle 2.5s）；M2 将换成网络通道(SSE)的精确信号 |
| V10 | iframe 可嵌入性（自动，结论性） | **BLOCKED** |  |
| V11 | 站点 AI 生成标识存在且可检出（人工基线） | **PASS（基线）** | 站点标识确实存在：["AI 生成","内容由 AI 生成"]；注意 aiNoticeGuess=0 → **无法用类名定位标识元素**，M1 断言需改用文本匹配（"内容由 AI 生成"），且注入层不得隐藏它 |
| V12 | 品牌合规：零 DeepSeek 品牌特征 | **明示例外** | R4 已登记：应用名仅本机自用；公开分发前必须改名换图标（DISPLAY_NAME 单点可改） |
| V13 | 页面可见模式自查（自动探针） | **PASS** | 可见模式：深度思考 + 智能搜索（社区"仅剩快速模式"的说法不成立） |
| V14 | 跨源外跳 / 应用内不开新窗口（自动） | **PASS** |  |

补充自动证据：

> ⚠️ **2026-11-17 事后更正（重要）**：下面 V5a/V5b/V5c 三条 PASS 与"改写后 UA"证据，
> 是在**实验脚本** `spike/main.mjs:200` 的 `session.webRequest.onBeforeSendHeaders` 里取得的，
> 该脚本至今仍在且改写逻辑完整。但这段改写**没有搬进 M1 的主进程**：
> `src/main/main.ts` 的 `setupSession()` 里没有 `onBeforeSendHeaders`，全库也搜不到 `setUserAgent`，
> `src/session/fingerprint.ts` 只有纯函数与单测、无调用方。
> 因此**当前产品运行时 UA 仍是 Electron 默认值**（含 `Electron/44.x`），`Sec-CH-UA` 系列头照旧不发。
> 本报告保留原始记录以留痕，但 V5a/V5b/V5c 描述的是**实验期能力**，不是产品现状。
> 按用户决定（2026-11-17）：保持现状、只改文档，不在主进程接线。
> 详见 `README.md`「指纹改写的现状」与 `docs/KNOWN-LIMITS.md` 同名条目。

- 指纹改写后 UA：`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36`
- 客户端提示（**补发**，因 Electron 44 默认对主框架导航不发这组头）：`"Chromium";v="152", "Not?A_Brand";v="24"`
  - 改写前实测值：`null`；原始头名列表：`Upgrade-Insecure-Requests,User-Agent,Accept,Sec-Fetch-Site,Sec-Fetch-Mode,Sec-Fetch-User,Sec-Fetch-Dest,Accept-Encoding,Accept-Lan`
  - 意义：过去伪造 `"Google Chrome"` 品牌会与 `navigator.userAgentData.brands`（只报 Chromium）矛盾，反而更易被检测；现改为与 JS 可见值完全自洽。

## 二、人工验证证据（窗口内实际操作记录）

- `Ctrl+Shift+S` 快照：**5** 次；其中命中 AI 生成标识：**5** 次；落在会话页：**5** 次
- 最新快照：节点数=402、文本长度=414、可编辑元素=1、按钮=["朗读"]
  - AI 生成标识命中：["AI 生成","内容由 AI 生成"]
  - 风控提示：[]
  - 会话标题长度=16 字符（**刻意不写入标题原文**）

### 真实页面结构（发消息后 · M1 选择器素材）

```json
{
  "url": "https://chat.deepseek.com/a/chat/s/<uuid>",
  "counts": {
    "buttons": 22,
    "editable": 1,
    "messagesGuess": 8,
    "aiNoticeGuess": 0
  },
  "modeHints": [
    "深度思考",
    "智能搜索"
  ],
  "editable": [
    {
      "tag": "textarea",
      "testid": null,
      "aria": null,
      "role": null,
      "cls": "_27c9245 ds-scroll-area ds-scroll-area--show-on-focus-within ds-scroll",
      "text": ""
    }
  ],
  "buttonSample": [
    {
      "tag": "div",
      "role": "button",
      "text": "",
      "cls": "ds-button ds-button--iconLabelTertiary ds-button--icon ds-bu"
    },
    {
      "tag": "div",
      "role": "button",
      "text": "",
      "cls": "ds-button ds-button--iconLabelTertiary ds-button--icon ds-bu"
    },
    {
      "tag": "div",
      "role": "button",
      "text": "",
      "cls": "ds-button ds-button--iconLabelTertiary ds-button--icon ds-bu"
    }
  ]
}
```

**结构结论**

1. 输入框：单个 `textarea`，但 class 带构建哈希（`_27c9245`）→ **不可依赖 class**。
2. 按钮：全部是 `div[role="button"]`，**无 text / 无 aria-label / 无 data-testid** → 无法按文本定位，只能靠设计系统修饰类（`ds-button--iconLabelTertiary` / `--primary`）。
3. 消息节点：`[class*=message|chat-item|markdown]` 命中 **8** 个 → 兜底通道可用但脆弱。
4. AI 标识：`[class*=generated|disclaimer|notice]` 命中 **0** 个 → **类名定位失败**，必须改用文本匹配。
5. 结论：**DD-06 改为网络优先（SSE 为准）**，DOM 只承担少量交互，并保留特性开关 + 熔断。

## 三、风控与异常观察

- 出现风控提示的快照：**0** 条 —— 未观察到验证码 / 限流 / 账号异常
- 页面控制台错误/警告合计：**33** 条
  - Electron 安全警告（自检页为无 CSP 的 `data:` 页面）：**25** 条 —— 开发期正常，打包后消失。
  - 微信登录 SDK 端口探测噪音：**8** 条 —— 站点自身行为，无影响。
  - 无来源信息的裸 `Error`（来自站点 `fp.min.js`）：**0** 条 —— **每次运行都出现（含未登录基线）**，待 M1 观察是否演化为风控信号。

## 四、结论

- **环境侧两大地雷已排掉**：DSH 注入的 `ELECTRON_RUN_AS_NODE`（会让 Electron 退化成 Node 模式）；以及 **Chromium 沙箱在 DSH 工作区目录树中崩溃**（根因是 `<workspace>` 上的孤儿 SID + 低完整性标签 + 缺 AppContainer 包 ACE，对应 electron/electron#51761）—— 已用干净 ACL 目录 + `ELECTRON_OVERRIDE_DIST_PATH` 修复，**沙箱保持启用**。
- **V10 是选型层面的关键结论**：站点 `CSP: frame-ancestors 'none'` → 不能被 iframe 嵌入 → 独立 Electron 壳的路线成立。
- **登录态由 `persist:` 分区承载，应用层零接触凭据**（对比参考实现 `dsh-webchat` 必须把含 HttpOnly 的 cookie 明文落盘）→ 这是自研在 R1 上的硬优势。
- **M1 起必须守住**：站点的 AI 生成标识（`["AI 生成","内容由 AI 生成"]`）存在性与可见性不得改变；导出产物必须自带该标识。

## 五、下一步

1. 你补完 V6（连续多轮）/ V7（上传）/ V9（流式结束）后，M0 即全绿。
2. M1 开工：T0 契约**已完成**（`src/shared/**` + tsconfig + 14 项单元测试 + typecheck 通过），随后 T1/T2/T3/T5 并行（见 docs/M1-TASKS.md）。
3. 头号技术调整：**DD-06 网络优先**；AI 标识断言改用文本匹配。
