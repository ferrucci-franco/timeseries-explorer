

export function installPlotDataMethods(TargetClass) {
    const proto = TargetClass.prototype;
    const PlotManager = TargetClass;
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
        calendarTimeFormat: t.calendarTimeFormat === 'ampm' ? 'ampm' : null,
        timeShift: t.timeShift === '' || t.timeShift === null || t.timeShift === undefined ? 0 : t.timeShift,
        timeStepMode: ['index', 'seconds', '10minutes', '1hour', 'custom'].includes(t.timeStepMode) ? t.timeStepMode : null,
        customTimeStep: t.customTimeStep === null || t.customTimeStep === undefined ? '' : String(t.customTimeStep),
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
    return t.timeDisplayMode !== null || t.calendarTimeFormat !== null || t.timeShift !== 0 || t.timeStepMode !== null || t.customTimeStep !== '' || t.gain !== 1 || t.yOffset !== 0 || t.cropStart !== null || t.cropEnd !== null;
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
    return this._getTimeVar(fileId)?.timeKind === 'datetime' ? 'datetime' : 'numeric';
};

proto._isGeneratedIndexTime = function(fileId, timeVar = null) {
    return this._fileTransform(fileId).timeDisplayMode === 'index'
        || (timeVar || this._getTimeVar(fileId))?.timeKind === 'index';
};

proto._isGeneratedDurationTime = function(fileId, timeVar = null) {
    return this._isGeneratedIndexTime(fileId, timeVar) && this._indexTimeStepMode(fileId) !== 'index';
};

proto._indexTimeStepMode = function(fileId) {
    const transform = this._fileTransform(fileId);
    const timeVar = this._getTimeVar(fileId);
    if (transform.timeDisplayMode !== 'index' && timeVar?.timeKind !== 'index') return null;
    return transform.timeStepMode || timeVar.timeStepMode || 'index';
};

proto._indexTimeStepSeconds = function(fileId) {
    const mode = this._indexTimeStepMode(fileId);
    if (mode === 'seconds') return 1;
    if (mode === '10minutes') return 600;
    if (mode === '1hour') return 3600;
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
    if (mode === '10minutes') return '10 min';
    if (mode === '1hour') return '1 h';
    if (mode === 'custom') {
        const raw = String(this._fileTransform(fileId).customTimeStep || '').trim();
        return raw || 'custom';
    }
    return '1 s';
};

proto._timeDisplayMode = function(fileId) {
    const transform = this._fileTransform(fileId);
    const timeVar = this._getTimeVar(fileId);
    if (transform.timeDisplayMode === 'index') return 'index';
    if (timeVar?.timeKind !== 'datetime') return 'numeric';
    return transform.timeDisplayMode || timeVar.timeDisplayMode || 'calendar';
};

proto._timeDisplayModeForVar = function(fileId, timeVar = null) {
    const transform = this._fileTransform(fileId);
    if (transform.timeDisplayMode === 'index') return 'index';
    if (timeVar?.timeKind !== 'datetime') return 'numeric';
    return transform.timeDisplayMode || timeVar.timeDisplayMode || 'calendar';
};

proto._calendarTimeFormat = function(fileId, timeVar = null) {
    const transform = this._fileTransform(fileId);
    return transform.calendarTimeFormat || timeVar?.calendarTimeFormat || '24h';
};

proto._calendarTickFormat = function(fileId, timeVar = null) {
    return this._calendarTimeFormat(fileId, timeVar) === 'ampm'
        ? '%Y-%m-%d %I:%M:%S %p'
        : '%Y-%m-%d %H:%M:%S';
};

proto._calendarAxisConfig = function(fileId, timeVar = null) {
    return {
        type: 'date',
        hoverformat: this._calendarTickFormat(fileId, timeVar),
    };
};

proto._isCalendarTime = function(fileId) {
    return this._timeDisplayMode(fileId) === 'calendar';
};

proto._isCalendarTimeForVar = function(fileId, timeVar = null) {
    return this._timeDisplayModeForVar(fileId, timeVar) === 'calendar';
};

