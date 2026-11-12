// A fit as the passes it makes over its rows, so the same code fits arrays in
// memory and a lazy file of any size.
//
// Every fit kernel (src/utils/regression.js, src/utils/exp-fit.js) is written
// as a generator of passes: it yields a pass — an object with chunk(x, y) —
// and, when resumed, reads what that pass accumulated; it returns the fit. A
// pass takes the rows in order, in as many chunks as the caller likes: its
// running sums carry on from one chunk to the next, so feeding it the whole
// arrays at once or a stream of pieces gives the same numbers, bit for bit.
//
// Two drivers:
//   · runPassesOnArrays — every pass over the same in-memory arrays (eager
//     files, and lazy rows few enough to fetch in one piece);
//   · runPassesOnChunks — every pass handed to `readPass`, which streams the
//     rows into it (a lazy file: one DuckDB stream per pass).
//
// The x/y of a chunk are aligned arrays (any array-like of numbers); a pass
// skips the rows its kernel skips (non-finite x or y), so a chunk may hold
// them.

export function runPassesOnArrays(steps, x, y) {
    let step = steps.next();
    while (!step.done) {
        step.value.chunk(x, y);
        step = steps.next();
    }
    return step.value;
}

/**
 * `readPass(pass, index)` must call pass.chunk(x, y) for every row, in order,
 * and resolve when the rows are done. `index` counts the passes from 0, for a
 * progress line. Rejections (a cancelled stream) propagate.
 */
export async function runPassesOnChunks(steps, readPass) {
    let index = 0;
    let step = steps.next();
    while (!step.done) {
        await readPass(step.value, index++);
        step = steps.next();
    }
    return step.value;
}
