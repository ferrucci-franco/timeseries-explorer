import assert from 'node:assert/strict';

const port = Number(process.argv[2] || 9333);
const deadline = Date.now() + 180_000;
let page = null;

while (Date.now() < deadline) {
  try {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
    page = pages.find(item => item.type === 'page' && /Time Series Explorer/i.test(item.title || '')) || null;
    if (page?.webSocketDebuggerUrl) break;
  } catch (_) {
    // The packaged process may still be extracting or starting.
  }
  await new Promise(resolve => setTimeout(resolve, 500));
}

assert.ok(page?.webSocketDebuggerUrl, `Desktop did not expose a page on debugging port ${port}`);

const result = await new Promise((resolve, reject) => {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const timeout = setTimeout(() => reject(new Error('Timed out waiting for Desktop smoke-test evaluation')), 90_000);
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: {
        expression: `(async () => {
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const badge = document.querySelector('#runtime-badge')?.textContent?.trim() || '';
            if (/Full Desktop/i.test(badge)) break;
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          return {
            title: document.title,
            origin: location.origin,
            desktopBridge: !!globalThis.omvDesktop,
            runtimeBadge: document.querySelector('#runtime-badge')?.textContent?.trim() || '',
            externalFetchBlocked: await fetch('https://example.com/', { cache: 'no-store' })
              .then(() => false, () => true)
          };
        })()`,
        awaitPromise: true,
        returnByValue: true,
      },
    }));
  });
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id !== 1) return;
    clearTimeout(timeout);
    socket.close();
    if (message.error || message.result?.exceptionDetails) {
      reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
      return;
    }
    resolve(message.result?.result?.value);
  });
  socket.addEventListener('error', () => {
    clearTimeout(timeout);
    reject(new Error('Desktop debugging WebSocket failed'));
  });
});

assert.equal(result.title, 'Time Series Explorer');
assert.match(result.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.equal(result.desktopBridge, true, 'preload Desktop bridge is available');
assert.match(result.runtimeBadge, /Full Desktop/i);
assert.equal(result.externalFetchBlocked, true, 'external renderer requests are blocked');

console.log('Packaged Desktop smoke test passed.');
console.log(JSON.stringify(result, null, 2));
