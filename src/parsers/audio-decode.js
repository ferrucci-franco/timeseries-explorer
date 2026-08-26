// Turning an audio file into sample arrays.
//
// Two decoders, chosen by what the file actually is:
//
//   * WAV is decoded here, in plain JavaScript. It is the format people convert
//     to when anything else fails, so it has to work everywhere the app runs —
//     including Node, where the tests live and where there is no audio engine
//     at all. PCM 8/16/24/32-bit, 32/64-bit float and G.711 A-law/mu-law are
//     covered, which is everything a recorder or an export dialog emits.
//
//   * Everything else (MP3, M4A/AAC, FLAC, Ogg/Opus, 3GP, CAF, WebM…) goes to
//     the browser's own decoder through decodeAudioData. Bundling an MP3 or AAC
//     decoder would add megabytes to duplicate something every browser and
//     every Electron build already ships.
//
// decodeAudioData resamples to the sample rate of the context it is called on,
// and the context's default rate is the sound card's, not the file's. So the
// container header is read first and the context created at the file's own
// rate. Getting that wrong costs resolution, never correctness: the decoded
// audio keeps its duration either way, so the time axis stays right even when
// the header could not be read at all.
//
// Web Audio does not exist inside a Worker, which is why audio is the one
// format the app decodes on the main thread. The expensive part — the codec
// itself — runs on the browser's own thread regardless, and the JavaScript left
// here is a deinterleaving loop.

import { decodeAlacFromMp4 } from './alac-decoder.js';

// Chrome's own bounds for an AudioContext sample rate. A header that claims
// something outside them is not usable as a context rate, whatever it means.
const MIN_CONTEXT_SAMPLE_RATE = 3000;
const MAX_CONTEXT_SAMPLE_RATE = 768000;
const FALLBACK_SAMPLE_RATE = 48000;

// WAVE format tags.
const WAVE_PCM = 0x0001;
const WAVE_IEEE_FLOAT = 0x0003;
const WAVE_ALAW = 0x0006;
const WAVE_MULAW = 0x0007;
const WAVE_EXTENSIBLE = 0xfffe;

const MPEG_SAMPLE_RATES = {
    3: [44100, 48000, 32000],   // MPEG 1
    2: [22050, 24000, 16000],   // MPEG 2
    0: [11025, 12000, 8000],    // MPEG 2.5
};

export function audioError(code, message, detail = {}) {
    const err = new Error(message);
    err.code = code;
    Object.assign(err, detail);
    return err;
}

export function toUint8Array(buffer) {
    if (buffer instanceof Uint8Array) return buffer;
    if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return new Uint8Array(buffer || new ArrayBuffer(0));
}

