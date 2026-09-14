// Audio playback — the player behind the panel's 🔊 button.
//
// One player for the whole app: one clock, one AudioContext, one state object,
// living in the module rather than in a panel. That is the decision the rest of
// the feature hangs off (docs/audio-playback-design.md): two independent
// players cannot be compared, and comparing a signal with its filtered version
// is what this exists for. Pressing play in another panel therefore stops the
// first one rather than mixing into it — two unsynchronised signals are mud.
//
// What belongs to a PANEL is the listening state: which trace is the source,
// where the playhead is, whether it loops, the volume. What belongs to the
// PLAYER is the sound. A panel that is not sounding keeps its strip and its
// position, and picks up where it left off.
//
// Phase 1 of #86 (issue #89). The range is read-only here: the analysis
// selection when the panel is in an analysis mode, the whole record otherwise.
// The Todo | Selección control in timeseries mode is phase 2 (#90), and stereo,
// reverse and source switching are phase 3 (#91).

import i18n from '../../i18n/index.js';
import { FFT_UNIFORM_REL_TOLERANCE } from '../../utils/fft.js';

// The sample rates createBuffer() accepts — a property of the browser's audio
// output, NOT a statement about what is audible. A signal sampled at 2 kHz can
// carry a perfectly audible 500 Hz tone; what it cannot do is be handed to this
// API at its own rate. (Sonification is the different problem of content that
// falls outside 20 Hz – 20 kHz, and it is deliberately not in v1.)
//
// Browsers disagree on the floor — Chrome takes 3 kHz, Firefox 8 kHz — so the
// gate is generous and _buildAudioBuffer catches what the browser still
// refuses. Resampling a slow signal up to a rate the output accepts, keeping
// its duration, would lift this limit entirely; that is a follow-up, not a
// reason to pretend the signal is unplayable in principle.
const MIN_PLAYABLE_RATE = 3000;
const MAX_PLAYABLE_RATE = 384000;

// A range is copied into one AudioBuffer, so its length is bounded by memory
// rather than by patience: 32 M samples is ~128 MB as Float32, about twelve
// minutes of CD-rate audio. Longer than that the strip asks for a narrower
// selection rather than trying to allocate it. (Chunked streaming would lift
// this; it is not worth its complexity before anyone has hit the ceiling.)
const MAX_BUFFER_SAMPLES = 32 * 1024 * 1024;

// Below this a range is a click, not a sound: at 44.1 kHz, 10 ms is 441
// samples, barely longer than the fades at each end.
const MIN_RANGE_SECONDS = 0.01;

// Fades written INTO the buffer edges, so a loop does not click at the seam.
const EDGE_FADE_SECONDS = 0.005;
// Fade applied when playback is interrupted (stop, pause, another panel taking
// over). Shorter than the edge fade would click; longer would feel laggy.
const INTERRUPT_FADE_SECONDS = 0.01;

// What the strip says when a range cannot be turned into a buffer.
const BUILD_ERROR_KEYS = {
    rangeTooLong: 'audioRangeTooLong',
    rangeTooShort: 'audioRangeTooShort',
    rateUnsupported: 'audioRateUnsupported',
};

// How far the pointer may travel between press and release and still count as a
// click rather than a drag. Plotly owns the mouse inside the plot area — a drag
// is a zoom — so seeking has to take only what a zoom would never claim.
const CLICK_SLOP_PIXELS = 3;

// A double click on the plot is Plotly's zoom-fit, and its first half is an
// ordinary click. Seeking waits this long to see whether a second one lands;
// short enough to feel immediate, long enough to catch the pair.
const DOUBLE_CLICK_GRACE_MS = 260;

// How long the panel's selection has to hold still before the sound follows it.
// Dragging a bound crosses dozens of values; rebuilding on each one would
// stutter rather than follow.
const RANGE_SETTLE_MS = 250;

// Auto scale lands the peak at −1 dBFS rather than at full scale: a hair of
// headroom costs nothing audible and keeps the last sample off the rail.
const AUTO_PEAK = 0.891;

// The one player. `owner` is the panel currently making sound, or null.
const player = {
    context: null,
    master: null,
    node: null,
    nodeGain: null,
    owner: null,          // { manager, panelId }
    playing: false,
    duration: 0,          // length of the range in seconds
    offset: 0,            // seconds into the range where the node was started
    startedAt: 0,         // context.currentTime at that moment
    loop: false,
    raf: null,
};

// Verdict per time vector, keyed by the array itself: the transform cache hands
// back the same array while nothing has changed and a fresh one when it has, so
// identity is exactly the right invalidation signal and costs no bookkeeping.
const samplingCache = new WeakMap();

/**
 * Is this time vector uniformly sampled, and at what rate?
 *
 * The same verdict analyzeSampling() reaches, computed without its copy of the
 * whole vector: a recording is tens of millions of samples, and `Array.from` on
 * that allocates hundreds of megabytes to answer a yes/no question. The
 * reference Δt is the median of a bounded sample of the deltas; every delta is
 * then checked against it in one streaming pass, so the uniformity claim still
 * covers the entire vector and a gap in the middle cannot slip through.
 */
function analyzeAudioSampling(times) {
    const n = times?.length || 0;
    if (n < 2) return { ok: false, reason: 'tooFewSamples' };

    const cached = samplingCache.get(times);
    if (cached) return cached;

    const sampleCount = Math.min(4096, n - 1);
    const stride = Math.max(1, Math.floor((n - 1) / sampleCount));
    const probes = [];
    for (let i = 1; i < n && probes.length < sampleCount; i += stride) {
        const dt = Number(times[i]) - Number(times[i - 1]);
        if (Number.isFinite(dt) && dt > 0) probes.push(dt);
    }
    if (!probes.length) {
        const verdict = { ok: false, reason: 'nonMonotonic' };
        samplingCache.set(times, verdict);
        return verdict;
    }
    probes.sort((a, b) => a - b);
    const dt = probes[probes.length >> 1];

    let maxRelativeError = 0;
    for (let i = 1; i < n; i++) {
        const step = Number(times[i]) - Number(times[i - 1]);
        if (!Number.isFinite(step) || step <= 0) {
            const verdict = { ok: false, reason: 'nonMonotonic' };
            samplingCache.set(times, verdict);
            return verdict;
        }
        const error = Math.abs(step - dt) / dt;
        if (error > maxRelativeError) maxRelativeError = error;
        if (maxRelativeError > FFT_UNIFORM_REL_TOLERANCE) {
            const verdict = { ok: false, reason: 'nonUniform', dt, maxRelativeError };
            samplingCache.set(times, verdict);
            return verdict;
        }
    }

    const verdict = { ok: true, dt, sampleRate: 1 / dt, maxRelativeError };
    samplingCache.set(times, verdict);
    return verdict;
}

