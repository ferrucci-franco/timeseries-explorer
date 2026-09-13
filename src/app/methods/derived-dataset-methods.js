// Derived datasets: results that live on an axis of their own.
//
// A file has exactly one abscissa, and every plot, cursor and export leans on
// that. So a tool whose result cannot share its source's axis — a resample
// (new Δt), a cross-correlation (lag, not time) — produces a FILE. That part is
// unchanged and is what keeps the plotting machinery unaware of any of this.
//
// What this module adds is that such a file is not an orphan. It carries its
// RECIPE — which tool, which source file, which variables, which parameters —
// and from that recipe it can be:
//
//   · listed in the source file's variable tree, under "Derived datasets",
//     with its own variables ready to drag onto a panel;
//   · edited: the tool reopens with the recipe's parameters, and Update
//     recomputes the dataset in place, so panels showing it follow;
//   · recomputed when the source is reloaded;
//   · saved to a session as a recipe (both view and project sessions), not as
//     a copy of its rows;
//   · closed together with its source, since without the source there is
//     nothing left to recompute from.
//
// The file entry stays what it was — name, extension, transform, the lazy
// `syntheticBytes()` that lets a project save write it out — plus one field:
//
//     entry.derivedDataset = { tool, sourceFileId, sourceName, params }
//
// The per-tool compute lives with the tool (resample-methods.js owns
// `_computeResampleDataset`); this module only knows how to ask for it.

import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';

// How many rows the read-only view shows; the rest is what "save to disk" is for.
export const DATASET_VALUES_ROW_LIMIT = 200;

