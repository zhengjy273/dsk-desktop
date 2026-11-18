# M2 进展报告：网络通道镜像与结构化导出

> 目标：把导出从"页面快照"升级为**逐条消息的结构化归档**；数据来源改为**只读观测页面自身产生的 SSE**
>（DD-06：站点 DOM 用 CSS Modules 哈希类名，DOM 解析天然脆弱；流式 SSE 才是会话数据的权威来源）。
>
> 硬约束：不逆向站点接口、**不构造或重放任何请求**、不读取账号凭据、不破坏 AI 生成内容标识、
> 自动化测试只用本地 mock/合成数据（**不用脚本操作真实账号**）。
>
> **本报告只记录协议结构与统计，不含任何真实会话内容。**

## 一、已完成

### 1. 只读探针 `src/session/network-mirror.ts`

- 走 Chromium DevTools Protocol 的**只读通道**：`Network.enable` → 在 `responseReceived` 里筛出
  `text/event-stream`（或 URL 含 `/chat/completion`）的请求 → 在 `loadingFinished` 时用
  `Network.getResponseBody` 取完整响应体。
- **不使用** `Fetch.enable`（那会拦截并改变页面行为）；不构造请求、不改请求头、不重放。
- 样本落盘 `docs/m2-evidence/sse-samples/`；`DSK_CAPTURE_SSE=0` 关闭。（v1.1.5 起改为 `DSK_CAPTURE_SSE=1` 显式开启，默认不落盘 —— 见 KNOWN-LIMITS）
- 自检断言：`mirrorAttached=true`、`mirrorStats={captured,failures,lastError,attached}`。

**2026-10-10 实际抓到 2 份样本**（用户手动发起，非脚本自动化）：

```
[mirror] SSE 开始 → https://chat.deepseek.com/api/v0/chat/completion（text/event-stream; charset=utf-8）
[mirror] SSE 完成 → 6322 字符，用时 1414ms
[mirror] SSE 完成 → 18447 字符，用时 5237ms   ← 这份带联网搜索
```

### 2. 真实协议结构（由 `spike/analyze-sse.mjs` 脱敏分析得出）

| 观察项 | 实测值 | 解析含义 |
|---|---|---|
| 事件类型 | `ready` / `update_session` / `title` / `close`，以及**大量无 event 字段**的数据帧 | 帧类型分类 |
| **流结束** | **`event: close`**（**没有** `[DONE]`） | 结束标记必须认事件名，不能只看 data |
| 增量正文 | `{"v":"<1~8 字符>"}`（样本 1：286 帧；样本 2：967 帧） | 逐字/逐词增量 |
| 操作类型 | `o`: `APPEND` / `SET` / `BATCH` | 帧语义分类 |
| 消息角色/状态 | `v.response.role = ASSISTANT`、`v.response.status = WIP` | 消息归属 |
| **片段类型** | `v.response.fragments[].type = THINK`（含 `content`/`id`/`stage_id`/`references`） | **思考与正文的区分依据** |
| 消息类型 | `v[].type = RESPONSE / TIP` | 含提示类消息 |
| 联网引用 | `…result:{ url, title, snippet, site_name, site_icon }` | 提取为 citations |
| 其他 | `v.response.thinking_enabled` / `search_enabled` / `search_triggered` / `accumulated_token_usage` | 能力与用量元数据 |

### 3. 解析器 `src/session/sse-parser.ts`（两层，31 项单测）

**通用层**：`parseSseFrames`（规范切帧：空行分隔、多行 data 合并、`:` 注释心跳、CRLF）、
`parseSseDeltas`/`assembleTurn`（宽容候选路径）、`structureFingerprint`（**脱敏**结构指纹：只有键路径与类型）。

**站点校准层**：`parseDeepSeekSse`（按上表精确映射）+ `collectCitations`（递归取 `result`，按 url 去重）。
阶段归属：用快照帧的 `fragments[].type` 判断"思考/正文"阶段，后续 `{"v":"字"}` 增量按该阶段归属。

**容错语义**：逐帧 try/catch；`skipped` **严格表示"JSON 解析失败的异常帧"**
（解析成功但无内容的空帧只计 `unknown`，不算坏帧）。

> 本轮的 2 个实现缺陷都是**测试先发现的**：
> ① `dataFrames` 在 `JSON.parse` 之前计数 → 非 JSON 帧被算成结构帧；
> ② `event: close` 紧随其后的正常 `{}` 空帧被算成坏帧（`skipped` 语义过宽）。

