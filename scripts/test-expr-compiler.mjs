// Differential test: the compiled formula kernel must produce exactly what the
// tree-walking evaluator produced.
//
//   node scripts/test-expr-compiler.mjs
//
// Expected values come from bench/legacy-derived.mjs, a frozen verbatim copy of
// the old evaluator. Formulas are user data that lives in saved sessions, so a
// change here would silently alter numbers people have already published.

import assert from 'node:assert/strict';

import { FORMULAS, makeDataset, refEvaluateDerivedFormula } from '../bench/legacy-derived.mjs';
import { clearFormulaCache, getCompiledFormula } from '../src/expr/compile.js';

function classifyFor(variables) {
    return (name) => {
        const variable = variables[name];
        if (!variable) throw new Error(`Unknown variable "${name}".`);
        return (variable.kind === 'parameter' || variable.data.length === 1) ? 'scalar' : 'series';
    };
}

// Mirror of the production _evaluateDerivedFormula, minus the app plumbing.
function evaluate(formula, data) {
    const variables = data.variables;
    const timeVar = Object.values(variables).find(v => v.kind === 'abscissa');
    if (!timeVar?.data?.length) throw new Error('No time vector found.');
    const classify = classifyFor(variables);
    const compiled = getCompiledFormula(formula, variables, classify);

    const referenced = compiled.names
        .map(name => variables[name])
        .filter(variable => variable && variable.kind !== 'parameter');
    const independentIndex = referenced.some(variable => variable.independentIndex);
    const lengths = referenced.map(variable => variable.data?.length || 0).filter(Boolean);
    const n = lengths.length ? Math.min(timeVar.data.length, ...lengths) : timeVar.data.length;

    const columns = {};
    const scalars = {};
    for (const name of compiled.names) {
        const variable = variables[name];
        if (classify(name) === 'scalar') { scalars[name] = Number(variable.data[0]); continue; }
        if (variable.data.length !== n) {
            throw new Error(`"${name}" has ${variable.data.length} points, but time has ${n}.`);
        }
        columns[name] = variable.data;
    }
    return { values: compiled.run(columns, scalars, n), independentIndex };
}

let checks = 0;

function assertSeriesEqual(got, want, label) {
    assert.equal(got.length, want.length, `${label}: length`);
    for (let i = 0; i < want.length; i++) {
        const a = got[i];
        const e = want[i];
        if (Number.isNaN(e)) {
            assert.ok(Number.isNaN(a), `${label}[${i}]: expected NaN, got ${a}`);
            continue;
        }
        // Float64Array cannot hold -0 distinctly from +0 for our purposes here,
        // but it does; Object.is catches that as well as ordinary inequality.
        assert.ok(Object.is(a, e) || a === e, `${label}[${i}]: expected ${e}, got ${a}`);
    }
    checks++;
}

for (const n of [1, 2, 3, 25, 1000, 20_000]) {
    const data = makeDataset(n, 900 + n);
    for (const formula of FORMULAS) {
        const want = refEvaluateDerivedFormula(formula, data);
        const got = evaluate(formula, data);
        assertSeriesEqual(got.values, want.values, `n=${n} "${formula}"`);
        assert.equal(got.independentIndex, want.independentIndex, `n=${n} "${formula}": independentIndex`);
    }
}

// A single-sample non-parameter variable clamps n to 1 in the old evaluator.
// That is arguably a bug, but it is the shipped behaviour and formulas in saved
// sessions depend on the result they got.
{
    const data = makeDataset(500, 4242, { includeShortVar: true });
    for (const formula of ['single', 'single + 1', 'single * gain']) {
        const want = refEvaluateDerivedFormula(formula, data);
        const got = evaluate(formula, data);
        assertSeriesEqual(got.values, want.values, `short-var "${formula}"`);
    }
}

// Errors must match too — they are shown verbatim in the derived-variable form.
{
    const data = makeDataset(100, 7);
    const cases = [
        ['nope + 1', /Unknown variable "nope"\./],
        ['sqrt(x, y)', /sqrt\(\) expects 1 argument\./],
        ['root(x)', /root\(\) expects 2 arguments\./],
        ['x +', /Unexpected end of formula\./],
        ['(x + y', /Missing closing parenthesis\./],
        ['x @ y', /Unexpected "@" at position 3\./],
        ['`x + y', /Missing closing backtick\./],
    ];
    for (const [formula, pattern] of cases) {
        let refMessage = null;
        let gotMessage = null;
        try { refEvaluateDerivedFormula(formula, data); } catch (err) { refMessage = err.message; }
        try { evaluate(formula, data); } catch (err) { gotMessage = err.message; }
        assert.ok(refMessage, `"${formula}" should fail in the reference`);
        assert.equal(gotMessage, refMessage, `"${formula}": message must match the interpreter`);
        assert.match(gotMessage, pattern, `"${formula}": message shape`);
        checks++;
    }
}

// The cache must key on operand shape, not just formula text: the same formula
// against a file where `gain` is a full column must not reuse the kernel
// compiled when it was a scalar parameter.
{
    clearFormulaCache();
    const asParameter = makeDataset(200, 11);
    const asColumn = makeDataset(200, 11);
    asColumn.variables.gain = { name: 'gain', kind: 'variable', data: asColumn.variables.z.data };

    const first = evaluate('x * gain', asParameter);
    const second = evaluate('x * gain', asColumn);
    assertSeriesEqual(first.values, refEvaluateDerivedFormula('x * gain', asParameter).values, 'gain as parameter');
    assertSeriesEqual(second.values, refEvaluateDerivedFormula('x * gain', asColumn).values, 'gain as column');
    assert.notDeepEqual(Array.from(first.values), Array.from(second.values), 'the two shapes must not produce the same kernel');
    checks++;
}

// Output must be a typed array — downstream code and the export path rely on it.
{
    const data = makeDataset(50, 3);
    assert.ok(evaluate('x + y', data).values instanceof Float64Array, 'result is a Float64Array');
    checks++;
}

console.log(`expression compiler: ${checks} exact comparisons passed`);
