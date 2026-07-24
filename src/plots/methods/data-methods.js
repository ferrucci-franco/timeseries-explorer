import { getCalendarDateTickFormat } from '../plotly-locale.js';

const DEFAULT_GENERATED_TIME_ORIGIN = '2026-01-01T00:00:00';

export function getCalendarTimeFormats(mode = '24h', language = 'en') {
    const useAmPm = mode === 'ampm' || mode === 'calendar-ampm';
    const tickformat = useAmPm ? '%-I:%M %p' : '%H:%M';
    const hoverformat = useAmPm ? '%-I:%M:%S %p' : '%H:%M:%S';
    return {
        tickformat,
        // Plotly treats the text after \n as a secondary date label, keeping
        // the day visible when it changes without making locale the clock source.
        tickformatWithDate: `${tickformat}\n${getCalendarDateTickFormat(language)}`,
        hoverformat,
        traceHoverformat: `%Y-%m-%d ${hoverformat}`,
    };
}

function finiteAxisExtent(input) {
    let min = Infinity;
    let max = -Infinity;
    const visit = (value) => {
        const isIterableView = ArrayBuffer.isView(value)
            && typeof value?.[Symbol.iterator] === 'function';
        if (Array.isArray(value) || isIterableView) {
            for (const item of value) visit(item);
            return;
        }
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) return;
        if (numeric < min) min = numeric;
        if (numeric > max) max = numeric;
    };
    visit(input ?? []);
    return Number.isFinite(min) && Number.isFinite(max) ? { min, max } : null;
}

function parseGeneratedTimeOriginMs(value) {
    const raw = String(value || '').trim();
    const text = (raw || DEFAULT_GENERATED_TIME_ORIGIN).replace(' ', 'T');
    const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (!match) return Date.UTC(2026, 0, 1, 0, 0, 0);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6] || 0);
    const ms = Date.UTC(year, month - 1, day, hour, minute, second);
    const d = new Date(ms);
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day
        || d.getUTCHours() !== hour || d.getUTCMinutes() !== minute || d.getUTCSeconds() !== second) {
        return Date.UTC(2026, 0, 1, 0, 0, 0);
    }
    return ms;
}

export function expandedAxisRangeForExtent(currentRange, extent, padding = 0.05) {
    if (!Array.isArray(currentRange) || currentRange.length < 2 || !extent) return null;
    const first = Number(currentRange[0]);
    const second = Number(currentRange[1]);
    const extentMin = Number(extent.min);
    const extentMax = Number(extent.max);
    if (![first, second, extentMin, extentMax].every(Number.isFinite)) return null;
    const reversed = first > second;
    const currentMin = Math.min(first, second);
    const currentMax = Math.max(first, second);
    if (extentMin >= currentMin && extentMax <= currentMax) return null;
    const unionMin = Math.min(currentMin, extentMin);
    const unionMax = Math.max(currentMax, extentMax);
    const pad = Math.max((unionMax - unionMin) * Math.max(0, Number(padding) || 0), 1e-9);
    const nextMin = extentMin < currentMin ? extentMin - pad : currentMin;
    const nextMax = extentMax > currentMax ? extentMax + pad : currentMax;
    return reversed ? [nextMax, nextMin] : [nextMin, nextMax];
}

export function installPlotDataMethods(TargetClass) {
    const proto = TargetClass.prototype;
    const PlotManager = TargetClass;

    if (!proto._variableLabel) {
        proto._variableLabel = function(varName, fileId = this.activeFileId) {
            if (!varName) return '';
            const d = fileId ? this.files.get(fileId)?.data : null;
            const v = d?.variables?.[varName];
            return v?.displayName || varName;
        };
    }

    if (!proto._phaseTraceName) {
        proto._phaseTraceName = function(plot, pt) {
            const label = plot.mode === 'phase3d'
                ? `${this._variableLabel(pt.x, pt.fileId)} / ${this._variableLabel(pt.y, pt.fileId)} / ${this._variableLabel(pt.z, pt.fileId)}`
                : `${this._variableLabel(pt.x, pt.fileId)} vs ${this._variableLabel(pt.y, pt.fileId)}`;
            return this._traceName(label, pt.fileId);
        };
    }

proto._normalizeFileTransform = function(transform = null) {
    const t = transform || {};
    const finiteOrZero = (value) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    };
    const valueOrNull = (value) => {
        if (value === '' || value === null || value === undefined) return null;
        return value;
    };
    const mode = (() => {
        if (t.timeDisplayMode === 'calendar') return 'calendar';
        if (t.timeDisplayMode === 'elapsedDateTime' || t.timeDisplayMode === 'elapsedDatetime') return 'elapsedDateTime';
        if (t.timeDisplayMode === 'elapsedSeconds' || t.timeDisplayMode === 'elapsed') return 'elapsedSeconds';
        if (t.timeDisplayMode === 'index') return 'index';
        return null;
    })();
    return {
        timeDisplayMode: mode,
        calendarTimeFormat: t.calendarTimeFormat === 'ampm'
            ? 'ampm'
            : (t.calendarTimeFormat === '24h' ? '24h' : null),
        timeShift: t.timeShift === '' || t.timeShift === null || t.timeShift === undefined ? 0 : t.timeShift,
        timeStepMode: ['index', 'seconds', '1minute', '10minutes', '15minutes', '30minutes', '1hour', '1day', 'custom'].includes(t.timeStepMode) ? t.timeStepMode : null,
        customTimeStep: t.customTimeStep === null || t.customTimeStep === undefined ? '' : String(t.customTimeStep),
        timeStepOriginMode: ['elapsed', 'elapsed-seconds', 'calendar'].includes(t.timeStepOriginMode) ? t.timeStepOriginMode : null,
        timeStepOriginDate: t.timeStepOriginDate === null || t.timeStepOriginDate === undefined ? '' : String(t.timeStepOriginDate),
        numericTimeDisplay: ['seconds', 'duration'].includes(t.numericTimeDisplay) ? t.numericTimeDisplay : null,
        gain: (() => {
            const n = Number(t.gain);
            return Number.isFinite(n) ? n : 1;
        })(),
        yOffset: finiteOrZero(t.yOffset),
        cropStart: valueOrNull(t.cropStart),
        cropEnd: valueOrNull(t.cropEnd),
    };
};

proto._isFileTransformActive = function(transform) {
    const t = this._normalizeFileTransform(transform);
    return t.timeDisplayMode !== null || t.calendarTimeFormat !== null || t.timeShift !== 0 || t.timeStepMode !== null || t.customTimeStep !== '' || t.timeStepOriginMode !== null || (t.timeStepOriginMode === 'calendar' && t.timeStepOriginDate !== '') || t.numericTimeDisplay !== null || t.gain !== 1 || t.yOffset !== 0 || t.cropStart !== null || t.cropEnd !== null;
};

proto._fileTransform = function(fileId) {
    return this._normalizeFileTransform(this.files.get(fileId)?.transform);
};

proto._transformCache = function(fileId) {
    const entry = this.files.get(fileId);
    if (!entry) return null;
    if (!entry._transformCache) entry._transformCache = { indexData: null, series: new Map() };
    return entry._transformCache;
};

proto._timeKind = function(fileId) {
    return this._timeAxisModel(fileId).legacyKind;
};

proto._isGeneratedIndexTime = function(fileId, timeVar = null) {
    const t = timeVar || this._getTimeVar(fileId);
    const transformMode = this._fileTransform(fileId).timeDisplayMode;
    if (transformMode === 'index') return true;
    if (t?.timeSourceStrategy === 'index-column') return false;
    if (t?.timeSourceStrategy === 'generated-index') return true;
    if (t?.timeKind === 'datetime' && transformMode) return false;
    return t?.timeKind === 'index'
        || (t?.timeKind === 'datetime' && t?.timeDisplayMode === 'index');
};

proto._isGeneratedDurationTime = function(fileId, timeVar = null) {
    // The "Seconds (numeric)" show-as (originMode 'elapsed-seconds') is a stepped
    // index too, but is rendered as a plain linear number of seconds rather than
    // hh:mm:ss, so it is deliberately excluded from the duration path here — this
    // one exclusion turns off duration formatting everywhere that gates on it.
    return this._isGeneratedIndexTime(fileId, timeVar)
        && this._indexTimeStepMode(fileId) !== 'index'
        && this._fileTransform(fileId).timeStepOriginMode !== 'elapsed-seconds';
};

proto._isGeneratedFromDetectedTime = function(fileId, timeVar = null) {
    const t = timeVar || this._getTimeVar(fileId);
    const transform = this._fileTransform(fileId);
    return this._isGeneratedIndexTime(fileId, t)
        && t?.timeKind === 'datetime'
        && (transform.timeDisplayMode === 'index'
            || (!transform.timeDisplayMode && t?.timeDisplayMode === 'index'));
};

proto._isGeneratedCalendarTime = function(fileId, timeVar = null) {
    const t = timeVar || this._getTimeVar(fileId);
    const stepSeconds = this._indexTimeStepSeconds(fileId);
    return this._isGeneratedDurationTime(fileId, t)
        && Number.isFinite(stepSeconds)
        && stepSeconds > 0
        && this._fileTransform(fileId).timeStepOriginMode === 'calendar';
};

// A generated (reindexed) axis stepped by a real Δt, but shown as a plain linear
// number of seconds (row × Δt) rather than hh:mm:ss — the value-preserving
// "Seconds (numeric)" show-as, and the native format of a .mat time vector.
proto._isGeneratedSecondsTime = function(fileId, timeVar = null) {
    return this._isGeneratedIndexTime(fileId, timeVar)
        && this._indexTimeStepMode(fileId) !== 'index'
        && this._fileTransform(fileId).timeStepOriginMode === 'elapsed-seconds';
};

// A real numeric time vector shown as a duration (hh:mm:ss) instead of a plain
// number of seconds. Value-preserving: the axis just formats the same seconds.
proto._isNumericDurationAxis = function(fileId, timeVar = null) {
    const t = timeVar || this._getTimeVar(fileId);
    if (this._isGeneratedIndexTime(fileId, t) || t?.timeKind === 'datetime') return false;
    return this._fileTransform(fileId).numericTimeDisplay === 'duration';
};

proto._isHighResolutionGeneratedCalendarTime = function(fileId, timeVar = null) {
    return this._isGeneratedCalendarTime(fileId, timeVar)
        && this._indexTimeStepSeconds(fileId) < 0.001;
};

proto._indexTimeStepMode = function(fileId) {
    const transform = this._fileTransform(fileId);
    const timeVar = this._getTimeVar(fileId);
    if (timeVar?.timeKind === 'datetime'
        && transform.timeDisplayMode
        && transform.timeDisplayMode !== 'index') {
        return null;
    }
    if (transform.timeDisplayMode !== 'index'
        && timeVar?.timeKind !== 'index'
        && !(timeVar?.timeKind === 'datetime' && timeVar?.timeDisplayMode === 'index')) {
        return null;
    }
    return transform.timeStepMode || timeVar.timeStepMode || 'index';
};

proto._indexTimeStepSeconds = function(fileId) {
    const mode = this._indexTimeStepMode(fileId);
    if (mode === 'seconds') return 1;
    if (mode === '1minute') return 60;
    if (mode === '10minutes') return 600;
    if (mode === '15minutes') return 900;
    if (mode === '30minutes') return 1800;
    if (mode === '1hour') return 3600;
    if (mode === '1day') return 86400;
    if (mode === 'custom') {
        const seconds = this._parseDurationMs(this._fileTransform(fileId).customTimeStep) / 1000;
        return Number.isFinite(seconds) && seconds > 0 ? seconds : 1;
    }
    return 1;
};

proto._indexTimeStepLabel = function(fileId) {
    const mode = this._indexTimeStepMode(fileId);
    if (mode === 'index') return 'index';
    if (mode === 'seconds') return '1 s';
    if (mode === '1minute') return '1 min';
    if (mode === '10minutes') return '10 min';
    if (mode === '15minutes') return '15 min';
    if (mode === '30minutes') return '30 min';
    if (mode === '1hour') return '1 h';
    if (mode === '1day') return '1 d';
    if (mode === 'custom') {
        const raw = String(this._fileTransform(fileId).customTimeStep || '').trim();
        return raw || 'custom';
    }
    return '1 s';
};

proto._timeDisplayMode = function(fileId) {
    return this._timeAxisModel(fileId).legacyDisplayMode;
};

