import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listPackage } = require('@electron/asar');
const outputDir = path.resolve(process.env.OMV_DIST_OUTPUT?.trim() || 'desktop-dist');
const asarPath = path.join(outputDir, 'win-unpacked', 'resources', 'app.asar');

assert.ok(existsSync(asarPath), `Missing packaged ASAR: ${asarPath}`);
const files = listPackage(asarPath);

const required = [
  /\\dist\\index\.html$/,
  /\\electron\\main\.cjs$/,
  /\\electron\\navigation-policy\.cjs$/,
  /\\electron\\preload\.cjs$/,
  /\\node_modules\\duckdb\\lib\\binding\\duckdb\.node$/,
];
for (const pattern of required) {
  assert.ok(files.some(file => pattern.test(file)), `Missing packaged runtime file matching ${pattern}`);
}

const forbidden = /\\node_modules\\(?:.*\\)?(?:node-gyp|cacache|make-fetch-happen|tar)(?:\\|$)/;
const forbiddenFiles = files.filter(file => forbidden.test(file));
assert.deepEqual(forbiddenFiles, [], `Build-only dependency leaked into runtime: ${forbiddenFiles[0] || ''}`);

console.log(`Packaged Desktop inspection passed (${files.length} ASAR entries).`);