### 4. 归档链路 `src/session/deepseek-mirror.ts`（已接通主进程）

```
SSE 字节 → parseDeepSseSse() → turnToMirrorMessage() → MirrorStore.appendTurn() → 结构化导出（待做）
```

- `extractConversationId(url)`：从页面 URL（`/a/chat/s/<id>` 或 `?conversation=`）提取会话 id，
  并**按路径片段规则校验**（防路径穿越；MirrorStore 侧还会再校验一次）。
- `turnToMirrorMessage(turn, {conversationId, createdAt})`：一轮 SSE = 一条 assistant 消息；
  空轮返回 `null`（不往归档塞空消息）；`aiGenerated` **恒为 true**（R3）。
- `turnFidelity(turn)`：正常结束（`event: close`）且无坏帧 → `full`，否则 `partial`。
- 主进程：baseDir = `userData/mirror/`；`onSse` 回调里直接归档；初始化失败只降级告警（DD-05）；
  会话 id 取**当前页面 URL**（流结束时新会话 URL 已带 id）。

**端到端断言**（`tests/unit/archive-pipeline.test.ts`，5 项）：
写入→读回（含思考与引用）、同实例幂等、**重启后仍幂等**（幂等状态从磁盘重建）、
索引不含正文（元数据最小化）、中断流仍归档且 `fidelity=partial`。

#### 引用提取的形态修正（重要）

第三份样本里那个 **18872 字符的大帧**不是消息快照，而是 **42 条搜索结果**：

```
{ p: "<parent>", o: "SET"|"BATCH", v: [ { url, title, snippet, cite_index, published_at, site_icon, site_name, … } × 42 ] }
```

即引用对象**自身**就带 `url/title/snippet/site_name`，而我先前假设的 `{result:{url}}` 包裹形态**在真实数据里不存在** ——
`collectCitations` 在真实数据上会提取到 0 条。已改为**两种形态都支持**（自身形态优先）。

#### 阶段归属的修正（真实归档当场暴露的 bug）

链路接通后**第一次真实归档**就暴露了问题：

```
[archive] bb4882f8-… appended=1 正文=0字 思考=359字     ← 正文全被归进了思考
```

诊断（`spike/diagnose-turn.mjs`，只输出结构）看到：

```
resume_stream  #3 status=WIP thinking_enabled=true frags=[THINK(stage=1,len=566) RESPONSE(stage=1,len=1326)]
```

根因有两个，都在解析器：

1. **阶段判定逻辑写错**：原实现用 `fragments.some(type===THINK)` **优先**判定 →
   当同一快照里**同时**含 `THINK` 与 `RESPONSE`（实测正是如此）时，永远停在"思考"阶段。
   → 改为**取最后一个片段的类型**（fragments 是累积列表，末项代表最新阶段）。
2. **过度依赖增量拼接**：实测快照里的 `fragment.content` **本身就是完整内容**（resume_stream 一次给出 1326 字正文）。
   → 改为"快照内容与增量拼接**取更完整的那个**"。

修复效果（**直接用真实样本复核**）：

| 样本 | 修复前 | 修复后 |
|---|---|---|
| `resume_stream` | 正文 0 字 / 思考 359 字 | 正文 **1326** 字 / 思考 **566** 字 |
| `completion`（带联网搜索） | 正文 0 字 / 思考 2370 字 | 正文 **2058** 字 / 思考 **312** 字 / 引用 **42** 条 |
| `completion`（中） | 正文 0 字 / 思考 1250 字 | 正文 **457** 字 / 思考 **1250** 字 |

回归测试：`tests/unit/sse-parser.test.ts` 新增 4 项，其中"同一快照同时含 THINK 与 RESPONSE"那条**就是 bug 本身**。

> 这条也印证了上一轮的自我标注是有价值的：我当时把"阶段归属"标为**未验证的推断**，
> 而没有把它当成既成事实写进结论 —— 结果它确实是错的，且第一次真实归档就撞上了。

#### 状态标记污染正文的修正（真实归档第二次暴露）

修好阶段归属后，从**真实归档记录**（`.spike-userdata-main/mirror/personal/f672a920-….jsonl`）里
看到正文末尾粘着状态词：

```
…改进人类对宇宙基本结构的认知。FINISHED
```

