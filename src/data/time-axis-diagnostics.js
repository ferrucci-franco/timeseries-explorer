// Pure, dependency-free diagnostics for a file's time axis, plus the SQL
// builders for the lazy (DuckDB) path. Kept out of DuckDbSource (which imports
// the Vite-only WASM engine) so it is unit-testable in Node.
//
// The question this answers: "is this series equidistant, and if not, where does
// it break?" — repeated timestamps (several samples at the same instant), gaps
// (missing samples), and time that goes backwards. Plotting Δt shows you *where*
// it breaks; this tells you *whether* it does, as a number.
//
// Everything hangs off the MEDIAN Δt, not the mean. The median is what a reader
// means by "the step": it survives gaps, event points and a handful of outliers,
// where the mean is dragged by every one of them. It is also the only reference
// that makes the two classifications below stable, since both are ratios against
// "the typical step".
//
// The Δt statistics deliberately EXCLUDE the intervals that do not really
// advance time. A Modelica result emits a duplicated timestamp at every event,
// so a perfectly uniform 1 ms run would otherwise report "Δt min 0 s" and read
// as irregular because of one benign event point. Some solvers do not repeat the
// instant exactly but restart a fraction of a nanosecond later, which is the same
// thing written differently — so the rule is a ratio, not a test against zero:
// anything below TIME_AXIS_COINCIDENT_FACTOR × the median step is two samples at
// one instant. They are their own reported category, and the verdict has three
// states rather than two.
//
// Eager files are scanned in FILE order, so a time vector that steps backwards is
// detected. The lazy path cannot: DuckDB runs with preserve_insertion_order=false,
// so the SQL walks the SORTED timeline and `backwards` stays null ("not checked")
// instead of being wrongly reported as zero.

// A Δt above this multiple of the median counts as a gap. Matches the nominal-step
// heuristic the lazy missing-data bands already use.
export const TIME_AXIS_GAP_FACTOR = 1.5;
// Relative spread below which the sampling is called equidistant. Float time
// vectors accumulate ~1e-16 relative noise per sample, orders below this.
export const TIME_AXIS_EQUIDISTANT_TOLERANCE = 1e-6;
// Two samples separated by less than this multiple of the median step are one
// instant, not two steps. Deliberately the same magnitude as the tolerance above:
// an interval too short to matter at the resolution where we still call the
// sampling uniform is also too short to be a sample of its own. A solver's event
// restart lands orders of magnitude below it (~1e-8 of the step in practice);
// a genuinely irregular series would have to hold steps six decades apart to be
// caught by it, and such a series reads as irregular either way.
export const TIME_AXIS_COINCIDENT_FACTOR = 1e-6;
// Upper bound on how many intervals are sorted to take the median. The eager pass
// runs inline while the sidebar renders, and sorting ten million doubles there
// would cost more than the whole rest of the diagnostic. Below this count the
// median is exact; above it, it is the median of an evenly strided sample of the
// same intervals, which for a robust central estimate is indistinguishable.
export const TIME_AXIS_MEDIAN_SAMPLE = 65536;

// Raw accumulator shared by the eager and lazy paths, in SOURCE units.
// `backwards`/`gaps` are null when that check has not run.
function emptyRaw() {
    return {
        nSamples: 0,
        tMin: NaN,
        tMax: NaN,
        intervals: 0,
        repeated: 0,
        backwards: null,
        dtMin: NaN,
        dtMax: NaN,
        dtMedian: NaN,
        gaps: null,
    };
}

// Median of the collected sample, in place. TypedArray.prototype.sort is numeric
// (no comparator needed, no string coercion) and the buffer is bounded by
// TIME_AXIS_MEDIAN_SAMPLE, so this is a few milliseconds at worst. The even case
// interpolates, matching DuckDB's median() so the two paths agree to the digit.
function medianOfSample(sample, count) {
    if (!sample || count <= 0) return NaN;
    const view = sample.subarray(0, count);
    view.sort();
    const mid = count >> 1;
    return count % 2 ? view[mid] : (view[mid - 1] + view[mid]) / 2;
}