proto._timeDisplayModeForVar = function(fileId, timeVar = null) {
    if (this._isGeneratedIndexTime(fileId, timeVar)) return this._isGeneratedCalendarTime(fileId, timeVar) ? 'calendar' : 'index';
    if (timeVar?.timeKind !== 'datetime') return 'numeric';
    const transform = this._fileTransform(fileId);
    return transform.timeDisplayMode || timeVar.timeDisplayMode || 'calendar';
};

// ── Canonical time-axis model (single source of truth) ──────────────────────
// Computed directly from the raw primitives (the abscissa variable, the file
// transform, and the generated-index/-calendar detectors) WITHOUT calling
// _timeKind / _timeDisplayMode / _timeUnitLabel — those are now thin wrappers
// over this function (`legacyKind` / `legacyDisplayMode` / `unit`). It reduces
// every axis to {semantic, storageEncoding, display, unit}. The NEW canonical
// fields (semantic, renderSignature) are not yet consumed by the overlay guard
// or transform menu; see docs/time-axis-unification-design.md (v4).
proto._timeAxisModel = function(fileId) {
    const timeVar = this._getTimeVar(fileId);
    const transform = this._fileTransform(fileId);
    const isGeneratedIndex = this._isGeneratedIndexTime(fileId, timeVar);
    const isGeneratedCalendar = this._isGeneratedCalendarTime(fileId, timeVar);
    const indexStepMode = this._indexTimeStepMode(fileId);
    const highResGeneratedCalendar = this._isHighResolutionGeneratedCalendarTime(fileId, timeVar);
    const isGeneratedSeconds = isGeneratedIndex && indexStepMode !== 'index' && transform.timeStepOriginMode === 'elapsed-seconds';
    // A real numeric time vector (its own seconds) that the user chose to show as a
    // duration (hh:mm:ss) instead of a plain number — value-preserving, no /1000.
    const isNumericDuration = !isGeneratedIndex && timeVar?.timeKind !== 'datetime' && transform.numericTimeDisplay === 'duration';

    // Legacy time kind (inlined from the former _timeKind).
    const kind = (isGeneratedCalendar || timeVar?.timeKind === 'datetime') ? 'datetime' : 'numeric';

    // Legacy display mode (inlined from the former _timeDisplayMode).
    let displayMode;
    if (isGeneratedIndex) displayMode = isGeneratedCalendar ? 'calendar' : 'index';
    else if (timeVar?.timeKind !== 'datetime') displayMode = 'numeric';
    else displayMode = transform.timeDisplayMode || timeVar.timeDisplayMode || 'calendar';

    // Axis unit label (inlined from the former _timeUnitLabel, using local state).
    let unit;
    if (isGeneratedCalendar) unit = 'datetime';
    else if (isGeneratedIndex) unit = indexStepMode === 'index' ? 'index' : (isGeneratedSeconds ? 's' : 'duration');
    else if (displayMode === 'calendar') unit = 'datetime';
    else if (displayMode === 'elapsedDateTime') unit = 'duration';
    else if (displayMode === 'elapsedSeconds') unit = 's';
    else if (isNumericDuration) unit = 'duration';
    else unit = timeVar ? this._extractUnit(timeVar.description) : 's';

    let semantic;
    let storageEncoding;
    if (isGeneratedCalendar) {
        semantic = 'absolute'; storageEncoding = 'row-count';
    } else if (isGeneratedIndex) {
        // A generated index is row-driven (stored values discarded). A PURE index
        // (0,1,2…) is a count axis; a stepped index (row × Δt) is elapsed seconds
        // shown as seconds/duration. Checked before the datetime case.
        semantic = indexStepMode === 'index' ? 'count' : 'elapsed';
        storageEncoding = 'row-count';
    } else if (kind === 'datetime') {
        semantic = 'absolute'; storageEncoding = 'epoch-ms';
    } else {
        // Product decision ("float time = seconds"): a numeric time axis is taken
        // as elapsed seconds, so it shares a render signature with a datetime shown
        // as Elapsed (seconds) and the two can overlay. (Diverges from the v4 doc's
        // conservative 'unknown'; a Unix-epoch/coordinate column would need an
        // explicit interpretation override to opt out — a follow-up.)
        semantic = 'elapsed'; storageEncoding = 'raw-number';
    }

    // Canonical display reflects the RENDERED axis (so overlay compatibility is
    // correct): a stepped generated index shows seconds/duration (both are
    // elapsed-seconds); only a PURE index (0,1,2…) is a count axis.
    let display;
    if (isGeneratedCalendar) display = 'calendar';
    else if (isGeneratedIndex) display = indexStepMode === 'index' ? 'index' : (isGeneratedSeconds ? 'seconds' : 'duration');
    else if (isNumericDuration) display = 'duration';
    else display = ({ calendar: 'calendar', elapsedDateTime: 'duration', elapsedSeconds: 'seconds', numeric: 'seconds' })[displayMode] || 'seconds';

    return {
        semantic,
        storageEncoding,
        display,
        unit,
        calendarId: semantic === 'absolute' ? 'gregorian' : 'none',
        indexStepMode,
        highResGeneratedCalendar,
        // Legacy shadow — consumed by the _timeKind/_timeDisplayMode wrappers.
        legacyKind: kind,
        legacyDisplayMode: displayMode,
    };
};

// FFT/analysis-mode time classifier ('index' | 'datetime' | 'numeric'), expressed
// through the canonical model. This is the single implementation that _fftTimeKind
// delegates to; it reproduces the original fft-methods.js logic exactly (proven by
// scripts/test-time-axis-readers.mjs), so analysis-mode gating is unchanged.
proto._canonicalFftKind = function(fileId) {
    const model = this._timeAxisModel(fileId);
    if (model.storageEncoding === 'row-count' && model.indexStepMode === 'index') return 'index';
    if (model.display === 'calendar' && !model.highResGeneratedCalendar) return 'datetime';
    return 'numeric';
};

// Coordinate-sharing signature: two traces can share one Plotly x-axis iff their
// renderSignature is identical. `raw` compares by unit token (unitless = ''), so
// two generic-numeric axes with the same unit stay overlay-compatible (v4 §4.1).
proto._renderSignature = function(fileId) {
    const model = this._timeAxisModel(fileId);
    switch (model.display) {
        case 'calendar': return 'date';
        case 'duration':
        case 'seconds':  return 'linear:elapsed-seconds';
        case 'index':    return 'linear:count';
        default:         return `linear:raw:${model.unit || ''}`;
    }
};

// Per-operation capability predicates, independent of renderSignature (v4 §4.2).
// Sampling-based capabilities (monotonic/uniform/Hz) are added in later phases.
proto._operationCapabilities = function(fileId) {
    const model = this._timeAxisModel(fileId);
    const hasGregorianCalendar = model.semantic === 'absolute' && model.calendarId === 'gregorian';
    const hasElapsed = model.semantic === 'absolute' || model.semantic === 'elapsed';
    return { hasGregorianCalendar, hasElapsed, hasPhysicalTimeUnit: hasElapsed };
};

// Panel-level time-axis resolution (Phase 1). Given the fileIds of a panel's
// visible time traces, decide the single axis the panel must render. Pure and
// order-independent (works on the SET of trace signatures/displays, never their
// insertion order). Not yet wired into the guard/renderers — that is Phase 1
// steps 2-3. See docs/time-axis-unification-design.md (v4 §5).
proto._resolvePanelTimeAxis = function(fileIds = []) {
    const ids = (fileIds || []).filter(Boolean);
    const base = { alignmentPolicy: 'per-series-zero', referenceOriginMs: null };
    if (!ids.length) {
        return { compatible: true, effectiveDisplay: null, effectiveUnit: null, ...base };
    }
    const signatures = new Set(ids.map(id => this._renderSignature(id)));
    if (signatures.size !== 1) {
        return { compatible: false, effectiveDisplay: null, effectiveUnit: null, ...base };
    }
    const signature = [...signatures][0];
    if (signature === 'date') {
        return { compatible: true, effectiveDisplay: 'calendar', effectiveUnit: null, ...base };
    }
    if (signature === 'linear:elapsed-seconds') {
        // duration only if EVERY trace prefers duration; any seconds ⇒ seconds
        // (plain linear, negative-safe, scientific default). Order-independent.
        const allDuration = ids.every(id => this._timeAxisModel(id).display === 'duration');
        return { compatible: true, effectiveDisplay: allDuration ? 'duration' : 'seconds', effectiveUnit: 's', ...base };
    }
    if (signature === 'linear:count') {
        return { compatible: true, effectiveDisplay: 'index', effectiveUnit: 'count', ...base };
    }
    // linear:raw:<unit> — identical unit across traces is guaranteed by the single signature.
    return { compatible: true, effectiveDisplay: 'raw', effectiveUnit: this._timeAxisModel(ids[0]).unit, ...base };
};

proto._calendarTimeFormat = function(fileId, timeVar = null) {
    const transform = this._fileTransform(fileId);
    return transform.calendarTimeFormat || timeVar?.calendarTimeFormat || '24h';
};

proto._calendarTimeFormats = function(fileId, timeVar = null) {
    return getCalendarTimeFormats(this._calendarTimeFormat(fileId, timeVar), this.language);
};

proto._calendarTickFormat = function(fileId, timeVar = null) {
    return this._calendarTimeFormats(fileId, timeVar).traceHoverformat;
};

proto._calendarAxisConfig = function(fileId, timeVar = null, rangeOrValues = null) {
    if (this._isHighResolutionGeneratedCalendarTime(fileId, timeVar)) {
        return this._highResolutionCalendarAxisConfig(fileId, timeVar, rangeOrValues);
    }
    const formats = this._calendarTimeFormats(fileId, timeVar);
    return {
        type: 'date',
        tickformat: formats.tickformatWithDate,
        hoverformat: formats.hoverformat,
    };
};

proto._timeAxisRelayoutUpdate = function(axisConfig = {}, axisPath = 'xaxis') {
    const update = {};
    for (const key of ['type', 'tickmode', 'tickvals', 'ticktext', 'tickformat', 'hoverformat']) {
        if (axisConfig[key] !== undefined) update[`${axisPath}.${key}`] = axisConfig[key];
    }
    return update;
};

proto._isCalendarTime = function(fileId) {
    return this._timeDisplayMode(fileId) === 'calendar';
};

proto._isCalendarTimeForVar = function(fileId, timeVar = null) {
    return this._timeDisplayModeForVar(fileId, timeVar) === 'calendar';
};

proto._timeOriginMsForVar = function(fileId, timeVar = null) {
    const entry = this.files.get(fileId);
    const t = timeVar || this._getTimeVar(fileId);
    const transform = this._fileTransform(fileId);
    if (this._isGeneratedDurationTime(fileId, t) && transform.timeStepOriginMode === 'calendar') {
        return parseGeneratedTimeOriginMs(transform.timeStepOriginDate);
    }
    const candidates = [
        t?.timeOriginMs,
        entry?.data?.metadata?.timeOriginMs,
        entry?.data?.metadata?.timeStart,
        t?.data?.[0],
    ];
    for (const candidate of candidates) {
        const value = Number(candidate);
        if (Number.isFinite(value)) return value;
    }
    return 0;
};

proto._timeOriginMs = function(fileId) {
    return this._timeOriginMsForVar(fileId);
};

proto._timeDisplayValue = function(fileId, rawTime) {
    if (this._isElapsedTime(fileId)) {
        return (rawTime - this._timeOriginMs(fileId)) / 1000;
    }
    return rawTime;
};

proto._timeDisplayValueForVar = function(fileId, rawTime, timeVar = null) {
    if (this._isGeneratedIndexTime(fileId, timeVar)) {
        return this._generatedIndexDisplayTime(fileId, rawTime, timeVar);
    }
    if (this._isElapsedTimeForVar(fileId, timeVar)) {
        const originMs = this._timeOriginMsForVar(fileId, timeVar);
        return (rawTime - originMs) / 1000;
    }
    return rawTime;
};

proto._generatedIndexDisplayTime = function(fileId, rowIndex, timeVar = null) {
    const row = Number(rowIndex);
    if (!Number.isFinite(row)) return NaN;
    const mode = this._indexTimeStepMode(fileId);
    if (mode !== 'index' && this._isGeneratedCalendarTime(fileId, timeVar)) {
        if (this._isHighResolutionGeneratedCalendarTime(fileId, timeVar)) {
            return row * this._indexTimeStepSeconds(fileId);
        }
        const originMs = this._timeOriginMsForVar(fileId, timeVar);
        return originMs + row * this._indexTimeStepSeconds(fileId) * 1000;
    }
    return mode === 'index' ? row : row * this._indexTimeStepSeconds(fileId);
};

