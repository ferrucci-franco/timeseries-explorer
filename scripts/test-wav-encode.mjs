// The WAV writer behind the export of what the audio strip plays (#92):
// src/utils/wav-encode.js. Checked: every header field of a 16-bit PCM and a
// 32-bit float file; PCM rounding and clipping; float samples as they are;
// stereo interleaved left first; NaN as silence; a file written in chunks is
// the file written whole; the writer refuses to write more or fewer frames
// than its header says, and a file past 4 GB.
import assert from 'node:assert/strict';
import {
    WAV_MAX_BYTES,
    createWavWriter,
    encodeWav,
    encodeWavFrames,
    pcm16Sample,
    wavFileBytes,
    wavHeader,
    wavHeaderBytes,
    wavSampleRate,
} from '../src/utils/wav-encode.js';

const ascii = (view, offset, length) => String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, length));
const bytesOf = async (blob) => new DataView(await blob.arrayBuffer());

// ── 16-bit PCM header ─────────────────────────────────────────────
{
    const view = new DataView(wavHeader({ sampleRate: 44100, channels: 2, format: 'pcm16', frames: 1000 }));
    assert.equal(view.byteLength, 44, 'a PCM header is 44 bytes');
    assert.equal(ascii(view, 0, 4), 'RIFF');
    assert.equal(view.getUint32(4, true), 36 + 4000, 'RIFF size: the file minus 8 bytes');
    assert.equal(ascii(view, 8, 4), 'WAVE');
    assert.equal(ascii(view, 12, 4), 'fmt ');
    assert.equal(view.getUint32(16, true), 16, 'a 16-byte fmt chunk');
    assert.equal(view.getUint16(20, true), 1, 'WAVE_FORMAT_PCM');
    assert.equal(view.getUint16(22, true), 2, 'two channels');
    assert.equal(view.getUint32(24, true), 44100, 'the sample rate');
    assert.equal(view.getUint32(28, true), 44100 * 4, 'bytes per second');
    assert.equal(view.getUint16(32, true), 4, 'block align: 2 channels × 2 bytes');
    assert.equal(view.getUint16(34, true), 16, '16 bits a sample');
    assert.equal(ascii(view, 36, 4), 'data');
    assert.equal(view.getUint32(40, true), 4000, 'data size');
}

// ── 32-bit float header ───────────────────────────────────────────
{
    const view = new DataView(wavHeader({ sampleRate: 8000, channels: 1, format: 'float32', frames: 250 }));
    assert.equal(view.byteLength, 58, 'a float header is 58 bytes: extended fmt and fact');
    assert.equal(wavHeaderBytes('float32'), 58);
    assert.equal(view.getUint32(4, true), 50 + 1000, 'RIFF size');
    assert.equal(view.getUint32(16, true), 18, 'an 18-byte fmt chunk');
    assert.equal(view.getUint16(20, true), 3, 'WAVE_FORMAT_IEEE_FLOAT');
    assert.equal(view.getUint16(22, true), 1, 'mono');
    assert.equal(view.getUint32(24, true), 8000);
    assert.equal(view.getUint32(28, true), 32000, 'bytes per second');
    assert.equal(view.getUint16(32, true), 4, 'block align');
    assert.equal(view.getUint16(34, true), 32, '32 bits a sample');
    assert.equal(view.getUint16(36, true), 0, 'cbSize: no extension');
    assert.equal(ascii(view, 38, 4), 'fact');
    assert.equal(view.getUint32(42, true), 4, 'a 4-byte fact chunk');
    assert.equal(view.getUint32(46, true), 250, 'holding the frame count');
    assert.equal(ascii(view, 50, 4), 'data');
    assert.equal(view.getUint32(54, true), 1000, 'data size');
}

// ── The rate a header carries ─────────────────────────────────────
assert.equal(wavSampleRate(1 / (1 / 44100)), 44100);
assert.equal(wavSampleRate(44099.9999997), 44100, "a rate read from a time vector is the file's rate");
assert.equal(wavSampleRate(7999.6), 8000, 'rounded, by less than half a hertz');

// ── PCM: rounding, clipping, silence ──────────────────────────────
assert.equal(pcm16Sample(0), 0);
assert.equal(pcm16Sample(1), 32767, 'full scale');
assert.equal(pcm16Sample(-1), -32767, 'and its mirror: the scale is symmetric');
assert.equal(pcm16Sample(1.5), 32767, 'past full scale it clips');
assert.equal(pcm16Sample(-3), -32767, 'both ways');
assert.equal(pcm16Sample(0.25), 8192, '0.25 × 32767 = 8191.75 rounds to 8192');
assert.equal(pcm16Sample(-0.25), -8192, 'and the negative alike');
assert.equal(pcm16Sample(0.5 / 32767), 1, 'half a step rounds up');
assert.equal(pcm16Sample(0.4 / 32767), 0, 'less than half a step is zero');
assert.ok(Object.is(pcm16Sample(-0.4 / 32767), 0), 'a tiny negative is 0, not −0');
assert.equal(pcm16Sample(NaN), 0, 'a missing value is silence');
assert.equal(pcm16Sample(Infinity), 32767, 'an infinity clips');
{
    const view = new DataView(encodeWavFrames([Float32Array.from([0, 1, -1, 0.25, NaN, 2])], 'pcm16'));
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(i => view.getInt16(i * 2, true)), [0, 32767, -32767, 8192, 0, 32767],
        'written little-endian, one Int16 a sample');
}

