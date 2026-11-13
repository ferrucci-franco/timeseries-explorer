// The "computing" pill every analysis shows while it recalculates, and the
// Cancel button on it.
//
// While an analysis recomputes, the result already on screen stays: the pill
// floats over it with pointer-events off, so the previous spectrum, histogram
// or fit can still be panned, zoomed and read. Only the Cancel button on the
// pill takes the pointer. Pressing it stops the work in flight — the DuckDB
// queries and streams of a lazy file (through the panel's analysis signal),
// the FFT worker, the streamed curve fits, a run still waiting for its paint
// frame — and drops whatever that work would have drawn. The previous result
// stays, and so do its settings: each time a result settles on screen its
// settings are noted (_rememberAnalysisSettings), and Cancel puts them back in
// the options panel and the range selection, so what the panel says is what
// it shows.
//
// Work already running synchronously on the main thread (an in-memory kernel)
// cannot be interrupted; the pill shows before it starts, and a run cancelled
// then never starts. Once it has started, the page cannot take the click
// until it ends.
//
// Every analysis goes through here (_setAnalysisComputing while it computes,
// _analysisSignal for the queries it makes), so a new analysis gets the pill
// and its Cancel by doing the same — see CLAUDE.md.

import i18n from '../../i18n/index.js';

const PILL_CLASS = 'analysis-computing-indicator';

// Where each analysis keeps its settings on the plot.
const STATE_KEY = {
    fft: 'fft',
    histogram: 'histogram',
    heatmap: 'heatmap',
    'temporal-profile': 'temporalProfile',
    integral: 'integral',
    'curve-fit': 'curveFit',
    correlation: 'correlation',
    phase2d: 'phase2d',
};
// Settings that are the panel's layout, not what a result is computed from:
// Cancel leaves them as the user set them.
const LAYOUT_KEYS = new Set(['layout', 'split', 'optionsVisible', 'timeSeriesHidden', 'residualsHidden', 'dirty', 'warnings']);

const cloneSettings = (value) => {
    try {
        return structuredClone(value);
    } catch (_) {
        return JSON.parse(JSON.stringify(value));
    }
};
// A comparable text of settings (NaN and ±Infinity kept apart from null).
const settingsText = (value) => JSON.stringify(value, (key, v) => (typeof v === 'number' && !Number.isFinite(v) ? `#${v}` : v));
const HOST_CLASS = 'analysis-computing-host';

// What each analysis draws its result into, for "is there a previous result
// still on screen".
const RESULT_DIV = {
    fft: 'fftDiv',
    histogram: 'histogramDiv',
    heatmap: 'heatmapDiv',
    'temporal-profile': 'temporalProfileDiv',
    integral: 'integralDiv',
    correlation: 'correlationDiv',
};

