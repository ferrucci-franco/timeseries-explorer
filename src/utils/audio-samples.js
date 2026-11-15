// The samples a range of a signal is heard as — the one kernel behind the
// audio strip's buffer and the WAV export.
//
// Two passes over the rows of the range, each of which accumulates chunk by
// chunk, so the same code serves a signal held in memory (one chunk, or the
// arrays cut in pieces) and a file read in memory-saving mode, streamed from
// DuckDB a chunk at a time (CLAUDE.md, "Every analysis and data tool works in
// memory-saving (lazy) mode"). Fed the same rows in the same order, the two
// give the same samples bit for bit: the first pass sums in row order, the
// second writes every sample from that pass' result alone, so where the chunks
// are cut changes nothing (scripts/test-lazy-audio.mjs).
//
//   const scan = createAudioScan(channels);
//   for each chunk: scanAudioChunk(scan, time, [values, …]);
//   const info = finishAudioScan(scan, { removeDC });      // ok, or why not
//   for each chunk: clipped += writeAudioChunk(info, [values, …], frameStart, outs);
//
// What a sample is: the value minus the mean of the range (Remove DC), times
// one gain that puts the peak at −1 dBFS (docs/audio-playback-design.md,
// "Numerical honesty"), stored as a 32-bit float; a missing value is silence;
// the first and last 5 ms fade in and out so a loop does not click at its
// seam. With several channels (a stereo WAV) each loses its own mean and all
// share one gain, from the largest peak, so the balance between them is the
// recording's.

/** Where the peak lands: −1 dBFS, a hair of headroom off full scale. */
export const AUDIO_PEAK = 0.891;
/** The fade written into each end of a range. */
export const AUDIO_EDGE_FADE_SECONDS = 0.005;
/** How far a step may stray from the range's mean step and still be uniform. */
export const AUDIO_UNIFORM_TOLERANCE = 1e-3;

export function createAudioScan(channelCount = 1) {
    return {
        frames: 0,
        first: NaN,
        last: NaN,
        minStep: Infinity,
        maxStep: -Infinity,
        monotonic: true,
        channels: Array.from({ length: Math.max(1, channelCount) }, () => ({
            sum: 0,
            finite: 0,
            nan: 0,
            min: Infinity,
            max: -Infinity,
        })),
    };
}

/**
 * Accumulate one chunk of rows: `time` and, per channel, the values of the
 * same rows. Rows in file order; a chunk continues where the last one ended.
 */
export function scanAudioChunk(scan, time, channelValues) {
    const n = time?.length || 0;
    if (!n) return scan;
    let previous = scan.last;
    for (let i = 0; i < n; i++) {
        const t = Number(time[i]);
        if (scan.frames + i === 0) {
            scan.first = t;
        } else {
            const step = t - previous;
            if (!Number.isFinite(step) || step <= 0) scan.monotonic = false;
            else {
                if (step < scan.minStep) scan.minStep = step;
                if (step > scan.maxStep) scan.maxStep = step;
            }
        }
        previous = t;
    }
    scan.last = previous;
    scan.frames += n;
    scan.channels.forEach((channel, c) => {
        const values = channelValues?.[c];
        for (let i = 0; i < n; i++) {
            const value = Number(values?.[i]);
            if (Number.isFinite(value)) {
                channel.sum += value;
                channel.finite++;
                if (value < channel.min) channel.min = value;
                if (value > channel.max) channel.max = value;
            } else {
                channel.nan++;
            }
        }
    });
    return scan;
}

/**
 * What the second pass writes from: the rate the range is sampled at, each
 * channel's mean, the one gain, the fade. `{ ok: false, reason }` when the
 * range cannot be heard as a recording: too few rows, time not moving forward,
 * or a step that strays from the others (a gap, a jitter) — the time would
 * not be the file's.
 */
export function finishAudioScan(scan, { removeDC = true, tolerance = AUDIO_UNIFORM_TOLERANCE } = {}) {
    const frames = scan.frames;
    if (frames < 2) return { ok: false, reason: 'tooFewSamples', frames };
    if (!scan.monotonic) return { ok: false, reason: 'nonMonotonic', frames };
    const dt = (scan.last - scan.first) / (frames - 1);
    if (!(dt > 0) || !Number.isFinite(dt)) return { ok: false, reason: 'nonMonotonic', frames };
    const maxRelativeError = Math.max(scan.maxStep - dt, dt - scan.minStep) / dt;
    if (!(maxRelativeError <= tolerance)) return { ok: false, reason: 'nonUniform', frames, dt, maxRelativeError };

    const sampleRate = 1 / dt;
    let peak = 0;
    let nanCount = 0;
    const means = scan.channels.map((channel) => {
        nanCount += channel.nan;
        const mean = removeDC && channel.finite ? channel.sum / channel.finite : 0;
        // The largest |value − mean| is at the largest or the smallest value:
        // a subtraction rounds monotonically, so this is the maximum a pass
        // over every value would find.
        if (channel.finite) {
            const high = Math.abs(channel.max - mean);
            const low = Math.abs(channel.min - mean);
            if (high > peak) peak = high;
            if (low > peak) peak = low;
        }
        return mean;
    });
    const gain = peak > 0 ? AUDIO_PEAK / peak : 1;
    // Rounded, not floored: the rate comes out of the time vector's floating
    // point, and 8 kHz read as 7999.999… would lose a sample of fade.
    const fade = Math.min(Math.round(AUDIO_EDGE_FADE_SECONDS * sampleRate), frames >> 1);
    return {
        ok: true,
        frames,
        sampleRate,
        dt,
        startTime: scan.first,
        endTime: scan.last,
        duration: frames / sampleRate,
        means,
        gain,
        fade,
        nanCount,
        nanCounts: scan.channels.map(channel => channel.nan),
        maxRelativeError,
    };
}

/**
 * Write one chunk of samples: rows `frameStart …` of the range, per channel,
 * into `outs[c]` from `outOffset`. Returns how many samples had to be clipped
 * (none, with the gain chosen from the peak — counted all the same, so a
 * clipped sample is never silent).
 */
export function writeAudioChunk(info, channelValues, frameStart, outs, outOffset = 0) {
    const { frames, fade, gain, means } = info;
    let clipped = 0;
    const n = channelValues?.[0]?.length || 0;
    for (let c = 0; c < outs.length; c++) {
        const values = channelValues[c];
        const out = outs[c];
        const mean = means[c] || 0;
        for (let i = 0; i < n; i++) {
            const value = Number(values[i]);
            if (!Number.isFinite(value)) { out[outOffset + i] = 0; continue; }
            let sample = (value - mean) * gain;
            if (sample > 1) { sample = 1; clipped++; } else if (sample < -1) { sample = -1; clipped++; }
            const frame = frameStart + i;
            if (frame < fade) sample *= frame / fade;
            else if (frame >= frames - fade) sample *= (frames - 1 - frame) / fade;
            out[outOffset + i] = sample;
        }
    }
    return clipped;
}

/** The whole range at once: the in-memory path, and a test's reference. */
export function audioSamplesFromArrays(time, channelValues, { removeDC = true } = {}) {
    const scan = scanAudioChunk(createAudioScan(channelValues.length), time, channelValues);
    const info = finishAudioScan(scan, { removeDC });
    if (!info.ok) return { info };
    const outs = channelValues.map(() => new Float32Array(info.frames));
    const clipped = writeAudioChunk(info, channelValues, 0, outs);
    return { info, outs, clipped };
}
