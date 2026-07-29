// Reading audio files as time series.
//
//   node scripts/test-audio-parser.mjs
//
// Two halves are checked here, and they fail for different reasons:
//
//   * The WAV decoder, which is ours. It has to be exactly right — every
//     encoding a recorder or an export dialog can produce, including the two
//     the format is inconsistent about (8-bit PCM is unsigned while everything
//     wider is signed) and the two telephony codings that still turn up in
//     voice recordings (G.711 A-law and mu-law).
//
//   * The header sniffing, which decides the sample rate the browser's decoder
//     is asked to produce. Getting it wrong costs resolution, not correctness,
//     so these checks are about the rate being READ, not about decoding.
//
// No fixture files: every container here is built byte by byte, which is both
// smaller than committing audio and clearer about what is being asserted.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    decodeAudioFile,
    decodeWav,
    sniffAudioFormat,
} from '../src/parsers/audio-decode.js';
import AudioParser, { channelNames } from '../src/parsers/audio-parser.js';
import MatParser from '../src/parsers/mat-parser.js';
import { formatTimeValue, pickTimeUnit } from '../src/utils/time-unit-format.js';
import { computeTimeAxisDiagnostics } from '../src/data/time-axis-diagnostics.js';
import { decodedAudioBytes } from '../src/parsers/audio-limits.js';
import { AUDIO_EXTENSIONS } from '../src/app/text-file-formats.js';
import { RESULT_FILE_EXTENSIONS } from '../src/app/constants.js';

let checks = 0;
const check = (name, fn) => { fn(); checks++; };
const checkAsync = async (name, fn) => { await fn(); checks++; };

// ─── Fixture builders ─────────────────────────────────────────────────────

function riffChunk(id, body) {
    const head = Buffer.alloc(8);
    head.write(id, 0, 'latin1');
    head.writeUInt32LE(body.length, 4);
    // Chunks are word-aligned.
    const pad = body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
    return Buffer.concat([head, body, pad]);
}

function buildWav({ sampleRate = 44100, formatTag = 1, bitDepth = 16, channels, extensible = false }) {
    const channelCount = channels.length;
    const frames = channels[0].length;
    const bytesPerSample = bitDepth / 8;
    const blockAlign = bytesPerSample * channelCount;

    const fmtBody = Buffer.alloc(extensible ? 40 : 16);
    fmtBody.writeUInt16LE(extensible ? 0xfffe : formatTag, 0);
    fmtBody.writeUInt16LE(channelCount, 2);
    fmtBody.writeUInt32LE(sampleRate, 4);
    fmtBody.writeUInt32LE(sampleRate * blockAlign, 8);
    fmtBody.writeUInt16LE(blockAlign, 12);
    fmtBody.writeUInt16LE(bitDepth, 14);
    if (extensible) {
        fmtBody.writeUInt16LE(22, 16);          // cbSize
        fmtBody.writeUInt16LE(bitDepth, 18);    // valid bits
        fmtBody.writeUInt32LE(channelCount === 2 ? 3 : 4, 20); // channel mask
        fmtBody.writeUInt16LE(formatTag, 24);   // SubFormat GUID, first field
    }

    const data = Buffer.alloc(frames * blockAlign);
    for (let frame = 0; frame < frames; frame++) {
        for (let c = 0; c < channelCount; c++) {
            const at = frame * blockAlign + c * bytesPerSample;
            const value = channels[c][frame];
            if (formatTag === 3 && bitDepth === 32) data.writeFloatLE(value, at);
            else if (formatTag === 3 && bitDepth === 64) data.writeDoubleLE(value, at);
            else if (formatTag === 1 && bitDepth === 8) data.writeUInt8(Math.round(value * 127) + 128, at);
            else if (formatTag === 1 && bitDepth === 16) data.writeInt16LE(Math.round(value * 32767), at);
            else if (formatTag === 1 && bitDepth === 24) data.writeIntLE(Math.round(value * 8388607), at, 3);
            else if (formatTag === 1 && bitDepth === 32) data.writeInt32LE(Math.round(value * 2147483647), at);
            else if (bitDepth === 8) data.writeUInt8(value & 0xff, at);   // raw code for A-law/mu-law
            else throw new Error(`no encoder for format ${formatTag}/${bitDepth}`);
        }
    }

    const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), riffChunk('fmt ', fmtBody), riffChunk('data', data)]);
    const head = Buffer.alloc(8);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(body.length, 4);
    return Buffer.concat([head, body]);
}

