// Data Tools over a file in memory-saving (lazy) mode, written as SQL.
//
// A lazy file's variables are DuckDB expressions over the file, not arrays, so
// a tool's output is one more expression: the source's own SQL with the tool
// applied on top. Every consumer that reads values through
// DuckDbSource._valueExpressionSql — zoom, exact export, heatmap, temporal
// profile, correlations — then reads the tool's output over the whole file, at
// full resolution, without a single array being held.
//
// Three shapes of tool, three shapes of SQL:
//
//   · Pointwise after a pass of statistics (IQR outliers, detrend by mean,
//     line, polynomial or first sample). The statistics — quartiles, a fitted
//     polynomial, the first finite sample — are computed once by the caller,
//     with aggregate queries, and written into the expression as literals.
//
//   · Neighbours (the derivative). The previous and next rows are LAG() and
//     LEAD() over the file's own row order. DuckDB 1.4 runs `OVER ()` with no
//     partition and no order as a STREAMING window: memory stays flat, rows
//     keep their order. Measured on DuckDB-WASM over a 20M-row CSV: the same
//     resident memory as a plain scan, +50 % time.
//
//     The catch is that a window is computed over the rows it is given. Put
//     in the same SELECT as a `WHERE t BETWEEN …`, it would see only the
//     zoomed rows, and the first of them would have no neighbour. So a window
//     is never inlined: it becomes a column of a subquery over the whole file
//     (windowedFromSql), and the queries that read it select FROM that
//     subquery. Only those: the subquery also stops DuckDB from pushing a time
//     filter into the scan, which on a table or Parquet file turns a zoom of
//     a few ms into a scan of the file. Measured on a 20M-row table: 17 ms
//     plain, 137 ms through the window.
//
// Values keep the invariant of src/expr/sql.js loosely: NULL reads back as NaN.
// Where a kernel distinguishes NaN from ±Infinity the expression does too.

// A double as a literal DuckDB parses back to the same double (see literal() in
// src/expr/sql.js for why a string cast and not a numeric literal).
export function doubleLiteral(value) {
    if (Number.isNaN(value)) return 'CAST(NULL AS DOUBLE)';
    if (value === Infinity) return "CAST('inf' AS DOUBLE)";
    if (value === -Infinity) return "CAST('-inf' AS DOUBLE)";
    if (Object.is(value, -0)) return "CAST('-0.0' AS DOUBLE)";
    return `CAST('${String(value)}' AS DOUBLE)`;
}

// A read of a column, or of a column cast to DOUBLE, is cheap enough to write
// twice; anything else is bound once through a one-element lambda (the same
// device src/expr/sql.js uses, ~+25 ms per 5M rows).
function isCheap(sql) {
    return /^"(?:[^"]|"")*"$/.test(sql)
        || /^try_cast\("(?:[^"]|"")*" AS DOUBLE\)$/.test(sql)
        || /^try_cast\(\("(?:[^"]|"")*"\) AS DOUBLE\)$/.test(sql)
        || /^CAST\('[^']*' AS DOUBLE\)$/.test(sql);
}

export function bindSql(sql, name, body) {
    if (isCheap(sql)) return body(sql);
    return `list_transform([${sql}], lambda ${name}: ${body(name)})[1]`;
}

// ─── Window columns ─────────────────────────────────────────────────────────

// FNV-1a over the text, two independent 32-bit lanes: a column name that is a
// function of the expression, so an edited tool gets a new column (and a new
// cache key) and two identical ones share it.
function hashText(text) {
    let a = 0x811c9dc5;
    let b = 0x01000193 ^ 0x5bd1e995;
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193) >>> 0;
        b = Math.imul(b ^ c, 0x5bd1e995) >>> 0;
    }
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

/**
 * A column a window subquery adds to the file.
 * @param {string} sql its expression, over the file's columns and over the
 *   columns of `deps`
 * @param {Array} deps window columns the expression reads
 * @returns {{ column: string, sql: string, level: number }} `level` orders the
 *   nesting: a column is computed one subquery above everything it reads.
 */
export function windowColumn(sql, deps = []) {
    const level = 1 + deps.reduce((max, dep) => Math.max(max, dep.level || 0), 0);
    return { column: `__omv_w_${hashText(`${level}:${sql}`)}`, sql, level };
}

export function quoteIdent(name) {
    return `"${String(name ?? '').replace(/"/g, '""')}"`;
}

// Every window column the variables need, once each, lowest level first.
export function collectWindows(variables) {
    const byColumn = new Map();
    for (const variable of variables || []) {
        for (const window of variable?._duckdbWindows || []) {
            if (window?.column && !byColumn.has(window.column)) byColumn.set(window.column, window);
        }
    }
    return [...byColumn.values()].sort((a, b) => a.level - b.level || (a.column < b.column ? -1 : 1));
}

// Windows a variable's SQL carries into whatever is built on it.
export function mergeWindows(...lists) {
    return collectWindows(lists.map(list => ({ _duckdbWindows: list || [] })));
}

/**
 * The FROM item that carries `windows` as columns: the file, filtered to the
 * rows every lazy query serves (`validWhere`), with one subquery per level.
 * Returns `tableName` untouched when there is nothing to add.
 */
export function windowedFromSql(tableName, validWhere, windows) {
    if (!windows?.length) return tableName;
    let from = validWhere && validWhere !== 'TRUE'
        ? `(SELECT * FROM ${tableName} WHERE ${validWhere})`
        : `(SELECT * FROM ${tableName})`;
    const levels = [...new Set(windows.map(w => w.level))].sort((a, b) => a - b);
    for (const level of levels) {
        const columns = windows
            .filter(w => w.level === level)
            .map(w => `${w.sql} AS ${quoteIdent(w.column)}`)
            .join(', ');
        from = `(SELECT *, ${columns} FROM ${from})`;
    }
    return from;
}

