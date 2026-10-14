// Measurement cursors on the phone layout (docs/phone-web-specification.md §6.2).
//
// The cursors themselves are the desktop's: the same A and B, the same state on
// the plot, the same measurements (plots/methods/interaction-methods.js). What a
// phone changes is how they are reached and read:
//
//  - On the plot, each line has a tab at its foot, the size of a finger
//    (utils/cursor-handles.js). A cursor out of view leaves its tab at the edge.
//    A tab held still, then dragged, moves both cursors together.
//  - The desktop's floating box — small buttons, Shift and Ctrl hints — is not
//    shown. Its reading goes to a sheet like the others: half the screen under
//    the plot when upright, beside it when sideways, the whole screen if asked.
//    The sheet adds what a finger lacks: arrows that step a cursor sample by
//    sample (or peak by peak), and keep stepping while held.
//  - Hidden, the sheet leaves Δx and Δy in the app bar; a tap there brings it
//    back. On a small phone that is the way to see the whole plot and still
//    read the measurement.
//  - A|B in the plot's corner turns them on and off; so does a switch in the
//    Plot sheet.
import i18n from '../../i18n/index.js';
import { copyTextToClipboard, cursorReadoutText } from '../../utils/clipboard.js';
import { button, el, section } from './compact-dom.js';

const ICONS = {
    // A finger tapping: on the app bar's reading while the sheet is hidden, to
    // say that a tap there brings it back.
    tap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 12V6.5a1.5 1.5 0 0 1 3 0V11"/><path d="M12 10.5a1.5 1.5 0 0 1 3 0V12"/><path d="M15 11.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-.8a5 5 0 0 1-3.7-1.7l-3-3.3a1.4 1.4 0 0 1 2-2L9 16.5"/><path d="M6.6 5.2A4.5 4.5 0 0 1 8.5 2.6M14.4 5.2a4.5 4.5 0 0 0-1.9-2.6"/></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>',
};

// What the arrows step to. "Sample" is the fine adjustment a finger cannot
// make by dragging.
const STEP_TARGETS = [
    { target: 'sample', labelKey: 'compactCursorStepSample' },
    { target: 'max', labelKey: 'compactCursorStepMax' },
    { target: 'min', labelKey: 'compactCursorStepMin' },
    { target: 'zero', labelKey: 'compactCursorStepZero' },
];

// A held arrow starts repeating after this, then steps this often.
const STEP_HOLD_MS = 420;
const STEP_REPEAT_MS = 70;

const isShownTrace = trace => trace.visible !== false && trace.visible !== 'legendonly';

