// The rows a range of a signal is heard from, wherever the file is held — and,
// for a file in memory-saving (lazy) mode, the samples of a range read from
// the file: every row in it, never the decimated overview in memory
// (CLAUDE.md, "Every analysis and data tool works in memory-saving mode").
//
// The audio strip (audio-methods.js) plays a lazy range from here, and the
// WAV export (audio-wav-methods.js) writes one. Both run the rows through the
// same kernel as a signal held in memory (src/utils/audio-samples.js): the
// eager path feeds it the arrays, the lazy path the chunks of a stream of the
// file (_lazyFitPass: the same query, transforms and cut on display time as
// every other lazy analysis), so a range sounds — and is written — the same
// either way, sample for sample (scripts/test-lazy-audio.mjs).
//
// Kept apart from the strip, which draws in the DOM, so a test can run these
// methods in Node on a real DuckDB-WASM engine.

import { createAudioScan, finishAudioScan, scanAudioChunk } from '../../utils/audio-samples.js';
import { audioRangeRows, audioSliceOf as sliceOf } from './audio-methods.js';

// Rows of a signal in memory handed to a visitor at a time: the size a lazy
// stream's chunks have, so a long export paints its progress either way.
const EAGER_CHUNK_ROWS = 262144;

/** An error that names the strip's reason for not playing a range. */
export function audioRangeError(reason) {
    return Object.assign(new Error(reason), { audioReason: reason });
}

function abortError() {
    const error = new Error('Cancelled');
    error.name = 'AbortError';
    return error;
}

