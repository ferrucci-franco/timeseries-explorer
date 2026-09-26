// Fetch DuckDB's Parquet module into the app, so Parquet works offline.
//
//   node scripts/fetch-duckdb-extensions.mjs            (warns and carries on if offline)
//   OMV_REQUIRE_DUCKDB_EXTENSIONS=1 node scripts/...     (fails instead; CI and releases)
//
// DuckDB-WASM loads Parquet support as a separate module, downloaded from
// extensions.duckdb.org the first time a Parquet file is read. This script
// downloads it once, at build time, into public/duckdb-extensions/, which Vite
// copies into the built app. src/data/duckdb-extensions.js explains how the
// app picks it up at run time.
//
// The version comes from the engine itself (`SELECT version()` on the
// DuckDB-WASM in node_modules), so upgrading @duckdb/duckdb-wasm fetches the
// matching module and removes the old one. Files already present with the
// hash the manifest recorded are kept, so repeated builds do not download.
//
// Nothing here checks the module's signature: the engine does, on every load,
// and refuses a module that is not signed by DuckDB.

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    DUCKDB_BUNDLED_EXTENSIONS,
    DUCKDB_EXTENSIONS_DIR,
    DUCKDB_EXTENSIONS_MANIFEST,
    DUCKDB_EXTENSIONS_REMOTE,
    DUCKDB_WASM_PLATFORMS,
    extensionFilePath,
} from '../src/data/duckdb-extensions.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(process.env.OMV_DUCKDB_EXTENSIONS_OUT || path.join(projectRoot, 'public', DUCKDB_EXTENSIONS_DIR));
// Overridable for the offline test (scripts/test-fetch-duckdb-extensions.mjs).
const remote = (process.env.OMV_DUCKDB_EXTENSIONS_REMOTE || DUCKDB_EXTENSIONS_REMOTE).replace(/\/+$/, '');
const required = process.argv.includes('--require') || /^(1|true|yes)$/i.test(process.env.OMV_REQUIRE_DUCKDB_EXTENSIONS || '');
const ATTEMPTS = 4;
const TIMEOUT_MS = 120000;
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];

async function engineVersion() {
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs', { paths: [projectRoot] });
    const duckdb = require(entry);
    const dist = path.dirname(entry);
    const db = await duckdb.createDuckDB({
        mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
        eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
    }, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
    await db.instantiate();
    db.open({});
    const conn = db.connect();
    try {
        const version = String(conn.query('SELECT version() AS v').toArray()[0]?.toJSON().v || '');
        if (!/^v\d+\.\d+\.\d+/.test(version)) throw new Error(`unexpected engine version "${version}"`);
        return version;
    } finally {
        try { conn.close(); } catch { /* the process exits next */ }
    }
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

async function readManifest() {
    try {
        return JSON.parse(await fs.readFile(path.join(outputRoot, DUCKDB_EXTENSIONS_MANIFEST), 'utf8'));
    } catch {
        return null;
    }
}

async function download(url) {
    let lastError = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (bytes.length < 1024 || WASM_MAGIC.some((b, i) => bytes[i] !== b)) {
                throw new Error(`not a WebAssembly module (${bytes.length} bytes)`);
            }
            return bytes;
        } catch (err) {
            lastError = err;
            // A refusal will not change on retry (404: the version has no such
            // module; 403: a network policy), a timeout or a 5xx might.
            if (/^HTTP 4(?!08|29)\d\d/.test(err?.message || '')) break;
            if (attempt < ATTEMPTS) await new Promise(resolve => setTimeout(resolve, 2000 * 2 ** (attempt - 1)));
        }
    }
    throw new Error(`${url}: ${lastError?.cause?.message || lastError?.message || lastError}`);
}

// Only the current version's folder stays: an old module would ship in every
// build and never be read.
async function removeStaleVersions(version) {
    let entries = [];
    try { entries = await fs.readdir(outputRoot, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== version) {
            await fs.rm(path.join(outputRoot, entry.name), { recursive: true, force: true });
        }
    }
}

async function main() {
    const version = await engineVersion();
    const previous = await readManifest();
    const files = {};
    const failures = [];

    for (const platform of DUCKDB_WASM_PLATFORMS) {
        for (const name of DUCKDB_BUNDLED_EXTENSIONS) {
            const relative = extensionFilePath(version, platform, name);
            const target = path.join(outputRoot, ...relative.split('/'));
            const known = previous?.files?.[relative];
            if (known && existsSync(target)) {
                const bytes = await fs.readFile(target);
                if (sha256(bytes) === known.sha256) {
                    files[relative] = known;
                    continue;
                }
            }
            try {
                const bytes = await download(`${remote}/${relative}`);
                await fs.mkdir(path.dirname(target), { recursive: true });
                await fs.writeFile(target, bytes);
                files[relative] = { bytes: bytes.length, sha256: sha256(bytes) };
                console.log(`duckdb extensions: fetched ${relative} (${(bytes.length / 1048576).toFixed(1)} MB)`);
            } catch (err) {
                failures.push(err.message);
                await fs.rm(target, { force: true });
            }
        }
    }

    await fs.mkdir(outputRoot, { recursive: true });
    await removeStaleVersions(version);
    const manifestPath = path.join(outputRoot, DUCKDB_EXTENSIONS_MANIFEST);
    if (Object.keys(files).length) {
        const manifest = { duckdb: version, source: remote, files };
        await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    } else {
        await fs.rm(manifestPath, { force: true });
        try { await fs.rmdir(outputRoot); } catch { /* not empty: leave it */ }
    }

    if (failures.length) {
        const detail = failures.map(line => `  - ${line}`).join('\n');
        if (required) {
            console.error(`duckdb extensions: could not fetch\n${detail}`);
            process.exit(1);
        }
        console.warn(`duckdb extensions: could not fetch; this build will download Parquet support from ${DUCKDB_EXTENSIONS_REMOTE} when it is first used\n${detail}`);
    } else {
        console.log(`duckdb extensions: ${Object.keys(files).length} module(s) for DuckDB ${version} in ${path.relative(projectRoot, outputRoot) || '.'}`);
    }
    process.exit(0);
}

main().catch(err => {
    console.error(`duckdb extensions: ${err?.stack || err}`);
    process.exit(required ? 1 : 0);
});
