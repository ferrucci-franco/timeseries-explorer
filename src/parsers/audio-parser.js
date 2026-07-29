// An audio recording, seen as what it is: one numeric signal per channel,
// sampled at a fixed rate.
//
// Nothing here decodes anything — src/parsers/audio-decode.js does that, and it
// is deliberately a separate step. The app has to know what the decoded audio
// will cost in memory before it is copied into columns, because a small file
// can decode into a very large one, and that question can only be asked between
// the two halves.
//
// The time axis is elapsed seconds from the start of the recording, built from
// the sample rate rather than read from the file: audio has no timestamps, only
// a rate, and a sample index divided by that rate is the exact time of the
// sample. It is a real Float64 column like every other parser produces — the
// app has no notion of an implied uniform axis.

import MatParser from './mat-parser.js';
import { formatTimeMagnitude } from '../utils/time-unit-format.js';

const FILE_INFO_NODE = 'Recording';

export default class AudioParser {
    constructor(structureParser) {
        // Shared normalisation (data-type detection, constant detection) lives
        // on the MAT parser; every format parser borrows it.
        this.structureParser = structureParser || new MatParser();
    }

    /**
     * @param {{ sampleRate, channels: Float32Array[], frames, ... }} decoded
     *   the output of decodeAudioFile.
     */
    parse(decoded, filename = '') {
        if (!decoded?.frames || !decoded.channels?.length) {
            const err = new Error('The audio file decoded to no samples.');
            err.code = 'AUDIO_EMPTY';
            throw err;
        }

        const sampleRate = Number(decoded.sampleRate) || 0;
        if (!(sampleRate > 0)) {
            const err = new Error('The audio file has no usable sample rate.');
            err.code = 'AUDIO_DECODE_FAILED';
            throw err;
        }

        const frames = decoded.frames;
        const channelCount = decoded.channels.length;
        const duration = frames / sampleRate;

        const result = {
            filename,
            metadata: {
                format: 'audio',
                source: 'audio',
                audio: {
                    sampleRate,
                    channelCount,
                    frames,
                    duration,
                    container: decoded.container || '',
                    containerLabel: decoded.containerLabel || '',
                    codec: decoded.codec || '',
                    bitDepth: Number(decoded.bitDepth) || 0,
                    // True when the browser handed the samples back at a rate
                    // other than the file's own. The duration is unaffected;
                    // only the number of samples behind it changed.
                    resampled: decoded.resampled === true,
                    declaredSampleRate: Number(decoded.declaredSampleRate) || 0,
                },
            },
            variables: {},
            tree: rootNode(),
        };

        const timeVariable = this._timeVariable(frames, sampleRate);
        result.variables[timeVariable.name] = timeVariable;
        result.tree._variables[timeVariable.name] = timeVariable;

        const names = channelNames(channelCount);
        for (let index = 0; index < channelCount; index++) {
            const variable = this._channelVariable(names[index], decoded.channels[index], frames, index, channelCount);
            result.variables[variable.name] = variable;
            result.tree._variables[variable.name] = variable;
        }

        this._addRecordingInfo(result.tree, result.metadata.audio, filename);

        result.metadata.numVariables = Object.keys(result.variables).length;
        result.metadata.numParams = 0;
        result.metadata.numTimevarying = channelCount;
        result.metadata.numTimesteps = frames;
        result.metadata.rowCount = frames;
        result.metadata.columnCount = channelCount;
        result.metadata.timeName = timeVariable.name;
        result.metadata.timeKind = 'numeric';
        result.metadata.timeDisplayMode = 'numeric';
        result.metadata.timeOriginMs = null;
        result.metadata.timeStart = 0;
        result.metadata.timeEnd = frames ? (frames - 1) / sampleRate : 0;
        result.metadata.datetimeAxisStalled = false;
        return result;
    }

    _timeVariable(frames, sampleRate) {
        // i / rate rather than an accumulated i * step: an accumulator drifts
        // by a sample or more over the tens of millions of steps an ordinary
        // recording contains.
        const values = new Float64Array(frames);
        for (let i = 0; i < frames; i++) values[i] = i / sampleRate;
        return {
            name: 'time',
            data: values,
            // The unit lives INSIDE the description, in brackets. That is the
            // app's only channel for it — PlotManager._extractUnit reads
            // `[...]` out of this string, and nothing anywhere reads a `units`
            // property. Without it the axis title loses its "[s]" whenever the
            // panel has not already resolved to seconds, and the FFT frequency
            // axis falls back to "1/x-unit" instead of saying Hz.
            description: 'Elapsed time from the start of the recording [s]',
            kind: 'abscissa',
            dataType: 'real',
            isConstant: false,
            interpolation: 'linear',
            negate: false,
            source: 'audio',
            timeKind: 'numeric',
            timeDisplayMode: 'numeric',
        };
    }

