/**
 * CSV time-axis detection.
 *
 * Current CSV time detector. Same public contract, plus a
 * stronger heuristic detector and the ability to recognise:
 *   - numeric time anywhere (not just first column)
 *   - ISO datetime, slash/dash/dot dates, month-name dates, Excel serials
 *   - split Date + Time column pairs
 *
 * Public API:
 *   detectCsvTimeAxis(rawHeaders, dataRows, { delimiter, preferredDateOrder })
 *   parseCsvNumber(rawValue, delimiter = ',', decimalSeparator = 'auto', thousandsSeparator = 'auto')
 *   describeTimeSourcePattern(timeSource, rows) / dateNamesLanguage(tokens)
 *   parseCsvTimeValue(...) / customDatetimePatternInfo(pattern)
 *
 * Dependency-free, deterministic, browser-compatible (ES module).
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SAMPLE_SIZE = 600;

// Header keywords that suggest a time-ish column. `weight` contributes to the
// 0..1 header score. `kind` is the semantic class. `exact` requires a whole
// match (so "stage" isn't treated as containing "t").
const TIME_HEADER_KEYWORDS = [
    { kw: 'datetime',   weight: 1.00, kind: 'datetime' },
    { kw: 'timestamp',  weight: 1.00, kind: 'datetime' },
    { kw: 'horodatage', weight: 1.00, kind: 'datetime' },
    { kw: 'date',       weight: 0.85, kind: 'date' },
    { kw: 'fecha',      weight: 0.85, kind: 'date' },
    { kw: 'time',       weight: 0.85, kind: 'time' },
    { kw: 'temps',      weight: 0.85, kind: 'time' },
    { kw: 'heure',      weight: 0.85, kind: 'time' },
    { kw: 'hora',       weight: 0.85, kind: 'time' },
    { kw: 'horaire',    weight: 0.80, kind: 'time' },
    { kw: 'orario',     weight: 0.80, kind: 'time' },
    { kw: 'zeitstempel', weight: 1.00, kind: 'datetime' },
    { kw: 'datum',      weight: 0.85, kind: 'date' },
    { kw: 'uhrzeit',    weight: 0.85, kind: 'time' },
    { kw: 'zeit',       weight: 0.85, kind: 'time' },
    { kw: 'tijd',       weight: 0.85, kind: 'time', exact: true },
    // Italian 'data'/'ora' must be exact: as substrings they would match
    // "dataset", "storage", "temporal", ...
    { kw: 'data',       weight: 0.85, kind: 'date', exact: true },
    { kw: 'ora',        weight: 0.85, kind: 'time', exact: true },
    { kw: 'day',        weight: 0.55, kind: 'date' },
    { kw: 'jour',       weight: 0.55, kind: 'date' },
    { kw: 'dia',        weight: 0.55, kind: 'date', exact: true },
    { kw: 't',          weight: 0.45, kind: 'time', exact: true },
];

// Headers that look time-ish but are really counters/indexes.
const NEGATIVE_HEADER_SUBSTRINGS = [
    'semaine', 'week', 'sample', 'index', 'idx', 'rowid', 'row',
    'count', 'counter', 'numero', 'identifier',
];
const NEGATIVE_HEADER_EXACT = ['n', 'no', 'num', 'id', 'n°'];

// Excel serial reasonable bounds: serial 1 = 1900-01-01, 80000 ≈ year 2119.
const EXCEL_SERIAL_MIN = 1;
const EXCEL_SERIAL_MAX = 80000;

// Excel epoch is 1899-12-30 in UTC (offset accounts for the 1900 leap bug).
const EXCEL_TO_UNIX_DAYS = 25569;
const MATLAB_TO_UNIX_DAYS = 719529;
const MS_PER_DAY = 86400000;
const DECIMAL_YEAR_MIN = 1800;
const DECIMAL_YEAR_MAX = 2200;
const MATLAB_DATENUM_MIN = 500000;
const MATLAB_DATENUM_MAX = 900000;

const MIN_CONFIDENCE = 0.30;

// Month names per language, as written in full and in the abbreviations
// spreadsheets and loggers use. Keys are lower case without accents or dots
// (lookupMonthName normalizes the cell the same way). The language is what
// the parsing dialog names when it says how a date column was read.
const MONTH_NAMES = {
    en: [
        ['january', 'jan'], ['february', 'feb'], ['march', 'mar'], ['april', 'apr'],
        ['may', 'may'], ['june', 'jun'], ['july', 'jul'], ['august', 'aug'],
        ['september', 'sep', 'sept'], ['october', 'oct'], ['november', 'nov'], ['december', 'dec'],
    ],
    fr: [
        ['janvier', 'janv', 'jan'], ['fevrier', 'fevr', 'fev'], ['mars', 'mar'], ['avril', 'avr'],
        ['mai'], ['juin'], ['juillet', 'juil'], ['aout', 'aou'],
        ['septembre', 'sept', 'sep'], ['octobre', 'oct'], ['novembre', 'nov'], ['decembre', 'dec'],
    ],
    es: [
        ['enero', 'ene'], ['febrero', 'feb'], ['marzo', 'mar'], ['abril', 'abr'],
        ['mayo', 'may'], ['junio', 'jun'], ['julio', 'jul'], ['agosto', 'ago'],
        ['septiembre', 'setiembre', 'sep', 'sept', 'set'], ['octubre', 'oct'], ['noviembre', 'nov'], ['diciembre', 'dic'],
    ],
    it: [
        ['gennaio', 'gen'], ['febbraio', 'feb'], ['marzo', 'mar'], ['aprile', 'apr'],
        ['maggio', 'mag'], ['giugno', 'giu'], ['luglio', 'lug'], ['agosto', 'ago'],
        ['settembre', 'set'], ['ottobre', 'ott'], ['novembre', 'nov'], ['dicembre', 'dic'],
    ],
    pt: [
        ['janeiro', 'jan'], ['fevereiro', 'fev'], ['marco', 'mar'], ['abril', 'abr'],
        ['maio', 'mai'], ['junho', 'jun'], ['julho', 'jul'], ['agosto', 'ago'],
        ['setembro', 'set'], ['outubro', 'out'], ['novembro', 'nov'], ['dezembro', 'dez'],
    ],
    de: [
        ['januar', 'jan', 'janner', 'jaenner'], ['februar', 'feb'], ['marz', 'mar', 'maerz', 'mrz'], ['april', 'apr'],
        ['mai'], ['juni', 'jun'], ['juli', 'jul'], ['august', 'aug'],
        ['september', 'sep', 'sept'], ['oktober', 'okt'], ['november', 'nov'], ['dezember', 'dez'],
    ],
    nl: [
        ['januari', 'jan'], ['februari', 'feb'], ['maart', 'mrt'], ['april', 'apr'],
        ['mei'], ['juni', 'jun'], ['juli', 'jul'], ['augustus', 'aug'],
        ['september', 'sep', 'sept'], ['oktober', 'okt'], ['november', 'nov'], ['december', 'dec'],
    ],
};

const WEEKDAY_NAMES = {
    en: [['monday', 'mon'], ['tuesday', 'tue', 'tues'], ['wednesday', 'wed'], ['thursday', 'thu', 'thur', 'thurs'], ['friday', 'fri'], ['saturday', 'sat'], ['sunday', 'sun']],
    fr: [['lundi', 'lun'], ['mardi', 'mar'], ['mercredi', 'mer'], ['jeudi', 'jeu'], ['vendredi', 'ven'], ['samedi', 'sam'], ['dimanche', 'dim']],
    es: [['lunes', 'lun'], ['martes', 'mar'], ['miercoles', 'mie'], ['jueves', 'jue'], ['viernes', 'vie'], ['sabado', 'sab'], ['domingo', 'dom']],
    it: [['lunedi', 'lun'], ['martedi', 'mar'], ['mercoledi', 'mer'], ['giovedi', 'gio'], ['venerdi', 'ven'], ['sabato', 'sab'], ['domenica', 'dom']],
    pt: [['segunda', 'seg', 'segunda-feira'], ['terca', 'ter', 'terca-feira'], ['quarta', 'qua', 'quarta-feira'], ['quinta', 'qui', 'quinta-feira'], ['sexta', 'sex', 'sexta-feira'], ['sabado', 'sab'], ['domingo', 'dom']],
    de: [['montag', 'mo', 'mon'], ['dienstag', 'di', 'die'], ['mittwoch', 'mi', 'mit'], ['donnerstag', 'do', 'don'], ['freitag', 'fr', 'fre'], ['samstag', 'sa', 'sam'], ['sonntag', 'so', 'son']],
    nl: [['maandag', 'ma'], ['dinsdag', 'di'], ['woensdag', 'wo'], ['donderdag', 'do'], ['vrijdag', 'vr'], ['zaterdag', 'za'], ['zondag', 'zo']],
};

export const DATE_LANGUAGE_NAMES = {
    en: 'English', fr: 'French', es: 'Spanish', it: 'Italian', pt: 'Portuguese', de: 'German', nl: 'Dutch',
};

// token -> { month, languages: Set, full: Set(languages where it is the full name) }
const MONTH_INDEX = new Map();
for (const [lang, months] of Object.entries(MONTH_NAMES)) {
    months.forEach((names, monthIndex) => {
        names.forEach((name, k) => {
            const entry = MONTH_INDEX.get(name) || { month: monthIndex + 1, languages: new Set(), full: new Set() };
            // The first language to claim a token keeps the month: no two
            // languages give one abbreviation two different months here.
            entry.languages.add(lang);
            if (k === 0) entry.full.add(lang);
            MONTH_INDEX.set(name, entry);
        });
    });
}
const WEEKDAY_INDEX = new Map();
for (const [lang, days] of Object.entries(WEEKDAY_NAMES)) {
    days.forEach((names, dayIndex) => {
        names.forEach((name, k) => {
            const entry = WEEKDAY_INDEX.get(name) || { day: dayIndex, languages: new Set(), full: new Set() };
            entry.languages.add(lang);
            if (k === 0) entry.full.add(lang);
            WEEKDAY_INDEX.set(name, entry);
        });
    });
}
const MONTH_LOOKUP = Object.fromEntries([...MONTH_INDEX].map(([name, entry]) => [name, entry.month]));

// ---------------------------------------------------------------------------
// parseCsvNumber - exported public helper
// ---------------------------------------------------------------------------

// A plain number, as nearly every cell of a data file is written: nothing to
// strip or translate, so it goes straight to Number().
const PLAIN_NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

export function parseCsvNumber(rawValue, delimiter = ',', decimalSeparator = 'auto', thousandsSeparator = 'auto') {
    let raw = String(rawValue ?? '').trim();
    if (!raw) return NaN;
    // Unless a dot groups thousands ("1.234" is then one thousand...).
    if (thousandsSeparator !== '.' && PLAIN_NUMBER_RE.test(raw)) return Number(raw);
    // A typographic minus (U+2212) or hyphen, as word processors and some
    // localized exports write it, is a minus sign.
    const first = raw.charCodeAt(0);
    if (first === 0x2212 || first === 0x2010 || first === 0x2013) raw = '-' + raw.slice(1);

    // Strip internal whitespace (which is also how space-grouped thousands,
    // "1 234,5" with a no-break space, are read) and translate Fortran-style
    // D-exponents.
    const normalized = raw
        .replace(/\s+/g, '')
        .replace(/[dD]([+-]?\d+)$/, 'e$1');

    if (/^[+-]?inf(?:inity)?$/i.test(normalized)) {
        return normalized.startsWith('-') ? -Infinity : Infinity;
    }
    if (/^nan$/i.test(normalized)) return NaN;

    let decimalMode = decimalSeparator === 'auto' || !decimalSeparator ? 'auto' : String(decimalSeparator);
    let thousandsMode = thousandsSeparator === 'auto' || !thousandsSeparator
        ? 'auto'
        : thousandsSeparator === 'none' ? 'none' : String(thousandsSeparator);
    if (thousandsMode === ' ') thousandsMode = 'none'; // whitespace is already gone
    // A grouping character implies the other one is the decimal separator.
    if (decimalMode === 'auto' && thousandsMode === '.') decimalMode = ',';
    if (decimalMode === 'auto' && thousandsMode === ',') decimalMode = '.';
    if (thousandsMode !== 'auto' && thousandsMode === decimalMode) thousandsMode = 'none';

    // The plain case — the one nearly every cell takes: nothing to translate.
    if (decimalMode === 'auto' && thousandsMode === 'auto'
        && normalized.indexOf(',') < 0 && normalized.indexOf("'") < 0 && normalized.indexOf('\u2019') < 0) {
        return Number(normalized);
    }

    let value = normalized;
    if (thousandsMode === 'auto') {
        // Only groupings that cannot be read another way.
        if (/^[+-]?\d{1,3}(?:['\u2019]\d{3})+(?:[.,]\d+)?$/.test(value)) {
            value = value.replace(/['\u2019]/g, '');
        } else if (decimalMode !== '.' && /^[+-]?\d{1,3}(?:\.\d{3})+,\d+$/.test(value)) {
            value = value.replace(/\./g, '');
            if (decimalMode === 'auto') decimalMode = ',';
        } else if (decimalMode !== ',' && /^[+-]?\d{1,3}(?:,\d{3})+\.\d+$/.test(value)) {
            value = value.replace(/,/g, '');
        }
    } else if (thousandsMode !== 'none') {
        value = value.split(thousandsMode).join('');
        if (thousandsMode === "'") value = value.replace(/\u2019/g, '');
    }

    if (decimalMode === ',') {
        value = value.replace(',', '.');
    } else if (decimalMode === 'auto') {
        if (delimiter !== ',' && value.includes(',') && !value.includes('.')) {
            value = value.replace(',', '.');
        }
    } else if (decimalMode !== '.') {
        // A custom decimal mark (the reader set it): it becomes the dot.
        value = value.split(decimalMode).join('.');
    }

    return Number(value);
}

function sniffDelimiter(text) {
    const candidates = [',', ';', '\t', 'whitespace'];
    let best = { delimiter: ',', score: -Infinity };

    for (const delimiter of candidates) {
        const rows = parseCsvNative(text.slice(0, 8192), delimiter)
            .filter(row => row.some(cell => cell.trim() !== ''))
            .slice(0, 8);
        if (!rows.length) continue;

        const headerWidth = rows[0].length;
        const widths = rows.map(row => row.length);
        const consistentRows = widths.filter(width => width === headerWidth).length;
        const drift = Math.max(...widths.map(width => Math.abs(width - headerWidth)));
        const score = headerWidth * 100 + consistentRows * 10 - drift;
        if (headerWidth > 1 && score > best.score) best = { delimiter, score };
    }

    return best.delimiter;
}

function parseCsvNative(text, delimiter) {
    if (delimiter === 'whitespace') {
        return String(text)
            .split(/\r?\n|\r/)
            .map(line => line.trim())
            .filter(line => line !== '')
            .map(line => line.split(/\s+/));
    }

    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (ch === '"') {
            if (inQuotes && text[i + 1] === '"') {
                field += '"';
                i++;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (!inQuotes && ch === delimiter) {
            row.push(field);
            field = '';
            continue;
        }

        if (!inQuotes && (ch === '\n' || ch === '\r')) {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            if (ch === '\r' && text[i + 1] === '\n') i++;
            continue;
        }

        field += ch;
    }

    row.push(field);
    rows.push(row);
    return rows;
}

// ---------------------------------------------------------------------------
// detectCsvTimeAxis - exported public detector
// ---------------------------------------------------------------------------

export function detectCsvTimeAxis(rawHeaders, dataRows, options = {}) {
    const delimiter = options.delimiter || ',';
    const preferred = (options.preferredDateOrder || 'DMY').toUpperCase();
    const warnings = [];

    const headers = (rawHeaders || []).map((h, i) => ({
        raw: h ?? '',
        norm: normalizeHeaderLabel(h),
        index: i,
    }));

    const nCols = Math.max(
        headers.length,
        dataRows.reduce((m, r) => Math.max(m, r ? r.length : 0), 0),
    );

    const sample = takeSample(dataRows, SAMPLE_SIZE);
    if (sample.length === 0) {
        return { ok: false, reason: 'No non-empty data rows to inspect', candidates: [], warnings };
    }

    // Per-column header score + content profile.
    const cols = [];
    for (let c = 0; c < nCols; c++) {
        const h = headers[c];
        cols.push({
            index: c,
            header: h,
            headerScore: scoreHeader(h ? h.norm : ''),
            content:     profileColumnContent(sample, c, delimiter),
        });
    }

    const candidates = [];

    // Single-column candidates: numeric, ISO/slash/dash/month-name datetime, Excel serial.
    for (const col of cols) {
        for (const cand of evaluateSingleColumn(col, preferred)) candidates.push(cand);
    }

    // Split date+time candidates. Any pair, but adjacency earns a small bonus.
    for (let i = 0; i < cols.length; i++) {
        for (let j = 0; j < cols.length; j++) {
            if (i === j) continue;
            const split = evaluateSplitColumns(cols[i], cols[j], preferred);
            if (split) candidates.push(split);
        }
    }

    candidates.sort((a, b) => b.score - a.score);

    // Drop near-duplicates (same mode + sourceIndexes, lower score).
    const seen = new Set();
    let unique = [];
    for (const c of candidates) {
        const key = c.mode + ':' + c.sourceIndexes.join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(c);
    }

    // A viable split candidate strictly dominates standalone candidates that it
    // absorbs. This matters for files with "Date" + "Time(s)": the clock column
    // name looks numeric, but values such as 09:58:45 are time-of-day and must
    // be combined with the date column.
    const splitDateIndexes = new Set();
    const splitAbsorbedIndexes = new Set();
    for (const c of unique) {
        if (c.mode === 'split' && c.score >= 0.5) {
            splitDateIndexes.add(c.sourceIndexes[0]);
            for (const idx of c.sourceIndexes) splitAbsorbedIndexes.add(idx);
        }
    }
    if (splitAbsorbedIndexes.size > 0) {
        unique = unique.filter(c =>
            !(c.mode === 'single'
              && ((c.kind === 'datetime' && !c.format.excelSerial && splitDateIndexes.has(c.sourceIndexes[0]))
                  || splitAbsorbedIndexes.has(c.sourceIndexes[0]))),
        );
    }

    if (unique.length === 0 || unique[0].score < MIN_CONFIDENCE) {
        warnings.push(unique.length === 0
            ? 'No time/date column detected; generated a zero-based index time vector.'
            : 'No candidate met the minimum confidence threshold; generated a zero-based index time vector.');
        return buildIndexResult(warnings);
    }

    return buildResult(unique[0], headers, delimiter, warnings);
}

export function parseCsvTimeValue(timeSource, row, rowIndex = 0, delimiter = ',', options = {}) {
    if (!timeSource?.ok) return NaN;
    const decimalSeparator = options.decimalSeparator || timeSource.decimalSeparator || 'auto';
    const thousandsSeparator = options.thousandsSeparator || 'auto';
    const indexes = Array.isArray(timeSource.sourceIndexes) ? timeSource.sourceIndexes : [];
    const strategy = timeSource.strategy || timeSource.mode;
    const idx = indexes[0] ?? 0;

    if (strategy === 'index-column') return parseCsvNumber(row?.[idx], delimiter, decimalSeparator, thousandsSeparator);
    if (timeSource.kind === 'index' || strategy === 'generated-index') return rowIndex;
    if (timeSource.kind === 'numeric') return parseCsvNumber(row?.[idx], delimiter, decimalSeparator, thousandsSeparator);
    if (strategy === 'custom-format') return parseCustomFormatMs(row?.[idx], timeSource.format?.pattern || '');
    if (strategy === 'iso-datetime') return parseIsoMs(row?.[idx]);
    if (strategy === 'partial-year-month') return parsePartialYearMonthMs(row?.[idx]);
    if (strategy === 'slash-date' || strategy === 'dash-date' || strategy === 'dot-date') {
        const order = timeSource.format?.dateOrder || 'YMD';
        return parseFlexibleDateMs(row?.[idx], order, dateSeparatorForStrategy(strategy));
    }
    if (strategy === 'yearless-date-time') {
        return parseYearlessDateTimeMs(row?.[idx], timeSource.format?.dateOrder || 'MDY');
    }
    if (strategy === 'month-name-date') return parseMonthNameDateMs(row?.[idx]);
    if (strategy === 'decimal-year') return decimalYearToMs(parseCsvNumber(row?.[idx], delimiter, decimalSeparator, thousandsSeparator));
    if (strategy === 'matlab-datenum') return matlabDatenumToMs(parseCsvNumber(row?.[idx], delimiter, decimalSeparator, thousandsSeparator));
    if (strategy === 'excel-serial') return excelSerialToMs(parseCsvNumber(row?.[idx], delimiter, decimalSeparator, thousandsSeparator));
    if (timeSource.mode === 'split' && indexes.length >= 2) {
        return combineDateAndTimeMs(row?.[indexes[0]], row?.[indexes[1]], timeSource.format?.dateOrder || 'YMD');
    }
    if (timeSource.mode === 'parts' || strategy === 'parts') {
        return parsePartsDateTimeMs(timeSource, row, delimiter, decimalSeparator, thousandsSeparator);
    }
    return NaN;
}

// The tokens a custom datetime pattern is made of, longest first so "MMMM"
// is read before "MM" and "yyyy" before "yy". `strf` is the DuckDB strptime
// equivalent the lazy (SQL) readers use.
const PATTERN_TOKENS = [
    { key: 'AM/PM', strf: '%p', part: 'ampm' },
    { key: 'yyyy', strf: '%Y', part: 'year' },
    { key: 'yy', strf: '%y', part: 'year' },
    { key: 'EEEE', strf: '%A', part: 'weekday' },
    { key: 'EEE', strf: '%a', part: 'weekday' },
    { key: 'MMMM', strf: '%b', part: 'monthName' },
    { key: 'MMM', strf: '%b', part: 'monthName' },
    { key: 'MM', strf: '%m', part: 'month' },
    { key: 'M', strf: '%m', part: 'month' },
    { key: 'dd', strf: '%d', part: 'day' },
    { key: 'd', strf: '%d', part: 'day' },
    { key: 'HH', strf: '%H', part: 'hour' },
    { key: 'H', strf: '%H', part: 'hour' },
    { key: 'hh', strf: '%I', part: 'hour12' },
    { key: 'h', strf: '%I', part: 'hour12' },
    { key: 'mm', strf: '%M', part: 'minute' },
    { key: 'm', strf: '%M', part: 'minute' },
    { key: 'ss', strf: '%S', part: 'second' },
    { key: 's', strf: '%S', part: 'second' },
    { key: 'XXX', strf: '%z', part: 'zone' },
];

/**
 * A pattern as a list of tokens and literal text. Text in single quotes is
 * literal ('T', 'h', 'de'), and '' is a quote character, as in Java and ICU.
 */
