import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    estimateFftDurationMs,
    FFT_AUTO_SLOW_MS,
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
assert.match(fft, /_setFftStatus\(plot, i18n\.t\('fftCalculating'\), 'loading'\)/);
assert.match(fft, /await new Promise\(resolve => setTimeout\(resolve, 0\)\)/);
assert.match(fft, /FFT_AUTO_TARGET_POINTS \/ state\.zeroPaddingFactor/);
assert.match(fft, /_buildFftTimeLayout\(plot, visualRange\)/);
assert.match(fft, /_buildFftTimeTraces\(plot, visualRange\)/);

const dataMethods = read('src/plots/methods/data-methods.js');
assert.match(dataMethods, /_buildTimeLayout = function\(plot, options = \{\}\)/);
assert.match(dataMethods, /boundedTimeRange[\s\S]*options\.timeRange/);

const interaction = read('src/plots/methods/interaction-methods.js');
assert.match(interaction, /plot\.traces\[result\.idx\] === result\.trace/);

const manager = read('src/plots/plot-manager.js');
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
