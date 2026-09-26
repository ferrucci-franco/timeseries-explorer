// The build step that puts DuckDB's Parquet module inside the app, and the
// rule the app uses to find it. Offline: a local server stands in for
// extensions.duckdb.org.
//
//   node scripts/test-fetch-duckdb-extensions.mjs
//
// Checked: the module lands where the engine looks for it, under the engine's
// own version; the manifest lists it with its hash; a second build downloads
// nothing; an old version's folder is removed; something that is not a
// WebAssembly module is refused; a failed download stops a release build but
// only warns a local one; and the app's lookup turns the manifest into the URL
// it hands the engine, or into nothing.

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DUCKDB_BUNDLED_EXTENSIONS,
    DUCKDB_WASM_PLATFORMS,
    extensionFilePath,
    localExtensionRepository,
} from '../src/data/duckdb-extensions.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(projectRoot, 'scripts', 'fetch-duckdb-extensions.mjs');
let checks = 0;
const check = async (label, fn) => { await fn(); checks++; };

// ─── The lookup the app runs in the browser ───────────────────────────────

await check('lookup', () => {
    const manifest = { duckdb: 'v1.4.3', files: { [extensionFilePath('v1.4.3', 'wasm_eh', 'parquet')]: { bytes: 1, sha256: 'x' } } };
    const where = { version: 'v1.4.3', platform: 'wasm_eh', name: 'parquet', baseUrl: 'https://example.org/app/index.html' };
    assert.equal(extensionFilePath('v1.4.3', 'wasm_eh', 'parquet'), 'v1.4.3/wasm_eh/parquet.duckdb_extension.wasm',
        'the layout DuckDB requests');
    assert.equal(localExtensionRepository(manifest, where), 'https://example.org/app/duckdb-extensions',
        'absolute, next to the page, no trailing slash');
    assert.equal(localExtensionRepository(manifest, { ...where, baseUrl: 'http://127.0.0.1:5173/' }), 'http://127.0.0.1:5173/duckdb-extensions');
    assert.equal(localExtensionRepository(manifest, { ...where, platform: 'wasm_mvp' }), null, 'a build the manifest does not list');
    assert.equal(localExtensionRepository(manifest, { ...where, version: 'v1.5.0' }), null, 'another engine version');
    assert.equal(localExtensionRepository(manifest, { ...where, name: 'json' }), null, 'another module');
    for (const notAManifest of [null, undefined, '<!doctype html>', 42, {}, { files: null }]) {
        assert.equal(localExtensionRepository(notAManifest, where), null, `${JSON.stringify(notAManifest)} is no manifest`);
    }
    assert.equal(localExtensionRepository(manifest, { ...where, baseUrl: '' }), null, 'no page URL, no guess');
});

// ─── The build step, against a stand-in server ────────────────────────────

const engineVersion = (() => {
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import { createRequire } from 'node:module';
        import path from 'node:path';
        const require = createRequire(${JSON.stringify(path.join(projectRoot, 'package.json'))});
        const entry = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
        const duckdb = require(entry);
        const dist = path.dirname(entry);
        const db = await duckdb.createDuckDB({
            mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
            eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
        }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
        await db.instantiate(); db.open({});
        console.log(db.connect().query('SELECT version() AS v').toArray()[0].toJSON().v);
        process.exit(0);
    `], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
})();

const moduleBytes = platform => {
    const bytes = Buffer.alloc(4096, platform.length);
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]).copy(bytes);
    Buffer.from(platform).copy(bytes, 16);
    return bytes;
};

const requests = [];
let mode = 'ok';
const server = http.createServer((req, res) => {
    requests.push(req.url);
    const match = req.url.match(/^\/(v[^/]+)\/(wasm_[a-z]+)\/([a-z_]+)\.duckdb_extension\.wasm$/);
    if (mode === 'missing' || !match) { res.writeHead(404); res.end(); return; }
    if (mode === 'html') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html>'.padEnd(4096, ' ')); return; }
    res.writeHead(200, { 'content-type': 'application/wasm' });
    res.end(moduleBytes(match[2]));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const remote = `http://127.0.0.1:${server.address().port}`;
const outDir = mkdtempSync(path.join(os.tmpdir(), 'omv-duckdb-ext-'));

// Asynchronous on purpose: the stand-in server lives in this process, and a
// synchronous spawn would stop it from answering the script it is waiting on.
function run(env = {}, args = []) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, ...args], {
            env: {
                ...process.env,
                OMV_DUCKDB_EXTENSIONS_OUT: outDir,
                OMV_DUCKDB_EXTENSIONS_REMOTE: remote,
                OMV_REQUIRE_DUCKDB_EXTENSIONS: '',
                NO_PROXY: '127.0.0.1,localhost',
                no_proxy: '127.0.0.1,localhost',
                ...env,
            },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', status => resolve({ status, stdout, stderr }));
    });
}
const expected = DUCKDB_WASM_PLATFORMS.flatMap(platform => DUCKDB_BUNDLED_EXTENSIONS.map(name => extensionFilePath(engineVersion, platform, name)));
const readManifest = () => JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8'));

