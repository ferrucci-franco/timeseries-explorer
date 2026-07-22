import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
  appOriginFromUrl,
  isAllowedRendererUrl,
  isExternalOpenUrl,
  isExternalWebUrl,
} = require('../electron/navigation-policy.cjs');

const origin = appOriginFromUrl('http://127.0.0.1:8876/index.html');
assert.equal(origin, 'http://127.0.0.1:8876');

for (const url of [
  'http://127.0.0.1:8876/index.html',
  'http://127.0.0.1:8876/assets/app.js',
  'blob:http://127.0.0.1:8876/1234',
  'data:text/plain,local',
  'about:blank',
]) {
  assert.equal(isAllowedRendererUrl(url, origin), true, `expected local URL to be allowed: ${url}`);
}

for (const url of [
  'https://ferrucci-franco.github.io/electronics/',
  'https://github.com/ferrucci-franco/timeseries-explorer',
  'http://127.0.0.1:8877/index.html',
  'http://localhost:8876/index.html',
  'ws://127.0.0.1:8876/socket',
  'file:///C:/Windows/System32/drivers/etc/hosts',
  'javascript:alert(1)',
  'not a URL',
]) {
  assert.equal(isAllowedRendererUrl(url, origin), false, `expected URL to be blocked: ${url}`);
}

assert.equal(isExternalWebUrl('https://github.com/ferrucci-franco', origin), true);
assert.equal(isExternalWebUrl('http://127.0.0.1:8876/help', origin), false);
assert.equal(isExternalWebUrl('mailto:test@example.com', origin), false);
assert.equal(isExternalWebUrl('javascript:alert(1)', origin), false);
assert.equal(isExternalOpenUrl('mailto:test@example.com', origin), true);
assert.equal(isExternalOpenUrl('https://github.com/ferrucci-franco', origin), true);
assert.equal(isExternalOpenUrl('http://127.0.0.1:8876/help', origin), false);
assert.equal(isExternalOpenUrl('javascript:alert(1)', origin), false);
assert.equal(appOriginFromUrl('not a URL'), '');

const mainSource = await readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8');
assert.match(mainSource, /Menu\.setApplicationMenu\(null\)/, 'the native Electron menu must be removed');
assert.match(mainSource, /setWindowOpenHandler/, 'popup navigation must be intercepted');
assert.match(mainSource, /shell\.openExternal/, 'external links must use the system browser');
assert.match(mainSource, /onBeforeRequest/, 'renderer network requests must be filtered');
assert.match(mainSource, /\['<all_urls>'\]/, 'the network filter must cover every URL scheme');

console.log('Electron navigation policy tests passed.');
