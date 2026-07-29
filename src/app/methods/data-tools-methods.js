import i18n from '../../i18n/index.js';
import WorkerPool, { canUseWorkers } from '../../core/worker-pool.js';
import {
    applyFilter,
    computeDerivative,
    computeDetrend,
    computeIntegral,
    computeMovingAverage,
    detectOutlierIndexes,
    fillMissingValues,
    interpolateOutliers,
    replaceOutliersWithNaN,
    runDataToolPipeline,
} from '../../compute/kernels/index.js';
import * as kernelShared from '../../compute/kernels/shared.js';
import {
    INTERPOLATE_MAX_GAP_UNLIMITED,
    normalizeInterpolateMaxGap,
    normalizeInterpolateParams,
    normalizeInterpolateWindow,
} from '../../compute/kernels/interpolate.js';
import {
    DETREND_METHODS,
    normalizeDetrendOrder,
    normalizeDetrendParams,
    normalizeDetrendWindow,
} from '../../compute/kernels/detrend.js';
import { FILTER_INIT_MODES, FILTER_MODES, normalizeFilterRestartGap } from '../../compute/kernels/iir.js';
// Seconds → "22 min" / "1 h 20 min" / "2 d 5 h". Already the FFT's ladder, so
// the two features spell a duration the same way.
import { formatNaturalDuration } from '../../utils/fft.js';

// Tools whose result is a VARIABLE of the current file: same length, same time
// axis, so it can be stored next to its source and edited in place.
const DATA_TOOLS = new Set([
    'removeOutliers', 'derivative', 'integrate', 'movingAverage',
    'interpolate', 'detrend', 'filter',
]);
// Tools whose result is a FILE. Resampling moves the samples onto a new time
// axis, and a file owns exactly one of those, so the result cannot live inside
// the source file — see resample-methods.js. These are selectable in the picker
// and share the form, but never enter the definition registry, the
// transformations table, the editing state or the preview.
const FILE_DATA_TOOLS = new Set(['resample']);
// The resample source picker's "every variable" entry. Deliberately not a legal
// variable name, so it can never collide with a real one.
export const RESAMPLE_ALL_VARIABLES = '__all_variables__';
// The reserved slot the dashed draft preview occupies in data.variables. Every
// consumer of the variable map skips entries flagged `previewOnly`.
export const DATA_TOOL_PREVIEW_NAME = '__dataToolPreview__';
const OUTLIER_METHODS = new Set(['spike', 'bounds', 'iqr']);
const OUTLIER_REPLACEMENTS = new Set(['nan', 'interpolate']);
const DERIVATIVE_METHODS = new Set(['centered', 'forward', 'backward', 'difference']);
const INTEGRAL_METHODS = new Set(['trapezoidal', 'rectangular']);
const INTEGRAL_GAP_POLICIES = kernelShared.INTEGRAL_GAP_POLICIES;

// One pool for the whole app. Created lazily so importing this module in a Node
// test harness (which has no Worker) costs nothing.
let computePool = null;
export function getComputePool() {
    if (!canUseWorkers()) return null;
    if (!computePool) {
        computePool = new WorkerPool(
            // The `new URL(..., import.meta.url)` form is what lets Vite find
            // and emit the worker chunk; it must stay literal and inline.
            () => new Worker(new URL('../../workers/compute-worker.js', import.meta.url), { type: 'module' }),
            { name: 'compute', size: 2 },
        );
    }
    return computePool;
}

// Kernels throw DataToolError with a stable code so they can run in a worker
// without dragging the translation table along. Re-translate on the way out.
export function translateKernelError(err) {
    const code = err?.code;
    if (!code) return err;
    const message = i18n.t(code);
    const translated = new Error(message && message !== code ? message : err.message);
    translated.code = code;
    return translated;
}

export function installDataToolsMethods(TargetClass) {
    const proto = TargetClass.prototype;

proto.initDataTools = function() {
    const toolSelect = document.getElementById('data-tool-select');
    const sourceSelect = document.getElementById('outlier-variable');
    const outputInput = document.getElementById('outlier-output-name');
    const methodSelect = document.getElementById('outlier-method');
    const helpBtn = document.getElementById('outlier-help-toggle');
    const createBtn = document.getElementById('data-tool-create');
    const createPlotBtn = document.getElementById('data-tool-create-plot');
    const clearBtn = document.getElementById('data-tool-clear');
    const renameBtn = document.getElementById('data-tool-rename');
    const liveChain = document.getElementById('data-tool-live-chain');
    const tableEl = document.getElementById('data-tool-table');
    if (!toolSelect || !sourceSelect || !outputInput || !methodSelect) return;

    toolSelect.value = '';
    toolSelect.addEventListener('change', () => {
        // Switching tools abandons the draft, so the preview it was drawing has
        // to come down with it — _clearDataToolDraft is what takes it off the plot.
        this._exitDataToolEditing({ keepTool: true });
        this._clearDataToolDraft({ keepTool: true });
        this._syncDataTools();
    });
    sourceSelect.addEventListener('change', () => {
        outputInput.value = this._suggestDataToolOutputName(sourceSelect.value);
        this._setOutlierMessage('', '');
        this._syncDataTools();
        this._handleDataToolPreviewChange({ immediate: true });
    });
    // The name never computes anything. Typing here used to commit a variable
    // under a half-typed name, which is the defect this panel was rebuilt for.
    outputInput.addEventListener('input', () => this._syncDataTools());
    outputInput.addEventListener('keydown', (event) => {
        if (!this._dataToolRenameUnlocked) return;
        if (event.key === 'Enter') { event.preventDefault(); this._confirmDataToolRename(); }
        else if (event.key === 'Escape') { event.preventDefault(); this._cancelDataToolRename(); }
    });
    methodSelect.addEventListener('change', () => this._handleDataToolOptionChange());
    document.getElementById('derivative-method')?.addEventListener('change', () => this._handleDataToolOptionChange());
    document.getElementById('integral-method')?.addEventListener('change', () => this._handleDataToolOptionChange());
    document.getElementById('integral-gap-policy')?.addEventListener('change', () => this._handleDataToolOptionChange());
    // Number inputs commit on blur/Enter; previewing every keystroke would run on
    // the "-" of "-1.5".
    document.getElementById('integral-initial')?.addEventListener('change', () => this._handleDataToolOptionChange());

    document.getElementById('moving-average-window-slider')?.addEventListener('input', (event) => {
        const numeric = document.getElementById('moving-average-window');
        if (numeric) numeric.value = event.target.value;
        this._syncDataTools();
        this._handleDataToolPreviewChange({ immediate: true });
    });
    document.getElementById('moving-average-window')?.addEventListener('input', () => {
        this._syncMovingAverageSliderFromInput();
        this._syncDataTools();
        this._handleDataToolPreviewChange({ immediate: true });
    });

    document.getElementById('interpolate-method')?.addEventListener('change', () => this._handleDataToolOptionChange());
    document.getElementById('interpolate-edges')?.addEventListener('change', () => this._handleDataToolOptionChange());
    // The slider and the box are two views of one number, and the box is the one
    // that may exceed the slider's range — that is the point of having both, so a
    // gap limit of 5000 samples is reachable without a 5000-wide slider.
    for (const [sliderId, inputId] of [
        ['interpolate-max-gap-slider', 'interpolate-max-gap'],
        ['interpolate-window-slider', 'interpolate-window'],
    ]) {
        document.getElementById(sliderId)?.addEventListener('input', (event) => {
            const numeric = document.getElementById(inputId);
            if (numeric) numeric.value = event.target.value;
            this._syncDataTools();
            this._handleDataToolPreviewChange({ immediate: true });
        });
        document.getElementById(inputId)?.addEventListener('input', () => {
            this._syncInterpolateControls();
            this._syncDataTools();
            this._handleDataToolPreviewChange({ immediate: true });
        });
    }
    document.getElementById('interpolate-help-toggle')?.addEventListener('click', (event) => {
        event.stopPropagation();
        this._toggleInterpolateHelpPopover();
    });

    document.getElementById('detrend-method')?.addEventListener('change', () => this._handleDataToolOptionChange());
    for (const [sliderId, inputId] of [
        ['detrend-order-slider', 'detrend-order'],
        ['detrend-window-slider', 'detrend-window'],
    ]) {
        document.getElementById(sliderId)?.addEventListener('input', (event) => {
            const numeric = document.getElementById(inputId);
            if (numeric) numeric.value = event.target.value;
            this._syncDataTools();
            this._handleDataToolPreviewChange({ immediate: true });
        });
        document.getElementById(inputId)?.addEventListener('input', () => {
            this._syncDetrendControls();
            this._syncDataTools();
            this._handleDataToolPreviewChange({ immediate: true });
        });
    }

    this.initResampleTool?.();
    this.initFilterTool?.();

    this._dataToolParameterInputs().forEach(input => {
        const isBound = input.id === 'outlier-lower-bound' || input.id === 'outlier-upper-bound';
        if (isBound) {
            // Number inputs commit on blur/Enter only. Previewing every keystroke
            // would run the tool on partial values (e.g. the "1" of "10"), which
            // can cut most of the signal and freeze the app.
            input.addEventListener('input', () => this._syncOutlierMethodControls());
            input.addEventListener('change', () => this._handleDataToolPreviewChange({ immediate: true }));
        } else {
            input.addEventListener('input', () => this._handleOutlierLiveChange({ immediate: true }));
            input.addEventListener('change', () => this._handleDataToolPreviewChange({ immediate: true }));
        }
    });
    document.querySelectorAll('input[name="outlier-replacement"]').forEach(input => {
        input.addEventListener('change', () => this._handleDataToolOptionChange());
    });
    helpBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleOutlierHelpPopover();
    });

    // `text-overflow: ellipsis` on an input only paints while the field is
    // scrolled to its start — and typing leaves it scrolled to the END, which is
    // why the ellipsis never appeared. Rewinding is what makes the CSS visible.
    // Losing focus is the obvious moment for it; _syncDataTools does it again for
    // every field nobody is typing in, so a value that arrived by any other route
    // (a definition loaded for editing, a tool switch, a suggested name) also
    // reads from its beginning.
    const section = document.querySelector('.data-tools-section');
    section?.addEventListener('focusout', (event) => {
        const input = event.target;
        if (input?.tagName === 'INPUT' && input.type === 'text') input.scrollLeft = 0;
        this._syncDataToolOverflowMarks();
    });
    // The overflow markers have to follow the caret and the field's own scrolling,
    // not just the panel's syncs: typing past the right edge, or dragging the text
    // back to the start, both change which side is hiding something.
    for (const eventName of ['input', 'scroll', 'focus', 'keyup', 'click']) {
        section?.addEventListener(eventName, (event) => {
            if (!event.target?.classList?.contains('data-tool-coefficients')) return;
            this._syncDataToolOverflowMarks();
        }, eventName === 'scroll' ? { capture: true } : undefined);
    }

    createBtn?.addEventListener('click', () => this.commitDataTool({ plot: false }));
    createPlotBtn?.addEventListener('click', () => this.commitDataTool({ plot: true }));
    clearBtn?.addEventListener('click', () => this.clearDataToolForm());
    renameBtn?.addEventListener('click', () => this._toggleDataToolRename());
    liveChain?.addEventListener('change', () => this._handleDataToolPreviewChange({ immediate: true }));
    tableEl?.addEventListener('click', (event) => this._handleDataToolTableClick(event));
    tableEl?.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !this._dataToolPendingDelete) return;
        event.preventDefault();
        this._dataToolPendingDelete = '';
        this._renderDataToolTable();
    });

    this._syncDataTools();
};

// Scroll every text field nobody is typing in back to its first character, so a
// value too long for the sidebar reads from its beginning rather than showing its
// tail with no sign that a beginning exists. The field being edited is left alone
// — rewinding under the caret would be maddening.
proto._rewindDataToolInputs = function() {
    const section = document.querySelector('.data-tools-section');
    if (!section) return;
    for (const input of section.querySelectorAll('input[type="text"]')) {
        if (input === document.activeElement) continue;
        if (input.scrollLeft) input.scrollLeft = 0;
    }
};

// Mark which SIDE of a field is hiding text, so a coefficient list too long for
// the sidebar says so — while it is being typed in as much as afterwards, which
// is where `text-overflow: ellipsis` gives up (Chromium will not ellipsize a
// focused editable field, and only ever marks the right-hand end anyway).
proto._syncDataToolOverflowMarks = function() {
    const section = document.querySelector('.data-tools-section');
    if (!section) return;
    for (const input of section.querySelectorAll('.data-tool-coefficients')) {
        const wrap = input.parentElement;
        if (!wrap?.classList.contains('data-tool-input-overflow')) continue;
        // A pixel of slack: sub-pixel text metrics otherwise report an overflow
        // on a value that fits exactly, and the marker would flicker as you type.
        const hidesLeft = input.scrollLeft > 1;
        const hidesRight = input.scrollWidth - input.clientWidth - input.scrollLeft > 1;
        wrap.classList.toggle('overflow-left', hidesLeft);
        wrap.classList.toggle('overflow-right', hidesRight);
    }
};

proto._dataToolParameterInputs = function() {
    return [
        'outlier-spike-sensitivity',
        'outlier-lower-bound',
        'outlier-upper-bound',
    ]
        .map(id => document.getElementById(id))
        .filter(Boolean);
};

proto._outlierParameterInputs = function() {
    return this._dataToolParameterInputs();
};

