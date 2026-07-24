// Regression tests for OpenModelica/Dymola .mat unit extraction.
//
// Dymola encodes a variable's unit together with its own metadata inside the
// description bracket, e.g. "Discrete PI state [rad/s:#(clock=_Clocks.…)]". The
// real unit is only the part before the first ":#"; the ":#(type=…)"/":#(clock=…)"
// tail must be stripped. Before the fix that whole tail leaked into the tree row
// and axis labels, so the variable rows read as unreadable garbage (the reported
// "variable names are not detected" symptom) while OpenModelica — which writes
// plain descriptions — rendered correctly. Fixtures are the same clocked model
// simulated in both tools:
//   clocked-dymola.mat        (Dymola,       time "Time", 601 samples)
//   clocked-openmodelica.mat  (OpenModelica, time "time", 660 samples)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import MatParser from '../src/parsers/mat-parser.js';

const fixture = name => {
    const bytes = readFileSync(new URL(`../test-files/matlab/${name}`, import.meta.url));
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
};

// ---- Dymola: units carry ":#(...)" metadata that must be stripped -----------
{
    const parser = new MatParser();
    const res = await parser.parse(fixture('clocked-dymola.mat'));
    assert.equal(res.metadata.timeName, 'Time', 'Dymola time axis is "Time"');

    // Variable names are recovered and nest under the PI component.
    for (const leaf of ['u', 'x', 'y', 'Ts', 'x_previous']) {
        assert.ok(res.variables[`PI.${leaf}`], `Dymola PI.${leaf} is detected`);
        assert.ok(res.tree._children.PI._variables[leaf], `Dymola PI.${leaf} nests under the PI node`);
    }

    // The unit shown for each variable is clean (no clock/type metadata leaks).
    assert.equal(parser._extractUnit(res.variables['PI.u'].description), ' [rad/s]', 'PI.u unit is rad/s');
    assert.equal(parser._extractUnit(res.variables['PI.Ts'].description), ' [s]', 'PI.Ts unit is s');
    assert.equal(parser._extractUnit(res.variables['PI.y'].description), '', 'PI.y has no display unit');
    assert.equal(parser.getVariableInfo(res.variables['PI.x']), '[601 pts] [rad/s] (real)', 'PI.x row is clean');

    // No description-derived label may contain Dymola metadata markers.
    for (const v of Object.values(res.variables)) {
        const info = parser.getVariableInfo(v);
        assert.ok(!/:#|clock=|type=/.test(info), `no metadata leaks into "${v.name}" row: ${info}`);
    }
}

// ---- OpenModelica: plain descriptions still render correctly -----------------
{
    const parser = new MatParser();
    const res = await parser.parse(fixture('clocked-openmodelica.mat'));
    assert.equal(res.metadata.timeName, 'time', 'OpenModelica time axis is "time"');
    for (const leaf of ['u', 'x', 'y']) {
        assert.ok(res.tree._children.PI._variables[leaf], `OpenModelica PI.${leaf} nests under the PI node`);
    }
    // These OpenModelica PI descriptions carry no unit bracket at all.
    assert.equal(parser.getVariableInfo(res.variables['PI.u']), '[660 pts] (real)', 'OpenModelica PI.u row is clean');
    // Plain OpenModelica units keep working (unchanged by the Dymola strip).
    assert.equal(parser._extractUnit(res.variables['load.w'].description), ' [rad/s]', 'OpenModelica keeps normal units');
}

// ---- Unit-string cases (focused, tool-independent) ---------------------------
{
    const parser = new MatParser();
    const u = d => parser._extractUnit(`desc ${d}`);
    assert.equal(u('[rad/s:#(clock=_Clocks.BaseClock_0.SubClock_1.activationCount)]'), ' [rad/s]', 'strip clock metadata');
    assert.equal(u('[s:#(clock=x)]'), ' [s]', 'strip clock metadata, keep s');
    assert.equal(u('[:#(type=Boolean)]'), '', 'a pure type-metadata bracket yields no unit');
    assert.equal(u('[:#(type=Clock):#(clock=x)]'), '', 'chained metadata yields no unit');
    assert.equal(u('[rad|deg]'), ' [deg]', 'OpenModelica SIunit|displayUnit still prefers displayUnit');
    assert.equal(u('[N.m]'), ' [N.m]', 'a plain unit is unchanged');
    assert.equal(u('[s]'), ' [s]', 'a plain SI unit is unchanged');
}

// ---- The axis-label copy in PlotManager applies the same strip ---------------
{
    const source = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
    assert.match(source, /split\(':#'\)/, 'PlotManager._extractUnit strips Dymola ":#" metadata for axis labels');
}

console.log('Modelica/Dymola unit-extraction tests passed.');
