import { strFromU8, strToU8, unzipSync, zipSync } from '../../../node_modules/fflate/esm/browser.js';
import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';
import { APP_VERSION, RESULT_FILE_EXTENSIONS } from '../constants.js';

const SESSION_FORMAT = 'openmodelica-viewer-session';
const SESSION_VERSION = 1;

export function installSessionMethods(TargetClass) {
    const proto = TargetClass.prototype;

proto.saveViewSession = async function() {
    if (!this.files.size) {
        await Modal.alert(i18n.t('sessionNoFilesTitle'), i18n.t('sessionNoFilesBody'), { icon: 'JSON' });
        return;
    }

    const session = this._createSessionSnapshot({ includeData: false });
    const json = `${JSON.stringify(session, null, 2)}\n`;
    this._downloadBlob(new Blob([json], { type: 'application/json' }), this._defaultSessionFileName('view', 'json'));
};

proto.saveProjectSession = async function() {
    if (!this.files.size) {
        await Modal.alert(i18n.t('sessionNoFilesTitle'), i18n.t('sessionNoFilesBody'), { icon: 'ZIP' });
        return;
    }

    const session = this._createSessionSnapshot({ includeData: true });
    const zipEntries = {
        'session.json': strToU8(`${JSON.stringify(session, null, 2)}\n`),
    };

    for (const fileMeta of session.files) {
        const entry = this.files.get(fileMeta.id);
        if (!entry?.buffer || !fileMeta.archivePath) continue;
        zipEntries[fileMeta.archivePath] = new Uint8Array(entry.buffer);
    }

    const zipped = zipSync(zipEntries, { level: 6 });
    this._downloadBlob(new Blob([zipped], { type: 'application/zip' }), this._defaultSessionFileName('project', 'zip'));
};

proto.openSessionOrProjectFromUser = function() {
    return new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,.zip';
        input.style.display = 'none';
        document.body.appendChild(input);

        const cleanup = () => input.remove();
        input.addEventListener('change', async () => {
            const file = input.files?.[0] || null;
            cleanup();
            if (!file) { resolve(false); return; }
            try {
                await this.loadSessionOrProjectFile(file);
                resolve(true);
            } catch (err) {
                reject(err);
            }
        }, { once: true });

        input.click();
    });
};

proto.loadSessionOrProjectFile = async function(file) {
    const extension = this._fileExtension(file.name);
    if (extension === '.json') {
        const text = await file.text();
        const session = this._parseSessionJson(text);
        await this._applySessionSnapshot(session, { source: 'view' });
        return;
    }

    if (extension === '.zip') {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const entries = unzipSync(bytes);
        const sessionBytes = entries['session.json'];
        if (!sessionBytes) throw new Error(i18n.t('sessionZipMissing'));
        const session = this._parseSessionJson(strFromU8(sessionBytes));
        await this._loadProjectDataFromZip(session, entries);
        await this._applySessionSnapshot(session, { source: 'project' });
        return;
    }

    throw new Error(i18n.t('sessionUnsupportedFile'));
};

proto._createSessionSnapshot = function(options = {}) {
    const includeData = !!options.includeData;
    const files = [];
    const usedArchiveNames = new Set();

    for (const [fileId, entry] of this.files) {
        const displayName = this._fileDisplayName(entry);
        const archivePath = includeData
            ? `data/${this._uniqueArchiveName(displayName, usedArchiveNames)}`
            : null;
        const data = this.plotManager.files.get(fileId)?.data;
        const csvProfile = data?.metadata?.csvProfile?.profileSource === 'user'
            ? this._cloneSerializable(data.metadata.csvProfile)
            : null;
        const derived = [...(this.derivedByFile.get(fileId) || new Map()).values()]
            .map(item => ({ name: item.name, formula: item.formula }));
        const dataTools = typeof this._serializeDataToolDefinitions === 'function'
            ? this._serializeDataToolDefinitions(fileId)
            : [];

        files.push({
            id: fileId,
            name: entry.name,
            extension: entry.extension,
            displayName,
            contentHash: entry.contentHash || '',
            transform: this._normalizeFileTransform(entry.transform),
            csvProfile,
            variableNames: data ? Object.keys(data.variables || {}) : [],
            derived,
            dataTools,
            archivePath,
        });
    }

    return {
        format: SESSION_FORMAT,
        version: SESSION_VERSION,
        appVersion: APP_VERSION,
        kind: includeData ? 'project' : 'view',
        savedAt: new Date().toISOString(),
        settings: this._captureSessionSettings(),
        files,
        activeFileId: this.activeFileId || null,
        layout: this._cloneSerializable(this.layoutManager.root),
        plots: this._capturePlotSessions(),
    };
};

