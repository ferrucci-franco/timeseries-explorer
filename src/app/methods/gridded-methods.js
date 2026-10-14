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

// The export button of every plot panel, so the map's reads the same.
const EXPORT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';
// One colour per extraction, shared by its marker or box on the map, its row
// in the panel and its curves in the preview.
const SERIES_COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2'];

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

// A drawn box or a click lands between pixels; two decimals of a degree is
// about a kilometre, finer than any reanalysis grid.
function roundCoordinate(value) {
    return Math.round(value * 100) / 100;
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
            // 'navigate', 'point' or 'region' (the panel's three buttons).
            mode: 'point',
            pendingPoint: null,
            pendingBox: null,
            groups: [],
            groupCount: 0,
            playing: false,
            speed: 2,
            map: null,
            zoom: null,
            requestedMap: null,
            mapInFlight: false,
            job: null,
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
    //
    // Layout, left to right: the map (with its time bar and, when there are
    // extractions, their preview below it) and the analysis panel. The panel
    // reads top to bottom as the workflow: choose a tool, set a point or a box
    // (by clicking/drawing or by typing coordinates), compute, then work with
    // the extracted series. Nothing is computed until the user asks.

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
                <span class="gridded-toolbar-end">
                    <button type="button" class="gridded-icon-btn" data-action="export-map">${EXPORT_ICON}</button>
                    <button type="button" class="gridded-close" data-action="close"></button>
                </span>
            </div>
            <div class="gridded-main">
                <div class="gridded-map-column">
                    <div class="gridded-body"><div class="gridded-map" data-role="map"></div></div>
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
                        <div class="gridded-preview-head" data-role="preview-title"></div>
                        <div class="gridded-preview-chart" data-role="preview-chart"></div>
                    </div>
                </div>
                <aside class="gridded-panel" data-role="panel">
                    <section class="gridded-panel-section">
                        <h3 data-role="tools-heading"></h3>
                        <div class="gridded-modes" role="radiogroup" data-role="modes">
                            <button type="button" class="gridded-mode" data-mode="navigate"></button>
                            <button type="button" class="gridded-mode" data-mode="point"></button>
                            <button type="button" class="gridded-mode" data-mode="region"></button>
                        </div>
                        <p class="gridded-help" data-role="mode-help"></p>
                        <div class="gridded-form" data-form="point" hidden>
                            <div class="gridded-coords gridded-coords-point">
                                <label><span data-role="lat-label"></span><input type="number" step="any" min="-90" max="90" data-input="lat"></label>
                                <label><span data-role="lon-label"></span><input type="number" step="any" min="-180" max="360" data-input="lon"></label>
                            </div>
                            <div class="gridded-form-actions">
                                <button type="button" class="gridded-primary" data-action="extract-point"></button>
                                <button type="button" data-action="clear-point"></button>
                            </div>
                        </div>
                        <div class="gridded-form" data-form="region" hidden>
                            <div class="gridded-coords gridded-coords-box">
                                <label class="gridded-north"><span data-role="north-label"></span><input type="number" step="any" min="-90" max="90" data-input="north"></label>
                                <label class="gridded-west"><span data-role="west-label"></span><input type="number" step="any" min="-180" max="360" data-input="west"></label>
                                <label class="gridded-east"><span data-role="east-label"></span><input type="number" step="any" min="-180" max="360" data-input="east"></label>
                                <label class="gridded-south"><span data-role="south-label"></span><input type="number" step="any" min="-90" max="90" data-input="south"></label>
                            </div>
                            <div class="gridded-form-actions">
                                <button type="button" class="gridded-primary" data-action="extract-region"></button>
                                <button type="button" data-action="clear-region"></button>
                            </div>
                        </div>
                        <p class="gridded-scope" data-role="scope"></p>
                    </section>
                    <section class="gridded-panel-section gridded-results">
                        <div class="gridded-results-head">
                            <h3 data-role="results-heading"></h3>
                            <button type="button" class="gridded-icon-btn" data-action="export-series">${EXPORT_ICON}</button>
                        </div>
                        <p class="gridded-help" data-role="results-empty"></p>
                        <ul class="gridded-results-list" data-role="results"></ul>
                        <button type="button" class="gridded-primary gridded-plot-btn" data-action="plot"></button>
                        <p class="gridded-help" data-role="plot-help"></p>
                    </section>
                    <section class="gridded-panel-section gridded-panel-footer">
                        <button type="button" class="gridded-link" data-action="as-series"></button>
                    </section>
                </aside>
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

    proto._griddedInput = function(name) {
        return document.querySelector(`#gridded-view [data-input="${name}"]`);
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
        root.querySelectorAll('.gridded-mode').forEach(button => {
            button.addEventListener('click', () => {
                const current = view();
                if (current) this._griddedSetMode(current, button.dataset.mode);
            });
        });
        // Typing coordinates moves the marker or the box as the numbers change;
        // nothing is read from the file until the action button is pressed.
        root.querySelectorAll('[data-input]').forEach(input => {
            input.addEventListener('input', () => {
                const current = view();
                if (!current) return;
                if (input.dataset.input === 'lat' || input.dataset.input === 'lon') current.pendingPoint = this._griddedReadPointInputs();
                else current.pendingBox = this._griddedReadBoxInputs();
                this._griddedSyncActions(current);
                this._griddedDrawOverlaysSoon(current);
            });
            input.addEventListener('keydown', event => {
                if (event.key !== 'Enter') return;
                const current = view();
                if (!current) return;
                if (input.dataset.input === 'lat' || input.dataset.input === 'lon') this._griddedExtractPoint(current);
                else this._griddedExtractRegion(current);
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
        root.querySelector('[data-role="results"]').addEventListener('change', event => {
            const current = view();
            const id = event.target.closest('[data-group]')?.dataset.group;
            if (!current || !id) return;
            const group = current.groups.find(item => item.id === id);
            if (group) group.checked = event.target.checked;
            this._griddedSyncActions(current);
            this._griddedDrawPreview(current);
        });
        root.addEventListener('click', event => {
            const target = event.target.closest('[data-action]');
            const action = target?.dataset.action;
            if (!action) return;
            const current = view();
            if (action === 'close') this._hideGriddedView();
            else if (!current) return;
            else if (action === 'cancel' && current.job) griddedClient().cancel(current.job.id);
            else if (action === 'extract-point') this._griddedExtractPoint(current);
            else if (action === 'extract-region') this._griddedExtractRegion(current);
            else if (action === 'clear-point') this._griddedClearPending(current, 'point');
            else if (action === 'clear-region') this._griddedClearPending(current, 'region');
            else if (action === 'remove-group') this._griddedRemoveGroup(current, target.closest('[data-group]')?.dataset.group);
            else if (action === 'export-map') this._griddedExportMap(current);
            else if (action === 'export-series') this._griddedExportSeries(current);
            else if (action === 'plot') this._griddedPlotChecked(current);
            else if (action === 'as-series') this._griddedOpenAsSeries(current.fileId);
        });
        root.addEventListener('keydown', event => {
            if (event.target.closest('input, select, textarea')) return;
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
        set('[data-action="export-map"]', 'griddedExportMapTitle', 'title');
        set('[data-action="export-map"]', 'griddedExportMapTitle', 'ariaLabel');
        set('[data-action="close"]', 'griddedCloseMap');
        set('[data-action="close"]', 'griddedCloseMapTitle', 'title');
        set('[data-action="cancel"]', 'griddedCancel');
        set('[data-role="tools-heading"]', 'griddedToolsHeading');
        set('[data-mode="navigate"]', 'griddedModeNavigate');
        set('[data-mode="point"]', 'griddedModePoint');
        set('[data-mode="region"]', 'griddedModeRegion');
        set('[data-role="lat-label"]', 'griddedLatitude');
        set('[data-role="lon-label"]', 'griddedLongitude');
        set('[data-role="north-label"]', 'griddedNorth');
        set('[data-role="south-label"]', 'griddedSouth');
        set('[data-role="west-label"]', 'griddedWest');
        set('[data-role="east-label"]', 'griddedEast');
        set('[data-action="extract-point"]', 'griddedExtractPoint');
        set('[data-action="extract-region"]', 'griddedExtractRegion');
        set('[data-action="clear-point"]', 'griddedClear');
        set('[data-action="clear-region"]', 'griddedClear');
        set('[data-role="results-heading"]', 'griddedResultsHeading');
        set('[data-role="results-empty"]', 'griddedResultsEmpty');
        set('[data-action="export-series"]', 'griddedExportSeriesTitle', 'title');
        set('[data-action="export-series"]', 'griddedExportSeriesTitle', 'ariaLabel');
        set('[data-action="plot"]', 'griddedPlotChecked');
        set('[data-role="plot-help"]', 'griddedPlotHelp');
        set('[data-action="as-series"]', 'griddedOpenAsSeries');
        set('[data-action="as-series"]', 'griddedOpenAsSeriesTitle', 'title');
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
        const title = root.querySelector('[data-role="title"]');
        title.textContent = this.files.get(view.fileId)?.name || model.title;
        title.title = model.members.map(member => `${member.filename} (${member.storageFormat})`).join('\n');
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
                    this._griddedSyncScope(view);
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
        this._griddedSyncMode(view);
        this._griddedSyncInputs(view);
        this._griddedSyncScope(view);
        this._griddedRenderResults(view);
    };

    // What an extraction will use, said before it runs: the variable, the
    // level (or other dimensions) chosen in the toolbar, and every time step.
    proto._griddedSyncScope = function(view) {
        const element = this._griddedEl('scope');
        const variable = this._griddedVariable(view);
        if (!element || !variable) return;
        const fixed = this._griddedSelectionSuffix(view, variable).replace(/^ @ /, '');
        const steps = variable.timeDim ? view.model.axes[variable.timeDim]?.size || 1 : 1;
        element.textContent = i18n.t('griddedScope')
            .replace('{variable}', variable.name)
            .replace('{level}', fixed ? ` · ${fixed}` : '')
            .replace('{steps}', String(steps));
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

    proto._griddedSetMode = function(view, mode) {
        view.mode = mode;
        this._griddedSyncMode(view);
        const div = this._griddedEl('map');
        if (div?._fullLayout) Plotly.relayout(div, { dragmode: mode === 'region' ? 'drawrect' : 'pan' });
    };

    proto._griddedSyncMode = function(view) {
        const root = document.getElementById('gridded-view');
        if (!root) return;
        root.querySelectorAll('.gridded-mode').forEach(button => {
            const active = button.dataset.mode === view.mode;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        root.querySelector('[data-form="point"]').hidden = view.mode !== 'point';
        root.querySelector('[data-form="region"]').hidden = view.mode !== 'region';
        const map = root.querySelector('[data-role="map"]');
        map.classList.toggle('gridded-cursor-point', view.mode === 'point');
        map.classList.toggle('gridded-cursor-region', view.mode === 'region');
        const help = { navigate: 'griddedHelpNavigate', point: 'griddedHelpPoint', region: 'griddedHelpRegion' }[view.mode];
        this._griddedEl('mode-help').textContent = i18n.t(help || 'griddedHelpNavigate');
        this._griddedSyncActions(view);
    };

    proto._griddedSyncInputs = function(view) {
        const set = (name, value) => {
            const input = this._griddedInput(name);
            if (input && document.activeElement !== input) input.value = Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '';
        };
        set('lat', view.pendingPoint?.lat);
        set('lon', view.pendingPoint?.lon);
        set('north', view.pendingBox?.latMax);
        set('south', view.pendingBox?.latMin);
        set('west', view.pendingBox?.lonMin);
        set('east', view.pendingBox?.lonMax);
        this._griddedSyncActions(view);
    };

    proto._griddedReadPointInputs = function() {
        const lat = Number(this._griddedInput('lat')?.value);
        const lon = Number(this._griddedInput('lon')?.value);
        const filled = this._griddedInput('lat')?.value !== '' && this._griddedInput('lon')?.value !== '';
        if (!filled || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return null;
        return { lat, lon };
    };

    proto._griddedReadBoxInputs = function() {
        const values = ['north', 'south', 'west', 'east'].map(name => {
            const input = this._griddedInput(name);
            return input?.value === '' ? NaN : Number(input?.value);
        });
        const [north, south, west, east] = values;
        if (!values.every(Number.isFinite) || north <= south || Math.abs(north) > 90 || Math.abs(south) > 90 || west === east) return null;
        // West > east is a box across the antimeridian, as in the CDS form.
        return { latMax: north, latMin: south, lonMin: west, lonMax: east };
    };

    proto._griddedSyncActions = function(view) {
        const root = document.getElementById('gridded-view');
        if (!root) return;
        const busy = !!view.job;
        root.querySelector('[data-action="extract-point"]').disabled = busy || !view.pendingPoint;
        root.querySelector('[data-action="extract-region"]').disabled = busy || !view.pendingBox;
        root.querySelector('[data-action="clear-point"]').disabled = !view.pendingPoint;
        root.querySelector('[data-action="clear-region"]').disabled = !view.pendingBox;
        const checked = (view.groups || []).filter(group => group.checked).length;
        root.querySelector('[data-action="plot"]').disabled = !checked;
        root.querySelector('[data-action="export-series"]').disabled = !(view.groups || []).length;
    };

    proto._griddedClearPending = function(view, kind) {
        if (kind === 'point') view.pendingPoint = null;
        else view.pendingBox = null;
        this._griddedSyncInputs(view);
        this._griddedDrawMap(view);
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
                        if (this._griddedVisibleView() === view) await this._griddedDrawMap(view);
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

    proto._griddedColors = function(theme = this.theme) {
        const dark = theme === 'dark';
        return {
            bg: dark ? '#2d2d2d' : '#ffffff',
            font: dark ? '#d0d0d0' : '#333333',
            grid: dark ? '#4a4a4a' : '#e3e3e3',
            coast: dark ? '#f2f2f2' : '#1a1a1a',
            border: dark ? 'rgba(240,240,240,0.55)' : 'rgba(30,30,30,0.45)',
            pending: dark ? '#ff8a65' : '#d84315',
        };
    };

    proto._griddedDrawOverlaysSoon = function(view) {
        clearTimeout(view.overlayTimer);
        view.overlayTimer = setTimeout(() => this._griddedDrawMap(view), 60);
    };

    /**
     * The point and box being set up (orange, the box editable) and the ones
     * already extracted (in their series' colour, numbered like the list).
     */
    proto._griddedOverlays = function(view, colors) {
        const traces = [];
        const shapes = [];
        const annotations = [];
        const points = (view.groups || []).filter(group => group.kind === 'point');
        if (points.length) {
            traces.push({
                type: 'scatter', mode: 'markers',
                x: points.map(group => group.geometry.lon), y: points.map(group => group.geometry.lat),
                marker: { symbol: 'circle', size: 11, color: points.map(group => group.color), line: { color: '#ffffff', width: 2 } },
                hoverinfo: 'skip', showlegend: false,
            });
            for (const group of points) {
                annotations.push({
                    x: group.geometry.lon, y: group.geometry.lat, xref: 'x', yref: 'y', text: `<b>${group.tag}</b>`,
                    showarrow: false, xanchor: 'left', yanchor: 'bottom', xshift: 6, yshift: 4,
                    font: { color: '#ffffff', size: 11 }, bgcolor: group.color, borderpad: 2,
                });
            }
        }
        for (const group of (view.groups || []).filter(item => item.kind === 'region')) {
            const box = group.geometry;
            shapes.push({
                type: 'rect', xref: 'x', yref: 'y', editable: false,
                x0: box.lonMin, x1: box.lonMax, y0: box.latMin, y1: box.latMax,
                line: { color: group.color, width: 1.5, dash: 'dash' }, fillcolor: 'rgba(0,0,0,0)',
            });
            annotations.push({
                x: box.lonMin, y: box.latMax, xref: 'x', yref: 'y', text: `<b>${group.tag}</b>`, showarrow: false,
                xanchor: 'left', yanchor: 'bottom', font: { color: '#ffffff', size: 11 }, bgcolor: group.color, borderpad: 2,
            });
        }
        if (view.pendingPoint) {
            traces.push({
                type: 'scatter', mode: 'markers',
                x: [view.pendingPoint.lon], y: [view.pendingPoint.lat],
                marker: { symbol: 'circle-open', size: 16, color: colors.pending, line: { width: 3 } },
                hoverinfo: 'skip', showlegend: false,
            });
        }
        if (view.pendingBox) {
            const box = view.pendingBox;
            // First, so its index (0) identifies it in Plotly's edit events.
            shapes.unshift({
                type: 'rect', xref: 'x', yref: 'y', editable: true,
                x0: box.lonMin, x1: box.lonMax, y0: box.latMin, y1: box.latMax,
                line: { color: colors.pending, width: 2.5 }, fillcolor: 'rgba(216,67,21,0.10)',
            });
        }
        return { traces, shapes, annotations };
    };

    proto._griddedDrawMap = async function(view, { theme = this.theme, transparent = false, target = null } = {}) {
        const div = target || this._griddedEl('map');
        const map = view.map;
        if (!div || !map || (!target && this._griddedVisibleView() !== view)) return;
        const variable = this._griddedVariable(view);
        const colors = this._griddedColors(theme);
        const grid = drawableGrid(map, view.zoom?.x, view.zoom?.y);
        const [zmin, zmax] = this._griddedCurrentRange(view);
        const lonMin = map.lon[0];
        const lonMax = map.lon[map.lon.length - 1];
        const span = view.zoom?.x ? Math.abs(view.zoom.x[1] - view.zoom.x[0]) : Math.abs(lonMax - lonMin);
        const coast = await loadCoastlines(span < FINE_COAST_SPAN_DEGREES ? 'fine' : 'coarse')
            || await loadCoastlines('coarse');
        if (!target && this._griddedVisibleView() !== view) return;
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
            // Title above the bar and a bounded tick format, inside a right
            // margin that is already wide enough: the bar never pushes the map
            // as its labels change from one time step to the next.
            colorbar: {
                title: { text: variable?.units || '', side: 'top', font: { size: 11 } },
                thickness: 12, len: 0.9, outlinewidth: 0, x: 1.01, xanchor: 'left', xpad: 6,
                tickformat: '.4~g', nticks: 8, tickfont: { color: colors.font, size: 10 },
            },
            hovertemplate: `%{y:.2f}°, %{x:.2f}°<br>%{z:.5~g}${units}<extra></extra>`,
            hoverongaps: false,
        }];
        if (coast) {
            const borders = coastlineTrace(coast.borders, lonMin, lonMax);
            const coastline = coastlineTrace(coast.coastlines, lonMin, lonMax);
            traces.push({ type: 'scattergl', mode: 'lines', x: borders.x, y: borders.y, line: { color: colors.border, width: 0.6 }, hoverinfo: 'skip', showlegend: false });
            traces.push({ type: 'scattergl', mode: 'lines', x: coastline.x, y: coastline.y, line: { color: colors.coast, width: 1 }, hoverinfo: 'skip', showlegend: false });
        }
        const overlays = this._griddedOverlays(view, colors);
        traces.push(...overlays.traces);
        const ranges = view.zoom || this._griddedFittedRanges(map, div);
        const paper = transparent ? 'rgba(0,0,0,0)' : colors.bg;
        const titleText = grid.stride > 1
            ? `${this._griddedMapTitle(view)}  <span style="font-size:10px;opacity:0.7">(${i18n.t('griddedDecimatedShort').replace('{stride}', String(grid.stride))})</span>`
            : this._griddedMapTitle(view);
        const layout = {
            paper_bgcolor: paper,
            plot_bgcolor: paper,
            font: { color: colors.font, size: 11, family: 'system-ui, sans-serif' },
            margin: { l: 56, r: 96, t: 30, b: 44 },
            showlegend: false,
            dragmode: view.mode === 'region' ? 'drawrect' : 'pan',
            uirevision: `${view.fileId}|${view.variableKey}`,
            title: { text: titleText, font: { size: 12 }, x: 0.01, xanchor: 'left' },
            xaxis: {
                range: ranges.x,
                title: { text: i18n.t('griddedLongitude') },
                gridcolor: colors.grid,
                zeroline: false,
                ticksuffix: '°',
                // Equal degrees on both axes by shrinking the drawing area,
                // never by stretching the latitude axis past the poles.
                constrain: 'domain',
            },
            yaxis: {
                range: ranges.y,
                title: { text: i18n.t('griddedLatitude') },
                gridcolor: colors.grid,
                zeroline: false,
                ticksuffix: '°',
                scaleanchor: 'x',
                scaleratio: 1,
                constrain: 'domain',
            },
            newshape: { line: { color: colors.pending, width: 2.5 }, fillcolor: 'rgba(216,67,21,0.10)' },
            shapes: overlays.shapes,
            annotations: overlays.annotations,
        };
        const config = {
            ...(this.plotManager._getPlotlyConfig?.() || {}),
            displayModeBar: false,
            scrollZoom: true,
            responsive: true,
            edits: { shapePosition: true },
        };
        const first = !div._fullLayout;
        await Plotly.react(div, traces, layout, config);
        if (first && !target) this._griddedBindPlot(div);
    };

    /**
     * The view that shows the whole grid with equal degrees on both axes and
     * fills the drawing area: a long thin region (a band of latitudes) gets
     * the geography above and below it rather than a sliver of a map, and a
     * tall one gets the longitudes either side — but never past the poles or
     * round the globe a second time. What cannot be filled is left to
     * Plotly's `constrain: 'domain'`, which shrinks the drawing area instead.
     */
    proto._griddedFittedRanges = function(map, div) {
        const dx = map.lon.length > 1 ? Math.abs(map.lon[1] - map.lon[0]) / 2 : 0.5;
        const dy = map.lat.length > 1 ? Math.abs(map.lat[1] - map.lat[0]) / 2 : 0.5;
        let x = [map.lon[0] - dx, map.lon[map.lon.length - 1] + dx];
        let y = [map.lat[0] - dy, map.lat[map.lat.length - 1] + dy];
        const width = Math.max(1, (div?.clientWidth || 800) - 56 - 96);
        const height = Math.max(1, (div?.clientHeight || 500) - 30 - 44);
        const spanX = x[1] - x[0];
        const spanY = y[1] - y[0];
        const grow = (range, span, limits) => {
            const centre = (range[0] + range[1]) / 2;
            let low = centre - span / 2;
            let high = centre + span / 2;
            if (low < limits[0]) { high += limits[0] - low; low = limits[0]; }
            if (high > limits[1]) { low -= high - limits[1]; high = limits[1]; }
            return [Math.max(limits[0], low), Math.min(limits[1], high)];
        };
        if (spanX / spanY > width / height) {
            y = grow(y, spanX * height / width, [Math.min(-90, y[0]), Math.max(90, y[1])]);
        } else {
            const limits = x[1] > 180 ? [Math.min(0, x[0]), Math.max(360, x[1])] : [Math.min(-180, x[0]), Math.max(180, x[1])];
            x = grow(x, spanY * width / height, limits);
        }
        return { x, y };
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
            if (!view || view.mode !== 'point') return;
            const point = (event?.points || []).find(item => item.data?.type === 'heatmap') || event?.points?.[0];
            if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
            // A click places the point; the button (or Enter) extracts it.
            view.pendingPoint = { lat: roundCoordinate(point.y), lon: roundCoordinate(point.x) };
            this._griddedSyncInputs(view);
            this._griddedDrawMap(view);
        });
        div.on('plotly_relayout', update => {
            const view = this._griddedVisibleView();
            if (!view || !update) return;
            const keys = Object.keys(update);
            if (update.shapes || keys.some(key => key.startsWith('shapes['))) {
                const shapes = div.layout.shapes || [];
                // A new drawing is the last shape; an edit of the pending box is shape 0.
                const shape = update.shapes ? shapes[shapes.length - 1] : shapes[0];
                if (!shape) return;
                view.pendingBox = {
                    lonMin: roundCoordinate(Math.min(shape.x0, shape.x1)),
                    lonMax: roundCoordinate(Math.max(shape.x0, shape.x1)),
                    latMin: roundCoordinate(Math.max(-90, Math.min(shape.y0, shape.y1))),
                    latMax: roundCoordinate(Math.min(90, Math.max(shape.y0, shape.y1))),
                };
                if (view.mode !== 'region') {
                    view.mode = 'region';
                    this._griddedSyncMode(view);
                }
                this._griddedSyncInputs(view);
                this._griddedDrawOverlaysSoon(view);
                return;
            }
            if (update['xaxis.autorange'] || update.autosize) {
                view.zoom = null;
            } else if (update['xaxis.range[0]'] !== undefined || update['yaxis.range[0]'] !== undefined) {
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
        this._griddedSyncActions(view);
        try {
            return await request.promise;
        } catch (error) {
            this._griddedSetStatus(error?.cancelled ? i18n.t('griddedCancelled') : this._griddedErrorText(error, ''), !error?.cancelled);
            return null;
        } finally {
            view.job = null;
            progressEl.hidden = true;
            this._griddedSyncActions(view);
        }
    };

    proto._griddedExtractPoint = async function(view, at = view.pendingPoint) {
        const variable = this._griddedVariable(view);
        if (!at || !this._griddedCanExtract(view, variable)) return;
        const { lat, lon } = at;
        const result = await this._griddedRunJob(view, 'point', {
            variable: variable.key, selection: view.selection, lat, lon,
        }, i18n.t('griddedReadingPoint').replace('{lat}', formatCoordinate(lat, 'N', 'S')).replace('{lon}', formatCoordinate(lon, 'E', 'W')));
        if (!result) return;
        const where = `${formatCoordinate(result.cell.lat, 'N', 'S')} ${formatCoordinate(result.cell.lon, 'E', 'W')}`;
        const suffix = this._griddedSelectionSuffix(view, variable);
        const displayName = `${variable.name} · ${where}${suffix}`;
        const description = i18n.t('griddedPointDescription')
            .replace('{variable}', variable.longName || variable.name)
            .replace('{where}', where);
        view.pendingPoint = null;
        this._griddedSyncInputs(view);
        const group = this._griddedAddGroup(view, {
            kind: 'point',
            geometry: { lat: result.cell.lat, lon: result.cell.lon },
            label: displayName,
            items: [{ displayName, values: result.values, units: variable.units, description, role: 'value' }],
        });
        this._griddedSetStatus(i18n.t('griddedPointDone').replace('{name}', `${group.tag} ${displayName}`));
    };

    proto._griddedExtractRegion = async function(view, box = view.pendingBox) {
        const variable = this._griddedVariable(view);
        if (!box || !this._griddedCanExtract(view, variable)) return;
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
        view.pendingBox = null;
        this._griddedSyncInputs(view);
        const group = this._griddedAddGroup(view, {
            kind: 'region',
            geometry: { ...box },
            label: `${variable.name} · [${where}]${suffix}`,
            note: i18n.t('griddedRegionNote').replace('{cells}', String(result.cells)).replace('{weighting}', weighting),
            items: [
                { displayName: `${variable.name} · ${i18n.t('griddedMean')} [${where}]${suffix}`, values: result.mean, units: variable.units, description: describe('griddedMeanDescription'), role: 'mean' },
                { displayName: `${variable.name} · ${i18n.t('griddedMin')} [${where}]${suffix}`, values: result.min, units: variable.units, description: describe('griddedMinDescription'), role: 'min' },
                { displayName: `${variable.name} · ${i18n.t('griddedMax')} [${where}]${suffix}`, values: result.max, units: variable.units, description: describe('griddedMaxDescription'), role: 'max' },
            ],
        });
        const missing = Array.from(result.validFraction).some(value => value < 1);
        this._griddedSetStatus(i18n.t('griddedRegionDone')
            .replace('{tag}', group.tag)
            .replace('{cells}', String(result.cells))
            .replace('{weighting}', weighting)
            + (missing ? ` ${i18n.t('griddedRegionMissing')}` : ''));
    };

    proto._griddedExtractionNode = function(data) {
        let node = Object.values(data.tree._children).find(child => child._griddedExtractions);
        if (!node) {
            node = treeNode(i18n.t('griddedExtractionsNode'));
            node._griddedExtractions = true;
            data.tree._children[node._name] = node;
        }
        return node;
    };

    /**
     * One extraction (a point, or a box with its mean, min and max) becomes
     * one row of the panel's list and one or three variables of the file.
     */
    proto._griddedAddGroup = function(view, { kind, geometry, label, note = '', items }) {
        const entry = this.plotManager.files.get(view.fileId);
        const data = entry?.data;
        if (!data) return null;
        const node = this._griddedExtractionNode(data);
        view.groupCount = (view.groupCount || 0) + 1;
        const counters = view.tagCounters || (view.tagCounters = { point: 0, region: 0 });
        counters[kind] += 1;
        const tag = `${kind === 'point' ? 'P' : 'R'}${counters[kind]}`;
        const group = {
            id: `g${view.groupCount}`,
            kind,
            tag,
            geometry,
            label,
            note,
            color: SERIES_COLORS[(view.groupCount - 1) % SERIES_COLORS.length],
            checked: true,
            names: [],
            roles: [],
        };
        for (const item of items) {
            view.extractionCount += 1;
            const name = `grid:x${view.extractionCount}`;
            const display = `${tag} · ${item.displayName}`;
            let leaf = display;
            let suffix = 2;
            while (node._variables[leaf]) leaf = `${display} (${suffix++})`;
            const values = Float64Array.from(item.values);
            data.variables[name] = {
                name,
                displayName: leaf,
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
            node._variables[leaf] = data.variables[name];
            group.names.push(name);
            group.roles.push(item.role);
        }
        this._griddedCommitData(view, data);
        view.groups.push(group);
        this._griddedRenderResults(view);
        this._griddedDrawPreview(view);
        this._griddedDrawMap(view);
        return group;
    };

    proto._griddedCommitData = function(view, data) {
        data.metadata.numVariables = Object.values(data.variables).filter(variable => variable.kind === 'variable').length;
        data.metadata.numTimevarying = data.metadata.numVariables;
        this.plotManager.updateFileData(view.fileId, data);
        if (this.plotManager.activeFileId === view.fileId) this._renderFilteredTree?.();
    };

    proto._griddedRemoveGroup = function(view, id) {
        const index = view.groups.findIndex(group => group.id === id);
        if (index < 0) return;
        const [group] = view.groups.splice(index, 1);
        const data = this.plotManager.files.get(view.fileId)?.data;
        if (data) {
            const node = this._griddedExtractionNode(data);
            for (const name of group.names) {
                delete data.variables[name];
                for (const [leaf, variable] of Object.entries(node._variables)) {
                    if (variable?.name === name) delete node._variables[leaf];
                }
            }
            this._griddedCommitData(view, data);
        }
        this._griddedRenderResults(view);
        this._griddedDrawPreview(view);
        this._griddedDrawMap(view);
    };

    proto._griddedRenderResults = function(view) {
        const list = this._griddedEl('results');
        if (!list) return;
        list.innerHTML = '';
        for (const group of view.groups || []) {
            const item = document.createElement('li');
            item.className = 'gridded-result';
            item.dataset.group = group.id;
            const label = document.createElement('label');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = group.checked;
            const swatch = document.createElement('span');
            swatch.className = 'gridded-swatch';
            swatch.style.background = group.color;
            swatch.textContent = group.tag;
            const text = document.createElement('span');
            text.className = 'gridded-result-text';
            text.textContent = group.label;
            if (group.note) {
                const note = document.createElement('small');
                note.textContent = group.note;
                text.appendChild(note);
            }
            label.append(checkbox, swatch, text);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'gridded-remove';
            remove.dataset.action = 'remove-group';
            remove.textContent = '✕';
            remove.title = i18n.t('griddedRemoveExtraction');
            remove.setAttribute('aria-label', i18n.t('griddedRemoveExtraction'));
            item.append(label, remove);
            list.appendChild(item);
        }
        const empty = this._griddedEl('results-empty');
        if (empty) empty.hidden = !!(view.groups || []).length;
        this._griddedSyncActions(view);
    };

    proto._griddedCheckedSeries = function(view) {
        const data = this.plotManager.files.get(view.fileId)?.data;
        const out = [];
        for (const group of (view.groups || []).filter(item => item.checked)) {
            group.names.forEach((name, index) => {
                const variable = data?.variables?.[name];
                if (variable) out.push({ group, variable, role: group.roles[index] });
            });
        }
        return out;
    };

    proto._griddedDrawPreview = function(view) {
        const panel = this._griddedEl('preview');
        const chart = this._griddedEl('preview-chart');
        if (!panel || !chart) return;
        const series = this._griddedCheckedSeries(view);
        if (!series.length) {
            panel.hidden = true;
            return;
        }
        panel.hidden = false;
        this._griddedEl('preview-title').textContent = i18n.t('griddedPreviewTitle');
        const data = this.plotManager.files.get(view.fileId).data;
        const time = data.variables[data.metadata.timeName];
        const datetime = time?.timeKind === 'datetime';
        const colors = this._griddedColors();
        const x = datetime ? Array.from(time.data, value => new Date(value)) : Array.from(time.data);
        const traces = series.map(({ group, variable, role }) => ({
            type: 'scatter',
            mode: 'lines',
            x,
            y: Array.from(variable.data),
            name: `${group.tag} ${role === 'value' ? '' : i18n.t(role === 'mean' ? 'griddedMean' : role === 'min' ? 'griddedMin' : 'griddedMax')}`.trim(),
            line: { width: role === 'min' || role === 'max' ? 1 : 1.8, color: group.color, dash: role === 'min' ? 'dot' : role === 'max' ? 'dash' : 'solid' },
            hovertemplate: `${variable.displayName}<br>%{y:.5~g}${variable.units ? ` ${variable.units}` : ''}<extra></extra>`,
        }));
        Plotly.react(chart, traces, {
            paper_bgcolor: colors.bg,
            plot_bgcolor: colors.bg,
            font: { color: colors.font, size: 10, family: 'system-ui, sans-serif' },
            margin: { l: 56, r: 96, t: 6, b: 28 },
            showlegend: true,
            legend: { x: 1.01, xanchor: 'left', y: 1, font: { size: 10 } },
            xaxis: { gridcolor: colors.grid, type: datetime ? 'date' : 'linear', title: { text: datetime ? '' : (time.units || time.displayName) } },
            yaxis: { gridcolor: colors.grid, title: { text: series[0].variable.units || '' } },
        }, { displayModeBar: false, responsive: true });
    };

    proto._griddedPlotChecked = function(view) {
        const names = this._griddedCheckedSeries(view).map(item => item.variable.name);
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
    // The same dialog as every plot panel's download button: CSV for the
    // numbers, PNG or SVG for the figure, with quality and theme.

    proto._griddedExportMap = async function(view) {
        const div = this._griddedEl('map');
        if (!view.map || !div?._fullLayout) return;
        const { default: PlotExportDialog } = await import('../../ui/plot-export-dialog.js');
        const stem = `${safeFileStem(this.files.get(view.fileId)?.name)}_${safeFileStem(this._griddedMapTitle(view))}`;
        const result = await PlotExportDialog.open({
            contextLabel: this._griddedMapTitle(view),
            charts: [{ id: 'map', label: i18n.t('griddedExportMapChart'), width: div.clientWidth, height: div.clientHeight }],
            defaultChartId: 'map',
            defaultBaseName: () => stem,
        });
        if (!result) return;
        if (result.format === 'csv') {
            this._griddedExportMapCsv(view, result.fileName);
            return;
        }
        await this._griddedExportImage(div, result, theme => this._griddedDrawMap(view, theme), () => this._griddedDrawMap(view));
    };

    proto._griddedExportSeries = async function(view) {
        if (!(view.groups || []).length) return;
        const chart = this._griddedEl('preview-chart');
        const { default: PlotExportDialog } = await import('../../ui/plot-export-dialog.js');
        const drawn = !this._griddedEl('preview').hidden && chart?._fullLayout;
        const stem = `${safeFileStem(this.files.get(view.fileId)?.name)}_series`;
        const result = await PlotExportDialog.open({
            contextLabel: i18n.t('griddedResultsHeading'),
            charts: drawn ? [{ id: 'series', label: i18n.t('griddedPreviewTitle'), width: chart.clientWidth, height: chart.clientHeight }] : [],
            defaultChartId: 'series',
            defaultBaseName: () => stem,
        });
        if (!result) return;
        if (result.format === 'csv') {
            this._griddedExportSeriesCsv(view, result.fileName);
            return;
        }
        const redraw = () => this._griddedDrawPreview(view);
        await this._griddedExportImage(chart, result, ({ theme, transparent }) => {
            const realTheme = this.theme;
            this.theme = theme;
            try { this._griddedDrawPreview(view); } finally { this.theme = realTheme; }
            if (transparent) return Plotly.relayout(chart, { paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)' });
            return null;
        }, redraw);
    };

    proto._griddedExportImage = async function(div, { format, scale, theme, fileName }, drawAs, restore) {
        const preset = {
            current: { theme: this.theme, transparent: false },
            light: { theme: 'light', transparent: false },
            dark: { theme: 'dark', transparent: false },
            'light-transparent': { theme: 'light', transparent: true },
        }[theme] || { theme: this.theme, transparent: false };
        const changed = preset.theme !== this.theme || preset.transparent;
        try {
            if (changed) await drawAs({ theme: preset.theme, transparent: preset.transparent });
            const dataUrl = await Plotly.toImage(div, {
                format,
                width: div.clientWidth,
                height: div.clientHeight,
                scale: format === 'png' ? scale : 1,
            });
            const blob = await (await fetch(dataUrl)).blob();
            downloadBlob(blob, fileName);
        } catch (error) {
            Modal.alert(i18n.t('exportFailedTitle'), i18n.t('exportFailedBody'), {
                details: error?.message || String(error),
                detailsLabel: i18n.t('exportFailedDetails'),
            });
        } finally {
            if (changed) await restore();
        }
    };

    proto._griddedExportMapCsv = function(view, fileName) {
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
        downloadBlob(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }), fileName);
    };

    proto._griddedExportSeriesCsv = function(view, fileName) {
        const data = this.plotManager.files.get(view.fileId)?.data;
        if (!data) return;
        const time = data.variables[data.metadata.timeName];
        const checked = this._griddedCheckedSeries(view).map(item => item.variable);
        const columns = checked.length ? checked : (view.groups || []).flatMap(group => group.names.map(name => data.variables[name]).filter(Boolean));
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
        downloadBlob(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }), fileName);
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
