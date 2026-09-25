import Plotly from '../../vendor/plotly.js';

// Ctrl+Z (⌘Z) goes back to the previous zoom/pan view of a panel. Only the
// view: axis ranges and the 3D camera, nothing else.
//
// Each panel keeps a stack of the views it had. A view covers every chart of
// the panel: the analysis modes have a time pane and a result chart (spectrum,
// bars, calendar, profile, integral, correlation), the 2D curve fit a time
// pane beside the 2D chart. Changes are recorded when the relayouts settle, so
// a burst of them (wheel ticks, the Y re-fit that follows an X zoom, the other
// panels following an axis sync) makes one step. Panels that moved in the
// same step share its id, and are restored together.
//
// The state animation is left out: while it plays it rewrites its own ranges
// on every frame (dynamic zoom), and each frame would read as a step.

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

    // The charts of a panel whose view Ctrl+Z restores, by name. Only the ones
    // the current mode shows: a mode left behind can keep its div around.
    proto._viewHistorySurfaces = function(plot) {
        if (!plot?.div || plot.mode === 'state-anim') return [];
        const second = {
            fft: plot.fftDiv,
            histogram: plot.histogramDiv,
            heatmap: plot.heatmapDiv,
            'temporal-profile': plot.temporalProfileDiv,
            integral: plot.integralDiv,
            correlation: plot.correlationDiv,
            phase2d: plot.phase2d?.fitEnabled ? plot.phase2dFitTimeDiv : null,
        }[plot.mode];
        return [['main', plot.div], ['second', second]]
            .filter(([, div]) => div?._fullLayout && div.isConnected !== false);
    };

    // One chart's view: every 2D axis (subplots and the right axis included),
    // or the 3D scene. An axis on autorange is kept as autorange, not as the
    // range it happened to have: the data under it can change.
    const surfaceView = (div) => {
        const fl = div._fullLayout;
        if (fl.scene && !fl.xaxis) {
            const scene = fl.scene;
            const range = axis => (Array.isArray(axis?.range) ? [...axis.range] : null);
            return {
                scene: {
                    camera: scene.camera ? JSON.parse(JSON.stringify(scene.camera)) : null,
                    x: range(scene.xaxis), y: range(scene.yaxis), z: range(scene.zaxis),
                },
            };
        }
        const axes = {};
        for (const name of Object.keys(fl).filter(key => /^[xy]axis\d*$/.test(key)).sort()) {
            const axis = fl[name];
            if (!axis || typeof axis !== 'object') continue;
            const auto = axis.autorange === undefined ? false : axis.autorange;
            axes[name] = {
                type: axis.type,
                auto,
                range: auto === false && Array.isArray(axis.range) ? [...axis.range] : null,
            };
        }
        return { axes };
    };

    // What a view is restored to, per chart. `sig` names how the axes read
    // their ranges — a log axis keeps its range in log10 — and which axes
    // there are, so a step taken on another scale or layout is not restored.
    proto._viewHistorySnapshot = function(plot) {
        const surfaces = this._viewHistorySurfaces(plot);
        if (!surfaces.length) return null;
        const view = {};
        const sig = [plot.mode, plot.timeseriesStacked ? 'stack' : ''];
        for (const [name, div] of surfaces) {
            view[name] = surfaceView(div);
            sig.push(name, view[name].scene ? '3d' : Object.entries(view[name].axes).map(([axis, v]) => `${axis}:${v.type}`).join(','));
        }
        return { view, sig: sig.join('|'), key: JSON.stringify(view) };
    };

    // The relayout that takes one chart from `now` back to `saved`, touching
    // only what differs.
    const surfaceRestoreUpdate = (saved, now) => {
        const update = {};
        if (saved.scene) {
            const was = saved.scene;
            if (JSON.stringify(was) === JSON.stringify(now?.scene)) return update;
            for (const axis of ['x', 'y', 'z']) {
                if (was[axis]) { update[`scene.${axis}axis.range`] = was[axis]; update[`scene.${axis}axis.autorange`] = false; }
            }
            if (was.camera) update['scene.camera'] = was.camera;
            return update;
        }
        for (const [name, was] of Object.entries(saved.axes || {})) {
            const is = now?.axes?.[name];
            if (!is || JSON.stringify(was) === JSON.stringify(is)) continue;
            if (was.auto !== false) update[`${name}.autorange`] = was.auto;
            else if (was.range) { update[`${name}.range`] = was.range; update[`${name}.autorange`] = false; }
        }
        return update;
    };

    proto._restoreViewHistoryEntry = function(plot, view) {
        const now = this._viewHistorySnapshot(plot)?.view || {};
        const restores = this._viewHistorySurfaces(plot).map(([name, div]) => {
            if (!view[name]) return null;
            const update = surfaceRestoreUpdate(view[name], now[name]);
            if (!Object.keys(update).length) return null;
            return Plotly.relayout(div, update).catch(() => {});
        });
        return Promise.all(restores).then(() => this._updateCameraOverlay?.(plot));
    };

    // Listens to every chart of the panel. Called whenever a mode builds its
    // charts (a Plotly.newPlot drops the listeners of the div it draws into).
    // The history lives on the plot, so it outlives rebuilds; new charts only
    // set a fresh baseline — the view they open with is not a step.
    proto._bindViewHistory = function(panelId, plot, { baseline = true } = {}) {
        if (!plot) return;
        plot._viewHistory ||= [];
        for (const [, div] of this._viewHistorySurfaces(plot)) {
            if (!div.on) continue;
            if (div._viewHistoryHandler) div.removeListener?.('plotly_relayout', div._viewHistoryHandler);
            div._viewHistoryHandler = () => this._markViewHistoryDirty(panelId);
            div.on('plotly_relayout', div._viewHistoryHandler);
        }
        if (baseline) {
            plot._viewCurrent = null;
            this._markViewHistoryDirty(panelId);
        }
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
            return this._restoreViewHistoryEntry(other, view).catch(() => {});
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
