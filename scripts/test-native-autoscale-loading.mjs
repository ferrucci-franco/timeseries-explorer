import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const interaction = readFileSync(
    new URL('../src/plots/methods/interaction-methods.js', import.meta.url),
    'utf8',
);
const start = interaction.indexOf('proto._runWithEagerDetailLoading = function(panelId, work) {');
const end = interaction.indexOf('\nproto._setLazyDetailLoading = function(', start);
assert.ok(start >= 0 && end > start, 'native autoscale guard methods are present');

const proto = {};
vm.runInNewContext(interaction.slice(start, end), {
    proto,
    performance: { now: () => 1000 },
});

const listeners = new Map();
const div = {
    contains: node => node === modebarButton,
    querySelectorAll: selector => selector === '.modebar-btn' ? [modebarButton] : [],
    addEventListener(type, listener, options) {
        assert.equal(options?.capture, true, `${type} guard runs in capture phase`);
        listeners.set(type, listener);
    },
};
const modebarButton = {
    __data__: { name: 'autoScale2d' },
    dataset: {},
    closest: selector => selector === '.modebar-btn' ? modebarButton : null,
    getAttribute: () => '',
};
const plotTarget = {
    closest: () => null,
};
const plot = { mode: 'timeseries', traces: [] };
const events = [];
let releasePaint;

const harness = {
    plots: new Map([['panel', plot]]),
    _timeseriesNeedsEagerDetailLoading: () => true,
    _setEagerDetailLoading(_plot, loading) {
        events.push(loading ? 'show' : 'hide');
    },
    _yieldForDetailIndicatorPaint() {
        events.push('yield');
        return new Promise(resolve => {
            releasePaint = () => {
                events.push('paint');
                resolve();
            };
        });
    },
    _autoScalePlot() {
        events.push('autoscale');
    },
    _eventInsidePlotArea: () => true,
};
for (const [name, method] of Object.entries(proto)) harness[name] = method;
harness._installEagerTimeseriesAutoscaleGuards('panel', plot, div);

for (const type of ['mousedown', 'click', 'mouseup', 'dblclick']) {
    assert.equal(typeof listeners.get(type), 'function', `${type} is intercepted`);
}

function fakeEvent(overrides = {}) {
    const calls = [];
    return {
        button: 0,
        detail: 1,
        target: plotTarget,
        preventDefault: () => calls.push('preventDefault'),
        stopPropagation: () => calls.push('stopPropagation'),
        stopImmediatePropagation: () => calls.push('stopImmediatePropagation'),
        calls,
        ...overrides,
    };
}

async function finishAutoscale(expectedPrefix) {
    assert.deepEqual(events, expectedPrefix, 'loading is visible before autoscale begins');
    releasePaint();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(
        events.slice(-3),
        ['paint', 'autoscale', 'hide'],
        'autoscale starts only after the loading indicator has painted',
    );
    assert.equal(plot._eagerNativeAutoscalePending, false, 'native autoscale guard is ready again');
}

// Plotly starts native double-click autorange on the second mousedown. The
// capture guard must cancel that event immediately and own the replacement.
{
    const event = fakeEvent({ detail: 2 });
    listeners.get('mousedown')(event);
    assert.deepEqual(
        event.calls,
        ['preventDefault', 'stopPropagation', 'stopImmediatePropagation'],
        'second mousedown is stopped before Plotly sees it',
    );
    await finishAutoscale(['show', 'yield']);
}

events.length = 0;

// Plotly's own modebar autoscale button must follow the identical painted path.
{
    const modebarTarget = {
        closest(selector) {
            if (selector === '.modebar-btn') return modebarButton;
            if (selector === '.modebar') return {};
            return null;
        },
    };
    const event = fakeEvent({ target: modebarTarget });
    listeners.get('click')(event);
    assert.deepEqual(
        event.calls,
        ['preventDefault', 'stopPropagation', 'stopImmediatePropagation'],
        'modebar autoscale click is stopped before Plotly sees it',
    );
    await finishAutoscale(['show', 'yield']);
}

const manager = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
const installAt = manager.indexOf('this._installEagerTimeseriesAutoscaleGuards(panelId, plot, div)');
const newPlotAt = manager.indexOf('Plotly.newPlot(div, traces, layout, config)', installAt);
assert.ok(installAt >= 0 && newPlotAt > installAt, 'capture guards are installed before Plotly handlers');

console.log('Native timeseries autoscale loading tests passed.');