proto._approxRowIndexFromSourceTime = function(fileId, rawTime, fallbackIndex = null) {
    const fallback = Number(fallbackIndex);
    const raw = Number(rawTime);
    const entry = this.files.get(fileId);
    const totalRows = Number(entry?.data?._duckdb?.totalRows);
    const start = Number(entry?.data?.metadata?.timeStart);
    const end = Number(entry?.data?.metadata?.timeEnd);
    if (Number.isFinite(raw)
        && Number.isFinite(totalRows)
        && totalRows > 1
        && Number.isFinite(start)
        && Number.isFinite(end)
        && end > start) {
        const ratio = (raw - start) / (end - start);
        return Math.max(0, Math.min(totalRows - 1, ratio * (totalRows - 1)));
    }
    if (Number.isFinite(fallback)) return fallback;
    return raw;
};

proto._displayTimeForFetchedSourceTime = function(fileId, rawTime, fallbackIndex = null, timeVar = null) {
    const t = timeVar || this._getTimeVar(fileId);
    const transform = this._fileTransform(fileId);
    let displayTime;
    if (this._isGeneratedIndexTime(fileId, t)) {
        const rowIndex = t?.timeKind === 'datetime'
            ? this._approxRowIndexFromSourceTime(fileId, rawTime, fallbackIndex)
            : rawTime;
        displayTime = this._generatedIndexDisplayTime(fileId, rowIndex, t);
    } else {
        displayTime = this._timeDisplayValueForVar(fileId, rawTime, t);
    }
    const shift = this._parseTimeShift(fileId, transform.timeShift);
    return Number.isFinite(displayTime) ? displayTime + shift : displayTime;
};

proto._sourceRangeForDisplayRange = function(fileId, displayRange, timeVar = null) {
    const t = timeVar || this._getTimeVar(fileId);
    const entry = this.files.get(fileId);
    const rawValues = (displayRange || []).map(value => Number(value));
    if (rawValues.length < 2 || !rawValues.every(Number.isFinite)) return null;

    const transform = this._fileTransform(fileId);
    const shift = this._parseTimeShift(fileId, transform.timeShift);
    const values = rawValues.map(value => value - shift);

    if (this._isGeneratedIndexTime(fileId, t)) {
        const dataStart = Number(entry?.data?.metadata?.timeStart);
        const dataEnd = Number(entry?.data?.metadata?.timeEnd);
        const totalRows = Number(entry?.data?._duckdb?.totalRows);
        if (Number.isFinite(dataStart)
            && Number.isFinite(dataEnd)
            && dataEnd > dataStart
            && Number.isFinite(totalRows)
            && totalRows > 1) {
            const stepSeconds = this._indexTimeStepSeconds(fileId);
            const mode = this._indexTimeStepMode(fileId);
            const displayToRow = value => {
                if (mode === 'index') return value;
                if (this._isGeneratedCalendarTime(fileId, t) && !this._isHighResolutionGeneratedCalendarTime(fileId, t)) {
                    const originMs = this._timeOriginMsForVar(fileId, t);
                    return (value - originMs) / (stepSeconds * 1000);
                }
                return value / stepSeconds;
            };
            const rowValues = values.map(displayToRow);
            if (rowValues.every(Number.isFinite)) {
                const sourceValues = rowValues.map(row => {
                    const clamped = Math.max(0, Math.min(totalRows - 1, row));
                    return dataStart + (clamped / (totalRows - 1)) * (dataEnd - dataStart);
                });
                return sourceValues;
            }
        }
        if (Number.isFinite(dataStart) && Number.isFinite(dataEnd) && dataEnd >= dataStart) {
            return [dataStart, dataEnd];
        }
        return values;
    }

    if (this._isElapsedTimeForVar(fileId, t)) {
        const originMs = this._timeOriginMsForVar(fileId, t);
        return values.map(value => originMs + value * 1000);
    }
    return values;
};

proto._isElapsedTime = function(fileId) {
    const mode = this._timeDisplayMode(fileId);
    return mode === 'elapsedDateTime' || mode === 'elapsedSeconds';
};

proto._isElapsedTimeForVar = function(fileId, timeVar = null) {
    const mode = this._timeDisplayModeForVar(fileId, timeVar);
    return mode === 'elapsedDateTime' || mode === 'elapsedSeconds';
};

proto._plotlyTimeValue = function(fileId, value, timeVar = null) {
    if (this._timeDisplayModeForVar(fileId, timeVar) !== 'calendar') return value;
    if (!Number.isFinite(value)) return value;
    if (this._isHighResolutionGeneratedCalendarTime(fileId, timeVar)) return value;
    return new Date(value).toISOString();
};

proto._plotlyTimeArray = function(fileId, values, timeVar = null) {
    if (this._timeDisplayModeForVar(fileId, timeVar) !== 'calendar') return values;
    return Array.from(values || [], value => this._plotlyTimeValue(fileId, value, timeVar));
};

proto._elapsedDateTimeAxisConfig = function(rangeOrValues, fileId = null) {
    const extent = finiteAxisExtent(rangeOrValues);
    if (!extent) return {};
    let { min, max } = extent;
    if (min > max) [min, max] = [max, min];
    if (min === max) {
        min -= 1;
        max += 1;
    }
    const tickvals = this._durationTickValues(min, max);
    return {
        type: 'linear',
        tickmode: 'array',
        tickvals,
        ticktext: tickvals.map(value => this._formatElapsedDateTime(value, this._durationFractionDigits(fileId))),
    };
};

proto._highResolutionCalendarAxisConfig = function(fileId, timeVar = null, rangeOrValues = null) {
    const extent = finiteAxisExtent(rangeOrValues);
    if (!extent) return { type: 'linear' };
    let { min, max } = extent;
    if (min > max) [min, max] = [max, min];
    if (min === max) {
        min -= 1;
        max += 1;
    }
    const spanSeconds = Math.max(max - min, 1e-9);
    const relativeTicks = this._durationTickValues(0, spanSeconds);
    const tickvals = relativeTicks.map(value => min + value);
    return {
        type: 'linear',
        tickmode: 'array',
        tickvals,
        ticktext: tickvals.map(value => this._formatGeneratedCalendarDateTime(fileId, value, timeVar)),
    };
};

proto._durationTickValues = function(min, max, maxTicks = 7) {
    const span = Math.max(Math.abs(max - min), 1e-9);
    const steps = [
        1e-9, 2e-9, 5e-9, 1e-8, 2e-8, 5e-8,
        1e-7, 2e-7, 5e-7, 1e-6, 2e-6, 5e-6,
        1e-5, 2e-5, 5e-5, 1e-4, 2e-4, 5e-4,
        0.001, 0.002, 0.005, 0.01, 0.02, 0.05,
        0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30,
        60, 120, 300, 600, 900, 1800,
        3600, 7200, 10800, 21600, 43200,
        86400, 172800, 604800, 1209600, 2592000, 7776000, 31536000,
    ];
    const step = steps.find(candidate => span / candidate <= maxTicks) || steps[steps.length - 1];
    const ticks = [];
    let value = Math.ceil(min / step) * step;
    const epsilon = step * 1e-9;
    while (value <= max + epsilon && ticks.length < 20) {
        ticks.push(Number(value.toPrecision(12)));
        value += step;
    }
    if (!ticks.length) ticks.push(min, max);
    return ticks;
};

proto._durationFractionDigits = function(fileId = null) {
    if (!fileId || !this._isGeneratedDurationTime(fileId)) return 3;
    const stepSeconds = this._indexTimeStepSeconds(fileId);
    if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) return 3;
    if (stepSeconds < 1e-6) return 9;
    if (stepSeconds < 1e-3) return 6;
    return 3;
};

proto._formatElapsedDateTime = function(value, fractionDigits = 3) {
    if (!Number.isFinite(value)) return this._formatHTMLNumber(value);
    const sign = value < 0 ? '-' : '';
    const digits = Math.max(0, Math.min(9, Number.isFinite(Number(fractionDigits)) ? Math.trunc(Number(fractionDigits)) : 3));
    const scale = 10 ** digits;
    let seconds = Math.round(Math.abs(value) * scale) / scale;
    const days = Math.floor(seconds / 86400);
    seconds -= days * 86400;
    const hours = Math.floor(seconds / 3600);
    seconds -= hours * 3600;
    const minutes = Math.floor(seconds / 60);
    seconds -= minutes * 60;
    const wholeSeconds = Math.floor(seconds);
    let fractionInt = Math.round((seconds - wholeSeconds) * scale);
    const pad = n => String(n).padStart(2, '0');
    const secText = digits > 0 && fractionInt > 0
        ? `${pad(wholeSeconds)}.${String(fractionInt).padStart(digits, '0')}`
        : pad(wholeSeconds);
    const timeText = `${pad(hours)}:${pad(minutes)}:${secText}`;
    return `${sign}${days ? `${days} d ` : ''}${timeText}`;
};

proto._parseTimeBoundary = function(fileId, value) {
    if (value === '' || value === null || value === undefined) return null;
    if (this._isCalendarTime(fileId)) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const ms = Date.parse(String(value));
        if (this._isHighResolutionGeneratedCalendarTime(fileId)) {
            return Number.isFinite(ms) ? (ms - this._timeOriginMsForVar(fileId)) / 1000 : null;
        }
        return Number.isFinite(ms) ? ms : null;
    }
    if (this._timeDisplayMode(fileId) === 'elapsedDateTime' || this._timeDisplayMode(fileId) === 'elapsedSeconds') {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const ms = this._parseDurationMs(value);
        return Number.isFinite(ms) ? ms / 1000 : null;
    }
    if (this._isGeneratedDurationTime(fileId)) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const ms = this._parseDurationMs(value);
        return Number.isFinite(ms) ? ms / 1000 : null;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
};

