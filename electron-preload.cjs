const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cod4xControl', {
  selectFolder: async () => ipcRenderer.invoke('select-runtime-folder'),
  selectExecutable: async () => ipcRenderer.invoke('select-runtime-executable'),
  getRememberedLogin: async () => ipcRenderer.invoke('get-remembered-login'),
  saveRememberedLogin: async (username, password) => ipcRenderer.invoke('save-remembered-login', { username, password }),
  clearRememberedLogin: async () => ipcRenderer.invoke('clear-remembered-login'),
});
