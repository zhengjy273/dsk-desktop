/**
 * M1 · T3：镜像落盘格式的**版本化迁移**骨架（PLAN §4.4，参照 DSH 会话日志 v0→v4 的做法）。
 *
 * 约定：
 *  - `MIRROR_SCHEMA_VERSION`（`src/shared/mirror-schema.ts`）是**当前**版本，本模块不重复定义；
 *  - 迁移链形如 `v0 → v1 → v2`，每一步只负责相邻版本的字段改写，最后统一过 `isConversationMirror` 校验；
 *  - **不静默丢数据**：每一步的丢弃（例如某条消息缺 `aiGenerated`）都会生成一条 `MigrationNote`，
 *    调用方可以把它写进 diagnostics；返回 `null` 表示"拒绝"，绝不返回"看起来正常但内容被削掉一半"的结果。
 *
 * 无版本号（`v0` 之前的实验格式）的处理选择：
 *  - 只在**字段能唯一对应**时才升级（`messageId→id`、`content→text`、`timestamp→createdAt`、
 *    秒级时间戳→毫秒、`ai: true → aiGenerated: true`、缺失的 `source/fidelity` 补安全默认值）；
 *  - 无法唯一对应（例如既没有 `text` 也没有 `content`）→ **拒绝**，并给出原因。
 */

import type { ConversationMirror, MirrorMessage } from '../../shared/ipc-contract.ts';
import { MIRROR_SCHEMA_VERSION, isConversationMirror, isMirrorMessage } from '../../shared/mirror-schema.ts';

export const LEGACY_VERSION = 0;
export const CURRENT_VERSION = MIRROR_SCHEMA_VERSION;

export interface MigrationNote {
  level: 'info' | 'warn';
  code:
    | 'assumed-legacy'
    | 'upgraded'
    | 'rejected'
    | 'dropped-message'
    | 'filled-default'
    | 'envelope-unwrapped'
    | 'future-version';
  message: string;
}

export interface MigrationResult {
  conversation: ConversationMirror | null;
  /** 原始版本（`0` 代表无版本号的实验格式）。 */
  fromVersion: number;
  toVersion: number;
  notes: MigrationNote[];
}

/** 单个迁移器：`migrate(raw, notes)` 返回下一版的原始对象；返回 `null` 表示拒绝。 */
export interface Migration {
  from: number;
  to: number;
  description: string;
  migrate(raw: Record<string, unknown>, notes: MigrationNote[]): Record<string, unknown> | null;
}

/** 允许出现在路径/索引里的字符集之外的内容一律不进管道（防御性，与 store 的路径规则一致）。 */
const MAX_MESSAGES = 20000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function note(
  notes: MigrationNote[],
  level: MigrationNote['level'],
  code: MigrationNote['code'],
  message: string,
): void {
  notes.push({ level, code, message });
}

