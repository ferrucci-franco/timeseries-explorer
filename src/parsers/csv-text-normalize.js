/**
 * The text-level repairs every CSV reader in the app shares: how the bytes
 * become text, which characters are noise, how numbers are written, and what
 * to do with a row that has the wrong number of cells.
 *
 * These are the things that make a file from a PLC, a data logger or an old
 * Windows tool fail to open at all — a UTF-16 export read as Latin-1, a zero-
 * width space in front of every value, "1.234,5" read as text, a trailing
 * delimiter on every data row — and none of them depend on what the table
 * holds. Each function here is pure and deterministic, so the browser parser,
 * the worker, the DuckDB path and the Node converter all read a file the same
 * way.
 */

// ---------------------------------------------------------------------------
// Encodings
// ---------------------------------------------------------------------------

/**
 * Encodings a reader can choose in the parsing dialog. Every label is one
 * TextDecoder understands (WHATWG Encoding Standard), so the browser, the
 * worker and Node decode the same bytes the same way.
 */
export const CSV_ENCODINGS = [
    'utf-8',
    'utf-16le',
    'utf-16be',
    'windows-1252',
    'iso-8859-15',
    'windows-1250',
    'windows-1251',
    'windows-1253',
    'windows-1254',
    'macintosh',
    'ibm866',
    'koi8-r',
    'shift_jis',
    'euc-jp',
    'gbk',
    'big5',
    'euc-kr',
    'latin1',
];

const SNIFF_BYTES = 64 * 1024;

function toBytes(buffer) {
    if (buffer instanceof Uint8Array) return buffer;
    if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return new Uint8Array(buffer || new ArrayBuffer(0));
}

/** The byte-order mark at the start of the bytes, if there is one. */
export function sniffByteOrderMark(bytes) {
    const b = toBytes(bytes);
    if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return { encoding: 'utf-8', length: 3 };
    // FF FE 00 00 would be UTF-32 LE, which no CSV tool writes and TextDecoder
    // cannot read; it is left to the fallbacks.
    if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE && !(b.length >= 4 && b[2] === 0 && b[3] === 0)) {
        return { encoding: 'utf-16le', length: 2 };
    }
    if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) return { encoding: 'utf-16be', length: 2 };
    return null;
}

/**
 * UTF-16 without a BOM: Latin text written in UTF-16 has a zero byte in every
 * other position. Little-endian puts it second ("t\0i\0m\0e\0"), big-endian
 * first. Nothing else a CSV is written in looks like that.
 */
export function sniffUtf16WithoutBom(bytes) {
    const b = toBytes(bytes);
    const n = Math.min(b.length, SNIFF_BYTES) & ~1;
    if (n < 8) return null;
    let evenZeros = 0;
    let oddZeros = 0;
    for (let i = 0; i < n; i += 2) {
        if (b[i] === 0) evenZeros++;
        if (b[i + 1] === 0) oddZeros++;
    }
    const pairs = n / 2;
    if (oddZeros / pairs > 0.3 && evenZeros / pairs < 0.05) return 'utf-16le';
    if (evenZeros / pairs > 0.3 && oddZeros / pairs < 0.05) return 'utf-16be';
    return null;
}

/**
 * Count well-formed and malformed UTF-8 multi-byte sequences. A sequence cut
 * off by the end of the bytes is neither: a preview sample is a slice of the
 * file and routinely ends in the middle of a character.
 */
export function utf8SequenceStats(bytes, limit = Infinity) {
    const b = toBytes(bytes);
    const n = Math.min(b.length, limit);
    let valid = 0;
    let invalid = 0;
    let i = 0;
    while (i < n) {
        const c = b[i];
        if (c < 0x80) { i++; continue; }
        let need = 0;
        let min = 0;
        if (c >= 0xC2 && c <= 0xDF) { need = 1; min = 0x80; }
        else if (c >= 0xE0 && c <= 0xEF) { need = 2; min = 0x800; }
        else if (c >= 0xF0 && c <= 0xF4) { need = 3; min = 0x10000; }
        else { invalid++; i++; continue; }
        if (i + need >= b.length) break; // truncated at the very end: not evidence
        let cp = c & (need === 1 ? 0x1F : need === 2 ? 0x0F : 0x07);
        let ok = true;
        for (let k = 1; k <= need; k++) {
            const cc = b[i + k];
            if ((cc & 0xC0) !== 0x80) { ok = false; break; }
            cp = (cp << 6) | (cc & 0x3F);
        }
        if (ok && (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF))) ok = false;
        if (ok) { valid++; i += need + 1; }
        else { invalid++; i++; }
    }
    return { valid, invalid };
}

