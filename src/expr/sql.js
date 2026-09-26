// Translate a derived-variable formula into one DuckDB SQL expression.
//
// A formula over a file in memory-saving (lazy) mode used to be computed in JS
// over the file's overview — ten thousand sampled rows — and that was all it
// ever had: zooming in never added detail, the export wrote the overview, and
// the heatmap and temporal profile refused it. As SQL, the formula is
// evaluated by DuckDB wherever the file's own columns are: every zoom, the
// exact export, the heatmap, the profile, the correlations.
//
// The expression must give the numbers compile.js gives. SQL and JavaScript
// disagree on a surprising number of corners, all measured on the DuckDB the
// app ships (1.4):
//
//   JavaScript                      DuckDB
//   sqrt(-1), log(-1), asin(2)      NaN          an error, which fails the whole query
//   log(0)                          -Infinity    an error
//   sin/cos/tan(Infinity)           NaN          an error
//   sign(NaN)                       NaN          0
//   NaN > 0                         false        true (NaN sorts above everything)
//   min(1, NaN)                     NaN          1 (least() skips NaN and NULL)
//   pow(1, Infinity)                NaN          1
//   pow(NaN, 0)                     1            NULL (NULL propagates)
//   min(0, -0)                      -0           0 (least() does not order zeros)
//   sign(-0)                        -0           0
//
// Minus zero matters although it prints as 0: one division later it is the
// difference between -Infinity and Infinity.
//
// So the expression keeps one invariant: every value it computes is either a
// number that is not NaN (±Infinity included) or NULL, and NULL plays the part
// NaN plays in JavaScript. Inputs are brought into it (NaN becomes NULL), every
// operation that can make a NaN puts its result back into it, and every
// function is written so that it errors on nothing and gives NULL exactly
// where JavaScript gives NaN. The app already reads NULL back as NaN.
//
// "Errors on nothing" is done by keeping out-of-domain values away from the
// function — ln(CASE WHEN x > 0 THEN x END) — never by catching the error with
// try(). Measured on 5M rows where half of them are out of domain: try() fell
// back to evaluating row by row and took 14 s; the guarded form takes 0.1 s.
//
// diff() and cumsum() read the previous row: a window over the whole file.
// DuckDB streams `OVER ()` windows, but a window cannot sit in the SELECT that
// filters the zoomed rows, or it would see only those. So each becomes a
// window column (src/data/lazy-tool-sql.js): its SQL is a reference to the
// column, and the columns the formula needs are handed back in `out.windows`
// for the query to select FROM (DuckDbSource._fromSql).
//   · diff: x[i] − x[i−1]; the first sample takes the forward difference, a
//     single row gives 0, and diff of a constant is a zero series.
//   · cumsum: the running sum in row order — the order compile.js adds in, so
//     the sums are the same doubles. SUM() skips NULLs where a NaN poisons
//     every later sample in JavaScript, so a NULL so far gives NULL.
//
// What cannot be translated says so and the caller keeps the overview:
//   · root() with a degree that is not a number written in the formula: its
//     branches depend on the degree's value, decided here, once.
//   · a variable with no SQL form of its own — a formula that itself could not
//     be translated, a time axis generated from the row number, an
//     independent-index variable.

import { parse, tokenize } from './parse.js';
import { flattenLists } from './compile.js';
import { quoteIdent, windowColumn } from '../data/lazy-tool-sql.js';

// A formula this long in SQL has nested enough shared subexpressions that it
// is not worth sending: the overview is the honest answer then.
const MAX_SQL_LENGTH = 20000;

const NAN = "CAST('NaN' AS DOUBLE)";
const MINUS_ZERO = "CAST('-0.0' AS DOUBLE)";
const PLUS_ZERO = "CAST('0' AS DOUBLE)";
const NULL_DOUBLE = 'CAST(NULL AS DOUBLE)';
const WINDOW_REF = /__omv_w_[0-9a-f]{16}/g;
const RUNNING = 'OVER (ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)';

export class FormulaNotTranslatable extends Error {
    constructor(reason) {
        super(reason);
        this.name = 'FormulaNotTranslatable';
        this.reason = reason;
    }
}

