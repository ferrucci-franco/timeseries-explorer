// Trigonometry, named constants, and the time vector as an operand.
//
//   node scripts/test-derived-trig-constants.mjs
//
// The three belong together because they are only interesting together: `sin`
// alone transforms a signal, but `sin`, `pi` and the time axis in one formula
// BUILD one — `sin(2*pi*1000*time)` is a 1 kHz tone over whatever file happens
// to be loaded. That formula is the thing this file is really protecting, so it
// is checked sample for sample against Math, not just for "runs without error".
//
// Constants carry the risk here. A file's own variables must always win, or a
// result file with a column called `pi` would silently change meaning in every
// formula a user has already saved.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { clearFormulaCache, getCompiledFormula } from '../src/expr/compile.js';
import { DERIVED_CONSTANTS, DERIVED_FUNCTIONS, DERIVED_FUNCTION_ALIASES } from '../src/app/constants.js';
import { installDerivedMethods } from '../src/app/methods/derived-methods.js';
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
        columns[name] = variable.data;
    }
    return compiled.run(columns, scalars, n);
}

function errorOf(formula, data) {
    try {
        evaluate(formula, data);
    } catch (err) {
        return err.message;
    }
    return null;
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

function assertClose(got, want, tolerance, label) {
    assert.equal(got.length, want.length, `${label}: length`);
    for (let i = 0; i < want.length; i++) {
        assert.ok(Math.abs(got[i] - want[i]) <= tolerance, `${label}[${i}]: ${got[i]} vs ${want[i]}`);
    }
    checks++;
}

// A sampled dataset: a real time axis in seconds plus a few signals, including
// the awkward values (NaN, out-of-domain for asin/acos, a zero).
function makeDataset(n, sampleRate = 8000) {
    const time = new Float64Array(n);
    const x = new Float64Array(n);
    const ratio = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        time[i] = i / sampleRate;
        x[i] = Math.sin(i * 0.05) * 3;
        // Deliberately runs past ±1 so asin/acos have an out-of-domain stretch.
        ratio[i] = -1.5 + (3 * i) / Math.max(1, n - 1);
    }
    if (n > 6) {
        x[2] = 0;
        x[4] = NaN;
        ratio[5] = NaN;
    }
    return {
        variables: {
            time: { name: 'time', kind: 'abscissa', data: time },
            x: { name: 'x', kind: 'variable', data: x },
            ratio: { name: 'ratio', kind: 'variable', data: ratio },
            gain: { name: 'gain', kind: 'parameter', data: new Float64Array([0.5]) },
        },
    };
}

const map = (source, fn) => Float64Array.from(source, fn);

// ─── Each function is exactly the platform's own, elementwise ───────────────

for (const n of [1, 2, 7, 64, 4096]) {
    const data = makeDataset(n);
    const { x, ratio } = data.variables;

    for (const [name, fn] of [['sin', Math.sin], ['cos', Math.cos], ['tan', Math.tan],
        ['sinh', Math.sinh], ['cosh', Math.cosh], ['tanh', Math.tanh]]) {
        assertSeriesEqual(evaluate(`${name}(x)`, data), map(x.data, fn), `n=${n} ${name}(x)`);
    }
    // The inverses get the operand that leaves their domain, so the NaN outside
    // [-1, 1] is part of what is pinned down here.
    for (const [name, fn] of [['asin', Math.asin], ['acos', Math.acos], ['atan', Math.atan]]) {
        assertSeriesEqual(evaluate(`${name}(ratio)`, data), map(ratio.data, fn), `n=${n} ${name}(ratio)`);
    }

    // Aliases and case, as for every other function name.
    assertSeriesEqual(evaluate('arcsin(ratio)', data), evaluate('asin(ratio)', data), `n=${n} arcsin alias`);
    assertSeriesEqual(evaluate('arccos(ratio)', data), evaluate('acos(ratio)', data), `n=${n} arccos alias`);
    assertSeriesEqual(evaluate('arctan(ratio)', data), evaluate('atan(ratio)', data), `n=${n} arctan alias`);
    assertSeriesEqual(evaluate('SIN(x)', data), evaluate('sin(x)', data), `n=${n} uppercase SIN`);
}

