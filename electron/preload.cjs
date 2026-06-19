const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omvDesktop', {
  platform: process.platform,
  selectFilePath: options => ipcRenderer.invoke('omv:select-file-path', options || {}),
});
