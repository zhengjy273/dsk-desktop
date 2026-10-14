/**
 * M2：把 DeepSeek 的**只读观测结果**转成契约里的会话镜像（`MirrorMessage`）。
 *
 * 数据流：
 *   SSE 字节 → `parseDeepSeekSse()`（src/session/sse-parser.ts）→ **本模块** → `MirrorMessage`
 *   → `MirrorStore.appendTurn()`（src/store/mirror-store.ts）→ 结构化导出。
 *
 * 边界（R2/R3）：
 *  - 只转换"页面自己已经产生的响应"的解析结果，不构造请求、不推断用户身份；
 *  - `aiGenerated` **恒为 true**，导出链路不得去除（R3 / DD-15）；
 *  - 不读取凭据、不访问网络。
 *
 * 写作用域：`src/session/**`（T2）。
 */
import type { MirrorMessage } from '../shared/ipc-contract.ts';
import { pickFirstString, type DeepSeekTurn } from './sse-parser.ts';

/** 会话 id 的合法形状（与 MirrorStore 的路径片段校验保持一致）。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** URL 里的会话 id 形态：`https://chat.deepseek.com/a/chat/s/<id>` */
const URL_PATTERNS = [/\/a\/chat\/s\/([A-Za-z0-9._-]{1,128})/i, /\/chat\/s\/([A-Za-z0-9._-]{1,128})/i];

/**
 * 从页面 URL 提取会话 id（拿不到返回 null）。
 *
 * 优先 query 参数（`?conversation=` 等），其次路径形态。返回前一律按路径片段规则校验，
 * 避免把任意字符串带进文件路径（MirrorStore 还会再校验一次，这里是第一道）。
 */
export function extractConversationId(url: string): string | null {
  if (typeof url !== 'string' || url === '') return null;

  try {
    const u = new URL(url);
    for (const key of ['conversation', 'conversation_id', 'conversationId', 'chat']) {
      const v = u.searchParams.get(key);
      if (v !== null && SAFE_ID.test(v)) return v;
    }
  } catch {
    /* 不是合法 URL：继续按字符串匹配 */
  }

  for (const re of URL_PATTERNS) {
    const m = re.exec(url);
    if (m?.[1] && SAFE_ID.test(m[1])) return m[1];
  }
  return null;
}

export interface TurnToMessageArgs {
  conversationId: string;
  /** 观测时间（毫秒） */
  createdAt: number;
}

/**
 * 把一轮 SSE 观测转成一条 assistant 消息；**这一轮没有任何内容时返回 null**
 *（例如流被中断且没收到任何文本，避免往归档里塞空消息）。
 *
 * 注意 `id` 只是占位：`MirrorStore` 会用**内容寻址**重算幂等键，因此重复观测同一轮不会重复落盘。
 */
export function turnToMirrorMessage(turn: DeepSeekTurn, args: TurnToMessageArgs): MirrorMessage | null {
  const text = turn.text ?? '';
  const reasoning = turn.thinking ?? '';
  if (text.trim() === '' && reasoning.trim() === '') return null;

  const citations = (turn.citations ?? [])
    .filter((c) => typeof c.url === 'string' && c.url !== '')
    .map((c) => ({ title: c.title !== '' ? c.title : c.url, url: c.url }));

  return {
    id: `${args.conversationId}:pending`,
    role: 'assistant',
    text,
    createdAt: args.createdAt,
    // exactOptionalPropertyTypes：可选字段用条件展开，不写 undefined
    ...(reasoning !== '' ? { reasoning } : {}),
    ...(citations.length > 0 ? { citations } : {}),
    aiGenerated: true,
  };
}

/**
 * 判定这一轮的**数据完整度**：
 *  - 正常结束（`event: close`）且没有解析失败的异常帧 → `full`；
 *  - 流被中断、或有坏帧 → `partial`（归档仍写入，但导出时会标注完整度）。
 */
export function turnFidelity(turn: DeepSeekTurn): 'partial' | 'full' {
  return turn.done && turn.skipped === 0 ? 'full' : 'partial';
}

/* ------------------------------------------------- 用户消息（来自请求体） */

/**
 * 候选路径：请求体里"用户这次说的话"。
 * 与 SSE 解析一样先**宽容匹配**，拿到真实请求体样本后再收窄（见 docs/M2-REPORT.md）。
 */
const REQUEST_TEXT_PATHS: readonly (readonly (string | number)[])[] = [
  ['prompt'],
  ['message'],
  ['query'],
  ['content'],
  ['text'],
  ['input'],
  ['request', 'prompt'],
  ['request', 'message'],
];

/**
 * 请求体里的会话 id 字段（**实测**：`chat_session_id`）。
 * 它比页面 URL 更早可用 —— 新会话在**请求发出时** URL 还没有 id，而请求体已经有了。
 */
const SESSION_ID_PATHS: readonly (readonly (string | number)[])[] = [
  ['chat_session_id'],
  ['session_id'],
  ['conversation_id'],
  ['conversationId'],
];

/** 从请求体提取会话 id（拿不到返回 null；返回前按路径片段规则校验）。 */
export function extractSessionIdFromRequest(postData: string): string | null {
  if (typeof postData !== 'string' || postData.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(postData);
  } catch {
    return null;
  }
  const id = pickFirstString(parsed, SESSION_ID_PATHS);
  return id !== null && SAFE_ID.test(id) ? id : null;
}

/** 取 `messages` 数组里**最后一条**的 content（OpenAI 风格请求体）。 */
export function pickLastMessageText(parsed: unknown): string | null {
  const msgs = (parsed as { messages?: unknown })?.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return null;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (m === null || typeof m !== 'object') continue;
    const content = (m as Record<string, unknown>).content;
    if (typeof content === 'string' && content.trim() !== '') return content;
  }
  return null;
}

/**
 * 从请求体提取用户文本；拿不到返回 null。
 *
 * 宁可返回 null（少记一条）也不猜错归属 —— 归档宁可缺，不可错。
 */
export function extractUserTextFromRequest(postData: string): string | null {
  if (typeof postData !== 'string' || postData.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(postData);
  } catch {
    return null;
  }
  const text = pickFirstString(parsed, REQUEST_TEXT_PATHS) ?? pickLastMessageText(parsed);
  if (text === null) return null;
  return text.trim() === '' ? null : text;
}

/**
 * 把用户文本包成契约消息。
 *
 * `aiGenerated: true` 是契约的强制字段（`isMirrorMessage` 要求），含义是
 * "本条记录属于一份 AI 生成内容的归档产物"（R3 / DD-15），而不是说用户话是 AI 说的。
 */
export function userTextToMirrorMessage(
  text: string,
  args: { conversationId: string; createdAt: number },
): MirrorMessage {
  return {
    id: `${args.conversationId}:pending-user`,
    role: 'user',
    text,
    createdAt: args.createdAt,
    aiGenerated: true,
  };
}
