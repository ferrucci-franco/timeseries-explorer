import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(
    new URL('../src/plots/methods/state-methods.js', import.meta.url),
    'utf8',
);
const managerSource = readFileSync(
    new URL('../src/plots/plot-manager.js', import.meta.url),
    'utf8',
);

const isolate = name => {
    const start = source.indexOf(`proto.${name} = function`);
    const end = source.indexOf('\n};', start) + 3;
    assert.ok(start >= 0 && end > start, `${name} can be isolated`);
    const proto = {};
    vm.runInNewContext(source.slice(start, end), { proto });
    return proto[name];
};

const length = 100_000_000;
let sourceReads = 0;
const makeSeries = offset => new Proxy({ length }, {
    get(target, key) {
        if (key in target) return target[key];
        const index = Number(key);
        if (Number.isInteger(index)) {
            sourceReads++;
            return offset + index;
        }
        return undefined;
    },
});

const downsampleStrideIndexes = (sourceLength, target) => {
    if (sourceLength <= target) return Array.from({ length: sourceLength }, (_, i) => i);
    const last = sourceLength - 1;
    const indexes = [0];
    const innerTarget = target - 2;
    for (let i = 1; i <= innerTarget; i++) {
        const index = Math.round((i * last) / (innerTarget + 1));
        if (index > indexes.at(-1) && index < last) indexes.push(index);
    }
    indexes.push(last);
    return indexes;
};
const pickIndexed = (values, indexes) => indexes.map(index => values[index]);
const harness = {
    _phaseTargetInfo: () => ({ limit: 4000 }),
    _downsampleStrideIndexes: downsampleStrideIndexes,
    _pickIndexed: pickIndexed,
};

const partial = isolate('_stateAnimPartialVisual').call(
    harness,
    [makeSeries(0), makeSeries(10), makeSeries(20)],
    length,
);
assert.equal(partial[0].length, 4000);
assert.equal(partial[1].length, 4000);
assert.equal(partial[2].length, 4000);
assert.ok(sourceReads <= 12_000, `partial trajectory reads only visual points (${sourceReads})`);
assert.equal(partial[0][0], 0);
assert.equal(partial[0].at(-1), length - 1);

sourceReads = 0;
const visualData = isolate('_stateAnimVisualData').call({
    files: new Map([['huge', {
        data: {
            variables: { x: {}, y: {}, z: {} },
        },
    }]]),
    _getTransformedVariableData: (_fileId, name) => makeSeries(name.charCodeAt(0)),
    _buildPhaseVisualSeries: series => {
        const indexes = downsampleStrideIndexes(length, 4000);
        return series.map(values => pickIndexed(values, indexes));
    },
}, {
    stateSlots: { fileId: 'huge', x: ['x', 'y', 'z'] },
});
assert.equal(visualData.x.length, 4000);
assert.equal(visualData.y.length, 4000);
assert.equal(visualData.z.length, 4000);
assert.ok(sourceReads <= 12_000, `full trajectory reads only visual points (${sourceReads})`);

assert.match(source, /_yieldForDetailIndicatorPaint\?\.\(\)/, 'controls paint before rendering');
assert.match(source, /_setEagerDetailLoading\?\.\(plot, true, panelEl\)/, 'render exposes loading status');
assert.match(source, /plot\._stateAnimRenderToken !== renderToken/, 'superseded renders stop before plotting');
assert.match(managerSource, /plot\._stateAnimRenderToken = \(plot\._stateAnimRenderToken \|\| 0\) \+ 1/,
    'closing the panel invalidates deferred State Animation work');
assert.match(source, /_buildStateAnimTraces[\s\S]*const visual = this\._stateAnimVisualData\(plot\)/);
assert.match(source, /_buildStateAnimLayout[\s\S]*const visual = this\._stateAnimVisualData\(plot\)/);
assert.match(source, /_stateAnimPartialVisual\(\[xAll, yAll, zAll\], frame \+ 1\)/);
assert.match(source, /_stateAnimPartialVisual\(\[xAll, yAll\], frame \+ 1\)/);
assert.match(source, /this\._lowerBound\(timeData, targetSimTime\)/, 'playback jumps with binary search');
assert.doesNotMatch(source, /while \(nextFrame < nPts - 1/, 'playback no longer walks every skipped sample');
assert.match(source, /renderNow - plot\._lastPlotlyUpdate < 80/, 'animation redraws are throttled');

console.log('State Animation responsiveness checks passed.');