// The length of the bytes without a multi-byte character the end cuts off.
function utf8CompleteLength(bytes) {
    const n = bytes.length;
    for (let back = 1; back <= 3 && back <= n; back++) {
        const c = bytes[n - back];
        if ((c & 0xC0) === 0x80) continue; // continuation byte: keep looking
        const need = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1;
        return need > back ? n - back : n;
    }
    return n;
}

function decodeWith(label, bytes, options = {}) {
    return new TextDecoder(label, { fatal: !!options.fatal, ignoreBOM: false })
        .decode(bytes, options.stream ? { stream: true } : undefined);
}

/**
 * Bytes to text, and which encoding that took.
 *
 * `auto` decides in this order: a byte-order mark; UTF-16 recognised by its
 * zero bytes; strict UTF-8 (a character cut off by the end of a sample does
 * not count against it); UTF-8 with a handful of corrupt bytes among many good
 * multi-byte characters; and Windows-1252 for everything else — the encoding
 * Excel and most Windows software on Western-European systems write, and a
 * superset of Latin-1 for every printable character.
 *
 * @returns {{ text: string, encoding: string, detection: string }}
 */
export function decodeCsvBytes(buffer, requested = 'auto') {
    if (typeof buffer === 'string') {
        return { text: buffer.replace(/^\uFEFF/, ''), encoding: requested === 'auto' ? 'utf-8' : requested, detection: 'text' };
    }
    const bytes = toBytes(buffer);
    const wanted = String(requested || 'auto').toLowerCase();
    if (wanted !== 'auto' && typeof TextDecoder !== 'undefined') {
        try {
            return { text: decodeWith(wanted, bytes).replace(/^\uFEFF/, ''), encoding: wanted, detection: 'chosen' };
        } catch (_) {
            // An encoding this runtime does not know: decide as for 'auto'.
        }
    }
    if (typeof TextDecoder === 'undefined') {
        let text = '';
        for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]);
        return { text: text.replace(/^\uFEFF/, ''), encoding: 'latin1', detection: 'fallback' };
    }

    const bom = sniffByteOrderMark(bytes);
    if (bom) {
        // The decoders drop the mark themselves (ignoreBOM: false).
        return { text: decodeWith(bom.encoding, bytes), encoding: bom.encoding, detection: 'bom' };
    }
    const utf16 = sniffUtf16WithoutBom(bytes);
    if (utf16) return { text: decodeWith(utf16, bytes), encoding: utf16, detection: 'utf16-zeros' };

    try {
        const text = decodeWith('utf-8', bytes, { fatal: true });
        return { text: text.replace(/^\uFEFF/, ''), encoding: 'utf-8', detection: 'utf-8' };
    } catch (_) {
        // Not strict UTF-8 — or strict UTF-8 cut in the middle of a character
        // by the end of a preview sample. That used to fail the whole sample:
        // the file went on as Windows-1252, every accent garbled, and was then
        // refused by the DuckDB path, which only reads UTF-8.
        const cut = utf8CompleteLength(bytes);
        if (cut < bytes.length) {
            try {
                const text = decodeWith('utf-8', bytes.subarray(0, cut), { fatal: true });
                return { text: text.replace(/^\uFEFF/, ''), encoding: 'utf-8', detection: 'utf-8' };
            } catch (_) {
                // Not UTF-8 before the cut either.
            }
        }
    }
    const stats = utf8SequenceStats(bytes);
    if (stats.valid >= 4 && stats.invalid / (stats.valid + stats.invalid) <= 0.1) {
        // Mostly UTF-8 with a few damaged bytes (a Windows-1252 file almost
        // never holds even one well-formed multi-byte sequence: it takes a
        // lead byte followed by a continuation byte). Decoding it as Windows-1252
        // would garble every good character to save a few bad ones.
        return { text: decodeWith('utf-8', bytes).replace(/^\uFEFF/, ''), encoding: 'utf-8', detection: 'utf-8-damaged' };
    }
    const legacy = detectLegacyEncoding(bytes);
    return { text: decodeWith(legacy, bytes).replace(/^\uFEFF/, ''), encoding: legacy, detection: legacy === 'windows-1252' ? 'single-byte' : 'legacy-script' };
}