proto._parseDurationMs = function(value) {
    if (value === '' || value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const raw = String(value).trim();
    if (!raw) return 0;
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) return numeric;
    const clockMatch = raw.match(/^([+-])?\s*(?:(\d+(?:\.\d+)?)\s*d(?:ays?)?\s*)?(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/i);
    if (clockMatch) {
        const sign = clockMatch[1] === '-' ? -1 : 1;
        const days = Number(clockMatch[2] || 0);
        const hours = Number(clockMatch[3]);
        const minutes = Number(clockMatch[4]);
        const seconds = Number(clockMatch[5] || 0);
        if ([days, hours, minutes, seconds].every(Number.isFinite)) {
            return sign * (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
        }
    }
    const match = raw.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(ps|picoseconds?|ns|nanoseconds?|us|microseconds?|ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|day|days|y|yr|yrs|year|years|w|week|weeks)?$/i);
    if (!match) return 0;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return 0;
    const unit = (match[2] || 'ms').toLowerCase();
    if (unit.startsWith('p')) return amount / 1e9;
    if (unit.startsWith('n')) return amount / 1e6;
    if (unit === 'us' || unit.startsWith('micro')) return amount / 1000;
    if (unit.startsWith('y')) return amount * 365.25 * 24 * 60 * 60 * 1000;
    if (unit.startsWith('w')) return amount * 7 * 24 * 60 * 60 * 1000;
    if (unit.startsWith('d')) return amount * 24 * 60 * 60 * 1000;
    if (unit.startsWith('h')) return amount * 60 * 60 * 1000;
    if (unit === 'm' || unit.startsWith('min')) return amount * 60 * 1000;
    if (unit.startsWith('s')) return amount * 1000;
    return amount;
};

proto._parseTimeShift = function(fileId, value) {
    if (this._isHighResolutionGeneratedCalendarTime(fileId)) return this._parseDurationMs(value) / 1000;
    if (this._isCalendarTime(fileId)) return this._parseDurationMs(value);
    if (this._timeDisplayMode(fileId) === 'elapsedDateTime' || this._timeDisplayMode(fileId) === 'elapsedSeconds' || this._isGeneratedDurationTime(fileId)) {
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        return this._parseDurationMs(value) / 1000;
    }
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
};

proto._timeAxisTitle = function(fileId, fallback = 'Time') {
    const timeVar = this._getTimeVar(fileId);
    return this._timeAxisTitleForVar(fileId, timeVar, fallback);
};

proto._timeAxisTitleForVar = function(fileId, timeVar = null, fallback = 'Time', effectiveDisplay = null) {
    const name = timeVar?.name || fallback;
    if (timeVar?.timeSourceStrategy === 'index-column') return name;
    // A mixed panel resolves duration + seconds ⇒ seconds (consensus). When the
    // shared axis is downgraded to seconds the title must drop the primary's
    // duration (hh:mm:ss) caption so title, ticks and hover stay in agreement.
    const forceSeconds = effectiveDisplay === 'seconds';
    if (this._isGeneratedIndexTime(fileId, timeVar)) {
        // The per-file Δt (the "step") is deliberately left OUT of the axis title:
        // the title labels a shared axis, and overlaying two reindexed traces with
        // different steps would make any single Δt caption misleading.
        const mode = this._indexTimeStepMode(fileId);
        if (mode !== 'index' && this._isGeneratedCalendarTime(fileId, timeVar)) {
            return 'datetime';
        }
        if (mode !== 'index' && (forceSeconds || this._isGeneratedSecondsTime(fileId, timeVar))) {
            return 'seconds';
        }
        return mode === 'index' ? 'index' : 'duration [hh:mm:ss]';
    }
    const mode = this._timeDisplayModeForVar(fileId, timeVar);
    if (mode === 'calendar') return `${name} [datetime, ${this._calendarTimeFormat(fileId, timeVar) === 'ampm' ? 'AM/PM' : '24h'}]`;
    if (mode === 'elapsedDateTime' && timeVar?.timeKind === 'datetime') {
        return forceSeconds ? `${name} elapsed [s]` : `${name} elapsed [d hh:mm:ss]`;
    }
    if (mode === 'elapsedSeconds' && timeVar?.timeKind === 'datetime') {
        return `${name} elapsed [s]`;
    }
    if (!forceSeconds && this._isNumericDurationAxis(fileId, timeVar)) return `${name} [d hh:mm:ss]`;
    const unit = (mode === 'elapsedSeconds' || forceSeconds) ? 's' : (timeVar ? this._extractUnit(timeVar.description) : 's');
    return unit ? `${name} [${unit}]` : name;
};

proto._timeUnitLabel = function(fileId) {
    return this._timeAxisModel(fileId).unit;
};

proto._calendarFractionDigits = function(fileId) {
    if (!this._isHighResolutionGeneratedCalendarTime(fileId)) return 3;
    const stepSeconds = this._indexTimeStepSeconds(fileId);
    if (stepSeconds < 1e-6) return 9;
    if (stepSeconds < 1e-3) return 6;
    return 3;
};

proto._formatCalendarDateTime = function(fileId, value, timeVar = null, calendarTimeFormat = null) {
    if (!Number.isFinite(value)) return this._formatHTMLNumber(value);
    const digits = this._calendarFractionDigits(fileId);
    let secondMs = Math.floor(value / 1000) * 1000;
    let fraction = (value - secondMs) / 1000;
    const scale = 10 ** digits;
    let fractionInt = Math.round(fraction * scale);
    if (fractionInt >= scale) {
        secondMs += 1000;
        fractionInt = 0;
    }
    const d = new Date(secondMs);
    if (!Number.isFinite(d.getTime())) return this._formatHTMLNumber(value);
    const pad2 = n => String(n).padStart(2, '0');
    const year = d.getUTCFullYear();
    const month = pad2(d.getUTCMonth() + 1);
    const day = pad2(d.getUTCDate());
    const minute = pad2(d.getUTCMinutes());
    const second = pad2(d.getUTCSeconds());
    const fractionText = digits > 0 ? `.${String(fractionInt).padStart(digits, '0')}` : '';
    if ((calendarTimeFormat || this._calendarTimeFormat(fileId, timeVar)) === 'ampm') {
        const h24 = d.getUTCHours();
        const suffix = h24 >= 12 ? 'PM' : 'AM';
        const h12 = h24 % 12 || 12;
        return `${year}-${month}-${day} ${h12}:${minute}:${second}${fractionText} ${suffix} UTC`;
    }
    return `${year}-${month}-${day} ${pad2(d.getUTCHours())}:${minute}:${second}${fractionText} UTC`;
};

proto._formatGeneratedCalendarDateTime = function(fileId, value, timeVar = null, calendarTimeFormat = null) {
    if (!this._isHighResolutionGeneratedCalendarTime(fileId, timeVar)) {
        return this._formatCalendarDateTime(fileId, value, timeVar, calendarTimeFormat);
    }
    if (!Number.isFinite(value)) return this._formatHTMLNumber(value);
    const originMs = this._timeOriginMsForVar(fileId, timeVar);
    const baseSecondMs = Math.floor(originMs / 1000) * 1000;
    let offsetSeconds = ((originMs - baseSecondMs) / 1000) + value;
    let wholeOffsetSeconds = Math.floor(offsetSeconds);
    let fractional = offsetSeconds - wholeOffsetSeconds;
    const digits = this._calendarFractionDigits(fileId);
    const scale = 10 ** digits;
    let fractionInt = Math.round(fractional * scale);
    if (fractionInt >= scale) {
        wholeOffsetSeconds += 1;
        fractionInt = 0;
    }
    const d = new Date(baseSecondMs + wholeOffsetSeconds * 1000);
    if (!Number.isFinite(d.getTime())) return this._formatHTMLNumber(value);
    const pad2 = n => String(n).padStart(2, '0');
    const year = d.getUTCFullYear();
    const month = pad2(d.getUTCMonth() + 1);
    const day = pad2(d.getUTCDate());
    const minute = pad2(d.getUTCMinutes());
    const second = pad2(d.getUTCSeconds());
    const fractionText = digits > 0 ? `.${String(fractionInt).padStart(digits, '0')}` : '';
    if ((calendarTimeFormat || this._calendarTimeFormat(fileId, timeVar)) === 'ampm') {
        const h24 = d.getUTCHours();
        const suffix = h24 >= 12 ? 'PM' : 'AM';
        const h12 = h24 % 12 || 12;
        return `${year}-${month}-${day} ${h12}:${minute}:${second}${fractionText} ${suffix} UTC`;
    }
    return `${year}-${month}-${day} ${pad2(d.getUTCHours())}:${minute}:${second}${fractionText} UTC`;
};

proto._formatTimeValue = function(fileId, value) {
    if (!Number.isFinite(value)) return this._formatHTMLNumber(value);
    if (this._isGeneratedCalendarTime(fileId)) return this._formatGeneratedCalendarDateTime(fileId, value);
    if (this._isGeneratedDurationTime(fileId)) return this._formatElapsedDateTime(value, this._durationFractionDigits(fileId));
    if (this._timeDisplayMode(fileId) === 'elapsedDateTime') return this._formatElapsedDateTime(value);
    if (!this._isCalendarTime(fileId)) return this._formatHTMLNumber(value);
    const d = new Date(value);
    if (!Number.isFinite(d.getTime())) return this._formatHTMLNumber(value);
    const pad2 = n => String(n).padStart(2, '0');
    const year = d.getUTCFullYear();
    const month = pad2(d.getUTCMonth() + 1);
    const day = pad2(d.getUTCDate());
    const minute = pad2(d.getUTCMinutes());
    const second = pad2(d.getUTCSeconds());
    if (this._calendarTimeFormat(fileId) === 'ampm') {
        const h24 = d.getUTCHours();
        const suffix = h24 >= 12 ? 'PM' : 'AM';
        const h12 = h24 % 12 || 12;
        return `${year}-${month}-${day} ${h12}:${minute}:${second} ${suffix} UTC`;
    }
    return `${year}-${month}-${day} ${pad2(d.getUTCHours())}:${minute}:${second} UTC`;
};

proto._formatTimeForExport = function(fileId, value) {
    if (!Number.isFinite(value)) return value;
    if (this._isGeneratedCalendarTime(fileId)) return this._formatGeneratedCalendarDateTime(fileId, value);
    if (this._isGeneratedDurationTime(fileId)) return this._formatElapsedDateTime(value, this._durationFractionDigits(fileId));
    if (this._timeDisplayMode(fileId) === 'elapsedDateTime') return this._formatElapsedDateTime(value);
    if (!this._isCalendarTime(fileId)) return value;
    return new Date(value).toISOString();
};

proto._formatTimeColumnForExport = function(fileId, values) {
    return Array.from(values || [], value => this._formatTimeForExport(fileId, value));
};

proto._formatDuration = function(value, unit = 's') {
    if (!Number.isFinite(value)) return this._formatHTMLNumber(value);
    let seconds = value;
    const normalized = String(unit || '').trim().toLowerCase();
    if (normalized === 'datetime' || normalized === 'ms' || normalized.startsWith('millisecond')) seconds = value / 1000;
    const sign = seconds < 0 ? '-' : '';
    seconds = Math.abs(seconds);
    const days = Math.floor(seconds / 86400);
    seconds -= days * 86400;
    const hours = Math.floor(seconds / 3600);
    seconds -= hours * 3600;
    const minutes = Math.floor(seconds / 60);
    seconds -= minutes * 60;
    const parts = [];
    if (days) parts.push(`${days} d`);
    if (hours) parts.push(`${hours} h`);
    if (minutes) parts.push(`${minutes} min`);
    if (seconds || !parts.length) parts.push(`${Number(seconds.toFixed(6))} s`);
    return sign + parts.join(' ');
};

proto._primaryTimeFileId = function(plot) {
    if (!plot) return this.activeFileId;
    if (plot.mode === 'timeseries') return plot.traces?.[0]?.fileId || this.activeFileId;
    if (plot.mode === 'fft') return plot.traces?.[0]?.fileId || this.activeFileId;
    if (plot.mode === 'histogram') return plot.traces?.[0]?.fileId || this.activeFileId;
    if (plot.mode === 'heatmap') return plot.traces?.[0]?.fileId || this.activeFileId;
    if (plot.mode === 'temporal-profile') return plot.traces?.[0]?.fileId || this.activeFileId;
    if (plot.mode === 'phase2d' || plot.mode === 'phase2dt' || plot.mode === 'phase3d') {
        return plot.phaseTraces?.[0]?.fileId || this.activeFileId;
    }
    if (plot.mode === 'state-anim') return plot.stateSlots?.fileId || this.activeFileId;
    return this.activeFileId;
};

proto._mapTimeValueBetweenFiles = function(sourceFileId, targetFileId, xValue) {
    if (!Number.isFinite(xValue)) return NaN;
    if (!sourceFileId || !targetFileId || sourceFileId === targetFileId) return xValue;

    const sourceMode = this._timeDisplayMode(sourceFileId);
    const targetMode = this._timeDisplayMode(targetFileId);
    if (sourceMode === targetMode) return xValue;
    if ((sourceMode === 'elapsedDateTime' || sourceMode === 'elapsedSeconds')
        && (targetMode === 'elapsedDateTime' || targetMode === 'elapsedSeconds')) return xValue;

    const sourceKind = this._timeKind(sourceFileId);
    const targetKind = this._timeKind(targetFileId);
    if (sourceKind !== 'datetime' || targetKind !== 'datetime') return NaN;

    const sourceOrigin = this._timeOriginMs(sourceFileId);
    const targetOrigin = this._timeOriginMs(targetFileId);
    if (sourceMode === 'calendar' && (targetMode === 'elapsedDateTime' || targetMode === 'elapsedSeconds')) return (xValue - targetOrigin) / 1000;
    if ((sourceMode === 'elapsedDateTime' || sourceMode === 'elapsedSeconds') && targetMode === 'calendar') return sourceOrigin + xValue * 1000;
    return NaN;
};

proto._getTransformIndexData = function(fileId) {
    const cache = this._transformCache(fileId);
    if (cache?.indexData) return cache.indexData;

    const timeVar = this._getTimeVar(fileId);
    const rawTimes = timeVar?.data || [];
    const transform = this._fileTransform(fileId);
    const generatedIndex = this._isGeneratedIndexTime(fileId, timeVar);
    const generatedFromDetectedTime = this._isGeneratedFromDetectedTime(fileId, timeVar);
    const cropStart = this._parseTimeBoundary(fileId, transform.cropStart);
    const cropEnd = this._parseTimeBoundary(fileId, transform.cropEnd);
    const timeShift = this._parseTimeShift(fileId, transform.timeShift);
    const cropped = cropStart !== null || cropEnd !== null;

    let result;
    if (!rawTimes.length) {
        result = { indexes: null, times: [] };
    } else if (timeShift === 0 && !cropped && !this._isElapsedTimeForVar(fileId, timeVar) && !generatedIndex) {
        result = { indexes: null, times: rawTimes };
    } else {
        let lo = cropStart ?? -Infinity;
        let hi = cropEnd ?? Infinity;
        if (lo > hi) [lo, hi] = [hi, lo];

        const indexes = [];
        const times = [];
        const generatedCalendar = generatedIndex && this._isGeneratedCalendarTime(fileId, timeVar);
        const highResolutionCalendar = generatedCalendar && this._isHighResolutionGeneratedCalendarTime(fileId, timeVar);
        const generatedCalendarOrigin = generatedCalendar ? this._timeOriginMsForVar(fileId, timeVar) : 0;
        const generatedStepMode = generatedIndex ? this._indexTimeStepMode(fileId) : null;
        const generatedStepSeconds = generatedIndex ? this._indexTimeStepSeconds(fileId) : 0;
        for (let i = 0; i < rawTimes.length; i++) {
            const rawTime = rawTimes[i];
            // Row that drives a generated index: a DETECTED datetime axis can be
            // irregular/downsampled, so map source time → approximate row; a numeric
            // or native-index axis uses the loop counter directly (its raw value is
            // seconds, not a row, so it must NOT be fed to the index formatter).
            const generatedRow = generatedFromDetectedTime && timeVar?.timeKind === 'datetime'
                ? this._approxRowIndexFromSourceTime(fileId, rawTime, i)
                : i;
            const displayTime = generatedIndex
                ? (generatedStepMode === 'index'
                    ? generatedRow
                    : generatedCalendar
                        ? (highResolutionCalendar
                            ? generatedRow * generatedStepSeconds
                            : generatedCalendarOrigin + generatedRow * generatedStepSeconds * 1000)
                        : generatedRow * generatedStepSeconds)
                : this._timeDisplayValueForVar(fileId, rawTime, timeVar);
            if (!cropped || (displayTime >= lo && displayTime <= hi)) {
                indexes.push(i);
                times.push(displayTime + timeShift);
            }
        }
        result = { indexes: (cropped || this._isElapsedTimeForVar(fileId, timeVar) || generatedIndex) ? indexes : null, times };
    }

    if (cache) cache.indexData = result;
    return result;
};

proto._getTransformedTimeData = function(fileId = this.activeFileId) {
    return this._getTransformIndexData(fileId).times;
};

proto._getTransformIndexDataForVariable = function(fileId, varName) {
    const base = this._getTransformIndexData(fileId);
    const variable = this.files.get(fileId)?.data?.variables?.[varName];
    if (!variable?.independentIndex || variable.kind === 'parameter') return base;
    const length = Math.max(0, Number(variable.data?.length) || 0);
    if (!base.indexes) return { indexes: null, times: base.times.slice(0, length) };
    const indexes = [];
    const times = [];
    for (let position = 0; position < base.indexes.length; position++) {
        const sourceIndex = base.indexes[position];
        if (sourceIndex >= length) continue;
        indexes.push(sourceIndex);
        times.push(base.times[position]);
    }
    return { indexes, times };
};

proto._getTransformedTimeDataForVariable = function(fileId, varName) {
    return this._getTransformIndexDataForVariable(fileId, varName).times;
};

proto._getTransformedVariableData = function(fileId, varName, options = {}) {
    const includeYOffset = options.includeYOffset !== false;
    const d = this.files.get(fileId)?.data;
    const variable = d?.variables?.[varName];
    if (!variable) return [];
    if (variable.kind === 'abscissa') return this._getTransformedTimeData(fileId);

    const transform = this._fileTransform(fileId);
    const sign = this.isVariableSignInverted?.(fileId, varName) ? -1 : 1;
    const gain = transform.gain * sign;
    const yOffset = includeYOffset ? transform.yOffset : 0;
    const indexData = this._getTransformIndexDataForVariable(fileId, varName);
    const cache = this._transformCache(fileId);
    const cacheKey = `${varName}\u0000${includeYOffset ? 'y' : 'n'}\u0000${gain}`;
    if (cache?.series.has(cacheKey)) return cache.series.get(cacheKey);

    const transformValue = (value) => Number.isFinite(value) ? value * gain + yOffset : value;

    let values;
    if (variable.kind === 'parameter') {
        const base = Number(variable.data?.[0]);
        const value = transformValue(base);
        const n = Math.max(1, indexData.times.length);
        values = new Array(n).fill(value);
    } else if (!indexData.indexes && gain === 1 && yOffset === 0) {
        values = variable.data;
    } else if (!indexData.indexes) {
        values = variable.data.map(transformValue);
    } else {
        values = indexData.indexes.map(i => transformValue(variable.data[i]));
    }

    if (cache) cache.series.set(cacheKey, values);
    return values;
};

proto._pickIndexed = function(values, indexes) {
    if (!Array.isArray(indexes) || !indexes.length) return values;
    const picked = new Array(indexes.length);
    for (let i = 0; i < indexes.length; i++) picked[i] = values[indexes[i]];
    return picked;
};

proto._downsampleStrideIndexes = function(length, target) {
    if (!Number.isFinite(length) || length <= 0) return [];
    if (target == null || length <= target) return Array.from({ length }, (_, i) => i);
    const last = length - 1;
    const indexes = [0];
    const innerTarget = Math.max(0, target - 2);
    for (let i = 1; i <= innerTarget; i++) {
        const idx = Math.round((i * last) / (innerTarget + 1));
        if (idx > indexes[indexes.length - 1] && idx < last) indexes.push(idx);
    }
    if (indexes[indexes.length - 1] !== last) indexes.push(last);
    return indexes;
};

proto._downsampleTimeseries = function(xValues, yValues, target = PlotManager.VISUAL_MAX_POINTS_TIMESERIES) {
    const n = Math.min(xValues?.length || 0, yValues?.length || 0);
    if (n <= target || n <= 2) return { x: xValues, y: yValues };

    const bucketCount = Math.max(1, Math.floor((target - 2) / 2));
    const bucketSize = Math.max(1, Math.ceil((n - 2) / bucketCount));
    const indexes = [0];

    for (let start = 1; start < n - 1; start += bucketSize) {
        const end = Math.min(n - 1, start + bucketSize);
        let minIdx = start;
        let maxIdx = start;
        let minVal = yValues[start];
        let maxVal = yValues[start];

        for (let i = start + 1; i < end; i++) {
            const value = yValues[i];
            if (!Number.isFinite(value)) continue;
            if (!Number.isFinite(minVal) || value < minVal) { minVal = value; minIdx = i; }
            if (!Number.isFinite(maxVal) || value > maxVal) { maxVal = value; maxIdx = i; }
        }

        if (minIdx === maxIdx) {
            if (minIdx > indexes[indexes.length - 1]) indexes.push(minIdx);
        } else if (minIdx < maxIdx) {
            if (minIdx > indexes[indexes.length - 1]) indexes.push(minIdx);
            if (maxIdx > indexes[indexes.length - 1]) indexes.push(maxIdx);
        } else {
            if (maxIdx > indexes[indexes.length - 1]) indexes.push(maxIdx);
            if (minIdx > indexes[indexes.length - 1]) indexes.push(minIdx);
        }
    }

    if (indexes[indexes.length - 1] !== n - 1) indexes.push(n - 1);
    return {
        x: this._pickIndexed(xValues, indexes),
        y: this._pickIndexed(yValues, indexes),
    };
};

proto._lowerBound = function(sortedValues, target) {
    let lo = 0;
    let hi = sortedValues.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedValues[mid] < target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
};

proto._upperBound = function(sortedValues, target) {
    let lo = 0;
    let hi = sortedValues.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sortedValues[mid] <= target) lo = mid + 1;
        else hi = mid;
    }
    return lo;
};

