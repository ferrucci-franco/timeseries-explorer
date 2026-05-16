import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';
import {
    APP_VERSION,
    EXAMPLES,
    STANDALONE_MANIFEST_PATH,
} from '../constants.js';

export function installUiMethods(TargetClass) {
    const proto = TargetClass.prototype;
proto.initEventListeners = function() {
    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.addEventListener('click', (e) => this.setLanguage(e.target.getAttribute('data-lang')));
    });

    document.getElementById('theme-toggle').addEventListener('click', () => this.toggleTheme());

    document.getElementById('toggle-sidebar').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('hidden');
        setTimeout(() => this.plotManager.resizeAll(), 320);
    });

    document.getElementById('toggle-descriptions').addEventListener('click', (e) => {
        this.showDescriptions = !this.showDescriptions;
        e.currentTarget.classList.toggle('active', this.showDescriptions);
        this.toggleDescriptions(this.showDescriptions);
    });

    // 📂 — just open file picker, no confirmation
    document.getElementById('load-new-file').addEventListener('click', () => {
        this._openResultFilesFromUser().catch(err => {
            console.error('Open file failed:', err);
            alert(i18n.t('errorLoading') + ': ' + (err?.message || String(err)));
        });
    });
    this._initOpenFileMenu();

    document.getElementById('toggle-sort').addEventListener('click', (e) => {
        this.sortAlphabetical = !this.sortAlphabetical;
        e.currentTarget.classList.toggle('active', this.sortAlphabetical);
        if (this._currentTree) this._renderFilteredTree();
    });
    document.getElementById('toggle-sort').classList.toggle('active', this.sortAlphabetical);

    document.getElementById('variable-filter').addEventListener('input', (e) => {
        this._filterText = e.target.value.trim().toLowerCase();
        if (this._currentTree) this._renderFilteredTree();
    });

    document.getElementById('expand-all').addEventListener('click',   () => this.expandAllTree());
    document.getElementById('collapse-all').addEventListener('click', () => this.collapseAllTree());

    document.getElementById('derived-help-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleDerivedHelpPopover();
    });
    document.getElementById('timeseries-downsampling-help-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleTimeseriesDownsamplingHelpPopover();
    });
    document.getElementById('derived-toggle').addEventListener('click', () => this._toggleDerivedForm(true));
    document.getElementById('derived-cancel').addEventListener('click', () => this._toggleDerivedForm(false));
    document.getElementById('derived-create').addEventListener('click', () => this.createDerivedVariable());
    document.getElementById('derived-formula').addEventListener('input', (e) => this._updateDerivedSuggestions(e));
    document.getElementById('derived-formula').addEventListener('keydown', (e) => this._handleDerivedFormulaKeydown(e));
    document.getElementById('derived-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.createDerivedVariable();
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.derived-formula-wrap')) this._hideDerivedSuggestions();
        if (!e.target.closest('#derived-help-popover') && !e.target.closest('#derived-help-toggle')) {
            this._toggleDerivedHelpPopover(false);
        }
        if (!e.target.closest('#timeseries-downsampling-help-popover') && !e.target.closest('#timeseries-downsampling-help-toggle')) {
            this._toggleTimeseriesDownsamplingHelpPopover(false);
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !document.getElementById('derived-help-popover')?.hidden) {
            e.preventDefault();
            this._toggleDerivedHelpPopover(false);
            return;
        }
        if (e.key === 'Escape' && !document.getElementById('timeseries-downsampling-help-popover')?.hidden) {
            e.preventDefault();
            this._toggleTimeseriesDownsamplingHelpPopover(false);
            return;
        }
        if (e.key === 'Escape' && this.selectedVariables.size > 0) {
            this._clearVariableSelection();
        }
    });

    document.getElementById('file-select-btn').addEventListener('click', () => {
        this._openResultFilesFromUser().catch(err => {
            console.error('Open file failed:', err);
            alert(i18n.t('errorLoading') + ': ' + (err?.message || String(err)));
        });
    });

    document.getElementById('file-input').addEventListener('change', async (e) => {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        for (const f of files) await this.loadFile(f);
    });

    document.getElementById('link-time-axes').addEventListener('change', (e) => {
        this.plotManager.setSyncAxes(e.target.checked);
    });

    document.getElementById('sync-hover').addEventListener('change', (e) => {
        this.plotManager.setSyncHover(e.target.checked);
    });

    document.getElementById('hover-proximity').addEventListener('change', (e) => {
        this.plotManager.setHoverProximity(e.target.checked);
    });

    const scrollablePlotAreaToggle = document.getElementById('scrollable-plot-area');
    if (scrollablePlotAreaToggle) {
        scrollablePlotAreaToggle.checked = !!this.scrollablePlotArea;
        scrollablePlotAreaToggle.addEventListener('change', (e) => {
            this._setScrollablePlotArea(e.target.checked);
        });
    }

    const mouseWheelZoomToggle = document.getElementById('mouse-wheel-zoom');
    if (mouseWheelZoomToggle) {
        mouseWheelZoomToggle.checked = !!this.mouseWheelZoom;
        mouseWheelZoomToggle.addEventListener('change', (e) => {
            this.mouseWheelZoom = e.target.checked;
            this.plotManager.setMouseWheelZoom(this.mouseWheelZoom);
        });
    }

    document.getElementById('timeseries-downsampling').addEventListener('change', (e) => {
        const raw = e.target.value;
        this.plotManager.setTimeseriesDownsamplingLimit(raw === 'none' ? null : Number(raw));
    });
    document.getElementById('phase-downsampling').addEventListener('change', (e) => {
        const raw = e.target.value;
        this.plotManager.setPhaseDownsamplingLimit(raw === 'none' ? null : Number(raw));
    });

    document.querySelectorAll('input[name="legend-pos"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            this.plotManager.setLegendPosition(e.target.value);
            this._syncLegendCornerPicker();
        });
    });
    document.querySelectorAll('.legend-corner-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            this.plotManager.setLegendOverlayCorner(btn.getAttribute('data-corner'));
            this._syncLegendCornerPicker();
        });
    });
    this._syncLegendCornerPicker();

    document.getElementById('reset-layout').addEventListener('click', async () => {
        const ok = await Modal.confirm(i18n.t('resetLayoutWarning'), { icon: '⬜' });
        if (ok) this.layoutManager.reset();
    });

    document.getElementById('auto-zoom').addEventListener('click',   () => this.plotManager.autoZoomAll());
    document.getElementById('clear-plots').addEventListener('click', async () => {
        const ok = await Modal.confirm(i18n.t('clearPlotsWarning'), { icon: '🗑️' });
        if (ok) this.plotManager.clearAll();
    });

    document.getElementById('reload-file').addEventListener('click', () => {
        const action = this.reloadAsNewVersionMode ? this.reloadActiveFileAsNewVersion() : this.reloadActiveFile();
        action.catch(err => {
            if (err?.name === 'AbortError') { this._updateTopBar(); return; }
            console.error('Reload failed:', err);
            alert(i18n.t('errorLoading') + ': ' + (err?.message || String(err)));
            this._updateTopBar();
        });
    });
    const reloadModeToggle = document.getElementById('reload-as-version-toggle');
    if (reloadModeToggle) {
        reloadModeToggle.checked = !!this.reloadAsNewVersionMode;
        reloadModeToggle.addEventListener('change', (e) => this._setReloadAsNewVersionMode(e.target.checked));
    }
    this._applyReloadModeUI();

    this._initExampleMenu();
    this._initExtraMenu();

    document.getElementById('help-btn').addEventListener('click', () => this.showHelp());
};

