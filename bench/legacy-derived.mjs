// Verbatim copy of the derived-variable tree-walking evaluator as it existed
// BEFORE src/expr/compile.js replaced it (`_evalDerivedNode`,
// `_evalDerivedFunction`, `_nthRoot`, `_cleanDerivedNumber` and the
// `_evaluateDerivedFormula` wrapper around them).
//
// Frozen on purpose, same contract as the other bench/legacy-*.mjs modules:
// scripts/test-expr-compiler.mjs asserts the compiler agrees with it bit for
// bit, and scripts/bench-derived.mjs measures against it. Do not optimize it.

import { parse, tokenize } from '../src/expr/parse.js';

function nthRoot(value, degree) {
    const d = Number(degree);
    if (!Number.isFinite(d) || d === 0) return NaN;
    const rounded = Math.round(d);
    const isIntegerDegree = Math.abs(d - rounded) <= 1e-12;
    let result;
    if (value < 0 && isIntegerDegree && rounded % 2 !== 0) {
        result = -Math.pow(Math.abs(value), 1 / rounded);
    } else {
        result = Math.pow(value, 1 / d);
    }
    return cleanNumber(result);
}

function cleanNumber(value) {
    if (!Number.isFinite(value)) return value;
    const rounded = Math.round(value);
    const tolerance = Math.max(1, Math.abs(value)) * 1e-12;
    return Math.abs(value - rounded) <= tolerance ? rounded : value;
}

function evalNode(node, data, n) {
    if (node.type === 'number') return { kind: 'scalar', value: node.value };
    if (node.type === 'name') {
        const variable = data.variables[node.value];
        if (!variable) throw new Error(`Unknown variable "${node.value}".`);
        if (variable.kind === 'parameter' || variable.data.length === 1) return { kind: 'scalar', value: Number(variable.data[0]) };
        if (variable.data.length !== n) throw new Error(`"${node.value}" has ${variable.data.length} points, but time has ${n}.`);
        return { kind: 'series', values: variable.data };
    }
    if (node.type === 'unary') {
        const v = evalNode(node.expr, data, n);
        return v.kind === 'scalar' ? { kind: 'scalar', value: -v.value } : { kind: 'series', values: v.values.map(x => -x) };
    }
    if (node.type === 'func') return evalFunction(node, data, n);
    const left = evalNode(node.left, data, n);
    const right = evalNode(node.right, data, n);
    const apply = (a, b) => {
        switch (node.op) {
            case '+': return a + b;
            case '-': return a - b;
            case '*': return a * b;
            case '/': return a / b;
            case '^': return Math.pow(a, b);
            default: throw new Error(`Unknown operator "${node.op}".`);
        }
    };
    if (left.kind === 'scalar' && right.kind === 'scalar') return { kind: 'scalar', value: apply(left.value, right.value) };
    const values = new Array(n);
    for (let i = 0; i < n; i++) values[i] = apply(left.kind === 'series' ? left.values[i] : left.value, right.kind === 'series' ? right.values[i] : right.value);
    return { kind: 'series', values };
}

function evalFunction(node, data, n) {
    const name = node.name;
    const args = node.args.map(arg => evalNode(arg, data, n));
    const arity = args.length;
    const requireArity = (expected, label = name) => {
        if (arity !== expected) throw new Error(`${label}() expects ${expected} argument${expected === 1 ? '' : 's'}.`);
    };
    const valueAt = (arg, i) => arg.kind === 'series' ? arg.values[i] : arg.value;
    const mapUnary = (fn) => {
        const a = args[0];
        if (a.kind === 'scalar') return { kind: 'scalar', value: fn(a.value) };
        return { kind: 'series', values: a.values.map(fn) };
    };
    const mapBinary = (fn) => {
        const [a, b] = args;
        if (a.kind === 'scalar' && b.kind === 'scalar') return { kind: 'scalar', value: fn(a.value, b.value) };
        const values = new Array(n);
        for (let i = 0; i < n; i++) values[i] = fn(valueAt(a, i), valueAt(b, i));
        return { kind: 'series', values };
    };

    if (name === 'sqrt') { requireArity(1, name); return mapUnary(v => Math.sqrt(v)); }
    if (name === 'abs') { requireArity(1, name); return mapUnary(v => Math.abs(v)); }
    if (name === 'log') { requireArity(1, name); return mapUnary(v => Math.log(v)); }
    if (name === 'log10') { requireArity(1, name); return mapUnary(v => Math.log10(v)); }
    if (name === 'square') { requireArity(1, name); return mapUnary(v => v * v); }
    if (name === 'diff') {
        requireArity(1, name);
        const a = args[0];
        if (a.kind === 'scalar') return { kind: 'series', values: new Array(n).fill(0) };
        const src = a.values;
        const out = new Array(n);
        for (let i = 0; i < n; i++) {
            if (n < 2) { out[i] = 0; continue; }
            out[i] = i === 0
                ? Number(src[1]) - Number(src[0])
                : Number(src[i]) - Number(src[i - 1]);
        }
        return { kind: 'series', values: out };
    }
    if (name === 'root') { requireArity(2, name); return mapBinary((v, degree) => nthRoot(v, degree)); }
    if (name === 'power') { requireArity(2, name); return mapBinary((v, exponent) => Math.pow(v, exponent)); }
    throw new Error(`Unknown function "${name}".`);
}

