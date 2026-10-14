/**
 * 「添加账号」输入窗口的 preload（沙箱下可用：CommonJS + 仅 require('electron')）。
 * 只暴露两个单向消息：提交名字 / 取消。校验在主进程侧再走一遍。
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dskAccountInput', {
  submit: (name) => ipcRenderer.send('dsk:account-input:submit', String(name ?? '')),
  cancel: () => ipcRenderer.send('dsk:account-input:cancel'),
});