proto._setScrollablePlotArea = async function(enabled) {
    const next = !!enabled;
    if (
        !next
        && this.scrollablePlotArea
        && this.layoutManager.wouldDisableScrollableCompressTooMuch()
    ) {
        const ok = await Modal.confirm(i18n.t('compressPlotLayoutWarning'), {
            icon: '↕',
            title: i18n.t('compressPlotLayoutTitle'),
            cancelText: i18n.t('keepScroll'),
            confirmText: i18n.t('compressPlots'),
        });
        if (!ok) {
            this._syncScrollablePlotAreaUI();
            return false;
        }
    }

    this.scrollablePlotArea = next;
    this.layoutManager.setScrollablePlotArea(next);
    this._syncScrollablePlotAreaUI();
    setTimeout(() => this.plotManager.resizeAll(), 80);
    return true;
};

proto._syncScrollablePlotAreaUI = function() {
    const toggle = document.getElementById('scrollable-plot-area');
    if (toggle) toggle.checked = !!this.scrollablePlotArea;
};

proto._syncLegendCornerPicker = function() {
    const picker = document.getElementById('legend-corner-picker');
    if (!picker) return;

    const isOverlay = this.plotManager.legendPosition === 'overlay';
    picker.classList.toggle('disabled', !isOverlay);
    picker.setAttribute('aria-disabled', isOverlay ? 'false' : 'true');

    const titleKeys = {
        tl: 'legendCornerTopLeft',
        tr: 'legendCornerTopRight',
        bl: 'legendCornerBottomLeft',
        br: 'legendCornerBottomRight',
    };

    picker.querySelectorAll('.legend-corner-btn').forEach(btn => {
        const corner = btn.getAttribute('data-corner');
        const label = i18n.t(titleKeys[corner] || 'legendCornerTopLeft');
        const isActive = this.plotManager.legendOverlayCorner === corner;
        btn.classList.toggle('active', isActive);
        btn.disabled = !isOverlay;
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
};

proto._initOpenFileMenu = function() {
    const btn  = document.getElementById('open-file-menu-btn');
    const menu = document.getElementById('open-file-menu');
    if (!btn || !menu) return;

    const close = () => {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
        this._renderOpenFileMenu();
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
    };

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden ? open() : close();
    });

    document.addEventListener('click', (e) => {
        if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.hidden) close();
    });

    this._closeOpenFileMenu = close;
};

