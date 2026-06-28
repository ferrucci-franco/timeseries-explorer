/**
 * DuckDB-WASM data source.
 *
 * Phase 1.A — drop-in CSV parser replacement.
 *
 * Produces the same `{variables, metadata, tree}` shape that `CsvParser`
 * produces, so the rest of the application keeps working untouched. Numeric
 * column data is exposed as `Float64Array` (via Apache Arrow) — a significant
 * memory and speed win over JS Array boxing.
 *
 * Browser files are registered with `BROWSER_FILEREADER` protocol so the
 * underlying `File` object is read lazily by DuckDB. Desktop CSV/Parquet files
 * can also arrive as local HTTP descriptors and are registered with DuckDB's
 * HTTP protocol, letting DuckDB request byte ranges from the Electron server
 * instead of materializing the whole file in renderer memory.
 *
 * Falls back to `CsvParser` for files DuckDB cannot detect.
 */

import * as duckdb from '@duckdb/duckdb-wasm';
import * as arrow from 'apache-arrow';
import mvpWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { parseCsvNumber } from '../parsers/csv-time-detection.js';
import { registerDuckDbFile } from './duckdb-file-registration.js';
import { duckDbAppendGrowthLimitError } from './duckdb-live-limits.js';

const BUNDLES = {
    mvp: { mainModule: mvpWasmUrl, mainWorker: mvpWorkerUrl },
    eh:  { mainModule: ehWasmUrl,  mainWorker: ehWorkerUrl  },
};

const TIME_HEADER_RE = /^(time|temps|t|datetime|timestamp|horodatage|date|fecha|hora|heure)$/i;
const MS_PER_DAY = 86400000;
const DUCKDB_DEFAULT_THREADS = 2;
const DUCKDB_DEFAULT_PRESERVE_INSERTION_ORDER = false;
const DUCKDB_PHASE_THREADS = 1;
const DUCKDB_PHASE_PRESERVE_INSERTION_ORDER = true;

export default class DuckDbSource {
    constructor(structureParser = null) {
        this.structureParser = structureParser || null;
        this._db = null;
        this._conn = null;
        this._initPromise = null;
        this._registered = new Set();
        this._nextTableId = 0;
        this._rangeCache = new Map();
        this._phaseCache = new Map();
        this._activeInteractiveQuery = null;
        this._connectionQueue = Promise.resolve();
    }

    static isAvailable() {
        return typeof window !== 'undefined'
            && typeof Worker !== 'undefined'
            && typeof WebAssembly !== 'undefined';
    }

    async init() {
        if (this._db) return;
        if (!this._initPromise) {
            this._initPromise = this._bootstrap();
        }
        await this._initPromise;
    }

    async _bootstrap() {
        const bundle = await duckdb.selectBundle(BUNDLES);
        const worker = new Worker(bundle.mainWorker, { type: 'module' });
        const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
        const db = new duckdb.AsyncDuckDB(logger, worker);
        await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
        await db.open({
            filesystem: {
                // Desktop local files are registered over HTTP Range. Avoid HEAD/full-read fallbacks:
                // they can trip DuckDB-WASM/XHR limits and accidentally fetch multi-GB files.
                reliableHeadRequests: false,
                allowFullHTTPReads: false,
                forceFullHTTPReads: false,
            },
        });
        this._db = db;
        this._conn = await db.connect();
        // Tune for the WASM context: less parallelism means smaller per-thread
        // chunk buffers, and allowing out-of-order operators frees DuckDB from
        // retaining whole pipelines in memory. Crucial for files near the
        // ~3 GB wasm heap ceiling.
        try {
            await this._conn.query(`PRAGMA threads=${DUCKDB_DEFAULT_THREADS}`);
            await this._conn.query(`PRAGMA preserve_insertion_order=${DUCKDB_DEFAULT_PRESERVE_INSERTION_ORDER}`);
        } catch (_) { /* tuning is best-effort */ }
    }

    async registerFile(name, file) {
        await this.init();
        if (this._registered.has(name)) {
            try { await this._db.dropFile(name); } catch (_) { /* ignore */ }
            this._registered.delete(name);
        }
        await registerDuckDbFile(this._db, duckdb, name, file);
        this._registered.add(name);
    }

    async unregisterFile(name) {
        if (!this._registered.has(name)) return;
        try { await this._db.dropFile(name); } catch (_) { /* ignore */ }
        this._registered.delete(name);
    }

    async query(sql) {
        await this.init();
        return this._withConnectionLock(() => this._conn.query(sql));
    }

    /**
     * Parse a CSV File into the legacy {variables, metadata, tree} shape.
     *
     * Modes:
     *   - eager (default): pull all data into Float64Array columns; drop the
     *     DuckDB table and unregister the file when done. No lazy queries.
     *   - lazy: keep the DuckDB temp table + registered file alive. Materialize
     *     only a downsampled overview (`overviewPoints` per column) into the
     *     legacy structure for initial render. Attach `data._duckdb` so the
     *     viewport handler can ask for high-resolution range slices later.
     *
     * Returns null if DuckDB cannot read the file; the caller should fall back.
     */
    async parseCsvFile(file, displayName = file.name, opts = {}) {
        return this._parseFile(file, displayName, { ...opts, format: 'csv' });
    }

    /**
     * Parse a Parquet File. Always uses VIEW + lazy queries — Parquet's
     * columnar layout + projection/predicate pushdown makes every step
     * cheaper than the CSV path. Use this for GB-scale workflows.
     */
    async parseParquetFile(file, displayName = file.name, opts = {}) {
        return this._parseFile(file, displayName, { ...opts, format: 'parquet' });
    }