// Scale the time-valued fields to seconds and derive the verdict.
// `secondsPerUnit`: 1 for a seconds axis, 1e-3 for epoch-milliseconds.
// `unitless`: a row-index axis has no time unit, so nothing is scaled and the
// values are reported as plain step counts.
//
// `verdict` is one of:
//   'equidistant'        — uniform spacing, nothing else to say
//   'equidistantRepeats' — uniform spacing plus repeated timestamps (events)
//   'irregular'          — the spacing itself varies, or time steps backwards
//   null                 — the step-level pass has not run (lazy phase 1, or
//                          cancelled); every count above it is still exact
export function finalizeTimeAxisDiagnostics(raw, options = {}) {
    const unitless = !!options.unitless;
    const scale = unitless ? 1 : (Number.isFinite(options.secondsPerUnit) && options.secondsPerUnit > 0
        ? options.secondsPerUnit
        : 1);
    const tolerance = Number.isFinite(options.tolerance) ? options.tolerance : TIME_AXIS_EQUIDISTANT_TOLERANCE;
    const scaled = value => (Number.isFinite(value) ? value * scale : NaN);

    const intervals = raw.intervals || 0;
    const repeated = raw.repeated || 0;
    // Intervals that actually advance time. The rest are the repeated timestamps.
    const steps = Math.max(0, intervals - repeated);
    const span = Number.isFinite(raw.tMax) && Number.isFinite(raw.tMin) ? raw.tMax - raw.tMin : NaN;
    // The mean is still span over the advancing intervals: what the excluded ones
    // contribute to the span is at most a millionth of a step each, by the very
    // rule that excluded them. Kept because phase 1 of the lazy path can report it
    // without any ordered walk — it is the only step figure available before the
    // median exists.
    const dtMean = steps > 0 && Number.isFinite(span) ? span / steps : NaN;
    const spread = Number.isFinite(raw.dtMax) && Number.isFinite(raw.dtMin) ? raw.dtMax - raw.dtMin : NaN;
    // Judge the spread against the median where there is one, and against the mean
    // in phase 1, where the answer is discarded anyway (no spread, no verdict).
    const reference = Math.abs(Number.isFinite(raw.dtMedian) ? raw.dtMedian : dtMean);
    const stepsKnown = Number.isFinite(spread);
    const uniform = stepsKnown
        && steps > 0
        && !raw.backwards
        && spread <= reference * tolerance;
    const verdict = !stepsKnown || steps === 0
        ? null
        : (uniform ? (repeated ? 'equidistantRepeats' : 'equidistant') : 'irregular');

    return {
        nSamples: raw.nSamples || 0,
        intervals,
        steps,
        tFirst: scaled(raw.tMin),
        tLast: scaled(raw.tMax),
        span: scaled(span),
        dtMin: scaled(raw.dtMin),
        dtMax: scaled(raw.dtMax),
        dtMean: scaled(dtMean),
        dtMedian: scaled(raw.dtMedian),
        repeated,
        backwards: raw.backwards,
        gaps: raw.gaps,
        verdict,
        unitless,
    };
}

