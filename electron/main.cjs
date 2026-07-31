const { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } = require('electron');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  AUDIO_FILE_EXTENSIONS,
  fileInfoPayload,
  isTrustedLoopbackRequest,
  mimeTypes,
  mimeTypeForPath,
  streamLocalFile,
} = require('./local-file-http.cjs');
const {
  appOriginFromUrl,
  isAllowedRendererUrl,
  isExternalOpenUrl,
} = require('./navigation-policy.cjs');
const {
  DEFAULT_ZOOM_FACTOR,
  MAX_ZOOM_FACTOR,
  MIN_ZOOM_FACTOR,
  normalizeZoomFactor,
  stepZoomFactor,
} = require('./zoom-levels.cjs');

const projectRoot = path.resolve(__dirname, '..');
const staticRoot = path.join(projectRoot, 'dist');
const desktopIconPath = path.join(projectRoot, 'build', 'icons', 'timeseries-explorer-icon.png');
const host = '127.0.0.1';
const preferredPort = Number(process.env.OMV_DESKTOP_PORT || 8876);
let csvToParquetCorePromise = null;
let mainWindow = null;
const temporaryParquetPaths = new Set();
let temporaryParquetSessionDir = null;
let desktopZoomFactor = DEFAULT_ZOOM_FACTOR;
let zoomWriteTimer = null;

if (process.env.OMV_REMOTE_DEBUGGING_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', String(process.env.OMV_REMOTE_DEBUGGING_PORT));
}

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

ipcMain.on('omv:set-theme', (_event, theme) => {
  nativeTheme.themeSource = theme === 'dark' ? 'dark' : 'light';
});

// ─── Window zoom ────────────────────────────────────────────────────────────
//
// setZoomFactor() is the same mechanism Ctrl +/- drives in a browser: the
// viewport changes size in CSS pixels, so media queries re-evaluate,
// devicePixelRatio follows, and Plotly re-lays-out through the resize event it
// already listens to -- measured at 125%, a panel went from 484 to 353 CSS px
// and its canvas backing store was rebuilt to match. A CSS transform on a
// wrapper would instead have stretched the bitmap Plotly had already drawn.
//
// The chosen factor is kept by the main process rather than in localStorage
// because the renderer's origin is not stable: the local server starts on 8876
// but walks up to 8877+ when that port is taken (a second instance), and
// per-origin storage would silently lose the setting on that run.

function desktopSettingsPath() {
  return path.join(app.getPath('userData'), 'desktop-settings.json');
}

function readDesktopSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(desktopSettingsPath(), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    // No file yet, or one we cannot parse. Either way the defaults stand.
    return {};
  }
}

