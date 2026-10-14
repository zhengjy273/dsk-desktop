/**
 * M1 · T3 单元测试：`src/store/search.ts`（内存全文检索）。
 *
 * 覆盖：多词 AND 语义、按相关度排序、片段裁剪、思考过程命中、索引失效与分页。
 * 全部数据写在 `node:os` 的 tmpdir() 下。
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MirrorMessage } from '../../src/shared/ipc-contract.ts';
import { MirrorStore } from '../../src/store/mirror-store.ts';
import { MirrorSearch, scoreTerms, snippet, tokenizeQuery } from '../../src/store/search.ts';

const ACCOUNT = 'personal';
const T0 = 1791598000000;

let baseDir: string;
let store: MirrorStore;

function message(seq: number, role: MirrorMessage['role'], text: string, extra: Partial<MirrorMessage> = {}): MirrorMessage {
  return { id: `m:${seq}`, role, text, createdAt: T0 + seq, aiGenerated: true, ...extra };
}

function addConversation(id: string, title: string, messages: MirrorMessage[]): void {
  store.appendTurn({
    accountId: ACCOUNT,
    conversationId: id,
    title,
    url: `https://chat.deepseek.com/a/chat/s/${id}`,
    messages,
    source: 'network',
    fidelity: 'full',
    observedAt: T0,
  });
}

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'dsk-search-'));
  store = new MirrorStore({ baseDir });
});

afterEach(() => {
  if (existsSync(baseDir)) rmSync(baseDir, { recursive: true, force: true });
});

describe('纯函数', () => {
  it('tokenizeQuery 小写化并按空白切分', () => {
    expect(tokenizeQuery('  TypeScript   类型  ')).toEqual(['typescript', '类型']);
    expect(tokenizeQuery('   ')).toEqual([]);
  });

  it('scoreTerms 是 AND 语义：任一关键词缺失即不匹配且得分为 0', () => {
    expect(scoreTerms('类型收窄与泛型', ['类型', '泛型'])).toEqual(expect.objectContaining({ matched: true }));
    expect(scoreTerms('只有类型', ['类型', '泛型'])).toEqual({ matched: false, score: 0 });
    expect(scoreTerms('任意文本', [])).toEqual({ matched: false, score: 0 });
    // 命中位置越靠前得分越高
    const early = scoreTerms('abc 目标', ['目标']).score;
    const late = scoreTerms(`${'x'.repeat(50)} 目标`, ['目标']).score;
    expect(early).toBeGreaterThan(late);
  });

  it('snippet 截取命中附近文本并加省略号', () => {
    const text = `${'a'.repeat(100)}命中关键字${'b'.repeat(100)}`;
    const out = snippet(text, '命中关键字', 10);
    expect(out).toContain('命中关键字');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    // 找不到关键词时退回前若干字符
    expect(snippet('短文本', '不存在')).toBe('短文本');
    expect(snippet('', 'x')).toBe('');
  });
});

describe('MirrorSearch', () => {
  it('空查询返回空结果，且不建立索引', () => {
    addConversation('c1', '标题', [message(1, 'user', '内容')]);
    const search = new MirrorSearch(store);
    expect(search.search('   ').hits).toEqual([]);
    expect(search.indexedConversations).toBe(0);
  });

  it('命中正文、给出片段与相关度排序', () => {
    addConversation('c1', '泛型讨论', [message(1, 'assistant', '这里是关于类型收窄的说明。')]);
    addConversation('c2', '无关会话', [message(1, 'user', '今天天气不错')]);
    addConversation('c3', '类型收窄', [message(1, 'user', '请讲讲类型收窄')]);

    const search = new MirrorSearch(store);
    const result = search.search('类型收窄');
    expect(result.total).toBe(2);
    expect(result.hits.map((h) => h.conversationId)).toContain('c1');
    expect(result.hits.map((h) => h.conversationId)).toContain('c3');
    // 标题命中的排在前面（标题权重更高）
    expect(result.hits[0]?.conversationId).toBe('c3');
    expect(result.hits[0]?.titleMatched).toBe(true);
    expect(result.hits[0]?.matches[0]?.field).toBe('title');
    expect(result.hits[1]?.matches[0]?.snippet).toContain('类型收窄');
  });

  it('多关键词是 AND：两个词都出现才算命中', () => {
    addConversation('c1', '并发', [message(1, 'assistant', '关于并发与锁的说明')]);
    addConversation('c2', '并发', [message(1, 'assistant', '只讲并发')]);
    const search = new MirrorSearch(store);
    expect(search.search('并发 锁').hits.map((h) => h.conversationId)).toEqual(['c1']);
  });

  it('可以命中深度思考内容，并标注 field=reasoning', () => {
    addConversation('c1', '思考', [message(1, 'assistant', '最终回答', { reasoning: '内部推理：先看边界条件' })]);
    const search = new MirrorSearch(store);
    const hit = search.search('边界条件').hits[0];
    expect(hit?.conversationId).toBe('c1');
    expect(hit?.matches[0]?.field).toBe('reasoning');

    // 关闭思考检索后不再命中
    expect(search.search('边界条件', { includeReasoning: false }).total).toBe(0);
    // 但正文仍可命中
    expect(search.search('最终回答').total).toBe(1);
  });

  it('分页：limit / offset 有效', () => {
    for (let i = 1; i <= 5; i += 1) {
      addConversation(`c${i}`, `关键词 ${i}`, [message(1, 'user', `第 ${i} 篇 共同关键词`)]);
    }
    const search = new MirrorSearch(store);
    const all = search.search('共同关键词');
    expect(all.total).toBe(5);
    expect(all.hits).toHaveLength(5);

    const page = search.search('共同关键词', { limit: 2, offset: 1 });
    expect(page.hits).toHaveLength(2);
    expect(page.hits.map((h) => h.conversationId)).toEqual(all.hits.slice(1, 3).map((h) => h.conversationId));
    expect(search.search('共同关键词', { limit: 0 }).hits).toEqual([]);
    expect(search.search('共同关键词', { offset: 99 }).hits).toEqual([]);
  });

  it('invalidate() 后能看到新写入的会话', () => {
    addConversation('c1', '旧会话', [message(1, 'user', '旧内容')]);
    const search = new MirrorSearch(store);
    expect(search.search('独特的词').total).toBe(0);

    addConversation('c2', '新会话', [message(1, 'user', '这里有独特的词')]);
    // 尚未失效：缓存里没有 c2
    expect(search.search('独特的词').total).toBe(0);
    search.invalidate();
    expect(search.search('独特的词').total).toBe(1);
    expect(search.indexedConversations).toBe(2);
  });

  it('索引里残留但磁盘文件已消失的会话被安全跳过', () => {
    addConversation('c1', '会被删掉的会话', [message(1, 'user', '关键词内容')]);
    const search = new MirrorSearch(store);
    expect(search.search('关键词内容').total).toBe(1);
    // 模拟"索引还在、文件没了"
    store.clearAll();
    search.invalidate();
    expect(search.search('关键词内容').total).toBe(0);
  });
});