function box(type, ...parts) {
    const body = Buffer.concat(parts.map(p => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))));
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
}

function buildM4a({ timescale = 44100, channels = 2, bitDepth = 16, codec = 'mp4a' } = {}) {
    const hdlr = box('hdlr', Buffer.alloc(8), Buffer.from('soun', 'latin1'), Buffer.alloc(12));
    const mdhd = (() => {
        const b = Buffer.alloc(24);
        b.writeUInt8(0, 0);                 // version 0
        b.writeUInt32BE(timescale, 12);
        b.writeUInt32BE(timescale * 3, 16); // three seconds
        return box('mdhd', b);
    })();
    const entry = Buffer.alloc(36);
    entry.writeUInt32BE(36, 0);
    entry.write(codec, 4, 'latin1');
    entry.writeUInt16BE(1, 14);          // data reference index
    entry.writeUInt16BE(channels, 24);
    entry.writeUInt16BE(bitDepth, 26);
    entry.writeUInt16BE(timescale > 65535 ? 0 : timescale, 32);
    const stsdBody = Buffer.concat([Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), entry]);
    const stbl = box('stbl', box('stsd', stsdBody));
    const minf = box('minf', stbl);
    const mdia = box('mdia', hdlr, mdhd, minf);
    const trak = box('trak', mdia);
    const moov = box('moov', trak);
    const ftyp = box('ftyp', 'M4A ', Buffer.alloc(4), 'M4A mp42isom');
    return Buffer.concat([ftyp, moov, box('mdat', Buffer.alloc(16))]);
}

function buildOggPage(packet) {
    const head = Buffer.alloc(27);
    head.write('OggS', 0, 'latin1');
    head.writeUInt8(0, 4);
    head.writeUInt8(2, 5);      // first page of the stream
    head.writeUInt8(1, 26);     // one segment
    const table = Buffer.from([Math.min(255, packet.length)]);
    return Buffer.concat([head, table, packet]);
}

function buildFlacStreamInfo({ sampleRate, channels, bitDepth }) {
    const info = Buffer.alloc(34);
    // 20 bits of sample rate, then 3 bits of (channels-1), then 5 bits of
    // (bit depth - 1), packed across bytes 10..13.
    info[10] = (sampleRate >> 12) & 0xff;
    info[11] = (sampleRate >> 4) & 0xff;
    const depth = bitDepth - 1;
    info[12] = ((sampleRate & 0x0f) << 4) | (((channels - 1) & 0x07) << 1) | ((depth >> 4) & 0x01);
    info[13] = (depth & 0x0f) << 4;
    // Metadata block header: last-block flag + type 0, then a 24-bit length.
    const header = Buffer.from([0x80, 0x00, 0x00, 34]);
    return Buffer.concat([header, info]);
}

function tone(frames, frequency, sampleRate, amplitude = 0.5) {
    const out = new Float64Array(frames);
    for (let i = 0; i < frames; i++) out[i] = amplitude * Math.sin(2 * Math.PI * frequency * i / sampleRate);
    return out;
}

// ─── WAV: every encoding ──────────────────────────────────────────────────

check('16-bit stereo round-trips', () => {
    const left = tone(1000, 440, 44100);
    const right = tone(1000, 880, 44100, 0.25);
    const decoded = decodeWav(buildWav({ channels: [left, right] }));

    assert.equal(decoded.sampleRate, 44100);
    assert.equal(decoded.frames, 1000);
    assert.equal(decoded.channels.length, 2);
    assert.equal(decoded.codec, 'PCM 16-bit');
    for (let i = 0; i < 1000; i++) {
        assert.ok(Math.abs(decoded.channels[0][i] - left[i]) < 1e-4, `left sample ${i}`);
        assert.ok(Math.abs(decoded.channels[1][i] - right[i]) < 1e-4, `right sample ${i}`);
    }
});

