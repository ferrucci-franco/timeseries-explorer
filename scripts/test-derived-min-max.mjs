// min() and max() for derived variables.
//
//   node scripts/test-derived-min-max.mjs
//
// The two functions are the only variadic ones in the formula language, and the
// point of that is the three shapes a user reaches for: a variable against a
// constant, two variables, and a whole list of variables written between square
// brackets. All three have to mean the same thing — compare sample by sample —
// so most of this file is the same expectation written three ways.
//
// The bracket syntax is the part that could quietly break something else: names
// in these files are routinely subscripted (`a[1]`, `phase[2].v` — Modelica
// arrays), so the tokenizer has to tell a subscript from a list. Those cases are
// checked here rather than left to the formula that first hits them.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeDataset } from '../bench/legacy-derived.mjs';
import { clearFormulaCache, getCompiledFormula } from '../src/expr/compile.js';
import { DERIVED_FUNCTIONS, DERIVED_FUNCTION_ALIASES } from '../src/app/constants.js';
import { derivedNameToken } from '../src/app/methods/derived-methods.js';
import translations from '../src/i18n/translations.js';

let checks = 0;

function classifyFor(variables) {
    return (name) => {
        const variable = variables[name];
        if (!variable) throw new Error(`Unknown variable "${name}".`);
        return (variable.kind === 'parameter' || variable.data.length === 1) ? 'scalar' : 'series';
    };
}

// The production path, minus the app plumbing (see _evaluateDerivedFormula).
function evaluate(formula, data) {
    const variables = data.variables;
    const timeVar = Object.values(variables).find(v => v.kind === 'abscissa');
    if (!timeVar?.data?.length) throw new Error('No time vector found.');
    const classify = classifyFor(variables);
    const compiled = getCompiledFormula(formula, variables, classify);

    const referenced = compiled.names
        .map(name => variables[name])
        .filter(variable => variable && variable.kind !== 'parameter');
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
    return compiled.run(columns, scalars, n);
}

function assertSeriesEqual(got, want, label) {
    assert.equal(got.length, want.length, `${label}: length`);
    for (let i = 0; i < want.length; i++) {
        if (Number.isNaN(want[i])) {
            assert.ok(Number.isNaN(got[i]), `${label}[${i}]: expected NaN, got ${got[i]}`);
            continue;
        }
        assert.equal(got[i], want[i], `${label}[${i}]`);
    }
    checks++;
}

// The expectation, written without the compiler: operands are read per sample
// and handed to the platform's own Math.min / Math.max.
function reference(kind, operands, n) {
    const pick = kind === 'min' ? Math.min : Math.max;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        out[i] = pick(...operands.map(operand => (typeof operand === 'number' ? operand : operand[i])));
    }
    return out;
}

function errorOf(formula, data) {
    try {
        evaluate(formula, data);
    } catch (err) {
        return err.message;
    }
    return null;
}

// ─── The three shapes, over data with NaN, negatives and zeros ───────────────

