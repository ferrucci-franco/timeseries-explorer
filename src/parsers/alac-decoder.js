// Apple Lossless (ALAC), decoded here in plain JavaScript.
//
// Every other compressed format is handed to the browser's decodeAudioData,
// and the comment in audio-decode.js explains why: bundling an MP3 or AAC
// decoder would duplicate megabytes every browser already ships. ALAC breaks
// that reasoning twice. No browser except Safari ships it — an iPhone voice
// memo recorded with the quality setting "Lossless" simply does not open in
// Firefox or Chrome — and the codec itself is small: adaptive Rice coding, an
// adaptive FIR predictor and one stereo decorrelation, which is this file.
//
// Decoding it ourselves also buys exactness, the same way the WAV path does:
// decodeAudioData resamples to the context rate and returns whatever the
// audio engine felt like, while a lossless codec decoded losslessly returns
// the recorded PCM bit for bit, at the file's own rate, in Node as well as in
// a browser — which is also what lets the tests run without an audio engine.
//
// Ported from Apple's open-source reference decoder (alac.macosforge.org,
// now github.com/macosforge/alac: ag_dec.c, dp_dec.c, matrix_dec.c,
// ALACDecoder.cpp), keeping its variable conventions where that helps a
// reader compare the two. Verified bit-exact against ffmpeg's independent
// implementation on real Voice Memos recordings.

// The only container ALAC travels in that this app meets is MP4/M4A. The
// demuxer below is deliberately its own small walk rather than a reuse of the
// sniffer's in audio-decode.js: the sniffer reads one box deep for a header
// field, while decoding needs the sample tables and the magic cookie, and
// sharing the walk would couple two readers with different needs.

const ID_SCE = 0;   // single channel element
const ID_CPE = 1;   // channel pair element
const ID_CCE = 2;   // coupling element — never used by ALAC encoders
const ID_LFE = 3;   // low frequency element, mono in practice
const ID_DSE = 4;   // data stream element, skipped
const ID_PCE = 5;   // program config element — never used
const ID_FIL = 6;   // fill element, skipped
const ID_END = 7;

// Rice coding constants, straight from ag_dec.c.
const QBSHIFT = 9;
const MAX_PREFIX = 9;       // longer unary prefixes escape to a plain read
const MAX_RUN_BITS = 16;    // zero-run lengths escape to 16 bits

function alacError(message) {
    const err = new Error(message);
    err.code = 'AUDIO_DECODE_FAILED';
    err.format = 'MP4 / M4A';
    return err;
}

// ─── Bit reading ──────────────────────────────────────────────────────────

// MSB-first, as ALAC is written. Reading past the packet is a structural
// error, never padding, so it throws instead of inventing zero bits.
class BitReader {
    constructor(bytes, start, end) {
        this.bytes = bytes;
        this.pos = start;
        this.end = end;
        this.acc = 0;
        this.have = 0;
    }

    /** Read up to 24 bits, unsigned. */
    read(n) {
        while (this.have < n) {
            if (this.pos >= this.end) throw alacError('ALAC packet ended mid-read.');
            this.acc = ((this.acc << 8) | this.bytes[this.pos++]) >>> 0;
            this.have += 8;
        }
        this.have -= n;
        const out = (this.acc >>> this.have) & ((1 << n) - 1);
        this.acc &= (1 << this.have) - 1;
        return out >>> 0;
    }

    /** Read up to 32 bits, unsigned. */
    readWide(n) {
        if (n <= 24) return this.read(n);
        return (this.read(n - 16) * 65536 + this.read(16)) >>> 0;
    }

    /** Read up to 32 bits, sign-extended. */
    readSigned(n) {
        const v = this.readWide(n);
        if (n === 32) return v | 0;
        return (v << (32 - n)) >> (32 - n);
    }

