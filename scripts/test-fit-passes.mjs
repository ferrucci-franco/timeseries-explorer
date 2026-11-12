// Every curve-fit model gives the same numbers, bit for bit, whether its
// passes run over whole arrays (an in-memory file) or over a stream of chunks
// (a lazy file, src/plots/methods/fit-lazy-methods.js).
//
//   node scripts/test-fit-passes.mjs
//
// For each model, on clean and noisy data with holes, below and above the
// exponential kernel's subset size (20 000 rows): fitPair on the arrays
// against runPassesOnChunks over random chunk sizes — with the rows read
// again on every pass, kept after the second pass, and kept only under a
// limit the data is past. Also: the residual decimation fed point by point
// equals decimateMinMax, and the drivers hand passes over in order.
import assert from 'node:assert/strict';
import { fitPair, fitSteps } from '../src/utils/regression.js';
import { runPassesOnArrays, runPassesOnChunks } from '../src/utils/fit-passes.js';
import { createMinMaxDecimator, decimateMinMax } from '../src/plots/curve-fit-state.js';

let seed = 11;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

function assertSame(got, want, label) {
    if (typeof want === 'number' || typeof got === 'number') {
        assert.ok(Object.is(got, want), `${label}: ${got}, on the arrays ${want}`);
        return;
    }
    if (want && typeof want === 'object') {
        for (const key of new Set([...Object.keys(want), ...Object.keys(got || {})])) assertSame(got?.[key], want[key], `${label}.${key}`);
        return;
    }
    assert.equal(got, want, label);
}

const chunked = (model, x, y, options) => runPassesOnChunks(fitSteps(model, options), async (pass) => {
    let i = 0;
    if (!x.length) pass.chunk(x, y);
    while (i < x.length) {
        const k = 1 + Math.floor(random() * 5000);
        pass.chunk(x.subarray(i, i + k), y.subarray(i, i + k));
        i += k;
    }
});

const MODELS = ['linear', 'quadratic', 'power', 'exponential', 'exponential-offset', 'first-order', 'first-order-offset'];
let cases = 0;
for (const n of [0, 3, 400, 20000, 20001, 45013]) {
    for (const shape of ['decay', 'rise']) {
        const x = new Float64Array(n);
        const y = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            x[i] = 0.25 + i * 0.01;
            y[i] = shape === 'decay'
                ? 3 + 5 * Math.exp(-x[i] / (n * 0.004 + 0.1)) + (random() - 0.5) * 0.05
                : 2 * (1 - Math.exp(-x[i] / (n * 0.003 + 0.05))) + (random() - 0.5) * 0.02;
            if (random() < 0.01) y[i] = NaN;
            if (random() < 0.004) x[i] = Infinity;
        }
        for (const model of MODELS) {
            const want = fitPair(model, x, y);
            const label = `${model}, ${n} rows, ${shape}`;
            assertSame(await chunked(model, x, y), want, `${label}, read on every pass`);
            assertSame(await chunked(model, x, y, { keepRows: true }), want, `${label}, kept`);
            assertSame(await chunked(model, x, y, { keepRows: 30000 }), want, `${label}, kept under 30 000`);
            assertSame(runPassesOnArrays(fitSteps(model), x, y), want, `${label}, arrays without keeping`);
            cases++;
        }
    }
}
assert.equal(fitSteps('nonsense'), null, 'an unknown model has no passes');
assert.equal(fitPair('nonsense', [1], [1]), null);

// The decimation of residuals, point by point.
for (const n of [0, 5, 4000, 4001, 9999, 123457]) {
    const x = Float64Array.from({ length: n }, (_, i) => i * 0.5);
    const y = Float64Array.from({ length: n }, () => (random() < 0.05 ? NaN : (random() < 0.3 ? 1 : random())));
    const decimator = createMinMaxDecimator(n, 2000);
    for (let i = 0; i < n; i++) decimator.push(x[i], y[i]);
    assert.deepEqual(decimator.result(), decimateMinMax(x, y, 2000), `decimation of ${n} points`);
}

// The chunk driver hands the passes over in order and waits for each.
{
    const order = [];
    const steps = (function* () {
        order.push('first');
        yield { chunk() { order.push('chunk 1'); } };
        order.push('second');
        yield { chunk() { order.push('chunk 2'); } };
        return 'done';
    })();
    const result = await runPassesOnChunks(steps, async (pass, index) => {
        await Promise.resolve();
        order.push(`pass ${index}`);
        pass.chunk();
    });
    assert.equal(result, 'done');
    assert.deepEqual(order, ['first', 'pass 0', 'chunk 1', 'second', 'pass 1', 'chunk 2']);
}

console.log(`fit passes: ${cases} model cases, the same on arrays and on chunks`);
