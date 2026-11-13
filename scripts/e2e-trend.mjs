// End-to-end check of the Trend analysis on a file read in memory-saving
// (lazy) mode, where every row a segment reports comes from DuckDB and not
// from the overview in memory.
//
// The signal is known by hand: y = 5 while t < 1000 s, then a ramp of
// 0.02 per second — y = 5 + 0.02·(t − 1000) — and, in the flat part only, a
// spike of 50 every 1000th row.
//
//   · a segment over the flat part [10, 100] therefore has 9001 rows, of which
//     10 are spikes; with the value band at [0, 10] it has 8991 rows, a mean of
//     exactly 5, and the table says 10 outliers were left out;
//   · a segment over the ramp [1500, 2500] has a slope of 0.02 per second, an
//     R² of 1, a mean of 25 and a Δ of 20 across it.
//
// Driven through the panel the way a person does: the Analysis menu, the
// drawer's controls, the table's rows, and the band's dashed line moved all
// three ways it can be — the pointer, a finger, and the keys alone.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:trend`.
// OMV_SHOTS=<dir> also writes a picture of the panel.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROWS = 300001;
// `decay` is an exponential with a time constant of exactly 300 s, for the
// exponential trend: y = 2 + 8·e^(−t/300).
const lines = ['time,y,decay'];
for (let i = 0; i < ROWS; i++) {
    const t = i * 0.01;
    const flat = t < 1000;
    let y = flat ? 5 : 5 + 0.02 * (t - 1000);
    if (flat && i > 0 && i % 1000 === 0) y = 50;
    lines.push(`${t.toFixed(2)},${y.toFixed(6)},${(2 + 8 * Math.exp(-t / 300)).toFixed(6)}`);
}
const file = { name: 'lazy-trend.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const browser = await chromium.launch();
try {
    // Not a touch context: on a touch device the app offers its phone
    // layout, and this is the desktop panel. The finger below turns touch
    // on through the protocol once the panel is up.
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    // Small enough that this CSV opens in memory-saving mode.
    await page.evaluate(() => window.app._saveAdvancedSettings({ ...window.app.advancedSettings, csvFullLoadMb: 2 }));
    await page.setInputFiles('#file-input', [file]);
    await page.waitForFunction(() => [...window.app.plotManager.files.values()][0]?.data?._duckdb, null, { timeout: 120000 });

    const panelId = await page.evaluate(() => {
        const app = window.app;
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        const el = document.querySelector('.layout-panel');
        app.plotManager.addTrace(el.dataset.id, 'y', el);
        return el.dataset.id;
    });
    await page.waitForTimeout(800);
    // The memory-saving notice sits over the panel; it is read and dismissed.
    assert.match(
        await page.evaluate(() => document.querySelector('.dismissible-notice-body')?.textContent || ''),
        /memory-saving/,
        'the file opened in memory-saving mode',
    );
    await page.evaluate(() => document.querySelectorAll('.dismissible-notice').forEach(el => el.remove()));

    // ── The analysis opens from the Analysis menu ──
    await page.locator('.timeseries-analysis-menu-btn').first().click();
    await page.locator('.analysis-card.marks-item-trend').click();
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.trendTableEl, panelId, { timeout: 30000 });
    assert.equal(await page.evaluate(id => window.app.plotManager.plots.get(id).mode, panelId), 'trend');
    assert.equal(await page.locator('.trend-container .trend-table-wrap').count(), 1, 'the panel has its table pane');
    assert.equal(await page.locator('.trend-options').count(), 1, 'and its options drawer');

    const result = (index = 0) => page.evaluate(({ id, index }) => {
        const r = window.app.plotManager.plots.get(id)._trendResults?.[index];
        if (!r?.result) return { status: r?.lazyStatus ?? null };
        const { trend, delta, exp, band, range } = r.result;
        return {
            status: 'ok', range, band, delta,
            n: trend.n, nScope: trend.nScope, nOutliers: trend.nOutliers, nMissing: trend.nMissing,
            mean: trend.mean, std: trend.std, minY: trend.minY, maxY: trend.maxY,
            slope: trend.linear.b1, r2: trend.linear.r2, linearStatus: trend.linear.status,
            quadStatus: trend.quadratic?.status ?? null, quadA: trend.quadratic?.a ?? null,
            expStatus: exp?.status ?? null, expTau: exp?.timeConstant ?? null,
        };
    }, { id: panelId, index });
    const settled = (index = 0) => page.waitForFunction(({ id, index }) => {
        const plot = window.app.plotManager.plots.get(id);
        const r = plot?._trendResults?.[index];
        return !!r?.result && !document.querySelector(`.layout-panel[data-id="${id}"] .analysis-computing-indicator`);
    }, { id: panelId, index }, { timeout: 60000 });
    const setSegment = (patch) => page.evaluate(({ id, patch }) => window.app.plotManager._updateTrendSegment(id, patch), { id: panelId, patch });
    const setBand = async (which, value) => {
        await page.evaluate(({ which, value }) => {
            const input = document.querySelector(`.fft-number-input[data-trend-band-key="${which}"]`);
            input.value = String(value);
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }, { which, value });
        await page.waitForFunction(({ id, which, value }) => {
            const segment = window.app.plotManager.plots.get(id).trend.segments[0];
            return Math.abs(Number(segment[which]) - value) < 1e-9;
        }, { id: panelId, which, value }, { timeout: 15000 });
    };
    const tableRows = () => page.evaluate(() => [...document.querySelectorAll('.trend-table tbody tr')]
        .map(tr => ({ active: tr.classList.contains('trend-row-active'), cells: [...tr.querySelectorAll('td')].map(td => td.textContent) })));
    // The counts are grouped the way the locale groups them.
    const plain = (text) => String(text).replace(/[\s,\u00a0\u202f]/g, '');

    // ── The flat stretch: 9001 rows, 10 of them spikes ──
    await setSegment({ rangeFull: false, x1: 10, x2: 100 });
    await settled();
    let flat = await result();
    assert.equal(flat.nScope, 9001, 'every row of [10, 100] is read (not the overview)');
    assert.equal(flat.n, 9001, 'all of them have a value');
    assert.equal(flat.nOutliers, 0, 'with no band, nothing is left out');
    assert.equal(flat.maxY, 50, 'the spikes are in');
    assert.ok(Math.abs(flat.mean - (8991 * 5 + 10 * 50) / 9001) < 1e-9, `the mean carries them: ${flat.mean}`);

    // The table says the same thing.
    let rows = await tableRows();
    assert.equal(rows.length, 1, 'one row per segment');
    assert.equal(rows[0].cells[0].trim(), 'T1');
    assert.equal(plain(rows[0].cells[4]), '9001', 'the n column');
    assert.ok(rows[0].cells[5].startsWith('5.0'), `the mean column (${rows[0].cells[5]})`);

    // ── The value band leaves the spikes out ──
    await page.locator('.trend-band-box').check();
    await setBand('lower', 0);
    await setBand('upper', 10);
    await settled();
    flat = await result();
    assert.deepEqual(flat.band, { lower: 0, upper: 10 }, 'the band is what was typed');
    assert.equal(flat.n, 8991, 'the band dropped the ten spikes');
    assert.equal(flat.nOutliers, 10, 'and counted them');
    assert.equal(flat.mean, 5, 'what is left is exactly 5');
    assert.equal(flat.maxY, 5, 'and its extremes are inside the band');
    assert.equal(flat.std, 0, 'a flat stretch has no spread');
    rows = await tableRows();
    assert.equal(plain(rows[0].cells[4]), '8991(−10)', `the n column says what the band took out (${rows[0].cells[4]})`);
    // The band is drawn as two dashed lines across the segment.
    const bandShapes = await page.evaluate(id => (window.app.plotManager.plots.get(id).div.layout.shapes || [])
        .filter(shape => shape._trendBand).map(shape => ({ side: shape._trendBand, y: shape.y0, dash: shape.line?.dash })), panelId);
    assert.deepEqual(bandShapes.map(s => s.side).sort(), ['lower', 'upper'], 'both bounds are drawn');
    assert.ok(bandShapes.every(s => s.dash === 'dash'), 'as dashed lines');

    // ── Dragging the upper line raises the bound ──
    const dragUpper = await page.evaluate(id => {
        const plot = window.app.plotManager.plots.get(id);
        const div = plot.div;
        const fl = div._fullLayout;
        const box = div.getBoundingClientRect();
        const [lo, hi] = window.app.plotManager._trendRange(plot, plot.trend.segments[0]);
        const xMid = box.left + (fl.xaxis._offset || 0) + fl.xaxis.d2p((lo + hi) / 2);
        const yAt = (value) => box.top + (fl.yaxis._offset || 0) + fl.yaxis.d2p(value);
        return { x: xMid, from: yAt(10), to: yAt(30), value: 30 };
    }, panelId);
    await page.mouse.move(dragUpper.x, dragUpper.from);
    // The pointer over the line says it can be dragged up and down.
    const hint = await page.evaluate(id => {
        const div = window.app.plotManager.plots.get(id).div;
        return { ns: div.classList.contains('trend-cursor-ns'), classes: div.className };
    }, panelId);
    assert.equal(hint.ns, true, `the pointer over the band line offers to drag it (${hint.classes})`);
    await page.mouse.down();
    const grabbed = await page.evaluate(() => document.body.className);
    assert.match(grabbed, /fft-selection-dragging/, 'the press grabbed it');
    await page.mouse.move(dragUpper.x, dragUpper.to, { steps: 8 });
    await page.mouse.up();
    const draggedUpper = await page.evaluate(id => window.app.plotManager.plots.get(id).trend.segments[0].upper, panelId);
    assert.ok(draggedUpper > 20 && draggedUpper < 40, `the dragged bound follows the pointer (${draggedUpper})`);
    const shownUpper = await page.locator('.fft-number-input[data-trend-band-key="upper"]').inputValue();
    assert.ok(Math.abs(Number(shownUpper) - draggedUpper) < 1e-6, 'and the drawer shows the new bound');
    // The numbers follow the line that was dragged.
    await page.waitForFunction(({ id, upper }) => {
        const band = window.app.plotManager.plots.get(id)._trendResults?.[0]?.result?.band;
        return !!band && Math.abs(band.upper - upper) < 1e-9;
    }, { id: panelId, upper: draggedUpper }, { timeout: 60000 });
    const dragged = await result();
    assert.equal(dragged.n, 8991, 'the spikes, at 50, are still above the raised band');
    assert.equal(dragged.nOutliers, 10, 'so they are still counted out');

    // A bound above them takes nothing out.
    await setBand('upper', 60);
    await settled();
    const wide = await result();
    assert.equal(wide.n, 9001, 'with the band over the spikes, every row counts');
    assert.equal(wide.nOutliers, 0, 'and nothing is an outlier');

    // Back to the band that leaves the spikes out.
    await setBand('upper', 10);
    await settled();
    assert.equal((await result()).n, 8991, 'and back out again');

    // ── The same line, moved with the keys alone ──
    // Each bound has a handle on its line: a slider the keyboard can reach.
    const handle = (which) => page.locator(`.trend-band-handle[data-bound="${which}"]`);
    assert.equal(await handle('upper').count(), 1, 'the upper bound has a handle');
    assert.equal(await handle('lower').count(), 1, 'and so does the lower one');
    assert.equal(await handle('upper').getAttribute('role'), 'slider', 'announced as a slider');
    assert.equal(Number(await handle('upper').getAttribute('aria-valuenow')), 10, 'reading the bound it holds');
    await handle('upper').focus();
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.bound), 'upper', 'the handle takes the focus');
    const beforeKeys = await page.evaluate(id => window.app.plotManager.plots.get(id).trend.segments[0].upper, panelId);
    await page.keyboard.press('ArrowUp');
    const oneStep = await page.evaluate(id => window.app.plotManager.plots.get(id).trend.segments[0].upper, panelId);
    assert.ok(oneStep > beforeKeys, `an arrow moves the bound up (${beforeKeys} → ${oneStep})`);
    // The step is a hundredth of the value axis, so ten presses are a tenth.
    const step = oneStep - beforeKeys;
    await page.keyboard.press('Shift+ArrowUp');
    const shifted = await page.evaluate(id => window.app.plotManager.plots.get(id).trend.segments[0].upper, panelId);
    assert.ok(Math.abs((shifted - oneStep) - step * 10) < step * 0.01, `Shift moves ten steps (${shifted - oneStep} vs ${step * 10})`);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Shift+ArrowDown');
    assert.ok(Math.abs(await page.evaluate(id => window.app.plotManager.plots.get(id).trend.segments[0].upper, panelId) - beforeKeys) < step * 0.01,
        'and down again, back where it started');
    // The handle keeps the focus through all of it, so a key can be held.
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.bound), 'upper', 'the handle still has the focus');
    // The numbers follow the keys, as they follow the pointer.
    await page.waitForFunction(({ id, upper }) => {
        const band = window.app.plotManager.plots.get(id)._trendResults?.[0]?.result?.band;
        return !!band && Math.abs(band.upper - upper) < 1e-9;
    }, { id: panelId, upper: beforeKeys }, { timeout: 60000 });
    assert.equal((await result()).n, 8991, 'and the band is where it was, so the spikes are still out');
    // End takes it to the top of the axis, Home to the bottom.
    await page.keyboard.press('End');
    const atEnd = await page.evaluate(id => window.app.plotManager.plots.get(id).trend.segments[0].upper, panelId);
    const axis = await page.evaluate(id => {
        const range = window.app.plotManager.plots.get(id).div._fullLayout.yaxis.range;
        return { min: Math.min(...range), max: Math.max(...range) };
    }, panelId);
    assert.ok(Math.abs(atEnd - axis.max) < 1e-6, `End is the top of the value axis (${atEnd} vs ${axis.max})`);
    // Back to the band that leaves the spikes out, from the drawer's field,
    // where the arrows move the bound the same way.
    await setBand('upper', 10);
    await settled();
    await page.locator('.fft-number-input[data-trend-band-key="upper"]').focus();
    await page.keyboard.press('ArrowUp');
    const fromField = await page.evaluate(id => window.app.plotManager.plots.get(id).trend.segments[0].upper, panelId);
    assert.ok(Math.abs((fromField - 10) - step) < step * 0.01, `the field's arrows move it a step too (${fromField})`);
    // And the field keeps the focus, so the key can be pressed again.
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.trendBandKey), 'upper', 'the field still has the focus');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(({ id }) => {
        const band = window.app.plotManager.plots.get(id)._trendResults?.[0]?.result?.band;
        return !!band && Math.abs(band.upper - 10) < 1e-9;
    }, { id: panelId }, { timeout: 60000 });

    // ── And moved with a finger ──
    {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
        const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
            type,
            touchPoints: type === 'touchEnd' ? [] : [{ x, y }],
        });
        const spot = await page.evaluate(id => {
            const plot = window.app.plotManager.plots.get(id);
            const fl = plot.div._fullLayout;
            const box = plot.div.getBoundingClientRect();
            const [lo, hi] = window.app.plotManager._trendRange(plot, plot.trend.segments[0]);
            return {
                x: box.left + (fl.xaxis._offset || 0) + fl.xaxis.d2p((lo + hi) / 2),
                from: box.top + (fl.yaxis._offset || 0) + fl.yaxis.d2p(10),
                to: box.top + (fl.yaxis._offset || 0) + fl.yaxis.d2p(25),
            };
        }, panelId);
        await touch('touchStart', spot.x, spot.from);
        for (let i = 1; i <= 6; i++) {
            await touch('touchMove', spot.x, spot.from + (spot.to - spot.from) * (i / 6));
            await page.waitForTimeout(16);
        }
        await touch('touchEnd');
        const byFinger = await page.evaluate(id => window.app.plotManager.plots.get(id).trend.segments[0].upper, panelId);
        assert.ok(byFinger > 18 && byFinger < 32, `a finger drags the line too (${byFinger})`);
        await setBand('upper', 10);
        await settled();
    }

    // ── A second segment over the ramp ──
    await page.locator('.trend-add-btn').click();
    await page.waitForFunction(id => window.app.plotManager.plots.get(id).trend.segments.length === 2, panelId);
    await setSegment({ rangeFull: false, x1: 1500, x2: 2500 });
    await settled(1);
    const ramp = await result(1);
    assert.equal(ramp.nScope, 100001, 'every row of [1500, 2500]');
    assert.ok(Math.abs(ramp.slope - 0.02) < 1e-9, `the slope of the ramp, per second (${ramp.slope})`);
    assert.ok(ramp.r2 > 0.999999, `a straight line (R² ${ramp.r2})`);
    assert.ok(Math.abs(ramp.mean - 25) < 1e-6, `the mean of the ramp (${ramp.mean})`);
    assert.ok(Math.abs(ramp.delta - 20) < 1e-6, `what the trend accounts for across it (${ramp.delta})`);
    assert.equal(ramp.quadStatus, 'ok', 'the parabola is computed too');
    assert.ok(Math.abs(ramp.quadA) < 1e-9, 'and it is flat: a straight stretch has no curvature');
    rows = await tableRows();
    assert.equal(rows.length, 2, 'two rows now');
    assert.equal(rows[1].active, true, 'the new segment is the one being worked on');
    assert.ok(rows[1].cells[7].includes('0.02'), `the slope column (${rows[1].cells[7]})`);

    // ── The curves drawn over the signal ──
    const curves = await page.evaluate(id => (window.app.plotManager.plots.get(id).div.data || [])
        .filter(trace => trace.meta?.trendIndex !== undefined)
        .map(trace => ({ index: trace.meta.trendIndex, kind: trace.meta.trendCurve, points: trace.x?.length || 0 })), panelId);
    assert.deepEqual(curves.map(c => `${c.index}:${c.kind}`).sort(),
        ['0:linear', '0:mean', '1:linear', '1:mean'], 'the mean and the line of each segment are drawn');
    assert.ok(curves.every(c => c.points >= 2), 'each with points to draw');

    // Turning the parabola on draws it as well.
    await page.locator('.trend-curves-block input[data-trend-curve="quadratic"]').check();
    await page.waitForFunction(id => (window.app.plotManager.plots.get(id).div.data || [])
        .some(trace => trace.meta?.trendCurve === 'quadratic'), panelId, { timeout: 15000 });

    // ── The exponential, asked for on this segment ──
    // On `decay`, whose time constant is 300 s by construction.
    await page.evaluate(id => {
        const el = document.querySelector(`.layout-panel[data-id="${id}"]`);
        window.app.plotManager.addTrace(id, 'decay', el);
    }, panelId);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id).traces.length === 2, panelId, { timeout: 15000 });
    await setSegment({ varName: 'decay', x1: 100, x2: 1500 });
    await settled(1);
    await page.locator('.trend-exp-select').selectOption('exponential-offset');
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)._trendResults?.[1]?.result?.exp?.status === 'ok',
        panelId, { timeout: 60000 });
    await settled(1);
    const withExp = await result(1);
    assert.equal(withExp.expStatus, 'ok', 'the exponential was fitted over the file');
    assert.ok(Math.abs(withExp.expTau - 300) < 1, `and its time constant is the one built in (${withExp.expTau} s)`);
    rows = await tableRows();
    assert.ok(plain(rows[1].cells[11]).startsWith('300'), `τ is in the table (${rows[1].cells[11]})`);
    assert.notEqual(rows[1].cells[12], '—', 'and so is its R²');
    await page.locator('.trend-exp-select').selectOption('none');
    await settled(1);

    // ── Clicking a row picks that segment ──
    await page.locator('.trend-table tbody tr').first().click();
    assert.equal(await page.evaluate(id => window.app.plotManager.plots.get(id).trend.activeSegment, panelId), 0, 'the first row selects the first segment');
    rows = await tableRows();
    assert.equal(rows[0].active, true, 'and the table says which one it is');

    // ── Dragging the segment's edge changes what it reads ──
    const edge = await page.evaluate(id => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const fl = plot.div._fullLayout;
        const box = plot.div.getBoundingClientRect();
        const [, hi] = pm._trendRange(plot, plot.trend.segments[0]);
        const xAt = (value) => box.left + (fl.xaxis._offset || 0) + fl.xaxis.d2p(value);
        const yMid = box.top + (fl.yaxis._offset || 0) + (fl.yaxis._length || 200) / 2;
        return { from: xAt(hi), to: xAt(hi + 400), y: yMid };
    }, panelId);
    await page.mouse.move(edge.from, edge.y);
    await page.mouse.down();
    await page.mouse.move(edge.to, edge.y, { steps: 10 });
    await page.mouse.up();
    const movedEnd = await page.evaluate(id => window.app.plotManager.plots.get(id).trend.segments[0].x2, panelId);
    assert.ok(movedEnd > 300, `the segment's end followed the pointer (${movedEnd})`);
    await page.waitForFunction(({ id, end }) => {
        const range = window.app.plotManager.plots.get(id)._trendResults?.[0]?.result?.range;
        return !!range && Math.abs(range[1] - end) < 1e-6;
    }, { id: panelId, end: movedEnd }, { timeout: 60000 });
    const moved = await result();
    assert.ok(moved.nScope > 9001, 'and it now reads more rows of the file');

    // ── The controls say what they are ──
    {
        // The band's seed: a number and a button said neither what "3" was nor
        // what pressing it would do.
        const sigma = page.locator('.trend-band-sigma');
        assert.ok((await sigma.locator('.trend-band-sigma-label').innerText()).trim(), 'the σ row is labelled');
        assert.equal((await sigma.locator('.trend-band-sigma-unit').innerText()).trim(), 'σ', 'and the number is in σ');
        assert.ok((await page.locator('.trend-band-hint').innerText()).trim().length > 40, 'with a line saying what it does to the result');
        assert.notEqual((await sigma.locator('.trend-sigma-btn').innerText()).trim(), '± σ', 'the button says what it does');

        // The analysis help is by the numbers it explains, not by the signal
        // picker, where it read as help about choosing a signal.
        const signalRow = page.locator('.trend-options .phase2d-fit-field', { hasText: 'Signal' }).first();
        assert.equal(await signalRow.locator('.fft-help-btn').count(), 0, 'no help button beside the signal');
        assert.equal(await page.locator('.trend-result .phase2d-fit-results-head .fft-help-btn').count(), 1,
            'the block of numbers carries it');

        // The exponential menu explains itself, with the four shapes drawn.
        const expHelp = page.locator('.trend-options .phase2d-fit-field', { hasText: 'Exponential' }).locator('.fft-help-btn');
        assert.equal(await expHelp.count(), 1, 'the exponential menu has its own help');
        await expHelp.click();
        await page.waitForSelector('.trend-exp-gallery');
        const cards = page.locator('.trend-exp-card');
        assert.equal(await cards.count(), 4, 'one card per model');
        assert.equal(await page.locator('.trend-exp-card .trend-exp-art .art-line').count(), 4, 'each with its shape drawn');
        const captions = await cards.locator('figcaption').allInnerTexts();
        assert.ok(captions.every(text => text.includes('y =')), `each with its equation (${captions.join(' | ')})`);
        if (process.env.OMV_SHOTS) {
            await page.locator('.modal-dialog-help').screenshot({ path: `${process.env.OMV_SHOTS}/trend-exp-help.png` });
        }
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.querySelector('.trend-exp-gallery'));
    }

    // ── The table as CSV ──
    const csv = await page.evaluate(id => {
        const pm = window.app.plotManager;
        const out = pm._trendSummaryCsv(pm.plots.get(id));
        return { headers: out.headers, rows: out.columns[0].length, mean: out.columns[out.headers.indexOf('mean')] };
    }, panelId);
    assert.ok(csv.headers.includes('mean') && csv.headers.includes('linear_slope') && csv.headers.includes('n_outliers'),
        'the CSV carries the numbers of the table');
    assert.equal(csv.rows, 2, 'one line per segment');

    if (process.env.OMV_SHOTS) {
        await page.locator(`.layout-panel[data-id="${panelId}"]`).screenshot({ path: `${process.env.OMV_SHOTS}/trend-panel.png` });
        await page.locator('.trend-options').screenshot({ path: `${process.env.OMV_SHOTS}/trend-drawer.png` });
        await page.locator('.trend-table-pane').screenshot({ path: `${process.env.OMV_SHOTS}/trend-table.png` });
        await page.locator('.trend-table tbody tr').first().click();
        await page.waitForTimeout(400);
        await page.locator(`.layout-panel[data-id="${panelId}"] .fft-time-pane`).screenshot({ path: `${process.env.OMV_SHOTS}/trend-band.png` });
    }

    // Nothing was logged as an error along the way.
    assert.deepEqual(errors, [], 'no page errors');
    console.log('trend analysis e2e: ok');
} finally {
    await browser.close();
    await server.close();
}
