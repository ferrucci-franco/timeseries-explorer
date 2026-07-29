import assert from 'node:assert/strict';
import { installDataToolsMethods } from '../src/app/methods/data-tools-methods.js';

class DataToolHarness {
    constructor() {
        this.parser = {
            _detectDataType: () => 'real',
            _isConstantValues: values => {
                const finite = Array.from(values || []).filter(Number.isFinite);
                return finite.length > 0 && finite.every(value => value === finite[0]);
            },
        };
    }
}

installDataToolsMethods(DataToolHarness);

const h = new DataToolHarness();

const closeArray = (actual, expected, label) => {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        if (Number.isNaN(expected[i])) {
            assert.ok(Number.isNaN(actual[i]), `${label}[${i}] expected NaN, got ${actual[i]}`);
        } else {
            assert.ok(Math.abs(actual[i] - expected[i]) < 1e-9, `${label}[${i}] expected ${expected[i]}, got ${actual[i]}`);
        }
    }
};

const numericData = (time, timeKind = 'numeric') => ({
    metadata: { timeName: 'time', timeKind },
    variables: {
        time: { name: 'time', kind: 'abscissa', data: time },
    },
});

const withDocument = (mockDocument, fn) => {
    const previous = globalThis.document;
    globalThis.document = mockDocument;
    try {
        fn();
    } finally {
        if (previous === undefined) delete globalThis.document;
        else globalThis.document = previous;
    }
};

closeArray(
    h._computeDerivativeValues([0, 1, 5, 11], numericData([0, 1, 3, 6]), { method: 'centered' }).values,
    [1, 5 / 3, 2, 2],
    'centered derivative nonuniform numeric time',
);

closeArray(
    h._computeDerivativeValues([0, 2, 6], numericData([0, 1000, 3000], 'datetime'), { method: 'centered' }).values,
    [2, 2, 2],
    'datetime derivative uses seconds',
);

closeArray(
    h._computeDerivativeValues([0, 2, 8], { metadata: { timeKind: 'index' }, variables: {} }, { method: 'forward' }).values,
    [2, 6, 6],
    'index derivative dt equals one sample',
);

closeArray(
    h._computeDerivativeValues([0, 1, 3], numericData([0, 1, 1]), { method: 'forward' }).values,
    [1, NaN, NaN],
    'zero dt derivative returns NaN',
);

closeArray(
    h._computeDerivativeValues([0, NaN, 3], numericData([0, 1, 2]), { method: 'centered' }).values,
    [NaN, 1.5, NaN],
    'derivative propagates NaN on touched interval',
);

// Pure difference: y[i]-y[i-1] with NO division by Δt (first sample forward).
// Applied to the time vector it yields Δt — flat for uniform sampling, 0 at a
// duplicate timestamp, and a spike at a gap — without any divide-by-zero.
closeArray(
    h._computeDerivativeValues([0, 1, 1, 2, 4], numericData([0, 1, 1, 2, 4]), { method: 'difference' }).values,
    [1, 1, 0, 1, 2],
    'difference of the time vector gives Δt (0 at a duplicate, spike at a gap)',
);
// Where the derivative would return NaN (Δt=0), the difference stays finite.
closeArray(
    h._computeDerivativeValues([10, 20, 45], numericData([0, 1, 1]), { method: 'difference' }).values,
    [10, 10, 25],
    'difference never divides by Δt, so a duplicate timestamp does not force NaN',
);

const integral = h._computeIntegralValues([2, 4, 6], numericData([0, 1, 3]), { method: 'trapezoidal' });
closeArray(integral.values, [0, 3, 13], 'trapezoidal integral nonuniform numeric time');
assert.equal(integral.negativeDtCount, 0);

closeArray(
    h._computeIntegralValues([2, 4, 6], numericData([0, 1, 3]), { method: 'rectangular' }).values,
    [0, 2, 10],
    'rectangular integral nonuniform numeric time',
);

