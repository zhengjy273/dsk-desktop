/**
 * M1 · T3：本地归档的全文检索（PLAN §4.1：先用内存索引，体量上来后迁 SQLite FTS5）。
 *
 * 设计取舍：
 *  - **不引入依赖**（DD-11）、**不联网**：启动时从 `MirrorStore` 读出全部会话，在内存里建索引；
 *  - 索引是**惰性**的（首次 `search()` 才 build），并且只缓存"会话快照"，不缓存文件句柄；
 *  - 语料体量预判（个人自用、纯文本）在几十 MB 以内，O(N) 扫描足够；超出后再按 PLAN §4.4 迁 FTS5；
 *  - 查询支持多个空格分隔的关键词（**AND** 语义），大小写不敏感；
 *  - 命中返回**片段**（命中位置前后各约 40 字符），便于搜索框直接展示，不整篇回传。
 */

import type { ConversationMirror } from '../shared/ipc-contract.ts';
import type { ConversationIndexEntry } from './mirror-store.ts';
import { MirrorStore } from './mirror-store.ts';

export interface SearchOptions {
  /** 最多返回多少条（默认 50）。 */
  limit?: number | undefined;
  /** 跳过前多少条命中（默认 0），配合 limit 做分页。 */
  offset?: number | undefined;
  /** 是否检索深度思考内容（默认 true）。 */
  includeReasoning?: boolean | undefined;
  /** 片段上下文半宽（字符数，默认 40）。 */
  contextRadius?: number | undefined;
}

export interface SearchHit {
  conversationId: string;
  accountId: string;
  title: string;
  url: string;
  updatedAt: number;
  score: number;
  /** 命中的消息（最多 3 条，按时间顺序）。 */
  matches: SearchMatch[];
  titleMatched: boolean;
}

export interface SearchMatch {
  messageId: string;
  role: 'user' | 'assistant';
  createdAt: number;
  /** 命中字段。 */
  field: 'text' | 'reasoning' | 'title';
  /** 命中片段（含省略号）。 */
  snippet: string;
}

export interface SearchResult {
  query: string;
  total: number;
  offset: number;
  limit: number;
  hits: SearchHit[];
}

export interface SearchMatchLike {
  matched: boolean;
  score: number;
}

/** 简单的 AND 语义匹配打分（纯函数，便于单测）。 */
export function scoreTerms(haystack: string, terms: readonly string[]): SearchMatchLike {
  if (terms.length === 0) return { matched: false, score: 0 };
  const lower = haystack.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const at = lower.indexOf(term);
    // AND 语义：任一词不命中 ⇒ 整条不匹配，得分归零（不保留已累计的部分分）。
    if (at < 0) return { matched: false, score: 0 };
    // 越靠前得分越高，且多次出现有小幅加成。
    score += 1000 - Math.min(at, 999);
    let cursor = at + term.length;
    let repeats = 0;
    while (repeats < 5) {
      const next = lower.indexOf(term, cursor);
      if (next < 0) break;
      repeats += 1;
      cursor = next + term.length;
    }
    score += repeats * 10;
  }
  return { matched: true, score };
}

export function tokenizeQuery(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** 取命中位置附近的一段文本；找不到时退化为前 N 个字符。 */
export function snippet(text: string, term: string, radius = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return '';
  const at = flat.toLowerCase().indexOf(term.toLowerCase());
  if (at < 0) return flat.length > radius * 2 ? `${flat.slice(0, radius * 2)}…` : flat;
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + term.length + radius);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

/**
 * 内存检索器。
 *
 * ```ts
 * const search = new MirrorSearch(store);
 * const result = search.search('深度思考 引用');
 * ```
 *
 * 索引刷新：写入归档后调用 `invalidate()`（或 `refresh()` 立即重建）。
 */
export class MirrorSearch {
  private readonly store: MirrorStore;

  private cache: { entries: ConversationIndexEntry[]; snapshotAt: number } | null = null;

  constructor(store: MirrorStore) {
    this.store = store;
  }

  /** 丢弃索引缓存，下次查询时重建（归档写入后调用）。 */
  invalidate(): void {
    this.cache = null;
  }

  /** 立即重建索引。 */
  refresh(): number {
    const entries = this.store.listConversations();
    this.cache = { entries, snapshotAt: Date.now() };
    return entries.length;
  }

  /** 返回已建索引的会话数（0 表示尚未建索引）。 */
  get indexedConversations(): number {
    return this.cache?.entries.length ?? 0;
  }

  search(query: string, options: SearchOptions = {}): SearchResult {
    const limit = Math.max(0, options.limit ?? 50);
    const offset = Math.max(0, options.offset ?? 0);
    const includeReasoning = options.includeReasoning !== false;
    const contextRadius = options.contextRadius ?? 40;
    const terms = tokenizeQuery(query);

    if (terms.length === 0) return { query, total: 0, offset, limit, hits: [] };

    if (!this.cache) this.refresh();
    const entries = this.cache?.entries ?? [];

    const all: SearchHit[] = [];
    for (const entry of entries) {
      const conversation = this.store.readConversation(entry.id, { accountId: entry.accountId });
      if (!conversation) continue; // 索引残留 / 文件被删：安全跳过（不崩）
      const hit = matchConversation(conversation, terms, includeReasoning, contextRadius);
      if (hit) all.push(hit);
    }

    all.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt || a.conversationId.localeCompare(b.conversationId));
    return { query, total: all.length, offset, limit, hits: all.slice(offset, offset + limit) };
  }
}

function matchConversation(
  conversation: ConversationMirror,
  terms: readonly string[],
  includeReasoning: boolean,
  contextRadius: number,
): SearchHit | null {
  const titleScore = scoreTerms(conversation.title, terms);
  const titleMatched = titleScore.matched;

  const matches: SearchMatch[] = [];
  let score = titleMatched ? titleScore.score * 2 : 0;
  let any = titleMatched;

  if (titleMatched) {
    matches.push({
      messageId: '',
      role: 'assistant',
      createdAt: conversation.updatedAt,
      field: 'title',
      snippet: snippet(conversation.title, terms[0] ?? '', contextRadius),
    });
  }

  for (const message of conversation.messages) {
    const textScore = scoreTerms(message.text, terms);
    if (textScore.matched) {
      any = true;
      score += textScore.score;
      if (matches.length < 3) {
        matches.push({
          messageId: message.id,
          role: message.role,
          createdAt: message.createdAt,
          field: 'text',
          snippet: snippet(message.text, terms[0] ?? '', contextRadius),
        });
      }
    }
    if (includeReasoning && typeof message.reasoning === 'string' && message.reasoning.length > 0) {
      const reasoningScore = scoreTerms(message.reasoning, terms);
      if (reasoningScore.matched) {
        any = true;
        score += reasoningScore.score;
        if (matches.length < 3) {
          matches.push({
            messageId: message.id,
            role: message.role,
            createdAt: message.createdAt,
            field: 'reasoning',
            snippet: snippet(message.reasoning, terms[0] ?? '', contextRadius),
          });
        }
      }
    }
  }

  if (!any) return null;
  matches.sort((a, b) => a.createdAt - b.createdAt);
  return {
    conversationId: conversation.id,
    accountId: conversation.accountId,
    title: conversation.title,
    url: conversation.url,
    updatedAt: conversation.updatedAt,
    score,
    matches,
    titleMatched,
  };
}
