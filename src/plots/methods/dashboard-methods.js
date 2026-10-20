import i18n from '../../i18n/index.js';

/**
 * Dashboard: a panel mode that shows each signal as a card with its value —
 * the last one read, or the one at an instant picked on a time slider.
 *
 * The cards are the panel's traces, in their order, so a time-series panel
 * turns into a dashboard (and back) with its signals, and a saved view keeps
 * them with no format of its own. What a card adds to its trace lives on it,
 * in `trace.card`: a title, a description under it, a background colour, the
 * number of decimals, how many columns of the grid it spans. Its
 * unit is the variable's own (setVariableUnit): one unit per signal, the one
 * the plots, the hover and the statistics show too.
 *
 * `plot.dashboard` holds the rest: whether the cards follow the last value
 * (`follow`, what a Live Update panel wants) or show the instant `time`, the
 * size of the cards, and the separators between them. A separator (a title
 * across the grid, with a colour of its own) is kept by how many cards come
 * before it (`at`), so it stays in place through a saved view applied to
 * other files; on screen, cards and separators are one sequence of items
 * (_dashboardItems) that dragging and the move buttons reorder.
 *
 * Nothing here is drawn by Plotly: the panel's chart is `plot.dashboardEl`, and
 * `plot.div` stays null, so the code that walks every chart leaves it alone.
 */

export const DASHBOARD_SIZES = ['s', 'm', 'l'];
// Two rows of strong colours, for a card that has to stand out, then two of
// light ones, for groups of cards that read as one; the text on each is
// chosen to read on it (readableTextColor).
export const DASHBOARD_COLORS = [
    '#1976d2', '#0097a7', '#00897b', '#43a047', '#7cb342', '#fbc02d', '#fb8c00',
    '#e53935', '#d81b60', '#8e24aa', '#5e35b1', '#6d4c41', '#546e7a', '#212121',
    '#bbdefb', '#b2ebf2', '#b2dfdb', '#c8e6c9', '#dcedc8', '#fff9c4', '#ffe0b2',
    '#ffcdd2', '#f8bbd0', '#e1bee7', '#d1c4e9', '#d7ccc8', '#cfd8dc', '#f5f5f5',
];
const DECIMALS = ['auto', '0', '1', '2', '3', '4', '5', '6'];
// How many columns of the grid a card takes: a long title or value gets room.
export const CARD_SPANS = [1, 2, 3];
const SLIDER_STEPS = 1000;
const CARD_DRAG_TYPE = 'application/x-omv-card';

// What a drag carries: its panel and the place of the card or separator in
// its sequence of items. One let go over another dashboard is not one of that
// dashboard's items.
function readCardDrag(dataTransfer, panelId) {
    try {
        const payload = JSON.parse(dataTransfer?.getData(CARD_DRAG_TYPE) || 'null');
        return payload && payload.panelId === panelId && Number.isInteger(payload.item) ? payload.item : null;
    } catch {
        return null;
    }
}

let separatorCounter = 0;

export function normalizeSeparator(raw = {}) {
    const bg = typeof raw?.bg === 'string' && /^#[0-9a-f]{6}$/i.test(raw.bg) ? raw.bg.toLowerCase() : '';
    const at = Math.max(0, Math.floor(Number(raw?.at) || 0));
    const id = typeof raw?.id === 'string' && raw.id ? raw.id.slice(0, 40) : `sep_${Date.now().toString(36)}_${++separatorCounter}`;
    return { id, title: String(raw?.title || '').slice(0, 80), bg, at };
}

export function normalizeDashboardState(raw = {}) {
    const time = Number(raw?.time);
    return {
        follow: raw?.follow !== false,
        time: Number.isFinite(time) ? time : null,
        size: DASHBOARD_SIZES.includes(raw?.size) ? raw.size : 'm',
        separators: (Array.isArray(raw?.separators) ? raw.separators : []).slice(0, 100).map(normalizeSeparator),
    };
}

export function normalizeCardSettings(raw = {}) {
    const bg = typeof raw?.bg === 'string' && /^#[0-9a-f]{6}$/i.test(raw.bg) ? raw.bg.toLowerCase() : '';
    const decimals = DECIMALS.includes(String(raw?.decimals)) ? String(raw.decimals) : 'auto';
    const span = CARD_SPANS.includes(Number(raw?.span)) ? Number(raw.span) : 1;
    return {
        title: String(raw?.title || '').slice(0, 80),
        description: String(raw?.description || '').slice(0, 200),
        bg,
        decimals,
        span,
    };
}

/** Index of the last sample at or before `t`, or -1 when there is none. */
export function lastIndexAtOrBefore(times, t) {
    const n = times?.length || 0;
    if (!n || !(Number(t) >= Number(times[0]))) return -1;
    if (t >= times[n - 1]) return n - 1;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= t) lo = mid;
        else hi = mid;
    }
    return lo;
}

export function formatDashboardValue(value, decimals = 'auto') {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    const n = Number(value);
    if (Number.isNaN(n)) return 'NaN';
    if (!Number.isFinite(n)) return n > 0 ? '∞' : '−∞';
    if (decimals !== 'auto' && DECIMALS.includes(String(decimals))) return n.toFixed(Number(decimals));
    const abs = Math.abs(n);
    if (abs !== 0 && (abs >= 1e7 || abs < 1e-4)) return n.toExponential(3);
    if (Number.isInteger(n)) return String(n);
    // Six significant digits, without the zeros toPrecision pads with.
    return String(Number(n.toPrecision(6)));
}

/** Black or white, whichever reads on `hex`. */
export function readableTextColor(hex) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
    if (!match) return '';
    const [r, g, b] = match.slice(1).map(part => {
        const c = parseInt(part, 16) / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#1a1a1a' : '#ffffff';
}

/**
 * A unit written into a variable's description, the place every reader takes
 * it from (`_extractUnit`): replacing the one there, or added after it. The
 * description as the file had it is kept beside it, so clearing the unit
 * gives that back.
 */
export function describeWithUnit(baseDescription, unit) {
    const base = String(baseDescription || '');
    if (!unit) return base;
    const withoutUnit = base.replace(/\s*\[[^\]]*\]/, '').trim();
    return withoutUnit ? `${withoutUnit} [${unit}]` : `[${unit}]`;
}

