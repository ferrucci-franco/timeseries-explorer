// The desktop window zoom.
//
//   node scripts/test-desktop-zoom.mjs
//
// Desktop needs its own zoom for a reason that is easy to lose: the app menu is
// removed at startup, and in Electron the Ctrl +/-/0 accelerators come from
// that menu's roles. Remove the menu and the desktop build has no zoom at all,
// while the browser build still has the browser's. So what is pinned here is
// the whole chain -- one ladder, one apply path, a value that survives a
// restart, and a row that never appears in the web build.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import translations from '../src/i18n/translations.js';

const require = createRequire(import.meta.url);
const zoom = require('../electron/zoom-levels.cjs');

const LANGS = ['en', 'fr', 'es', 'it'];
let checks = 0;
const check = (fn) => { fn(); checks++; };

const electronMain = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8');
const preload = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const uiMethods = readFileSync(new URL('../src/app/methods/ui-methods.js', import.meta.url), 'utf8');
const baseCss = readFileSync(new URL('../src/styles/base.css', import.meta.url), 'utf8');

const from = (source, marker, length = 6000) => {
    const at = source.indexOf(marker);
    assert.ok(at > 0, `located ${marker}`);
    return source.slice(at, at + length);
};

// ─── The ladder ───────────────────────────────────────────────────────────

check(() => {
    assert.equal(zoom.DEFAULT_ZOOM_FACTOR, 1, '100% is the default');
    assert.ok(zoom.ZOOM_FACTORS.includes(1), 'the ladder passes through 100%');
    assert.deepEqual([...zoom.ZOOM_FACTORS].sort((a, b) => a - b), zoom.ZOOM_FACTORS, 'ascending');
    assert.equal(zoom.MIN_ZOOM_FACTOR, zoom.ZOOM_FACTORS[0]);
    assert.equal(zoom.MAX_ZOOM_FACTOR, zoom.ZOOM_FACTORS[zoom.ZOOM_FACTORS.length - 1]);
});

check(() => {
    assert.equal(zoom.stepZoomFactor(1, 'in'), 1.1, 'in moves one step up');
    assert.equal(zoom.stepZoomFactor(1, 'out'), 0.9, 'out moves one step down');
    assert.equal(zoom.stepZoomFactor(1.75, 'reset'), 1, 'reset returns to 100%');
    assert.equal(zoom.stepZoomFactor(1.75, 'nonsense'), 1, 'an unknown action resets rather than drifts');
});

// The ends are walls, not wraps: zooming out at the minimum must not jump to 300%.
check(() => {
    assert.equal(zoom.stepZoomFactor(zoom.MAX_ZOOM_FACTOR, 'in'), zoom.MAX_ZOOM_FACTOR);
    assert.equal(zoom.stepZoomFactor(zoom.MIN_ZOOM_FACTOR, 'out'), zoom.MIN_ZOOM_FACTOR);
});

// Chromium keeps the zoom as a level, so a factor that goes to the window and
// comes back is only equal to within rounding. Stepping must not read
// 0.6700000000000002 as "already past 0.67" and skip a rung.
check(() => {
    const wobbled = 0.67 + 1e-15;
    assert.equal(zoom.nextZoomFactor(wobbled), 0.75, 'a rounding wobble does not skip a step up');
    assert.equal(zoom.previousZoomFactor(wobbled), 0.5, 'nor a step down');
});

// A hand-edited or corrupt settings file must not be able to shrink the window
// to nothing or blow it up past the ladder.
check(() => {
    assert.equal(zoom.normalizeZoomFactor(undefined), 1);
    assert.equal(zoom.normalizeZoomFactor('nonsense'), 1);
    assert.equal(zoom.normalizeZoomFactor(0), 1, 'zero is not a zoom, it is a missing value');
    assert.equal(zoom.normalizeZoomFactor(-2), 1);
    assert.equal(zoom.normalizeZoomFactor(Infinity), 1);
    assert.equal(zoom.normalizeZoomFactor(99), zoom.MAX_ZOOM_FACTOR);
    assert.equal(zoom.normalizeZoomFactor(0.01), zoom.MIN_ZOOM_FACTOR);
    // A value between two rungs is legal -- it just is not somewhere the
    // buttons can put you.
    assert.equal(zoom.normalizeZoomFactor(1.33), 1.33);
});

check(() => {
    assert.equal(zoom.zoomPercent(1.25), 125);
    assert.equal(zoom.zoomPercent(0.67), 67);
});

// ─── One apply path ───────────────────────────────────────────────────────

check(() => {
    const apply = from(electronMain, 'function applyZoomFactor', 700);
    assert.match(apply, /setZoomFactor\(next\)/, 'it zooms the window');
    assert.match(apply, /omv:zoom-changed/, 'and tells the renderer, so the menu percentage follows');
    assert.match(apply, /scheduleZoomFactorWrite\(\)/, 'and remembers the choice');
});