proto._syncDataTools = function() {
    const toolSelect = document.getElementById('data-tool-select');
    const form = document.getElementById('remove-outliers-tool');
    const sourceSelect = document.getElementById('outlier-variable');
    const outputInput = document.getElementById('outlier-output-name');
    const methodSelect = document.getElementById('outlier-method');
    if (!toolSelect || !form || !sourceSelect || !outputInput || !methodSelect) return;

    const fileId = this.activeFileId;
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    const lazy = this._isDataToolLazyData(data);
    // An edit and its preview belong to the file they were started from; switching
    // files abandons both. Without this the placeholder variable would be stranded
    // in the file the user just left.
    if (this._dataToolPreview && this._dataToolPreview.fileId !== fileId) this._clearDataToolPreview();
    if (this._dataToolEditing && this._dataToolEditing.fileId !== fileId) this._exitDataToolEditing({ keepMessage: true });
    const editing = this._dataToolEditing || null;
    this._syncDataToolPickerOptions(lazy);

    const tool = this._getSelectedDataTool();
    const hasTool = !!tool;
    const allowed = hasTool && this._isDataToolAvailableForData(tool, data);

    form.classList.toggle('collapsed', !hasTool);
    document.getElementById('outlier-method-wrap')?.classList.toggle('collapsed', tool !== 'removeOutliers');
    document.getElementById('outlier-replacement-wrap')?.classList.toggle('collapsed', tool !== 'removeOutliers');
    document.querySelectorAll('.data-tool-controls').forEach(el => {
        el.classList.toggle('collapsed', el.dataset.toolKind !== tool);
    });
    this._syncOutlierMethodOptions(lazy && tool === 'removeOutliers');
    this._syncOutlierMethodControls();
    this._syncMovingAverageControls();
    this._syncInterpolateControls();
    this._syncDetrendControls();
    this._syncResampleControls?.();
    this._syncFilterControls?.();

    const fileTool = this._isFileDataTool(tool);
    const previous = sourceSelect.value;
    const entries = hasTool && allowed ? this._getDataToolSourceEntries(data, tool, editing?.name) : [];

    sourceSelect.innerHTML = '';
    if (!hasTool) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = i18n.t('outlierSelectVariable');
        sourceSelect.appendChild(option);
    } else if (lazy && !allowed) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = i18n.t('dataToolLazyToolUnavailable');
        sourceSelect.appendChild(option);
    } else if (!entries.length) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = i18n.t('outlierNoVariables');
        sourceSelect.appendChild(option);
    } else {
        // Resampling rebuilds the whole dataset onto one grid, so "every
        // variable" is its natural default: a file with one column on the new
        // axis and the rest left behind is not a dataset anyone asked for.
        if (fileTool) {
            const option = document.createElement('option');
            option.value = RESAMPLE_ALL_VARIABLES;
            option.textContent = i18n.t('dataToolResampleAllVariables').replace('{count}', String(entries.length));
            sourceSelect.appendChild(option);
        } else {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = i18n.t('outlierSelectVariable');
            sourceSelect.appendChild(option);
        }
        for (const [name, variable] of entries) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = this._outlierSourceLabel(name, variable);
            option.classList.toggle('data-tool-modified', !!variable.dataToolModified);
            sourceSelect.appendChild(option);
        }
    }

    const keptPrevious = entries.some(([name]) => name === previous)
        || (fileTool && previous === RESAMPLE_ALL_VARIABLES);
    if (keptPrevious) sourceSelect.value = previous;
    if (!fileTool && !sourceSelect.value) outputInput.value = '';
    // The suggestion is written once, when the source is picked (see the change
    // handler). Re-suggesting here would refill the field the moment the user
    // cleared it to type their own name.
    if (!editing && !keptPrevious && sourceSelect.value) {
        outputInput.value = this._suggestDataToolOutputName(sourceSelect.value);
    }

    const sourceVariable = sourceSelect.value ? data?.variables?.[sourceSelect.value] : null;
    const hasSource = fileTool
        ? (hasTool && allowed && entries.length > 0)
        : (hasTool && allowed && !!sourceSelect.value && !!sourceVariable);
    const hasValidConfig = !hasSource || !!this._tryReadDataToolConfig();

    sourceSelect.disabled = !hasTool || !allowed || !entries.length;
    outputInput.disabled = !hasSource || (!!editing && !this._dataToolRenameUnlocked);
    methodSelect.disabled = !hasSource || tool !== 'removeOutliers' || lazy;
    this._dataToolParameterInputs().forEach(input => { input.disabled = !hasSource || (lazy && input.id !== 'outlier-lower-bound' && input.id !== 'outlier-upper-bound'); });
    document.getElementById('derivative-method')?.toggleAttribute('disabled', !hasSource || tool !== 'derivative');
    document.getElementById('integral-method')?.toggleAttribute('disabled', !hasSource || tool !== 'integrate');
    document.getElementById('integral-gap-policy')?.toggleAttribute('disabled', !hasSource || tool !== 'integrate');
    document.getElementById('integral-initial')?.toggleAttribute('disabled', !hasSource || tool !== 'integrate');
    document.getElementById('moving-average-window-slider')?.toggleAttribute('disabled', !hasSource || tool !== 'movingAverage');
    document.getElementById('moving-average-window')?.toggleAttribute('disabled', !hasSource || tool !== 'movingAverage');
    for (const id of ['interpolate-method', 'interpolate-edges', 'interpolate-max-gap-slider',
        'interpolate-max-gap', 'interpolate-window-slider', 'interpolate-window']) {
        document.getElementById(id)?.toggleAttribute('disabled', !hasSource || tool !== 'interpolate');
    }
    for (const id of ['detrend-method', 'detrend-order', 'detrend-order-slider',
        'detrend-window', 'detrend-window-slider']) {
        document.getElementById(id)?.toggleAttribute('disabled', !hasSource || tool !== 'detrend');
    }
    const filterOff = !hasSource || tool !== 'filter';
    for (const id of ['filter-b', 'filter-a', 'filter-mode', 'filter-restart-gap']) {
        document.getElementById(id)?.toggleAttribute('disabled', filterOff);
    }
    // Zero phase builds its own edges out of the reflection padding, so an
    // initial-condition choice there would be a control over nothing.
    const zeroPhase = document.getElementById('filter-mode')?.value === 'zeroPhase';
    for (const id of ['filter-init', 'filter-init-level', 'filter-init-x', 'filter-init-y']) {
        document.getElementById(id)?.toggleAttribute('disabled', filterOff || zeroPhase);
    }
    for (const id of ['resample-grid-mode', 'resample-method', 'resample-step', 'resample-factor', 'resample-count']) {
        document.getElementById(id)?.toggleAttribute('disabled', !hasSource || tool !== 'resample');
    }
    document.querySelectorAll('input[name="outlier-replacement"]').forEach(input => {
        input.disabled = !hasSource || tool !== 'removeOutliers' || lazy;
        if (lazy && input.value === 'nan') input.checked = true;
    });

    // The output field names a variable for every tool but one; for resampling it
    // names the file the resampled dataset lands in, and saying "Output name"
    // there would describe the wrong thing.
    const outputLabel = document.getElementById('data-tool-output-label');
    if (outputLabel) outputLabel.textContent = i18n.t(fileTool ? 'dataToolResampleFileName' : 'outlierOutputName');

    const blocker = this._dataToolCommitBlocker({ hasSource, hasValidConfig, editing, fileId, data });
    form.classList.toggle('data-tool-invalid', hasSource && !!blocker);
    this._rewindDataToolInputs();
    this._syncDataToolOverflowMarks();
    this._syncDataToolNameHint();
    this._syncDataToolActions(editing, blocker);
    this._syncDataToolLiveChainToggle(editing, fileId);
    this._renderDataToolTable();

    if (hasTool && lazy && !allowed) {
        this._setOutlierMessage(() => i18n.t('dataToolLazyDisabled'), 'error');
    } else if (hasTool && lazy && tool === 'removeOutliers') {
        const messageEl = document.getElementById('outlier-message');
        if (!messageEl?.textContent) this._setOutlierMessage(() => i18n.t('dataToolLazyBoundsOnly'), '');
    }
};

// Why the commit buttons are disabled, as an i18n key — or '' when the draft is
// ready. The panel shows the same reason as text, so the user never has to guess
// which field is at fault.
proto._dataToolCommitBlocker = function({ hasSource, hasValidConfig, editing, fileId, data }) {
    const tool = this._getSelectedDataTool();
    if (this._isFileDataTool(tool)) {
        if (!hasSource) return 'outlierNoVariables';
        const name = (document.getElementById('outlier-output-name')?.value || '').trim();
        if (!name) return 'dataToolResampleFileNameRequired';
        // A grid that does not resolve to a usable Δt and sample count is the one
        // way this tool can be misconfigured, and the summary already says which.
        return this._resamplePlan(data).ok ? '' : 'dataToolFixParameters';
    }
    if (!hasSource) return 'dataToolChooseVariable';
    // An unstable filter is refused BY NAME rather than through the generic
    // "check the parameters": the reason is specific, the fix is specific, and
    // the whole point of the check is that the user learns which it is.
    if (tool === 'filter') {
        const plan = this._filterPlan();
        if (!plan.ok) return plan.code;
    }
    if (!hasValidConfig) return 'dataToolFixParameters';
    const outputName = (document.getElementById('outlier-output-name')?.value || '').trim();
    if (!outputName) return 'dataToolOutputNameRequired';
    const sourceName = document.getElementById('outlier-variable')?.value || '';
    if (outputName === sourceName) return 'outlierOutputSameAsSource';
    // A name already in use is only free when it is the row being edited.
    const taken = !!data?.variables?.[outputName] && outputName !== editing?.name;
    if (taken) return 'dataToolNameTaken';
    if (editing && !this.dataToolVariablesByFile?.get(fileId)?.has(editing.name)) return 'dataToolEditingGone';
    return '';
};

proto._syncDataToolActions = function(editing, blocker) {
    const createBtn = document.getElementById('data-tool-create');
    const createPlotBtn = document.getElementById('data-tool-create-plot');
    const clearBtn = document.getElementById('data-tool-clear');
    const renameBtn = document.getElementById('data-tool-rename');
    const banner = document.getElementById('data-tool-editing-banner');
    if (createBtn) {
        createBtn.disabled = !!blocker;
        createBtn.textContent = i18n.t(editing ? 'dataToolUpdate' : 'dataToolCreate');
    }
    if (createPlotBtn) {
        // While editing something already on a panel, "and plot" has nothing left
        // to do — the live update is already redrawing that very trace.
        const alreadyPlotted = !!editing && this._isDataToolVariablePlotted(editing.fileId, editing.name);
        createPlotBtn.disabled = !!blocker || alreadyPlotted;
        createPlotBtn.title = alreadyPlotted ? i18n.t('dataToolAlreadyPlotted') : '';
        createPlotBtn.textContent = i18n.t(editing ? 'dataToolUpdateAndPlot' : 'dataToolCreateAndPlot');
    }
    if (clearBtn) clearBtn.textContent = i18n.t(editing ? 'dataToolCancel' : 'dataToolClear');
    if (renameBtn) {
        // Hidden while drafting: there is nothing to rename yet, the field is
        // already open.
        const renaming = !!this._dataToolRenameUnlocked;
        renameBtn.hidden = !editing;
        renameBtn.classList.toggle('active', renaming);
        renameBtn.disabled = renaming && !!this._dataToolNameHint();
        renameBtn.title = i18n.t(renaming ? 'dataToolRenameConfirmTitle' : 'dataToolRenameTitle');
        const glyph = document.getElementById('data-tool-rename-glyph');
        if (glyph) glyph.textContent = renaming ? '✓' : '✎';
    }
    if (banner) {
        banner.hidden = !editing;
        banner.textContent = editing ? i18n.t('dataToolEditing').replace('{name}', editing.name) : '';
    }
};

// Only meaningful while editing something other variables were built from; with
// no chain the checkbox would be a control over nothing.
proto._syncDataToolLiveChainToggle = function(editing, fileId) {
    const wrap = document.getElementById('data-tool-live-chain-wrap');
    const label = document.getElementById('data-tool-live-chain-label');
    if (!wrap) return;
    const dependents = editing ? this._dataToolDependents(fileId, editing.name) : [];
    const count = dependents.length;
    wrap.hidden = count === 0;
    if (count === 0) return;
    if (label) {
        label.textContent = i18n.t(count === 1 ? 'dataToolLiveChainOne' : 'dataToolLiveChain')
            .replace('{count}', String(count));
    }
    // "Live-update chain" says nothing on its own; the tooltip names the actual
    // variables that ride along with each parameter change.
    wrap.title = i18n.t('dataToolLiveChainHelp').replace('{names}', dependents.join(', '));
};

proto._syncDataToolPickerOptions = function(lazy) {
    const toolSelect = document.getElementById('data-tool-select');
    if (!toolSelect) return;
    for (const option of toolSelect.options) {
        if (!option.value) continue;
        option.disabled = !!lazy && option.value !== 'removeOutliers';
    }
    if (toolSelect.value && toolSelect.options[toolSelect.selectedIndex]?.disabled) {
        toolSelect.value = '';
    }
};

proto._syncOutlierMethodOptions = function(lazyBoundsOnly) {
    const methodSelect = document.getElementById('outlier-method');
    if (!methodSelect) return;
    for (const option of methodSelect.options) {
        option.disabled = !!lazyBoundsOnly && option.value !== 'bounds';
    }
    if (lazyBoundsOnly && methodSelect.value !== 'bounds') methodSelect.value = 'bounds';
};

proto._syncOutlierMethodControls = function() {
    const tool = this._getSelectedDataTool();
    const method = this._getOutlierDetectorMethod();
    document.querySelectorAll('.outlier-method-controls').forEach(el => {
        el.classList.toggle('collapsed', tool !== 'removeOutliers' || el.dataset.outlierMethod !== method);
    });
    const sliderValue = document.getElementById('outlier-spike-sensitivity-value');
    if (sliderValue) sliderValue.textContent = this._formatOutlierNumber(this._getOutlierSensitivity(), 0);
};

proto._syncMovingAverageControls = function() {
    const input = document.getElementById('moving-average-window');
    const slider = document.getElementById('moving-average-window-slider');
    const value = document.getElementById('moving-average-window-value');
    if (!input || !slider) return;
    const sourceName = document.getElementById('outlier-variable')?.value || '';
    const source = this.activeFileId
        ? this.plotManager.files.get(this.activeFileId)?.data?.variables?.[sourceName]
        : null;
    // The window can only be capped once we know how long the series is. With no
    // source picked there is no length to cap against, and clamping to the
    // two-sample floor would drag the default 21 down to 2 in the slider while
    // the number box still read 21.
    const length = Number(source?.data?.length);
    const max = Number.isFinite(length) && length >= 2 ? length : Infinity;
    if (Number.isFinite(max)) input.max = String(max);
    else input.removeAttribute('max');
    const windowSize = this._normalizeMovingAverageWindow(input.value || slider.value, max);
    if (!input.value) input.value = String(windowSize);
    const sliderMin = Number(slider.min);
    const sliderMax = Number(slider.max);
    slider.value = String(Math.max(sliderMin, Math.min(sliderMax, windowSize)));
    if (value) value.textContent = String(windowSize);
};

// The gap limit and the smoothing window are each a slider plus a number box.
// The number box is authoritative and deliberately UNBOUNDED above: a gap limit
// of 5000 samples is a legitimate thing to want, and it does not deserve a
// 5000-wide slider that no one can aim. The slider clamps to its own range and
// the read-out always shows the real value, so a typed 5000 reads 5000 with the
// slider parked at its maximum.
proto._syncInterpolateControls = function() {
    const method = document.getElementById('interpolate-method')?.value || 'linear';
    // The window belongs to one method only; showing it under the others would
    // offer a setting that changes nothing.
    document.getElementById('interpolate-window-wrap')?.classList.toggle('collapsed', method !== 'smooth');

    const pairs = [
        ['interpolate-max-gap', 'interpolate-max-gap-slider', 'interpolate-max-gap-value', normalizeInterpolateMaxGap],
        ['interpolate-window', 'interpolate-window-slider', 'interpolate-window-value', normalizeInterpolateWindow],
    ];
    for (const [inputId, sliderId, valueId, normalize] of pairs) {
        const input = document.getElementById(inputId);
        const slider = document.getElementById(sliderId);
        const value = document.getElementById(valueId);
        if (!input || !slider) continue;
        const normalized = normalize(input.value === '' ? slider.value : input.value);
        // Never written back into the box while the user is typing in it — that
        // is what would turn a half-typed "50" into a clamped "5".
        if (input.value === '') input.value = String(normalized);
        slider.value = String(Math.max(Number(slider.min), Math.min(Number(slider.max), normalized)));
        if (value) {
            value.textContent = inputId === 'interpolate-max-gap' && normalized >= INTERPOLATE_MAX_GAP_UNLIMITED
                ? i18n.t('dataToolInterpolateNoLimit')
                : String(normalized);
        }
    }
};

