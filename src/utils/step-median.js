// detectSamplingGaps' nominal step, over steps that arrive a chunk at a time.
//
// The gap scan of src/utils/sampling-gaps.js takes the median of the positive
// steps of a time axis (medianInPlace → selectKth over all of them) and then
// counts the steps within 10 % of it. A file in memory-saving (lazy) mode is
// read as a stream and cannot hold all its steps, so this object computes the
// same two numbers in passes over the steps, holding a bounded amount:
//
//   · while there are no more than `collectLimit` steps, it keeps them and
//     does exactly what detectSamplingGaps does: medianInPlace over the kept
//     steps, then the agreement count over them. On an array in memory the
//     limit is Infinity, which is that code path and nothing else;
//   · past the limit it keeps a histogram instead, keyed by the top 16 bits of
//     each step's IEEE-754 pattern (positive doubles order as their bit
//     patterns do), with each bucket's count, smallest and largest step. The
//     median's order statistics are located bucket by bucket: a bucket whose
//     smallest and largest steps are equal holds the answer outright (a
//     regular axis: one pass); otherwise one more pass keeps the steps of
//     that one bucket — or, if it is still too many, histograms its next 16
//     bits, and so on. 64 bits are four levels, so at most four more passes,
//     and usually none or one;
//   · the agreement count (|d − median| ≤ 10 % of the median) is bounded from
//     the histogram: a bucket whose smallest and largest steps both agree
//     agrees whole, one whose both disagree on the same side not at all (the
//     subtraction rounds monotonically, so the steps between agree as their
//     ends do). Only when the bounds straddle the 80 % gate is one more pass
//     made, to count exactly.
//
// The median is an order statistic, so it is the same double however it was
// found: the gap verdict, the threshold and everything downstream are the
// in-memory kernel's, bit for bit.
//
// Use: add(d) every positive finite step of the axis, in any order but the
// same multiset each pass; then endPass(). While it returns true, the caller
// makes one more pass over the same steps (add(d) each again) and calls
// endPass() again. verdict() then answers.

import { GAP_STEP_MIN_AGREEMENT, GAP_STEP_MIN_SAMPLES, GAP_STEP_TOLERANCE, medianInPlace, selectKth } from './sampling-gaps.js';

/** Steps kept as they are before the histogram takes over (8 MB). */
export const STEP_COLLECT_LIMIT = 1 << 20;

const BUCKETS = 1 << 16;
const SCRATCH = new Float64Array(1);
const WORDS = new Uint32Array(SCRATCH.buffer);
// The high word of a double: index 1 on a little-endian machine.
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;
const LO = 1 - HI;

// The 16-bit digit of `d` at `level` (0: top of the high word … 3: bottom of
// the low word), and the bits above it, as a string key of the prefix.
function digit(level) {
    switch (level) {
    case 0: return WORDS[HI] >>> 16;
    case 1: return WORDS[HI] & 0xffff;
    case 2: return WORDS[LO] >>> 16;
    default: return WORDS[LO] & 0xffff;
    }
}

// Whether the bits of `d` above `level` are `prefix` (an array of digits).
function hasPrefix(prefix) {
    for (let level = 0; level < prefix.length; level++) {
        if (digit(level) !== prefix[level]) return false;
    }
    return true;
}

function denseHistogram() {
    const min = new Float64Array(BUCKETS);
    const max = new Float64Array(BUCKETS);
    min.fill(Infinity);
    max.fill(-Infinity);
    return { count: new Float64Array(BUCKETS), min, max };
}

function histogramAdd(h, key, d) {
    h.count[key]++;
    if (d < h.min[key]) h.min[key] = d;
    if (d > h.max[key]) h.max[key] = d;
}

// The non-empty buckets of a dense histogram, in key order.
function compact(h) {
    const keys = [];
    for (let key = 0; key < BUCKETS; key++) if (h.count[key] > 0) keys.push(key);
    return {
        keys: Int32Array.from(keys),
        count: Float64Array.from(keys, key => h.count[key]),
        min: Float64Array.from(keys, key => h.min[key]),
        max: Float64Array.from(keys, key => h.max[key]),
    };
}

