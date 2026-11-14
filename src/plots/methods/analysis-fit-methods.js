// Whose are Fit X, Fit Y and Fit all?
//
// An analysis panel shows two things: the time series, and the result beside
// or below it. The panel's toolbar has one set of fit buttons, and nothing
// said which of the two they acted on — they fitted the RESULT, while the
// obvious reading is that the buttons at the top of the panel belong to the
// plot at the top of the panel.
//
// So:
//
//   · the toolbar's buttons belong to the TIME SERIES while it is on screen,
//     and to the analysis' own pane when the user has folded the time series
//     away (then there is only one plot left, and no question to answer);
//   · while both are on screen, the analysis' pane carries three floating
//     buttons of its own, in its top right corner, faint until the pointer is
//     on them — the same three the phone layout already draws over a plot.
//     They are the only buttons for that pane, and they go when it is the
//     only pane left.
//
// The 2D fit is the other way round and stays that way: the plot it is built
// on IS the result (x against y), and the time series is the pane beside it —
// so the toolbar keeps the 2D plot, and the floating buttons go to the time
// pane. The rule is the same one: the toolbar belongs to the pane the panel
// is built on.
//
// Which pane is which, how each is fitted and which can be folded away is
// described once, per analysis, in src/app/methods/compact-analyses.js — the
// phone layout's description of the same panels, which imports nothing and is
// read here rather than copied.

import i18n from '../../i18n/index.js';
import Plotly from '../../vendor/plotly.js';
import { compactAnalysisFor } from '../../app/methods/compact-analyses.js';

// The icons of the phone layout's own fit buttons, so a user who knows one
// layout knows the other.
const ICON = {
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5v14M20 5v14"/><path d="M8 12h8M8 12l3-3M8 12l3 3M16 12l-3-3M16 12l-3 3"/></svg>',
    y: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4h14M5 20h14"/><path d="M12 8v8M12 8l-3 3M12 8l3 3M12 16l-3-3M12 16l3-3"/></svg>',
    all: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>',
};

const AXES = [
    { axis: 'x', icon: ICON.x, titleKey: 'autoScaleXTitle' },
    { axis: 'y', icon: ICON.y, titleKey: 'autoScaleYTitle' },
    { axis: 'all', icon: ICON.all, titleKey: 'viewHome' },
];

export function installPlotAnalysisFitMethods(TargetClass) {
    const proto = TargetClass.prototype;

    /**
     * What the fit buttons of this panel act on, or null when the panel is not
     * an analysis with two panes.
     *
     * `toolbarOwnsMain` says the toolbar fits the pane the plot is built on
     * (the time series, for every analysis but the 2D fit) rather than the
     * analysis' own; `floatDiv` is the pane that gets the floating trio, and
     * is null when there is nothing beside it to tell apart.
     */
    proto._analysisFitPlan = function (plot) {
        const entry = compactAnalysisFor(plot);
        if (!entry?.pane || !plot?.div) return null;
        const ctx = { pm: this, plot };
        const mainHidden = !!entry.hidden?.main?.(ctx);
        const paneHidden = !!entry.hidden?.pane?.(ctx);
        const paneDiv = entry.pane.div ? plot[entry.pane.div] : null;
        // A pane with no axes to fit (the Trend's table of segments) is not a
        // second plot: the toolbar keeps the one plot there is.
        const fittable = !!entry.pane.fit && !!paneDiv?._fullLayout;
        return {
            mode: plot.mode,
            entry,
            mainHidden,
            paneHidden,
            // The toolbar fits the time series while it is on screen. With it
            // folded away the analysis' pane is all there is, and the toolbar
            // fits that, as it always did. The 2D fit's own plot is not a time
            // series (it is the result), so its toolbar keeps the path it has.
            toolbarOwnsMain: entry.mainPane === 'time' && !mainHidden,
            floatDiv: !mainHidden && !paneHidden && fittable ? paneDiv : null,
            floatFitY: entry.pane.fitY !== false,
        };
    };

    /** Fit one axis (or all) of the analysis' own pane. */
    proto._fitAnalysisPane = function (panelId, plot, axis) {
        const plan = this._analysisFitPlan(plot);
        const div = plan?.entry?.pane?.div ? plot[plan.entry.pane.div] : null;
        if (!plan?.entry?.pane?.fit || !div?._fullLayout) return Promise.resolve();
        const relayout = (update) => (update && Object.keys(update).length
            ? Plotly.relayout(div, update)
            : Promise.resolve());
        return Promise.resolve(plan.entry.pane.fit({ pm: this, panelId, plot, div, relayout }, axis));
    };

    /**
     * The three floating buttons over the analysis' own pane: made when the
     * pane first has something to fit, shown while both panes are on screen,
     * hidden when the time series is folded away (the toolbar's buttons are
     * then that pane's own) and in the phone layout, which draws its own.
     */
    proto._refreshAnalysisFitButtons = function (plot) {
        const plan = this._analysisFitPlan(plot);
        const panelId = this._panelIdForPlot?.(plot);
        const compact = document.documentElement.classList.contains('compact');
        const div = plan?.floatDiv;
        const existing = plot?._analysisFitGroup;
        if (!div || compact || !panelId) {
            if (existing) existing.hidden = true;
            return;
        }
        let group = existing;
        if (!group || group.parentNode !== div) {
            group = document.createElement('div');
            group.className = 'analysis-fit-group';
            for (const { axis, icon, titleKey } of AXES) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'analysis-fit-btn';
                button.dataset.axis = axis;
                button.innerHTML = icon;
                button.title = i18n.t(titleKey);
                button.setAttribute('aria-label', button.title);
                button.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const id = this._panelIdForPlot?.(plot);
                    if (id == null) return;
                    this._runWithEagerDetailLoading(id, () => this._fitAnalysisPane(id, plot, axis));
                });
                group.appendChild(button);
            }
            div.appendChild(group);
            plot._analysisFitGroup = group;
        }
        group.hidden = false;
        // The language may have changed since the group was made.
        for (const { axis, titleKey } of AXES) {
            const button = group.querySelector(`[data-axis="${axis}"]`);
            if (!button) continue;
            button.title = i18n.t(titleKey);
            button.setAttribute('aria-label', button.title);
            // A pane with nothing to fit on one axis (the Heatmap's calendar
            // rows) does not offer that button, as the toolbar does not either.
            if (axis === 'y') button.hidden = !plan.floatFitY;
        }
    };
}