// Order belongs to the polynomial fit and the window to the moving-average
// baseline; each is shown only under the method that reads it.
proto._syncDetrendControls = function() {
    const method = document.getElementById('detrend-method')?.value || 'linear';
    document.getElementById('detrend-order-wrap')?.classList.toggle('collapsed', method !== 'polynomial');
    document.getElementById('detrend-window-wrap')?.classList.toggle('collapsed', method !== 'movingAverage');

    const sourceName = document.getElementById('outlier-variable')?.value || '';
    const length = Number(this.activeFileId
        ? this.plotManager.files.get(this.activeFileId)?.data?.variables?.[sourceName]?.data?.length
        : 0);
    const max = Number.isFinite(length) && length >= 3 ? length : Infinity;

    for (const [inputId, sliderId, valueId, normalize] of [
        ['detrend-order', 'detrend-order-slider', 'detrend-order-value', value => normalizeDetrendOrder(value)],
        ['detrend-window', 'detrend-window-slider', 'detrend-window-value', value => normalizeDetrendWindow(value, max)],
    ]) {
        const input = document.getElementById(inputId);
        const slider = document.getElementById(sliderId);
        const value = document.getElementById(valueId);
        if (!input || !slider) continue;
        const normalized = normalize(input.value === '' ? slider.value : input.value);
        if (input.value === '') input.value = String(normalized);
        slider.value = String(Math.max(Number(slider.min), Math.min(Number(slider.max), normalized)));
        if (value) value.textContent = String(normalized);
    }
};

proto._toggleInterpolateHelpPopover = function(show) {
    const popover = document.getElementById('interpolate-help-popover');
    const button = document.getElementById('interpolate-help-toggle');
    if (!popover || !button) return;
    const willShow = typeof show === 'boolean' ? show : popover.hidden;
    popover.hidden = !willShow;
    button.classList.toggle('active', willShow);
    button.setAttribute('aria-expanded', String(willShow));
};

proto._syncMovingAverageSliderFromInput = function() {
    const input = document.getElementById('moving-average-window');
    const slider = document.getElementById('moving-average-window-slider');
    const value = document.getElementById('moving-average-window-value');
    if (!input || !slider) return;
    const n = Number(input.value);
    if (Number.isFinite(n)) {
        const sliderMin = Number(slider.min);
        const sliderMax = Number(slider.max);
        slider.value = String(Math.max(sliderMin, Math.min(sliderMax, Math.round(n))));
    }
    if (value && Number.isFinite(n)) value.textContent = String(Math.max(2, Math.round(n)));
};

proto._handleOutlierMethodChange = function() {
    this._handleDataToolOptionChange();
};

proto._handleOutlierOptionChange = function() {
    this._handleDataToolOptionChange();
};

proto._handleDataToolOptionChange = function() {
    this._setOutlierMessage('', '');
    this._syncDataTools();
    this._handleDataToolPreviewChange({ immediate: true });
};

proto._handleOutlierLiveChange = function(options = {}) {
    this._syncOutlierMethodControls();
    this._handleDataToolPreviewChange(options);
};

// `excludeName`, when editing, drops the edited variable and everything built
// from it: picking either as the new source would make the definition feed
// itself.
proto._getDataToolSourceEntries = function(data, tool = this._getSelectedDataTool(), excludeName = '') {
    const lazy = this._isDataToolLazyData(data);
    const excluded = excludeName
        ? new Set([excludeName, ...this._dataToolDependents(this.activeFileId, excludeName)])
        : null;
    return Object.entries(data?.variables || {})
        .filter(([name, variable]) => {
            if (excluded?.has(name) || variable?.previewOnly) return false;
            if (!variable || variable.kind === 'abscissa' || variable.kind === 'parameter') return false;
            if (variable.plottable === false) return false;
            if (variable.dataType === 'string' || variable.dataType === 'boolean') return false;
            if (lazy) return tool === 'removeOutliers' && !!variable._duckdbCol;
            return this._isDataToolDataSeries(variable.data, tool);
        })
        .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
};

proto._getOutlierSourceEntries = function(data) {
    return this._getDataToolSourceEntries(data, 'removeOutliers');
};

proto._outlierSourceLabel = function(name, variable) {
    const label = variable?.displayName || name;
    return variable?.dataToolModified ? `${label} ${i18n.t('outlierModifiedSuffix')}` : label;
};

proto._suggestOutlierOutputName = function(sourceName) {
    return this._suggestDataToolOutputName(sourceName, 'removeOutliers');
};

proto._suggestDataToolOutputName = function(sourceName, tool = this._getSelectedDataTool()) {
    if (this._isFileDataTool(tool)) return this._suggestResampleFileName();
    if (!sourceName) return '';
    const suffix = {
        removeOutliers: 'no_outliers',
        derivative: 'ddt',
        integrate: 'int',
        movingAverage: 'avg',
        interpolate: 'filled',
        detrend: 'detrended',
        filter: 'filtered',
    }[tool] || 'tool';
    return this._uniqueDataToolVariableName(`${sourceName} ${suffix}`);
};

// The name of the file a resample lands in. Built from the source file, not from
// a variable, because the whole dataset moves onto the new grid.
proto._suggestResampleFileName = function() {
    const base = this.files.get(this.activeFileId)?.name || 'data';
    const candidate = `${base} ${i18n.t('dataToolResampleFileSuffix')}`;
    const taken = name => [...this.files.values()].some(entry => entry?.name === name);
    if (!taken(candidate)) return candidate;
    let index = 2;
    while (taken(`${candidate} ${index}`)) index++;
    return `${candidate} ${index}`;
};

// The single entry point the buttons use. Nothing else in the panel writes a
// variable: until this runs, the form is a draft.
proto.commitDataTool = async function(options = {}) {
    // A preview scheduled but not yet started would post AFTER this commit under
    // the same last-one-wins key and cancel it — the commit would report "task
    // superseded" and write nothing. Committing IS the answer to the draft the
    // preview was going to draw, so the draft run is dropped rather than raced.
    this._cancelPendingDataToolPreview();

    // Resampling writes a file, not a variable, so it does not pass through the
    // create/update/definition machinery below at all.
    if (this._isFileDataTool()) return this.commitResampleTool(options);

    const editing = this._dataToolEditing;
    const context = this._getOutlierContext();
    if (!context) return null;
    let config;
    try {
        config = this._getDataToolConfig(context.tool, context);
    } catch (err) {
        this._setOutlierMessage(err?.message || String(err), 'error');
        return null;
    }

    const result = editing
        ? await this._updateDataToolVariable(context, config, editing)
        : await this._createDataToolVariable(context, config);
    if (!result) return null;

    this._clearDataToolPreview();
    if (options.plot) this._plotDataToolVariable(context.fileId, result.name);
    // The edit was committed, so the pre-edit values must NOT be put back: drop
    // the backup before leaving the editing state, which would otherwise restore
    // them over the result that was just written.
    this._dataToolEditBackup = null;
    // Back to "Choose a tool" either way: a finished transformation is a finished
    // job, and leaving the form half-populated invites a second accidental one.
    if (editing) this._exitDataToolEditing({ keepMessage: true });
    else this._clearDataToolDraft({ keepMessage: true });
    this._syncDataTools();
    return result;
};

proto._createDataToolVariable = async function(context, config) {
    if (context.lazy) return this._applyLazyDataToolCreateMode(context, config, {});

    const { fileId, data, sourceName, sourceVariable, outputName, tool } = context;
    try {
        if (data.variables[outputName]) throw new Error(i18n.t('outlierOutputExists').replace('{name}', outputName));
        if (outputName === sourceName) throw new Error(i18n.t('outlierOutputSameAsSource'));

        const result = await this._buildDataToolResultOffThread(sourceVariable.data, sourceVariable, {
            ...config,
            sourceName,
            targetName: outputName,
            targetMode: 'create',
        }, data);
        data.variables[outputName] = result.variable;
        this._storeDataToolDefinition(fileId, outputName, {
            name: outputName,
            tool,
            targetMode: 'create',
            sourceName,
            method: config.method,
            params: this._cloneDataToolParams(config.params),
            replacement: config.replacement,
            variable: result.variable,
        });

        this.plotManager.updateFileData(fileId, data);
        this._renderFilteredTree();
        this._setDataToolApplyMessage(result, 'created', outputName);
        return result;
    } catch (err) {
        this._setOutlierMessage(err?.message || String(err), 'error');
        return null;
    }
};

// Recompute an existing row in place, optionally under a new name, then refresh
// whatever was built on top of it.
proto._updateDataToolVariable = async function(context, config, editing) {
    const { fileId, data, sourceName, sourceVariable, outputName, tool } = context;
    const oldName = editing.name;
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    if (!definitions?.has(oldName)) {
        this._setOutlierMessage(() => i18n.t('dataToolEditingGone'), 'error');
        return null;
    }

    try {
        if (outputName !== oldName && data.variables[outputName]) {
            throw new Error(i18n.t('dataToolNameTaken').replace('{name}', outputName));
        }
        if (outputName === sourceName) throw new Error(i18n.t('outlierOutputSameAsSource'));

        // A lazy file's variable is a DuckDB column reference, not an array. It
        // has to be rebuilt by the lazy path or it loses that binding.
        if (context.lazy) {
            if (outputName !== oldName) this._renameDataToolVariable(fileId, data, oldName, outputName);
            return await this._applyLazyDataToolCreateMode(context, config, {});
        }

        const result = await this._buildDataToolResultOffThread(sourceVariable.data, sourceVariable, {
            ...config,
            sourceName,
            targetName: outputName,
            targetMode: 'create',
        }, data);
        // Renamed only once the new values are in hand, so a recompute that
        // throws leaves the row exactly as it was.
        if (outputName !== oldName) this._renameDataToolVariable(fileId, data, oldName, outputName);
        data.variables[outputName] = result.variable;
        this._storeDataToolDefinition(fileId, outputName, {
            name: outputName,
            tool,
            targetMode: 'create',
            sourceName,
            method: config.method,
            params: this._cloneDataToolParams(config.params),
            replacement: config.replacement,
            variable: result.variable,
        });
        const dependents = this._dataToolDependents(fileId, outputName);
        this._reapplyDataToolDependents(fileId, data, outputName);

        // One rebuild, from updateFileData, which restores each panel's view.
        // Rebuilding again here would capture the not-yet-restored view and pin
        // the autoranged one, throwing away the zoom the user was working at.
        this.plotManager.updateFileData(fileId, data);
        this._renderFilteredTree();
        this._setDataToolApplyMessage(result, 'updated', outputName, dependents.length);
        return result;
    } catch (err) {
        this._setOutlierMessage(err?.message || String(err), 'error');
        return null;
    }
};

// Moving the key: the variable map, the definition registry, every definition
// that names it as a source, and any trace already drawing it.
proto._renameDataToolVariable = function(fileId, data, oldName, newName) {
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    const variable = data.variables[oldName];
    if (variable) {
        variable.name = newName;
        data.variables[newName] = variable;
        delete data.variables[oldName];
    }
    if (definitions?.has(oldName)) {
        const definition = definitions.get(oldName);
        definition.name = newName;
        definitions.delete(oldName);
        definitions.set(newName, definition);
        for (const other of definitions.values()) {
            if (other.sourceName === oldName) other.sourceName = newName;
        }
    }
    for (const [panelId, plot] of this.plotManager.plots) {
        let touched = false;
        for (const trace of plot.traces) {
            if (trace.fileId === fileId && trace.varName === oldName) { trace.varName = newName; touched = true; }
        }
        for (const trace of plot.phaseTraces) {
            if (trace.fileId !== fileId) continue;
            for (const axis of ['x', 'y', 'z']) {
                if (trace[axis] === oldName) { trace[axis] = newName; touched = true; }
            }
        }
        // A rename changes a label, not the data: there is no reason for the view
        // to jump.
        if (touched) this.plotManager._rebuildPanel(panelId, { preserveView: true });
    }
};

proto._applyLazyDataToolCreateMode = async function(context, config, options = {}) {
    const { fileId, data, sourceName, sourceVariable, outputName, tool } = context;
    if (!this._isLazyBoundsConfig(config)) throw new Error(i18n.t('dataToolLazyDisabled'));
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    const existing = data.variables[outputName];
    const existingDefinition = definitions?.get(outputName);

    if (existing && !existingDefinition) throw new Error(i18n.t('outlierOutputExists').replace('{name}', outputName));
    if (outputName === sourceName) throw new Error(i18n.t('outlierOutputSameAsSource'));

    const definition = this._lazyDataToolDefinition(outputName, config, sourceName, 'create');
    const variable = {
        ...sourceVariable,
        name: outputName,
        data: this._replaceOutliersWithNaN(
            Array.from(sourceVariable.data || []),
            this._detectBoundsOutliers(sourceVariable.data || [], config.params)
        ),
        description: `Data tool: remove outliers from ${sourceName}; ${this._outlierDetectorDescription(config)}; nan`,
        kind: 'variable',
        derived: true,
        dataToolModified: false,
        dataTool: { ...definition, outlierCount: null },
        _duckdbCol: sourceVariable._duckdbCol,
        _duckdbDataTool: definition,
    };
    delete variable.formula;
    data.variables[outputName] = variable;
    this._storeDataToolDefinition(fileId, outputName, { ...definition, variable });
    const count = await this._countLazyBoundsOutliers(data, sourceName, config.params);
    variable.dataTool.outlierCount = count;
    await this._refreshLazyDataToolOverview(data);

    this.plotManager.updateFileData(fileId, data);
    this._renderFilteredTree();
    this._syncDataTools();
    const result = { variable, count, tool, name: outputName };
    if (!options.silent) this._setDataToolApplyMessage(result, existingDefinition ? 'updated' : 'created', outputName);
    return result;
};

proto._lazyDataToolDefinition = function(name, config, sourceName, targetMode) {
    return {
        name,
        tool: 'removeOutliers',
        targetMode,
        sourceName,
        method: 'bounds',
        params: this._cloneDataToolParams(config.params),
        replacement: 'nan',
    };
};

proto._isLazyBoundsConfig = function(config) {
    return config?.tool === 'removeOutliers' && config.method === 'bounds';
};

proto._countLazyBoundsOutliers = async function(data, sourceName, params) {
    const source = data?._duckdb?.source;
    if (!source?.countOutOfBounds) return this._detectBoundsOutliers(data?.variables?.[sourceName]?.data || [], params).length;
    try {
        return await source.countOutOfBounds(data, sourceName, params);
    } catch (err) {
        console.warn('[duckdb] could not count lazy data-tool outliers:', err?.message || err);
        return null;
    }
};

