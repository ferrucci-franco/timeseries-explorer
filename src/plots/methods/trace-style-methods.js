import i18n from '../../i18n/index.js';
import {
    TRACE_COLOR_SWATCHES,
    moveTraceInList,
    setTraceColor,
    traceColorHex,
    traceMovesAvailable,
} from '../trace-style.js';

// A trace's colour and its place among the plot's traces (#371), from the
// legend's context menu on a desktop and from a trace's row in the Plot sheet
// on a phone.
//
// Both are the trace state's: `color` and the order of plot.traces (or of
// plot.phaseTraces, for the pairs of the 2D/3D modes and Correlation). Every
// analysis draws a series from that state (the spectrum, the bars, the fit,
// the integral, the profile…), so the panel is rebuilt with its view kept and
// all of them follow; that is also how a saved view, a tab off screen and an
// export get the new colour and order without anything of their own. The
// rebuild is what the line-shape and legend-unit changes do too: a restyle
// would have to know every companion trace (NaN marks, samples, gap breaks,
// the analysis panes) a series draws.

const MOVE_ITEMS = [
    ['up', 'legendMenuMoveUp', 'moveUp'],
    ['down', 'legendMenuMoveDown', 'moveDown'],
    ['first', 'legendMenuMoveFirst', 'moveFirst'],
    ['last', 'legendMenuMoveLast', 'moveLast'],
];

