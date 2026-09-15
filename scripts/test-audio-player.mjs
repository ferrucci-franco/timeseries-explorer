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

console.log('audio player tests passed');
