// Issue #54: the FFT panel recomputed the transform for things that cannot
// change it.
//
// Hiding a curve, closing one, and switching the amplitude scale to dB all went
// through the same full recompute as a new range: the "Computing FFT" pill came
// up and the panel spent seconds arriving at a spectrum it already had. None of
// those three touches what the transform reads — the remaining curves keep the
// same samples, and dB is a remap of the amplitudes that came out of it.
//
// What this pins:
//   1. the amplitude scale is a pure remap, identical to computing with it;
//   2. the cache key covers exactly what the transform depends on — and nothing
//      the panel can change without changing it;
//   3. spectra are reused, with both cache budgets bounding what is held;
//   4. the recompute path consults the cache, computes linear, and only claims
//      to be computing when it is;
//   5. closing a curve updates the panel in place instead of rebuilding it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
    applyAmplitudeScale,
    computeAmplitudeSpectrum,
    normalizeFftWindow,
    normalizeZeroPaddingFactor,
} from '../src/utils/fft.js';

const fftMethodsSource = readFileSync(new URL('../src/plots/methods/fft-methods.js', import.meta.url), 'utf8');
const plotManagerSource = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');

const isolate = (name, context = {}) => {
    const start = fftMethodsSource.indexOf(`proto.${name} = function`);
    assert.ok(start >= 0, `${name} is declared`);
    const end = fftMethodsSource.indexOf('\n};', start);
    assert.ok(end > start, `${name} can be isolated`);
    const proto = {};
    vm.runInNewContext(fftMethodsSource.slice(start, end + '\n};'.length), { proto, ...context });
    return proto[name];
};

const signal = ({ n = 4096, fs = 100, frequency = 7 } = {}) => {
    const times = new Float64Array(n);
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        times[i] = i / fs;
        values[i] = Math.sin(2 * Math.PI * frequency * times[i]);
    }
    return { times, values };
};

// ── 1. dB is a remap, not another transform ───────────────────────────────
{
    const { times, values } = signal();
    const linear = computeAmplitudeSpectrum({ times, values, amplitudeScale: 'normal' });
    assert.equal(linear.ok, true, 'the linear spectrum is computed');

    for (const scale of ['db', 'dbRelative']) {
        const computed = computeAmplitudeSpectrum({ times, values, amplitudeScale: scale });
        const remapped = applyAmplitudeScale(linear.rawAmplitudes, scale);
        assert.equal(computed.amplitudes.length, remapped.amplitudes.length, `${scale} keeps the bin count`);
        for (let k = 0; k < computed.amplitudes.length; k++) {
            assert.equal(
                remapped.amplitudes[k],
                computed.amplitudes[k],
                `${scale} bin ${k} matches a spectrum computed in that scale`,
            );
        }
    }

    // Linear hands back the amplitudes themselves: the common case must not
    // allocate a second copy of a spectrum that can hold millions of bins.
    const asLinear = applyAmplitudeScale(linear.rawAmplitudes, 'normal');
    assert.equal(asLinear.amplitudes, linear.rawAmplitudes, 'linear reuses the computed amplitudes');
    assert.deepEqual(asLinear.warnings, [], 'linear has nothing to warn about');
}

// ── dB relative to a spectrum with no peak still reports it ───────────────
{
    const n = 256;
    const times = new Float64Array(n);
    const values = new Float64Array(n); // all zeros: nothing to be relative to
    for (let i = 0; i < n; i++) times[i] = i / 50;
    const linear = computeAmplitudeSpectrum({ times, values, amplitudeScale: 'normal' });
    assert.equal(linear.ok, true, 'a flat signal still transforms');
    assert.deepEqual(linear.warnings, [], 'the transform itself has no scale warning to give');

    const remapped = applyAmplitudeScale(linear.rawAmplitudes, 'dbRelative');
    assert.deepEqual(remapped.warnings, ['noSpectralContent'], 'the warning belongs to the scale step');
    const computed = computeAmplitudeSpectrum({ times, values, amplitudeScale: 'dbRelative' });
    assert.deepEqual(computed.warnings, ['noSpectralContent'], 'computing in that scale reports the same');
}

// ── 2. What the cache key does and does not depend on ─────────────────────
const fftDataTokens = new WeakMap();
const cacheContext = () => ({
    fftDataTokens,
    fftDataTokenSeq: 0,
    normalizeFftWindow,
    normalizeZeroPaddingFactor,
    FFT_SPECTRUM_CACHE_MAX_ENTRIES: 3,
    FFT_SPECTRUM_CACHE_MAX_BINS: 1000,
});
const dataToken = isolate('_fftDataToken', cacheContext());
const cacheKey = isolate('_fftSpectrumCacheKey', cacheContext());
const cachedSpectrum = isolate('_cachedFftSpectrum', cacheContext());
const rememberSpectrum = isolate('_rememberFftSpectrum', cacheContext());