// Eager path: two passes over the in-memory time vector, in FILE order.
//
// Two, not one, because every classification here is a ratio against the median
// and the median is not known until the vector has been walked once. Splitting it
// that way buys a single rule applied in a single place — the alternative, an
// approximate step guessed in pass 1 and patched afterwards, has two rules that
// can disagree. A linear scan of a Float64Array is a few milliseconds even at ten
// million samples, and the result is cached per file and transform.
export function computeTimeAxisDiagnostics(times, options = {}) {
    const gapFactor = Number.isFinite(options.gapFactor) ? options.gapFactor : TIME_AXIS_GAP_FACTOR;
    const coincidentFactor = Number.isFinite(options.coincidentFactor)
        ? options.coincidentFactor
        : TIME_AXIS_COINCIDENT_FACTOR;
    const source = times || [];
    const raw = emptyRaw();
    raw.backwards = 0;
    const length = source.length || 0;

    // ── Pass 1: bounds, and an evenly strided sample of the advancing intervals.
    // Nothing is classified yet. Only positive intervals are sampled: the median
    // stands for "the typical step forward", and a reversal is an anomaly to be
    // reported, not part of the step it should be measured against.
    const budget = Math.min(Math.max(0, length - 1), TIME_AXIS_MEDIAN_SAMPLE);
    const sample = budget > 0 ? new Float64Array(budget) : null;
    const stride = budget > 0 ? Math.ceil(Math.max(0, length - 1) / budget) : 1;
    let sampled = 0;
    let advancing = 0;
    let tMin = Infinity;
    let tMax = -Infinity;
    let previous = 0;
    let hasPrevious = false;
    for (let i = 0; i < length; i++) {
        const t = Number(source[i]);
        if (!Number.isFinite(t)) continue;
        raw.nSamples++;
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
        if (hasPrevious) {
            raw.intervals++;
            const dt = t - previous;
            if (dt > 0) {
                if (advancing % stride === 0 && sampled < budget) sample[sampled++] = dt;
                advancing++;
            }
        }
        previous = t;
        hasPrevious = true;
    }
    if (raw.nSamples) { raw.tMin = tMin; raw.tMax = tMax; }
    raw.dtMedian = medianOfSample(sample, sampled);

    // ── Pass 2: classify every interval against the median.
    // With no median (nothing advances time) the coincidence threshold collapses
    // to zero, which is exactly the older rule: only an exactly repeated timestamp
    // counts, and the verdict ends up null anyway.
    const coincident = Number.isFinite(raw.dtMedian) ? Math.abs(raw.dtMedian) * coincidentFactor : 0;
    const gapThreshold = Number.isFinite(raw.dtMedian) ? raw.dtMedian * gapFactor : NaN;
    let dtMin = Infinity;
    let dtMax = -Infinity;
    raw.gaps = 0;
    previous = 0;
    hasPrevious = false;
    for (let i = 0; i < length; i++) {
        const t = Number(source[i]);
        if (!Number.isFinite(t)) continue;
        if (hasPrevious) {
            const dt = t - previous;
            if (Math.abs(dt) <= coincident) {
                // Two samples at the same instant: their own category, never a Δt
                // near zero dragging the reported minimum (and the verdict) down.
                // A backwards nudge of that size is not time going backwards
                // either — it is the same event point, written imprecisely.
                raw.repeated++;
            } else {
                if (dt < 0) raw.backwards++;
                if (dt < dtMin) dtMin = dt;
                if (dt > dtMax) dtMax = dt;
                if (dt > gapThreshold) raw.gaps++;
            }
        }
        previous = t;
        hasPrevious = true;
    }
    if (raw.intervals - raw.repeated > 0) { raw.dtMin = dtMin; raw.dtMax = dtMax; }

    return finalizeTimeAxisDiagnostics(raw, options);
}

// ─── Lazy (DuckDB) path ───────────────────────────────────────────────────────
// Two queries on purpose. Phase 1 is a plain streaming aggregate — no sort, no
// window — and already answers "how many samples, over what span, with how many
// exactly repeated timestamps". Phase 2 walks consecutive steps, which needs
// ORDER BY, and is the expensive half the user can cancel while keeping phase 1's
// numbers. Phase 2 owns the median and therefore both thresholds derived from it,
// which is why nothing has to be handed back from phase 1 to build it.

const FINITE_FILTER = 't IS NOT NULL AND NOT isnan(t) AND NOT isinf(t)';

// `tExpr` may be a window function (generated-time files use ROW_NUMBER()), which
// cannot appear in a WHERE — hence the extra CTE instead of filtering in place.
export function buildTimeAxisSummarySql(tExpr, tableName) {
    return `
        WITH v AS (
            SELECT ${tExpr} AS t
            FROM ${tableName}
        )
        SELECT COUNT(*)::DOUBLE AS n,
               MIN(t)::DOUBLE AS t_min,
               MAX(t)::DOUBLE AS t_max,
               COUNT(DISTINCT t)::DOUBLE AS n_distinct
        FROM v
        WHERE ${FINITE_FILTER};
    `;
}

