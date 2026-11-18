/**
 * 限额状态存储 —— 按账号隔离的内存态 + 磁盘缓存。
 *
 * 为什么需要磁盘缓存（用户确认的口径）：
 *  - 只有**当前登录账号**的页面在跑轮询，其他账号拿不到实时数据；
 *  - 因此其余账号显示"上次登录时缓存的额度"，并明确标注「缓存」，无缓存显示「未知」。
 *
 * 落盘位置：`userData/quota/<accountId>.json`（与 `mirror/` 平级，不进安装目录、不进工作区）。
 * 边界：只存站点下发的额度/禁言/文案，**不存任何凭据**（R1）。
 *
 * 写作用域：`src/store/**`。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatStatus, ModelQuotaConfig, QuotaState } from '../session/quota-parser.ts';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isSafeAccountId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_ID.test(value) && !value.includes('..');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------ 宽容解析 */

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function parseChatStatus(raw: unknown): ChatStatus | null {
  if (!isRecord(raw)) return null;
  const quotasRaw = raw['quotas'];
  const quotas: ChatStatus['quotas'] = [];
  if (Array.isArray(quotasRaw)) {
    for (const item of quotasRaw) {
      if (!isRecord(item)) continue;
      quotas.push({
        modelType: typeof item['modelType'] === 'string' ? item['modelType'] : null,
        isExhausted: item['isExhausted'] === true,
        resetAt: num(item['resetAt']),
        msg: str(item['msg']),
        alertTitle: str(item['alertTitle']),
        alertDescription: str(item['alertDescription']),
      });
    }
  }
  return {
    generatedAt: num(raw['generatedAt']),
    isMuted: raw['isMuted'] === true,
    muteUntil: num(raw['muteUntil']),
    muteMsg: str(raw['muteMsg']),
    quotas,
  };
}

function parseModelConfig(raw: unknown): ModelQuotaConfig | null {
  if (!isRecord(raw)) return null;
  const n = (k: string): number | null =>
    typeof raw[k] === 'number' && Number.isFinite(raw[k] as number) ? (raw[k] as number) : null;
  return {
    modelType: typeof raw['modelType'] === 'string' ? raw['modelType'] : null,
    name: str(raw['name']),
    enabled: raw['enabled'] !== false,
    regenerateQuota: n('regenerateQuota'),
    editQuota: n('editQuota'),
    inputCharacterLimit: n('inputCharacterLimit'),
    fileTokenLimit: n('fileTokenLimit'),
    fileTokenLimitWithThinking: n('fileTokenLimitWithThinking'),
  };
}

/**
 * 读文本并剥掉 UTF-8 BOM。
 *
 * 为什么要剥：Windows 上用户可能用记事本/PowerShell 手工改过缓存文件（`Set-Content -Encoding UTF8`
 * 会带 BOM），而 `JSON.parse` 遇到 BOM 直接抛错 —— 表现是"缓存明明有内容却显示未知"。
 */