const makeApp = (caches) => ({
    files: new Map([...caches.keys()].map(fileId => [fileId, {}])),
    _transformCache: fileId => caches.get(fileId),
    _fftDataToken: dataToken,
    _fftComputationMaxNfft: () => 2 ** 24,
    _cachedFftSpectrum: cachedSpectrum,
    _rememberFftSpectrum: rememberSpectrum,
});

{
    const caches = new Map([['f1', { series: new Map() }], ['f2', { series: new Map() }]]);
    const app = makeApp(caches);
    const trace = { fileId: 'f1', varName: 'speed' };
    const base = {
        rangeFull: true,
        windowType: 'hann',
        removeMean: true,
        zeroPaddingFactor: 4,
        amplitudeScale: 'normal',
    };
    const key = cacheKey.call(app, trace, [0, 30], base);
    assert.ok(key, 'a trace over a live file has a key');

    // The amplitude scale is not part of the transform.
    assert.equal(
        cacheKey.call(app, trace, [0, 30], { ...base, amplitudeScale: 'db' }),
        key,
        'switching to dB reuses the same spectrum',
    );
    assert.equal(
        cacheKey.call(app, trace, [0, 30], { ...base, amplitudeScale: 'dbRelative' }),
        key,
        'so does switching to dB relative',
    );

    // On the whole signal each trace transforms its own series, so the union
    // range of the panel must not enter the key: closing a longer curve would
    // otherwise invalidate the shorter ones for nothing.
    assert.equal(
        cacheKey.call(app, trace, [0, 120], base),
        key,
        'a wider panel domain does not invalidate a full-signal spectrum',
    );

    // Everything the transform actually reads does change it.
    const differs = (state, range, label) => assert.notEqual(cacheKey.call(app, trace, range, state), key, label);
    differs({ ...base, windowType: 'hamming' }, [0, 30], 'the window function is part of the key');
    differs({ ...base, removeMean: false }, [0, 30], 'mean removal is part of the key');
    differs({ ...base, zeroPaddingFactor: 8 }, [0, 30], 'zero padding is part of the key');
    differs({ ...base, rangeFull: false }, [0, 30], 'an explicit selection is not the whole signal');
    assert.notEqual(
        cacheKey.call(app, trace, [0, 30], { ...base, rangeFull: false }),
        cacheKey.call(app, trace, [0, 45], { ...base, rangeFull: false }),
        'a different selected span is a different spectrum',
    );
    assert.notEqual(
        cacheKey.call(app, { fileId: 'f1', varName: 'torque' }, [0, 30], base),
        key,
        'another variable is another spectrum',
    );
    assert.notEqual(
        cacheKey.call(app, { fileId: 'f2', varName: 'speed' }, [0, 30], base),
        key,
        'the same variable in another file is another spectrum',
    );

    // New data, a transform, a sign inversion and a live append all drop the
    // file's transform cache. That is the signal the key rides on.
    caches.set('f1', { series: new Map() });
    assert.notEqual(cacheKey.call(app, trace, [0, 30], base), key, 'changed data invalidates the spectrum');

    // A trace whose file is gone has no key at all, rather than one that could
    // collide with a future file.
    app.files.delete('f2');
    assert.equal(cacheKey.call(app, { fileId: 'f2', varName: 'speed' }, [0, 30], base), null, 'a closed file has no key');
}

// ── 3. Reuse, LRU order, and both budgets ─────────────────────────────────
{
    const caches = new Map([['f1', { series: new Map() }]]);
    const app = makeApp(caches);
    const plot = {};
    const spectrum = bins => ({ ok: true, rawAmplitudes: new Float64Array(bins) });

    rememberSpectrum.call(app, plot, 'a', spectrum(100));
    assert.equal(cachedSpectrum.call(app, plot, 'a').rawAmplitudes.length, 100, 'a stored spectrum comes back');
    assert.equal(cachedSpectrum.call(app, plot, 'zz'), null, 'an unknown key is a miss');
    assert.equal(cachedSpectrum.call(app, plot, null), null, 'a trace with no key never hits the cache');

    rememberSpectrum.call(app, plot, 'b', spectrum(100));
    rememberSpectrum.call(app, plot, 'c', spectrum(100));
    // 'a' is used again, so 'b' becomes the oldest and is the one dropped when
    // a fourth entry passes the 3-entry budget.
    cachedSpectrum.call(app, plot, 'a');
    rememberSpectrum.call(app, plot, 'd', spectrum(100));
    assert.equal(plot._fftSpectrumCache.size, 3, 'the entry budget is enforced');
    assert.equal(cachedSpectrum.call(app, plot, 'b'), null, 'the least recently used entry is the one evicted');
    assert.ok(cachedSpectrum.call(app, plot, 'a'), 'a recently used entry survives');
    assert.ok(cachedSpectrum.call(app, plot, 'd'), 'the entry just stored survives');

    // A single zero-padded spectrum can be tens of millions of bins, so the
    // second budget is on the bins themselves.
    rememberSpectrum.call(app, plot, 'huge', spectrum(2000));
    assert.equal(plot._fftSpectrumCache.size, 1, 'a spectrum over the bin budget evicts the rest');
    assert.ok(cachedSpectrum.call(app, plot, 'huge'), 'and the spectrum on screen is never the one freed');
}