const LETTER = /\p{L}/u;

// What the non-ASCII characters of a decoding are: the script they belong to,
// and how many letters stand in runs of non-ASCII letters (two or more), or in
// whole words of them (three or more). Words of a non-Latin script are such
// runs; a Western text's accents sit alone between ASCII letters ("Débit",
// "Größe"), or in pairs at most ("ção").
function scriptProfile(text) {
    const p = { nonAscii: 0, kana: 0, cjk: 0, hangul: 0, fullwidth: 0, cyrillic: 0, cyrillicLower: 0, letters: 0, inRuns: 0, inWords: 0 };
    let run = 0;
    const endRun = () => {
        if (run >= 2) p.inRuns += run;
        if (run >= 3) p.inWords += run;
        run = 0;
    };
    for (const ch of text) {
        const u = ch.codePointAt(0);
        if (u < 128) { endRun(); continue; }
        p.nonAscii++;
        if (u >= 0x3040 && u <= 0x30FF) p.kana++;
        else if (u >= 0x4E00 && u <= 0x9FFF) p.cjk++;
        else if (u >= 0xAC00 && u <= 0xD7AF) p.hangul++;
        else if (u >= 0xFF00 && u <= 0xFFEF) p.fullwidth++;
        else if (u >= 0x400 && u <= 0x4FF) {
            p.cyrillic++;
            if (ch !== ch.toUpperCase()) p.cyrillicLower++;
        }
        if (LETTER.test(ch)) {
            p.letters++;
            run++;
        } else {
            endRun();
        }
    }
    endRun();
    p.runRatio = p.letters ? p.inRuns / p.letters : 0;
    p.wordRatio = p.letters ? p.inWords / p.letters : 0;
    return p;
}

function tryDecode(label, bytes) {
    try {
        return new TextDecoder(label, { fatal: true }).decode(bytes);
    } catch (_) {
        return null;
    }
}


/**
 * The legacy encoding of a file that is neither UTF-8 nor UTF-16: Shift_JIS,
 * EUC-KR (CP949), GBK, Big5, a Cyrillic code page (Windows-1251, DOS 866,
 * KOI8-R), Windows-1250, or else Windows-1252.
 *
 * Every candidate is decoded and judged by what it produces, not by byte
 * statistics: Japanese has kana, which GBK never yields from the same bytes;
 * every reading must give words, runs of letters, since a Western "AÑO"
 * decodes as GBK too, to one ideograph between Latin letters;
 * Korean decodes to Hangul; a Cyrillic text is words of Cyrillic letters,
 * which shows as runs of non-ASCII letters that a Western text never has; and
 * Windows-1250 is chosen only on evidence that cannot be read the Western
 * way (ł that 1252 reads as ³, the Slovak ý). Japanese, Chinese, Korean, Russian
 * and Slovak PLC and SCADA exports used to arrive as Windows-1252 mojibake.
 */
