// The range section of an analysis: ONE block, built here, used by every
// analysis there is.
//
// Every analysis reads a stretch of time, and every one of them asks for it the
// same way: a pair of buttons, **Full** or **Selection**, and under them the two
// bounds — a field to type the instant in, and a slider to drag it with. It was
// written nine times, and nine times it came out a little different: two
// analyses had no sliders at all, the tooltips did not match, one rounded the
// number in the field and another did not. So it lives here now, as one builder
// and one sync, and a new analysis gets the block by calling them rather than
// by copying it:
//
//     drawer.appendChild(this._buildAnalysisRangeSection({
//         prefix: 'trend',            // data-trend-key / data-trend-role
//         rangeFull: segment.rangeFull,
//         lo, hi, domain, calendar,
//         onMode: (full) => …,        // Full / Selection pressed
//         onType: (key, value) => …,  // the field was typed in (null: cleared)
//         onSlide: (key, value) => …, // the slider is being dragged
//         onCommit: (key, value) => …,// the drag ended
//     }));
//
// and keeps it in step with the state through `_syncAnalysisRangeSection`.
//
// `scripts/test-analysis-range.mjs` is the guard: it reads the sources and
// fails if an analysis builds the block by hand instead.

import i18n from '../../i18n/index.js';

// The two bounds, in the order they are drawn.
export const ANALYSIS_RANGE_BOUNDS = [
    { key: 'x1', labelKey: 'fftRangeStart', tooltipKey: 'analysisRangeStartTooltip' },
    { key: 'x2', labelKey: 'fftRangeEnd', tooltipKey: 'analysisRangeEndTooltip' },
];

/**
 * What the number field shows: a rounded value, since it is read at a glance
 * and the state keeps the full precision either way.
 */
export function formatAnalysisRangeValue(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    if (n !== 0 && Math.abs(n) < 0.01) return n.toExponential(2);
    return String(Number(n.toFixed(2)));
}

// A calendar axis stores epoch ms read as naive UTC, and the datetime-local
// pickers use the same convention, so a bound reads as its own tick label.
export function analysisRangeMsToInput(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n)) return '';
    const d = new Date(n);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 19);
}

export function analysisRangeInputToMs(text) {
    if (!text) return NaN;
    const ms = Date.parse(`${text}Z`);
    return Number.isFinite(ms) ? ms : NaN;
}

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

