// WAV export of what the audio strip plays (#92): the range, the source (or
// two, as the left and right channels of the file), Remove DC and the gain
// that puts the peak at −1 dBFS — what is heard — at the signal's own sample
// rate, not the browser's.
//
// The samples come from the strip's own kernel (src/utils/audio-samples.js)
// and are written chunk by chunk (src/utils/wav-encode.js) into a Blob made
// of parts: two passes over the rows of the range (_audioVisitRange), the
// first to count them and find the mean and the peak, the second to write
// them. A file in memory-saving mode is read from the file in both — every
// row of the range, streamed, never the overview and never all of it at once
// — so the file is not bound by one buffer, and its bytes are the bytes the
// same file gives from memory (scripts/test-lazy-audio.mjs).
//
// The dialog's half (the options block, the size estimate) is in
// src/ui/plot-export-dialog.js; the wiring, the progress and Cancel in
// export-methods.js. This module draws nothing, so a test runs it in Node.

import i18n from '../../i18n/index.js';
import { createAudioScan, finishAudioScan, scanAudioChunk, writeAudioChunk } from '../../utils/audio-samples.js';
import { createWavWriter, wavFileBytes, wavSampleRate, WAV_MAX_BYTES } from '../../utils/wav-encode.js';
import { MIN_RANGE_SECONDS } from './audio-methods.js';

