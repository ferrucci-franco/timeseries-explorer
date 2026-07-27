import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';
import CsvParsingPreviewDialog from '../../ui/csv-parsing-preview-dialog.js';
import {
    PYPSA_NETCDF_DESKTOP_EAGER_LIMIT_BYTES,
    PYPSA_NETCDF_WEB_EAGER_LIMIT_BYTES,
} from '../../parsers/pypsa-netcdf-limits.js';
import {
    PICKLE_DESKTOP_EAGER_LIMIT_BYTES,
    PICKLE_WEB_EAGER_LIMIT_BYTES,
} from '../../parsers/pickle-limits.js';
import {
    EXCEL_DESKTOP_EAGER_LIMIT_BYTES,
    EXCEL_WEB_EAGER_LIMIT_BYTES,
} from '../../parsers/excel-limits.js';
import {
    MATLAB_MAT_DESKTOP_EAGER_LIMIT_BYTES,
    MATLAB_MAT_WEB_EAGER_LIMIT_BYTES,
} from '../../parsers/matlab-mat-limits.js';

import WorkerPool, { canUseWorkers } from '../../core/worker-pool.js';
import { checkFullLoadLimit } from '../file-size-limits.js';
import { describeLoadError, formatLoadErrorMessage } from '../load-error-messages.js';
import { isTextTableExtension, mayBeTextTable } from '../text-file-formats.js';

const LOCAL_API_BASE = '/__omv_local__';
const PARQUET_STRONG_HINT_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_GENERATED_TIME_ORIGIN = '2026-01-01T00:00:00';

// Size 1 on purpose. Parsing is memory-bound, not CPU-bound: two workers each
// decoding a 500 MB .mat would double the peak footprint against a browser tab
// ceiling of ~4 GB. Concurrent file drops queue instead.
let parsePool = null;
function getParsePool() {
    if (!canUseWorkers()) return null;
    if (!parsePool) {
        parsePool = new WorkerPool(
            () => new Worker(new URL('../../workers/parse-worker.js', import.meta.url), { type: 'module' }),
            { name: 'parse', size: 1 },
        );
    }
    return parsePool;
}

// Every parser call goes through here: try the worker, fall back in-thread on
// anything that means "no worker available". A parse error from the worker is a
// real error and propagates — only transport failures fall back, otherwise a
// malformed file would be decoded twice before reporting.
async function parseOffThread(op, payload, transfer, inlineFallback) {
    const pool = getParsePool();
    if (!pool?.available) return inlineFallback();
    try {
        return await pool.run(op, payload, { transfer });
    } catch (err) {
        if (err?.workerUnavailable) return inlineFallback();
        throw err;
    }
}

// The worker receives its own copy: the app keeps entry.buffer alive for
// reloads, adjust-parsing and session save, so the original cannot be given
// away. postMessage would clone it anyway; slicing first and transferring makes
// the single copy explicit and lets the worker own its half outright.
function detachedCopy(buffer) {
    return buffer instanceof ArrayBuffer ? buffer.slice(0) : new Uint8Array(buffer).slice().buffer;
}

// A sample of a converted sheet for the parsing preview. Cut at the last
// newline so the preview never has to reason about a half row, and bounded so
// a million-row sheet does not push its whole CSV form through the dialog.
//
// Its own constant rather than CSV_PREVIEW_SEGMENT_BYTES: that one is declared
// inside installFileMethods and is not visible from module scope out here.
const SPREADSHEET_PREVIEW_SAMPLE_BYTES = 2 * 1024 * 1024;

function spreadsheetPreviewSample(csvBuffer, maxBytes = SPREADSHEET_PREVIEW_SAMPLE_BYTES) {
    const bytes = new Uint8Array(csvBuffer);
    if (bytes.byteLength <= maxBytes) return csvBuffer;
    let end = maxBytes;
    while (end > 0 && bytes[end - 1] !== 0x0a) end--;
    return csvBuffer.slice(0, end || maxBytes);
}
let duckDbSourceClassPromise = null;
let netcdfParserClassPromise = null;
let pickleParserClassPromise = null;
let excelWorkbookModulePromise = null;
let matlabMatFileClassPromise = null;

async function loadDuckDbSourceClass() {
    if (globalThis.__OMV_PORTABLE__ === true) return null;
    if (!duckDbSourceClassPromise) {
        duckDbSourceClassPromise = import('../../data/duckdb-source.js').then(module => module.default);
    }
    return duckDbSourceClassPromise;
}

function isTransientFileReadError(err) {
    const name = err?.name || '';
    const message = err?.message || '';
    return name === 'NotReadableError'
        || name === 'NotFoundError'
        || (name === 'TypeError' && /fetch|network|load failed|terminated/i.test(message));
}

function waitForFileRetry(attempt) {
    return new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
}

function cloneCsvProfileForIpc(csvProfile) {
    if (!csvProfile) return null;
    return JSON.parse(JSON.stringify(csvProfile, (_key, value) =>
        typeof value === 'function' ? undefined : value
    ));
}

async function loadPypsaNetcdfParserClass() {
    if (!netcdfParserClassPromise) {
        netcdfParserClassPromise = import('../../parsers/netcdf-parser.js').then(module => module.default);
    }
    return netcdfParserClassPromise;
}

async function loadPickleParserClass() {
    if (!pickleParserClassPromise) {
        pickleParserClassPromise = import('../../parsers/pickle-parser.js').then(module => module.default);
    }
    return pickleParserClassPromise;
}

async function loadExcelWorkbookModule() {
    if (!excelWorkbookModulePromise) {
        excelWorkbookModulePromise = import('../../parsers/excel-workbook.js');
    }
    return excelWorkbookModulePromise;
}

async function loadMatlabMatFileClass() {
    if (!matlabMatFileClassPromise) {
        matlabMatFileClassPromise = import('../../parsers/matlab-mat-file.js').then(module => module.default);
    }
    return matlabMatFileClassPromise;
}

function resolveExcelSheetName(excelModule, workbook, preferredName = null) {
    if (preferredName && workbook?.Sheets?.[preferredName]) return preferredName;
    const names = excelModule.nonEmptySheetNames(workbook);
    if (!names.length) return null;
    if (preferredName) {
        console.warn(`[excel] sheet "${preferredName}" not found; falling back to "${names[0]}".`);
    }
    return names[0];
}

function csvProfileWithoutRowFilter(csvProfile) {
    const clone = cloneCsvProfileForIpc(csvProfile);
    if (!clone) return null;
    delete clone.rowFilter;
    delete clone.previewFilteredRows;
    return clone;
}

export function installFileMethods(TargetClass) {
    const proto = TargetClass.prototype;
proto.loadFile = async function(file, options = {}) {
    let hideParquetOverlayAfterLoad = false;
    const isCancelled = () => options.loadToken?.cancelled === true;
    try {
        let currentFile = file;
        let extension;
        let buffer;
        let contentHash;
        let data;
        for (let attempt = 0; ; attempt++) {
            try {
                if (isCancelled()) return null;
                if ((!currentFile || attempt > 0) && options.fileHandle?.getFile) {
                    currentFile = await options.fileHandle.getFile();
                }
                if (!currentFile) throw new Error(i18n.t('invalidFile'));
                extension = this._fileExtension(currentFile.name);
                // Formats with no memory-saving path warn above their limit and
                // let the user decide. `allowOversized` then has to travel with
                // the request: the pickle and netCDF readers enforce the same
                // ceiling internally, so overriding here without telling them
                // would just fail again a moment later with a worse message.
                const overLimit = this._checkFullLoadLimit(currentFile, extension);
                if (overLimit && !options.allowOversized) {
                    if (!(await this._confirmOversizedFile(overLimit))) return null;
                    options = { ...options, allowOversized: true };
                }
                const preflight = await this._maybeConvertLargeCsvBeforeLoad(currentFile, { ...options, extension });
                if (preflight?.cancelled) return null;
                if (preflight?.csvProfile) {
                    options = {
                        ...options,
                        csvProfile: preflight.csvProfile,
                        skipLargeCsvPreflight: true,
                    };
                }
                if (preflight?.file) {
                    hideParquetOverlayAfterLoad = preflight.keepOverlayUntilLoaded === true;
                    currentFile = preflight.file;
                    options = {
                        ...options,
                        localPath: preflight.localPath || options.localPath,
                        skipLargeCsvPreflight: true,
                        temporaryParquetPath: preflight.temporaryParquetPath || options.temporaryParquetPath || '',
                    };
                    extension = this._fileExtension(currentFile.name);
                }
                const streamable = this._canParseFromFile(currentFile, extension);
                buffer = options.matBuffer || (streamable ? null : await (currentFile.arrayBuffer ? currentFile.arrayBuffer() : this._readAsArrayBuffer(currentFile)));
                contentHash = buffer
                    ? await this._hashBuffer(buffer)
                    : this._fileFingerprint(currentFile);
                data = await this._parseResultBuffer(currentFile.name, buffer, currentFile, {
                    csvProfile: options.csvProfile || null,
                    excelSheetName: options.excelSheetName || null,
                    excelWorkbook: options.excelWorkbook || null,
                    matInspection: options.matInspection || null,
                    matSelection: options.matSelection || null,
                    allowOversized: options.allowOversized === true,
                });
                if (isCancelled()) {
                    await data?._duckdb?.source?.release?.(data);
                    return null;
                }
                break;
            } catch (err) {
                if (isTransientFileReadError(err) && attempt < 4) {
                    await waitForFileRetry(attempt);
                    continue;
                }
                throw err;
            }
        }

        const fileId   = `f${this._nextFileId++}`;
        let baseName = this._fileBaseName(currentFile.name);
        if (options.excelAppendSheetName && data?.metadata?.excel?.sheetName) {
            baseName = `${baseName} — ${data.metadata.excel.sheetName}`;
        }
        const transform = this._defaultFileTransform();
        this.files.set(fileId, {
            file: currentFile,
            fileHandle: options.fileHandle || null,
            localPath: options.localPath || '',
            temporaryParquetPath: options.temporaryParquetPath || '',
            buffer,
            contentHash,
            name: baseName,
            extension,
            transform,
            excel: data?.metadata?.excel ? { ...data.metadata.excel } : null,
            matlab: data?.metadata?.matlab ? { ...data.metadata.matlab } : null,
        });
        this._adoptExcelCsvCache(this.files.get(fileId), data);

        // PlotManager takes ownership of the data
        this.plotManager.addFile(fileId, baseName, data, transform, {
            deferRebuild: options.deferPlotRebuild === true,
        });

        if (!options.deferUi) {
            // Hide drop zone after first file
            document.getElementById('drop-zone').classList.remove('active');

            this._updateTopBar();
            this._renderFilesList();
            this._clearVariableSelection();
            this.renderVariablesTree(data.tree);
            this._updateActionButtons();
        }
        if (hideParquetOverlayAfterLoad && !options.deferUi) {
            this._hideFileLoadingOverlay();
        }
        if (!options.deferUi) {
            await this._showDatetimeAxisWarningIfNeeded(fileId, data);
            this._showSpreadsheetParquetHint(this.files.get(fileId));
        }

        console.log('Loaded:', currentFile.name, '- variables:', Object.keys(data.variables).length);
        return { fileId, data };
    } catch (err) {
        if (isCancelled()) return null;
        if (hideParquetOverlayAfterLoad && !options.deferUi) {
            this._hideFileLoadingOverlay();
        }
        console.error('Error loading file:', err);
        if (options.throwOnError) throw err;
        await this._showLoadError(err, currentFileNameForError(currentFile, file));
        return null;
    }
};

function currentFileNameForError(currentFile, originalFile) {
    return currentFile?.name || originalFile?.name || '';
}

// One dialog for every way a load can end badly.
//
// The catch above always produced an app dialog, but its body was whatever the
// error happened to say — often a raw V8 string like "Cannot create a string
// longer than 0x1fffffe8 characters". describeLoadError maps the failures we
// can actually explain onto translated text and leaves the rest alone, and the
// original always stays available under "Technical details" so a bug report
// still carries the real message.
proto._showLoadError = async function(error, filename = '') {
    const described = describeLoadError(error);
    // The user's own cancellation is not a failure and gets no dialog.
    if (described.cancelled) return;

    const body = described.key
        ? formatLoadErrorMessage(i18n.t(described.key), { ...described.params, file: filename })
        : described.raw;

    await Modal.alert(i18n.t('errorLoading'), body, {
        // Only worth showing when it is not already the message.
        details: described.key ? described.raw : '',
        detailsLabel: i18n.t('errorDetailsLabel'),
    });
};

proto.loadFiles = async function(items = []) {
    // Sheet selection happens before the loading overlay so the picker is not
    // stacked under it and the progress counter reflects the expanded count.
    const excelEntries = await this._expandExcelEntries(Array.from(items || []));
    const entries = await this._expandMatEntries(excelEntries);
    if (!entries.length) return [];

    const loaded = [];
    const loadToken = { cancelled: false };
    this._showFileLoadingOverlay(entries.length, loadToken);
    await this._yieldToBrowser();
    try {
        for (let index = 0; index < entries.length; index++) {
            if (loadToken.cancelled) break;
            const item = entries[index];
            const fileHandle = item?.fileHandle || null;
            const file = item?.file || (fileHandle ? null : item);
            const localPath = item?.localPath || '';
            if (!file && !fileHandle) continue;
            this._updateFileLoadingOverlay(index + 1, entries.length, file?.name || fileHandle?.name || '', file?.size);
            const result = await this.loadFile(file, {
                fileHandle,
                localPath,
                deferUi: true,
                excelSheetName: item?.excelSheetName || null,
                excelWorkbook: item?.excelWorkbook || null,
                excelAppendSheetName: item?.excelAppendSheetName === true,
                matBuffer: item?.matBuffer || null,
                matInspection: item?.matInspection || null,
                matSelection: item?.matSelection || null,
                loadToken,
            });
            if (result) loaded.push(result);
            if (loadToken.cancelled) break;
            await this._yieldToBrowser();
        }

        if (loaded.length) {
            document.getElementById('drop-zone').classList.remove('active');
            this._updateTopBar();
            this._renderFilesList();
            this._clearVariableSelection();
            const activeData = this.plotManager.files.get(this.plotManager.activeFileId)?.data;
            this.renderVariablesTree(activeData?.tree || null);
            this._updateActionButtons();
        }
    } finally {
        this._hideFileLoadingOverlay(loadToken);
    }

    for (const result of loaded) {
        await this._showDatetimeAxisWarningIfNeeded(result.fileId, result.data);
        if (result.data?._duckdb) this._showLazyFileNotice(result.fileId);
    }

    return loaded;
};

// Expands each spreadsheet in a load batch into one entry per selected sheet.
// The parsed workbook rides along on the entry so loadFile does not re-read
// the zip per sheet; it is dropped once the batch finishes (never stored).
proto._expandExcelEntries = async function(entries) {
    const expanded = [];
    // The loading overlay covers the read + SheetJS decode (synchronous and
    // potentially seconds long) but must be hidden while a modal is open.
    let overlayShown = false;
    const showBusy = async (file) => {
        this._showFileLoadingOverlay(1);
        this._updateFileLoadingOverlay(1, 1, file?.name || '', file?.size);
        overlayShown = true;
        await this._waitForNextPaint();
    };
    const hideBusy = () => {
        if (!overlayShown) return;
        this._hideFileLoadingOverlay();
        overlayShown = false;
    };
    for (const item of entries) {
        const fileHandle = item?.fileHandle || null;
        let file = item?.file || (fileHandle ? null : item);
        const sourceName = file?.name || fileHandle?.name || '';
        const extension = this._fileExtension(sourceName);
        if (!this._isExcelExtension(extension)) {
            expanded.push(item);
            continue;
        }
        try {
            if (!file && fileHandle?.getFile) file = await fileHandle.getFile();
            if (!file) continue;
            if (!(await this._confirmOversizedFile(this._checkFullLoadLimit(file, extension)))) continue;
            await showBusy(file);
            const excel = await loadExcelWorkbookModule();
            const rawBuffer = await (file.arrayBuffer ? file.arrayBuffer() : this._readAsArrayBuffer(file));
            const workbook = excel.readWorkbook(await excel.loadXlsxModule(), rawBuffer);
            const sheets = excel.listSheets(workbook);
            const nonEmpty = sheets.filter(sheet => !sheet.empty);
            if (!nonEmpty.length) {
                hideBusy();
                await Modal.alert(
                    i18n.t('excelSheetPickerTitle'),
                    i18n.t('excelNoDataSheets').replace('{file}', file.name),
                    { icon: 'XLS' },
                );
                continue;
            }
            let selected = [nonEmpty[0].name];
            if (nonEmpty.length > 1) {
                hideBusy();
                const { default: ExcelSheetPickerDialog } = await import('../../ui/excel-sheet-picker-dialog.js');
                const picked = await ExcelSheetPickerDialog.open({ fileName: file.name, sheets });
                if (!picked || !picked.length) continue;
                selected = picked;
            }
            for (const sheetName of selected) {
                expanded.push({
                    file,
                    fileHandle,
                    localPath: item?.localPath || '',
                    excelSheetName: sheetName,
                    excelWorkbook: workbook,
                    excelAppendSheetName: selected.length > 1,
                });
            }
        } catch (err) {
            hideBusy();
            console.error('Error preparing Excel file:', err);
            await Modal.alert(i18n.t('errorLoading'), err?.message || String(err), { icon: 'XLS' });
        }
    }
    // When entries follow, loadFiles takes over the same overlay (reused by
    // _showFileLoadingOverlay); otherwise nothing else will hide it.
    if (!expanded.length) hideBusy();
    return expanded;
};

// MATLAB files are inspected before the loading batch begins. Simulation
// results keep the legacy direct path; general MAT containers expose a
// spreadsheet-like catalog so the user controls which arrays are imported.
proto._expandMatEntries = async function(entries) {
    const expanded = [];
    for (const item of entries || []) {
        const fileHandle = item?.fileHandle || null;
        let file = item?.file || (fileHandle ? null : item);
        const sourceName = file?.name || fileHandle?.name || '';
        if (this._fileExtension(sourceName) !== '.mat') {
            expanded.push(item);
            continue;
        }
        try {
            if (!file && fileHandle?.getFile) file = await fileHandle.getFile();
            if (!file) continue;
            if (!(await this._confirmOversizedFile(this._checkFullLoadLimit(file, '.mat')))) continue;
            this._showFileLoadingOverlay(1);
            this._updateFileLoadingOverlay(1, 1, file.name || '', file.size);
            await this._waitForNextPaint();
            const buffer = await (file.arrayBuffer ? file.arrayBuffer() : this._readAsArrayBuffer(file));
            const Parser = await loadMatlabMatFileClass();
            const parser = new Parser(this.parser);
            const inspection = await parser.inspect(buffer, file.name);
            this._hideFileLoadingOverlay();
            let selection = null;
            if (inspection.kind === 'general') {
                const { default: MatVariablePickerDialog } = await import('../../ui/mat-variable-picker-dialog.js');
                selection = await MatVariablePickerDialog.open({
                    fileName: file.name,
                    version: inspection.version,
                    entries: inspection.entries,
                });
                if (!selection?.selectedIds?.length) continue;
            }
            expanded.push({
                ...(item?.file || item?.fileHandle ? item : {}),
                file,
                fileHandle,
                matBuffer: buffer,
                matInspection: inspection,
                matSelection: selection,
            });
        } catch (err) {
            this._hideFileLoadingOverlay();
            console.error('Error inspecting MAT file:', err);
            // MAT_FILE_TOO_LARGE is gone — an oversized file is a question now,
            // not an error — but the wider dialog is still the right shape for
            // the long messages the MAT reader can produce.
            await Modal.alert(i18n.t('errorLoading'), err?.message || String(err), {
                icon: 'MAT',
                className: 'modal-dialog-mat-too-large',
            });
        }
    }
    return expanded;
};

proto._hasRepeatedDatetimeWarning = function(data) {
    const metadata = data?.metadata || {};
    if (metadata.datetimeAxisStalled) return true;
    const metadataStart = Number(metadata.timeStart);
    const metadataEnd = Number(metadata.timeEnd);
    if (metadata.timeKind === 'datetime'
        && Number(metadata.numTimesteps) >= 3
        && Number.isFinite(metadataStart)
        && metadataStart === metadataEnd) {
        return true;
    }
    const timeName = metadata.timeName;
    const timeVar = timeName ? data?.variables?.[timeName] : null;
    if (timeVar?.timeKind !== 'datetime') return false;
    const values = timeVar.data;
    if (!values || values.length < 3) return false;
    let previous = NaN;
    let runLength = 0;
    const limit = Math.min(values.length, 1000);
    for (let i = 0; i < limit; i++) {
        const value = Number(values[i]);
        if (!Number.isFinite(value)) {
            previous = NaN;
            runLength = 0;
            continue;
        }
        runLength = value === previous ? runLength + 1 : 1;
        previous = value;
        if (runLength >= 3) return true;
    }
    return false;
};

proto._showDatetimeAxisWarningIfNeeded = async function(fileId, data) {
    if (!this._hasRepeatedDatetimeWarning(data)) return;
    if (!this._datetimeAxisWarningShownFileIds) this._datetimeAxisWarningShownFileIds = new Set();
    if (this._datetimeAxisWarningShownFileIds.has(fileId)) return;
    this._datetimeAxisWarningShownFileIds.add(fileId);
    const entry = this.files.get(fileId);
    const fileName = entry?.name || data?.filename || 'file';
    const body = i18n.t('datetimeAxisRepeatedDialogBody').replace('{file}', fileName);
    await Modal.alert(i18n.t('datetimeAxisRepeatedDialogTitle'), body, {
        icon: '⚠️',
    });
};

proto._yieldToBrowser = function() {
    return new Promise(resolve => setTimeout(resolve, 0));
};

// Resolves after the next frame is painted; needed before synchronous heavy
// work (e.g. spreadsheet decoding) so the overlay is actually visible. The
// timeout fallback covers hidden tabs, where rAF does not fire.
proto._waitForNextPaint = function() {
    return new Promise(resolve => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(finish, 100);
        requestAnimationFrame(() => requestAnimationFrame(finish));
    });
};

