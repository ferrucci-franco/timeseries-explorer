// 'Reset layout' stayed clickable on an empty app (#49): it opened a
// confirmation for work that could not exist, since every panel was already
// blank. It now switches off with the rest of the top bar. The other half of
// the same report: a split arrangement must not outlive the files it was built
// for, so closing the last one drops back to a single panel.
//
//   node scripts/test-reset-layout-availability.mjs

import assert from 'node:assert/strict';
import { installFileMethods } from '../src/app/methods/file-methods.js';

const TOP_BAR_IDS = [
    'reload-file', 'auto-zoom', 'clear-plots', 'reset-layout',
    'reload-as-version-toggle', 'reload-as-version-switch', 'drop-zone',
];

const makeDocumentStub = () => {
    const elements = new Map(TOP_BAR_IDS.map(id => [id, {
        id,
        disabled: false,
        classes: new Set(),
        classList: {
            add(name) { elements.get(id).classes.add(name); },
            remove(name) { elements.get(id).classes.delete(name); },
            toggle(name, on) { on ? this.add(name) : this.remove(name); },
            contains(name) { return elements.get(id).classes.has(name); },
        },
    }]));
    return { elements, getElementById: (id) => elements.get(id) ?? null };
};

const split = () => ({
    type: 'split', id: 's1', direction: 'v', ratio: 0.5,
    children: [{ type: 'panel', id: 'p1' }, { type: 'panel', id: 'p2' }],
});

class Harness {
    constructor({ fileIds = ['f1'], root = split() } = {}) {
        this.files = new Map(fileIds.map(id => [id, { name: `${id}.csv`, extension: '.csv', transform: {} }]));
        this.derivedByFile = new Map();
        this._expandedFileTransforms = new Set();
        this.resetCalls = 0;
        this.layoutManager = {
            root,
            reset: () => { this.layoutManager.root = { type: 'panel', id: 'fresh' }; this.resetCalls++; },
        };
        this.plotManager = {
            activeFileId: fileIds[0] ?? null,
            files: new Map(fileIds.map(id => [id, { data: null }])),
            hasTracesForFile: () => false,
            removeFile: (fileId) => {
                this.plotManager.files.delete(fileId);
                if (this.plotManager.activeFileId === fileId) {
                    this.plotManager.activeFileId = [...this.plotManager.files.keys()][0] ?? null;
                }
            },
        };
        this._clearVariableSelection = () => {};
        this.renderVariablesTree = () => {};
        this._updateTopBar = () => {};
        this._renderFilesList = () => {};
    }
}
installFileMethods(Harness);

const withDocumentStub = async (fn) => {
    const previous = globalThis.document;
    const stub = makeDocumentStub();
    globalThis.document = stub;
    try { return await fn(stub); } finally { globalThis.document = previous; }
};

let checks = 0;
const check = async (fn) => { await fn(); checks++; };

// ── The button follows the rest of the top bar ────────────────────────────

await check(() => withDocumentStub(({ elements }) => {
    const h = new Harness({ fileIds: [] });
    h._updateActionButtons();
    assert.equal(elements.get('reset-layout').disabled, true,
        'no file loaded: Reset layout is off');
    assert.equal(elements.get('clear-plots').disabled, true,
        'and its neighbours stay off too');
}));

await check(() => withDocumentStub(({ elements }) => {
    const h = new Harness({ fileIds: ['f1'] });
    h._updateActionButtons();
    assert.equal(elements.get('reset-layout').disabled, false,
        'a loaded file gives Reset layout something to do');
}));

// ── The arrangement does not outlive the last file ───────────────────────

await check(() => withDocumentStub(async () => {
    const h = new Harness({ fileIds: ['f1'] });
    await h.removeFile('f1');
    assert.equal(h.resetCalls, 1, 'closing the last file resets the layout');
    assert.equal(h.layoutManager.root.type, 'panel', 'back to a single panel');
}));

await check(() => withDocumentStub(async () => {
    const h = new Harness({ fileIds: ['f1', 'f2'] });
    await h.removeFile('f1');
    assert.equal(h.resetCalls, 0, 'a file left means the arrangement is still in use');
    assert.equal(h.layoutManager.root.type, 'split', 'so the split survives');
}));

await check(() => withDocumentStub(async () => {
    const h = new Harness({ fileIds: ['f1'], root: { type: 'panel', id: 'p1' } });
    await h.removeFile('f1');
    assert.equal(h.resetCalls, 0, 'a single panel is already the reset state: no re-render');
}));

await check(() => withDocumentStub(async () => {
    const h = new Harness({ fileIds: ['f1'] });
    await h.removeFile('f1', { cascade: true });
    assert.equal(h.resetCalls, 0, 'a cascaded close leaves the panels to the close that started it');
}));

// ── The empty app is disabled again after the last close ─────────────────

await check(() => withDocumentStub(async ({ elements }) => {
    const h = new Harness({ fileIds: ['f1'] });
    h._updateActionButtons();
    assert.equal(elements.get('reset-layout').disabled, false);
    await h.removeFile('f1');
    assert.equal(elements.get('reset-layout').disabled, true,
        'closing the last file switches Reset layout back off');
}));

console.log(`reset-layout availability: ${checks} checks passed.`);
