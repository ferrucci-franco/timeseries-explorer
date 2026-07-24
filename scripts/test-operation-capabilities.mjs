// Tests for _operationCapabilities sampling predicates (design §4.2): monotonic,
// uniform, and supportsFrequencyHz derived from the transformed time vector.
// These are the Phase-4 mode contracts' foundation (FFT needs monotonic+uniform;
// Hz additionally needs a physical unit). Uses the same lightweight harness as
// test-time-axis-model, but with real `data` arrays so the regularity scan runs.
import assert from 'node:assert/strict';
import { installPlotDataMethods } from '../src/plots/methods/data-methods.js';

class Harness {
    constructor() { this.files = new Map(); this.language = 'en'; }
    _getTimeVar(fileId) {
        const d = this.files.get(fileId)?.data;
        if (!d) return null;
        return Object.values(d.variables).find(v => v.kind === 'abscissa') || null;
    }
    _extractUnit(description) {
        if (!description) return '';
        const m = description.match(/\[([^\]]+)\]/);
        if (!m) return '';
        const parts = m[1].split('|');
        return (parts[1] ?? parts[0]).trim();
    }
}
installPlotDataMethods(Harness);

function makeFile({ timeVar, data, transform = {} }) {
    return {
        data: { variables: { [timeVar.name]: { kind: 'abscissa', data, ...timeVar } } },
        transform,
    };
}

const h = new Harness();
h.files.set('uniform',     makeFile({ timeVar: { name: 't', timeKind: 'numeric', description: 'time [s]' }, data: [0, 0.1, 0.2, 0.3, 0.4] }));
h.files.set('nonuniform',  makeFile({ timeVar: { name: 't', timeKind: 'numeric', description: 'time [s]' }, data: [0, 0.1, 0.3, 0.35] }));
h.files.set('nonmonotone', makeFile({ timeVar: { name: 't', timeKind: 'numeric', description: 'time [s]' }, data: [0, 1, 0.5, 2] }));
h.files.set('cal',         makeFile({ timeVar: { name: 't', timeKind: 'datetime', timeDisplayMode: 'calendar' }, data: [1000, 2000, 3000, 4000] }));
h.files.set('short',       makeFile({ timeVar: { name: 't', timeKind: 'numeric', description: 'time [s]' }, data: [0, 1] }));

const cap = id => h._operationCapabilities(id);

// Uniform, strictly increasing numeric ⇒ Hz-capable.
assert.equal(cap('uniform').isMonotonic, true);
assert.equal(cap('uniform').isUniform, true);
assert.equal(cap('uniform').hasPhysicalTimeUnit, true);   // numeric = elapsed seconds
assert.equal(cap('uniform').supportsFrequencyHz, true);

// Monotonic but irregular spacing ⇒ no Hz.
assert.equal(cap('nonuniform').isMonotonic, true);
assert.equal(cap('nonuniform').isUniform, false);
assert.equal(cap('nonuniform').supportsFrequencyHz, false);

// Not monotonic ⇒ neither uniform nor Hz.
assert.equal(cap('nonmonotone').isMonotonic, false);
assert.equal(cap('nonmonotone').isUniform, false);
assert.equal(cap('nonmonotone').supportsFrequencyHz, false);

// A uniform gregorian calendar axis is monotonic+uniform and (being absolute)
// has a physical time unit, so it too supports Hz.
assert.equal(cap('cal').hasGregorianCalendar, true);
assert.equal(cap('cal').isMonotonic, true);
assert.equal(cap('cal').isUniform, true);
assert.equal(cap('cal').supportsFrequencyHz, true);

// Fewer than 3 points ⇒ uniformity is unknown (null), never a false claim.
assert.equal(cap('short').isUniform, null);
assert.equal(cap('short').supportsFrequencyHz, false);

// Backward compatibility: the original fields are unchanged.
assert.equal(cap('uniform').hasElapsed, true);
assert.equal(cap('cal').hasElapsed, true);

console.log('Operation-capabilities sampling-predicate tests passed.');