proto._refreshLazyDataToolOverview = async function(data) {
    const source = data?._duckdb?.source;
    if (!source?.refreshOverview) return;
    try {
        await source.refreshOverview(data);
    } catch (err) {
        console.warn('[duckdb] could not refresh lazy data-tool overview:', err?.message || err);
    }
};

proto._setDataToolApplyMessage = function(result, action, name, dependentCount = 0) {
    const tool = result?.tool || 'removeOutliers';
    // Both tools that COUNT something say how much; the rest just name the
    // variable, because "created X" is the whole story for a derivative.
    const keyByAction = tool === 'removeOutliers'
        ? { created: 'outlierCreated', updated: 'outlierUpdated' }
        : tool === 'interpolate'
            ? { created: 'dataToolInterpolateCreated', updated: 'dataToolInterpolateUpdated' }
            : { created: 'dataToolCreated', updated: 'dataToolUpdated' };
    const warning = result?.warning;
    this._setOutlierMessage(() => {
        const base = i18n.t(keyByAction[action] || 'dataToolUpdated')
            .replace('{count}', String(result?.count ?? 0))
            .replace('{name}', name || result?.name || '');
        const chain = dependentCount > 0
            ? i18n.t(dependentCount === 1 ? 'dataToolChainRefreshedOne' : 'dataToolChainRefreshed')
                .replace('{count}', String(dependentCount))
            : '';
        const note = typeof warning === 'function' ? warning() : (warning || '');
        return [base, chain, note].filter(Boolean).join(' ');
    }, warning ? 'error' : 'ok');
};

// ─── Draft, editing and the transformations table ─────────────────────────

// `Clear` on a draft, `Cancel` on an edit. Neither ever deletes a variable —
// that is the row's trash button, and conflating the two is what made the old
// Reset button unpredictable.
proto.clearDataToolForm = function() {
    if (this._dataToolEditing) this._exitDataToolEditing();
    else this._clearDataToolDraft();
    this._syncDataTools();
};

proto._clearDataToolDraft = function(options = {}) {
    this._clearDataToolPreview();
    const sourceSelect = document.getElementById('outlier-variable');
    const outputInput = document.getElementById('outlier-output-name');
    if (sourceSelect) sourceSelect.value = '';
    if (outputInput) outputInput.value = '';
    this._resetDataToolParameters();
    if (!options.keepTool) {
        const toolSelect = document.getElementById('data-tool-select');
        if (toolSelect) toolSelect.value = '';
    }
    if (!options.keepMessage) this._setOutlierMessage('', '');
};

// Every parameter control the four tools own. Read from the DOM rather than
// listed as constants here, so the defaults live in one place: the markup.
const DATA_TOOL_PARAMETER_IDS = [
    'outlier-method',
    'outlier-spike-sensitivity',
    'outlier-lower-bound',
    'outlier-upper-bound',
    'derivative-method',
    'integral-method',
    'integral-gap-policy',
    'integral-initial',
    'moving-average-window',
    'moving-average-window-slider',
    'interpolate-method',
    'interpolate-max-gap',
    'interpolate-max-gap-slider',
    'interpolate-edges',
    'interpolate-window',
    'interpolate-window-slider',
    'detrend-method',
    'detrend-order',
    'detrend-order-slider',
    'detrend-window',
    'detrend-window-slider',
    'filter-b',
    'filter-a',
    'filter-mode',
    'filter-init',
    'filter-init-level',
    'filter-init-x',
    'filter-init-y',
    'filter-restart-gap',
    'resample-grid-mode',
    'resample-method',
    'resample-step',
    'resample-factor',
    'resample-count',
];

// A new transformation starts from the tool's defaults. Carrying the last run's
// sensitivity or window into the next variable silently applies a setting the
// user chose for something else — and it is invisible, because the control that
// holds it may be collapsed under a different tool.
proto._resetDataToolParameters = function() {
    if (typeof document === 'undefined') return;
    for (const id of DATA_TOOL_PARAMETER_IDS) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.tagName === 'SELECT') {
            const fallback = [...el.options].find(option => option.defaultSelected) || el.options[0];
            if (fallback) el.value = fallback.value;
        } else {
            el.value = el.defaultValue;
        }
    }
    document.querySelectorAll('input[name="outlier-replacement"]').forEach(input => {
        input.checked = input.defaultChecked;
    });
    this._seedResampleDefaults?.();
    this._syncOutlierMethodControls();
    this._syncMovingAverageControls();
    this._syncInterpolateControls();
    this._syncDetrendControls();
    this._syncResampleControls?.();
    this._syncFilterControls?.();
};

proto._enterDataToolEditing = function(fileId, name) {
    const data = this.plotManager.files.get(fileId)?.data;
    const definition = this.dataToolVariablesByFile?.get(fileId)?.get(name);
    if (!data || !definition) return;
    const normalized = this._normalizeDataToolDefinition(definition);

    this._clearDataToolPreview();
    this._dataToolEditing = { fileId, name };
    this._dataToolRenameUnlocked = false;
    this._setOutlierMessage('', '');
    // Defaults first, so the controls this definition does not use show the tool's
    // default rather than whatever a previous draft left in them.
    this._resetDataToolParameters();
    // Two passes on purpose: the first sync repopulates the source picker for the
    // selected tool, and only then does writing `sourceName` into it stick.
    const toolSelect = document.getElementById('data-tool-select');
    if (toolSelect) toolSelect.value = normalized.tool;
    this._syncDataTools();
    this._writeDataToolForm(normalized, name);
    this._syncDataTools();
};

proto._exitDataToolEditing = function(options = {}) {
    if (!this._dataToolEditing) return;
    this._restoreEditedTraceValues();
    this._dataToolEditing = null;
    this._dataToolRenameUnlocked = false;
    this._dataToolRenamePrevious = '';
    this._clearDataToolDraft({ keepMessage: options.keepMessage, keepTool: options.keepTool });
};

// Push a stored definition back into the controls. Values the tool does not use
// are left alone; they are hidden anyway.
proto._writeDataToolForm = function(definition, name) {
    const set = (id, value) => {
        const el = document.getElementById(id);
        if (el && value !== undefined && value !== null) el.value = String(value);
    };
    set('data-tool-select', definition.tool);
    set('outlier-variable', definition.sourceName);
    set('outlier-output-name', name);
    const params = definition.params || {};
    if (definition.tool === 'removeOutliers') {
        set('outlier-method', definition.method);
        if (definition.method === 'bounds') {
            set('outlier-lower-bound', params.lower ?? '');
            set('outlier-upper-bound', params.upper ?? '');
        } else {
            set('outlier-spike-sensitivity', params.sensitivity);
        }
        document.querySelectorAll('input[name="outlier-replacement"]').forEach(input => {
            input.checked = input.value === (definition.replacement || 'nan');
        });
    } else if (definition.tool === 'derivative') {
        set('derivative-method', params.method);
    } else if (definition.tool === 'integrate') {
        set('integral-method', params.method);
        set('integral-gap-policy', params.gapPolicy);
        set('integral-initial', params.initial ?? 0);
    } else if (definition.tool === 'movingAverage') {
        set('moving-average-window', params.window);
        set('moving-average-window-slider', params.window);
    } else if (definition.tool === 'detrend') {
        set('detrend-method', params.method);
        set('detrend-order', params.order);
        set('detrend-order-slider', params.order);
        set('detrend-window', params.window);
        set('detrend-window-slider', params.window);
    } else if (definition.tool === 'filter') {
        set('filter-b', (params.b || [1]).join(', '));
        set('filter-a', (params.a || [1]).join(', '));
        set('filter-mode', params.mode);
        set('filter-init', params.init || 'steady');
        // The stored state is flat [x…, y…]; the panel splits it back into the
        // two boxes it was typed in.
        const stored = params.initState || [];
        const order = Math.max(0, (params.a || [1]).length - 1);
        set('filter-init-level', params.init === 'level' ? (stored[0] ?? '') : '');
        set('filter-init-x', params.init === 'past' ? stored.slice(0, order).join(', ') : '');
        set('filter-init-y', params.init === 'past' ? stored.slice(order).join(', ') : '');
        set('filter-restart-gap', params.restartGap ?? 0);
    } else if (definition.tool === 'interpolate') {
        set('interpolate-method', params.method);
        set('interpolate-max-gap', params.maxGap);
        set('interpolate-max-gap-slider', params.maxGap);
        set('interpolate-edges', params.edges);
        set('interpolate-window', params.window);
        set('interpolate-window-slider', params.window);
    }
};

// The pencil opens the field; it then becomes a check that commits the new name.
// Enter does the same, Escape puts the old one back. Committing is refused while
// the name is invalid, so the field can never be left holding a name the variable
// does not have.
proto._toggleDataToolRename = function() {
    if (!this._dataToolEditing) return;
    if (!this._dataToolRenameUnlocked) {
        this._dataToolRenamePrevious = document.getElementById('outlier-output-name')?.value || '';
        this._dataToolRenameUnlocked = true;
        this._syncDataTools();
        const input = document.getElementById('outlier-output-name');
        input?.focus();
        input?.select();
        return;
    }
    this._confirmDataToolRename();
};

proto._confirmDataToolRename = function() {
    if (!this._dataToolEditing) return;
    if (this._dataToolNameHint()) return;
    this._dataToolRenameUnlocked = false;
    this._dataToolRenamePrevious = '';
    this._syncDataTools();
};

proto._cancelDataToolRename = function() {
    if (!this._dataToolRenameUnlocked) return;
    const input = document.getElementById('outlier-output-name');
    if (input) input.value = this._dataToolRenamePrevious || input.value;
    this._dataToolRenameUnlocked = false;
    this._dataToolRenamePrevious = '';
    this._syncDataTools();
};

// The i18n key naming what is wrong with the name in the field, or '' when it is
// usable. Shown under the input rather than only disabling a button, so the
// reason is visible where the mistake was made.
proto._dataToolNameHint = function() {
    const name = (document.getElementById('outlier-output-name')?.value || '').trim();
    const sourceName = document.getElementById('outlier-variable')?.value || '';
    const data = this.activeFileId ? this.plotManager.files.get(this.activeFileId)?.data : null;
    if (this._isFileDataTool(this._getSelectedDataTool())) {
        if (!name) return 'dataToolNameEmpty';
        // Re-using the name of an earlier resample is how you REPLACE it, so that
        // is not a clash. Re-using the name of a file loaded from disk is.
        for (const [, entry] of this.files) {
            if (entry?.name === name && entry?.resampledFrom === undefined) return 'dataToolResampleFileNameTaken';
        }
        return '';
    }
    if (!name) return 'dataToolNameEmpty';
    if (name === sourceName) return 'outlierOutputSameAsSource';
    if (data?.variables?.[name] && name !== this._dataToolEditing?.name) return 'dataToolNameTaken';
    return '';
};

proto._syncDataToolNameHint = function() {
    const hint = document.getElementById('data-tool-name-hint');
    const input = document.getElementById('outlier-output-name');
    if (!hint || !input) return '';
    const editable = !input.disabled;
    const key = editable ? this._dataToolNameHint() : '';
    hint.hidden = !key;
    hint.textContent = key
        ? i18n.t(key).replace('{name}', (input.value || '').trim())
        : '';
    input.classList.toggle('data-tool-input-invalid', !!key);
    return key;
};

proto._isDataToolVariablePlotted = function(fileId, name) {
    for (const [, plot] of this.plotManager?.plots || []) {
        if (plot.traces?.some(trace => trace.fileId === fileId && trace.varName === name)) return true;
        if (plot.phaseTraces?.some(trace => trace.fileId === fileId
            && (trace.x === name || trace.y === name || trace.z === name))) return true;
    }
    return false;
};

// Names of every transformation built, directly or not, on top of `name`.
proto._dataToolDependents = function(fileId, name) {
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    if (!definitions?.size || !name) return [];
    const found = [];
    const seeds = new Set([name]);
    // _orderedDataToolDefinitions is topological, so one pass reaches the whole
    // subtree: a definition is always visited after its source.
    for (const [candidate, definition] of this._orderedDataToolDefinitions(fileId)) {
        if (candidate === name || !seeds.has(definition.sourceName)) continue;
        seeds.add(candidate);
        found.push(candidate);
    }
    return found;
};

// Deletes without asking: the table arms the row and asks there, in place, so
// this runs only once the answer is yes.
proto._deleteDataToolVariable = function(fileId, name) {
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    if (!data) return false;
    const dependents = this._dataToolDependents(fileId, name);

    // Deepest first, so nothing is briefly left pointing at a missing source.
    for (const dependent of [...dependents].reverse()) this._removeDataToolVariable(fileId, data, dependent);
    this._removeDataToolVariable(fileId, data, name);

    if (data?._duckdb?.source?.refreshOverview) {
        data._duckdb.source.refreshOverview(data).catch(err =>
            console.warn('[duckdb] could not refresh overview after data-tool delete:', err?.message || err)
        );
    }
    this.plotManager.updateFileData(fileId, data);
    this._clearVariableSelection?.();
    this._renderFilteredTree();
    // The count names the variables that came DOWN WITH it, not including it.
    this._setOutlierMessage(() => (dependents.length
        ? i18n.t(dependents.length === 1 ? 'dataToolDeletedWithChainOne' : 'dataToolDeletedWithChain')
            .replace('{name}', name)
            .replace('{count}', String(dependents.length))
        : i18n.t('dataToolDeleted').replace('{name}', name)), 'ok');
    this._syncDataTools();
    return true;
};

proto._removeDataToolVariable = function(fileId, data, name) {
    delete data.variables[name];
    this.derivedByFile?.get(fileId)?.delete(name);
    this._deleteDataToolDefinition(fileId, name);
    this._removeDataToolVariableFromPlots(fileId, name);
};

proto._renderDataToolTable = function() {
    const wrap = document.getElementById('data-tool-table-wrap');
    const table = document.getElementById('data-tool-table');
    if (!wrap || !table) return;
    const fileId = this.activeFileId;
    // Topological order, so a chain reads top to bottom: a variable never appears
    // above the one it was built from. Insertion order would not survive a rename,
    // which re-inserts the row at the end.
    const rows = fileId ? this._orderedDataToolDefinitions(fileId) : [];
    wrap.hidden = !fileId || rows.length === 0;
    if (wrap.hidden) {
        table.innerHTML = '';
        return;
    }

    const editingName = this._dataToolEditing?.name || '';
    // A pending confirmation for a row that no longer exists would strand the
    // table in a state nothing can dismiss.
    if (this._dataToolPendingDelete && !rows.some(([name]) => name === this._dataToolPendingDelete)) {
        this._dataToolPendingDelete = '';
    }
    table.innerHTML = '';
    for (const [name, definition] of rows) {
        const confirming = name === this._dataToolPendingDelete;
        const row = document.createElement('div');
        row.className = 'data-tool-row'
            + (name === editingName ? ' editing' : '')
            + (confirming ? ' confirming' : '');
        row.dataset.name = name;

        const flow = document.createElement('div');
        flow.className = 'data-tool-row-flow';
        flow.textContent = `${definition.sourceName} → ${name}`;
        flow.title = flow.textContent;

        row.appendChild(flow);
        row.appendChild(confirming
            ? this._dataToolRowConfirm(fileId, name)
            : this._dataToolRowActions(definition));
        table.appendChild(row);
    }
};

