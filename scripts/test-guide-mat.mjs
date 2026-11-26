// The simulation results the "Load as new" demo builds in the browser
// (src/ui/guide-om-result.js), read back with the app's own OpenModelica
// parser (src/parsers/mat-parser.js).
//
// The demo stands or falls on these bytes being a real OpenModelica result:
// the file is loaded by the app under test, and a reader who looks at the
// variable tree should see what OMEdit shows — the model's variables with
// their units, the parameters, der(...) next to its state. A wrong matrix
// layout would not throw; it would quietly produce a tree of nonsense that
// only a person watching the demo would notice.
//
// Run with `npm run test:guide-mat`. No browser.
import assert from 'node:assert/strict';

import MatParser from '../src/parsers/mat-parser.js';
import { pendulumResultMat, PENDULUM_RUNS } from '../src/ui/guide-om-result.js';

const parse = async (bytes) => {
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return new MatParser().parse(buffer);
};

const near = (actual, expected, tolerance, what) =>
    assert.ok(Math.abs(actual - expected) <= tolerance,
        `${what}: ${actual} is not within ${tolerance} of ${expected}`);

// ── A run reads back as the OpenModelica result it claims to be ──
const first = await parse(pendulumResultMat({ b: PENDULUM_RUNS[0] }));

assert.equal(first.metadata.binTrans, true, 'written the way OMEdit writes: binTrans');
assert.equal(first.metadata.timeName, 'time');
assert.equal(first.metadata.timeStart, 0);
assert.equal(first.metadata.timeEnd, 20);
assert.equal(first.metadata.numTimesteps, 1001, '20 s every 0.02 s');
assert.equal(first.metadata.numParams, 6);
assert.equal(first.metadata.numTimevarying, 11);

assert.deepEqual(Object.keys(first.variables), [
    'time', 'omega', 'theta', 'der(omega)', 'der(theta)', 'Ekin', 'Epot', 'Etot',
    'omega_deg_s', 'theta_deg', 'x', 'y',
    'L', 'b', 'g', 'm', 'omega0_deg', 'theta0_deg',
], 'the variables of ExampleSimplePendulum, in the order a result file lists them');

assert.equal(first.variables.theta.kind, 'variable');
assert.equal(first.variables.b.kind, 'parameter');
assert.equal(first.variables.time.kind, 'abscissa');

// The unit the tree shows comes from the description.
assert.equal(first.variables.theta.description, 'Angle [rad]');
assert.equal(first.variables.b.description, 'Viscous rotational damping (N.m.s) [N.m.s/rad]');

// der(theta) is grouped with theta in the tree, as in a result from OMEdit.
const tree = JSON.stringify(first.tree);
assert.ok(tree.includes('der(theta)'), 'der(theta) is in the tree');

// ── The physics is the model's, not a drawing ──
const theta = first.variables.theta.data;
const omega = first.variables.omega.data;
const time = first.variables.time.data;

near(theta[0], 45 * Math.PI / 180, 1e-12, 'theta starts at theta0_deg');
near(omega[0], 0, 1e-12, 'omega starts at rest');
near(time[1] - time[0], 0.02, 1e-12, 'the sample interval');
assert.deepEqual([...first.variables['der(theta)'].data], [...omega], 'der(theta) is omega');

// A damped pendulum: the swing decays, and the energy never grows.
const peak = (values) => Math.max(...values.map(Math.abs));
const early = peak(theta.slice(0, 100));
const late = peak(theta.slice(-100));
assert.ok(late < early * 0.6, `the swing decays (${late} vs ${early})`);
const energy = first.variables.Etot.data;
assert.ok(energy.every((value, i) => i === 0 || value <= energy[i - 1] + 1e-9), 'the energy never grows');

// Small swings: the period is the one the pendulum's length gives, 2π√(L/g).
const crossings = [];
for (let i = 1; i < theta.length; i++) {
    if (theta[i - 1] > 0 && theta[i] <= 0) crossings.push(time[i]);
}
assert.ok(crossings.length > 4, 'the pendulum swings several times');
const period = (crossings.at(-1) - crossings[0]) / (crossings.length - 1);
near(period, 2 * Math.PI * Math.sqrt(1 / 9.81), 0.06, 'the period of a 1 m pendulum');

// ── The three runs differ only by the parameter the demo changes ──
const runs = [];
for (const b of PENDULUM_RUNS) runs.push(await parse(pendulumResultMat({ b })));

for (const [i, run] of runs.entries()) {
    assert.equal(run.variables.b.data[0], PENDULUM_RUNS[i], 'the parameter the demo typed');
    assert.equal(run.variables.L.data[0], 1);
    assert.equal(run.variables.theta0_deg.data[0], 45);
}

const decay = runs.map((run) => peak(run.variables.theta.data.slice(-100)));
for (let i = 1; i < decay.length; i++) {
    assert.ok(decay[i] < decay[i - 1],
        `more damping, a smaller swing left at the end (b=${PENDULUM_RUNS[i]}: ${decay[i]} vs ${decay[i - 1]})`);
}

// Overlaying them is only worth watching if the curves are plainly apart.
assert.ok(decay[0] > decay[2] * 2.5, 'the three runs are clearly different curves');

// Two runs of the same parameter are the same bytes: a reload finds a changed
// file only when the demo actually changed something.
const again = pendulumResultMat({ b: PENDULUM_RUNS[0] });
const once = pendulumResultMat({ b: PENDULUM_RUNS[0] });
assert.deepEqual([...again], [...once], 'the same run twice gives the same file');
assert.notDeepEqual([...pendulumResultMat({ b: PENDULUM_RUNS[1] })], [...once], 'another run gives another file');

console.log(`guide simulation results: ${PENDULUM_RUNS.length} runs, read back by the OpenModelica parser — ok`);
