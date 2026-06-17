import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';

const LOCAL_API_BASE = '/__omv_local__';

export function installLiveUpdateMethods(TargetClass) {
    const proto = TargetClass.prototype;

proto._initLiveUpdateControls = function() {
    const toggle = document.getElementById('live-update-file');
    const menuBtn = document.getElementById('live-update-menu-btn');
    const menu = document.getElementById('live-update-menu');
    if (!toggle || !menuBtn || !menu) return;

    toggle.addEventListener('click', () => {
        const fileId = this.activeFileId;
        if (!fileId) return;
        this.toggleLiveUpdate(fileId);
    });

    const close = () => {
        menu.hidden = true;
        menuBtn.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
        this._renderLiveUpdateTopBarMenu(menu);
        menu.hidden = false;
        menuBtn.setAttribute('aria-expanded', 'true');
    };

    menuBtn.addEventListener('click', event => {
        event.stopPropagation();
        menu.hidden ? open() : close();
    });
    menu.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', event => {
        if (!menu.hidden && !menu.contains(event.target) && event.target !== menuBtn && !menuBtn.contains(event.target)) close();
    });

    this._updateLiveUpdateTopBar();
};

proto._updateLiveUpdateTopBar = function() {
    const toggle = document.getElementById('live-update-file');
    const menuBtn = document.getElementById('live-update-menu-btn');
    if (!toggle || !menuBtn) return;
    const entry = this.activeFileId ? this.files.get(this.activeFileId) : null;
    const state = this.activeFileId ? this._ensureLiveUpdateState(this.activeFileId) : null;
    const hasCandidate = !!entry && this._isLiveUpdateCandidate(entry);
    toggle.disabled = !hasCandidate;
    menuBtn.disabled = !entry;
    toggle.classList.toggle('active', !!state?.enabled);
    toggle.title = state?.message || (entry ? this._liveUpdateSupportMessage(entry) : i18n.t('liveUpdateTitle'));
};

proto._ensureLiveUpdateState = function(fileId) {
    const entry = this.files.get(fileId);
    if (!entry) return null;
    if (!entry.liveUpdate) {
        entry.liveUpdate = {
            enabled: false,
            intervalSec: 2,
            status: 'idle',
            message: '',
            timer: null,
            lastFingerprint: '',
            lastRows: this._liveUpdateRowCount(fileId),
            localPath: '',
        };
    }
    return entry.liveUpdate;
};

proto._liveUpdateRowCount = function(fileId) {
    const data = this.plotManager.files.get(fileId)?.data;
    const timeName = data?.metadata?.timeName;
    return timeName ? (data.variables?.[timeName]?.data?.length || 0) : 0;
};

proto._isLiveUpdateCandidate = function(entry) {
    const extension = String(entry?.extension || '').toLowerCase();
    return extension === '.csv' || extension === '.txt' || extension === '';
};

proto._liveUpdateHasReadableSource = function(entry) {
    return !!entry?.fileHandle?.getFile || !!entry?.liveUpdate?.localPath;
};

proto.toggleLiveUpdate = async function(fileId) {
    const entry = this.files.get(fileId);
    if (!entry) return;
    const state = this._ensureLiveUpdateState(fileId);
    if (state.enabled) {
        this._stopLiveUpdate(fileId, 'idle', i18n.t('liveUpdatePaused'));
        return;
    }
    await this._startLiveUpdate(fileId);
};

proto._startLiveUpdate = async function(fileId) {
    const entry = this.files.get(fileId);
    const state = this._ensureLiveUpdateState(fileId);
    if (!entry || !state) return;

    if (!this._isLiveUpdateCandidate(entry)) {
        await Modal.alert(i18n.t('liveUpdateTitle'), i18n.t('liveUpdateCsvOnly'), { icon: 'LIVE' });
        return;
    }

    if (!this._liveUpdateHasReadableSource(entry)) {
        if (!await this._canUseLocalLiveApi()) {
            await Modal.alert(i18n.t('liveUpdateTitle'), i18n.t('liveUpdateNeedsLauncher'), { icon: 'LIVE' });
            return;
        }
        const path = await this._promptLiveUpdatePath(entry, state.localPath || '');
        if (!path) return;
        state.localPath = path;
    }

    state.enabled = true;
    state.status = 'polling';
    state.message = i18n.t('liveUpdatePolling');
    state.lastRows = this._liveUpdateRowCount(fileId);
    state.lastFingerprint = this._fileFingerprint(entry.file);
    this._renderFilesList();
    this._updateLiveUpdateTopBar();
    await this._pollLiveUpdate(fileId);
};

