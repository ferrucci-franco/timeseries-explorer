// End-to-end check of the numbers in the hover boxes, in a real browser.
//
// Every hover number is written by one rule (utils/readout-format.js): four
// significant digits, plain decimals between 0.01 and 10 000, an SI prefix
// glued to the unit outside that band, never an exponent; an abscissa keeps
// the digits its resolution needs. The readout is written from the x/y the
// trace is drawn with, in src/vendor/plotly.js, so this checks it where it can
// go wrong: on the box Plotly actually shows, after a zoom has redrawn the
// trace, in the spectrum, and with the decimal comma from Settings.
//
// Scenario: a 10 ms record sampled every 5 µs, a 1 kHz sine of 3 mV amplitude
// in volts. The time series reads "Time = 627.4 µs"-style times and mV
// values; a zoom redraws the trace and the box reads the new points; the
// spectrum reads its frequency, period and amplitude the same way; with a
// decimal comma the box follows.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:hover-readout`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROWS = 2000;
const DT = 5e-6;

function makeCsv() {
    const lines = ['time [s],signal [V]'];
    for (let i = 0; i < ROWS; i++) {
        const t = i * DT;
        lines.push(`${t.toPrecision(10)},${(0.003 * Math.sin(2 * Math.PI * 1000 * t)).toPrecision(10)}`);
    }
    return { name: 'small.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

// "Time = 4.01 ms" → 0.00401: a readout back to a number in the base unit.
const PREFIX = { n: 1e-9, 'µ': 1e-6, m: 1e-3, '': 1, k: 1e3 };
function readBack(text, label, unit) {
    const match = new RegExp(`${label} = (−?[\\d.,]+) (n|µ|m|k|)${unit}(?![A-Za-z])`).exec(text);
    if (!match) return null;
    return Number(match[1].replace('−', '-').replace(',', '.')) * PREFIX[match[2]];
}

// Hover one point of a trace and read the box Plotly drew.
const hoverText = (page, panelId, divKey, curveNumber, pointNumber) => page.evaluate(({ id, divKey, curveNumber, pointNumber }) => {
    const div = window.app.plotManager.plots.get(id)[divKey];
    const point = div.data[curveNumber];
    // A WebGL trace (the spectrum) answers a hover by position, not by index.
    if (String(div._fullData?.[curveNumber]?.type).endsWith('gl')) {
        window.Plotly.Fx.hover(div, { xval: Number(point.x[pointNumber]), yval: Number(point.y[pointNumber]) });
    } else {
        window.Plotly.Fx.hover(div, [{ curveNumber, pointNumber }]);
    }
    // One line per tspan: textContent alone runs "4.01 ms" into the next line.
    const text = [...div.querySelectorAll('.hoverlayer .hovertext')].map(node => {
        const lines = [...node.querySelectorAll('tspan.line')].map(line => line.textContent);
        return lines.length ? lines.join('\n') : node.textContent;
    }).join(' | ');
    const trace = div.data[curveNumber];
    return { text, x: Number(trace.x[pointNumber]), y: Number(trace.y[pointNumber]), template: trace.hovertemplate };
}, { id: panelId, divKey, curveNumber, pointNumber });

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
// Set to a folder to keep a screenshot of each box checked.
const shots = process.env.HOVER_READOUT_SHOTS;
const shoot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    const panelId = await page.evaluate(() => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        const variables = Object.keys(app.plotManager.files.values().next().value.data.variables);
        const signal = variables.find(name => name.startsWith('signal'));
        app.plotManager.addTrace(panelEl.dataset.id, signal, panelEl);
        return panelEl.dataset.id;
    });
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0, panelId);
    await page.waitForTimeout(300);

    // ── Time series ──
    const first = await hoverText(page, panelId, 'div', 0, 50);
    await shoot(page, 'time-series');
    assert.ok(first.text, 'the hover box is drawn');
    assert.ok(first.template.includes('%{hovertext}'), `the time series hovers through the readout (${first.template})`);
    assert.doesNotMatch(first.text, /\d[eE][-+]?\d/, `no exponent in the box: ${first.text}`);
    assert.doesNotMatch(first.text, /0\.000/, `no run of leading zeros in the box: ${first.text}`);
    assert.match(first.text, /Time = [\d.]+ µs/, `a time under 10 ms reads in µs: ${first.text}`);
    assert.match(first.text, /= −?[\d.]+ mV/, `a millivolt value reads in mV: ${first.text}`);
    // The box tells the very point hovered: its time, to the 5 µs step.
    const microseconds = Number(/Time = ([\d.]+) µs/.exec(first.text)[1]);
    assert.ok(Math.abs(microseconds * 1e-6 - first.x) < DT / 2, `the time read is the point's (${microseconds} µs vs ${first.x} s)`);
    const millivolts = Number(/= (−?[\d.]+) mV/.exec(first.text)[1].replace('−', '-'));
    assert.ok(Math.abs(millivolts * 1e-3 - first.y) <= Math.abs(first.y) * 1e-3 + 1e-9,
        `the value read is the point's (${millivolts} mV vs ${first.y} V)`);

    // ── A zoom redraws the trace; the box must read the new points ──
    await page.evaluate(id => window.Plotly.relayout(window.app.plotManager.plots.get(id).div,
        { 'xaxis.range': [0.004, 0.0041] }), panelId);
    await page.waitForTimeout(800);
    const zoomed = await hoverText(page, panelId, 'div', 0, 3);
    assert.ok(zoomed.x >= 0.0039 && zoomed.x <= 0.0042, `the zoom redrew the trace (${zoomed.x})`);
    assert.match(zoomed.text, /Time = 4[\d.]* ms/, `4 ms reads in ms: ${zoomed.text}`);
    assert.ok(Math.abs(readBack(zoomed.text, 'Time', 's') - zoomed.x) < DT / 2,
        `after the zoom the box reads the new point's time (${zoomed.text} vs x = ${zoomed.x})`);
    assert.ok(Math.abs(readBack(zoomed.text, 'signal', 'V') - zoomed.y) <= Math.abs(zoomed.y) * 1e-3 + 1e-12,
        `and its value (${zoomed.text} vs y = ${zoomed.y})`);

    // ── Spectrum ──
    await page.evaluate(id => window.app.plotManager._requestModeChange(id, 'fft'), panelId);
    await page.waitForFunction(id => (window.app.plotManager.plots.get(id)?.fftDiv?.data || [])
        .some(trace => trace?._hoverReadout && trace.x?.length > 10), panelId, { timeout: 30000 });
    await page.waitForTimeout(500);
    const spectrum = await page.evaluate((id) => {
        const div = window.app.plotManager.plots.get(id).fftDiv;
        const curveNumber = div.data.findIndex(trace => trace?._hoverReadout);
        const trace = div.data[curveNumber];
        // The peak: the bin nearest 1 kHz.
        let best = 0;
        for (let i = 0; i < trace.y.length; i++) if (Number(trace.y[i]) > Number(trace.y[best])) best = i;
        return { curveNumber, pointNumber: best };
    }, panelId);
    const peak = await hoverText(page, panelId, 'fftDiv', spectrum.curveNumber, spectrum.pointNumber);
    await shoot(page, 'spectrum');
    assert.doesNotMatch(peak.text, /\d[eE][-+]?\d/, `no exponent in the spectrum box: ${peak.text}`);
    assert.match(peak.text, /Period = [\d.]+ (ms|µs)/, `the period of a ~1 kHz bin reads in ms or µs: ${peak.text}`);
    assert.match(peak.text, /Amplitude = [\d.]+ m\b/, `a millivolt amplitude reads with an m prefix: ${peak.text}`);
    assert.match(peak.text, /Frequency = [\d.]+ Hz/, `the frequency reads in Hz: ${peak.text}`);
    const hertz = Number(/Frequency = ([\d.]+) Hz/.exec(peak.text)[1]);
    assert.ok(Math.abs(hertz - peak.x) < 1, `the frequency read is the bin's (${hertz} vs ${peak.x})`);

    // ── Decimal comma ──
    await page.evaluate(() => {
        const app = window.app;
        app.advancedSettings = { ...(app.advancedSettings || {}), decimalSeparator: 'comma' };
        app._applyNumberFormat();
    });
    await page.evaluate(id => window.app.plotManager._requestModeChange(id, 'timeseries'), panelId);
    await page.waitForFunction(id => (window.app.plotManager.plots.get(id)?.div?.data || [])
        .some(trace => trace?._hoverReadout), panelId, { timeout: 30000 });
    await page.waitForTimeout(500);
    const comma = await hoverText(page, panelId, 'div', 0, 7);
    await shoot(page, 'decimal-comma');
    if (shots) console.log([first.text, zoomed.text, peak.text, comma.text].join('\n---\n'));
    assert.match(comma.text, /Time = \d+,\d+ [µm]s/, `the time follows the decimal comma: ${comma.text}`);
    assert.doesNotMatch(comma.text, /\d\.\d/, `no decimal point left in the box: ${comma.text}`);

    assert.deepEqual(errors, [], `no page errors: ${errors.join('; ')}`);
    console.log('Hover readout e2e checks passed.');
} finally {
    await browser.close();
    await server.close();
}
