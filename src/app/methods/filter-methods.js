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
import {
    FILTER_INIT_MODES,
    FILTER_MODES,
    normalizeFilterRestartGap,
    parseCoefficients,
} from '../../compute/kernels/iir.js';
import { detectSamplingGaps } from '../../utils/sampling-gaps.js';

export function installFilterMethods(TargetClass) {
    const proto = TargetClass.prototype;

proto.initFilterTool = function() {
    // Coefficients settle on blur/Enter. Re-checking on every keystroke would
    // run the stability test on the "1, -" of "1, -1.8" and flash "unstable"
    // at someone who is halfway through typing a perfectly good filter.
    for (const id of ['filter-b', 'filter-a']) {
        document.getElementById(id)?.addEventListener('change', () => {
            // A manual state belongs to the filter it was written for. Once the
            // coefficients move, its length is very likely wrong and its meaning
            // certainly is, so it is cleared rather than silently reinterpreted.
            this._clearManualFilterState();
            this._handleDataToolOptionChange();
        });
        // The summary is cheap and non-committal, so it may follow along live;
        // only the verdict waits for the field to settle.
        document.getElementById(id)?.addEventListener('input', () => this._syncFilterControls());
    }
    for (const id of ['filter-mode', 'filter-init', 'filter-init-state', 'filter-restart-gap']) {
        document.getElementById(id)?.addEventListener('change', () => this._handleDataToolOptionChange());
    }
    document.getElementById('filter-init-state')?.addEventListener('input', () => this._syncFilterControls());
    document.getElementById('filter-help-toggle')?.addEventListener('click', (event) => {
        event.stopPropagation();
        this._toggleFilterHelpPopover();
    });
    document.getElementById('filter-init-help-toggle')?.addEventListener('click', (event) => {
        event.stopPropagation();
        this._toggleFilterInitHelpPopover();
    });
};

proto._clearManualFilterState = function() {
    const input = document.getElementById('filter-init-state');
    if (input) input.value = '';
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

proto._toggleFilterInitHelpPopover = function(show) {
    const popover = document.getElementById('filter-init-help-popover');
    const button = document.getElementById('filter-init-help-toggle');
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
// computed here rather than declared in CSS.
//
// It opens BESIDE the sidebar, not below the button. Below is where the filter's
// own controls are, and a 600px panel dropped on top of them hides exactly what
// the reader is trying to understand; it also lands near the bottom of the page,
// since Data Tools sits well down the sidebar. Vertically it tracks the button
// and is then pulled up as far as needed to fit on screen.
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

    const sidebarRight = document.getElementById('sidebar')?.getBoundingClientRect().right ?? rect.right;
    // Beside the sidebar when there is room for it; otherwise as far right as the
    // window allows, which on a narrow window means overlapping — still better
    // than off-screen.
    const left = Math.max(margin, Math.min(sidebarRight + margin, viewportWidth - width - margin));

    popover.style.position = 'fixed';
    popover.style.width = `${width}px`;
    popover.style.left = `${left}px`;
    popover.style.right = 'auto';
    popover.style.maxHeight = `${Math.max(160, viewportHeight - 2 * margin)}px`;
    // Measured only once it is laid out at its final width, so the clamp below
    // works on the real height rather than a guess.
    popover.style.top = `${margin}px`;
    const height = popover.offsetHeight || 0;
    const top = Math.max(margin, Math.min(rect.top - 8, viewportHeight - height - margin));
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

    // A manual state is part of the filter's definition, so a wrong-length one is
    // as much a reason to refuse as an unstable denominator: running it would
    // silently pad or truncate the state the user carefully wrote.
    const manual = this._readManualFilterState(inspection.order);
    if (manual.code) {
        return { ok: false, code: manual.code, text: manual.text, inspection, manual };
    }

    const isFir = inspection.denominatorOrder === 0;
    const key = isFir ? 'dataToolFilterInfoFir' : 'dataToolFilterInfo';
    const text = i18n.t(key)
        .replace('{order}', String(inspection.order))
        .replace('{pole}', formatNumber(inspection.maxPoleRadius))
        .replace('{gain}', formatNumber(inspection.dcGain));
    return { ok: true, code: '', text, inspection, manual };
};

/**
 * The manual initial state, checked against the filter's order.
 * @returns {{ mode: string, state: number[], code: string, text: string }}
 */
proto._readManualFilterState = function(order) {
    const mode = document.getElementById('filter-init')?.value;
    const resolved = FILTER_INIT_MODES.has(mode) ? mode : 'steady';
    if (resolved !== 'manual') return { mode: resolved, state: [], code: '', text: '' };

    const raw = document.getElementById('filter-init-state')?.value ?? '';
    const parsed = parseCoefficients(raw);
    if (!parsed.values) {
        return {
            mode: resolved, state: [], code: 'dataToolFilterNotNumeric',
            text: i18n.t('dataToolFilterNotNumeric').replace('{token}', parsed.badToken),
        };
    }
    if (parsed.values.length !== order) {
        return {
            mode: resolved, state: parsed.values, code: 'dataToolFilterInitStateLength',
            // A global replace: the order appears twice in this sentence, and the
            // single-shot .replace() used everywhere else would leave the second
            // one as a literal placeholder.
            text: i18n.t(order === 1 ? 'dataToolFilterInitStateLengthOne' : 'dataToolFilterInitStateLength')
                .replace(/\{needed\}/g, String(order))
                .replace('{given}', String(parsed.values.length)),
        };
    }
    return { mode: resolved, state: parsed.values, code: '', text: '' };
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
            init: plan.manual.mode,
            initState: plan.manual.mode === 'manual' ? [...plan.manual.state] : [],
            restartGap: normalizeFilterRestartGap(document.getElementById('filter-restart-gap')?.value),
        },
    };
};