proto._dataToolRowActions = function(definition) {
    const bottom = document.createElement('div');
    bottom.className = 'data-tool-row-bottom';
    const label = document.createElement('span');
    label.className = 'data-tool-row-tool';
    label.textContent = this._dataToolLabel(definition.tool);
    const actions = document.createElement('span');
    actions.className = 'data-tool-row-actions';
    actions.appendChild(this._dataToolRowButton('edit', '✎', 'dataToolEditTitle'));
    actions.appendChild(this._dataToolRowButton('delete', '🗑', 'dataToolDeleteTitle'));
    bottom.appendChild(label);
    bottom.appendChild(actions);
    return bottom;
};

// The confirmation takes over the row's second line rather than opening a modal:
// the question belongs next to the thing being deleted, and a full dialog for one
// derived variable is heavier than the action deserves.
proto._dataToolRowConfirm = function(fileId, name) {
    const dependents = this._dataToolDependents(fileId, name);
    const bottom = document.createElement('div');
    bottom.className = 'data-tool-row-bottom';

    const question = document.createElement('span');
    question.className = 'data-tool-row-question';
    question.textContent = dependents.length
        ? i18n.t('dataToolDeleteConfirmChain').replace('{count}', String(dependents.length))
        : i18n.t('dataToolDeleteConfirm');
    // The chain is named in full on hover; the inline line only has room for a count.
    if (dependents.length) {
        question.title = i18n.t(dependents.length === 1 ? 'dataToolDeleteCascadeOne' : 'dataToolDeleteCascade')
            .replace('{name}', name)
            .replace('{count}', String(dependents.length))
            .replace('{names}', dependents.join(', '));
    }

    const actions = document.createElement('span');
    actions.className = 'data-tool-row-actions';
    const yes = this._dataToolRowButton('confirm-delete', i18n.t('dataToolYes'), 'dataToolDeleteTitle');
    yes.classList.add('data-tool-row-yes');
    const no = this._dataToolRowButton('cancel-delete', i18n.t('dataToolNo'), 'dataToolCancel');
    actions.appendChild(yes);
    actions.appendChild(no);

    bottom.appendChild(question);
    bottom.appendChild(actions);
    return bottom;
};

proto._dataToolRowButton = function(action, glyph, titleKey) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `tree-control-btn data-tool-row-btn data-tool-row-${action}`;
    button.dataset.action = action;
    button.title = i18n.t(titleKey);
    button.textContent = glyph;
    return button;
};

proto._dataToolLabel = function(tool) {
    return i18n.t({
        removeOutliers: 'removeOutliers',
        derivative: 'dataToolDerivative',
        integrate: 'dataToolIntegrate',
        movingAverage: 'dataToolMovingAverage',
        interpolate: 'dataToolInterpolate',
        detrend: 'dataToolDetrend',
        filter: 'dataToolFilter',
        resample: 'dataToolResample',
    }[tool] || 'dataTools');
};

proto._handleDataToolTableClick = function(event) {
    const button = event.target.closest('.data-tool-row-btn');
    const row = event.target.closest('.data-tool-row');
    if (!button || !row) return;
    const name = row.dataset.name;
    const fileId = this.activeFileId;
    if (!name || !fileId) return;
    const action = button.dataset.action;
    if (action === 'edit') {
        this._dataToolPendingDelete = '';
        this._enterDataToolEditing(fileId, name);
    } else if (action === 'delete') {
        // Arm the row instead of deleting; only one row is ever armed.
        this._dataToolPendingDelete = name;
        this._renderDataToolTable();
    } else if (action === 'cancel-delete') {
        this._dataToolPendingDelete = '';
        this._renderDataToolTable();
    } else if (action === 'confirm-delete') {
        this._dataToolPendingDelete = '';
        this._deleteDataToolVariable(fileId, name);
    }
};

// "Create and plot": prefer a panel that already shows the source variable, so
// the new curve lands next to what it was made from.
proto._plotDataToolVariable = function(fileId, name) {
    const sourceName = document.getElementById('outlier-variable')?.value || '';
    let panelId = null;
    for (const [id, plot] of this.plotManager.plots) {
        if (plot.mode !== 'timeseries') continue;
        if (plot.traces.some(trace => trace.fileId === fileId && trace.varName === sourceName)) { panelId = id; break; }
        if (panelId === null && plot.traces.length) panelId = id;
    }
    if (panelId === null) panelId = document.querySelector('.layout-panel')?.dataset.id || null;
    if (panelId === null) return;
    const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
    if (!panelEl) return;
    this.plotManager.addTrace(panelId, name, panelEl);
};

// Run the tool in the compute worker when one is available, then assemble the
// result through the exact same code the synchronous path uses. Falls back to
// running in-thread whenever workers are unavailable (file://, Node harnesses,
// a crashed pool), so behaviour never depends on the transport.
proto._buildDataToolResultOffThread = async function(sourceValues, sourceVariable, config, data) {
    const pool = getComputePool();
    const runInline = () => this._buildDataToolResult(sourceValues, sourceVariable, config, data);
    if (!pool?.available) return runInline();

    const steps = (Array.isArray(config.steps) && config.steps.length)
        ? config.steps.map(step => this._normalizeDataToolStep(step))
        : [{
            tool: config.tool,
            method: config.method,
            params: config.params,
            replacement: config.replacement,
        }];

    // Copies, because posting with a transfer list neuters the buffers on this
    // side and the caller still owns the originals.
    const values = kernelShared.copyFloat64(sourceValues);
    const timeContext = this._getDataToolTimeContext(data, values.length);
    const time = {
        values: timeContext.values ? kernelShared.copyFloat64(timeContext.values) : null,
        kind: timeContext.kind,
    };
    const transfer = [values.buffer];
    if (time.values) transfer.push(time.values.buffer);

    try {
        const precomputed = await pool.run('dataTool:pipeline', { values, time, steps }, {
            transfer,
            // Last-one-wins per output variable: dragging the sensitivity slider
            // supersedes the run already in flight instead of queueing behind it.
            key: `dataTool:${config.targetName || config.sourceName || ''}`,
        });
        return this._buildDataToolResult(sourceValues, sourceVariable, config, data, precomputed);
    } catch (err) {
        if (err?.cancelled) throw err;
        if (err?.workerUnavailable) return runInline();
        throw translateKernelError(err);
    }
};

// `precomputed`, when supplied, carries values the compute worker already
// produced: { stepValues: Float64Array[], stepMeta: object[] }. The assembly
// below is then identical to the synchronous path — which is the point, so the
// worker cannot drift from the fallback.
proto._buildDataToolResult = function(sourceValues, sourceVariable, config, data, precomputed = null) {
    if (Array.isArray(config.steps) && config.steps.length) {
        return this._buildDataToolPipelineResult(sourceValues, sourceVariable, config, data, precomputed);
    }
    const pre = precomputed
        ? { values: precomputed.stepValues[0], meta: precomputed.stepMeta[0] }
        : null;
    return this._buildSingleDataToolResult(sourceValues, sourceVariable, config, data, pre);
};

proto._buildSingleDataToolResult = function(sourceValues, sourceVariable, config, data, pre = null) {
    if (config.tool === 'derivative') return this._buildDerivativeResult(sourceValues, sourceVariable, config, data, pre);
    if (config.tool === 'integrate') return this._buildIntegralResult(sourceValues, sourceVariable, config, data, pre);
    if (config.tool === 'movingAverage') return this._buildMovingAverageResult(sourceValues, sourceVariable, config, pre);
    if (config.tool === 'interpolate') return this._buildInterpolateResult(sourceValues, sourceVariable, config, data, pre);
    if (config.tool === 'detrend') return this._buildDetrendResult(sourceValues, sourceVariable, config, data, pre);
    if (config.tool === 'filter') return this._buildFilterResult(sourceValues, sourceVariable, config, data, pre);
    return this._buildOutlierResult(sourceValues, sourceVariable, config, pre);
};

proto._buildDataToolPipelineResult = function(sourceValues, sourceVariable, config, data, precomputed = null) {
    const steps = config.steps.map(step => this._normalizeDataToolStep(step));
    let currentValues = sourceValues;
    let currentVariable = sourceVariable;
    let result = null;
    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const pre = precomputed
            ? { values: precomputed.stepValues[i], meta: precomputed.stepMeta[i] }
            : null;
        result = this._buildSingleDataToolResult(currentValues, currentVariable, {
            ...step,
            sourceName: config.sourceName,
            targetName: config.targetName,
            targetMode: config.targetMode,
        }, data, pre);
        currentValues = result.variable.data;
        currentVariable = result.variable;
    }

    const last = steps[steps.length - 1];
    const {
        tool: _tool,
        sourceName: _sourceName,
        targetMode: _targetMode,
        method: _method,
        params: _params,
        replacement: _replacement,
        steps: _steps,
        ...finalDataTool
    } = result?.variable?.dataTool || {};
    const variable = this._baseDataToolVariable(sourceValues, sourceVariable, {
        ...config,
        tool: last.tool,
        method: last.method,
        params: this._cloneDataToolParams(last.params),
        replacement: last.replacement,
    }, currentValues, {
        ...finalDataTool,
        steps: steps.map(step => this._cloneDataToolParams(step)),
    });
    if (config.targetMode === 'create') variable.description = this._dataToolDescription({ ...config, steps });
    return { ...result, variable, tool: last.tool, name: config.targetName };
};

proto._baseDataToolVariable = function(sourceValues, sourceVariable, config, values, extraDataTool = {}) {
    const variable = {
        ...sourceVariable,
        name: config.targetName,
        data: values,
        description: config.targetMode === 'create'
            ? this._dataToolDescription(config)
            : sourceVariable.description,
        kind: 'variable',
        dataType: this.parser._detectDataType(values, 'variable'),
        isConstant: this.parser._isConstantValues(values),
        interpolation: sourceVariable.interpolation || 'linear',
        derived: config.targetMode === 'create' ? true : !!sourceVariable.derived,
        dataToolModified: config.targetMode === 'modify',
        dataTool: {
            tool: config.tool,
            sourceName: config.sourceName,
            targetMode: config.targetMode,
            method: config.method || null,
            params: this._cloneDataToolParams(config.params),
            ...extraDataTool,
        },
    };
    if (config.replacement) variable.dataTool.replacement = config.replacement;
    if (config.targetMode === 'create') {
        delete variable._duckdbCol;
        delete variable._duckdbDataTool;
        delete variable.formula;
    }
    return variable;
};

proto._buildOutlierResult = function(sourceValues, sourceVariable, config, pre = null) {
    const values = kernelShared.asFloat64(sourceValues);
    const outlierIndexes = pre ? pre.meta.outlierIndexes : this._detectOutlierIndexes(values, config.method, config.params);
    const cleaned = pre
        ? pre.values
        : (config.replacement === 'interpolate'
            ? this._interpolateOutliers(values, outlierIndexes)
            : this._replaceOutliersWithNaN(values, outlierIndexes));
    const variable = this._baseDataToolVariable(values, sourceVariable, {
        ...config,
        tool: 'removeOutliers',
    }, cleaned, {
        method: config.method,
        replacement: config.replacement,
        outlierCount: outlierIndexes.length,
        outlierIndexes,
    });
    return { variable, count: outlierIndexes.length, tool: 'removeOutliers', name: config.targetName };
};

proto._buildDerivativeResult = function(sourceValues, sourceVariable, config, data, pre = null) {
    const result = pre ? { values: pre.values } : this._computeDerivativeValues(sourceValues, data, config.params);
    const variable = this._baseDataToolVariable(sourceValues, sourceVariable, {
        ...config,
        tool: 'derivative',
    }, result.values, { method: config.params.method });
    return { variable, count: result.values.length, tool: 'derivative', name: config.targetName };
};

proto._buildIntegralResult = function(sourceValues, sourceVariable, config, data, pre = null) {
    const result = pre ? { ...pre.meta, values: pre.values } : this._computeIntegralValues(sourceValues, data, config.params);
    const variable = this._baseDataToolVariable(sourceValues, sourceVariable, {
        ...config,
        tool: 'integrate',
    }, result.values, {
        method: config.params.method,
        gapPolicy: config.params.gapPolicy,
        initial: config.params.initial,
        negativeDtCount: result.negativeDtCount,
        gapCount: result.gapCount,
        nanSegmentCount: result.nanSegmentCount,
        uncoveredTime: result.uncoveredTime,
        hasNominalStep: result.hasNominalStep,
    });
    // A function, not a string: the panel re-renders it on a language switch,
    // and the counts it reads live on `result` rather than in baked text.
    const warning = () => this._integralWarning(result, config.params);
    return {
        variable,
        count: result.values.length,
        tool: 'integrate',
        name: config.targetName,
        warning: warning() ? warning : '',
    };
};

// A gap changes the answer, so it cannot stay silent — that silence is the bug
// this tool had.
//
// The quantity is how much of the span the file has no data for. It is the same
// number under every policy, because it describes the FILE; what each policy
// changes is the sentence after it, which says what was done about it. Counting
// gaps and invalid segments separately, as this did at first, made the reader
// decode two internal categories to answer one question: how much of my
// integral was not measured.
proto._integralWarning = function(result, params = {}) {
    const parts = [];
    if (result.negativeDtCount > 0) {
        parts.push(i18n.t('dataToolNegativeDtWarning').replace('{count}', String(result.negativeDtCount)));
    }
    const holes = (result.gapCount || 0) + (result.nanSegmentCount || 0);
    if (holes > 0) {
        const key = params.gapPolicy === 'interpolate'
            ? 'dataToolIntegralGapWarningInterpolate'
            : (params.gapPolicy === 'propagate'
                ? 'dataToolIntegralGapWarningPropagate'
                : 'dataToolIntegralGapWarningZero');
        parts.push(i18n.t(key).replace('{time}', this._formatUncoveredTime(result)));
    }
    return parts.join(' ');
};

// Only a datetime axis measures the uncovered span in seconds, so only there is
// a duration ("22 min", "1 h 20 min", "2 d 5 h") a true statement. A numeric
// axis carries whatever unit its column had, and an index axis counts rows —
// formatting either as a duration would invent hours out of row numbers.
proto._formatUncoveredTime = function(result) {
    const amount = Number(result?.uncoveredTime);
    if (!Number.isFinite(amount)) return '?';
    if (result?.timeKind === 'datetime') return formatNaturalDuration(amount);
    if (result?.timeKind === 'index') {
        return i18n.t(amount === 1 ? 'dataToolIntegralGapSample' : 'dataToolIntegralGapSamples')
            .replace('{n}', String(amount));
    }
    return String(Number(amount.toPrecision(6)));
};

