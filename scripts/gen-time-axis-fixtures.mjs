#!/usr/bin/env node
// Generates the time-axis diagnostic fixtures in test-files/csv/time-axis/.
//
// Run with: node scripts/gen-time-axis-fixtures.mjs
//
// The output is COMMITTED and the tests assert against the committed files. The
// jitter case uses a seeded PRNG rather than Math.random so re-running this
// reproduces the same bytes — a fixture that changes on its own turns a test
// into a coin flip.
//
// These files deliberately break: missing samples, unparseable timestamps,
// repeated instants, time that steps backwards. They live in a SUBDIRECTORY
// because test-csv-fixtures.mjs sweeps test-files/csv/ and requires every file
// there to parse cleanly with finite timestamps; that sweep only picks up plain
// files, so a nested directory stays out of its way.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT_DIR = join('test-files', 'csv', 'time-axis');

// Deterministic PRNG (mulberry32) — same seed, same fixture, forever.
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Two signals so the fixtures are also worth opening by hand in the app.
const signalA = t => Math.sin(Number(t) * 0.7);
const signalB = t => Number(t) * 2;

const num = value => (Number.isFinite(value) ? String(Number(value.toFixed(6))) : String(value));

// `times` entries are either numbers or raw strings written verbatim (used for
// the unparseable cells). Signal columns always hold valid numbers, so a dropped
// row is dropped for its timestamp alone.
function writeFixture(name, header, times) {
    const lines = [header];
    let previousValid = 0;
    for (const entry of times) {
        const isRaw = typeof entry === 'string';
        const t = isRaw ? previousValid + 1 : entry;
        if (!isRaw) previousValid = entry;
        lines.push([isRaw ? entry : num(entry), num(signalA(t)), num(signalB(t))].join(','));
    }
    writeFileSync(join(OUT_DIR, name), `${lines.join('\n')}\n`, 'utf8');
    return lines.length - 1;
}

mkdirSync(OUT_DIR, { recursive: true });
const header = 'time,speed,position';
const written = [];
const add = (name, times) => written.push([name, writeFixture(name, header, times)]);

// ── Negative control: perfectly uniform, must not raise anything ──────────────
add('uniform.csv', Array.from({ length: 30 }, (_, i) => i));

// ── Missing samples: two stretches dropped out of a 1 s grid ──────────────────
add('gaps.csv', [
    ...Array.from({ length: 10 }, (_, i) => i),        // 0…9
    ...Array.from({ length: 10 }, (_, i) => 15 + i),   // 15…24  (missing 10…14)
    ...Array.from({ length: 5 }, (_, i) => 30 + i),    // 30…34  (missing 25…29)
]);

// ── Repeated instants: the shape every Modelica result has at an event ────────
{
    const times = [];
    for (let i = 0; i <= 20; i++) {
        const t = Number((i * 0.1).toFixed(6));
        times.push(t);
        if (i === 5 || i === 15) times.push(t); // the duplicated event sample
    }
    add('repeated.csv', times);
}

// ── Time stepping backwards: a clock correction or a badly merged log ─────────
// Note what the CSV parser does with this: _sortTimeSeriesByTime reorders the
// rows (stably) whenever the column is not monotonic, so the reversal never
// reaches the diagnostic — it arrives as 3 → 3.5 → 4, i.e. two half-steps and a
// double step. The fixture pins that behaviour; the reversal counter itself is
// exercised at the array level, where formats that keep file order can hit it.
add('backwards.csv', [0, 1, 2, 3, 4, 3.5, 6, 7, 8, 9]);

// ── Unparseable timestamps: empty, NaN and text cells ─────────────────────────
// A single unparseable cell costs the whole column: the parser refuses it as the
// time axis and generates a row index instead (timeKind 'index'), demoting the
// real timestamps to an ordinary variable. That is why this pathology gets its
// own file and is never mixed with the others — once it fires, there is no
// timestamp axis left for them to be pathologies of.
{
    const times = [];
    for (let i = 0; i < 30; i++) {
        if (i === 7) times.push('');
        else if (i === 15) times.push('NaN');
        else if (i === 23) times.push('bad');
        else times.push(i);
    }
    add('nan-time.csv', times);
}

// ── ±10% jitter: irregular sampling with nothing actually missing ─────────────
{
    const random = mulberry32(20260726);
    const times = [0];
    for (let i = 1; i < 200; i++) {
        const step = 1 + (random() * 0.2 - 0.1);
        times.push(Number((times[i - 1] + step).toFixed(6)));
    }
    add('jitter.csv', times);
}

// ── Everything at once, with distinct counts so a swapped counter shows ───────
// 3 repeated instants, 2 gaps, and one out-of-order sample the parser sorts back
// into place. No unparseable cells here on purpose — see nan-time.csv.
add('mixed.csv', [
    0, 1, 2, 3, 4, 4, 5, 6, 6,
    12, 13, 14, 13.5, 15, 15, 22, 23,
]);

for (const [name, rows] of written) console.log(`${name}: ${rows} rows`);