export function detectLegacyEncoding(buffer) {
    const all = toBytes(buffer);
    let sample = all.subarray(0, 262144);
    // End on a line break, so no multi-byte character is cut in half.
    const lastBreak = sample.lastIndexOf(10);
    if (lastBreak > 0 && sample.length < all.length) sample = sample.subarray(0, lastBreak);
    let highBytes = 0;
    for (let i = 0; i < sample.length; i++) if (sample[i] >= 0x80) highBytes++;
    if (highBytes < 4) return 'windows-1252';

    const sjis = tryDecode('shift_jis', sample);
    if (sjis !== null) {
        const p = scriptProfile(sjis);
        if (p.kana > 0 && p.runRatio >= 0.5 && (p.kana + p.cjk + p.fullwidth) / Math.max(1, p.nonAscii) >= 0.9) return 'shift_jis';
    }
    const korean = tryDecode('euc-kr', sample);
    if (korean !== null) {
        const p = scriptProfile(korean);
        // GB2312 bytes are valid EUC-KR too, half of them Hangul; the other
        // half are Hanja, which Korean text hardly writes.
        if (p.runRatio >= 0.5 && p.hangul / Math.max(1, p.nonAscii) >= 0.6
            && p.cjk / Math.max(1, p.nonAscii) < 0.1) return 'euc-kr';
    }
    for (const label of ['gbk', 'big5']) {
        const text = tryDecode(label, sample);
        if (text === null) continue;
        const p = scriptProfile(text);
        if (p.runRatio >= 0.5 && p.cjk / Math.max(1, p.nonAscii) >= 0.85) return label;
    }

    // Cyrillic: the code page whose reading is words of Cyrillic letters.
    // Read with the wrong one of the three, the same bytes give box-drawing
    // symbols or letters scattered between them.
    let cyrillic = null;
    for (const label of ['windows-1251', 'ibm866', 'koi8-r']) {
        const p = scriptProfile(new TextDecoder(label).decode(sample));
        const share = p.cyrillic / Math.max(1, p.nonAscii);
        if (share < 0.9 || p.wordRatio < 0.6) continue;
        // Windows-1251 and KOI8-R both read Cyrillic letters from the same
        // bytes, upper case in one where the other has lower case; text is
        // mostly lower case.
        const score = share + p.wordRatio + p.cyrillicLower / Math.max(1, p.cyrillic);
        if (!cyrillic || score > cyrillic.score) cyrillic = { label, score };
    }
    if (cyrillic) return cyrillic.label;

    const western = new TextDecoder('windows-1252').decode(sample);

    // Windows-1250 or 1252. Most bytes the two read differently are letters
    // in both (č or è, ř or ø), which says nothing. What does: a byte that is
    // a letter in one and a symbol in the other (ł or ³, ą or ¹, ľ or ¾),
    // and the shared letters one language family writes and the other does
    // not: ý in Czech and Slovak, ç in French and Portuguese.
    const central = new TextDecoder('windows-1250').decode(sample);
    const a = [...central];
    const b = [...western];
    let centralEvidence = 0;
    let westernEvidence = 0;
    for (let i = 0; i < a.length && i < b.length; i++) {
        const x = a[i];
        const y = b[i];
        if (x === y) {
            if (x === 'ý' || x === 'Ý') centralEvidence++;
            else if (x === 'ç' || x === 'Ç') westernEvidence++;
            continue;
        }
        const xLetter = LETTER.test(x);
        const yLetter = LETTER.test(y);
        if (xLetter && !yLetter) centralEvidence++;
        else if (yLetter && !xLetter) westernEvidence++;
    }
    if (centralEvidence >= 3 && centralEvidence > 2 * westernEvidence) return 'windows-1250';
    return 'windows-1252';
}

// ---------------------------------------------------------------------------
// Invisible characters
// ---------------------------------------------------------------------------

// Characters that are never part of a value: C0 controls other than tab and
// the line breaks, DEL, C1 controls, soft hyphen, zero-width and bidi marks,
// word joiners, stray byte-order marks and the noncharacter U+FFFE. PLC and
// logger firmware writes them (NUL padding, a BOM per line, ZWSP from a web
// export), and every one of them turned a number into text.
const INVISIBLE_CHARS = '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD'
    + '\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF\\uFFFE';
const INVISIBLE_TEST_RE = new RegExp(`[${INVISIBLE_CHARS}\\u2028\\u2029]`);
const INVISIBLE_RE = new RegExp(`[${INVISIBLE_CHARS}]+`, 'g');
const LINE_SEPARATOR_RE = /[\u2028\u2029]/g;

/** The same class for DuckDB's RE2, for the SQL readers. */
export const INVISIBLE_CHARS_RE2 = '[\\x{00}-\\x{08}\\x{0B}\\x{0C}\\x{0E}-\\x{1F}\\x{7F}-\\x{9F}\\x{AD}'
    + '\\x{200B}-\\x{200F}\\x{202A}-\\x{202E}\\x{2060}-\\x{2064}\\x{2066}-\\x{2069}\\x{FEFF}\\x{FFFE}]';

/**
 * Remove the characters no value is made of.
 *
 * @returns {{ text: string, removed: number }} `removed` counts characters
 *   taken out, so the reader can be told the file was cleaned.
 */
export function sanitizeCsvText(text) {
    const source = String(text ?? '');
    if (!INVISIBLE_TEST_RE.test(source)) return { text: source, removed: 0 };
    let removed = 0;
    const cleaned = source
        .replace(INVISIBLE_RE, match => { removed += match.length; return ''; })
        // Unicode line separators end a line; a file that uses them means them.
        .replace(LINE_SEPARATOR_RE, '\n');
    return { text: cleaned, removed };
}

