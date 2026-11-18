/**
 * 导出：把**结构化归档会话**写成本地文件（只出 Markdown）。
 *
 * v1.1.4 的两处收缩（用户要求）：
 *  - **取消页面快照导出**（原来导出 DOM 可见文本的 Markdown/JSON）。它产出的只是页面文本堆叠、
 *    不含消息结构，与归档导出重复且容易被误当成结构化产物；入口与渲染函数一并移除。
 *  - **去掉 JSON 出口**：只剩 Markdown。
 *
 * 诚实边界：
 *  - 数据来源是网络通道观测到的逐条消息镜像（含深度思考与引用），不是 DOM 抓取；
 *  - 产物**必须**带 AI 生成标识且恒为第一块（R3 / DD-15），写入前会校验，绝不"裸导出"；
 *  - 内容是用户自己的数据，只落本机（R5）。
 *
 * 写作用域：`src/main/**`（T1），只会**读取** `src/features/**` 与 `src/shared/**` 的公开 API。
 */
import { dialog } from 'electron';
import { writeFileSync } from 'node:fs';
import type { ConversationMirror } from '../shared/ipc-contract.ts';
import { renderArchive } from '../features/export/archive.ts';

export interface ExportResult {
  ok: boolean;
  path?: string;
  bytes?: number;
  chars?: number;
  error?: string;
  canceled?: boolean;
}

/**
 * 导出**结构化归档**（来自网络通道观测并归档的会话镜像）。
 *
 * 渲染复用 T3 的 `renderArchive()`，**AI 生成标识恒为产物第一块**（R3 / DD-15）；
 * 写入前校验产物含标识，否则中止。
 */
export async function exportConversationArchive(
  conversation: ConversationMirror,
  opts: { defaultDir?: string } = {},
): Promise<ExportResult> {
  const exportedAt = Date.now();
  const rendered = renderArchive(conversation, 'md', exportedAt);

  if (!rendered.hasNotice) {
    return { ok: false, error: '内部错误：归档产物缺少 AI 生成标识，已中止导出' };
  }

  const picked = await dialog.showSaveDialog({
    title: '导出会话归档（Markdown）',
    defaultPath: opts.defaultDir ? `${opts.defaultDir}\\${rendered.filename}` : rendered.filename,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
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