check('every PCM width decodes to the same waveform', () => {
    const source = tone(256, 100, 8000, 0.8);
    // Above 16 bits the tolerance stops describing the encoding and starts
    // describing Float32, which is what samples are held in — and what they
    // natively are, so nothing is lost by it.
    for (const { bitDepth, formatTag, tolerance } of [
        { bitDepth: 8, formatTag: 1, tolerance: 1 / 100 },
        { bitDepth: 16, formatTag: 1, tolerance: 1e-4 },
        { bitDepth: 24, formatTag: 1, tolerance: 1e-6 },
        { bitDepth: 32, formatTag: 1, tolerance: 1e-6 },
        { bitDepth: 32, formatTag: 3, tolerance: 1e-6 },
        { bitDepth: 64, formatTag: 3, tolerance: 1e-6 },
    ]) {
        const decoded = decodeWav(buildWav({ sampleRate: 8000, bitDepth, formatTag, channels: [source] }));
        assert.equal(decoded.frames, 256, `${formatTag}/${bitDepth} frame count`);
        for (let i = 0; i < 256; i++) {
            assert.ok(
                Math.abs(decoded.channels[0][i] - source[i]) <= tolerance,
                `${formatTag}/${bitDepth} sample ${i}: ${decoded.channels[0][i]} vs ${source[i]}`,
            );
        }
    }
});

check('8-bit PCM is unsigned, which is the format\'s own inconsistency', () => {
    // Silence in 8-bit WAV is the byte 128, not 0. Treating it as signed would
    // decode a silent file as a full-scale offset.
    const raw = buildWav({ bitDepth: 8, formatTag: 1, channels: [new Float64Array(8)] });
    const decoded = decodeWav(raw);
    for (const value of decoded.channels[0]) assert.equal(value, 0);
});

check('G.711 mu-law expands to the reference values', () => {
    // The four anchors of the coding: both zeros and both extremes.
    const codes = [0xff, 0x7f, 0x00, 0x80];
    const expected = [0, -0, -32124 / 32768, 32124 / 32768];
    const wav = buildWav({ sampleRate: 8000, formatTag: 7, bitDepth: 8, channels: [Float64Array.from(codes)] });
    const decoded = decodeWav(wav);
    assert.equal(decoded.codec, 'G.711 mu-law');
    for (let i = 0; i < codes.length; i++) {
        assert.ok(Math.abs(decoded.channels[0][i] - expected[i]) < 1e-6, `mu-law 0x${codes[i].toString(16)}`);
    }
});

check('G.711 A-law expands to the reference values', () => {
    const codes = [0xd5, 0x55, 0x2a, 0xaa];
    const expected = [8 / 32768, -8 / 32768, -32256 / 32768, 32256 / 32768];
    const wav = buildWav({ sampleRate: 8000, formatTag: 6, bitDepth: 8, channels: [Float64Array.from(codes)] });
    const decoded = decodeWav(wav);
    assert.equal(decoded.codec, 'G.711 A-law');
    for (let i = 0; i < codes.length; i++) {
        assert.ok(Math.abs(decoded.channels[0][i] - expected[i]) < 1e-6, `A-law 0x${codes[i].toString(16)}`);
    }
});

check('WAVE_FORMAT_EXTENSIBLE is read through to its real format', () => {
    // Anything recorded at more than two channels or more than 16 bits is
    // normally written this way, with the true format tag inside the SubFormat
    // GUID. Reading only the outer tag would reject the file.
    const source = tone(64, 50, 48000);
    const wav = buildWav({ sampleRate: 48000, bitDepth: 24, formatTag: 1, extensible: true, channels: [source] });
    const sniffed = sniffAudioFormat(wav);
    assert.equal(sniffed.codec, 'PCM 24-bit');
    const decoded = decodeWav(wav);
    for (let i = 0; i < 64; i++) assert.ok(Math.abs(decoded.channels[0][i] - source[i]) < 1e-6);
});

check('a data chunk that lies about its size falls back to what is there', () => {
    // Streamed WAVs are written with a placeholder size that is never fixed up.
    const wav = buildWav({ channels: [tone(100, 440, 44100)] });
    wav.writeUInt32LE(0xffffffff, wav.length - 100 * 2 - 4);
    const decoded = decodeWav(wav);
    assert.equal(decoded.frames, 100);
});

// ─── Header sniffing, container by container ──────────────────────────────

