import assert from 'node:assert/strict';

import { initialCapabilities, resolveCapabilities } from '../src/app/capabilities.js';

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
const originalFetch = globalThis.fetch;
const originalDesktop = globalThis.omvDesktop;

function setLocation({ hostname, protocol = 'https:' }) {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { hostname, protocol },
  });
}

function setFetch(response) {
  globalThis.fetch = async () => response;
}

function setFetchFailure() {
  globalThis.fetch = async () => {
    throw new Error('network unavailable in test');
  };
}

async function withRuntime(config, callback) {
  delete globalThis.omvDesktop;
  setLocation(config);
  if (config.desktop) {
    globalThis.omvDesktop = {};
  }
  if (config.fetch === 'local-api-ok') {
    setFetch({
      ok: true,
      json: async () => ({ ok: true }),
    });
  } else if (config.fetch === 'local-api-missing') {
    setFetch({
      ok: false,
      json: async () => null,
    });
  } else {
    setFetchFailure();
  }

  await callback();
}

try {
  await withRuntime({ hostname: 'ferrucci-franco.github.io', fetch: 'missing' }, async () => {
    const caps = await resolveCapabilities(initialCapabilities());
    assert.equal(caps.runtime, 'light-web');
    assert.equal(caps.label, 'Light Web');
    assert.equal(caps.isPublishedLight, true);
    assert.equal(caps.canUseLiveUpdate, false);
    assert.equal(caps.canUseLocalPath, false);
  });

  await withRuntime({ hostname: 'localhost', protocol: 'http:', fetch: 'local-api-missing' }, async () => {
    const caps = await resolveCapabilities(initialCapabilities());
    assert.equal(caps.runtime, 'light-web');
    assert.equal(caps.label, 'Light Web');
    assert.equal(caps.isLocalhost, true);
    assert.equal(caps.isLocalServer, false);
    assert.equal(caps.canUseLiveUpdate, false);
    assert.equal(caps.canUseLocalPath, false);
  });

  await withRuntime({ hostname: 'localhost', protocol: 'http:', fetch: 'local-api-ok' }, async () => {
    const caps = await resolveCapabilities(initialCapabilities());
    assert.equal(caps.runtime, 'light-web');
    assert.equal(caps.label, 'Light Web');
    assert.equal(caps.isLocalhost, true);
    assert.equal(caps.isLocalServer, true);
    assert.equal(caps.canUseLiveUpdate, false);
    assert.equal(caps.canUseLocalPath, false);
  });

  await withRuntime({ hostname: 'localhost', protocol: 'http:', fetch: 'local-api-ok', desktop: true }, async () => {
    const caps = await resolveCapabilities(initialCapabilities());
    assert.equal(caps.runtime, 'full-desktop');
    assert.equal(caps.label, 'Full Desktop');
    assert.equal(caps.isDesktop, true);
    assert.equal(caps.canUseLiveUpdate, true);
    assert.equal(caps.canUseLocalPath, true);
    assert.equal(caps.canUseHugeFiles, true);
  });

  console.log('Runtime capability checks passed.');
} finally {
  if (originalLocation) {
    Object.defineProperty(globalThis, 'location', originalLocation);
  } else {
    delete globalThis.location;
  }
  globalThis.fetch = originalFetch;
  if (originalDesktop === undefined) {
    delete globalThis.omvDesktop;
  } else {
    globalThis.omvDesktop = originalDesktop;
  }
}
