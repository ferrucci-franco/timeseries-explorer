// The state band of a memory-saving (DuckDB) file (docs/state-band-design.md).
//
// The range queries of a lazy file read every value as a DOUBLE, which turns
// text into NULL, and the overview the file opens with is a stride sample that
// loses short runs. So a band asks DuckDB for exactly what it draws: the rows
// where the value changes inside the view, plus the row holding at its left
// edge. When the view holds more changes than a band draws one bar each, it
// asks instead for one value per screen column (the one most rows hold) and
// how many changes happen in it.
//
// Values are trimmed and an empty cell is NULL, as the in-memory parser reads
// them: '' and NULL are both an absent value.
//
// Pure builders and reducers: the source runs the SQL; the tests run it on
// real DuckDB.

/** The text of a column as the band compares it. */
export function stateValueSql(columnExpr) {
    return `NULLIF(trim(CAST((${columnExpr}) AS VARCHAR)), '')`;
}

// Rows of the file as (t, value), the time the axis plots.
function baseCte(timeExpr, valueExpr, from) {
    return `base AS (
        SELECT * FROM (
            SELECT (${timeExpr})::DOUBLE AS t, ${stateValueSql(valueExpr)} AS value
            FROM ${from}
        ) WHERE t IS NOT NULL
    )`;
}

/**
 * Changes of value in [lo, hi], with the row holding at `lo` first. At most
 * `limit` rows come back; one more than the caller can draw tells it to ask
 * for columns instead.
 */
export function buildStateChangesSql(timeExpr, valueExpr, from, lit, lo, hi, limit) {
    return `
        WITH ${baseCte(timeExpr, valueExpr, from)},
        edge AS (SELECT COALESCE(MAX(t), ${lit(lo)}) AS t0 FROM base WHERE t <= ${lit(lo)}),
        r AS (SELECT t, value FROM base WHERE t >= (SELECT t0 FROM edge) AND t <= ${lit(hi)}),
        c AS (
            SELECT t, value,
                   LAG(value) OVER (ORDER BY t) AS prev,
                   ROW_NUMBER() OVER (ORDER BY t) AS rn
            FROM r
        )
        SELECT t, value FROM c
        WHERE rn = 1 OR prev IS DISTINCT FROM value
        ORDER BY t
        LIMIT ${Math.max(1, Math.floor(limit))};
    `;
}

/**
 * One row per screen column of [lo, hi] that holds rows: the value most of
 * its rows hold ('' when most are empty) and the changes inside it.
 */
export function buildStateColumnsSql(timeExpr, valueExpr, from, lit, lo, hi, columns) {
    const n = Math.max(1, Math.floor(columns));
    const span = Math.max(Number(hi) - Number(lo), Number.MIN_VALUE);
    return `
        WITH ${baseCte(timeExpr, valueExpr, from)},
        r AS (SELECT t, value FROM base WHERE t >= ${lit(lo)} AND t <= ${lit(hi)}),
        c AS (SELECT t, value, LAG(value) OVER (ORDER BY t) AS prev,
                     ROW_NUMBER() OVER (ORDER BY t) AS rn FROM r),
        b AS (
            SELECT LEAST(FLOOR((t - ${lit(lo)}) * ${n} / ${lit(span)}), ${n - 1})::INTEGER AS b,
                   COALESCE(value, '') AS value,
                   CASE WHEN rn > 1 AND prev IS DISTINCT FROM value THEN 1 ELSE 0 END AS changed
            FROM c
        )
        SELECT b, mode(value) AS value, SUM(changed)::DOUBLE AS changes
        FROM b GROUP BY b ORDER BY b;
    `;
}

/** Distinct values of the whole column, in order of first appearance. */
export function buildStateValuesSql(timeExpr, valueExpr, from, limit) {
    return `
        WITH ${baseCte(timeExpr, valueExpr, from)}
        SELECT value, MIN(t) AS first_t FROM base
        WHERE value IS NOT NULL
        GROUP BY value ORDER BY first_t, value
        LIMIT ${Math.max(1, Math.floor(limit))};
    `;
}

/**
 * Columns from buildStateColumnsSql as band segments `{ t0, t1, value,
 * changes }` (times in the units of lo/hi). A column with no rows keeps the
 * value of the one before (a state holds until it changes); neighbours of the
 * same value merge; an empty value is left blank.
 */
export function stateSegmentsFromColumns(rows, lo, hi, columns) {
    const n = Math.max(1, Math.floor(columns));
    const width = (Number(hi) - Number(lo)) / n;
    const byColumn = new Map(rows.map(row => [Number(row.b), row]));
    const segments = [];
    let held = null;
    for (let b = 0; b < n; b++) {
        const row = byColumn.get(b);
        const value = row ? String(row.value ?? '') : held;
        const changes = row ? Number(row.changes) || 0 : 0;
        if (row) held = value;
        if (value === null || value === '') continue;
        const t0 = lo + b * width;
        const t1 = b === n - 1 ? hi : lo + (b + 1) * width;
        const prev = segments[segments.length - 1];
        if (prev && prev.value === value && prev.t1 === t0) {
            prev.t1 = t1;
            prev.changes += changes;
        } else {
            segments.push({ t0, t1, value, changes });
        }
    }
    return segments;
}