proto._renderOpenFileMenu = function() {
    const menu = document.getElementById('open-file-menu');
    menu.innerHTML = '';

    const tempItem = document.createElement('button');
    tempItem.className = 'example-menu-item';
    tempItem.type = 'button';
    tempItem.setAttribute('role', 'menuitem');
    tempItem.textContent = i18n.t('openOpenModelicaTemp');
    tempItem.addEventListener('click', () => {
        this._closeOpenFileMenu?.();
        this._copyOpenModelicaTempPathToClipboard().catch(err => {
            console.error('Copy OpenModelica temp path failed:', err);
            alert(i18n.t('errorLoading') + ': ' + (err?.message || String(err)));
        });
    });
    menu.appendChild(tempItem);
};

proto._setReloadAsNewVersionMode = function(enabled) {
    this.reloadAsNewVersionMode = !!enabled;
    this._applyReloadModeUI();
};

proto._applyReloadModeUI = function() {
    const reloadBtn = document.getElementById('reload-file');
    const toggle = document.getElementById('reload-as-version-toggle');
    const switchEl = document.getElementById('reload-as-version-switch');
    const enabled = !!(reloadBtn && !reloadBtn.disabled);
    if (toggle) toggle.checked = enabled && !!this.reloadAsNewVersionMode;
    if (switchEl) {
        switchEl.classList.toggle('active', enabled && !!this.reloadAsNewVersionMode);
        switchEl.title = i18n.t(this.reloadAsNewVersionMode ? 'reloadModeNewVersion' : 'reloadModeReplace');
    }
    if (reloadBtn) {
        reloadBtn.title = i18n.t(this.reloadAsNewVersionMode ? 'reloadAsNewVersion' : 'reloadFile');
        reloadBtn.classList.toggle('active', enabled && !!this.reloadAsNewVersionMode);
        reloadBtn.classList.toggle('reload-as-new', enabled && !!this.reloadAsNewVersionMode);
        reloadBtn.dataset.modeLabel = enabled && this.reloadAsNewVersionMode ? 'AS NEW' : '';
    }
};

