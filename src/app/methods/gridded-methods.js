// The gridded dataset view: a map of a gridded netCDF file (ERA5, CMIP, ...)
// over the plot area, with a time slider, a level selector and two tools —
// a point and a box — whose results become ordinary variables of the file in
// the explorer, where FFT, integrals, heatmaps and cursors already work.
//
// The data never comes to this thread whole. src/gridded/ holds the files open
// in a worker, by parts; this side asks for one map at a time, or for one
// extraction, and draws. See docs/netcdf-gridded-viewer-spec.md (§4.4).

import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';
import Plotly from '../../vendor/plotly.js';
import { griddedClient, nextDatasetId } from '../../gridded/gridded-client.js';
import { extractZipEntry, isNetcdfEntryName, listZipEntries } from '../../gridded/zip-reader.js';
import { NETCDF_READABLE_KINDS, sniffNetcdfContainer } from '../../parsers/netcdf-sniff.js';

const GRIDDED_EXTENSIONS = new Set(['.nc', '.nc4', '.netcdf', '.cdf', '.zip']);
// Above this many cells a map is drawn decimated to the screen; zooming in
// reads the full resolution of what is visible.
const MAX_DRAWN_CELLS = 400 * 1000;
const PALETTES = ['Viridis', 'Cividis', 'Turbo', 'RdBu', 'Greys'];
const PLAY_SPEEDS = [1, 2, 4, 8];
const COASTLINE_FILES = { coarse: 'geo/natural-earth-110m.json', fine: 'geo/natural-earth-50m.json' };
// Zoomed in past this longitude span, the 1:50m coastline replaces the 1:110m one.
const FINE_COAST_SPAN_DEGREES = 70;

const coastlineCache = new Map();

function loadCoastlines(scale) {
    if (!coastlineCache.has(scale)) {
        const base = (typeof window !== 'undefined' && window.__OMV_PUBLIC_BASE__) || './';
        coastlineCache.set(scale, fetch(`${base}${COASTLINE_FILES[scale]}`)
            .then(response => (response.ok ? response.json() : null))
            .catch(() => null));
    }
    return coastlineCache.get(scale);
}

/**
 * Coastline polylines as one x/y pair of arrays with null breaks, shifted into
 * the map's longitude convention (a 0..360 grid that could not be rolled keeps
 * 0..360, so the coast goes there too) and cut where a line jumps the seam.
 */
export function coastlineTrace(lines, lonMin, lonMax) {
    const shift = lonMax > 180;
    const x = [];
    const y = [];
    for (const line of lines || []) {
        let previous = null;
        for (let index = 0; index < line.length; index += 2) {
            let lon = line[index];
            const lat = line[index + 1];
            if (shift && lon < 0) lon += 360;
            if (previous !== null && Math.abs(lon - previous) > 180) {
                x.push(null);
                y.push(null);
            }
            x.push(lon);
            y.push(lat);
            previous = lon;
        }
        x.push(null);
        y.push(null);
    }
    // Margin so lines leaving the frame are not cut short of it.
    return { x, y, lonMin, lonMax };
}

/**
 * The part of a map to draw for a given view window, decimated by an integer
 * stride so the browser never paints more than MAX_DRAWN_CELLS bricks.
 */
export function drawableGrid(map, xRange = null, yRange = null, maxCells = MAX_DRAWN_CELLS) {
    const window = (axis, range) => {
        if (!range) return [0, axis.length - 1];
        const [low, high] = range[0] <= range[1] ? range : [range[1], range[0]];
        let start = 0;
        while (start < axis.length - 1 && axis[start + 1] < low) start += 1;
        let stop = axis.length - 1;
        while (stop > 0 && axis[stop - 1] > high) stop -= 1;
        return stop >= start ? [start, stop] : [0, axis.length - 1];
    };
    const [x0, x1] = window(map.lon, xRange);
    const [y0, y1] = window(map.lat, yRange);
    const width = x1 - x0 + 1;
    const height = y1 - y0 + 1;
    const stride = Math.max(1, Math.ceil(Math.sqrt((width * height) / maxCells)));
    const xs = [];
    for (let column = x0; column <= x1; column += stride) xs.push(column);
    const ys = [];
    for (let row = y0; row <= y1; row += stride) ys.push(row);
    const z = ys.map(row => {
        const out = new Float32Array(xs.length);
        const base = row * map.nx;
        for (let index = 0; index < xs.length; index++) out[index] = map.values[base + xs[index]];
        return out;
    });
    return {
        x: Float64Array.from(xs, column => map.lon[column]),
        y: Float64Array.from(ys, row => map.lat[row]),
        z,
        stride,
    };
}

function formatCoordinate(value, positive, negative) {
    if (!Number.isFinite(value)) return '?';
    const rounded = Math.round(Math.abs(value) * 100) / 100;
    return `${rounded}°${value >= 0 ? positive : negative}`;
}

