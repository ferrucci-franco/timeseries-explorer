// The numeric lines of a hover box, written from the arrays a trace is drawn
// with.
//
// A Plotly hovertemplate formats with d3, which has no way to say "plain
// decimals between 0.01 and 10 000, an SI prefix glued to the unit outside it"
// (utils/readout-format.js). So a trace that wants its numbers read that way
// declares them instead of formatting them:
//
//     trace._hoverReadout = {
//         lines: [
//             { label: '<b>Time</b>', source: 'x', unit: 's', resolution: 1e-6 },
//             { label: '<b>Left</b>', source: 'y', unit: 'V' },
//         ],
//         fallback: '<b>Time</b> = %{x:.6g} s<br><b>Left</b> = %{y:.4~g} V',
//     };
//     trace.hovertemplate = '%{hovertext}<extra></extra>';
//
// and src/vendor/plotly.js writes `hovertext` — one string per point, the
// lines joined with <br> — every time the trace's x, y or z reach Plotly, by
// newPlot, react, restyle, update or addTraces. That is the whole point of
// doing it there: a time series is redrawn on every zoom by half a dozen paths
// (eager, lazy, from a worker, with line breaks inserted…), and a readout kept
// by each of them would sooner or later print the old window's numbers next to
// the new window's curve.
//
// Above HOVER_READOUT_POINT_LIMIT points (a trace drawn without downsampling)
// writing a string per point costs more than the draw, so `%{hovertext}` is
// replaced by the d3 `fallback` instead: the right number, the old notation.
//
// The spec is plain data — no functions — so a trace stays serialisable.
//
// Pure: no DOM, no Plotly.

import { readoutFormatter } from './readout-format.js';
import { formatNaturalDuration } from './fft.js';

export const HOVER_READOUT_POINT_LIMIT = 100_000;
export const HOVER_READOUT_TOKEN = '%{hovertext}';

const escapeHtml = text => String(text).replace(/[&<>"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
}[ch]));

const MAPS = {
    // Frequency ↔ period. A zero frequency has an infinite period, which is
    // what the readout prints.
    reciprocal: value => (value === 0 ? Infinity : 1 / Math.abs(value)),
};

// " (1 d 2 h)" after a period of a minute or more, as the spectrum always had.
const SUFFIXES = {
    naturalDuration: value => (Number.isFinite(value) && Math.abs(value) >= 60
        ? ` (${formatNaturalDuration(value, 2)})`
        : ''),
};

const sourceArray = (arrays, line) => {
    const array = arrays[line.source];
    if (!array || typeof array.length !== 'number') return null;
    if (line.index === undefined) return array;
    return { length: array.length, at: i => array[i]?.[line.index] };
};

const valueAt = (array, i) => (typeof array.at === 'function' && !ArrayBuffer.isView(array) && !Array.isArray(array)
    ? array.at(i)
    : array[i]);

/** How many points a trace's readout would have to write. */
export function hoverReadoutLength(spec, arrays) {
    let length = 0;
    for (const line of spec?.lines || []) {
        const array = sourceArray(arrays, line);
        if (array) length = Math.max(length, array.length);
    }
    return length;
}

/**
 * One string per point. Each line is `label = value`, or `value` alone when the
 * line has no label.
 *
 * @param {{lines: object[]}} spec
 * @param {{x?: ArrayLike, y?: ArrayLike, z?: ArrayLike, customdata?: ArrayLike}} arrays
 * @param {{decimal: string}} format
 * @returns {string[]}
 */
export function buildHoverReadoutText(spec, arrays, format) {
    const lines = (spec?.lines || []).map((line) => {
        const array = sourceArray(arrays, line);
        const map = MAPS[line.map] || null;
        const suffix = SUFFIXES[line.suffix] || null;
        const local = line.resolution === 'local';
        const fixedResolution = Number(line.resolution) > 0 ? Number(line.resolution) : null;
        const shared = local ? null : readoutFormatter({
            unit: line.unit, digits: line.digits, resolution: fixedResolution, format,
        });
        const prefix = line.label ? `${line.label} = ` : '';
        return { array, map, suffix, local, shared, prefix, line };
    });
    const length = hoverReadoutLength(spec, arrays);
    const out = new Array(length);
    for (let i = 0; i < length; i++) {
        let text = '';
        for (let k = 0; k < lines.length; k++) {
            const entry = lines[k];
            if (!entry.array) continue;
            const raw = valueAt(entry.array, i);
            const value = raw === null || raw === undefined ? NaN : (entry.map ? entry.map(Number(raw)) : Number(raw));
            let formatted;
            if (entry.local) {
                // The distance to the nearer neighbour: on a non-uniform axis
                // (periods, a zero-padded spectrum window) that is what two
                // adjacent points must not be rounded together across.
                formatted = readoutFormatter({
                    unit: entry.line.unit,
                    digits: entry.line.digits,
                    resolution: localStep(entry, i, value),
                    format,
                })(value);
            } else {
                formatted = entry.shared(value);
            }
            if (k && text) text += '<br>';
            text += entry.prefix + escapeHtml(formatted) + (entry.suffix ? escapeHtml(entry.suffix(value)) : '');
        }
        out[i] = text;
    }
    return out;
}

