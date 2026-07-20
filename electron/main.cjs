const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } = require('electron');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  fileInfoPayload,
  mimeTypes,
  mimeTypeForPath,
  streamLocalFile,
} = require('./local-file-http.cjs');
const {
  appOriginFromUrl,
  isAllowedRendererUrl,
  isExternalWebUrl,
} = require('./navigation-policy.cjs');

const projectRoot = path.resolve(__dirname, '..');
const staticRoot = path.join(projectRoot, 'dist');
const desktopIconPath = path.join(projectRoot, 'build', 'icons', 'timeseries-explorer-icon.png');
const host = '127.0.0.1';
const preferredPort = Number(process.env.OMV_DESKTOP_PORT || 8876);
let csvToParquetCorePromise = null;
let mainWindow = null;
const temporaryParquetPaths = new Set();
let temporaryParquetSessionDir = null;

if (process.env.OMV_REMOTE_DEBUGGING_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', String(process.env.OMV_REMOTE_DEBUGGING_PORT));
}

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

ipcMain.on('omv:set-theme', (_event, theme) => {
  nativeTheme.themeSource = theme === 'dark' ? 'dark' : 'light';
});

function desktopReadErrorPayload(err) {
  const code = err?.code || '';
  const notFound = code === 'ENOENT' || code === 'ENOTDIR';
  const transient = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
  return {
    ok: false,
    name: notFound ? 'NotFoundError' : transient ? 'NotReadableError' : 'Error',
    code,
    message: err?.message || 'The file could not be read',
  };
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

function localPathFromUrl(url) {
  const raw = url.searchParams.get('path') || '';
  if (!raw.trim()) return null;
  return path.resolve(raw);
}

function csvFingerprint(filePath, stat) {
  return crypto
    .createHash('sha256')
    .update(path.resolve(filePath))
    .update('\0')
    .update(String(stat.size))
    .update('\0')
    .update(String(stat.mtimeMs))
    .digest('hex')
    .slice(0, 16);
}

function parquetCacheName(filePath, fingerprint) {
  const base = path.basename(filePath, path.extname(filePath));
  return `${base}.omv-${fingerprint}.parquet`;
}

function temporaryParquetRoot() {
  return path.join(app.getPath('userData'), 'temporary-parquet');
}

function temporaryParquetSessionRoot() {
  if (!temporaryParquetSessionDir) {
    const token = crypto.randomBytes(4).toString('hex');
    temporaryParquetSessionDir = path.join(temporaryParquetRoot(), `${process.pid}-${token}`);
  }
  return temporaryParquetSessionDir;
}

function temporaryParquetName(filePath) {
  const base = path.basename(filePath, path.extname(filePath)).replace(/[^a-zA-Z0-9._-]/g, '_') || 'results';
  const token = crypto.randomBytes(8).toString('hex');
  return `${base}.tmp-${process.pid}-${Date.now()}-${token}.parquet`;
}

function isInsideDirectory(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function canWriteDirectory(dir) {
  try {
    await fsp.mkdir(dir, { recursive: true });
    const probe = path.join(dir, `.omv-write-test-${process.pid}-${Date.now()}`);
    await fsp.writeFile(probe, '');
    await fsp.unlink(probe);
    return true;
  } catch (_) {
    return false;
  }
}

async function chooseParquetOutputPath(inputPath, stat, requestedPath = '', options = {}) {
  if (requestedPath && String(requestedPath).trim()) return path.resolve(requestedPath);
  if (options.temporary) {
    const dir = temporaryParquetSessionRoot();
    await fsp.mkdir(dir, { recursive: true });
    return path.join(dir, temporaryParquetName(inputPath));
  }
  const fingerprint = csvFingerprint(inputPath, stat);
  const name = parquetCacheName(inputPath, fingerprint);
  const adjacent = path.resolve(path.dirname(inputPath), name);
  if (await canWriteDirectory(path.dirname(inputPath))) return adjacent;
  const fallbackDir = path.join(app.getPath('userData'), 'parquet-output');
  await fsp.mkdir(fallbackDir, { recursive: true });
  return path.join(fallbackDir, name);
}

async function sweepTemporaryParquetOrphans() {
  const root = temporaryParquetRoot();
  const ownDir = temporaryParquetSessionRoot();
  try {
    await fsp.mkdir(root, { recursive: true });
    const entries = await fsp.readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name);
      if (path.resolve(candidate) === path.resolve(ownDir)) continue;

      const match = /^(\d+)-[a-f0-9]+$/i.exec(entry.name);
      if (!match) continue;
      const pid = Number(match[1]);
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch (err) {
        alive = err?.code === 'EPERM';
      }
      if (!alive) {
        try { await fsp.rm(candidate, { recursive: true, force: true }); } catch (_) {}
      }
    }
  } catch (_) {
    // Best effort: stale temp Parquets should never block app startup.
  }
  await fsp.mkdir(ownDir, { recursive: true });
}

