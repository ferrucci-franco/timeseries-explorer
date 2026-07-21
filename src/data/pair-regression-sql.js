// Pure, dependency-free SQL builders + result parsers for lazy (DuckDB) OLS
// fitting of variable pairs (TODO 10 phase 3). Kept out of DuckDbSource (which
// imports the Vite-only WASM engine) so it is unit-testable in Node.
//
// Two passes, mirroring src/utils/regression.js so eager and lazy agree exactly:
//  • Pass 1 — one aggregate row per pair with the pairwise-finite count, means,
//    the central second moments (regr_sxx/syy/sxy), and min/max X. These feed
//    the linear fit directly (via linearFromMoments) and give the centre/scale
//    for the quadratic pass.
//  • Pass 2 — for quadratic pairs only, the sufficient statistics S0..S4,
//    T0..T2, YY in the centred/scaled coordinate u = (x−centerX)/scaleX, so the
//    normal equations stay well conditioned even for huge X (no raw Σx⁴).
//
// pairExprs entries are { i, vx, vy } where vx/vy are DOUBLE SQL value
// expressions with gain/sign/offset already applied by the caller.

const isFin = (e) => `(${e} IS NOT NULL AND NOT isnan(${e}) AND NOT isinf(${e}))`;

// Build the paired-finite CTE columns shared by both passes: px_i / py_i are the
// value or NULL when either side of the row is non-finite (pairwise deletion).
function pairedCteSql(tableName, where, pairExprs) {
    const valsCols = pairExprs
        .map(p => `${p.vx} AS vx${p.i}, ${p.vy} AS vy${p.i}`)
        .join(',\n                           ');
    const pairedCols = pairExprs.map(p => {
        const both = `${isFin(`vx${p.i}`)} AND ${isFin(`vy${p.i}`)}`;
        return `CASE WHEN ${both} THEN vx${p.i} END AS px${p.i}, `
            + `CASE WHEN ${both} THEN vy${p.i} END AS py${p.i}`;
    }).join(',\n                           ');
    return `
                WITH vals AS (
                    SELECT ${valsCols}
                    FROM ${tableName}
                    WHERE ${where}
                ),
                paired AS (
                    SELECT ${pairedCols}
                    FROM vals
                )`;
}

// Pass 1: means, central second moments, count and X span per pair.
export function buildRegressionPass1Sql(tableName, where, pairExprs) {
    const aggCols = pairExprs.map(p => (
        `regr_count(py${p.i}, px${p.i})::BIGINT AS n${p.i}, `
        + `regr_avgx(py${p.i}, px${p.i}) AS ax${p.i}, regr_avgy(py${p.i}, px${p.i}) AS ay${p.i}, `
        + `regr_sxx(py${p.i}, px${p.i}) AS sxx${p.i}, regr_syy(py${p.i}, px${p.i}) AS syy${p.i}, `
        + `regr_sxy(py${p.i}, px${p.i}) AS sxy${p.i}, `
        + `min(px${p.i}) AS mnx${p.i}, max(px${p.i}) AS mxx${p.i}`
    )).join(',\n                       ');
    return `${pairedCteSql(tableName, where, pairExprs)}
                SELECT COUNT(*)::BIGINT AS n_scope,
                       ${aggCols}
                FROM paired;
            `;
}

// Parse pass 1 → per-pair moments { n, nExcluded, meanX, meanY, m2x, m2y,
// cMoment, minX, maxX } plus centerX/scaleX for the quadratic pass.
export function parseRegressionPass1(getScalar, count) {
    const num = (name) => { const v = getScalar(name); return v == null ? NaN : Number(v); };
    const rawScope = num('n_scope');
    const nScope = Number.isFinite(rawScope) ? rawScope : 0;
    const out = [];
    for (let i = 0; i < count; i++) {
        const rawN = num(`n${i}`);
        const n = Number.isFinite(rawN) ? rawN : 0;
        const m2x = num(`sxx${i}`);
        const centerX = num(`ax${i}`);
        // Sample stddev from the central second moment (matches the eager scale).
        const scaleX = n >= 2 && m2x > 0 ? Math.sqrt(m2x / (n - 1)) : NaN;
        out.push({
            nScope,
            moments: {
                n,
                nExcluded: Math.max(0, nScope - n),
                meanX: centerX,
                meanY: num(`ay${i}`),
                m2x,
                m2y: num(`syy${i}`),
                cMoment: num(`sxy${i}`),
                minX: num(`mnx${i}`),
                maxX: num(`mxx${i}`),
            },
            centerX,
            scaleX,
        });
    }
    return out;
}

// Pass 2: centred/scaled sufficient statistics for quadratic pairs.
// quadExprs entries are { i, vx, vy, centerX, scaleX, lit } where lit(n) formats
// a numeric literal (so centre/scale are inlined as constants → u is O(1)).
export function buildRegressionPass2Sql(tableName, where, quadExprs, lit) {
    const uOf = (p) => `((px${p.i} - ${lit(p.centerX)}) / ${lit(p.scaleX)})`;
    const aggCols = quadExprs.map(p => {
        const u = uOf(p);
        return `sum(${u}) AS s1_${p.i}, sum(${u}*${u}) AS s2_${p.i}, `
            + `sum(${u}*${u}*${u}) AS s3_${p.i}, sum(${u}*${u}*${u}*${u}) AS s4_${p.i}, `
            + `count(px${p.i})::BIGINT AS s0_${p.i}, `
            + `sum(py${p.i}) AS t0_${p.i}, sum(${u}*py${p.i}) AS t1_${p.i}, `
            + `sum(${u}*${u}*py${p.i}) AS t2_${p.i}, sum(py${p.i}*py${p.i}) AS yy_${p.i}`;
    }).join(',\n                       ');
    return `${pairedCteSql(tableName, where, quadExprs)}
                SELECT ${aggCols}
                FROM paired;
            `;
}

// Parse pass 2 → { S0..S4, T0..T2, YY } per quadratic pair (keyed by its i).
export function parseRegressionPass2(getScalar, quadExprs) {
    const num = (name) => { const v = getScalar(name); return v == null ? NaN : Number(v); };
    const map = new Map();
    for (const p of quadExprs) {
        map.set(p.i, {
            S0: num(`s0_${p.i}`), S1: num(`s1_${p.i}`), S2: num(`s2_${p.i}`),
            S3: num(`s3_${p.i}`), S4: num(`s4_${p.i}`),
            T0: num(`t0_${p.i}`), T1: num(`t1_${p.i}`), T2: num(`t2_${p.i}`),
            YY: num(`yy_${p.i}`),
        });
    }
    return map;
}