check('WAV headers', () => {
    const sniffed = sniffAudioFormat(buildWav({ sampleRate: 22050, channels: [new Float64Array(4), new Float64Array(4)] }));
    assert.deepEqual(
        { container: sniffed.container, sampleRate: sniffed.sampleRate, channels: sniffed.channels, bitDepth: sniffed.bitDepth },
        { container: 'wav', sampleRate: 22050, channels: 2, bitDepth: 16 },
    );
});

check('MP3 frame headers, with and without an ID3 tag', () => {
    const frame = Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
    const bare = sniffAudioFormat(frame);
    assert.equal(bare.container, 'mp3');
    assert.equal(bare.sampleRate, 44100);
    assert.equal(bare.channels, 2);
    assert.equal(bare.codec, 'MPEG Layer 3');

    // ID3v2 sizes are syncsafe — seven bits per byte — so a tag of 128 bytes is
    // written as 0x00 0x00 0x01 0x00, not 0x80.
    const tag = Buffer.alloc(10 + 128);
    tag.write('ID3', 0, 'latin1');
    tag[3] = 3;
    tag[8] = 1;
    const tagged = sniffAudioFormat(Buffer.concat([tag, frame]));
    assert.equal(tagged.container, 'mp3');
    assert.equal(tagged.sampleRate, 44100);
});

check('MPEG-2 and MPEG-2.5 rate tables', () => {
    // Bits 4-3 of the second byte select the version: 0b10 is MPEG 2, 0b00 is
    // MPEG 2.5, and each has its own sample-rate table.
    const mpeg2 = sniffAudioFormat(Buffer.from([0xff, 0xf3, 0x90, 0xc0, 0, 0, 0, 0, 0, 0, 0, 0]));
    assert.equal(mpeg2.sampleRate, 22050);
    assert.equal(mpeg2.channels, 1, 'channel mode 3 is mono');
    const mpeg25 = sniffAudioFormat(Buffer.from([0xff, 0xe3, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]));
    assert.equal(mpeg25.sampleRate, 11025);
});

check('M4A / MP4 audio tracks — the iPhone Voice Memos case', () => {
    const sniffed = sniffAudioFormat(buildM4a({ timescale: 44100, channels: 1 }));
    assert.equal(sniffed.container, 'mp4');
    assert.equal(sniffed.sampleRate, 44100, 'the media timescale of a sound track is its sample rate');
    assert.equal(sniffed.channels, 1);
    assert.equal(sniffed.codec, 'mp4a');
});

check('3GP is told apart from MP4 by its brand', () => {
    const file = buildM4a({ timescale: 8000, channels: 1 });
    file.write('3gp4', 8, 'latin1');
    const sniffed = sniffAudioFormat(file);
    assert.equal(sniffed.container, '3gp');
    assert.equal(sniffed.sampleRate, 8000);
});

check('FLAC STREAMINFO', () => {
    const file = Buffer.concat([Buffer.from('fLaC', 'latin1'), buildFlacStreamInfo({ sampleRate: 48000, channels: 2, bitDepth: 24 })]);
    const sniffed = sniffAudioFormat(file);
    assert.deepEqual(
        { container: sniffed.container, sampleRate: sniffed.sampleRate, channels: sniffed.channels, bitDepth: sniffed.bitDepth },
        { container: 'flac', sampleRate: 48000, channels: 2, bitDepth: 24 },
    );
});

check('Ogg Opus and Ogg Vorbis', () => {
    const opusHead = Buffer.alloc(19);
    opusHead.write('OpusHead', 0, 'latin1');
    opusHead[8] = 1;
    opusHead[9] = 1;                      // channels
    opusHead.writeUInt32LE(16000, 12);    // the ORIGINAL rate, not the output one
    const opus = sniffAudioFormat(buildOggPage(opusHead));
    assert.equal(opus.container, 'ogg');
    assert.equal(opus.codec, 'Opus');
    assert.equal(opus.sampleRate, 48000, 'Opus always decodes at 48 kHz whatever it was recorded at');
    assert.equal(opus.channels, 1);

    const vorbisId = Buffer.alloc(30);
    vorbisId[0] = 0x01;
    vorbisId.write('vorbis', 1, 'latin1');
    vorbisId[11] = 2;
    vorbisId.writeUInt32LE(44100, 12);
    const vorbis = sniffAudioFormat(buildOggPage(vorbisId));
    assert.equal(vorbis.codec, 'Vorbis');
    assert.equal(vorbis.sampleRate, 44100);
    assert.equal(vorbis.channels, 2);
});

