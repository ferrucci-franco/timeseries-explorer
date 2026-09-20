// `v(V1)` is a signal, not a column in units of V1 (#53).
//
// A Microcap run heads its columns `v(V1)`, `v(OUT_1)`, `v(OUT_2)`,
// `i(R_load1)`, `i(R10)`… — the voltage at node V1, the current through
// R_load1. The header parser read the trailing parentheses as an inline unit,
// cut them off, and left three columns called `v` and four called `i` for the
// deduplicator to rename. The sidebar listed `v`, `v_2`, `v_3`, `i`, `i_2`,
// `i_3`, `i_4` with the file's own names filed as units.
//
// What tells a unit from a name is the rest of the row. Units repeat — three
// columns in volts — and names do not. So a split that makes two DIFFERENT
// headers collide was not a unit split.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import CsvParser from '../src/parsers/csv-parser.js';
import { inlineUnitSplitCollides } from '../src/utils/inline-unit-headers.js';

const parser = new CsvParser();

// ── The rule ────────────────────────────────────────────────────────────────
const split = headers => headers.map((raw, index) => parser._parseHeader(raw, index));
const collides = headers => inlineUnitSplitCollides(headers, split(headers));

assert.equal(collides(['T', 'v(V1)', 'v(OUT_1)', 'v(OUT_2)']), true,
    'three signals that differ only inside the parentheses');
assert.equal(collides(['t', 'i(R_load1)', 'i(R_load2)', 'i(R10)', 'i(R11)']), true);
assert.equal(collides(['time (s)', 'speed (m/s)', 'load (N)']), false,
    'real inline units name different things and do not collide');
assert.equal(collides(['t (s)', 'a (V)', 'b (V)', 'c (V)']), false,
    'columns sharing one unit are the ordinary case — the UNIT repeats, not the name');
assert.equal(collides(['T', 'speed', 'load']), false, 'nothing to split, nothing to collide');
assert.equal(collides(['a [V]', 'b [V]']), false, 'brackets read the same way');

// Two columns with the SAME raw header are an ordinary duplicate — the
// deduplicator's job — and say nothing about whether the split was right.
assert.equal(inlineUnitSplitCollides(['a (V)', 'a (V)'], split(['a (V)', 'a (V)'])), false);
// A column with no parentheses is untouched by the split and is not evidence.
assert.equal(inlineUnitSplitCollides(['v', 'v (V)'], split(['v', 'v (V)'])), false,
    'an unsplit header that happens to match a split one is not a collision');

// Degenerate inputs answer rather than throw.
for (const bad of [[], null, undefined]) {
    assert.equal(inlineUnitSplitCollides(bad, []), false, `refuses ${JSON.stringify(bad)}`);
}
assert.equal(inlineUnitSplitCollides(['a (V)'], null), false, 'no parse, no evidence');

// ── What a fresh load makes of the real file ────────────────────────────────
const MICROCAP = ['T', 'v(V1)', 'v(OUT_1)', 'v(OUT_2)', 'v(OUT_3)-V(COM)', 'v(OUT_4)-V(COM)',
    'i(R_load1)', 'i(R_load2)', 'i(R10)', 'i(R11)', 'i(R10)*V(V1)', 'i(R11)*V(V1)',
    'AVG(i(R10)*V(V1))', 'AVG(i(R11)*V(V1))'];
const fresh = parser._makeUniqueHeaders(MICROCAP);
assert.deepEqual(fresh.map(h => h.name), MICROCAP,
    'every signal keeps the name the file gave it');
assert.deepEqual(fresh.map(h => h.description), MICROCAP.map(() => ''),
    'and none of them acquires an invented unit');

// The ordinary case still splits, or the guard would have cost every file its
// inline units to save one.
const ordinary = parser._makeUniqueHeaders(['time (s)', 'speed (m/s)', 'load (N)']);
assert.deepEqual(ordinary.map(h => h.name), ['time', 'speed', 'load']);
assert.deepEqual(ordinary.map(h => h.description), ['[s]', '[m/s]', '[N]']);

// ── A saved profile is replayed exactly ─────────────────────────────────────
// Its owner may have a view that names `Voltage_2`; deciding after the fact
// that those parentheses were a name would break that reference. The guard is
// for a fresh look at a file, not for a decision already made.
const SAVED = ['Time (s)', 'Voltage (RMS)', 'Voltage (peak)'];
assert.deepEqual(
    parser._makeUniqueHeaders(SAVED, { guardNameCollisions: false }).map(h => h.name),
    ['Time', 'Voltage', 'Voltage_2'],
    'a profile from before the setting existed keeps its names');
assert.deepEqual(
    parser._normalizeProfileHeaders(null, SAVED, { unitsMode: undefined }).map(h => h.name),
    ['Time', 'Voltage', 'Voltage_2'],
    'and that is the path such a profile takes');
// Choosing "Units: inline" is the reader saying the parentheses hold units.
assert.deepEqual(
    parser._normalizeProfileHeaders(null, SAVED, { unitsMode: 'inline' }).map(h => h.name),
    ['Time', 'Voltage', 'Voltage_2'],
    'an explicit inline choice is not second-guessed either');

// ── The parser carries the unit it took, which is what the rule reads ───────
assert.equal(parser._parseHeader('speed (m/s)', 1).unit, 'm/s');
assert.equal(parser._parseHeader('power [kW]', 1).unit, 'kW');
assert.equal(parser._parseHeader('plain', 1).unit, '', 'nothing taken, nothing reported');
assert.equal(parser._parseHeader('', 1).unit, '');
assert.equal(parser._parseInlineUnitHeader('speed (m/s)', 1).unit, 'm/s');
assert.equal(parser._parseInlineUnitHeader('plain', 1).unit, '');

const source = readFileSync(new URL('../src/parsers/csv-parser.js', import.meta.url), 'utf8');
assert.match(source, /_makeUniqueInlineHeaders[\s\S]{0,400}?const seen = new Map\(\);/,
    'the explicit-inline path has no guard, and says why above itself');
assert.doesNotMatch(
    source.slice(source.indexOf('_makeUniqueInlineHeaders'), source.indexOf('_parseInlineUnitHeader')),
    /inlineUnitSplitCollides/, 'an explicit choice is the reader’s to make');

console.log('Inline-unit name checks passed.');