export function installDerivedDatasetMethods(TargetClass) {
    const proto = TargetClass.prototype;

/** The recipe on a file entry, or null when the file is not a derived dataset. */
proto._derivedDatasetRecipe = function(entryOrId) {
    const entry = typeof entryOrId === 'string' ? this.files.get(entryOrId) : entryOrId;
    const recipe = entry?.derivedDataset;
    return recipe && recipe.tool && recipe.sourceFileId ? recipe : null;
};

proto._isDerivedDataset = function(entryOrId) {
    return !!this._derivedDatasetRecipe(entryOrId);
};

/** [fileId, entry] of every dataset derived from `sourceFileId`, in files order. */
proto._derivedDatasetsOf = function(sourceFileId) {
    const out = [];
    if (!sourceFileId) return out;
    for (const [fileId, entry] of this.files) {
        if (entry?.derivedDataset?.sourceFileId === sourceFileId) out.push([fileId, entry]);
    }
    return out;
};

/** Datasets derived from `sourceFileId`, and from those, and so on. */
proto._derivedDatasetsUnder = function(sourceFileId) {
    const out = [];
    const walk = (id) => {
        for (const item of this._derivedDatasetsOf(id)) {
            out.push(item);
            walk(item[0]);
        }
    };
    walk(sourceFileId);
    return out;
};

/**
 * Compute a dataset from its recipe against the CURRENT data of its source.
 * @returns {Promise<{ data: object, summary: object }|null>} null when the source is gone.
 */
proto._computeDerivedDataset = async function(recipe) {
    const sourceData = recipe?.sourceFileId ? this.plotManager.files.get(recipe.sourceFileId)?.data : null;
    if (!sourceData) return null;
    if (recipe.tool === 'resample') return this._computeResampleDataset(recipe.sourceFileId, sourceData, recipe);
    if (recipe.tool === 'xcorr') return this._computeXcorrDataset(recipe.sourceFileId, sourceData, recipe);
    throw new Error(`Unknown derived-dataset tool: ${recipe.tool}`);
};

/**
 * Recompute one derived dataset in place. Panels drawing it are rebuilt by
 * updateFileData; the tree and the list are refreshed here.
 * @returns {Promise<boolean>} false when the source is gone or the recipe failed.
 */
proto._recomputeDerivedDataset = async function(fileId, options = {}) {
    const entry = this.files.get(fileId);
    const recipe = this._derivedDatasetRecipe(entry);
    if (!recipe) return false;
    let result;
    try {
        result = await this._computeDerivedDataset(recipe);
    } catch (err) {
        if (err?.cancelled) return false;
        if (!options.silent) {
            await Modal.alert(
                i18n.t('derivedDatasetRecomputeFailedTitle'),
                i18n.t('derivedDatasetRecomputeFailed')
                    .replace('{name}', this._fileDisplayName(entry))
                    .replace('{error}', err?.message || String(err)),
                { icon: '⚠️' },
            );
        }
        return false;
    }
    if (!result) return false;
    this._adoptDerivedDatasetData(fileId, result.data);
    // A dataset built from this one is now stale in turn.
    for (const [childId] of this._derivedDatasetsOf(fileId)) {
        await this._recomputeDerivedDataset(childId, options);
    }
    if (!options.deferUi) this._refreshDerivedDatasetUi();
    return true;
};

/** Replace the rows of a derived dataset, keeping its identity and its recipe. */
proto._adoptDerivedDatasetData = function(fileId, data) {
    const entry = this.files.get(fileId);
    if (!entry) return;
    entry.syntheticBytes = () => this._resampleCsvBytes(data);
    // Whatever was written out before this rewrite is now a copy of data that
    // no longer exists here, so the row stops claiming it.
    entry.savedCopyName = '';
    this.plotManager.updateFileData(fileId, data);
};

proto._refreshDerivedDatasetUi = function() {
    if (typeof document === 'undefined') return;
    this._renderFilesList?.();
    const active = this.activeFileId ? this.plotManager.files.get(this.activeFileId)?.data : null;
    if (active?.tree) this.renderVariablesTree(active.tree);
    this._renderDataToolTable?.();
};

/** Recompute every dataset derived (directly) from a source whose data changed. */
proto._recomputeDerivedDatasetsOf = async function(sourceFileId, options = {}) {
    for (const [fileId] of this._derivedDatasetsOf(sourceFileId)) {
        await this._recomputeDerivedDataset(fileId, { ...options, deferUi: true });
    }
    if (!options.deferUi) this._refreshDerivedDatasetUi();
};

/**
 * Open the tool that made a dataset, with its recipe in the form. Committing
 * then recomputes the dataset in place instead of making a second file.
 */
proto._editDerivedDataset = function(fileId) {
    const entry = this.files.get(fileId);
    const recipe = this._derivedDatasetRecipe(entry);
    if (!recipe || !this.files.has(recipe.sourceFileId)) return;
    if (this.activeFileId !== recipe.sourceFileId) this.setActiveFile(recipe.sourceFileId);
    this._exitDataToolEditing?.();
    this._clearDataToolDraft?.();
    this._datasetEditing = { fileId, name: entry.name };
    const toolSelect = document.getElementById('data-tool-select');
    if (toolSelect) toolSelect.value = recipe.tool;
    this._syncDataTools?.();
    if (recipe.tool === 'resample') this._writeResampleForm?.(recipe, entry.name);
    if (recipe.tool === 'xcorr') this._writeXcorrForm?.(recipe, entry.name);
    this._syncDataTools?.();
    // The pencil sits in the tree or the files list, a screen away from the
    // form it just filled: bring the form up and say what is going on.
    this._setOutlierMessage?.(() => i18n.t('derivedDatasetEditHint').replace('{name}', entry.name), '');
    document.querySelector?.('.data-tools-section')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
};

// ─── Reading the values ───────────────────────────────────────────────────
// A dataset the app computed has no file to adjust the parsing of, but its
// rows are still worth a look. This is a read-only table: the first rows,
// the parameters, and a note on where the rest is.

proto._datasetValuesTable = function(fileId, limit = DATASET_VALUES_ROW_LIMIT) {
    const data = this.plotManager.files.get(fileId)?.data;
    if (!data) return null;
    const timeName = data.metadata?.timeName;
    const abscissa = timeName ? data.variables?.[timeName] : null;
    const isDatetime = data.metadata?.timeKind === 'datetime';
    const columns = [];
    if (abscissa) columns.push([timeName, abscissa]);
    for (const [name, variable] of Object.entries(data.variables || {})) {
        if (name === timeName || variable?.kind !== 'variable' || variable?.previewOnly) continue;
        columns.push([name, variable]);
    }
    const parameters = Object.entries(data.variables || {}).filter(([, variable]) => variable?.kind === 'parameter');
    const total = Number(data.metadata?.numTimesteps) || Number(abscissa?.data?.length) || 0;
    const shown = Math.min(total, limit);
    const unitOf = variable => (String(variable?.description || '').match(/\[([^\]]+)\]/) || [])[1] || '';
    const format = (value, datetime) => {
        if (value === null || value === undefined) return '';
        if (datetime) return Number.isFinite(value) ? new Date(value).toISOString() : '';
        if (typeof value === 'number') return Number.isFinite(value) ? String(Number(value.toPrecision(7))) : (Number.isNaN(value) ? 'NaN' : String(value));
        return String(value);
    };
    const rows = [];
    for (let r = 0; r < shown; r++) {
        rows.push(columns.map(([name, variable]) => format(variable.data?.[r], name === timeName && isDatetime)));
    }
    return {
        headers: columns.map(([name, variable]) => (unitOf(variable) ? `${name} [${unitOf(variable)}]` : name)),
        rows,
        parameters: parameters.map(([name, variable]) => ({
            name,
            value: format(variable.data?.[0], false),
            unit: unitOf(variable),
        })),
        shown,
        total,
    };
};

