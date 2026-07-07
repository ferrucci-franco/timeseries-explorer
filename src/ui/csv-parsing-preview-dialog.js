import i18n from '../i18n/index.js';
import Modal from './modal.js';
import { csvRowMatchesFilter, normalizeCsvRowFilter } from '../parsers/csv-parser.js';
import { customDatetimePatternInfo, detectCsvTimeAxis, parseCsvNumber, parseCsvTimeValue } from '../parsers/csv-time-detection.js';

const LINE_LIMITS = [10, 25, 50, 100, 150, 200];
const MAX_PREVIEW_LINES = 5000;
const CUSTOM_LINE_LIMIT_VALUE = 'custom';
const DEFAULT_SAMPLE_BYTES = 2 * 1024 * 1024;
const DEFAULT_SIDE_PANEL_WIDTH = 416;
const MIN_SIDE_PANEL_WIDTH = 338;
const MAX_SIDE_PANEL_WIDTH = 720;
const MIN_GRID_WIDTH = 360;
const DELIMITERS = [
    { value: ',', label: ', comma' },
    { value: ';', label: '; semicolon' },
    { value: '\t', label: 'tab' },
    { value: 'whitespace', label: 'whitespace' },
];
const INLINE_UNIT_FORMATS = [
    { value: 'auto', label: 'Auto' },
    { value: 'paren', label: '(...)' },
    { value: 'bracket', label: '[...]' },
    { value: 'brace', label: '{...}' },
    { value: 'angle', label: '<...>' },
    { value: 'slash', label: 'name / unit' },
];
const ENCODINGS = [
    { value: 'auto', label: 'UTF-8 auto' },
    { value: 'utf-8', label: 'UTF-8' },
    { value: 'windows-1252', label: 'Windows-1252' },
    { value: 'latin1', label: 'Latin-1' },
];
const DECIMAL_SEPARATORS = [
    { value: 'auto', label: 'Auto' },
    { value: '.', label: '. dot' },
    { value: ',', label: ', comma' },
];
const TIME_FORMATS = [
    { value: 'auto', label: 'Auto' },
    { value: 'custom', label: 'Custom' },
];
const ROW_FILTER_OPERATORS = [
    { value: '==', label: '==' },
    { value: '!=', label: '!=' },
    { value: 'is_numeric', labelKey: 'csvPreviewRowFilterIsNumeric' },
];
const SAMPLE_REGION_KEYS = {
    start: 'csvPreviewSampleStart',
    middle: 'csvPreviewSampleMiddle',
    end: 'csvPreviewSampleEnd',
};
const PARSED_DATETIME_FORMAT_LABEL = 'YYYY-MM-DD hh:mm:ss';

function rowFilterOperatorOptions() {
    return ROW_FILTER_OPERATORS.map(option => ({
        ...option,
        label: option.labelKey ? i18n.t(option.labelKey) : option.label,
    }));
}

function formatParsedTimeValue(timeSource, value) {
    if (!Number.isFinite(value)) return '';
    if (timeSource?.kind === 'datetime') {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return '';
        const iso = date.toISOString().replace('T', ' ').replace('Z', '');
        return iso.endsWith('.000') ? iso.slice(0, -4) : iso;
    }
    return String(Number.isInteger(value) ? value : Number(value.toPrecision(12)));
}

function unitTextFromDescription(description) {
    const text = String(description || '').trim();
    const bracketed = text.match(/^\[([^\]]+)\]$/);
    return bracketed ? bracketed[1].trim() : text;
}

function isEmptyPreviewRow(row) {
    return !(row || []).some(cell => String(cell ?? '').trim() !== '');
}

function inferNumericColumnIndexes(rows, columnCount, delimiter, decimalSeparator = 'auto') {
    const numericIndexes = [];
    for (let index = 0; index < columnCount; index++) {
        let nonEmpty = 0;
        let numeric = 0;
        for (const row of rows || []) {
            const raw = String(row?.[index] ?? '').trim();
            if (!raw) continue;
            nonEmpty++;
            if (Number.isFinite(parseCsvNumber(raw, delimiter, decimalSeparator))) numeric++;
        }
        if (nonEmpty > 0 && numeric / nonEmpty > 0.5) numericIndexes.push(index);
    }
    return numericIndexes;
}

function rowHasInvalidNumericCell(row, numericIndexes, delimiter, decimalSeparator = 'auto') {
    for (const index of numericIndexes || []) {
        const raw = String(row?.[index] ?? '').trim();
        if (raw && !Number.isFinite(parseCsvNumber(raw, delimiter, decimalSeparator))) return true;
    }
    return false;
}

function parsedColumnFormatLabel(timeSource) {
    if (timeSource?.kind === 'datetime') {
        if (timeSource.strategy === 'excel-serial') return 'Excel serial -> YYYY-MM-DD hh:mm:ss';
        if (timeSource.strategy === 'matlab-datenum') return 'MATLAB datenum -> YYYY-MM-DD hh:mm:ss';
        if (timeSource.strategy === 'partial-year-month') return 'YYYY-MM -> day=01';
        if (timeSource.strategy === 'custom-format') {
            const info = customDatetimePatternInfo(timeSource.format?.pattern || '');
            if (info && (!info.hasYear || !info.hasMonth || !info.hasDay)) {
                const assumed = [];
                if (!info.hasYear) assumed.push('year=2001');
                if (!info.hasMonth) assumed.push('month=01');
                if (!info.hasDay) assumed.push('day=01');
                return `${timeSource.format?.pattern || 'Custom'} -> ${assumed.join(', ')}`;
            }
        }
        return PARSED_DATETIME_FORMAT_LABEL;
    }
    if (timeSource?.kind === 'index') return '[index]';
    if (timeSource?.kind === 'numeric') return '[numeric]';
    return '';
}

function dateOrderPattern(order, separator, hasTime, hasMeridiem = false) {
    const parts = {
        YMD: ['yyyy', 'MM', 'dd'],
        DMY: ['dd', 'MM', 'yyyy'],
        MDY: ['MM', 'dd', 'yyyy'],
    }[order || 'YMD'] || ['yyyy', 'MM', 'dd'];
    const date = parts.join(separator);
    if (!hasTime) return date;
    return hasMeridiem ? `${date} hh:mm AM/PM` : `${date} HH:mm:ss`;
}

function customPatternFromTimeSource(timeSource) {
    const strategy = timeSource?.strategy || '';
    const format = timeSource?.format || {};
    if (!timeSource?.ok) return '';
    if (strategy === 'custom-format') return format.pattern || '';
    if (strategy === 'excel-serial') return 'Excel';
    if (strategy === 'matlab-datenum') return 'Matlab';
    if (strategy === 'partial-year-month') return format.dashSeparator === false ? 'yyyy/MM' : 'yyyy-MM';
    if (strategy === 'iso-datetime') return format.hasTime ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd';
    if (strategy === 'slash-date' || strategy === 'dash-date') {
        return dateOrderPattern(format.dateOrder, strategy === 'dash-date' ? '-' : '/', !!format.hasTime, !!format.hasMeridiem);
    }
    if (strategy === 'month-name-date') {
        const order = format.dateOrder || 'DMY';
        if (order === 'MDY') return format.hasTime ? 'MMM dd yyyy HH:mm:ss' : 'MMM dd yyyy';
        return format.hasTime ? 'dd MMM yyyy HH:mm:ss' : 'dd MMM yyyy';
    }
    if (strategy === 'yearless-date-time') {
        const separator = format.dashSeparator ? '-' : '/';
        return dateOrderPattern(format.dateOrder === 'DMY' ? 'DMY' : 'MDY', separator, true, !!format.hasMeridiem).replace('yyyy', '').replace(/^[/\-\s]+|[/\-\s]+$/g, '');
    }
    return '';
}

function autoDetectedFormatText(timeSource) {
    const strategy = timeSource?.strategy || '';
    const format = timeSource?.format || {};
    if (!timeSource?.ok) return i18n.t('csvPreviewAutoTimeFormatHelp');
    if (timeSource.kind === 'numeric' || strategy === 'numeric') {
        return i18n.t('csvPreviewAutoDetectedFormat')
            .replace('{format}', i18n.t('csvPreviewAutoDetectedNumeric'));
    }
    if (strategy === 'excel-serial') {
        return i18n.t('csvPreviewAutoDetectedFormat')
            .replace('{format}', i18n.t('csvPreviewAutoDetectedExcelSerial'));
    }
    if (strategy === 'matlab-datenum') {
        return i18n.t('csvPreviewAutoDetectedFormat')
            .replace('{format}', i18n.t('csvPreviewAutoDetectedMatlabDatenum'));
    }
    if (strategy === 'decimal-year') {
        return i18n.t('csvPreviewAutoDetectedFormat')
            .replace('{format}', i18n.t('csvPreviewAutoDetectedDecimalYear'));
    }
    if (strategy === 'partial-year-month') {
        return i18n.t('csvPreviewAutoDetectedFormat')
            .replace('{format}', i18n.t('csvPreviewAutoDetectedYearMonth'));
    }
    if (strategy === 'iso-datetime') {
        const pattern = format.hasTime ? 'yyyy-MM-dd HH:mm:ss' : 'yyyy-MM-dd';
        return i18n.t('csvPreviewAutoDetectedDatePattern').replace('{pattern}', pattern);
    }
    if (strategy === 'slash-date' || strategy === 'dash-date') {
        const separator = strategy === 'dash-date' ? '-' : '/';
        return i18n.t('csvPreviewAutoDetectedDatePattern')
            .replace('{pattern}', dateOrderPattern(format.dateOrder, separator, !!format.hasTime, !!format.hasMeridiem));
    }
    if (strategy === 'month-name-date') {
        return i18n.t('csvPreviewAutoDetectedFormat')
            .replace('{format}', i18n.t('csvPreviewAutoDetectedMonthName'));
    }
    if (strategy === 'yearless-date-time') {
        return i18n.t('csvPreviewAutoDetectedFormat')
            .replace('{format}', i18n.t('csvPreviewAutoDetectedYearless'));
    }
    return i18n.t('csvPreviewAutoTimeFormatHelp');
}

function cloneProfile(profile) {
    if (!profile) return null;
    return JSON.parse(JSON.stringify(profile, (_key, value) =>
        typeof value === 'function' ? undefined : value
    ));
}

function hasGeneratedColumnHeaders(rawHeaders) {
    return Array.isArray(rawHeaders)
        && rawHeaders.length > 0
        && rawHeaders.every((header, index) => String(header || '') === `column_${index + 1}`);
}

function columnLabel(index) {
    let n = index + 1;
    let label = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        label = String.fromCharCode(65 + rem) + label;
        n = Math.floor((n - 1) / 26);
    }
    return label;
}

function toRowNumber(index) {
    return Number.isFinite(index) ? String(index + 1) : '';
}

function fromRowNumber(value, fallback = 0) {
    const n = Math.trunc(Number(value));
    return Number.isFinite(n) && n > 0 ? n - 1 : fallback;
}

function decimalSeparatorOptions(delimiter) {
    return DECIMAL_SEPARATORS.map(option => {
        if (option.value !== ',' || delimiter !== ',') return option;
        return {
            ...option,
            disabled: true,
            label: i18n.t('csvPreviewDecimalCommaUnavailable'),
            title: i18n.t('csvPreviewDecimalCommaUnavailableTooltip'),
        };
    });
}

function makeIndexTimeSource() {
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
        warnings: [],
    };
}

function buildIndexColumnTimeSource(parser, rawHeaders, dataRows, delimiter, columnIndex, decimalSeparator = 'auto') {
    const name = headerName(parser, rawHeaders[columnIndex], columnIndex);
    const parsed = dataRows
        .map(row => parseCsvNumber(row?.[columnIndex], delimiter, decimalSeparator))
        .filter(Number.isFinite);
    if (!dataRows.length || parsed.length / dataRows.length < 0.8) {
        return { ok: false, reason: 'Selected index column must be numeric.' };
    }
    for (let i = 1; i < parsed.length; i++) {
        if (parsed[i] < parsed[i - 1]) {
            return { ok: false, reason: 'Selected index column must be monotonically non-decreasing.' };
        }
    }
    return {
        ok: true,
        kind: 'index',
        mode: 'index-column',
        strategy: 'index-column',
        sourceIndexes: [columnIndex],
        sourceHeaders: [rawHeaders[columnIndex] || name],
        name,
        description: '[index]',
        confidence: parsed.length / dataRows.length,
        format: { source: 'column', allowRepeated: true },
        warnings: [],
    };
}