// NaN in, NaN out — no silent substitution.
{
    const data = makeDataset(64);
    const x = data.variables.x.data;
    const nanIndices = [...x.keys()].filter(i => Number.isNaN(x[i]));
    assert.ok(nanIndices.length, 'the fixture is supposed to contain a NaN');
    for (const formula of ['sin(x)', 'cos(x)', 'tan(x)', 'atan(x)']) {
        const got = evaluate(formula, data);
        for (const i of nanIndices) {
            assert.ok(Number.isNaN(got[i]), `${formula} must not hide the NaN at ${i}`);
        }
    }
    checks++;
}

// Identities the maths owes us, as a check on composition rather than on Math.
{
    const n = 512;
    const data = makeDataset(n);
    const ones = new Float64Array(n).fill(1);
    const pythagorean = evaluate('sin(x)^2 + cos(x)^2', data);
    const defined = [...pythagorean.keys()].filter(i => !Number.isNaN(pythagorean[i]));
    assertClose(
        Float64Array.from(defined, i => pythagorean[i]),
        Float64Array.from(defined, () => 1),
        1e-12,
        'sin² + cos² = 1',
    );
    assert.equal(ones.length, n, 'sanity');

    // The hyperbolic counterpart, which is a sign away from the circular one and
    // therefore the check that would catch a cosh/cos mix-up in the emitter.
    const hyperbolic = evaluate('cosh(x)^2 - sinh(x)^2', data);
    const hyperbolicDefined = [...hyperbolic.keys()].filter(i => !Number.isNaN(hyperbolic[i]));
    assertClose(
        Float64Array.from(hyperbolicDefined, i => hyperbolic[i]),
        Float64Array.from(hyperbolicDefined, () => 1),
        1e-9,
        'cosh² - sinh² = 1',
    );

    // tanh is bounded; a signal that reaches ±3 is deep enough into saturation
    // for a wrong mapping to show up as a value outside the band.
    const saturating = evaluate('tanh(x)', data);
    for (let i = 0; i < n; i++) {
        if (Number.isNaN(saturating[i])) continue;
        assert.ok(saturating[i] > -1 && saturating[i] < 1, `tanh must stay inside (-1, 1) at ${i}`);
    }
    checks++;

    // asin(sin(t)) folds back onto t only inside [-pi/2, pi/2]; tan = sin/cos
    // holds wherever cos is not zero, which a sampled signal never lands on.
    const tanViaRatio = evaluate('sin(x) / cos(x)', data);
    const tanDirect = evaluate('tan(x)', data);
    const bothDefined = [...tanDirect.keys()].filter(i => Number.isFinite(tanDirect[i]) && Number.isFinite(tanViaRatio[i]));
    assertClose(
        Float64Array.from(bothDefined, i => tanDirect[i]),
        Float64Array.from(bothDefined, i => tanViaRatio[i]),
        1e-9,
        'tan == sin/cos',
    );
}

// ─── sign and step, and the square wave they are for ───────────────────────
//
// The pair exists because of one question: what a sample sitting exactly on
// zero should become. `sign` answers it the way every other maths library does
// — zero is neither positive nor negative, so it stays 0 — and `step` is the one
// that makes it pick a side, which is what a square wave built out of a sine
// needs at the instant the sine crosses.
{
    const n = 9;
    const time = Float64Array.from({ length: n }, (_, i) => i / 8);
    // Every case that matters in one column: negative, -0, +0, positive, NaN.
    const probe = Float64Array.from([-3, -1e-300, -0, 0, 1e-300, 2, Infinity, -Infinity, NaN]);
    const data = {
        variables: {
            time: { name: 'time', kind: 'abscissa', data: time },
            v: { name: 'v', kind: 'variable', data: probe },
        },
    };

    assertSeriesEqual(evaluate('sign(v)', data), map(probe, Math.sign), 'sign is the platform signum');
    assertSeriesEqual(
        evaluate('step(v)', data),
        Float64Array.from([0, 0, 1, 1, 1, 1, 1, 0, NaN]),
        'step is 1 from zero upwards, 0 below',
    );

    // The zero rule, stated on its own because it is the decision this pair
    // encodes: sign keeps zero, step sends it up.
    const signed = evaluate('sign(v)', data);
    const stepped = evaluate('step(v)', data);
    // `===` rather than assert.equal: signum preserves the sign of zero, so
    // sign(-0) is -0, which is zero and plots as zero but is not Object.is(+0).
    assert.ok(signed[2] === 0, 'sign(-0) is zero');
    assert.ok(signed[3] === 0, 'sign(0) is zero');
    assert.equal(stepped[2], 1, 'step(-0) is 1: negative zero is still zero');
    assert.equal(stepped[3], 1, 'step(0) is 1');
    assert.ok(Number.isNaN(signed[8]) && Number.isNaN(stepped[8]), 'both leave NaN alone');
    checks++;

    // A hole in the signal must not become a 0 — the trap in writing step as a
    // single `>= 0 ? 1 : 0`, which would silently turn every NaN into "below".
    assert.ok(!stepped.some((value, i) => Number.isNaN(probe[i]) && value === 0), 'NaN never becomes 0');
    checks++;

    // Aliases.
    assertSeriesEqual(evaluate('sgn(v)', data), signed, 'sgn alias');
    assertSeriesEqual(evaluate('signum(v)', data), signed, 'signum alias');
    assertSeriesEqual(evaluate('heaviside(v)', data), stepped, 'heaviside alias');

    // step is the half-wave rectifier and the switch-on, which is why it earns
    // its place beyond squaring a sine.
    // Written as the multiplication it is, so the expectation carries the sign
    // of zero the same way: -3 * 0 is -0, which is what the formula produces and
    // what a rectified sample of a negative value should read as.
    assertSeriesEqual(evaluate('v * step(v)', data), map(probe, x => x * (x >= 0 ? 1 : (x < 0 ? 0 : NaN))), 'x*step(x) rectifies');
    assertSeriesEqual(evaluate('step(time - 0.5)', data), map(time, t => (t - 0.5 >= 0 ? 1 : 0)), 'step(time - t0) switches on');
}

