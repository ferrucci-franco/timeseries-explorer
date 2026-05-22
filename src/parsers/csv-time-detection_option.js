/**
 * CSV time-axis detection.
 *
 * Replacement for csv-time-detection_old.js. Same public contract, plus a
 * stronger heuristic detector and the ability to recognise:
 *   - numeric time anywhere (not just first column)
 *   - ISO datetime, slash/dash dates, month-name dates, Excel serials
 *   - split Date + Time column pairs
 *
 * Public API:
 *   detectCsvTimeAxis(rawHeaders, dataRows, { delimiter, preferredDateOrder, locale })
 *   parseCsvNumber(rawValue, delimiter = ',')
 *   parseCsvText(text, { delimiter, papa })                 // optional helper
 *
 * Dependency-free, deterministic, browser-compatible (ES module).
 *
 * Optional integrations (graceful, runtime-detected — no build step required):
 *
 *   <!-- Robust CSV ingestion (used by parseCsvText below) -->
 *   <script src="https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js"></script>
 *
 *   <!-- Flexible/i18n date parsing fallback (FR/EN/ES, ambiguous strings) -->
 *   <script src="https://cdn.jsdelivr.net/npm/any-date-parser@2.2.3/dist/browser-bundle.js"></script>
 *
 * Behaviour with each library:
 *   - Papa Parse (window.Papa): when present, parseCsvText() defers to it for
 *     delimiter sniffing and quoted-field handling. Otherwise a small native
 *     RFC-4180-ish fallback parser is used.
 *   - any-date-parser (window.dateParser): when present, columns that no
 *     native regex (ISO/slash/dash/month-name) matched are *additionally*
 *     tried through the library — both at detection time and inside the
 *     parse(row) closure. Native parsers always win when both succeed, since
 *     they are faster and respect options.preferredDateOrder.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SAMPLE_SIZE = 60;

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
const MS_PER_DAY = 86400000;

const MIN_CONFIDENCE = 0.30;

// English + French month names → 1-based month index. Accents are stripped
// before lookup, so 'août' and 'aout' both resolve.
const MONTH_LOOKUP = {
    jan: 1,  january: 1,  janv: 1, janvier: 1,
    feb: 2,  february: 2, fev: 2,  fevr: 2,    fevrier: 2,
    mar: 3,  march: 3,    mars: 3,
    apr: 4,  april: 4,    avr: 4,  avril: 4,
    may: 5,  mai: 5,
    jun: 6,  june: 6,     juin: 6,
    jul: 7,  july: 7,     juil: 7, juillet: 7,
    aug: 8,  august: 8,   aou: 8,  aout: 8,
    sep: 9,  sept: 9,     september: 9, septembre: 9,
    oct: 10, october: 10, octobre: 10,
    nov: 11, november: 11, novembre: 11,
    dec: 12, december: 12, decembre: 12,
};

function lookupMonthName(token) {
    if (!token) return null;
    const norm = String(token)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '');
    return MONTH_LOOKUP[norm] ?? null;
}

// Match a "1-Jan-2008", "01 Jan 2008", "Jan 01, 2008" style date with an
// optional trailing time. Returns parsed components + the order detected from
// the position of the month-name token, or null.
function matchMonthNameDate(cell) {
    // Pattern A: D <month> Y (typical of MATLAB/Excel-EN exports).
    let m = cell.match(
        /^(\d{1,2})[\-\s]([A-Za-zÀ-ÿ]{3,12})[\-\s](\d{2,4})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/,
    );
    if (m) {
        const mo = lookupMonthName(m[2]);
        if (mo != null) return buildMonthNameMatch('DMY', +m[1], mo, +m[3], m);
    }
    // Pattern B: <month> D[,] Y (US English style).
    m = cell.match(
        /^([A-Za-zÀ-ÿ]{3,12})[\-\s](\d{1,2}),?[\-\s](\d{2,4})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?$/,
    );
    if (m) {
        const mo = lookupMonthName(m[1]);
        if (mo != null) return buildMonthNameMatch('MDY', +m[2], mo, +m[3], m);
    }
    return null;
}

function buildMonthNameMatch(order, d, mo, y, m) {
    return {
        order, d, mo, y,
        H:  m[4] != null ? +m[4] : 0,
        Mi: m[5] != null ? +m[5] : 0,
        Se: m[6] != null ? +m[6] : 0,
        Ms: m[7] != null ? Math.round(Number('0.' + m[7]) * 1000) : 0,
        hasTime: m[4] != null,
    };
}

// ---------------------------------------------------------------------------
// parseCsvNumber — exported public helper
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

// ---------------------------------------------------------------------------
// Optional-library probes (safe in any JS environment)
//
// Probing returns the library object or null. We never throw, never warn, and
// never cache a stale handle — the user might inject the library after this
// module evaluates, so each call re-reads globalThis.
// ---------------------------------------------------------------------------

function getPapaLib() {
    const g = (typeof globalThis !== 'undefined') ? globalThis : {};
    return (g.Papa && typeof g.Papa.parse === 'function') ? g.Papa : null;
}

function getDateParserLib() {
    const g = (typeof globalThis !== 'undefined') ? globalThis : {};
    // any-date-parser's browser bundle exposes `dateParser`. Probe a couple of
    // alternate spellings in case the bundle is wrapped or re-exported.
    const candidates = [g.dateParser, g.anyDateParser, g.DateParser];
    for (const c of candidates) {
        if (c && typeof c.fromString === 'function') return c;
    }
    return null;
}

// Try any-date-parser on a single cell. Returns Unix ms (UTC) or NaN. Never
// throws. Called only when no native regex matched the cell, so this is the
// "exotic format" lane: French long dates, "yesterday", "March 19 2025", etc.
function tryFlexibleDateMs(cell, locale) {
    const lib = getDateParserLib();
    if (!lib) return NaN;
    try {
        const result = lib.fromString(String(cell), locale);
        if (result instanceof Date) {
            const ms = result.getTime();
            return Number.isFinite(ms) ? ms : NaN;
        }
        // Library returns { invalid: '...' } on failure; treat as no match.
        return NaN;
    } catch (_) {
        return NaN;
    }
}

// ---------------------------------------------------------------------------
// parseCsvText — optional helper for callers that have raw CSV text.
//
// Uses Papa Parse when window.Papa is loaded (better delimiter sniffing and
// quoted-field handling); otherwise falls back to a small native parser.
// Returns { headers, rows, delimiter } shaped for detectCsvTimeAxis.
// ---------------------------------------------------------------------------

export function parseCsvText(text, options = {}) {
    const Papa = getPapaLib();
    const wanted = options.delimiter;

    if (Papa) {
        const result = Papa.parse(String(text ?? ''), {
            skipEmptyLines: 'greedy',
            delimiter: wanted || '',          // empty string = Papa auto-detects
            ...(options.papa || {}),
        });
        const data = (result.data || [])
            .map(r => (Array.isArray(r) ? r : []).map(c => String(c ?? '').trim()))
            .filter(r => r.some(c => c !== ''));
        return {
            headers: data[0] || [],
            rows: data.slice(1),
            delimiter: (result.meta && result.meta.delimiter) || wanted || ',',
        };
    }

    const delimiter = wanted || sniffDelimiter(String(text ?? ''));
    const rows = parseCsvNative(String(text ?? ''), delimiter)
        .map(r => r.map(c => c.trim()))
        .filter(r => r.some(c => c !== ''));
    return {
        headers: rows[0] || [],
        rows: rows.slice(1),
        delimiter,
    };
}

function sniffDelimiter(text) {
    const head = text.slice(0, 4096);
    const counts = {
        ',':  (head.match(/,/g)  || []).length,
        ';':  (head.match(/;/g)  || []).length,
        '\t': (head.match(/\t/g) || []).length,
    };
    let best = ',', max = -1;
    for (const k of Object.keys(counts)) if (counts[k] > max) { max = counts[k]; best = k; }
    return best;
}

// Minimal RFC-4180-ish parser. Used only when Papa Parse is not loaded.
function parseCsvNative(text, delimiter) {
    const out = [];
    let row = [], field = '', inQuotes = false, i = 0;
    const len = text.length;
    while (i < len) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
                inQuotes = false; i++; continue;
            }
            field += ch; i++; continue;
        }
        if (ch === '"')      { inQuotes = true; i++; continue; }
        if (ch === delimiter){ row.push(field); field = ''; i++; continue; }
        if (ch === '\r' || ch === '\n') {
            row.push(field); field = '';
            out.push(row); row = [];
            if (ch === '\r' && text[i + 1] === '\n') i += 2; else i++;
            continue;
        }
        field += ch; i++;
    }
    if (field !== '' || row.length > 0) { row.push(field); out.push(row); }
    return out;
}

// ---------------------------------------------------------------------------
// detectCsvTimeAxis — exported public detector
// ---------------------------------------------------------------------------

export function detectCsvTimeAxis(rawHeaders, dataRows, options = {}) {
    const delimiter = options.delimiter || ',';
    const preferred = (options.preferredDateOrder || 'DMY').toUpperCase();
    // Locale forwarded to any-date-parser when present. Undefined means "use
    // the library's default", which works fine for ISO-ish inputs.
    const locale    = options.locale;
    const warnings  = [];

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
            content:     profileColumnContent(sample, c, delimiter, locale),
        });
    }

    const candidates = [];

    // Single-column candidates: numeric, ISO/slash/dash/month-name datetime,
    // Excel serial, and (when any-date-parser is loaded) flexible-date.
    for (const col of cols) {
        for (const cand of evaluateSingleColumn(col, preferred, locale)) candidates.push(cand);
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

    // A viable split candidate strictly dominates the standalone date-column
    // candidate that it absorbs — drop the latter so the split wins on ties.
    const splitDateIndexes = new Set();
    for (const c of unique) {
        if (c.mode === 'split' && c.score >= 0.5) splitDateIndexes.add(c.sourceIndexes[0]);
    }
    if (splitDateIndexes.size > 0) {
        unique = unique.filter(c =>
            !(c.mode === 'single'
              && c.kind === 'datetime'
              && !c.format.excelSerial
              && splitDateIndexes.has(c.sourceIndexes[0])),
        );
    }

    if (unique.length === 0 || unique[0].score < MIN_CONFIDENCE) {
        return {
            ok: false,
            reason: unique.length === 0
                ? 'CSV must contain a time column, Date+Time columns, or a numeric first column.'
                : 'No candidate met the minimum confidence threshold',
            candidates: [],
            warnings,
        };
    }

    return buildResult(unique[0], headers, delimiter, warnings);
}

// ---------------------------------------------------------------------------
// Header normalization + scoring
// ---------------------------------------------------------------------------

function normalizeHeaderLabel(header) {
    return String(header ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')   // strip combining accents
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

// ---------------------------------------------------------------------------
// Content profile
// ---------------------------------------------------------------------------

function profileColumnContent(sample, colIdx, delimiter, locale) {
    const dateLib = getDateParserLib();   // probed once per column for speed
    const profile = {
        nonEmpty: 0,
        numeric: 0,
        numericValues: [],
        timeOfDay: 0,
        iso: 0,                // 2022-08-01 [T 00:00:00…]
        slashDate: 0,          // a/b/c
        dashDate: 0,           // a-b-c (when leading part is 1-2 digits, so not ISO)
        monthNameDate: 0,      // dd-Mmm-yyyy or Mmm-dd-yyyy (incl. spaces)
        monthNameDmy: 0,
        monthNameMdy: 0,
        flexibleDate: 0,       // matched only by any-date-parser fallback
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
            if (mn.order === 'DMY') profile.monthNameDmy++; else profile.monthNameMdy++;
            if (mn.hasTime) profile.hasTimePart++;
            continue;
        }

        // Final fallback: any-date-parser (if loaded). Skip pure numeric cells
        // — the library would happily interpret "42" as a date and confuse
        // detection. Anything containing a letter, '/', '-', ':', or space is
        // fair game.
        if (dateLib && /[A-Za-zÀ-ÿ \/\-:]/.test(cell) && !Number.isFinite(num)) {
            const ms = tryFlexibleDateMs(cell, locale);
            if (Number.isFinite(ms)) profile.flexibleDate++;
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

function evaluateSingleColumn(col, preferred, locale) {
    const out = [];
    const { content, headerScore } = col;
    if (content.nonEmpty === 0) return out;

    const fNumeric    = content.numeric / content.nonEmpty;
    const fIso        = content.iso     / content.nonEmpty;
    const fSlash      = content.slashDate / content.nonEmpty;
    const fDash       = content.dashDate  / content.nonEmpty;
    const fMonthName  = content.monthNameDate / content.nonEmpty;
    const fFlexible   = content.flexibleDate / content.nonEmpty;
    const fMono       = content.numericValues.length > 1
        ? content.monotonicInc / (content.numericValues.length - 1)
        : 0;

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
                        : 'local',
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
            format: { dateOrder: order.order, hasTime, timezone: 'local', excelSerial: false, ambiguous: order.ambiguous },
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
            format: { dateOrder: order.order, hasTime, timezone: 'local', excelSerial: false, dashSeparator: true, ambiguous: order.ambiguous },
            descTag: 'dash-date',
            col,
        });
    }

    // ---- Datetime: month-name date (e.g. "01-Jan-2008 00:00:00") --------
    if (fMonthName >= 0.8) {
        const order = content.monthNameDmy >= content.monthNameMdy ? 'DMY' : 'MDY';
        const hasTime = content.hasTimePart / content.monthNameDate >= 0.5;
        out.push({
            mode: 'single',
            kind: 'datetime',
            sourceIndexes: [col.index],
            score: clamp01(0.5 * headerScore.score + 0.6 + 0.1 * (hasTime ? 1 : 0)),
            format: { dateOrder: order, hasTime, timezone: 'local', excelSerial: false, monthName: true },
            descTag: 'month-name-date',
            col,
        });
    }

    // ---- Datetime: any-date-parser fallback ------------------------------
    // Only fires when the library is loaded AND the column is mostly
    // non-numeric date-like strings that none of our native regexes matched.
    // Score is intentionally lower than native parsers so a native match
    // always wins when both apply.
    if (fFlexible >= 0.8 && fNumeric < 0.5) {
        out.push({
            mode: 'single',
            kind: 'datetime',
            sourceIndexes: [col.index],
            score: clamp01(0.4 * headerScore.score + 0.5),
            format: { dateOrder: 'unknown', hasTime: true, timezone: 'unknown', excelSerial: false, library: 'any-date-parser' },
            descTag: 'flexible-date',
            locale,
            col,
        });
    }

    // ---- Datetime: Excel serial — requires a date-ish header -------------
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
    // Either header says "time"/"t"/"temps" (kind=time) or first column with
    // strictly increasing numbers. Negative headers (sample/index/...) are
    // disqualified; date-ish headers are reserved for the Excel branch.
    const headerIsDateish = headerScore.kind === 'date' || headerScore.kind === 'datetime';
    if (fNumeric >= 0.95 && !headerScore.negative && !headerIsDateish) {
        const headerSaysTime = headerScore.kind === 'time';
        const isFirstCol = col.index === 0;
        const monoBoost = fMono >= 0.95 ? 0.25 : fMono >= 0.7 ? 0.10 : 0;
        if (headerSaysTime || (isFirstCol && fMono >= 0.9)) {
            out.push({
                mode: 'single',
                kind: 'numeric',
                sourceIndexes: [col.index],
                score: clamp01((headerSaysTime ? 0.55 : 0.25) + 0.4 * headerScore.score + monoBoost + (isFirstCol ? 0.05 : 0)),
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
    const counts = { iso: dc.iso, slash: dc.slashDate, dash: dc.dashDate, mn: dc.monthNameDate };
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
    const score = clamp01(0.45 + headerBoost + (adjacent ? 0.1 : 0));

    return {
        mode: 'split',
        kind: 'datetime',
        sourceIndexes: [dateCol.index, timeCol.index],
        score,
        format: { dateOrder: order, hasTime: true, timezone: 'local', excelSerial: false, dashSeparator, ambiguous, monthName },
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
    } else if (best.descTag === 'flexible-date') {
        // Library-driven fallback. The closure re-probes globalThis each call
        // so that loading any-date-parser after detection still works.
        const idx = best.sourceIndexes[0];
        const loc = best.locale;
        parse = (row) => tryFlexibleDateMs(row?.[idx], loc);
        const h = parseHeader(headers[idx]?.raw, idx);
        name = h.name;
        description = '[datetime via any-date-parser]';
    } else if (best.descTag === 'month-name-date') {
        const idx = best.sourceIndexes[0];
        parse = (row) => parseMonthNameDateMs(row?.[idx]);
        const h = parseHeader(headers[idx]?.raw, idx);
        name = h.name;
        description = '[datetime]';
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
    const s = String(cell);
    const ms = Date.parse(s.length === 10 ? s + 'T00:00:00' : s);
    return Number.isFinite(ms) ? ms : NaN;
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
    if (order === 'YMD')      { y = a; mo = b; d = c; }
    else if (order === 'DMY') { d = a; mo = b; y = c; }
    else                      { mo = a; d = b; y = c; }
    if (y < 100) y += (y >= 70 ? 1900 : 2000);
    if (!isValidDate(y, mo, d)) return NaN;

    const H  = m[4] != null ? +m[4] : 0;
    const Mi = m[5] != null ? +m[5] : 0;
    const Se = m[6] != null ? +m[6] : 0;
    const Ms = m[7] != null ? Math.round(Number('0.' + m[7]) * 1000) : 0;

    // Naive timestamps → local time, matching Date.parse default for ISO.
    return new Date(y, mo - 1, d, H, Mi, Se, Ms).getTime();
}

function combineDateAndTimeMs(dateCell, timeCell, order) {
    if (dateCell == null || dateCell === '') return NaN;
    const dateStr = String(dateCell);
    const timeStr = timeCell == null ? '' : String(timeCell);

    const t = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
    const H  = t ? +t[1] : 0;
    const Mi = t ? +t[2] : 0;
    const Se = t && t[3] != null ? +t[3] : 0;
    const Ms = t && t[4] != null ? Math.round(Number('0.' + t[4]) * 1000) : 0;

    // Month-name date column?
    const mn = matchMonthNameDate(dateStr);
    if (mn) {
        let y = mn.y;
        if (y < 100) y += (y >= 70 ? 1900 : 2000);
        if (!isValidDate(y, mn.mo, mn.d)) return NaN;
        return new Date(y, mn.mo - 1, mn.d, H, Mi, Se, Ms).getTime();
    }

    const sep = dateStr.includes('/') ? '/'
              : dateStr.includes('-') ? '-'
              : null;
    if (!sep) return NaN;

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

    return new Date(y, mo - 1, d, H, Mi, Se, Ms).getTime();
}

function parseMonthNameDateMs(cell) {
    if (cell == null || cell === '') return NaN;
    const m = matchMonthNameDate(String(cell));
    if (!m) return NaN;
    let y = m.y;
    if (y < 100) y += (y >= 70 ? 1900 : 2000);
    if (!isValidDate(y, m.mo, m.d)) return NaN;
    return new Date(y, m.mo - 1, m.d, m.H, m.Mi, m.Se, m.Ms).getTime();
}

function excelSerialToMs(serial) {
    if (!Number.isFinite(serial)) return NaN;
    return Math.round((serial - EXCEL_TO_UNIX_DAYS) * MS_PER_DAY);
}

function isValidDate(y, mo, d) {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    const dt = new Date(y, mo - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
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
