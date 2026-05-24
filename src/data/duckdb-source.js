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

const BUNDLES = {
    mvp: { mainModule: mvpWasmUrl, mainWorker: mvpWorkerUrl },
    eh:  { mainModule: ehWasmUrl,  mainWorker: ehWorkerUrl  },
};

// Header keywords used to pick a time column when DuckDB types alone are
// ambiguous. Mirrors a tiny subset of csv-time-detection's vocabulary so we
// stay aligned with the rest of the app.
const TIME_HEADER_RE = /^(time|temps|t|datetime|timestamp|horodatage|date|fecha|hora|heure)$/i;

export default class DuckDbSource {
    constructor(structureParser = null) {
        this.structureParser = structureParser || null;
        this._db = null;
        this._conn = null;
        this._initPromise = null;
        this._registered = new Set();
        this._nextTableId = 0;
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

    async getColumnRange(/* tableName, col, t0, t1, maxPoints */) {
        throw new Error('getColumnRange will be implemented in Phase 1.B');
    }

    /**
     * Parse a CSV File into the legacy {variables, metadata, tree} shape.
     * Returns null if DuckDB cannot read the file; the caller should fall back.
     */
    async parseCsvFile(file, displayName = file.name) {
        await this.init();
        const handle = `bench_${++this._nextTableId}_${displayName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const tableName = `t_${this._nextTableId}`;
        await this.registerFile(handle, file);
        try {
            return await this._loadCsvIntoLegacy(handle, tableName, file);
        } finally {
            try { await this._conn.query(`DROP TABLE IF EXISTS ${tableName}`); } catch (_) { /* ignore */ }
            await this.unregisterFile(handle);
        }
    }

    async _loadCsvIntoLegacy(handle, tableName, file) {
        // Let DuckDB auto-detect delimiter, quote, decimal, header, types.
        // `all_varchar=false` keeps numeric columns typed (so toArray() returns Float64Array).
        // `union_by_name=false` keeps original column order.
        const escapedHandle = handle.replace(/'/g, "''");
        const createSql = `CREATE TABLE ${tableName} AS SELECT * FROM read_csv_auto('${escapedHandle}', sample_size=20000)`;
        try {
            await this._conn.query(createSql);
        } catch (err) {
            // Surface the underlying DuckDB error so the caller can decide.
            throw new Error(`DuckDB read_csv_auto failed: ${err?.message || err}`);
        }

        const schemaResult = await this._conn.query(`DESCRIBE ${tableName}`);
        const schema = this._arrowRowsToObjects(schemaResult);

        const countResult = await this._conn.query(`SELECT COUNT(*)::BIGINT AS n FROM ${tableName}`);
        const totalRows = Number(countResult.getChild(0).get(0));

        const columnNames = schema.map(s => s.column_name);
        const columnTypes = schema.map(s => String(s.column_type || '').toUpperCase());

        // Pick a time column. Heuristic: first header that matches TIME_HEADER_RE,
        // else first column if it is numeric / timestamp.
        let timeColIndex = columnNames.findIndex(name => TIME_HEADER_RE.test(String(name).trim()));
        if (timeColIndex < 0) {
            const firstType = columnTypes[0] || '';
            if (/INT|BIGINT|DOUBLE|REAL|FLOAT|DECIMAL|NUMERIC|TIMESTAMP|DATE|TIME/.test(firstType)) {
                timeColIndex = 0;
            }
        }
        if (timeColIndex < 0) {
            throw new Error('DuckDB: no suitable time column detected; falling back.');
        }

        const orderClause = `ORDER BY "${columnNames[timeColIndex].replace(/"/g, '""')}" ASC NULLS LAST`;
        const dataResult = await this._conn.query(`SELECT * FROM ${tableName} ${orderClause}`);

        return this._buildLegacyFromArrow(dataResult, columnNames, columnTypes, timeColIndex, totalRows);
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

    _buildLegacyFromArrow(table, columnNames, columnTypes, timeColIndex, totalRows) {
        const result = {
            filename: '',
            metadata: {},
            variables: {},
            tree: {},
        };

        const timeName = columnNames[timeColIndex];
        const timeType = columnTypes[timeColIndex];
        const timeData = this._extractColumnAsFloat64(table, timeColIndex, timeType);
        const timeKind = /TIMESTAMP|DATE|TIME/.test(timeType) ? 'datetime' : 'numeric';

        const usedNames = new Set();
        const sanitize = (raw) => {
            const base = String(raw ?? '').trim() || `column`;
            return base;
        };

        const timeVar = {
            name: this._uniqueName(sanitize(timeName), usedNames),
            data: timeData,
            description: timeKind === 'datetime' ? '[datetime]' : '',
            kind: 'abscissa',
            dataType: 'real',
            isConstant: false,
            interpolation: 'linear',
            negate: false,
            source: 'csv',
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
            timeSourceColumns: [timeName],
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
        const child = table.getChild(idx);
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
        const child = table.getChild(idx);
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
