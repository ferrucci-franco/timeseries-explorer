// A file DuckDB cannot read by itself, opened in memory-saving (lazy) mode.
//
// A CSV or a Parquet file stays where it is and DuckDB reads it. A MAT file is
// a format DuckDB has no reader for, so its samples are copied once, a block
// at a time, into tables of the engine (on disk, where the browser gives the
// engine a disk), and those tables are adopted as a lazy dataset: the same
// `{ metadata, variables, tree, _duckdb }` every lazy query, analysis, data
// tool and export already reads. Nothing downstream knows the rows came from
// a MAT file.
//
// What is read is a "columnar reader" (src/parsers/mat-v4-stream.js describes
// the shape): the rows in order, as blocks of one Float64Array per series.
//
// Width. A simulation result is often wide: thousands of series. One table
// with thousands of columns is what DuckDB-WASM does worst (measured: 1 000
// columns insert at a third of the speed of 200, and 2 000 fail to commit in
// the engine's memory), so the series are spread over tables of
// INGEST_GROUP_COLUMNS columns. The first holds the time and is the dataset's
// table; the series of the others are read as sink columns — joined to it by
// position (DuckDbSource._fromSql), the mechanism a data tool's output on a
// lazy file already uses, so a query pays only for the tables it reads.
//
// Overview. A lazy file keeps a decimated overview of every series in memory.
// For a wide file 10 000 points of each would be the file again, so the
// points are fewer the more series there are (ingestOverviewPoints). The
// overview is taken from the blocks as they go by: every stride-th row and
// the last, the rows adoptDatasetTable takes.

import MatParser from '../parsers/mat-parser.js';
import { sinkColumn } from './lazy-tool-sql.js';

export const INGEST_GROUP_COLUMNS = 250;
// Values held in memory as the overview of all the series together (8 bytes
// each: 160 MB), and the fewest points a series is drawn with.
export const INGEST_OVERVIEW_VALUES = 20_000_000;
export const INGEST_MIN_OVERVIEW_POINTS = 1000;
// Values handed to the engine per insert, across the columns of one table.
const INSERT_VALUES = 4_000_000;

let nextIngestId = 0;

export function ingestOverviewPoints(columns, requested = 10000) {
    const wanted = Math.max(2, Math.round(Number(requested) || 10000));
    const room = Math.floor(INGEST_OVERVIEW_VALUES / Math.max(1, columns));
    return Math.max(Math.min(wanted, INGEST_MIN_OVERVIEW_POINTS), Math.min(wanted, room));
}

// What MatParser._detectDataType and _isConstantValues say of a whole series,
// counted as the blocks go by — of the series and of its negation.
function newStats() {
    return { seen: 0, first: NaN, constant: true, zeroOne: true, zeroMinusOne: true, zero: false, one: false, minusOne: false };
}

function countStats(stats, values) {
    let i = 0;
    if (!stats.seen && values.length) { stats.first = values[0]; i = 1; noteValue(stats, values[0]); }
    const first = stats.first;
    for (; i < values.length; i++) {
        const v = values[i];
        if (v !== first) stats.constant = false;
        noteValue(stats, v);
    }
    stats.seen += values.length;
}

function noteValue(stats, v) {
    if (!Number.isFinite(v)) return;
    if (v === 0) { stats.zero = true; return; }
    if (v === 1) { stats.one = true; stats.zeroMinusOne = false; return; }
    if (v === -1) { stats.minusOne = true; stats.zeroOne = false; return; }
    stats.zeroOne = false;
    stats.zeroMinusOne = false;
}

function dataTypeOf(stats, negate) {
    if (negate) return stats.zeroMinusOne && stats.zero && stats.minusOne ? 'boolean' : 'real';
    return stats.zeroOne && stats.zero && stats.one ? 'boolean' : 'real';
}

// A number as a DOUBLE constant; NaN is NULL, which every lazy query reads as NaN.
function constantSql(value) {
    if (typeof value !== 'number') return null;
    if (Number.isNaN(value)) return 'CAST(NULL AS DOUBLE)';
    if (!Number.isFinite(value)) return `CAST('${value > 0 ? '' : '-'}Infinity' AS DOUBLE)`;
    return `CAST(${Object.is(value, -0) ? '-0.0' : String(value)} AS DOUBLE)`;
}

const quote = name => `"${String(name).replace(/"/g, '""')}"`;

