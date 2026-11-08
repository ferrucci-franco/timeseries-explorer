// A CSV's time column as DuckDB SQL: the instant, in milliseconds since the
// epoch, that parseCsvTimeValue (src/parsers/csv-time-detection.js) reads
// from the same text. One module for both DuckDB readers, the browser's
// (duckdb-source.js) and the desktop converter's (csv-to-parquet-core.js).
//
// Every expression gives a DOUBLE or NULL and never fails on a cell it
// cannot read: a line of the file that is not data must not stop a query.
//
// Dates written with digits are taken apart with one regular expression and
// put together the way the JS reader does (Date.UTC of the parts), rather
// than matched against a list of strptime formats. That is what keeps the
// two readers equal on what strptime has no format for: two-digit years
// (70-99 are 19xx, as in JS), "3:00 a" and "1:45 PM", "24:00" for midnight
// at the end of a day, a UTC offset ("+02:00"), and a fraction after a
// comma. Each of these used to read differently, or not at all, in DuckDB.
import { csvMonthNameTable, customDatetimePatternInfo, dateSeparatorForStrategy } from '../parsers/csv-time-detection.js';

const MS_PER_DAY = 86400000;

function escapeSqlString(value) {
    return String(value ?? '').replace(/'/g, "''");
}

// A value computed once and named, for an expression that reads it many
// times: a lambda over a one-element list. Written out instead, the text and
// the regular expression ran once per mention, dozens of times per cell, and
// the time axis of a lazy file took five times as long to read.
let bindCount = 0;
function bind(value, body) {
    const name = `__omv_${(bindCount++).toString(36)}`;
    return `list_transform([${value}], lambda ${name}: ${body(name)})[1]`;
}

function defaultQuoteIdent(name) {
    return `"${String(name ?? '').replace(/"/g, '""')}"`;
}

// The cell as text, trimmed, and without a pair of quotes around it (a line
// that starts with a byte-order mark hides its quotes from the CSV reader).
function textSql(expr) {
    // No regular expression here: this runs on every row of every query.
    return bind(`trim(CAST(${expr} AS VARCHAR))`, t =>
        `(CASE WHEN left(${t}, 1) = '"' AND right(${t}, 1) = '"' AND length(${t}) > 1 THEN substr(${t}, 2, length(${t}) - 2) ELSE ${t} END)`);
}

// A strptime or cast result as the JS reader's milliseconds: rounded, as it
// rounds ".123999" to 124, and only for a year written with four digits;
// anything else (a two-digit year strptime reads as year 22) is left to the
// part-by-part reading.
function fastMsSql(timestamp) {
    // NULLIF keeps it to one strptime per cell and no lambda: a year before
    // 100 makes the CASE NULL.
    return `round(epoch_us(CASE WHEN year(${timestamp}) >= 100 THEN ${timestamp} END) / 1000.0)`;
}

// The parts as SQL integers (NULL when absent), from a regexp_extract struct.
function part(struct, name) {
    return `TRY_CAST(nullif(struct_extract(${struct}, '${name}'), '') AS BIGINT)`;
}

// Milliseconds of a fraction written after the seconds ("123", "5", "123456").
function fractionMsSql(struct, name) {
    const digits = `nullif(struct_extract(${struct}, '${name}'), '')`;
    return `coalesce(round(TRY_CAST('0.' || ${digits} AS DOUBLE) * 1000), 0)`;
}

// The hour on a 24-hour clock, from an hour and an optional meridiem letter;
// -1, which no instant has, for "13 PM" or "0 AM".
function hour24Sql(hour, meridiem) {
    return bind(`{'h': ${hour}, 'ap': coalesce(${meridiem}, '')}`, v => `(CASE WHEN ${v}.ap = '' THEN ${v}.h`
        + ` WHEN ${v}.h BETWEEN 1 AND 12 THEN (${v}.h % 12) + (CASE WHEN upper(${v}.ap) = 'P' THEN 12 ELSE 0 END)`
        + ' ELSE -1 END)');
}

function fullYearSql(year, digits) {
    // "22" is 2022 and "85" is 1985, as in the JS reader.
    return `(CASE WHEN length(${digits}) <= 2 THEN ${year} + (CASE WHEN ${year} >= 70 THEN 1900 ELSE 2000 END) ELSE ${year} END)`;
}

/**
 * The instant of a date and a time of day, as Date.UTC(y, mo - 1, d, H, Mi,
 * Se, Ms) - offset: NULL for a date that does not exist (30 February), an
 * hour past 24, or 24 with minutes. 24:00 is midnight at the end of the day.
 */
export function csvPartsToMsSql({ year, month, day, hour = '0', minute = '0', second = '0', ms = '0', offsetMinutes = '0' }) {
    const parts = `{'y': ${year}, 'mo': ${month}, 'd': ${day}, 'h': coalesce(${hour}, 0), 'mi': coalesce(${minute}, 0),`
        + ` 'se': coalesce(${second}, 0), 'ms': coalesce(${ms}, 0), 'tz': coalesce(${offsetMinutes}, 0)}`;
    return bind(parts, p => `(CASE WHEN ${p}.h BETWEEN 0 AND 24 AND ${p}.mi BETWEEN 0 AND 59 AND ${p}.se BETWEEN 0 AND 59`
        + ` AND (${p}.h < 24 OR (${p}.mi = 0 AND ${p}.se = 0 AND ${p}.ms = 0))`
        + ` THEN epoch_ms(try_strptime(printf('%04d-%02d-%02d', ${p}.y, ${p}.mo, ${p}.d), '%Y-%m-%d'))::DOUBLE`
        + ` + ${p}.h * 3600000 + ${p}.mi * 60000 + ${p}.se * 1000 + ${p}.ms - ${p}.tz * 60000`
        + ' END)');
}

const MERIDIEM = '(?:\\s*(?P<ap>[AaPp])\\.?(?:[Mm]\\.?)?)?';
const CLOCK = '(?:[T\\s]+(?P<H>\\d{1,2}):(?P<Mi>\\d{2})(?::(?P<S>\\d{2})(?:[.,](?P<F>\\d+))?)?' + MERIDIEM + ')?';
const OFFSET = '\\s?(?P<tz>Z|[+-]\\d{2}(?::?\\d{2})?)?';

function extractSql(text, pattern) {
    // Named groups become the struct's fields; RE2 writes them (?P<name>...).
    const names = [...pattern.matchAll(/\(\?P<([a-zA-Z]+)>/g)].map(m => `'${m[1]}'`);
    const plain = pattern.replace(/\(\?P<[a-zA-Z]+>/g, '(');
    return `regexp_extract(${text}, '${escapeSqlString(plain)}', [${names.join(', ')}])`;
}

// Minutes east of UTC of "Z", "+02", "+0200" or "-03:30", or NULL.
function offsetMinutesSql(struct) {
    return bind(`nullif(struct_extract(${struct}, 'tz'), '')`, tz => {
        const digits = `replace(${tz}, ':', '')`;
        return `(CASE WHEN ${tz} IS NULL OR upper(${tz}) = 'Z' THEN 0`
            + ` ELSE (CASE WHEN left(${tz}, 1) = '-' THEN -1 ELSE 1 END)`
            + ` * (TRY_CAST(substr(${digits}, 2, 2) AS BIGINT) * 60`
            + ` + (CASE WHEN length(${digits}) >= 5 THEN TRY_CAST(substr(${digits}, 4, 2) AS BIGINT) ELSE 0 END))`
            + ' END)';
    });
}

/** "2024-01-05 07:05:22,123+01:00" and every shape parseIsoMs reads. */
export function csvIsoDateTimeSql(expr, format = {}) {
    // Most cells are "2024-01-05 07:05:22": DuckDB's own cast reads them,
    // straight from the column and with no lambda, and only the others pay
    // for the parts. Not a cell with an offset, which the cast would ignore,
    // nor a comma before the fraction: when the sample showed neither
    // (timezone 'floating'), no cell is looked at for them, which halves the
    // time of a query on a large file.
    const raw = `CAST(${expr} AS VARCHAR)`;
    const plain = format?.timezone === 'floating' && !format?.fractionComma;
    const offsetOrComma = `(${raw} LIKE '%+%' OR ${raw} LIKE '%:%-%' OR ${raw} ILIKE '%z' OR ${raw} LIKE '%,%')`;
    const cast = `round(epoch_us(TRY_CAST(${raw} AS TIMESTAMP)) / 1000.0)`;
    const fast = plain ? cast : `(CASE WHEN NOT ${offsetOrComma} THEN ${cast} END)`;
    return `coalesce(${fast}, ${bind(textSql(expr), text => isoFromTextSql(text))})`;
}

function isoFromTextSql(text) {
    const pattern = '^(?P<y>\\d{4})-(?P<mo>\\d{1,2})-(?P<d>\\d{1,2})'
        + '(?:[T ](?P<H>\\d{1,2}):(?P<Mi>\\d{2})(?::(?P<S>\\d{2})(?:[.,](?P<F>\\d+))?)?' + OFFSET + ')?$';
    return bind(extractSql(text, pattern), m => csvPartsToMsSql({
        year: part(m, 'y'), month: part(m, 'mo'), day: part(m, 'd'),
        hour: part(m, 'H'), minute: part(m, 'Mi'), second: part(m, 'S'),
        ms: fractionMsSql(m, 'F'), offsetMinutes: offsetMinutesSql(m),
    }));
}

// Which captured number is the year, the month and the day.
function ymdSql(m, order) {
    const a = part(m, 'a');
    const b = part(m, 'b');
    const c = part(m, 'c');
    const aDigits = `struct_extract(${m}, 'a')`;
    const cDigits = `struct_extract(${m}, 'c')`;
    // A four-digit first number is a year whatever the order says.
    const ymd = `(${order === 'YMD' ? 'TRUE' : `length(${aDigits}) = 4`})`;
    const dayFirst = order === 'DMY';
    return {
        year: `(CASE WHEN ${ymd} THEN ${fullYearSql(a, aDigits)} ELSE ${fullYearSql(c, cDigits)} END)`,
        month: `(CASE WHEN ${ymd} THEN ${b} ELSE ${dayFirst ? b : a} END)`,
        day: `(CASE WHEN ${ymd} THEN ${c} ELSE ${dayFirst ? a : b} END)`,
    };
}

function separatorClass(sep) {
    return sep === '.' ? '\\.' : sep === '-' ? '-' : '/';
}

/** "31/01/24 1:45 PM", "2024.01.31 13:45:00,5": parseFlexibleDateMs. */
// The strptime formats of a date in the given order with a four-digit year,
// with and without a 24-hour clock: what nearly every row is written in.
function commonFormats(order, sep) {
    const date = order === 'DMY' ? `%d${sep}%m${sep}%Y` : order === 'MDY' ? `%m${sep}%d${sep}%Y` : `%Y${sep}%m${sep}%d`;
    return [`${date} %H:%M:%S`, `${date} %H:%M`, date, `${date} %H:%M:%S.%f`];
}

export function csvNumericDateTimeSql(expr, order = 'YMD', sep = '/') {
    const s = separatorClass(sep);
    const fast = fastMsSql(tryStrptimeTimestampSql(`CAST(${expr} AS VARCHAR)`, commonFormats(order, sep)));
    return `coalesce(${fast}, ` + bind(textSql(expr), text => {
        return bind(extractSql(text, `^(?P<a>\\d{1,4})${s}(?P<b>\\d{1,2})${s}(?P<c>\\d{1,4})${CLOCK}$`), m => {
            const { year, month, day } = ymdSql(m, order);
            return csvPartsToMsSql({
                year, month, day,
                hour: hour24Sql(part(m, 'H'), `struct_extract(${m}, 'ap')`),
                minute: part(m, 'Mi'), second: part(m, 'S'), ms: fractionMsSql(m, 'F'),
            });
        });
    }) + ')';
}

/** "01/31 13:45" with no year: parseYearlessDateTimeMs (2001). */
export function csvYearlessDateTimeSql(expr, order = 'MDY') {
    const pattern = '^(?P<a>\\d{1,2})[/-](?P<b>\\d{1,2})[T\\s]+(?P<H>\\d{1,2}):(?P<Mi>\\d{2})'
        + '(?::(?P<S>\\d{2})(?:[.,](?P<F>\\d+))?)?' + MERIDIEM + '$';
    return bind(extractSql(textSql(expr), pattern), m => {
        const a = part(m, 'a');
        const b = part(m, 'b');
        return csvPartsToMsSql({
            year: '2001', month: order === 'DMY' ? b : a, day: order === 'DMY' ? a : b,
            hour: hour24Sql(part(m, 'H'), `struct_extract(${m}, 'ap')`),
            minute: part(m, 'Mi'), second: part(m, 'S'), ms: fractionMsSql(m, 'F'),
        });
    });
}

// The month names of every language the JS reader knows, replaced by the
// English abbreviation strptime's %b reads, whole words only: "mar" in
// "marzo" is the same month, but "set" or "ago" inside another word is not.
export function csvNormalizedMonthNameSql(expr) {
    // The dot of an abbreviation goes ("janv.", "Sept."); the one between
    // seconds and their fraction stays.
    let sql = `regexp_replace(lower(strip_accents(CAST(${expr} AS VARCHAR))), '([a-z])\\.', '\\1', 'g')`;
    const english = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    for (const [month, names] of csvMonthNameTable()) {
        const target = english[month - 1];
        const words = names.filter(name => name !== target).sort((x, y) => y.length - x.length);
        if (!words.length) continue;
        sql = `regexp_replace(${sql}, '\\b(${words.map(escapeSqlString).join('|')})\\b', '${target}', 'g')`;
    }
    // "15 de enero de 2024": the Spanish and Portuguese "de" joins the parts.
    return `regexp_replace(${sql}, '\\s+de\\s+', ' ', 'g')`;
}

const MONTH_NAME_FORMATS = [
    '%d-%b-%Y %H:%M:%S.%f', '%d-%b-%Y %H:%M:%S', '%d-%b-%Y %H:%M', '%d-%b-%Y',
    '%d %b %Y %H:%M:%S.%f', '%d %b %Y %H:%M:%S', '%d %b %Y %H:%M', '%d %b %Y',
    '%d %b, %Y %H:%M:%S', '%d %b, %Y %H:%M', '%d %b, %Y',
    '%b %d %Y %H:%M:%S.%f', '%b %d %Y %H:%M:%S', '%b %d %Y %H:%M', '%b %d %Y',
    '%b %d, %Y %H:%M:%S', '%b %d, %Y %H:%M', '%b %d, %Y',
    '%b %d %H:%M:%S %Y', '%b-%d-%Y', '%Y-%b-%d %H:%M:%S', '%Y-%b-%d',
];

// A strptime result whose year was written with two digits ("15-Jan-24"
// reads as year 24) moved to the century the JS reader gives it.
function centuryFixedSql(timestamp) {
    return bind(timestamp, ts => `(CASE WHEN year(${ts}) < 100 THEN ${ts} + to_years(CASE WHEN year(${ts}) >= 70 THEN 1900 ELSE 2000 END) ELSE ${ts} END)`);
}

function tryStrptimeTimestampSql(expr, formats) {
    return `try_strptime(${expr}, [${formats.map(f => `'${escapeSqlString(f)}'`).join(', ')}])`;
}

/** "09-Janvier-2024 07:05:08", "Mon, 15 Jan 2024 10:00": parseMonthNameDateMs. */
export function csvMonthNameDateSql(expr) {
    const months = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
    return bind(csvNormalizedMonthNameSql(textSql(expr)), normalized =>
        // A weekday in front ("lundi 1 janvier", "Mon, 15 Jan") names nothing new.
        bind(`(CASE WHEN regexp_matches(${normalized}, '^(${months})\\b') THEN ${normalized}`
            + ` ELSE regexp_replace(${normalized}, '^[a-z]{2,14},?\\s+([0-9]|${months})', '\\1') END)`, text => {
            // A trailing UTC offset ("+0100"), taken off and applied after.
            const m = extractSql(text, '(?P<tz>[+-]\\d{2}:?\\d{2})$');
            const bare = `trim(regexp_replace(${text}, '\\s*(?:[+-]\\d{2}:?\\d{2}|z|utc|gmt)$', ''))`;
            const timestamp = tryStrptimeTimestampSql(bare, MONTH_NAME_FORMATS);
            return `(epoch_ms(${centuryFixedSql(timestamp)})::DOUBLE - ${offsetMinutesSql(m)} * 60000)`;
        }));
}

/** A date column and a time-of-day column: combineDateAndTimeMs. */
export function csvSplitDateTimeSql(dateExpr, timeExpr, format = {}) {
    const order = format?.dateOrder || 'YMD';
    const sep = format?.dotSeparator ? '.' : format?.dashSeparator ? '-' : '/';
    const timePattern = '^(?P<H>\\d{1,2}):(?P<Mi>\\d{2})(?::(?P<S>\\d{2})(?:[.,](?P<F>\\d+))?)?' + MERIDIEM + '$';
    const datePattern = '^(?P<a>\\d{1,4})[./-](?P<b>\\d{1,4})(?:[./-](?P<c>\\d{1,4}))?$';
    const slow = bind(`{'date': ${textSql(dateExpr)}, 'time': ${textSql(timeExpr)}}`, cells => {
        const dateText = `${cells}.date`;
        const timeText = `${cells}.time`;
        // An empty time is midnight; a time that does not read is no instant.
        const clockOf = t => ({
            hour: `(CASE WHEN ${timeText} = '' THEN 0 ELSE coalesce(${hour24Sql(part(t, 'H'), `struct_extract(${t}, 'ap')`)}, -1) END)`,
            minute: `(CASE WHEN ${timeText} = '' THEN 0 ELSE coalesce(${part(t, 'Mi')}, -1) END)`,
            second: `coalesce(${part(t, 'S')}, 0)`,
            ms: fractionMsSql(t, 'F'),
        });
        return bind(`{'t': ${extractSql(timeText, timePattern)}, 'd': ${extractSql(dateText, datePattern)}}`, x => {
            const clock = clockOf(`${x}.t`);
            const d = `${x}.d`;
            const monthName = `(epoch_ms(${centuryFixedSql(tryStrptimeTimestampSql(csvNormalizedMonthNameSql(dateText), MONTH_NAME_FORMATS))})::DOUBLE`
                + ` + ${clock.hour} * 3600000 + ${clock.minute} * 60000 + ${clock.second} * 1000 + ${clock.ms})`;
            // "31/01/2024", or a date without its year or day ("2024-01", "01/31").
            const full = ymdSql(d, order);
            const a = part(d, 'a');
            const b = part(d, 'b');
            const hasDay = `struct_extract(${d}, 'c') <> ''`;
            const yearFirst = `(length(struct_extract(${d}, 'a')) = 4 OR ${order === 'YMD' ? 'TRUE' : 'FALSE'})`;
            const dayFirst = order === 'DMY' ? 'TRUE' : 'FALSE';
            const numeric = csvPartsToMsSql({
                year: `(CASE WHEN ${hasDay} THEN ${full.year} WHEN ${yearFirst} THEN ${a} ELSE 2001 END)`,
                month: `(CASE WHEN ${hasDay} THEN ${full.month} WHEN ${yearFirst} THEN ${b} WHEN ${dayFirst} THEN ${b} ELSE ${a} END)`,
                day: `(CASE WHEN ${hasDay} THEN ${full.day} WHEN ${yearFirst} THEN 1 WHEN ${dayFirst} THEN ${a} ELSE ${b} END)`,
                ...clock,
            });
            return format?.monthName ? `coalesce(${monthName}, ${numeric})` : `coalesce(${numeric}, ${monthName})`;
        });
    });
    if (format?.monthName) return slow;
    const fast = fastMsSql(tryStrptimeTimestampSql(`CAST(${dateExpr} AS VARCHAR) || ' ' || CAST(${timeExpr} AS VARCHAR)`, commonFormats(order, sep)));
    return `coalesce(${fast}, ${slow})`;
}

/** Year, month, day, hour, minute and second each in a column of its own. */
export function csvPartsDateTimeSql(timeSource, sourceNames, { quoteIdent = defaultQuoteIdent, numericCastSql = null } = {}) {
    const sourceIndexes = timeSource.sourceIndexes || [];
    const parts = timeSource.format?.parts || {};
    const cast = numericCastSql || (expr => `TRY_CAST(${expr} AS DOUBLE)`);
    const value = (name, fallback) => {
        const sourceOffset = sourceIndexes.indexOf(parts[name]);
        if (sourceOffset < 0 || !sourceNames[sourceOffset]) return fallback;
        return cast(quoteIdent(sourceNames[sourceOffset]));
    };
    const seconds = value('second', '0');
    const whole = (expr) => `TRY_CAST(${expr} AS BIGINT)`;
    let year = whole(value('year', '2001'));
    year = `(CASE WHEN ${year} < 100 THEN ${year} + (CASE WHEN ${year} >= 70 THEN 1900 ELSE 2000 END) ELSE ${year} END)`;
    return csvPartsToMsSql({
        year,
        month: whole(value('month', '1')),
        day: whole(value('day', '1')),
        hour: whole(value('hour', '0')),
        minute: whole(value('minute', '0')),
        second: `TRY_CAST(floor(${seconds}) AS BIGINT)`,
        ms: `round((${seconds} - floor(${seconds})) * 1000)`,
    });
}

/** A date written to the user's own pattern (the dialog's Custom). */
export function csvCustomFormatSql(expr, pattern) {
    const info = customDatetimePatternInfo(pattern);
    if (!info?.format) return null;
    let valueExpr = textSql(expr);
    if (info.hasWeekday) valueExpr = `regexp_replace(${valueExpr}, '^[\\p{L}-]{2,14}\\.?,?\\s+', '')`;
    if (info.valuePrefix) valueExpr = `'${escapeSqlString(info.valuePrefix)}' || ${valueExpr}`;
    if (info.valueSuffix) valueExpr = `${valueExpr} || '${escapeSqlString(info.valueSuffix)}'`;
    if (info.hasMonthName) valueExpr = csvNormalizedMonthNameSql(valueExpr);
    return `epoch_ms(try_strptime(${valueExpr}, '${escapeSqlString(info.format)}'))::DOUBLE`;
}

function decimalYearSql(numeric) {
    const value = `(${numeric})::DOUBLE`;
    const year = `floor(${value})`;
    const leap = `((${year} % 4 = 0 AND ${year} % 100 <> 0) OR ${year} % 400 = 0)`;
    return `(epoch_ms(try_strptime(printf('%04d-01-01', TRY_CAST(${year} AS BIGINT)), '%Y-%m-%d'))::DOUBLE`
        + ` + (${value} - ${year}) * CASE WHEN ${leap} THEN 366 ELSE 365 END * ${MS_PER_DAY})`;
}

/**
 * The time axis of a CSV profile's datetime column as SQL, or null when the
 * strategy has no SQL form.
 *
 * @param {object} timeSource the profile's timeSource
 * @param {string[]} sourceNames the file's names of its source columns
 * @param {{ quoteIdent?: Function, numericCastSql?: Function, firstType?: string }} [options]
 */
export function csvDatetimeSql(timeSource, sourceNames, options = {}) {
    const quoteIdent = options.quoteIdent || defaultQuoteIdent;
    const cast = options.numericCastSql || (expr => `TRY_CAST(${expr} AS DOUBLE)`);
    const first = quoteIdent(sourceNames[0]);
    if (/TIMESTAMP|DATE|TIME/.test(options.firstType || '')) return `epoch_ms(${first})::DOUBLE`;
    const strategy = timeSource.strategy;
    const order = timeSource.format?.dateOrder || 'YMD';
    if (strategy === 'excel-serial') return `((${cast(first)} - 25569) * ${MS_PER_DAY})`;
    if (strategy === 'matlab-datenum') return `((${cast(first)} - 719529) * ${MS_PER_DAY})`;
    if (strategy === 'decimal-year') return decimalYearSql(cast(first));
    if (strategy === 'yearless-date-time') return csvYearlessDateTimeSql(first, order === 'DMY' ? 'DMY' : 'MDY');
    if (strategy === 'month-name-date') return csvMonthNameDateSql(first);
    if (strategy === 'partial-year-month') {
        const m = extractSql(textSql(first), '^(?P<y>\\d{4})[/-](?P<mo>\\d{1,2})$');
        return csvPartsToMsSql({ year: part(m, 'y'), month: part(m, 'mo'), day: '1' });
    }
    if (strategy === 'iso-datetime') return csvIsoDateTimeSql(first, timeSource.format || {});
    if (strategy === 'custom-format') return csvCustomFormatSql(first, timeSource.format?.pattern || '');
    if (strategy === 'slash-date' || strategy === 'dash-date' || strategy === 'dot-date') {
        return csvNumericDateTimeSql(first, order, dateSeparatorForStrategy(strategy));
    }
    if (timeSource.mode === 'split' && sourceNames.length >= 2) {
        return csvSplitDateTimeSql(first, quoteIdent(sourceNames[1]), timeSource.format || {});
    }
    if (timeSource.mode === 'parts' || strategy === 'parts') {
        return csvPartsDateTimeSql(timeSource, sourceNames, { quoteIdent, numericCastSql: options.numericCastSql });
    }
    return null;
}