    // The unary prefix of a Rice code: consecutive 1-bits ended by a 0. Nine
    // ones arrive with no terminator — that is the escape marker.
    unary() {
        let n = 0;
        while (n < MAX_PREFIX && this.read(1) === 1) n++;
        return n;
    }

    skip(n) {
        // In whole bytes where possible: shift buffers can be megabits long.
        const fromAcc = Math.min(n, this.have);
        if (fromAcc > 0) this.read(fromAcc);
        let left = n - fromAcc;
        const bytes = Math.floor(left / 8);
        if (this.pos + bytes > this.end) throw alacError('ALAC packet ended mid-skip.');
        this.pos += bytes;
        left -= bytes * 8;
        if (left > 0) this.read(left);
    }

    alignToByte() {
        const extra = this.have % 8;
        if (extra > 0) this.read(extra);
    }

    clone() {
        const copy = new BitReader(this.bytes, this.pos, this.end);
        copy.acc = this.acc;
        copy.have = this.have;
        return copy;
    }
}

// ─── Rice decoding (ag_dec.c) ─────────────────────────────────────────────

const log2i = (x) => (x > 0 ? 31 - Math.clz32(x) : 0);

// One Golomb/Rice scalar with ALAC's two quirks: the escape after nine prefix
// bits, and the k-bit remainder whose values 0 and 1 share a shortened code —
// when the remainder's high k-1 bits are all zero, its last bit was never
// written, so it must not be consumed either.
function riceScalar(reader, k, escapeBits) {
    const prefix = reader.unary();
    if (prefix >= MAX_PREFIX) return reader.readWide(escapeBits);
    if (k === 1) return prefix;
    const x = prefix * ((1 << k) - 1);
    const high = reader.read(k - 1);
    if (high === 0) return x;
    return x + high * 2 + reader.read(1) - 1;
}

// Decode `count` residuals. The Rice parameter adapts to a running history of
// magnitudes, and runs of zeros — silence, in audio terms — get their own
// run-length code once the history says the signal has gone quiet.
function riceDecode(reader, out, count, chanbits, historyMult, initialHistory, riceLimit) {
    let history = initialHistory;
    let signModifier = 0;
    for (let i = 0; i < count; i++) {
        let k = log2i((history >> QBSHIFT) + 3);
        k = Math.min(k, riceLimit);
        let x = riceScalar(reader, k, chanbits);
        x += signModifier;
        signModifier = 0;
        out[i] = (x >>> 1) ^ -(x & 1);

        if (x > 0xffff) history = 0xffff;
        else history += x * historyMult - ((history * historyMult) >> QBSHIFT);

        // Zero run: only reachable when the history has decayed to near-quiet.
        if (history < 128 && i + 1 < count) {
            let kRun = 7 - log2i(history) + ((history + 16) >> 6);
            kRun = Math.min(kRun, riceLimit);
            let run = riceScalar(reader, kRun, MAX_RUN_BITS);
            if (run > 0) {
                if (run > count - i - 1) throw alacError('ALAC zero run overflows its frame.');
                out.fill(0, i + 1, i + 1 + run);
                i += run;
            }
            if (run <= 0xffff) signModifier = 1;
            history = 0;
        }
    }
}

// ─── The predictor (dp_dec.c) ─────────────────────────────────────────────