closeArray(
    h._computeIntegralValues([2, 4, 6], numericData([0, 1, 2], 'index'), { method: 'rectangular' }).values,
    [0, 2, 6],
    'rectangular integral index axis uses unit dt',
);

closeArray(
    h._computeIntegralValues([1, NaN, 3], numericData([0, 1, 2]), { method: 'trapezoidal' }).values,
    [0, 0, 0],
    'integral skips NaN intervals',
);

const negative = h._computeIntegralValues([1, 1], numericData([1, 0]), { method: 'trapezoidal' });
closeArray(negative.values, [0, -1], 'integral allows negative dt');
assert.equal(negative.negativeDtCount, 1);

closeArray(
    h._computeMovingAverageValues([1, 2, 100, 4, 5], { window: 3 }),
    [1.5, 103 / 3, 106 / 3, 109 / 3, 4.5],
    'centered moving average with partial edges',
);

closeArray(
    h._computeMovingAverageValues([1, NaN, 3], { window: 3 }),
    [1, 2, 3],
    'moving average ignores NaN',
);

const sourceVariable = { name: 'x', kind: 'variable', data: [2, 4, 6] };
const pipelineData = numericData([0, 1, 2], 'index');
const pipeline = h._buildDataToolResult(sourceVariable.data, sourceVariable, {
    sourceName: 'x',
    targetName: 'x avg',
    targetMode: 'create',
    tool: 'integrate',
    params: { method: 'rectangular' },
    steps: [
        { tool: 'movingAverage', params: { window: 2 } },
        { tool: 'integrate', params: { method: 'rectangular' } },
    ],
}, pipelineData);
closeArray(pipeline.variable.data, [0, 3, 8], 'pipeline moving average then rectangular integral');
assert.deepEqual(pipeline.variable.dataTool.steps.map(step => step.tool), ['movingAverage', 'integrate']);

const app = new DataToolHarness();
const chainData = numericData([0, 1, 2], 'index');
chainData.variables.x = { ...sourceVariable };
chainData.variables['x avg'] = h._buildMovingAverageResult(sourceVariable.data, sourceVariable, {
    sourceName: 'x',
    targetName: 'x avg',
    targetMode: 'create',
    tool: 'movingAverage',
    params: { window: 2 },
}).variable;
app.dataToolVariablesByFile = new Map([['file', new Map([['x avg', {
    name: 'x avg',
    tool: 'movingAverage',
    targetMode: 'create',
    sourceName: 'x',
    params: { window: 2 },
}]])]]);
app.plotManager = {
    files: new Map([['file', { data: chainData }]]),
    updateFileData: () => {},
};
app._renderFilteredTree = () => {};
app._syncDataTools = () => {};
app._setOutlierMessage = () => {};

// Chaining is now one row per step: a tool-created variable is simply picked as
// the source of the next one. The dependency walk has to see through the chain,
// because editing or deleting a link has to reach everything below it.
app.dataToolVariablesByFile.get('file').set('x avg int', {
    name: 'x avg int',
    tool: 'integrate',
    targetMode: 'create',
    sourceName: 'x avg',
    params: { method: 'rectangular' },
});
app.dataToolVariablesByFile.get('file').set('x avg int ddt', {
    name: 'x avg int ddt',
    tool: 'derivative',
    targetMode: 'create',
    sourceName: 'x avg int',
    params: { method: 'forward' },
});
assert.deepEqual(
    app._dataToolDependents('file', 'x avg'),
    ['x avg int', 'x avg int ddt'],
    'dependents reach the whole chain, not just the direct child',
);
assert.deepEqual(app._dataToolDependents('file', 'x avg int ddt'), [], 'the last link has no dependents');

