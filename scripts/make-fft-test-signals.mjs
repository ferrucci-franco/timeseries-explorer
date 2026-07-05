// Generates CSV fixtures for manually testing the FFT plot mode.
// Usage: node scripts/make-fft-test-signals.mjs
// Output: test-files/fft/*.csv (time axis in seconds, fs = 1000 Hz)

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'test-files', 'fft');
const FS = 1000;

// Deterministic PRNG (mulberry32) so fixtures are reproducible.
function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Box-Muller gaussian from uniform rng.
function makeGauss(rng) {
    let spare = null;
    return () => {
        if (spare !== null) { const v = spare; spare = null; return v; }
        let u = 0, v = 0, s = 0;
        do {
            u = 2 * rng() - 1;
            v = 2 * rng() - 1;
            s = u * u + v * v;
        } while (s === 0 || s >= 1);
        const m = Math.sqrt(-2 * Math.log(s) / s);
        spare = v * m;
        return u * m;
    };
}

function writeCsv(name, headers, rows) {
    const lines = [headers.join(',')];
    for (const row of rows) lines.push(row.map(v => Number(v.toFixed(6))).join(','));
    writeFileSync(join(OUT_DIR, name), lines.join('\n') + '\n');
    console.log(`${name}: ${rows.length} rows, ${headers.length} columns`);
}

function times(duration) {
    const n = Math.round(duration * FS) + 1;
    return Array.from({ length: n }, (_, i) => i / FS);
}

mkdirSync(OUT_DIR, { recursive: true });

// 1. Sine with noise that changes period: 5 segments, 2 s each,
//    frequencies 5/10/20/40/80 Hz, amplitude 1, noise sigma 0.05.
{
    const gauss = makeGauss(makeRng(101));
    const freqs = [5, 10, 20, 40, 80];
    const segDur = 2;
    const rows = [];
    let phase = 0;
    let prevT = 0;
    for (const t of times(freqs.length * segDur)) {
        const seg = Math.min(freqs.length - 1, Math.floor(t / segDur));
        phase += 2 * Math.PI * freqs[seg] * (t - prevT); // continuous phase
        prevT = t;
        rows.push([t, Math.sin(phase) + 0.05 * gauss()]);
    }
    writeCsv('01_sine_changing_period.csv', ['time_s', 'signal'], rows);
}

// 2. Sum of sines (10 Hz A=1, 35 Hz A=0.5, 80 Hz A=0.25), 10 s:
//    first half clean, second half with gaussian noise sigma 0.3.
{
    const gauss = makeGauss(makeRng(202));
    const rows = times(10).map(t => {
        const clean = Math.sin(2 * Math.PI * 10 * t)
            + 0.5 * Math.sin(2 * Math.PI * 35 * t)
            + 0.25 * Math.sin(2 * Math.PI * 80 * t);
        return [t, clean + (t >= 5 ? 0.3 * gauss() : 0)];
    });
    writeCsv('02_multisine_half_noisy.csv', ['time_s', 'signal'], rows);
}

// 3. 20 Hz sine A=1 with noise growing linearly from 0 to sigma 1 over 10 s.
{
    const gauss = makeGauss(makeRng(303));
    const rows = times(10).map(t => [
        t,
        Math.sin(2 * Math.PI * 20 * t) + (t / 10) * gauss(),
    ]);
    writeCsv('03_sine_growing_noise.csv', ['time_s', 'signal'], rows);
}

// 4. Two close sines (50 Hz and 53 Hz, both A=1), 10 s. Columns for each
//    tone and for the sum, to test overlaid FFTs and frequency resolution:
//    a 2 s window resolves them, a 0.2 s window cannot.
{
    const rows = times(10).map(t => {
        const s50 = Math.sin(2 * Math.PI * 50 * t);
        const s53 = Math.sin(2 * Math.PI * 53 * t);
        return [t, s50, s53, s50 + s53];
    });
    writeCsv('04_two_close_sines.csv', ['time_s', 'sine_50Hz', 'sine_53Hz', 'sum'], rows);
}

// 5. Square -> triangle -> sawtooth, 10 Hz, amplitude 1, 3 s per segment.
{
    const f = 10;
    const rows = times(9).map(t => {
        const cyc = (t * f) % 1;
        let v;
        if (t < 3) v = cyc < 0.5 ? 1 : -1;                       // square
        else if (t < 6) v = cyc < 0.5 ? 4 * cyc - 1 : 3 - 4 * cyc; // triangle
        else v = 2 * cyc - 1;                                     // sawtooth
        return [t, v];
    });
    writeCsv('05_square_triangle_sawtooth.csv', ['time_s', 'signal'], rows);
}

// 6. Linear sweep (chirp) 1 -> 100 Hz over 10 s, amplitude 1.
{
    const f0 = 1, f1 = 100, T = 10;
    const rows = times(T).map(t => [
        t,
        Math.sin(2 * Math.PI * (f0 * t + ((f1 - f0) / (2 * T)) * t * t)),
    ]);
    writeCsv('06_sweep_1_to_100Hz.csv', ['time_s', 'signal'], rows);
}

console.log(`\nDone. Files in ${OUT_DIR}`);
