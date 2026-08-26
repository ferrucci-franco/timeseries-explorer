// Apple Lossless, decoded by our own code — src/parsers/alac-decoder.js
// explains why the browser is not asked.
//
//   node scripts/test-alac-decoder.mjs
//
// Correctness is claimed three unrelated ways, because each can lie alone:
//
//   * Real encoder roundtrips. Three small ALAC files made by ffmpeg's
//     encoder (an implementation unrelated to ours) from PCM this file can
//     regenerate deterministically. ALAC is lossless, so the decoded output
//     must equal that PCM exactly — every sample, every channel, every bit.
//     A decoder that misreads Rice codes, predictor state or the stereo
//     unmix cannot pass this by luck.
//
//   * Hand-built files, byte by byte, for the parts ffmpeg's encoder never
//     writes: escape (uncompressed) frames, partial frames, the demuxing
//     itself, and the failure paths.
//
//   * The wiring: decodeAudioFile must route M4A-with-ALAC here — in Node,
//     with no Web Audio anywhere — and the parser must turn the result into
//     the same columns any other recording becomes.

import assert from 'node:assert/strict';

import { decodeAlacFromMp4, parseAlacCookie } from '../src/parsers/alac-decoder.js';
import { decodeAudioFile, sniffAudioFormat } from '../src/parsers/audio-decode.js';
import AudioParser from '../src/parsers/audio-parser.js';
import { mono16, stereo16, stereo24 } from './alac-test-fixtures.mjs';

let checks = 0;
const check = (name, fn) => { fn(); checks++; };
const checkAsync = async (name, fn) => { await fn(); checks++; };

// ─── The deterministic PCM behind the ffmpeg fixtures ─────────────────────

// Integer arithmetic only: Math.sin is not guaranteed to round the same way
// in every engine, and this generator has to reproduce, forever, the exact
// samples the fixtures were encoded from. Three sections: a triangle wave
// with an exact integer slope (the predictor's favourite food), silence (the
// zero-run coder's), and seeded noise (the entropy coder's).
const FIXTURE_FRAMES = 8704; // two full 4096-sample packets + one partial

function fixtureChannel(frames, channel, toneSlope, noiseAmplitude) {
    let seed = (0x2545f49 + channel * 7919) >>> 0;
    const lcg = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0);
    const out = new Int32Array(frames);
    const period = 126 + channel * 16;
    const half = period >> 1;
    for (let i = 0; i < frames; i++) {
        if (i < frames * 0.5) {
            const pos = i % period;
            const frac = pos < half ? pos : period - pos;
            out[i] = (2 * frac - half) * toneSlope;
        } else if (i < frames * 0.7) {
            out[i] = 0;
        } else {
            out[i] = ((lcg() >>> 8) % (2 * noiseAmplitude + 1)) - noiseAmplitude;
        }
    }
    return out;
}

function expectLossless(name, base64, { channels, bitDepth }) {
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    const decoded = decodeAlacFromMp4(bytes);
    assert.ok(decoded, `${name}: recognised as ALAC`);
    assert.equal(decoded.frames, FIXTURE_FRAMES, `${name}: every packet decoded, the partial one included`);
    assert.equal(decoded.channels.length, channels, `${name}: channel count`);
    assert.equal(decoded.bitDepth, bitDepth, `${name}: bit depth from the magic cookie`);
    assert.equal(decoded.sampleRate, 8000, `${name}: sample rate from the magic cookie`);

    const toneSlope = bitDepth === 16 ? 140 : 60000;
    const noiseAmplitude = bitDepth === 16 ? 2500 : 300;
    const scale = 2 ** (bitDepth - 1);
    for (let c = 0; c < channels; c++) {
        const expected = fixtureChannel(FIXTURE_FRAMES, c, toneSlope, noiseAmplitude);
        for (let i = 0; i < FIXTURE_FRAMES; i++) {
            const got = Math.round(decoded.channels[c][i] * scale);
            if (got !== expected[i]) {
                assert.fail(`${name}: channel ${c} sample ${i}: decoded ${got}, encoder was given ${expected[i]}`);
            }
        }
    }
}

check('16-bit mono survives a real encoder roundtrip bit-exactly', () => {
    expectLossless('mono16', mono16, { channels: 1, bitDepth: 16 });
});

check('16-bit stereo survives a real encoder roundtrip bit-exactly', () => {
    // The two channels differ in seed and period, so an exact match is also
    // proof the decorrelated pair came back in the right order.
    expectLossless('stereo16', stereo16, { channels: 2, bitDepth: 16 });
});

check('24-bit stereo — the iPhone "Lossless" voice memo shape — roundtrips', () => {
    expectLossless('stereo24', stereo24, { channels: 2, bitDepth: 24 });
});

// ─── Hand-built files: escape frames, partial frames, demuxing ────────────

