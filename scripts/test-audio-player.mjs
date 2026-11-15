// Behavioural tests for src/plots/methods/audio-methods.js — the audio player
// behind a panel's 🔊 button (issue #89).
//
// The strip itself is DOM, and the sound is a browser's audio output; neither
// belongs here. What this covers is the part that decides WHAT is played and
// WHICH numbers come out of it: the playability gate, the range the panel
// hands over, the samples copied into the buffer, and the clock that places the
// playhead. Every one of these has a way of being wrong in silence — a window
// off by a few thousand samples, a mean not removed, a mark that lies about
// where the sound is — which is exactly what a test is for.
//
// The module installs its methods on a class, so the test installs them on a
// stand-in that carries only the collaborators they call.
import assert from 'node:assert/strict';
import { installPlotAudioMethods, positionInRange } from '../src/plots/methods/audio-methods.js';
import {
    AUDIO_PEAK,
    audioSamplesFromArrays,
    createAudioScan,
    finishAudioScan,
    scanAudioChunk,
    writeAudioChunk,
} from '../src/utils/audio-samples.js';

// ── A stand-in for PlotManager ────────────────────────────────────

class FakeManager {
    constructor() {
        this.plots = new Map();
        this.files = new Map();
        this.lazyFiles = new Set();
        this.timeKinds = new Map();
    }

    _isLazyFile(fileId) { return this.lazyFiles.has(fileId); }
    _fftTimeKind(fileId) { return this.timeKinds.get(fileId) || 'numeric'; }
    _hasContent(plot) { return (plot?.traces?.length || 0) > 0; }
    _traceName(varName) { return varName; }
    _getTransformedTimeDataForVariable(fileId, varName) { return this.files.get(`${fileId}/${varName}`)?.times; }
    _getTransformedVariableData(fileId, varName) { return this.files.get(`${fileId}/${varName}`)?.values; }
    _activeFftRange(plot) { return plot.fft?.rangeFull === false ? [plot.fft.x1, plot.fft.x2] : null; }
    _activeHistogramRange(plot) { return null; }
    _activeIntegralRange(plot) { return null; }

    addSignal(fileId, varName, { times, values }) {
        this.files.set(`${fileId}/${varName}`, { times, values });
    }

    addPanel(panelId, traces, extra = {}) {
        const plot = { mode: 'timeseries', traces, ...extra };
        this.plots.set(panelId, plot);
        return plot;
    }
}
installPlotAudioMethods(FakeManager);

/** A uniformly sampled signal: `seconds` of it at `rate`, from `fill(i, t)`. */
const signal = (rate, seconds, fill = () => 0) => {
    const n = Math.round(rate * seconds);
    const times = new Float64Array(n);
    const values = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        times[i] = i / rate;
        values[i] = fill(i, i / rate);
    }
    return { times, values };
};

/** Enough of an AudioContext to build a buffer, and to refuse a rate. */
const fakeContext = ({ sampleRate = 48000, accepts = () => true } = {}) => ({
    sampleRate,
    currentTime: 0,
    createBuffer(channels, length, rate) {
        if (!accepts(rate)) {
            const error = new Error(`unsupported sample rate ${rate}`);
            error.name = 'NotSupportedError';
            throw error;
        }
        const data = new Float32Array(length);
        return { numberOfChannels: channels, length, sampleRate: rate, duration: length / rate, getChannelData: () => data };
    },
});

