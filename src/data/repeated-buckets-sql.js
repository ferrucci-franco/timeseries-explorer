// Pure, dependency-free SQL builder for the Repeated marks of a lazy (DuckDB)
// file (docs/repeated-timestamps-indicator-design.md, "Lazy files"). Kept apart
// from DuckDbSource (which imports the Vite-only WASM engine) so it is
// unit-testable in Node, as missing-buckets-sql.js is.
//
// In memory the marks come from the runs of the time column: consecutive rows
// at one instant (src/utils/repeated-timestamps.js), grouped by screen column
// (src/utils/repeated-marks.js). A lazy file has no time column in memory, so
// DuckDB finds the runs and groups them, and answers with one row per screen
// column that holds any — the same thing the in-memory kernel reduces its runs
// to, whatever the file holds.
//
// Runs, as the kernel defines them: consecutive rows (file order) whose time is
// finite and equal. Found with window functions over the whole file that DuckDB
// evaluates as a stream — no sort, no hash of the rows:
//   · a row starts a run when the row before it has another time;
//   · the row number of the last start so far (a running MAX) is the run's
//     first row, so `rn - start_rn + 1` is how many rows the run has up to here;
//   · a row ends a run when the row after it has another time: that row carries
//     the run's whole length.
// A run is counted at its last row; every row of a run has the same time, so
// its instant is that row's.
//
// The column of an instant is computed with the kernel's own arithmetic,
// `floor((t - lo) / span * columns)`, clamped to the last column. Runs outside
// [lo, hi] are grouped under column -1: the scan reads the whole file either
// way, and their count says whether the file repeats an instant anywhere.
//
// `tExpr` is the file's time expression (DOUBLE, in the units the rest of the
// app uses); `lo`/`hi` are in those units. Rows with no time are not rows of
// the series (the in-memory loader drops them), so they are left out before
// the runs are found.
export function buildRepeatedColumnsSql(tExpr, tableName, lit, lo, hi, columns, minRun = 2) {
    const n = Math.max(1, Math.floor(columns));
    const shortest = Math.max(2, Math.floor(Number(minRun) || 2));
    const span = Number(hi) - Number(lo);
    const column = span > 0
        ? `LEAST(${n - 1}, CAST(FLOOR((t - ${lit(lo)}) / ${lit(span)} * ${n}) AS BIGINT))`
        : '0';
    return `
        WITH base AS (
            SELECT ${tExpr} AS t FROM ${tableName}
        ),
        present AS (
            SELECT t FROM base WHERE t IS NOT NULL
        ),
        neighbours AS (
            SELECT t,
                   ROW_NUMBER() OVER () AS rn,
                   LAG(t) OVER () AS before,
                   LEAD(t) OVER () AS after
            FROM present
        ),
        marked AS (
            SELECT t, rn,
                   (after IS NULL OR after <> t) AS ends,
                   MAX(CASE WHEN before IS NULL OR before <> t THEN rn END)
                       OVER (ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS start_rn
            FROM neighbours
        ),
        runs AS (
            SELECT t, start_rn, rn - start_rn + 1 AS len
            FROM marked
            WHERE ends AND isfinite(t) AND rn - start_rn + 1 >= ${shortest}
        )
        SELECT CASE WHEN t >= ${lit(lo)} AND t <= ${lit(hi)} THEN ${column} ELSE -1 END AS col,
               COUNT(*)::DOUBLE AS instants,
               MAX(len)::DOUBLE AS longest,
               ARG_MAX(t, len::HUGEINT * 1000000000000 - start_rn)::DOUBLE AS t
        FROM runs
        GROUP BY col
        ORDER BY col;
    `;
}

/**
 * The query's rows as the kernel's column marks.
 * @returns {{ marks: Array<{column: number, t: number, instants: number, longest: number}>, total: number }}
 *   `marks`: one per column of the window that holds a repeated instant; `t` is
 *   the instant with the longest run there (the earliest of them on a tie, as
 *   the kernel picks). `total`: repeated instants in the whole file.
 */
export function repeatedColumnsFromRows(columns, instants, longest, times) {
    const marks = [];
    let total = 0;
    const n = Math.min(columns?.length || 0, instants?.length || 0, longest?.length || 0, times?.length || 0);
    for (let i = 0; i < n; i++) {
        total += Number(instants[i]) || 0;
        const column = Number(columns[i]);
        if (!(column >= 0)) continue;
        marks.push({ column, t: Number(times[i]), instants: Number(instants[i]), longest: Number(longest[i]) });
    }
    return { marks, total };
}