proto._buildInterpolateResult = function(sourceValues, sourceVariable, config, data, pre = null) {
    const result = pre
        ? { ...pre.meta, values: pre.values }
        : this._computeInterpolatedValues(sourceValues, data, config.params);
    const variable = this._baseDataToolVariable(sourceValues, sourceVariable, {
        ...config,
        tool: 'interpolate',
    }, result.values, {
        method: config.params.method,
        maxGap: config.params.maxGap,
        edges: config.params.edges,
        window: config.params.window,
        filledCount: result.filledCount,
        filledRuns: result.filledRuns,
        skippedCount: result.skippedCount,
        skippedRuns: result.skippedRuns,
        missingCount: result.missingCount,
    });
    const warning = () => this._interpolateWarning(result);
    return {
        variable,
        // The headline number is what the tool DID, not how long the series is:
        // "filled 412 samples" is the fact the user is checking.
        count: result.filledCount,
        tool: 'interpolate',
        name: config.targetName,
        warning: warning() ? warning : '',
    };
};

// What was deliberately left missing, and why. A gap limit that quietly refuses
// to fill anything is worse than no limit at all, so the panel says so.
proto._interpolateWarning = function(result) {
    const parts = [];
    if (result.skippedRuns > 0) {
        parts.push(i18n.t(result.skippedRuns === 1 ? 'dataToolInterpolateSkippedOne' : 'dataToolInterpolateSkipped')
            .replace('{runs}', String(result.skippedRuns))
            .replace('{count}', String(result.skippedCount))
            .replace('{longest}', String(result.longestSkipped)));
    }
    // Row numbers and time coincide only on a regular axis; where they do not,
    // saying which one was used is the difference between a bridge that lands
    // where it should and one that merely looks plausible.
    if (result.filledCount > 0 && result.usedTimeAxis === false) {
        parts.push(i18n.t('dataToolInterpolateIndexAxis'));
    }
    return parts.join(' ');
};

proto._buildDetrendResult = function(sourceValues, sourceVariable, config, data, pre = null) {
    const result = pre
        ? { ...pre.meta, values: pre.values }
        : this._computeDetrendValues(sourceValues, data, config.params);
    const variable = this._baseDataToolVariable(sourceValues, sourceVariable, {
        ...config,
        tool: 'detrend',
    }, result.values, {
        method: config.params.method,
        order: result.order,
        window: config.params.window,
        slope: result.slope,
        fitPoints: result.fitPoints,
    });
    const warning = () => this._detrendNote(result, config.params);
    return {
        variable,
        count: result.values.length,
        tool: 'detrend',
        name: config.targetName,
        warning: warning() ? warning : '',
    };
};

// The drift that was taken out, in the file's own units per second. A detrend is
// the one transformation whose effect is hard to read off the plot afterwards —
// the result looks like a signal with no trend either way — so the number that
// was removed is worth stating.
proto._detrendNote = function(result, params = {}) {
    if (!Number.isFinite(result?.slope)) return '';
    if (params.method !== 'linear') return '';
    const perUnit = result.usedTimeAxis ? 'dataToolDetrendSlope' : 'dataToolDetrendSlopePerSample';
    return i18n.t(perUnit).replace('{slope}', formatSignificant(result.slope));
};

proto._buildFilterResult = function(sourceValues, sourceVariable, config, data, pre = null) {
    const result = pre
        ? { ...pre.meta, values: pre.values }
        : this._computeFilteredValues(sourceValues, data, config.params);
    const variable = this._baseDataToolVariable(sourceValues, sourceVariable, {
        ...config,
        tool: 'filter',
    }, result.values, {
        mode: config.params.mode,
        b: [...config.params.b],
        a: [...config.params.a],
        init: config.params.init,
        initState: [...(config.params.initState || [])],
        restartGap: config.params.restartGap,
        segments: result.segments,
        restarts: result.restarts,
        carriedBreaks: result.carriedBreaks,
        filteredCount: result.filteredCount,
        skippedCount: result.skippedCount,
        irregular: result.irregular,
    });
    const warning = () => this._filterNote(result);
    return {
        variable,
        count: result.filteredCount,
        tool: 'filter',
        name: config.targetName,
        warning: warning() ? warning : '',
    };
};

// What the run had to work around. Both facts change how the result should be
// read, and neither is visible on the plot: a restart spends a settling
// transient, and an irregular axis means the cut-off is not a frequency.
proto._filterNote = function(result) {
    const parts = [];
    if (result?.restarts > 1) {
        parts.push(i18n.t('dataToolFilterSegments')
            .replace('{segments}', String(result.restarts))
            .replace('{count}', String(result.skippedCount)));
    }
    if (result?.carriedBreaks > 0) {
        parts.push(i18n.t(result.carriedBreaks === 1 ? 'dataToolFilterCarriedOne' : 'dataToolFilterCarried')
            .replace('{count}', String(result.carriedBreaks)));
    }
    if (result?.irregular) parts.push(i18n.t('dataToolFilterAxisIrregular'));
    return parts.join(' ');
};

proto._buildMovingAverageResult = function(sourceValues, sourceVariable, config, pre = null) {
    const values = pre ? pre.values : this._computeMovingAverageValues(sourceValues, config.params);
    const variable = this._baseDataToolVariable(sourceValues, sourceVariable, {
        ...config,
        tool: 'movingAverage',
    }, values, { window: config.params.window });
    return { variable, count: values.length, tool: 'movingAverage', name: config.targetName };
};

proto._dataToolDescription = function(config) {
    if (Array.isArray(config.steps) && config.steps.length) {
        const labels = config.steps.map(step => this._dataToolStepLabel(step)).join(' -> ');
        return `Data tool: ${labels} of ${config.sourceName}`;
    }
    if (config.tool === 'derivative') {
        return config.params.method === 'difference'
            ? `Data tool: difference of ${config.sourceName}`
            : `Data tool: derivative of ${config.sourceName}; ${config.params.method}`;
    }
    if (config.tool === 'integrate') {
        const initial = config.params.initial || 0;
        const from = initial ? `; from ${initial}` : '';
        return `Data tool: integral of ${config.sourceName}; ${config.params.method}${from}; missing data: ${config.params.gapPolicy}`;
    }
    if (config.tool === 'movingAverage') {
        return `Data tool: moving average of ${config.sourceName}; window ${config.params.window}`;
    }
    if (config.tool === 'interpolate') {
        return `Data tool: fill missing data in ${config.sourceName}; ${this._interpolateDescription(config.params)}`;
    }
    if (config.tool === 'detrend') {
        return `Data tool: detrend ${config.sourceName}; ${this._detrendDescription(config.params)}`;
    }
    if (config.tool === 'filter') {
        return `Data tool: filter ${config.sourceName}; ${this._filterDescription(config.params)}`;
    }
    return `Data tool: remove outliers from ${config.sourceName}; ${this._outlierDetectorDescription(config)}; ${config.replacement}`;
};

proto._interpolateDescription = function(params = {}) {
    const limit = params.maxGap >= INTERPOLATE_MAX_GAP_UNLIMITED ? 'any length' : `up to ${params.maxGap} samples`;
    const window = params.method === 'smooth' ? `, window ${params.window}` : '';
    const edges = params.edges === 'hold' ? ', ends held' : '';
    return `${params.method}${window}; gaps ${limit}${edges}`;
};

proto._detrendDescription = function(params = {}) {
    if (params.method === 'polynomial') return `polynomial order ${params.order}`;
    if (params.method === 'movingAverage') return `moving-average baseline, window ${params.window}`;
    if (params.method === 'firstSample') return 'first sample';
    if (params.method === 'mean') return 'mean';
    return 'least-squares line';
};

proto._dataToolStepLabel = function(step) {
    if (step.tool === 'derivative') return step.params.method === 'difference' ? 'difference' : `derivative (${step.params.method})`;
    if (step.tool === 'integrate') return `integral (${step.params.method}, gaps: ${step.params.gapPolicy})`;
    if (step.tool === 'movingAverage') return `moving average (window ${step.params.window})`;
    if (step.tool === 'interpolate') return `fill missing (${this._interpolateDescription(step.params)})`;
    if (step.tool === 'detrend') return `detrend (${this._detrendDescription(step.params)})`;
    if (step.tool === 'filter') return `filter (${this._filterDescription(step.params)})`;
    return `remove outliers (${this._outlierDetectorDescription(step)}; ${step.replacement})`;
};

// ─── Data Tools math ──────────────────────────────────────────────────────
// The algorithms themselves live in src/compute/kernels/, which is pure,
// DOM-free and importable from a worker. What stays here is the app-facing
// surface: reading the time context off the parsed file and turning a kernel
// error code back into a translated message.
//
// These synchronous entry points are still the fallback (and what
// scripts/test-data-tools.mjs exercises); applyDataTool prefers the worker.

proto._computeDerivativeValues = function(sourceValues, data, params = {}) {
    const time = this._getDataToolTimeContext(data, sourceValues?.length || 0);
    return computeDerivative(sourceValues, time, params);
};

proto._computeIntegralValues = function(sourceValues, data, params = {}) {
    const time = this._getDataToolTimeContext(data, sourceValues?.length || 0);
    return computeIntegral(sourceValues, time, params);
};

proto._computeMovingAverageValues = function(sourceValues, params = {}) {
    return computeMovingAverage(sourceValues, params);
};

proto._computeInterpolatedValues = function(sourceValues, data, params = {}) {
    const time = this._getDataToolTimeContext(data, sourceValues?.length || 0);
    return fillMissingValues(sourceValues, time, params);
};

proto._computeDetrendValues = function(sourceValues, data, params = {}) {
    const time = this._getDataToolTimeContext(data, sourceValues?.length || 0);
    return computeDetrend(sourceValues, time, params);
};

proto._computeFilteredValues = function(sourceValues, data, params = {}) {
    const time = this._getDataToolTimeContext(data, sourceValues?.length || 0);
    try {
        return applyFilter(sourceValues, { ...params, time });
    } catch (err) {
        throw translateKernelError(err);
    }
};

proto._getDataToolTimeContext = function(data, expectedLength) {
    const timeName = data?.metadata?.timeName;
    const timeVariable = (timeName && data?.variables?.[timeName])
        || Object.values(data?.variables || {}).find(v => v.kind === 'abscissa')
        || null;
    const values = timeVariable?.data && timeVariable.data.length === expectedLength
        ? timeVariable.data
        : null;
    const metaKind = data?.metadata?.timeKind || timeVariable?.timeKind || '';
    const kind = metaKind === 'datetime'
        ? 'datetime'
        : (metaKind === 'index' || timeVariable?.timeStepMode === 'index' ? 'index' : 'numeric');
    return { values, kind };
};

proto._dataToolDelta = function(time, a, b) {
    return kernelShared.timeDelta(kernelShared.normalizeTimeContext(time), a, b);
};

proto._detectOutlierIndexes = function(values, method, params = {}) {
    try {
        return detectOutlierIndexes(values, method, params);
    } catch (err) {
        throw translateKernelError(err);
    }
};

proto._replaceOutliersWithNaN = function(values, outlierIndexes) {
    return replaceOutliersWithNaN(values, outlierIndexes);
};

proto._interpolateOutliers = function(values, outlierIndexes) {
    return interpolateOutliers(values, outlierIndexes);
};

proto._getOutlierContext = function(options = {}) {
    const fileId = this.activeFileId;
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    const tool = this._getSelectedDataTool();
    const sourceName = document.getElementById('outlier-variable')?.value || '';
    const outputName = (document.getElementById('outlier-output-name')?.value || '').trim();
    const sourceVariable = data?.variables?.[sourceName];
    const lazy = this._isDataToolLazyData(data);
    if (!tool || !fileId || !data || !sourceVariable) {
        if (!options.quiet) this._setOutlierMessage(() => i18n.t('outlierLoadFileFirst'), 'error');
        return null;
    }
    if (!outputName) {
        if (!options.quiet) this._setOutlierMessage(() => i18n.t('dataToolOutputNameRequired'), 'error');
        return null;
    }
    if (lazy && !this._isDataToolAvailableForData(tool, data)) {
        if (!options.quiet) this._setOutlierMessage(() => i18n.t('dataToolLazyDisabled'), 'error');
        return null;
    }
    return { fileId, data, sourceName, sourceVariable, outputName, targetMode: 'create', tool, lazy };
};

proto._getOutlierConfig = function() {
    return this._getDataToolConfig('removeOutliers');
};

proto._getDataToolConfig = function(tool = this._getSelectedDataTool(), context = null) {
    const data = context?.data || (this.activeFileId ? this.plotManager.files.get(this.activeFileId)?.data : null);
    const lazy = this._isDataToolLazyData(data);
    if (tool === 'derivative') {
        const method = document.getElementById('derivative-method')?.value || 'centered';
        return { tool, params: { method: DERIVATIVE_METHODS.has(method) ? method : 'centered' } };
    }
    if (tool === 'integrate') {
        const method = document.getElementById('integral-method')?.value || 'trapezoidal';
        const gapPolicy = document.getElementById('integral-gap-policy')?.value || 'zero';
        const initial = Number(document.getElementById('integral-initial')?.value);
        return {
            tool,
            params: {
                method: INTEGRAL_METHODS.has(method) ? method : 'trapezoidal',
                gapPolicy: INTEGRAL_GAP_POLICIES.has(gapPolicy) ? gapPolicy : 'zero',
                initial: Number.isFinite(initial) ? initial : 0,
            },
        };
    }
    if (tool === 'movingAverage') {
        const max = context?.sourceVariable?.data?.length
            || (document.getElementById('outlier-variable')?.value
                ? data?.variables?.[document.getElementById('outlier-variable')?.value]?.data?.length
                : 201)
            || 201;
        return { tool, params: { window: this._normalizeMovingAverageWindow(document.getElementById('moving-average-window')?.value, max) } };
    }
    if (tool === 'interpolate') {
        return {
            tool,
            params: normalizeInterpolateParams({
                method: document.getElementById('interpolate-method')?.value,
                maxGap: document.getElementById('interpolate-max-gap')?.value,
                edges: document.getElementById('interpolate-edges')?.value,
                window: document.getElementById('interpolate-window')?.value,
            }),
        };
    }
    if (tool === 'detrend') {
        const method = document.getElementById('detrend-method')?.value;
        return {
            tool,
            params: normalizeDetrendParams({
                method: DETREND_METHODS.has(method) ? method : 'linear',
                order: document.getElementById('detrend-order')?.value,
                window: document.getElementById('detrend-window')?.value,
            }),
        };
    }
    if (tool === 'filter') return this._getFilterConfig();
    if (tool === 'resample') return this._getResampleConfig();

    const method = this._getOutlierDetectorMethod();
    if (lazy && method !== 'bounds') throw new Error(i18n.t('dataToolLazyBoundsOnly'));
    const params = this._getOutlierParams(method);
    const replacement = lazy ? 'nan' : this._getOutlierReplacementMethod();
    return { tool: 'removeOutliers', method, params, replacement };
};

proto._tryReadOutlierConfig = function() {
    return this._tryReadDataToolConfig();
};

