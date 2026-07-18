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

const LOCAL_API_BASE = '/__omv_local__';
const PARQUET_STRONG_HINT_BYTES = 2 * 1024 * 1024 * 1024;
let duckDbSourceClassPromise = null;
let pypsaNetcdfParserClassPromise = null;
let pickleParserClassPromise = null;
let excelWorkbookModulePromise = null;

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
    if (!pypsaNetcdfParserClassPromise) {
        pypsaNetcdfParserClassPromise = import('../../parsers/pypsa-netcdf-parser.js').then(module => module.default);
    }
    return pypsaNetcdfParserClassPromise;
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
                this._preflightPypsaNetcdfFile(currentFile, extension);
                this._preflightPickleFile(currentFile, extension);
                this._preflightExcelFile(currentFile, extension);
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
                buffer = streamable ? null : await (currentFile.arrayBuffer ? currentFile.arrayBuffer() : this._readAsArrayBuffer(currentFile));
                contentHash = buffer
                    ? await this._hashBuffer(buffer)
                    : this._fileFingerprint(currentFile);
                data = await this._parseResultBuffer(currentFile.name, buffer, currentFile, {
                    csvProfile: options.csvProfile || null,
                    excelSheetName: options.excelSheetName || null,
                    excelWorkbook: options.excelWorkbook || null,
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
        });
        this._adoptExcelCsvCache(this.files.get(fileId), data);

        // PlotManager takes ownership of the data
        this.plotManager.addFile(fileId, baseName, data, transform);

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
        }

        console.log('Loaded:', currentFile.name, '- variables:', Object.keys(data.variables).length);
        return { fileId, data };
    } catch (err) {
        if (isCancelled()) return null;
        if (hideParquetOverlayAfterLoad && !options.deferUi) {
            this._hideFileLoadingOverlay();
        }
        console.error('Error loading file:', err);
        // A formatted dialog (not the browser's native alert) so limit/parse
        // errors read as an in-app warning, with the actionable message intact.
        await Modal.alert(i18n.t('errorLoading'), err?.message || String(err));
        return null;
    }
};

