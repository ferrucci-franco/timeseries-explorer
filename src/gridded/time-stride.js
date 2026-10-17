// How far Play and the ◀ ▶ buttons move along a gridded time axis.
//
// One step of the file is an hour of ERA5: a year is 8760 steps, eighteen
// minutes at 8 steps a second. A stride of a day, a week or a month moves to
// the step that far ahead in time, found on the axis itself, so it holds for
// 3-hourly files, months of unequal length and axes with gaps. Axes that are
// not times (an index, a plain number) move by a number of steps instead.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Model calendars (noleap, 360_day...) are counted in days, not on the
// Gregorian calendar: a month and a year there are their mean lengths.
const MEAN_MONTH_DAYS = 365.2425 / 12;

const TIME_STRIDES = [
    { id: '1h', ms: HOUR },
    { id: '6h', ms: 6 * HOUR },
    { id: '1d', ms: DAY },
    { id: '1w', ms: 7 * DAY },
    { id: '1mo', months: 1 },
    { id: '1y', months: 12 },
];
const COUNT_STRIDES = [10, 100, 1000];

// Milliseconds per unit of the axis values: epoch ms for 'datetime', days for
// 'calendar'; null for an axis that is not a time.
function unitMs(axis) {
    if (axis?.kind === 'datetime') return 1;
    if (axis?.kind === 'calendar') return DAY;
    return null;
}

function increasing(values) {
    for (let index = 1; index < values.length; index++) if (!(values[index] > values[index - 1])) return false;
    return values.length > 1;
}

/** The typical spacing of the axis, in ms (the median gap), or null. */
export function axisSpacingMs(axis) {
    const unit = unitMs(axis);
    const values = axis?.values;
    if (!unit || !values || values.length < 2) return null;
    const gaps = [];
    for (let index = 1; index < values.length; index++) gaps.push(values[index] - values[index - 1]);
    gaps.sort((a, b) => a - b);
    return gaps[gaps.length >> 1] * unit;
}

function strideMs(stride) {
    return stride.ms ?? stride.months * MEAN_MONTH_DAYS * DAY;
}

/**
 * The strides the axis offers, first "one step of the file". Each is
 * { id, label: { key, n } }, the label for i18n: key 'step' | 'steps' |
 * 'minutes' | 'hours' | 'day' | 'days' | 'week' | 'month' | 'year'.
 */
export function strideOptions(axis) {
    const size = axis?.values?.length || axis?.size || 0;
    const options = [{ id: 'step', label: nativeLabel(axis) }];
    const spacing = axisSpacingMs(axis);
    if (spacing && increasing(axis.values)) {
        const values = axis.values;
        for (const stride of TIME_STRIDES) {
            // Only what is longer than one step, and fits once in the axis.
            const fits = strideTarget(axis, values[0], stride, 1) <= values[values.length - 1] + 1 / unitMs(axis);
            if (strideMs(stride) > spacing * 1.5 && fits) options.push({ id: stride.id, label: strideLabel(stride) });
        }
        return options;
    }
    for (const count of COUNT_STRIDES) {
        if (count < size) options.push({ id: `n${count}`, label: { key: 'steps', n: count } });
    }
    return options;
}

function strideLabel(stride) {
    if (stride.id === '1h') return { key: 'hours', n: 1 };
    if (stride.id === '6h') return { key: 'hours', n: 6 };
    if (stride.id === '1d') return { key: 'day', n: 1 };
    if (stride.id === '1w') return { key: 'week', n: 1 };
    if (stride.id === '1mo') return { key: 'month', n: 1 };
    return { key: 'year', n: 1 };
}

// One step of the file, said in time when the axis is regular enough to.
function nativeLabel(axis) {
    const spacing = axisSpacingMs(axis);
    if (!spacing) return { key: 'step', n: 1 };
    const whole = (unit, key, plural = key) => {
        const n = spacing / unit;
        return Math.abs(n - Math.round(n)) < 1e-6 && Math.round(n) >= 1 ? { key: Math.round(n) === 1 ? key : plural, n: Math.round(n) } : null;
    };
    if (spacing < HOUR) return whole(MINUTE, 'minutes') || { key: 'step', n: 1 };
    if (spacing < DAY) return whole(HOUR, 'hours') || { key: 'step', n: 1 };
    if (Math.abs(spacing - 7 * DAY) < 1e-6) return { key: 'week', n: 1 };
    if (spacing >= 28 * DAY && spacing <= 31 * DAY) return { key: 'month', n: 1 };
    if (spacing >= 365 * DAY && spacing <= 366 * DAY) return { key: 'year', n: 1 };
    return whole(DAY, 'day', 'days') || { key: 'step', n: 1 };
}

// The instant `months` calendar months from `ms` (epoch ms, UTC), the day of
// the month kept where the target month has it: 31 January + 1 month is
// 29 February, not 2 March.
function addMonths(ms, months) {
    const date = new Date(ms);
    const day = date.getUTCDate();
    const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1,
        date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(day, last));
    return target.getTime();
}

// The axis value one stride from `from`, in the axis's own units.
function strideTarget(axis, from, stride, step) {
    return stride.months && axis.kind === 'datetime'
        ? addMonths(from, step * stride.months)
        : from + (step * strideMs(stride)) / unitMs(axis);
}

/**
 * The index one stride from `index` in `direction` (+1 or -1), or -1 past
 * either end. Always moves at least one step.
 */
export function strideIndex(axis, index, strideId, direction = 1) {
    const values = axis?.values;
    const size = values?.length || axis?.size || 0;
    const step = direction < 0 ? -1 : 1;
    const plain = target => (target >= 0 && target < size ? target : -1);
    if (!strideId || strideId === 'step') return plain(index + step);
    if (strideId.startsWith('n')) return plain(index + step * Number(strideId.slice(1)));
    const stride = TIME_STRIDES.find(item => item.id === strideId);
    const unit = unitMs(axis);
    if (!stride || !unit || !increasing(values)) return plain(index + step);
    const to = strideTarget(axis, values[index], stride, step);
    // The first step at or after the target going forward, the last at or
    // before it going back; tolerant of rounding in the stored times.
    const tolerance = 1 / unit;
    if (step > 0) {
        let low = index + 1;
        let high = size;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (values[middle] >= to - tolerance) high = middle;
            else low = middle + 1;
        }
        return low < size ? low : -1;
    }
    let low = 0;
    let high = index;
    while (low < high) {
        const middle = (low + high) >> 1;
        if (values[middle] > to + tolerance) high = middle;
        else low = middle + 1;
    }
    return low - 1;
}
