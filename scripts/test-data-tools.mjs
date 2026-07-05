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

withDocument({
    querySelector: () => null,
    querySelectorAll: () => [],
}, () => {
    assert.equal(h._getOutlierTargetMode(), '', 'data tool target mode starts unselected');
});

withDocument({
    querySelector: () => ({ value: 'modify' }),
    querySelectorAll: () => [],
}, () => {
    assert.equal(h._getOutlierTargetMode(), 'modify', 'modify target mode is explicit');
});

withDocument({
    querySelector: () => ({ value: 'create' }),
    querySelectorAll: () => [],
}, () => {
    assert.equal(h._getOutlierTargetMode(), 'create', 'create target mode is explicit');
});

const targetModeRadios = [{ checked: true }, { checked: true }];
withDocument({
    querySelector: () => null,
    querySelectorAll: () => targetModeRadios,
}, () => {
    h._clearDataToolTargetMode();
    assert.deepEqual(targetModeRadios.map(input => input.checked), [false, false], 'target mode clear unchecks all radios');
});

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

const appended = app._applyDataToolModifyMode({
    fileId: 'file',
    data: chainData,
    sourceName: 'x avg',
    sourceVariable: chainData.variables['x avg'],
    tool: 'integrate',
}, {
    tool: 'integrate',
    params: { method: 'rectangular' },
}, { silent: true });
assert.ok(appended, 'append tool to created variable succeeds');
closeArray(chainData.variables['x avg'].data, [0, 3, 8], 'modify created variable appends pipeline step');
const chainedDefinition = app.dataToolVariablesByFile.get('file').get('x avg');
assert.equal(chainedDefinition.targetMode, 'create');
assert.equal(chainedDefinition.sourceName, 'x');
assert.deepEqual(chainedDefinition.steps.map(step => step.tool), ['movingAverage', 'integrate']);
app._reapplyDataToolVariables('file', chainData);
closeArray(chainData.variables['x avg'].data, [0, 3, 8], 'pipeline reapply is stable once');
app._reapplyDataToolVariables('file', chainData);
closeArray(chainData.variables['x avg'].data, [0, 3, 8], 'pipeline reapply is stable twice');

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

console.log('data tools logic tests passed');