proto._stopLiveUpdate = function(fileId, status = 'idle', message = '') {
    const entry = this.files.get(fileId);
    const state = entry?.liveUpdate;
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.enabled = false;
    state.status = status;
    state.message = message;
    this._renderFilesList();
    this._updateLiveUpdateTopBar();
};

proto._scheduleLiveUpdate = function(fileId) {
    const state = this.files.get(fileId)?.liveUpdate;
    if (!state?.enabled) return;
    if (state.timer) clearTimeout(state.timer);
    const delay = Math.max(0.5, Number(state.intervalSec) || 2) * 1000;
    state.timer = setTimeout(() => this._pollLiveUpdate(fileId), delay);
};

proto._pollLiveUpdate = async function(fileId) {
    const entry = this.files.get(fileId);
    const state = entry?.liveUpdate;
    if (!entry || !state?.enabled) return;

    try {
        state.status = 'polling';
        state.message = i18n.t('liveUpdatePolling');
        this._renderFilesList();

        const latestFile = await this._readLiveUpdateFile(entry);
        const fingerprint = this._fileFingerprint(latestFile);
        if (fingerprint && fingerprint === state.lastFingerprint) {
            state.status = 'ok';
            state.message = i18n.t('liveUpdateNoChanges');
            return;
        }

        const previousData = this.plotManager.files.get(fileId)?.data;
        const nextData = await this._parseResultBuffer(this._fileDisplayName(entry), null, latestFile);
        const outcome = this._validateLiveUpdateData(previousData, nextData);
        if (outcome.action === 'unchanged') {
            state.status = 'ok';
            state.message = i18n.t('liveUpdateNoNewRows');
            state.lastFingerprint = fingerprint;
            return;
        }
        if (outcome.action !== 'append') {
            throw new Error(outcome.message || i18n.t('liveUpdateSchemaChanged'));
        }

        entry.file = latestFile;
        entry.extension = this._fileExtension(latestFile.name || this._fileDisplayName(entry));
        entry.contentHash = fingerprint;
        state.lastFingerprint = fingerprint;
        state.lastRows = outcome.nextRows;

        this._reapplyDerivedVariables(fileId, nextData);
        this._reapplyDataToolVariables?.(fileId, nextData);
        this.plotManager.updateFileData(fileId, nextData, { liveAppend: true });

        if (fileId === this.activeFileId) {
            this._clearVariableSelection();
            this.renderVariablesTree(nextData.tree);
        }
        state.status = 'ok';
        state.message = i18n.t('liveUpdateRowsAdded').replace('{count}', String(outcome.addedRows));
    } catch (err) {
        console.error('Live update failed:', err);
        state.status = 'error';
        state.message = err?.message || String(err);
        state.enabled = false;
    } finally {
        this._renderFilesList();
        this._updateLiveUpdateTopBar();
        this._scheduleLiveUpdate(fileId);
    }
};

proto._readLiveUpdateFile = async function(entry) {
    if (entry.fileHandle?.getFile) {
        return entry.fileHandle.getFile();
    }
    const path = entry.liveUpdate?.localPath;
    if (!path) throw new Error(i18n.t('liveUpdateNoSource'));

    const url = `${LOCAL_API_BASE}/file?path=${encodeURIComponent(path)}`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(detail || i18n.t('liveUpdateLocalServerUnavailable'));
    }
    if (!response.headers.get('x-omv-last-modified')) {
        throw new Error(i18n.t('liveUpdateLocalServerUnavailable'));
    }
    const blob = await response.blob();
    const name = path.split(/[\\/]/).filter(Boolean).pop() || this._fileDisplayName(entry);
    const lastModified = Number(response.headers.get('x-omv-last-modified')) || Date.now();
    return new File([blob], name, { lastModified, type: response.headers.get('content-type') || 'text/csv' });
};

proto._canUseLocalLiveApi = async function() {
    try {
        const response = await fetch(`${LOCAL_API_BASE}/status`, { cache: 'no-store' });
        if (!response.ok) return false;
        const status = await response.json();
        return status?.ok === true && status?.app === 'openmodelica-viewer';
    } catch {
        return false;
    }
};

