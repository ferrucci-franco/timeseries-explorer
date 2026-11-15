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
// Phase 1 of #86 (issue #89), and where the feature stops (see the status at
// the top of docs/audio-playback-design.md). The range is read-only here: the
// analysis selection when the panel is in an analysis mode; in timeseries mode
// the whole record or the plot's visible window, the strip's All | Visible
// window (#375). The strip's ⬇ opens the export dialog on WAV (#92). The
// panel-level selection (#90), stereo and reverse (#91) and the extra entry
// points (#93) were dropped.
//
// A file in memory-saving mode plays too: its range is read from the file,
// every row of it (audio-lazy-methods.js), never from the overview in memory.

import i18n from '../../i18n/index.js';
import { FFT_UNIFORM_REL_TOLERANCE } from '../../utils/fft.js';
import { createAudioScan, finishAudioScan, scanAudioChunk, writeAudioChunk } from '../../utils/audio-samples.js';

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
// The WAV export has no such bound: it streams the range into the file.
export const MAX_BUFFER_SAMPLES = 32 * 1024 * 1024;

// Below this a range is a click, not a sound: the design's ~50 ms, which at
// 44.1 kHz is 2 205 samples — ten times the fades written into its ends.
export const MIN_RANGE_SECONDS = 0.05;

// Fade applied when playback is interrupted (stop, pause, another panel taking
// over). Shorter than the edge fade would click; longer would feel laggy.
const INTERRUPT_FADE_SECONDS = 0.01;
// How far ahead a range waiting for the end of the loop must be scheduled to
// start on time; closer than this, it waits for the turn after.
const SEAM_LEAD_SECONDS = 0.04;

// What the strip says when a range cannot be turned into a buffer. A visible
// window is changed by zooming, not by a selection, so it gets its own words.
const BUILD_ERROR_KEYS = {
    rangeTooLong: 'audioRangeTooLong',
    rangeTooShort: 'audioRangeTooShort',
    rateUnsupported: 'audioRateUnsupported',
    nonUniform: 'audioRangeNotUniform',
    nonMonotonic: 'audioRangeNotUniform',
    tooFewSamples: 'audioRangeTooShort',
    readFailed: 'audioReadFailed',
};
const WINDOW_ERROR_KEYS = {
    rangeTooLong: 'audioWindowTooLong',
    rangeTooShort: 'audioWindowTooShort',
    tooFewSamples: 'audioWindowTooShort',
};

// The two ranges the strip offers in timeseries mode (#375).
export const AUDIO_WINDOW_MODES = ['all', 'visible'];

// How far the pointer may travel between press and release and still count as a
// click rather than a drag. Plotly owns the mouse inside the plot area — a drag
// is a zoom — so seeking has to take only what a zoom would never claim.
const CLICK_SLOP_PIXELS = 3;

// A double click on the plot is Plotly's zoom-fit, and its first half is an
// ordinary click. Seeking waits this long to see whether a second one lands;
// short enough to feel immediate, long enough to catch the pair.
const DOUBLE_CLICK_GRACE_MS = 260;
// What a click on the chart that seeks the sound must not have started on: the
// chart's own furniture. Any button or field counts — the phone layout puts
// Fit X / Fit Y / Fit all, A|B and the legend's button over the plot, and a
// tap on Fit moved the playhead to where the button sits.
const AUDIO_SEEK_IGNORED = 'button, a, input, select, textarea, label, [role="button"], '
    + '.legend, .modebar, .audio-strip, .hover-info-box';
// How long after Play a context that is still not running counts as held back.
const AUDIO_START_CHECK_MS = 1200;

// How long the panel's selection has to hold still before the sound follows it.
// Dragging a bound crosses dozens of values; rebuilding on each one would
// stutter rather than follow.
const RANGE_SETTLE_MS = 250;

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