/** Same as sanitizeCsvText for one cell, when only a value is at hand. */
export function stripInvisibleChars(value) {
    const text = String(value ?? '');
    return INVISIBLE_TEST_RE.test(text) ? text.replace(INVISIBLE_RE, '').replace(LINE_SEPARATOR_RE, ' ') : text;
}

// ---------------------------------------------------------------------------
// Number format: decimal and thousands separators
// ---------------------------------------------------------------------------

export const DECIMAL_SEPARATOR_CHOICES = ['auto', '.', ','];
export const THOUSANDS_SEPARATOR_CHOICES = ['auto', 'none', ',', '.', ' ', "'"];

/**
 * A decimal-separator setting as the number parser takes it: 'auto', or the
 * one character between the integer and the fraction.
 */
export function normalizeDecimalSeparator(value) {
    const text = String(value ?? '');
    if (!text || text === 'auto') return 'auto';
    if (text === 'dot') return '.';
    if (text === 'comma') return ',';
    const ch = Array.from(text)[0];
    return /\d|[+\-eE]/.test(ch) || /\s/.test(ch) ? 'auto' : ch;
}

/**
 * A thousands-separator setting: 'auto', 'none', or the grouping character.
 * Any space-like character means "space", which the number parser already
 * strips (narrow no-break space is what French locales write).
 */
export function normalizeThousandsSeparator(value) {
    const text = String(value ?? '');
    if (!text || text === 'auto') return 'auto';
    if (text === 'none') return 'none';
    if (text === 'space' || /^\s+$/.test(text)) return ' ';
    if (text === 'apostrophe' || text === '\u2019') return "'";
    const ch = Array.from(text)[0];
    return /\d|[+\-eE]/.test(ch) ? 'none' : ch;
}