// The square wave, which is what this was asked for.
{
    const sampleRate = 800;
    const n = 400;
    const frequency = 50;
    const time = Float64Array.from({ length: n }, (_, i) => i / sampleRate);
    const data = { variables: { time: { name: 'time', kind: 'abscissa', data: time } } };

    const viaSign = evaluate(`sign(sin(2*pi*${frequency}*time))`, data);
    const viaStep = evaluate(`2*step(sin(2*pi*${frequency}*time))-1`, data);

    // Strictly two-valued: the reason step is offered alongside sign.
    for (let i = 0; i < n; i++) {
        assert.ok(viaStep[i] === 1 || viaStep[i] === -1, `the step square wave is +/-1 at ${i}, got ${viaStep[i]}`);
    }
    // sign agrees everywhere the sine is not exactly zero, and the sample at
    // t=0 is exactly where it does not: sin(0) is 0, so sign gives 0 there.
    assert.equal(viaSign[0], 0, 'sign leaves the sample on the crossing at 0');
    assert.equal(viaStep[0], 1, 'step sends the same sample up');
    for (let i = 1; i < n; i++) {
        if (Math.sin(2 * Math.PI * frequency * time[i]) === 0) continue;
        assert.equal(viaSign[i], viaStep[i], `the two agree away from an exact crossing, at ${i}`);
    }

    // It really is a 50 Hz square wave on an 800 Hz grid: 16 samples per period,
    // and it repeats.
    //
    // Not at every sample, though, and the exception is worth naming: this grid
    // puts a sample exactly on each crossing, where sin comes out around 1e-16
    // with a sign that is rounding noise rather than arithmetic. Those samples
    // are genuinely ambiguous — a square wave from a sine is undefined at the
    // crossing — so periodicity is asserted where the sine is actually away from
    // zero, and the count below keeps that from quietly excusing everything.
    const period = sampleRate / frequency;
    const sine = (i) => Math.sin(2 * Math.PI * frequency * time[i]);
    let compared = 0;
    for (let i = 1; i + period < n; i++) {
        if (Math.abs(sine(i)) < 1e-12) continue;
        assert.equal(viaStep[i], viaStep[i + period], `the square wave repeats every ${period} samples (at ${i})`);
        compared++;
    }
    assert.ok(compared > n * 0.8, `most samples must be off the crossings (compared ${compared} of ${n})`);
    const high = [...viaStep].filter(value => value === 1).length;
    assert.ok(Math.abs(high - n / 2) <= period, 'a square wave spends about half its time high');
    checks++;
}

