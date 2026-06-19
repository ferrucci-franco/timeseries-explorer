import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const host = '127.0.0.1';
const preferredPort = Number(process.env.OMV_PORT || 8765);

const mimeTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.csv', 'text/csv; charset=utf-8'],
    ['.txt', 'text/plain; charset=utf-8'],
    ['.mat', 'application/octet-stream'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.svg', 'image/svg+xml'],
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
        sendText(res, 200, JSON.stringify({ ok: true, app: 'openmodelica-viewer', runtime: 'light-local' }), 'application/json; charset=utf-8');
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
            stat = await fs.stat(filePath);
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
        const stream = createReadStream(filePath, { start: 0, end: stat.size - 1 });
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
    const targetPath = path.resolve(packageRoot, relativePath);
    if (!targetPath.startsWith(packageRoot)) {
        sendText(res, 403, 'Forbidden');
        return;
    }

    let stat;
    try {
        stat = await fs.stat(targetPath);
    } catch {
        sendText(res, 404, 'Not found');
        return;
    }
    if (stat.isDirectory()) {
        const indexPath = path.join(targetPath, 'index.html');
        try {
            stat = await fs.stat(indexPath);
            res.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'content-length': stat.size,
                'cache-control': 'no-store',
            });
            createReadStream(indexPath).pipe(res);
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
    createReadStream(targetPath).pipe(res);
}

function openBrowser(url) {
    const platform = process.platform;
    const command = platform === 'win32'
        ? 'cmd'
        : platform === 'darwin'
            ? 'open'
            : 'xdg-open';
    const args = platform === 'win32'
        ? ['/c', 'start', '', url]
        : [url];
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.unref();
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

const { port } = await listenOnAvailablePort(preferredPort);
const url = `http://localhost:${port}/index.html`;
console.log(`Time Series Explorer local server`);
console.log(`Serving ${packageRoot}`);
console.log(`Open ${url}`);
openBrowser(url);