const NUMBER_SHAPES = [
    // Decimal comma with dot thousands: 1.234,5  12.345.678,90
    { re: /^[+-]?\d{1,3}(?:\.\d{3})+,\d+$/, decimal: ',', thousands: '.', weight: 3 },
    // Decimal dot with comma thousands: 1,234.5
    { re: /^[+-]?\d{1,3}(?:,\d{3})+\.\d+$/, decimal: '.', thousands: ',', weight: 3 },
    // Space-grouped: 1 234,5 / 1 234.5 (any Unicode space)
    { re: /^[+-]?\d{1,3}(?:[\s\u00A0\u202F\u2009]\d{3})+(?:([.,])\d+)?$/u, thousands: ' ', weight: 2 },
    // Apostrophe-grouped (Swiss): 1'234.5
    { re: /^[+-]?\d{1,3}(?:['\u2019]\d{3})+(?:([.,])\d+)?$/, thousands: "'", weight: 3 },
    // Two or more dot groups and nothing else: 1.234.567 — never a decimal
    { re: /^[+-]?\d{1,3}(?:\.\d{3}){2,}$/, thousands: '.', weight: 2 },
    // Two or more comma groups: 1,234,567
    { re: /^[+-]?\d{1,3}(?:,\d{3}){2,}$/, thousands: ',', weight: 2 },
];

/**
 * How the numbers in a sample are written, decided from the cells that can
 * only be read one way.
 *
 * A cell like "1,5" or "3.25" says which character is the decimal separator;
 * "1.234,5" says both; "1,234" says nothing (a thousand, or one and a bit).
 * The verdict is the separator the unambiguous cells agree on. Conflicting
 * evidence, or none, leaves the setting at 'auto' — the per-cell reading,
 * which is right for every file that is not ambiguous.
 *
 * @returns {{ decimalSeparator: string, thousandsSeparator: string,
 *             evidence: { decimalComma: number, decimalDot: number, thousands: object } }}
 */
export function detectCsvNumberFormat(rows, options = {}) {
    const delimiter = options.delimiter || ',';
    const skipColumns = options.skipColumns instanceof Set ? options.skipColumns : new Set(options.skipColumns || []);
    const maxCells = Number(options.maxCells) || 20000;
    let decimalComma = 0;
    let decimalDot = 0;
    const thousands = { ',': 0, '.': 0, ' ': 0, "'": 0 };
    let seen = 0;

    for (const row of rows || []) {
        if (!Array.isArray(row)) continue;
        for (let c = 0; c < row.length; c++) {
            if (skipColumns.has(c)) continue;
            const cell = String(row[c] ?? '').trim();
            if (!cell || cell.length > 40 || !/\d/.test(cell)) continue;
            if (++seen > maxCells) break;
            let matched = false;
            for (const shape of NUMBER_SHAPES) {
                const m = cell.match(shape.re);
                if (!m) continue;
                matched = true;
                thousands[shape.thousands] += shape.weight;
                const decimal = shape.decimal || m[1];
                if (decimal === ',') decimalComma += shape.weight;
                if (decimal === '.') decimalDot += shape.weight;
                break;
            }
            if (matched) continue;
            // One separator, and a fraction that is not three digits long: the
            // separator can only be the decimal one. These are split cells, so
            // a comma in a comma-delimited file was quoted: "2,0825" says
            // decimal comma there as much as anywhere.
            // Four digits or more before it ("46622,538") also rule out a
            // thousands group, which holds three at most.
            let m = cell.match(/^[+-]?(\d*),(\d+)(?:[eE][+-]?\d+)?$/);
            if (m && (m[2].length !== 3 || m[1].length > 3)) { decimalComma++; continue; }
            m = cell.match(/^[+-]?(\d*)\.(\d+)(?:[eE][+-]?\d+)?$/);
            if (m && (m[2].length !== 3 || m[1].length > 3)) { decimalDot++; continue; }
            // "0,500" / "0.500": a leading zero is never a thousands group.
            m = cell.match(/^[+-]?0([.,])\d+$/);
            if (m) {
                if (m[1] === ',') decimalComma++;
                else if (m[1] === '.') decimalDot++;
            }
        }
        if (seen > maxCells) break;
    }

    let decimalSeparator = 'auto';
    if (decimalComma > 0 && decimalDot === 0) decimalSeparator = ',';
    else if (decimalDot > 0 && decimalComma === 0) decimalSeparator = '.';
    else if (decimalComma >= 4 * decimalDot && decimalComma >= 3) decimalSeparator = ',';
    else if (decimalDot >= 4 * decimalComma && decimalDot >= 3) decimalSeparator = '.';

    let thousandsSeparator = 'auto';
    const strongest = Object.entries(thousands).sort((a, b) => b[1] - a[1])[0];
    if (strongest && strongest[1] > 0) {
        const [sep] = strongest;
        if (sep === ' ' || sep === "'") {
            // Never a decimal separator, so never a risk.
            thousandsSeparator = sep;
        } else if (sep !== delimiter) {
            const other = sep === '.' ? ',' : '.';
            if (decimalSeparator === other) {
                thousandsSeparator = sep;
            } else if (decimalSeparator === 'auto' && decimalComma === 0 && decimalDot === 0) {
                // Grouped integers and no fraction anywhere ("1.234.567"):
                // the other character is the decimal one.
                thousandsSeparator = sep;
                if (other !== delimiter) decimalSeparator = other;
            }
            // Otherwise the evidence conflicts ("3.25" next to "1.234,5"):
            // stripping one character from every cell would turn some values
            // into others, so auto stays and each cell is read on its own.
        }
    }
    return {
        decimalSeparator,
        thousandsSeparator,
        evidence: { decimalComma, decimalDot, thousands },
    };
}

// ---------------------------------------------------------------------------
// Rows with the wrong number of cells
// ---------------------------------------------------------------------------

export const RAGGED_ROW_POLICIES = ['drop', 'pad'];

export function normalizeRaggedRowPolicy(value) {
    return value === 'pad' ? 'pad' : 'drop';
}

function isBlankCell(cell) {
    return String(cell ?? '').trim() === '';
}

/**
 * The header width rows may legitimately stop short of: cells after the last
 * named header column are optional when every header cell there is empty.
 */
export function minimumRowWidth(headerRow) {
    const row = headerRow || [];
    let last = row.length - 1;
    while (last >= 0 && isBlankCell(row[last])) last--;
    return Math.max(1, last + 1);
}

/**
 * Fit a row to the table's width, or say it cannot be.
 *
 *   - extra cells that are all empty (a trailing delimiter, "1;2;3;") are
 *     dropped: always safe, and the most common way a logger's rows come out
 *     one cell wider than its header;
 *   - a row short only of cells under empty header names is padded;
 *   - with policy 'pad', any short row is padded with empty cells, which load
 *     as missing values (a row cut off by the logger, or a value it skipped);
 *   - anything else is not a row of this table: null.
 *
 * @param {string[]} row
 * @param {number} width the header's width
 * @param {{ minWidth?: number, policy?: 'drop'|'pad' }} [options]
 * @returns {string[]|null} the row itself when it already fits.
 */
export function fitCsvRowToWidth(row, width, options = {}) {
    if (!Array.isArray(row)) return null;
    const n = row.length;
    if (n === width) return row;
    if (n > width) {
        for (let i = width; i < n; i++) {
            if (!isBlankCell(row[i])) return null;
        }
        return row.slice(0, width);
    }
    const minWidth = options.policy === 'pad' ? 1 : Math.max(1, Number(options.minWidth) || width);
    if (n < minWidth) return null;
    const padded = row.slice();
    while (padded.length < width) padded.push('');
    return padded;
}

/**
 * The separators a profile reads numbers with: what the reader chose, and
 * where they left it on 'auto', what the sample showed (detectedNumberFormat).
 */
export function csvNumberFormat(profile) {
    const detected = profile?.detectedNumberFormat || {};
    const decimal = normalizeDecimalSeparator(profile?.decimalSeparator);
    const thousands = normalizeThousandsSeparator(profile?.thousandsSeparator);
    return {
        decimalSeparator: decimal === 'auto' ? (detected.decimalSeparator || 'auto') : decimal,
        thousandsSeparator: thousands === 'auto' ? (detected.thousandsSeparator || 'auto') : thousands,
    };
}

/**
 * The rows of a table from its first data row on, each fitted to the header's
 * width (fitCsvRowToWidth). Blank rows are skipped and not counted.
 *
 * @returns {{ rows: string[][], dropped: number, repaired: number, trailingEmpty: number }}
 *   `repaired` counts rows padded or trimmed to fit; `trailingEmpty` the most
 *   empty cells any row carried past the header's width.
 */
export function fitCsvTableRows(rows, startIndex, headerRow, options = {}) {
    const width = (headerRow || []).length;
    const minWidth = minimumRowWidth(headerRow);
    const policy = normalizeRaggedRowPolicy(options.policy);
    const out = [];
    let dropped = 0;
    let repaired = 0;
    let trailingEmpty = 0;
    for (let i = Math.max(0, startIndex); i < (rows || []).length; i++) {
        const row = rows[i];
        if (!row || !row.some(cell => !isBlankCell(cell))) continue;
        const fitted = fitCsvRowToWidth(row, width, { minWidth, policy });
        if (!fitted) { dropped++; continue; }
        if (fitted !== row) {
            repaired++;
            if (row.length > width) trailingEmpty = Math.max(trailingEmpty, row.length - width);
        }
        out.push(fitted);
    }
    return { rows: out, dropped, repaired, trailingEmpty };
}

/**
 * The header's width without trailing columns that have neither a name nor
 * a value: a header ending in a delimiter ("Horodatage,Valeur,Fiabilite,")
 * otherwise adds an empty, unnamed variable to every file a GTB exports.
 */
export function trimmedTableWidth(headerRow, dataRows) {
    let width = (headerRow || []).length;
    while (width > 1 && isBlankCell(headerRow[width - 1])
        && (dataRows || []).every(row => isBlankCell(row?.[width - 1]))) {
        width--;
    }
    return width;
}

/**
 * How the data rows end their lines, from the first data line on:
 * 'crlf', 'lf', 'cr', or 'mixed'. DuckDB needs to be told when it
 * is CRLF and the lines above the table do not all agree: it counts the
 * lines to skip differently, or fails, when a preamble mixes LF and CRLF.
 */
export function detectLineEnding(text, fromLine = 0) {
    const source = String(text ?? '');
    // The data region: past `fromLine` line breaks (the preamble and header).
    let start = 0;
    for (let seen = 0; seen < fromLine && start < source.length; start++) {
        const c = source.charCodeAt(start);
        if (c === 10 || (c === 13 && source.charCodeAt(start + 1) !== 10)) seen++;
    }
    const tail = source.slice(start, start + 65536);
    let crlf = 0;
    let lf = 0;
    let cr = 0;
    for (let i = 0; i < tail.length; i++) {
        const c = tail.charCodeAt(i);
        if (c === 13) {
            if (tail.charCodeAt(i + 1) === 10) { crlf++; i++; } else cr++;
        } else if (c === 10) {
            lf++;
        }
    }
    if (crlf && !lf && !cr) return 'crlf';
    if (lf && !crlf && !cr) return 'lf';
    if (cr && !crlf && !lf) return 'cr';
    return crlf || lf || cr ? 'mixed' : 'lf';
}
