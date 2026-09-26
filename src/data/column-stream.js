// Every row of a file's columns, a chunk at a time, whatever the file is.
//
//   for await (const { x, yByVar, rowStart } of streamColumns(data, names, options)) { … }
//
// One interface over the two ways a file can be held. A lazy (DuckDB-backed)
// file streams from DuckDB without the result ever existing in one piece —
// see DuckDBSource.streamColumns. An eager file is already in memory, and is
// cut into chunks of the arrays it has. A consumer written against this runs
// on a 5 MB file and a 50 GB one without knowing which it has.
//
// Rules shared by both paths, so the same file gives the same rows either way:
//   · rows with no time are skipped (a generated index always has one);
//   · `t0`/`t1` keep the rows whose time falls in [t0, t1], inclusive;
//   · rows keep the order they have in the file — nothing is sorted;
//   · a missing value is NaN.
//
// The arrays in a chunk are read-only. For an eager file they may be views of
// the file's own columns, so writing to them would change the data on screen.

const DEFAULT_CHUNK_ROWS = 262144;

export async function* streamColumns(data, varNames, options = {}) {
    const source = data?._duckdb?.source;
    if (source?.streamColumns) {
        yield* source.streamColumns(data, varNames, options);
        return;
    }
    yield* streamEagerColumns(data, varNames, options);
}

export async function* streamEagerColumns(data, varNames, options = {}) {
    const names = [...new Set(varNames || [])].filter(name => isArrayLike(data?.variables?.[name]?.data));
    if (!names.length) return;
    const columns = names.map(name => data.variables[name].data);
    const length = Math.max(...columns.map(column => column.length));
    const time = eagerTime(data, length);

    let lo = Number(options.t0);
    let hi = Number(options.t1);
    const ranged = options.t0 != null && options.t1 != null && Number.isFinite(lo) && Number.isFinite(hi);
    if (ranged && lo > hi) [lo, hi] = [hi, lo];
    const chunkRows = Math.max(1, Math.round(Number(options.chunkRows) || DEFAULT_CHUNK_ROWS));
    const signal = options.signal;

    let rowStart = 0;
    for (let from = 0; from < length; from += chunkRows) {
        if (signal?.aborted) throw abortError();
        const to = Math.min(length, from + chunkRows);
        const keep = [];
        for (let i = from; i < to; i++) {
            const t = time[i];
            if (!Number.isFinite(t)) continue;
            if (ranged && (t < lo || t > hi)) continue;
            keep.push(i);
        }
        if (!keep.length) continue;
        const contiguous = keep.length === to - from;
        const x = contiguous ? viewOrCopy(time, from, to) : gather(time, keep);
        const yByVar = new Map();
        names.forEach((name, index) => {
            const column = columns[index];
            yByVar.set(name, contiguous ? viewOrCopy(column, from, to) : gather(column, keep));
        });
        yield { x, yByVar, rowStart };
        rowStart += keep.length;
        // Give the event loop a turn between chunks, as the lazy path does by
        // waiting on DuckDB. A consumer with a Cancel button needs it to paint.
        await Promise.resolve();
    }
}

function eagerTime(data, length) {
    const timeName = data?.metadata?.timeName;
    const time = timeName ? data?.variables?.[timeName]?.data : null;
    if (isArrayLike(time) && time.length >= length) return time;
    // No time column the reader could use: the sample index is the axis, as it
    // is for a lazy file with generated time.
    const index = new Float64Array(length);
    for (let i = 0; i < length; i++) index[i] = i;
    return index;
}

function viewOrCopy(column, from, to) {
    if (column instanceof Float64Array) return column.subarray(from, to);
    const out = new Float64Array(to - from);
    for (let i = from; i < to; i++) out[i - from] = toNumber(column[i]);
    return out;
}

function gather(column, indexes) {
    const out = new Float64Array(indexes.length);
    for (let k = 0; k < indexes.length; k++) out[k] = toNumber(column[indexes[k]]);
    return out;
}

function toNumber(value) {
    if (value == null) return NaN;
    const number = Number(value);
    return Number.isNaN(number) ? NaN : number;
}

function isArrayLike(value) {
    return Array.isArray(value) || ArrayBuffer.isView(value);
}

function abortError() {
    const err = new Error('Stream cancelled');
    err.name = 'AbortError';
    return err;
}