for (const n of [1, 2, 3, 40, 5000]) {
    const data = makeDataset(n, 500 + n);
    const { x, y, z } = data.variables;
    const gain = Number(data.variables.gain.data[0]);

    // A variable and a constant.
    assertSeriesEqual(evaluate('min(x, 0)', data), reference('min', [x.data, 0], n), `n=${n} min(x, 0)`);
    assertSeriesEqual(evaluate('max(x, 0)', data), reference('max', [x.data, 0], n), `n=${n} max(x, 0)`);
    assertSeriesEqual(evaluate('min(x, -2.5)', data), reference('min', [x.data, -2.5], n), `n=${n} min(x, -2.5)`);
    // Order of the operands must not matter.
    assertSeriesEqual(evaluate('max(0, x)', data), reference('max', [x.data, 0], n), `n=${n} max(0, x)`);

    // Two variables.
    assertSeriesEqual(evaluate('min(x, y)', data), reference('min', [x.data, y.data], n), `n=${n} min(x, y)`);
    assertSeriesEqual(evaluate('max(x, y)', data), reference('max', [x.data, y.data], n), `n=${n} max(x, y)`);

    // A list of variables.
    assertSeriesEqual(evaluate('min([x, y, z])', data), reference('min', [x.data, y.data, z.data], n), `n=${n} min([x, y, z])`);
    assertSeriesEqual(evaluate('max([x, y, z])', data), reference('max', [x.data, y.data, z.data], n), `n=${n} max([x, y, z])`);

    // A list may hold constants too, and may sit beside other operands.
    assertSeriesEqual(evaluate('max([x, 0, y])', data), reference('max', [x.data, 0, y.data], n), `n=${n} max([x, 0, y])`);
    assertSeriesEqual(evaluate('min([x, y], z)', data), reference('min', [x.data, y.data, z.data], n), `n=${n} min([x, y], z)`);

    // A parameter is a scalar operand, exactly like a literal.
    assertSeriesEqual(evaluate('min(x, gain)', data), reference('min', [x.data, gain], n), `n=${n} min(x, gain)`);

    // The three spellings of the same thing must agree, which is the promise the
    // help popover makes to the user.
    const listed = evaluate('min([x, y, z])', data);
    assertSeriesEqual(evaluate('min(x, y, z)', data), listed, `n=${n} bare arguments == list`);
    assertSeriesEqual(evaluate('min(min(x, y), z)', data), listed, `n=${n} nested min == list`);
    assertSeriesEqual(evaluate('min([x, [y, z]])', data), listed, `n=${n} nested list flattens`);

    // Aliases resolve to the same function.
    assertSeriesEqual(evaluate('minimum(x, y)', data), evaluate('min(x, y)', data), `n=${n} minimum alias`);
    assertSeriesEqual(evaluate('maximum(x, y)', data), evaluate('max(x, y)', data), `n=${n} maximum alias`);

    // Case is not significant, as for every other function name.
    assertSeriesEqual(evaluate('MIN(x, y)', data), evaluate('min(x, y)', data), `n=${n} uppercase MIN`);
}

// ─── NaN propagates, as it does through + and * ──────────────────────────────
{
    const data = makeDataset(40, 77);
    const x = data.variables.x.data;
    const gotMin = evaluate('min(x, y)', data);
    const gotMax = evaluate('max(x, 0)', data);
    const nanIndices = [...x.keys()].filter(i => Number.isNaN(x[i]));
    assert.ok(nanIndices.length, 'the fixture is supposed to contain NaN samples');
    for (const i of nanIndices) {
        assert.ok(Number.isNaN(gotMin[i]), `min must not hide the NaN at ${i}`);
        assert.ok(Number.isNaN(gotMax[i]), `max must not hide the NaN at ${i}`);
    }
    checks++;
}

// ─── Composition with the rest of the language ──────────────────────────────
{
    const n = 200;
    const data = makeDataset(n, 991);
    const { x, y } = data.variables;
    const gain = Number(data.variables.gain.data[0]);

    // Clamping a signal before a function that dislikes negatives is the reason
    // most people reach for max() in the first place.
    const clamped = reference('max', [x.data, 0], n);
    assertSeriesEqual(evaluate('sqrt(max(x, 0))', data), clamped.map(Math.sqrt), 'sqrt(max(x, 0))');

    const expectedScaled = reference('min', [x.data, y.data], n).map(v => v * gain);
    assertSeriesEqual(evaluate('min(x, y) * gain', data), expectedScaled, 'min(x, y) * gain');

    // Clamping both ways: the idiomatic clamp is min(max(x, lo), hi).
    const clampBoth = reference('min', [reference('max', [x.data, -5], n), 5], n);
    assertSeriesEqual(evaluate('min(max(x, -5), 5)', data), clampBoth, 'min(max(x, -5), 5)');

    // The spread max - min is never negative where the data is defined.
    const spread = evaluate('max([x, y]) - min([x, y])', data);
    for (let i = 0; i < n; i++) {
        if (Number.isNaN(spread[i])) continue;
        assert.ok(spread[i] >= 0, `spread must not go negative at ${i}: ${spread[i]}`);
    }
    checks++;

    // diff() is the one neighbour op, lowered to its own pass before codegen —
    // min/max must still see it as an ordinary operand.
    const diffX = new Float64Array(n);
    diffX[0] = x.data[1] - x.data[0];
    for (let i = 1; i < n; i++) diffX[i] = x.data[i] - x.data[i - 1];
    assertSeriesEqual(evaluate('max(diff(x), 0)', data), reference('max', [diffX, 0], n), 'max(diff(x), 0)');
    assertSeriesEqual(evaluate('min([diff(x), diff(y)])', data), reference('min', [diffX, (() => {
        const d = new Float64Array(n);
        d[0] = y.data[1] - y.data[0];
        for (let i = 1; i < n; i++) d[i] = y.data[i] - y.data[i - 1];
        return d;
    })()], n), 'min([diff(x), diff(y)])');
}