app._reapplyDataToolVariables('file', chainData);
closeArray(chainData.variables['x avg'].data, [3, 5, 6], 'chained reapply is stable once');
closeArray(chainData.variables['x avg int'].data, [0, 3, 8], 'the second link reapplies from the first');
closeArray(chainData.variables['x avg int ddt'].data, [3, 5, 5], 'the third link reapplies from the second');
app._reapplyDataToolVariables('file', chainData);
closeArray(chainData.variables['x avg'].data, [3, 5, 6], 'chained reapply does not compound');
closeArray(chainData.variables['x avg int'].data, [0, 3, 8], 'the second link does not compound either');

// The integral's constant of integration. It shifts the whole curve, starting at
// the first sample; leaving it out has to stay identical to the old behaviour.
{
    const initialData = numericData([0, 1, 2, 3], 'index');
    const values = [2, 2, 2, 2];
    const base = h._computeIntegralValues(values, initialData, { method: 'rectangular' });
    closeArray(base.values, [0, 2, 4, 6], 'no initial condition keeps the historical result');

    const offset = h._computeIntegralValues(values, initialData, { method: 'rectangular', initial: 10 });
    closeArray(offset.values, [10, 12, 14, 16], 'the initial condition offsets the whole accumulation');

    const negative = h._computeIntegralValues(values, initialData, { method: 'rectangular', initial: -1.5 });
    closeArray(negative.values, [-1.5, 0.5, 2.5, 4.5], 'a negative initial condition works too');

    // A hole under 'propagate' still poisons everything after it: the offset is a
    // starting point, not a repair.
    const holed = h._computeIntegralValues([2, NaN, 2, 2], initialData, {
        method: 'rectangular',
        initial: 10,
        gapPolicy: 'propagate',
    });
    assert.equal(holed.values[0], 10, 'the initial condition survives at the first sample');
    assert.ok(Number.isNaN(holed.values[3]), 'propagate still marks the tail unknown');

    assert.equal(
        h._normalizeDataToolParams('integrate', { initial: '2.5' }).initial,
        2.5,
        'a numeric string initial condition is accepted',
    );
    assert.equal(
        h._normalizeDataToolParams('integrate', { initial: 'nonsense' }).initial,
        0,
        'an unparseable initial condition falls back to zero',
    );
}

// Renaming moves a key through four places at once. Missing any one of them
// leaves a dangling reference: a definition pointing at a source that no longer
// exists, or a trace drawing a variable that was renamed out from under it.
{
    const renameData = numericData([0, 1, 2], 'index');
    renameData.variables.x = { name: 'x', kind: 'variable', data: [1, 2, 4] };
    renameData.variables['x avg'] = { name: 'x avg', kind: 'variable', data: [1.5, 3, 4] };
    renameData.variables['x avg int'] = { name: 'x avg int', kind: 'variable', data: [0, 1.5, 4.5] };
    const rebuilt = [];
    const renameApp = new DataToolHarness();
    renameApp.dataToolVariablesByFile = new Map([['f', new Map([
        ['x avg', { name: 'x avg', tool: 'movingAverage', targetMode: 'create', sourceName: 'x', params: { window: 2 } }],
        ['x avg int', { name: 'x avg int', tool: 'integrate', targetMode: 'create', sourceName: 'x avg', params: { method: 'rectangular' } }],
    ])]]);
    renameApp.plotManager = {
        files: new Map([['f', { data: renameData }]]),
        plots: new Map([['p1', {
            traces: [{ fileId: 'f', varName: 'x avg' }, { fileId: 'other', varName: 'x avg' }],
            phaseTraces: [{ fileId: 'f', x: 'x', y: 'x avg', z: null }],
        }]]),
        _rebuildPanel: id => rebuilt.push(id),
        updateFileData: () => {},
    };

    renameApp._renameDataToolVariable('f', renameData, 'x avg', 'x smooth');
    const definitions = renameApp.dataToolVariablesByFile.get('f');
    assert.ok(renameData.variables['x smooth'], 'the variable moves to the new key');
    assert.ok(!renameData.variables['x avg'], 'the old key is gone');
    assert.equal(renameData.variables['x smooth'].name, 'x smooth', 'the variable carries its new name');
    assert.ok(definitions.has('x smooth') && !definitions.has('x avg'), 'the definition moves with it');
    assert.equal(definitions.get('x avg int').sourceName, 'x smooth', 'dependents follow the rename');
    const plot = renameApp.plotManager.plots.get('p1');
    assert.equal(plot.traces[0].varName, 'x smooth', 'a plotted trace follows the rename');
    assert.equal(plot.traces[1].varName, 'x avg', 'another file keeping the old name is left alone');
    assert.equal(plot.phaseTraces[0].y, 'x smooth', 'phase-trace axes follow the rename too');
    assert.deepEqual(rebuilt, ['p1'], 'only the touched panel is rebuilt');
}