// ── The playability gate, and what it says when it refuses ────────
{
    const manager = new FakeManager();
    manager.addSignal('f1', 'Left', signal(44100, 0.2, (i) => Math.sin(i / 20)));
    const status = manager._audioSourceStatus('f1', 'Left');
    assert.equal(status.ok, true, 'a uniformly sampled recording is playable');
    assert.ok(Math.abs(status.sampleRate - 44100) < 1e-6, 'the sample rate comes back from the time vector');

    // The reference Δt is estimated from a bounded sample of the deltas, so the
    // test that matters is a gap the sample can miss: one long step buried in
    // the middle of a signal that is otherwise perfectly uniform.
    const gapped = signal(44100, 0.2);
    for (let i = 4000; i < gapped.times.length; i++) gapped.times[i] += 0.05;
    manager.addSignal('f1', 'Gapped', gapped);
    assert.deepEqual(
        manager._audioSourceStatus('f1', 'Gapped'),
        { ok: false, reason: 'nonUniform' },
        'a single gap in the middle is caught, not averaged away',
    );

    const backwards = signal(1000, 0.1);
    backwards.times[50] = backwards.times[49] - 0.001;
    manager.addSignal('f1', 'Backwards', backwards);
    assert.equal(manager._audioSourceStatus('f1', 'Backwards').reason, 'nonMonotonic', 'time must move forward');

    manager.addSignal('f1', 'OneSample', { times: new Float64Array([0]), values: new Float64Array([0.5]) });
    assert.equal(manager._audioSourceStatus('f1', 'OneSample').reason, 'tooFewSamples', 'one sample is not a sound');

    manager.addSignal('f1', 'Slow', signal(1000, 1));
    assert.equal(manager._audioSourceStatus('f1', 'Slow').reason, 'rateTooLow',
        'below what createBuffer takes — a limit of the audio output, not of the ear');

    manager.addSignal('f1', 'Fast', signal(500000, 0.01));
    assert.equal(manager._audioSourceStatus('f1', 'Fast').reason, 'rateTooHigh', 'above what the audio output takes');

    manager.lazyFiles.add('lazy');
    manager.addSignal('lazy', 'Left', signal(44100, 0.1));
    assert.equal(manager._audioSourceStatus('lazy', 'Left').reason, 'lazy',
        'a file read in memory-saving mode has an overview, not samples');

    manager.timeKinds.set('cal', 'datetime');
    manager.addSignal('cal', 'Left', signal(44100, 0.1));
    assert.equal(manager._audioSourceStatus('cal', 'Left').reason, 'timeAxis', 'a calendar axis is not seconds');

    assert.equal(manager._audioSourceStatus('f1', 'Missing').reason, 'noData', 'a variable with no data refuses too');
}

// ── The sources a panel offers ────────────────────────────────────
{
    const manager = new FakeManager();
    manager.addSignal('f1', 'Left', signal(44100, 0.1));
    manager.addSignal('f1', 'Slow', signal(1000, 1));
    const plot = manager.addPanel('p1', [
        { fileId: 'f1', varName: 'Left', color: '#1f77b4' },
        { fileId: 'f1', varName: 'Slow', color: '#ff7f0e' },
        { fileId: 'f1', varName: 'Left', color: '#1f77b4' },   // the same trace twice
    ]);

    const sources = manager._audioSources(plot);
    assert.equal(sources.length, 2, 'one entry per distinct trace');
    assert.deepEqual(sources.map(s => s.varName), ['Left', 'Slow'], 'in the order the panel draws them');
    assert.equal(sources[0].status.ok, true);
    assert.equal(sources[1].status.ok, false, 'an unplayable trace is listed with its reason, not hidden');

    assert.equal(manager._audioSelectedSource(plot).varName, 'Left', 'the first playable trace is the default');

    manager._ensureAudioState(plot).sourceKey = sources[1].key;
    assert.equal(manager._audioSelectedSource(plot).varName, 'Slow', 'an explicit choice is honoured');

    manager._ensureAudioState(plot).sourceKey = 'f1\u0000Gone';
    assert.equal(manager._audioSelectedSource(plot).varName, 'Left',
        'a choice that left the panel falls back instead of throwing');

    assert.equal(manager._audioPanelPlayable(plot), true, 'a panel with one playable trace can be listened to');
    assert.equal(manager._audioPanelPlayable(manager.addPanel('p2', [], { mode: 'phase2d' })), false,
        'a mode with no time axis cannot');
}

// ── The range comes from the panel, never from the audio ──────────
{
    const manager = new FakeManager();
    manager.addSignal('f1', 'Left', signal(44100, 2));
    const plot = manager.addPanel('p1', [{ fileId: 'f1', varName: 'Left', color: '#1f77b4' }]);
    const source = manager._audioSelectedSource(plot);

    const whole = manager._audioRange(plot, source);
    assert.ok(Math.abs(whole[0] - 0) < 1e-9 && Math.abs(whole[1] - (88200 - 1) / 44100) < 1e-9,
        'in timeseries mode the whole record plays');

    plot.mode = 'fft';
    plot.fft = { rangeFull: true, x1: 0.5, x2: 1.5 };
    assert.deepEqual(manager._audioRange(plot, source), whole, 'Todo ignores the selection without clearing it');

    plot.fft.rangeFull = false;
    assert.deepEqual(manager._audioRange(plot, source), [0.5, 1.5], 'Selección is what sounds');

    plot.fft = { rangeFull: false, x1: -10, x2: 99 };
    assert.deepEqual(manager._audioRange(plot, source), whole, 'a selection wider than the signal is clamped to it');

    plot.fft = { rangeFull: false, x1: 1.5, x2: 0.5 };
    assert.deepEqual(manager._audioRange(plot, source), [0.5, 1.5], 'bounds in either order name the same range');
}