function serializeTimeSource(timeSource) {
    return {
        ok: !!timeSource?.ok,
        kind: timeSource?.kind,
        mode: timeSource?.mode,
        strategy: timeSource?.strategy || null,
        sourceIndexes: Array.isArray(timeSource?.sourceIndexes) ? timeSource.sourceIndexes.slice() : [],
        sourceHeaders: Array.isArray(timeSource?.sourceHeaders) ? timeSource.sourceHeaders.slice() : [],
        name: timeSource?.name,
        description: timeSource?.description,
        confidence: timeSource?.confidence,
        format: { ...(timeSource?.format || {}) },
        warnings: Array.isArray(timeSource?.warnings) ? timeSource.warnings.slice() : [],
    };
}

function headerName(parser, rawHeader, index) {
    return parser?._parseHeader?.(rawHeader, index)?.name || String(rawHeader || `column_${index + 1}`).trim() || `column_${index + 1}`;
}

function applyHeaderNamesToTimeSource(timeSource, headers) {
    if (!timeSource?.ok || !Array.isArray(timeSource.sourceIndexes)) return timeSource;
    const namedIndexes = timeSource.sourceIndexes
        .map(index => ({ index, name: headers[index]?.name }))
        .filter(item => Number.isInteger(item.index) && item.name);
    if (!namedIndexes.length) return timeSource;

    const next = serializeTimeSource(timeSource);
    next.sourceHeaders = namedIndexes.map(item => item.name);
    next.name = namedIndexes.map(item => item.name).join(' ') || next.name;
    return next;
}

function buildManualTimeSource(parser, rawHeaders, dataRows, delimiter, columnIndex, dateOrder, options = {}) {
    const decimalSeparator = options.decimalSeparator || 'auto';
    const customPattern = String(options.customPattern || '').trim();
    if (options.timeFormat === 'custom') {
        const name = headerName(parser, rawHeaders[columnIndex], columnIndex);
        if (!customPattern) return { ok: false, reason: 'Custom datetime pattern is empty.' };
        const alias = customPattern.toLowerCase().replace(/[\s_-]+/g, '');
        if (alias === 'excel' || alias === 'excelserial' || alias === 'excelserialdate') {
            const source = {
                ok: true,
                kind: 'datetime',
                mode: 'single',
                strategy: 'excel-serial',
                sourceIndexes: [columnIndex],
                sourceHeaders: [rawHeaders[columnIndex] || name],
                name,
                description: '[datetime]',
                confidence: 1,
                format: { pattern: 'Excel', dateOrder: 'YMD', hasTime: true, timezone: 'utc', excelSerial: true },
                warnings: [],
            };
            const validRows = dataRows.filter((row, index) =>
                Number.isFinite(parseCsvTimeValue(source, row, index, delimiter, { decimalSeparator }))
            ).length;
            if (!dataRows.length || validRows / dataRows.length < 0.8) {
                return { ok: false, reason: 'Selected column does not parse as Excel serial dates.' };
            }
            source.confidence = validRows / dataRows.length;
            return source;
        }
        if (alias === 'matlab' || alias === 'matlabdatenum') {
            const source = {
                ok: true,
                kind: 'datetime',
                mode: 'single',
                strategy: 'matlab-datenum',
                sourceIndexes: [columnIndex],
                sourceHeaders: [rawHeaders[columnIndex] || name],
                name,
                description: '[MATLAB datenum]',
                confidence: 1,
                format: { pattern: 'Matlab', dateOrder: 'YMD', hasTime: true, timezone: 'utc', matlabDatenum: true },
                warnings: [],
            };
            const validRows = dataRows.filter((row, index) =>
                Number.isFinite(parseCsvTimeValue(source, row, index, delimiter, { decimalSeparator }))
            ).length;
            if (!dataRows.length || validRows / dataRows.length < 0.8) {
                return { ok: false, reason: 'Selected column does not parse as MATLAB datenum values.' };
            }
            source.confidence = validRows / dataRows.length;
            return source;
        }
        const source = {
            ok: true,
            kind: 'datetime',
            mode: 'single',
            strategy: 'custom-format',
            sourceIndexes: [columnIndex],
            sourceHeaders: [rawHeaders[columnIndex] || name],
            name,
            description: '[datetime]',
            confidence: 1,
            format: { pattern: customPattern, hasTime: /[HhmsS]/.test(customPattern), timezone: 'floating' },
            warnings: [],
        };
        const validRows = dataRows.filter((row, index) =>
            Number.isFinite(parseCsvTimeValue(source, row, index, delimiter, { decimalSeparator }))
        ).length;
        const validRatio = dataRows.length ? validRows / dataRows.length : 0;
        const minValidRows = dataRows.length >= 3 ? 2 : 1;
        if (!dataRows.length || validRows < minValidRows || validRatio < 0.5) {
            return { ok: false, reason: 'Custom datetime pattern does not match the selected column.' };
        }
        source.confidence = validRatio;
        return source;
    }

    const detected = detectCsvTimeAxis(rawHeaders, dataRows, { delimiter, preferredDateOrder: dateOrder });
    if (detected?.ok && detected.sourceIndexes?.[0] === columnIndex) {
        const source = serializeTimeSource(detected);
        if (source.format && dateOrder && (source.strategy === 'slash-date' || source.strategy === 'dash-date')) {
            source.format.dateOrder = dateOrder;
        }
        return source;
    }

    const values = dataRows
        .map(row => String(row?.[columnIndex] ?? '').trim())
        .filter(Boolean)
        .slice(0, 80);
    const name = headerName(parser, rawHeaders[columnIndex], columnIndex);
    if (!values.length) return { ok: false, reason: 'Selected time column is empty.' };

    const numericRatio = values.filter(value => Number.isFinite(parseCsvNumber(value, delimiter, decimalSeparator))).length / values.length;
    if (numericRatio >= 0.8) {
        return {
            ok: true,
            kind: 'numeric',
            mode: 'single',
            strategy: 'numeric',
            sourceIndexes: [columnIndex],
            sourceHeaders: [rawHeaders[columnIndex] || name],
            name,
            description: `Numeric time from column "${name}"`,
            confidence: numericRatio,
            format: {},
            warnings: [],
        };
    }

    const isoRatio = values.filter(value => /^\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?/.test(value)).length / values.length;
    if (isoRatio >= 0.8) {
        return {
            ok: true,
            kind: 'datetime',
            mode: 'single',
            strategy: 'iso-datetime',
            sourceIndexes: [columnIndex],
            sourceHeaders: [rawHeaders[columnIndex] || name],
            name,
            description: '[datetime]',
            confidence: isoRatio,
            format: { dateOrder: 'YMD', hasTime: true, timezone: 'floating', excelSerial: false },
            warnings: [],
        };
    }

    const slashRatio = values.filter(value => /^\d{1,4}\/\d{1,2}\/\d{1,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*[AP]M)?)?$/i.test(value)).length / values.length;
    if (slashRatio >= 0.8) {
        const meridiemRatio = values.filter(value => /[AP]M\s*$/i.test(value)).length / values.length;
        return {
            ok: true,
            kind: 'datetime',
            mode: 'single',
            strategy: 'slash-date',
            sourceIndexes: [columnIndex],
            sourceHeaders: [rawHeaders[columnIndex] || name],
            name,
            description: '[datetime]',
            confidence: slashRatio,
            format: { dateOrder: dateOrder || 'YMD', hasTime: true, hasMeridiem: meridiemRatio >= 0.5, timezone: 'floating', excelSerial: false },
            warnings: [],
        };
    }

    const dashRatio = values.filter(value => /^\d{1,4}-\d{1,2}-\d{1,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*[AP]M)?)?$/i.test(value)).length / values.length;
    if (dashRatio >= 0.8) {
        const meridiemRatio = values.filter(value => /[AP]M\s*$/i.test(value)).length / values.length;
        return {
            ok: true,
            kind: 'datetime',
            mode: 'single',
            strategy: 'dash-date',
            sourceIndexes: [columnIndex],
            sourceHeaders: [rawHeaders[columnIndex] || name],
            name,
            description: '[datetime]',
            confidence: dashRatio,
            format: { dateOrder: dateOrder || 'YMD', hasTime: true, hasMeridiem: meridiemRatio >= 0.5, timezone: 'floating', excelSerial: false, dashSeparator: true },
            warnings: [],
        };
    }

    return { ok: false, reason: 'Selected time column does not parse as numeric time or a supported date.' };
}

function buildSplitTimeSource(parser, rawHeaders, dataRows, delimiter, dateColumnIndex, timeColumnIndex, dateOrder) {
    const detected = detectCsvTimeAxis(rawHeaders, dataRows, { delimiter, preferredDateOrder: dateOrder });
    const detectedIndexes = detected?.sourceIndexes || [];
    if (detected?.ok
        && detected.mode === 'split'
        && detectedIndexes[0] === dateColumnIndex
        && detectedIndexes[1] === timeColumnIndex) {
        const source = serializeTimeSource(detected);
        if (source.format && dateOrder) source.format.dateOrder = dateOrder;
        return source;
    }

    const dateValues = dataRows
        .map(row => String(row?.[dateColumnIndex] ?? '').trim())
        .filter(Boolean)
        .slice(0, 80);
    const timeValues = dataRows
        .map(row => String(row?.[timeColumnIndex] ?? '').trim())
        .filter(Boolean)
        .slice(0, 80);
    if (!dateValues.length || !timeValues.length) {
        return { ok: false, reason: 'Selected date/time columns must not be empty.' };
    }

    const dateRatio = dateValues.filter(value =>
        /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(value)
        || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/.test(value)
    ).length / dateValues.length;
    const timeRatio = timeValues.filter(value =>
        /^\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*(?:am|pm))?$/i.test(value)
    ).length / timeValues.length;
    if (dateRatio < 0.8 || timeRatio < 0.8) {
        return { ok: false, reason: 'Selected columns do not look like separate date and time columns.' };
    }

    const dateName = headerName(parser, rawHeaders[dateColumnIndex], dateColumnIndex);
    const timeName = headerName(parser, rawHeaders[timeColumnIndex], timeColumnIndex);
    const dashSeparator = dateValues.filter(value => value.includes('-')).length >= dateValues.length / 2;
    return {
        ok: true,
        kind: 'datetime',
        mode: 'split',
        strategy: 'split-date-time',
        sourceIndexes: [dateColumnIndex, timeColumnIndex],
        sourceHeaders: [rawHeaders[dateColumnIndex] || dateName, rawHeaders[timeColumnIndex] || timeName],
        name: `${dateName} ${timeName}`,
        description: '[datetime]',
        confidence: Math.min(dateRatio, timeRatio),
        format: { dateOrder: dateOrder || 'YMD', hasTime: true, timezone: 'floating', excelSerial: false, dashSeparator },
        warnings: [],
    };
}

function buildPartsTimeSource(parser, rawHeaders, dataRows, delimiter, parts, decimalSeparator = 'auto') {
    const assigned = Object.entries(parts)
        .filter(([, index]) => Number.isInteger(index) && index >= 0);
    if (!assigned.length) {
        return { ok: false, reason: 'At least one date/time part column is required.' };
    }
    const used = new Set();
    for (const [, index] of assigned) {
        if (used.has(index)) return { ok: false, reason: 'Each date/time part must use a different column.' };
        used.add(index);
    }

    const testSource = {
        ok: true,
        kind: 'datetime',
        mode: 'parts',
        strategy: 'parts',
        sourceIndexes: assigned.map(([, index]) => index),
        sourceHeaders: assigned.map(([, index]) => rawHeaders[index] || `column_${index + 1}`),
        name: 'datetime',
        description: '[datetime]',
        confidence: 1,
        format: { parts: { ...parts } },
        warnings: [],
    };
    const validRows = dataRows.filter((row, index) =>
        Number.isFinite(parseCsvTimeValue(testSource, row, index, delimiter, { decimalSeparator }))
    ).length;
    if (!dataRows.length || validRows / dataRows.length < 0.8) {
        return { ok: false, reason: 'Selected date/time parts do not produce valid datetimes.' };
    }

    const sourceIndexes = assigned.map(([, index]) => index);
    const sourceHeaders = assigned.map(([, index]) => rawHeaders[index] || `column_${index + 1}`);
    const name = sourceHeaders
        .map((header, index) => headerName(parser, header, sourceIndexes[index]))
        .join(' ');
    return {
        ...testSource,
        sourceIndexes,
        sourceHeaders,
        name: name || 'datetime',
        confidence: validRows / dataRows.length,
    };
}

