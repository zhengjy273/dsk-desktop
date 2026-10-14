/**
 * M1 · T3 单元测试：`src/store/migrations/index.ts`（版本化迁移骨架）。
 *
 * 关键断言：
 *  - 当前版本数据原样放行；
 *  - 无版本号 / 旧版本数据被**安全升级**，且每一步丢弃都有 note（绝不静默丢数据）；
 *  - 缺少 AI 标识、非法角色、无法解析的时间 → 拒绝或逐条丢弃并告警；
 *  - 未来版本 → **拒绝**（不假装读懂新格式）。
 */

import { describe, expect, it } from 'vitest';
import { MIRROR_SCHEMA_VERSION } from '../../src/shared/mirror-schema.ts';
import {
  CURRENT_VERSION,
  LEGACY_VERSION,
  MIGRATIONS,
  detectVersion,
  migrate,
  migrateDetailed,
  normalizeLegacyMessage,
  normalizeTimestamp,
  withSchemaVersion,
} from '../../src/store/migrations/index.ts';

const T0_MS = 1791598000000;
const T0_SEC = Math.floor(T0_MS / 1000);

const currentConversation = {
  id: 'c1',
  accountId: 'personal',
  title: '当前版本会话',
  url: 'https://chat.deepseek.com/a/chat/s/c1',
  updatedAt: T0_MS,
  messages: [{ id: 'c1:1:abc', role: 'user', text: '你好', createdAt: T0_MS, aiGenerated: true }],
  source: 'network',
  fidelity: 'full',
};

const legacyConversationV0 = {
  conversationId: 'c9',
  account: 'work',
  name: '旧格式会话',
  href: 'https://chat.deepseek.com/a/chat/s/c9',
  time: T0_SEC,
  source: 'network',
  fidelity: 'full',
  messages: [
    { messageId: 'c9:1:aa', role: 'user', content: '旧问题', timestamp: T0_SEC, ai: true },
    {
      messageId: 'c9:2:bb',
      role: 'assistant',
      content: '旧回答',
      timestamp: T0_SEC + 1,
      ai: true,
      thinking: '旧的思考过程',
      references: [{ name: '旧来源', url: 'https://example.test/old' }],
      files: [{ name: 'a.pdf', size: 10 }],
    },
  ],
};

describe('版本常量与探测', () => {
  it('当前版本来自 T0 契约，不重复定义', () => {
    expect(CURRENT_VERSION).toBe(MIRROR_SCHEMA_VERSION);
    expect(LEGACY_VERSION).toBe(0);
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    // 迁移链必须连续：0 → 1 → …
    let cursor = MIGRATIONS[0]?.from;
    for (const migration of MIGRATIONS) {
      expect(migration.from).toBe(cursor);
      expect(migration.to).toBe(migration.from + 1);
      cursor = migration.to;
    }
    expect(cursor).toBe(CURRENT_VERSION);
  });

  it('detectVersion 识别 schemaVersion / version / v，缺失视为 v0', () => {
    expect(detectVersion({ schemaVersion: 3 })).toEqual({ version: 3, explicit: true });
    expect(detectVersion({ version: '2' })).toEqual({ version: 2, explicit: true });
    expect(detectVersion({ v: 1 })).toEqual({ version: 1, explicit: true });
    expect(detectVersion({})).toEqual({ version: LEGACY_VERSION, explicit: false });
    expect(detectVersion(null)).toEqual({ version: LEGACY_VERSION, explicit: false });
    expect(detectVersion({ schemaVersion: 'x' })).toEqual({ version: LEGACY_VERSION, explicit: false });
  });

  it('normalizeTimestamp 统一秒/毫秒/ISO 字符串', () => {
    expect(normalizeTimestamp(T0_MS)).toBe(T0_MS);
    expect(normalizeTimestamp(T0_SEC)).toBe(T0_MS);
    expect(normalizeTimestamp(String(T0_MS))).toBe(T0_MS);
    expect(normalizeTimestamp(new Date(T0_MS).toISOString())).toBe(T0_MS);
    expect(normalizeTimestamp('not a date')).toBeNull();
    expect(normalizeTimestamp(undefined)).toBeNull();
  });
});

describe('migrate：当前版本', () => {
  it('带版本号的合法数据原样通过', () => {
    const result = migrateDetailed({ schemaVersion: CURRENT_VERSION, conversation: currentConversation });
    expect(result.conversation).toEqual(currentConversation);
    expect(result.fromVersion).toBe(CURRENT_VERSION);
    expect(result.notes.some((n) => n.code === 'envelope-unwrapped')).toBe(true);
  });

  it('无版本号但结构符合当前版本 → 直接接受（不产生丢弃）', () => {
    const result = migrateDetailed(currentConversation);
    expect(result.conversation).toEqual(currentConversation);
    expect(result.notes.some((n) => n.code === 'assumed-legacy')).toBe(true);
    expect(result.notes.some((n) => n.code === 'dropped-message')).toBe(false);
  });

  it('withSchemaVersion 输出的信封可被自己读回', () => {
    const envelope = withSchemaVersion(currentConversation as never);
    expect(envelope['schemaVersion']).toBe(CURRENT_VERSION);
    expect(migrate(envelope)).toEqual(currentConversation);
  });

  it('migrate 的 out 参数能收集告警（供 diagnostics 使用）', () => {
    const notes: Parameters<typeof migrate>[1] = [];
    const conversation = migrate(legacyConversationV0, notes);
    expect(conversation).not.toBeNull();
    expect(notes?.length ?? 0).toBeGreaterThan(0);
    expect(notes?.some((n) => n.code === 'upgraded')).toBe(true);
  });
});