proto._timeOriginMs = function(fileId) {
    const timeVar = this._getTimeVar(fileId);
    const origin = Number(timeVar?.timeOriginMs);
    return Number.isFinite(origin) ? origin : Number(timeVar?.data?.[0]) || 0;
};

proto._timeDisplayValue = function(fileId, rawTime) {
    if (this._isElapsedTime(fileId)) {
        return (rawTime - this._timeOriginMs(fileId)) / 1000;
    }
    return rawTime;
};

proto._timeDisplayValueForVar = function(fileId, rawTime, timeVar = null) {
    if (this._isGeneratedIndexTime(fileId, timeVar)) {
        const mode = this._indexTimeStepMode(fileId);
        return mode === 'index' ? rawTime : rawTime * this._indexTimeStepSeconds(fileId);
    }
    if (this._isElapsedTimeForVar(fileId, timeVar)) {
        const origin = Number(timeVar?.timeOriginMs);
        const fallbackOrigin = Number(timeVar?.data?.[0]);
        const originMs = Number.isFinite(origin) ? origin : (Number.isFinite(fallbackOrigin) ? fallbackOrigin : this._timeOriginMs(fileId));
        return (rawTime - originMs) / 1000;
    }
    return rawTime;
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
    return new Date(value).toISOString();
};

proto._plotlyTimeArray = function(fileId, values, timeVar = null) {
    if (this._timeDisplayModeForVar(fileId, timeVar) !== 'calendar') return values;
    return values.map(value => this._plotlyTimeValue(fileId, value, timeVar));
};

proto._elapsedDateTimeAxisConfig = function(rangeOrValues) {
    const values = Array.isArray(rangeOrValues?.[0]) ? rangeOrValues.flat() : (rangeOrValues || []);
    const finite = values.map(Number).filter(Number.isFinite);
    if (!finite.length) return {};
    let min = Math.min(...finite);
    let max = Math.max(...finite);
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
        ticktext: tickvals.map(value => this._formatElapsedDateTime(value)),
    };
};

proto._durationTickValues = function(min, max, maxTicks = 7) {
    const span = Math.max(Math.abs(max - min), 1e-9);
    const steps = [
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

proto._formatElapsedDateTime = function(value) {
    if (!Number.isFinite(value)) return this._formatHTMLNumber(value);
    const sign = value < 0 ? '-' : '';
    let seconds = Math.abs(value);
    const days = Math.floor(seconds / 86400);
    seconds -= days * 86400;
    const hours = Math.floor(seconds / 3600);
    seconds -= hours * 3600;
    const minutes = Math.floor(seconds / 60);
    seconds -= minutes * 60;
    const wholeSeconds = Math.floor(seconds);
    const fractional = seconds - wholeSeconds;
    const pad = n => String(n).padStart(2, '0');
    const secText = fractional > 1e-6
        ? `${pad(wholeSeconds)}.${String(Number(fractional.toFixed(3))).slice(2)}`
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
    const match = raw.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|day|days|w|week|weeks)?$/i);
    if (!match) return 0;
    const amount = Number(match[1]);
    if (!Number.isFinite(amount)) return 0;
    const unit = (match[2] || 'ms').toLowerCase();
    if (unit.startsWith('w')) return amount * 7 * 24 * 60 * 60 * 1000;
    if (unit.startsWith('d')) return amount * 24 * 60 * 60 * 1000;
    if (unit.startsWith('h')) return amount * 60 * 60 * 1000;
    if (unit === 'm' || unit.startsWith('min')) return amount * 60 * 1000;
    if (unit.startsWith('s')) return amount * 1000;
    return amount;
};

