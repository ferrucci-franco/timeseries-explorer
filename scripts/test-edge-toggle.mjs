// The control that collapses a panel from its own border.
//
// Both panels could already be collapsed, but only from a toolbar somewhere
// else on screen. This adds a second way in — and a second way in is only
// worth having if the two can never disagree about the state, and if it costs
// the layout nothing: the divider it straddles must keep the width it had.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import translations from '../src/i18n/translations.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// ─── A DOM small enough to run the module against ──────────────────
// Not a browser: just the handful of things edge-toggle.js touches, so the
// behaviour below is the module's own and not a description of it.
class FakeClassList {
    constructor() { this.set = new Set(); }
    add(...names) { names.forEach(n => this.set.add(n)); }
    toggle(name, force) {
        const on = force === undefined ? !this.set.has(name) : !!force;
        if (on) this.set.add(name); else this.set.delete(name);
        return on;
    }
    contains(name) { return this.set.has(name); }
}

class FakeElement {
    constructor(tag) {
        this.tagName = tag.toUpperCase();
        this.classList = new FakeClassList();
        this.dataset = {};
        this.attributes = {};
        this.children = [];
        this.listeners = new Map();
        this.innerHTML = '';
    }
    set className(value) { this._class = value; this.classList.set = new Set(String(value).split(/\s+/).filter(Boolean)); }
    get className() { return [...this.classList.set].join(' '); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    appendChild(child) { this.children.push(child); return child; }
    addEventListener(type, handler) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(handler);
    }
    dispatch(type, event = {}) {
        const fired = { defaultPrevented: false, propagationStopped: false };
        const detail = {
            ...event,
            preventDefault: () => { fired.defaultPrevented = true; },
            stopPropagation: () => { fired.propagationStopped = true; },
        };
        for (const handler of this.listeners.get(type) || []) handler(detail);
        return fired;
    }
    querySelector(selector) {
        const wanted = selector.replace(/^\./, '');
        const walk = (node) => {
            for (const child of node.children) {
                if (child.classList.contains(wanted)) return child;
                const found = walk(child);
                if (found) return found;
            }
            return null;
        };
        return walk(this);
    }
}

const originalDocument = globalThis.document;
globalThis.document = {
    createElement: (tag) => new FakeElement(tag),
    querySelectorAll: () => [],
    getElementById: () => null,
    title: '',
};

try {
    const { createEdgeToggle, syncEdgeToggle } = await import('../src/ui/edge-toggle.js');

    let toggles = 0;
    const rail = createEdgeToggle({
        side: 'right',
        collapsed: false,
        hideKey: 'edgeHideOptions',
        showKey: 'edgeShowOptions',
        onToggle: () => { toggles++; },
    });
    const button = rail.querySelector('.edge-toggle');

    assert.ok(rail.classList.contains('edge-toggle-rail'), 'the rail carries its class');
    assert.ok(rail.classList.contains('edge-toggle-rail-right'), 'and which side the panel is on');
    assert.ok(button, 'the rail holds the button');
    assert.equal(button.tagName, 'BUTTON', 'a real button, so it is reachable from the keyboard');
    assert.equal(button.type, 'button', "and type=button, so it never submits anything it happens to sit inside");
    assert.match(button.innerHTML, /<svg[\s\S]*<\/svg>/, 'the chevron is drawn, not typed as a glyph');

    // Expanded: it offers to hide, and says the panel is open.
    assert.equal(button.getAttribute('aria-expanded'), 'true');
    assert.equal(button.title, translations.en.edgeHideOptions);
    assert.equal(button.getAttribute('aria-label'), translations.en.edgeHideOptions);
    assert.ok(!button.classList.contains('is-collapsed'));

    // A click reaches the caller, and stops there: a panel's own click
    // handling must not also fire for a control about its frame.
    const clicked = button.dispatch('click');
    assert.equal(toggles, 1, 'the click runs the toggle');
    assert.ok(clicked.propagationStopped, 'and does not bubble into the panel');
    assert.ok(clicked.defaultPrevented, 'and is not treated as a form/default action');

    // The sidebar's resize proxy starts a drag on pointerdown over this very
    // edge; the pill has to keep that from happening under the finger.
    assert.ok(button.dispatch('pointerdown').propagationStopped, 'pointerdown does not start a resize');

    // The panel was collapsed from somewhere else: the control follows.
    syncEdgeToggle(rail, true);
    assert.ok(button.classList.contains('is-collapsed'), 'it knows the panel is away');
    assert.equal(button.getAttribute('aria-expanded'), 'false');
    assert.equal(button.title, translations.en.edgeShowOptions, 'and now offers to bring it back');
    syncEdgeToggle(rail, false);
    assert.equal(button.title, translations.en.edgeHideOptions, 'and back again');

    // A rail built collapsed starts collapsed, rather than lying until the
    // first toggle.
    const started = createEdgeToggle({
        side: 'left', collapsed: true,
        hideKey: 'edgeHideSidebar', showKey: 'edgeShowSidebar', onToggle: () => {},
    });
    assert.ok(started.querySelector('.edge-toggle').classList.contains('is-collapsed'));
    assert.equal(started.querySelector('.edge-toggle').title, translations.en.edgeShowSidebar);

    // Missing root, missing button: a sync must never throw at a caller that
    // runs on every toolbar click.
    assert.doesNotThrow(() => syncEdgeToggle(null, true));
    assert.doesNotThrow(() => syncEdgeToggle(new FakeElement('div'), true));
} finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
}

