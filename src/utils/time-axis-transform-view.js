// Does the axis the plots draw deserve its own diagnostic block?
//
// The time-axis inspector measures the file's own time column. A file transform
// that REPLACES that column — a reindex above all, which discards the stored
// timestamps and steps by row — therefore left the dialog reporting the sampling
// of data nobody is looking at any more: reindex an irregular file to a clean
// 10-minute step and the verdict still read "irregular" (#107).
//
// The answer is a second block for the transformed axis, but only where the two
// actually disagree. A time offset, a crop-free promotion of numeric seconds to
// a calendar, a "show as duration" — those move or relabel every sample by the
// same amount and would print the same numbers twice, which is noise, not
// information.
//
// Pure (no DOM, no Plotly) so the offline suite can cover the decision itself.

// Compared exactly: these are counts, and one more gap IS a different axis.
// `backwards` and `gaps` are null when that check could not run, so the
// comparison has to survive null on either side.
const COUNTS = ['nSamples', 'repeated', 'gaps', 'backwards'];
// Compared with a tolerance: see below.
const MEASURES = ['span', 'dtMin', 'dtMedian', 'dtMean', 'dtMax'];

// Both sides reach the same seconds by different arithmetic — (t - origin)/1000
// on one, t * 1e-3 on the other — and a float time vector carries ~1e-16 of
// relative noise per sample on top. Equality here is relative, never exact; the
// bound is still many decades below any difference a reader would care about.
export const TIME_AXIS_VIEW_TOLERANCE = 1e-9;

function sameMeasure(a, b, tolerance) {
    const aFinite = Number.isFinite(a);
    if (aFinite !== Number.isFinite(b)) return false;
    // Both unknown (an empty axis, a step nobody could measure): nothing to
    // disagree about, so this is not a reason to open a second block.
    if (!aFinite) return true;
    const scale = Math.max(Math.abs(a), Math.abs(b));
    return Math.abs(a - b) <= (scale === 0 ? 0 : scale * tolerance);
}

/**
 * True when `transformed` describes an axis the reader would not recognise from
 * `source` — the only case where showing both is worth the space.
 */
export function timeAxisViewsDiffer(source, transformed, tolerance = TIME_AXIS_VIEW_TOLERANCE) {
    if (!transformed) return false;
    if (!source) return true;
    if (source.verdict !== transformed.verdict) return true;
    // A pure row index counts samples where the stored column measured seconds.
    // The numbers can coincide (row i against i × 1 s) while the axis does not.
    if (!!source.unitless !== !!transformed.unitless) return true;
    for (const key of COUNTS) {
        const a = source[key] ?? null;
        const b = transformed[key] ?? null;
        if (a !== b) return true;
    }
    for (const key of MEASURES) {
        if (!sameMeasure(source[key], transformed[key], tolerance)) return true;
    }
    return false;
}