proto._tryReadDataToolConfig = function() {
    try {
        return this._getDataToolConfig();
    } catch {
        return null;
    }
};

proto._getSelectedDataTool = function() {
    const value = document.getElementById('data-tool-select')?.value;
    return DATA_TOOLS.has(value) || FILE_DATA_TOOLS.has(value) ? value : '';
};

proto._isFileDataTool = function(tool = this._getSelectedDataTool()) {
    return FILE_DATA_TOOLS.has(tool);
};

proto._isDataToolAvailableForData = function(tool, data) {
    if (!this._isDataToolLazyData(data)) return DATA_TOOLS.has(tool) || FILE_DATA_TOOLS.has(tool);
    // A lazy file's variables are DuckDB column references, not arrays: nothing
    // in here can read a series out of one, so only the bounds filter — which the
    // lazy path implements in SQL — survives.
    return tool === 'removeOutliers';
};

proto._getOutlierDetectorMethod = function() {
    const value = document.getElementById('outlier-method')?.value;
    return OUTLIER_METHODS.has(value) ? value : 'spike';
};

proto._getOutlierParams = function(method) {
    if (method === 'bounds') {
        const lower = this._optionalNumberFromInput('outlier-lower-bound');
        const upper = this._optionalNumberFromInput('outlier-upper-bound');
        if (lower === null && upper === null) throw new Error(i18n.t('outlierBoundsMissing'));
        if (lower !== null && upper !== null && lower > upper) throw new Error(i18n.t('outlierBoundsInvalid'));
        return { lower, upper };
    }
    if (method === 'iqr') return { factor: this._getOutlierIqrFactor() };
    return { sensitivity: this._getOutlierSensitivity() };
};

proto._optionalNumberFromInput = function(id) {
    const raw = document.getElementById(id)?.value;
    if (raw === '' || raw === null || raw === undefined) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
};

proto._getOutlierIqrFactor = function() {
    return this._positiveNumber(document.getElementById('outlier-iqr-factor')?.value, 1.5);
};

proto._getOutlierSensitivity = function() {
    const value = Number(document.getElementById('outlier-spike-sensitivity')?.value);
    if (!Number.isFinite(value)) return 6;
    return Math.max(1, Math.min(10, Math.round(value)));
};

proto._getOutlierReplacementMethod = function() {
    const value = document.querySelector('input[name="outlier-replacement"]:checked')?.value;
    return OUTLIER_REPLACEMENTS.has(value) ? value : 'nan';
};

proto._uniqueDataToolVariableName = function(baseName, fileId = this.activeFileId) {
    const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
    const base = String(baseName || 'tool').trim() || 'tool';
    if (!data?.variables?.[base]) return base;
    let index = 2;
    while (data.variables[`${base} ${index}`]) index++;
    return `${base} ${index}`;
};

proto._dataToolOutputExists = function(fileId, name) {
    return !!fileId && !!name && !!this.dataToolVariablesByFile?.get(fileId)?.has(name);
};

proto._isOutlierDataSeries = function(values) {
    return this._isDataToolDataSeries(values, 'removeOutliers');
};

proto._isDataToolDataSeries = function(values, tool = 'removeOutliers') {
    const length = Number(values?.length);
    if (!Number.isFinite(length)) return false;
    return length > (tool === 'removeOutliers' ? 2 : 1);
};

proto._isDataToolLazyData = function(data) {
    return !!data?._duckdb;
};

proto._storeDataToolDefinition = function(fileId, name, definition) {
    if (!this.dataToolVariablesByFile) this.dataToolVariablesByFile = new Map();
    if (!this.dataToolVariablesByFile.has(fileId)) this.dataToolVariablesByFile.set(fileId, new Map());
    this.dataToolVariablesByFile.get(fileId).set(name, this._normalizeDataToolDefinition(definition));
};

proto._deleteDataToolDefinition = function(fileId, name) {
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    if (!definitions) return;
    definitions.delete(name);
    if (!definitions.size) this.dataToolVariablesByFile.delete(fileId);
};

proto._removeDataToolVariableFromPlots = function(fileId, name) {
    for (const [panelId, plot] of this.plotManager.plots) {
        const beforeTs = plot.traces.length;
        const beforePh = plot.phaseTraces.length;
        plot.traces = plot.traces.filter(t => !(t.fileId === fileId && t.varName === name));
        plot.phaseTraces = plot.phaseTraces.filter(t => !(t.fileId === fileId && (t.x === name || t.y === name || t.z === name)));
        if (beforeTs !== plot.traces.length || beforePh !== plot.phaseTraces.length) {
            this.plotManager._rebuildPanel(panelId);
        }
    }
};

proto._reapplyDataToolVariables = function(fileId, data) {
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    if (!definitions) return;
    for (const [name, definition] of this._orderedDataToolDefinitions(fileId)) {
        this._reapplyDataToolDefinition(fileId, data, name, definition);
    }
    if (this._isDataToolLazyData(data)) {
        this._refreshLazyDataToolOverview(data);
    }
};

proto._reapplyDataToolDependents = function(fileId, data, changedName) {
    if (!changedName) return;
    const changed = new Set([changedName]);
    for (const [name, definition] of this._orderedDataToolDefinitions(fileId)) {
        if (name === changedName || !changed.has(definition.sourceName)) continue;
        if (this._reapplyDataToolDefinition(fileId, data, name, definition)) changed.add(name);
    }
};

proto._orderedDataToolDefinitions = function(fileId) {
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    if (!definitions) return [];
    const normalizedByName = new Map();
    for (const [name, rawDefinition] of definitions) {
        const normalized = this._normalizeDataToolDefinition(rawDefinition);
        definitions.set(name, normalized);
        normalizedByName.set(name, normalized);
    }

    const ordered = [];
    const visiting = new Set();
    const visited = new Set();
    const visit = name => {
        if (visited.has(name)) return;
        if (visiting.has(name)) {
            console.warn(`Circular data-tool dependency involving ${name}; using current variable values.`);
            return;
        }
        const definition = normalizedByName.get(name);
        if (!definition) return;
        visiting.add(name);
        if (definition.sourceName && definition.sourceName !== name && normalizedByName.has(definition.sourceName)) {
            visit(definition.sourceName);
        }
        visiting.delete(name);
        visited.add(name);
        ordered.push([name, definition]);
    };

    for (const name of normalizedByName.keys()) visit(name);
    return ordered;
};

proto._reapplyDataToolDefinition = function(fileId, data, name, definition) {
    const definitions = this.dataToolVariablesByFile?.get(fileId);
    definitions?.set(name, definition);
    try {
        const sourceVariable = data.variables?.[definition.sourceName];
        if (!sourceVariable) throw new Error(`Unknown source variable "${definition.sourceName}".`);
        const targetMode = definition.targetMode || 'create';
        if (this._isDataToolLazyData(data)) {
            if (definition.tool !== 'removeOutliers' || definition.method !== 'bounds') return false;
            const lazyDefinition = this._lazyDataToolDefinition(name, definition, definition.sourceName, targetMode);
            if (targetMode === 'modify') {
                const originalData = definition.originalData?.length
                    ? Array.from(definition.originalData)
                    : Array.from(sourceVariable.data || []);
                sourceVariable.data = this._replaceOutliersWithNaN(originalData, this._detectBoundsOutliers(originalData, definition.params));
                sourceVariable.dataToolModified = true;
                sourceVariable.dataTool = lazyDefinition;
                sourceVariable._duckdbDataTool = lazyDefinition;
                definition.originalData = originalData;
                definition.variable = sourceVariable;
            } else {
                data.variables[name] = {
                    ...sourceVariable,
                    name,
                    data: this._replaceOutliersWithNaN(sourceVariable.data || [], this._detectBoundsOutliers(sourceVariable.data || [], definition.params)),
                    description: `Data tool: remove outliers from ${definition.sourceName}; ${this._outlierDetectorDescription(definition)}; nan`,
                    kind: 'variable',
                    derived: true,
                    dataTool: lazyDefinition,
                    _duckdbCol: sourceVariable._duckdbCol,
                    _duckdbDataTool: lazyDefinition,
                };
                definition.variable = data.variables[name];
            }
            return true;
        }
        const sourceValues = targetMode === 'modify' && definition.originalData?.length
            ? Array.from(definition.originalData)
            : Array.from(sourceVariable.data);
        const result = this._buildDataToolResult(sourceValues, sourceVariable, {
            sourceName: definition.sourceName,
            targetName: name,
            targetMode,
            tool: definition.tool,
            method: definition.method,
            params: this._cloneDataToolParams(definition.params),
            replacement: definition.replacement,
            steps: Array.isArray(definition.steps) ? definition.steps.map(step => this._cloneDataToolParams(step)) : undefined,
        }, data);
        if (targetMode === 'modify') {
            const originalData = sourceValues;
            sourceVariable.data = result.variable.data;
            sourceVariable.dataType = result.variable.dataType;
            sourceVariable.isConstant = result.variable.isConstant;
            sourceVariable.dataToolModified = true;
            sourceVariable.dataTool = result.variable.dataTool;
            definition.originalData = Array.from(originalData);
            definition.variable = sourceVariable;
        } else {
            data.variables[name] = result.variable;
            definition.variable = result.variable;
        }
        return true;
    } catch (err) {
        console.warn(`Could not reapply data tool variable ${name}:`, err);
        return false;
    }
};

proto._copyDataToolDefinitions = function(sourceId, targetId) {
    const sourceDefinitions = this.dataToolVariablesByFile?.get(sourceId);
    if (!sourceDefinitions?.size) return;
    const targetDefinitions = new Map();
    for (const [name, definition] of sourceDefinitions) {
        const normalized = this._normalizeDataToolDefinition(definition);
        targetDefinitions.set(name, {
            name,
            tool: normalized.tool,
            targetMode: normalized.targetMode || 'create',
            sourceName: normalized.sourceName,
            method: normalized.method,
            params: this._cloneDataToolParams(normalized.params),
            replacement: normalized.replacement,
            steps: Array.isArray(normalized.steps)
                ? normalized.steps.map(step => this._cloneDataToolParams(step))
                : undefined,
            variable: null,
        });
    }
    this.dataToolVariablesByFile.set(targetId, targetDefinitions);
};

proto._clearDataToolDefinitions = function(fileId = null) {
    if (!this.dataToolVariablesByFile) return;
    if (fileId) this.dataToolVariablesByFile.delete(fileId);
    else this.dataToolVariablesByFile.clear();
    this._syncDataTools?.();
};

proto._normalizeDataToolDefinition = function(definition = {}) {
    if (Array.isArray(definition.steps) && definition.steps.length) {
        const steps = definition.steps.map(step => this._normalizeDataToolStep(step));
        const last = steps[steps.length - 1];
        return {
            ...definition,
            tool: last.tool,
            targetMode: definition.targetMode || 'create',
            method: last.method,
            params: this._cloneDataToolParams(last.params),
            replacement: last.replacement || '',
            steps,
        };
    }

    const tool = DATA_TOOLS.has(definition.tool) ? definition.tool : 'removeOutliers';
    if (tool !== 'removeOutliers') {
        return {
            ...definition,
            tool,
            targetMode: definition.targetMode || 'create',
            params: this._normalizeDataToolParams(tool, definition.params || definition),
            method: definition.method || definition.params?.method || null,
            replacement: '',
        };
    }

    let method = OUTLIER_METHODS.has(definition.method) ? definition.method : '';
    let replacement = OUTLIER_REPLACEMENTS.has(definition.replacement) ? definition.replacement : '';
    if (!method && Number.isFinite(Number(definition.iqrFactor))) method = 'iqr';
    if (!replacement && OUTLIER_REPLACEMENTS.has(definition.method)) replacement = definition.method;
    method ||= 'spike';
    if (method === 'hampel') method = 'spike';
    replacement ||= 'nan';
    const params = this._normalizeOutlierParams(method, definition.params || {
        factor: definition.iqrFactor,
        iqrFactor: definition.iqrFactor,
    });

    return {
        ...definition,
        tool,
        targetMode: definition.targetMode || 'create',
        method,
        params,
        replacement,
    };
};

proto._normalizeDataToolStep = function(step = {}) {
    const tool = DATA_TOOLS.has(step.tool) ? step.tool : 'removeOutliers';
    if (tool !== 'removeOutliers') {
        const params = this._normalizeDataToolParams(tool, step.params || step);
        return {
            tool,
            method: step.method || params.method || null,
            params,
            replacement: '',
        };
    }

    let method = OUTLIER_METHODS.has(step.method) ? step.method : '';
    let replacement = OUTLIER_REPLACEMENTS.has(step.replacement) ? step.replacement : '';
    if (!method && OUTLIER_METHODS.has(step.params?.method)) method = step.params.method;
    if (!replacement && OUTLIER_REPLACEMENTS.has(step.method)) replacement = step.method;
    method ||= 'spike';
    if (method === 'hampel') method = 'spike';
    replacement ||= 'nan';
    return {
        tool,
        method,
        params: this._normalizeOutlierParams(method, step.params || step),
        replacement,
    };
};

proto._dataToolStepFromConfig = function(config = {}) {
    return this._normalizeDataToolStep({
        tool: config.tool,
        method: config.method,
        params: config.params,
        replacement: config.replacement,
    });
};

proto._dataToolStepsFromDefinition = function(definition = {}) {
    const normalized = this._normalizeDataToolDefinition(definition);
    if (Array.isArray(normalized.steps) && normalized.steps.length) {
        return normalized.steps.map(step => this._normalizeDataToolStep(step));
    }
    return [this._dataToolStepFromConfig(normalized)];
};

proto._normalizeDataToolParams = function(tool, params = {}) {
    if (tool === 'derivative') {
        const method = DERIVATIVE_METHODS.has(params.method) ? params.method : 'centered';
        return { method };
    }
    if (tool === 'integrate') {
        const method = INTEGRAL_METHODS.has(params.method) ? params.method : 'trapezoidal';
        // Sessions saved before the gap policy existed carry no `gapPolicy`, so
        // they land on the default like everything else. That is deliberate: the
        // old value was a bug, and silently reproducing it on reload would keep
        // exactly the results this change exists to correct.
        const gapPolicy = INTEGRAL_GAP_POLICIES.has(params.gapPolicy) ? params.gapPolicy : 'zero';
        // Sessions saved before the initial condition existed carry none, and
        // zero is exactly the accumulation they were computed with.
        const initial = Number.isFinite(Number(params.initial)) ? Number(params.initial) : 0;
        return { method, gapPolicy, initial };
    }
    if (tool === 'movingAverage') {
        return { window: this._normalizeMovingAverageWindow(params.window, Number(params.maxLength) || Infinity) };
    }
    if (tool === 'interpolate') return normalizeInterpolateParams(params);
    if (tool === 'detrend') return normalizeDetrendParams(params);
    if (tool === 'filter') {
        // Coefficients are stored already normalized, so a restored session keeps
        // whatever ran. A definition that carries none is the identity filter,
        // which is the only safe reading of "no coefficients".
        const list = values => (Array.isArray(values) && values.length
            ? values.map(Number).filter(Number.isFinite)
            : [1]);
        return {
            b: list(params.b),
            a: list(params.a),
            mode: FILTER_MODES.has(params.mode) ? params.mode : 'forward',
            init: FILTER_INIT_MODES.has(params.init) ? params.init : 'steady',
            initState: Array.isArray(params.initState)
                ? params.initState.map(Number).filter(Number.isFinite)
                : [],
            // Sessions saved before the restart threshold existed rebuilt the
            // state at every hole, and 0 is exactly that behaviour.
            restartGap: normalizeFilterRestartGap(params.restartGap),
        };
    }
    return this._normalizeOutlierParams(params.method || 'spike', params);
};