proto._copyOpenModelicaTempPathToClipboard = async function() {
    const candidates = this._getOpenModelicaTempCandidates();
    const usedFallback = candidates.length === 0;
    const fallbackPaths = this._getOpenModelicaTempFallbackPaths();
    const path = usedFallback
        ? this._getLikelyOpenModelicaTempPath(fallbackPaths)
        : candidates[0];
    const copied = await this._copyTextToClipboard(path);

    let messageKey = 'openModelicaTempPathCopyFailed';
    if (copied) {
        messageKey = usedFallback
            ? 'openModelicaTempPathCopiedUsernameUnknown'
            : 'openModelicaTempPathCopied';
    }

    const titleKey = copied
        ? 'openModelicaTempPathCopiedTitle'
        : 'openModelicaTempPathCopyFailedTitle';

    await Modal.alert(i18n.t(titleKey), i18n.t(messageKey).replaceAll('{path}', path), {
        icon: '📋',
        className: 'modal-dialog-temp-path',
    });
};

proto._copyTextToClipboard = async function(text) {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (_) {}
    }

    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.select();
    try {
        return document.execCommand('copy');
    } catch (_) {
        return false;
    } finally {
        document.body.removeChild(textArea);
    }
};

proto._getOpenModelicaTempCandidates = function() {
    const userHome = this._inferWindowsUserHomeFromLocation();
    if (userHome) {
        return [
            `${userHome}\\AppData\\Local\\Temp\\OpenModelica\\OMEdit`,
            `${userHome}\\AppData\\Local\\Temp\\OpenModelica`,
        ];
    }

    const linuxUser = this._inferLinuxUserFromLocation();
    if (linuxUser) {
        return [
            `/tmp/OpenModelica${linuxUser}/OMEdit`,
            `/tmp/OpenModelica${linuxUser}`,
        ];
    }

    return [];
};

proto._getOpenModelicaTempFallbackPaths = function() {
    return {
        windows: 'C:\\Users\\USERNAME\\AppData\\Local\\Temp\\OpenModelica\\OMEdit',
        linux: '/tmp/OpenModelicaUSERNAME/OMEdit',
    };
};

proto._getLikelyOpenModelicaTempPath = function(paths) {
    const platform = `${navigator.userAgent || ''} ${navigator.platform || ''}`.toLowerCase();
    if (platform.includes('linux')) return paths.linux;
    return paths.windows;
};

proto._inferWindowsUserHomeFromLocation = function() {
    const candidates = this._getDecodedLocationCandidates();
    for (const candidate of candidates) {
        const normalized = candidate.replace(/\\/g, '/');
        const match = normalized.match(/(?:^file:\/\/\/|^\/)?([A-Za-z]:\/Users\/[^/]+)/i);
        if (match) return match[1].replace(/\//g, '\\');
    }
    return '';
};

proto._inferLinuxUserFromLocation = function() {
    const candidates = this._getDecodedLocationCandidates();
    for (const candidate of candidates) {
        const normalized = candidate.replace(/\\/g, '/');
        const match = normalized.match(/(?:^file:\/\/)?\/home\/([^/]+)/i);
        if (match) return match[1];
    }
    return '';
};

proto._getDecodedLocationCandidates = function() {
    const rawCandidates = [
        window.location.href,
        window.location.pathname,
        window.location.toString?.() || '',
    ].filter(Boolean);

    const decoded = [];
    for (const value of rawCandidates) {
        try {
            decoded.push(decodeURIComponent(value));
        } catch (_) {
            decoded.push(value);
        }
    }

    return [...new Set(decoded)];
};

proto._initExampleMenu = function() {
    const btn  = document.getElementById('load-example-btn');
    const menu = document.getElementById('example-menu');

    const close = () => {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
        this._renderExampleMenu();
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
    };

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden ? open() : close();
    });

    document.addEventListener('click', (e) => {
        if (!menu.hidden && !menu.contains(e.target) && e.target !== btn) close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.hidden) close();
    });

    this._closeExampleMenu = close;
};

