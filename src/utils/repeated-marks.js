// What the Repeated toggle draws for the current view
// (docs/repeated-timestamps-indicator-design.md).
//
// A repeated instant has no width in time, so there is no band to shade the way
// Missing/NaN does. Where the samples themselves are not drawn (zoomed out),
// the repeats show as red bars on a thin strip along the top of the plot. Many
// fall on one pixel, so the runs are grouped by screen column first: one mark
// per column that holds any, carrying how many instants it stands for and the
// longest run among them (for the hover), and adjacent marked columns merge
// into one bar. That bounds what is drawn by the plot width, whatever the file
// holds. Zoomed in, the Samples dots take over: each repeated sample gets a red
// ring, and the strip is not drawn.

/** Shortest run marked. 2 marks every repeat (a Modelica event is a 2-row run). */
export const REPEATED_MARK_MIN_RUN = 2;
/** Width of the screen column runs are grouped into, in pixels. */
export const REPEATED_MARK_COLUMN_PX = 3;

/**
 * @param {Array<{key: string, times: ArrayLike<number>, runs: {starts: Int32Array, lengths: Int32Array, count: number}}>} sources
 *   one entry per time column on the panel (usually one per file); `key` says
 *   which, so a mark can name its files.
 * @param {number} lo  visible range start, in the units of `times`
 * @param {number} hi  visible range end
 * @param {number} widthPx  plot area width
 * @param {number} [columnPx]
 * @returns {{
 *   marks: Array<{t: number, instants: number, longest: number, keys: string[]}>,
 *   regions: Array<{t0: number, t1: number}>,
 * }}
 *   `marks`: one per marked column, for the hover; `t` is a real repeated
 *   instant, the one with the longest run in its column. `regions`: the bars —
 *   runs of adjacent marked columns, as time spans.
 */
export function repeatedMarksForView(sources, lo, hi, widthPx, columnPx = REPEATED_MARK_COLUMN_PX) {
    const none = { marks: [], regions: [] };
    let a = Number(lo);
    let b = Number(hi);
    const width = Number(widthPx);
    if (!Number.isFinite(a) || !Number.isFinite(b) || !(width > 0)) return none;
    if (a > b) [a, b] = [b, a];
    const span = b - a;
    const step = Math.max(1, Number(columnPx) || REPEATED_MARK_COLUMN_PX);
    const columns = Math.max(1, Math.floor(width / step));

    const byColumn = new Map();
    for (const source of sources || []) {
        const { times, runs, key } = source || {};
        if (!times || !runs?.count) continue;
        // A linear pass, not a binary search: runs are in row order, and a
        // column out of chronological order is exactly the kind of file whose
        // repeats a user wants to find.
        for (let i = 0; i < runs.count; i++) {
            const t = Number(times[runs.starts[i]]);
            if (!(t >= a && t <= b)) continue;
            const column = span > 0
                ? Math.min(columns - 1, Math.floor(((t - a) / span) * columns))
                : 0;
            const length = runs.lengths[i];
            let mark = byColumn.get(column);
            if (!mark) {
                mark = { column, t, instants: 0, longest: 0, keys: new Set() };
                byColumn.set(column, mark);
            }
            // One run, one instant. (A column out of order that comes back to
            // the same instant later counts it again; the hover says "instants"
            // for what are, strictly, runs.)
            mark.instants += 1;
            if (length > mark.longest) {
                mark.longest = length;
                mark.t = t;
            }
            mark.keys.add(key);
        }
    }
    if (!byColumn.size) return none;

    const sorted = [...byColumn.values()].sort((m, n) => m.column - n.column);
    const marks = sorted.map(m => ({ t: m.t, instants: m.instants, longest: m.longest, keys: [...m.keys] }));
    const at = (column) => a + (column / columns) * span;
    const regions = [];
    let first = sorted[0].column;
    let last = first;
    for (let i = 1; i <= sorted.length; i++) {
        const column = i < sorted.length ? sorted[i].column : Infinity;
        if (column === last + 1) {
            last = column;
            continue;
        }
        regions.push({ t0: at(first), t1: at(last + 1) });
        first = column;
        last = column;
    }
    return { marks, regions };
}
