import assert from 'node:assert/strict';

import { installFileMethods } from '../src/app/methods/file-methods.js';
import { installLiveUpdateMethods } from '../src/app/methods/live-update-methods.js';
import { registerDuckDbFile } from '../src/data/duckdb-file-registration.js';
import {
    PYPSA_NETCDF_DESKTOP_EAGER_LIMIT_BYTES,
    PYPSA_NETCDF_WEB_EAGER_LIMIT_BYTES,
} from '../src/parsers/pypsa-netcdf-limits.js';

class Harness {
    constructor() {
        this.capabilities = { isDesktop: true, canUseLiveUpdate: true };
        this.files = new Map();
        this.plotManager = { files: new Map() };
    }
}

installFileMethods(Harness);
installLiveUpdateMethods(Harness);

const originalDesktop = globalThis.omvDesktop;
const originalFetch = globalThis.fetch;
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');

const text = 'time,x\n0,1\n1,2\n';
const bytes = new TextEncoder().encode(text);
const ranges = [];

Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'http://localhost:8876' },
});

globalThis.omvDesktop = {
    statFile: async () => ({
        ok: true,
        name: 'growing.csv',
        size: bytes.byteLength,
        lastModified: 1234,
        type: 'text/csv; charset=utf-8',
    }),
};

globalThis.fetch = async (url, options = {}) => {
    assert.equal(String(url), 'http://localhost:8876/__omv_local__/file?path=C%3A%5Ctemp%5Cgrowing.csv');
    const range = options.headers?.Range || options.headers?.range;
    ranges.push(range || 'full');
    const match = String(range || '').match(/^bytes=(\d+)-(\d+)$/);
    assert.ok(match, `Expected a byte range request, got ${range}`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    const slice = bytes.slice(start, end + 1);
    return new Response(slice, {
        status: 206,
        headers: {
            'content-range': `bytes ${start}-${end}/${bytes.byteLength}`,
            'content-length': String(slice.byteLength),
            'accept-ranges': 'bytes',
            'cache-control': 'no-store',
        },
    });
};

try {
    const harness = new Harness();
    const file = await harness._readLocalResultPath('C:\\temp\\growing.csv');

    assert.equal(file.__omvLocalHttpFile, true);
    assert.equal(file.name, 'growing.csv');
    assert.equal(file.size, bytes.byteLength);
    assert.equal(file.localUrl, 'http://localhost:8876/__omv_local__/file?path=C%3A%5Ctemp%5Cgrowing.csv');

    const middle = new TextDecoder().decode(await file.slice(7, 10).arrayBuffer());
    assert.equal(middle, '0,1');
    assert.equal(ranges.at(-1), 'bytes=7-9');

    const middleText = await file.slice(7, 10).text();
    assert.equal(middleText, '0,1');
    assert.equal(ranges.at(-1), 'bytes=7-9');

    const empty = await file.slice(5, 5).arrayBuffer();
    assert.equal(empty.byteLength, 0);
    assert.equal(ranges.filter(range => range !== 'full').length, 2);

    const lastLine = await harness._readLiveUpdateLastCompleteLine(file);
    assert.equal(lastLine, '1,2');
    assert.equal(ranges.at(-1), `bytes=0-${bytes.byteLength - 1}`);

    const duckdbModule = {
        DuckDBDataProtocol: {
            HTTP: 'HTTP',
            BROWSER_FILEREADER: 'BROWSER_FILEREADER',
        },
    };
    const calls = [];
    const db = {
        registerFileURL: async (...args) => calls.push(['url', ...args]),
        registerFileHandle: async (...args) => calls.push(['handle', ...args]),
    };

    assert.equal(await registerDuckDbFile(db, duckdbModule, 'desktop.csv', file), 'http');
    assert.deepEqual(calls[0], ['url', 'desktop.csv', file.localUrl, 'HTTP', false]);

    const webFile = { name: 'web.csv' };
    assert.equal(await registerDuckDbFile(db, duckdbModule, 'web.csv', webFile), 'browser-filereader');
    assert.deepEqual(calls[1], ['handle', 'web.csv', webFile, 'BROWSER_FILEREADER', true]);

    assert.doesNotThrow(() => harness._preflightPypsaNetcdfFile({
        name: 'desktop-medium-network.nc',
        size: PYPSA_NETCDF_DESKTOP_EAGER_LIMIT_BYTES - 1024,
    }, '.nc'));

    assert.throws(
        () => harness._preflightPypsaNetcdfFile({
            name: 'huge-network.nc',
            size: PYPSA_NETCDF_DESKTOP_EAGER_LIMIT_BYTES + 1024,
        }, '.nc'),
        /PyPSA netCDF support currently uses eager loading/
    );

    const webHarness = new Harness();
    webHarness.capabilities = { isDesktop: false, canUseLiveUpdate: false };
    assert.doesNotThrow(() => webHarness._preflightPypsaNetcdfFile({
        name: 'web-medium-network.nc',
        size: PYPSA_NETCDF_WEB_EAGER_LIMIT_BYTES,
    }, '.nc'));
    assert.throws(
        () => webHarness._preflightPypsaNetcdfFile({
            name: 'web-too-large-network.nc',
            size: PYPSA_NETCDF_WEB_EAGER_LIMIT_BYTES + 1024,
        }, '.nc'),
        /PyPSA netCDF support currently uses eager loading/
    );

    let readFileCalls = 0;
    globalThis.omvDesktop = {
        statFile: async () => ({
            ok: true,
            name: 'huge-network.nc',
            size: PYPSA_NETCDF_DESKTOP_EAGER_LIMIT_BYTES + 1024,
            lastModified: 5678,
            type: 'application/x-netcdf',
        }),
        readFile: async () => {
            readFileCalls += 1;
            throw new Error('readFile should not be called for oversized PyPSA files');
        },
    };
    await assert.rejects(
        () => harness._readLocalResultPath('C:\\temp\\huge-network.nc'),
        /PyPSA netCDF support currently uses eager loading/
    );
    assert.equal(readFileCalls, 0, 'oversized PyPSA netCDF should be rejected before Desktop readFile');

    console.log('Desktop streamable file descriptor checks passed.');
} finally {
    if (originalDesktop === undefined) delete globalThis.omvDesktop;
    else globalThis.omvDesktop = originalDesktop;
    globalThis.fetch = originalFetch;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else delete globalThis.location;
}
