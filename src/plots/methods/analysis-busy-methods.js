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
// stays, and the status line says it is the previous one.
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

    /**
     * The Cancel button: stop what the panel's analysis is computing, keep
     * what it shows, and say so.
     */
    proto._cancelAnalysisComputation = function(panelId, plot = this.plots?.get(panelId)) {
        if (!plot) return;
        const mode = plot.mode;
        // What a cancelled lazy fit must not start again on the next refresh
        // (the panel refreshes for many reasons): its key, as cancelled.
        if (mode === 'curve-fit') this._markCurveFitsCancelled?.(plot);
        if (mode === 'phase2d') this._markPhase2dFitsCancelled?.(plot);
        this._dropAnalysisRuns(plot, 'Analysis cancelled by the user');
        this._setAnalysisComputing(plot, false);
        const message = i18n.t(this._analysisHasResult(plot, mode) ? 'analysisCancelledKept' : 'analysisCancelled');
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
    };

    // An AbortError a run did not ask for — it shared a cached query with a
    // panel whose analysis was cancelled — means: run again.
    proto._isForeignAbort = function(error, signal) {
        return error?.name === 'AbortError' && !signal?.aborted;
    };
}
