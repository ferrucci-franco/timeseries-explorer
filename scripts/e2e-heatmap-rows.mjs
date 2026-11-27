// End-to-end check of the Heatmap's Day x hour rows in a real browser.
//
// Two signals sampled every three hours over a month — what a reanalysis grid
// (the ERA5 example that ships with the app) writes. Two things the picture
// has to get right, both reported from that file:
//
//   · the grid's row follows the sampling step. An hour-tall row on 3 h data
//     leaves two empty rows for every row of data, and the reader sees stripes
//     that are not in the signal. Automatically it is 3 h and every row is
//     full; asked for by hand it is whatever was asked for, including finer
//     than the step, and the Y axis says which.
//   · no two tick labels overlap, whatever the row height and however short
//     the pane. Measured on the labels the browser actually drew, for the Y
//     axis of each stacked heatmap and for the dates along the bottom.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:heatmap-rows`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const STEP_MS = 3 * 3600_000;
const START = Date.UTC(2024, 7, 1);
const SAMPLES = 248; // August 2024, every three hours

function makeCsv() {
    const lines = ['time,d2m,tcc'];
    for (let i = 0; i < SAMPLES; i++) {
        const stamp = new Date(START + i * STEP_MS).toISOString().slice(0, 19).replace('T', ' ');
        lines.push(`${stamp},${(275 + 8 * Math.sin(i / 7)).toFixed(3)},${(0.5 + 0.5 * Math.sin(i / 3)).toFixed(3)}`);
    }
    return { name: 'era5-like.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

// What the drawn figure says: the grids, and the labels the browser laid out.
const readHeatmap = page => page.evaluate(() => {
    const panelId = document.querySelector('.layout-panel').dataset.id;
    const pm = window.app.plotManager;
    const plot = pm.plots.get(panelId);
    const boxes = selector => [...plot.heatmapDiv.querySelectorAll(selector)]
        .map((node) => {
            const rect = node.getBoundingClientRect();
            return { text: node.textContent, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
        })
        .filter(box => box.text.trim());
    const subplots = [...plot.heatmapDiv.querySelectorAll('.subplot')].map(node => node.id || '');
    return {
        models: (plot._calendarHeatmapModels || []).map(model => ({
            rows: model.grid.z.length,
            columns: model.grid.z[0]?.length || 0,
            rowStepMs: model.grid.meta.rowStepMs,
            rowStepAuto: model.grid.meta.rowStepAuto,
            emptyRows: model.grid.z.filter(row => row.every(value => value == null)).length,
            nullCells: model.grid.z.flat().filter(value => value == null).length,
        })),
        xTitle: plot.heatmapDiv._fullLayout?.xaxis?.title?.text || '',
        yTicks: boxes('.ytick text'),
        y2Ticks: boxes('.yaxislayer-above .ytick text, .overaxes-above .ytick text'),
        xTicks: boxes('.xtick text'),
        tickAngle: Number(plot.heatmapDiv._fullLayout?.xaxis?.tickangle) || 0,
        // The drawn Y range of each stacked subplot, reversed (row 0 on top).
        yRanges: ['yaxis', 'yaxis2']
            .map(key => plot.heatmapDiv._fullLayout?.[key]?.range)
            .filter(Boolean)
            .map(range => range.slice()),
        subplots,
        status: plot.heatmapContainer?.querySelector('.heatmap-status, .fft-status')?.textContent || '',
        // The warnings themselves live in the options drawer's message box;
        // the status line under the plot only points at it.
        message: plot.heatmapContainer?.querySelector('.heatmap-message')?.textContent || '',
    };
});

// Every row of the grid is inside the axis the figure drew. A changed row
// height is a changed axis, and a Plotly `uirevision` that did not say so
// would keep the previous range and show a slice of the new grid.
function assertEveryRowDrawn(view, rows, label) {
    assert.equal(view.yRanges.length, 2, `${label}: both subplots have a Y axis`);
    for (const range of view.yRanges) {
        const low = Math.min(...range);
        const high = Math.max(...range);
        assert.ok(low <= -0.5 + 1e-9 && high >= rows - 0.5 - 1e-9,
            `${label}: the axis [${low}, ${high}] leaves out rows of a ${rows}-row grid`);
    }
}

// Labels on one axis never share a line of pixels with their neighbour.
//
// Upright, that is the gap between one label's box and the next one's. Tilted
// (the Heatmap writes its dates at -35 degrees so they fit), the boxes of two
// labels do overlap horizontally while the text does not: what keeps them
// apart is the distance across the tilt, so that is what is measured.
function assertNoOverlap(boxes, axis, label, tickAngle = 0) {
    const sorted = boxes.slice().sort((a, b) => (axis === 'y' ? a.top - b.top : a.left - b.left));
    const tilt = Math.abs(Number(tickAngle) || 0);
    const across = axis === 'x' && tilt > 1 ? Math.sin((tilt * Math.PI) / 180) : 0;
    for (let i = 1; i < sorted.length; i++) {
        const previous = sorted[i - 1];
        const current = sorted[i];
        if (across) {
            const centre = box => (box.left + box.right) / 2;
            const separation = (centre(current) - centre(previous)) * across;
            assert.ok(
                separation >= 13,
                `${label}: "${previous.text}" and "${current.text}" are ${separation.toFixed(1)} px apart across the tilt`,
            );
            continue;
        }
        const gap = axis === 'y' ? current.top - previous.bottom : current.left - previous.right;
        assert.ok(
            gap >= -0.5,
            `${label}: "${previous.text}" and "${current.text}" overlap by ${(-gap).toFixed(1)} px`,
        );
    }
}

const setRowStep = (page, patch) => page.evaluate((state) => {
    const panelId = document.querySelector('.layout-panel').dataset.id;
    const pm = window.app.plotManager;
    const plot = pm.plots.get(panelId);
    Object.assign(plot.heatmap, state);
    pm._renderCalendarHeatmapOptionsPanel(panelId, plot);
    pm._scheduleCalendarHeatmapRecompute(panelId, { immediate: true });
}, patch);

const settled = async (page) => {
    await page.waitForFunction(() => {
        const panelId = document.querySelector('.layout-panel').dataset.id;
        const plot = window.app.plotManager.plots.get(panelId);
        return plot?.heatmapContainer?.getAttribute('aria-busy') === 'false'
            && (plot?._calendarHeatmapModels || []).length === 2;
    }, null, { timeout: 60000 });
    await page.waitForTimeout(350);
};

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    // A deliberately short window: two stacked heatmaps leave each subplot a
    // couple of hundred pixels, which is where the labels used to collide.
    const context = await browser.newContext({ viewport: { width: 1100, height: 760 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    await page.evaluate(() => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        app.plotManager.addTrace(panelEl.dataset.id, 'd2m', panelEl);
        app.plotManager.addTrace(panelEl.dataset.id, 'tcc', panelEl);
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => {
        const panelEl = document.querySelector('.layout-panel');
        window.app.plotManager._setMode(panelEl.dataset.id, 'heatmap', null, { preserveTimeTraces: true });
    });
    await settled(page);

    // Day x hour, left to itself.
    await setRowStep(page, { calendarMode: 'day-hour', rowStepMode: 'auto' });
    await settled(page);
    const auto = await readHeatmap(page);
    assert.equal(auto.models.length, 2, 'both signals have a grid');
    for (const model of auto.models) {
        assert.equal(model.rowStepMs, STEP_MS, 'a row is the 3 h sampling step');
        assert.equal(model.rows, 8, 'eight rows a day');
        assert.equal(model.columns, 31, 'a column per day of August');
        assert.equal(model.rowStepAuto, true, 'the height was counted from the data');
        assert.equal(model.emptyRows, 0, 'no row of the grid is empty');
        assert.equal(model.nullCells, 0, 'and no cell inside it either');
    }
    assert.match(auto.xTitle, /3\s*h/, 'the axis says what the grid is');
    assert.ok(auto.yTicks.length >= 4, 'the hours of the day are labelled');
    assert.ok(auto.yTicks.some(tick => tick.text.trim() === '00:00'), 'from midnight');
    assert.ok(
        auto.yTicks.every(tick => /^\d{2}:\d{2}$/.test(tick.text.trim())),
        'every row label is a clock time',
    );
    assertEveryRowDrawn(auto, 8, 'Day x 3 h');
    assertNoOverlap(auto.yTicks, 'y', 'Day x 3 h row labels');
    assertNoOverlap(auto.xTicks, 'x', 'Day x 3 h date labels', auto.tickAngle);

    // Asked for by hand: the hour, which is the grid that leaves the stripes.
    // Honest, and asked for — but its 24 labels must still be readable.
    await setRowStep(page, { rowStepMode: 'fixed', rowStepMinutes: 60 });
    await settled(page);
    const hourly = await readHeatmap(page);
    for (const model of hourly.models) {
        assert.equal(model.rows, 24, 'an hourly row was asked for and given');
        assert.equal(model.emptyRows, 16, 'two rows in three are empty, as the data leaves them');
    }
    assertEveryRowDrawn(hourly, 24, '24 hourly rows');
    assertNoOverlap(hourly.yTicks, 'y', '24 hourly row labels');
    assert.ok(hourly.yTicks.length < 24, 'not all 24 are drawn in a short subplot');
    // The cells the data cannot fill are reported once for the grid, not once
    // per signal: behind each signal's name (an extraction carries its
    // coordinates) the same sentence three times was a paragraph nobody reads.
    const coarseLine = 'Some cells are empty';
    const coarseCount = hourly.message.split(coarseLine).length - 1;
    assert.equal(coarseCount, 1, `the empty cells are reported once, not per signal (${hourly.message})`);
    assert.ok(
        !new RegExp(`d2m[^|]*${coarseLine}`).test(hourly.message),
        'and with no signal name in front of it',
    );

    // Finer than the step: 96 rows of a quarter of an hour.
    await setRowStep(page, { rowStepMode: 'fixed', rowStepMinutes: 15 });
    await settled(page);
    const quarter = await readHeatmap(page);
    for (const model of quarter.models) assert.equal(model.rows, 96, '96 quarter-hour rows');
    assertEveryRowDrawn(quarter, 96, '96 quarter-hour rows');
    assertNoOverlap(quarter.yTicks, 'y', '96 quarter-hour row labels');
    assert.ok(quarter.yTicks.length <= 24, 'and only as many labels as the subplot can hold');

    // A height that does not divide the day is rounded to one that does, and
    // the box says so rather than showing a value the grid is not using.
    await page.evaluate(() => {
        const input = document.querySelector('[data-heatmap-row-step-minutes]');
        input.value = '100';
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settled(page);
    const snapped = await readHeatmap(page);
    const shownMinutes = await page.evaluate(() => document.querySelector('[data-heatmap-row-step-minutes]').value);
    assert.equal(shownMinutes, '96', '100 minutes rounds to 96, which divides the day');
    for (const model of snapped.models) {
        assert.equal(model.rows, 15, '96-minute rows tile the day exactly');
    }
    assertEveryRowDrawn(snapped, 15, '96-minute rows');
    assertNoOverlap(snapped.yTicks, 'y', '96-minute row labels');

    // Week x day keeps its seven weekday rows whatever the sampling step.
    await setRowStep(page, { calendarMode: 'week-day', rowStepMode: 'auto' });
    await settled(page);
    const week = await readHeatmap(page);
    for (const model of week.models) assert.equal(model.rows, 7, 'a week is seven days');
    assertNoOverlap(week.yTicks, 'y', 'weekday labels');
    assertNoOverlap(week.xTicks, 'x', 'ISO week labels', week.tickAngle);

    assert.deepEqual(errors, [], 'no page error');
    console.log('e2e heatmap rows: a 3 h file gets 3 h rows with no empty row; every row label readable at 8, 15, 24 and 96 rows');
} finally {
    await browser.close();
    await server.close();
}