proto._buildTimeseriesVisualData = function(timeData, values, visibleRange = null, isStep = false) {
    const n = Math.min(timeData?.length || 0, values?.length || 0);
    if (n <= 0) return { x: timeData || [], y: values || [] };
    const target = this.timeseriesVisualMaxPoints;
    if (target == null) return { x: timeData, y: values };
    if (isStep || !visibleRange || visibleRange[0] == null || visibleRange[1] == null) {
        return isStep ? { x: timeData, y: values } : this._downsampleTimeseries(timeData, values, target);
    }

    let [minX, maxX] = visibleRange.map(value => {
        if (typeof this._coerceAxisValue === 'function') return this._coerceAxisValue(value);
        const numeric = Number(value);
        if (Number.isFinite(numeric)) return numeric;
        const text = String(value).trim();
        const floatingIso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?$/);
        if (floatingIso) {
            const [, year, month, day, hour = '0', minute = '0', second = '0', fraction = '0'] = floatingIso;
            const msPart = Number(String(fraction).padEnd(3, '0').slice(0, 3));
            return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), msPart);
        }
        const ms = Date.parse(text);
        return Number.isFinite(ms) ? ms : NaN;
    });
    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return this._downsampleTimeseries(timeData, values, target);
    if (minX > maxX) [minX, maxX] = [maxX, minX];
    let start = this._lowerBound(timeData, minX);
    let end = this._upperBound(timeData, maxX);
    start = Math.max(0, start - 1);
    end = Math.min(n, end + 1);
    if (end - start <= 0) return { x: timeData, y: values };

    const sliceX = timeData.slice(start, end);
    const sliceY = values.slice(start, end);
    if (sliceX.length <= target) {
        return { x: sliceX, y: sliceY };
    }
    return this._downsampleTimeseries(sliceX, sliceY, target);
};

proto._buildPhaseVisualSeries = function(seriesList) {
    const target = this.phaseVisualMaxPoints;
    if (target == null) return seriesList;
    const length = Math.min(...seriesList.map(series => series?.length || 0));
    if (!Number.isFinite(length) || length <= 0 || length <= target) return seriesList;
    const indexes = this._downsampleStrideIndexes(length, target);
    return seriesList.map(series => this._pickIndexed(series, indexes));
};

proto._isLazyPhaseFile = function(fileId) {
    return !!this.files.get(fileId)?.data?._duckdb;
};

proto._phaseTraceVariables = function(plot, pt) {
    if (!pt) return [];
    if (plot?.mode === 'phase3d') return [pt.x, pt.y, pt.z].filter(Boolean);
    return [pt.x, pt.y].filter(Boolean);
};

proto._phaseTargetInfo = function() {
    const configured = this.phaseVisualMaxPoints;
    if (Number.isFinite(configured) && configured > 0) {
        return { limit: Math.max(2, Math.round(configured)), capped: false };
    }
    const max = typeof this._maxPhaseDownsamplingMenuLimit === 'function'
        ? this._maxPhaseDownsamplingMenuLimit()
        : PlotManager.MAX_MENU_VISUAL_POINTS;
    return { limit: Math.max(2, max), capped: true };
};

proto._phaseTraceCacheKey = function(plot, pt, targetInfo = this._phaseTargetInfo()) {
    const fileId = pt?.fileId;
    const entry = this.files.get(fileId);
    const meta = entry?.data?._duckdb;
    const vars = this._phaseTraceVariables(plot, pt).join('\u001f');
    const transform = this._normalizeFileTransform(entry?.transform);
    const version = [
        Number(meta?.appendRows) || 0,
        Number(meta?.appendBytes) || 0,
        Number(meta?.totalRows) || '',
    ].join('\u001f');
    return [
        plot?.mode || '',
        fileId || '',
        vars,
        targetInfo.limit,
        targetInfo.capped ? 'capped' : 'exact',
        JSON.stringify(transform),
        version,
    ].join('\u001e');
};

proto._phaseCachedTrajectory = function(plot, pt, targetInfo = this._phaseTargetInfo()) {
    if (!this._isLazyPhaseFile(pt?.fileId)) return null;
    const key = this._phaseTraceCacheKey(plot, pt, targetInfo);
    const cached = pt?._lazyPhaseCache;
    return cached?.key === key ? cached : null;
};

