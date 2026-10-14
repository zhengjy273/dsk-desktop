/**
 * 跨进程 IPC 契约 —— 唯一真源（T0 产出）。
 *
 * 纪律：`src/shared/**` 只由 Lead 修改；其他任务需要改契约时提请求，不得自行编辑（PLAN §4.2）。
 * 设计原则：载荷一律走可 JSON 序列化的纯数据，禁止传函数/类实例/Electron 对象。
 */

export type AccountId = string; // 仅用户本人的多个账号，如 "personal" | "work"（R6：不做账号共享）
export type TabId = string;

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

/** 主进程 → 外壳 UI。 */
export type MainToShell =
  | { t: 'tabs/changed'; tabs: { id: TabId; title: string; unread: number }[] }
  | { t: 'turn/finished'; tabId: TabId; conversationId: string }
  | { t: 'theme/changed'; dark: boolean }
  | { t: 'diagnostics'; warnings: SelectorWarning[] }
  | { t: 'account/signOutDone'; id: AccountId };

/** 外壳 UI → 主进程。 */
export type ShellToMain =
  | { t: 'tab/new'; url?: string }
  | { t: 'tab/close'; id: TabId }
  | { t: 'tab/activate'; id: TabId }
  | { t: 'win/mini'; on: boolean }
  | { t: 'win/alwaysOnTop'; on: boolean }
  | { t: 'export'; conversationId: string; format: 'md' | 'json' }
  | { t: 'account/add'; label: string }
  | { t: 'account/signOut'; id: AccountId }
  | { t: 'proxy/set'; mode: 'direct' | 'manual' | 'pac'; rules?: string; pacUrl?: string };

/** IPC 通道名常量，避免各处手写字符串。 */
export const CH = {
  mainToShell: 'dsk:main->shell',
  shellToMain: 'dsk:shell->main',
} as const;
