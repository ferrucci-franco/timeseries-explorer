import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { installSessionMethods } from '../src/app/methods/session-methods.js';
import Modal from '../src/ui/modal.js';

const translationsSource = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
for (const key of [
    'sessionProjectLazyFilesTitle',
    'sessionProjectLazyFilesBody',
    'sessionProjectReadFailedTitle',
    'sessionProjectReadFailedBody',
]) {
    assert.equal([...translationsSource.matchAll(new RegExp(`\\b${key}:`, 'g'))].length, 4, `${key} is translated in all languages`);
}

class SessionProjectHarness {
    constructor(entries) {
        this.files = new Map(entries);
        this.plotManager = {
            files: new Map(entries.map(([id, entry]) => [id, {
                data: entry.lazy ? { variables: { x: {} }, _duckdb: { tableName: 'lazy' } } : { variables: { x: {} } },
                invertedVariables: new Set(),
            }])),
            plots: new Map(),
            activeFileId: entries[0]?.[0] || null,
            syncAxes: true,
            syncHover: false,
            hoverInfoCorner: 'bl',
            hoverProximity: true,
            legendPosition: 'overlay',
            legendOverlayCorner: 'tl',
            mouseWheelZoom: true,
            timeseriesVisualMaxPoints: 2000,
            phaseVisualMaxPoints: 4000,
        };
        this.layoutManager = { root: { type: 'panel', id: 'panel-1' } };
        this.derivedByFile = new Map();
        this.theme = 'light';
        this.language = 'en';
        this.showDescriptions = false;
        this.sortAlphabetical = true;
        this.scrollablePlotArea = false;
        this.mouseWheelZoom = true;
        this.reloadAsNewVersionMode = false;
        this.activeFileId = entries[0]?.[0] || null;
        this.download = null;
    }

    _fileDisplayName(entry) { return `${entry.name}${entry.extension}`; }
    _fileExtension(name) { return String(name).match(/\.[^.]+$/)?.[0]?.toLowerCase() || ''; }
    _fileBaseName(name) { return String(name).replace(/\.[^.]+$/, ''); }
    _normalizeFileTransform(value) { return value || {}; }
    _readLatestBuffer() { throw new Error('No fallback buffer'); }
}

installSessionMethods(SessionProjectHarness);
SessionProjectHarness.prototype._downloadBlob = function(blob, name) {
    this.download = { blob, name };
};

const originalAlert = Modal.alert;
const alerts = [];
Modal.alert = async (title, body, options) => {
    alerts.push({ title, body, options });
};

try {
    const encoded = new TextEncoder().encode('MAT payload').buffer;
    const buffered = new SessionProjectHarness([[
        'f1',
        { name: 'model', extension: '.mat', buffer: encoded, contentHash: 'hash', transform: {} },
    ]]);
    assert.equal(await buffered.saveProjectSession(), true);
    assert(buffered.download, 'buffered project should be downloaded');
    const bufferedZip = unzipSync(new Uint8Array(await buffered.download.blob.arrayBuffer()));
    const bufferedSession = JSON.parse(strFromU8(bufferedZip['session.json']));
    assert(bufferedZip[bufferedSession.files[0].archivePath], 'buffered project should contain its source file');

    const eagerCsv = new SessionProjectHarness([[
        'f1',
        {
            name: 'small',
            extension: '.csv',
            buffer: null,
            file: new File(['time,value\n0,1\n'], 'small.csv'),
            contentHash: 'fingerprint',
            transform: {},
        },
    ]]);
    assert.equal(await eagerCsv.saveProjectSession(), true);
    const eagerZip = unzipSync(new Uint8Array(await eagerCsv.download.blob.arrayBuffer()));
    const eagerSession = JSON.parse(strFromU8(eagerZip['session.json']));
    assert.equal(strFromU8(eagerZip[eagerSession.files[0].archivePath]), 'time,value\n0,1\n');

    const liveCsv = new SessionProjectHarness([[
        'f1',
        {
            name: 'live',
            extension: '.csv',
            buffer: new TextEncoder().encode('time,value\n0,1\n').buffer,
            file: new File(['time,value\n0,1\n'], 'live.csv'),
            liveUpdate: { hasAppliedAppend: true, lastParsedOffset: 19 },
            contentHash: 'fingerprint',
            transform: {},
        },
    ]]);
    liveCsv._readLiveUpdateFile = async () => new File(['time,value\n0,1\n1,2\npartial'], 'live.csv');
    assert.equal(await liveCsv.saveProjectSession(), true);
    const liveZip = unzipSync(new Uint8Array(await liveCsv.download.blob.arrayBuffer()));
    const liveSession = JSON.parse(strFromU8(liveZip['session.json']));
    assert.equal(
        strFromU8(liveZip[liveSession.files[0].archivePath]),
        'time,value\n0,1\n1,2\n',
        'complete project should contain the displayed Live Update rows but not its pending partial row',
    );

    alerts.length = 0;
    const lazyProject = new SessionProjectHarness([[
        'f1',
        {
            name: 'large',
            extension: '.parquet',
            buffer: null,
            file: new File(['parquet'], 'large.parquet'),
            contentHash: 'fingerprint',
            transform: {},
            lazy: true,
        },
    ]]);
    assert.equal(await lazyProject.saveProjectSession(), false);
    assert.equal(lazyProject.download, null, 'lazy project must not create a download');
    assert.equal(alerts.length, 1, 'lazy project should explain why saving is blocked');
    assert.match(alerts[0].body, /large\.parquet/);

    alerts.length = 0;
    const unreadable = new SessionProjectHarness([[
        'f1',
        {
            name: 'unreadable',
            extension: '.mat',
            buffer: null,
            file: { arrayBuffer: async () => { throw new Error('read failed'); } },
            contentHash: 'hash',
            transform: {},
        },
    ]]);
    assert.equal(await unreadable.saveProjectSession(), false);
    assert.equal(unreadable.download, null, 'unreadable project must not create a download');
    assert.equal(alerts.length, 1, 'unreadable project should show a clear error');
    assert.match(alerts[0].body, /unreadable\.mat/);

    console.log('Session complete-project eager/lazy checks passed.');
} finally {
    Modal.alert = originalAlert;
}