function writeZoomFactorNow() {
  zoomWriteTimer = null;
  try {
    const settings = readDesktopSettings();
    settings.zoomFactor = desktopZoomFactor;
    fs.mkdirSync(path.dirname(desktopSettingsPath()), { recursive: true });
    fs.writeFileSync(desktopSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (err) {
    // A preference that cannot be remembered is not worth interrupting over.
    console.error('[desktop] could not save the zoom factor', err?.message || err);
  }
}

// Holding + walks the ladder in a few clicks; each one should not be its own
// disk write. The timer is deliberately NOT unref'd: in the main process the
// Node loop is pumped by Chromium's, and an unref'd timer does not schedule a
// wake-up of its own -- it simply never fired on an otherwise idle app, and the
// setting was silently never saved. Quitting inside the window still flushes.
function scheduleZoomFactorWrite() {
  if (zoomWriteTimer) clearTimeout(zoomWriteTimer);
  zoomWriteTimer = setTimeout(writeZoomFactorNow, 300);
}

function flushZoomFactorWrite() {
  if (!zoomWriteTimer) return;
  clearTimeout(zoomWriteTimer);
  writeZoomFactorNow();
}

function loadStoredZoomFactor() {
  desktopZoomFactor = normalizeZoomFactor(readDesktopSettings().zoomFactor);
  return desktopZoomFactor;
}

// The single place the zoom changes. The menu buttons and the keyboard
// accelerators both land here, so the window, the stored value and the
// percentage the menu shows can never disagree.
function applyZoomFactor(win, factor) {
  const next = normalizeZoomFactor(factor);
  desktopZoomFactor = next;
  if (win && !win.isDestroyed()) {
    win.webContents.setZoomFactor(next);
    win.webContents.send('omv:zoom-changed', next);
  }
  scheduleZoomFactorWrite();
  return next;
}

ipcMain.handle('omv:get-zoom', () => ({
  factor: desktopZoomFactor,
  min: MIN_ZOOM_FACTOR,
  max: MAX_ZOOM_FACTOR,
}));

// The renderer names a direction, never a factor: the ladder stays in one
// place and there is no arbitrary number to validate coming across the bridge.
ipcMain.handle('omv:set-zoom', (event, options = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  return applyZoomFactor(win, stepZoomFactor(desktopZoomFactor, options?.action));
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

async function handleApi(req, res, url, port) {
  // The local API reads the user's disk. Only the app's own renderer may ask.
  if (!isTrustedLoopbackRequest(req, port)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

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

  // A bare prefix match treats a sibling that merely starts with the same
  // characters as inside the root: with staticRoot=/app/dist, /app/dist-secret
  // would pass. The separator is what makes it a containment test.
  if (targetPath !== staticRoot && !targetPath.startsWith(staticRoot + path.sep)) {
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
        handleApi(req, res, url, port).catch(err => sendText(res, 500, err?.message || String(err)));
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
  const startupZoomFactor = loadStoredZoomFactor();
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
      // Set here so the first frame is already at the right size: applying the
      // zoom only after the load would show the window at 100% and then jump.
      zoomFactor: startupZoomFactor,
    },
  });

  mainWindow = win;
  win.removeMenu();

  // Belt and braces for the line above: webPreferences.zoomFactor has been
  // unreliable across Electron versions, and a reload after a renderer crash
  // starts from the session's own zoom rather than ours.
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.setZoomFactor(desktopZoomFactor);
  });

  // The zoom accelerators every desktop app is expected to have. Electron gets
  // them from the application menu's zoomIn/zoomOut/resetZoom roles, and this
  // app removes that menu, so without this they simply do nothing.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.alt) return;
    const accelerator = process.platform === 'darwin' ? input.meta : input.control;
    if (!accelerator) return;
    // '=' and '_' are the unshifted keys the user actually presses for + and -.
    const action = ['+', '='].includes(input.key) ? 'in'
      : ['-', '_'].includes(input.key) ? 'out'
        : input.key === '0' ? 'reset'
          : null;
    if (!action) return;
    event.preventDefault();
    applyZoomFactor(win, stepZoomFactor(desktopZoomFactor, action));
  });

  // The one failure the renderer cannot report on its own.
  //
  // Everywhere else a failed load ends in an in-app dialog. If the renderer
  // process itself is killed — almost always for memory, on a file too large to
  // hold — no JavaScript runs, so there is nothing left to draw a dialog with
  // and the window simply goes blank. Only the main process is still alive to
  // say what happened. The browser build has no equivalent: this is one of the
  // few things that is genuinely desktop-only.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[desktop] renderer gone', details);
    // 'clean-exit' is a normal shutdown and 'killed' is usually the user or the
    // OS doing it deliberately. Neither deserves an alarming popup.
    if (details?.reason === 'clean-exit' || details?.reason === 'killed') return;

    const outOfMemory = details?.reason === 'oom';
    dialog.showMessageBox(win, {
      type: 'error',
      title: 'Time Series Explorer',
      message: outOfMemory
        ? 'The application ran out of memory and had to restart the view.'
        : 'The application view stopped unexpectedly and was restarted.',
      detail: outOfMemory
        ? 'This normally happens with a file too large to hold in memory all at once.\n\n'
          + 'Converting it to Parquet lets the app read it in pieces instead. You can also lower the '
          + 'full-load limit for that format in Settings → File loading, so the warning comes earlier.'
        : `Reason reported by the system: ${details?.reason || 'unknown'}.\n\n`
          + 'Loaded files were not saved. If this repeats with the same file it is worth reporting.',
      buttons: ['Reload', 'Close'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    }).then(({ response }) => {
      if (response === 0 && !win.isDestroyed()) win.reload();
    }).catch(err => {
      console.error('[desktop] could not show the renderer-gone dialog', err);
    });
  });

  // Full Desktop is intentionally offline-first. The packaged renderer may
  // request only its own loopback origin; external network traffic is denied.
  win.webContents.session.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      callback({ cancel: !isAllowedRendererUrl(details.url, appOrigin) });
    },
  );

  const openInSystemBrowser = targetUrl => {
    if (!isExternalOpenUrl(targetUrl, appOrigin)) return;
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
    // A caller that can only handle some of these says so. The Parquet
    // converter has no reader for .mat or .pkl, and offering them in its own
    // dialog would only let the user pick a file it then has to refuse.
    filters: Array.isArray(options.filters) && options.filters.length ? options.filters : [
      { name: 'Result files', extensions: ['csv', 'txt', 'mat', 'parquet', 'nc', 'netcdf', 'pkl', 'pickle', 'xlsx', 'xlsm', 'xls', 'ods', ...AUDIO_FILE_EXTENSIONS] },
      { name: 'Spreadsheets', extensions: ['xlsx', 'xlsm', 'xls', 'ods'] },
      { name: 'Audio recordings', extensions: [...AUDIO_FILE_EXTENSIONS] },
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

// Spreadsheets have no path the converter can read: the app turns the chosen
// sheet into CSV text in a worker, so what it holds is bytes, not a file. Those
// are staged into a temp file here — in the main process, where the cleanup
// already lives — converted, and removed again. Staging in the renderer would
// mean a second IPC and a temp file nobody owns if the window closes mid-way.
async function stageBytesForConversion(bytes, suggestedName = 'sheet.csv') {
  const dir = path.join(temporaryParquetSessionRoot(), 'staged');
  await fsp.mkdir(dir, { recursive: true });
  const safe = String(suggestedName).replace(/[^A-Za-z0-9._-]/g, '_') || 'sheet.csv';
  const staged = path.join(dir, `${Date.now()}-${safe}`);
  await fsp.writeFile(staged, Buffer.from(bytes));
  return staged;
}

ipcMain.handle('omv:convert-to-parquet', async (_event, options = {}) => {
  let stagedInput = '';
  try {
    const rawPath = typeof options.path === 'string' ? options.path : '';
    if (!rawPath.trim() && !options.bytes) {
      const err = new Error('Missing path');
      err.code = 'EINVAL';
      throw err;
    }
    if (!rawPath.trim()) {
      stagedInput = await stageBytesForConversion(options.bytes, options.sourceName || 'sheet.csv');
    }

    const filePath = path.resolve(stagedInput || rawPath);
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
  } finally {
    // The staged CSV is an implementation detail of this call and must not
    // outlive it, whether the conversion succeeded or not.
    if (stagedInput) {
      try { await fsp.rm(stagedInput, { force: true }); } catch (_) { /* best effort */ }
    }
  }
});

app.on('before-quit', cleanupTrackedTemporaryParquets);
app.on('will-quit', cleanupTrackedTemporaryParquets);
app.on('before-quit', flushZoomFactorWrite);

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
