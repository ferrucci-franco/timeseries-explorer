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

console.log('data tools logic tests passed');