proto._parseTimeShift = function(fileId, value) {
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

proto._timeAxisTitleForVar = function(fileId, timeVar = null, fallback = 'Time') {
    const name = timeVar?.name || fallback;
    if (this._isGeneratedIndexTime(fileId, timeVar)) {
        const mode = this._indexTimeStepMode(fileId);
        return mode === 'index' ? 'index' : `duration [hh:mm:ss, step ${this._indexTimeStepLabel(fileId)}]`;
    }
    const mode = this._timeDisplayModeForVar(fileId, timeVar);
    if (mode === 'calendar') return `${name} [datetime, ${this._calendarTimeFormat(fileId, timeVar) === 'ampm' ? 'AM/PM' : '24h'}]`;
    if (mode === 'elapsedDateTime' && timeVar?.timeKind === 'datetime') {
        return `${name} elapsed [d hh:mm:ss]`;
    }
    if (mode === 'elapsedSeconds' && timeVar?.timeKind === 'datetime') {
        return `${name} elapsed [s]`;
    }
    const unit = mode === 'elapsedSeconds' ? 's' : (timeVar ? this._extractUnit(timeVar.description) : 's');
    return unit ? `${name} [${unit}]` : name;
};

proto._timeUnitLabel = function(fileId) {
    if (this._isGeneratedIndexTime(fileId)) return this._indexTimeStepMode(fileId) === 'index' ? 'index' : 'duration';
    if (this._isCalendarTime(fileId)) return 'datetime';
    if (this._timeDisplayMode(fileId) === 'elapsedDateTime') return 'duration';
    if (this._timeDisplayMode(fileId) === 'elapsedSeconds') return 's';
    const timeVar = this._getTimeVar(fileId);
    return timeVar ? this._extractUnit(timeVar.description) : 's';
};

proto._formatTimeValue = function(fileId, value) {
    if (!Number.isFinite(value)) return this._formatHTMLNumber(value);
    if (this._isGeneratedDurationTime(fileId)) return this._formatElapsedDateTime(value);
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
        return `${year}-${month}-${day} ${pad2(h12)}:${minute}:${second} ${suffix} UTC`;
    }
    return `${year}-${month}-${day} ${pad2(d.getUTCHours())}:${minute}:${second} UTC`;
};

