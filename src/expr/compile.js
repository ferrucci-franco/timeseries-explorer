// Compile a derived-variable formula into a single fused loop.
//
// The evaluator this replaces walked the AST once per formula, and every node
// materialized a whole new array: each binary op allocated `new Array(n)`, each
// function did `.map(fn)` with a closure. For the canonical `sqrt(x^2 + y^2)`
// over 5M samples that is five intermediate 5M-element arrays and a
// megamorphic call per element per node.
//
// This emits one function that reads the source columns, computes into local
// scalars, and writes one Float64Array. Intermediates never exist.
//
// Semantics are unchanged, including the awkward corners:
//   * `diff()` is a neighbour op, not elementwise, so it gets its own pass
//     (see lowerDiffs below) and keeps the forward-difference first sample.
//   * `root()` keeps the odd-negative-degree branch and the integer snapping of
//     the original `_nthRoot` / `_cleanDerivedNumber`.
//   * A formula referring only to scalars still produces a full-length series.
//
// Codegen uses `new Function`, which needs `unsafe-eval`. The app ships no CSP
// today so this is fine; if one is ever added, this is the call site that has
// to move to WebAssembly (see docs/optimization-blueprint.md §2.4).

import { parse, tokenize } from './parse.js';

export function nthRoot(value, degree) {
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
    if (!Number.isFinite(result)) return result;
    const snapped = Math.round(result);
    const tolerance = Math.max(1, Math.abs(result)) * 1e-12;
    return Math.abs(result - snapped) <= tolerance ? snapped : result;
}

const UNARY_MATH = {
    sqrt: 'Math.sqrt',
    abs: 'Math.abs',
    log: 'Math.log',
    log10: 'Math.log10',
};

const ARITY = { sqrt: 1, abs: 1, log: 1, log10: 1, square: 1, diff: 1, root: 2, power: 2 };

function requireArity(name, got) {
    const expected = ARITY[name];
    if (expected === undefined) throw new Error(`Unknown function "${name}".`);
    if (got !== expected) {
        throw new Error(`${name}() expects ${expected} argument${expected === 1 ? '' : 's'}.`);
    }
}

// ─── Pass 1: pull `diff()` out into its own temporaries ───────────────────
//
// Everything else fuses into one loop, but a neighbour op cannot: it needs its
// operand fully materialized. Each diff becomes a temp array, and the node is
// replaced by a reference to it, so the remaining tree is purely elementwise.

function lowerDiffs(node, passes) {
    switch (node.type) {
        case 'number':
        case 'name':
        case 'temp':
            return node;
        case 'unary':
            return { ...node, expr: lowerDiffs(node.expr, passes) };
        case 'binary':
            return { ...node, left: lowerDiffs(node.left, passes), right: lowerDiffs(node.right, passes) };
        case 'func': {
            requireArity(node.name, node.args.length);
            const args = node.args.map(arg => lowerDiffs(arg, passes));
            if (node.name !== 'diff') return { ...node, args };
            const index = passes.length;
            passes.push({ source: args[0] });
            return { type: 'temp', index };
        }
        default:
            throw new Error(`Unexpected node "${node.type}".`);
    }
}

// ─── Pass 2: elementwise codegen ──────────────────────────────────────────

function makeEmitter(classify) {
    let tempId = 0;
    // Statements go in `lines`; the returned string is the expression holding
    // the value. Assigning to a local const rather than inlining is what stops
    // `square(expr)` evaluating `expr` twice.
    return function emit(node, lines) {
        switch (node.type) {
            case 'number':
                return Number.isInteger(node.value) ? `${node.value}` : `${node.value}`;
            case 'name':
                return classify(node.value) === 'scalar' ? scalarRef(node.value) : `${columnRef(node.value)}[i]`;
            case 'temp':
                return `t${node.index}[i]`;
            case 'unary': {
                const inner = emit(node.expr, lines);
                return `(-(${inner}))`;
            }
            case 'binary': {
                const a = emit(node.left, lines);
                const b = emit(node.right, lines);
                if (node.op === '^') return `Math.pow(${a}, ${b})`;
                return `(${a} ${node.op} ${b})`;
            }
            case 'func': {
                const name = node.name;
                requireArity(name, node.args.length);
                if (UNARY_MATH[name]) return `${UNARY_MATH[name]}(${emit(node.args[0], lines)})`;
                if (name === 'square') {
                    const v = `v${tempId++}`;
                    lines.push(`const ${v} = ${emit(node.args[0], lines)};`);
                    return `(${v} * ${v})`;
                }
                if (name === 'power') return `Math.pow(${emit(node.args[0], lines)}, ${emit(node.args[1], lines)})`;
                if (name === 'root') return `R(${emit(node.args[0], lines)}, ${emit(node.args[1], lines)})`;
                throw new Error(`Unknown function "${name}".`);
            }
            default:
                throw new Error(`Unexpected node "${node.type}".`);
        }
    };
}

const identifier = (name) => name.replace(/[^A-Za-z0-9_]/g, '_');
const columnRef = (name) => `c_${identifier(name)}`;
const scalarRef = (name) => `s_${identifier(name)}`;