proto._captureSessionSettings = function() {
    return {
        theme: this.theme,
        language: this.language,
        showDescriptions: !!this.showDescriptions,
        sortAlphabetical: !!this.sortAlphabetical,
        scrollablePlotArea: !!this.scrollablePlotArea,
        mouseWheelZoom: !!this.mouseWheelZoom,
        reloadAsNewVersionMode: !!this.reloadAsNewVersionMode,
        syncAxes: !!this.plotManager.syncAxes,
        syncHover: !!this.plotManager.syncHover,
        hoverInfoCorner: this.plotManager.hoverInfoCorner,
        hoverProximity: !!this.plotManager.hoverProximity,
        legendPosition: this.plotManager.legendPosition,
        legendOverlayCorner: this.plotManager.legendOverlayCorner,
        timeseriesVisualMaxPoints: this.plotManager.timeseriesVisualMaxPoints,
        phaseVisualMaxPoints: this.plotManager.phaseVisualMaxPoints,
    };
};

proto._capturePlotSessions = function() {
    const plots = [];
    for (const [panelId, plot] of this.plotManager.plots) {
        plots.push({
            panelId,
            mode: plot.mode,
            traces: plot.traces.map(t => this._cloneSerializable(t)),
            phaseTraces: plot.phaseTraces.map(t => this._cloneSerializable(t)),
            phasePending: this._cloneSerializable(plot.phasePending),
            stateSlots: this._cloneSerializable(plot.stateSlots),
            stateAnimDim: plot.stateAnimDim || 2,
            stateConfig: this._cloneSerializable(plot.stateConfig),
            fft: this._cloneSerializable(plot.fft || this.plotManager._defaultFftState?.()),
            projection: plot.projection || 'orthographic',
            equalAspect2D: !!plot.equalAspect2D,
            liveView: this._cloneSerializable(plot.liveView || this.plotManager._defaultLiveViewPolicy(plot.mode)),
            cursors: this._cloneSerializable(plot.cursors || this.plotManager._defaultCursors()),
            showCameraOverlay: !!plot.showCameraOverlay,
            homeCamera: this._cloneSerializable(plot.homeCamera),
            animFrame: plot.animFrame || 0,
            animSpeed: plot.animSpeed || 1,
            autoPlayOnRender: false,
            timeseriesStacked: !!plot.timeseriesStacked,
            timeseriesY2Enabled: !!plot.timeseriesY2Enabled,
            view: this.plotManager._capturePlotView(plot),
        });
    }
    return plots;
};

proto._parseSessionJson = function(text) {
    let session;
    try {
        session = JSON.parse(text);
    } catch {
        throw new Error(i18n.t('sessionInvalidFile'));
    }
    if (session?.format !== SESSION_FORMAT || session.version !== SESSION_VERSION) {
        throw new Error(i18n.t('sessionInvalidFile'));
    }
    return session;
};

proto._loadProjectDataFromZip = async function(session, entries) {
    if (this.files.size || this.plotManager.hasAnyTraces()) {
        const ok = await Modal.confirm(i18n.t('sessionProjectReplaceWarning'), { icon: 'ZIP' });
        if (!ok) {
            const err = new Error('Project load cancelled');
            err.name = 'AbortError';
            throw err;
        }
    }

    this._resetWorkspaceForSession();

    for (const fileMeta of session.files || []) {
        if (!fileMeta.archivePath) throw new Error(i18n.t('sessionMissingProjectData').replace('{file}', fileMeta.displayName || fileMeta.name || 'file'));
        const bytes = entries[fileMeta.archivePath];
        if (!bytes) throw new Error(i18n.t('sessionMissingProjectData').replace('{file}', fileMeta.displayName || fileMeta.name || fileMeta.archivePath));
        const file = new File([bytes], fileMeta.displayName || `${fileMeta.name || 'results'}${fileMeta.extension || '.mat'}`);
        await this.loadFile(file);
    }
};