// ─── Constants ──────────────────────────────────────────────────────────────
{
    const n = 32;
    const data = makeDataset(n);

    // A constant-only formula still spans the time vector, like any other.
    assertSeriesEqual(evaluate('pi', data), new Float64Array(n).fill(Math.PI), 'pi');
    assertSeriesEqual(evaluate('e', data), new Float64Array(n).fill(Math.E), 'e');
    assertSeriesEqual(evaluate('math.pi', data), new Float64Array(n).fill(Math.PI), 'math.pi');
    assertSeriesEqual(evaluate('math.e', data), new Float64Array(n).fill(Math.E), 'math.e');
    // Case-insensitive, as function names are.
    for (const spelling of ['PI', 'Pi', 'MATH.PI']) {
        assertSeriesEqual(evaluate(spelling, data), new Float64Array(n).fill(Math.PI), spelling);
    }

    // They are values, not markers: they compose like any number.
    assertSeriesEqual(evaluate('2*pi', data), new Float64Array(n).fill(2 * Math.PI), '2*pi');
    assertSeriesEqual(evaluate('log(e)', data), new Float64Array(n).fill(1), 'log(e) == 1');
    assertClose(evaluate('sin(pi)', data), new Float64Array(n).fill(0), 1e-15, 'sin(pi) ≈ 0');
    assertSeriesEqual(evaluate('cos(pi)', data), new Float64Array(n).fill(-1), 'cos(pi) == -1');
}

// ─── The file's own variables always win ────────────────────────────────────
//
// This is the whole safety argument for adding named constants at all: a result
// file with a column called `pi` must keep meaning what it meant before.
{
    const n = 16;
    const data = makeDataset(n);
    const shadow = makeDataset(n);
    shadow.variables.pi = { name: 'pi', kind: 'variable', data: new Float64Array(n).fill(7) };
    shadow.variables.e = { name: 'e', kind: 'parameter', data: new Float64Array([9]) };

    clearFormulaCache();
    assertSeriesEqual(evaluate('pi', shadow), new Float64Array(n).fill(7), 'a column named pi wins over the constant');
    assertSeriesEqual(evaluate('e', shadow), new Float64Array(n).fill(9), 'a parameter named e wins over the constant');
    // Same formula text, the other file: still the number. The compile cache
    // must not carry one reading over to the other.
    assertSeriesEqual(evaluate('pi', data), new Float64Array(n).fill(Math.PI), 'the constant is back when the name is free');
    assertSeriesEqual(evaluate('pi', shadow), new Float64Array(n).fill(7), 'and the column again, from cache');

    // The documented way out when a file does shadow them.
    assertSeriesEqual(evaluate('math.pi', shadow), new Float64Array(n).fill(Math.PI), 'math.pi ignores the shadowing column');
    assertSeriesEqual(evaluate('math.e', shadow), new Float64Array(n).fill(Math.E), 'math.e ignores the shadowing parameter');

    // Backticks have always meant "this is a variable name", and still do.
    assertSeriesEqual(evaluate('`pi`', shadow), new Float64Array(n).fill(7), 'backticks force the variable reading');
    assert.match(errorOf('`pi`', data), /Unknown variable "pi"\./, 'backticks never fall back to the constant');
    checks++;

    // A name that is neither a variable nor a constant still fails as before.
    assert.match(errorOf('nope', data), /Unknown variable "nope"\./, 'unknown names are unchanged');
    assert.match(errorOf('pie', data), /Unknown variable "pie"\./, 'a constant is a whole name, not a prefix');
    checks++;
}