function parseInlineUnitHeader(rawHeader, index, format = 'auto') {
    const fallback = index === 0 ? 'time' : `column_${index + 1}`;
    const raw = String(rawHeader || '').trim();
    if (!raw) return { name: fallback, description: '', unit: '' };

    const patterns = [
        { key: 'paren', re: /^(.*?)\s*\(([^)]+)\)\s*$/ },
        { key: 'bracket', re: /^(.*?)\s*\[([^\]]+)\]\s*$/ },
        { key: 'brace', re: /^(.*?)\s*\{([^}]+)\}\s*$/ },
        { key: 'angle', re: /^(.*?)\s*<([^>]+)>\s*$/ },
        { key: 'slash', re: /^(.*?)\s+\/\s+(.+?)\s*$/ },
    ];
    const candidates = format === 'auto'
        ? patterns
        : patterns.filter(pattern => pattern.key === format);
    for (const pattern of candidates) {
        const match = raw.match(pattern.re);
        if (!match) continue;
        const name = String(match[1] || '').trim() || fallback;
        const unit = String(match[2] || '').trim();
        if (unit) return { name, description: `[${unit}]`, unit };
    }
    return { name: raw || fallback, description: '', unit: '' };
}

function makeUniqueInlineHeaders(rawHeaders, format) {
    const seen = new Map();
    return rawHeaders.map((raw, index) => {
        const parsed = parseInlineUnitHeader(raw, index, format);
        const base = parsed.name;
        const count = (seen.get(base) || 0) + 1;
        seen.set(base, count);
        return {
            name: count === 1 ? base : `${base}_${count}`,
            description: parsed.description,
        };
    });
}

export default class CsvParsingPreviewDialog {
    static open(options = {}) {
        const dialog = new CsvParsingPreviewDialog(options);
        return dialog.open();
    }

    constructor({ parser, sampleBuffer, sampleSegments = null, loadPreviewSegment = null, csvProfile = null, title = '' } = {}) {
        this.parser = parser;
        const normalizedSegments = Array.isArray(sampleSegments)
            ? sampleSegments.filter(segment => segment?.buffer)
            : [];
        this.sampleSegments = normalizedSegments.length
            ? normalizedSegments
            : [{ id: 'start', buffer: sampleBuffer, offset: 0, bytes: sampleBuffer?.byteLength || 0, totalSize: sampleBuffer?.byteLength || 0 }];
        this.loadPreviewSegment = typeof loadPreviewSegment === 'function' ? loadPreviewSegment : null;
        this.autoProfile = cloneProfile(csvProfile);
        this.title = title;
        this.sidePanelWidth = DEFAULT_SIDE_PANEL_WIDTH;
        this.headerlessProfileLocked = this.autoProfile?.hasHeader === false
            && hasGeneratedColumnHeaders(this.autoProfile?.rawHeaders);
        this.state = {
            lineLimit: 10,
            sampleRegion: this.sampleSegments[0]?.id || 'start',
            hideEmptyLines: false,
            hidePreambleRows: true,
            hideInvalidLines: false,
            delimiter: this.autoProfile?.delimiter || ',',
            encoding: this.autoProfile?.encoding || 'auto',
            decimalSeparator: this.autoProfile?.decimalSeparator || 'auto',
            hasHeader: this.autoProfile?.hasHeader !== false,
            headerIndex: Math.max(0, Number(this.autoProfile?.headerIndex) || 0),
            unitsMode: this.autoProfile?.unitsMode || (Number.isFinite(Number(this.autoProfile?.unitRowIndex)) ? 'row' : 'none'),
            unitRowIndex: Number.isFinite(Number(this.autoProfile?.unitRowIndex)) ? Number(this.autoProfile.unitRowIndex) : null,
            inlineUnitFormat: this.autoProfile?.inlineUnitFormat || 'auto',
            ignoredColumns: Array.isArray(this.autoProfile?.ignoredColumns) ? this.autoProfile.ignoredColumns.slice() : [],
            columnOverrides: this.autoProfile?.columnOverrides && typeof this.autoProfile.columnOverrides === 'object'
                ? cloneProfile(this.autoProfile.columnOverrides)
                : {},
            rowFilter: this.autoProfile?.rowFilter?.enabled
                ? {
                    enabled: true,
                    columnIndex: Math.max(0, Number(this.autoProfile.rowFilter.columnIndex) || 0),
                    operator: ['!=', 'is_numeric'].includes(this.autoProfile.rowFilter.operator) ? this.autoProfile.rowFilter.operator : '==',
                    value: String(this.autoProfile.rowFilter.value ?? ''),
                }
                : { enabled: false, columnIndex: 0, operator: '==', value: '' },
            showColumnTools: !!(
                (Array.isArray(this.autoProfile?.ignoredColumns) && this.autoProfile.ignoredColumns.length)
                || (this.autoProfile?.columnOverrides && Object.keys(this.autoProfile.columnOverrides).length)
            ),
            dataStartIndex: Number.isFinite(Number(this.autoProfile?.dataStartIndex))
                ? Math.max(0, Number(this.autoProfile.dataStartIndex))
                : 1,
            timeMode: this.autoProfile?.timeSource?.kind === 'index'
                ? (this.autoProfile?.timeSource?.strategy === 'index-column' ? 'index-column' : 'index')
                : this.autoProfile?.timeSource?.mode === 'split' ? 'split' : 'single',
            timeColumn: Array.isArray(this.autoProfile?.timeSource?.sourceIndexes) ? (this.autoProfile.timeSource.sourceIndexes[0] ?? 0) : 0,
            timeDateColumn: Array.isArray(this.autoProfile?.timeSource?.sourceIndexes) ? (this.autoProfile.timeSource.sourceIndexes[0] ?? 0) : 0,
            timeTimeColumn: Array.isArray(this.autoProfile?.timeSource?.sourceIndexes) ? (this.autoProfile.timeSource.sourceIndexes[1] ?? 1) : 1,
            timeParts: {
                year: this.autoProfile?.timeSource?.format?.parts?.year ?? 0,
                month: this.autoProfile?.timeSource?.format?.parts?.month ?? 1,
                day: this.autoProfile?.timeSource?.format?.parts?.day ?? 2,
                hour: this.autoProfile?.timeSource?.format?.parts?.hour ?? null,
                minute: this.autoProfile?.timeSource?.format?.parts?.minute ?? null,
                second: this.autoProfile?.timeSource?.format?.parts?.second ?? null,
            },
            timeFormat: this.autoProfile?.timeSource?.strategy === 'custom-format' ? 'custom' : 'auto',
            customDatetimePattern: this.autoProfile?.timeSource?.format?.pattern || 'yyyy/MM/dd HH:mm:ss',
            dateOrder: this.autoProfile?.timeSource?.format?.dateOrder || 'YMD',
        };
        if (this.autoProfile?.timeSource?.mode === 'parts') this.state.timeMode = 'parts';
        this.preview = null;
        this.resultProfile = null;
        this.lastStartProfile = null;
        this.validation = { ok: false, messages: [] };
    }

    open() {
        return new Promise((resolve) => {
            this.resolve = resolve;
            this.previousActive = document.activeElement;
            this.overlay = document.createElement('div');
            this.overlay.className = 'csv-preview-overlay';
            this.overlay.setAttribute('role', 'dialog');
            this.overlay.setAttribute('aria-modal', 'true');

            this.dialog = document.createElement('div');
            this.dialog.className = 'csv-preview-dialog';

            this._renderShell();
            this.overlay.appendChild(this.dialog);
            document.body.appendChild(this.overlay);

            this.keyHandler = (event) => {
                if (event.key === 'Escape') this._finish(null);
            };
            document.addEventListener('keydown', this.keyHandler);
            this.overlay.addEventListener('click', event => {
                if (event.target === this.overlay) this._finish(null);
            });

            this._refreshPreview();
            requestAnimationFrame(() => this.overlay.classList.add('show'));
        });
    }

    _renderShell() {
        this.dialog.innerHTML = '';
        const header = document.createElement('div');
        header.className = 'csv-preview-header';
        const heading = document.createElement('div');
        heading.className = 'csv-preview-title';
        heading.textContent = i18n.t('csvPreviewTitle');
        const subtitle = document.createElement('div');
        subtitle.className = 'csv-preview-subtitle';
        subtitle.textContent = this.title || '';
        this.confidence = document.createElement('div');
        this.confidence.className = 'csv-preview-confidence';
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'csv-preview-close';
        closeBtn.textContent = '✕';
        closeBtn.title = i18n.t('cancel');
        closeBtn.setAttribute('aria-label', i18n.t('cancel'));
        closeBtn.addEventListener('click', () => this._finish(null));
        header.append(heading, subtitle, this.confidence, closeBtn);

        const toolbar = document.createElement('div');
        toolbar.className = 'csv-preview-toolbar';
        this.lineLimitSelect = this._select(this._lineLimitOptions(), this._selectedLineLimitValue());
        this.sampleRegionSelect = this._select(this._sampleRegionOptions(), this.state.sampleRegion);
        this.delimiterSelect = this._select(DELIMITERS, this.state.delimiter);
        if (this.state.delimiter === ',' && this.state.decimalSeparator === ',') this.state.decimalSeparator = 'auto';
        this.decimalSelect = this._select(decimalSeparatorOptions(this.state.delimiter), this.state.decimalSeparator);
        this.encodingSelect = this._select(ENCODINGS, this.state.encoding);
        this.customLineLimitWrap = document.createElement('div');
        this.customLineLimitWrap.className = 'csv-preview-custom-lines';
        this.customLineLimitInput = document.createElement('input');
        this.customLineLimitInput.type = 'number';
        this.customLineLimitInput.min = '1';
        this.customLineLimitInput.max = String(MAX_PREVIEW_LINES);
        this.customLineLimitInput.step = '1';
        this.customLineLimitInput.value = String(this.state.lineLimit);
        this.customLineLimitInput.title = i18n.t('csvPreviewCustomLinesTooltip').replace('{max}', String(MAX_PREVIEW_LINES));
        this.customLineLimitButton = document.createElement('button');
        this.customLineLimitButton.type = 'button';
        this.customLineLimitButton.className = 'csv-preview-custom-lines-ok';
        this.customLineLimitButton.textContent = i18n.t('csvPreviewCustomLinesOk');
        this.customLineLimitButton.title = i18n.t('csvPreviewCustomLinesTooltip').replace('{max}', String(MAX_PREVIEW_LINES));
        this.customLineLimitWrap.append(this.customLineLimitInput, this.customLineLimitButton);
        this.lineLimitSelect.addEventListener('change', async () => {
            if (this.lineLimitSelect.value === CUSTOM_LINE_LIMIT_VALUE) {
                this._syncCustomLineLimitControls();
                this.customLineLimitInput?.focus();
                this.customLineLimitInput?.select();
                return;
            }
            this.state.lineLimit = Number(this.lineLimitSelect.value) || 10;
            if (this.customLineLimitInput) this.customLineLimitInput.value = String(this.state.lineLimit);
            this._syncCustomLineLimitControls();
            await this._ensurePreviewSampleForLineLimit(this.state.lineLimit);
            this._refreshPreview({ preserveStructure: true });
        });
        this.sampleRegionSelect.addEventListener('change', () => {
            this.state.sampleRegion = this.sampleRegionSelect.value;
            this._refreshPreview({ preserveStructure: true });
        });
        this.customLineLimitInput.addEventListener('keydown', event => {
            if (event.key === 'Enter') this._applyCustomLineLimit();
        });
        this.customLineLimitButton.addEventListener('click', () => this._applyCustomLineLimit());
        this._syncCustomLineLimitControls();
        this.delimiterSelect.addEventListener('change', () => {
            this.state.delimiter = this.delimiterSelect.value;
            if (this.state.delimiter === ',' && this.state.decimalSeparator === ',') this.state.decimalSeparator = 'auto';
            this._updateDecimalSeparatorSelect();
            this._refreshPreview({ redetectStructure: true });
        });
        this.decimalSelect.addEventListener('change', () => {
            this.state.decimalSeparator = this.decimalSelect.value;
            this._rebuildAndRender();
        });
        this.encodingSelect.addEventListener('change', () => {
            this.state.encoding = this.encodingSelect.value;
            this._refreshPreview({ redetectStructure: true });
        });
        toolbar.append(
            this.sampleSegments.length > 1 ? this._field(i18n.t('csvPreviewSample'), this.sampleRegionSelect) : document.createDocumentFragment(),
            this._field(i18n.t('csvPreviewLinesShown'), this.lineLimitSelect),
            this.customLineLimitWrap,
            this._field(i18n.t('csvPreviewDelimiter'), this.delimiterSelect),
            this._field(i18n.t('csvPreviewDecimalSeparator'), this.decimalSelect),
            this._field(i18n.t('csvPreviewEncoding'), this.encodingSelect),
        );

        const body = document.createElement('div');
        body.className = 'csv-preview-body';
        this.body = body;
        this.gridWrap = document.createElement('div');
        this.gridWrap.className = 'csv-preview-grid-wrap';
        this.sideResizer = document.createElement('div');
        this.sideResizer.className = 'csv-preview-resizer';
        this.sideResizer.setAttribute('role', 'separator');
        this.sideResizer.setAttribute('aria-orientation', 'vertical');
        this.sideResizer.setAttribute('aria-label', i18n.t('csvPreviewResizeSide'));
        this.sideResizer.title = i18n.t('csvPreviewResizeSide');
        this.sideResizer.tabIndex = 0;
        this.sidePanel = document.createElement('div');
        this.sidePanel.className = 'csv-preview-side';
        body.append(this.gridWrap, this.sideResizer, this.sidePanel);
        this._applySidePanelWidth();
        this._installSidePanelResize();

        const footer = document.createElement('div');
        footer.className = 'csv-preview-footer';
        const left = document.createElement('div');
        left.className = 'csv-preview-footer-left';
        const redetect = document.createElement('button');
        redetect.type = 'button';
        redetect.textContent = i18n.t('csvPreviewRedetect');
        redetect.title = i18n.t('csvPreviewRedetectTooltip');
        redetect.addEventListener('click', () => this._refreshPreview({
            redetectStructure: true,
            detectDelimiter: true,
            detectEncoding: true,
            resetDecimal: true,
            resetUnits: true,
        }));
        left.append(redetect);
        const right = document.createElement('div');
        right.className = 'csv-preview-footer-right';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'modal-btn modal-btn-cancel';
        cancel.textContent = i18n.t('cancel');
        cancel.title = i18n.t('cancel');
        cancel.addEventListener('click', () => this._finish(null));
        this.applyButton = document.createElement('button');
        this.applyButton.type = 'button';
        this.applyButton.className = 'modal-btn modal-btn-confirm';
        this.applyButton.textContent = i18n.t('csvPreviewApply');
        this.applyButton.title = i18n.t('csvPreviewApply');
        this.applyButton.addEventListener('click', () => this._finish(this.resultProfile));
        right.append(cancel, this.applyButton);
        footer.append(left, right);

        this.dialog.append(header, toolbar, body, footer);
    }

