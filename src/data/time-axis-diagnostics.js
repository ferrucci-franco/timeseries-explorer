// Pure, dependency-free diagnostics for a file's time axis, plus the SQL
// builders for the lazy (DuckDB) path. Kept out of DuckDbSource (which imports
// the Vite-only WASM engine) so it is unit-testable in Node.
//
// The question this answers: "is this series equidistant, and if not, where does
// it break?" — repeated timestamps (several samples at the same instant), gaps
// (missing samples), and time that goes backwards. Plotting Δt shows you *where*
// it breaks; this tells you *whether* it does, as a number.
//
// Everything is computed in ONE pass without sorting: N, first/last, min/mean/max
// Δt and the anomaly counts. The mean (not the median) is deliberate — a median
// needs a sort, which on tens of millions of samples costs more than the whole
// rest of the diagnostic.
//
// The Δt statistics deliberately EXCLUDE zero-length intervals. A Modelica result
// emits a duplicated timestamp at every event, so a perfectly uniform 1 ms run
// would otherwise report "Δt min 0 s" and read as irregular because of one benign
// event point. Repeated timestamps are their own reported category instead, and
// the verdict has three states rather than two. Excluding them costs nothing:
// zeros contribute nothing to the sum either, so the mean is still span divided
// by the number of non-zero intervals — no sort, no second pass.
//
// Eager files are scanned in FILE order, so a time vector that steps backwards is
// detected. The lazy path cannot: DuckDB runs with preserve_insertion_order=false,
// so the SQL walks the SORTED timeline and `backwards` stays null ("not checked")
// instead of being wrongly reported as zero.

// A Δt above this multiple of the mean counts as a gap. Matches the nominal-step
// heuristic the lazy missing-data bands already use.
export const TIME_AXIS_GAP_FACTOR = 1.5;
// Relative spread below which the sampling is called equidistant. Float time
// vectors accumulate ~1e-16 relative noise per sample, orders below this.
export const TIME_AXIS_EQUIDISTANT_TOLERANCE = 1e-6;

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
        gaps: null,
    };
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
    // Intervals that actually advance time. Zeros are the repeated timestamps.
    const steps = Math.max(0, intervals - repeated);
    const span = Number.isFinite(raw.tMax) && Number.isFinite(raw.tMin) ? raw.tMax - raw.tMin : NaN;
    // Zero-length intervals add nothing to the sum, so the mean over the
    // advancing intervals is just the span over their count — still no sort, and
    // eager and lazy agree on the definition.
    const dtMean = steps > 0 && Number.isFinite(span) ? span / steps : NaN;
    const spread = Number.isFinite(raw.dtMax) && Number.isFinite(raw.dtMin) ? raw.dtMax - raw.dtMin : NaN;
    const stepsKnown = Number.isFinite(spread);
    const uniform = stepsKnown
        && steps > 0
        && !raw.backwards
        && spread <= Math.abs(dtMean) * tolerance;
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
        repeated,
        backwards: raw.backwards,
        gaps: raw.gaps,
        verdict,
        unitless,
    };
}

// Eager path: one pass over the in-memory time vector, in FILE order.
export function computeTimeAxisDiagnostics(times, options = {}) {
    const gapFactor = Number.isFinite(options.gapFactor) ? options.gapFactor : TIME_AXIS_GAP_FACTOR;
    const source = times || [];
    const raw = emptyRaw();
    raw.backwards = 0;

    const length = source.length || 0;
    let previous = 0;
    let hasPrevious = false;
    let tMin = Infinity;
    let tMax = -Infinity;
    let dtMin = Infinity;
    let dtMax = -Infinity;
    // Δt values are needed twice (spread now, gap count against the mean after),
    // but keeping them would cost N doubles. Instead accumulate the extremes in
    // pass 1 and count gaps in a second pass only when there is spread to explain.
    for (let i = 0; i < length; i++) {
        const t = Number(source[i]);
        if (!Number.isFinite(t)) continue;
        raw.nSamples++;
        if (t < tMin) tMin = t;
        if (t > tMax) tMax = t;
        if (hasPrevious) {
            const dt = t - previous;
            raw.intervals++;
            if (dt === 0) {
                // A repeated timestamp is its own category, never a Δt of zero
                // dragging the reported minimum (and the verdict) down with it.
                raw.repeated++;
            } else {
                if (dt < 0) raw.backwards++;
                if (dt < dtMin) dtMin = dt;
                if (dt > dtMax) dtMax = dt;
            }
        }
        previous = t;
        hasPrevious = true;
    }
    if (raw.nSamples) { raw.tMin = tMin; raw.tMax = tMax; }
    const steps = raw.intervals - raw.repeated;
    if (steps > 0) { raw.dtMin = dtMin; raw.dtMax = dtMax; }

    raw.gaps = 0;
    const dtMean = steps > 0 ? (raw.tMax - raw.tMin) / steps : NaN;
    const threshold = Number.isFinite(dtMean) ? dtMean * gapFactor : NaN;
    if (Number.isFinite(threshold) && Number.isFinite(dtMax) && dtMax > threshold) {
        previous = 0;
        hasPrevious = false;
        for (let i = 0; i < length; i++) {
            const t = Number(source[i]);
            if (!Number.isFinite(t)) continue;
            if (hasPrevious && t - previous > threshold) raw.gaps++;
            previous = t;
            hasPrevious = true;
        }
    }
    return finalizeTimeAxisDiagnostics(raw, options);
}

// ─── Lazy (DuckDB) path ───────────────────────────────────────────────────────
// Two queries on purpose. Phase 1 is a plain streaming aggregate — no sort, no
// window — and already answers "how many samples, over what span, with how many
// repeated timestamps". Phase 2 walks consecutive steps, which needs ORDER BY,
// and is the expensive half the user can cancel while keeping phase 1's numbers.
// It skips dt = 0 for the same reason the eager pass does: repeated timestamps
// are already counted in phase 1 and must not drag the Δt range down to zero.

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

// `gapThreshold` comes from phase 1 (gapFactor × mean Δt) so this stays a single
// aggregate; `lit` is the caller's numeric literal formatter.
export function buildTimeAxisStepsSql(tExpr, tableName, gapThreshold, lit) {
    const threshold = Number.isFinite(gapThreshold) ? lit(gapThreshold) : 'NULL';
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
        )
        SELECT MIN(dt)::DOUBLE AS dt_min,
               MAX(dt)::DOUBLE AS dt_max,
               SUM(CASE WHEN ${threshold} IS NOT NULL AND dt > ${threshold} THEN 1 ELSE 0 END)::DOUBLE AS n_gaps
        FROM d
        WHERE dt IS NOT NULL AND dt <> 0;
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
export function mergeTimeAxisSteps(raw, { dtMin, dtMax, gaps }) {
    return {
        ...raw,
        dtMin: Number(dtMin),
        dtMax: Number(dtMax),
        gaps: Number.isFinite(gaps) ? gaps : 0,
    };
}
