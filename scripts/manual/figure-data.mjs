// The files the manual's scripted figures are captured from
// (scripts/capture-manual-figures.mjs). Each is generated here, from a seeded
// random sequence, so a capture run gives the same figure every time and no
// measurement file has to live in the repository.
import { PENDULUM_RUNS, pendulumResultMat } from '../../src/ui/guide-om-result.js';

// mulberry32: a small seeded generator, the same sequence on every run.
function random(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
// Roughly normal noise: the sum of four uniforms, centred.
const noise = rand => (rand() + rand() + rand() + rand() - 2) * 0.87;

const csvFile = (name, lines) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(`${lines.join('\n')}\n`) });
const pad = value => String(value).padStart(2, '0');

/** Three runs of the bundled pendulum model, as OpenModelica writes them: the damping `b` differs. */
export function pendulumRuns() {
    return PENDULUM_RUNS.map((b, index) => ({
        name: `Pendulum_run${index + 1}_res.mat`,
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(pendulumResultMat({ b, theta0Deg: 60 })),
    }));
}

/** A logger export as instruments write them: a preamble, semicolons, decimal commas, day-first dates. */
export function loggerCsv() {
    const rand = random(11);
    const lines = [
        'Logger;DL-220',
        'Site;Pump station 3',
        'Serial;48213',
        'Started;12/03/2026 08:00:00',
        '',
        'Timestamp;Pressure [bar];Flow [m3/h];Temperature [°C]',
    ];
    const comma = (value, digits) => value.toFixed(digits).replace('.', ',');
    for (let i = 0; i < 720; i++) {
        const minutes = 8 * 60 + i;
        const stamp = `12/03/2026 ${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}:00`;
        const pressure = 4.2 + 0.35 * Math.sin(i / 55) + 0.04 * noise(rand);
        const flow = 18 + 4 * Math.sin(i / 90 + 1) + 0.5 * noise(rand);
        const temperature = 21.5 + 3 * Math.sin(i / 230) + 0.1 * noise(rand);
        lines.push(`${stamp};${comma(pressure, 3)};${comma(flow, 2)};${comma(temperature, 1)}`);
    }
    return csvFile('pump-station-3.csv', lines);
}

/** A measurement with holes: rows missing for a while, and values that are not numbers. */
export function gapsCsv() {
    const rand = random(23);
    const lines = ['time,level,flow'];
    for (let i = 0; i < 600; i++) {
        if ((i > 150 && i < 205) || (i > 400 && i < 430)) continue;   // the logger was off
        const t = i * 0.5;
        const level = 2 + Math.sin(t / 18) + 0.03 * noise(rand);
        const flow = 1.2 + 0.6 * Math.cos(t / 25) + 0.03 * noise(rand);
        const lost = (i > 290 && i < 312) || i === 505;                // the sensor answered nothing
        lines.push(`${t.toFixed(1)},${lost ? 'NaN' : level.toFixed(4)},${flow.toFixed(4)}`);
    }
    return csvFile('tank-level.csv', lines);
}

/** A heater switched on at t = 20 s: a first-order rise with noise, for the curve fit. */
export function stepCsv() {
    const rand = random(37);
    const lines = ['time,temperature'];
    for (let i = 0; i <= 1200; i++) {
        const t = i * 0.1;
        const rise = t < 20 ? 0 : 35 * (1 - Math.exp(-(t - 20) / 14));
        lines.push(`${t.toFixed(1)},${(22 + rise + 0.35 * noise(rand)).toFixed(3)}`);
    }
    return csvFile('heater-step.csv', lines);
}

/** A sensor that holds, drifts up, then drifts down faster: three stretches for the trend analysis. */
export function trendCsv() {
    const rand = random(41);
    const lines = ['time,pressure'];
    for (let i = 0; i <= 1800; i++) {
        const t = i;
        let y = 5;
        if (t > 600) y += 0.004 * (Math.min(t, 1200) - 600);
        if (t > 1200) y -= 0.006 * (t - 1200);
        lines.push(`${t},${(y + 0.12 * noise(rand)).toFixed(4)}`);
    }
    return csvFile('pressure-drift.csv', lines);
}

/** A slow 2 Hz wave under 50 Hz hum and noise, sampled at 1 kHz: what a low-pass filter is for. */
export function noisyCsv() {
    const rand = random(53);
    const lines = ['time,vibration'];
    for (let i = 0; i < 2000; i++) {
        const t = i / 1000;
        const y = Math.sin(2 * Math.PI * 2 * t) + 0.35 * Math.sin(2 * Math.PI * 50 * t) + 0.12 * noise(rand);
        lines.push(`${t.toFixed(3)},${y.toFixed(5)}`);
    }
    return csvFile('vibration.csv', lines);
}

/** A table past the smallest CSV limit (about 3 MB), so it opens in memory-saving mode. */
export function largeCsv() {
    const rand = random(67);
    const lines = ['time,speed,torque,power'];
    for (let i = 0; i < 90000; i++) {
        const t = i * 0.01;
        const speed = 1500 + 300 * Math.sin(t / 40) + 8 * noise(rand);
        const torque = 42 + 10 * Math.sin(t / 15 + 1) + 1.2 * noise(rand);
        lines.push(`${t.toFixed(2)},${speed.toFixed(4)},${torque.toFixed(4)},${(speed * torque * 2 * Math.PI / 60000).toFixed(5)}`);
    }
    return csvFile('test-bench-run.csv', lines);
}

/** Three channels of a logger, for the phone figures. */
export function signalsCsv() {
    const rand = random(71);
    const lines = ['time,voltage,current,temperature'];
    for (let i = 0; i < 2000; i++) {
        const t = i / 100;
        lines.push(`${t.toFixed(2)},${(Math.sin(2 * Math.PI * 1.5 * t) * Math.exp(-t / 14) + 0.02 * noise(rand)).toFixed(5)},${(0.5 * Math.cos(2 * Math.PI * 0.4 * t) + 0.02 * noise(rand)).toFixed(5)},${(20 + t / 5).toFixed(3)}`);
    }
    return csvFile('logger-channels.csv', lines);
}