/** First index whose time is >= value (or the length), over an ascending vector. */
function lowerBound(times, value) {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (Number(times[mid]) < value) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** First index whose time is > value (or the length), over an ascending vector. */
function upperBound(times, value) {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (Number(times[mid]) <= value) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/**
 * The rows of a range: every one whose time t has lo <= t <= hi. The same rule
 * the rows of a lazy file are read by (_lazyFitPass), so a range holds the
 * same samples in memory and from the file.
 */
export function audioRangeRows(times, range) {
    const n = times?.length || 0;
    const from = lowerBound(times, range[0]);
    const to = Math.max(from, Math.min(n, upperBound(times, range[1])));
    return { from, to, count: to - from };
}

export const audioSliceOf = (values, from, to) => (ArrayBuffer.isView(values) ? values.subarray(from, to) : values.slice(from, to));
const sliceOf = audioSliceOf;

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
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4h2v8.2l3.1-3.1 1.4 1.4L12 16l-5.5-5.5 1.4-1.4 3.1 3.1zM5 18h14v2H5z"/></svg>',
};

function formatClock(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(total / 60);
    const rest = total - minutes * 60;
    return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`;
}

// ─── The iPhone's silent switch ──────────────────────────────────────
//
// iOS plays a page's Web Audio as "ambient" sound, which the ring/silent switch
// mutes: the playhead ran and nothing was heard, on a phone where a video
// played aloud. Safari 17+ takes navigator.audioSession.type = 'playback'
// (_audioEnsureContext). Older iOS, and browsers built on WebKit that may not
// pass that on, are moved to media playback the way the platform allows: a
// media element playing at the same time. So on iOS a silent, looping
// <audio> plays while the strip does, started inside the same tap.
let sessionElement = null;
let sessionUrl = null;

/** iOS WebKit (Safari, and Chrome or Firefox on an iPhone), by feature. */
function isIosWebKit() {
    return typeof window !== 'undefined'
        && typeof window.GestureEvent !== 'undefined'
        && (navigator.maxTouchPoints || 0) > 0;
}

/** Half a second of silence as a WAV: 8 kHz, mono, 16-bit. */
function silentWavUrl() {
    if (sessionUrl) return sessionUrl;
    const rate = 8000;
    const samples = rate / 2;
    const bytes = new ArrayBuffer(44 + samples * 2);
    const view = new DataView(bytes);
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, 'RIFF');
    view.setUint32(4, 36 + samples * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, samples * 2, true);
    sessionUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
    return sessionUrl;
}

/** Start (inside the tap) or stop the media playback that unmutes iOS. */
function keepIosMediaSession(on) {
    if (!isIosWebKit()) return;
    try {
        if (on) {
            if (!sessionElement) {
                sessionElement = document.createElement('audio');
                sessionElement.className = 'audio-ios-session';
                sessionElement.setAttribute('playsinline', '');
                sessionElement.setAttribute('aria-hidden', 'true');
                sessionElement.loop = true;
                sessionElement.preload = 'auto';
                sessionElement.src = silentWavUrl();
                sessionElement.style.display = 'none';
                document.body.appendChild(sessionElement);
            }
            const started = sessionElement.play();
            if (started?.catch) started.catch(() => {});
        } else if (sessionElement && !sessionElement.paused) {
            sessionElement.pause();
        }
    } catch { /* the Web Audio sound still plays where it can */ }
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
            // In timeseries mode: the whole record, or the plot's visible
            // window (#375). Listening state, like loop and volume.
            window: 'all',
            // A range being read from a lazy file: { key, controller, rows, expected }.
            loading: null,
            // The last buffer made ready ahead of time (a window waiting for
            // the end of the loop), kept so a play right after reuses it.
            prepared: null,
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
        // A file in memory-saving mode: what is in memory is an overview, so
        // the gate is read from the file's row count and span, and the range
        // itself from the file when it is played (audio-lazy-methods.js).
        if (this._isLazyFile?.(fileId)) {
            if (!this._audioLazySourceStatus) return { ok: false, reason: 'lazy' };
            return this._audioLazySourceStatus(fileId, varName, { min: MIN_PLAYABLE_RATE, max: MAX_PLAYABLE_RATE });
        }

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
            // A state band is text: nothing to hear.
            if (this._isStateBandTrace?.(trace)) continue;
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
     * there is no selection: the strip offers All | Visible window (#375) —
     * the whole record, or what the plot shows after a zoom or a pan, clamped
     * to the signal. Two states, never three (docs/audio-playback-design.md).
     */
    proto._audioRange = function(plot, source) {
        const extent = this._audioSourceExtent(source);
        if (!extent) return null;
        let range = null;
        if (plot?.mode === 'fft') range = this._activeFftRange?.(plot);
        else if (plot?.mode === 'histogram') range = this._activeHistogramRange?.(plot);
        else if (plot?.mode === 'integral') range = this._activeIntegralRange?.(plot);
        else if (this._audioWindowMode(plot) === 'visible') {
            // A window that misses the signal altogether (panned off its end)
            // has nothing of it to play: an empty range, said as too short,
            // rather than the whole record standing in for it.
            const visible = this._audioVisibleWindow(plot);
            if (!visible) return extent;
            const lo = Math.max(extent[0], visible[0]);
            const hi = Math.min(extent[1], visible[1]);
            return hi > lo ? [lo, hi] : [lo, lo];
        }
        if (!Array.isArray(range) || !Number.isFinite(range[0]) || !Number.isFinite(range[1])) {
            return extent;
        }
        const lo = Math.max(extent[0], Math.min(range[0], range[1]));
        const hi = Math.min(extent[1], Math.max(range[0], range[1]));
        if (!(hi > lo)) return extent;
        return [lo, hi];
    };

    /** 'visible' when the strip plays the plot's window, 'all' otherwise. */
    proto._audioWindowMode = function(plot) {
        if (plot?.mode !== 'timeseries') return 'all';
        return plot?.audio?.window === 'visible' ? 'visible' : 'all';
    };

    proto._audioSetWindowMode = function(panelId, mode) {
        const plot = this.plots.get(panelId);
        if (!plot || !AUDIO_WINDOW_MODES.includes(mode)) return;
        const state = this._ensureAudioState(plot);
        if (state.window === mode) return;
        state.window = mode;
        // Like a moved window: heard from the end of the loop, or the next play.
        this._syncAudioStrip(panelId);
    };

    /** The x range the plot shows, in the signal's time, or null. */
    proto._audioVisibleWindow = function(plot) {
        const range = plot?.div?._fullLayout?.xaxis?.range;
        if (!Array.isArray(range) || range.length < 2) return null;
        const a = this._coerceAxisValue ? this._coerceAxisValue(range[0]) : Number(range[0]);
        const b = this._coerceAxisValue ? this._coerceAxisValue(range[1]) : Number(range[1]);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
        return [Math.min(a, b), Math.max(a, b)];
    };

    proto._audioSourceExtent = function(source) {
        if (source?.status?.lazy) return source.status.extent || null;
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
     * quietly folded over. The samples come from src/utils/audio-samples.js,
     * the kernel a file in memory-saving mode is read through too
     * (_audioLazyRangeSamples), so both are heard alike.
     */
    proto._buildAudioBuffer = function(context, source, range, state) {
        if (source?.status?.lazy) return { error: 'readFailed' };
        const result = this._audioEagerRangeSamples(source, range, state, (frames, sampleRate) => {
            // Within the gate but outside what THIS browser takes — 4 kHz
            // passes in Chrome and is refused in Firefox. An exception here
            // would surface as a dead button; a sentence does not.
            const buffer = context.createBuffer(1, frames, sampleRate);
            return { buffer, channel: buffer.getChannelData(0) };
        });
        return this._audioBuiltFromSamples(result);
    };

    /**
     * The samples of a range of a signal held in memory, through the shared
     * kernel. `alloc(frames, sampleRate)` hands back where they go:
     * `{ channel }` (a Float32Array), plus whatever the caller wants kept.
     */
    proto._audioEagerRangeSamples = function(source, range, state, alloc) {
        const { times, values } = source.status;
        const { from, to, count } = audioRangeRows(times, range);
        if (count < 2) return { error: 'rangeTooShort' };
        if (count > MAX_BUFFER_SAMPLES) return { error: 'rangeTooLong' };
        const time = sliceOf(times, from, to);
        const chunk = [sliceOf(values, from, to)];
        const info = finishAudioScan(scanAudioChunk(createAudioScan(1), time, chunk), { removeDC: !!state.removeDC });
        return this._audioWriteSamples(info, [chunk], alloc);
    };

    /**
     * The second pass, over the chunks the first one read: the checks every
     * path shares, then the samples into what `alloc` gives.
     */
    proto._audioWriteSamples = function(info, chunks, alloc) {
        if (!info.ok) return { error: info.reason || 'nonUniform', info };
        if (info.duration < MIN_RANGE_SECONDS) return { error: 'rangeTooShort', info };
        if (info.frames > MAX_BUFFER_SAMPLES) return { error: 'rangeTooLong', info };
        let target;
        try {
            target = alloc(info.frames, info.sampleRate);
        } catch {
            return { error: 'rateUnsupported', info };
        }
        let clipped = 0;
        let at = 0;
        for (const chunk of chunks) {
            clipped += writeAudioChunk(info, chunk, at, [target.channel], at);
            at += chunk[0].length;
        }
        return { ...target, info, clipped };
    };

    proto._audioBuiltFromSamples = function(result) {
        if (result.error) return { error: result.error };
        return {
            buffer: result.buffer,
            clipped: result.clipped,
            nanCount: result.info.nanCount,
            duration: result.info.duration,
            startTime: result.info.startTime,
            sampleRate: result.info.sampleRate,
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
        return [this._audioSamplesKey(source, state), range[0], range[1]].join('|');
    };

    /**
     * The part of the key that is not the range: which samples, and how they
     * are treated. When only the range differs — a zoom, a pan, All ↔ Visible
     * window — the take is not cut: the new range waits for the end of the
     * loop (_followAudioSourceChange).
     */
    proto._audioSamplesKey = function(source, state) {
        const values = source.status?.values;
        return [
            source.key,
            sampleStamp(values),
            values?.length || 0,
            state.removeDC ? 1 : 0,
        ].join('|');
    };

    /**
     * The range moved since the buffer was built (a zoom, a moved bound). The
     * instant stays where the new range still holds it; a take that had run
     * to its end, or an instant the new range leaves out, starts it over.
     */
    proto._audioRemapPosition = function(state, range) {
        const old = state.buffer;
        if (!old || !Number.isFinite(old.startTime)) return;
        const atEnd = state.position >= old.duration - 0.001;
        const absolute = old.startTime + state.position;
        state.position = (!atEnd && absolute >= range[0] && absolute < range[1]) ? absolute - range[0] : 0;
    };

    /**
     * While nothing sounds, the strip measures against the range it would play
     * now, not the buffer of the last take: a zoom while paused moves where a
     * click seeks and how long the readout says. The buffer is kept aside, so
     * zooming back plays it without building it again.
     */
    proto._audioSettleIdleRange = function(plot) {
        const state = plot?.audio;
        if (!state?.buffer || state.loading || this._audioPanelIsPlaying(plot)) return;
        const source = this._audioSelectedSource(plot);
        if (!source?.status?.ok) return;
        const range = this._audioRange(plot, source);
        if (!range) return;
        const key = this._audioBufferKey(source, range, state);
        if (key === state.bufferKey) return;
        this._audioRemapPosition(state, range);
        state.prepared = { key: state.bufferKey, built: state.buffer };
        state.buffer = null;
        state.bufferKey = '';
    };

    // ─── Transport ──────────────────────────────────────────────────

    proto._audioEnsureContext = function() {
        // Safari on an iPhone plays Web Audio as "ambient" sound, which the
        // ring/silent switch mutes — and an iPhone is often on silent, so the
        // strip played nothing while a video beside it was heard. Declaring
        // this page a player (Safari 17+) makes it sound as media does.
        try {
            if (navigator.audioSession && navigator.audioSession.type !== 'playback') {
                navigator.audioSession.type = 'playback';
            }
        } catch { /* not settable here */ }
        // Created inside the user's click, which is what the browsers' autoplay
        // policy requires; every entry point into playback is a click.
        if (!player.context) {
            const Ctor = window.AudioContext || window.webkitAudioContext;
            if (!Ctor) return null;
            player.context = new Ctor();
            player.master = player.context.createGain();
            player.master.connect(player.context.destination);
            // A context left stopped by the browser stops the playhead with
            // it (its clock is the playhead's): say so when it moves again or
            // does not (see _audioCheckStarted).
            player.context.onstatechange = () => {
                const owner = player.owner;
                owner?.manager?._syncAudioStrip?.(owner.panelId);
            };
        }
        // Not only "suspended": Safari also reports "interrupted" (a call,
        // another tab's sound, the phone locked), and waits for a resume.
        if (player.context.state !== 'running') {
            player.context.resume().catch(() => {});
            // The iOS unlock: a sound started inside the tap, even a silent
            // sample, is what lets the context run there.
            try {
                const silence = player.context.createBufferSource();
                silence.buffer = player.context.createBuffer(1, 1, player.context.sampleRate);
                silence.connect(player.context.destination);
                silence.start(0);
            } catch { /* nothing to unlock with */ }
        }
        return player.context;
    };

    /**
     * After Play: the browser may still hold the sound back (Safari does when
     * the tap was not taken as permission). Its clock then stands still, and
     * so did the playhead, with the strip reading "playing" — the one thing
     * the user could not tell apart from a broken player. A second later the
     * strip says what to do instead.
     */
    proto._audioCheckStarted = function(panelId) {
        clearTimeout(player.startCheck);
        player.startCheck = setTimeout(() => {
            const plot = this.plots.get(panelId);
            if (!plot || !this._audioPanelIsPlaying(plot)) return;
            if (player.context?.state === 'running') return;
            this._syncAudioStrip(panelId);
        }, AUDIO_START_CHECK_MS);
    };

    /** Playing, but the browser has not let the sound start. */
    proto._audioHeldBack = function(plot) {
        return this._audioPanelIsPlaying(plot)
            && !!player.context
            && player.context.state !== 'running'
            && player.context.currentTime - player.startedAt < 0.001;
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
        keepIosMediaSession(false);
        this._audioDropSeam?.();
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
        // A range still being read for another panel would start over this one.
        this._audioCancelOtherLoads(panelId);

        const key = this._audioBufferKey(source, range, state);
        if (state.bufferKey !== key || !state.buffer) {
            this._audioRemapPosition(state, range);
            if (state.prepared?.key === key) {
                this._audioAdoptBuffer(state, source, state.prepared.built, key);
            } else if (source.status.lazy) {
                // Read from the file, every row of the range. The take starts
                // when it lands; the strip says how far the read has got.
                state.buffer = null;
                state.bufferKey = '';
                this._audioLoadLazy(panelId, source, range, key, {
                    onReady: (built) => this._audioStartTake(panelId, built, { crossfade: false }),
                });
                return;
            } else {
                const built = this._buildAudioBuffer(context, source, range, state);
                if (built.error) {
                    this._audioBuildFailed(panelId, built.error);
                    return;
                }
                this._audioAdoptBuffer(state, source, built, key);
            }
        }
        this._audioStartTake(panelId, state.buffer, { crossfade: wasSounding });
    };

    /** A built buffer becomes the panel's take. */
    proto._audioAdoptBuffer = function(state, source, built, key) {
        built.samplesKey = this._audioSamplesKey(source, state);
        state.buffer = built;
        state.bufferKey = key;
        state.prepared = null;
        state.seamFailedKey = null;
        state.notice = this._audioBufferNotice(source, built);
    };

    /** The sentence for a range that cannot be turned into a buffer. */
    proto._audioBuildErrorText = function(plot, error) {
        const windowed = this._audioWindowMode(plot) === 'visible';
        const key = (windowed && WINDOW_ERROR_KEYS[error]) || BUILD_ERROR_KEYS[error] || 'audioReasonUnavailable';
        return i18n.t(key)
            .replace('{ms}', i18n.formatNumber(Math.round(MIN_RANGE_SECONDS * 1000)))
            .replace('{samples}', i18n.formatNumber(MAX_BUFFER_SAMPLES));
    };

    /** Why a range could not be turned into a buffer, in the strip. */
    proto._audioBuildFailed = function(panelId, error) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureAudioState(plot);
        state.notice = () => this._audioBuildErrorText(plot, error);
        state.buffer = null;
        state.bufferKey = '';
        this._syncAudioStrip(panelId);
    };

    /** Start a built buffer sounding from the panel's position. */
    proto._audioStartTake = function(panelId, built, { crossfade = false } = {}) {
        const plot = this.plots.get(panelId);
        const context = player.context;
        if (!plot || !context || !built?.buffer) return;
        const state = this._ensureAudioState(plot);
        if (state.position >= built.duration - 0.001) state.position = 0;

        const nodeGain = context.createGain();
        nodeGain.connect(player.master);
        if (crossfade) {
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
        player.playStartedAtMs = Date.now();
        this._applyAudioVolume(state, panelId);
        this._audioWireEnded(node, panelId, built);

        // Inside the tap, as iOS wants it: see keepIosMediaSession.
        keepIosMediaSession(true);
        node.start(0, state.position);
        this._startAudioTick();
        this._syncAudioStrip(panelId);
        this._audioCheckStarted(panelId);
    };

    proto._audioWireEnded = function(node, panelId, built) {
        node.onended = () => {
            if (player.node !== node) return;
            player.playing = false;
            keepIosMediaSession(false);
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
    };

    // ─── A range read from a lazy file ──────────────────────────────

    /**
     * Read a range of a lazy file into a buffer, then hand it to `onReady`.
     * Every row of the range comes from the file (_audioLazyRangeSamples);
     * the strip shows how far the read has got, with a Cancel, and a newer
     * request — another range, Stop, another panel playing — replaces it.
     * `startsTake` is false for a range read ahead of the end of a loop: the
     * take sounding then is left alone whatever happens to the read.
     */
    proto._audioLoadLazy = function(panelId, source, range, key, { onReady = null, startsTake = true } = {}) {
        const plot = this.plots.get(panelId);
        const context = player.context;
        if (!plot || !context) return;
        const state = this._ensureAudioState(plot);
        if (state.loading?.key === key) {
            if (onReady) state.loading.onReady = onReady;
            return;
        }
        state.loading?.controller.abort();
        const controller = new AbortController();
        const rate = Number(source.status.sampleRate);
        const loading = {
            key,
            controller,
            rows: 0,
            expected: Number.isFinite(rate) ? Math.max(0, Math.round((range[1] - range[0]) * rate) + 1) : NaN,
            onReady,
            startsTake,
            lastPaint: 0,
        };
        state.loading = loading;
        // Inside the tap that asked to play, as iOS wants it.
        if (startsTake) keepIosMediaSession(true);
        this._syncAudioStrip(panelId);

        const alloc = (frames, sampleRate) => {
            const buffer = context.createBuffer(1, frames, sampleRate);
            return { buffer, channel: buffer.getChannelData(0) };
        };
        const onRows = (rows) => {
            loading.rows = rows;
            const now = Date.now();
            if (now - loading.lastPaint < 120) return;
            loading.lastPaint = now;
            this._audioSyncLoadingNote(panelId);
        };
        Promise.resolve()
            .then(() => this._audioLazyRangeSamples(source, range, state, alloc, {
                signal: controller.signal,
                onRows,
                maxFrames: MAX_BUFFER_SAMPLES,
            }))
            .then((result) => {
                if (state.loading !== loading || controller.signal.aborted) return;
                state.loading = null;
                const built = this._audioBuiltFromSamples(result);
                if (built.error) {
                    if (startsTake) {
                        keepIosMediaSession(false);
                        this._audioBuildFailed(panelId, built.error);
                    } else {
                        // The take that is sounding carries on; the strip says
                        // why the new range will not follow it.
                        state.seamFailedKey = key;
                        state.notice = () => this._audioBuildErrorText(plot, built.error);
                        this._syncAudioStrip(panelId);
                    }
                    return;
                }
                if (startsTake) this._audioAdoptBuffer(state, source, built, key);
                if (this.plots.get(panelId) === plot) loading.onReady?.(built);
                this._syncAudioStrip(panelId);
            })
            .catch((error) => {
                if (state.loading !== loading) return;
                state.loading = null;
                if (startsTake) keepIosMediaSession(false);
                if (error?.name === 'AbortError') { this._syncAudioStrip(panelId); return; }
                if (!startsTake) state.seamFailedKey = key;
                state.notice = () => i18n.t('audioReadFailed');
                this._syncAudioStrip(panelId);
            });
    };

    /** Stop reading a range, leaving whatever was sounding as it was. */
    proto._audioCancelLoad = function(panelId, { quiet = false } = {}) {
        const plot = this.plots.get(panelId);
        const loading = plot?.audio?.loading;
        if (!loading) return false;
        plot.audio.loading = null;
        loading.controller.abort();
        if (loading.startsTake) keepIosMediaSession(false);
        // A range read ahead of the loop's end is not asked for again until
        // the range changes once more.
        if (!loading.startsTake) plot.audio.seamFailedKey = loading.key;
        if (!quiet) plot.audio.notice = () => i18n.t('audioReadCancelled');
        this._syncAudioStrip(panelId);
        return true;
    };

    proto._audioCancelOtherLoads = function(panelId) {
        for (const [id, plot] of this.plots) {
            if (id !== panelId && plot.audio?.loading?.startsTake) this._audioCancelLoad(id, { quiet: true });
        }
    };

    // ─── A new range at the end of the loop ─────────────────────────

    /**
     * The range changed under a take that loops (a zoom or a pan, All ↔
     * Visible window): the new one is built — read from the file, on a lazy
     * one — and starts exactly where the current loop ends, scheduled on the
     * audio clock, so the sound is never cut mid-way. The buffers' own edge
     * fades meet at that seam, as they do on every turn of the loop.
     */
    proto._audioPrepareSeam = function(panelId, source, range, key) {
        const plot = this.plots.get(panelId);
        const state = this._ensureAudioState(plot);
        if (state.prepared?.key === key) {
            this._audioScheduleSeam(panelId, state.prepared.built, key);
            return;
        }
        if (source.status.lazy) {
            this._audioLoadLazy(panelId, source, range, key, {
                startsTake: false,
                onReady: (built) => {
                    built.samplesKey = this._audioSamplesKey(source, state);
                    state.prepared = { key, built };
                    this._audioScheduleSeam(panelId, built, key);
                },
            });
            return;
        }
        const built = this._buildAudioBuffer(player.context, source, range, state);
        if (built.error) {
            state.seamFailedKey = key;
            state.notice = () => this._audioBuildErrorText(plot, built.error);
            this._syncAudioStrip(panelId);
            return;
        }
        built.samplesKey = this._audioSamplesKey(source, state);
        state.prepared = { key, built };
        this._audioScheduleSeam(panelId, built, key);
    };

    proto._audioScheduleSeam = function(panelId, built, key) {
        if (!this._audioPanelOwnsPlayer(panelId) || !player.playing || !player.loop || !player.node) return false;
        const context = player.context;
        const now = context.currentTime;
        const position = positionInRange(player.offset, now - player.startedAt, player.duration, true);
        let at = now + (player.duration - position);
        // Too close to start on time: the turn after.
        while (at - now < SEAM_LEAD_SECONDS) at += player.duration;
        this._audioDropSeam();
        const nodeGain = context.createGain();
        nodeGain.gain.setValueAtTime(1, now);
        nodeGain.connect(player.master);
        const node = context.createBufferSource();
        node.buffer = built.buffer;
        node.loop = true;
        node.connect(nodeGain);
        node.start(at, 0);
        // The take sounding now ends at the seam by design: its end there is
        // not the end of listening.
        player.node.onended = null;
        player.node.stop(at);
        player.pending = { manager: this, panelId, node, nodeGain, at, built, key };
        return true;
    };

    /** The seam reached: the new range is the take (called from the tick). */
    proto._audioPromoteSeam = function() {
        const pending = player.pending;
        if (!pending || pending.manager !== this || !player.context) return;
        if (player.context.currentTime < pending.at) return;
        const plot = this.plots.get(pending.panelId);
        const oldNode = player.node;
        const oldGain = player.nodeGain;
        player.pending = null;
        player.node = pending.node;
        player.nodeGain = pending.nodeGain;
        player.duration = pending.built.duration;
        player.offset = 0;
        player.startedAt = pending.at;
        if (plot) {
            const state = this._ensureAudioState(plot);
            const source = this._audioSelectedSource(plot);
            state.buffer = pending.built;
            state.bufferKey = pending.key;
            state.prepared = null;
            state.pendingRebuildKey = null;
            if (source) state.notice = this._audioBufferNotice(source, pending.built);
        }
        this._audioWireEnded(pending.node, pending.panelId, pending.built);
        setTimeout(() => {
            try { oldNode?.disconnect(); oldGain?.disconnect(); } catch { /* gone */ }
        }, 50);
        this._syncAudioStrip(pending.panelId);
    };

    /**
     * Forget a seam that has not been reached: the range came back, loop went
     * off, the take was stopped. The take sounding now carries on, and ends
     * where it ends if it no longer loops.
     */
    proto._audioDropSeam = function() {
        const pending = player.pending;
        if (!pending) return;
        player.pending = null;
        try { pending.node.onended = null; pending.node.stop(); } catch { /* not started */ }
        setTimeout(() => {
            try { pending.node.disconnect(); pending.nodeGain.disconnect(); } catch { /* gone */ }
        }, 50);
        if (player.node && player.playing) {
            // Its stop at the seam is withdrawn (the last stop() called is the
            // one a source node keeps), and its end is listened for again.
            try {
                if (player.context.currentTime < pending.at) player.node.stop(player.context.currentTime + 1e7);
            } catch { /* already ending */ }
            const plot = pending.manager.plots?.get(pending.panelId);
            const built = plot?.audio?.buffer;
            if (built) pending.manager._audioWireEnded(player.node, pending.panelId, built);
        }
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
            notes.push(i18n.t('audioClipped').replace('{count}', i18n.formatNumber(built.clipped)));
        }
        if (built.nanCount > 0) {
            notes.push(i18n.t('audioNaNs').replace('{count}', i18n.formatNumber(built.nanCount)));
        }
        const contextRate = player.context?.sampleRate;
        if (contextRate && Math.abs(contextRate - sampleRate) > 1) {
            notes.push(i18n.t('audioResampled')
                .replace('{from}', i18n.formatNumber(Math.round(sampleRate)))
                .replace('{to}', i18n.formatNumber(Math.round(contextRate))));
        }
        return notes.join(' · ');
    };

    proto._audioPause = function(panelId) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureAudioState(plot);
        // Still reading the range from the file: pausing is not wanting it.
        if (state.loading?.startsTake) this._audioCancelLoad(panelId, { quiet: true });
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
        if (state.loading) this._audioCancelLoad(panelId, { quiet: true });
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
        // Held back by the browser, the button still shows Pause; the tap that
        // the note asks for is a new try (inside a new gesture), not a pause.
        if (this._audioHeldBack(plot)) {
            this._audioEnsureContext();
            this._audioPlay(panelId);
            return;
        }
        if (this._audioPanelIsPlaying(plot) || plot.audio?.loading?.startsTake) this._audioPause(panelId);
        else this._audioPlay(panelId);
    };

    proto._audioSeekTo = function(panelId, seconds) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureAudioState(plot);
        this._audioSettleIdleRange(plot);
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
            this._audioPromoteSeam();
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
        if (key === state.bufferKey) {
            state.pendingRebuildKey = null;
            // Back where it was before the loop's end: nothing to change.
            if (player.pending?.manager === this) this._audioDropSeam();
            if (state.loading && !state.loading.startsTake) this._audioCancelLoad(panelId, { quiet: true });
            return;
        }
        const now = performance.now();
        if (state.pendingRebuildKey !== key) {
            state.pendingRebuildKey = key;
            state.pendingRebuildSince = now;
            return;
        }
        if (now - state.pendingRebuildSince < RANGE_SETTLE_MS) return;

        // In timeseries mode only the range moved — a zoom, a pan, All ↔
        // Visible window: the take is not cut. Looping, the new range starts
        // where this turn of the loop ends; playing once, at the next play
        // (#375, and the design's rule for a moved bound). A recomputed
        // signal, another signal or Remove DC change what is heard, and
        // follow at once, keeping the instant, as below.
        if (plot.mode === 'timeseries' && state.buffer.samplesKey === this._audioSamplesKey(source, state)) {
            if (!player.loop) return;
            if (player.pending?.key === key || state.loading?.key === key || state.seamFailedKey === key) return;
            this._audioPrepareSeam(panelId, source, range, key);
            return;
        }
        // A recomputed lazy range is read from the file before it is heard.
        if (source.status.lazy) {
            if (state.loading?.key === key || state.seamFailedKey === key) return;
            this._audioLoadLazy(panelId, source, range, key, {
                startsTake: false,
                onReady: (built) => {
                    if (!this._audioPanelIsPlaying(plot)) {
                        built.samplesKey = this._audioSamplesKey(source, state);
                        state.prepared = { key, built };
                        return;
                    }
                    const absolute = state.buffer.startTime + this._audioPosition(plot);
                    this._audioAdoptBuffer(state, source, built, key);
                    state.position = (absolute >= range[0] && absolute <= range[1]) ? absolute - range[0] : 0;
                    this._audioPlay(panelId);
                },
            });
            return;
        }

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
        this._audioSettleIdleRange(plot);
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
            // Playing the visible window, the zoom is the range: the readout
            // and the note follow it (the sound does at the loop's end).
            if (plot.audio?.open && this._audioWindowMode(plot) === 'visible') this._syncAudioStrip(panelId);
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
            const onChrome = event.target?.closest?.(AUDIO_SEEK_IGNORED);
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
        if (event.target?.closest?.(AUDIO_SEEK_IGNORED)) return;

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
        this._audioSettleIdleRange(plot);
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
            if (state.loading) this._audioCancelLoad(panelId, { quiet: true });
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
        const strip = panelEl?.querySelector('.audio-strip');
        strip?._heightObserver?.disconnect();
        strip?.remove();
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
                <div class="audio-window" role="radiogroup" aria-label="${i18n.t('audioWindowLabel')}" hidden>
                    <button type="button" class="audio-window-btn" data-window="all" role="radio" aria-checked="true" title="${i18n.t('audioWindowAllTitle')}">${i18n.t('audioWindowAll')}</button>
                    <button type="button" class="audio-window-btn" data-window="visible" role="radio" aria-checked="false" title="${i18n.t('audioWindowVisibleTitle')}">${i18n.t('audioWindowVisible')}</button>
                </div>
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
            <div class="audio-strip-loading" role="status" hidden>
                <span class="audio-loading-text"></span>
                <button type="button" class="audio-btn audio-loading-cancel">${i18n.t('cancel')}</button>
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
                // A new range waiting for the end of the loop: with no loop
                // there is no end to wait for, and it is heard at the next play.
                if (!state.loop) {
                    this._audioDropSeam();
                    if (state.loading && !state.loading.startsTake) this._audioCancelLoad(panelId, { quiet: true });
                }
            }
            this._syncAudioStrip(panelId);
        });
        for (const button of strip.querySelectorAll('.audio-window-btn')) {
            button.addEventListener('click', () => this._audioSetWindowMode(panelId, button.dataset.window));
        }
        strip.querySelector('.audio-loading-cancel').addEventListener('click', () => this._audioCancelLoad(panelId));
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

        // The strip grows when its note appears (a resampled rate, clipping,
        // why nothing plays) and shrinks when it goes. The panel keeps its
        // size, so the panel's own ResizeObserver never hears of it, and the
        // chart went on drawing its x axis under the strip. Its height is
        // watched here instead.
        if (typeof ResizeObserver === 'function') {
            let lastHeight = -1;
            let timer = null;
            strip._heightObserver = new ResizeObserver(entries => {
                const height = Math.round(entries[entries.length - 1]?.contentRect?.height ?? 0);
                if (height === lastHeight) return;
                const first = lastHeight < 0;
                lastHeight = height;
                // Its first size is already told to Plotly by whoever opened it.
                if (first) return;
                clearTimeout(timer);
                timer = setTimeout(() => this._resizePanelCharts?.(panelId), 50);
            });
            strip._heightObserver.observe(strip);
        }

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
        const reading = !!state.loading?.startsTake;
        if (reading) playBtn.innerHTML = ICONS.pause;
        playBtn.dataset.state = playing ? 'playing' : (reading ? 'loading' : 'paused');
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

        // All | Visible window, in timeseries mode only: in an analysis mode
        // the analysis' selection is what sounds, and its control is in the
        // panel's options.
        const windowGroup = strip.querySelector('.audio-window');
        const windowMode = this._audioWindowMode(plot);
        windowGroup.hidden = plot.mode !== 'timeseries';
        for (const button of windowGroup.querySelectorAll('.audio-window-btn')) {
            const on = button.dataset.window === windowMode;
            button.classList.toggle('active', on);
            button.setAttribute('aria-checked', String(on));
            button.disabled = !playable;
        }
        this._audioSyncLoadingNote(panelId, strip);

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
        // Pressed Play, and the browser keeps the sound (and the clock) still.
        const heldBack = this._audioHeldBack(plot) && Date.now() - (player.playStartedAtMs || 0) >= AUDIO_START_CHECK_MS
            ? i18n.t('audioHeldBack')
            : '';
        // A visible window that cannot be played says so before Play is
        // pressed, as the zoom makes it: too short to be a sound, or too long
        // for one buffer.
        const windowLimit = playable && !playing && !reading && windowMode === 'visible'
            ? this._audioWindowLimitText(plot, selected)
            : '';
        const text = [reason, heldBack, windowLimit || notice].filter(Boolean).join(' · ');
        note.textContent = text;
        note.hidden = !text;

        this._syncAudioReadout();
    };

    /** The read of a lazy range, in the strip: how far, and its Cancel. */
    proto._audioSyncLoadingNote = function(panelId, strip = null) {
        const plot = this.plots.get(panelId);
        const box = (strip || document.querySelector(`.layout-panel[data-id="${panelId}"] .audio-strip`))
            ?.querySelector('.audio-strip-loading');
        if (!plot || !box) return;
        const loading = plot.audio?.loading;
        box.hidden = !loading;
        if (!loading) return;
        const done = i18n.formatNumber(loading.rows || 0);
        box.querySelector('.audio-loading-text').textContent = Number.isFinite(loading.expected) && loading.expected > 0
            ? i18n.t('audioReading').replace('{done}', done).replace('{total}', i18n.formatNumber(loading.expected))
            : i18n.t('audioReadingRows').replace('{done}', done);
    };

    /**
     * Why the visible window would not play, from its length and the signal's
     * rate alone, or ''. The same limits the buffer is held to.
     */
    proto._audioWindowLimitText = function(plot, source) {
        const range = this._audioRange(plot, source);
        if (!range) return '';
        const seconds = range[1] - range[0];
        const rate = Number(source?.status?.sampleRate);
        if (seconds < MIN_RANGE_SECONDS) return this._audioBuildErrorText(plot, 'rangeTooShort');
        if (Number.isFinite(rate) && seconds * rate + 1 > MAX_BUFFER_SAMPLES) {
            return this._audioBuildErrorText(plot, 'rangeTooLong');
        }
        return '';
    };

    proto._syncAudioReadout = function() {
        for (const [panelId, plot] of this.plots) {
            const state = plot.audio;
            if (!state?.open) continue;
            const strip = document.querySelector(`.layout-panel[data-id="${panelId}"] .audio-strip`);
            if (!strip) continue;
            this._audioSettleIdleRange(plot);
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
            case 'lazyNoSource':return i18n.t('audioReasonLazyNoSource');
            case 'nonUniform':  return i18n.t('audioReasonNonUniform');
            case 'nonMonotonic':return i18n.t('audioReasonNonUniform');
            case 'tooFewSamples': return i18n.t('audioReasonTooFewSamples');
            case 'timeAxis':    return i18n.t('audioReasonTimeAxis');
            case 'rateTooLow':  return i18n.t('audioReasonRateTooLow')
                .replace('{rate}', i18n.formatNumber(Math.round(status.sampleRate || 0)));
            case 'rateTooHigh': return i18n.t('audioReasonRateTooHigh')
                .replace('{rate}', i18n.formatNumber(Math.round(status.sampleRate || 0)));
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
        if (this.plots.get(panelId)?.audio?.loading) this._audioCancelLoad(panelId, { quiet: true });
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
        for (const [panelId, plot] of this.plots) {
            if (plot.audio?.loading) this._audioCancelLoad(panelId, { quiet: true });
        }
        if (player.owner?.manager !== this) return;
        const panelId = player.owner.panelId;
        this._audioReleaseNode();
        this._stopAudioTick();
        player.owner = null;
        this._renderAudioPlayheads();
        this._syncAudioStrip(panelId);
    };
}
