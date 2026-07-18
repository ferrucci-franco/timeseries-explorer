import assert from 'node:assert/strict';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';

class FakePlotManager {}
installPlotDataMethods(FakePlotManager);

const manager = new FakePlotManager();
const transform = { gain: 2, yOffset: 5 };
manager.files = new Map([['f1', {
    data: { variables: { signal: { kind: 'variable', data: [1, -2, 3] } } },
    invertedVariables: new Set(['signal']),
}]]);
manager.isVariableSignInverted = (fileId, varName) =>
    manager.files.get(fileId)?.invertedVariables?.has(varName) === true;
manager._fileTransform = () => transform;
manager._getTransformIndexData = () => ({ indexes: null, times: [0, 1, 2] });
manager._transformCache = () => null;

assert.deepEqual(
    manager._getTransformedVariableData('f1', 'signal'),
    [3, 9, -1],
    'sign inversion should happen before the file y-offset',
);

manager.files.get('f1').invertedVariables.clear();
assert.deepEqual(
    manager._getTransformedVariableData('f1', 'signal'),
    [7, 1, 11],
    'restoring the sign should recover the standard file transform',
);

console.log('Variable sign toggle tests passed.');