// ─── Scalar-only operands still produce a full-length series ────────────────
{
    const n = 128;
    const data = makeDataset(n, 17);
    const gain = Number(data.variables.gain.data[0]);
    const offset = Number(data.variables.offset.data[0]);
    const got = evaluate('max(gain, offset)', data);
    assert.ok(got instanceof Float64Array, 'result is a Float64Array');
    assert.equal(got.length, n, 'a scalar-only formula still spans the time vector');
    assertSeriesEqual(got, new Float64Array(n).fill(Math.max(gain, offset)), 'max(gain, offset)');
    assertSeriesEqual(evaluate('min([gain, offset, 0])', data), new Float64Array(n).fill(Math.min(gain, offset, 0)), 'min([gain, offset, 0])');
}

// ─── Subscripted names: a bracket in a name is not a list ───────────────────
//
// `a[1]` is one name, so `min([a[1], a[2]])` has to close the list on the LAST
// bracket and the name on the one before it.
{
    const n = 6;
    const column = (values) => ({ kind: 'variable', data: Float64Array.from(values) });
    const data = {
        variables: {
            time: { name: 'time', kind: 'abscissa', data: Float64Array.from([0, 1, 2, 3, 4, 5]) },
            'a[1]': { name: 'a[1]', ...column([5, -2, 9, 0, 3, -7]) },
            'a[2]': { name: 'a[2]', ...column([1, 4, -3, 8, -1, 2]) },
            'a[3]': { name: 'a[3]', ...column([6, 6, 6, 6, 6, 6]) },
            'b[1].v': { name: 'b[1].v', ...column([-9, 9, -9, 9, -9, 9]) },
            'odd name': { name: 'odd name', ...column([2, 2, 2, 2, 2, 2]) },
            min: { name: 'min', ...column([100, 200, 300, 400, 500, 600]) },
        },
    };
    const A1 = data.variables['a[1]'].data;
    const A2 = data.variables['a[2]'].data;
    const A3 = data.variables['a[3]'].data;
    const B1 = data.variables['b[1].v'].data;

    assertSeriesEqual(evaluate('min(a[1], a[2])', data), reference('min', [A1, A2], n), 'min(a[1], a[2])');
    assertSeriesEqual(evaluate('max([a[1], a[2]])', data), reference('max', [A1, A2], n), 'max([a[1], a[2]])');
    assertSeriesEqual(evaluate('min([a[1], a[2], a[3]])', data), reference('min', [A1, A2, A3], n), 'min([a[1], a[2], a[3]])');
    assertSeriesEqual(evaluate('max([a[1], b[1].v])', data), reference('max', [A1, B1], n), 'max([a[1], b[1].v])');
    assertSeriesEqual(evaluate('min([ a[1] , a[2] ])', data), reference('min', [A1, A2], n), 'whitespace inside a list');
    // Subscripts keep working outside a list, which is the behaviour that was
    // already shipped.
    assertSeriesEqual(evaluate('a[1] + a[2]', data), Float64Array.from(A1.map((v, i) => v + A2[i])), 'a[1] + a[2]');

    // A backtick-quoted name inside a list.
    assertSeriesEqual(evaluate('max([`odd name`, a[3]])', data), reference('max', [data.variables['odd name'].data, A3], n), 'backtick name in a list');

    // A variable actually called `min` is still readable as an operand: only a
    // name followed by "(" is taken for a function call.
    assertSeriesEqual(evaluate('min + 1', data), Float64Array.from(data.variables.min.data.map(v => v + 1)), 'a variable named min');
    assertSeriesEqual(evaluate('max(min, 250)', data), reference('max', [data.variables.min.data, 250], n), 'max(min, 250)');
}

