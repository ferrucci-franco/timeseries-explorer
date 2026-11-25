import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import { installSessionMethods } from '../src/app/methods/session-methods.js';
import Modal from '../src/ui/modal.js';

const translationsSource = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
for (const key of [
    'sessionProjectLazyFilesTitle',
    'sessionProjectLazyFilesBody',
    'sessionProjectLazyFilesViewHint',
    'sessionProjectReadFailedTitle',
    'sessionProjectReadFailedBody',
]) {
    assert.equal([...translationsSource.matchAll(new RegExp(`\\b${key}:`, 'g'))].length, 5, `${key} is translated in all languages`);
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

// The dialog a file in memory-saving mode gets: it offers to save a view.
const originalConfirm = Modal.confirm;
const confirms = [];
let confirmAnswer = false;
Modal.confirm = async (body, options) => {
    confirms.push({ body, options });
    return confirmAnswer;
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

    // Reloaded since Live Update appended: the data is the whole file again,
    // so the archive is the file, not the file cut where Live Update stopped.
    const reloadedCsv = new SessionProjectHarness([[
        'f1',
        {
            name: 'live',
            extension: '.csv',
            buffer: new TextEncoder().encode('time,value\n0,1\n1,2\n2,3\n').buffer,
            file: new File(['time,value\n0,1\n1,2\n2,3\n'], 'live.csv'),
            liveUpdate: { hasAppliedAppend: true, lastParsedOffset: 19, cursorData: { before: 'reload' } },
            contentHash: 'fingerprint',
            transform: {},
        },
    ]]);
    reloadedCsv._readLiveUpdateFile = async () => new File(['time,value\n0,1\n1,2\n2,3\n'], 'live.csv');
    reloadedCsv._liveUpdateDataOf = () => ({ after: 'reload' });
    assert.equal(await reloadedCsv.saveProjectSession(), true);
    const reloadedZip = unzipSync(new Uint8Array(await reloadedCsv.download.blob.arrayBuffer()));
    const reloadedSession = JSON.parse(strFromU8(reloadedZip['session.json']));
    assert.equal(
        strFromU8(reloadedZip[reloadedSession.files[0].archivePath]),
        'time,value\n0,1\n1,2\n2,3\n',
        'after a reload the project holds the whole file the data was read from',
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
    // A file in memory-saving mode is not copied into an archive: the dialog
    // says so and offers the view, which is what keeps the work on such a
    // file. Declined: nothing is saved.
    confirmAnswer = false;
    assert.equal(await lazyProject.saveProjectSession(), false);
    assert.equal(lazyProject.download, null, 'declined: nothing is downloaded');
    assert.equal(alerts.length, 0, 'it is an offer, not a dead end');
    assert.equal(confirms.length, 1, 'a lazy project offers the view');
    assert.match(confirms[0].body, /large\.parquet/, 'naming the files that are not copied');
    assert.doesNotMatch(confirms[0].body, /full-load limit/i, 'and without advice a large file cannot follow');
    assert.match(confirms[0].options.confirmText, /view/i, 'the button saves a view');
    // Accepted: the view is saved — a .json with the workspace and no data.
    confirmAnswer = true;
    assert.equal(await lazyProject.saveProjectSession(), false, 'still not a complete project');
    assert.match(lazyProject.download?.name || '', /\.json$/, 'accepted: the view is downloaded');
    const savedView = JSON.parse(await lazyProject.download.blob.text());
    assert.equal(savedView.files[0].archivePath, null, 'the view carries no bytes');
    assert.equal(savedView.files.length, 1);

    // What the app keeps on a trace while it draws stays out of a session: on
    // a lazy file `_lazyDetailCache` is the rows last read for the window, and
    // a view holds no data.
    lazyProject.plotManager.plots.set('panel-1', {
        mode: 'timeseries',
        traces: [{ fileId: 'f1', varName: 'x', axis: 'y', color: '#123456', _lazyDetailCache: { fileId: 'f1', varName: 'x', x: [0, 1], y: [5, 6] } }],
        phaseTraces: [{ fileId: 'f1', x: 'x', y: 'x', _working: [1, 2, 3] }],
    });
    lazyProject.plotManager._capturePlotView = () => null;
    lazyProject.plotManager._defaultLiveViewPolicy = () => ({});
    lazyProject.plotManager._defaultCursors = () => ({});
    const [capturedPlot] = lazyProject._capturePlotSessions();
    assert.deepEqual(capturedPlot.traces, [{ fileId: 'f1', varName: 'x', axis: 'y', color: '#123456' }], 'a saved trace is what the user chose');
    assert.deepEqual(capturedPlot.phaseTraces, [{ fileId: 'f1', x: 'x', y: 'x' }]);
    assert.deepEqual(
        lazyProject._sessionTrace({ fileId: 'f1', varName: 'x', _lazyDetailCache: { x: [1] } }),
        { fileId: 'f1', varName: 'x' },
        'and a view saved with it loads without it',
    );
    lazyProject.plotManager.plots.clear();

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

    // A gridded dataset can stand on several files (months joined along time,
    // the entries of a CDS ZIP) and then has no `entry.file` of its own: the
    // project has to carry every one of them, and the way they were joined.
    alerts.length = 0;
    const members = [new File(['month-one'], 'era5-2024-01.nc'), new File(['month-two'], 'era5-2024-02.nc')];
    const joined = new SessionProjectHarness([[
        'f1',
        {
            name: 'era5-2024-01 (+1)',
            extension: '.nc',
            buffer: null,
            file: null,
            contentHash: 'fingerprint',
            transform: {},
            gridded: {
                datasetId: 'grid-1',
                files: members,
                model: {},
                options: { mode: 'concat-time', title: 'era5-2024-01 (+1)' },
            },
        },
    ]]);
    joined._griddedSessionState = () => ({ open: true, palette: 'Cividis', groups: [{ id: 'g1', tag: 'P1', sets: [] }] });
    assert.equal(await joined.saveProjectSession(), true, 'a dataset of several files can be saved');
    assert.equal(alerts.length, 0);
    const joinedZip = unzipSync(new Uint8Array(await joined.download.blob.arrayBuffer()));
    const joinedMeta = JSON.parse(strFromU8(joinedZip['session.json'])).files[0];
    assert.deepEqual(joinedMeta.gridded.files.map(member => member.name), ['era5-2024-01.nc', 'era5-2024-02.nc']);
    assert.equal(joinedMeta.archivePath, joinedMeta.gridded.files[0].archivePath, 'the first member is the entry\'s own file');
    assert.notEqual(joinedMeta.gridded.files[0].archivePath, joinedMeta.gridded.files[1].archivePath);
    assert.equal(strFromU8(joinedZip[joinedMeta.gridded.files[0].archivePath]), 'month-one');
    assert.equal(strFromU8(joinedZip[joinedMeta.gridded.files[1].archivePath]), 'month-two');
    assert.equal(joinedMeta.gridded.options.mode, 'concat-time', 'and how they are read together');
    assert.equal(joinedMeta.gridded.view.palette, 'Cividis', 'the map travels with the dataset');

    // A view session (no data) still says which files the dataset was opened
    // from, and keeps the map; it just carries no bytes.
    const viewSession = joined._createSessionSnapshot({ includeData: false });
    assert.deepEqual(viewSession.files[0].gridded.files.map(member => member.name), ['era5-2024-01.nc', 'era5-2024-02.nc']);
    assert.equal(viewSession.files[0].gridded.files[0].archivePath, undefined);
    assert.equal(viewSession.files[0].archivePath, null);
    assert.equal(viewSession.files[0].gridded.view.open, true);

    // A series extracted on a map comes back with the session itself, so it
    // is not a variable to look for in the file (as for derived variables).
    assert.deepEqual(
        joined._sessionRequiredVariables('f1', {
            files: [{ id: 'f1', gridded: { view: { groups: [{ sets: [{ items: [{ name: 'grid:x1' }, { name: 'grid:x2' }] }] }] } } }],
            plots: [{ traces: [{ fileId: 'f1', varName: 'grid:x1' }, { fileId: 'f1', varName: 'pressure' }] }],
        }),
        ['pressure'],
    );

    console.log('Session complete-project eager/lazy/gridded checks passed.');
} finally {
    Modal.alert = originalAlert;
    Modal.confirm = originalConfirm;
}
