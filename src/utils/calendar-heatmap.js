// Pure calendar-heatmap kernel: no DOM, Plotly, locale APIs or DuckDB.
//
// All timestamps are epoch milliseconds and every boundary is UTC. The eager
// path consumes this module directly; the lazy path can feed the same sparse
// accumulator shape to densifyCalendarHeatmap so rendering and aggregation
// projection stay identical.

export const CALENDAR_HEATMAP_SOFT_CELLS = 250_000;
export const CALENDAR_HEATMAP_MAX_CELLS_WEB = 1_000_000;
export const CALENDAR_HEATMAP_MAX_CELLS_DESKTOP = 2_000_000;
export const CALENDAR_HEATMAP_RECOMPUTE_DEBOUNCE_MS = 150;
export const CALENDAR_HEATMAP_MANY_TRACES_WARNING = 6;

export const CALENDAR_HEATMAP_MODES = new Set(['week-day', 'day-hour']);
export const CALENDAR_HEATMAP_AGGREGATIONS = new Set(['mean', 'min', 'max', 'sum', 'count', 'integral']);

// A step longer than this many times the median step is a hole in the data, not
// a sample: integrating across it would invent area nobody measured. The cells
// it touches are reported as gaps instead of getting a plausible-looking value.
export const CALENDAR_HEATMAP_GAP_FACTOR = 1.5;
// The median step is estimated from at most this many consecutive steps.
const STEP_SAMPLE_LIMIT = 100_000;
// A gap can span an arbitrary stretch of calendar; stop marking its cells well
// before the dense grid limits would reject the figure anyway.
const MAX_GAP_CELLS = 200_000;

export const CALENDAR_HEATMAP_HOUR_MS = 60 * 60 * 1000;
export const CALENDAR_HEATMAP_DAY_MS = 24 * CALENDAR_HEATMAP_HOUR_MS;
export const CALENDAR_HEATMAP_WEEK_MS = 7 * CALENDAR_HEATMAP_DAY_MS;
export const CALENDAR_HEATMAP_MINUTE_MS = 60 * 1000;

// ── The height of a Day x hour row ─────────────────────────────────────────
//
// A row one hour tall on a file sampled every three hours draws two empty rows
// for every row of data: the grid says "no data" where the instrument was
// never going to write any. So the row follows the sampling step.
//
// A row must divide the day, or the rows of one column would not tile it, and
// the last row of each day would aggregate a shorter span than its neighbours
// — a lie the colour scale cannot show. These are the minute-counts that
// divide 1440.
export const CALENDAR_HEATMAP_ROW_MINUTES = [
    1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 16, 18, 20, 24, 30, 32, 36, 40, 45, 48,
    60, 72, 80, 90, 96, 120, 144, 160, 180, 240, 288, 360, 480, 720, 1440,
];
// What the automatic rule may choose: the whole hours that divide the day.
// Finer rows than an hour never remove a blank (an hour already holds every
// sub-hourly sample), so they are only ever asked for by hand.
export const CALENDAR_HEATMAP_AUTO_ROW_STEPS_MS = [1, 2, 3, 4, 6, 8, 12, 24]
    .map(hours => hours * CALENDAR_HEATMAP_HOUR_MS);

/**
 * The nearest row height that divides the day, in ms.
 *
 * Anything unusable (not a number, zero, longer than a day) becomes one hour,
 * the grid's historical row. A value between two divisors snaps to the closer
 * one, and ties go to the coarser: fewer, fuller rows.
 */
export function normalizeCalendarHeatmapRowStepMs(value) {
    const ms = Number(value);
    if (!Number.isFinite(ms) || ms <= 0) return CALENDAR_HEATMAP_HOUR_MS;
    if (ms >= CALENDAR_HEATMAP_DAY_MS) return CALENDAR_HEATMAP_DAY_MS;
    const minutes = ms / CALENDAR_HEATMAP_MINUTE_MS;
    let best = CALENDAR_HEATMAP_ROW_MINUTES[0];
    let bestDistance = Infinity;
    for (const candidate of CALENDAR_HEATMAP_ROW_MINUTES) {
        const distance = Math.abs(candidate - minutes);
        if (distance < bestDistance || (distance === bestDistance && candidate > best)) {
            best = candidate;
            bestDistance = distance;
        }
    }
    return best * CALENDAR_HEATMAP_MINUTE_MS;
}

/**
 * The counts the automatic row height is decided from: how many inter-sample
 * steps are no longer than each candidate row, and how many steps there are.
 *
 * Counters rather than a sorted median: the same eight numbers can be counted
 * in one pass here and by eight COUNT(...) FILTER in DuckDB
 * (_queryCalendarHeatmapAggregates), so a file read lazily and the same file
 * in memory always land on the same grid — no sorting, no sampling cap, and
 * no order dependence beyond the order the rows come in.
 */
export function createCalendarHeatmapStepCounts(cellMs = null) {
    return {
        n: 0,
        atMost: CALENDAR_HEATMAP_AUTO_ROW_STEPS_MS.map(() => 0),
        // Steps that fit inside a cell of a height known before counting (a
        // height given by hand, or the day of a Week x day cell). Where the
        // height is counted it is by construction the first one half the steps
        // fit in, so only the coarsest candidate can fail — atMost's last.
        cellMs: cellMs == null ? null : Number(cellMs),
        fit: 0,
    };
}

export function countCalendarHeatmapStep(counts, stepMs) {
    if (!(stepMs > 0)) return counts;
    counts.n++;
    for (let i = 0; i < CALENDAR_HEATMAP_AUTO_ROW_STEPS_MS.length; i++) {
        if (stepMs <= CALENDAR_HEATMAP_AUTO_ROW_STEPS_MS[i]) counts.atMost[i]++;
    }
    if (counts.cellMs != null && stepMs <= counts.cellMs) counts.fit++;
    return counts;
}

