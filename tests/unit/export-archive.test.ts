import { describe, expect, it } from 'vitest';
import { renderArchive } from '../../src/features/export/archive';
import { AI_NOTICE_TEXT } from '../../src/features/export/ai-notice';
import type { ConversationMirror } from '../../src/shared/ipc-contract';

/** 合成一个结构化会话镜像（含深度思考与引用） */
function conversation(messages: ConversationMirror['messages'] = []): ConversationMirror {
  return {
    id: 'conv-export-1',
    accountId: 'personal',
    title: '导出测试会话',
    url: 'https://chat.deepseek.com/a/chat/s/conv-export-1',
    updatedAt: 1_700_000_000_000,
    source: 'network',
    fidelity: 'full',
    messages,
  };
}

const sampleMessages: ConversationMirror['messages'] = [
  {
    id: 'm1',
    role: 'user',
    text: '你好',
    createdAt: 1_700_000_000_000,
    aiGenerated: true,
  },
  {
    id: 'm2',
    role: 'assistant',
    text: '你好！有什么可以帮你？',
    createdAt: 1_700_000_001_000,
    reasoning: '用户只是打招呼，简短回应即可。',
    citations: [{ title: '示例来源', url: 'https://example.com/a' }],
    aiGenerated: true,
  },
];

describe('renderArchive（M2 结构化导出渲染）', () => {
  it('Markdown：AI 标识是第一块，且含思考小节与引用列表', () => {
    const r = renderArchive(conversation(sampleMessages), 'md', 1_700_000_002_000);
    expect(r.hasNotice).toBe(true);
    expect(r.content).toContain(AI_NOTICE_TEXT);
    // 标识块必须在最前面（R3）
    expect(r.content.indexOf(AI_NOTICE_TEXT)).toBeLessThan(r.content.indexOf('# 导出测试会话'));
    expect(r.content).toContain('### 深度思考');
    expect(r.content).toContain('用户只是打招呼');
    expect(r.content).toContain('### 引用来源');
    expect(r.content).toContain('https://example.com/a');
    // 两条消息都导出，角色可区分
    expect(r.content).toContain('我（用户）');
    expect(r.content).toContain('AI 助手');
    expect(r.filename.endsWith('.md')).toBe(true);
  });

  it('JSON：信封带 aiGenerated/notice，且逐条消息仍为 aiGenerated: true', () => {
    const r = renderArchive(conversation(sampleMessages), 'json', 1_700_000_002_000);
    expect(r.hasNotice).toBe(true);
    const parsed = JSON.parse(r.content) as {
      aiGenerated?: boolean;
      notice?: string;
      schemaVersion?: number;
      messageCount?: number;
      conversation?: { messages: { aiGenerated?: boolean; reasoning?: string }[] };
    };
    expect(parsed.aiGenerated).toBe(true);
    expect(parsed.notice).toBe(AI_NOTICE_TEXT);
    expect(parsed.schemaVersion).toBeGreaterThan(0);
    expect(parsed.messageCount).toBe(2);
    expect(parsed.conversation?.messages).toHaveLength(2);
    expect(parsed.conversation?.messages.every((m) => m.aiGenerated === true)).toBe(true);
    expect(parsed.conversation?.messages[1]?.reasoning).toContain('用户只是打招呼');
    expect(r.filename.endsWith('.json')).toBe(true);
  });

  it('空会话也能导出（只输出标识块与元信息，不抛错）', () => {
    const md = renderArchive(conversation([]), 'md', 1_700_000_002_000);
    expect(md.hasNotice).toBe(true);
    expect(md.content).toContain('消息数：0');
    const json = renderArchive(conversation([]), 'json', 1_700_000_002_000);
    expect(json.hasNotice).toBe(true);
    expect((JSON.parse(json.content) as { messageCount?: number }).messageCount).toBe(0);
  });

  it('文件名已消毒：不含路径分隔符与非法字符', () => {
    const weird = conversation([]);
    weird.title = 'a/b\\c:d*e?f"g<h>i|j';
    const r = renderArchive(weird, 'md', 1_700_000_002_000);
    expect(r.filename).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('同一个会话两种格式的产物内容不同，但都自证 AI 生成', () => {
    const md = renderArchive(conversation(sampleMessages), 'md', 1);
    const json = renderArchive(conversation(sampleMessages), 'json', 1);
    expect(md.content).not.toBe(json.content);
    expect(md.hasNotice && json.hasNotice).toBe(true);
  });
});
