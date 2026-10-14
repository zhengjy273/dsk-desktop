/**
 * M1 · T3：AI 生成标识的**单一真源**（PLAN §1.3 R3、DD-15）。
 *
 * 合规依据：协议 3.1(2)/5.3 —— 不得删除、遮挡或以其它方式破坏 AI 生成标识。
 * 落地方式：**所有导出格式都必须引用本模块**，不允许各自手写文案；
 * 新增导出格式（html/pdf/…）必须调用 `renderAiNotice` / `serializeAiNotice`。
 *
 * 该文案同时是自动化断言的锚点（见 tests/unit/export-*.test.ts 与 PLAN §6.3 G3）。
 */

/** 标识文案的正文（不含 Markdown 引用前缀），全项目唯一字面量。 */
export const AI_NOTICE_TEXT = '本内容由 AI 生成，请仔细甄别';

/** Markdown 形式：引用块 + ⚠️（导出产物第一行即为它）。 */
export const AI_NOTICE_MARKDOWN = `> ⚠️ ${AI_NOTICE_TEXT}`;

/** 纯文本形式（便于终端、文件名、剪贴板等非 Markdown 场景）。 */
export const AI_NOTICE_PLAIN = `⚠️ ${AI_NOTICE_TEXT}`;

export const AI_NOTICE_VERSION = '1';

export interface AiNoticeInput {
  /** 来源 URL（会话页地址，DD-06 可追溯）。 */
  url?: string | undefined;
  /** 导出时间戳（毫秒）。 */
  exportedAt?: number | undefined;
  /** 数据来源通道：network 为权威（DD-06），dom 为兜底。 */
  source?: 'network' | 'dom' | undefined;
  /** 完整度标记。 */
  fidelity?: 'partial' | 'full' | undefined;
  /** 会话标题（可选，帮助读者确认导出的对象）。 */
  title?: string | undefined;
  /** 生成器名称（默认项目内部标识，不含站点品牌特征；R4）。 */
  generator?: string | undefined;
}

export interface RenderAiNoticeOptions {
  /** Markdown 渲染时给链接加尖括号（URL 含空格/括号时更稳）。 */
  angleBrackets?: boolean;
}

/**
 * 生成标识段落（Markdown）。**导出产物必须把它写在最前面。**
 *
 * 输出结构（固定，便于断言）：
 * ```
 * > ⚠️ 本内容由 AI 生成，请仔细甄别
 * > 来源：<url>
 * > 导出时间：<ISO 8601>
 * ```
 */
export function renderAiNotice(input: AiNoticeInput = {}, options: RenderAiNoticeOptions = {}): string {
  const lines = [AI_NOTICE_MARKDOWN];

  if (input.title !== undefined && input.title.trim().length > 0) {
    lines.push(`> 会话：${escapeInline(input.title.trim())}`);
  }
  if (typeof input.url === 'string' && input.url.length > 0) {
    const url = options.angleBrackets ? `<${sanitizeUrl(input.url)}>` : sanitizeUrl(input.url);
    lines.push(`> 来源：${url}`);
  }
  if (typeof input.exportedAt === 'number' && Number.isFinite(input.exportedAt)) {
    lines.push(`> 导出时间：${formatTimestamp(input.exportedAt)}`);
  }
  if (input.source !== undefined || input.fidelity !== undefined) {
    const parts: string[] = [];
    if (input.source !== undefined) parts.push(`通道 ${input.source}`);
    if (input.fidelity !== undefined) parts.push(`完整度 ${input.fidelity}`);
    lines.push(`> 归档信息：${parts.join(' · ')}`);
  }
  lines.push(`> 生成器：${escapeInline(input.generator ?? DEFAULT_GENERATOR)}`);
  return lines.join('\n');
}

export const DEFAULT_GENERATOR = 'dsk-desktop（非官方本地归档）';

/** 用于 JSON / 结构化产物的标识字段（保证"结构化产物也带标识"）。 */
export function serializeAiNotice(input: AiNoticeInput = {}): {
  aiGenerated: true;
  notice: string;
  noticeText: string;
  noticeVersion: string;
  generator: string;
  sourceUrl?: string;
  exportedAt?: number;
  exportedAtIso?: string;
  mirrorSource?: 'network' | 'dom';
  fidelity?: 'partial' | 'full';
} {
  const out: {
    aiGenerated: true;
    notice: string;
    noticeText: string;
    noticeVersion: string;
    generator: string;
    sourceUrl?: string;
    exportedAt?: number;
    exportedAtIso?: string;
    mirrorSource?: 'network' | 'dom';
    fidelity?: 'partial' | 'full';
  } = {
    aiGenerated: true, // R3：结构化产物也不允许出现"未标注"的导出
    notice: AI_NOTICE_TEXT,
    noticeText: AI_NOTICE_PLAIN,
    noticeVersion: AI_NOTICE_VERSION,
    generator: input.generator ?? DEFAULT_GENERATOR,
  };
  if (typeof input.url === 'string' && input.url.length > 0) out.sourceUrl = input.url;
  if (typeof input.exportedAt === 'number' && Number.isFinite(input.exportedAt)) {
    out.exportedAt = input.exportedAt;
    out.exportedAtIso = formatTimestamp(input.exportedAt);
  }
  if (input.source !== undefined) out.mirrorSource = input.source;
  if (input.fidelity !== undefined) out.fidelity = input.fidelity;
  return out;
}

/** 统一的时间呈现：本地时区可读形式 + ISO 8601（UTC），便于人工与机器同时消费。 */
export function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(ms);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  const local =
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${local} (${date.toISOString()})`;
}

/** 只保留 https 链接；其它协议（javascript: / data: / file:）一律降级为不可点击的纯文本。 */
export function sanitizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('https://')) return trimmed;
  return trimmed.replace(/[[\]()<>]/g, '');
}

/** 行内文本转义：避免标题里的 `|`、换行破坏 Markdown 结构。 */
export function escapeInline(raw: string): string {
  return raw.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
}