proto._phaseVisualDataForTrace = function(plot, pt, targetInfo = this._phaseTargetInfo()) {
    const d = this.files.get(pt.fileId)?.data;
    if (!d) return null;
    const vars = this._phaseTraceVariables(plot, pt);
    if (!vars.every(name => d.variables?.[name])) return null;

    if (this._isLazyPhaseFile(pt.fileId)) {
        const cached = this._phaseCachedTrajectory(plot, pt, targetInfo);
        if (!cached) {
            const empty = new Float64Array(0);
            return plot.mode === 'phase3d'
                ? { time: empty, x: empty, y: empty, z: empty, lazyPending: true }
                : { time: empty, x: empty, y: empty, lazyPending: true };
        }
        return cached.visual;
    }

    if (plot.mode === 'phase2dt') {
        const timeVar = this._getTimeVar(pt.fileId);
        const [time, x, y] = this._buildPhaseVisualSeries([
            timeVar ? this._getTransformedTimeDataForVariable(pt.fileId, pt.x) : [],
            this._getTransformedVariableData(pt.fileId, pt.x),
            this._getTransformedVariableData(pt.fileId, pt.y),
        ]);
        return { time, x, y };
    }
    if (plot.mode === 'phase3d') {
        const [x, y, z] = this._buildPhaseVisualSeries([
            this._getTransformedVariableData(pt.fileId, pt.x),
            this._getTransformedVariableData(pt.fileId, pt.y),
            this._getTransformedVariableData(pt.fileId, pt.z),
        ]);
        return { x, y, z };
    }
    const [x, y] = this._buildPhaseVisualSeries([
        this._getTransformedVariableData(pt.fileId, pt.x),
        this._getTransformedVariableData(pt.fileId, pt.y),
    ]);
    return { x, y };
};

proto._phaseSourceTimeRange = function(fileId) {
    const entry = this.files.get(fileId);
    if (!entry?.data?._duckdb) return null;
    const transform = this._fileTransform(fileId);
    if (transform.cropStart === null && transform.cropEnd === null) return null;
    const timeVar = this._getTimeVar(fileId);
    if (!timeVar) return null;
    if (this._isGeneratedIndexTime(fileId, timeVar)) return null;
    let lo = this._parseTimeBoundary(fileId, transform.cropStart);
    let hi = this._parseTimeBoundary(fileId, transform.cropEnd);
    if (lo === null && hi === null) return null;
    const dataStart = Number(entry.data.metadata?.timeStart);
    const dataEnd = Number(entry.data.metadata?.timeEnd);
    if (lo === null) lo = Number.isFinite(dataStart) ? dataStart : -Infinity;
    if (hi === null) hi = Number.isFinite(dataEnd) ? dataEnd : Infinity;
    if (this._isElapsedTimeForVar(fileId, timeVar)) {
        const originMs = this._timeOriginMsForVar(fileId, timeVar);
        lo = Number.isFinite(lo) ? originMs + lo * 1000 : lo;
        hi = Number.isFinite(hi) ? originMs + hi * 1000 : hi;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null;
    if (lo > hi) [lo, hi] = [hi, lo];
    return [lo, hi];
};

proto._transformFetchedPhaseTrajectory = function(fileId, rawTime, rowIndex, rawByVar, varNames) {
    const timeVar = this._getTimeVar(fileId);
    const transform = this._fileTransform(fileId);
    const generatedIndex = this._isGeneratedIndexTime(fileId, timeVar);
    const generatedFromDetectedTime = this._isGeneratedFromDetectedTime(fileId, timeVar);
    const cropStart = this._parseTimeBoundary(fileId, transform.cropStart);
    const cropEnd = this._parseTimeBoundary(fileId, transform.cropEnd);
    const timeShift = this._parseTimeShift(fileId, transform.timeShift);
    const cropped = cropStart !== null || cropEnd !== null;
    let lo = cropStart ?? -Infinity;
    let hi = cropEnd ?? Infinity;
    if (lo > hi) [lo, hi] = [hi, lo];

    const yOffset = transform.yOffset;
    const n = rawTime?.length || 0;
    // Preallocate typed arrays and fill by index (subarray at the end for any
    // dropped rows). Pushing into regular JS arrays and Float64Array.from-ing
    // afterwards holds ~3x the memory — enough to OOM the browser on a
    // multi-million-row lazy FFT fetch. `k` counts kept rows.
    const outTime = new Float64Array(n);
    const outCols = varNames.map(name => ({ name, src: rawByVar?.get(name) || null, dst: new Float64Array(n) }));
    let k = 0;
    const generatedCalendar = generatedFromDetectedTime && this._isGeneratedCalendarTime(fileId, timeVar);
    const highResolutionCalendar = generatedCalendar && this._isHighResolutionGeneratedCalendarTime(fileId, timeVar);
    const generatedCalendarOrigin = generatedCalendar ? this._timeOriginMsForVar(fileId, timeVar) : 0;
    for (let i = 0; i < n; i++) {
        const rn = Number(rowIndex?.[i]);
        const raw = Number(rawTime[i]);
        const displayTime = generatedFromDetectedTime
            ? (this._indexTimeStepMode(fileId) === 'index'
                ? rn
                : generatedCalendar
                    ? (highResolutionCalendar
                        ? rn * this._indexTimeStepSeconds(fileId)
                        : generatedCalendarOrigin + rn * this._indexTimeStepSeconds(fileId) * 1000)
                    : rn * this._indexTimeStepSeconds(fileId))
            : this._timeDisplayValueForVar(fileId, raw, timeVar);
        if (!Number.isFinite(displayTime)) continue;
        if (cropped && (displayTime < lo || displayTime > hi)) continue;
        outTime[k] = displayTime + timeShift;
        for (const col of outCols) {
            const value = col.src ? Number(col.src[i]) : NaN;
            const sign = this.isVariableSignInverted?.(fileId, col.name) ? -1 : 1;
            col.dst[k] = Number.isFinite(value) ? value * transform.gain * sign + yOffset : value;
        }
        k++;
    }
    const trim = (arr) => (k === n ? arr : arr.slice(0, k));
    return {
        time: trim(outTime),
        valuesByVar: new Map(outCols.map(col => [col.name, trim(col.dst)])),
    };
};

// ─── Trace / layout builders ───────────────────────────────────

proto._buildPlotData = function(plot) {
    switch (plot.mode) {
        case 'phase2d':    return { traces: this._buildPhase2DTraces(plot),  layout: this._buildPhase2DLayout(plot)  };
        case 'phase2dt':   return { traces: this._buildPhase2DtTraces(plot), layout: this._buildPhase3DLayout(plot, true)  };
        case 'phase3d':    return { traces: this._buildPhase3DTraces(plot),  layout: this._buildPhase3DLayout(plot, false) };
        case 'state-anim': return { traces: this._buildStateAnimTraces(plot), layout: this._buildStateAnimLayout(plot) };
        default: {
            const showMissing = plot.mode === 'timeseries' && plot.showMissingData;
            const missInfo = showMissing ? this._missingDataInfo(plot) : null;
            const traces = plot.traces
                .map((t, idx) => {
                    const built = this._buildTimeTrace(t, null, plot, idx, showMissing ? { attachSourceX: true } : {});
                    if (built && showMissing) this._applyLineBreaks(built, missInfo.traceIntervals.get(this._missTraceKey(t)));
                    return built;
                })
                .filter(Boolean);
            return { traces, layout: this._buildTimeLayout(plot) };
        }
    }
};

// ── Timeseries ──
proto._timeseriesStackAttrs = function(plot, traceIndex = 0) {
    if (!plot?.timeseriesStacked || plot?.timeseriesY2Enabled) return {};
    return {
        stackgroup: 'timeseries-stack',
        // Each trace is min/max-downsampled independently, so their rendered
        // x coordinates do not necessarily match. Inferring zero at the other
        // traces' x positions creates false vertical drops in oscillatory
        // signals. Interpolation preserves the continuous stacked envelope;
        // explicit zero-padding below still handles genuinely disjoint support.
        stackgaps: 'interpolate',
        fill: traceIndex === 0 ? 'tozeroy' : 'tonexty',
    };
};

proto._traceYAxis = function(traceState, plot = null) {
    return plot?.timeseriesY2Enabled && traceState?.axis === 'y2' ? 'y2' : 'y';
};

proto._timeseriesTraceSupport = function(traceState) {
    if (!traceState) return null;
    const timeData = this._getTransformedTimeDataForVariable(traceState.fileId, traceState.varName);
    const values = this._getTransformedVariableData(traceState.fileId, traceState.varName);
    const n = Math.min(timeData?.length || 0, values?.length || 0);
    if (!n) return null;

    const hasFinitePoint = (index) =>
        Number.isFinite(Number(timeData[index])) && Number.isFinite(Number(values[index]));
    let first = -1;
    let last = -1;
    for (let i = 0; i < n; i++) {
        if (hasFinitePoint(i)) {
            first = i;
            break;
        }
    }
    for (let i = n - 1; i >= 0; i--) {
        if (hasFinitePoint(i)) {
            last = i;
            break;
        }
    }
    if (first < 0 || last < 0) return null;
    return {
        startX: Number(timeData[first]),
        endX: Number(timeData[last]),
        startY: Number(values[first]),
        endY: Number(values[last]),
    };
};

proto._timeseriesStackPaddingEpsilon = function(boundaries, visual) {
    const values = [];
    for (const value of boundaries || []) {
        const n = Number(value);
        if (Number.isFinite(n)) values.push(n);
    }
    for (const value of visual?.x || []) {
        const n = Number(value);
        if (Number.isFinite(n)) values.push(n);
    }
    if (!values.length) return 1e-9;
    values.sort((a, b) => a - b);
    let minGap = Infinity;
    for (let i = 1; i < values.length; i++) {
        const gap = values[i] - values[i - 1];
        if (gap > 0 && gap < minGap) minGap = gap;
    }
    const span = values[values.length - 1] - values[0];
    const scale = Number.isFinite(minGap) ? minGap : (span > 0 ? span : Math.max(1, Math.abs(values[0])));
    const ulpGuard = Number.EPSILON * Math.max(1, Math.abs(values[0]), Math.abs(values[values.length - 1])) * 16;
    return Math.max(scale * 1e-9, ulpGuard, 1e-12);
};

proto._timeseriesStackBoundaryTimes = function(plot) {
    if (!plot?.timeseriesStacked) return [];
    const boundaries = new Set();
    for (const trace of plot.traces || []) {
        if (!this._isVisible(trace)) continue;
        const support = this._timeseriesTraceSupport(trace);
        if (!support) continue;
        boundaries.add(support.startX);
        boundaries.add(support.endX);
    }
    return [...boundaries].filter(Number.isFinite).sort((a, b) => a - b);
};

proto._applyTimeseriesStackZeroPadding = function(plot, traceState, visual) {
    if (!plot?.timeseriesStacked || !visual?.x?.length || !visual?.y?.length) return visual;
    const support = this._timeseriesTraceSupport(traceState);
    if (!support) return visual;
    const boundaries = this._timeseriesStackBoundaryTimes(plot);
    if (!boundaries.length) return visual;
    const epsilon = this._timeseriesStackPaddingEpsilon(boundaries, visual);

    const points = [];
    const addPoint = (x, y, order = 1) => {
        const xn = Number(x);
        const yn = Number(y);
        if (!Number.isFinite(xn) || !Number.isFinite(yn)) return;
        points.push({ x: xn, y: yn, order });
    };

    for (let i = 0; i < Math.min(visual.x.length, visual.y.length); i++) {
        addPoint(visual.x[i], visual.y[i], 1);
    }

    addPoint(support.startX, support.startY, 1);
    addPoint(support.endX, support.endY, 1);

    const previousBoundary = [...boundaries].reverse().find(x => x < support.startX);
    const nextBoundary = boundaries.find(x => x > support.endX);
    const supportSpan = support.endX - support.startX;
    const boundedOffset = (neighborGap) => {
        const limits = [epsilon];
        if (Number.isFinite(neighborGap) && neighborGap > 0) limits.push(neighborGap / 4);
        if (Number.isFinite(supportSpan) && supportSpan > 0) limits.push(supportSpan / 4);
        return Math.max(0, Math.min(...limits.filter(value => Number.isFinite(value) && value > 0)));
    };

    if (Number.isFinite(previousBoundary)) {
        const offset = boundedOffset(support.startX - previousBoundary);
        addPoint(support.startX - offset, 0, 0);
    }
    if (Number.isFinite(nextBoundary)) {
        const offset = boundedOffset(nextBoundary - support.endX);
        addPoint(support.endX + offset, 0, 2);
    }

    for (const x of boundaries) {
        if (x < support.startX || x > support.endX) addPoint(x, 0, 1);
    }

    points.sort((a, b) => (a.x - b.x) || (a.order - b.order));

    const outX = [];
    const outY = [];
    for (const point of points) {
        const last = outX.length - 1;
        if (last >= 0 && outX[last] === point.x && outY[last] === point.y) continue;
        outX.push(point.x);
        outY.push(point.y);
    }
    return { x: outX, y: outY };
};

proto._buildTimeTrace = function(t, visibleRange = null, plot = null, traceIndex = 0, options = {}) {
    const fileData = this.files.get(t.fileId)?.data;
    if (!fileData) return null;
    const variable = fileData.variables[t.varName];
    if (!variable) return null;
    const timeVar  = this._getTimeVar(t.fileId);
    const timeData = this._getTransformedTimeDataForVariable(t.fileId, t.varName);
    const values   = this._getTransformedVariableData(t.fileId, t.varName);
    // The hover's TIME format follows the panel axis (the primary trace's file), so
    // a secondary trace sharing that axis — e.g. a numeric seconds trace under a
    // Duration axis — reads in the axis format, not its own file's default. The
    // plotted x values (timeData/plotX below) stay the trace's own.
    const primaryTimeTrace = plot?.traces?.[0] || t;
    const primaryTimeVar = this._getTimeVar(primaryTimeTrace.fileId);
    const timeMode = this._timeDisplayModeForVar(primaryTimeTrace.fileId, primaryTimeVar);
    const generatedIndexAxis = this._isGeneratedIndexTime(primaryTimeTrace.fileId, primaryTimeVar);
    const generatedCalendarAxis = this._isGeneratedCalendarTime(primaryTimeTrace.fileId, primaryTimeVar);
    const highResolutionCalendarAxis = this._isHighResolutionGeneratedCalendarTime(primaryTimeTrace.fileId, primaryTimeVar);
    // Duration vs seconds is a PANEL consensus (order-independent), so the hover's
    // time format matches the shared axis: duration only when every overlaid trace
    // is duration; any seconds trace ⇒ this hover reads in plain seconds too.
    const durationAxis = this._resolvePanelTimeAxis(
        (plot?.traces || [t]).map(tr => tr.fileId),
    ).effectiveDisplay === 'duration';
    const timeUnit = generatedIndexAxis
        ? (generatedCalendarAxis ? 'datetime' : (durationAxis ? 'duration' : 'index'))
        : (timeMode === 'calendar'
            ? 'datetime'
            : (durationAxis ? 'duration' : (timeMode === 'elapsedSeconds' ? 's' : (primaryTimeVar ? this._extractUnit(primaryTimeVar.description) : 's'))));
    const unit     = this._extractUnit(variable.description);
    const name     = this._traceName(t.varName, t.fileId);
    const hoverName = this._escapeHTML(name);
    const hoverTimeUnit = this._escapeHTML(timeUnit);
    const unitStr  = unit ? ` [${this._escapeHTML(unit)}]` : '';
    const primaryCalendarTimeFormat = this._calendarTimeFormat(primaryTimeTrace.fileId, primaryTimeVar);
    const calendarHoverFormat = this._calendarTickFormat(primaryTimeTrace.fileId, primaryTimeVar);
    const durationFractionDigits = this._durationFractionDigits(t.fileId);
    const stackAttrs = this._timeseriesStackAttrs(plot, traceIndex);
    const yaxis = this._traceYAxis(t, plot);
    const hoverX = highResolutionCalendarAxis
        ? `<b>Time</b> = %{customdata}<br>`
        : timeMode === 'calendar'
        ? `<b>Time</b> = %{x|${calendarHoverFormat}}<br>`
        : (durationAxis
            ? `<b>Elapsed</b> = %{customdata}<br>`
            : `<b>Time [${hoverTimeUnit}]</b> = %{x:.4g}<br>`);

    if (variable.kind === 'parameter') {
        const tStart = timeData.length ? timeData[0] : 0;
        const tEnd   = timeData.length ? timeData[timeData.length - 1] : 1;
        const yValue = values.length ? values[0] : variable.data[0];
        return {
            x: this._plotlyTimeArray(t.fileId, [tStart, tEnd], timeVar), y: [yValue, yValue],
            name, type: 'scatter', mode: 'lines',
            visible: t.visible ?? true,
            yaxis,
            line: { color: t.color, width: 1.5, dash: 'dash' },
            ...stackAttrs,
            hovertemplate: `${hoverX}<b>${hoverName}</b>${unitStr} = ${this._formatHTMLNumber(yValue)}<extra></extra>`,
            ...(highResolutionCalendarAxis
                ? { customdata: [tStart, tEnd].map(value => this._formatGeneratedCalendarDateTime(
                    t.fileId,
                    value,
                    timeVar,
                    primaryCalendarTimeFormat,
                )) }
                : durationAxis
                    ? { customdata: [tStart, tEnd].map(value => this._formatElapsedDateTime(value, durationFractionDigits)) }
                    : {}),
        };
    }
    const isStep = variable.dataType === 'boolean';
    const useGL = !isStep && values.length >= PlotManager.GL_POINT_THRESHOLD;
    const visual = this._applyTimeseriesStackZeroPadding(
        plot,
        t,
        this._buildTimeseriesVisualData(timeData, values, visibleRange, isStep)
    );
    const plotX = this._plotlyTimeArray(t.fileId, visual.x, timeVar);
    const customdata = highResolutionCalendarAxis
        ? Array.from(visual.x || [], value => this._formatGeneratedCalendarDateTime(
            t.fileId,
            value,
            timeVar,
            primaryCalendarTimeFormat,
        ))
        : durationAxis
        ? Array.from(visual.x || [], value => this._formatElapsedDateTime(value, durationFractionDigits))
        : undefined;
    const line = useGL
        ? { color: t.color, width: 1.5 }
        : { color: t.color, width: 1.5, shape: isStep ? 'hv' : 'linear' };
    return {
        x: plotX, y: visual.y,
        name, type: plot?.timeseriesStacked ? 'scatter' : (useGL ? 'scattergl' : 'scatter'), mode: 'lines',
        visible: t.visible ?? true,
        yaxis,
        line,
        ...stackAttrs,
        ...(customdata ? { customdata } : {}),
        // Numeric, pre-Plotly x aligned 1:1 with y — the FFT pane uses it to
        // locate sampling gaps for line breaks, then strips it before Plotly
        // sees the trace. Never emitted in timeseries mode.
        ...(options.attachSourceX ? { __srcX: visual.x } : {}),
        hovertemplate: `${hoverX}<b>${hoverName}</b>${unitStr} = %{y:.4g}<extra></extra>`,
    };
};

proto._buildTimeLayout = function(plot) {
    const { bg, gridColor, fontColor, legendBg } = this._colors();
    const margin = this._marginConfig();
    margin.b += 6;
    const firstTrace = plot.traces[0];
    const firstFileId = firstTrace?.fileId || this.activeFileId;
    const firstTimeVar = firstFileId ? this._getTimeVar(firstFileId) : this._getTimeVar();
    const firstTimeMode = this._timeDisplayModeForVar(firstFileId, firstTimeVar);
    const generatedCalendarAxis = this._isGeneratedCalendarTime(firstFileId, firstTimeVar);
    // Duration vs seconds is a PANEL consensus (order-independent): the shared axis
    // renders as duration (hh:mm:ss) only when EVERY overlaid trace is duration; any
    // seconds trace ⇒ plain linear seconds. Replaces the old "primary trace wins".
    const visibleFileIds = plot.traces.filter(t => this._isVisible(t)).map(t => t.fileId);
    const panelDisplay = this._resolvePanelTimeAxis(
        visibleFileIds.length ? visibleFileIds : plot.traces.map(t => t.fileId),
    ).effectiveDisplay;
    const timeTitle = this._timeAxisTitleForVar(firstFileId, firstTimeVar, 'Time', panelDisplay);
    const xAxisMode = firstTimeMode === 'calendar' || generatedCalendarAxis
        ? this._calendarAxisConfig(firstFileId, firstTimeVar, plot.traces.map(t => this._getTransformedTimeDataForVariable(t.fileId, t.varName)))
        : (panelDisplay === 'duration'
            ? this._elapsedDateTimeAxisConfig(plot.traces.map(t => this._getTransformedTimeDataForVariable(t.fileId, t.varName)), firstFileId)
            : { type: 'linear' });
    const xExtent = this._finiteExtent(plot.traces
        .filter(t => this._isVisible(t))
        .map(t => this._getTransformedTimeDataForVariable(t.fileId, t.varName)));
    const xRange = xExtent ? this._exactRange(xExtent.min, xExtent.max) : null;
    const xRangeConfig = xRange
        ? {
            range: firstTimeMode === 'calendar' || generatedCalendarAxis
                ? this._plotlyTimeArray(firstFileId, xRange, firstTimeVar)
                : xRange,
            autorange: false,
        }
        : {};
    const axisTraces = {
        y: plot.traces.filter(t => this._traceYAxis(t, plot) === 'y'),
        y2: plot.traces.filter(t => this._traceYAxis(t, plot) === 'y2'),
    };
    const axisTitle = (traces) => {
        if (traces.length !== 1) return '';
        const trace = traces[0];
        const d = this.files.get(trace.fileId)?.data;
        const v = d?.variables[trace.varName];
        const unit = v ? this._extractUnit(v.description) : '';
        const label = this._variableLabel(trace.varName, trace.fileId);
        return unit ? `${label} [${unit}]` : label;
    };
    const yTitle = axisTitle(axisTraces.y);
    const y2Title = plot.timeseriesY2Enabled ? axisTitle(axisTraces.y2) : '';
    if (plot.timeseriesY2Enabled) margin.r = Math.max(margin.r || 0, 56);

    const layout = {
        paper_bgcolor: bg, plot_bgcolor: bg,
        font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
        showlegend: true,
        xaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                 ...xAxisMode,
                 ...xRangeConfig,
                 title: { text: timeTitle, font: { size: 10 } } },
        yaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                 title: yTitle ? { text: yTitle, font: { size: 10 } } : { text: '' } },
        legend: this._legendConfig(legendBg, gridColor),
        margin,
        autosize:  true,
        hovermode: this.hoverProximity ? 'closest' : 'x',
    };
    if (plot.timeseriesY2Enabled) {
        layout.yaxis2 = {
            overlaying: 'y',
            side: 'right',
            showgrid: false,
            linecolor: gridColor,
            tickcolor: gridColor,
            zeroline: false,
            title: y2Title ? { text: y2Title, font: { size: 10 } } : { text: '' },
        };
    }
    // Opt-in "show missing data" bands (timeseries only; the FFT/histogram/
    // heatmap panes that also call this builder set their own shapes afterward).
    if (plot.mode === 'timeseries' && plot.showMissingData) {
        layout.shapes = this._missingDataBandShapes(plot);
    }
    return layout;
};

