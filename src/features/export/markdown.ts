/**
 * M1 · T3：`ConversationMirror` → Markdown 导出（PLAN §4.1 / DD-15）。
 *
 * 结构（顺序固定）：
 *   1. **AI 生成标识块**（`ai-notice.ts`，单一真源；R3 不允许裸导出）
 *   2. 会话元信息（标题 / 会话 id / 账号 / 最后更新 / 消息数）
 *   3. 逐条消息：角色分区 → 时间 → 深度思考（独立小标题 + 引用块）→ 正文 → 引用 → 附件
 *
 * 保真原则：
 *  - 正文里的 Markdown 标题、列表、表格**原样保留**（只有代码围栏会被规格化，见下）；
 *  - 正文里的 ``` 围栏会被提升到 4 个反引号，避免把正文中的 ``` 提前闭合（信息不丢失）；
 *  - 无引用 / 无思考 / 无附件时不产生空小节；**空会话也能导出**（只输出标识块与元信息）。
 */

import type { ConversationMirror } from '../../shared/ipc-contract.ts';
import { escapeInline, formatTimestamp, renderAiNotice, sanitizeUrl } from './ai-notice.ts';

export interface MarkdownExportOptions {
  /** 导出时间（毫秒）；默认取当前时间。显式传入可让测试输出可复现。 */
  exportedAt?: number | undefined;
  /** 是否输出深度思考小节（默认 true；关掉也必须保留标识块）。 */
  includeReasoning?: boolean | undefined;
  /** 是否输出引用链接小节（默认 true）。 */
  includeCitations?: boolean | undefined;
  /** 是否输出正文（默认 true；false 时只导出元信息，用于"目录/摘要"）。 */
  includeBody?: boolean | undefined;
}

export interface MarkdownExportResult {
  /** 产物全文。 */
  markdown: string;
  /** 建议文件名（已消毒，不含路径分隔符与品牌特征）。 */
  filename: string;
  exportedAt: number;
  messageCount: number;
}

const FENCE = '```';

export function renderConversationMarkdown(
  conversation: ConversationMirror,
  options: MarkdownExportOptions = {},
): MarkdownExportResult {
  const exportedAt = Number.isFinite(options.exportedAt) ? (options.exportedAt as number) : Date.now();
  const includeReasoning = options.includeReasoning !== false;
  const includeCitations = options.includeCitations !== false;
  const includeBody = options.includeBody !== false;

  const lines: string[] = [];

  // 1) AI 生成标识：永远是第一块（R3 / DD-15）。
  lines.push(
    renderAiNotice({
      url: conversation.url,
      exportedAt,
      source: conversation.source,
      fidelity: conversation.fidelity,
      title: conversation.title,
    }),
  );
  lines.push('');

  // 2) 元信息
  lines.push(`# ${escapeInline(conversation.title)}`, '');
  lines.push(
    [
      `- 会话 ID：\`${escapeInline(conversation.id)}\``,
      `- 账号：\`${escapeInline(conversation.accountId)}\``,
      `- 最后更新：${formatTimestamp(conversation.updatedAt)}`,
      `- 消息数：${conversation.messages.length}`,
      `- 归档通道：${conversation.source}（完整度 ${conversation.fidelity}）`,
      `- 来源：[${sanitizeUrl(conversation.url)}](${sanitizeUrl(conversation.url)})`,
      `- 导出时间：${formatTimestamp(exportedAt)}`,
    ].join('\n'),
  );
  lines.push('');

  // 3) 消息
  const messages = [...conversation.messages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  if (messages.length === 0) {
    lines.push('---', '', '_（本会话没有可导出的消息）_', '');
  }

  messages.forEach((message, index) => {
    const ordinal = index + 1;
    const who = message.role === 'user' ? '我（用户）' : 'AI 助手';
    lines.push('---', '');
    lines.push(`## ${ordinal}. ${who}`, '');
    lines.push(`_时间：${formatTimestamp(message.createdAt)}_`, '');

    if (includeReasoning && typeof message.reasoning === 'string' && message.reasoning.trim().length > 0) {
      lines.push('### 深度思考（模型推理，非最终回答）', '');
      lines.push(quoteBlock(message.reasoning), '');
    }

    if (includeBody) {
      if (message.text.trim().length > 0) {
        lines.push(safeFence(message.text.trim()), '');
      } else {
        lines.push('_（本条消息正文为空）_', '');
      }
    }

    if (includeCitations && Array.isArray(message.citations) && message.citations.length > 0) {
      lines.push(`### 引用来源（${message.citations.length}）`, '');
      message.citations.forEach((citation, i) => {
        const url = sanitizeUrl(citation.url);
        const title = citation.title.trim().length > 0 ? citation.title.trim() : url;
        lines.push(`${i + 1}. [${escapeInline(title)}](<${url}>)`);
      });
      lines.push('');
    }

    if (Array.isArray(message.attachments) && message.attachments.length > 0) {
      lines.push('### 附件', '');
      for (const attachment of message.attachments) {
        lines.push(`- ${escapeInline(attachment.name)}（${formatBytes(attachment.size)}）`);
      }
      lines.push('');
    }
  });

  lines.push('---', '');
  lines.push(`<!-- ${AI_NOTICE_MENTION}：${messageCountNotice(messages.length)} -->`, '');

  const markdown = `${trimTrailingBlank(lines.join('\n'))}\n`;
  return {
    markdown,
    filename: exportFilename(conversation.title, conversation.id, exportedAt),
    exportedAt,
    messageCount: messages.length,
  };
}

/** 便捷包装：只要字符串。 */
export function conversationToMarkdown(
  conversation: ConversationMirror,
  options: MarkdownExportOptions = {},
): string {
  return renderConversationMarkdown(conversation, options).markdown;
}

const AI_NOTICE_MENTION = 'AI 生成标识';

function messageCountNotice(count: number): string {
  return count === 0 ? '空会话导出，仍保留 AI 生成标识' : `共 ${count} 条消息，标识块由 ai-notice.ts 单一真源生成`;
}

/**
 * 正文围栏保护：若正文自身含 ``` 围栏，则把外层围栏提升到 4 个反引号，
 * 保证 Markdown 渲染器（Typora / VSCode）不会提前闭合。空正文返回空串。
 */
export function safeFence(text: string): string {
  if (text.length === 0) return '';
  let fence = FENCE;
  while (text.includes(fence)) fence += '`';
  return `${fence}\n${text}\n${fence}`;
}

/** 多行文本 → Markdown 引用块（保留空行，保证 Typora 渲染正确）。 */
export function quoteBlock(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.length === 0 ? '>' : `> ${line}`))
    .join('\n');
}

function trimTrailingBlank(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

/** 文件名消毒：去掉 Windows 非法字符与控制字符，限长，绝不产生路径分隔符。 */
export function exportFilename(title: string, id: string, exportedAt: number): string {
  const stamp = new Date(exportedAt);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const datePart = Number.isNaN(stamp.getTime())
    ? 'unknown-date'
    : `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
  const base = sanitizeFilenamePart(title).slice(0, 60);
  const safeId = sanitizeFilenamePart(id).slice(0, 40);
  const stem = base.length > 0 ? `${base}-${safeId}` : safeId;
  return `${stem || 'conversation'}-${datePart}.md`;
}

export function sanitizeFilenamePart(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex -- 需要显式剔除控制字符
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.+$/, '');
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return `${size} B`;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/** 供 diagnostics / 导出前自检使用：产物里是否带标识。 */
export function hasAiNotice(markdown: string): boolean {
  return markdown.includes('本内容由 AI 生成');
}
