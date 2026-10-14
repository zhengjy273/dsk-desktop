/**
 * M2：SSE 解析 —— **纯函数**，便于单测（不接触网络、不接触 Electron）。
 *
 * 分两层：
 *  1. **通用层**（`parseSseFrames` / `parseSseDeltas` / `assembleTurn`）：按 SSE 规范切帧 + 宽容候选路径；
 *  2. **站点校准层**（`parseDeepSeekSse`）：依据 **2026-10-10 抓到的真实样本**（结构已分析、内容未落报告）
 *     精确映射 DeepSeek 的帧语义 —— 见 `docs/M2-REPORT.md`。
 *
 * 真实样本观察到的结构（只记结构，不记内容）：
 *  - 事件：`ready` / `update_session` / `title` / `close`，以及大量**无 event 字段**的数据帧；
 *  - 增量正文：`{"v": "<1~8 字符>"}`（逐字/逐词）；
 *  - 快照：`{"v":{"response":{ role:"ASSISTANT", status:"WIP", fragments:[{type,content,…}], …}}}`；
 *  - 操作类型 `o`：`APPEND` / `SET` / `BATCH`；
 *  - 消息类型 `v[].type`：`RESPONSE` / `TIP`；
 *  - 片段类型 `v.response.fragments[].type`：已观测到 `THINK`；
 *  - 联网搜索引用：`…result:{ url, title, snippet, site_name, site_icon }`；
 *  - **流结束靠 `event: close`，没有 `[DONE]`**。
 *
 * 设计取舍：解析过程**逐帧容错**（坏帧不影响其余帧）；不猜内容，无法识别就计入 `skipped`。
 * 边界：只消费调用方给的文本；不发起请求、不改写请求、不读取凭据。
 *
 * 写作用域：`src/session/**`（T2）。
 */

export interface SseFrame {
  /** `event:` 字段（没有则为 null） */
  event: string | null;
  /** 同一事件的多行 `data:` 以 \n 连接后的原始文本 */
  data: string;
}

export interface SseDelta {
  /** 正文增量 */
  text: string;
  /** 深度思考增量 */
  reasoning: string;
  /** 是否收到结束标记（`[DONE]` 或 `event: close`） */
  done: boolean;
  /** 原始 data（便于诊断与后续收窄映射） */
  raw: string;
}

/** 候选路径：正文增量（通用层） */
const TEXT_PATHS: readonly (readonly (string | number)[])[] = [
  ['choices', 0, 'delta', 'content'],
  ['choices', 0, 'message', 'content'],
  ['choices', 0, 'text'],
  ['delta', 'content'],
  ['delta', 'text'],
  ['content'],
  ['text'],
  ['v'],
  ['response'],
  ['message', 'content'],
  ['data', 'content'],
];

/** 候选路径：思考增量（通用层） */
const REASONING_PATHS: readonly (readonly (string | number)[])[] = [
  ['choices', 0, 'delta', 'reasoning_content'],
  ['choices', 0, 'delta', 'reasoning'],
  ['delta', 'reasoning_content'],
  ['reasoning_content'],
  ['reasoning'],
  ['thinking'],
  ['think'],
];

/** 结束标记候选（数据形态） */
const DONE_MARKERS = ['[DONE]', 'DONE', '[done]'];
/** 结束标记候选（事件形态）—— DeepSeek 用 `close` */
const DONE_EVENTS = ['close', 'done', 'end', 'finish', 'message_end'];

/**
 * 按 SSE 规范切分帧：
 *  - 空行分隔事件；以 `:` 开头的是注释（心跳）；
 *  - 同一事件的多个 `data:` 行以 `\n` 连接；
 *  - 字段名后紧跟一个可选空格。
 */
export function parseSseFrames(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  const lines = String(raw ?? '').split(/\r?\n/);
  let event: string | null = null;
  let dataLines: string[] = [];

  const flush = (): void => {
    if (dataLines.length > 0 || event !== null) frames.push({ event, data: dataLines.join('\n') });
    event = null;
    dataLines = [];
  };

  for (const line of lines) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue; // 注释 / 心跳
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
    // 其余字段（id / retry）当前用不到，忽略
  }
  flush();
  return frames;
}

