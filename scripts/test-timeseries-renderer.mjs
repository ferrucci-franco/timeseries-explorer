// Which renderer a time-series trace asks for.
//
// Plotly draws a trace either as SVG (`scatter`) or through WebGL
// (`scattergl`). GL is worth a context when there are a lot of points ON
// SCREEN — and the panel decimates to `timeseriesVisualMaxPoints` for the
// visible window before Plotly sees anything, so a multi-million-sample file
// usually arrives as ~2,000 points. Choosing by the source length instead
// built a GL context on every redraw to draw those 2,000 points, which a CPU
// profile showed was the whole cost of a live preview on a minute of audio.
//
// So: judge by what is drawn. With the visual limit off, or set above the
// threshold, the full series really is drawn and GL comes back.
import assert from 'node:assert/strict';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';

const FILE_ID = 'renderer-fixture';
const THRESHOLD = 50000;

class Harness {
    static GL_POINT_THRESHOLD = THRESHOLD;

    constructor(count, { visualMaxPoints = 2000 } = {}) {
        this.activeFileId = FILE_ID;
        this.language = 'en';
        this.timeseriesVisualMaxPoints = visualMaxPoints;
        const time = Float64Array.from({ length: count }, (_, i) => i * 0.001);
        const values = Float64Array.from({ length: count }, (_, i) => Math.sin(i * 0.01));
        this.files = new Map([[FILE_ID, {
            name: 'renderer-fixture.csv',
            transform: {},
            data: {
                metadata: { timeName: 'time' },
                variables: {
                    time: { name: 'time', kind: 'abscissa', timeKind: 'numeric', description: 'Time [s]', data: time },
                    y: { name: 'y', kind: 'variable', dataType: 'real', description: 'Signal [V]', data: values },
                },
            },
        }]]);
    }

    _getTimeVar(fileId = this.activeFileId) {
        const data = this.files.get(fileId)?.data;
        return data?.variables?.[data.metadata.timeName] ?? null;
    }

    _isVisible(trace) { return trace?.visible !== false && trace?.visible !== 'legendonly'; }
    _extractUnit(description = '') { return /\[([^\]]+)\]/.exec(description)?.[1] || ''; }
    _traceName(name) { return name; }
    _escapeHTML(value) { return String(value); }
    _formatHTMLNumber(value) { return String(value); }
}

installPlotDataMethods(Harness);

const plot = { mode: 'timeseries', traces: [], timeseriesStacked: false, timeseriesY2Enabled: false };
const build = (harness, state = {}) => {
    const trace = { fileId: FILE_ID, varName: 'y', color: '#2196f3', ...state };
    plot.traces = [trace];
    return harness._buildTimeTrace(trace, null, plot, 0);
};

{
    // The case that matters: far more samples than the threshold, decimated to
    // 2,000 points. SVG draws those 2,000; a GL context would be built for them.
    const harness = new Harness(300_000, { visualMaxPoints: 2000 });
    const trace = build(harness);
    assert.ok(trace.x.length <= 2000, `decimated to the visual limit (got ${trace.x.length})`);
    assert.equal(trace.type, 'scatter', 'a decimated trace is drawn as SVG, however long the file');
    assert.equal(trace.line.shape, 'linear', 'and carries the SVG line shape');
}

{
    // No visual limit: the full series reaches Plotly, so GL is right.
    const harness = new Harness(300_000, { visualMaxPoints: null });
    const trace = build(harness);
    assert.equal(trace.x.length, 300_000, 'nothing is decimated');
    assert.equal(trace.type, 'scattergl', 'a long drawn trace asks for WebGL');
}

{
    // A visual limit above the threshold is still a lot of points on screen.
    const harness = new Harness(300_000, { visualMaxPoints: THRESHOLD + 1000 });
    const trace = build(harness);
    assert.ok(trace.x.length >= THRESHOLD, `drawn points above the threshold (got ${trace.x.length})`);
    assert.equal(trace.type, 'scattergl', 'judged by what is drawn, not by the file');
}

{
    // A short file was SVG before and stays SVG.
    const harness = new Harness(1000);
    assert.equal(build(harness).type, 'scatter', 'a short series is SVG');
}

{
    // Step traces skip the decimation (their shape is an SVG line shape) and
    // must never be handed to WebGL, which cannot draw 'hv'.
    const harness = new Harness(300_000, { visualMaxPoints: null });
    const trace = build(harness, { lineShape: 'hv' });
    assert.equal(trace.type, 'scatter', 'a step trace stays SVG');
    assert.equal(trace.line.shape, 'hv', 'and keeps its shape');
}

{
    // The data-tool preview draws a dashed curve. scattergl ignores `dash`, so
    // being SVG is what makes the dash visible at all.
    const harness = new Harness(300_000, { visualMaxPoints: 2000 });
    const trace = build(harness, { dash: 'dash' });
    assert.equal(trace.type, 'scatter');
    assert.equal(trace.line.dash, 'dash', 'the dashed preview renders as asked');
}

console.log('timeseries renderer tests passed');
