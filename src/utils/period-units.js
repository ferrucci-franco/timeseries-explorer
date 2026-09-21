// Reading a period as a duration (#108).
//
// The spectrum's period axis is in seconds, which is the honest unit and the
// wrong label: a daily oscillation is 86400, a weekly one 604800, and a reader
// looking for either has to divide. Series that oscillate with the day, the
// week or the season are exactly the ones a period axis is for, so the axis can
// be read the other way — the same numbers, labelled in the units a calendar
// uses.
//
// Only the labels change. Everything the panel stores, exports and accepts
// typed in stays in seconds, because that is what the numbers are.

/** d, h and min are the SI-accepted symbols, and the same in every language. */
const UNITS = [
    { symbol: 'd', seconds: 86400 },
    { symbol: 'h', seconds: 3600 },
    { symbol: 'min', seconds: 60 },
    { symbol: 's', seconds: 1 },
    { symbol: 'ms', seconds: 1e-3 },
    { symbol: 'µs', seconds: 1e-6 },
    { symbol: 'ns', seconds: 1e-9 },
];

export const PERIOD_UNIT_MODES = ['seconds', 'calendar'];
export const PERIOD_UNIT_DEFAULT = 'seconds';

/** @param {string|undefined} raw @returns {'seconds'|'calendar'} */
export function normalizePeriodUnitMode(raw) {
    return PERIOD_UNIT_MODES.includes(raw) ? raw : PERIOD_UNIT_DEFAULT;
}

const trimNumber = (value, digits) => {
    const rounded = Number(Number(value).toPrecision(digits));
    return String(rounded);
};

/**
 * A duration in the largest unit that leaves it at or above one.
 *
 * 86400 is a day and says so; 108000 is 1.25 d, not 1 d 6 h, because a tick
 * label is read at a glance and a second unit doubles its width for a digit.
 *
 * @param {number} seconds
 * @param {{digits?: number}} [options]
 * @returns {string} '' when there is no duration to speak of
 */
export function formatPeriodDuration(seconds, { digits = 3, unitSymbol = null } = {}) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return '';
    const unit = UNITS.find(candidate => candidate.symbol === unitSymbol)
        || UNITS.find(candidate => value >= candidate.seconds)
        || UNITS[UNITS.length - 1];
    return `${trimNumber(value / unit.seconds, digits)} ${unit.symbol}`;
}

// Where a reader expects a tick: the round numbers of seconds, and then the
// ones a clock and a calendar are made of — a quarter of an hour, six hours,
// a week, a month. Below a second there is no calendar left, so it is decades
// of 1, 2 and 5 all the way down.
const CALENDAR_ANCHORS = [
    1, 2, 5, 10, 15, 30,
    60, 120, 300, 600, 900, 1800,
    3600, 7200, 10800, 21600, 43200,
    86400, 172800, 604800, 1209600,
    2592000, 7776000, 15552000, 31536000,
    63072000, 157680000, 315360000,
];

const decadeAnchors = () => {
    const values = [];
    for (let exponent = -9; exponent < 0; exponent += 1) {
        for (const step of [1, 2, 5]) values.push(step * (10 ** exponent));
    }
    return values;
};

const LADDER = [...decadeAnchors(), ...CALENDAR_ANCHORS].sort((a, b) => a - b);

// The ones a reader looks for first: one of each unit, and the decades below.
// An axis that has room for five labels should spend them on "1 h" and "1 d",
// not on "3 h" and "2 d" — which is what thinning the whole ladder by index
// did.
const PRIMARY = new Set([1, 60, 3600, 86400, 604800, 2592000, 31536000]);
for (let exponent = -9; exponent < 0; exponent += 1) PRIMARY.add(10 ** exponent);

/**
 * Tick positions for a period axis, in seconds.
 *
 * A zoom deep enough to fall between two anchors — inside one decade, say —
 * would leave the axis bare, so that case falls back to a log sweep of the
 * window itself. The labels are the same either way.
 *
 * @param {number} lo @param {number} hi both in seconds
 * @param {{maxTicks?: number}} [options]
 * @returns {number[]}
 */
export function periodTickValues(lo, hi, { maxTicks = 10 } = {}) {
    const from = Math.min(Number(lo), Number(hi));
    const to = Math.max(Number(lo), Number(hi));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= 0 || from === to) return [];
    const low = Math.max(from, 1e-12);
    const inside = LADDER.filter(value => value >= low && value <= to);
    if (inside.length < 3) {
        // Nothing round in this window: walk it in logarithmic steps instead.
        const logLo = Math.log10(low);
        const logHi = Math.log10(to);
        const steps = Math.max(3, Math.min(maxTicks, 6));
        const swept = [];
        for (let i = 0; i <= steps; i += 1) {
            const value = 10 ** (logLo + ((logHi - logLo) * i) / steps);
            swept.push(Number(value.toPrecision(3)));
        }
        return [...new Set(swept)].filter(value => value > 0);
    }

    const chosen = inside.filter(value => PRIMARY.has(value));
    const spare = inside.filter(value => !PRIMARY.has(value));
    const wanted = Math.min(maxTicks, Math.max(5, chosen.length));
    // Fill the widest gap first, so what is added spreads the labels out
    // rather than crowding one end of the axis.
    while (chosen.length < wanted && spare.length) {
        const edges = [Math.log10(low), ...chosen.map(Math.log10), Math.log10(to)].sort((a, b) => a - b);
        let gapMiddle = null;
        let widest = 0;
        for (let i = 1; i < edges.length; i += 1) {
            const gap = edges[i] - edges[i - 1];
            if (gap > widest) {
                widest = gap;
                gapMiddle = (edges[i] + edges[i - 1]) / 2;
            }
        }
        if (gapMiddle === null) break;
        let best = 0;
        for (let i = 1; i < spare.length; i += 1) {
            if (Math.abs(Math.log10(spare[i]) - gapMiddle) < Math.abs(Math.log10(spare[best]) - gapMiddle)) best = i;
        }
        chosen.push(spare.splice(best, 1)[0]);
    }
    return chosen.sort((a, b) => a - b);
}

/**
 * The labels for those positions.
 * @param {number[]} values @returns {string[]}
 */
export function periodTickText(values) {
    const list = (values || []).filter(value => Number(value) > 0);
    if (!list.length) return [];
    // A window narrower than a decade is one unit's worth of axis: labelling
    // 86400 as "1 d" between two "23 h" reads as a jump that is not there.
    const lo = Math.min(...list);
    const hi = Math.max(...list);
    // The unit of the middle of the window, not of either end: a window from
    // 19 to 25 hours reads in hours, and one from half a second to three reads
    // in seconds, while the end it was taken from would have said otherwise.
    const middle = Math.sqrt(lo * hi);
    const uniform = hi / lo < 10
        ? (UNITS.find(candidate => middle >= candidate.seconds) || UNITS[UNITS.length - 1]).symbol
        : null;
    return list.map(value => formatPeriodDuration(value, uniform ? { unitSymbol: uniform } : {}));
}
