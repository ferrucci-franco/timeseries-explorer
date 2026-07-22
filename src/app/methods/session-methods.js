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
        return false;
    }

    const lazyFiles = [];
    for (const [fileId, entry] of this.files) {
        if (this.plotManager.files.get(fileId)?.data?._duckdb) {
            lazyFiles.push(this._fileDisplayName(entry));
        }
    }
    if (lazyFiles.length) {
        const list = lazyFiles
            .map(name => `<li title="${this._escapeSessionHTML(name)}">${this._escapeSessionHTML(name)}</li>`)
            .join('');
        const body = `
            <div class="session-missing-intro">${this._escapeSessionHTML(i18n.t('sessionProjectLazyFilesBody'))}</div>
            <ul class="session-missing-files">${list}</ul>
        `;
        await Modal.alert(i18n.t('sessionProjectLazyFilesTitle'), body, {
            icon: 'ZIP',
            html: true,
            className: 'modal-dialog-session-missing',
        });
        return false;
    }

    const session = this._createSessionSnapshot({ includeData: true });
    const zipEntries = {
        'session.json': strToU8(`${JSON.stringify(session, null, 2)}\n`),
    };

    try {
        for (const fileMeta of session.files) {
            const entry = this.files.get(fileMeta.id);
            if (!entry || !fileMeta.archivePath) throw new Error(fileMeta.displayName || fileMeta.name || 'file');
            zipEntries[fileMeta.archivePath] = await this._readProjectEntryBytes(entry);
        }
    } catch (err) {
        const fileName = err?.projectFileName || err?.message || i18n.t('file');
        await Modal.alert(
            i18n.t('sessionProjectReadFailedTitle'),
            i18n.t('sessionProjectReadFailedBody').replace('{file}', fileName),
            { icon: 'ZIP', className: 'modal-dialog-session-missing' },
        );
        return false;
    }

    const zipped = zipSync(zipEntries, { level: 6 });
    this._downloadBlob(new Blob([zipped], { type: 'application/zip' }), this._defaultSessionFileName('project', 'zip'));
    return true;
};

proto._readProjectEntryBytes = async function(entry) {
    const toBytes = value => {
        if (value instanceof ArrayBuffer) return new Uint8Array(value);
        if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        return null;
    };

    try {
        if (entry?.liveUpdate?.hasAppliedAppend) {
            const file = await this._readLiveUpdateFile(entry);
            const parsedEnd = Number(entry.liveUpdate.lastParsedOffset);
            if (!Number.isFinite(parsedEnd) || parsedEnd <= 0 || Number(file?.size) < parsedEnd) {
                throw new Error('Live Update source no longer matches the displayed data');
            }
            const visibleFile = typeof file.slice === 'function' ? file.slice(0, parsedEnd) : file;
            const liveBytes = toBytes(await (visibleFile.arrayBuffer
                ? visibleFile.arrayBuffer()
                : this._readAsArrayBuffer(visibleFile)));
            if (!liveBytes) throw new Error('Could not read Live Update source');
            return liveBytes;
        }

        let bytes = toBytes(entry?.buffer);
        if (!bytes && entry?.file?.arrayBuffer) bytes = toBytes(await entry.file.arrayBuffer());
        if (!bytes) bytes = toBytes(await this._readLatestBuffer(entry));
        if (bytes) return bytes;
    } catch (err) {
        const wrapped = new Error(this._fileDisplayName(entry));
        wrapped.projectFileName = this._fileDisplayName(entry);
        wrapped.cause = err;
        throw wrapped;
    }
    const error = new Error(this._fileDisplayName(entry));
    error.projectFileName = this._fileDisplayName(entry);
    throw error;
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
                const loaded = await this.loadSessionOrProjectFile(file);
                resolve(loaded !== false);
            } catch (err) {
                reject(err);
            }
        }, { once: true });

        input.click();
    });
};