proto._formatTimeForExport = function(fileId, value) {
    if (!Number.isFinite(value)) return value;
    if (this._isGeneratedDurationTime(fileId)) return this._formatElapsedDateTime(value);
    if (this._timeDisplayMode(fileId) === 'elapsedDateTime') return this._formatElapsedDateTime(value);
    if (!this._isCalendarTime(fileId)) return value;
    return new Date(value).toISOString();
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
    const generatedFromDetectedTime = generatedIndex && transform.timeDisplayMode === 'index';
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
        for (let i = 0; i < rawTimes.length; i++) {
            const rawTime = rawTimes[i];
            const displayTime = generatedFromDetectedTime
                ? (this._indexTimeStepMode(fileId) === 'index' ? i : i * this._indexTimeStepSeconds(fileId))
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

proto._getTransformedVariableData = function(fileId, varName, options = {}) {
    const includeYOffset = options.includeYOffset !== false;
    const d = this.files.get(fileId)?.data;
    const variable = d?.variables?.[varName];
    if (!variable) return [];
    if (variable.kind === 'abscissa') return this._getTransformedTimeData(fileId);

    const transform = this._fileTransform(fileId);
    const gain = transform.gain;
    const yOffset = includeYOffset ? transform.yOffset : 0;
    const indexData = this._getTransformIndexData(fileId);
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

// ─── Trace / layout builders ───────────────────────────────────

proto._buildPlotData = function(plot) {
    switch (plot.mode) {
        case 'phase2d':    return { traces: this._buildPhase2DTraces(plot),  layout: this._buildPhase2DLayout(plot)  };
        case 'phase2dt':   return { traces: this._buildPhase2DtTraces(plot), layout: this._buildPhase3DLayout(plot, true)  };
        case 'phase3d':    return { traces: this._buildPhase3DTraces(plot),  layout: this._buildPhase3DLayout(plot, false) };
        case 'state-anim': return { traces: this._buildStateAnimTraces(plot), layout: this._buildStateAnimLayout(plot) };
        default:           return { traces: plot.traces.map(t => this._buildTimeTrace(t)).filter(Boolean), layout: this._buildTimeLayout(plot) };
    }
};

// ── Timeseries ──
proto._buildTimeTrace = function(t, visibleRange = null) {
    const fileData = this.files.get(t.fileId)?.data;
    if (!fileData) return null;
    const variable = fileData.variables[t.varName];
    if (!variable) return null;
    const timeVar  = this._getTimeVar(t.fileId);
    const timeData = this._getTransformedTimeData(t.fileId);
    const values   = this._getTransformedVariableData(t.fileId, t.varName);
    const timeMode = this._timeDisplayModeForVar(t.fileId, timeVar);
    const generatedIndexAxis = this._isGeneratedIndexTime(t.fileId, timeVar);
    const durationAxis = timeMode === 'elapsedDateTime' || this._isGeneratedDurationTime(t.fileId, timeVar);
    const timeUnit = generatedIndexAxis
        ? (durationAxis ? 'duration' : 'index')
        : (timeMode === 'calendar'
            ? 'datetime'
            : (durationAxis ? 'duration' : (timeMode === 'elapsedSeconds' ? 's' : (timeVar ? this._extractUnit(timeVar.description) : 's'))));
    const unit     = this._extractUnit(variable.description);
    const name     = this._traceName(t.varName, t.fileId);
    const hoverName = this._escapeHTML(name);
    const hoverTimeUnit = this._escapeHTML(timeUnit);
    const unitStr  = unit ? ` [${this._escapeHTML(unit)}]` : '';
    const calendarTickFormat = this._calendarTickFormat(t.fileId, timeVar);
    const hoverX = timeMode === 'calendar'
        ? `<b>Time</b> = %{x|${calendarTickFormat}}<br>`
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
            line: { color: t.color, width: 1.5, dash: 'dash' },
            hovertemplate: `${hoverX}<b>${hoverName}</b>${unitStr} = ${this._formatHTMLNumber(yValue)}<extra></extra>`,
            ...(durationAxis ? { customdata: [tStart, tEnd].map(value => this._formatElapsedDateTime(value)) } : {}),
        };
    }
    const isStep = variable.dataType === 'boolean';
    const useGL = !isStep && values.length >= PlotManager.GL_POINT_THRESHOLD;
    const visual = this._buildTimeseriesVisualData(timeData, values, visibleRange, isStep);
    const plotX = this._plotlyTimeArray(t.fileId, visual.x, timeVar);
    const customdata = durationAxis
        ? visual.x.map(value => this._formatElapsedDateTime(value))
        : undefined;
    const line = useGL
        ? { color: t.color, width: 1.5 }
        : { color: t.color, width: 1.5, shape: isStep ? 'hv' : 'linear' };
    return {
        x: plotX, y: visual.y,
        name, type: useGL ? 'scattergl' : 'scatter', mode: 'lines',
        visible: t.visible ?? true,
        line,
        ...(customdata ? { customdata } : {}),
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
    const timeTitle = this._timeAxisTitleForVar(firstFileId, firstTimeVar);
    const xAxisMode = firstTimeMode === 'calendar'
        ? this._calendarAxisConfig(firstFileId, firstTimeVar)
        : (firstTimeMode === 'elapsedDateTime' || this._isGeneratedDurationTime(firstFileId, firstTimeVar)
            ? this._elapsedDateTimeAxisConfig(plot.traces.map(t => this._getTransformedTimeData(t.fileId)))
            : { type: 'linear' });
    const xExtent = this._finiteExtent(plot.traces
        .filter(t => this._isVisible(t))
        .map(t => this._getTransformedTimeData(t.fileId)));
    const xRange = xExtent ? this._exactRange(xExtent.min, xExtent.max) : null;
    const xRangeConfig = xRange
        ? {
            range: firstTimeMode === 'calendar'
                ? this._plotlyTimeArray(firstFileId, xRange, firstTimeVar)
                : xRange,
            autorange: false,
        }
        : {};
    const multiTrace = plot.traces.length > 1;
    let yTitle = '';
    if (!multiTrace && firstTrace) {
        const d = this.files.get(firstTrace.fileId)?.data;
        const v = d?.variables[firstTrace.varName];
        const unit = v ? this._extractUnit(v.description) : '';
        yTitle = unit ? `${firstTrace.varName} [${unit}]` : firstTrace.varName;
    }

    return {
        paper_bgcolor: bg, plot_bgcolor: bg,
        font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
        showlegend: true,
        xaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                 ...xAxisMode,
                 ...xRangeConfig,
                 title: { text: timeTitle, font: { size: 10 } } },
        yaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                 title: (yTitle && !multiTrace) ? { text: yTitle, font: { size: 10 } } : { text: '' } },
        legend: this._legendConfig(legendBg, gridColor),
        margin,
        autosize:  true,
        hovermode: this.hoverProximity ? 'closest' : 'x',
    };
};

