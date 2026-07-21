import assert from 'node:assert/strict';
import {
    linearFit,
    quadraticFitCentered,
    linearFromMoments,
    quadraticFromMoments,
} from '../src/utils/regression.js';
import {
    buildRegressionPass1Sql,
    parseRegressionPass1,
    buildRegressionPass2Sql,
    parseRegressionPass2,
} from '../src/data/pair-regression-sql.js';

const close = (a, b, tol, label) => assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b}`);

// Compute the exact aggregates DuckDB's regr_*/sum would return for a dataset,
// so we can drive the lazy parse path and prove it matches the eager kernel.
function duckdbPass1(x, y) {
    let n = 0, sx = 0, sy = 0, minx = Infinity, maxx = -Infinity;
    const xs = [], ys = [];
    for (let i = 0; i < x.length; i++) {
        const xi = x[i], yi = y[i];
        if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
        n++; sx += xi; sy += yi; xs.push(xi); ys.push(yi);
        if (xi < minx) minx = xi; if (xi > maxx) maxx = xi;
    }
    const ax = sx / n, ay = sy / n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < xs.length; i++) { sxx += (xs[i]-ax)**2; syy += (ys[i]-ay)**2; sxy += (xs[i]-ax)*(ys[i]-ay); }
    return { n, ax, ay, sxx, syy, sxy, minx, maxx, xs, ys };
}
function duckdbPass2(xs, ys, centerX, scaleX) {
    let S0=0,S1=0,S2=0,S3=0,S4=0,T0=0,T1=0,T2=0,YY=0;
    for (let i = 0; i < xs.length; i++) {
        const u = (xs[i]-centerX)/scaleX, u2=u*u;
        S0++; S1+=u; S2+=u2; S3+=u2*u; S4+=u2*u2;
        T0+=ys[i]; T1+=u*ys[i]; T2+=u2*ys[i]; YY+=ys[i]*ys[i];
    }
    return { S0,S1,S2,S3,S4,T0,T1,T2,YY };
}

// Mock getScalar backed by a flat {name: value} map (pair index 0).
const scalarFrom = (map) => (name) => (name in map ? map[name] : null);

// ── Linear parity: eager linearFit === lazy linearFromMoments(regr aggregates) ──
for (const [x, y] of [
    [[0,1,2,3,4,5], [2,5,8,11,14,17]],           // y = 3x + 2
    [[1,2,3,4,5], [10,8,6,4,2]],                  // y = -2x + 12
    [[1e12,1e12+1,1e12+2,1e12+3,1e12+4], [5,10,15,20,25]],
    [[1,2,3,4,5], [2,1,4,3,6]],                   // noisy
]) {
    const eager = linearFit(x, y);
    const p = duckdbPass1(x, y);
    const map = { n_scope: x.length, n0: p.n, ax0: p.ax, ay0: p.ay, sxx0: p.sxx, syy0: p.syy, sxy0: p.sxy, mnx0: p.minx, mxx0: p.maxx };
    const [{ moments }] = parseRegressionPass1(scalarFrom(map), 1);
    const lazy = linearFromMoments(moments);
    close(lazy.b1, eager.b1, Math.abs(eager.b1)*1e-9 + 1e-9, 'linear slope parity');
    close(lazy.b0, eager.b0, Math.abs(eager.b0)*1e-9 + 1e-9, 'linear intercept parity');
    if (Number.isFinite(eager.r2)) close(lazy.r2, eager.r2, 1e-9, 'linear R2 parity');
    if (Number.isFinite(eager.rmse)) close(lazy.rmse, eager.rmse, Math.abs(eager.rmse)*1e-9 + 1e-9, 'linear RMSE parity');
    assert.equal(lazy.n, eager.n, 'linear n parity');
}

// ── Quadratic parity: eager === lazy quadraticFromMoments(pass1+pass2) ──
for (const [x, y] of [
    [[-3,-2,-1,0,1,2,3], [-3,-2,-1,0,1,2,3].map(v=>2*v*v-3*v+1)],   // exact
    (() => { const x=[],y=[]; for (let k=0;k<40;k++){ x.push(k); y.push(0.2*k*k-1.5*k+3 + ((k*37)%11-5)); } return [x,y]; })(), // noisy
    (() => { const b=1e9,x=[],y=[]; for (let k=0;k<=20;k++){ const xv=b+k*0.1,l=xv-b; x.push(xv); y.push(3*l*l-2*l+5);} return [x,y]; })(), // huge X
]) {
    const eager = quadraticFitCentered(x, y);
    const p = duckdbPass1(x, y);
    const map1 = { n_scope: x.length, n0: p.n, ax0: p.ax, ay0: p.ay, sxx0: p.sxx, syy0: p.syy, sxy0: p.sxy, mnx0: p.minx, mxx0: p.maxx };
    const [{ moments, centerX, scaleX }] = parseRegressionPass1(scalarFrom(map1), 1);
    const s = duckdbPass2(p.xs, p.ys, centerX, scaleX);
    const map2 = { s0_0: s.S0, s1_0: s.S1, s2_0: s.S2, s3_0: s.S3, s4_0: s.S4, t0_0: s.T0, t1_0: s.T1, t2_0: s.T2, yy_0: s.YY };
    const statsMap = parseRegressionPass2(scalarFrom(map2), [{ i: 0 }]);
    const lazy = quadraticFromMoments({ n: moments.n, nExcluded: moments.nExcluded, centerX, scaleX, ...statsMap.get(0), minX: moments.minX, maxX: moments.maxX });
    close(lazy.a, eager.a, Math.abs(eager.a)*1e-6 + 1e-7, 'quad a parity');
    close(lazy.b, eager.b, Math.abs(eager.b)*1e-6 + 1e-6, 'quad b parity');
    close(lazy.c, eager.c, Math.abs(eager.c)*1e-6 + 1e-6, 'quad c parity');
    if (Number.isFinite(eager.r2)) close(lazy.r2, eager.r2, 1e-6, 'quad R2 parity');
}

// ── SQL builders produce the expected shape ──
{
    const pairExprs = [{ i: 0, vx: 'a', vy: 'b' }, { i: 1, vx: 'c', vy: 'd' }];
    const sql1 = buildRegressionPass1Sql('tbl', 'TRUE', pairExprs);
    assert.ok(/regr_sxx\(py0, px0\)/.test(sql1), 'pass1 has regr_sxx for pair 0');
    assert.ok(/regr_sxy\(py1, px1\)/.test(sql1), 'pass1 has regr_sxy for pair 1');
    assert.ok(/COUNT\(\*\)::BIGINT AS n_scope/.test(sql1), 'pass1 has n_scope');
    const sql2 = buildRegressionPass2Sql('tbl', 'TRUE', [{ i: 0, vx: 'a', vy: 'b', centerX: 5, scaleX: 2 }], (v) => String(v));
    assert.ok(/s4_0/.test(sql2) && /yy_0/.test(sql2), 'pass2 has S4 and YY');
    assert.ok(/px0 - 5\) \/ 2/.test(sql2), 'pass2 inlines centre/scale');
}

// ── Degenerate: X constant → quadratic undefined via moments path ──
{
    const p = duckdbPass1([5,5,5,5], [1,2,3,4]);
    const map1 = { n_scope: 4, n0: p.n, ax0: p.ax, ay0: p.ay, sxx0: p.sxx, syy0: p.syy, sxy0: p.sxy, mnx0: p.minx, mxx0: p.maxx };
    const [{ moments, centerX, scaleX }] = parseRegressionPass1(scalarFrom(map1), 1);
    const lin = linearFromMoments(moments);
    assert.equal(lin.status, 'undefined', 'X constant → linear undefined');
    assert.ok(!(scaleX > 0), 'X constant → scaleX not positive');
}

console.log('test-regression-lazy: all assertions passed');
