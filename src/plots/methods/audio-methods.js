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
/**
 * Draw the idle (grey) mark when it sits at the very start of the range.
 *
 * Off by default: at position zero the line lands on the axis itself, where it
 * reads as part of the frame rather than as a cursor, so a panel that has not
 * been played yet shows nothing. Everywhere else the idle mark is drawn, so
 * the seek slider always has a visible answer to "where am I?". Flip this to
 * true to have it drawn at the start too.
 */
const SHOW_IDLE_MARK_AT_START = false;

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
 * A number that changes when the samples do.
 *
 * Recomputing a data tool — a new M for a moving average, another cutoff —
 * replaces the variable's array rather than editing it, which is the same
 * contract the missing-data overlays rely on. So the array's identity IS the
 * version of what should be heard, and putting it in the buffer's key is what
 * makes a stale take impossible: no identity, no cache hit.
 */
const sampleStamps = new WeakMap();
let nextSampleStamp = 1;
const sampleStamp = (values) => {
    if (!values || typeof values !== 'object') return 0;
    let stamp = sampleStamps.get(values);
    if (!stamp) {
        stamp = nextSampleStamp++;
        sampleStamps.set(values, stamp);
    }
    return stamp;
};

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

/**
 * Where the playhead is, in seconds from the start of the range.
 *
 * Exported and pure because it is the piece that has already been wrong once:
 * while looping, the elapsed time runs past the buffer's length and only the
 * modulo brings it back, so switching loop off has to re-anchor the clock or
 * the clamp pins the mark at the end. Both halves are covered by
 * scripts/test-audio-player.mjs.
 */
