#!/usr/bin/env node
// Checks every file listed in manifest.jsonl against its sha256.
//
//   node test-files/csv-real-world/verify.mjs           verify only (exit 1 on any problem)
//   node test-files/csv-real-world/verify.mjs --fetch   also download missing or changed files
//                                                       from their pinned source_url
//
// The corpus is only useful if the bytes are exactly what the instrument wrote, so a
// checkout that rewrote line endings or re-encoded a file shows up here as a mismatch.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const fetchMissing = process.argv.includes('--fetch');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const entries = readFileSync(join(root, 'manifest.jsonl'), 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .map(line => JSON.parse(line));

let ok = 0;
const problems = [];

for (const entry of entries) {
    const path = join(root, entry.path);
    const state = !existsSync(path) ? 'missing'
        : sha256(readFileSync(path)) !== entry.sha256 ? 'changed'
        : 'ok';
    if (state === 'ok') { ok++; continue; }
    if (!fetchMissing) { problems.push(`${state}: ${entry.path}`); continue; }

    try {
        const response = await fetch(entry.source_url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (sha256(bytes) !== entry.sha256) throw new Error('downloaded bytes do not match sha256');
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, bytes);
        ok++;
        console.log(`fetched: ${entry.path}`);
    } catch (error) {
        problems.push(`${state}, fetch failed (${error.message}): ${entry.path}`);
    }
}

for (const line of problems) console.error(line);
console.log(`${ok}/${entries.length} files verified`);
process.exit(problems.length ? 1 : 0);
