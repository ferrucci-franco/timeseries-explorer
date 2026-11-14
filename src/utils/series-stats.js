// Pure summary statistics for one series: no DOM, no Plotly, no DuckDB.
//
// Panel statistics used to compute these inline and return null whenever a
// variable had no finite sample, which quietly dropped the variable from the
// table. That was exactly backwards for the reader who opened the panel to ask
// why a signal looks empty: the answer — every sample is missing — was the one
// answer the table refused to give. So the count of missing samples travels
// with the statistics, and a series with nothing finite in it still produces a
// row, with the numeric fields left as NaN for the caller to print as a gap.
//
// What counts as missing: anything that is not a finite number and is not an
// infinity. NaN is how every reader in this app marks a hole, an out-of-range
// index reads back as undefined, and both mean "no value here". ±Infinity is a
// value the file really contains, so it is not called missing — it is still
// left out of min/max/mean/RMS, which it would otherwise swallow whole.

/**
 * The same statistics, fed a piece at a time: `add(values)` for each chunk of
 * the series in order, then `result()`. A file in memory-saving mode is read
 * in chunks and never held whole; fed its chunks in order, this runs the very
 * sums seriesStats runs over the whole array, so the two agree bit for bit.
 */
export function createSeriesStatsAccumulator() {
    let total = 0;
    let n = 0;
    let missing = 0;
    let sum = 0;
    let sumSq = 0;
    let min = Infinity;
    let max = -Infinity;
    return {
        add(values) {
            if (!values) return;
            total += values.length;
            for (const value of values) {
                if (!Number.isFinite(value)) {
                    if (value !== Infinity && value !== -Infinity) missing++;
                    continue;
                }
                n++;
                sum += value;
                sumSq += value * value;
                if (value < min) min = value;
                if (value > max) max = value;
            }
        },
        /** null only when there was nothing at all to describe. */
        result() {
            if (!total) return null;
            if (!n) return { min: NaN, max: NaN, mean: NaN, rms: NaN, missing, total };
            return { min, max, mean: sum / n, rms: Math.sqrt(sumSq / n), missing, total };
        },
    };
}

/**
 * @param {ArrayLike<number>|null|undefined} values
 * @returns {{min:number,max:number,mean:number,rms:number,missing:number,total:number}|null}
 *          null only when there is nothing at all to describe.
 */
export function seriesStats(values) {
    if (!values || !values.length) return null;
    const stats = createSeriesStatsAccumulator();
    stats.add(values);
    return stats.result();
}

/**
 * The missing count as the statistics table shows it: a bare "0", or a count
 * with the share it represents. The share is what turns a number into a
 * judgement — 12 missing samples mean one thing in a 10-sample record and
 * another in a million-sample one — and it is rounded so that a non-zero count
 * never reads as "0%".
 */
export function formatMissingCount(missing, total) {
    if (!missing) return '0';
    if (!total) return String(missing);
    const percent = (missing / total) * 100;
    const shown = percent >= 10 ? percent.toFixed(0)
        : percent >= 0.1 ? percent.toFixed(1)
        : '<0.1';
    return `${missing} (${shown}%)`;
}