    _field(labelText, control) {
        const label = document.createElement('label');
        label.className = 'csv-preview-field';
        label.title = labelText;
        const span = document.createElement('span');
        span.textContent = labelText;
        span.title = labelText;
        if (control && !control.title) control.title = labelText;
        label.append(span, control);
        return label;
    }

    _patternField(labelText, input) {
        const wrap = document.createElement('div');
        wrap.className = 'csv-preview-pattern-control';
        const helpButton = document.createElement('button');
        helpButton.type = 'button';
        helpButton.className = 'csv-preview-pattern-help';
        helpButton.textContent = '?';
        helpButton.title = i18n.t('csvPreviewPatternHelpTooltip');
        helpButton.setAttribute('aria-label', i18n.t('csvPreviewPatternHelpTitle'));
        helpButton.addEventListener('click', event => {
            event.preventDefault();
            this._showPatternHelp();
        });
        wrap.append(input, helpButton);
        return this._field(labelText, wrap);
    }

    _formatField(labelText, select) {
        const wrap = document.createElement('div');
        wrap.className = 'csv-preview-format-control';
        const helpButton = document.createElement('button');
        helpButton.type = 'button';
        helpButton.className = 'csv-preview-pattern-help';
        helpButton.textContent = '?';
        helpButton.title = i18n.t('csvPreviewPatternHelpTooltip');
        helpButton.setAttribute('aria-label', i18n.t('csvPreviewPatternHelpTitle'));
        helpButton.addEventListener('click', event => {
            event.preventDefault();
            this._showPatternHelp();
        });
        wrap.append(select, helpButton);
        return this._field(labelText, wrap);
    }