function readJsonText(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

/** 单个会话的观测记录（token 与已用次数各自独立，可能只有其一）。 */
export interface SessionTokenEntry {
  /** 该会话已用 token；没观测到过就没有这个字段 */
  tokens?: number;
  /** 最后一次观测到该会话数据的时间（毫秒），用于淘汰最旧记录 */
  updatedAt: number;
  /** 该会话已用「重新生成」次数（有观测时才有值） */
  regenerateUsed?: number;
  /** 该会话已用「修改输入」次数（有观测时才有值） */
  editUsed?: number;
}

/** 会话 token 缓存最多保留多少条（超过按 updatedAt 淘汰最旧的）。 */
const MAX_SESSION_ENTRIES = 200;

/**
 * 把 `updatedAt` 清洗成可信的毫秒时间戳。
 *
 * 为什么需要：实测某个会话条目里出现过 `updatedAt=134393759974646800`
 *（Windows FILETIME 的 100ns 计数，不是毫秒）。这类值在"按 updatedAt 升序淘汰最旧"
 * 的排序里巨大无比，等于**永远不会被淘汰**，缓存上限形同虚设。
 *
 * 规则保守：只把明显不是毫秒时间戳的值（负数、0、超过 2096 年的天文数字）换成当前时间；
 * 正常量级的值原样保留 —— 不擅自做单位换算，免得把调用方有意写的测试值改掉。
 */
function saneUpdatedAt(value: unknown): number {
  const n = num(value);
  if (n <= 0) return Date.now();
  if (n > 4e12) return Date.now(); // 4e12 ≈ 2096 年，超过它必然是坏值
  return Math.trunc(n);
}

/**
 * 宽容解析会话 token 缓存文件。
 *
 * 为什么要单独一个文件：`history_messages` 命中服务端缓存时返回**空** `chat_messages`
 * （实测常见），此时拿不到用量；但用户切回旧会话时仍应看到上次已知的用量，
 * 所以把每次观测到的值按会话 id 记下来，切回来直接读。
 */
/**
 * 判断磁盘上的会话缓存是否含「解析时被清洗过」的字段（v1.1.5 BUG-2）。
 *
 * 为什么需要：`parseSessionTokensFile` 会把坏 `updatedAt`（实测出现过 Windows FILETIME
 * 的 100ns 计数 `134393759974646800`，以及 0/负数）清洗成可信毫秒值。但清洗只发生在
 * **读取**路径；只要用户不重新观测该会话（切会话/重启都不重写），坏值就永久留在
 * `<账号>.sessions.json` 里，每次启动都要重复纠正。检测到「原始值 ≠ 清洗后值」就由
 * `loadSessions` 回写一次，磁盘自愈。
 *
 * 这是纯函数，便于单测（不碰文件系统）。
 */
export function sessionEntriesNeedRepair(
  raw: unknown,
  entries: Record<string, SessionTokenEntry>,
): boolean {
  if (!isRecord(raw)) return false;
  const rawEntries = raw['entries'];
  if (!isRecord(rawEntries)) return false;
  for (const [id, entry] of Object.entries(entries)) {
    const rawEntry = Object.prototype.hasOwnProperty.call(rawEntries, id)
      ? rawEntries[id]
      : null;
    if (!isRecord(rawEntry)) return true;
    const rawUpdatedAt = rawEntry['updatedAt'];
    // parse 对缺失/非数字/0/负数/>4e12 一律回落到 Date.now()；与清洗后不等就说明被修过
    if (
      typeof rawUpdatedAt !== 'number' ||
      !Number.isFinite(rawUpdatedAt) ||
      rawUpdatedAt !== entry.updatedAt
    ) {
      return true;
    }
  }
  // 反向：磁盘上有、解析后却不见的条目 —— 说明它无效（会话 id 非法 / tokens、次数三字段
  // 全缺），解析时已被丢弃。不回写它就会永久滞留（N19），所以也算需要修复。
  for (const id of Object.keys(rawEntries)) {
    // 用 hasOwn 而不是 `in`：`'__proto__' in {}` 恒为 true，会让这类残留条目永远不被清理（N33）。
    if (!Object.prototype.hasOwnProperty.call(entries, id)) return true;
  }
  return false;
}

export function parseSessionTokensFile(
  raw: unknown,
): { accountId: string; entries: Record<string, SessionTokenEntry> } | null {
  if (!isRecord(raw)) return null;
  const accountId = str(raw['accountId']);
  if (accountId === null || !isSafeAccountId(accountId)) return null;
  const entriesRaw = raw['entries'];
  if (!isRecord(entriesRaw)) return null;
  const entries: Record<string, SessionTokenEntry> = {};
  for (const [convId, value] of Object.entries(entriesRaw)) {
    if (!isSafeAccountId(convId) || !isRecord(value)) continue;
    const tokens = value['tokens'];
    const entry: SessionTokenEntry = { updatedAt: saneUpdatedAt(value['updatedAt']) };
    // 每个字段都独立可选：token 与已用次数来自不同接口，可能只有其一
    if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0) {
      entry.tokens = Math.trunc(tokens);
    }
    const regen = value['regenerateUsed'];
    if (typeof regen === 'number' && Number.isFinite(regen) && regen >= 0) {
      entry.regenerateUsed = Math.trunc(regen);
    }
    const edit = value['editUsed'];
    if (typeof edit === 'number' && Number.isFinite(edit) && edit >= 0) {
      entry.editUsed = Math.trunc(edit);
    }
    if (entry.tokens === undefined && entry.regenerateUsed === undefined && entry.editUsed === undefined) {
      continue;
    }
    entries[convId] = entry;
  }
  return { accountId, entries };
}

