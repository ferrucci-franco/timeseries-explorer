const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const staticRoot = path.join(projectRoot, 'dist');
const host = '127.0.0.1';
const preferredPort = Number(process.env.OMV_DESKTOP_PORT || 8876);

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.mat', 'application/octet-stream'],
  ['.wasm', 'application/wasm'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

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

    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'content-type': mimeTypes.get(ext) || 'application/octet-stream',
      'content-length': stat.size,
      'last-modified': stat.mtime.toUTCString(),
      'x-omv-last-modified': String(stat.mtimeMs),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };

    if (stat.size === 0) {
      res.writeHead(200, headers);
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath, { start: 0, end: stat.size - 1 });
    stream.once('open', () => {
      res.writeHead(200, headers);
      stream.pipe(res);
    });
    stream.once('error', err => {
      if (res.headersSent) {
        res.destroy(err);
        return;
      }
      const code = err?.code === 'ENOENT' ? 404 : 409;
      sendText(res, code, code === 409 ? 'File temporarily unavailable' : 'File not found');
    });
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadURL(url);
}

ipcMain.handle('omv:select-file-path', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Result files', extensions: ['csv', 'txt', 'mat', 'parquet'] },
      { name: 'All files', extensions: ['*'] },
    ],
  });
  return result.canceled ? null : result.filePaths[0];
});

app.whenReady().then(async () => {
  await fsp.access(path.join(staticRoot, 'index.html'));
  const { port } = await listenOnAvailablePort(preferredPort);
  await createWindow(`http://localhost:${port}/index.html`);
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
