import i18n from '../i18n/index.js';
import { detectCsvTimeAxis, parseCsvNumber, parseCsvTimeValue } from '../parsers/csv-time-detection.js';

const LINE_LIMITS = [50, 100, 150, 200];
const LOAD_MORE_LINE_STEP = 100;
const MAX_PREVIEW_LINES = 1000;
const DEFAULT_SAMPLE_BYTES = 2 * 1024 * 1024;
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
const SAMPLE_REGION_KEYS = {
    start: 'csvPreviewSampleStart',
    middle: 'csvPreviewSampleMiddle',
    end: 'csvPreviewSampleEnd',
};

function cloneProfile(profile) {
    if (!profile) return null;
    return JSON.parse(JSON.stringify(profile, (_key, value) =>
        typeof value === 'function' ? undefined : value
    ));
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

function buildManualTimeSource(parser, rawHeaders, dataRows, delimiter, columnIndex, dateOrder, options = {}) {
    const decimalSeparator = options.decimalSeparator || 'auto';
    const customPattern = String(options.customPattern || '').trim();
    if (options.timeFormat === 'custom') {
        const name = headerName(parser, rawHeaders[columnIndex], columnIndex);
        if (!customPattern) return { ok: false, reason: 'Custom datetime pattern is empty.' };
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
        if (!dataRows.length || validRows / dataRows.length < 0.8) {
            return { ok: false, reason: 'Custom datetime pattern does not match the selected column.' };
        }
        source.confidence = validRows / dataRows.length;
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

    const slashRatio = values.filter(value => /^\d{1,4}\/\d{1,2}\/\d{1,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?/.test(value)).length / values.length;
    if (slashRatio >= 0.8) {
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
            format: { dateOrder: dateOrder || 'YMD', hasTime: true, timezone: 'floating', excelSerial: false },
            warnings: [],
        };
    }

    const dashRatio = values.filter(value => /^\d{1,4}-\d{1,2}-\d{1,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?/.test(value)).length / values.length;
    if (dashRatio >= 0.8) {
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
            format: { dateOrder: dateOrder || 'YMD', hasTime: true, timezone: 'floating', excelSerial: false, dashSeparator: true },
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
        return { ok: false, reason: 'Selected columns do not look like a Date + Time pair.' };
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
    const required = ['year', 'month', 'day'];
    for (const part of required) {
        if (!Number.isInteger(parts?.[part]) || parts[part] < 0) {
            return { ok: false, reason: 'Year, month and day columns are required.' };
        }
    }

    const assigned = Object.entries(parts)
        .filter(([, index]) => Number.isInteger(index) && index >= 0);
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
        this.state = {
            lineLimit: 50,
            sampleRegion: this.sampleSegments[0]?.id || 'start',
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
            dataStartIndex: Math.max(0, Number(this.autoProfile?.dataStartIndex) || 1),
            timeMode: this.autoProfile?.timeSource?.kind === 'index'
                ? 'index'
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
        header.append(heading, subtitle, this.confidence);

        const toolbar = document.createElement('div');
        toolbar.className = 'csv-preview-toolbar';
        this.lineLimitSelect = this._select(LINE_LIMITS.map(value => ({ value, label: String(value) })), this.state.lineLimit);
        this.sampleRegionSelect = this._select(this._sampleRegionOptions(), this.state.sampleRegion);
        this.delimiterSelect = this._select(DELIMITERS, this.state.delimiter);
        this.decimalSelect = this._select(DECIMAL_SEPARATORS, this.state.decimalSeparator);
        this.encodingSelect = this._select(ENCODINGS, this.state.encoding);
        this.loadMoreButton = document.createElement('button');
        this.loadMoreButton.type = 'button';
        this.loadMoreButton.className = 'csv-preview-load-more';
        this.loadMoreButton.textContent = i18n.t('csvPreviewLoadMore');
        this.lineLimitSelect.addEventListener('change', () => {
            this.state.lineLimit = Number(this.lineLimitSelect.value) || 50;
            this._refreshPreview();
        });
        this.sampleRegionSelect.addEventListener('change', () => {
            this.state.sampleRegion = this.sampleRegionSelect.value;
            this._refreshPreview({ preserveStructure: true });
        });
        this.loadMoreButton.addEventListener('click', () => this._loadMorePreviewLines());
        this.delimiterSelect.addEventListener('change', () => {
            this.state.delimiter = this.delimiterSelect.value;
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
            this.loadMoreButton,
            this._field(i18n.t('csvPreviewDelimiter'), this.delimiterSelect),
            this._field(i18n.t('csvPreviewDecimalSeparator'), this.decimalSelect),
            this._field(i18n.t('csvPreviewEncoding'), this.encodingSelect),
        );

        const body = document.createElement('div');
        body.className = 'csv-preview-body';
        this.gridWrap = document.createElement('div');
        this.gridWrap.className = 'csv-preview-grid-wrap';
        this.sidePanel = document.createElement('div');
        this.sidePanel.className = 'csv-preview-side';
        body.append(this.gridWrap, this.sidePanel);

        const footer = document.createElement('div');
        footer.className = 'csv-preview-footer';
        const left = document.createElement('div');
        left.className = 'csv-preview-footer-left';
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.textContent = i18n.t('csvPreviewResetAuto');
        reset.addEventListener('click', () => {
            this.autoProfile = null;
            this._refreshPreview({ redetectStructure: true });
        });
        const redetect = document.createElement('button');
        redetect.type = 'button';
        redetect.textContent = i18n.t('csvPreviewRedetect');
        redetect.addEventListener('click', () => this._refreshPreview({ redetectStructure: true }));
        left.append(reset, redetect);
        const right = document.createElement('div');
        right.className = 'csv-preview-footer-right';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'modal-btn modal-btn-cancel';
        cancel.textContent = i18n.t('cancel');
        cancel.addEventListener('click', () => this._finish(null));
        this.applyButton = document.createElement('button');
        this.applyButton.type = 'button';
        this.applyButton.className = 'modal-btn modal-btn-confirm';
        this.applyButton.textContent = i18n.t('csvPreviewApply');
        this.applyButton.addEventListener('click', () => this._finish(this.resultProfile));
        right.append(cancel, this.applyButton);
        footer.append(left, right);

        this.dialog.append(header, toolbar, body, footer);
    }

    _field(labelText, control) {
        const label = document.createElement('label');
        label.className = 'csv-preview-field';
        const span = document.createElement('span');
        span.textContent = labelText;
        label.append(span, control);
        return label;
    }

    _select(options, selected) {
        const select = document.createElement('select');
        for (const option of options) {
            const el = document.createElement('option');
            el.value = option.value;
            el.textContent = option.label;
            el.selected = String(option.value) === String(selected);
            select.appendChild(el);
        }
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

    _refreshPreview(options = {}) {
        const selectedSegment = this._selectedSegment();
        const buffer = selectedSegment?.buffer;
        const preview = this.parser.inspectPreview(buffer, {
            maxRows: this.state.lineLimit,
            delimiter: this.state.delimiter,
            encoding: this.state.encoding,
        });
        this.preview = preview;
        if (!options.preserveStructure && (options.redetectStructure || !this.resultProfile)) {
            const profile = preview.profile || {};
            this.state.hasHeader = profile.hasHeader !== false;
            this.state.headerIndex = Math.max(0, Number(profile.headerIndex) || 0);
            this.state.dataStartIndex = Math.max(0, Number(profile.dataStartIndex) || (this.state.hasHeader ? this.state.headerIndex + 1 : this.state.headerIndex));
            this.state.timeMode = profile.timeSource?.kind === 'index'
                ? 'index'
                : profile.timeSource?.mode === 'split' ? 'split' : 'single';
            this.state.timeColumn = profile.timeSource?.sourceIndexes?.[0] ?? this.state.timeColumn ?? 0;
            this.state.timeDateColumn = profile.timeSource?.sourceIndexes?.[0] ?? this.state.timeDateColumn ?? 0;
            this.state.timeTimeColumn = profile.timeSource?.sourceIndexes?.[1] ?? this.state.timeTimeColumn ?? 1;
            this.state.dateOrder = profile.timeSource?.format?.dateOrder || this.state.dateOrder || 'YMD';
        }
        this._rebuildProfile();
        this._renderControls();
        this._renderGrid();
        this._renderValidation();
    }

    async _loadMorePreviewLines() {
        const selectedSegment = this._selectedSegment();
        const nextLineLimit = Math.min(MAX_PREVIEW_LINES, Math.max(this.state.lineLimit + LOAD_MORE_LINE_STEP, 100));
        this.state.lineLimit = nextLineLimit;
        if (this.loadMoreButton) this.loadMoreButton.disabled = true;
        if (this.lineLimitSelect && ![...this.lineLimitSelect.options].some(option => Number(option.value) === nextLineLimit)) {
            const option = document.createElement('option');
            option.value = String(nextLineLimit);
            option.textContent = String(nextLineLimit);
            this.lineLimitSelect.appendChild(option);
        }
        if (this.lineLimitSelect) this.lineLimitSelect.value = String(nextLineLimit);
        try {
            if (this.loadPreviewSegment && selectedSegment) {
                const currentBytes = Number(selectedSegment.bytes || selectedSegment.buffer?.byteLength || DEFAULT_SAMPLE_BYTES);
                const requestedBytes = Math.max(currentBytes + DEFAULT_SAMPLE_BYTES, Math.ceil(currentBytes * 1.5));
                const refreshed = await this.loadPreviewSegment(selectedSegment.id, requestedBytes);
                if (refreshed?.buffer) this._replaceSelectedSegment(refreshed);
            }
        } finally {
            if (this.loadMoreButton) this.loadMoreButton.disabled = this.state.lineLimit >= MAX_PREVIEW_LINES;
        }
        this._refreshPreview({ preserveStructure: true });
    }

    _rebuildProfile() {
        const rows = this.preview?.rows || [];
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
        const decimalSeparator = this.state.decimalSeparator || 'auto';
        const hasHeader = !!this.state.hasHeader;
        const headerIndex = Math.max(0, this.state.headerIndex);
        const dataStartIndex = Math.max(0, this.state.dataStartIndex);
        const unitsMode = this.state.unitsMode;
        const unitRowIndex = unitsMode === 'row' && Number.isFinite(this.state.unitRowIndex) ? Math.max(0, this.state.unitRowIndex) : null;
        const previousProfile = this.lastStartProfile || this.resultProfile || this.autoProfile || {};
        const previousHeaders = previousProfile?.rawHeaders || [];
        const sourceHeaderRow = isStartSample
            ? (hasHeader ? rows[headerIndex] : rows[dataStartIndex])
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
            const unitRow = isStartSample ? (rows[unitRowIndex] || []) : [];
            headers = headers.map((header, index) => {
                const unit = String(unitRow[index] ?? '').trim();
                return unit ? { ...header, description: `[${unit}]` } : header;
            });
        }
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
        const candidateRows = (isStartSample ? rows.slice(dataStartIndex) : rows)
            .filter(row => row.some(cell => String(cell ?? '').trim() !== ''));
        const sampleRows = candidateRows.filter(row => row.length === expectedColumns);
        const discardedRows = candidateRows.length - sampleRows.length;
        if (discardedRows > 0) {
            const message = `${discardedRows} visible data row(s) have a different column count.`;
            if (isStartSample) messages.push(message);
            else warnings.push(message);
        }
        if (!sampleRows.length) messages.push('No visible data rows match the header width.');

        let timeSource;
        if (this.state.timeMode === 'index') {
            timeSource = makeIndexTimeSource();
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
            if (!timeSource.ok) messages.push(timeSource.reason || 'Selected Date + Time columns are not valid.');
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

        const timeIndexes = new Set(timeSource?.sourceIndexes || []);
        const ignoredColumns = (this.state.ignoredColumns || [])
            .map(index => Number(index))
            .filter(index => Number.isInteger(index) && index >= 0 && index < expectedColumns && !timeIndexes.has(index));
        this.state.ignoredColumns = ignoredColumns;

        const validTimeRows = sampleRows.filter((row, index) =>
            Number.isFinite(parseCsvTimeValue(timeSource, row, index, delimiter, { decimalSeparator }))
        ).length;
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
            timeSource,
            sampleRows: sampleRows.slice(0, 100),
            unitsMode,
            unitRowIndex,
            inlineUnitFormat: this.state.inlineUnitFormat,
            decimalSeparator,
            ignoredColumns,
            columnOverrides: cloneProfile(this.state.columnOverrides || {}),
            profileSource: 'user',
            previewDiscardedColumnCountRows: discardedRows,
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
        const noHeaderInput = document.createElement('input');
        noHeaderInput.type = 'checkbox';
        noHeaderInput.checked = !this.state.hasHeader;
        noHeaderInput.addEventListener('change', () => {
            this.state.hasHeader = !noHeaderInput.checked;
            this._rebuildAndRender();
        });
        noHeader.append(noHeaderInput, document.createTextNode(i18n.t('csvPreviewNoHeader')));

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
            { value: 'index', label: i18n.t('csvPreviewTimeIndex') },
        ], this.state.timeMode);
        timeMode.addEventListener('change', () => {
            this.state.timeMode = timeMode.value;
            this._rebuildAndRender();
        });

        const timeFormat = this._select(TIME_FORMATS, this.state.timeFormat);
        timeFormat.disabled = this.state.timeMode !== 'single';
        timeFormat.addEventListener('change', () => {
            this.state.timeFormat = timeFormat.value;
            this._rebuildAndRender();
        });

        const customPattern = document.createElement('input');
        customPattern.type = 'text';
        customPattern.value = this.state.customDatetimePattern || '';
        customPattern.placeholder = 'yyyy/MM/dd HH:mm:ss';
        customPattern.disabled = this.state.timeMode !== 'single' || this.state.timeFormat !== 'custom';
        customPattern.addEventListener('change', () => {
            this.state.customDatetimePattern = customPattern.value;
            this._rebuildAndRender();
        });
        customPattern.addEventListener('keydown', event => {
            if (event.key === 'Enter') customPattern.blur();
        });

        const columns = (this.resultProfile?.rawHeaders || []).map((header, index) => ({
            value: index,
            label: `${columnLabel(index)} ${header || `column_${index + 1}`}`,
        }));
        const timeColumn = this._select(columns.length ? columns : [{ value: 0, label: 'A column_1' }], this.state.timeColumn);
        timeColumn.disabled = this.state.timeMode !== 'single';
        timeColumn.addEventListener('change', () => {
            this.state.timeColumn = Number(timeColumn.value) || 0;
            this._rebuildAndRender();
        });

        const dateColumn = this._select(columns.length ? columns : [{ value: 0, label: 'A column_1' }], this.state.timeDateColumn);
        dateColumn.disabled = this.state.timeMode !== 'split';
        dateColumn.addEventListener('change', () => {
            this.state.timeDateColumn = Number(dateColumn.value) || 0;
            this._rebuildAndRender();
        });

        const clockColumn = this._select(columns.length ? columns : [{ value: 1, label: 'B column_2' }], this.state.timeTimeColumn);
        clockColumn.disabled = this.state.timeMode !== 'split';
        clockColumn.addEventListener('change', () => {
            this.state.timeTimeColumn = Number(clockColumn.value) || 0;
            this._rebuildAndRender();
        });

        const partOptions = [{ value: '', label: i18n.t('csvPreviewNone') }, ...columns];
        const makePartSelect = (part) => {
            const select = this._select(partOptions, this.state.timeParts?.[part] ?? '');
            select.disabled = this.state.timeMode !== 'parts';
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
        dateOrder.disabled = this.state.timeMode === 'index';
        dateOrder.addEventListener('change', () => {
            this.state.dateOrder = dateOrder.value;
            this._rebuildAndRender();
        });

        this.statusBox = document.createElement('div');
        this.statusBox.className = 'csv-preview-status';

        const columnTitle = document.createElement('div');
        columnTitle.className = 'csv-preview-side-title';
        columnTitle.textContent = i18n.t('csvPreviewColumns');
        const columnList = this._renderColumnControls();

        this.sidePanel.append(
            tableTitle,
            noHeader,
            this._field(i18n.t('csvPreviewHeaderRow'), headerInput),
            this._field(i18n.t('csvPreviewUnitsSource'), unitsSelect),
            this._field(i18n.t('csvPreviewUnitsRowLabel'), unitsInput),
            this._field(i18n.t('csvPreviewInlineUnitFormat'), inlineFormat),
            this._field(i18n.t('csvPreviewFirstDataRow'), dataInput),
            timeTitle,
            this._field(i18n.t('csvPreviewMode'), timeMode),
            this._field(i18n.t('csvPreviewColumn'), timeColumn),
            this._field(i18n.t('csvPreviewTimeFormat'), timeFormat),
            this._field(i18n.t('csvPreviewPattern'), customPattern),
            this._field(i18n.t('csvPreviewDateColumn'), dateColumn),
            this._field(i18n.t('csvPreviewTimeColumn'), clockColumn),
            this._field(i18n.t('csvPreviewYearColumn'), yearColumn),
            this._field(i18n.t('csvPreviewMonthColumn'), monthColumn),
            this._field(i18n.t('csvPreviewDayColumn'), dayColumn),
            this._field(i18n.t('csvPreviewHourColumn'), hourColumn),
            this._field(i18n.t('csvPreviewMinuteColumn'), minuteColumn),
            this._field(i18n.t('csvPreviewSecondColumn'), secondColumn),
            this._field(i18n.t('csvPreviewDateOrder'), dateOrder),
            columnTitle,
            columnList,
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
            const row = document.createElement('div');
            row.className = 'csv-preview-column-control';

            const ignore = document.createElement('input');
            ignore.type = 'checkbox';
            ignore.checked = ignored.has(index);
            ignore.disabled = timeIndexes.has(index);
            ignore.title = timeIndexes.has(index) ? i18n.t('csvPreviewTimeColumnProtected') : '';
            ignore.addEventListener('change', () => {
                const next = new Set(this.state.ignoredColumns || []);
                if (ignore.checked) next.add(index);
                else next.delete(index);
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
            raw.textContent = `${columnLabel(index)} ${rawHeaders[index] || ''}`;
            raw.title = rawHeaders[index] || '';

            row.append(ignore, name, raw);
            wrap.appendChild(row);
        });
        return wrap;
    }

    _rebuildAndRender() {
        this._rebuildProfile();
        this._renderControls();
        this._renderGrid();
        this._renderValidation();
    }

    _renderGrid() {
        const rows = this.preview?.rows || [];
        const isStartSample = this._isStartSample();
        const maxColumns = Math.max(1, ...rows.map(row => row.length));
        const table = document.createElement('table');
        table.className = 'csv-preview-grid';
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        headRow.appendChild(document.createElement('th'));
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
        const visualDataStartIndex = isStartSample ? this.state.dataStartIndex : 0;
        const dataRowsBefore = rows
            .slice(0, visualDataStartIndex)
            .filter(row => row.some(cell => String(cell ?? '').trim() !== ''));
        const dataRowOffset = dataRowsBefore.length;

        rows.forEach((row, r) => {
            const tr = document.createElement('tr');
            if (isStartSample && r < this.state.dataStartIndex) tr.classList.add('is-skipped');
            if (isStartSample && this.state.hasHeader && r === this.state.headerIndex) tr.classList.add('is-header-row');
            if (isStartSample && this.state.unitsMode === 'row' && r === this.state.unitRowIndex) tr.classList.add('is-units-row');
            if (r >= visualDataStartIndex) tr.classList.add('is-data-row');

            const rowHead = document.createElement('th');
            rowHead.className = 'csv-preview-row-head';
            rowHead.textContent = isStartSample ? String(r + 1) : `~${r + 1}`;
            rowHead.title = i18n.t('csvPreviewRowClickHint');
            rowHead.addEventListener('click', () => {
                if (!isStartSample) return;
                if (!this.state.hasHeader || r >= this.state.dataStartIndex) this.state.dataStartIndex = r;
                else if (this.state.unitsMode === 'row') this.state.unitRowIndex = r;
                else this.state.headerIndex = r;
                this._rebuildAndRender();
            });
            tr.appendChild(rowHead);

            for (let c = 0; c < maxColumns; c++) {
                const td = document.createElement('td');
                td.textContent = row[c] ?? '';
                if (timeIndexes.has(c)) td.classList.add('is-time-column');
                if (r >= visualDataStartIndex && timeIndexes.has(c)) {
                    const rowIndex = Math.max(0, r - dataRowOffset);
                    const parsed = parseCsvTimeValue(this.resultProfile.timeSource, row, rowIndex, delimiter, {
                        decimalSeparator: this.resultProfile.decimalSeparator || 'auto',
                    });
                    if (!Number.isFinite(parsed)) td.classList.add('is-invalid-cell');
                }
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        this.gridWrap.replaceChildren(table);
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
