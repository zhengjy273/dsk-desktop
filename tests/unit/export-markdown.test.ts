/**
 * M1 · T3 单元测试：`src/features/export/markdown.ts` + `ai-notice.ts`（DD-15 / R3）。
 *
 * 验收标准（docs/M1-TASKS.md T3）：
 *  - 「导出的每一份产物都含 AI 生成标识（自动化断言，不允许裸导出）」
 *  - Markdown 结构：标题 / 时间 / 角色 / 代码围栏 / 列表 / 深度思考 / 引用
 *  - 空会话也能导出
 */

import { describe, expect, it } from 'vitest';
import type { ConversationMirror, MirrorMessage } from '../../src/shared/ipc-contract.ts';
import {
  AI_NOTICE_MARKDOWN,
  AI_NOTICE_PLAIN,
  AI_NOTICE_TEXT,
  formatTimestamp,
  renderAiNotice,
  sanitizeUrl,
  serializeAiNotice,
} from '../../src/features/export/ai-notice.ts';
import {
  conversationToMarkdown,
  exportFilename,
  hasAiNotice,
  quoteBlock,
  renderConversationMarkdown,
  safeFence,
  sanitizeFilenamePart,
} from '../../src/features/export/markdown.ts';
import { conversationToJson } from '../../src/features/export/json.ts';

const T0 = 1791598000000;
const EXPORTED_AT = 1791600000000;