proto._applySessionSnapshot = async function(session, options = {}) {
    const fileMap = this._matchSessionFiles(session);
    const missing = this._missingSessionFiles(session, fileMap);
    if (missing.length) {
        const list = missing
            .map(item => `<li title="${this._escapeSessionHTML(item)}">${this._escapeSessionHTML(item)}</li>`)
            .join('');
        const body = `
            <div class="session-missing-intro">${this._escapeSessionHTML(i18n.t('sessionMissingFilesBody'))}</div>
            <ul class="session-missing-files">${list}</ul>
        `;
        await Modal.alert(i18n.t('sessionMissingFilesTitle'), body, {
            icon: 'JSON',
            html: true,
            className: 'modal-dialog-session-missing',
        });
        return false;
    }

    this._applySessionSettings(session.settings || {});
    await this._applySessionFileMetadata(session, fileMap);
    this._applySessionDerivedVariables(session, fileMap);
    this._applySessionDataToolVariables(session, fileMap);
    this._applySessionLayout(session.layout);
    await this._applySessionPlots(session.plots || [], fileMap);

    const mappedActive = fileMap.get(session.activeFileId);
    if (mappedActive) this.setActiveFile(mappedActive);
    else if (this.files.size) this.setActiveFile([...this.files.keys()][0]);

    this._updateTopBar();
    this._renderFilesList();
    this._updateActionButtons();
    const activeData = this.activeFileId ? this.plotManager.files.get(this.activeFileId)?.data : null;
    if (activeData) this.renderVariablesTree(activeData.tree);
    this._resetDataToolPicker?.();
    document.getElementById('drop-zone')?.classList.toggle('active', this.files.size === 0);

    await Modal.alert(
        i18n.t('sessionAppliedTitle'),
        i18n.t(options.source === 'project' ? 'sessionProjectLoadedBody' : 'sessionViewAppliedBody'),
        { icon: options.source === 'project' ? 'ZIP' : 'JSON' },
    );
    return true;
};

proto._matchSessionFiles = function(session) {
    const result = new Map();
    const usedOpenFiles = new Set();
    const metas = session.files || [];

    for (const meta of metas) {
        const candidates = [...this.files.entries()]
            .filter(([fileId]) => !usedOpenFiles.has(fileId))
            .map(([fileId, entry]) => ({
                fileId,
                score: this._scoreSessionFileMatch(session, meta, fileId, entry),
            }))
            .filter(candidate => candidate.score > 0)
            .sort((a, b) => b.score - a.score);

        if (candidates.length) {
            result.set(meta.id, candidates[0].fileId);
            usedOpenFiles.add(candidates[0].fileId);
        }
    }

    return result;
};

proto._scoreSessionFileMatch = function(session, meta, fileId, entry) {
    const data = this.plotManager.files.get(fileId)?.data;
    if (!data) return 0;
    const displayName = this._fileDisplayName(entry);
    const sameHash = meta.contentHash && entry.contentHash && meta.contentHash === entry.contentHash;
    const sameName = String(meta.displayName || '').toLowerCase() === displayName.toLowerCase()
        || (String(meta.name || '').toLowerCase() === String(entry.name || '').toLowerCase()
            && String(meta.extension || '').toLowerCase() === String(entry.extension || '').toLowerCase());
    const required = this._sessionRequiredVariables(meta.id, session);
    const hasRequired = required.every(name =>
        !!data.variables?.[name]
        || !!(meta.derived || []).some(d => d.name === name)
        || !!(meta.dataTools || []).some(d => (d.targetMode || 'create') !== 'modify' && d.name === name)
    );

    let score = 0;
    if (sameHash) score += 1000;
    if (sameName && (!required.length || hasRequired)) score += 200;
    if (hasRequired) score += 100;
    if (!required.length && sameName) score += 25;

    if (!score) {
        const sessionVars = new Set(meta.variableNames || []);
        if (sessionVars.size) {
            let overlap = 0;
            for (const name of Object.keys(data.variables || {})) {
                if (sessionVars.has(name)) overlap++;
            }
            if (overlap) score += Math.min(50, overlap);
        }
    }

    if (required.length && !hasRequired && !sameHash) return 0;
    return hasRequired || sameHash || sameName ? score : 0;
};