class BitWriter {
    constructor() { this.bytes = []; this.acc = 0; this.have = 0; }
    write(value, n) {
        for (let i = n - 1; i >= 0; i--) {
            this.acc = (this.acc << 1) | ((value >>> i) & 1);
            if (++this.have === 8) { this.bytes.push(this.acc); this.acc = 0; this.have = 0; }
        }
    }
    finish() {
        if (this.have > 0) this.bytes.push((this.acc << (8 - this.have)) & 0xff);
        return Buffer.from(this.bytes);
    }
}

function box(type, ...parts) {
    const body = Buffer.concat(parts.map(p => (Buffer.isBuffer(p) ? p : Buffer.from(p, 'latin1'))));
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
}

// One escape-coded packet: the verbatim path every ALAC encoder keeps for
// frames that refuse to compress, and the one path ffmpeg's encoder never
// emitted for the fixtures above.
function escapePacket(channelData, frameLength, bitDepth) {
    const samples = channelData[0].length;
    const partial = samples !== frameLength;
    const w = new BitWriter();
    w.write(channelData.length === 2 ? 1 : 0, 3); // CPE or SCE
    w.write(0, 4);                                // element instance tag
    w.write(0, 12);                               // unused, must be zero
    w.write(partial ? 1 : 0, 1);
    w.write(0, 2);                                // bytesShifted
    w.write(1, 1);                                // escape: raw PCM follows
    if (partial) w.write(samples, 32);
    const mask = (1 << bitDepth) - 1;
    for (let i = 0; i < samples; i++) {
        for (const channel of channelData) w.write(channel[i] & mask, bitDepth);
    }
    w.write(7, 3);                                // END
    return w.finish();
}

// A minimal M4A around ALAC packets: exactly the boxes the demuxer reads,
// with the magic cookie in the 'alac' child of the 'alac' sample entry.
function buildAlacM4a({ channelData, frameLength = 1024, bitDepth = 16, sampleRate = 8000, entryType = 'alac' }) {
    const channels = channelData.length;
    const frames = channelData[0].length;
    const packets = [];
    for (let at = 0; at < frames; at += frameLength) {
        const slice = channelData.map(ch => ch.subarray(at, Math.min(at + frameLength, frames)));
        packets.push(escapePacket(slice, frameLength, bitDepth));
    }

    const cookie = Buffer.alloc(24);
    cookie.writeUInt32BE(frameLength, 0);
    cookie.writeUInt8(bitDepth, 5);
    cookie.writeUInt8(40, 6);                    // pb
    cookie.writeUInt8(10, 7);                    // mb
    cookie.writeUInt8(14, 8);                    // kb
    cookie.writeUInt8(channels, 9);
    cookie.writeUInt16BE(255, 10);               // maxRun
    cookie.writeUInt32BE(sampleRate, 20);
    const alacBox = box('alac', Buffer.alloc(4), cookie);

    const entry = Buffer.alloc(36);
    entry.writeUInt32BE(36 + alacBox.length, 0);
    entry.write(entryType, 4, 'latin1');
    entry.writeUInt16BE(1, 14);                  // data reference index
    entry.writeUInt16BE(channels, 24);
    entry.writeUInt16BE(bitDepth, 26);
    entry.writeUInt16BE(sampleRate, 32);
    const stsd = box('stsd', Buffer.alloc(4), Buffer.from([0, 0, 0, 1]), entry, alacBox);

    const u32 = (...values) => {
        const b = Buffer.alloc(values.length * 4);
        values.forEach((v, i) => b.writeUInt32BE(v, i * 4));
        return b;
    };
    const stts = box('stts', u32(0, 1, packets.length, frameLength));
    const stsc = box('stsc', u32(0, 1, 1, packets.length, 1));
    const stsz = box('stsz', u32(0, 0, packets.length, ...packets.map(p => p.length)));
    // ftyp is 28 bytes and the mdat header 8, so the first packet lands at 36.
    const stco = box('stco', u32(0, 1, 36));

    const mdhd = (() => {
        const b = Buffer.alloc(24);
        b.writeUInt32BE(sampleRate, 12);
        b.writeUInt32BE(frames, 16);
        return box('mdhd', b);
    })();
    const hdlr = box('hdlr', Buffer.alloc(8), Buffer.from('soun', 'latin1'), Buffer.alloc(12));
    const stbl = box('stbl', stsd, stts, stsc, stsz, stco);
    const moov = box('moov', box('trak', box('mdia', mdhd, hdlr, box('minf', stbl))));
    const ftyp = box('ftyp', 'M4A ', Buffer.alloc(4), 'M4A mp42isom');
    return new Uint8Array(Buffer.concat([ftyp, box('mdat', ...packets), moov]));
}

function rampChannel(frames, from, step) {
    const out = new Int32Array(frames);
    for (let i = 0; i < frames; i++) out[i] = from + ((i * step) % 7001) - 3500;
    return out;
}