function fourCC(bytes, offset) {
    if (offset + 4 > bytes.length) return '';
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function matches(bytes, offset, text) {
    return fourCC(bytes, offset) === text;
}

function viewOf(bytes) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function usableSampleRate(rate) {
    const value = Math.round(Number(rate) || 0);
    if (!Number.isFinite(value)) return 0;
    if (value < MIN_CONTEXT_SAMPLE_RATE || value > MAX_CONTEXT_SAMPLE_RATE) return 0;
    return value;
}

// ─── What is this file? ───────────────────────────────────────────────────

/**
 * Identify an audio container from its first bytes, and read whatever the
 * header cheaply says about the audio inside it.
 *
 * @returns {null | {
 *   container: string, label: string, codec: string,
 *   sampleRate: number, channels: number, bitDepth: number,
 *   decodable: boolean,
 * }} null when the bytes are not audio we recognise. `decodable: false` marks
 *   the containers whose codec no browser ships (AMR), so the caller can say
 *   what to do instead of reporting a generic decode failure.
 */
export function sniffAudioFormat(buffer) {
    const bytes = toUint8Array(buffer);
    if (bytes.length < 12) return null;

    if ((matches(bytes, 0, 'RIFF') || matches(bytes, 0, 'RF64')) && matches(bytes, 8, 'WAVE')) {
        return { container: 'wav', label: 'WAV', decodable: true, ...readWavHeader(bytes) };
    }
    if (matches(bytes, 0, 'FORM') && (matches(bytes, 8, 'AIFF') || matches(bytes, 8, 'AIFC'))) {
        return { container: 'aiff', label: 'AIFF', codec: 'PCM', decodable: true, ...readAiffHeader(bytes) };
    }
    if (matches(bytes, 0, 'fLaC')) {
        return { container: 'flac', label: 'FLAC', codec: 'FLAC', decodable: true, ...readFlacStreamInfo(bytes, 4) };
    }
    if (matches(bytes, 0, 'OggS')) {
        return { container: 'ogg', label: 'Ogg', decodable: true, ...readOggHeader(bytes) };
    }
    if (matches(bytes, 0, 'caff')) {
        return { container: 'caf', label: 'CAF', codec: '', decodable: true, ...readCafHeader(bytes) };
    }
    if (matches(bytes, 4, 'ftyp')) {
        const brand = fourCC(bytes, 8);
        const threeGpp = /^3g/i.test(brand);
        return {
            container: threeGpp ? '3gp' : 'mp4',
            label: threeGpp ? '3GP' : 'MP4 / M4A',
            decodable: true,
            codec: '',
            ...readMp4AudioTrack(bytes),
        };
    }
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
        // Matroska/WebM headers put the sample rate deep inside the track
        // entries; the browser reads it correctly on its own, so leaving the
        // rate unknown here only means the context is created at its default.
        return { container: 'webm', label: 'WebM / Matroska', codec: '', sampleRate: 0, channels: 0, bitDepth: 0, decodable: true };
    }
    if (matches(bytes, 0, '#!AM')) {
        const wideband = String.fromCharCode(...bytes.subarray(0, 9)) === '#!AMR-WB\n';
        return {
            container: 'amr',
            label: wideband ? 'AMR-WB' : 'AMR',
            codec: wideband ? 'AMR-WB' : 'AMR-NB',
            sampleRate: wideband ? 16000 : 8000,
            channels: 1,
            bitDepth: 0,
            // No browser ships an AMR decoder. Saying so up front beats letting
            // decodeAudioData fail with "Unable to decode audio data".
            decodable: false,
        };
    }
    const mpeg = readMpegFrameHeader(bytes);
    if (mpeg) return { container: 'mp3', label: 'MP3', decodable: true, ...mpeg };

    return null;
}

// ─── Container headers ────────────────────────────────────────────────────

// Walks the RIFF chunk list. Also returns where the samples are, so the WAV
// decoder does not have to walk it a second time.
function readWavChunks(bytes) {
    const view = viewOf(bytes);
    const out = { sampleRate: 0, channels: 0, bitDepth: 0, codec: '', formatTag: 0, dataStart: 0, dataLength: 0, blockAlign: 0 };
    // RF64 stores the real data size in a ds64 chunk because the 32-bit field
    // cannot hold it.
    let rf64DataLength = -1;
    let offset = 12;
    while (offset + 8 <= bytes.length) {
        const id = fourCC(bytes, offset);
        let size = view.getUint32(offset + 4, true);
        const body = offset + 8;
        if (id === 'ds64' && body + 20 <= bytes.length) {
            const lo = view.getUint32(body + 8, true);
            const hi = view.getUint32(body + 12, true);
            rf64DataLength = hi * 4294967296 + lo;
        } else if (id === 'fmt ' && body + 16 <= bytes.length) {
            out.formatTag = view.getUint16(body, true);
            out.channels = view.getUint16(body + 2, true);
            out.sampleRate = view.getUint32(body + 4, true);
            out.blockAlign = view.getUint16(body + 12, true);
            out.bitDepth = view.getUint16(body + 14, true);
            if (out.formatTag === WAVE_EXTENSIBLE && body + 26 <= bytes.length) {
                // The real format tag is the first two bytes of the SubFormat
                // GUID; the outer tag is only "look inside".
                out.formatTag = view.getUint16(body + 24, true);
            }
        } else if (id === 'data') {
            out.dataStart = body;
            // A streamed WAV can carry 0xFFFFFFFF or 0 as the data size; the
            // rest of the file is the honest answer in that case.
            const declared = rf64DataLength >= 0 ? rf64DataLength : size;
            const available = bytes.length - body;
            out.dataLength = declared > 0 && declared <= available ? declared : available;
            break;
        }
        if (size <= 0) break;
        // Chunks are word-aligned: an odd size is followed by a pad byte.
        offset = body + size + (size % 2);
    }
    out.codec = wavCodecLabel(out.formatTag, out.bitDepth);
    return out;
}

