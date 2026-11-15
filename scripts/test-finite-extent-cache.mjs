// The time pane's extent of an axis is kept per array and never served stale.
//
//   node scripts/test-finite-extent-cache.mjs
import assert from 'node:assert/strict';
import { createExtentCache, scanFiniteExtent } from '../src/utils/finite-extent.js';

const extentOf = createExtentCache();

// The same numbers as a plain scan, for every kind of array and both modes.
for (const arr of [
    Float64Array.from([3, 1, NaN, 7, -2, Infinity]),
    [5, 4, null, 'x', 9, 0],
    new Float64Array(0),
    Float64Array.from([NaN, NaN]),
]) {
    for (const positive of [false, true]) {
        assert.deepEqual(extentOf(arr, positive), scanFiniteExtent(arr, positive), `cached = scanned (${positive})`);
        assert.deepEqual(extentOf(arr, positive), scanFiniteExtent(arr, positive), 'and again, from the cache');
    }
}

// Served from the cache: the second ask returns the very same object.
const axis = Float64Array.from([10, 20, 30]);
assert.equal(extentOf(axis), extentOf(axis), 'one scan per array');
assert.notEqual(extentOf(axis, true), extentOf(axis, false), 'the positive-only extent is kept apart');

// A new array (a transform, a reload, a live append) is scanned afresh; so is
// a longer one under the same identity.
const shifted = axis.map(v => v + 100);
assert.deepEqual(extentOf(shifted), { min: 110, max: 130 }, 'a new array, a new extent');
const grown = [1, 2, 3];
assert.deepEqual(extentOf(grown), { min: 1, max: 3 });
grown.push(9);
assert.deepEqual(extentOf(grown), { min: 1, max: 9 }, 'an array that grew is scanned again');

console.log('finite extent cache: per-array extents equal the scan and are never stale');