// ─── Errors reach the user as sentences, not stack traces ───────────────────
{
    const data = makeDataset(60, 5);
    const cases = [
        // One operand cannot be compared with anything.
        ['min(x)', /min\(\) expects at least 2 operands/],
        ['max()', /max\(\) expects at least 2 operands/],
        ['min([x])', /min\(\) expects at least 2 operands/],
        ['max([])', /max\(\) expects at least 2 operands/],
        // A list is not a value: it only means "these operands".
        ['[x, y]', /list can only be used inside min\(\) and max\(\)/],
        ['sqrt([x, y])', /list can only be used inside min\(\) and max\(\)/],
        ['x + [y, z]', /list can only be used inside min\(\) and max\(\)/],
        ['power([x, y], 2)', /list can only be used inside min\(\) and max\(\)/],
        // Malformed lists.
        ['min([x, y)', /Missing closing bracket "\]"\./],
        ['min([x, ])', /Unexpected "\]"\./],
        ['min([nope, x])', /Unknown variable "nope"\./],
    ];
    for (const [formula, pattern] of cases) {
        const message = errorOf(formula, data);
        assert.ok(message, `"${formula}" must be rejected`);
        assert.match(message, pattern, `"${formula}": message shape`);
        checks++;
    }

    // The hint has to spell out all three shapes, since that is the whole reason
    // the function is variadic.
    const hint = errorOf('min(x)', data);
    for (const fragment of ['a variable and a constant', 'two variables', '[a, b, c]']) {
        assert.ok(hint.includes(fragment), `the arity error should mention "${fragment}": ${hint}`);
    }
    checks++;

    // Fixed-arity functions keep their original message, which saved sessions
    // and the derived-variable form both show verbatim.
    assert.match(errorOf('sqrt(x, y)', data), /sqrt\(\) expects 1 argument\./, 'sqrt arity message unchanged');
    assert.match(errorOf('root(x)', data), /root\(\) expects 2 arguments\./, 'root arity message unchanged');
    checks++;
}

// ─── The compile cache keys on operand shape, not just text ─────────────────
{
    clearFormulaCache();
    const asParameter = makeDataset(150, 23);
    const asColumn = makeDataset(150, 23);
    asColumn.variables.gain = { name: 'gain', kind: 'variable', data: asColumn.variables.z.data };

    const scalarGain = evaluate('min(x, gain)', asParameter);
    const columnGain = evaluate('min(x, gain)', asColumn);
    assertSeriesEqual(scalarGain, reference('min', [asParameter.variables.x.data, Number(asParameter.variables.gain.data[0])], 150), 'min(x, gain) with a parameter');
    assertSeriesEqual(columnGain, reference('min', [asColumn.variables.x.data, asColumn.variables.gain.data], 150), 'min(x, gain) with a column');
    assert.notDeepEqual(Array.from(scalarGain), Array.from(columnGain), 'the two shapes must not share a kernel');
    checks++;
}

