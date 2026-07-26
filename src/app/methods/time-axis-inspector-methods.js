import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';
import { TIME_AXIS_VARIABLE_KINDS } from './derived-methods.js';
import {
    TIME_AXIS_GAP_FACTOR,
    computeTimeAxisDiagnostics,
    finalizeTimeAxisDiagnostics,
    mergeTimeAxisSteps,
} from '../../data/time-axis-diagnostics.js';

// ─── Time-axis inspector ──────────────────────────────────────────────────────
// One dialog, three doors: the button in the file's "Time axis" panel, the clock
// button on the time-axis row in the tree, and dragging the time axis onto a
// plot. All three do exactly the same thing, which is why the drag no longer
// plots anything — a gesture must not mean something different from a button.
//
// The dialog has two halves:
//   · the diagnostic — is this series equidistant, and if not, where does it
//     break? Exact, even for lazy files (a DuckDB pass over the whole column).
//   · the checkboxes — materialize the sample index and/or the Δt signal as
//     derived variables. Those come from the loaded overview on lazy files, so
//     the trace is indicative while the numbers above it are not.
//
// Nothing is ever computed on its own: a lazy diagnostic runs only when the user
// opens the dialog, because DuckDB serializes queries on one connection and a
// full-column scan started from a sidebar re-render would stall pan and zoom.

