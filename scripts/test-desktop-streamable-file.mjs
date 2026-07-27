import assert from 'node:assert/strict';

import { installFileMethods } from '../src/app/methods/file-methods.js';
import { installLiveUpdateMethods } from '../src/app/methods/live-update-methods.js';
import { registerDuckDbFile } from '../src/data/duckdb-file-registration.js';
import {
    PYPSA_NETCDF_DESKTOP_EAGER_LIMIT_BYTES,
    PYPSA_NETCDF_WEB_EAGER_LIMIT_BYTES,
} from '../src/parsers/pypsa-netcdf-limits.js';
import {
    PICKLE_DESKTOP_EAGER_LIMIT_BYTES,
    PICKLE_WEB_EAGER_LIMIT_BYTES,
} from '../src/parsers/pickle-limits.js';

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

    // Size limits used to throw here. They report a verdict now and the caller
    // asks the user, so what this pins is that the DEFAULTS still differ
    // between desktop and web, and still trip at the right byte.
    assert.equal(harness._checkFullLoadLimit({
        name: 'desktop-medium-network.nc',
        size: PYPSA_NETCDF_DESKTOP_EAGER_LIMIT_BYTES - 1024,
    }, '.nc'), null, 'a netCDF under the desktop limit raises nothing');

    const desktopNetcdf = harness._checkFullLoadLimit({
        name: 'huge-network.nc',
        size: PYPSA_NETCDF_DESKTOP_EAGER_LIMIT_BYTES + 1024,
    }, '.nc');
    assert.ok(desktopNetcdf, 'a netCDF over the desktop limit is flagged');
    assert.equal(desktopNetcdf.format, 'netcdf');
    assert.equal(desktopNetcdf.limitBytes, PYPSA_NETCDF_DESKTOP_EAGER_LIMIT_BYTES);
    assert.equal(desktopNetcdf.settingLabelKey, 'pypsaNetcdfFullLoadLimit');

    const webHarness = new Harness();
    webHarness.capabilities = { isDesktop: false, canUseLiveUpdate: false };
    assert.equal(webHarness._checkFullLoadLimit({
        name: 'web-medium-network.nc',
        size: PYPSA_NETCDF_WEB_EAGER_LIMIT_BYTES,
    }, '.nc'), null, 'exactly at the limit is still allowed');
    assert.ok(webHarness._checkFullLoadLimit({
        name: 'web-too-large-network.nc',
        size: PYPSA_NETCDF_WEB_EAGER_LIMIT_BYTES + 1024,
    }, '.nc'), 'the web default is lower than the desktop one');

    assert.equal(harness._checkFullLoadLimit({
        name: 'desktop-medium-results.pkl',
        size: PICKLE_DESKTOP_EAGER_LIMIT_BYTES - 1024,
    }, '.pkl'), null);

    const desktopPickle = harness._checkFullLoadLimit({
        name: 'huge-results.pkl',
        size: PICKLE_DESKTOP_EAGER_LIMIT_BYTES + 1024,
    }, '.pkl');
    assert.ok(desktopPickle, 'a pickle over the desktop limit is flagged');
    assert.equal(desktopPickle.format, 'pickle');

    assert.equal(webHarness._checkFullLoadLimit({
        name: 'web-medium-results.pkl',
        size: PICKLE_WEB_EAGER_LIMIT_BYTES,
    }, '.pkl'), null);
    assert.ok(webHarness._checkFullLoadLimit({
        name: 'web-too-large-results.pkl',
        size: PICKLE_WEB_EAGER_LIMIT_BYTES + 1024,
    }, '.pkl'));

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
    // The bytes must not be pulled in until the user has answered: by the time
    // loadFile could warn, the whole file is already in memory.
    harness._confirmOversizedFile = async () => false;
    await assert.rejects(
        () => harness._readLocalResultPath('C:\\temp\\huge-network.nc'),
        (err) => err.name === 'AbortError',
    );
    assert.equal(readFileCalls, 0, 'declining an oversized netCDF stops it before Desktop readFile');

    // Accepting lets the read proceed — the whole point of the change.
    harness._confirmOversizedFile = async () => true;
    await assert.rejects(
        () => harness._readLocalResultPath('C:\\temp\\huge-network.nc'),
        /readFile should not be called/,
        'accepting reaches the reader instead of being refused up front',
    );
    assert.equal(readFileCalls, 1, 'the reader runs once the user accepts');
    harness._confirmOversizedFile = async () => false;

    let pickleReadFileCalls = 0;
    globalThis.omvDesktop = {
        statFile: async () => ({
            ok: true,
            name: 'huge-results.pkl',
            size: PICKLE_DESKTOP_EAGER_LIMIT_BYTES + 1024,
            lastModified: 5678,
            type: 'application/octet-stream',
        }),
        readFile: async () => {
            pickleReadFileCalls += 1;
            throw new Error('readFile should not be called for oversized pickle files');
        },
    };
    await assert.rejects(
        () => harness._readLocalResultPath('C:\\temp\\huge-results.pkl'),
        (err) => err.name === 'AbortError',
    );
    assert.equal(pickleReadFileCalls, 0, 'declining an oversized pickle stops it before Desktop readFile');

    const staleBuffer = new ArrayBuffer(8);
    await assert.rejects(
        () => harness._readLatestBuffer({
            fileHandle: {
                getFile: async () => ({
                    name: 'huge-results.pkl',
                    size: PICKLE_DESKTOP_EAGER_LIMIT_BYTES + 1024,
                    arrayBuffer: async () => {
                        throw new Error('arrayBuffer should not be called for oversized pickle files');
                    },
                }),
            },
            file: { name: 'old-results.pkl', size: 8, arrayBuffer: async () => staleBuffer },
            extension: '.pkl',
            buffer: staleBuffer,
        }),
        (err) => err.name === 'AbortError'
    );

    const httpMethods = [];
    globalThis.omvDesktop = {};
    globalThis.fetch = async (_url, options = {}) => {
        const method = options.method || 'GET';
        httpMethods.push(method);
        if (method === 'HEAD') {
            return new Response(null, {
                status: 200,
                headers: {
                    'content-length': String(PICKLE_DESKTOP_EAGER_LIMIT_BYTES + 1024),
                    'content-type': 'application/octet-stream',
                },
            });
        }
        throw new Error('GET should not be called for oversized pickle files');
    };
    await assert.rejects(
        () => harness._readLocalResultPath('C:\\temp\\huge-results.pkl'),
        (err) => err.name === 'AbortError'
    );
    assert.deepEqual(httpMethods, ['HEAD'], 'local HTTP fallback should reject oversized pickle before GET');

    await assert.rejects(
        () => harness._parseResultBuffer('results.bin', new Uint8Array([0x80, 0x05, 0x2e]).buffer),
        /looks like a Python pickle/
    );

    console.log('Desktop streamable file descriptor checks passed.');
} finally {
    if (originalDesktop === undefined) delete globalThis.omvDesktop;
    else globalThis.omvDesktop = originalDesktop;
    globalThis.fetch = originalFetch;
    if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
    else delete globalThis.location;
}