proto.loadSessionOrProjectFile = async function(file, options = {}) {
    const extension = this._fileExtension(file.name);
    if (extension === '.json') {
        const text = await file.text();
        const session = this._parseSessionJson(text);
        const previousSession = this._createSessionSnapshot({ includeData: false });
        try {
            return await this._applySessionSnapshot(session, { source: 'view' });
        } catch (err) {
            const previousMap = new Map((previousSession.files || []).map(meta => [meta.id, meta.id]));
            await this._applySessionSnapshot(previousSession, {
                source: 'view',
                fileMap: previousMap,
                silent: true,
            });
            throw err;
        }
    }

    if (extension === '.zip') {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const entries = unzipSync(bytes);
        const sessionBytes = entries['session.json'];
        if (!sessionBytes) throw new Error(i18n.t('sessionZipMissing'));
        const session = this._parseSessionJson(strFromU8(sessionBytes));
        const transaction = await this._loadProjectDataFromZip(session, entries, options);
        try {
            const applied = await this._applySessionSnapshot(session, {
                source: 'project',
                fileMap: transaction.fileMap,
                silent: !!options.silent,
                preserveTheme: !!options.preserveTheme,
            });
            if (!applied) {
                await this._rollbackProjectTransaction(transaction);
                return false;
            }
            await this._finalizeProjectTransaction(transaction);
        } catch (err) {
            await this._rollbackProjectTransaction(transaction);
            throw err;
        }
        return true;
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
        const invertedVariables = [...(this.plotManager.files.get(fileId)?.invertedVariables || [])];

        files.push({
            id: fileId,
            name: entry.name,
            extension: entry.extension,
            displayName,
            contentHash: entry.contentHash || '',
            transform: this._normalizeFileTransform(entry.transform),
            csvProfile,
            excel: entry.excel ? this._cloneSerializable(entry.excel) : null,
            matlab: entry.matlab ? this._cloneSerializable(entry.matlab) : null,
            variableNames: data ? Object.keys(data.variables || {}) : [],
            derived,
            dataTools,
            invertedVariables,
            transformPanelExpanded: !!this._expandedFileTransforms?.has(fileId),
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
    const sidebar = typeof document !== 'undefined' ? document.getElementById('sidebar') : null;
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
        liveViewDefaults: this._cloneSerializable(this.plotManager.liveViewDefaults || {}),
        advancedSettings: this._cloneSerializable(this.advancedSettings || {}),
        variableFilterText: this._filterText || '',
        sidebarHidden: !!sidebar?.classList.contains('hidden'),
        sidebarWidth: sidebar?.style.width || '',
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
            histogram: this._cloneSerializable(plot.histogram || this.plotManager._defaultHistogramState?.()),
            heatmap: this._cloneSerializable(plot.heatmap || this.plotManager._defaultCalendarHeatmapState?.()),
            temporalProfile: this._cloneSerializable(plot.temporalProfile || this.plotManager._defaultTemporalProfileState?.()),
            correlation: this._cloneSerializable(plot.correlation || this.plotManager._defaultCorrelationState?.()),
            phase2d: this._cloneSerializable(plot.phase2d || this.plotManager._defaultPhase2dState?.()),
            projection: plot.projection || 'orthographic',
            equalAspect2D: !!plot.equalAspect2D,
            liveView: this._cloneSerializable(plot.liveView || this.plotManager._defaultLiveViewPolicy(plot.mode)),
            cursors: this._cloneSerializable(plot.cursors || this.plotManager._defaultCursors()),
            cursorsSpectrum: this._cloneSerializable(plot.cursorsSpectrum || this.plotManager._defaultCursors()),
            showCameraOverlay: !!plot.showCameraOverlay,
            homeCamera: this._cloneSerializable(plot.homeCamera),
            animFrame: plot.animFrame || 0,
            animSpeed: plot.animSpeed || 1,
            animPlaying: !!plot.animPlaying,
            timeseriesStacked: !!plot.timeseriesStacked,
            timeseriesY2Enabled: !!plot.timeseriesY2Enabled,
            showMissingData: !!plot.showMissingData,
            modeViews: this._cloneSerializable(plot._modeViews || {}),
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

proto._loadProjectDataFromZip = async function(session, entries, options = {}) {
    for (const fileMeta of session.files || []) {
        if (!fileMeta.archivePath) throw new Error(i18n.t('sessionMissingProjectData').replace('{file}', fileMeta.displayName || fileMeta.name || 'file'));
        if (!entries[fileMeta.archivePath]) throw new Error(i18n.t('sessionMissingProjectData').replace('{file}', fileMeta.displayName || fileMeta.name || fileMeta.archivePath));
    }

    if (!options.replaceConfirmed && (this.files.size || this.plotManager.hasAnyTraces())) {
        const ok = await Modal.confirm(i18n.t('sessionProjectReplaceWarning'), { icon: 'ZIP' });
        if (!ok) {
            const err = new Error('Project load cancelled');
            err.name = 'AbortError';
            throw err;
        }
    }

    const previousActiveFileId = this.activeFileId;
    const previousSession = this._createSessionSnapshot({ includeData: false });
    const previousFiles = [...this.files.entries()];
    const previousPlotFiles = [...this.plotManager.files.entries()];
    const previousDerivedByFile = [...this.derivedByFile.entries()];
    const previousDataToolsByFile = [...(this.dataToolVariablesByFile || new Map()).entries()];
    const previousAdvancedSettings = this._cloneSerializable(this.advancedSettings || {});
    if (session.settings?.advancedSettings && this._normalizeAdvancedSettings) {
        this.advancedSettings = this._normalizeAdvancedSettings(session.settings.advancedSettings);
    }

    const stagedIds = [];
    const fileMap = new Map();
    try {
        for (const fileMeta of session.files || []) {
            const bytes = entries[fileMeta.archivePath];
            const file = new File([bytes], fileMeta.displayName || `${fileMeta.name || 'results'}${fileMeta.extension || '.mat'}`);
            // The archived bytes of an Excel entry are the raw workbook; restore
            // the recorded sheet directly so the sheet picker never re-appears.
            const result = await this.loadFile(file, {
                excelSheetName: fileMeta.excel?.sheetName || null,
                matSelection: fileMeta.matlab || null,
                deferUi: true,
                deferPlotRebuild: true,
                throwOnError: true,
            });
            if (!result?.fileId) throw new Error(i18n.t('sessionMissingProjectData').replace('{file}', file.name));
            stagedIds.push(result.fileId);
            fileMap.set(fileMeta.id, result.fileId);
        }
    } catch (err) {
        await this._discardStagedProjectFiles(stagedIds, previousActiveFileId);
        this.advancedSettings = previousAdvancedSettings;
        this.plotManager.setRelayoutRefreshMode?.(previousAdvancedSettings.panZoomRefreshMode || 'auto');
        throw err;
    }

    await this._commitStagedProjectFiles(stagedIds);
    return {
        fileMap,
        stagedIds,
        previousSession,
        previousFiles,
        previousPlotFiles,
        previousDerivedByFile,
        previousDataToolsByFile,
        previousActiveFileId,
        previousAdvancedSettings,
    };
};

proto._discardStagedProjectFiles = async function(stagedIds, previousActiveFileId = null) {
    for (const fileId of stagedIds || []) {
        const data = this.plotManager.files.get(fileId)?.data;
        try { await data?._duckdb?.source?.release?.(data); } catch (_) {}
        this.files.delete(fileId);
        this.plotManager.files.delete(fileId);
    }
    this.plotManager.activeFileId = previousActiveFileId && this.files.has(previousActiveFileId)
        ? previousActiveFileId
        : (this.files.keys().next().value || null);
};

proto._commitStagedProjectFiles = async function(stagedIds) {
    const stagedSet = new Set(stagedIds || []);
    const stagedFiles = [...stagedSet].map(fileId => [fileId, this.files.get(fileId)]);
    const stagedPlotFiles = [...stagedSet].map(fileId => [fileId, this.plotManager.files.get(fileId)]);

    this._resetWorkspaceForSession();
    for (const [fileId, entry] of stagedFiles) if (entry) this.files.set(fileId, entry);
    for (const [fileId, entry] of stagedPlotFiles) if (entry) this.plotManager.files.set(fileId, entry);
    this.plotManager.activeFileId = stagedIds?.[0] || null;
};

proto._finalizeProjectTransaction = async function(transaction) {
    for (const [, plotEntry] of transaction?.previousPlotFiles || []) {
        try { await plotEntry?.data?._duckdb?.source?.release?.(plotEntry.data); } catch (_) {}
    }
};

proto._rollbackProjectTransaction = async function(transaction) {
    for (const [, plotEntry] of this.plotManager.files) {
        try { await plotEntry?.data?._duckdb?.source?.release?.(plotEntry.data); } catch (_) {}
    }
    this._resetWorkspaceForSession();
    for (const [fileId, entry] of transaction?.previousFiles || []) this.files.set(fileId, entry);
    for (const [fileId, entry] of transaction?.previousPlotFiles || []) this.plotManager.files.set(fileId, entry);
    for (const [fileId, definitions] of transaction?.previousDerivedByFile || []) this.derivedByFile.set(fileId, definitions);
    for (const [fileId, definitions] of transaction?.previousDataToolsByFile || []) this.dataToolVariablesByFile.set(fileId, definitions);
    this.plotManager.activeFileId = transaction?.previousActiveFileId || null;
    this.advancedSettings = this._cloneSerializable(transaction?.previousAdvancedSettings || {});
    const previousMap = new Map((transaction?.previousSession?.files || []).map(meta => [meta.id, meta.id]));
    await this._applySessionSnapshot(transaction.previousSession, {
        source: 'view',
        fileMap: previousMap,
        silent: true,
    });
};

proto._applySessionSnapshot = async function(session, options = {}) {
    const fileMap = options.fileMap instanceof Map ? options.fileMap : this._matchSessionFiles(session);
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

    const settings = options.preserveTheme
        ? { ...(session.settings || {}), theme: this.theme }
        : (session.settings || {});
    this._applySessionSettings(settings);
    this._clearGeneratedVariablesForSession(fileMap);
    await this._applySessionFileMetadata(session, fileMap, { projectData: options.source === 'project' });
    this._applySessionDerivedVariables(session, fileMap, { defer: true });
    this._applySessionDataToolVariables(session, fileMap, { defer: true });
    this._reapplySessionGeneratedVariables(session, fileMap);
    this._applySessionInvertedVariables(session, fileMap);
    this._applySessionLayout(session.layout);
    await this._applySessionPlots(session.plots || [], fileMap);

    const mappedActive = fileMap.get(session.activeFileId);
    if (mappedActive) this.setActiveFile(mappedActive);
    else if (this.files.size) this.setActiveFile([...this.files.keys()][0]);

    this._updateTopBar();
    this._renderFilesList();
    this._updateActionButtons();
    this._syncSessionSettingsUI();
    const activeData = this.activeFileId ? this.plotManager.files.get(this.activeFileId)?.data : null;
    if (activeData) this.renderVariablesTree(activeData.tree);
    this._resetDataToolPicker?.();
    if (typeof document !== 'undefined') {
        document.getElementById('drop-zone')?.classList.toggle('active', this.files.size === 0);
    }

    if (!options.silent) {
        await Modal.alert(
            i18n.t('sessionAppliedTitle'),
            i18n.t(options.source === 'project' ? 'sessionProjectLoadedBody' : 'sessionViewAppliedBody'),
            { icon: options.source === 'project' ? 'ZIP' : 'JSON' },
        );
    }
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
        .filter(meta => {
            const fileId = fileMap.get(meta.id);
            const variables = fileId ? this.plotManager.files.get(fileId)?.data?.variables : null;
            if (!variables) return true;
            return this._sessionRequiredVariables(meta.id, session).some(name => !variables[name]);
        })
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
        if (plot.phasePending?.fileId === sessionFileId) {
            [plot.phasePending.x, plot.phasePending.y, plot.phasePending.z].filter(Boolean).forEach(name => {
                if (!generatedNames.has(name)) names.add(name);
            });
        }
        if (plot.stateSlots?.fileId === sessionFileId) {
            (plot.stateSlots.x || []).filter(Boolean).forEach(name => {
                if (!generatedNames.has(name)) names.add(name);
            });
            (plot.stateSlots.dx || []).filter(Boolean).forEach(name => {
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
    this.mouseWheelZoom = settings.mouseWheelZoom !== false;
    this._filterText = String(settings.variableFilterText || '').trim().toLowerCase();
    this._sessionSidebarHidden = !!settings.sidebarHidden;
    this._sessionSidebarWidth = typeof settings.sidebarWidth === 'string' ? settings.sidebarWidth : '';
    if (settings.advancedSettings && this._normalizeAdvancedSettings) {
        this.advancedSettings = this._normalizeAdvancedSettings(settings.advancedSettings);
        this._saveAdvancedSettings?.(this.advancedSettings);
        this.plotManager.setRelayoutRefreshMode?.(this.advancedSettings.panZoomRefreshMode);
    }
    this.plotManager.setSyncAxes(settings.syncAxes !== false);
    this.plotManager.setSyncHover(!!settings.syncHover);
    this.plotManager.setHoverInfoCorner(settings.hoverInfoCorner || 'bl');
    this.plotManager.setHoverProximity(settings.hoverProximity !== false);
    this.plotManager.setLegendPosition(settings.legendPosition || 'overlay');
    this.plotManager.setLegendOverlayCorner(settings.legendOverlayCorner || 'tl');
    this.plotManager.setMouseWheelZoom(this.mouseWheelZoom);
    this.plotManager.setTimeseriesDownsamplingLimit(settings.timeseriesVisualMaxPoints ?? this.plotManager.timeseriesVisualMaxPoints);
    this.plotManager.setPhaseDownsamplingLimit(settings.phaseVisualMaxPoints ?? this.plotManager.phaseVisualMaxPoints);
    if (settings.liveViewDefaults) {
        this.plotManager.liveViewDefaults = {
            ...(this.plotManager.liveViewDefaults || {}),
            ...this._cloneSerializable(settings.liveViewDefaults),
        };
    }
    this.scrollablePlotArea = !!settings.scrollablePlotArea;
    this.layoutManager.setScrollablePlotArea(this.scrollablePlotArea);
    this._syncScrollablePlotAreaUI();
    this._syncHoverCornerPicker?.();
    this._syncSessionSettingsUI();
};

proto._clearGeneratedVariablesForSession = function(fileMap) {
    for (const fileId of new Set(fileMap.values())) {
        const data = this.plotManager.files.get(fileId)?.data;
        if (!data) continue;
        const toolDefinitions = this.dataToolVariablesByFile?.get(fileId) || new Map();
        for (const [name, definition] of toolDefinitions) {
            if ((definition.targetMode || 'create') === 'modify') {
                const variable = data.variables?.[definition.sourceName || name];
                const originalData = definition.originalData;
                if (variable && originalData?.length) {
                    variable.data = Array.from(originalData);
                    variable.dataType = this.parser._detectDataType(variable.data, 'variable');
                    variable.isConstant = this.parser._isConstantValues(variable.data);
                    delete variable.dataToolModified;
                    delete variable.dataTool;
                    delete variable._duckdbDataTool;
                }
            } else {
                delete data.variables?.[name];
            }
        }
        for (const name of this.derivedByFile.get(fileId)?.keys() || []) delete data.variables?.[name];
    }
    this.derivedByFile.clear();
    this.dataToolVariablesByFile?.clear();
};

proto._syncSessionSettingsUI = function() {
    if (typeof document === 'undefined') return;
    const checked = (selector, value) => {
        const input = document.querySelector(selector);
        if (input) input.checked = !!value;
    };
    checked('#link-time-axes', this.plotManager.syncAxes);
    checked('#sync-hover', this.plotManager.syncHover);
    checked('#hover-proximity', this.plotManager.hoverProximity);
    checked('#mouse-wheel-zoom', this.mouseWheelZoom);
    checked('#scrollable-plot-area', this.scrollablePlotArea);
    checked('#reload-as-version-toggle', this.reloadAsNewVersionMode);
    document.querySelectorAll('input[name="legend-pos"]').forEach(input => {
        input.checked = input.value === this.plotManager.legendPosition;
    });
    document.getElementById('toggle-descriptions')?.classList.toggle('active', this.showDescriptions);
    document.getElementById('toggle-sort')?.classList.toggle('active', this.sortAlphabetical);
    const variableFilter = document.getElementById('variable-filter');
    if (variableFilter) variableFilter.value = this._filterText;
    const clearVariableFilter = document.getElementById('clear-variable-filter');
    if (clearVariableFilter) clearVariableFilter.hidden = !this._filterText;
    const sidebar = document.getElementById('sidebar');
    if (sidebar) {
        sidebar.classList.toggle('hidden', !!this._sessionSidebarHidden);
        if (this._sessionSidebarWidth) sidebar.style.width = this._sessionSidebarWidth;
    }
    this._applyReloadModeUI?.();
    this._syncLegendCornerPicker?.();
    this._syncHoverCornerPicker?.();
};

proto._applySessionFileMetadata = async function(session, fileMap, options = {}) {
    const skippedProfiles = [];
    for (const meta of session.files || []) {
        const fileId = fileMap.get(meta.id);
        const entry = fileId ? this.files.get(fileId) : null;
        if (!entry) continue;
        entry.transform = this._normalizeFileTransform(meta.transform);
        this._expandedFileTransforms ||= new Set();
        if (meta.transformPanelExpanded) this._expandedFileTransforms.add(fileId);
        else this._expandedFileTransforms.delete(fileId);
        this.plotManager.setFileTransform(fileId, entry.transform);
        const plotEntry = this.plotManager.files.get(fileId);
        if (plotEntry) plotEntry._transformCache = null;
        if (meta.csvProfile?.profileSource !== 'user') continue;

        const currentHash = entry.contentHash || '';
        if (meta.contentHash && currentHash && meta.contentHash !== currentHash) {
            skippedProfiles.push(meta.displayName || `${meta.name || 'results'}${meta.extension || ''}`);
            continue;
        }

        try {
            const displayName = this._fileDisplayName(entry);
            if (this._isExcelExtension?.(entry.extension)) {
                // Entry bytes are the raw workbook: re-derive the CSV view of
                // the recorded sheet (cached from load unless the session asks
                // for a different sheet) before applying the user profile.
                const { csvBuffer, sheetName, sheetNames } = await this._convertExcelEntryToCsvBuffer(entry, {
                    sheetName: meta.excel?.sheetName || null,
                });
                const data = await this._parseCsvResultBuffer(displayName, csvBuffer, null, {
                    csvProfile: meta.csvProfile,
                });
                data.metadata.excel = { sheetName, sheetNames: sheetNames || entry.excel?.sheetNames || null };
                entry.excel = { ...data.metadata.excel };
                this.plotManager.updateFileData(fileId, data);
                continue;
            }
            const streamable = this._canParseFromFile?.(entry.file, entry.extension);
            const latestFile = streamable
                ? (options.projectData ? entry.file : await this._readLatestFileForStreamableReload(entry))
                : null;
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

proto._applySessionDerivedVariables = function(session, fileMap, options = {}) {
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
            if (!options.defer) this._reapplyDerivedVariables(fileId, data);
        } else {
            this.derivedByFile.delete(fileId);
        }
    }
};

proto._applySessionDataToolVariables = function(session, fileMap, options = {}) {
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
            if (!options.defer) this._reapplyDataToolVariables?.(fileId, data);
        } else {
            this.dataToolVariablesByFile.delete(fileId);
        }
    }
};

proto._reapplySessionGeneratedVariables = function(session, fileMap) {
    for (const meta of session.files || []) {
        const fileId = fileMap.get(meta.id);
        const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
        if (!fileId || !data) continue;

        const pendingDerived = new Map(this.derivedByFile.get(fileId) || []);
        const pendingTools = new Map(this.dataToolVariablesByFile?.get(fileId) || []);
        const knownVariableNames = new Set([
            ...Object.keys(data.variables || {}),
            ...pendingDerived.keys(),
            ...pendingTools.keys(),
        ]);
        const maxPasses = pendingDerived.size + pendingTools.size + 1;
        for (let pass = 0; pass < maxPasses && (pendingDerived.size || pendingTools.size); pass++) {
            let progressed = false;
            for (const [name, definition] of [...pendingTools]) {
                if (this._reapplyDataToolDefinition?.(fileId, data, name, definition)) {
                    pendingTools.delete(name);
                    progressed = true;
                }
            }
            for (const [name, entry] of [...pendingDerived]) {
                const references = this._derivedFormulaReferences?.(entry.formula, knownVariableNames) || [];
                const waitsForModifier = [...pendingTools.values()].some(definition => (
                    (definition.targetMode || 'create') === 'modify'
                    && references.includes(definition.sourceName)
                ));
                if (waitsForModifier) continue;
                if (this._reapplyDerivedVariable?.(fileId, data, name, entry)) {
                    pendingDerived.delete(name);
                    progressed = true;
                }
            }
            if (!progressed) break;
        }
        if (data._duckdb) this._refreshLazyDataToolOverview?.(data);
        if (pendingDerived.size || pendingTools.size) {
            console.warn('[session] unresolved generated variables:', [
                ...pendingDerived.keys(),
                ...pendingTools.keys(),
            ].join(', '));
        }
    }
};

proto._applySessionInvertedVariables = function(session, fileMap) {
    for (const meta of session.files || []) {
        const fileId = fileMap.get(meta.id);
        const plotEntry = fileId ? this.plotManager.files.get(fileId) : null;
        if (!plotEntry) continue;
        plotEntry.invertedVariables = new Set(
            (meta.invertedVariables || []).filter(name => !!plotEntry.data?.variables?.[name]),
        );
        plotEntry._transformCache = null;
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
        plot.histogram = this.plotManager._normalizeHistogramState
            ? this.plotManager._normalizeHistogramState(saved.histogram || plot.histogram || {})
            : this._cloneSerializable(saved.histogram || plot.histogram);
        plot.heatmap = this.plotManager._normalizeCalendarHeatmapState
            ? this.plotManager._normalizeCalendarHeatmapState(saved.heatmap || plot.heatmap || {})
            : this._cloneSerializable(saved.heatmap || plot.heatmap);
        plot.temporalProfile = this.plotManager._normalizeTemporalProfileState
            ? this.plotManager._normalizeTemporalProfileState(saved.temporalProfile || plot.temporalProfile || {})
            : this._cloneSerializable(saved.temporalProfile || plot.temporalProfile);
        plot.correlation = this.plotManager._normalizeCorrelationState
            ? this.plotManager._normalizeCorrelationState(saved.correlation || plot.correlation || {})
            : this._cloneSerializable(saved.correlation || plot.correlation);
        // Correlation results (r) are never persisted — the rebuilt panel
        // recomputes them from the restored pairs — so start clean: drop any
        // saved warnings/dirty flag that the fresh compute will regenerate.
        if (plot.correlation) { plot.correlation.warnings = []; plot.correlation.dirty = false; }
        plot.phase2d = this.plotManager._normalizePhase2dState
            ? this.plotManager._normalizePhase2dState(saved.phase2d || plot.phase2d || {})
            : this._cloneSerializable(saved.phase2d || plot.phase2d);
        if (plot.phase2d) { plot.phase2d.warnings = []; plot.phase2d.dirty = false; }
        plot.projection = saved.projection || 'orthographic';
        plot.equalAspect2D = !!saved.equalAspect2D;
        plot.liveView = this._cloneSerializable(saved.liveView || this.plotManager._defaultLiveViewPolicy(plot.mode));
        plot.cursors = this._cloneSerializable(saved.cursors || this.plotManager._defaultCursors());
        plot.cursorsSpectrum = this._cloneSerializable(saved.cursorsSpectrum || this.plotManager._defaultCursors());
        plot.showCameraOverlay = !!saved.showCameraOverlay;
        plot.homeCamera = this._cloneSerializable(saved.homeCamera);
        plot.animFrame = saved.animFrame || 0;
        plot.animSpeed = saved.animSpeed || 1;
        plot.autoPlayOnRender = !!saved.animPlaying;
        plot.timeseriesStacked = !!saved.timeseriesStacked && !saved.timeseriesY2Enabled;
        plot.timeseriesY2Enabled = !!saved.timeseriesY2Enabled;
        plot.showMissingData = !!saved.showMissingData;
        plot._modeViews = this._cloneSerializable(saved.modeViews || {});
        if (!plot.timeseriesY2Enabled) plot.traces.forEach(trace => { trace.axis = 'y'; });
        plot.stateSlots = this._mappedStateSlots(saved.stateSlots, fileMap);
        plot.phasePending = this._mappedPhasePending(saved.phasePending, fileMap);

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

proto._mappedPhasePending = function(pending, fileMap) {
    const fileId = fileMap.get(pending?.fileId);
    if (!fileId) return { x: null, y: null, z: null, fileId: null };
    const variables = this.plotManager.files.get(fileId)?.data?.variables || {};
    const x = pending?.x && variables[pending.x] ? pending.x : null;
    const y = pending?.y && variables[pending.y] ? pending.y : null;
    const z = pending?.z && variables[pending.z] ? pending.z : null;
    return { x, y, z, fileId: x || y || z ? fileId : null };
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