/** 宽容解析缓存文件：坏数据返回 null（调用方按"无缓存"处理）。 */
export function parseQuotaStateFile(raw: unknown): QuotaState | null {
  if (!isRecord(raw)) return null;
  const accountId = str(raw['accountId']);
  if (accountId === null || !isSafeAccountId(accountId)) return null;

  const configsRaw = raw['modelConfigs'];
  const modelConfigs: ModelQuotaConfig[] = [];
  if (Array.isArray(configsRaw)) {
    for (const item of configsRaw) {
      const cfg = parseModelConfig(item);
      if (cfg !== null) modelConfigs.push(cfg);
    }
  }

  return {
    accountId,
    updatedAt: num(raw['updatedAt']),
    chatStatus: parseChatStatus(raw['chatStatus']),
    modelConfigs,
  };
}

/* ------------------------------------------------------------ 存储 */

export interface QuotaStoreOptions {
  baseDir: string;
  logger?: { warn: (message: string) => void };
}

export class QuotaStore {
  private readonly opts: QuotaStoreOptions;
  /** 内存态：accountId → 最新快照 */
  private readonly byAccount = new Map<string, QuotaState>();
  /** 内存态：accountId → (会话 id → 已用 token) */
  private readonly sessionsByAccount = new Map<string, Record<string, SessionTokenEntry>>();
  /** 已排队自愈写盘的账号（N20：读路径不自接同步写，避免重复排队）。 */
  private readonly sessionsRepairQueued = new Set<string>();

  // 注意：不用 TS 的构造函数参数属性（strip-only 不支持）
  constructor(opts: QuotaStoreOptions) {
    this.opts = opts;
  }

  filePath(accountId: string): string {
    if (!isSafeAccountId(accountId)) throw new TypeError(`非法账号 id：${String(accountId)}`);
    return join(this.opts.baseDir, `${accountId}.json`);
  }

  /** 会话 token 缓存文件路径（与额度快照分开，避免频繁写大文件）。 */
  sessionFilePath(accountId: string): string {
    if (!isSafeAccountId(accountId)) throw new TypeError(`非法账号 id：${String(accountId)}`);
    return join(this.opts.baseDir, `${accountId}.sessions.json`);
  }

  /**
   * 读某会话上次观测到的已用 token。
   *
   * 用途：`history_messages` 命中服务端缓存时返回空消息列表（实测常见），
   * 此时切回该会话仍应显示上次已知的用量，而不是把输入栏那行还原成原文。
   */
  getSessionTokens(accountId: string, conversationId: string): number | null {
    if (!isSafeAccountId(accountId) || !isSafeAccountId(conversationId)) return null;
    const entries = this.loadSessions(accountId);
    return entries[conversationId]?.tokens ?? null;
  }

  /** 记录某会话的已用 token（只在数值变化时落盘，避免频繁写磁盘）。 */
  setSessionTokens(accountId: string, conversationId: string, tokens: number): void {
    if (!isSafeAccountId(accountId) || !isSafeAccountId(conversationId)) return;
    if (!Number.isFinite(tokens) || tokens < 0) return;
    const entries = this.loadSessions(accountId);
    const value = Math.trunc(tokens);
    const prev = entries[conversationId];
    if (prev !== undefined && prev.tokens === value) return;
    const next: SessionTokenEntry = {
      tokens: value,
      updatedAt: Date.now(),
    };
    if (prev?.regenerateUsed !== undefined) next.regenerateUsed = prev.regenerateUsed;
    if (prev?.editUsed !== undefined) next.editUsed = prev.editUsed;
    entries[conversationId] = next;
    this.sessionsByAccount.set(accountId, entries);
    this.saveSessions(accountId, entries);
  }

  /**
   * 读某会话上次观测到的已用次数。
   *
   * 为什么需要：操作次数只在内存里累加的话，重开应用就归零，
   * 用户会看到"明明用掉 3 次，重启后又变回满额"。
   */
  getSessionActions(
    accountId: string,
    conversationId: string,
  ): { regenerateUsed: number; editUsed: number } | null {
    if (!isSafeAccountId(accountId) || !isSafeAccountId(conversationId)) return null;
    const entries = this.loadSessions(accountId);
    const entry = entries[conversationId];
    if (entry === undefined) return null;
    if (entry.regenerateUsed === undefined && entry.editUsed === undefined) return null;
    return { regenerateUsed: entry.regenerateUsed ?? 0, editUsed: entry.editUsed ?? 0 };
  }