// ── What goes into the buffer ─────────────────────────────────────
{
    const manager = new FakeManager();
    const rate = 8000;
    manager.addSignal('f1', 'Left', signal(rate, 1, (i) => 0.25 * Math.sin(i / 7) + 0.5));   // offset by 0.5
    const plot = manager.addPanel('p1', [{ fileId: 'f1', varName: 'Left', color: '#1f77b4' }]);
    const source = manager._audioSelectedSource(plot);
    const state = manager._ensureAudioState(plot);
    const context = fakeContext();

    const built = manager._buildAudioBuffer(context, source, [0.25, 0.75], state);
    assert.equal(built.error, undefined, 'a half-second range builds');
    assert.ok(Math.abs(built.duration - 0.5) < 1e-3, 'the buffer is as long as the range');
    assert.ok(Math.abs(built.startTime - 0.25) < 1e-6, 'and knows where in the signal it starts');
    // Not an integer on the nose: the rate is 1/median(Δt) of the time vector,
    // so it carries the vector's floating point with it. That is the honest
    // value — the file's own timing — and every audio API takes a float rate.
    assert.ok(Math.abs(built.buffer.sampleRate - rate) < 1e-6, "the buffer carries the signal's own rate");

    const samples = built.buffer.getChannelData(0);
    let peak = 0;
    let mean = 0;
    for (const v of samples) { peak = Math.max(peak, Math.abs(v)); mean += v; }
    mean /= samples.length;
    assert.ok(Math.abs(peak - 0.891) < 1e-3, 'the peak lands at −1 dBFS, always');
    assert.equal(built.clipped, 0, 'and because the gain is chosen from the peak, nothing ever clips');
    assert.ok(Math.abs(mean) < 0.02, 'the constant offset is removed by default, so the speaker does not thump');

    // The edges are faded so a loop does not click at the seam.
    assert.equal(samples[0], 0, 'the first sample is silence');
    assert.equal(samples[samples.length - 1], 0, 'and so is the last');
    assert.ok(Math.abs(samples[20]) < Math.abs(samples[40]) || samples[20] === 0, 'the fade ramps in');

    // Without DC removal the offset survives into the sound.
    state.removeDC = false;
    const kept = manager._buildAudioBuffer(context, source, [0.25, 0.75], state);
    let keptMean = 0;
    for (const v of kept.buffer.getChannelData(0)) keptMean += v;
    keptMean /= kept.buffer.length;
    assert.ok(keptMean > 0.2, 'with DC removal off, the offset is still there');
    state.removeDC = true;

    // Missing samples are silence, and are counted rather than swallowed.
    const withHoles = signal(rate, 0.5, (i) => (i % 500 === 0 ? NaN : 0.4));
    manager.addSignal('f1', 'Holes', withHoles);
    const holed = manager._audioSources(plot.traces.length ? { traces: [{ fileId: 'f1', varName: 'Holes' }] } : plot)[0];
    const holedBuilt = manager._buildAudioBuffer(context, holed, [0, 0.5], manager._defaultAudioState());
    assert.equal(holedBuilt.nanCount, 8, 'every missing sample is counted — 4000 samples, one hole every 500');
    assert.equal(holedBuilt.buffer.getChannelData(0)[500], 0, 'and plays as silence');

    // Ranges the player refuses, each with its own reason.
    assert.equal(manager._buildAudioBuffer(context, source, [0.25, 0.2501], state).error, 'rangeTooShort',
        'a range shorter than the fades is a click, not a sound');
    const refusing = fakeContext({ accepts: (r) => r >= 16000 });
    assert.equal(manager._buildAudioBuffer(refusing, source, [0, 0.5], state).error, 'rateUnsupported',
        'a rate this browser will not take is reported, not thrown');
}