// ─── The left sidebar ──────────────────────────────────────────────
const ui = read('src/app/methods/ui-methods.js');
assert.match(ui, /document\.getElementById\('toggle-sidebar'\)\.addEventListener\('click', \(\) => this\.toggleSidebar\(\)\)/,
    'the top-bar button goes through the one place that knows how to collapse');
assert.match(ui, /proto\.toggleSidebar = function\(\) \{[\s\S]*?classList\.toggle\('hidden'\);[\s\S]*?_syncSidebarEdgeToggle\(\)/,
    'and that place brings the edge control along');
assert.match(ui, /createEdgeToggle\(\{[\s\S]*?side: 'left'[\s\S]*?hideKey: 'edgeHideSidebar'[\s\S]*?onToggle: \(\) => this\.toggleSidebar\(\)/,
    'the edge control runs the same action, not a copy of it');
assert.match(ui, /sidebar\.insertAdjacentElement\('afterend', this\._sidebarEdgeToggle\)/,
    'the rail sits between the sidebar and the content, which is where the border is');

// A restored view sets the class straight on the sidebar, so it has to say so.
const session = read('src/app/methods/session-methods.js');
assert.match(
    session,
    /sidebar\.classList\.toggle\('hidden', !!this\._sessionSidebarHidden\);[\s\S]{0,240}?_syncSidebarEdgeToggle\?\.\(\)/,
    'restoring a view leaves the edge control saying the right thing',
);

const app = read('src/app/viewer-app.js');
assert.match(app, /setLanguage\(lang\) \{[\s\S]*?_syncSidebarEdgeToggle\?\.\(\)/,
    'switching language relabels the control, like every other tooltip');

// ─── Every analysis panel ──────────────────────────────────────────
const PANELS = [
    ['fft', '_toggleFftOptions', 'plot.fftContainer'],
    ['histogram', '_toggleHistogramOptions', 'plot.histogramContainer'],
    ['integral', '_toggleIntegralOptions', 'plot.integralContainer'],
    ['temporal-profile', '_toggleTemporalProfileOptions', 'plot.temporalProfileContainer'],
    ['correlation', '_toggleCorrelationOptions', 'plot.correlationContainer'],
    ['phase2d-fit', '_togglePhase2dOptions', 'plot.phase2dFitContainer'],
    ['heatmap', '_toggleCalendarHeatmapOptions', 'plot.heatmapContainer'],
];

for (const [file, toggleName, container] of PANELS) {
    const source = read(`src/plots/methods/${file}-methods.js`);
    assert.match(source, /import \{ createEdgeToggle, syncEdgeToggle \} from '\.\.\/\.\.\/ui\/edge-toggle\.js';/,
        `${file}: uses the shared control`);
    // Between the plot and the options: that is the border it has to sit on.
    assert.match(
        source,
        new RegExp(`workspace\\.append\\(plotArea, createEdgeToggle\\(\\{[\\s\\S]{0,240}?side: 'right',[\\s\\S]{0,240}?onToggle: \\(\\) => this\\.${toggleName}\\(panelId\\),[\\s\\S]{0,40}?\\}\\), options\\);`),
        `${file}: the rail goes between the plot area and the options panel`,
    );
    assert.doesNotMatch(source, /workspace\.append\(plotArea, options\);/,
        `${file}: no shell left without one`);
    // The toolbar button and the edge control must never disagree.
    assert.match(
        source,
        new RegExp(`state\\.optionsVisible = !state\\.optionsVisible;\\n\\s*syncEdgeToggle\\(${container.replace('.', '\\.')}, !state\\.optionsVisible\\);`),
        `${file}: collapsing from the toolbar updates the edge control`,
    );
}

// ─── The line itself is untouched ──────────────────────────────────
const base = read('src/styles/base.css');
const sidebarCss = read('src/styles/sidebar.css');
const content = read('src/styles/content.css');

assert.match(sidebarCss, /\.sidebar \{[\s\S]*?border-right: 1px solid var\(--border-color\);/,
    'the sidebar divider is still one pixel');
assert.match(content, /\.fft-options \{[\s\S]*?border-left: 1px solid var\(--border-color\);/,
    'and so is the options panel divider');
assert.doesNotMatch(base, /\.edge-toggle[^{]*\{[^}]*\bborder-(right|left)-width\b/,
    'the control does not thicken the border it sits on');

// Zero width is what keeps the layout where it was: the rail is a flex item
// that takes no room, and the button hangs off it.
assert.match(base, /\.edge-toggle-rail \{[\s\S]*?flex: 0 0 0;[\s\S]*?width: 0;/,
    'the rail takes no width');
assert.match(base, /\.edge-toggle \{[\s\S]*?position: absolute;/, 'so the button must be out of flow');
assert.match(base, /\.edge-toggle \{[\s\S]*?border-radius: 999px;/, 'a rounded pill, as asked');
assert.match(base, /\.edge-toggle \{[\s\S]*?width: 14px;[\s\S]*?height: 46px;/, 'short and narrow, not a grab bar');
assert.match(base, /\.edge-toggle \{[\s\S]*?top: 50%;/, 'centred on the border it sits on');

// Collapsed, it must stay on screen and inside its panel, or the way back
// disappears with the panel.
assert.match(base, /\.edge-toggle-rail-left \.edge-toggle\.is-collapsed \{\s*transform: translate\(0, -50%\);/,
    'the sidebar control moves fully into the content when the sidebar goes');
assert.match(base, /\.edge-toggle-rail-right \.edge-toggle\.is-collapsed \{\s*transform: translate\(-100%, -50%\);/,
    'the options control moves fully into the plot when the options go');

// The sidebar's resize proxy is fixed at z-index 1200 on this same edge.
const railZ = Number(/\.edge-toggle-rail-left \{\s*z-index: (\d+)/.exec(base)?.[1]);
const proxyZ = Number(/\.sidebar-resize-proxy \{[\s\S]*?z-index: (\d+)/.exec(sidebarCss)?.[1]);
assert.ok(Number.isFinite(railZ) && Number.isFinite(proxyZ), 'both stacking levels are declared');
assert.ok(railZ > proxyZ, `the pill sits above the resize proxy (${railZ} > ${proxyZ})`);

// ─── Labels ────────────────────────────────────────────────────────
for (const lang of Object.keys(translations)) {
    for (const key of ['edgeHideSidebar', 'edgeShowSidebar', 'edgeHideOptions', 'edgeShowOptions']) {
        assert.ok(translations[lang][key]?.trim(), `${lang}.${key} is present`);
    }
    // The label says which way it will go, so the two must not read alike.
    assert.notEqual(translations[lang].edgeHideSidebar, translations[lang].edgeShowSidebar, `${lang}: sidebar labels differ`);
    assert.notEqual(translations[lang].edgeHideOptions, translations[lang].edgeShowOptions, `${lang}: options labels differ`);
}

console.log(`Edge toggle checks passed (${PANELS.length} analysis panels + the sidebar).`);