// ── Phase 2D ──
// Whether a 2D pair trace of `len` points should render with WebGL. Marker
// displays use WebGL for any non-empty trace because SVG creates one DOM node
// per point; line-only displays stay SVG until the usual large-trace threshold.
proto._phase2dUseGL = function(len, showMarkers) {
    const pointCount = len || 0;
    if (showMarkers) return pointCount > 0;
    return pointCount >= PlotManager.GL_POINT_THRESHOLD;
};

proto._buildPhase2DTraces = function(plot) {
    // Display mode (Lines / Points / Lines+points) and marker options come from
    // the phase2d state (TODO 10); default to the legacy line trajectory.
    const state = this._ensurePhase2dState ? this._ensurePhase2dState(plot) : null;
    const mode = this._phase2dPlotlyMode ? this._phase2dPlotlyMode(state) : 'lines';
    const showMarkers = this._phase2dShowsMarkers ? this._phase2dShowsMarkers(state) : false;
    const traces = plot.phaseTraces.map(pt => {
        // In an active Selección the scatter shows only the selected window
        // (range-limited visual); otherwise the normal downsampled trajectory.
        const visual = (this._phase2dRangeLimitedVisual
            ? this._phase2dRangeLimitedVisual(plot, pt) : null)
            || this._phaseVisualDataForTrace(plot, pt);
        if (!visual) return null;
        const len = Math.max(visual.x?.length || 0, visual.y?.length || 0);
        const useGL = this._phase2dUseGL(len, showMarkers);
        const trace = {
            x: visual.x, y: visual.y,
            name: this._phaseTraceName(plot, pt),
            type: useGL ? 'scattergl' : 'scatter', mode,
            visible: pt.visible ?? true,
            line: { color: pt.color, width: 1.5 },
        };
        if (showMarkers) {
            trace.marker = { color: pt.color, size: state?.markerSize ?? 4, opacity: state?.markerOpacity ?? 0.65 };
        }
        return trace;
    }).filter(Boolean);
    // Fit curves (TODO 10): appended AFTER the data traces and BEFORE the origin
    // cross, so the trace order is [data…, fit…, origin]. Callers that map a
    // plot trace index back to a phaseTraces index must account for these.
    if (state?.fitEnabled && this._buildPhase2dFitCurveTraces) {
        for (const fitTrace of this._buildPhase2dFitCurveTraces(plot)) traces.push(fitTrace);
    }
    traces.push(this._originCross2D());
    return traces;
};

