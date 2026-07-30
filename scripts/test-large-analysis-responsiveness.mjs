import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
    estimateFftDurationMs,
    FFT_AUTO_SLOW_MS,
    FFT_AUTO_TARGET_POINTS,
    selectFftRange,
} from '../src/utils/fft.js';
import translations from '../src/i18n/translations.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Range extraction from a huge monotonic signal must be logarithmic. These
// virtual arrays make a linear implementation impractical while recording the
// number of indexed reads performed by the binary-search path.
let timeReads = 0;
const length = 100_000_000;
const virtualTimes = new Proxy({
    length,
    slice: (start, end) => ({ start, end, length: end - start }),
}, {
    get(target, key) {
        if (key in target) return target[key];
        const index = Number(key);
        if (Number.isInteger(index)) {
            timeReads++;
            return index * 0.01;
        }
        return undefined;
    },
});
const virtualValues = {
    length,
    slice: (start, end) => ({ start, end, length: end - start }),
};
const selected = selectFftRange(virtualTimes, virtualValues, [1234.5, 1235.5]);
assert.equal(selected.times.length, 101);
assert.equal(selected.values.length, 101);
assert.ok(timeReads < 200, `binary selection should not scan the signal (${timeReads} reads)`);
assert.ok(estimateFftDurationMs(length, 1) > FFT_AUTO_SLOW_MS);

