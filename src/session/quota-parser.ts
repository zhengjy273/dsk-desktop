/**
 * 限额数据解析 —— **纯函数**，便于单测（不接触网络、不接触 Electron）。
 *
 * 数据来源（2026-11-13 前端 bundle 逆向确认，见 docs/KNOWN-LIMITS.md）：
 *  - `GET /api/v0/chat/status`：模型额度状态、禁言状态、服务端文案；
 *  - `GET /api/v0/client/settings?scope=model`：`model_configs` 里的
 *    `regenerate_quota` / `edit_quota` / `input_character_limit`。
 *
 * 边界（R2「不逆向接口」）：
 *  - 本模块**只解析调用方递进来的响应文本**，不发起请求、不构造请求、不重放；
 *  - 调用方（NetworkMirror）走的是 Chromium 只读通道，观察页面自己已经产生的响应。
 *
 * 设计取舍：站点字段名可能 snake_case 也可能 camelCase，且 `entries` 的确切形状未定 ——
 * 因此一律**深度搜索**目标字段，宁可解析失败返回 null 也不猜错结构。
 *
 * 写作用域：`src/session/**`（T2）。
 */
import type { QuotaView } from '../shared/ipc-contract.ts';

/** 单个模型的额度状态（来自 chat/status）。 */
export interface ModelQuotaStatus {
  /** 站点模型标识；null 表示"未指明"（站点用它做默认额度） */
  modelType: string | null;
  isExhausted: boolean;
  /** 额度重置时间（毫秒；0 表示站点未给出） */
  resetAt: number;
  /** 服务端下发的额度文案（明文） */
  msg: string | null;
  /** 告警弹窗标题（明文） */
  alertTitle: string | null;
  /** 告警弹窗说明（明文） */
  alertDescription: string | null;
}

/** 账号级状态（来自 chat/status）。 */
export interface ChatStatus {
  /** 站点生成该状态的时间（毫秒） */
  generatedAt: number;
  isMuted: boolean;
  /** 禁言截止时间（毫秒；0 表示未给出） */
  muteUntil: number;
  /** 服务端下发的禁言文案（明文） */
  muteMsg: string | null;
  quotas: ModelQuotaStatus[];
}

/** 单个模型的可配置上限（来自 client/settings 的 model_configs）。 */
export interface ModelQuotaConfig {
  modelType: string | null;
  /** 展示名（站点下发；缺失时调用方回落 modelType） */
  name: string | null;
  enabled: boolean;
  /** 重新生成次数上限（null = 站点未给出，前端回落 5） */
  regenerateQuota: number | null;
  /** 修改输入次数上限（null = 站点未给出，前端回落 5） */
  editQuota: number | null;
  /** 单次输入字符上限（null = 未给出） */
  inputCharacterLimit: number | null;
  /** 附件 token 上限（未开深度思考时） */
  fileTokenLimit: number | null;
  /** 附件 token 上限（开深度思考时） */
  fileTokenLimitWithThinking: number | null;
}

/** 一个账号的完整限额快照。 */
export interface QuotaState {
  accountId: string;
  /** 本快照最后一次更新的时间（毫秒） */
  updatedAt: number;
  /** chat/status 最近一次成功解析的结果 */
  chatStatus: ChatStatus | null;
  /** model_configs 最近一次成功解析的结果 */
  modelConfigs: ModelQuotaConfig[];
}

/* ------------------------------------------------------------ 通用取值 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 秒级时间戳 → 毫秒；非法值返回 0（不抛错）。 */
export function toMillis(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return 0;
  // 站点用秒级时间戳（10 位）；> 1e12 视为已经是毫秒
  return n > 1e12 ? Math.trunc(n) : Math.trunc(n * 1000);
}

function pickString(rec: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

function pickNumber(rec: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function pickBool(rec: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === 'boolean') return v;
    if (v === 0 || v === 1) return v === 1;
  }
  return null;
}