/**
 * Is the typical step longer than one cell? Then the grid cannot be filled:
 * cells the instrument was never going to write into stay empty, and the
 * picture is striped for a reason that is not in the data.
 */
export function calendarHeatmapSamplingIsCoarse(counts) {
    const total = Math.max(0, Number(counts?.n) || 0);
    if (!total) return false;
    const fit = counts.cellMs == null
        ? Number(counts.atMost?.[CALENDAR_HEATMAP_AUTO_ROW_STEPS_MS.length - 1]) || 0
        : Number(counts.fit) || 0;
    return fit * 2 < total;
}

/**
 * The automatic row height: the shortest candidate row that holds at least
 * half of the steps — the bucket the median step falls in.
 *
 * With a regular step every row then holds at least one sample, so no row of
 * the grid is empty for want of a finer instrument. With fewer than two
 * samples, or an irregular axis whose median step is under an hour, the row
 * stays the hour it has always been.
 */
export function chooseCalendarHeatmapRowStepMs(counts) {
    const total = Math.max(0, Number(counts?.n) || 0);
    if (!total) return CALENDAR_HEATMAP_HOUR_MS;
    const atMost = counts.atMost || [];
    for (let i = 0; i < CALENDAR_HEATMAP_AUTO_ROW_STEPS_MS.length; i++) {
        if ((Number(atMost[i]) || 0) * 2 >= total) return CALENDAR_HEATMAP_AUTO_ROW_STEPS_MS[i];
    }
    return CALENDAR_HEATMAP_DAY_MS;
}

/**
 * The clock time a Day x hour row starts at, as HH:MM.
 *
 * The row index alone says nothing once a row is not an hour: row 2 of a 3 h
 * grid starts at 06:00. Both the Y axis and the hover read the time from here
 * so they can never disagree.
 */