proto._syncFilterControls = function() {
    const info = document.getElementById('filter-info');
    const axisNote = document.getElementById('filter-axis-note');
    const hint = document.getElementById('filter-init-hint');
    const stateWrap = document.getElementById('filter-init-state-wrap');
    const selected = this._getSelectedDataTool() === 'filter';

    const initMode = document.getElementById('filter-init')?.value || 'steady';
    stateWrap?.classList.toggle('collapsed', initMode !== 'manual');

    if (!info) return;
    if (!selected) {
        info.textContent = '';
        info.classList.remove('invalid');
        if (axisNote) axisNote.textContent = '';
        if (hint) hint.hidden = true;
        return;
    }

    const plan = this._filterPlan();
    info.textContent = plan.text;
    info.classList.toggle('invalid', !plan.ok);

    // The manual-state complaint belongs under the field it is about, in red,
    // not only in the summary at the bottom of the panel.
    if (hint) {
        const wrong = plan.manual?.code === 'dataToolFilterInitStateLength'
            || (initMode === 'manual' && plan.manual?.code === 'dataToolFilterNotNumeric');
        hint.hidden = !wrong;
        hint.textContent = wrong ? plan.text : '';
    }
    document.getElementById('filter-init-state')?.classList
        .toggle('data-tool-input-invalid', !!hint && !hint.hidden);

    if (axisNote) {
        const note = this._filterAxisNote();
        axisNote.textContent = note;
    }
};

// Whether the source's time axis has a nominal step at all, using the same
// detector the integral kernel uses (utils/sampling-gaps.js). A filter is
// defined per sample, so an irregular axis does not stop it — but the cut-off
// then is not a frequency in the file's units, and that has to be said out loud
// rather than left for the user to discover from a result that looks fine.
proto._filterAxisNote = function() {
    const fileId = this.activeFileId;
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    const sourceName = document.getElementById('outlier-variable')?.value || '';
    const variable = sourceName ? data?.variables?.[sourceName] : null;
    if (!variable) return '';
    const time = this._resampleTimeContext?.(data);
    const values = time?.values;
    if (!values || values.length !== variable.data?.length || time.kind === 'index') return '';

    const info = detectSamplingGaps(values);
    if (!info.hasNominalStep) {
        return i18n.t(info.reason === 'nonMonotonic'
            ? 'dataToolFilterAxisBackwards'
            : 'dataToolFilterAxisIrregular');
    }
    if (info.count > 0) {
        return i18n.t(info.count === 1 ? 'dataToolFilterAxisGapsOne' : 'dataToolFilterAxisGaps')
            .replace('{count}', String(info.count))
            .replace('{missing}', String(info.totalMissing));
    }
    return '';
};

proto._filterDescription = function(params = {}) {
    const list = values => Array.from(values || []).map(value => Number(Number(value).toPrecision(6))).join(', ');
    const direction = params.mode === 'zeroPhase' ? 'zero phase' : 'forward';
    const parts = [`b [${list(params.b)}]`, `a [${list(params.a)}]`, direction];
    if (params.mode !== 'zeroPhase') {
        if (params.init === 'zero') parts.push('from rest');
        else if (params.init === 'manual') parts.push(`from state [${list(params.initState)}]`);
    }
    if (params.restartGap > 0) parts.push(`restart after gaps > ${params.restartGap} samples`);
    return parts.join('; ');
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