async function deleteTemporaryParquetPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return { ok: false, message: 'Missing path' };
  const resolved = path.resolve(filePath);
  const sessionRoot = temporaryParquetSessionRoot();
  if (!isInsideDirectory(resolved, sessionRoot)) {
    return { ok: false, message: 'Refusing to delete a file outside this app instance temporary Parquet directory' };
  }
  temporaryParquetPaths.delete(resolved);
  try {
    await fsp.rm(resolved, { force: true });
    return { ok: true, path: resolved };
  } catch (err) {
    return { ok: false, path: resolved, message: err?.message || String(err) };
  }
}

function cleanupTrackedTemporaryParquets() {
  for (const filePath of [...temporaryParquetPaths]) {
    try { fs.rmSync(filePath, { force: true }); } catch (_) {}
    temporaryParquetPaths.delete(filePath);
  }
  const sessionRoot = temporaryParquetSessionRoot();
  try { fs.rmSync(sessionRoot, { recursive: true, force: true }); } catch (_) {}
}

async function loadCsvToParquetCore() {
  if (!csvToParquetCorePromise) {
    const packedPath = path.join(projectRoot, 'src', 'data', 'csv-to-parquet-core.js');
    const modulePath = app.isPackaged
      ? packedPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
      : packedPath;
    csvToParquetCorePromise = import(pathToFileURL(modulePath).href);
  }
  return csvToParquetCorePromise;
}

async function handleApi(req, res, url) {
  if (url.pathname === '/__omv_local__/status') {
    sendText(res, 200, JSON.stringify({ ok: true, app: 'openmodelica-viewer', desktop: true }), 'application/json; charset=utf-8');
    return;
  }

  if (url.pathname === '/__omv_local__/file') {
    const filePath = localPathFromUrl(url);
    if (!filePath) {
      sendText(res, 400, 'Missing path');
      return;
    }

    let stat;
    try {
      stat = await fsp.stat(filePath);
    } catch {
      sendText(res, 404, 'File not found');
      return;
    }

    if (!stat.isFile()) {
      sendText(res, 400, 'Path is not a file');
      return;
    }

    streamLocalFile(req, res, filePath, stat);
    return;
  }

  sendText(res, 404, 'Unknown local API endpoint');
}

