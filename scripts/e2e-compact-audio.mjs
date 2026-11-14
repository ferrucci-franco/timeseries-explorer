// End-to-end check of sound on the phone layout (docs/phone-web-specification.md,
// §5.2 "audio strip"): the Plot sheet's Sound switch opens the desktop's audio
// strip (audio-methods.js) under the plot, laid out at a finger's size.
//
//   · a signal sampled too slowly to be heard: the switch is disabled, and the
//     reason the desktop puts in its tooltip is written under it;
//   · an 8 kHz tone: the switch opens the strip and puts the sheet away; every
//     control is on the screen, 40 px or more, nothing scrolls sideways, and
//     the chart ends where the strip begins — also once the strip's note line
//     appears and it grows;
//   · a tap on the plot moves the sound there; Play plays; the signal list
//     switches to the other signal; the switch closes the strip;
//   · sideways, the strip still fits under the plot.
//
// Needs a Chromium for Playwright. Run with `npm run e2e:compact-audio`.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const RATE = 8000;
function toneCsv() {
    const lines = ['time,tone,filtered'];
    for (let i = 0; i < RATE * 2; i++) {
        const t = i / RATE;
        lines.push(`${t.toFixed(6)},${Math.sin(2 * Math.PI * 440 * t).toFixed(5)},${(0.5 * Math.sin(2 * Math.PI * 440 * t)).toFixed(5)}`);
    }
    return { name: 'tone.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}
function slowCsv() {
    const lines = ['time,slow'];
    for (let i = 0; i < 2000; i++) lines.push(`${(i / 100).toFixed(2)},${Math.sin(i / 20).toFixed(5)}`);
    return { name: 'slow.csv', mimeType: 'text/csv', buffer: Buffer.from(lines.join('\n') + '\n') };
}

const server = await createServer({ logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await chromium.launch();
const shots = process.env.SHOTS_DIR;
const shot = async (page, name) => { if (shots) await page.screenshot({ path: `${shots}/compact-audio-${name}.png` }); };

try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(baseUrl);
    await page.waitForFunction(() => window.app?.plotManager && document.querySelector('.layout-panel'), null, { timeout: 60000 });

    const plotSignal = async (name) => {
        await page.locator('.compact-nav-btn[data-sheet="data"]').click();
        await page.locator(`#variables-tree .tree-item[data-var-name="${name}"]`).click();
        await page.locator('.compact-sheet-close').click();
        await page.waitForFunction(() => window.app._compact.sheet === null);
    };
    const audio = () => page.evaluate(() => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(window.app._compactActivePanelId());
        return {
            open: !!plot.audio?.open,
            position: pm._audioPosition(plot),
            playing: pm._audioPanelIsPlaying(plot),
            source: document.querySelector('.compact-active-panel .audio-source')?.selectedOptions?.[0]?.textContent || null,
        };
    });
    // The chart's bottom against the strip's top, and what would stick out.
    const layout = () => page.evaluate(() => {
        const panel = document.querySelector('.compact-active-panel');
        const strip = panel.querySelector('.audio-strip');
        const plot = window.app.plotManager.plots.get(window.app._compactActivePanelId());
        const svg = plot.div.querySelector('.main-svg').getBoundingClientRect();
        const s = strip.getBoundingClientRect();
        const controls = ['.audio-play', '.audio-stop', '.audio-loop', '.audio-readout', '.audio-seek', '.audio-source', '.audio-dc', '.audio-mute'];
        const problems = [];
        for (const selector of controls) {
            const r = strip.querySelector(selector).getBoundingClientRect();
            if (r.width === 0 || r.left < 0 || r.right > window.innerWidth + 0.5 || r.top < s.top - 0.5 || r.bottom > s.bottom + 0.5) {
                problems.push(`${selector} at ${Math.round(r.left)}–${Math.round(r.right)} × ${Math.round(r.top)}–${Math.round(r.bottom)}`);
            }
            if (selector !== '.audio-readout' && selector !== '.audio-seek' && r.height < 40) problems.push(`${selector} is ${Math.round(r.height)} px tall`);
        }
        if (document.documentElement.scrollWidth > window.innerWidth + 1) problems.push('the page scrolls sideways');
        if (strip.querySelector('.audio-strip-row').scrollWidth > strip.querySelector('.audio-strip-row').clientWidth + 1) problems.push('the strip scrolls sideways');
        return { chartBottom: Math.round(svg.bottom), stripTop: Math.round(s.top), stripBottom: Math.round(s.bottom), problems };
    });
    const settled = async (label) => {
        await page.waitForFunction(() => {
            const plot = window.app.plotManager.plots.get(window.app._compactActivePanelId());
            const svg = plot.div.querySelector('.main-svg').getBoundingClientRect();
            const strip = document.querySelector('.compact-active-panel .audio-strip').getBoundingClientRect();
            return Math.abs(svg.bottom - strip.top) <= 1.5;
        }, null, { timeout: 5000 }).catch(() => {});
        const l = await layout();
        assert.deepEqual(l.problems, [], `${label}: every control of the strip is on the screen, at a finger's size`);
        // Neither under the strip (the axis hidden) nor short of it (a gap).
        assert.ok(Math.abs(l.chartBottom - l.stripTop) <= 1.5, `${label}: the chart ends where the strip begins (chart ${l.chartBottom}, strip ${l.stripTop})`);
        return l;
    };

    // ── Too slow to hear: disabled, with the reason ─────────────────────────
    await page.setInputFiles('#file-input', [slowCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 1, null, { timeout: 60000 });
    await plotSignal('slow');
    await page.locator('.compact-nav-btn[data-sheet="plot"]').click();
    const slowSwitch = page.locator('.compact-sound-switch input');
    assert.equal(await slowSwitch.isDisabled(), true, 'a 100 Hz signal cannot be heard: the switch is off and disabled');
    const reason = await page.locator('.compact-sound-note').innerText();
    const desktopReason = await page.evaluate(() => {
        const pm = window.app.plotManager;
        return pm._audioButtonTitle(pm.plots.get(window.app._compactActivePanelId()));
    });
    assert.equal(reason, desktopReason, 'and says why, in the desktop tooltip\'s words');
    assert.match(reason, /slow/, `naming the signal (${reason})`);
    await page.locator('.compact-sheet-close').click();

    // ── An 8 kHz tone, on a plot of its own ─────────────────────────────────
    await page.locator('.compact-nav-btn[data-sheet="plot"]').click();
    await page.locator('.compact-page-plot .compact-secondary-btn', { hasText: 'New plot' }).click();
    await page.locator('.compact-sheet-close').click();
    await page.setInputFiles('#file-input', [toneCsv()]);
    await page.waitForFunction(() => window.app.plotManager.files.size === 2, null, { timeout: 60000 });
    await plotSignal('tone');
    await plotSignal('filtered');

    await page.locator('.compact-nav-btn[data-sheet="plot"]').click();
    assert.equal(await page.locator('.compact-sound-section-title, .compact-section-title', { hasText: /^Sound$/i }).count(), 1, 'the Plot sheet has a Sound section');
    const soundSwitch = page.locator('.compact-sound-switch input');
    assert.equal(await soundSwitch.isDisabled(), false, 'an 8 kHz tone can be heard');
    assert.equal(await soundSwitch.isChecked(), false);
    await soundSwitch.click();
    await page.waitForFunction(() => window.app._compact.sheet === null && !!document.querySelector('.compact-active-panel .audio-strip'));
    assert.equal((await audio()).open, true, 'the switch opens the strip, and the sheet makes way for it');
    await settled('upright');
    await shot(page, 'strip');

    // A tap on the plot moves the sound to that instant: 1.5 s, wherever it
    // is on the axis (this plot's time axis is linked to the 20 s one).
    const box = await page.locator('.compact-active-panel .main-svg').first().boundingBox();
    const xa = await page.evaluate(() => {
        const xaxis = window.app.plotManager.plots.get(window.app._compactActivePanelId()).div._fullLayout.xaxis;
        return { offset: xaxis._offset, length: xaxis._length, range: xaxis.range.map(Number) };
    });
    const at = xa.offset + ((1.5 - xa.range[0]) / (xa.range[1] - xa.range[0])) * xa.length;
    await page.touchscreen.tap(box.x + at, box.y + box.height * 0.5);
    await page.waitForFunction(() => {
        const pm = window.app.plotManager;
        return pm._audioPosition(pm.plots.get(window.app._compactActivePanelId())) > 0;
    }, null, { timeout: 5000 });
    const sought = (await audio()).position;
    assert.ok(Math.abs(sought - 1.5) < 0.05, `a tap at 1.5 s on the plot moves the sound there (${sought})`);

    // Play: the tap is the gesture the browser wants before it makes a sound.
    await page.locator('.compact-active-panel .audio-play').tap();
    await page.waitForFunction(() => {
        const pm = window.app.plotManager;
        const plot = pm.plots.get(window.app._compactActivePanelId());
        return pm._audioPanelIsPlaying(plot) || pm._audioPosition(plot) > 1.6;
    }, null, { timeout: 5000 });
    // The note says the browser resampled 8 kHz: the strip grows, and the
    // chart gives it the room.
    await page.waitForFunction(() => !document.querySelector('.compact-active-panel .audio-strip-note')?.hidden, null, { timeout: 5000 });
    await settled('with the note line');

    // The other signal, from the list.
    const filteredValue = await page.evaluate(() => [...document.querySelectorAll('.compact-active-panel .audio-source option')]
        .find(option => /filtered$/.test(option.textContent))?.value);
    await page.locator('.compact-active-panel .audio-source').selectOption(filteredValue);
    assert.match((await audio()).source, /filtered$/, 'the list switches to the other signal');

    // ── Sideways ────────────────────────────────────────────────────────────
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForFunction(() => document.documentElement.classList.contains('compact-landscape'));
    await page.waitForTimeout(600);
    await settled('sideways');
    await shot(page, 'landscape');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.documentElement.classList.contains('compact-landscape'));
    await page.waitForTimeout(400);

    // ── The switch closes it ────────────────────────────────────────────────
    await page.locator('.compact-nav-btn[data-sheet="plot"]').click();
    assert.equal(await page.locator('.compact-sound-switch input').isChecked(), true, 'the sheet says the sound is on');
    await page.locator('.compact-sound-switch input').click();
    await page.waitForFunction(() => !document.querySelector('.compact-active-panel .audio-strip'));
    assert.equal((await audio()).open, false, 'off, the strip goes');
    assert.equal(await page.locator('.compact-sound-switch input').isChecked(), false, 'and the switch says so');

    assert.deepEqual(errors, [], 'no page error');
    console.log('e2e compact audio: the Sound switch opens a strip that fits a phone, upright and sideways; tap to seek, play, switch signal, close');
} finally {
    await browser.close();
    await server.close();
}
