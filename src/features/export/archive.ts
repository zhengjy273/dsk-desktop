/**
 * M2：归档产物渲染 —— **纯函数**（不依赖 electron，可在 vitest 下直接测）。
 *
 * 输入是 `ConversationMirror`（来自网络通道归档的结构化会话镜像），输出可直接落盘的内容与建议文件名。
 * 渲染本身复用 T3 的 `renderConversationMarkdown/Json`（**AI 生成标识恒为产物第一块**，R3 / DD-15）。
 *
 * 与 `src/main/exporter.ts` 的"页面快照导出"的关系：
 *  - 页面快照（M1）：DOM 可见文本，兜底用；
 *  - 归档导出（M2，本模块）：逐条消息（含深度思考与引用），网络通道观测所得。
 */
import type { ConversationMirror } from '../../shared/ipc-contract.ts';
import { AI_NOTICE_TEXT } from './ai-notice.ts';
import { renderConversationJson } from './json.ts';
import { renderConversationMarkdown } from './markdown.ts';

export interface RenderedArchive {
  /** 可直接落盘的产物全文。 */
  content: string;
  /** 建议文件名（已消毒，不含路径分隔符）。 */
  filename: string;
  chars: number;
  /** R3 自证：产物是否带 AI 生成标识（导出前必须为 true）。 */
  hasNotice: boolean;
}

/** 渲染归档产物；空会话同样可导出（只输出标识块与元信息）。 */
export function renderArchive(
  conversation: ConversationMirror,
  format: 'md' | 'json',
  exportedAt = Date.now(),
): RenderedArchive {
  if (format === 'md') {
    const r = renderConversationMarkdown(conversation, { exportedAt });
    return {
      content: r.markdown,
      filename: r.filename,
      chars: r.markdown.length,
      hasNotice: r.markdown.includes(AI_NOTICE_TEXT),
    };
  }
  const r = renderConversationJson(conversation, { exportedAt });
  return {
    content: r.json,
    filename: r.filename,
    chars: r.json.length,
    hasNotice: r.json.includes(AI_NOTICE_TEXT),
  };
}