export function installPlotTraceStyleMethods(TargetClass) {
    const proto = TargetClass.prototype;

    // The panel whose state holds `trace`, and the list it is in.
    proto._traceStyleOwner = function(trace) {
        if (!trace || !this.plots) return null;
        for (const [panelId, plot] of this.plots) {
            for (const key of ['traces', 'phaseTraces']) {
                const list = plot?.[key];
                if (Array.isArray(list) && list.includes(trace)) return { panelId, plot, list, key };
            }
        }
        return null;
    };

    // A state band is drawn in its own palette (utils/state-colors.js), not
    // in its trace's colour: it has no colour to change.
    proto._traceStyleCanColor = function(owner, trace) {
        return !(owner?.key === 'traces' && this._isStateBandTrace?.(trace));
    };

    // The menu items for `trace`: Colour…, then the moves, those that would
    // leave it where it is disabled. A plot of one trace has nothing to order.
    // `point` places the colour popover; `onChange` runs after a change.
    proto._traceStyleMenuItems = function(trace, { point = null, onChange = null } = {}) {
        const owner = this._traceStyleOwner(trace);
        if (!owner) return [];
        const items = [];
        if (this._traceStyleCanColor(owner, trace)) {
            items.push({
                labelKey: 'legendMenuColor',
                icon: 'color',
                className: 'timeseries-axis-menu-divider',
                action: () => this._showTraceColorPopover(point, trace, { onChange }),
            });
        }
        if (owner.list.length > 1) {
            const available = traceMovesAvailable(owner.list, trace);
            MOVE_ITEMS.forEach(([where, labelKey, icon], index) => {
                items.push({
                    labelKey,
                    icon,
                    className: index === 0 ? 'timeseries-axis-menu-divider' : '',
                    disabled: !available[where],
                    action: () => this._moveTraceStyle(trace, where, { onChange }),
                });
            });
        }
        return items;
    };

    // Changes made in one go (a colour and a move, say) make one rebuild: a
    // panel rebuilt again before its charts have finished drawing leaves
    // Plotly redrawing a chart that is gone.
    proto._applyTraceStyleChange = function(owner, onChange) {
        const { panelId, plot } = owner;
        const pending = plot._traceStyleRebuild || (plot._traceStyleRebuild = { callbacks: [] });
        if (onChange) pending.callbacks.push(onChange);
        if (pending.scheduled) return;
        pending.scheduled = true;
        queueMicrotask(() => {
            plot._traceStyleRebuild = null;
            if (this.plots.get(panelId) === plot) this._rebuildPanel(panelId, { preserveView: true });
            for (const callback of pending.callbacks) {
                try {
                    callback();
                } catch (error) {
                    console.error('[trace-style] onChange failed:', error);
                }
            }
        });
    };

    proto._setTraceStyleColor = function(trace, color, { onChange = null } = {}) {
        const owner = this._traceStyleOwner(trace);
        if (!owner || !this._traceStyleCanColor(owner, trace)) return false;
        if (!setTraceColor(trace, color)) return false;
        this._applyTraceStyleChange(owner, onChange);
        return true;
    };

    proto._moveTraceStyle = function(trace, where, { onChange = null } = {}) {
        const owner = this._traceStyleOwner(trace);
        if (!owner) return false;
        // The 2D fit's drawer edits a pair by its place among the visible
        // ones: that place follows the pair it was showing.
        const phase2d = owner.key === 'phaseTraces' ? owner.plot.phase2d : null;
        const activePair = phase2d ? this._phase2dActivePair?.(owner.plot) : null;
        if (!moveTraceInList(owner.list, trace, where)) return false;
        if (phase2d && activePair) {
            const index = owner.list.filter(pair => pair.visible !== false).indexOf(activePair);
            if (index >= 0) phase2d.activePairIndex = index;
        }
        this._applyTraceStyleChange(owner, onChange);
        return true;
    };

    // The colour picker: the palette, then a colour of one's own through the
    // browser's picker. A pick applies at once and closes it; Escape or a
    // press outside closes it with nothing changed.
    proto._showTraceColorPopover = function(point, trace, { onChange = null } = {}) {
        document.querySelector('.trace-color-popover')?.remove();
        const current = traceColorHex(trace?.color);
        const popover = document.createElement('div');
        popover.className = 'trace-color-popover';
        popover.setAttribute('role', 'dialog');
        popover.setAttribute('aria-label', i18n.t('traceColorTitle'));

        const close = (closeEvent = null) => {
            if (closeEvent?.type === 'pointerdown' && popover.contains(closeEvent.target)) return;
            if (closeEvent?.type === 'keydown' && closeEvent.key !== 'Escape') return;
            popover.remove();
            document.removeEventListener('pointerdown', close, true);
            document.removeEventListener('keydown', close, true);
        };
        const pick = (color) => {
            close();
            this._setTraceStyleColor(trace, color, { onChange });
        };

        const title = document.createElement('div');
        title.className = 'trace-color-title';
        title.textContent = i18n.t('traceColorTitle');
        popover.appendChild(title);

        const grid = document.createElement('div');
        grid.className = 'trace-color-swatches';
        for (const color of TRACE_COLOR_SWATCHES) {
            const swatch = document.createElement('button');
            swatch.type = 'button';
            swatch.className = 'trace-color-swatch';
            swatch.dataset.color = color;
            swatch.style.background = color;
            swatch.title = color;
            swatch.setAttribute('aria-label', i18n.t('traceColorSwatch').replace('{color}', color));
            swatch.setAttribute('aria-pressed', String(color === current));
            swatch.addEventListener('click', () => pick(color));
            grid.appendChild(swatch);
        }
        popover.appendChild(grid);

        const custom = document.createElement('label');
        custom.className = 'trace-color-custom';
        const input = document.createElement('input');
        input.type = 'color';
        input.value = current || TRACE_COLOR_SWATCHES[0];
        // `change`, not `input`: the browser's picker sends `input` on every
        // move of its cursor, and each pick rebuilds the panel.
        input.addEventListener('change', () => pick(input.value));
        const customLabel = document.createElement('span');
        customLabel.textContent = i18n.t('traceColorCustom');
        custom.append(input, customLabel);
        popover.appendChild(custom);

        document.body.appendChild(popover);
        const at = point || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
        const x = Math.min(at.x, window.innerWidth - popover.offsetWidth - 8);
        const y = Math.min(at.y, window.innerHeight - popover.offsetHeight - 8);
        popover.style.left = `${Math.max(8, x)}px`;
        popover.style.top = `${Math.max(8, y)}px`;
        (grid.querySelector('[aria-pressed="true"]') || grid.firstElementChild)?.focus?.();
        setTimeout(() => {
            if (!popover.isConnected) return;
            document.addEventListener('pointerdown', close, true);
            document.addEventListener('keydown', close, true);
        }, 0);
        return popover;
    };

    // The phone's way in (no right-click there): the colour and order actions
    // of one trace, under the button that asked for them.
    proto._showTraceStyleMenu = function(anchor, trace, { onChange = null } = {}) {
        const rect = anchor?.getBoundingClientRect?.();
        const point = rect ? { x: rect.left, y: rect.bottom + 4 } : null;
        const items = this._traceStyleMenuItems(trace, { point, onChange });
        if (!items.length) return null;
        // The first item needs no line above it.
        items[0] = { ...items[0], className: '' };
        return this._openTraceMenu(point || { x: 8, y: 8 }, items);
    };
}
