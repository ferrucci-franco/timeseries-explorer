const fs = require('node:fs');
const path = require('node:path');

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.csv', 'text/csv; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.parquet', 'application/octet-stream'],
  ['.mat', 'application/octet-stream'],
  ['.wasm', 'application/wasm'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

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
  fileInfoPayload,
  localFileHeaders,
  mimeTypeForPath,
  mimeTypes,
  parseRangeHeader,
  streamLocalFile,
};