proto._showFileLoadingOverlay = function(total = 1, loadToken = null) {
    const existing = document.getElementById('file-loading-overlay');
    if (existing?.classList.contains('show')) {
        // Already visible (e.g. shown during spreadsheet preparation): reuse
        // it so chained show calls do not re-trigger the fade-in.
        this._updateFileLoadingOverlay(0, total, '');
        const cancelHint = document.getElementById('file-loading-cancel-hint');
        if (cancelHint) cancelHint.hidden = !loadToken;
        this._installFileLoadingCancellation(loadToken);
        return;
    }
    existing?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'file-loading-overlay';
    overlay.className = 'example-loading-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-live', 'assertive');

    const dialog = document.createElement('div');
    dialog.className = 'example-loading-dialog';
    const spinner = document.createElement('div');
    spinner.className = 'example-loading-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const title = document.createElement('div');
    title.className = 'example-loading-title';
    title.id = 'file-loading-title';
    const hint = document.createElement('div');
    hint.className = 'example-loading-hint';
    hint.id = 'file-loading-hint';
    const cancelHint = document.createElement('div');
    cancelHint.className = 'example-loading-hint';
    cancelHint.id = 'file-loading-cancel-hint';
    cancelHint.textContent = i18n.t('loadingFilesCancelHint');

    dialog.append(spinner, title, hint, cancelHint);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    this._updateFileLoadingOverlay(0, total, '');
    this._installFileLoadingCancellation(loadToken);
    if (!loadToken) {
        cancelHint.hidden = true;
    }
    requestAnimationFrame(() => overlay.classList.add('show'));
    overlay.tabIndex = -1;
    overlay.focus({ preventScroll: true });
};

proto._installFileLoadingCancellation = function(loadToken) {
    if (!loadToken) return;
    if (this._fileLoadingEscHandler) {
        document.removeEventListener('keydown', this._fileLoadingEscHandler, true);
    }
    this._fileLoadingToken = loadToken;
    this._fileLoadingEscHandler = (event) => {
        if (event.key !== 'Escape' || this._fileLoadingToken !== loadToken) return;
        event.preventDefault();
        event.stopPropagation();
        loadToken.cancelled = true;
        this._hideFileLoadingOverlay(loadToken);
    };
    document.addEventListener('keydown', this._fileLoadingEscHandler, true);
};

proto._updateFileLoadingOverlay = function(current, total, filename = '', size = null) {
    const title = document.getElementById('file-loading-title');
    const hint = document.getElementById('file-loading-hint');
    if (title) {
        title.textContent = i18n.t('loadingFiles')
            .replace('{current}', String(Math.min(current, total)))
            .replace('{total}', String(total));
    }
    if (hint) {
        const sizeLabel = this._formatFileSize(size);
        const fileLabel = sizeLabel ? `${filename} (${sizeLabel})` : filename;
        hint.textContent = filename
            ? i18n.t('loadingFilesCurrent').replace('{file}', fileLabel)
            : i18n.t('loadingFilesPreparing');
    }
};

proto._formatFileSize = function(size) {
    const bytes = Number(size);
    if (!Number.isFinite(bytes) || bytes < 0) return '';
    const units = ['B', 'kB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }
    const decimals = unitIndex === 0 ? 0 : (value >= 100 ? 0 : value >= 10 ? 1 : 2);
    return `${value.toFixed(decimals)} ${units[unitIndex]}`;
};

proto._hideFileLoadingOverlay = function(loadToken = null) {
    if (loadToken && this._fileLoadingToken && this._fileLoadingToken !== loadToken) return;
    if (this._fileLoadingEscHandler) {
        document.removeEventListener('keydown', this._fileLoadingEscHandler, true);
        this._fileLoadingEscHandler = null;
    }
    this._fileLoadingToken = null;
    const overlay = document.getElementById('file-loading-overlay');
    if (!overlay) return;
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 220);
};

proto._showLazyFileNotice = function(fileId) {
    const entry = this.files.get(fileId);
    if (!entry) return;
    const noticeId = `lazy-file-notice-${fileId}`;
    document.getElementById(noticeId)?.remove();

    const notice = document.createElement('div');
    notice.id = noticeId;
    notice.className = 'dismissible-notice';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');

    const content = document.createElement('div');
    content.className = 'dismissible-notice-content';
    const title = document.createElement('div');
    title.className = 'dismissible-notice-title';
    title.textContent = i18n.t('lazyFileNoticeTitle');
    const body = document.createElement('div');
    body.className = 'dismissible-notice-body';
    body.textContent = i18n.t('lazyFileNoticeBody').replace('{file}', this._fileDisplayName(entry));
    const actions = document.createElement('div');
    actions.className = 'dismissible-notice-actions';
    const settings = document.createElement('button');
    settings.type = 'button';
    settings.className = 'dismissible-notice-action primary';
    settings.textContent = i18n.t('lazyFileNoticeSettings');
    settings.addEventListener('click', () => {
        notice.remove();
        this.showDisplaySettings();
    });
    actions.appendChild(settings);
    content.append(title, body, actions);

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'dismissible-notice-close';
    close.textContent = '×';
    close.title = i18n.t('closeFile');
    close.addEventListener('click', () => notice.remove());
    notice.append(content, close);
    document.body.appendChild(notice);
    requestAnimationFrame(() => notice.classList.add('show'));
};

proto.reloadActiveFile = async function() {
    const id = this.plotManager.activeFileId;
    if (!id) return;
    const entry = this.files.get(id);
    if (!entry) return;

    const streamable = this._canParseFromFile(entry.file, entry.extension);
    const latestFile = streamable ? await this._readLatestFileForStreamableReload(entry) : null;
    const buffer = streamable ? null : await this._readLatestBuffer(entry);
    const contentHash = streamable ? this._fileFingerprint(latestFile || entry.file) : await this._hashBuffer(buffer);

    const currentProfile = this.plotManager.files.get(id)?.data?.metadata?.csvProfile || null;
    const data = await this._parseResultBuffer(this._fileDisplayName(entry), buffer, latestFile || entry.file, {
        csvProfile: currentProfile?.profileSource === 'user' ? currentProfile : null,
        excelSheetName: entry.excel?.sheetName || null,
        matSelection: entry.matlab || null,
    });
    if (data?.metadata?.excel) entry.excel = { ...data.metadata.excel };
    if (data?.metadata?.matlab) entry.matlab = { ...data.metadata.matlab };
    this._reapplyDerivedVariables(id, data);
    this._reapplyDataToolVariables?.(id, data);

    entry.buffer = buffer;
    entry.contentHash = contentHash;
    this._adoptExcelCsvCache(entry, data);
    this.plotManager.updateFileData(id, data);
    this._updateTopBar();
    this._clearVariableSelection();
    this.renderVariablesTree(data.tree);
};

proto.adjustMatlabArrays = async function(fileId) {
    const entry = this.files.get(fileId);
    const currentData = this.plotManager.files.get(fileId)?.data;
    const currentSelection = currentData?.metadata?.matlab || entry?.matlab || null;
    if (!entry || currentData?.metadata?.source !== 'matlab' || !Array.isArray(currentSelection?.selectedIds)) return;

    let loading = false;
    try {
        this._showFileLoadingOverlay(1);
        loading = true;
        this._updateFileLoadingOverlay(1, 1, this._fileDisplayName(entry), entry.file?.size || entry.buffer?.byteLength);
        await this._waitForNextPaint();

        const buffer = entry.buffer || await this._readLatestBuffer(entry);
        const Parser = await loadMatlabMatFileClass();
        const parser = new Parser(this.parser);
        const inspection = await parser.inspect(buffer, this._fileDisplayName(entry));
        this._hideFileLoadingOverlay();
        loading = false;
        if (inspection.kind !== 'general') return;

        const { default: MatVariablePickerDialog } = await import('../../ui/mat-variable-picker-dialog.js');
        const selection = await MatVariablePickerDialog.open({
            fileName: this._fileDisplayName(entry),
            version: inspection.version,
            entries: inspection.entries,
            initialSelection: currentSelection,
        });
        if (!selection?.selectedIds?.length) return;

        this._showFileLoadingOverlay(1);
        loading = true;
        this._updateFileLoadingOverlay(1, 1, this._fileDisplayName(entry), buffer.byteLength);
        await this._waitForNextPaint();
        const data = await parser.parse(buffer, this._fileDisplayName(entry), { inspection, selection });
        this._reapplyDerivedVariables(fileId, data);
        this._reapplyDataToolVariables?.(fileId, data);

        entry.buffer = buffer;
        entry.matlab = data?.metadata?.matlab ? { ...data.metadata.matlab } : { ...selection };
        this.plotManager.updateFileData(fileId, data);
        if (fileId === this.activeFileId) {
            this._clearVariableSelection();
            this.renderVariablesTree(data.tree);
        }
        this._renderFilesList();
        this._updateActionButtons();
        await this._showDatetimeAxisWarningIfNeeded(fileId, data);
    } catch (err) {
        if (err?.name === 'AbortError') return;
        console.error('Error updating MATLAB array selection:', err);
        await Modal.alert(i18n.t('errorLoading'), err?.message || String(err), { icon: 'MAT' });
    } finally {
        if (loading) this._hideFileLoadingOverlay();
    }
};

proto.reloadActiveFileAsNewVersion = async function() {
    const sourceId = this.plotManager.activeFileId;
    if (!sourceId) return;
    const source = this.files.get(sourceId);
    if (!source) return;

    const name = this._nextVersionName(source.name);
    const streamable = this._canParseFromFile(source.file, source.extension);
    const latestFile = streamable ? await this._readLatestFileForStreamableReload(source) : null;
    const buffer = streamable ? null : await this._readLatestBuffer(source);
    const contentHash = streamable ? this._fileFingerprint(latestFile || source.file) : await this._hashBuffer(buffer);
    const sourceHash = source.contentHash || (source.buffer ? await this._hashBuffer(source.buffer) : '');
    if (!source.contentHash && sourceHash) source.contentHash = sourceHash;
    const currentProfile = this.plotManager.files.get(sourceId)?.data?.metadata?.csvProfile || null;
    const hasCsvRowFilter = currentProfile?.profileSource === 'user' && currentProfile?.rowFilter?.enabled;
    if (sourceHash && contentHash === sourceHash && !hasCsvRowFilter) {
        await Modal.alert(i18n.t('reloadAsNewVersion'), i18n.t('reloadUnchangedNoVersion'), { icon: '🔄' });
        this._updateTopBar();
        return;
    }

    const reloadProfile = currentProfile?.profileSource === 'user'
        ? (hasCsvRowFilter ? csvProfileWithoutRowFilter(currentProfile) : currentProfile)
        : null;
    const data = await this._parseResultBuffer(this._fileDisplayName(source), buffer, latestFile || source.file, {
        csvProfile: reloadProfile,
        excelSheetName: source.excel?.sheetName || null,
        matSelection: source.matlab || null,
    });

    const fileId = `f${this._nextFileId++}`;
    this._copyDerivedDefinitions(sourceId, fileId);
    this._reapplyDerivedVariables(fileId, data);
    this._copyDataToolDefinitions?.(sourceId, fileId);
    this._reapplyDataToolVariables?.(fileId, data);
    this.files.set(fileId, {
        file: latestFile || source.file,
        fileHandle: source.fileHandle || null,
        localPath: source.localPath || '',
        buffer,
        contentHash,
        name,
        extension: source.extension || '.mat',
        transform: this._normalizeFileTransform(source.transform),
        excel: data?.metadata?.excel ? { ...data.metadata.excel } : (source.excel ? { ...source.excel } : null),
        matlab: data?.metadata?.matlab ? { ...data.metadata.matlab } : (source.matlab ? { ...source.matlab } : null),
    });
    this._adoptExcelCsvCache(this.files.get(fileId), data);
    this.plotManager.addFile(fileId, name, data, this.files.get(fileId).transform);
    this.plotManager.setActiveFile(fileId);

    document.getElementById('drop-zone').classList.remove('active');
    this._updateTopBar();
    this._renderFilesList();
    this._clearVariableSelection();
    this.renderVariablesTree(data.tree);
    this._updateActionButtons();
};

proto._readLatestFileForStreamableReload = async function(entry) {
    if (entry.localPath) {
        const file = await this._readLocalResultPath(entry.localPath);
        entry.file = file;
        entry.extension = this._fileExtension(file.name);
        return file;
    }

    if (entry.fileHandle?.getFile) {
        try {
            const file = await entry.fileHandle.getFile();
            entry.file = file;
            entry.extension = this._fileExtension(file.name);
            return file;
        } catch (err) {
            console.warn('Could not read latest file handle; falling back to stored file snapshot.', err);
        }
    }

    if (this._shouldReselectFileForReload(entry)) {
        const file = await this._promptForReloadReselect(entry);
        if (!file) {
            const err = new Error('File selection cancelled');
            err.name = 'AbortError';
            throw err;
        }
        entry.file = file;
        entry.fileHandle = null;
        entry.extension = this._fileExtension(file.name);
        return file;
    }

    if (!entry.file) throw new Error('No file available');
    return entry.file;
};

proto._readLatestBuffer = async function(entry) {
    if (entry.localPath) {
        const file = await this._readLocalResultPath(entry.localPath);
        const buffer = await (file.arrayBuffer ? file.arrayBuffer() : this._readAsArrayBuffer(file));
        entry.file = file;
        entry.extension = this._fileExtension(file.name);
        return buffer;
    }

    if (entry.fileHandle?.getFile) {
        let file = null;
        try {
            file = await entry.fileHandle.getFile();
        } catch (err) {
            console.warn('Could not read latest file handle; falling back to stored file snapshot.', err);
        }
        if (file) {
            // A reload re-reads whatever is on disk now. If the file has grown
            // past its format's limit since it was opened, that is a new
            // decision — the memo key includes size and mtime, so an unchanged
            // file never asks twice.
            const overLimit = this._checkFullLoadLimit(file, this._fileExtension(file.name));
            if (overLimit && !(await this._confirmOversizedFile(overLimit, file))) {
                const err = new Error('File load cancelled');
                err.name = 'AbortError';
                throw err;
            }
            try {
                const buffer = await (file.arrayBuffer ? file.arrayBuffer() : this._readAsArrayBuffer(file));
                entry.file = file;
                entry.extension = this._fileExtension(file.name);
                return buffer;
            } catch (err) {
                console.warn('Could not read latest file handle; falling back to stored file snapshot.', err);
            }
        }
    }

    if (this._shouldReselectFileForReload(entry)) {
        const file = await this._promptForReloadReselect(entry);
        if (!file) {
            const err = new Error('File selection cancelled');
            err.name = 'AbortError';
            throw err;
        }

        entry.file = file;
        entry.fileHandle = null;
        entry.extension = this._fileExtension(file.name);
        return file.arrayBuffer ? file.arrayBuffer() : this._readAsArrayBuffer(file);
    }

    // In Firefox the File object is refreshed on re-read. In Chromium it may
    // be a snapshot, so the FileSystemFileHandle path above is preferred.
    let buffer;
    if (entry.file?.arrayBuffer) {
        try {
            buffer = await entry.file.arrayBuffer();
        } catch (_) {}
    }
    if (!buffer) buffer = entry.buffer;
    if (!buffer) throw new Error('No buffer available');
    return buffer;
};

proto._shouldReselectFileForReload = function(entry) {
    return !entry.fileHandle && this._isChromeOrEdge();
};

proto._isChromeOrEdge = function() {
    const brands = navigator.userAgentData?.brands?.map(b => b.brand).join(' ') || '';
    if (/\b(Google Chrome|Microsoft Edge)\b/.test(brands)) return true;

    const ua = navigator.userAgent || '';
    return /\bEdg\//.test(ua) || (
        /\bChrome\//.test(ua) &&
        !/\b(Firefox|FxiOS|OPR|Opera|SamsungBrowser)\b/.test(ua)
    );
};

proto._promptForReloadReselect = function(entry) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'modal-dialog modal-dialog-alert';

        const content = document.createElement('div');
        content.className = 'modal-content';

        const icon = document.createElement('div');
        icon.className = 'modal-icon';
        icon.textContent = '🔄';
        content.appendChild(icon);

        const title = document.createElement('div');
        title.className = 'modal-title';
        title.textContent = i18n.t('reloadReselectTitle');
        content.appendChild(title);

        const message = document.createElement('div');
        message.className = 'modal-message';
        message.style.whiteSpace = 'pre-line';
        message.textContent = i18n.t('reloadReselectBody').replace('{file}', this._fileDisplayName(entry));
        content.appendChild(message);

        const input = document.createElement('input');
        input.type = 'file';
        input.style.display = 'none';
        document.body.appendChild(input);

        const buttons = document.createElement('div');
        buttons.className = 'modal-buttons';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-btn modal-btn-cancel';
        cancelBtn.textContent = i18n.t('cancel');

        const selectBtn = document.createElement('button');
        selectBtn.className = 'modal-btn modal-btn-confirm';
        selectBtn.textContent = i18n.t('reloadReselectSelect');

        buttons.append(cancelBtn, selectBtn);
        content.appendChild(buttons);
        modal.appendChild(content);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        let settled = false;
        const finish = (file = null) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', escHandler);
            window.removeEventListener('focus', focusHandler);
            input.remove();
            Modal.close(overlay);
            resolve(file);
        };

        const focusHandler = () => {
            setTimeout(() => {
                if (!settled && !input.files?.length) finish(null);
            }, 350);
        };

        const escHandler = (e) => {
            if (e.key === 'Escape') finish(null);
        };

        cancelBtn.addEventListener('click', () => finish(null));
        selectBtn.addEventListener('click', () => {
            window.addEventListener('focus', focusHandler);
            input.click();
        });
        input.addEventListener('change', () => finish(input.files?.[0] || null));
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) finish(null);
        });
        document.addEventListener('keydown', escHandler);

        setTimeout(() => selectBtn.focus(), 100);
        requestAnimationFrame(() => overlay.classList.add('show'));
    });
};

proto._canUseFileSystemPicker = function() {
    return typeof window !== 'undefined' &&
        window.location?.protocol !== 'file:' &&
        window.isSecureContext !== false &&
        typeof window.showOpenFilePicker === 'function';
};

proto._pickResultFilesWithHandles = async function(options = {}) {
    const handles = await window.showOpenFilePicker({
        multiple: options.multiple !== false,
    });

    const picked = [];
    for (const fileHandle of handles) {
        picked.push({ file: null, fileHandle });
    }
    return picked;
};

proto._getFileHandleSnapshot = async function(fileHandle) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fileHandle.getFile();
        } catch (err) {
            if (isTransientFileReadError(err) && attempt < 4) {
                await waitForFileRetry(attempt);
                continue;
            }
            throw err;
        }
    }
};

