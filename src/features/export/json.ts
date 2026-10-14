/**
 * M1 · T3：`ConversationMirror` → JSON 导出（PLAN §4.1 / DD-15）。
 *
 * 产物形状（带 schema 版本号，可被 `src/store/migrations` 的 `migrate()` 直接读回）：
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "aiGenerated": true,
 *   "notice": "本内容由 AI 生成，请仔细甄别",
 *   "exportedAt": 1791598000000,
 *   "exportedAtIso": "…",
 *   "generator": "…",
 *   "conversation": { …ConversationMirror（每条消息仍带 aiGenerated: true）… }
 * }
 * ```
 *
 * 约束：`aiGenerated: true` / `notice` 是**强制字段**（R3 / DD-15），不接受关闭开关；
 * 序列化只复制契约字段（相当于一次显式白名单拷贝），因此不会把内部字段意外带出，
 * 也不会因为循环引用而抛异常让导出崩掉。
 */

import type { ConversationMirror, MirrorMessage } from '../../shared/ipc-contract.ts';
import { MIRROR_SCHEMA_VERSION } from '../../shared/mirror-schema.ts';
import { AI_NOTICE_TEXT, DEFAULT_GENERATOR, formatTimestamp, serializeAiNotice } from './ai-notice.ts';
import { sanitizeFilenamePart } from './markdown.ts';

export interface JsonExportOptions {
  /** 导出时间（毫秒）；默认当前时间。显式传入可复现。 */
  exportedAt?: number | undefined;
  /** 缩进空格数（默认 2；传 0 输出紧凑单行）。 */
  indent?: number | undefined;
}

export interface JsonExportEnvelope {
  schemaVersion: number;
  aiGenerated: true;
  notice: string;
  noticeText: string;
  noticeVersion: string;
  generator: string;
  exportedAt: number;
  exportedAtIso: string;
  sourceUrl: string;
  mirrorSource: 'network' | 'dom';
  fidelity: 'partial' | 'full';
  messageCount: number;
  conversation: ConversationMirror;
}

export interface JsonExportResult {
  /** 可直接落盘的 JSON 字符串（结尾带换行）。 */
  json: string;
  /** 与 `json` 等价的对象（便于调用方写测试或继续加工）。 */
  envelope: JsonExportEnvelope;
  filename: string;
  exportedAt: number;
  messageCount: number;
}

export function buildJsonEnvelope(
  conversation: ConversationMirror,
  options: JsonExportOptions = {},
): JsonExportEnvelope {
  const exportedAt = Number.isFinite(options.exportedAt) ? (options.exportedAt as number) : Date.now();
  const notice = serializeAiNotice({
    url: conversation.url,
    exportedAt,
    source: conversation.source,
    fidelity: conversation.fidelity,
    title: conversation.title,
  });

  return {
    // 当前落盘/导出格式版本（与 T0 契约的 MIRROR_SCHEMA_VERSION 同源）。
    schemaVersion: MIRROR_SCHEMA_VERSION,
    aiGenerated: true,
    notice: AI_NOTICE_TEXT,
    noticeText: notice.noticeText,
    noticeVersion: notice.noticeVersion,
    generator: notice.generator,
    exportedAt,
    exportedAtIso: formatTimestamp(exportedAt),
    sourceUrl: conversation.url,
    mirrorSource: conversation.source,
    fidelity: conversation.fidelity,
    messageCount: conversation.messages.length,
    conversation: normalizeConversation(conversation),
  };
}

export function renderConversationJson(
  conversation: ConversationMirror,
  options: JsonExportOptions = {},
): JsonExportResult {
  const envelope = buildJsonEnvelope(conversation, options);
  const indent = options.indent === 0 ? 0 : (options.indent ?? 2);
  return {
    json: `${JSON.stringify(envelope, null, indent)}\n`,
    envelope,
    filename: jsonFilename(conversation.title, conversation.id, envelope.exportedAt),
    exportedAt: envelope.exportedAt,
    messageCount: envelope.messageCount,
  };
}

/** 便捷包装：只要 JSON 字符串。 */
export function conversationToJson(
  conversation: ConversationMirror,
  options: JsonExportOptions = {},
): string {
  return renderConversationJson(conversation, options).json;
}

/**
 * 读回：把导出产物（或旧版本文件）解析成对象。
 * 迁移到 `ConversationMirror` 请走 `src/store/migrations`（那里有版本判定与丢弃告警）。
 */
export function parseJsonExport(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** 解析后取内层会话对象；不是可识别的信封则返回原对象（交给迁移层判定）。 */
export function unwrapJsonExport(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return parsed;
  const record = parsed as Record<string, unknown>;
  const inner = record['conversation'];
  return typeof inner === 'object' && inner !== null && !Array.isArray(inner) ? inner : record;
}

/* --------------------------------------------------------------- 内部 */

/**
 * 显式白名单拷贝：只保留契约字段，并**逐条强制** `aiGenerated: true`（R3）。
 * 等价于"导出前再标注一次"，任何上游改动都无法把它从产物里去掉。
 */
function normalizeConversation(conversation: ConversationMirror): ConversationMirror {
  return {
    id: conversation.id,
    accountId: conversation.accountId,
    title: conversation.title,
    url: conversation.url,
    updatedAt: conversation.updatedAt,
    source: conversation.source,
    fidelity: conversation.fidelity,
    messages: conversation.messages.map(normalizeMessage),
  };
}

function normalizeMessage(message: MirrorMessage): MirrorMessage {
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.createdAt,
    aiGenerated: true,
    ...(typeof message.reasoning === 'string' ? { reasoning: message.reasoning } : {}),
    ...(Array.isArray(message.citations)
      ? { citations: message.citations.map((c) => ({ title: c.title, url: c.url })) }
      : {}),
    ...(Array.isArray(message.attachments)
      ? { attachments: message.attachments.map((a) => ({ name: a.name, size: a.size })) }
      : {}),
  };
}

function jsonFilename(title: string, id: string, exportedAt: number): string {
  const stamp = new Date(exportedAt);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const datePart = Number.isNaN(stamp.getTime())
    ? 'unknown-date'
    : `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
  const base = sanitizeFilenamePart(title).slice(0, 60);
  const safeId = sanitizeFilenamePart(id).slice(0, 40);
  const stem = base.length > 0 ? `${base}-${safeId}` : safeId;
  return `${stem || 'conversation'}-${datePart}.json`;
}