/** First index whose time is >= value, over an ascending vector. */
function lowerBound(times, value) {
    let lo = 0;
    let hi = times.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (Number(times[mid]) < value) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function formatClock(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(total / 60);
    const rest = total - minutes * 60;
    return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}

export function installPlotAudioMethods(TargetClass) {
    const proto = TargetClass.prototype;

    // ─── State ──────────────────────────────────────────────────────

    proto._defaultAudioState = function() {
        return {
            open: false,
            sourceKey: null,
            position: 0,      // seconds from the start of the range
            loop: false,
            volume: 0.7,
            muted: false,
            scale: 'auto',    // auto | fixed | manual
            manualDb: 0,
            removeDC: true,
            buffer: null,
            bufferKey: '',
            notice: '',
            resumeAfterScrub: false,
            pendingRangeKey: null,
            pendingRangeSince: 0,
        };
    };

    proto._ensureAudioState = function(plot) {
        if (!plot) return this._defaultAudioState();
        if (!plot.audio) plot.audio = this._defaultAudioState();
        return plot.audio;
    };

    // ─── Sources ────────────────────────────────────────────────────

    proto._audioTraceKey = function(trace) {
        return `${trace?.fileId ?? ''}\u0000${trace?.varName ?? ''}`;
    };

    /**
     * Can this variable be played, and if not, why not? The reason is half the
     * answer: a disabled button that does not say why is a bug report waiting
     * to be filed.
     */
    proto._audioSourceStatus = function(fileId, varName) {
        if (this._isLazyFile?.(fileId)) return { ok: false, reason: 'lazy' };

        const times = this._getTransformedTimeDataForVariable(fileId, varName);
        const values = this._getTransformedVariableData(fileId, varName);
        if (!times?.length || !values?.length) return { ok: false, reason: 'noData' };

        // A calendar axis is seconds only by accident; the rate that comes out
        // of it is not the recording's. Out of scope until someone asks.
        if (this._fftTimeKind?.(fileId) !== 'numeric') return { ok: false, reason: 'timeAxis' };

        const sampling = analyzeAudioSampling(times);
        if (!sampling.ok) return { ok: false, reason: sampling.reason || 'nonUniform' };

        const sampleRate = sampling.sampleRate;
        if (!(sampleRate >= MIN_PLAYABLE_RATE)) {
            return { ok: false, reason: 'rateTooLow', sampleRate };
        }
        if (!(sampleRate <= MAX_PLAYABLE_RATE)) {
            return { ok: false, reason: 'rateTooHigh', sampleRate };
        }
        return { ok: true, sampleRate, dt: sampling.dt, times, values };
    };

    proto._audioSources = function(plot) {
        const traces = plot?.traces || [];
        const seen = new Set();
        const sources = [];
        for (const trace of traces) {
            const key = this._audioTraceKey(trace);
            if (seen.has(key)) continue;
            seen.add(key);
            const status = this._audioSourceStatus(trace.fileId, trace.varName);
            sources.push({
                key,
                fileId: trace.fileId,
                varName: trace.varName,
                color: trace.color,
                label: this._traceName?.(trace.varName, trace.fileId, { units: false }) || trace.varName,
                status,
            });
        }
        return sources;
    };

    proto._audioSelectedSource = function(plot) {
        const sources = this._audioSources(plot);
        if (!sources.length) return null;
        const state = this._ensureAudioState(plot);
        const chosen = sources.find(source => source.key === state.sourceKey);
        if (chosen) return chosen;
        // Default to the first playable trace, falling back to the first one so
        // the strip can still explain why nothing can be played.
        return sources.find(source => source.status.ok) || sources[0];
    };

    /** What the 🔊 button's tooltip says, including why it is disabled. */
    proto._audioButtonTitle = function(plot) {
        if (this._audioPanelPlayable(plot)) return i18n.t('audioToggle');
        if (!this._hasContent(plot)) return i18n.t('audioReasonNoTraces');
        if (!['timeseries', 'fft', 'histogram', 'integral'].includes(plot?.mode)) {
            return i18n.t('audioReasonMode');
        }
        // Named, so the tooltip reads as a sentence about a signal rather than
        // as a bare fragment: "Left — not uniformly sampled".
        const named = this._audioSources(plot)
            .map(source => {
                const reason = this._audioReasonText(source.status);
                return reason ? `${source.label} — ${reason}` : '';
            })
            .find(Boolean);
        return named || i18n.t('audioReasonUnavailable');
    };

    /** True when any trace in this panel could be played. */
    proto._audioPanelPlayable = function(plot) {
        if (!this._hasContent(plot)) return false;
        if (!['timeseries', 'fft', 'histogram', 'integral'].includes(plot?.mode)) return false;
        return this._audioSources(plot).some(source => source.status.ok);
    };

    // ─── Range ──────────────────────────────────────────────────────

    /**
     * What sounds: the panel's selection, never a range of the audio's own.
     * In an analysis mode that selection already exists and already has its
     * control in the panel's options, so this only reads it. In timeseries mode
     * there is no selection yet — phase 2 gives the strip the same
     * Todo | Selección control; until then the whole record plays.
     */
    proto._audioRange = function(plot, source) {
        const extent = this._audioSourceExtent(source);
        if (!extent) return null;
        let range = null;
        if (plot?.mode === 'fft') range = this._activeFftRange?.(plot);
        else if (plot?.mode === 'histogram') range = this._activeHistogramRange?.(plot);
        else if (plot?.mode === 'integral') range = this._activeIntegralRange?.(plot);
        if (!Array.isArray(range) || !Number.isFinite(range[0]) || !Number.isFinite(range[1])) {
            return extent;
        }
        const lo = Math.max(extent[0], Math.min(range[0], range[1]));
        const hi = Math.min(extent[1], Math.max(range[0], range[1]));
        if (!(hi > lo)) return extent;
        return [lo, hi];
    };

    proto._audioSourceExtent = function(source) {
        const times = source?.status?.times;
        if (!times?.length) return null;
        const first = Number(times[0]);
        const last = Number(times[times.length - 1]);
        if (!Number.isFinite(first) || !Number.isFinite(last) || !(last > first)) return null;
        return [first, last];
    };

    // ─── Buffer ─────────────────────────────────────────────────────

    /**
     * Copy one range into an AudioBuffer, honestly: NaNs become silence and are
     * counted, the mean can be removed so the speaker does not thump on the
     * first sample, the scale is stated rather than guessed, and anything the
     * gain pushes past full scale is counted as clipped instead of being
     * quietly folded over.
     */
    proto._buildAudioBuffer = function(context, source, range, state) {
        const { times, values, sampleRate } = source.status;
        const lo = lowerBound(times, range[0]);
        let hi = lowerBound(times, range[1]);
        if (hi < lo) hi = lo;
        const count = Math.min(hi - lo + 1, times.length - lo);
        if (count < 2) return { error: 'rangeTooShort' };
        if (count / sampleRate < MIN_RANGE_SECONDS) return { error: 'rangeTooShort' };
        if (count > MAX_BUFFER_SAMPLES) return { error: 'rangeTooLong' };

        let sum = 0;
        let finiteCount = 0;
        let nanCount = 0;
        let peak = 0;
        for (let i = 0; i < count; i++) {
            const value = Number(values[lo + i]);
            if (Number.isFinite(value)) {
                sum += value;
                finiteCount++;
            } else {
                nanCount++;
            }
        }
        const mean = state.removeDC && finiteCount ? sum / finiteCount : 0;
        for (let i = 0; i < count; i++) {
            const value = Number(values[lo + i]);
            if (!Number.isFinite(value)) continue;
            const centred = Math.abs(value - mean);
            if (centred > peak) peak = centred;
        }

        let gain = 1;
        if (state.scale === 'auto') gain = peak > 0 ? AUTO_PEAK / peak : 1;
        else if (state.scale === 'manual') gain = 10 ** ((Number(state.manualDb) || 0) / 20);

        let buffer;
        try {
            buffer = context.createBuffer(1, count, sampleRate);
        } catch {
            // Within the gate above but outside what THIS browser takes —
            // 4 kHz passes in Chrome and is refused in Firefox. An exception
            // here would surface as a dead button; a sentence does not.
            return { error: 'rateUnsupported' };
        }
        const channel = buffer.getChannelData(0);
        let clipped = 0;
        for (let i = 0; i < count; i++) {
            const value = Number(values[lo + i]);
            if (!Number.isFinite(value)) { channel[i] = 0; continue; }
            let scaled = (value - mean) * gain;
            if (scaled > 1) { scaled = 1; clipped++; }
            else if (scaled < -1) { scaled = -1; clipped++; }
            channel[i] = scaled;
        }

        // Fades written into the edges: without them a loop clicks at the seam
        // every time round, and so does the very first sample of a range that
        // starts mid-waveform.
        const fade = Math.min(Math.floor(EDGE_FADE_SECONDS * sampleRate), count >> 1);
        for (let i = 0; i < fade; i++) {
            const factor = i / fade;
            channel[i] *= factor;
            channel[count - 1 - i] *= factor;
        }

        return {
            buffer,
            clipped,
            nanCount,
            duration: count / sampleRate,
            startTime: Number(times[lo]),
        };
    };

    proto._audioBufferKey = function(source, range, state) {
        return [
            source.key,
            range[0], range[1],
            state.scale, state.manualDb,
            state.removeDC ? 1 : 0,
        ].join('|');
    };

    // ─── Transport ──────────────────────────────────────────────────

    proto._audioEnsureContext = function() {
        // Created inside the user's click, which is what the browsers' autoplay
        // policy requires; every entry point into playback is a click.
        if (!player.context) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) return null;
            player.context = new Ctor();
            player.master = player.context.createGain();
            player.master.connect(player.context.destination);
        }
        if (player.context.state === 'suspended') player.context.resume().catch(() => {});
        return player.context;
    };

    /** Seconds into the range, right now. */
    proto._audioPosition = function(plot) {
        const state = this._ensureAudioState(plot);
        if (!this._audioPanelIsPlaying(plot)) return state.position;
        const elapsed = player.context.currentTime - player.startedAt;
        const raw = player.offset + Math.max(0, elapsed);
        if (!player.duration) return 0;
        return player.loop ? raw % player.duration : Math.min(raw, player.duration);
    };

    proto._audioPanelIsPlaying = function(plot) {
        return !!(player.playing
            && player.owner
            && player.owner.manager === this
            && this.plots.get(player.owner.panelId) === plot);
    };

    /**
     * Release the sound without clicking. Each playback owns its own gain node,
     * so the ramp belongs to the take being ended and cannot collide with the
     * next one starting.
     */
    proto._audioReleaseNode = function() {
        const node = player.node;
        const nodeGain = player.nodeGain;
        player.node = null;
        player.nodeGain = null;
        player.playing = false;
        if (!node) return;
        node.onended = null;
        try {
            const now = player.context.currentTime;
            nodeGain.gain.cancelScheduledValues(now);
            nodeGain.gain.setValueAtTime(nodeGain.gain.value, now);
            nodeGain.gain.linearRampToValueAtTime(0.0001, now + INTERRUPT_FADE_SECONDS);
            node.stop(now + INTERRUPT_FADE_SECONDS + 0.002);
        } catch {
            try { node.stop(); } catch { /* already stopped */ }
        }
        setTimeout(() => {
            try { node.disconnect(); nodeGain.disconnect(); } catch { /* gone */ }
        }, (INTERRUPT_FADE_SECONDS + 0.05) * 1000);
    };

    /**
     * Hand the player to another panel. Whoever was sounding keeps its position
     * so that coming back to it and pressing play resumes rather than restarts.
     */
    proto._audioYieldPlayer = function() {
        if (!player.owner) return;
        const { manager, panelId } = player.owner;
        const previous = manager.plots?.get(panelId);
        if (previous && player.playing) {
            const state = manager._ensureAudioState(previous);
            state.position = manager._audioPosition(previous);
        }
        manager._audioReleaseNode?.();
        manager._stopAudioTick?.();
        manager._clearAudioPlayheads?.();
        player.owner = null;
        if (previous) manager._syncAudioStrip?.(panelId);
    };

    proto._audioPlay = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureAudioState(plot);
        const source = this._audioSelectedSource(plot);
        if (!source?.status?.ok) return;

        const context = this._audioEnsureContext();
        if (!context) { state.notice = i18n.t('audioNoContext'); this._syncAudioStrip(panelId); return; }

        const range = this._audioRange(plot, source);
        if (!range) return;

        // One panel sounds at a time — including this one, whose previous take
        // has to end before the next begins. Yielding snapshots the live clock
        // into the position of whatever was sounding, which is right when that
        // is another panel and wrong when it is this one: seeking mid-playback
        // restarts the take, and the position just asked for would be
        // overwritten by the one being left behind. So it is taken first and
        // put back afterwards.
        const requestedPosition = state.position;
        this._audioYieldPlayer();
        state.position = requestedPosition;

        const key = this._audioBufferKey(source, range, state);
        if (state.bufferKey !== key || !state.buffer) {
            const built = this._buildAudioBuffer(context, source, range, state);
            if (built.error) {
                state.notice = i18n.t(BUILD_ERROR_KEYS[built.error] || 'audioReasonUnavailable');
                state.buffer = null;
                state.bufferKey = '';
                this._syncAudioStrip(panelId);
                return;
            }
            state.buffer = built;
            state.bufferKey = key;
            state.notice = this._audioBufferNotice(source, built);
        }

        const built = state.buffer;
        if (state.position >= built.duration - 0.001) state.position = 0;

        const nodeGain = context.createGain();
        nodeGain.gain.setValueAtTime(1, context.currentTime);
        nodeGain.connect(player.master);
        const node = context.createBufferSource();
        node.buffer = built.buffer;
        node.loop = !!state.loop;
        node.connect(nodeGain);

        player.node = node;
        player.nodeGain = nodeGain;
        player.owner = { manager: this, panelId };
        player.duration = built.duration;
        player.offset = state.position;
        player.startedAt = context.currentTime;
        player.loop = !!state.loop;
        player.playing = true;
        this._applyAudioVolume(state);

        node.onended = () => {
            if (player.node !== node) return;
            player.playing = false;
            player.node = null;
            player.nodeGain = null;
            const current = this.plots.get(panelId);
            if (current) {
                // Stopping at the end rather than snapping to zero: the reading
                // stays where the sound stopped, which is what a reader expects
                // to see, and play starts it over from the top anyway.
                this._ensureAudioState(current).position = built.duration;
            }
            this._stopAudioTick();
            this._clearAudioPlayheads();
            this._syncAudioStrip(panelId);
        };

        node.start(0, state.position);
        this._startAudioTick();
        this._syncAudioStrip(panelId);
    };

    proto._audioBufferNotice = function(source, built) {
        const notes = [];
        if (built.clipped > 0) {
            notes.push(i18n.t('audioClipped').replace('{count}', built.clipped.toLocaleString()));
        }
        if (built.nanCount > 0) {
            notes.push(i18n.t('audioNaNs').replace('{count}', built.nanCount.toLocaleString()));
        }
        const contextRate = player.context?.sampleRate;
        if (contextRate && Math.abs(contextRate - source.status.sampleRate) > 1) {
            notes.push(i18n.t('audioResampled')
                .replace('{from}', Math.round(source.status.sampleRate).toLocaleString())
                .replace('{to}', Math.round(contextRate).toLocaleString()));
        }
        return notes.join(' · ');
    };

    proto._audioPause = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureAudioState(plot);
        state.position = this._audioPosition(plot);
        this._audioReleaseNode();
        this._stopAudioTick();
        // Paused, not stopped: the playhead stays where the sound stopped.
        // Removing it was the bug — pause is the one moment a reader wants to
        // see exactly where they are.
        this._renderAudioPlayheads();
        this._syncAudioStrip(panelId);
    };

    proto._audioStop = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureAudioState(plot);
        this._audioReleaseNode();
        state.position = 0;
        this._stopAudioTick();
        this._clearAudioPlayheads();
        this._syncAudioStrip(panelId);
    };

    proto._audioTogglePlay = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        if (this._audioPanelIsPlaying(plot)) this._audioPause(panelId);
        else this._audioPlay(panelId);
    };

    proto._audioSeekTo = function(panelId, seconds) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureAudioState(plot);
        const duration = state.buffer?.duration || this._audioRangeDuration(plot);
        const target = Math.max(0, Math.min(Number(seconds) || 0, duration || 0));
        const wasPlaying = this._audioPanelIsPlaying(plot);
        state.position = target;
        if (wasPlaying) this._audioPlay(panelId);
        else { this._syncAudioStrip(panelId); this._renderAudioPlayheads(); }
    };

    proto._audioRangeDuration = function(plot) {
        const source = this._audioSelectedSource(plot);
        if (!source?.status?.ok) return 0;
        const range = this._audioRange(plot, source);
        if (!range) return 0;
        return Math.max(0, range[1] - range[0]);
    };

    proto._applyAudioVolume = function(state) {
        if (!player.master) return;
        const volume = state.muted ? 0 : Math.max(0, Math.min(1, Number(state.volume) || 0));
        player.master.gain.setTargetAtTime(volume, player.context.currentTime, 0.01);
    };

    // ─── Playhead ───────────────────────────────────────────────────

    proto._startAudioTick = function() {
        if (player.raf) return;
        const step = () => {
            player.raf = null;
            if (!player.playing || player.owner?.manager !== this) return;
            this._followAudioRangeChange();
            this._renderAudioPlayheads();
            this._syncAudioReadout();
            player.raf = requestAnimationFrame(step);
        };
        player.raf = requestAnimationFrame(step);
    };

    /**
     * The panel's selection can move while the sound is running — dragging an
     * FFT bound, typing a new x1. The sound has to follow it, since it IS that
     * selection; before this, the range only changed on the next stop and play.
     *
     * Polled from the tick rather than hooked into each analysis mode: the
     * range has four owners today and the tick already runs while playing, so
     * comparing two numbers there beats four callbacks that must not be
     * forgotten. The change is applied once it has been still for a moment,
     * so dragging a bound does not restart the take on every frame.
     */
    proto._followAudioRangeChange = function() {
        const panelId = player.owner?.panelId;
        const plot = this.plots.get(panelId);
        const state = plot?.audio;
        if (!state?.buffer) return;
        const source = this._audioSelectedSource(plot);
        if (!source?.status?.ok) return;
        const range = this._audioRange(plot, source);
        if (!range) return;

        const key = this._audioBufferKey(source, range, state);
        if (key === state.bufferKey) { state.pendingRangeKey = null; return; }
        const now = performance.now();
        if (state.pendingRangeKey !== key) {
            state.pendingRangeKey = key;
            state.pendingRangeSince = now;
            return;
        }
        if (now - state.pendingRangeSince < RANGE_SETTLE_MS) return;

        // Keep the instant when the new range still contains it; otherwise
        // start at the beginning of what was just selected.
        const absolute = state.buffer.startTime + this._audioPosition(plot);
        state.pendingRangeKey = null;
        state.buffer = null;
        state.bufferKey = '';
        state.position = (absolute >= range[0] && absolute <= range[1]) ? absolute - range[0] : 0;
        this._audioPlay(panelId);
    };

    proto._stopAudioTick = function() {
        if (player.raf) cancelAnimationFrame(player.raf);
        player.raf = null;
    };

    /**
     * The playhead is drawn in every panel that plots the sounding signal, not
     * only in the one that owns the strip: the clock is one, so the mark has to
     * agree everywhere it appears.
     */
    proto._renderAudioPlayheads = function() {
        const mark = this._audioCurrentMark();
        if (!mark) return;
        for (const [, plot] of this.plots) this._applyAudioMark(plot, mark);
    };

    /** Where the playhead is, in the signal's own time. Null when nothing sounds. */
    proto._audioCurrentMark = function() {
        if (!player.owner || player.owner.manager !== this) return null;
        const ownerPlot = this.plots.get(player.owner.panelId);
        if (!ownerPlot) return null;
        const built = this._ensureAudioState(ownerPlot).buffer;
        const source = this._audioSelectedSource(ownerPlot);
        if (!source?.status?.ok || !built) return null;
        return { sourceKey: source.key, dataTime: built.startTime + this._audioPosition(ownerPlot) };
    };

    proto._applyAudioMark = function(plot, mark) {
        const shows = (plot?.traces || []).some(trace => this._audioTraceKey(trace) === mark.sourceKey);
        if (!shows || !plot.div?.isConnected) { this._removeAudioPlayhead(plot); return; }
        this._drawAudioPlayhead(plot, mark.dataTime);
    };

    /**
     * Re-place this panel's playhead after the axes moved — a zoom, a pan, a
     * resize. Called from _refreshPanelDomOverlays, where the cursors are
     * re-placed for the same reason.
     */
    proto._refreshAudioPlayhead = function(plot) {
        if (!plot?.div?.isConnected) return;
        const mark = this._audioCurrentMark();
        if (!mark) { this._removeAudioPlayhead(plot); return; }
        this._applyAudioMark(plot, mark);
    };

    /**
     * Drawn INSIDE Plotly's first main-svg — the one holding the traces —
     * rather than as a div over the container.
     *
     * Plotly renders three stacked SVGs: the plot, then the one carrying the
     * legend, then the hover layer. A div on top of all of them paints over
     * the legend, which is wrong: the legend is a label for the picture and
     * the playhead is part of the picture. Appended last inside the first SVG,
     * it sits above every trace and below the legend, which is exactly where
     * it belongs — and moving an SVG attribute costs no more than moving a
     * div, so the 60 fps sweep is unaffected.
     */
    proto._drawAudioPlayhead = function(plot, dataTime) {
        const svg = plot?.div?.querySelector('svg.main-svg');
        if (!svg) return;
        const geometry = this._hoverOverlayGeometry?.(plot, dataTime);
        let head = svg.querySelector('.audio-playhead-svg');
        if (!geometry || geometry.left < geometry.leftAxis || geometry.left > geometry.rightAxis) {
            head?.remove();
            return;
        }
        if (!head) {
            const ns = 'http://www.w3.org/2000/svg';
            head = document.createElementNS(ns, 'g');
            head.setAttribute('class', 'audio-playhead-svg');
            head.setAttribute('aria-hidden', 'true');
            head.appendChild(document.createElementNS(ns, 'rect'));
            head.appendChild(document.createElementNS(ns, 'path'));
            svg.appendChild(head);
        }
        const top = geometry.topAxis;
        const height = Math.max(0, geometry.bottomAxis - geometry.topAxis);
        const x = geometry.left;
        const rect = head.firstChild;
        rect.setAttribute('x', String(x - 1));
        rect.setAttribute('y', String(top));
        rect.setAttribute('width', '2');
        rect.setAttribute('height', String(height));
        head.lastChild.setAttribute('d', `M${x - 6},${top} L${x + 6},${top} L${x},${top + 9} Z`);
    };

    proto._removeAudioPlayhead = function(plot) {
        plot?.div?.querySelector?.('.audio-playhead-svg')?.remove();
    };

    proto._clearAudioPlayheads = function() {
        for (const [, plot] of this.plots) this._removeAudioPlayhead(plot);
    };

    // ─── Click the curve to seek ────────────────────────────────────

    /**
     * Move the playhead by clicking the waveform, the way every audio editor
     * does — without taking the mouse away from Plotly, which owns the plot
     * area for zooming, and without stepping on the measurement cursors when
     * they are the ones being dragged.
     *
     * The guard is the whole trick: the press position is remembered, and the
     * release only seeks if the pointer barely moved. A zoom drag moves far
     * more than three pixels, so the two gestures never collide.
     */
    proto._installAudioSeekHandlers = function(panelId, plot) {
        const div = plot?.div;
        if (!div || plot._audioSeekDiv === div) return;
        this._removeAudioSeekHandlers(plot);
        plot._audioSeekDiv = div;
        let pressedAt = null;

        const onDown = (event) => {
            pressedAt = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
        };
        // The release is read on document, in the capture phase, because
        // Plotly's drag layer consumes mouseup before it reaches the container:
        // listening on the container gives a press that never ends.
        const onUp = (event) => {
            const start = pressedAt;
            pressedAt = null;
            if (!start || event.button !== 0) return;
            if (Math.abs(event.clientX - start.x) > CLICK_SLOP_PIXELS) return;
            if (Math.abs(event.clientY - start.y) > CLICK_SLOP_PIXELS) return;
            clearTimeout(plot._audioSeekTimer);
            const target = { clientX: event.clientX, clientY: event.clientY, target: event.target };
            plot._audioSeekTimer = setTimeout(() => this._audioSeekFromClick(panelId, target), DOUBLE_CLICK_GRACE_MS);
        };
        // The second click cancels the first one's seek, so zoom-fit does not
        // drag the playhead along with it.
        const onDoubleClick = () => clearTimeout(plot._audioSeekTimer);

        div.addEventListener('mousedown', onDown);
        document.addEventListener('mouseup', onUp, true);
        document.addEventListener('dblclick', onDoubleClick, true);
        plot._audioDocListeners = { up: onUp, dblclick: onDoubleClick };
    };

    /**
     * Drop the document listener. A panel that is closed rather than rebuilt
     * never re-installs, so without this its listener would sit on document for
     * the rest of the session holding the panel — the same trap the cursors
     * document listeners are swept for in _destroyChart.
     */
    proto._removeAudioSeekHandlers = function(plot) {
        if (!plot) return;
        if (plot._audioDocListeners?.up) {
            document.removeEventListener('mouseup', plot._audioDocListeners.up, true);
        }
        if (plot._audioDocListeners?.dblclick) {
            document.removeEventListener('dblclick', plot._audioDocListeners.dblclick, true);
        }
        clearTimeout(plot._audioSeekTimer);
        plot._audioDocListeners = null;
        plot._audioSeekDiv = null;
    };

    proto._audioSeekFromClick = function(panelId, event) {
        const plot = this.plots.get(panelId);
        if (!plot?.audio?.open || !plot.div) return;
        // A|B is being used: those cursors are dragged with the same button in
        // the same pixels, and moving the sound under them would be a surprise.
        if (this._anyCursorEnabled?.(plot)) return;
        if (event.target?.closest?.('.modebar, .legend, .audio-strip, .hover-info-box')) return;

        const source = this._audioSelectedSource(plot);
        if (!source?.status?.ok) return;

        const fullLayout = plot.div._fullLayout;
        const xa = fullLayout?.xaxis;
        const ya = fullLayout?.yaxis;
        if (!xa?.range || !xa._length) return;

        const rect = plot.div.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        const left = xa._offset || 0;
        if (x < left || x > left + xa._length) return;
        if (ya?._length) {
            const top = ya._offset || 0;
            if (y < top || y > top + ya._length) return;
        }

        const x0 = this._coerceAxisValue(xa.range[0]);
        const x1 = this._coerceAxisValue(xa.range[1]);
        if (!Number.isFinite(x0) || !Number.isFinite(x1) || x1 === x0) return;

        this._audioSeekToDataTime(panelId, x0 + ((x - left) / xa._length) * (x1 - x0));
    };

    /**
     * Seek to a point in the signal's own time. Outside the range being played
     * it lands on the nearest end rather than doing nothing: the click said
     * "over there", and the nearest playable point is the honest answer.
     */
    proto._audioSeekToDataTime = function(panelId, dataTime) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureAudioState(plot);
        const source = this._audioSelectedSource(plot);
        if (!source?.status?.ok) return;
        const start = Number.isFinite(state.buffer?.startTime)
            ? state.buffer.startTime
            : this._audioRange(plot, source)?.[0];
        if (!Number.isFinite(start)) return;
        this._audioSeekTo(panelId, dataTime - start);
    };

    // ─── The strip ──────────────────────────────────────────────────

    proto._toggleAudioStrip = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureAudioState(plot);
        state.open = !state.open;
        if (!state.open) {
            if (this._audioPanelIsPlaying(plot)) this._audioStop(panelId);
            this._removeAudioStrip(panelId);
            this._removeAudioSeekHandlers(plot);
        } else {
            this._syncAudioStrip(panelId);
        }
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        const button = panelEl?.querySelector('.panel-audio-btn');
        if (button) {
            button.classList.toggle('active', state.open);
            button.setAttribute('aria-pressed', String(state.open));
        }
        // The strip takes height from the chart. Tell Plotly now rather than
        // waiting for the ResizeObserver: until it re-lays out, its drag layer
        // still covers the pixels the strip now occupies, and the strip's own
        // buttons cannot be clicked.
        this._resizePanelCharts?.(panelId);
    };

    proto._removeAudioStrip = function(panelId) {
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        panelEl?.querySelector('.audio-strip')?.remove();
    };

    proto._syncAudioStrip = function(panelId) {
        const plot = this.plots.get(panelId);
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        if (!plot || !panelEl) return;
        const state = this._ensureAudioState(plot);
        if (!state.open) {
            this._removeAudioStrip(panelId);
            this._removeAudioSeekHandlers(plot);
            return;
        }

        let strip = panelEl.querySelector('.audio-strip');
        if (!strip) strip = this._buildAudioStrip(panelId);
        // A rebuilt chart is appended to the panel, so a strip created earlier
        // would end up above it. Keep it last, always.
        if (panelEl.lastElementChild !== strip) panelEl.appendChild(strip);
        this._installAudioSeekHandlers(panelId, plot);
        this._updateAudioStrip(panelId, strip);
    };

    proto._buildAudioStrip = function(panelId) {
        const strip = document.createElement('div');
        strip.className = 'audio-strip';
        strip.dataset.panelId = panelId;
        // Every control that is not a universally understood transport symbol
        // carries a written label. The first read of this strip found the two
        // dropdowns unreadable and the loop button mistaken for "refresh",
        // which is what an unlabelled icon buys.
        strip.innerHTML = `
            <div class="audio-strip-row">
                <button type="button" class="audio-btn audio-play" title="${i18n.t('audioPlay')}" aria-label="${i18n.t('audioPlay')}">▶</button>
                <button type="button" class="audio-btn audio-stop" title="${i18n.t('audioStop')}" aria-label="${i18n.t('audioStop')}">⏹</button>
                <button type="button" class="audio-btn audio-loop audio-btn-wide" aria-pressed="false" title="${i18n.t('audioLoop')}" aria-label="${i18n.t('audioLoop')}">⟲ ${i18n.t('audioLoopLabel')}</button>
                <span class="audio-readout" role="status"></span>
                <input type="range" class="audio-seek" min="0" max="1000" value="0" step="1" aria-label="${i18n.t('audioSeek')}">
                <label class="audio-field">
                    <span class="audio-label">${i18n.t('audioSourceLabel')}</span>
                    <select class="audio-source" title="${i18n.t('audioSource')}" aria-label="${i18n.t('audioSource')}"></select>
                </label>
                <label class="audio-field">
                    <span class="audio-label">${i18n.t('audioScaleLabel')}</span>
                    <select class="audio-scale" title="${i18n.t('audioScaleHelp')}" aria-label="${i18n.t('audioScale')}">
                        <option value="auto">${i18n.t('audioScaleAuto')}</option>
                        <option value="fixed">${i18n.t('audioScaleFixed')}</option>
                        <option value="manual">${i18n.t('audioScaleManual')}</option>
                    </select>
                </label>
                <input type="number" class="audio-gain-db" step="1" value="0" title="${i18n.t('audioGainDb')}" aria-label="${i18n.t('audioGainDb')}" hidden>
                <label class="audio-dc"><input type="checkbox" class="audio-dc-input" checked> ${i18n.t('audioRemoveDC')}</label>
                <button type="button" class="audio-btn audio-mute" aria-pressed="false" title="${i18n.t('audioMute')}" aria-label="${i18n.t('audioMute')}">🔈</button>
                <input type="range" class="audio-volume" min="0" max="100" value="70" step="1" title="${i18n.t('audioVolume')}" aria-label="${i18n.t('audioVolume')}">
            </div>
            <div class="audio-strip-note" role="status"></div>
        `;

        const plot = this.plots.get(panelId);
        const state = this._ensureAudioState(plot);
        const onOptionChange = () => {
            // Any option that changes the samples invalidates the buffer; the
            // next play rebuilds it.
            state.buffer = null;
            state.bufferKey = '';
            if (this._audioPanelIsPlaying(plot)) this._audioPlay(panelId);
            else this._syncAudioStrip(panelId);
        };

        strip.querySelector('.audio-play').addEventListener('click', () => this._audioTogglePlay(panelId));
        strip.querySelector('.audio-stop').addEventListener('click', () => this._audioStop(panelId));
        strip.querySelector('.audio-loop').addEventListener('click', () => {
            state.loop = !state.loop;
            // Set it on the take that is already sounding. Restarting to apply
            // it rebuilt the node and dropped the playhead back by the time
            // that took — half a second of rewind for a setting that the Web
            // Audio node accepts live.
            if (this._audioPanelIsPlaying(plot) && player.node) {
                player.node.loop = state.loop;
                player.loop = state.loop;
            }
            this._syncAudioStrip(panelId);
        });
        const seek = strip.querySelector('.audio-seek');
        // Scrubbing is silent: the sound stops when the handle is grabbed and
        // picks up from the new point when it is let go. Seeking on every
        // pixel of the drag restarts the take on each one, which stutters and
        // keeps playing from wherever the pointer paused.
        seek.addEventListener('pointerdown', () => {
            state.resumeAfterScrub = this._audioPanelIsPlaying(plot);
            if (state.resumeAfterScrub) this._audioPause(panelId);
        });
        seek.addEventListener('input', (event) => {
            const duration = state.buffer?.duration || this._audioRangeDuration(plot);
            this._audioSeekTo(panelId, (Number(event.target.value) / 1000) * duration);
        });
        seek.addEventListener('change', () => {
            if (!state.resumeAfterScrub) return;
            state.resumeAfterScrub = false;
            this._audioPlay(panelId);
        });
        strip.querySelector('.audio-source').addEventListener('change', (event) => {
            // Switching signal keeps the instant: that is the whole point of
            // comparing a recording with its filtered version — the same
            // moment, the other signal. Only a signal that does not reach that
            // instant (another recording, another length) starts from its own
            // beginning.
            const previous = this._audioSelectedSource(plot);
            const previousStart = Number.isFinite(state.buffer?.startTime)
                ? state.buffer.startTime
                : this._audioRange(plot, previous)?.[0];
            const absolute = Number.isFinite(previousStart)
                ? previousStart + this._audioPosition(plot)
                : null;

            state.sourceKey = event.target.value;
            state.buffer = null;
            state.bufferKey = '';

            const next = this._audioSelectedSource(plot);
            const nextRange = next?.status?.ok ? this._audioRange(plot, next) : null;
            state.position = (absolute !== null && nextRange
                && absolute >= nextRange[0] && absolute <= nextRange[1])
                ? absolute - nextRange[0]
                : 0;
            onOptionChange();
        });
        strip.querySelector('.audio-scale').addEventListener('change', (event) => {
            state.scale = event.target.value;
            onOptionChange();
        });
        strip.querySelector('.audio-gain-db').addEventListener('change', (event) => {
            state.manualDb = Number(event.target.value) || 0;
            onOptionChange();
        });
        strip.querySelector('.audio-dc-input').addEventListener('change', (event) => {
            state.removeDC = !!event.target.checked;
            onOptionChange();
        });
        strip.querySelector('.audio-mute').addEventListener('click', () => {
            state.muted = !state.muted;
            this._applyAudioVolume(state);
            this._syncAudioStrip(panelId);
        });
        strip.querySelector('.audio-volume').addEventListener('input', (event) => {
            state.volume = Number(event.target.value) / 100;
            state.muted = false;
            this._applyAudioVolume(state);
            this._syncAudioStrip(panelId);
        });

        return strip;
    };

    proto._updateAudioStrip = function(panelId, strip) {
        const plot = this.plots.get(panelId);
        if (!plot || !strip) return;
        const state = this._ensureAudioState(plot);
        const sources = this._audioSources(plot);
        // The chosen signal is gone from the panel — cleared, or removed from
        // the legend. Whatever comes next is a fresh start, not a resumption of
        // something that is no longer on screen.
        if (state.sourceKey && !sources.some(source => source.key === state.sourceKey)) {
            if (this._audioPanelIsPlaying(plot)) this._audioStop(panelId);
            state.sourceKey = null;
            state.position = 0;
            state.buffer = null;
            state.bufferKey = '';
            state.notice = '';
        }
        const selected = this._audioSelectedSource(plot);
        const playing = this._audioPanelIsPlaying(plot);
        const playable = !!selected?.status?.ok;

        const select = strip.querySelector('.audio-source');
        const wanted = sources.map(source => `${source.key}\u0001${source.label}\u0001${source.status.ok ? 1 : 0}`).join('\u0002');
        if (select.dataset.signature !== wanted) {
            select.dataset.signature = wanted;
            select.innerHTML = '';
            for (const source of sources) {
                const option = document.createElement('option');
                option.value = source.key;
                option.textContent = source.status.ok
                    ? source.label
                    : `${source.label} — ${this._audioReasonText(source.status)}`;
                option.disabled = !source.status.ok;
                select.appendChild(option);
            }
        }
        if (selected) select.value = selected.key;

        strip.querySelector('.audio-play').textContent = playing ? '⏸' : '▶';
        strip.querySelector('.audio-play').disabled = !playable;
        strip.querySelector('.audio-stop').disabled = !playable;
        const loopBtn = strip.querySelector('.audio-loop');
        loopBtn.classList.toggle('active', !!state.loop);
        loopBtn.setAttribute('aria-pressed', String(!!state.loop));
        loopBtn.disabled = !playable;
        strip.querySelector('.audio-seek').disabled = !playable;
        strip.querySelector('.audio-scale').value = state.scale;
        const gainInput = strip.querySelector('.audio-gain-db');
        gainInput.hidden = state.scale !== 'manual';
        gainInput.value = String(state.manualDb);
        strip.querySelector('.audio-dc-input').checked = !!state.removeDC;
        const muteBtn = strip.querySelector('.audio-mute');
        muteBtn.textContent = state.muted ? '🔇' : '🔈';
        muteBtn.setAttribute('aria-pressed', String(!!state.muted));
        strip.querySelector('.audio-volume').value = String(Math.round(state.volume * 100));

        const note = strip.querySelector('.audio-strip-note');
        const reason = playable
            ? ''
            : (sources.length ? this._audioReasonText(selected?.status) : i18n.t('audioReasonNoTraces'));
        const rangeNote = playable ? this._audioRangeNote(plot, selected) : '';
        const text = [reason, state.notice, rangeNote].filter(Boolean).join(' · ');
        note.textContent = text;
        note.hidden = !text;

        this._syncAudioReadout();
    };

    proto._audioRangeNote = function(plot, source) {
        const range = this._audioRange(plot, source);
        if (!range) return '';
        const rate = Math.round(source.status.sampleRate).toLocaleString();
        const isAnalysisSelection = ['fft', 'histogram', 'integral'].includes(plot.mode);
        const label = isAnalysisSelection ? i18n.t('audioRangeFromPanel') : i18n.t('audioRangeWhole');
        return `${label} ${range[0].toFixed(3)} – ${range[1].toFixed(3)} s · ${rate} Hz`;
    };

    proto._syncAudioReadout = function() {
        for (const [panelId, plot] of this.plots) {
            const state = plot.audio;
            if (!state?.open) continue;
            const strip = document.querySelector(`.layout-panel[data-id="${panelId}"] .audio-strip`);
            if (!strip) continue;
            const duration = state.buffer?.duration || this._audioRangeDuration(plot);
            const position = this._audioPosition(plot);
            strip.querySelector('.audio-readout').textContent =
                `${formatClock(position)} / ${formatClock(duration)}`;
            const seek = strip.querySelector('.audio-seek');
            if (document.activeElement !== seek) {
                seek.value = String(duration > 0 ? Math.round((position / duration) * 1000) : 0);
            }
        }
    };

    proto._audioReasonText = function(status) {
        if (!status || status.ok) return '';
        switch (status.reason) {
            case 'lazy':        return i18n.t('audioReasonLazy');
            case 'nonUniform':  return i18n.t('audioReasonNonUniform');
            case 'nonMonotonic':return i18n.t('audioReasonNonUniform');
            case 'tooFewSamples': return i18n.t('audioReasonTooFewSamples');
            case 'timeAxis':    return i18n.t('audioReasonTimeAxis');
            case 'rateTooLow':  return i18n.t('audioReasonRateTooLow')
                .replace('{rate}', Math.round(status.sampleRate || 0).toLocaleString());
            case 'rateTooHigh': return i18n.t('audioReasonRateTooHigh')
                .replace('{rate}', Math.round(status.sampleRate || 0).toLocaleString());
            default:            return i18n.t('audioReasonUnavailable');
        }
    };

    // ─── Lifecycle ──────────────────────────────────────────────────

    /**
     * Called from _destroyChart: the panel's chart is going away.
     *
     * The strip is deliberately left in place. It belongs to the panel, not to
     * the chart, and a chart is destroyed and rebuilt for ordinary reasons — a
     * trace removed from the legend, a mode change. Taking the strip out and
     * putting it back changes the panel's height twice per rebuild, which
     * makes the rebuild flash. What does have to go is the sound, the
     * playhead, and the listeners bound to the element being dropped.
     */
    proto._teardownAudioForPanel = function(panelId, plot) {
        if (player.owner?.manager === this && player.owner.panelId === panelId) {
            this._audioReleaseNode();
            this._stopAudioTick();
            player.owner = null;
        }
        this._removeAudioPlayhead(plot);
        if (!plot?.audio?.open) this._removeAudioStrip(panelId);
        this._removeAudioSeekHandlers(plot);
        const state = plot?.audio;
        if (state) { state.buffer = null; state.bufferKey = ''; }
    };

    /** Called when a file closes, the language changes, or the layout resets. */
    proto.stopAudioPlayback = function() {
        if (player.owner?.manager !== this) return;
        const panelId = player.owner.panelId;
        this._audioReleaseNode();
        this._stopAudioTick();
        this._clearAudioPlayheads();
        player.owner = null;
        this._syncAudioStrip(panelId);
    };
}