function readWavHeader(bytes) {
    const chunks = readWavChunks(bytes);
    return { sampleRate: chunks.sampleRate, channels: chunks.channels, bitDepth: chunks.bitDepth, codec: chunks.codec };
}

function wavCodecLabel(formatTag, bitDepth) {
    if (formatTag === WAVE_IEEE_FLOAT) return `PCM float ${bitDepth}-bit`;
    if (formatTag === WAVE_ALAW) return 'G.711 A-law';
    if (formatTag === WAVE_MULAW) return 'G.711 mu-law';
    if (formatTag === WAVE_PCM) return `PCM ${bitDepth}-bit`;
    return formatTag ? `WAVE format 0x${formatTag.toString(16)}` : '';
}

function readAiffHeader(bytes) {
    const view = viewOf(bytes);
    let offset = 12;
    while (offset + 8 <= bytes.length) {
        const id = fourCC(bytes, offset);
        const size = view.getUint32(offset + 4);
        const body = offset + 8;
        if (id === 'COMM' && body + 18 <= bytes.length) {
            return {
                channels: view.getUint16(body),
                bitDepth: view.getUint16(body + 6),
                sampleRate: readExtendedFloat80(view, body + 8),
            };
        }
        if (size <= 0) break;
        offset = body + size + (size % 2);
    }
    return { sampleRate: 0, channels: 0, bitDepth: 0 };
}

// AIFF stores its sample rate as an 80-bit IEEE extended float, which no
// JavaScript type maps onto. Only the integral range matters here.
function readExtendedFloat80(view, offset) {
    const exponent = view.getUint16(offset);
    const hi = view.getUint32(offset + 2);
    const lo = view.getUint32(offset + 6);
    const sign = exponent & 0x8000 ? -1 : 1;
    const e = (exponent & 0x7fff) - 16383;
    const mantissa = hi * 4294967296 + lo;
    if (!mantissa) return 0;
    return Math.round(sign * mantissa * Math.pow(2, e - 63));
}

function readFlacStreamInfo(bytes, offset) {
    // Metadata block header: 1 flag/type byte + 3 length bytes, then
    // STREAMINFO, whose sample rate starts 10 bytes in and is 20 bits wide.
    const info = offset + 4;
    if (info + 14 > bytes.length) return { sampleRate: 0, channels: 0, bitDepth: 0 };
    const sampleRate = (bytes[info + 10] << 12) | (bytes[info + 11] << 4) | (bytes[info + 12] >> 4);
    const channels = ((bytes[info + 12] >> 1) & 0x07) + 1;
    const bitDepth = ((((bytes[info + 12] & 0x01) << 4) | (bytes[info + 13] >> 4)) & 0x1f) + 1;
    return { sampleRate, channels, bitDepth };
}