/** 按路径取值；任一层不是对象/数组就返回 null（不抛错）。 */
export function pickStringAt(obj: unknown, path: readonly (string | number)[]): string | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string | number, unknown>)[key as string];
  }
  return typeof cur === 'string' ? cur : null;
}

/** 依次尝试候选路径，返回第一个命中的字符串。 */
export function pickFirstString(obj: unknown, paths: readonly (readonly (string | number)[])[]): string | null {
  for (const p of paths) {
    const v = pickStringAt(obj, p);
    if (v !== null) return v;
  }
  return null;
}

function isDoneMarker(data: string): boolean {
  return DONE_MARKERS.includes(data.trim());
}

function isDoneEvent(event: string | null): boolean {
  return event !== null && DONE_EVENTS.includes(event.toLowerCase());
}

/**
 * 把原始 SSE 文本转成增量片段序列（通用层）。
 * 单帧解析失败会被跳过（记在 skipped 里），不影响其余帧。
 */
export function parseSseDeltas(raw: string): { deltas: SseDelta[]; skipped: number } {
  const frames = parseSseFrames(raw);
  const deltas: SseDelta[] = [];
  let skipped = 0;

  for (const frame of frames) {
    // 结束标记优先判定：`event: close` 的 data 可能为空（通用层原先只看 data，会漏掉）
    if (isDoneEvent(frame.event) || isDoneMarker(frame.data)) {
      deltas.push({ text: '', reasoning: '', done: true, raw: frame.data });
      continue;
    }

    const data = frame.data.trim();
    if (data === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      skipped += 1;
      continue; // 非 JSON 不猜
    }

    const text = pickFirstString(parsed, TEXT_PATHS) ?? '';
    const reasoning = pickFirstString(parsed, REASONING_PATHS) ?? '';
    if (text === '' && reasoning === '') {
      skipped += 1;
      continue;
    }
    deltas.push({ text, reasoning, done: false, raw: data });
  }

  return { deltas, skipped };
}

/** 把增量序列拼成"本轮回答"（通用层）。 */
export function assembleTurn(raw: string): {
  text: string;
  reasoning: string;
  done: boolean;
  frames: number;
  skipped: number;
} {
  const { deltas, skipped } = parseSseDeltas(raw);
  let text = '';
  let reasoning = '';
  let done = false;
  for (const d of deltas) {
    text += d.text;
    reasoning += d.reasoning;
    if (d.done) done = true;
  }
  return { text, reasoning, done, frames: deltas.length, skipped };
}

/* ==================================================================== 站点校准层 */

export interface Citation {
  url: string;
  title: string;
  siteName: string;
  snippet: string;
}

export type DeepSeekFrameKind =
  | 'ready'
  | 'session'
  | 'title'
  | 'text-delta'
  | 'status'
  | 'snapshot'
  | 'op'
  | 'close'
  | 'unknown';

export interface DeepSeekFrame {
  kind: DeepSeekFrameKind;
  /** 本帧贡献的正文增量（已按阶段归属） */
  text: string;
  /** 本帧贡献的思考增量（已按阶段归属） */
  thinking: string;
  /** `o` 字段（APPEND / SET / BATCH） */
  op: string | null;
  /** 快照帧里携带的片段（type + content） */
  fragments: { type: string; content: string }[];
  raw: string;
}

export interface DeepSeekTurn {
  text: string;
  thinking: string;
  citations: Citation[];
  done: boolean;
  /** 统计：各类帧的数量，便于诊断与回归 */
  counts: Record<DeepSeekFrameKind, number>;
  /** JSON 解析失败的帧数（真正的异常帧；解析成功但无内容的空帧不计入） */
  skipped: number;
}

/** `fragments[].type` 中被视为"思考"的取值（样本观测到 THINK） */
const THINK_TYPES = new Set(['THINK', 'REASONING', 'REASON']);

/**
 * **流状态标记**：站点用独立帧 `{"v":"FINISHED"}` 表达状态（样本里每轮出现 2~11 个），它不是正文内容。
 *
 * 踩坑记录：未过滤时正文末尾会粘上状态词 —— 真实归档里出现过
 * `…改进人类对宇宙基本结构的认知。FINISHED`（详见 docs/M2-REPORT.md）。
 */
const STATUS_MARKERS = new Set(['FINISHED', 'WIP', 'DONE', 'STOP', 'CANCELED', 'CANCELLED', 'ERROR']);

