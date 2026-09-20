// Collapsing rows that share a timestamp.
//
// A logger writing a burst at one instant, a device whose clock is coarser than
// its sampling loop, a Modelica event: several rows land on the same stamp. The
// app no longer takes the time axis away over it (#154) — but the rows are
// still several answers to one question, and a reader usually wants one.
//
// Which one is theirs to say: the mean of the burst, its extremes, or simply
// the row that arrived first or last. Nothing here guesses.
//
// Runs are CONSECUTIVE rows with the same stamp. The app sorts a file by time
// as it reads it, so equal stamps are adjacent; grouping by adjacency also
// means a file that was NOT sorted keeps its order instead of being silently
// rearranged by this tool.

export const COLLAPSE_AGGREGATES = ['mean', 'max', 'min', 'first', 'last'];
export const COLLAPSE_DEFAULT_AGGREGATE = 'mean';

/** The aggregate names this kernel knows, with an unknown one falling back to the default. */
export function normalizeCollapseAggregate(aggregate) {
    return COLLAPSE_AGGREGATES.includes(aggregate) ? aggregate : COLLAPSE_DEFAULT_AGGREGATE;
}

/**
 * Where the runs of equal timestamps are.
 *
 * A non-finite stamp (NaT, a row whose time could not be read) never joins a
 * run: it cannot be said to be at the same instant as anything.
 *
 * @returns {{starts: Int32Array, lengths: Int32Array, groups: number, collapsed: number}}
 *   `collapsed` is how many rows the file would lose.
 */
export function timestampRuns(time) {
    const n = time?.length || 0;
    const starts = new Int32Array(n);
    const lengths = new Int32Array(n);
    let groups = 0;
    let i = 0;
    while (i < n) {
        const value = Number(time[i]);
        let end = i + 1;
        if (Number.isFinite(value)) {
            while (end < n && Number(time[end]) === value) end++;
        }
        starts[groups] = i;
        lengths[groups] = end - i;
        groups++;
        i = end;
    }
    return {
        starts: starts.subarray(0, groups),
        lengths: lengths.subarray(0, groups),
        groups,
        collapsed: n - groups,
    };
}

// mean/max/min are over the FINITE values of the run: a gap in one of the rows
// is a missing reading, not a reason to throw the burst away. A run with no
// finite value at all has nothing to average, and says so with NaN.
function aggregateRun(values, start, length, aggregate) {
    if (aggregate === 'first') return Number(values[start]);
    if (aggregate === 'last') return Number(values[start + length - 1]);
    let sum = 0;
    let count = 0;
    let max = -Infinity;
    let min = Infinity;
    for (let i = start; i < start + length; i++) {
        const value = Number(values[i]);
        if (!Number.isFinite(value)) continue;
        sum += value;
        count++;
        if (value > max) max = value;
        if (value < min) min = value;
    }
    if (!count) return NaN;
    if (aggregate === 'max') return max;
    if (aggregate === 'min') return min;
    return sum / count;
}

/**
 * One row per instant.
 *
 * @param {{time: ArrayLike<number>, columns: ArrayLike<number>[], params: {aggregate?: string}}} input
 * @returns {{time: Float64Array, columns: Float64Array[], groups: number, collapsed: number, aggregate: string}}
 */
export function runCollapseRepeats({ time, columns = [], params = {} } = {}) {
    const aggregate = normalizeCollapseAggregate(params.aggregate);
    const runs = timestampRuns(time || []);
    const out = new Float64Array(runs.groups);
    for (let g = 0; g < runs.groups; g++) out[g] = Number(time[runs.starts[g]]);
    const collapsedColumns = columns.map((values) => {
        const column = new Float64Array(runs.groups);
        for (let g = 0; g < runs.groups; g++) {
            column[g] = runs.lengths[g] === 1
                ? Number(values[runs.starts[g]])
                : aggregateRun(values, runs.starts[g], runs.lengths[g], aggregate);
        }
        return column;
    });
    return { time: out, columns: collapsedColumns, groups: runs.groups, collapsed: runs.collapsed, aggregate };
}
