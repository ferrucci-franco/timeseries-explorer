// A WAV writer that works chunk by chunk (#92).
//
// The header is a few bytes that only need the frame count, which the caller
// knows before the first sample is written (the first pass of
// src/utils/audio-samples.js counts the rows); the samples go out as one
// ArrayBuffer per chunk. The parts are handed to a Blob, whose bytes live
// with the browser rather than in the JavaScript heap, so a file far larger
// than one in-memory buffer can be written — a recording read a chunk at a
// time from a file in memory-saving mode, say.
//
//   const writer = createWavWriter({ sampleRate, channels: 2, format: 'pcm16', frames });
//   for each chunk: writer.write([left, right]);   // Float32Array (or any array) per channel
//   const blob = writer.blob();
//
// Two encodings: 16-bit PCM (WAVE_FORMAT_PCM, 1), the default, which every
// program reads; and 32-bit IEEE float (WAVE_FORMAT_IEEE_FLOAT, 3), for
// re-analysis without the 16-bit rounding — written with the `fact` chunk and
// the extended `fmt ` chunk that a non-PCM WAV is meant to carry. Channels are
// interleaved, little-endian, as the format says.
//
// A sample is a number in −1…1. PCM rounds x·32767 to the nearest integer and
// clips outside ±1 (so −1 and 1 are symmetric: −32767 and 32767); a missing
// value (NaN) is silence in both encodings, as it is in playback.

export const WAV_FORMATS = ['pcm16', 'float32'];
/** RIFF sizes are 32-bit: no WAV holds more. */
export const WAV_MAX_BYTES = 0xFFFFFFFF;

export function wavBytesPerSample(format) {
    return format === 'float32' ? 4 : 2;
}

/** The header's length: 44 bytes for PCM; 58 for float (extended fmt, fact). */
export function wavHeaderBytes(format) {
    return format === 'float32' ? 58 : 44;
}

/** How large the file will be. */
export function wavFileBytes({ frames, channels = 1, format = 'pcm16' }) {
    return wavHeaderBytes(format) + Math.max(0, frames) * channels * wavBytesPerSample(format);
}

/**
 * The rate a WAV header can carry: a whole number of hertz. The rate of a
 * signal is read from its time vector, so 44 100 Hz arrives as
 * 44 099.999 999 7; a rate that is truly fractional is rounded, by less than
 * half a hertz.
 */
export function wavSampleRate(sampleRate) {
    return Math.max(1, Math.round(Number(sampleRate) || 0));
}

export function pcm16Sample(x) {
    const value = Number(x);
    if (!Number.isFinite(value)) return Number.isNaN(value) ? 0 : (value > 0 ? 32767 : -32767);
    if (value >= 1) return 32767;
    if (value <= -1) return -32767;
    const scaled = Math.round(value * 32767);
    // Math.round(−0.4) is −0; a sample has no sign of zero.
    return scaled === 0 ? 0 : scaled;
}

export function wavHeader({ sampleRate, channels = 1, format = 'pcm16', frames }) {
    const float = format === 'float32';
    const bytesPerSample = wavBytesPerSample(format);
    const blockAlign = channels * bytesPerSample;
    const rate = wavSampleRate(sampleRate);
    const dataBytes = Math.max(0, frames) * blockAlign;
    const headerBytes = wavHeaderBytes(format);
    const buffer = new ArrayBuffer(headerBytes);
    const view = new DataView(buffer);
    const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    text(0, 'RIFF');
    view.setUint32(4, headerBytes - 8 + dataBytes, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, float ? 18 : 16, true);
    view.setUint16(20, float ? 3 : 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bytesPerSample * 8, true);
    let at = 36;
    if (float) {
        view.setUint16(36, 0, true);        // cbSize: no extension
        text(38, 'fact');
        view.setUint32(42, 4, true);
        view.setUint32(46, Math.max(0, frames), true);
        at = 50;
    }
    text(at, 'data');
    view.setUint32(at + 4, dataBytes, true);
    return buffer;
}

/**
 * Frames `from … to` of the channels, interleaved: one ArrayBuffer. Each
 * channel is an array of samples of the same length.
 */
export function encodeWavFrames(channelData, format = 'pcm16', from = 0, to = channelData?.[0]?.length ?? 0) {
    const channels = channelData.length;
    const frames = Math.max(0, to - from);
    const bytesPerSample = wavBytesPerSample(format);
    const buffer = new ArrayBuffer(frames * channels * bytesPerSample);
    const view = new DataView(buffer);
    let offset = 0;
    if (format === 'float32') {
        for (let i = from; i < to; i++) {
            for (let c = 0; c < channels; c++) {
                const value = Number(channelData[c][i]);
                view.setFloat32(offset, Number.isNaN(value) ? 0 : value, true);
                offset += 4;
            }
        }
    } else {
        for (let i = from; i < to; i++) {
            for (let c = 0; c < channels; c++) {
                view.setInt16(offset, pcm16Sample(channelData[c][i]), true);
                offset += 2;
            }
        }
    }
    return buffer;
}

/**
 * A WAV built from parts: the header first, then each chunk as it is
 * written. Writing more frames than the header announced throws, so a file
 * can never say one length and hold another.
 */
export function createWavWriter({ sampleRate, channels = 1, format = 'pcm16', frames }) {
    if (!WAV_FORMATS.includes(format)) throw new Error(`Unknown WAV format: ${format}`);
    if (wavFileBytes({ frames, channels, format }) > WAV_MAX_BYTES) {
        throw Object.assign(new Error('A WAV file holds at most 4 GB'), { wavReason: 'tooLarge' });
    }
    const parts = [wavHeader({ sampleRate, channels, format, frames })];
    let written = 0;
    return {
        get written() { return written; },
        parts,
        write(channelData) {
            if (channelData.length !== channels) throw new Error(`Expected ${channels} channel(s), got ${channelData.length}`);
            const n = channelData[0]?.length || 0;
            if (written + n > frames) throw new Error('More frames than the header announced');
            if (n) parts.push(encodeWavFrames(channelData, format, 0, n));
            written += n;
        },
        blob() {
            if (written !== frames) throw new Error(`The header announced ${frames} frames; ${written} were written`);
            return new Blob(parts, { type: 'audio/wav' });
        },
    };
}

/** A whole WAV from whole channels: a test's reference, and small exports. */
export function encodeWav(channelData, { sampleRate, format = 'pcm16' } = {}) {
    const frames = channelData[0]?.length || 0;
    const writer = createWavWriter({ sampleRate, channels: channelData.length, format, frames });
    writer.write(channelData);
    return writer.blob();
}
