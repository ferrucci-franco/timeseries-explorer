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

// ── A refused RANGE lands on the largest one that fits ─────────────────────
// Falling back to the last accepted range answers a different question. On the
// reported file, asking for the whole 26,460,000 samples was refused and handed
// back the 262,144-sample preview — 1% of the signal — while the ceiling allows
// 16,777,216, or 63% of it. The user could then widen it by hand, which is what
// made the "narrow the selection" message read as wrong.
{
    const HARD = 16777216;
    const TOTAL = 26460000;
    // Index i is at i/44100 seconds; only length and indexing are exercised.
    const times = new Proxy({ length: TOTAL }, {
        get: (t, key) => (key in t ? t[key] : (Number.isInteger(Number(key)) ? Number(key) / 44100 : undefined)),
    });
    const largest = isolate('_largestFittingFftRange', { normalizeZeroPaddingFactor });
    const clamp = isolate('_clampFftRangeToLimit', { normalizeZeroPaddingFactor });
    const makeRangeApp = (state) => ({
        _ensureFftState: () => state,
        _isVisible: () => true,
        _getTransformedTimeDataForVariable: () => times,
        _canUseFftWorker: () => true,
        _fftComputationMaxNfft: () => HARD,
        _fftLiveMaxNfft: () => 4194304,
        _lowerBound: (arr, value) => Math.max(0, Math.min(TOTAL, Math.ceil(value * 44100))),
        _largestFittingFftRange: largest,
    });
    const plot = { traces: [{ fileId: 'f1', varName: 'Left' }] };

    // Full range refused: clamp to the ceiling, not back to the preview.
    {
        const state = { rangeFull: true, x1: null, x2: null, zeroPaddingFactor: 1 };
        const fitting = clamp.call(makeRangeApp(state), plot, state);
        assert.ok(fitting, 'a refused full range must be clamped');
        assert.equal(fitting.samples, HARD, 'clamped to exactly the NFFT ceiling in samples');
        assert.equal(state.rangeFull, false, 'the range becomes an explicit selection');
        assert.equal(state.x1, 0, 'anchored at the start of the data');
        assert.ok(Math.abs(state.x2 - (HARD - 1) / 44100) < 1e-9, 'and ends at the last sample that fits');
        assert.equal(state.autoRangeFocusPending, true, 'the view moves onto the clamped window');
        assert.equal(plot._fftPreflightTooLarge, null, 'the refusal is cleared before recomputing');
    }

    // Zero padding divides the budget, so the window shrinks with it.
    for (const [padding, expected] of [[2, HARD / 2], [4, HARD / 4], [16, HARD / 16]]) {
        const state = { rangeFull: true, x1: null, x2: null, zeroPaddingFactor: padding };
        const fitting = clamp.call(makeRangeApp(state), plot, state);
        assert.equal(fitting.samples, expected, `x${padding} padding allows ${expected} samples`);
    }

    // The clamp keeps where the user started rather than jumping to zero.
    {
        const state = { rangeFull: false, x1: 100, x2: 600, zeroPaddingFactor: 1 };
        const fitting = clamp.call(makeRangeApp(state), plot, state);
        assert.ok(Math.abs(fitting.x1 - 100) < 1e-6, 'the clamped window starts where the selection did');
        assert.ok(fitting.samples <= HARD, 'and still fits');
    }

    // Already at the largest fitting range: refuse, so the caller falls through
    // to reverting the padding instead of resubmitting the same request.
    {
        const state = { rangeFull: false, x1: 0, x2: (HARD - 1) / 44100, zeroPaddingFactor: 1 };
        assert.equal(clamp.call(makeRangeApp(state), plot, state), null,
            'clamping to the range already set must be refused, or the recompute loops');
    }

    // A selection near the end of the data cannot grow past it.
    {
        const state = { rangeFull: false, x1: (TOTAL - 1000) / 44100, x2: 600, zeroPaddingFactor: 1 };
        const fitting = clamp.call(makeRangeApp(state), plot, state);
        assert.ok(!fitting || fitting.samples <= 1000, 'the window never runs past the end of the data');
    }
}