/** Small cross marker at (0,0) used as origin indicator for 2D plots. */
proto._originCross2D = function() {
    const { fontColor } = this._colors();
    // 'cross-thin-open' is a thin + glyph; size controls overall length,
    // marker.line.width controls stroke thickness. Color follows theme.
    return {
        x: [0], y: [0], type: 'scatter', mode: 'markers',
        marker: { symbol: 'cross-thin-open', size: 20, color: fontColor,
                  line: { color: fontColor, width: 1.2 } },
        showlegend: false, hoverinfo: 'skip', name: '__origin__',
    };
};

proto._buildPhase2DLayout = function(plot) {
    const { bg, gridColor, fontColor, legendBg } = this._colors();
    const first = plot.phaseTraces[0] || {};
    const multiTrace = plot.phaseTraces.length > 1;
    const xu = this._varUnit(first.x, first.fileId);
    const yu = this._varUnit(first.y, first.fileId);
    const xLabel = this._variableLabel(first.x, first.fileId);
    const yLabel = this._variableLabel(first.y, first.fileId);
    const xArrays = [];
    const yArrays = [];
    for (const pt of plot.phaseTraces) {
        if (!this._isVisible(pt)) continue;
        const visual = this._phaseVisualDataForTrace(plot, pt);
        if (!visual) continue;
        xArrays.push(visual.x);
        yArrays.push(visual.y);
    }
    const xExtent = this._finiteExtent(xArrays);
    const yExtent = this._finiteExtent(yArrays);
    const xRangeConfig = xExtent ? { range: this._padRange(xExtent.min, xExtent.max), autorange: false } : {};
    const yRangeConfig = yExtent ? { range: this._padRange(yExtent.min, yExtent.max), autorange: false } : {};
    return {
        paper_bgcolor: bg, plot_bgcolor: bg,
        font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
        showlegend: true,
        legend: this._legendConfig(legendBg, gridColor),
        xaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                 ...xRangeConfig,
                 title: { text: multiTrace ? 'x' : (xu ? `${xLabel} [${xu}]` : (xLabel || 'X')), font: { size: 10 } } },
        yaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                 ...yRangeConfig,
                 title: { text: multiTrace ? 'y' : (yu ? `${yLabel} [${yu}]` : (yLabel || 'Y')), font: { size: 10 } },
                 ...(plot.equalAspect2D ? { scaleanchor: 'x', scaleratio: 1 } : {}) },
        margin: { l: 60, r: 15, t: 10, b: 50 },
        autosize: true, hovermode: 'closest',
    };
};

// ── Phase 2D+t: x=var1, y=time, z=var2 ──
proto._phase2DtHighResolutionTimeCustomData = function(plot, pt, timeValues) {
    const timeVar = this._getTimeVar(pt.fileId);
    if (!this._isHighResolutionGeneratedCalendarTime(pt.fileId, timeVar)) return null;
    const primary = plot?.phaseTraces?.[0] || pt;
    const primaryTimeVar = this._getTimeVar(primary.fileId);
    const calendarTimeFormat = this._calendarTimeFormat(primary.fileId, primaryTimeVar);
    return Array.from(timeValues || [], value => this._formatGeneratedCalendarDateTime(
        pt.fileId,
        value,
        timeVar,
        calendarTimeFormat,
    ));
};

proto._buildPhase2DtTraces = function(plot) {
    return plot.phaseTraces.map(pt => {
        const d = this.files.get(pt.fileId)?.data;
        const timeVar = this._getTimeVar(pt.fileId);
        if (!d) return null;
        const visual = this._phaseVisualDataForTrace(plot, pt);
        if (!visual) return null;
        const name = this._phaseTraceName(plot, pt);
        const customdata = this._phase2DtHighResolutionTimeCustomData(plot, pt, visual.time);
        const highResolutionHover = customdata ? {
            customdata,
            hovertemplate: `<b>Time</b> = %{customdata}<br>`
                + `<b>${this._escapeHTML(this._variableLabel(pt.x, pt.fileId))}</b> = %{y:.4g}<br>`
                + `<b>${this._escapeHTML(this._variableLabel(pt.y, pt.fileId))}</b> = %{z:.4g}`
                + `<extra>${this._escapeHTML(name)}</extra>`,
        } : {};
        return {
            x: this._plotlyTimeArray(pt.fileId, visual.time, timeVar),
            y: visual.x,
            z: visual.y,
            name,
            type: 'scatter3d', mode: 'lines',
            visible: pt.visible ?? true,
            line: { color: pt.color, width: 3 },
            ...highResolutionHover,
        };
    }).filter(Boolean);
};

// ── Phase 3D ──
proto._buildPhase3DTraces = function(plot) {
    return plot.phaseTraces.map(pt => {
        const visual = this._phaseVisualDataForTrace(plot, pt);
        if (!visual) return null;
        return {
            x: visual.x,
            y: visual.y,
            z: visual.z,
            name: this._phaseTraceName(plot, pt),
            type: 'scatter3d', mode: 'lines',
            visible: pt.visible ?? true,
            line: { color: pt.color, width: 3 },
        };
    }).filter(Boolean);
};

proto._buildPhase3DLayout = function(plot, isTimez) {
    const { bg, gridColor, fontColor, legendBg } = this._colors();
    const first = plot.phaseTraces[0] || {};
    const firstTimeVar = this._getTimeVar(first.fileId);
    const firstTimeMode = this._timeDisplayModeForVar(first.fileId, firstTimeVar);
    // Duration vs seconds on the time axis is a PANEL consensus (order-independent),
    // matching the 2D timeseries path: duration only if every overlaid trace is.
    const phaseTimeFileIds = plot.phaseTraces.filter(pt => this._isVisible(pt)).map(pt => pt.fileId);
    const timePanelDisplay = isTimez
        ? this._resolvePanelTimeAxis(phaseTimeFileIds.length ? phaseTimeFileIds : plot.phaseTraces.map(pt => pt.fileId)).effectiveDisplay
        : null;
    const timeTitle = this._timeAxisTitleForVar(first.fileId, firstTimeVar, 'Time', timePanelDisplay);

    // phase2dt: plotly X=time,  Y=var x, Z=var y
    // phase3d:  plotly X=var x, Y=var y, Z=var z
    let xLabel, yLabel, zLabel;
    if (isTimez) {
        const yu = this._varUnit(first.x, first.fileId);
        const zu = this._varUnit(first.y, first.fileId);
        const yVarLabel = this._variableLabel(first.x, first.fileId);
        const zVarLabel = this._variableLabel(first.y, first.fileId);
        xLabel = timeTitle;
        yLabel = yu ? `${yVarLabel} [${yu}]` : (yVarLabel || 'x');
        zLabel = zu ? `${zVarLabel} [${zu}]` : (zVarLabel || 'y');
    } else {
        const xu = this._varUnit(first.x, first.fileId);
        const yu = this._varUnit(first.y, first.fileId);
        const zu = this._varUnit(first.z, first.fileId);
        const xVarLabel = this._variableLabel(first.x, first.fileId);
        const yVarLabel = this._variableLabel(first.y, first.fileId);
        const zVarLabel = this._variableLabel(first.z, first.fileId);
        xLabel = xu ? `${xVarLabel} [${xu}]` : (xVarLabel || 'X');
        yLabel = yu ? `${yVarLabel} [${yu}]` : (yVarLabel || 'Y');
        zLabel = zu ? `${zVarLabel} [${zu}]` : (zVarLabel || 'Z');
    }

    const multiTrace = plot.phaseTraces.length > 1;
    // Build explicit axis ranges that include 0 so the origin-anchored decoration
    // lines (red/green/blue) don't trigger autorange expansion when added.
    const xArrays = [], yArrays = [], zArrays = [];
    for (const pt of plot.phaseTraces) {
        if (!this._isVisible(pt)) continue;
        const d = this.files.get(pt.fileId)?.data;
        if (!d) continue;
        const visual = this._phaseVisualDataForTrace(plot, pt);
        if (!visual) continue;
        if (isTimez) {
            xArrays.push(visual.time || []);
            yArrays.push(visual.x || []);
            zArrays.push(visual.y || []);
        } else {
            xArrays.push(visual.x || []);
            yArrays.push(visual.y || []);
            zArrays.push(visual.z || []);
        }
    }
    const generatedCalendarAxis = this._isGeneratedCalendarTime(first.fileId, firstTimeVar);
    const calendarTimeAxis = isTimez && (firstTimeMode === 'calendar' || generatedCalendarAxis);
    const elapsedDateTimeAxis = isTimez && !calendarTimeAxis && timePanelDisplay === 'duration';
    const xExtent = calendarTimeAxis ? this._finiteExtent(xArrays) : null;
    let xRange = xExtent ? this._exactRange(xExtent.min, xExtent.max) : this._rangeIncluding0(xArrays);
    if (calendarTimeAxis && Array.isArray(xRange)) {
        const timeVar = this._getTimeVar(first.fileId);
        xRange = this._plotlyTimeArray(first.fileId, xRange, timeVar);
    }
    const timeAxisConfig = calendarTimeAxis
        ? this._calendarAxisConfig(first.fileId, firstTimeVar, xArrays)
        : (elapsedDateTimeAxis ? this._elapsedDateTimeAxisConfig(xArrays, first.fileId) : {});
    const yRange = this._rangeIncluding0(yArrays);
    const zRange = this._rangeIncluding0(zArrays);
    const axisStyle = { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor,
                        backgroundcolor: bg, showbackground: true, zeroline: false,
                        autorange: false };
    // Bold axis-coloured titles match the red/green/blue arrows
    const xTitleFont = { color: '#e74c3c', size: 13, family: 'system-ui, sans-serif', weight: 700 };
    const yTitleFont = { color: '#2ecc71', size: 13, family: 'system-ui, sans-serif', weight: 700 };
    const zTitleFont = { color: '#3498db', size: 13, family: 'system-ui, sans-serif', weight: 700 };
    return {
        paper_bgcolor: bg,
        font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
        showlegend: true,
        legend: this._legendConfig(legendBg, gridColor),
        scene: {
            xaxis: { ...axisStyle, range: xRange,
                     ...timeAxisConfig,
                     title: { text: (multiTrace && !isTimez) ? 'x' : xLabel, font: xTitleFont },
                     showspikes: true, spikecolor: '#e74c3c', spikethickness: 3, spikesides: false },
            yaxis: { ...axisStyle, range: yRange,
                     title: { text: multiTrace ? (isTimez ? 'x' : 'y') : yLabel, font: yTitleFont },
                     showspikes: true, spikecolor: '#2ecc71', spikethickness: 3, spikesides: false },
            zaxis: { ...axisStyle, range: zRange,
                     title: { text: multiTrace ? (isTimez ? 'y' : 'z') : zLabel, font: zTitleFont },
                     showspikes: true, spikecolor: '#3498db', spikethickness: 3, spikesides: false },
            camera: {
                // phase2dt default view is rotated around the Z (var y / up) axis so time
                // (plotly X) reads from the lower-right toward the upper-left of the screen,
                // with var x (plotly Y) going toward the lower-left and var y (plotly Z) up.
                eye: isTimez ? { x: 1.25, y: -1.25, z: 1.25 } : { x: 1.25, y: 1.25, z: 1.25 },
                up:  { x: 0, y: 0, z: 1 },
                center: { x: 0, y: 0, z: 0 },
                projection: { type: plot.projection || 'orthographic' },
            },
            bgcolor: bg,
            aspectmode: 'cube',
        },
        margin:   { l: 0, r: 0, t: 10, b: 0 },
        autosize: true,
    };
};

// ─── State Animation mode ────────────────────────────────────────

}