// ── The buffer is rebuilt when, and only when, it must be ─────────
{
    const manager = new FakeManager();
    manager.addSignal('f1', 'Left', signal(8000, 1));
    const plot = manager.addPanel('p1', [{ fileId: 'f1', varName: 'Left', color: '#1f77b4' }]);
    const source = manager._audioSelectedSource(plot);
    const state = manager._ensureAudioState(plot);

    const key = manager._audioBufferKey(source, [0, 1], state);
    assert.equal(manager._audioBufferKey(source, [0, 1], state), key, 'the same request is the same key');
    assert.notEqual(manager._audioBufferKey(source, [0, 0.5], state), key, 'a moved bound invalidates it');
    const withoutDC = { ...state, removeDC: false };
    assert.notEqual(manager._audioBufferKey(source, [0, 1], withoutDC), key, 'so does changing DC removal');

    // The bug this is here for: a data tool re-run with new parameters —
    // another M for a moving average — keeps the signal's name, its range and
    // its DC setting, and replaces its samples. Keyed on the name alone, the
    // old take went on playing through stop and play until the dropdown was
    // moved away and back.
    manager.addSignal('f1', 'Left', signal(8000, 1, (i) => Math.sin(i / 10)));
    const recomputed = manager._audioSelectedSource(plot);
    assert.equal(recomputed.key, source.key, 'the signal is still the same signal by name');
    assert.notEqual(manager._audioBufferKey(recomputed, [0, 1], state), key,
        'but its recomputed samples are a different take');

    // And the other half: the stamp must be stable, or the take would restart
    // on every frame of the tick that checks it.
    assert.equal(manager._audioBufferKey(manager._audioSelectedSource(plot), [0, 1], state),
        manager._audioBufferKey(recomputed, [0, 1], state),
        'samples that have not changed keep their key');
}

// ── A redraw is not the end of listening ──────────────────────────
{
    // The chart is destroyed and rebuilt for ordinary reasons — a data tool
    // drawing its preview, a trace removed, a rename — and none of them are a
    // reason to stop the sound or to throw away what it is playing. The buffer
    // in particular has to survive: the playhead reads its startTime to know
    // where in the signal the sound is, and dropping it left the audio playing
    // with no mark on the new chart.
    const manager = new FakeManager();
    manager.addSignal('f1', 'Left', signal(8000, 1));
    const plot = manager.addPanel('p1', [{ fileId: 'f1', varName: 'Left', color: '#1f77b4' }]);
    const source = manager._audioSelectedSource(plot);
    const state = manager._ensureAudioState(plot);
    state.open = true;
    state.buffer = manager._buildAudioBuffer(fakeContext(), source, [0, 1], state);
    state.bufferKey = manager._audioBufferKey(source, [0, 1], state);
    state.position = 0.25;

    manager._teardownAudioForPanel('p1', plot);

    assert.ok(state.buffer, 'the buffer survives the chart it was playing under');
    assert.ok(Math.abs(state.buffer.startTime - 0) < 1e-9, 'and still knows where in the signal it starts');
    assert.equal(state.position, 0.25, 'and the position is where the sound was');
    assert.equal(state.open, true, 'the strip stays open across a redraw');
}

// ── Each panel's mark is its own ──────────────────────────────────
{
    // The player is a singleton and only one panel sounds at a time. The mark
    // used to be computed once for the owner and copied into every panel
    // plotting that signal, on the grounds that the clock is one; in front of
    // two panels that reads as two players running at once, which is the one
    // thing the feature promises never to do. Each panel now answers for
    // itself, and a panel can only be live when it holds the player.
    const manager = new FakeManager();
    manager.addSignal('f1', 'Left', signal(8000, 1));
    const trace = { fileId: 'f1', varName: 'Left', color: '#1f77b4' };
    const parked = manager.addPanel('p1', [trace], { div: { isConnected: true } });
    const untouched = manager.addPanel('p2', [{ ...trace }], { div: { isConnected: true } });
    for (const plot of [parked, untouched]) manager._ensureAudioState(plot).open = true;

    // Nothing is sounding in this harness, so no panel's mark can be live.
    manager._ensureAudioState(parked).position = 0.4;
    const mine = manager._audioPanelMark('p1');
    assert.equal(mine.live, false, 'a panel that does not hold the player is never the live mark');
    assert.ok(Math.abs(mine.dataTime - 0.4) < 1e-9, 'the parked mark sits where the panel was left');
    assert.equal(manager._audioPanelMark('p2'), null,
        'and the panel next door, left at the start, shows nothing at all');

    // The start is the documented exception: at zero the line lands on the
    // axis, so it is not drawn unless the flag says otherwise.
    manager._ensureAudioState(parked).position = 0;
    assert.equal(manager._audioPanelMark('p1'), null, 'back at the start, the parked mark goes');
    manager._ensureAudioState(parked).position = 0.001;
    assert.ok(manager._audioPanelMark('p1'), 'a hair past the start it is back');

    // A closed strip has no mark, wherever its position is.
    manager._ensureAudioState(parked).position = 0.4;
    manager._ensureAudioState(parked).open = false;
    assert.equal(manager._audioPanelMark('p1'), null, 'a closed strip has no mark');
}