function normalizeBlobSliceRange(size, start = 0, end = size) {
    const total = Math.max(0, Math.floor(Number(size) || 0));
    const normalizeIndex = (value, fallback) => {
        if (value === undefined || value === null) return fallback;
        let index = Math.trunc(Number(value));
        if (!Number.isFinite(index)) index = 0;
        if (index < 0) index = Math.max(total + index, 0);
        return Math.min(Math.max(index, 0), total);
    };
    const normalizedStart = normalizeIndex(start, 0);
    const normalizedEnd = Math.max(normalizedStart, normalizeIndex(end, total));
    return { start: normalizedStart, end: normalizedEnd, size: normalizedEnd - normalizedStart };
}

proto._isDesktopStreamablePath = function(filePath) {
    const extension = this._fileExtension(filePath);
    return extension === '.csv' || extension === '.parquet';
};

proto._isPypsaNetcdfExtension = function(extension) {
    return extension === '.nc' || extension === '.netcdf';
};

proto._isPickleExtension = function(extension) {
    return extension === '.pkl' || extension === '.pickle';
};

proto._pypsaNetcdfEagerLimitBytes = function() {
    const fallback = this.capabilities?.isDesktop
        ? PYPSA_NETCDF_DESKTOP_EAGER_LIMIT_BYTES
        : PYPSA_NETCDF_WEB_EAGER_LIMIT_BYTES;
    return this._advancedSettingBytes('pypsaNetcdfFullLoadMb', fallback);
};

// Resolves the configured limit for one of the eager-only formats. Kept as the
// single place that knows about desktop/web defaults, so file-size-limits.js
// can stay free of capabilities and Settings.
proto._fullLoadLimitBytesFor = function(limitKey) {
    switch (limitKey) {
        case 'matlabFullLoadMb': return this._matlabEagerLimitBytes();
        case 'excelFullLoadMb': return this._excelEagerLimitBytes();
        case 'pickleFullLoadMb': return this._pickleEagerLimitBytes();
        case 'pypsaNetcdfFullLoadMb': return this._pypsaNetcdfEagerLimitBytes();
        default: return 0;
    }
};

// Verdict only — no dialog, no throw. Null means "nothing to warn about".
proto._checkFullLoadLimit = function(file, extension = this._fileExtension(file?.name || '')) {
    return checkFullLoadLimit(file, extension, key => this._fullLoadLimitBytesFor(key));
};

// Identity of one decision: this file, at this size, as of this timestamp. A
// file that changed on disk is a new decision.
proto._oversizedDecisionKey = function(file) {
    return [file?.name || '', Number(file?.size) || 0, Number(file?.lastModified) || 0].join(' ');
};

// Ask before loading a file bigger than its format's limit.
//
// This used to be a hard refusal. It is a warning now because the only failure
// it can actually prevent — a renderer out-of-memory crash — is largely
// contained since parsing moved into a worker: the worker dies, the tab
// survives, and the error surfaces normally. Refusing outright took a decision
// away from the user that the machine in front of them may well be able to make.
//
// The answer is remembered per file for the session, because this question is
// asked from two places: here, and again before the desktop reader pulls the
// bytes in. Asking twice for one file would read as a bug. This is NOT a "don't
// ask again" affordance — there is deliberately no way to silence the warning
// for a format or for future files, because a dialog people learn to dismiss
// has stopped being a safety signal.
proto._confirmOversizedFile = async function(verdict, file = null) {
    if (!verdict) return true;
    this._oversizedApproved ||= new Set();
    const key = this._oversizedDecisionKey(file || { name: verdict.name, size: verdict.sizeBytes });
    if (this._oversizedApproved.has(key)) return true;

    const body = i18n.t('fileOverLimitBody')
        .replace('{file}', verdict.name)
        .replace('{size}', this._formatFileSize(verdict.sizeBytes))
        .replace('{limit}', this._formatFileSize(verdict.limitBytes))
        .replace('{format}', i18n.t(verdict.formatLabelKey))
        .replace('{setting}', i18n.t(verdict.settingLabelKey));

    const choice = await Modal.choice(body, {
        title: i18n.t('fileOverLimitTitle'),
        icon: '⚠️',
        className: 'modal-dialog-wide',
        choices: [
            { value: 'cancel', text: i18n.t('cancel'), className: 'modal-btn-cancel', autoFocus: true },
            { value: 'load', text: i18n.t('fileOverLimitLoadAnyway'), className: 'modal-btn-confirm' },
        ],
    });
    if (choice !== 'load') return false;
    this._oversizedApproved.add(key);
    return true;
};

proto._pickleEagerLimitBytes = function() {
    const fallback = this.capabilities?.isDesktop
        ? PICKLE_DESKTOP_EAGER_LIMIT_BYTES
        : PICKLE_WEB_EAGER_LIMIT_BYTES;
    return this._advancedSettingBytes('pickleFullLoadMb', fallback);
};

proto._isExcelExtension = function(extension) {
    return extension === '.xlsx'
        || extension === '.xlsm'
        || extension === '.xls'
        || extension === '.ods';
};

proto._excelEagerLimitBytes = function() {
    const fallback = this.capabilities?.isDesktop
        ? EXCEL_DESKTOP_EAGER_LIMIT_BYTES
        : EXCEL_WEB_EAGER_LIMIT_BYTES;
    return this._advancedSettingBytes('excelFullLoadMb', fallback);
};

proto._createDesktopLocalHttpFile = function(filePath, info) {
    const name = info?.name || String(filePath).split(/[\\/]/).filter(Boolean).pop() || 'results.csv';
    const size = Math.max(0, Number(info?.size) || 0);
    const lastModified = Number(info?.lastModified) || Date.now();
    const type = info?.type || 'application/octet-stream';
    const origin = globalThis.location?.origin || '';
    const base = origin || '';
    const localUrl = `${base}${LOCAL_API_BASE}/file?path=${encodeURIComponent(filePath)}`;

    const readRange = async (start, end) => {
        const range = normalizeBlobSliceRange(size, start, end);
        if (range.size <= 0) return new ArrayBuffer(0);
        const response = await fetch(localUrl, {
            cache: 'no-store',
            headers: {
                Range: `bytes=${range.start}-${range.end - 1}`,
            },
        });
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(detail || i18n.t('errorLoading'));
        }
        if (response.status !== 206 && range.size !== size) {
            throw new Error('Local file server did not honor the requested byte range.');
        }
        return response.arrayBuffer();
    };

    // Blob-like on purpose, but intentionally minimal: current consumers need
    // metadata plus slice().arrayBuffer()/text(), not a real Blob instance.
    return {
        name,
        size,
        lastModified,
        type,
        localPath: filePath,
        localUrl,
        __omvLocalHttpFile: true,
        slice(start = 0, end = size, sliceType = '') {
            const range = normalizeBlobSliceRange(size, start, end);
            return {
                size: range.size,
                type: sliceType || type,
                arrayBuffer: () => readRange(range.start, range.end),
                text: async () => new TextDecoder('utf-8').decode(await readRange(range.start, range.end)),
            };
        },
        arrayBuffer: () => readRange(0, size),
    };
};

proto._readLocalResultPath = async function(filePath) {
    const desktopStat = globalThis.omvDesktop?.statFile;
    if (
        this.capabilities?.isDesktop
        && this._isDesktopStreamablePath(filePath)
        && typeof desktopStat === 'function'
    ) {
        try {
            const result = await desktopStat({ path: filePath });
            if (result?.ok === false) {
                const err = new Error(result.message || i18n.t('errorLoading'));
                err.name = result.name || 'Error';
                err.code = result.code || '';
                throw err;
            }
            return this._createDesktopLocalHttpFile(filePath, result);
        } catch (err) {
            const wrapped = new Error(err?.message || i18n.t('errorLoading'));
            wrapped.name = err?.name === 'Error' ? 'NotReadableError' : (err?.name || 'NotReadableError');
            wrapped.code = err?.code || '';
            throw wrapped;
        }
    }

    const desktopReader = globalThis.omvDesktop?.readFile;
    if (this.capabilities?.isDesktop && typeof desktopReader === 'function') {
        try {
            if (typeof desktopStat === 'function') {
                const statResult = await desktopStat({ path: filePath });
                if (statResult?.ok === false) {
                    const err = new Error(statResult.message || i18n.t('errorLoading'));
                    err.name = statResult.name || 'Error';
                    err.code = statResult.code || '';
                    throw err;
                }
                // Ask BEFORE pulling the bytes in. loadFile warns too, but by
                // then the whole file is already in memory — which on the file
                // sizes this warning exists for is the crash we are trying to
                // avoid. The answer is memoized, so only one of the two asks.
                const overLimit = this._checkFullLoadLimit(statResult, this._fileExtension(filePath));
                if (overLimit && !(await this._confirmOversizedFile(overLimit, statResult))) {
                    const err = new Error('File load cancelled');
                    err.name = 'AbortError';
                    throw err;
                }
            }
            const result = await desktopReader({ path: filePath });
            if (result?.ok === false) {
                const err = new Error(result.message || i18n.t('errorLoading'));
                err.name = result.name || 'Error';
                err.code = result.code || '';
                throw err;
            }
            const bytes = result?.bytes;
            if (!bytes) throw new Error(i18n.t('errorLoading'));
            const name = result.name || String(filePath).split(/[\\/]/).filter(Boolean).pop() || 'results.csv';
            return new File([bytes], name, {
                lastModified: Number(result.lastModified) || Date.now(),
                type: result.type || 'application/octet-stream',
            });
        } catch (err) {
            const wrapped = new Error(err?.message || i18n.t('errorLoading'));
            wrapped.name = err?.name === 'Error' ? 'NotReadableError' : (err?.name || 'NotReadableError');
            wrapped.code = err?.code || '';
            throw wrapped;
        }
    }

    const localUrl = `${LOCAL_API_BASE}/file?path=${encodeURIComponent(filePath)}`;
    const extension = this._fileExtension(filePath);
    const name = String(filePath).split(/[\\/]/).filter(Boolean).pop() || 'results.csv';
    if (this._isPypsaNetcdfExtension(extension) || this._isPickleExtension(extension) || this._isExcelExtension(extension)) {
        let headResponse = null;
        try {
            headResponse = await fetch(localUrl, { method: 'HEAD', cache: 'no-store' });
        } catch (_) {
            headResponse = null;
        }
        if (headResponse?.ok) {
            const size = Number(headResponse.headers.get('content-length') || 0);
            const statLike = { name, size };
            // Same reason as the desktop reader above: the fetch that follows
            // materializes the whole file, so the question has to come first.
            const overLimit = this._checkFullLoadLimit(statLike, extension);
            if (overLimit && !(await this._confirmOversizedFile(overLimit, statLike))) {
                const err = new Error('File load cancelled');
                err.name = 'AbortError';
                throw err;
            }
        }
    }

    const response = await fetch(localUrl, { cache: 'no-store' });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(detail || i18n.t('errorLoading'));
    }
    const blob = await response.blob();
    const lastModified = Number(response.headers.get('x-omv-last-modified')) || Date.now();
    return new File([blob], name, { lastModified, type: response.headers.get('content-type') || 'application/octet-stream' });
};
proto._openResultFilesFromUser = async function() {
    const desktopPicker = globalThis.omvDesktop?.selectFilePaths;
    if (this.capabilities?.isDesktop && typeof desktopPicker === 'function') {
        try {
            const paths = await desktopPicker({ title: 'Select result files' });
            if (!paths?.length) return;
            const picked = [];
            for (const localPath of paths) {
                const file = await this._readLocalResultPath(localPath);
                picked.push({ file, fileHandle: null, localPath });
            }
            await this.loadFiles(picked);
            return;
        } catch (err) {
            console.warn('Desktop file picker failed; using browser file picker fallback.', err);
        }
    }

    if (this._canUseFileSystemPicker()) {
        try {
            const picked = await this._pickResultFilesWithHandles({ multiple: true });
            await this.loadFiles(picked);
            return;
        } catch (err) {
            if (err?.name === 'AbortError') return;
            console.warn('File System Access picker failed; using file input fallback.', err);
        }
    }

    document.getElementById('file-input').click();
};

proto._getDroppedResultFiles = async function(dataTransfer) {
    const picked = [];
    const items = Array.from(dataTransfer?.items || []);
    const canReadDroppedHandles = items.some(item => (
        item.kind === 'file' && typeof item.getAsFileSystemHandle === 'function'
    ));

    if (canReadDroppedHandles) {
        for (const item of items) {
            if (item.kind !== 'file' || typeof item.getAsFileSystemHandle !== 'function') continue;
            try {
                const fileHandle = await item.getAsFileSystemHandle();
                if (fileHandle?.kind !== 'file') continue;
                const file = await this._getFileHandleSnapshot(fileHandle);
                picked.push({ file, fileHandle });
            } catch (err) {
                console.warn('Could not read dropped file handle.', err);
            }
        }

        if (picked.length) return picked;
    }

    return Array.from(dataTransfer?.files || [])
        .map(file => ({ file, fileHandle: null }));
};

proto._fileExtension = function(filename) {
    const match = String(filename || '').toLowerCase().match(/\.[^.]+$/);
    return match ? match[0] : '';
};

proto._fileBaseName = function(filename) {
    return String(filename || 'results').replace(/\.[^.]+$/i, '');
};

proto._fileDisplayName = function(entry) {
    return `${entry?.name || ''}${entry?.extension ?? '.mat'}`;
};

proto._parseResultBuffer = async function(filename, buffer, file = null, options = {}) {
    const extension = this._fileExtension(filename);
    if (extension === '.parquet') return this._parseParquetResult(filename, file);
    if (extension === '.nc' || extension === '.netcdf') return this._parsePypsaNetcdfResultBuffer(filename, buffer, options);
    if (this._isPickleExtension(extension)) return this._parsePickleResultBuffer(filename, buffer, options);
    if (this._isExcelExtension(extension)) return this._parseExcelResultBuffer(filename, buffer, options);
    if (extension === '.mat') return this._parseMatlabResultBuffer(filename, buffer, options);
    // Routed by extension, not by sniffing the bytes: a known text file may
    // have been left unread on purpose (see _canParseFromFile) so DuckDB can
    // stream it, and there would be no buffer here to sniff.
    if (isTextTableExtension(extension)) return this._parseCsvResultBuffer(filename, buffer, file, options);
    if (this._looksLikePickleBuffer(buffer)) throw new Error(i18n.t('pickleLooksLikeUnsupportedExtension'));
    if (this._looksLikeTextBuffer(buffer)) return this._parseCsvResultBuffer(filename, buffer, file, options);
    throw new Error(i18n.t('invalidFile'));
};

proto._matlabEagerLimitBytes = function() {
    const fallback = this.capabilities?.isDesktop
        ? MATLAB_MAT_DESKTOP_EAGER_LIMIT_BYTES
        : MATLAB_MAT_WEB_EAGER_LIMIT_BYTES;
    return this._advancedSettingBytes('matlabFullLoadMb', fallback);
};

proto._parseMatlabResultBuffer = async function(filename, buffer, options = {}) {
    const inspection = options.matInspection || null;
    const selection = options.matSelection || null;
    const workerBuffer = detachedCopy(buffer);
    return parseOffThread(
        'parse:mat',
        { filename, buffer: workerBuffer, inspection, selection },
        [workerBuffer],
        async () => {
            const Parser = await loadMatlabMatFileClass();
            const parser = new Parser(this.parser);
            return parser.parse(buffer, filename, { inspection, selection });
        },
    );
};

proto._parsePypsaNetcdfResultBuffer = async function(filename, buffer, options = {}) {
    // Infinity disables the reader's own ceiling: the user already saw the
    // warning and chose to proceed, so refusing here would be a second veto on
    // a decision they have made.
    const maxFileBytes = options.allowOversized ? Infinity : this._pypsaNetcdfEagerLimitBytes();
    const workerBuffer = detachedCopy(buffer);
    return parseOffThread(
        'parse:netcdf',
        { filename, buffer: workerBuffer, maxFileBytes },
        [workerBuffer],
        async () => {
            const Parser = await loadPypsaNetcdfParserClass();
            const parser = new Parser(this.parser);
            return parser.parse(buffer, filename, { maxFileBytes });
        },
    );
};

// Spreadsheets are not parsed directly: the selected sheet is serialized to
// deterministic CSV text and fed to the CSV pipeline, so header/time
// detection, profiles and the parsing-preview dialog all apply unchanged.
proto._parseExcelResultBuffer = async function(filename, buffer, options = {}) {
    // Decoding the workbook and serializing the sheet is the expensive half —
    // the code below used to note "tens of seconds of blocked main thread" — so
    // both happen in the worker. The one exception is when the sheet-picker
    // dialog already holds a decoded workbook: that object cannot be posted to
    // a worker, and re-decoding to avoid a stall the user has already paid for
    // would be slower overall.
    const converted = options.excelWorkbook
        ? null
        : await this._convertExcelBufferToCsv(buffer, options.excelSheetName || null);

    let csvBuffer;
    let sheetName;
    let sheetNames;
    if (converted) {
        ({ csvBuffer, sheetName, sheetNames } = converted);
    } else {
        const excel = await loadExcelWorkbookModule();
        const workbook = options.excelWorkbook;
        sheetName = resolveExcelSheetName(excel, workbook, options.excelSheetName || null);
        if (sheetName) csvBuffer = excel.csvTextToBuffer(excel.sheetToCsvText(workbook, sheetName));
        sheetNames = excel.listSheets(workbook).map(sheet => sheet.name);
    }
    if (!sheetName) {
        throw new Error(i18n.t('excelNoDataSheets').replace('{file}', filename));
    }
    // file = null on purpose: it keeps the converted buffer out of the DuckDB
    // lazy path and the Parquet hints, while still using the parser worker.
    const data = await this._parseCsvResultBuffer(filename, csvBuffer, null, {
        csvProfile: options.csvProfile || null,
    });
    data.metadata.excel = { sheetName, sheetNames };
    // Non-enumerable so it never leaks into session snapshots; the caller
    // moves it onto the file entry via _adoptExcelCsvCache.
    Object.defineProperty(data, '_excelCsvBuffer', {
        value: csvBuffer,
        configurable: true,
        writable: true,
        enumerable: false,
    });
    return data;
};

// Re-derives the CSV view of an Excel-origin entry (adjust-parsing, session
// profile restore). Any caller that re-parses an entry with entry.excel set
// must go through this instead of feeding raw workbook bytes to the CSV path.
// The converted CSV is cached on the entry: decoding a large workbook takes
// tens of seconds of blocked main thread, so it must happen at most once per
// workbook version (the cache is keyed on the raw-buffer identity + sheet).
proto._convertExcelEntryToCsvBuffer = async function(entry, { sheetName = null } = {}) {
    const preferredName = sheetName || entry.excel?.sheetName || null;
    const rawBuffer = entry.buffer || await this._readLatestBuffer(entry);
    if (this._hasExcelCsvCache(entry, rawBuffer, preferredName)) {
        return {
            csvBuffer: entry.excelCsvBuffer,
            rawBuffer,
            sheetName: entry.excelCsvSheetName,
            sheetNames: entry.excel?.sheetNames || null,
        };
    }
    const converted = await this._convertExcelBufferToCsv(rawBuffer, preferredName);
    if (!converted?.sheetName) {
        throw new Error(i18n.t('excelNoDataSheets').replace('{file}', this._fileDisplayName(entry)));
    }
    entry.excelCsvBuffer = converted.csvBuffer;
    entry.excelCsvSheetName = converted.sheetName;
    entry.excelCsvSourceBuffer = rawBuffer;
    return {
        csvBuffer: converted.csvBuffer,
        rawBuffer,
        sheetName: converted.sheetName,
        sheetNames: converted.sheetNames,
    };
};

proto._hasExcelCsvCache = function(entry, rawBuffer = entry?.buffer, preferredName = entry?.excel?.sheetName || null) {
    return !!(entry?.excelCsvBuffer
        && entry.excelCsvSourceBuffer === rawBuffer
        && (!preferredName || entry.excelCsvSheetName === preferredName));
};

