import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseRangeHeader, streamLocalFile } = require('../electron/local-file-http.cjs');

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

    console.log('Local file HTTP range checks passed.');
} finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
}
