import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';
import { RESULT_FILE_EXTENSIONS } from '../constants.js';

export function installFileMethods(TargetClass) {
    const proto = TargetClass.prototype;
proto.loadFile = async function(file, options = {}) {
    if (!this._isSupportedResultFileName(file.name)) { alert(i18n.t('invalidFile')); return; }

    try {
        document.getElementById('file-name').textContent = `Loading ${file.name}…`;
        const buffer = await (file.arrayBuffer ? file.arrayBuffer() : this._readAsArrayBuffer(file));
        const contentHash = await this._hashBuffer(buffer);
        const data   = await this._parseResultBuffer(file.name, buffer);

        const fileId   = `f${this._nextFileId++}`;
        const extension = this._fileExtension(file.name);
        const baseName = this._fileBaseName(file.name);
        const transform = this._defaultFileTransform();
        this.files.set(fileId, { file, fileHandle: options.fileHandle || null, buffer, contentHash, name: baseName, extension, transform });

        // PlotManager takes ownership of the data
        this.plotManager.addFile(fileId, baseName, data, transform);

        // Hide drop zone after first file
        document.getElementById('drop-zone').classList.remove('active');

        this._updateTopBar();
        this._renderFilesList();
        this._clearVariableSelection();
        this.renderVariablesTree(data.tree);
        this._updateActionButtons();

        console.log('Loaded:', file.name, '— variables:', Object.keys(data.variables).length);
    } catch (err) {
        console.error('Error loading file:', err);
        alert(i18n.t('errorLoading') + ': ' + (err?.message || String(err)));
        document.getElementById('file-name').textContent = '';
    }
};

proto.reloadActiveFile = async function() {
    const id = this.plotManager.activeFileId;
    if (!id) return;
    const entry = this.files.get(id);
    if (!entry) return;

    document.getElementById('file-name').textContent = `Loading ${this._fileDisplayName(entry)}…`;

    const buffer = await this._readLatestBuffer(entry);
    const contentHash = await this._hashBuffer(buffer);

    const data = await this._parseResultBuffer(this._fileDisplayName(entry), buffer);
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
    document.getElementById('file-name').textContent = `Loading ${name}${source.extension || '.mat'}…`;

    const buffer = await this._readLatestBuffer(source);
    const contentHash = await this._hashBuffer(buffer);
    const sourceHash = source.contentHash || (source.buffer ? await this._hashBuffer(source.buffer) : '');
    if (!source.contentHash && sourceHash) source.contentHash = sourceHash;
    if (sourceHash && contentHash === sourceHash) {
        document.getElementById('file-name').textContent = this._fileDisplayName(source);
        await Modal.alert(i18n.t('reloadAsNewVersion'), i18n.t('reloadUnchangedNoVersion'), { icon: '🔄' });
        this._updateTopBar();
        return;
    }

    const data = await this._parseResultBuffer(this._fileDisplayName(source), buffer);

    const fileId = `f${this._nextFileId++}`;
    this._copyDerivedDefinitions(sourceId, fileId);
    this._reapplyDerivedVariables(fileId, data);
    this.files.set(fileId, {
        file: source.file,
        fileHandle: source.fileHandle || null,
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

proto._readLatestBuffer = async function(entry) {
    if (entry.fileHandle?.getFile) {
        try {
            const file = await entry.fileHandle.getFile();
            const buffer = await (file.arrayBuffer ? file.arrayBuffer() : this._readAsArrayBuffer(file));
            if (!this._isSupportedResultFileName(file.name)) throw new Error(i18n.t('invalidFile'));
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
        if (!this._isSupportedResultFileName(file.name)) throw new Error(i18n.t('invalidFile'));

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
        input.accept = RESULT_FILE_EXTENSIONS.join(',');
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
        types: [{
            description: 'MAT and CSV result files',
            accept: {
                'application/octet-stream': ['.mat'],
                'text/csv': ['.csv'],
            },
        }],
    });

    const picked = [];
    for (const fileHandle of handles) {
        const file = await fileHandle.getFile();
        if (this._isSupportedResultFileName(file.name)) picked.push({ file, fileHandle });
    }
    return picked;
};

proto._openResultFilesFromUser = async function() {
    if (this._canUseFileSystemPicker()) {
        try {
            const picked = await this._pickResultFilesWithHandles({ multiple: true });
            for (const { file, fileHandle } of picked) {
                await this.loadFile(file, { fileHandle });
            }
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
                const file = await fileHandle.getFile();
                if (this._isSupportedResultFileName(file.name)) picked.push({ file, fileHandle });
            } catch (err) {
                console.warn('Could not read dropped file handle.', err);
            }
        }

        if (picked.length) return picked;
    }

    return Array.from(dataTransfer?.files || [])
        .filter(file => this._isSupportedResultFileName(file.name))
        .map(file => ({ file, fileHandle: null }));
};

proto._isSupportedResultFileName = function(filename) {
    return RESULT_FILE_EXTENSIONS.includes(this._fileExtension(filename));
};

proto._fileExtension = function(filename) {
    const match = String(filename || '').toLowerCase().match(/\.[^.]+$/);
    return match ? match[0] : '';
};

proto._fileBaseName = function(filename) {
    return String(filename || 'results').replace(/\.[^.]+$/i, '');
};

proto._fileDisplayName = function(entry) {
    return `${entry?.name || ''}${entry?.extension || '.mat'}`;
};

proto._parseResultBuffer = async function(filename, buffer) {
    const extension = this._fileExtension(filename);
    if (extension === '.csv') return this.csvParser.parse(buffer);
    if (extension === '.mat') return this.parser.parse(buffer);
    throw new Error(i18n.t('invalidFile'));
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
        const ok = await Modal.confirm(i18n.t('closeFileWarning'), { icon: '📂' });
        if (!ok) return;
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
        if (d) this.renderVariablesTree(d.tree);
    } else {
        document.getElementById('variables-tree').innerHTML = '';
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
    this._updateTopBar();
    this._renderFilesList();
};

proto._updateTopBar = function() {
    const id   = this.plotManager.activeFileId;
    const entry = id ? this.files.get(id) : null;
    document.getElementById('file-name').textContent = entry ? this._fileDisplayName(entry) : '';
};

proto._updateActionButtons = function() {
    const hasFiles = this.files.size > 0;
    document.getElementById('reload-file').disabled  = !hasFiles;
    document.getElementById('auto-zoom').disabled    = !hasFiles;
    document.getElementById('clear-plots').disabled  = !hasFiles;
    const reloadModeToggle = document.getElementById('reload-as-version-toggle');
    const reloadModeSwitch = document.getElementById('reload-as-version-switch');
    if (reloadModeToggle) reloadModeToggle.disabled = !hasFiles;
    if (reloadModeSwitch) reloadModeSwitch.classList.toggle('disabled', !hasFiles);
};

proto._renderFilesList = function() {
    const list = document.getElementById('files-list');
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
        transformBtn.setAttribute('aria-expanded', String(this._expandedFileTransforms.has(fileId)));
        transformBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleFileTransformPanel(fileId);
        });

        const closeBtn = document.createElement('button');
        closeBtn.className = 'file-entry-close';
        closeBtn.textContent = '✕';
        closeBtn.title = i18n.t('closeFile');
        closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.removeFile(fileId); });

        entry.appendChild(nameSpan);
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
    return { timeShift: 0, gain: 1, yOffset: 0, cropStart: null, cropEnd: null };
};

