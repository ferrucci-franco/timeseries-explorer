const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omvDesktop', {
  platform: process.platform,
  selectFilePath: () => ipcRenderer.invoke('omv:select-file-path'),
});
