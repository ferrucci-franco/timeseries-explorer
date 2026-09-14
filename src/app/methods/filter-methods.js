// Panel side of the digital filter tool.
//
// The kernels (src/compute/kernels/iir.js, filter-design.js) own the
// mathematics and the verdict; what lives here is reading the form — a
// specification to design from, or two text boxes of coefficients — and, the
// part that matters, making the verdict VISIBLE and BINDING before anything runs. An unstable filter is not
// reported after the fact: the Create buttons go dead, the reason is spelled out
// under the coefficients, and the live preview stops drawing. There is no path
// through this panel that runs an unstable recursion over a user's data.

import i18n from '../../i18n/index.js';
import { designFilter, inspectFilter, inspectSos } from '../../compute/kernels/index.js';
import {
    FILTER_INIT_MODES,
    FILTER_MODES,
    filterInitStateLength,
    normalizeFilterRestartGap,
    parseCoefficients,
} from '../../compute/kernels/iir.js';
import { designedMagnitudeDb, normalizeFilterDesignOrder } from '../../compute/kernels/filter-design.js';
import { TIME_UNITS } from '../../utils/time-unit-format.js';

// The ids of the design fields, in the one list the parameter reset, the
// disabled sweep and the listeners all read from.
export const FILTER_DESIGN_FIELD_IDS = [
    'filter-source',
    'filter-design-family',
    'filter-design-response',
    'filter-design-order',
    'filter-design-order-slider',
    'filter-design-cutoff',
    'filter-design-cutoff-high',
    'filter-design-ripple',
    'filter-design-attenuation',
];

// A declared axis unit that IS a time unit gets its cut-off in hertz; anything
// else is honest about being cycles per unit. 'us' is what a file that cannot
// type µ writes.
const TIME_UNIT_SECONDS = new Map([
    ...TIME_UNITS.map(unit => [unit.suffix, unit.factor]),
    ['sec', 1], ['seconds', 1], ['us', 1e-6], ['hours', 3600], ['hr', 3600], ['days', 86400], ['minutes', 60],
]);

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
    for (const id of ['filter-mode', 'filter-init', 'filter-init-level',
        'filter-init-x', 'filter-init-y', 'filter-restart-gap']) {
        document.getElementById(id)?.addEventListener('change', () => this._handleDataToolOptionChange());
    }
    for (const id of ['filter-init-level', 'filter-init-x', 'filter-init-y']) {
        document.getElementById(id)?.addEventListener('input', () => this._syncFilterControls());
    }
    document.getElementById('filter-help-toggle')?.addEventListener('click', (event) => {
        event.stopPropagation();
        this._toggleFilterHelpPopover();
    });
    document.getElementById('filter-init-help-toggle')?.addEventListener('click', (event) => {
        event.stopPropagation();
        this._toggleFilterInitHelpPopover();
    });
    document.getElementById('filter-gap-help-toggle')?.addEventListener('click', (event) => {
        event.stopPropagation();
        this._toggleFilterGapHelpPopover();
    });
    document.getElementById('filter-direction-help-toggle')?.addEventListener('click', (event) => {
        event.stopPropagation();
        this._toggleFilterDirectionHelpPopover();
    });

    // The design fields. Selects commit at once; the numbers commit on change
    // (blur/Enter) like the coefficients, and merely refresh the summary while
    // being typed, so a half-typed "5" on the way to "50" does not run a preview
    // with the wrong cut-off. The order slider is live, as the detrend sliders are.
    for (const id of ['filter-source', 'filter-design-family', 'filter-design-response']) {
        document.getElementById(id)?.addEventListener('change', () => this._handleDataToolOptionChange());
    }
    for (const id of ['filter-design-cutoff', 'filter-design-cutoff-high', 'filter-design-ripple', 'filter-design-attenuation', 'filter-design-order']) {
        document.getElementById(id)?.addEventListener('change', () => this._handleDataToolOptionChange());
        document.getElementById(id)?.addEventListener('input', () => this._syncFilterControls());
    }
    document.getElementById('filter-design-order-slider')?.addEventListener('input', (event) => {
        const numeric = document.getElementById('filter-design-order');
        if (numeric) numeric.value = event.target.value;
        this._handleDataToolOptionChange();
    });
    document.getElementById('filter-design-help-toggle')?.addEventListener('click', (event) => {
        event.stopPropagation();
        this._toggleFilterDesignHelpPopover();
    });
};