function localStep(entry, i, value) {
    const neighbour = (j) => {
        const raw = valueAt(entry.array, j);
        if (raw === null || raw === undefined) return NaN;
        return entry.map ? entry.map(Number(raw)) : Number(raw);
    };
    let step = Infinity;
    for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= entry.array.length) continue;
        const other = neighbour(j);
        const gap = Math.abs(other - value);
        if (gap > 0 && gap < step) step = gap;
    }
    return Number.isFinite(step) ? step : null;
}

/**
 * The hovertemplate a trace is drawn with: its own, or — when it has too many
 * points to write a readout for each — the same template with the d3 fallback
 * where the readout would go.
 */
export function hoverReadoutTemplate(template, spec, useFallback) {
    const text = String(template ?? '');
    if (!useFallback || !text.includes(HOVER_READOUT_TOKEN)) return text;
    return text.split(HOVER_READOUT_TOKEN).join(spec?.fallback || '');
}

const READOUT_SOURCES = ['x', 'y', 'z', 'customdata'];
// A restyle of any of these writes the readout again; a new hovertemplate is
// how a relabelled trace asks for it (PlotManager.relabelTimeseriesTraces).
const READOUT_TRIGGERS = [...READOUT_SOURCES, 'hovertemplate'];

/**
 * Write a declared trace's `hovertext` and hovertemplate, in place, from the
 * arrays it carries. A trace without `_hoverReadout` is returned untouched.
 */
export function fillHoverReadout(trace, format) {
    const spec = trace?._hoverReadout;
    if (!spec) return trace;
    // The template with the readout token is the one to come back to after a
    // trace too long for a readout has been drawn with the fallback.
    if (String(trace.hovertemplate ?? '').includes(HOVER_READOUT_TOKEN)) spec.template = trace.hovertemplate;
    const arrays = { x: trace.x, y: trace.y, z: trace.z, customdata: trace.customdata };
    const tooMany = hoverReadoutLength(spec, arrays) > HOVER_READOUT_POINT_LIMIT;
    trace.hovertext = tooMany ? undefined : buildHoverReadoutText(spec, arrays, format);
    trace.hovertemplate = hoverReadoutTemplate(spec.template ?? trace.hovertemplate, spec, tooMany);
    return trace;
}

const isDataArray = value => Array.isArray(value) || ArrayBuffer.isView(value);

/**
 * A `Plotly.restyle(div, update, traces)` update with the readouts of the
 * declared traces it touches written in: when x, y, z or customdata change
 * (or a hovertemplate does), `hovertext` and `hovertemplate` join the update,
 * one entry per trace, the undeclared ones keeping what they have.
 *
 * Plotly's own reading of the update: a data array (x, y, z, customdata) is
 * given per trace as an array of arrays; any other attribute given as an array
 * is one value per trace. Both cycle over the trace list.
 *
 * @param {object[]} data the div's current `data`
 * @param {object} update
 * @param {number|number[]|undefined} traces
 * @param {{decimal: string}} format
 */
export function hoverReadoutRestyle(data, update, traces, format) {
    if (!Array.isArray(data) || !update || typeof update !== 'object') return update;
    if (!READOUT_TRIGGERS.some(key => key in update)) return update;
    const indices = traces === undefined || traces === null
        ? data.map((_, index) => index)
        : (Array.isArray(traces) ? traces : [traces]).map(index => (index < 0 ? data.length + index : index));
    if (!indices.some(index => data[index]?._hoverReadout)) return update;
    const dataValue = (key, k) => {
        if (!(key in update)) return undefined;
        const value = update[key];
        if (!Array.isArray(value)) return value;
        const nested = value.length && (isDataArray(value[0]) || value[0] === null || value[0] === undefined);
        return nested ? value[k % value.length] : value;
    };
    const traceValue = (key, k) => {
        if (!(key in update)) return undefined;
        const value = update[key];
        return Array.isArray(value) ? value[k % value.length] : value;
    };
    const hovertext = [];
    const hovertemplate = [];
    indices.forEach((index, k) => {
        const current = data[index];
        const ownTemplate = traceValue('hovertemplate', k);
        if (!current?._hoverReadout) {
            hovertext.push(current?.hovertext ?? null);
            hovertemplate.push(ownTemplate !== undefined ? ownTemplate : (current?.hovertemplate ?? null));
            return;
        }
        const next = {
            _hoverReadout: current._hoverReadout,
            hovertemplate: ownTemplate !== undefined ? ownTemplate : (current._hoverReadout.template ?? current.hovertemplate),
        };
        for (const key of READOUT_SOURCES) {
            const value = dataValue(key, k);
            next[key] = value !== undefined ? value : current[key];
        }
        fillHoverReadout(next, format);
        hovertext.push(next.hovertext ?? null);
        hovertemplate.push(next.hovertemplate ?? null);
    });
    return { ...update, hovertext, hovertemplate };
}