proto.showDatasetValues = async function(fileId) {
    const entry = this.files.get(fileId);
    const table = this._datasetValuesTable(fileId);
    if (!entry || !table) return;
    const escape = value => this._escapeSessionHTML(String(value));
    const head = table.headers.map(h => `<th>${escape(h)}</th>`).join('');
    const body = table.rows.map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('');
    const parameters = table.parameters.length
        ? `<div class="dataset-values-params"><span class="dataset-values-params-label">${escape(i18n.t('derivedDatasetValuesParams'))}</span> ${
            table.parameters.map(p => `<code>${escape(p.name)} = ${escape(p.value)}${p.unit ? ` ${escape(p.unit)}` : ''}</code>`).join(' · ')}</div>`
        : '';
    const note = i18n.t('derivedDatasetValuesNote')
        .replace('{shown}', String(table.shown))
        .replace('{total}', String(table.total));
    const html = `
        <div class="dataset-values-note">${escape(note)}</div>
        ${parameters}
        <div class="dataset-values-scroll"><table class="dataset-values-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>
    `;
    await Modal.alert(
        i18n.t('derivedDatasetValuesTitle').replace('{name}', this._fileDisplayName(entry)),
        html,
        { icon: '▦', html: true, className: 'modal-dialog-dataset-values' },
    );
};

proto._exitDerivedDatasetEditing = function() {
    this._datasetEditing = null;
};

/** Close a derived dataset, asking first when a panel is drawing it. */
proto._removeDerivedDataset = async function(fileId) {
    if (!this._isDerivedDataset(fileId)) return false;
    await this.removeFile(fileId);
    return !this.files.has(fileId);
};

/**
 * Closing a source closes what was derived from it: without the source there
 * is no recipe left to recompute, and a frozen copy would be the very thing
 * this module exists to replace. Asked once, with the count.
 * @returns {Promise<boolean>} whether the close may go ahead.
 */
proto._confirmClosingDerivedDatasets = async function(sourceFileId) {
    const dependents = this._derivedDatasetsUnder(sourceFileId);
    if (!dependents.length) return true;
    const names = dependents.map(([, entry]) => this._fileDisplayName(entry));
    const key = dependents.length === 1 ? 'derivedDatasetCloseWithSourceOne' : 'derivedDatasetCloseWithSource';
    return Modal.confirm(
        i18n.t(key)
            .replace('{count}', String(dependents.length))
            .replace('{names}', names.join(', ')),
        { icon: '⚠️' },
    );
};

/** Close every dataset under a source, deepest first, without further prompts. */
proto._closeDerivedDatasetsUnder = async function(sourceFileId) {
    const dependents = this._derivedDatasetsUnder(sourceFileId).reverse();
    for (const [fileId] of dependents) {
        if (this.files.has(fileId)) await this.removeFile(fileId, { cascade: true });
    }
};

/**
 * The recipe as a session stores it. The source is implied by where the
 * record sits (under the source file's metadata); the id is kept so panels
 * that reference the dataset can be mapped back after the restore.
 */
proto._serializeDerivedDataset = function(fileId) {
    const entry = this.files.get(fileId);
    const recipe = this._derivedDatasetRecipe(entry);
    if (!recipe) return null;
    return {
        id: fileId,
        name: entry.name,
        extension: entry.extension || '.csv',
        tool: recipe.tool,
        sourceName: recipe.sourceName || '',
        params: this._cloneSerializable(recipe.params || {}),
        transform: this._normalizeFileTransform(entry.transform),
        invertedVariables: [...(this.plotManager.files.get(fileId)?.invertedVariables || [])],
        transformPanelExpanded: !!this._expandedFileTransforms?.has(fileId),
        // Datasets built from this one, so a chain restores in order.
        derivedDatasets: this._derivedDatasetsOf(fileId)
            .map(([childId]) => this._serializeDerivedDataset(childId))
            .filter(Boolean),
    };
};

/**
 * Rebuild the datasets a session recorded under a source file, once that file
 * (and its generated variables) is in place. Adds each new id to `fileMap`
 * under the id the session used, so plots referencing it resolve.
 */