// Workbook bytes -> { csvBuffer, sheetName, sheetNames }, off-thread when a
// worker is available. Returns null only when the workbook has no usable sheet.
proto._convertExcelBufferToCsv = async function(buffer, preferredSheet = null) {
    const workerBuffer = detachedCopy(buffer);
    const converted = await parseOffThread(
        'parse:excelToCsv',
        { buffer: workerBuffer, preferredSheet },
        [workerBuffer],
        async () => {
            const excel = await loadExcelWorkbookModule();
            const workbook = excel.readWorkbook(await excel.loadXlsxModule(), buffer);
            const sheetName = resolveExcelSheetName(excel, workbook, preferredSheet);
            return {
                csvBuffer: sheetName ? excel.csvTextToBuffer(excel.sheetToCsvText(workbook, sheetName)) : null,
                sheetName: sheetName || '',
                sheetNames: excel.listSheets(workbook).map(sheet => sheet.name),
            };
        },
    );
    return converted?.sheetName ? converted : { ...converted, sheetName: '' };
};

// _parseExcelResultBuffer stashes the converted CSV on the parsed data so
// callers that own a file entry can adopt it into the entry-level cache.
proto._adoptExcelCsvCache = function(entry, data) {
    if (!entry || !data?._excelCsvBuffer) return;
    entry.excelCsvBuffer = data._excelCsvBuffer;
    entry.excelCsvSheetName = data.metadata?.excel?.sheetName || null;
    entry.excelCsvSourceBuffer = entry.buffer || null;
    delete data._excelCsvBuffer;
};

proto._parsePickleResultBuffer = async function(filename, buffer, options = {}) {
    // See _parsePypsaNetcdfResultBuffer: the reader enforces the same ceiling,
    // so an override has to reach it too.
    const maxFileBytes = options.allowOversized ? Infinity : this._pickleEagerLimitBytes();
    const workerBuffer = detachedCopy(buffer);
    try {
        return await parseOffThread(
            'parse:pickle',
            { filename, buffer: workerBuffer, maxFileBytes },
            [workerBuffer],
            async () => {
                const Parser = await loadPickleParserClass();
                const parser = new Parser(this.parser);
                return parser.parse(buffer, filename, { maxFileBytes });
            },
        );
    } catch (err) {
        if (err?.code === 'PICKLE_COMPRESSED_UNSUPPORTED') {
            throw new Error(i18n.t('pickleCompressedUnsupported')
                .replace('{format}', err.format || 'unknown'));
        }
        if (err?.code === 'PICKLE_UNSUPPORTED_OBJECT') {
            throw new Error(i18n.t('pickleUnsupportedObject')
                .replace('{type}', err.type || err.message || 'unknown'));
        }
        throw err;
    }
};

// Files bigger than this threshold (bytes) trigger DuckDB lazy mode: the
// in-memory copy holds a downsampled overview, and zoom queries hit DuckDB.
const DUCKDB_LAZY_THRESHOLD_BYTES = 150 * 1024 * 1024;
const PARQUET_LAZY_THRESHOLD_BYTES = 100 * 1024 * 1024;
// CSV files larger than this should ideally be pre-converted to Parquet
// (`node bench/csv-to-parquet.mjs file.csv`) — the WASM heap ceiling makes
// the raw CSV path risky above this size.
const PARQUET_HINT_THRESHOLD_BYTES = 500 * 1024 * 1024;
// Above this size the legacy JS parser is unsafe: it decodes the whole file
// into one string and can OOM the browser tab before throwing cleanly.
const LEGACY_CSV_FALLBACK_MAX_BYTES = 450 * 1024 * 1024;
const CSV_PREVIEW_SEGMENT_BYTES = 2 * 1024 * 1024;
const MB_BYTES = 1024 * 1024;