try {
    await check('first build downloads', async () => {
        mkdirSync(path.join(outDir, 'v0.9.0', 'wasm_eh'), { recursive: true });
        writeFileSync(path.join(outDir, 'v0.9.0', 'wasm_eh', 'parquet.duckdb_extension.wasm'), 'old');
        const out = await run();
        assert.equal(out.status, 0, out.stderr);
        assert.deepEqual(requests.sort(), expected.map(p => `/${p}`).sort(), 'one request per engine build, at the engine version');
        const manifest = readManifest();
        assert.equal(manifest.duckdb, engineVersion);
        assert.deepEqual(Object.keys(manifest.files).sort(), [...expected].sort());
        for (const relative of expected) {
            const bytes = readFileSync(path.join(outDir, ...relative.split('/')));
            const platform = relative.split('/')[1];
            assert.deepEqual(bytes, moduleBytes(platform), `${relative} is the served module`);
            assert.equal(manifest.files[relative].sha256, createHash('sha256').update(bytes).digest('hex'));
            assert.equal(manifest.files[relative].bytes, bytes.length);
        }
        assert.equal(existsSync(path.join(outDir, 'v0.9.0')), false, 'an old version is removed');
        assert.equal(localExtensionRepository(manifest, { version: engineVersion, platform: 'wasm_eh', name: 'parquet', baseUrl: 'http://x/' }),
            'http://x/duckdb-extensions', 'what the build writes is what the app reads');
    });

    await check('second build downloads nothing', async () => {
        requests.length = 0;
        const out = await run();
        assert.equal(out.status, 0, out.stderr);
        assert.deepEqual(requests, [], 'files matching the manifest are kept');
    });

    await check('a changed file is fetched again', async () => {
        requests.length = 0;
        writeFileSync(path.join(outDir, ...expected[0].split('/')), 'tampered');
        const out = await run();
        assert.equal(out.status, 0, out.stderr);
        assert.deepEqual(requests, [`/${expected[0]}`]);
        assert.deepEqual(readFileSync(path.join(outDir, ...expected[0].split('/'))), moduleBytes(expected[0].split('/')[1]));
    });

    await check('a page is not a module', async () => {
        rmSync(outDir, { recursive: true, force: true });
        mode = 'html';
        const soft = await run();
        assert.equal(soft.status, 0, 'a local build carries on');
        assert.match(soft.stderr, /not a WebAssembly module/);
        assert.match(soft.stderr, /will download Parquet support from https:\/\/extensions\.duckdb\.org/);
        assert.equal(existsSync(path.join(outDir, 'manifest.json')), false, 'no manifest, so the app uses the public download');
        assert.equal(existsSync(path.join(outDir, ...expected[0].split('/'))), false, 'nothing half-written stays');
    });

    await check('a release build stops', async () => {
        mode = 'missing';
        requests.length = 0;
        const hard = await run({ OMV_REQUIRE_DUCKDB_EXTENSIONS: '1' });
        assert.equal(hard.status, 1, 'a release must not ship without it');
        assert.match(hard.stderr, /HTTP 404/);
        assert.equal(requests.length, expected.length, 'a 404 is not retried');
        const flag = await run({}, ['--require']);
        assert.equal(flag.status, 1, '--require does the same');
    });
} finally {
    server.close();
    rmSync(outDir, { recursive: true, force: true });
}

// ─── Wired into every build that ships the app ────────────────────────────

await check('wiring', () => {
    const pkg = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    assert.match(pkg.scripts['build:web'], /^node scripts\/fetch-duckdb-extensions\.mjs && vite build$/, 'every web build fetches first');
    for (const [name, command] of Object.entries(pkg.scripts)) {
        if (/^desktop:(pack|dist)/.test(name) && /electron-builder/.test(command)) {
            assert.match(command, /npm run build:web/, `${name} builds the web app, and so fetches`);
        }
    }
    const workflow = file => readFileSync(path.join(projectRoot, '.github', 'workflows', file), 'utf8');
    for (const file of ['pages.yml', 'desktop-release.yml', 'ci.yml']) {
        assert.match(workflow(file), /OMV_REQUIRE_DUCKDB_EXTENSIONS: ['"]?1/, `${file} refuses to ship without the module`);
    }
    const ci = workflow('ci.yml');
    assert.ok(ci.indexOf('fetch:duckdb-extensions') > 0 && ci.indexOf('fetch:duckdb-extensions') < ci.indexOf('npm run e2e'),
        'CI fetches before the browser checks, which serve public/ directly');
    const ignored = readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');
    assert.match(ignored, /^\/public\/duckdb-extensions\/$/m, 'the fetched binaries are not committed');
});

console.log(`fetch duckdb extensions: ${checks} checks passed`);