export function positionInRange(offset, elapsed, duration, loop) {
    if (!(duration > 0)) return 0;
    const raw = offset + Math.max(0, elapsed);
    return loop ? raw % duration : Math.min(raw, duration);
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

// Transport icons as inline SVG rather than glyphs. Centring a button's
// content centres the line box, not the ink inside it, and the pause and play
// characters carry their ink off-centre — visibly so at 22 px. A path is drawn
// where it is told, in currentColor, and renders the same on every platform.
const ICONS = {
    play:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.4v14H7zm6.6 0H17v14h-3.4z"/></svg>',
    stop:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 6.5h11v11h-11z"/></svg>',
    loop:  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v3l4-4-4-4v3H5v6h2zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2z"/></svg>',
    volume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5zm10.5-1.2v7.4a4 4 0 0 0 0-7.4z"/></svg>',
    muted: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5v5h3.5L12 19V5L7.5 9.5zm15 .1-1.4-1.4-2.1 2.1-2.1-2.1L12 9.6l2.1 2.1-2.1 2.1 1.4 1.4 2.1-2.1 2.1 2.1 1.4-1.4-2.1-2.1z"/></svg>',
};

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
            removeDC: true,
            buffer: null,
            bufferKey: '',
            notice: '',
            resumeAfterScrub: false,
            pendingRebuildKey: null,
            pendingRebuildSince: 0,
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

        // One amplitude rule, not a choice: the peak goes to −1 dBFS. A signal
        // is plotted in its own units and heard at a level that works, and the
        // three-way selector that used to offer fixed and manual gain was read
        // as "no idea what this does" by the first person to use the strip.
        const gain = peak > 0 ? AUTO_PEAK / peak : 1;

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

    /**
     * What a built buffer is a copy OF. Two takes with the same key sound the
     * same, so the buffer is kept; anything else rebuilds it.
     *
     * The samples' stamp is the part that took a bug to learn. The key used to
     * name only the signal, the range and Remove DC — all of which stay put
     * when a data tool is re-run with new parameters — so a moving average
     * kept playing the M it was built with, through stop and play, until the
     * dropdown was moved to another signal and back. The signal's NAME is not
     * its contents.
     */
    proto._audioBufferKey = function(source, range, state) {
        const values = source.status?.values;
        return [
            source.key,
            sampleStamp(values),
            values?.length || 0,
            range[0],
            range[1],
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
        return positionInRange(player.offset, elapsed, player.duration, player.loop);
    };

    /**
     * Does this panel hold the player? A strip commands its own panel and
     * nothing else: the node, the clock and the gain are shared, so every
     * control that touches them has to ask this first.
     */
    proto._audioPanelOwnsPlayer = function(panelId) {
        return !!(player.owner && player.owner.manager === this && player.owner.panelId === panelId);
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
        player.owner = null;
        // After the hand-over, not before: with the player let go, the panel
        // that was sounding re-draws its mark in the parked grey.
        manager._renderAudioPlayheads?.();
        if (previous) manager._syncAudioStrip?.(panelId);
    };

    proto._audioPlay = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureAudioState(plot);
        const source = this._audioSelectedSource(plot);
        if (!source?.status?.ok) return;

        const context = this._audioEnsureContext();
        if (!context) { state.notice = () => i18n.t('audioNoContext'); this._syncAudioStrip(panelId); return; }

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
        const wasSounding = player.playing;
        this._audioYieldPlayer();
        state.position = requestedPosition;

        const key = this._audioBufferKey(source, range, state);
        if (state.bufferKey !== key || !state.buffer) {
            const built = this._buildAudioBuffer(context, source, range, state);
            if (built.error) {
                const errorKey = BUILD_ERROR_KEYS[built.error] || 'audioReasonUnavailable';
                state.notice = () => i18n.t(errorKey);
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
        nodeGain.connect(player.master);
        if (wasSounding) {
            // Crossfade: the take being left is already ramping down over the
            // same 10 ms inside _audioReleaseNode, so fading this one up over
            // that window closes the gap instead of leaving the click that a
            // straight cut leaves. It costs one extra gain node for 10 ms.
            nodeGain.gain.setValueAtTime(0.0001, context.currentTime);
            nodeGain.gain.linearRampToValueAtTime(1, context.currentTime + INTERRUPT_FADE_SECONDS);
        } else {
            nodeGain.gain.setValueAtTime(1, context.currentTime);
        }
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
        this._applyAudioVolume(state, panelId);

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
            // The mark stays where the sound ran out, in grey: it is the
            // reading the strip shows, and losing it left the chart blank
            // while the strip still said 3:00.
            this._renderAudioPlayheads();
            this._syncAudioStrip(panelId);
        };

        node.start(0, state.position);
        this._startAudioTick();
        this._syncAudioStrip(panelId);
    };

    /**
     * Returned as a function, not as a sentence.
     *
     * A note written at build time froze the language it was built in: play a
     * 44.1 kHz file on a 48 kHz output, switch the app to Spanish, and the
     * strip still read "44,100 Hz played at 48,000 Hz (resampled by the
     * browser)" — the only English left on the panel. The strip now asks for
     * the words when it draws them, which is the same thing the data tools'
     * messages do for the same reason.
     */
    proto._audioBufferNotice = function(source, built) {
        const sampleRate = source.status.sampleRate;
        return () => this._audioBufferNoticeText(sampleRate, built);
    };

    proto._audioBufferNoticeText = function(sampleRate, built) {
        const notes = [];
        if (built.clipped > 0) {
            notes.push(i18n.t('audioClipped').replace('{count}', built.clipped.toLocaleString()));
        }
        if (built.nanCount > 0) {
            notes.push(i18n.t('audioNaNs').replace('{count}', built.nanCount.toLocaleString()));
        }
        const contextRate = player.context?.sampleRate;
        if (contextRate && Math.abs(contextRate - sampleRate) > 1) {
            notes.push(i18n.t('audioResampled')
                .replace('{from}', Math.round(sampleRate).toLocaleString())
                .replace('{to}', Math.round(contextRate).toLocaleString()));
        }
        return notes.join(' · ');
    };

    proto._audioPause = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureAudioState(plot);
        state.position = this._audioPosition(plot);
        // Only the panel holding the player may silence it. Pressing pause on
        // a strip that is not sounding parks its own cursor and leaves the
        // panel that IS sounding alone.
        if (this._audioPanelOwnsPlayer(panelId)) {
            this._audioReleaseNode();
            this._stopAudioTick();
        }
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
        // The bug this guard is here for: stop released whatever node was
        // sounding, so pressing it on an idle strip cut the panel that was
        // actually playing. A strip stops its own panel and no other.
        if (this._audioPanelOwnsPlayer(panelId)) {
            this._audioReleaseNode();
            this._stopAudioTick();
        }
        state.position = 0;
        this._renderAudioPlayheads();
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

    /**
     * The gain is the player's, and the player belongs to one panel: a strip
     * that is not sounding records its volume for its next take rather than
     * turning down the panel that is.
     */
    proto._applyAudioVolume = function(state, panelId) {
        if (!player.master) return;
        if (panelId !== undefined && !this._audioPanelOwnsPlayer(panelId)) return;
        const volume = state.muted ? 0 : Math.max(0, Math.min(1, Number(state.volume) || 0));
        player.master.gain.setTargetAtTime(volume, player.context.currentTime, 0.01);
    };

    // ─── Playhead ───────────────────────────────────────────────────

    proto._startAudioTick = function() {
        if (player.raf) return;
        const step = () => {
            player.raf = null;
            if (!player.playing || player.owner?.manager !== this) return;
            this._followAudioSourceChange();
            this._renderAudioPlayheads();
            this._syncAudioReadout();
            player.raf = requestAnimationFrame(step);
        };
        player.raf = requestAnimationFrame(step);
    };

    /**
     * What is being played can change under the sound: the panel's selection
     * moves — dragging an FFT bound, typing a new x1 — or the samples
     * themselves are recomputed, which is what happens when a data tool's
     * parameters are edited while its output is playing. Either way the sound
     * has to follow, since it IS that selection of those samples.
     *
     * Polled from the tick rather than hooked into each producer: the range
     * has four owners today and the data tools more, and the tick already runs
     * while playing, so comparing one key there beats a dozen callbacks that
     * must not be forgotten. The change is applied once it has been still for
     * a moment, so dragging a bound — or an M slider — does not restart the
     * take on every frame, and the instant is kept across the rebuild.
     */
    proto._followAudioSourceChange = function() {
        const panelId = player.owner?.panelId;
        const plot = this.plots.get(panelId);
        const state = plot?.audio;
        if (!state?.buffer) return;
        const source = this._audioSelectedSource(plot);
        if (!source?.status?.ok) return;
        const range = this._audioRange(plot, source);
        if (!range) return;

        const key = this._audioBufferKey(source, range, state);
        if (key === state.bufferKey) { state.pendingRebuildKey = null; return; }
        const now = performance.now();
        if (state.pendingRebuildKey !== key) {
            state.pendingRebuildKey = key;
            state.pendingRebuildSince = now;
            return;
        }
        if (now - state.pendingRebuildSince < RANGE_SETTLE_MS) return;

        // Keep the instant when the new range still contains it; otherwise
        // start at the beginning of what was just selected. A recompute keeps
        // the range, so the instant simply survives it.
        const absolute = state.buffer.startTime + this._audioPosition(plot);
        state.pendingRebuildKey = null;
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
     * Each panel draws its own mark, and only its own: the live one in the
     * panel that holds the player, a parked grey one in any other panel that
     * has been left somewhere in its signal.
     *
     * The live mark used to be copied into every panel plotting the same
     * signal, on the grounds that the clock is one. In front of two panels
     * that reads as two players running at once, which is the one thing the
     * feature promises never to do — and it cannot happen here, because a mark
     * can only be live in the panel that owns the player.
     */
    proto._renderAudioPlayheads = function() {
        for (const [panelId, plot] of this.plots) {
            this._applyAudioMark(plot, this._audioPanelMark(panelId, plot));
        }
    };

    /**
     * Where this panel's mark belongs, in the signal's own time, and whether
     * the sound is running under it. Null when the panel has no mark to show.
     */
    proto._audioPanelMark = function(panelId, plot = this.plots.get(panelId)) {
        // A closed strip has no mark. Without this, every relayout after
        // closing redrew the playhead the close had just cleared: pause leaves
        // the panel owning the player, and the mark came back with the panel's
        // next repaint.
        if (!plot?.audio?.open) return null;
        const source = this._audioSelectedSource(plot);
        if (!source?.status?.ok) return null;
        const state = this._ensureAudioState(plot);
        // Before the first play there is no buffer, and the range's own start
        // is what the seek slider is measured against.
        const start = Number.isFinite(state.buffer?.startTime)
            ? state.buffer.startTime
            : this._audioRange(plot, source)?.[0];
        if (!Number.isFinite(start)) return null;
        const live = this._audioPanelIsPlaying(plot);
        const position = this._audioPosition(plot);
        if (!live && position <= 0 && !SHOW_IDLE_MARK_AT_START) return null;
        return { sourceKey: source.key, dataTime: start + position, live };
    };

    proto._applyAudioMark = function(plot, mark) {
        if (!mark) { this._removeAudioPlayhead(plot); return; }
        const shows = (plot?.traces || []).some(trace => this._audioTraceKey(trace) === mark.sourceKey);
        if (!shows || !plot.div?.isConnected) { this._removeAudioPlayhead(plot); return; }
        this._drawAudioPlayhead(plot, mark.dataTime, mark.live);
    };

    /**
     * Re-place this panel's playhead after the axes moved — a zoom, a pan, a
     * resize. Called from _refreshPanelDomOverlays, where the cursors are
     * re-placed for the same reason.
     */
    proto._refreshAudioPlayhead = function(plot) {
        if (!plot?.div?.isConnected) return;
        for (const [panelId, candidate] of this.plots) {
            if (candidate !== plot) continue;
            this._applyAudioMark(plot, this._audioPanelMark(panelId, plot));
            return;
        }
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
    proto._drawAudioPlayhead = function(plot, dataTime, live = true) {
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
        // Set on every draw, not only on creation: the same mark goes from red
        // to grey in place when the sound stops under it.
        head.setAttribute('class', live ? 'audio-playhead-svg' : 'audio-playhead-svg audio-playhead-idle');
    };

    proto._removeAudioPlayhead = function(plot) {
        plot?.div?.querySelector?.('.audio-playhead-svg')?.remove();
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
            // What the gesture IS gets decided where it starts. A shift-click
            // on a legend entry removes that curve, and its release reaches
            // this handler looking like an ordinary click over the plot area —
            // the legend sits inside that rectangle when it is drawn as an
            // overlay — which seeked the sound on every curve removed. Any
            // modifier is somebody else's gesture too: the cursors use them.
            const onChrome = event.target?.closest?.('.legend, .modebar, .audio-strip, .hover-info-box');
            const modified = event.shiftKey || event.ctrlKey || event.altKey || event.metaKey;
            pressedAt = (event.button === 0 && !onChrome && !modified)
                ? { x: event.clientX, y: event.clientY }
                : null;
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
            const owned = player.owner?.manager === this && player.owner.panelId === panelId;
            if (this._audioPanelIsPlaying(plot)) this._audioStop(panelId);
            // Closing takes this panel's mark with it — a strip closed while
            // PAUSED used to leave the line on the chart, since pause keeps
            // the playhead on purpose and nothing was undoing that. A closed
            // strip has no mark, so re-drawing is enough to remove it.
            if (owned) {
                // Hand the player back: this panel is no longer listening, so
                // nothing about it should keep the player pointed at it.
                player.owner = null;
            }
            this._renderAudioPlayheads();
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
        // would end up above it. Keep it last, always — and whenever it moves,
        // tell Plotly, because until it re-lays out its SVG keeps the height it
        // had before the strip took its share and overhangs it.
        if (panelEl.lastElementChild !== strip) {
            panelEl.appendChild(strip);
            this._resizePanelCharts?.(panelId);
        }
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
                <button type="button" class="audio-btn audio-play" title="${i18n.t('audioPlay')}" aria-label="${i18n.t('audioPlay')}">${ICONS.play}</button>
                <button type="button" class="audio-btn audio-stop" title="${i18n.t('audioStop')}" aria-label="${i18n.t('audioStop')}">${ICONS.stop}</button>
                <button type="button" class="audio-btn audio-loop audio-btn-wide" aria-pressed="false" title="${i18n.t('audioLoop')}" aria-label="${i18n.t('audioLoop')}">${ICONS.loop}<span>${i18n.t('audioLoopLabel')}</span></button>
                <span class="audio-readout" role="status"></span>
                <input type="range" class="audio-seek" min="0" max="1000" value="0" step="1" aria-label="${i18n.t('audioSeek')}">
                <label class="audio-field">
                    <span class="audio-label">${i18n.t('audioSourceLabel')}</span>
                    <select class="audio-source" title="${i18n.t('audioSource')}" aria-label="${i18n.t('audioSource')}"></select>
                </label>
                <label class="audio-dc" title="${i18n.t('audioRemoveDC')}"><input type="checkbox" class="audio-dc-input" checked> <span class="audio-dc-text">${i18n.t('audioRemoveDC')}</span></label>
                <button type="button" class="audio-btn audio-mute" aria-pressed="false" title="${i18n.t('audioMute')}" aria-label="${i18n.t('audioMute')}">${ICONS.volume}</button>
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
                // Read the position BEFORE the flag flips, then re-anchor the
                // clock to it. While looping, the elapsed time runs past the
                // buffer's length again and again and only the modulo keeps it
                // inside the range; dropping the modulo without re-anchoring
                // left the playhead pinned at the end of the range while the
                // sound carried on correctly.
                const position = this._audioPosition(plot);
                player.node.loop = state.loop;
                player.loop = state.loop;
                player.offset = position;
                player.startedAt = player.context.currentTime;
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
        strip.querySelector('.audio-dc-input').addEventListener('change', (event) => {
            state.removeDC = !!event.target.checked;
            onOptionChange();
        });
        strip.querySelector('.audio-mute').addEventListener('click', () => {
            state.muted = !state.muted;
            this._applyAudioVolume(state, panelId);
            this._syncAudioStrip(panelId);
        });
        strip.querySelector('.audio-volume').addEventListener('input', (event) => {
            state.volume = Number(event.target.value) / 100;
            state.muted = false;
            this._applyAudioVolume(state, panelId);
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
        const wanted = sources
            .map(source => `${source.key}\u0001${source.label}\u0001${source.color}\u0001${source.status.ok ? 1 : 0}`)
            .join('\u0002');
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
                // Each entry in the trace's own colour, so the list reads like
                // the legend it is naming rather than like a list of strings.
                if (source.color) option.style.color = source.color;
                select.appendChild(option);
            }
        }
        if (selected) {
            select.value = selected.key;
            // And the closed select shows the colour of what is selected — the
            // one place the colour is worth having, since it is the signal the
            // playhead is tracing.
            select.style.color = selected.status.ok && selected.color ? selected.color : '';
        }

        const playBtn = strip.querySelector('.audio-play');
        playBtn.innerHTML = playing ? ICONS.pause : ICONS.play;
        // The icon is a path now, so the state has to be readable some other
        // way — by a stylesheet, by a test, by anyone inspecting the strip.
        playBtn.dataset.state = playing ? 'playing' : 'paused';
        strip.querySelector('.audio-play').disabled = !playable;
        strip.querySelector('.audio-stop').disabled = !playable;
        const loopBtn = strip.querySelector('.audio-loop');
        loopBtn.classList.toggle('active', !!state.loop);
        loopBtn.setAttribute('aria-pressed', String(!!state.loop));
        loopBtn.disabled = !playable;
        strip.querySelector('.audio-seek').disabled = !playable;
        strip.querySelector('.audio-dc-input').checked = !!state.removeDC;
        const muteBtn = strip.querySelector('.audio-mute');
        muteBtn.innerHTML = state.muted ? ICONS.muted : ICONS.volume;
        muteBtn.setAttribute('aria-pressed', String(!!state.muted));
        strip.querySelector('.audio-volume').value = String(Math.round(state.volume * 100));

        const note = strip.querySelector('.audio-strip-note');
        const reason = playable
            ? ''
            : (sources.length ? this._audioReasonText(selected?.status) : i18n.t('audioReasonNoTraces'));
        // Only things worth a line: why nothing can be played, clipping, missing
        // samples, a rate the browser had to resample. The range and the sample
        // rate used to sit here permanently and cost a row of a strip that has
        // to stay thin — the readout already gives the length of what is
        // playing, and the panel already shows the selection it came from.
        const notice = typeof state.notice === 'function' ? state.notice() : state.notice;
        const text = [reason, notice].filter(Boolean).join(' · ');
        note.textContent = text;
        note.hidden = !text;

        this._syncAudioReadout();
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
     * The sound is NOT stopped here, and neither is the strip removed. A chart
     * is destroyed and rebuilt for ordinary reasons that have nothing to do
     * with listening — a data tool drawing its preview, a trace removed from
     * the legend, a rename — and stopping the audio on each of them made the
     * player unusable while working: the moment a filter previewed, the sound
     * cut out. The buffer is a copy, so playback does not depend on the chart
     * that was just dropped.
     *
     * What does have to go is everything bound to the element being dropped:
     * the playhead drawn inside its SVG, and the seek listeners. Both come
     * back when the new chart appears — the playhead on the next frame of the
     * playback tick, the listeners from _syncAudioStrip.
     *
     * Listening ends elsewhere, where it actually ends: a panel unmounted, a
     * panel cleared, a mode with no 🔊 button, a file closed.
     */
    proto._teardownAudioForPanel = function(panelId, plot) {
        this._removeAudioPlayhead(plot);
        if (!plot?.audio?.open) this._removeAudioStrip(panelId);
        this._removeAudioSeekHandlers(plot);
        // The buffer is kept. A redraw does not change the samples, and the
        // playhead reads its startTime to know where in the signal the sound
        // is: dropping it here left the audio playing with no mark on the new
        // chart. It goes when the source or the range changes — the key says
        // so — or when the panel is cleared.
    };

    /**
     * End listening in this panel, if it is the one making sound. Called where
     * listening genuinely ends — the panel is unmounted or cleared, or its mode
     * no longer has anything to play — as opposed to the chart merely being
     * redrawn, which _teardownAudioForPanel now survives.
     */
    proto._stopAudioIfOwner = function(panelId) {
        if (player.owner?.manager !== this || player.owner.panelId !== panelId) return;
        this._audioReleaseNode();
        this._stopAudioTick();
        player.owner = null;
        const plot = this.plots.get(panelId);
        if (plot?.audio) plot.audio.position = 0;
        this._renderAudioPlayheads();
    };

    /** Called when a file closes, the language changes, or the layout resets. */
    proto.stopAudioPlayback = function() {
        if (player.owner?.manager !== this) return;
        const panelId = player.owner.panelId;
        this._audioReleaseNode();
        this._stopAudioTick();
        player.owner = null;
        this._renderAudioPlayheads();
        this._syncAudioStrip(panelId);
    };
}