// ── A strip commands its own panel ────────────────────────────────
{
    // The bug: stop released whatever node was sounding and zeroed nothing
    // else, so pressing stop on an idle strip cut the panel that was actually
    // playing. Every control that touches the player — stop, pause, the gain —
    // asks first whether this panel holds it.
    const manager = new FakeManager();
    manager.addSignal('f1', 'Left', signal(8000, 1));
    const trace = { fileId: 'f1', varName: 'Left', color: '#1f77b4' };
    const first = manager.addPanel('p1', [trace], { div: { isConnected: true } });
    const second = manager.addPanel('p2', [{ ...trace }], { div: { isConnected: true } });
    for (const plot of [first, second]) manager._ensureAudioState(plot).open = true;
    // The strip and the mark are DOM; only what they are told matters here.
    manager._syncAudioStrip = () => {};
    manager._drawAudioPlayhead = () => {};
    manager._removeAudioPlayhead = () => {};
    manager._ensureAudioState(first).position = 0.4;
    manager._ensureAudioState(second).position = 0.9;

    assert.equal(manager._audioPanelOwnsPlayer('p1'), false, 'no panel holds the player here');

    manager._audioStop('p2');

    assert.equal(manager._ensureAudioState(second).position, 0, 'stop rewinds the panel it was pressed in');
    assert.equal(manager._ensureAudioState(first).position, 0.4, 'and leaves the other panel exactly where it was');
}

// ── The clock behind the playhead ─────────────────────────────────
{
    assert.equal(positionInRange(0, 0.4, 1, false), 0.4, 'the position is where the sound is');
    assert.equal(positionInRange(0, 2.5, 1, false), 1, 'without loop it stops at the end of the range');
    assert.ok(Math.abs(positionInRange(0, 2.5, 1, true) - 0.5) < 1e-9, 'with loop it wraps');
    assert.equal(positionInRange(0.3, 0, 1, true), 0.3, 'an offset with no time elapsed is the offset');
    assert.equal(positionInRange(0, 5, 0, false), 0, 'an empty range has no position to report');

    // The bug this is here for: while looping, the elapsed time runs far past
    // the range and only the modulo keeps it inside. Switching loop off drops
    // the modulo for a clamp, so the clock has to be re-anchored to the wrapped
    // position — otherwise the mark jumps to the end of the range.
    const offset = 0;
    const elapsed = 3.4;
    const duration = 1;
    const wrapped = positionInRange(offset, elapsed, duration, true);
    assert.ok(Math.abs(wrapped - 0.4) < 1e-9, 'three and a bit laps of a one-second range read as 0.4 s');
    assert.equal(positionInRange(offset, elapsed, duration, false), duration,
        'reading the same clock without the modulo pins it at the end — what the bug looked like');
    assert.ok(Math.abs(positionInRange(wrapped, 0, duration, false) - wrapped) < 1e-9,
        're-anchored to the wrapped position, switching loop off continues where it was');
}

