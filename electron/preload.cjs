const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omvDesktop', {
  platform: process.platform,
  selectFilePath: options => ipcRenderer.invoke('omv:select-file-path', options || {}),
  selectFilePaths: options => ipcRenderer.invoke('omv:select-file-paths', options || {}),
  readFile: options => ipcRenderer.invoke('omv:read-file', options || {}),
  statFile: options => ipcRenderer.invoke('omv:stat-file', options || {}),
  readFileSlice: options => ipcRenderer.invoke('omv:read-file-slice', options || {}),
});