/**
 * 取出业务数据体 `biz_data`。
 *
 * 站点统一包一层 `{code, data:{biz_code, biz_data}}`；宽容接受直接给 `biz_data` 的形态。
 * `code`/`biz_code` 非 0 视为失败（返回 null）—— 失败响应没有可展示的数据。
 */
export function pickBizData(parsed: unknown): unknown {
  if (!isRecord(parsed)) return null;

  const code = pickNumber(parsed, 'code');
  if (code !== null && code !== 0) return null;

  const data = parsed['data'];
  if (isRecord(data)) {
    const bizCode = pickNumber(data, 'biz_code', 'bizCode');
    if (bizCode !== null && bizCode !== 0) return null;
    if ('biz_data' in data) return data['biz_data'];
    if ('bizData' in data) return data['bizData'];
  }

  if ('biz_data' in parsed) return parsed['biz_data'];
  if ('bizData' in parsed) return parsed['bizData'];
  return null;
}

/** 安全 JSON 解析：坏文本返回 null，绝不抛错。 */
export function safeJsonParse(raw: string): unknown {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ chat/status */

/** 解析单个 quota 项（宽容）。 */
function parseQuotaItem(raw: unknown): ModelQuotaStatus | null {
  if (!isRecord(raw)) return null;

  const alert = isRecord(raw['alert']) ? raw['alert'] : null;
  const alertContent = alert !== null && isRecord(alert['content']) ? alert['content'] : null;

  const modelTypeRaw = raw['model_type'] ?? raw['modelType'];
  const modelType =
    typeof modelTypeRaw === 'string'
      ? modelTypeRaw
      : typeof modelTypeRaw === 'number'
        ? String(modelTypeRaw)
        : null;

  return {
    modelType,
    isExhausted: pickBool(raw, 'is_exhausted', 'isExhausted') ?? false,
    resetAt: toMillis(raw['reset_at'] ?? raw['resetAt']),
    msg: pickString(raw, 'msg'),
    alertTitle: alertContent !== null ? pickString(alertContent, 'title') : null,
    alertDescription: alertContent !== null ? pickString(alertContent, 'description') : null,
  };
}

/**
 * 解析 `GET /api/v0/chat/status` 的响应文本。
 *
 * 结构（前端归一化函数 `dR` 确认）：
 * ```
 * biz_data: {
 *   generated_at,
 *   mute: { mute_until, msg } | null,
 *   quotas: [{ model_type, is_exhausted, reset_at, msg, alert }]
 * }
 * ```
 */
export function parseChatStatusResponse(raw: string): ChatStatus | null {
  const bizData = pickBizData(safeJsonParse(raw));
  if (!isRecord(bizData)) return null;

  const mute = isRecord(bizData['mute']) ? bizData['mute'] : null;

  const quotasRaw = bizData['quotas'];
  const quotas: ModelQuotaStatus[] = [];
  if (Array.isArray(quotasRaw)) {
    for (const item of quotasRaw) {
      const q = parseQuotaItem(item);
      if (q !== null) quotas.push(q);
    }
  }

  return {
    generatedAt: toMillis(bizData['generated_at'] ?? bizData['generatedAt']),
    // 前端口径：`isMuted = e.mute != null` —— 有 mute 对象即视为禁言中
    isMuted: mute !== null,
    muteUntil: mute !== null ? toMillis(mute['mute_until'] ?? mute['muteUntil']) : 0,
    muteMsg: mute !== null ? pickString(mute, 'msg') : null,
    quotas,
  };
}

/* ------------------------------------------------- client/settings(scope=model) */

/** 判定一个对象是不是 model_configs 里的一项。 */
function looksLikeModelConfig(rec: Record<string, unknown>): boolean {
  const hasModelType = 'model_type' in rec || 'modelType' in rec;
  if (!hasModelType) return false;
  return (
    'input_character_limit' in rec ||
    'inputCharacterLimit' in rec ||
    'regenerate_quota' in rec ||
    'regenerateQuota' in rec ||
    'edit_quota' in rec ||
    'editQuota' in rec
  );
}

/** 递归收集 model_configs 项（entries 的确切形状未定，故深度搜索）。 */
function collectModelConfigs(value: unknown, out: ModelQuotaConfig[], depth = 0): void {
  if (depth > 12 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectModelConfigs(item, out, depth + 1);
    return;
  }
  const rec = value as Record<string, unknown>;

  if (looksLikeModelConfig(rec)) {
    const modelTypeRaw = rec['model_type'] ?? rec['modelType'];
    const modelType =
      typeof modelTypeRaw === 'string'
        ? modelTypeRaw
        : typeof modelTypeRaw === 'number'
          ? String(modelTypeRaw)
          : null;

    const fileFeature = isRecord(rec['file_feature'])
      ? rec['file_feature']
      : isRecord(rec['fileFeature'])
        ? rec['fileFeature']
        : null;

    out.push({
      modelType,
      name: pickString(rec, 'name', 'display_name', 'displayName'),
      enabled: pickBool(rec, 'enabled') ?? true,
      regenerateQuota: pickNumber(rec, 'regenerate_quota', 'regenerateQuota'),
      editQuota: pickNumber(rec, 'edit_quota', 'editQuota'),
      inputCharacterLimit: pickNumber(rec, 'input_character_limit', 'inputCharacterLimit'),
      fileTokenLimit: fileFeature !== null ? pickNumber(fileFeature, 'token_limit', 'tokenLimit') : null,
      fileTokenLimitWithThinking:
        fileFeature !== null
          ? pickNumber(fileFeature, 'token_limit_with_thinking', 'tokenLimitWithThinking')
          : null,
    });
    // 配置对象内部不再深入（避免把嵌套的 file_feature 重复计入）
    return;
  }

  for (const v of Object.values(rec)) collectModelConfigs(v, out, depth + 1);
}

/**
 * 解析 `GET /api/v0/client/settings?scope=model` 的响应文本。
 *
 * 前端从 `getLatestFeature("model_configs")` 取值，缓存键为
 * localStorage `__ds_remote_feature_store_model`；响应体形状为 `{entries, version, fetchAfterSec}`，
 * 但 `entries` 的具体结构未在 bundle 里固定 —— 因此这里**深度搜索**含
 * `model_type` + 上限字段的对象。
 *
 * 解析不到任何配置返回 null（调用方保留上一次的值，不覆盖成空）。
 */
export function parseModelSettingsResponse(raw: string): ModelQuotaConfig[] | null {
  const bizData = pickBizData(safeJsonParse(raw));
  if (bizData === null) return null;

  const found: ModelQuotaConfig[] = [];
  collectModelConfigs(bizData, found);
  if (found.length === 0) return null;

  // 按 modelType 去重（同一次响应里可能重复出现同一模型）
  const byType = new Map<string, ModelQuotaConfig>();
  for (const cfg of found) {
    const key = cfg.modelType ?? '';
    const prev = byType.get(key);
    // 保留字段更完整的那一份
    if (prev === undefined || scoreConfig(cfg) > scoreConfig(prev)) byType.set(key, cfg);
  }
  return [...byType.values()];
}

function scoreConfig(cfg: ModelQuotaConfig): number {
  let n = 0;
  if (cfg.regenerateQuota !== null) n += 1;
  if (cfg.editQuota !== null) n += 1;
  if (cfg.inputCharacterLimit !== null) n += 1;
  if (cfg.name !== null) n += 1;
  return n;
}

/* ------------------------------------------------------------ 摘要与展示 */

/** 按 modelType 找配置；找不到时回落"第一个启用的配置"。 */
export function findConfig(
  configs: readonly ModelQuotaConfig[],
  modelType: string | null,
): ModelQuotaConfig | null {
  if (configs.length === 0) return null;
  if (modelType !== null) {
    const hit = configs.find((c) => c.modelType === modelType);
    if (hit !== undefined) return hit;
  }
  return configs.find((c) => c.enabled) ?? configs[0] ?? null;
}

/** 模型的展示名（站点名 → modelType → 「默认模型」）。 */
export function configLabel(cfg: ModelQuotaConfig | null): string {
  if (cfg === null) return '默认模型';
  if (cfg.name !== null && cfg.name.trim() !== '') return cfg.name;
  if (cfg.modelType !== null && cfg.modelType !== '') return cfg.modelType;
  return '默认模型';
}

/** 把毫秒时间格式化为「HH:MM」；无效返回空串。 */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * 额度状态的一句话摘要（托盘 tooltip / 菜单用）。
 *
 * 口径：站点**没有**下发"剩余量/总量"，只有 `is_exhausted` + `reset_at`；
 * 因此这里如实表达"正常 / 已耗尽（HH:MM 重置）"，绝不编造百分比。
 */
export function describeQuotaStatus(status: ChatStatus | null): string {
  if (status === null) return '额度未知';
  if (status.isMuted) {
    const until = formatClock(status.muteUntil);
    return until === '' ? '已禁言' : `已禁言至 ${until}`;
  }
  const exhausted = status.quotas.filter((q) => q.isExhausted);
  if (exhausted.length === 0) return '额度正常';
  const parts = exhausted.map((q) => {
    const at = formatClock(q.resetAt);
    const label = q.modelType ?? '默认';
    return at === '' ? `${label} 已耗尽` : `${label} 已耗尽（${at} 重置）`;
  });
  return parts.join('；');
}

/** 额度耗尽的模型名列表（浮层里高亮用）。 */
export function exhaustedModelTypes(status: ChatStatus | null): string[] {
  if (status === null) return [];
  return status.quotas.filter((q) => q.isExhausted).map((q) => q.modelType ?? '');
}

/** 当前可展示的服务端文案（禁言文案 + 各模型额度文案 + 告警标题/说明），去空去重。 */
export function collectServerMessages(status: ChatStatus | null): string[] {
  if (status === null) return [];
  const out: string[] = [];
  const push = (s: string | null): void => {
    if (s === null || s.trim() === '') return;
    if (!out.includes(s)) out.push(s);
  };
  push(status.muteMsg);
  for (const q of status.quotas) {
    push(q.msg);
    push(q.alertTitle);
    push(q.alertDescription);
  }
  return out;
}

/**
 * 格式化「重新生成 / 修改输入」次数行。
 *
 * 口径（2026-11-17 用户实测后调整）：优先显示**剩余 / 上限**。
 * 已用次数来自 history 的分支关系，以及本程序观测到的 regenerate/edit_message 请求；
 * 没有任何已用次数观测时才退回旧版「上限值」文案，绝不把未知当成 0。
 */
export function formatRegenerateLimits(
  cfg: ModelQuotaConfig | null,
  usage?: { regenerateUsed?: number | null; editUsed?: number | null },
): string {
  const fallback = 5;
  const regen = Math.max(0, Math.trunc(cfg?.regenerateQuota ?? fallback));
  const edit = Math.max(0, Math.trunc(cfg?.editQuota ?? fallback));
  const regenUsed = usage?.regenerateUsed;
  const editUsed = usage?.editUsed;
  if (regenUsed === null || regenUsed === undefined || editUsed === null || editUsed === undefined) {
    return `重新生成上限 ${regen} 次 · 修改上限 ${edit} 次`;
  }
  const regenLeft = Math.max(0, regen - Math.max(0, Math.trunc(regenUsed)));
  const editLeft = Math.max(0, edit - Math.max(0, Math.trunc(editUsed)));
  return `重新生成剩余 ${regenLeft}/${regen} 次 · 修改剩余 ${editLeft}/${edit} 次`;
}

/* ------------------------------------------------------ 修改/重新生成已用次数 */

export interface ActionUsage {
  regenerateUsed: number;
  editUsed: number;
}

function actionKind(url: string): keyof ActionUsage | null {
  if (url.includes('/chat/regenerate')) return 'regenerateUsed';
  if (url.includes('/chat/edit_message')) return 'editUsed';
  return null;
}

/** 从页面自身发出的请求 URL 判断操作类型；不匹配返回 null。 */
export function classifyQuotaAction(url: string): 'regenerate' | 'edit' | null {
  const kind = actionKind(url);
  return kind === 'regenerateUsed' ? 'regenerate' : kind === 'editUsed' ? 'edit' : null;
}

/**
 * 从历史消息的分支关系统计已用次数。
 *
 * 前端 `u1` 的真实口径：`分支兄弟数 - 1`，不是简单数 assistant 消息。
 * - 同一 parent 下多条 assistant = 该用户消息的重新生成分支；
 * - 同一 parent 下多条 user = 上一条回答的修改输入分支。
 * 无法识别 parent/message id 时返回 null（调用方保留运行期计数）。
 */
export function parseHistoryActionUsage(raw: string): ActionUsage | null {
  const bizData = pickBizData(safeJsonParse(raw));
  if (!isRecord(bizData)) return null;
  const messages = bizData['chat_messages'] ?? bizData['chatMessages'];
  if (!Array.isArray(messages) || messages.length === 0) return null;

  type Item = { id: string; parent: string; role: string };
  const items: Item[] = [];
  for (const entry of messages) {
    if (!isRecord(entry)) continue;
    const id = pickString(entry, 'message_id', 'messageId', 'id');
    const parent = pickString(entry, 'parent_id', 'parentId');
    const role = pickString(entry, 'role', 'message_role', 'messageRole');
    if (id !== null && parent !== null && role !== null) items.push({ id, parent, role });
  }
  if (items.length === 0) return null;

  const groups = new Map<string, Item[]>();
  for (const item of items) {
    const list = groups.get(item.parent) ?? [];
    list.push(item);
    groups.set(item.parent, list);
  }
  // 找当前叶子的父链：优先最后一条 assistant，再退回最后一条消息。
  const byId = new Map(items.map((item) => [item.id, item]));
  let current = [...items].reverse().find((item) => item.role.toLowerCase() === 'assistant') ?? items[items.length - 1];
  if (!current) return null;
  let regenerateUsed = 0;
  let editUsed = 0;
  const visited = new Set<string>();
  for (let depth = 0; depth < 1000; depth += 1) {
    if (visited.has(current.id)) break;
    visited.add(current.id);
    const role = current.role.toLowerCase();
    const siblings = groups.get(current.parent) ?? [];
    const sameRole = siblings.filter((item) => item.role.toLowerCase() === role);
    const used = Math.max(0, sameRole.length - 1);
    if (role === 'assistant') regenerateUsed = Math.max(regenerateUsed, used);
    if (role === 'user') editUsed = Math.max(editUsed, used);
    const parent = byId.get(current.parent);
    if (!parent) break;
    current = parent;
  }
  return { regenerateUsed, editUsed };
}

/** 单次输入上限的一行文案（未下发时返回 null，调用方不展示）。 */
export function formatInputLimit(cfg: ModelQuotaConfig | null): string | null {
  const limit = cfg?.inputCharacterLimit ?? null;
  if (limit === null || !Number.isFinite(limit) || limit <= 0) return null;
  return `单次输入上限 ${limit.toLocaleString('zh-CN')} 字`;
}

/* ------------------------------------------------------ 会话累计 token（history） */

/**
 * 递归取 `accumulated_token_usage` 的最大值。
 *
 * 为什么取最大值：站点该字段是**累计值**（单调递增），历史消息数组里每条都带它；
 * 最大值即该会话最新的累计用量。中途字段缺失/为 0 都不会把结果拉低。
 *
 * 同时识别两种写法：快照键名 `accumulated_token_usage: N` 与
 * 路径补丁 `{"p":"accumulated_token_usage","v":N}`（SSE 终帧用的就是后者，
 * 早期只认前者导致读到的永远是流式过程中的 0）。
 */
export function maxAccumulatedTokens(value: unknown, depth = 0): number | null {
  if (depth > 12 || value === null || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    let best: number | null = null;
    for (const item of value) {
      const n = maxAccumulatedTokens(item, depth + 1);
      if (n !== null && (best === null || n > best)) best = n;
    }
    return best;
  }
  const rec = value as Record<string, unknown>;
  let best: number | null = null;
  if (isTokenField(rec.p) && typeof rec.v === 'number') {
    const n = rec.v;
    if (Number.isFinite(n) && n >= 0) best = n;
  }
  for (const [key, v] of Object.entries(rec)) {
    if (isTokenField(key) && typeof v === 'number') {
      if (Number.isFinite(v) && v >= 0 && (best === null || v > best)) best = v;
      continue;
    }
    const n = maxAccumulatedTokens(v, depth + 1);
    if (n !== null && (best === null || n > best)) best = n;
  }
  return best;
}

/** 累计 token 用量的字段名（快照键名 / 补丁帧路径名）。 */
function isTokenField(name: unknown): boolean {
  return name === 'accumulated_token_usage' || name === 'accumulatedTokenUsage';
}

/**
 * 解析 `GET /api/v0/chat/history_messages` 的响应，取该会话的累计已用 token。
 *
 * 用途：**切换会话时**同步已用量 —— 单靠 SSE 只能拿到"本轮结束时"的值，
 * 打开一个已有会话时没有 SSE，必须从历史接口补。
 * 解析不到返回 null（调用方保留原值，不显示 0）。
 */
export function parseHistoryAccumulatedTokens(raw: string): number | null {
  const bizData = pickBizData(safeJsonParse(raw));
  if (bizData === null) return null;
  return maxAccumulatedTokens(bizData);
}

/**
 * 解析 `GET /api/v0/chat/history_messages` 响应里的会话 id（`biz_data.chat_session.id`）。
 *
 * 用途：history 是**异步**响应 —— 用户切走会话后，上一会话的响应才到达。只比"当前页面 URL"
 * 不够（两条请求交叉时页面已经换了），响应体自带的会话 id 才是权威归属。
 *
 * 解析不到返回 null（调用方退回 URL 比对，保持旧行为）。
 */
/** 响应是否带失败码（`code`/`data.biz_code` 非 0）。失败响应不应提供归属依据。 */
function hasFailedCode(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  const code = pickNumber(parsed, 'code');
  if (code !== null && code !== 0) return true;
  const data = parsed['data'];
  if (isRecord(data)) {
    const bizCode = pickNumber(data, 'biz_code', 'bizCode');
    if (bizCode !== null && bizCode !== 0) return true;
  }
  return false;
}

export function parseHistorySessionId(raw: string): string | null {
  const parsed = safeJsonParse(raw);
  const bizData = pickBizData(parsed);
  // 常规形态：`{data:{biz_code:0,biz_data:{chat_session:{…}}}}`。
  const wrapped =
    isRecord(bizData) && isRecord(bizData['chat_session']) ? bizData['chat_session'] : null;
  // 缓存命中时站点直接返回**顶层** `{chat_session:{…}, chat_messages:[], cache_control:"MERGE"}`
  //（KNOWN-LIMITS.md:136），没有 biz_data 包装 —— 而缓存命中恰恰是最需要归属判定的场景（N27）。
  // 失败响应即使带顶层 chat_session 也不算有效归属（N36）。
  const topLevel =
    !hasFailedCode(parsed) && isRecord(parsed) && isRecord(parsed['chat_session'])
      ? parsed['chat_session']
      : null;
  const session = wrapped ?? topLevel;
  if (!isRecord(session)) return null;
  const id = session['id'];
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  // 会话 id 是 UUID（36 字符）；明显过短的字符串不当作有效归属依据。
  if (trimmed.length < 32) return null;
  // 页面 URL 里的会话 id 是小写；响应若给大写 UUID，不归一化会静默判成"不属于本会话"（N28）。
  return trimmed.toLowerCase();
}

/**
 * 格式化"本会话已用 token"的一行文案。
 *
 * 口径（用户确认）：**只显示已用量，不估剩余** —— 站点没有下发总量/剩余量，
 * 任何"剩余 X"都是编造的。`null` 表示还没观测到，返回 null 让调用方不展示。
 */
export function formatSessionTokens(tokens: number | null): string | null {
  if (tokens === null || !Number.isFinite(tokens) || tokens < 0) return null;
  return `本会话已用 ${tokens.toLocaleString('zh-CN')} tokens`;
}

/* ------------------------------------------------------------ 展示快照组装 */

/**
 * 把存储层快照组装成**可跨进程传输的展示数据**（`QuotaView`）。
 *
 * 放在解析层而不是 main.ts 的原因：这是纯函数，单测能覆盖"没有数据 / 只有部分数据 /
 * 禁言中 / 额度耗尽"等分支，而这些分支恰恰最容易写错（例如把 `null` 渲染成 "0"）。
 *
 * @param modelType 当前页面选中的模型标识；null 表示未知（回落第一个启用的配置）
 * @param sessionTokens 本会话累计已用 token；null 表示尚未观测到
 * @param fromCache 数据是否来自磁盘缓存（非当前账号为 true）
 */
export function composeQuotaView(
  state: QuotaState | null,
  opts: {
    accountId: string;
    modelType?: string | null;
    sessionTokens?: number | null;
    regenerateUsed?: number | null;
    editUsed?: number | null;
    actionCountsEstimated?: boolean;
    fromCache?: boolean;
  },
): QuotaView {
  const modelType = opts.modelType ?? null;
  const sessionTokens = opts.sessionTokens ?? null;
  const chatStatus = state?.chatStatus ?? null;
  const configs = state?.modelConfigs ?? [];
  const cfg = findConfig(configs, modelType);

  const quotas = (chatStatus?.quotas ?? []).map((q) => ({
    modelType: q.modelType,
    isExhausted: q.isExhausted,
    resetAt: q.resetAt,
    msg: q.msg,
  }));

  return {
    accountId: opts.accountId,
    updatedAt: state?.updatedAt ?? 0,
    modelLabel: configLabel(cfg),
    // 有已用次数观测时显示剩余/上限；没有观测时保留诚实的上限文案。
    regenerateLimits: formatRegenerateLimits(cfg, {
      regenerateUsed: opts.regenerateUsed ?? null,
      editUsed: opts.editUsed ?? null,
    }),
    regenerateUsed: opts.regenerateUsed ?? null,
    editUsed: opts.editUsed ?? null,
    actionCountsEstimated: opts.actionCountsEstimated === true,
    inputLimit: formatInputLimit(cfg),
    quotaSummary: describeQuotaStatus(chatStatus),
    isMuted: chatStatus?.isMuted === true,
    muteUntil: chatStatus?.muteUntil ?? 0,
    muteMsg: chatStatus?.muteMsg ?? null,
    serverMessages: collectServerMessages(chatStatus),
    exhaustedModels: exhaustedModelTypes(chatStatus),
    quotas,
    sessionTokens,
    sessionTokensText: formatSessionTokens(sessionTokens),
    fromCache: opts.fromCache === true,
  };
}

/**
 * 托盘 tooltip 的多行摘要（额度 + 禁言 + 会话用量）。
 *
 * v1.1.2：**不再输出重新生成/修改次数行**。用户判定"似乎无法获取准确剩余次数"
 * 并要求整个去掉；`QuotaView.regenerateLimits` 字段保留（数据通路不删），只是不展示。
 */
export function formatTrayTooltip(view: QuotaView, displayName: string): string {
  const lines = [displayName, `账号：${view.accountId}${view.fromCache ? '（缓存）' : ''}`];
  lines.push(`额度：${view.quotaSummary}`);
  if (view.inputLimit !== null) lines.push(view.inputLimit);
  if (view.sessionTokensText !== null) lines.push(view.sessionTokensText);
  return lines.join('\n');
}

/**
 * 托盘「账号」子菜单里每行账号后面的额度尾巴（用户要求：模型额度显示在每个账号后方）。
 *
 * 例：`● personal（当前）· 额度正常`、`   work · 已耗尽（22:23 重置）· 缓存`。
 * 无缓存数据显示「未知」—— 绝不假装知道。
 */
export function accountQuotaSuffix(state: QuotaState | null, fromCache: boolean): string {
  if (state === null) return '未知';
  const summary = describeQuotaStatus(state.chatStatus);
  return fromCache ? `${summary} · 缓存` : summary;
}


