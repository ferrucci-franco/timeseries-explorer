// End-to-end check of calendar-period aggregation in a real browser
// (docs/calendar-period-aggregation.md): the Integral analysis grouped by a
// calendar period, and the Temporal profile's `Multi-year` period.
//
// One file, calendar time, daily samples over three whole years, two signals:
//   rain  — 1 mm/day in 2019, 2 in 2020, 3 in 2021, so the yearly accumulation
//           is 365, 732 and 1095 mm·d and the yearly MEAN is 1, 2 and 3 mm.
//           Both numbers are known by hand, which is the point: a snapshot of
//           the implementation would re-baseline a wrong answer.
//   drizzle — half of rain, so the two bars of a period are always 2:1.
//
// Checks: the Group by control appears and splits the bars into one column per
// year per signal; the columns carry the hand-computed accumulations; they sum
// to the ungrouped total; Order is disabled while the columns are a timeline;
// the profile's Multi-year period plots one point per calendar year with the
// year on the axis and the mean of the daily means as its value.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:calendar-periods`.
// Not part of test:release, which stays offline and browser-free.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const DAY = 86_400_000;
const YEARS = [2019, 2020, 2021];
// 2020 is a leap year, which is exactly why the accumulations differ from a
// flat 365 × level: a per-period total has to follow the calendar.
const DAYS_IN_YEAR = { 2019: 365, 2020: 366, 2021: 365 };
const LEVEL = { 2019: 1, 2020: 2, 2021: 3 };

