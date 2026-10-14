/**
 * M1 · T3 单元测试：`src/features/export/json.ts`（DD-15 / R3）。
 *
 * 断言：产物带 schema 版本号、`aiGenerated: true` 与标识文案必须保留；
 * 产物可被 `src/store/migrations` 直接读回（往返一致）。
 */

import { describe, expect, it } from 'vitest';
import type { ConversationMirror, MirrorMessage } from '../../src/shared/ipc-contract.ts';
import { MIRROR_SCHEMA_VERSION } from '../../src/shared/mirror-schema.ts';
import { AI_NOTICE_TEXT } from '../../src/features/export/ai-notice.ts';
import {
  buildJsonEnvelope,
  conversationToJson,
  parseJsonExport,
  renderConversationJson,
  unwrapJsonExport,
} from '../../src/features/export/json.ts';
import { migrateDetailed } from '../../src/store/migrations/index.ts';

const T0 = 1791598000000;
const EXPORTED_AT = 1791600000000;

function message(seq: number, role: MirrorMessage['role'], text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage {
  return { id: `c1:${seq}:hash`, role, text, createdAt: T0 + seq, aiGenerated: true, ...extra };
}

function conversation(overrides: Partial<ConversationMirror> = {}): ConversationMirror {
  return {
    id: 'c1',
    accountId: 'personal',
    title: 'JSON 导出测试',
    url: 'https://chat.deepseek.com/a/chat/s/c1',
    updatedAt: T0 + 2,
    messages: [
      message(1, 'user', '问题'),
      message(2, 'assistant', '回答', { reasoning: '思考', citations: [{ title: '来源', url: 'https://example.test/' }] }),
    ],
    source: 'network',
    fidelity: 'full',
    ...overrides,
  };
}

describe('JSON 导出', () => {
  it('产物带 schema 版本号、aiGenerated: true 与标识文案', () => {
    const { json, envelope } = renderConversationJson(conversation(), { exportedAt: EXPORTED_AT });
    expect(envelope.schemaVersion).toBe(MIRROR_SCHEMA_VERSION);
    expect(envelope.aiGenerated).toBe(true);
    expect(envelope.notice).toBe(AI_NOTICE_TEXT);
    expect(envelope.sourceUrl).toBe('https://chat.deepseek.com/a/chat/s/c1');
    expect(envelope.exportedAt).toBe(EXPORTED_AT);
    expect(envelope.messageCount).toBe(2);

    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed['schemaVersion']).toBe(MIRROR_SCHEMA_VERSION);
    expect(parsed['aiGenerated']).toBe(true);
    expect(json).toContain(AI_NOTICE_TEXT);
    expect(json.endsWith('\n')).toBe(true);
  });

  it('每条消息在产物里都保留 aiGenerated: true', () => {
    const parsed = JSON.parse(conversationToJson(conversation(), { exportedAt: EXPORTED_AT })) as {
      conversation: { messages: { aiGenerated?: boolean; reasoning?: string; citations?: unknown[] }[] };
    };
    expect(parsed.conversation.messages).toHaveLength(2);
    for (const m of parsed.conversation.messages) expect(m.aiGenerated).toBe(true);
    expect(parsed.conversation.messages[1]?.reasoning).toBe('思考');
    expect(parsed.conversation.messages[1]?.citations).toHaveLength(1);
  });

  it('上游把 aiGenerated 抹掉，导出仍会补回 true（白名单拷贝）', () => {
    const tampered = conversation();
    const broken = { ...tampered.messages[0], aiGenerated: undefined } as unknown as MirrorMessage;
    const envelope = buildJsonEnvelope({ ...tampered, messages: [broken] }, { exportedAt: EXPORTED_AT });
    expect(envelope.conversation.messages[0]?.aiGenerated).toBe(true);
  });

  it('空会话也能导出', () => {
    const { envelope, json, messageCount } = renderConversationJson(conversation({ messages: [] }), {
      exportedAt: EXPORTED_AT,
    });
    expect(messageCount).toBe(0);
    expect(envelope.conversation.messages).toEqual([]);
    expect(json).toContain(AI_NOTICE_TEXT);
    expect(envelope.aiGenerated).toBe(true);
  });

  it('indent: 0 输出紧凑单行 JSON；文件名以 .json 结尾且不含路径分隔符', () => {
    const compact = renderConversationJson(conversation(), { exportedAt: EXPORTED_AT, indent: 0 });
    expect(compact.json.trim().split('\n')).toHaveLength(1);
    expect(compact.filename.endsWith('.json')).toBe(true);
    expect(compact.filename).not.toMatch(/[\\/]/);
  });

  it('产物可被 migrations 读回（往返一致，不丢消息）', () => {
    const original = conversation();
    const json = conversationToJson(original, { exportedAt: EXPORTED_AT });
    const parsed = parseJsonExport(json);
    const unwrapped = unwrapJsonExport(parsed);
    const result = migrateDetailed(parsed);
    expect(result.fromVersion).toBe(MIRROR_SCHEMA_VERSION);
    expect(result.conversation).not.toBeNull();
    expect(result.conversation?.messages.map((m) => m.text)).toEqual(original.messages.map((m) => m.text));
    expect(result.conversation?.messages.every((m) => m.aiGenerated === true)).toBe(true);
    // 内层对象本身就是合法镜像
    expect(unwrapped).toMatchObject({ id: 'c1', accountId: 'personal' });
  });

  it('parseJsonExport / unwrapJsonExport 对垃圾输入安全', () => {
    expect(parseJsonExport('{ not json')).toBeNull();
    expect(unwrapJsonExport(null)).toBeNull();
    expect(unwrapJsonExport('x')).toBe('x');
    expect(unwrapJsonExport({ a: 1 })).toEqual({ a: 1 });
    expect(unwrapJsonExport({ conversation: { id: 'c1' } })).toEqual({ id: 'c1' });
  });
});
