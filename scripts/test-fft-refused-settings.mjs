// When the FFT platform limit refuses a (range, zero padding) combination, the
// panel must not simply stop.
//
// The preflight used to detect the over-limit request and return: no recompute,
// nothing on screen changed. The spectrum from the PREVIOUS settings stayed up
// while the controls showed the new ones, so the plot described a range and a
// padding that had not produced it. Zero padding above x1 reaches the ceiling
// 2 to 16 times sooner, which is why raising it looked like the control did
// nothing, and why widening the range afterwards appeared not to relaunch
// anything — every later request was refused the same silent way.
//
// The rule this pins: what is drawn always matches what the controls say.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const fft = read('src/plots/methods/fft-methods.js');

const isolate = (name, context = {}) => {
    const start = fft.indexOf(`proto.${name} = function`);
    assert.ok(start >= 0, `${name} is declared`);
    const end = fft.indexOf('\n};', start);
    assert.ok(end > start, `${name} can be isolated`);
    const proto = {};
    vm.runInNewContext(fft.slice(start, end + '\n};'.length), { proto, ...context });
    return proto[name];
};

const normalizeZeroPaddingFactor = value => {
    const n = Number(value);
    return [1, 2, 4, 8, 16].includes(n) ? n : 1;
};
const remember = isolate('_rememberAcceptedFftSettings', { normalizeZeroPaddingFactor });
const revert = isolate('_revertFftToLastAccepted', { normalizeZeroPaddingFactor });

const makeApp = (state) => ({
    _ensureFftState: () => state,
    _rememberAcceptedFftSettings: remember,
    _revertFftToLastAccepted: revert,
});

// ── Only a combination that actually produced a spectrum is remembered ─────
{
    const state = { rangeFull: false, x1: 0, x2: 30, zeroPaddingFactor: 4 };
    const plot = {};
    remember.call(makeApp(state), plot);
    assert.deepEqual(
        { ...plot._fftLastAccepted },
        { rangeFull: false, x1: 0, x2: 30, zeroPaddingFactor: 4 },
        'the accepted range and padding are recorded together',
    );
    // Recorded normalised, so a later comparison cannot fail on '4' vs 4.
    const other = { rangeFull: true, x1: null, x2: null, zeroPaddingFactor: '8' };
    remember.call(makeApp(other), plot);
    assert.equal(plot._fftLastAccepted.zeroPaddingFactor, 8, 'the padding is normalised when recorded');
    assert.equal(plot._fftLastAccepted.rangeFull, true, 'a full range is recorded as such');
}

// ── Raising the padding past the ceiling restores the padding ──────────────
{
    const state = { rangeFull: false, x1: 0, x2: 30, zeroPaddingFactor: 4 };
    const plot = {};
    remember.call(makeApp(state), plot);
    // The user picks x16 over the same 30 s: 2^21 x 16 = 33,554,432 NFFT.
    state.zeroPaddingFactor = 16;
    plot._fftPreflightTooLarge = { n: 1323001, nfft: 33554432, maxNfft: 16777216 };

    const reverted = revert.call(makeApp(state), 'p1', plot, state);
    assert.equal(reverted, true, 'a refused padding falls back to the accepted one');
    assert.equal(state.zeroPaddingFactor, 4, 'the padding is restored');
    assert.equal(state.x2, 30, 'and the range the user did not touch is left alone');
    assert.equal(plot._fftPreflightTooLarge, null, 'the refusal is cleared before recomputing');
    assert.equal(state.autoRangeFocusPending, true, 'the view follows the restored range');
}

// ── Widening the range past the ceiling restores the range ─────────────────
{
    const state = { rangeFull: false, x1: 0, x2: 30, zeroPaddingFactor: 4 };
    const plot = {};
    remember.call(makeApp(state), plot);
    // Same padding, but now 120 s: 2^23 x 4 = 33,554,432 NFFT.
    state.x2 = 120;
    plot._fftPreflightTooLarge = { n: 5292001, nfft: 33554432, maxNfft: 16777216 };

    const reverted = revert.call(makeApp(state), 'p1', plot, state);
    assert.equal(reverted, true, 'a refused range falls back to the accepted one');
    assert.equal(state.x2, 30, 'the range is restored');
    assert.equal(state.zeroPaddingFactor, 4, 'and the padding the user did not touch is left alone');
}

// A restored full range must come back as Full, not as a selection spanning
// everything — those are different states for every downstream reader.
{
    const state = { rangeFull: true, x1: null, x2: null, zeroPaddingFactor: 1 };
    const plot = {};
    remember.call(makeApp(state), plot);
    Object.assign(state, { rangeFull: false, x1: 0, x2: 120, zeroPaddingFactor: 16 });
    assert.equal(revert.call(makeApp(state), 'p1', plot, state), true, 'reverts');
    assert.equal(state.rangeFull, true, 'Full comes back as Full');
    assert.equal(state.x1, null, 'with no residual selection bounds');
    assert.equal(state.x2, null);
}

// ── The loop guards ────────────────────────────────────────────────────────

// Nothing accepted yet: the very first attempt was already too large, so there
// is nothing to fall back to and the plain refusal must stand.
{
    const state = { rangeFull: true, x1: null, x2: null, zeroPaddingFactor: 16 };
    const plot = {};
    assert.equal(revert.call(makeApp(state), 'p1', plot, state), false,
        'with no accepted settings the refusal stands and the controls stay put');
    assert.equal(state.zeroPaddingFactor, 16, 'the user\'s choice is not silently undone');
}

// Already sitting on the accepted combination: reverting would re-submit the
// same refused request forever.
{
    const state = { rangeFull: false, x1: 0, x2: 30, zeroPaddingFactor: 4 };
    const plot = {};
    remember.call(makeApp(state), plot);
    assert.equal(revert.call(makeApp(state), 'p1', plot, state), false,
        'reverting to what is already set must be refused, or the recompute loops');
}

// A padding that differs only in type must count as unchanged for the same
// reason — otherwise '4' vs 4 would drive an endless revert/recompute cycle.
{
    const state = { rangeFull: false, x1: 0, x2: 30, zeroPaddingFactor: 4 };
    const plot = {};
    remember.call(makeApp(state), plot);
    state.zeroPaddingFactor = '4';
    assert.equal(revert.call(makeApp(state), 'p1', plot, state), false,
        'a padding equal after normalisation is not a change');
}

// ── The refusal path must actually use it ──────────────────────────────────
// A revert helper the preflight never calls protects nothing.
assert.match(fft, /_revertFftToLastAccepted\(panelId, plot, state\)/,
    'the preflight refusal must attempt the revert');
assert.match(fft, /'tooManyPointsReverted'/,
    'a reverted refusal must say that the previous settings were restored');
assert.match(fft, /fftWarningTooManyReverted/,
    'and that message must exist in the warning builder');
// Recording happens only where a spectrum came out, never before.
assert.match(fft, /if \(spectra\.length\) this\._rememberAcceptedFftSettings\(plot\)/,
    'settings are remembered only once they have produced a spectrum');

// Every language must carry the reverted wording, or three of them fall back to
// a message that does not mention the restore.
const translations = read('src/i18n/translations.js');
assert.equal(
    (translations.match(/fftWarningTooManyReverted:/g) || []).length, 4,
    'the reverted warning is translated in all four languages',
);

console.log('FFT refused-settings checks passed.');