    async _parseFile(file, displayName, opts) {
        const { lazy = false, overviewPoints = 10000, format = 'csv', csvProfile = null } = opts;
        await this.init();
        const id = ++this._nextTableId;
        const handle = `omv_${id}_${displayName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const tableName = `omv_t_${id}`;
        await this.registerFile(handle, file);
        let result = null;
        try {
            result = await this._loadIntoLegacy(handle, tableName, { lazy, overviewPoints, format, csvProfile });
        } catch (err) {
            try { await this._conn.query(`DROP TABLE IF EXISTS ${tableName}`); } catch (_) { /* ignore */ }
            try { await this._conn.query(`DROP VIEW IF EXISTS ${tableName}`); } catch (_) { /* ignore */ }
            await this.unregisterFile(handle);
            throw err;
        }
        if (!lazy) {
            try { await this._conn.query(`DROP TABLE IF EXISTS ${tableName}`); } catch (_) { /* ignore */ }
            try { await this._conn.query(`DROP VIEW IF EXISTS ${tableName}`); } catch (_) { /* ignore */ }
            await this.unregisterFile(handle);
        }
        return result;
    }

    /**
     * Release a lazy file: drop its DuckDB table/view and unregister the
     * file handle. Safe to call on eager-mode data (no-op) and idempotent.
     */
    async release(legacyData) {
        const meta = legacyData?._duckdb;
        if (!meta) return;
        const objects = [
            meta.combinedViewName,
            meta.appendTableName,
            meta.baseTableName,
            meta.tableName,
        ].filter(Boolean);
        for (const name of [...new Set(objects)]) {
            try { await this._conn.query(`DROP TABLE IF EXISTS ${name}`); } catch (_) { /* ignore */ }
            try { await this._conn.query(`DROP VIEW IF EXISTS ${name}`); } catch (_) { /* ignore */ }
        }
        for (const handle of [...new Set(meta.deltaHandles || [])]) {
            await this.unregisterFile(handle);
        }
        await this.unregisterFile(meta.handle);
        this._clearRangeCacheForTable(meta.tableName);
        this._clearRangeCacheForTable(meta.combinedViewName);
        this._clearRangeCacheForTable(meta.baseTableName);
        delete legacyData._duckdb;
    }

    async appendCsvDelta(legacyData, csvProfile, text, options = {}) {
        const meta = legacyData?._duckdb;
        if (!meta) throw new Error('appendCsvDelta: data is not DuckDB-backed');
        if (!csvProfile) throw new Error('appendCsvDelta: missing CSV profile');
        await this.init();

        const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const deltaHandle = `${meta.baseTableName || meta.tableName}_delta_${id}.csv`;
        const deltaView = `${meta.baseTableName || meta.tableName}_delta_${id}`;
        const deltaText = String(text || '').endsWith('\n') ? String(text || '') : `${text || ''}\n`;
        const deltaFile = typeof File !== 'undefined'
            ? new File([deltaText], deltaHandle, { type: 'text/csv' })
            : new Blob([deltaText], { type: 'text/csv' });
        const escapedHandle = deltaHandle.replace(/'/g, "''");
        const readExpr = this._csvReadExpr(escapedHandle, csvProfile, { skip: 0 });
        const validWhere = `${meta.timeExprSql} IS NOT NULL`;
        const expectedRows = Number(options.expectedRows);

        return this._withConnectionLock(async () => {
            await this._ensureAppendTable(meta, csvProfile);
            await this.registerFile(deltaHandle, deltaFile);
            meta.deltaHandles = [...(meta.deltaHandles || []), deltaHandle];
            try {
                await this._conn.query(`CREATE OR REPLACE TEMP VIEW ${deltaView} AS SELECT * FROM ${readExpr}`);
                const countResult = await this._conn.query(`
                    SELECT
                        COUNT(*)::BIGINT AS n,
                        COUNT(DISTINCT ${meta.timeExprSql})::BIGINT AS distinct_n,
                        MIN(${meta.timeExprSql})::DOUBLE AS tmin,
                        MAX(${meta.timeExprSql})::DOUBLE AS tmax
                    FROM ${deltaView}
                    WHERE ${validWhere}
                `);
                const rows = Number(countResult.getChild('n')?.get(0) ?? 0);
                const distinctRows = Number(countResult.getChild('distinct_n')?.get(0) ?? 0);
                const minTime = Number(countResult.getChild('tmin')?.get(0));
                const maxTime = Number(countResult.getChild('tmax')?.get(0));
                if (Number.isFinite(expectedRows) && rows !== expectedRows) {
                    throw new Error(`DuckDB accepted ${rows} appended rows; expected ${expectedRows}.`);
                }
                if (rows <= 0) {
                    throw new Error('DuckDB did not find valid time values in appended rows.');
                }
                if (distinctRows !== rows) {
                    throw new Error('Appended rows contain duplicate time values.');
                }
                if (Number.isFinite(Number(options.lastTime)) && Number.isFinite(minTime) && minTime <= Number(options.lastTime)) {
                    throw new Error('Appended time values must be strictly greater than the previous file time.');
                }
                const limitError = duckDbAppendGrowthLimitError({
                    appendRows: (Number(meta.appendRows) || 0) + rows,
                    appendBytes: (Number(meta.appendBytes) || 0) + deltaText.length,
                }, options.limits);
                if (limitError) throw limitError;

                const projected = await this._conn.query(`
                    SELECT ${meta.projectionSql}
                    FROM ${deltaView}
                    WHERE ${validWhere}
                    ORDER BY "__omv_time" ASC NULLS LAST
                `);
                await this._conn.query(`INSERT INTO ${meta.appendTableName} SELECT * FROM ${deltaView} WHERE ${validWhere}`);

                meta.appendRows = (Number(meta.appendRows) || 0) + rows;
                meta.appendBytes = (Number(meta.appendBytes) || 0) + deltaText.length;
                if (Number.isFinite(Number(meta.totalRows))) meta.totalRows = Number(meta.totalRows) + rows;
                meta.overviewPoints = Math.max(Number(meta.overviewPoints) || 0, legacyData?.variables?.[legacyData?.metadata?.timeName]?.data?.length || 0);
                this._clearRangeCacheForTable(meta.tableName);
                return {
                    rows,
                    timeStart: minTime,
                    timeEnd: maxTime,
                    columns: this._projectedDeltaColumns(legacyData, projected),
                };
            } finally {
                try { await this._conn.query(`DROP VIEW IF EXISTS ${deltaView}`); } catch (_) { /* ignore */ }
                await this.unregisterFile(deltaHandle);
                meta.deltaHandles = (meta.deltaHandles || []).filter(handle => handle !== deltaHandle);
            }
        });
    }

    /**
     * Fetch a viewport-bounded slice of one variable.
     *
     * Returns `{x: Float64Array, y: Float64Array}` with at most `maxPoints`
     * samples between `[t0, t1]`. Uses server-side time-bucket aggregation
     * (`GROUP BY bucket`) so the data transferred over the wire is
     * O(maxPoints) regardless of how many rows the visible range contains.
     */
    async getColumnRange(legacyData, varName, t0, t1, maxPoints = 4000) {
        const result = await this.getColumnsRange(legacyData, [varName], t0, t1, maxPoints);
        return {
            x: result.x,
            y: result.yByVar.get(varName) || new Float64Array(0),
        };
    }

    /**
     * Fetch viewport-bounded slices for multiple variables from the same file
     * in one DuckDB scan. This is critical for overlaid traces: four traces
     * should not trigger four independent Parquet/CSV range scans.
     */
    async getColumnsRange(legacyData, varNames, t0, t1, maxPoints = 4000) {
        const meta = legacyData?._duckdb;
        if (!meta) throw new Error('getColumnsRange: data is not DuckDB-backed (eager mode)');
        const requested = [...new Set(varNames || [])]
            .map(varName => ({ varName, variable: legacyData.variables?.[varName] }))
            .filter(item => item.variable)
            .sort((a, b) => String(a.varName).localeCompare(String(b.varName)));
        if (!requested.length) {
            return { x: new Float64Array(0), yByVar: new Map() };
        }
        const cacheKey = this._rangeCacheKey(meta, requested, t0, t1, maxPoints);
        const cached = cacheKey ? this._rangeCache.get(cacheKey) : null;
        if (cached) {
            if (cached instanceof Promise) return cached;
            return { ...cached, _perf: { ...(cached._perf || {}), cacheHit: true } };
        }

        const promise = this._queryColumnsRange(legacyData, meta, requested, t0, t1, maxPoints);
        if (cacheKey) this._rememberRangeCache(cacheKey, promise);
        try {
            const result = await promise;
            if (cacheKey) this._rangeCache.set(cacheKey, result);
            return result;
        } catch (err) {
            if (cacheKey) this._rangeCache.delete(cacheKey);
            throw err;
        }
    }

    async _queryColumnsRange(legacyData, meta, requested, t0, t1, maxPoints = 4000) {
        const queryStartedAt = this._now();
        const timeCol = meta.timeColumn;
        const escTime = timeCol.replace(/"/g, '""');
        const tableName = meta.tableName;
        const lit = (v) => this._numericLiteral(v);
        // Express the time column in the same units the rest of the app uses
        // (Unix milliseconds for datetime, raw numeric otherwise) so the JS
        // side never has to translate between encodings.
        const timeKind = legacyData?.metadata?.timeKind;
        const tExpr = meta.timeExprSql || (timeKind === 'datetime'
            ? `epoch_ms("${escTime}")::DOUBLE`
            : `"${escTime}"::DOUBLE`);

        // GROUP BY time-bucket gives O(maxPoints) output regardless of how
        // many input rows match — far cheaper than `COUNT(*) OVER ()` +
        // `ROW_NUMBER() OVER (ORDER BY t)` for wide ranges where the input
        // set is large.
        const span = t1 - t0;
        if (!Number.isFinite(span) || span <= 0) {
            return { x: new Float64Array(0), yByVar: new Map(requested.map(({ varName }) => [varName, new Float64Array(0)])) };
        }
        const estimatedRows = this._estimateRowsInRange(legacyData, meta, t0, t1);
        const rawLimit = Math.ceil(maxPoints * 1.2);
        const valueSelect = requested
            .map(({ variable }, index) => `${this._quoteIdent(variable._duckdbCol || variable.name)} AS v${index}`)
            .join(',\n                       ');
        if (Number.isFinite(estimatedRows) && estimatedRows > 0 && estimatedRows <= rawLimit) {
            const sql = `
                SELECT ${tExpr} AS t,
                       ${valueSelect}
                FROM ${tableName}
                WHERE ${tExpr} BETWEEN ${lit(t0)} AND ${lit(t1)}
                ORDER BY t
                LIMIT ${rawLimit};
            `;
            const result = await this._interactiveQuery(sql);
            const extractStartedAt = this._now();
            const yByVar = new Map();
            requested.forEach(({ varName }, index) => {
                yByVar.set(varName, this._extractColumnAsFloat64(result, index + 1, 'DOUBLE'));
            });
            const x = this._extractColumnAsFloat64(result, 0, 'DOUBLE');
            return {
                x,
                yByVar,
                _perf: this._rangePerf({
                    mode: 'raw',
                    startedAt: queryStartedAt,
                    extractStartedAt,
                    result,
                    rows: x.length,
                    requested,
                    t0,
                    t1,
                    maxPoints,
                    estimatedRows,
                }),
            };
        }
        const aggregateSelect = requested
            .map((_, index) => `AVG(v${index}) AS v${index}`)
            .join(',\n                   ');
        const sql = `
            WITH visible AS (
                SELECT ${tExpr} AS t,
                       ${valueSelect}
                FROM ${tableName}
                WHERE ${tExpr} BETWEEN ${lit(t0)} AND ${lit(t1)}
            ),
            bucketed AS (
                SELECT t,
                       ${requested.map((_, index) => `v${index}`).join(', ')},
                       CAST(LEAST(${maxPoints - 1},
                                  GREATEST(0,
                                           FLOOR((t - ${lit(t0)})
                                                 * ${maxPoints} / ${lit(span)})))
                            AS BIGINT) AS bucket
                FROM visible
            )
            SELECT MIN(t) AS t,
                   ${aggregateSelect}
            FROM bucketed
            GROUP BY bucket
            ORDER BY bucket;
        `;
        const result = await this._interactiveQuery(sql);
        const extractStartedAt = this._now();
        const yByVar = new Map();
        requested.forEach(({ varName }, index) => {
            yByVar.set(varName, this._extractColumnAsFloat64(result, index + 1, 'DOUBLE'));
        });
        const x = this._extractColumnAsFloat64(result, 0, 'DOUBLE');
        return {
            x,
            yByVar,
            _perf: this._rangePerf({
                mode: 'aggregate',
                startedAt: queryStartedAt,
                extractStartedAt,
                result,
                rows: x.length,
                requested,
                t0,
                t1,
                maxPoints,
                estimatedRows,
            }),
        };
    }

    _rangePerf({ mode, startedAt, extractStartedAt, result, rows, requested, t0, t1, maxPoints, estimatedRows }) {
        const finishedAt = this._now();
        const queryPerf = result?._omvPerf || {};
        return {
            mode,
            vars: requested.length,
            rows,
            target: maxPoints,
            span: t1 - t0,
            estimatedRows: Number.isFinite(estimatedRows) ? Math.round(estimatedRows) : null,
            queryMs: this._roundMs(queryPerf.totalMs ?? (extractStartedAt - startedAt)),
            sendMs: this._roundMs(queryPerf.sendMs),
            readMs: this._roundMs(queryPerf.readMs),
            extractMs: this._roundMs(finishedAt - extractStartedAt),
            totalMs: this._roundMs(finishedAt - startedAt),
            cacheHit: false,
        };
    }

    _estimateRowsInRange(legacyData, meta, t0, t1) {
        const totalRows = Number(meta?.totalRows);
        const dataStart = Number(legacyData?.metadata?.timeStart);
        const dataEnd = Number(legacyData?.metadata?.timeEnd);
        const span = Math.abs(t1 - t0);
        const fullSpan = dataEnd - dataStart;
        if (!Number.isFinite(totalRows) || totalRows <= 0) return NaN;
        if (!Number.isFinite(span) || span <= 0) return NaN;
        if (!Number.isFinite(fullSpan) || fullSpan <= 0) return NaN;
        return totalRows * Math.min(1, span / fullSpan);
    }

    _rangeCacheKey(meta, requested, t0, t1, maxPoints) {
        const tableName = meta?.tableName;
        if (!tableName) return null;
        const vars = requested.map(({ varName }) => varName).join('\u001f');
        return [tableName, vars, this._roundedRangeKey(t0), this._roundedRangeKey(t1), Math.round(maxPoints)].join('\u001e');
    }

    _phaseCacheKey(meta, requested, sourceRange, maxPoints) {
        const tableName = meta?.tableName;
        if (!tableName) return null;
        const vars = requested.map(({ varName }) => varName).join('\u001f');
        const rangeKey = Array.isArray(sourceRange) && sourceRange.length >= 2
            ? `${this._roundedRangeKey(Number(sourceRange[0]))}\u001f${this._roundedRangeKey(Number(sourceRange[1]))}`
            : 'full';
        const version = [
            Number(meta.appendRows) || 0,
            Number(meta.appendBytes) || 0,
            Number(meta.totalRows) || '',
        ].join('\u001f');
        return [tableName, 'phase', vars, rangeKey, Math.round(maxPoints), version].join('\u001e');
    }

    _roundedRangeKey(value) {
        return Number.isFinite(value) ? Number(value).toPrecision(15) : String(value);
    }

    _rememberRangeCache(key, value) {
        this._rangeCache.set(key, value);
        while (this._rangeCache.size > 24) {
            const first = this._rangeCache.keys().next().value;
            this._rangeCache.delete(first);
        }
    }

    _rememberPhaseCache(key, value) {
        this._phaseCache.set(key, value);
        while (this._phaseCache.size > 12) {
            const first = this._phaseCache.keys().next().value;
            this._phaseCache.delete(first);
        }
    }

    _clearRangeCacheForTable(tableName) {
        if (!tableName) return;
        if (this._rangeCache?.size) {
            for (const key of [...this._rangeCache.keys()]) {
                if (String(key).startsWith(`${tableName}\u001e`)) this._rangeCache.delete(key);
            }
        }
        if (this._phaseCache?.size) {
            for (const key of [...this._phaseCache.keys()]) {
                if (String(key).startsWith(`${tableName}\u001e`)) this._phaseCache.delete(key);
            }
        }
    }

    /**
     * Pull a window of raw source samples (no bucket aggregation, no
     * decimation) around a reference time, for operations that need exact
     * data points: cursor "next sample", "next extremum", "next zero
     * crossing", etc.
     *
     * Returns `{times: Float64Array, values: Float64Array}` already sorted
     * ascending by time. Up to `maxRows` samples, biased toward `direction`:
     *
     *  - `direction: 'next'` → `contextRows` samples ≤ fromX plus the next
     *    `maxRows - contextRows` samples > fromX.
     *  - `direction: 'prev'` → `contextRows` samples ≥ fromX plus the
     *    previous `maxRows - contextRows` samples < fromX.
     *
     * The context tail ensures the JS algorithms (which need a left/right
     * neighbour to confirm a local extremum) have something to look at.
     */
    async fetchSourceWindow(legacyData, varName, fromX, direction = 'next', maxRows = 50000, contextRows = 32) {
        const meta = legacyData?._duckdb;
        if (!meta) throw new Error('fetchSourceWindow: data is not DuckDB-backed (eager mode)');
        const variable = legacyData.variables?.[varName];
        if (!variable) throw new Error(`fetchSourceWindow: unknown variable "${varName}"`);
        const sourceCol = variable._duckdbCol || varName;
        const timeCol = meta.timeColumn;
        const escTime = timeCol.replace(/"/g, '""');
        const escCol = sourceCol.replace(/"/g, '""');
        const tableName = meta.tableName;
        const lit = (v) => this._numericLiteral(v);
        const timeKind = legacyData?.metadata?.timeKind;
        const tExpr = meta.timeExprSql || (timeKind === 'datetime'
            ? `epoch_ms("${escTime}")::DOUBLE`
            : `"${escTime}"::DOUBLE`);

        if (!Number.isFinite(fromX)) {
            return { times: new Float64Array(0), values: new Float64Array(0) };
        }

        const dataRows = Math.max(1, maxRows - contextRows);
        const orderByT = tExpr;

        const sql = direction === 'prev'
            ? `
                SELECT * FROM (
                    SELECT ${tExpr} AS t, "${escCol}"::DOUBLE AS v
                    FROM ${tableName}
                    WHERE ${tExpr} < ${lit(fromX)}
                    ORDER BY ${orderByT} DESC
                    LIMIT ${dataRows}
                )
                UNION ALL
                SELECT * FROM (
                    SELECT ${tExpr} AS t, "${escCol}"::DOUBLE AS v
                    FROM ${tableName}
                    WHERE ${tExpr} >= ${lit(fromX)}
                    ORDER BY ${orderByT} ASC
                    LIMIT ${contextRows}
                )
                ORDER BY t ASC;
            `
            : `
                SELECT * FROM (
                    SELECT ${tExpr} AS t, "${escCol}"::DOUBLE AS v
                    FROM ${tableName}
                    WHERE ${tExpr} <= ${lit(fromX)}
                    ORDER BY ${orderByT} DESC
                    LIMIT ${contextRows}
                )
                UNION ALL
                SELECT * FROM (
                    SELECT ${tExpr} AS t, "${escCol}"::DOUBLE AS v
                    FROM ${tableName}
                    WHERE ${tExpr} > ${lit(fromX)}
                    ORDER BY ${orderByT} ASC
                    LIMIT ${dataRows}
                )
                ORDER BY t ASC;
            `;

        const result = await this._interactiveQuery(sql);
        return {
            times: this._extractColumnAsFloat64(result, 0, 'DOUBLE'),
            values: this._extractColumnAsFloat64(result, 1, 'DOUBLE'),
        };
    }

    async cancelActiveQuery() {
        const active = this._activeInteractiveQuery;
        if (active) active.cancelled = true;
        const tasks = [];
        if (active?.reader?.cancel) {
            tasks.push(Promise.resolve().then(() => active.reader.cancel()).catch(() => null));
        }
        if (this._conn?.cancelSent) {
            tasks.push(Promise.resolve().then(() => this._conn.cancelSent()).catch(() => null));
        }
        if (!tasks.length) return false;
        await Promise.allSettled(tasks);
        return true;
    }

    async _withConnectionLock(run) {
        const previous = this._connectionQueue || Promise.resolve();
        let release;
        const current = new Promise(resolve => { release = resolve; });
        this._connectionQueue = previous.catch(() => null).then(() => current);
        await previous.catch(() => null);
        try {
            return await run();
        } finally {
            release();
        }
    }

    async _interactiveQuery(sql) {
        return this._withConnectionLock(() => this._interactiveQueryUnlocked(sql));
    }

    async _interactiveQueryUnlocked(sql) {
        await this.init();
        const active = { cancelled: false, reader: null };
        this._activeInteractiveQuery = active;
        const t0 = this._now();
        try {
            const reader = await this._conn.send(sql);
            const t1 = this._now();
            active.reader = reader;
            const batches = await reader.readAll();
            const t2 = this._now();
            if (active.cancelled) {
                const err = new Error('DuckDB query cancelled');
                err.name = 'AbortError';
                throw err;
            }
            const table = new arrow.Table(batches);
            table._omvPerf = {
                sendMs: this._roundMs(t1 - t0),
                readMs: this._roundMs(t2 - t1),
                totalMs: this._roundMs(t2 - t0),
            };
            return table;
        } finally {
            if (this._activeInteractiveQuery === active) {
                this._activeInteractiveQuery = null;
            }
        }
    }

    _now() {
        return globalThis.performance?.now?.() ?? Date.now();
    }

    _roundMs(value) {
        return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
    }

    _numericLiteral(value) {
        if (Number.isFinite(value)) return String(value);
        // For datetime (Unix ms) inputs, also numeric. Bail to a safe sentinel
        // that the BETWEEN clause will exclude.
        return 'NULL';
    }

    async _loadIntoLegacy(handle, tableName, { lazy, overviewPoints, format, csvProfile = null }) {
        const escapedHandle = handle.replace(/'/g, "''");
        const readExpr = format === 'parquet'
            ? `read_parquet('${escapedHandle}')`
            : this._csvReadExpr(escapedHandle, csvProfile);
        let viewMode = false;

        if (format === 'csv' && csvProfile?.delimiter === 'whitespace') {
            throw new Error('DuckDB CSV path does not yet support variable-width whitespace delimiters.');
        }

        // Lazy mode: use VIEW from the start. CREATE TABLE materializes the
        // full CSV/Parquet into DuckDB's WASM heap first, which is exactly
        // what large-file mode is trying to avoid.
        if (lazy) {
            await this._conn.query(`CREATE OR REPLACE VIEW ${tableName} AS SELECT * FROM ${readExpr}`);
            viewMode = true;
        } else {
            try {
                await this._conn.query(`CREATE TABLE ${tableName} AS SELECT * FROM ${readExpr}`);
            } catch (err) {
                const msg = String(err?.message || err);
                const isOom = /malloc|out of memory|memory|allocation/i.test(msg);
                if (!lazy || !isOom) {
                    throw new Error(`DuckDB read failed: ${msg}`);
                }
                // Lazy + OOM (large file): fall back to a VIEW so we never
                // materialize the full dataset. Each query re-reads from the
                // file (with projection / predicate pushdown).
                await this._conn.query(`CREATE OR REPLACE VIEW ${tableName} AS SELECT * FROM ${readExpr}`);
                viewMode = true;
            }
        }

        const schemaResult = await this._conn.query(`DESCRIBE ${tableName}`);
        const schema = this._arrowRowsToObjects(schemaResult);
        const columnNames = schema.map(s => s.column_name);
        const columnTypes = schema.map(s => String(s.column_type || '').toUpperCase());

        const timeInfo = this._timeInfoFromProfile(columnNames, columnTypes, csvProfile)
            || this._timeInfoFromDuckDbSchema(columnNames, columnTypes);
        if (!timeInfo) {
            throw new Error('DuckDB: no suitable time column detected; falling back.');
        }

        const projection = this._projectionSql(columnNames, timeInfo);
        const timeAlias = '__omv_time';
        const escTimeAlias = timeAlias.replace(/"/g, '""');
        const validTimeWhere = `${timeInfo.sql} IS NOT NULL`;

        let totalRows;
        let dataSql;
        if (!viewMode) {
            const countResult = await this._conn.query(`SELECT COUNT(*)::BIGINT AS n FROM ${tableName} WHERE ${validTimeWhere}`);
            const countCol = countResult.getChildAt(0) || countResult.getChild('n');
            totalRows = Number(countCol?.get(0) ?? 0);
            if (format === 'csv' && totalRows <= 0) {
                throw new Error('DuckDB CSV profile produced no valid time rows; falling back.');
            }
            dataSql = (!lazy || totalRows <= overviewPoints)
                ? `SELECT ${projection} FROM ${tableName} WHERE ${validTimeWhere} ORDER BY "${escTimeAlias}" ASC NULLS LAST`
                : this._overviewSql(tableName, projection, escTimeAlias, totalRows, overviewPoints, validTimeWhere);
        } else {
            if (format === 'parquet') {
                totalRows = await this._parquetRowCountFromMetadata(escapedHandle);
            }
            // VIEW mode: skip COUNT (would re-scan the whole CSV) and use
            // streaming reservoir sampling for the initial overview.
            dataSql = `
                WITH projected AS (
                    SELECT ${projection}
                    FROM ${tableName}
                    WHERE ${validTimeWhere}
                ),
                sampled AS (
                    SELECT * FROM projected USING SAMPLE ${overviewPoints} ROWS (RESERVOIR, 42)
                )
                SELECT * FROM sampled ORDER BY "${escTimeAlias}" ASC NULLS LAST
            `;
        }
        const dataResult = await this._conn.query(dataSql);
        const projectedNames = dataResult.schema.fields.map(f => f.name);
        const projectedTypes = dataResult.schema.fields.map((f, i) =>
            i === 0 ? 'DOUBLE' : String(f.type || '').toUpperCase()
        );

        const legacy = this._buildLegacyFromArrow(dataResult, projectedNames, projectedTypes, 0, totalRows, timeInfo);

        if (viewMode) {
            // In view mode the overview is a small reservoir sample, so its
            // first/last values are not the file's true time range. Issue an
            // aggregate query — DuckDB can compute MIN/MAX without sorting.
            try {
                const aggResult = await this._conn.query(
                    `SELECT MIN(${timeInfo.sql})::DOUBLE AS tmin, MAX(${timeInfo.sql})::DOUBLE AS tmax FROM ${tableName} WHERE ${validTimeWhere}`
                );
                const tmin = aggResult.getChild('tmin')?.get(0);
                const tmax = aggResult.getChild('tmax')?.get(0);
                if (Number.isFinite(Number(tmin))) legacy.metadata.timeStart = Number(tmin);
                if (Number.isFinite(Number(tmax))) legacy.metadata.timeEnd = Number(tmax);
            } catch (_) { /* metadata best-effort */ }
            legacy.metadata.numTimesteps = null;
        }

        if (lazy) {
            legacy._duckdb = {
                source: this,
                handle,
                tableName,
                baseTableName: tableName,
                combinedViewName: null,
                appendTableName: null,
                timeColumn: timeInfo.sourceNames[0] || timeInfo.name,
                timeExprSql: timeInfo.sql,
                projectionSql: projection,
                rawColumnNames: columnNames.slice(),
                rawColumnTypes: columnTypes.slice(),
                csvProfile: this._cloneCsvProfile(csvProfile),
                totalRows,
                overviewPoints: totalRows
                    ? Math.min(overviewPoints, totalRows)
                    : overviewPoints,
                viewMode,
                appendRows: 0,
                appendBytes: 0,
                deltaHandles: [],
            };
        }
        return legacy;
    }

    /**
     * Fetch full-trajectory phase data from a lazy DuckDB-backed file.
     *
     * This deliberately does not reuse getColumnsRange(): phase plots need
     * aligned real rows, not time-bucket averages. The default path strides in
     * physical file order after a monotonicity guard, avoiding a full ORDER BY
     * sort that can OOM on multi-GB CSV in DuckDB-WASM.
     */
    async getPhaseTrajectory(legacyData, varNames, options = {}) {
        const meta = legacyData?._duckdb;
        if (!meta) throw new Error('getPhaseTrajectory: data is not DuckDB-backed (eager mode)');
        const requested = [...new Set(varNames || [])]
            .map(varName => ({ varName, variable: legacyData.variables?.[varName] }))
            .filter(item => item.variable);
        if (!requested.length) {
            return {
                rowIndex: new Float64Array(0),
                time: new Float64Array(0),
                yByVar: new Map(),
                rowCount: 0,
                stride: 1,
                monotonic: true,
            };
        }

        const maxPoints = Math.max(2, Math.round(Number(options.maxPoints) || 10000));
        let sourceRange = Array.isArray(options.sourceTimeRange) ? options.sourceTimeRange : null;
        if (!sourceRange && Array.isArray(options.sourceRange)) {
            console.warn('[duckdb] getPhaseTrajectory option "sourceRange" is deprecated; use "sourceTimeRange".');
            sourceRange = options.sourceRange;
        }
        const cacheKey = this._phaseCacheKey(meta, requested, sourceRange, maxPoints);
        const cached = cacheKey ? this._phaseCache.get(cacheKey) : null;
        if (cached) {
            if (cached instanceof Promise) return cached;
            return { ...cached, _perf: { ...(cached._perf || {}), cacheHit: true } };
        }

        const promise = this._queryPhaseTrajectory(legacyData, meta, requested, sourceRange, maxPoints);
        if (cacheKey) this._rememberPhaseCache(cacheKey, promise);
        try {
            const result = await promise;
            if (cacheKey) this._phaseCache.set(cacheKey, result);
            return result;
        } catch (err) {
            if (cacheKey) this._phaseCache.delete(cacheKey);
            throw err;
        }
    }

    async _queryPhaseTrajectory(legacyData, meta, requested, sourceRange, maxPoints) {
        const queryStartedAt = this._now();
        const timeCol = meta.timeColumn;
        const escTime = timeCol.replace(/"/g, '""');
        const timeKind = legacyData?.metadata?.timeKind;
        const tExpr = meta.timeExprSql || (timeKind === 'datetime'
            ? `epoch_ms("${escTime}")::DOUBLE`
            : `"${escTime}"::DOUBLE`);
        const tableName = meta.tableName;
        const where = this._phaseWhereSql(tExpr, sourceRange);

        return this._withConnectionLock(async () => {
            await this._enterPhasePhysicalOrderMode();
            try {
            const statsSql = `
                WITH sequenced AS (
                    SELECT ${tExpr} AS t,
                           LAG(${tExpr}) OVER () AS previous_t
                    FROM ${tableName}
                    WHERE ${where}
                )
                SELECT COUNT(*)::BIGINT AS n,
                       SUM(CASE WHEN previous_t IS NOT NULL AND t < previous_t THEN 1 ELSE 0 END)::BIGINT AS violations
                FROM sequenced;
            `;
            const statsResult = await this._interactiveQueryUnlocked(statsSql);
            const rowCount = Number(statsResult.getChild('n')?.get(0) ?? 0);
            const violations = Number(statsResult.getChild('violations')?.get(0) ?? 0);
            if (!Number.isFinite(rowCount) || rowCount <= 0) {
                return {
                    rowIndex: new Float64Array(0),
                    time: new Float64Array(0),
                    yByVar: new Map(requested.map(({ varName }) => [varName, new Float64Array(0)])),
                    rowCount: 0,
                    stride: 1,
                    monotonic: true,
                    _perf: this._phasePerf({
                        mode: 'empty',
                        startedAt: queryStartedAt,
                        extractStartedAt: this._now(),
                        result: statsResult,
                        rows: 0,
                        requested,
                        maxPoints,
                        rowCount: 0,
                        stride: 1,
                        violations: 0,
                    }),
                };
            }
            if (violations > 0) {
                throw new Error('Phase trajectory requires the file to be sorted by time. This lazy CSV/Parquet is not monotonic in physical row order; convert/sort to Parquet before opening a phase plot.');
            }

            const last = rowCount - 1;
            const stride = rowCount <= maxPoints
                ? 1
                : Math.max(1, Math.ceil(last / Math.max(1, maxPoints - 1)));
            const valueSelect = requested
                .map(({ variable }, index) => `${this._quoteIdent(variable._duckdbCol || variable.name)}::DOUBLE AS v${index}`)
                .join(',\n                       ');
            const valueNames = requested.map((_, index) => `v${index}`).join(', ');
            const sql = `
                WITH numbered AS (
                    SELECT (ROW_NUMBER() OVER () - 1)::BIGINT AS rn,
                           ${tExpr}::DOUBLE AS t,
                           ${valueSelect}
                    FROM ${tableName}
                    WHERE ${where}
                )
                SELECT rn::DOUBLE AS __rn,
                       t,
                       ${valueNames}
                FROM numbered
                WHERE rn = 0
                   OR rn = ${Math.round(last)}
                   OR rn % ${Math.round(stride)} = 0
                ORDER BY rn;
            `;
            const result = await this._interactiveQueryUnlocked(sql);
            const extractStartedAt = this._now();
            const yByVar = new Map();
            requested.forEach(({ varName }, index) => {
                yByVar.set(varName, this._extractColumnAsFloat64(result, index + 2, 'DOUBLE'));
            });
            const rowIndex = this._extractColumnAsFloat64(result, 0, 'DOUBLE');
            const time = this._extractColumnAsFloat64(result, 1, 'DOUBLE');
            return {
                rowIndex,
                time,
                yByVar,
                rowCount,
                stride,
                monotonic: true,
                _perf: this._phasePerf({
                    mode: 'physical-stride',
                    startedAt: queryStartedAt,
                    extractStartedAt,
                    result,
                    rows: time.length,
                    requested,
                    maxPoints,
                    rowCount,
                    stride,
                    violations,
                }),
            };
            } finally {
                await this._leavePhasePhysicalOrderMode();
            }
        });
    }

    async _enterPhasePhysicalOrderMode() {
        try {
            // Single-threaded physical-order mode is slower, but it keeps
            // ROW_NUMBER() OVER () tied to scan order for phase trajectories.
            await this._conn.query(`PRAGMA threads=${DUCKDB_PHASE_THREADS}`);
            await this._conn.query(`PRAGMA preserve_insertion_order=${DUCKDB_PHASE_PRESERVE_INSERTION_ORDER}`);
        } catch (_) { /* best-effort: phase still has the monotonicity guard */ }
    }

    async _leavePhasePhysicalOrderMode() {
        try {
            await this._conn.query(`PRAGMA preserve_insertion_order=${DUCKDB_DEFAULT_PRESERVE_INSERTION_ORDER}`);
            await this._conn.query(`PRAGMA threads=${DUCKDB_DEFAULT_THREADS}`);
        } catch (_) { /* restore is best-effort */ }
    }

    _phaseWhereSql(tExpr, sourceRange) {
        const clauses = [`${tExpr} IS NOT NULL`];
        if (Array.isArray(sourceRange) && sourceRange.length >= 2) {
            let [lo, hi] = sourceRange.map(Number);
            if (Number.isFinite(lo) && Number.isFinite(hi)) {
                if (lo > hi) [lo, hi] = [hi, lo];
                clauses.push(`${tExpr} BETWEEN ${this._numericLiteral(lo)} AND ${this._numericLiteral(hi)}`);
            }
        }
        return clauses.join(' AND ');
    }

    _phasePerf({ mode, startedAt, extractStartedAt, result, rows, requested, maxPoints, rowCount, stride, violations }) {
        const finishedAt = this._now();
        const queryPerf = result?._omvPerf || {};
        return {
            mode,
            vars: requested.length,
            rows,
            target: maxPoints,
            rowCount,
            stride,
            monotonicViolations: violations,
            queryMs: this._roundMs(queryPerf.totalMs ?? (extractStartedAt - startedAt)),
            sendMs: this._roundMs(queryPerf.sendMs),
            readMs: this._roundMs(queryPerf.readMs),
            extractMs: this._roundMs(finishedAt - extractStartedAt),
            totalMs: this._roundMs(finishedAt - startedAt),
            cacheHit: false,
        };
    }

    async _ensureAppendTable(meta, csvProfile) {
        if (meta.appendTableName && meta.combinedViewName) return;
        const base = meta.baseTableName || meta.tableName;
        const append = `${base}_append`;
        const combined = `${base}_live`;
        const specs = this._csvColumnSpecs(csvProfile);
        const columns = specs
            .map(({ name, type }) => `${this._quoteIdent(name)} ${type || 'VARCHAR'}`)
            .join(', ');
        await this._conn.query(`CREATE TABLE IF NOT EXISTS ${append} (${columns})`);
        await this._conn.query(`
            CREATE OR REPLACE VIEW ${combined} AS
            SELECT * FROM ${base}
            UNION ALL
            SELECT * FROM ${append}
        `);
        meta.baseTableName = base;
        meta.appendTableName = append;
        meta.combinedViewName = combined;
        meta.tableName = combined;
        meta.csvProfile = meta.csvProfile || this._cloneCsvProfile(csvProfile);
    }

    _cloneCsvProfile(csvProfile) {
        if (!csvProfile) return null;
        if (typeof structuredClone === 'function') return structuredClone(csvProfile);
        return JSON.parse(JSON.stringify(csvProfile));
    }

    _projectedDeltaColumns(legacyData, table) {
        const fields = table.schema.fields.map(f => f.name);
        const time = this._extractColumnAsFloat64(table, 0, 'DOUBLE');
        const variables = new Map();
        for (const [name, variable] of Object.entries(legacyData?.variables || {})) {
            if (variable.kind === 'abscissa' || variable.source === 'derived' || variable.source === 'data-tool') continue;
            const rawName = variable._duckdbCol || name;
            const index = fields.indexOf(rawName);
            if (index < 0) continue;
            const values = variable.dataType === 'string'
                ? this._extractColumnAsStrings(table, index)
                : this._extractColumnAsFloat64(table, index, 'DOUBLE');
            variables.set(name, values);
        }
        return { timeValues: time, variables };
    }

    _csvReadExpr(escapedHandle, csvProfile = null, readOptions = {}) {
        if (!csvProfile) return `read_csv_auto('${escapedHandle}', sample_size=20000)`;

        const specs = this._csvColumnSpecs(csvProfile);
        const skip = Number.isFinite(Number(readOptions.skip))
            ? Number(readOptions.skip)
            : Math.max(0, Number(csvProfile.dataStartIndex) || 0);
        const options = [
            `auto_detect=false`,
            `header=false`,
            `skip=${skip}`,
            `columns=${this._duckDbColumnsStruct(specs)}`,
            `ignore_errors=true`,
        ];
        if (csvProfile.delimiter && csvProfile.delimiter !== 'whitespace') {
            options.push(`delim='${this._escapeSqlString(csvProfile.delimiter)}'`);
        }
        if (this._csvUsesDecimalComma(csvProfile)) options.push(`decimal_separator=','`);
        return `read_csv('${escapedHandle}', ${options.join(', ')})`;
    }

    _csvColumnSpecs(csvProfile) {
        const rawHeaders = csvProfile?.rawHeaders || [];
        const headers = csvProfile?.headers || [];
        const sampleRows = csvProfile?.sampleRows || [];
        const timeSource = csvProfile?.timeSource || {};
        const timeIndexes = new Set(timeSource.sourceIndexes || []);
        return rawHeaders.map((raw, index) => {
            const header = headers[index] || {};
            const name = header.name || String(raw || `column_${index + 1}`);
            const forceVarchar = timeIndexes.has(index)
                && timeSource.kind === 'datetime'
                && !['excel-serial', 'matlab-datenum', 'decimal-year'].includes(timeSource.strategy);
            return {
                name,
                type: forceVarchar ? 'VARCHAR' : this._inferDuckDbCsvType(sampleRows, index, csvProfile.delimiter),
            };
        });
    }

    _inferDuckDbCsvType(sampleRows, index, delimiter) {
        let nonEmpty = 0;
        let numeric = 0;
        for (const row of sampleRows || []) {
            const raw = String(row?.[index] ?? '').trim();
            if (!raw) continue;
            nonEmpty++;
            if (Number.isFinite(parseCsvNumber(raw, delimiter))) numeric++;
        }
        return nonEmpty > 0 && (numeric / nonEmpty) >= 0.95 ? 'DOUBLE' : 'VARCHAR';
    }

    _duckDbColumnsStruct(specs) {
        const fields = specs.map(({ name, type }) =>
            `'${this._escapeSqlString(name)}': '${this._escapeSqlString(type || 'VARCHAR')}'`
        );
        return `{${fields.join(', ')}}`;
    }

    _csvUsesDecimalComma(csvProfile) {
        if (!csvProfile || csvProfile.delimiter === ',') return false;
        for (const row of csvProfile.sampleRows || []) {
            for (const cell of row || []) {
                const raw = String(cell ?? '').trim();
                if (/^[+-]?\d+,\d+(?:[eEdD][+-]?\d+)?$/.test(raw)) return true;
            }
        }
        return false;
    }

    async _parquetRowCountFromMetadata(escapedHandle) {
        try {
            const result = await this._conn.query(`
                SELECT SUM(row_group_num_rows)::BIGINT AS n
                FROM (
                    SELECT DISTINCT row_group_id, row_group_num_rows
                    FROM parquet_metadata('${escapedHandle}')
                )
            `);
            const value = result.getChild('n')?.get(0);
            const count = Number(value);
            return Number.isFinite(count) && count > 0 ? count : null;
        } catch (_) {
            return null;
        }
    }

    _timeInfoFromDuckDbSchema(columnNames, columnTypes) {
        let timeColIndex = columnNames.findIndex(name => TIME_HEADER_RE.test(String(name).trim()));
        if (timeColIndex < 0) {
            const firstType = columnTypes[0] || '';
            if (/INT|BIGINT|DOUBLE|REAL|FLOAT|DECIMAL|NUMERIC|TIMESTAMP|DATE|TIME/.test(firstType)) {
                timeColIndex = 0;
            }
        }
        if (timeColIndex < 0) return null;
        const name = columnNames[timeColIndex];
        const type = columnTypes[timeColIndex] || '';
        const esc = this._quoteIdent(name);
        const timeKind = /TIMESTAMP|DATE|TIME/.test(type) ? 'datetime' : 'numeric';
        return {
            name,
            description: timeKind === 'datetime' ? '[datetime]' : '',
            timeKind,
            sourceNames: [name],
            sql: timeKind === 'datetime' ? `epoch_ms(${esc})::DOUBLE` : esc,
        };
    }

    _timeInfoFromProfile(columnNames, columnTypes, csvProfile) {
        const timeSource = csvProfile?.timeSource;
        if (!timeSource?.ok) return null;
        if (timeSource.kind === 'index' || timeSource.strategy === 'generated-index') return null;

        const sourceNames = (timeSource.sourceIndexes || [])
            .map(index => columnNames[index])
            .filter(name => name != null);
        if (!sourceNames.length) return null;

        const name = timeSource.name || sourceNames.join(' ');
        const description = timeSource.description || (timeSource.kind === 'datetime' ? '[datetime]' : '');
        const firstName = sourceNames[0];
        const firstType = columnTypes[timeSource.sourceIndexes?.[0] ?? 0] || '';
        const first = this._quoteIdent(firstName);
        let sql = null;

        if (timeSource.kind === 'numeric') {
            sql = first;
        } else if (timeSource.kind === 'datetime') {
            sql = this._datetimeSqlFromProfile(timeSource, sourceNames, firstType);
        }

        if (!sql) return null;
        return {
            name,
            description,
            timeKind: timeSource.kind,
            sourceNames,
            sql,
        };
    }

    _datetimeSqlFromProfile(timeSource, sourceNames, firstType) {
        const first = this._quoteIdent(sourceNames[0]);
        if (/TIMESTAMP|DATE|TIME/.test(firstType || '')) return `epoch_ms(${first})::DOUBLE`;

        const strategy = timeSource.strategy;
        if (strategy === 'excel-serial') return `((${first}::DOUBLE - 25569) * ${MS_PER_DAY})`;
        if (strategy === 'matlab-datenum') return `((${first}::DOUBLE - 719529) * ${MS_PER_DAY})`;
        if (strategy === 'decimal-year') return this._decimalYearSql(first);
        if (strategy === 'yearless-date-time') return this._yearlessDateTimeSql(first, timeSource.format);
        if (strategy === 'month-name-date') return this._monthNameDateSql(first);

        if (strategy === 'iso-datetime') {
            return `epoch_ms(CAST(${first} AS TIMESTAMP))::DOUBLE`;
        }

        const order = timeSource.format?.dateOrder || 'YMD';
        if (strategy === 'slash-date' || strategy === 'dash-date') {
            const formats = this._dateTimeFormats(order, strategy === 'dash-date' ? '-' : '/');
            return this._tryStrptimeSql(`CAST(${first} AS VARCHAR)`, formats);
        }

        if (timeSource.mode === 'split' && sourceNames.length >= 2) {
            const dateCol = this._quoteIdent(sourceNames[0]);
            const timeCol = this._quoteIdent(sourceNames[1]);
            const sep = timeSource.format?.dashSeparator ? '-' : '/';
            const formats = this._dateTimeFormats(order, sep);
            const expr = `CAST(${dateCol} AS VARCHAR) || ' ' || CAST(${timeCol} AS VARCHAR)`;
            return this._tryStrptimeSql(expr, formats);
        }

        return null;
    }

    _dateTimeFormats(order, sep) {
        const date = order === 'DMY'
            ? `%d${sep}%m${sep}%Y`
            : order === 'MDY'
              ? `%m${sep}%d${sep}%Y`
              : `%Y${sep}%m${sep}%d`;
        const shortYear = order === 'DMY'
            ? `%d${sep}%m${sep}%y`
            : order === 'MDY'
              ? `%m${sep}%d${sep}%y`
              : `%y${sep}%m${sep}%d`;
        return [
            `${date} %H:%M:%S.%f`,
            `${date} %H:%M:%S`,
            `${date} %H:%M`,
            date,
            `${shortYear} %H:%M:%S.%f`,
            `${shortYear} %H:%M:%S`,
            `${shortYear} %H:%M`,
            shortYear,
        ];
    }

    _decimalYearSql(expr) {
        const value = `${expr}::DOUBLE`;
        const year = `FLOOR(${value})`;
        const leap = `((${year} % 4 = 0 AND ${year} % 100 <> 0) OR ${year} % 400 = 0)`;
        return `(
            epoch_ms(CAST(CAST(CAST(${year} AS BIGINT) AS VARCHAR) || '-01-01' AS TIMESTAMP))::DOUBLE
            + (${value} - ${year}) * CASE WHEN ${leap} THEN 366 ELSE 365 END * ${MS_PER_DAY}
        )`;
    }

    _yearlessDateTimeSql(expr, format = {}) {
        const order = format?.dateOrder || 'MDY';
        const sep = format?.dashSeparator ? '-' : '/';
        const date = order === 'DMY'
            ? `%Y${sep}%d${sep}%m`
            : `%Y${sep}%m${sep}%d`;
        const formats = [
            `${date} %H:%M:%S.%f`,
            `${date} %H:%M:%S`,
            `${date} %H:%M`,
        ];
        return this._tryStrptimeSql(`'2001${sep}' || CAST(${expr} AS VARCHAR)`, formats);
    }

    _monthNameDateSql(expr) {
        return this._tryStrptimeSql(this._normalizedMonthNameSql(expr), [
            '%d-%b-%Y %H:%M:%S.%f',
            '%d-%b-%Y %H:%M:%S',
            '%d-%b-%Y %H:%M',
            '%d-%b-%Y',
            '%d %b %Y %H:%M:%S.%f',
            '%d %b %Y %H:%M:%S',
            '%d %b %Y %H:%M',
            '%d %b %Y',
            '%b %d %Y %H:%M:%S.%f',
            '%b %d %Y %H:%M:%S',
            '%b %d %Y %H:%M',
            '%b %d %Y',
            '%B %d %Y %H:%M:%S.%f',
            '%B %d %Y %H:%M:%S',
            '%B %d %Y %H:%M',
            '%B %d %Y',
        ]);
    }

    _normalizedMonthNameSql(expr) {
        let sql = `lower(regexp_replace(CAST(${expr} AS VARCHAR), '\\.', '', 'g'))`;
        const replacements = [
            ['january', 'jan'], ['janvier', 'jan'], ['enero', 'jan'],
            ['february', 'feb'], ['février', 'feb'], ['fevrier', 'feb'], ['févr', 'feb'], ['fevr', 'feb'], ['febrero', 'feb'],
            ['march', 'mar'], ['mars', 'mar'], ['marzo', 'mar'],
            ['april', 'apr'], ['avril', 'apr'], ['abril', 'apr'],
            ['mayo', 'may'], ['mai', 'may'],
            ['june', 'jun'], ['juin', 'jun'], ['junio', 'jun'],
            ['july', 'jul'], ['juillet', 'jul'], ['juil', 'jul'], ['julio', 'jul'],
            ['august', 'aug'], ['août', 'aug'], ['aout', 'aug'], ['agosto', 'aug'],
            ['september', 'sep'], ['septembre', 'sep'], ['septiembre', 'sep'], ['sept', 'sep'],
            ['october', 'oct'], ['octobre', 'oct'], ['octubre', 'oct'],
            ['november', 'nov'], ['novembre', 'nov'], ['noviembre', 'nov'],
            ['december', 'dec'], ['décembre', 'dec'], ['decembre', 'dec'], ['diciembre', 'dec'],
        ];
        for (const [from, to] of replacements) {
            sql = `replace(${sql}, '${this._escapeSqlString(from)}', '${to}')`;
        }
        return sql;
    }

    _tryStrptimeSql(expr, formats) {
        const list = formats.map(format => `'${this._escapeSqlString(format)}'`).join(', ');
        return `epoch_ms(try_strptime(${expr}, [${list}]))::DOUBLE`;
    }

    _projectionSql(columnNames, timeInfo) {
        const exclude = new Set(timeInfo.sourceNames || []);
        const columns = columnNames
            .filter(name => !exclude.has(name))
            .map(name => this._quoteIdent(name));
        return [
            `${timeInfo.sql} AS "__omv_time"`,
            ...columns,
        ].join(', ');
    }

    _quoteIdent(name) {
        return `"${String(name ?? '').replace(/"/g, '""')}"`;
    }

    _escapeSqlString(value) {
        return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "''");
    }

    _overviewSql(tableName, projection, escTime, totalRows, overviewPoints, whereSql = null) {
        const stride = Math.max(1, Math.ceil(totalRows / overviewPoints));
        // Keep first + last + every Nth row by time order. Numbered separately
        // so the result is still ordered by time.
        return `
            WITH projected AS (
                SELECT ${projection}
                FROM ${tableName}
                ${whereSql ? `WHERE ${whereSql}` : ''}
            ),
            numbered AS (
                SELECT *, ROW_NUMBER() OVER (ORDER BY "${escTime}") AS __rn
                FROM projected
            )
            SELECT * EXCLUDE (__rn) FROM numbered
            WHERE __rn = 1 OR __rn = ${totalRows} OR (__rn - 1) % ${stride} = 0
            ORDER BY __rn;
        `;
    }

    _arrowRowsToObjects(table) {
        const rows = [];
        const numRows = table.numRows;
        const fields = table.schema.fields.map(f => f.name);
        for (let i = 0; i < numRows; i++) {
            const row = {};
            for (const name of fields) {
                row[name] = table.getChild(name)?.get(i);
            }
            rows.push(row);
        }
        return rows;
    }

    _buildLegacyFromArrow(table, columnNames, columnTypes, timeColIndex, totalRows, timeInfo = null) {
        const result = {
            filename: '',
            metadata: {},
            variables: {},
            tree: {},
        };

        const timeName = timeInfo?.name || columnNames[timeColIndex];
        const timeType = columnTypes[timeColIndex];
        const timeData = this._extractColumnAsFloat64(table, timeColIndex, timeType);
        const timeKind = timeInfo?.timeKind || (/TIMESTAMP|DATE|TIME/.test(timeType) ? 'datetime' : 'numeric');
        const datetimeAxisStalled = timeKind === 'datetime' && this._isStalledTimeAxis(timeData);

        const usedNames = new Set();
        const sanitize = (raw) => {
            const base = String(raw ?? '').trim() || `column`;
            return base;
        };

        const timeVar = {
            name: this._uniqueName(sanitize(timeName), usedNames),
            data: timeData,
            description: timeInfo?.description || (timeKind === 'datetime' ? '[datetime]' : ''),
            kind: 'abscissa',
            dataType: 'real',
            isConstant: false,
            interpolation: 'linear',
            negate: false,
            source: 'csv',
            _duckdbCol: timeInfo?.sourceNames?.[0] || columnNames[timeColIndex],
        };
        if (timeKind === 'datetime') {
            timeVar.timeKind = 'datetime';
            timeVar.timeDisplayMode = datetimeAxisStalled ? 'index' : 'calendar';
            timeVar.timeOriginMs = timeData.length ? timeData[0] : null;
        }
        result.variables[timeVar.name] = timeVar;
        usedNames.add(timeVar.name);

        let numTimevarying = 0;
        for (let i = 0; i < columnNames.length; i++) {
            if (i === timeColIndex) continue;
            const colName = sanitize(columnNames[i]);
            const colType = columnTypes[i];
            const isNumeric = /INT|BIGINT|DOUBLE|REAL|FLOAT|DECIMAL|NUMERIC/.test(colType);
            const data = isNumeric
                ? this._extractColumnAsFloat64(table, i, colType)
                : this._extractColumnAsStrings(table, i);
            const uniqueName = this._uniqueName(colName, usedNames);
            usedNames.add(uniqueName);
            const isConstant = this._isConstantData(data);
            result.variables[uniqueName] = {
                name: uniqueName,
                data,
                description: '',
                kind: 'variable',
                dataType: isNumeric ? 'real' : 'string',
                isConstant,
                interpolation: 'linear',
                negate: false,
                source: 'csv',
                _duckdbCol: columnNames[i],
            };
            numTimevarying++;
        }

        result.metadata = {
            numVariables: Object.keys(result.variables).length,
            numParams: 0,
            numTimevarying,
            numTimesteps: timeData.length,
            timeStart: timeData.length ? timeData[0] : 0,
            timeEnd: timeData.length ? timeData[timeData.length - 1] : 0,
            csv: true,
            delimiter: 'auto',
            hasHeader: true,
            skippedRows: 0,
            skippedRowsAfterHeader: 0,
            timeName: timeVar.name,
            timeKind,
            timeDisplayMode: timeKind === 'datetime' ? (datetimeAxisStalled ? 'index' : 'calendar') : 'numeric',
            timeOriginMs: timeVar.timeOriginMs ?? null,
            timeSourceColumns: timeInfo?.sourceNames?.length ? timeInfo.sourceNames : [timeName],
            datetimeAxisStalled,
            backend: 'duckdb',
        };

        if (this.structureParser?._buildTree) {
            result.tree = this.structureParser._buildTree(result.variables);
        } else {
            result.tree = this._flatTree(result.variables);
        }
        return result;
    }

    _extractColumnAsFloat64(table, idx, type) {
        const child = table.getChildAt(idx);
        if (!child) return new Float64Array(0);
        // TIMESTAMP / DATE / TIME columns: convert to Unix milliseconds.
        if (/TIMESTAMP|DATE|TIME/.test(type)) {
            const arr = new Float64Array(child.length);
            for (let i = 0; i < child.length; i++) {
                const v = child.get(i);
                if (v == null) { arr[i] = NaN; continue; }
                arr[i] = typeof v === 'number' ? v : (v instanceof Date ? v.getTime() : Number(v));
            }
            return arr;
        }
        // Try the typed-array fast path only when Arrow reports no nulls.
        // toArray() drops the validity bitmap for primitive columns, which
        // turns NULL into 0 and creates fake spikes/drops in line plots.
        if (!(Number(child.nullCount) > 0)) {
            try {
                const raw = child.toArray();
                if (raw instanceof Float64Array) return raw;
                if (raw instanceof Float32Array
                    || raw instanceof Int32Array || raw instanceof Uint32Array
                    || raw instanceof Int16Array || raw instanceof Uint16Array
                    || raw instanceof Int8Array  || raw instanceof Uint8Array) {
                    return Float64Array.from(raw);
                }
                if (Array.isArray(raw)) {
                    const arr = new Float64Array(raw.length);
                    for (let i = 0; i < raw.length; i++) arr[i] = raw[i] == null ? NaN : Number(raw[i]);
                    return arr;
                }
            } catch (_) { /* fall through */ }
        }
        // Fallback: iterate.
        const arr = new Float64Array(child.length);
        for (let i = 0; i < child.length; i++) {
            const v = child.get(i);
            arr[i] = v == null ? NaN : Number(v);
        }
        return arr;
    }

    _extractColumnAsStrings(table, idx) {
        const child = table.getChildAt(idx);
        if (!child) return [];
        const arr = new Array(child.length);
        for (let i = 0; i < child.length; i++) {
            const v = child.get(i);
            arr[i] = v == null ? '' : String(v);
        }
        return arr;
    }

    _isConstantData(data) {
        if (!data || data.length < 2) return true;
        const first = data[0];
        for (let i = 1; i < data.length; i++) {
            if (data[i] !== first) return false;
        }
        return true;
    }

    _isStalledTimeAxis(data) {
        if (!data || data.length < 3) return false;
        let previous = NaN;
        let runLength = 0;
        const limit = Math.min(data.length, 1000);
        for (let i = 0; i < limit; i++) {
            const value = Number(data[i]);
            if (!Number.isFinite(value)) {
                previous = NaN;
                runLength = 0;
                continue;
            }
            runLength = value === previous ? runLength + 1 : 1;
            previous = value;
            if (runLength >= 3) return true;
        }
        return false;
    }

    _uniqueName(base, used) {
        if (!used.has(base)) return base;
        let i = 2;
        while (used.has(`${base}_${i}`)) i++;
        return `${base}_${i}`;
    }

    _flatTree(variables) {
        const tree = {};
        for (const name of Object.keys(variables)) tree[name] = { _leaf: true, name };
        return tree;
    }

    async shutdown() {
        for (const name of [...this._registered]) await this.unregisterFile(name);
        try { await this._conn?.close(); } catch (_) { /* ignore */ }
        try { await this._db?.terminate(); } catch (_) { /* ignore */ }
        this._conn = null;
        this._db = null;
        this._initPromise = null;
    }
}