// ── All | Visible window, in timeseries mode (#375) ───────────────
{
    const manager = new FakeManager();
    manager.addSignal('f1', 'Left', signal(8000, 3));
    const plot = manager.addPanel('p1', [{ fileId: 'f1', varName: 'Left', color: '#1f77b4' }]);
    const source = manager._audioSelectedSource(plot);
    const whole = manager._audioRange(plot, source);
    const state = manager._ensureAudioState(plot);
    assert.equal(state.window, 'all', 'the whole record is the default');

    state.window = 'visible';
    assert.deepEqual(manager._audioRange(plot, source), whole, 'a plot not drawn yet has no window: the whole record plays');
    plot.div = { _fullLayout: { xaxis: { range: [0.5, 1.25] } } };
    assert.deepEqual(manager._audioRange(plot, source), [0.5, 1.25], 'the visible window is what sounds');
    plot.div._fullLayout.xaxis.range = [1.25, 0.5];
    assert.deepEqual(manager._audioRange(plot, source), [0.5, 1.25], 'a reversed axis names the same window');
    plot.div._fullLayout.xaxis.range = [-1, 0.5];
    assert.deepEqual(manager._audioRange(plot, source), [0, 0.5], 'clamped to the start of the signal');
    plot.div._fullLayout.xaxis.range = [2.5, 9];
    assert.deepEqual(manager._audioRange(plot, source), [2.5, whole[1]], 'and to its end');
    plot.div._fullLayout.xaxis.range = [5, 6];
    assert.equal(manager._audioRangeDuration(plot), 0,
        'a window past the end of the signal holds nothing of it — not the whole record in its place');

    state.window = 'all';
    plot.div._fullLayout.xaxis.range = [0.5, 1.25];
    assert.deepEqual(manager._audioRange(plot, source), whole, 'All ignores the zoom');

    // In an analysis mode the analysis' selection sounds, whatever the strip
    // said in timeseries mode.
    state.window = 'visible';
    plot.mode = 'fft';
    plot.fft = { rangeFull: true, x1: 1, x2: 2 };
    assert.equal(manager._audioWindowMode(plot), 'all', 'no visible window outside timeseries mode');
    assert.deepEqual(manager._audioRange(plot, source), whole, 'Fourier on Full plays everything');
    plot.fft.rangeFull = false;
    assert.deepEqual(manager._audioRange(plot, source), [1, 2], 'and its selection when it has one');
    plot.mode = 'timeseries';
    assert.equal(manager._audioWindowMode(plot), 'visible', 'back in timeseries mode, the choice is still there');

    // The ~50 ms floor, for any range.
    const context = fakeContext();
    assert.equal(manager._buildAudioBuffer(context, source, [1, 1.04], state).error, 'rangeTooShort', '40 ms is refused');
    assert.equal(manager._buildAudioBuffer(context, source, [1, 1.06], state).error, undefined, '60 ms plays');

    // The rows of a range are the ones whose time is in it, both ends included:
    // the rule a lazy file's rows are read by.
    const built = manager._buildAudioBuffer(context, source, [0.5, 1.25], state);
    assert.equal(built.buffer.length, 6001, 'from 0.5 s to 1.25 s at 8 kHz, both ends included');
    const between = manager._buildAudioBuffer(context, source, [0.50001, 1.24999], state);
    assert.equal(between.buffer.length, 5999, 'bounds between samples keep only the samples inside');
}

// ── A moved range keeps the instant where it can ──────────────────
{
    const manager = new FakeManager();
    manager.addSignal('f1', 'Left', signal(8000, 3));
    const plot = manager.addPanel('p1', [{ fileId: 'f1', varName: 'Left', color: '#1f77b4' }]);
    const state = manager._ensureAudioState(plot);
    state.buffer = { startTime: 0.5, duration: 0.75 };
    state.position = 0.25;
    manager._audioRemapPosition(state, [0.6, 1]);
    assert.ok(Math.abs(state.position - 0.15) < 1e-12, 'an instant the new range holds is kept');
    state.position = 0.25;
    manager._audioRemapPosition(state, [1, 2]);
    assert.equal(state.position, 0, 'one it leaves out starts the range over');
    state.position = 0.75;
    manager._audioRemapPosition(state, [0, 3]);
    assert.equal(state.position, 0, 'a take that had run to its end starts the next one from the top');

    // Paused, the strip measures against the range it would play now.
    state.open = true;
    state.window = 'visible';
    plot.div = { _fullLayout: { xaxis: { range: [0.5, 1.25] } } };
    const source = manager._audioSelectedSource(plot);
    state.buffer = manager._buildAudioBuffer(fakeContext(), source, [0.5, 1.25], state);
    state.bufferKey = manager._audioBufferKey(source, [0.5, 1.25], state);
    state.position = 0.3;
    const keptKey = state.bufferKey;
    manager._audioSettleIdleRange(plot);
    assert.equal(state.bufferKey, keptKey, 'nothing moved, nothing changes');
    plot.div._fullLayout.xaxis.range = [0.7, 2];
    manager._audioSettleIdleRange(plot);
    assert.equal(state.buffer, null, 'a zoom while paused retires the old take');
    assert.equal(state.prepared.key, keptKey, 'kept aside, should the zoom come back');
    assert.ok(Math.abs(state.position - 0.1) < 1e-9, 'and the instant is where it was in the signal (0.8 s)');
    assert.ok(Math.abs(manager._audioRangeDuration(plot) - 1.3) < 1e-9, 'the readout gives the new window\'s length');
}