  /** 记录某会话的已用次数（与 token 共用一份会话缓存文件）。 */
  setSessionActions(
    accountId: string,
    conversationId: string,
    actions: { regenerateUsed: number; editUsed: number },
  ): void {
    if (!isSafeAccountId(accountId) || !isSafeAccountId(conversationId)) return;
    const regen = Math.max(0, Math.trunc(actions.regenerateUsed));
    const edit = Math.max(0, Math.trunc(actions.editUsed));
    if (!Number.isFinite(regen) || !Number.isFinite(edit)) return;
    const entries = this.loadSessions(accountId);
    const prev = entries[conversationId];
    if (prev !== undefined && prev.regenerateUsed === regen && prev.editUsed === edit) return;
    const next: SessionTokenEntry = {
      updatedAt: Date.now(),
      regenerateUsed: regen,
      editUsed: edit,
    };
    // token 是另一路观测来的，别用 0 覆盖掉已知值
    if (prev?.tokens !== undefined) next.tokens = prev.tokens;
    entries[conversationId] = next;
    this.sessionsByAccount.set(accountId, entries);
    this.saveSessions(accountId, entries);
  }

  /** 取快照：先内存、再磁盘（磁盘命中会回填内存）。都没有返回 null。 */
  get(accountId: string): QuotaState | null {
    const cached = this.byAccount.get(accountId);
    if (cached !== undefined) return cached;
    const loaded = this.load(accountId);
    if (loaded !== null) this.byAccount.set(accountId, loaded);
    return loaded;
  }

  /** 只更新 chat/status 部分（保留已有的 model_configs）。 */
  applyChatStatus(accountId: string, chatStatus: ChatStatus): QuotaState {
    const prev = this.get(accountId);
    const next: QuotaState = {
      accountId,
      updatedAt: Date.now(),
      chatStatus,
      modelConfigs: prev?.modelConfigs ?? [],
    };
    this.byAccount.set(accountId, next);
    this.save(next);
    return next;
  }

  /** 只更新 model_configs 部分（保留已有的 chat/status）。 */
  applyModelConfigs(accountId: string, modelConfigs: ModelQuotaConfig[]): QuotaState {
    const prev = this.get(accountId);
    const next: QuotaState = {
      accountId,
      updatedAt: Date.now(),
      chatStatus: prev?.chatStatus ?? null,
      modelConfigs,
    };
    this.byAccount.set(accountId, next);
    this.save(next);
    return next;
  }

  /** 清空某账号的缓存（删除账号时调用）。 */
  remove(accountId: string): void {
    this.byAccount.delete(accountId);
    this.sessionsByAccount.delete(accountId);
    // 必须**真删文件**，不能写成空文件：空文件下次 `JSON.parse('')` 会抛错，
    // 结果是把"用户已经删掉的账号"报成"缓存损坏"，看着像 bug。
    for (const file of [this.filePath(accountId), this.sessionFilePath(accountId)]) {
      try {
        rmSync(file, { force: true });
      } catch {
        /* 忽略：缓存残留不影响功能 */
      }
    }
  }

  /**
   * 清空**所有账号**的额度缓存（托盘「清除本地归档数据…」一并调用）。
   *
   * 之前只清 `mirror/`，额度缓存留着 —— 用户的预期是"清除本地数据"就该连这些都清掉。
   * 返回删掉的文件数，供日志/提示文案用。
   */
  clearAll(): number {
    this.byAccount.clear();
    this.sessionsByAccount.clear();
    let removed = 0;
    const dir = this.opts.baseDir;
    try {
      if (!existsSync(dir)) return 0;
      for (const name of readdirSync(dir)) {
        /**
         * 只删**本模块自己写的**文件，判据是「文件内容自证」：
         * 解开 JSON 后必须有 `accountId` 字段，且等于文件名主体
         *（`<accountId>.json` 或 `<accountId>.sessions.json`）。
         *
         * 为什么不只看文件名：光靠 `isSafeAccountId` 不够 —— `account.json`、`unrelated.json`
         * 的主体都是合法 id 形态，`baseDir` 一旦被配错（比如指到 userData 根目录），
         * 就会把账号配置一起删掉。内容自证能区分"我们写的"和"别人写的"。
         */
        const bare = name.endsWith('.sessions.json')
          ? name.slice(0, -'.sessions.json'.length)
          : name.endsWith('.json')
            ? name.slice(0, -'.json'.length)
            : null;
        if (bare === null || !isSafeAccountId(bare)) continue;
        const file = join(dir, name);
        let selfOwned = false;
        try {
          const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
          selfOwned = isRecord(parsed) && str(parsed['accountId']) === bare;
        } catch {
          // 读不动 / 解不开：不是我们认识的文件，留着更安全
          selfOwned = false;
        }
        if (!selfOwned) continue;
        try {
          rmSync(file, { force: true });
          removed += 1;
        } catch {
          /* 单个失败不影响其余 */
        }
      }
    } catch {
      /* 目录读不到就当没有 */
    }
    return removed;
  }