export function installPlotAnalysisBusyMethods(TargetClass) {
    const proto = TargetClass.prototype;

    // The signal the queries of this panel's analysis carry. One controller per
    // panel, shared by consecutive runs (a superseded run is dropped by its
    // token, not aborted: a newer run may be waiting on the same cached query);
    // Cancel aborts it, and the next run gets a fresh one.
    proto._analysisSignal = function(plot) {
        if (!plot) return null;
        if (typeof AbortController !== 'function') return null;
        if (!plot._analysisAbort || plot._analysisAbort.signal.aborted) plot._analysisAbort = new AbortController();
        return plot._analysisAbort.signal;
    };

    // Where the pill goes: the pane that holds the analysis' result. `anchor`
    // is the pane it is centred on; `host` the element it is appended to —
    // the pane itself, except where the pane scrolls (the heatmap), which
    // would carry the pill away with its content.
    proto._analysisComputingTarget = function(plot, mode = plot?.mode) {
        const pane = (el) => el?.parentElement || null;
        let anchor = null;
        switch (mode) {
        case 'fft': anchor = pane(plot.fftDiv); break;
        case 'histogram': anchor = pane(plot.histogramDiv); break;
        case 'temporal-profile': anchor = pane(plot.temporalProfileDiv); break;
        case 'integral': anchor = pane(plot.integralDiv); break;
        case 'correlation': anchor = pane(plot.correlationDiv); break;
        case 'curve-fit': anchor = pane(plot.div); break;
        case 'phase2d': anchor = pane(plot.div); break;
        case 'heatmap': {
            anchor = pane(plot.heatmapDiv);
            return { anchor, host: anchor?.parentElement || null };
        }
        default: break;
        }
        return { anchor, host: anchor };
    };

    /**
     * Shows or hides the panel's computing pill. `label` defaults to the
     * generic "Calculating…"; `className` adds the analysis' own placement
     * class. Idempotent: a second call while shown only updates the label.
     */
    proto._setAnalysisComputing = function(plot, active, { label = '', className = '' } = {}) {
        if (!plot) return;
        const existing = plot._analysisPill;
        if (!active) {
            if (existing) existing.remove();
            plot._analysisPill = null;
            return;
        }
        const { anchor, host } = this._analysisComputingTarget(plot);
        if (!host || !anchor) return;
        let pill = existing;
        if (!pill || pill.parentElement !== host) {
            existing?.remove();
            pill = document.createElement('div');
            pill.className = `lazy-detail-indicator ${PILL_CLASS}`;
            pill.setAttribute('role', 'status');
            pill.setAttribute('aria-live', 'polite');
            const spinner = document.createElement('span');
            spinner.className = 'lazy-detail-spinner';
            spinner.setAttribute('aria-hidden', 'true');
            const text = document.createElement('span');
            text.className = 'lazy-detail-text';
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'analysis-cancel-btn';
            // The pill sits over a Plotly chart: keep the press to the button.
            for (const type of ['pointerdown', 'mousedown', 'touchstart']) {
                cancel.addEventListener(type, event => event.stopPropagation(), { passive: true });
            }
            cancel.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._cancelAnalysisComputation(this._panelIdForPlot?.(plot), plot);
            });
            pill.append(spinner, text, cancel);
            host.classList.add(HOST_CLASS);
            host.appendChild(pill);
            plot._analysisPill = pill;
        }
        pill.className = `lazy-detail-indicator ${PILL_CLASS}${className ? ` ${className}` : ''} active`;
        const shown = label || i18n.t('analysisCalculating');
        const text = pill.querySelector('.lazy-detail-text');
        if (text && text.textContent !== shown) text.textContent = shown;
        const cancel = pill.querySelector('.analysis-cancel-btn');
        if (cancel) {
            cancel.textContent = i18n.t('analysisCancel');
            cancel.title = i18n.t('analysisCancelTitle');
        }
        pill.setAttribute('aria-label', shown);
        if (host !== anchor) {
            // Centred over the anchor pane, inside a host that does not scroll.
            pill.style.left = `${anchor.offsetLeft + anchor.offsetWidth / 2}px`;
            pill.style.top = `${anchor.offsetTop + 10}px`;
        }
    };

    // Whether the analysis has a result on screen that a cancelled run leaves.
    proto._analysisHasResult = function(plot, mode = plot?.mode) {
        const hasData = (div) => Array.isArray(div?.data) && div.data.some(trace =>
            (trace?.x?.length || 0) > 0 || (trace?.y?.length || 0) > 0 || (trace?.z?.length || 0) > 0 || (trace?.values?.length || 0) > 0);
        if (mode === 'curve-fit') return [...(plot?._curveFitCache?.values() || [])].some(entry => entry?.result?.fit?.status === 'ok');
        if (mode === 'phase2d') return [...(plot?._phase2dLazyFits?.values() || [])].some(entry => entry?.fit?.status === 'ok') || (plot?._phase2dFits || []).some(r => r?.fit?.status === 'ok');
        return hasData(plot?.[RESULT_DIV[mode]]);
    };

    /**
     * Drops every analysis computation of the panel: runs waiting for a paint
     * frame or a debounce timer, results still to come (their tokens), and
     * the work itself where it can be stopped (the panel's analysis signal,
     * the histogram's streams, the FFT worker, the streamed fits). Shared by
     * Cancel and by _cancelPanelAnalysis (a panel or a file going away).
     */
    proto._dropAnalysisRuns = function(plot, reason = 'Analysis cancelled') {
        if (!plot) return;
        for (const key of [
            '_fftToken', '_fftPreparationToken', '_histToken', '_calendarHeatmapToken',
            '_temporalProfileToken', '_integralToken', '_correlationToken', '_phase2dLazyToken',
        ]) {
            plot[key] = (plot[key] || 0) + 1;
        }
        for (const key of [
            '_fftRecomputeTimer', '_histRecomputeTimer', '_calendarHeatmapRecomputeTimer',
            '_temporalProfileRecomputeTimer', '_integralRecomputeTimer',
            '_correlationRecomputeTimer', '_corrVisualTimer',
            '_phase2dFitRecomputeTimer', '_phase2dFitVisualTimer', '_curveFitRecomputeTimer',
        ]) {
            clearTimeout(plot[key]);
            plot[key] = null;
        }
        // Recomputes that are waiting for a paint frame are not timers: they
        // hold a token slot, and clearing it is what drops the pending run.
        for (const key of [
            '_histRecomputeRun', '_calendarHeatmapRecomputeRun', '_temporalProfileRecomputeRun',
            '_integralRecomputeRun', '_correlationRecomputeRun', '_phase2dFitRecomputeRun',
            '_curveFitRecomputeRun',
        ]) {
            plot[key] = null;
        }
        plot._analysisAbort?.abort();
        plot._analysisAbort = null;
        plot._histAbort?.abort();
        this._stopLazyFits?.(plot);
        this._abortFftWorkerJob?.(plot, reason);
    };

    // The settings a result of `mode` is computed from: the analysis' state
    // minus its layout, and for the 2D fit each pair's model (kept on the pair).
    proto._analysisSettings = function(plot, mode = plot?.mode) {
        const state = plot?.[STATE_KEY[mode]];
        if (!state || typeof state !== 'object') return null;
        const settings = {};
        for (const [key, value] of Object.entries(state)) {
            if (LAYOUT_KEYS.has(key) || typeof value === 'function') continue;
            settings[key] = value;
        }
        const pairs = mode === 'phase2d'
            ? (plot.phaseTraces || []).map(pair => ({ pair, fitModel: pair.fitModel }))
            : null;
        return { settings: cloneSettings(settings), pairs };
    };

    // Whether what the panel shows is the result of its current settings: not
    // while a lazy fit is still coming (its previous curve is on screen).
    proto._analysisSettled = function(plot, mode = plot?.mode) {
        if (mode === 'curve-fit') {
            return !(plot._curveFitResults || []).some(r => r.lazy && !r.result && r.lazyStatus === 'pending');
        }
        if (mode === 'phase2d') {
            if (plot._phase2dLazyJob) return false;
            return !(plot.phaseTraces || []).some((pair) => {
                if (pair.visible === false || this._phase2dPairModel?.(pair) === 'none' || !this._isLazyFile?.(pair.fileId)) return false;
                const cached = plot._phase2dLazyFits?.get(this._phase2dPairId(pair));
                return !(cached && cached.status === 'ok' && cached.key === this._phase2dLazyFitKey(plot, pair));
            });
        }
        return true;
    };

    // Noted each time a result settles on screen (every status line that is
    // not 'loading'): the settings Cancel puts back.
    proto._rememberAnalysisSettings = function(plot) {
        if (!plot || plot._analysisCancelling) return;
        const mode = plot.mode;
        if (!STATE_KEY[mode] || !this._analysisSettled(plot, mode)) return;
        const noted = this._analysisSettings(plot, mode);
        if (noted) plot._analysisApplied = { mode, ...noted };
    };

    /**
     * What every analysis' status line calls: the computing pill while it is
     * 'loading' (`pill: false` for an analysis that drives its pill itself),
     * and, once a result is there, its settings noted for Cancel.
     */
    proto._noteAnalysisStatus = function(plot, kind, { label = '', pill = true } = {}) {
        if (!plot) return;
        if (pill) this._setAnalysisComputing(plot, kind === 'loading', { label });
        if (kind !== 'loading') this._rememberAnalysisSettings(plot);
    };

    // Cancel: the settings of the result on screen back in the analysis' state,
    // its options panel and its range selection. False when there is nothing
    // to put back (no result yet, or the settings did not change).
    proto._restoreAnalysisSettings = function(panelId, plot) {
        const mode = plot?.mode;
        const applied = plot?._analysisApplied;
        const state = plot?.[STATE_KEY[mode]];
        if (!applied || applied.mode !== mode || !state) return false;
        const now = this._analysisSettings(plot, mode);
        const pairsChanged = (applied.pairs || []).some(({ pair, fitModel }) => pair.fitModel !== fitModel);
        if (settingsText(now?.settings) === settingsText(applied.settings) && !pairsChanged) return false;
        for (const key of Object.keys(state)) {
            if (!LAYOUT_KEYS.has(key) && !(key in applied.settings)) delete state[key];
        }
        Object.assign(state, cloneSettings(applied.settings));
        for (const { pair, fitModel } of applied.pairs || []) {
            if ((plot.phaseTraces || []).includes(pair)) pair.fitModel = fitModel;
        }
        const call = (name, ...args) => {
            try { this[name]?.(...args); } catch (error) { console.warn(`[analysis] ${name} after cancel:`, error); }
        };
        switch (mode) {
        case 'fft':
            call('_syncFftOptionsPanel', plot);
            call('_updateFftSelectionShapes', panelId, plot);
            break;
        case 'histogram':
            call('_syncHistogramOptionsPanel', plot);
            call('_updateHistogramSelectionShapes', panelId, plot);
            break;
        case 'heatmap':
            call('_syncCalendarHeatmapOptionsPanel', plot);
            call('_updateCalendarHeatmapSelectionShapes', panelId, plot);
            break;
        case 'temporal-profile':
            call('_syncTemporalProfileOptionsPanel', plot);
            call('_updateTemporalProfileSelectionShapes', panelId, plot);
            break;
        case 'integral':
            call('_syncIntegralOptionsPanel', plot);
            call('_updateIntegralSelectionShapes', panelId, plot);
            break;
        case 'curve-fit':
            // The fit on screen becomes the fit of its settings again, so no
            // refresh asks for it a second time.
            call('_rekeyCurveFitsAfterRestore', plot);
            call('_updateCurveFitSelectionShapes', plot);
            call('_paintCurveFits', panelId, plot, this._computeCurveFits?.(plot) || []);
            break;
        case 'correlation':
            call('_renderCorrelationOptionsPanel', panelId, plot);
            call('_updateCorrelationSelectionShapes', panelId, plot);
            break;
        case 'phase2d':
            call('_rekeyPhase2dFitsAfterRestore', plot);
            call('_rerenderPhase2dPlot', panelId, plot);
            call('_renderPhase2dFitDrawer', panelId, plot);
            call('_updatePhase2dFitSelectionShapes', panelId, plot);
            break;
        default: break;
        }
        return true;
    };

    /**
     * The Cancel button: stop what the panel's analysis is computing, keep
     * what it shows, and say so.
     */
    proto._cancelAnalysisComputation = function(panelId, plot = this.plots?.get(panelId)) {
        if (!plot) return;
        const mode = plot.mode;
        plot._analysisCancelling = true;
        try {
            // What a cancelled lazy fit must not start again on the next refresh
            // (the panel refreshes for many reasons): its key, as cancelled.
            if (mode === 'curve-fit') this._markCurveFitsCancelled?.(plot);
            if (mode === 'phase2d') this._markPhase2dFitsCancelled?.(plot);
            this._dropAnalysisRuns(plot, 'Analysis cancelled by the user');
            this._setAnalysisComputing(plot, false);
            const restored = this._restoreAnalysisSettings(panelId, plot);
            if (!restored) {
                // Settings unchanged (or no result yet): repaint what is known,
                // the previous curves drawn and the drawer saying "cancelled".
                if (mode === 'curve-fit' && plot.div) this._paintCurveFits?.(panelId, plot, plot._curveFitResults || []);
                if (mode === 'phase2d') {
                    this._rerenderPhase2dPlot?.(panelId, plot);
                    this._renderPhase2dFitDrawer?.(panelId, plot, { results: plot._phase2dFits || [] });
                }
            }
            const message = i18n.t(restored
                ? 'analysisCancelledRestored'
                : (this._analysisHasResult(plot, mode) ? 'analysisCancelledKept' : 'analysisCancelled'));
            switch (mode) {
            case 'fft': this._setFftStatus?.(plot, message, 'muted'); break;
            case 'histogram': this._setHistogramStatus?.(plot, message, 'muted'); break;
            case 'heatmap':
                plot.heatmapContainer?.setAttribute('aria-busy', 'false');
                this._setCalendarHeatmapStatus?.(plot, message, 'muted');
                break;
            case 'temporal-profile':
                plot.temporalProfileContainer?.setAttribute('aria-busy', 'false');
                this._setTemporalProfileStatus?.(plot, message, 'muted');
                break;
            case 'integral': this._setIntegralStatus?.(plot, message, [], 'muted'); break;
            case 'curve-fit': this._setCurveFitStatus?.(plot, message, 'muted'); break;
            case 'correlation': this._setCorrelationStatus?.(plot, message, 'muted'); break;
            case 'phase2d': this._setPhase2dFitStatus?.(plot, message, 'muted'); break;
            default: break;
            }
        } finally {
            plot._analysisCancelling = false;
        }
    };

    // An AbortError a run did not ask for — it shared a cached query with a
    // panel whose analysis was cancelled — means: run again.
    proto._isForeignAbort = function(error, signal) {
        return error?.name === 'AbortError' && !signal?.aborted;
    };
}