proto._advancedSettingMb = function(key, fallbackMb) {
    const raw = Number(this.advancedSettings?.[key]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallbackMb;
};

proto._advancedSettingBytes = function(key, fallbackBytes) {
    const fallbackMb = fallbackBytes / MB_BYTES;
    return Math.round(this._advancedSettingMb(key, fallbackMb) * MB_BYTES);
};

proto._csvFullLoadLimitBytes = function() {
    return this._advancedSettingBytes('csvFullLoadMb', DUCKDB_LAZY_THRESHOLD_BYTES);
};

proto._parquetFullLoadLimitBytes = function() {
    return this._advancedSettingBytes('parquetFullLoadMb', PARQUET_LAZY_THRESHOLD_BYTES);
};

proto._csvCompactHintBytes = function() {
    return this._advancedSettingBytes('csvCompactHintMb', PARQUET_HINT_THRESHOLD_BYTES);
};

// Can this file be handed to the reader as a file, instead of being read into
// an ArrayBuffer first?
//
// This gated on `.csv` alone, so every other text file was fully buffered
// before parsing: a 600 MB `.txt` reserved 600 MB of memory before DuckDB —
// which can stream it — ever saw it. That undid most of the benefit of the
// memory-saving path for exactly the files that need it.
//
// KNOWN text extensions only, deliberately. An unrecognised extension still
// has to be read so _parseResultBuffer can sniff its bytes and decide what it
// is; skipping the read would leave nothing to sniff.
proto._canParseFromFile = function(file, extension = this._fileExtension(file?.name || '')) {
    return !!file
        && (isTextTableExtension(extension) || extension === '.parquet')
        && this._canUseDuckDb();
};

proto._fileFingerprint = function(file) {
    if (!file) return '';
    return [
        'file',
        file.name || '',
        file.size ?? '',
        file.lastModified ?? '',
        file.type || '',
    ].join(':');
};

proto._readFileSampleBuffer = async function(file, bytes = 1024 * 1024) {
    if (!file) return null;
    const blob = typeof file.slice === 'function' ? file.slice(0, bytes) : file;
    return blob.arrayBuffer ? blob.arrayBuffer() : this._readAsArrayBuffer(blob);
};

proto._readCsvPreviewSegment = async function(file, region = 'start', bytes = CSV_PREVIEW_SEGMENT_BYTES) {
    if (!file) return null;
    const requestedBytes = Math.max(64 * 1024, Number(bytes) || CSV_PREVIEW_SEGMENT_BYTES);
    const totalSize = Math.max(0, Number(file.size || 0));
    const cappedBytes = totalSize > 0 ? Math.min(requestedBytes, totalSize) : requestedBytes;
    let offset = 0;
    if (region === 'middle' && totalSize > cappedBytes) {
        offset = Math.max(0, Math.floor((totalSize - cappedBytes) / 2));
    } else if (region === 'end' && totalSize > cappedBytes) {
        offset = Math.max(0, totalSize - cappedBytes);
    }
    const end = totalSize > 0 ? Math.min(totalSize, offset + cappedBytes) : undefined;
    const blob = typeof file.slice === 'function' ? file.slice(offset, end) : file;
    const buffer = blob.arrayBuffer ? await blob.arrayBuffer() : await this._readAsArrayBuffer(blob);
    return {
        id: region,
        buffer,
        offset,
        bytes: requestedBytes,
        totalSize,
        truncated: totalSize > 0 && buffer.byteLength < totalSize,
    };
};

proto._readCsvPreviewSegments = async function(file, options = {}) {
    const bytes = Number(options.bytes) || CSV_PREVIEW_SEGMENT_BYTES;
    if (!file) return [];
    const segments = [];
    const segment = await this._readCsvPreviewSegment(file, 'start', bytes);
    if (segment?.buffer) segments.push(segment);
    return segments;
};

proto._inspectCsvSample = async function(file, buffer = null) {
    const sampleBuffer = buffer || await this._readFileSampleBuffer(file);
    return this.csvParser.inspectSample(sampleBuffer, { maxRows: 700 });
};

proto._largeCsvDecisionKey = function(file, filename = '') {
    return this._fileFingerprint(file) || `${filename || file?.name || 'csv'}:${file?.size || 0}`;
};

proto._shouldOfferLargeCsvPreflight = function(file, options = {}) {
    if (options.skipLargeCsvPreflight) return false;
    const extension = options.extension || this._fileExtension(file?.name || '');
    // Any delimited text, not just `.csv`. The reader never checked the
    // extension — it parses whatever sniffs as text — but this offer did, so a
    // 900 MB `.txt` measurement log was left with no way to convert it.
    // `mayBeTextTable` also lets unknown extensions through, since refusing
    // them is exactly what made people rename files to get here.
    if (!mayBeTextTable(extension)) return false;
    if (!this.capabilities?.isDesktop) return false;
    if (!file?.localPath) return false;
    if (Number(file.size || 0) < this._csvCompactHintBytes()) return false;
    if (typeof globalThis.omvDesktop?.convertToParquet !== 'function') return false;
    const key = this._largeCsvDecisionKey(file);
    return !this._largeCsvRawApproved?.has(key);
};

proto._defaultParquetOutputPath = function(file) {
    const source = file?.localPath || file?.name || 'results.csv';
    return String(source).replace(/\.[^.\\/]+$/i, '') + '.parquet';
};

proto._maybeConvertLargeCsvBeforeLoad = async function(file, options = {}) {
    if (!this._shouldOfferLargeCsvPreflight(file, options)) return null;

    let csvProfile = null;
    try {
        csvProfile = await this._inspectCsvSample(file);
    } catch (err) {
        console.warn('[csv] could not inspect sample before Parquet preflight:', err?.message || err);
    }

    const mb = (Number(file.size || 0) / (1024 * 1024)).toFixed(0);
    let choice = await Modal.choice(
        i18n.t('largeCsvPreflightBody')
            .replace('{file}', file.name || 'results.csv')
            .replace('{size}', `${mb} MB`),
        {
            title: i18n.t('largeCsvPreflightTitle'),
            icon: 'CSV',
            className: 'modal-dialog-large-csv',
            choices: [
                {
                    value: 'review',
                    text: i18n.t('csvPreviewReviewStructure'),
                    className: 'modal-btn-confirm',
                    autoFocus: true,
                },
                {
                    value: 'save',
                    text: i18n.t('largeCsvPreflightSave'),
                    className: 'modal-btn-confirm modal-btn-secondary-confirm',
                },
                {
                    value: 'temporary',
                    text: i18n.t('largeCsvPreflightTemporary'),
                    className: 'modal-btn-confirm modal-btn-secondary-confirm',
                },
                {
                    value: 'raw',
                    text: i18n.t('largeCsvPreflightRaw'),
                    className: 'modal-btn-cancel',
                },
            ],
        }
    );

    if (!choice) return { cancelled: true };
    if (choice === 'review') {
        const reviewedProfile = await this._openCsvParsingPreviewForFileObject(file, {
            csvProfile,
            title: file.name || 'results.csv',
        });
        if (!reviewedProfile) return { cancelled: true };
        csvProfile = reviewedProfile;
        choice = await Modal.choice(
            i18n.t('csvPreviewReviewedPreflightBody'),
            {
                title: i18n.t('largeCsvPreflightTitle'),
                icon: 'CSV',
                className: 'modal-dialog-large-csv',
                choices: [
                    {
                        value: 'save',
                        text: i18n.t('largeCsvPreflightSave'),
                        className: 'modal-btn-confirm',
                        autoFocus: true,
                    },
                    {
                        value: 'temporary',
                        text: i18n.t('largeCsvPreflightTemporary'),
                        className: 'modal-btn-confirm modal-btn-secondary-confirm',
                    },
                    {
                        value: 'raw',
                        text: i18n.t('largeCsvPreflightRaw'),
                        className: 'modal-btn-cancel',
                    },
                ],
            }
        );
        if (!choice) return { cancelled: true };
    }
    if (choice === 'raw') {
        this._largeCsvRawApproved ||= new Set();
        this._largeCsvRawApproved.add(this._largeCsvDecisionKey(file));
        return csvProfile?.profileSource === 'user' ? { csvProfile } : null;
    }

    let outputPath = '';
    const temporary = choice === 'temporary';
    if (!temporary) {
        const picker = globalThis.omvDesktop?.selectParquetOutputPath;
        if (typeof picker !== 'function') throw new Error(i18n.t('parquetConversionUnavailable'));
        outputPath = await picker({
            title: i18n.t('largeCsvPreflightSaveDialogTitle'),
            defaultPath: this._defaultParquetOutputPath(file),
        });
        if (!outputPath) return { cancelled: true };
    }

    const parquetFile = await this._convertCsvFileToParquetFile(file, {
        csvProfile,
        outputPath,
        temporary,
        keepOverlayUntilLoaded: true,
    });
    return {
        file: parquetFile,
        localPath: parquetFile.localPath,
        temporaryParquetPath: temporary ? parquetFile.localPath : '',
        keepOverlayUntilLoaded: true,
    };
};

proto._showParquetConversionOverlay = function(filename) {
    document.getElementById('file-loading-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'file-loading-overlay';
    overlay.className = 'example-loading-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    const dialog = document.createElement('div');
    dialog.className = 'example-loading-dialog';

    const spinner = document.createElement('div');
    spinner.className = 'example-loading-spinner';

    const title = document.createElement('div');
    title.id = 'file-loading-title';
    title.className = 'example-loading-title';
    title.textContent = i18n.t('convertingToParquet');

    const hint = document.createElement('div');
    hint.id = 'file-loading-hint';
    hint.className = 'example-loading-hint';
    hint.dataset.filename = filename || '';

    dialog.append(spinner, title, hint);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('show'));
};

proto._updateParquetConversionOverlay = function(startedAt) {
    const hint = document.getElementById('file-loading-hint');
    if (!hint) return;
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    hint.textContent = i18n.t('parquetConversionInProgress').replace('{seconds}', String(seconds));
};

proto._setParquetConversionOverlayLoading = function() {
    const hint = document.getElementById('file-loading-hint');
    if (hint) hint.textContent = i18n.t('parquetConversionComplete');
};

proto._convertCsvFileToParquetFile = async function(file, options = {}) {
    if (!file?.localPath) throw new Error(i18n.t('parquetConversionDesktopOnly'));
    const converter = globalThis.omvDesktop?.convertToParquet;
    if (typeof converter !== 'function') throw new Error(i18n.t('parquetConversionUnavailable'));

    const started = Date.now();
    this._showParquetConversionOverlay(file.name);
    this._updateParquetConversionOverlay(started);
    let timer = setInterval(() => this._updateParquetConversionOverlay(started), 1000);
    let handedOffToLoad = false;
    try {
        const result = await converter({
            path: file.localPath,
            outputPath: options.outputPath || '',
            temporary: options.temporary === true,
            csvProfile: cloneCsvProfileForIpc(options.csvProfile),
            compression: 'zstd',
        });
        if (result?.ok === false) throw new Error(result.message || i18n.t('parquetConversionFailed'));
        if (!result?.outputPath) throw new Error(i18n.t('parquetConversionFailed'));
        clearInterval(timer);
        timer = null;
        this._setParquetConversionOverlayLoading();
        const parquetFile = await this._readLocalResultPath(result.outputPath);
        handedOffToLoad = true;
        return parquetFile;
    } finally {
        if (timer) clearInterval(timer);
        if (!options.keepOverlayUntilLoaded || !handedOffToLoad) {
            this._hideFileLoadingOverlay();
        }
    }
};

proto._quoteCommandPath = function(path) {
    return `"${String(path || '').replace(/"/g, '\\"')}"`;
};

// ─── Spreadsheet → Parquet ────────────────────────────────────────────────
//
// A spreadsheet is decoded from scratch on every open, and that decode is the
// single most expensive thing the app does: a 126 MB .xlsx measures ~68 s, every
// time. The app already turns the chosen sheet into CSV text on load, so the
// expensive half of a Parquet conversion has been paid for by the time the file
// is on screen — converting from there costs seconds and makes every later open
// near-instant.
//
// Offered after the load rather than before it, deliberately. Before, we would
// have nothing to convert yet (the workbook has to be decoded first), and the
// user would be answering a question about a file they have not seen.

// Below this the decode is quick enough that interrupting to offer a
// conversion costs more attention than it saves: a 4 MB sheet is a few seconds,
// an 18 MB one is about fourteen, and a 126 MB one about sixty-eight.
const SPREADSHEET_PARQUET_HINT_BYTES = 4 * 1024 * 1024;

// Writing Parquet never actually needed the desktop build. The native
// converter is used when it is there because it also writes the file to a real
// path; in the browser DuckDB-WASM does the same conversion in memory and the
// result is handed to the user through the save dialog instead. Gating this on
// isDesktop meant the one runtime with the LOWER spreadsheet limit — the
// browser — was also the one with no way out of it.
proto._canConvertSpreadsheetToParquet = function(entry) {
    if (!entry || !this._isExcelExtension(entry.extension)) return false;
    if (Number(entry.file?.size || 0) < SPREADSHEET_PARQUET_HINT_BYTES) return false;
    return typeof globalThis.omvDesktop?.convertToParquet === 'function' || this._canUseDuckDb();
};

// The CSV form of the sheet: from the load-time cache when it is still valid,
// re-derived from the workbook otherwise.
proto._spreadsheetCsvBytes = async function(entry) {
    if (this._hasExcelCsvCache(entry)) return entry.excelCsvBuffer;
    const converted = await this._convertExcelEntryToCsvBuffer(entry);
    return converted.csvBuffer;
};

// Non-blocking offer after a spreadsheet loads. Shown once per file per
// session; dismissing it is a normal outcome, so it never returns.
proto._showSpreadsheetParquetHint = function(entry) {
    if (!this._canConvertSpreadsheetToParquet(entry)) return;
    if (typeof document === 'undefined') return;

    const key = this._oversizedDecisionKey(entry.file || {});
    this._spreadsheetHintsShown ||= new Set();
    if (this._spreadsheetHintsShown.has(key)) return;
    this._spreadsheetHintsShown.add(key);

    document.getElementById('spreadsheet-parquet-hint')?.remove();
    const filename = entry.file?.name || entry.name || '';

    const notice = document.createElement('div');
    notice.id = 'spreadsheet-parquet-hint';
    notice.className = 'dismissible-notice large-csv-parquet-hint';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');

    const content = document.createElement('div');
    content.className = 'dismissible-notice-content';

    const title = document.createElement('div');
    title.className = 'dismissible-notice-title';
    title.textContent = i18n.t('spreadsheetParquetHintTitle');

    const body = document.createElement('div');
    body.className = 'dismissible-notice-body';
    body.textContent = i18n.t('spreadsheetParquetHintBody').replace('{file}', filename);

    const actions = document.createElement('div');
    actions.className = 'dismissible-notice-actions';

    const convert = document.createElement('button');
    convert.type = 'button';
    convert.className = 'dismissible-notice-action primary';
    convert.textContent = i18n.t('spreadsheetParquetHintConvert');

    const status = document.createElement('div');
    status.className = 'dismissible-notice-status';
    status.hidden = true;

    convert.addEventListener('click', async () => {
        convert.disabled = true;
        status.hidden = false;
        status.classList.remove('error', 'success');
        status.textContent = i18n.t('convertingToParquet');
        try {
            const parquetFile = await this._convertSpreadsheetEntryToParquet(entry, { temporary: false });
            if (!parquetFile) { convert.disabled = false; status.hidden = true; return; }
            status.classList.add('success');
            status.textContent = i18n.t('parquetConversionComplete');
            await this.loadFile(parquetFile, { localPath: parquetFile.localPath });
            notice.remove();
        } catch (err) {
            this._hideFileLoadingOverlay();
            convert.disabled = false;
            status.classList.add('error');
            status.textContent = err?.message || String(err);
        }
    });

    actions.append(convert, status);
    content.append(title, body, actions);

    const close = document.createElement('button');
    close.className = 'dismissible-notice-close';
    close.type = 'button';
    close.title = i18n.t('dismiss');
    close.setAttribute('aria-label', i18n.t('dismiss'));
    close.textContent = '×';
    close.addEventListener('click', () => notice.remove());

    notice.append(content, close);
    document.body.appendChild(notice);
    requestAnimationFrame(() => notice.classList.add('show'));
};

// "microgrid-demo.xlsx" + sheet "Registro" -> "microgrid-demo - Registro.parquet".
// The sheet name is part of it because one workbook can produce several.
proto._spreadsheetParquetName = function(entry, sheetName) {
    const base = this._fileBaseName(entry.file?.name || entry.name || 'spreadsheet');
    const suffix = sheetName && sheetName !== base ? ` - ${sheetName}` : '';
    return `${base}${suffix}`.replace(/[\\/:*?"<>|]/g, '_') + '.parquet';
};

// Hand bytes to the user. showSaveFilePicker lets them choose where it lands
// and is the only way the file survives usefully; without it (Firefox, Safari)
// a download is the best the browser allows.
proto._saveBytesToDisk = async function(bytes, filename) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' });
    const picker = globalThis.showSaveFilePicker;
    if (typeof picker === 'function') {
        try {
            const handle = await picker({
                suggestedName: filename,
                types: [{ description: 'Parquet', accept: { 'application/octet-stream': ['.parquet'] } }],
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            return true;
        } catch (err) {
            // Cancelling the dialog is a normal answer, not a failure: the
            // caller still gets the converted file to open right now.
            if (err?.name === 'AbortError') return false;
            console.warn('[parquet] save picker failed; falling back to download', err);
        }
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
    return true;
};

proto._convertSpreadsheetEntryToParquet = async function(entry, { temporary = false } = {}) {
    const converter = globalThis.omvDesktop?.convertToParquet;
    const inBrowser = typeof converter !== 'function';
    if (inBrowser && !this._canUseDuckDb()) throw new Error(i18n.t('parquetConversionUnavailable'));

    const csvBuffer = await this._spreadsheetCsvBytes(entry);
    const sheetName = entry.excelCsvSheetName || entry.excel?.sheetName || 'sheet';

    // Show the parsing before committing to it, exactly as the text-file route
    // does. The sheet has already been turned into CSV, so the questions are
    // the same ones: which row is the header, which column is time, how numbers
    // are written. Converting without asking would bake a wrong answer into a
    // file that then looks authoritative.
    const reviewed = await this._openCsvParsingPreviewForFileObject(null, {
        sampleBuffer: spreadsheetPreviewSample(csvBuffer),
        csvProfile: entry.data?.metadata?.csvProfile || null,
        title: entry.file?.name || entry.name || sheetName,
    });
    if (!reviewed) return null;   // backed out of the preview

    const parquetName = this._spreadsheetParquetName(entry, sheetName);

    if (inBrowser) {
        const started = Date.now();
        this._showParquetConversionOverlay(entry.file?.name || entry.name || '');
        const timer = setInterval(() => this._updateParquetConversionOverlay(started), 1000);
        try {
            const source = await this._getDuckDbSource();
            const parquetBytes = await source.convertCsvBufferToParquet(csvBuffer, {
                csvProfile: reviewed,
                compression: 'zstd',
            });
            this._setParquetConversionOverlayLoading();
            // Offer to keep it. Converting only in memory would make this open
            // faster and every future one exactly as slow as before, which is
            // the opposite of the point.
            await this._saveBytesToDisk(parquetBytes, parquetName);
            return new File([parquetBytes], parquetName, { type: 'application/octet-stream' });
        } finally {
            clearInterval(timer);
        }
    }

    let outputPath = '';
    if (!temporary) {
        const picker = globalThis.omvDesktop?.selectParquetOutputPath;
        if (typeof picker !== 'function') throw new Error(i18n.t('parquetConversionUnavailable'));
        outputPath = await picker({
            title: i18n.t('largeCsvPreflightSaveDialogTitle'),
            defaultPath: this._defaultParquetOutputPath({
                localPath: entry.localPath,
                name: entry.file?.name || `${entry.name || 'sheet'}.xlsx`,
            }),
        });
        if (!outputPath) return null;
    }

    const started = Date.now();
    this._showParquetConversionOverlay(entry.file?.name || entry.name || '');
    const timer = setInterval(() => this._updateParquetConversionOverlay(started), 1000);
    try {
        // `bytes` rather than `path`: the sheet only exists as CSV text in
        // memory. The main process stages it, converts, and removes the stage.
        // An explicit outputPath or `temporary` is required — without a real
        // source path there is no sensible place to put the result next to.
        const result = await converter({
            bytes: new Uint8Array(csvBuffer),
            sourceName: `${sheetName}.csv`,
            csvProfile: cloneCsvProfileForIpc(reviewed),
            outputPath,
            temporary,
            compression: 'zstd',
        });
        if (result?.ok === false) throw new Error(result.message || i18n.t('parquetConversionFailed'));
        if (!result?.outputPath) throw new Error(i18n.t('parquetConversionFailed'));
        this._setParquetConversionOverlayLoading();
        return await this._readLocalResultPath(result.outputPath);
    } finally {
        clearInterval(timer);
    }
};

proto._showLargeCsvParquetHint = function(filename, fileSize, file = null, csvProfile = null) {
    const key = this._largeCsvDecisionKey(file, filename);
    if (this._largeCsvRawApproved?.has(key)) return;
    this._largeCsvParquetHintsShown ||= new Set();
    if (this._largeCsvParquetHintsShown.has(key)) return;
    this._largeCsvParquetHintsShown.add(key);

    const canConvertInApp = typeof globalThis.omvDesktop?.convertToParquet === 'function'
        && file?.localPath
        && this.capabilities?.isDesktop;
    const commandPath = file?.localPath || filename;
    const command = `node bench/csv-to-parquet.mjs ${this._quoteCommandPath(commandPath)}`;
    const mb = Number.isFinite(fileSize) ? (fileSize / (1024 * 1024)).toFixed(0) : '?';
    const strong = Number(fileSize) >= PARQUET_STRONG_HINT_BYTES;
    console.warn(`[duckdb] "${filename}" is ${mb} MB — consider converting to Parquet for faster loads:`
        + `\n  ${command}\n  Then load the resulting .parquet directly.`);

    if (typeof document === 'undefined') return;
    document.getElementById('large-csv-parquet-hint')?.remove();

    const notice = document.createElement('div');
    notice.id = 'large-csv-parquet-hint';
    notice.className = 'dismissible-notice large-csv-parquet-hint';
    notice.setAttribute('role', 'status');
    notice.setAttribute('aria-live', 'polite');

    const content = document.createElement('div');
    content.className = 'dismissible-notice-content';

    const title = document.createElement('div');
    title.className = 'dismissible-notice-title';
    title.textContent = i18n.t(strong ? 'largeCsvParquetHintTitleStrong' : 'largeCsvParquetHintTitle');

    const body = document.createElement('div');
    body.className = 'dismissible-notice-body';
    body.textContent = i18n.t(strong ? 'largeCsvParquetHintBodyStrong' : 'largeCsvParquetHintBody')
        .replace('{file}', filename)
        .replace('{size}', `${mb} MB`);

    const code = document.createElement('code');
    code.className = 'dismissible-notice-code';
    code.textContent = command;

    content.append(title, body, code);

    if (canConvertInApp) {
        const actions = document.createElement('div');
        actions.className = 'dismissible-notice-actions';

        const convert = document.createElement('button');
        convert.type = 'button';
        convert.className = 'dismissible-notice-action primary';
        convert.textContent = i18n.t('convertToParquetAndLoad');

        const status = document.createElement('div');
        status.className = 'dismissible-notice-status';
        status.hidden = true;

        convert.addEventListener('click', () => {
            this._convertLargeCsvNoticeToParquet({
                filename,
                file,
                csvProfile,
                button: convert,
                status,
                notice,
            }).catch(err => {
                status.hidden = false;
                status.classList.add('error');
                status.textContent = err?.message || i18n.t('parquetConversionFailed');
                convert.disabled = false;
                convert.textContent = i18n.t('retry');
            });
        });

        actions.append(convert);
        content.append(actions, status);
    }

    const close = document.createElement('button');
    close.className = 'dismissible-notice-close';
    close.type = 'button';
    close.title = i18n.t('dismiss');
    close.setAttribute('aria-label', i18n.t('dismiss'));
    close.textContent = '×';
    close.addEventListener('click', () => notice.remove());

    notice.append(content, close);
    document.body.appendChild(notice);
    requestAnimationFrame(() => notice.classList.add('show'));
};

proto._convertLargeCsvNoticeToParquet = async function({ filename, file, csvProfile, button, status, notice }) {
    if (!file?.localPath) throw new Error(i18n.t('parquetConversionDesktopOnly'));
    const converter = globalThis.omvDesktop?.convertToParquet;
    if (typeof converter !== 'function') throw new Error(i18n.t('parquetConversionUnavailable'));

    // Show the parsing before committing to it. This was the one route that
    // converted blind: the blocking dialog leads with "Review structure", but
    // this button — the easiest one to click — went straight to the converter
    // with whatever the auto-detection had guessed. A conversion of a
    // misparsed file is worse than no conversion, because the result looks
    // authoritative and the mistake is baked in.
    const reviewed = await this._openCsvParsingPreviewForFileObject(file, {
        csvProfile,
        title: filename || file.name || '',
    });
    if (!reviewed) return;   // backed out of the preview
    csvProfile = reviewed;

    button.disabled = true;
    button.textContent = i18n.t('convertingToParquet');
    status.hidden = false;
    status.classList.remove('error', 'success');
    const started = Date.now();
    const tick = () => {
        const seconds = Math.max(1, Math.round((Date.now() - started) / 1000));
        status.textContent = i18n.t('parquetConversionInProgress').replace('{seconds}', String(seconds));
    };
    tick();
    const timer = setInterval(tick, 1000);
    try {
        const result = await converter({
            path: file.localPath,
            csvProfile: cloneCsvProfileForIpc(csvProfile),
            compression: 'zstd',
        });
        if (result?.ok === false) throw new Error(result.message || i18n.t('parquetConversionFailed'));
        if (!result?.outputPath) throw new Error(i18n.t('parquetConversionFailed'));

        status.classList.add('success');
        status.textContent = result.cached
            ? i18n.t('parquetConversionUsingExisting')
            : i18n.t('parquetConversionComplete');
        const parquetFile = await this._readLocalResultPath(result.outputPath);
        await this.loadFile(parquetFile, { localPath: result.outputPath });
        notice?.remove();
    } finally {
        clearInterval(timer);
    }
};

proto._parseParquetResult = async function(filename, file) {
    if (!file) throw new Error(`Parquet files must be loaded via a File handle (got buffer-only for ${filename}).`);
    if (!this._canUseDuckDb()) throw new Error(`Parquet support requires DuckDB-WASM (current page does not allow Workers).`);
    const source = await this._getDuckDbSource();
    const lazy = (file.size ?? 0) >= this._parquetFullLoadLimitBytes();
    const data = await source.parseParquetFile(file, filename, { lazy });
    data.filename = filename;
    return data;
};

proto._parseCsvResultBuffer = async function(filename, buffer, file = null, options = {}) {
    const fileSize = file?.size ?? (buffer?.byteLength || 0);
    const legacyFallbackUnsafe = fileSize >= LEGACY_CSV_FALLBACK_MAX_BYTES;
    let csvProfile = options.csvProfile ? cloneCsvProfileForIpc(options.csvProfile) : null;
    const attachCsvProfile = data => {
        if (data?.metadata && csvProfile) data.metadata.csvProfile = csvProfile;
        return data;
    };

    if (!csvProfile) {
        try {
            if (file || buffer) csvProfile = await this._inspectCsvSample(file, buffer);
        } catch (err) {
            console.warn('[csv] could not inspect sample for live-update profile:', err?.message || err);
        }
    }

    // Hint the user toward Parquet for very large CSVs. Non-blocking — the
    // parse still proceeds.
    if (file && fileSize >= this._csvCompactHintBytes()) {
        this._showLargeCsvParquetHint(filename, fileSize, file, csvProfile);
    }
    // Try DuckDB-WASM first when available — it bypasses the ~512 MB string
    // ceiling of the legacy parser and returns typed-array columns.
    const duckDbCsvCompatible = !csvProfile?.encoding || csvProfile.encoding === 'utf-8';
    if (file && this._canUseDuckDb() && duckDbCsvCompatible) {
        try {
            const source = await this._getDuckDbSource();
            const lazy = (file.size ?? 0) >= this._csvFullLoadLimitBytes();
            const data = await source.parseCsvFile(file, filename, { lazy, csvProfile });
            data.filename = filename;
            return attachCsvProfile(data);
        } catch (err) {
            if (legacyFallbackUnsafe) {
                throw this._largeCsvDuckDbError(filename, fileSize, err);
            }
            console.warn('[duckdb] falling back to legacy CSV parser:', err?.message || err);
            // fall through to legacy path
        }
    } else if (file && this._canUseDuckDb() && !duckDbCsvCompatible) {
        console.warn(`[duckdb] skipping CSV path for ${filename}: ${csvProfile.encoding} text is handled by the legacy parser.`);
    }
    if (legacyFallbackUnsafe) {
        throw this._largeCsvDuckDbError(filename, fileSize, null);
    }
    if (!buffer && file) {
        buffer = await (file.arrayBuffer ? file.arrayBuffer() : this._readAsArrayBuffer(file));
        if (!csvProfile) {
            try { csvProfile = await this._inspectCsvSample(file, buffer); } catch (_) {}
        }
    }
    if (!this._canUseParserWorker()) {
        return attachCsvProfile(csvProfile?.profileSource === 'user'
            ? await this.csvParser.parseWithProfile(buffer, csvProfile)
            : await this.csvParser.parse(buffer));
    }
    try {
        return attachCsvProfile(await this._parseCsvInWorker(filename, buffer, csvProfile?.profileSource === 'user' ? csvProfile : null));
    } catch (err) {
        if (err?.workerUnavailable) {
            return attachCsvProfile(csvProfile?.profileSource === 'user'
                ? await this.csvParser.parseWithProfile(buffer, csvProfile)
                : await this.csvParser.parse(buffer));
        }
        throw err;
    }
};

proto._largeCsvDuckDbError = function(filename, size, cause = null) {
    const mb = Number.isFinite(size) ? (size / (1024 * 1024)).toFixed(0) : '?';
    const detail = cause?.message ? ` DuckDB reported: ${cause.message}` : '';
    return new Error(
        `Large CSV "${filename}" (${mb} MB) cannot be opened with the legacy parser without risking browser out-of-memory.${detail}`
        + ` Convert it once with: node bench/csv-to-parquet.mjs "${filename}", then load the .parquet file.`
    );
};

proto._canUseParserWorker = function() {
    return typeof window !== 'undefined'
        && typeof Worker !== 'undefined'
        && window.location?.protocol !== 'file:';
};

proto._canUseDuckDb = function() {
    if (globalThis.__OMV_PORTABLE__ === true) return false;
    if (this._duckdbDisabled) return false;
    if (typeof window === 'undefined') return false;
    if (typeof Worker === 'undefined') return false;
    if (typeof WebAssembly === 'undefined') return false;
    // Workers under file:// fail on most browsers; reuse the same guard.
    if (window.location?.protocol === 'file:') return false;
    try {
        if (window.localStorage?.getItem('omv_disable_duckdb') === '1') return false;
    } catch (_) { /* ignore */ }
    return true;
};

proto._getDuckDbSource = async function() {
    if (!this._duckdbSource) {
        const DuckDbSource = await loadDuckDbSourceClass();
        if (!DuckDbSource) throw new Error('DuckDB source unavailable in this build.');
        this._duckdbSource = new DuckDbSource(this.parser);
    }
    return this._duckdbSource;
};

// CSV now goes through the same pool as every other format. The bespoke
// worker lifecycle this replaced (spawn, pending map, error teardown, manual
// fallback detection) lives in src/core/worker-pool.js.
proto._parseCsvInWorker = function(filename, buffer, csvProfile = null) {
    const workerBuffer = detachedCopy(buffer);
    return parseOffThread(
        'parse:csv',
        { filename, buffer: workerBuffer, csvProfile: cloneCsvProfileForIpc(csvProfile) },
        [workerBuffer],
        () => {
            const unavailable = new Error('Parser worker unavailable');
            unavailable.workerUnavailable = true;
            throw unavailable;
        },
    );
};

proto._looksLikeTextBuffer = function(buffer) {
    if (typeof buffer === 'string') return true;
    const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
    if (!bytes.length) return true;

    const sampleLength = Math.min(bytes.length, 8192);
    let suspiciousControls = 0;
    for (let i = 0; i < sampleLength; i++) {
        const b = bytes[i];
        if (b === 0) return false;
        const isCommonWhitespace = b === 9 || b === 10 || b === 12 || b === 13;
        if (b < 32 && !isCommonWhitespace) suspiciousControls++;
    }

    if (suspiciousControls / sampleLength > 0.01) return false;

    if (typeof TextDecoder !== 'undefined') {
        try {
            new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, sampleLength));
            return true;
        } catch (_) {
            return suspiciousControls === 0;
        }
    }

    return true;
};

proto._looksLikePickleBuffer = function(buffer) {
    const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
    return bytes.length >= 2 && bytes[0] === 0x80 && bytes[1] >= 2 && bytes[1] <= 5;
};

proto._nextVersionName = function(name) {
    const base = String(name || 'results').replace(/\s+#\d+$/, '');
    let maxVersion = 1;
    for (const { name: existingName } of this.files.values()) {
        if (existingName === base) {
            maxVersion = Math.max(maxVersion, 1);
            continue;
        }
        const match = String(existingName).match(new RegExp(`^${this._escapeRegExp(base)}\\s+#(\\d+)$`));
        if (match) maxVersion = Math.max(maxVersion, Number(match[1]));
    }
    return `${base} #${maxVersion + 1}`;
};

proto._escapeRegExp = function(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

proto._hashBuffer = async function(buffer) {
    if (typeof crypto !== 'undefined' && crypto.subtle?.digest) {
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    }

    const bytes = new Uint8Array(buffer);
    let hash = 2166136261;
    for (let i = 0; i < bytes.length; i++) {
        hash ^= bytes[i];
        hash = Math.imul(hash, 16777619) >>> 0;
    }
    return `fnv1a32:${bytes.length}:${hash.toString(16).padStart(8, '0')}`;
};

proto._copyDerivedDefinitions = function(sourceId, targetId) {
    const sourceDerived = this.derivedByFile.get(sourceId);
    if (!sourceDerived?.size) return;

    const targetDerived = new Map();
    for (const [name, entry] of sourceDerived) {
        targetDerived.set(name, { name, formula: entry.formula, variable: null });
    }
    this.derivedByFile.set(targetId, targetDerived);
};

proto.removeFile = async function(fileId) {
    if (!this.files.has(fileId)) return;
    const fileEntry = this.files.get(fileId);

    if (this.plotManager.hasTracesForFile(fileId)) {
        const ok = await Modal.confirm(i18n.t('closeFileWarning'), { icon: '⚠️' });
        if (!ok) return;
    }

    // Drop the DuckDB temp table + file handle for this file's lazy data,
    // if any. Safe no-op on eager / non-DuckDB data.
    const pmEntry = this.plotManager.files.get(fileId);
    const lazyData = pmEntry?.data;
    if (lazyData?._duckdb?.source) {
        try { await lazyData._duckdb.source.release(lazyData); } catch (_) { /* ignore */ }
    }
    if (fileEntry?.temporaryParquetPath && typeof globalThis.omvDesktop?.deleteTemporaryParquet === 'function') {
        try {
            const result = await globalThis.omvDesktop.deleteTemporaryParquet({ path: fileEntry.temporaryParquetPath });
            if (result?.ok === false) console.warn('[parquet] could not delete temporary file:', result.message || result);
        } catch (err) {
            console.warn('[parquet] could not delete temporary file:', err?.message || err);
        }
    }

    this.plotManager.removeFile(fileId);
    this.files.delete(fileId);
    this.derivedByFile.delete(fileId);
    this._clearDataToolDefinitions?.(fileId);
    this._expandedFileTransforms.delete(fileId);
    this._clearVariableSelection();

    // Switch sidebar to new active file (if any)
    const newActiveId = this.plotManager.activeFileId;
    if (newActiveId) {
        const d = this.plotManager.files.get(newActiveId)?.data;
        if (d?.tree) this.renderVariablesTree(d.tree);
        else this.renderVariablesTree(null);
    } else {
        this.renderVariablesTree(null);
        document.getElementById('drop-zone').classList.add('active');
    }

    this._updateTopBar();
    this._renderFilesList();
    this._updateActionButtons();
};

proto.setActiveFile = function(fileId) {
    if (!this.files.has(fileId)) return;
    this.plotManager.setActiveFile(fileId);
    this._clearVariableSelection();
    const d = this.plotManager.files.get(fileId)?.data;
    if (d) this.renderVariablesTree(d.tree);
    this._updateActionButtons();
    this._updateTopBar();
    this._renderFilesList();
};

proto._updateTopBar = function() {
    // The active file is shown in the sidebar, so the top bar no longer mirrors it.
};

proto._updateActionButtons = function() {
    const hasFiles = this.files.size > 0;
    document.getElementById('reload-file').disabled  = !hasFiles;
    document.getElementById('auto-zoom').disabled    = !hasFiles;
    document.getElementById('clear-plots').disabled  = !hasFiles;
    this._updateLiveUpdateTopBar?.();
    const reloadModeToggle = document.getElementById('reload-as-version-toggle');
    const reloadModeSwitch = document.getElementById('reload-as-version-switch');
    if (reloadModeToggle) reloadModeToggle.disabled = !hasFiles;
    if (reloadModeSwitch) reloadModeSwitch.classList.toggle('disabled', !hasFiles);
};

proto._renderFilesList = function() {
    const list = document.getElementById('files-list');
    const count = document.getElementById('files-count');
    if (count) count.textContent = `(${this.files.size})`;
    list.innerHTML = '';
    for (const [fileId, entryData] of this.files) {
        const item = document.createElement('div');
        item.className = 'file-list-item';

        const entry = document.createElement('div');
        entry.className = 'file-entry' +
            (fileId === this.activeFileId ? ' active' : '') +
            (this._isFileTransformActive(entryData.transform) ? ' transformed' : '');
        entry.dataset.fileId = fileId;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'file-entry-name';
        nameSpan.textContent = this._fileDisplayName(entryData);
        nameSpan.title = this._fileDisplayName(entryData);
        nameSpan.addEventListener('click', () => this.setActiveFile(fileId));

        const typeLabel = this._fileTypeLabel(entryData, fileId);
        const typeBadge = document.createElement('span');
        typeBadge.className = 'file-entry-type';
        typeBadge.textContent = typeLabel;
        typeBadge.title = this._fileTypeTooltip(entryData, fileId, typeLabel);
        typeBadge.classList.toggle('file-entry-type-warning', this._fileTypeHasWarnings(entryData, fileId));
        typeBadge.hidden = !typeLabel;
        typeBadge.addEventListener('click', () => this.setActiveFile(fileId));

        const lazyIndicator = document.createElement('span');
        lazyIndicator.className = 'file-entry-lazy-indicator';
        lazyIndicator.textContent = '☘️';
        lazyIndicator.title = i18n.t('lazyFileIndicatorTooltip');
        lazyIndicator.setAttribute('role', 'img');
        lazyIndicator.setAttribute('aria-label', i18n.t('lazyFileIndicatorTooltip'));
        lazyIndicator.hidden = !this.plotManager.files.get(fileId)?.data?._duckdb;

        const transformBtn = document.createElement('button');
        transformBtn.className = 'file-entry-transform';
        transformBtn.textContent = '⛭';
        transformBtn.title = i18n.t('fileTransformTitle');
        transformBtn.setAttribute('aria-label', i18n.t('fileTransformTitle'));
        transformBtn.setAttribute('aria-expanded', String(this._expandedFileTransforms.has(fileId)));
        transformBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleFileTransformPanel(fileId);
        });

        const csvParsingBtn = document.createElement('button');
        csvParsingBtn.className = 'file-entry-csv-parsing';
        csvParsingBtn.textContent = '▦';
        csvParsingBtn.title = i18n.t('csvPreviewAction');
        csvParsingBtn.setAttribute('aria-label', i18n.t('csvPreviewAction'));
        csvParsingBtn.hidden = !this._isCsvTextEntry(entryData, fileId);
        csvParsingBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.adjustCsvParsing(fileId);
        });

        const matArraysBtn = document.createElement('button');
        matArraysBtn.type = 'button';
        matArraysBtn.className = 'file-entry-mat-arrays';
        matArraysBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3.5" y="4" width="12" height="12" rx="1.5"/><path d="M7.5 4v12M11.5 4v12M3.5 8h12M3.5 12h12M19 13v8M15 17h8"/></svg>';
        matArraysBtn.title = i18n.t('matSelectArraysAction');
        matArraysBtn.setAttribute('aria-label', i18n.t('matSelectArraysAction'));
        matArraysBtn.hidden = this.plotManager.files.get(fileId)?.data?.metadata?.source !== 'matlab'
            || !Array.isArray(this.plotManager.files.get(fileId)?.data?.metadata?.matlab?.selectedIds);
        matArraysBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.adjustMatlabArrays(fileId);
        });

        const liveIndicator = document.createElement('span');
        liveIndicator.className = 'file-entry-live-indicator';
        liveIndicator.title = 'This file is being polled in real time';
        liveIndicator.setAttribute('role', 'img');
        liveIndicator.setAttribute('aria-label', 'This file is being polled in real time');
        liveIndicator.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M17.65 6.35A7.95 7.95 0 0 0 12 4a8 8 0 1 0 7.75 10h-2.1A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h8V3l-3.35 3.35Z"/></svg>';

        const closeBtn = document.createElement('button');
        closeBtn.className = 'file-entry-close';
        closeBtn.textContent = 'x';
        closeBtn.title = i18n.t('closeFile');
        closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.removeFile(fileId); });

        entry.appendChild(nameSpan);
        entry.appendChild(typeBadge);
        entry.appendChild(lazyIndicator);
        if (entryData.liveUpdate?.enabled) entry.appendChild(liveIndicator);
        entry.appendChild(csvParsingBtn);
        entry.appendChild(matArraysBtn);
        entry.appendChild(transformBtn);
        entry.appendChild(closeBtn);
        item.appendChild(entry);
        if (this._expandedFileTransforms.has(fileId)) {
            item.appendChild(this._renderFileTransformPanel(fileId, entryData));
        }
        list.appendChild(item);
    }
};

