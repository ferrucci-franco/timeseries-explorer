import assert from 'node:assert/strict';

import { expandedAxisRangeForExtent } from '../src/plots/methods/data-methods.js';

assert.equal(
    expandedAxisRangeForExtent([0, 10], { min: 2, max: 8 }),
    null,
    'an added signal already inside the visible Y range leaves it untouched',
);

const above = expandedAxisRangeForExtent([0, 10], { min: 4, max: 20 });
assert.equal(above[0], 0, 'expanding upward preserves the lower Y bound');
assert.ok(above[1] > 20, 'expanding upward includes the new signal with padding');

const below = expandedAxisRangeForExtent([0, 10], { min: -20, max: 4 });
assert.ok(below[0] < -20, 'expanding downward includes the new signal with padding');
assert.equal(below[1], 10, 'expanding downward preserves the upper Y bound');

const both = expandedAxisRangeForExtent([0, 10], { min: -5, max: 20 });
assert.ok(both[0] < -5 && both[1] > 20, 'a signal crossing both bounds expands both sides');

const reversed = expandedAxisRangeForExtent([10, 0], { min: -5, max: 8 });
assert.ok(reversed[0] === 10 && reversed[1] < -5, 'reversed Y axes preserve their direction');

console.log('Time-series Y expansion tests passed.');
