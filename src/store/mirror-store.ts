/**
 * M1 · T3：会话镜像存储 —— 追加式 JSONL + 原子重写索引。
 *
 * 设计（PLAN §4.4 / DD-06）：
 *  - 布局：`<baseDir>/<accountId>/<conversationId>.jsonl`（**baseDir 由调用方传入**，便于测试用临时目录）；
 *  - 每条 JSONL 记录就是一个 `MirrorMessage`（最小冗余：正文与思考过程留在日志里，元数据进索引）；
 *  - 幂等：幂等键为**内容寻址**（`contentKey()` = `messageId(conv, 0, role+text)`，复用 T0 契约的
 *    FNV-1a 实现）。调用方传入的 `message.id` 也会被登记，因此重复观察只留一条记录，
 *    并且这一点**重启之后依然成立**（幂等状态从磁盘重建，不依赖内存里的序号）；
 *  - 索引：`<baseDir>/index.json`，先写同目录临时文件再 `renameSync` 覆盖（同卷 rename 在
 *    Windows/POSIX 上都是原子替换），因此读方永远不会看到"写了一半"的索引；
 *  - 容错（DD-05：降级而非崩溃）：损坏的 JSONL 行、非法对象一律**安全跳过并告警**，
 *    绝不让一条坏数据毁掉整个存储。
 *
 * 所有外部输入（调用方参数、磁盘上的旧文件）都必须先过 `src/shared/mirror-schema.ts` 的校验函数。
 * 本模块只依赖 Node 内置模块，不 import electron（可在纯 Node / vitest 下运行）。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ConversationMirror, MirrorMessage } from '../shared/ipc-contract.ts';
import {
  MIRROR_SCHEMA_VERSION,
  isConversationMirror,
  isMirrorMessage,
  messageId,
} from '../shared/mirror-schema.ts';

/* ------------------------------------------------------------------ 类型 */

/** 索引里的一条会话摘要（由已验证的 `ConversationMirror` 派生，永不包含正文）。 */
export interface ConversationIndexEntry {
  id: string;
  accountId: string;
  title: string;
  url: string;
  updatedAt: number;
  /** 已落盘的消息条数（去重后）。 */
  messageCount: number;
  /** 数据来源可追溯（DD-06）。 */
  source: ConversationMirror['source'];
  fidelity: ConversationMirror['fidelity'];
  /** 首次落盘时间。 */
  createdAt: number;
}

export interface MirrorIndex {
  schemaVersion: number;
  updatedAt: number;
  conversations: ConversationIndexEntry[];
}

/** 结构化日志事件：便于测试断言、也便于主进程统一收集诊断。 */
export interface MirrorLogEvent {
  code:
    | 'skipped-invalid-record'
    | 'skipped-corrupt-line'
    | 'read-failed'
    | 'rejected-input'
    | 'rejected-conversation'
    | 'index-unreadable'
    | 'index-invalid'
    | 'orphan-entry'
    | 'cleared';
  message: string;
  /** 相对 baseDir 的文件路径（日志用，便于定位）。 */
  file?: string;
  line?: number;
}

export interface MirrorLogger {
  warn(event: MirrorLogEvent): void;
  info?(event: MirrorLogEvent): void;
}

export interface MirrorStoreOptions {
  /** baseDir 由调用方传入（生产环境为主进程的 userData 子目录，测试里用 tmpdir）。 */
  baseDir: string;
  logger?: MirrorLogger;
}

/** 写入入口的输入：元数据 + 本轮观察到的消息（可以是空数组 = 新建空会话）。 */
export interface AppendTurnInput {
  accountId: string;
  conversationId: string;
  title?: string;
  url: string;
  messages: readonly MirrorMessage[];
  source: ConversationMirror['source'];
  fidelity: ConversationMirror['fidelity'];
  /** 观察时间；默认取"消息最大 createdAt"与"当前时间"的较大值。 */
  observedAt?: number;
}