function tokenizeDatetimePattern(pattern) {
    const source = String(pattern || '');
    const parts = [];
    for (let i = 0; i < source.length;) {
        if (source[i] === "'") {
            const close = source.indexOf("'", i + 1);
            const end = close < 0 ? source.length : close;
            const literal = source.slice(i + 1, end);
            parts.push({ literal: literal === '' ? "'" : literal });
            i = end + 1;
            continue;
        }
        const token = readPatternToken(source, i);
        if (token) {
            parts.push({ token });
            i += token.key.length;
            continue;
        }
        parts.push({ literal: source[i] });
        i++;
    }
    return parts;
}

// A run of S is the fraction of a second, any number of digits.
function readPatternToken(pattern, i) {
    if (pattern[i] === 'S') {
        let j = i;
        while (pattern[j] === 'S') j++;
        const width = j - i;
        return { key: pattern.slice(i, j), strf: width > 6 ? '%n' : '%f', part: 'fraction', width };
    }
    return PATTERN_TOKENS.find(token => pattern.startsWith(token.key, i)) || null;
}

export function customDatetimePatternInfo(pattern) {
    const source = String(pattern || '');
    if (!source.trim()) return null;
    const flags = {
        hasYear: false,
        hasMonth: false,
        hasDay: false,
        hasMonthName: false,
        hasWeekday: false,
    };
    let out = '';
    const parts = tokenizeDatetimePattern(source);
    for (let p = 0; p < parts.length; p++) {
        const { token, literal } = parts[p];
        if (token) {
            if (token.part === 'weekday') {
                // DuckDB only knows English weekday names; the SQL readers
                // strip the weekday instead (see hasWeekday), so it is left
                // out of the format, with the separator that followed it.
                flags.hasWeekday = true;
                while (parts[p + 1]?.literal != null && /^[\s,.]+$/.test(parts[p + 1].literal)) p++;
                continue;
            }
            out += token.strf;
            if (token.part === 'year') flags.hasYear = true;
            if (token.part === 'month' || token.part === 'monthName') flags.hasMonth = true;
            if (token.part === 'monthName') flags.hasMonthName = true;
            if (token.part === 'day') flags.hasDay = true;
            continue;
        }
        out += literal.replace(/%/g, '%%');
    }
    let prefix = '';
    let suffix = '';
    let formatPrefix = '';
    let formatSuffix = '';
    if (!flags.hasYear) {
        prefix = '2001-';
        formatPrefix = '%Y-';
    }
    if (!flags.hasMonth) {
        suffix += '-01';
        formatSuffix += '-%m';
    }
    if (!flags.hasDay) {
        suffix += '-01';
        formatSuffix += '-%d';
    }
    return {
        format: `${formatPrefix}${out}${formatSuffix}`,
        valuePrefix: prefix,
        valueSuffix: suffix,
        ...flags,
    };
}

