// The pure pieces of the phone's derived-variable editor
// (src/app/methods/compact-derived-methods.js): what ⌫ takes back, how a
// function is shown on its key, the keys under the formula, and the small
// preview plot of the values a formula gives.
import assert from 'node:assert/strict';

import { DERIVED_FUNCTIONS } from '../src/app/constants.js';
import translations from '../src/i18n/translations.js';
import {
    FORMULA_KEYS,
    FUNCTION_GROUPS,
    envelopePaths,
    functionSignature,
    previewEnvelope,
    smartBackspaceLength,
} from '../src/app/methods/compact-derived-methods.js';

// ── ⌫: whatever one tap wrote goes in one tap ───────────────────────────────
const back = (text) => text.slice(0, text.length - smartBackspaceLength(text));
assert.equal(back('voltage * current'), 'voltage * ', 'a whole name');
assert.equal(back('voltage * '), 'voltage', 'an operator with the spaces around it');
assert.equal(back('voltage+'), 'voltage', 'an operator typed without spaces');
assert.equal(back('x + `d squared`'), 'x + ', 'a quoted name, spaces and all');
assert.equal(back('2 * sqrt('), '2 * ', 'a function\'s opening');
assert.equal(back('phase[2].v'), '', 'a name with brackets and dots');
assert.equal(back('math.pi'), '', 'a dotted constant');
assert.equal(back('x / 10'), 'x / 1', 'a number goes digit by digit');
assert.equal(back('(x)'), '(x', 'a closing bracket alone');
assert.equal(back('sum(a, '), 'sum(a', 'a list separator');
assert.equal(back('x   '), 'x', 'trailing spaces');
assert.equal(smartBackspaceLength(''), 0, 'nothing to take back');

// ── The keys under the formula ──────────────────────────────────────────────
assert.deepEqual(FORMULA_KEYS.map(([label]) => label), ['+', '−', '×', '÷', '^', '(', ')'],
    'the operators a phone keyboard keeps on its second page');
assert.deepEqual(Object.fromEntries(FORMULA_KEYS), { '+': ' + ', '−': ' - ', '×': ' * ', '÷': ' / ', '^': '^', '(': '(', ')': ')' },
    'each writes what the grammar reads, not the glyph it shows');

// ── Functions: each on its key, each described in every language ────────────
assert.equal(functionSignature({ name: 'sqrt', arity: 1 }), 'sqrt(x)');
assert.equal(functionSignature({ name: 'power', arity: 2 }), 'power(x, n)');
assert.equal(functionSignature({ name: 'root', arity: 2 }), 'root(x, n)');
assert.equal(functionSignature({ name: 'sum', minArity: 1 }), 'sum(a, b, …)');
assert.equal(functionSignature({ name: 'max', minArity: 2 }), 'max(a, b, …)');
const grouped = new Set(FUNCTION_GROUPS.flatMap(group => group.names));
for (const fn of DERIVED_FUNCTIONS) {
    // A function the table leaves out still shows (under Other), but every
    // function there is today has its place.
    assert.ok(grouped.has(fn.name), `${fn.name} has a group in the Functions tab`);
    for (const lang of Object.keys(translations)) {
        assert.ok(translations[lang][`compactFn_${fn.name}`], `${lang} describes ${fn.name}`);
    }
}
for (const group of FUNCTION_GROUPS) {
    for (const lang of Object.keys(translations)) assert.ok(translations[lang][group.key], `${lang} names the group ${group.key}`);
}

// ── The preview: an envelope per column ─────────────────────────────────────
{
    const values = Float64Array.from({ length: 1000 }, (_, i) => Math.sin(i / 50));
    const env = previewEnvelope(values, 100);
    assert.equal(env.n, 1000);
    assert.equal(env.finite, 1000);
    assert.equal(env.nan, 0);
    assert.equal(env.lo.length, 100, 'one column per pixel group');
    assert.ok(env.min < -0.99 && env.max > 0.99, 'the extremes of the whole signal');
    for (let c = 0; c < 100; c++) assert.ok(env.lo[c] <= env.hi[c], `column ${c} spans low to high`);
}
{
    // Not a number is counted, never drawn, and leaves a gap.
    const values = [1, 2, NaN, NaN, NaN, NaN, 3, 4];
    const env = previewEnvelope(values, 4);
    assert.equal(env.nan, 4);
    assert.equal(env.min, 1);
    assert.equal(env.max, 4);
    assert.ok(Number.isNaN(env.lo[1]) && Number.isNaN(env.lo[2]), 'the columns with no number are empty');
    const { line, band } = envelopePaths(env, 300, 56);
    assert.equal((line.match(/M/g) || []).length, 2, 'the gap breaks the curve in two');
    assert.equal((band.match(/Z/g) || []).length, 2, 'and the band');
}
{
    // Fewer samples than columns: one column per sample.
    const env = previewEnvelope([5, 6, 7], 120);
    assert.equal(env.lo.length, 3);
    assert.deepEqual(Array.from(env.lo), [5, 6, 7]);
}
{
    // A constant draws a flat line through the middle, not a division by zero.
    const env = previewEnvelope(new Float64Array(50).fill(2), 10);
    const { line } = envelopePaths(env, 100, 40);
    assert.ok(line && !/NaN|Infinity/.test(line), 'a flat line');
    assert.ok(line.split(/[ML]/).filter(Boolean).every(point => point.endsWith(',20.0')), 'at mid height');
}
{
    // Nothing but NaN: nothing to draw.
    const env = previewEnvelope([NaN, NaN], 10);
    assert.equal(env.finite, 0);
    assert.deepEqual(envelopePaths(env), { band: '', line: '' });
    assert.equal(previewEnvelope([], 10).n, 0, 'an empty result');
}

console.log('compact derived editor tests passed');