check('escape-coded mono decodes byte-exactly, partial last frame included', () => {
    const channel = rampChannel(2500, 100, 37); // 2 full 1024-packets + 452
    const decoded = decodeAlacFromMp4(buildAlacM4a({ channelData: [channel] }));
    assert.equal(decoded.frames, 2500);
    assert.equal(decoded.channels.length, 1);
    for (let i = 0; i < 2500; i++) {
        assert.equal(Math.round(decoded.channels[0][i] * 32768), channel[i], `sample ${i}`);
    }
});

check('escape-coded stereo keeps its channels apart and in order', () => {
    const left = rampChannel(1500, 20, 13);
    const right = rampChannel(1500, -20, 29);
    const decoded = decodeAlacFromMp4(buildAlacM4a({ channelData: [left, right] }));
    assert.equal(decoded.channels.length, 2);
    for (let i = 0; i < 1500; i++) {
        assert.equal(Math.round(decoded.channels[0][i] * 32768), left[i], `left ${i}`);
        assert.equal(Math.round(decoded.channels[1][i] * 32768), right[i], `right ${i}`);
    }
});

check('24-bit escape frames keep their least significant byte', () => {
    const channel = new Int32Array(600);
    for (let i = 0; i < 600; i++) channel[i] = ((i * 40503) % 4000000) - 2000000 + (i % 251);
    const decoded = decodeAlacFromMp4(buildAlacM4a({ channelData: [channel], bitDepth: 24 }));
    assert.equal(decoded.bitDepth, 24);
    for (let i = 0; i < 600; i++) {
        assert.equal(Math.round(decoded.channels[0][i] * 8388608), channel[i], `sample ${i}`);
    }
});

check('the sniffer reads the alac codec out of the sample description', () => {
    const sniffed = sniffAudioFormat(buildAlacM4a({ channelData: [rampChannel(64, 0, 1)] }));
    assert.equal(sniffed.container, 'mp4');
    assert.equal(sniffed.codec, 'alac');
});

check('an MP4 whose audio is not ALAC is left for the browser decoder', () => {
    const bytes = buildAlacM4a({ channelData: [rampChannel(64, 0, 1)], entryType: 'mp4a' });
    assert.equal(decodeAlacFromMp4(bytes), null);
});

check('a corrupt packet fails as a decode error, never silently', () => {
    const bytes = buildAlacM4a({ channelData: [rampChannel(64, 0, 1)] });
    bytes[36] = 0xff; // first packet now opens with an END element
    assert.throws(() => decodeAlacFromMp4(bytes), (err) => err.code === 'AUDIO_DECODE_FAILED');
});

check('a magic cookie with nothing in it is rejected up front', () => {
    const cookie = Buffer.alloc(24); // frameLength 0, channels 0
    assert.throws(() => parseAlacCookie(new Uint8Array(cookie), 0), (err) => err.code === 'AUDIO_DECODE_FAILED');
});

// ─── The wiring ───────────────────────────────────────────────────────────

await checkAsync('decodeAudioFile routes M4A-with-ALAC here, with no Web Audio anywhere', async () => {
    // This runs in Node: reaching the browser decoder would throw
    // AUDIO_NO_DECODER, so merely resolving proves the route.
    const decoded = await decodeAudioFile(new Uint8Array(Buffer.from(stereo16, 'base64')));
    assert.equal(decoded.decodedBy, 'alac');
    assert.equal(decoded.codec, 'Apple Lossless (ALAC)');
    assert.equal(decoded.resampled, false, 'lossless decode at the file\'s own rate, nothing resampled');
    assert.equal(decoded.sampleRate, 8000);
    assert.equal(decoded.declaredSampleRate, 8000);
});

await checkAsync('a lossless voice memo becomes ordinary columns', async () => {
    const decoded = await decodeAudioFile(new Uint8Array(Buffer.from(stereo16, 'base64')));
    const result = new AudioParser().parse(decoded, 'memo.m4a');
    assert.deepEqual(Object.keys(result.variables), ['time', 'Left', 'Right']);
    assert.equal(result.metadata.numTimesteps, FIXTURE_FRAMES);
    const info = result.tree._children.Recording;
    assert.equal(info._variables.Format.data[0], 'MP4 / M4A · Apple Lossless (ALAC)');
    assert.equal(info._variables['Bit depth'].data[0], '16-bit');
});

await checkAsync('an ALAC file that will not decode still falls back to the browser', async () => {
    // Corrupt the packet, not the container: the file must still look like
    // ALAC so the fallback (Safari has a native decoder) stays reachable. In
    // Node that fallback reports there is no decoder at all.
    const bytes = buildAlacM4a({ channelData: [rampChannel(64, 0, 1)] });
    bytes[36] = 0xff;
    await assert.rejects(decodeAudioFile(bytes), (err) => err.code === 'AUDIO_NO_DECODER');
});

console.log(`alac decoder: ${checks} checks passed`);