export function installPlotAudioLazyMethods(TargetClass) {
    const proto = TargetClass.prototype;

    proto._audioIsLazy = function(fileId) {
        return !!this.files.get(fileId)?.data?._duckdb?.source;
    };

    /**
     * Whether a variable of a lazy file can be heard, from what is known
     * without reading it: a column the file query can read (a data tool's
     * output over the file counts; a formula computed over the overview
     * does not), a time axis in seconds, and a rate the audio output takes.
     *
     * The rate is the file's rows over its span. The overview cannot say
     * whether every step is the same — it is a sample of the rows — so that
     * is checked on the rows of the range when they are read
     * (finishAudioScan), and a range that is not uniform says so then.
     */
    proto._audioLazySourceStatus = function(fileId, varName, gate) {
        const data = this.files.get(fileId)?.data;
        const meta = data?._duckdb;
        const variable = data?.variables?.[varName];
        if (!meta?.source || !variable) return { ok: false, reason: 'noData' };
        if (!meta.source.hasSqlValue?.(variable) || variable.dataType === 'string') {
            return { ok: false, reason: 'lazyNoSource' };
        }
        if (this._fftTimeKind?.(fileId) !== 'numeric') return { ok: false, reason: 'timeAxis' };

        const overviewTimes = this._getTransformedTimeDataForVariable(fileId, varName);
        const span = this._audioLazySpan(fileId);
        let extent = span?.extent || null;
        if (!extent) {
            const n = overviewTimes?.length || 0;
            extent = n >= 2 ? [Number(overviewTimes[0]), Number(overviewTimes[n - 1])] : null;
        }
        if (!extent || !(extent[1] > extent[0])) return { ok: false, reason: 'tooFewSamples' };
        // The rows with a time — the ones a range is read from — as the load's
        // scan counted them; the table's row count otherwise. Unknown for a
        // file that was not counted: the gate is then left to the read.
        const timed = Number(data.metadata?.numTimesteps);
        const rows = Number.isFinite(timed) && timed > 0 ? timed : Number(meta.totalRows);
        const full = span?.full || extent;
        const sampleRate = Number.isFinite(rows) && rows > 1 ? (rows - 1) / (full[1] - full[0]) : NaN;
        if (Number.isFinite(sampleRate)) {
            if (!(sampleRate >= gate.min)) return { ok: false, reason: 'rateTooLow', sampleRate };
            if (!(sampleRate <= gate.max)) return { ok: false, reason: 'rateTooHigh', sampleRate };
        }
        return {
            ok: true,
            lazy: true,
            sampleRate,
            extent: [Number(extent[0]), Number(extent[1])],
            // The overview, for what is drawn and for the key of the buffer:
            // a recomputed data tool or a live update gives a new array.
            times: overviewTimes,
            values: this._getTransformedVariableData(fileId, varName),
        };
    };

    /**
     * A lazy file's time span as the panel shows it: `full`, its first and
     * last row in display time (the load's scan has them; the overview, a
     * sample of the rows, may not reach them), and `extent`, that span inside
     * the file's crop — the bounds of "All", which hold exactly the rows the
     * in-memory signal has. Null when the ends are not known.
     */
    proto._audioLazySpan = function(fileId) {
        const data = this.files.get(fileId)?.data;
        const meta = data?._duckdb;
        const start = Number(data?.metadata?.timeStart);
        const end = Number(data?.metadata?.timeEnd);
        if (!meta || !Number.isFinite(start) || !Number.isFinite(end)) return null;
        const rows = Number(meta.totalRows);
        const lastRow = Number.isFinite(rows) && rows > 0 ? rows - 1 : null;
        const first = this._displayTimeForFetchedSourceTime(fileId, start, 0);
        const last = this._displayTimeForFetchedSourceTime(fileId, end, lastRow);
        if (!Number.isFinite(first) || !Number.isFinite(last) || !(last > first)) return null;
        const transform = this._fileTransform(fileId);
        const shift = this._parseTimeShift(fileId, transform.timeShift);
        let lo = this._parseTimeBoundary(fileId, transform.cropStart);
        let hi = this._parseTimeBoundary(fileId, transform.cropEnd);
        lo = lo === null ? -Infinity : lo + shift;
        hi = hi === null ? Infinity : hi + shift;
        if (lo > hi) [lo, hi] = [hi, lo];
        const extent = [Math.max(first, lo), Math.min(last, hi)];
        return { full: [first, last], extent: extent[1] > extent[0] ? extent : null };
    };

    /**
     * Every row of `varNames` (one file) whose display time is in `range`,
     * inclusive, transformed as the panel draws them, handed to
     * `visit(time, [values per name])` a chunk at a time in file order.
     *
     * In memory the chunks are views of the panel's own arrays (read-only);
     * from a lazy file they are a stream of the file, cancelled by `signal`.
     * `onRows(rows)` follows the progress.
     */
    proto._audioVisitRange = async function(fileId, varNames, range, visit, { signal = null, onRows = null, chunkRows } = {}) {
        if (this._audioIsLazy(fileId)) {
            await this._audioLazyPass(fileId, varNames, range, visit, { signal, onRows, chunkRows });
            return;
        }
        const times = this._getTransformedTimeDataForVariable(fileId, varNames[0]);
        const columns = varNames.map(name => this._getTransformedVariableData(fileId, name));
        // One time axis for every channel: a variable with its own index
        // would line its samples up with another signal's instants.
        for (const name of varNames.slice(1)) {
            const other = this._getTransformedTimeDataForVariable(fileId, name);
            if (other !== times && (other?.length !== times?.length
                || Number(other[0]) !== Number(times[0])
                || Number(other[other.length - 1]) !== Number(times[times.length - 1]))) {
                throw audioRangeError('channelsGrid');
            }
        }
        if (!times?.length) return;
        const { from, to } = audioRangeRows(times, range);
        const step = Math.max(1, Math.round(Number(chunkRows) || EAGER_CHUNK_ROWS));
        for (let at = from; at < to; at += step) {
            if (signal?.aborted) throw abortError();
            const end = Math.min(to, at + step);
            visit(sliceOf(times, at, end), columns.map(column => sliceOf(column, at, end)));
            onRows?.(end - from);
            // A frame between chunks, so a long export paints its progress
            // and its Cancel can be pressed.
            if (end < to) await (this._yieldToPaint ? this._yieldToPaint() : new Promise(resolve => setTimeout(resolve, 0)));
        }
    };

    /**
     * The lazy half of _audioVisitRange: a stream of the file over the source
     * range the display range maps to, widened a hair so that the exact cut
     * is made on the transformed time, as in memory (a time shift does not
     * map back to the very same double). A file whose axis is a row number
     * is read whole, so each row's number is its place in the file — as the
     * histogram reads one (histogram-lazy-methods.js).
     */
    proto._audioLazyPass = async function(fileId, varNames, range, visit, { signal = null, onRows = null, chunkRows } = {}) {
        const data = this.files.get(fileId)?.data;
        const source = data?._duckdb?.source;
        if (!source?.streamColumns) throw audioRangeError('readFailed');
        const timeVar = this._getTimeVar(fileId);
        const byRow = this._isGeneratedIndexTime(fileId, timeVar) || this._isGeneratedFromDetectedTime(fileId, timeVar);
        let lo = Number(range[0]);
        let hi = Number(range[1]);
        if (lo > hi) [lo, hi] = [hi, lo];
        const options = { signal, chunkRows };
        if (!byRow) {
            const sourceRange = this._sourceRangeForDisplayRange(fileId, [lo, hi], timeVar);
            if (!sourceRange || !sourceRange.every(Number.isFinite)) throw audioRangeError('readFailed');
            let [a, b] = sourceRange;
            if (a > b) [a, b] = [b, a];
            const pad = (b - a) * 1e-9 + Math.max(Math.abs(a), Math.abs(b), 1) * 1e-12;
            options.t0 = a - pad;
            options.t1 = b + pad;
        }
        let rows = 0;
        for await (const chunk of source.streamColumns(data, varNames, options)) {
            if (signal?.aborted) throw abortError();
            const n = chunk.x.length;
            let rowIndex = null;
            if (byRow) {
                rowIndex = new Float64Array(n);
                for (let i = 0; i < n; i++) rowIndex[i] = chunk.rowStart + i;
            }
            const transformed = this._transformFetchedPhaseTrajectory(fileId, chunk.x, rowIndex, chunk.yByVar, varNames);
            const time = transformed.time;
            // lo ≤ t ≤ hi, the rule audioRangeRows applies in memory.
            let first = -1;
            let last = -1;
            let count = 0;
            for (let i = 0; i < time.length; i++) {
                if (!(time[i] >= lo && time[i] <= hi)) continue;
                if (first < 0) first = i;
                last = i;
                count++;
            }
            if (!count) continue;
            const columns = varNames.map(name => transformed.valuesByVar.get(name));
            if (count === last - first + 1) {
                visit(time.subarray(first, last + 1), columns.map(column => column.subarray(first, last + 1)));
            } else {
                // Rows in range with others between them (a file out of time
                // order): kept one by one, in file order.
                const keep = [];
                for (let i = first; i <= last; i++) if (time[i] >= lo && time[i] <= hi) keep.push(i);
                const pick = (arr) => Float64Array.from(keep, i => arr[i]);
                visit(pick(time), columns.map(pick));
            }
            rows += count;
            onRows?.(rows);
        }
    };

    /**
     * The samples of a range of a lazy file, read from the file: one stream
     * of the range, scanned as it comes, then written by the kernel the
     * in-memory path uses. Holds the range's values while it is read (8 bytes
     * a sample, the same bound as the buffer: MAX_BUFFER_SAMPLES), never the
     * file. `alloc(frames, sampleRate)` gives where the samples go, as for
     * _audioEagerRangeSamples.
     */
    proto._audioLazyRangeSamples = async function(source, range, state, alloc, { signal = null, onRows = null, maxFrames = Infinity, chunkRows } = {}) {
        const scan = createAudioScan(1);
        const chunks = [];
        let frames = 0;
        try {
            await this._audioVisitRange(source.fileId, [source.varName], range, (time, channels) => {
                frames += time.length;
                // Stopped at the limit rather than read to the end only to be
                // refused: the strip says the range is too long, as in memory.
                if (frames > maxFrames) throw audioRangeError('rangeTooLong');
                scanAudioChunk(scan, time, channels);
                chunks.push(channels);
            }, { signal, onRows, chunkRows });
        } catch (error) {
            if (error?.audioReason) return { error: error.audioReason };
            throw error;
        }
        if (frames < 2) return { error: 'rangeTooShort' };
        const info = finishAudioScan(scan, { removeDC: !!state.removeDC });
        return this._audioWriteSamples(info, chunks, alloc);
    };
}