// A finite number as a DOUBLE literal. String() is the shortest text that reads
// back as the same double, and DuckDB's string cast is a correctly rounded
// parse, so the literal is the number the formula wrote — not a DECIMAL
// rounded on the way in.
function literal(value) {
    if (Number.isNaN(value)) return NULL_DOUBLE;
    if (value === Infinity) return "CAST('inf' AS DOUBLE)";
    if (value === -Infinity) return "CAST('-inf' AS DOUBLE)";
    return `CAST('${String(value)}' AS DOUBLE)`;
}

// Nodes carry their SQL and whether it is cheap enough to write twice. A
// column read or a literal is; anything computed is bound once, through a
// one-element lambda, so a formula like log(log(log(x))) does not grow as
// 2^depth.
const node = (sql, cheap = false) => ({ sql, cheap });

// A number written in the formula, sign included: the parser reads `-3` as a
// minus applied to 3, but as a degree or an exponent it is the number -3.
function constantValue(n) {
    if (n.type === 'number') return n.value;
    if (n.type === 'unary') {
        const inner = constantValue(n.expr);
        return inner === null ? null : -inner;
    }
    return null;
}

/**
 * @param {string} formula
 * @param {object} variables the file's variables, as the tokenizer needs them
 * @param {(name: string) => ({ scalar: number } | { sql: string, windows?: Array } | null)} resolve
 *   how a name reads: a scalar value, the SQL of a column (any SQL giving a
 *   DOUBLE or NULL, with the window columns it reads), or null when it has no
 *   SQL form
 * @param {{ windows?: Array }} [out] receives the window columns the SQL reads
 * @returns {string} the SQL expression
 * @throws {FormulaNotTranslatable} when the formula has no faithful SQL form
 */