// ─── Derivative ─────────────────────────────────────────────────────────────

const finiteOrNull = (sql) => `CASE WHEN isfinite(${sql}) THEN ${sql} END`;

/**
 * computeDerivative (src/compute/kernels/derivative.js) as window columns.
 *
 * @param {string} valueSql the source's values (DOUBLE or NULL)
 * @param {string|null} timeSql the time axis the kernel would read, or null
 *   when it counts samples (an 'index' axis, a generated one)
 * @param {{ kind: string, method: string, deps?: Array }} options
 * @returns {{ column: object, windows: Array }} the derivative's own column and
 *   every window column it needs, itself included
 *
 * The kernel, per sample: diff(a, b) = (y[b] − y[a]) / Δt, NaN unless both
 * values and Δt are finite and Δt ≠ 0; Δt is in seconds on a calendar axis and
 * b − a on an index one. The first and last samples take the one-sided
 * difference. 'difference' divides by nothing, so a repeated timestamp does
 * not blow it up. Here NULL plays NaN: the operands are made finite-or-NULL
 * one level below, and NULL propagates through the arithmetic.
 */
export function derivativeWindows(valueSql, timeSql, { kind = 'numeric', method = 'centered', deps = [] } = {}) {
    const operand = windowColumn(finiteOrNull(valueSql), deps);
    const columns = [operand];
    const y = quoteIdent(operand.column);
    let t = null;
    if (timeSql && kind !== 'index') {
        const time = windowColumn(finiteOrNull(timeSql), deps);
        columns.push(time);
        t = quoteIdent(time.column);
    }
    const at = (sql, offset) => offset < 0
        ? `LAG(${sql}) OVER ()`
        : (offset > 0 ? `LEAD(${sql}) OVER ()` : sql);
    const diff = (a, b) => {
        const dy = `(${at(y, b)} - ${at(y, a)})`;
        if (method === 'difference') return dy;
        let dt;
        if (!t) {
            dt = doubleLiteral(b - a);
            return `(${dy} / ${dt})`;
        }
        dt = `(${at(t, b)} - ${at(t, a)})`;
        if (kind === 'datetime') dt = `(${dt} / ${doubleLiteral(1000)})`;
        return `(${dy} / (CASE WHEN isfinite(${dt}) AND ${dt} <> 0 THEN ${dt} END))`;
    };
    const hasPrev = 'LAG(TRUE, 1, FALSE) OVER ()';
    const hasNext = 'LEAD(TRUE, 1, FALSE) OVER ()';
    let sql;
    if (method === 'difference' || method === 'backward') {
        sql = `CASE WHEN ${hasPrev} THEN ${diff(-1, 0)} ELSE ${diff(0, 1)} END`;
    } else if (method === 'forward') {
        sql = `CASE WHEN ${hasNext} THEN ${diff(0, 1)} ELSE ${diff(-1, 0)} END`;
    } else {
        sql = `CASE WHEN NOT ${hasPrev} THEN ${diff(0, 1)} WHEN NOT ${hasNext} THEN ${diff(-1, 0)} ELSE ${diff(-1, 1)} END`;
    }
    const own = windowColumn(sql, [...deps, ...columns]);
    return { column: own, windows: mergeWindows(deps, columns, [own]) };
}

// The sample number the kernels use when the axis is an index: 0, 1, 2… over
// the rows of the file, in order.
export function rowIndexWindow() {
    return windowColumn('(ROW_NUMBER() OVER () - 1)::DOUBLE');
}

// ─── Outliers (IQR) ─────────────────────────────────────────────────────────

/**
 * detectIqrOutliers + replacement by NaN, once the fences are known: a finite
 * sample outside [low, high] becomes NULL; everything else — NaN and ±∞
 * included, which the kernel never flags — passes through.
 */
export function iqrOutlierSql(valueSql, low, high) {
    return bindSql(valueSql, 'omv_iqr', v =>
        `CASE WHEN isfinite(${v}) AND (${v} < ${doubleLiteral(low)} OR ${v} > ${doubleLiteral(high)}) THEN NULL ELSE ${v} END`);
}

// ─── Detrend ────────────────────────────────────────────────────────────────

/**
 * computeDetrend's subtraction for the polynomial methods, once the fit is
 * known. Operation for operation the kernel's loop, so that with the same
 * coefficients the result is the same double:
 *
 *   u = (x − mid) / half;  trend = 0; power = 1
 *   for p: trend += c[p] · power; power *= u
 *   out = y − trend      (NaN unless y and x are finite)
 */
export function detrendPolynomialSql(valueSql, xSql, { mid, half, coefficients }) {
    const zero = doubleLiteral(0);
    const one = doubleLiteral(1);
    const trend = (u) => {
        let sum = zero;
        let power = one;
        coefficients.forEach((c, p) => {
            sum = `(${sum} + ${doubleLiteral(c)} * ${power})`;
            if (p < coefficients.length - 1) power = `(${power} * ${u})`;
        });
        return sum;
    };
    return bindSql(valueSql, 'omv_dty', y => bindSql(xSql, 'omv_dtx', x =>
        `CASE WHEN isfinite(${y}) AND isfinite(${x}) THEN ${y} - list_transform([(${x} - ${doubleLiteral(mid)}) / ${doubleLiteral(half)}], lambda omv_dtu: ${trend('omv_dtu')})[1] END`));
}

// First-sample detrend: every sample minus the first finite one.
export function detrendAnchorSql(valueSql, anchor) {
    if (!Number.isFinite(anchor)) return 'CAST(NULL AS DOUBLE)';
    return `(${valueSql} - ${doubleLiteral(anchor)})`;
}