export function installPlotAnalysisRangeMethods(TargetClass) {
    const proto = TargetClass.prototype;

    /**
     * The range section, as a fragment to append where the analysis wants it.
     * `prefix` names the data attributes the analysis' own code looks the
     * controls up by (`data-<prefix>-key` and `data-<prefix>-role`).
     */
    proto._buildAnalysisRangeSection = function (spec = {}) {
        const {
            prefix,
            rangeFull = false,
            lo = null,
            hi = null,
            domain = null,
            calendar = false,
            fullTooltipKey = 'analysisRangeFullTooltip',
            selectionTooltipKey = 'analysisRangeSelectionTooltip',
            onMode = () => {},
            onType = () => {},
            onSlide = () => {},
            onCommit = () => {},
        } = spec;
        if (!prefix) throw new Error('_buildAnalysisRangeSection needs a prefix');
        const value = (key) => (key === 'x1' ? lo : hi);

        const fragment = document.createDocumentFragment();

        // Full / Selection.
        const segmented = document.createElement('div');
        segmented.className = 'fft-segmented analysis-range-segmented';
        for (const isFull of [true, false]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = i18n.t(isFull ? 'fftRangeFull' : 'fftRangeSelection');
            button.title = i18n.t(isFull ? fullTooltipKey : selectionTooltipKey);
            button.dataset.analysisRangeFull = String(isFull);
            button.dataset[`${prefix}RangeFull`] = String(isFull);
            const active = !!rangeFull === isFull;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
            button.addEventListener('click', (event) => {
                event.preventDefault();
                if (!!rangeFull === isFull) return;
                onMode(isFull);
            });
            segmented.appendChild(button);
        }
        fragment.appendChild(rangeRow(i18n.t('fftRange'), segmented, '', 'analysis-range-mode'));

        // The two bounds, each a field with its slider under it.
        const grid = document.createElement('div');
        grid.className = 'fft-range-grid analysis-range-grid';
        for (const bound of ANALYSIS_RANGE_BOUNDS) {
            const { key, labelKey, tooltipKey } = bound;
            const tooltip = i18n.t(tooltipKey);
            const wrap = document.createElement('div');
            wrap.className = 'fft-range-bound';
            if (calendar) wrap.classList.add('fft-range-bound-datetime');

            const field = document.createElement('input');
            field.type = calendar ? 'datetime-local' : 'number';
            field.step = calendar ? '1' : 'any';
            field.className = 'fft-number-input';
            field.dataset.analysisRangeKey = key;
            field.dataset.analysisRangeRole = 'input';
            field.dataset[`${prefix}Key`] = key;
            field.dataset[`${prefix}Role`] = 'input';
            field.disabled = !!rangeFull;
            field.value = calendar ? analysisRangeMsToInput(value(key)) : formatAnalysisRangeValue(value(key));
            field.addEventListener('change', () => {
                const n = calendar ? analysisRangeInputToMs(field.value) : Number(field.value);
                onType(key, finiteOrNull(n));
            });

            const slider = document.createElement('input');
            slider.type = 'range';
            slider.className = 'fft-range-input';
            slider.title = tooltip;
            slider.setAttribute('aria-label', `${i18n.t(labelKey)} — ${i18n.t('fftRange')}`);
            slider.dataset.analysisRangeKey = key;
            slider.dataset.analysisRangeRole = 'slider';
            slider.dataset[`${prefix}Key`] = key;
            slider.dataset[`${prefix}Role`] = 'slider';
            slider.disabled = !!rangeFull;
            if (domain && Number.isFinite(domain.min) && Number.isFinite(domain.max)) {
                slider.min = String(domain.min);
                slider.max = String(domain.max);
                slider.step = 'any';
            }
            if (Number.isFinite(Number(value(key)))) slider.value = String(Number(value(key)));
            slider.addEventListener('input', () => {
                onSlide(key, finiteOrNull(Number(slider.value)));
            });
            slider.addEventListener('change', () => {
                onCommit(key, finiteOrNull(Number(slider.value)));
            });

            wrap.append(rangeRow(i18n.t(labelKey), field, tooltip), slider);
            grid.appendChild(wrap);
        }
        fragment.appendChild(grid);
        return fragment;
    };

    /**
     * Put the state back on the controls: which mode is pressed, the two
     * values, and whether anything is editable at all. A control the user is
     * typing in or dragging is left alone unless `force` says otherwise (the
     * drag itself is what writes the state, and taking it over mid-drag is how
     * a slider jumps back under the finger).
     */
    proto._syncAnalysisRangeSection = function (root, spec = {}) {
        if (!root) return;
        const {
            prefix, rangeFull = false, lo = null, hi = null, domain = null, calendar = false,
            force = false,
            // 'slider' or 'input': that half is left alone, for the caller that
            // is already being driven by it.
            skipRole = null,
        } = spec;
        if (!prefix) throw new Error('_syncAnalysisRangeSection needs a prefix');
        const value = (key) => (key === 'x1' ? lo : hi);
        root.querySelectorAll('[data-analysis-range-full]').forEach((button) => {
            const isFull = button.dataset.analysisRangeFull === 'true';
            const active = !!rangeFull === isFull;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        root.querySelectorAll('[data-analysis-range-key]').forEach((input) => {
            const key = input.dataset.analysisRangeKey;
            const slider = input.dataset.analysisRangeRole === 'slider';
            input.disabled = !!rangeFull;
            if (skipRole && input.dataset.analysisRangeRole === skipRole) return;
            if (slider && domain && Number.isFinite(domain.min) && Number.isFinite(domain.max)) {
                input.min = String(domain.min);
                input.max = String(domain.max);
            }
            if (!force && document.activeElement === input) return;
            const current = Number(value(key));
            if (slider) {
                if (Number.isFinite(current)) input.value = String(current);
            } else {
                input.value = calendar ? analysisRangeMsToInput(current) : formatAnalysisRangeValue(current);
            }
        });
    };
}

function rangeRow(labelText, control, tooltip = '', extraClass = '') {
    const label = document.createElement('label');
    label.className = 'fft-option-row';
    if (extraClass) label.classList.add(extraClass);
    if (tooltip) label.title = tooltip;
    const span = document.createElement('span');
    span.textContent = labelText;
    label.append(span, control);
    return label;
}