function buildIndexResult(warnings) {
    return {
        ok: true,
        kind: 'index',
        mode: 'generated-index',
        strategy: 'generated-index',
        sourceIndexes: [],
        sourceHeaders: [],
        name: 'index',
        description: '[index]',
        confidence: 1,
        format: { generated: true },
        parse: (_row, rowIndex = 0) => rowIndex,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// Header normalization + scoring
// ---------------------------------------------------------------------------

function normalizeHeaderLabel(header) {
    return String(header ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')   // strip combining accents
        .replace(/[^a-z0-9]+/g, ' ')       // collapse separators
        .trim();
}

function scoreHeader(norm) {
    if (!norm) return { score: 0, kind: null, matched: null, negative: false };

    const tokens = norm.split(' ').filter(Boolean);
    const negative =
        NEGATIVE_HEADER_EXACT.includes(norm) ||
        tokens.some(t => NEGATIVE_HEADER_EXACT.includes(t)) ||
        NEGATIVE_HEADER_SUBSTRINGS.some(s => norm.includes(s));

    let best = { score: 0, kind: null, matched: null };
    for (const { kw, weight, kind, exact } of TIME_HEADER_KEYWORDS) {
        const match = exact ? (norm === kw || tokens.includes(kw)) : norm.includes(kw);
        if (match && weight > best.score) best = { score: weight, kind, matched: kw };
    }

    return { ...best, negative };
}

// Splits a header into a display name and a bracketed unit description.
//   "Voltage [V]"     -> { name: 'Voltage', description: '[V]' }
//   "speed (km/h)"    -> { name: 'speed',   description: '[km/h]' }
//   ""                -> { name: fallback, description: '' }
/**
 * Whether the text in a header's brackets reads as a unit. "kW.h", "m/s",
 * "°C", "deg C" do; "vierge si fiable" ("blank if reliable", a note a GTB
 * export puts after Fiabilité) does not: three words or more are a phrase,
 * and the header keeps them as part of its name.
 */
export function looksLikeUnitText(text) {
    const words = String(text ?? '').trim().split(/\s+/).filter(Boolean);
    return words.length > 0 && words.length <= 2;
}

function parseHeader(rawHeader, fallbackIndex) {
    const fallback = fallbackIndex === 0 ? 'time' : `column_${fallbackIndex + 1}`;
    const raw = String(rawHeader ?? '').trim();
    if (!raw) return { name: fallback, description: '' };

    let m = raw.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
    if (m && looksLikeUnitText(m[2])) return { name: sanitizeName(m[1], fallback), description: `[${m[2].trim()}]` };

    m = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (m && looksLikeUnitText(m[2])) return { name: sanitizeName(m[1], fallback), description: `[${m[2].trim()}]` };

    return { name: sanitizeName(raw, fallback), description: '' };
}

function sanitizeName(name, fallback) {
    const cleaned = String(name ?? '').trim();
    return cleaned || fallback;
}

function normalizeNameToken(token) {
    return String(token ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[.,]/g, '');
}

function lookupMonthName(token) {
    return MONTH_LOOKUP[normalizeNameToken(token)] ?? null;
}

function lookupWeekdayName(token) {
    return WEEKDAY_INDEX.get(normalizeNameToken(token)) || null;
}

/**
 * The language month (and weekday) names in a sample are written in, decided
 * by which language accounts for all of them. "mars" is French, "marzo"
 * Spanish or Italian, "Mar" any of four: the language that explains every
 * token wins, and among those the one whose full names were used.
 *
 * @param {string[]} tokens month or weekday words as written in the file
 * @returns {string|null} a key of DATE_LANGUAGE_NAMES
 */
export function dateNamesLanguage(tokens) {
    const scores = new Map();
    let counted = 0;
    for (const token of tokens || []) {
        const key = normalizeNameToken(token);
        const entry = MONTH_INDEX.get(key) || WEEKDAY_INDEX.get(key);
        if (!entry) continue;
        counted++;
        for (const lang of entry.languages) {
            const score = scores.get(lang) || { hits: 0, full: 0 };
            score.hits++;
            if (entry.full.has(lang) && key.length > 3) score.full++;
            scores.set(lang, score);
        }
    }
    if (!counted) return null;
    const order = Object.keys(DATE_LANGUAGE_NAMES);
    const ranked = [...scores.entries()].sort((a, b) =>
        (b[1].hits - a[1].hits) || (b[1].full - a[1].full) || (order.indexOf(a[0]) - order.indexOf(b[0])));
    return ranked[0]?.[0] || null;
}

// A clock time after a date, as month-name dates are written: "10:05",
// "10:05:22", "10:05:22.123" or ",123" (European loggers), "1:05 PM",
// "13h05", and an optional zone (Z, UTC, GMT, +01:00).
const NAMED_DATE_TIME = '(?:(?:[T\\s]+|\\s*[,@]\\s*|\\s+(?:at|a|à|um|alle|às|las|los)\\s+)'
    + '(?<H>\\d{1,2})[:h](?<Mi>\\d{2})(?::(?<Se>\\d{2})(?:[.,](?<F>\\d+))?)?'
    + '(?:\\s*(?<ampm>[AaPp]\\.?[Mm]\\.?))?'
    + '(?:\\s*(?<tz>Z|(?:UTC|GMT)(?:[+\\-]\\d{1,2}(?::?\\d{2})?)?|[+\\-]\\d{2}:?\\d{2}))?)?';
const NAMED_MONTH = '(?<mon>[\\p{L}]{3,12}\\.?)';
const NAMED_DATE_SEP = '(?:\\s+de\\s+|\\s+del\\s+|[-\\s.,/]+)';
const NAMED_DATE_PATTERNS = [
    // 15 janvier 2024, 15-Jan-24, 15 de enero de 2024, 1er mars 2024
    { order: 'DMY', re: new RegExp(`^(?<d>\\d{1,2})(?:er|st|nd|rd|th|º|°)?${NAMED_DATE_SEP}${NAMED_MONTH}${NAMED_DATE_SEP}(?<y>\\d{2,4})${NAMED_DATE_TIME}$`, 'u') },
    // January 15, 2024 / Jan 15 2024
    { order: 'MDY', re: new RegExp(`^${NAMED_MONTH}[-\\s.,/]+(?<d>\\d{1,2})(?:st|nd|rd|th)?,?[-\\s.,/]+(?<y>\\d{2,4})${NAMED_DATE_TIME}$`, 'u') },
    // 2024-Jan-15 / 2024 janvier 15
    { order: 'YMD', re: new RegExp(`^(?<y>\\d{4})[-\\s.,/]+${NAMED_MONTH}[-\\s.,/]+(?<d>\\d{1,2})${NAMED_DATE_TIME}$`, 'u') },
    // Jan 15 10:00:00 2024 (C asctime, syslog with a year)
    { order: 'MDY', re: new RegExp(`^${NAMED_MONTH}\\s+(?<d>\\d{1,2})\\s+(?<H>\\d{1,2}):(?<Mi>\\d{2})(?::(?<Se>\\d{2})(?:[.,](?<F>\\d+))?)?\\s+(?<y>\\d{4})$`, 'u'), timeBeforeYear: true },
    // January 2024 / janv. 2024 (a month, day 01)
    { order: 'MY', re: new RegExp(`^${NAMED_MONTH}[-\\s.,/]+(?<y>\\d{4})$`, 'u') },
];

function tzOffsetMinutes(tz) {
    if (!tz) return 0;
    const text = String(tz).toUpperCase();
    if (text === 'Z' || text === 'UTC' || text === 'GMT') return 0;
    const m = text.match(/([+\-])(\d{1,2})(?::?(\d{2}))?$/);
    if (!m) return 0;
    const minutes = Number(m[2]) * 60 + Number(m[3] || 0);
    return m[1] === '-' ? -minutes : minutes;
}

/** Whether a cell is a date written with a month name (see below). */
export function isMonthNameDateCell(cell) {
    return matchMonthNameDate(cell) !== null;
}

/**
 * A date written with a month name, in any of the languages above, with an
 * optional weekday in front ("Mon, 15 Jan 2024 10:00:00 +0100", "lundi 15
 * janvier 2024 10:00"). Null when the cell is not one.
 */
function matchMonthNameDate(cell) {
    const s = String(cell ?? '').trim();
    if (!s || s.length > 64 || !/\p{L}{2}/u.test(s)) return null;
    // The date as written, then without a leading weekday. In that order:
    // "Mar 1 2000" is March (and "mar" a Spanish or French weekday only when
    // what follows is a date by itself).
    const direct = matchNamedDateBody(s, null);
    if (direct) return direct;
    const wm = s.match(/^([\p{L}-]{2,14})\.?,?\s+(?=[\d\p{L}])/u);
    if (wm && lookupWeekdayName(wm[1])) return matchNamedDateBody(s.slice(wm[0].length), wm[1]);
    return null;
}

function matchNamedDateBody(s, weekdayToken) {
    for (const pattern of NAMED_DATE_PATTERNS) {
        const m = s.match(pattern.re);
        if (!m?.groups) continue;
        const g = m.groups;
        const mo = lookupMonthName(g.mon);
        if (mo == null) continue;
        let H = g.H != null ? +g.H : 0;
        const ampm = g.ampm ? g.ampm.replace(/\./g, '').toUpperCase() : '';
        if (ampm) {
            if (H < 1 || H > 12) continue;
            H = (H % 12) + (ampm === 'PM' ? 12 : 0);
        }
        return {
            order: pattern.order === 'MY' ? 'MDY' : pattern.order,
            d: g.d != null ? +g.d : 1,
            mo,
            y: +g.y,
            H,
            Mi: g.Mi != null ? +g.Mi : 0,
            Se: g.Se != null ? +g.Se : 0,
            Ms: g.F != null ? Math.round(Number('0.' + g.F) * 1000) : 0,
            hasTime: g.H != null,
            tzOffsetMinutes: tzOffsetMinutes(g.tz),
            hasZone: !!g.tz,
            monthToken: g.mon,
            weekdayToken,
            dayless: pattern.order === 'MY',
        };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Content profile
// ---------------------------------------------------------------------------

function profileColumnContent(sample, colIdx, delimiter) {
    const profile = {
        nonEmpty: 0,
        numeric: 0,
        numericValues: [],
        timeOfDay: 0,
        iso: 0,                // 2022-08-01 [T 00:00:00...]
        partialYearMonth: 0,   // 2022-08 or 2022/08, day 01 assumed
        partialYearMonthDash: 0,
        slashDate: 0,          // a/b/c
        dashDate: 0,           // a-b-c (when leading part is 1-2 digits, so not ISO)
        dotDate: 0,            // a.b.c (dd.MM.yyyy, as German/Swiss/Polish exports write it)
        yearlessDateTime: 0,   // MM/DD HH:mm:ss or DD/MM HH:mm:ss
        yearlessSlash: 0,
        yearlessDash: 0,
        monthNameDate: 0,      // 01-Aug-2022, 01 aout 2022, Aug 01 2022
        monthNameDmy: 0,
        monthNameMdy: 0,
        yearlessCounts: { ymd: 0, firstGt12: 0, secondGt12: 0, ambig: 0, total: 0 },
        slashCounts: { ymd: 0, firstGt12: 0, secondGt12: 0, ambig: 0, total: 0 },
        dashCounts:  { ymd: 0, firstGt12: 0, secondGt12: 0, ambig: 0, total: 0 },
        dotCounts:   { ymd: 0, firstGt12: 0, secondGt12: 0, ambig: 0, total: 0 },
        hasTimePart: 0,
        meridiemTimePart: 0,
        excelSerialCandidate: 0,
        monotonicInc: 0,
        sample: [],
        tzMode: null,          // 'utc' | 'offset' | 'naive'
        fractionComma: 0,      // 10:05:22,123 — European loggers
        weekdayPrefix: 0,      // "Mon, 15 Jan 2024"
    };

    let prevNum = null;
    for (const row of sample) {
        const raw = row?.[colIdx];
        if (raw == null || raw === '') continue;
        const cell = String(raw);
        profile.nonEmpty++;
        if (profile.sample.length < 5) profile.sample.push(cell);
        if (cell.indexOf(':') > 0 && /\d:\d{2}(?::\d{2})?,\d/.test(cell)) profile.fractionComma++;

        const num = parseCsvNumber(cell, delimiter);
        if (Number.isFinite(num)) {
            profile.numeric++;
            profile.numericValues.push(num);
            if (prevNum != null && num > prevNum) profile.monotonicInc++;
            prevNum = num;
            if (num >= EXCEL_SERIAL_MIN && num <= EXCEL_SERIAL_MAX) profile.excelSerialCandidate++;
        } else {
            prevNum = null;
        }

        if (/^\d{1,2}:\d{2}(:\d{2})?([.,]\d+)?$/.test(cell)) profile.timeOfDay++;

        const pym = cell.match(/^(\d{4})([/-])(\d{1,2})$/);
        if (pym) {
            profile.partialYearMonth++;
            if (pym[2] === '-') profile.partialYearMonthDash++;
            continue;
        }

        const ym = cell.match(
            /^(\d{1,2})([/-])(\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?(?:\s*[AP]M)?$/i,
        );
        if (ym) {
            profile.yearlessDateTime++;
            if (ym[2] === '/') profile.yearlessSlash++;
            else profile.yearlessDash++;
            tallyDateAmbiguity(profile.yearlessCounts, +ym[1], +ym[3], ym[1]);
            profile.hasTimePart++;
            if (/[AP]M\s*$/i.test(cell)) profile.meridiemTimePart++;
            continue;
        }

        const isoMatch = cell.match(
            /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?\s?(Z|[+\-]\d{2}(?::?\d{2})?)?)?$/,
        );
        if (isoMatch) {
            profile.iso++;
            if (isoMatch[4] != null) profile.hasTimePart++;
            const tz = isoMatch[7];
            profile.tzMode =
                tz == null ? (profile.tzMode || 'naive')
              : tz === 'Z'  ? 'utc'
                            : 'offset';
            continue;
        }

        const sm = cell.match(
            /^(\d{1,4})\/(\d{1,2})\/(\d{1,4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?(?:\s*[AP]M)?)?$/i,
        );
        if (sm) {
            profile.slashDate++;
            tallyDateAmbiguity(profile.slashCounts, +sm[1], +sm[2], sm[1]);
            if (sm[4] != null) profile.hasTimePart++;
            if (sm[4] != null && /[AP]M\s*$/i.test(cell)) profile.meridiemTimePart++;
            continue;
        }

        const dm = cell.match(
            /^(\d{1,2})-(\d{1,2})-(\d{2,4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?(?:\s*[AP]M)?)?$/i,
        );
        if (dm) {
            profile.dashDate++;
            tallyDateAmbiguity(profile.dashCounts, +dm[1], +dm[2], dm[1]);
            if (dm[4] != null) profile.hasTimePart++;
            if (dm[4] != null && /[AP]M\s*$/i.test(cell)) profile.meridiemTimePart++;
            continue;
        }

        // Dots between the parts: 08.10.2026 00:05. Three parts are required,
        // so a decimal number (12.5) never reaches here as a date — it was
        // counted as numeric above and fails this pattern anyway.
        const dot = cell.match(
            /^(\d{1,4})\.(\d{1,2})\.(\d{1,4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?(?:\s*[AP]M)?)?$/i,
        );
        if (dot && (dot[1].length === 4 ? dot[3].length <= 2 : (dot[1].length <= 2 && (dot[3].length === 2 || dot[3].length === 4)))) {
            profile.dotDate++;
            tallyDateAmbiguity(profile.dotCounts, +dot[1], +dot[2], dot[1]);
            if (dot[4] != null) profile.hasTimePart++;
            if (dot[4] != null && /[AP]M\s*$/i.test(cell)) profile.meridiemTimePart++;
            continue;
        }

        const mn = matchMonthNameDate(cell);
        if (mn) {
            profile.monthNameDate++;
            if (mn.order === 'DMY') profile.monthNameDmy++;
            if (mn.weekdayToken) profile.weekdayPrefix++;
            else profile.monthNameMdy++;
            if (mn.hasTime) profile.hasTimePart++;
        }
    }

    return profile;
}

function tallyDateAmbiguity(c, a, b, firstPart = '') {
    c.total++;
    if (String(firstPart).length === 4) c.ymd++;
    else if (a > 12 && a <= 31) c.firstGt12++;
    else if (b > 12 && b <= 31) c.secondGt12++;
    else c.ambig++;
}

// ---------------------------------------------------------------------------
// Candidate evaluation
// ---------------------------------------------------------------------------

function evaluateSingleColumn(col, preferred) {
    const out = [];
    const { content, headerScore } = col;
    if (content.nonEmpty === 0) return out;

    const fNumeric = content.numeric / content.nonEmpty;
    const fIso     = content.iso     / content.nonEmpty;
    const fPartialYearMonth = content.partialYearMonth / content.nonEmpty;
    const fSlash   = content.slashDate / content.nonEmpty;
    const fDash    = content.dashDate  / content.nonEmpty;
    const fDot     = content.dotDate   / content.nonEmpty;
    const fYearless = content.yearlessDateTime / content.nonEmpty;
    const fMonthName = content.monthNameDate / content.nonEmpty;
    const fMono    = content.numericValues.length > 1
        ? content.monotonicInc / (content.numericValues.length - 1)
        : 0;
    const decimalYear = profileDecimalYear(content.numericValues);
    const matlabDatenum = profileMatlabDatenum(content.numericValues);

    // ---- Datetime: ISO ----------------------------------------------------
    if (fIso >= 0.8) {
        const hasTime = content.hasTimePart / content.iso >= 0.5;
        out.push({
            mode: 'single',
            kind: 'datetime',
            sourceIndexes: [col.index],
            score: clamp01(0.5 * headerScore.score + 0.6 + 0.1 * (hasTime ? 1 : 0)),
            format: {
                dateOrder: 'YMD',
                hasTime,
                timezone: content.tzMode === 'utc' ? 'utc'
                        : content.tzMode === 'offset' ? 'offset'
                        : 'floating',
                excelSerial: false, fractionComma: content.fractionComma > 0,
            },
            descTag: 'iso-datetime',
            col,
        });
    }

    // ---- Datetime: year + month, day missing -----------------------------
    if (fPartialYearMonth >= 0.8) {
        out.push({
            mode: 'single',
            kind: 'datetime',
            sourceIndexes: [col.index],
            score: clamp01(0.5 * headerScore.score + 0.58),
            format: {
                dateOrder: 'YMD',
                hasTime: false,
                timezone: 'floating',
                excelSerial: false, fractionComma: content.fractionComma > 0,
                partial: 'year-month',
                assumedDay: 1,
                dashSeparator: content.partialYearMonthDash >= content.partialYearMonth / 2,
            },
            descTag: 'partial-year-month',
            col,
        });
    }

    // ---- Datetime: slash date --------------------------------------------
    if (fSlash >= 0.8) {
        const order = resolveDmyOrMdy(content.slashCounts, preferred);
        const hasTime = content.hasTimePart / content.slashDate >= 0.5;
        const hasMeridiem = hasTime && content.meridiemTimePart / Math.max(1, content.hasTimePart) >= 0.5;
        out.push({
            mode: 'single',
            kind: 'datetime',
            sourceIndexes: [col.index],
            score: clamp01(0.5 * headerScore.score + 0.55 + 0.1 * (hasTime ? 1 : 0)),
            format: { dateOrder: order.order, hasTime, hasMeridiem, timezone: 'floating', excelSerial: false, fractionComma: content.fractionComma > 0, ambiguous: order.ambiguous },
            descTag: 'slash-date',
            col,
        });
    }

    // ---- Datetime: dash date (non-ISO) -----------------------------------
    if (fDash >= 0.8 && fIso < 0.5) {
        const order = resolveDmyOrMdy(content.dashCounts, preferred);
        const hasTime = content.hasTimePart / content.dashDate >= 0.5;
        const hasMeridiem = hasTime && content.meridiemTimePart / Math.max(1, content.hasTimePart) >= 0.5;
        out.push({
            mode: 'single',
            kind: 'datetime',
            sourceIndexes: [col.index],
            score: clamp01(0.5 * headerScore.score + 0.5 + 0.1 * (hasTime ? 1 : 0)),
            format: { dateOrder: order.order, hasTime, hasMeridiem, timezone: 'floating', excelSerial: false, fractionComma: content.fractionComma > 0, dashSeparator: true, ambiguous: order.ambiguous },
            descTag: 'dash-date',
            col,
        });
    }

    // ---- Datetime: dot date (dd.MM.yyyy) ---------------------------------
    // A dotted date is day-first wherever it is written (DE, CH, AT, PL, RU,
    // ...), so an ambiguous column leans DMY unless the caller says otherwise.
    if (fDot >= 0.8) {
        const order = resolveDmyOrMdy(content.dotCounts, preferred === 'MDY' ? 'MDY' : 'DMY');
        const hasTime = content.hasTimePart / content.dotDate >= 0.5;
        const hasMeridiem = hasTime && content.meridiemTimePart / Math.max(1, content.hasTimePart) >= 0.5;
        out.push({
            mode: 'single',
            kind: 'datetime',
            sourceIndexes: [col.index],
            score: clamp01(0.5 * headerScore.score + 0.55 + 0.1 * (hasTime ? 1 : 0)),
            format: { dateOrder: order.order, hasTime, hasMeridiem, timezone: 'floating', excelSerial: false, fractionComma: content.fractionComma > 0, dotSeparator: true, ambiguous: order.ambiguous },
            descTag: 'dot-date',
            col,
        });
    }

    // ---- Datetime: month/day + time, no year ----------------------------
    if (fYearless >= 0.8) {
        const order = resolveDmyOrMdy(content.yearlessCounts, preferred);
        out.push({
            mode: 'single',
            kind: 'datetime',
            sourceIndexes: [col.index],
            score: clamp01(0.5 * headerScore.score + 0.5 + 0.1),
            format: {
                dateOrder: order.order,
                hasTime: true,
                timezone: 'floating',
                excelSerial: false, fractionComma: content.fractionComma > 0,
                yearless: true,
                hasMeridiem: content.meridiemTimePart / Math.max(1, content.hasTimePart) >= 0.5,
                dashSeparator: content.yearlessDash > content.yearlessSlash,
                ambiguous: order.ambiguous,
            },
            descTag: 'yearless-date-time',
            col,
        });
    }

    // ---- Datetime: month-name date --------------------------------------
    if (fMonthName >= 0.8) {
        const order = content.monthNameDmy >= content.monthNameMdy ? 'DMY' : 'MDY';
        const hasTime = content.hasTimePart / content.monthNameDate >= 0.5;
        out.push({
            mode: 'single',
            kind: 'datetime',
            sourceIndexes: [col.index],
            score: clamp01(0.5 * headerScore.score + 0.6 + 0.1 * (hasTime ? 1 : 0)),
            format: { dateOrder: order, hasTime, timezone: 'floating', excelSerial: false, fractionComma: content.fractionComma > 0, monthName: true, weekday: content.weekdayPrefix > 0 },
            descTag: 'month-name-date',
            col,
        });
    }

    // ---- Datetime: decimal year -----------------------------------------
    // Value-driven detection: e.g. 1958.2027 means 20.27% through 1958.
    // Header text can help rank ties, but is not required.
    if (fNumeric >= 0.95 && decimalYear.ok) {
        out.push({
            mode: 'single',
            kind: 'datetime',
            sourceIndexes: [col.index],
            score: clamp01(0.72 + 0.18 * decimalYear.confidence + 0.08 * headerScore.score),
            format: { dateOrder: 'YMD', hasTime: true, timezone: 'floating', excelSerial: false, fractionComma: content.fractionComma > 0, decimalYear: true },
            descTag: 'decimal-year',
            col,
        });
    }

    // ---- Datetime: MATLAB datenum ---------------------------------------
    // MATLAB datenum is ~719529 at Unix epoch and ~739000 for modern dates,
    // far away from Excel serial dates (~45000 today), so magnitude separates them.
    if (fNumeric >= 0.95 && matlabDatenum.ok && !headerScore.negative) {
        out.push({
            mode: 'single',
            kind: 'datetime',
            sourceIndexes: [col.index],
            score: clamp01(0.86 + 0.14 * matlabDatenum.confidence + 0.08 * headerScore.score),
            format: { dateOrder: 'YMD', hasTime: true, timezone: 'utc', excelSerial: false, fractionComma: content.fractionComma > 0, matlabDatenum: true },
            descTag: 'matlab-datenum',
            col,
        });
    }

    // ---- Datetime: Excel serial - requires a date-ish header -------------
    if (fNumeric >= 0.95 && content.excelSerialCandidate / content.numeric >= 0.95) {
        if (!headerScore.negative && (headerScore.kind === 'date' || headerScore.kind === 'datetime')) {
            out.push({
                mode: 'single',
                kind: 'datetime',
                sourceIndexes: [col.index],
                score: clamp01(0.7 * headerScore.score + 0.25),
                format: { dateOrder: 'YMD', hasTime: true, timezone: 'utc', excelSerial: true },
                descTag: 'excel-serial',
                col,
            });
        }
    }

    // ---- Numeric: simulation-style time. ---------------------------------
    // Only an explicit time-ish header ("time", "t", "temps", ...) is treated
    // as numeric time. Plain monotonic first columns are preserved as variables;
    // the caller gets a generated index abscissa instead.
    const headerIsDateish = headerScore.kind === 'date' || headerScore.kind === 'datetime';
    if (fNumeric >= 0.95 && !headerScore.negative && !headerIsDateish) {
        const headerSaysTime = headerScore.kind === 'time';
        const monoBoost = fMono >= 0.95 ? 0.25 : fMono >= 0.7 ? 0.10 : 0;
        if (headerSaysTime) {
            out.push({
                mode: 'single',
                kind: 'numeric',
                sourceIndexes: [col.index],
                score: clamp01(0.55 + 0.4 * headerScore.score + monoBoost),
                format: {},
                descTag: 'numeric-time',
                col,
            });
        }
    }

    return out;
}

function evaluateSplitColumns(dateCol, timeCol, preferred) {
    const dc = dateCol.content;
    const tc = timeCol.content;
    if (dc.nonEmpty === 0 || tc.nonEmpty === 0) return null;

    const dateRatio = (dc.iso + dc.slashDate + dc.dashDate + dc.dotDate + dc.monthNameDate) / dc.nonEmpty;
    const timeRatio = tc.timeOfDay / tc.nonEmpty;
    if (dateRatio < 0.8 || timeRatio < 0.8) return null;

    let order = 'YMD';
    let ambiguous = false;
    let dashSeparator = false;
    let dotSeparator = false;
    let monthName = false;
    const counts = { iso: dc.iso, slash: dc.slashDate, dash: dc.dashDate, dot: dc.dotDate, month: dc.monthNameDate };
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    if (top === 'iso') {
        order = 'YMD';
        dashSeparator = true;
    } else if (top === 'slash') {
        const r = resolveDmyOrMdy(dc.slashCounts, preferred);
        order = r.order; ambiguous = r.ambiguous;
    } else if (top === 'dash') {
        const r = resolveDmyOrMdy(dc.dashCounts, preferred);
        order = r.order; ambiguous = r.ambiguous; dashSeparator = true;
    } else if (top === 'dot') {
        const r = resolveDmyOrMdy(dc.dotCounts, preferred === 'MDY' ? 'MDY' : 'DMY');
        order = r.order; ambiguous = r.ambiguous; dotSeparator = true;
    } else {
        order = dc.monthNameDmy >= dc.monthNameMdy ? 'DMY' : 'MDY';
        monthName = true;
    }

    const adjacent = Math.abs(dateCol.index - timeCol.index) === 1;
    const headerBoost =
        (dateCol.headerScore.kind === 'date' ? 0.2 : 0) +
        (timeCol.headerScore.kind === 'time' ? 0.2 : 0);
    const contentBoost = Math.min(dateRatio, timeRatio) >= 0.98 ? 0.1 : 0;
    const score = clamp01(0.45 + headerBoost + (adjacent ? 0.1 : 0) + contentBoost);

    return {
        mode: 'split',
        kind: 'datetime',
        sourceIndexes: [dateCol.index, timeCol.index],
        score,
        format: { dateOrder: order, hasTime: true, timezone: 'floating', excelSerial: false, dashSeparator, dotSeparator, ambiguous, monthName, fractionComma: tc.fractionComma > 0, weekday: dc.weekdayPrefix > 0 },
        descTag: 'split-date-time',
        col: dateCol,
        timeCol,
    };
}

function resolveDmyOrMdy(counts, preferred) {
    if (counts.ymd > 0) return { order: 'YMD', ambiguous: false };
    if (counts.firstGt12 > 0 && counts.secondGt12 === 0) return { order: 'DMY', ambiguous: false };
    if (counts.secondGt12 > 0 && counts.firstGt12 === 0) return { order: 'MDY', ambiguous: false };
    if (counts.firstGt12 > 0 && counts.secondGt12 > 0) {
        return { order: preferred === 'MDY' ? 'MDY' : 'DMY', ambiguous: true };
    }
    return { order: preferred === 'MDY' ? 'MDY' : 'DMY', ambiguous: true };
}

function profileDecimalYear(values) {
    const nums = (values || []).filter(Number.isFinite);
    if (nums.length < 3) return { ok: false, confidence: 0 };

    const plausible = nums.filter(value => value >= DECIMAL_YEAR_MIN && value <= DECIMAL_YEAR_MAX).length;
    const fractional = nums.filter(value => Math.abs(value - Math.round(value)) > 1e-6).length;
    const plausibleRatio = plausible / nums.length;
    const fractionalRatio = fractional / nums.length;
    if (plausibleRatio < 0.95 || fractionalRatio < 0.5) return { ok: false, confidence: 0 };

    const diffs = [];
    let inc = 0;
    let dec = 0;
    for (let i = 1; i < nums.length; i++) {
        const diff = nums[i] - nums[i - 1];
        if (diff > 0) {
            inc++;
            diffs.push(diff);
        } else if (diff < 0) {
            dec++;
            diffs.push(-diff);
        }
    }
    if (!diffs.length) return { ok: false, confidence: 0 };

    const orderRatio = Math.max(inc, dec) / (nums.length - 1);
    const span = Math.max(...nums) - Math.min(...nums);
    const sortedDiffs = diffs.slice().sort((a, b) => a - b);
    const medianStep = sortedDiffs[Math.floor(sortedDiffs.length / 2)];
    const yearLikeStep = medianStep > 1 / 500 && medianStep <= 1.25;

    if (orderRatio < 0.75 || span < 0.25 || !yearLikeStep) return { ok: false, confidence: 0 };

    const confidence = (
        Math.min(1, plausibleRatio) * 0.25 +
        Math.min(1, fractionalRatio) * 0.25 +
        Math.min(1, orderRatio) * 0.30 +
        Math.min(1, span / 3) * 0.20
    );
    return { ok: true, confidence };
}

function profileMatlabDatenum(values) {
    const nums = (values || []).filter(Number.isFinite);
    if (nums.length < 3) return { ok: false, confidence: 0 };

    const plausible = nums.filter(value => {
        if (value < MATLAB_DATENUM_MIN || value > MATLAB_DATENUM_MAX) return false;
        const year = new Date(matlabDatenumToMs(value)).getUTCFullYear();
        return year >= 1900 && year <= 2200;
    }).length;
    const plausibleRatio = plausible / nums.length;
    if (plausibleRatio < 0.95) return { ok: false, confidence: 0 };

    let inc = 0;
    let dec = 0;
    let nonZeroDiffs = 0;
    for (let i = 1; i < nums.length; i++) {
        const diff = nums[i] - nums[i - 1];
        if (diff > 0) {
            inc++;
            nonZeroDiffs++;
        } else if (diff < 0) {
            dec++;
            nonZeroDiffs++;
        }
    }
    if (!nonZeroDiffs) return { ok: false, confidence: 0 };

    const orderRatio = Math.max(inc, dec) / (nums.length - 1);
    const span = Math.max(...nums) - Math.min(...nums);
    if (orderRatio < 0.75 || span < 1 / 86400) return { ok: false, confidence: 0 };

    const confidence = (
        Math.min(1, plausibleRatio) * 0.35 +
        Math.min(1, orderRatio) * 0.35 +
        Math.min(1, span / 30) * 0.30
    );
    return { ok: true, confidence };
}

// ---------------------------------------------------------------------------
// Result builder + parse closures
// ---------------------------------------------------------------------------

function buildResult(best, headers, delimiter, warnings) {
    const sourceHeaders = best.sourceIndexes.map(i => headers[i]?.raw ?? '');

    if (best.format && best.format.ambiguous) {
        warnings.push(
            `Date order ${best.format.dateOrder} chosen from ambiguous data; pass options.preferredDateOrder to override.`,
        );
    }

    let parse;
    let name;
    let description;

    if (best.kind === 'numeric') {
        const idx = best.sourceIndexes[0];
        parse = (row) => parseCsvNumber(row?.[idx], delimiter);
        const h = parseHeader(headers[idx]?.raw, idx);
        name = h.name;
        description = h.description || `Numeric time from column "${name}"`;
    } else if (best.descTag === 'iso-datetime') {
        const idx = best.sourceIndexes[0];
        parse = (row) => parseIsoMs(row?.[idx]);
        const h = parseHeader(headers[idx]?.raw, idx);
        name = h.name;
        description = '[datetime]';
    } else if (best.descTag === 'partial-year-month') {
        const idx = best.sourceIndexes[0];
        parse = (row) => parsePartialYearMonthMs(row?.[idx]);
        const h = parseHeader(headers[idx]?.raw, idx);
        name = h.name;
        description = '[datetime, day 01 assumed]';
    } else if (best.descTag === 'slash-date' || best.descTag === 'dash-date' || best.descTag === 'dot-date') {
        const idx = best.sourceIndexes[0];
        const order = best.format.dateOrder;
        const sep = dateSeparatorForStrategy(best.descTag);
        parse = (row) => parseFlexibleDateMs(row?.[idx], order, sep);
        const h = parseHeader(headers[idx]?.raw, idx);
        name = h.name;
        description = '[datetime]';
    } else if (best.descTag === 'yearless-date-time') {
        const idx = best.sourceIndexes[0];
        const order = best.format.dateOrder;
        parse = (row) => parseYearlessDateTimeMs(row?.[idx], order);
        const h = parseHeader(headers[idx]?.raw, idx);
        name = h.name;
        description = '[datetime, year 2001 assumed]';
    } else if (best.descTag === 'month-name-date') {
        const idx = best.sourceIndexes[0];
        parse = (row) => parseMonthNameDateMs(row?.[idx]);
        const h = parseHeader(headers[idx]?.raw, idx);
        name = h.name;
        description = '[datetime]';
    } else if (best.descTag === 'decimal-year') {
        const idx = best.sourceIndexes[0];
        parse = (row) => decimalYearToMs(parseCsvNumber(row?.[idx], delimiter));
        const h = parseHeader(headers[idx]?.raw, idx);
        name = h.name;
        description = '[decimal year]';
    } else if (best.descTag === 'matlab-datenum') {
        const idx = best.sourceIndexes[0];
        parse = (row) => matlabDatenumToMs(parseCsvNumber(row?.[idx], delimiter));
        const h = parseHeader(headers[idx]?.raw, idx);
        name = h.name;
        description = '[MATLAB datenum]';
    } else if (best.descTag === 'excel-serial') {
        const idx = best.sourceIndexes[0];
        parse = (row) => excelSerialToMs(parseCsvNumber(row?.[idx], delimiter));
        const h = parseHeader(headers[idx]?.raw, idx);
        name = h.name;
        description = '[datetime]';
    } else if (best.mode === 'split') {
        const dIdx = best.sourceIndexes[0];
        const tIdx = best.sourceIndexes[1];
        const order = best.format.dateOrder;
        parse = (row) => combineDateAndTimeMs(row?.[dIdx], row?.[tIdx], order);
        const dh = parseHeader(headers[dIdx]?.raw, dIdx);
        const th = parseHeader(headers[tIdx]?.raw, tIdx);
        name = `${dh.name} ${th.name}`;
        description = '[datetime]';
    }

    return {
        ok: true,
        kind: best.kind,
        mode: best.mode,
        strategy: best.descTag || best.mode,
        sourceIndexes: best.sourceIndexes.slice(),
        sourceHeaders,
        name,
        description,
        confidence: round3(best.score),
        format: { ...best.format },
        parse,
        warnings,
    };
}

// ---------------------------------------------------------------------------
// Datetime parsers used by the closures
// ---------------------------------------------------------------------------

function parseIsoMs(cell) {
    if (cell == null || cell === '') return NaN;
    const s = String(cell).trim();
    const m = s.match(
        /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s?(Z|[+\-]\d{2}(?::?\d{2})?)?)?$/,
    );
    if (!m) return NaN;

    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    if (!isValidDate(y, mo, d)) return NaN;

    const H = m[4] != null ? +m[4] : 0;
    const Mi = m[5] != null ? +m[5] : 0;
    const Se = m[6] != null ? +m[6] : 0;
    const Ms = m[7] != null ? Math.round(Number('0.' + m[7]) * 1000) : 0;
    const tz = m[8];

    if (tz) {
        const normalizedTz = tz === 'Z' ? 'Z' : /^[+\-]\d{2}$/.test(tz) ? `${tz}:00` : tz.replace(/^([+\-]\d{2})(\d{2})$/, '$1:$2');
        const padded = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
            + `T${String(H).padStart(2, '0')}:${String(Mi).padStart(2, '0')}:${String(Se).padStart(2, '0')}.${String(Ms).padStart(3, '0')}${normalizedTz}`;
        const ms = Date.parse(padded);
        return Number.isFinite(ms) ? ms : NaN;
    }

    return Date.UTC(y, mo - 1, d, H, Mi, Se, Ms);
}

function parsePartialYearMonthMs(cell) {
    if (cell == null || cell === '') return NaN;
    const m = String(cell).trim().match(/^(\d{4})([/-])(\d{1,2})$/);
    if (!m) return NaN;
    const y = +m[1];
    const mo = +m[3];
    const d = 1;
    if (!isValidDate(y, mo, d)) return NaN;
    return Date.UTC(y, mo - 1, d, 0, 0, 0, 0);
}

function parseFlexibleDateMs(cell, order, sep) {
    if (cell == null || cell === '') return NaN;
    const re = sep === '-'
        ? /^(\d{1,4})-(\d{1,2})-(\d{1,4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?:\s*([AP]M))?)?$/i
        : sep === '.'
            ? /^(\d{1,4})\.(\d{1,2})\.(\d{1,4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?:\s*([AP]M))?)?$/i
            : /^(\d{1,4})\/(\d{1,2})\/(\d{1,4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?:\s*([AP]M))?)?$/i;
    const m = String(cell).trim().match(re);
    if (!m) return NaN;

    let y, mo, d;
    const a = +m[1], b = +m[2], c = +m[3];
    if (order === 'YMD' || String(m[1]).length === 4) { y = a; mo = b; d = c; }
    else if (order === 'DMY') { d = a; mo = b; y = c; }
    else                      { mo = a; d = b; y = c; }
    if (y < 100) y += (y >= 70 ? 1900 : 2000);
    if (!isValidDate(y, mo, d)) return NaN;

    let H = m[4] != null ? +m[4] : 0;
    const Mi = m[5] != null ? +m[5] : 0;
    const Se = m[6] != null ? +m[6] : 0;
    const Ms = m[7] != null ? Math.round(Number('0.' + m[7]) * 1000) : 0;
    const ampm = m[8] ? String(m[8]).toUpperCase() : '';
    if (ampm) {
        if (H < 1 || H > 12) return NaN;
        H = (H % 12) + (ampm === 'PM' ? 12 : 0);
    }

    return Date.UTC(y, mo - 1, d, H, Mi, Se, Ms);
}

function combineDateAndTimeMs(dateCell, timeCell, order) {
    if (dateCell == null || dateCell === '') return NaN;
    const dateStr = String(dateCell);
    const timeStr = timeCell == null ? '' : String(timeCell);

    const mn = matchMonthNameDate(dateStr);
    if (mn) {
        let y = mn.y;
        if (y < 100) y += (y >= 70 ? 1900 : 2000);
        if (!isValidDate(y, mn.mo, mn.d)) return NaN;
        const time = parseTimeOfDay(timeStr);
        if (!time) return NaN;
        return Date.UTC(y, mn.mo - 1, mn.d, time.H, time.Mi, time.Se, time.Ms);
    }

    const sep = dateStr.includes('/') ? '/'
              : dateStr.includes('-') ? '-'
              : /^\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/.test(dateStr.trim()) ? '.'
              : null;
    if (!sep) return NaN;

    const time = timeStr.trim() ? parseTimeOfDay(timeStr) : { H: 0, Mi: 0, Se: 0, Ms: 0 };
    if (!time) return NaN;
    const { H, Mi, Se, Ms } = time;

    const re = sep === '-'
        ? /^(\d{1,4})-(\d{1,2})-(\d{1,4})$/
        : sep === '.'
            ? /^(\d{1,4})\.(\d{1,2})\.(\d{1,4})$/
            : /^(\d{1,4})\/(\d{1,2})\/(\d{1,4})$/;
    const dm = dateStr.trim().match(re);
    let y, mo, d;
    if (dm) {
        const a = +dm[1], b = +dm[2], c = +dm[3];
        if (order === 'YMD')      { y = a; mo = b; d = c; }
        else if (order === 'DMY') { d = a; mo = b; y = c; }
        else                      { mo = a; d = b; y = c; }
    } else {
        const pm = dateStr.trim().match(sep === '-'
            ? /^(\d{1,4})-(\d{1,4})$/
            : sep === '.'
                ? /^(\d{1,4})\.(\d{1,4})$/
                : /^(\d{1,4})\/(\d{1,4})$/);
        if (!pm) return NaN;
        const a = +pm[1], b = +pm[2];
        if (String(pm[1]).length === 4 || order === 'YMD') {
            y = a; mo = b; d = 1;
        } else if (order === 'DMY') {
            y = 2001; d = a; mo = b;
        } else {
            y = 2001; mo = a; d = b;
        }
    }
    if (y < 100) y += (y >= 70 ? 1900 : 2000);
    if (!isValidDate(y, mo, d)) return NaN;

    return Date.UTC(y, mo - 1, d, H, Mi, Se, Ms);
}

const CUSTOM_PATTERN_REGEX = {
    'AM/PM': '(?<ampm>[AaPp]\\.?[Mm]\\.?)',
    yyyy: '(?<year>\\d{4})',
    yy: '(?<year2>\\d{2})',
    EEEE: '(?<weekday>[\\p{L}-]{2,14}\\.?)',
    EEE: '(?<weekday>[\\p{L}-]{2,14}\\.?)',
    MMMM: '(?<monthName>[\\p{L}.]{3,12})',
    MMM: '(?<monthName>[\\p{L}.]{3,12})',
    MM: '(?<month>\\d{2})',
    M: '(?<month>\\d{1,2})',
    dd: '(?<day>\\d{2})',
    d: '(?<day>\\d{1,2})',
    HH: '(?<hour>\\d{2})',
    H: '(?<hour>\\d{1,2})',
    hh: '(?<hour12>\\d{2})',
    h: '(?<hour12>\\d{1,2})',
    mm: '(?<minute>\\d{2})',
    m: '(?<minute>\\d{1,2})',
    ss: '(?<second>\\d{2})',
    s: '(?<second>\\d{1,2})',
    XXX: '(?<zone>Z|[+\\-]\\d{2}(?::?\\d{2})?)',
};
const customPatternCache = new Map();

function customPatternRegex(pattern) {
    let cached = customPatternCache.get(pattern);
    if (cached !== undefined) return cached;
    const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let regex = '';
    const used = new Set();
    for (const { token, literal } of tokenizeDatetimePattern(pattern)) {
        if (token) {
            const group = token.part === 'fraction'
                ? '(?<ms>\\d{1,9})'
                : CUSTOM_PATTERN_REGEX[token.key];
            const name = group.match(/\(\?<(\w+)>/)?.[1];
            // A part written twice ("dd/MM/yyyy dd") cannot be two groups of
            // one name; the second is matched and ignored.
            regex += name && used.has(name) ? group.replace(/\(\?<\w+>/, '(?:') : group;
            if (name) used.add(name);
            continue;
        }
        // One space in the pattern stands for any run of spaces in the file.
        regex += literal.replace(/\s+/g, ' ').split(' ').map(escapeRegex).join('\\s+');
    }
    try {
        cached = new RegExp(`^${regex}$`, 'iu');
    } catch (_) {
        cached = null;
    }
    if (customPatternCache.size > 64) customPatternCache.clear();
    customPatternCache.set(pattern, cached);
    return cached;
}

function parseCustomFormatMs(cell, pattern) {
    if (cell == null || cell === '' || !pattern) return NaN;
    const re = customPatternRegex(pattern);
    if (!re) return NaN;
    const match = String(cell).trim().match(re);
    if (!match?.groups) return NaN;
    let y = match.groups.year != null
        ? Number(match.groups.year)
        : match.groups.year2 != null ? Number(match.groups.year2) : 2001;
    if (y < 100) y += (y >= 70 ? 1900 : 2000);
    const mo = match.groups.monthName != null
        ? lookupMonthName(match.groups.monthName)
        : match.groups.month != null ? Number(match.groups.month) : 1;
    const d = match.groups.day != null ? Number(match.groups.day) : 1;
    let H = match.groups.hour != null
        ? Number(match.groups.hour)
        : match.groups.hour12 != null ? Number(match.groups.hour12) : 0;
    const ampm = match.groups.ampm ? String(match.groups.ampm).replace(/\./g, '').toUpperCase() : '';
    if (match.groups.hour12 != null) {
        if (H < 1 || H > 12 || !ampm) return NaN;
        H = (H % 12) + (ampm === 'PM' ? 12 : 0);
    } else if (ampm && H >= 1 && H <= 12) {
        H = (H % 12) + (ampm === 'PM' ? 12 : 0);
    }
    const Mi = match.groups.minute != null ? Number(match.groups.minute) : 0;
    const Se = match.groups.second != null ? Number(match.groups.second) : 0;
    const Ms = match.groups.ms != null ? Math.round(Number('0.' + match.groups.ms) * 1000) : 0;
    if (![y, mo, d, H, Mi, Se, Ms].every(Number.isFinite)) return NaN;
    if (!isValidDate(y, mo, d)) return NaN;
    if (H < 0 || H > 24 || Mi < 0 || Mi > 59 || Se < 0 || Se > 59 || Ms < 0 || Ms > 1000) return NaN;
    if (H === 24 && (Mi !== 0 || Se !== 0 || Ms !== 0)) return NaN;
    const zone = match.groups.zone ? tzOffsetMinutes(match.groups.zone) : 0;
    return Date.UTC(y, mo - 1, d, H, Mi, Se, Ms) - zone * 60000;
}

function parsePartsDateTimeMs(timeSource, row, delimiter = ',', decimalSeparator = 'auto', thousandsSeparator = 'auto') {
    const parts = timeSource?.format?.parts || {};
    const hasPart = ['year', 'month', 'day', 'hour', 'minute', 'second']
        .some(name => Number.isInteger(parts[name]) && parts[name] >= 0);
    if (!hasPart) return NaN;
    const readPart = (name, fallback = 0) => {
        const index = parts[name];
        if (index === null || index === undefined || index === '') return fallback;
        const value = parseCsvNumber(row?.[index], delimiter, decimalSeparator, thousandsSeparator);
        return Number.isFinite(value) ? value : NaN;
    };

    let y = readPart('year', 2001);
    const mo = readPart('month', 1);
    const d = readPart('day', 1);
    const H = readPart('hour', 0);
    const Mi = readPart('minute', 0);
    const secondValue = readPart('second', 0);
    if (y < 100) y += (y >= 70 ? 1900 : 2000);
    const Se = Math.trunc(secondValue);
    const Ms = Math.round((secondValue - Se) * 1000);

    if (![y, mo, d, H, Mi, secondValue].every(Number.isFinite)) return NaN;
    if (!isValidDate(y, mo, d)) return NaN;
    if (H < 0 || H > 24 || Mi < 0 || Mi > 59 || Se < 0 || Se > 59 || Ms < 0 || Ms > 999) return NaN;
    if (H === 24 && (Mi !== 0 || Se !== 0 || Ms !== 0)) return NaN;
    return Date.UTC(y, mo - 1, d, H, Mi, Se, Ms);
}

function parseYearlessDateTimeMs(cell, order) {
    if (cell == null || cell === '') return NaN;
    const m = String(cell).trim().match(
        /^(\d{1,2})[/-](\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?:\s*([AP]M))?$/i,
    );
    if (!m) return NaN;

    const a = +m[1];
    const b = +m[2];
    const mo = order === 'DMY' ? b : a;
    const d = order === 'DMY' ? a : b;
    let H = +m[3];
    const Mi = +m[4];
    const Se = m[5] != null ? +m[5] : 0;
    const Ms = m[6] != null ? Math.round(Number('0.' + m[6]) * 1000) : 0;
    const ampm = m[7] ? String(m[7]).toUpperCase() : '';
    if (ampm) {
        if (H < 1 || H > 12) return NaN;
        H = (H % 12) + (ampm === 'PM' ? 12 : 0);
    }
    const baseYear = 2001;
    if (!isValidDate(baseYear, mo, d)) return NaN;
    if (H < 0 || H > 24 || Mi < 0 || Mi > 59 || Se < 0 || Se > 59 || Ms < 0 || Ms > 999) return NaN;
    if (H === 24 && (Mi !== 0 || Se !== 0 || Ms !== 0)) return NaN;

    return Date.UTC(baseYear, mo - 1, d, H, Mi, Se, Ms);
}

function parseMonthNameDateMs(cell) {
    if (cell == null || cell === '') return NaN;
    const m = matchMonthNameDate(cell);
    if (!m) return NaN;

    let y = m.y;
    if (y < 100) y += (y >= 70 ? 1900 : 2000);
    if (!isValidDate(y, m.mo, m.d)) return NaN;
    if (m.H > 24 || m.Mi > 59 || m.Se > 59) return NaN;

    return Date.UTC(y, m.mo - 1, m.d, m.H, m.Mi, m.Se, m.Ms) - m.tzOffsetMinutes * 60000;
}

function parseTimeOfDay(cell) {
    const t = String(cell ?? '').trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?:\s*([AP]M))?$/i);
    if (!t) return null;
    let H = +t[1];
    const ampm = t[5] ? String(t[5]).toUpperCase() : '';
    if (ampm) {
        if (H < 1 || H > 12) return null;
        H = (H % 12) + (ampm === 'PM' ? 12 : 0);
    }
    return {
        H,
        Mi: +t[2],
        Se: t[3] != null ? +t[3] : 0,
        Ms: t[4] != null ? Math.round(Number('0.' + t[4]) * 1000) : 0,
    };
}

/** The character between the date parts for a slash/dash/dot strategy. */
export function dateSeparatorForStrategy(strategy) {
    if (strategy === 'dash-date') return '-';
    if (strategy === 'dot-date') return '.';
    return '/';
}

function excelSerialToMs(serial) {
    if (!Number.isFinite(serial)) return NaN;
    return Math.round((serial - EXCEL_TO_UNIX_DAYS) * MS_PER_DAY);
}

function matlabDatenumToMs(datenum) {
    if (!Number.isFinite(datenum)) return NaN;
    return Math.round((datenum - MATLAB_TO_UNIX_DAYS) * MS_PER_DAY);
}

function decimalYearToMs(value) {
    if (!Number.isFinite(value)) return NaN;
    const year = Math.floor(value);
    if (year < DECIMAL_YEAR_MIN || year > DECIMAL_YEAR_MAX) return NaN;
    const fraction = value - year;
    if (fraction < -1e-9 || fraction >= 1 + 1e-9) return NaN;
    const days = isLeapYear(year) ? 366 : 365;
    return Math.round(Date.UTC(year, 0, 1) + fraction * days * MS_PER_DAY);
}

function isLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidDate(y, mo, d) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// ---------------------------------------------------------------------------
// The detected format, said as a pattern
// ---------------------------------------------------------------------------

// Letters that are pattern tokens: literal text containing one is quoted.
const PATTERN_LETTERS = /[yEMdHhmsSXA]/;

function quotePatternLiteral(text) {
    if (!text) return '';
    if (text.includes("'")) return text.replace(/'/g, "''");
    return PATTERN_LETTERS.test(text) ? `'${text}'` : text;
}

const TIME_IN_CELL_RE = /(\d{1,2})([:h])(\d{2})(?::(\d{2})(?:([.,])(\d+))?)?(?:(\s*)([AaPp]\.?[Mm]\.?))?(?:(\s*)(Z|UTC|GMT|[+\-]\d{2}(?::?\d{2})?))?$/;

/**
 * One cell's pattern, as a list of parts with the widths each numeric part
 * was written with, so a column's cells can be merged ("d" when any day has
 * one digit, "dd" when every day has two).
 */
function cellPatternParts(cell, order) {
    let s = String(cell ?? '').trim();
    if (!s) return null;
    const parts = [];
    const words = { months: [], weekdays: [] };

    const wm = s.match(/^([\p{L}-]{2,14})(\.?,?\s+)(?=[\d\p{L}])/u);
    if (wm) {
        const weekday = lookupWeekdayName(wm[1]);
        // "Mar 1 2000" is March: a word that is both a month and a weekday is
        // the weekday only when another month name follows it.
        const rest = s.slice(wm[0].length);
        const isMonthToo = lookupMonthName(wm[1]) != null
            && !(rest.match(/\p{L}+/gu) || []).some(word => lookupMonthName(word) != null);
        if (weekday && !isMonthToo) {
            const full = weekday.full.size > 0 && normalizeNameToken(wm[1]).length > 3;
            parts.push({ kind: full ? 'EEEE' : 'EEE' });
            parts.push({ literal: wm[2] });
            words.weekdays.push(wm[1]);
            s = s.slice(wm[0].length);
        }
    }

    // The clock time, if any, ends the cell (asctime puts the year after it).
    let datePart = s;
    let timeMatch = null;
    let afterTime = '';
    const asctime = s.match(/^(.*?\s)(\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?)(\s+\d{4})$/);
    if (asctime) {
        datePart = asctime[1];
        timeMatch = asctime[2].match(TIME_IN_CELL_RE);
        afterTime = asctime[3];
    } else {
        const tm = s.match(TIME_IN_CELL_RE);
        if (tm && tm.index > 0) {
            datePart = s.slice(0, tm.index);
            timeMatch = tm;
        } else if (tm && tm.index === 0) {
            datePart = '';
            timeMatch = tm;
        }
    }
    let joiner = '';
    if (timeMatch && datePart) {
        const j = datePart.match(/(\s*(?:T|at|a|à|um|alle|às|las|los|,|@)?\s*)$/u);
        joiner = j ? j[1] : '';
        datePart = datePart.slice(0, datePart.length - joiner.length);
    }

    // Date: runs of digits, runs of letters, and what lies between them.
    const runs = datePart.match(/\d+|\p{L}+\.?|[^\d\p{L}]+/gu) || [];
    const numeric = runs.filter(run => /^\d+$/.test(run));
    const hasMonthWord = runs.some(run => /^\p{L}/u.test(run) && lookupMonthName(run) != null);
    let roles;
    if (hasMonthWord) {
        const yearAt = numeric.findIndex(run => run.length === 4);
        if (numeric.length === 1) roles = asctime || numeric[0].length <= 2 ? ['d'] : ['y'];
        else if (yearAt === 0 || (yearAt < 0 && order === 'YMD')) roles = ['y', 'd'];
        else roles = ['d', 'y'];
    } else if (numeric.length === 3) {
        if (numeric[0].length === 4 || order === 'YMD') roles = ['y', 'M', 'd'];
        else if (order === 'MDY') roles = ['M', 'd', 'y'];
        else roles = ['d', 'M', 'y'];
    } else if (numeric.length === 2) {
        // A partial date: year and month, or month and day.
        if (numeric[0].length === 4) roles = ['y', 'M'];
        else if (order === 'DMY') roles = ['d', 'M'];
        else roles = ['M', 'd'];
    } else {
        roles = numeric.map(() => '?');
    }
    let k = 0;
    for (const run of runs) {
        if (/^\d+$/.test(run)) {
            const role = roles[k++] || '?';
            if (role === 'y') parts.push({ kind: run.length >= 4 ? 'yyyy' : 'yy' });
            else if (role === 'M') parts.push({ kind: 'M', width: run.length });
            else if (role === 'd') parts.push({ kind: 'd', width: run.length });
            else parts.push({ literal: run });
        } else if (/^\p{L}/u.test(run)) {
            const word = run.replace(/\.$/, '');
            if (lookupMonthName(word) != null) {
                const entry = MONTH_INDEX.get(normalizeNameToken(word));
                const full = !!entry && entry.full.size > 0 && normalizeNameToken(word).length > 3;
                parts.push({ kind: 'month-name', full });
                if (run.endsWith('.')) parts.push({ literal: '.' });
                words.months.push(word);
            } else {
                parts.push({ literal: run });
            }
        } else {
            parts.push({ literal: run });
        }
    }

    if (timeMatch) {
        if (joiner) parts.push({ literal: joiner });
        const hasMeridiem = !!timeMatch[8];
        parts.push({ kind: hasMeridiem ? 'h' : 'H', width: timeMatch[1].length });
        parts.push({ literal: timeMatch[2] === 'h' ? 'h' : ':' });
        parts.push({ kind: 'mm' });
        if (timeMatch[4] != null) {
            parts.push({ literal: ':' });
            parts.push({ kind: 'ss' });
            if (timeMatch[6] != null) {
                parts.push({ literal: timeMatch[5] });
                parts.push({ kind: 'S', width: timeMatch[6].length });
            }
        }
        if (hasMeridiem) {
            parts.push({ literal: timeMatch[7] || '' });
            parts.push({ kind: 'AM/PM' });
        }
        if (timeMatch[10]) {
            parts.push({ literal: timeMatch[9] || '' });
            parts.push(/^[+\-]/.test(timeMatch[10]) ? { kind: 'XXX' } : { literal: timeMatch[10] });
        }
        if (afterTime) {
            parts.push({ literal: afterTime.match(/^\s+/)[0] });
            parts.push({ kind: 'yyyy' });
        }
    }
    return { parts: parts.filter(part => part.kind || part.literal), words };
}

function partsKey(parts) {
    return parts.map(part => part.kind || `"${part.literal}"`).join('|');
}

function renderPatternParts(parts) {
    return parts.map(part => {
        if (part.literal != null) return quotePatternLiteral(part.literal);
        switch (part.kind) {
            case 'M': return part.minWidth === 1 ? 'M' : 'MM';
            case 'd': return part.minWidth === 1 ? 'd' : 'dd';
            case 'H': return part.minWidth === 1 ? 'H' : 'HH';
            case 'h': return part.minWidth === 1 ? 'h' : 'hh';
            case 'S': return 'S'.repeat(Math.max(1, part.maxWidth || 3));
            case 'month-name': return part.anyFull ? 'MMMM' : 'MMM';
            default: return part.kind;
        }
    }).join('');
}

/**
 * The pattern a date column is written in, read from its cells: what the
 * parsing dialog shows for "Format: Auto" ("d MMMM yyyy HH:mm:ss", and the
 * language when months are named) and what "Custom" starts from.
 *
 * The cells are described one by one and the most common shape wins; widths
 * are merged across them, so a column with "9 janvier" and "10 janvier"
 * reads "d", one with "09" and "10" reads "dd".
 *
 * @param {string[]} values the column's cells
 * @param {{ dateOrder?: 'YMD'|'DMY'|'MDY' }} [options]
 * @returns {{ pattern: string, language: string|null } | null}
 */
export function describeDatetimeValues(values, options = {}) {
    const order = options.dateOrder || 'YMD';
    const shapes = new Map();
    const months = [];
    const weekdays = [];
    let counted = 0;
    for (const value of values || []) {
        if (counted >= 200) break;
        const described = cellPatternParts(value, order);
        if (!described || !described.parts.length) continue;
        counted++;
        months.push(...described.words.months);
        weekdays.push(...described.words.weekdays);
        const key = partsKey(described.parts);
        const shape = shapes.get(key) || { parts: described.parts.map(part => ({ ...part })), count: 0 };
        described.parts.forEach((part, i) => {
            const merged = shape.parts[i];
            if (part.width != null) {
                merged.minWidth = Math.min(merged.minWidth ?? Infinity, part.width);
                merged.maxWidth = Math.max(merged.maxWidth ?? 0, part.width);
            }
            if (part.kind === 'month-name' && part.full) merged.anyFull = true;
        });
        shape.count++;
        shapes.set(key, shape);
    }
    if (!shapes.size) return null;
    const best = [...shapes.values()].sort((a, b) => b.count - a.count)[0];
    return {
        pattern: renderPatternParts(best.parts),
        language: dateNamesLanguage([...months, ...weekdays]),
    };
}

/**
 * The detected time source's format as a pattern, from the rows it was
 * detected on. Null for sources that are not written as text dates (numbers,
 * Excel serials, an index): those are named, not patterned.
 */
export function describeTimeSourcePattern(timeSource, rows, options = {}) {
    if (!timeSource?.ok || timeSource.kind !== 'datetime') return null;
    const strategy = timeSource.strategy || timeSource.mode;
    if (['excel-serial', 'matlab-datenum', 'decimal-year', 'parts'].includes(strategy)) return null;
    const indexes = Array.isArray(timeSource.sourceIndexes) ? timeSource.sourceIndexes : [];
    if (!indexes.length) return null;
    const limit = Number(options.limit) || 200;
    const order = timeSource.format?.dateOrder || 'YMD';
    const column = index => (rows || []).slice(0, limit * 2)
        .map(row => String(row?.[index] ?? '').trim())
        .filter(Boolean)
        .slice(0, limit);
    if (strategy === 'custom-format') {
        const pattern = timeSource.format?.pattern || '';
        const described = describeDatetimeValues(column(indexes[0]), { dateOrder: order });
        return pattern ? { pattern, language: described?.language || null } : null;
    }
    if (timeSource.mode === 'split' && indexes.length >= 2) {
        const date = describeDatetimeValues(column(indexes[0]), { dateOrder: order });
        const time = describeDatetimeValues(column(indexes[1]), { dateOrder: order });
        if (!date) return null;
        return {
            pattern: time ? `${date.pattern} + ${time.pattern}` : date.pattern,
            language: date.language,
            datePattern: date.pattern,
            timePattern: time?.pattern || null,
        };
    }
    return describeDatetimeValues(column(indexes[0]), { dateOrder: order });
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function takeSample(rows, n) {
    const out = [];
    for (let i = 0; i < rows.length && out.length < n; i++) {
        const r = rows[i];
        if (r && r.some(c => c !== '' && c != null)) out.push(r);
    }
    return out;
}

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
function round3(x)  { return Math.round(x * 1000) / 1000; }