核查 SSE 样本：每轮流里都有 **2~11 个** `{"v":"FINISHED"|"WIP"}` 形态的**状态帧**，
而解析器把"整帧恰好等于状态词"的增量当成了正文内容。

修法：维护状态词白名单（`FINISHED`/`WIP`/`DONE`/`STOP`/`CANCELED`/`CANCELLED`/`ERROR`），
整帧命中时**单独计数**（`counts.status`）、绝不并入文本；并加保护测试确保
`"FINISHED 是我的口头禅"` 这类"状态词只是正文一部分"的情况**不被误过滤**。

修复效果（**8 份真实样本全部复核**，修复前它们的正文全为 0）：

| 样本 | 正文 | 思考 | 引用 |
|---|---|---|---|
| 04-25-12 | 21 | 421 | 0 |
| 04-25-29 | 449 | 1250 | 0 |
| 04-26-28 | **2050** | 248 | **42** |
| 04-29-07 | 48 | 0 | 0 |
| 04-29-17 | 32 | 99 | 0 |
| 04-29-34 | 778 | 0 | 0 |
| 04-29-48 | 1326 | 566 | 0 |
| 04-33-31 | 1082 | 2323 | 0 |

#### 双向归档验证（真实使用中确认）

你在真实使用里发了一条消息，归档记录（`.spike-userdata-main/mirror/personal/bb4882f8-….jsonl`）为：

```
记录数=3
  role=assistant 正文=0字    思考=359字    ← 修复前的旧记录（对照组）
  role=user      正文=5字    "双生子佯谬"   ← 用户消息（来自请求体）✅
  role=assistant 正文=2067字 思考=3787字    ← 修复后；末尾是句号，无状态词污染 ✅
```

**导出产物**（用户实测，存于 `E:\`）：`…-f672a920-…-1239.md`，含标识块 / 元信息 / `## 1. AI 助手` /
`### 深度思考`，**无 UI 噪音**（对比 M1 页面快照把侧边栏、按钮、乱码文字全抓了进来）。

#### 请求体结构（实测，样本已落盘 `docs/m2-evidence/request-samples/`）

```
$.chat_session_id : string(36, uuid)
$.parent_message_id : number
$.prompt : string(len=5)        ← 用户消息（**唯一**文本字段，候选路径已可收窄到它）
$.ref_file_ids : array[0]
$.thinking_enabled / $.search_enabled / $.model_type / $.action / $.preempt
```

据此改进：**会话 id 优先取请求体里的 `chat_session_id`** —— 它比页面 URL 更早可用
（新会话在请求发出时 URL 还没带 id），URL 只作兜底。

#### 结构发现能力（补齐"无候选选择器"的目标）

注册表里 5 个目标（`messageList` / `messageAssistant` / `reasoningBlock` / `generatingIndicator` /
`sendButton`）**没有登记候选选择器**，探测脚本无从下手。新增 `buildStructureDiscoveryScript()`：
只读统计元素计数、候选选择器命中数、类名分布 —— **不读元素文本、不读输入值**
（单测有机器断言），手动诊断时一并写入日志，据此写精确锚点。

#### 锚点补齐结果（实测）

结构发现实测（有历史消息的会话页）：

```
div=260  原生button=0  role=button=26  textarea=1  svg=43
[class*=message]=6  [class*=markdown]=132  [class*=think]=2
[class*=loading]=0  [class*=typing]=0      [class*=stream]=0
```

→ 站点**没有原生 `<button>`**（与 M0 结论一致），采用 `ds-*` 设计系统类名 + 哈希类名混合。

| 目标 | 状态 | 锚点 | 依据 |
|---|---|---|---|
| `composer` | verified | `textarea` | 命中 1 |
| `modeDeepThink` | text-match | 深度思考 | 命中 1 |
| `modeSmartSearch` | text-match | 智能搜索 | 命中 1 |
| `aiGeneratedNotice` | text-match | 内容由 AI 生成 | 会话页命中 1（首页不存在） |
| `messageList` | verified | `[class*="message"]` | 命中 6 |
| `reasoningBlock` | verified | `[class*="think"]` | 命中 2~4 |
| `messageAssistant` | verified | `[class*="assistant"]` | **生成中**命中 1（精确对应 1 条助手消息） |
| `sendButton` | verified | `div[role="button"][class*="primary"]` | **生成中**命中 1（+`filled` 亦 1，同一按钮）；**语义待确认** |
| `generatingIndicator` | unverified | — | **生成中 8 个候选全 0**，未找到稳定锚点（详见下） |

