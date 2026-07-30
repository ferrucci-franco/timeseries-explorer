// Pure, dependency-free SQL builder + result parser for lazy (DuckDB) Pearson
// correlation of variable pairs (TODO 9 phase 3). Kept separate from
// DuckDbSource (which imports the Vite-only WASM engine) so it is unit-testable
// in Node. The semantics mirror the eager kernel in src/utils/correlation.js:
// non-finite values become NULL, pairwise deletion, undefined for n<2 or zero
// variance.

import { pairedCteSql } from './pair-regression-sql.js';

// One aggregate query for every pair. `pairExprs` is [{ i, vx, vy }] where vx/vy
// are DOUBLE SQL value expressions (transforms already applied).
//
// The paired-finite CTE comes from pair-regression-sql.js rather than being
// spelt out again here: pairwise deletion is one rule, and lazy correlation and
// lazy regression must never drift into two versions of it.
export function buildPairCorrelationSql(tExpr, tableName, where, pairExprs) {
    const aggCols = pairExprs.map(p => (
        `COUNT(px${p.i})::BIGINT AS n${p.i}, corr(py${p.i}, px${p.i}) AS r${p.i}, `
        + `avg(px${p.i}) AS mx${p.i}, stddev_samp(px${p.i}) AS sx${p.i}, `
        + `avg(py${p.i}) AS my${p.i}, stddev_samp(py${p.i}) AS sy${p.i}`
    )).join(',\n                       ');
    return `${pairedCteSql(tableName, where, pairExprs)}
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