proto._missingSessionFiles = function(session, fileMap) {
    return (session.files || [])
        .filter(meta => !fileMap.has(meta.id))
        .map(meta => {
            const required = this._sessionRequiredVariables(meta.id, session);
            const suffix = required.length ? ` (${required.slice(0, 5).join(', ')}${required.length > 5 ? ', ...' : ''})` : '';
            return `${meta.displayName || `${meta.name || 'results'}${meta.extension || ''}`}${suffix}`;
        });
};

proto._sessionRequiredVariables = function(sessionFileId, session) {
    if (!session) return [];
    const fileMeta = (session.files || []).find(file => file.id === sessionFileId);
    const derivedNames = new Set(fileMeta?.derived?.map(d => d.name) || []);
    const dataToolItems = fileMeta?.dataTools || [];
    const dataToolNames = new Set(dataToolItems
        .filter(item => (item.targetMode || 'create') !== 'modify')
        .map(item => item.name)
        .filter(Boolean));
    const generatedNames = new Set([...derivedNames, ...dataToolNames]);
    const names = new Set();
    for (const plot of session.plots || []) {
        for (const trace of plot.traces || []) {
            if (trace.fileId === sessionFileId && !generatedNames.has(trace.varName)) names.add(trace.varName);
        }
        for (const trace of plot.phaseTraces || []) {
            if (trace.fileId !== sessionFileId) continue;
            [trace.x, trace.y, trace.z].filter(Boolean).forEach(name => {
                if (!generatedNames.has(name)) names.add(name);
            });
        }
        if (plot.stateSlots?.fileId === sessionFileId) {
            (plot.stateSlots.x || []).filter(Boolean).forEach(name => {
                if (!generatedNames.has(name)) names.add(name);
            });
        }
    }
    dataToolItems.forEach(item => {
        if (item?.sourceName && !generatedNames.has(item.sourceName)) names.add(item.sourceName);
    });
    return [...names];
};

proto._applySessionSettings = function(settings) {
    if (settings.language) this.setLanguage(settings.language);
    if (settings.theme) this.applyTheme(settings.theme);
    this.showDescriptions = !!settings.showDescriptions;
    this.sortAlphabetical = settings.sortAlphabetical !== false;
    this.reloadAsNewVersionMode = !!settings.reloadAsNewVersionMode;
    this.plotManager.setSyncAxes(settings.syncAxes !== false);
    this.plotManager.setSyncHover(!!settings.syncHover);
    this.plotManager.setHoverInfoCorner(settings.hoverInfoCorner || 'bl');
    this.plotManager.setHoverProximity(settings.hoverProximity !== false);
    this.plotManager.setLegendPosition(settings.legendPosition || 'overlay');
    this.plotManager.setLegendOverlayCorner(settings.legendOverlayCorner || 'tl');
    this.plotManager.setMouseWheelZoom(settings.mouseWheelZoom !== false);
    this.plotManager.setTimeseriesDownsamplingLimit(settings.timeseriesVisualMaxPoints ?? this.plotManager.timeseriesVisualMaxPoints);
    this.plotManager.setPhaseDownsamplingLimit(settings.phaseVisualMaxPoints ?? this.plotManager.phaseVisualMaxPoints);
    this.scrollablePlotArea = !!settings.scrollablePlotArea;
    this.layoutManager.setScrollablePlotArea(this.scrollablePlotArea);
    this._syncScrollablePlotAreaUI();
    this._syncHoverCornerPicker?.();
};