// Undo the adaptive FIR prediction, mutating `coefs` exactly as the encoder
// did so both sides stay in lockstep. `err` and `out` may be the same array —
// mode 15 runs a first-order pass in place before the real one. All
// arithmetic wraps at 32 bits, matching the reference's int32.
function predict(err, out, count, coefs, order, denshift, chanbits) {
    const shift = 32 - chanbits;
    out[0] = err[0];
    if (count <= 1) return;

    if (order === 0) {
        if (out !== err) out.set(err.subarray(0, count));
        return;
    }
    if (order === 31) {
        // The special "order 31" is a plain first-order predictor.
        for (let j = 1; j < count; j++) out[j] = ((out[j - 1] + err[j]) << shift) >> shift;
        return;
    }

    for (let j = 1; j <= order && j < count; j++) {
        out[j] = ((out[j - 1] + err[j]) << shift) >> shift;
    }

    const denhalf = denshift > 0 ? 1 << (denshift - 1) : 0;
    for (let j = order + 1; j < count; j++) {
        const top = out[j - order - 1];
        let sum = 0;
        for (let k = 0; k < order; k++) {
            sum = (sum + coefs[k] * (out[j - 1 - k] - top)) | 0;
        }
        const del = err[j];
        out[j] = ((del + top + ((sum + denhalf) >> denshift)) << shift) >> shift;

        // Sign-LMS adaptation, nudging each tap by ±1 until the residual's
        // energy is spoken for.
        if (del > 0) {
            let left = del;
            for (let k = order - 1; k >= 0; k--) {
                const dd = top - out[j - 1 - k];
                const sgn = dd > 0 ? 1 : dd < 0 ? -1 : 0;
                coefs[k] -= sgn;
                left -= (order - k) * ((sgn * dd) >> denshift);
                if (left <= 0) break;
            }
        } else if (del < 0) {
            let left = del;
            for (let k = order - 1; k >= 0; k--) {
                const dd = top - out[j - 1 - k];
                const sgn = dd > 0 ? 1 : dd < 0 ? -1 : 0;
                coefs[k] += sgn;
                left -= (order - k) * ((-sgn * dd) >> denshift);
                if (left >= 0) break;
            }
        }
    }
}

// ─── Stereo decorrelation (matrix_dec.c) ──────────────────────────────────

// The encoder stores an adjustable mid/side pair; mixRes 0 means the channels
// were left separate. In place: U becomes left, V becomes right.
function unmix(U, V, count, mixBits, mixRes) {
    if (!mixRes) return;
    for (let i = 0; i < count; i++) {
        const u = U[i];
        const v = V[i];
        const l = (u + v - (((mixRes * v) | 0) >> mixBits)) | 0;
        U[i] = l;
        V[i] = l - v;
    }
}

// ─── One packet ───────────────────────────────────────────────────────────

// Decode a single ALAC packet (one "frame" of up to cookie.frameLength
// samples for every channel) into the per-channel Int32 scratch buffers.
// Returns the number of samples the packet carried.
function decodePacket(reader, cookie, scratch) {
    let channelIndex = 0;
    let samples = -1;

    for (;;) {
        const tag = reader.read(3);
        if (tag === ID_END) break;

        if (tag === ID_SCE || tag === ID_LFE || tag === ID_CPE) {
            const channels = tag === ID_CPE ? 2 : 1;
            if (channelIndex + channels > cookie.numChannels) {
                throw alacError('ALAC frame carries more channels than its header declares.');
            }
            const got = decodeElement(reader, cookie, scratch, channelIndex, channels);
            if (samples >= 0 && got !== samples) {
                throw alacError('ALAC channel elements disagree on the frame length.');
            }
            samples = got;
            channelIndex += channels;
            continue;
        }
        if (tag === ID_DSE) {
            // Data stream element: parse enough to step over it.
            reader.read(4);                       // element instance tag
            const align = reader.read(1);
            let count = reader.read(8);
            if (count === 255) count += reader.read(8);
            if (align) reader.alignToByte();
            reader.skip(count * 8);
            continue;
        }
        if (tag === ID_FIL) {
            let count = reader.read(4);
            if (count === 15) count += reader.read(8) - 1;
            reader.skip(count * 8);
            continue;
        }
        throw alacError(`ALAC frame contains an unsupported element (${tag === ID_CCE ? 'CCE' : 'PCE'}).`);
    }

    if (samples < 0) throw alacError('ALAC frame contains no audio elements.');
    if (channelIndex !== cookie.numChannels) {
        throw alacError('ALAC frame is missing channels its header declares.');
    }
    return samples;
}

