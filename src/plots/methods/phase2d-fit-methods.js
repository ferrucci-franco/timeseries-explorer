import i18n from '../../i18n/index.js';
import Plotly from '../../vendor/plotly.js';
import {
    defaultPhase2dState,
    normalizePhase2dState,
    phase2dPlotlyMode,
    phase2dShowsMarkers,
    clampNumber,
    MARKER_SIZE_MIN,
    MARKER_SIZE_MAX,
    MARKER_OPACITY_MIN,
    MARKER_OPACITY_MAX,
    PHASE2D_DISPLAY_MODES,
} from '../phase2d-state.js';

// TODO 10 — 2D mode: point/line display + (later) linear/quadratic fitting.
// Phase 1 installs only the display state and the Lines / Points / Lines+points
// controls with compact marker options; the fitting shell/kernel come in later
// phases into this same module. Pure state lives in plots/phase2d-state.js.

export function installPlotPhase2dFitMethods(TargetClass) {
    const proto = TargetClass.prototype;

    // ── State ──────────────────────────────────────────────────────
    proto._defaultPhase2dState = function() {
        return defaultPhase2dState();
    };

    proto._normalizePhase2dState = function(raw = {}) {
        return normalizePhase2dState(raw);
    };

    proto._ensurePhase2dState = function(plot) {
        if (!plot) return defaultPhase2dState();
        if (!plot.phase2d) {
            plot.phase2d = normalizePhase2dState({});
            return plot.phase2d;
        }
        Object.assign(plot.phase2d, normalizePhase2dState(plot.phase2d));
        return plot.phase2d;
    };

    proto._phase2dPlotlyMode = function(state) {
        return phase2dPlotlyMode(state);
    };

    proto._phase2dShowsMarkers = function(state) {
        return phase2dShowsMarkers(state);
    };

    // ── Display + marker toolbar controls (phase2d only) ────────────
    proto._injectPhase2dDisplayControls = function(panelId, toolbar, plot) {
        if (!toolbar || plot?.mode !== 'phase2d') return;
        const state = this._ensurePhase2dState(plot);

        const group = document.createElement('div');
        group.className = 'phase2d-tools-group';

        // Display: Lines / Points / Lines+points as a compact select.
        const displaySelect = document.createElement('select');
        displaySelect.className = 'phase2d-display-select';
        displaySelect.title = i18n.t('phase2dDisplayTooltip');
        displaySelect.setAttribute('aria-label', i18n.t('phase2dDisplayLabel'));
        [
            ['lines', i18n.t('phase2dDisplayLines')],
            ['markers', i18n.t('phase2dDisplayPoints')],
            ['lines+markers', i18n.t('phase2dDisplayLinesPoints')],
        ].forEach(([value, label]) => {
            const opt = document.createElement('option');
            opt.value = value;
            opt.textContent = label;
            if (value === state.displayMode) opt.selected = true;
            displaySelect.appendChild(opt);
        });
        displaySelect.addEventListener('change', () => this._setPhase2dDisplayMode(panelId, displaySelect.value));
        group.appendChild(displaySelect);

        // Compact marker size / opacity — only when points are shown.
        const markerWrap = document.createElement('div');
        markerWrap.className = 'phase2d-marker-controls';
        markerWrap.hidden = !this._phase2dShowsMarkers(state);

        const makeNumber = (key, labelKey, min, max, step, value) => {
            const label = document.createElement('label');
            label.className = 'phase2d-marker-field';
            label.title = i18n.t(labelKey);
            const span = document.createElement('span');
            span.textContent = i18n.t(labelKey);
            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'phase2d-marker-input';
            input.min = String(min);
            input.max = String(max);
            input.step = String(step);
            input.value = String(value);
            input.setAttribute('aria-label', i18n.t(labelKey));
            input.addEventListener('change', () => this._setPhase2dMarkerSetting(panelId, key, input.value));
            label.append(span, input);
            return label;
        };
        markerWrap.append(
            makeNumber('markerSize', 'phase2dMarkerSize', MARKER_SIZE_MIN, MARKER_SIZE_MAX, 1, state.markerSize),
            makeNumber('markerOpacity', 'phase2dMarkerOpacity', MARKER_OPACITY_MIN, MARKER_OPACITY_MAX, 0.05, state.markerOpacity),
        );
        group.appendChild(markerWrap);

        toolbar.appendChild(group);
    };

    proto._setPhase2dDisplayMode = function(panelId, displayMode) {
        const plot = this.plots.get(panelId);
        if (!plot || plot.mode !== 'phase2d') return;
        const state = this._ensurePhase2dState(plot);
        state.displayMode = PHASE2D_DISPLAY_MODES.has(displayMode) ? displayMode : 'lines';
        // Show/hide the compact marker controls without a full toolbar rebuild.
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        const markerWrap = panelEl?.querySelector('.phase2d-marker-controls');
        if (markerWrap) markerWrap.hidden = !this._phase2dShowsMarkers(state);
        this._restylePhase2dDisplay(panelId, plot);
    };

    proto._setPhase2dMarkerSetting = function(panelId, key, rawValue) {
        const plot = this.plots.get(panelId);
        if (!plot || plot.mode !== 'phase2d') return;
        const state = this._ensurePhase2dState(plot);
        if (key === 'markerSize') state.markerSize = clampNumber(rawValue, MARKER_SIZE_MIN, MARKER_SIZE_MAX, state.markerSize);
        else if (key === 'markerOpacity') state.markerOpacity = clampNumber(rawValue, MARKER_OPACITY_MIN, MARKER_OPACITY_MAX, state.markerOpacity);
        else return;
        this._restylePhase2dDisplay(panelId, plot);
    };

    // Display change is a pure restyle over the SAME visual data — no query, no
    // pair change, no fitting recompute (that matters for the lazy path).
    proto._restylePhase2dDisplay = function(panelId, plot = this.plots.get(panelId)) {
        if (!plot?.div || plot.mode !== 'phase2d') return;
        const state = this._ensurePhase2dState(plot);
        const mode = this._phase2dPlotlyMode(state);
        const showMarkers = this._phase2dShowsMarkers(state);
        const data = plot.div.data || [];
        const indices = [];
        const modes = [];
        const markers = [];
        const types = [];
        let typeChanged = false;
        data.forEach((tr, i) => {
            // Leave the origin cross and transient hover markers alone.
            if (!tr || tr.name === '__origin__' || tr.name === '__hover__') return;
            indices.push(i);
            modes.push(mode);
            const color = tr.line?.color || tr.marker?.color;
            markers.push(showMarkers
                ? { color, size: state.markerSize, opacity: state.markerOpacity }
                : { color });
            // Toggling markers on/off can cross the WebGL point threshold, so a
            // Points display doesn't crawl in SVG. Only send `type` when it
            // actually changes — restyling `type` forces a replot, and marker
            // size/opacity tweaks must stay cheap.
            const len = Math.max(tr.x?.length || 0, tr.y?.length || 0);
            const wantType = this._phase2dUseGL(len, showMarkers) ? 'scattergl' : 'scatter';
            types.push(wantType);
            if (wantType !== (tr.type || 'scatter')) typeChanged = true;
        });
        if (!indices.length) return;
        const update = { mode: modes, marker: markers };
        if (typeChanged) update.type = types;
        Plotly.restyle(plot.div, update, indices);
    };
}
