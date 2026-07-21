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
import { customDatetimePatternInfo, parseCsvNumber, parseCsvTimeValue } from '../parsers/csv-time-detection.js';
import { registerDuckDbFile } from './duckdb-file-registration.js';
import { duckDbAppendGrowthLimitError } from './duckdb-live-limits.js';
import { buildPairCorrelationSql, parsePairCorrelations } from './pair-correlation-sql.js';
import { buildMissingBucketsSql } from './missing-buckets-sql.js';
import { pandasColumnPaths } from './parquet-pandas-metadata.js';
import {
    buildTemporalProfileFinalSql,
    buildTemporalProfileTimeStatsSql,
    temporalProfilesFromFinalRows,
} from './temporal-profile-sql.js';

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
        this._heatmapCache = new Map();
        this._temporalProfileCache = new Map();
        this._correlationCache = new Map();
        this._corrCapable = null; // cached "does DuckDB expose corr()" probe
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
        const validWhere = this._andSql([
            this._csvRowFilterSql(csvProfile),
            meta.generatedTime ? 'TRUE' : `${meta.timeExprSql} IS NOT NULL`,
        ]);
        const expectedRows = options.expectedRows == null ? NaN : Number(options.expectedRows);

        return this._withConnectionLock(async () => {
            await this._ensureAppendTable(meta, csvProfile);
            const generatedBaseRows = meta.generatedTime
                ? await this._currentDuckDbRowCount(meta)
                : 0;
            await this.registerFile(deltaHandle, deltaFile);
            meta.deltaHandles = [...(meta.deltaHandles || []), deltaHandle];
            try {
                await this._conn.query(`CREATE OR REPLACE TEMP VIEW ${deltaView} AS SELECT * FROM ${readExpr}`);
                const countResult = meta.generatedTime
                    ? await this._conn.query(`SELECT COUNT(*)::BIGINT AS n FROM ${deltaView} WHERE ${validWhere}`)
                    : await this._conn.query(`
                        SELECT
                            COUNT(*)::BIGINT AS n,
                            COUNT(DISTINCT ${meta.timeExprSql})::BIGINT AS distinct_n,
                            MIN(${meta.timeExprSql})::DOUBLE AS tmin,
                            MAX(${meta.timeExprSql})::DOUBLE AS tmax
                        FROM ${deltaView}
                        WHERE ${validWhere}
                    `);
                const rows = Number(countResult.getChild('n')?.get(0) ?? 0);
                const distinctRows = meta.generatedTime ? rows : Number(countResult.getChild('distinct_n')?.get(0) ?? 0);
                const minTime = meta.generatedTime ? generatedBaseRows : Number(countResult.getChild('tmin')?.get(0));
                const maxTime = meta.generatedTime ? generatedBaseRows + rows - 1 : Number(countResult.getChild('tmax')?.get(0));
                if (Number.isFinite(expectedRows) && rows !== expectedRows) {
                    throw new Error(`DuckDB accepted ${rows} appended rows; expected ${expectedRows}.`);
                }
                if (rows <= 0) {
                    if (csvProfile?.rowFilter?.enabled) {
                        return {
                            rows: 0,
                            timeStart: null,
                            timeEnd: null,
                            columns: { timeValues: [], variables: new Map() },
                        };
                    }
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

                const projectionSql = meta.generatedTime
                    ? this._generatedIndexProjectionSql(meta.rawColumnNames || [], generatedBaseRows, csvProfile)
                    : meta.projectionSql;
                const projected = await this._conn.query(`
                    SELECT ${projectionSql}
                    FROM ${deltaView}
                    WHERE ${validWhere}
                    ORDER BY "__omv_time" ASC NULLS LAST
                `);
                await this._conn.query(`INSERT INTO ${meta.appendTableName} SELECT * FROM ${deltaView} WHERE ${validWhere}`);

                meta.appendRows = (Number(meta.appendRows) || 0) + rows;
                meta.appendBytes = (Number(meta.appendBytes) || 0) + deltaText.length;
                if (meta.generatedTime) meta.totalRows = generatedBaseRows + rows;
                else if (Number.isFinite(Number(meta.totalRows))) meta.totalRows = Number(meta.totalRows) + rows;
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

    /**
     * Fetch exact source samples for algorithms such as FFT that must not use
     * the overview or server-side aggregation. The caller gets up to
     * `maxRows + 1` rows; `truncated` tells the UI to reject the request before
     * running an expensive calculation on an oversized selection.
     */
    async getRawColumnsRange(legacyData, varNames, t0, t1, maxRows = 500000) {
        const meta = legacyData?._duckdb;
        if (!meta) throw new Error('getRawColumnsRange: data is not DuckDB-backed (eager mode)');
        const requested = [...new Set(varNames || [])]
            .map(varName => ({ varName, variable: legacyData.variables?.[varName] }))
            .filter(item => item.variable)
            .sort((a, b) => String(a.varName).localeCompare(String(b.varName)));
        if (!requested.length) {
            return { x: new Float64Array(0), rowIndex: new Float64Array(0), yByVar: new Map(), truncated: false };
        }

        let lo = Number(t0);
        let hi = Number(t1);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
            return { x: new Float64Array(0), rowIndex: new Float64Array(0), yByVar: new Map(), truncated: false };
        }
        if (lo > hi) [lo, hi] = [hi, lo];

        const limit = Math.max(1, Math.round(Number(maxRows) || 1)) + 1;
        const timeCol = meta.timeColumn;
        const escTime = timeCol.replace(/"/g, '""');
        const tableName = meta.tableName;
        const lit = (v) => this._numericLiteral(v);
        const timeKind = legacyData?.metadata?.timeKind;
        const tExpr = meta.timeExprSql || (timeKind === 'datetime'
            ? `epoch_ms("${escTime}")::DOUBLE`
            : `"${escTime}"::DOUBLE`);
        const valueSelect = requested
            .map(({ variable, varName }, index) => `${this._valueExpressionSql(variable, varName, { castDouble: true })} AS v${index}`)
            .join(',\n                               ');
        const valueNames = requested.map((_, index) => `v${index}`).join(', ');

        // `rn` (the file-absolute row index) is only consumed downstream for
        // GENERATED-time files (_transformFetchedPhaseTrajectory maps rn ->
        // display time). For a real time column it is unused, so we must NOT pay
        // for `ROW_NUMBER() OVER (ORDER BY t)` — that is a full-table sort of
        // every row and OOMs DuckDB-WASM on multi-million-row files (surfacing
        // as "Could not fetch raw samples"). Generated time gets its index from
        // the cheap physical-order ROW_NUMBER() OVER () that also defines t.
        // No ORDER BY: a full sort of every matching row (up to millions) is what
        // OOMs DuckDB-WASM in the browser (LIMIT is far above the row count, so
        // top-N never kicks in). Rows come back in physical storage order, which
        // for a time-sorted file IS time order; the FFT's own monotonicity gate
        // catches any file that is not sorted. Same precedent as getPhaseTrajectory.
        let sql;
        if (meta.generatedTime) {
            sql = `
                WITH base AS (
                    SELECT (ROW_NUMBER() OVER () - 1)::DOUBLE AS t,
                           ${valueSelect}
                    FROM ${tableName}
                )
                SELECT t,
                       t AS rn,
                       ${valueNames}
                FROM base
                WHERE t BETWEEN ${lit(lo)} AND ${lit(hi)}
                LIMIT ${limit};
            `;
        } else {
            sql = `
                SELECT t,
                       CAST(NULL AS DOUBLE) AS rn,
                       ${valueNames}
                FROM (
                    SELECT ${tExpr} AS t,
                           ${valueSelect}
                    FROM ${tableName}
                )
                WHERE t BETWEEN ${lit(lo)} AND ${lit(hi)}
                LIMIT ${limit};
            `;
        }
        const result = await this._interactiveQuery(sql);
        const xFull = this._extractColumnAsFloat64(result, 0, 'DOUBLE');
        const rowIndexFull = this._extractColumnAsFloat64(result, 1, 'DOUBLE');
        const truncated = xFull.length > limit - 1;
        const keep = truncated ? limit - 1 : xFull.length;
        const x = truncated ? xFull.slice(0, keep) : xFull;
        const rowIndex = truncated ? rowIndexFull.slice(0, keep) : rowIndexFull;
        const yByVar = new Map();
        requested.forEach(({ varName }, index) => {
            const values = this._extractColumnAsFloat64(result, index + 2, 'DOUBLE');
            yByVar.set(varName, truncated ? values.slice(0, keep) : values);
        });
        return { x, rowIndex, yByVar, truncated };
    }

    /**
     * Truthful Missing/NaN detection for a lazy file over a visible range.
     * Buckets the range into `nBuckets` (~one per pixel) and returns, per bucket
     * that held rows, how many rows fell in it and how many had a non-finite
     * value for ANY of `varNames`. Empty buckets inside the data are time gaps
     * (inferred JS-side). One O(nBuckets) aggregate — no full-resolution scan,
     * no sort. See missing-buckets-sql.js for the pure builder/reducer.
     */
    async getMissingIntervals(legacyData, varNames, t0, t1, nBuckets = 1500) {
        const meta = legacyData?._duckdb;
        if (!meta) throw new Error('getMissingIntervals: data is not DuckDB-backed (eager mode)');
        const requested = [...new Set(varNames || [])]
            .map(varName => ({ varName, variable: legacyData.variables?.[varName] }))
            .filter(item => item.variable);
        let lo = Number(t0);
        let hi = Number(t1);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { buckets: [] };
        if (lo > hi) [lo, hi] = [hi, lo];

        const timeKind = legacyData?.metadata?.timeKind;
        const escTime = (meta.timeColumn || '').replace(/"/g, '""');
        const tExpr = meta.timeExprSql || (timeKind === 'datetime'
            ? `epoch_ms("${escTime}")::DOUBLE`
            : `"${escTime}"::DOUBLE`);
        const baseTime = meta.generatedTime ? '(ROW_NUMBER() OVER () - 1)::DOUBLE' : tExpr;
        const valueExprs = requested.map(({ variable, varName }) =>
            this._valueExpressionSql(variable, varName, { castDouble: true }));

        const sql = buildMissingBucketsSql(
            baseTime, meta.tableName, valueExprs, (v) => this._numericLiteral(v), lo, hi, nBuckets, !!meta.generatedTime);
        const result = await this._interactiveQuery(sql);
        const b = this._extractColumnAsFloat64(result, 0, 'DOUBLE');
        const nTotal = this._extractColumnAsFloat64(result, 1, 'DOUBLE');
        const nMissing = this._extractColumnAsFloat64(result, 2, 'DOUBLE');
        const n = Math.min(b.length, nTotal.length, nMissing.length);
        const buckets = new Array(n);
        for (let i = 0; i < n; i++) buckets[i] = { b: b[i], nTotal: nTotal[i], nMissing: nMissing[i] };
        return { buckets };
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
            .map(({ variable, varName }, index) => `${this._valueExpressionSql(variable, varName, { castDouble: true })} AS v${index}`)
            .join(',\n                       ');
        if (meta.generatedTime) {
            const generatedValueSelect = requested
                .map(({ variable, varName }, index) => `${this._valueExpressionSql(variable, varName, { castDouble: true })} AS v${index}`)
                .join(',\n                           ');
            const generatedValueNames = requested.map((_, index) => `v${index}`).join(', ');
            if (Number.isFinite(estimatedRows) && estimatedRows > 0 && estimatedRows <= rawLimit) {
                const sql = `
                    WITH numbered AS (
                        SELECT (ROW_NUMBER() OVER () - 1)::DOUBLE AS t,
                               ${generatedValueSelect}
                        FROM ${tableName}
                    )
                    SELECT t,
                           ${generatedValueNames}
                    FROM numbered
                    WHERE t BETWEEN ${lit(t0)} AND ${lit(t1)}
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
                        mode: 'raw-index',
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
            const maxBuckets = Math.max(1, Math.floor(maxPoints / 2));
            const aggregateSelect = this._minMaxBucketAggregateSql(requested);
            const sql = `
                WITH numbered AS (
                    SELECT (ROW_NUMBER() OVER () - 1)::DOUBLE AS t,
                           ${generatedValueSelect}
                    FROM ${tableName}
                ),
                visible AS (
                    SELECT t,
                           ${generatedValueNames}
                    FROM numbered
                    WHERE t BETWEEN ${lit(t0)} AND ${lit(t1)}
                ),
                bucketed AS (
                    SELECT t,
                           ${generatedValueNames},
                           CAST(LEAST(${maxBuckets - 1},
                                FLOOR((t - ${lit(t0)}) / NULLIF(${lit(t1)} - ${lit(t0)}, 0) * ${maxBuckets})) AS BIGINT) AS bucket
                    FROM visible
                )
                SELECT MIN(t) AS t_lo,
                       MAX(t) AS t_hi,
                       ${aggregateSelect}
                FROM bucketed
                GROUP BY bucket
                ORDER BY bucket;
            `;
            const result = await this._interactiveQuery(sql);
            const extractStartedAt = this._now();
            const { x, yByVar } = this._expandMinMaxBucketResult(result, requested);
            return {
                x,
                yByVar,
                _perf: this._rangePerf({
                    mode: 'bucket-index',
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
        const maxBuckets = Math.max(1, Math.floor(maxPoints / 2));
        const aggregateSelect = this._minMaxBucketAggregateSql(requested);
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
                       CAST(LEAST(${maxBuckets - 1},
                                  GREATEST(0,
                                           FLOOR((t - ${lit(t0)})
                                                 * ${maxBuckets} / ${lit(span)})))
                            AS BIGINT) AS bucket
                FROM visible
            )
            SELECT MIN(t) AS t_lo,
                   MAX(t) AS t_hi,
                   ${aggregateSelect}
            FROM bucketed
            GROUP BY bucket
            ORDER BY bucket;
        `;
        const result = await this._interactiveQuery(sql);
        const extractStartedAt = this._now();
        const { x, yByVar } = this._expandMinMaxBucketResult(result, requested);
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

    // Per-bucket MIN and MAX of every requested value column (v0..vN-1). Using
    // min/max instead of AVG keeps the amplitude envelope truthful at every zoom
    // level — AVG flattened the peaks so the Y axis appeared to shrink when
    // zooming out. Emits two value columns per variable: min{i}, max{i}.
    _minMaxBucketAggregateSql(requested) {
        return requested
            .map((_, index) => `MIN(v${index}) AS min${index}, MAX(v${index}) AS max${index}`)
            .join(',\n                   ');
    }

    // Expand a MIN(t)/MAX(t)/min_i/max_i bucket result into a plottable series:
    // two points per bucket — (t_lo, min…) then (t_hi, max…) — so each bucket
    // draws its true vertical extent (the same idea as the eager min/max
    // downsampler). Column layout: 0=t_lo, 1=t_hi, then min_i,max_i per variable.
    _expandMinMaxBucketResult(result, requested) {
        const tLo = this._extractColumnAsFloat64(result, 0, 'DOUBLE');
        const tHi = this._extractColumnAsFloat64(result, 1, 'DOUBLE');
        const nb = Math.min(tLo.length, tHi.length);
        const x = new Float64Array(nb * 2);
        for (let b = 0; b < nb; b++) { x[2 * b] = tLo[b]; x[2 * b + 1] = tHi[b]; }
        const yByVar = new Map();
        requested.forEach(({ varName }, index) => {
            const minCol = this._extractColumnAsFloat64(result, 2 + index * 2, 'DOUBLE');
            const maxCol = this._extractColumnAsFloat64(result, 3 + index * 2, 'DOUBLE');
            const y = new Float64Array(nb * 2);
            for (let b = 0; b < nb; b++) { y[2 * b] = minCol[b]; y[2 * b + 1] = maxCol[b]; }
            yByVar.set(varName, y);
        });
        return { x, yByVar };
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
        const vars = requested.map(({ varName, variable }) => `${varName}\u001d${this._dataToolCacheToken(variable)}`).join('\u001f');
        return [tableName, vars, this._roundedRangeKey(t0), this._roundedRangeKey(t1), Math.round(maxPoints)].join('\u001e');
    }

    _phaseCacheKey(meta, requested, sourceRange, maxPoints) {
        const tableName = meta?.tableName;
        if (!tableName) return null;
        const vars = requested.map(({ varName, variable }) => `${varName}\u001d${this._dataToolCacheToken(variable)}`).join('\u001f');
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
        if (this._correlationCache?.size) {
            for (const key of [...this._correlationCache.keys()]) {
                if (String(key).startsWith(tableName + '')) this._correlationCache.delete(key);
            }
        }
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
        if (this._temporalProfileCache?.size) {
            for (const key of [...this._temporalProfileCache.keys()]) {
                if (String(key).startsWith(`${tableName}\u001e`)) this._temporalProfileCache.delete(key);
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
        const timeCol = meta.timeColumn;
        const escTime = timeCol.replace(/"/g, '""');
        const tableName = meta.tableName;
        const valueExpr = this._valueExpressionSql(variable, varName, { castDouble: true });
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

        if (meta.generatedTime) {
            const sql = direction === 'prev'
                ? `
                    WITH numbered AS (
                        SELECT (ROW_NUMBER() OVER () - 1)::DOUBLE AS t,
                               ${valueExpr} AS v
                        FROM ${tableName}
                    )
                    SELECT * FROM (
                        SELECT t, v
                        FROM numbered
                        WHERE t < ${lit(fromX)}
                        ORDER BY t DESC
                        LIMIT ${dataRows}
                    )
                    UNION ALL
                    SELECT * FROM (
                        SELECT t, v
                        FROM numbered
                        WHERE t >= ${lit(fromX)}
                        ORDER BY t ASC
                        LIMIT ${contextRows}
                    )
                    ORDER BY t ASC;
                `
                : `
                    WITH numbered AS (
                        SELECT (ROW_NUMBER() OVER () - 1)::DOUBLE AS t,
                               ${valueExpr} AS v
                        FROM ${tableName}
                    )
                    SELECT * FROM (
                        SELECT t, v
                        FROM numbered
                        WHERE t <= ${lit(fromX)}
                        ORDER BY t DESC
                        LIMIT ${contextRows}
                    )
                    UNION ALL
                    SELECT * FROM (
                        SELECT t, v
                        FROM numbered
                        WHERE t > ${lit(fromX)}
                        ORDER BY t ASC
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

        const sql = direction === 'prev'
            ? `
                SELECT * FROM (
                    SELECT ${tExpr} AS t, ${valueExpr} AS v
                    FROM ${tableName}
                    WHERE ${tExpr} < ${lit(fromX)}
                    ORDER BY ${orderByT} DESC
                    LIMIT ${dataRows}
                )
                UNION ALL
                SELECT * FROM (
                    SELECT ${tExpr} AS t, ${valueExpr} AS v
                    FROM ${tableName}
                    WHERE ${tExpr} >= ${lit(fromX)}
                    ORDER BY ${orderByT} ASC
                    LIMIT ${contextRows}
                )
                ORDER BY t ASC;
            `
            : `
                SELECT * FROM (
                    SELECT ${tExpr} AS t, ${valueExpr} AS v
                    FROM ${tableName}
                    WHERE ${tExpr} <= ${lit(fromX)}
                    ORDER BY ${orderByT} DESC
                    LIMIT ${contextRows}
                )
                UNION ALL
                SELECT * FROM (
                    SELECT ${tExpr} AS t, ${valueExpr} AS v
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

    async countOutOfBounds(legacyData, varName, params = {}) {
        const meta = legacyData?._duckdb;
        if (!meta) throw new Error('countOutOfBounds: data is not DuckDB-backed (eager mode)');
        const variable = legacyData.variables?.[varName];
        if (!variable) throw new Error(`countOutOfBounds: unknown variable "${varName}"`);
        const base = `try_cast(${this._quoteIdent(variable._duckdbCol || varName)} AS DOUBLE)`;
        const predicate = this._boundsPredicateSql(base, params);
        if (!predicate) throw new Error('countOutOfBounds: missing finite bounds');
        const timeCol = meta.timeColumn;
        const escTime = timeCol.replace(/"/g, '""');
        const timeKind = legacyData?.metadata?.timeKind;
        const tExpr = meta.timeExprSql || (timeKind === 'datetime'
            ? `epoch_ms("${escTime}")::DOUBLE`
            : `"${escTime}"::DOUBLE`);
        const validTimeWhere = meta.generatedTime ? 'TRUE' : `${tExpr} IS NOT NULL`;
        const result = await this._interactiveQuery(`
            SELECT COUNT(*)::BIGINT AS n
            FROM ${meta.tableName}
            WHERE ${validTimeWhere}
              AND ${base} IS NOT NULL
              AND NOT (${predicate});
        `);
        return Number(result.getChild('n')?.get(0) ?? 0);
    }

    async refreshOverview(legacyData) {
        const meta = legacyData?._duckdb;
        if (!meta) return;
        const timeName = legacyData.metadata?.timeName;
        const timeVar = timeName ? legacyData.variables?.[timeName] : null;
        const varNames = Object.entries(legacyData.variables || {})
            .filter(([, variable]) => {
                if (!variable || variable.kind === 'abscissa' || variable.kind === 'parameter') return false;
                if (variable.dataType === 'string' || variable.dataType === 'boolean') return false;
                return !!(variable._duckdbCol || variable._duckdbDataTool);
            })
            .map(([name]) => name);
        if (!timeVar || !varNames.length) return;
        const currentTime = timeVar.data || [];
        const t0 = Number.isFinite(Number(legacyData.metadata?.timeStart))
            ? Number(legacyData.metadata.timeStart)
            : Number(currentTime[0]);
        const t1 = Number.isFinite(Number(legacyData.metadata?.timeEnd))
            ? Number(legacyData.metadata.timeEnd)
            : Number(currentTime[currentTime.length - 1]);
        if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return;
        const target = Math.max(2, Math.round(Number(meta.overviewPoints) || currentTime.length || 10000));
        this._clearRangeCacheForTable(meta.tableName);
        const result = await this.getColumnsRange(legacyData, varNames, t0, t1, target);
        timeVar.data = result.x;
        for (const name of varNames) {
            const values = result.yByVar?.get(name);
            if (values) legacyData.variables[name].data = values;
        }
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
        const readWhere = format === 'csv' ? this._csvRowFilterSql(csvProfile) : '';
        const sourceExpr = readWhere
            ? `(SELECT * FROM ${readExpr} WHERE ${readWhere})`
            : readExpr;
        let viewMode = false;

        if (format === 'csv' && csvProfile?.delimiter === 'whitespace') {
            throw new Error('DuckDB CSV path does not yet support variable-width whitespace delimiters.');
        }

        // Lazy mode: use VIEW from the start. CREATE TABLE materializes the
        // full CSV/Parquet into DuckDB's WASM heap first, which is exactly
        // what large-file mode is trying to avoid.
        if (lazy) {
            await this._conn.query(`CREATE OR REPLACE VIEW ${tableName} AS SELECT * FROM ${sourceExpr}`);
            viewMode = true;
        } else {
            try {
                await this._conn.query(`CREATE TABLE ${tableName} AS SELECT * FROM ${sourceExpr}`);
            } catch (err) {
                const msg = String(err?.message || err);
                const isOom = /malloc|out of memory|memory|allocation/i.test(msg);
                if (!lazy || !isOom) {
                    throw new Error(`DuckDB read failed: ${msg}`);
                }
                // Lazy + OOM (large file): fall back to a VIEW so we never
                // materialize the full dataset. Each query re-reads from the
                // file (with projection / predicate pushdown).
                await this._conn.query(`CREATE OR REPLACE VIEW ${tableName} AS SELECT * FROM ${sourceExpr}`);
                viewMode = true;
            }
        }

        const schemaResult = await this._conn.query(`DESCRIBE ${tableName}`);
        const schema = this._arrowRowsToObjects(schemaResult);
        const columnNames = schema.map(s => s.column_name);
        const columnTypes = schema.map(s => String(s.column_type || '').toUpperCase());
        const pandasPaths = format === 'parquet'
            ? await this._parquetPandasColumnPaths(escapedHandle)
            : new Map();

        const timeInfo = this._timeInfoFromProfile(columnNames, columnTypes, csvProfile)
            || this._timeInfoFromDuckDbSchema(columnNames, columnTypes);
        if (!timeInfo) {
            throw new Error('DuckDB: no suitable time column detected; falling back.');
        }

        const projection = this._projectionSql(columnNames, timeInfo, csvProfile);
        const timeAlias = '__omv_time';
        const escTimeAlias = timeAlias.replace(/"/g, '""');
        const validTimeWhere = timeInfo.generated ? 'TRUE' : `${timeInfo.sql} IS NOT NULL`;

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

        const legacy = this._buildLegacyFromArrow(
            dataResult,
            projectedNames,
            projectedTypes,
            0,
            totalRows,
            timeInfo,
            { format, pandasPaths },
        );

        if (viewMode) {
            // In view mode the overview is a small reservoir sample, so its
            // first/last values are not the file's true time range. Issue an
            // aggregate query — DuckDB can compute MIN/MAX without sorting.
            if (!timeInfo.generated) try {
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
                generatedTime: !!timeInfo.generated,
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
    /**
     * Exact calendar-heatmap aggregates for a lazy (DuckDB-backed) file. Never
     * uses the overview, reservoir or any viewport downsampling as a result.
     *
     * Buckets are computed with pure integer arithmetic on epoch-ms (the same
     * floored-modulo math as the JS kernel), so no date_part/timezone is
     * involved and eager/lazy parity holds by construction. All requested vars
     * share one table scan via conditional aggregates.
     *
     * Returns `{ ok, calendarMode, blocked, traces: [{ varName, cells }] }`
     * where each `cell` matches the kernel accumulator shape consumed by
     * densifyCalendarHeatmap: { columnStartMs, rowIndex, nScope, nFinite,
     * nInvalid, sum, mean, min, max }.
     */
    async getCalendarHeatmapAggregates(legacyData, varNames, options = {}) {
        const meta = legacyData?._duckdb;
        if (!meta) throw new Error('getCalendarHeatmapAggregates: data is not DuckDB-backed (eager mode)');
        const calendarMode = options.calendarMode === 'day-hour' ? 'day-hour' : 'week-day';
        if (legacyData?.metadata?.timeKind !== 'datetime') {
            return { ok: false, reason: 'notDatetime', calendarMode, blocked: [], traces: [] };
        }

        const requested = [...new Set(varNames || [])]
            .map(varName => ({ varName, variable: legacyData.variables?.[varName] }))
            .filter(item => item.variable);
        // Only vars backed by an exact SQL column/expression are allowed; a
        // purely overview-derived series has no truthful lazy aggregate.
        const usable = [];
        const blocked = [];
        for (const item of requested) {
            if (item.variable._duckdbCol || item.variable._duckdbDataTool) usable.push(item);
            else blocked.push(item.varName);
        }
        if (!usable.length) return { ok: true, calendarMode, blocked, traces: [] };

        const shiftMs = Math.trunc(Number(options.timeShiftMs) || 0);
        const cropRange = this._normalizeMsRange(options.cropRange);
        const selectionRange = this._normalizeMsRange(options.selectionRange);
        const transforms = options.transforms || {};
        // The integral needs a different pipeline (ordered pairs, gap detection,
        // boundary-split trapezoids); everything else is one GROUP BY.
        const integral = options.aggregation === 'integral';

        const cacheKey = this._calendarHeatmapCacheKey(meta, usable, {
            calendarMode, shiftMs, cropRange, selectionRange, transforms, integral,
        });
        const cached = cacheKey ? this._heatmapCache.get(cacheKey) : null;
        if (cached) return (cached instanceof Promise) ? cached : cached;

        const queryOpts = { calendarMode, shiftMs, cropRange, selectionRange, transforms, blocked };
        const promise = integral
            ? this._queryCalendarHeatmapIntegral(meta, legacyData, usable, queryOpts)
            : this._queryCalendarHeatmapAggregates(meta, legacyData, usable, queryOpts);
        if (cacheKey) {
            this._heatmapCache.set(cacheKey, promise);
            while (this._heatmapCache.size > 16) {
                const first = this._heatmapCache.keys().next().value;
                this._heatmapCache.delete(first);
            }
        }
        try {
            const result = await promise;
            if (cacheKey) this._heatmapCache.set(cacheKey, result);
            return result;
        } catch (err) {
            if (cacheKey) this._heatmapCache.delete(cacheKey);
            throw err;
        }
    }

    _normalizeMsRange(range) {
        if (!Array.isArray(range) || range.length < 2) return null;
        let [lo, hi] = range.map(Number);
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
        if (lo > hi) [lo, hi] = [hi, lo];
        return [lo, hi];
    }

    _calendarHeatmapCacheKey(meta, usable, opts) {
        const tableName = meta?.tableName;
        if (!tableName) return null;
        const vars = usable
            .map(({ varName, variable }) => {
                const t = opts.transforms[varName] || {};
                return [
                    varName,
                    this._dataToolCacheToken(variable),
                    Number(t.gain ?? 1),
                    Number(t.yOffset ?? 0),
                ].join('');
            })
            .join('');
        // meta.appendRows makes any live-appended data miss a stale entry.
        return [
            tableName,
            'calheat',
            Number(meta.appendRows) || 0,
            opts.calendarMode,
            opts.shiftMs,
            opts.cropRange ? opts.cropRange.join('_') : '',
            opts.selectionRange ? opts.selectionRange.join('_') : '',
            opts.integral ? 'integral' : 'agg',
            vars,
        ].join('');
    }

    async _queryCalendarHeatmapAggregates(meta, legacyData, usable, opts) {
        const { calendarMode, shiftMs, cropRange, selectionRange, transforms, blocked } = opts;
        const tableName = meta.tableName;
        // epoch-ms in display space (pre-shift); crop compares against this.
        const baseMsExpr = `CAST((${meta.timeExprSql}) AS HUGEINT)`;
        // Shifted epoch-ms drives bucketing and the selection filter.
        const tExpr = shiftMs ? `(${baseMsExpr} + ${shiftMs})` : baseMsExpr;

        const where = [`(${meta.timeExprSql}) IS NOT NULL`];
        if (cropRange) {
            where.push(`${baseMsExpr} BETWEEN ${this._numericLiteral(cropRange[0])} AND ${this._numericLiteral(cropRange[1])}`);
        }
        if (selectionRange) {
            where.push(`${tExpr} BETWEEN ${this._numericLiteral(selectionRange[0])} AND ${this._numericLiteral(selectionRange[1])}`);
        }

        const dayStart = `(t_ms - (((t_ms % 86400000) + 86400000) % 86400000))`;
        const colRowSql = calendarMode === 'day-hour'
            ? `${dayStart} AS col_start,
               ((t_ms - (((t_ms % 3600000) + 3600000) % 3600000)) - ${dayStart}) / 3600000 AS row_idx`
            : `(${dayStart} - (((((${dayStart}) / 86400000) + 3) % 7 + 7) % 7) * 86400000) AS col_start,
               (((((${dayStart}) / 86400000) + 3) % 7 + 7) % 7 + 1) AS row_idx`;

        const valueSelect = usable.map(({ variable, varName }, index) => {
            const t = transforms[varName] || {};
            const gain = Number(t.gain ?? 1);
            const yOffset = Number(t.yOffset ?? 0);
            let expr = this._valueExpressionSql(variable, varName, { castDouble: true });
            if (gain !== 1) expr = `(${expr}) * ${this._numericLiteral(gain)}`;
            if (yOffset !== 0) expr = `(${expr}) + ${this._numericLiteral(yOffset)}`;
            return `${expr} AS v${index}`;
        }).join(',\n                   ');

        const aggSelect = usable.map((_, index) => {
            const finite = `CASE WHEN v${index} IS NOT NULL AND isfinite(v${index}) THEN v${index} END`;
            return `COUNT(${finite})::BIGINT AS nf${index},
                   SUM(${finite})::DOUBLE AS s${index},
                   AVG(${finite})::DOUBLE AS a${index},
                   MIN(${finite})::DOUBLE AS mi${index},
                   MAX(${finite})::DOUBLE AS ma${index}`;
        }).join(',\n                   ');

        const sql = `
            WITH base AS (
                SELECT ${tExpr} AS t_ms,
                       ${valueSelect}
                FROM ${tableName}
                WHERE ${where.join(' AND ')}
            ),
            bucketed AS (
                SELECT ${colRowSql},
                       ${usable.map((_, i) => `v${i}`).join(', ')}
                FROM base
            )
            SELECT col_start::DOUBLE AS col_start,
                   row_idx::BIGINT AS row_idx,
                   COUNT(*)::BIGINT AS n_scope,
                   ${aggSelect}
            FROM bucketed
            GROUP BY col_start, row_idx`;

        const result = await this._interactiveQuery(sql);
        const rows = this._arrowRowsToObjects(result);
        const traces = usable.map(({ varName }, index) => {
            const cells = [];
            for (const row of rows) {
                const nScope = Number(row.n_scope) || 0;
                const nFinite = Number(row[`nf${index}`]) || 0;
                const sum = row[`s${index}`];
                const mean = row[`a${index}`];
                const min = row[`mi${index}`];
                const max = row[`ma${index}`];
                cells.push({
                    columnStartMs: Number(row.col_start),
                    bucketStartMs: Number(row.col_start),
                    rowIndex: Number(row.row_idx),
                    nScope,
                    nFinite,
                    nInvalid: Math.max(0, nScope - nFinite),
                    sum: nFinite === 0 || sum == null ? null : Number(sum),
                    mean: nFinite === 0 || mean == null ? null : Number(mean),
                    min: nFinite === 0 || min == null ? null : Number(min),
                    max: nFinite === 0 || max == null ? null : Number(max),
                });
            }
            return { varName, cells };
        });

        return { ok: true, calendarMode, blocked, traces };
    }

    // Exact trapezoidal integral per cell for lazy files. Runs one query per var
    // (integration needs the var's own ordered finite samples): pairs consecutive
    // finite samples, drops gaps longer than 1.5x the median step, and splits
    // every kept interval at the cell boundaries via unnest(range()) so the area
    // is attributed to each hour/day it crosses. Verified cell-for-cell against
    // the JS kernel (fine + coarse sampling, gaps, week-day, pre-1970).
    async _queryCalendarHeatmapIntegral(meta, legacyData, usable, opts) {
        const { calendarMode, shiftMs, cropRange, selectionRange, transforms, blocked } = opts;
        const tableName = meta.tableName;
        const cm = calendarMode === 'day-hour' ? 3600000 : 86400000;
        const baseMsExpr = `CAST((${meta.timeExprSql}) AS HUGEINT)`;
        const tExpr = shiftMs ? `(${baseMsExpr} + ${shiftMs})` : baseMsExpr;

        const where = [`(${meta.timeExprSql}) IS NOT NULL`];
        if (cropRange) {
            where.push(`${baseMsExpr} BETWEEN ${this._numericLiteral(cropRange[0])} AND ${this._numericLiteral(cropRange[1])}`);
        }
        if (selectionRange) {
            where.push(`${tExpr} BETWEEN ${this._numericLiteral(selectionRange[0])} AND ${this._numericLiteral(selectionRange[1])}`);
        }
        const whereSql = where.join(' AND ');

        const floorTo = (x, m) => `((${x}) - ((((${x}) % ${m}) + ${m}) % ${m}))`;
        const cellStartExpr = floorTo('t_ms', cm);
        const cellIdx = (x) => `CAST(${floorTo(x, cm)} / ${cm} AS BIGINT)`;
        // Derive (col_start, row_idx) from a cell_start already floored to cm.
        const colRowFromCellStart = calendarMode === 'day-hour'
            ? {
                col: `(cell_start - (((cell_start % 86400000) + 86400000) % 86400000))`,
                row: `((cell_start - (cell_start - (((cell_start % 86400000) + 86400000) % 86400000))) / 3600000)`,
            }
            : {
                col: `(cell_start - (((((cell_start / 86400000)) + 3) % 7 + 7) % 7) * 86400000)`,
                row: `((((cell_start / 86400000) + 3) % 7 + 7) % 7 + 1)`,
            };

        const traces = [];
        for (const { varName, variable } of usable) {
            const t = transforms[varName] || {};
            const gain = Number(t.gain ?? 1);
            const yOffset = Number(t.yOffset ?? 0);
            let vExpr = this._valueExpressionSql(variable, varName, { castDouble: true });
            if (gain !== 1) vExpr = `(${vExpr}) * ${this._numericLiteral(gain)}`;
            if (yOffset !== 0) vExpr = `(${vExpr}) + ${this._numericLiteral(yOffset)}`;

            const sql = `
                WITH src AS (
                    SELECT ${tExpr} AS t_ms, ${vExpr} AS v
                    FROM ${tableName}
                    WHERE ${whereSql}
                ),
                mono AS (
                    SELECT COALESCE(SUM(CASE WHEN prev_t IS NOT NULL AND t_ms < prev_t THEN 1 ELSE 0 END), 0) AS violations
                    FROM (SELECT t_ms, LAG(t_ms) OVER () AS prev_t FROM src)
                ),
                fin AS (SELECT t_ms, v FROM src WHERE v IS NOT NULL AND isfinite(v)),
                pairs AS (
                    SELECT LAG(t_ms) OVER (ORDER BY t_ms) AS a, LAG(v) OVER (ORDER BY t_ms) AS va, t_ms AS b, v AS vb FROM fin
                ),
                med AS (SELECT median(b - a) AS m FROM pairs WHERE a IS NOT NULL AND b > a),
                intervals AS (
                    SELECT a, va, b, vb, (b - a) AS dur, ${cellIdx('a')} AS a_idx, ${cellIdx('b')} AS b_idx,
                        CASE WHEN (SELECT m FROM med) IS NULL THEN 0
                             WHEN (b - a) > 1.5 * (SELECT m FROM med) THEN 1 ELSE 0 END AS is_gap
                    FROM pairs WHERE a IS NOT NULL AND b > a
                ),
                seg0 AS (
                    SELECT a, va, b, vb, dur, is_gap, unnest(range(a_idx, b_idx + 1)) AS cell_idx FROM intervals
                ),
                seg AS (
                    SELECT is_gap, (cell_idx * ${cm}) AS cell_start,
                        greatest(a, cell_idx * ${cm}) AS s, least(b, cell_idx * ${cm} + ${cm}) AS e,
                        a, va, b, vb, dur
                    FROM seg0
                ),
                seg2 AS (
                    SELECT cell_start, is_gap, (e - s) AS overlap,
                        (va + (vb - va) * ((s - a)::DOUBLE / dur)) AS vs,
                        (va + (vb - va) * ((e - a)::DOUBLE / dur)) AS ve
                    FROM seg WHERE e > s
                ),
                integ AS (
                    SELECT cell_start,
                        SUM(CASE WHEN is_gap = 0 THEN (vs + ve) / 2.0 * overlap ELSE 0 END) AS integral_ms,
                        SUM(CASE WHEN is_gap = 0 THEN overlap ELSE 0 END) AS covered_ms,
                        SUM(CASE WHEN is_gap = 1 THEN overlap ELSE 0 END) AS missing_ms,
                        MAX(is_gap) AS has_gap
                    FROM seg2 GROUP BY cell_start
                ),
                base AS (
                    SELECT ${cellStartExpr} AS cell_start,
                        COUNT(*)::BIGINT AS n_scope,
                        COUNT(CASE WHEN v IS NOT NULL AND isfinite(v) THEN 1 END)::BIGINT AS n_finite
                    FROM src GROUP BY cell_start
                ),
                joined AS (
                    SELECT COALESCE(base.cell_start, integ.cell_start) AS cell_start,
                        COALESCE(base.n_scope, 0) AS n_scope,
                        COALESCE(base.n_finite, 0) AS n_finite,
                        integ.integral_ms, integ.covered_ms, integ.missing_ms,
                        COALESCE(integ.has_gap, 0) AS has_gap
                    FROM base FULL OUTER JOIN integ ON base.cell_start = integ.cell_start
                )
                SELECT ${colRowFromCellStart.col}::DOUBLE AS col_start,
                    ${colRowFromCellStart.row}::BIGINT AS row_idx,
                    cell_start::DOUBLE AS cell_start,
                    n_scope::BIGINT AS n_scope,
                    n_finite::BIGINT AS n_finite,
                    integral_ms::DOUBLE AS integral_ms,
                    covered_ms::DOUBLE AS covered_ms,
                    missing_ms::DOUBLE AS missing_ms,
                    has_gap::BIGINT AS has_gap,
                    (SELECT violations FROM mono)::BIGINT AS violations,
                    (SELECT m FROM med)::DOUBLE AS median_step
                FROM joined`;

            const rows = this._arrowRowsToObjects(await this._interactiveQuery(sql));
            const violations = rows.length ? Number(rows[0].violations) : 0;
            const medianStep = rows.length ? rows[0].median_step : null;
            // Mirror the eager kernel: unsorted input or fewer than two finite
            // samples means no trustworthy integral.
            const integralAvailable = violations === 0 && medianStep != null;
            const cells = [];
            for (const row of rows) {
                const nScope = Number(row.n_scope) || 0;
                const nFinite = Number(row.n_finite) || 0;
                const hasGap = Number(row.has_gap) === 1;
                const coveredMs = row.covered_ms == null ? 0 : Number(row.covered_ms);
                const integralMs = row.integral_ms == null ? null : Number(row.integral_ms);
                cells.push({
                    columnStartMs: Number(row.col_start),
                    bucketStartMs: Number(row.col_start),
                    rowIndex: Number(row.row_idx),
                    nScope,
                    nFinite,
                    nInvalid: Math.max(0, nScope - nFinite),
                    integral: (integralAvailable && coveredMs > 0 && integralMs != null) ? integralMs / 3600000 : null,
                    coveredMs,
                    missingMs: row.missing_ms == null ? 0 : Number(row.missing_ms),
                    hasGap,
                });
            }
            traces.push({ varName, cells, integralAvailable });
        }

        return { ok: true, calendarMode, blocked, traces };
    }

    /**
     * Exact temporal-profile statistics for lazy files. Source rows are reduced
     * to calendar-period/bin aggregates in DuckDB; only O(periods × bins)
     * compact rows cross into JavaScript. Multiple variables share the scan.
     */
    async getTemporalProfileAggregates(legacyData, varNames, options = {}) {
        const meta = legacyData?._duckdb;
        if (!meta) throw new Error('getTemporalProfileAggregates: data is not DuckDB-backed (eager mode)');
        if (legacyData?.metadata?.timeKind !== 'datetime' || meta.generatedTime) {
            return { ok: false, reason: 'notDatetime', blocked: [], traces: [] };
        }
        const requested = [...new Set(varNames || [])]
            .map(varName => ({ varName, variable: legacyData.variables?.[varName] }))
            .filter(item => item.variable);
        const usable = [];
        const blocked = [];
        for (const item of requested) {
            if (item.variable._duckdbCol || item.variable._duckdbDataTool) usable.push(item);
            else blocked.push(item.varName);
        }
        if (!usable.length) return { ok: true, blocked, traces: [], medianStepMs: null };

        const period = ['day', 'week', 'month', 'year'].includes(options.period) ? options.period : 'day';
        const resolutionUnit = period === 'year' && options.resolutionUnit === 'month' ? 'month' : 'minute';
        const resolutionMinutes = resolutionUnit === 'month' ? null : Number(options.resolutionMinutes);
        const shiftMs = Math.trunc(Number(options.timeShiftMs) || 0);
        const rawCropRange = Array.isArray(options.cropRange) ? options.cropRange.map(Number) : null;
        let cropRange = rawCropRange?.length >= 2
            ? [Number.isFinite(rawCropRange[0]) ? rawCropRange[0] : null, Number.isFinite(rawCropRange[1]) ? rawCropRange[1] : null]
            : null;
        if (cropRange?.[0] != null && cropRange?.[1] != null && cropRange[0] > cropRange[1]) {
            cropRange = [cropRange[1], cropRange[0]];
        }
        const selectionRange = this._normalizeMsRange(options.selectionRange);
        const transforms = options.transforms || {};
        const baseMsExpr = `CAST((${meta.timeExprSql}) AS HUGEINT)`;
        const tExpr = shiftMs ? `(${baseMsExpr} + ${shiftMs})` : baseMsExpr;
        const where = [`(${meta.timeExprSql}) IS NOT NULL`];
        if (cropRange?.[0] != null) where.push(`${baseMsExpr} >= ${this._numericLiteral(cropRange[0])}`);
        if (cropRange?.[1] != null) where.push(`${baseMsExpr} <= ${this._numericLiteral(cropRange[1])}`);
        if (selectionRange) where.push(`${tExpr} BETWEEN ${this._numericLiteral(selectionRange[0])} AND ${this._numericLiteral(selectionRange[1])}`);
        const whereSql = where.join(' AND ');
        const valueExpressions = usable.map(({ variable, varName }) => {
            const transform = transforms[varName] || {};
            const gain = Number.isFinite(Number(transform.gain)) ? Number(transform.gain) : 1;
            const yOffset = Number.isFinite(Number(transform.yOffset)) ? Number(transform.yOffset) : 0;
            let expression = this._valueExpressionSql(variable, varName, { castDouble: true });
            if (gain !== 1) expression = `(${expression}) * ${this._numericLiteral(gain)}`;
            if (yOffset !== 0) expression = `(${expression}) + ${this._numericLiteral(yOffset)}`;
            return expression;
        });
        const cacheKey = this._temporalProfileCacheKey(meta, usable, {
            period, resolutionUnit, resolutionMinutes, shiftMs, cropRange, selectionRange,
            transforms, dayGrouping: options.dayGrouping, discardIncomplete: options.discardIncomplete,
        });
        const cached = cacheKey ? this._temporalProfileCache.get(cacheKey) : null;
        if (cached) return cached instanceof Promise ? cached : cached;

        const promise = (async () => {
            const statsArgs = { tableName: meta.tableName, timeExpression: tExpr, whereSql };
            let statsRows = this._arrowRowsToObjects(await this._interactiveQuery(buildTemporalProfileTimeStatsSql(statsArgs)));
            let stats = statsRows[0] || {};
            let ordered = Number(stats.order_violations) > 0;
            if (ordered) {
                statsRows = this._arrowRowsToObjects(await this._interactiveQuery(buildTemporalProfileTimeStatsSql({ ...statsArgs, ordered: true })));
                stats = statsRows[0] || {};
            }
            const medianStepMs = stats.median_step == null ? null : Number(stats.median_step);
            const scopeStart = selectionRange?.[0] ?? (stats.min_t == null ? null : Number(stats.min_t));
            const scopeEnd = selectionRange?.[1] ?? (stats.max_t == null ? null : Number(stats.max_t));
            const boundaryToleranceMs = Number.isFinite(medianStepMs) ? medianStepMs * 1.5 : 0;
            const aggregate = buildTemporalProfileFinalSql({
                tableName: meta.tableName,
                timeExpression: tExpr,
                whereSql,
                valueExpressions,
                period,
                resolutionUnit,
                resolutionMinutes,
                gapThresholdMs: Number.isFinite(medianStepMs) ? medianStepMs * 1.5 : null,
                boundaryToleranceMs,
                scopeStart,
                scopeEnd,
                selectionActive: !!selectionRange,
                dayGrouping: options.dayGrouping,
                discardIncomplete: options.discardIncomplete,
                numericLiteral: value => this._numericLiteral(value),
                ordered,
            });
            if (!aggregate.ok) return { ...aggregate, blocked, traces: [] };
            const rows = this._arrowRowsToObjects(await this._interactiveQuery(aggregate.sql));
            const reduced = temporalProfilesFromFinalRows(rows, {
                period,
                resolutionUnit,
                resolutionMinutes,
                dayGrouping: options.dayGrouping,
                discardIncomplete: options.discardIncomplete,
                valueCount: usable.length,
                medianStepMs,
                nScope: Number(stats.n_scope) || 0,
            });
            if (!reduced.ok) return { ...reduced, blocked, traces: [] };
            return {
                ok: true,
                blocked,
                medianStepMs,
                orderedInput: !ordered,
                traces: usable.map((item, index) => ({ varName: item.varName, result: reduced.results[index] })),
            };
        })();
        if (cacheKey) {
            this._temporalProfileCache.set(cacheKey, promise);
            while (this._temporalProfileCache.size > 12) {
                const first = this._temporalProfileCache.keys().next().value;
                this._temporalProfileCache.delete(first);
            }
        }
        try {
            const result = await promise;
            if (cacheKey) this._temporalProfileCache.set(cacheKey, result);
            return result;
        } catch (error) {
            if (cacheKey) this._temporalProfileCache.delete(cacheKey);
            throw error;
        }
    }

    _temporalProfileCacheKey(meta, usable, options) {
        if (!meta?.tableName) return null;
        const variables = usable.map(({ varName, variable }) => {
            const transform = options.transforms?.[varName] || {};
            return [varName, this._dataToolCacheToken(variable), Number(transform.gain ?? 1), Number(transform.yOffset ?? 0)].join('\u001d');
        }).join('\u001f');
        return [
            meta.tableName,
            'profile',
            Number(meta.appendRows) || 0,
            Number(meta.appendBytes) || 0,
            options.period,
            options.resolutionUnit,
            options.resolutionMinutes ?? '',
            options.shiftMs,
            options.cropRange?.join('_') || '',
            options.selectionRange?.join('_') || '',
            options.dayGrouping || '',
            options.discardIncomplete ? 1 : 0,
            variables,
        ].join('\u001e');
    }

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

    // ── Pearson correlation for variable pairs (lazy exact, TODO 9 phase 3) ──
    // One aggregate query per file computes corr/count/avg/stddev over the
    // source range for every pair, converting non-finite values to NULL and
    // applying pairwise deletion — exact parity with the eager kernel. Never
    // reads raw rows; returns O(pairs). All pairs are from `legacyData`.
    async getPairCorrelations(legacyData, pairs, options = {}) {
        const meta = legacyData?._duckdb;
        if (!meta) throw new Error('getPairCorrelations: data is not DuckDB-backed (eager mode)');
        const list = Array.isArray(pairs) ? pairs : [];
        const resolved = list.map(p => {
            const vx = legacyData.variables?.[p?.x];
            const vy = legacyData.variables?.[p?.y];
            return { pair: p, vx, vy, ok: !!(vx && vy) };
        });
        const active = resolved.filter(r => r.ok);
        if (!active.length) return resolved.map(() => ({ status: 'noSql' }));

        if (!(await this._supportsCorr())) {
            return resolved.map(r => ({ status: r.ok ? 'noCorr' : 'noSql' }));
        }

        const gain = Number.isFinite(Number(options.gain)) ? Number(options.gain) : 1;
        const yOffset = Number.isFinite(Number(options.yOffset)) ? Number(options.yOffset) : 0;
        const sourceRange = Array.isArray(options.sourceTimeRange) ? options.sourceTimeRange : null;

        const cacheKey = this._pairCorrelationCacheKey(meta, active, sourceRange, gain, yOffset);
        const cached = cacheKey ? this._correlationCache.get(cacheKey) : null;
        if (cached) {
            const activeResults = cached instanceof Promise ? await cached : cached;
            return this._reindexPairResults(resolved, activeResults);
        }

        const timeCol = meta.timeColumn;
        const escTime = String(timeCol).replace(/"/g, '""');
        const timeKind = legacyData?.metadata?.timeKind;
        const tExpr = meta.timeExprSql || (timeKind === 'datetime'
            ? `epoch_ms("${escTime}")::DOUBLE`
            : `"${escTime}"::DOUBLE`);
        const where = this._phaseWhereSql(tExpr, sourceRange);
        const gLit = this._numericLiteral(gain);
        const oLit = this._numericLiteral(yOffset);
        // gain/yOffset go into SQL so a negative gain flips r's sign exactly as
        // it does on screen; positive gain/offset leave r unchanged.
        const valueExpr = (variable, name) => `(${this._valueExpressionSql(variable, name, { castDouble: true })} * ${gLit} + ${oLit})`;
        const pairExprs = active.map((r, i) => ({ i, vx: valueExpr(r.vx, r.pair.x), vy: valueExpr(r.vy, r.pair.y) }));
        const sql = buildPairCorrelationSql(tExpr, meta.tableName, where, pairExprs);

        const promise = (async () => {
            const result = await this._interactiveQuery(sql);
            return parsePairCorrelations(
                (name) => { const v = result?.getChild?.(name)?.get(0); return v == null ? NaN : Number(v); },
                active.length,
            );
        })();
        if (cacheKey) this._rememberCorrelationCache(cacheKey, promise);
        try {
            const activeResults = await promise;
            if (cacheKey) this._correlationCache.set(cacheKey, activeResults);
            return this._reindexPairResults(resolved, activeResults);
        } catch (err) {
            if (cacheKey) this._correlationCache.delete(cacheKey);
            throw err;
        }
    }


    _reindexPairResults(resolved, activeResults) {
        let k = 0;
        return resolved.map(r => (r.ok ? (activeResults[k++] ?? { status: 'undefined' }) : { status: 'noSql' }));
    }

    _pairCorrelationCacheKey(meta, active, sourceRange, gain, yOffset) {
        const tableName = meta?.tableName;
        if (!tableName) return null;
        const pairsKey = active.map(r => (
            `${r.pair.x}${this._dataToolCacheToken(r.vx)}${r.pair.y}${this._dataToolCacheToken(r.vy)}`
        )).join('');
        const rangeKey = Array.isArray(sourceRange) && sourceRange.length >= 2
            ? `${this._roundedRangeKey(Number(sourceRange[0]))}${this._roundedRangeKey(Number(sourceRange[1]))}`
            : 'full';
        const version = [Number(meta.appendRows) || 0, Number(meta.appendBytes) || 0, Number(meta.totalRows) || ''].join('');
        return [tableName, 'corr', pairsKey, rangeKey, gain, yOffset, version].join('');
    }

    _rememberCorrelationCache(key, value) {
        this._correlationCache.set(key, value);
        while (this._correlationCache.size > 12) {
            const first = this._correlationCache.keys().next().value;
            this._correlationCache.delete(first);
        }
    }

    async _supportsCorr() {
        if (this._corrCapable !== null) return this._corrCapable;
        try {
            await this._interactiveQuery('SELECT corr(1.0, 2.0) AS c;');
            this._corrCapable = true;
        } catch (_) {
            this._corrCapable = false;
        }
        return this._corrCapable;
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
                .map(({ variable, varName }, index) => `${this._valueExpressionSql(variable, varName, { castDouble: true })} AS v${index}`)
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
            .map(({ name, type, readType }) => `${this._quoteIdent(name)} ${readType || type || 'VARCHAR'}`)
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

    async _currentDuckDbRowCount(meta) {
        const cached = Number(meta?.totalRows);
        if (Number.isFinite(cached) && cached >= 0) return Math.floor(cached);
        const tableName = meta?.tableName;
        if (!tableName) return 0;
        const result = await this._conn.query(`SELECT COUNT(*)::BIGINT AS n FROM ${tableName}`);
        const count = Number(result.getChild('n')?.get(0) ?? 0);
        return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
    }

    _generatedIndexProjectionSql(columnNames, offset = 0, csvProfile = null) {
        const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
        return this._projectionSql(columnNames, {
            sourceNames: [],
            sql: `(${safeOffset} + ROW_NUMBER() OVER () - 1)::DOUBLE`,
        }, csvProfile);
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

    _csvRowFilterSql(csvProfile = null) {
        const filter = csvProfile?.rowFilter;
        if (!filter?.enabled) return '';
        const columnIndex = Number(filter.columnIndex);
        if (!Number.isInteger(columnIndex) || columnIndex < 0) return '';
        const column = this._csvColumnSpecs(csvProfile)[columnIndex]?.name;
        if (!column) return '';
        if (filter.operator === 'is_numeric') return `${this._numericCastSql(this._quoteIdent(column), csvProfile)} IS NOT NULL`;
        const operator = filter.operator === '!=' ? '<>' : '=';
        return `trim(CAST(${this._quoteIdent(column)} AS VARCHAR)) ${operator} '${this._escapeSqlString(String(filter.value ?? '').trim())}'`;
    }

    _andSql(parts = []) {
        return parts
            .map(part => String(part || '').trim())
            .filter(Boolean)
            .join(' AND ') || 'TRUE';
    }

    _csvColumnSpecs(csvProfile) {
        const rawHeaders = csvProfile?.rawHeaders || [];
        const headers = csvProfile?.headers || [];
        const sampleRows = csvProfile?.sampleRows || [];
        const timeSource = csvProfile?.timeSource || {};
        const timeIndexes = new Set(timeSource.sourceIndexes || []);
        const numericIndexes = Array.isArray(csvProfile?.numericColumnIndexes)
            ? new Set(csvProfile.numericColumnIndexes.map(index => Number(index)).filter(index => Number.isInteger(index) && index >= 0))
            : null;
        return rawHeaders.map((raw, index) => {
            const header = headers[index] || {};
            const name = header.name || String(raw || `column_${index + 1}`);
            const forceVarchar = timeIndexes.has(index)
                && timeSource.kind === 'datetime'
                && !['excel-serial', 'matlab-datenum', 'decimal-year'].includes(timeSource.strategy);
            const inferred = forceVarchar
                ? { type: 'VARCHAR', readType: 'VARCHAR' }
                : numericIndexes
                    ? (numericIndexes.has(index) ? { type: 'DOUBLE', readType: 'VARCHAR' } : { type: 'VARCHAR', readType: 'VARCHAR' })
                : this._inferDuckDbCsvType(
                    this._sampleRowsWithValidTime(sampleRows, csvProfile),
                    index,
                    csvProfile.delimiter,
                    csvProfile.decimalSeparator,
                );
            return {
                name,
                ...inferred,
            };
        });
    }

    _sampleRowsWithValidTime(sampleRows, csvProfile) {
        const timeSource = csvProfile?.timeSource;
        if (!timeSource?.ok || timeSource.strategy === 'generated-index') return sampleRows || [];
        const delimiter = csvProfile?.delimiter || ',';
        const decimalSeparator = csvProfile?.decimalSeparator || 'auto';
        return (sampleRows || []).filter((row, index) =>
            Number.isFinite(parseCsvTimeValue(timeSource, row, index, delimiter, { decimalSeparator }))
        );
    }

    _inferDuckDbCsvType(sampleRows, index, delimiter, decimalSeparator = 'auto') {
        let nonEmpty = 0;
        let numeric = 0;
        for (const row of sampleRows || []) {
            const raw = String(row?.[index] ?? '').trim();
            if (!raw) continue;
            nonEmpty++;
            if (Number.isFinite(parseCsvNumber(raw, delimiter, decimalSeparator))) numeric++;
        }
        if (nonEmpty > 0 && (numeric / nonEmpty) > 0.5) {
            return { type: 'DOUBLE', readType: 'VARCHAR' };
        }
        return { type: 'VARCHAR', readType: 'VARCHAR' };
    }

    _duckDbColumnsStruct(specs) {
        const fields = specs.map(({ name, type, readType }) =>
            `'${this._escapeSqlString(name)}': '${this._escapeSqlString(readType || type || 'VARCHAR')}'`
        );
        return `{${fields.join(', ')}}`;
    }

    _csvUsesDecimalComma(csvProfile) {
        if (csvProfile?.decimalSeparator === ',') return true;
        if (csvProfile?.decimalSeparator === '.') return false;
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
        if (timeSource.strategy === 'generated-index') {
            return {
                name: timeSource.name || 'index',
                description: timeSource.description || '[index]',
                timeKind: 'index',
                strategy: timeSource.strategy || 'generated-index',
                sourceNames: [],
                sql: '(ROW_NUMBER() OVER () - 1)::DOUBLE',
                generated: true,
            };
        }

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

        if (timeSource.strategy === 'index-column') {
            sql = this._numericCastSql(first, csvProfile);
        } else if (timeSource.kind === 'numeric') {
            sql = this._numericCastSql(first, csvProfile);
        } else if (timeSource.kind === 'datetime') {
            sql = this._datetimeSqlFromProfile(timeSource, sourceNames, firstType, csvProfile);
        }

        if (!sql) return null;
        return {
            name,
            description,
            timeKind: timeSource.strategy === 'index-column' ? 'index' : timeSource.kind,
            strategy: timeSource.strategy || timeSource.mode || null,
            sourceNames,
            sql,
        };
    }

    _datetimeSqlFromProfile(timeSource, sourceNames, firstType, csvProfile = null) {
        const first = this._quoteIdent(sourceNames[0]);
        if (/TIMESTAMP|DATE|TIME/.test(firstType || '')) return `epoch_ms(${first})::DOUBLE`;

        const strategy = timeSource.strategy;
        const numericFirst = this._numericCastSql(first, csvProfile);
        if (strategy === 'excel-serial') return `((${numericFirst} - 25569) * ${MS_PER_DAY})`;
        if (strategy === 'matlab-datenum') return `((${numericFirst} - 719529) * ${MS_PER_DAY})`;
        if (strategy === 'decimal-year') return this._decimalYearSql(numericFirst);
        if (strategy === 'yearless-date-time') return this._yearlessDateTimeSql(first, timeSource.format);
        if (strategy === 'month-name-date') return this._monthNameDateSql(first);
        if (strategy === 'partial-year-month') return this._partialYearMonthSql(first);

        if (strategy === 'iso-datetime') {
            return `epoch_ms(CAST(${first} AS TIMESTAMP))::DOUBLE`;
        }

        if (strategy === 'custom-format') {
            return this._customFormatSql(first, timeSource.format?.pattern || '');
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
            const partialYearMonth = `CAST(${dateCol} AS VARCHAR) || '-01 ' || CAST(${timeCol} AS VARCHAR)`;
            const partialMonthDay = `'2001-' || CAST(${dateCol} AS VARCHAR) || ' ' || CAST(${timeCol} AS VARCHAR)`;
            const timestamps = [
                this._tryStrptimeTimestampSql(expr, formats),
                this._tryStrptimeTimestampSql(partialYearMonth, this._partialYearMonthDateTimeFormats()),
                this._tryStrptimeTimestampSql(partialMonthDay, this._partialMonthDayDateTimeFormats(order)),
            ];
            return `epoch_ms(coalesce(${timestamps.join(', ')}))::DOUBLE`;
        }

        if (timeSource.mode === 'parts' || strategy === 'parts') {
            return this._partsDateTimeSql(timeSource, sourceNames);
        }

        return null;
    }

    _partsDateTimeSql(timeSource, sourceNames) {
        const sourceIndexes = timeSource.sourceIndexes || [];
        const parts = timeSource.format?.parts || {};
        const partExpr = (name, fallback = '0') => {
            const profileIndex = parts[name];
            const sourceOffset = sourceIndexes.indexOf(profileIndex);
            if (sourceOffset < 0 || !sourceNames[sourceOffset]) return fallback;
            return `try_cast(${this._quoteIdent(sourceNames[sourceOffset])} AS DOUBLE)`;
        };
        const year = partExpr('year', '2001');
        const month = partExpr('month', '1');
        const day = partExpr('day', '1');
        const hour = partExpr('hour', '0');
        const minute = partExpr('minute', '0');
        const second = partExpr('second', '0');
        const secondInt = `FLOOR(${second})`;
        const microsecond = `ROUND((${second} - FLOOR(${second})) * 1000000)`;
        const expr = `make_timestamp(CAST(${year} AS BIGINT), CAST(${month} AS BIGINT), CAST(${day} AS BIGINT), CAST(${hour} AS BIGINT), CAST(${minute} AS BIGINT), CAST(${secondInt} AS BIGINT)) + CAST(${microsecond} AS BIGINT) * INTERVAL 1 MICROSECOND`;
        return `epoch_ms(${expr})::DOUBLE`;
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

    _partialYearMonthDateTimeFormats() {
        return [
            '%Y-%m-%d %H:%M:%S.%f',
            '%Y-%m-%d %H:%M:%S',
            '%Y-%m-%d %H:%M',
            '%Y/%m-%d %H:%M:%S.%f',
            '%Y/%m-%d %H:%M:%S',
            '%Y/%m-%d %H:%M',
        ];
    }

    _partialMonthDayDateTimeFormats(order) {
        const dash = order === 'DMY' ? '%Y-%d-%m' : '%Y-%m-%d';
        const slash = order === 'DMY' ? '%Y-%d/%m' : '%Y-%m/%d';
        return [
            `${dash} %H:%M:%S.%f`,
            `${dash} %H:%M:%S`,
            `${dash} %H:%M`,
            `${slash} %H:%M:%S.%f`,
            `${slash} %H:%M:%S`,
            `${slash} %H:%M`,
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

    _partialYearMonthSql(expr) {
        return this._tryStrptimeSql(`CAST(${expr} AS VARCHAR) || '-01'`, ['%Y-%m-%d', '%Y/%m-%d']);
    }

    _customFormatSql(expr, pattern) {
        const info = customDatetimePatternInfo(pattern);
        if (!info?.format) return null;
        let valueExpr = `CAST(${expr} AS VARCHAR)`;
        if (info.valuePrefix) valueExpr = `'${this._escapeSqlString(info.valuePrefix)}' || ${valueExpr}`;
        if (info.valueSuffix) valueExpr = `${valueExpr} || '${this._escapeSqlString(info.valueSuffix)}'`;
        if (info.hasMonthName) valueExpr = this._normalizedMonthNameSql(valueExpr);
        return this._tryStrptimeSql(valueExpr, [info.format]);
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
        replacements.push(
            ['gennaio', 'jan'], ['janeiro', 'jan'], ['ene', 'jan'], ['gen', 'jan'],
            ['febbraio', 'feb'], ['fevereiro', 'feb'],
            ['marco', 'mar'], ['marz', 'mar'],
            ['aprile', 'apr'], ['abr', 'apr'],
            ['maggio', 'may'], ['maio', 'may'], ['mag', 'may'],
            ['giugno', 'jun'], ['junho', 'jun'], ['juni', 'jun'], ['giu', 'jun'],
            ['luglio', 'jul'], ['julho', 'jul'], ['juli', 'jul'], ['lug', 'jul'],
            ['ago', 'aug'],
            ['settembre', 'sep'], ['setembro', 'sep'], ['set', 'sep'],
            ['ottobre', 'oct'], ['outubro', 'oct'], ['oktober', 'oct'], ['ott', 'oct'], ['okt', 'oct'],
            ['novembro', 'nov'],
            ['dicembre', 'dec'], ['dezembro', 'dec'], ['dezember', 'dec'], ['dic', 'dec'], ['dez', 'dec'],
        );
        for (const [from, to] of replacements) {
            sql = `replace(${sql}, '${this._escapeSqlString(from)}', '${to}')`;
        }
        return sql;
    }

    _tryStrptimeSql(expr, formats) {
        return `epoch_ms(${this._tryStrptimeTimestampSql(expr, formats)})::DOUBLE`;
    }

    _tryStrptimeTimestampSql(expr, formats) {
        const list = formats.map(format => `'${this._escapeSqlString(format)}'`).join(', ');
        return `try_strptime(${expr}, [${list}])`;
    }

    _projectionSql(columnNames, timeInfo, csvProfile = null) {
        const specsByName = new Map((this._csvColumnSpecs(csvProfile) || []).map(spec => [spec.name, spec]));
        const exclude = new Set(timeInfo.sourceNames || []);
        for (const index of csvProfile?.ignoredColumns || []) {
            const name = columnNames[Number(index)];
            if (name != null) exclude.add(name);
        }
        const columns = columnNames
            .filter(name => !exclude.has(name))
            .map(name => this._projectionColumnSql(name, specsByName.get(name), csvProfile));
        return [
            `${timeInfo.sql} AS "__omv_time"`,
            ...columns,
        ].join(', ');
    }

    _projectionColumnSql(name, spec = null, csvProfile = null) {
        const ident = this._quoteIdent(name);
        if (spec?.type === 'DOUBLE' && spec?.readType === 'VARCHAR') {
            return `${this._numericCastSql(ident, csvProfile)} AS ${ident}`;
        }
        return ident;
    }

    _numericCastSql(expr, csvProfile = null) {
        const value = this._csvUsesDecimalComma(csvProfile)
            ? `replace(CAST(${expr} AS VARCHAR), ',', '.')`
            : expr;
        return `try_cast(${value} AS DOUBLE)`;
    }

    _quoteIdent(name) {
        return `"${String(name ?? '').replace(/"/g, '""')}"`;
    }

    _valueExpressionSql(variable, fallbackName = '', options = {}) {
        const base = this._quoteIdent(variable?._duckdbCol || fallbackName || variable?.name);
        const definition = variable?._duckdbDataTool;
        let expr = base;
        if (definition?.tool === 'removeOutliers' && definition.method === 'bounds') {
            const numericBase = `try_cast(${base} AS DOUBLE)`;
            const predicate = this._boundsPredicateSql(numericBase, definition.params || {});
            if (predicate) {
                expr = `CASE WHEN ${numericBase} IS NULL THEN NULL WHEN ${predicate} THEN ${numericBase} ELSE NULL END`;
            }
        }
        return options.castDouble ? `try_cast((${expr}) AS DOUBLE)` : expr;
    }

    _boundsPredicateSql(baseExpression, params = {}) {
        const clauses = [];
        const lower = Number(params.lower);
        const upper = Number(params.upper);
        if (Number.isFinite(lower)) clauses.push(`${baseExpression} >= ${this._numericLiteral(lower)}`);
        if (Number.isFinite(upper)) clauses.push(`${baseExpression} <= ${this._numericLiteral(upper)}`);
        if (clauses.length >= 2 && lower > upper) return 'FALSE';
        return clauses.join(' AND ');
    }

    _dataToolCacheToken(variable) {
        const definition = variable?._duckdbDataTool;
        if (!definition) return '';
        return JSON.stringify({
            tool: definition.tool || '',
            method: definition.method || '',
            params: definition.params || {},
            replacement: definition.replacement || '',
        });
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

    _buildLegacyFromArrow(table, columnNames, columnTypes, timeColIndex, totalRows, timeInfo = null, sourceInfo = {}) {
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
        const variablePaths = new Map();
        const sanitize = (raw) => {
            const base = String(raw ?? '').trim() || `column`;
            return base;
        };

        const timeVar = {
            name: this._uniqueName(sanitize(timeName), usedNames),
            data: timeData,
            description: timeInfo?.description || (timeKind === 'datetime' ? '[datetime]' : ''),
            kind: 'abscissa',
            timeSourceStrategy: timeInfo?.strategy || null,
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
        } else if (timeKind === 'index') {
            timeVar.timeKind = 'index';
            timeVar.timeDisplayMode = 'index';
            timeVar.timeStepMode = 'index';
        }
        result.variables[timeVar.name] = timeVar;
        usedNames.add(timeVar.name);

        let numTimevarying = 0;
        for (let i = 0; i < columnNames.length; i++) {
            if (i === timeColIndex) continue;
            const colName = sanitize(columnNames[i]);
            const columnPath = sourceInfo.pandasPaths?.get(columnNames[i]) || null;
            const colType = columnTypes[i];
            const isNumeric = /INT|BIGINT|DOUBLE|REAL|FLOAT|DECIMAL|NUMERIC/.test(colType);
            const data = isNumeric
                ? this._extractColumnAsFloat64(table, i, colType)
                : this._extractColumnAsStrings(table, i);
            const uniqueName = this._uniqueName(columnPath?.join('.') || colName, usedNames);
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
                source: sourceInfo.format === 'parquet' ? 'parquet' : 'csv',
                _duckdbCol: columnNames[i],
            };
            if (columnPath) {
                result.variables[uniqueName].displayName = columnPath.join('.');
                result.variables[uniqueName].pandas = { columnPath: columnPath.slice() };
                variablePaths.set(uniqueName, columnPath);
            }
            numTimevarying++;
        }

        result.metadata = {
            numVariables: Object.keys(result.variables).length,
            numParams: 0,
            numTimevarying,
            numTimesteps: timeData.length,
            timeStart: timeData.length ? timeData[0] : 0,
            timeEnd: timeData.length ? timeData[timeData.length - 1] : 0,
            csv: sourceInfo.format !== 'parquet',
            format: sourceInfo.format || 'csv',
            delimiter: 'auto',
            hasHeader: true,
            skippedRows: 0,
            skippedRowsAfterHeader: 0,
            timeName: timeVar.name,
            timeKind,
            timeDisplayMode: timeKind === 'datetime' ? (datetimeAxisStalled ? 'index' : 'calendar')
                : timeKind === 'index' ? 'index' : 'numeric',
            timeOriginMs: timeVar.timeOriginMs ?? null,
            timeSourceColumns: timeInfo?.sourceNames?.length ? timeInfo.sourceNames : [timeName],
            datetimeAxisStalled,
            backend: 'duckdb',
        };

        if (variablePaths.size) {
            result.tree = this._buildColumnPathTree(result.variables, variablePaths);
            result.metadata.pandasMultiIndex = true;
            result.metadata.pandasColumnLevels = Math.max(...[...variablePaths.values()].map(path => path.length));
        } else if (this.structureParser?._buildTree) {
            result.tree = this.structureParser._buildTree(result.variables);
        } else {
            result.tree = this._flatTree(result.variables);
        }
        return result;
    }

    _buildColumnPathTree(variables, variablePaths) {
        const root = { _type: 'root', _name: '', _children: {}, _variables: {} };
        for (const [name, variable] of Object.entries(variables)) {
            const path = variablePaths.get(name);
            if (!path?.length) {
                root._variables[name] = variable;
                continue;
            }
            let node = root;
            for (const part of path.slice(0, -1)) {
                if (!node._children[part]) {
                    node._children[part] = {
                        _type: 'component',
                        _name: part,
                        _fullName: '',
                        _children: {},
                        _variables: {},
                    };
                }
                node = node._children[part];
            }
            let leaf = path[path.length - 1] || name;
            let suffix = 2;
            while (node._variables[leaf]) leaf = `${path[path.length - 1]} #${suffix++}`;
            node._variables[leaf] = variable;
        }
        return root;
    }

    async _parquetPandasColumnPaths(escapedHandle) {
        try {
            const table = await this._conn.query(`
                SELECT value
                FROM parquet_kv_metadata('${escapedHandle}')
                WHERE CAST(key AS VARCHAR) = 'pandas'
                LIMIT 1
            `);
            const raw = table.getChild('value')?.get(0);
            if (raw == null) return new Map();
            const json = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
            return pandasColumnPaths(JSON.parse(json));
        } catch (_) {
            return new Map();
        }
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