function decodeElement(reader, cookie, scratch, channelIndex, channels) {
    reader.read(4);                              // element instance tag
    if (reader.read(12) !== 0) throw alacError('ALAC element header is corrupt.');
    const partialFrame = reader.read(1);
    const bytesShifted = reader.read(2);
    if (bytesShifted === 3) throw alacError('ALAC element declares an invalid shift.');
    const escape = reader.read(1);
    const samples = partialFrame ? reader.readWide(32) : cookie.frameLength;
    if (samples > cookie.frameLength) throw alacError('ALAC partial frame is longer than a full one.');

    const U = scratch.mix[channelIndex];
    const V = channels === 2 ? scratch.mix[channelIndex + 1] : null;

    if (escape) {
        // Uncompressed: interleaved raw PCM at the full bit depth. The rare
        // case, but also the honest fallback every encoder keeps for frames
        // that refuse to compress.
        for (let i = 0; i < samples; i++) {
            U[i] = reader.readSigned(cookie.bitDepth);
            if (V) V[i] = reader.readSigned(cookie.bitDepth);
        }
        return samples;
    }

    const shift = bytesShifted * 8;
    const chanbits = cookie.bitDepth - shift + channels - 1;
    if (chanbits > 32) throw alacError('ALAC frame needs more than 32 bits per sample.');

    const mixBits = reader.read(8);
    const mixRes = (reader.read(8) << 24) >> 24;  // signed, and 0 for mono

    const heads = [];
    for (let ch = 0; ch < channels; ch++) {
        let byte = reader.read(8);
        const mode = byte >> 4;
        const denshift = byte & 0x0f;
        if (mode !== 0 && mode !== 15) throw alacError('ALAC frame uses an unknown predictor mode.');
        byte = reader.read(8);
        const pbFactor = byte >> 5;
        const order = byte & 0x1f;
        // Int16, not Int32: the taps adapt as samples decode, and when one
        // crosses ±32768 it has to wrap exactly like the reference's int16_t
        // or every later sample in the frame comes out wrong.
        const coefs = new Int16Array(order);
        for (let k = 0; k < order; k++) coefs[k] = reader.read(16);
        heads.push({ mode, denshift, pbFactor, order, coefs });
    }

    // The shifted-away low bytes sit between the headers and the entropy
    // data; note where they start, decode past them, read them afterwards.
    let shiftReader = null;
    if (shift) {
        shiftReader = reader.clone();
        reader.skip(samples * channels * shift);
    }

    for (let ch = 0; ch < channels; ch++) {
        const head = heads[ch];
        const target = ch === 0 ? U : V;
        const historyMult = Math.floor((cookie.pb * head.pbFactor) / 4);
        riceDecode(reader, scratch.err, samples, chanbits, historyMult, cookie.mb, cookie.kb);
        if (head.mode === 15) {
            // Mode 15 chains a first-order pass before the coefficient one.
            predict(scratch.err, scratch.err, samples, null, 31, 0, chanbits);
        }
        predict(scratch.err, target, samples, head.coefs, head.order, head.denshift, chanbits);
    }

    if (channels === 2) unmix(U, V, samples, mixBits, mixRes);

    if (shift) {
        for (let i = 0; i < samples; i++) {
            U[i] = (U[i] << shift) | shiftReader.read(shift);
            if (V) V[i] = (V[i] << shift) | shiftReader.read(shift);
        }
    }
    return samples;
}

// ─── The magic cookie ─────────────────────────────────────────────────────

