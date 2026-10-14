import { describe, expect, it } from 'vitest';
import {
  MIRROR_SCHEMA_VERSION,
  isConversationMirror,
  isMirrorMessage,
  messageId,
} from '../../src/shared/mirror-schema';

const okMsg = {
  id: 'c1:1:deadbeef',
  role: 'user' as const,
  text: '你好',
  createdAt: 1791598000000,
  aiGenerated: true as const,
};

const okConv = {
  id: 'c1',
  accountId: 'personal',
  title: '测试会话',
  url: 'https://chat.deepseek.com/a/chat/s/c1',
  updatedAt: 1791598000000,
  messages: [okMsg],
  source: 'network' as const,
  fidelity: 'full' as const,
};

describe('isMirrorMessage', () => {
  it('接受合法消息', () => {
    expect(isMirrorMessage(okMsg)).toBe(true);
  });

  it('拒绝缺少 aiGenerated 的消息（R3：不允许未标注的 AI 内容）', () => {
    const { aiGenerated: _drop, ...rest } = okMsg;
    expect(isMirrorMessage(rest)).toBe(false);
    expect(isMirrorMessage({ ...okMsg, aiGenerated: false })).toBe(false);
  });

  it('拒绝非法 role / 空 id / 非数字时间戳', () => {
    expect(isMirrorMessage({ ...okMsg, role: 'system' })).toBe(false);
    expect(isMirrorMessage({ ...okMsg, id: '' })).toBe(false);
    expect(isMirrorMessage({ ...okMsg, createdAt: 'now' })).toBe(false);
    expect(isMirrorMessage({ ...okMsg, createdAt: Number.NaN })).toBe(false);
  });

  it('拒绝非对象 / 数组 / null', () => {
    for (const bad of [null, undefined, 42, 'x', [], [okMsg]]) {
      expect(isMirrorMessage(bad)).toBe(false);
    }
  });

  it('校验可选字段的类型', () => {
    expect(isMirrorMessage({ ...okMsg, reasoning: 1 })).toBe(false);
    expect(isMirrorMessage({ ...okMsg, reasoning: '思考过程' })).toBe(true);
    expect(isMirrorMessage({ ...okMsg, attachments: [{ name: 'a.pdf', size: 1 }] })).toBe(true);
    expect(isMirrorMessage({ ...okMsg, attachments: [{ name: 'a.pdf' }] })).toBe(false);
    expect(isMirrorMessage({ ...okMsg, citations: [{ url: 'https://x.test' }] })).toBe(true);
    expect(isMirrorMessage({ ...okMsg, citations: [{ title: 'no url' }] })).toBe(false);
  });
});

describe('isConversationMirror', () => {
  it('接受合法会话', () => {
    expect(isConversationMirror(okConv)).toBe(true);
  });

  it('拒绝非 https 的 url', () => {
    expect(isConversationMirror({ ...okConv, url: 'http://chat.deepseek.com/' })).toBe(false);
    expect(isConversationMirror({ ...okConv, url: 'javascript:alert(1)' })).toBe(false);
  });

  it('拒绝越界的 source / fidelity', () => {
    expect(isConversationMirror({ ...okConv, source: 'guess' })).toBe(false);
    expect(isConversationMirror({ ...okConv, fidelity: 'maybe' })).toBe(false);
  });

  it('只要有一条消息非法就整体拒绝', () => {
    expect(isConversationMirror({ ...okConv, messages: [okMsg, { id: 'x' }] })).toBe(false);
  });

  it('接受空消息列表（新建会话）', () => {
    expect(isConversationMirror({ ...okConv, messages: [] })).toBe(true);
  });
});

describe('messageId 幂等性', () => {
  it('同输入 → 同 id（DOM 通道重复观察不产生重复记录）', () => {
    expect(messageId('c1', 3, '同样的话')).toBe(messageId('c1', 3, '同样的话'));
  });

  it('内容/序号/会话任一变化 → id 变化', () => {
    const a = messageId('c1', 3, '甲');
    expect(messageId('c1', 3, '乙')).not.toBe(a);
    expect(messageId('c1', 4, '甲')).not.toBe(a);
    expect(messageId('c2', 3, '甲')).not.toBe(a);
  });

  it('长文本与中文不丢精度', () => {
    const long = '中文'.repeat(5000);
    expect(messageId('c1', 1, long)).toBe(messageId('c1', 1, long));
  });
});

describe('schema 版本', () => {
  it('暴露可比较的版本号', () => {
    expect(Number.isInteger(MIRROR_SCHEMA_VERSION)).toBe(true);
    expect(MIRROR_SCHEMA_VERSION).toBeGreaterThan(0);
  });
});
