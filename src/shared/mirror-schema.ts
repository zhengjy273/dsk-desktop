/**
 * 会话镜像的运行时校验 —— 零依赖手写校验（DD-11：供应链面最小）。
 *
 * 每个从"不可信来源"（页面 DOM、SSE 字节、旧版本本地文件）读入的对象都必须先过这里。
 */
import type { ConversationMirror, MirrorMessage } from './ipc-contract.js';

/** 落盘格式版本；破坏性变更时递增，并在 src/store/migrations 提供迁移。 */
export const MIRROR_SCHEMA_VERSION = 1;

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function isMirrorMessage(v: unknown): v is MirrorMessage {
  if (!isObj(v)) return false;
  if (!isStr(v.id) || v.id.length === 0) return false;
  if (v.role !== 'user' && v.role !== 'assistant') return false;
  if (!isStr(v.text)) return false;
  if (!isNum(v.createdAt)) return false;
  if (v.aiGenerated !== true) return false; // R3：不允许出现"未标注 AI 生成"的消息
  if (v.reasoning !== undefined && !isStr(v.reasoning)) return false;
  if (v.attachments !== undefined) {
    if (!Array.isArray(v.attachments)) return false;
    for (const a of v.attachments) {
      if (!isObj(a) || !isStr(a.name) || !isNum(a.size)) return false;
    }
  }
  if (v.citations !== undefined) {
    if (!Array.isArray(v.citations)) return false;
    for (const c of v.citations) {
      if (!isObj(c) || !isStr(c.url)) return false;
    }
  }
  return true;
}

export function isConversationMirror(v: unknown): v is ConversationMirror {
  if (!isObj(v)) return false;
  if (!isStr(v.id) || v.id.length === 0) return false;
  if (!isStr(v.accountId)) return false;
  if (!isStr(v.title)) return false;
  if (!isStr(v.url) || !v.url.startsWith('https://')) return false;
  if (!isNum(v.updatedAt)) return false;
  if (v.source !== 'network' && v.source !== 'dom') return false;
  if (v.fidelity !== 'partial' && v.fidelity !== 'full') return false;
  if (!Array.isArray(v.messages)) return false;
  return v.messages.every(isMirrorMessage);
}

/** 幂等键构造：同一轮同一内容重复观察时得到同一个 id。 */
export function messageId(conversationId: string, seq: number, text: string): string {
  let h = 2166136261; // FNV-1a 32bit
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${conversationId}:${seq}:${(h >>> 0).toString(16)}`;
}
