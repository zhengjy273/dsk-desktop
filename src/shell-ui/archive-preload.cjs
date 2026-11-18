/**
 * 本地归档查看器的 preload（沙箱下可用：CommonJS + 仅 require('electron')）。
 *
 * 只暴露**白名单**方法，且全部走 ipcRenderer.invoke（主进程侧会再校验参数）：
 * 页面本身没有 Node 能力，也不接受任意通道名。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dskArchive', {
  /** 列出全部已归档会话（索引项，不含正文） */
  list: () => ipcRenderer.invoke('dsk:archive:list'),
  /** 全文检索（AND 语义），返回带片段的命中 */
  search: (query) => ipcRenderer.invoke('dsk:archive:search', String(query ?? '')),
  /** 读回单个会话的完整镜像 */
  read: (id) => ipcRenderer.invoke('dsk:archive:read', String(id ?? '')),
  /** 触发导出（主进程弹保存对话框）。v1.1.4：只支持 Markdown，格式在桥内固定，页面无法指定。 */
  exportArchive: (id) => ipcRenderer.invoke('dsk:archive:export', String(id ?? ''), 'md'),
});
