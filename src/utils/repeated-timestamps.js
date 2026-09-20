// Repeated timestamps in a datetime column, counted rather than judged.
//
// A logger that writes a burst of rows at one instant, a device whose clock has
// one-second resolution under a faster sampling loop, a Modelica event: all of
// them put the same stamp on consecutive rows. The app used to treat three such
// rows as proof that the whole column was unusable and plotted the file against
// row number instead — which throws away the other 4 997 good timestamps in a
// 5 000-row file, and depended on WHERE the burst sat, since only the first
// 1 000 rows were scanned (#154).
//
// So this counts, and the caller warns. The whole column is scanned: a count
// that changes with the position of the burst is not a count.

/**
 * @param {ArrayLike<number>|null|undefined} values  a datetime column, in ms
 * @returns {{samples: number, repeated: number, longestRun: number}}
 *   `repeated` is how many samples carry the same instant as the sample before
 *   them, so three rows at one instant count as two. `longestRun` is the most
 *   rows ever seen at a single instant, counting the first — three, for that
 *   same burst — because that is the number a reader recognises in their file.
 */
export function repeatedTimestampSummary(values) {
    const empty = { samples: 0, repeated: 0, longestRun: 0 };
    if (!values || typeof values.length !== 'number') return empty;
    const samples = values.length;
    if (samples < 2) return { samples, repeated: 0, longestRun: samples ? 1 : 0 };

    let previous = NaN;
    let run = 0;
    let repeated = 0;
    let longestRun = 0;
    for (let i = 0; i < samples; i++) {
        const value = Number(values[i]);
        // A gap in the stamps is not a repeat, and it does not join the runs on
        // either side of it into one.
        if (!Number.isFinite(value)) {
            previous = NaN;
            run = 0;
            continue;
        }
        if (value === previous) {
            run += 1;
            repeated += 1;
        } else {
            run = 1;
        }
        previous = value;
        if (run > longestRun) longestRun = run;
    }
    return { samples, repeated, longestRun };
}

/**
 * Worth telling the user about? Two rows at one instant is how a Modelica event
 * is written and reads as noise; a run of three is where a reader starts asking
 * why their curve has a vertical segment. Deliberately the same number the old
 * rule used, so the same files are spoken about — they just keep their axis now.
 */
export const REPEATED_TIMESTAMP_RUN_NOTICE = 3;

/** @returns {boolean} whether `summary` deserves the notice. */
export function repeatedTimestampsWorthSaying(summary) {
    return Number(summary?.longestRun) >= REPEATED_TIMESTAMP_RUN_NOTICE;
}