export function calendarHeatmapRowLabel(rowIndex, rowStepMs = CALENDAR_HEATMAP_HOUR_MS) {
    const step = normalizeCalendarHeatmapRowStepMs(rowStepMs);
    const offsetMs = (Number(rowIndex) || 0) * step;
    const minutes = Math.floor(offsetMs / CALENDAR_HEATMAP_MINUTE_MS);
    const hour = Math.floor(minutes / 60);
    return `${String(hour).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/** A row height written for a person: "3 h", "90 min", "24 h". */
export function formatCalendarHeatmapRowStep(rowStepMs) {
    const step = normalizeCalendarHeatmapRowStepMs(rowStepMs);
    if (step === CALENDAR_HEATMAP_DAY_MS) return '24 h';
    if (step % CALENDAR_HEATMAP_HOUR_MS === 0) return `${step / CALENDAR_HEATMAP_HOUR_MS} h`;
    return `${step / CALENDAR_HEATMAP_MINUTE_MS} min`;
}

// A row height for a mode: only Day x hour has one to choose. A week's rows
// are its seven days and nothing else divides a week into days.
function rowStepForMode(mode, rowStepMs) {
    if (mode === 'week-day') return CALENDAR_HEATMAP_DAY_MS;
    return normalizeCalendarHeatmapRowStepMs(rowStepMs);
}

// How much time one cell of the grid covers.
function cellDurationMs(mode, rowStepMs) {
    return mode === 'week-day' ? CALENDAR_HEATMAP_DAY_MS : rowStepForMode(mode, rowStepMs);
}

// ECMAScript Date's valid epoch range is +/- 100,000,000 days. Reject values
// outside it before doing calendar arithmetic so invalid dates never become
// misleading buckets.
const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

const isFiniteEpochMs = (value) => (
    typeof value === 'number'
    && Number.isFinite(value)
    && Math.abs(value) <= MAX_DATE_EPOCH_MS
);

const epochMs = (value) => {
    if (value instanceof Date) return value.getTime();
    return typeof value === 'number' ? value : NaN;
};

const positiveModulo = (value, divisor) => ((value % divisor) + divisor) % divisor;

const uniqueWarnings = (warnings) => [...new Set((warnings || []).filter(Boolean))];

function utcDateMs(year, month, day) {
    // Date.UTC treats years 0..99 as 1900..1999. setUTCFullYear does not.
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month, day);
    return date.getTime();
}

function normalizeCalendarMode(calendarMode) {
    return CALENDAR_HEATMAP_MODES.has(calendarMode) ? calendarMode : null;
}

function normalizeAggregation(aggregation) {
    return CALENDAR_HEATMAP_AGGREGATIONS.has(aggregation) ? aggregation : null;
}

function normalizeRange(rangeStart, rangeEnd) {
    const startMissing = rangeStart == null || rangeStart === '';
    const endMissing = rangeEnd == null || rangeEnd === '';
    if (startMissing && endMissing) {
        return { ok: true, active: false, startMs: null, endMs: null };
    }
    const start = epochMs(rangeStart);
    const end = epochMs(rangeEnd);
    if (startMissing || endMissing || !isFiniteEpochMs(start) || !isFiniteEpochMs(end)) {
        return { ok: false, reason: 'invalidRange' };
    }
    return {
        ok: true,
        active: true,
        startMs: Math.min(start, end),
        endMs: Math.max(start, end),
    };
}

function numericSample(value) {
    if (typeof value === 'boolean') return value ? 1 : 0;
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function floorUtcHour(timestampMs) {
    const value = epochMs(timestampMs);
    if (!isFiniteEpochMs(value)) return NaN;
    return Math.floor(value / CALENDAR_HEATMAP_HOUR_MS) * CALENDAR_HEATMAP_HOUR_MS;
}

export function floorUtcDay(timestampMs) {
    const value = epochMs(timestampMs);
    if (!isFiniteEpochMs(value)) return NaN;
    return Math.floor(value / CALENDAR_HEATMAP_DAY_MS) * CALENDAR_HEATMAP_DAY_MS;
}

function utcIsoDayParts(timestampMs) {
    const dayStartMs = floorUtcDay(timestampMs);
    if (!Number.isFinite(dayStartMs)) {
        return { dayStartMs: NaN, isoWeekday: NaN, weekStartMs: NaN };
    }
    const epochDay = Math.floor(dayStartMs / CALENDAR_HEATMAP_DAY_MS);
    const isoWeekday = positiveModulo(epochDay + 3, 7) + 1;
    const weekStartMs = dayStartMs - (isoWeekday - 1) * CALENDAR_HEATMAP_DAY_MS;
    return { dayStartMs, isoWeekday, weekStartMs };
}

export function getUtcIsoWeek(timestampMs) {
    const { dayStartMs, isoWeekday, weekStartMs } = utcIsoDayParts(timestampMs);
    if (!Number.isFinite(dayStartMs)) {
        return {
            isoYear: NaN,
            isoWeek: NaN,
            isoWeekday: NaN,
            dayStartMs: NaN,
            weekStartMs: NaN,
        };
    }

    const thursdayMs = weekStartMs + 3 * CALENDAR_HEATMAP_DAY_MS;
    const isoYear = new Date(thursdayMs).getUTCFullYear();
    const firstWeekStartMs = floorUtcIsoWeek(utcDateMs(isoYear, 0, 4));
    const isoWeek = Math.round((weekStartMs - firstWeekStartMs) / CALENDAR_HEATMAP_WEEK_MS) + 1;

    return { isoYear, isoWeek, isoWeekday, dayStartMs, weekStartMs };
}

export function floorUtcIsoWeek(timestampMs) {
    return utcIsoDayParts(timestampMs).weekStartMs;
}

export function formatUtcIsoWeek(timestampMs) {
    const { isoYear, isoWeek } = getUtcIsoWeek(timestampMs);
    if (!Number.isFinite(isoYear) || !Number.isFinite(isoWeek)) return '';
    const year = isoYear < 0
        ? `-${String(Math.abs(isoYear)).padStart(4, '0')}`
        : String(isoYear).padStart(4, '0');
    return `${year}-W${String(isoWeek).padStart(2, '0')}`;
}

function calendarHeatmapCellCore(value, mode, rowStepMs = CALENDAR_HEATMAP_HOUR_MS) {
    if (mode === 'week-day') {
        const iso = utcIsoDayParts(value);
        return {
            columnStartMs: iso.weekStartMs,
            bucketStartMs: iso.weekStartMs,
            rowIndex: iso.isoWeekday,
            cellStartMs: iso.dayStartMs,
            cellEndMs: iso.dayStartMs + CALENDAR_HEATMAP_DAY_MS,
            isoWeekday: iso.isoWeekday,
        };
    }

    const columnStartMs = floorUtcDay(value);
    const rowIndex = Math.floor((value - columnStartMs) / rowStepMs);
    const cellStartMs = columnStartMs + rowIndex * rowStepMs;
    return {
        columnStartMs,
        bucketStartMs: columnStartMs,
        rowIndex,
        cellStartMs,
        cellEndMs: cellStartMs + rowStepMs,
    };
}

export function getCalendarHeatmapCell(timestampMs, calendarMode = 'week-day', options = {}) {
    const value = epochMs(timestampMs);
    const mode = normalizeCalendarMode(calendarMode);
    if (!mode || !isFiniteEpochMs(value)) return null;
    const cell = calendarHeatmapCellCore(value, mode, rowStepForMode(mode, options.rowStepMs));
    if (mode !== 'week-day') return cell;
    const { isoYear, isoWeek } = getUtcIsoWeek(value);
    return { ...cell, isoYear, isoWeek };
}

function isPartialCell(cellStartMs, cellEndMs, range) {
    if (!range?.active) return false;
    return range.startMs > cellStartMs || range.endMs < cellEndMs;
}

function createAccumulator(cell, range) {
    return {
        columnStartMs: cell.columnStartMs,
        bucketStartMs: cell.columnStartMs,
        rowIndex: cell.rowIndex,
        cellStartMs: cell.cellStartMs,
        cellEndMs: cell.cellEndMs,
        nScope: 0,
        nFinite: 0,
        nInvalid: 0,
        sum: 0,
        mean: null,
        min: null,
        max: null,
        // Integral state: area in value·ms, how much of the cell the integrated
        // intervals actually cover, and how much of it falls inside a gap.
        integralMs: 0,
        coveredMs: 0,
        missingMs: 0,
        hasGap: false,
        integral: null,
        partial: isPartialCell(cell.cellStartMs, cell.cellEndMs, range),
    };
}

function accumulatorKey(columnStartMs, rowIndex) {
    return `${columnStartMs}:${rowIndex}`;
}

function medianOfSteps(steps) {
    if (!steps.length) return NaN;
    const sorted = steps.slice().sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2
        ? sorted[middle]
        : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Trapezoidal area of one inter-sample interval, split at every calendar
// boundary it crosses so no energy leaks into the neighbouring cell.
function integrateInterval(startMs, startValue, endMs, endValue, mode, ensure, rowStepMs) {
    const span = endMs - startMs;
    if (!(span > 0)) return;
    let segmentStartMs = startMs;
    let segmentStartValue = startValue;
    while (segmentStartMs < endMs) {
        const cell = calendarHeatmapCellCore(segmentStartMs, mode, rowStepMs);
        const segmentEndMs = Math.min(cell.cellEndMs, endMs);
        const segmentEndValue = startValue
            + (endValue - startValue) * ((segmentEndMs - startMs) / span);
        const accumulator = ensure(cell);
        const duration = segmentEndMs - segmentStartMs;
        accumulator.integralMs += ((segmentStartValue + segmentEndValue) / 2) * duration;
        accumulator.coveredMs += duration;
        segmentStartMs = segmentEndMs;
        segmentStartValue = segmentEndValue;
    }
}

// Every cell touched by a gap is flagged: its integral would be missing the
// data that is not there, so it is reported as a gap rather than as a value.
function markGapCells(startMs, endMs, mode, ensure, rowStepMs) {
    let cursorMs = startMs;
    let guard = 0;
    while (cursorMs < endMs && guard++ < MAX_GAP_CELLS) {
        const cell = calendarHeatmapCellCore(cursorMs, mode, rowStepMs);
        const overlapEndMs = Math.min(cell.cellEndMs, endMs);
        const accumulator = ensure(cell);
        accumulator.hasGap = true;
        accumulator.missingMs += overlapEndMs - cursorMs;
        cursorMs = overlapEndMs;
    }
    return guard >= MAX_GAP_CELLS;
}

// One-pass sparse aggregation for one trace. The selected range is closed
// ([rangeStart, rangeEnd]), matching the interaction cursors. Calendar cells
// themselves remain half-open [cellStartMs, cellEndMs).
export function aggregateCalendarHeatmap(options = {}) {
    const {
        times = [],
        values = [],
        calendarMode = 'week-day',
        rangeStart = null,
        rangeEnd = null,
        timeShiftMs = 0,
        rowStepMs = null,
    } = options;

    const mode = normalizeCalendarMode(calendarMode);
    if (!mode) return { ok: false, reason: 'invalidCalendarMode', warnings: [] };
    const range = normalizeRange(rangeStart, rangeEnd);
    if (!range.ok) return { ok: false, reason: range.reason, warnings: [] };
    const shift = Number(timeShiftMs);
    if (!Number.isFinite(shift)) return { ok: false, reason: 'invalidTimeShift', warnings: [] };

    const nTime = Number.isFinite(times?.length) ? Math.max(0, Math.trunc(times.length)) : 0;
    // The grid before any cell exists: a row cannot be filled until its height
    // is known. Asked for by hand, or counted from the axis in one pass that
    // touches the timestamps only (the same counts DuckDB makes, so the two
    // paths always agree) — see chooseCalendarHeatmapRowStepMs.
    const rowStepAuto = rowStepMs == null && mode !== 'week-day';
    const counts = createCalendarHeatmapStepCounts(
        rowStepAuto ? null : cellDurationMs(mode, rowStepMs),
    );
    let previousStepMs = null;
    for (let i = 0; i < nTime; i++) {
        const sourceTimeMs = epochMs(times[i]);
        const timestampMs = sourceTimeMs + shift;
        if (!isFiniteEpochMs(sourceTimeMs) || !isFiniteEpochMs(timestampMs)) continue;
        if (range.active && (timestampMs < range.startMs || timestampMs > range.endMs)) continue;
        if (previousStepMs != null) countCalendarHeatmapStep(counts, timestampMs - previousStepMs);
        previousStepMs = timestampMs;
    }
    const gridRowStepMs = rowStepAuto
        ? chooseCalendarHeatmapRowStepMs(counts)
        : rowStepForMode(mode, rowStepMs);
    const samplingIsCoarse = calendarHeatmapSamplingIsCoarse(counts);
    const nValues = Number.isFinite(values?.length) ? Math.max(0, Math.trunc(values.length)) : 0;
    const sparse = new Map();
    let nInvalidTimestamp = 0;
    let nOutOfRange = 0;
    let nScope = 0;
    let nFinite = 0;
    let minTimestampMs = Infinity;
    let maxTimestampMs = -Infinity;
    let aggregateOverflow = false;
    // Integration needs ordered pairs and a notion of the normal step, both
    // gathered here so the source arrays are never copied.
    const steps = [];
    let previousFiniteMs = null;
    let timeSorted = true;

    for (let i = 0; i < nTime; i++) {
        const sourceTimeMs = epochMs(times[i]);
        const timestampMs = sourceTimeMs + shift;
        if (!isFiniteEpochMs(sourceTimeMs) || !isFiniteEpochMs(timestampMs)) {
            nInvalidTimestamp++;
            continue;
        }
        if (range.active && (timestampMs < range.startMs || timestampMs > range.endMs)) {
            nOutOfRange++;
            continue;
        }

        // The hot path only needs column/row/bounds. ISO labels are derived
        // once per dense column rather than recalculating ISO year/week for
        // every source sample.
        const cell = calendarHeatmapCellCore(timestampMs, mode, gridRowStepMs);
        if (!cell) {
            nInvalidTimestamp++;
            continue;
        }
        const key = accumulatorKey(cell.columnStartMs, cell.rowIndex);
        let accumulator = sparse.get(key);
        if (!accumulator) {
            accumulator = createAccumulator(cell, range);
            sparse.set(key, accumulator);
        }

        accumulator.nScope++;
        nScope++;
        if (timestampMs < minTimestampMs) minTimestampMs = timestampMs;
        if (timestampMs > maxTimestampMs) maxTimestampMs = timestampMs;

        const sample = numericSample(values[i]);
        if (sample == null) {
            accumulator.nInvalid++;
            continue;
        }

        accumulator.nFinite++;
        nFinite++;
        if (previousFiniteMs != null) {
            const step = timestampMs - previousFiniteMs;
            if (step < 0) timeSorted = false;
            else if (step > 0 && steps.length < STEP_SAMPLE_LIMIT) steps.push(step);
        }
        previousFiniteMs = timestampMs;
        accumulator.sum += sample;
        // A weighted form of the online mean avoids overflowing merely from
        // adding two large finite samples whose true mean is still finite.
        accumulator.mean = accumulator.nFinite === 1
            ? sample
            : accumulator.mean * ((accumulator.nFinite - 1) / accumulator.nFinite)
                + sample / accumulator.nFinite;
        accumulator.min = accumulator.min == null ? sample : Math.min(accumulator.min, sample);
        accumulator.max = accumulator.max == null ? sample : Math.max(accumulator.max, sample);
        if (!Number.isFinite(accumulator.sum) || !Number.isFinite(accumulator.mean)) {
            aggregateOverflow = true;
        }
    }

    const warnings = [];
    const medianStepMs = medianOfSteps(steps);
    const gapThresholdMs = Number.isFinite(medianStepMs) && medianStepMs > 0
        ? medianStepMs * CALENDAR_HEATMAP_GAP_FACTOR
        : NaN;
    // Out-of-order timestamps would pair unrelated samples, so the integral is
    // withheld rather than guessed. Every other aggregation is order-agnostic.
    const integralAvailable = timeSorted && Number.isFinite(gapThresholdMs) && nFinite > 1;
    let gapCellsTruncated = false;

    if (integralAvailable) {
        const ensure = (cell) => {
            const key = accumulatorKey(cell.columnStartMs, cell.rowIndex);
            let accumulator = sparse.get(key);
            if (!accumulator) {
                accumulator = createAccumulator(cell, range);
                sparse.set(key, accumulator);
            }
            return accumulator;
        };
        let previousMs = null;
        let previousValue = null;
        for (let i = 0; i < nTime; i++) {
            const timestampMs = epochMs(times[i]) + shift;
            if (!isFiniteEpochMs(timestampMs)) continue;
            if (range.active && (timestampMs < range.startMs || timestampMs > range.endMs)) continue;
            const sample = numericSample(values[i]);
            if (sample == null) continue;
            if (previousMs != null && timestampMs > previousMs) {
                if (timestampMs - previousMs > gapThresholdMs) {
                    gapCellsTruncated = markGapCells(previousMs, timestampMs, mode, ensure, gridRowStepMs) || gapCellsTruncated;
                } else {
                    integrateInterval(previousMs, previousValue, timestampMs, sample, mode, ensure, gridRowStepMs);
                }
            }
            previousMs = timestampMs;
            previousValue = sample;
        }
    } else if (nFinite > 1) {
        warnings.push('integralUnavailable');
    }

    const accumulators = [...sparse.values()].sort((a, b) => (
        a.columnStartMs - b.columnStartMs || a.rowIndex - b.rowIndex
    ));
    let nGapCells = 0;
    for (const accumulator of accumulators) {
        accumulator.nInvalid = accumulator.nScope - accumulator.nFinite;
        // Match SQL SUM/AVG semantics and the empty-cell rule: an occupied
        // cell containing no finite values is still null, never a synthetic 0.
        if (accumulator.nFinite === 0) accumulator.sum = null;
        if (accumulator.hasGap) nGapCells++;
        // Accumulated in value·ms, reported in value·hours: a power in MW yields
        // energy in MWh.
        accumulator.integral = integralAvailable && accumulator.coveredMs > 0
            ? accumulator.integralMs / CALENDAR_HEATMAP_HOUR_MS
            : null;
        if (accumulator.integral != null && !Number.isFinite(accumulator.integral)) {
            accumulator.integral = null;
            aggregateOverflow = true;
        }
    }
    const nInvalid = nScope - nFinite;
    if (nTime !== nValues) warnings.push('unalignedData');
    if (nInvalidTimestamp > 0) warnings.push('invalidTimestamps');
    if (nScope > 0 && nFinite === 0) warnings.push('noFiniteValues');
    if (aggregateOverflow) warnings.push('aggregateOverflow');
    if (nGapCells > 0) warnings.push('dataGaps');
    if (gapCellsTruncated) warnings.push('gapCellsTruncated');
    // A cell shorter than the instrument's step cannot be filled: the grid
    // would draw holes the data was never going to cover. Said plainly rather
    // than left for the reader to infer from a striped picture.
    if (samplingIsCoarse) warnings.push('coarseSampling');

    return {
        ok: true,
        calendarMode: mode,
        rowStepMs: gridRowStepMs,
        rowStepAuto,
        timeZone: 'UTC',
        rangeStartMs: range.startMs,
        rangeEndMs: range.endMs,
        rangeActive: range.active,
        accumulators,
        // `cells` is intentionally the same sparse array. It mirrors the
        // planned DuckDB result vocabulary and makes lazy/eager parity simple.
        cells: accumulators,
        stats: {
            nTime,
            nValues,
            nAligned: Math.min(nTime, nValues),
            nInvalidTimestamp,
            nOutOfRange,
            nScope,
            nFinite,
            nInvalid,
            occupiedCells: accumulators.length,
            minTimestampMs: nScope ? minTimestampMs : null,
            maxTimestampMs: nScope ? maxTimestampMs : null,
            aggregateOverflow,
            unaligned: nTime !== nValues,
            medianStepMs: Number.isFinite(medianStepMs) ? medianStepMs : null,
            gapThresholdMs: Number.isFinite(gapThresholdMs) ? gapThresholdMs : null,
            integralAvailable,
            timeSorted,
            nGapCells,
        },
        warnings: uniqueWarnings(warnings),
    };
}

export function calendarHeatmapCellValue(cell, aggregation = 'mean') {
    const key = normalizeAggregation(aggregation);
    if (!key || !cell) return null;
    // The integral is defined by time coverage, not by whether a sample happens
    // to land inside the cell: an hour crossed by the line between two samples
    // has a real area even with nFinite === 0. So it is gated on the gap flag
    // and its own (coverage-derived) value, never on the sample count. A cell
    // touched by a gap is reported as a gap, never a misleading partial area.
    if (key === 'integral') {
        if (cell.hasGap === true || cell.integral == null) return null;
        const integral = Number(cell.integral);
        return Number.isFinite(integral) ? integral : null;
    }
    if (!(Number(cell.nFinite) > 0)) return null;
    const raw = key === 'count' ? cell.nFinite : cell[key];
    if (raw == null) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
}

export function getCalendarHeatmapGridShape(options = {}) {
    const mode = normalizeCalendarMode(options.calendarMode || 'week-day');
    if (!mode) return { ok: false, reason: 'invalidCalendarMode' };
    const start = epochMs(options.domainStart ?? options.domainStartMs);
    const end = epochMs(options.domainEnd ?? options.domainEndMs);
    if (!isFiniteEpochMs(start) || !isFiniteEpochMs(end)) {
        return { ok: false, reason: 'invalidDomain' };
    }
    const lo = Math.min(start, end);
    const hi = Math.max(start, end);
    const rowStepMs = rowStepForMode(mode, options.rowStepMs);
    const firstColumnStartMs = mode === 'week-day' ? floorUtcIsoWeek(lo) : floorUtcDay(lo);
    const lastColumnStartMs = mode === 'week-day' ? floorUtcIsoWeek(hi) : floorUtcDay(hi);
    const columnStepMs = mode === 'week-day' ? CALENDAR_HEATMAP_WEEK_MS : CALENDAR_HEATMAP_DAY_MS;
    const rowCount = mode === 'week-day' ? 7 : Math.round(CALENDAR_HEATMAP_DAY_MS / rowStepMs);
    const columnCount = Math.floor((lastColumnStartMs - firstColumnStartMs) / columnStepMs) + 1;
    if (!Number.isSafeInteger(columnCount) || columnCount < 1) {
        return { ok: false, reason: 'invalidDomain' };
    }
    return {
        ok: true,
        calendarMode: mode,
        domainStartMs: lo,
        domainEndMs: hi,
        firstColumnStartMs,
        lastColumnStartMs,
        columnStepMs,
        rowStepMs,
        columnCount,
        rowCount,
        cellsPerTrace: columnCount * rowCount,
    };
}

export function validateCalendarHeatmapCellLimit(options = {}) {
    const columns = Number(options.columns ?? options.columnCount);
    const rows = Number(options.rows ?? options.rowCount);
    const traceCountRaw = Number(options.traceCount ?? 1);
    if (!Number.isSafeInteger(columns) || columns < 1
        || !Number.isSafeInteger(rows) || rows < 1
        || !Number.isSafeInteger(traceCountRaw) || traceCountRaw < 1) {
        return { ok: false, reason: 'invalidGridShape' };
    }

    const limits = options.limits || {};
    const runtime = options.runtime === 'desktop' ? 'desktop' : 'web';
    const positiveLimit = (candidate, fallback) => {
        const value = Number(candidate);
        return Number.isSafeInteger(value) && value > 0 ? value : fallback;
    };
    const softLimit = positiveLimit(
        limits.softCells ?? options.softLimit,
        CALENDAR_HEATMAP_SOFT_CELLS,
    );
    const runtimeDefault = runtime === 'desktop'
        ? CALENDAR_HEATMAP_MAX_CELLS_DESKTOP
        : CALENDAR_HEATMAP_MAX_CELLS_WEB;
    const hardLimit = positiveLimit(
        limits.maxCells
            ?? options.maxCells
            ?? (runtime === 'desktop' ? limits.maxCellsDesktop : limits.maxCellsWeb),
        runtimeDefault,
    );
    const gridCells = columns * rows * traceCountRaw;
    const softExceeded = gridCells > softLimit;
    const hardExceeded = gridCells > hardLimit;
    return {
        ok: !hardExceeded,
        reason: hardExceeded ? 'cellLimit' : null,
        runtime,
        columns,
        rows,
        traceCount: traceCountRaw,
        gridCells,
        softLimit,
        hardLimit,
        softExceeded,
        hardExceeded,
    };
}

function resolveDenseSource(source) {
    if (Array.isArray(source)) {
        return {
            cells: source,
            calendarMode: null,
            rowStepMs: null,
            rowStepAuto: null,
            rangeActive: false,
            rangeStartMs: null,
            rangeEndMs: null,
            domainStartMs: null,
            domainEndMs: null,
            stats: null,
            warnings: [],
        };
    }
    if (!source || typeof source !== 'object') return null;
    const cells = source.accumulators || source.cells;
    if (!Array.isArray(cells)) return null;
    return {
        cells,
        calendarMode: source.calendarMode || source.meta?.calendarMode || null,
        rowStepMs: source.rowStepMs ?? source.meta?.rowStepMs ?? null,
        rowStepAuto: source.rowStepAuto ?? source.meta?.rowStepAuto ?? null,
        rangeActive: source.rangeActive ?? source.meta?.rangeActive ?? false,
        rangeStartMs: source.rangeStartMs ?? source.meta?.rangeStartMs ?? null,
        rangeEndMs: source.rangeEndMs ?? source.meta?.rangeEndMs ?? null,
        domainStartMs: source.domainStartMs ?? source.meta?.domainStartMs ?? null,
        domainEndMs: source.domainEndMs ?? source.meta?.domainEndMs ?? null,
        stats: source.stats || null,
        warnings: source.warnings || [],
    };
}

function naturalCellBounds(calendarMode, columnStartMs, rowIndex, rowStepMs = CALENDAR_HEATMAP_HOUR_MS) {
    const step = calendarMode === 'week-day' ? CALENDAR_HEATMAP_DAY_MS : rowStepMs;
    const offset = calendarMode === 'week-day' ? (rowIndex - 1) * step : rowIndex * step;
    const cellStartMs = columnStartMs + offset;
    return { cellStartMs, cellEndMs: cellStartMs + step };
}

// Convert sparse eager or lazy accumulators into Plotly-ready dense matrices.
// Limits are always checked before x/y/z/customdata arrays are allocated.
export function densifyCalendarHeatmap(source, options = {}) {
    const resolved = resolveDenseSource(source);
    if (!resolved) return { ok: false, reason: 'invalidSparseData', warnings: [] };
    const calendarMode = normalizeCalendarMode(options.calendarMode || resolved.calendarMode || 'week-day');
    if (!calendarMode) return { ok: false, reason: 'invalidCalendarMode', warnings: [] };
    const aggregation = normalizeAggregation(options.aggregation || 'mean');
    if (!aggregation) return { ok: false, reason: 'invalidAggregation', warnings: [] };
    // The cells were already bucketed by a row height; densifying with another
    // one would put them in the wrong rows, so the sparse source's own height
    // wins and the option is only the fallback for a bare array of cells.
    const rowStepMs = rowStepForMode(calendarMode, resolved.rowStepMs ?? options.rowStepMs);

    let domainStart = options.domainStart ?? options.domainStartMs;
    let domainEnd = options.domainEnd ?? options.domainEndMs;
    if (domainStart == null || domainEnd == null) {
        if (isFiniteEpochMs(resolved.domainStartMs) && isFiniteEpochMs(resolved.domainEndMs)) {
            domainStart = resolved.domainStartMs;
            domainEnd = resolved.domainEndMs;
        } else if (resolved.rangeActive && isFiniteEpochMs(resolved.rangeStartMs) && isFiniteEpochMs(resolved.rangeEndMs)) {
            domainStart = resolved.rangeStartMs;
            domainEnd = resolved.rangeEndMs;
        } else if (resolved.cells.length) {
            let minimum = Infinity;
            let maximum = -Infinity;
            for (const cell of resolved.cells) {
                const columnStartMs = Number(cell.columnStartMs ?? cell.bucketStartMs);
                const rowIndex = Number(cell.rowIndex);
                const natural = Number.isFinite(columnStartMs) && Number.isInteger(rowIndex)
                    ? naturalCellBounds(calendarMode, columnStartMs, rowIndex, rowStepMs)
                    : { cellStartMs: NaN, cellEndMs: NaN };
                const explicitStart = Number(cell.cellStartMs);
                const explicitEnd = Number(cell.cellEndMs);
                const start = Number.isFinite(explicitStart) ? explicitStart : natural.cellStartMs;
                const end = (Number.isFinite(explicitEnd) ? explicitEnd : natural.cellEndMs) - 1;
                if (Number.isFinite(start) && start < minimum) minimum = start;
                if (Number.isFinite(end) && end > maximum) maximum = end;
            }
            domainStart = minimum;
            domainEnd = maximum;
        }
    }
    const shape = getCalendarHeatmapGridShape({ calendarMode, domainStart, domainEnd, rowStepMs });
    if (!shape.ok) return { ...shape, warnings: uniqueWarnings(resolved.warnings) };
    const limit = validateCalendarHeatmapCellLimit({
        columns: shape.columnCount,
        rows: shape.rowCount,
        traceCount: options.traceCount ?? 1,
        runtime: options.runtime,
        limits: options.limits,
        softLimit: options.softLimit,
        maxCells: options.maxCells,
    });
    if (!limit.ok) {
        return {
            ok: false,
            reason: limit.reason,
            calendarMode,
            aggregation,
            limit,
            gridCells: limit.gridCells,
            meta: { ...shape, gridCells: limit.gridCells },
            warnings: uniqueWarnings(resolved.warnings),
        };
    }

    const x = Array.from(
        { length: shape.columnCount },
        (_, index) => shape.firstColumnStartMs + index * shape.columnStepMs,
    );
    // Week x day: ISO weekday 1..7. Day x hour: the row index, which is the
    // hour only while a row is an hour tall — the labels carry the clock time
    // (calendarHeatmapRowLabel), so a 3 h or a 15 min row needs no other axis.
    const y = calendarMode === 'week-day'
        ? Array.from({ length: 7 }, (_, index) => index + 1)
        : Array.from({ length: shape.rowCount }, (_, index) => index);
    const z = Array.from({ length: shape.rowCount }, () => Array(shape.columnCount).fill(null));
    const customdata = Array.from({ length: shape.rowCount }, () => Array(shape.columnCount).fill(null));
    const warnings = [...resolved.warnings];

    for (const cell of resolved.cells) {
        const columnStartMs = Number(cell.columnStartMs ?? cell.bucketStartMs);
        const rowIndex = Number(cell.rowIndex);
        const columnIndex = Math.round((columnStartMs - shape.firstColumnStartMs) / shape.columnStepMs);
        const rowOffset = calendarMode === 'week-day' ? rowIndex - 1 : rowIndex;
        if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= shape.columnCount
            || !Number.isInteger(rowOffset) || rowOffset < 0 || rowOffset >= shape.rowCount) {
            continue;
        }
        const bounds = naturalCellBounds(calendarMode, columnStartMs, rowIndex, rowStepMs);
        const nScope = Math.max(0, Number(cell.nScope) || 0);
        const nFinite = Math.max(0, Number(cell.nFinite) || 0);
        const nInvalid = Number.isFinite(Number(cell.nInvalid))
            ? Math.max(0, Number(cell.nInvalid))
            : Math.max(0, nScope - nFinite);
        const custom = {
            columnStartMs,
            bucketStartMs: columnStartMs,
            rowIndex,
            cellStartMs: Number.isFinite(Number(cell.cellStartMs)) ? Number(cell.cellStartMs) : bounds.cellStartMs,
            cellEndMs: Number.isFinite(Number(cell.cellEndMs)) ? Number(cell.cellEndMs) : bounds.cellEndMs,
            nScope,
            nFinite,
            nInvalid,
            sum: cell.sum == null ? null : Number(cell.sum),
            mean: cell.mean == null ? null : Number(cell.mean),
            min: cell.min == null ? null : Number(cell.min),
            max: cell.max == null ? null : Number(cell.max),
            integral: cell.integral == null ? null : Number(cell.integral),
            hasGap: cell.hasGap === true,
            coveredMs: Math.max(0, Number(cell.coveredMs) || 0),
            missingMs: Math.max(0, Number(cell.missingMs) || 0),
            partial: cell.partial === true || isPartialCell(
                bounds.cellStartMs,
                bounds.cellEndMs,
                {
                    active: resolved.rangeActive,
                    startMs: resolved.rangeStartMs,
                    endMs: resolved.rangeEndMs,
                },
            ),
        };
        const value = calendarHeatmapCellValue(custom, aggregation);
        // Under the integral a null is expected wherever the cell was not fully
        // covered by integrated intervals: gap cells and the domain-edge cell
        // whose sample has no following sample. Real overflow was already flagged
        // by the kernel, so only the value-based aggregations use this heuristic.
        if (aggregation !== 'integral' && custom.nFinite > 0 && value == null) {
            warnings.push('aggregateOverflow');
        }
        z[rowOffset][columnIndex] = value;
        customdata[rowOffset][columnIndex] = custom;
    }
    if (limit.softExceeded) warnings.push('softCellLimit');

    return {
        ok: true,
        x,
        y,
        z,
        customdata,
        accumulators: resolved.cells,
        stats: resolved.stats,
        meta: {
            calendarMode,
            aggregation,
            rowStepMs,
            rowStepAuto: resolved.rowStepAuto ?? null,
            timeZone: 'UTC',
            rangeActive: resolved.rangeActive,
            rangeStartMs: resolved.rangeStartMs,
            rangeEndMs: resolved.rangeEndMs,
            domainStartMs: shape.domainStartMs,
            domainEndMs: shape.domainEndMs,
            firstColumnStartMs: shape.firstColumnStartMs,
            lastColumnStartMs: shape.lastColumnStartMs,
            columnStepMs: shape.columnStepMs,
            columnCount: shape.columnCount,
            rowCount: shape.rowCount,
            cellsPerTrace: shape.cellsPerTrace,
            gridCells: limit.gridCells,
        },
        limit,
        gridCells: limit.gridCells,
        warnings: uniqueWarnings(warnings),
    };
}

// Convenience eager pipeline for one trace. Keeping aggregate + densify public
// lets callers switch mean/min/max/sum/count without reading source data again.
export function buildCalendarHeatmap(options = {}) {
    const calendarMode = options.calendarMode || 'week-day';
    const aggregation = options.aggregation || 'mean';
    const aggregate = aggregateCalendarHeatmap({
        times: options.times,
        values: options.values,
        calendarMode,
        rangeStart: options.rangeStart ?? options.rangeStartMs ?? null,
        rangeEnd: options.rangeEnd ?? options.rangeEndMs ?? null,
        timeShiftMs: options.timeShiftMs ?? 0,
        rowStepMs: options.rowStepMs ?? null,
    });
    if (!aggregate.ok) return aggregate;
    if (aggregate.stats.nScope === 0) {
        return {
            ...aggregate,
            ok: false,
            reason: 'noRows',
            meta: {
                calendarMode,
                aggregation,
                rowStepMs: aggregate.rowStepMs,
                rowStepAuto: aggregate.rowStepAuto,
                timeZone: 'UTC',
                rangeActive: aggregate.rangeActive,
                rangeStartMs: aggregate.rangeStartMs,
                rangeEndMs: aggregate.rangeEndMs,
            },
        };
    }
    const dense = densifyCalendarHeatmap(aggregate, {
        calendarMode,
        aggregation,
        domainStart: options.domainStart ?? options.domainStartMs,
        domainEnd: options.domainEnd ?? options.domainEndMs,
        traceCount: options.traceCount ?? 1,
        runtime: options.runtime,
        limits: options.limits,
        softLimit: options.softLimit,
        maxCells: options.maxCells,
    });
    if (!dense.ok) {
        return {
            ...dense,
            accumulators: aggregate.accumulators,
            stats: aggregate.stats,
            warnings: uniqueWarnings([...aggregate.warnings, ...(dense.warnings || [])]),
        };
    }
    return {
        ...dense,
        accumulators: aggregate.accumulators,
        stats: aggregate.stats,
        warnings: uniqueWarnings([...aggregate.warnings, ...dense.warnings]),
    };
}
