// The smallest and largest finite value of arrays, for axis ranges.

/**
 * One array's extent: the finite values (those > 0 when `positive`).
 * `{ min: Infinity, max: -Infinity }` when it has none.
 */
export function scanFiniteExtent(arr, positive = false) {
    let min = Infinity;
    let max = -Infinity;
    // An index loop where there is one: the same values in the same order as
    // the iterator, several times faster on a typed array of millions.
    if (Array.isArray(arr) || ArrayBuffer.isView(arr)) {
        for (let i = 0; i < arr.length; i++) {
            const value = arr[i];
            if (!Number.isFinite(value)) continue;
            if (positive && !(value > 0)) continue;
            if (value < min) min = value;
            if (value > max) max = value;
        }
        return { min, max };
    }
    for (const value of arr) {
        if (!Number.isFinite(value)) continue;
        if (positive && !(value > 0)) continue;
        if (value < min) min = value;
        if (value > max) max = value;
    }
    return { min, max };
}

/**
 * `scanFiniteExtent` remembered per array, for arrays that are never changed in
 * place (the time axes). Keyed by the array itself, so a transform, a reload or
 * a live append — each hands out a new array — is scanned again; the length is
 * checked as well. Building a time pane read every value of the axis (100–250
 * ms on 10 M rows), and a curve-fit recompute builds the residual pane again.
 */
export function createExtentCache() {
    const memo = new WeakMap();
    return (arr, positive = false) => {
        if (!arr || typeof arr !== 'object') return scanFiniteExtent(arr || [], positive);
        let entries = memo.get(arr);
        if (!entries) {
            entries = {};
            memo.set(arr, entries);
        }
        const key = positive ? 'positive' : 'all';
        const hit = entries[key];
        if (hit && hit.length === arr.length) return hit.extent;
        const extent = scanFiniteExtent(arr, positive);
        entries[key] = { length: arr.length, extent };
        return extent;
    };
}
