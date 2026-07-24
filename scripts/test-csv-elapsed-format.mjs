// Test for the CSV import "Numeric elapsed (seconds)" time format (design S4).
// buildManualTimeSource lives in a DOM-coupled dialog module, so we slice the
// pure function out of the source and run it in a vm with the real parseCsvNumber
// and light stubs for the branches the elapsed path never reaches.
//
// The point of the elapsed format: a column like `s.SSS` with values > 59 must be
// read as plain elapsed numbers, NOT fed to the datetime clock parser (which
// anchors to year 2001 and rejects seconds > 59).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseCsvNumber } from '../src/parsers/csv-time-detection.js';

const source = readFileSync(
    new URL('../src/ui/csv-parsing-preview-dialog.js', import.meta.url),
    'utf8',
);
const start = source.indexOf('function buildManualTimeSource(');
assert.ok(start >= 0, 'buildManualTimeSource is present');
const end = source.indexOf('\nfunction ', start + 1);
assert.ok(end > start, 'function end located');
const fnText = source.slice(start, end >= 0 ? end : source.length);

const context = {
    parseCsvNumber,
    headerName: (_parser, header, index) => header || `col${index}`,
    detectCsvTimeAxis: () => ({ ok: false }),
    serializeTimeSource: x => x,
    parseCsvTimeValue: () => NaN,
    customDatetimePatternInfo: () => ({}),
};
vm.createContext(context);
vm.runInContext(fnText, context);
const buildManualTimeSource = context.buildManualTimeSource;
assert.equal(typeof buildManualTimeSource, 'function', 'extracted function is callable');

const rawHeaders = ['t'];
// Values chosen to include seconds > 59 — fatal for the clock parser, fine here.
const numericRows = [['0'], ['0.1'], ['75.5'], ['120.25'], ['3600.125']];

// Elapsed format: numeric column ⇒ numeric strategy (elapsed seconds), no clock.
const elapsed = buildManualTimeSource(null, rawHeaders, numericRows, ',', 0, 'DMY', { timeFormat: 'elapsed' });
assert.equal(elapsed.ok, true, 'elapsed: numeric column accepted');
assert.equal(elapsed.kind, 'numeric', 'elapsed: kind is numeric');
assert.equal(elapsed.strategy, 'numeric', 'elapsed: strategy is numeric (bypasses the datetime clock parser)');
assert.equal(elapsed.sourceIndexes.length, 1);
assert.equal(elapsed.sourceIndexes[0], 0);
assert.equal(elapsed.format && Object.keys(elapsed.format).length, 0, 'elapsed: no datetime format attached');

// Elapsed format on a non-numeric column ⇒ rejected with a clear reason.
const nonNumericRows = [['apple'], ['banana'], ['cherry'], ['date']];
const rejected = buildManualTimeSource(null, rawHeaders, nonNumericRows, ',', 0, 'DMY', { timeFormat: 'elapsed' });
assert.equal(rejected.ok, false, 'elapsed: non-numeric column rejected');
assert.match(rejected.reason, /numeric/i);

// Empty column ⇒ rejected.
const empty = buildManualTimeSource(null, rawHeaders, [[''], ['']], ',', 0, 'DMY', { timeFormat: 'elapsed' });
assert.equal(empty.ok, false, 'elapsed: empty column rejected');

console.log('CSV elapsed-format (S4) tests passed.');