proto._normalizeOutlierParams = function(method, params = {}) {
    if (method === 'bounds') {
        const lower = Number.isFinite(Number(params.lower)) ? Number(params.lower) : null;
        const upper = Number.isFinite(Number(params.upper)) ? Number(params.upper) : null;
        return { lower, upper };
    }
    if (method === 'iqr') {
        return { factor: this._positiveNumber(params.factor ?? params.iqrFactor, 1.5) };
    }
    if (Number.isFinite(Number(params.sensitivity))) return { sensitivity: this._normalizeSensitivity(params.sensitivity) };
    if (Number.isFinite(Number(params.threshold))) return { sensitivity: this._sensitivityFromLegacyThreshold(params.threshold) };
    return { sensitivity: 6 };
};

proto._cloneOutlierParams = function(params = {}) {
    return this._cloneDataToolParams(params);
};

proto._cloneDataToolParams = function(params = {}) {
    return JSON.parse(JSON.stringify(params));
};

proto._serializeDataToolDefinitions = function(fileId) {
    return [...(this.dataToolVariablesByFile?.get(fileId) || new Map()).values()]
        .map(item => {
            const definition = this._normalizeDataToolDefinition(item);
            const serialized = {
                name: definition.name,
                tool: definition.tool,
                targetMode: definition.targetMode || 'create',
                sourceName: definition.sourceName,
                method: definition.method || null,
                params: this._cloneDataToolParams(definition.params),
                replacement: definition.replacement || '',
            };
            if (Array.isArray(definition.steps) && definition.steps.length) {
                serialized.steps = definition.steps.map(step => this._cloneDataToolParams(step));
            }
            return serialized;
        });
};

proto._resetDataToolPicker = function() {
    this._dataToolEditing = null;
    this._dataToolRenameUnlocked = false;
    this._clearDataToolPreview();
    const toolSelect = document.getElementById('data-tool-select');
    if (toolSelect) toolSelect.value = '';
    this._toggleOutlierHelpPopover?.(false);
    this._toggleInterpolateHelpPopover?.(false);
    this._toggleResampleHelpPopover?.(false);
    this._toggleFilterHelpPopover?.(false);
    this._toggleFilterInitHelpPopover?.(false);
    this._toggleFilterGapHelpPopover?.(false);
    this._toggleFilterDirectionHelpPopover?.(false);
    this._setOutlierMessage('', '');
    this._syncDataTools?.();
};

// ─── Preview ──────────────────────────────────────────────────────────────
// Dragging a slider must still show its effect — that was the one virtue of the
// old auto-apply. What changed is that the effect is drawn, not stored: while
// drafting it is a dashed throwaway trace, and while editing it is the real
// curve, restored on Cancel.

// Drop a scheduled preview without touching the one already on the plot.
// _clearDataToolPreview also does this, but it tears the trace down and rebuilds
// the panel with it, which is the wrong thing to do mid-commit.
proto._cancelPendingDataToolPreview = function() {
    if (!this._dataToolPreviewTimer) return;
    clearTimeout(this._dataToolPreviewTimer);
    this._dataToolPreviewTimer = null;
};

proto._handleDataToolPreviewChange = function(options = {}) {
    if (this._dataToolPreviewTimer) clearTimeout(this._dataToolPreviewTimer);
    const delay = options.immediate ? 0 : 350;
    this._dataToolPreviewTimer = setTimeout(() => {
        this._dataToolPreviewTimer = null;
        this._runDataToolPreview();
    }, delay);
};

// Take the preview down whatever form it is in. Drafting draws a dashed
// throwaway trace; editing writes into the real variable and keeps a backup, so
// abandoning it has to put those values back or the plot keeps showing a curve
// no setting in the panel produces any more.
proto._abandonDataToolPreview = function() {
    this._clearDataToolPreview();
    if (this._dataToolEditing) this._restoreEditedTraceValues();
};

proto._runDataToolPreview = function() {
    // Resampling has no preview: its result does not share this file's time axis,
    // so there is no trace it could be drawn as next to the source.
    if (this._isFileDataTool()) {
        this._abandonDataToolPreview();
        return;
    }
    const context = this._getOutlierContext({ quiet: true });
    // A lazy file holds column references, not arrays: previewing would compute
    // over the overview and show a curve the commit would not reproduce.
    if (!context || context.lazy) {
        this._abandonDataToolPreview();
        return;
    }
    let config;
    try {
        config = this._getDataToolConfig(context.tool, context);
    } catch {
        // An unreadable configuration has no curve. Leaving the last valid one on
        // the plot is worse than showing nothing: it is a trace that belongs to a
        // filter the panel is no longer describing — an unstable one, say — and
        // nothing on screen says so.
        this._abandonDataToolPreview();
        return;
    }

    const editing = this._dataToolEditing;
    this._buildDataToolResultOffThread(context.sourceVariable.data, context.sourceVariable, {
        ...config,
        sourceName: context.sourceName,
        targetName: editing ? editing.name : `${context.outputName} (preview)`,
        targetMode: 'create',
    }, context.data).then(result => {
        if (editing) this._previewEditedVariable(context, editing, result);
        else this._drawDataToolPreviewTrace(context, result);
    }).catch(err => {
        // A superseded run is the normal outcome of dragging a slider: a newer
        // preview is already in flight and will report for it, and its trace is
        // the one that should stay up.
        if (err?.cancelled) return;
        // Anything else means this configuration produced nothing, so nothing is
        // what the plot should show for it.
        this._abandonDataToolPreview();
        this._setOutlierMessage(err?.message || String(err), 'error');
    });
};

// Editing writes the recomputed values straight into the live variable so every
// panel showing it redraws. The pre-edit values are kept once, so Cancel can put
// them back.
proto._previewEditedVariable = function(context, editing, result) {
    const { fileId, data } = context;
    const variable = data.variables?.[editing.name];
    if (!variable) return;
    if (!this._dataToolEditBackup) {
        this._dataToolEditBackup = { fileId, name: editing.name, data: variable.data, dataTool: variable.dataTool };
    }
    variable.data = result.variable.data;
    variable.dataType = result.variable.dataType;
    variable.isConstant = result.variable.isConstant;
    variable.dataTool = result.variable.dataTool;

    const dependents = document.getElementById('data-tool-live-chain')?.checked === false
        ? []
        : this._dataToolDependents(fileId, editing.name);
    if (dependents.length) this._reapplyDataToolDependents(fileId, data, editing.name);

    // updateFileData already rebuilds every panel using this file and restores the
    // view it captured. Rebuilding again on top of it is what LOST the zoom: the
    // second capture ran before the first restore had been applied, so it recorded
    // the autoranged view and pinned that. The point of a live preview is to watch
    // a parameter's effect where you zoomed in, so one rebuild it is.
    this.plotManager.updateFileData(fileId, data);
};

proto._restoreEditedTraceValues = function() {
    const backup = this._dataToolEditBackup;
    this._dataToolEditBackup = null;
    if (!backup) return;
    const data = this.plotManager.files.get(backup.fileId)?.data;
    const variable = data?.variables?.[backup.name];
    if (!variable) return;
    variable.data = backup.data;
    variable.dataType = this.parser._detectDataType(backup.data, 'variable');
    variable.isConstant = this.parser._isConstantValues(backup.data);
    variable.dataTool = backup.dataTool;
    this._reapplyDataToolDependents(backup.fileId, data, backup.name);
    this.plotManager.updateFileData(backup.fileId, data);
};

// The draft preview goes through the ordinary trace machinery, under a reserved
// name flagged `previewOnly`. Hand-drawing it onto Plotly instead would mean
// re-deriving the x axis (file transform, calendar vs elapsed, decimation) and
// getting it subtly wrong — a preview that misleads is worse than none. The flag
// is what keeps the placeholder out of the tree, the pickers and saved sessions;
// `_clearDataToolPreview` is what keeps it from outliving the draft.
proto._drawDataToolPreviewTrace = function(context, result) {
    const panelId = this._dataToolPreviewPanelId(context);
    if (panelId === null) {
        this._clearDataToolPreview();
        return;
    }
    const { fileId, data } = context;
    const name = DATA_TOOL_PREVIEW_NAME;
    data.variables[name] = {
        ...result.variable,
        name,
        displayName: context.outputName,
        description: '',
        previewOnly: true,
    };

    const plot = this.plotManager.plots.get(panelId);
    const existing = plot?.traces.find(trace => trace.fileId === fileId && trace.varName === name);
    // updateFileData rebuilds the panel and restores its view, so an existing
    // preview trace redraws with the zoom intact and needs nothing further.
    this.plotManager.updateFileData(fileId, data);
    if (!existing) {
        const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
        if (!panelEl) return;
        this.plotManager.addTrace(panelId, name, panelEl);
        const added = plot?.traces.find(trace => trace.fileId === fileId && trace.varName === name);
        if (added) {
            added.dash = 'dot';
            this.plotManager._rebuildPanel(panelId, { preserveView: true });
        }
    }
    this._dataToolPreview = { fileId, panelId };
};

// Only preview against a panel that already draws the source, so the dashed
// curve appears next to what it was computed from.
proto._dataToolPreviewPanelId = function(context) {
    for (const [id, plot] of this.plotManager.plots) {
        if (plot.mode !== 'timeseries' || !plot.div) continue;
        if (plot.traces.some(trace => trace.fileId === context.fileId
            && (trace.varName === context.sourceName || trace.varName === DATA_TOOL_PREVIEW_NAME))) return id;
    }
    return null;
};

proto._clearDataToolPreview = function() {
    if (this._dataToolPreviewTimer) {
        clearTimeout(this._dataToolPreviewTimer);
        this._dataToolPreviewTimer = null;
    }
    const preview = this._dataToolPreview;
    this._dataToolPreview = null;
    if (!preview || this._clearingDataToolPreview) return;
    // Taking the trace down rebuilds the panel, which re-enters _syncDataTools;
    // the guard keeps that from recursing back into this teardown.
    this._clearingDataToolPreview = true;
    try {
        const data = this.plotManager?.files.get(preview.fileId)?.data;
        this._removeDataToolVariableFromPlots(preview.fileId, DATA_TOOL_PREVIEW_NAME);
        if (data?.variables?.[DATA_TOOL_PREVIEW_NAME]) {
            delete data.variables[DATA_TOOL_PREVIEW_NAME];
            this.plotManager.updateFileData(preview.fileId, data);
        }
    } finally {
        this._clearingDataToolPreview = false;
    }
};

proto._toggleOutlierHelpPopover = function(show) {
    const popover = document.getElementById('outlier-help-popover');
    const button = document.getElementById('outlier-help-toggle');
    if (!popover || !button) return;
    const willShow = typeof show === 'boolean' ? show : popover.hidden;
    popover.hidden = !willShow;
    button.classList.toggle('active', willShow);
    button.setAttribute('aria-expanded', String(willShow));
};

// Keep HOW to produce the text, not the text. The panel message is written
// imperatively, so it carries no data-i18n attribute for the language sweep to
// find, and a message already on screen used to stay in the previous language
// until something else replaced it. Call sites that pass a function get
// re-rendered on a language switch; the ones that pass a plain string (an
// exception's own message) simply keep it, which is all we can do for text that
// was never translated to begin with.
proto._setOutlierMessage = function(message, type) {
    this._dataToolMessage = { message, type };
    this._renderDataToolMessage();

    // A success notice reports something that already happened; leaving it up
    // makes it read as the current state of a panel the user has since moved on
    // from. Errors stay: they describe a condition still in effect.
    if (this._dataToolMessageTimer) {
        clearTimeout(this._dataToolMessageTimer);
        this._dataToolMessageTimer = null;
    }
    if (type === 'ok' && typeof setTimeout === 'function') {
        const shown = this._dataToolMessage;
        this._dataToolMessageTimer = setTimeout(() => {
            this._dataToolMessageTimer = null;
            if (this._dataToolMessage === shown) this._setOutlierMessage('', '');
        }, 6000);
    }
};

proto._renderDataToolMessage = function() {
    const el = document.getElementById('outlier-message');
    if (!el) return;
    const { message, type } = this._dataToolMessage || {};
    el.textContent = (typeof message === 'function' ? message() : message) || '';
    el.className = `derived-message data-tool-message${type ? ' ' + type : ''}`;
};

proto._outlierDetectorDescription = function(config) {
    if (config.method === 'bounds') {
        const lower = config.params.lower ?? '-inf';
        const upper = config.params.upper ?? 'inf';
        return `bounds [${lower}, ${upper}]`;
    }
    if (config.method === 'iqr') {
        return `IQR factor ${this._formatOutlierNumber(config.params.factor, 1)}`;
    }
    return `spike/dropout sensitivity ${config.params.sensitivity}`;
};

// Numeric helpers shared with the kernels. The definitions moved to
// src/compute/kernels/shared.js so the worker can use them; these stay as
// aliases because the UI code above calls them on `this` in a dozen places.
proto._quantileSorted = function(sorted, p) {
    return kernelShared.quantileSorted(sorted, p);
};

proto._zeroMadTolerance = function(median) {
    return kernelShared.zeroMadTolerance(median);
};

proto._positiveNumber = function(value, fallback) {
    return kernelShared.positiveNumber(value, fallback);
};

proto._normalizeSensitivity = function(value) {
    return kernelShared.normalizeSensitivity(value);
};

proto._normalizeMovingAverageWindow = function(value, maxLength = Infinity) {
    return kernelShared.normalizeMovingAverageWindow(value, maxLength);
};

proto._spikeParamsFromSensitivity = function(sensitivity) {
    return kernelShared.spikeParamsFromSensitivity(sensitivity);
};

proto._sensitivityFromLegacyThreshold = function(threshold) {
    return this._normalizeSensitivity(12 - this._positiveNumber(threshold, 6));
};

// Significant digits, not decimal places: a drift of 3e-7 per second and one of
// 4.2e4 per second are both real, and %.2f renders the first as "0.00".
function formatSignificant(value, digits = 4) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '?';
    if (n === 0) return '0';
    const abs = Math.abs(n);
    if (abs >= 1e6 || abs < 1e-4) return n.toExponential(3);
    return String(Number(n.toPrecision(digits)));
}

proto._formatOutlierNumber = function(value, digits = 2) {
    const number = Number(value);
    if (!Number.isFinite(number)) return '';
    return Number.isInteger(number) ? String(number) : number.toFixed(digits);
};

}