async function handleStatic(req, res, url) {
  const decoded = decodeURIComponent(url.pathname);
  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const targetPath = path.resolve(staticRoot, relativePath);

  if (!targetPath.startsWith(staticRoot)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(targetPath);
  } catch {
    sendText(res, 404, 'Not found');
    return;
  }

  if (stat.isDirectory()) {
    const indexPath = path.join(targetPath, 'index.html');
    try {
      stat = await fsp.stat(indexPath);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': stat.size,
        'cache-control': 'no-store',
      });
      fs.createReadStream(indexPath).pipe(res);
    } catch {
      sendText(res, 404, 'Not found');
    }
    return;
  }

  const ext = path.extname(targetPath).toLowerCase();
  res.writeHead(200, {
    'content-type': mimeTypes.get(ext) || 'application/octet-stream',
    'content-length': stat.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(targetPath).pipe(res);
}

function listenOnAvailablePort(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${host}`);
      if (url.pathname.startsWith('/__omv_local__/')) {
        handleApi(req, res, url).catch(err => sendText(res, 500, err?.message || String(err)));
        return;
      }
      handleStatic(req, res, url).catch(err => sendText(res, 500, err?.message || String(err)));
    });

    server.on('error', err => {
      if (err.code === 'EADDRINUSE' && port < preferredPort + 50) {
        listenOnAvailablePort(port + 1).then(resolve, reject);
      } else {
        reject(err);
      }
    });
    server.listen(port, host, () => resolve({ server, port }));
  });
}

async function createWindow(url) {
  const appOrigin = appOriginFromUrl(url);
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    icon: fs.existsSync(desktopIconPath) ? desktopIconPath : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  mainWindow = win;
  win.removeMenu();

  // Full Desktop is intentionally offline-first. The packaged renderer may
  // request only its own loopback origin; external network traffic is denied.
  win.webContents.session.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      callback({ cancel: !isAllowedRendererUrl(details.url, appOrigin) });
    },
  );

  const openInSystemBrowser = targetUrl => {
    if (!isExternalWebUrl(targetUrl, appOrigin)) return;
    shell.openExternal(targetUrl).catch(err => {
      console.error('[desktop] could not open external URL', {
        url: targetUrl,
        message: err?.message || String(err),
      });
    });
  };

  // Never create secondary Electron windows. Web links belong in the user's
  // normal browser; every popup request is denied inside Electron.
  win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    openInSystemBrowser(targetUrl);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (isAllowedRendererUrl(targetUrl, appOrigin)) return;
    event.preventDefault();
    openInSystemBrowser(targetUrl);
  });

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  await win.loadURL(url);
  return win;
}

async function selectResultFilePaths(options = {}, multiple = false) {
  const result = await dialog.showOpenDialog({
    title: typeof options.title === 'string' ? options.title : 'Select result file',
    defaultPath: typeof options.defaultPath === 'string' && options.defaultPath ? options.defaultPath : undefined,
    properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: [
      { name: 'Result files', extensions: ['csv', 'txt', 'mat', 'parquet', 'nc', 'netcdf', 'pkl', 'pickle', 'xlsx', 'xlsm', 'xls', 'ods'] },
      { name: 'Spreadsheets', extensions: ['xlsx', 'xlsm', 'xls', 'ods'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return multiple ? [] : null;
  return multiple ? result.filePaths : result.filePaths[0];
}

async function selectParquetOutputPath(options = {}) {
  const defaultPath = typeof options.defaultPath === 'string' && options.defaultPath
    ? options.defaultPath
    : undefined;
  const result = await dialog.showSaveDialog({
    title: typeof options.title === 'string' ? options.title : 'Save Parquet file',
    defaultPath,
    filters: [
      { name: 'Parquet files', extensions: ['parquet'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
}

ipcMain.handle('omv:select-file-path', async (_event, options = {}) => {
  return selectResultFilePaths(options, false);
});

ipcMain.handle('omv:select-file-paths', async (_event, options = {}) => {
  return selectResultFilePaths(options, true);
});

ipcMain.handle('omv:select-parquet-output-path', async (_event, options = {}) => {
  return selectParquetOutputPath(options);
});

ipcMain.handle('omv:delete-temporary-parquet', async (_event, options = {}) => {
  const rawPath = typeof options.path === 'string' ? options.path : '';
  return deleteTemporaryParquetPath(rawPath);
});

ipcMain.handle('omv:read-file', async (_event, options = {}) => {
  try {
    const rawPath = typeof options.path === 'string' ? options.path : '';
    if (!rawPath.trim()) {
      const err = new Error('Missing path');
      err.code = 'EINVAL';
      throw err;
    }

    const filePath = path.resolve(rawPath);
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      const err = new Error('Path is not a file');
      err.code = 'EINVAL';
      throw err;
    }

    // Each poll opens a read-only handle and closes it immediately; no watcher or
    // long-lived stream is kept against files that simulators are writing.
    const buffer = await fsp.readFile(filePath);
    const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return {
      ok: true,
      ...fileInfoPayload(filePath, stat),
      bytes,
    };
  } catch (err) {
    return desktopReadErrorPayload(err);
  }
});

ipcMain.handle('omv:stat-file', async (_event, options = {}) => {
  try {
    const rawPath = typeof options.path === 'string' ? options.path : '';
    if (!rawPath.trim()) {
      const err = new Error('Missing path');
      err.code = 'EINVAL';
      throw err;
    }
    const filePath = path.resolve(rawPath);
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      const err = new Error('Path is not a file');
      err.code = 'EINVAL';
      throw err;
    }
    return { ok: true, ...fileInfoPayload(filePath, stat) };
  } catch (err) {
    return desktopReadErrorPayload(err);
  }
});

ipcMain.handle('omv:read-file-slice', async (_event, options = {}) => {
  let handle = null;
  try {
    const rawPath = typeof options.path === 'string' ? options.path : '';
    if (!rawPath.trim()) {
      const err = new Error('Missing path');
      err.code = 'EINVAL';
      throw err;
    }
    const filePath = path.resolve(rawPath);
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      const err = new Error('Path is not a file');
      err.code = 'EINVAL';
      throw err;
    }

    const start = Math.max(0, Math.floor(Number(options.start) || 0));
    const end = Math.min(stat.size, Math.max(start, Math.floor(Number(options.end ?? stat.size))));
    const length = Math.max(0, end - start);
    const buffer = Buffer.allocUnsafe(length);

    handle = await fsp.open(filePath, 'r');
    const read = length ? await handle.read(buffer, 0, length, start) : { bytesRead: 0 };
    const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + read.bytesRead);
    return {
      ok: true,
      ...fileInfoPayload(filePath, stat),
      start,
      end: start + read.bytesRead,
      bytes,
    };
  } catch (err) {
    return desktopReadErrorPayload(err);
  } finally {
    if (handle) {
      try { await handle.close(); } catch (_) {}
    }
  }
});

ipcMain.handle('omv:convert-to-parquet', async (_event, options = {}) => {
  try {
    const rawPath = typeof options.path === 'string' ? options.path : '';
    if (!rawPath.trim()) {
      const err = new Error('Missing path');
      err.code = 'EINVAL';
      throw err;
    }

    const filePath = path.resolve(rawPath);
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) {
      const err = new Error('Path is not a file');
      err.code = 'EINVAL';
      throw err;
    }

    const temporary = options.temporary === true;
    const outputPath = await chooseParquetOutputPath(filePath, stat, options.outputPath, { temporary });
    const fingerprint = csvFingerprint(filePath, stat);
    const overwrite = options.overwrite === true;
    let outputStat = null;
    try { outputStat = await fsp.stat(outputPath); } catch (_) { outputStat = null; }
    if (!overwrite && outputStat?.isFile() && outputStat.mtimeMs >= stat.mtimeMs) {
      if (temporary) temporaryParquetPaths.add(outputPath);
      return {
        ok: true,
        cached: true,
        temporary,
        fingerprint,
        inputPath: filePath,
        outputPath,
        inputBytes: stat.size,
        outputBytes: outputStat.size,
        elapsedMs: 0,
      };
    }

    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    const { convertCsvToParquet } = await loadCsvToParquetCore();
    const result = await convertCsvToParquet({
      inputPath: filePath,
      outputPath,
      csvProfile: options.csvProfile || null,
      compression: options.compression || 'zstd',
      overwrite: true,
    });

    if (temporary) temporaryParquetPaths.add(result.outputPath);
    return {
      ok: true,
      cached: false,
      temporary,
      fingerprint,
      ...result,
    };
  } catch (err) {
    return {
      ok: false,
      name: err?.name || 'Error',
      code: err?.code || '',
      message: err?.message || 'CSV-to-Parquet conversion failed',
    };
  }
});

app.on('before-quit', cleanupTrackedTemporaryParquets);
app.on('will-quit', cleanupTrackedTemporaryParquets);

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  await sweepTemporaryParquetOrphans();
  await fsp.access(path.join(staticRoot, 'index.html'));
  const { port } = await listenOnAvailablePort(preferredPort);
  await createWindow(`http://${host}:${port}/index.html`);
}).catch(err => {
  console.error('[desktop] startup failed', {
    projectRoot,
    staticRoot,
    message: err?.message || String(err),
    stack: err?.stack || '',
  });
  try {
    dialog.showErrorBox('Time Series Explorer startup failed', err?.message || String(err));
  } catch (_) {}
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const { port } = await listenOnAvailablePort(preferredPort);
    await createWindow(`http://${host}:${port}/index.html`);
  }
});