function readOggHeader(bytes) {
    const view = viewOf(bytes);
    if (bytes.length < 28) return { sampleRate: 0, channels: 0, bitDepth: 0, codec: '' };
    const segmentCount = bytes[26];
    const packet = 27 + segmentCount;
    if (packet + 16 > bytes.length) return { sampleRate: 0, channels: 0, bitDepth: 0, codec: '' };

    if (fourCC(bytes, packet) === 'Opus' && fourCC(bytes, packet + 4) === 'Head') {
        // Opus always decodes at 48 kHz whatever the input rate recorded here.
        return { sampleRate: 48000, channels: bytes[packet + 9], bitDepth: 0, codec: 'Opus' };
    }
    if (bytes[packet] === 0x01 && fourCC(bytes, packet + 1) === 'vorb') {
        return {
            sampleRate: view.getUint32(packet + 12, true),
            channels: bytes[packet + 11],
            bitDepth: 0,
            codec: 'Vorbis',
        };
    }
    if (bytes[packet] === 0x7f && fourCC(bytes, packet + 1) === 'FLAC') {
        // FLAC-in-Ogg: the native 'fLaC' stream starts inside this packet.
        const native = packet + 9;
        if (matches(bytes, native, 'fLaC')) {
            return { codec: 'FLAC', ...readFlacStreamInfo(bytes, native + 4) };
        }
    }
    return { sampleRate: 0, channels: 0, bitDepth: 0, codec: '' };
}

function readCafHeader(bytes) {
    const view = viewOf(bytes);
    let offset = 8;
    while (offset + 12 <= bytes.length) {
        const type = fourCC(bytes, offset);
        const hi = view.getUint32(offset + 4);
        const lo = view.getUint32(offset + 8);
        const size = hi * 4294967296 + lo;
        const body = offset + 12;
        if (type === 'desc' && body + 32 <= bytes.length) {
            return {
                sampleRate: Math.round(view.getFloat64(body)),
                channels: view.getUint32(body + 24),
                bitDepth: view.getUint32(body + 28),
                codec: fourCC(bytes, body + 8).trim(),
            };
        }
        if (!(size > 0)) break;
        offset = body + size;
    }
    return { sampleRate: 0, channels: 0, bitDepth: 0, codec: '' };
}

// Walks one level of the ISO base-media box tree. `visit` returning false stops
// the walk, which is how the search leaves `moov` once it has what it needs.
function walkMp4Boxes(bytes, view, start, end, visit) {
    let offset = start;
    while (offset + 8 <= end) {
        let size = view.getUint32(offset);
        const type = fourCC(bytes, offset + 4);
        let headerSize = 8;
        if (size === 1) {
            if (offset + 16 > end) return true;
            size = view.getUint32(offset + 8) * 4294967296 + view.getUint32(offset + 12);
            headerSize = 16;
        } else if (size === 0) {
            size = end - offset;
        }
        if (size < headerSize || offset + size > end) return true;
        if (visit(type, offset + headerSize, offset + size) === false) return false;
        offset += size;
    }
    return true;
}

function readMp4AudioTrack(bytes) {
    const view = viewOf(bytes);
    const found = { sampleRate: 0, channels: 0, bitDepth: 0, codec: '' };
    walkMp4Boxes(bytes, view, 0, bytes.length, (type, start, end) => {
        if (type !== 'moov') return;
        walkMp4Boxes(bytes, view, start, end, (trackType, trackStart, trackEnd) => {
            if (trackType !== 'trak') return;
            const track = { isAudio: false, sampleRate: 0, channels: 0, bitDepth: 0, codec: '' };
            walkMp4Boxes(bytes, view, trackStart, trackEnd, (mediaType, mediaStart, mediaEnd) => {
                if (mediaType !== 'mdia') return;
                walkMp4Boxes(bytes, view, mediaStart, mediaEnd, (t, s, e) => {
                    if (t === 'hdlr') {
                        track.isAudio = fourCC(bytes, s + 8) === 'soun';
                    } else if (t === 'mdhd') {
                        // For an audio track the media timescale IS the sample
                        // rate, and it is stored more reliably than the 16.16
                        // field in the sample description.
                        const version = bytes[s];
                        track.sampleRate = version === 1 ? view.getUint32(s + 20) : view.getUint32(s + 12);
                    } else if (t === 'minf') {
                        walkMp4Boxes(bytes, view, s, e, (t2, s2, e2) => {
                            if (t2 !== 'stbl') return;
                            walkMp4Boxes(bytes, view, s2, e2, (t3, s3) => {
                                if (t3 !== 'stsd') return;
                                const entry = s3 + 8;
                                if (entry + 36 > bytes.length) return;
                                track.codec = fourCC(bytes, entry + 4).trim();
                                track.channels = view.getUint16(entry + 24);
                                track.bitDepth = view.getUint16(entry + 26);
                                if (!track.sampleRate) track.sampleRate = view.getUint16(entry + 32);
                            });
                        });
                    }
                });
            });
            if (track.isAudio) {
                found.sampleRate = track.sampleRate;
                found.channels = track.channels;
                found.bitDepth = track.bitDepth;
                found.codec = track.codec;
                return false;
            }
        });
        return false;
    });
    return found;
}