proto._renderExampleMenu = function() {
    const menu = document.getElementById('example-menu');
    menu.innerHTML = '';
    for (const ex of EXAMPLES) {
        const item = document.createElement('button');
        item.className = 'example-menu-item';
        item.type = 'button';
        item.setAttribute('role', 'menuitem');

        const available = ex.getDataB64() != null || !!ex.script;
        item.disabled = !available;

        const name = document.createElement('span');
        name.className = 'example-name';
        name.textContent = i18n.t(ex.nameKey);
        item.appendChild(name);

        if (!available) {
            const badge = document.createElement('span');
            badge.className = 'example-badge';
            badge.textContent = i18n.t('exampleComingSoon');
            item.appendChild(badge);
        }

        item.addEventListener('click', () => {
            this._closeExampleMenu();
            if (!available) return;
            this.loadExample(ex.id).catch(err => {
                this._setExampleLoading(false);
                console.error('Example load failed:', err);
                alert(i18n.t('errorLoading') + ': ' + (err?.message || String(err)));
            });
        });
        menu.appendChild(item);
    }
};

proto._initExtraMenu = function() {
    const btn  = document.getElementById('extra-menu-btn');
    const menu = document.getElementById('extra-menu');
    if (!btn || !menu) return;

    const close = () => {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
    };
    const open = () => {
        this._renderExtraMenu();
        menu.hidden = false;
        btn.setAttribute('aria-expanded', 'true');
    };

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.hidden ? open() : close();
    });

    document.addEventListener('click', (e) => {
        if (!menu.hidden && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) close();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !menu.hidden) close();
    });

    this._closeExtraMenu = close;
};

proto._renderExtraMenu = function() {
    const menu = document.getElementById('extra-menu');
    if (!menu) return;
    menu.innerHTML = '';

    const makeAction = (icon, labelKey, handler, options = {}) => {
        const item = document.createElement('button');
        item.className = 'example-menu-item extra-menu-item';
        item.type = 'button';
        item.setAttribute('role', 'menuitem');

        const iconSpan = document.createElement('span');
        iconSpan.className = 'extra-menu-icon';
        iconSpan.textContent = icon;

        const name = document.createElement('span');
        name.className = 'example-name';
        name.textContent = i18n.t(labelKey);

        item.append(iconSpan, name);

        if (options.badgeKey) {
            const badge = document.createElement('span');
            badge.className = 'example-badge';
            badge.textContent = i18n.t(options.badgeKey);
            item.appendChild(badge);
        }

        item.addEventListener('click', () => {
            this._closeExtraMenu?.();
            handler();
        });
        return item;
    };

    const feedbackItem = makeAction('💬', 'extraFeedback', () => {
        Modal.alert(i18n.t('extraFeedback'), i18n.t('extraFeedbackSoonBody'), { icon: '💬' });
    }, { badgeKey: 'exampleComingSoon' });

    const standaloneItem = makeAction('📦', 'extraStandalone', () => {
        this._downloadStandalonePackage();
    });

    const versionRow = document.createElement('div');
    versionRow.className = 'example-menu-item extra-menu-static';

    const versionIcon = document.createElement('span');
    versionIcon.className = 'extra-menu-icon';
    versionIcon.textContent = '🏷';

    const versionLabel = document.createElement('span');
    versionLabel.className = 'example-name';
    versionLabel.textContent = i18n.t('extraVersion');

    const versionValue = document.createElement('span');
    versionValue.className = 'example-badge extra-version-badge';
    versionValue.textContent = `v${APP_VERSION}`;

    versionRow.append(versionIcon, versionLabel, versionValue);

    menu.append(feedbackItem, standaloneItem, versionRow);
};