export function installPlotDashboardMethods(TargetClass) {
    const proto = TargetClass.prototype;

    proto._defaultDashboardState = function() {
        return normalizeDashboardState({});
    };

    proto._ensureDashboardState = function(plot) {
        if (!plot.dashboard) plot.dashboard = this._defaultDashboardState();
        if (!Array.isArray(plot.dashboard.separators)) plot.dashboard.separators = [];
        return plot.dashboard;
    };

    // ── Items: the cards and the separators, in their order on screen ──

    proto._dashboardItems = function(plot) {
        const separators = [...this._ensureDashboardState(plot).separators]
            .map((sep, order) => ({ sep, order }))
            .sort((a, b) => (a.sep.at - b.sep.at) || (a.order - b.order))
            .map(entry => entry.sep);
        const items = [];
        let next = 0;
        const count = plot.traces.length;
        for (let index = 0; index <= count; index++) {
            while (next < separators.length && Math.min(separators[next].at, count) <= index) {
                items.push({ type: 'separator', sep: separators[next++] });
            }
            if (index < count) items.push({ type: 'card', trace: plot.traces[index], index });
        }
        return items;
    };

    // The cards in their new order, and every separator counted again by the
    // cards before it.
    proto._setDashboardItems = function(plot, items) {
        const traces = [];
        const separators = [];
        for (const item of items) {
            if (item.type === 'card') traces.push(item.trace);
            else {
                item.sep.at = traces.length;
                separators.push(item.sep);
            }
        }
        plot.traces = traces;
        this._ensureDashboardState(plot).separators = separators;
    };

    // `gap`: where it goes, as a position between the items as they are now
    // (0 before the first, items.length after the last).
    proto._moveDashboardItem = function(panelId, from, gap) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const items = this._dashboardItems(plot);
        if (!items[from] || gap < 0 || gap > items.length || gap === from || gap === from + 1) return;
        const [item] = items.splice(from, 1);
        items.splice(gap > from ? gap - 1 : gap, 0, item);
        this._setDashboardItems(plot, items);
        this._renderDashboardCards(panelId);
    };

    proto._addDashboardSeparator = function(panelId, gap, settings = {}) {
        const plot = this.plots.get(panelId);
        if (!plot) return null;
        const items = this._dashboardItems(plot);
        const sep = normalizeSeparator({ ...settings, id: '' });
        items.splice(Math.max(0, Math.min(gap, items.length)), 0, { type: 'separator', sep });
        this._setDashboardItems(plot, items);
        this._renderDashboardCards(panelId);
        return sep;
    };

    proto._removeDashboardSeparator = function(panelId, id) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureDashboardState(plot);
        state.separators = state.separators.filter(sep => sep.id !== id);
        this._closeDashboardCardEditor();
        this._renderDashboardCards(panelId);
    };

    proto._normalizeDashboardState = function(raw) {
        return normalizeDashboardState(raw);
    };

    // Normalized in place: the card editor holds this object while it is open.
    proto._dashboardCard = function(trace) {
        if (!trace.card || typeof trace.card !== 'object') trace.card = {};
        Object.assign(trace.card, normalizeCardSettings(trace.card));
        return trace.card;
    };

    // ── Units ──

    proto.setVariableUnit = function(fileId, varName, unit) {
        const entry = this.files.get(fileId);
        if (!entry) return;
        const clean = String(unit || '').trim().replace(/[\[\]]/g, '').slice(0, 32);
        entry.unitOverrides = { ...(entry.unitOverrides || {}) };
        if (clean) entry.unitOverrides[varName] = clean;
        else delete entry.unitOverrides[varName];
        entry.dataEpoch = (entry.dataEpoch || 0) + 1;
        this._applyUnitOverride(entry.data?.variables?.[varName], clean);
        // Every other panel that writes the unit (legend, hover, axis titles).
        for (const [panelId, plot] of this.plots) {
            if (plot.mode === 'dashboard') continue;
            const uses = plot.traces.some(t => t.fileId === fileId && t.varName === varName)
                || plot.phaseTraces.some(t => t.fileId === fileId && [t.x, t.y, t.z].includes(varName));
            if (uses && plot.div) this._rebuildPanel(panelId, { preserveView: true });
        }
        this.refreshDashboards();
        this.onVariableUnitChanged?.(fileId, varName);
    };

    proto.getUnitOverrides = function(fileId) {
        return { ...(this.files.get(fileId)?.unitOverrides || {}) };
    };

    proto.setUnitOverrides = function(fileId, overrides) {
        const entry = this.files.get(fileId);
        if (!entry) return;
        const clean = {};
        for (const [name, unit] of Object.entries(overrides || {})) {
            const value = String(unit || '').trim().replace(/[\[\]]/g, '').slice(0, 32);
            if (value) clean[name] = value;
        }
        // The variables that had one and no longer do get their own back.
        for (const name of Object.keys(entry.unitOverrides || {})) {
            if (!clean[name]) this._applyUnitOverride(entry.data?.variables?.[name], '');
        }
        entry.unitOverrides = clean;
        entry.dataEpoch = (entry.dataEpoch || 0) + 1;
        this._applyUnitOverrides(fileId);
    };

    // Written again into data that was read again (a reload, a re-parse).
    proto._applyUnitOverrides = function(fileId) {
        const entry = this.files.get(fileId);
        for (const [name, unit] of Object.entries(entry?.unitOverrides || {})) {
            this._applyUnitOverride(entry.data?.variables?.[name], unit);
        }
    };

    proto._applyUnitOverride = function(variable, unit) {
        if (!variable) return;
        if (!Object.prototype.hasOwnProperty.call(variable, '_fileDescription')) {
            // Not enumerable: never copied into a saved session.
            Object.defineProperty(variable, '_fileDescription', {
                value: variable.description || '', writable: true, configurable: true, enumerable: false,
            });
        }
        variable.description = describeWithUnit(variable._fileDescription, unit);
    };

    // ── Cards ──

    proto._addDashboardCards = function(panelId, varNames, panelEl) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const fileId = this.activeFileId;
        let added = 0;
        for (const varName of varNames) {
            const variable = this.data?.variables?.[varName];
            if (!variable || variable.kind === 'abscissa') continue;
            if (plot.traces.some(t => t.varName === varName && t.fileId === fileId)) continue;
            plot.traces.push({
                varName,
                fileId,
                color: this._nextTraceColor(plot.traces),
                axis: 'y',
                card: normalizeCardSettings({}),
            });
            added++;
        }
        if (!added) return;
        this._ensureDashboardState(plot);
        if (plot.dashboardEl) this._renderDashboardCards(panelId);
        else this._createDashboard(panelId, panelEl);
        this._refreshActionBtns(panelId);
    };

    proto._removeDashboardCard = function(panelId, index) {
        const plot = this.plots.get(panelId);
        if (!plot || !plot.traces[index]) return;
        const trace = plot.traces[index];
        // Through the items, so the separators after it keep their place.
        this._setDashboardItems(plot, this._dashboardItems(plot).filter(item => item.trace !== trace));
        this._closeDashboardCardEditor();
        if (plot.traces.length) this._renderDashboardCards(panelId);
        else this._rebuildPanel(panelId);
        this._refreshActionBtns(panelId);
    };

    proto._setDashboardSize = function(panelId, size) {
        const plot = this.plots.get(panelId);
        if (!plot || !DASHBOARD_SIZES.includes(size)) return;
        this._ensureDashboardState(plot).size = size;
        const grid = plot.dashboardEl?.querySelector('.dashboard-grid');
        if (grid) DASHBOARD_SIZES.forEach(s => grid.classList.toggle(`size-${s}`, s === size));
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        panelEl?.querySelectorAll('.dashboard-size-btn').forEach(button => {
            const active = button.dataset.size === size;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    };

    proto._setDashboardFollow = function(panelId, follow = true) {
        const plot = this.plots.get(panelId);
        if (!plot) return;
        const state = this._ensureDashboardState(plot);
        state.follow = !!follow;
        if (follow) state.time = null;
        this._refreshDashboard(panelId);
    };

    // ── Values ──

    // The time span the slider covers: every card's file, as the plots show
    // it (with the file's time shift and reindexing).
    proto._dashboardRange = function(plot) {
        let start = Infinity;
        let end = -Infinity;
        for (const trace of plot.traces) {
            const times = this._dashboardTimes(trace);
            const n = times?.length || 0;
            if (!n) continue;
            const first = Number(times[0]);
            const last = Number(times[n - 1]);
            if (Number.isFinite(first)) start = Math.min(start, first);
            if (Number.isFinite(last)) end = Math.max(end, last);
        }
        return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : null;
    };

    proto._dashboardTimes = function(trace) {
        if (!this.files.get(trace.fileId)?.data?.variables?.[trace.varName]) return null;
        return this._getTransformedTimeDataForVariable(trace.fileId, trace.varName);
    };

    // What a card shows: the sample at or before `time`, or the last one.
    proto._dashboardReading = function(trace, time = null) {
        const variable = this.files.get(trace.fileId)?.data?.variables?.[trace.varName];
        if (!variable) return { index: -1, value: null, time: null };
        const times = this._dashboardTimes(trace);
        const values = variable.kind === 'parameter'
            ? [variable.data?.[0]]
            : this._getTransformedVariableData(trace.fileId, trace.varName);
        if (variable.kind === 'parameter') return { index: 0, value: values[0], time: null };
        const n = Math.min(times?.length || 0, values?.length || 0);
        if (!n) return { index: -1, value: null, time: null };
        const index = time === null ? n - 1 : Math.min(lastIndexAtOrBefore(times, time), n - 1);
        if (index < 0) return { index: -1, value: null, time: null };
        return { index, value: values[index], time: Number(times[index]) };
    };

    proto._dashboardIsLive = function(plot) {
        return plot.traces.some(trace => !!this.isFileLive?.(trace.fileId));
    };

    // ── DOM ──

    proto._createDashboard = function(panelId, panelEl) {
        const plot = this.plots.get(panelId);
        if (!plot || !this._hasContent(plot)) return;
        this._destroyDashboard(plot);
        this._ensureDashboardState(plot);
        const placeholder = panelEl.querySelector('.layout-panel-placeholder');
        if (placeholder) placeholder.style.display = 'none';

        const container = document.createElement('div');
        container.className = 'dashboard-container';
        const grid = document.createElement('div');
        grid.className = `dashboard-grid size-${plot.dashboard.size}`;
        grid.setAttribute('role', 'list');
        // Right-click: what can be added or done where it was clicked.
        grid.addEventListener('contextmenu', event => {
            event.preventDefault();
            event.stopPropagation();
            this._openDashboardContextMenu(panelId, event);
        });
        // A card dragged past the last one goes to the end.
        grid.addEventListener('dragover', event => {
            if (!event.dataTransfer?.types?.includes(CARD_DRAG_TYPE)) return;
            event.preventDefault();
            event.stopPropagation();
        });
        grid.addEventListener('drop', event => {
            if (!event.dataTransfer?.types?.includes(CARD_DRAG_TYPE)) return;
            event.preventDefault();
            event.stopPropagation();
            if (event.target !== grid) return;
            const from = readCardDrag(event.dataTransfer, panelId);
            if (from !== null) this._moveDashboardItem(panelId, from, this._dashboardItems(plot).length);
        });

        const bar = document.createElement('div');
        bar.className = 'dashboard-timebar';
        const live = document.createElement('span');
        live.className = 'dashboard-live-badge';
        live.textContent = i18n.t('dashboardLive');
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.className = 'dashboard-slider';
        slider.min = '0';
        slider.max = String(SLIDER_STEPS);
        slider.step = '1';
        slider.setAttribute('aria-label', i18n.t('dashboardTimeSlider'));
        slider.title = i18n.t('dashboardTimeSlider');
        slider.addEventListener('input', () => {
            const range = this._dashboardRange(plot);
            if (!range) return;
            const state = this._ensureDashboardState(plot);
            state.follow = false;
            state.time = range[0] + (Number(slider.value) / SLIDER_STEPS) * (range[1] - range[0]);
            this._refreshDashboard(panelId);
        });
        const timeLabel = document.createElement('span');
        timeLabel.className = 'dashboard-time';
        const latest = document.createElement('button');
        latest.type = 'button';
        latest.className = 'dashboard-latest-btn';
        latest.textContent = i18n.t('dashboardLatest');
        latest.title = i18n.t('dashboardLatestTitle');
        latest.addEventListener('click', event => {
            event.stopPropagation();
            this._setDashboardFollow(panelId, true);
        });
        bar.append(live, slider, timeLabel, latest);

        container.append(grid, bar);
        panelEl.appendChild(container);
        plot.dashboardEl = container;
        // A wide card never asks for more columns than the panel has room for.
        if (typeof ResizeObserver === 'function') {
            plot._dashboardObserver = new ResizeObserver(() => this._fitDashboardSpans(plot));
            plot._dashboardObserver.observe(grid);
        }
        this._renderDashboardCards(panelId);
        this._refreshActionBtns(panelId);
    };

    proto._destroyDashboard = function(plot) {
        if (!plot?.dashboardEl) return;
        this._closeDashboardCardEditor();
        this._closeDashboardContextMenu();
        plot._dashboardObserver?.disconnect();
        plot._dashboardObserver = null;
        plot.dashboardEl.remove();
        plot.dashboardEl = null;
    };

    proto._renderDashboardCards = function(panelId) {
        const plot = this.plots.get(panelId);
        const grid = plot?.dashboardEl?.querySelector('.dashboard-grid');
        if (!grid) return;
        grid.replaceChildren();
        this._dashboardItems(plot).forEach((item, itemIndex) => grid.appendChild(item.type === 'card'
            ? this._buildDashboardCard(panelId, item.trace, item.index, itemIndex)
            : this._buildDashboardSeparator(panelId, item.sep, itemIndex)));
        this._refreshDashboard(panelId);
    };

    proto._buildDashboardCard = function(panelId, trace, index, itemIndex = index) {
        const card = document.createElement('div');
        card.className = 'dashboard-card';
        card.setAttribute('role', 'listitem');
        card.dataset.index = String(index);
        card.dataset.item = String(itemIndex);
        card.draggable = true;

        const head = document.createElement('div');
        head.className = 'dashboard-card-head';
        const title = document.createElement('span');
        title.className = 'dashboard-card-title';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'dashboard-card-edit';
        edit.textContent = '✎';
        edit.title = i18n.t('dashboardEditCard');
        edit.setAttribute('aria-label', i18n.t('dashboardEditCard'));
        edit.addEventListener('click', event => {
            event.stopPropagation();
            this._openDashboardCardEditor(panelId, index, card);
        });
        head.append(title, edit);
        const description = document.createElement('div');
        description.className = 'dashboard-card-description';

        const value = document.createElement('div');
        value.className = 'dashboard-card-value';
        const number = document.createElement('span');
        number.className = 'dashboard-card-number';
        const unit = document.createElement('span');
        unit.className = 'dashboard-card-unit';
        value.append(number, unit);

        const foot = document.createElement('div');
        foot.className = 'dashboard-card-foot';

        card.append(head, description, value, foot);
        card.addEventListener('dblclick', event => {
            event.preventDefault();
            this._openDashboardCardEditor(panelId, index, card);
        });

        // Reordering: dropped on the left half of a card, the dragged one goes
        // before it; on the right half, after it.
        this._makeDashboardItemDraggable(panelId, card, itemIndex, event => {
            const rect = card.getBoundingClientRect();
            return event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
        });
        return card;
    };

    // A card or a separator: dragged, and a place to drop one. `side(event)`
    // says whether a drop over it goes before or after it.
    proto._makeDashboardItemDraggable = function(panelId, element, itemIndex, side) {
        element.addEventListener('dragstart', event => {
            event.dataTransfer?.setData(CARD_DRAG_TYPE, JSON.stringify({ panelId, item: itemIndex }));
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
            element.classList.add('dragging');
        });
        element.addEventListener('dragend', () => element.classList.remove('dragging'));
        element.addEventListener('dragover', event => {
            if (!event.dataTransfer?.types?.includes(CARD_DRAG_TYPE)) return;
            event.preventDefault();
            event.stopPropagation();
            const where = side(event);
            element.classList.toggle('drop-before', where === 'before');
            element.classList.toggle('drop-after', where === 'after');
        });
        element.addEventListener('dragleave', () => element.classList.remove('drop-before', 'drop-after'));
        element.addEventListener('drop', event => {
            if (!event.dataTransfer?.types?.includes(CARD_DRAG_TYPE)) return;
            event.preventDefault();
            event.stopPropagation();
            element.classList.remove('drop-before', 'drop-after');
            const from = readCardDrag(event.dataTransfer, panelId);
            if (from === null) return;
            this._moveDashboardItem(panelId, from, side(event) === 'before' ? itemIndex : itemIndex + 1);
        });
    };

    proto._buildDashboardSeparator = function(panelId, sep, itemIndex) {
        const row = document.createElement('div');
        row.className = 'dashboard-separator';
        row.setAttribute('role', 'separator');
        row.dataset.item = String(itemIndex);
        row.dataset.separator = sep.id;
        row.draggable = true;
        const title = document.createElement('span');
        title.className = 'dashboard-separator-title';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'dashboard-card-edit dashboard-separator-edit';
        edit.textContent = '✎';
        edit.title = i18n.t('dashboardEditSeparator');
        edit.setAttribute('aria-label', i18n.t('dashboardEditSeparator'));
        edit.addEventListener('click', event => {
            event.stopPropagation();
            this._openDashboardSeparatorEditor(panelId, sep.id, row);
        });
        row.append(title, edit);
        row.addEventListener('dblclick', event => {
            event.preventDefault();
            this._openDashboardSeparatorEditor(panelId, sep.id, row);
        });
        // A separator spans the row: dropped on its upper half, an item goes
        // before it (end of the section above); on its lower half, after it.
        this._makeDashboardItemDraggable(panelId, row, itemIndex, event => {
            const rect = row.getBoundingClientRect();
            return event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
        });
        return row;
    };

    // Where a click on the free part of the grid falls among the items: before
    // the first item that comes after it in reading order.
    proto._dashboardGapAt = function(grid, x, y) {
        const elements = [...grid.querySelectorAll(':scope > .dashboard-card, :scope > .dashboard-separator')];
        for (const element of elements) {
            const rect = element.getBoundingClientRect();
            if (y < rect.top || (y <= rect.bottom && x < rect.left + rect.width / 2)) return Number(element.dataset.item);
        }
        return elements.length;
    };

    proto._closeDashboardContextMenu = function() {
        document.querySelector('.dashboard-context-menu')?._close?.();
    };

    proto._openDashboardContextMenu = function(panelId, event) {
        this._closeDashboardContextMenu();
        this._closeDashboardCardEditor();
        const plot = this.plots.get(panelId);
        const grid = plot?.dashboardEl?.querySelector('.dashboard-grid');
        if (!grid) return;
        const card = event.target.closest?.('.dashboard-card');
        const separator = event.target.closest?.('.dashboard-separator');
        const entries = [];
        if (card) {
            const index = Number(card.dataset.index);
            entries.push(
                { labelKey: 'dashboardEditCard', run: () => this._openDashboardCardEditor(panelId, index, card) },
                { labelKey: 'dashboardAddSeparatorBefore', run: () => this._addAndEditDashboardSeparator(panelId, Number(card.dataset.item)) },
                { labelKey: 'dashboardRemoveCard', danger: true, run: () => this._removeDashboardCard(panelId, index) },
            );
        } else if (separator) {
            const id = separator.dataset.separator;
            entries.push(
                { labelKey: 'dashboardEditSeparator', run: () => this._openDashboardSeparatorEditor(panelId, id, separator) },
                { labelKey: 'dashboardRemoveSeparator', danger: true, run: () => this._removeDashboardSeparator(panelId, id) },
            );
        } else {
            const gap = this._dashboardGapAt(grid, event.clientX, event.clientY);
            entries.push({ labelKey: 'dashboardAddSeparator', run: () => this._addAndEditDashboardSeparator(panelId, gap) });
        }

        const menu = document.createElement('div');
        menu.className = 'example-menu dashboard-context-menu';
        menu.setAttribute('role', 'menu');
        for (const entry of entries) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = `example-menu-item${entry.danger ? ' is-danger' : ''}`;
            item.setAttribute('role', 'menuitem');
            item.textContent = i18n.t(entry.labelKey);
            item.addEventListener('click', clickEvent => {
                clickEvent.stopPropagation();
                close();
                entry.run();
            });
            menu.appendChild(item);
        }
        document.body.appendChild(menu);
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        menu.style.left = `${Math.round(Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)))}px`;
        menu.style.top = `${Math.round(Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)))}px`;
        const onPointer = pointerEvent => { if (!menu.contains(pointerEvent.target)) close(); };
        const onKey = keyEvent => { if (keyEvent.key === 'Escape') close(); };
        const close = () => {
            document.removeEventListener('pointerdown', onPointer, true);
            document.removeEventListener('keydown', onKey, true);
            menu.remove();
        };
        menu._close = close;
        document.addEventListener('keydown', onKey, true);
        setTimeout(() => {
            if (menu.isConnected) document.addEventListener('pointerdown', onPointer, true);
        }, 0);
        menu.querySelector('button')?.focus();
    };

    // A separator is put in, and opened to be named.
    proto._addAndEditDashboardSeparator = function(panelId, gap) {
        const sep = this._addDashboardSeparator(panelId, gap);
        const plot = this.plots.get(panelId);
        const row = sep && plot?.dashboardEl?.querySelector(`.dashboard-separator[data-separator="${sep.id}"]`);
        if (row) this._openDashboardSeparatorEditor(panelId, sep.id, row);
    };

    /**
     * The values on screen, the slider and the time under it, from the data
     * as it is now. Called on every Live Update poll: it changes text, never
     * the cards themselves, so a card being dragged or edited is left alone.
     */
    proto._refreshDashboard = function(panelId) {
        const plot = this.plots.get(panelId);
        const container = plot?.dashboardEl;
        if (!container) return;
        const state = this._ensureDashboardState(plot);
        const range = this._dashboardRange(plot);
        const time = state.follow || state.time === null ? null : state.time;
        const multipleFiles = new Set(plot.traces.map(t => t.fileId)).size > 1 || this.files.size > 1;

        const cards = container.querySelectorAll('.dashboard-card');
        plot.traces.forEach((trace, index) => {
            const card = cards[index];
            if (!card) return;
            const settings = this._dashboardCard(trace);
            const variable = this.files.get(trace.fileId)?.data?.variables?.[trace.varName];
            const reading = this._dashboardReading(trace, time);
            const label = settings.title || this._variableLabel(trace.varName, trace.fileId) || trace.varName;
            card.querySelector('.dashboard-card-title').textContent = label;
            card.title = trace.varName;
            card.querySelector('.dashboard-card-number').textContent = variable
                ? formatDashboardValue(reading.value, settings.decimals)
                : '—';
            card.querySelector('.dashboard-card-unit').textContent = this._varUnit(trace.varName, trace.fileId);
            const parts = [];
            if (Number.isFinite(reading.time)) parts.push(`t = ${this._formatTimeValue(trace.fileId, reading.time)}`);
            else if (!variable) parts.push(i18n.t('dashboardMissing'));
            else if (reading.index < 0) parts.push(i18n.t('dashboardBeforeStart'));
            if (multipleFiles) parts.push(this.files.get(trace.fileId)?.name || '');
            card.querySelector('.dashboard-card-foot').textContent = parts.filter(Boolean).join(' · ');
            card.style.setProperty('--dashboard-accent', trace.color || 'var(--primary-color)');
            card.classList.toggle('has-bg', !!settings.bg);
            card.style.backgroundColor = settings.bg || '';
            card.style.color = settings.bg ? readableTextColor(settings.bg) : '';
            const description = card.querySelector('.dashboard-card-description');
            description.textContent = settings.description;
            description.hidden = !settings.description;
            card.querySelector('.dashboard-card-title').title = label;
            card.dataset.span = String(settings.span);
        });

        const separators = new Map(state.separators.map(sep => [sep.id, sep]));
        container.querySelectorAll('.dashboard-separator').forEach(row => {
            const sep = separators.get(row.dataset.separator);
            if (!sep) return;
            const title = row.querySelector('.dashboard-separator-title');
            title.textContent = sep.title;
            row.classList.toggle('has-title', !!sep.title);
            row.classList.toggle('has-bg', !!sep.bg);
            row.style.backgroundColor = sep.bg || '';
            row.style.color = sep.bg ? readableTextColor(sep.bg) : '';
        });

        const slider = container.querySelector('.dashboard-slider');
        const timeLabel = container.querySelector('.dashboard-time');
        const latest = container.querySelector('.dashboard-latest-btn');
        const live = container.querySelector('.dashboard-live-badge');
        const firstFile = plot.traces.find(t => this.files.has(t.fileId))?.fileId;
        const hasRange = !!range && range[1] > range[0];
        slider.disabled = !hasRange;
        if (hasRange) {
            const shown = time === null ? range[1] : Math.min(Math.max(time, range[0]), range[1]);
            slider.value = String(Math.round(((shown - range[0]) / (range[1] - range[0])) * SLIDER_STEPS));
        } else {
            slider.value = String(SLIDER_STEPS);
        }
        const shownTime = time === null ? range?.[1] : time;
        timeLabel.textContent = Number.isFinite(shownTime) && firstFile
            ? this._formatTimeValue(firstFile, shownTime)
            : '';
        latest.classList.toggle('active', time === null);
        latest.setAttribute('aria-pressed', String(time === null));
        live.hidden = !(time === null && this._dashboardIsLive(plot));
        container.classList.toggle('is-following', time === null);
        this._fitDashboardSpans(plot);
    };

    // The columns the grid has now; a card's span is held to them.
    proto._fitDashboardSpans = function(plot) {
        const grid = plot?.dashboardEl?.querySelector('.dashboard-grid');
        if (!grid) return;
        const template = typeof getComputedStyle === 'function' ? getComputedStyle(grid).gridTemplateColumns : '';
        const columns = Math.max(1, String(template || '').split(' ').filter(Boolean).length);
        grid.querySelectorAll('.dashboard-card').forEach(card => {
            const span = Math.min(Number(card.dataset.span) || 1, columns);
            card.style.gridColumn = span > 1 ? `span ${span}` : '';
            // The value keeps the size of a one-column card: the room is for
            // a long value or title, not a bigger number.
            card.style.setProperty('--dashboard-span', String(span));
        });
    };

    proto.refreshDashboards = function() {
        for (const [panelId, plot] of this.plots) {
            if (plot.mode === 'dashboard' && plot.dashboardEl) this._refreshDashboard(panelId);
        }
    };

    // The background of a card or a separator: no colour, one of the palette,
    // or one's own.
    proto._dashboardColorField = function(getColor, setColor) {
        const swatches = document.createElement('div');
        swatches.className = 'dashboard-editor-swatches';
        const syncSwatches = () => swatches.querySelectorAll('button').forEach(button => {
            button.classList.toggle('active', (button.dataset.color || '') === getColor());
        });
        const setBg = color => { setColor(color); syncSwatches(); custom.value = color || '#2196f3'; };
        const none = document.createElement('button');
        none.type = 'button';
        none.className = 'dashboard-swatch dashboard-swatch-none';
        none.dataset.color = '';
        none.title = i18n.t('dashboardColorNone');
        none.setAttribute('aria-label', i18n.t('dashboardColorNone'));
        none.addEventListener('click', event => { event.preventDefault(); setBg(''); });
        const palette = document.createElement('div');
        palette.className = 'dashboard-editor-palette';
        for (const color of DASHBOARD_COLORS) {
            const swatch = document.createElement('button');
            swatch.type = 'button';
            swatch.className = 'dashboard-swatch';
            swatch.dataset.color = color.toLowerCase();
            swatch.style.backgroundColor = color;
            swatch.setAttribute('aria-label', color);
            swatch.addEventListener('click', event => { event.preventDefault(); setBg(color.toLowerCase()); });
            palette.appendChild(swatch);
        }
        const custom = document.createElement('input');
        custom.type = 'color';
        custom.className = 'dashboard-swatch-custom';
        custom.value = getColor() || '#2196f3';
        custom.title = i18n.t('dashboardColorCustom');
        custom.setAttribute('aria-label', i18n.t('dashboardColorCustom'));
        custom.addEventListener('input', () => setBg(custom.value.toLowerCase()));
        // No colour and a colour of one's own, then the palette.
        const extras = document.createElement('div');
        extras.className = 'dashboard-editor-swatch-extras';
        extras.append(none, custom);
        swatches.append(extras, palette);
        syncSwatches();
        const colorRow = document.createElement('div');
        colorRow.className = 'dashboard-editor-field';
        const colorCaption = document.createElement('span');
        colorCaption.className = 'dashboard-editor-caption';
        colorCaption.textContent = i18n.t('dashboardCardColor');
        colorRow.append(colorCaption, swatches);
        return colorRow;
    };

    // Under (or over) what it edits, inside the window.
    proto._placeDashboardEditor = function(editor, anchor) {
        const rect = anchor.getBoundingClientRect();
        const width = editor.offsetWidth;
        const height = editor.offsetHeight;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
        const below = rect.bottom + 6;
        const above = rect.top - height - 6;
        const top = below + height <= window.innerHeight - 8 ? below : (above >= 8 ? above : 8);
        editor.style.left = `${Math.round(left)}px`;
        editor.style.top = `${Math.round(top)}px`;
    };

    // ── Card editor ──

    proto._closeDashboardCardEditor = function() {
        const editor = document.querySelector('.dashboard-card-editor');
        if (!editor) return;
        editor._cleanup?.();
        editor.remove();
    };

    proto._openDashboardCardEditor = function(panelId, index, anchor, options = {}) {
        this._closeDashboardCardEditor();
        const plot = this.plots.get(panelId);
        const trace = plot?.traces?.[index];
        if (!trace) return;
        const settings = this._dashboardCard(trace);
        const refresh = () => this._refreshDashboard(panelId);

        const editor = document.createElement('div');
        editor.className = 'dashboard-card-editor';
        editor.setAttribute('role', 'dialog');
        editor.setAttribute('aria-label', i18n.t('dashboardEditCard'));

        const field = (labelKey, input, hintKey = '') => {
            const row = document.createElement('label');
            row.className = 'dashboard-editor-field';
            const caption = document.createElement('span');
            caption.className = 'dashboard-editor-caption';
            caption.textContent = i18n.t(labelKey);
            row.append(caption, input);
            if (hintKey) {
                const hint = document.createElement('small');
                hint.className = 'dashboard-editor-hint';
                hint.textContent = i18n.t(hintKey);
                row.appendChild(hint);
            }
            editor.appendChild(row);
            return row;
        };

        const title = document.createElement('input');
        title.type = 'text';
        title.className = 'dashboard-editor-title';
        title.maxLength = 80;
        title.value = settings.title;
        title.placeholder = this._variableLabel(trace.varName, trace.fileId) || trace.varName;
        title.addEventListener('input', () => { settings.title = title.value; refresh(); });
        field('dashboardCardTitle', title);

        const description = document.createElement('textarea');
        description.className = 'dashboard-editor-description';
        description.rows = 2;
        description.maxLength = 200;
        description.value = settings.description;
        description.placeholder = i18n.t('dashboardDescriptionPlaceholder');
        description.addEventListener('input', () => { settings.description = description.value; refresh(); });
        field('dashboardCardDescription', description);

        const unit = document.createElement('input');
        unit.type = 'text';
        unit.className = 'dashboard-editor-unit';
        unit.maxLength = 32;
        unit.value = this._varUnit(trace.varName, trace.fileId);
        unit.placeholder = i18n.t('dashboardUnitPlaceholder');
        // Applied when left, not on every key: it redraws the plots that show it.
        unit.addEventListener('change', () => this.setVariableUnit(trace.fileId, trace.varName, unit.value));
        field('dashboardCardUnit', unit, 'dashboardCardUnitHint');

        const decimals = document.createElement('select');
        decimals.className = 'dashboard-editor-decimals';
        for (const option of DECIMALS) {
            decimals.add(new Option(option === 'auto' ? i18n.t('dashboardDecimalsAuto') : option, option));
        }
        decimals.value = settings.decimals;
        decimals.addEventListener('change', () => { settings.decimals = decimals.value; refresh(); });
        field('dashboardCardDecimals', decimals);

        const widths = document.createElement('div');
        widths.className = 'dashboard-editor-widths';
        widths.setAttribute('role', 'group');
        for (const span of CARD_SPANS) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `dashboard-width-btn${settings.span === span ? ' active' : ''}`;
            button.dataset.span = String(span);
            button.textContent = i18n.t(`dashboardWidth${span}`);
            button.setAttribute('aria-pressed', String(settings.span === span));
            button.addEventListener('click', event => {
                event.preventDefault();
                settings.span = span;
                widths.querySelectorAll('button').forEach(other => {
                    const active = Number(other.dataset.span) === span;
                    other.classList.toggle('active', active);
                    other.setAttribute('aria-pressed', String(active));
                });
                refresh();
            });
            widths.appendChild(button);
        }
        const widthRow = document.createElement('div');
        widthRow.className = 'dashboard-editor-field';
        const widthCaption = document.createElement('span');
        widthCaption.className = 'dashboard-editor-caption';
        widthCaption.textContent = i18n.t('dashboardCardWidth');
        widthRow.append(widthCaption, widths);
        editor.appendChild(widthRow);

        editor.appendChild(this._dashboardColorField(() => settings.bg, color => { settings.bg = color; refresh(); }));

        // Moving a card without dragging it: the keyboard, and a touch screen.
        const moves = document.createElement('div');
        moves.className = 'dashboard-editor-moves';
        const move = (labelKey, className, target, disabled) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `dashboard-move-btn ${className}`;
            button.textContent = i18n.t(labelKey);
            button.disabled = disabled;
            button.addEventListener('click', event => {
                event.preventDefault();
                if (unit.value !== this._varUnit(trace.varName, trace.fileId)) this.setVariableUnit(trace.fileId, trace.varName, unit.value);
                this._moveDashboardItem(panelId, itemIndex, target);
                const newIndex = plot.traces.indexOf(trace);
                const card = plot.dashboardEl?.querySelectorAll('.dashboard-card')[newIndex];
                if (card) this._openDashboardCardEditor(panelId, newIndex, card, { focus: className });
            });
            moves.appendChild(button);
        };
        // One item back or on: past a separator, the card goes into the
        // section beside it.
        const items = this._dashboardItems(plot);
        const itemIndex = items.findIndex(item => item.trace === trace);
        move('dashboardMoveBefore', 'move-before', itemIndex - 1, itemIndex <= 0);
        move('dashboardMoveAfter', 'move-after', itemIndex + 2, itemIndex >= items.length - 1);
        const moveRow = document.createElement('div');
        moveRow.className = 'dashboard-editor-field';
        const moveCaption = document.createElement('span');
        moveCaption.className = 'dashboard-editor-caption';
        moveCaption.textContent = i18n.t('dashboardCardPosition');
        moveRow.append(moveCaption, moves);
        editor.appendChild(moveRow);

        const buttons = document.createElement('div');
        buttons.className = 'dashboard-editor-buttons';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'dashboard-editor-remove';
        remove.textContent = i18n.t('dashboardRemoveCard');
        remove.addEventListener('click', () => this._removeDashboardCard(panelId, index));
        const done = document.createElement('button');
        done.type = 'button';
        done.className = 'dashboard-editor-done';
        done.textContent = i18n.t('dashboardDone');
        done.addEventListener('click', () => {
            if (unit.value !== this._varUnit(trace.varName, trace.fileId)) this.setVariableUnit(trace.fileId, trace.varName, unit.value);
            this._closeDashboardCardEditor();
        });
        buttons.append(remove, done);
        editor.appendChild(buttons);

        document.body.appendChild(editor);
        this._placeDashboardEditor(editor, anchor);

        const onPointer = event => {
            if (editor.contains(event.target)) return;
            if (unit.value !== this._varUnit(trace.varName, trace.fileId)) this.setVariableUnit(trace.fileId, trace.varName, unit.value);
            this._closeDashboardCardEditor();
        };
        const onKey = event => {
            if (event.key === 'Escape') { event.stopPropagation(); this._closeDashboardCardEditor(); }
            if (event.key === 'Enter' && event.target?.tagName === 'INPUT' && event.target.type === 'text') {
                event.preventDefault();
                done.click();
            }
        };
        editor._cleanup = () => {
            document.removeEventListener('pointerdown', onPointer, true);
            editor.removeEventListener('keydown', onKey);
        };
        editor.addEventListener('keydown', onKey);
        setTimeout(() => {
            if (editor.isConnected) document.addEventListener('pointerdown', onPointer, true);
        }, 0);
        // Moved with a button: the focus stays on it, so the next press moves
        // the card on.
        const keep = options.focus ? editor.querySelector(`.dashboard-move-btn.${options.focus}`) : null;
        if (keep && !keep.disabled) keep.focus();
        else {
            title.focus();
            title.select();
        }
    };

    // ── Separator editor ──

    proto._openDashboardSeparatorEditor = function(panelId, id, anchor, options = {}) {
        this._closeDashboardCardEditor();
        const plot = this.plots.get(panelId);
        const sep = plot ? this._ensureDashboardState(plot).separators.find(item => item.id === id) : null;
        if (!sep) return;
        const refresh = () => this._refreshDashboard(panelId);

        const editor = document.createElement('div');
        editor.className = 'dashboard-card-editor dashboard-separator-editor';
        editor.setAttribute('role', 'dialog');
        editor.setAttribute('aria-label', i18n.t('dashboardEditSeparator'));

        const titleRow = document.createElement('label');
        titleRow.className = 'dashboard-editor-field';
        const caption = document.createElement('span');
        caption.className = 'dashboard-editor-caption';
        caption.textContent = i18n.t('dashboardCardTitle');
        const title = document.createElement('input');
        title.type = 'text';
        title.className = 'dashboard-editor-title';
        title.maxLength = 80;
        title.value = sep.title;
        title.placeholder = i18n.t('dashboardSeparatorPlaceholder');
        title.addEventListener('input', () => { sep.title = title.value; refresh(); });
        titleRow.append(caption, title);
        editor.appendChild(titleRow);

        editor.appendChild(this._dashboardColorField(() => sep.bg, color => { sep.bg = color; refresh(); }));

        const moves = document.createElement('div');
        moves.className = 'dashboard-editor-moves';
        const items = this._dashboardItems(plot);
        const itemIndex = items.findIndex(item => item.sep === sep);
        const move = (labelKey, className, target, disabled) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `dashboard-move-btn ${className}`;
            button.textContent = i18n.t(labelKey);
            button.disabled = disabled;
            button.addEventListener('click', event => {
                event.preventDefault();
                this._moveDashboardItem(panelId, itemIndex, target);
                const row = plot.dashboardEl?.querySelector(`.dashboard-separator[data-separator="${id}"]`);
                if (row) this._openDashboardSeparatorEditor(panelId, id, row, { focus: className });
            });
            moves.appendChild(button);
        };
        move('dashboardMoveBefore', 'move-before', itemIndex - 1, itemIndex <= 0);
        move('dashboardMoveAfter', 'move-after', itemIndex + 2, itemIndex >= items.length - 1);
        const moveRow = document.createElement('div');
        moveRow.className = 'dashboard-editor-field';
        const moveCaption = document.createElement('span');
        moveCaption.className = 'dashboard-editor-caption';
        moveCaption.textContent = i18n.t('dashboardCardPosition');
        moveRow.append(moveCaption, moves);
        editor.appendChild(moveRow);

        const buttons = document.createElement('div');
        buttons.className = 'dashboard-editor-buttons';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'dashboard-editor-remove';
        remove.textContent = i18n.t('dashboardRemoveSeparator');
        remove.addEventListener('click', () => this._removeDashboardSeparator(panelId, id));
        const done = document.createElement('button');
        done.type = 'button';
        done.className = 'dashboard-editor-done';
        done.textContent = i18n.t('dashboardDone');
        done.addEventListener('click', () => this._closeDashboardCardEditor());
        buttons.append(remove, done);
        editor.appendChild(buttons);

        document.body.appendChild(editor);
        this._placeDashboardEditor(editor, anchor);
        const onPointer = event => { if (!editor.contains(event.target)) this._closeDashboardCardEditor(); };
        const onKey = event => {
            if (event.key === 'Escape') { event.stopPropagation(); this._closeDashboardCardEditor(); }
            if (event.key === 'Enter' && event.target === title) { event.preventDefault(); done.click(); }
        };
        editor._cleanup = () => {
            document.removeEventListener('pointerdown', onPointer, true);
            editor.removeEventListener('keydown', onKey);
        };
        editor.addEventListener('keydown', onKey);
        setTimeout(() => {
            if (editor.isConnected) document.addEventListener('pointerdown', onPointer, true);
        }, 0);
        const keep = options.focus ? editor.querySelector(`.dashboard-move-btn.${options.focus}`) : null;
        if (keep && !keep.disabled) keep.focus();
        else {
            title.focus();
            title.select();
        }
    };

    // ── Toolbar ──

    proto._createDashboardToolsGroup = function(panelId, plot) {
        const group = document.createElement('div');
        group.className = 'dashboard-tools-group';
        const caption = document.createElement('span');
        caption.className = 'dashboard-tools-caption';
        caption.textContent = i18n.t('dashboardCardSize');
        group.appendChild(caption);
        const size = this._ensureDashboardState(plot).size;
        for (const value of DASHBOARD_SIZES) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `layout-toolbar-btn dashboard-size-btn${value === size ? ' active' : ''}`;
            button.dataset.size = value;
            button.textContent = value.toUpperCase();
            button.title = i18n.t(`dashboardSize${value.toUpperCase()}`);
            button.setAttribute('aria-pressed', String(value === size));
            button.addEventListener('click', event => {
                event.stopPropagation();
                this._setDashboardSize(panelId, value);
            });
            group.appendChild(button);
        }
        // A separator at the end, for a screen with no right-click.
        const separator = document.createElement('button');
        separator.type = 'button';
        separator.className = 'layout-toolbar-btn dashboard-add-separator-btn';
        separator.textContent = i18n.t('dashboardAddSeparatorButton');
        separator.title = i18n.t('dashboardAddSeparatorTitle');
        separator.addEventListener('click', event => {
            event.stopPropagation();
            const current = this.plots.get(panelId);
            if (!current?.dashboardEl) return;
            this._addAndEditDashboardSeparator(panelId, this._dashboardItems(current).length);
        });
        group.appendChild(separator);
        return group;
    };
}
