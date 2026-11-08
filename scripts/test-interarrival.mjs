// The Data tool "Time between edges" (tool id `interarrival`).
//
//   node scripts/test-interarrival.mjs
//
//   · the kernel: rising, falling or both; a dead band measured from the last
//     edge (a slow drift counts, noise around a level does not); NaN samples
//     and times skipped; seconds on a date/time axis, the axis's unit on a
//     numeric one, samples on an index; the same output however it is cut;
//   · the mean rate ΔY/Δt between edges, at the edge or held over
//     [t_(k−1), t_k) as stairs that integrate back to the counter; per
//     second, minute or hour; the cap on a held interval;
//   · the panel's in-memory path: the variable, its unit, its counts, and a
//     source that is itself an interarrival output;
//   · a lazy file on a real DuckDB-WASM engine: the chunked executor writes the
//     kernel's own doubles to a sink, on a numeric axis, a date/time axis and
//     a generated one, and a session runs it again.
import assert from 'node:assert/strict';
import { createRequire, register } from 'node:module';
import path from 'node:path';

register(new URL('./support/vite-asset-url-hooks.mjs', import.meta.url));
const {
    computeInterarrival, createInterarrival, normalizeInterarrivalParams,
} = await import(new URL('../src/compute/kernels/interarrival.js', import.meta.url));
const { runDataToolPipeline } = await import(new URL('../src/compute/kernels/index.js', import.meta.url));

