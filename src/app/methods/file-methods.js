import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';

const LOCAL_API_BASE = '/__omv_local__';
let duckDbSourceClassPromise = null;

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

export function installFileMethods(TargetClass) {
    const proto = TargetClass.prototype;
proto.loadFile = async function(file, options = {}) {
    try {
        let currentFile = file;
        let extension;
        let buffer;
        let contentHash;
        let data;
        for (let attempt = 0; ; attempt++) {
            try {
                if ((!currentFile || attempt > 0) && options.fileHandle?.getFile) {
                    currentFile = await options.fileHandle.getFile();
                }
                if (!currentFile) throw new Error(i18n.t('invalidFile'));
                extension = this._fileExtension(currentFile.name);
                const streamable = this._canParseFromFile(currentFile, extension);
                buffer = streamable ? null : await (currentFile.arrayBuffer ? currentFile.arrayBuffer() : this._readAsArrayBuffer(currentFile));
                contentHash = buffer
                    ? await this._hashBuffer(buffer)
                    : this._fileFingerprint(currentFile);
                data = await this._parseResultBuffer(currentFile.name, buffer, currentFile);
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
        const baseName = this._fileBaseName(currentFile.name);
        const transform = this._defaultFileTransform();
        this.files.set(fileId, { file: currentFile, fileHandle: options.fileHandle || null, localPath: options.localPath || '', buffer, contentHash, name: baseName, extension, transform });

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

        console.log('Loaded:', currentFile.name, '- variables:', Object.keys(data.variables).length);
        return { fileId, data };
    } catch (err) {
        console.error('Error loading file:', err);
        alert(i18n.t('errorLoading') + ': ' + (err?.message || String(err)));
        return null;
    }
};

proto.loadFiles = async function(items = []) {
    const entries = Array.from(items || []);
    if (!entries.length) return [];

    const loaded = [];
    this._showFileLoadingOverlay(entries.length);
    await this._yieldToBrowser();
    try {
        for (let index = 0; index < entries.length; index++) {
            const item = entries[index];
            const fileHandle = item?.fileHandle || null;
            const file = item?.file || (fileHandle ? null : item);
            const localPath = item?.localPath || '';
            if (!file && !fileHandle) continue;
            this._updateFileLoadingOverlay(index + 1, entries.length, file?.name || fileHandle?.name || '', file?.size);
            const result = await this.loadFile(file, { fileHandle, localPath, deferUi: true });
            if (result) loaded.push(result);
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
        this._hideFileLoadingOverlay();
    }

    return loaded;
};

proto._yieldToBrowser = function() {
    return new Promise(resolve => setTimeout(resolve, 0));
};

proto._showFileLoadingOverlay = function(total = 1) {
    document.getElementById('file-loading-overlay')?.remove();
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

    dialog.append(spinner, title, hint);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    this._updateFileLoadingOverlay(0, total, '');
    requestAnimationFrame(() => overlay.classList.add('show'));
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

proto._hideFileLoadingOverlay = function() {
    const overlay = document.getElementById('file-loading-overlay');
    if (!overlay) return;
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 220);
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

    const data = await this._parseResultBuffer(this._fileDisplayName(entry), buffer, latestFile || entry.file);
    this._reapplyDerivedVariables(id, data);

    entry.buffer = buffer;
    entry.contentHash = contentHash;
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
    if (sourceHash && contentHash === sourceHash) {
        await Modal.alert(i18n.t('reloadAsNewVersion'), i18n.t('reloadUnchangedNoVersion'), { icon: '🔄' });
        this._updateTopBar();
        return;
    }

    const data = await this._parseResultBuffer(this._fileDisplayName(source), buffer, source.file);

    const fileId = `f${this._nextFileId++}`;
    this._copyDerivedDefinitions(sourceId, fileId);
    this._reapplyDerivedVariables(fileId, data);
    this.files.set(fileId, {
        file: latestFile || source.file,
        fileHandle: source.fileHandle || null,
        localPath: source.localPath || '',
        buffer,
        contentHash,
        name,
        extension: source.extension || '.mat',
        transform: this._normalizeFileTransform(source.transform),
    });
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
        try {
            const file = await entry.fileHandle.getFile();
            const buffer = await (file.arrayBuffer ? file.arrayBuffer() : this._readAsArrayBuffer(file));
            entry.file = file;
            entry.extension = this._fileExtension(file.name);
            return buffer;
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
        return file.arrayBuffer ? file.arrayBuffer() : this._readAsArrayBuffer(file);
    }

    // In Firefox the File object is refreshed on re-read. In Chromium it may
    // be a snapshot, so the FileSystemFileHandle path above is preferred.
    let buffer;
    if (entry.file?.arrayBuffer) {
        try { buffer = await entry.file.arrayBuffer(); } catch (_) {}
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

proto._readLocalResultPath = async function(filePath) {
    const desktopReader = globalThis.omvDesktop?.readFile;
    if (this.capabilities?.isDesktop && typeof desktopReader === 'function') {
        try {
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

    const response = await fetch(`${LOCAL_API_BASE}/file?path=${encodeURIComponent(filePath)}`, { cache: 'no-store' });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(detail || i18n.t('errorLoading'));
    }
    const blob = await response.blob();
    const name = String(filePath).split(/[\\/]/).filter(Boolean).pop() || 'results.csv';
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

proto._parseResultBuffer = async function(filename, buffer, file = null) {
    const extension = this._fileExtension(filename);
    if (extension === '.parquet') return this._parseParquetResult(filename, file);
    if (extension === '.csv') return this._parseCsvResultBuffer(filename, buffer, file);
    if (extension === '.mat') return this.parser.parse(buffer);
    if (this._looksLikeTextBuffer(buffer)) return this._parseCsvResultBuffer(filename, buffer, file);
    throw new Error(i18n.t('invalidFile'));
};

// Files bigger than this threshold (bytes) trigger DuckDB lazy mode: the
// in-memory copy holds a downsampled overview, and zoom queries hit DuckDB.
const DUCKDB_LAZY_THRESHOLD_BYTES = 50 * 1024 * 1024;
// CSV files larger than this should ideally be pre-converted to Parquet
// (`node bench/csv-to-parquet.mjs file.csv`) — the WASM heap ceiling makes
// the raw CSV path risky above this size.
const PARQUET_HINT_THRESHOLD_BYTES = 500 * 1024 * 1024;
// Above this size the legacy JS parser is unsafe: it decodes the whole file
// into one string and can OOM the browser tab before throwing cleanly.
const LEGACY_CSV_FALLBACK_MAX_BYTES = 450 * 1024 * 1024;

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

proto._inspectCsvSample = async function(file, buffer = null) {
    const sampleBuffer = buffer || await this._readFileSampleBuffer(file);
    return this.csvParser.inspectSample(sampleBuffer, { maxRows: 700 });
};

proto._parseParquetResult = async function(filename, file) {
    if (!file) throw new Error(`Parquet files must be loaded via a File handle (got buffer-only for ${filename}).`);
    if (!this._canUseDuckDb()) throw new Error(`Parquet support requires DuckDB-WASM (current page does not allow Workers).`);
    const source = await this._getDuckDbSource();
    const data = await source.parseParquetFile(file, filename, { lazy: true });
    data.filename = filename;
    return data;
};

proto._parseCsvResultBuffer = async function(filename, buffer, file = null) {
    const fileSize = file?.size ?? (buffer?.byteLength || 0);
    const legacyFallbackUnsafe = fileSize >= LEGACY_CSV_FALLBACK_MAX_BYTES;

    // Hint the user toward Parquet for very large CSVs. Non-blocking — the
    // parse still proceeds; this only logs once and could be wired to a
    // toast/notification in a follow-up.
    if (file && fileSize >= PARQUET_HINT_THRESHOLD_BYTES) {
        const mb = (fileSize / (1024 * 1024)).toFixed(0);
        console.warn(`[duckdb] "${filename}" is ${mb} MB — consider converting to Parquet for faster loads:`
            + `\n  node bench/csv-to-parquet.mjs "${filename}"\n  Then load the resulting .parquet directly.`);
    }
    // Try DuckDB-WASM first when available — it bypasses the ~512 MB string
    // ceiling of the legacy parser and returns typed-array columns.
    if (file && this._canUseDuckDb()) {
        try {
            const source = await this._getDuckDbSource();
            const lazy = (file.size ?? 0) >= DUCKDB_LAZY_THRESHOLD_BYTES;
            const csvProfile = await this._inspectCsvSample(file, buffer);
            const data = await source.parseCsvFile(file, filename, { lazy, csvProfile });
            data.filename = filename;
            return data;
        } catch (err) {
            if (legacyFallbackUnsafe) {
                throw this._largeCsvDuckDbError(filename, fileSize, err);
            }
            console.warn('[duckdb] falling back to legacy CSV parser:', err?.message || err);
            // fall through to legacy path
        }
    }
    if (legacyFallbackUnsafe) {
        throw this._largeCsvDuckDbError(filename, fileSize, null);
    }
    if (!buffer && file) {
        buffer = await (file.arrayBuffer ? file.arrayBuffer() : this._readAsArrayBuffer(file));
    }
    if (!this._canUseParserWorker()) return this.csvParser.parse(buffer);
    try {
        return await this._parseCsvInWorker(filename, buffer);
    } catch (err) {
        if (err?.workerUnavailable) return this.csvParser.parse(buffer);
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

proto._parseCsvInWorker = function(filename, buffer) {
    const worker = this._getParserWorker();
    const id = `parse-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workerBuffer = buffer.slice(0);
    return new Promise((resolve, reject) => {
        this._parserWorkerPending.set(id, { resolve, reject });
        try {
            worker.postMessage({ id, filename, buffer: workerBuffer }, [workerBuffer]);
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

    this.plotManager.removeFile(fileId);
    this.files.delete(fileId);
    this.derivedByFile.delete(fileId);
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
        const { name } = entryData;
        const item = document.createElement('div');
        item.className = 'file-list-item';

        const entry = document.createElement('div');
        entry.className = 'file-entry' +
            (fileId === this.activeFileId ? ' active' : '') +
            (this._isFileTransformActive(entryData.transform) ? ' transformed' : '');
        entry.dataset.fileId = fileId;

        const nameSpan = document.createElement('span');
        nameSpan.className = 'file-entry-name';
        nameSpan.textContent = name;
        nameSpan.title = this._fileDisplayName(entryData);
        nameSpan.addEventListener('click', () => this.setActiveFile(fileId));

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
        if (entryData.liveUpdate?.enabled) entry.appendChild(liveIndicator);
        entry.appendChild(transformBtn);
        entry.appendChild(closeBtn);
        item.appendChild(entry);
        if (this._expandedFileTransforms.has(fileId)) {
            item.appendChild(this._renderFileTransformPanel(fileId, entryData));
        }
        list.appendChild(item);
    }
};

proto._defaultFileTransform = function() {
    return { timeDisplayMode: null, calendarTimeFormat: null, timeShift: 0, timeStepMode: null, customTimeStep: '', gain: 1, yOffset: 0, cropStart: null, cropEnd: null };
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
        calendarTimeFormat: t.calendarTimeFormat === 'ampm' ? 'ampm' : null,
        timeShift: t.timeShift === '' || t.timeShift === null || t.timeShift === undefined ? 0 : t.timeShift,
        timeStepMode: ['index', 'seconds', '10minutes', '1hour', 'custom'].includes(t.timeStepMode) ? t.timeStepMode : null,
        customTimeStep: t.customTimeStep === null || t.customTimeStep === undefined ? '' : String(t.customTimeStep),
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
    return t.timeDisplayMode !== null || t.calendarTimeFormat !== null || t.timeShift !== 0 || t.timeStepMode !== null || t.customTimeStep !== '' || t.gain !== 1 || t.yOffset !== 0 || t.cropStart !== null || t.cropEnd !== null;
};

proto._toggleFileTransformPanel = function(fileId) {
    if (this._expandedFileTransforms.has(fileId)) this._expandedFileTransforms.delete(fileId);
    else this._expandedFileTransforms.add(fileId);
    this._renderFilesList();
};

proto._renderFileTransformPanel = function(fileId, entryData) {
    const transform = this._normalizeFileTransform(entryData.transform);
    const timeVar = this.plotManager?._getTimeVar?.(fileId);
    const isDateTime = timeVar?.timeKind === 'datetime';
    const isIndexTime = timeVar?.timeKind === 'index';
    const timeDisplayMode = isDateTime
        ? (transform.timeDisplayMode || timeVar.timeDisplayMode || 'calendar')
        : 'numeric';
    const isIndexAxis = isIndexTime || timeDisplayMode === 'index';
    const calendarTimeFormat = transform.calendarTimeFormat || timeVar?.calendarTimeFormat || '24h';
    const panel = document.createElement('div');
    panel.className = 'file-transform-panel';
    panel.addEventListener('click', e => e.stopPropagation());

    const makeInput = (key, label, value, placeholder = '0', options = {}) => {
        const wrap = document.createElement('label');
        wrap.className = 'file-transform-field';
        if (options.className) wrap.classList.add(options.className);
        if (options.title) wrap.title = options.title;

        const span = document.createElement('span');
        span.textContent = label;
        if (options.title) span.title = options.title;

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
                calendarTimeFormat: nextIsCalendar && selected === 'calendar-ampm' ? 'ampm' : null,
            };
            if (!nextIsIndex) {
                patch.timeStepMode = null;
                patch.customTimeStep = '';
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
        stepSelect.addEventListener('change', () => this._updateFileTransform(fileId, {
            timeStepMode: stepSelect.value,
        }, { rerender: true }));
        stepWrap.append(stepLabel, stepSelect);
        panel.append(timeTitle, stepWrap);

        if (stepMode === 'custom') {
            panel.append(makeInput(
                'customTimeStep',
                i18n.t('indexCustomStepLabel'),
                transform.customTimeStep,
                '15 min',
                { type: 'text', title: i18n.t('indexCustomStepTooltip') },
            ));
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
        const match = raw.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|day|days|w|week|weeks)?$/i);
        if (!match) return NaN;
        const amount = Number(match[1]);
        if (!Number.isFinite(amount)) return NaN;
        const unit = (match[2] || 'ms').toLowerCase();
        if (unit.startsWith('w')) return amount * 7 * 24 * 60 * 60 * 1000;
        if (unit.startsWith('d')) return amount * 24 * 60 * 60 * 1000;
        if (unit.startsWith('h')) return amount * 60 * 60 * 1000;
        if (unit === 'm' || unit.startsWith('min')) return amount * 60 * 1000;
        if (unit.startsWith('s')) return amount * 1000;
        return amount;
    };
    const stepModeForAxis = isIndexAxis ? (transform.timeStepMode || timeVar.timeStepMode || 'index') : null;
    const isGeneratedDurationAxis = isIndexAxis && stepModeForAxis !== 'index';
    const usesDurationCrop = timeDisplayMode === 'elapsedDateTime' || timeDisplayMode === 'elapsedSeconds' || isGeneratedDurationAxis;
    const usesIndexCrop = isIndexAxis && stepModeForAxis === 'index';
    const cropTooltip = (() => {
        if (isDateTime && timeDisplayMode === 'calendar') return i18n.t('calendarCropTooltip');
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
        if (isDateTime && timeDisplayMode === 'calendar') {
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
    const isCalendarCrop = isDateTime && timeDisplayMode === 'calendar';
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
            title: timeDisplayMode === 'calendar' ? i18n.t('calendarOffsetTooltip') : i18n.t('durationOffsetTooltip'),
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