    _dateOrderField(labelText, select) {
        const wrap = document.createElement('div');
        wrap.className = 'csv-preview-date-order-control';
        const helpButton = document.createElement('button');
        helpButton.type = 'button';
        helpButton.className = 'csv-preview-date-order-help';
        helpButton.textContent = '?';
        helpButton.title = i18n.t('csvPreviewDateOrderHelpTooltip');
        helpButton.setAttribute('aria-label', i18n.t('csvPreviewDateOrderHelpTitle'));
        helpButton.setAttribute('aria-haspopup', 'dialog');
        helpButton.setAttribute('aria-expanded', 'false');

        const popover = document.createElement('div');
        popover.className = 'csv-preview-date-order-popover';
        popover.role = 'dialog';
        popover.hidden = true;

        const title = document.createElement('div');
        title.className = 'csv-preview-date-order-title';
        title.textContent = i18n.t('csvPreviewDateOrderHelpTitle');
        popover.appendChild(title);

        for (const [label, key] of [
            ['YMD', 'csvPreviewDateOrderYmdHelp'],
            ['DMY', 'csvPreviewDateOrderDmyHelp'],
            ['MDY', 'csvPreviewDateOrderMdyHelp'],
        ]) {
            const row = document.createElement('div');
            row.className = 'csv-preview-date-order-row';
            const code = document.createElement('code');
            code.textContent = label;
            const text = document.createElement('span');
            text.textContent = i18n.t(key);
            row.append(code, text);
            popover.appendChild(row);
        }

        helpButton.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            const willShow = popover.hidden;
            popover.hidden = !willShow;
            helpButton.classList.toggle('active', willShow);
            helpButton.setAttribute('aria-expanded', String(willShow));
        });
        wrap.append(select, helpButton, popover);
        return this._field(labelText, wrap);
    }

    _modeField(labelText, select) {
        const wrap = document.createElement('div');
        wrap.className = 'csv-preview-mode-control';
        const helpButton = document.createElement('button');
        helpButton.type = 'button';
        helpButton.className = 'csv-preview-mode-help';
        helpButton.textContent = '?';
        helpButton.title = i18n.t('csvPreviewModeHelpTooltip');
        helpButton.setAttribute('aria-label', i18n.t('csvPreviewModeHelpTitle'));
        helpButton.addEventListener('click', event => {
            event.preventDefault();
            this._showModeHelp();
        });
        wrap.append(select, helpButton);
        return this._field(labelText, wrap);
    }

    _showPatternHelp() {
        return Modal.alert(
            i18n.t('csvPreviewPatternHelpTitle'),
            i18n.t('csvPreviewPatternHelpBody'),
            {
                icon: false,
                html: true,
                className: 'modal-dialog-csv-pattern-help',
            }
        );
    }

    _showModeHelp() {
        return Modal.alert(
            i18n.t('csvPreviewModeHelpTitle'),
            i18n.t('csvPreviewModeHelpBody'),
            {
                icon: false,
                html: true,
                className: 'modal-dialog-csv-pattern-help',
            }
        );
    }

    _select(options, selected) {
        const select = document.createElement('select');
        for (const option of options) {
            const el = document.createElement('option');
            el.value = option.value;
            el.textContent = option.label;
            el.selected = String(option.value) === String(selected);
            el.disabled = !!option.disabled;
            if (option.title) el.title = option.title;
            select.appendChild(el);
        }
        return select;
    }

    _lineLimitOptions() {
        return [
            ...LINE_LIMITS.map(value => ({ value, label: String(value) })),
            { value: CUSTOM_LINE_LIMIT_VALUE, label: i18n.t('csvPreviewLinesCustom') },
        ];
    }

    _selectedLineLimitValue() {
        return LINE_LIMITS.includes(Number(this.state.lineLimit))
            ? Number(this.state.lineLimit)
            : CUSTOM_LINE_LIMIT_VALUE;
    }

    _syncCustomLineLimitControls() {
        if (!this.customLineLimitWrap || !this.lineLimitSelect) return;
        const isCustom = this.lineLimitSelect.value === CUSTOM_LINE_LIMIT_VALUE;
        this.customLineLimitWrap.hidden = !isCustom;
        if (isCustom && this.customLineLimitInput) {
            this.customLineLimitInput.value = String(this.state.lineLimit);
        }
    }

    async _applyCustomLineLimit() {
        if (!this.customLineLimitInput) return;
        const parsed = Math.trunc(Number(this.customLineLimitInput.value));
        const nextLineLimit = Math.max(1, Math.min(MAX_PREVIEW_LINES, Number.isFinite(parsed) ? parsed : this.state.lineLimit));
        this.state.lineLimit = nextLineLimit;
        this.customLineLimitInput.value = String(nextLineLimit);
        this.customLineLimitInput.disabled = true;
        if (this.customLineLimitButton) this.customLineLimitButton.disabled = true;
        try {
            await this._ensurePreviewSampleForLineLimit(nextLineLimit);
            this._refreshPreview({ preserveStructure: true });
        } finally {
            this.customLineLimitInput.disabled = false;
            if (this.customLineLimitButton) this.customLineLimitButton.disabled = false;
        }
    }

    _updateDecimalSeparatorSelect() {
        if (!this.decimalSelect) return;
        this.decimalSelect.replaceChildren();
        for (const option of decimalSeparatorOptions(this.state.delimiter)) {
            const el = document.createElement('option');
            el.value = option.value;
            el.textContent = option.label;
            el.selected = String(option.value) === String(this.state.decimalSeparator);
            el.disabled = !!option.disabled;
            if (option.title) el.title = option.title;
            this.decimalSelect.appendChild(el);
        }
        this.decimalSelect.value = this.state.decimalSeparator;
        this.decimalSelect.title = this.state.delimiter === ','
            ? i18n.t('csvPreviewDecimalCommaUnavailableTooltip')
            : i18n.t('csvPreviewDecimalSeparator');
    }

    _blankDisabledSelect() {
        const select = this._select([{ value: '', label: '' }], '');
        select.disabled = true;
        select.classList.add('is-empty-disabled');
        return select;
    }

    _sampleRegionOptions() {
        return this.sampleSegments.map(segment => ({
            value: segment.id,
            label: i18n.t(SAMPLE_REGION_KEYS[segment.id] || 'csvPreviewSampleStart'),
        }));
    }

    _selectedSegment() {
        return this.sampleSegments.find(segment => segment.id === this.state.sampleRegion) || this.sampleSegments[0] || null;
    }

    _replaceSelectedSegment(nextSegment) {
        if (!nextSegment?.buffer) return;
        const id = nextSegment.id || this.state.sampleRegion || 'start';
        const index = this.sampleSegments.findIndex(segment => segment.id === id);
        const normalized = { ...nextSegment, id };
        if (index >= 0) this.sampleSegments[index] = normalized;
        else this.sampleSegments.push(normalized);
        this.state.sampleRegion = id;
    }

    _isStartSample() {
        const segment = this._selectedSegment();
        return !segment || segment.id === 'start' || Number(segment.offset || 0) === 0;
    }

    _numberInput(value, onChange) {
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '1';
        input.step = '1';
        input.value = value;
        input.addEventListener('change', () => onChange(input.value));
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') input.blur();
        });
        return input;
    }

    _setTimeFormat(nextFormat, options = {}) {
        const previousFormat = this.state.timeFormat;
        this.state.timeFormat = nextFormat;
        if (previousFormat !== 'custom' && nextFormat === 'custom') {
            const detectedPattern = customPatternFromTimeSource(this.resultProfile?.timeSource);
            if (detectedPattern) this.state.customDatetimePattern = detectedPattern;
        }
        if (options.render !== false) this._rebuildAndRender();
    }

    _applySidePanelWidth() {
        if (!this.body) return;
        this.body.style.setProperty('--csv-preview-side-width', `${this.sidePanelWidth}px`);
        if (this.sideResizer) this.sideResizer.setAttribute('aria-valuenow', String(this.sidePanelWidth));
    }

    _clampSidePanelWidth(width) {
        const bodyWidth = this.body?.getBoundingClientRect?.().width || 0;
        const maxByBody = bodyWidth > 0 ? Math.max(MIN_SIDE_PANEL_WIDTH, bodyWidth - MIN_GRID_WIDTH) : MAX_SIDE_PANEL_WIDTH;
        const maxWidth = Math.min(MAX_SIDE_PANEL_WIDTH, maxByBody);
        return Math.max(MIN_SIDE_PANEL_WIDTH, Math.min(maxWidth, Math.round(width)));
    }

    _installSidePanelResize() {
        if (!this.sideResizer || this.sideResizer.dataset.resizeInstalled) return;
        this.sideResizer.dataset.resizeInstalled = '1';

        const setWidthFromClientX = (clientX) => {
            const rect = this.body?.getBoundingClientRect?.();
            if (!rect) return;
            this.sidePanelWidth = this._clampSidePanelWidth(rect.right - clientX);
            this._applySidePanelWidth();
        };

        this.sideResizer.addEventListener('pointerdown', event => {
            if (event.button !== 0) return;
            event.preventDefault();
            this.sideResizer.classList.add('is-active');
            const onMove = moveEvent => setWidthFromClientX(moveEvent.clientX);
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                this.sideResizer?.classList.remove('is-active');
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp, { once: true });
        });

        this.sideResizer.addEventListener('keydown', event => {
            const step = event.shiftKey ? 40 : 16;
            if (event.key === 'ArrowLeft') {
                this.sidePanelWidth = this._clampSidePanelWidth(this.sidePanelWidth + step);
                this._applySidePanelWidth();
                event.preventDefault();
            } else if (event.key === 'ArrowRight') {
                this.sidePanelWidth = this._clampSidePanelWidth(this.sidePanelWidth - step);
                this._applySidePanelWidth();
                event.preventDefault();
            }
        });
    }

    _allPreviewRowEntries() {
        let parsedDataIndex = 0;
        const entries = (this.preview?.rows || []).map((row, sourceIndex) => {
            const isEmpty = isEmptyPreviewRow(row);
            const entry = { row, sourceIndex, logicalIndex: sourceIndex, isEmpty };
            this._annotatePreviewRowEntry(entry, parsedDataIndex);
            if (entry.isDataRow && !entry.isInvalid) parsedDataIndex++;
            return entry;
        });
        return entries;
    }

    _previewRowEntries() {
        return this._allPreviewRowEntries().filter(entry => {
            if (this.state.hideEmptyLines && entry.isEmpty) return false;
            if (this.state.hidePreambleRows && entry.isPreamble) return false;
            if (this.state.hideInvalidLines && entry.isInvalid) return false;
            return true;
        });
    }

    _annotatePreviewRowEntry(entry, parsedDataIndex = 0) {
        const isStartSample = this._isStartSample();
        const dataStart = isStartSample ? this.state.dataStartIndex : 0;
        const expectedColumns = this.resultProfile?.rawHeaders?.length || 0;
        const delimiter = this.resultProfile?.delimiter || this.state.delimiter || ',';
        const decimalSeparator = this.resultProfile?.decimalSeparator || this.state.decimalSeparator || 'auto';
        const rowFilter = normalizeCsvRowFilter(this.resultProfile?.rowFilter);
        const structureStart = this.state.hasHeader
            ? Math.max(0, Number(this.state.headerIndex) || 0)
            : dataStart;
        entry.isPreamble = isStartSample && !entry.isEmpty && entry.logicalIndex < structureStart;
        entry.isDataRow = !entry.isEmpty && entry.logicalIndex >= dataStart;
        entry.rowPassesFilter = !entry.isDataRow || csvRowMatchesFilter(entry.row, rowFilter, { delimiter, decimalSeparator });
        entry.hasValidWidth = !entry.isDataRow || !expectedColumns || entry.row.length === expectedColumns;
        entry.hasValidTime = true;
        if (entry.isDataRow && entry.rowPassesFilter && entry.hasValidWidth && this.resultProfile?.timeSource) {
            const parsed = parseCsvTimeValue(this.resultProfile.timeSource, entry.row, parsedDataIndex, delimiter, { decimalSeparator });
            entry.hasValidTime = Number.isFinite(parsed);
        }
        const timeIndexes = new Set(this.resultProfile?.timeSource?.sourceIndexes || []);
        const numericIndexes = (this.resultProfile?.numericColumnIndexes || []).filter(index => !timeIndexes.has(index));
        entry.hasInvalidNumericCell = entry.isDataRow
            && entry.rowPassesFilter
            && entry.hasValidWidth
            && entry.hasValidTime
            && rowHasInvalidNumericCell(entry.row, numericIndexes, delimiter, decimalSeparator);
        entry.isInvalid = entry.isDataRow && (!entry.rowPassesFilter || !entry.hasValidWidth || !entry.hasValidTime);
    }

    _nonEmptyPreviewRows() {
        return this._allPreviewRowEntries()
            .filter(entry => !entry.isEmpty)
            .map(entry => entry.row);
    }

    _rowForLogicalIndex(index) {
        if (!Number.isFinite(index)) return null;
        return this._allPreviewRowEntries()
            .find(entry => entry.logicalIndex === index)
            ?.row || null;
    }

    _detectedUnitRowIndex(profile = {}) {
        const hasHeader = profile.hasHeader !== false;
        const headerIndex = Math.max(0, Number(profile.headerIndex) || 0);
        const dataStartIndex = Math.max(0, Number(profile.dataStartIndex) || (hasHeader ? headerIndex + 1 : headerIndex));
        if (!hasHeader || dataStartIndex <= headerIndex + 1) return null;

        const candidateIndex = dataStartIndex - 1;
        const row = this._rowForLogicalIndex(candidateIndex);
        const width = (profile.rawHeaders || []).length || row?.length || 0;
        if (!row || row.length !== width || width < 2) return null;

        const delimiter = profile.delimiter || this.state.delimiter || ',';
        if (typeof this.parser?._isUnitLikeRow === 'function' && this.parser._isUnitLikeRow(row, delimiter)) {
            return candidateIndex;
        }

        const cells = row.map(cell => String(cell ?? '').trim()).filter(Boolean);
        if (cells.length < 2) return null;
        const numeric = cells.filter(cell => Number.isFinite(parseCsvNumber(cell, delimiter))).length;
        const compactText = cells.filter(cell => /^[a-zA-Z%\u00b0\u00b5\/\-\d.]+$/.test(cell)).length;
        return numeric === 0 && compactText / cells.length >= 0.7 ? candidateIndex : null;
    }

    _applyDetectedProfileToState(profile = {}, options = {}) {
        this.state.hasHeader = profile.hasHeader !== false;
        this.state.headerIndex = Math.max(0, Number(profile.headerIndex) || 0);
        this.state.dataStartIndex = Math.max(0, Number(profile.dataStartIndex) || (this.state.hasHeader ? this.state.headerIndex + 1 : this.state.headerIndex));

        const detectedUnitRowIndex = Number.isFinite(Number(profile.unitRowIndex))
            ? Number(profile.unitRowIndex)
            : this._detectedUnitRowIndex(profile);
        if (options.resetUnits || !this.resultProfile) {
            this.state.unitsMode = profile.unitsMode || (detectedUnitRowIndex !== null ? 'row' : 'none');
            this.state.unitRowIndex = detectedUnitRowIndex;
            this.state.inlineUnitFormat = profile.inlineUnitFormat || 'auto';
        }

        const source = profile.timeSource || {};
        this.state.timeMode = source.kind === 'index'
            ? (source.strategy === 'index-column' ? 'index-column' : 'index')
            : source.mode === 'parts' ? 'parts'
                : source.mode === 'split' ? 'split' : 'single';
        this.state.timeColumn = source.sourceIndexes?.[0] ?? this.state.timeColumn ?? 0;
        this.state.timeDateColumn = source.sourceIndexes?.[0] ?? this.state.timeDateColumn ?? 0;
        this.state.timeTimeColumn = source.sourceIndexes?.[1] ?? this.state.timeTimeColumn ?? 1;
        this.state.timeFormat = source.strategy === 'custom-format' ? 'custom' : 'auto';
        this.state.customDatetimePattern = source.format?.pattern || 'yyyy/MM/dd HH:mm:ss';
        this.state.dateOrder = source.format?.dateOrder || this.state.dateOrder || 'YMD';
        this.state.timeParts = {
            year: source.format?.parts?.year ?? 0,
            month: source.format?.parts?.month ?? 1,
            day: source.format?.parts?.day ?? 2,
            hour: source.format?.parts?.hour ?? null,
            minute: source.format?.parts?.minute ?? null,
            second: source.format?.parts?.second ?? null,
        };

        if (options.resetColumns) {
            this.state.ignoredColumns = [];
            this.state.columnOverrides = {};
            this.state.showColumnTools = false;
        }
        if (options.resetColumns) {
            this.state.rowFilter = { enabled: false, columnIndex: 0, operator: '==', value: '' };
        }
    }

    _refreshPreview(options = {}) {
        const selectedSegment = this._selectedSegment();
        const buffer = selectedSegment?.buffer;
        const previewOptions = {
            maxRows: this.state.lineLimit,
            encoding: options.detectEncoding ? 'auto' : this.state.encoding,
        };
        if (!options.detectDelimiter) previewOptions.delimiter = this.state.delimiter;
        const preview = this.parser.inspectPreview(buffer, previewOptions);
        this.preview = preview;
        const shouldApplyDetected = !options.preserveStructure
            && (options.redetectStructure || !this.resultProfile);
        if (shouldApplyDetected) {
            const profile = options.redetectStructure
                ? (preview.profile || {})
                : (this.autoProfile || preview.profile || {});
            this.state.delimiter = profile.delimiter || preview.delimiter || this.state.delimiter;
            if (options.detectEncoding) this.state.encoding = profile.encoding || preview.encoding || 'auto';
            if (options.resetDecimal) this.state.decimalSeparator = profile.decimalSeparator || 'auto';
            this._applyDetectedProfileToState(profile, options);
        }
        if (this.state.delimiter === ',' && this.state.decimalSeparator === ',') this.state.decimalSeparator = 'auto';
        this._updateDecimalSeparatorSelect();
        this._rebuildProfile();
        this._renderControls();
        this._renderGrid();
        this._renderValidation();
    }

    async _ensurePreviewSampleForLineLimit(lineLimit) {
        const selectedSegment = this._selectedSegment();
        if (!this.loadPreviewSegment || !selectedSegment) return;
        const currentRows = this.preview?.rows?.length || 0;
        if (currentRows >= lineLimit) return;
        const currentBytes = Number(selectedSegment.bytes || selectedSegment.buffer?.byteLength || DEFAULT_SAMPLE_BYTES);
        const totalSize = Number(selectedSegment.totalSize || 0);
        if (totalSize > 0 && currentBytes >= totalSize) return;
        const ratio = Math.max(1.5, (lineLimit / Math.max(1, currentRows)) * 1.25);
        let requestedBytes = Math.max(currentBytes + DEFAULT_SAMPLE_BYTES, Math.ceil(currentBytes * Math.min(ratio, 8)));
        if (totalSize > 0) requestedBytes = Math.min(totalSize, requestedBytes);
        const refreshed = await this.loadPreviewSegment(selectedSegment.id, requestedBytes);
        if (refreshed?.buffer) this._replaceSelectedSegment(refreshed);
    }

    _rebuildProfile() {
        const previewEntries = this._allPreviewRowEntries();
        const rows = previewEntries
            .filter(entry => !entry.isEmpty)
            .map(entry => entry.row);
        const warnings = [];
        const isStartSample = this._isStartSample();
        const messages = isStartSample ? [...(this.preview?.warnings || [])] : [];
        if (!isStartSample && this.preview?.warnings?.length) {
            warnings.push(...this.preview.warnings);
        }
        if (this.sampleSegments.length > 1) {
            warnings.push(i18n.t('csvPreviewSampleLimitedWarning'));
        }
        if (!isStartSample) {
            warnings.push(i18n.t('csvPreviewSamplePartialWarning'));
        }
        const delimiter = this.state.delimiter;
        if (delimiter === ',' && this.state.decimalSeparator === ',') this.state.decimalSeparator = 'auto';
        const decimalSeparator = this.state.decimalSeparator || 'auto';
        if (this.headerlessProfileLocked) this.state.hasHeader = false;
        const hasHeader = !!this.state.hasHeader;
        const headerIndex = Math.max(0, this.state.headerIndex);
        const dataStartIndex = Math.max(0, this.state.dataStartIndex);
        const unitsMode = this.state.unitsMode;
        const unitRowIndex = unitsMode === 'row' && Number.isFinite(this.state.unitRowIndex) ? Math.max(0, this.state.unitRowIndex) : null;
        const previousProfile = this.lastStartProfile || this.resultProfile || this.autoProfile || {};
        const previousHeaders = previousProfile?.rawHeaders || [];
        const sourceHeaderRow = isStartSample
            ? (hasHeader ? this._rowForLogicalIndex(headerIndex) : this._rowForLogicalIndex(dataStartIndex))
            : previousHeaders;
        let rawHeaders = hasHeader
            ? (sourceHeaderRow || []).map(cell => String(cell ?? '').trim())
            : (sourceHeaderRow || []).map((_cell, index) => `column_${index + 1}`);
        if (!isStartSample && previousHeaders.length) rawHeaders = previousHeaders.map(cell => String(cell ?? '').trim());
        rawHeaders = rawHeaders.filter((_cell, index) => index < (sourceHeaderRow?.length || 0));
        if (rawHeaders.length < 2) messages.push('Header/data row must expose at least two columns.');

        let headers = !isStartSample && Array.isArray(previousProfile?.headers) && previousProfile.headers.length === rawHeaders.length
            ? cloneProfile(previousProfile.headers)
            : (this.state.unitsMode === 'inline'
                ? makeUniqueInlineHeaders(rawHeaders, this.state.inlineUnitFormat)
                : this.parser._makeUniqueHeaders(rawHeaders));
        if (unitRowIndex !== null) {
            const unitRow = isStartSample ? (this._rowForLogicalIndex(unitRowIndex) || []) : [];
            headers = headers.map((header, index) => {
                const unit = String(unitRow[index] ?? '').trim();
                return unit ? { ...header, description: `[${unit}]` } : header;
            });
        }
        const baseHeaders = cloneProfile(headers);
        headers = headers.map((header, index) => {
            const override = this.state.columnOverrides?.[index];
            if (!override || typeof override !== 'object') return header;
            return {
                ...header,
                name: String(override.name || header.name || `column_${index + 1}`).trim() || header.name,
                description: override.description !== undefined
                    ? String(override.description || '')
                    : header.description,
            };
        });

        if (hasHeader && dataStartIndex <= headerIndex) messages.push('First data row must be after the header row.');
        if (unitRowIndex !== null && (unitRowIndex === headerIndex || unitRowIndex >= dataStartIndex)) {
            messages.push('Units row cannot overlap the header row or data rows.');
        }

        const expectedColumns = rawHeaders.length;
        const candidateRows = (isStartSample
            ? previewEntries
                .filter(entry => !entry.isEmpty && entry.logicalIndex >= dataStartIndex)
                .map(entry => entry.row)
            : rows)
            .filter(row => row.some(cell => String(cell ?? '').trim() !== ''));
        const widthRows = candidateRows.filter(row => row.length === expectedColumns);
        const discardedRows = candidateRows.length - widthRows.length;
        if (discardedRows > 0) {
            const message = `${discardedRows} visible data row(s) have a different column count.`;
            if (isStartSample) messages.push(message);
            else warnings.push(message);
        }
        const normalizedFilter = normalizeCsvRowFilter({
            ...(this.state.rowFilter || {}),
            columnIndex: Math.max(0, Math.min(Math.max(0, expectedColumns - 1), Number(this.state.rowFilter?.columnIndex) || 0)),
        });
        this.state.rowFilter = normalizedFilter
            ? normalizedFilter
            : {
                enabled: !!this.state.rowFilter?.enabled,
                columnIndex: Math.max(0, Math.min(Math.max(0, expectedColumns - 1), Number(this.state.rowFilter?.columnIndex) || 0)),
                operator: ['!=', 'is_numeric'].includes(this.state.rowFilter?.operator) ? this.state.rowFilter.operator : '==',
                value: String(this.state.rowFilter?.value ?? ''),
            };
        const sampleRows = normalizedFilter
            ? widthRows.filter(row => csvRowMatchesFilter(row, normalizedFilter, { delimiter, decimalSeparator }))
            : widthRows;
        const filteredRows = widthRows.length - sampleRows.length;
        if (normalizedFilter && filteredRows > 0) {
            warnings.push(i18n.t('csvPreviewFilteredRows')
                .replace('{filtered}', String(filteredRows))
                .replace('{total}', String(widthRows.length)));
        }
        if (!sampleRows.length) messages.push('No visible data rows match the header width.');

        let timeSource;
        if (this.state.timeMode === 'index') {
            timeSource = makeIndexTimeSource();
        } else if (this.state.timeMode === 'index-column') {
            const maxColumn = Math.max(0, expectedColumns - 1);
            const columnIndex = Math.max(0, Math.min(maxColumn, Number(this.state.timeColumn) || 0));
            this.state.timeColumn = columnIndex;
            timeSource = buildIndexColumnTimeSource(this.parser, rawHeaders, sampleRows, delimiter, columnIndex, decimalSeparator);
            if (!timeSource.ok) messages.push(timeSource.reason || 'Selected index column is not valid.');
        } else if (this.state.timeMode === 'split') {
            const maxColumn = Math.max(0, expectedColumns - 1);
            const dateColumnIndex = Math.max(0, Math.min(maxColumn, Number(this.state.timeDateColumn) || 0));
            const timeColumnIndex = Math.max(0, Math.min(maxColumn, Number(this.state.timeTimeColumn) || 0));
            this.state.timeDateColumn = dateColumnIndex;
            this.state.timeTimeColumn = timeColumnIndex;
            if (dateColumnIndex === timeColumnIndex) {
                timeSource = { ok: false, reason: 'Date and time columns must be different.' };
            } else {
                timeSource = buildSplitTimeSource(this.parser, rawHeaders, sampleRows, delimiter, dateColumnIndex, timeColumnIndex, this.state.dateOrder);
            }
            if (!timeSource.ok) messages.push(timeSource.reason || 'Selected separate date and time columns are not valid.');
        } else if (this.state.timeMode === 'parts') {
            const maxColumn = Math.max(0, expectedColumns - 1);
            const normalizePart = value => {
                if (value === null || value === undefined || value === '') return null;
                const index = Number(value);
                return Number.isInteger(index) && index >= 0 ? Math.min(maxColumn, index) : null;
            };
            const parts = {
                year: normalizePart(this.state.timeParts.year),
                month: normalizePart(this.state.timeParts.month),
                day: normalizePart(this.state.timeParts.day),
                hour: normalizePart(this.state.timeParts.hour),
                minute: normalizePart(this.state.timeParts.minute),
                second: normalizePart(this.state.timeParts.second),
            };
            this.state.timeParts = parts;
            timeSource = buildPartsTimeSource(this.parser, rawHeaders, sampleRows, delimiter, parts, decimalSeparator);
            if (!timeSource.ok) messages.push(timeSource.reason || 'Selected date/time parts are not valid.');
        } else {
            const maxColumn = Math.max(0, expectedColumns - 1);
            const columnIndex = Math.max(0, Math.min(maxColumn, Number(this.state.timeColumn) || 0));
            this.state.timeColumn = columnIndex;
            timeSource = buildManualTimeSource(this.parser, rawHeaders, sampleRows, delimiter, columnIndex, this.state.dateOrder, {
                decimalSeparator,
                timeFormat: this.state.timeFormat,
                customPattern: this.state.customDatetimePattern,
            });
            if (!timeSource.ok) messages.push(timeSource.reason || 'Selected time column is not valid.');
        }
        timeSource = applyHeaderNamesToTimeSource(timeSource, headers);

        const timeIndexes = new Set(timeSource?.sourceIndexes || []);
        const ignoredColumns = (this.state.ignoredColumns || [])
            .map(index => Number(index))
            .filter(index => Number.isInteger(index) && index >= 0 && index < expectedColumns && !timeIndexes.has(index));
        this.state.ignoredColumns = ignoredColumns;

        const validTimeSampleRows = sampleRows.filter((row, index) =>
            Number.isFinite(parseCsvTimeValue(timeSource, row, index, delimiter, { decimalSeparator }))
        );
        const validTimeRows = validTimeSampleRows.length;
        const numericColumnIndexes = inferNumericColumnIndexes(validTimeSampleRows, expectedColumns, delimiter, decimalSeparator);
        if (sampleRows.length && validTimeRows === 0) messages.push('No visible data row produces a valid time value.');

        this.resultProfile = {
            ...(this.autoProfile || this.preview?.profile || {}),
            delimiter,
            encoding: this.state.encoding === 'auto'
                ? (this.preview?.encoding || this.autoProfile?.encoding || 'utf-8')
                : this.state.encoding,
            hasHeader,
            headerIndex,
            dataStartIndex,
            skippedRows: headerIndex,
            skippedRowsAfterHeader: Math.max(0, dataStartIndex - headerIndex - (hasHeader ? 1 : 0)),
            rawHeaders,
            headers,
            previewBaseHeaders: baseHeaders,
            timeSource,
            sampleRows: sampleRows.slice(0, 100),
            numericColumnIndexes,
            unitsMode,
            unitRowIndex,
            inlineUnitFormat: this.state.inlineUnitFormat,
            decimalSeparator,
            rowFilter: normalizedFilter,
            ignoredColumns,
            columnOverrides: cloneProfile(this.state.columnOverrides || {}),
            profileSource: 'user',
            previewDiscardedColumnCountRows: discardedRows,
            previewFilteredRows: filteredRows,
        };
        this.validation = {
            ok: messages.length === 0 && !!timeSource?.ok && sampleRows.length > 0 && validTimeRows > 0,
            messages,
            warnings,
            validTimeRows,
            totalDataRows: sampleRows.length,
        };
        if (isStartSample && this.validation.ok) {
            this.lastStartProfile = cloneProfile(this.resultProfile);
        }
    }

    _renderControls() {
        this.sidePanel.innerHTML = '';
        const tableTitle = document.createElement('div');
        tableTitle.className = 'csv-preview-side-title';
        tableTitle.textContent = i18n.t('csvPreviewTableStructure');

        const noHeader = document.createElement('label');
        noHeader.className = 'csv-preview-check';
        noHeader.classList.toggle('is-disabled', this.headerlessProfileLocked);
        noHeader.title = this.headerlessProfileLocked
            ? i18n.t('csvPreviewNoHeaderLockedTooltip')
            : i18n.t('csvPreviewNoHeader');
        const noHeaderInput = document.createElement('input');
        noHeaderInput.type = 'checkbox';
        noHeaderInput.checked = this.headerlessProfileLocked || !this.state.hasHeader;
        noHeaderInput.disabled = this.headerlessProfileLocked;
        noHeaderInput.title = noHeader.title;
        noHeaderInput.addEventListener('change', () => {
            if (this.headerlessProfileLocked) {
                noHeaderInput.checked = true;
                this.state.hasHeader = false;
                return;
            }
            this.state.hasHeader = !noHeaderInput.checked;
            this._rebuildAndRender();
        });
        noHeader.append(noHeaderInput, document.createTextNode(i18n.t('csvPreviewNoHeader')));

        const hideEmpty = document.createElement('label');
        hideEmpty.className = 'csv-preview-check';
        hideEmpty.title = i18n.t('csvPreviewHideEmptyLinesTooltip');
        const hideEmptyInput = document.createElement('input');
        hideEmptyInput.type = 'checkbox';
        hideEmptyInput.checked = !!this.state.hideEmptyLines;
        hideEmptyInput.title = i18n.t('csvPreviewHideEmptyLinesTooltip');
        hideEmptyInput.addEventListener('change', () => {
            this.state.hideEmptyLines = hideEmptyInput.checked;
            this._renderGrid();
        });
        hideEmpty.append(hideEmptyInput, document.createTextNode(i18n.t('csvPreviewHideEmptyLines')));

        const hidePreamble = document.createElement('label');
        hidePreamble.className = 'csv-preview-check';
        hidePreamble.title = i18n.t('csvPreviewHidePreambleRowsTooltip');
        const hidePreambleInput = document.createElement('input');
        hidePreambleInput.type = 'checkbox';
        hidePreambleInput.checked = !!this.state.hidePreambleRows;
        hidePreambleInput.title = i18n.t('csvPreviewHidePreambleRowsTooltip');
        hidePreambleInput.addEventListener('change', () => {
            this.state.hidePreambleRows = hidePreambleInput.checked;
            this._renderGrid();
        });
        hidePreamble.append(hidePreambleInput, document.createTextNode(i18n.t('csvPreviewHidePreambleRows')));

        const hideInvalid = document.createElement('label');
        hideInvalid.className = 'csv-preview-check';
        hideInvalid.title = i18n.t('csvPreviewHideInvalidLinesTooltip');
        const hideInvalidInput = document.createElement('input');
        hideInvalidInput.type = 'checkbox';
        hideInvalidInput.checked = !!this.state.hideInvalidLines;
        hideInvalidInput.title = i18n.t('csvPreviewHideInvalidLinesTooltip');
        hideInvalidInput.addEventListener('change', () => {
            this.state.hideInvalidLines = hideInvalidInput.checked;
            this._renderGrid();
        });
        hideInvalid.append(hideInvalidInput, document.createTextNode(i18n.t('csvPreviewHideInvalidLines')));

        const headerInput = this._numberInput(toRowNumber(this.state.headerIndex), value => {
            this.state.headerIndex = fromRowNumber(value, this.state.headerIndex);
            this._rebuildAndRender();
        });
        headerInput.disabled = !this.state.hasHeader;

        const unitsSelect = this._select([
            { value: 'none', label: i18n.t('csvPreviewUnitsNone') },
            { value: 'row', label: i18n.t('csvPreviewUnitsRow') },
            { value: 'inline', label: i18n.t('csvPreviewUnitsInline') },
        ], this.state.unitsMode);
        unitsSelect.addEventListener('change', () => {
            this.state.unitsMode = unitsSelect.value;
            if (this.state.unitsMode === 'row' && this.state.unitRowIndex === null) {
                this.state.unitRowIndex = Math.max(0, this.state.dataStartIndex - 1);
            }
            this._rebuildAndRender();
        });

        const unitsInput = this._numberInput(toRowNumber(this.state.unitRowIndex ?? Math.max(0, this.state.dataStartIndex - 1)), value => {
            this.state.unitRowIndex = fromRowNumber(value, this.state.unitRowIndex ?? 0);
            this._rebuildAndRender();
        });
        unitsInput.disabled = this.state.unitsMode !== 'row';

        const inlineFormat = this._select(INLINE_UNIT_FORMATS, this.state.inlineUnitFormat);
        inlineFormat.disabled = this.state.unitsMode !== 'inline';
        inlineFormat.addEventListener('change', () => {
            this.state.inlineUnitFormat = inlineFormat.value;
            this._rebuildAndRender();
        });

        const dataInput = this._numberInput(toRowNumber(this.state.dataStartIndex), value => {
            this.state.dataStartIndex = fromRowNumber(value, this.state.dataStartIndex);
            this._rebuildAndRender();
        });

        const timeTitle = document.createElement('div');
        timeTitle.className = 'csv-preview-side-title';
        timeTitle.textContent = i18n.t('csvPreviewTimeAxis');

        const timeMode = this._select([
            { value: 'single', label: i18n.t('csvPreviewTimeSingle') },
            { value: 'split', label: i18n.t('csvPreviewTimeSplit') },
            { value: 'parts', label: i18n.t('csvPreviewTimeParts') },
            { value: 'index-column', label: i18n.t('csvPreviewTimeIndexColumn') },
            { value: 'index', label: i18n.t('csvPreviewTimeIndex') },
        ], this.state.timeMode);
        timeMode.addEventListener('change', () => {
            this.state.timeMode = timeMode.value;
            this._rebuildAndRender();
        });

        const timeFormat = this._select(TIME_FORMATS, this.state.timeFormat);
        timeFormat.addEventListener('change', () => {
            this._setTimeFormat(timeFormat.value);
        });

        const customPattern = document.createElement('input');
        customPattern.type = 'text';
        const patternApplies = this.state.timeMode === 'single' && this.state.timeFormat === 'custom';
        customPattern.value = this.state.customDatetimePattern || '';
        customPattern.placeholder = 'yyyy/MM/dd HH:mm:ss';
        customPattern.addEventListener('change', () => {
            this.state.customDatetimePattern = customPattern.value;
            this._rebuildAndRender();
        });
        customPattern.addEventListener('keydown', event => {
            if (event.key === 'Enter') customPattern.blur();
        });
        const autoFormatNote = document.createElement('div');
        autoFormatNote.className = 'csv-preview-side-note';
        autoFormatNote.textContent = autoDetectedFormatText(this.resultProfile?.timeSource);
        autoFormatNote.title = autoFormatNote.textContent;

        const columns = (this.resultProfile?.rawHeaders || []).map((header, index) => ({
            value: index,
            label: `${columnLabel(index)} - ${header || `column_${index + 1}`}`,
        }));
        const timeColumn = this._select(columns.length ? columns : [{ value: 0, label: 'A - column_1' }], this.state.timeColumn);
        timeColumn.addEventListener('change', () => {
            this.state.timeColumn = Number(timeColumn.value) || 0;
            this._rebuildAndRender();
        });

        const dateColumn = this._select(columns.length ? columns : [{ value: 0, label: 'A - column_1' }], this.state.timeDateColumn);
        dateColumn.addEventListener('change', () => {
            this.state.timeDateColumn = Number(dateColumn.value) || 0;
            this._rebuildAndRender();
        });

        const clockColumn = this._select(columns.length ? columns : [{ value: 1, label: 'B - column_2' }], this.state.timeTimeColumn);
        clockColumn.addEventListener('change', () => {
            this.state.timeTimeColumn = Number(clockColumn.value) || 0;
            this._rebuildAndRender();
        });

        const partOptions = [{ value: '', label: i18n.t('csvPreviewNone') }, ...columns];
        const makePartSelect = (part) => {
            const select = this._select(partOptions, this.state.timeParts?.[part] ?? '');
            select.addEventListener('change', () => {
                this.state.timeParts = { ...(this.state.timeParts || {}), [part]: select.value === '' ? null : Number(select.value) };
                this._rebuildAndRender();
            });
            return select;
        };
        const yearColumn = makePartSelect('year');
        const monthColumn = makePartSelect('month');
        const dayColumn = makePartSelect('day');
        const hourColumn = makePartSelect('hour');
        const minuteColumn = makePartSelect('minute');
        const secondColumn = makePartSelect('second');

        const dateOrder = this._select([
            { value: 'YMD', label: 'YMD' },
            { value: 'DMY', label: 'DMY' },
            { value: 'MDY', label: 'MDY' },
        ], this.state.dateOrder);
        dateOrder.addEventListener('change', () => {
            this.state.dateOrder = dateOrder.value;
            this._rebuildAndRender();
        });

        const filterTitle = document.createElement('div');
        filterTitle.className = 'csv-preview-side-title';
        filterTitle.textContent = i18n.t('csvPreviewRowFilter');
        const filterEnabled = document.createElement('label');
        filterEnabled.className = 'csv-preview-check';
        filterEnabled.title = i18n.t('csvPreviewRowFilterTooltip');
        const filterEnabledInput = document.createElement('input');
        filterEnabledInput.type = 'checkbox';
        filterEnabledInput.checked = !!this.state.rowFilter?.enabled;
        filterEnabledInput.title = i18n.t('csvPreviewRowFilterTooltip');
        filterEnabledInput.addEventListener('change', () => {
            this.state.rowFilter = {
                ...(this.state.rowFilter || {}),
                enabled: filterEnabledInput.checked,
            };
            this._rebuildAndRender();
        });
        filterEnabled.append(filterEnabledInput, document.createTextNode(i18n.t('csvPreviewRowFilterEnable')));

        const filterColumn = this._select(columns.length ? columns : [{ value: 0, label: 'A - column_1' }], this.state.rowFilter?.columnIndex ?? 0);
        filterColumn.addEventListener('change', () => {
            this.state.rowFilter = {
                ...(this.state.rowFilter || {}),
                columnIndex: Number(filterColumn.value) || 0,
            };
            this._rebuildAndRender();
        });
        const filterOperator = this._select(rowFilterOperatorOptions(), this.state.rowFilter?.operator || '==');
        filterOperator.addEventListener('change', () => {
            this.state.rowFilter = {
                ...(this.state.rowFilter || {}),
                operator: ['!=', 'is_numeric'].includes(filterOperator.value) ? filterOperator.value : '==',
            };
            this._rebuildAndRender();
        });
        const filterValue = document.createElement('input');
        filterValue.type = 'text';
        filterValue.value = this.state.rowFilter?.value ?? '';
        filterValue.placeholder = 'GCAG';
        filterValue.title = i18n.t('csvPreviewRowFilterValue');
        filterValue.disabled = this.state.rowFilter?.operator === 'is_numeric';
        filterValue.addEventListener('change', () => {
            this.state.rowFilter = {
                ...(this.state.rowFilter || {}),
                value: filterValue.value,
            };
            this._rebuildAndRender();
        });
        filterValue.addEventListener('keydown', event => {
            if (event.key === 'Enter') filterValue.blur();
        });

        this.statusBox = document.createElement('div');
        this.statusBox.className = 'csv-preview-status';

        const columnTitle = document.createElement('div');
        columnTitle.className = 'csv-preview-side-title';
        columnTitle.textContent = i18n.t('csvPreviewColumns');
        const columnTools = document.createElement('label');
        columnTools.className = 'csv-preview-check';
        columnTools.title = i18n.t('csvPreviewColumnToolsTooltip');
        const columnToolsInput = document.createElement('input');
        columnToolsInput.type = 'checkbox';
        columnToolsInput.checked = !!this.state.showColumnTools;
        columnToolsInput.title = i18n.t('csvPreviewColumnToolsTooltip');
        columnToolsInput.addEventListener('change', () => {
            this.state.showColumnTools = columnToolsInput.checked;
            this._renderControls();
        });
        columnTools.append(columnToolsInput, document.createTextNode(i18n.t('csvPreviewColumnTools')));
        const columnNote = document.createElement('div');
        columnNote.className = 'csv-preview-side-note';
        columnNote.textContent = i18n.t('csvPreviewColumnsHelp');
        const columnResetRow = document.createElement('div');
        columnResetRow.className = 'csv-preview-column-actions';
        const columnReset = document.createElement('button');
        columnReset.type = 'button';
        columnReset.className = 'csv-preview-small-button';
        columnReset.textContent = i18n.t('csvPreviewColumnsReset');
        columnReset.title = i18n.t('csvPreviewColumnsResetTooltip');
        columnReset.addEventListener('click', () => this._resetColumnTools());
        columnResetRow.appendChild(columnReset);
        const columnList = this._renderColumnControls();

        const timeFields = [
            timeTitle,
            this._modeField(i18n.t('csvPreviewMode'), timeMode),
        ];
        if (this.state.timeMode === 'single') {
            timeFields.push(
                this._field(i18n.t('csvPreviewColumn'), timeColumn),
                patternApplies
                    ? this._field(i18n.t('csvPreviewTimeFormat'), timeFormat)
                    : this._formatField(i18n.t('csvPreviewTimeFormat'), timeFormat),
            );
            if (!patternApplies) timeFields.push(autoFormatNote);
            if (patternApplies) timeFields.push(this._patternField(i18n.t('csvPreviewPattern'), customPattern));
        } else if (this.state.timeMode === 'index-column') {
            timeFields.push(
                this._field(i18n.t('csvPreviewIndexColumn'), timeColumn),
            );
        } else if (this.state.timeMode === 'split') {
            timeFields.push(
                this._field(i18n.t('csvPreviewDateColumn'), dateColumn),
                this._dateOrderField(i18n.t('csvPreviewDateOrder'), dateOrder),
                this._field(i18n.t('csvPreviewTimeColumn'), clockColumn),
            );
        } else if (this.state.timeMode === 'parts') {
            timeFields.push(
                this._field(i18n.t('csvPreviewYearColumn'), yearColumn),
                this._field(i18n.t('csvPreviewMonthColumn'), monthColumn),
                this._field(i18n.t('csvPreviewDayColumn'), dayColumn),
                this._field(i18n.t('csvPreviewHourColumn'), hourColumn),
                this._field(i18n.t('csvPreviewMinuteColumn'), minuteColumn),
                this._field(i18n.t('csvPreviewSecondColumn'), secondColumn),
            );
        }

        const columnFields = [columnTitle, columnTools];
        if (this.state.showColumnTools) columnFields.push(columnNote, columnResetRow, columnList);
        const filterFields = [filterTitle, filterEnabled];
        if (this.state.rowFilter?.enabled) {
            filterFields.push(
                this._field(i18n.t('csvPreviewRowFilterColumn'), filterColumn),
                this._field(i18n.t('csvPreviewRowFilterOperator'), filterOperator),
                this._field(i18n.t('csvPreviewRowFilterValue'), filterValue),
            );
        }

        this.sidePanel.append(
            tableTitle,
            noHeader,
            hideEmpty,
            hidePreamble,
            hideInvalid,
            this._field(i18n.t('csvPreviewHeaderRow'), headerInput),
            this._field(i18n.t('csvPreviewUnitsSource'), unitsSelect),
            this._field(i18n.t('csvPreviewUnitsRowLabel'), unitsInput),
            this._field(i18n.t('csvPreviewInlineUnitFormat'), inlineFormat),
            this._field(i18n.t('csvPreviewFirstDataRow'), dataInput),
            ...filterFields,
            ...timeFields,
            ...columnFields,
            this.statusBox,
        );
    }

    _renderColumnControls() {
        const wrap = document.createElement('div');
        wrap.className = 'csv-preview-column-list';
        const headers = this.resultProfile?.headers || [];
        const rawHeaders = this.resultProfile?.rawHeaders || [];
        const timeIndexes = new Set(this.resultProfile?.timeSource?.sourceIndexes || []);
        const ignored = new Set(this.state.ignoredColumns || []);

        headers.forEach((header, index) => {
            const isProtected = timeIndexes.has(index);
            const row = document.createElement('div');
            row.className = 'csv-preview-column-control';
            row.classList.toggle('is-protected-column', isProtected);

            const useColumn = document.createElement('input');
            useColumn.type = 'checkbox';
            useColumn.checked = isProtected ? true : !ignored.has(index);
            useColumn.disabled = isProtected;
            useColumn.title = isProtected ? i18n.t('csvPreviewTimeColumnProtected') : i18n.t('csvPreviewUseColumn');
            useColumn.setAttribute('aria-label', i18n.t('csvPreviewUseColumn'));
            useColumn.addEventListener('change', () => {
                const next = new Set(this.state.ignoredColumns || []);
                if (useColumn.checked) next.delete(index);
                else next.add(index);
                this.state.ignoredColumns = [...next].sort((a, b) => a - b);
                this._rebuildAndRender();
            });

            const name = document.createElement('input');
            name.type = 'text';
            name.value = header.name || rawHeaders[index] || `column_${index + 1}`;
            name.placeholder = rawHeaders[index] || `column_${index + 1}`;
            name.addEventListener('change', () => {
                const value = String(name.value || '').trim();
                this.state.columnOverrides = { ...(this.state.columnOverrides || {}) };
                this.state.columnOverrides[index] = {
                    ...(this.state.columnOverrides[index] || {}),
                    name: value || header.name || `column_${index + 1}`,
                };
                this._rebuildAndRender();
            });
            name.addEventListener('keydown', event => {
                if (event.key === 'Enter') name.blur();
            });

            const raw = document.createElement('div');
            raw.className = 'csv-preview-column-raw';
            raw.textContent = `${columnLabel(index)} - ${rawHeaders[index] || ''}`;
            raw.title = rawHeaders[index] || '';

            row.append(useColumn, name, raw);
            wrap.appendChild(row);
        });
        return wrap;
    }

    _resetColumnTools(options = {}) {
        this.state.ignoredColumns = [];
        this.state.columnOverrides = {};
        if (options.render !== false) this._rebuildAndRender();
    }

    _rebuildAndRender() {
        this._rebuildProfile();
        this._renderControls();
        this._renderGrid();
        this._renderValidation();
    }

    _buildDetectedUnitsRow(maxColumns) {
        const tr = document.createElement('tr');
        tr.className = 'is-detected-units-row';

        const rowHead = document.createElement('th');
        rowHead.className = 'csv-preview-row-head';
        rowHead.textContent = i18n.t('csvPreviewDetectedUnits');
        rowHead.title = i18n.t('csvPreviewDetectedUnits');
        tr.appendChild(rowHead);

        const parsedCell = document.createElement('td');
        parsedCell.className = 'csv-preview-parsed-cell';
        parsedCell.textContent = parsedColumnFormatLabel(this.resultProfile?.timeSource);
        parsedCell.title = parsedCell.textContent;
        tr.appendChild(parsedCell);

        const headers = this.resultProfile?.headers || [];
        for (let c = 0; c < maxColumns; c++) {
            const td = document.createElement('td');
            td.textContent = unitTextFromDescription(headers[c]?.description);
            td.title = td.textContent;
            tr.appendChild(td);
        }
        return tr;
    }

    _hasRenamedColumns() {
        const headers = this.resultProfile?.headers || [];
        const baseHeaders = this.resultProfile?.previewBaseHeaders || [];
        const overrides = this.state.columnOverrides || {};
        return Object.keys(overrides).some(key => {
            const index = Number(key);
            const nextName = String(headers[index]?.name || '').trim();
            const baseName = String(baseHeaders[index]?.name || '').trim();
            return nextName && baseName && nextName !== baseName;
        });
    }

    _buildNewNamesRow(maxColumns) {
        const tr = document.createElement('tr');
        tr.className = 'is-new-names-row';

        const rowHead = document.createElement('th');
        rowHead.className = 'csv-preview-row-head';
        rowHead.textContent = i18n.t('csvPreviewNewNames');
        rowHead.title = i18n.t('csvPreviewNewNames');
        tr.appendChild(rowHead);

        const parsedCell = document.createElement('td');
        parsedCell.className = 'csv-preview-parsed-cell';
        parsedCell.textContent = this.resultProfile?.timeSource?.name || '';
        parsedCell.title = parsedCell.textContent;
        tr.appendChild(parsedCell);

        const headers = this.resultProfile?.headers || [];
        for (let c = 0; c < maxColumns; c++) {
            const td = document.createElement('td');
            td.textContent = headers[c]?.name || '';
            td.title = td.textContent;
            tr.appendChild(td);
        }
        return tr;
    }

    _renderGrid() {
        const rowEntries = this._previewRowEntries();
        const allEntries = this._allPreviewRowEntries();
        const isStartSample = this._isStartSample();
        const maxColumns = Math.max(1, ...(rowEntries.length ? rowEntries : allEntries).map(entry => entry.row.length));
        const table = document.createElement('table');
        table.className = 'csv-preview-grid';
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        const rowNumberHead = document.createElement('th');
        rowNumberHead.textContent = i18n.t('csvPreviewFileRowNumber');
        rowNumberHead.title = i18n.t('csvPreviewFileRowNumber');
        headRow.appendChild(rowNumberHead);
        const parsedHead = document.createElement('th');
        parsedHead.className = 'csv-preview-parsed-head';
        parsedHead.textContent = i18n.t('csvPreviewDateTimeParsed');
        parsedHead.title = `${i18n.t('csvPreviewDateTimeParsed')} (${PARSED_DATETIME_FORMAT_LABEL})`;
        headRow.appendChild(parsedHead);
        for (let c = 0; c < maxColumns; c++) {
            const th = document.createElement('th');
            th.textContent = columnLabel(c);
            headRow.appendChild(th);
        }
        thead.appendChild(headRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        const timeIndexes = new Set(this.resultProfile?.timeSource?.sourceIndexes || []);
        const delimiter = this.resultProfile?.delimiter || ',';
        const onlyPreambleMessage = this._onlyPreambleLoadedMessageInfo(allEntries, rowEntries);
        let renderedValidDataRows = 0;
        if (!rowEntries.length) {
            tbody.appendChild(this._buildGridMessageRow(this._hiddenRowsMessage(allEntries), maxColumns, 'is-hidden-message'));
        }
        rowEntries.forEach((entry, r) => {
            const { row, logicalIndex, isEmpty, sourceIndex, isDataRow, rowPassesFilter, isInvalid, hasInvalidNumericCell } = entry;
            const tr = document.createElement('tr');
            if (isEmpty) tr.classList.add('is-empty-row');
            if (isStartSample && !isEmpty && logicalIndex < this.state.dataStartIndex) tr.classList.add('is-skipped');
            if (isStartSample && !isEmpty && this.state.hasHeader && logicalIndex === this.state.headerIndex) tr.classList.add('is-header-row');
            if (isStartSample && !isEmpty && this.state.unitsMode === 'row' && logicalIndex === this.state.unitRowIndex) tr.classList.add('is-units-row');
            if (isDataRow) tr.classList.add('is-data-row');
            if (isDataRow && !rowPassesFilter) tr.classList.add('is-filtered-row');
            if (isInvalid) tr.classList.add('is-invalid-row');
            if (hasInvalidNumericCell) tr.classList.add('is-invalid-row');

            const rowHead = document.createElement('th');
            rowHead.className = 'csv-preview-row-head';
            rowHead.textContent = isStartSample ? String(sourceIndex + 1) : `~${r + 1}`;
            rowHead.title = rowHead.textContent;
            tr.appendChild(rowHead);

            const parsedCell = document.createElement('td');
            parsedCell.className = 'csv-preview-parsed-cell';
            const rowIndex = renderedValidDataRows;
            if (isDataRow && rowPassesFilter) {
                const parsed = parseCsvTimeValue(this.resultProfile.timeSource, row, rowIndex, delimiter, {
                    decimalSeparator: this.resultProfile.decimalSeparator || 'auto',
                });
                parsedCell.textContent = formatParsedTimeValue(this.resultProfile?.timeSource, parsed);
                parsedCell.title = parsedCell.textContent;
                if (!Number.isFinite(parsed)) parsedCell.classList.add('is-invalid-cell');
            }
            tr.appendChild(parsedCell);

            for (let c = 0; c < maxColumns; c++) {
                const td = document.createElement('td');
                td.textContent = row[c] ?? '';
                td.title = td.textContent;
                if (timeIndexes.has(c)) td.classList.add('is-time-column');
                if (hasInvalidNumericCell
                    && (this.resultProfile?.numericColumnIndexes || []).includes(c)
                    && !timeIndexes.has(c)
                    && String(row[c] ?? '').trim()
                    && !Number.isFinite(parseCsvNumber(row[c], delimiter, this.resultProfile.decimalSeparator || 'auto'))) {
                    td.classList.add('is-invalid-cell');
                    td.title = `${td.textContent} (${i18n.t('csvPreviewInvalidNumericCell')})`;
                }
                if (isDataRow && rowPassesFilter && timeIndexes.has(c)) {
                    const parsed = parseCsvTimeValue(this.resultProfile.timeSource, row, rowIndex, delimiter, {
                        decimalSeparator: this.resultProfile.decimalSeparator || 'auto',
                    });
                    if (!Number.isFinite(parsed)) td.classList.add('is-invalid-cell');
                }
                tr.appendChild(td);
            }
            if (isDataRow && !isInvalid) renderedValidDataRows++;
            tbody.appendChild(tr);
            if (onlyPreambleMessage && sourceIndex === onlyPreambleMessage.sourceIndex) {
                tbody.appendChild(this._buildGridMessageRow(onlyPreambleMessage.message, maxColumns, 'is-load-more-message'));
            }
            if (isStartSample && this.state.hasHeader && !isEmpty && logicalIndex === this.state.headerIndex) {
                tbody.appendChild(this._buildDetectedUnitsRow(maxColumns));
                if (this._hasRenamedColumns()) tbody.appendChild(this._buildNewNamesRow(maxColumns));
            }
        });
        table.appendChild(tbody);
        this.gridWrap.replaceChildren(table);
    }

    _buildGridMessageRow(message, maxColumns, variant = '') {
        const tr = document.createElement('tr');
        tr.className = 'csv-preview-message-row';
        if (variant) tr.classList.add(variant);
        const td = document.createElement('td');
        td.colSpan = maxColumns + 2;
        td.textContent = message;
        td.title = message;
        tr.appendChild(td);
        return tr;
    }

    _onlyPreambleLoadedMessageInfo(allEntries = [], rowEntries = []) {
        if (this.state.hidePreambleRows) return null;
        const visiblePreambleRows = rowEntries.filter(entry => entry.isPreamble);
        if (!visiblePreambleRows.length) return null;
        const hasLoadedNonPreambleContent = allEntries.some(entry => !entry.isEmpty && !entry.isPreamble);
        if (hasLoadedNonPreambleContent) return null;
        return {
            sourceIndex: visiblePreambleRows[visiblePreambleRows.length - 1].sourceIndex,
            message: i18n.t('csvPreviewOnlyPreambleLoaded'),
        };
    }

    _hiddenRowsMessage(allEntries = []) {
        const hasHiddenPreamble = this.state.hidePreambleRows && allEntries.some(entry => entry.isPreamble);
        const hasHiddenInvalid = this.state.hideInvalidLines && allEntries.some(entry => entry.isInvalid);
        const hasHiddenEmpty = this.state.hideEmptyLines && allEntries.some(entry => entry.isEmpty);
        if (hasHiddenPreamble) return i18n.t('csvPreviewAllRowsHiddenByPreamble');
        if (hasHiddenInvalid) return i18n.t('csvPreviewAllRowsHiddenByInvalid');
        if (hasHiddenEmpty) return i18n.t('csvPreviewAllRowsHiddenByEmpty');
        return i18n.t('csvPreviewNoPreviewRows');
    }

    _renderValidation() {
        const confidence = this.resultProfile?.timeSource?.confidence;
        this.confidence.textContent = Number.isFinite(confidence)
            ? `${i18n.t('csvPreviewConfidence')} ${Math.round(confidence * 100)}%`
            : '';
        this.applyButton.disabled = !this.validation.ok;
        this.statusBox.innerHTML = '';

        const summary = document.createElement('div');
        summary.className = this.validation.ok ? 'csv-preview-status-ok' : 'csv-preview-status-error';
        summary.textContent = this.validation.ok
            ? i18n.t('csvPreviewValidRows')
                .replace('{valid}', String(this.validation.validTimeRows))
                .replace('{total}', String(this.validation.totalDataRows))
            : i18n.t('csvPreviewCannotApply');
        this.statusBox.appendChild(summary);

        for (const message of this.validation.messages.slice(0, 6)) {
            const item = document.createElement('div');
            item.className = 'csv-preview-warning';
            item.textContent = message;
            this.statusBox.appendChild(item);
        }
        for (const message of (this.validation.warnings || []).slice(0, 4)) {
            const item = document.createElement('div');
            item.className = 'csv-preview-note';
            item.textContent = message;
            this.statusBox.appendChild(item);
        }
    }

    _finish(result) {
        document.removeEventListener('keydown', this.keyHandler);
        this.overlay.style.pointerEvents = 'none';
        this.overlay.classList.remove('show');
        setTimeout(() => {
            this.overlay.remove();
            if (this.previousActive && document.contains(this.previousActive)) {
                try { this.previousActive.focus({ preventScroll: true }); } catch (_) {}
            }
            this.resolve(result ? cloneProfile(result) : null);
        }, 220);
    }
}