proto._validateLiveUpdateData = function(previousData, nextData) {
    const previousTimeName = previousData?.metadata?.timeName;
    const nextTimeName = nextData?.metadata?.timeName;
    const previousTime = previousTimeName ? previousData.variables?.[previousTimeName]?.data : null;
    const nextTime = nextTimeName ? nextData.variables?.[nextTimeName]?.data : null;
    if (!previousTime?.length || !nextTime?.length) {
        return { action: 'error', message: i18n.t('liveUpdateInvalidData') };
    }
    if (nextTime.length < previousTime.length) {
        return { action: 'error', message: i18n.t('liveUpdateFileShrank') };
    }
    if (nextTime.length === previousTime.length) {
        return { action: 'unchanged' };
    }

    const previousNames = Object.values(previousData.variables || {})
        .filter(variable => variable.source !== 'derived' && variable.source !== 'data-tool')
        .map(variable => variable.name)
        .sort();
    const nextNames = Object.values(nextData.variables || {})
        .map(variable => variable.name)
        .sort();
    if (previousNames.join('\n') !== nextNames.join('\n')) {
        return { action: 'error', message: i18n.t('liveUpdateSchemaChanged') };
    }

    const oldLast = Number(previousTime[previousTime.length - 1]);
    const newLast = Number(nextTime[nextTime.length - 1]);
    if (Number.isFinite(oldLast) && Number.isFinite(newLast) && newLast < oldLast) {
        return { action: 'error', message: i18n.t('liveUpdateTimeWentBack') };
    }

    return {
        action: 'append',
        previousRows: previousTime.length,
        nextRows: nextTime.length,
        addedRows: nextTime.length - previousTime.length,
    };
};

proto._promptLiveUpdatePath = function(entry, initialValue = '') {
    return new Promise(resolve => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        const modal = document.createElement('div');
        modal.className = 'modal-dialog';
        const content = document.createElement('div');
        content.className = 'modal-content';

        const title = document.createElement('div');
        title.className = 'modal-title';
        title.textContent = i18n.t('liveUpdatePathTitle');

        const message = document.createElement('div');
        message.className = 'modal-message';
        message.textContent = i18n.t('liveUpdatePathBody').replace('{file}', this._fileDisplayName(entry));

        const input = document.createElement('input');
        input.className = 'live-update-path-input';
        input.type = 'text';
        input.value = initialValue;
        input.placeholder = i18n.t('liveUpdatePathPlaceholder');

        const buttons = document.createElement('div');
        buttons.className = 'modal-buttons';
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'modal-btn modal-btn-cancel';
        cancelBtn.textContent = i18n.t('cancel');
        const okBtn = document.createElement('button');
        okBtn.className = 'modal-btn modal-btn-confirm';
        okBtn.textContent = i18n.t('liveUpdateUsePath');

        const finish = value => {
            Modal.close(overlay);
            resolve(value);
        };
        cancelBtn.addEventListener('click', () => finish(''));
        okBtn.addEventListener('click', () => finish(input.value.trim()));
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter') finish(input.value.trim());
            if (event.key === 'Escape') finish('');
        });

        buttons.append(cancelBtn, okBtn);
        content.append(title, message, input, buttons);
        modal.appendChild(content);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('show'));
        setTimeout(() => input.focus(), 60);
    });
};

