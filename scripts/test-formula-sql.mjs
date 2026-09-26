// A formula translated to SQL gives the numbers the in-memory compiler gives.
//
//   node scripts/test-formula-sql.mjs
//
// Every formula below runs twice over the same values: through compile.js, as a
// file in memory computes it, and as SQL on the DuckDB-WASM engine the app
// ships, as a lazy file will. The values are chosen to hit every corner where
// the two languages disagree — zero and minus zero, both infinities, NaN and an
// empty cell, the largest and smallest doubles, negatives under roots and
// logarithms — in every pairing of two columns.
//
// Three standards, from strictest:
//   · arithmetic (+ − × ÷), sqrt, abs, sign, step, min, max and square must
//     agree exactly — IEEE 754 fixes their results;
//   · a transcendental function applied once (sin(a), log(a), pow(a, b), …)
//     may differ by 2 units in the last place: V8 and DuckDB (musl) carry
//     different maths libraries, and this measures them;
//   · a composition of them must agree to 12 significant digits. Composing
//     ill-conditioned steps amplifies those last bits — log(log(log(3)))
//     differs by 5 ulps, because log is steep near 1 — and would do so between
//     two JavaScript engines too. A translation error (a wrong branch, a NaN
//     taken for a number) misses by far more than the 13th digit.
// Whether both sides are NaN, and the sign, must always match. Any query that
// errors fails the test.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { compileFormula } from '../src/expr/compile.js';
import { formulaToSql, FormulaNotTranslatable } from '../src/expr/sql.js';