// ── Phase 2D ──
proto._buildPhase2DTraces = function(plot) {
    const traces = plot.phaseTraces.map(pt => {
        const d = this.files.get(pt.fileId)?.data;
        if (!d) return null;
        const xVar = d.variables[pt.x], yVar = d.variables[pt.y];
        if (!xVar || !yVar) return null;
        const xData = this._getTransformedVariableData(pt.fileId, pt.x);
        const yData = this._getTransformedVariableData(pt.fileId, pt.y);
        const [xVisual, yVisual] = this._buildPhaseVisualSeries([xData, yData]);
        const useGL = xData.length >= PlotManager.GL_POINT_THRESHOLD || yData.length >= PlotManager.GL_POINT_THRESHOLD;
        return {
            x: xVisual, y: yVisual,
            name: this._traceName(`${pt.x} vs ${pt.y}`, pt.fileId),
            type: useGL ? 'scattergl' : 'scatter', mode: 'lines',
            visible: pt.visible ?? true,
            line: { color: pt.color, width: 1.5 },
        };
    }).filter(Boolean);
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
    const xArrays = [];
    const yArrays = [];
    for (const pt of plot.phaseTraces) {
        if (!this._isVisible(pt)) continue;
        const d = this.files.get(pt.fileId)?.data;
        if (!d?.variables?.[pt.x] || !d?.variables?.[pt.y]) continue;
        xArrays.push(this._getTransformedVariableData(pt.fileId, pt.x));
        yArrays.push(this._getTransformedVariableData(pt.fileId, pt.y));
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
                 title: { text: multiTrace ? 'x' : (xu ? `${first.x} [${xu}]` : (first.x || 'X')), font: { size: 10 } } },
        yaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                 ...yRangeConfig,
                 title: { text: multiTrace ? 'y' : (yu ? `${first.y} [${yu}]` : (first.y || 'Y')), font: { size: 10 } },
                 ...(plot.equalAspect2D ? { scaleanchor: 'x', scaleratio: 1 } : {}) },
        margin: { l: 60, r: 15, t: 10, b: 50 },
        autosize: true, hovermode: 'closest',
    };
};

// ── Phase 2D+t: x=var1, y=time, z=var2 ──
proto._buildPhase2DtTraces = function(plot) {
    return plot.phaseTraces.map(pt => {
        const d = this.files.get(pt.fileId)?.data;
        if (!d) return null;
        const xVar = d.variables[pt.x], yVar = d.variables[pt.y];
        const timeVar = this._getTimeVar(pt.fileId);
        if (!xVar || !yVar) return null;
        const [timeVisual, xVisual, yVisual] = this._buildPhaseVisualSeries([
            timeVar ? this._getTransformedTimeData(pt.fileId) : [],
            this._getTransformedVariableData(pt.fileId, pt.x),
            this._getTransformedVariableData(pt.fileId, pt.y),
        ]);
        return {
            x: this._plotlyTimeArray(pt.fileId, timeVisual, timeVar),
            y: xVisual,
            z: yVisual,
            name: this._traceName(`${pt.x} vs ${pt.y}`, pt.fileId),
            type: 'scatter3d', mode: 'lines',
            visible: pt.visible ?? true,
            line: { color: pt.color, width: 3 },
        };
    }).filter(Boolean);
};