check('AIFF, whose sample rate is an 80-bit float no JavaScript type holds', () => {
    const comm = Buffer.alloc(18);
    comm.writeUInt16BE(2, 0);
    comm.writeUInt32BE(1000, 2);
    comm.writeUInt16BE(16, 6);
    comm.writeUInt16BE(16398, 8);            // exponent for 2^15
    comm.writeUInt32BE(0xac440000, 10);      // 44100 << 48, high word
    const chunk = Buffer.alloc(8);
    chunk.write('COMM', 0, 'latin1');
    chunk.writeUInt32BE(comm.length, 4);
    const head = Buffer.alloc(12);
    head.write('FORM', 0, 'latin1');
    head.write('AIFF', 8, 'latin1');
    const sniffed = sniffAudioFormat(Buffer.concat([head, chunk, comm]));
    assert.equal(sniffed.container, 'aiff');
    assert.equal(sniffed.sampleRate, 44100);
    assert.equal(sniffed.channels, 2);
});

check('CAF', () => {
    const desc = Buffer.alloc(32);
    desc.writeDoubleBE(48000, 0);
    desc.write('lpcm', 8, 'latin1');
    desc.writeUInt32BE(1, 24);
    desc.writeUInt32BE(16, 28);
    const chunk = Buffer.alloc(12);
    chunk.write('desc', 0, 'latin1');
    chunk.writeUInt32BE(32, 8);
    const head = Buffer.alloc(8);
    head.write('caff', 0, 'latin1');
    const sniffed = sniffAudioFormat(Buffer.concat([head, chunk, desc]));
    assert.equal(sniffed.container, 'caf');
    assert.equal(sniffed.sampleRate, 48000);
    assert.equal(sniffed.codec, 'lpcm');
});

check('AMR is recognised and reported as undecodable, not as a broken file', () => {
    // Some Android recorders still write AMR, and no browser ships a decoder
    // for it. "No decoder for AMR" is actionable; "could not decode" is not.
    const narrow = sniffAudioFormat(Buffer.from('#!AMR\n\0\0\0\0\0\0', 'latin1'));
    assert.equal(narrow.container, 'amr');
    assert.equal(narrow.decodable, false);
    assert.equal(narrow.sampleRate, 8000);
    const wide = sniffAudioFormat(Buffer.from('#!AMR-WB\n\0\0\0', 'latin1'));
    assert.equal(wide.sampleRate, 16000);
});

check('WebM is recognised without a rate; the browser reads it itself', () => {
    const sniffed = sniffAudioFormat(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 0, 0, 0, 0, 0, 0, 0]));
    assert.equal(sniffed.container, 'webm');
    assert.equal(sniffed.sampleRate, 0);
});

check('non-audio bytes are not audio', () => {
    assert.equal(sniffAudioFormat(Buffer.from('time,value\n0,1\n2,3\n', 'latin1')), null);
    assert.equal(sniffAudioFormat(Buffer.alloc(4)), null, 'too short to judge');
});

// ─── decodeAudioFile ──────────────────────────────────────────────────────

await checkAsync('WAV decodes with no audio engine present', async () => {
    // The whole reason WAV is decoded in JavaScript: Node has no Web Audio, and
    // neither does a Worker. A stub decoder is passed that would throw if it
    // were reached.
    const wav = buildWav({ channels: [tone(500, 440, 44100)] });
    const decoded = await decodeAudioFile(wav, {
        decodeCompressed: () => { throw new Error('the WAV path must not need a browser decoder'); },
    });
    assert.equal(decoded.decodedBy, 'wav');
    assert.equal(decoded.frames, 500);
    assert.equal(decoded.resampled, false);
    assert.equal(decoded.containerLabel, 'WAV');
});

await checkAsync('compressed files are handed to the browser at their own sample rate', async () => {
    const seen = [];
    const decoded = await decodeAudioFile(buildM4a({ timescale: 44100, channels: 2 }), {
        decodeCompressed: (buffer, rate) => {
            seen.push(rate);
            return { sampleRate: rate, frames: 8, channels: [new Float32Array(8), new Float32Array(8)] };
        },
    });
    assert.deepEqual(seen, [44100], 'the context is created at the file\'s rate, not the sound card\'s');
    assert.equal(decoded.decodedBy, 'webaudio');
    assert.equal(decoded.resampled, false);
});

