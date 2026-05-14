

export function installPlotDataMethods(TargetClass) {
    const proto = TargetClass.prototype;
    const PlotManager = TargetClass;
proto._normalizeFileTransform = function(transform = null) {
    const t = transform || {};
    const finiteOrZero = (value) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    };
    const finiteOrNull = (value) => {
        if (value === '' || value === null || value === undefined) return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    };
    return {
        timeShift: finiteOrZero(t.timeShift),
        gain: (() => {
            const n = Number(t.gain);
            return Number.isFinite(n) ? n : 1;
        })(),
        yOffset: finiteOrZero(t.yOffset),
        cropStart: finiteOrNull(t.cropStart),
        cropEnd: finiteOrNull(t.cropEnd),
    };
};

proto._isFileTransformActive = function(transform) {
    const t = this._normalizeFileTransform(transform);
    return t.timeShift !== 0 || t.gain !== 1 || t.yOffset !== 0 || t.cropStart !== null || t.cropEnd !== null;
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

proto._getTransformIndexData = function(fileId) {
    const cache = this._transformCache(fileId);
    if (cache?.indexData) return cache.indexData;

    const timeVar = this._getTimeVar(fileId);
    const rawTimes = timeVar?.data || [];
    const transform = this._fileTransform(fileId);
    const cropped = transform.cropStart !== null || transform.cropEnd !== null;

    let result;
    if (!rawTimes.length) {
        result = { indexes: null, times: [] };
    } else if (transform.timeShift === 0 && !cropped) {
        result = { indexes: null, times: rawTimes };
    } else {
        let lo = transform.cropStart ?? -Infinity;
        let hi = transform.cropEnd ?? Infinity;
        if (lo > hi) [lo, hi] = [hi, lo];

        const indexes = [];
        const times = [];
        for (let i = 0; i < rawTimes.length; i++) {
            const rawTime = rawTimes[i];
            if (!cropped || (rawTime >= lo && rawTime <= hi)) {
                indexes.push(i);
                times.push(rawTime + transform.timeShift);
            }
        }
        result = { indexes: cropped ? indexes : null, times };
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

    let [minX, maxX] = visibleRange;
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
    const timeUnit = timeVar ? this._extractUnit(timeVar.description) : 's';
    const unit     = this._extractUnit(variable.description);
    const name     = this._traceName(t.varName, t.fileId);
    const hoverName = this._escapeHTML(name);
    const hoverTimeUnit = this._escapeHTML(timeUnit);
    const unitStr  = unit ? ` [${this._escapeHTML(unit)}]` : '';

    if (variable.kind === 'parameter') {
        const tStart = timeData.length ? timeData[0] : 0;
        const tEnd   = timeData.length ? timeData[timeData.length - 1] : 1;
        const yValue = values.length ? values[0] : variable.data[0];
        return {
            x: [tStart, tEnd], y: [yValue, yValue],
            name, type: 'scatter', mode: 'lines',
            visible: t.visible ?? true,
            line: { color: t.color, width: 1.5, dash: 'dash' },
            hovertemplate: `<b>Time [${hoverTimeUnit}]</b> = %{x:.4g}<br><b>${hoverName}</b>${unitStr} = ${this._formatHTMLNumber(yValue)}<extra></extra>`,
        };
    }
    const isStep = variable.dataType === 'boolean';
    const useGL = !isStep && values.length >= PlotManager.GL_POINT_THRESHOLD;
    const visual = this._buildTimeseriesVisualData(timeData, values, visibleRange, isStep);
    const line = useGL
        ? { color: t.color, width: 1.5 }
        : { color: t.color, width: 1.5, shape: isStep ? 'hv' : 'linear' };
    return {
        x: visual.x, y: visual.y,
        name, type: useGL ? 'scattergl' : 'scatter', mode: 'lines',
        visible: t.visible ?? true,
        line,
        hovertemplate: `<b>Time [${hoverTimeUnit}]</b> = %{x:.4g}<br><b>${hoverName}</b>${unitStr} = %{y:.4g}<extra></extra>`,
    };
};

proto._buildTimeLayout = function(plot) {
    const { bg, gridColor, fontColor, legendBg } = this._colors();
    const margin = this._marginConfig();
    margin.b += 6;
    const firstTrace = plot.traces[0];
    const timeVar  = firstTrace ? this._getTimeVar(firstTrace.fileId) : this._getTimeVar();
    const timeUnit = timeVar ? this._extractUnit(timeVar.description) : 's';
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
                 title: { text: `Time [${timeUnit}]`, font: { size: 10 } } },
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
    return {
        paper_bgcolor: bg, plot_bgcolor: bg,
        font: { color: fontColor, size: 11, family: 'system-ui, sans-serif' },
        showlegend: true,
        legend: this._legendConfig(legendBg, gridColor),
        xaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
                 title: { text: multiTrace ? 'x' : (xu ? `${first.x} [${xu}]` : (first.x || 'X')), font: { size: 10 } } },
        yaxis: { gridcolor: gridColor, linecolor: gridColor, tickcolor: gridColor, zeroline: false,
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
            x: timeVisual,
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
    const timeVar  = this._getTimeVar(first.fileId);
    const timeUnit = timeVar ? this._extractUnit(timeVar.description) : 's';

    // phase2dt: plotly X=time,  Y=var x, Z=var y
    // phase3d:  plotly X=var x, Y=var y, Z=var z
    let xLabel, yLabel, zLabel;
    if (isTimez) {
        const yu = this._varUnit(first.x, first.fileId);
        const zu = this._varUnit(first.y, first.fileId);
        xLabel = `Time [${timeUnit}]`;
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
    const xRange = this._rangeIncluding0(xArrays);
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