// Finds the first MPEG audio frame header, past any ID3v2 tag. Returns null
// when the bytes are not MPEG audio, which is also how the sniffer tells an
// unrecognised file from an untagged MP3.
function readMpegFrameHeader(bytes) {
    let start = 0;
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes.length > 10) {
        // ID3v2 sizes are syncsafe: seven bits per byte.
        const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
        start = 10 + size;
    }
    // A tag can be followed by padding, so scan rather than trust the offset.
    const limit = Math.min(bytes.length - 4, start + 8192);
    for (let i = start; i <= limit; i++) {
        if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
        const versionBits = (bytes[i + 1] >> 3) & 0x03;
        const layerBits = (bytes[i + 1] >> 1) & 0x03;
        const rateIndex = (bytes[i + 2] >> 2) & 0x03;
        // versionBits 1 and layerBits 0 are reserved; rateIndex 3 is invalid.
        if (versionBits === 1 || layerBits === 0 || rateIndex === 3) continue;
        const rates = MPEG_SAMPLE_RATES[versionBits];
        if (!rates) continue;
        const channelMode = (bytes[i + 3] >> 6) & 0x03;
        return {
            sampleRate: rates[rateIndex],
            channels: channelMode === 3 ? 1 : 2,
            bitDepth: 0,
            codec: `MPEG Layer ${4 - layerBits}`,
        };
    }
    return null;
}

// ─── WAV, decoded here ────────────────────────────────────────────────────

/**
 * Decode a RIFF/WAVE (or RF64) file to one Float32Array per channel.
 * @returns {{ sampleRate, channels: Float32Array[], frames, codec, bitDepth }}
 */
export function decodeWav(buffer) {
    const bytes = toUint8Array(buffer);
    const header = readWavChunks(bytes);
    if (!header.channels || !header.sampleRate) {
        throw audioError('AUDIO_DECODE_FAILED', 'WAV file has no readable format chunk.', { format: 'WAV' });
    }
    if (!header.dataStart || header.dataLength <= 0) {
        throw audioError('AUDIO_EMPTY', 'WAV file contains no audio samples.', { format: 'WAV' });
    }

    const read = wavSampleReader(header);
    const bytesPerSample = read.bytesPerSample;
    const channelCount = header.channels;
    const stride = header.blockAlign || bytesPerSample * channelCount;
    const frames = Math.floor(header.dataLength / stride);
    if (frames <= 0) {
        throw audioError('AUDIO_EMPTY', 'WAV file contains no audio samples.', { format: 'WAV' });
    }

    const view = viewOf(bytes);
    const channels = [];
    for (let c = 0; c < channelCount; c++) channels.push(new Float32Array(frames));
    for (let frame = 0; frame < frames; frame++) {
        const base = header.dataStart + frame * stride;
        for (let c = 0; c < channelCount; c++) {
            channels[c][frame] = read.sample(view, bytes, base + c * bytesPerSample);
        }
    }

    return {
        sampleRate: header.sampleRate,
        channels,
        frames,
        codec: header.codec,
        bitDepth: header.bitDepth,
    };
}

