// Fitting labels to a plot's room (src/utils/text-fit.js): the name of a
// curve in its hover label wraps, a long axis title is shortened.
import assert from 'node:assert/strict';
import { fitText, wrapText } from '../src/utils/text-fit.js';

const name = 'R1 · 2 metre dewpoint temperature (d2m) · mean [33.44°S–31.01°S, 64.99°W–61.24°W]';
assert.deepEqual(wrapText('short', 20), ['short'], 'a short name stays whole');
const lines = wrapText(name, 40);
assert.ok(lines.every(line => line.length <= 40), `no line longer than the room (${JSON.stringify(lines)})`);
assert.equal(lines.join(' ').replace(/\s+/g, ' '), name.replace(/\s+/g, ' '), 'nothing lost');
assert.equal(lines[0], 'R1 · 2 metre dewpoint temperature (d2m)', 'broken between words, not inside one');
assert.ok(lines[1].startsWith('· mean'), 'the next line goes on from there');
assert.ok(wrapText('x'.repeat(50), 20).every(line => line.length <= 20), 'a word longer than a line is cut');
assert.equal(fitText('abc', 10), 'abc');
assert.equal(fitText(name, 20), `${name.slice(0, 19).trimEnd()}…`);
assert.equal(fitText(name, 20).length <= 20, true);
const roomy = wrapText(name, 40, { reserve: 14 });
assert.ok(roomy.at(-1).length <= 26, `the last line keeps room for the value (${JSON.stringify(roomy)})`);
assert.equal(roomy.join(' ').replace(/\s+/g, ' '), name.replace(/\s+/g, ' '), 'still nothing lost');
console.log('text fit: ok');