export interface AppendTurnResult {
  conversation: ConversationMirror;
  /** 本次真正新增的消息数（幂等：重复观察时为 0）。 */
  appended: number;
  /** 本次因 id 已存在而跳过的消息数。 */
  skipped: number;
}

export interface ReadConversationOptions {
  accountId: string;
  conversationId: string;
}

/* ------------------------------------------------------- 常量与基础工具 */

export const INDEX_FILENAME = 'index.json';

/** 临时文件前缀：以 `.` 开头（与合法 id 的首字符规则互斥）且带 `.tmp` 后缀。 */
const TMP_PREFIX = '.tmp-';
const TMP_SUFFIX = '.json';

/** 允许的 id 形状：字母/数字开头，允许 `._-`，上限 128 字符。**禁止** `..`、路径分隔符、盘符。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * 校验一段外部输入能否安全地当作路径片段。
 * 这是路径穿越的第一道防线（`accountId` / `conversationId` 都可能来自页面）。
 */
export function isSafePathSegment(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 128) return false;
  if (!SAFE_ID.test(value)) return false;
  if (value.includes('..')) return false;
  return true;
}

/** 测试/生产共用的"原子替换落盘"回调挂点（在写 tmp 之后、rename 之前触发）。 */
let beforeAtomicRenameHook: (() => void) | null = null;

/** 仅用于测试：注册 rename 前的挂点，便于对"索引永远可解析"做高并发断言。 */
export function setBeforeAtomicRenameHookForTests(hook: (() => void) | null): void {
  beforeAtomicRenameHook = hook;
}

