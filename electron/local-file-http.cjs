const fs = require('node:fs');
const path = require('node:path');

// Recordings the viewer reads as one signal per channel. Kept beside the MIME
// map because the two lists describe the same set of files, and the file dialog
// in main.cjs needs the extensions on their own.
const AUDIO_FILE_EXTENSIONS = [
  'wav', 'wave',
  'mp3',
  'm4a', 'm4b', 'aac',
  'flac',
  'ogg', 'oga', 'opus',
  'aif', 'aiff', 'aifc',
  'caf',
  '3gp', '3gpp', 'amr',
  'webm', 'weba',
];

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.parquet', 'application/octet-stream'],
  ['.mat', 'application/octet-stream'],
  ['.nc', 'application/x-netcdf'],
  ['.netcdf', 'application/x-netcdf'],
  ['.pkl', 'application/octet-stream'],
  ['.pickle', 'application/octet-stream'],
  ['.wav', 'audio/wav'],
  ['.wave', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.m4a', 'audio/mp4'],
  ['.m4b', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.flac', 'audio/flac'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.aif', 'audio/aiff'],
  ['.aiff', 'audio/aiff'],
  ['.aifc', 'audio/aiff'],
  ['.caf', 'audio/x-caf'],
  ['.3gp', 'audio/3gpp'],
  ['.3gpp', 'audio/3gpp'],
  ['.amr', 'audio/amr'],
  ['.webm', 'audio/webm'],
  ['.weba', 'audio/webm'],
  ['.wasm', 'application/wasm'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

// DNS rebinding is the one way a web page reaches this server. The page cannot
// read a cross-origin response, so it makes its own hostname resolve to
// 127.0.0.1 and asks again: same URL, same port, now "same origin" as far as the
// browser is concerned. The Host header still carries the attacker's hostname,
// and a browser will not let script forge it — so a request that does not
// address us as loopback on our own port is not one of ours.
//
// scripts/portable-server.mjs carries the same guard; it ships alone in the
// portable zip and cannot require this module.
function isTrustedLoopbackRequest(req, port) {
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  if (Number(port) === 80) {
    for (const bare of ['127.0.0.1', 'localhost', '[::1]']) allowed.add(bare);
  }

  const host = String(req?.headers?.host || '').toLowerCase();
  if (!allowed.has(host)) return false;

  // Same-origin GETs carry no Origin header at all; when one is present it must
  // be us. 'null' is an opaque origin (a sandboxed frame or a file:// page) and
  // is not the app.
  const origin = req?.headers?.origin;
  if (origin) {
    let originHost = '';
    try { originHost = new URL(origin).host.toLowerCase(); } catch (_) { return false; }
    if (!allowed.has(originHost)) return false;
  }
  return true;
}

function mimeTypeForPath(filePath) {
  return mimeTypes.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function fileInfoPayload(filePath, stat) {
  return {
    name: path.basename(filePath),
    path: filePath,
    size: stat.size,
    lastModified: stat.mtimeMs,
    type: mimeTypeForPath(filePath),
  };
}

function localFileHeaders(filePath, stat, extra = {}) {
  return {
    'content-type': mimeTypeForPath(filePath),
    'content-length': stat.size,
    'last-modified': stat.mtime.toUTCString(),
    'x-omv-last-modified': String(stat.mtimeMs),
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  };
}

function parseRangeHeader(rangeHeader, size) {
  const value = String(rangeHeader || '').trim();
  if (!value) return null;

  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return { unsatisfiable: true };

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return { unsatisfiable: true };
  if (!Number.isFinite(size) || size < 0) return { unsatisfiable: true };
  if (size === 0) return { unsatisfiable: true };

  let start;
  let end;

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(rawStart);
    if (!Number.isSafeInteger(start) || start < 0) return { unsatisfiable: true };
    end = rawEnd ? Number(rawEnd) : size - 1;
    if (!Number.isSafeInteger(end) || end < 0) return { unsatisfiable: true };
    if (end >= size) end = size - 1;
  }

  if (start >= size || start > end) return { unsatisfiable: true };
  return {
    start,
    end,
    length: end - start + 1,
    contentRange: `bytes ${start}-${end}/${size}`,
  };
}

function sendPlain(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

function streamLocalFile(req, res, filePath, stat) {
  const headers = localFileHeaders(filePath, stat);
  const range = parseRangeHeader(req.headers.range, stat.size);

  if (range?.unsatisfiable) {
    res.writeHead(416, {
      ...headers,
      'content-length': 0,
      'content-range': `bytes */${stat.size}`,
    });
    res.end();
    return;
  }

  if (range) {
    const rangeHeaders = {
      ...headers,
      'content-length': range.length,
      'content-range': range.contentRange,
    };
    if (req.method === 'HEAD') {
      res.writeHead(206, rangeHeaders);
      res.end();
      return;
    }
    const stream = fs.createReadStream(filePath, { start: range.start, end: range.end });
    stream.once('open', () => {
      res.writeHead(206, rangeHeaders);
      stream.pipe(res);
    });
    stream.once('error', err => {
      if (res.headersSent) {
        res.destroy(err);
        return;
      }
      const code = err?.code === 'ENOENT' ? 404 : 409;
      sendPlain(res, code, code === 409 ? 'File temporarily unavailable' : 'File not found');
    });
    return;
  }

  if (req.method === 'HEAD' || stat.size === 0) {
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
    sendPlain(res, code, code === 409 ? 'File temporarily unavailable' : 'File not found');
  });
}

module.exports = {
  AUDIO_FILE_EXTENSIONS,
  fileInfoPayload,
  isTrustedLoopbackRequest,
  localFileHeaders,
  mimeTypeForPath,
  mimeTypes,
  parseRangeHeader,
  streamLocalFile,
};
