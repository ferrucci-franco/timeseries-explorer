import i18n from '../../i18n/index.js';
import {
    TRACE_COLOR_SWATCHES,
    hexToHsv,
    hsvToHex,
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

    // The colour picker: the palette, then a colour of one's own. A palette
    // pick applies at once and closes it; Escape or a press outside closes it
    // with nothing changed.
    //
    // A colour of one's own is chosen in the picker's own square and strip,
    // by pressing or sliding (a finger or the mouse), and applied only by its
    // Apply button. It was the browser's picker (<input type="color">) at
    // first, applied on `change`: on a phone that event comes on every move
    // of the finger, so sliding to look for a colour rebuilt the panel many
    // times a second and removed the input its own picker was open on, and
    // the browser closed. Nothing here touches the plot until Apply.
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
        const place = () => {
            const at = point || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
            const x = Math.min(at.x, window.innerWidth - popover.offsetWidth - 8);
            const y = Math.min(at.y, window.innerHeight - popover.offsetHeight - 8);
            popover.style.left = `${Math.max(8, x)}px`;
            popover.style.top = `${Math.max(8, y)}px`;
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

        // ── A colour of one's own ───────────────────────────────────────
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'trace-color-custom-toggle';
        toggle.textContent = i18n.t('traceColorCustom');
        toggle.setAttribute('aria-expanded', 'false');
        popover.appendChild(toggle);

        const custom = document.createElement('div');
        custom.className = 'trace-color-custom';
        custom.hidden = true;
        popover.appendChild(custom);

        // The colour being looked for: the picker's own state, the plot's
        // only on Apply. Kept as hue, saturation and value, so the hue is not
        // lost on the way through a grey or black.
        const hsv = hexToHsv(current || TRACE_COLOR_SWATCHES[0]);

        const area = document.createElement('div');
        area.className = 'trace-color-area';
        area.tabIndex = 0;
        area.setAttribute('role', 'slider');
        area.setAttribute('aria-label', i18n.t('traceColorShade'));
        const areaThumb = document.createElement('div');
        areaThumb.className = 'trace-color-thumb';
        area.appendChild(areaThumb);

        const hue = document.createElement('div');
        hue.className = 'trace-color-hue';
        hue.tabIndex = 0;
        hue.setAttribute('role', 'slider');
        hue.setAttribute('aria-label', i18n.t('traceColorHue'));
        hue.setAttribute('aria-valuemin', '0');
        hue.setAttribute('aria-valuemax', '360');
        const hueThumb = document.createElement('div');
        hueThumb.className = 'trace-color-thumb';
        hue.appendChild(hueThumb);

        const row = document.createElement('div');
        row.className = 'trace-color-result';
        const preview = document.createElement('span');
        preview.className = 'trace-color-preview';
        const before = document.createElement('span');
        before.style.background = current || 'transparent';
        const after = document.createElement('span');
        preview.append(before, after);
        const hex = document.createElement('input');
        hex.type = 'text';
        hex.className = 'trace-color-hex';
        hex.maxLength = 7;
        hex.spellcheck = false;
        hex.autocapitalize = 'off';
        hex.autocomplete = 'off';
        hex.setAttribute('aria-label', i18n.t('traceColorHex'));
        row.append(preview, hex);

        const actions = document.createElement('div');
        actions.className = 'trace-color-actions';
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'trace-color-cancel';
        cancel.textContent = i18n.t('cancel');
        const apply = document.createElement('button');
        apply.type = 'button';
        apply.className = 'trace-color-apply';
        apply.textContent = i18n.t('apply');
        actions.append(cancel, apply);

        custom.append(area, hue, row, actions);

        const chosen = () => hsvToHex(hsv.h, hsv.s, hsv.v);
        const render = ({ keepText = false } = {}) => {
            const color = chosen();
            area.style.setProperty('--trace-color-hue', String(Math.round(hsv.h)));
            areaThumb.style.left = `${hsv.s * 100}%`;
            areaThumb.style.top = `${(1 - hsv.v) * 100}%`;
            areaThumb.style.background = color;
            hueThumb.style.left = `${(hsv.h / 360) * 100}%`;
            hueThumb.style.background = hsvToHex(hsv.h, 1, 1);
            after.style.background = color;
            area.setAttribute('aria-valuetext', color);
            hue.setAttribute('aria-valuenow', String(Math.round(hsv.h)));
            popover.dataset.color = color;
            if (!keepText) hex.value = color;
        };

        // Pressing or sliding on `element` reports where, as two fractions of
        // its box. The pointer is captured, so a slide that leaves the box
        // keeps going; CSS gives the box `touch-action: none`, so a finger
        // slides the colour and not the page.
        const slide = (element, onAt) => {
            const report = (event) => {
                const rect = element.getBoundingClientRect();
                if (!(rect.width > 0 && rect.height > 0)) return;
                onAt(
                    Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
                    Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
                );
            };
            element.addEventListener('pointerdown', (down) => {
                if (down.button > 0) return;
                down.preventDefault();
                element.focus({ preventScroll: true });
                try {
                    element.setPointerCapture(down.pointerId);
                } catch {
                    // A pointer that is already gone: the press still counts.
                }
                report(down);
                const move = (event) => {
                    if (event.pointerId === down.pointerId) report(event);
                };
                const end = (event) => {
                    if (event.pointerId !== down.pointerId) return;
                    element.removeEventListener('pointermove', move);
                    element.removeEventListener('pointerup', end);
                    element.removeEventListener('pointercancel', end);
                };
                element.addEventListener('pointermove', move);
                element.addEventListener('pointerup', end);
                element.addEventListener('pointercancel', end);
            });
        };
        slide(area, (x, y) => {
            hsv.s = x;
            hsv.v = 1 - y;
            render();
        });
        slide(hue, (x) => {
            hsv.h = x * 360;
            render();
        });

        const arrows = (element, onStep) => {
            element.addEventListener('keydown', (event) => {
                const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[event.key];
                if (!step) return;
                event.preventDefault();
                onStep(step[0], step[1], event.shiftKey ? 5 : 1);
                render();
            });
        };
        arrows(area, (dx, dy, times) => {
            hsv.s = Math.max(0, Math.min(1, hsv.s + dx * 0.02 * times));
            hsv.v = Math.max(0, Math.min(1, hsv.v + dy * 0.02 * times));
        });
        arrows(hue, (dx, dy, times) => {
            hsv.h = Math.max(0, Math.min(360, hsv.h + (dx || dy) * 2 * times));
        });

        const typed = () => {
            const text = hex.value.trim();
            return /^#?(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(text) ? hexToHsv(text.startsWith('#') ? text : `#${text}`) : null;
        };
        hex.addEventListener('input', () => {
            const value = typed();
            hex.classList.toggle('is-invalid', !value);
            if (!value) return;
            Object.assign(hsv, value);
            render({ keepText: true });
        });
        hex.addEventListener('blur', () => {
            hex.classList.remove('is-invalid');
            render();
        });
        hex.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (typed()) pick(chosen());
        });

        toggle.addEventListener('click', () => {
            const open = custom.hidden;
            custom.hidden = !open;
            toggle.setAttribute('aria-expanded', String(open));
            if (open) render();
            place();
        });
        cancel.addEventListener('click', () => close());
        apply.addEventListener('click', () => pick(chosen()));

        document.body.appendChild(popover);
        place();
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