/** 秒级时间戳 → 毫秒（仅当明显小于 1e12 时判定为秒）。 */
export function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 0 && value < 1e12 ? Math.round(value * 1000) : value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return normalizeTimestamp(asNumber);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** 逐条规范化消息；返回 `null` 表示这一条无法安全升级。 */
export function normalizeLegacyMessage(raw: unknown): { message: MirrorMessage | null; reason?: string } {
  if (!isRecord(raw)) return { message: null, reason: '不是对象' };

  const idRaw = raw['id'] ?? raw['messageId'] ?? raw['msgId'];
  const textRaw = raw['text'] ?? raw['content'] ?? raw['markdown'];
  const createdAtRaw = raw['createdAt'] ?? raw['timestamp'] ?? raw['time'] ?? raw['ts'];
  const roleRaw = raw['role'] ?? raw['author'];
  const reasoningRaw = raw['reasoning'] ?? raw['thinking'] ?? raw['reasoningContent'];
  const citationsRaw = raw['citations'] ?? raw['references'] ?? raw['sources'];
  const attachmentsRaw = raw['attachments'] ?? raw['files'];
  // R3 / DD-15：消息里的 AI 生成属性只接受"显式为真"，其余一律不认（宁可拒绝，不可无标注入库）。
  const aiRaw = raw['aiGenerated'] ?? raw['ai'] ?? raw['ai_generated'];

  if (typeof idRaw !== 'string' || idRaw.length === 0) return { message: null, reason: '缺少可用 id' };
  if (typeof textRaw !== 'string') return { message: null, reason: '缺少可用 text/content' };
  if (roleRaw !== 'user' && roleRaw !== 'assistant') return { message: null, reason: `role 非法：${String(roleRaw)}` };
  const createdAt = normalizeTimestamp(createdAtRaw);
  if (createdAt === null) return { message: null, reason: 'createdAt 不可解析' };
  if (aiRaw !== true) return { message: null, reason: 'aiGenerated 不为 true（R3 拒绝无标注数据）' };
  if (reasoningRaw !== undefined && typeof reasoningRaw !== 'string') {
    return { message: null, reason: 'reasoning 类型非法' };
  }

  const message: MirrorMessage = {
    id: idRaw,
    role: roleRaw,
    text: textRaw,
    createdAt,
    aiGenerated: true,
  };
  if (typeof reasoningRaw === 'string' && reasoningRaw.length > 0) message.reasoning = reasoningRaw;
  if (Array.isArray(citationsRaw)) {
    const citations: { title: string; url: string }[] = [];
    for (const item of citationsRaw) {
      if (!isRecord(item)) continue;
      const url = item['url'];
      if (typeof url !== 'string' || !url.startsWith('https://')) continue;
      const title = item['title'] ?? item['name'] ?? url;
      citations.push({ title: typeof title === 'string' && title.length > 0 ? title : url, url });
    }
    if (citations.length > 0) message.citations = citations;
  }
  if (Array.isArray(attachmentsRaw)) {
    const attachments: { name: string; size: number }[] = [];
    for (const item of attachmentsRaw) {
      if (!isRecord(item)) continue;
      const name = item['name'];
      const size = item['size'];
      if (typeof name !== 'string' || typeof size !== 'number' || !Number.isFinite(size)) continue;
      attachments.push({ name, size });
    }
    if (attachments.length > 0) message.attachments = attachments;
  }

  return isMirrorMessage(message) ? { message } : { message: null, reason: '规范化后仍未通过校验' };
}

/** v0 → v1：把 M0 实验期的字段名统一到当前契约。 */
const migrationV0toV1: Migration = {
  from: LEGACY_VERSION,
  to: 1,
  description: 'M0 实验格式 → v1：字段改名、秒级时间戳归一化、缺失元数据补默认值、逐条过滤非法消息',
  migrate(raw, notes) {
    const messagesRaw = Array.isArray(raw['messages']) ? raw['messages'] : null;
    if (!messagesRaw) {
      note(notes, 'warn', 'rejected', 'v0 对象缺少 messages 数组，拒绝迁移');
      return null;
    }
    if (messagesRaw.length > MAX_MESSAGES) {
      note(notes, 'warn', 'rejected', `messages 数量异常（${messagesRaw.length}），拒绝迁移`);
      return null;
    }

    const messages: MirrorMessage[] = [];
    for (const item of messagesRaw) {
      const { message, reason } = normalizeLegacyMessage(item);
      if (message) messages.push(message);
      else note(notes, 'warn', 'dropped-message', `丢弃一条无法安全升级的消息：${reason ?? '未知原因'}`);
    }

    const urlRaw = raw['url'] ?? raw['href'];
    const url = typeof urlRaw === 'string' && urlRaw.startsWith('https://') ? urlRaw : 'https://chat.deepseek.com/';
    if (url !== urlRaw) note(notes, 'warn', 'filled-default', 'url 缺失或非 https，已补站点默认值');

    const idRaw = raw['id'] ?? raw['conversationId'] ?? raw['chatId'];
    if (typeof idRaw !== 'string' || idRaw.length === 0) {
      note(notes, 'warn', 'rejected', 'v0 对象缺少会话 id，拒绝迁移');
      return null;
    }

    const titleRaw = raw['title'] ?? raw['name'];
    const accountRaw = raw['accountId'] ?? raw['account'];
    const sourceRaw = raw['source'];
    const fidelityRaw = raw['fidelity'];
    const updatedAtRaw = raw['updatedAt'] ?? raw['updated_at'] ?? raw['time'];

    const updatedAt = normalizeTimestamp(updatedAtRaw) ?? (messages.length > 0 ? (messages[messages.length - 1]?.createdAt ?? Date.now()) : Date.now());
    if (updatedAtRaw === undefined) note(notes, 'warn', 'filled-default', 'updatedAt 缺失，已按最后一条消息推断');

    if (sourceRaw !== 'network' && sourceRaw !== 'dom') {
      note(notes, 'warn', 'filled-default', `source 非法或缺失（${String(sourceRaw)}），按兜底通道 dom 处理`);
    }
    if (fidelityRaw !== 'partial' && fidelityRaw !== 'full') {
      note(notes, 'warn', 'filled-default', `fidelity 非法或缺失（${String(fidelityRaw)}），按 partial 处理`);
    }

    note(
      notes,
      'info',
      'upgraded',
      `v0 → v1：保留 ${messages.length} 条消息，丢弃 ${messagesRaw.length - messages.length} 条`,
    );

    return {
      id: idRaw,
      accountId: typeof accountRaw === 'string' && accountRaw.length > 0 ? accountRaw : 'personal',
      title: typeof titleRaw === 'string' && titleRaw.length > 0 ? titleRaw : `会话 ${idRaw}`,
      url,
      updatedAt,
      messages,
      source: sourceRaw === 'network' ? 'network' : 'dom',
      fidelity: fidelityRaw === 'full' ? 'full' : 'partial',
    };
  },
};