proto._renderLiveUpdateTopBarMenu = function(menu) {
    menu.innerHTML = '';
    const fileId = this.activeFileId;
    const entry = fileId ? this.files.get(fileId) : null;
    const state = fileId ? this._ensureLiveUpdateState(fileId) : null;

    const addStatic = (label, className = '') => {
        const row = document.createElement('div');
        row.className = `example-menu-item-row live-update-menu-row ${className}`.trim();
        const text = document.createElement('span');
        text.className = 'example-name';
        text.textContent = label;
        row.appendChild(text);
        menu.appendChild(row);
        return row;
    };
    const addHeading = label => {
        const row = addStatic(label, 'live-update-menu-heading');
        return row;
    };
    const addAction = (label, active, handler) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'example-menu-item live-update-menu-action' + (active ? ' active' : '');
        const name = document.createElement('span');
        name.className = 'example-name';
        name.textContent = label;
        item.appendChild(name);
        item.addEventListener('click', () => {
            handler();
            this._renderLiveUpdateTopBarMenu(menu);
            this._updateLiveUpdateTopBar();
        });
        menu.appendChild(item);
    };

    addHeading(i18n.t('liveUpdateTitle'));
    if (!entry) {
        addStatic(i18n.t('liveUpdateNoActiveFile'), 'disabled');
    } else {
        addStatic(this._fileDisplayName(entry));
        const canLive = this._isLiveUpdateCandidate(entry);
        addAction(state?.enabled ? i18n.t('liveUpdateStop') : i18n.t('liveUpdateStart'), !!state?.enabled, () => this.toggleLiveUpdate(fileId));
        if (!canLive) {
            addStatic(i18n.t('liveUpdateCsvOnlyShort'), 'disabled');
        }

        const intervalRow = addStatic(i18n.t('liveUpdateEvery'), 'live-update-menu-interval');
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0.5';
        input.step = '0.5';
        input.value = String(state?.intervalSec || 2);
        input.disabled = !canLive;
        input.addEventListener('change', () => {
            state.intervalSec = Math.max(0.5, Number(input.value) || 2);
            input.value = String(state.intervalSec);
            this._scheduleLiveUpdate(fileId);
        });
        intervalRow.appendChild(input);

        const source = state?.message || this._liveUpdateSupportMessage(entry);
        addStatic(source, `live-update-menu-status ${state?.status || 'idle'}`);
    }

    const tsPolicy = this.plotManager._normalizeLiveViewPolicy({
        mode: 'timeseries',
        liveView: this.plotManager.liveViewDefaults?.timeseries,
    });
    addHeading(i18n.t('liveViewX'));
    addAction(i18n.t('liveViewAutoscale'), tsPolicy.xMode === 'autoscale', () => this.plotManager.setGlobalLiveViewPolicy('timeseries', { xMode: 'autoscale' }));
    addAction(i18n.t('liveViewPinStart'), tsPolicy.xMode === 'pin-start', () => this.plotManager.setGlobalLiveViewPolicy('timeseries', { xMode: 'pin-start' }));
    addAction(`${i18n.t('liveViewSliding')} - ${i18n.t('liveViewCurrentZoom')}`, false, () => this._setGlobalLiveWindowFromCurrentZoom());
    [
        [10, i18n.t('liveView10s')],
        [30, i18n.t('liveView30s')],
        [60, i18n.t('liveView1m')],
        [600, i18n.t('liveView10m')],
    ].forEach(([seconds, label]) => {
        addAction(`${i18n.t('liveViewSliding')} - ${label}`,
            tsPolicy.xMode === 'sliding' && Number(tsPolicy.windowSeconds) === seconds,
            () => this.plotManager.setGlobalLiveViewPolicy('timeseries', { xMode: 'sliding', windowSeconds: seconds }));
    });

    addHeading(i18n.t('liveViewY'));
    addAction(i18n.t('liveViewExpandY'), tsPolicy.yMode === 'expand', () => this.plotManager.setGlobalLiveViewPolicy('timeseries', { yMode: 'expand' }));
    addAction(i18n.t('liveViewAutoscale'), tsPolicy.yMode === 'autoscale', () => this.plotManager.setGlobalLiveViewPolicy('timeseries', { yMode: 'autoscale' }));
    addAction(i18n.t('liveViewKeep'), tsPolicy.yMode === 'keep', () => this.plotManager.setGlobalLiveViewPolicy('timeseries', { yMode: 'keep' }));

    const phasePolicy = this.plotManager._normalizeLiveViewPolicy({
        mode: 'phase2d',
        liveView: this.plotManager.liveViewDefaults?.phase,
    });
    addHeading(i18n.t('liveViewView'));
    addAction(i18n.t('liveViewKeep'), phasePolicy.viewMode !== 'autoscale', () => this.plotManager.setGlobalLiveViewPolicy('phase', { viewMode: 'keep' }));
    addAction(i18n.t('liveViewAutoscale'), phasePolicy.viewMode === 'autoscale', () => this.plotManager.setGlobalLiveViewPolicy('phase', { viewMode: 'autoscale' }));
};

proto._setGlobalLiveWindowFromCurrentZoom = function() {
    for (const [panelId, plot] of this.plotManager.plots) {
        if (plot.mode !== 'timeseries') continue;
        const view = this.plotManager._capturePlotView(plot);
        if (!view?.xRange) continue;
        const start = this.plotManager._coerceAxisValue(view.xRange[0]);
        const end = this.plotManager._coerceAxisValue(view.xRange[1]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const axis = plot.div?._fullLayout?.xaxis;
        const seconds = (end - start) / (axis?.type === 'date' ? 1000 : 1);
        if (Number.isFinite(seconds) && seconds > 0) {
            this.plotManager.setGlobalLiveViewPolicy('timeseries', { xMode: 'sliding', windowSeconds: seconds });
            return true;
        }
    }
    return false;
};

proto._liveUpdateSupportMessage = function(entry) {
    if (!this._isLiveUpdateCandidate(entry)) return i18n.t('liveUpdateCsvOnlyShort');
    if (entry.fileHandle?.getFile) return i18n.t('liveUpdateHandleReady');
    return i18n.t('liveUpdateNeedsPath');
};

}