proto._toggleFilterDesignHelpPopover = function(show) {
    const popover = document.getElementById('filter-design-help-popover');
    const button = document.getElementById('filter-design-help-toggle');
    if (!popover || !button) return;
    const willShow = typeof show === 'boolean' ? show : popover.hidden;
    popover.hidden = !willShow;
    button.classList.toggle('active', willShow);
    button.setAttribute('aria-expanded', String(willShow));
    if (willShow) this._positionFilterHelpPopover(popover, button);
};

// The values one box actually wants, spelled out. Fixed text cannot do it — a
// first-order filter needs a different list from a third-order one.
function pastSamplesPlaceholder(symbol, order) {
    if (!(order > 0)) return '';
    return order <= 3
        ? Array.from({ length: order }, (_, i) => `${symbol}[−${i + 1}]`).join(', ')
        : `${symbol}[−1] … ${symbol}[−${order}]`;
}

proto._clearManualFilterState = function() {
    for (const id of ['filter-init-level', 'filter-init-x', 'filter-init-y']) {
        const input = document.getElementById(id);
        if (input) input.value = '';
    }
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

proto._toggleFilterDirectionHelpPopover = function(show) {
    const popover = document.getElementById('filter-direction-help-popover');
    const button = document.getElementById('filter-direction-help-toggle');
    if (!popover || !button) return;
    const willShow = typeof show === 'boolean' ? show : popover.hidden;
    popover.hidden = !willShow;
    button.classList.toggle('active', willShow);
    button.setAttribute('aria-expanded', String(willShow));
    if (willShow) this._positionFilterHelpPopover(popover, button);
};

proto._toggleFilterGapHelpPopover = function(show) {
    const popover = document.getElementById('filter-gap-help-popover');
    const button = document.getElementById('filter-gap-help-toggle');
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
    // The viewport may report zero on a window that is offscreen or has not
    // composited yet. Where it does, the honest answer is "unknown", not a made-up
    // number: an invented width both shrinks the popover and drags it left over
    // the very controls it is explaining. Unknown means skip the clamp instead.
    const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
    const width = viewportWidth
        ? Math.max(300, Math.min(600, viewportWidth - 2 * margin))
        : 600;

    const sidebarRight = document.getElementById('sidebar')?.getBoundingClientRect().right ?? rect.right;
    // Beside the sidebar, which is what keeps it clear of the filter's controls.
    // Only a viewport we actually measured may pull it back left, and on a window
    // too narrow for that it overlaps — still better than opening off-screen.
    const preferred = sidebarRight + margin;
    const left = viewportWidth
        ? Math.max(margin, Math.min(preferred, viewportWidth - width - margin))
        : preferred;

    popover.style.position = 'fixed';
    popover.style.width = `${width}px`;
    popover.style.left = `${left}px`;
    popover.style.right = 'auto';
    if (viewportHeight) popover.style.maxHeight = `${Math.max(160, viewportHeight - 2 * margin)}px`;
    else popover.style.maxHeight = '';
    // Measured only once it is laid out at its final width, so the clamp below
    // works on the real height rather than a guess.
    popover.style.top = `${margin}px`;
    const height = popover.offsetHeight || 0;
    const top = viewportHeight
        ? Math.max(margin, Math.min(rect.top - 8, viewportHeight - height - margin))
        : Math.max(margin, rect.top - 8);
    popover.style.top = `${top}px`;
    if (viewportHeight) popover.style.maxHeight = `${Math.max(160, viewportHeight - top - margin)}px`;
};

// ─── Reading the form ─────────────────────────────────────────────────────

// Where the coefficients come from. A markup without the selector (the tests'
// minimal document) is the typed-coefficients tool as it always was.
proto._filterSource = function() {
    return document.getElementById('filter-source')?.value === 'design' ? 'design' : 'manual';
};

proto._readFilterDesign = function() {
    const read = id => document.getElementById(id)?.value;
    // An empty box is a cut-off not yet typed, which is a different complaint
    // from a zero — and Number('') is 0.
    const number = value => (value === '' || value === undefined || value === null ? NaN : Number(value));
    const response = read('filter-design-response');
    const cutoff = [number(read('filter-design-cutoff'))];
    if (response === 'bandpass' || response === 'bandstop') cutoff.push(number(read('filter-design-cutoff-high')));
    const orderField = read('filter-design-order');
    return {
        family: read('filter-design-family'),
        response,
        order: normalizeFilterDesignOrder(orderField === '' || orderField === undefined ? read('filter-design-order-slider') : orderField),
        cutoff,
        rippleDb: Number(read('filter-design-ripple')),
        attenuationDb: Number(read('filter-design-attenuation')),
    };
};

/**
 * The sample rate a designed filter is designed against, read off the source
 * variable's time axis. The cut-off's unit follows from the axis: hertz for a
 * calendar axis or a numeric axis in a time unit, cycles per sample for an
 * index axis, and cycles per axis unit when the file declared something else.
 *
 * An axis without a nominal step is a refusal, not a caution: a cut-off in
 * hertz on unevenly spaced samples describes nothing, and the manual tool is
 * there for anyone who wants to run a per-sample filter regardless.
 *
 * @returns {{ ok: boolean, code: string, sampleRate: number, unit: string,
 *   kind: string, medianDt: number, gapCount: number, totalMissing: number }}
 */
proto._filterDesignRate = function() {
    const blank = { ok: false, code: '', sampleRate: NaN, unit: '', kind: '', medianDt: NaN, gapCount: 0, totalMissing: 0 };
    const fileId = this.activeFileId;
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    const sourceName = document.getElementById('outlier-variable')?.value || '';
    const variable = sourceName ? data?.variables?.[sourceName] : null;
    if (!variable) return { ...blank, code: 'dataToolFilterDesignNoSource' };
    const time = this._resampleTimeContext?.(data);
    const length = variable.data?.length || 0;
    const values = time?.values && time.values.length === length ? time.values : null;

    if (!values || time.kind === 'index') {
        return { ...blank, ok: true, sampleRate: 1, unit: i18n.t('dataToolFilterDesignUnitCyclesPerSample'), kind: 'index', medianDt: 1 };
    }
    // Measured once per axis (`_axisStepInfo`): this runs on every sync of
    // the panel, and on a long file the measurement is what the user waits for.
    const info = this._axisStepInfo(values);
    if (!info.hasNominalStep || !(info.medianDt > 0)) {
        return {
            ...blank,
            code: info.reason === 'nonMonotonic' ? 'dataToolFilterDesignBackwards' : 'dataToolFilterDesignIrregular',
            kind: time.kind,
            medianDt: info.medianDt,
        };
    }
    let secondsPerUnit = NaN;
    let declared = '';
    if (time.kind === 'datetime') {
        secondsPerUnit = 1e-3;
    } else {
        declared = time.variable?.description ? (this.plotManager?._extractUnit?.(time.variable.description) || '') : '';
        const known = TIME_UNIT_SECONDS.get(declared.trim());
        if (known) secondsPerUnit = known;
    }
    const inSeconds = Number.isFinite(secondsPerUnit);
    const sampleRate = inSeconds ? 1 / (info.medianDt * secondsPerUnit) : 1 / info.medianDt;
    const unit = inSeconds
        ? i18n.t('dataToolFilterDesignUnitHz')
        : i18n.t('dataToolFilterDesignUnitPerAxis').replace('{unit}', declared || i18n.t('dataToolResampleUnitAxis'));
    return {
        ok: true,
        code: '',
        sampleRate,
        unit,
        kind: time.kind,
        medianDt: info.medianDt,
        gapCount: info.count,
        totalMissing: info.totalMissing,
    };
};

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
    if (this._filterSource() === 'design') return this._filterDesignPlan();
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
 * The design-mode plan: the same { ok, code, text, inspection } contract, with
 * the designed sections, the polynomial for display and the specification
 * (including the sample rate it was designed against) carried on `inspection`.
 */
proto._filterDesignPlan = function() {
    const rate = this._filterDesignRate();
    if (!rate.ok) {
        return { ok: false, code: rate.code, text: i18n.t(rate.code), inspection: null, rate, source: 'design' };
    }
    const spec = this._readFilterDesign();
    let designed;
    try {
        designed = designFilter({ ...spec, sampleRate: rate.sampleRate });
    } catch (err) {
        const code = err?.code || 'dataToolFilterDesignCutoffMissing';
        const text = i18n.t(code)
            .replace('{nyquist}', formatNumber(rate.sampleRate / 2))
            .replace('{unit}', rate.unit);
        return { ok: false, code, text, inspection: null, rate, source: 'design' };
    }
    const inspection = inspectSos(designed.sos);
    if (!inspection.stable) {
        // Cannot happen for these families at the orders the panel allows — the
        // prototypes are stable by construction and the bilinear map preserves
        // that — but the gate is the gate.
        return { ok: false, code: 'dataToolFilterUnstable', text: i18n.t('dataToolFilterUnstable'), inspection, rate, source: 'design' };
    }
    const manual = this._readManualFilterState(inspection.order);
    if (manual.code) {
        return { ok: false, code: manual.code, text: manual.text, inspection, manual, rate, source: 'design' };
    }
    const design = { ...designed.design, sampleRate: rate.sampleRate, unit: rate.unit };
    const gains = design.cutoff.map(f => formatDb(designedMagnitudeDb(designed.sos, f, rate.sampleRate)));
    const text = i18n.t('dataToolFilterDesignInfo')
        .replace('{family}', i18n.t(FAMILY_KEYS[design.family]))
        .replace('{response}', i18n.t(RESPONSE_KEYS[design.response]).toLowerCase())
        .replace('{order}', String(inspection.order))
        .replace('{gain}', gains.join(' / '))
        .replace('{cutoff}', design.cutoff.map(formatNumber).join(' – '))
        .replace('{unit}', rate.unit);
    return {
        ok: true,
        code: '',
        text,
        inspection: { ...inspection, sos: designed.sos, design, designedB: designed.b, designedA: designed.a },
        manual,
        rate,
        source: 'design',
    };
};

/**
 * The typed initial conditions, checked against what the chosen convention needs.
 *
 * `state` is flattened to [x…, y…] for the kernel, which is the order the filtic
 * conversion expects; the panel keeps the two histories in separate fields
 * because they are separate quantities and their order should be visible rather
 * than remembered.
 *
 * @returns {{ mode, state: number[], code: string, text: string, levelText, pastText }}
 */
proto._readManualFilterState = function(order) {
    const mode = document.getElementById('filter-init')?.value;
    const resolved = FILTER_INIT_MODES.has(mode) ? mode : 'steady';
    const blank = { mode: resolved, state: [], code: '', text: '', levelText: '', pastText: '' };
    if (!filterInitStateLength(resolved, order)) return blank;

    // The counts appear more than once in these sentences, so every substitution
    // here is global; the single-shot .replace() used elsewhere would leave the
    // later ones as literal placeholders.
    const fill = (key, given) => i18n.t(key)
        .replace(/\{order\}/g, String(order))
        .replace(/\{given\}/g, String(given));

    const read = (id) => {
        const parsed = parseCoefficients(document.getElementById(id)?.value ?? '');
        return parsed;
    };

    if (resolved === 'level') {
        const parsed = read('filter-init-level');
        if (!parsed.values) {
            const text = i18n.t('dataToolFilterNotNumeric').replace('{token}', parsed.badToken);
            return { ...blank, code: 'dataToolFilterNotNumeric', text, levelText: text };
        }
        if (parsed.values.length !== 1) {
            const text = fill('dataToolFilterInitLevelLength', parsed.values.length);
            return { ...blank, state: parsed.values, code: 'dataToolFilterInitStateLength', text, levelText: text };
        }
        return { ...blank, state: parsed.values };
    }

    const xs = read('filter-init-x');
    const ys = read('filter-init-y');
    const bad = !xs.values ? xs : (!ys.values ? ys : null);
    if (bad) {
        const text = i18n.t('dataToolFilterNotNumeric').replace('{token}', bad.badToken);
        return { ...blank, code: 'dataToolFilterNotNumeric', text, pastText: text };
    }
    // Each box is counted in its own terms and named, so the message points at
    // the field that is actually wrong instead of at a combined total.
    const wrong = xs.values.length !== order
        ? fill('dataToolFilterInitPastLengthX', xs.values.length)
        : (ys.values.length !== order ? fill('dataToolFilterInitPastLengthY', ys.values.length) : '');
    if (wrong) {
        return {
            ...blank,
            state: [...xs.values, ...ys.values],
            code: 'dataToolFilterInitStateLength',
            text: wrong,
            pastText: wrong,
        };
    }
    return { ...blank, state: [...xs.values, ...ys.values] };
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
    const params = {
        source: plan.source === 'design' ? 'design' : 'manual',
        // Stored NORMALIZED (a₀ = 1, both lists the same length), so a saved
        // session reproduces exactly the recursion that ran, not the text
        // that happened to be in the box.
        b: Array.from(plan.inspection.b),
        a: Array.from(plan.inspection.a),
        mode: FILTER_MODES.has(mode) ? mode : 'forward',
        init: plan.manual.mode,
        initState: [...plan.manual.state],
        restartGap: normalizeFilterRestartGap(document.getElementById('filter-restart-gap')?.value),
    };
    if (plan.source === 'design') {
        // The sections are what runs; the specification (with the sample rate
        // it was designed against) is what the panel reopens with; b and a are
        // the expanded polynomial, kept for display and for the definition's
        // description. Past samples cannot initialise a cascade — see the
        // kernel — so a designed filter never stores that convention.
        params.sos = plan.inspection.sos.map(section => Array.from(section));
        params.design = { ...plan.inspection.design, cutoff: [...plan.inspection.design.cutoff] };
        if (params.init === 'past') { params.init = 'steady'; params.initState = []; }
    }
    return { tool: 'filter', params };
};

proto._syncFilterControls = function() {
    const info = document.getElementById('filter-info');
    const axisNote = document.getElementById('filter-axis-note');
    const levelHint = document.getElementById('filter-init-level-hint');
    const pastHint = document.getElementById('filter-init-past-hint');
    const selected = this._getSelectedDataTool() === 'filter';
    const design = this._filterSource() === 'design';

    this._syncFilterDesignControls(design, selected);

    // A cascade has no single past to be initialised from, so the option is
    // withdrawn — and a selection made before switching modes falls back to the
    // default rather than silently meaning something else.
    const initSelect = document.getElementById('filter-init');
    const pastOption = initSelect?.querySelector?.('option[value="past"]');
    if (pastOption) pastOption.disabled = design;
    if (design && initSelect?.value === 'past') initSelect.value = 'steady';
    const initMode = initSelect?.value || 'steady';
    // Each convention shows only its own fields.
    document.getElementById('filter-init-level-wrap')?.classList.toggle('collapsed', initMode !== 'level');
    document.getElementById('filter-init-past-wrap')?.classList.toggle('collapsed', initMode !== 'past');

    // The placeholders track the coefficients, so each box always names exactly
    // the values it wants for the filter currently in the fields above.
    const b = parseCoefficients(document.getElementById('filter-b')?.value ?? '1');
    const a = parseCoefficients(document.getElementById('filter-a')?.value ?? '1');
    const order = b.values && a.values
        ? Math.max(1, Math.max(b.values.length, a.values.length)) - 1
        : 0;
    const xInput = document.getElementById('filter-init-x');
    const yInput = document.getElementById('filter-init-y');
    if (xInput) xInput.placeholder = pastSamplesPlaceholder('x', order);
    if (yInput) yInput.placeholder = pastSamplesPlaceholder('y', order);

    const markHint = (hint, text, inputs) => {
        if (hint) {
            hint.hidden = !text;
            hint.textContent = text || '';
        }
        for (const input of inputs) {
            input?.classList.toggle('data-tool-input-invalid', !!text);
        }
    };

    if (!info) return;
    if (!selected) {
        info.textContent = '';
        info.classList.remove('invalid');
        if (axisNote) axisNote.textContent = '';
        markHint(levelHint, '', [document.getElementById('filter-init-level')]);
        markHint(pastHint, '', [xInput, yInput]);
        return;
    }

    const plan = this._filterPlan();
    info.textContent = plan.text;
    info.classList.toggle('invalid', !plan.ok);

    // The designed coefficients land in the boxes for reading and copying. Set
    // programmatically, so the boxes' own change listeners (which would clear a
    // typed state and rerun the preview) do not fire.
    if (design) {
        const bBox = document.getElementById('filter-b');
        const aBox = document.getElementById('filter-a');
        if (plan.ok && plan.inspection) {
            if (bBox) bBox.value = formatCoefficientList(plan.inspection.designedB);
            if (aBox) aBox.value = formatCoefficientList(plan.inspection.designedA);
        }
    }
    const cutoffInvalid = design && !plan.ok && plan.code.startsWith('dataToolFilterDesign') && plan.code !== 'dataToolFilterDesignNoSource'
        && plan.code !== 'dataToolFilterDesignIrregular' && plan.code !== 'dataToolFilterDesignBackwards';
    document.getElementById('filter-design-cutoff')?.classList.toggle('data-tool-input-invalid', cutoffInvalid);
    document.getElementById('filter-design-cutoff-high')?.classList.toggle('data-tool-input-invalid', cutoffInvalid && plan.code === 'dataToolFilterDesignBandOrder');

    // A complaint about a history belongs under the boxes it is about, in red,
    // not only in the summary at the bottom of the panel.
    markHint(levelHint, plan.manual?.levelText || '', [document.getElementById('filter-init-level')]);
    markHint(pastHint, plan.manual?.pastText || '', [xInput, yInput]);

    if (axisNote) {
        // In design mode an irregular axis is already the summary's verdict;
        // repeating it here as a caution would contradict the refusal above it.
        const note = design && !plan.ok ? '' : this._filterAxisNote();
        axisNote.textContent = note;
    }
};

// The design fields: which of them show, what unit the cut-offs are in, and
// the sample rate line beneath them.
proto._syncFilterDesignControls = function(design, selected) {
    document.getElementById('filter-design-wrap')?.classList.toggle('collapsed', !design);
    const family = document.getElementById('filter-design-family')?.value || 'butterworth';
    const response = document.getElementById('filter-design-response')?.value || 'lowpass';
    const band = response === 'bandpass' || response === 'bandstop';
    document.getElementById('filter-design-cutoff-high-wrap')?.classList.toggle('collapsed', !band);
    document.getElementById('filter-design-ripple-wrap')?.classList.toggle('collapsed', family !== 'chebyshev1');
    document.getElementById('filter-design-attenuation-wrap')?.classList.toggle('collapsed', family !== 'chebyshev2');

    const cutoffLabel = document.getElementById('filter-design-cutoff-label');
    if (cutoffLabel) cutoffLabel.textContent = i18n.t(band ? 'dataToolFilterDesignCutoffLow' : 'dataToolFilterDesignCutoff');

    // Slider and number are one control seen twice.
    const orderInput = document.getElementById('filter-design-order');
    const orderSlider = document.getElementById('filter-design-order-slider');
    const orderValue = document.getElementById('filter-design-order-value');
    if (orderInput && orderSlider) {
        const normalized = normalizeFilterDesignOrder(orderInput.value === '' ? orderSlider.value : orderInput.value);
        if (orderInput.value === '') orderInput.value = String(normalized);
        orderSlider.value = String(normalized);
        if (orderValue) orderValue.textContent = String(normalized);
    }

    // The coefficient boxes are read-only while a design owns them.
    for (const id of ['filter-b', 'filter-a']) {
        const box = document.getElementById(id);
        if (box) box.readOnly = design;
    }

    const rateLine = document.getElementById('filter-design-rate');
    const unitLabels = [document.getElementById('filter-design-cutoff-unit'), document.getElementById('filter-design-cutoff-high-unit')];
    if (!design || !selected) {
        if (rateLine) { rateLine.textContent = ''; rateLine.classList.remove('invalid'); }
        return;
    }
    const rate = this._filterDesignRate();
    for (const label of unitLabels) {
        if (label) label.textContent = rate.ok ? rate.unit : i18n.t('dataToolFilterDesignUnitHz');
    }
    if (!rateLine) return;
    if (!rate.ok) {
        rateLine.textContent = rate.code === 'dataToolFilterDesignNoSource' ? '' : i18n.t(rate.code);
        rateLine.classList.toggle('invalid', rate.code !== 'dataToolFilterDesignNoSource');
        return;
    }
    rateLine.classList.remove('invalid');
    const key = rate.kind === 'index' ? 'dataToolFilterDesignRateIndex' : 'dataToolFilterDesignRate';
    rateLine.textContent = i18n.t(key)
        .replace('{rate}', formatNumber(rate.sampleRate))
        .replace('{nyquist}', formatNumber(rate.sampleRate / 2))
        .replace(/\{unit\}/g, rate.unit);
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

    const info = this._axisStepInfo(values);
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
    const parts = [];
    if (params.source === 'design' && params.design) {
        const d = params.design;
        const family = FAMILY_NAMES[d.family] || d.family;
        const response = RESPONSE_NAMES[d.response] || d.response;
        const cutoff = (d.cutoff || []).map(value => Number(Number(value).toPrecision(6))).join('–');
        const unit = d.unit || 'Hz';
        let extra = '';
        if (d.family === 'chebyshev1') extra = `, ripple ${Number(Number(d.rippleDb).toPrecision(4))} dB`;
        if (d.family === 'chebyshev2') extra = `, attenuation ${Number(Number(d.attenuationDb).toPrecision(4))} dB`;
        parts.push(`${family} ${response}, order ${d.order}, ${cutoff} ${unit}${extra}`);
        parts.push(direction);
    } else {
        parts.push(`b [${list(params.b)}]`, `a [${list(params.a)}]`, direction);
    }
    if (params.mode !== 'zeroPhase') {
        if (params.init === 'zero') parts.push('from rest');
        else if (params.init === 'level') parts.push(`from level ${list(params.initState)}`);
        else if (params.init === 'past') parts.push(`from past samples [${list(params.initState)}]`);
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

function formatDb(value) {
    if (!Number.isFinite(value)) return '−∞ dB';
    const rounded = Math.round(value * 100) / 100;
    return `${rounded === 0 ? '0' : String(rounded).replace('-', '−')} dB`;
}

// Enough digits that the polynomial pasted elsewhere is the polynomial that was
// designed, in the same comma-separated form the boxes accept back.
function formatCoefficientList(values) {
    return Array.from(values || []).map(value => {
        const n = Number(value);
        if (Math.abs(n) < 1e-300) return '0';
        return String(Number(n.toPrecision(15)));
    }).join(', ');
}

// Translation keys for the summary line, and plain English for the
// description a definition carries (descriptions are not translated).
const FAMILY_KEYS = {
    butterworth: 'dataToolFilterDesignButterworthShort',
    chebyshev1: 'dataToolFilterDesignChebyshev1Short',
    chebyshev2: 'dataToolFilterDesignChebyshev2Short',
    bessel: 'dataToolFilterDesignBesselShort',
};
const RESPONSE_KEYS = {
    lowpass: 'dataToolFilterDesignLowpass',
    highpass: 'dataToolFilterDesignHighpass',
    bandpass: 'dataToolFilterDesignBandpass',
    bandstop: 'dataToolFilterDesignBandstopShort',
};
const FAMILY_NAMES = { butterworth: 'Butterworth', chebyshev1: 'Chebyshev I', chebyshev2: 'Chebyshev II', bessel: 'Bessel' };
const RESPONSE_NAMES = { lowpass: 'low-pass', highpass: 'high-pass', bandpass: 'band-pass', bandstop: 'band-stop' };
