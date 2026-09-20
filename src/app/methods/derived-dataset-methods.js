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
//   · edited (from its row in the Transformations table): the tool reopens
//     with the recipe's parameters, and Update recomputes the dataset in
//     place, so panels showing it follow;
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
import { datasetFailureText } from '../../utils/reload-report.js';

// One frame, so a message written just before is on screen before the main
// thread is taken by synchronous work.
const nextFrame = () => new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 0);
});

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
    if (recipe.tool === 'collapse') return this._computeCollapseDataset(recipe.sourceFileId, sourceData, recipe);
    throw new Error(`Unknown derived-dataset tool: ${recipe.tool}`);
};

/**
 * Recompute one derived dataset in place. Panels drawing it are rebuilt by
 * updateFileData; the tree and the list are refreshed here.
 *
 * `options.failures`, when given, collects `{ name, reason }` for every dataset
 * that could not be recomputed. That is what lets a caller who is in the middle
 * of something — a reload, with its overlay up — say so afterwards instead of
 * stopping to ask (#50).
 *
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
        const name = this._fileDisplayName(entry);
        // The tools throw a DataToolError whose message is a translation key,
        // so the reason is translated here rather than printed raw.
        const reason = datasetFailureText(err, key => i18n.t(key));
        options.failures?.push({ name, reason });
        if (!options.silent) {
            await Modal.alert(
                i18n.t('derivedDatasetRecomputeFailedTitle'),
                reason
                    ? i18n.t('derivedDatasetRecomputeFailed').replace('{name}', name).replace('{error}', reason)
                    : i18n.t('derivedDatasetRecomputeFailedNoReason').replace('{name}', name),
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
 *
 * Opening is not free: switching to the source re-renders the tree and the
 * files list, and the tool's sync measures the source axis (a sort of every
 * Δt, on a large file a good fraction of a second). The message line says
 * "opening" before any of that starts and the Create buttons go dead, so a
 * pause of a couple of seconds on a long file is a visible one.
 */
proto._editDerivedDataset = async function(fileId) {
    const entry = this.files.get(fileId);
    const recipe = this._derivedDatasetRecipe(entry);
    if (!recipe || !this.files.has(recipe.sourceFileId)) return false;
    const stopBusy = this._beginDataToolBusy?.({
        immediate: true,
        message: () => i18n.t('derivedDatasetEditOpening').replace('{name}', entry.name),
    }) || (() => {});
    try {
        await nextFrame();
        // The user may have moved on while the frame was pending.
        if (!this.files.has(fileId) || !this.files.has(recipe.sourceFileId)) return false;
        if (this.activeFileId !== recipe.sourceFileId) this.setActiveFile(recipe.sourceFileId);
        this._exitDataToolEditing?.();
        this._clearDataToolDraft?.();
        this._datasetEditing = { fileId, name: entry.name };
        const toolSelect = document.getElementById('data-tool-select');
        if (toolSelect) toolSelect.value = recipe.tool;
        this._syncDataTools?.();
        if (recipe.tool === 'resample') this._writeResampleForm?.(recipe, entry.name);
        if (recipe.tool === 'xcorr') this._writeXcorrForm?.(recipe, entry.name);
        if (recipe.tool === 'collapse') this._writeCollapseForm?.(recipe, entry.name);
        this._syncDataTools?.();
        // The pencil sits in the Transformations table, below the form it just
        // filled: bring the form up and say what is going on. Written before
        // the busy state ends, so it is the line that stays.
        this._setOutlierMessage?.(() => i18n.t('derivedDatasetEditHint').replace('{name}', entry.name), '');
        document.querySelector?.('.data-tools-section')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
        return true;
    } finally {
        stopBusy();
    }
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
    if (recipe.tool === 'collapse') return this._collapseRecipeDescription?.(recipe) || 'collapse repeated timestamps';
    return recipe.tool;
};

}
