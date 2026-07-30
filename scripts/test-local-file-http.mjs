import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isTrustedLoopbackRequest, parseRangeHeader, streamLocalFile } = require('../electron/local-file-http.cjs');

const dir = await mkdtemp(join(tmpdir(), 'tse-local-file-'));
const filePath = join(dir, 'sample.csv');
const text = '0123456789abcdefghijklmnopqrstuvwxyz';
await writeFile(filePath, text);

const server = http.createServer(async (req, res) => {
    const fileStat = await stat(filePath);
    streamLocalFile(req, res, filePath, fileStat);
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const url = `http://127.0.0.1:${port}/file`;

try {
    {
        const response = await fetch(url, { method: 'HEAD' });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('accept-ranges'), 'bytes');
        assert.equal(response.headers.get('content-length'), String(text.length));
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.ok(response.headers.get('x-omv-last-modified'));
    }

    {
        const response = await fetch(url, { headers: { Range: 'bytes=10-19' } });
        assert.equal(response.status, 206);
        assert.equal(response.headers.get('accept-ranges'), 'bytes');
        assert.equal(response.headers.get('content-range'), `bytes 10-19/${text.length}`);
        assert.equal(response.headers.get('content-length'), '10');
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(await response.text(), 'abcdefghij');
    }

    {
        const response = await fetch(url, { headers: { Range: `bytes=${text.length}-` } });
        assert.equal(response.status, 416);
        assert.equal(response.headers.get('content-range'), `bytes */${text.length}`);
        assert.equal(response.headers.get('accept-ranges'), 'bytes');
        assert.equal(response.headers.get('cache-control'), 'no-store');
    }

    assert.deepEqual(parseRangeHeader('bytes=2-4', 10), {
        start: 2,
        end: 4,
        length: 3,
        contentRange: 'bytes 2-4/10',
    });
    assert.deepEqual(parseRangeHeader('bytes=-3', 10), {
        start: 7,
        end: 9,
        length: 3,
        contentRange: 'bytes 7-9/10',
    });

    // DNS rebinding: the request arrives on the loopback socket, but the Host
    // header names the attacker's hostname. That is the only signal separating
    // "the app asking" from "a web page that rebound its own domain to
    // 127.0.0.1", and it must be enough to refuse.
    {
        const appRequest = { headers: { host: `127.0.0.1:${port}` } };
        assert.equal(isTrustedLoopbackRequest(appRequest, port), true, 'the app itself is trusted');
        assert.equal(
            isTrustedLoopbackRequest({ headers: { host: `localhost:${port}` } }, port),
            true,
            'localhost is the same server',
        );
        assert.equal(
            isTrustedLoopbackRequest({ headers: { host: `evil.example:${port}` } }, port),
            false,
            'a rebound hostname is refused',
        );
        assert.equal(
            isTrustedLoopbackRequest({ headers: { host: `127.0.0.1:${port + 1}` } }, port),
            false,
            'a different port is not this server',
        );
        assert.equal(isTrustedLoopbackRequest({ headers: {} }, port), false, 'no Host header, no service');
        assert.equal(
            isTrustedLoopbackRequest({ headers: { host: `127.0.0.1:${port}`, origin: 'https://evil.example' } }, port),
            false,
            'a cross-origin fetch is refused even with the right Host',
        );
        assert.equal(
            isTrustedLoopbackRequest({ headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` } }, port),
            true,
            'the app own origin is accepted when the browser sends it',
        );
    }

    console.log('Local file HTTP range checks passed.');
} finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
}
