import { describe, expect, it } from 'vitest';
import {
  extractConversationId,
  extractModelTypeFromRequest,
  extractSessionIdFromRequest,
  extractUserTextFromRequest,
  pickLastMessageText,
  turnFidelity,
  turnToMirrorMessage,
  userTextToMirrorMessage,
} from '../../src/session/deepseek-mirror';
import { parseDeepSeekSse } from '../../src/session/sse-parser';
import { isMirrorMessage } from '../../src/shared/mirror-schema';

/** 合成一轮 DeepSeek 风格流（含可选的思考阶段与引用） */
function turnOf(opts: { deltas?: string[]; thinking?: string[]; refs?: boolean; close?: boolean } = {}) {
  const { deltas = [], thinking = [], refs = false, close = true } = opts;
  const lines: string[] = [];
  lines.push('event: ready', 'data: {}', '');
  if (thinking.length > 0) {
    lines.push(
      `data: ${JSON.stringify({ v: { response: { fragments: [{ type: 'THINK', content: '' }] } } })}`,
      '',
    );
    for (const t of thinking) lines.push(`data: ${JSON.stringify({ v: t })}`, '');
    lines.push(
      `data: ${JSON.stringify({ v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } })}`,
      '',
    );
  }
  for (const d of deltas) lines.push(`data: ${JSON.stringify({ v: d })}`, '');
  if (refs) {
    // 真实形态：引用对象自身带 url/title/snippet/site_name（见 M2-REPORT）
    lines.push(
      `data: ${JSON.stringify({
        o: 'SET',
        p: 'parent-id',
        v: [
          { url: 'https://example.com/1', title: '标题一', snippet: '摘要一', site_name: '站点一' },
          { url: 'https://example.com/2', title: '标题二', snippet: '摘要二', site_name: '站点二' },
        ],
      })}`,
      '',
    );
  }
  if (close) lines.push('event: close', 'data: {}', '');
  return parseDeepSeekSse(lines.join('\n'));
}

describe('extractConversationId', () => {
  it('从 /a/chat/s/<id> 形态提取', () => {
    expect(extractConversationId('https://chat.deepseek.com/a/chat/s/3f2b9c1e-aa11')).toBe('3f2b9c1e-aa11');
  });

  it('支持 query 参数形态', () => {
    expect(extractConversationId('https://chat.deepseek.com/?conversation=abc123')).toBe('abc123');
    expect(extractConversationId('https://chat.deepseek.com/?conversation_id=xyz_9')).toBe('xyz_9');
  });

  it('非会话 URL 返回 null', () => {
    expect(extractConversationId('https://chat.deepseek.com/')).toBeNull();
    expect(extractConversationId('about:blank')).toBeNull();
    expect(extractConversationId('')).toBeNull();
    expect(extractConversationId(undefined as unknown as string)).toBeNull();
  });

  it('拒绝不安全的 id 形状（防路径穿越）', () => {
    expect(extractConversationId('https://chat.deepseek.com/?conversation=../../etc/passwd')).toBeNull();
    expect(extractConversationId('https://chat.deepseek.com/?conversation=-leading-dash')).toBeNull();
  });
});