const require = createRequire(import.meta.url);
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const dist = path.dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));
const db = await duckdb.createDuckDB({
    mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
    eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
}, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
await db.instantiate();
db.open({});
const conn = db.connect();

// ── The values ──────────────────────────────────────────────────────────────
// `null` is an empty cell (NULL in SQL); NaN is a cell that says NaN. In
// memory both are NaN.
const VALUES = [
    0, -0, 1, -1, 2, -2, 0.5, -0.5, 3, -3, 8, -8, 27, -27, 16, 0.1, -0.1, 10, 100, 1000, -1000,
    2.5, -2.5, 1e-12, 1e-300, -1e-300, 1e308, -1e308, 7.999999999999999, 4503599627370496.5,
    Infinity, -Infinity, NaN, null, Math.PI, Math.PI / 2, -Math.PI / 2,
];
const pairs = [];
for (const a of VALUES) for (const b of VALUES) pairs.push([a, b]);
const sqlValue = v => (v === null ? 'NULL' : `CAST('${Number.isNaN(v) ? 'NaN' : v === Infinity ? 'inf' : v === -Infinity ? '-inf' : Object.is(v, -0) ? '-0.0' : String(v)}' AS DOUBLE)`);
conn.query(`CREATE TABLE t AS SELECT * FROM (VALUES ${pairs.map(([a, b], i) =>
    `(${i}, ${sqlValue(a)}, ${sqlValue(b)}, ${sqlValue(VALUES[(i * 7) % VALUES.length])})`).join(',\n')}) AS v(id, a, b, c)`);
const N = pairs.length;
const toJs = v => (v === null ? NaN : v);
const columns = {
    a: Float64Array.from(pairs, ([a]) => toJs(a)),
    b: Float64Array.from(pairs, ([, b]) => toJs(b)),
    c: Float64Array.from(pairs, (_, i) => toJs(VALUES[(i * 7) % VALUES.length])),
};
const PARAMS = { p: 2, q: -0.5, z: 0 };
const variables = {
    a: { data: columns.a }, b: { data: columns.b }, c: { data: columns.c },
    ...Object.fromEntries(Object.entries(PARAMS).map(([name, value]) => [name, { kind: 'parameter', data: [value] }])),
};
const classify = name => (name in PARAMS ? 'scalar' : 'series');
const resolve = name => (name in PARAMS ? { scalar: PARAMS[name] } : { sql: `"${name}"` });

// Units in the last place between two doubles of the same sign.
const ulps = (x, y) => {
    const buf = new DataView(new ArrayBuffer(16));
    buf.setFloat64(0, x); buf.setFloat64(8, y);
    return Number(buf.getBigInt64(0) - buf.getBigInt64(8) < 0n ? buf.getBigInt64(8) - buf.getBigInt64(0) : buf.getBigInt64(0) - buf.getBigInt64(8));
};
const EXACT_ONLY = /^[\sabcpqz0-9.+\-*/(),]*$|^(?:[\sabcpqz0-9.+\-*/(),]|sqrt|abs|sign|step|min|max|square)*$/;

let maxUlps = 0;
let worst = '';
let maxRelative = 0;
let worstRelative = '';
let checked = 0;
const SINGLE_CALL = /^\s*[a-z0-9]+\(\s*[abc]\s*(?:,\s*[abc0-9.\-]+\s*)?\)\s*$|^\s*[abc]\s*\^\s*[abc0-9.\-]+\s*$/;
function check(formula) {
    const expected = compileFormula(formula, variables, classify).run(columns, PARAMS, N);
    const sql = formulaToSql(formula, variables, resolve);
    // Never try(): on rows that error it drops to row-by-row evaluation — 14 s
    // instead of 0.1 s over 5M rows. Domains are guarded before the call.
    assert.ok(!/\btry\(/.test(sql), `${formula}: the SQL must not rely on try()`);
    let result;
    try {
        result = conn.query(`SELECT ${sql} AS v FROM t ORDER BY id`).getChildAt(0);
    } catch (err) {
        assert.fail(`${formula}: the SQL failed — ${err.message.split('\n')[0]}`);
    }
    const exact = EXACT_ONLY.test(formula);
    const single = SINGLE_CALL.test(formula);
    for (let i = 0; i < N; i++) {
        const got = result.get(i);
        const actual = got === null ? NaN : Number(got);
        const want = expected[i];
        if (Number.isNaN(want) || Number.isNaN(actual)) {
            assert.ok(Number.isNaN(want) && Number.isNaN(actual),
                `${formula} at a=${pairs[i][0]}, b=${pairs[i][1]}: expected ${want}, got ${actual}`);
            continue;
        }
        // Zeros must carry the same sign: -0 prints as 0, but one division
        // later it is -Infinity where +0 gives Infinity.
        if (want === 0 || actual === 0) {
            assert.ok(Object.is(actual, want), `${formula} at a=${pairs[i][0]}, b=${pairs[i][1]}: expected ${Object.is(want, -0) ? '-0' : want}, got ${Object.is(actual, -0) ? '-0' : actual}`);
            continue;
        }
        if (actual === want) continue;
        assert.ok(!exact, `${formula} at a=${pairs[i][0]}, b=${pairs[i][1]}: expected exactly ${want}, got ${actual}`);
        assert.ok(Number.isFinite(want) && Number.isFinite(actual) && Math.sign(want) === Math.sign(actual),
            `${formula} at a=${pairs[i][0]}, b=${pairs[i][1]}: expected ${want}, got ${actual}`);
        const where = `${formula} at a=${pairs[i][0]}, b=${pairs[i][1]}: ${want} vs ${actual}`;
        if (single) {
            const distance = ulps(actual, want);
            if (distance > maxUlps) { maxUlps = distance; worst = where; }
            assert.ok(distance <= 2, `${where} (${distance} ulps for a single call)`);
            continue;
        }
        const relative = Math.abs(actual - want) / Math.max(Math.abs(actual), Math.abs(want));
        if (relative > maxRelative) { maxRelative = relative; worstRelative = where; }
        assert.ok(relative <= 1e-12, `${where} (relative difference ${relative.toExponential(2)})`);
    }
    checked++;
}

// ── Every operator and function, on its own and against the corners ────────
const handWritten = [
    'a + b', 'a - b', 'a * b', 'a / b', '-a', '-(a - b)', 'a + 1', '1 / a', '0 / a', 'a / 0',
    'a ^ 2', 'a ^ 0', 'a ^ 0.5', 'a ^ -1', 'a ^ b', 'a ^ q', 'a ^ z', '2 ^ a', 'power(a, b)', 'power(a, 3)',
    'sqrt(a)', 'abs(a)', 'log(a)', 'log10(a)', 'log(a * b)', 'log(0)', 'log10(0)',
    'sin(a)', 'cos(a)', 'tan(a)', 'asin(a)', 'acos(a)', 'atan(a)', 'sinh(a)', 'cosh(a)', 'tanh(a)',
    'sign(a)', 'step(a)', 'step(a - b)', 'sign(a * b)', 'square(a)', 'square(a - b)',
    'min(a, b)', 'max(a, b)', 'min(a, 0)', 'max([a, b, c])', 'min(a, b, c, p)', 'max(a, q)',
    'root(a, 3)', 'root(a, 2)', 'root(a, -3)', 'root(a, 0.5)', 'root(a, 0)', 'root(a * b, 5)', 'root(27, 3)',
    'sqrt(a ^ 2 + b ^ 2)', 'log(log(log(a)))', 'sqrt(sqrt(sqrt(a * b)))', 'atan(a / b) * 180 / pi',
    'p * a + q', 'p', 'q * z', 'min(max(a, -1), 1)', 'step(sin(a)) * cos(b)', 'a * e',
    // Minus zero, followed through a division that exposes its sign.
    '1 / min(a, b)', '1 / max(a, b)', '1 / sign(a)', '1 / root(a, 1)', '1 / root(a, 3)', '1 / sqrt(a)', '1 / -a', '1 / (a * b)',
];
for (const formula of handWritten) check(formula);
console.log(`formula SQL: ${handWritten.length} hand-written formulas agree`);
console.log(`  single calls: worst ${maxUlps} ulp${worst ? ` (${worst})` : ''}`);

// ── And random ones ─────────────────────────────────────────────────────────
// A fixed seed, so a failure names a formula that can be run again. Formulas
// are built as trees so every subexpression's text is known.
let seed = 20260926;
const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = list => list[Math.floor(random() * list.length)];
const EXACT_UNARY = ['sqrt', 'abs', 'sign', 'step', 'square'];
const ALL_UNARY = [...EXACT_UNARY, 'log', 'log10', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh'];
const LEAVES = ['a', 'b', 'c', 'p', 'q', 'z', '2', '0.5', '0', '3'];
function randomTree(depth, exactOnly) {
    if (depth <= 0 || random() < 0.2) return { text: pick(LEAVES), children: [] };
    const r = random();
    const child = () => randomTree(depth - 1, exactOnly);
    if (r < 0.35) {
        const op = pick(exactOnly ? ['+', '-', '*', '/'] : ['+', '-', '*', '/', '^']);
        const [x, y] = [child(), child()];
        return { text: `(${x.text} ${op} ${y.text})`, children: [x, y], shape: (u, v) => `(${u} ${op} ${v})` };
    }
    if (r < 0.75) {
        const fn = pick(exactOnly ? EXACT_UNARY : ALL_UNARY);
        const x = child();
        return { text: `${fn}(${x.text})`, children: [x], shape: u => `${fn}(${u})` };
    }
    if (r < 0.85) {
        const fn = pick(['min', 'max']);
        const [x, y] = [child(), child()];
        return { text: `${fn}(${x.text}, ${y.text})`, children: [x, y], shape: (u, v) => `${fn}(${u}, ${v})` };
    }
    if (r < 0.92 && !exactOnly) {
        const degree = pick(['2', '3', '-3', '0.5']);
        const x = child();
        return { text: `root(${x.text}, ${degree})`, children: [x], shape: u => `root(${u}, ${degree})` };
    }
    const x = child();
    return { text: `-${x.text}`, children: [x], shape: u => `-${u}` };
}

// 1) Exact operations only, end to end: bit for bit, zero signs included.
const RANDOM_EXACT = 400;
for (let i = 0; i < RANDOM_EXACT; i++) check(randomTree(5, true).text);
console.log(`formula SQL: ${RANDOM_EXACT} random formulas of exact operations agree bit for bit`);

// 2) Every operation, one at a time. Composed end to end, ill-conditioned
// steps amplify the libraries' last-bit differences without bound — sin of a
// power near 1e15 is a different number for a 1-ulp change in the power. So
// each node of a random formula is checked on its own: its operands are the
// values DuckDB computed for its children, fed to compile.js and to the
// translation of that single operation alike.
const readColumn = (sql) => {
    const vector = conn.query(`SELECT ${sql} AS v FROM t ORDER BY id`).getChildAt(0);
    return Float64Array.from({ length: N }, (_, i) => { const v = vector.get(i); return v === null ? NaN : Number(v); });
};
let operations = 0;
// root() snaps any result within 1e-12 (relative) of an integer to it. Past
// |r| = 5e11 that window is wider than 0.5, so everything snaps, and a result
// sitting on a half — where the two libraries' pow() can land 1 ulp apart —
// rounds to one integer or its neighbour. That is the rounding's own
// discontinuity, not the translation; it is allowed there only, and counted.
let rootRoundingFlips = 0;
function checkNodes(tree) {
    for (const child of tree.children) checkNodes(child);
    if (!tree.children.length) return;
    const operands = tree.children.map(child => readColumn(formulaToSql(child.text, variables, resolve)));
    const names = ['x', 'y'].slice(0, operands.length);
    conn.query('DROP TABLE IF EXISTS operands');
    conn.query(`CREATE TABLE operands AS SELECT * FROM (VALUES ${Array.from({ length: N }, (_, i) =>
        `(${i}, ${operands.map(column => sqlValue(Number.isNaN(column[i]) ? null : column[i])).join(', ')})`).join(',\n')}) AS v(id, ${names.join(', ')})`);
    const formula = tree.shape(...names);
    const opVariables = Object.fromEntries(names.map((name, k) => [name, { data: operands[k] }]));
    const expected = compileFormula(formula, opVariables, () => 'series').run(Object.fromEntries(names.map((name, k) => [name, operands[k]])), {}, N);
    const vector = conn.query(`SELECT ${formulaToSql(formula, opVariables, name => ({ sql: `"${name}"` }))} AS v FROM operands ORDER BY id`).getChildAt(0);
    const exact = EXACT_ONLY.test(formula);
    for (let i = 0; i < N; i++) {
        const got = vector.get(i);
        const actual = got === null ? NaN : Number(got);
        const want = expected[i];
        const where = `${formula} in ${tree.text} with x=${operands[0][i]}${operands[1] ? `, y=${operands[1][i]}` : ''}`;
        if (Number.isNaN(want) || Number.isNaN(actual)) { assert.ok(Number.isNaN(want) && Number.isNaN(actual), `${where}: expected ${want}, got ${actual}`); continue; }
        if (want === 0 || actual === 0) { assert.ok(Object.is(actual, want), `${where}: expected ${Object.is(want, -0) ? '-0' : want}, got ${Object.is(actual, -0) ? '-0' : actual}`); continue; }
        if (actual === want) continue;
        assert.ok(!exact && Number.isFinite(want) && Number.isFinite(actual) && Math.sign(want) === Math.sign(actual), `${where}: expected ${want}, got ${actual}`);
        if (formula.startsWith('root(') && Math.abs(want) * 1e-12 > 0.5
            && Number.isInteger(want) && Number.isInteger(actual) && Math.abs(want - actual) === 1) {
            rootRoundingFlips++;
            continue;
        }
        const distance = ulps(actual, want);
        if (distance > maxUlps) { maxUlps = distance; worst = `${where}: ${want} vs ${actual}`; }
        assert.ok(distance <= 2, `${where}: ${want} vs ${actual} (${distance} ulps)`);
    }
    operations++;
}
const RANDOM_TREES = 150;
for (let i = 0; i < RANDOM_TREES; i++) {
    const tree = randomTree(4, false);
    // And the whole formula must at least run: no error, whatever the values.
    readColumn(formulaToSql(tree.text, variables, resolve));
    checkNodes(tree);
}
console.log(`formula SQL: ${RANDOM_TREES} random formulas run, and each of their ${operations} operations agrees on its own`);
console.log(`  worst difference of a single operation: ${maxUlps} ulp${worst ? ` (${worst})` : ''}`);
console.log(`  root() results past 5e11 rounded to a neighbouring integer: ${rootRoundingFlips}`);

// ── What has no SQL form says so ────────────────────────────────────────────
for (const formula of ['diff(a)', 'cumsum(a)', 'a + diff(b)', 'root(a, b)']) {
    assert.throws(() => formulaToSql(formula, variables, resolve), FormulaNotTranslatable, `${formula} is not translated`);
}
assert.throws(() => formulaToSql('a + b', variables, name => (name === 'b' ? null : resolve(name))), FormulaNotTranslatable,
    'a formula over a variable with no SQL form is not translated');
console.log(`formula SQL: ${checked} formulas checked over ${N} rows each; untranslatable ones refused`);