// `lit` is the caller's numeric literal formatter.
//
// The walk is sorted, so dt is never negative here and the classifications are
// plain comparisons against the median. `n_coincident` counts only the non-zero
// ones: exactly repeated timestamps already came out of phase 1 as
// COUNT(*) − COUNT(DISTINCT), and counting them twice would eat real steps.
// `coalesce(..., 0)` keeps a file whose timestamps are all identical (no median)
// from turning every comparison into NULL.
export function buildTimeAxisStepsSql(tExpr, tableName, lit, options = {}) {
    const gapFactor = Number.isFinite(options.gapFactor) ? options.gapFactor : TIME_AXIS_GAP_FACTOR;
    const coincidentFactor = Number.isFinite(options.coincidentFactor)
        ? options.coincidentFactor
        : TIME_AXIS_COINCIDENT_FACTOR;
    return `
        WITH v AS (
            SELECT ${tExpr} AS t
            FROM ${tableName}
        ),
        f AS (
            SELECT t FROM v WHERE ${FINITE_FILTER}
        ),
        d AS (
            SELECT t - LAG(t) OVER (ORDER BY t) AS dt
            FROM f
        ),
        s AS (
            SELECT dt FROM d WHERE dt IS NOT NULL
        ),
        m AS (
            SELECT median(dt) AS dt_median FROM s WHERE dt > 0
        ),
        c AS (
            SELECT dt, coalesce((SELECT dt_median FROM m), 0) AS med FROM s
        )
        SELECT (SELECT dt_median FROM m)::DOUBLE AS dt_median,
               MIN(dt) FILTER (WHERE dt > med * ${lit(coincidentFactor)})::DOUBLE AS dt_min,
               MAX(dt) FILTER (WHERE dt > med * ${lit(coincidentFactor)})::DOUBLE AS dt_max,
               COUNT(*) FILTER (WHERE dt <> 0 AND dt <= med * ${lit(coincidentFactor)})::DOUBLE AS n_coincident,
               COUNT(*) FILTER (WHERE dt > med * ${lit(gapFactor)})::DOUBLE AS n_gaps
        FROM c;
    `;
}

// Phase 1 row → raw accumulator. Duplicates come from COUNT(*) − COUNT(DISTINCT),
// which needs no ordering at all. `backwards` stays null: the sorted walk in
// phase 2 cannot see a time vector that steps backwards in file order.
export function rawFromTimeAxisSummary({ n, tMin, tMax, nDistinct }) {
    const raw = emptyRaw();
    raw.nSamples = Number.isFinite(n) ? n : 0;
    raw.tMin = Number(tMin);
    raw.tMax = Number(tMax);
    raw.intervals = Math.max(0, raw.nSamples - 1);
    raw.repeated = Number.isFinite(nDistinct) ? Math.max(0, raw.nSamples - nDistinct) : 0;
    return raw;
}

// Phase 2 row → the step-level fields merged onto the phase 1 accumulator.
// `coincident` are the near-zero intervals phase 1 could not see, so they add to
// the exactly repeated timestamps it did count.
export function mergeTimeAxisSteps(raw, { dtMin, dtMax, dtMedian, coincident, gaps }) {
    const extra = Number.isFinite(coincident) ? Math.max(0, coincident) : 0;
    // A NULL median (nothing advanced time) must stay NaN, not become Number(null).
    const median = dtMedian === null || dtMedian === undefined ? NaN : Number(dtMedian);
    return {
        ...raw,
        dtMin: Number(dtMin),
        dtMax: Number(dtMax),
        dtMedian: median,
        repeated: (raw.repeated || 0) + extra,
        gaps: Number.isFinite(gaps) ? gaps : 0,
    };
}