    _channelVariable(name, samples, frames, index, channelCount) {
        const data = new Float64Array(frames);
        for (let i = 0; i < frames; i++) data[i] = samples[i];
        return {
            name,
            data,
            // No unit in brackets, deliberately: a normalised waveform is
            // dimensionless, and inventing one would put it on the Y axis title.
            description: channelCount > 1
                ? `Audio channel ${index + 1} of ${channelCount}, amplitude normalised to -1…1`
                : 'Audio waveform, amplitude normalised to -1…1',
            kind: 'variable',
            // Detection is skipped on purpose: a waveform is real-valued by
            // definition, and _detectDataType would walk tens of millions of
            // samples to conclude the same thing.
            dataType: 'real',
            isConstant: false,
            interpolation: 'linear',
            negate: false,
            source: 'audio',
            audio: { channelIndex: index },
        };
    }

    // What the recording is, as read-only entries in the tree. Same shape the
    // pickle reader uses for its own non-plottable notes: a parameter carrying
    // a string, which the sidebar shows and no plot can be built from.
    _addRecordingInfo(root, audio, filename) {
        const entries = [
            ['Sample rate', `${formatNumber(audio.sampleRate)} Hz`],
            // The same fact as the sample rate, the way the time axis states it.
            // Printed through the shared seconds ladder so it reads exactly as
            // the "Sampling of time" panel behind the clock icon does — that
            // panel measures Δt off this very vector, and a reader who saw
            // "20.8333 µs" there and "2.08333e-5 s" here would have no way to
            // tell they are the same number.
            ['Sampling time', formatTimeMagnitude(1 / audio.sampleRate)],
            // Never a bare number: the sidebar runs a parameter's value through
            // Number() and a plain "1" comes back rendered as "1.00000".
            ['Channels', channelCountLabel(audio.channelCount)],
            ['Duration', formatDuration(audio.duration)],
            ['Samples per channel', formatNumber(audio.frames)],
            ['Format', [audio.containerLabel, audio.codec].filter(Boolean).join(' · ') || 'unknown'],
        ];
        if (audio.bitDepth > 0) entries.push(['Bit depth', `${audio.bitDepth}-bit`]);
        if (audio.resampled && audio.declaredSampleRate > 0) {
            entries.push(['Original sample rate', `${formatNumber(audio.declaredSampleRate)} Hz (resampled on decode)`]);
        }

        const node = {
            _type: 'component',
            _name: FILE_INFO_NODE,
            _fullName: FILE_INFO_NODE,
            _children: {},
            _variables: {},
        };
        for (const [label, value] of entries) {
            node._variables[label] = {
                name: `audio:@info/${encodeURIComponent(label)}`,
                displayName: label,
                data: [value],
                description: `${label}: ${value}${filename ? ` — ${filename}` : ''}`,
                kind: 'parameter',
                dataType: 'string',
                isConstant: true,
                interpolation: 'constant',
                negate: false,
                source: 'audio',
            };
        }
        root._children[FILE_INFO_NODE] = node;
    }
}

/**
 * Channel labels. Left/Right for stereo because that is what every listener and
 * every editor calls them; Ch1…ChN above two, where "left" stops meaning
 * anything and a number is the only honest name.
 */
export function channelNames(count) {
    if (count === 1) return ['Mono'];
    if (count === 2) return ['Left', 'Right'];
    return Array.from({ length: count }, (_, i) => `Ch${i + 1}`);
}

function channelCountLabel(count) {
    if (count === 1) return '1 (mono)';
    if (count === 2) return '2 (stereo)';
    return `${count} (multichannel)`;
}

function rootNode() {
    return { _type: 'root', _name: '', _children: {}, _variables: {} };
}

function formatNumber(value) {
    return Number(value || 0).toLocaleString('en-US');
}

function formatDuration(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total - hours * 3600 - minutes * 60;
    const secondsText = rest.toFixed(2).padStart(5, '0');
    if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${secondsText}`;
    return `${minutes}:${secondsText}`;
}