/** The ALACSpecificConfig: 24 bytes the encoder and decoder agree on. */
export function parseAlacCookie(bytes, offset) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cookie = {
        frameLength: view.getUint32(offset),
        bitDepth: bytes[offset + 5],
        pb: bytes[offset + 6],       // rice history multiplier
        mb: bytes[offset + 7],       // rice initial history
        kb: bytes[offset + 8],       // rice parameter limit
        numChannels: bytes[offset + 9],
        maxRun: view.getUint16(offset + 10),
        sampleRate: view.getUint32(offset + 20),
    };
    if (!cookie.frameLength || cookie.frameLength > 1 << 20) {
        throw alacError('ALAC header declares an unusable frame length.');
    }
    if (!cookie.numChannels || cookie.numChannels > 8) {
        throw alacError('ALAC header declares an unusable channel count.');
    }
    if (cookie.bitDepth < 8 || cookie.bitDepth > 32) {
        throw alacError('ALAC header declares an unusable bit depth.');
    }
    return cookie;
}

// ─── MP4 demuxing ─────────────────────────────────────────────────────────

function fourCC(bytes, offset) {
    if (offset + 4 > bytes.length) return '';
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

// One level of the box tree; `visit` returning false stops the walk.
function walkBoxes(bytes, view, start, end, visit) {
    let offset = start;
    while (offset + 8 <= end) {
        let size = view.getUint32(offset);
        const type = fourCC(bytes, offset + 4);
        let headerSize = 8;
        if (size === 1) {
            if (offset + 16 > end) return;
            size = view.getUint32(offset + 8) * 4294967296 + view.getUint32(offset + 12);
            headerSize = 16;
        } else if (size === 0) {
            size = end - offset;
        }
        if (size < headerSize || offset + size > end) return;
        if (visit(type, offset + headerSize, offset + size) === false) return;
        offset += size;
    }
}

// Find the ALAC audio track: its magic cookie and its sample tables. Returns
// null when the file's audio is not ALAC — the caller falls back to the
// browser's decoder for those.
function findAlacTrack(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let found = null;

    walkBoxes(bytes, view, 0, bytes.length, (type, start, end) => {
        if (type !== 'moov') return;
        walkBoxes(bytes, view, start, end, (t1, s1, e1) => {
            if (t1 !== 'trak') return;
            const track = { isAudio: false, cookieAt: -1, stsz: -1, stsc: -1, stco: -1, co64: -1 };
            walkBoxes(bytes, view, s1, e1, (t2, s2, e2) => {
                if (t2 !== 'mdia') return;
                walkBoxes(bytes, view, s2, e2, (t3, s3, e3) => {
                    if (t3 === 'hdlr') track.isAudio = fourCC(bytes, s3 + 8) === 'soun';
                    if (t3 !== 'minf') return;
                    walkBoxes(bytes, view, s3, e3, (t4, s4, e4) => {
                        if (t4 !== 'stbl') return;
                        walkBoxes(bytes, view, s4, e4, (t5, s5, e5) => {
                            if (t5 === 'stsz') track.stsz = s5;
                            else if (t5 === 'stsc') track.stsc = s5;
                            else if (t5 === 'stco') track.stco = s5;
                            else if (t5 === 'co64') track.co64 = s5;
                            else if (t5 === 'stsd' && fourCC(bytes, s5 + 12) === 'alac') {
                                // Inside the sample entry: its own boxes start
                                // after the audio sample entry fields — 36
                                // bytes for version 0, more for QuickTime's
                                // v1/v2 layouts. The cookie is in an 'alac'
                                // child, sometimes wrapped one level deeper
                                // in a 'wave' box.
                                const entryStart = s5 + 8;
                                const entryEnd = Math.min(entryStart + view.getUint32(entryStart), e5);
                                const version = view.getUint16(entryStart + 16);
                                const fields = version === 1 ? 52 : version === 2 ? 72 : 36;
                                const findCookie = (from, to) => {
                                    walkBoxes(bytes, view, from, to, (t6, s6, e6) => {
                                        if (t6 === 'alac' && e6 - s6 >= 28) track.cookieAt = s6 + 4;
                                        else if (t6 === 'wave') findCookie(s6, e6);
                                    });
                                };
                                findCookie(entryStart + fields, entryEnd);
                            }
                        });
                    });
                });
            });
            if (track.isAudio && track.cookieAt >= 0) {
                found = track;
                return false;
            }
        });
        return false;
    });
    return found;
}

// Turn the three sample tables into a flat list of packet byte ranges. In MP4
// terms every ALAC packet is one "sample"; chunks group samples back to back
// at an absolute file offset.
function packetRanges(bytes, track) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (track.stsz < 0 || track.stsc < 0 || (track.stco < 0 && track.co64 < 0)) {
        throw alacError('ALAC track is missing its sample tables.');
    }

    const uniformSize = view.getUint32(track.stsz + 4);
    const sampleCount = view.getUint32(track.stsz + 8);
    const sizeOf = (index) => (uniformSize ? uniformSize : view.getUint32(track.stsz + 12 + index * 4));

    const chunkCount = view.getUint32((track.co64 >= 0 ? track.co64 : track.stco) + 4);
    const chunkOffset = (index) => (track.co64 >= 0
        ? view.getUint32(track.co64 + 8 + index * 8) * 4294967296 + view.getUint32(track.co64 + 12 + index * 8)
        : view.getUint32(track.stco + 8 + index * 4));

    const stscCount = view.getUint32(track.stsc + 4);
    const stscEntry = (index) => ({
        firstChunk: view.getUint32(track.stsc + 8 + index * 12),
        samplesPerChunk: view.getUint32(track.stsc + 12 + index * 12),
    });

    const packets = [];
    let stscIndex = 0;
    let sampleIndex = 0;
    for (let chunk = 0; chunk < chunkCount && sampleIndex < sampleCount; chunk++) {
        while (stscIndex + 1 < stscCount && stscEntry(stscIndex + 1).firstChunk <= chunk + 1) stscIndex++;
        const perChunk = stscEntry(stscIndex).samplesPerChunk;
        let offset = chunkOffset(chunk);
        for (let s = 0; s < perChunk && sampleIndex < sampleCount; s++, sampleIndex++) {
            const size = sizeOf(sampleIndex);
            if (offset + size > bytes.length) throw alacError('ALAC packet lies outside the file.');
            packets.push({ offset, size });
            offset += size;
        }
    }
    if (packets.length !== sampleCount) throw alacError('ALAC sample tables disagree with each other.');
    return packets;
}