// Sessions saved before the redesign carry a steps[] pipeline on one variable.
// They still have to load and reapply, which is why the pipeline builder stays.
const legacyData = numericData([0, 1, 2], 'index');
legacyData.variables.x = { name: 'x', kind: 'variable', data: [1, 2, 4] };
app.plotManager.files.set('legacy', { data: legacyData });
app.dataToolVariablesByFile.set('legacy', new Map([['x avg', {
    name: 'x avg',
    targetMode: 'create',
    sourceName: 'x',
    steps: [
        { tool: 'movingAverage', params: { window: 2 } },
        { tool: 'integrate', params: { method: 'rectangular' } },
    ],
}]]));
app._reapplyDataToolVariables('legacy', legacyData);
closeArray(legacyData.variables['x avg'].data, [0, 1.5, 4.5], 'a legacy steps[] pipeline still reapplies');

const modifyData = numericData([0, 1, 2], 'index');
modifyData.variables.y = { name: 'y', kind: 'variable', data: [1, 2, 3] };
app.dataToolVariablesByFile.set('modify', new Map([['y', {
    name: 'y',
    tool: 'integrate',
    targetMode: 'modify',
    sourceName: 'y',
    params: { method: 'rectangular' },
    originalData: [1, 2, 3],
}]]));
app._reapplyDataToolVariables('modify', modifyData);
closeArray(modifyData.variables.y.data, [0, 1, 3], 'modify reapply uses original data once');
app._reapplyDataToolVariables('modify', modifyData);
closeArray(modifyData.variables.y.data, [0, 1, 3], 'modify reapply does not compound');

