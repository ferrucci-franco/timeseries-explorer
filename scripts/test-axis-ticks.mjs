// Tick labels never collide, on any axis the app names itself.
//
// Plotly thins the labels of an automatic axis; an axis given its own
// tickvals/ticktext draws every one of them, however little room there is.
// src/utils/axis-ticks.js is the thinning those axes do instead, and every
// plot builder that writes `tickmode: 'array'` has to go through it — checked
// here over the sources so a new crowded axis cannot be added quietly.
//
//   node scripts/test-axis-ticks.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    AXIS_TICK_LABEL_HEIGHT_PX,
    AXIS_TICK_LABEL_WIDTH_PX,
    AXIS_TICK_LABEL_WIDTH_ROTATED_PX,
    axisTickCapacity,
    fitAxisTicks,
} from '../src/utils/axis-ticks.js';

const hours = Array.from({ length: 24 }, (_, index) => index);
const hourLabels = hours.map(hour => `${String(hour).padStart(2, '0')}:00`);

// How many fit: never fewer than two, and an unusable size thins nothing.
{
    assert.equal(axisTickCapacity(300, 15), 20);
    assert.equal(axisTickCapacity(100, 15), 6);
    assert.equal(axisTickCapacity(10, 15), 2, 'a tiny pane still shows two labels');
    assert.equal(axisTickCapacity(0, 15), Infinity, 'an unmeasured pane thins nothing');
    assert.equal(axisTickCapacity(300, 0), Infinity);
    assert.equal(axisTickCapacity(NaN, 15), Infinity);
    // Unless the caller knows what its axis can take before it is laid out:
    // a figure is built before its pane has a width on the first paint.
    assert.equal(axisTickCapacity(0, 15, 12), 12, 'an unmeasured pane falls back to what the caller says');
    assert.equal(axisTickCapacity(300, 15, 12), 20, 'and a measured one ignores the fallback');
    const unmeasured = fitAxisTicks(hours, hourLabels, { sizePx: 0, labelPx: 15, fallbackCapacity: 12 });
    assert.equal(unmeasured.tickvals.length, 12);
}

// The reported bug: two stacked Heatmaps leave each subplot ~160 px, and all
// 24 hour labels were drawn into it.
{
    const roomy = fitAxisTicks(hours, hourLabels, { sizePx: 700, labelPx: AXIS_TICK_LABEL_HEIGHT_PX });
    assert.equal(roomy.stride, 1, 'a tall subplot keeps every hour');
    assert.deepEqual(roomy.ticktext, hourLabels);

    const cramped = fitAxisTicks(hours, hourLabels, { sizePx: 160, labelPx: AXIS_TICK_LABEL_HEIGHT_PX });
    assert.ok(cramped.tickvals.length * AXIS_TICK_LABEL_HEIGHT_PX <= 160, 'what is drawn fits the room there is');
    assert.deepEqual(cramped.tickvals, [0, 3, 6, 9, 12, 15, 18, 21], 'and the hours kept are evenly spaced');
    assert.deepEqual(cramped.ticktext, ['00:00', '03:00', '06:00', '09:00', '12:00', '15:00', '18:00', '21:00']);

    // A quarter-hour row (96 of them) in the same subplot.
    const quarters = Array.from({ length: 96 }, (_, index) => index);
    const tight = fitAxisTicks(quarters, quarters.map(String), { sizePx: 160, labelPx: AXIS_TICK_LABEL_HEIGHT_PX });
    assert.ok(tight.tickvals.length <= 160 / AXIS_TICK_LABEL_HEIGHT_PX);
    assert.equal(tight.tickvals[0], 0, 'the first tick is always kept');
}

// Dates along the bottom of a Heatmap: a year of columns in a narrow pane.
{
    const days = Array.from({ length: 365 }, (_, index) => index);
    const labels = days.map(day => `2024-${String(day).padStart(3, '0')}`);
    const wide = fitAxisTicks(days, labels, { sizePx: 1200, labelPx: AXIS_TICK_LABEL_WIDTH_ROTATED_PX });
    assert.ok(wide.tickvals.length <= 40 && wide.tickvals.length > 1);
    const narrow = fitAxisTicks(days, labels, { sizePx: 240, labelPx: AXIS_TICK_LABEL_WIDTH_PX });
    assert.ok(narrow.tickvals.length <= Math.floor(240 / AXIS_TICK_LABEL_WIDTH_PX) + 1, 'a narrow pane drops more');
    assert.ok(narrow.tickvals.length >= 2);
}

// Degenerate inputs answer with something a layout can use.
{
    assert.deepEqual(fitAxisTicks([], [], { sizePx: 100, labelPx: 15 }), { tickvals: [], ticktext: [], stride: 1 });
    assert.deepEqual(fitAxisTicks(null, null, { sizePx: 100, labelPx: 15 }), { tickvals: [], ticktext: null, stride: 1 });
    const unlabelled = fitAxisTicks(hours, null, { sizePx: 60, labelPx: 15 });
    assert.equal(unlabelled.ticktext, null, 'values with no labels stay values with no labels');
    assert.equal(unlabelled.tickvals.length, 4);
}

// Every axis that names its own ticks is thinned. A `tickmode: 'array'` that
// does not go through fitAxisTicks (or pick its own small, bounded tick list)
// is how the crowded labels came back the last time.
{
    const allowed = new Map([
        // Five fixed ticks on a correlation axis that is always -1..1.
        ['src/plots/methods/correlation-methods.js', 'a fixed five-tick scale'],
        // _durationTickValues picks at most eight round values for the span.
        ['src/plots/methods/data-methods.js', 'at most eight values chosen for the span'],
        // periodTickValues does the same for the FFT period axis.
        ['src/plots/methods/fft-methods.js', 'period ticks chosen for the span'],
        // Relays a config built elsewhere (data-methods, fft-methods).
        ['src/plots/methods/interaction-methods.js', 'relays a config built elsewhere'],
    ]);
    const thinned = ['src/plots/methods/heatmap-methods.js', 'src/plots/methods/temporal-profile-methods.js'];
    for (const file of thinned) {
        const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
        assert.match(source, /fitAxisTicks\(/, `${file} thins the ticks it names`);
    }
    for (const [file, why] of allowed) {
        const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
        assert.ok(source.includes('tickvals'), `${file} still names ticks (${why})`);
    }
}

console.log('Axis tick tests passed.');
