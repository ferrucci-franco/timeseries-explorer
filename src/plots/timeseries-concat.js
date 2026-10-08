// Joining a time-series panel's files one after another in time.
//
// One file per day, the same variable overlaid from all of them: exported trace
// by trace, that is a time column and a value column per day, each mostly
// empty. When the files do not overlap in time they are really one record cut
// into pieces, and the table a reader wants has one time column and one column
// per variable, the files placed one after another in time order.
//
// Nothing here knows about files or the DOM: the caller hands over each file's
// time range, and a reader of rows per file. The rows are served as blocks for
// the CSV writer (`{ columns, rows }`), a file at a time, so a lazy file is
// never held whole.

/** What to do with the rows at an instant where one file ends and the next begins. */
export const CONCAT_BOUNDARY_MODES = ['keep', 'mean', 'first', 'last'];
export const CONCAT_DEFAULT_BOUNDARY_MODE = 'keep';

export function normalizeConcatBoundaryMode(mode) {
    return CONCAT_BOUNDARY_MODES.includes(mode) ? mode : CONCAT_DEFAULT_BOUNDARY_MODE;
}

/**
 * Whether files can be placed one after another in time, and in which order.
 *
 * Each segment is a file's time range as plotted: `{ start, end }`, the
 * smallest and largest finite time. A file with no finite time has nothing to
 * place and goes last, where it adds no rows anyway.
 *
 * Sorted by start, a file overlaps when it starts before every earlier file
 * has ended. Starting exactly where the previous one ends is not an overlap:
 * a logger that writes midnight into both days loses nothing by being joined,
 * and such an instant is counted in `boundaryInstants` so it can be offered
 * as a choice.
 *
 * Only the first overlap is described: with thirty files in relative time,
 * every file overlaps every other, and a list of them would be the dialog.
 *
 * @param {Array<{start: number, end: number}>} segments
 * @returns {{order: number[], overlaps: number, firstOverlap: {earlier: number, later: number}|null,
 *   boundaryInstants: number}} indexes into `segments`
 */
export function planTimeConcat(segments = []) {
    const finite = (value) => Number.isFinite(value);
    const order = segments.map((_, index) => index).sort((a, b) => {
        const sa = segments[a];
        const sb = segments[b];
        const fa = finite(sa.start);
        const fb = finite(sb.start);
        if (fa !== fb) return fa ? -1 : 1;
        if (!fa) return a - b;
        return (sa.start - sb.start) || (sa.end - sb.end) || (a - b);
    });

    let overlaps = 0;
    let firstOverlap = null;
    let boundaryInstants = 0;
    let reachEnd = -Infinity;   // the latest end among the files placed so far
    let reachIndex = -1;        // the file that reaches it
    for (const index of order) {
        const { start, end } = segments[index];
        if (!finite(start) || !finite(end)) continue;
        if (reachIndex >= 0) {
            if (start < reachEnd) {
                overlaps++;
                if (!firstOverlap) firstOverlap = { earlier: reachIndex, later: index };
            } else if (start === reachEnd) {
                boundaryInstants++;
            }
        }
        if (end > reachEnd || reachIndex < 0) {
            reachEnd = end;
            reachIndex = index;
        }
    }
    return { order, overlaps, firstOverlap, boundaryInstants };
}

// One value out of the rows that share an instant across files. `undefined`
// is a file that does not have the variable at all: it has no say. A NaN is a
// reading the file does have, empty, and counts as that row's value for first
// and last; the mean is over finite values, as in Collapse repeated timestamps.
function mergeValues(values, mode) {
    const present = values.filter(value => value !== undefined);
    if (!present.length) return undefined;
    if (mode === 'first') return present[0];
    if (mode === 'last') return present[present.length - 1];
    let sum = 0;
    let count = 0;
    for (const value of present) {
        const number = Number(value);
        if (!Number.isFinite(number)) continue;
        sum += number;
        count++;
    }
    return count ? sum / count : NaN;
}

