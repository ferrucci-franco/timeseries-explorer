// "NaN" cells are missing numbers, not text (RECIF SCADA REC_*.txt files, 2026-10-22): a tab-separated log
// whose first data row is mostly NaN must keep its real header, and an all-NaN column must stay numeric.
import assert from 'node:assert/strict';
import CsvParser, { isMissingNumberCell } from '../src/parsers/csv-parser.js';

assert.ok(isMissingNumberCell('NaN') && isMissingNumberCell(' nan ') && isMissingNumberCell('-NaN'));
assert.ok(!isMissingNumberCell('') && !isMissingNumberCell('Nantes') && !isMissingNumberCell('1.0'));

const header = ['Date', 'Time(s)', 'tps(s)', 'tpb(ms)', 'ELY_V', 'ELY_I', 'FC_V', 'FC_I', 'BATT_V', 'T_01', 'PH2_LINE'];
const rows = [];
for (let i = 0; i < 20; i++) {
    const t = `11:44:${String(10 + i).padStart(2, '0')}`;
    rows.push(['21/10/2026', t, (i + 1).toFixed(3), '516.000', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN',
        (23.4 + i / 10).toFixed(3), '5.879']);
}
const text = [header, ...rows].map(r => r.join('\t')).join('\r\n') + '\r\n';
const buffer = new TextEncoder().encode(text).buffer;
const result = await new CsvParser().parse(buffer);
const names = Object.keys(result.variables);
assert.ok(names.includes('ELY_V') && names.includes('T_01'), `header lost: ${names.slice(0, 6)}`);
const time = Object.values(result.variables).find(v => v.kind === 'abscissa');
assert.equal(time.data.length, 20);
assert.equal(result.variables.ELY_V.dataType === 'string', false, 'an all-NaN column must stay numeric');
assert.ok(result.variables.ELY_V.data.every(Number.isNaN));
assert.equal(result.variables.T_01.data[3], 23.7);
console.log('CSV NaN cells OK');