proto._downloadStandalonePackage = async function() {
    try {
        const response = await fetch(STANDALONE_MANIFEST_PATH, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Missing manifest: ${response.status}`);

        const manifest = await response.json();
        if (!manifest?.zipUrl) throw new Error('Missing zipUrl in manifest');

        const link = document.createElement('a');
        link.href = manifest.zipUrl;
        link.download = manifest.fileName || '';
        document.body.appendChild(link);
        link.click();
        link.remove();
    } catch {
        Modal.alert(i18n.t('extraStandalone'), i18n.t('extraStandaloneUnavailableBody'), { icon: '📦' });
    }
};

proto.loadExample = async function(exampleId = 'pendulum') {
    if (this._exampleLoading) return;
    const ex = EXAMPLES.find(e => e.id === exampleId);
    if (!ex) throw new Error(`Unknown example: ${exampleId}`);

    if (this.plotManager.hasAnyTraces()) {
        const ok = await Modal.confirm(i18n.t('loadExampleWarning'), { icon: '🎓' });
        if (!ok) return;
    }

    const token = this._setExampleLoading(true, i18n.t(ex.nameKey));
    const isCancelled = () => !token || token.cancelled || this._exampleLoadToken !== token;

    try {
        await this._waitForExampleCancelWindow(token);
        if (isCancelled()) return;

        await this._ensureExampleData(ex);
        if (isCancelled()) return;

        const b64 = ex.getDataB64();
        if (b64 == null) return;

        // Decode embedded base64 data — works with file:// and http:// alike
        const binary = atob(b64);
        const buffer = new ArrayBuffer(binary.length);
        const view   = new Uint8Array(buffer);
        for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);

        const contentHash = await this._hashBuffer(buffer);
        const data   = await this.parser.parse(buffer);
        await this._yieldToBrowser();
        if (isCancelled()) return;

        token.committed = true;
        const baseName   = ex.baseName;
        const existingId = [...this.files.entries()].find(([,e]) => e.name === baseName)?.[0];
        let fileId = existingId;
        if (!fileId) {
            fileId = `f${this._nextFileId++}`;
            const transform = this._defaultFileTransform();
            this.files.set(fileId, { file: null, buffer, contentHash, name: baseName, extension: '.mat', transform });
            this.plotManager.addFile(fileId, baseName, data, transform);
        } else {
            this.files.get(fileId).buffer = buffer;
            this.files.get(fileId).contentHash = contentHash;
            this._reapplyDerivedVariables(fileId, data);
            this.plotManager.updateFileData(fileId, data);
        }
        this.plotManager.setActiveFile(fileId);

        const grid = ex.grid || { rows: 2, cols: 2 };

        // Clear plots and build the example layout grid
        this.plotManager.clearAll();
        this.layoutManager.resetToGrid(grid.rows, grid.cols);

        // Wait for panels to mount
        await new Promise(r => setTimeout(r, 50));
        if (isCancelled()) return;

        // Collect panel IDs in DOM order: TL, TR, BL, BR for 2×2 examples,
        // or panelId for single-panel examples.
        const panels = [...document.querySelectorAll('.layout-panel')].map(el => el.dataset.id);
        if (panels.length < grid.rows * grid.cols) return;
        const [tlId, trId, blId, brId] = panels;

        // Set state directly — no addTrace, avoids async race conditions
        ex.applyLayout(this.plotManager, fileId, { panelId: panels[0], panels, tlId, trId, blId, brId });

        document.getElementById('drop-zone').classList.remove('active');
        this._updateTopBar();
        this._renderFilesList();
        this._updateActionButtons();
        this._clearVariableSelection();
        this.renderVariablesTree(data.tree);
    } finally {
        if (this._exampleLoadToken === token) this._setExampleLoading(false);
    }
};

proto._setExampleLoading = function(loading, exampleName = '') {
    this._exampleLoading = loading;
    const btn = document.getElementById('load-example-btn');
    const message = i18n.t('loadingExample').replace('{name}', exampleName);

    if (loading) {
        const token = { cancelled: false };
        this._exampleLoadToken = token;
        if (btn) btn.disabled = true;
        this._setDropZoneStatus(true, message);
        this._showExampleLoadingOverlay(message, token);
        return token;
    }

    if (this._exampleLoadToken) this._exampleLoadToken.cancelled = true;
    this._exampleLoadToken = null;
    if (btn) btn.disabled = false;
    this._setDropZoneStatus(false);
    this._hideExampleLoadingOverlay();
    return null;
};

proto._showExampleLoadingOverlay = function(message, token) {
    this._hideExampleLoadingOverlay();

    const overlay = document.createElement('div');
    overlay.id = 'example-loading-overlay';
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
    title.textContent = message;

    const hint = document.createElement('div');
    hint.className = 'example-loading-hint';
    hint.textContent = i18n.t('loadingExampleCancelHint');

    dialog.append(spinner, title, hint);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    this._exampleLoadingEscHandler = (e) => {
        if (e.key !== 'Escape' || this._exampleLoadToken !== token) return;
        if (token.committed) return;
        e.preventDefault();
        e.stopPropagation();
        token.cancelled = true;
        this._setExampleLoading(false);
    };
    document.addEventListener('keydown', this._exampleLoadingEscHandler, true);
    requestAnimationFrame(() => overlay.classList.add('show'));
    overlay.tabIndex = -1;
    overlay.focus({ preventScroll: true });
};

proto._hideExampleLoadingOverlay = function() {
    if (this._exampleLoadingEscHandler) {
        document.removeEventListener('keydown', this._exampleLoadingEscHandler, true);
        this._exampleLoadingEscHandler = null;
    }

    const overlay = document.getElementById('example-loading-overlay');
    if (!overlay) return;
    overlay.classList.remove('show');
    setTimeout(() => overlay.remove(), 220);
};

proto._waitForExampleCancelWindow = function(token, ms = 450) {
    return new Promise(resolve => {
        const started = performance.now();
        const tick = () => {
            if (!token || token.cancelled || this._exampleLoadToken !== token) {
                resolve();
                return;
            }
            if (performance.now() - started >= ms) {
                resolve();
                return;
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    });
};

proto._yieldToBrowser = function() {
    return new Promise(resolve => setTimeout(resolve, 0));
};

proto._setDropZoneStatus = function(show, message = '') {
    const status = document.getElementById('drop-zone-status');
    if (!status) return;
    status.hidden = !show;
    status.textContent = show ? message : '';
};

proto._ensureExampleData = async function(example) {
    if (example.getDataB64() != null || !example.script) return;
    await this._loadScriptOnce(example.script);
};

proto._loadScriptOnce = function(src) {
    if (this._loadedScripts.has(src)) return Promise.resolve();
    if ([...document.scripts].some(s => s.getAttribute('src') === src)) {
        this._loadedScripts.add(src);
        return;
    }
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => {
            this._loadedScripts.add(src);
            resolve();
        };
        script.onerror = () => reject(new Error(`Cannot load script: ${src}`));
        document.head.appendChild(script);
    });
};

proto.showHelp = function() {
    const sections = ['1','2','5','3','10','4','6','7','8','9'];

    const backdrop = document.createElement('div');
    backdrop.className = 'help-backdrop';

    const modal = document.createElement('div');
    modal.className = 'help-modal';

    const header = document.createElement('div');
    header.className = 'help-modal-header';
    const title = document.createElement('h2');
    title.textContent = i18n.t('helpTitle');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'help-modal-close';
    closeBtn.textContent = '✕';
    closeBtn.title = i18n.t('helpClose');
    header.append(title, closeBtn);

    const body = document.createElement('div');
    body.className = 'help-modal-body';

    for (const n of sections) {
        const sec = document.createElement('div');
        sec.className = 'help-section';
        const h3 = document.createElement('h3');
        h3.textContent = i18n.t(`helpSec${n}Title`);
        const p = document.createElement('p');
        p.innerHTML = i18n.t(`helpSec${n}Body`);
        sec.append(h3, p);
        body.appendChild(sec);
    }

    modal.append(header, body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', function onKey(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });
};

// ─── Drag-and-drop file loading ────────────────────────────────

proto.initDragAndDrop = function() {
    const dropZone = document.getElementById('drop-zone');

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragging');
    });

    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));

    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragging');
        const files = await this._getDroppedResultFiles(e.dataTransfer);
        if (!files.length) { alert(i18n.t('invalidFile')); return; }
        for (const { file, fileHandle } of files) {
            await this.loadFile(file, { fileHandle });
        }
    });
};

// ─── Sidebar resize ────────────────────────────────────────────

proto.initSidebarResize = function() {
    const sidebar = document.getElementById('sidebar');
    const handle  = document.querySelector('.sidebar-resize-handle');
    const proxy = document.createElement('div');
    proxy.className = 'sidebar-resize-proxy';
    document.body.appendChild(proxy);
    let isResizing = false, startX = 0, startWidth = 0;
    const edgeWidth = 14;

    const updateProxy = () => {
        const rect = sidebar.getBoundingClientRect();
        const hidden = sidebar.classList.contains('hidden') || rect.width < 2;
        proxy.style.display = hidden ? 'none' : '';
        proxy.style.left = `${rect.right - 6}px`;
        proxy.style.top = `${rect.top}px`;
        proxy.style.height = `${rect.height}px`;
    };

    const startResize = (e) => {
        isResizing = true; startX = e.clientX; startWidth = sidebar.offsetWidth;
        handle.classList.add('resizing');
        proxy.classList.add('resizing');
        sidebar.classList.add('resizing');
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        proxy.setPointerCapture?.(e.pointerId);
        e.preventDefault();
    };

    handle.addEventListener('pointerdown', startResize);
    proxy.addEventListener('pointerdown', startResize);

    sidebar.addEventListener('pointerdown', (e) => {
        const rect = sidebar.getBoundingClientRect();
        const nearRightEdge = rect.right - e.clientX <= edgeWidth;
        if (nearRightEdge && !sidebar.classList.contains('hidden')) startResize(e);
    }, true);

    sidebar.addEventListener('pointermove', (e) => {
        if (isResizing || sidebar.classList.contains('hidden')) return;
        const rect = sidebar.getBoundingClientRect();
        sidebar.classList.toggle('resize-ready', rect.right - e.clientX <= edgeWidth);
    });

    document.addEventListener('pointermove', (e) => {
        if (!isResizing) return;
        const w = Math.max(200, Math.min(600, startWidth + e.clientX - startX));
        sidebar.style.width = w + 'px';
        updateProxy();
    });

    document.addEventListener('pointerup', (e) => {
        if (!isResizing) return;
        isResizing = false;
        handle.classList.remove('resizing');
        proxy.classList.remove('resizing');
        sidebar.classList.remove('resizing');
        sidebar.classList.remove('resize-ready');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        proxy.releasePointerCapture?.(e.pointerId);
        updateProxy();
    });

    window.addEventListener('resize', updateProxy);
    new ResizeObserver(updateProxy).observe(sidebar);
    updateProxy();
};

// ─── Variables tree ────────────────────────────────────────────

// ─── Derived variables ─────────────────────────────────────────

}