const activeTimeVar = (data) => Object.values(data.variables).find(v => v.kind === 'abscissa') || null;

export function refEvaluateDerivedFormula(formula, data) {
    const timeVar = activeTimeVar(data);
    if (!timeVar?.data?.length) throw new Error('No time vector found.');
    const tokens = tokenize(formula, data.variables);
    const ast = parse(tokens);
    const referenced = tokens
        .filter(token => token.type === 'name')
        .map(token => data.variables[token.value])
        .filter(variable => variable && variable.kind !== 'parameter');
    const independentIndex = referenced.some(variable => variable.independentIndex);
    const lengths = referenced.map(variable => variable.data?.length || 0).filter(Boolean);
    const n = lengths.length ? Math.min(timeVar.data.length, ...lengths) : timeVar.data.length;
    const evaluated = evalNode(ast, data, n);
    const values = evaluated.kind === 'series' ? evaluated.values : Array.from({ length: n }, () => evaluated.value);
    return { values, independentIndex };
}

// A dataset shaped like a parsed file: a time axis, several signals, a scalar
// parameter and a single-sample variable (which the evaluator treats as a
// scalar, and which clamps n — a quirk the compiler has to reproduce).
export function makeDataset(n, seed = 31337, { includeShortVar = false } = {}) {
    let state = seed >>> 0;
    const rand = () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
    const time = new Float64Array(n);
    const x = new Float64Array(n);
    const y = new Float64Array(n);
    const z = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        time[i] = i * 0.01;
        x[i] = 20 * Math.sin(i * 0.002) + (rand() - 0.5) * 3;
        y[i] = 14 * Math.cos(i * 0.003) + (rand() - 0.5) * 3;
        z[i] = (rand() - 0.5) * 8;
    }
    // Values the maths has to survive: negatives under sqrt/log, and zeros
    // under division.
    if (n > 20) {
        x[3] = -4; y[3] = 0; z[3] = 0;
        x[7] = 0; y[7] = -9;
        x[11] = NaN; y[12] = NaN;
    }
    const variables = {
        time: { name: 'time', kind: 'abscissa', data: time },
        x: { name: 'x', kind: 'variable', data: x },
        y: { name: 'y', kind: 'variable', data: y },
        z: { name: 'z', kind: 'variable', data: z },
        gain: { name: 'gain', kind: 'parameter', data: new Float64Array([2.5]) },
        offset: { name: 'offset', kind: 'parameter', data: new Float64Array([-1.25]) },
    };
    if (includeShortVar) {
        variables.single = { name: 'single', kind: 'variable', data: new Float64Array([7]) };
    }
    return { metadata: { timeName: 'time' }, variables };
}

export const FORMULAS = [
    'x',
    '-x',
    'x + y',
    'x - y',
    'x * y',
    'x / y',
    'x ^ 2',
    'x ^ y',
    'sqrt(x^2 + y^2)',
    'abs(x) + abs(y)',
    'log(abs(x) + 1)',
    'log10(abs(y) + 1)',
    'square(x) - square(y)',
    'power(x, 3)',
    'root(abs(x), 3)',
    'root(x, 3)',
    'diff(x)',
    'diff(diff(x))',
    'diff(x) / diff(time)',
    'diff(x * y + z)',
    'x * gain + offset',
    'gain * offset',
    'gain + 1',
    '2 + 3 * 4',
    'sqrt(square(x) + square(y) + square(z))',
    '(x + y) * (x - y) / (abs(z) + 1)',
    'diff(x) * gain + diff(y) * offset',
    '-(x + y) ^ 2',
    'power(root(abs(x) + 1, 2), 2)',
];
