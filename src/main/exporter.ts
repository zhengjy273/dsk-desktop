/**
 * M1：把当前会话导出为本地文件（Markdown / JSON）。
 *
 * 数据源与**诚实边界**（重要，别把它当结构化归档）：
 *  - M1 是**页面快照导出**：只取页面可见文本 + 标题 + URL，并强制带上 AI 生成标识（R3 / DD-15）；
 *    内容是用户自己的数据，只落本机（R5）。
 *  - 站点 DOM 的结构化信息（role / 深度思考 / 引用）在 M1 **拿不可靠**：站点用 CSS Modules 哈希类名、
 *    图标按钮无可访问名称（见 docs/M0-REPORT.md §二）。所以这里**不假装**结构化。
 *  - M2 接入网络通道（SSE）后，会改用 `renderConversationMarkdown()` 输出真正的结构化归档。
 *
 * 写作用域：`src/main/**`（T1），只会**读取** `src/features/**` 与 `src/shared/**` 的公开 API。
 */
import { dialog } from 'electron';
import type { WebContents } from 'electron';
import { writeFileSync } from 'node:fs';
import type { ConversationMirror } from '../shared/ipc-contract.ts';
import { AI_NOTICE_MARKDOWN, AI_NOTICE_TEXT, formatTimestamp } from '../features/export/ai-notice.ts';
import { renderArchive } from '../features/export/archive.ts';
import { sanitizeFilenamePart } from '../features/export/markdown.ts';

/** 只读探针：取标题/URL/可见文本，**不读取任何输入控件的值**（R1）。 */
const SNAPSHOT_PROBE = `(() => {
  const body = document.body ? (document.body.innerText || '') : '';
  return { title: document.title || 'DeepSeek 会话', url: location.href, text: body.slice(0, 400000) };
})()`;

export interface ExportResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  chars?: number;
  error?: string;
  canceled?: boolean;
}

interface Snapshot {
  title: string;
  url: string;
  text: string;
}

/** 读取当前页面快照（导出与自检共用）。 */
export async function readSnapshot(wc: WebContents): Promise<Snapshot | null> {
  try {
    const s = (await wc.executeJavaScript(SNAPSHOT_PROBE, true)) as Snapshot | null;
    if (!s || typeof s.text !== 'string') return null;
    return s;
  } catch {
    return null;
  }
}

/** 渲染页面快照为 Markdown（标识块恒为第一块）。 */
export function renderSnapshotMarkdown(snap: Snapshot, exportedAt = Date.now()): string {
  const lines: string[] = [];
  lines.push(AI_NOTICE_MARKDOWN, '');
  lines.push(`# ${snap.title}`, '');
  lines.push(`- 来源：${snap.url}`);
  lines.push(`- 导出时间：${formatTimestamp(exportedAt)}`);
  lines.push('- 说明：本文件为**页面快照**（M1），非结构化归档；接入网络通道后将提供结构化导出。');
  lines.push('', '---', '', snap.text);
  return lines.join('\n');
}

/** 渲染页面快照为 JSON。 */
export function renderSnapshotJson(snap: Snapshot, exportedAt = Date.now()): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      kind: 'page-snapshot',
      /** R3：产物必须自证是 AI 生成内容 */
      aiGenerated: true,
      notice: AI_NOTICE_TEXT,
      title: snap.title,
      url: snap.url,
      exportedAt,
      exportedAtText: formatTimestamp(exportedAt),
      text: snap.text,
    },
    null,
    2,
  );
}

function suggestedName(snap: Snapshot, ext: string, exportedAt: number): string {
  const stamp = new Date(exportedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `${sanitizeFilenamePart(snap.title) || 'deepseek-chat'}-${stamp}.${ext}`;
}

/**
 * 导出当前页面到用户选择的文件。
 * 注意：写入前会强制校验产物含 AI 生成标识，避免"裸导出"（R3）。
 */
export async function exportCurrentPage(
  wc: WebContents,
  format: 'md' | 'json',
  opts: { defaultDir?: string } = {},
): Promise<ExportResult> {
  const snap = await readSnapshot(wc);
  if (!snap) return { ok: false, error: '无法读取页面内容（页面可能未加载完成）' };
  if (!snap.text.trim()) return { ok: false, error: '当前页面没有可导出的文本内容' };

  const exportedAt = Date.now();
  const content = format === 'md' ? renderSnapshotMarkdown(snap, exportedAt) : renderSnapshotJson(snap, exportedAt);

  // R3 兜底断言：产物必须自证 AI 生成
  if (format === 'md' && !content.includes(AI_NOTICE_TEXT)) {
    return { ok: false, error: '内部错误：Markdown 产物缺少 AI 生成标识，已中止导出' };
  }
  if (format === 'json' && !content.includes(AI_NOTICE_TEXT)) {
    return { ok: false, error: '内部错误：JSON 产物缺少 AI 生成标识，已中止导出' };
  }

  const ext = format === 'md' ? 'md' : 'json';
  const picked = await dialog.showSaveDialog({
    title: format === 'md' ? '导出当前会话为 Markdown' : '导出当前会话为 JSON',
    defaultPath: opts.defaultDir
      ? `${opts.defaultDir}\\${suggestedName(snap, ext, exportedAt)}`
      : suggestedName(snap, ext, exportedAt),
    filters:
      format === 'md'
        ? [{ name: 'Markdown', extensions: ['md'] }]
        : [{ name: 'JSON', extensions: ['json'] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };

  try {
    writeFileSync(picked.filePath, content, 'utf8');
    return { ok: true, path: picked.filePath, bytes: Buffer.byteLength(content, 'utf8'), chars: content.length };
  } catch (e) {
    return { ok: false, error: `写入失败：${String((e as Error)?.message ?? e)}` };
  }
}

/**
 * M2：导出**结构化归档**（来自网络通道观测并归档的会话镜像）。
 *
 * 与 `exportCurrentPage()` 的区别：
 *  - 数据源：前者是 DOM 可见文本（页面快照，M1 兜底）；本函数是逐条消息镜像（含深度思考与引用）；
 *  - 渲染：复用 T3 的 `renderArchive()`，**AI 生成标识恒为产物第一块**（R3 / DD-15）；
 *  - 兜底断言：写入前校验产物含标识，否则中止（绝不"裸导出"）。
 */
export async function exportConversationArchive(
  conversation: ConversationMirror,
  format: 'md' | 'json',
  opts: { defaultDir?: string } = {},
): Promise<ExportResult> {
  const exportedAt = Date.now();
  const rendered = renderArchive(conversation, format, exportedAt);

  if (!rendered.hasNotice) {
    return { ok: false, error: '内部错误：归档产物缺少 AI 生成标识，已中止导出' };
  }

  const picked = await dialog.showSaveDialog({
    title: format === 'md' ? '导出会话归档（结构化 Markdown）' : '导出会话归档（结构化 JSON）',
    defaultPath: opts.defaultDir ? `${opts.defaultDir}\\${rendered.filename}` : rendered.filename,
    filters:
      format === 'md'
        ? [{ name: 'Markdown', extensions: ['md'] }]
        : [{ name: 'JSON', extensions: ['json'] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };

  try {
    writeFileSync(picked.filePath, rendered.content, 'utf8');
    return {
      ok: true,
      path: picked.filePath,
      bytes: Buffer.byteLength(rendered.content, 'utf8'),
      chars: rendered.chars,
    };
  } catch (e) {
    return { ok: false, error: `写入失败：${String((e as Error)?.message ?? e)}` };
  }
}
