import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
    buildTemporalProfile,
    inferTemporalProfileStepMs,
    multiYearBinEdges,
    TEMPORAL_PROFILE_MAX_BINS,
    TEMPORAL_PROFILE_PERIODS,
} from '../src/utils/temporal-profile.js';

import {
    buildTemporalProfileFinalSql,
    temporalProfilesFromAggregateRows,
} from '../src/data/temporal-profile-sql.js';

const DAY = 86_400_000;

const temporalProfileMethodsSource = readFileSync(
    new URL('../src/plots/methods/temporal-profile-methods.js', import.meta.url),
    'utf8',
);

// Timestep inference and selected-series extraction both stay bounded on a
// multi-GB eager timeline.
{
    const hugeLength = 20_000_000;
    let inferenceReads = 0;
    const virtualTimeline = new Proxy({ length: hugeLength }, {
        get(target, key) {
            if (key in target) return target[key];
            const index = Number(key);
            if (Number.isInteger(index)) {
                inferenceReads++;
                return index * 1000;
            }
            return undefined;
        },
    });
    assert.equal(inferTemporalProfileStepMs(virtualTimeline), 1000);
    assert.ok(inferenceReads <= 100_001, `step inference is capped (${inferenceReads} reads)`);

    const start = temporalProfileMethodsSource.indexOf('proto._temporalProfileSeriesForTrace = function');
    const end = temporalProfileMethodsSource.indexOf('\nproto.', start + 1);
    assert.ok(start >= 0 && end > start, 'Temporal Profile bounded sampler can be isolated');
    const isolatedProto = {};
    vm.runInNewContext(temporalProfileMethodsSource.slice(start, end), { proto: isolatedProto });
    let boundReads = 0;
    let copiedTimes = 0;
    let copiedValues = 0;
    const times = new Proxy({
        length: hugeLength,
        slice(first, last) {
            copiedTimes += last - first;
            return { length: last - first };
        },
    }, {
        get(target, key) {
            if (key in target) return target[key];
            const index = Number(key);
            if (Number.isInteger(index)) {
                boundReads++;
                return index;
            }
            return undefined;
        },
    });
    const values = {
        length: hugeLength,
        slice(first, last) {
            copiedValues += last - first;
            return { length: last - first };
        },
    };
    const bound = upper => (array, target) => {
        let lo = 0;
        let hi = array.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (upper ? array[mid] <= target : array[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    };
    const selected = isolatedProto._temporalProfileSeriesForTrace.call({
        _getTransformedTimeDataForVariable: () => times,
        _getTransformedVariableData: () => values,
        _lowerBound: bound(false),
        _upperBound: bound(true),
    }, { fileId: 'audio', varName: 'Left' }, [4_000_000, 4_262_143]);
    assert.equal(selected.times.length, 262_144);
    assert.equal(selected.values.length, 262_144);
    assert.ok(boundReads < 100, `profile bounds stay logarithmic (${boundReads} reads)`);
    assert.equal(copiedTimes, 262_144);
    assert.equal(copiedValues, 262_144);
}

assert.match(
    temporalProfileMethodsSource,
    /_scheduleTemporalProfileRecompute[\s\S]*_autoLimitAnalysisRange\(plot, state, 'temporal-profile'\)[\s\S]*_setTemporalProfileComputing\(plot, true\)[\s\S]*_runAnalysisAfterPaint\(/,
    'Temporal Profile paints progress and preflights before eager computation',
);

const utc = value => Date.parse(value);
const close = (actual, expected, epsilon = 1e-12, message = '') => {
    assert.ok(Math.abs(actual - expected) <= epsilon, `${message}: expected ${expected}, got ${actual}`);
};

// The UI uses the median positive timestamp step as its minimum useful bin
// resolution. A bin may be wider without being an exact multiple of the step.
{
    const base = utc('2024-01-01T00:00:00Z');
    const tenMinutes = 10 * 60 * 1000;
    assert.equal(inferTemporalProfileStepMs([base, base + tenMinutes, base + 2 * tenMinutes]), tenMinutes);

    const times = [];
    const values = [];
    for (let minute = 0; minute < 24 * 60; minute += 10) {
        times.push(base + minute * 60 * 1000);
        values.push(minute);
    }
    const fifteenMinuteBins = buildTemporalProfile({ times, values, period: 'day', resolutionMinutes: 15 });
    assert.equal(fifteenMinuteBins.binCount, 96);
    assert.ok(fifteenMinuteBins.categories[0].bins.every(bin => bin.mean != null), '15-minute bins work with a 10-minute timestep');
    assert.deepEqual(
        fifteenMinuteBins.categories[0].bins.slice(0, 4).map(bin => bin.mean),
        [5, 20, 35, 50],
        'non-multiple bins alternate between two and one samples without gaps',
    );
}

// Daily defaults: 24 hourly bins and the three calendar categories.
{
    const result = buildTemporalProfile({
        times: [utc('2024-01-01T00:10:00Z'), utc('2024-01-06T00:10:00Z'), utc('2024-01-07T00:10:00Z')],
        values: [1, 2, 3],
        period: 'day',
    });
    assert.equal(result.ok, true);
    assert.equal(result.binCount, 24);
    assert.deepEqual(result.categories.map(category => category.id), ['workday', 'saturday', 'sunday']);
    assert.equal(result.categories[0].bins[0].mean, 1);
    assert.equal(result.categories[1].bins[0].mean, 2);
    assert.equal(result.categories[2].bins[0].mean, 3);
}

// Daily profiles can combine every calendar day into one equally weighted
// category instead of splitting workdays, Saturdays and Sundays.
{
    const result = buildTemporalProfile({
        times: [utc('2024-01-01T00:00:00Z'), utc('2024-01-06T00:00:00Z'), utc('2024-01-07T00:00:00Z')],
        values: [1, 3, 5],
        period: 'day',
        dayGrouping: 'all',
    });
    assert.deepEqual(result.categories.map(category => category.id), ['all']);
    assert.equal(result.categories[0].bins[0].mean, 3);
    assert.equal(result.categories[0].bins[0].nPeriods, 3);
}

// Saturday and Sunday can be combined into one weekend category while keeping
// workdays separate.
{
    const result = buildTemporalProfile({
        times: [utc('2024-01-01T00:00:00Z'), utc('2024-01-06T00:00:00Z'), utc('2024-01-07T00:00:00Z')],
        values: [1, 3, 5],
        period: 'day',
        dayGrouping: 'day-type',
        combineWeekends: true,
    });
    assert.deepEqual(result.categories.map(category => category.id), ['workday', 'weekend']);
    assert.equal(result.categories[0].bins[0].mean, 1);
    assert.equal(result.categories[1].bins[0].mean, 4);
    assert.equal(result.categories[1].bins[0].nPeriods, 2);
}

// One-minute resolution is allowed for a full day.
{
    const result = buildTemporalProfile({ times: [utc('2024-01-01T00:00:00Z')], values: [1], period: 'day', resolutionMinutes: 1 });
    assert.equal(result.ok, true);
    assert.equal(result.binCount, 1440);
}

// Periods receive equal weight even when one day has many more samples.
{
    const result = buildTemporalProfile({
        times: [
            utc('2024-01-01T00:05:00Z'), utc('2024-01-01T00:10:00Z'), utc('2024-01-01T00:15:00Z'),
            utc('2024-01-02T00:05:00Z'),
        ],
        values: [0, 0, 0, 10],
        period: 'day',
    });
    const bin = result.categories[0].bins[0];
    close(bin.mean, 5, 1e-12, 'mean of day means');
    close(bin.std, Math.sqrt(50), 1e-12, 'sample standard deviation across days');
    assert.equal(bin.nPeriods, 2);
}

// Missing data affects only its bin by default, with truthful coverage.
{
    const result = buildTemporalProfile({
        times: [
            utc('2024-01-01T00:00:00Z'), utc('2024-01-01T01:00:00Z'),
            utc('2024-01-02T00:00:00Z'), utc('2024-01-02T01:00:00Z'),
        ],
        values: [1, NaN, 3, 4],
        period: 'day',
    });
    const workday = result.categories[0];
    assert.equal(workday.bins[0].mean, 2);
    assert.equal(workday.bins[0].coverage, 1);
    assert.equal(workday.bins[1].mean, 4);
    assert.equal(workday.bins[1].nPeriods, 1);
    assert.equal(workday.bins[1].nExpectedPeriods, 2);
    assert.equal(workday.bins[1].coverage, 0.5);
    assert.equal(workday.bins[1].nInvalidSamples, 1);
}

// Strict mode discards the whole period containing an explicit NaN.
{
    const times = [];
    const values = [];
    for (let day = 1; day <= 2; day++) {
        for (let hour = 0; hour < 24; hour++) {
            times.push(Date.UTC(2024, 0, day, hour));
            values.push(day === 1 && hour === 1 ? NaN : (day === 1 ? 1 : 3));
        }
    }
    const result = buildTemporalProfile({
        times,
        values,
        period: 'day',
        discardIncomplete: true,
    });
    assert.equal(result.stats.nDiscardedPeriods, 1);
    assert.equal(result.categories[0].bins[0].mean, 3);
}

// Week profiles fold timestamps to Monday..Sunday (168 hourly bins).
{
    const result = buildTemporalProfile({
        times: [utc('2024-01-01T00:00:00Z'), utc('2024-01-08T00:00:00Z')],
        values: [2, 6],
        period: 'week',
    });
    assert.equal(result.binCount, 168);
    assert.equal(result.categories[0].bins[0].mean, 4);
    assert.equal(result.categories[0].bins[0].nPeriods, 2);
}

// Short months do not make day 29/30/31 count as missing. February and March
// both contribute to day 1, only March is expected to contribute to day 31.
{
    const result = buildTemporalProfile({
        times: [utc('2023-02-01T00:00:00Z'), utc('2023-03-01T00:00:00Z'), utc('2023-03-31T00:00:00Z')],
        values: [2, 4, 8],
        period: 'month',
    });
    assert.equal(result.binCount, 31);
    assert.equal(result.categories[0].bins[0].nExpectedPeriods, 2);
    assert.equal(result.categories[0].bins[30].nExpectedPeriods, 1);
    assert.equal(result.categories[0].bins[30].coverage, 1);
}

// Year profiles reserve Feb 29 structurally. March 1 and Dec 31 therefore stay
// aligned across leap and non-leap years, while only the leap year contributes
// to the Feb 29 bin.
{
    const result = buildTemporalProfile({
        times: [
            utc('2023-01-01T00:00:00Z'), utc('2023-03-01T00:00:00Z'), utc('2023-12-31T00:00:00Z'),
            utc('2024-01-01T00:00:00Z'), utc('2024-02-29T00:00:00Z'), utc('2024-03-01T00:00:00Z'), utc('2024-12-31T00:00:00Z'),
        ],
        values: [1, 3, 5, 2, 20, 4, 6],
        period: 'year',
    });
    assert.equal(result.ok, true);
    assert.equal(result.binCount, 366);
    const bins = result.categories[0].bins;
    assert.equal(bins[0].mean, 1.5, 'January 1 aligns across years');
    assert.equal(bins[59].mean, 20, 'only the leap year contributes to February 29');
    assert.equal(bins[59].nExpectedPeriods, 1, 'February 29 is structural in a non-leap year');
    assert.equal(bins[60].mean, 3.5, 'March 1 aligns across years');
    assert.equal(bins[60].nExpectedPeriods, 2);
    assert.equal(bins[365].mean, 5.5, 'December 31 aligns across years');
    assert.equal(bins[365].nExpectedPeriods, 2);
}

// Calendar-month resolution uses twelve variable-duration bins and still
// calculates dispersion across yearly period means.
{
    const result = buildTemporalProfile({
        times: [
            utc('2023-01-15T00:00:00Z'), utc('2023-02-15T00:00:00Z'),
            utc('2024-01-15T00:00:00Z'), utc('2024-02-15T00:00:00Z'),
        ],
        values: [1, 2, 3, 4],
        period: 'year',
        resolutionUnit: 'month',
    });
    assert.equal(result.resolutionUnit, 'month');
    assert.equal(result.binCount, 12);
    assert.equal(result.categories[0].bins[0].mean, 2);
    assert.equal(result.categories[0].bins[1].mean, 3);
    close(result.categories[0].bins[0].std, Math.sqrt(2), 1e-12, 'monthly standard deviation across years');
}

// Selection boundaries produce partial periods; strict mode removes them.
{
    const result = buildTemporalProfile({
        times: [utc('2024-01-01T12:00:00Z'), utc('2024-01-02T00:00:00Z')],
        values: [1, 2],
        period: 'day',
        rangeStart: utc('2024-01-01T12:00:00Z'),
        rangeEnd: utc('2024-01-02T00:00:00Z'),
        discardIncomplete: true,
    });
    assert.equal(result.stats.nDiscardedPeriods, 2);
}

// Internal time gaps are attached to every touched profile bin even if a bin
// still contains a finite sample, and strict mode discards the affected day.
{
    const times = [];
    const values = [];
    for (let hour = 0; hour < 24; hour++) {
        if (hour >= 5 && hour <= 7) continue;
        times.push(Date.UTC(2024, 0, 1, hour));
        values.push(hour);
    }
    const permissive = buildTemporalProfile({ times, values, period: 'day' });
    assert.ok(permissive.categories[0].bins[4].nGapPeriods > 0, 'bin bordering a gap is marked');
    assert.ok(permissive.categories[0].bins[8].nGapPeriods > 0, 'bin after a gap is marked');
    const strict = buildTemporalProfile({ times, values, period: 'day', discardIncomplete: true });
    assert.equal(strict.stats.nDiscardedPeriods, 1, 'strict mode discards a day with an internal gap');
}

// Invalid resolution and excessive bin counts are rejected explicitly.
{
    assert.equal(buildTemporalProfile({ resolutionMinutes: 0 }).reason, 'invalidResolution');
    const tooFine = buildTemporalProfile({ period: 'month', resolutionMinutes: 0.01 });
    assert.equal(tooFine.reason, 'tooManyBins');
    assert.ok(tooFine.binCount > TEMPORAL_PROFILE_MAX_BINS);
}

// ─── Multi-year ───────────────────────────────────────────────────────────
//
// The one period that does NOT fold: its bins are the calendar years of the
// record, laid out along the real timeline, and its sub-period is the UTC day.
{
    assert.ok(TEMPORAL_PROFILE_PERIODS.has('multi-year'), 'multi-year is a period');

    // Bin edges: one per calendar year the span touches, leap years included.
    const edges = multiYearBinEdges(Date.UTC(2019, 5, 10), Date.UTC(2021, 1, 3));
    assert.deepEqual(edges.years, [2019, 2020, 2021], 'every year the span touches gets a bin');
    assert.deepEqual(edges.edgesMs, [Date.UTC(2019, 0, 1), Date.UTC(2020, 0, 1), Date.UTC(2021, 0, 1), Date.UTC(2022, 0, 1)],
        'and the edges are the 1 January boundaries, one more than the bins');
    assert.equal(edges.edgesMs[2] - edges.edgesMs[1], 366 * DAY, '2020 is 366 days long');
    assert.deepEqual(multiYearBinEdges(Date.UTC(2019, 0, 1), Date.UTC(2019, 11, 31)).years, [2019],
        'a single-year record makes a single bin');
    assert.equal(multiYearBinEdges(Date.UTC(2021, 0, 1), Date.UTC(2019, 0, 1)), null,
        'a backwards span has no bins');
    assert.equal(multiYearBinEdges(NaN, 0), null, 'nor has an unreadable one');

    // Three years of daily samples, one constant value per year: each year bin
    // then reads exactly that value, and the day-to-day spread is zero.
    const times = [];
    const values = [];
    for (let t = Date.UTC(2019, 0, 1); t < Date.UTC(2022, 0, 1); t += DAY) {
        times.push(t);
        values.push(new Date(t).getUTCFullYear() - 2018);
    }
    const profile = buildTemporalProfile({ times, values, period: 'multi-year' });
    assert.equal(profile.ok, true, 'a multi-year profile is produced');
    assert.equal(profile.binCount, 3, 'one bin per year');
    assert.deepEqual(profile.binYears, [2019, 2020, 2021], 'and the years are named');
    assert.equal(profile.absoluteBins, true, 'the bins sit on the real timeline, which the result says');
    assert.equal(profile.resolutionUnit, 'year', 'there is no sub-resolution to choose');
    assert.equal(profile.resolutionMinutes, null, 'so no resolution is reported');
    assert.deepEqual(profile.categories.map(category => category.id), ['all'],
        'day-type categories belong to the folded day profile, not to a timeline');
    const bins = profile.categories[0].bins;
    assert.deepEqual(bins.map(bin => bin.mean), [1, 2, 3], 'each year carries its own level');
    assert.deepEqual(bins.map(bin => bin.std), [0, 0, 0], 'a constant year has no day-to-day spread');
    assert.deepEqual(bins.map(bin => bin.nPeriods), [365, 366, 365],
        'the periods counted per year are its days, leap year included');
    assert.deepEqual(bins.map(bin => bin.coverage), [1, 1, 1], 'all of which have data');
    // The x values are epoch hours of the real year boundaries, which is what
    // lets the axis label them with the year rather than an offset.
    assert.equal(new Date(bins[0].startHours * 3600000).toISOString(), '2019-01-01T00:00:00.000Z',
        'the first bin opens on 1 January of the first year');
    assert.equal(new Date(bins[2].endHours * 3600000).toISOString(), '2022-01-01T00:00:00.000Z',
        'and the last closes on 1 January after the last');

    // The mean is a mean of DAILY means, so a densely sampled day does not
    // outvote a sparse one — the same rule the folded periods follow.
    {
        const t = [];
        const v = [];
        const year = Date.UTC(2020, 0, 1);
        // Day 0: twenty-four samples of 0. Day 1: one sample of 24.
        for (let hour = 0; hour < 24; hour++) { t.push(year + hour * 3600000); v.push(0); }
        t.push(year + DAY);
        v.push(24);
        const weighted = buildTemporalProfile({ times: t, values: v, period: 'multi-year' });
        const bin = weighted.categories[0].bins[0];
        assert.equal(bin.mean, 12, 'the year is the mean of its two daily means, not of its 25 samples');
        assert.equal(bin.nPeriods, 2, 'two days contributed');
        assert.ok(Math.abs(bin.std - Math.sqrt((144 + 144) / 1)) < 1e-9,
            'and the deviation is the spread between those days');
    }

    // Years with no samples at all are not invented: the bins span the data.
    {
        const t = [Date.UTC(2015, 6, 1), Date.UTC(2015, 6, 2)];
        const single = buildTemporalProfile({ times: t, values: [5, 7], period: 'multi-year' });
        assert.deepEqual(single.binYears, [2015], 'two days in one year make one bin');
        assert.equal(single.categories[0].bins[0].mean, 6, 'holding the mean of its days');
    }

    // A selection narrows the years to the data INSIDE it, not to the band.
    {
        const narrowed = buildTemporalProfile({
            times, values, period: 'multi-year',
            rangeStart: Date.UTC(2020, 5, 1),
            rangeEnd: Date.UTC(2020, 7, 1),
        });
        assert.deepEqual(narrowed.binYears, [2020], 'only the selected year is binned');
        assert.equal(narrowed.categories[0].bins[0].mean, 2, 'with the level of that year');
        assert.ok(narrowed.stats.nOutOfRange > 0, 'and the samples outside are counted as such');
    }

    // An explicit span is honoured, which is how the lazy (DuckDB) path bins
    // against exactly the years the eager kernel would have chosen.
    {
        const explicit = buildTemporalProfile({
            times, values, period: 'multi-year',
            spanStartMs: Date.UTC(2018, 0, 1),
            spanEndMs: Date.UTC(2022, 11, 31),
        });
        assert.deepEqual(explicit.binYears, [2018, 2019, 2020, 2021, 2022],
            'the declared span decides the bins');
        assert.deepEqual(explicit.categories[0].bins.map(bin => bin.mean), [null, 1, 2, 3, null],
            'and a year the data never reaches reads as no data rather than as zero');
        assert.deepEqual(explicit.categories[0].bins.map(bin => bin.nExpectedPeriods), [0, 365, 366, 365, 0],
            'an empty year expects nothing, so its coverage is not a false 100%');
    }

    // An incomplete sub-period is a DAY here, so discarding drops days.
    {
        const t = [];
        const v = [];
        for (let day = 0; day < 5; day++) {
            for (let hour = 0; hour < 24; hour++) {
                // The third day is missing its afternoon.
                if (day === 2 && hour >= 12) continue;
                t.push(Date.UTC(2022, 0, 1 + day, hour));
                v.push(10);
            }
        }
        const strict = buildTemporalProfile({ times: t, values: v, period: 'multi-year', discardIncomplete: true });
        assert.equal(strict.categories[0].bins[0].nPeriods, 4, 'the cut day leaves the year bin');
        assert.equal(strict.stats.nDiscardedPeriods, 1, 'and is counted as discarded');
    }
}

// ─── Multi-year on the lazy (DuckDB) side ─────────────────────────────────
//
// scripts/test-temporal-profile-lazy.mjs runs the real query against DuckDB.
// What is checked here is everything about that path that does NOT need the
// native module: the reducer that folds the query's rows, and the query text
// itself carrying the multi-year geometry.
{
    const spanStartMs = Date.UTC(2019, 4, 20);
    const spanEndMs = Date.UTC(2021, 3, 2);
    const options = { period: 'multi-year', spanStartMs, spanEndMs, valueCount: 1 };

    // The query: the bin is the sample's calendar year, counted from the first
    // year of the span, and a day expects only the bin of its own year.
    const built = buildTemporalProfileFinalSql({
        ...options,
        tableName: 'src',
        timeExpression: 't_ms',
        whereSql: 'TRUE',
        valueExpressions: ['v'],
        numericLiteral: value => String(Number(value)),
    });
    assert.equal(built.ok, true, 'a multi-year query is built');
    assert.equal(built.binCount, 3, 'with one bin per year of the span');
    assert.ok(built.sql.includes('year(epoch_ms(CAST(t_ms AS BIGINT))) - 2019'),
        'the bin index is the year, counted from the first year of the span');
    assert.ok(built.sql.includes('bin_idx = year(epoch_ms(CAST(period_start AS BIGINT))) - 2019'),
        'and a day only expects the bin of its own year');
    // The sub-period is the day, so the per-period statistics are a day's.
    assert.ok(built.sql.includes(`(period_start + ${86_400_000})`),
        'the period a multi-year profile aggregates is the UTC day');

    // The reducer, driven with rows shaped exactly as that query returns them.
    const times = [];
    const values = [];
    for (let t = Date.UTC(2019, 11, 28); t < Date.UTC(2020, 0, 4); t += 6 * 3600_000) {
        times.push(t);
        // One value per day so the daily means, and hence the yearly means of
        // those means, are known by hand.
        values.push(new Date(t).getUTCDate() + (new Date(t).getUTCFullYear() - 2019) * 100);
    }
    const eager = buildTemporalProfile({ times, values, period: 'multi-year', spanStartMs, spanEndMs });
    const firstYear = 2019;
    const byDay = new Map();
    for (let index = 0; index < times.length; index++) {
        const dayStart = Math.floor(times[index] / DAY) * DAY;
        if (!byDay.has(dayStart)) byDay.set(dayStart, { sum: 0, count: 0, first: times[index], last: times[index] });
        const entry = byDay.get(dayStart);
        entry.sum += values[index];
        entry.count++;
        entry.first = Math.min(entry.first, times[index]);
        entry.last = Math.max(entry.last, times[index]);
    }
    const rows = [...byDay.entries()].map(([dayStart, entry]) => ({
        period_start: dayStart,
        bin_idx: new Date(dayStart).getUTCFullYear() - firstYear,
        category: 'all',
        first_t: entry.first,
        last_t: entry.last,
        has_gap: 0,
        gap: 0,
        s0: entry.sum,
        nf0: entry.count,
        ni0: 0,
    }));
    const reduced = temporalProfilesFromAggregateRows(rows, {
        ...options,
        medianStepMs: 6 * 3600_000,
        scopeStart: times[0],
        scopeEnd: times[times.length - 1],
    });
    assert.equal(reduced.ok, true, 'the reducer folds multi-year rows');
    const lazyBins = reduced.results[0].categories[0].bins;
    assert.equal(reduced.results[0].binCount, 3, 'keeping the three bins of the span');
    assert.deepEqual(reduced.results[0].binYears, [2019, 2020, 2021], 'and naming their years');
    assert.equal(reduced.results[0].absoluteBins, true, 'and saying the bins are absolute');
    assert.deepEqual(
        lazyBins.map(bin => [bin.mean, bin.nPeriods, bin.nExpectedPeriods]),
        eager.categories[0].bins.map(bin => [bin.mean, bin.nPeriods, bin.nExpectedPeriods]),
        'and agreeing with the eager kernel bin by bin',
    );
    assert.deepEqual(lazyBins.map(bin => bin.nPeriods), [4, 3, 0],
        'four days in 2019, three in 2020, none in 2021 — the span declared a year the data never reaches');
    assert.equal(lazyBins[2].nExpectedPeriods, 0, 'which therefore expects nothing');

    // No readable timestamp anywhere: both paths answer with one placeholder
    // bin and no years, rather than one of them failing with a reason.
    const empty = temporalProfilesFromAggregateRows([], { period: 'multi-year', valueCount: 1 });
    assert.equal(empty.ok, true, 'an empty multi-year scope is not an error');
    assert.deepEqual(empty.results[0].binYears, [], 'it simply has no years');
    assert.deepEqual(buildTemporalProfile({ times: [], values: [], period: 'multi-year' }).binYears, [],
        'which is what the eager kernel says too');
}

// Five periods do not fit the 286px options panel, so the Period control wraps
// and "Multi-year" lands on a row of its own. It has to still read as one
// segmented control there: the separators came from a border-right per button,
// which draws nothing between two ROWS and leaves the last button of a wrapped
// row with a border and dead space after it.
{
    const contentCss = readFileSync(new URL('../src/styles/content.css', import.meta.url), 'utf8');
    const wrapper = contentCss.match(/\.hist-segmented\s*\{([^}]*)\}/)?.[1];
    const button = contentCss.match(/\.hist-seg-btn\s*\{([^}]*)\}/)?.[1];
    assert.ok(wrapper && button, 'the segmented control is styled in content.css');

    assert.match(wrapper, /flex-wrap\s*:\s*wrap/, 'the control wraps rather than overflowing the panel');
    assert.match(wrapper, /gap\s*:\s*1px/, 'the separators are the gaps, so a row boundary gets one too');
    assert.match(wrapper, /background\s*:\s*var\(--border-color\)/, 'and the gaps show the border colour through');
    assert.match(button, /flex\s*:\s*1 1 auto/, 'a wrapped row fills the width instead of ending in dead space');
    assert.doesNotMatch(button, /border-right/, 'no per-button border: it cannot separate two rows');
}

console.log('temporal profile kernel tests passed');