proto._fileTypeLabel = function(_entry, fileId = null) {
    const metadata = fileId ? this.plotManager.files.get(fileId)?.data?.metadata : null;
    if (metadata?.format === 'pypsa-netcdf' || metadata?.source === 'pypsa') {
        return i18n.t('fileTypePypsaNetcdf');
    }
    if (metadata?.format === 'generic-netcdf' || metadata?.source === 'netcdf') {
        return i18n.t('fileTypeGenericNetcdf');
    }
    if (metadata?.format === 'pandas-pickle' || metadata?.source === 'pandas') {
        return i18n.t('fileTypePandasPickle');
    }
    if (metadata?.source === 'matlab') {
        return i18n.t('fileTypeMatlab').replace('{version}', metadata.matVersion || '?');
    }
    return '';
};

proto._fileTypeHasWarnings = function(_entry, fileId = null) {
    const metadata = fileId ? this.plotManager.files.get(fileId)?.data?.metadata : null;
    return Number(metadata?.skippedDynamicCount || metadata?.skippedDynamic?.length || 0) > 0
        || Number(metadata?.skippedVariablesCount || metadata?.skippedVariables?.length || 0) > 0
        || Number(metadata?.skippedColumnsCount || metadata?.skippedColumns?.length || 0) > 0
        || Number(metadata?.precisionLossCount || metadata?.precisionWarnings?.length || 0) > 0
        || Number(metadata?.duplicateColumnCount || metadata?.duplicateColumns?.length || 0) > 0;
};

proto._fileTypeTooltip = function(_entry, fileId = null, fallback = '') {
    const metadata = fileId ? this.plotManager.files.get(fileId)?.data?.metadata : null;
    const skipped = Number(metadata?.skippedDynamicCount || metadata?.skippedDynamic?.length || 0);
    if ((metadata?.format === 'pypsa-netcdf' || metadata?.source === 'pypsa') && skipped > 0) {
        return `${fallback}\n${i18n.t('fileTypePypsaSkippedDynamic').replace('{count}', String(skipped))}`;
    }
    const skippedNetcdf = Number(metadata?.skippedVariablesCount || metadata?.skippedVariables?.length || 0);
    if ((metadata?.format === 'generic-netcdf' || metadata?.source === 'netcdf') && skippedNetcdf > 0) {
        return `${fallback}\n${i18n.t('fileTypeNetcdfSkippedVariables').replace('{count}', String(skippedNetcdf))}`;
    }
    if (metadata?.format === 'pandas-pickle' || metadata?.source === 'pandas') {
        const lines = [fallback].filter(Boolean);
        const skippedColumns = Number(metadata?.skippedColumnsCount || metadata?.skippedColumns?.length || 0);
        const precision = Number(metadata?.precisionLossCount || metadata?.precisionWarnings?.length || 0);
        const duplicates = Number(metadata?.duplicateColumnCount || metadata?.duplicateColumns?.length || 0);
        if (skippedColumns > 0) lines.push(i18n.t('picklesSkippedColumns').replace('{count}', String(skippedColumns)));
        if (precision > 0) lines.push(i18n.t('picklePrecisionWarnings').replace('{count}', String(precision)));
        if (duplicates > 0) lines.push(i18n.t('pickleDuplicateColumns').replace('{count}', String(duplicates)));
        return lines.join('\n');
    }
    return fallback;
};

proto._defaultFileTransform = function() {
    return { timeDisplayMode: null, calendarTimeFormat: null, timeShift: 0, timeStepMode: null, customTimeStep: '', timeStepOriginMode: null, timeStepOriginDate: '', numericTimeDisplay: null, gain: 1, yOffset: 0, cropStart: null, cropEnd: null };
};

proto._openCsvParsingPreviewForFileObject = async function(file, options = {}) {
    const sampleSegments = options.sampleBuffer
        ? [{ id: 'start', buffer: options.sampleBuffer, offset: 0, bytes: options.sampleBuffer.byteLength || 0, totalSize: options.sampleBuffer.byteLength || 0 }]
        : await this._readCsvPreviewSegments(file, { bytes: CSV_PREVIEW_SEGMENT_BYTES });
    const sampleBuffer = sampleSegments[0]?.buffer;
    if (!sampleBuffer) throw new Error('No CSV sample available.');
    return CsvParsingPreviewDialog.open({
        parser: this.csvParser,
        sampleBuffer,
        sampleSegments,
        loadPreviewSegment: file
            ? (region, bytes) => this._readCsvPreviewSegment(file, region, bytes)
            : null,
        csvProfile: options.csvProfile || null,
        title: options.title || file?.name || '',
    });
};

proto._isCsvTextEntry = function(entry, fileId = null) {
    const extension = entry?.extension || this._fileExtension(entry?.file?.name || '');
    return extension === '.csv'
        || extension === '.txt'
        || (fileId && this.plotManager.files.get(fileId)?.data?.metadata?.csv === true);
};

proto.adjustCsvParsing = async function(fileId) {
    const entry = this.files.get(fileId);
    if (!entry || !this._isCsvTextEntry(entry, fileId)) return;
    const displayName = this._fileDisplayName(entry);
    const plotEntry = this.plotManager.files.get(fileId);
    const currentProfile = plotEntry?.data?.metadata?.csvProfile || null;
    const isExcel = this._isExcelExtension(entry.extension);

    try {
        let previewFile = entry.file;
        let previewSampleBuffer = entry.file ? null : entry.buffer;
        if (isExcel) {
            // The dialog must see the converted CSV view, never workbook bytes.
            // Normally cached from the initial load; a miss means seconds of
            // synchronous workbook decoding, so give feedback first.
            const cached = this._hasExcelCsvCache(entry);
            if (!cached) {
                this._showFileLoadingOverlay(1);
                this._updateFileLoadingOverlay(1, 1, displayName, entry.file?.size);
                await this._waitForNextPaint();
            }
            let csvBuffer;
            try {
                ({ csvBuffer } = await this._convertExcelEntryToCsvBuffer(entry));
            } finally {
                if (!cached) this._hideFileLoadingOverlay();
            }
            previewFile = new File([csvBuffer], displayName.replace(/\.[^.]+$/, '.csv'));
            previewSampleBuffer = null;
        }
        const reviewedProfile = await this._openCsvParsingPreviewForFileObject(previewFile, {
            csvProfile: currentProfile,
            sampleBuffer: previewSampleBuffer,
            title: displayName,
        });
        if (!reviewedProfile) return;

        this._showFileLoadingOverlay(1);
        this._updateFileLoadingOverlay(1, 1, displayName, entry.file?.size);
        let data;
        if (isExcel) {
            // Reuses the cached CSV: re-reading the workbook from disk here
            // would block the UI for seconds again (the Reload button covers
            // picking up external file changes).
            const { csvBuffer, sheetName, sheetNames } = await this._convertExcelEntryToCsvBuffer(entry);
            data = await this._parseCsvResultBuffer(displayName, csvBuffer, null, { csvProfile: reviewedProfile });
            data.metadata.excel = { sheetName, sheetNames: sheetNames || entry.excel?.sheetNames || null };
            entry.excel = { ...data.metadata.excel };
            this._reapplyDerivedVariables(fileId, data);
            this._reapplyDataToolVariables?.(fileId, data);
            this.plotManager.updateFileData(fileId, data);
            this.plotManager.setActiveFile(fileId);
            this._clearVariableSelection();
            this.renderVariablesTree(data.tree);
            this._renderFilesList();
            this._updateActionButtons();
            await this._showDatetimeAxisWarningIfNeeded(fileId, data);
            return;
        }
        const streamable = this._canParseFromFile(entry.file, entry.extension);
        const latestFile = streamable ? await this._readLatestFileForStreamableReload(entry) : null;
        const buffer = streamable ? null : await this._readLatestBuffer(entry);
        const contentHash = buffer
            ? await this._hashBuffer(buffer)
            : this._fileFingerprint(latestFile || entry.file);
        data = await this._parseCsvResultBuffer(displayName, buffer, latestFile || entry.file, { csvProfile: reviewedProfile });
        this._reapplyDerivedVariables(fileId, data);
        this._reapplyDataToolVariables?.(fileId, data);
        if (latestFile) entry.file = latestFile;
        entry.buffer = buffer;
        entry.contentHash = contentHash;
        this.plotManager.updateFileData(fileId, data);
        this.plotManager.setActiveFile(fileId);
        this._clearVariableSelection();
        this.renderVariablesTree(data.tree);
        this._renderFilesList();
        this._updateActionButtons();
        await this._showDatetimeAxisWarningIfNeeded(fileId, data);
    } catch (err) {
        console.error('Error adjusting CSV parsing:', err);
        await Modal.alert(i18n.t('csvPreviewTitle'), err?.message || String(err), { icon: 'CSV' });
    } finally {
        this._hideFileLoadingOverlay();
    }
};

proto._normalizeFileTransform = function(transform = null) {
    const t = transform || {};
    const finiteOrZero = (value) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    };
    const valueOrNull = (value) => {
        if (value === '' || value === null || value === undefined) return null;
        return value;
    };
    const mode = (() => {
        if (t.timeDisplayMode === 'calendar') return 'calendar';
        if (t.timeDisplayMode === 'elapsedDateTime' || t.timeDisplayMode === 'elapsedDatetime') return 'elapsedDateTime';
        if (t.timeDisplayMode === 'elapsedSeconds' || t.timeDisplayMode === 'elapsed') return 'elapsedSeconds';
        if (t.timeDisplayMode === 'index') return 'index';
        return null;
    })();
    return {
        timeDisplayMode: mode,
        calendarTimeFormat: t.calendarTimeFormat === 'ampm'
            ? 'ampm'
            : (t.calendarTimeFormat === '24h' ? '24h' : null),
        timeShift: t.timeShift === '' || t.timeShift === null || t.timeShift === undefined ? 0 : t.timeShift,
        timeStepMode: ['index', 'seconds', '1minute', '10minutes', '15minutes', '30minutes', '1hour', '1day', 'custom'].includes(t.timeStepMode) ? t.timeStepMode : null,
        customTimeStep: t.customTimeStep === null || t.customTimeStep === undefined ? '' : String(t.customTimeStep),
        timeStepOriginMode: ['elapsed', 'elapsed-seconds', 'calendar'].includes(t.timeStepOriginMode) ? t.timeStepOriginMode : null,
        timeStepOriginDate: t.timeStepOriginDate === null || t.timeStepOriginDate === undefined ? '' : String(t.timeStepOriginDate),
        numericTimeDisplay: ['seconds', 'duration', 'calendar'].includes(t.numericTimeDisplay) ? t.numericTimeDisplay : null,
        gain: (() => {
            const n = Number(t.gain);
            return Number.isFinite(n) ? n : 1;
        })(),
        yOffset: finiteOrZero(t.yOffset),
        cropStart: valueOrNull(t.cropStart),
        cropEnd: valueOrNull(t.cropEnd),
    };
};

proto._isFileTransformActive = function(transform) {
    const t = this._normalizeFileTransform(transform);
    return t.timeDisplayMode !== null || t.calendarTimeFormat !== null || t.timeShift !== 0 || t.timeStepMode !== null || t.customTimeStep !== '' || t.timeStepOriginMode !== null || (t.timeStepOriginMode === 'calendar' && t.timeStepOriginDate !== '') || t.numericTimeDisplay !== null || t.gain !== 1 || t.yOffset !== 0 || t.cropStart !== null || t.cropEnd !== null;
};

proto._toggleFileTransformPanel = function(fileId) {
    if (this._expandedFileTransforms.has(fileId)) this._expandedFileTransforms.delete(fileId);
    else this._expandedFileTransforms.add(fileId);
    this._renderFilesList();
};

