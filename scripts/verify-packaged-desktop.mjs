import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listPackage } = require('@electron/asar');
const outputDir = path.resolve(process.env.OMV_DIST_OUTPUT?.trim() || 'desktop-dist');
const releasePlatform = process.env.OMV_RELEASE_PLATFORM?.trim() || 'windows';

async function findPackagedAsar(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(dir, entry.name);
    if (
      entry.isFile()
      && entry.name === 'app.asar'
      && path.basename(path.dirname(candidate)).toLowerCase() === 'resources'
    ) {
      return candidate;
    }
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const found = await findPackagedAsar(candidate);
      if (found) return found;
    }
  }
  return null;
}

const asarPath = await findPackagedAsar(outputDir);

assert.ok(asarPath && existsSync(asarPath), `Missing packaged ASAR for ${releasePlatform}: ${outputDir}`);
const files = listPackage(asarPath);
const normalizedFiles = files.map(file => file.replaceAll('\\', '/'));

const required = [
  /dist\/index\.html$/,
  /electron\/main\.cjs$/,
  /electron\/navigation-policy\.cjs$/,
  /electron\/preload\.cjs$/,
  /node_modules\/duckdb\/lib\/binding\/duckdb\.node$/,
];
for (const pattern of required) {
  assert.ok(normalizedFiles.some(file => pattern.test(file)), `Missing packaged runtime file matching ${pattern}`);
}

const forbidden = /node_modules\/(?:.*\/)?(?:node-gyp|cacache|make-fetch-happen|tar)(?:\/|$)/;
const forbiddenFiles = normalizedFiles.filter(file => forbidden.test(file));
assert.deepEqual(forbiddenFiles, [], `Build-only dependency leaked into runtime: ${forbiddenFiles[0] || ''}`);

console.log(`Packaged ${releasePlatform} Desktop inspection passed (${files.length} ASAR entries): ${asarPath}`);
