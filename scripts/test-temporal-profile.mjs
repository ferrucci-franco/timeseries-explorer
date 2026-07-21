import assert from 'node:assert/strict';
import {
    buildTemporalProfile,
    inferTemporalProfileStepMs,
    TEMPORAL_PROFILE_MAX_BINS,
} from '../src/utils/temporal-profile.js';

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

console.log('temporal profile kernel tests passed');