describe('turnToMirrorMessage', () => {
  it('正常一轮 → 通过 isMirrorMessage，且 aiGenerated 恒为 true', () => {
    const turn = turnOf({ deltas: ['你', '好'] });
    const msg = turnToMirrorMessage(turn, { conversationId: 'conv1', createdAt: 1000 });
    expect(msg).not.toBeNull();
    expect(msg?.text).toBe('你好');
    expect(msg?.role).toBe('assistant');
    expect(msg?.aiGenerated).toBe(true);
    expect(isMirrorMessage(msg)).toBe(true);
    expect(msg?.reasoning).toBeUndefined();
    expect(msg?.citations).toBeUndefined();
  });

  it('带思考时写入 reasoning，且不写空字符串', () => {
    const withThinking = turnToMirrorMessage(turnOf({ deltas: ['答'], thinking: ['想'] }), {
      conversationId: 'c',
      createdAt: 1,
    });
    expect(withThinking?.reasoning).toBe('想');

    const without = turnToMirrorMessage(turnOf({ deltas: ['答'] }), { conversationId: 'c', createdAt: 1 });
    expect(without && 'reasoning' in without).toBe(false);
  });

  it('提取真实形态的引用并映射为 {title,url}', () => {
    const msg = turnToMirrorMessage(turnOf({ deltas: ['答'], refs: true }), {
      conversationId: 'c',
      createdAt: 1,
    });
    expect(msg?.citations).toHaveLength(2);
    expect(msg?.citations?.[0]).toEqual({ title: '标题一', url: 'https://example.com/1' });
    expect(isMirrorMessage(msg)).toBe(true);
  });

  it('没有 title 时用 url 兜底', () => {
    const turn = parseDeepSeekSse(
      [
        `data: ${JSON.stringify({ v: [{ url: 'https://example.com/x' }] })}`,
        `data: ${JSON.stringify({ v: '正文' })}`,
        '',
      ].join('\n\n'),
    );
    const msg = turnToMirrorMessage(turn, { conversationId: 'c', createdAt: 1 });
    expect(msg?.citations?.[0]?.title).toBe('https://example.com/x');
  });

  it('完全空的一轮返回 null（不往归档塞空消息）', () => {
    expect(turnToMirrorMessage(turnOf({}), { conversationId: 'c', createdAt: 1 })).toBeNull();
  });

  it('流被中断（没有 close）但仍收到文本 → 仍然产出消息', () => {
    const turn = turnOf({ deltas: ['半'], close: false });
    const msg = turnToMirrorMessage(turn, { conversationId: 'c', createdAt: 1 });
    expect(msg?.text).toBe('半');
    expect(turnFidelity(turn)).toBe('partial');
  });

  it('占位 id 不含非法路径字符（真正的幂等键由 MirrorStore 重算）', () => {
    const msg = turnToMirrorMessage(turnOf({ deltas: ['x'] }), { conversationId: 'conv-1', createdAt: 1 });
    expect(msg?.id.startsWith('conv-1:')).toBe(true);
  });
});

describe('turnFidelity', () => {
  it('正常结束且无坏帧 → full', () => {
    expect(turnFidelity(turnOf({ deltas: ['答'] }))).toBe('full');
  });

  it('没有 close → partial', () => {
    expect(turnFidelity(turnOf({ deltas: ['答'], close: false }))).toBe('partial');
  });

  it('有 JSON 解析失败的坏帧 → partial', () => {
    const turn = parseDeepSeekSse(['data: not-json', `data: ${JSON.stringify({ v: 'ok' })}`, 'event: close', 'data: {}', ''].join('\n\n'));
    expect(turn.skipped).toBe(1);
    expect(turnFidelity(turn)).toBe('partial');
  });
});