export function formulaToSql(formula, variables, resolve, out = null) {
    const ast = flattenLists(parse(tokenize(formula, variables)));
    let lambdaId = 0;

    // Every window column met so far, by name: those of the variables read,
    // and those diff() and cumsum() create.
    const registry = new Map();
    const windowsIn = (text) => {
        const found = new Map();
        const visit = (sql) => {
            for (const name of sql.match(WINDOW_REF) || []) {
                const window = registry.get(name);
                if (!window || found.has(name)) continue;
                found.set(name, window);
                visit(window.sql);
            }
        };
        visit(text);
        return [...found.values()];
    };
    const asColumn = (sql) => {
        const window = windowColumn(sql, windowsIn(sql));
        registry.set(window.column, window);
        return quoteIdent(window.column);
    };
    const hasSeries = (n) => {
        if (n.type === 'name') return !!resolve(n.value)?.sql;
        if (n.type === 'unary') return hasSeries(n.expr);
        if (n.type === 'binary') return hasSeries(n.left) || hasSeries(n.right);
        if (n.type === 'func') return n.args.some(hasSeries);
        return false;
    };

    const share = (value, body) => {
        if (value.cheap) return body(value.sql);
        const v = `omv_v${lambdaId++}`;
        return `list_transform([${value.sql}], lambda ${v}: ${body(v)})[1]`;
    };
    const shareAll = (values, body) => {
        const refs = [];
        const step = (index) => {
            if (index === values.length) return body(refs);
            return share(values[index], ref => { refs[index] = ref; return step(index + 1); });
        };
        return step(0);
    };
    // Back into the invariant: an operation that made a NaN hands on NULL.
    const settle = (sql) => `NULLIF(${sql}, ${NAN})`;

    const emit = (n) => {
        switch (n.type) {
            case 'number':
                return node(literal(n.value), true);
            case 'name': {
                const resolved = resolve(n.value);
                if (!resolved) throw new FormulaNotTranslatable(`"${n.value}" has no SQL form`);
                if ('scalar' in resolved) return node(literal(Number(resolved.scalar)), true);
                for (const window of resolved.windows || []) registry.set(window.column, window);
                return node(settle(resolved.sql), true);
            }
            case 'unary': {
                const inner = emit(n.expr);
                return node(`(-(${inner.sql}))`, inner.cheap);
            }
            case 'binary': {
                if (n.op === '^') return power(emit(n.left), n.right);
                const a = emit(n.left);
                const b = emit(n.right);
                return node(settle(`(${a.sql} ${n.op} ${b.sql})`));
            }
            case 'func':
                return func(n);
            default:
                throw new FormulaNotTranslatable(`unexpected "${n.type}"`);
        }
    };

    // JavaScript's Math.pow, not C's: x^0 is 1 whatever x is (NaN included),
    // and ±1 to an infinite power is NaN. An exponent written in the formula
    // — the usual x^2 — settles both at translation time.
    function power(base, exponentNode) {
        const constant = constantValue(exponentNode);
        if (constant !== null) {
            if (constant === 0) return node(literal(1), true);
            return node(settle(`pow(${base.sql}, ${literal(constant)})`));
        }
        const exponent = emit(exponentNode);
        return node(shareAll([base, exponent], ([x, y]) => (
            `(CASE WHEN ${y} = 0 THEN ${literal(1)}`
            + ` WHEN ${x} IS NULL OR ${y} IS NULL THEN ${NULL_DOUBLE}`
            + ` WHEN isinf(${y}) AND abs(${x}) = 1 THEN ${NULL_DOUBLE}`
            + ` ELSE ${settle(`pow(${x}, ${y})`)} END)`
        )));
    }

    function func(n) {
        const name = n.name;
        if (name === 'diff') {
            if (!hasSeries(n.args[0])) return node(literal(0), true);
            // The operand one level down, so LAG reads a column.
            const v = asColumn(emit(n.args[0]).sql);
            return node(asColumn(
                `(CASE WHEN LAG(TRUE, 1, FALSE) OVER () THEN ${settle(`${v} - LAG(${v}) OVER ()`)}`
                + ` WHEN LEAD(TRUE, 1, FALSE) OVER () THEN ${settle(`LEAD(${v}) OVER () - ${v}`)}`
                + ` ELSE ${literal(0)} END)`), true);
        }
        if (name === 'cumsum') {
            const v = asColumn(emit(n.args[0]).sql);
            return node(asColumn(
                `(CASE WHEN COUNT(*) ${RUNNING} > COUNT(${v}) ${RUNNING} THEN ${NULL_DOUBLE}`
                + ` ELSE ${settle(`SUM(${v}) ${RUNNING}`)} END)`), true);
        }
        if (name === 'power') return power(emit(n.args[0]), n.args[1]);
        if (name === 'root') return root(n);
        if (name === 'min' || name === 'max') {
            // Math.min/max: NaN as soon as any operand is NaN — least/greatest
            // skip NULLs, so the NULL test comes first — and -0 below +0: when
            // the answer is a zero, min is -0 if any operand is -0, max is +0
            // if any operand is +0. least/greatest do not tell them apart.
            const args = n.args.map(emit);
            const isMin = name === 'min';
            // least(...) of operands already bound is cheap to write twice;
            // binding it through a lambda cost more than computing it again
            // (1.1 s against 0.6 s on 5M rows).
            return node(shareAll(args, refs => share(
                node(`${isMin ? 'least' : 'greatest'}(${refs.join(', ')})`, true),
                m => {
                    const zeroOfSign = refs.map(r => `(${r} = 0 AND ${isMin ? '' : 'NOT '}signbit(${r}))`).join(' OR ');
                    return `(CASE WHEN ${refs.map(r => `${r} IS NULL`).join(' OR ')} THEN ${NULL_DOUBLE}`
                        + ` WHEN ${m} = 0 THEN (CASE WHEN ${zeroOfSign} THEN ${isMin ? MINUS_ZERO : PLUS_ZERO} ELSE ${isMin ? PLUS_ZERO : MINUS_ZERO} END)`
                        + ` ELSE ${m} END)`;
                },
            )));
        }
        const x = emit(n.args[0]);
        switch (name) {
            // Out-of-domain inputs become NULL before the function sees them,
            // which is exactly where JavaScript gives NaN: sqrt of a negative
            // or of -Infinity (sqrt(-0) is -0 in both, and -0 >= 0 holds), asin
            // and acos outside [-1, 1], the trigonometric functions of
            // ±Infinity.
            case 'sqrt': return node(share(x, v => `sqrt(CASE WHEN ${v} >= 0 THEN ${v} END)`));
            case 'sin': case 'cos': case 'tan':
                return node(share(x, v => `${name}(CASE WHEN NOT isinf(${v}) THEN ${v} END)`));
            case 'asin': case 'acos':
                return node(share(x, v => `${name}(CASE WHEN ${v} BETWEEN -1 AND 1 THEN ${v} END)`));
            case 'atan': case 'sinh': case 'cosh': case 'tanh':
                return node(`${name}(${x.sql})`);
            case 'abs': return node(`abs(${x.sql})`);
            // log of zero is -Infinity in JavaScript, an error in DuckDB; log
            // of a negative is NaN in one and an error in the other.
            case 'log': case 'log10': {
                const fn = name === 'log' ? 'ln' : 'log10';
                return node(share(x, v => `(CASE WHEN ${v} = 0 THEN ${literal(-Infinity)} ELSE ${fn}(CASE WHEN ${v} > 0 THEN ${v} END) END)`));
            }
            // sign() of NaN is 0 in DuckDB; with NaN already NULL it is NULL.
            // Math.sign hands a zero back as it came, sign or not.
            case 'sign': return node(share(x, v => `(CASE WHEN ${v} = 0 THEN ${v} ELSE CAST(sign(${v}) AS DOUBLE) END)`));
            // 1 from zero upwards, 0 below, NaN stays NaN: sign gives -1, 0 or
            // 1, and ceil((s + 1) / 2) maps them to 0, 1, 1 — reading x once.
            case 'step': return node(`CAST(ceil((sign(${x.sql}) + 1) / 2.0) AS DOUBLE)`);
            case 'square': return node(share(x, v => `(${v} * ${v})`));
            default:
                throw new FormulaNotTranslatable(`unknown function "${name}"`);
        }
    }

    // nthRoot() in compile.js: an odd integer degree takes the real root of a
    // negative value, and a result within 1e-12 (relative) of an integer is
    // snapped to it. The degree's branches are decided here, so the degree has
    // to be a number written in the formula.
    function root(n) {
        const d = constantValue(n.args[1]);
        if (d === null) throw new FormulaNotTranslatable('root() with a degree that is not a number');
        if (!Number.isFinite(d) || d === 0) return node(NULL_DOUBLE, true);
        const rounded = Math.round(d);
        const oddInteger = Math.abs(d - rounded) <= 1e-12 && rounded % 2 !== 0;
        const x = emit(n.args[0]);
        const raw = oddInteger
            ? share(x, v => `(CASE WHEN ${v} < 0 THEN -pow(-${v}, ${literal(1 / rounded)}) ELSE pow(${v}, ${literal(1 / d)}) END)`)
            : `pow(${x.sql}, ${literal(1 / d)})`;
        // Math.round is floor(x + 0.5), except that it gives -0 for x in
        // [-0.5, -0]; DuckDB's round() goes half away from zero. They differ at
        // exact halves (which can snap on very large results) and in the sign
        // of a zero, so the JavaScript definition is written out. A zero is
        // its own rounding, sign and all.
        return node(share(node(settle(raw)), r => (
            `(CASE WHEN ${r} IS NULL OR isinf(${r}) OR ${r} = 0 THEN ${r}`
            + ` WHEN abs(${r} - floor(${r} + 0.5)) <= greatest(1, abs(${r})) * 1e-12`
            + ` THEN (CASE WHEN ${r} < 0 AND floor(${r} + 0.5) = 0 THEN ${MINUS_ZERO} ELSE floor(${r} + 0.5) END)`
            + ` ELSE ${r} END)`
        )));
    }

    const sql = emit(ast).sql;
    const windows = windowsIn(sql);
    const length = windows.reduce((total, window) => total + window.sql.length, sql.length);
    if (length > MAX_SQL_LENGTH) throw new FormulaNotTranslatable('the formula is too large to evaluate in SQL');
    if (out) out.windows = windows.sort((a, b) => a.level - b.level || (a.column < b.column ? -1 : 1));
    return sql;
}
