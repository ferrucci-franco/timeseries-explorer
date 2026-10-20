// The Feedback form, in a real browser, from Ctrl+V to a filed report.
//
// Two things this proves that reading the source cannot:
//
// 1. Ctrl+V attaches a screenshot even though the caret is in a text field.
//    The form opens with the focus in the summary input, and the paste
//    listener used to live on the drop zone -- which receives the event only
//    while it holds focus. So "paste screenshots here" did nothing, every
//    time, for everyone who did not first click the zone.
// 2. Pressing Send is the whole of sending: the report leaves the page as one
//    request and comes back as an issue link, with no GitHub account, no mail
//    client, and nothing to drag anywhere.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:feedback-send`.
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';

import { chromium } from 'playwright';

// A stand-in for server/feedback-worker: it records what arrived and answers
// the way the worker does. The endpoint is read at build time, so it has to be
// in the environment before Vite's config is loaded.
const received = [];
const stub = createHttpServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
        received.push({
            method: request.method,
            contentType: request.headers['content-type'] || '',
            body: Buffer.concat(chunks).toString('utf8'),
        });
        response.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
        });
        response.end(JSON.stringify({
            ok: true,
            issueUrl: 'https://github.com/ferrucci-franco/timeseries-explorer/issues/4242',
            issueNumber: 4242,
            reference: '2026-10-19-abcdef',
        }));
    });
});
const endpoint = await new Promise((resolve) => {
    stub.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${stub.address().port}/report`));
});
// Unreferenced, so this stub can never be the reason the script hangs at the
// end. It was `process.exit(0)` in the finally below that did that job before,
// which also discarded the exit code of a failed assertion: the script
// reported success no matter what it found.
stub.unref();
process.env.OMV_FEEDBACK_ENDPOINT = endpoint;

const { createServer } = await import('vite');
const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();

// A real PNG, small enough to be left alone by the shrinking step.
const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEJMDEgAUIcAJSAAx3n8TYZAAAAAElFTkSuQmCC',
    'base64',
);

try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.app?.showFeedbackForm === 'function');

    await page.evaluate(() => window.app.showFeedbackForm());
    await page.waitForSelector('.feedback-dialog');

    // The form opens with the caret in the summary field. That is the state
    // the paste bug lived in, so the test keeps it.
    await page.waitForFunction(() => document.activeElement?.closest('.feedback-field') !== null);
    const focusedFirst = await page.evaluate(() => document.activeElement.tagName.toLowerCase());
    assert.equal(focusedFirst, 'input', 'the form still opens with the focus in a text field');

    // Nothing has been reported yet, so the status box must take no space at
    // all. It is `hidden`, but its class sets `display`, which is one
    // specificity step above the browser's own [hidden] rule -- so it drew as
    // an empty grey bar above the buttons until the CSS said otherwise, and
    // only a real layout can tell.
    assert.equal(await page.isVisible('.feedback-status'), false, 'an empty status box is not drawn');

    await page.fill('.feedback-field:nth-child(3) .feedback-control', 'The cursor jumps one sample');
    await page.fill('.feedback-field:nth-child(4) .feedback-control', 'Opened a csv, dragged the cursor across the plot.');

    // ── Ctrl+V with the caret in a text field ───────────────────────────────
    // Dispatched on whatever has focus, exactly as the browser would on
    // Ctrl+V; nothing here targets the drop zone.
    await page.evaluate(async (bytes) => {
        const file = new File([new Uint8Array(bytes)], 'image.png', { type: 'image/png' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        document.activeElement.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
        }));
    }, Array.from(PNG));

    await page.waitForSelector('.feedback-file-list li', { timeout: 5000 });
    const attached = await page.$$eval('.feedback-file-list li .feedback-file-name', nodes => nodes.map(n => n.textContent));
    assert.equal(attached.length, 1, 'the pasted screenshot is attached');
    assert.match(attached[0], /^screenshot-1\./, 'and named as a screenshot rather than "image"');
    assert.ok(await page.$('.feedback-file-list li img'), 'with a preview of what was pasted');

    // Pasting text, meanwhile, still belongs to the field the caret is in.
    await page.click('.feedback-field:nth-child(5) .feedback-control');
    await page.evaluate(() => {
        const transfer = new DataTransfer();
        transfer.setData('text/plain', 'pasted words');
        document.activeElement.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: transfer,
            bubbles: true,
            cancelable: true,
        }));
    });
    const stillOne = await page.$$eval('.feedback-file-list li', nodes => nodes.length);
    assert.equal(stillOne, 1, 'a paste with no file attaches nothing');

    // ── Send ────────────────────────────────────────────────────────────────
    await page.click('.feedback-send-btn');
    await page.waitForSelector('.feedback-status.is-sent', { timeout: 15000 });

    assert.equal(await page.isVisible('.feedback-status'), true, 'and a real one is');
    const link = await page.$eval('.feedback-status-link', node => ({ href: node.href, text: node.textContent }));
    assert.equal(link.href, 'https://github.com/ferrucci-franco/timeseries-explorer/issues/4242');
    assert.match(link.text, /4242/, 'the reporter is shown where the report landed');
    assert.equal(await page.$eval('.feedback-send-btn', node => node.hidden), true, 'Send is gone once it is filed');
    assert.equal(await page.$eval('.feedback-field:nth-child(3) .feedback-control', node => node.disabled), true,
        'and the form is frozen, so the same report cannot be filed twice');

    // What actually left the page.
    assert.equal(received.length, 1, 'one report, one request');
    const [request] = received;
    assert.equal(request.method, 'POST');
    assert.match(request.contentType, /^text\/plain/, 'a simple CORS request, so no preflight is needed');
    const lines = request.body.split('\n');
    assert.equal(lines.length, 2, 'the metadata line, then the screenshot');
    const head = JSON.parse(lines[0]);
    assert.equal(head.schema, 1);
    assert.equal(head.summary, 'The cursor jumps one sample');
    assert.equal(head.details, 'Opened a csv, dragged the cursor across the plot.');
    assert.equal(head.attachments.length, 1);
    assert.ok(head.app.version, 'the build travels with the report');
    assert.ok(head.app.userAgent.includes('Chrome'), 'and so does the browser it happened in');
    assert.ok(Buffer.from(lines[1], 'base64').length > 0, 'the screenshot arrives as bytes');

    // Reopening offers a clean form: a filed report is not a draft.
    await page.click('.feedback-actions .modal-btn-confirm');
    await page.waitForSelector('.feedback-dialog', { state: 'detached' });
    await page.evaluate(() => window.app.showFeedbackForm());
    await page.waitForSelector('.feedback-dialog');
    assert.equal(await page.$eval('.feedback-field:nth-child(3) .feedback-control', node => node.value), '',
        'the sent report is not waiting in the form to be sent again');
    assert.equal(await page.$$eval('.feedback-file-list li', nodes => nodes.length), 0);

    // ── A real screenshot is really shrunk ──────────────────────────────────
    // The unit test decides with stubs; this runs the actual OffscreenCanvas
    // path in Chromium, on a picture the size a screen grab really is.
    const shrink = await page.evaluate(async () => {
        const { shrinkScreenshot } = await import('/src/app/feedback-transport.js');
        const canvas = document.createElement('canvas');
        canvas.width = 2800;
        canvas.height = 1800;
        const context = canvas.getContext('2d');
        // Noise, so PNG cannot compress it down to nothing and the file is
        // the megabyte or two a screenshot of a plot would be.
        const image = context.createImageData(canvas.width, canvas.height);
        for (let i = 0; i < image.data.length; i += 4) {
            image.data[i] = (i * 7) % 255;
            image.data[i + 1] = (i * 13) % 255;
            image.data[i + 2] = (i * 29) % 255;
            image.data[i + 3] = 255;
        }
        context.putImageData(image, 0, 0);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const original = new File([blob], 'screen.png', { type: 'image/png' });
        const result = await shrinkScreenshot(original);
        const bitmap = await createImageBitmap(result);
        return {
            before: original.size,
            after: result.size,
            type: result.type,
            name: result.name,
            width: bitmap.width,
        };
    });
    assert.ok(shrink.before > 600 * 1024, `the test picture is screenshot-sized (${shrink.before} bytes)`);
    assert.ok(shrink.after < shrink.before, `shrunk from ${shrink.before} to ${shrink.after} bytes`);
    assert.equal(shrink.type, 'image/jpeg');
    assert.equal(shrink.name, 'screen.jpg');
    assert.equal(shrink.width, 2000, 'and capped at 2000 px on its longest edge');

    // ── The handover from Full Desktop ──────────────────────────────────────
    // That edition transmits nothing, so its Feedback command opens this page
    // with the form requested in the query. The form has to come up by itself,
    // the query has to be gone afterwards, and the report has to say which
    // build it is about -- the desktop one, not this page.
    received.length = 0;
    const handed = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await handed.goto(`${baseUrl}?feedback=1&from=desktop&v=0.4.1&c=abc1234&p=win32`, { waitUntil: 'domcontentloaded' });
    await handed.waitForSelector('.feedback-dialog', { timeout: 15000 });
    assert.equal(await handed.evaluate(() => window.location.search), '',
        'the query is cleared, so a reload does not reopen the form');

    await handed.fill('.feedback-field:nth-child(3) .feedback-control', 'Crashes when opening a .mat');
    await handed.fill('.feedback-field:nth-child(4) .feedback-control', 'Opened a Dymola result in the desktop app.');
    await handed.click('.feedback-send-btn');
    await handed.waitForSelector('.feedback-status.is-sent', { timeout: 15000 });
    const handedHead = JSON.parse(received[0].body.split('\n')[0]);
    assert.equal(handedHead.app.reportedFrom, 'Full Desktop 0.4.1 · win32 · commit abc1234');

    // ── And the desktop end of it ───────────────────────────────────────────
    // With a desktop runtime in place, Feedback must build no sending form at
    // all: it explains itself and hands that URL to the system browser, which
    // is what `window.open` becomes inside Electron.
    const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await desktop.addInitScript(() => {
        const noop = () => {};
        // Enough of the preload's surface (electron/preload.cjs) for the app
        // to come up believing it is Full Desktop.
        window.omvDesktop = {
            platform: 'win32',
            homedir: 'C:\\Users\\tester',
            tmpdir: 'C:\\Temp',
            username: 'tester',
            setTheme: noop,
            setSpellcheck: noop,
            getZoom: async () => 1,
            setZoom: async () => 1,
            onZoomChanged: () => noop,
            selectFilePath: async () => null,
            selectFilePaths: async () => null,
            selectParquetOutputPath: async () => null,
            deleteTemporaryParquet: async () => null,
            readFile: async () => null,
        };
        window.__openedUrls = [];
        window.open = (target) => { window.__openedUrls.push(target); return null; };
    });
    const desktopErrors = [];
    desktop.on('pageerror', error => desktopErrors.push(String(error)));
    await desktop.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await desktop.waitForFunction(() => window.app?.capabilities?.isDesktop === true);
    await desktop.evaluate(() => window.app.showFeedbackForm());
    await desktop.waitForSelector('.modal-dialog');
    assert.equal(await desktop.$$eval('.feedback-dialog', nodes => nodes.length), 0,
        'the edition that cannot transmit never builds the form that would');
    await desktop.click('.modal-btn-confirm');
    await desktop.waitForFunction(() => window.__openedUrls.length > 0, { timeout: 5000 });
    const opened = await desktop.evaluate(() => window.__openedUrls[0]);
    assert.match(opened, /^https:\/\/www\.unditas\.com\/\?feedback=1&from=desktop&v=/, `handed over to ${opened}`);
    assert.match(opened, /&p=win32$/, 'with the platform the report is about');
    assert.deepEqual(desktopErrors, [], 'and nothing broke on the way there');

    assert.deepEqual(pageErrors, [], 'no page errors along the way');
    console.log('Feedback end-to-end send checks passed.');
} finally {
    await browser.close();
    await server.close();
    stub.close();
}
