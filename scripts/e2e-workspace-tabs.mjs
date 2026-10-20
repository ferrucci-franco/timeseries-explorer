// End-to-end check of three things a real-time session in Full Desktop needs,
// in a real browser:
//
//   1. Tabs: several screens of panels over the same files. A tab left and
//      come back to has its panels, traces and name; Ctrl+T / Ctrl+Tab work;
//      a saved view lists every tab and brings them back.
//   2. Shift+click in a panel menu (Samples, line shape) gives every time plot
//      the same state, the ones of the tab off screen included.
//   3. A view saved with one file, applied while only another file of the same
//      experiment is open (a logger names its files by the hour): a dialog
//      names the file the view was saved with and offers the open one.
//   4. The web build has tabs as well, reached with Alt+1…9; the Ctrl keys
//      are the browser's there and are left alone.
//
// Full Desktop is told apart by window.omvDesktop, which the page gets here
// before it loads. Needs a Chromium for Playwright. Run with
// `npm run e2e:workspace-tabs`. Not part of test:release, which stays offline
// and browser-free.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

function csv(name, offset) {
    const lines = ['time,a,b'];
    for (let i = 0; i < 200; i++) lines.push(`${i / 10},${Math.sin(i / 9 + offset).toFixed(5)},${(i % 17) + offset}`);
    return { name, mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

const tabState = page => page.evaluate(() => {
    const app = window.app;
    return {
        names: [...document.querySelectorAll('#workspace-tabs .workspace-tab-label')].map(el => el.textContent),
        active: app.tabs.activeIndex,
        panels: app.layoutManager.getPanelCount(),
        traces: [...app.plotManager.plots.values()].map(plot => plot.traces.map(t => t.varName).join('+')).sort(),
    };
});

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
try {
    const context = await browser.newContext({ viewport: { width: 1500, height: 900 } });
    await context.addInitScript(() => { window.omvDesktop = {}; });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));

    // ── The language is one button now, with the four in its menu ──
    await page.click('#language-menu-btn');
    await page.click('#language-menu .lang-btn[data-lang="es"]');
    await page.waitForFunction(() => window.app.language === 'es');
    assert.equal(await page.textContent('#language-menu-btn .language-menu-code'), 'ES');
    assert.equal(await page.isHidden('#language-menu'), true, 'the menu closes on a pick');

    await page.setInputFiles('#file-input', [csv('run_10h.csv', 0)]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });

    assert.equal(await page.isVisible('#workspace-tabs'), true, 'Full Desktop shows the tab strip');
    let s = await tabState(page);
    assert.deepEqual(s.names, ['Pestaña 1'], 'one tab to begin with, named in the language of the app');

    // Tab 1: two panels, a and b.
    await page.evaluate(() => {
        const app = window.app;
        app.setActiveFile([...app.plotManager.files.keys()][0]);
        const first = document.querySelector('.layout-panel').dataset.id;
        app.layoutManager.splitPanel(first, 'h');
        const [p1, p2] = [...document.querySelectorAll('.layout-panel')].map(el => el.dataset.id);
        app.plotManager.addTrace(p1, 'a', document.querySelector(`.layout-panel[data-id="${p1}"]`));
        app.plotManager.addTrace(p2, 'b', document.querySelector(`.layout-panel[data-id="${p2}"]`));
    });
    await page.waitForFunction(() => [...window.app.plotManager.plots.values()].every(p => p.div?._fullLayout));

    // Tab 2, by keyboard, with one panel of a; renamed by a double-click.
    await page.locator('.top-bar').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+t');
    await page.waitForFunction(() => window.app.tabs.items.length === 2 && !window.app._tabSwitching);
    s = await tabState(page);
    assert.equal(s.active, 1, 'Ctrl+T opens the new tab');
    assert.equal(s.panels, 1, 'a new tab starts with one empty panel');
    assert.deepEqual(s.traces, [''], 'and nothing on it');
    await page.evaluate(() => {
        const panel = document.querySelector('.layout-panel');
        window.app.plotManager.addTrace(panel.dataset.id, 'a', panel);
    });
    await page.dblclick('#workspace-tabs .workspace-tab.active');
    await page.fill('#workspace-tabs .workspace-tab-input', 'Detalle');
    await page.keyboard.press('Enter');
    s = await tabState(page);
    assert.deepEqual(s.names, ['Pestaña 1', 'Detalle']);

    // Back to tab 1: its two panels, as they were.
    await page.locator('.top-bar').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+Tab');
    await page.waitForFunction(() => window.app.tabs.activeIndex === 0 && !window.app._tabSwitching);
    await page.waitForFunction(() => [...window.app.plotManager.plots.values()].every(p => p.div?._fullLayout));
    s = await tabState(page);
    assert.equal(s.panels, 2, 'the first tab has its two panels back');
    assert.deepEqual(s.traces, ['a', 'b'], 'with their traces');

    // ── Shift+click: every time plot, the tab off screen included ──
    const firstPanel = await page.evaluate(() => document.querySelector('.layout-panel').dataset.id);
    await page.click(`.layout-panel[data-id="${firstPanel}"] .timeseries-marks-btn`);
    assert.ok(await page.isVisible(`.timeseries-marks-menu[data-panel-id="${firstPanel}"] .marks-menu-footnote`),
        'the menu says what Shift+click does');
    await page.click(`.timeseries-marks-menu[data-panel-id="${firstPanel}"] .marks-item-samples`, { modifiers: ['Shift'] });
    await page.keyboard.press('Escape');
    await page.click(`.layout-panel[data-id="${firstPanel}"] .panel-view-btn`);
    await page.click(`.panel-view-menu[data-panel-id="${firstPanel}"] .marks-line-hv`, { modifiers: ['Shift'] });
    await page.keyboard.press('Escape');
    const applied = await page.evaluate(() => {
        const app = window.app;
        return {
            onScreen: [...app.plotManager.plots.values()].map(p => [p.showSamples, p.traces.every(t => t.lineShape === 'hv')]),
            offScreen: app.tabs.items[1].snapshot.plots.map(p => [p.showSamples, p.traces.every(t => t.lineShape === 'hv')]),
        };
    });
    assert.deepEqual(applied.onScreen, [[true, true], [true, true]], 'both plots on screen');
    assert.deepEqual(applied.offScreen, [[true, true]], 'and the one of the other tab');
    // A plain click is still this plot's only.
    await page.click(`.layout-panel[data-id="${firstPanel}"] .timeseries-marks-btn`);
    await page.click(`.timeseries-marks-menu[data-panel-id="${firstPanel}"] .marks-item-samples`);
    await page.keyboard.press('Escape');
    const plain = await page.evaluate(() => [...window.app.plotManager.plots.values()].map(p => p.showSamples));
    assert.deepEqual(plain.sort(), [false, true], 'a click without Shift changes one plot');

    // ── A saved view keeps the tabs ──
    const viewJson = await page.evaluate(() => JSON.stringify(window.app._createSessionSnapshot({ includeData: false })));
    const view = JSON.parse(viewJson);
    assert.equal(view.tabs.items.length, 2);
    assert.equal(view.tabs.items[1].name, 'Detalle');

    // ── The same view on the next hour's file ──
    // run_10h.csv is closed, run_11h.csv opened: same columns, another name.
    await page.evaluate(async () => {
        const app = window.app;
        const fileId = [...app.files.keys()][0];
        await app.removeFile(fileId, { confirmed: true });
    });
    await page.waitForFunction(() => window.app.plotManager.files.size === 0);
    await page.setInputFiles('#file-input', [csv('run_11h.csv', 3)]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    const applying = page.evaluate(json => window.app.loadSessionOrProjectFile(new File([json], 'view.json')), viewJson);
    await page.waitForSelector('.modal-dialog-session-remap', { timeout: 10000 });
    const dialog = await page.evaluate(() => ({
        needed: document.querySelector('.session-remap-name')?.textContent,
        picked: document.querySelector('.session-remap-select')?.selectedOptions?.[0]?.textContent,
        status: document.querySelector('.session-remap-status')?.className,
    }));
    assert.equal(dialog.needed, 'run_10h.csv', 'the dialog names the file the view was saved with');
    assert.equal(dialog.picked, 'run_11h.csv', 'and offers the open one');
    assert.match(dialog.status, /\bok\b/, 'which has every signal');
    await page.click('.modal-dialog-session-remap .modal-btn-confirm');
    await page.waitForSelector('.modal-dialog-alert');
    await page.click('.modal-dialog-alert .modal-btn');
    assert.equal(await applying, true, 'the view is applied');
    await page.waitForFunction(() => !window.app._tabSwitching);
    s = await tabState(page);
    assert.deepEqual(s.names, ['Pestaña 1', 'Detalle'], 'with its tabs');
    assert.deepEqual(s.traces, ['a', 'b'], 'and the panels of the tab on screen');
    const fileIds = await page.evaluate(() => {
        const app = window.app;
        const open = [...app.files.keys()][0];
        return {
            onScreen: [...app.plotManager.plots.values()].flatMap(p => p.traces.map(t => t.fileId === open)),
            offScreen: app.tabs.items[1].snapshot.plots.flatMap(p => p.traces.map(t => t.fileId === open)),
        };
    });
    assert.deepEqual(fileIds.onScreen, [true, true], 'drawn from the file picked');
    assert.deepEqual(fileIds.offScreen, [true], 'the other tab too');
    await page.keyboard.press('Control+2');
    await page.waitForFunction(() => window.app.tabs.activeIndex === 1 && !window.app._tabSwitching);
    s = await tabState(page);
    assert.deepEqual(s.traces, ['a'], 'Ctrl+2: the second tab, from the new file');

    // ── Closing a tab ──
    page.once('dialog', d => d.accept());
    await page.click('#workspace-tabs .workspace-tab.active .workspace-tab-close');
    await page.waitForSelector('.modal-overlay .modal-btn-confirm');
    await page.click('.modal-overlay .modal-btn-confirm');
    await page.waitForFunction(() => window.app.tabs.items.length === 1 && !window.app._tabSwitching);
    s = await tabState(page);
    assert.deepEqual(s.traces, ['a', 'b'], 'closing the tab on screen shows the one beside it');
    assert.equal(await page.locator('#workspace-tabs .workspace-tab-close').count(), 0, 'the last tab cannot be closed');

    assert.deepEqual(errors, [], 'no page errors');

    // ── The web build ──
    const webContext = await browser.newContext({ viewport: { width: 1500, height: 900 } });
    const web = await webContext.newPage();
    web.on('pageerror', e => errors.push(e.message));
    await web.goto(baseUrl);
    await web.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'));
    await web.setInputFiles('#file-input', [csv('run_10h.csv', 0)]);
    await web.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    assert.equal(await web.isVisible('#workspace-tabs'), true, 'the web build shows the tab strip too');
    await web.evaluate(() => {
        const panel = document.querySelector('.layout-panel');
        window.app.setActiveFile([...window.app.plotManager.files.keys()][0]);
        window.app.plotManager.addTrace(panel.dataset.id, 'a', panel);
    });
    await web.click('#workspace-tabs .workspace-tab-add');
    await web.waitForFunction(() => window.app.tabs.items.length === 2 && !window.app._tabSwitching);
    assert.equal(await web.evaluate(() => window.app.tabs.activeIndex), 1, '+ opens a new tab');
    await web.locator('.top-bar').click({ position: { x: 5, y: 5 } });
    await web.keyboard.press('Alt+1');
    await web.waitForFunction(() => window.app.tabs.activeIndex === 0 && !window.app._tabSwitching);
    s = await tabState(web);
    assert.deepEqual(s.traces, ['a'], 'Alt+1: the first tab, with its trace');
    await web.keyboard.press('Alt+9');
    await web.waitForFunction(() => window.app.tabs.activeIndex === 1 && !window.app._tabSwitching);
    // Ctrl+1 is the browser's in the web build: the app does not act on it.
    const ctrlTaken = await web.evaluate(() => {
        const event = new KeyboardEvent('keydown', { key: '1', code: 'Digit1', ctrlKey: true, bubbles: true, cancelable: true });
        document.body.dispatchEvent(event);
        return event.defaultPrevented || window.app.tabs.activeIndex !== 1;
    });
    assert.equal(ctrlTaken, false, 'Ctrl+1 is left to the browser');

    // ── Many tabs: still one row, + and the list of them all in reach ──
    const sameHeight = await web.evaluate(() => {
        const tab = document.querySelector('#workspace-tabs .workspace-tab').getBoundingClientRect().height;
        const button = document.getElementById('load-new-file').getBoundingClientRect().height;
        return Math.abs(tab - button) < 0.5;
    });
    assert.equal(sameHeight, true, 'a tab is as tall as the buttons of the top bar');
    assert.equal(await web.isVisible('#workspace-tabs .workspace-tabs-overflow'), false, 'no list while the tabs fit');
    await web.evaluate(async () => { for (let i = 0; i < 14; i++) await window.app.addTab(); });
    await web.waitForFunction(() => window.app.tabs.items.length === 16 && !window.app._tabSwitching);
    const row = await web.evaluate(() => {
        const strip = document.getElementById('workspace-tabs');
        const tops = new Set([...strip.querySelectorAll('.workspace-tab')].map(tab => Math.round(tab.getBoundingClientRect().top)));
        const add = strip.querySelector('.workspace-tab-add').getBoundingClientRect();
        return { rows: tops.size, addInView: add.right <= strip.getBoundingClientRect().right + 0.5 && add.width > 0 };
    });
    assert.equal(row.rows, 1, 'sixteen tabs stay on one row');
    assert.equal(row.addInView, true, 'with + still in view');
    assert.equal(await web.isVisible('#workspace-tabs .workspace-tabs-overflow'), true, 'and the list of every tab');
    await web.click('#workspace-tabs .workspace-tabs-overflow');
    const names = await web.$$eval('.workspace-tab-list-menu .workspace-tab-menu-text', items => items.map(item => item.textContent));
    assert.equal(names.length, 16, 'the list names every tab');
    await web.click('.workspace-tab-list-menu .example-menu-item >> nth=0');
    await web.waitForFunction(() => window.app.tabs.activeIndex === 0 && !window.app._tabSwitching);
    const firstInView = await web.evaluate(() => {
        const scroller = document.querySelector('#workspace-tabs .workspace-tabs-scroll').getBoundingClientRect();
        const tab = document.querySelector('#workspace-tabs .workspace-tab.active').getBoundingClientRect();
        return tab.left >= scroller.left - 0.5 && tab.right <= scroller.right + 0.5;
    });
    assert.equal(firstInView, true, 'picking one from the list brings it into view');
    await webContext.close();

    assert.deepEqual(errors, [], 'no page errors');
    console.log('Workspace tabs end-to-end checks passed.');
} finally {
    await browser.close();
    await server.close();
}