/**
 * 递归收集搜索引用（按 url 去重）。
 *
 * 支持两种形态 —— 这是**按真实样本修正过的**：
 *  - 形态 A（实测）：对象自身就是一条引用 `{ url, title, snippet, site_name, site_icon, … }`，
 *    出现在 `{"o":"SET"|"BATCH","p":"<parent>","v":[<引用对象>…]}` 里（样本中一帧最多 42 条）；
 *  - 形态 B（其它实现）：包一层 `{ result: { url, … } }`。
 */
export function collectCitations(value: unknown, out: Citation[] = [], depth = 0): Citation[] {
  if (depth > 10 || value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectCitations(item, out, depth + 1);
    return out;
  }
  const obj = value as Record<string, unknown>;

  const nested = obj.result !== null && typeof obj.result === 'object' ? (obj.result as Record<string, unknown>) : null;
  const candidate = typeof obj.url === 'string' ? obj : nested;

  if (candidate !== null && typeof candidate.url === 'string' && /^https?:\/\//.test(candidate.url)) {
    const url = candidate.url;
    if (!out.some((c) => c.url === url)) {
      out.push({
        url,
        title: typeof candidate.title === 'string' ? candidate.title : '',
        siteName: typeof candidate.site_name === 'string' ? candidate.site_name : '',
        snippet: typeof candidate.snippet === 'string' ? candidate.snippet : '',
      });
    }
  }

  for (const v of Object.values(obj)) collectCitations(v, out, depth + 1);
  return out;
}

/**
 * 递归收集"内容片段" `{ type, content, stage_id? }`。
 *
 * 为什么递归：实测片段不只在 `v.response.fragments`，也会出现在
 * `{"o":"BATCH"|"SET","v":[ … ]}` 这类嵌套数组里（见 docs/M2-REPORT.md）。
 */
export function readFragments(
  parsed: unknown,
  out: { type: string; content: string }[] = [],
  depth = 0,
): { type: string; content: string }[] {
  if (depth > 6 || parsed === null || typeof parsed !== 'object') return out;
  if (Array.isArray(parsed)) {
    for (const item of parsed) readFragments(item, out, depth + 1);
    return out;
  }
  const rec = parsed as Record<string, unknown>;
  if (typeof rec.type === 'string' && typeof rec.content === 'string') {
    out.push({ type: rec.type, content: rec.content });
    return out; // 片段对象内部不再深入
  }
  for (const v of Object.values(rec)) readFragments(v, out, depth + 1);
  return out;
}

/**
 * 站点校准解析：把一段 DeepSeek SSE 文本解成一轮回答。
 *
 * **阶段归属**：先用快照帧里的 `fragments[].type` 判断当前处于"思考"还是"正文"阶段，
 * 后续 `{"v":"字"}` 增量按该阶段归属。这是基于样本的**推断**（样本里 THINK 阶段在前），
 * 待拿到"带深度思考"的样本再复核 —— 报告里已标注未验证。
 */
