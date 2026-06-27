const { app, BrowserWindow, dialog, ipcMain } = require('electron');
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

const projectRoot = path.resolve(__dirname, '..');
const staticRoot = path.join(projectRoot, 'dist');
const desktopIconPath = path.join(projectRoot, 'build', 'icons', 'timeseries-explorer-icon.png');
const host = '127.0.0.1';
const preferredPort = Number(process.env.OMV_DESKTOP_PORT || 8876);
let csvToParquetCorePromise = null;
let mainWindow = null;

if (process.env.OMV_REMOTE_DEBUGGING_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', String(process.env.OMV_REMOTE_DEBUGGING_PORT));
}

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

async function chooseParquetOutputPath(inputPath, stat, requestedPath = '') {
  if (requestedPath && String(requestedPath).trim()) return path.resolve(requestedPath);
  const fingerprint = csvFingerprint(inputPath, stat);
  const name = parquetCacheName(inputPath, fingerprint);
  const adjacent = path.resolve(path.dirname(inputPath), name);
  if (await canWriteDirectory(path.dirname(inputPath))) return adjacent;
  const cacheDir = path.join(app.getPath('userData'), 'parquet-cache');
  await fsp.mkdir(cacheDir, { recursive: true });
  return path.join(cacheDir, name);
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
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    icon: fs.existsSync(desktopIconPath) ? desktopIconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow = win;
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
      { name: 'Result files', extensions: ['csv', 'txt', 'mat', 'parquet'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return multiple ? [] : null;
  return multiple ? result.filePaths : result.filePaths[0];
}

ipcMain.handle('omv:select-file-path', async (_event, options = {}) => {
  return selectResultFilePaths(options, false);
});

ipcMain.handle('omv:select-file-paths', async (_event, options = {}) => {
  return selectResultFilePaths(options, true);
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

    const outputPath = await chooseParquetOutputPath(filePath, stat, options.outputPath);
    const fingerprint = csvFingerprint(filePath, stat);
    const overwrite = options.overwrite === true;
    let outputStat = null;
    try { outputStat = await fsp.stat(outputPath); } catch (_) { outputStat = null; }
    if (!overwrite && outputStat?.isFile() && outputStat.mtimeMs >= stat.mtimeMs) {
      return {
        ok: true,
        cached: true,
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

    return {
      ok: true,
      cached: false,
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

app.whenReady().then(async () => {
  await fsp.access(path.join(staticRoot, 'index.html'));
  const { port } = await listenOnAvailablePort(preferredPort);
  await createWindow(`http://localhost:${port}/index.html`);
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
    await createWindow(`http://localhost:${port}/index.html`);
  }
});