// ─── Entry point ──────────────────────────────────────────────────────────

/**
 * Decode ALAC audio out of an MP4/M4A file.
 *
 * @param {Uint8Array} bytes the whole file
 * @returns {null | { sampleRate, channels: Float32Array[], frames, bitDepth }}
 *   null when the file's audio track is not ALAC; throws when it is ALAC but
 *   cannot be decoded.
 */
export function decodeAlacFromMp4(bytes) {
    const track = findAlacTrack(bytes);
    if (!track) return null;

    const cookie = parseAlacCookie(bytes, track.cookieAt);
    const packets = packetRanges(bytes, track);
    if (!packets.length) throw alacError('ALAC track contains no audio packets.');

    const scratch = {
        mix: Array.from({ length: cookie.numChannels }, () => new Int32Array(cookie.frameLength)),
        err: new Int32Array(cookie.frameLength),
    };
    const capacity = packets.length * cookie.frameLength;
    const channels = Array.from({ length: cookie.numChannels }, () => new Float32Array(capacity));
    const scale = 1 / 2 ** (cookie.bitDepth - 1);

    let frames = 0;
    for (const packet of packets) {
        const reader = new BitReader(bytes, packet.offset, packet.offset + packet.size);
        const samples = decodePacket(reader, cookie, scratch);
        for (let c = 0; c < cookie.numChannels; c++) {
            const mixed = scratch.mix[c];
            const out = channels[c];
            for (let i = 0; i < samples; i++) out[frames + i] = mixed[i] * scale;
        }
        frames += samples;
    }

    return {
        sampleRate: cookie.sampleRate || 0,
        channels: channels.map((data) => data.subarray(0, frames)),
        frames,
        bitDepth: cookie.bitDepth,
    };
}
