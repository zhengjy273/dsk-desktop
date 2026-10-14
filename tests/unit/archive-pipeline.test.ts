import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  extractConversationId,
  extractUserTextFromRequest,
  turnFidelity,
  turnToMirrorMessage,
  userTextToMirrorMessage,
} from '../../src/session/deepseek-mirror';
import { parseDeepSeekSse } from '../../src/session/sse-parser';
import { MirrorStore } from '../../src/store/mirror-store';

/** 合成一轮 DeepSeek 风格 SSE：ready → THINK 阶段 → 正文 → 真实形态引用 → close */
function syntheticSse(): string {
  const lines: string[] = [];
  lines.push('event: ready', 'data: {}', '');
  lines.push(
    `data: ${JSON.stringify({ v: { response: { role: 'ASSISTANT', status: 'WIP', fragments: [{ type: 'THINK', content: '' }] } } })}`,
    '',
  );
  for (const t of ['先想', '一下']) lines.push(`data: ${JSON.stringify({ v: t })}`, '');
  lines.push(`data: ${JSON.stringify({ v: { response: { fragments: [{ type: 'RESPONSE', content: '' }] } } })}`, '');
  for (const c of ['你', '好', '！']) lines.push(`data: ${JSON.stringify({ v: c })}`, '');
  // 引用：真实样本形态（对象自身带 url/title/snippet/site_name）
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
  lines.push('event: close', 'data: {}', '');
  return lines.join('\n');
}

describe('归档链路：SSE → 解析 → 消息 → MirrorStore', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function makeStore(): MirrorStore {
    dir = mkdtempSync(join(tmpdir(), 'dsk-archive-'));
    return new MirrorStore({ baseDir: dir, logger: { warn: () => {} } });
  }

  function buildMessage(conversationId: string) {
    const turn = parseDeepSeekSse(syntheticSse());
    return { turn, message: turnToMirrorMessage(turn, { conversationId, createdAt: 1_700_000_000_000 }) };
  }

  it('端到端写入并可读回：含思考、正文与引用', () => {
    const store = makeStore();
    const url = 'https://chat.deepseek.com/a/chat/s/conv-e2e-1';
    const conversationId = extractConversationId(url);
    expect(conversationId).toBe('conv-e2e-1');

    const { turn, message } = buildMessage(conversationId as string);
    expect(message).not.toBeNull();

    const result = store.appendTurn({
      accountId: 'personal',
      conversationId: conversationId as string,
      title: '端到端测试会话',
      url,
      messages: [message!],
      source: 'network',
      fidelity: turnFidelity(turn),
    });
    expect(result.appended).toBe(1);
    expect(result.conversation.fidelity).toBe('full');

    const back = store.readConversation('conv-e2e-1');
    expect(back?.messages).toHaveLength(1);
    const m = back?.messages[0];
    expect(m?.role).toBe('assistant');
    expect(m?.aiGenerated).toBe(true); // R3：不得出现"未标注 AI 生成"的消息
    expect(m?.reasoning).toBe('先想一下');
    expect(m?.text).toBe('你好！');
    expect(m?.citations).toHaveLength(2);
    expect(m?.citations?.[0]).toEqual({ title: '标题一', url: 'https://example.com/1' });
    expect(back?.source).toBe('network');
  });

  it('同一 store 内重复观测同一轮 → 不重复落盘（幂等）', () => {
    const store = makeStore();
    const { turn, message } = buildMessage('conv-idem-1');
    const input = {
      accountId: 'personal',
      conversationId: 'conv-idem-1',
      url: 'https://chat.deepseek.com/a/chat/s/conv-idem-1',
      messages: [message!],
      source: 'network' as const,
      fidelity: turnFidelity(turn),
    };
    expect(store.appendTurn(input).appended).toBe(1);
    expect(store.appendTurn(input).appended).toBe(0);
    expect(store.readConversation('conv-idem-1')?.messages).toHaveLength(1);
  });

  it('重启后依然幂等（幂等状态从磁盘重建，不靠内存序号）', () => {
    const store1 = makeStore();
    const { turn, message } = buildMessage('conv-restart-1');
    const input = {
      accountId: 'personal',
      conversationId: 'conv-restart-1',
      url: 'https://chat.deepseek.com/a/chat/s/conv-restart-1',
      messages: [message!],
      source: 'network' as const,
      fidelity: turnFidelity(turn),
    };
    expect(store1.appendTurn(input).appended).toBe(1);

    // 用同一目录新建实例 = 模拟应用重启
    const store2 = new MirrorStore({ baseDir: dir as string, logger: { warn: () => {} } });
    expect(store2.appendTurn(input).appended).toBe(0);
    expect(store2.readConversation('conv-restart-1')?.messages).toHaveLength(1);
  });

  it('索引列出会话，且**索引本身不含正文**（元数据最小化）', () => {
    const store = makeStore();
    const { turn, message } = buildMessage('conv-index-1');
    store.appendTurn({
      accountId: 'personal',
      conversationId: 'conv-index-1',
      title: '索引测试',
      url: 'https://chat.deepseek.com/a/chat/s/conv-index-1',
      messages: [message!],
      source: 'network',
      fidelity: turnFidelity(turn),
    });

    const list = store.listConversations();
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe('conv-index-1');
    expect(list[0]?.messageCount).toBe(1);
    // 正文与思考都只应存在于 JSONL，不应出现在索引里
    expect(JSON.stringify(list)).not.toContain('你好');
    expect(JSON.stringify(list)).not.toContain('先想一下');
  });

  it('用户消息与 AI 消息**一起归档**（双向完整会话）', () => {
    const store = makeStore();
    const url = 'https://chat.deepseek.com/a/chat/s/conv-bi-1';
    const userText = extractUserTextFromRequest(JSON.stringify({ prompt: '介绍爱因斯坦的成就' }));
    expect(userText).toBe('介绍爱因斯坦的成就');

    const { turn, message } = buildMessage('conv-bi-1');
    const result = store.appendTurn({
      accountId: 'personal',
      conversationId: 'conv-bi-1',
      url,
      messages: [
        userTextToMirrorMessage(userText as string, { conversationId: 'conv-bi-1', createdAt: 999 }),
        message!,
      ],
      source: 'network',
      fidelity: turnFidelity(turn),
    });
    expect(result.appended).toBe(2);

    const back = store.readConversation('conv-bi-1');
    expect(back?.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(back?.messages[0]?.text).toBe('介绍爱因斯坦的成就');
    expect(back?.messages.every((m) => m.aiGenerated === true)).toBe(true);
  });

  it('流被中断（无 close）→ fidelity=partial，但内容仍然归档', () => {
    const store = makeStore();
    const interrupted = ['event: ready', 'data: {}', `data: ${JSON.stringify({ v: '半' })}`, ''].join('\n\n');
    const turn = parseDeepSseSafely(interrupted);
    const message = turnToMirrorMessage(turn, { conversationId: 'conv-partial', createdAt: 1 });
    const result = store.appendTurn({
      accountId: 'personal',
      conversationId: 'conv-partial',
      url: 'https://chat.deepseek.com/a/chat/s/conv-partial',
      messages: [message!],
      source: 'network',
      fidelity: turnFidelity(turn),
    });
    expect(result.appended).toBe(1);
    expect(result.conversation.fidelity).toBe('partial');
    expect(store.readConversation('conv-partial')?.messages[0]?.text).toBe('半');
  });
});

/** 小包装：让"中断流"的构造保持可读 */
function parseDeepSseSafely(raw: string) {
  return parseDeepSeekSse(raw);
}