function csvCell(value) {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFileStem(name) {
    return String(name || 'map').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'map';
}

function treeNode(name, type = 'component', fullName = name) {
    return { _type: type, _name: name, _fullName: fullName, _children: Object.create(null), _variables: Object.create(null) };
}

export function installGriddedMethods(TargetClass) {
    const proto = TargetClass.prototype;

    proto._isGriddedCandidateExtension = function(extension) {
        return GRIDDED_EXTENSIONS.has(String(extension || '').toLowerCase());
    };

    proto._griddedState = function() {
        if (!this._gridded) this._gridded = { views: new Map(), visibleFileId: null };
        return this._gridded;
    };

    // ─── Opening ──────────────────────────────────────────────────────────

    proto._griddedContainerMessage = function(kind, fileName) {
        const keys = {
            zip: 'griddedErrorZip',
            grib: 'griddedErrorGrib',
            gzip: 'griddedErrorGzip',
            html: 'griddedErrorHtml',
            json: 'griddedErrorHtml',
            pdf: 'griddedErrorNotData',
            png: 'griddedErrorNotData',
            jpeg: 'griddedErrorNotData',
            empty: 'griddedErrorEmpty',
        };
        return i18n.t(keys[kind] || 'griddedErrorUnknown').replace('{file}', fileName || '');
    };

    proto._sniffFileHead = async function(file) {
        const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
        return sniffNetcdfContainer(head).kind;
    };

    /**
     * Load-batch step, before the loading overlay: ZIP archives are listed and
     * the chosen entries extracted; files that are not data at all are
     * reported in words; gridded files are opened (header only) so that
     * several of them can be offered as one dataset joined in time.
     */
    proto._expandNetcdfEntries = async function(entries) {
        const expanded = [];
        const opened = [];
        for (const item of entries || []) {
            const fileHandle = item?.fileHandle || null;
            let file = item?.file || (fileHandle ? null : item);
            const sourceName = file?.name || fileHandle?.name || '';
            const extension = this._fileExtension(sourceName);
            if (!this._isGriddedCandidateExtension(extension) || item?.netcdfAsSeries) {
                expanded.push(item);
                continue;
            }
            try {
                if (!file && fileHandle?.getFile) file = await fileHandle.getFile();
                if (!file) continue;
                const kind = await this._sniffFileHead(file);
                if (kind === 'zip') {
                    const listed = (await listZipEntries(file)).filter(entry => isNetcdfEntryName(entry.name));
                    if (!listed.length) {
                        // A project archive, or some other ZIP: not ours.
                        if (extension === '.zip') {
                            expanded.push(item);
                            continue;
                        }
                        await Modal.alert(i18n.t('errorLoading'), i18n.t('griddedZipNoNetcdf').replace('{file}', file.name), { icon: '🗜️' });
                        continue;
                    }
                    const members = await this._griddedPickZipEntries(file, listed);
                    if (!members) continue;
                    if (members.files.length > 1 && members.together) {
                        const options = { mode: 'merge-variables', title: this._fileBaseName(file.name) };
                        const result = await this._griddedProbe(members.files, options);
                        if (result?.gridded) {
                            opened.push({ files: members.files, result, options, title: this._fileBaseName(file.name) });
                            continue;
                        }
                    }
                    for (const member of members.files) expanded.push({ file: member, fileHandle: null, localPath: '' });
                    continue;
                }
                if (!NETCDF_READABLE_KINDS.has(kind) && kind !== 'cdf5') {
                    if (extension === '.zip') {
                        expanded.push(item);
                        continue;
                    }
                    await Modal.alert(i18n.t('errorLoading'), this._griddedContainerMessage(kind, file.name), { icon: '🌐' });
                    continue;
                }
                const result = await this._griddedProbe([file], {});
                if (result?.gridded) {
                    opened.push({ files: [file], result, title: this._fileBaseName(file.name), fileHandle, localPath: item?.localPath || '' });
                    continue;
                }
                expanded.push({ ...(item?.file || item?.fileHandle ? item : {}), file, fileHandle, netcdfProbed: true });
            } catch (error) {
                console.error('Error opening netCDF file:', error);
                await Modal.alert(i18n.t('errorLoading'), this._griddedErrorText(error, file?.name || sourceName), { icon: '🌐' });
            }
        }
        const joined = await this._griddedOfferJoin(opened);
        for (const group of joined) expanded.push({ griddedOpen: group, file: group.files[0], fileHandle: group.fileHandle || null, localPath: group.localPath || '' });
        return expanded;
    };

    proto._griddedErrorText = function(error, fileName) {
        if (error?.containerKind) return this._griddedContainerMessage(error.containerKind, fileName);
        if (error?.code === 'GRIDDED_INCOMPATIBLE') return `${i18n.t('griddedErrorIncompatible')}\n\n${error.message}`;
        if (error?.code === 'ZIP_DAMAGED') return i18n.t('griddedErrorZipDamaged').replace('{file}', fileName || '');
        return error?.message || String(error);
    };

    /** Opens the files in the gridded worker; returns null when it cannot be used. */
    proto._griddedProbe = async function(files, options) {
        const datasetId = nextDatasetId();
        const result = await griddedClient().open(datasetId, files, options);
        return { ...result, datasetId };
    };

    proto._griddedPickZipEntries = async function(file, entries) {
        let chosen = entries;
        let together = false;
        if (entries.length > 1) {
            const body = document.createElement('label');
            body.className = 'gridded-zip-together';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            body.append(checkbox, document.createTextNode(` ${i18n.t('griddedZipTogether')}`));
            const picked = await Modal.checklist(i18n.t('griddedZipMessage').replace('{file}', file.name), {
                title: i18n.t('griddedZipTitle'),
                icon: '🗜️',
                className: 'modal-dialog-gridded-zip',
                confirmText: i18n.t('griddedZipOpen'),
                bodyElement: body,
                items: entries.map((entry, index) => ({
                    value: String(index),
                    label: entry.name,
                    note: this._formatBytes(entry.size),
                    checked: true,
                })),
            });
            if (!picked?.length) return null;
            chosen = picked.map(value => entries[Number(value)]);
            together = checkbox.checked && chosen.length > 1;
        }
        this._showFileLoadingOverlay?.(1);
        this._updateFileLoadingOverlay?.(1, 1, file.name, file.size);
        await this._waitForNextPaint?.();
        try {
            const files = [];
            for (const entry of chosen) files.push(await extractZipEntry(file, entry));
            return { files, together };
        } finally {
            this._hideFileLoadingOverlay?.();
        }
    };

    // Several gridded files picked together that hold the same variables on
    // the same grid are usually consecutive downloads (one per month): offer
    // to read them as one dataset along time.
    proto._griddedOfferJoin = async function(opened) {
        if (opened.length < 2) return opened;
        const signature = result => {
            const model = result.model;
            const vars = model.variables.filter(variable => variable.mapable).map(variable => `${variable.key}:${variable.dimNames.filter(name => model.axes[name]?.role !== 't').map(name => `${name}=${model.axes[name]?.size}`).join(',')}`);
            return `${model.primaryTimeDim}|${vars.sort().join(';')}`;
        };
        const first = signature(opened[0].result);
        if (!opened[0].result.model.primaryTimeDim || !opened.every(group => signature(group.result) === first)) return opened;
        const join = await Modal.confirm(i18n.t('griddedJoinMessage').replace('{count}', String(opened.length)), {
            title: i18n.t('griddedJoinTitle'),
            icon: '🌐',
            confirmText: i18n.t('griddedJoinYes'),
            cancelText: i18n.t('griddedJoinNo'),
        });
        if (!join) return opened;
        const files = opened.flatMap(group => group.files);
        try {
            const options = { mode: 'concat-time', title: `${opened[0].title} (+${opened.length - 1})` };
            const result = await this._griddedProbe(files, options);
            for (const group of opened) griddedClient().close(group.result.datasetId);
            return [{ files, result, options, title: options.title }];
        } catch (error) {
            await Modal.alert(i18n.t('errorLoading'), this._griddedErrorText(error, ''), { icon: '🌐' });
            return opened;
        }
    };

    /**
     * Called from loadFile for netCDF-like files that did not come through a
     * load batch (a project being restored, a reload). Returns the registered
     * dataset, or null when the file is not a grid and the series reader
     * should take it.
     */
    proto._maybeOpenGridded = async function(file, extension, options = {}) {
        if (options.netcdfAsSeries || options.netcdfProbed || !this._isGriddedCandidateExtension(extension)) return null;
        if (options.griddedOpen) return this._registerGriddedDataset(options.griddedOpen, options);
        const kind = await this._sniffFileHead(file);
        if (!NETCDF_READABLE_KINDS.has(kind) && kind !== 'cdf5') {
            if (extension === '.zip') return null;
            throw Object.assign(new Error(this._griddedContainerMessage(kind, file.name)), { containerKind: kind });
        }
        const result = await this._griddedProbe([file], {});
        if (!result?.gridded) return null;
        return this._registerGriddedDataset({ files: [file], result, title: this._fileBaseName(file.name) }, options);
    };

    proto._griddedTimeAbscissa = function(model) {
        const axis = model.primaryTimeDim ? model.axes[model.primaryTimeDim] : null;
        if (!axis) {
            return {
                name: 'index', displayName: 'index', data: Float64Array.of(0), kind: 'abscissa',
                timeKind: 'index', timeStepMode: 'index', dataType: 'numeric', isConstant: true,
                interpolation: 'linear', negate: false, source: 'netcdf-gridded',
                description: i18n.t('griddedNoTimeAxis'),
            };
        }
        const datetime = axis.kind === 'datetime';
        return {
            // Named after the file's own time coordinate: it is what the
            // explorer writes under the time axis.
            name: axis.name,
            displayName: axis.name,
            data: Float64Array.from(axis.values),
            kind: 'abscissa',
            timeKind: datetime ? 'datetime' : 'numeric',
            timeDisplayMode: datetime ? 'calendar' : undefined,
            timeOriginMs: datetime ? axis.values[0] : undefined,
            timeSourceStrategy: 'netcdf-cf-time',
            dataType: 'numeric',
            isConstant: axis.values.length < 2,
            interpolation: 'linear',
            negate: false,
            source: 'netcdf-gridded',
            units: datetime ? '' : (axis.unitsLabel || axis.units || ''),
            description: `netCDF coordinate ${axis.name}${axis.unitsLabel ? ` (${axis.unitsLabel})` : ''}`,
        };
    };

    proto._griddedBuildData = function(model, title) {
        const abscissa = this._griddedTimeAbscissa(model);
        const tree = treeNode('', 'root');
        tree._variables[abscissa.displayName] = abscissa;
        const extractions = treeNode(i18n.t('griddedExtractionsNode'));
        extractions._griddedExtractions = true;
        tree._children[extractions._name] = extractions;
        const datasetNode = treeNode(i18n.t('griddedDatasetVariablesNode'), 'metadata');
        for (const variable of model.variables.filter(item => item.mapable)) {
            const shape = variable.dimNames.map((name, index) => `${name}=${variable.shape[index]}`).join(', ');
            datasetNode._variables[variable.name] = {
                name: `grid:@var/${encodeURIComponent(variable.key)}`,
                displayName: variable.name,
                data: [shape],
                description: `${variable.longName || variable.name}${variable.units ? ` [${variable.units}]` : ''} — ${shape}`,
                kind: 'parameter', dataType: 'string', isConstant: true, interpolation: 'constant',
                negate: false, source: 'netcdf-gridded', plottable: false,
            };
        }
        tree._children[datasetNode._name] = datasetNode;
        const attrs = Object.entries(model.globalAttrs || {});
        if (attrs.length) {
            const metadataNode = treeNode(i18n.t('griddedFileMetadataNode'), 'metadata');
            for (const [name, value] of attrs) {
                metadataNode._variables[name] = {
                    name: `grid:@global/${encodeURIComponent(name)}`, displayName: name, data: [value],
                    description: `Global netCDF attribute ${name}`, kind: 'parameter',
                    dataType: typeof value === 'string' ? 'string' : 'numeric', isConstant: true,
                    interpolation: 'constant', negate: false, source: 'netcdf-gridded', plottable: false,
                };
            }
            tree._children[metadataNode._name] = metadataNode;
        }
        const values = abscissa.data;
        return {
            filename: title,
            metadata: {
                format: 'gridded-netcdf',
                source: 'netcdf-gridded',
                gridded: true,
                storageFormat: model.members.map(member => member.storageFormat).join(', '),
                timeName: abscissa.name,
                timeKind: abscissa.timeKind,
                timeDisplayMode: abscissa.timeDisplayMode,
                timeOriginMs: abscissa.timeOriginMs,
                sampleCount: values.length,
                numVariables: 0,
                numParams: 0,
                numTimevarying: 0,
                numTimesteps: values.length,
                timeStart: values[0],
                timeEnd: values[values.length - 1],
                globalAttributes: model.globalAttrs || {},
            },
            variables: { [abscissa.name]: abscissa },
            tree,
        };
    };

    proto._registerGriddedDataset = function(group, options = {}) {
        const { result } = group;
        const model = result.model;
        const fileId = `f${this._nextFileId++}`;
        const baseName = group.title || this._fileBaseName(group.files[0]?.name || 'dataset.nc');
        const data = this._griddedBuildData(model, baseName);
        const transform = this._defaultFileTransform();
        const firstFile = group.files[0];
        this.files.set(fileId, {
            file: group.files.length === 1 ? firstFile : null,
            fileHandle: group.files.length === 1 ? (options.fileHandle || group.fileHandle || null) : null,
            localPath: group.files.length === 1 ? (options.localPath || group.localPath || '') : '',
            temporaryParquetPath: '',
            buffer: null,
            contentHash: firstFile ? this._fileFingerprint(firstFile) : '',
            name: baseName,
            extension: this._fileExtension(firstFile?.name || '.nc'),
            transform,
            excel: null,
            matlab: null,
            gridded: { datasetId: result.datasetId, files: group.files, model, options: group.options || {} },
        });
        this.plotManager.addFile(fileId, baseName, data, transform, { deferRebuild: options.deferPlotRebuild === true });
        const state = this._griddedState();
        state.views.set(fileId, this._griddedInitialView(fileId, result.datasetId, model));
        if (!options.deferUi) {
            document.getElementById('drop-zone')?.classList.remove('active');
            this._updateTopBar();
            this._renderFilesList();
            this._clearVariableSelection();
            this.renderVariablesTree(data.tree);
            this._updateActionButtons();
            this._showGriddedView(fileId);
        }
        return { fileId, data, gridded: true };
    };

    proto._griddedInitialView = function(fileId, datasetId, model) {
        const mapable = model.variables.filter(variable => variable.mapable);
        // The variable with the most dimensions first: a pressure-level field
        // over its surface companions, and never `number` or `expver`.
        const first = [...mapable].sort((a, b) => b.dimNames.length - a.dimNames.length)[0] || null;
        return {
            fileId,
            datasetId,
            model,
            variableKey: first?.key || null,
            selection: {},
            palette: 'Viridis',
            rangeMode: 'auto',
            fixedRange: null,
            manualRange: null,
            tool: 'point',
            playing: false,
            speed: 2,
            map: null,
            zoom: null,
            requestedMap: null,
            mapInFlight: false,
            job: null,
            lastExtraction: [],
            extractionCount: 0,
        };
    };

    /**
     * Reload a gridded dataset: open the file again (its latest version when
     * the app can reach it) and rebuild the dataset. Extractions are dropped —
     * they were cut from the data that just changed.
     */
    proto._griddedReload = async function(fileId) {
        const entry = this.files.get(fileId);
        if (!entry?.gridded) return false;
        let files = entry.gridded.files;
        try {
            if (files.length === 1 && entry.fileHandle?.getFile) files = [await entry.fileHandle.getFile()];
            else if (files.length === 1 && entry.localPath && this.capabilities?.isDesktop) files = [await this._readLocalResultPath(entry.localPath)];
        } catch (error) {
            console.warn('[netcdf] could not read the latest version, reopening the one in hand:', error?.message || error);
        }
        this._showFileLoadingOverlay?.(1);
        this._updateFileLoadingOverlay?.(1, 1, this._fileDisplayName(entry), files[0]?.size);
        let result;
        try {
            result = await this._griddedProbe(files, entry.gridded.options || {});
        } catch (error) {
            await Modal.alert(i18n.t('errorLoading'), this._griddedErrorText(error, files[0]?.name || ''), { icon: '🌐' });
            return true;
        } finally {
            this._hideFileLoadingOverlay?.();
        }
        if (!result?.gridded) {
            griddedClient().close(result?.datasetId);
            await Modal.alert(i18n.t('errorLoading'), i18n.t('griddedErrorUnknown').replace('{file}', files[0]?.name || ''), { icon: '🌐' });
            return true;
        }
        const state = this._griddedState();
        const previous = state.views.get(fileId);
        if (previous) {
            previous.playing = false;
            griddedClient().close(previous.datasetId);
        }
        entry.gridded = { ...entry.gridded, datasetId: result.datasetId, files, model: result.model };
        entry.file = files.length === 1 ? files[0] : entry.file;
        entry.contentHash = files[0] ? this._fileFingerprint(files[0]) : '';
        const data = this._griddedBuildData(result.model, entry.name);
        this.plotManager.updateFileData(fileId, data);
        const view = this._griddedInitialView(fileId, result.datasetId, result.model);
        if (previous && result.model.variables.some(variable => variable.mapable && variable.key === previous.variableKey)) {
            view.variableKey = previous.variableKey;
            view.palette = previous.palette;
            for (const [name, index] of Object.entries(previous.selection)) {
                if (index < (result.model.axes[name]?.size || 0)) view.selection[name] = index;
            }
        }
        state.views.set(fileId, view);
        if (this.plotManager.activeFileId === fileId) this.renderVariablesTree(data.tree);
        if (state.visibleFileId === fileId) this._showGriddedView(fileId);
        return true;
    };

    proto._griddedReleaseFile = function(fileId) {
        const state = this._griddedState();
        const view = state.views.get(fileId);
        if (!view) return;
        view.playing = false;
        if (view.job) griddedClient().cancel(view.job.id);
        griddedClient().close(view.datasetId);
        state.views.delete(fileId);
        if (state.visibleFileId === fileId) this._hideGriddedView();
    };

    // ─── The view ─────────────────────────────────────────────────────────

    proto._griddedEnsureDom = function() {
        let root = document.getElementById('gridded-view');
        if (root) return root;
        root = document.createElement('section');
        root.id = 'gridded-view';
        root.className = 'gridded-view';
        root.hidden = true;
        root.innerHTML = `
            <div class="gridded-toolbar">
                <div class="gridded-title" data-role="title"></div>
                <label class="gridded-field"><span data-role="variable-label"></span><select data-role="variable"></select></label>
                <span class="gridded-dims" data-role="dims"></span>
                <label class="gridded-field"><span data-role="palette-label"></span><select data-role="palette"></select></label>
                <label class="gridded-field"><span data-role="range-label"></span><select data-role="range"></select></label>
                <span class="gridded-manual-range" data-role="manual-range" hidden>
                    <input type="number" step="any" data-role="range-min" aria-label="min">
                    <input type="number" step="any" data-role="range-max" aria-label="max">
                </span>
                <span class="gridded-tools" role="group" data-role="tools">
                    <button type="button" class="gridded-tool" data-tool="pan"></button>
                    <button type="button" class="gridded-tool" data-tool="point"></button>
                    <button type="button" class="gridded-tool" data-tool="box"></button>
                </span>
                <span class="gridded-actions">
                    <button type="button" class="gridded-action" data-action="export-png"></button>
                    <button type="button" class="gridded-action" data-action="export-csv"></button>
                    <button type="button" class="gridded-action" data-action="as-series"></button>
                    <button type="button" class="gridded-action gridded-close" data-action="close"></button>
                </span>
            </div>
            <div class="gridded-body">
                <div class="gridded-map" data-role="map"></div>
            </div>
            <div class="gridded-status" data-role="status" aria-live="polite"></div>
            <div class="gridded-timebar" data-role="timebar">
                <button type="button" class="gridded-step" data-step="first">⏮</button>
                <button type="button" class="gridded-step" data-step="prev">◀</button>
                <button type="button" class="gridded-step gridded-play" data-step="play">▶</button>
                <button type="button" class="gridded-step" data-step="next">▶|</button>
                <button type="button" class="gridded-step" data-step="last">⏭</button>
                <input type="range" min="0" max="0" step="1" value="0" data-role="time">
                <span class="gridded-time-label" data-role="time-label"></span>
                <select data-role="speed" class="gridded-speed"></select>
            </div>
            <div class="gridded-progress" data-role="progress" hidden>
                <span data-role="progress-label"></span>
                <progress max="1" value="0" data-role="progress-bar"></progress>
                <button type="button" data-action="cancel"></button>
            </div>
            <div class="gridded-preview" data-role="preview" hidden>
                <div class="gridded-preview-head">
                    <span data-role="preview-title"></span>
                    <span class="gridded-preview-actions">
                        <button type="button" data-action="plot"></button>
                        <button type="button" data-action="export-series"></button>
                    </span>
                </div>
                <div class="gridded-preview-chart" data-role="preview-chart"></div>
            </div>`;
        const host = document.querySelector('.content-area') || document.body;
        host.appendChild(root);
        this._griddedBindDom(root);
        // The map shares the column with the preview, which comes and goes:
        // Plotly only follows window resizes on its own.
        if (typeof ResizeObserver === 'function') {
            const observer = new ResizeObserver(entries => {
                for (const entry of entries) {
                    if (entry.target._fullLayout && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
                        Plotly.Plots.resize(entry.target);
                    }
                }
            });
            observer.observe(root.querySelector('[data-role="map"]'));
            observer.observe(root.querySelector('[data-role="preview-chart"]'));
        }
        this._griddedRefreshTexts();
        return root;
    };

    proto._griddedEl = function(role) {
        return document.querySelector(`#gridded-view [data-role="${role}"]`);
    };

    proto._griddedVisibleView = function() {
        const state = this._griddedState();
        return state.visibleFileId ? state.views.get(state.visibleFileId) || null : null;
    };

    proto._griddedBindDom = function(root) {
        const view = () => this._griddedVisibleView();
        root.querySelector('[data-role="variable"]').addEventListener('change', event => {
            const current = view();
            if (!current) return;
            current.variableKey = event.target.value;
            current.fixedRange = null;
            current.zoom = null;
            this._griddedRenderControls(current);
            this._griddedRequestMap(current);
        });
        root.querySelector('[data-role="palette"]').addEventListener('change', event => {
            const current = view();
            if (!current) return;
            current.palette = event.target.value;
            this._griddedDrawMap(current);
        });
        root.querySelector('[data-role="range"]').addEventListener('change', event => {
            const current = view();
            if (!current) return;
            current.rangeMode = event.target.value;
            if (current.rangeMode === 'fixed') current.fixedRange = this._griddedCurrentRange(current, 'auto');
            if (current.rangeMode === 'manual') current.manualRange = this._griddedCurrentRange(current, 'auto');
            this._griddedRenderControls(current);
            this._griddedDrawMap(current);
        });
        for (const role of ['range-min', 'range-max']) {
            root.querySelector(`[data-role="${role}"]`).addEventListener('change', () => {
                const current = view();
                if (!current) return;
                const min = Number(this._griddedEl('range-min').value);
                const max = Number(this._griddedEl('range-max').value);
                if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
                    current.manualRange = [min, max];
                    this._griddedDrawMap(current);
                }
            });
        }
        root.querySelectorAll('.gridded-tool').forEach(button => {
            button.addEventListener('click', () => {
                const current = view();
                if (!current) return;
                current.tool = button.dataset.tool;
                this._griddedSyncTools(current);
            });
        });
        root.querySelector('[data-role="time"]').addEventListener('input', event => {
            const current = view();
            if (!current) return;
            const dim = this._griddedTimeDim(current);
            if (!dim) return;
            current.selection[dim] = Number(event.target.value);
            this._griddedSyncTimeLabel(current);
            this._griddedRequestMap(current);
        });
        root.querySelectorAll('.gridded-step').forEach(button => {
            button.addEventListener('click', () => this._griddedStep(button.dataset.step));
        });
        root.querySelector('[data-role="speed"]').addEventListener('change', event => {
            const current = view();
            if (current) current.speed = Number(event.target.value) || 2;
        });
        root.addEventListener('click', event => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (!action) return;
            const current = view();
            if (action === 'close') this._hideGriddedView();
            else if (action === 'cancel' && current?.job) griddedClient().cancel(current.job.id);
            else if (action === 'export-png' && current) this._griddedExportPng(current);
            else if (action === 'export-csv' && current) this._griddedExportMapCsv(current);
            else if (action === 'export-series' && current) this._griddedExportExtractionsCsv(current);
            else if (action === 'plot' && current) this._griddedPlotLastExtraction(current);
            else if (action === 'as-series' && current) this._griddedOpenAsSeries(current.fileId);
        });
        root.addEventListener('keydown', event => {
            if (event.target.closest('input[type="number"], select')) return;
            if (event.key === 'ArrowRight') { this._griddedStep('next'); event.preventDefault(); }
            else if (event.key === 'ArrowLeft') { this._griddedStep('prev'); event.preventDefault(); }
            else if (event.key === ' ' && !event.target.closest('button')) { this._griddedStep('play'); event.preventDefault(); }
        });
    };

    proto._griddedRefreshTexts = function() {
        const root = document.getElementById('gridded-view');
        if (!root) return;
        const set = (selector, key, attr = 'textContent') => {
            const element = root.querySelector(selector);
            if (element) element[attr] = i18n.t(key);
        };
        set('[data-role="variable-label"]', 'griddedVariable');
        set('[data-role="palette-label"]', 'griddedPalette');
        set('[data-role="range-label"]', 'griddedColorRange');
        set('[data-tool="pan"]', 'griddedToolPan');
        set('[data-tool="point"]', 'griddedToolPoint');
        set('[data-tool="box"]', 'griddedToolBox');
        set('[data-tool="pan"]', 'griddedToolPanTitle', 'title');
        set('[data-tool="point"]', 'griddedToolPointTitle', 'title');
        set('[data-tool="box"]', 'griddedToolBoxTitle', 'title');
        set('[data-action="export-png"]', 'griddedExportPng');
        set('[data-action="export-csv"]', 'griddedExportMapCsv');
        set('[data-action="export-csv"]', 'griddedExportMapCsvTitle', 'title');
        set('[data-action="as-series"]', 'griddedOpenAsSeries');
        set('[data-action="as-series"]', 'griddedOpenAsSeriesTitle', 'title');
        set('[data-action="close"]', 'griddedShowPlots');
        set('[data-action="close"]', 'griddedShowPlotsTitle', 'title');
        set('[data-action="cancel"]', 'griddedCancel');
        set('[data-action="plot"]', 'griddedPlotInExplorer');
        set('[data-action="export-series"]', 'griddedExportSeriesCsv');
        set('[data-step="first"]', 'griddedFirstStep', 'title');
        set('[data-step="prev"]', 'griddedPrevStep', 'title');
        set('[data-step="play"]', 'griddedPlay', 'title');
        set('[data-step="next"]', 'griddedNextStep', 'title');
        set('[data-step="last"]', 'griddedLastStep', 'title');
        set('[data-role="speed"]', 'griddedSpeed', 'title');
        const palette = root.querySelector('[data-role="palette"]');
        palette.innerHTML = '';
        for (const name of PALETTES) palette.add(new Option(name, name));
        const range = root.querySelector('[data-role="range"]');
        range.innerHTML = '';
        for (const [value, key] of [['auto', 'griddedRangeAuto'], ['fixed', 'griddedRangeFixed'], ['manual', 'griddedRangeManual']]) {
            range.add(new Option(i18n.t(key), value));
        }
        const speed = root.querySelector('[data-role="speed"]');
        speed.innerHTML = '';
        for (const value of PLAY_SPEEDS) speed.add(new Option(i18n.t('griddedSpeedValue').replace('{fps}', String(value)), String(value)));
        const view = this._griddedVisibleView();
        if (view) {
            this._griddedRenderControls(view);
            this._griddedDrawMap(view);
            this._griddedDrawPreview(view);
        }
    };

    proto._showGriddedView = function(fileId) {
        const state = this._griddedState();
        const view = state.views.get(fileId);
        if (!view) return;
        const root = this._griddedEnsureDom();
        if (state.visibleFileId && state.visibleFileId !== fileId) {
            const previous = state.views.get(state.visibleFileId);
            if (previous) previous.playing = false;
        }
        state.visibleFileId = fileId;
        root.hidden = false;
        document.body.classList.add('gridded-view-open');
        if (this.plotManager.activeFileId !== fileId) this.setActiveFile(fileId);
        this._griddedRenderControls(view);
        this._griddedDrawPreview(view);
        if (view.map) this._griddedDrawMap(view);
        else this._griddedRequestMap(view);
        this._renderFilesList();
    };

    proto._hideGriddedView = function() {
        const state = this._griddedState();
        const view = this._griddedVisibleView();
        if (view) view.playing = false;
        state.visibleFileId = null;
        const root = document.getElementById('gridded-view');
        if (root) root.hidden = true;
        document.body.classList.remove('gridded-view-open');
        this._renderFilesList();
        setTimeout(() => this.plotManager.resizeAll?.(), 30);
    };

    proto._griddedVariable = function(view) {
        return view.model.variables.find(variable => variable.key === view.variableKey) || null;
    };

    proto._griddedTimeDim = function(view) {
        return this._griddedVariable(view)?.timeDim || null;
    };

    proto._griddedRenderControls = function(view) {
        const root = document.getElementById('gridded-view');
        if (!root) return;
        const model = view.model;
        root.querySelector('[data-role="title"]').textContent = this.files.get(view.fileId)?.name || model.title;
        root.querySelector('[data-role="title"]').title = model.members.map(member => `${member.filename} (${member.storageFormat})`).join('\n');
        const select = root.querySelector('[data-role="variable"]');
        select.innerHTML = '';
        for (const variable of model.variables.filter(item => item.mapable)) {
            const label = `${variable.name}${variable.longName && variable.longName !== variable.name ? ` — ${variable.longName}` : ''}${variable.units ? ` [${variable.units}]` : ''}`;
            select.add(new Option(label, variable.key));
        }
        select.value = view.variableKey || '';
        const variable = this._griddedVariable(view);
        const dims = root.querySelector('[data-role="dims"]');
        dims.innerHTML = '';
        if (variable) {
            variable.dimNames.forEach((name, index) => {
                const role = variable.roles[index];
                if (role === 'y' || role === 'x' || role === 't') return;
                const axis = model.axes[name];
                if (!axis || axis.size < 2) return;
                const wrap = document.createElement('label');
                wrap.className = 'gridded-field';
                const caption = document.createElement('span');
                caption.textContent = role === 'z' ? i18n.t('griddedLevel') : name;
                const dimSelect = document.createElement('select');
                dimSelect.dataset.dim = name;
                axis.labels.forEach((labelText, position) => {
                    dimSelect.add(new Option(`${labelText}${role === 'z' && axis.units ? ` ${axis.units}` : ''}`, String(position)));
                });
                dimSelect.value = String(view.selection[name] || 0);
                dimSelect.addEventListener('change', () => {
                    view.selection[name] = Number(dimSelect.value);
                    view.fixedRange = view.rangeMode === 'fixed' ? null : view.fixedRange;
                    this._griddedRequestMap(view);
                });
                wrap.append(caption, dimSelect);
                dims.appendChild(wrap);
            });
        }
        root.querySelector('[data-role="palette"]').value = view.palette;
        root.querySelector('[data-role="range"]').value = view.rangeMode;
        const manual = root.querySelector('[data-role="manual-range"]');
        manual.hidden = view.rangeMode !== 'manual';
        if (view.rangeMode === 'manual' && view.manualRange) {
            this._griddedEl('range-min').value = String(Number(view.manualRange[0].toPrecision(6)));
            this._griddedEl('range-max').value = String(Number(view.manualRange[1].toPrecision(6)));
        }
        root.querySelector('[data-role="speed"]').value = String(view.speed);
        const timeDim = variable?.timeDim;
        const timebar = root.querySelector('[data-role="timebar"]');
        const slider = root.querySelector('[data-role="time"]');
        const size = timeDim ? model.axes[timeDim]?.size || 1 : 1;
        timebar.classList.toggle('gridded-timebar-static', !timeDim || size < 2);
        slider.max = String(Math.max(0, size - 1));
        slider.value = String(timeDim ? view.selection[timeDim] || 0 : 0);
        slider.disabled = !timeDim || size < 2;
        this._griddedSyncTimeLabel(view);
        this._griddedSyncTools(view);
    };

    proto._griddedSyncTimeLabel = function(view) {
        const dim = this._griddedTimeDim(view);
        const label = this._griddedEl('time-label');
        const play = document.querySelector('#gridded-view [data-step="play"]');
        if (play) {
            play.textContent = view.playing ? '⏸' : '▶';
            play.title = i18n.t(view.playing ? 'griddedPause' : 'griddedPlay');
        }
        if (!label) return;
        if (!dim) {
            label.textContent = i18n.t('griddedNoTimeAxis');
            return;
        }
        const axis = view.model.axes[dim];
        const index = view.selection[dim] || 0;
        label.textContent = `${axis.labels[index] ?? index}  (${index + 1}/${axis.size})`;
    };

    proto._griddedSyncTools = function(view) {
        document.querySelectorAll('#gridded-view .gridded-tool').forEach(button => {
            const active = button.dataset.tool === view.tool;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        const div = this._griddedEl('map');
        if (div?._fullLayout) {
            Plotly.relayout(div, { dragmode: view.tool === 'box' ? 'drawrect' : 'pan' });
        }
        this._griddedSetStatus(view.tool === 'point' ? i18n.t('griddedHintPoint')
            : view.tool === 'box' ? i18n.t('griddedHintBox') : i18n.t('griddedHintPan'));
    };

    proto._griddedSetStatus = function(text, isError = false) {
        const status = this._griddedEl('status');
        if (!status) return;
        status.textContent = text || '';
        status.classList.toggle('error', !!isError);
    };

    proto._griddedStep = function(step) {
        const view = this._griddedVisibleView();
        const dim = view ? this._griddedTimeDim(view) : null;
        if (!view || !dim) return;
        const size = view.model.axes[dim].size;
        const current = view.selection[dim] || 0;
        if (step === 'play') {
            view.playing = !view.playing;
            this._griddedSyncTimeLabel(view);
            if (view.playing) this._griddedPlayLoop(view);
            return;
        }
        const next = step === 'first' ? 0 : step === 'last' ? size - 1
            : step === 'next' ? Math.min(size - 1, current + 1) : Math.max(0, current - 1);
        if (next === current) return;
        view.selection[dim] = next;
        this._griddedEl('time').value = String(next);
        this._griddedSyncTimeLabel(view);
        this._griddedRequestMap(view);
    };

    proto._griddedPlayLoop = async function(view) {
        const dim = this._griddedTimeDim(view);
        while (view.playing && dim && this._griddedVisibleView() === view) {
            const started = performance.now();
            const size = view.model.axes[dim].size;
            view.selection[dim] = ((view.selection[dim] || 0) + 1) % size;
            const slider = this._griddedEl('time');
            if (slider) slider.value = String(view.selection[dim]);
            this._griddedSyncTimeLabel(view);
            await this._griddedRequestMap(view);
            const wait = 1000 / Math.max(1, view.speed) - (performance.now() - started);
            if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        }
        view.playing = false;
        this._griddedSyncTimeLabel(view);
    };

    // Requests coalesce: while a map is being read, only the latest selection
    // is remembered, so dragging the slider never queues a backlog.
    proto._griddedRequestMap = function(view) {
        view.requestedMap = { variable: view.variableKey, selection: { ...view.selection } };
        if (view.mapInFlight) return view.mapInFlight;
        view.mapInFlight = (async () => {
            try {
                while (view.requestedMap) {
                    const request = view.requestedMap;
                    view.requestedMap = null;
                    if (!request.variable) break;
                    try {
                        const map = await griddedClient().request('map', { datasetId: view.datasetId, ...request }).promise;
                        view.map = map;
                        view.mapFor = request;
                        if (this._griddedVisibleView() === view) this._griddedDrawMap(view);
                    } catch (error) {
                        this._griddedSetStatus(this._griddedErrorText(error, ''), true);
                        view.playing = false;
                        break;
                    }
                }
            } finally {
                view.mapInFlight = false;
            }
        })();
        return view.mapInFlight;
    };

    proto._griddedCurrentRange = function(view, mode = view.rangeMode) {
        if (mode === 'fixed' && view.fixedRange) return view.fixedRange;
        if (mode === 'manual' && view.manualRange) return view.manualRange;
        const map = view.map;
        if (!map || !Number.isFinite(map.min)) return [0, 1];
        if (map.max === map.min) return [map.min - 0.5, map.max + 0.5];
        return [map.min, map.max];
    };

    proto._griddedColors = function() {
        const dark = this.theme === 'dark';
        return {
            bg: dark ? '#2d2d2d' : '#ffffff',
            font: dark ? '#d0d0d0' : '#333333',
            grid: dark ? '#4a4a4a' : '#e3e3e3',
            coast: dark ? '#f2f2f2' : '#1a1a1a',
            border: dark ? 'rgba(240,240,240,0.55)' : 'rgba(30,30,30,0.45)',
            box: dark ? '#ff8a65' : '#d84315',
        };
    };

    proto._griddedDrawMap = async function(view) {
        const div = this._griddedEl('map');
        const map = view.map;
        if (!div || !map || this._griddedVisibleView() !== view) return;
        const variable = this._griddedVariable(view);
        const colors = this._griddedColors();
        const grid = drawableGrid(map, view.zoom?.x, view.zoom?.y);
        const [zmin, zmax] = this._griddedCurrentRange(view);
        const lonMin = map.lon[0];
        const lonMax = map.lon[map.lon.length - 1];
        const span = view.zoom?.x ? Math.abs(view.zoom.x[1] - view.zoom.x[0]) : Math.abs(lonMax - lonMin);
        const coast = await loadCoastlines(span < FINE_COAST_SPAN_DEGREES ? 'fine' : 'coarse')
            || await loadCoastlines('coarse');
        if (this._griddedVisibleView() !== view) return;
        const units = variable?.units ? ` ${variable.units}` : '';
        const traces = [{
            type: 'heatmap',
            x: grid.x,
            y: grid.y,
            z: grid.z,
            zmin,
            zmax,
            zauto: false,
            colorscale: view.palette,
            reversescale: view.palette === 'RdBu',
            colorbar: { title: { text: variable?.units || '', side: 'right' }, thickness: 14, outlinewidth: 0, tickfont: { color: colors.font } },
            hovertemplate: `%{y:.2f}°, %{x:.2f}°<br>%{z:.5~g}${units}<extra></extra>`,
            hoverongaps: false,
        }];
        if (coast) {
            const borders = coastlineTrace(coast.borders, lonMin, lonMax);
            const coastline = coastlineTrace(coast.coastlines, lonMin, lonMax);
            traces.push({ type: 'scattergl', mode: 'lines', x: borders.x, y: borders.y, line: { color: colors.border, width: 0.6 }, hoverinfo: 'skip', showlegend: false });
            traces.push({ type: 'scattergl', mode: 'lines', x: coastline.x, y: coastline.y, line: { color: colors.coast, width: 1 }, hoverinfo: 'skip', showlegend: false });
        }
        const pad = (low, high, extra) => [low - extra, high + extra];
        const dx = map.lon.length > 1 ? Math.abs(map.lon[1] - map.lon[0]) / 2 : 0.5;
        const dy = map.lat.length > 1 ? Math.abs(map.lat[1] - map.lat[0]) / 2 : 0.5;
        const layout = {
            paper_bgcolor: colors.bg,
            plot_bgcolor: colors.bg,
            font: { color: colors.font, size: 11, family: 'system-ui, sans-serif' },
            margin: { l: 52, r: 10, t: 28, b: 40 },
            showlegend: false,
            dragmode: view.tool === 'box' ? 'drawrect' : 'pan',
            uirevision: `${view.fileId}|${view.variableKey}`,
            // A decimated drawing says so in the title, where it stays visible,
            // rather than in the status line that reports extractions.
            title: {
                text: grid.stride > 1
                    ? `${this._griddedMapTitle(view)}  <span style="font-size:10px;opacity:0.7">(${i18n.t('griddedDecimatedShort').replace('{stride}', String(grid.stride))})</span>`
                    : this._griddedMapTitle(view),
                font: { size: 12 }, x: 0.01, xanchor: 'left',
            },
            xaxis: {
                range: view.zoom?.x || pad(lonMin, lonMax, dx),
                title: { text: i18n.t('griddedLongitude') },
                gridcolor: colors.grid,
                zeroline: false,
                ticksuffix: '°',
            },
            yaxis: {
                range: view.zoom?.y || pad(map.lat[0], map.lat[map.lat.length - 1], dy),
                title: { text: i18n.t('griddedLatitude') },
                gridcolor: colors.grid,
                zeroline: false,
                ticksuffix: '°',
                scaleanchor: 'x',
                scaleratio: 1,
            },
            newshape: { line: { color: colors.box, width: 2 }, fillcolor: 'rgba(216,67,21,0.08)' },
            shapes: view.box ? [{
                type: 'rect', xref: 'x', yref: 'y',
                x0: view.box.lonMin, x1: view.box.lonMax, y0: view.box.latMin, y1: view.box.latMax,
                line: { color: colors.box, width: 2 }, fillcolor: 'rgba(216,67,21,0.08)',
            }] : [],
        };
        const config = { ...(this.plotManager._getPlotlyConfig?.() || {}), displayModeBar: false, scrollZoom: true, responsive: true };
        const first = !div._fullLayout;
        await Plotly.react(div, traces, layout, config);
        if (first) this._griddedBindPlot(div);
    };

    proto._griddedMapTitle = function(view) {
        const variable = this._griddedVariable(view);
        if (!variable) return '';
        const parts = [variable.longName || variable.name];
        variable.dimNames.forEach((name, index) => {
            const role = variable.roles[index];
            if (role === 'y' || role === 'x') return;
            const axis = view.model.axes[name];
            if (!axis) return;
            const label = axis.labels[view.selection[name] || 0];
            parts.push(role === 'z' && axis.units ? `${label} ${axis.units}` : label);
        });
        return parts.join(' · ');
    };

    proto._griddedBindPlot = function(div) {
        div.on('plotly_click', event => {
            const view = this._griddedVisibleView();
            if (!view || view.tool !== 'point') return;
            const point = (event?.points || []).find(item => item.data?.type === 'heatmap') || event?.points?.[0];
            if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
            this._griddedExtractPoint(view, point.y, point.x);
        });
        div.on('plotly_relayout', update => {
            const view = this._griddedVisibleView();
            if (!view || !update) return;
            if (update.shapes || Object.keys(update).some(key => key.startsWith('shapes['))) {
                const shapes = div.layout.shapes || [];
                const shape = shapes[shapes.length - 1];
                if (!shape) return;
                const box = {
                    lonMin: Math.min(shape.x0, shape.x1),
                    lonMax: Math.max(shape.x0, shape.x1),
                    latMin: Math.min(shape.y0, shape.y1),
                    latMax: Math.max(shape.y0, shape.y1),
                };
                const same = view.box && ['lonMin', 'lonMax', 'latMin', 'latMax'].every(key => Math.abs(view.box[key] - box[key]) < 1e-9);
                if (same) return;
                view.box = box;
                this._griddedExtractRegion(view, box);
                return;
            }
            const x0 = update['xaxis.range[0]'];
            const y0 = update['yaxis.range[0]'];
            if (update['xaxis.autorange'] || update.autosize) {
                view.zoom = null;
            } else if (x0 !== undefined || y0 !== undefined) {
                const layout = div._fullLayout;
                view.zoom = { x: [...layout.xaxis.range], y: [...layout.yaxis.range] };
            } else {
                return;
            }
            clearTimeout(view.zoomTimer);
            view.zoomTimer = setTimeout(() => this._griddedDrawMap(view), 120);
        });
    };

    // ─── Extractions ──────────────────────────────────────────────────────

    proto._griddedSelectionSuffix = function(view, variable) {
        const parts = [];
        variable.dimNames.forEach((name, index) => {
            const role = variable.roles[index];
            if (role === 'y' || role === 'x' || role === 't') return;
            const axis = view.model.axes[name];
            if (!axis || axis.size < 2) return;
            const label = axis.labels[view.selection[name] || 0];
            parts.push(role === 'z' && axis.units ? `${label} ${axis.units}` : `${name}=${label}`);
        });
        return parts.length ? ` @ ${parts.join(', ')}` : '';
    };

    proto._griddedCanExtract = function(view, variable) {
        if (!variable) return false;
        if (!variable.timeDim || variable.timeDim !== view.model.primaryTimeDim) {
            this._griddedSetStatus(i18n.t('griddedNoSeriesForVariable').replace('{name}', variable.name), true);
            return false;
        }
        return true;
    };

    proto._griddedRunJob = async function(view, op, payload, label) {
        if (view.job) {
            this._griddedSetStatus(i18n.t('griddedBusy'), true);
            return null;
        }
        const progressEl = this._griddedEl('progress');
        const bar = this._griddedEl('progress-bar');
        this._griddedEl('progress-label').textContent = label;
        bar.value = 0;
        progressEl.hidden = false;
        const request = griddedClient().request(op, { datasetId: view.datasetId, ...payload }, {
            onProgress: value => { bar.value = value; },
        });
        view.job = request;
        try {
            return await request.promise;
        } catch (error) {
            this._griddedSetStatus(error?.cancelled ? i18n.t('griddedCancelled') : this._griddedErrorText(error, ''), !error?.cancelled);
            return null;
        } finally {
            view.job = null;
            progressEl.hidden = true;
        }
    };

    proto._griddedExtractPoint = async function(view, lat, lon) {
        const variable = this._griddedVariable(view);
        if (!this._griddedCanExtract(view, variable)) return;
        const result = await this._griddedRunJob(view, 'point', {
            variable: variable.key, selection: view.selection, lat, lon,
        }, i18n.t('griddedReadingPoint').replace('{lat}', formatCoordinate(lat, 'N', 'S')).replace('{lon}', formatCoordinate(lon, 'E', 'W')));
        if (!result) return;
        const where = `${formatCoordinate(result.cell.lat, 'N', 'S')} ${formatCoordinate(result.cell.lon, 'E', 'W')}`;
        const displayName = `${variable.name} · ${where}${this._griddedSelectionSuffix(view, variable)}`;
        const description = i18n.t('griddedPointDescription')
            .replace('{variable}', variable.longName || variable.name)
            .replace('{where}', where);
        this._griddedAddExtractions(view, [{ displayName, values: result.values, units: variable.units, description }]);
        this._griddedSetStatus(i18n.t('griddedPointDone').replace('{name}', displayName));
    };

    proto._griddedExtractRegion = async function(view, box) {
        const variable = this._griddedVariable(view);
        if (!this._griddedCanExtract(view, variable)) return;
        const where = `${formatCoordinate(box.latMin, 'N', 'S')}–${formatCoordinate(box.latMax, 'N', 'S')}, ${formatCoordinate(box.lonMin, 'E', 'W')}–${formatCoordinate(box.lonMax, 'E', 'W')}`;
        const result = await this._griddedRunJob(view, 'region', {
            variable: variable.key, selection: view.selection, box,
        }, i18n.t('griddedReadingRegion').replace('{where}', where));
        if (!result) return;
        const suffix = this._griddedSelectionSuffix(view, variable);
        const weighting = i18n.t(result.weighting === 'cell-area' ? 'griddedWeightingArea' : 'griddedWeightingCosLat');
        const describe = key => i18n.t(key)
            .replace('{variable}', variable.longName || variable.name)
            .replace('{where}', where)
            .replace('{cells}', String(result.cells))
            .replace('{weighting}', weighting);
        this._griddedAddExtractions(view, [
            { displayName: `${variable.name} · ${i18n.t('griddedMean')} [${where}]${suffix}`, values: result.mean, units: variable.units, description: describe('griddedMeanDescription') },
            { displayName: `${variable.name} · ${i18n.t('griddedMin')} [${where}]${suffix}`, values: result.min, units: variable.units, description: describe('griddedMinDescription') },
            { displayName: `${variable.name} · ${i18n.t('griddedMax')} [${where}]${suffix}`, values: result.max, units: variable.units, description: describe('griddedMaxDescription') },
        ]);
        const missing = Array.from(result.validFraction).some(value => value < 1);
        this._griddedSetStatus(i18n.t('griddedRegionDone')
            .replace('{cells}', String(result.cells))
            .replace('{weighting}', weighting)
            + (missing ? ` ${i18n.t('griddedRegionMissing')}` : ''));
    };

    proto._griddedAddExtractions = function(view, items) {
        const entry = this.plotManager.files.get(view.fileId);
        const data = entry?.data;
        if (!data) return;
        let node = Object.values(data.tree._children).find(child => child._griddedExtractions);
        if (!node) {
            node = treeNode(i18n.t('griddedExtractionsNode'));
            node._griddedExtractions = true;
            data.tree._children[node._name] = node;
        }
        const names = [];
        for (const item of items) {
            view.extractionCount += 1;
            const name = `grid:x${view.extractionCount}`;
            let label = item.displayName;
            let suffix = 2;
            while (node._variables[label]) label = `${item.displayName} (${suffix++})`;
            const values = Float64Array.from(item.values);
            data.variables[name] = {
                name,
                displayName: label,
                data: values,
                description: item.description,
                units: item.units || '',
                kind: 'variable',
                dataType: this.parser?._detectDataType ? this.parser._detectDataType(values, name) : 'numeric',
                isConstant: this.parser?._isConstantValues ? this.parser._isConstantValues(values) : false,
                interpolation: 'linear',
                negate: false,
                source: 'netcdf-gridded',
            };
            node._variables[label] = data.variables[name];
            names.push(name);
        }
        data.metadata.numVariables = Object.values(data.variables).filter(variable => variable.kind === 'variable').length;
        data.metadata.numTimevarying = data.metadata.numVariables;
        this.plotManager.updateFileData(view.fileId, data);
        if (this.plotManager.activeFileId === view.fileId) this._renderFilteredTree?.();
        view.lastExtraction = names;
        this._griddedDrawPreview(view);
    };

    proto._griddedDrawPreview = function(view) {
        const panel = this._griddedEl('preview');
        const chart = this._griddedEl('preview-chart');
        if (!panel || !chart) return;
        const data = this.plotManager.files.get(view.fileId)?.data;
        const variables = (view.lastExtraction || []).map(name => data?.variables?.[name]).filter(Boolean);
        if (!variables.length) {
            panel.hidden = true;
            return;
        }
        panel.hidden = false;
        this._griddedEl('preview-title').textContent = variables.map(variable => variable.displayName).join('  |  ');
        const time = data.variables[data.metadata.timeName];
        const datetime = time?.timeKind === 'datetime';
        const colors = this._griddedColors();
        const palette = ['#1f77b4', '#2ca02c', '#d62728'];
        const traces = variables.map((variable, index) => ({
            type: 'scatter',
            mode: time.data.length > 400 ? 'lines' : 'lines+markers',
            x: datetime ? Array.from(time.data, value => new Date(value)) : Array.from(time.data),
            y: Array.from(variable.data),
            name: variable.displayName,
            line: { width: index === 0 ? 2 : 1.2, color: palette[index % palette.length] },
            marker: { size: 3 },
        }));
        Plotly.react(chart, traces, {
            paper_bgcolor: colors.bg,
            plot_bgcolor: colors.bg,
            font: { color: colors.font, size: 10, family: 'system-ui, sans-serif' },
            margin: { l: 52, r: 10, t: 6, b: 28 },
            showlegend: variables.length > 1,
            legend: { orientation: 'h', y: 1.15, x: 0, font: { size: 9 } },
            xaxis: { gridcolor: colors.grid, type: datetime ? 'date' : 'linear', title: { text: datetime ? '' : (time.units || time.displayName) } },
            yaxis: { gridcolor: colors.grid, title: { text: variables[0].units || '' } },
        }, { displayModeBar: false, responsive: true });
    };

    proto._griddedPlotLastExtraction = function(view) {
        const names = view.lastExtraction || [];
        if (!names.length) return;
        this._hideGriddedView();
        // One curve at a time, each after the previous panel has drawn: the
        // first may split the layout, and a split re-renders every panel,
        // which must not overlap another trace being added.
        const settle = () => new Promise(resolve => setTimeout(() => requestAnimationFrame(() => resolve()), 120));
        (async () => {
            await settle();
            this._plotDerivedDatasetVariable?.(view.fileId, names[0]);
            const first = { fileId: view.fileId, name: names[0] };
            for (const name of names.slice(1)) {
                await settle();
                this._plotDerivedDatasetVariable?.(view.fileId, name, { alongside: first });
            }
        })();
    };

    // ─── Export ───────────────────────────────────────────────────────────

    proto._griddedExportPng = function(view) {
        const div = this._griddedEl('map');
        if (!div?._fullLayout) return;
        const name = `${safeFileStem(this.files.get(view.fileId)?.name)}_${safeFileStem(this._griddedMapTitle(view))}`;
        Plotly.downloadImage(div, { format: 'png', filename: name, width: div.clientWidth * 2, height: div.clientHeight * 2, scale: 1 });
    };

    proto._griddedExportMapCsv = function(view) {
        const map = view.map;
        if (!map) return;
        const variable = this._griddedVariable(view);
        const rows = [
            `# ${this._griddedMapTitle(view)}${variable?.units ? ` [${variable.units}]` : ''}`,
            ['lat \\ lon', ...Array.from(map.lon, value => Number(value.toPrecision(10)))].map(csvCell).join(','),
        ];
        for (let row = map.ny - 1; row >= 0; row--) {
            const values = [Number(map.lat[row].toPrecision(10))];
            for (let column = 0; column < map.nx; column++) {
                const value = map.values[row * map.nx + column];
                values.push(Number.isFinite(value) ? Number(value.toPrecision(7)) : '');
            }
            rows.push(values.join(','));
        }
        const name = `${safeFileStem(this.files.get(view.fileId)?.name)}_${safeFileStem(this._griddedMapTitle(view))}.csv`;
        downloadBlob(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }), name);
    };

    proto._griddedExportExtractionsCsv = function(view) {
        const data = this.plotManager.files.get(view.fileId)?.data;
        if (!data) return;
        const time = data.variables[data.metadata.timeName];
        const columns = Object.values(data.variables).filter(variable => variable.kind === 'variable');
        if (!columns.length) return;
        const datetime = time.timeKind === 'datetime';
        const header = [time.displayName, ...columns.map(variable => `${variable.displayName}${variable.units ? ` [${variable.units}]` : ''}`)];
        const lines = [header.map(csvCell).join(',')];
        for (let index = 0; index < time.data.length; index++) {
            const cells = [datetime ? new Date(time.data[index]).toISOString() : time.data[index]];
            for (const variable of columns) {
                const value = variable.data[index];
                cells.push(Number.isFinite(value) ? value : '');
            }
            lines.push(cells.map(csvCell).join(','));
        }
        downloadBlob(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }), `${safeFileStem(this.files.get(view.fileId)?.name)}_extractions.csv`);
    };

    proto._griddedOpenAsSeries = async function(fileId) {
        const entry = this.files.get(fileId);
        const file = entry?.gridded?.files?.[0];
        if (!file) return;
        const ok = await Modal.confirm(i18n.t('griddedOpenAsSeriesConfirm'), { title: i18n.t('griddedOpenAsSeries'), icon: '🌐' });
        if (!ok) return;
        this._hideGriddedView();
        await this.loadFile(file, { netcdfAsSeries: true, fileHandle: entry.fileHandle || null, localPath: entry.localPath || '' });
    };

    proto._griddedApplyTheme = function() {
        const view = this._griddedVisibleView();
        if (!view) return;
        this._griddedDrawMap(view);
        this._griddedDrawPreview(view);
    };
}