proto._renderFileTransformPanel = function(fileId, entryData) {
    // Drop any floating help popup left over from a previous render.
    document.querySelectorAll('.file-transform-help-popover').forEach(el => el.remove());
    const transform = this._normalizeFileTransform(entryData.transform);
    const timeVar = this.plotManager?._getTimeVar?.(fileId);
    const isDateTime = timeVar?.timeKind === 'datetime';
    const isIndexTime = timeVar?.timeKind === 'index';
    const isNumericTime = !isDateTime && !isIndexTime;
    const timeDisplayMode = isDateTime
        ? (transform.timeDisplayMode || timeVar.timeDisplayMode || 'calendar')
        : (isNumericTime && transform.timeDisplayMode === 'index' ? 'index' : 'numeric');
    const isIndexAxis = isIndexTime || timeDisplayMode === 'index';
    const indexStepMode = isIndexAxis ? (transform.timeStepMode || timeVar.timeStepMode || 'index') : null;
    let isGeneratedCalendarAxis = isIndexAxis
        && indexStepMode !== 'index'
        && transform.timeStepOriginMode === 'calendar';
    const calendarTimeFormat = transform.calendarTimeFormat || timeVar?.calendarTimeFormat || '24h';
    const panel = document.createElement('div');
    panel.className = 'file-transform-panel'
        + (fileId === this.activeFileId ? ' file-transform-panel-active' : '');
    panel.addEventListener('click', e => e.stopPropagation());

    // Yellow "?" help button that opens a FLOATING popup (not an in-flow box):
    // the popover is fixed-positioned and lives on <body> only while open, so it
    // overlays the UI near the button instead of pushing the menu around.
    // Shared factory for the small round popover buttons — the yellow "?" help and
    // the amber "⚠" warning both use it. The button toggles a FLOATING popover
    // (fixed-positioned, appended to <body> only while open, so it overlays the UI
    // near the button instead of pushing the menu around).
    const makeTransformPopover = ({ glyph, btnClass, title, bodyHtml }) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = btnClass;
        btn.textContent = glyph;
        btn.title = title;
        btn.setAttribute('aria-label', title);
        btn.setAttribute('aria-expanded', 'false');

        const popover = document.createElement('div');
        popover.className = 'fft-help-popover file-transform-help-popover';
        popover.hidden = true;
        popover.innerHTML = `<div class="file-transform-help-title">${title}</div>${bodyHtml}`;

        const positionPopover = () => {
            const rect = btn.getBoundingClientRect();
            const margin = 8;
            const w = popover.offsetWidth;
            const h = popover.offsetHeight;
            let left = Math.min(rect.left, window.innerWidth - w - margin);
            left = Math.max(margin, left);
            let top = rect.bottom + 6;
            if (top + h > window.innerHeight - margin) top = Math.max(margin, rect.top - h - 6);
            popover.style.left = `${left}px`;
            popover.style.top = `${top}px`;
        };
        const onDocMouseDown = (event) => {
            if (!popover.contains(event.target) && event.target !== btn) close();
        };
        function close() {
            popover.hidden = true;
            popover.remove();
            btn.setAttribute('aria-expanded', 'false');
            document.removeEventListener('mousedown', onDocMouseDown, true);
            window.removeEventListener('resize', close);
            window.removeEventListener('scroll', close, true);
        }
        // Stop the wrapping <label> from redirecting the click to the input.
        btn.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation(); });
        btn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!popover.hidden) { close(); return; }
            document.body.appendChild(popover);
            popover.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
            positionPopover();
            setTimeout(() => {
                document.addEventListener('mousedown', onDocMouseDown, true);
                window.addEventListener('resize', close);
                window.addEventListener('scroll', close, true);
            }, 0);
        });
        return { btn, popover };
    };
    const makeTransformHelp = (titleKey, bodyKey) => {
        const { btn, popover } = makeTransformPopover({
            glyph: '?',
            btnClass: 'fft-help-btn file-transform-help-btn',
            title: i18n.t(titleKey),
            bodyHtml: i18n.t(bodyKey),
        });
        return { helpBtn: btn, helpPopover: popover };
    };
    // Amber "⚠" next to "Create a row index vector": a static, general caption
    // (no per-file gap detection) spelling out the two assumptions of reindexing.
    const makeReindexWarning = () => makeTransformPopover({
        glyph: '⚠',
        btnClass: 'fft-help-btn file-transform-warning-btn',
        title: i18n.t('reindexWarnTitle'),
        bodyHtml: '<ul>'
            + `<li>${i18n.t('reindexWarnEquidistant')}</li>`
            + `<li>${i18n.t('reindexWarnGaps')}</li>`
            + '</ul>',
    }).btn;

    const makeInput = (key, label, value, placeholder = '0', options = {}) => {
        const wrap = document.createElement('label');
        wrap.className = 'file-transform-field';
        if (options.className) wrap.classList.add(options.className);
        if (options.title) wrap.title = options.title;

        const span = document.createElement('span');
        if (options.help) {
            span.className = 'file-transform-label-with-help';
            const labelText = document.createElement('span');
            labelText.textContent = label;
            if (options.title) labelText.title = options.title;
            const help = makeTransformHelp(options.help.titleKey, options.help.bodyKey);
            span.append(labelText, help.helpBtn);
        } else {
            span.textContent = label;
            if (options.title) span.title = options.title;
        }

        const input = document.createElement('input');
        input.type = options.type || 'number';
        if (options.step) input.step = options.step;
        if (options.lang) input.lang = options.lang;
        if (input.type === 'number') {
            input.step = options.step || 'any';
            input.inputMode = 'decimal';
        }
        input.placeholder = options.placeholder || placeholder;
        if (options.title) input.title = options.title;
        input.value = options.format ? options.format(value) : (value === null || value === undefined ? '' : String(value));
        const commitValue = () => {
            if (options.onCommit) options.onCommit(input.value, input);
            else this._updateFileTransform(fileId, { [key]: input.value });
        };
        let skipNextBlurCommit = false;
        if (options.updateOnChange !== false) input.addEventListener('change', commitValue);
        if (options.commitOnBlur) {
            input.addEventListener('blur', () => {
                if (skipNextBlurCommit) {
                    skipNextBlurCommit = false;
                    return;
                }
                commitValue();
            });
        }
        if (options.onInput) input.addEventListener('input', () => options.onInput(input));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (options.updateOnChange === false) {
                    commitValue();
                    if (options.commitOnBlur) {
                        skipNextBlurCommit = true;
                        input.blur();
                    }
                }
                else input.blur();
            }
        });

        wrap.append(span, input);
        wrap.input = input;
        return wrap;
    };

    const stepUnits = ['ps', 'ns', 'us', 'ms', 's', 'min', 'h', 'day', 'year'];
    const isTimeVarAxisStalled = () => {
        if (!isDateTime) return false;
        const data = timeVar?.data;
        if (!data || data.length < 3) return false;
        let previous = NaN;
        let runLength = 0;
        const limit = Math.min(data.length, 1000);
        for (let i = 0; i < limit; i++) {
            const value = Number(data[i]);
            if (!Number.isFinite(value)) {
                previous = NaN;
                runLength = 0;
                continue;
            }
            runLength = value === previous ? runLength + 1 : 1;
            previous = value;
            if (runLength >= 3) return true;
        }
        return false;
    };
    const metadata = entryData.data?.metadata || {};
    const metadataStart = Number(metadata.timeStart);
    const metadataEnd = Number(metadata.timeEnd);
    const metadataStalled = metadata.timeKind === 'datetime'
        && Number(metadata.numTimesteps) >= 3
        && Number.isFinite(metadataStart)
        && metadataStart === metadataEnd;
    const datetimeAxisStalled = Boolean(metadata.datetimeAxisStalled) || metadataStalled || isTimeVarAxisStalled();

    const makeCustomStepField = () => {
        const raw = String(transform.customTimeStep || '').trim();
        const match = raw.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(ps|ns|us|ms|s|min|h|day|year)?$/i);
        const wrap = document.createElement('label');
        // Full width so it sits right under the Mode selector; the value and the
        // unit dropdown share one line (see .file-transform-step-row). No help
        // button here — the unit dropdown is self-explanatory.
        wrap.className = 'file-transform-field file-transform-field-wide';
        wrap.title = i18n.t('indexCustomStepTooltip');

        const span = document.createElement('span');
        span.textContent = i18n.t('indexCustomStepLabel');
        span.title = i18n.t('indexCustomStepTooltip');

        const input = document.createElement('input');
        input.type = 'number';
        input.step = 'any';
        input.inputMode = 'decimal';
        input.placeholder = '10';
        input.value = match ? match[1] : '';

        const select = document.createElement('select');
        const selectedUnit = match && stepUnits.includes(match[2]?.toLowerCase()) ? match[2].toLowerCase() : (match ? 'ms' : 's');
        select.innerHTML = stepUnits
            .map(unit => `<option value="${unit}"${unit === selectedUnit ? ' selected' : ''}>${unit}</option>`)
            .join('');

        const commit = () => {
            const value = String(input.value || '').trim();
            const customTimeStep = value ? `${value} ${select.value}` : '';
            this._updateFileTransform(fileId, { customTimeStep }, { autoscaleX: false });
        };
        input.addEventListener('change', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
        });
        select.addEventListener('change', commit);

        const row = document.createElement('div');
        row.className = 'file-transform-step-row';
        row.append(input, select);
        wrap.append(span, row);
        wrap.input = input;
        return wrap;
    };

    const normalizeGeneratedOriginValue = (value) => {
        const raw = String(value || '').trim();
        const text = (raw || DEFAULT_GENERATED_TIME_ORIGIN).replace(' ', 'T');
        const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (!match) return { ok: false };
        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        const hour = Number(match[4]);
        const minute = Number(match[5]);
        const second = Number(match[6] || 0);
        if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute > 59 || second > 59) {
            return { ok: false };
        }
        const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
        if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day
            || d.getUTCHours() !== hour || d.getUTCMinutes() !== minute || d.getUTCSeconds() !== second) {
            return { ok: false };
        }
        return {
            ok: true,
            year,
            value: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`,
        };
    };
    const isLeapYear = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const leapYearText = (value) => {
        const parsed = normalizeGeneratedOriginValue(value);
        if (!parsed.ok) return `${i18n.t('indexTimeLeapYearLabel')}: -`;
        return `${i18n.t('indexTimeLeapYearLabel')}: ${isLeapYear(parsed.year) ? i18n.t('indexTimeLeapYearYes') : i18n.t('indexTimeLeapYearNo')}`;
    };

    // Unified Option B time-axis UI (Source × Format), for every file format.
    if (isDateTime) {
        // ── Option B: Source (File time / Row index) × Format ──────────────────
        const timeTitle = document.createElement('div');
        timeTitle.className = 'file-transform-title';
        timeTitle.textContent = i18n.t('timeAxisTitle');
        panel.append(timeTitle);

        const isRowIndex = timeDisplayMode === 'index';

        // Source: what drives the axis — the file's real time, or a row index.
        const sourceWrap = document.createElement('div');
        sourceWrap.className = 'file-transform-field file-transform-field-wide';
        sourceWrap.style.alignItems = 'stretch';
        sourceWrap.style.gap = '4px';
        sourceWrap.style.minWidth = '0';
        const sourceLabel = document.createElement('span');
        sourceLabel.textContent = i18n.t('timeAxisSource');
        const sourceRow = document.createElement('div');
        sourceRow.style.display = 'flex';
        sourceRow.style.flexDirection = 'column';
        sourceRow.style.gap = '7px';
        sourceRow.style.alignItems = 'stretch';
        sourceRow.style.width = '100%';
        const makeSourceRadio = (value, labelText, checked) => {
            const wrap = document.createElement('label');
            wrap.style.display = 'flex';
            wrap.style.alignItems = 'center';
            wrap.style.gap = '7px';
            wrap.style.width = '100%';
            wrap.style.cursor = 'pointer';
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = `time-source-${fileId}`;
            input.value = value;
            input.checked = checked;
            // Override the panel's `.file-transform-field input { width:100% }` rule,
            // which otherwise stretches the radio into a full-width bordered box.
            input.style.width = 'auto';
            input.style.minWidth = '0';
            input.style.margin = '0';
            input.style.padding = '0';
            input.style.border = 'none';
            input.style.background = 'none';
            input.style.flexShrink = '0';
            const span = document.createElement('span');
            span.textContent = labelText;
            span.style.flex = '1';
            span.style.minWidth = '0';
            span.style.lineHeight = '1.25';
            wrap.append(input, span);
            return { wrap, input };
        };
        const fileSrc = makeSourceRadio('values', i18n.t('timeAxisSourceFile'), !isRowIndex);
        const indexSrc = makeSourceRadio('index', i18n.t('timeAxisSourceIndex'), isRowIndex);
        fileSrc.input.addEventListener('change', () => {
            if (!fileSrc.input.checked) return;
            this._updateFileTransform(fileId, {
                timeDisplayMode: 'calendar', calendarTimeFormat: '24h',
                timeStepMode: null, customTimeStep: '', timeStepOriginMode: null,
                cropStart: null, cropEnd: null, timeShift: 0,
            }, { rerender: true, autoscaleX: false });
        });
        indexSrc.input.addEventListener('change', () => {
            if (!indexSrc.input.checked) return;
            this._updateFileTransform(fileId, {
                timeDisplayMode: 'index', calendarTimeFormat: null,
                cropStart: null, cropEnd: null, timeShift: 0,
            }, { rerender: true, autoscaleX: false });
        });
        // Append the ⚠ INSIDE the label's text span (not the flex wrap) so it sits
        // right after "Create a row index vector" instead of being pushed to the
        // far right, making clear the warning belongs to that option.
        (indexSrc.wrap.querySelector('span') || indexSrc.wrap).append(makeReindexWarning());
        sourceRow.append(fileSrc.wrap, indexSrc.wrap);
        sourceWrap.append(sourceLabel, sourceRow);
        panel.append(sourceWrap);

        // Format: pure display of the real time (only when Source = File time).
        // When Source = Row index, the Step ΔT + Show-as controls below (the
        // existing isIndexAxis block) take over.
        if (!isRowIndex) {
            const fmtWrap = document.createElement('label');
            fmtWrap.className = 'file-transform-field file-transform-field-wide';
            const fmtLabel = document.createElement('span');
            fmtLabel.textContent = i18n.t('timeAxisFormat');
            const fmtSelect = document.createElement('select');
            const selectedCalendarMode = timeDisplayMode === 'calendar'
                ? (calendarTimeFormat === 'ampm' ? 'calendar-ampm' : 'calendar-24h')
                : timeDisplayMode;
            fmtSelect.innerHTML = `
                <option value="calendar-24h"${selectedCalendarMode === 'calendar-24h' ? ' selected' : ''}>${i18n.t('timeAxisFormatCalendar24h')}</option>
                <option value="calendar-ampm"${selectedCalendarMode === 'calendar-ampm' ? ' selected' : ''}>${i18n.t('timeAxisFormatCalendarAmPm')}</option>
                <option value="elapsedDateTime"${timeDisplayMode === 'elapsedDateTime' ? ' selected' : ''}>${i18n.t('timeAxisFormatDuration')}</option>
                <option value="elapsedSeconds"${timeDisplayMode === 'elapsedSeconds' ? ' selected' : ''}>${i18n.t('timeAxisFormatSecondsNumeric')}</option>
            `;
            fmtSelect.addEventListener('change', () => {
                const selected = fmtSelect.value;
                const nextIsCalendar = selected === 'calendar-24h' || selected === 'calendar-ampm';
                const patch = {
                    timeDisplayMode: nextIsCalendar ? 'calendar' : selected,
                    calendarTimeFormat: nextIsCalendar ? (selected === 'calendar-ampm' ? 'ampm' : '24h') : null,
                    timeStepMode: null, customTimeStep: '', timeStepOriginMode: null,
                };
                if (!(timeDisplayMode === 'calendar' && nextIsCalendar)) {
                    patch.cropStart = null; patch.cropEnd = null; patch.timeShift = 0;
                }
                this._updateFileTransform(fileId, patch, { rerender: true });
            });
            fmtWrap.append(fmtLabel, fmtSelect);
            panel.append(fmtWrap);
        }

        if (datetimeAxisStalled) {
            const stalledHint = document.createElement('div');
            stalledHint.className = 'file-transform-hint datetime-axis-warning-hint';
            stalledHint.textContent = i18n.t('datetimeAxisStalledHint');
            panel.appendChild(stalledHint);
        }
    } else if (isNumericTime) {
        // ── Option B for a numeric (float) time vector: Source × Format ────────
        // The file already carries its own seconds. Source = File time shows those
        // seconds either as a plain number or as a duration (hh:mm:ss); Source =
        // Row index discards them and generates a row-driven axis (shared Step +
        // Show-as controls in the isIndexAxis block below take over).
        const timeTitle = document.createElement('div');
        timeTitle.className = 'file-transform-title';
        timeTitle.textContent = i18n.t('timeAxisTitle');
        panel.append(timeTitle);

        const isRowIndex = timeDisplayMode === 'index';

        const sourceWrap = document.createElement('div');
        sourceWrap.className = 'file-transform-field file-transform-field-wide';
        sourceWrap.style.alignItems = 'stretch';
        sourceWrap.style.gap = '4px';
        sourceWrap.style.minWidth = '0';
        const sourceLabel = document.createElement('span');
        sourceLabel.textContent = i18n.t('timeAxisSource');
        const sourceRow = document.createElement('div');
        sourceRow.style.display = 'flex';
        sourceRow.style.flexDirection = 'column';
        sourceRow.style.gap = '7px';
        sourceRow.style.alignItems = 'stretch';
        sourceRow.style.width = '100%';
        const makeSourceRadio = (value, labelText, checked) => {
            const wrap = document.createElement('label');
            wrap.style.display = 'flex';
            wrap.style.alignItems = 'center';
            wrap.style.gap = '7px';
            wrap.style.width = '100%';
            wrap.style.cursor = 'pointer';
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = `time-source-${fileId}`;
            input.value = value;
            input.checked = checked;
            input.style.width = 'auto';
            input.style.minWidth = '0';
            input.style.margin = '0';
            input.style.padding = '0';
            input.style.border = 'none';
            input.style.background = 'none';
            input.style.flexShrink = '0';
            const span = document.createElement('span');
            span.textContent = labelText;
            span.style.flex = '1';
            span.style.minWidth = '0';
            span.style.lineHeight = '1.25';
            wrap.append(input, span);
            return { wrap, input };
        };
        const fileSrc = makeSourceRadio('values', i18n.t('timeAxisSourceFile'), !isRowIndex);
        const indexSrc = makeSourceRadio('index', i18n.t('timeAxisSourceIndex'), isRowIndex);
        fileSrc.input.addEventListener('change', () => {
            if (!fileSrc.input.checked) return;
            this._updateFileTransform(fileId, {
                timeDisplayMode: null,
                timeStepMode: null, customTimeStep: '', timeStepOriginMode: null,
                cropStart: null, cropEnd: null, timeShift: 0,
            }, { rerender: true, autoscaleX: false });
        });
        indexSrc.input.addEventListener('change', () => {
            if (!indexSrc.input.checked) return;
            this._updateFileTransform(fileId, {
                timeDisplayMode: 'index',
                cropStart: null, cropEnd: null, timeShift: 0,
            }, { rerender: true, autoscaleX: false });
        });
        // Append the ⚠ INSIDE the label's text span (not the flex wrap) so it sits
        // right after "Create a row index vector" instead of being pushed to the
        // far right, making clear the warning belongs to that option.
        (indexSrc.wrap.querySelector('span') || indexSrc.wrap).append(makeReindexWarning());
        sourceRow.append(fileSrc.wrap, indexSrc.wrap);
        sourceWrap.append(sourceLabel, sourceRow);
        panel.append(sourceWrap);

        // Format: value-preserving display of the file's own seconds.
        if (!isRowIndex) {
            const fmtWrap = document.createElement('label');
            fmtWrap.className = 'file-transform-field file-transform-field-wide';
            const fmtLabel = document.createElement('span');
            fmtLabel.textContent = i18n.t('timeAxisFormat');
            const fmtSelect = document.createElement('select');
            const numericDisplay = transform.numericTimeDisplay === 'duration' ? 'duration'
                : (transform.numericTimeDisplay === 'calendar' ? 'calendar' : 'seconds');
            fmtSelect.innerHTML = `
                <option value="seconds"${numericDisplay === 'seconds' ? ' selected' : ''}>${i18n.t('timeAxisFormatSecondsNumeric')}</option>
                <option value="duration"${numericDisplay === 'duration' ? ' selected' : ''}>${i18n.t('timeAxisFormatDuration')}</option>
                <option value="calendar"${numericDisplay === 'calendar' ? ' selected' : ''}>${i18n.t('timeAxisFormatCalendarFromDate')}</option>
            `;
            fmtSelect.addEventListener('change', () => {
                const selected = fmtSelect.value;
                const patch = { numericTimeDisplay: selected === 'seconds' ? null : selected };
                // Promoting to a calendar needs a valid origin; seed one if the
                // shared origin-date field is empty so the axis never lands on 1970.
                if (selected === 'calendar' && !String(transform.timeStepOriginDate || '').trim()) {
                    patch.timeStepOriginDate = DEFAULT_GENERATED_TIME_ORIGIN;
                }
                this._updateFileTransform(fileId, patch, { rerender: true });
            });
            fmtWrap.append(fmtLabel, fmtSelect);
            panel.append(fmtWrap);

            // Origin date for the value-preserving numeric → calendar promotion
            // (absolute time = origin + rawSeconds). Reuses the reindex origin-date
            // field and its validation.
            if (numericDisplay === 'calendar') {
                const originDateField = makeInput(
                    'timeStepOriginDate',
                    i18n.t('indexTimeOriginStartLabel'),
                    transform.timeStepOriginDate || DEFAULT_GENERATED_TIME_ORIGIN,
                    DEFAULT_GENERATED_TIME_ORIGIN,
                    {
                        type: 'datetime-local',
                        step: '1',
                        className: 'file-transform-field-wide',
                        updateOnChange: false,
                        commitOnBlur: true,
                        onInput: input => {
                            input.classList.remove('invalid');
                            const hint = originDateField.nextSibling;
                            if (hint?.classList?.contains('file-transform-leap-year')) {
                                hint.textContent = leapYearText(input.value);
                            }
                        },
                        onCommit: (value, input) => {
                            const parsed = normalizeGeneratedOriginValue(value);
                            input.classList.toggle('invalid', !parsed.ok);
                            if (!parsed.ok) return;
                            input.value = parsed.value;
                            const currentTransform = this.files.get(fileId)?.transform || {};
                            const current = normalizeGeneratedOriginValue(currentTransform.timeStepOriginDate || DEFAULT_GENERATED_TIME_ORIGIN);
                            if (current.ok && current.value === parsed.value) return;
                            this._updateFileTransform(fileId, {
                                timeStepOriginDate: parsed.value,
                                cropStart: null,
                                cropEnd: null,
                            }, { rerender: true });
                        },
                    },
                );
                originDateField.input.value = normalizeGeneratedOriginValue(transform.timeStepOriginDate || DEFAULT_GENERATED_TIME_ORIGIN).value || DEFAULT_GENERATED_TIME_ORIGIN;
                const leapHint = document.createElement('div');
                leapHint.className = 'file-transform-hint file-transform-leap-year';
                leapHint.textContent = leapYearText(originDateField.input.value);
                panel.append(originDateField, leapHint);
            }
        }
    }

    if (isIndexAxis) {
        const timeTitle = document.createElement('div');
        timeTitle.className = 'file-transform-title';
        timeTitle.textContent = i18n.t('indexTimeTitle');

        const stepWrap = document.createElement('label');
        stepWrap.className = 'file-transform-field';
        const stepLabel = document.createElement('span');
        stepLabel.textContent = i18n.t('timeAxisNewStep');
        const stepSelect = document.createElement('select');
        const stepMode = transform.timeStepMode || timeVar.timeStepMode || 'index';
        const opt = (val, text) => `<option value="${val}"${stepMode === val ? ' selected' : ''}>${text}</option>`;
        stepSelect.innerHTML = [
            opt('index', i18n.t('timeStepIndex')),
            opt('seconds', i18n.t('timeStep1Second')),
            opt('1minute', i18n.t('timeStep1Minute')),
            opt('10minutes', i18n.t('timeStep10Minutes')),
            opt('15minutes', i18n.t('timeStep15Minutes')),
            opt('30minutes', i18n.t('timeStep30Minutes')),
            opt('1hour', i18n.t('timeStep1Hour')),
            opt('1day', i18n.t('timeStep1Day')),
            opt('custom', i18n.t('timeStepCustom')),
        ].join('');
        stepSelect.addEventListener('change', () => {
            const nextStepMode = stepSelect.value;
            this._updateFileTransform(fileId, {
                timeStepMode: nextStepMode,
                timeStepOriginMode: nextStepMode === 'index' ? null : transform.timeStepOriginMode,
            }, { rerender: true, autoscaleX: false });
        });
        stepWrap.append(stepLabel, stepSelect);
        panel.append(timeTitle, stepWrap);

        if (stepMode === 'custom') {
            panel.append(makeCustomStepField());
        }

        if (stepMode !== 'index') {
            const originWrap = document.createElement('label');
            originWrap.className = 'file-transform-field file-transform-field-wide';
            const originLabel = document.createElement('span');
            const originSelect = document.createElement('select');
            const rawOrigin = transform.timeStepOriginMode;
            const originMode = rawOrigin === 'calendar' ? 'calendar'
                : (rawOrigin === 'elapsed-seconds' ? 'elapsed-seconds' : 'elapsed');
            // The reindexed axis is shown as Duration, Seconds (numeric), or a
            // Calendar from an origin date.
            originLabel.textContent = i18n.t('timeAxisShowAs');
            originSelect.innerHTML = `
                <option value="elapsed"${originMode === 'elapsed' ? ' selected' : ''}>${i18n.t('timeAxisFormatDuration')}</option>
                <option value="elapsed-seconds"${originMode === 'elapsed-seconds' ? ' selected' : ''}>${i18n.t('timeAxisFormatSecondsNumeric')}</option>
                <option value="calendar"${originMode === 'calendar' ? ' selected' : ''}>${i18n.t('timeAxisShowCalendar')}</option>
            `;
            originSelect.addEventListener('change', () => {
                const nextOriginMode = originSelect.value;
                const patch = {
                    timeStepOriginMode: nextOriginMode,
                    cropStart: null,
                    cropEnd: null,
                    timeShift: 0,
                };
                if (nextOriginMode === 'calendar' && !String(transform.timeStepOriginDate || '').trim()) {
                    patch.timeStepOriginDate = DEFAULT_GENERATED_TIME_ORIGIN;
                }
                // Row-index: never autoscale — setFileTransform remaps the view
                // through the source time so the data window stays put (#3).
                this._updateFileTransform(fileId, { ...patch }, { rerender: true, autoscaleX: false });
            });
            originWrap.append(originLabel, originSelect);
            panel.append(originWrap);

            if (originMode === 'calendar') {
                const originDateField = makeInput(
                    'timeStepOriginDate',
                    i18n.t('indexTimeOriginStartLabel'),
                    transform.timeStepOriginDate || DEFAULT_GENERATED_TIME_ORIGIN,
                    DEFAULT_GENERATED_TIME_ORIGIN,
                    {
                        type: 'datetime-local',
                        step: '1',
                        className: 'file-transform-field-wide',
                        updateOnChange: false,
                        commitOnBlur: true,
                        onInput: input => {
                            input.classList.remove('invalid');
                            const hint = originDateField.nextSibling;
                            if (hint?.classList?.contains('file-transform-leap-year')) {
                                hint.textContent = leapYearText(input.value);
                            }
                        },
                        onCommit: (value, input) => {
                            const parsed = normalizeGeneratedOriginValue(value);
                            input.classList.toggle('invalid', !parsed.ok);
                            if (!parsed.ok) return;
                            input.value = parsed.value;
                            const currentTransform = this.files.get(fileId)?.transform || {};
                            const current = normalizeGeneratedOriginValue(currentTransform.timeStepOriginDate || DEFAULT_GENERATED_TIME_ORIGIN);
                            if (current.ok && current.value === parsed.value) return;
                            this._updateFileTransform(fileId, {
                                timeStepOriginDate: parsed.value,
                                cropStart: null,
                                cropEnd: null,
                            }, { autoscaleX: false });
                        },
                    },
                );
                originDateField.input.value = normalizeGeneratedOriginValue(transform.timeStepOriginDate || DEFAULT_GENERATED_TIME_ORIGIN).value || DEFAULT_GENERATED_TIME_ORIGIN;
                const leapHint = document.createElement('div');
                leapHint.className = 'file-transform-hint file-transform-leap-year';
                leapHint.textContent = leapYearText(originDateField.input.value);
                panel.append(originDateField, leapHint);
            }
        }
    }

    // Time-axis inspector. Placed after all three axis-kind branches so it is one
    // call site for every format, and it closes the "Time axis" section: is this
    // series equidistant, and do I want the sample-index / Δt signals out of it?
    // The verdict line below the button is filled from the diagnostics cache —
    // eager files compute it inline, lazy files only after the dialog has run
    // once, because a full-column scan must never start from a sidebar render.
    {
        const inspectBtn = document.createElement('button');
        inspectBtn.type = 'button';
        inspectBtn.className = 'file-transform-wide-action';
        inspectBtn.textContent = `🕐 ${i18n.t('timeAxisInspectButton')}`;
        inspectBtn.addEventListener('click', () => { void this._openTimeAxisInspector(fileId); });
        panel.append(inspectBtn);

        const summary = this._timeAxisSummaryLine?.(this._timeAxisDiagnosticsForPanel?.(fileId));
        if (summary) {
            const summaryHint = document.createElement('div');
            summaryHint.className = 'file-transform-hint file-transform-time-axis-summary';
            summaryHint.textContent = summary;
            panel.append(summaryHint);
        }
    }

    const pad2 = n => String(n).padStart(2, '0');
    const dateInputValue = (value) => {
        if (value === null || value === undefined || value === '') return '';
        const ms = Number.isFinite(Number(value)) ? Number(value) : Date.parse(String(value));
        if (!Number.isFinite(ms)) return '';
        const d = new Date(ms);
        const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        return `${date}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    };
    const normalizeCalendarCropValue = (value) => {
        const text = String(value || '').trim();
        if (!text) return { ok: true, value: null };
        const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
        if (!match) return { ok: false };

        const year = Number(match[1]);
        const month = Number(match[2]);
        const day = Number(match[3]);
        let hour = Number(match[4]);
        const minute = Number(match[5]);
        const second = Number(match[6] || 0);
        if (month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 23 || minute > 59 || second > 59) {
            return { ok: false };
        }
        const d = new Date(year, month - 1, day, hour, minute, second);
        if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day
            || d.getHours() !== hour || d.getMinutes() !== minute || d.getSeconds() !== second) {
            return { ok: false };
        }
        return {
            ok: true,
            value: `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
        };
    };
    const parseDurationMsStrict = (value) => {
        if (value === '' || value === null || value === undefined) return 0;
        if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
        const raw = String(value).trim();
        if (!raw) return 0;
        const numeric = Number(raw);
        if (Number.isFinite(numeric)) return numeric;
        const clockMatch = raw.match(/^([+-])?\s*(?:(\d+(?:\.\d+)?)\s*d(?:ays?)?\s*)?(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?$/i);
        if (clockMatch) {
            const sign = clockMatch[1] === '-' ? -1 : 1;
            const days = Number(clockMatch[2] || 0);
            const hours = Number(clockMatch[3]);
            const minutes = Number(clockMatch[4]);
            const seconds = Number(clockMatch[5] || 0);
            return [days, hours, minutes, seconds].every(Number.isFinite)
                ? sign * (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000
                : NaN;
        }
        const match = raw.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(ps|picoseconds?|ns|nanoseconds?|us|microseconds?|ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|day|days|y|yr|yrs|year|years|w|week|weeks)?$/i);
        if (!match) return NaN;
        const amount = Number(match[1]);
        if (!Number.isFinite(amount)) return NaN;
        const unit = (match[2] || 'ms').toLowerCase();
        if (unit.startsWith('p')) return amount / 1e9;
        if (unit.startsWith('n')) return amount / 1e6;
        if (unit === 'us' || unit.startsWith('micro')) return amount / 1000;
        if (unit.startsWith('y')) return amount * 365.25 * 24 * 60 * 60 * 1000;
        if (unit.startsWith('w')) return amount * 7 * 24 * 60 * 60 * 1000;
        if (unit.startsWith('d')) return amount * 24 * 60 * 60 * 1000;
        if (unit.startsWith('h')) return amount * 60 * 60 * 1000;
        if (unit === 'm' || unit.startsWith('min')) return amount * 60 * 1000;
        if (unit.startsWith('s')) return amount * 1000;
        return amount;
    };
    const stepModeForAxis = indexStepMode;
    const isGeneratedDurationAxis = isIndexAxis && stepModeForAxis !== 'index';
    const usesDurationCrop = timeDisplayMode === 'elapsedDateTime' || timeDisplayMode === 'elapsedSeconds' || isGeneratedDurationAxis;
    const usesIndexCrop = isIndexAxis && stepModeForAxis === 'index';
    const cropTooltip = (() => {
        if ((isDateTime && timeDisplayMode === 'calendar') || isGeneratedCalendarAxis) return i18n.t('calendarCropTooltip');
        if (usesIndexCrop) return i18n.t('indexCropTooltip');
        if (usesDurationCrop) return timeDisplayMode === 'elapsedSeconds' ? i18n.t('secondsCropTooltip') : i18n.t('durationCropTooltip');
        return i18n.t('numericCropTooltip');
    })();
    const cropPlaceholders = (() => {
        if (usesIndexCrop) return { start: i18n.t('cropStartIndexPlaceholder'), end: i18n.t('cropEndIndexPlaceholder') };
        if (usesDurationCrop) return { start: i18n.t('cropStartDurationPlaceholder'), end: i18n.t('cropEndDurationPlaceholder') };
        return { start: i18n.t('cropStartNumericPlaceholder'), end: i18n.t('cropEndNumericPlaceholder') };
    })();
    let cropStartField = null;
    let cropEndField = null;
    let timeShiftField = null;
    let yOffsetField = null;
    let applyErrorLabel = null;
    const setApplyError = (message = '') => {
        if (applyErrorLabel) applyErrorLabel.textContent = message;
    };
    const setFieldInvalid = (field, invalid) => {
        field?.input?.classList.toggle('invalid', Boolean(invalid));
    };
    const validateCropField = (field) => {
        const input = field?.input;
        if (!input) return { ok: true, value: null };
        let parsed;
        if ((isDateTime && timeDisplayMode === 'calendar') || isGeneratedCalendarAxis) {
            const nativeInvalid = input.validity?.badInput || input.validity?.rangeOverflow || input.validity?.rangeUnderflow;
            parsed = nativeInvalid ? { ok: false } : normalizeCalendarCropValue(input.value);
            if (!parsed.ok) input.value = '';
        } else if (usesDurationCrop) {
            if (input.value === '' || input.value === null || input.value === undefined) parsed = { ok: true, value: null };
            else parsed = Number.isFinite(parseDurationMsStrict(input.value)) ? { ok: true, value: input.value } : { ok: false };
        } else {
            if (input.value === '' || input.value === null || input.value === undefined) parsed = { ok: true, value: null };
            else parsed = Number.isFinite(Number(input.value)) ? { ok: true, value: input.value } : { ok: false };
        }
        setFieldInvalid(field, !parsed.ok);
        return parsed;
    };
    const clearApplyErrorOnInput = (input) => {
        input.classList.remove('invalid');
        if (applyErrorLabel
            && !cropStartField?.input?.classList.contains('invalid')
            && !cropEndField?.input?.classList.contains('invalid')
            && !timeShiftField?.input?.classList.contains('invalid')
            && !yOffsetField?.input?.classList.contains('invalid')) {
            setApplyError('');
        }
    };
    const validateTimeShiftField = () => {
        if (!timeShiftField?.input) return { ok: true, value: 0 };
        const durationShift = (isDateTime && (timeDisplayMode === 'calendar' || timeDisplayMode === 'elapsedDateTime' || timeDisplayMode === 'elapsedSeconds')) || isGeneratedDurationAxis;
        const raw = timeShiftField.input.value;
        let parsed;
        if (raw === '' || raw === null || raw === undefined) parsed = { ok: true, value: 0 };
        else if (durationShift) parsed = Number.isFinite(parseDurationMsStrict(raw)) ? { ok: true, value: raw } : { ok: false };
        else parsed = Number.isFinite(Number(raw)) ? { ok: true, value: raw } : { ok: false };
        setFieldInvalid(timeShiftField, !parsed.ok);
        return parsed;
    };
    const validateYOffsetField = () => {
        const raw = yOffsetField?.input?.value;
        const parsed = (raw === '' || raw === null || raw === undefined)
            ? { ok: true, value: 0 }
            : (Number.isFinite(Number(raw)) ? { ok: true, value: raw } : { ok: false });
        setFieldInvalid(yOffsetField, !parsed.ok);
        return parsed;
    };
    const applyCropAndOffset = () => {
        const start = validateCropField(cropStartField);
        const end = validateCropField(cropEndField);
        const timeShift = validateTimeShiftField();
        const yOffset = validateYOffsetField();
        if (!start.ok || !end.ok || !timeShift.ok || !yOffset.ok) {
            setApplyError(i18n.t('invalidCropOffsetValue'));
            return;
        }
        setApplyError('');
        this._updateFileTransform(fileId, {
            cropStart: start.value,
            cropEnd: end.value,
            timeShift: timeShift.value,
            yOffset: yOffset.value,
        });
    };
    const isCalendarCrop = (isDateTime && timeDisplayMode === 'calendar') || isGeneratedCalendarAxis;
    const cropInputOptions = isCalendarCrop
        ? {
            type: 'datetime-local',
            step: '1',
            placeholder: '2022-08-01T13:30:00',
            format: dateInputValue,
            className: 'file-transform-field-wide',
            title: cropTooltip,
            updateOnChange: false,
            onInput: clearApplyErrorOnInput,
            onCommit: applyCropAndOffset,
        }
        : {
            type: 'text',
            title: cropTooltip,
            updateOnChange: false,
            onInput: clearApplyErrorOnInput,
            onCommit: applyCropAndOffset,
        };
    const durationShift = (isDateTime && (timeDisplayMode === 'calendar' || timeDisplayMode === 'elapsedDateTime' || timeDisplayMode === 'elapsedSeconds')) || isGeneratedDurationAxis;
    const shiftInputOptions = durationShift
        ? {
            type: 'text',
            title: (timeDisplayMode === 'calendar' || isGeneratedCalendarAxis) ? i18n.t('calendarOffsetTooltip') : i18n.t('durationOffsetTooltip'),
            help: { titleKey: 'timeShiftHelpTitle', bodyKey: 'timeShiftHelpBody' },
            placeholder: '0 h',
            updateOnChange: false,
            onInput: clearApplyErrorOnInput,
            onCommit: applyCropAndOffset,
            format: value => {
                if (value === null || value === undefined || value === '') return '';
                if (Number(value) === 0) return '0 h';
                return String(value);
            },
        }
        : {
            type: 'text',
            title: i18n.t('numericOffsetTooltip'),
            updateOnChange: false,
            onInput: clearApplyErrorOnInput,
            onCommit: applyCropAndOffset,
        };
    const yOffsetInputOptions = {
        type: 'text',
        title: i18n.t('yOffsetTooltip'),
        updateOnChange: false,
        onInput: clearApplyErrorOnInput,
        onCommit: applyCropAndOffset,
    };

    // Crop + Offset are grouped in one bordered box so it reads as one unit.
    const cropOffsetBox = document.createElement('div');
    cropOffsetBox.className = 'file-transform-box';

    const cropTitle = document.createElement('div');
    cropTitle.className = 'file-transform-title';
    cropTitle.textContent = i18n.t('fileCropTitle');
    const cropHint = document.createElement('div');
    cropHint.className = 'file-transform-hint';
    cropHint.textContent = i18n.t('cropUnitsHint');
    cropStartField = makeInput('cropStart', i18n.t('cropStartLabel'), transform.cropStart, cropPlaceholders.start, cropInputOptions);
    cropEndField = makeInput('cropEnd', i18n.t('cropEndLabel'), transform.cropEnd, cropPlaceholders.end, cropInputOptions);
    const offsetTitle = document.createElement('div');
    offsetTitle.className = 'file-transform-title';
    offsetTitle.textContent = i18n.t('fileOffsetTitle');
    timeShiftField = makeInput('timeShift', '\u0394t', transform.timeShift, durationShift ? '0 h' : '0', shiftInputOptions);
    yOffsetField = makeInput('yOffset', '\u0394y', transform.yOffset, '0', yOffsetInputOptions);

    // Error sits on its own full-width row ABOVE the buttons (not beside them).
    applyErrorLabel = document.createElement('div');
    applyErrorLabel.className = 'file-transform-error';
    const applyActions = document.createElement('div');
    applyActions.className = 'file-transform-actions file-transform-crop-actions';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.textContent = 'Apply';
    applyBtn.addEventListener('click', applyCropAndOffset);
    const resetCropBtn = document.createElement('button');
    resetCropBtn.type = 'button';
    resetCropBtn.textContent = 'Reset';
    resetCropBtn.addEventListener('click', () => {
        cropStartField.input.value = '';
        cropEndField.input.value = '';
        timeShiftField.input.value = durationShift ? '0 h' : '0';
        yOffsetField.input.value = '0';
        setFieldInvalid(cropStartField, false);
        setFieldInvalid(cropEndField, false);
        setFieldInvalid(timeShiftField, false);
        setFieldInvalid(yOffsetField, false);
        setApplyError('');
        this._resetFileCropAndOffsets(fileId);
    });
    applyActions.append(applyBtn, resetCropBtn);
    cropOffsetBox.append(cropTitle, cropHint, cropStartField, cropEndField, offsetTitle, timeShiftField, yOffsetField, applyErrorLabel, applyActions);
    panel.appendChild(cropOffsetBox);

    const gainTitle = document.createElement('div');
    gainTitle.className = 'file-transform-title';
    gainTitle.textContent = i18n.t('fileGainTitle');
    panel.append(
        gainTitle,
        makeInput('gain', 'Gain applied to all time-series', transform.gain, '1', { step: '0.1' }),
    );

    const actions = document.createElement('div');
    actions.className = 'file-transform-actions';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = 'Reset all';
    resetBtn.addEventListener('click', () => {
        this._updateFileTransform(fileId, this._defaultFileTransform(), { rerender: true });
    });
    actions.appendChild(resetBtn);
    panel.appendChild(actions);

    return panel;
};

proto._resetFileCropAndOffsets = function(fileId) {
    this._updateFileTransform(fileId, {
        cropStart: null,
        cropEnd: null,
        timeShift: 0,
        yOffset: 0,
    });
};

proto._updateFileTransform = function(fileId, patch, options = {}) {
    const entry = this.files.get(fileId);
    if (!entry) return;
    const previousTransform = entry.transform;
    entry.transform = this._normalizeFileTransform({ ...entry.transform, ...patch });
    const applied = this.plotManager.setFileTransform(fileId, entry.transform, { autoscaleX: options.autoscaleX === true, force: options.force });
    if (applied === false) {
        // Rejected (would break an overlay): keep the app copy in sync with the
        // reverted plot state and re-render so the controls snap back.
        entry.transform = previousTransform;
        this._renderFilesList();
        return;
    }
    if (options.rerender) this._renderFilesList();
    else {
        const isActive = this._isFileTransformActive(entry.transform);
        for (const row of document.querySelectorAll('#files-list .file-entry')) {
            if (row.dataset.fileId === fileId) row.classList.toggle('transformed', isActive);
        }
    }
};

}