proto._restoreDerivedDatasets = async function(records, sourceFileId, fileMap) {
    for (const record of records || []) {
        if (!record?.tool || !record?.name) continue;
        const recipe = {
            tool: record.tool,
            sourceFileId,
            sourceName: record.sourceName || '',
            params: this._cloneSerializable(record.params || {}),
        };
        let fileId = null;
        try {
            const result = await this._computeDerivedDataset(recipe);
            if (!result) continue;
            fileId = this._registerDerivedDataset(recipe, record.name, result.data, { deferUi: true }).fileId;
        } catch (err) {
            console.warn('[session] could not rebuild derived dataset', record.name, err?.message || err);
            continue;
        }
        const entry = this.files.get(fileId);
        if (entry && record.transform) {
            entry.transform = this._normalizeFileTransform(record.transform);
            this.plotManager.setFileTransform?.(fileId, entry.transform);
        }
        const plotEntry = this.plotManager.files.get(fileId);
        if (plotEntry) {
            plotEntry.invertedVariables = new Set(
                (record.invertedVariables || []).filter(name => !!plotEntry.data?.variables?.[name]),
            );
            plotEntry._transformCache = null;
        }
        this._expandedFileTransforms ||= new Set();
        if (record.transformPanelExpanded) this._expandedFileTransforms.add(fileId);
        if (record.id) fileMap.set(record.id, fileId);
        await this._restoreDerivedDatasets(record.derivedDatasets, fileId, fileMap);
    }
};

/**
 * Register a computed dataset as a file entry carrying its recipe. A dataset
 * with the same name under the same source is rewritten in place — re-running
 * with a different Δt must not leave a trail of near-duplicate files behind.
 * @returns {{ fileId: string, replaced: boolean }}
 */
proto._registerDerivedDataset = function(recipe, name, data, options = {}) {
    const existingId = options.fileId && this.files.has(options.fileId)
        ? options.fileId
        : this._findDerivedDatasetByName(recipe.sourceFileId, name);
    if (existingId) {
        const entry = this.files.get(existingId);
        entry.name = name;
        entry.derivedDataset = { ...recipe, params: this._cloneSerializable(recipe.params || {}) };
        this._adoptDerivedDatasetData(existingId, data);
        if (!options.deferUi) this._refreshDerivedDatasetUi();
        return { fileId: existingId, replaced: true };
    }

    const fileId = `f${this._nextFileId++}`;
    const transform = this._defaultFileTransform();
    this.files.set(fileId, {
        file: null,
        fileHandle: null,
        localPath: '',
        temporaryParquetPath: '',
        buffer: null,
        contentHash: '',
        name,
        // The bytes below really are CSV, so a project session can still write
        // the dataset out, and "save as file" hands the user a CSV.
        extension: '.csv',
        transform,
        excel: null,
        matlab: null,
        resampledFrom: recipe.sourceFileId,
        derivedDataset: { ...recipe, params: this._cloneSerializable(recipe.params || {}) },
        syntheticBytes: () => this._resampleCsvBytes(data),
    });
    // The source stays the active file: that is where the new dataset shows up
    // (under "Derived datasets"), and where the user was working.
    const previousActive = this.plotManager.activeFileId;
    // `deferRebuild`: the caller is about to re-render the layout itself (a
    // panel opened for the new dataset), which redraws every panel once; a
    // rebuild here as well would race it inside Plotly.
    this.plotManager.addFile(fileId, name, data, transform, { deferRebuild: !!options.deferUi || !!options.deferRebuild });
    if (previousActive && this.plotManager.files.has(previousActive)) this.plotManager.setActiveFile(previousActive);
    if (!options.deferUi) {
        if (typeof document !== 'undefined') document.getElementById('drop-zone')?.classList.remove('active');
        this._updateTopBar?.();
        this._refreshDerivedDatasetUi();
        this._updateActionButtons?.();
    }
    return { fileId, replaced: false };
};

proto._findDerivedDatasetByName = function(sourceFileId, name) {
    for (const [fileId, entry] of this._derivedDatasetsOf(sourceFileId)) {
        if (entry.name === name) return fileId;
    }
    return null;
};

/** A plain-English line for the transformations table and tooltips. */
proto._derivedDatasetDescription = function(recipe) {
    if (!recipe) return '';
    if (recipe.tool === 'resample') return this._resampleRecipeDescription?.(recipe) || 'resample';
    if (recipe.tool === 'xcorr') return this._xcorrRecipeDescription?.(recipe) || 'cross-correlation';
    return recipe.tool;
};

}
