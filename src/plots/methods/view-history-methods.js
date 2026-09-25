// Ctrl+Z (⌘Z) goes back to the previous zoom/pan view of a panel. Only the
// view: axis ranges and the 3D camera, nothing else.
//
// Each panel keeps a stack of the views it had. Changes are recorded when the
// relayouts settle, so a burst of them (wheel ticks, the Y re-fit that follows
// an X zoom, the other panels following an axis sync) makes one step. Panels
// that moved in the same step share its id, and are restored together.

const SETTLE_MS = 350;
const MAX_STEPS = 50;

function viewUndoShortcutLabel() {
    const platform = typeof navigator !== 'undefined'
        ? (navigator.userAgentData?.platform || navigator.platform || '')
        : '';
    return /mac|iphone|ipad/i.test(platform) ? '⌘Z' : 'Ctrl+Z';
}

export function installPlotViewHistoryMethods(TargetClass) {
    const proto = TargetClass.prototype;

    proto._viewUndoShortcutLabel = viewUndoShortcutLabel;

    // What a view is restored to: the main chart's ranges (or 3D camera).
    // `sig` names how the axes read those ranges — a log axis keeps its range
    // in log10, so a step taken on another scale cannot be restored.
    proto._viewHistorySnapshot = function(plot) {
        const fl = plot?.div?._fullLayout;
        if (!fl) return null;
        const captured = this._capturePlotView(plot);
        if (!captured) return null;
        const view = captured.mode === '3d'
            ? { mode: '3d', camera: captured.camera, xRange: captured.xRange, yRange: captured.yRange, zRange: captured.zRange }
            : { mode: '2d', xRange: captured.xRange, yRange: captured.yRange, y2Range: captured.y2Range };
        const sig = [
            plot.mode,
            fl.xaxis?.type, fl.yaxis?.type,
            plot.timeseriesY2Enabled ? fl.yaxis2?.type : '',
            plot.timeseriesStacked ? 'stack' : '',
        ].join('|');
        return { view, sig, key: JSON.stringify(view) };
    };

    // Called for every chart built by _createChart. The history lives on the
    // plot, so it outlives rebuilds; a new chart only sets a fresh baseline.
    proto._installViewHistory = function(panelId, plot, div) {
        if (!div?.on) return;
        plot._viewHistory ||= [];
        plot._viewCurrent = null;
        div.on('plotly_relayout', () => this._markViewHistoryDirty(panelId));
    };

    proto._markViewHistoryDirty = function(panelId) {
        this._viewHistoryDirty ||= new Set();
        this._viewHistoryDirty.add(panelId);
        if (this._viewHistoryTimer) clearTimeout(this._viewHistoryTimer);
        this._viewHistoryTimer = setTimeout(() => this._settleViewHistory(), SETTLE_MS);
    };

    proto._settleViewHistory = function() {
        this._viewHistoryTimer = 0;
        const dirty = this._viewHistoryDirty || new Set();
        this._viewHistoryDirty = new Set();
        const restoring = !!this._viewHistoryRestoring;
        this._viewHistoryRestoring = false;
        const step = (this._viewHistoryStep || 0) + 1;
        let recorded = false;
        for (const panelId of dirty) {
            const plot = this.plots.get(panelId);
            const snapshot = this._viewHistorySnapshot(plot);
            if (!snapshot) continue;
            const current = plot._viewCurrent;
            plot._viewCurrent = snapshot;
            if (!current || restoring || current.key === snapshot.key) continue;
            plot._viewHistory ||= [];
            plot._viewHistory.push({ view: current.view, sig: current.sig, step });
            if (plot._viewHistory.length > MAX_STEPS) plot._viewHistory.shift();
            recorded = true;
            this._syncViewUndoControls(panelId);
        }
        if (recorded) {
            this._viewHistoryStep = step;
            this._viewHistoryLastPanel = [...dirty].find(id => this.plots.get(id)?._viewHistory?.at(-1)?.step === step) ?? null;
        }
        if (restoring) for (const panelId of dirty) this._syncViewUndoControls(panelId);
    };

    // The last step of a panel that can still be restored; steps taken on
    // another axis scale are dropped on the way.
    proto._viewHistoryTop = function(plot) {
        const history = plot?._viewHistory;
        if (!history?.length) return null;
        const sig = this._viewHistorySnapshot(plot)?.sig;
        while (history.length && history.at(-1).sig !== sig) history.pop();
        return history.at(-1) || null;
    };

    proto._canUndoView = function(panelId) {
        return !!this._viewHistoryTop(this.plots.get(panelId));
    };

    // The panel Ctrl+Z acts on: the one under the mouse, otherwise the one
    // whose view changed last.
    proto._viewUndoTargetPanel = function() {
        const hovered = document.querySelector('.layout-panel:hover')?.dataset?.id;
        const hoveredId = hovered === undefined ? null : [...this.plots.keys()].find(id => String(id) === hovered);
        if (hoveredId !== undefined && hoveredId !== null && this._canUndoView(hoveredId)) return hoveredId;
        const last = this._viewHistoryLastPanel;
        if (last !== undefined && last !== null && this._canUndoView(last)) return last;
        return hoveredId ?? null;
    };

    proto.undoView = function(panelId = this._viewUndoTargetPanel()) {
        const plot = this.plots.get(panelId);
        const top = this._viewHistoryTop(plot);
        if (!top) return false;
        // The panels that moved in the same step go back with it.
        const targets = [];
        for (const [id, other] of this.plots) {
            const entry = id === panelId ? top : this._viewHistoryTop(other);
            if (entry?.step === top.step && other.div) {
                other._viewHistory.pop();
                targets.push([id, other, entry.view]);
            }
        }
        if (this._viewHistoryTimer) clearTimeout(this._viewHistoryTimer);
        this._viewHistoryRestoring = true;
        const restores = targets.map(([id, other, view]) => {
            this._viewHistoryDirty ||= new Set();
            this._viewHistoryDirty.add(id);
            return this._restorePlotView(other, view).catch(() => {});
        });
        // Settle once they are in, whether or not Plotly reported a relayout.
        Promise.all(restores).then(() => {
            for (const [id] of targets) this._markViewHistoryDirty(id);
        });
        return true;
    };

    proto._syncViewUndoControls = function(panelId) {
        const menu = document.querySelector(`.panel-view-menu[data-panel-id="${panelId}"]`);
        if (menu) this._renderViewMenu?.(panelId, menu);
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        this._applyViewButtonState?.(this.plots.get(panelId), panelEl?.querySelector('.panel-view-btn'));
    };

    // Once per manager. Typing in a field keeps its own Ctrl+Z.
    proto._installViewUndoShortcut = function() {
        if (this._viewUndoShortcutInstalled || typeof document === 'undefined') return;
        this._viewUndoShortcutInstalled = true;
        document.addEventListener('keydown', (event) => {
            if (event.key?.toLowerCase() !== 'z' || event.shiftKey || event.altKey) return;
            if (!(event.ctrlKey || event.metaKey)) return;
            const target = event.target;
            if (target?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
            if (document.querySelector('.modal-overlay, dialog[open]')) return;
            if (this.undoView()) event.preventDefault();
        });
    };
}