await checkAsync('a rate the header did not give falls back, and resampling is recorded', async () => {
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 1, 0, 0, 0, 0, 0, 0, 0]);
    const noRate = await decodeAudioFile(webm, {
        decodeCompressed: (_buffer, rate) => ({ sampleRate: rate, frames: 4, channels: [new Float32Array(4)] }),
    });
    assert.equal(noRate.sampleRate, 48000, 'falls back when the header says nothing');
    assert.equal(noRate.resampled, false, 'nothing was claimed, so nothing was overridden');

    // A browser that hands back a different rate than it was asked for is
    // resampling, and the recording info should say so.
    const forced = await decodeAudioFile(buildM4a({ timescale: 44100 }), {
        decodeCompressed: () => ({ sampleRate: 48000, frames: 4, channels: [new Float32Array(4)] }),
    });
    assert.equal(forced.resampled, true);
    assert.equal(forced.declaredSampleRate, 44100);
});

await checkAsync('unreadable inputs fail with a code the UI can translate', async () => {
    const cases = [
        [Buffer.alloc(0), 'AUDIO_EMPTY'],
        [Buffer.from('time,value\n0,1\n2,3\n', 'latin1'), 'AUDIO_UNRECOGNIZED'],
        [Buffer.from('#!AMR\n\0\0\0\0\0\0', 'latin1'), 'AUDIO_CODEC_UNAVAILABLE'],
    ];
    for (const [input, code] of cases) {
        await assert.rejects(() => decodeAudioFile(input), err => err.code === code, `${code} for ${input.length} bytes`);
    }
});

// ─── The parsed result ────────────────────────────────────────────────────

check('a stereo recording becomes a time axis and two signals', () => {
    const sampleRate = 8000;
    const decoded = decodeWav(buildWav({ sampleRate, channels: [tone(400, 100, sampleRate), tone(400, 200, sampleRate)] }));
    const result = new AudioParser().parse({ ...decoded, containerLabel: 'WAV', container: 'wav' }, 'memo.wav');

    assert.deepEqual(Object.keys(result.variables), ['time', 'Left', 'Right']);
    assert.equal(result.variables.time.kind, 'abscissa');
    assert.equal(result.variables.Left.kind, 'variable');
    assert.equal(result.metadata.timeName, 'time');
    assert.equal(result.metadata.timeKind, 'numeric');
    assert.equal(result.metadata.numTimesteps, 400);
    assert.equal(result.metadata.columnCount, 2);
    assert.equal(result.metadata.audio.duration, 400 / sampleRate);
});

check('the time axis carries its unit where the app looks for it', () => {
    // Units travel inside the description, in brackets — there is no `units`
    // property anywhere in this app. Setting one instead of writing "[s]" left
    // the FFT frequency axis reading "Frequency [1/x-unit]" and dropped the
    // "[s]" from the time axis title whenever the panel had not already
    // resolved itself to seconds. _extractUnit is the reader, so it is the one
    // that has to agree.
    const structure = new MatParser();
    const result = new AudioParser(structure).parse({ sampleRate: 8000, frames: 8, channels: [new Float32Array(8)] });
    assert.equal(structure._extractUnit(result.variables.time.description).trim(), '[s]');
    assert.equal(result.variables.time.units, undefined, 'a `units` property would be read by nothing');
    // A normalised waveform is dimensionless; a bracket here would end up on
    // the Y axis title as a unit that does not exist.
    assert.equal(structure._extractUnit(result.variables.Mono.description), '');
});

check('the time axis is exact seconds, not an accumulated step', () => {
    // Accumulating a step drifts over the tens of millions of samples an
    // ordinary recording holds, which would put the end of a long file
    // measurably in the wrong place.
    const sampleRate = 44100;
    const frames = 200000;
    const result = new AudioParser().parse({
        sampleRate,
        frames,
        channels: [new Float32Array(frames)],
    });
    const time = result.variables.time.data;
    assert.equal(time[0], 0);
    for (const i of [1, 4409, 99999, frames - 1]) {
        assert.equal(time[i], i / sampleRate, `t[${i}]`);
    }
    assert.equal(result.metadata.timeEnd, (frames - 1) / sampleRate);
});

