// Data tools on a phone (docs/phone-web-specification.md §5.8).
//
// On the desktop the tools are a column of the side panel: a dropdown of
// tools, a dropdown of signals, a form that unfolds under them, a row of three
// buttons and a two-line table of what was made. On a phone that column is
// hidden in the Data sheet, every dropdown is a 14 px target, the help is a
// popover pinned to a mouse position, and the dashed preview it draws is on a
// plot the sheet covers.
//
// So the phone gets its own pages, laid out for a thumb:
//
//   · a hub (Analyze → Data tools) with the tools as tiles, grouped by what
//     they are for — clean, calculus, smooth and filter, resample and compare —
//     each with its drawing and one line of what it does, since there is no
//     hover to say it; under them the transformations of the file as cards
//     (tap to edit, ✓ to put it on the plot, 🗑 to delete, asking in place);
//   · a page per tool that opens at HALF height, so the plot stays live above
//     it: the signal is a row that opens a searchable list (pre-set to the
//     signal on screen, so the dashed preview is there from the first tap),
//     a strip says what the plot is showing — the result, dashed, or how to
//     get it there — and the settings are the desktop's own controls at a
//     finger's size: sliders with a thumb that can be found, numbers with
//     − and + that repeat when held, and every "?" a help page with Back;
//   · a footer always in reach: ✕, whether the result goes on the plot, and
//     Create (or Update), saying why not while it cannot;
//   · the tree's ✎ on a tool's output opens its page, editing.
//
// Nothing about a transformation lives here. The settings ARE the side panel's
// controls, lent to the page and put back when it closes, and the page presses
// the panel's own Create: one code path for computing, previewing, editing,
// renaming, chaining and every check those make. Leaving the page with Back
// keeps a new draft (the hub offers to continue it) and cancels an edit;
// hiding the sheet to look at the plot keeps either, and Analyze says so.
import i18n from '../../i18n/index.js';
import { setEmphasizedText } from '../../ui/emphasis.js';
import { button, el, section } from './compact-dom.js';
import { COMPACT_SIGNAL_LIST_MODES } from './compact-analyses.js';
import { RESAMPLE_ALL_VARIABLES } from './data-tools-methods.js';

const ICON = {
    tools: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><path d="M13 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M7 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/></svg>',
    removeOutliers: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 16h5.5l2.5-9 2.5 9H21"/><path d="M15.5 3.5l4 4M19.5 3.5l-4 4"/></svg>',
    interpolate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 18l5-6M16 9l5-5"/><path d="M10.5 11h.01M13.5 10h.01"/></svg>',
    collapse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h.01M5 12h.01M5 19h.01"/><path d="M8.5 6l6 6-6 6M8.5 12h6"/><path d="M19 12h.01"/></svg>',
    derivative: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19c6 0 10-4 12-14"/><path d="M7 21l13-13" stroke-dasharray="2.2 2.2"/></svg>',
    integrate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19h18"/><path d="M4 19c3-9 6-11 9-7s5 2 7-5"/><path d="M8 19v-6M12 19v-7M16 19v-5" stroke-opacity=".55"/></svg>',
    movingAverage: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 13l2-4 2 6 2-7 2 7 2-5 2 6 2-6 2 4 2-1" stroke-opacity=".45"/><path d="M3 12c6-1.5 12-1.5 18 0"/></svg>',
    detrend: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 19L21 6" stroke-opacity=".45" stroke-dasharray="2.2 2.2"/><path d="M3 14l3-2 3 3 3-3 3 2 3-2 3 1"/></svg>',
    filter: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>',
    resample: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20h18"/><path d="M5 20v-7M9 20v-11M13 20v-9M17 20v-6M21 20v-4"/></svg>',
    xcorr: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9c2.5-5 5-5 7.5 0s5 5 7.5 0"/><path d="M6 17c2.5-5 5-5 7.5 0s5 5 7.5 0" stroke-opacity=".55"/></svg>',
    help: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><path d="M12 17.5v.01"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
    minus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M16 16l5 5"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M14 7l5 5-5 5"/></svg>',
    eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z"/><path d="M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0"/></svg>',
    file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
    resume: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4h4"/></svg>',
};

// The tools by what they are for, in the hub's order. Every tool of the
// desktop's picker must appear here: `npm run test:compact-tools` fails when
// the desktop gains one this table does not place, which is the §11 rule
// enforced in code. A tool's settings are, by default, its own block of the
// side panel; Remove outliers is the one built from several.
export const COMPACT_TOOL_GROUPS = [
    { id: 'clean', titleKey: 'compactToolGroupClean', tools: ['removeOutliers', 'interpolate', 'collapse'] },
    { id: 'calculus', titleKey: 'compactToolGroupCalculus', tools: ['derivative', 'integrate'] },
    { id: 'smooth', titleKey: 'compactToolGroupSmooth', tools: ['movingAverage', 'detrend', 'filter'] },
    { id: 'time', titleKey: 'compactToolGroupTime', tools: ['resample', 'xcorr'] },
];

export const COMPACT_TOOLS = COMPACT_TOOL_GROUPS.flatMap(group => group.tools);

// A tool's drawing, tinted by its group so the hub reads as four families.
const groupOf = tool => COMPACT_TOOL_GROUPS.find(group => group.tools.includes(tool))?.id || 'other';
const glyphNode = (tool, extra = '') => {
    const glyph = el('span', `compact-tool-glyph group-${groupOf(tool)}${extra ? ` ${extra}` : ''}`);
    glyph.innerHTML = ICON[tool] || ICON.tools;
    return glyph;
};

// The side panel's pieces a tool's settings are made of, in the order the
// page shows them.
export function compactToolSettingsSelectors(tool) {
    if (tool === 'removeOutliers') {
        return ['#outlier-method-wrap', '.outlier-method-controls', '#outlier-replacement-wrap'];
    }
    return [`.data-tool-controls[data-tool-kind="${tool}"]`];
}

// What a − / + pair steps a number field by, or 0 when it has none: only a
// field with a step of its own. "any" is a value typed, not counted (a
// cut-off, a Δt, a bound).
export function stepperStep(stepAttr) {
    const step = Number(stepAttr);
    return stepAttr != null && stepAttr !== '' && Number.isFinite(step) && step > 0 ? step : 0;
}

// The keyboard a number field wants on a phone. A field that may go below
// zero keeps the full one: the numeric keypads of iOS have no minus sign.
export function numberInputMode({ min, step }) {
    const lower = Number(min);
    if (min == null || min === '' || !Number.isFinite(lower) || lower < 0) return '';
    const s = stepperStep(step);
    return s && Number.isInteger(s) ? 'numeric' : 'decimal';
}

// The height a tool's page opens at, upright: half a sheet when half of
// the screen leaves room for the signal and a setting between the header and
// the footer (a 390 × 844 phone has ~220 px there), the whole sheet on a
// short phone (320 × 568 would keep ~90 px).
export const COMPACT_TOOL_HALF_MIN_HEIGHT = 700;
export function compactToolSheetSize(viewportHeight) {
    return viewportHeight >= COMPACT_TOOL_HALF_MIN_HEIGHT ? 'half' : 'full';
}

// A tool's description and how it reads in a tile, per language.
const descKey = tool => `compactToolDesc_${tool}`;