/** 迁移链：新增版本时在末尾追加一项，并保持 `from/to` 连续。 */
export const MIGRATIONS: readonly Migration[] = [migrationV0toV1];

function migrationFor(version: number): Migration | null {
  return MIGRATIONS.find((m) => m.from === version) ?? null;
}

/** 判定版本：优先 `schemaVersion`，兼容 `version` / `v` 字段；没有版本号视为 v0。 */
export function detectVersion(raw: unknown): { version: number; explicit: boolean } {
  if (!isRecord(raw)) return { version: LEGACY_VERSION, explicit: false };
  for (const key of ['schemaVersion', 'schema_version', 'version', 'v'] as const) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      return { version: value, explicit: true };
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      return { version: Number(value), explicit: true };
    }
  }
  return { version: LEGACY_VERSION, explicit: false };
}

/** 拆信封：`{ schemaVersion, conversation }` 形式的导出产物 → 内层会话对象。 */
function unwrap(raw: Record<string, unknown>, notes: MigrationNote[]): Record<string, unknown> {
  const inner = raw['conversation'] ?? raw['mirror'] ?? raw['data'];
  if (isRecord(inner) && inner['messages'] !== undefined) {
    note(notes, 'info', 'envelope-unwrapped', '检测到导出信封，已取内层 conversation 字段');
    return inner;
  }
  return raw;
}

/**
 * 把"任意来源的原始对象"（旧版本本地文件、导出的 JSON）迁移到当前版本。
 *
 * - 合法当前版本 → 原样通过；
 * - 旧版本 / 无版本号 → 逐级迁移（丢弃的每条数据都有 note）；
 * - 未来版本（大于 `CURRENT_VERSION`）→ **拒绝**（不能假装读懂了新格式，也绝不静默降级改写）；
 * - 无法安全升级 → 返回 `null`，并把原因写进 notes。
 *
 * 需要观测 notes 时用带 out 参数的重载形式；只关心结果时用 `migrate(raw)`。
 */
export function migrate(raw: unknown, out?: MigrationNote[]): ConversationMirror | null {
  return migrateDetailed(raw, out).conversation;
}

export function migrateDetailed(raw: unknown, out?: MigrationNote[]): MigrationResult {
  const notes: MigrationNote[] = [];
  const result = run(raw, notes);
  if (out) out.push(...notes);
  return { ...result, notes };
}