check('channel naming', () => {
    assert.deepEqual(channelNames(1), ['Mono']);
    assert.deepEqual(channelNames(2), ['Left', 'Right']);
    assert.deepEqual(channelNames(4), ['Ch1', 'Ch2', 'Ch3', 'Ch4']);

    const mono = new AudioParser().parse({ sampleRate: 8000, frames: 4, channels: [new Float32Array(4)] });
    assert.ok(mono.variables.Mono, 'a one-channel file is Mono, not Ch1');
});

check('the recording details are in the tree and cannot be plotted', () => {
    const result = new AudioParser().parse({
        sampleRate: 48000,
        frames: 96000,
        channels: [new Float32Array(96000)],
        containerLabel: 'MP4 / M4A',
        codec: 'mp4a',
        bitDepth: 16,
    }, 'voice.m4a');

    const info = result.tree._children.Recording;
    assert.ok(info, 'the tree carries a Recording node');
    const labels = Object.keys(info._variables);
    assert.deepEqual(labels, ['Sample rate', 'Sampling time', 'Channels', 'Duration', 'Samples per channel', 'Format', 'Bit depth']);
    for (const label of labels) {
        assert.equal(info._variables[label].kind, 'parameter', `${label} is not plottable`);
        assert.equal(info._variables[label].dataType, 'string');
    }
    assert.equal(info._variables['Sample rate'].data[0], '48,000 Hz');
    // Not a bare "1": the sidebar pushes a parameter's value through Number()
    // and renders anything numeric as "1.00000".
    assert.equal(info._variables.Channels.data[0], '1 (mono)');
    assert.equal(info._variables.Duration.data[0], '0:02.00');
    assert.equal(info._variables.Format.data[0], 'MP4 / M4A · mp4a');
    // These are notes, not signals: they must not appear among the variables
    // the rest of the app can select and plot.
    assert.deepEqual(Object.keys(result.variables), ['time', 'Mono']);
});

check('the sampling time reads exactly as the time-axis panel states it', () => {
    // Two places print this number: the Recording details, and the "Sampling
    // of time" panel behind the clock icon, which measures Δt off the parser's
    // own time vector. Seeing "20.8333 µs" in one and "2.08333e-5 s" in the
    // other would give the reader no way to tell they are the same
    // measurement, so the check runs the real diagnostics over the real vector
    // and demands the same string.
    for (const sampleRate of [48000, 44100, 8000, 16000, 22050, 1]) {
        const frames = Math.min(4000, Math.max(64, Math.round(sampleRate / 10)));
        const result = new AudioParser().parse({ sampleRate, frames, channels: [new Float32Array(frames)] });
        const stated = result.tree._children.Recording._variables['Sampling time'].data[0];

        const diagnostics = computeTimeAxisDiagnostics(result.variables.time.data);
        assert.equal(diagnostics.verdict, 'equidistant', `${sampleRate} Hz is evenly sampled`);
        const asThePanelPrintsIt = formatTimeValue(diagnostics.dtMean, pickTimeUnit([diagnostics.dtMean]));
        assert.equal(stated, asThePanelPrintsIt, `${sampleRate} Hz`);
    }
});

check('the sampling time uses the nearest unit rather than an exponent', () => {
    const stated = (sampleRate) => new AudioParser()
        .parse({ sampleRate, frames: 64, channels: [new Float32Array(64)] })
        .tree._children.Recording._variables['Sampling time'].data[0];
    assert.equal(stated(48000), '20.8333 µs');
    assert.equal(stated(44100), '22.6757 µs');
    assert.equal(stated(8000), '125 µs');
    assert.equal(stated(1000), '1 ms');
    assert.equal(stated(1), '1 s');
});

check('resampling is disclosed when it happened', () => {
    const result = new AudioParser().parse({
        sampleRate: 48000,
        frames: 480,
        channels: [new Float32Array(480)],
        resampled: true,
        declaredSampleRate: 44100,
    });
    const info = result.tree._children.Recording._variables['Original sample rate'];
    assert.ok(info, 'the user is told the rate they see is not the file\'s own');
    assert.match(info.data[0], /44,100 Hz/);
});