const fft = read('src/plots/methods/fft-methods.js');
assert.match(fft, /setTimeout\(async \(\) => \{\s*await this\._prepareFftAutoRange/s);
assert.match(fft, /const run = async \(\) => \{[\s\S]*await this\._prepareFftAutoRange[\s\S]*this\._refreshFftSpectrumPlot/);
assert.match(fft, /if \(adjusted\) \{[\s\S]*_updateFftSelectionShapes[\s\S]*_refreshFftWindowedOverlayIfNeeded/);
assert.match(fft, /const needsInitialLimit = estimatedMs > FFT_AUTO_SLOW_MS/);
assert.match(fft, /_setFftStatus\(plot, i18n\.t\('fftCalculating'\), 'loading'\)/);
assert.match(fft, /await new Promise\(resolve => setTimeout\(resolve, 0\)\)/);
assert.match(fft, /FFT_AUTO_TARGET_POINTS \/ state\.zeroPaddingFactor/);
assert.match(fft, /_buildFftTimeTraces\(plot\), this\._buildFftTimeLayout\(plot, fullTimeRange\)/);
const cleanBlock = fft.match(/const blockIsClean = start => \{[\s\S]*?\n    \};/)?.[0] || '';
assert.ok(cleanBlock, 'FFT clean-block validator exists');
assert.doesNotMatch(cleanBlock, /await|setTimeout/, 'first bounded FFT block is validated without timer delays');
assert.match(fft, /state\.autoRangeLimited = true/);
assert.match(fft, /_dismissFftAutoRangeWarning[\s\S]*state\.autoRangeWarning = null/);

// Manual oversized selections must be clamped by the same bounded preflight
// used on initial entry, before any full-range slice/copy is attempted.
{
    const start = fft.indexOf('proto._prepareFftAutoRange = async function');
    const end = fft.indexOf('\nproto.', start + 1);
    assert.ok(start >= 0 && end > start, 'FFT preflight method can be isolated');
    const preflightProto = {};
    vm.runInNewContext(fft.slice(start, end), {
        proto: preflightProto,
        estimateFftDurationMs,
        FFT_AUTO_SLOW_MS,
        FFT_AUTO_TARGET_POINTS,
        i18n: {
            t: key => key === 'fftAutoRangeWarning'
                ? 'estimated {seconds}; selected {samples}'
                : 'estimated {seconds}; selected {samples}',
        },
        setTimeout,
    });
    let preflightTimeReads = 0;
    let preflightValueReads = 0;
    const hugeLength = 20_000_000;
    const hugeTimes = new Proxy({ length: hugeLength }, {
        get(target, key) {
            if (key in target) return target[key];
            const index = Number(key);
            if (Number.isInteger(index)) {
                preflightTimeReads++;
                return index;
            }
            return undefined;
        },
    });
    const hugeValues = new Proxy({ length: hugeLength }, {
        get(target, key) {
            if (key in target) return target[key];
            const index = Number(key);
            if (Number.isInteger(index)) {
                preflightValueReads++;
                return 1;
            }
            return undefined;
        },
    });
    const state = {
        rangeFull: false,
        autoRangeLimited: false,
        x1: 0,
        x2: hugeLength - 1,
        zeroPaddingFactor: 1,
    };
    const plot = {
        mode: 'fft',
        traces: [{ fileId: 'f', varName: 'Left' }],
        _fftPreparationToken: 1,
    };
    const harness = {
        _ensureFftState: () => state,
        _isVisible: () => true,
        _getTransformedTimeDataForVariable: () => hugeTimes,
        _getTransformedVariableData: () => hugeValues,
        _activeFftRange: () => [state.x1, state.x2],
        _syncFftOptionsPanel() {},
    };
    const adjusted = await preflightProto._prepareFftAutoRange.call(harness, 'panel', plot, 1);
    assert.equal(adjusted, true, 'oversized manual FFT selection is adjusted');
    assert.equal(state.x1, 0);
    assert.equal(state.x2, FFT_AUTO_TARGET_POINTS - 1);
    assert.equal(state.autoRangeLimited, true);
    assert.ok(preflightTimeReads < FFT_AUTO_TARGET_POINTS + 200,
        `preflight stays bounded (${preflightTimeReads} time reads)`);
    assert.ok(preflightValueReads <= FFT_AUTO_TARGET_POINTS,
        `preflight validates only the chosen block (${preflightValueReads} value reads)`);
}

const dataMethods = read('src/plots/methods/data-methods.js');
assert.match(dataMethods, /_buildTimeLayout = function\(plot, options = \{\}\)/);
assert.match(dataMethods, /boundedTimeRange[\s\S]*options\.timeRange/);
assert.match(dataMethods, /selectedCount = selectionEnd - selectionStart/);
assert.match(dataMethods, /estimatedMs = \(selectedCount \* traceCount \* factor\)/);
assert.match(dataMethods, /state\.autoRangeLimited = true/);

// Shared non-FFT preflight must count a manually selected span with binary
// bounds and clamp it before an analysis-specific sampler can scan the source.
{
    const start = dataMethods.indexOf('proto._autoLimitAnalysisRange = function');
    const end = dataMethods.indexOf('\n};', start + 1) + 3;
    assert.ok(start >= 0 && end > start, 'shared analysis preflight can be isolated');
    const preflightProto = {};
    vm.runInNewContext(dataMethods.slice(start, end), {
        proto: preflightProto,
        i18n: {
            t: () => 'estimated {seconds}; selected {samples}',
        },
    });
    const hugeLength = 20_000_000;
    let timeReads = 0;
    const times = new Proxy({ length: hugeLength }, {
        get(target, key) {
            if (key in target) return target[key];
            const index = Number(key);
            if (Number.isInteger(index)) {
                timeReads++;
                return index;
            }
            return undefined;
        },
    });
    const lowerBound = (array, target) => {
        let lo = 0;
        let hi = array.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (array[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const upperBound = (array, target) => {
        let lo = 0;
        let hi = array.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (array[mid] <= target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const state = {
        rangeFull: false,
        autoRangeLimited: false,
        x1: 0,
        x2: hugeLength - 1,
        warnings: [],
    };
    const harness = {
        files: new Map([['audio', { data: {} }]]),
        _isVisible: () => true,
        _getTransformedTimeDataForVariable: () => times,
        _lowerBound: lowerBound,
        _upperBound: upperBound,
    };
    const adjusted = preflightProto._autoLimitAnalysisRange.call(
        harness,
        { mode: 'histogram', traces: [{ fileId: 'audio', varName: 'Left' }] },
        state,
        'histogram',
    );
    assert.equal(adjusted, true, 'manual oversized analysis range is adjusted');
    assert.equal(state.rangeFull, false);
    assert.equal(state.x1, 0);
    assert.equal(state.x2, FFT_AUTO_TARGET_POINTS - 1);
    assert.ok(timeReads < 100, `shared preflight stays logarithmic (${timeReads} reads)`);
}

const interaction = read('src/plots/methods/interaction-methods.js');
assert.match(interaction, /plot\.traces\[result\.idx\] === result\.trace/);
assert.match(interaction, /fftMode && !fftSkipGlobalGaps \? this\._fftGapInfo\(plot\) : null/);
assert.match(fft, /_fftTimePaneShapes[\s\S]*_fftShouldSkipGlobalGapScan\(plot\)[\s\S]*return this\._fftSelectionShapes\(plot\)/);
assert.match(fft, /_fftGapsOverlapAnalyzedRange[\s\S]*_fftShouldSkipGlobalGapScan\(plot\)\) return false/);
assert.match(interaction, /_timeseriesNeedsEagerDetailLoading[\s\S]*LIVE_RELAYOUT_MAX_SOURCE_POINTS/);
assert.match(interaction, /plot\?\.mode !== 'timeseries' && plot\?\.mode !== 'fft'/);
assert.match(interaction, /_runWithEagerDetailLoading[\s\S]*_yieldForDetailIndicatorPaint/);
assert.match(interaction, /plot\._eagerDetailLoadingCount = \(plot\._eagerDetailLoadingCount \|\| 0\) \+ 1/);
assert.match(interaction, /traceBuildRange = null/);
assert.match(fft, /plot\.div\.addEventListener\('click'[\s\S]*event\.detail !== 2[\s\S]*_runWithEagerDetailLoading[\s\S]*capture: true/);
assert.match(fft, /_buildFftTimeTraces\(plot\), this\._buildFftTimeLayout\(plot, fullTimeRange\)/);
assert.match(fft, /largeFftOverview[\s\S]*_fullVisualCache\?\.visual\?\.y/);

assert.match(dataMethods, /_fullVisualCache[\s\S]*timeData[\s\S]*values[\s\S]*target/);
assert.match(dataMethods, /Object\.defineProperty\(t, '_fullVisualCache'/);

const manager = read('src/plots/plot-manager.js');
assert.match(manager, /Object\.defineProperty\(clone, '_fullVisualCache'/);
assert.match(manager, /_eagerInitialDetailDeferred[\s\S]*_yieldForDetailIndicatorPaint/);
assert.match(manager, /autoZoomAll[\s\S]*_runWithEagerDetailLoading/);
assert.match(manager, /plot\.mode === 'timeseries'[\s\S]*addEventListener\('click'[\s\S]*event\.detail !== 2[\s\S]*_runWithEagerDetailLoading[\s\S]*capture: true/);
for (const token of [
    '_fftToken', '_histToken', '_calendarHeatmapToken',
    '_temporalProfileToken', '_integralToken', '_correlationToken',
    '_phase2dLazyToken',
]) {
    assert.ok(manager.includes(token), `panel cancellation invalidates ${token}`);
}

const analysisHooks = {
    histogram: 'src/plots/methods/histogram-methods.js',
    heatmap: 'src/plots/methods/heatmap-methods.js',
    'temporal-profile': 'src/plots/methods/temporal-profile-methods.js',
    integral: 'src/plots/methods/integral-methods.js',
    correlation: 'src/plots/methods/correlation-methods.js',
    phase2d: 'src/plots/methods/phase2d-fit-methods.js',
};
for (const [mode, path] of Object.entries(analysisHooks)) {
    assert.ok(read(path).includes(`_autoLimitAnalysisRange(plot, state, '${mode}')`), `${mode} uses the shared analysis budget`);
}
assert.match(read(analysisHooks.phase2d), /state\.timeSeriesHidden = false/);

for (const [language, strings] of Object.entries(translations)) {
    assert.ok(strings.fftAutoRangeWarning, `${language}: FFT auto-range warning`);
    assert.ok(strings.analysisAutoRangeWarning, `${language}: generic analysis auto-range warning`);
}

console.log('Large-analysis responsiveness checks passed.');
