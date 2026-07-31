const { contextBridge, ipcRenderer } = require('electron');
const os = require('os');

// The renderer can't read os.* directly (context isolation), but the real
// user/home/temp paths let the OpenModelica & Dymola "copy path" helpers build
// an exact path instead of a USERNAME placeholder inferred from the URL.
let username = '';
try { username = os.userInfo().username || ''; } catch (_) { username = ''; }

contextBridge.exposeInMainWorld('omvDesktop', {
  platform: process.platform,
  homedir: os.homedir(),
  tmpdir: os.tmpdir(),
  username,
  setTheme: theme => ipcRenderer.send('omv:set-theme', theme),
  getZoom: () => ipcRenderer.invoke('omv:get-zoom'),
  // 'in' | 'out' | 'reset' -- the ladder lives in the main process.
  setZoom: action => ipcRenderer.invoke('omv:set-zoom', { action }),
  // Keeps the menu's percentage honest when the keyboard changed the zoom.
  // Returns an unsubscribe so a caller is never forced to leak the listener.
  onZoomChanged: callback => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, factor) => callback(factor);
    ipcRenderer.on('omv:zoom-changed', listener);
    return () => ipcRenderer.removeListener('omv:zoom-changed', listener);
  },
  selectFilePath: options => ipcRenderer.invoke('omv:select-file-path', options || {}),
  selectFilePaths: options => ipcRenderer.invoke('omv:select-file-paths', options || {}),
  selectParquetOutputPath: options => ipcRenderer.invoke('omv:select-parquet-output-path', options || {}),
  deleteTemporaryParquet: options => ipcRenderer.invoke('omv:delete-temporary-parquet', options || {}),
  readFile: options => ipcRenderer.invoke('omv:read-file', options || {}),
  statFile: options => ipcRenderer.invoke('omv:stat-file', options || {}),
  readFileSlice: options => ipcRenderer.invoke('omv:read-file-slice', options || {}),
  convertToParquet: options => ipcRenderer.invoke('omv:convert-to-parquet', options || {}),
});