check('an hour-long recording formats as hours', () => {
    // One sample per second keeps the fixture small while still producing an
    // hour of duration.
    const result = new AudioParser().parse({ sampleRate: 1, frames: 3725, channels: [new Float32Array(3725)] });
    assert.equal(result.tree._children.Recording._variables.Duration.data[0], '1:02:05.00');
});

check('empty and rateless decodes are refused', () => {
    assert.throws(() => new AudioParser().parse({ sampleRate: 8000, frames: 0, channels: [] }), err => err.code === 'AUDIO_EMPTY');
    assert.throws(() => new AudioParser().parse({ sampleRate: 0, frames: 4, channels: [new Float32Array(4)] }), err => err.code === 'AUDIO_DECODE_FAILED');
});

// ─── What it will cost in memory ──────────────────────────────────────────

check('the decoded size counts the time vector as well as the channels', () => {
    // The whole point of measuring the DECODED size: this is what the app is
    // about to allocate, and it is not the size of the file.
    assert.equal(decodedAudioBytes(1000, 2), 1000 * 3 * 8);
    assert.equal(decodedAudioBytes(1000, 1), 1000 * 2 * 8);
    assert.equal(decodedAudioBytes(0, 2), 0);

    // One minute of stereo CD audio, which is what a 1.5 MB MP3 holds.
    const oneMinute = decodedAudioBytes(44100 * 60, 2);
    assert.ok(oneMinute > 60 * 1024 * 1024, `a minute of stereo is ${Math.round(oneMinute / 1048576)} MB, not the file's size`);
});

// ─── Wiring ───────────────────────────────────────────────────────────────

check('every accepted extension is offered everywhere a file can be picked', () => {
    // Four separate lists have to agree, and nothing makes them agree by
    // construction: a missing entry means the format works when dropped and is
    // invisible in the file dialog, or the other way round.
    const listed = AUDIO_EXTENSIONS.map(e => e.slice(1)).sort();

    assert.deepEqual(
        RESULT_FILE_EXTENSIONS.filter(e => AUDIO_EXTENSIONS.includes(e)).map(e => e.slice(1)).sort(),
        listed,
        'the session/project reader accepts every audio extension',
    );

    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const accept = html.match(/id="file-input"[^>]*accept="([^"]+)"/)?.[1] || '';
    const accepted = accept.split(',').map(e => e.trim());
    for (const extension of AUDIO_EXTENSIONS) {
        assert.ok(accepted.includes(extension), `the browser file dialog offers ${extension}`);
    }

    const localHttp = readFileSync(new URL('../electron/local-file-http.cjs', import.meta.url), 'utf8');
    const desktop = localHttp.match(/AUDIO_FILE_EXTENSIONS = \[([\s\S]*?)\]/)?.[1] || '';
    const desktopList = [...desktop.matchAll(/'([^']+)'/g)].map(m => m[1]).sort();
    assert.deepEqual(desktopList, listed, 'the desktop file dialog offers the same set');

    for (const extension of AUDIO_EXTENSIONS) {
        assert.match(localHttp, new RegExp(`\\['\\${extension}', 'audio/`), `${extension} is served with an audio MIME type`);
    }
});

check('audio is routed by extension, before the text sniffing', () => {
    const source = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
    const dispatch = source.slice(source.indexOf('proto._parseResultBuffer'), source.indexOf('proto._matlabEagerLimitBytes'));
    const byExtension = dispatch.indexOf('isAudioExtension(extension)');
    const bySniff = dispatch.indexOf('_looksLikeTextBuffer(buffer)');
    assert.ok(byExtension > 0, 'audio has its own branch');
    assert.ok(byExtension < bySniff, 'audio is routed before any attempt to read it as text');
});

check('the size question is asked between decoding and building the columns', () => {
    // The order is the point. Asking earlier would be asking about the file
    // size, which for audio means nothing; asking later would be asking after
    // the memory has already been taken.
    const source = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('proto._parseAudioResultBuffer'), source.indexOf('function translateAudioError'));
    const decode = body.indexOf('decodeAudioFile');
    const confirm = body.indexOf('checkDecodedAudioLimit');
    const build = body.indexOf('parser.parse(');
    assert.ok(decode > 0 && confirm > decode && build > confirm, 'decode → ask → build');
    assert.match(body, /allowOversized/, 'a user who already said yes is not asked again');
});

console.log(`audio parser: ${checks} checks passed`);
