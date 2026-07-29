// Panel side of the digital filter tool.
//
// The kernel (src/compute/kernels/iir.js) owns the mathematics and the verdict;
// what lives here is reading two text boxes, and — the part that matters — making
// the verdict VISIBLE and BINDING before anything runs. An unstable filter is not
// reported after the fact: the Create buttons go dead, the reason is spelled out
// under the coefficients, and the live preview stops drawing. There is no path
// through this panel that runs an unstable recursion over a user's data.

import i18n from '../../i18n/index.js';
import { inspectFilter } from '../../compute/kernels/index.js';
import { FILTER_MODES, parseCoefficients } from '../../compute/kernels/iir.js';

export function installFilterMethods(TargetClass) {
    const proto = TargetClass.prototype;

proto.initFilterTool = function() {
    // Coefficients settle on blur/Enter. Re-checking on every keystroke would
    // run the stability test on the "1, -" of "1, -1.8" and flash "unstable"
    // at someone who is halfway through typing a perfectly good filter.
    for (const id of ['filter-b', 'filter-a']) {
        document.getElementById(id)?.addEventListener('change', () => this._handleDataToolOptionChange());
        // The summary is cheap and non-committal, so it may follow along live;
        // only the verdict waits for the field to settle.
        document.getElementById(id)?.addEventListener('input', () => this._syncFilterControls());
    }
    document.getElementById('filter-mode')?.addEventListener('change', () => this._handleDataToolOptionChange());
    document.getElementById('filter-help-toggle')?.addEventListener('click', (event) => {
        event.stopPropagation();
        this._toggleFilterHelpPopover();
    });
};

proto._toggleFilterHelpPopover = function(show) {
    const popover = document.getElementById('filter-help-popover');
    const button = document.getElementById('filter-help-toggle');
    if (!popover || !button) return;
    const willShow = typeof show === 'boolean' ? show : popover.hidden;
    popover.hidden = !willShow;
    button.classList.toggle('active', willShow);
    button.setAttribute('aria-expanded', String(willShow));
    if (willShow) this._positionFilterHelpPopover(popover, button);
};

// The sidebar clips horizontal overflow, so a popover wide enough to hold the
// difference equation on one line cannot be absolutely positioned inside it.
// Fixed positioning escapes the clip; the cost is that the placement has to be
// computed here rather than declared in CSS. Clamped to the viewport on both
// axes so it can never open partly off-screen on a narrow window.
proto._positionFilterHelpPopover = function(popover, button) {
    if (typeof window === 'undefined' || !button.getBoundingClientRect) return;
    const rect = button.getBoundingClientRect();
    const margin = 12;
    // A viewport that reports zero (an offscreen or not-yet-composited window)
    // would otherwise collapse the popover to a sliver. Fall back to the document
    // width, and never go below a width the equation can still be read in.
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 900;
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 700;
    const width = Math.max(300, Math.min(600, viewportWidth - 2 * margin));
    const top = Math.min(rect.bottom + 8, Math.max(margin, viewportHeight - 120));
    const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin));
    popover.style.position = 'fixed';
    popover.style.width = `${width}px`;
    popover.style.left = `${left}px`;
    popover.style.right = 'auto';
    popover.style.top = `${top}px`;
    popover.style.maxHeight = `${Math.max(160, viewportHeight - top - margin)}px`;
};

// ─── Reading the form ─────────────────────────────────────────────────────

proto._readFilterCoefficients = function() {
    const b = parseCoefficients(document.getElementById('filter-b')?.value ?? '1');
    const a = parseCoefficients(document.getElementById('filter-a')?.value ?? '1');
    return { b, a };
};

/**
 * Everything the panel needs to say about the current coefficients.
 * @returns {{ ok: boolean, text: string, code: string, inspection: object|null }}
 *   `code` is the i18n key naming what is wrong, or '' when the filter is usable.
 */
proto._filterPlan = function() {
    const { b, a } = this._readFilterCoefficients();
    if (!b.values || !a.values) {
        const bad = b.badToken || a.badToken;
        return {
            ok: false,
            code: 'dataToolFilterNotNumeric',
            text: i18n.t('dataToolFilterNotNumeric').replace('{token}', bad),
            inspection: null,
        };
    }
    if (!b.values.length || !a.values.length) {
        return { ok: false, code: 'dataToolFilterEmpty', text: i18n.t('dataToolFilterEmpty'), inspection: null };
    }

    let inspection;
    try {
        inspection = inspectFilter(b.values, a.values);
    } catch (err) {
        const code = err?.code || 'dataToolFilterNotNumeric';
        return { ok: false, code, text: i18n.t(code), inspection: null };
    }

    if (!inspection.stable) {
        // Name the pole when the root finder found one. "A pole at |z| = 1.030"
        // tells the user which coefficient to pull back; "unstable" does not.
        // A pole ON the circle gets its own sentence, because saying "outside the
        // unit circle" about one sitting exactly on it is simply wrong, and this
        // is a panel engineers read closely.
        const radius = inspection.maxPoleRadius;
        let text;
        if (!Number.isFinite(radius) || !(radius > 0)) {
            text = i18n.t('dataToolFilterUnstable');
        } else {
            const key = Math.abs(radius - 1) < 5e-4
                ? 'dataToolFilterUnstableOnCircle'
                : 'dataToolFilterUnstableDetail';
            text = i18n.t(key).replace('{radius}', formatNumber(radius));
        }
        return { ok: false, code: 'dataToolFilterUnstable', text, inspection };
    }

    const isFir = inspection.denominatorOrder === 0;
    const key = isFir ? 'dataToolFilterInfoFir' : 'dataToolFilterInfo';
    const text = i18n.t(key)
        .replace('{order}', String(inspection.order))
        .replace('{pole}', formatNumber(inspection.maxPoleRadius))
        .replace('{gain}', formatNumber(inspection.dcGain));
    return { ok: true, code: '', text, inspection };
};

proto._getFilterConfig = function() {
    const plan = this._filterPlan();
    // Throwing is what makes the preview and the commit refuse in the same
    // place: both read the config, and neither gets one for an unstable filter.
    if (!plan.ok) {
        const error = new Error(plan.text);
        error.code = plan.code;
        throw error;
    }
    const mode = document.getElementById('filter-mode')?.value;
    return {
        tool: 'filter',
        params: {
            // Stored NORMALIZED (a₀ = 1, both lists the same length), so a saved
            // session reproduces exactly the recursion that ran, not the text
            // that happened to be in the box.
            b: Array.from(plan.inspection.b),
            a: Array.from(plan.inspection.a),
            mode: FILTER_MODES.has(mode) ? mode : 'forward',
        },
    };
};

proto._syncFilterControls = function() {
    const info = document.getElementById('filter-info');
    if (!info) return;
    if (this._getSelectedDataTool() !== 'filter') {
        info.textContent = '';
        info.classList.remove('invalid');
        return;
    }
    const plan = this._filterPlan();
    info.textContent = plan.text;
    info.classList.toggle('invalid', !plan.ok);
};

proto._filterDescription = function(params = {}) {
    const list = values => Array.from(values || []).map(value => Number(Number(value).toPrecision(6))).join(', ');
    const pass = params.mode === 'zeroPhase' ? 'zero phase' : 'forward';
    return `b [${list(params.b)}]; a [${list(params.a)}]; ${pass}`;
};

}

function formatNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '?';
    if (n === 0) return '0';
    const abs = Math.abs(n);
    if (abs >= 1e6 || abs < 1e-4) return n.toExponential(3);
    return String(Number(n.toPrecision(4)));
}
