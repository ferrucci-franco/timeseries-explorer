// End-to-end check that every analysis can go from Full to Selection AND
// back to Full, with its own buttons, in a real browser.
//
// The report: in an analysis, once Selection had been pressed, Full did
// nothing. The shared range block (plots/methods/analysis-range-methods.js)
// decided whether a press changed the mode from the `rangeFull` the block was
// BUILT with. A panel that syncs its block in place instead of rebuilding it
// (_syncAnalysisRangeSection) kept that first value for ever: built in Full,
// every later press on Full was "already on".
//
// So, for each analysis of the time-series menu and of the 2D menu: press
// Selection, check the state and the buttons, press Full, check them again,
// and once more round, since the second lap is the one that used to fail on
// the panels that do rebuild.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:analysis-range-mode`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

function makeCsv() {
    const lines = ['time,y,z'];
    const start = Date.UTC(2026, 9, 1);
    for (let i = 0; i < 3000; i++) {
        const stamp = new Date(start + i * 60000).toISOString().slice(0, 19).replace('T', ' ');
        lines.push(`${stamp},${(2 + Math.sin(i / 30)).toFixed(4)},${(0.8 * Math.sin(i / 30) + 0.1 * Math.cos(i / 7)).toFixed(4)}`);
    }
    return { name: 'wave.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

const TIME_ANALYSES = ['fft', 'histogram', 'heatmap', 'temporal-profile', 'integral', 'curve-fit', 'trend'];
const PLANE_ANALYSES = ['correlation', 'phase2d-fit'];

// The Full / Selection buttons of a panel that are on screen (an analysis may
// keep a block per fit or per segment; the first visible one is pressed).
const modeButtons = (page, index) => page.evaluate((i) => {
    const panel = document.querySelectorAll('.layout-panel')[i];
    const visible = [...panel.querySelectorAll('[data-analysis-range-full]')].filter(node => node.offsetParent !== null);
    const full = visible.find(node => node.dataset.analysisRangeFull === 'true');
    const selection = visible.find(node => node.dataset.analysisRangeFull === 'false');
    return {
        found: !!full && !!selection,
        full: full?.getAttribute('aria-pressed') === 'true',
        selection: selection?.getAttribute('aria-pressed') === 'true',
    };
}, index);

// A panel may rebuild its options while it recomputes, so the button is looked
// up and pressed in one step, in the page.
async function press(page, index, full) {
    const pressed = await page.evaluate(([i, wantFull]) => {
        const panel = document.querySelectorAll('.layout-panel')[i];
        const button = [...panel.querySelectorAll(`[data-analysis-range-full="${wantFull}"]`)].find(node => node.offsetParent !== null);
        if (!button) return false;
        button.scrollIntoView({ block: 'nearest' });
        button.click();
        return true;
    }, [index, full]);
    assert.equal(pressed, true, `the ${full ? 'Full' : 'Selection'} button is on screen`);
}

async function expectMode(page, index, full, message) {
    try {
        await page.waitForFunction(([i, wantFull]) => {
            const panel = document.querySelectorAll('.layout-panel')[i];
            const visible = [...panel.querySelectorAll('[data-analysis-range-full]')].filter(node => node.offsetParent !== null);
            const on = visible.find(node => node.getAttribute('aria-pressed') === 'true');
            return !!on && on.dataset.analysisRangeFull === String(wantFull);
        }, [index, full], { timeout: 8000 });
    } catch (_) {
        assert.fail(`${message} (buttons: ${JSON.stringify(await modeButtons(page, index))})`);
    }
    // The bounds follow the mode: Full locks them, Selection frees them.
    const locked = await page.evaluate((i) => {
        const panel = document.querySelectorAll('.layout-panel')[i];
        const fields = [...panel.querySelectorAll('[data-analysis-range-key]')].filter(node => node.offsetParent !== null);
        return fields.length ? fields.every(node => node.disabled) : null;
    }, index);
    if (locked !== null) assert.equal(locked, full, `${message}: the bounds are ${full ? 'locked' : 'free'}`);
}

async function roundTrip(page, index, name) {
    try {
        await page.waitForFunction((i) => {
            const panel = document.querySelectorAll('.layout-panel')[i];
            return [...panel.querySelectorAll('[data-analysis-range-full]')].some(node => node.offsetParent !== null);
        }, index, { timeout: 20000 });
    } catch (_) {
        assert.fail(`${name}: no Full / Selection buttons on screen`);
    }
    const start = await modeButtons(page, index);
    assert.equal(start.found, true, `${name}: both buttons are there`);
    // Start from Full, whatever the analysis opens in.
    if (!start.full) {
        await press(page, index, true);
        await expectMode(page, index, true, `${name}: Full from its opening mode`);
    }
    for (const lap of [1, 2]) {
        await press(page, index, false);
        await expectMode(page, index, false, `${name}: Full → Selection (lap ${lap})`);
        await press(page, index, true);
        await expectMode(page, index, true, `${name}: Selection → Full (lap ${lap})`);
    }
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    const errors = [];
    // With its stack: a page error here has been a draw onto a panel already
    // rebuilt, and only the stack says whose.
    page.on('pageerror', e => errors.push(String(e.stack || e.message)));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });
    await page.setInputFiles('#file-input', [makeCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    await page.evaluate(() => {
        const app = window.app;
        const panelEl = document.querySelector('.layout-panel');
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        app.plotManager.addTrace(panelEl.dataset.id, 'y', panelEl);
    });
    await page.locator('.timeseries-analysis-menu-btn').first().waitFor();

    const failures = [];
    const attempt = async (name, index) => {
        try {
            await roundTrip(page, index, name);
            console.log(`  ${name}: Full ⇄ Selection, twice round`);
        } catch (error) {
            failures.push(error.message);
            console.log(`  ${name}: FAILED — ${error.message}`);
        }
    };

    for (const id of TIME_ANALYSES) {
        await page.locator('.timeseries-analysis-menu-btn').first().click();
        await page.locator(`.panel-analysis-menu .analysis-card[data-mark="${id}"]`).click();
        await page.waitForFunction(() => !document.querySelector('.panel-analysis-menu'));
        await attempt(id, 0);
    }

    // The 2D analyses, in a second panel.
    await page.evaluate(() => window.app.layoutManager.splitPanel(document.querySelector('.layout-panel').dataset.id, 'h', false));
    await page.waitForFunction(() => document.querySelectorAll('.layout-panel').length === 2);
    await page.evaluate(() => {
        const panels = [...document.querySelectorAll('.layout-panel')];
        window.app.plotManager._setMode(panels[1].dataset.id, 'phase2d');
    });
    await page.waitForFunction(() => {
        const panel = [...document.querySelectorAll('.layout-panel')][1];
        return window.app.plotManager.plots.get(panel.dataset.id)?.mode === 'phase2d' && panel.querySelector('.timeseries-analysis-menu-btn');
    });
    await page.evaluate(() => {
        const panel = [...document.querySelectorAll('.layout-panel')][1];
        const pm = window.app.plotManager;
        pm.addTrace(panel.dataset.id, 'y', panel);
        pm.addTrace(panel.dataset.id, 'z', panel);
    });
    await page.waitForFunction(() => {
        const panel = [...document.querySelectorAll('.layout-panel')][1];
        return window.app.plotManager.plots.get(panel.dataset.id)?.phaseTraces?.length > 0;
    }, null, { timeout: 30000 });
    for (const id of PLANE_ANALYSES) {
        await page.locator('.timeseries-analysis-menu-btn').last().click();
        await page.locator(`.panel-analysis-menu .analysis-card[data-mark="${id}"]`).click();
        await page.waitForFunction(() => !document.querySelector('.panel-analysis-menu'));
        await attempt(id, 1);
    }

    assert.deepEqual(failures, [], 'every analysis goes to Selection and back to Full');
    assert.deepEqual(errors, [], 'no page error');
    console.log('Analysis range mode: Full ⇄ Selection in every analysis, both ways.');
} finally {
    await browser.close();
    await server.close();
}