// Picks the per-sample reader for a WAVE format tag + bit depth, normalising to
// the -1..1 range every other decoder in the world produces.
function wavSampleReader(header) {
    const { formatTag, bitDepth } = header;
    if (formatTag === WAVE_MULAW) {
        return { bytesPerSample: 1, sample: (_view, bytes, at) => expandMuLaw(bytes[at]) / 32768 };
    }
    if (formatTag === WAVE_ALAW) {
        return { bytesPerSample: 1, sample: (_view, bytes, at) => expandALaw(bytes[at]) / 32768 };
    }
    if (formatTag === WAVE_IEEE_FLOAT) {
        if (bitDepth === 32) return { bytesPerSample: 4, sample: (view, _b, at) => view.getFloat32(at, true) };
        if (bitDepth === 64) return { bytesPerSample: 8, sample: (view, _b, at) => view.getFloat64(at, true) };
        throw audioError('AUDIO_DECODE_FAILED', `Unsupported WAV float depth: ${bitDepth}-bit.`, { format: 'WAV' });
    }
    if (formatTag === WAVE_PCM) {
        // 8-bit PCM in WAV is unsigned, everything wider is signed. That is the
        // format's own inconsistency, not a choice made here.
        if (bitDepth === 8) return { bytesPerSample: 1, sample: (_v, bytes, at) => (bytes[at] - 128) / 128 };
        if (bitDepth === 16) return { bytesPerSample: 2, sample: (view, _b, at) => view.getInt16(at, true) / 32768 };
        if (bitDepth === 24) {
            return {
                bytesPerSample: 3,
                sample: (_v, bytes, at) => {
                    const raw = bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
                    // Sign-extend the 24th bit.
                    return ((raw << 8) >> 8) / 8388608;
                },
            };
        }
        if (bitDepth === 32) return { bytesPerSample: 4, sample: (view, _b, at) => view.getInt32(at, true) / 2147483648 };
        throw audioError('AUDIO_DECODE_FAILED', `Unsupported WAV bit depth: ${bitDepth}-bit.`, { format: 'WAV' });
    }
    throw audioError('AUDIO_DECODE_FAILED', `Unsupported WAV encoding (format 0x${(formatTag || 0).toString(16)}).`, { format: 'WAV' });
}

// G.711 expansion, as in the reference CCITT implementation.
function expandMuLaw(value) {
    const u = (~value) & 0xff;
    let t = ((u & 0x0f) << 3) + 0x84;
    t <<= (u & 0x70) >> 4;
    return (u & 0x80) ? (0x84 - t) : (t - 0x84);
}

function expandALaw(value) {
    const a = value ^ 0x55;
    let t = (a & 0x0f) << 4;
    const segment = (a & 0x70) >> 4;
    if (segment === 0) t += 8;
    else if (segment === 1) t += 0x108;
    else {
        t += 0x108;
        t <<= segment - 1;
    }
    return (a & 0x80) ? t : -t;
}

// ─── Everything else, decoded by the browser ──────────────────────────────

function offlineAudioContextClass() {
    return globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext || null;
}

/** Can this runtime decode compressed audio at all? False in Node. */
export function canDecodeCompressedAudio() {
    return !!offlineAudioContextClass();
}