// ─── The time vector as an operand: synthesizing a signal ───────────────────
{
    const sampleRate = 8000;
    const n = 800;
    const data = makeDataset(n, sampleRate);
    const time = data.variables.time.data;
    const x = data.variables.x.data;

    // The headline formula, sample for sample.
    const tone = evaluate('sin(2*pi*1000*time)', data);
    assertSeriesEqual(tone, map(time, t => Math.sin(2 * Math.PI * 1000 * t)), 'sin(2*pi*1000*time) is a 1 kHz tone');

    // At 8 kHz a 1 kHz tone is 8 samples per period, so it must come back to
    // itself every 8 samples — an independent statement about the frequency,
    // not a restatement of Math.sin.
    for (let i = 0; i + 8 < n; i++) {
        assert.ok(Math.abs(tone[i] - tone[i + 8]) <= 1e-9, `the tone must repeat every 8 samples (at ${i})`);
    }
    assert.ok(Math.max(...tone) > 0.999 && Math.min(...tone) < -0.999, 'the tone must reach full amplitude');
    checks++;

    // Adding it to a signal, which is the other half of the help text.
    const hummed = evaluate('x + 0.1*sin(2*pi*50*time)', data);
    assertSeriesEqual(hummed, map(time, (t, i) => x[i] + 0.1 * Math.sin(2 * Math.PI * 50 * t)), 'hum added to a signal');

    // The time axis was already a legal operand; it must stay one.
    assertSeriesEqual(evaluate('time*2', data), map(time, t => t * 2), 'time*2');
    assertSeriesEqual(evaluate('cos(2*pi*time/0.1) * gain', data), map(time, t => Math.cos(2 * Math.PI * t / 0.1) * 0.5), 'a parameter scales a synthesized wave');

    // A file whose time axis is called something else works the same way: the
    // abscissa is found by kind, never by the name "time".
    const named = makeDataset(n, sampleRate);
    named.variables.Zeit = { ...named.variables.time, name: 'Zeit' };
    delete named.variables.time;
    assertSeriesEqual(evaluate('sin(2*pi*1000*Zeit)', named), tone, 'the time axis need not be called "time"');
}

// ─── Discoverability: autocomplete, the popover, and every language ─────────
{
    const names = DERIVED_FUNCTIONS.map(fn => fn.name);
    for (const name of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'sign', 'step']) {
        assert.ok(names.includes(name), `${name}() must be offered by autocomplete`);
        assert.equal(DERIVED_FUNCTIONS.find(fn => fn.name === name).arity, 1, `${name}() takes one operand`);
    }
    for (const [alias, target] of [['arcsin', 'asin'], ['arccos', 'acos'], ['arctan', 'atan'],
        ['sgn', 'sign'], ['signum', 'sign'], ['heaviside', 'step']]) {
        assert.equal(DERIVED_FUNCTION_ALIASES.get(alias), target, `${alias} is an alias of ${target}`);
    }
    assert.equal(DERIVED_CONSTANTS.get('pi'), Math.PI, 'pi is π');
    assert.equal(DERIVED_CONSTANTS.get('e'), Math.E, 'e is Euler');
    assert.equal(DERIVED_CONSTANTS.get('math.pi'), Math.PI, 'math.pi is π');
    assert.equal(DERIVED_CONSTANTS.get('math.e'), Math.E, 'math.e is Euler');
    // Lowercase keys only — lookup lowercases the name before asking.
    for (const key of DERIVED_CONSTANTS.keys()) {
        assert.equal(key, key.toLowerCase(), `constant key ${key} must be lowercase`);
    }
    checks++;

    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const popover = html.slice(html.indexOf('id="derived-help-popover"'), html.indexOf('id="derived-form"'));
    assert.ok(popover, 'the formula-help popover is in index.html');

    // Wider, and laid out in columns: the point of the width is that the panel
    // gets shorter, not that the same column gets roomier.
    assert.ok(popover.includes('derived-help-popover-wide'), 'the popover opens in its wide form');
    assert.ok(popover.includes('derived-help-grid'), 'its rows sit in the multi-column grid');
    const css = readFileSync(new URL('../src/styles/sidebar.css', import.meta.url), 'utf8');
    assert.match(css, /\.derived-help-popover-wide \.derived-help-grid \{[^}]*columns:/, 'the wide form is what turns on the columns');
    assert.match(css, /\.derived-help-grid > \.derived-help-row \{[^}]*break-inside: avoid/, 'a row must not split across columns');
    checks++;

    for (const fragment of ['sin(x)', 'cos(x)', 'tan(x)', 'asin(x)', 'acos(x)', 'atan(x)',
        'sinh(x)', 'cosh(x)', 'tanh(x)', 'sign(x), step(x)', '2*step(sin(2*pi*50*time))-1',
        'sin(2*pi*1000*time)', 'x + 0.1*sin(2*pi*50*time)', 'pi, e', 'math.pi, math.e']) {
        assert.ok(popover.includes(fragment), `the popover must show ${fragment}`);
    }
    // Every sentence in the new rows is translated; only the code samples are
    // literal. A hardcoded English line would read as English in all four.
    const keys = ['derivedHelpRadians', 'derivedHelpTimeAxis', 'derivedHelpTimeAxisText',
        'derivedHelpTimeAxisTone', 'derivedHelpTimeAxisAdd', 'derivedHelpTimeAxisUnits',
        'derivedHelpTimeAxisSquare', 'derivedHelpSign',
        'derivedHelpConstants', 'derivedHelpConstantsText'];
    for (const key of keys) {
        assert.ok(popover.includes(`data-i18n="${key}"`), `the popover must bind ${key}`);
        for (const lang of Object.keys(translations)) {
            const value = translations[lang][key];
            assert.ok(typeof value === 'string' && value.trim(), `${lang} must translate ${key}`);
        }
    }
    checks++;

    // Each language says it in its own words rather than inheriting English.
    // 'Constants' is spelled the same in French, so it is exempt.
    for (const key of keys.filter(k => k !== 'derivedHelpConstants')) {
        for (const lang of Object.keys(translations)) {
            if (lang === 'en') continue;
            assert.notEqual(translations[lang][key], translations.en[key], `${lang}.${key} is still the English string`);
        }
    }
    checks++;

    // The long-form help (Help → Create and process signals) carries the tone
    // recipe in every language, since that is where a reader goes for the why.
    for (const lang of Object.keys(translations)) {
        const body = translations[lang].helpSec10Body;
        for (const fragment of ['sin(2*pi*1000*time)', '<code>asin</code>', '<code>tanh</code>',
            '<code>step</code>', '2*step(sin(', 'math.pi']) {
            assert.ok(body.includes(fragment), `${lang}.helpSec10Body must mention ${fragment}`);
        }
    }
    checks++;
}

