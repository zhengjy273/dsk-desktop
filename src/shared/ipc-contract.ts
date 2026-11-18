/**
 * 跨进程 IPC 契约 —— 唯一真源（T0 产出）。
 *
 * 纪律：`src/shared/**` 只由 Lead 修改；其他任务需要改契约时提请求，不得自行编辑（PLAN §4.2）。
 * 设计原则：载荷一律走可 JSON 序列化的纯数据，禁止传函数/类实例/Electron 对象。
 */

export type AccountId = string; // 仅用户本人的多个账号，如 "personal" | "work"（R6：不做账号共享）

/** 会话镜像中的一条消息。 */
export interface MirrorMessage {
  id: string; // 幂等键：会话 id + 序号 + 内容哈希（重复观察不产生重复记录）
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  reasoning?: string; // 深度思考内容（页面展示时才有）
  citations?: { title: string; url: string }[];
  attachments?: { name: string; size: number }[];
  /** 恒为 true：产物必须保留"AI 生成"属性，导出时不得去除（R3 / DD-15）。 */
  aiGenerated: true;
}

export interface ConversationMirror {
  id: string;
  accountId: AccountId;
  title: string;
  url: string;
  updatedAt: number;
  messages: MirrorMessage[];
  /** 数据来源可追溯：network 为权威通道（DD-06），dom 为兜底。 */
  source: 'network' | 'dom';
  fidelity: 'partial' | 'full';
}

/** 选择器失配诊断（DD-05：增强层降级而不崩溃）。 */
export interface SelectorWarning {
  selector: string;
  hits: number;
  lastOk: number;
}

/**
 * 展示用的额度快照（**主进程 → 注入脚本**，也可给托盘用）。
 *
 * 为什么单独定义而不直接复用 `src/session/quota-parser.ts` 的 `QuotaState`：
 * 契约层只放**可 JSON 序列化的纯展示数据**，解析层的内部结构（原始 modelConfigs 全字段）
 * 不该越过进程边界；这里只保留"要显示什么"。
 *
 * 口径约束（用户已确认）：
 *  - 单会话 token **只显示已用量**，站点没有下发总量/剩余量，绝不编造"剩余 X"；
 *  - 重新生成/修改次数：优先显示**剩余次数**，已用次数来自页面自身请求与历史分支；
 *    没有已用次数观测时退回「上限值」，不伪造 0 已用。
 */
export interface QuotaView {
  accountId: AccountId;
  /** 本次数据的时间（毫秒） */
  updatedAt: number;
  /** 当前模型展示名 */
  modelLabel: string;
  /** 「重新生成剩余 N/M 次 · 修改剩余 N/M 次」；没有上限配置时为 null */
  regenerateLimits: string | null;
  /** 当前回答的重新生成已用次数；null = 尚未观测到 */
  regenerateUsed: number | null;
  /** 当前用户消息的修改已用次数；null = 尚未观测到 */
  editUsed: number | null;
  /** 已用次数是否只在本程序运行时计数（非历史全量） */
  actionCountsEstimated: boolean;
  /** 「单次输入上限 N 字」；未取到配置时为 null */
  inputLimit: string | null;
  /** 额度状态摘要（托盘 tooltip / 浮层标题） */
  quotaSummary: string;
  /** 是否禁言中 */
  isMuted: boolean;
  /** 禁言截止（毫秒；0 = 未给出） */
  muteUntil: number;
  /** 禁言文案（服务端明文） */
  muteMsg: string | null;
  /** 服务端下发的额度/告警文案（明文，已去重） */
  serverMessages: string[];
  /** 额度耗尽的模型标识 */
  exhaustedModels: string[];
  /** 各模型额度明细（浮层展开用） */
  quotas: {
    modelType: string | null;
    isExhausted: boolean;
    resetAt: number;
    msg: string | null;
  }[];
  /** 本会话累计已用 token；null = 尚未观测到（不显示，也不显示 0） */
  sessionTokens: number | null;
  /** 单会话 token 的一行文案（主进程算好，注入脚本只贴文字） */
  sessionTokensText: string | null;
  /** 是否来自磁盘缓存（非当前账号 = 缓存） */
  fromCache: boolean;
}

/**
 * 主进程 → 外壳 UI。
 *
 * 当前**没有运行时消费者** —— 主进程与页面之间不走 IPC（限额数据是用
 * `webContents.executeJavaScript` 把脚本直推页面），归档查看器走的是另一套
 * `CH_ARCHIVE`（见 `src/main/main.ts`）。这里保留类型是留痕：将来若真要做
 * 独立的 shell UI 通道，形状已经定好，不必重新设计。标签页相关项（`tabs/changed`、
 * `TabId`）已随 M1「不做标签页」的最终决定移除，别再往回加。
 */
export type MainToShell =
  | { t: 'turn/finished'; conversationId: string }
  | { t: 'theme/changed'; dark: boolean }
  | { t: 'diagnostics'; warnings: SelectorWarning[] }
  | { t: 'quota/changed'; view: QuotaView }
  | { t: 'account/signOutDone'; id: AccountId };

/**
 * 外壳 UI → 主进程。
 *
 * 同 `MainToShell`：当前无运行时消费者，保留作形状留痕。
 * `export` 不再带 `format` —— v1.1.4 起只出 Markdown（格式在 `archive-preload.cjs` 里固定）。
 */
export type ShellToMain =
  | { t: 'win/mini'; on: boolean }
  | { t: 'win/alwaysOnTop'; on: boolean }
  | { t: 'export'; conversationId: string }
  | { t: 'account/add'; label: string }
  | { t: 'account/signOut'; id: AccountId }
  | { t: 'proxy/set'; mode: 'direct' | 'manual' | 'pac'; rules?: string; pacUrl?: string };

// 注意：这里**没有** `CH` 通道名常量。曾经有过 `CH.mainToShell` / `CH.shellToMain`，
// 但全库零引用（实际 IPC 通道是 `src/main/main.ts` 的 `CH_ARCHIVE`，名字形如 `dsk:archive:*`）。
// 保留一个没人用的常量只会让人以为还存在 main↔shell 双向通道 —— 已删。