proto._normalizeFileTransform = function(transform = null) {
    const t = transform || {};
    const finiteOrZero = (value) => {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    };
    const finiteOrNull = (value) => {
        if (value === '' || value === null || value === undefined) return null;
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    };
    return {
        timeShift: finiteOrZero(t.timeShift),
        gain: (() => {
            const n = Number(t.gain);
            return Number.isFinite(n) ? n : 1;
        })(),
        yOffset: finiteOrZero(t.yOffset),
        cropStart: finiteOrNull(t.cropStart),
        cropEnd: finiteOrNull(t.cropEnd),
    };
};

proto._isFileTransformActive = function(transform) {
    const t = this._normalizeFileTransform(transform);
    return t.timeShift !== 0 || t.gain !== 1 || t.yOffset !== 0 || t.cropStart !== null || t.cropEnd !== null;
};

proto._toggleFileTransformPanel = function(fileId) {
    if (this._expandedFileTransforms.has(fileId)) this._expandedFileTransforms.delete(fileId);
    else this._expandedFileTransforms.add(fileId);
    this._renderFilesList();
};

proto._renderFileTransformPanel = function(fileId, entryData) {
    const transform = this._normalizeFileTransform(entryData.transform);
    const panel = document.createElement('div');
    panel.className = 'file-transform-panel';
    panel.addEventListener('click', e => e.stopPropagation());

    const makeInput = (key, label, value, placeholder = '0', options = {}) => {
        const wrap = document.createElement('label');
        wrap.className = 'file-transform-field';

        const span = document.createElement('span');
        span.textContent = label;

        const input = document.createElement('input');
        input.type = 'number';
        input.step = options.step || 'any';
        input.inputMode = 'decimal';
        input.placeholder = placeholder;
        input.value = value === null || value === undefined ? '' : String(value);
        input.addEventListener('change', () => this._updateFileTransform(fileId, { [key]: input.value }));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') input.blur();
        });

        wrap.append(span, input);
        return wrap;
    };

    const cropTitle = document.createElement('div');
    cropTitle.className = 'file-transform-title';
    cropTitle.textContent = i18n.t('fileCropTitle');
    panel.append(
        cropTitle,
        makeInput('cropStart', i18n.t('cropStartLabel'), transform.cropStart, 'auto'),
        makeInput('cropEnd', i18n.t('cropEndLabel'), transform.cropEnd, 'auto'),
    );

    const offsetTitle = document.createElement('div');
    offsetTitle.className = 'file-transform-title';
    offsetTitle.textContent = i18n.t('fileOffsetTitle');
    panel.append(
        offsetTitle,
        makeInput('timeShift', 'Δt', transform.timeShift),
        makeInput('yOffset', 'Δy', transform.yOffset),
    );

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

// ─── Event listeners ───────────────────────────────────────────

}
