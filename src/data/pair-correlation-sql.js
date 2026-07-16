// Pure, dependency-free SQL builder + result parser for lazy (DuckDB) Pearson
// correlation of variable pairs (TODO 9 phase 3). Kept separate from
// DuckDbSource (which imports the Vite-only WASM engine) so it is unit-testable
// in Node. The semantics mirror the eager kernel in src/utils/correlation.js:
// non-finite values become NULL, pairwise deletion, undefined for n<2 or zero
// variance.

// One aggregate query for every pair. `pairExprs` is [{ i, vx, vy }] where vx/vy
// are DOUBLE SQL value expressions (transforms already applied).
export function buildPairCorrelationSql(tExpr, tableName, where, pairExprs) {
    const isFin = (e) => `(${e} IS NOT NULL AND NOT isnan(${e}) AND NOT isinf(${e}))`;
    const valsCols = pairExprs
        .map(p => `${p.vx} AS vx${p.i}, ${p.vy} AS vy${p.i}`)
        .join(',\n                           ');
    const pairedCols = pairExprs.map(p => {
        const both = `${isFin(`vx${p.i}`)} AND ${isFin(`vy${p.i}`)}`;
        return `CASE WHEN ${both} THEN vx${p.i} END AS px${p.i}, `
            + `CASE WHEN ${both} THEN vy${p.i} END AS py${p.i}`;
    }).join(',\n                           ');
    const aggCols = pairExprs.map(p => (
        `COUNT(px${p.i})::BIGINT AS n${p.i}, corr(py${p.i}, px${p.i}) AS r${p.i}, `
        + `avg(px${p.i}) AS mx${p.i}, stddev_samp(px${p.i}) AS sx${p.i}, `
        + `avg(py${p.i}) AS my${p.i}, stddev_samp(py${p.i}) AS sy${p.i}`
    )).join(',\n                       ');
    return `
                WITH vals AS (
                    SELECT ${valsCols}
                    FROM ${tableName}
                    WHERE ${where}
                ),
                paired AS (
                    SELECT ${pairedCols}
                    FROM vals
                )
                SELECT COUNT(*)::BIGINT AS n_scope,
                       ${aggCols}
                FROM paired;
            `;
}

// `getScalar(name)` returns the query's scalar column as a number (or NaN).
// Returns one result object per pair, with the same shape/rules as the eager
// kernel (status 'ok' | 'undefined').
export function parsePairCorrelations(getScalar, count) {
    const num = (name) => {
        const v = getScalar(name);
        return v == null ? NaN : Number(v);
    };
    const rawScope = num('n_scope');
    const nScope = Number.isFinite(rawScope) ? rawScope : 0;
    const out = [];
    for (let i = 0; i < count; i++) {
        const rawN = num(`n${i}`);
        const nPair = Number.isFinite(rawN) ? rawN : 0;
        const stdX = num(`sx${i}`);
        const stdY = num(`sy${i}`);
        let r = num(`r${i}`);
        const base = { nScope, nPair, nExcluded: Math.max(0, nScope - nPair) };
        if (!(nPair >= 2) || !Number.isFinite(r) || !(stdX > 0) || !(stdY > 0)) {
            out.push({ ...base, r: NaN, r2: NaN, meanX: NaN, stdX: NaN, meanY: NaN, stdY: NaN, status: 'undefined' });
        } else {
            r = Math.max(-1, Math.min(1, r));
            out.push({ ...base, r, r2: r * r, meanX: num(`mx${i}`), stdX, meanY: num(`my${i}`), stdY, status: 'ok' });
        }
    }
    return out;
}