function collectNames(node, out = new Set()) {
    if (!node || typeof node !== 'object') return out;
    if (node.type === 'name') out.add(node.value);
    if (node.type === 'unary') collectNames(node.expr, out);
    if (node.type === 'binary') { collectNames(node.left, out); collectNames(node.right, out); }
    if (node.type === 'func') node.args.forEach(arg => collectNames(arg, out));
    return out;
}

function hasSeries(node, classify) {
    if (!node || typeof node !== 'object') return false;
    if (node.type === 'temp') return true;
    if (node.type === 'name') return classify(node.value) !== 'scalar';
    if (node.type === 'unary') return hasSeries(node.expr, classify);
    if (node.type === 'binary') return hasSeries(node.left, classify) || hasSeries(node.right, classify);
    if (node.type === 'func') return node.args.some(arg => hasSeries(arg, classify));
    return false;
}

// Operand bindings are hoisted once per generated function, not per loop: a
// formula with two passes (anything containing diff) would otherwise redeclare
// the same const.
function buildBindings(names, classify) {
    return names.map(name => (classify(name) === 'scalar'
        ? `const ${scalarRef(name)} = SCALARS[${JSON.stringify(name)}];`
        : `const ${columnRef(name)} = COLUMNS[${JSON.stringify(name)}];`));
}

function buildLoop(node, classify, target) {
    const emit = makeEmitter(classify);
    const body = [];
    const value = emit(node, body);
    return [
        `for (let i = 0; i < n; i++) {`,
        ...body.map(line => `    ${line}`),
        `    ${target}[i] = ${value};`,
        `}`,
    ].join('\n');
}

/**
 * @param {string} formula
 * @param {(name: string) => 'scalar'|'series'} classify
 * @returns {{ names: string[], run: (COLUMNS, SCALARS, n) => Float64Array }}
 */
export function compileFormula(formula, variables, classify) {
    const tokens = tokenize(formula, variables);
    const ast = parse(tokens);

    const passes = [];
    const root = lowerDiffs(ast, passes);
    const names = [...collectNames(ast)];

    const chunks = [...buildBindings(names, classify)];
    passes.forEach((pass, index) => {
        // `diff(scalar)` is a zero series in the original, and stays one.
        if (!hasSeries(pass.source, classify)) {
            chunks.push(`const t${index} = new Float64Array(n);`);
            return;
        }
        // `diff(x)` over a bare column reads the column directly. Materializing
        // it first would make the single commonest neighbour-op formula SLOWER
        // than the interpreter it replaced — three arrays and three passes for
        // what is one pass over data already in memory.
        const bare = pass.source.type === 'name' && classify(pass.source.value) === 'series';
        const src = bare ? columnRef(pass.source.value) : `src${index}`;
        if (!bare) {
            chunks.push(`const ${src} = new Float64Array(n);`);
            chunks.push(buildLoop(pass.source, classify, src));
        }
        chunks.push([
            `const t${index} = new Float64Array(n);`,
            `if (n >= 2) {`,
            // First sample takes the forward difference so length and the
            // uniform baseline hold — same convention as the time-axis delta.
            `    t${index}[0] = ${src}[1] - ${src}[0];`,
            `    for (let i = 1; i < n; i++) t${index}[i] = ${src}[i] - ${src}[i - 1];`,
            `}`,
        ].join('\n'));
    });

    // A formula that IS a single diff (`diff(x)`) needs no final pass: the temp
    // already holds the answer, freshly allocated and owned by nobody else.
    if (root.type === 'temp') {
        chunks.push(`return t${root.index};`);
        return finish(chunks, names);
    }

    const out = 'out';
    chunks.push(`const ${out} = new Float64Array(n);`);
    if (hasSeries(root, classify)) {
        chunks.push(buildLoop(root, classify, out));
    } else {
        // Scalar-only formula: compute once, fill. The original produced a
        // full-length constant series here too.
        const emit = makeEmitter(classify);
        const body = [];
        const value = emit(root, body);
        chunks.push([...body, `${out}.fill(${value});`].join('\n'));
    }
    chunks.push(`return ${out};`);
    return finish(chunks, names);
}

function finish(chunks, names) {
    const source = chunks.join('\n');
    // eslint-disable-next-line no-new-func
    const run = new Function('COLUMNS', 'SCALARS', 'n', 'R', source);
    return {
        names,
        source,
        run: (columns, scalars, n) => run(columns, scalars, n, nthRoot),
    };
}

// Compiled kernels are cached by formula plus the scalar/series shape of every
// name it mentions. The shape matters: whether `gain` is a parameter or a
// full-length column changes the generated code, and the same formula text can
// be reapplied against a different file.
const cache = new Map();
const CACHE_LIMIT = 200;

export function getCompiledFormula(formula, variables, classify) {
    const probe = tokenize(formula, variables);
    const names = [...new Set(probe.filter(t => t.type === 'name').map(t => t.value))].sort();
    const key = `${formula}\u0000${names.map(name => `${name}:${classify(name)}`).join(',')}`;
    let compiled = cache.get(key);
    if (!compiled) {
        compiled = compileFormula(formula, variables, classify);
        if (cache.size >= CACHE_LIMIT) cache.clear();
        cache.set(key, compiled);
    }
    return compiled;
}

export function clearFormulaCache() {
    cache.clear();
}