// ── The refusal path must actually use it ──────────────────────────────────
assert.match(fft, /_clampFftRangeToLimit\(plot, state\)/,
    'the preflight refusal must try the clamp before giving up on the range');
assert.match(fft, /'tooManyPointsClamped'/,
    'a clamped refusal must say the selection was reduced to the largest that fits');
assert.equal(
    (read('src/i18n/translations.js').match(/fftWarningTooManyClamped:/g) || []).length, 4,
    'the clamped warning is translated in all four languages',
);

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


// ── "FFT ready" reports how much was transformed ───────────────────────────
// A bare "FFT ready" leaves the one question a large file raises unanswered:
// how much of it does this spectrum actually describe.
{
    const i18n = (await import('../src/i18n/index.js')).default;
    // currentLang directly rather than setLanguage(): the setter repaints the
    // DOM, which does not exist here, and the formatting is what is under test.
    const withLanguage = (lang, run) => {
        const previous = i18n.currentLang;
        i18n.currentLang = lang;
        try { return run(); } finally { i18n.currentLang = previous; }
    };

    const formatted = new Map();
    for (const lang of ['en', 'fr', 'es', 'it']) {
        withLanguage(lang, () => {
            const count = i18n.formatNumber(16777216);
            assert.match(count, /\d/, `${lang} formats digits`);
            assert.doesNotMatch(count, /e\+|NaN|undefined/i, `${lang} prints no exponent and no non-number`);
            assert.notEqual(count, '16777216', `${lang} groups thousands rather than running them together`);
            formatted.set(lang, count);

            const template = i18n.t('fftReadySamples');
            assert.notEqual(template, 'fftReadySamples', `${lang} translates the ready message`);
            assert.match(template, /\{samples\}/, `${lang} keeps the placeholder to substitute`);
            const message = template.replace('{samples}', count);
            assert.doesNotMatch(message, /\{samples\}/, `${lang} substitutes the placeholder`);
            assert.ok(message.includes(count), `${lang} keeps the number in the message`);
        });
    }

    // The unit noun lives inside each translated string, so it cannot be left
    // in English by a caller that forgets to translate it separately.
    for (const [lang, word] of [['fr', 'echantillons'], ['es', 'muestras'], ['it', 'campioni']]) {
        withLanguage(lang, () => {
            const template = i18n.t('fftReadySamples');
            assert.match(template, new RegExp(word, 'i'), `${lang} names the unit in its own language`);
            // Compared with the placeholder removed: {samples} is the
            // substitution token, not the English noun.
            assert.doesNotMatch(template.replace('{samples}', ''), /samples/i,
                `${lang} must not fall back to the English word`);
        });
    }

    // Separators differ between these locales, so a number formatted for the
    // browser instead of the chosen language is visibly wrong in at least one.
    assert.notEqual(formatted.get('en'), formatted.get('es'),
        'en and es must not share a thousands separator, or the language is being ignored');

    // Degenerate input must never reach the topbar as "NaN" or "Infinity".
    for (const bad of [NaN, undefined, null, 'abc', Infinity, -Infinity]) {
        assert.doesNotMatch(i18n.formatNumber(bad), /NaN|Infinity/, `${String(bad)} must not print as a number`);
    }
    assert.equal(i18n.formatNumber(0), '0', 'zero is a real count, not an absent one');

    // Reported only when every plotted trace agrees; overlaid files can carry
    // different lengths and naming one of them would be a guess.
    assert.match(fft, /sampleCounts\.size === 1/, 'the count is shown only when the traces agree');
    assert.match(fft, /sampleCounts\.add\(spectrum\.n\)/, 'it comes from what was actually transformed');
    assert.match(fft, /i18n\.formatNumber\(/, 'and it is formatted for the chosen language');
}

console.log('FFT refused-settings and ready-status checks passed.');