export function parseDeepSeekSse(raw: string): DeepSeekTurn {
  const frames = parseSseFrames(raw);
  const counts: Record<DeepSeekFrameKind, number> = {
    ready: 0,
    session: 0,
    title: 0,
    'text-delta': 0,
    status: 0,
    snapshot: 0,
    op: 0,
    close: 0,
    unknown: 0,
  };
  const citations: Citation[] = [];
  let text = '';
  let thinking = '';
  let done = false;
  let skipped = 0;
  let stage: 'think' | 'text' = 'text';
  // 快照里给出的**累积完整内容**（实测 resume_stream 会在快照里直接给出完整正文与思考）
  let snapshotText = '';
  let snapshotThinking = '';

  for (const frame of frames) {
    const event = (frame.event ?? '').toLowerCase();
    const data = frame.data.trim();

    if (event === 'ready') {
      counts.ready += 1;
      continue;
    }
    if (event === 'close') {
      counts.close += 1;
      done = true;
      continue;
    }
    if (event === 'title') {
      counts.title += 1;
      continue;
    }
    if (event === 'update_session' || event === 'session') {
      counts.session += 1;
      continue;
    }
    if (event !== '' && isDoneEvent(frame.event)) {
      counts.close += 1;
      done = true;
      continue;
    }

    if (data === '' || isDoneMarker(data)) {
      if (isDoneMarker(data)) {
        counts.close += 1;
        done = true;
      }
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      counts.unknown += 1;
      skipped += 1;
      continue;
    }

    collectCitations(parsed, citations);

    const v = (parsed as { v?: unknown }).v;
    const op = typeof (parsed as { o?: unknown }).o === 'string' ? String((parsed as { o?: unknown }).o) : null;

    // 1) 增量：{"v":"字"}
    if (typeof v === 'string') {
      if (v === '') continue;
      // 状态标记（{"v":"FINISHED"} 等）不是正文：单独计数，绝不并入文本
      if (STATUS_MARKERS.has(v)) {
        counts.status += 1;
        continue;
      }
      if (stage === 'think') thinking += v;
      else text += v;
      counts['text-delta'] += 1;
      continue;
    }

    // 2) 快照 / 片段帧（{"v":{"response":{fragments:[…]}}} 或 {"o":"BATCH","v":[…]})
    const fragments = readFragments(parsed);
    if (fragments.length > 0 || (v !== null && typeof v === 'object')) {
      if (fragments.length > 0) {
        // 快照里的片段是**累积的完整内容**：按 type 分别保留最完整的一份
        for (const f of fragments) {
          const t = f.type.toUpperCase();
          if (THINK_TYPES.has(t)) {
            if (f.content.length > snapshotThinking.length) snapshotThinking = f.content;
          } else if (f.content.length > snapshotText.length) {
            snapshotText = f.content;
          }
        }
        // 阶段取**最后一个片段**的类型。
        // 踩坑记录：原实现用 `some(THINK)` 优先判定 → 同一快照里同时含 THINK 与 RESPONSE 时
        // 永远停在思考阶段，真实归档出现"正文=0字 / 思考=359字"（resume_stream 样本）。
        const last = fragments[fragments.length - 1];
        if (last) stage = THINK_TYPES.has(last.type.toUpperCase()) ? 'think' : 'text';
      }
      counts.snapshot += 1;
      continue;
    }

    if (op !== null) {
      counts.op += 1;
      continue;
    }

    // 合法 JSON 但取不到任何可用字段（例如 close 事件紧随其后的 `{}`）只计 unknown。
    // `skipped` 的语义**收窄为"JSON 解析失败"** —— 真正的异常帧，避免把正常空帧算成坏帧。
    counts.unknown += 1;
  }

  return {
    // 实测：快照里的 fragment content 就是**完整内容**（resume_stream 一次给出 1326 字正文），
    // 因此"增量拼接"与"快照"取**更完整的那个**，而不是盲目信任其中一方。
    text: text.length >= snapshotText.length ? text : snapshotText,
    thinking: thinking.length >= snapshotThinking.length ? thinking : snapshotThinking,
    citations,
    done,
    counts,
    skipped,
  };
}

/**
 * 诊断用：从一段 SSE 文本里抽取"结构指纹"——只用键名与类型，**不含任何内容**。
 * 用于样本到手时判断该往候选路径里加什么，同时避免把对话内容写进报告。
 */
export function structureFingerprint(raw: string, maxDepth = 4): {
  dataFrames: number;
  keys: string[];
  sampleTypes: Record<string, string>;
} {
  const frames = parseSseFrames(raw);
  const keys = new Set<string>();
  const sampleTypes: Record<string, string> = {};

  const walk = (value: unknown, prefix: string, depth: number): void => {
    if (depth > maxDepth || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      if (value.length > 0) walk(value[0], `${prefix}[]`, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const path = prefix ? `${prefix}.${k}` : k;
      keys.add(path);
      sampleTypes[path] = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
      if (v !== null && typeof v === 'object') walk(v, path, depth + 1);
    }
  };

  let dataFrames = 0;
  for (const frame of frames) {
    const data = frame.data.trim();
    if (data === '' || isDoneMarker(data)) continue;
    try {
      const parsed = JSON.parse(data);
      // 只有**成功解析成 JSON** 的帧才算结构帧（非 JSON 帧不计入，避免计数虚高）
      dataFrames += 1;
      walk(parsed, '', 0);
    } catch {
      /* 非 JSON 帧不计入结构 */
    }
  }

  return { dataFrames, keys: [...keys].sort(), sampleTypes };
}
