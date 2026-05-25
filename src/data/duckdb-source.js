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
 * Files are registered with `BROWSER_FILEREADER` protocol so the underlying
 * `File` object is read lazily by DuckDB (no full-buffer string materialization,
 * which is what gives the legacy parser its ~512 MB hard ceiling).
 *
 * Falls back to `CsvParser` for files DuckDB cannot detect.
 */

import * as duckdb from '@duckdb/duckdb-wasm';
import mvpWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import ehWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { parseCsvNumber } from '../parsers/csv-time-detection.js';

const BUNDLES = {
    mvp: { mainModule: mvpWasmUrl, mainWorker: mvpWorkerUrl },
    eh:  { mainModule: ehWasmUrl,  mainWorker: ehWorkerUrl  },
};

const TIME_HEADER_RE = /^(time|temps|t|datetime|timestamp|horodatage|date|fecha|hora|heure)$/i;
const MS_PER_DAY = 86400000;

export default class DuckDbSource {
    constructor(structureParser = null) {
        this.structureParser = structureParser || null;
        this._db = null;
        this._conn = null;
        this._initPromise = null;
        this._registered = new Set();
        this._nextTableId = 0;
        this._rangeCache = new Map();
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
        this._db = db;
        this._conn = await db.connect();
        // Tune for the WASM context: less parallelism means smaller per-thread
        // chunk buffers, and allowing out-of-order operators frees DuckDB from
        // retaining whole pipelines in memory. Crucial for files near the
        // ~3 GB wasm heap ceiling.
        try {
            await this._conn.query(`PRAGMA threads=2`);
            await this._conn.query(`PRAGMA preserve_insertion_order=false`);
        } catch (_) { /* tuning is best-effort */ }
    }

    async registerFile(name, file) {
        await this.init();
        if (this._registered.has(name)) {
            try { await this._db.dropFile(name); } catch (_) { /* ignore */ }
            this._registered.delete(name);
        }
        await this._db.registerFileHandle(
            name,
            file,
            duckdb.DuckDBDataProtocol.BROWSER_FILEREADER,
            true,
        );
        this._registered.add(name);
    }

    async unregisterFile(name) {
        if (!this._registered.has(name)) return;
        try { await this._db.dropFile(name); } catch (_) { /* ignore */ }
        this._registered.delete(name);
    }

    async query(sql) {
        await this.init();
        return this._conn.query(sql);
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
        try { await this._conn.query(`DROP TABLE IF EXISTS ${meta.tableName}`); } catch (_) { /* ignore */ }
        try { await this._conn.query(`DROP VIEW IF EXISTS ${meta.tableName}`); } catch (_) { /* ignore */ }
        await this.unregisterFile(meta.handle);
        this._clearRangeCacheForTable(meta.tableName);
        delete legacyData._duckdb;
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
        if (cached) return cached;

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
            const result = await this._conn.query(sql);
            const yByVar = new Map();
            requested.forEach(({ varName }, index) => {
                yByVar.set(varName, this._extractColumnAsFloat64(result, index + 1, 'DOUBLE'));
            });
            return {
                x: this._extractColumnAsFloat64(result, 0, 'DOUBLE'),
                yByVar,
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
        const result = await this._conn.query(sql);
        const yByVar = new Map();
        requested.forEach(({ varName }, index) => {
            yByVar.set(varName, this._extractColumnAsFloat64(result, index + 1, 'DOUBLE'));
        });
        return {
            x: this._extractColumnAsFloat64(result, 0, 'DOUBLE'),
            yByVar,
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

    _clearRangeCacheForTable(tableName) {
        if (!tableName || !this._rangeCache?.size) return;
        for (const key of [...this._rangeCache.keys()]) {
            if (String(key).startsWith(`${tableName}\u001e`)) this._rangeCache.delete(key);
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

        const result = await this._conn.query(sql);
        return {
            times: this._extractColumnAsFloat64(result, 0, 'DOUBLE'),
            values: this._extractColumnAsFloat64(result, 1, 'DOUBLE'),
        };
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

        let totalRows;
        let dataSql;
        if (!viewMode) {
            const countResult = await this._conn.query(`SELECT COUNT(*)::BIGINT AS n FROM ${tableName}`);
            const countCol = countResult.getChildAt(0) || countResult.getChild('n');
            totalRows = Number(countCol?.get(0) ?? 0);
            dataSql = (!lazy || totalRows <= overviewPoints)
                ? `SELECT ${projection} FROM ${tableName} ORDER BY "${escTimeAlias}" ASC NULLS LAST`
                : this._overviewSql(tableName, projection, escTimeAlias, totalRows, overviewPoints);
        } else {
            if (format === 'parquet') {
                totalRows = await this._parquetRowCountFromMetadata(escapedHandle);
            }
            // VIEW mode: skip COUNT (would re-scan the whole CSV) and use
            // streaming reservoir sampling for the initial overview.
            dataSql = `
                SELECT * FROM (
                    SELECT ${projection} FROM ${tableName} USING SAMPLE ${overviewPoints} ROWS (RESERVOIR, 42)
                ) ORDER BY "${escTimeAlias}" ASC NULLS LAST
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
                    `SELECT MIN(${timeInfo.sql})::DOUBLE AS tmin, MAX(${timeInfo.sql})::DOUBLE AS tmax FROM ${tableName}`
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
                timeColumn: timeInfo.sourceNames[0] || timeInfo.name,
                timeExprSql: timeInfo.sql,
                totalRows,
                overviewPoints: totalRows
                    ? Math.min(overviewPoints, totalRows)
                    : overviewPoints,
                viewMode,
            };
        }
        return legacy;
    }

    _csvReadExpr(escapedHandle, csvProfile = null) {
        if (!csvProfile) return `read_csv_auto('${escapedHandle}', sample_size=20000)`;

        const specs = this._csvColumnSpecs(csvProfile);
        const options = [
            `auto_detect=false`,
            `header=false`,
            `skip=${Math.max(0, Number(csvProfile.dataStartIndex) || 0)}`,
            `columns=${this._duckDbColumnsStruct(specs)}`,
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
        return nonEmpty > 0 && numeric === nonEmpty ? 'DOUBLE' : 'VARCHAR';
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
        if (strategy === 'decimal-year' || strategy === 'month-name-date' || strategy === 'yearless-date-time') return null;

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

    _overviewSql(tableName, projection, escTime, totalRows, overviewPoints) {
        const stride = Math.max(1, Math.ceil(totalRows / overviewPoints));
        // Keep first + last + every Nth row by time order. Numbered separately
        // so the result is still ordered by time.
        return `
            WITH projected AS (
                SELECT ${projection}
                FROM ${tableName}
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
            timeVar.timeDisplayMode = 'calendar';
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
            timeDisplayMode: timeKind === 'datetime' ? 'calendar' : 'numeric',
            timeOriginMs: timeVar.timeOriginMs ?? null,
            timeSourceColumns: timeInfo?.sourceNames?.length ? timeInfo.sourceNames : [timeName],
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
        // Try the typed-array fast path. Arrow exposes toArray() for primitive cols.
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
                for (let i = 0; i < raw.length; i++) arr[i] = Number(raw[i]);
                return arr;
            }
        } catch (_) { /* fall through */ }
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