const defaultLogger: MirrorLogger = {
  warn(event) {
    // 只降级告警，不抛出：坏数据不得中断归档（DD-05）。
    console.warn(`[mirror-store] ${event.code}: ${event.message}`);
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rel(baseDir: string, file: string): string {
  return file.startsWith(baseDir) ? file.slice(baseDir.length).replace(/^[\\/]+/, '') : file;
}

let tmpCounter = 0;

/* ------------------------------------------------------------- MirrorStore */

export class MirrorStore {
  readonly baseDir: string;

  private readonly logger: MirrorLogger;

  /** 会话 id 全集：由索引维护（去重、稳定顺序）。 */
  private entryCache = new Map<string, ConversationIndexEntry>();

  /** 每个会话已落盘的幂等键集合：既含 `message.id`，也含"内容键"（重启后仍幂等）。 */
  private seenCache = new Map<string, Set<string>>();

  constructor(options: MirrorStoreOptions) {
    if (typeof options?.baseDir !== 'string' || options.baseDir.length === 0) {
      throw new TypeError('MirrorStore: baseDir 必须是非空字符串');
    }
    this.baseDir = options.baseDir;
    this.logger = options.logger ?? defaultLogger;
    this.mkdirp(this.baseDir, true);
    this.loadIndex();
  }

  /* ------------------------------------------------------------- 写入 */

  /**
   * 追加一轮观察到的消息（写入入口）。
   *
   * - 输入非法（id/url/消息非法）→ 抛 `TypeError`（写入路径拒绝，不做静默丢弃）；
   * - 输入合法但本轮消息全部是重复 id → 不重复落盘，仅刷新索引元数据；
   * - 空消息数组是合法的（新建空会话也能被索引到、能被导出）。
   */
  appendTurn(input: AppendTurnInput): AppendTurnResult {
    if (typeof input !== 'object' || input === null) throw new TypeError('appendTurn: 输入必须是对象');
    const { accountId, conversationId } = input;

    if (!isSafePathSegment(accountId)) {
      this.logger.warn({
        code: 'rejected-input',
        message: `拒绝非法 accountId：${JSON.stringify(input.accountId)}`,
      });
      throw new TypeError('appendTurn: accountId 非法（只允许字母/数字开头、[A-Za-z0-9._-]、≤128 字符）');
    }
    if (!isSafePathSegment(conversationId)) {
      this.logger.warn({
        code: 'rejected-input',
        message: `拒绝非法 conversationId：${JSON.stringify(input.conversationId)}`,
      });
      throw new TypeError('appendTurn: conversationId 非法（只允许字母/数字开头、[A-Za-z0-9._-]、≤128 字符）');
    }
    if (typeof input.url !== 'string' || !input.url.startsWith('https://')) {
      this.logger.warn({ code: 'rejected-input', message: `拒绝非 https 的 url：${String(input.url)}` });
      throw new TypeError('appendTurn: url 必须以 https:// 开头');
    }
    if (input.source !== 'network' && input.source !== 'dom') {
      throw new TypeError("appendTurn: source 必须是 'network' | 'dom'");
    }
    if (input.fidelity !== 'partial' && input.fidelity !== 'full') {
      throw new TypeError("appendTurn: fidelity 必须是 'partial' | 'full'");
    }
    if (!Array.isArray(input.messages)) {
      throw new TypeError('appendTurn: messages 必须是数组');
    }

    const existing = this.entryCache.get(conversationId);
    if (existing && existing.accountId !== accountId) {
      this.logger.warn({
        code: 'rejected-input',
        message: `会话 ${conversationId} 已属于账号 ${existing.accountId}，拒绝写入账号 ${accountId}`,
      });
      throw new TypeError('appendTurn: conversationId 已归属其它 accountId（跨账号写入被拒绝）');
    }

    // 只接受能过契约校验的消息；其余安全跳过并告警（不因为一条坏消息丢掉整轮）。
    const accepted: MirrorMessage[] = [];
    for (const raw of input.messages) {
      if (isMirrorMessage(raw)) accepted.push(raw);
      else {
        this.logger.warn({
          code: 'skipped-invalid-record',
          message: `跳过非法消息（未通过 isMirrorMessage）：${describe(raw)}`,
          file: this.relConversationFile(accountId, conversationId),
        });
      }
    }

    const file = this.conversationFile(accountId, conversationId);
    const seen = this.ensureSeen(accountId, conversationId);
    const fresh: MirrorMessage[] = [];
    let skipped = 0;

    for (const message of accepted) {
      const key = contentKey(conversationId, message);
      if (seen.has(message.id) || seen.has(key)) {
        skipped += 1;
        continue;
      }
      seen.add(key);
      seen.add(message.id);
      fresh.push({ ...message, id: key });
    }

    if (fresh.length > 0) {
      this.mkdirp(dirname(file), false);
      const payload = fresh.map((m) => `${JSON.stringify(m)}\n`).join('');
      writeFileSync(file, payload, { encoding: 'utf8', flag: 'a' });
    }

    const conversation = this.buildConversation({
      accountId,
      conversationId,
      title: input.title,
      url: input.url,
      existing,
      fallbackSource: input.source,
      fallbackFidelity: input.fidelity,
      observedAt: input.observedAt,
    });

    if (!isConversationMirror(conversation)) {
      this.logger.warn({
        code: 'rejected-conversation',
        message: `组装出的会话未通过 isConversationMirror 校验，已拒绝写入：${conversationId}`,
        file: rel(this.baseDir, file),
      });
      // 回滚本轮缓存，保持缓存与磁盘一致（磁盘只落了 fresh 记录，这里不落索引）。
      throw new TypeError('appendTurn: 组装出的会话非法，已拒绝（未写入索引）');
    }

    this.putEntry(conversation);
    this.writeIndexAtomically();

    return { conversation, appended: fresh.length, skipped };
  }

  /* ------------------------------------------------------------- 读回 */

  /** 按 `updatedAt` 倒序列出全部会话（读索引，O(1) 文件 IO）。 */
  listConversations(): ConversationIndexEntry[] {
    return [...this.entryCache.values()].sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }

  /** 读回一个会话的完整镜像；不存在返回 `null`。 */
  readConversation(id: string, options?: { accountId?: string }): ConversationMirror | null {
    if (typeof id !== 'string' || id.length === 0) return null;
    const entry = this.entryCache.get(id);
    const accountId = options?.accountId ?? entry?.accountId;
    if (!isSafePathSegment(accountId)) {
      if (entry) {
        this.logger.warn({
          code: 'orphan-entry',
          message: `索引项 ${id} 的 accountId 非法，无法读回`,
        });
      }
      return null;
    }
    if (!isSafePathSegment(id)) return null;

    const file = this.conversationFile(accountId, id);
    if (!existsSync(file)) {
      if (entry) {
        this.logger.warn({
          code: 'orphan-entry',
          message: `索引项 ${id} 对应的日志不存在，返回空会话`,
          file: rel(this.baseDir, file),
        });
        return {
          id,
          accountId,
          title: entry.title,
          url: entry.url,
          updatedAt: entry.updatedAt,
          messages: [],
          source: entry.source,
          fidelity: entry.fidelity,
        };
      }
      return null;
    }

    const { messages, skipped } = this.readMessages(file);
    if (skipped > 0) {
      this.logger.warn({
        code: 'read-failed',
        message: `会话 ${id} 读回时跳过 ${skipped} 条异常记录（其余照常返回）`,
        file: rel(this.baseDir, file),
      });
    }

    const fallbackUpdatedAt =
      messages.length > 0 ? Math.max(...messages.map((m) => m.createdAt)) : Date.now();

    const conversation: ConversationMirror = {
      id,
      accountId,
      title: entry?.title ?? `会话 ${id}`,
      url: entry?.url ?? 'https://chat.deepseek.com/',
      updatedAt: entry?.updatedAt ?? fallbackUpdatedAt,
      messages,
      source: entry?.source ?? 'dom',
      fidelity: entry?.fidelity ?? 'partial',
    };

    if (!isConversationMirror(conversation)) {
      // 索引里的元数据不合法（例如被手改过）：仍然把合法消息还给调用方，但用安全默认值兜底。
      this.logger.warn({
        code: 'rejected-conversation',
        message: `会话 ${id} 的元数据未通过校验，已用安全默认值降级返回`,
      });
      return {
        id,
        accountId,
        title: `会话 ${id}`,
        url: 'https://chat.deepseek.com/',
        updatedAt: fallbackUpdatedAt,
        messages,
        source: 'dom',
        fidelity: 'partial',
      };
    }
    return conversation;
  }

  /** 列出某账号下磁盘上实际存在的会话 id（用于核对索引是否残留/缺失）。 */
  listConversationFiles(accountId: string): string[] {
    if (!isSafePathSegment(accountId)) return [];
    const dir = join(this.baseDir, accountId);
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const id = name.slice(0, -'.jsonl'.length);
      if (isSafePathSegment(id)) out.push(id);
    }
    return out.sort();
  }

  /* ------------------------------------------------------- 一键清除数据 */

  /**
   * 「一键清除本地数据」：删除索引里登记过的账号目录、磁盘上残留的孤儿账号目录与索引文件。
   *
   * 安全约束（顺序即防护）：
   *  1. 目标必须是**直接子目录**（`dirname(target) === realpath(baseDir)`），因此符号链接/junction
   *     指到别处时也只会删掉链接本身，不会顺着链接删到外部；
   *  2. 名称必须过 `isSafePathSegment`（无 `..`、无路径分隔符）；
   *  3. 只删子目录，不删 `baseDir` 本身 —— 调用方把镜像放在 `<userData>/mirror/` 时不会波及 userData；
   *  4. 清理遗留的 `.tmp-*.json`，避免崩溃残留。
   *
   * 返回被删除的**账号目录数**。
   */
  clearAll(): number {
    const accounts = new Set<string>();
    for (const entry of this.entryCache.values()) {
      if (isSafePathSegment(entry.accountId)) accounts.add(entry.accountId);
    }
    // 索引可能已损坏/被删，但磁盘上仍有数据 → 直接扫目录，保证"清除"是真的清除。
    for (const name of readdirSyncSafe(this.baseDir)) {
      if (isSafePathSegment(name) && isDirectory(join(this.baseDir, name))) accounts.add(name);
    }

    let removed = 0;
    for (const accountId of accounts) {
      const dir = join(this.baseDir, accountId);
      if (!existsSync(dir)) continue;
      if (!this.isDirectChild(dir)) {
        this.logger.warn({
          code: 'read-failed',
          message: `跳过非直接子目录（可能是链接）：${rel(this.baseDir, dir)}`,
          file: rel(this.baseDir, dir),
        });
        continue;
      }
      try {
        rmSync(dir, { recursive: true, force: true });
        removed += 1;
      } catch (error) {
        this.logger.warn({
          code: 'read-failed',
          message: `删除账号目录失败（已跳过）：${describe(error)}`,
          file: rel(this.baseDir, dir),
        });
      }
    }
    this.removeStaleTmpFiles(this.baseDir);
    try {
      rmSync(join(this.baseDir, INDEX_FILENAME), { force: true });
    } catch (error) {
      this.logger.warn({ code: 'read-failed', message: `删除索引失败：${describe(error)}` });
    }
    this.entryCache.clear();
    this.seenCache.clear();
    this.logger.info?.({ code: 'cleared', message: `已清除 ${removed} 个账号的本地镜像数据` });
    return removed;
  }

  /** 判定 `target` 是否为 `baseDir` 的直接子路径（用 realpath 抵御链接穿越）。 */
  private isDirectChild(target: string): boolean {
    const parent = realpathSyncSafe(dirname(target));
    const base = realpathSyncSafe(this.baseDir);
    return parent === base;
  }

  /* ------------------------------------------------------------- 内部 */

  private relConversationFile(accountId: string, conversationId: string): string {
    return rel(this.baseDir, this.conversationFile(accountId, conversationId));
  }

  private conversationFile(accountId: string, conversationId: string): string {
    return join(this.baseDir, accountId, `${conversationId}.jsonl`);
  }

  private mkdirp(dir: string, allowBase: boolean): void {
    if (!allowBase && !dir.startsWith(this.baseDir)) {
      throw new TypeError(`MirrorStore: 拒绝在 baseDir 之外建目录（${dir}）`);
    }
    mkdirSync(dir, { recursive: true });
  }

  private loadIndex(): void {
    const file = join(this.baseDir, INDEX_FILENAME);
    if (!existsSync(file)) return;
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      this.logger.warn({ code: 'index-unreadable', message: `索引不可读：${describe(error)}`, file: INDEX_FILENAME });
      return;
    }
    const parsed = safeJsonParse(raw);
    if (parsed === undefined) {
      this.logger.warn({ code: 'index-invalid', message: '索引不是合法 JSON，按空索引处理', file: INDEX_FILENAME });
      return;
    }
    const root = isRecord(parsed) ? parsed : null;
    const list = root && Array.isArray(root['conversations']) ? (root['conversations'] as unknown[]) : [];
    for (const item of list) {
      const entry = normalizeIndexEntry(item);
      if (entry) this.entryCache.set(entry.id, entry);
      else {
        this.logger.warn({
          code: 'index-invalid',
          message: `索引项未通过校验，已跳过：${describe(item)}`,
          file: INDEX_FILENAME,
        });
      }
    }
  }

  /** 索引里的会话摘要（本模块自产，仍做一次严格校验，用于安全跳过外部/手改数据）。 */
  private putEntry(conversation: ConversationMirror): void {
    const previous = this.entryCache.get(conversation.id);
    const entry: ConversationIndexEntry = {
      id: conversation.id,
      accountId: conversation.accountId,
      title: conversation.title,
      url: conversation.url,
      updatedAt: conversation.updatedAt,
      messageCount: conversation.messages.length,
      source: conversation.source,
      fidelity: conversation.fidelity,
      createdAt: previous?.createdAt ?? conversation.updatedAt,
    };
    this.entryCache.set(entry.id, entry);
  }

  private buildConversation(args: {
    accountId: string;
    conversationId: string;
    title?: string | undefined;
    url: string;
    existing: ConversationIndexEntry | undefined;
    fallbackSource: ConversationMirror['source'];
    fallbackFidelity: ConversationMirror['fidelity'];
    observedAt?: number | undefined;
  }): ConversationMirror {
    const { accountId, conversationId, existing } = args;

    // 落盘后的正文以磁盘为准（包含历史消息），保证"读回一致"。
    const file = this.conversationFile(accountId, conversationId);
    let stored: MirrorMessage[] = [];
    if (existsSync(file)) {
      const read = this.readMessages(file);
      stored = read.messages;
      if (read.skipped > 0) {
        this.logger.warn({
          code: 'skipped-corrupt-line',
          message: `组装会话时跳过 ${read.skipped} 条异常记录`,
          file: rel(this.baseDir, file),
        });
      }
    }

    const timestamps = stored.map((m) => m.createdAt);
    const observed =
      typeof args.observedAt === 'number' && Number.isFinite(args.observedAt) ? args.observedAt : undefined;
    const latest = timestamps.length > 0 ? Math.max(...timestamps) : undefined;
    // 只有"新建的空会话"才用当前时间兜底；其余一律取已观察到的最大值。
    const updatedAt =
      Math.max(existing?.updatedAt ?? 0, latest ?? 0, observed ?? 0) ||
      (stored.length === 0 ? Date.now() : args.observedAt ?? Date.now());

    const title = sanitizeTitle(args.title) ?? existing?.title ?? `会话 ${conversationId}`;

    return {
      id: conversationId,
      accountId,
      title,
      url: args.url,
      updatedAt,
      messages: stored,
      source: args.fallbackSource,
      fidelity: args.fallbackFidelity,
    };
  }

  private ensureSeen(accountId: string, conversationId: string): Set<string> {
    const cached = this.seenCache.get(conversationId);
    if (cached) return cached;
    const seen = new Set<string>();
    const file = this.conversationFile(accountId, conversationId);
    if (existsSync(file)) {
      const read = this.readMessages(file);
      for (const message of read.messages) {
        // 同时登记"已落盘的 id"与"内容键"，因此重启后重复观察同一内容仍然幂等。
        seen.add(message.id);
        seen.add(contentKey(conversationId, message));
      }
      if (read.skipped > 0) {
        this.logger.warn({
          code: 'skipped-corrupt-line',
          message: `为幂等写入扫描日志时跳过 ${read.skipped} 条异常记录`,
          file: rel(this.baseDir, file),
        });
      }
    }
    this.seenCache.set(conversationId, seen);
    return seen;
  }

  /** 读 JSONL：逐行解析，坏行安全跳过并计告警，其余照常返回。 */
  private readMessages(file: string): { messages: MirrorMessage[]; skipped: number } {
    const messages: MirrorMessage[] = [];
    let skipped = 0;
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      this.logger.warn({
        code: 'read-failed',
        message: `读取 JSONL 失败：${describe(error)}`,
        file: rel(this.baseDir, file),
      });
      return { messages, skipped };
    }

    const seen = new Set<string>();
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = (lines[i] ?? '').trim();
      if (line.length === 0) continue; // 末尾换行 / 空行属正常
      const parsed = safeJsonParse(line);
      if (parsed === undefined) {
        skipped += 1;
        this.logger.warn({
          code: 'skipped-corrupt-line',
          message: 'JSONL 行不是合法 JSON，已跳过',
          file: rel(this.baseDir, file),
          line: i + 1,
        });
        continue;
      }
      if (!isMirrorMessage(parsed)) {
        skipped += 1;
        this.logger.warn({
          code: 'skipped-invalid-record',
          message: `JSONL 行未通过 isMirrorMessage 校验，已跳过：${describe(parsed)}`,
          file: rel(this.baseDir, file),
          line: i + 1,
        });
        continue;
      }
      if (seen.has(parsed.id)) {
        skipped += 1; // 旧文件里若混入了重复记录，读回时同样去重
        continue;
      }
      seen.add(parsed.id);
      messages.push(parsed);
    }
    messages.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return { messages, skipped };
  }

  /** 先写同目录临时文件，再原子 rename 覆盖（读方永远看不到半个索引）。 */
  private writeIndexAtomically(): void {
    const target = join(this.baseDir, INDEX_FILENAME);
    const index: MirrorIndex = {
      schemaVersion: MIRROR_SCHEMA_VERSION,
      updatedAt: Date.now(),
      conversations: [...this.entryCache.values()].sort((a, b) => a.id.localeCompare(b.id)),
    };
    const payload = `${JSON.stringify(index, null, 2)}\n`;
    tmpCounter += 1;
    const tmp = join(this.baseDir, `${TMP_PREFIX}${process.pid}-${tmpCounter}${TMP_SUFFIX}`);
    writeFileSync(tmp, payload, 'utf8');
    beforeAtomicRenameHook?.();
    try {
      renameSync(tmp, target);
    } catch (error) {
      // 极端情况（跨卷/权限）：退化为"先删后改名"，并保证清理临时文件。
      try {
        rmSync(target, { force: true });
        renameSync(tmp, target);
      } catch (inner) {
        try {
          rmSync(tmp, { force: true });
        } catch {
          /* 清理失败也不再抛出：归档不应让主进程崩溃 */
        }
        this.logger.warn({
          code: 'read-failed',
          message: `索引原子替换失败：${describe(inner) || describe(error)}`,
          file: INDEX_FILENAME,
        });
      }
    }
  }

  private removeStaleTmpFiles(dir: string): void {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!(name.startsWith(TMP_PREFIX) && name.endsWith(TMP_SUFFIX))) continue;
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }
}

