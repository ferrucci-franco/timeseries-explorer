// Dispatch for the Data Tools kernels.
//
// Both callers go through here: data-tools-methods.js on the main thread (the
// fallback path, and the path the existing synchronous tests exercise) and
// compute-worker.js off it. Keeping one dispatch means the worker cannot drift
// from the fallback.

import { computeDerivative } from './derivative.js';
import { computeIntegral } from './integral.js';
import { computeMovingAverage } from './moving-average.js';
import { fillMissingValues } from './interpolate.js';
import { computeDetrend } from './detrend.js';
import { applyFilter, inspectFilter } from './iir.js';
import { detectOutlierIndexes, interpolateOutliers, replaceOutliersWithNaN } from './outliers.js';
import { buildResampleGrid, resampleSourceAxis, resampleValues, medianStep } from './regrid.js';

export { computeDerivative, computeIntegral, computeMovingAverage, fillMissingValues };
export { computeDetrend, applyFilter, inspectFilter };
export { detectOutlierIndexes, interpolateOutliers, replaceOutliersWithNaN };
export { buildResampleGrid, resampleSourceAxis, resampleValues, medianStep };

/**
 * Resample a whole set of columns onto one grid. Batched rather than called
 * per column because the grid and the source-axis validation are shared, and
 * because off the main thread this is what turns a 20-variable file into one
 * round-trip instead of twenty.
 */
export function runResample({ columns, time, params }) {
    const length = columns?.[0]?.length || 0;
    const { x } = resampleSourceAxis(time, length);
    const { grid, step, sourceStep } = buildResampleGrid(x, params);
    const outputs = [];
    const emptyCounts = [];
    for (const column of columns || []) {
        const { values, emptyCount } = resampleValues(column, x, grid, params);
        outputs.push(values);
        emptyCounts.push(emptyCount);
    }
    return { grid, step, sourceStep, columns: outputs, emptyCounts };
}

/**
 * Run one Data Tools step.
 * @returns {{ values: Float64Array, meta: object }} `meta` carries only the
 *   tool-specific extras the UI stores on variable.dataTool.
 */
export function runDataToolStep(values, time, step) {
    const params = step.params || {};
    switch (step.tool) {
        case 'derivative': {
            const { values: out } = computeDerivative(values, time, params);
            return { values: out, meta: { method: params.method } };
        }
        case 'integrate': {
            const { values: out, negativeDtCount, gapCount, nanSegmentCount, uncoveredTime, hasNominalStep, timeKind }
                = computeIntegral(values, time, params);
            return {
                values: out,
                meta: {
                    method: params.method,
                    gapPolicy: params.gapPolicy,
                    negativeDtCount,
                    gapCount,
                    nanSegmentCount,
                    uncoveredTime,
                    hasNominalStep,
                    timeKind,
                },
            };
        }
        case 'movingAverage': {
            const out = computeMovingAverage(values, params);
            return { values: out, meta: { window: params.window } };
        }
        case 'detrend': {
            const { values: out, ...trend } = computeDetrend(values, time, params);
            return {
                values: out,
                meta: {
                    method: params.method,
                    order: trend.order,
                    window: params.window,
                    coefficients: trend.coefficients,
                    slope: trend.slope,
                    fitPoints: trend.fitPoints,
                    usedTimeAxis: trend.usedTimeAxis,
                },
            };
        }
        case 'filter': {
            const { values: out, segments, filteredCount, skippedCount } = applyFilter(values, params);
            return {
                values: out,
                meta: {
                    mode: params.mode,
                    b: params.b,
                    a: params.a,
                    segments,
                    filteredCount,
                    skippedCount,
                },
            };
        }
        case 'interpolate': {
            const { values: out, ...counts } = fillMissingValues(values, time, params);
            return {
                values: out,
                meta: {
                    method: params.method,
                    maxGap: params.maxGap,
                    edges: params.edges,
                    window: params.window,
                    ...counts,
                },
            };
        }
        case 'removeOutliers':
        default: {
            const outlierIndexes = detectOutlierIndexes(values, step.method, params);
            const out = step.replacement === 'interpolate'
                ? interpolateOutliers(values, outlierIndexes)
                : replaceOutliersWithNaN(values, outlierIndexes);
            return {
                values: out,
                meta: {
                    method: step.method,
                    replacement: step.replacement,
                    outlierCount: outlierIndexes.length,
                    outlierIndexes,
                },
            };
        }
    }
}

/**
 * Run a whole pipeline in one go. Threading the steps here rather than in the
 * UI layer is what turns an N-step pipeline into a single worker round-trip
 * instead of N.
 *
 * Per-step values are returned, not just the final ones: the UI assembles a
 * variable object per step (each inheriting from the previous), so handing back
 * only the last array would force that assembly to be duplicated for the worker
 * path. Pipelines are 1-3 steps, so the extra transfers are cheap.
 *
 * @returns {{ values: Float64Array, stepValues: Float64Array[], stepMeta: object[] }}
 */
export function runDataToolPipeline(values, time, steps) {
    let current = values;
    const stepValues = [];
    const stepMeta = [];
    for (const step of steps) {
        const result = runDataToolStep(current, time, step);
        current = result.values;
        stepValues.push(result.values);
        stepMeta.push({ tool: step.tool, ...result.meta });
    }
    return { values: current, stepValues, stepMeta };
}
