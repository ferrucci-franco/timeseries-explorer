// A reload takes off the panels what the file no longer has.
//
// Reload a file whose source lost a column and the panels kept their traces
// for it: the trace builder returns null for a variable that is not there, so
// the curve vanished, but the entry stayed — in the panel's state, in its
// legend menu, in the panel statistics and in any view saved afterwards, with
// nothing to say why the curve had gone. A panel whose traces were ALL for
// gone variables was worse: content is counted as traces.length, so it went on
// claiming to have some while drawing nothing.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { dropMissingVariablesFromPanels } from '../src/utils/panel-variables.js';

const FILE = 'f1';
const OTHER = 'f2';
const presentIn = (...names) => (name) => names.includes(name);

const panel = (id, plot) => [id, { traces: [], phaseTraces: [], ...plot }];
const trace = (varName, fileId = FILE) => ({ fileId, varName, color: '#000' });
const pair = (x, y, z = null, fileId = FILE) => ({ fileId, x, y, z });

// ─── A trace whose variable is gone ────────────────────────────────
{
    const plots = new Map([panel('p1', { traces: [trace('a'), trace('b')] })]);
    const { dropped, panels } = dropMissingVariablesFromPanels(plots, FILE, presentIn('time', 'a'));
    assert.deepEqual(dropped, ['b'], 'the name is reported, so the user can be told');
    assert.deepEqual([...panels], ['p1'], 'and the panel is redrawn');
    assert.deepEqual(plots.get('p1').traces.map(t => t.varName), ['a'], 'only the survivor is left');
}

// ─── Every trace gone: the panel must end up honestly empty ────────
{
    const plots = new Map([panel('p1', { traces: [trace('a'), trace('b')] })]);
    const { dropped } = dropMissingVariablesFromPanels(plots, FILE, presentIn('time', 'c'));
    assert.deepEqual(dropped, ['a', 'b']);
    assert.equal(plots.get('p1').traces.length, 0, 'an empty panel, not one that claims content and draws nothing');
}

// ─── Another file's traces are not ours to judge ───────────────────
{
    const plots = new Map([panel('p1', { traces: [trace('b'), trace('b', OTHER)] })]);
    const { dropped } = dropMissingVariablesFromPanels(plots, FILE, presentIn('time'));
    assert.deepEqual(dropped, ['b']);
    assert.deepEqual(plots.get('p1').traces.map(t => t.fileId), [OTHER],
        'the same name in another file keeps its trace');
}

// ─── A phase pair needs both axes ──────────────────────────────────
{
    const plots = new Map([panel('p1', { phaseTraces: [pair('a', 'b'), pair('a', 'a')] })]);
    const { dropped, panels } = dropMissingVariablesFromPanels(plots, FILE, presentIn('a'));
    assert.deepEqual(dropped, ['b'], 'only the missing half is named');
    assert.equal(plots.get('p1').phaseTraces.length, 1, 'the pair goes whole rather than half-drawn');
    assert.deepEqual([...panels], ['p1']);
}
{
    // 3-D: the third axis counts too.
    const plots = new Map([panel('p1', { phaseTraces: [pair('a', 'b', 'c')] })]);
    const { dropped } = dropMissingVariablesFromPanels(plots, FILE, presentIn('a', 'b'));
    assert.deepEqual(dropped, ['c']);
    assert.equal(plots.get('p1').phaseTraces.length, 0);
}

// ─── A state vector needs all of its components ────────────────────
{
    const plots = new Map([panel('p1', {
        stateSlots: { fileId: FILE, x: ['x', 'y', 'z'], dx: ['der(x)', null, 'der(z)'] },
    })]);
    const { dropped, panels } = dropMissingVariablesFromPanels(
        plots, FILE, presentIn('x', 'y', 'der(x)', 'der(z)'),
    );
    assert.deepEqual(dropped, ['z'], 'the missing component is named');
    assert.deepEqual(plots.get('p1').stateSlots.x, [], 'and the vector is emptied, not left one axis short');
    assert.deepEqual(plots.get('p1').stateSlots.dx, []);
    assert.equal(plots.get('p1').stateSlots.fileId, FILE, 'the panel still belongs to its file');
    assert.deepEqual([...panels], ['p1']);
}
{
    // A null derivative slot is not a missing variable — it is an empty slot.
    const plots = new Map([panel('p1', { stateSlots: { fileId: FILE, x: ['x', 'y'], dx: [null, null] } })]);
    const { dropped, panels } = dropMissingVariablesFromPanels(plots, FILE, presentIn('x', 'y'));
    assert.deepEqual(dropped, []);
    assert.equal(panels.size, 0, 'nothing changed, so nothing is redrawn');
    assert.deepEqual(plots.get('p1').stateSlots.x, ['x', 'y']);
}

// ─── Nothing missing, nothing touched ──────────────────────────────
{
    const traces = [trace('a'), trace('b')];
    const plots = new Map([panel('p1', { traces })]);
    const { dropped, panels } = dropMissingVariablesFromPanels(plots, FILE, presentIn('a', 'b'));
    assert.deepEqual(dropped, []);
    assert.equal(panels.size, 0);
    assert.equal(plots.get('p1').traces, traces, 'the array is not even replaced');
}

// ─── Several panels, one report ────────────────────────────────────
{
    const plots = new Map([
        panel('p1', { traces: [trace('b')] }),
        panel('p2', { traces: [trace('b'), trace('a')] }),
        panel('p3', { traces: [trace('a')] }),
    ]);
    const { dropped, panels } = dropMissingVariablesFromPanels(plots, FILE, presentIn('a'));
    assert.deepEqual(dropped, ['b'], 'named once however many panels drew it');
    assert.deepEqual([...panels].sort(), ['p1', 'p2'], 'and only the panels that changed are redrawn');
}

// ─── Wired into the reload ─────────────────────────────────────────
const manager = readFileSync(new URL('../src/plots/plot-manager.js', import.meta.url), 'utf8');
const files = readFileSync(new URL('../src/app/methods/file-methods.js', import.meta.url), 'utf8');
const translations = readFileSync(new URL('../src/i18n/translations.js', import.meta.url), 'utf8');

assert.match(manager, /const \{ dropped, panels \} = this\._dropTracesForMissingVariables\(fileId, newData\);/,
    'updateFileData prunes before it rebuilds');
assert.match(manager, /if \(!uses && !panels\.has\(panelId\)\) continue;/,
    'a panel that just lost its last trace is redrawn even though it no longer uses the file');
assert.match(manager, /return dropped;\s*\n\s*\}/, 'and hands the names back to the caller');
assert.match(files, /const dropped = this\.plotManager\.updateFileData\(id, data\);/, 'which the reload keeps');
assert.match(files, /this\._reportReloadOutcome\(droppedTraces, datasetFailures\);/,
    'and reports once the loading overlay is down, so the dialog is not behind it');
for (const key of ['reloadDroppedTracesTitle', 'reloadDroppedTracesBody']) {
    assert.equal([...translations.matchAll(new RegExp(`${key}:`, 'g'))].length, 4, `${key} in four languages`);
}

console.log('Reload dropped-trace checks passed.');
