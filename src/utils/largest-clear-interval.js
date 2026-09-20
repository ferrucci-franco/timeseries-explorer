// The longest stretch of a span with nothing blocking it.
//
// The FFT refuses a selection that contains missing data — a NaN, or a hole in
// the timestamps — and until now it said so and stopped, leaving the user to
// find a clean stretch by dragging the green selection around (#59). Given the
// intervals where data is missing, this returns the longest interval where it
// is not, which is the one worth transforming.
//
// The blocking intervals arrive as the missing-data detector reports them:
// `t0` is the last good sample before the hole and `t1` the first good one
// after it, so the hole itself is the OPEN interval (t0, t1) and both endpoints
// are samples a transform may use. That is why the complement below is built
// closed on both sides, and why two intervals that merely touch at a point are
// merged rather than left with a zero-width candidate between them.
//
// Pure (no DOM, no Plotly) so the offline suite can cover the arithmetic.

/**
 * @param {{min:number,max:number}} span      the selection to search within
 * @param {Array<{t0:number,t1:number}>} blocked  intervals where data is missing,
 *        in any order, from any number of traces — overlaps are expected, since
 *        the point is to find what is clear for ALL of them at once.
 * @returns {{range:[number,number]|null, blockedCount:number, blockedSpan:number}}
 *        `range` is the longest clear interval, or null when the span is fully
 *        blocked. `blockedCount` is how many intervals actually overlap the
 *        span — zero means there was nothing to work around, which is a
 *        different answer from "nothing survived".
 */
export function largestClearInterval(span, blocked = []) {
    const min = Number(span?.min);
    const max = Number(span?.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || !(max > min)) {
        return { range: null, blockedCount: 0, blockedSpan: 0 };
    }

    // Clip to the span, and drop what lies entirely outside it. An interval
    // ending exactly at `min` (or starting exactly at `max`) blocks nothing
    // inside: its endpoints are good samples.
    const clipped = [];
    for (const item of blocked) {
        const t0 = Number(item?.t0);
        const t1 = Number(item?.t1);
        if (!Number.isFinite(t0) || !Number.isFinite(t1) || !(t1 > t0)) continue;
        if (t1 <= min || t0 >= max) continue;
        clipped.push([Math.max(t0, min), Math.min(t1, max)]);
    }
    if (!clipped.length) return { range: null, blockedCount: 0, blockedSpan: 0 };

    clipped.sort((a, b) => a[0] - b[0]);
    const merged = [clipped[0]];
    for (let i = 1; i < clipped.length; i++) {
        const last = merged[merged.length - 1];
        const [t0, t1] = clipped[i];
        // `<=`, not `<`: two holes that meet at one sample leave no stretch
        // between them worth offering.
        if (t0 <= last[1]) last[1] = Math.max(last[1], t1);
        else merged.push([t0, t1]);
    }

    let blockedSpan = 0;
    for (const [t0, t1] of merged) blockedSpan += t1 - t0;

    let best = null;
    let bestWidth = 0;
    const consider = (lo, hi) => {
        const width = hi - lo;
        if (width > bestWidth) {
            bestWidth = width;
            best = [lo, hi];
        }
    };
    let cursor = min;
    for (const [t0, t1] of merged) {
        if (t0 > cursor) consider(cursor, t0);
        cursor = Math.max(cursor, t1);
    }
    if (cursor < max) consider(cursor, max);

    return { range: best, blockedCount: merged.length, blockedSpan };
}