const same = (a, b) => Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
function assertBitwise(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: length`);
    for (let i = 0; i < expected.length; i++) {
        if (!same(actual[i], expected[i])) assert.fail(`${label}: row ${i} is ${actual[i]}, expected ${expected[i]}`);
    }
}
const run = (y, params, time = null) => computeInterarrival(Float64Array.from(y), time, params);
const finite = (values) => [...values].map((v, i) => [i, v]).filter(([, v]) => Number.isFinite(v));

// ── The kernel ──────────────────────────────────────────────────────────────
{
    // Every change is an edge with no dead band; the output sits on the edge
    // and the first edge of the chosen kind has no interval.
    const y = [0, 0, 1, 1, 1, 0, 0, 2, 2, 1];
    const t = { values: Float64Array.from(y, (_, i) => i * 10), kind: 'numeric' };
    const both = run(y, { edge: 'both' }, t);
    assert.deepEqual(finite(both.values), [[5, 30], [7, 20], [9, 20]], 'both: time since the previous edge, at the edge');
    assert.equal(both.risingCount, 2);
    assert.equal(both.fallingCount, 2);
    assert.equal(both.edgeCount, 4);
    assert.equal(both.intervalCount, 3);
    assert.equal(both.meanDt, 70 / 3);
    assert.equal(both.minDt, 20);
    assert.equal(both.maxDt, 30);
    assert.ok(Number.isNaN(both.values[2]), 'the first edge has no interval');
    const rising = run(y, { edge: 'rising' }, t);
    assert.deepEqual(finite(rising.values), [[7, 50]], 'rising: from rise to rise, falls in between ignored');
    assert.equal(rising.edgeCount, 2);
    const falling = run(y, { edge: 'falling' }, t);
    assert.deepEqual(finite(falling.values), [[9, 40]], 'falling: from fall to fall');
    assert.equal(falling.values.length, y.length, 'as long as the input');
}
{
    // A dead band measured from the last edge: a drift of 0.3 a sample makes
    // an edge every 4 samples (1.2 ≥ 1), where sample-to-sample it never would.
    const drift = Array.from({ length: 13 }, (_, i) => i * 0.3);
    const out = run(drift, { edge: 'rising', deadband: 1 });
    assert.equal(out.risingCount, 3, 'a slow drift still makes edges');
    assert.deepEqual(finite(out.values).map(([i]) => i), [8, 12], 'every 4 samples');
    assert.deepEqual(finite(out.values).map(([, v]) => v), [4, 4], 'intervals in samples on an index');
    // Noise around a level makes none, then a real step makes one each way.
    const noisy = [5, 5.2, 4.9, 5.1, 4.8, 5.3, 5, 8, 8.2, 7.9, 8.1, 5, 5.1];
    const band = run(noisy, { edge: 'both', deadband: 1 });
    assert.equal(band.risingCount, 1, 'noise is not an edge');
    assert.equal(band.fallingCount, 1);
    assert.deepEqual(finite(band.values), [[11, 4]], 'step up at 7, down at 11');
    const raw = run(noisy, { edge: 'both', deadband: 0 });
    assert.ok(raw.edgeCount > 8, 'without a band every wiggle is an edge');
    // The band is inclusive: an integer counter with |ΔY| = 1 counts each step.
    const counter = run([10, 10, 11, 11, 12, 13], { edge: 'rising', deadband: 1 });
    assert.equal(counter.risingCount, 3, '|ΔY| = 1 on a counter of 1-unit steps');
    // A fall moves the reference too: the rise after it is measured from
    // where it fell to.
    const after = run([0, 3, 0.5, 2], { edge: 'rising', deadband: 1 });
    assert.equal(after.risingCount, 2, 'measured from the fall');
}
{
    // NaN values and times are skipped and leave the reference alone.
    const y = [0, NaN, 1, Infinity, 1, 0];
    const tv = Float64Array.from([0, 1, 2, 3, NaN, 5]);
    const out = run(y, { edge: 'both' }, { values: tv, kind: 'numeric' });
    assert.deepEqual(finite(out.values), [[5, 3]], 'NaN skipped');
    // A date/time axis is in milliseconds; intervals come out in seconds.
    const dt = run([0, 1, 1, 2], { edge: 'rising' }, { values: Float64Array.from([0, 60000, 120000, 300000]), kind: 'datetime' });
    assert.deepEqual(finite(dt.values), [[3, 240]], 'seconds on a date/time axis');
    assert.equal(dt.timeKind, 'datetime');
    // A time axis that does not match the series counts samples.
    const mismatch = run([0, 1, 2], { edge: 'rising' }, { values: Float64Array.from([0, 5]), kind: 'numeric' });
    assert.deepEqual(finite(mismatch.values), [[2, 1]], 'samples when the axis does not fit');
    // Time going backwards gives a negative interval, counted.
    const back = run([0, 1, 2], { edge: 'rising' }, { values: Float64Array.from([0, 10, 4]), kind: 'numeric' });
    assert.equal(back.negativeDtCount, 1, 'a negative interval is counted');
}
{
    const defaults = { edge: 'both', deadband: 0, output: 'interval', placement: 'edge', rateUnit: 's' };
    assert.deepEqual(normalizeInterarrivalParams({}), defaults, 'a definition from before the rate: the interval at the edge');
    assert.deepEqual(normalizeInterarrivalParams({ edge: 'up', deadband: -3, output: 'x', placement: 'y', rateUnit: 'day' }), defaults);
    assert.deepEqual(normalizeInterarrivalParams({ edge: 'falling', deadband: '0.5', output: 'rate', placement: 'hold', rateUnit: 'h' }),
        { edge: 'falling', deadband: 0.5, output: 'rate', placement: 'hold', rateUnit: 'h' });
}
{
    // The same doubles whatever the chunking.
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const n = 5003;
    const y = Float64Array.from({ length: n }, (_, i) => (i % 97 === 0 ? NaN : Math.round(Math.sin(i / 40) * 20 + random() * 3)));
    const tv = Float64Array.from({ length: n }, (_, i) => i * 1000 + (i % 7) * 13);
    for (const params of [{ edge: 'both' }, { edge: 'rising', deadband: 2.5 }, { edge: 'falling', deadband: 1 }]) {
        const whole = computeInterarrival(y, { values: tv, kind: 'datetime' }, params).values;
        for (const size of [1, 17, 1000]) {
            const kernel = createInterarrival(params, { kind: 'datetime' });
            const parts = [];
            for (let at = 0; at < n; at += size) parts.push(...kernel.push(y.subarray(at, at + size), tv.subarray(at, at + size)));
            parts.push(...kernel.flush());
            assertBitwise(Float64Array.from(parts), whole, `${params.edge} in chunks of ${size}`);
        }
        // And the worker's dispatch gives the same thing.
        const piped = runDataToolPipeline(y, { values: tv, kind: 'datetime' }, [{ tool: 'interarrival', params }]);
        assertBitwise(piped.values, whole, `${params.edge} through the pipeline`);
        assert.equal(piped.stepMeta[0].intervalCount, computeInterarrival(y, { values: tv, kind: 'datetime' }, params).intervalCount);
    }
}
console.log('interarrival: the kernel times rising, falling and both edges through a dead band that remembers the last edge');

// ── The mean rate, at the edge and held ─────────────────────────────────────
{
    // Rising edges at rows 2 (t=20), 5 (t=50) and 9 (t=90).
    const y = [0, 0, 1, 1, 1, 2, 2, 2, 2, 3, 3];
    const t = { values: Float64Array.from(y, (_, i) => i * 10), kind: 'numeric' };
    const atEdge = run(y, { edge: 'rising', output: 'rate' }, t);
    assert.deepEqual(finite(atEdge.values), [[5, 1 / 30], [9, 1 / 40]], 'at the edge that closes each interval');
    const held = run(y, { edge: 'rising', output: 'rate', placement: 'hold' }, t);
    const expected = [NaN, NaN, 1 / 30, 1 / 30, 1 / 30, 1 / 40, 1 / 40, 1 / 40, 1 / 40, NaN, NaN];
    assertBitwise(held.values, Float64Array.from(expected), 'held over [t_(k-1), t_k), NaN before the first edge and after the last');
    // Stairs: each value until the next sample, so the rectangular sum gives
    // the counter back between the first and the last edge.
    let integral = 0;
    for (let i = 0; i < y.length - 1; i++) if (Number.isFinite(held.values[i])) integral += held.values[i] * (t.values[i + 1] - t.values[i]);
    assert.ok(Math.abs(integral - (3 - 1)) < 1e-12, `held, it integrates back to the counter (${integral})`);
    assert.equal(held.meanRate, 2 / 70, 'the mean rate is the change over the time, weighted by time');
    assert.equal(held.minRate, 1 / 40);
    assert.equal(held.maxRate, 1 / 30);
    // The interval, held: each row carries the length of the interval it is in.
    const heldDt = run(y, { edge: 'rising', placement: 'hold' }, t);
    assertBitwise(heldDt.values, Float64Array.from([NaN, NaN, 30, 30, 30, 40, 40, 40, 40, NaN, NaN]), 'the interval held');
}
{
    // The real change, not the band: a counter that catches up three steps.
    const out = run([0, 0, 3, 3, 4], { edge: 'rising', deadband: 1, output: 'rate' }, { values: Float64Array.from([0, 60, 120, 180, 240]), kind: 'numeric' });
    assert.deepEqual(finite(out.values), [[4, 1 / 120]], 'ΔY is the change between the edges');
    assert.equal(out.minJump, 1);
    assert.equal(out.maxJump, 3, 'the catch-up jump is reported');
    // Falls in between rising edges count in the net change.
    const net = run([0, 2, 1, 3], { edge: 'rising', output: 'rate' });
    assert.deepEqual(finite(net.values), [[3, 0.5]], 'net change over the interval, per sample on an index');
    // Per hour on a date/time axis: 1 kWh every 90 minutes is 2/3 kW.
    const minutes = Float64Array.from({ length: 400 }, (_, i) => i * 60000);
    const meter = Float64Array.from(minutes, (_, i) => Math.floor(i / 90));
    const kw = computeInterarrival(meter, { values: minutes, kind: 'datetime' }, { edge: 'rising', output: 'rate', placement: 'hold', rateUnit: 'h' });
    assert.ok(finite(kw.values).every(([, v]) => Math.abs(v - 2 / 3) < 1e-12), 'kWh per hour reads in kW');
    assert.equal(finite(kw.values).length, 270, 'three complete intervals of 90 rows');
    assert.ok(Math.abs(kw.meanRate - 2 / 3) < 1e-12);
    const perMinute = computeInterarrival(meter, { values: minutes, kind: 'datetime' }, { edge: 'rising', output: 'rate', rateUnit: 'min' });
    assert.ok(Math.abs(finite(perMinute.values)[0][1] - 1 / 90) < 1e-15, 'per minute');
    // An index has no second to scale.
    const index = computeInterarrival(meter, null, { edge: 'rising', output: 'rate', rateUnit: 'h' });
    assert.equal(finite(index.values)[0][1], 1 / 90, 'per sample on an index, whatever the unit asked');
    // Two edges at one instant: no rate, and it is counted.
    const same = run([0, 1, 2], { edge: 'rising', output: 'rate' }, { values: Float64Array.from([0, 5, 5]), kind: 'numeric' });
    assert.equal(finite(same.values).length, 0, 'no rate over no time');
    assert.equal(same.zeroDtCount, 1);
    // A held interval longer than the cap is left empty, the same way in memory
    // and in chunks.
    const long = [0, 1, 1, 1, 1, 1, 1, 2, 2, 3, 3];
    const capped = computeInterarrival(long, null, { edge: 'rising', output: 'rate', placement: 'hold' }, { maxHoldRows: 3 });
    assertBitwise(capped.values, Float64Array.from([NaN, NaN, NaN, NaN, NaN, NaN, NaN, 0.5, 0.5, NaN, NaN]), 'the long interval is dropped');
    assert.equal(capped.droppedIntervals, 1);
    for (const size of [1, 2, 4]) {
        const kernel = createInterarrival({ edge: 'rising', output: 'rate', placement: 'hold' }, { kind: 'index', maxHoldRows: 3 });
        const parts = [];
        for (let at = 0; at < long.length; at += size) parts.push(...kernel.push(Float64Array.from(long.slice(at, at + size))));
        parts.push(...kernel.flush());
        assertBitwise(Float64Array.from(parts), capped.values, `capped, in chunks of ${size}`);
    }
}
{
    // Held outputs trail their inputs: the same doubles however it is cut.
    let seed = 11;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const n = 4007;
    const y = Float64Array.from({ length: n }, (_, i) => (i % 89 === 0 ? NaN : Math.floor(i / (20 + Math.floor(random() * 60))) + (i % 1500 === 1499 ? -5 : 0)));
    const tv = Float64Array.from({ length: n }, (_, i) => i * 60000 + (i % 5) * 7);
    for (const params of [
        { edge: 'rising', output: 'rate', placement: 'hold', rateUnit: 'h' },
        { edge: 'both', output: 'rate', placement: 'edge', deadband: 2 },
        { edge: 'falling', output: 'interval', placement: 'hold' },
    ]) {
        const whole = computeInterarrival(y, { values: tv, kind: 'datetime' }, params).values;
        assert.equal(whole.length, n, `${JSON.stringify(params)}: as long as the input`);
        for (const size of [1, 13, 1000]) {
            const kernel = createInterarrival(params, { kind: 'datetime' });
            const parts = [];
            for (let at = 0; at < n; at += size) parts.push(...kernel.push(y.subarray(at, at + size), tv.subarray(at, at + size)));
            parts.push(...kernel.flush());
            assertBitwise(Float64Array.from(parts), whole, `${JSON.stringify(params)} in chunks of ${size}`);
        }
        const piped = runDataToolPipeline(y, { values: tv, kind: 'datetime' }, [{ tool: 'interarrival', params }]);
        assertBitwise(piped.values, whole, `${JSON.stringify(params)} through the pipeline`);
    }
}
console.log('interarrival: the mean rate between edges, at the edge or held as stairs that integrate back to the counter');

// ── The panel's in-memory path ──────────────────────────────────────────────
const { installDataToolsMethods } = await import(new URL('../src/app/methods/data-tools-methods.js', import.meta.url));
const { installLazyDataToolsMethods } = await import(new URL('../src/app/methods/lazy-data-tools-methods.js', import.meta.url));
const { installDerivedMethods } = await import(new URL('../src/app/methods/derived-methods.js', import.meta.url));

class Harness {
    constructor() {
        this.files = new Map();
        this.activeFileId = 'f';
        this.dataToolVariablesByFile = new Map();
        this.derivedByFile = new Map();
        this.messages = [];
        this.plotManager = { files: this.files, updateFileData() {}, plots: new Map() };
        this.parser = { _detectDataType: () => 'real', _isConstantValues: () => false };
    }
}
installDataToolsMethods(Harness);
installLazyDataToolsMethods(Harness);
installDerivedMethods(Harness);
Object.assign(Harness.prototype, {
    _renderFilteredTree() {},
    _syncDataTools() {},
    _setOutlierMessage(message, type) { this.messages.push([typeof message === 'function' ? message() : message, type]); },
});
{
    const h = new Harness();
    const minutes = Float64Array.from({ length: 600 }, (_, i) => Date.UTC(2026, 9, 1) + i * 60000);
    const meter = Float64Array.from(minutes, (_, i) => 8597 + Math.floor(i / 90));
    const data = {
        metadata: { timeName: 'Time', timeKind: 'datetime' },
        variables: {
            Time: { name: 'Time', kind: 'abscissa', data: minutes, timeKind: 'datetime' },
            meter: { name: 'meter', kind: 'variable', data: meter, description: 'Energy [kWh]' },
        },
    };
    h.files.set('f', { data });
    const config = { tool: 'interarrival', params: { edge: 'rising', deadband: 1 } };
    const result = h._buildDataToolResult(meter, data.variables.meter, { ...config, sourceName: 'meter', targetName: 'meter dt_up', targetMode: 'create' }, data);
    const variable = result.variable;
    assert.equal(result.tool, 'interarrival');
    assert.equal(result.count, 5, 'six rises, five intervals');
    assert.deepEqual(finite(variable.data).map(([, v]) => v), [5400, 5400, 5400, 5400, 5400], 'every 90 minutes, in seconds');
    assert.equal(variable.eventSamples, true, 'drawn as dots');
    assert.match(variable.description, /interarrival time of meter; rising edges; deadband 1; at each edge \[s\]$/, 'its unit is the second');
    assert.equal(variable.dataTool.edge, 'rising');
    assert.equal(variable.dataTool.intervalCount, 5);
    assert.equal(variable.dataTool.meanDt, 5400);
    assert.equal(variable.displayName, 'meter dt_up');
    assert.equal(result.warning, '', 'intervals were found: no warning');
    assert.match(result.note(), /^6 edges; mean interval 1 h 30 min \(min 1 h 30 min, max 1 h 30 min\)\.$/, 'the summary');
    // None of the kind asked for: the result says so.
    const none = h._buildDataToolResult(meter, data.variables.meter, { tool: 'interarrival', params: { edge: 'falling', deadband: 0 }, sourceName: 'meter', targetName: 'x', targetMode: 'create' }, data);
    assert.equal(none.count, 0);
    assert.match(none.warning(), /^No interval: 0 falling edges found/, 'the warning names the edges');
    // A tool run on the output is a curve again, not a series of events.
    data.variables['meter dt_up'] = variable;
    const smoothed = h._buildDataToolResult(variable.data, variable, { tool: 'movingAverage', params: { window: 3 }, sourceName: 'meter dt_up', targetName: 'avg', targetMode: 'create' }, data);
    assert.equal(smoothed.variable.eventSamples, undefined, 'a moving average of it is not drawn as events');
    // Its definition survives a session.
    assert.deepEqual(h._normalizeDataToolParams('interarrival', { edge: 'rising', deadband: 1 }),
        { edge: 'rising', deadband: 1, output: 'interval', placement: 'edge', rateUnit: 's' });
    assert.equal(h._normalizeDataToolDefinition({ tool: 'interarrival', params: { edge: 'x' } }).params.edge, 'both');
    // The unit on other axes.
    assert.equal(h._interarrivalUnit({ metadata: { timeName: 't', timeKind: 'numeric' }, variables: { t: { kind: 'abscissa', description: 'Time [ms]' } } }), 'ms');
    assert.equal(h._interarrivalUnit({ metadata: { timeName: 't', timeKind: 'numeric' }, variables: { t: { kind: 'abscissa', description: 'Time' } } }), 's');
    assert.equal(h._interarrivalUnit({ metadata: { timeName: 't', timeKind: 'index' }, variables: { t: { kind: 'abscissa' } } }), '');
    assert.equal(h._interarrivalNameSuffix('rising'), 'dt_up');
    assert.equal(h._interarrivalNameSuffix('falling'), 'dt_down');
    assert.equal(h._interarrivalNameSuffix('both'), 'dt_edges');
    assert.equal(h._interarrivalNameSuffix('rising', 'rate'), 'rate_up');

    // The mean power of the meter, held over each interval: stairs, in kW.
    const power = h._buildDataToolResult(meter, data.variables.meter, {
        tool: 'interarrival', params: { edge: 'rising', deadband: 1, output: 'rate', placement: 'hold', rateUnit: 'h' },
        sourceName: 'meter', targetName: 'meter rate_up', targetMode: 'create',
    }, data);
    const held = power.variable;
    assert.ok(finite(held.data).every(([, v]) => Math.abs(v - 2 / 3) < 1e-12), '1 kWh every 90 minutes: 0.667 kW');
    assert.equal(finite(held.data).length, 450, 'every row of the five complete intervals');
    assert.ok(Number.isNaN(held.data[0]) && Number.isNaN(held.data[599]), 'NaN before the first edge and after the last');
    assert.equal(held.heldSteps, true, 'drawn as stairs');
    assert.equal(held.eventSamples, undefined, 'not as dots');
    assert.match(held.description, /mean rate between edges of meter; rising edges; deadband 1; held over each interval \[kW\]$/, 'kWh per hour is kW');
    assert.equal(held.dataTool.output, 'rate');
    assert.equal(held.dataTool.placement, 'hold');
    assert.ok(Math.abs(held.dataTool.meanRate - 2 / 3) < 1e-12);
    assert.match(power.note(), /^6 edges; mean rate 0\.6667 kW over the whole span, weighted by time \(min 0\.6667 kW, max 0\.6667 kW\)\.$/, 'the summary');
    // The app's own Integral (rectangular) of the held power gives the energy
    // back: 5 kWh between the first and the last edge, in kW·s.
    const energy = h._computeIntegralValues(held.data, data, { method: 'rectangular', gapPolicy: 'zero', initial: 0 }).values;
    assert.ok(Math.abs(energy[energy.length - 1] / 3600 - 5) < 1e-9, `the Integral tool closes the energy balance (${energy[energy.length - 1] / 3600} kWh)`);
    // A tool run on the stairs draws a curve of its own.
    const smoothedStairs = h._buildDataToolResult(held.data, held, { tool: 'movingAverage', params: { window: 3 }, sourceName: 'meter rate_up', targetName: 'avg2', targetMode: 'create' }, data);
    assert.equal(smoothedStairs.variable.heldSteps, undefined, 'a moving average of it is not stairs by default');
    // The output's unit.
    const axis = (timeKind, description) => ({ metadata: { timeName: 't', timeKind }, variables: { t: { kind: 'abscissa', description } } });
    const rate = (rateUnit) => ({ output: 'rate', rateUnit });
    assert.equal(h._interarrivalOutputUnit(axis('datetime'), rate('h'), { description: 'E [kW.h]' }), 'kW', 'kW.h per hour');
    assert.equal(h._interarrivalOutputUnit(axis('datetime'), rate('h'), { description: 'E [MWh]' }), 'MW');
    assert.equal(h._interarrivalOutputUnit(axis('datetime'), rate('min'), { description: 'E [kWh]' }), 'kWh/min');
    assert.equal(h._interarrivalOutputUnit(axis('datetime'), rate('h'), { description: 'V [m3]' }), 'm3/h');
    assert.equal(h._interarrivalOutputUnit(axis('numeric', 'Time [ms]'), rate('s'), { description: 'E [kWh]' }), 'kWh/ms', 'per the axis unit');
    assert.equal(h._interarrivalOutputUnit(axis('index'), rate('h'), { description: 'n [pulses]' }), 'pulses/sample');
    assert.equal(h._interarrivalOutputUnit(axis('datetime'), rate('h'), { description: 'no unit' }), '1/h');
    assert.equal(h._interarrivalAxisInSeconds(axis('numeric', 'Time [ms]')), false, 'a millisecond axis cannot be scaled to hours');
    assert.equal(h._interarrivalAxisInSeconds(axis('datetime')), true);
}
console.log('interarrival: the in-memory tool writes the intervals in seconds, drawn as events, with its counts');

// ── A lazy file ─────────────────────────────────────────────────────────────
const DuckDbSource = (await import(new URL('../src/data/duckdb-source.js', import.meta.url))).default;
const { streamColumns } = await import(new URL('../src/data/column-stream.js', import.meta.url));
const { runChunkedJob } = await import(new URL('../src/data/chunk-executor.js', import.meta.url));

const ROWS = 20011;
const numericLines = ['t,meter,noisy'];
const datetimeLines = ['time,meter'];
const start = Date.UTC(2026, 9, 1);
for (let i = 0; i < ROWS; i++) {
    const meter = i % 211 === 5 ? '' : String(8597 + Math.floor(i / 73) + (i % 1000 === 999 ? -3 : 0));
    const noisy = String(Math.round((Math.sin(i / 50) * 10 + ((i * 7919) % 13) / 13) * 1000) / 1000);
    numericLines.push(`${(i * 60).toFixed(0)},${meter},${noisy}`);
    const stamp = new Date(start + i * 60000).toISOString().slice(0, 19).replace('T', ' ');
    datetimeLines.push(`${stamp},${meter}`);
}
const generatedProfile = {
    delimiter: ',',
    decimalSeparator: '.',
    rawHeaders: ['t', 'meter', 'noisy'],
    headers: [{ name: 't' }, { name: 'meter' }, { name: 'noisy' }],
    dataStartIndex: 1,
    numericColumnIndexes: [1, 2],
    sampleRows: [],
    timeSource: { ok: true, strategy: 'generated-index', name: 'index' },
};

const require = createRequire(import.meta.url);
const esmArrow = await import('apache-arrow');
const arrowPath = require.resolve('apache-arrow');
require.cache[arrowPath] = { id: arrowPath, filename: arrowPath, loaded: true, exports: esmArrow };
const duckdb = require('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs');
const dist = path.dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));
const db = await duckdb.createDuckDB({
    mvp: { mainModule: path.join(dist, 'duckdb-mvp.wasm'), mainWorker: '' },
    eh: { mainModule: path.join(dist, 'duckdb-eh.wasm'), mainWorker: '' },
}, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
await db.instantiate();
db.open({});
db.registerFileText('numeric.csv', numericLines.join('\n') + '\n');
db.registerFileText('datetime.csv', datetimeLines.join('\n') + '\n');
const duck = new DuckDbSource();
duck._db = db;
duck._conn = db.connect();

let tableId = 0;
const loadLazy = (handle, csvProfile = null) =>
    duck._loadIntoLegacy(handle, `omv_interarrival_${tableId++}`, { lazy: true, overviewPoints: 300, format: 'csv', csvProfile });
async function eagerFrom(lazy) {
    const names = Object.keys(lazy.variables).filter(name => name !== lazy.metadata.timeName);
    const chunks = [];
    for await (const chunk of streamColumns(lazy, names)) chunks.push(chunk);
    const concat = (pick) => {
        const out = new Float64Array(chunks.reduce((n, c) => n + c.x.length, 0));
        let at = 0;
        for (const c of chunks) { const part = pick(c); out.set(part, at); at += part.length; }
        return out;
    };
    const data = structuredClone({ metadata: lazy.metadata, variables: Object.fromEntries(
        Object.entries(lazy.variables).map(([name, variable]) => [name, { ...variable, data: null }])) });
    data.variables[lazy.metadata.timeName].data = concat(c => c.x);
    for (const name of names) data.variables[name].data = concat(c => c.yByVar.get(name));
    return data;
}
const app = (data) => { const h = new Harness(); h.files.set('f', { data }); return h; };
async function create(h, sourceName, outputName, config) {
    const data = h.files.get('f').data;
    return h._applyLazyDataToolCreateMode({
        fileId: 'f', data, sourceName, sourceVariable: data.variables[sourceName], outputName,
        targetMode: 'create', tool: config.tool, lazy: true,
    }, config, { silent: true });
}
async function readAll(data, name) {
    const out = [];
    for await (const chunk of streamColumns(data, [name])) out.push(...chunk.yByVar.get(name));
    return Float64Array.from(out);
}
const pending = (h) => Promise.all([...(h._lazyToolStatsPending || [])]);

for (const [label, handle, profile, expectKind] of [
    ['numeric axis', 'numeric.csv', null, 'numeric'],
    ['date/time axis', 'datetime.csv', null, 'datetime'],
    ['generated axis', 'numeric.csv', generatedProfile, 'index'],
]) {
    const lazy = await loadLazy(handle, profile);
    const eager = await eagerFrom(lazy);
    const h = app(lazy);
    const eh = app(eager);
    assert.equal(h._lazyToolTimeAxis(lazy).kind, expectKind, `${label}: the axis the lazy kernel reads`);
    assert.equal(eh._getDataToolTimeContext(eager, ROWS).kind, expectKind, `${label}: the axis the in-memory kernel reads`);
    const sources = Object.keys(lazy.variables).filter(name => name !== lazy.metadata.timeName);
    for (const source of sources) {
        for (const params of [
            { edge: 'both', deadband: 0 },
            { edge: 'rising', deadband: 2 },
            { edge: 'falling', deadband: 0.5 },
            { edge: 'rising', deadband: 1, output: 'rate', placement: 'hold', rateUnit: 'h' },
            { edge: 'both', deadband: 0, output: 'rate', placement: 'edge' },
            { edge: 'rising', deadband: 0, output: 'interval', placement: 'hold' },
        ]) {
            const name = `${source} ${params.edge} ${params.deadband} ${params.output || ''} ${params.placement || ''}`;
            const result = await create(h, source, name, { tool: 'interarrival', params });
            assert.equal(result?.name, name, `${label} ${name}: created`);
            const variable = lazy.variables[name];
            assert.ok(variable._duckdbExpr && variable._duckdbWindows?.[0]?.sink, `${label} ${name}: reads a sink`);
            const heldOutput = params.placement === 'hold';
            assert.equal(!!variable.eventSamples, !heldOutput, `${label} ${name}: dots at the edge`);
            assert.equal(!!variable.heldSteps, heldOutput, `${label} ${name}: stairs when held`);
            const expected = eh._computeInterarrivalValues(eager.variables[source].data, eager, params);
            assertBitwise(await readAll(lazy, name), expected.values, `${label} ${name}`);
            assert.equal(result.count, expected.intervalCount, `${label} ${name}: the interval count`);
            assert.equal(variable.dataTool.edgeCount, expected.edgeCount, `${label} ${name}: the edge count`);
            assert.equal(variable.dataTool.meanDt, expected.meanDt, `${label} ${name}: the mean interval`);
            assert.equal(variable.dataTool.meanRate, expected.meanRate, `${label} ${name}: the mean rate`);
            assert.equal(variable.description, eh._buildDataToolResult(eager.variables[source].data, eager.variables[source],
                { tool: 'interarrival', params, sourceName: source, targetName: name, targetMode: 'create' }, eager).variable.description,
            `${label} ${name}: the same description, unit included`);
            assert.equal(h._interarrivalUnit(lazy), eh._interarrivalUnit(eager), `${label}: the same unit`);
        }
    }
    // Through the executor in small chunks, held outputs trailing their rows.
    for (const params of [{ edge: 'rising', deadband: 1 }, { edge: 'rising', deadband: 1, output: 'rate', placement: 'hold', rateUnit: 'h' }]) {
        const expected = eh._computeInterarrivalValues(eager.variables.meter.data, eager, params).values;
        for (const chunkRows of [1, 777]) {
            const sink = await duck.createSink(lazy);
            const kernel = h._lazySinkKernel(lazy, { tool: 'interarrival', sourceName: 'meter', params });
            await runChunkedJob({ data: lazy, sourceNames: ['meter'], kernel, sink, withTime: !!kernel.withTime, chunkRows });
            lazy.variables.cut = { ...lazy.variables.meter, _duckdbExpr: `"${sink.columns[0].column}"`, _duckdbWindows: [sink.columns[0]] };
            delete lazy.variables.cut._duckdbCol;
            assertBitwise(await readAll(lazy, 'cut'), expected, `${label} ${params.placement || 'edge'}: chunks of ${chunkRows}`);
            delete lazy.variables.cut;
            await duck.dropSink(lazy, sink.table);
        }
    }
    if (label === 'numeric axis') {
        // A session restores the definition and runs the job again.
        const params = { edge: 'rising', deadband: 1 };
        await create(h, 'meter', 'restored', { tool: 'interarrival', params });
        const saved = h._serializeDataToolDefinitions('f').find(item => item.name === 'restored');
        assert.deepEqual(saved.params, normalizeInterarrivalParams(params), 'the session keeps the parameters');
        const again = await loadLazy(handle, profile);
        const rh = app(again);
        rh.dataToolVariablesByFile.set('f', new Map([['restored', { ...saved, variable: null }]]));
        rh._reapplyDataToolVariables('f', again);
        await pending(rh);
        assert.ok(again.variables.restored._duckdbWindows?.[0]?.sink, 'the job ran again');
        assertBitwise(await readAll(again, 'restored'), eh._computeInterarrivalValues(eager.variables.meter.data, eager, params).values, 'restored');
        await duck.release(again);
    }
    await duck.release(lazy);
}
console.log('interarrival: a lazy file gets the kernel\'s own intervals and rates, at the edge and held, on numeric, date/time and generated axes, and again from a session');