// ── Phase 3D ──
proto._buildPhase3DTraces = function(plot) {
    return plot.phaseTraces.map(pt => {
        const d = this.files.get(pt.fileId)?.data;
        if (!d) return null;
        const xVar = d.variables[pt.x], yVar = d.variables[pt.y], zVar = d.variables[pt.z];
        if (!xVar || !yVar || !zVar) return null;
        const [xVisual, yVisual, zVisual] = this._buildPhaseVisualSeries([
            this._getTransformedVariableData(pt.fileId, pt.x),
            this._getTransformedVariableData(pt.fileId, pt.y),
            this._getTransformedVariableData(pt.fileId, pt.z),
        ]);
        return {
            x: xVisual,
            y: yVisual,
            z: zVisual,
            name: this._traceName(`${pt.x} / ${pt.y} / ${pt.z}`, pt.fileId),
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
    const timeTitle = this._timeAxisTitleForVar(first.fileId, firstTimeVar);

    // phase2dt: plotly X=time,  Y=var x, Z=var y
    // phase3d:  plotly X=var x, Y=var y, Z=var z
    let xLabel, yLabel, zLabel;
    if (isTimez) {
        const yu = this._varUnit(first.x, first.fileId);
        const zu = this._varUnit(first.y, first.fileId);
        xLabel = timeTitle;
        yLabel = yu ? `${first.x} [${yu}]` : (first.x || 'x');
        zLabel = zu ? `${first.y} [${zu}]` : (first.y || 'y');
    } else {
        const xu = this._varUnit(first.x, first.fileId);
        const yu = this._varUnit(first.y, first.fileId);
        const zu = this._varUnit(first.z, first.fileId);
        xLabel = xu ? `${first.x} [${xu}]` : (first.x || 'X');
        yLabel = yu ? `${first.y} [${yu}]` : (first.y || 'Y');
        zLabel = zu ? `${first.z} [${zu}]` : (first.z || 'Z');
    }

    const multiTrace = plot.phaseTraces.length > 1;
    // Build explicit axis ranges that include 0 so the origin-anchored decoration
    // lines (red/green/blue) don't trigger autorange expansion when added.
    const xArrays = [], yArrays = [], zArrays = [];
    for (const pt of plot.phaseTraces) {
        if (!this._isVisible(pt)) continue;
        const d = this.files.get(pt.fileId)?.data;
        if (!d) continue;
        if (isTimez) {
            const tv = this._getTimeVar(pt.fileId);
            xArrays.push(tv ? this._getTransformedTimeData(pt.fileId) : []);
            yArrays.push(d.variables[pt.x] ? this._getTransformedVariableData(pt.fileId, pt.x) : []);
            zArrays.push(d.variables[pt.y] ? this._getTransformedVariableData(pt.fileId, pt.y) : []);
        } else {
            xArrays.push(d.variables[pt.x] ? this._getTransformedVariableData(pt.fileId, pt.x) : []);
            yArrays.push(d.variables[pt.y] ? this._getTransformedVariableData(pt.fileId, pt.y) : []);
            zArrays.push(d.variables[pt.z] ? this._getTransformedVariableData(pt.fileId, pt.z) : []);
        }
    }
    const calendarTimeAxis = isTimez && firstTimeMode === 'calendar';
    const elapsedDateTimeAxis = isTimez && (firstTimeMode === 'elapsedDateTime' || this._isGeneratedDurationTime(first.fileId, firstTimeVar));
    const xExtent = calendarTimeAxis ? this._finiteExtent(xArrays) : null;
    let xRange = xExtent ? this._exactRange(xExtent.min, xExtent.max) : this._rangeIncluding0(xArrays);
    if (calendarTimeAxis && Array.isArray(xRange)) {
        const timeVar = this._getTimeVar(first.fileId);
        xRange = this._plotlyTimeArray(first.fileId, xRange, timeVar);
    }
    const timeAxisConfig = calendarTimeAxis
        ? this._calendarAxisConfig(first.fileId, firstTimeVar)
        : (elapsedDateTimeAxis ? this._elapsedDateTimeAxisConfig(xArrays) : {});
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