function makeCsv() {
    const lines = ['time,rain [mm],drizzle [mm]'];
    for (let t = Date.UTC(2019, 0, 1); t < Date.UTC(2022, 0, 1); t += DAY) {
        const level = LEVEL[new Date(t).getUTCFullYear()];
        lines.push(`${new Date(t).toISOString()},${level},${level / 2}`);
    }
    return { name: 'rain.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

// Read the live chart and the live presentation, so the assertions are about
// what the panel actually drew rather than about a recomputation of it.
async function integralState(page, panelId) {
    return page.evaluate((id) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const view = pm._integralPresentation(plot, plot._integralModels || []);
        const options = pm._integralOptionsPanel(plot);
        const selects = [...options.querySelectorAll('select')];
        const labelOf = (select) => select.closest('label')?.querySelector('span')?.textContent || '';
        return {
            grouped: view.grouped,
            groupBy: view.groupBy,
            categories: view.categories,
            axisUnit: view.axisUnit,
            series: view.series.map(entry => ({
                name: entry.model.name,
                unit: entry.unit,
                values: entry.points.map(point => point.value),
                means: entry.points.map(point => point.mean),
            })),
            totals: view.rows.map(row => ({ name: row.model.name, value: row.value })),
            traceCount: plot.integralDiv.data.length,
            traceNames: plot.integralDiv.data.map(trace => trace.name),
            barX: plot.integralDiv.data.map(trace => trace.x),
            barText: plot.integralDiv.data.map(trace => trace.text || null),
            barmode: plot.integralDiv.layout.barmode,
            categoryAxisTitle: plot.integralDiv.layout.xaxis?.title?.text || '',
            valueAxisTitle: plot.integralDiv.layout.yaxis?.title?.text || '',
            status: plot.integralContainer.querySelector('.hist-status')?.textContent || '',
            summaryPeriods: [...options.querySelectorAll('.integral-summary-table tbody tr td:first-child')]
                .map(cell => cell.textContent.trim()),
            selectLabels: selects.map(labelOf),
            disabledSelects: selects.filter(select => select.disabled).map(labelOf),
        };
    }, panelId);
}

async function setIntegralOption(page, panelId, labelText, value) {
    await page.evaluate(({ id, labelText: label, value: next }) => {
        const pm = window.app.plotManager;
        const options = pm._integralOptionsPanel(pm.plots.get(id));
        const select = [...options.querySelectorAll('select')].find(candidate =>
            candidate.closest('label')?.querySelector('span')?.textContent === label);
        if (!select) throw new Error(`no select labelled ${label}`);
        select.value = next;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }, { id: panelId, labelText, value });
    await page.waitForTimeout(700);
}

async function profileState(page, panelId) {
    return page.evaluate((id) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const model = (plot._temporalProfileModels || [])[0];
        const layout = plot.temporalProfileDiv.layout;
        return {
            period: plot.temporalProfile.period,
            binYears: model?.result?.binYears || null,
            absoluteBins: !!model?.result?.absoluteBins,
            means: (model?.result?.categories?.[0]?.bins || []).map(bin => bin.mean),
            nPeriods: (model?.result?.categories?.[0]?.bins || []).map(bin => bin.nPeriods),
            ticktext: layout.xaxis?.ticktext || null,
            xAxisTitle: layout.xaxis?.title?.text || '',
            yAxisTitle: layout.yaxis?.title?.text || '',
            plottedX: plot.temporalProfileDiv.data.map(trace => trace.x?.length || 0),
        };
    }, panelId);
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const shots = process.env.CALENDAR_PERIOD_SHOTS;
try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', event => errors.push(event.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    const panelId = await page.evaluate(() => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        app.plotManager.addTrace(panelEl.dataset.id, 'rain', panelEl);
        app.plotManager.addTrace(panelEl.dataset.id, 'drizzle', panelEl);
        return panelEl.dataset.id;
    });
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.div?._fullLayout?.xaxis?._length > 0, panelId);

    // ── Integral, ungrouped ──
    await page.evaluate(id => window.app.plotManager._toggleTimeseriesAnalysisMode(id, 'integral'), panelId);
    await page.waitForFunction(id => window.app.plotManager.plots.get(id)?.integralDiv?.data?.length === 1, panelId, { timeout: 30000 });
    let integral = await integralState(page, panelId);
    assert.equal(integral.grouped, false, 'the panel opens with one total per signal');
    assert.ok(integral.selectLabels.includes('Group by'), `the Group by control is offered (${integral.selectLabels.join(', ')})`);
    assert.deepEqual(integral.disabledSelects, [], 'and nothing is disabled on a calendar axis');

    // The rainfall reading: a daily total is a rectangle, not a ramp towards
    // the next day. With the rule set to rectangular and each sample lasting
    // until the next one, the accumulation of a year is days × level exactly,
    // which is what makes every number below hand-computable.
    await setIntegralOption(page, panelId, 'Rule', 'rectangular');
    integral = await integralState(page, panelId);
    const ungroupedTotal = integral.totals.find(row => row.name.startsWith('rain')).value;
    // 365 × 1 + 366 × 2 + 365 × 3 = 2192 mm·d, reported in mm·h.
    const expected = YEARS.map(year => DAYS_IN_YEAR[year] * LEVEL[year] * 24);
    const expectedTotal = expected.reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(ungroupedTotal - expectedTotal) < 1e-6,
        `the whole-range total is the hand-computed one (${ungroupedTotal} vs ${expectedTotal})`);

    // ── Integral, grouped by year ──
    await setIntegralOption(page, panelId, 'Group by', 'year');
    integral = await integralState(page, panelId);
    assert.equal(integral.grouped, true, 'the view switches to the grouped reading');
    assert.equal(integral.groupBy, 'year', 'by year');
    assert.deepEqual(integral.categories, ['2019', '2020', '2021'], 'one category per calendar year');
    assert.equal(integral.traceCount, 2, 'one bar series per signal');
    assert.equal(integral.barmode, 'group', 'drawn side by side');
    assert.deepEqual(integral.barX[0], ['2019', '2020', '2021'], 'with the years on the category axis');
    assert.equal(integral.categoryAxisTitle, 'Period', 'which says what it carries');
    // `mm` takes no SI prefix of its own (millimetres, not metres), so the
    // shared decade is stated as ×10ⁿ instead of folded into the unit.
    assert.match(integral.valueAxisTitle, /Integral \[mm·h ×10³\]/,
        `and the value axis keeps the unit (${integral.valueAxisTitle})`);

    const rain = integral.series.find(entry => entry.name.startsWith('rain'));
    const drizzle = integral.series.find(entry => entry.name.startsWith('drizzle'));
    for (let index = 0; index < YEARS.length; index++) {
        assert.ok(Math.abs(rain.values[index] - expected[index]) < 1e-6,
            `${YEARS[index]} accumulates its own calendar year (${rain.values[index]} vs ${expected[index]})`);
        assert.ok(Math.abs(rain.means[index] - LEVEL[YEARS[index]]) < 1e-9,
            `and its mean is the level it was held at (${rain.means[index]})`);
        assert.ok(Math.abs(drizzle.values[index] - expected[index] / 2) < 1e-6,
            'while the second signal keeps its 2:1 ratio in every column');
    }
    const summed = rain.values.reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(summed - ungroupedTotal) < 1e-6,
        `the columns add back up to the whole-range total (${summed} vs ${ungroupedTotal})`);
    assert.deepEqual(integral.disabledSelects, ['Order'],
        'Order is disabled while the columns are a timeline');
    assert.match(integral.status, /3 year periods/, `the status says how the range was cut up (${integral.status})`);
    assert.deepEqual(integral.summaryPeriods.slice(0, 4), ['2019', '2020', '2021', 'Whole range'],
        'and the summary lists each period, closed by the total it sums to');
    // The label on a bar drops the unit the axis already carries, so a column
    // reads as a number instead of a rotated smear.
    assert.equal(integral.barText[0].length, 3, 'each column is labelled with its value');
    assert.ok(integral.barText[0].every(label => !label.includes('mm')),
        `without repeating the axis unit (${integral.barText[0].join(', ')})`);
    if (shots) await page.screenshot({ path: `${shots}/integral-grouped-by-year.png` });

    // A coarser-to-finer switch keeps the identity: twelve months of 2019 plus
    // the rest, all still summing to the same total.
    await setIntegralOption(page, panelId, 'Group by', 'month');
    integral = await integralState(page, panelId);
    assert.equal(integral.categories.length, 36, 'thirty-six monthly columns');
    assert.equal(integral.categories[0], '2019-01', 'labelled by year and month');
    const monthlyRain = integral.series.find(entry => entry.name.startsWith('rain'));
    const monthlySum = monthlyRain.values.reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(monthlySum - ungroupedTotal) < 1e-6,
        `and the monthly columns sum to the same total (${monthlySum} vs ${ungroupedTotal})`);

    // And down to the day: 1096 columns, one per sample, each the rectangle
    // that one sample owns — the finest split the record allows, and still the
    // same total. (The 2000-period cap is exercised in the kernel tests.)
    await setIntegralOption(page, panelId, 'Group by', 'day');
    integral = await integralState(page, panelId);
    assert.equal(integral.grouped, true, 'daily grouping is within the cap for a three-year record');
    assert.equal(integral.categories.length, 1096, 'one column per day, leap day included');
    const dailyRain = integral.series.find(entry => entry.name.startsWith('rain'));
    const dailySum = dailyRain.values.reduce((sum, value) => sum + value, 0);
    assert.ok(Math.abs(dailySum - ungroupedTotal) < 1e-6,
        `and the daily columns sum to the same total (${dailySum} vs ${ungroupedTotal})`);
    assert.ok(Math.abs(dailyRain.values[0] - 24) < 1e-9,
        `the first day is one millimetre over one day (${dailyRain.values[0]} mm·h)`);
    assert.equal(integral.barText[0], null,
        'and at that density the printed values are dropped rather than overlapped');
    await setIntegralOption(page, panelId, 'Group by', 'none');

    // ── Temporal profile, Multi-year ──
    await page.evaluate(id => window.app.plotManager._toggleTimeseriesAnalysisMode(id, 'temporal-profile'), panelId);
    await page.waitForFunction(id => (window.app.plotManager.plots.get(id)?._temporalProfileModels || []).length > 0,
        panelId, { timeout: 30000 });
    await page.evaluate((id) => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(id);
        const buttons = [...pm._temporalProfileOptionsPanel(plot).querySelectorAll('.hist-seg-btn')];
        const button = buttons.find(candidate => candidate.textContent === 'Multi-year');
        if (!button) throw new Error('no Multi-year period button');
        button.click();
    }, panelId);
    await page.waitForTimeout(900);
    const profile = await profileState(page, panelId);
    assert.equal(profile.period, 'multi-year', 'the profile switches to the multi-year period');
    assert.deepEqual(profile.binYears, YEARS, 'one bin per calendar year of the record');
    assert.equal(profile.absoluteBins, true, 'whose bins sit on the real timeline');
    assert.deepEqual(profile.means, YEARS.map(year => LEVEL[year]),
        'each carrying the mean of its daily means');
    assert.deepEqual(profile.nPeriods, YEARS.map(year => DAYS_IN_YEAR[year]),
        'over all the days of that year');
    assert.deepEqual(profile.ticktext, YEARS.map(String), 'the axis is ticked by year');
    assert.equal(profile.xAxisTitle, 'Calendar year [UTC]', 'and says so');
    assert.match(profile.yAxisTitle, /^Mean/, `while the profile still shows the mean (${profile.yAxisTitle})`);
    assert.ok(profile.plottedX.every(length => length === YEARS.length),
        `every drawn series has one point per year (${profile.plottedX.join(', ')})`);
    if (shots) await page.screenshot({ path: `${shots}/profile-multi-year.png` });

    assert.deepEqual(errors, [], `no page errors: ${errors.join(' | ')}`);
    console.log('Calendar-period aggregation e2e checks passed');
} finally {
    await browser.close();
    await server.close();
}