/* ------------------------------------------------------------- 纯函数辅助 */

/**
 * 幂等键：`messageId(conversationId, 0, role + '\u0000' + text)`。
 *
 * 为什么不用"会话 id + 序号"：序号在**重启后会重置**（序号状态不在磁盘上），
 * 于是同一轮的重复观察会被算出不同的 id，幂等就失效了。改用**内容寻址**后：
 *  - 重启前后同一内容 → 同一个 key（幂等）；
 *  - 同一会话内内容完全相同的两条消息 → 会被视为同一条（本工具自用的可接受取舍，
 *    且这种取舍是"少记"而不是"记错"，不影响导出可读性）；
 *  - 复用 T0 契约的 FNV-1a 哈希实现，不新增算法。
 */
export function contentKey(conversationId: string, message: Pick<MirrorMessage, 'role' | 'text'>): string {
  return messageId(conversationId, 0, `${message.role}\u0000${message.text}`);
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 读目录；失败（不存在/无权限）一律返回空数组 —— 归档层不因目录问题中断。 */
function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** realpath 的安全包装：路径不存在时退回原路径（用于 clearAll 的前置判定）。 */
function realpathSyncSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** 索引项校验：任何一项非法都不影响其余项。 */
export function normalizeIndexEntry(value: unknown): ConversationIndexEntry | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const accountId = value['accountId'];
  const title = value['title'];
  const url = value['url'];
  const updatedAt = value['updatedAt'];
  const messageCount = value['messageCount'];
  const source = value['source'];
  const fidelity = value['fidelity'];
  const createdAt = value['createdAt'];

  if (!isSafePathSegment(id)) return null;
  if (!isSafePathSegment(accountId)) return null;
  if (typeof title !== 'string') return null;
  if (typeof url !== 'string' || !url.startsWith('https://')) return null;
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null;
  if (typeof messageCount !== 'number' || !Number.isInteger(messageCount) || messageCount < 0) return null;
  if (source !== 'network' && source !== 'dom') return null;
  if (fidelity !== 'partial' && fidelity !== 'full') return null;

  return {
    id,
    accountId,
    title,
    url,
    updatedAt,
    messageCount,
    source,
    fidelity,
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : updatedAt,
  };
}

/** 标题清洗：折叠空白、限长，空标题交给调用方兜底。 */
export function sanitizeTitle(value: unknown, maxLength = 200): string | null {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return null;
  return flat.length > maxLength ? `${flat.slice(0, maxLength - 1)}…` : flat;
}

function describe(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    if (typeof s !== 'string') return String(value);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return '<unserializable>';
  }
}
