// sum() and mean() for derived variables.
//
//   node scripts/test-derived-sum-mean.mjs
//
// Asked for by someone adding up ten signals with long names: `a + b + … + j`
// is ten names and nine pluses, and the expanded formula editor builds it from
// a selection of variables in one click. sum(a, b, c) is exactly a + b + c,
// sample by sample — NaN in, NaN out, as through + — and mean is that sum over
// the number of operands. Both take a list too, like min() and max().
import assert from 'node:assert/strict';

import { compileFormula } from '../src/expr/compile.js';
import { DERIVED_FUNCTIONS, DERIVED_FUNCTION_ALIASES } from '../src/app/constants.js';

const n = 5;
const series = values => ({ kind: 'variable', data: Float64Array.from(values) });
const variables = {
    a: series([1, 2, 3, NaN, -1]),
    b: series([10, 20, 30, 40, -10]),
    'long signal name': series([100, 200, 300, 400, -100]),
    k: { kind: 'parameter', data: [0.5] },
};
const classify = name => (variables[name].kind === 'parameter' ? 'scalar' : 'series');
const run = formula => {
    const compiled = compileFormula(formula, variables, classify);
    const columns = {};
    const scalars = {};
    for (const name of compiled.names) {
        if (classify(name) === 'scalar') scalars[name] = Number(variables[name].data[0]);
        else columns[name] = variables[name].data;
    }
    return Array.from(compiled.run(columns, scalars, n));
};
const same = (got, want, label) => {
    assert.equal(got.length, want.length, label);
    got.forEach((v, i) => {
        if (Number.isNaN(want[i])) assert.ok(Number.isNaN(v), `${label}[${i}] is NaN`);
        else assert.ok(Math.abs(v - want[i]) < 1e-12, `${label}[${i}]: ${v} vs ${want[i]}`);
    });
};

// The function is the + chain it stands for, in every shape.
const chain = run('a + b + `long signal name`');
same(run('sum(a, b, `long signal name`)'), chain, 'sum(a, b, c)');
same(run('sum([a, b, `long signal name`])'), chain, 'sum([a, b, c])');
same(run('sum([a, b], `long signal name`)'), chain, 'a list and an operand');
same(run('sum(a)'), run('a'), 'one operand is itself');
same(run('sum(a, k, 2)'), run('a + k + 2'), 'constants and parameters');
assert.ok(Number.isNaN(run('sum(a, b)')[3]), 'NaN in any operand gives NaN, as through +');

same(run('mean(a, b)'), run('(a + b) / 2'), 'mean of two');
same(run('mean([a, b, `long signal name`])'), run('(a + b + `long signal name`) / 3'), 'mean of a list');
same(run('avg(a, b)'), run('mean(a, b)'), 'avg is mean');
same(run('average(a, b)'), run('mean(a, b)'), 'average is mean');
same(run('2 * sum(a, b) - mean(a, b)'), run('2 * (a + b) - (a + b) / 2'), 'inside a larger formula');

// Case-insensitive, like every function name.
same(run('SUM(a, b)'), run('a + b'), 'SUM');

// What it refuses.
assert.throws(() => run('sum()'), /sum\(\) expects at least one operand/);
assert.throws(() => run('mean([])'), /mean\(\) expects at least one operand/);
assert.throws(() => run('sqrt([a, b])'), /list can only be used inside min\(\), max\(\), sum\(\) and mean\(\)/);

// Offered like the others: the autocomplete and the editor's palette read this list.
assert.ok(DERIVED_FUNCTIONS.some(fn => fn.name === 'sum' && fn.minArity === 1));
assert.ok(DERIVED_FUNCTIONS.some(fn => fn.name === 'mean' && fn.minArity === 1));
assert.equal(DERIVED_FUNCTION_ALIASES.get('avg'), 'mean');

console.log('derived sum/mean: ok');