// Both entry points must go through it, or the keyboard and the buttons end up
// with two ladders and the menu shows a percentage the window does not have.
check(() => {
    const keyboard = from(electronMain, "win.webContents.on('before-input-event'", 1200);
    assert.match(keyboard, /applyZoomFactor\(win, stepZoomFactor\(/, 'the accelerators apply through the shared path');
    for (const key of ['+', '=', '-', '_', '0']) {
        assert.ok(keyboard.includes(`'${key}'`), `Ctrl ${key} is handled`);
    }
    assert.match(keyboard, /darwin'\s*\?\s*input\.meta\s*:\s*input\.control/, 'Cmd on macOS, Ctrl elsewhere');

    const handler = from(electronMain, "ipcMain.handle('omv:set-zoom'", 400);
    assert.match(handler, /applyZoomFactor\(win, stepZoomFactor\(desktopZoomFactor, options\?\.action\)\)/,
        'the menu applies through the same path');
    // A direction, not a number: nothing arbitrary crosses the bridge.
    assert.ok(!/options\.factor/.test(handler), 'the renderer cannot name a raw factor');
});

// ─── It survives a restart, and a moved port ──────────────────────────────

check(() => {
    assert.match(electronMain, /desktopSettingsPath[\s\S]{0,200}getPath\('userData'\)/,
        'the setting lives in userData, not in the renderer');
    // Origin-scoped storage would be per-port, and the local server walks from
    // 8876 to 8877+ when a second instance is running -- the setting would
    // vanish on that run. (Matching a use, not the comment that says why not.)
    assert.ok(!/localStorage\s*[.[]/.test(electronMain), 'and not in origin-scoped storage');
    assert.match(from(electronMain, 'function writeZoomFactorNow', 500), /writeFileSync\(desktopSettingsPath\(\)/,
        'the write lands in that file');
});

check(() => {
    const create = from(electronMain, 'async function createWindow', 2600);
    assert.match(create, /zoomFactor: startupZoomFactor/, 'the first frame is already zoomed, so it does not jump');
    assert.match(create, /did-finish-load[\s\S]{0,220}setZoomFactor\(desktopZoomFactor\)/,
        'and it is re-applied after each load, including a reload after a crash');
});

check(() => {
    assert.match(electronMain, /app\.on\('before-quit', flushZoomFactorWrite\)/,
        'a pending debounced write is flushed on quit');
    // An unref'd timer here does not schedule its own wake-up of the main
    // process's Node loop: on an idle app it never fired, and the setting was
    // silently never saved. Found by watching for the file and not seeing it.
    assert.ok(!/unref/.test(from(electronMain, 'function scheduleZoomFactorWrite', 300)),
        'the debounce timer is not unref\'d, or it never fires');
});

// ─── The bridge ───────────────────────────────────────────────────────────

check(() => {
    assert.match(preload, /getZoom: \(\) => ipcRenderer\.invoke\('omv:get-zoom'\)/);
    assert.match(preload, /setZoom: action => ipcRenderer\.invoke\('omv:set-zoom', \{ action \}\)/);
    // Returning the unsubscribe is what keeps a re-render from stacking listeners.
    assert.match(from(preload, 'onZoomChanged:', 500), /removeListener\('omv:zoom-changed', listener\)/);
});

// ─── The row, and where it does not appear ────────────────────────────────

check(() => {
    const row = from(uiMethods, 'proto._createZoomRow', 2600);
    assert.match(row, /if \(!this\.capabilities\?\.isDesktop \|\| !desktop\?\.setZoom\) return null/,
        'the web build never gets the row -- the browser already zooms there');
    assert.match(row, /makeButton\('out'/, 'zoom out');
    assert.match(row, /makeButton\('in'/, 'zoom in');
    assert.match(row, /makeButton\('reset'[\s\S]{0,60}extra-zoom-value/, 'the percentage readout is the reset button');
    // It opened hardcoded at "100%" once, while the window was at 80%.
    assert.match(row, /makeButton\('reset', this\._zoomPercentLabel\(\)/,
        'and it opens showing the zoom actually in force');
    assert.match(row, /e\.stopPropagation\(\)/, 'clicking a zoom button does not close the menu');
    assert.match(row, /extra-menu-static/, 'it is a row, not a menu action');
});

check(() => {
    const menu = from(uiMethods, 'proto._renderExtraMenu', 9000);
    const items = menu.slice(menu.indexOf('const items = ['));
    assert.match(items.slice(0, 400), /zoomRow = this\._createZoomRow\(\)[\s\S]{0,80}items\.push\(zoomRow\)/,
        'the row is added to the menu, next to the other display settings');
});

// Ctrl +/- change the zoom behind the menu's back; the readout has to follow or
// it becomes a lie the moment the user touches the keyboard.
check(() => {
    const init = from(uiMethods, 'proto._initDesktopZoom', 1400);
    assert.match(init, /desktop\.onZoomChanged\?\.\(/, 'the renderer subscribes to keyboard-driven changes');
    assert.match(init, /this\._updateZoomReadout\(\)/, 'and refreshes the percentage');

    const update = from(uiMethods, 'proto._zoomPercentLabel', 900);
    assert.match(update, /Math\.round\(\(this\._desktopZoom\?\.factor \|\| 1\) \* 100\)/, 'shown as a percentage');
    assert.match(update, /_zoomOutBtn\.disabled/, 'the buttons go flat at the ends of the ladder');
    assert.match(update, /_zoomInBtn\.disabled/);
});

check(() => {
    assert.match(baseCss, /\.extra-zoom-value \{[\s\S]{0,220}tabular-nums/,
        'the readout uses tabular figures so the row does not twitch between 90% and 100%');
});

// ─── Wording ──────────────────────────────────────────────────────────────

check(() => {
    for (const lang of LANGS) {
        for (const key of ['extraZoom', 'extraZoomTooltip', 'extraZoomIn', 'extraZoomOut', 'extraZoomReset']) {
            assert.ok(translations[lang]?.[key], `${lang}.${key} exists`);
        }
        // The keyboard is the discoverability problem here: without a menu bar
        // nothing else tells the user the accelerators exist.
        assert.match(translations[lang].extraZoomTooltip, /Ctrl/, `${lang} mentions the accelerators`);
    }
});

console.log(`desktop zoom: ${checks} checks passed`);