**最终：8/9 有可用锚点**（`verified 5 + text-match 3`），仅 `generatingIndicator` 保留 `unverified`。

补最后 3 个锚点时，把探测升级成了**命中矩阵**（每个候选各自统计命中数，不再只报第一个命中者），因此
**一次"生成中"探测**就拿到了全部候选数据。命中矩阵实测：

```
messageAssistant    → [class*=assistant]=1   [class*=markdown]=11   [class*=message][class*=ai]=1
sendButton          → div[role=button][class*=primary]=1   [class*=filled]=1
generatingIndicator → 8 个候选全 0
生成中结构发现      → div=211  role=button=13  button=0  svg=29  [class*=markdown]=11  [class*=think]=4
```

**`generatingIndicator` 为什么补不了（诚实记录）**：在**流式输出进行时**实测，`stop` / `loading` / `typing` /
`generating` / `stream` / `cursor` / `pending` / `blink` 这 8 个类名**全部为 0** —— 站点根本不用这些词；
生成中 `ds-icon` 有 24 个、`svg` 29 个，指示器很可能由 `ds-icon` + SVG 动画或哈希类名表达。
**没有用一个猜测的类名去"假装补齐"**；该项当前也**没有任何消费方**（「回答完成」通知已取消），不影响功能。

**`sendButton` 的语义边界**：同一 `ds-button--primary` 样式在生成中可能对应**"停止"**而非"发送"，
注册表里已写明"任何 UI 使用前必须再核对"，本应用当前不点击该按钮 —— 这是"锚点有效但语义未确认"的诚实表达。

**诚实说明**：这里的 `verified` 表示"**选择器有效、能选中节点**"，不完全等于"语义已人工确认" ——
这一点已写进各自的 `observed` 字段，避免后人误以为语义也验证过了。

#### 条件性目标（conditional）：消除告警噪音

把 `messageList` / `reasoningBlock` / `aiGeneratedNotice` 登记为锚点后，它们在**首页/空会话**必然探测不到
→ 每次启动都报"真失配"。新增 `conditional: true` 语义：这类"只在特定页面状态存在"的目标
未命中时**仍然降级，但不计为失配**。重启后探测结果：
`可用 3 / 失配 0 / 未验证降级 6（共 9）` —— 噪音归零，且真实失配仍会告警。

## 二、待办（按依赖顺序）

1. **补上"用户消息"的来源**：SSE 只含 assistant 侧。用户自己发出的内容可从
   `Network.requestWillBeSent` 的 `postData` 只读取得（同样是"观察页面已产生的数据"，不构造请求）。
2. **接入结构化归档**：`parseDeepSeekSse` 的结果包装成 `MirrorMessage`（`aiGenerated: true` 恒定，R3），
   写入 T3 已就绪的 `MirrorStore`（幂等、原子索引、损坏行安全跳过均已具备）。
3. **结构化导出路径**：`src/main/exporter.ts` 增加"从镜像导出"，改用 T3 的
   `renderConversationMarkdown/Json`（AI 标识恒为产物第一块）；**与现有"页面快照导出"并存**，快照作兜底。
4. **注入健壮性**（本阶段后半）：`src/shared/selectors.json` 的 `unverified` 项在真实页面补齐实测值；
   选择器失配时降级并上报诊断（DD-05 设计与 `SelectorWarning` 契约已就绪）。

### 尚未验证的推断（诚实标注）

- **阶段归属**：样本里 THINK 片段出现在前，且未拿到"开启深度思考且带完整思考过程"的样本，
  因此"用 `fragments[].type` 切换阶段"是**基于样本的推断**，待新样本复核。
- `o` 的 `SET` / `BATCH` 两种操作在样本中各只出现少量，其增量语义未逐一验证。
- 未观测到 `v[].type = TIP` 的实际载荷（只观测到取值本身）。

## 三、验证状态

```
pnpm check        → exit 0（strip-only + tsc 0 error + 10 个测试文件 / 161 项全绿）
pnpm app:selftest → exit 0（含 mirrorAttached、mirrorStats、迷你窗与托盘联动断言）
spike/analyze-sse.mjs → 脱敏结构分析（不含内容）
```