describe('用户消息：从请求体提取（SSE 只有 assistant 侧）', () => {
  it('从 prompt 路径提取', () => {
    expect(extractUserTextFromRequest(JSON.stringify({ prompt: '你好' }))).toBe('你好');
  });

  it('从 query / content 等候选路径提取', () => {
    expect(extractUserTextFromRequest(JSON.stringify({ query: '问题' }))).toBe('问题');
    expect(extractUserTextFromRequest(JSON.stringify({ content: '内容' }))).toBe('内容');
  });

  it('从 messages 数组取**最后一条** content', () => {
    const body = JSON.stringify({
      messages: [
        { role: 'user', content: '第一条' },
        { role: 'assistant', content: '回答' },
        { role: 'user', content: '最后一条' },
      ],
    });
    expect(extractUserTextFromRequest(body)).toBe('最后一条');
  });

  it('非 JSON / 空 / 无候选字段 / 全空白 → null（宁可少记，不猜错归属）', () => {
    expect(extractUserTextFromRequest('not json')).toBeNull();
    expect(extractUserTextFromRequest('')).toBeNull();
    expect(extractUserTextFromRequest(JSON.stringify({ other: 1 }))).toBeNull();
    expect(extractUserTextFromRequest(JSON.stringify({ prompt: '   ' }))).toBeNull();
    expect(extractUserTextFromRequest(undefined as unknown as string)).toBeNull();
  });

  it('提取失败时绝不返回"猜的内容"（只认白名单路径）', () => {
    expect(extractUserTextFromRequest(JSON.stringify({ a: 'b', c: 'd' }))).toBeNull();
  });

  it('pickLastMessageText 跳过非对象与非法 content', () => {
    expect(pickLastMessageText({ messages: [null, 42, { content: 7 }] })).toBeNull();
    expect(pickLastMessageText({ messages: [{ content: 'a' }] })).toBe('a');
    expect(pickLastMessageText({})).toBeNull();
  });

  it('包成契约消息：role=user 且 aiGenerated=true（契约强制字段），并通过校验', () => {
    const m = userTextToMirrorMessage('介绍爱因斯坦', { conversationId: 'c1', createdAt: 1 });
    expect(m.role).toBe('user');
    expect(m.aiGenerated).toBe(true);
    expect(isMirrorMessage(m)).toBe(true);
  });
});

describe('会话 id：从请求体提取（比 URL 更早可用）', () => {
  it('实测字段 chat_session_id', () => {
    const body = JSON.stringify({
      chat_session_id: 'bb4882f8-1b58-4c1a-bdb9-67fe9499ed2a',
      parent_message_id: 14,
      prompt: '双生子佯谬',
      thinking_enabled: true,
    });
    expect(extractSessionIdFromRequest(body)).toBe('bb4882f8-1b58-4c1a-bdb9-67fe9499ed2a');
  });

  it('兼容 session_id / conversation_id 形态', () => {
    expect(extractSessionIdFromRequest(JSON.stringify({ session_id: 'abc123' }))).toBe('abc123');
    expect(extractSessionIdFromRequest(JSON.stringify({ conversation_id: 'conv_9' }))).toBe('conv_9');
  });

  it('拿不到或形状不安全 → null（防路径穿越）', () => {
    expect(extractSessionIdFromRequest('not json')).toBeNull();
    expect(extractSessionIdFromRequest('')).toBeNull();
    expect(extractSessionIdFromRequest(JSON.stringify({ other: 1 }))).toBeNull();
    expect(extractSessionIdFromRequest(JSON.stringify({ chat_session_id: '../../evil' }))).toBeNull();
    expect(extractSessionIdFromRequest(JSON.stringify({ chat_session_id: '-bad' }))).toBeNull();
  });
});

describe('模型标识：从请求体提取（限额上限按模型下发）', () => {
  it('实测字段 model_type', () => {
    const body = JSON.stringify({ chat_session_id: 'abc', model_type: 'deep_think', prompt: 'hi' });
    expect(extractModelTypeFromRequest(body)).toBe('deep_think');
  });

  it('兼容 modelType / model / chat_model', () => {
    expect(extractModelTypeFromRequest(JSON.stringify({ modelType: 'x' }))).toBe('x');
    expect(extractModelTypeFromRequest(JSON.stringify({ model: 'y' }))).toBe('y');
    expect(extractModelTypeFromRequest(JSON.stringify({ chat_model: 'z' }))).toBe('z');
  });

  it('拿不到 → null（调用方保留旧值，不猜）', () => {
    expect(extractModelTypeFromRequest('not json')).toBeNull();
    expect(extractModelTypeFromRequest('')).toBeNull();
    expect(extractModelTypeFromRequest(JSON.stringify({ prompt: 'hi' }))).toBeNull();
  });

  it('过长或空字符串 → null（避免把 prompt 文本误当模型名）', () => {
    expect(extractModelTypeFromRequest(JSON.stringify({ model_type: 'a'.repeat(65) }))).toBeNull();
    expect(extractModelTypeFromRequest(JSON.stringify({ model_type: '   ' }))).toBeNull();
  });
});