  /* ---------------------------------------------------------- 内部 */

  /** 读会话 token 缓存（内存优先，磁盘回填）。坏数据当作空。 */
  private loadSessions(accountId: string): Record<string, SessionTokenEntry> {
    const cached = this.sessionsByAccount.get(accountId);
    if (cached !== undefined) return cached;
    const empty: Record<string, SessionTokenEntry> = {};
    if (!isSafeAccountId(accountId)) return empty;
    const file = this.sessionFilePath(accountId);
    if (!existsSync(file)) {
      this.sessionsByAccount.set(accountId, empty);
      return empty;
    }
    try {
      const raw = readJsonText(file);
      const parsed = parseSessionTokensFile(raw);
      if (parsed === null || parsed.accountId !== accountId) {
        this.sessionsByAccount.set(accountId, empty);
        return empty;
      }
      this.sessionsByAccount.set(accountId, parsed.entries);
      // v1.1.5 BUG-2：读到坏 updatedAt 时 parse 已清洗，但磁盘上的坏值不会自己消失
      //（切会话/重启都不重写）。这里回写一次，让缓存文件自愈，避免每次启动重复纠正。
      //
      // N20：读路径可能被导航回调等热路径同步调用，这里不做同步磁盘 I/O ——
      // 把自愈写盘排到当前调用栈之后（同一账号只排一次）。写的是内存里的最新 entries，
      // 不会覆盖期间 setSessionTokens/setSessionActions 刚写入的值。
      if (sessionEntriesNeedRepair(raw, parsed.entries) && !this.sessionsRepairQueued.has(accountId)) {
        this.sessionsRepairQueued.add(accountId);
        setImmediate(() => {
          this.sessionsRepairQueued.delete(accountId);
          this.saveSessions(accountId, this.sessionsByAccount.get(accountId) ?? parsed.entries);
        });
      }
      return parsed.entries;
    } catch (e) {
      this.opts.logger?.warn(
        `读取会话 token 缓存失败（${accountId}）：${String((e as Error)?.message ?? e)}`,
      );
      this.sessionsByAccount.set(accountId, empty);
      return empty;
    }
  }

  /** 原子写会话 token 缓存；超过上限按 updatedAt 淘汰最旧的。失败只告警。 */
  private saveSessions(accountId: string, entries: Record<string, SessionTokenEntry>): void {
    try {
      const keys = Object.keys(entries);
      if (keys.length > MAX_SESSION_ENTRIES) {
        const sorted = keys.sort((a, b) => (entries[a]?.updatedAt ?? 0) - (entries[b]?.updatedAt ?? 0));
        for (const key of sorted.slice(0, keys.length - MAX_SESSION_ENTRIES)) delete entries[key];
      }
      const file = this.sessionFilePath(accountId);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify({ accountId, entries }, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
    } catch (e) {
      this.opts.logger?.warn(`写入会话 token 缓存失败：${String((e as Error)?.message ?? e)}`);
    }
  }

  private load(accountId: string): QuotaState | null {
    if (!isSafeAccountId(accountId)) return null;
    const file = this.filePath(accountId);
    if (!existsSync(file)) return null;
    try {
      const parsed = parseQuotaStateFile(readJsonText(file));
      if (parsed === null) return null;
      // 文件里的 accountId 必须与文件名一致 —— 否则说明文件被换过/拷错，
      // 用它会让 A 账号的额度显示在 B 账号名下（宁可当作无缓存）。
      if (parsed.accountId !== accountId) {
        this.opts.logger?.warn(
          `额度缓存归属不符（文件 ${accountId}.json 里写着 ${parsed.accountId}），已忽略`,
        );
        return null;
      }
      return parsed;
    } catch (e) {
      this.opts.logger?.warn(`读取额度缓存失败（${accountId}）：${String((e as Error)?.message ?? e)}`);
      return null;
    }
  }

  /** 原子写：先写临时文件再 rename（读方永远看不到半个文件）。失败只告警。 */
  private save(state: QuotaState): void {
    try {
      const file = this.filePath(state.accountId);
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      renameSync(tmp, file);
    } catch (e) {
      this.opts.logger?.warn(`写入额度缓存失败：${String((e as Error)?.message ?? e)}`);
    }
  }
}