proto.loadFiles = async function(items = []) {
    // Sheet selection happens before the loading overlay so the picker is not
    // stacked under it and the progress counter reflects the expanded count.
    const entries = await this._expandExcelEntries(Array.from(items || []));
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
            this._preflightExcelFile(file, extension);
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
    });
    if (data?.metadata?.excel) entry.excel = { ...data.metadata.excel };
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
        this._preflightPypsaNetcdfFile(file, this._fileExtension(file.name));
        this._preflightPickleFile(file, this._fileExtension(file.name));
        this._preflightExcelFile(file, this._fileExtension(file.name));
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
            this._preflightPypsaNetcdfFile(file, this._fileExtension(file.name));
            this._preflightPickleFile(file, this._fileExtension(file.name));
            this._preflightExcelFile(file, this._fileExtension(file.name));
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
        this._preflightPypsaNetcdfFile(file, entry.extension);
        this._preflightPickleFile(file, entry.extension);
        this._preflightExcelFile(file, entry.extension);
        return file.arrayBuffer ? file.arrayBuffer() : this._readAsArrayBuffer(file);
    }

    // In Firefox the File object is refreshed on re-read. In Chromium it may
    // be a snapshot, so the FileSystemFileHandle path above is preferred.
    let buffer;
    if (entry.file?.arrayBuffer) {
        this._preflightPypsaNetcdfFile(entry.file, entry.extension || this._fileExtension(entry.file.name));
        this._preflightPickleFile(entry.file, entry.extension || this._fileExtension(entry.file.name));
        this._preflightExcelFile(entry.file, entry.extension || this._fileExtension(entry.file.name));
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

proto._preflightPypsaNetcdfFile = function(file, extension = this._fileExtension(file?.name || '')) {
    if (!this._isPypsaNetcdfExtension(extension)) return;
    const size = Number(file?.size || 0);
    const limit = this._pypsaNetcdfEagerLimitBytes();
    if (!Number.isFinite(size) || size <= limit) return;
    throw new Error(i18n.t('pypsaNetcdfTooLarge')
        .replace('{file}', file?.name || 'network.nc')
        .replace('{size}', this._formatFileSize(size))
        .replace('{limit}', this._formatFileSize(limit)));
};

proto._pickleEagerLimitBytes = function() {
    const fallback = this.capabilities?.isDesktop
        ? PICKLE_DESKTOP_EAGER_LIMIT_BYTES
        : PICKLE_WEB_EAGER_LIMIT_BYTES;
    return this._advancedSettingBytes('pickleFullLoadMb', fallback);
};

proto._preflightPickleFile = function(file, extension = this._fileExtension(file?.name || '')) {
    if (!this._isPickleExtension(extension)) return;
    const size = Number(file?.size || 0);
    const limit = this._pickleEagerLimitBytes();
    if (!Number.isFinite(size) || size <= limit) return;
    throw new Error(i18n.t('pickleTooLarge')
        .replace('{file}', file?.name || 'data.pkl')
        .replace('{size}', this._formatFileSize(size))
        .replace('{limit}', this._formatFileSize(limit)));
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

proto._preflightExcelFile = function(file, extension = this._fileExtension(file?.name || '')) {
    if (!this._isExcelExtension(extension)) return;
    const size = Number(file?.size || 0);
    const limit = this._excelEagerLimitBytes();
    if (!Number.isFinite(size) || size <= limit) return;
    throw new Error(i18n.t('excelTooLarge')
        .replace('{file}', file?.name || 'data.xlsx')
        .replace('{size}', this._formatFileSize(size))
        .replace('{limit}', this._formatFileSize(limit)));
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
                this._preflightPypsaNetcdfFile(statResult, this._fileExtension(filePath));
                this._preflightPickleFile(statResult, this._fileExtension(filePath));
                this._preflightExcelFile(statResult, this._fileExtension(filePath));
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
            this._preflightPypsaNetcdfFile(statLike, extension);
            this._preflightPickleFile(statLike, extension);
            this._preflightExcelFile(statLike, extension);
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
    if (extension === '.nc' || extension === '.netcdf') return this._parsePypsaNetcdfResultBuffer(filename, buffer);
    if (this._isPickleExtension(extension)) return this._parsePickleResultBuffer(filename, buffer);
    if (this._isExcelExtension(extension)) return this._parseExcelResultBuffer(filename, buffer, options);
    if (extension === '.csv') return this._parseCsvResultBuffer(filename, buffer, file, options);
    if (extension === '.mat') return this.parser.parse(buffer);
    if (this._looksLikePickleBuffer(buffer)) throw new Error(i18n.t('pickleLooksLikeUnsupportedExtension'));
    if (this._looksLikeTextBuffer(buffer)) return this._parseCsvResultBuffer(filename, buffer, file, options);
    throw new Error(i18n.t('invalidFile'));
};

proto._parsePypsaNetcdfResultBuffer = async function(filename, buffer) {
    const Parser = await loadPypsaNetcdfParserClass();
    const parser = new Parser(this.parser);
    return parser.parse(buffer, filename, { maxFileBytes: this._pypsaNetcdfEagerLimitBytes() });
};

// Spreadsheets are not parsed directly: the selected sheet is serialized to
// deterministic CSV text and fed to the CSV pipeline, so header/time
// detection, profiles and the parsing-preview dialog all apply unchanged.
proto._parseExcelResultBuffer = async function(filename, buffer, options = {}) {
    const excel = await loadExcelWorkbookModule();
    const workbook = options.excelWorkbook
        || excel.readWorkbook(await excel.loadXlsxModule(), buffer);
    const sheetName = resolveExcelSheetName(excel, workbook, options.excelSheetName || null);
    if (!sheetName) {
        throw new Error(i18n.t('excelNoDataSheets').replace('{file}', filename));
    }
    const csvBuffer = excel.csvTextToBuffer(excel.sheetToCsvText(workbook, sheetName));
    // file = null on purpose: it keeps the converted buffer out of the DuckDB
    // lazy path and the Parquet hints, while still using the parser worker.
    const data = await this._parseCsvResultBuffer(filename, csvBuffer, null, {
        csvProfile: options.csvProfile || null,
    });
    data.metadata.excel = {
        sheetName,
        sheetNames: excel.listSheets(workbook).map(sheet => sheet.name),
    };
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
    const excel = await loadExcelWorkbookModule();
    const workbook = excel.readWorkbook(await excel.loadXlsxModule(), rawBuffer);
    const resolvedName = resolveExcelSheetName(excel, workbook, preferredName);
    if (!resolvedName) {
        throw new Error(i18n.t('excelNoDataSheets').replace('{file}', this._fileDisplayName(entry)));
    }
    const csvBuffer = excel.csvTextToBuffer(excel.sheetToCsvText(workbook, resolvedName));
    entry.excelCsvBuffer = csvBuffer;
    entry.excelCsvSheetName = resolvedName;
    entry.excelCsvSourceBuffer = rawBuffer;
    return {
        csvBuffer,
        rawBuffer,
        sheetName: resolvedName,
        sheetNames: excel.listSheets(workbook).map(sheet => sheet.name),
    };
};

proto._hasExcelCsvCache = function(entry, rawBuffer = entry?.buffer, preferredName = entry?.excel?.sheetName || null) {
    return !!(entry?.excelCsvBuffer
        && entry.excelCsvSourceBuffer === rawBuffer
        && (!preferredName || entry.excelCsvSheetName === preferredName));
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

proto._parsePickleResultBuffer = async function(filename, buffer) {
    const Parser = await loadPickleParserClass();
    const parser = new Parser(this.parser);
    try {
        return await parser.parse(buffer, filename, { maxFileBytes: this._pickleEagerLimitBytes() });
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

proto._csvCompactHintBytes = function() {
    return this._advancedSettingBytes('csvCompactHintMb', PARQUET_HINT_THRESHOLD_BYTES);
};

proto._canParseFromFile = function(file, extension = this._fileExtension(file?.name || '')) {
    return !!file
        && (extension === '.csv' || extension === '.parquet')
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
    if (extension !== '.csv') return false;
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
    const data = await source.parseParquetFile(file, filename, { lazy: true });
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

proto._getParserWorker = function() {
    if (this._parserWorker) return this._parserWorker;
    if (!this._parserWorkerPending) this._parserWorkerPending = new Map();
    try {
        this._parserWorker = new Worker(new URL('../../workers/result-parser-worker.js', import.meta.url), { type: 'module' });
    } catch (err) {
        const unavailable = new Error(err?.message || 'Parser worker unavailable');
        unavailable.workerUnavailable = true;
        throw unavailable;
    }

    this._parserWorker.addEventListener('message', (event) => {
        const { id, ok, data, error } = event.data || {};
        const pending = this._parserWorkerPending?.get(id);
        if (!pending) return;
        this._parserWorkerPending.delete(id);
        if (ok) {
            pending.resolve(data);
            return;
        }
        const err = new Error(error?.message || 'CSV parse failed');
        err.name = error?.name || 'Error';
        err.stack = error?.stack || err.stack;
        pending.reject(err);
    });

    this._parserWorker.addEventListener('error', (event) => {
        const err = new Error(event?.message || 'Parser worker failed');
        for (const [, pending] of this._parserWorkerPending || []) pending.reject(err);
        this._parserWorkerPending?.clear();
        this._parserWorker?.terminate();
        this._parserWorker = null;
    });

    return this._parserWorker;
};

proto._parseCsvInWorker = function(filename, buffer, csvProfile = null) {
    const worker = this._getParserWorker();
    const id = `parse-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workerBuffer = buffer.slice(0);
    return new Promise((resolve, reject) => {
        this._parserWorkerPending.set(id, { resolve, reject });
        try {
            worker.postMessage({ id, filename, buffer: workerBuffer, csvProfile: cloneCsvProfileForIpc(csvProfile) }, [workerBuffer]);
        } catch (err) {
            this._parserWorkerPending.delete(id);
            reject(err);
        }
    });
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
    if (metadata?.format === 'pandas-pickle' || metadata?.source === 'pandas') {
        return i18n.t('fileTypePandasPickle');
    }
    return '';
};

proto._fileTypeHasWarnings = function(_entry, fileId = null) {
    const metadata = fileId ? this.plotManager.files.get(fileId)?.data?.metadata : null;
    return Number(metadata?.skippedDynamicCount || metadata?.skippedDynamic?.length || 0) > 0
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
    return { timeDisplayMode: null, calendarTimeFormat: null, timeShift: 0, timeStepMode: null, customTimeStep: '', timeStepOriginMode: null, gain: 1, yOffset: 0, cropStart: null, cropEnd: null };
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
        timeStepMode: ['index', 'seconds', '10minutes', '1hour', 'custom'].includes(t.timeStepMode) ? t.timeStepMode : null,
        customTimeStep: t.customTimeStep === null || t.customTimeStep === undefined ? '' : String(t.customTimeStep),
        timeStepOriginMode: ['elapsed', 'calendar'].includes(t.timeStepOriginMode) ? t.timeStepOriginMode : null,
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
    return t.timeDisplayMode !== null || t.calendarTimeFormat !== null || t.timeShift !== 0 || t.timeStepMode !== null || t.customTimeStep !== '' || t.timeStepOriginMode !== null || t.gain !== 1 || t.yOffset !== 0 || t.cropStart !== null || t.cropEnd !== null;
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
    const timeDisplayMode = isDateTime
        ? (transform.timeDisplayMode || timeVar.timeDisplayMode || 'calendar')
        : 'numeric';
    const isIndexAxis = isIndexTime || timeDisplayMode === 'index';
    const indexStepMode = isIndexAxis ? (transform.timeStepMode || timeVar.timeStepMode || 'index') : null;
    let isGeneratedCalendarAxis = isDateTime
        && timeDisplayMode === 'index'
        && indexStepMode !== 'index'
        && transform.timeStepOriginMode === 'calendar';
    const calendarTimeFormat = transform.calendarTimeFormat || timeVar?.calendarTimeFormat || '24h';
    const panel = document.createElement('div');
    panel.className = 'file-transform-panel';
    panel.addEventListener('click', e => e.stopPropagation());

    // Yellow "?" help button that opens a FLOATING popup (not an in-flow box):
    // the popover is fixed-positioned and lives on <body> only while open, so it
    // overlays the UI near the button instead of pushing the menu around.
    const makeTransformHelp = (titleKey, bodyKey) => {
        const helpBtn = document.createElement('button');
        helpBtn.type = 'button';
        helpBtn.className = 'fft-help-btn file-transform-help-btn';
        helpBtn.textContent = '?';
        helpBtn.title = i18n.t(titleKey);
        helpBtn.setAttribute('aria-label', i18n.t(titleKey));
        helpBtn.setAttribute('aria-expanded', 'false');

        const helpPopover = document.createElement('div');
        helpPopover.className = 'fft-help-popover file-transform-help-popover';
        helpPopover.hidden = true;
        helpPopover.innerHTML = `<div class="file-transform-help-title">${i18n.t(titleKey)}</div>${i18n.t(bodyKey)}`;

        const positionPopover = () => {
            const rect = helpBtn.getBoundingClientRect();
            const margin = 8;
            const w = helpPopover.offsetWidth;
            const h = helpPopover.offsetHeight;
            let left = Math.min(rect.left, window.innerWidth - w - margin);
            left = Math.max(margin, left);
            let top = rect.bottom + 6;
            if (top + h > window.innerHeight - margin) top = Math.max(margin, rect.top - h - 6);
            helpPopover.style.left = `${left}px`;
            helpPopover.style.top = `${top}px`;
        };
        const onDocMouseDown = (event) => {
            if (!helpPopover.contains(event.target) && event.target !== helpBtn) closeHelp();
        };
        function closeHelp() {
            helpPopover.hidden = true;
            helpPopover.remove();
            helpBtn.setAttribute('aria-expanded', 'false');
            document.removeEventListener('mousedown', onDocMouseDown, true);
            window.removeEventListener('resize', closeHelp);
            window.removeEventListener('scroll', closeHelp, true);
        }
        // Stop the wrapping <label> from redirecting the click to the input.
        helpBtn.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation(); });
        helpBtn.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!helpPopover.hidden) { closeHelp(); return; }
            document.body.appendChild(helpPopover);
            helpPopover.hidden = false;
            helpBtn.setAttribute('aria-expanded', 'true');
            positionPopover();
            setTimeout(() => {
                document.addEventListener('mousedown', onDocMouseDown, true);
                window.addEventListener('resize', closeHelp);
                window.addEventListener('scroll', closeHelp, true);
            }, 0);
        });
        return { helpBtn, helpPopover };
    };

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
        if (options.updateOnChange !== false) input.addEventListener('change', commitValue);
        if (options.onInput) input.addEventListener('input', () => options.onInput(input));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (options.updateOnChange === false) commitValue();
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
            this._updateFileTransform(fileId, { customTimeStep });
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

    if (isDateTime) {
        const timeTitle = document.createElement('div');
        timeTitle.className = 'file-transform-title';
        timeTitle.textContent = 'Time axis';

        const modeWrap = document.createElement('label');
        modeWrap.className = 'file-transform-field file-transform-field-wide';
        const modeLabel = document.createElement('span');
        modeLabel.textContent = 'Mode';
        const modeSelect = document.createElement('select');
        const selectedCalendarMode = timeDisplayMode === 'calendar'
            ? (calendarTimeFormat === 'ampm' ? 'calendar-ampm' : 'calendar-24h')
            : timeDisplayMode;
        modeSelect.innerHTML = `
            <option value="calendar-24h"${selectedCalendarMode === 'calendar-24h' ? ' selected' : ''}>Calendar (24h format)</option>
            <option value="calendar-ampm"${selectedCalendarMode === 'calendar-ampm' ? ' selected' : ''}>Calendar (AM/PM format)</option>
            <option value="elapsedDateTime"${timeDisplayMode === 'elapsedDateTime' ? ' selected' : ''}>Elapsed (hh:mm:ss)</option>
            <option value="elapsedSeconds"${timeDisplayMode === 'elapsedSeconds' ? ' selected' : ''}>Elapsed (seconds)</option>
            <option value="index"${timeDisplayMode === 'index' ? ' selected' : ''}>Index</option>
        `;
        const updateTimeMode = () => {
            const selected = modeSelect.value;
            const nextIsCalendar = selected === 'calendar-24h' || selected === 'calendar-ampm';
            const nextIsIndex = selected === 'index';
            const patch = {
                timeDisplayMode: nextIsCalendar ? 'calendar' : selected,
                calendarTimeFormat: nextIsCalendar
                    ? (selected === 'calendar-ampm' ? 'ampm' : '24h')
                    : null,
            };
            if (!nextIsIndex) {
                patch.timeStepMode = null;
                patch.customTimeStep = '';
                patch.timeStepOriginMode = null;
            }
            if (!(timeDisplayMode === 'calendar' && nextIsCalendar)) {
                patch.cropStart = null;
                patch.cropEnd = null;
                patch.timeShift = 0;
            }
            this._updateFileTransform(fileId, patch, { rerender: true });
        };
        modeSelect.addEventListener('change', updateTimeMode);
        modeWrap.append(modeLabel, modeSelect);
        panel.append(timeTitle, modeWrap);

        if (datetimeAxisStalled) {
            const stalledHint = document.createElement('div');
            stalledHint.className = 'file-transform-hint datetime-axis-warning-hint';
            stalledHint.textContent = i18n.t('datetimeAxisStalledHint');
            panel.appendChild(stalledHint);
        }

        if (timeDisplayMode === 'index') {
            const indexHint = document.createElement('div');
            indexHint.className = 'file-transform-hint';
            indexHint.textContent = i18n.t('indexIgnoreDetectedHint');
            panel.appendChild(indexHint);
        }
    }

    if (isIndexAxis) {
        const timeTitle = document.createElement('div');
        timeTitle.className = 'file-transform-title';
        timeTitle.textContent = i18n.t('indexTimeTitle');

        const stepWrap = document.createElement('label');
        stepWrap.className = 'file-transform-field';
        const stepLabel = document.createElement('span');
        stepLabel.textContent = i18n.t('indexTimeStepLabel');
        const stepSelect = document.createElement('select');
        const stepMode = transform.timeStepMode || timeVar.timeStepMode || 'index';
        stepSelect.innerHTML = `
            <option value="index"${stepMode === 'index' ? ' selected' : ''}>${i18n.t('indexTimeStepIndex')}</option>
            <option value="seconds"${stepMode === 'seconds' ? ' selected' : ''}>${i18n.t('indexTimeStepSeconds')}</option>
            <option value="10minutes"${stepMode === '10minutes' ? ' selected' : ''}>${i18n.t('indexTimeStep10Minutes')}</option>
            <option value="1hour"${stepMode === '1hour' ? ' selected' : ''}>${i18n.t('indexTimeStep1Hour')}</option>
            <option value="custom"${stepMode === 'custom' ? ' selected' : ''}>${i18n.t('indexTimeStepCustom')}</option>
        `;
        stepSelect.addEventListener('change', () => {
            const nextStepMode = stepSelect.value;
            this._updateFileTransform(fileId, {
                timeStepMode: nextStepMode,
                timeStepOriginMode: nextStepMode === 'index' ? null : transform.timeStepOriginMode,
            }, { rerender: true });
        });
        stepWrap.append(stepLabel, stepSelect);
        panel.append(timeTitle, stepWrap);

        if (stepMode === 'custom') {
            panel.append(makeCustomStepField());
        }

        if (isDateTime && stepMode !== 'index') {
            const originWrap = document.createElement('label');
            originWrap.className = 'file-transform-field file-transform-field-wide';
            const originLabel = document.createElement('span');
            originLabel.textContent = i18n.t('indexTimeOriginLabel');
            const originSelect = document.createElement('select');
            const originMode = transform.timeStepOriginMode === 'calendar' ? 'calendar' : 'elapsed';
            originSelect.innerHTML = `
                <option value="elapsed"${originMode === 'elapsed' ? ' selected' : ''}>${i18n.t('indexTimeOriginElapsed')}</option>
                <option value="calendar"${originMode === 'calendar' ? ' selected' : ''}>${i18n.t('indexTimeOriginCalendar')}</option>
            `;
            originSelect.addEventListener('change', () => {
                this._updateFileTransform(fileId, {
                    timeStepOriginMode: originSelect.value,
                    cropStart: null,
                    cropEnd: null,
                    timeShift: 0,
                }, { rerender: true });
            });
            originWrap.append(originLabel, originSelect);
            panel.append(originWrap);
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

    const cropTitle = document.createElement('div');
    cropTitle.className = 'file-transform-title';
    cropTitle.textContent = i18n.t('fileCropTitle');
    const cropHint = document.createElement('div');
    cropHint.className = 'file-transform-hint';
    cropHint.textContent = i18n.t('cropUnitsHint');
    panel.append(cropTitle, cropHint);
    cropStartField = makeInput('cropStart', i18n.t('cropStartLabel'), transform.cropStart, cropPlaceholders.start, cropInputOptions);
    cropEndField = makeInput('cropEnd', i18n.t('cropEndLabel'), transform.cropEnd, cropPlaceholders.end, cropInputOptions);
    panel.append(
        cropStartField,
        cropEndField,
    );
    const offsetTitle = document.createElement('div');
    offsetTitle.className = 'file-transform-title';
    offsetTitle.textContent = i18n.t('fileOffsetTitle');
    timeShiftField = makeInput('timeShift', '\u0394t', transform.timeShift, durationShift ? '0 h' : '0', shiftInputOptions);
    yOffsetField = makeInput('yOffset', '\u0394y', transform.yOffset, '0', yOffsetInputOptions);
    panel.append(
        offsetTitle,
        timeShiftField,
        yOffsetField,
    );

    const applyActions = document.createElement('div');
    applyActions.className = 'file-transform-actions file-transform-crop-actions';
    applyErrorLabel = document.createElement('span');
    applyErrorLabel.className = 'file-transform-error';
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.textContent = i18n.t('applyCropOffset');
    applyBtn.addEventListener('click', applyCropAndOffset);
    const resetCropBtn = document.createElement('button');
    resetCropBtn.type = 'button';
    resetCropBtn.textContent = i18n.t('resetCropOffset');
    resetCropBtn.addEventListener('click', () => {
        cropStartField.input.value = '';
        cropEndField.input.value = '';
        setFieldInvalid(cropStartField, false);
        setFieldInvalid(cropEndField, false);
        setApplyError('');
        this._updateFileTransform(fileId, { cropStart: null, cropEnd: null });
    });
    applyActions.append(applyErrorLabel, applyBtn, resetCropBtn);
    panel.appendChild(applyActions);

    const gainTitle = document.createElement('div');
    gainTitle.className = 'file-transform-title';
    gainTitle.textContent = i18n.t('fileGainTitle');
    panel.append(
        gainTitle,
        makeInput('gain', i18n.t('gainLabel'), transform.gain, '1', { step: '0.1' }),
    );

    const actions = document.createElement('div');
    actions.className = 'file-transform-actions';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.textContent = i18n.t('resetTransform');
    resetBtn.addEventListener('click', () => {
        this._updateFileTransform(fileId, this._defaultFileTransform(), { rerender: true });
    });
    actions.appendChild(resetBtn);
    panel.appendChild(actions);

    return panel;
};

proto._updateFileTransform = function(fileId, patch, options = {}) {
    const entry = this.files.get(fileId);
    if (!entry) return;
    entry.transform = this._normalizeFileTransform({ ...entry.transform, ...patch });
    this.plotManager.setFileTransform(fileId, entry.transform);
    if (options.rerender) this._renderFilesList();
    else {
        const isActive = this._isFileTransformActive(entry.transform);
        for (const row of document.querySelectorAll('#files-list .file-entry')) {
            if (row.dataset.fileId === fileId) row.classList.toggle('transformed', isActive);
        }
    }
};

}