// ─── Autocomplete offers them, and offers the reachable spelling ────────────
//
// The popover tells the reader to "start typing to autocomplete", so a constant
// that never appears in the list is a promise the app does not keep.
{
    class Host {}
    installDerivedMethods(Host);
    const host = new Host();
    const suggest = (prefix, variables) => {
        host.plotManager = { data: { variables } };
        return host._getDerivedSuggestions(prefix);
    };
    const free = makeDataset(8).variables;
    const shadowed = { ...free, pi: { name: 'pi', kind: 'variable', data: new Float64Array(8).fill(7) } };

    const names = (list) => list.map(s => s.name);

    // Free name: the short spelling, tagged as a constant rather than a variable.
    const forPi = suggest('pi', free);
    assert.ok(names(forPi).includes('pi'), `typing "pi" must offer pi: ${names(forPi)}`);
    assert.equal(forPi.find(s => s.name === 'pi').kind, 'const', 'it is labelled a constant');
    assert.equal(forPi.find(s => s.name === 'pi').type, 'constant', 'and carries the constant type');
    assert.ok(names(suggest('e', free)).includes('e'), 'typing "e" must offer e');

    // Shadowed: the short name belongs to the file, so the list offers the only
    // spelling that still reaches the number — alongside the variable itself.
    const forShadowed = suggest('pi', shadowed);
    assert.ok(names(forShadowed).includes('math.pi'), `a shadowed pi must offer math.pi: ${names(forShadowed)}`);
    assert.ok(!names(forShadowed).includes('pi') || forShadowed.find(s => s.name === 'pi').type === 'variable',
        'the bare "pi" in the list is the file variable, not the constant');
    assert.ok(names(suggest('math', shadowed)).includes('math.pi'), 'typing "math" finds it too');
    assert.ok(!names(suggest('pi', free)).includes('math.pi'), 'the escape spelling stays out of the way when unneeded');

    // The new functions are reachable by prefix.
    for (const [prefix, expected] of [['si', 'sin'], ['co', 'cos'], ['ta', 'tan'], ['as', 'asin'],
        ['ac', 'acos'], ['at', 'atan'], ['sinh', 'sinh'], ['cosh', 'cosh'], ['tanh', 'tanh'],
        ['sig', 'sign'], ['st', 'step']]) {
        assert.ok(names(suggest(prefix, free)).includes(expected), `typing "${prefix}" must offer ${expected}`);
    }

    // The box shows at most eight rows; constants must count against that budget
    // rather than pushing it over.
    const many = { ...free };
    for (let i = 0; i < 30; i++) many[`sig_${i}`] = { name: `sig_${i}`, kind: 'variable', data: new Float64Array(8) };
    for (const prefix of ['s', 'a', 'e', 'pi']) {
        assert.ok(suggest(prefix, many).length <= 8, `"${prefix}" must not overflow the suggestion box`);
    }
    checks++;
}

console.log(`derived trig/constants: ${checks} checks passed`);
