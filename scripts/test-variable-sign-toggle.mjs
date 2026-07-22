import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { expandedAxisRangeForExtent, installPlotDataMethods } from '../src/plots/methods/data-methods.js';

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

const treeMethodsSource = await readFile(
    new URL('../src/app/methods/tree-methods.js', import.meta.url),
    'utf8',
);
const signClickHandler = treeMethodsSource.match(
    /signToggle\.addEventListener\('click',[\s\S]*?\n\s*}\);/,
)?.[0] || '';
assert.match(signClickHandler, /_syncVariableSignToggle\(signToggle, nextInverted\)/,
    'sign toggle updates the clicked button in place');
assert.doesNotMatch(signClickHandler, /_renderFilteredTree/,
    'sign toggle must not rebuild and collapse the expanded variable tree');

assert.deepEqual(
    expandedAxisRangeForExtent([0, 10], { min: -8, max: -2 }),
    [-8.9, 10],
    'a sign flip expands only the newly exceeded side of the existing Y range',
);

const plotManagerSource = await readFile(
    new URL('../src/plots/plot-manager.js', import.meta.url),
    'utf8',
);
const signSetter = plotManagerSource.match(
    /setVariableSignInverted\(fileId, varName, inverted\)[\s\S]*?\n    setExampleLayout/,
)?.[0] || '';
assert.match(signSetter, /_expandCapturedTimeYForVariable\(plot, restoreView, fileId, varName\)/,
    'sign changes expand the captured time-pane Y range before rebuilding');
assert.doesNotMatch(
    plotManagerSource.match(/_expandCapturedTimeYForVariable[\s\S]*?\n    setExampleLayout/)?.[0] || '',
    /view\.xRange\s*=/,
    'sign-driven Y expansion never changes the captured X range',
);

console.log('Variable sign toggle tests passed.');