export function installTimeAxisInspectorMethods(TargetClass) {
    const proto = TargetClass.prototype;

// Cache key: the diagnostic describes the axis AFTER the file transform, so a
// crop, a shift or a reindex invalidates it. Live-appended rows do too.
proto._timeAxisDiagnosticsKey = function(fileId) {
    const entry = this.plotManager.files.get(fileId);
    const data = entry?.data;
    if (!data) return null;
    const transform = entry.transform || {};
    const timeVar = this._getActiveTimeVar(data);
    return JSON.stringify([
        fileId,
        timeVar?.name || '',
        timeVar?.timeKind || '',
        timeVar?.data?.length || 0,
        transform.timeDisplayMode || '',
        transform.timeStepMode || '',
        transform.customTimeStep || '',
        transform.cropStart ?? null,
        transform.cropEnd ?? null,
        transform.timeShift ?? 0,
    ]);
};

proto._cachedTimeAxisDiagnostics = function(fileId) {
    const key = this._timeAxisDiagnosticsKey(fileId);
    if (!key) return null;
    const cached = this.timeAxisDiagnosticsCache?.get(fileId);
    return cached && cached.key === key ? cached.value : null;
};

proto._storeTimeAxisDiagnostics = function(fileId, value) {
    const key = this._timeAxisDiagnosticsKey(fileId);
    if (!key) return;
    if (!this.timeAxisDiagnosticsCache) this.timeAxisDiagnosticsCache = new Map();
    this.timeAxisDiagnosticsCache.set(fileId, { key, value });
};

// Eager files: one in-memory pass, cheap enough to run inline and cache.
proto._computeEagerTimeAxisDiagnostics = function(fileId) {
    const data = this.plotManager.files.get(fileId)?.data;
    const timeVar = data ? this._getActiveTimeVar(data) : null;
    if (!timeVar?.data?.length) return null;
    const diagnostics = computeTimeAxisDiagnostics(timeVar.data, this._timeAxisSecondsScale(timeVar));
    this._storeTimeAxisDiagnostics(fileId, diagnostics);
    return diagnostics;
};

// What the file's panel shows without asking for anything: the eager verdict,
// or a lazy one only once the user has opened the inspector at least once.
proto._timeAxisDiagnosticsForPanel = function(fileId) {
    const cached = this._cachedTimeAxisDiagnostics(fileId);
    if (cached) return cached;
    const data = this.plotManager.files.get(fileId)?.data;
    if (!data || data._duckdb) return null;
    return this._computeEagerTimeAxisDiagnostics(fileId);
};

// Lazy files: phase 1 (no sort) lands first and is reported through onPartial;
// phase 2 (ORDER BY, the expensive half) completes the verdict. Both share the
// abort signal, so cancelling keeps whatever phase 1 already produced.
proto._computeLazyTimeAxisDiagnostics = async function(fileId, { signal, onPartial } = {}) {
    const data = this.plotManager.files.get(fileId)?.data;
    const source = data?._duckdb?.source;
    if (!source?.getTimeAxisSummary) return null;
    const scale = this._timeAxisSecondsScale(this._getActiveTimeVar(data));

    const raw = await source.getTimeAxisSummary(data, { signal });
    const partial = finalizeTimeAxisDiagnostics(raw, scale);
    onPartial?.(partial);

    const gapThreshold = Number.isFinite(partial.dtMean) && raw.intervals > 0
        ? ((raw.tMax - raw.tMin) / raw.intervals) * TIME_AXIS_GAP_FACTOR
        : NaN;
    const steps = await source.getTimeAxisSteps(data, { gapThreshold, signal });
    const complete = finalizeTimeAxisDiagnostics(mergeTimeAxisSteps(raw, steps), scale);
    this._storeTimeAxisDiagnostics(fileId, complete);
    return complete;
};

// ─── Formatting ───────────────────────────────────────────────────────────────

// Seconds ladder. A sampling step reads as "1 ms", never as "1.000e-3 s".
const TIME_AXIS_UNITS = [
    { factor: 86400, suffix: 'd' },
    { factor: 3600, suffix: 'h' },
    { factor: 60, suffix: 'min' },
    { factor: 1, suffix: 's' },
    { factor: 1e-3, suffix: 'ms' },
    { factor: 1e-6, suffix: 'µs' },
    { factor: 1e-9, suffix: 'ns' },
];

// One unit for a whole group of values, picked from the largest of them. Choosing
// per value is what used to print "0 s / 1.000e-3 s / 0.001 s" — three notations
// in one row for numbers that straddle a threshold.
proto._timeAxisUnit = function(values, unitless = false) {
    if (unitless) return { factor: 1, suffix: '' };
    const magnitudes = values.filter(Number.isFinite).map(Math.abs).filter(value => value > 0);
    if (!magnitudes.length) return { factor: 1, suffix: 's' };
    const largest = Math.max(...magnitudes);
    return TIME_AXIS_UNITS.find(unit => largest >= unit.factor)
        || TIME_AXIS_UNITS[TIME_AXIS_UNITS.length - 1];
};

// Six significant digits, trailing zeros trimmed: enough to tell 1 ms from
// 0.99995 ms without rounding the difference away.
proto._formatTimeAxisValue = function(value, unit) {
    if (!Number.isFinite(value)) return '—';
    const scaled = value / unit.factor;
    const text = scaled === 0 ? '0' : String(Number(scaled.toPrecision(6)));
    return unit.suffix ? `${text} ${unit.suffix}` : text;
};

// A span is a duration, not a magnitude: nobody reads "70.9896 d". Past a minute
// it gets the app's compound duration form ("70 d 23 h 45 min") — the same one
// the measurement cursor uses for Δx — and below that the single-unit ladder,
// where "20 s" or "100 µs" already reads naturally.
proto._formatTimeAxisSpan = function(value, unitless = false) {
    if (!Number.isFinite(value)) return '—';
    if (!unitless && Math.abs(value) >= 60 && this.plotManager?._formatDuration) {
        return this.plotManager._formatDuration(value, 's');
    }
    return this._formatTimeAxisValue(value, this._timeAxisUnit([value], unitless));
};

// "1 repeated time" / "3 repeated times", for the anomalies that are non-zero.
// Listing "0 gaps" is noise: absence of a problem does not need a number.
proto._timeAxisAnomalyPhrases = function(diagnostics) {
    const phrases = [];
    const add = (count, oneKey, manyKey) => {
        if (!count) return;
        phrases.push(count === 1
            ? i18n.t(oneKey)
            : i18n.t(manyKey).replace('{n}', String(count)));
    };
    add(diagnostics.repeated, 'timeAxisCountRepeatedOne', 'timeAxisCountRepeatedMany');
    add(diagnostics.gaps, 'timeAxisCountGapsOne', 'timeAxisCountGapsMany');
    add(diagnostics.backwards, 'timeAxisCountBackwardsOne', 'timeAxisCountBackwardsMany');
    return phrases;
};

// The one-line verdict under the panel button.
proto._timeAxisSummaryLine = function(diagnostics) {
    if (!diagnostics) return '';
    const n = diagnostics.nSamples;
    if (!n) return i18n.t('timeAxisSummaryEmpty');
    const unitless = diagnostics.unitless;

    if (diagnostics.verdict === null) {
        return i18n.t('timeAxisSummaryPartial')
            .replace('{n}', String(n))
            .replace('{span}', this._formatTimeAxisSpan(diagnostics.span, unitless));
    }

    const uniform = diagnostics.verdict !== 'irregular';
    const unit = this._timeAxisUnit(
        uniform ? [diagnostics.dtMean] : [diagnostics.dtMin, diagnostics.dtMax],
        unitless,
    );
    const step = uniform
        ? this._formatTimeAxisValue(diagnostics.dtMean, unit)
        : `${this._formatTimeAxisValue(diagnostics.dtMin, unit)}–${this._formatTimeAxisValue(diagnostics.dtMax, unit)}`;
    const anomalies = this._timeAxisAnomalyPhrases(diagnostics);
    if (!anomalies.length) {
        return i18n.t('timeAxisSummaryEquidistant')
            .replace('{n}', String(n))
            .replace('{dt}', step);
    }
    return i18n.t('timeAxisSummaryAnomalies')
        .replace('{n}', String(n))
        .replace('{dt}', step)
        .replace('{anomalies}', anomalies.join(', '));
};

// ─── The dialog ───────────────────────────────────────────────────────────────

proto._renderTimeAxisDiagnosticsBlock = function(container, diagnostics, state = {}) {
    container.textContent = '';

    if (state.heading) {
        const heading = document.createElement('div');
        heading.className = 'modal-section-title';
        heading.textContent = state.heading;
        container.appendChild(heading);
    }

    if (state.status === 'pending' || state.status === 'cancelled' || state.status === 'error') {
        const notice = document.createElement('div');
        notice.className = `time-axis-diag-notice time-axis-diag-notice-${state.status}`;
        const label = document.createElement('span');
        label.textContent = state.status === 'pending' ? i18n.t('timeAxisSummaryComputing')
            : state.status === 'cancelled' ? i18n.t('timeAxisDiagCancelled')
                : i18n.t('timeAxisDiagFailed');
        notice.appendChild(label);
        const action = document.createElement('button');
        action.type = 'button';
        action.className = 'time-axis-diag-action';
        action.textContent = state.status === 'pending' ? i18n.t('cancel') : i18n.t('timeAxisDiagRetry');
        action.addEventListener('click', () => {
            if (state.status === 'pending') state.onCancel?.();
            else state.onRetry?.();
        });
        notice.appendChild(action);
        container.appendChild(notice);
    }

    if (!diagnostics) return;
    const unitless = diagnostics.unitless;
    const unknown = '—';
    const stepUnit = this._timeAxisUnit([diagnostics.dtMin, diagnostics.dtMean, diagnostics.dtMax], unitless);
    const step = value => this._formatTimeAxisValue(value, stepUnit);

    const rows = [[i18n.t('timeAxisDiagSamples'), String(diagnostics.nSamples)]];
    rows.push([i18n.t('timeAxisDiagSpan'), this._formatTimeAxisSpan(diagnostics.span, unitless)]);
    if (diagnostics.verdict === null) {
        rows.push([i18n.t('timeAxisDiagStep'), unknown]);
    } else if (diagnostics.verdict === 'irregular') {
        rows.push([i18n.t('timeAxisDiagStep'),
            `${step(diagnostics.dtMin)} / ${step(diagnostics.dtMean)} / ${step(diagnostics.dtMax)}`]);
    } else {
        // Uniform: three identical numbers say less than one.
        rows.push([i18n.t('timeAxisDiagStepConstant'), step(diagnostics.dtMean)]);
    }
    rows.push([i18n.t('timeAxisDiagRepeated'), String(diagnostics.repeated)]);
    rows.push([i18n.t('timeAxisDiagGaps'), diagnostics.gaps === null ? unknown : String(diagnostics.gaps)]);
    rows.push([i18n.t('timeAxisDiagBackwards'), diagnostics.backwards === null
        ? i18n.t('timeAxisDiagNotChecked')
        : String(diagnostics.backwards)]);

    const table = document.createElement('div');
    table.className = 'time-axis-diag-grid';
    for (const [label, value] of rows) {
        const key = document.createElement('span');
        key.className = 'time-axis-diag-key';
        key.textContent = label;
        const val = document.createElement('span');
        val.className = 'time-axis-diag-value';
        val.textContent = value;
        table.append(key, val);
    }
    container.appendChild(table);

    const verdict = document.createElement('div');
    verdict.className = 'time-axis-diag-verdict';
    if (diagnostics.verdict === 'equidistant') {
        verdict.classList.add('ok');
        verdict.textContent = i18n.t('timeAxisDiagVerdictEquidistant');
    } else if (diagnostics.verdict === 'equidistantRepeats') {
        verdict.classList.add('ok');
        verdict.textContent = i18n.t('timeAxisDiagVerdictEquidistantRepeats')
            .replace('{anomalies}', this._timeAxisAnomalyPhrases(diagnostics).join(', '));
    } else if (diagnostics.verdict === 'irregular') {
        verdict.classList.add('warn');
        verdict.textContent = i18n.t('timeAxisDiagVerdictIrregular');
    } else {
        verdict.textContent = i18n.t('timeAxisDiagVerdictUnknown');
    }
    container.appendChild(verdict);

    // The Δt figures skip the repeated timestamps; say so rather than letting
    // the reader wonder why the minimum is not zero.
    if (diagnostics.repeated > 0 && diagnostics.verdict !== null) {
        const note = document.createElement('div');
        note.className = 'time-axis-diag-footnote';
        note.textContent = i18n.t('timeAxisDiagExcludesRepeated');
        container.appendChild(note);
    }
};

/**
 * Open the inspector for a file. Creates the ticked derived variables; never
 * plots. Returns the names it created or reused.
 */
proto._openTimeAxisInspector = async function(fileId) {
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    if (!data) return [];
    const timeVar = this._getActiveTimeVar(data);
    if (!timeVar?.data?.length) return [];
    const timeVarName = timeVar.name || 'time';
    const isLazy = !!data._duckdb;

    const block = document.createElement('div');
    block.className = 'time-axis-diag';
    let diagnostics = this._cachedTimeAxisDiagnostics(fileId);
    let controller = null;

    const heading = i18n.t('timeAxisDiagHeading').replace('{time}', timeVarName);
    const render = (state = {}, value = diagnostics) =>
        this._renderTimeAxisDiagnosticsBlock(block, value, { heading, ...state });

    const runLazyDiagnostics = () => {
        controller?.abort();
        controller = new AbortController();
        const signal = controller.signal;
        const pending = { status: 'pending', onCancel: () => controller?.abort() };
        render(pending);
        this._computeLazyTimeAxisDiagnostics(fileId, {
            signal,
            onPartial: (partial) => {
                if (signal.aborted) return;
                diagnostics = partial;
                render(pending);
            },
        }).then((complete) => {
            if (signal.aborted) return;
            if (!complete && !diagnostics) {
                // A DuckDB-backed file whose source cannot answer (older source
                // object): say so rather than showing an empty block.
                render({ status: 'error', onRetry: runLazyDiagnostics }, null);
                return;
            }
            if (complete) diagnostics = complete;
            render();
            // The panel's inline verdict can now read this from the cache.
            this._renderFilesList?.();
        }).catch((err) => {
            if (signal.aborted || err?.name === 'AbortError') {
                render({ status: 'cancelled', onRetry: runLazyDiagnostics });
                return;
            }
            console.warn('[time-axis] diagnostics failed:', err);
            render({ status: 'error', onRetry: runLazyDiagnostics });
        });
    };

    if (isLazy && !diagnostics) {
        runLazyDiagnostics();
    } else {
        if (!diagnostics) diagnostics = this._computeEagerTimeAxisDiagnostics(fileId);
        render();
    }

    const existing = new Map(TIME_AXIS_VARIABLE_KINDS
        .map(kind => [kind, this._findTimeAxisEntry(fileId, kind)]));
    const items = TIME_AXIS_VARIABLE_KINDS.map((kind) => {
        const entry = existing.get(kind);
        return {
            value: kind,
            label: i18n.t(kind === 'index' ? 'timeAxisOptionIndexLabel' : 'timeAxisOptionDeltaLabel'),
            code: entry?.name || this._timeAxisVariableName(fileId, data, kind),
            note: entry ? i18n.t('timeAxisOptionExists') : '',
            description: i18n.t(kind === 'index' ? 'timeAxisOptionIndexHelp' : 'timeAxisOptionDeltaHelp')
                .replaceAll('{time}', timeVarName),
            checked: false,
        };
    });

    const escapeHtml = text => String(text).replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
    // There is no derived copy of the time values on purpose: the formula engine
    // already takes the axis as an operand, so the dialog points there instead.
    const hint = i18n.t('timeAxisInspectHint')
        .replace('{time}', `<code>${escapeHtml(timeVarName)}</code>`);
    const body = `<p>${i18n.t('timeAxisInspectBody').replaceAll('{time}', escapeHtml(timeVarName))}</p>`
        + (isLazy ? `<p class="time-axis-diag-lazy-note">${i18n.t('timeAxisInspectLazyNote')}</p>` : '');

    let selection = null;
    try {
        selection = await Modal.checklist(
            body,
            {
                title: i18n.t('timeAxisInspectTitle')
                    .replace('{file}', this._fileDisplayName?.(this.files?.get(fileId)) || ''),
                icon: '🕐',
                className: 'modal-dialog-wide modal-dialog-time-axis',
                html: true,
                bodyElement: block,
                items,
                listTitle: i18n.t('timeAxisSignalsHeading'),
                listFooterHtml: `${i18n.t('timeAxisSignalsLead')} ${hint}`,
                confirmText: i18n.t('timeAxisInspectCreate'),
                cancelText: i18n.t('helpClose'),
            },
        );
    } finally {
        // An abandoned dialog must never leave a full-column scan holding the
        // single DuckDB connection hostage.
        controller?.abort();
    }

    const kinds = Array.isArray(selection)
        ? selection.filter(kind => TIME_AXIS_VARIABLE_KINDS.includes(kind))
        : [];
    const created = [];
    for (const kind of kinds) {
        // Each creation re-renders the tree and any panel already using the name.
        const name = await this._materializeTimeAxisVariable(fileId, data, kind);
        if (name) created.push(name);
    }
    return created;
};

}