// ── Float: the samples as they are, NaN as silence ────────────────
{
    const samples = Float32Array.from([0, 0.123456789, -0.891, 1, NaN, 1.25]);
    const view = new DataView(encodeWavFrames([samples], 'float32'));
    const read = [0, 1, 2, 3, 4, 5].map(i => view.getFloat32(i * 4, true));
    assert.deepEqual(read.slice(0, 4), Array.from(samples.slice(0, 4)), 'every float as it is, bit for bit');
    assert.equal(read[4], 0, 'NaN is silence');
    assert.equal(read[5], 1.25, 'nothing clips in float: that is what it is for');
}

// ── Stereo: interleaved, left first ───────────────────────────────
{
    const left = Float32Array.from([0.1, 0.2, 0.3]);
    const right = Float32Array.from([-0.1, -0.2, -0.3]);
    const view = new DataView(encodeWavFrames([left, right], 'pcm16'));
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(i => view.getInt16(i * 2, true)),
        [pcm16Sample(0.1), pcm16Sample(-0.1), pcm16Sample(0.2), pcm16Sample(-0.2), pcm16Sample(0.3), pcm16Sample(-0.3)],
        'L R L R L R');
    const floatView = new DataView(encodeWavFrames([left, right], 'float32', 1, 3));
    assert.equal(floatView.byteLength, 16, 'a slice of frames: two frames, two channels, four bytes');
    assert.deepEqual([0, 1, 2, 3].map(i => floatView.getFloat32(i * 4, true)), [left[1], right[1], left[2], right[2]]);
}

// ── Chunks: the same bytes as one piece ───────────────────────────
for (const format of ['pcm16', 'float32']) {
    const n = 10007;
    const left = Float32Array.from({ length: n }, (_, i) => Math.sin(i / 13) * 0.9);
    const right = Float32Array.from({ length: n }, (_, i) => (i % 101 === 0 ? NaN : Math.cos(i / 7) * 0.5));
    const whole = new Uint8Array(await (encodeWav([left, right], { sampleRate: 22050, format })).arrayBuffer());
    const writer = createWavWriter({ sampleRate: 22050, channels: 2, format, frames: n });
    for (let at = 0; at < n; at += 1000) writer.write([left.subarray(at, at + 1000), right.subarray(at, at + 1000)]);
    const chunked = new Uint8Array(await writer.blob().arrayBuffer());
    assert.equal(Buffer.compare(Buffer.from(chunked), Buffer.from(whole)), 0, `${format}: written in chunks, the same file`);
    assert.equal(whole.length, wavFileBytes({ frames: n, channels: 2, format }), `${format}: the size the estimate gives`);
    const view = await bytesOf(writer.blob());
    assert.equal(view.getUint32(4, true), whole.length - 8, `${format}: and the RIFF size says so`);
}

// ── The writer keeps its header honest ────────────────────────────
{
    const writer = createWavWriter({ sampleRate: 8000, channels: 1, format: 'pcm16', frames: 10 });
    writer.write([new Float32Array(6)]);
    assert.throws(() => writer.blob(), /announced 10 frames; 6 were written/, 'fewer frames than the header says is refused');
    assert.throws(() => writer.write([new Float32Array(5)]), /More frames/, 'and more');
    assert.throws(() => writer.write([new Float32Array(1), new Float32Array(1)]), /1 channel/, 'and another channel count');
    assert.throws(() => createWavWriter({ sampleRate: 8000, channels: 1, format: 'mp3', frames: 1 }), /Unknown WAV format/);
    assert.throws(
        () => createWavWriter({ sampleRate: 44100, channels: 2, format: 'float32', frames: Math.ceil(WAV_MAX_BYTES / 8) }),
        error => error.wavReason === 'tooLarge',
        'past 4 GB a WAV cannot say its own size: refused',
    );
}

// ── The size the dialog estimates ─────────────────────────────────
{
    const minute = wavFileBytes({ frames: 44100 * 60, channels: 2, format: 'pcm16' });
    assert.ok(Math.abs(minute / 1e6 - 10.6) < 0.05, `16-bit stereo at 44.1 kHz is about 10.6 MB a minute (${minute})`);
    assert.equal(wavFileBytes({ frames: 100, channels: 1, format: 'float32' }), 58 + 400);
}

// ── The app's own WAV reader reads it back ────────────────────────
{
    const { decodeWav } = await import('../src/parsers/audio-decode.js');
    const left = Float32Array.from({ length: 4000 }, (_, i) => 0.8 * Math.sin(i / 5));
    const right = Float32Array.from({ length: 4000 }, (_, i) => -0.3 * Math.cos(i / 9));
    for (const format of ['pcm16', 'float32']) {
        const bytes = new Uint8Array(await encodeWav([left, right], { sampleRate: 8000, format }).arrayBuffer());
        const decoded = decodeWav(bytes);
        assert.equal(decoded.sampleRate, 8000, `${format}: read back at its own rate`);
        assert.equal(decoded.frames, 4000, `${format}: every frame`);
        assert.equal(decoded.channels.length, 2, `${format}: two channels`);
        let worst = 0;
        for (let i = 0; i < 4000; i++) {
            worst = Math.max(worst, Math.abs(decoded.channels[0][i] - left[i]), Math.abs(decoded.channels[1][i] - right[i]));
        }
        if (format === 'float32') assert.equal(worst, 0, 'float: bit for bit');
        else assert.ok(worst < 1.5 / 32767, `16-bit: within a step (${worst})`);
    }
}

console.log('wav encoder tests passed');
