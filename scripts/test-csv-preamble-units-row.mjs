#!/usr/bin/env node
// A power analyser writes its CSV like this:
//
//     Recording
//     Date:,Time:,V1 RMS 1/2 cycle MIN,...,F,P1 (W),Q1 (var),S1 (VA)
//     ,,V,...,Hz,W,var,VA
//     (blank)
//     02/06/2026,13:37:30,227.67,...
//
// Names on row 2, units on row 3, a blank spacer on row 4. The whole file
// arrived as column_1..column_12: the names were gone and the units with them.
//
// Two things in _detectTableRows did it, and each on its own was enough:
//
//   1. The blank spacer was a header candidate. _looksLikeHeaderRow calls an
//      empty row a header (it is written to accept a row that names nothing
//      rather than reject it), and the spacer sits directly above the data, so
//      it paid no skipped-rows penalty while the real header two rows up paid
//      for the units row and the spacer both.
//
//   2. dataCount — 20 points a row, far and away the biggest term — was
//      counted inside a window ending at headerIndex + 30. A candidate lower
//      down therefore saw more data rows than one higher up looking at the
//      same table, so the score rewarded sitting close to the data instead of
//      explaining it. With the spacer gone, the first data row won on that
//      alone.
//
// Both are fixed, and the detector has to keep finding the title row with the
// preamble above it, the units row under it, and the units attached to each
// column — while the files that have no preamble at all still parse as before.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import CsvParser from '../src/parsers/csv-parser.js';

const parser = new CsvParser();

function bufferOf(text) {
    const bytes = new TextEncoder().encode(text);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// ─── The file as the analyser writes it ────────────────────────────
const FIXTURE = 'test-files/csv/power_analyzer_names_units_rows.csv';
const profile = parser.inspectSample(bufferOf(readFileSync(FIXTURE, 'utf8')), { maxRows: 200 });

assert.equal(profile.hasHeader, true, 'the analyser export has a header row');
assert.equal(profile.headerIndex, 1, 'the names are on row 2, under the "Recording" title');
assert.equal(profile.unitRowIndex, 2, 'the units are on row 3');
assert.equal(profile.unitsMode, 'row', 'units in a row of their own, not cut out of the titles');
assert.equal(profile.dataStartIndex, 4, 'the data starts under the blank spacer row');

assert.deepEqual(
    profile.headers.map(header => header.name),
    [
        'Date:', 'Time:',
        'V1 RMS 1/2 cycle MIN', 'V1 RMS 1/2 cycle AVG', 'V1 RMS 1/2 cycle MAX',
        'A1 RMS 1/2 cycle MIN', 'A1 RMS 1/2 cycle AVG', 'A1 RMS 1/2 cycle MAX',
        'F', 'P1 (W)', 'Q1 (var)', 'S1 (VA)',
    ],
    'every column keeps the name the file gave it',
);

// A units row is in charge of the units, so "P1 (W)" keeps its parentheses
// instead of being split into a name and a unit as well.
assert.deepEqual(
    profile.headers.map(header => header.description),
    ['', '', '[V]', '[V]', '[V]', '[A]', '[A]', '[A]', '[Hz]', '[W]', '[var]', '[VA]'],
    'each column takes its unit from the units row',
);

assert.equal(profile.timeSource?.ok, true, 'the split Date:/Time: pair is still read as the time');
assert.deepEqual(profile.timeSource.sourceIndexes, [0, 1], 'time comes from the date and time columns');

// The data itself survives: the blank spacer is not counted as a record, and
// "- - -" in the frequency column is a missing value rather than a parse error.
const parsed = await parser.parseWithProfile(bufferOf(readFileSync(FIXTURE, 'utf8')), profile);
assert.equal(parsed.metadata.numTimesteps, 60, 'all 60 records parse, and the spacer is not one of them');
const frequency = parsed.variables.F;
assert.ok(frequency, 'the frequency column is there under its own name');
assert.ok(Number.isNaN(frequency.data[0]), '"- - -" is a missing value');
assert.ok(Number.isFinite(frequency.data[10]), 'the frequency readings that are there parse as numbers');

// ─── The same shape, without the trailing blank spacer ─────────────
// Covers fix 2 on its own: nothing here is blank, and the title row still has
// to beat the units row and the first data row.
const NO_SPACER = [
    'Logger export,,,',
    'Timestamp,Speed,Power,Temp',
    '[yyyy-MM-dd HH:mm],m/s,kW,degC',
    ...Array.from({ length: 40 }, (_, i) =>
        `2024-03-01 ${String(i).padStart(2, '0')}:00,${(4 + i * 0.1).toFixed(2)},${(900 + i).toFixed(1)},${(12 + i * 0.05).toFixed(2)}`),
].join('\n');
const noSpacer = parser.inspectSample(bufferOf(NO_SPACER), { maxRows: 200 });
assert.equal(noSpacer.headerIndex, 1, 'the title row wins over the units row below it');
assert.equal(noSpacer.unitRowIndex, 2, 'and the row below it is read as units');
assert.deepEqual(
    noSpacer.headers.map(header => header.name),
    ['Timestamp', 'Speed', 'Power', 'Temp'],
);
assert.deepEqual(
    noSpacer.headers.map(header => header.description),
    ['[yyyy-MM-dd HH:mm]', '[m/s]', '[kW]', '[degC]'],
);

// ─── Nothing moved for the ordinary files ──────────────────────────
const PLAIN = [
    'time,value',
    ...Array.from({ length: 10 }, (_, i) => `${i},${i * 2}`),
].join('\n');
const plain = parser.inspectSample(bufferOf(PLAIN), { maxRows: 50 });
assert.equal(plain.headerIndex, 0, 'a plain header on row 1 is still row 1');
assert.equal(plain.dataStartIndex, 1);
assert.equal(plain.unitRowIndex ?? null, null, 'and there is no units row to find');

// A headerless numeric file keeps every row of data, blank first line or not.
const HEADERLESS = Array.from({ length: 10 }, (_, i) => `${i},${i * 3}`).join('\n');
const headerless = parser.inspectSample(bufferOf(HEADERLESS), { maxRows: 50 });
assert.equal(headerless.hasHeader, false, 'numbers all the way down is not a header');
assert.equal(headerless.dataStartIndex, 0, 'and the first row is data');

const LEADING_BLANK = `,\n${HEADERLESS}`;
const leadingBlank = parser.inspectSample(bufferOf(LEADING_BLANK), { maxRows: 50 });
assert.equal(leadingBlank.hasHeader, false, 'a blank first line does not become the header');
assert.equal(leadingBlank.dataStartIndex, 1, 'the data still starts at the first row of numbers');
const leadingBlankData = await parser.parseWithProfile(bufferOf(LEADING_BLANK), leadingBlank);
assert.equal(leadingBlankData.metadata.numTimesteps, 10, 'and no row of it is eaten by the blank line');

console.log('csv preamble/units-row detection: OK');