proto._applySessionFileMetadata = async function(session, fileMap) {
    const skippedProfiles = [];
    for (const meta of session.files || []) {
        const fileId = fileMap.get(meta.id);
        const entry = fileId ? this.files.get(fileId) : null;
        if (!entry) continue;
        entry.transform = this._normalizeFileTransform(meta.transform);
        this.plotManager.setFileTransform(fileId, entry.transform);
        if (meta.csvProfile?.profileSource !== 'user') continue;

        const currentHash = entry.contentHash || '';
        if (meta.contentHash && currentHash && meta.contentHash !== currentHash) {
            skippedProfiles.push(meta.displayName || `${meta.name || 'results'}${meta.extension || ''}`);
            continue;
        }

        try {
            const displayName = this._fileDisplayName(entry);
            const streamable = this._canParseFromFile?.(entry.file, entry.extension);
            const latestFile = streamable ? await this._readLatestFileForStreamableReload(entry) : null;
            const buffer = streamable ? null : await this._readLatestBuffer(entry);
            const contentHash = buffer
                ? await this._hashBuffer(buffer)
                : this._fileFingerprint(latestFile || entry.file);
            const data = await this._parseCsvResultBuffer(displayName, buffer, latestFile || entry.file, {
                csvProfile: meta.csvProfile,
            });
            entry.buffer = buffer;
            entry.contentHash = contentHash;
            this.plotManager.updateFileData(fileId, data);
        } catch (err) {
            console.warn('[session] could not restore CSV parsing profile:', err?.message || err);
            skippedProfiles.push(meta.displayName || `${meta.name || 'results'}${meta.extension || ''}`);
        }
    }
    if (skippedProfiles.length) {
        await Modal.alert(
            i18n.t('csvProfileRestoreSkippedTitle'),
            i18n.t('csvProfileRestoreSkippedBody').replace('{files}', skippedProfiles.join(', ')),
            { icon: 'CSV' },
        );
    }
};

proto._applySessionDerivedVariables = function(session, fileMap) {
    for (const meta of session.files || []) {
        const fileId = fileMap.get(meta.id);
        const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
        if (!fileId || !data) continue;
        const definitions = new Map();
        for (const item of meta.derived || []) {
            definitions.set(item.name, { name: item.name, formula: item.formula, variable: null });
        }
        if (definitions.size) {
            this.derivedByFile.set(fileId, definitions);
            this._reapplyDerivedVariables(fileId, data);
        } else {
            this.derivedByFile.delete(fileId);
        }
    }
};

proto._applySessionDataToolVariables = function(session, fileMap) {
    for (const meta of session.files || []) {
        const fileId = fileMap.get(meta.id);
        const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
        if (!fileId || !data) continue;
        const definitions = new Map();
        for (const item of meta.dataTools || []) {
            definitions.set(item.name, {
                name: item.name,
                tool: item.tool,
                targetMode: item.targetMode || 'create',
                sourceName: item.sourceName,
                method: item.method,
                params: this._cloneSerializable(item.params || {}),
                replacement: item.replacement || 'nan',
                steps: Array.isArray(item.steps) ? this._cloneSerializable(item.steps) : undefined,
                variable: null,
            });
        }
        if (definitions.size) {
            this.dataToolVariablesByFile.set(fileId, definitions);
            this._reapplyDataToolVariables?.(fileId, data);
        } else {
            this.dataToolVariablesByFile.delete(fileId);
        }
    }
};

proto._applySessionLayout = function(layout) {
    if (!layout) return;
    if (this.layoutManager.onPanelUnmount) {
        this.layoutManager._collectPanelIds(this.layoutManager.root).forEach(id => this.layoutManager.onPanelUnmount(id));
    }
    this.layoutManager.root = this._cloneSerializable(layout);
    this.layoutManager.render();
};