function run(raw: unknown, notes: MigrationNote[]): Omit<MigrationResult, 'notes'> {
  if (!isRecord(raw)) {
    note(notes, 'warn', 'rejected', '输入不是对象，拒绝迁移');
    return { conversation: null, fromVersion: LEGACY_VERSION, toVersion: CURRENT_VERSION };
  }

  const { version, explicit } = detectVersion(raw);
  const body = unwrap(raw, notes);

  if (version > CURRENT_VERSION) {
    note(
      notes,
      'warn',
      'future-version',
      `数据版本 v${version} 高于当前支持的 v${CURRENT_VERSION}，拒绝读取（请升级应用，勿用旧版本覆盖写入）`,
    );
    return { conversation: null, fromVersion: version, toVersion: CURRENT_VERSION };
  }

  if (version === CURRENT_VERSION && explicit) {
    if (isConversationMirror(body)) {
      note(notes, 'info', 'upgraded', `已是当前版本 v${CURRENT_VERSION}，无需迁移`);
      return { conversation: body, fromVersion: version, toVersion: CURRENT_VERSION };
    }
    note(notes, 'warn', 'assumed-legacy', `声明为 v${CURRENT_VERSION} 但未通过校验，按 v0 实验格式再试一次`);
    const fallback = migrationFor(LEGACY_VERSION);
    if (!fallback) {
      return { conversation: null, fromVersion: version, toVersion: CURRENT_VERSION };
    }
    const migrated = fallback.migrate(body, notes);
    const conversation = migrated && isConversationMirror(migrated) ? migrated : null;
    if (!conversation) note(notes, 'warn', 'rejected', '按 v0 重试仍失败，拒绝迁移');
    return { conversation, fromVersion: LEGACY_VERSION, toVersion: CURRENT_VERSION };
  }

  if (version === CURRENT_VERSION && !explicit) {
    // 无版本号但结构就是当前版本：这是 M1 之前手写的对象，直接放行。
    if (isConversationMirror(body)) {
      note(notes, 'info', 'assumed-legacy', '缺少版本号，但结构符合当前版本，按当前版本接受');
      return { conversation: body, fromVersion: CURRENT_VERSION, toVersion: CURRENT_VERSION };
    }
    note(notes, 'warn', 'assumed-legacy', '缺少版本号且不符合当前版本，按 v0 实验格式迁移');
  } else {
    note(notes, 'warn', 'assumed-legacy', `检测到旧版本 v${version}，开始逐级迁移`);
  }

  let current = body;
  let cursor = LEGACY_VERSION;
  let guard = 0;
  while (cursor < CURRENT_VERSION) {
    guard += 1;
    if (guard > 64) {
      note(notes, 'warn', 'rejected', '迁移链疑似成环，拒绝继续');
      return { conversation: null, fromVersion: version, toVersion: CURRENT_VERSION };
    }
    const migration = migrationFor(cursor);
    if (!migration) {
      note(notes, 'warn', 'rejected', `缺少 v${cursor} → v${cursor + 1} 的迁移器，拒绝迁移`);
      return { conversation: null, fromVersion: version, toVersion: CURRENT_VERSION };
    }
    const next = migration.migrate(current, notes);
    if (!next) {
      note(notes, 'warn', 'rejected', `v${cursor} → v${migration.to} 迁移失败，拒绝迁移`);
      return { conversation: null, fromVersion: version, toVersion: CURRENT_VERSION };
    }
    current = next;
    cursor = migration.to;
  }

  if (!isConversationMirror(current)) {
    note(notes, 'warn', 'rejected', '迁移结果未通过 isConversationMirror 校验，拒绝返回');
    return { conversation: null, fromVersion: version, toVersion: CURRENT_VERSION };
  }
  return { conversation: current, fromVersion: version, toVersion: CURRENT_VERSION };
}

/** 便捷包装：为当前版本的数据打上显式版本号（导出用）。 */
export function withSchemaVersion(conversation: ConversationMirror): Record<string, unknown> {
  return { schemaVersion: CURRENT_VERSION, conversation };
}