async function decodeWithWebAudio(buffer, preferredSampleRate) {
    const ContextClass = offlineAudioContextClass();
    if (!ContextClass) {
        throw audioError('AUDIO_NO_DECODER', 'This runtime has no audio decoder for compressed formats.');
    }
    // A one-frame context: it is never rendered, it exists only to own
    // decodeAudioData and to fix the sample rate the result comes back at.
    const context = new ContextClass(1, 1, preferredSampleRate || FALLBACK_SAMPLE_RATE);
    // decodeAudioData detaches what it is given. The caller already handed over
    // a private copy for exactly that reason, so this can be consumed.
    const decoded = await new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn) => (value) => { if (!settled) { settled = true; fn(value); } };
        // Both the promise and the callback forms are honoured: Safari
        // implemented the callbacks long before the promise.
        let promise = null;
        try {
            promise = context.decodeAudioData(buffer, done(resolve), done(reject));
        } catch (err) {
            done(reject)(err);
            return;
        }
        if (promise?.then) promise.then(done(resolve), done(reject));
    });

    const channels = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
    return {
        sampleRate: decoded.sampleRate,
        channels,
        frames: decoded.length,
    };
}

/**
 * Decode any supported audio file to per-channel sample arrays.
 *
 * Kept separate from the parser so the app can measure what the decoded audio
 * will cost — and ask about it — before anything is copied into its columns.
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {{ decodeCompressed?: Function }} [options] `decodeCompressed` exists
 *   for tests: Node has no Web Audio, so a stub stands in for it there.
 */
export async function decodeAudioFile(buffer, options = {}) {
    const bytes = toUint8Array(buffer);
    if (!bytes.length) throw audioError('AUDIO_EMPTY', 'Audio file is empty.');

    const format = sniffAudioFormat(bytes);
    if (!format) throw audioError('AUDIO_UNRECOGNIZED', 'Not a recognised audio file.');
    if (format.decodable === false) {
        throw audioError('AUDIO_CODEC_UNAVAILABLE', `No decoder is available for ${format.label} audio.`, { format: format.label });
    }

    if (format.container === 'wav') {
        const decoded = decodeWav(bytes);
        return { ...describe(format, decoded), ...decoded, decodedBy: 'wav', resampled: false };
    }

    // Apple Lossless is the other codec decoded here rather than by the
    // browser: only Safari ships one, and an iPhone voice memo recorded with
    // the "Lossless" quality setting would otherwise not open at all. Being
    // lossless it also comes back bit-exact at the file's own rate, which the
    // resampling browser path cannot promise.
    if (format.container === 'mp4' && format.codec === 'alac') {
        try {
            const decoded = decodeAlacFromMp4(bytes);
            if (decoded?.frames && decoded.channels?.length) {
                return {
                    ...describe(format, decoded),
                    ...decoded,
                    codec: 'Apple Lossless (ALAC)',
                    decodedBy: 'alac',
                    resampled: false,
                };
            }
        } catch (err) {
            // Fall through to decodeAudioData: on Safari the native decoder
            // may still manage a file this one gave up on.
        }
    }

    const decodeCompressed = options.decodeCompressed || decodeWithWebAudio;
    const preferred = usableSampleRate(format.sampleRate);
    let decoded;
    try {
        // A private copy: decodeAudioData detaches it, and the app keeps the
        // original buffer alive for reloads, adjust-parsing and session saving.
        const detachable = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        decoded = await decodeCompressed(detachable, preferred || FALLBACK_SAMPLE_RATE, format);
    } catch (err) {
        if (err?.code === 'AUDIO_NO_DECODER') throw err;
        throw audioError('AUDIO_DECODE_FAILED', err?.message || `Could not decode ${format.label} audio.`, { format: format.label });
    }
    if (!decoded?.frames || !decoded.channels?.length) {
        throw audioError('AUDIO_EMPTY', 'The audio file decoded to no samples.', { format: format.label });
    }
    return {
        ...describe(format, decoded),
        ...decoded,
        decodedBy: 'webaudio',
        // Worth recording: it is the difference between "44100 Hz because the
        // file says so" and "48000 Hz because that is what this machine runs at".
        resampled: !!preferred && decoded.sampleRate !== preferred,
    };
}

function describe(format, decoded) {
    return {
        container: format.container,
        containerLabel: format.label,
        codec: format.codec || '',
        bitDepth: decoded.bitDepth ?? format.bitDepth ?? 0,
        declaredSampleRate: format.sampleRate || 0,
    };
}