// ── The kernel: chunks change nothing ─────────────────────────────
{
    const rate = 8000;
    const { times, values } = signal(rate, 0.5, (i) => (i % 97 === 3 ? NaN : 0.3 + Math.sin(i / 9) * (1 + i / 4000)));
    const whole = audioSamplesFromArrays(times, [values]);
    assert.equal(whole.info.ok, true);
    assert.equal(whole.info.fade, 40, '5 ms at 8 kHz is 40 samples, not 39 for a rate read as 7999.999…');
    assert.equal(whole.info.nanCount, Math.ceil((4000 - 3) / 97), 'the holes are counted');
    for (const size of [1, 13, 1000]) {
        const scan = createAudioScan(1);
        for (let at = 0; at < times.length; at += size) scanAudioChunk(scan, times.subarray(at, at + size), [values.subarray(at, at + size)]);
        const info = finishAudioScan(scan);
        const out = new Float32Array(info.frames);
        for (let at = 0; at < times.length; at += size) writeAudioChunk(info, [values.subarray(at, at + size)], at, [out], at);
        assert.deepEqual(Buffer.from(out.buffer), Buffer.from(whole.outs[0].buffer), `in chunks of ${size}, the same samples`);
    }
    let peak = 0;
    for (const v of whole.outs[0]) peak = Math.max(peak, Math.abs(v));
    assert.ok(Math.abs(peak - AUDIO_PEAK) < 1e-6 || peak < AUDIO_PEAK, 'the peak is at −1 dBFS at most (the fades only lower it)');

    // Two channels: each loses its own mean, both share one gain.
    const left = Float64Array.from({ length: 4000 }, (_, i) => 2 + Math.sin(i / 7));
    const right = Float64Array.from({ length: 4000 }, (_, i) => -1 + 0.5 * Math.sin(i / 7));
    const stereo = audioSamplesFromArrays(times, [left, right]);
    assert.ok(Math.abs(stereo.info.means[0] - 2) < 0.01 && Math.abs(stereo.info.means[1] + 1) < 0.01, 'each channel its own mean');
    assert.ok(Math.abs(stereo.outs[1][2000] * 2 - stereo.outs[0][2000]) < 1e-6, 'one gain: the balance of the recording stays');

    // Not a recording: a gap, time going back.
    const gappy = Float64Array.from(times);
    for (let i = 2000; i < gappy.length; i++) gappy[i] += 0.001;
    assert.equal(audioSamplesFromArrays(gappy, [values]).info.reason, 'nonUniform', 'a gap is not uniform');
    const back = Float64Array.from(times);
    back[100] = back[99];
    assert.equal(audioSamplesFromArrays(back, [values]).info.reason, 'nonMonotonic', 'a repeated instant is not a recording');
}

