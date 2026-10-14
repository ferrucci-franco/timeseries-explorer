// CF time coordinates in every calendar the conventions define.
//
// Standard calendars become epoch milliseconds, like every other time axis in
// the app. Model calendars (noleap, all_leap, 360_day, julian) cannot: "2050-02-30"
// is a real date in a 360_day run and no instant on the Gregorian calendar. For
// those the axis stays numeric (days since the file's own origin) and every step
// carries its label in its own calendar, so the slider still reads as dates.

import { cfTimeUnits } from '../parsers/netcdf-cf.js';

const MONTH_DAYS_365 = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_DAYS_366 = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const STANDARD = new Set(['standard', 'gregorian', 'proleptic_gregorian', 'none', '']);
const CALENDAR_ALIASES = {
    '365_day': 'noleap',
    noleap: 'noleap',
    '366_day': 'all_leap',
    all_leap: 'all_leap',
    '360_day': '360_day',
    julian: 'julian',
};

function pad(value, length = 2) {
    return String(value).padStart(length, '0');
}

function parseOrigin(text) {
    const match = String(text || '').trim().replace(/^(\d{1,4}-\d{1,2}-\d{1,2})_/, '$1T')
        .match(/^(-?\d{1,4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?)?/);
    if (!match) return null;
    const [, year, month, day, hour = '0', minute = '0', second = '0', fraction = ''] = match;
    return {
        year: Number(year), month: Number(month), day: Number(day),
        seconds: Number(hour) * 3600 + Number(minute) * 60 + Number(second) + (fraction ? Number(`0.${fraction}`) : 0),
    };
}

function isJulianLeap(year) {
    return year % 4 === 0;
}

function monthLengths(calendar, year) {
    if (calendar === 'noleap') return MONTH_DAYS_365;
    if (calendar === 'all_leap') return MONTH_DAYS_366;
    if (calendar === 'julian') return isJulianLeap(year) ? MONTH_DAYS_366 : MONTH_DAYS_365;
    return null;
}

function yearLength(calendar, year) {
    if (calendar === '360_day') return 360;
    if (calendar === 'noleap') return 365;
    if (calendar === 'all_leap') return 366;
    return isJulianLeap(year) ? 366 : 365;
}

// Days from 0001-01-01 of the given calendar to the date (fractional).
function toDayNumber(calendar, { year, month, day }) {
    if (calendar === '360_day') return (year - 1) * 360 + (month - 1) * 30 + (day - 1);
    let days = 0;
    if (calendar === 'noleap') days = (year - 1) * 365;
    else if (calendar === 'all_leap') days = (year - 1) * 366;
    else {
        const y = year - 1;
        days = y * 365 + Math.floor(y / 4);
    }
    const lengths = monthLengths(calendar, year);
    for (let m = 0; m < month - 1; m++) days += lengths[m];
    return days + (day - 1);
}

function fromDayNumber(calendar, dayNumber) {
    let remaining = Math.floor(dayNumber);
    let year = 1;
    if (calendar === '360_day') {
        year = Math.floor(remaining / 360) + 1;
        remaining -= (year - 1) * 360;
        return { year, month: Math.floor(remaining / 30) + 1, day: (remaining % 30) + 1 };
    }
    if (calendar === 'noleap' || calendar === 'all_leap') {
        const length = yearLength(calendar, 1);
        year = Math.floor(remaining / length) + 1;
        remaining -= (year - 1) * length;
    } else {
        const cycles = Math.floor(remaining / 1461);
        year = cycles * 4 + 1;
        remaining -= cycles * 1461;
        while (remaining >= yearLength(calendar, year)) {
            remaining -= yearLength(calendar, year);
            year += 1;
        }
    }
    const lengths = monthLengths(calendar, year);
    let month = 0;
    while (remaining >= lengths[month]) {
        remaining -= lengths[month];
        month += 1;
    }
    return { year, month: month + 1, day: remaining + 1 };
}

function label(date, secondsOfDay, withTime) {
    const base = `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)}`;
    if (!withTime) return base;
    const total = Math.round(secondsOfDay);
    return `${base} ${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}`;
}

export function normalizeCalendar(calendar) {
    const key = String(calendar || 'standard').trim().toLowerCase();
    if (STANDARD.has(key)) return 'standard';
    return CALENDAR_ALIASES[key] || 'standard';
}

/** "2024-01-01 06:00", or the date alone when every step falls at midnight. */
export function formatEpochLabel(milliseconds, withTime = true) {
    if (!Number.isFinite(milliseconds)) return '';
    const iso = new Date(milliseconds).toISOString();
    return withTime ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso.slice(0, 10);
}

/**
 * @param {ArrayLike<number|bigint>} rawValues the coordinate as stored
 * @param {string} units CF units, "<unit> since <origin>"
 * @param {string} calendar CF calendar attribute
 * @returns {{kind: 'datetime'|'calendar'|'numeric', values: Float64Array,
 *   labels: string[], calendar: string, unitsLabel: string}}
 *   `values` are epoch ms for 'datetime' and days since the origin for
 *   'calendar'; the raw numbers for 'numeric'.
 */
export function decodeCfTime(rawValues, units, calendar) {
    const numbers = Float64Array.from(rawValues, value => Number(value));
    const cf = cfTimeUnits(units);
    const normalized = normalizeCalendar(calendar);
    if (!cf) {
        return {
            kind: 'numeric', values: numbers, calendar: normalized, unitsLabel: String(units || ''),
            labels: Array.from(numbers, value => String(value)),
        };
    }
    if (normalized === 'standard') {
        const values = Float64Array.from(numbers, value => cf.originMs + value * cf.scaleMs);
        const withTime = Array.from(values).some(value => Number.isFinite(value) && value % 86400000 !== 0);
        return {
            kind: 'datetime', values, calendar: normalized, unitsLabel: '',
            labels: Array.from(values, value => formatEpochLabel(value, withTime)),
        };
    }
    const origin = parseOrigin(cf.originText);
    if (!origin) {
        return {
            kind: 'numeric', values: numbers, calendar: normalized, unitsLabel: String(units || ''),
            labels: Array.from(numbers, value => String(value)),
        };
    }
    const scaleDays = cf.scaleMs / 86400000;
    const originDays = toDayNumber(normalized, origin) + origin.seconds / 86400;
    const days = Float64Array.from(numbers, value => value * scaleDays);
    const absolute = Array.from(days, value => originDays + value);
    const withTime = absolute.some(value => Math.abs(value - Math.round(value)) > 1e-9);
    const labels = absolute.map(value => {
        const dayNumber = Math.floor(value + 1e-9);
        return label(fromDayNumber(normalized, dayNumber), (value - dayNumber) * 86400, withTime);
    });
    return {
        kind: 'calendar', values: days, calendar: normalized, labels,
        unitsLabel: `days since ${label(origin, origin.seconds, origin.seconds > 0)} (${normalized})`,
    };
}