/**
 * Copy a columnar reader into the engine and return it as a lazy dataset.
 *
 * @param {object} source a DuckDbSource
 * @param {object} reader a columnar reader
 * @param {{ signal?: AbortSignal, onProgress?: (done: number, total: number) => void,
 *           overviewPoints?: number, groupColumns?: number, parser?: MatParser }} options
 * @returns {Promise<object>} `{ metadata, variables, tree, _duckdb }`
 */
export async function ingestColumnarReader(source, reader, options = {}) {
    const { signal = null, onProgress = null, parser = new MatParser() } = options;
    const groupColumns = Math.max(2, Math.round(Number(options.groupColumns) || INGEST_GROUP_COLUMNS));
    await source.init();
    const rows = reader.rows;
    const timeIndex = reader.timeColumn;
    const valueIndexes = [];
    for (let c = 0; c < reader.columns; c++) if (c !== timeIndex) valueIndexes.push(c);

    // While it is written, every table is a "sink" of this holder: cancelled
    // or failed, they are dropped through it.
    const base = `omv_ingest_${Date.now().toString(36)}_${++nextIngestId}`;
    const holder = { _duckdb: { tableName: base, baseTableName: base, sinks: new Map() } };
    const groups = [];
    // Where each column of the reader is: its table, and the SQL that reads it.
    const place = new Array(reader.columns);
    place[timeIndex] = { group: 0, sql: '"t"', column: 't', window: null };

    const points = ingestOverviewPoints(reader.columns, options.overviewPoints);
    const stride = Math.max(1, Math.ceil(rows / points));
    const overviewRows = rows ? Math.ceil(rows / stride) + ((rows - 1) % stride ? 1 : 0) : 0;
    const overview = Array.from({ length: reader.columns }, () => new Float64Array(overviewRows));
    const stats = Array.from({ length: reader.columns }, newStats);
    let overviewAt = 0;
    let done = 0;

    const dropAll = async () => {
        for (const group of groups) {
            try {
                if (group.writer) await group.writer.abort();
                else await source.dropSink(holder, group.dataset.table);
            } catch (_) { /* already gone */ }
        }
    };

    try {
        for (let start = 0, g = 0; start < valueIndexes.length || g === 0; start += (g === 0 ? groupColumns - 1 : groupColumns), g++) {
            const members = valueIndexes.slice(start, start + (g === 0 ? groupColumns - 1 : groupColumns));
            if (g > 0 && !members.length) break;
            let dataset;
            if (g === 0) {
                const names = members.map(index => `c${index}`);
                dataset = await source.createDatasetTable(holder, { timeColumn: 't', columns: names.length ? names : ['__omv_none'] });
                members.forEach((index, k) => { place[index] = { group: 0, sql: quote(names[k]), column: names[k], window: null }; });
            } else {
                const table = `${base}_p${g}`;
                const windows = members.map((_, k) => sinkColumn(table, k));
                dataset = await source.createDatasetTable(holder, { timeColumn: `__omv_t${g}`, columns: windows.map(w => w.column), table });
                // The name asked for is the name the sink columns were made for.
                if (dataset.table !== table) throw new Error(`columnar ingest: table ${table} is taken`);
                members.forEach((index, k) => { place[index] = { group: g, sql: quote(windows[k].column), column: windows[k].column, window: windows[k] }; });
            }
            const chunkRows = Math.max(1024, Math.floor(INSERT_VALUES / (members.length + 1)));
            groups.push({ dataset, members, writer: source.openDatasetWriter(holder, dataset, { chunkRows }) });
        }
        // A file with no series but the time still needs its one value column.
        const filler = groups[0].members.length ? null : true;

        for await (const block of reader.blocks({ signal })) {
            const n = block.rows;
            const time = block.columns[timeIndex];
            for (let c = 0; c < reader.columns; c++) countStats(stats[c], block.columns[c]);
            // Every stride-th row of the file, and its last.
            for (let i = 0; i < n; i++) {
                const row = done + i;
                if (row % stride !== 0 && row !== rows - 1) continue;
                for (let c = 0; c < reader.columns; c++) overview[c][overviewAt] = block.columns[c][i];
                overviewAt += 1;
            }
            for (const group of groups) {
                const columns = filler && group === groups[0]
                    ? [new Float64Array(n).fill(NaN)]
                    : group.members.map(index => block.columns[index]);
                await group.writer.append(time, columns);
            }
            done += n;
            onProgress?.(done, rows);
            if (signal?.aborted) {
                const error = new Error('Aborted');
                error.name = 'AbortError';
                throw error;
            }
        }
        for (const group of groups) {
            await group.writer.finish();
            group.writer = null;
        }
    } catch (error) {
        await dropAll();
        throw error;
    }

    let adopted;
    try {
        adopted = await source.adoptDatasetTable(holder, groups[0].dataset, {
            timeName: reader.timeName || 't',
            // A netCDF CF axis is milliseconds since an origin, not seconds of
            // simulation: the dataset has to know, or every date reads as a
            // number of milliseconds.
            timeKind: reader.timeKind === 'datetime' ? 'datetime' : 'numeric',
            overviewPoints: points,
        });
    } catch (error) {
        await dropAll();
        throw error;
    }
    // The other tables go with the dataset: dropped when it is released.
    for (const group of groups.slice(1)) {
        holder._duckdb.sinks.delete(group.dataset.table);
        adopted._duckdb.sinks.set(group.dataset.table, group.dataset);
    }

    const used = overviewAt === overviewRows ? overview : overview.map(column => column.subarray(0, overviewAt));
    const timeName = adopted.metadata.timeName;
    const variables = {};
    const timeDeclared = reader.variables.find(variable => variable.column === timeIndex && variable.kind === 'abscissa');
    for (const declared of reader.variables) {
        if (declared === timeDeclared) {
            variables[timeName] = {
                ...adopted.variables[timeName],
                // How the axis is displayed, what it is called on screen, and
                // whatever else the format knows about it.
                ...(declared.extra || {}),
                name: timeName,
                data: used[timeIndex],
                description: declared.description || '',
                interpolation: declared.interpolation || 'linear',
                source: reader.format,
            };
            continue;
        }
        if (declared.kind === 'parameter' || declared.column == null) {
            const values = declared.values || [];
            variables[declared.name] = {
                ...(declared.extra || {}),
                name: declared.name,
                data: values,
                description: declared.description || '',
                kind: 'parameter',
                dataType: parser._detectDataType(values, 'parameter'),
                isConstant: parser._isConstantValues(values),
                interpolation: declared.interpolation || 'linear',
                negate: !!declared.negate,
                source: reader.format,
            };
            // In memory an analysis reads a parameter as its value at every
            // row; as a constant of the file's rows it is that here too.
            const constant = constantSql(values[0]);
            if (constant) variables[declared.name]._duckdbExpr = constant;
            continue;
        }
        const at = place[declared.column];
        const negate = !!declared.negate;
        const values = used[declared.column];
        const variable = {
            ...(declared.extra || {}),
            name: declared.name,
            data: negate ? values.map(v => -v) : values,
            description: declared.description || '',
            kind: declared.kind === 'abscissa' ? 'variable' : (declared.kind || 'variable'),
            dataType: dataTypeOf(stats[declared.column], negate),
            isConstant: stats[declared.column].seen > 0 && stats[declared.column].constant,
            interpolation: declared.interpolation || 'linear',
            negate,
            source: reader.format,
        };
        if (!negate && !at.window) variable._duckdbCol = at.column;
        else variable._duckdbExpr = negate ? `(-${at.sql})` : at.sql;
        if (at.window) variable._duckdbWindows = [at.window];
        variables[declared.name] = variable;
    }
    if (!variables[timeName]) {
        variables[timeName] = { ...adopted.variables[timeName], data: used[timeIndex], source: reader.format };
    }

    const list = Object.values(variables);
    const time = variables[timeName].data;
    adopted.variables = variables;
    adopted.metadata = {
        ...adopted.metadata,
        ...(reader.metadata || {}),
        numVariables: list.length,
        numParams: list.filter(variable => variable.kind === 'parameter').length,
        numTimevarying: list.filter(variable => variable.kind === 'variable').length,
        numTimesteps: rows,
        timeStart: time.length ? time[0] : 0,
        timeEnd: time.length ? time[time.length - 1] : 0,
        timeName,
        format: `${reader.format}-lazy`,
        csv: false,
        ingest: { format: reader.format, tables: groups.length, columns: reader.columns, overviewPoints: time.length },
    };
    adopted._duckdb.overviewPoints = Math.max(2, time.length);
    // A format whose series have a shape of their own — netCDF groups them by
    // the dataset each was cut from, under the file's dimensions and its global
    // attributes — hands back the tree it would have built in memory, so the
    // sidebar of a lazy file is the sidebar of the same file read whole.
    adopted.tree = reader.buildTree ? reader.buildTree(variables, adopted) : parser._buildTree(variables);
    return adopted;
}