function userMessage(seq: number, text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage {
  return { id: `c1:${seq}:aaaa`, role: 'user', text, createdAt: T0 + seq, aiGenerated: true, ...extra };
}

function assistantMessage(seq: number, text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage {
  return { id: `c1:${seq}:bbbb`, role: 'assistant', text, createdAt: T0 + seq, aiGenerated: true, ...extra };
}

function conversation(overrides: Partial<ConversationMirror> = {}): ConversationMirror {
  return {
    id: 'c1',
    accountId: 'personal',
    title: '关于 TypeScript 的讨论',
    url: 'https://chat.deepseek.com/a/chat/s/c1',
    updatedAt: T0 + 10,
    messages: [userMessage(1, '什么是类型收窄？'), assistantMessage(2, '类型收窄就是编译器根据控制流推断更窄的类型。')],
    source: 'network',
    fidelity: 'full',
    ...overrides,
  };
}

describe('AI 生成标识（单一真源）', () => {
  it('文案固定且同时提供 Markdown / 纯文本形式', () => {
    expect(AI_NOTICE_TEXT).toBe('本内容由 AI 生成，请仔细甄别');
    expect(AI_NOTICE_MARKDOWN).toBe(`> ⚠️ ${AI_NOTICE_TEXT}`);
    expect(AI_NOTICE_PLAIN).toBe(`⚠️ ${AI_NOTICE_TEXT}`);
  });

  it('renderAiNotice 带来源 URL、导出时间与通道信息', () => {
    const notice = renderAiNotice({
      url: 'https://chat.deepseek.com/a/chat/s/c1',
      exportedAt: EXPORTED_AT,
      source: 'network',
      fidelity: 'full',
    });
    expect(notice.split('\n')[0]).toBe(AI_NOTICE_MARKDOWN);
    expect(notice).toContain('> 来源：https://chat.deepseek.com/a/chat/s/c1');
    expect(notice).toContain('> 导出时间：');
    expect(notice).toContain('通道 network');
    expect(notice).toContain('完整度 full');
  });

  it('renderAiNotice 对缺失字段稳健（只输出标识本身）', () => {
    const notice = renderAiNotice();
    expect(notice.startsWith(AI_NOTICE_MARKDOWN)).toBe(true);
    expect(notice).not.toContain('> 来源：');
    expect(notice).not.toContain('> 导出时间：');
  });

  it('serializeAiNotice 强制 aiGenerated: true（结构化产物也不允许裸导出）', () => {
    const json = serializeAiNotice({ url: 'https://x.test/', exportedAt: EXPORTED_AT });
    expect(json.aiGenerated).toBe(true);
    expect(json).toMatchObject({
      aiGenerated: true,
      notice: AI_NOTICE_TEXT,
      noticeText: AI_NOTICE_PLAIN,
      sourceUrl: 'https://x.test/',
      exportedAt: EXPORTED_AT,
    });
  });

  it('sanitizeUrl 只放行 https，其它协议降级为纯文本', () => {
    expect(sanitizeUrl('https://a.test/x')).toBe('https://a.test/x');
    // 非 https 一律去掉 Markdown 链接语法字符，避免变成可点击链接
    expect(sanitizeUrl('javascript:alert(1)')).not.toContain('(');
    expect(sanitizeUrl('javascript:alert(1)')).not.toContain(']');
    expect(sanitizeUrl('file:///C:/x](y)')).not.toContain(']');
    expect(sanitizeUrl('  https://b.test/y  ')).toBe('https://b.test/y');
  });

  it('formatTimestamp 同时给出本地时间与 ISO 8601', () => {
    const formatted = formatTimestamp(EXPORTED_AT);
    expect(formatted).toContain(new Date(EXPORTED_AT).toISOString());
  });
});

describe('Markdown 导出结构', () => {
  it('产物以 AI 生成标识开头，且带来源 URL 与导出时间', () => {
    const { markdown } = renderConversationMarkdown(conversation(), { exportedAt: EXPORTED_AT });
    const firstLine = markdown.split('\n')[0];
    expect(firstLine).toBe(AI_NOTICE_MARKDOWN);
    expect(markdown).toContain(AI_NOTICE_TEXT);
    expect(markdown).toContain('https://chat.deepseek.com/a/chat/s/c1');
    expect(markdown).toContain(formatTimestamp(EXPORTED_AT));
    expect(markdown.endsWith('\n')).toBe(true);
    expect(hasAiNotice(markdown)).toBe(true);
  });

  it('结构：标题 / 时间 / 角色分区都在', () => {
    const { markdown, filename, messageCount } = renderConversationMarkdown(conversation(), {
      exportedAt: EXPORTED_AT,
    });
    expect(markdown).toContain('# 关于 TypeScript 的讨论');
    expect(markdown).toContain('## 1. 我（用户）');
    expect(markdown).toContain('## 2. AI 助手');
    expect(markdown).toContain(`_时间：${formatTimestamp(T0 + 1)}_`);
    expect(markdown).toContain('- 会话 ID：`c1`');
    expect(markdown).toContain('- 账号：`personal`');
    expect(messageCount).toBe(2);
    expect(filename.endsWith('.md')).toBe(true);
    expect(filename).not.toContain('/');
    expect(filename).not.toContain('\\');
  });

  it('Markdown 标题与列表原样保留', () => {
    const body = ['## 小节标题', '', '- 第一项', '- 第二项', '', '1. 有序项', '', '| a | b |', '| - | - |', '| 1 | 2 |'].join('\n');
    const { markdown } = renderConversationMarkdown(
      conversation({ messages: [userMessage(1, 'hi'), assistantMessage(2, body)] }),
      { exportedAt: EXPORTED_AT },
    );
    expect(markdown).toContain('## 小节标题');
    expect(markdown).toContain('- 第一项\n- 第二项');
    expect(markdown).toContain('1. 有序项');
    expect(markdown).toContain('| a | b |');
  });

  it('代码用围栏包裹；正文自带围栏时提升外层围栏（不提前闭合）', () => {
    const code = ['说明：', '```ts', 'const a: number = 1;', '```', '以上。'].join('\n');
    const { markdown } = renderConversationMarkdown(
      conversation({ messages: [assistantMessage(1, code)] }),
      { exportedAt: EXPORTED_AT },
    );
    expect(markdown).toContain('```ts');
    expect(markdown).toContain('const a: number = 1;');
    // 外层围栏被提升为 4 个反引号
    expect(markdown).toContain('````\n说明：');
    expect(markdown).toContain('以上。\n````');
    expect(safeFence('plain')).toBe('```\nplain\n```');
    expect(safeFence('a ``` b')).toBe('````\na ``` b\n````');
    expect(safeFence('')).toBe('');
  });

  it('深度思考单独呈现并明确标注「深度思考」', () => {
    const { markdown } = renderConversationMarkdown(
      conversation({
        messages: [
          userMessage(1, '为什么？'),
          assistantMessage(2, '因为……', { reasoning: '第一，检查边界；\n第二，给出结论。' }),
        ],
      }),
      { exportedAt: EXPORTED_AT },
    );
    expect(markdown).toContain('### 深度思考（模型推理，非最终回答）');
    expect(markdown).toContain('> 第一，检查边界；');
    expect(markdown).toContain('> 第二，给出结论。');
    // 深度思考块在正文之前
    expect(markdown.indexOf('深度思考')).toBeLessThan(markdown.indexOf('因为……'));
  });

  it('includeReasoning: false 时不输出思考内容，但标识仍在', () => {
    const { markdown } = renderConversationMarkdown(
      conversation({ messages: [assistantMessage(1, '答案', { reasoning: '内心戏' })] }),
      { exportedAt: EXPORTED_AT, includeReasoning: false },
    );
    expect(markdown).not.toContain('内心戏');
    expect(markdown).not.toContain('### 深度思考');
    expect(hasAiNotice(markdown)).toBe(true);
  });

  it('引用渲染为链接列表（带序号与标题）', () => {
    const { markdown } = renderConversationMarkdown(
      conversation({
        messages: [
          assistantMessage(1, '结论如下。', {
            citations: [
              { title: 'MDN · 类型收窄', url: 'https://developer.mozilla.org/x' },
              { title: '', url: 'https://example.test/no-title' },
            ],
          }),
        ],
      }),
      { exportedAt: EXPORTED_AT },
    );
    expect(markdown).toContain('### 引用来源（2）');
    expect(markdown).toContain('1. [MDN · 类型收窄](<https://developer.mozilla.org/x>)');
    expect(markdown).toContain('2. [https://example.test/no-title](<https://example.test/no-title>)');
  });

  it('附件以列表呈现并带可读大小', () => {
    const { markdown } = renderConversationMarkdown(
      conversation({ messages: [userMessage(1, '看看这个', { attachments: [{ name: 'report.pdf', size: 2048 }] })] }),
      { exportedAt: EXPORTED_AT },
    );
    expect(markdown).toContain('### 附件');
    expect(markdown).toContain('- report.pdf（2.0 KB）');
  });

  it('空会话也能导出（不报错，含标识且给出空态说明）', () => {
    const { markdown, messageCount, filename } = renderConversationMarkdown(
      conversation({ messages: [], title: '空的会话' }),
      { exportedAt: EXPORTED_AT },
    );
    expect(messageCount).toBe(0);
    expect(markdown.split('\n')[0]).toBe(AI_NOTICE_MARKDOWN);
    expect(markdown).toContain('# 空的会话');
    expect(markdown).toContain('_（本会话没有可导出的消息）_');
    expect(markdown).toContain('- 消息数：0');
    expect(filename.endsWith('.md')).toBe(true);
    expect(hasAiNotice(markdown)).toBe(true);
  });

  it('正文为空的消息也能导出', () => {
    const { markdown } = renderConversationMarkdown(conversation({ messages: [assistantMessage(1, '   ')] }), {
      exportedAt: EXPORTED_AT,
    });
    expect(markdown).toContain('_（本条消息正文为空）_');
    expect(hasAiNotice(markdown)).toBe(true);
  });

  it('conversationToMarkdown 便捷函数与 renderConversationMarkdown 一致', () => {
    const conv = conversation();
    expect(conversationToMarkdown(conv, { exportedAt: EXPORTED_AT })).toBe(
      renderConversationMarkdown(conv, { exportedAt: EXPORTED_AT }).markdown,
    );
  });

  it('产物里每条消息的 AI 属性都有体现（不出现"裸导出"）', () => {
    const { markdown } = renderConversationMarkdown(conversation(), { exportedAt: EXPORTED_AT });
    // 逐条导出时角色分区数量 = 消息数
    const sections = markdown.split('\n').filter((line) => /^## \d+\. /.test(line));
    expect(sections).toHaveLength(conversation().messages.length);
    expect(hasAiNotice(markdown)).toBe(true);
  });
});

describe('规模与性能（T3 验收：导出 100 条消息 < 2s）', () => {
  function longConversation(count: number): ConversationMirror {
    const messages: MirrorMessage[] = [];
    for (let i = 1; i <= count; i += 1) {
      messages.push(
        i % 2 === 1
          ? userMessage(i, `第 ${i} 个问题：请解释第 ${i} 个概念。`)
          : assistantMessage(i, `第 ${i} 个回答：\n\n- 要点一\n- 要点二\n\n\`\`\`ts\nconst n${i} = ${i};\n\`\`\``, {
              reasoning: `关于第 ${i} 个问题的推理过程……`,
              citations: [{ title: `来源 ${i}`, url: `https://example.test/${i}` }],
            }),
      );
    }
    return conversation({ messages, title: '长会话（100 条）' });
  }

  it('100 条消息的 Markdown 导出 < 2s 且结构完整', () => {
    const conv = longConversation(100);
    const started = Date.now();
    const { markdown, messageCount } = renderConversationMarkdown(conv, { exportedAt: EXPORTED_AT });
    const elapsed = Date.now() - started;

    expect(messageCount).toBe(100);
    expect(elapsed).toBeLessThan(2000);
    expect(hasAiNotice(markdown)).toBe(true);
    expect(markdown.split('\n').filter((line) => /^## \d+\. /.test(line))).toHaveLength(100);
    expect(markdown).toContain('const n100 = 100;');
    expect(markdown).toContain('### 深度思考（模型推理，非最终回答）');
    expect(markdown).toContain('### 引用来源（1）');
  });

  it('100 条消息的 JSON 导出 < 2s 且可被读回', () => {
    const conv = longConversation(100);
    const started = Date.now();
    const json = conversationToJson(conv, { exportedAt: EXPORTED_AT });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
    const parsed = JSON.parse(json) as { messageCount: number; conversation: { messages: unknown[] } };
    expect(parsed.messageCount).toBe(100);
    expect(parsed.conversation.messages).toHaveLength(100);
  });
});

describe('辅助函数', () => {
  it('quoteBlock 保留空行', () => {
    expect(quoteBlock('a\n\nb')).toBe('> a\n>\n> b');
  });

  it('sanitizeFilenamePart 去掉 Windows 非法字符与控制字符', () => {
    expect(sanitizeFilenamePart('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(sanitizeFilenamePart('name\u0000with\u001fctrl')).toBe('namewithctrl');
    expect(sanitizeFilenamePart('递归问题...')).toBe('递归问题');
    expect(sanitizeFilenamePart('  spaced   out  ')).toBe('spaced out');
  });

  it('exportFilename 带日期且总是 .md', () => {
    const filename = exportFilename('a/b:c', 'c1', EXPORTED_AT);
    expect(filename).toMatch(/^a_b_c-c1-\d{8}-\d{4}\.md$/);
    expect(exportFilename('', '', EXPORTED_AT)).toMatch(/^conversation-\d{8}-\d{4}\.md$/);
  });

  it('hasAiNotice 能识别缺少标识的裸文档', () => {
    expect(hasAiNotice('# 标题\n\n内容')).toBe(false);
    expect(hasAiNotice(AI_NOTICE_MARKDOWN)).toBe(true);
  });
});