/**
 * The rows of every file, one after another, as blocks for the CSV writer.
 *
 * @param {object} options
 * @param {Array<{label: string, varNames: string[], take: (n: number) => Promise<{rows: number,
 *   rawTime: ArrayLike<number>, time: ArrayLike<any>, values: Map<string, ArrayLike<number>>}>}>} options.segments
 *   in the order they are to be written. `rawTime` is the time as a number,
 *   for comparing instants; `time` is what is written.
 * @param {string[]} options.varNames the value columns, in order. A file that
 *   does not have one leaves it empty.
 * @param {string} [options.boundaryMode] 'keep' writes every row; 'mean',
 *   'first' and 'last' write one row for an instant that rows from two or more
 *   files share, taking the mean, the earliest file's row or the latest's.
 * @param {(label: string) => any} [options.sourceCell] when given, a last
 *   column names the file each row comes from; a merged row names every file
 *   it was merged from, joined by ' + '.
 * @param {number} [options.blockRows] rows asked of a file at a time.
 */
export async function* concatenatedCsvBlocks({
    segments = [],
    varNames = [],
    boundaryMode = CONCAT_DEFAULT_BOUNDARY_MODE,
    sourceCell = null,
    blockRows = 65536,
} = {}) {
    const mode = normalizeConcatBoundaryMode(boundaryMode);
    const withSource = typeof sourceCell === 'function';
    const sourceCells = new Map();
    const sourceFor = (label) => {
        if (!sourceCells.has(label)) sourceCells.set(label, sourceCell(label));
        return sourceCells.get(label);
    };

    // A run of rows at one instant, held back in case the next file starts at
    // that same instant. Only a run that ends one file and starts the next is
    // ever merged; repeats inside a file are the file's own and stay as written.
    let held = null;  // { instant, rows: [{ time, values: any[], segment }] }

    const blockOfRows = (rows) => {
        const columns = [rows.map(row => row.time)];
        varNames.forEach((_, c) => columns.push(rows.map(row => row.values[c])));
        if (withSource) columns.push(rows.map(row => sourceFor(row.segment)));
        return { columns, rows: rows.length };
    };

    const releaseHeld = () => {
        if (!held) return null;
        const { rows } = held;
        held = null;
        const segmentsInRun = [...new Set(rows.map(row => row.segment))];
        if (segmentsInRun.length < 2) return blockOfRows(rows);
        const merged = {
            time: rows[0].time,
            values: varNames.map((_, c) => mergeValues(rows.map(row => row.values[c]), mode)),
            segment: segmentsInRun.join(' + '),
        };
        return blockOfRows([merged]);
    };

    for (const segment of segments) {
        const label = segment.label;
        const present = varNames.map(name => segment.varNames.includes(name));
        const rowAt = (part, i) => ({
            time: part.time[i],
            values: varNames.map((name, c) => (present[c] ? part.values.get(name)?.[i] : undefined)),
            segment: label,
        });

        for (;;) {
            const part = await segment.take(blockRows);
            if (!part?.rows) break;
            const { rows, rawTime } = part;

            if (mode === 'keep') {
                // Nothing is merged: the file's columns go out as they are,
                // views rather than copies. A variable the file lacks is an
                // empty column, whose every cell the writer leaves blank.
                const columns = [part.time];
                varNames.forEach((name, c) => columns.push(present[c] ? (part.values.get(name) || []) : []));
                if (withSource) columns.push(new Array(rows).fill(sourceFor(label)));
                yield { columns, rows };
                continue;
            }

            // The head: rows at the instant held from before join that run.
            let from = 0;
            if (held) {
                while (from < rows && rawTime[from] === held.instant) {
                    held.rows.push(rowAt(part, from));
                    from++;
                }
                if (from === rows) continue;
                const released = releaseHeld();
                if (released) yield released;
            }

            // The tail: the last instant of this block is held back, since the
            // next block — or the next file — may continue it.
            const lastInstant = rawTime[rows - 1];
            let to = rows;
            if (Number.isFinite(lastInstant)) {
                while (to > from && rawTime[to - 1] === lastInstant) to--;
            }

            if (to > from) {
                const slice = column => (ArrayBuffer.isView(column) ? column.subarray(from, to) : column.slice(from, to));
                const columns = [slice(part.time)];
                varNames.forEach((name, c) => columns.push(present[c] ? slice(part.values.get(name) || []) : []));
                if (withSource) columns.push(new Array(to - from).fill(sourceFor(label)));
                yield { columns, rows: to - from };
            }
            if (to < rows) {
                held = { instant: lastInstant, rows: [] };
                for (let i = to; i < rows; i++) held.rows.push(rowAt(part, i));
            }
        }
    }
    const released = releaseHeld();
    if (released) yield released;
}