// ─── Discoverability: autocomplete, the popover, and every language ─────────
{
    const names = DERIVED_FUNCTIONS.map(fn => fn.name);
    for (const name of ['min', 'max']) {
        assert.ok(names.includes(name), `${name}() must be offered by autocomplete`);
        const entry = DERIVED_FUNCTIONS.find(fn => fn.name === name);
        assert.equal(entry.minArity, 2, `${name}() is variadic from two operands up`);
        assert.equal(entry.arity, undefined, `${name}() must not claim a fixed arity`);
    }
    assert.equal(DERIVED_FUNCTION_ALIASES.get('minimum'), 'min', 'minimum is an alias of min');
    assert.equal(DERIVED_FUNCTION_ALIASES.get('maximum'), 'max', 'maximum is an alias of max');
    checks++;

    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const popover = html.slice(html.indexOf('id="derived-help-popover"'), html.indexOf('id="derived-form"'));
    assert.ok(popover, 'the formula-help popover is in index.html');
    for (const fragment of ['min(...)', 'max(...)', 'min(x, 0)', 'max(x, y)', 'min([x, y, z])']) {
        assert.ok(popover.includes(fragment), `the popover must show ${fragment}`);
    }
    // Every line of prose in that row is translated; only the code samples are
    // literal. A hardcoded English sentence would read as English in all four.
    for (const key of ['derivedHelpMinMax', 'derivedHelpMinMaxText', 'derivedHelpMinMaxConstant', 'derivedHelpMinMaxPair', 'derivedHelpMinMaxList']) {
        assert.ok(popover.includes(`data-i18n="${key}"`), `the popover must bind ${key}`);
        for (const lang of Object.keys(translations)) {
            const value = translations[lang][key];
            assert.ok(typeof value === 'string' && value.trim(), `${lang} must translate ${key}`);
        }
    }
    checks++;

    // The long-form help (Help → Create and process signals) documents the same
    // three shapes in every language.
    for (const lang of Object.keys(translations)) {
        const body = translations[lang].helpSec10Body;
        for (const fragment of ['min(x, 0)', 'max(x, y)', 'min([x, y, z])']) {
            assert.ok(body.includes(fragment), `${lang}.helpSec10Body must show ${fragment}`);
        }
    }
    checks++;

    // Each language must say it in its own words rather than inherit English.
    for (const key of ['derivedHelpMinMaxText', 'derivedHelpMinMaxConstant', 'derivedHelpMinMaxPair', 'derivedHelpMinMaxList']) {
        for (const lang of Object.keys(translations)) {
            if (lang === 'en') continue;
            assert.notEqual(translations[lang][key], translations.en[key], `${lang}.${key} is still the English string`);
        }
    }
    checks++;
}

// ─── Autocomplete still finds the name being typed inside a list ────────────
//
// The suggestion box scans back from the cursor for a partial name. Subscripts
// are part of a name, so brackets are in that run — but the `[` that opens a
// list is not, and without dropping it the box would search for "[x" and go
// quiet exactly where the new syntax is being typed.
{
    const cases = [
        ['min([x', 'x'],
        ['min([xy_1', 'xy_1'],
        ['max([a, b', 'b'],
        ['max([a,b', 'b'],
        ['min([a[1', 'a[1'],
        ['min([a[1], b[2', 'b[2'],
        // Nothing to do with lists: the shapes that already worked.
        ['sqrt(x', 'x'],
        ['a[1', 'a[1'],
        ['motor.slip', 'motor.slip'],
        ['x + ', ''],
        ['', ''],
        // Inside backticks a bracket really is part of the name.
        ['`[odd', '`[odd'],
    ];
    for (const [left, expected] of cases) {
        assert.equal(derivedNameToken(left), expected, `prefix under the cursor for "${left}"`);
        // Whatever is inserted replaces exactly the token, so the rest of the
        // formula — the opening bracket included — has to survive.
        assert.ok(left.endsWith(expected), `"${expected}" must be the tail of "${left}"`);
    }
    assert.equal(derivedNameToken('min([x').length, 1, 'the "[" is left in place, not overwritten');
    checks++;
}

console.log(`derived min/max: ${checks} checks passed`);