export function installPlotAudioWavMethods(TargetClass) {
    const proto = TargetClass.prototype;

    /**
     * What the dialog offers for WAV in this panel, or why it cannot: the
     * playable traces, which one sounds now, a Left/Right pair of the same
     * recording when there is one, and the range the strip plays.
     */
    proto._wavExportPlan = function(plot) {
        const modes = ['timeseries', 'fft', 'histogram', 'integral'];
        if (!plot || !this._hasContent(plot)) return { blockedReason: i18n.t('audioReasonNoTraces') };
        if (!modes.includes(plot.mode)) return { blockedReason: i18n.t('exportWavUnavailableMode') };
        const sources = this._audioSources(plot).filter(source => source.status.ok);
        if (!sources.length) {
            return { blockedReason: `${i18n.t('exportWavUnavailable')} ${this._audioButtonTitle(plot)}` };
        }
        const selected = this._audioSelectedSource(plot);
        const source = selected?.status?.ok ? selected : sources[0];

        // Left and Right of one recording, as the parser marks them.
        let pair = null;
        const byFile = new Map();
        for (const candidate of sources) {
            const index = this.files.get(candidate.fileId)?.data?.variables?.[candidate.varName]?.audio?.channelIndex;
            if (index !== 0 && index !== 1) continue;
            if (!byFile.has(candidate.fileId)) byFile.set(candidate.fileId, []);
            byFile.get(candidate.fileId)[index] = candidate;
        }
        const preferred = byFile.get(source.fileId);
        const found = preferred?.[0] && preferred?.[1] ? preferred : [...byFile.values()].find(entry => entry[0] && entry[1]);
        if (found) pair = { left: found[0].key, right: found[1].key };

        const range = this._audioRange(plot, source);
        return {
            blockedReason: '',
            sources: sources.map(entry => ({ key: entry.key, label: entry.label, color: entry.color, fileId: entry.fileId })),
            source: source.key,
            channels: 'mono',
            left: pair?.left || source.key,
            right: pair?.right || (sources.find(entry => entry.key !== source.key && entry.fileId === source.fileId) || source).key,
            pair: !!pair,
            range,
            rangeLabel: this._wavRangeLabel(plot, range),
        };
    };

    /** What the range is, in words: whose it is and where it runs. */
    proto._wavRangeLabel = function(plot, range) {
        if (!range) return '';
        const fmt = (value) => i18n.formatNumber(Number(value.toFixed(3)));
        const span = `${fmt(range[0])} – ${fmt(range[1])} s`;
        if (plot.mode !== 'timeseries') return i18n.t('exportWavRangeSelection').replace('{range}', span);
        return i18n.t(this._audioWindowMode(plot) === 'visible' ? 'exportWavRangeVisible' : 'exportWavRangeAll').replace('{range}', span);
    };

    /** The sources a choice names, in channel order. */
    proto._wavChosenSources = function(plot, choice) {
        const sources = this._audioSources(plot).filter(source => source.status.ok);
        const keys = choice?.channels === 'stereo' ? [choice.left, choice.right] : [choice?.source];
        return keys.map(key => sources.find(source => source.key === key) || null);
    };

    /**
     * The file's size before it is written, from the range and the rate, or
     * why it cannot be written: a pair from two files, a range too short, a
     * file past the 4 GB a WAV can hold.
     */
    proto._wavEstimate = function(plot, choice) {
        const chosen = this._wavChosenSources(plot, choice);
        if (chosen.some(source => !source)) return { blockedReason: i18n.t('exportWavUnavailable') };
        if (chosen.length === 2 && chosen[0].fileId !== chosen[1].fileId) {
            return { blockedReason: i18n.t('exportWavChannelsFiles') };
        }
        const range = this._audioRange(plot, chosen[0]);
        if (!range) return { blockedReason: i18n.t('exportWavUnavailable') };
        const seconds = range[1] - range[0];
        if (seconds < MIN_RANGE_SECONDS) {
            return { blockedReason: this._audioBuildErrorText?.(plot, 'rangeTooShort') || i18n.t('audioRangeTooShort') };
        }
        const rate = Number(chosen[0].status.sampleRate);
        const known = Number.isFinite(rate) && rate > 0;
        const frames = known ? Math.round(seconds * rate) + 1 : NaN;
        const bytes = known ? wavFileBytes({ frames, channels: chosen.length, format: choice.encoding }) : NaN;
        if (bytes > WAV_MAX_BYTES) return { blockedReason: i18n.t('exportWavTooLarge'), bytes, frames, sampleRate: rate };
        return { blockedReason: '', bytes, frames, sampleRate: rate, seconds, channels: chosen.length };
    };

    /** The proposed name: file__signal__1.204-3.051s. */
    proto._wavBaseName = function(plot, choice) {
        const chosen = this._wavChosenSources(plot, choice).filter(Boolean);
        if (!chosen.length) return 'audio';
        const fileName = String(this.files.get(chosen[0].fileId)?.name || '').replace(/\.[^.]+$/, '');
        const signals = chosen.map(source => source.varName).join('_');
        const range = this._audioRange(plot, chosen[0]);
        const span = range ? `${range[0].toFixed(3)}-${range[1].toFixed(3)}s` : '';
        return [fileName, signals, span].filter(Boolean).join('__');
    };

    /**
     * Write the WAV: two passes over the rows of the range, from memory or
     * from the file. Resolves to `{ blob, info, clipped }`, or `{ error }` with
     * a reason the strip's messages name; an AbortError when `signal` aborts.
     * `onProgress({ pass, rows, frames })` follows the work.
     */
    proto._writeWav = async function(plot, choice, { signal = null, onProgress = null, chunkRows } = {}) {
        const chosen = this._wavChosenSources(plot, choice);
        if (chosen.some(source => !source)) return { error: 'readFailed' };
        if (chosen.length === 2 && chosen[0].fileId !== chosen[1].fileId) return { error: 'channelsFiles' };
        const fileId = chosen[0].fileId;
        const varNames = chosen.map(source => source.varName);
        const range = this._audioRange(plot, chosen[0]);
        if (!range) return { error: 'readFailed' };
        const removeDC = this._ensureAudioState(plot).removeDC !== false;
        const channels = varNames.length;

        try {
            const scan = createAudioScan(channels);
            await this._audioVisitRange(fileId, varNames, range, (time, values) => {
                scanAudioChunk(scan, time, values);
            }, { signal, chunkRows, onRows: rows => onProgress?.({ pass: 1, rows }) });
            const info = finishAudioScan(scan, { removeDC });
            if (!info.ok) return { error: info.reason || 'nonUniform', info };
            if (info.duration < MIN_RANGE_SECONDS) return { error: 'rangeTooShort', info };

            const writer = createWavWriter({ sampleRate: info.sampleRate, channels, format: choice.encoding, frames: info.frames });
            let at = 0;
            let clipped = 0;
            await this._audioVisitRange(fileId, varNames, range, (time, values) => {
                const n = time.length;
                if (at + n > info.frames) throw Object.assign(new Error('changed'), { audioReason: 'fileChanged' });
                const outs = values.map(() => new Float32Array(n));
                clipped += writeAudioChunk(info, values, at, outs);
                writer.write(outs);
                at += n;
            }, { signal, chunkRows, onRows: rows => onProgress?.({ pass: 2, rows, frames: info.frames }) });
            if (at !== info.frames) return { error: 'fileChanged', info };
            return { blob: writer.blob(), info, clipped, sampleRate: wavSampleRate(info.sampleRate) };
        } catch (error) {
            if (error?.audioReason) return { error: error.audioReason };
            if (error?.wavReason === 'tooLarge') return { error: 'tooLarge' };
            throw error;
        }
    };

    /** A failed write, in words. */
    proto._wavErrorText = function(plot, error) {
        switch (error) {
            case 'channelsFiles': return i18n.t('exportWavChannelsFiles');
            case 'channelsGrid': return i18n.t('exportWavChannelsGrid');
            case 'tooLarge': return i18n.t('exportWavTooLarge');
            case 'fileChanged': return i18n.t('exportWavFileChanged');
            default: return this._audioBuildErrorText?.(plot, error) || i18n.t('exportWavUnavailable');
        }
    };
}