// ── Zoom while playing: heard at the end of the loop, never cut ───
{
    // A stand-in for the browser's audio: a clock that moves when told, and
    // nodes that record when they were asked to start and stop.
    const nodes = [];
    class FakeAudioContext {
        constructor() {
            this.currentTime = 0;
            this.sampleRate = 48000;
            this.state = 'running';
            this.destination = {};
        }
        resume() { return Promise.resolve(); }
        createGain() {
            const param = { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} };
            return { gain: param, connect() {}, disconnect() {} };
        }
        createBuffer(channels, length, rate) {
            const data = new Float32Array(length);
            return { numberOfChannels: channels, length, sampleRate: rate, duration: length / rate, getChannelData: () => data };
        }
        createBufferSource() {
            const node = { starts: [], stops: [], loop: false, connect() {}, disconnect() {},
                start(when, offset) { this.starts.push([when, offset]); }, stop(when) { this.stops.push(when); } };
            nodes.push(node);
            return node;
        }
    }
    globalThis.window = { AudioContext: FakeAudioContext };
    globalThis.requestAnimationFrame = () => 0;
    globalThis.cancelAnimationFrame = () => {};

    const manager = new FakeManager();
    manager._syncAudioStrip = () => {};
    manager._drawAudioPlayhead = () => {};
    manager._removeAudioPlayhead = () => {};
    manager.addSignal('f1', 'Left', signal(8000, 3));
    const plot = manager.addPanel('p1', [{ fileId: 'f1', varName: 'Left', color: '#1f77b4' }]);
    const state = manager._ensureAudioState(plot);
    state.open = true;
    state.window = 'visible';
    state.loop = true;
    plot.div = { _fullLayout: { xaxis: { range: [0.5, 1.25] } } };

    manager._audioPlay('p1');
    const first = nodes.at(-1);
    const context = first && manager._audioEnsureContext();
    assert.ok(first && first.loop, 'the window plays, looping');
    assert.ok(Math.abs(state.buffer.startTime - 0.5) < 1e-9, 'from the start of the window');
    const duration = state.buffer.duration;

    // A zoom, a third of the way through a turn of the loop.
    context.currentTime = 0.3;
    plot.div._fullLayout.xaxis.range = [1.5, 2];
    const settle = () => {
        manager._followAudioSourceChange();
        state.pendingRebuildSince -= 1000;   // the zoom held still
        manager._followAudioSourceChange();
    };
    settle();
    const next = nodes.at(-1);
    assert.notEqual(next, first, 'the new window is made ready');
    assert.equal(next.starts.length, 1);
    assert.ok(Math.abs(next.starts[0][0] - duration) < 1e-9, `it starts where this turn of the loop ends (${next.starts[0][0]} s)`);
    assert.equal(next.starts[0][1], 0, 'from its own beginning');
    assert.ok(Math.abs(first.stops.at(-1) - duration) < 1e-9, 'and the take sounding now stops right there, not before');
    assert.ok(Math.abs(state.buffer.startTime - 0.5) < 1e-9, 'until then, the old window is what sounds');

    context.currentTime = duration + 0.05;
    manager._audioPromoteSeam();
    assert.ok(Math.abs(state.buffer.startTime - 1.5) < 1e-9, 'past the seam, the new window is the take');
    assert.ok(Math.abs(manager._audioPosition(plot) - 0.05) < 1e-9, 'and the playhead runs from its start');

    // Loop off: a zoom waits for the next play.
    first.stops.length = 0;
    nodes.at(-1).loop = false;
    state.loop = false;
    const before = nodes.length;
    // As the loop button does, while playing.
    manager._audioPlay('p1');
    const once = nodes.at(-1);
    plot.div._fullLayout.xaxis.range = [0.2, 0.4];
    settle();
    assert.equal(nodes.length, before + 1, 'playing once, nothing is scheduled for a zoom');
    assert.equal(once.stops.length, 0, 'and the take is not cut');
    once.onended();
    assert.equal(manager._audioPanelIsPlaying(plot), false, 'the take ran to its end');
    manager._audioPlay('p1');
    assert.ok(Math.abs(state.buffer.startTime - 0.2) < 1e-9, 'the next play is the new window');
    assert.ok(Math.abs(state.position) < 1e-9, 'from its start');

    // A zoom that comes back before the seam: nothing changes.
    manager._audioStop('p1');
    state.loop = true;
    manager._audioPlay('p1');
    const looping = nodes.at(-1);
    plot.div._fullLayout.xaxis.range = [1, 1.5];
    settle();
    const pending = nodes.at(-1);
    assert.notEqual(pending, looping, 'a new window waits for the seam');
    plot.div._fullLayout.xaxis.range = [0.2, 0.4];
    manager._followAudioSourceChange();
    assert.ok(pending.stops.length >= 1, 'zoomed back, the waiting window is dropped');
    assert.ok(looping.stops.at(-1) > 1e6, 'and the take sounding now is no longer told to stop at the seam');
    assert.ok(Math.abs(state.buffer.startTime - 0.2) < 1e-9, 'it simply goes on');
    manager._audioStop('p1');
    delete globalThis.window;
}

console.log('audio player tests passed');