proto._applySessionPlots = async function(plotSessions, fileMap) {
    await new Promise(resolve => setTimeout(resolve, 0));
    for (const saved of plotSessions) {
        const plot = this.plotManager.plots.get(saved.panelId);
        if (!plot) continue;

        this.plotManager._stopAnim(plot);
        plot.mode = saved.mode || 'timeseries';
        plot.traces = (saved.traces || [])
            .map(trace => ({ ...trace, fileId: fileMap.get(trace.fileId) }))
            .filter(trace => trace.fileId && this._sessionTraceExists(trace));
        plot.phaseTraces = (saved.phaseTraces || [])
            .map(trace => ({ ...trace, fileId: fileMap.get(trace.fileId) }))
            .filter(trace => trace.fileId && this._sessionPhaseTraceExists(trace));
        plot.phasePending = { x: null, y: null, z: null, fileId: null };
        plot.stateAnimDim = saved.stateAnimDim || 2;
        plot.stateConfig = { ...plot.stateConfig, ...(saved.stateConfig || {}) };
        plot.fft = this.plotManager._normalizeFftState
            ? this.plotManager._normalizeFftState(saved.fft || plot.fft)
            : this._cloneSerializable(saved.fft || plot.fft);
        plot.projection = saved.projection || 'orthographic';
        plot.equalAspect2D = !!saved.equalAspect2D;
        plot.liveView = this._cloneSerializable(saved.liveView || this.plotManager._defaultLiveViewPolicy(plot.mode));
        plot.cursors = this._cloneSerializable(saved.cursors || this.plotManager._defaultCursors());
        plot.showCameraOverlay = !!saved.showCameraOverlay;
        plot.homeCamera = this._cloneSerializable(saved.homeCamera);
        plot.animFrame = saved.animFrame || 0;
        plot.animSpeed = saved.animSpeed || 1;
        plot.autoPlayOnRender = false;
        plot.timeseriesStacked = !!saved.timeseriesStacked && !saved.timeseriesY2Enabled;
        plot.timeseriesY2Enabled = !!saved.timeseriesY2Enabled;
        if (!plot.timeseriesY2Enabled) plot.traces.forEach(trace => { trace.axis = 'y'; });
        plot.stateSlots = this._mappedStateSlots(saved.stateSlots, fileMap);

        if (saved.view) plot._pendingViewRestore = this._cloneSerializable(saved.view);
        this.plotManager._rebuildPanel(saved.panelId);
    }
};

proto._sessionTraceExists = function(trace) {
    return !!this.plotManager.files.get(trace.fileId)?.data?.variables?.[trace.varName];
};

proto._sessionPhaseTraceExists = function(trace) {
    const variables = this.plotManager.files.get(trace.fileId)?.data?.variables || {};
    return !!variables[trace.x] && !!variables[trace.y] && (!trace.z || !!variables[trace.z]);
};

proto._mappedStateSlots = function(slots, fileMap) {
    const fileId = fileMap.get(slots?.fileId);
    const variables = fileId ? this.plotManager.files.get(fileId)?.data?.variables || {} : {};
    const x = (slots?.x || []).filter(name => !!variables[name]);
    const dx = (slots?.dx || []).filter(name => !!variables[name]);
    return { x, dx, fileId: fileId || null };
};

proto._resetWorkspaceForSession = function() {
    if (this.layoutManager.onPanelUnmount) {
        this.layoutManager._collectPanelIds(this.layoutManager.root).forEach(id => this.layoutManager.onPanelUnmount(id));
    }
    this.files.clear();
    this.plotManager.files.clear();
    this.plotManager.plots.clear();
    this.plotManager.activeFileId = null;
    this.derivedByFile.clear();
    this._clearDataToolDefinitions?.();
    this._expandedFileTransforms.clear();
    this._clearVariableSelection();
    this.layoutManager.reset();
};

proto._downloadBlob = function(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

proto._defaultSessionFileName = function(kind, extension) {
    const base = this.activeFileId
        ? this._fileBaseName(this._fileDisplayName(this.files.get(this.activeFileId)))
        : 'timeseries-explorer';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    return `${this._safeFileName(base)}-${kind}-${stamp}.${extension}`;
};

proto._uniqueArchiveName = function(filename, used) {
    const safe = this._safeFileName(filename);
    let candidate = safe;
    let index = 2;
    while (used.has(candidate.toLowerCase())) {
        const ext = this._fileExtension(safe);
        const stem = ext ? safe.slice(0, -ext.length) : safe;
        candidate = `${stem}-${index}${ext}`;
        index++;
    }
    used.add(candidate.toLowerCase());
    return candidate;
};

proto._safeFileName = function(value) {
    const clean = String(value || 'session')
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
        .replace(/\s+/g, '_')
        .replace(/^_+|_+$/g, '');
    return clean || 'session';
};

proto._cloneSerializable = function(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
};

proto._escapeSessionHTML = function(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[ch]));
};

proto._isSupportedSessionFileName = function(filename) {
    const extension = this._fileExtension(filename);
    return extension === '.json' || extension === '.zip' || RESULT_FILE_EXTENSIONS.includes(extension);
};

}