// ── 4. The recompute path uses it ─────────────────────────────────────────
{
    const refreshStart = fftMethodsSource.indexOf('proto._refreshFftSpectrumPlot = async function');
    const refreshEnd = fftMethodsSource.indexOf('proto._buildFftSpectrumTrace = function');
    assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, '_refreshFftSpectrumPlot can be isolated');
    const refresh = fftMethodsSource.slice(refreshStart, refreshEnd);

    assert.match(
        refresh,
        /let spectrum = this\._cachedFftSpectrum\(plot, cacheKey\);\s*\n\s*if \(!spectrum\) \{/,
        'a cached spectrum short-circuits both the fetch and the transform',
    );
    assert.match(
        refresh,
        /this\._rememberFftSpectrum\(plot, cacheKey, spectrum\)/,
        'a freshly computed spectrum is stored for the next recompute',
    );
    assert.match(
        refresh,
        /const computing = cacheKeys\.some\(key => !this\._cachedFftSpectrum\(plot, key\)\)[\s\S]*?if \(computing\) \{[\s\S]*?_setFftComputing\(plot, true\)/,
        'the "computing" pill is only shown when something is actually computed',
    );
    assert.match(
        refresh,
        /applyAmplitudeScale\(spectrum\.rawAmplitudes, state\.amplitudeScale\)/,
        'the amplitude scale is applied to the cached amplitudes',
    );
    assert.match(
        refresh,
        /amplitudes: scaled\.amplitudes/,
        'and the scaled amplitudes are what the spectrum trace draws',
    );

    const computeStart = fftMethodsSource.indexOf('proto._computeFftSpectrumForSeries = async function');
    const compute = fftMethodsSource.slice(computeStart, fftMethodsSource.indexOf('\n};', computeStart));
    assert.match(
        compute,
        /amplitudeScale: 'normal'/,
        'the transform always runs linear, so its result is reusable in any scale',
    );
    assert.doesNotMatch(
        compute,
        /amplitudeScale: state\.amplitudeScale/,
        'the scale never reaches the transform',
    );
}

// ── 5. Closing a curve updates the panel instead of rebuilding it ─────────
{
    const start = fftMethodsSource.indexOf('proto._removeFftTraceFromLegend = function');
    assert.ok(start >= 0, '_removeFftTraceFromLegend is declared');
    const remove = fftMethodsSource.slice(start, fftMethodsSource.indexOf('\n};', start));
    assert.doesNotMatch(remove, /_rebuildPanel/, 'closing one curve no longer tears the whole panel down');
    assert.match(remove, /this\._clearPanel\(panelId\)/, 'closing the last curve still empties the panel');
    assert.match(remove, /this\._refreshFftTimePlot\(panelId, plot, \{ preserveView: true \}\)/, 'the time pane is refreshed in place');
    assert.match(remove, /this\._renderFftOptionsPanel\(panelId, plot\)/, 'and the options panel is rebuilt from the new time domain');
    assert.match(remove, /this\._scheduleFftRecompute\(panelId, \{ immediate: true \}\)/, 'the spectrum is refreshed from the cache');

    const legendStart = fftMethodsSource.indexOf('proto._handleFftLegendClick = function');
    const legend = fftMethodsSource.slice(legendStart, fftMethodsSource.indexOf('\n};', legendStart));
    assert.match(
        legend,
        /if \(shiftClick\) \{\s*\n\s*this\._removeFftTraceFromLegend\(panelId, plot, trace\);/,
        'shift-click removal takes the same in-place path',
    );
    assert.match(
        legend,
        /trace\.visible = trace\.visible === 'legendonly' \? true : 'legendonly'/,
        'a plain click still only toggles visibility',
    );
}

// ── The cache is dropped when the panel stops being an FFT ────────────────
{
    assert.match(
        plotManagerSource,
        /if \(mode !== 'fft'\) plot\._fftSpectrumCache = null;/,
        'leaving FFT mode frees the cached amplitudes',
    );
    assert.match(
        plotManagerSource,
        /existing\._fftSpectrumCache = null;/,
        'clearing a panel frees them too',
    );
}

console.log('FFT recompute cache tests passed');