// ── Integral gap policy: normalization, persistence, warning ──
{
    // The default is the corrected behaviour, not the historical one.
    assert.deepEqual(
        h._normalizeDataToolParams('integrate', {}),
        { method: 'trapezoidal', gapPolicy: 'zero', initial: 0 },
        'integral params default to the zero policy and a zero initial condition',
    );
    assert.equal(
        h._normalizeDataToolParams('integrate', { gapPolicy: 'nonsense' }).gapPolicy,
        'zero',
        'an unknown policy falls back to the default',
    );
    // A session saved before the policy existed carries no gapPolicy. It must
    // land on the default rather than silently reproducing the old result —
    // that result is the bug this change corrects.
    assert.equal(
        h._normalizeDataToolParams('integrate', { method: 'rectangular' }).gapPolicy,
        'zero',
        'a pre-policy session reloads with the corrected default',
    );
    assert.equal(
        h._normalizeDataToolParams('integrate', { gapPolicy: 'propagate' }).gapPolicy,
        'propagate',
        'an explicit policy survives normalization',
    );

    // Params are serialized with a generic deep clone, so the new field has to
    // survive a session round-trip without any extra plumbing.
    assert.equal(
        h._cloneDataToolParams({ method: 'trapezoidal', gapPolicy: 'interpolate' }).gapPolicy,
        'interpolate',
        'the policy survives session serialization',
    );

    // The warning is the thing that stops a gap from being silent, so a result
    // WITH holes must never come back with an empty message. The quantity is
    // how much of the span has no data — a property of the FILE, so the same
    // under every policy; only the sentence after it changes.
    const holes = {
        negativeDtCount: 0, gapCount: 1, nanSegmentCount: 22,
        uncoveredTime: 1320, timeKind: 'datetime',
    };
    const messages = new Set();
    for (const gapPolicy of ['zero', 'interpolate', 'propagate']) {
        const text = h._integralWarning(holes, { gapPolicy });
        assert.ok(text, `${gapPolicy}: a hole always produces a warning`);
        assert.ok(text.includes('22 min'), `${gapPolicy}: names the uncovered span as a duration`);
        assert.ok(!/\{time\}/.test(text), `${gapPolicy}: the placeholder is filled in`);
        messages.add(text);
    }
    assert.equal(messages.size, 3, 'each policy explains its own claim');

    // A duration is only true on a datetime axis. Row numbers are not hours.
    assert.equal(h._formatUncoveredTime({ uncoveredTime: 4800, timeKind: 'datetime' }), '1 h 20 min');
    assert.equal(h._formatUncoveredTime({ uncoveredTime: 190800, timeKind: 'datetime' }), '2 d 5 h');
    assert.equal(h._formatUncoveredTime({ uncoveredTime: 90, timeKind: 'datetime' }), '1 min 30 s');
    assert.match(h._formatUncoveredTime({ uncoveredTime: 80, timeKind: 'index' }), /80/);
    assert.ok(!/min|h\b|\bd\b/.test(h._formatUncoveredTime({ uncoveredTime: 80, timeKind: 'index' })),
        'an index axis counts samples, it does not invent a duration');
    assert.equal(h._formatUncoveredTime({ uncoveredTime: 1320, timeKind: 'numeric' }), '1320',
        'a numeric axis carries its column unit, so the bare number is all we can say');

    // The panel message is written imperatively, so the data-i18n sweep never
    // sees it: a message already on screen has to be produced AGAIN when the
    // language changes, which means storing how to build it, not the text.
    {
        const el = { textContent: '', className: '' };
        const host = Object.create(Object.getPrototypeOf(h));
        host._renderDataToolMessage = h._renderDataToolMessage;
        host._setOutlierMessage = h._setOutlierMessage;
        // Stand in for document.getElementById without a DOM.
        const originalDoc = globalThis.document;
        globalThis.document = { getElementById: (id) => (id === 'outlier-message' ? el : null) };
        try {
            let lang = 'en';
            host._setOutlierMessage(() => `msg-${lang}`, 'error');
            assert.equal(el.textContent, 'msg-en', 'a function message renders immediately');
            lang = 'es';
            host._renderDataToolMessage();
            assert.equal(el.textContent, 'msg-es', 'and is produced again on a language switch');

            // A plain string is text nobody translated (an exception message):
            // it must survive re-rendering rather than vanish.
            host._setOutlierMessage('boom', 'error');
            host._renderDataToolMessage();
            assert.equal(el.textContent, 'boom', 'a plain string message is kept as-is');
        } finally {
            globalThis.document = originalDoc;
        }
    }

    // Clean data stays quiet.
    assert.equal(
        h._integralWarning({ negativeDtCount: 0, gapCount: 0, nanSegmentCount: 0 }, { gapPolicy: 'zero' }),
        '',
        'no holes means no warning',
    );
    // The pre-existing negative-dt warning still fires, and coexists.
    const both = h._integralWarning(
        { negativeDtCount: 6, gapCount: 1, nanSegmentCount: 0 },
        { gapPolicy: 'zero' },
    );
    assert.ok(both.includes('6'), 'the negative-dt warning survives');
    assert.ok(both.length > 40, 'and is joined with the gap warning rather than replacing it');
}

console.log('data tools logic tests passed');