export function installCompactToolsMethods(ViewerClass) {
    const proto = ViewerClass.prototype;

    // ─── Hooks into the side panel ────────────────────────────────

    // The tree's ✎ on a tool's output: on a phone, the phone's page.
    const desktopEnterEditing = proto._enterDataToolEditing;
    proto._enterDataToolEditing = function(fileId, name) {
        if (this._compactIsActive?.() && !this._compactToolsOpening) {
            const definition = this.dataToolVariablesByFile?.get(fileId)?.get(name);
            if (definition) {
                this._openCompactTool(definition.tool, { edit: name });
                return;
            }
        }
        desktopEnterEditing.call(this, fileId, name);
    };

    // Whatever the panel re-synced (a slider moved, a commit, a file switched),
    // the phone page reads it again.
    const desktopSync = proto._syncDataTools;
    proto._syncDataTools = function(...args) {
        const result = desktopSync.apply(this, args);
        this._compactToolsAfterSync();
        return result;
    };

    // Why Create is off, kept for the footer to say.
    const desktopBlocker = proto._dataToolCommitBlocker;
    proto._dataToolCommitBlocker = function(...args) {
        const blocker = desktopBlocker.apply(this, args);
        this._compactToolBlocker = blocker;
        return blocker;
    };

    // The panel's verdict line, shown where the phone is.
    const desktopMessage = proto._renderDataToolMessage;
    proto._renderDataToolMessage = function(...args) {
        const result = desktopMessage.apply(this, args);
        this._compactToolsRenderMessage();
        return result;
    };

    // The dashed preview went up or came down: the strip says so.
    for (const name of ['_drawDataToolPreviewTrace', '_clearDataToolPreview']) {
        const original = proto[name];
        proto[name] = function(...args) {
            const result = original.apply(this, args);
            this._compactToolSyncPreviewStrip?.();
            return result;
        };
    }

    // On a phone the preview belongs on the plot on screen — one plot at a
    // time, so a curve drawn on another would be drawn for nobody — and the
    // page offers to put the source there when it is not.
    const desktopPreviewPanel = proto._dataToolPreviewPanelId;
    proto._dataToolPreviewPanelId = function(context) {
        if (!this._compactIsActive?.()) return desktopPreviewPanel.call(this, context);
        const panelId = this._compactActivePanelId?.();
        const plot = panelId ? this.plotManager.plots.get(panelId) : null;
        if (!plot || plot.mode !== 'timeseries' || !plot.div) return null;
        const draws = plot.traces.some(trace => trace.fileId === context.fileId
            && (trace.varName === context.sourceName || trace.varName === '__dataToolPreview__'));
        return draws ? panelId : null;
    };

    // The strip offers "See the plot" only while the sheet covers it.
    const compactApplySize = proto._applyCompactSheetSize;
    proto._applyCompactSheetSize = function(...args) {
        const result = compactApplySize.apply(this, args);
        this._compactToolSyncPreviewStrip?.();
        return result;
    };

    // Back from a tool page is a pop; hiding the sheet is not. Only the first
    // cancels an edit.
    const compactPop = proto._popCompactPage;
    proto._popCompactPage = function(...args) {
        this._compactToolsPopping = true;
        try {
            return compactPop.apply(this, args);
        } finally {
            this._compactToolsPopping = false;
        }
    };

    // ─── State ────────────────────────────────────────────────────

    proto._compactToolsState = function() {
        if (!this._compactToolsData) this._compactToolsData = { hub: null, tool: null };
        return this._compactToolsData;
    };

    proto._compactToolsFileData = function(fileId = this.activeFileId) {
        return fileId != null ? this.plotManager.files.get(fileId)?.data || null : null;
    };

    // What the side panel holds right now: nothing, a draft, or an edit.
    proto._compactToolsInProgress = function() {
        const tool = document.getElementById('data-tool-select')?.value || '';
        if (!tool) return null;
        const source = document.getElementById('outlier-variable')?.value || '';
        const output = (document.getElementById('outlier-output-name')?.value || '').trim();
        if (this._dataToolEditing) return { tool, kind: 'edit', name: this._dataToolEditing.name, source };
        if (this._datasetEditing) return { tool, kind: 'dataset', name: this._datasetEditing.name, source };
        if (!source) return null;
        return { tool, kind: 'draft', source, output };
    };

    proto._compactToolLabelFor = function(tool) {
        return this._dataToolLabel?.(tool) || tool;
    };

    proto._compactToolIsLazy = function() {
        return !!this._isDataToolLazyData?.(this._compactToolsFileData());
    };

    // ─── The hub ──────────────────────────────────────────────────

    proto._openCompactToolsHub = function() {
        if (!this._compact?.active) return;
        if (!this._compact.sheet) this._openCompactSheet('analyze', { toggle: false });
        const state = this._compactToolsState();
        // Already open (the Analyze row tapped from the hub's own sheet).
        if (state.hub && this._compact.pages.includes(state.hub)) {
            while (this._compact.pages[this._compact.pages.length - 1] !== state.hub) this._popCompactPage();
            return state.hub;
        }
        const node = el('div', 'compact-page compact-page-tools');
        const page = {
            title: i18n.t('dataTools'),
            node,
            persist: true,
            lang: i18n.currentLang,
            dirty: false,
            rebuild: () => {
                page.title = i18n.t('dataTools');
                page.lang = i18n.currentLang;
                const pages = this._compact.pages;
                if (pages[pages.length - 1] === page) this._compactSheetTitle.textContent = page.title;
                this._renderCompactToolsHub();
            },
            onClose: () => {
                if (state.hub === page) state.hub = null;
            },
        };
        state.hub = page;
        this._renderCompactToolsHub();
        this._pushCompactPage(page);
        return page;
    };

    proto._renderCompactToolsHub = function({ scrollTop = null } = {}) {
        const state = this._compactToolsState();
        const page = state.hub;
        if (!page) return;
        page.dirty = false;
        const node = page.node;
        const pagesNow = this._compact.pages || [];
        const onTop = pagesNow[pagesNow.length - 1] === page;
        const keepScroll = scrollTop ?? (onTop ? (this._compactSheetBody?.scrollTop || 0) : (page.scrollTop || 0));
        node.replaceChildren();
        const fileId = this.activeFileId;
        const data = this._compactToolsFileData(fileId);

        if (!data) {
            node.appendChild(el('p', 'compact-note', i18n.t('compactToolsNeedFile')));
            return;
        }

        // Which file the tools work on, when there is a choice.
        if (this.files.size > 1) {
            const fileLine = el('div', 'compact-tools-file');
            const icon = el('span', 'compact-btn-icon');
            icon.innerHTML = ICON.file;
            fileLine.append(icon, el('span', 'compact-tools-file-name', this._fileDisplayName?.(this.files.get(fileId)) || this.files.get(fileId)?.name || ''));
            node.appendChild(fileLine);
        }

        // A draft or an edit left behind: offered first, with what it was.
        const progress = this._compactToolsInProgress();
        if (progress && !state.tool) node.appendChild(this._compactToolsResumeCard(progress));

        const lazy = this._compactToolIsLazy();
        for (const group of COMPACT_TOOL_GROUPS) {
            const wrap = section(i18n.t(group.titleKey));
            const grid = el('div', 'compact-tools-grid');
            for (const tool of group.tools) {
                const available = !!this._isDataToolAvailableForData?.(tool, data);
                const tile = el('button', `compact-tool-tile tool-${tool}`);
                tile.type = 'button';
                tile.dataset.tool = tool;
                const glyph = glyphNode(tool);
                const text = el('span', 'compact-tool-text');
                text.appendChild(el('span', 'compact-tool-name', this._compactToolLabelFor(tool)));
                text.appendChild(el('span', 'compact-tool-desc', available
                    ? i18n.t(descKey(tool))
                    : (lazy ? i18n.t('compactToolLazyUnavailable') : i18n.t(descKey(tool)))));
                tile.append(glyph, text);
                tile.disabled = !available;
                tile.addEventListener('click', (event) => {
                    event.stopPropagation();
                    this._openCompactTool(tool);
                });
                grid.appendChild(tile);
            }
            wrap.appendChild(grid);
            node.appendChild(wrap);
        }

        // The verdict of the last thing done (it takes itself down), above
        // what was made: a new card and what it says about itself, together.
        const made = this._compactToolsTransformations(fileId);
        const message = el('div', 'compact-tools-message');
        message.setAttribute('role', 'status');
        state.hubMessage = message;
        made.insertBefore(message, made.querySelector('.compact-section-title')?.nextSibling || null);
        node.appendChild(made);
        this._compactToolsRenderMessage();
        requestAnimationFrame(() => {
            const pages = this._compact.pages;
            if (pages[pages.length - 1] === page && this._compactSheetBody) this._compactSheetBody.scrollTop = keepScroll;
        });
    };

    proto._compactToolsResumeCard = function(progress) {
        const card = el('div', 'compact-tools-resume');
        const icon = glyphNode(progress.tool);
        const text = el('div', 'compact-tools-resume-text');
        const head = progress.kind === 'draft' ? 'compactToolsInProgress' : 'compactToolsEditing';
        text.appendChild(el('span', 'compact-tools-resume-title', i18n.t(head).replace('{tool}', this._compactToolLabelFor(progress.tool))));
        const flow = progress.kind === 'draft'
            ? `${this._compactToolSourceLabel(progress.source)} → ${progress.output || '…'}`
            : progress.name;
        text.appendChild(el('span', 'compact-tools-resume-flow', flow));
        if (this._dataToolPreview) text.appendChild(el('span', 'compact-tools-resume-note', i18n.t('compactToolsResumePreview')));
        const actions = el('div', 'compact-tools-resume-actions');
        actions.appendChild(button('compact-secondary-btn compact-tools-discard', i18n.t(progress.kind === 'draft' ? 'compactToolsDiscard' : 'dataToolCancel'), () => {
            this.clearDataToolForm();
            this._renderCompactToolsHub();
        }));
        actions.appendChild(button('compact-primary-btn compact-tools-continue', i18n.t('compactToolsContinue'), () => {
            this._openCompactTool(progress.tool, { resume: true });
        }, { icon: ICON.resume }));
        card.append(icon, text, actions);
        return card;
    };

    proto._compactToolSourceLabel = function(source) {
        if (source === RESAMPLE_ALL_VARIABLES) return i18n.t('dataToolRowAllVariables');
        return source || '…';
    };

    // The transformations of the file, as cards. The desktop's table, built
    // for a finger: the card is the edit, the trash asks on the card itself.
    proto._compactToolsTransformations = function(fileId) {
        const state = this._compactToolsState();
        const wrap = section(i18n.t('dataToolTransformations'));
        wrap.classList.add('compact-tools-made');
        const rows = fileId ? (this._orderedDataToolDefinitions?.(fileId) || []) : [];
        const datasets = fileId ? (this._derivedDatasetsOf?.(fileId) || []) : [];
        if (!rows.length && !datasets.length) {
            wrap.appendChild(el('p', 'compact-note compact-tools-empty', i18n.t('compactToolsNoneYet')));
            return wrap;
        }
        const list = el('div', 'compact-tools-cards');
        const target = this._compactDerivedPlotTarget?.();
        const panelPlot = target ? this.plotManager.plots.get(target.panelId) : null;
        const confirming = state.confirmDelete || '';
        for (const [name, definition] of rows) {
            const onPlot = !!panelPlot?.traces.some(trace => trace.fileId === fileId && trace.varName === name);
            const key = `var:${name}`;
            const card = this._compactToolCard({
                key,
                tool: definition.tool,
                source: definition.sourceName,
                result: name,
                editing: this._dataToolEditing?.name === name,
                onEdit: () => this._openCompactTool(definition.tool, { edit: name }),
                plot: target ? {
                    on: onPlot,
                    label: i18n.t('compactPlotN').replace('{n}', String(target.n)),
                    run: async () => {
                        await this._compactToggleVariable(name);
                        this._renderCompactToolsHub();
                    },
                } : null,
                confirm: confirming === key ? {
                    question: (() => {
                        const chain = this._dataToolChainDependents?.(fileId, name) || [];
                        return chain.length
                            ? i18n.t('compactToolsDeleteChain').replace('{count}', String(chain.length))
                            : i18n.t('dataToolDeleteConfirm');
                    })(),
                    run: () => {
                        state.confirmDelete = '';
                        if (this._dataToolEditing?.name === name) this._exitDataToolEditing?.();
                        this._deleteDataToolVariable(fileId, name);
                        this._compactToast(i18n.t('compactDerivedDeleted').replace('{name}', name));
                        this._renderCompactToolsHub();
                    },
                } : null,
            });
            list.appendChild(card);
        }
        for (const [datasetId, entry] of datasets) {
            const recipe = entry.derivedDataset || {};
            const key = `dataset:${datasetId}`;
            const card = this._compactToolCard({
                key,
                tool: recipe.tool,
                source: this._compactToolSourceLabel(recipe.sourceName),
                result: this._fileDisplayName?.(entry) || entry.name,
                dataset: true,
                editing: this._datasetEditing?.fileId === datasetId,
                onEdit: () => this._openCompactTool(recipe.tool, { dataset: datasetId }),
                confirm: confirming === key ? {
                    question: (() => {
                        const under = this._derivedDatasetsUnder?.(datasetId) || [];
                        return under.length
                            ? i18n.t('compactToolsDeleteChain').replace('{count}', String(under.length))
                            : i18n.t('derivedDatasetDeleteConfirm');
                    })(),
                    run: async () => {
                        state.confirmDelete = '';
                        const label = this._fileDisplayName?.(entry) || entry.name;
                        await this.removeFile(datasetId, { confirmed: true });
                        if (!this.files.has(datasetId)) this._compactToast(i18n.t('compactDerivedDeleted').replace('{name}', label));
                        this._renderCompactToolsHub();
                    },
                } : null,
            });
            list.appendChild(card);
        }
        wrap.appendChild(list);
        return wrap;
    };

    proto._compactToolCard = function({ key, tool, source, result, dataset = false, editing = false, onEdit, plot = null, confirm = null }) {
        const state = this._compactToolsState();
        const card = el('div', `compact-tool-card${editing ? ' is-editing' : ''}${confirm ? ' is-confirming' : ''}`);
        card.dataset.key = key;
        card.dataset.result = result;
        const main = el('button', 'compact-tool-card-main');
        main.type = 'button';
        const glyph = glyphNode(tool, 'is-small');
        // The result is what the card is about; where it came from and how,
        // under it. A narrow phone cut "source → result" down to two stubs.
        const text = el('span', 'compact-tool-card-text');
        text.appendChild(el('span', 'compact-tool-card-result', result));
        const meta = el('span', 'compact-tool-card-meta');
        const arrow = el('span', 'compact-tool-card-arrow');
        arrow.innerHTML = ICON.arrow;
        meta.append(el('span', 'compact-tool-card-source', source || '…'), arrow,
            el('span', 'compact-tool-card-how', this._compactToolLabelFor(tool)
                + (dataset ? ` · ${i18n.t('dataToolRowDataset')}` : '')
                + (editing ? ` · ${i18n.t('compactToolsEditingNow')}` : '')));
        text.appendChild(meta);
        main.append(glyph, text);
        main.title = i18n.t(dataset ? 'derivedDatasetEditTitle' : 'dataToolEditTitle');
        main.addEventListener('click', (event) => {
            event.stopPropagation();
            state.confirmDelete = '';
            onEdit();
        });
        card.appendChild(main);

        if (confirm) {
            const ask = el('div', 'compact-tool-card-confirm');
            ask.appendChild(el('span', 'compact-tool-card-question', confirm.question));
            const keep = button('compact-secondary-btn compact-tool-card-keep', i18n.t('dataToolNo'), () => {
                state.confirmDelete = '';
                this._renderCompactToolsHub();
            });
            const yes = button('compact-secondary-btn compact-danger-btn compact-tool-card-yes', i18n.t('compactToolsDeleteYes'), () => confirm.run(), { icon: ICON.trash });
            ask.append(keep, yes);
            card.appendChild(ask);
            return card;
        }

        const actions = el('div', 'compact-tool-card-actions');
        if (plot) {
            const toggle = button(`compact-tool-card-plot${plot.on ? ' is-active' : ''}`, plot.label, () => plot.run(), {
                icon: plot.on ? ICON.check : ICON.plus,
                title: i18n.t(plot.on ? 'compactToolsTakeOffPlot' : 'compactToolsPutOnPlot').replace('{n}', plot.label),
            });
            toggle.setAttribute('aria-pressed', String(plot.on));
            actions.appendChild(toggle);
        }
        actions.appendChild(button('compact-icon-btn compact-tool-card-delete', '', () => {
            state.confirmDelete = key;
            this._renderCompactToolsHub();
        }, { icon: ICON.trash, title: i18n.t(dataset ? 'derivedDatasetRemoveTitle' : 'dataToolDeleteTitle') }));
        card.appendChild(actions);
        return card;
    };

    // ─── A tool's page ────────────────────────────────────────────

    proto._openCompactTool = async function(tool, { edit = null, dataset = null, resume = false } = {}) {
        if (!this._compact?.active || !COMPACT_TOOLS.includes(tool)) return;
        const fileId = this.activeFileId;
        const data = this._compactToolsFileData(fileId);
        if (!data && !dataset) {
            this._compactToast(i18n.t('compactToolsNeedFile'));
            return;
        }
        const state = this._compactToolsState();
        // One tool page at a time: a second one replaces the first.
        if (state.tool) this._compactPopToolPage({ keep: true });
        if (!this._compact.sheet) this._openCompactSheet(edit ? 'data' : 'analyze', { toggle: false });

        // The side panel learns what to show, through its own entry points.
        const toolSelect = document.getElementById('data-tool-select');
        const sourceSelect = document.getElementById('outlier-variable');
        if (!toolSelect || !sourceSelect) return;
        this._compactToolsOpening = true;
        try {
            if (edit) {
                desktopEnterEditing.call(this, fileId, edit);
            } else if (dataset) {
                const opened = await this._editDerivedDataset?.(dataset);
                if (!opened) return;
            } else if (!resume || toolSelect.value !== tool) {
                if (this._dataToolEditing || this._datasetEditing || toolSelect.value !== tool) {
                    toolSelect.value = tool;
                    toolSelect.dispatchEvent(new Event('change', { bubbles: true }));
                }
                // The signal on screen, so the preview is there from the start.
                if (!sourceSelect.value || sourceSelect.value === RESAMPLE_ALL_VARIABLES) {
                    const preset = this._compactToolPresetSource(tool);
                    if (preset) this._compactToolChooseSource(preset, { quiet: true });
                }
            }
        } finally {
            this._compactToolsOpening = false;
        }
        // An awaited dataset edit may have outlived the sheet.
        if (!this._compact?.active || !this._compact.sheet) return;

        const node = el('div', 'compact-page compact-page-tool');
        const page = {
            title: '',
            node,
            persist: true,
            lang: i18n.currentLang,
            rebuild: () => {
                page.lang = i18n.currentLang;
                this._renderCompactToolPage();
            },
            onClose: () => this._closeCompactToolPage(page),
        };
        const toolState = {
            tool,
            page,
            fileId: this.activeFileId,
            addToPlot: this._compact.toolsAddToPlot !== false,
            done: false,
            restore: [],
            sheet: this._compact.sheet,
            sheetSize: this._compact.sheetSize,
        };
        // Where the hub was, for when Back returns to it.
        const pagesNow = this._compact.pages;
        if (state.hub && pagesNow[pagesNow.length - 1] === state.hub) state.hub.scrollTop = this._compactSheetBody.scrollTop;
        state.tool = toolState;
        state.confirmDelete = '';
        // The pencil in the tree opens straight onto the page; from the hub
        // the hub is under it, and Back returns there.
        this._renderCompactToolPage();
        this._pushCompactPage(page);
        // Half height upright, where half a sheet still holds the signal and
        // a setting above the footer: the plot above is where the result is
        // seen. A short phone gets the whole height (its strip then offers
        // "See the plot", which halves it).
        if (!this._compact.landscape) this._setCompactSheetSize(compactToolSheetSize(window.innerHeight));
        this._handleDataToolPreviewChange?.({ immediate: true });
        this._compactSyncToolsNav();
    };

    // The signal the page starts on: the first on the plot on screen that the
    // tool takes, else none (the list is a tap away).
    proto._compactToolPresetSource = function(tool) {
        if (tool === 'resample' || tool === 'collapse') return '';
        const sourceSelect = document.getElementById('outlier-variable');
        const options = new Set([...(sourceSelect?.options || [])].map(option => option.value).filter(Boolean));
        const panelId = this._compactActivePanelId?.();
        const plot = panelId ? this.plotManager.plots.get(panelId) : null;
        for (const trace of plot?.traces || []) {
            if (trace.fileId !== this.activeFileId) continue;
            if (options.has(trace.varName)) return trace.varName;
        }
        return '';
    };

    proto._compactToolChooseSource = function(value, { quiet = false } = {}) {
        const sourceSelect = document.getElementById('outlier-variable');
        if (!sourceSelect) return;
        if (![...sourceSelect.options].some(option => option.value === value)) return;
        sourceSelect.value = value;
        sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
        if (!quiet) this._compactToolSyncPage();
    };

    proto._renderCompactToolPage = function() {
        const state = this._compactToolsState();
        const toolState = state.tool;
        if (!toolState) return;
        const { tool, page } = toolState;
        const node = page.node;
        // Whatever was lent goes home before the page is drawn again.
        this._compactToolGiveBack(toolState);
        node.replaceChildren();

        const editing = this._dataToolEditing;
        const datasetEditing = this._datasetEditing;
        const editingName = editing?.name || datasetEditing?.name || '';
        page.title = editingName
            ? i18n.t('compactToolsEditTitle').replace('{name}', editingName)
            : this._compactToolLabelFor(tool);
        const pages = this._compact.pages;
        if (pages[pages.length - 1] === page) this._compactSheetTitle.textContent = page.title;

        // ── What it does, and its help ──
        const intro = el('div', 'compact-tool-intro');
        const glyph = glyphNode(tool);
        const introText = el('p', 'compact-tool-intro-text', i18n.t(descKey(tool)));
        intro.append(glyph, introText);
        const topics = this._compactToolHelpTopics(tool);
        if (topics.length) {
            const help = button('compact-icon-btn compact-tool-help-btn', '', () => {
                if (topics.length === 1) this._openCompactToolHelp(topics[0].id);
                else this._openCompactToolHelpIndex(tool, topics);
            }, { icon: ICON.help, title: i18n.t('compactToolsHelp') });
            intro.appendChild(help);
        }
        node.appendChild(intro);

        // ── The signal ──
        const fileTool = this._isFileDataTool?.(tool);
        const signal = section(i18n.t(tool === 'xcorr' ? 'compactToolSignalX' : 'compactToolSignal'));
        signal.classList.add('compact-tool-signal-section');
        const signalRow = el('button', 'compact-tool-signal');
        signalRow.type = 'button';
        signalRow.appendChild(el('span', 'compact-tool-signal-text'));
        const chevron = el('span', 'compact-btn-icon compact-tool-signal-chevron');
        chevron.innerHTML = ICON.chevron;
        signalRow.appendChild(chevron);
        signalRow.addEventListener('click', (event) => {
            event.stopPropagation();
            this._openCompactToolSignalPicker();
        });
        toolState.signalRow = signalRow;
        signal.appendChild(signalRow);

        // What the plot shows of the result, or how to get it there.
        const strip = el('div', 'compact-tool-preview');
        strip.setAttribute('aria-live', 'polite');
        toolState.previewStrip = strip;
        signal.appendChild(strip);
        node.appendChild(signal);

        // ── The settings: the side panel's own controls ──
        const settings = section(i18n.t('compactToolSettings'));
        settings.classList.add('compact-tool-settings');
        let lent = 0;
        for (const selector of compactToolSettingsSelectors(tool)) {
            for (const piece of document.querySelectorAll(`.data-tools-section ${selector}`)) {
                toolState.restore.push(this._lendToCompact(piece, settings));
                lent += 1;
            }
        }
        if (lent) {
            this._compactToolEnhance(settings, toolState);
            node.appendChild(settings);
        }
        toolState.settings = settings;

        // ── The result's name ──
        const result = section(i18n.t(fileTool ? 'compactToolResultFile' : 'compactToolResult'));
        result.classList.add('compact-tool-result');
        const outputWrap = document.querySelector('.data-tools-section #outlier-output-wrap');
        if (outputWrap) {
            toolState.restore.push(this._lendToCompact(outputWrap, result));
            const input = outputWrap.querySelector('#outlier-output-name');
            if (input) this._compactToolTagField(input, toolState, {
                autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'done',
            });
        }
        const chain = document.querySelector('.data-tools-section #data-tool-live-chain-wrap');
        if (chain) toolState.restore.push(this._lendToCompact(chain, result));
        node.appendChild(result);

        // ── Edit: the way out for the variable itself ──
        if (editing || datasetEditing) {
            const del = el('div', 'compact-tool-delete');
            toolState.deleteBox = del;
            node.appendChild(del);
        }

        // ── Footer: always in reach ──
        const footer = el('div', 'compact-derived-footer compact-tool-footer');
        const message = el('div', 'compact-tool-message');
        message.setAttribute('role', 'status');
        toolState.message = message;
        const reason = el('div', 'compact-tool-reason');
        toolState.reason = reason;
        const actions = el('div', 'compact-derived-actions');
        const cancel = button('compact-secondary-btn compact-derived-cancel compact-tool-cancel', '', () => this._compactToolCancel(), { icon: ICON.close, title: i18n.t('cancel') });
        const plotChip = button('compact-derived-plot-chip compact-tool-plot-chip', '', () => {
            toolState.addToPlot = !toolState.addToPlot;
            this._compact.toolsAddToPlot = toolState.addToPlot;
            this._compactToolSyncFooter();
        }, { icon: ICON.check });
        plotChip.appendChild(el('span', 'compact-btn-label'));
        toolState.plotChip = plotChip;
        const submit = button('compact-primary-btn compact-tool-submit', '', () => this._compactToolSubmit());
        toolState.submit = submit;
        actions.append(cancel, plotChip, submit);
        footer.append(message, reason, actions);
        node.appendChild(footer);

        this._compactToolSyncPage();
    };

    // Number fields get − and + (held, they repeat) and the keypad that suits
    // them; help buttons open pages. All of it is taken off again when the
    // controls go home.
    proto._compactToolEnhance = function(container, toolState) {
        for (const input of container.querySelectorAll('input[type="number"]')) {
            const mode = numberInputMode({ min: input.getAttribute('min'), step: input.getAttribute('step') });
            if (mode) this._compactToolTagField(input, toolState, { inputmode: mode });
            const step = stepperStep(input.getAttribute('step'));
            if (!step) continue;
            const make = (direction) => {
                const stepOnce = () => {
                    if (input.disabled) return;
                    const before = input.value;
                    try {
                        if (input.value === '') input.value = input.getAttribute('min') || '0';
                        else if (direction > 0) input.stepUp();
                        else input.stepDown();
                    } catch (_) {
                        return;
                    }
                    if (input.value === before) return;
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    input.dispatchEvent(new Event('change', { bubbles: true }));
                };
                const btn = button(`compact-tool-step compact-tool-step-${direction > 0 ? 'up' : 'down'}`, '', stepOnce,
                    { icon: direction > 0 ? ICON.plus : ICON.minus, title: i18n.t(direction > 0 ? 'compactToolStepUp' : 'compactToolStepDown') });
                // A held button keeps stepping, as the formula's ⌫ does.
                this._compactDerivedRepeat?.(btn, stepOnce);
                btn.addEventListener('pointerdown', event => event.preventDefault());
                return btn;
            };
            const down = make(-1);
            const up = make(1);
            // A field that stands alone in a column of labels and lists (the
            // integral's initial condition) gets a row of its own, or − and
            // + would stack above and below it.
            const parent = input.parentElement;
            const alone = parent && [...parent.children].some(child => child !== input && child.matches('label, select, .data-tool-label-row'));
            let wrap = null;
            if (alone) {
                wrap = el('div', 'data-tool-step-row compact-tool-step-wrap');
                input.before(wrap);
                wrap.appendChild(input);
            }
            input.before(down);
            input.after(up);
            const row = input.parentElement;
            row?.classList.add('compact-tool-has-steppers');
            toolState.restore.push(() => {
                down.remove();
                up.remove();
                row?.classList.remove('compact-tool-has-steppers');
                if (wrap) {
                    wrap.before(input);
                    wrap.remove();
                }
            });
        }
        for (const input of container.querySelectorAll('.data-tool-coefficients, input[type="text"]')) {
            this._compactToolTagField(input, toolState, { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
        }
        // Every "?" of the panel is a page here, never a popover.
        const onHelp = (event) => {
            const toggle = event.target.closest?.('.data-tool-help-toggle, .derived-help-more');
            if (!toggle || !container.contains(toggle)) return;
            event.preventDefault();
            event.stopPropagation();
            const id = toggle.getAttribute('aria-controls');
            if (id) this._openCompactToolHelp(id);
        };
        container.addEventListener('click', onHelp, true);
        toolState.restore.push(() => container.removeEventListener('click', onHelp, true));
    };

    // Set attributes on a lent field for as long as it is lent.
    proto._compactToolTagField = function(input, toolState, attributes) {
        for (const [name, value] of Object.entries(attributes)) {
            const had = input.hasAttribute(name);
            const before = input.getAttribute(name);
            input.setAttribute(name, value);
            toolState.restore.push(() => {
                if (had) input.setAttribute(name, before);
                else input.removeAttribute(name);
            });
        }
    };

    proto._compactToolGiveBack = function(toolState) {
        const restore = toolState.restore.splice(0);
        // Last lent, first returned: a stepper comes off before its field goes home.
        for (const fn of restore.reverse()) {
            try { fn(); } catch (_) { /* already gone */ }
        }
    };

    proto._closeCompactToolPage = function(page) {
        const state = this._compactToolsState();
        const toolState = state.tool;
        if (!toolState || toolState.page !== page) return;
        this._compactToolGiveBack(toolState);
        state.tool = null;
        // Back from an edit abandons it, as on the desktop's Cancel: the
        // variable is put back as it was. Hiding the sheet keeps it, to be
        // continued.
        if (!toolState.done && this._compactToolsPopping && (this._dataToolEditing || this._datasetEditing)) {
            this.clearDataToolForm();
        }
        // The hub under it shows what happened meanwhile, where it was left.
        if (state.hub && this._compact.pages.includes(state.hub)) this._renderCompactToolsHub({ scrollTop: state.hub.scrollTop || 0 });
        this._compactSyncToolsNav();
    };

    proto._compactPopToolPage = function({ keep = false } = {}) {
        const state = this._compactToolsState();
        const toolState = state.tool;
        if (!toolState) return;
        if (keep) toolState.done = true;
        const pages = this._compact.pages;
        const index = pages.indexOf(toolState.page);
        if (index < 0) {
            this._closeCompactToolPage(toolState.page);
            return;
        }
        while (pages.length > index) this._popCompactPage();
    };

    // ─── Keeping the page in step with the panel ──────────────────

    proto._compactToolsAfterSync = function() {
        const state = this._compactToolsData;
        if (!state) {
            this._compactSyncToolsNav?.();
            return;
        }
        if (state.tool) this._compactToolSyncPage();
        // The hub, if it is the page on show; otherwise when it is shown again.
        if (state.hub && !state.tool) {
            const pages = this._compact?.pages || [];
            if (pages[pages.length - 1] === state.hub && !this._compactToolsRendering) {
                this._compactToolsRendering = true;
                try { this._renderCompactToolsHub(); } finally { this._compactToolsRendering = false; }
            }
        }
        this._compactSyncToolsNav?.();
    };

    proto._compactToolSyncPage = function() {
        const toolState = this._compactToolsData?.tool;
        if (!toolState) return;
        // The tool left the panel (a file switched, the edit was deleted):
        // there is nothing for this page to show any more.
        const tool = document.getElementById('data-tool-select')?.value || '';
        if (tool !== toolState.tool && !toolState.done && !this._compactToolsOpening) {
            toolState.done = true;
            queueMicrotask(() => this._compactPopToolPage());
            return;
        }
        this._compactToolSyncSignal();
        this._compactToolSyncPreviewStrip();
        this._compactToolSyncFooter();
        this._compactToolSyncDelete();
        this._compactToolsRenderMessage();
    };

    proto._compactToolSyncSignal = function() {
        const toolState = this._compactToolsData?.tool;
        const row = toolState?.signalRow;
        if (!row) return;
        const sourceSelect = document.getElementById('outlier-variable');
        const value = sourceSelect?.value || '';
        const data = this._compactToolsFileData();
        const text = row.querySelector('.compact-tool-signal-text');
        text.replaceChildren();
        const options = [...(sourceSelect?.options || [])].filter(option => option.value);
        if (value) {
            const label = value === RESAMPLE_ALL_VARIABLES
                ? sourceSelect.selectedOptions[0]?.textContent || i18n.t('dataToolRowAllVariables')
                : value;
            text.appendChild(el('span', 'compact-tool-signal-name', label));
            const detail = value === RESAMPLE_ALL_VARIABLES ? '' : this._compactToolVariableDetail(data?.variables?.[value]);
            if (detail) text.appendChild(el('span', 'compact-tool-signal-detail', detail));
            row.classList.remove('is-empty');
        } else {
            text.appendChild(el('span', 'compact-tool-signal-name', options.length
                ? i18n.t('compactToolChooseSignal')
                : (sourceSelect?.options[0]?.textContent || i18n.t('outlierNoVariables'))));
            row.classList.add('is-empty');
        }
        row.disabled = !options.length || !!sourceSelect?.disabled;
    };

    proto._compactToolVariableDetail = function(variable) {
        if (!variable) return '';
        const parts = [];
        const n = variable.data?.length;
        if (Number.isFinite(n) && n > 0) parts.push(i18n.t('compactDerivedPreviewPoints').replace('{n}', i18n.formatNumber(n)));
        if (variable.unit) parts.push(variable.unit);
        if (variable.description && variable.description !== variable.name) parts.push(variable.description);
        return parts.join(' · ');
    };

    // What the plot on screen shows of the result.
    proto._compactToolSyncPreviewStrip = function() {
        const toolState = this._compactToolsData?.tool;
        const strip = toolState?.previewStrip;
        if (!strip) return;
        strip.replaceChildren();
        strip.className = 'compact-tool-preview';
        const tool = toolState.tool;
        const source = document.getElementById('outlier-variable')?.value || '';
        const say = (key, tone = '', extra = null) => {
            strip.classList.add(`is-${tone || 'info'}`);
            const swatch = el('span', 'compact-tool-preview-swatch');
            strip.appendChild(swatch);
            const text = el('span', 'compact-tool-preview-text', i18n.t(key)
                .replace('{name}', source)
                .replace('{n}', String(this._compactDerivedPlotTarget?.()?.n || 1)));
            strip.appendChild(text);
            if (extra) strip.appendChild(extra);
            strip.hidden = false;
        };
        strip.hidden = true;
        if (this._isFileDataTool?.(tool)) {
            say(tool === 'xcorr' ? 'compactToolPreviewXcorr' : 'compactToolPreviewFile', 'file');
            return;
        }
        if (!source) return;
        if (this._compactToolIsLazy()) {
            say('compactToolPreviewLazy', 'muted');
            return;
        }
        const panelId = this._compactActivePanelId?.();
        const plot = panelId ? this.plotManager.plots.get(panelId) : null;
        const editing = this._dataToolEditing;
        const seeBtn = () => (this._compact.sheetSize === 'full' && !this._compact.landscape
            ? button('compact-link-btn compact-tool-preview-see', i18n.t('compactToolPreviewSee'), () => this._setCompactSheetSize('half'), { icon: ICON.eye })
            : null);
        if (editing) {
            const shown = !!plot?.traces.some(trace => trace.fileId === editing.fileId && trace.varName === editing.name);
            if (shown) {
                say('compactToolPreviewLive', 'live', seeBtn());
            } else if (plot && COMPACT_SIGNAL_LIST_MODES.has(plot.mode || 'timeseries')) {
                say('compactToolPreviewEditOff', 'muted', button('compact-link-btn compact-tool-preview-show', i18n.t('compactToolPreviewShowIt'), async () => {
                    await this._compactToggleVariable(editing.name);
                    this._compactToolSyncPreviewStrip();
                }));
            }
            return;
        }
        if (this._dataToolPreview && this._dataToolPreview.panelId === panelId) {
            say('compactToolPreviewDrawn', 'dashed', seeBtn());
            return;
        }
        const sourceShown = !!plot?.traces.some(trace => trace.fileId === this.activeFileId && trace.varName === source);
        if (sourceShown && (plot.mode || 'timeseries') === 'timeseries') {
            // On the plot, and nothing drawn yet: the settings are not complete
            // (the footer says what is missing), or the first run is on its way.
            say('compactToolPreviewPending', 'muted');
            return;
        }
        if (plot && (plot.mode || 'timeseries') === 'timeseries') {
            say('compactToolPreviewNeedsSource', 'muted', button('compact-link-btn compact-tool-preview-show', i18n.t('compactToolPreviewShowSource'), async () => {
                await this._compactToggleVariable(source);
                this._handleDataToolPreviewChange?.({ immediate: true });
            }, { icon: ICON.plus }));
            return;
        }
        say('compactToolPreviewNeedsTime', 'muted');
    };

    proto._compactToolSyncFooter = function() {
        const toolState = this._compactToolsData?.tool;
        if (!toolState?.submit) return;
        const createBtn = document.getElementById('data-tool-create');
        const editing = this._dataToolEditing;
        const datasetEditing = this._datasetEditing;
        const updating = !!editing || !!datasetEditing;
        const busy = !!this._dataToolBusy || !!toolState.busy;
        const blocker = this._compactToolBlocker || '';
        const submit = toolState.submit;
        submit.disabled = !createBtn || createBtn.disabled || busy;
        submit.classList.toggle('is-busy', busy);
        const label = submit.querySelector('.compact-btn-label') || submit.appendChild(el('span', 'compact-btn-label'));
        label.textContent = i18n.t(busy ? 'compactToolWorking' : (updating ? 'dataToolUpdate' : 'dataToolCreate'));
        // Why it cannot be pressed, in words, under the buttons.
        let reasonText = '';
        if (!busy && blocker) {
            const translated = i18n.t(blocker);
            reasonText = translated && translated !== blocker ? translated : i18n.t('dataToolFixParameters');
        }
        toolState.reason.textContent = reasonText;
        toolState.reason.hidden = !reasonText;
        submit.title = reasonText;

        // Put on the plot at once: a variable, on the plot on screen when a tap
        // in Data would add it there; a new dataset, wherever the panel puts it.
        const chip = toolState.plotChip;
        const fileTool = this._isFileDataTool?.(toolState.tool);
        let label2 = '';
        if (fileTool) {
            label2 = datasetEditing && this.plotManager.hasTracesForFile?.(datasetEditing.fileId) ? '' : i18n.t('compactToolPlotIt');
        } else {
            const target = this._compactDerivedPlotTarget?.();
            const plot = target ? this.plotManager.plots.get(target.panelId) : null;
            const alreadyOn = !!editing && !!plot?.traces.some(trace => trace.fileId === editing.fileId && trace.varName === editing.name);
            if (target && !alreadyOn) label2 = i18n.t('compactPlotN').replace('{n}', String(target.n));
        }
        chip.hidden = !label2;
        if (label2) {
            chip.querySelector('.compact-btn-label').textContent = label2;
            chip.querySelector('.compact-btn-icon').innerHTML = toolState.addToPlot ? ICON.check : ICON.plus;
            chip.classList.toggle('is-active', toolState.addToPlot);
            chip.setAttribute('aria-pressed', String(toolState.addToPlot));
            const title = fileTool ? i18n.t('compactToolPlotItTitle') : i18n.t('compactToolsPutOnPlot').replace('{n}', label2);
            chip.title = title;
            chip.setAttribute('aria-label', title);
        }
    };

    // Delete, while editing: asked in place, with what goes with it.
    proto._compactToolSyncDelete = function() {
        const toolState = this._compactToolsData?.tool;
        const box = toolState?.deleteBox;
        if (!box) return;
        const editing = this._dataToolEditing;
        const datasetEditing = this._datasetEditing;
        box.replaceChildren();
        if (!editing && !datasetEditing) {
            box.hidden = true;
            return;
        }
        box.hidden = false;
        const list = el('div', 'compact-list');
        if (!toolState.confirmDelete) {
            list.appendChild(button('compact-list-btn compact-list-btn-danger compact-tool-delete-btn',
                i18n.t(editing ? 'compactDerivedDelete' : 'compactToolsDeleteDataset'), () => {
                    toolState.confirmDelete = true;
                    this._compactToolSyncDelete();
                }, { icon: ICON.trash }));
            box.appendChild(list);
            return;
        }
        const chain = editing
            ? (this._dataToolChainDependents?.(editing.fileId, editing.name) || [])
            : (this._derivedDatasetsUnder?.(datasetEditing.fileId) || []);
        const ask = el('div', 'compact-tool-card-confirm compact-tool-delete-confirm');
        ask.appendChild(el('span', 'compact-tool-card-question', chain.length
            ? i18n.t('compactToolsDeleteChain').replace('{count}', String(chain.length))
            : i18n.t(editing ? 'dataToolDeleteConfirm' : 'derivedDatasetDeleteConfirm')));
        ask.appendChild(button('compact-secondary-btn compact-tool-card-keep', i18n.t('dataToolNo'), () => {
            toolState.confirmDelete = false;
            this._compactToolSyncDelete();
        }));
        ask.appendChild(button('compact-secondary-btn compact-danger-btn compact-tool-card-yes', i18n.t('compactToolsDeleteYes'), () => this._compactToolDelete(), { icon: ICON.trash }));
        box.appendChild(ask);
    };

    proto._compactToolsRenderMessage = function() {
        const state = this._compactToolsData;
        if (!state) return;
        const { message, type } = this._dataToolMessage || {};
        const text = (typeof message === 'function' ? message() : message) || '';
        const targets = [state.tool?.message, state.tool ? null : state.hubMessage].filter(Boolean);
        for (const target of targets) {
            setEmphasizedText(target, text);
            target.className = `${target === state.hubMessage ? 'compact-tools-message' : 'compact-tool-message'}${type ? ` is-${type}` : ''}`;
            target.hidden = !text;
        }
    };

    // Analyze says that a draft or an edit is waiting, with a dot.
    proto._compactSyncToolsNav = function() {
        const btn = this._compactNavButtons?.get('analyze');
        if (!btn) return;
        const waiting = !!this._compact?.active && !this._compactToolsData?.tool && !!this._compactToolsInProgress();
        btn.classList.toggle('has-tool-draft', waiting);
    };

    // ─── Create, cancel, delete ───────────────────────────────────

    proto._compactToolSubmit = async function() {
        const toolState = this._compactToolsData?.tool;
        if (!toolState || toolState.busy) return;
        const createBtn = document.getElementById('data-tool-create');
        if (!createBtn || createBtn.disabled) return;
        const tool = toolState.tool;
        const fileTool = !!this._isFileDataTool?.(tool);
        const editing = this._dataToolEditing ? { ...this._dataToolEditing } : null;
        const datasetEditing = this._datasetEditing ? { ...this._datasetEditing } : null;
        const name = (document.getElementById('outlier-output-name')?.value || '').trim();
        const chipOn = !toolState.plotChip.hidden && toolState.addToPlot;
        const target = !fileTool && chipOn ? this._compactDerivedPlotTarget?.() : null;
        const filesBefore = new Set(this.files.keys());
        const fileId = this.activeFileId;

        toolState.busy = true;
        this._compactToolSyncFooter();
        let result = null;
        try {
            result = await this.commitDataTool({ plot: fileTool && chipOn });
        } finally {
            toolState.busy = false;
        }
        if (!result) {
            // The panel's message says why; it is on the page already.
            this._compactToolSyncPage();
            return;
        }
        toolState.done = true;
        this._compactPopToolPage();

        if (target && !fileTool) {
            const plot = this.plotManager.plots.get(target.panelId);
            const already = (plot?.traces || []).some(trace => trace.varName === name && trace.fileId === fileId);
            if (!already) await this._compactToggleVariable(name);
        }
        if (fileTool && chipOn) {
            // The new dataset went on a plot of its own choosing: show that one.
            const newFile = [...this.files.keys()].find(id => !filesBefore.has(id)) || datasetEditing?.fileId || result?.fileId;
            for (const [panelId, plot] of this.plotManager.plots) {
                if ((plot.traces || []).some(trace => trace.fileId === newFile)) {
                    if (panelId !== this._compactActivePanelId?.()) this._setCompactActivePanel?.(panelId);
                    break;
                }
            }
        }
        if (editing) this._compactDerivedRefitShown?.(fileId, name);
        // The hub was drawn before the result went on the plot.
        if (this._compactToolsData?.hub) this._renderCompactToolsHub();
        const key = (editing || datasetEditing) ? 'compactDerivedUpdated' : (target ? 'compactDerivedCreatedOnPlot' : 'compactDerivedCreated');
        this._compactToast(i18n.t(key).replace('{name}', name).replace('{n}', String(target?.n || '')));
        this._compactToolsHighlight(name);
        this._compactSyncToolsNav();
    };

    proto._compactToolCancel = function() {
        const toolState = this._compactToolsData?.tool;
        if (!toolState) return;
        toolState.done = true;
        // Clear for a draft, Cancel for an edit: neither deletes anything, and
        // an edit's live values are put back.
        this.clearDataToolForm();
        this._compactPopToolPage();
        this._compactSyncToolsNav();
    };

    proto._compactToolDelete = async function() {
        const toolState = this._compactToolsData?.tool;
        if (!toolState) return;
        const editing = this._dataToolEditing ? { ...this._dataToolEditing } : null;
        const datasetEditing = this._datasetEditing ? { ...this._datasetEditing } : null;
        toolState.done = true;
        if (editing) {
            this._exitDataToolEditing?.();
            this._deleteDataToolVariable(editing.fileId, editing.name);
            this._compactPopToolPage();
            this._compactToast(i18n.t('compactDerivedDeleted').replace('{name}', editing.name));
        } else if (datasetEditing) {
            this._exitDerivedDatasetEditing?.();
            this.clearDataToolForm();
            this._compactPopToolPage();
            await this.removeFile(datasetEditing.fileId, { confirmed: true });
            if (!this.files.has(datasetEditing.fileId)) this._compactToast(i18n.t('compactDerivedDeleted').replace('{name}', datasetEditing.name));
        }
        if (this._compactToolsData?.hub) this._renderCompactToolsHub();
        this._compactSyncToolsNav();
    };

    // Back on the hub: the new card brought into view and lit for a moment.
    proto._compactToolsHighlight = function(name) {
        setTimeout(() => {
            const hub = this._compactToolsData?.hub;
            const card = hub ? [...hub.node.querySelectorAll('.compact-tool-card')].find(item => item.dataset.result === name) : null;
            if (!card?.offsetParent) return;
            card.scrollIntoView?.({ block: 'nearest' });
            card.classList.remove('compact-flash');
            void card.offsetWidth;
            card.classList.add('compact-flash');
            setTimeout(() => card.classList.remove('compact-flash'), 1600);
        }, 280);
    };

    // ─── The signal list ──────────────────────────────────────────

    proto._openCompactToolSignalPicker = function() {
        const toolState = this._compactToolsData?.tool;
        if (!toolState) return;
        const sourceSelect = document.getElementById('outlier-variable');
        if (!sourceSelect) return;
        const data = this._compactToolsFileData();
        const current = sourceSelect.value;
        const options = [...sourceSelect.options].filter(option => option.value);
        const panelId = this._compactActivePanelId?.();
        const plot = panelId ? this.plotManager.plots.get(panelId) : null;
        const onPlot = new Set((plot?.traces || []).filter(trace => trace.fileId === this.activeFileId).map(trace => trace.varName));
        const node = el('div', 'compact-page compact-page-tool-signal');

        let search = null;
        if (options.length > 8) {
            const searchWrap = el('label', 'compact-derived-search');
            const searchIcon = el('span', 'compact-derived-search-icon');
            searchIcon.innerHTML = ICON.search;
            search = el('input', 'compact-derived-filter compact-tool-signal-filter');
            search.type = 'search';
            search.placeholder = i18n.t('formulaEditorFilter');
            search.setAttribute('aria-label', i18n.t('formulaEditorFilter'));
            search.setAttribute('autocapitalize', 'off');
            search.setAttribute('autocorrect', 'off');
            search.spellcheck = false;
            searchWrap.append(searchIcon, search);
            node.appendChild(searchWrap);
        }
        // The ones on the plot on screen first: those are what the preview
        // can be drawn next to.
        const ordered = [
            ...options.filter(option => option.value === RESAMPLE_ALL_VARIABLES),
            ...options.filter(option => option.value !== RESAMPLE_ALL_VARIABLES && onPlot.has(option.value)),
            ...options.filter(option => option.value !== RESAMPLE_ALL_VARIABLES && !onPlot.has(option.value)),
        ];
        const list = el('div', 'compact-list compact-tool-signal-list');
        list.setAttribute('role', 'listbox');
        const rows = [];
        for (const option of ordered) {
            const value = option.value;
            const all = value === RESAMPLE_ALL_VARIABLES;
            const variable = all ? null : data?.variables?.[value];
            const selected = value === current;
            const row = button(`compact-list-btn compact-tool-signal-option${selected ? ' is-selected' : ''}`, '', () => {
                this._popCompactPage();
                this._compactToolChooseSource(value);
            });
            row.dataset.value = value;
            row.setAttribute('role', 'option');
            row.setAttribute('aria-selected', String(selected));
            const mark = el('span', 'compact-btn-icon compact-tool-signal-mark');
            mark.innerHTML = selected ? ICON.check : '';
            const text = el('span', 'compact-derived-var-text');
            text.appendChild(el('span', 'compact-derived-var-name', all ? option.textContent : value));
            const detail = all ? '' : this._compactToolVariableDetail(variable);
            if (detail) text.appendChild(el('span', 'compact-derived-var-detail', detail));
            row.append(mark, text);
            if (!all && onPlot.has(value)) row.appendChild(el('span', 'compact-derived-var-tag tag-plot', i18n.t('compactToolOnPlot')));
            else if (variable?.dataToolModified || variable?.derived) row.appendChild(el('span', 'compact-derived-var-tag tag-derived', i18n.t('compactToolMade')));
            rows.push(row);
            list.appendChild(row);
        }
        const empty = el('p', 'compact-note', i18n.t('compactDerivedNoMatch'));
        empty.hidden = true;
        node.append(list, empty);
        search?.addEventListener('input', () => {
            const query = search.value.trim().toLowerCase();
            let shown = 0;
            for (const row of rows) {
                const text = row.textContent.toLowerCase();
                row.hidden = !!query && !text.includes(query);
                if (!row.hidden) shown += 1;
            }
            empty.hidden = shown > 0;
        });
        this._pushCompactPage({ title: i18n.t(toolState.tool === 'xcorr' ? 'compactToolSignalX' : 'compactToolSignal'), node, persist: true });
        requestAnimationFrame(() => list.querySelector('.is-selected')?.scrollIntoView?.({ block: 'center' }));
    };

    // ─── Help ─────────────────────────────────────────────────────

    // The tool's help topics: the "?" buttons among its settings.
    proto._compactToolHelpTopics = function(tool) {
        const topics = [];
        for (const selector of compactToolSettingsSelectors(tool)) {
            for (const piece of document.querySelectorAll(selector)) {
                for (const toggle of piece.querySelectorAll('.data-tool-help-toggle')) {
                    const id = toggle.getAttribute('aria-controls');
                    const popover = id ? document.getElementById(id) : null;
                    if (!popover || topics.some(topic => topic.id === id)) continue;
                    const title = popover.querySelector('.derived-help-title')?.textContent?.trim() || toggle.title || '';
                    topics.push({ id, title });
                }
            }
        }
        return topics;
    };

    proto._openCompactToolHelpIndex = function(tool, topics) {
        const node = el('div', 'compact-page compact-page-tool-help-index');
        const list = el('div', 'compact-list compact-menu-list');
        for (const topic of topics) {
            const row = el('button', 'compact-menu-btn');
            row.type = 'button';
            const icon = el('span', 'compact-btn-icon compact-menu-icon');
            icon.innerHTML = ICON.help;
            const text = el('span', 'compact-menu-text');
            text.appendChild(el('span', 'compact-menu-label', topic.title));
            row.append(icon, text);
            row.addEventListener('click', (event) => {
                event.stopPropagation();
                this._openCompactToolHelp(topic.id);
            });
            list.appendChild(row);
        }
        node.appendChild(list);
        this._pushCompactPage({ title: i18n.t('compactToolsHelpOf').replace('{tool}', this._compactToolLabelFor(tool)), node, persist: true });
    };

    // A popover of the panel, as a page: the same text, in the user's
    // language, read at a phone's size. A "more" link inside it is a page too.
    proto._openCompactToolHelp = function(popoverId) {
        const popover = document.getElementById(popoverId);
        if (!popover) return;
        const node = el('div', 'compact-page compact-page-tool-help');
        const copy = popover.cloneNode(true);
        copy.removeAttribute('id');
        copy.hidden = false;
        copy.className = 'compact-tool-help';
        copy.removeAttribute('role');
        const title = copy.querySelector('.derived-help-title');
        const titleText = title?.textContent?.trim() || '';
        title?.remove();
        copy.querySelectorAll('[id]').forEach(item => item.removeAttribute('id'));
        copy.querySelectorAll('.derived-help-more').forEach((more) => {
            const target = more.getAttribute('aria-controls');
            more.className = 'compact-link-btn compact-tool-help-more';
            more.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (target) this._openCompactToolHelp(target);
            });
        });
        node.appendChild(copy);
        this._pushCompactPage({ title: titleText || i18n.t('compactToolsHelp'), node, persist: true });
    };

    // ─── Entry point ──────────────────────────────────────────────

    // The Analyze sheet's row, in the section of what makes new signals.
    proto._compactToolsAnalyzeRow = function() {
        const row = el('button', 'compact-menu-btn compact-tools-analyze-row');
        row.type = 'button';
        const icon = el('span', 'compact-btn-icon compact-menu-icon');
        icon.innerHTML = ICON.tools;
        const text = el('span', 'compact-menu-text');
        text.appendChild(el('span', 'compact-menu-label', i18n.t('dataTools')));
        const data = this._compactToolsFileData();
        const progress = data ? this._compactToolsInProgress() : null;
        let subtitle;
        if (!data) subtitle = i18n.t('compactToolsNeedFile');
        else if (progress) subtitle = i18n.t(progress.kind === 'draft' ? 'compactToolsInProgress' : 'compactToolsEditing').replace('{tool}', this._compactToolLabelFor(progress.tool));
        else {
            const count = (this._orderedDataToolDefinitions?.(this.activeFileId) || []).length
                + (this._derivedDatasetsOf?.(this.activeFileId) || []).length;
            subtitle = count
                ? i18n.t('compactToolsAnalyzeCount').replace('{count}', String(count))
                : i18n.t('compactToolsAnalyzeSubtitle');
        }
        const sub = el('span', 'compact-menu-subtitle', subtitle);
        sub.classList.toggle('is-waiting', !!progress);
        text.appendChild(sub);
        row.append(icon, text);
        row.disabled = !data;
        row.addEventListener('click', (event) => {
            event.stopPropagation();
            this._openCompactToolsHub();
            // A draft or an edit left behind goes straight back to its page.
            if (progress) this._openCompactTool(progress.tool, { resume: true });
        });
        return row;
    };
}
