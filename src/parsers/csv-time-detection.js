/**
 * CSV time-axis detection.
 *
 * Current CSV time detector. Same public contract, plus a
 * stronger heuristic detector and the ability to recognise:
 *   - numeric time anywhere (not just first column)
 *   - ISO datetime, slash/dash dates, month-name dates, Excel serials
 *   - split Date + Time column pairs
 *
 * Public API:
 *   detectCsvTimeAxis(rawHeaders, dataRows, { delimiter, preferredDateOrder })
 *   parseCsvNumber(rawValue, delimiter = ',')
 *   parseCsvText(text, { delimiter })
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
    { kw: 'time',       weight: 0.85, kind: 'time' },
    { kw: 'temps',      weight: 0.85, kind: 'time' },
    { kw: 'heure',      weight: 0.85, kind: 'time' },
    { kw: 'horaire',    weight: 0.80, kind: 'time' },
    { kw: 'day',        weight: 0.55, kind: 'date' },
    { kw: 'jour',       weight: 0.55, kind: 'date' },
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

const MONTH_LOOKUP = {
    jan: 1, january: 1, janv: 1, janvier: 1, enero: 1,
    feb: 2, february: 2, fev: 2, fevr: 2, fevrier: 2, febrero: 2,
    mar: 3, march: 3, mars: 3, marzo: 3,
    apr: 4, april: 4, avr: 4, avril: 4, abril: 4,
    may: 5, mai: 5, mayo: 5,
    jun: 6, june: 6, juin: 6, junio: 6,
    jul: 7, july: 7, juil: 7, juillet: 7, julio: 7,
    aug: 8, august: 8, aou: 8, aout: 8, agosto: 8,
    sep: 9, sept: 9, september: 9, septembre: 9, septiembre: 9,
    oct: 10, october: 10, octobre: 10, octubre: 10,
    nov: 11, november: 11, novembre: 11, noviembre: 11,
    dec: 12, december: 12, decembre: 12, diciembre: 12,
};

// ---------------------------------------------------------------------------
// parseCsvNumber - exported public helper
// ---------------------------------------------------------------------------

export function parseCsvNumber(rawValue, delimiter = ',') {
    const raw = String(rawValue ?? '').trim();
    if (!raw) return NaN;

    // Strip internal whitespace and translate Fortran-style D-exponents.
    const normalized = raw
        .replace(/\s+/g, '')
        .replace(/[dD]([+-]?\d+)$/, 'e$1');

    if (/^[+-]?inf(?:inity)?$/i.test(normalized)) {
        return normalized.startsWith('-') ? -Infinity : Infinity;
    }
    if (/^nan$/i.test(normalized)) return NaN;

    // Decimal comma is only allowed when the cell delimiter is not comma.
    const decimalNormalized = (delimiter !== ',' && normalized.includes(',') && !normalized.includes('.'))
        ? normalized.replace(',', '.')
        : normalized;

    return Number(decimalNormalized);
}

export function parseCsvText(text, options = {}) {
    const delimiter = options.delimiter || sniffDelimiter(String(text ?? ''));
    const rows = parseCsvNative(String(text ?? ''), delimiter)
        .map(row => row.map(cell => cell.trim()))
        .filter(row => row.some(cell => cell !== ''));

    return {
        headers: rows[0] || [],
        rows: rows.slice(1),
        delimiter,
    };
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

function buildIndexResult(warnings) {
    return {
        ok: true,
        kind: 'index',
        mode: 'generated-index',
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
function parseHeader(rawHeader, fallbackIndex) {
    const fallback = fallbackIndex === 0 ? 'time' : `column_${fallbackIndex + 1}`;
    const raw = String(rawHeader ?? '').trim();
    if (!raw) return { name: fallback, description: '' };

    let m = raw.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
    if (m) return { name: sanitizeName(m[1], fallback), description: `[${m[2].trim()}]` };

    m = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (m) return { name: sanitizeName(m[1], fallback), description: `[${m[2].trim()}]` };

    return { name: sanitizeName(raw, fallback), description: '' };
}

function sanitizeName(name, fallback) {
    const cleaned = String(name ?? '').trim();
    return cleaned || fallback;
}

function lookupMonthName(token) {
    const norm = String(token ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\./g, '');
    return MONTH_LOOKUP[norm] ?? null;
}

function matchMonthNameDate(cell) {
    const s = String(cell ?? '').trim();
    const monthToken = '[\\p{L}.]{3,12}';
    const timePart = '(?:[T\\s]+(\\d{1,2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d+))?)?)?';

    let m = s.match(new RegExp(`^(\\d{1,2})[-\\s.,]+(${monthToken})[-\\s.,]+(\\d{2,4})${timePart}$`, 'u'));
    if (m) {
        const mo = lookupMonthName(m[2]);
        if (mo != null) return buildMonthNameMatch('DMY', +m[1], mo, +m[3], m);
    }

    m = s.match(new RegExp(`^(${monthToken})[-\\s.,]+(\\d{1,2}),?[-\\s.,]+(\\d{2,4})${timePart}$`, 'u'));
    if (m) {
        const mo = lookupMonthName(m[1]);
        if (mo != null) return buildMonthNameMatch('MDY', +m[2], mo, +m[3], m);
    }

    return null;
}

function buildMonthNameMatch(order, d, mo, y, m) {
    return {
        order,
        d,
        mo,
        y,
        H: m[4] != null ? +m[4] : 0,
        Mi: m[5] != null ? +m[5] : 0,
        Se: m[6] != null ? +m[6] : 0,
        Ms: m[7] != null ? Math.round(Number('0.' + m[7]) * 1000) : 0,
        hasTime: m[4] != null,
    };
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
        slashDate: 0,          // a/b/c
        dashDate: 0,           // a-b-c (when leading part is 1-2 digits, so not ISO)
        yearlessDateTime: 0,   // MM/DD HH:mm:ss or DD/MM HH:mm:ss
        yearlessSlash: 0,
        yearlessDash: 0,
        monthNameDate: 0,      // 01-Aug-2022, 01 aout 2022, Aug 01 2022
        monthNameDmy: 0,
        monthNameMdy: 0,
        yearlessCounts: { firstGt12: 0, secondGt12: 0, ambig: 0, total: 0 },
        slashCounts: { firstGt12: 0, secondGt12: 0, ambig: 0, total: 0 },
        dashCounts:  { firstGt12: 0, secondGt12: 0, ambig: 0, total: 0 },
        hasTimePart: 0,
        excelSerialCandidate: 0,
        monotonicInc: 0,
        sample: [],
        tzMode: null,          // 'utc' | 'offset' | 'naive'
    };

    let prevNum = null;
    for (const row of sample) {
        const raw = row?.[colIdx];
        if (raw == null || raw === '') continue;
        const cell = String(raw);
        profile.nonEmpty++;
        if (profile.sample.length < 5) profile.sample.push(cell);

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

        if (/^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?$/.test(cell)) profile.timeOfDay++;

        const ym = cell.match(
            /^(\d{1,2})([/-])(\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/,
        );
        if (ym) {
            profile.yearlessDateTime++;
            if (ym[2] === '/') profile.yearlessSlash++;
            else profile.yearlessDash++;
            tallyDateAmbiguity(profile.yearlessCounts, +ym[1], +ym[3]);
            profile.hasTimePart++;
            continue;
        }

        const isoMatch = cell.match(
            /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+\-]\d{2}:?\d{2})?)?$/,
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
            /^(\d{1,4})\/(\d{1,2})\/(\d{1,4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/,
        );
        if (sm) {
            profile.slashDate++;
            tallyDateAmbiguity(profile.slashCounts, +sm[1], +sm[2]);
            if (sm[4] != null) profile.hasTimePart++;
            continue;
        }

        const dm = cell.match(
            /^(\d{1,2})-(\d{1,2})-(\d{2,4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/,
        );
        if (dm) {
            profile.dashDate++;
            tallyDateAmbiguity(profile.dashCounts, +dm[1], +dm[2]);
            if (dm[4] != null) profile.hasTimePart++;
            continue;
        }

        const mn = matchMonthNameDate(cell);
        if (mn) {
            profile.monthNameDate++;
            if (mn.order === 'DMY') profile.monthNameDmy++;
            else profile.monthNameMdy++;
            if (mn.hasTime) profile.hasTimePart++;
        }
    }

    return profile;
}

function tallyDateAmbiguity(c, a, b) {
    c.total++;
    if (a > 12 && a <= 31) c.firstGt12++;
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
    const fSlash   = content.slashDate / content.nonEmpty;
    const fDash    = content.dashDate  / content.nonEmpty;
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
                excelSerial: false,
            },
            descTag: 'iso-datetime',
            col,
        });
    }

    // ---- Datetime: slash date --------------------------------------------
    if (fSlash >= 0.8) {
        const order = resolveDmyOrMdy(content.slashCounts, preferred);
        const hasTime = content.hasTimePart / content.slashDate >= 0.5;
        out.push({
            mode: 'single',
            kind: 'datetime',
            sourceIndexes: [col.index],
            score: clamp01(0.5 * headerScore.score + 0.55 + 0.1 * (hasTime ? 1 : 0)),
            format: { dateOrder: order.order, hasTime, timezone: 'floating', excelSerial: false, ambiguous: order.ambiguous },
            descTag: 'slash-date',
            col,
        });
    }

    // ---- Datetime: dash date (non-ISO) -----------------------------------
    if (fDash >= 0.8 && fIso < 0.5) {
        const order = resolveDmyOrMdy(content.dashCounts, preferred);
        const hasTime = content.hasTimePart / content.dashDate >= 0.5;
        out.push({
            mode: 'single',
            kind: 'datetime',
            sourceIndexes: [col.index],
            score: clamp01(0.5 * headerScore.score + 0.5 + 0.1 * (hasTime ? 1 : 0)),
            format: { dateOrder: order.order, hasTime, timezone: 'floating', excelSerial: false, dashSeparator: true, ambiguous: order.ambiguous },
            descTag: 'dash-date',
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
                excelSerial: false,
                yearless: true,
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
            format: { dateOrder: order, hasTime, timezone: 'floating', excelSerial: false, monthName: true },
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
            format: { dateOrder: 'YMD', hasTime: true, timezone: 'floating', excelSerial: false, decimalYear: true },
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
            format: { dateOrder: 'YMD', hasTime: true, timezone: 'utc', excelSerial: false, matlabDatenum: true },
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

    const dateRatio = (dc.iso + dc.slashDate + dc.dashDate + dc.monthNameDate) / dc.nonEmpty;
    const timeRatio = tc.timeOfDay / tc.nonEmpty;
    if (dateRatio < 0.8 || timeRatio < 0.8) return null;

    let order = 'YMD';
    let ambiguous = false;
    let dashSeparator = false;
    let monthName = false;
    const counts = { iso: dc.iso, slash: dc.slashDate, dash: dc.dashDate, month: dc.monthNameDate };
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    if (top === 'iso') {
        order = 'YMD';
    } else if (top === 'slash') {
        const r = resolveDmyOrMdy(dc.slashCounts, preferred);
        order = r.order; ambiguous = r.ambiguous;
    } else if (top === 'dash') {
        const r = resolveDmyOrMdy(dc.dashCounts, preferred);
        order = r.order; ambiguous = r.ambiguous; dashSeparator = true;
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
        format: { dateOrder: order, hasTime: true, timezone: 'floating', excelSerial: false, dashSeparator, ambiguous, monthName },
        descTag: 'split-date-time',
        col: dateCol,
        timeCol,
    };
}

function resolveDmyOrMdy(counts, preferred) {
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
    } else if (best.descTag === 'slash-date' || best.descTag === 'dash-date') {
        const idx = best.sourceIndexes[0];
        const order = best.format.dateOrder;
        const sep = best.descTag === 'dash-date' ? '-' : '/';
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
        /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+\-]\d{2}:?\d{2})?)?$/,
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
        const normalizedTz = tz === 'Z' ? 'Z' : tz.replace(/^([+\-]\d{2})(\d{2})$/, '$1:$2');
        const padded = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
            + `T${String(H).padStart(2, '0')}:${String(Mi).padStart(2, '0')}:${String(Se).padStart(2, '0')}.${String(Ms).padStart(3, '0')}${normalizedTz}`;
        const ms = Date.parse(padded);
        return Number.isFinite(ms) ? ms : NaN;
    }

    return Date.UTC(y, mo - 1, d, H, Mi, Se, Ms);
}

function parseFlexibleDateMs(cell, order, sep) {
    if (cell == null || cell === '') return NaN;
    const re = sep === '-'
        ? /^(\d{1,4})-(\d{1,2})-(\d{1,4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/
        : /^(\d{1,4})\/(\d{1,2})\/(\d{1,4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/;
    const m = String(cell).match(re);
    if (!m) return NaN;

    let y, mo, d;
    const a = +m[1], b = +m[2], c = +m[3];
    if (order === 'YMD' || String(m[1]).length === 4) { y = a; mo = b; d = c; }
    else if (order === 'DMY') { d = a; mo = b; y = c; }
    else                      { mo = a; d = b; y = c; }
    if (y < 100) y += (y >= 70 ? 1900 : 2000);
    if (!isValidDate(y, mo, d)) return NaN;

    const H  = m[4] != null ? +m[4] : 0;
    const Mi = m[5] != null ? +m[5] : 0;
    const Se = m[6] != null ? +m[6] : 0;
    const Ms = m[7] != null ? Math.round(Number('0.' + m[7]) * 1000) : 0;

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
              : null;
    if (!sep) return NaN;

    const t = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
    const H  = t ? +t[1] : 0;
    const Mi = t ? +t[2] : 0;
    const Se = t && t[3] != null ? +t[3] : 0;
    const Ms = t && t[4] != null ? Math.round(Number('0.' + t[4]) * 1000) : 0;

    const re = sep === '-'
        ? /^(\d{1,4})-(\d{1,2})-(\d{1,4})$/
        : /^(\d{1,4})\/(\d{1,2})\/(\d{1,4})$/;
    const dm = dateStr.match(re);
    if (!dm) return NaN;

    const a = +dm[1], b = +dm[2], c = +dm[3];
    let y, mo, d;
    if (order === 'YMD')      { y = a; mo = b; d = c; }
    else if (order === 'DMY') { d = a; mo = b; y = c; }
    else                      { mo = a; d = b; y = c; }
    if (y < 100) y += (y >= 70 ? 1900 : 2000);
    if (!isValidDate(y, mo, d)) return NaN;

    return Date.UTC(y, mo - 1, d, H, Mi, Se, Ms);
}

function parseYearlessDateTimeMs(cell, order) {
    if (cell == null || cell === '') return NaN;
    const m = String(cell).trim().match(
        /^(\d{1,2})[/-](\d{1,2})[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/,
    );
    if (!m) return NaN;

    const a = +m[1];
    const b = +m[2];
    const mo = order === 'DMY' ? b : a;
    const d = order === 'DMY' ? a : b;
    const H = +m[3];
    const Mi = +m[4];
    const Se = m[5] != null ? +m[5] : 0;
    const Ms = m[6] != null ? Math.round(Number('0.' + m[6]) * 1000) : 0;
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

    return Date.UTC(y, m.mo - 1, m.d, m.H, m.Mi, m.Se, m.Ms);
}

function parseTimeOfDay(cell) {
    const t = String(cell ?? '').match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
    if (!t) return null;
    return {
        H: +t[1],
        Mi: +t[2],
        Se: t[3] != null ? +t[3] : 0,
        Ms: t[4] != null ? Math.round(Number('0.' + t[4]) * 1000) : 0,
    };
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
