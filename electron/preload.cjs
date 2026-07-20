const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omvDesktop', {
  platform: process.platform,
  setTheme: theme => ipcRenderer.send('omv:set-theme', theme),
  selectFilePath: options => ipcRenderer.invoke('omv:select-file-path', options || {}),
  selectFilePaths: options => ipcRenderer.invoke('omv:select-file-paths', options || {}),
  selectParquetOutputPath: options => ipcRenderer.invoke('omv:select-parquet-output-path', options || {}),
  deleteTemporaryParquet: options => ipcRenderer.invoke('omv:delete-temporary-parquet', options || {}),
  readFile: options => ipcRenderer.invoke('omv:read-file', options || {}),
  statFile: options => ipcRenderer.invoke('omv:stat-file', options || {}),
  readFileSlice: options => ipcRenderer.invoke('omv:read-file-slice', options || {}),
  convertToParquet: options => ipcRenderer.invoke('omv:convert-to-parquet', options || {}),
});