export function installCompactCursorMethods(ViewerClass) {
    const proto = ViewerClass.prototype;

    proto._initCompactCursors = function() {
        // The last reading of each view of each plot, as the desktop box
        // computed it.
        this._compactCursorReadouts = new WeakMap();
        this._compactCursorPage = null;
        const pm = this.plotManager;
        pm.onCursorReadout = (view, readout) => this._compactOnCursorReadout(view, readout);
        pm.onCursorsChanged = () => this._compactSyncCursors();
    };

    proto._compactActivePlot = function() {
        const panelId = this._compactActivePanelId();
        return { panelId, plot: panelId ? this.plotManager.plots.get(panelId) : null };
    };

    // Can this plot have cursors at all, right now?
    proto._compactCanUseCursors = function(plot) {
        const pm = this.plotManager;
        if (!plot?.div || !pm._hasContent(plot) || !pm._plotSupportsCursors(plot)) return false;
        // An analysis showing only its result has no time pane to put them on;
        // FFT still has its spectrum.
        return plot.mode === 'fft' || !pm._cursorTimePaneHidden(plot);
    };

    // The cursor views that are on and on screen: the time pane, and in FFT
    // the spectrum as well.
    proto._compactCursorViews = function(plot, panelId) {
        const pm = this.plotManager;
        if (!plot?.div || !pm._plotSupportsCursors(plot)) return [];
        const timeHidden = pm._cursorTimePaneHidden(plot);
        return pm._cursorViews(panelId, plot)
            .filter(view => pm._viewCursors(view).enabled && !(timeHidden && !view.isSpectrum));
    };

    // Which pane carries the A|B button: the time pane, or the spectrum when
    // FFT hides the time pane.
    proto._compactCursorPane = function(plot) {
        if (!this._compactCanUseCursors(plot)) return null;
        return plot.mode === 'fft' && this.plotManager._cursorTimePaneHidden(plot) ? 'spectrum' : 'main';
    };

    proto._compactToggleCursors = function() {
        const pm = this.plotManager;
        const { panelId, plot } = this._compactActivePlot();
        if (!plot) return;
        const wasOn = pm._anyCursorEnabled(plot);
        if (!wasOn && !this._compactCanUseCursors(plot)) return;
        pm._toggleCursors(panelId);
        const nowOn = pm._anyCursorEnabled(plot);
        if (!wasOn && nowOn) {
            this._openCompactSheet('cursors', { toggle: false });
        } else if (!nowOn && this._compact.sheet === 'cursors') {
            this._closeCompactSheet();
        } else if (this._compact.sheet === 'plot') {
            this._renderCompactSheetContent();
        }
        this._compactSyncCursors();
    };

    proto._compactToggleCursorSheet = function() {
        if (this._compact.sheet === 'cursors') this._closeCompactSheet();
        else this._openCompactSheet('cursors', { toggle: false });
    };

    // ── Keeping the phone's pieces in step ─────────────────────────────

    proto._compactOnCursorReadout = function(view, readout) {
        let byView = this._compactCursorReadouts.get(view.plot);
        if (!byView) {
            byView = {};
            this._compactCursorReadouts.set(view.plot, byView);
        }
        byView[view.id] = readout;
        if (!this._compact?.active) return;
        if (view.plot !== this._compactActivePlot().plot) return;
        this._compactSyncCursorChip();
        const page = this._compactCursorPage;
        if (page?.node.isConnected && page.plot === view.plot && page.viewId === view.id) {
            this._compactFillCursorValues(page, readout);
        }
    };

    // Everything that shows the cursors' state: the chip, the A|B button, and
    // the sheet if it is open on a plot whose cursors went away or changed.
    proto._compactSyncCursors = function() {
        if (!this._compact?.active) return;
        this._compactSyncCursorChip();
        this._compactSyncAllFitButtons?.();
        if (this._compact.sheet !== 'cursors') return;
        const { panelId, plot } = this._compactActivePlot();
        const views = this._compactCursorViews(plot, panelId);
        if (!views.length) {
            this._closeCompactSheet();
            return;
        }
        const page = this._compactCursorPage;
        const shape = this._compactCursorPageShape(plot, views);
        if (!page?.node.isConnected || page.plot !== plot || page.shape !== shape) this._renderCompactSheetContent();
    };

    // What the sheet was built for: when any of it changes, it is rebuilt.
    proto._compactCursorPageShape = function(plot, views) {
        const traces = (plot?.traces || []).filter(isShownTrace)
            .map(trace => `${trace.fileId}\u0000${trace.varName}\u0000${trace.color || ''}`).join('\u0001');
        return [views.map(view => view.id).join(','), traces, i18n.currentLang].join('\u0002');
    };

    // The app bar's Δx and Δy, while the cursors are on.
    proto._compactSyncCursorChip = function() {
        const chip = this._compactCursorChip;
        if (!chip) return;
        const pm = this.plotManager;
        const { panelId, plot } = this._compactActivePlot();
        const views = this._compact?.active ? this._compactCursorViews(plot, panelId) : [];
        const show = views.length > 0;
        chip.hidden = !show;
        this._compactAppBar?.classList.toggle('has-cursor-chip', show);
        if (!show) return;
        const view = views.find(candidate => !candidate.isSpectrum) || views[0];
        let readout = this._compactCursorReadouts.get(plot)?.[view.id];
        if (!readout && !this._compactCursorSyncing) {
            // Turned on before the phone layout was (a session, the desktop
            // layout): ask for a reading. It comes back through the hook.
            this._compactCursorSyncing = true;
            try { pm._syncCursorDisplay(panelId, plot); } finally { this._compactCursorSyncing = false; }
            readout = this._compactCursorReadouts.get(plot)?.[view.id];
        }
        const open = this._compact.sheet === 'cursors';
        // Built once: the reading changes with every move of a cursor, and the
        // finger's nudge must not restart with it.
        if (!chip._parts) {
            const tap = el('span', 'compact-cursor-chip-tap');
            tap.setAttribute('aria-hidden', 'true');
            tap.innerHTML = ICONS.tap;
            tap.addEventListener('animationend', () => tap.classList.remove('is-nudging'));
            const ab = el('span', 'compact-cursor-chip-ab');
            ab.setAttribute('aria-hidden', 'true');
            const letterA = el('b', '', 'A');
            const letterB = el('b', '', 'B');
            ab.append(letterA, letterB);
            const text = el('span', 'compact-cursor-chip-text');
            chip.replaceChildren(tap, ab, text);
            chip._parts = { tap, letterA, letterB, text };
        }
        const { tap, letterA, letterB, text } = chip._parts;
        // The sheet just went away: the finger shows once where it comes back.
        if (!open && chip._wasOpen) {
            tap.classList.remove('is-nudging');
            void tap.offsetWidth;
            tap.classList.add('is-nudging');
        }
        chip._wasOpen = open;
        chip.classList.toggle('is-open', open);
        chip.setAttribute('aria-expanded', String(open));
        letterA.style.color = readout?.colorA || '#ff9800';
        letterB.style.color = readout?.colorB || '#2196f3';
        // The reading is HTML the desktop box escaped (interaction-methods).
        text.innerHTML = !readout ? ''
            : readout.empty ? pm._escapeHTML(readout.message || '')
            : `<span>${readout.dxHTML}</span> <span>${readout.dyHTML}</span>`;
    };

    // The A|B button among the plot's corner buttons (compact-methods:
    // _compactSyncFitButtons builds the group).
    proto._compactSyncCursorButton = function(group, owner) {
        let btn = group.querySelector('.compact-cursor-btn');
        if (!btn) {
            btn = button('compact-fit-btn compact-cursor-btn', 'A|B', () => this._compactToggleCursors(), { title: i18n.t('cursorsToggle') });
            group.insertBefore(btn, group.firstChild);
        }
        const pane = this._compactCursorPane(owner.plot);
        btn.hidden = !pane || owner.pane !== pane;
        const on = this.plotManager._anyCursorEnabled(owner.plot);
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-pressed', String(on));
        btn.title = i18n.t('cursorsToggle');
    };

    // ── Plot sheet: the switch ─────────────────────────────────────────

    proto._buildCompactCursorSection = function(node, plot) {
        const pm = this.plotManager;
        if (!plot) return;
        const on = pm._anyCursorEnabled(plot);
        if (!on && !this._compactCanUseCursors(plot)) return;
        const wrap = section(i18n.t('cursorsToggle'));
        const row = el('label', 'compact-switch-row compact-cursor-switch');
        const input = el('input');
        input.type = 'checkbox';
        input.checked = on;
        input.addEventListener('change', () => this._compactToggleCursors());
        row.append(el('span', '', i18n.t('compactCursorsSwitch')), input);
        wrap.appendChild(row);
        if (on) {
            const actions = el('div', 'compact-action-row');
            actions.appendChild(button('compact-secondary-btn compact-cursor-readout-btn', i18n.t('compactCursorsReadout'), () => this._openCompactSheet('cursors', { toggle: false })));
            wrap.appendChild(actions);
        } else {
            wrap.appendChild(el('p', 'compact-note', i18n.t('compactCursorsNote')));
        }
        node.appendChild(wrap);
    };

    // ── The Cursors sheet ──────────────────────────────────────────────

    proto._buildCompactCursorsPage = function() {
        const pm = this.plotManager;
        const { panelId, plot } = this._compactActivePlot();
        const node = el('div', 'compact-page compact-page-cursors');
        const page = { title: i18n.t('cursorsToggle'), node };
        const views = this._compactCursorViews(plot, panelId);
        this._compactCursorPage = null;
        if (!views.length) {
            node.appendChild(el('p', 'compact-note', i18n.t('compactCursorsOffNote')));
            if (this._compactCanUseCursors(plot)) {
                const actions = el('div', 'compact-action-row');
                actions.appendChild(button('compact-primary-btn', i18n.t('compactCursorsTurnOn'), () => this._compactToggleCursors()));
                node.appendChild(actions);
            }
            return page;
        }
        if (!views.some(view => view.id === this._compact.cursorViewId)) this._compact.cursorViewId = views[0].id;
        const view = views.find(candidate => candidate.id === this._compact.cursorViewId);

        // FFT: the time pane's cursors and the spectrum's, one at a time.
        if (views.length > 1) {
            const switcher = el('div', 'compact-segmented compact-cursor-views');
            switcher.setAttribute('role', 'tablist');
            for (const candidate of views) {
                const selected = candidate.id === view.id;
                const tab = button(`compact-segment${selected ? ' is-active' : ''}`, i18n.t(candidate.isSpectrum ? 'fftCursorSpectrumSection' : 'fftCursorTimeSection'), () => {
                    if (selected) return;
                    this._compact.cursorViewId = candidate.id;
                    this._renderCompactSheetContent();
                });
                tab.setAttribute('role', 'tab');
                tab.setAttribute('aria-selected', String(selected));
                switcher.appendChild(tab);
            }
            node.appendChild(switcher);
        }

        // The reading first: it is what the user is watching while dragging.
        const values = el('div', `compact-cursor-values${view.isSpectrum ? ' is-spectrum' : ''}`);
        values.addEventListener('click', (event) => {
            // The spectrum's "?" beside 1/Δf: its note opens in place.
            const help = event.target.closest('.cursor-help-btn');
            if (!help) return;
            event.preventDefault();
            event.stopPropagation();
            current.helpOpen = !current.helpOpen;
            this._compactSyncCursorHelp(current);
        });
        node.appendChild(values);

        // Each cursor: the trace it reads, and arrows that step it.
        const rows = el('div', 'compact-cursor-rows');
        const badges = {};
        const traces = (plot.traces || []).filter(isShownTrace);
        for (const which of ['a', 'b']) {
            const letter = which.toUpperCase();
            const row = el('div', `compact-cursor-row compact-cursor-row-${which}`);
            const badge = el('span', 'compact-cursor-badge', letter);
            badges[which] = badge;
            const select = el('select', 'compact-cursor-trace');
            select.setAttribute('aria-label', `${letter} — ${i18n.t('cursorTraceLabel')}`);
            const reads = pm._resolveCursorTrace(view, which);
            traces.forEach((trace, index) => {
                const option = el('option', '', pm._traceName(trace.varName, trace.fileId));
                option.value = String(index);
                option.selected = pm._sameCursorTrace(trace, reads);
                select.appendChild(option);
            });
            select.addEventListener('change', () => pm._setCursorTrace(view, which, traces[Number(select.value)]));
            row.append(
                badge,
                select,
                this._compactCursorStepButton(view, which, 'prev'),
                this._compactCursorStepButton(view, which, 'next'),
            );
            rows.appendChild(row);
        }
        node.appendChild(rows);

        const step = el('div', 'compact-cursor-step');
        step.appendChild(el('span', 'compact-cursor-step-label', i18n.t('compactCursorStepTo')));
        const targets = el('div', 'compact-segmented compact-cursor-targets');
        const chosen = this._compact.cursorStep || 'sample';
        for (const { target, labelKey } of STEP_TARGETS) {
            const selected = target === chosen;
            const choice = button(`compact-segment${selected ? ' is-active' : ''}`, i18n.t(labelKey), () => {
                this._compact.cursorStep = target;
                targets.querySelectorAll('.compact-segment').forEach(segment => {
                    const on = segment.dataset.target === target;
                    segment.classList.toggle('is-active', on);
                    segment.setAttribute('aria-pressed', String(on));
                });
            });
            choice.dataset.target = target;
            choice.setAttribute('aria-pressed', String(selected));
            targets.appendChild(choice);
        }
        step.appendChild(targets);
        node.appendChild(step);

        if (!view.isSpectrum) {
            const secant = el('label', 'compact-switch-row');
            const input = el('input');
            input.type = 'checkbox';
            input.checked = !!pm._viewCursors(view).showSecant;
            input.addEventListener('change', () => {
                pm._viewCursors(view).showSecant = input.checked;
                pm._syncCursorDisplay(panelId, plot);
            });
            secant.append(el('span', '', i18n.t('cursorSecantLine')), input);
            node.appendChild(secant);
        }

        const actions = el('div', 'compact-action-row');
        actions.appendChild(button('compact-secondary-btn', i18n.t('cursorCopy'), () => this._compactCopyCursorReadout(view)));
        actions.appendChild(button('compact-secondary-btn compact-danger-btn', i18n.t('compactCursorsOff'), () => {
            if (pm._anyCursorEnabled(plot)) this._compactToggleCursors();
        }));
        node.appendChild(actions);
        node.appendChild(el('p', 'compact-note', i18n.t('compactCursorsHint')));

        const current = {
            node,
            plot,
            panelId,
            viewId: view.id,
            values,
            badges,
            helpOpen: false,
            shape: this._compactCursorPageShape(plot, views),
        };
        this._compactCursorPage = current;
        page.onClose = () => {
            if (this._compactCursorPage === current) this._compactCursorPage = null;
        };
        const readout = this._compactCursorReadouts.get(plot)?.[view.id];
        if (readout) this._compactFillCursorValues(current, readout);
        else pm._syncCursorDisplay(panelId, plot);
        return page;
    };

    proto._compactFillCursorValues = function(page, readout) {
        if (readout.empty) {
            page.values.textContent = readout.message || '';
            return;
        }
        // Built and escaped by the desktop box (interaction-methods).
        page.values.innerHTML = readout.valuesHTML;
        if (page.badges.a) page.badges.a.style.background = readout.colorA || '';
        if (page.badges.b) page.badges.b.style.background = readout.colorB || '';
        this._compactSyncCursorHelp(page);
    };

    proto._compactSyncCursorHelp = function(page) {
        const popover = page.values.querySelector('.cursor-help-popover');
        if (popover) popover.hidden = !page.helpOpen;
        page.values.querySelector('.cursor-help-btn')?.setAttribute('aria-expanded', String(!!page.helpOpen));
    };

    // ◀ / ▶ for one cursor: a tap is one step; held, it keeps stepping. A
    // touch that turns into a scroll of the sheet steps nothing.
    proto._compactCursorStepButton = function(view, which, direction) {
        const pm = this.plotManager;
        const title = i18n.t(direction === 'prev' ? 'compactCursorStepBack' : 'compactCursorStepForward')
            .replace('{c}', which.toUpperCase());
        const btn = el('button', `compact-icon-btn compact-cursor-step-btn is-${direction}`);
        btn.type = 'button';
        btn.title = title;
        btn.setAttribute('aria-label', title);
        btn.dataset.cursor = which;
        btn.dataset.direction = direction;
        btn.innerHTML = `<span class="compact-btn-icon">${ICONS[direction]}</span>`;
        let timer = null;
        let held = false;
        let repeated = false;
        let running = false;
        const step = async () => {
            if (running) return;
            running = true;
            try {
                await pm._jumpCursorTo(view, which, this._compact.cursorStep || 'sample', direction);
            } finally {
                running = false;
            }
        };
        const repeat = async () => {
            if (!held) return;
            await step();
            if (held) timer = setTimeout(repeat, STEP_REPEAT_MS);
        };
        const stop = () => {
            held = false;
            clearTimeout(timer);
            timer = null;
        };
        btn.addEventListener('pointerdown', (event) => {
            if (event.pointerType === 'mouse' && event.button !== 0) return;
            held = true;
            repeated = false;
            clearTimeout(timer);
            timer = setTimeout(() => {
                repeated = true;
                repeat();
            }, STEP_HOLD_MS);
        });
        for (const type of ['pointerup', 'pointerleave', 'pointercancel']) btn.addEventListener(type, stop);
        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            // A hold already stepped; its release is not one more.
            if (repeated) {
                repeated = false;
                return;
            }
            step();
        });
        btn.addEventListener('contextmenu', event => event.preventDefault());
        return btn;
    };

    proto._compactCopyCursorReadout = async function(view) {
        const pm = this.plotManager;
        const page = this._compactCursorPage;
        if (!page) return;
        const traceLines = ['a', 'b'].map(which => {
            const trace = pm._resolveCursorTrace(view, which);
            return trace ? `${which.toUpperCase()}: ${pm._traceName(trace.varName, trace.fileId)}` : '';
        });
        const text = cursorReadoutText(page.values, traceLines);
        const copied = text ? await copyTextToClipboard(text) : false;
        this._compactToast(i18n.t(copied ? 'cursorCopied' : 'cursorCopyFailed'));
    };
}
