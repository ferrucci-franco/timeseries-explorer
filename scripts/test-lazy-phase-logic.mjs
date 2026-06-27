import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';

class Harness {
    static MAX_MENU_VISUAL_POINTS = 10000;
    static DEFAULT_VISUAL_MAX_POINTS_PHASE = 4000;
    static GL_POINT_THRESHOLD = 50000;

    constructor() {
        this.files = new Map();
        this.phaseVisualMaxPoints = Harness.DEFAULT_VISUAL_MAX_POINTS_PHASE;
    }

    _extractUnit() { return ''; }
    _traceName(name) { return name; }
    _colors() { return { fontColor: '#000', bg: '#fff', gridColor: '#ccc', legendBg: '#fff' }; }
    _legendConfig() { return {}; }
    _marginConfig() { return { l: 60, r: 15, t: 10, b: 50 }; }
    _varUnit() { return ''; }
    _getTimeVar(fileId) {
        const data = this.files.get(fileId)?.data;
        return data?.variables?.[data?.metadata?.timeName || 'time'] || null;
    }
    _rangeIncluding0(arrays) {
        const extent = this._finiteExtent(arrays);
        return extent ? [extent.min, extent.max] : [-1, 1];
    }
    _padRange(min, max) { return [min, max]; }
    _exactRange(min, max) { return [min, max]; }
    _finiteExtent(arrays) {
        let min = Infinity;
        let max = -Infinity;
        for (const arr of arrays) {
            for (const value of arr || []) {
                if (!Number.isFinite(value)) continue;
                min = Math.min(min, value);
                max = Math.max(max, value);
            }
        }
        return Number.isFinite(min) ? { min, max } : null;
    }
}

installPlotDataMethods(Harness);

const h = new Harness();
h.files.set('lazy', {
    transform: {
        gain: 2,
        yOffset: 10,
        cropStart: 1,
        cropEnd: 3,
        timeShift: 5,
    },
    data: {
        metadata: { timeName: 'time', timeStart: 0, timeEnd: 4 },
        _duckdb: { appendRows: 0, appendBytes: 0, totalRows: 5 },
        variables: {
            time: { name: 'time', kind: 'abscissa', data: new Float64Array([0, 1, 2, 3, 4]) },
            x: { name: 'x', kind: 'variable', data: new Float64Array([999]), _duckdbCol: 'x' },
            y: { name: 'y', kind: 'variable', data: new Float64Array([999]), _duckdbCol: 'y' },
            z: { name: 'z', kind: 'variable', data: new Float64Array([999]), _duckdbCol: 'z' },
        },
    },
});

const transformed = h._transformFetchedPhaseTrajectory(
    'lazy',
    new Float64Array([0, 1, 2, 3, 4]),
    new Float64Array([0, 1, 2, 3, 4]),
    new Map([
        ['x', new Float64Array([0, 1, 2, 3, 4])],
        ['y', new Float64Array([10, 11, 12, 13, 14])],
    ]),
    ['x', 'y']
);
assert.deepEqual([...transformed.time], [6, 7, 8]);
assert.deepEqual([...transformed.valuesByVar.get('x')], [12, 14, 16]);
assert.deepEqual([...transformed.valuesByVar.get('y')], [32, 34, 36]);

const plot = {
    mode: 'phase2d',
    phaseTraces: [{ fileId: 'lazy', x: 'x', y: 'y', color: '#123' }],
};
const uncached = h._buildPhase2DTraces(plot);
assert.equal(uncached.length, 2, 'phase2d keeps the origin cross');
assert.equal(uncached[0].x.length, 0, 'lazy phase must not draw overview data as final data');
assert.equal(uncached[0].y.length, 0, 'lazy phase must not draw overview data as final data');

const targetInfo = h._phaseTargetInfo();
plot.phaseTraces[0]._lazyPhaseCache = {
    key: h._phaseTraceCacheKey(plot, plot.phaseTraces[0], targetInfo),
    visual: {
        x: new Float64Array([1, 2, 3]),
        y: new Float64Array([4, 5, 6]),
    },
};
const cached = h._buildPhase2DTraces(plot);
assert.deepEqual([...cached[0].x], [1, 2, 3]);
assert.deepEqual([...cached[0].y], [4, 5, 6]);

const source = await readFile(new URL('../src/data/duckdb-source.js', import.meta.url), 'utf8');
const phaseStart = source.indexOf('async _queryPhaseTrajectory');
const phaseMethod = source.slice(
    phaseStart,
    source.indexOf('\n    _phaseWhereSql', phaseStart)
);
assert.match(phaseMethod, /LAG\(\$\{tExpr\}\) OVER \(\)/, 'phase guard must check physical-order monotonicity');
assert.match(phaseMethod, /ROW_NUMBER\(\) OVER \(\) - 1/, 'phase stride must use physical row order');
assert.match(phaseMethod, /return this\._withConnectionLock\(async \(\) =>/, 'phase PRAGMA section must be serialized on the shared connection');
assert.match(phaseMethod, /_interactiveQueryUnlocked\(statsSql\)/, 'phase stats query must run inside the existing connection lock');
assert.match(phaseMethod, /_interactiveQueryUnlocked\(sql\)/, 'phase stride query must run inside the existing connection lock');
assert.doesNotMatch(phaseMethod, /ROW_NUMBER\(\) OVER \(ORDER BY/i, 'phase stride must not sort the full file by time');
assert.doesNotMatch(phaseMethod, /\bLIMIT\b/i, 'phase stride must not use LIMIT that can evict the last row');
assert.match(phaseMethod, /rn = \$\{Math\.round\(last\)\}/, 'phase stride must explicitly preserve the last row');
assert.match(phaseMethod, /violations > 0/, 'non-monotonic files must be guarded');
assert.match(source, /const DUCKDB_DEFAULT_THREADS = 2;/, 'normal DuckDB thread setting should be centralized');
assert.match(source, /const DUCKDB_PHASE_THREADS = 1;/, 'phase physical-order thread setting should be explicit');
assert.match(source, /async _withConnectionLock\(run\)/, 'DuckDBSource must expose a connection-level mutex');
assert.match(source, /options\.sourceTimeRange/, 'phase trajectory should document/use sourceTimeRange as the official crop key');
assert.match(source, /options\.sourceRange/, 'phase trajectory should accept sourceRange as a maintenance-safe alias');
assert.match(source, /sourceRange" is deprecated; use "sourceTimeRange"/, 'sourceRange alias should warn instead of being silently ignored');

console.log('Lazy phase logic checks passed.');
