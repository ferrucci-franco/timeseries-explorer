// Repeated timestamps are counted and said, not acted on (#154).
//
// Three consecutive rows with the same datetime used to switch the whole file
// to a row-number axis — 4 997 good timestamps in a 5 000-row file set aside
// because of 3 — and only the first 1 000 rows were scanned, so the SAME file
// kept or lost its axis depending on where the burst sat.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    REPEATED_TIMESTAMP_RUN_NOTICE,
    repeatedTimestampSummary,
    repeatedTimestampsWorthSaying,
} from '../src/utils/repeated-timestamps.js';

// ── Counting ────────────────────────────────────────────────────────────────
assert.deepEqual(repeatedTimestampSummary([1, 2, 3, 4]), { samples: 4, repeated: 0, longestRun: 1 });
assert.deepEqual(repeatedTimestampSummary([1, 1, 2]), { samples: 3, repeated: 1, longestRun: 2 },
    'three rows, two of them at one instant');
assert.deepEqual(repeatedTimestampSummary([1, 1, 1, 2]), { samples: 4, repeated: 2, longestRun: 3 },
    'a burst of three counts as three rows at one instant, and two repeats');
assert.deepEqual(repeatedTimestampSummary([5, 5, 6, 7, 7, 7, 7]), { samples: 7, repeated: 4, longestRun: 4 },
    'the longest run is the longest, not the last');

// Position must not matter: that was half the bug.
const burstAt = (index) => {
    const values = new Float64Array(5000);
    for (let i = 0; i < values.length; i++) values[i] = i >= index && i < index + 3 ? index : i;
    return values;
};
assert.deepEqual(repeatedTimestampSummary(burstAt(100)), repeatedTimestampSummary(burstAt(4000)),
    'the same file reads the same whether the burst is early or late');
assert.equal(repeatedTimestampSummary(burstAt(4000)).longestRun, 3, 'and it is seen at all past row 1 000');

// A gap is not a repeat, and it does not join the runs on either side.
assert.deepEqual(repeatedTimestampSummary([1, NaN, 1, 2]), { samples: 4, repeated: 0, longestRun: 1 },
    'the same instant either side of a hole is not two rows at one instant');
assert.deepEqual(repeatedTimestampSummary([]), { samples: 0, repeated: 0, longestRun: 0 });
assert.deepEqual(repeatedTimestampSummary([7]), { samples: 1, repeated: 0, longestRun: 1 });
assert.deepEqual(repeatedTimestampSummary(null), { samples: 0, repeated: 0, longestRun: 0 });
assert.equal(repeatedTimestampSummary(Float64Array.from([2, 2, 2])).longestRun, 3, 'typed arrays too');

// ── When it is worth a sentence ─────────────────────────────────────────────
assert.equal(REPEATED_TIMESTAMP_RUN_NOTICE, 3, 'the same files are spoken about as before');
assert.equal(repeatedTimestampsWorthSaying(repeatedTimestampSummary([1, 1, 2])), false,
    'two rows at one instant is how a solver writes an event');
assert.equal(repeatedTimestampsWorthSaying(repeatedTimestampSummary([1, 1, 1])), true);
assert.equal(repeatedTimestampsWorthSaying(null), false);

// ── Nothing demotes the axis any more ───────────────────────────────────────
const sources = {
    'src/parsers/csv-parser.js': readFileSync(new URL('../src/parsers/csv-parser.js', import.meta.url), 'utf8'),
    'src/parsers/pickle-parser.js': readFileSync(new URL('../src/parsers/pickle-parser.js', import.meta.url), 'utf8'),
    'src/data/duckdb-source.js': readFileSync(new URL('../src/data/duckdb-source.js', import.meta.url), 'utf8'),
    'src/app/methods/file-methods.js': readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8'),
};
for (const [name, source] of Object.entries(sources)) {
    assert.doesNotMatch(source, /_isStalledTimeAxis/, `${name}: the five copies of the detector are gone`);
    assert.doesNotMatch(source, /datetimeAxisStalled/, `${name}: and so is the flag they set`);
}
// A datetime column reads as a calendar, whatever its repeats.
assert.match(sources['src/parsers/csv-parser.js'], /timeVariable\.timeDisplayMode = 'calendar';/,
    'the CSV path keeps the calendar axis');
assert.match(sources['src/data/duckdb-source.js'], /timeVar\.timeDisplayMode = 'calendar';/,
    'and so does the lazy one');
assert.equal((sources['src/parsers/csv-parser.js'].match(/repeatedTimestampSummary\(timeValues\)/g) || []).length, 2,
    'both CSV parse paths count');

// The count travels with the file, and the notice reads it.
for (const [name, source] of Object.entries(sources)) {
    if (name === 'src/app/methods/file-methods.js') continue;
    assert.match(source, /datetimeRepeats/, `${name}: the count is in the metadata`);
}
const app = sources['src/app/methods/file-methods.js'];
assert.match(app, /proto\._repeatedDatetimeSummary = function\(data\) \{/, 'one place asks the question');
assert.match(app, /if \(!repeatedTimestampsWorthSaying\(summary\)\) return;/, 'and the dialog is gated on it');
assert.match(app, /\.replace\('\{count\}', i18n\.formatNumber\(summary\.repeated\)\)/, 'the notice says how many');
assert.match(app, /\.replace\('\{run\}', i18n\.formatNumber\(summary\.longestRun\)\)/, 'and how long the worst run is');

const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');
assert.doesNotMatch(translations, /datetimeAxisStalledHint/, 'the hint that announced the switch is gone');
for (const key of ['datetimeRepeatsHint', 'datetimeAxisRepeatedDialogBody']) {
    assert.equal([...translations.matchAll(new RegExp(`${key}:`, 'g'))].length, 4, `${key} in four languages`);
}
// Every language's text carries both numbers, or a language quietly says less.
for (const line of translations.split('\n')) {
    if (!/\b(datetimeRepeatsHint|datetimeAxisRepeatedDialogBody):/.test(line)) continue;
    assert.ok(line.includes('{count}') && line.includes('{run}'), `both counts in: ${line.trim().slice(0, 60)}…`);
}

console.log('Repeated-timestamp checks passed.');