describe('migrate：旧版本安全升级', () => {
  it('v0 实验格式升级为当前版本，字段全部对应上', () => {
    const result = migrateDetailed(legacyConversationV0);
    const conversation = result.conversation;
    expect(conversation).not.toBeNull();
    expect(result.fromVersion).toBe(LEGACY_VERSION);
    expect(result.toVersion).toBe(CURRENT_VERSION);
    expect(conversation).toMatchObject({
      id: 'c9',
      accountId: 'work',
      title: '旧格式会话',
      url: 'https://chat.deepseek.com/a/chat/s/c9',
      source: 'network',
      fidelity: 'full',
    });
    expect(conversation?.messages).toHaveLength(2);
    expect(conversation?.messages[0]).toMatchObject({ id: 'c9:1:aa', text: '旧问题', aiGenerated: true });
    expect(conversation?.messages[0]?.createdAt).toBe(T0_MS); // 秒 → 毫秒
    expect(conversation?.messages[1]?.reasoning).toBe('旧的思考过程');
    expect(conversation?.messages[1]?.citations?.[0]).toEqual({ title: '旧来源', url: 'https://example.test/old' });
    expect(result.conversation?.messages[1]?.attachments?.[0]).toEqual({ name: 'a.pdf', size: 10 });
    expect(result.toVersion).toBe(CURRENT_VERSION);
    expect(result.conversation?.messages.every((m) => m.createdAt >= T0_MS)).toBe(true);
    expect(result.notes.filter((n) => n.code === 'dropped-message')).toHaveLength(0);
  });

  it('v0 里缺 AI 标识的消息被逐条丢弃并给出 warn（不静默）', () => {
    const raw = {
      ...legacyConversationV0,
      messages: [
        ...legacyConversationV0.messages,
        { messageId: 'c9:3:cc', role: 'assistant', content: '没有标识', timestamp: T0_SEC + 2 },
      ],
    };
    const result = migrateDetailed(raw);
    expect(result.conversation?.messages).toHaveLength(2);
    const dropped = result.notes.filter((n) => n.code === 'dropped-message');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.level).toBe('warn');
    expect(dropped[0]?.message).toContain('aiGenerated');
  });

  it('v0 缺 source/fidelity/url 时补安全默认值并记 note', () => {
    const result = migrateDetailed({
      id: 'c2',
      title: '极简 v0',
      messages: [{ id: 'c2:1:x', role: 'user', text: 'hi', createdAt: T0_MS, aiGenerated: true }],
    });
    expect(result.conversation?.url).toBe('https://chat.deepseek.com/');
    expect(result.conversation?.source).toBe('dom');
    expect(result.conversation?.fidelity).toBe('partial');
    expect(result.notes.filter((n) => n.code === 'filled-default').length).toBeGreaterThanOrEqual(3);
  });

  it('v0 缺会话 id → 拒绝（返回 null，不猜）', () => {
    const result = migrateDetailed({ messages: [{ id: 'x', role: 'user', text: 'hi', createdAt: T0_MS, aiGenerated: true }] });
    expect(result.conversation).toBeNull();
    expect(result.notes.some((n) => n.code === 'rejected')).toBe(true);
  });

  it('normalizeLegacyMessage 逐条判定，理由可读', () => {
    expect(normalizeLegacyMessage({ id: 'x', role: 'system', text: 't', createdAt: 1, aiGenerated: true }).reason).toContain('role');
    expect(normalizeLegacyMessage({ id: 'x', role: 'user', createdAt: 1, aiGenerated: true }).reason).toContain('text');
    expect(normalizeLegacyMessage({ id: 'x', role: 'user', text: 't', createdAt: 'nope', aiGenerated: true }).reason).toContain('createdAt');
    expect(normalizeLegacyMessage({ id: '', role: 'user', text: 't', createdAt: 1, aiGenerated: true }).reason).toContain('id');
    expect(normalizeLegacyMessage(null).message).toBeNull();
    // 非 https 的引用被逐条过滤，其余引用保留
    const { message } = normalizeLegacyMessage({
      id: 'x',
      role: 'assistant',
      text: 't',
      createdAt: 1,
      aiGenerated: true,
      citations: [{ url: 'http://insecure.test/' }, { url: 'https://ok.test/' }],
    });
    expect(message?.citations).toHaveLength(1);
    expect(message?.citations?.[0]?.url).toBe('https://ok.test/');
  });
});

describe('migrate：拒绝路径', () => {
  it('未来版本 → 拒绝并给出 future-version 说明', () => {
    const result = migrateDetailed({ schemaVersion: CURRENT_VERSION + 5, conversation: currentConversation });
    expect(result.conversation).toBeNull();
    expect(result.fromVersion).toBe(CURRENT_VERSION + 5);
    expect(result.notes.some((n) => n.code === 'future-version')).toBe(true);
  });

  it('非对象 / 结构完全不符 → 拒绝', () => {
    for (const bad of [null, undefined, 42, 'x', [], true]) {
      const result = migrateDetailed(bad);
      expect(result.conversation).toBeNull();
      expect(result.notes.some((n) => n.code === 'rejected')).toBe(true);
    }
    const broken = migrateDetailed({ schemaVersion: CURRENT_VERSION, conversation: { id: 'x' } });
    expect(broken.conversation).toBeNull();
  });

  it('声明为当前版本但内容不合法的数据，会退回 v0 迁移再判定', () => {
    const result = migrateDetailed({ schemaVersion: CURRENT_VERSION, ...legacyConversationV0 });
    // 退回 v0 迁移后能救回来（字段可唯一对应），因此不应直接丢弃
    expect(result.conversation).not.toBeNull();
    expect(result.conversation?.id).toBe('c9');
    expect(result.notes.some((n) => n.code === 'assumed-legacy')).toBe(true);
  });
});