// The bucket of a compact histogram holding the `rank`-th smallest (0-based),
// and the rank within it.
function locate(h, rank) {
    let below = 0;
    for (let b = 0; b < h.keys.length; b++) {
        if (rank < below + h.count[b]) return { bucket: b, rank: rank - below };
        below += h.count[b];
    }
    return null;
}

function growFloat64(buffer, size) {
    if (size < buffer.length) return buffer;
    const out = new Float64Array(Math.max(1024, buffer.length * 2));
    out.set(buffer);
    return out;
}

export function createStepMedian({ collectLimit = STEP_COLLECT_LIMIT, capacity = 0, stepTolerance = GAP_STEP_TOLERANCE, minStepAgreement = GAP_STEP_MIN_AGREEMENT } = {}) {
    const limit = Number(collectLimit) >= 0 ? Number(collectLimit) : STEP_COLLECT_LIMIT;
    // `capacity`: the steps expected, when known (an array in memory), so the
    // kept steps are one allocation, as in detectSamplingGaps.
    // 'collect' → 'histogram' (first pass) → 'refine' (order statistics) →
    // 'agree' (exact agreement count) → 'done'.
    let phase = 'collect';
    let count = 0;          // steps of the first pass
    let seen = 0;           // steps of the current pass
    let kept = new Float64Array(Math.max(0, Math.min(limit, Math.floor(Number(capacity) || 0))));
    let level0 = null;      // dense, during the first pass
    let top = null;         // compact level-0 histogram, for the agreement bounds
    let groups = [];        // refine: { prefix, ranks: [{rank, order}], collect, values, size, hist }
    const orders = new Map(); // order statistic (0-based rank) → value
    let median = NaN;
    let agreeing = 0;
    let agreementKnown = false;
    let agreementOk = false;

    const wantedRanks = () => (count % 2 ? [count >> 1] : [(count >> 1) - 1, count >> 1]);
    const band = () => median * stepTolerance;
    const agrees = (d) => Math.abs(d - median) <= band();

    function finishMedian() {
        const mid = count >> 1;
        median = count % 2 ? orders.get(mid) : (orders.get(mid - 1) + orders.get(mid)) / 2;
    }

    // Decide the agreement gate from the compact histogram, or ask for a pass.
    function decideAgreement() {
        if (!Number.isFinite(median) || median <= 0 || count < GAP_STEP_MIN_SAMPLES) {
            agreementKnown = true;
            agreementOk = true;
            return false;
        }
        let lower = 0;
        let unknown = 0;
        for (let b = 0; b < top.keys.length; b++) {
            const lo = top.min[b];
            const hi = top.max[b];
            const a = agrees(lo);
            const z = agrees(hi);
            if (a && z) lower += top.count[b];
            else if (!a && !z && ((lo > median && hi > median) || (lo < median && hi < median))) continue;
            else unknown += top.count[b];
        }
        if (lower / count >= minStepAgreement) { agreementKnown = true; agreementOk = true; return false; }
        if ((lower + unknown) / count < minStepAgreement) { agreementKnown = true; agreementOk = false; return false; }
        phase = 'agree';
        agreeing = 0;
        return true;
    }

    // Place each wanted order statistic, or plan the pass that will.
    function planGroups(source, prefix, ranks) {
        for (const { rank, order } of ranks) {
            const at = locate(source, rank);
            const b = at.bucket;
            if (source.min[b] === source.max[b]) { orders.set(order, source.min[b]); continue; }
            const keyPrefix = [...prefix, source.keys[b]];
            const id = keyPrefix.join(':');
            let group = groups.find(g => g.id === id);
            if (!group) {
                const size = source.count[b];
                group = { id, prefix: keyPrefix, ranks: [], collect: size <= limit, values: null, size: 0, hist: null };
                if (group.collect) group.values = new Float64Array(size);
                else group.hist = denseHistogram();
                groups.push(group);
            }
            group.ranks.push({ rank: at.rank, order });
        }
    }

    function resolveGroups() {
        const pending = groups;
        groups = [];
        for (const group of pending) {
            if (group.collect) {
                const values = group.values.subarray(0, group.size);
                for (const { rank, order } of group.ranks) orders.set(order, selectKth(values, rank));
            } else {
                planGroups(compact(group.hist), group.prefix, group.ranks);
            }
        }
    }

    return {
        get count() { return count; },

        /** One positive, finite step. */
        add(d) {
            // The common case first, kept short: a step kept as it is.
            if (phase === 'collect' && count < kept.length) {
                kept[count++] = d;
                return;
            }
            switch (phase) {
            case 'collect':
                if (count < limit) {
                    kept = growFloat64(kept, count);
                    kept[count++] = d;
                    return;
                }
                // Past the limit: what was kept goes into the histogram.
                level0 = denseHistogram();
                for (let i = 0; i < count; i++) {
                    SCRATCH[0] = kept[i];
                    histogramAdd(level0, digit(0), kept[i]);
                }
                kept = null;
                phase = 'histogram';
                // falls through
            case 'histogram':
                count++;
                SCRATCH[0] = d;
                histogramAdd(level0, digit(0), d);
                return;
            case 'refine':
                SCRATCH[0] = d;
                for (const group of groups) {
                    if (!hasPrefix(group.prefix)) continue;
                    if (group.collect) group.values[group.size++] = d;
                    else histogramAdd(group.hist, digit(group.prefix.length), d);
                }
                return;
            case 'agree':
                seen++;
                if (agrees(d)) agreeing++;
                return;
            default:
                return;
            }
        },

        /**
         * The positive, finite steps of `t[0..len)` (with `prev` the abscissa
         * before t[0], NaN for none), added in order. One tight loop over a
         * chunk, for the time axis' scan.
         */
        addSteps(t, len, prev) {
            let p = prev;
            let k = 0;
            if (phase === 'collect') {
                const buffer = kept;
                let c = count;
                const room = buffer.length;
                for (; k < len && c < room; k++) {
                    const tk = t[k];
                    const d = tk - p;
                    p = tk;
                    if (d > 0 && d !== Infinity) buffer[c++] = d;
                }
                count = c;
            }
            for (; k < len; k++) {
                const tk = t[k];
                const d = tk - p;
                p = tk;
                if (d > 0 && d !== Infinity) this.add(d);
            }
        },

        /** After a pass over every step. True: make one more pass. */
        endPass() {
            switch (phase) {
            case 'collect': {
                // Exactly detectSamplingGaps: medianInPlace, then the count.
                const deltas = kept.subarray(0, count);
                median = count ? medianInPlace(deltas) : NaN;
                if (Number.isFinite(median) && median > 0) {
                    const width = band();
                    let agree = 0;
                    for (let i = 0; i < deltas.length; i++) if (Math.abs(deltas[i] - median) <= width) agree++;
                    agreementKnown = true;
                    agreementOk = !(count >= GAP_STEP_MIN_SAMPLES && agree / count < minStepAgreement);
                } else {
                    agreementKnown = true;
                    agreementOk = true;
                }
                kept = null;
                phase = 'done';
                return false;
            }
            case 'histogram':
                top = compact(level0);
                level0 = null;
                planGroups(top, [], wantedRanks().map(order => ({ rank: order, order })));
                if (groups.length) { phase = 'refine'; return true; }
                finishMedian();
                if (decideAgreement()) return true;
                phase = 'done';
                return false;
            case 'refine':
                resolveGroups();
                if (groups.length) return true;
                finishMedian();
                if (decideAgreement()) return true;
                phase = 'done';
                return false;
            case 'agree':
                agreementKnown = true;
                agreementOk = !(seen >= GAP_STEP_MIN_SAMPLES && agreeing / seen < minStepAgreement);
                phase = 'done';
                return false;
            default:
                return false;
            }
        },

        /**
         * The median step and whether at least 80 % of the steps agree with it
         * (when there are enough to judge): detectSamplingGaps' gate.
         */
        verdict() {
            return { medianDt: median, agreementOk: agreementKnown ? agreementOk : true };
        },
    };
}
