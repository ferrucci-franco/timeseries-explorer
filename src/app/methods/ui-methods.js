import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';
import { strToU8, zipSync } from '../../../node_modules/fflate/esm/browser.js';
import {
    APP_VERSION,
    BUILD_SHA,
    BUILD_DATE,
    DESKTOP_MANIFEST_PATH,
    DESKTOP_PLATFORM_ICON_PATHS,
    DYMOLA_LOGO_ICON_PATH,
    EXAMPLES,
    FEEDBACK_EMAIL,
    FEEDBACK_ISSUES_URL,
    ONLINE_VERSION_URL,
    OPENMODELICA_MODELING_ICON_PATH,
    RESET_LAYOUT_ICON_SVG,
} from '../constants.js';

const FEEDBACK_MAX_PACKAGE_BYTES = 25 * 1024 * 1024;

const HELP_TOPICS = [
    { section: '1', icon: 'compass', color: '#3b82f6' },
    { section: '2', icon: 'folder', color: '#f59e0b' },
    { section: '3', icon: 'model', color: '#2563eb' },
    { section: '4', icon: 'layers', color: '#06b6d4' },
    { section: '5', icon: 'chart', color: '#8b5cf6' },
    { section: '6', icon: 'spectrum', color: '#ec4899' },
    { section: '7', icon: 'animation', color: '#a855f7' },
    { section: '8', icon: 'cursor', color: '#ef4444' },
    { section: '9', icon: 'align', color: '#14b8a6' },
    { section: '10', icon: 'formula', color: '#f97316' },
    { section: '11', icon: 'database', color: '#64748b' },
    { section: '12', icon: 'reload', color: '#0ea5e9' },
    { section: '13', icon: 'save', color: '#22c55e' },
    { section: '14', icon: 'info', color: '#6366f1' },
];

const HELP_ICON_PATHS = {
    compass: '<circle cx="12" cy="12" r="8.5"/><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9 4.9-2.1Z"/>',
    chart: '<path d="M4 19.5V5m0 14.5h16"/><path d="m7 15 3-3 2.5 2 4.5-6 2 1.5"/>',
    spectrum: '<path d="M3 12h3l2-7 3 14 3-9 2 4h5"/><path d="M3 20h18"/>',
    animation: '<path d="M7.5 6.5A7 7 0 0 1 19 10l1.5-1.5M20 10h-4"/><path d="M16.5 17.5A7 7 0 0 1 5 14l-1.5 1.5M4 14h4"/><circle cx="12" cy="12" r="2"/>',
    folder: '<path d="M3.5 7.5h6l2-2h9v13h-17z"/><path d="M3.5 9.5h17"/>',
    model: '<circle cx="6" cy="6" r="2.2"/><circle cx="18" cy="6" r="2.2"/><circle cx="12" cy="18" r="2.2"/><path d="M8.2 6h7.6M7.3 7.8l3.5 8.2M16.7 7.8 13.2 16"/>',
    align: '<path d="M4 7h10m3 0h3M4 17h3m3 0h10"/><circle cx="15.5" cy="7" r="1.5"/><circle cx="8.5" cy="17" r="1.5"/>',
    layers: '<path d="m12 4 8 4-8 4-8-4 8-4Z"/><path d="m4 12 8 4 8-4M4 16l8 4 8-4"/>',
    save: '<path d="M5 4h12l2 2v14H5z"/><path d="M8 4v6h8V4M8 20v-6h8v6"/>',
    reload: '<path d="M19 8a7.5 7.5 0 0 0-13-2L4 8m0 0V4m0 4h4"/><path d="M5 16a7.5 7.5 0 0 0 13 2l2-2m0 0v4m0-4h-4"/>',
    formula: '<path d="M15.5 4.5h-2a3 3 0 0 0-3 3v9a3 3 0 0 1-3 3h-2"/><path d="M7.5 11.5h6M16 14l4 4m0-4-4 4"/>',
    database: '<ellipse cx="12" cy="5.5" rx="7.5" ry="3"/><path d="M4.5 5.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6M4.5 11.5v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/>',
    cursor: '<circle cx="12" cy="12" r="5"/><path d="M12 3v4m0 10v4M3 12h4m10 0h4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 10.5v6M12 7.25h.01"/>',
};

function helpIcon(name, className = 'help-topic-icon-svg') {
    return `<svg class="${className}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${HELP_ICON_PATHS[name] || HELP_ICON_PATHS.compass}</svg>`;
}

export function installUiMethods(TargetClass) {
    const proto = TargetClass.prototype;
proto.initEventListeners = function() {
    const resetLayoutIcon = document.querySelector('#reset-layout .reset-layout-icon');
    if (resetLayoutIcon) resetLayoutIcon.innerHTML = RESET_LAYOUT_ICON_SVG;
    // The browser menu does not provide app actions and can obscure the UI.
    // Prevent only the native default: target-level contextmenu handlers still
    // receive the event and can open the app's own contextual menus.
    document.addEventListener('contextmenu', (event) => {
        event.preventDefault();
    });

    document.querySelectorAll('.lang-btn').forEach(btn => {
        btn.addEventListener('click', (e) => this.setLanguage(e.target.getAttribute('data-lang')));
    });

    document.getElementById('theme-toggle').addEventListener('click', () => this.toggleTheme());

    document.getElementById('supported-formats-link')?.addEventListener('click', () => {
        this.showSupportedFormats();
    });

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

    document.getElementById('toggle-sort').addEventListener('click', (e) => {
        this.sortAlphabetical = !this.sortAlphabetical;
        e.currentTarget.classList.toggle('active', this.sortAlphabetical);
        if (this._currentTree) this._renderFilteredTree();
    });
    document.getElementById('toggle-sort').classList.toggle('active', this.sortAlphabetical);

    const variableFilter = document.getElementById('variable-filter');
    const clearVariableFilter = document.getElementById('clear-variable-filter');
    const updateVariableFilterClear = () => {
        clearVariableFilter.hidden = variableFilter.value.length === 0;
    };
    variableFilter.addEventListener('input', (e) => {
        this._filterText = e.target.value.trim().toLowerCase();
        updateVariableFilterClear();
        if (this._currentTree) this._renderFilteredTree();
    });
    clearVariableFilter.addEventListener('click', () => {
        if (!variableFilter.value) return;
        variableFilter.value = '';
        this._filterText = '';
        updateVariableFilterClear();
        if (this._currentTree) this._renderFilteredTree();
        variableFilter.focus();
    });
    updateVariableFilterClear();

    document.getElementById('expand-all').addEventListener('click',   () => this.expandAllTree());
    document.getElementById('collapse-all').addEventListener('click', () => this.collapseAllTree());

    document.getElementById('derived-help-toggle').addEventListener('click', (e) => {
        e.stopPropagation();
        this._toggleDerivedHelpPopover();
    });
    document.getElementById('derived-toggle').addEventListener('click', () => this._toggleDerivedForm(true));
    document.getElementById('derived-cancel').addEventListener('click', () => this._toggleDerivedForm(false));
    document.getElementById('derived-create').addEventListener('click', () => this.createDerivedVariable());
    document.getElementById('derived-formula').addEventListener('input', (e) => this._updateDerivedSuggestions(e));
    document.getElementById('derived-formula').addEventListener('keydown', (e) => this._handleDerivedFormulaKeydown(e));
    document.getElementById('derived-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.createDerivedVariable();
    });
    this.initDataTools?.();
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.derived-formula-wrap')) this._hideDerivedSuggestions();
        if (!e.target.closest('#derived-help-popover') && !e.target.closest('#derived-help-toggle')) {
            this._toggleDerivedHelpPopover(false);
        }
        if (!e.target.closest('#outlier-help-popover') && !e.target.closest('#outlier-help-toggle')) {
            this._toggleOutlierHelpPopover?.(false);
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !document.getElementById('derived-help-popover')?.hidden) {
            e.preventDefault();
            this._toggleDerivedHelpPopover(false);
            return;
        }
        if (e.key === 'Escape' && !document.getElementById('outlier-help-popover')?.hidden) {
            e.preventDefault();
            this._toggleOutlierHelpPopover?.(false);
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
        await this.loadFiles(files);
    });

    document.getElementById('link-time-axes').addEventListener('change', (e) => {
        this.plotManager.setSyncAxes(e.target.checked);
    });

    document.getElementById('sync-hover').addEventListener('change', (e) => {
        this.plotManager.setSyncHover(e.target.checked);
        this._syncHoverCornerPicker();
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

    document.querySelectorAll('input[name="legend-pos"]').forEach(radio => {
        radio.addEventListener('change', (e) => {
            this.plotManager.setLegendPosition(e.target.value);
            this._syncLegendCornerPicker();
        });
    });
    document.querySelectorAll('.legend-corner-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (btn.classList.contains('hover-corner-btn')) return;
            this.plotManager.setLegendOverlayCorner(btn.getAttribute('data-corner'));
            this._syncLegendCornerPicker();
        });
    });
    this._syncLegendCornerPicker();
    document.querySelectorAll('.hover-corner-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            this.plotManager.setHoverInfoCorner(btn.getAttribute('data-corner'));
            this._syncHoverCornerPicker();
        });
    });
    this._syncHoverCornerPicker();

    document.getElementById('reset-layout').addEventListener('click', async () => {
        const ok = await Modal.confirm(i18n.t('resetLayoutWarning'), {
            iconHtml: RESET_LAYOUT_ICON_SVG,
        });
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
    this._initLiveUpdateControls?.();

    this._initExampleMenu();
    this._initExtraMenu();
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

proto._syncHoverCornerPicker = function() {
    const picker = document.getElementById('sync-hover-corner-picker');
    if (!picker) return;

    const titleKeys = {
        tl: 'legendCornerTopLeft',
        tr: 'legendCornerTopRight',
        bl: 'legendCornerBottomLeft',
        br: 'legendCornerBottomRight',
    };

    picker.querySelectorAll('.hover-corner-btn').forEach(btn => {
        const corner = btn.getAttribute('data-corner');
        const label = i18n.t(titleKeys[corner] || 'legendCornerBottomLeft');
        const isActive = this.plotManager.hoverInfoCorner === corner;
        btn.classList.toggle('active', isActive);
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
};

proto._closePeerMenus = function(except = '') {
    if (except !== 'open-file') this._closeOpenFileMenu?.();
    if (except !== 'example') this._closeExampleMenu?.();
    if (except !== 'extra') this._closeExtraMenu?.();
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

    await Modal.alert(i18n.t(titleKey), this._formatTempPathModalBody(i18n.t(messageKey), path), {
        iconHtml: `<img src="${OPENMODELICA_MODELING_ICON_PATH}" alt="" class="modal-openmodelica-icon">`,
        className: 'modal-dialog-temp-path',
        html: true,
    });
};

proto._copyDymolaDirectoryPathToClipboard = async function() {
    const candidates = this._getDymolaDirectoryCandidates();
    const usedFallback = candidates.length === 0;
    const fallbackPaths = this._getDymolaDirectoryFallbackPaths();
    const path = usedFallback ? fallbackPaths.windows : candidates[0];
    const copied = await this._copyTextToClipboard(path);

    let messageKey = 'dymolaDirectoryPathCopyFailed';
    if (copied) {
        messageKey = usedFallback
            ? 'dymolaDirectoryPathCopiedUsernameUnknown'
            : 'dymolaDirectoryPathCopied';
    }

    const titleKey = copied
        ? 'dymolaDirectoryPathCopiedTitle'
        : 'dymolaDirectoryPathCopyFailedTitle';

    await Modal.alert(i18n.t(titleKey), this._formatTempPathModalBody(i18n.t(messageKey), path), {
        iconHtml: `<img src="${DYMOLA_LOGO_ICON_PATH}" alt="" class="modal-openmodelica-icon">`,
        className: 'modal-dialog-temp-path',
        html: true,
    });
};

proto._formatTempPathModalBody = function(template, path) {
    const escapeHtml = (text) => String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');

    const codeHtml = `<code class="modal-inline-code">${escapeHtml(path)}</code>`;
    let html = escapeHtml(String(template || '')).replaceAll('{path}', codeHtml);

    const firefoxPatterns = [
        'use Firefox.',
        'utilisez Firefox.',
        'usa Firefox.',
        'usa Firefox.',
    ];
    for (const pattern of firefoxPatterns) {
        html = html.replace(pattern, `<strong>${pattern}</strong>`);
    }

    return html
        .split(/\n\n+/)
        .map(paragraph => `<p>${paragraph.replace(/\n/g, '<br>')}</p>`)
        .join('');
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

proto._getDymolaDirectoryCandidates = function() {
    const userHome = this._inferWindowsUserHomeFromLocation();
    if (userHome) {
        return [`${userHome}\\Documents\\Dymola\\`];
    }
    return [];
};

proto._getDymolaDirectoryFallbackPaths = function() {
    return {
        windows: 'C:\\Users\\USERNAME\\Documents\\Dymola\\',
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
        this._closePeerMenus('example');
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
        const available = ex.getDataB64() != null || !!ex.script || !!ex.projectPath;
        const item = document.createElement('div');
        item.className = `example-menu-item example-menu-item-row${available ? '' : ' disabled'}`;
        item.setAttribute('role', 'group');

        const loadBtn = document.createElement('button');
        loadBtn.className = 'example-load-btn';
        loadBtn.type = 'button';
        loadBtn.disabled = !available;
        loadBtn.title = i18n.t('exampleLoadAction');

        const name = document.createElement('span');
        name.className = 'example-name';
        name.textContent = i18n.t(ex.nameKey);
        loadBtn.appendChild(name);
        item.appendChild(loadBtn);

        const actions = document.createElement('div');
        actions.className = 'example-menu-actions';
        item.appendChild(actions);

        const makeActionBtn = (content, titleKey, handler, options = {}) => {
            const btn = document.createElement('button');
            btn.className = 'example-action-btn';
            btn.type = 'button';
            if (options.html) btn.innerHTML = content;
            else btn.textContent = content;
            btn.title = i18n.t(titleKey);
            btn.setAttribute('aria-label', i18n.t(titleKey));
            if (options.className) btn.classList.add(options.className);
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                try {
                    await handler(btn);
                } catch (err) {
                    console.error(`Example model action failed (${titleKey}):`, err);
                    if (titleKey === 'exampleCopyModel') {
                        Modal.alert(
                            i18n.t('exampleModelCopyFailedTitle'),
                            i18n.t('exampleModelCopyFailedBody'),
                            { icon: '📋' },
                        );
                    } else {
                        alert(i18n.t('errorLoading') + ': ' + (err?.message || String(err)));
                    }
                }
            });
            return btn;
        };

        if (ex.modelicaPath) {
            actions.appendChild(makeActionBtn(
                '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a1 1 0 0 1 1 1v8.59l2.3-2.29a1 1 0 1 1 1.4 1.41l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 1.4-1.41L11 12.59V4a1 1 0 0 1 1-1Zm-7 14a1 1 0 0 1 1 1v1h12v-1a1 1 0 1 1 2 0v2a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1Z"/></svg>',
                'exampleDownloadModel',
                async (btn) => {
                    await this._flashExampleAction(btn, i18n.t('exampleModelDownloadStarted'));
                    await this._downloadExampleModel(ex);
                },
                { html: true, className: 'example-action-download' },
            ));
            actions.appendChild(makeActionBtn('⧉', 'exampleCopyModel', async (btn) => {
                await this._copyExampleModelToClipboard(ex);
                await this._flashExampleAction(btn, i18n.t('exampleModelCopied'));
            }));
        }

        if (!available) {
            const badge = document.createElement('span');
            badge.className = 'example-badge';
            badge.textContent = i18n.t('exampleComingSoon');
            actions.appendChild(badge);
        }

        loadBtn.addEventListener('click', () => {
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

proto._getExampleModelicaText = async function(example) {
    if (!example?.modelicaPath) throw new Error('Missing example Modelica path');
    const response = await fetch(example.modelicaPath, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Cannot load example model: ${response.status}`);
    return response.text();
};

proto._downloadExampleModel = async function(example) {
    const source = await this._getExampleModelicaText(example);
    const blob = new Blob([source], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = example.modelicaFileName || `${example.baseName || example.id}.mo`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
};

proto._copyExampleModelToClipboard = async function(example) {
    const source = await this._getExampleModelicaText(example);
    const copied = await this._copyTextToClipboard(source);
    if (!copied) throw new Error('Clipboard write failed');
};

proto._flashExampleAction = async function(button, message = '') {
    if (button) {
        button.classList.remove('action-feedback');
        void button.offsetWidth;
        button.classList.add('action-feedback');
    }
    if (message) this._showTransientStatus(message);
    await new Promise(resolve => setTimeout(resolve, 220));
    setTimeout(() => button?.classList.remove('action-feedback'), 520);
};

proto._showTransientStatus = function(message) {
    if (!message) return;
    let toast = document.getElementById('transient-status');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'transient-status';
        toast.className = 'transient-status';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.remove('show');
    if (this._transientStatusTimer) clearTimeout(this._transientStatusTimer);
    requestAnimationFrame(() => toast.classList.add('show'));
    this._transientStatusTimer = setTimeout(() => {
        toast.classList.remove('show');
    }, 1600);
};

proto.showDisplaySettings = function() {
    const previousActive = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal-dialog plot-settings-dialog';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'plot-settings-title');

    const content = document.createElement('div');
    content.className = 'modal-content plot-settings-content';

    const header = document.createElement('div');
    header.className = 'plot-settings-header';

    const heading = document.createElement('div');
    heading.className = 'plot-settings-heading';

    const headingIcon = document.createElement('span');
    headingIcon.className = 'plot-settings-heading-icon';
    headingIcon.innerHTML = helpIcon('align', 'plot-settings-heading-icon-svg');

    const title = document.createElement('div');
    title.id = 'plot-settings-title';
    title.className = 'modal-title plot-settings-title';
    title.textContent = i18n.t('displaySettingsTitle');

    const headerCloseBtn = document.createElement('button');
    headerCloseBtn.type = 'button';
    headerCloseBtn.className = 'plot-settings-header-close';
    headerCloseBtn.title = i18n.t('helpClose');
    headerCloseBtn.setAttribute('aria-label', i18n.t('helpClose'));
    headerCloseBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>';

    const helpWrap = document.createElement('div');
    helpWrap.className = 'plot-settings-help-wrap';

    const helpBtn = document.createElement('button');
    helpBtn.type = 'button';
    helpBtn.className = 'fft-help-btn plot-settings-help-btn';
    helpBtn.textContent = '?';
    helpBtn.title = i18n.t('displaySettingsHelpTitle');
    helpBtn.setAttribute('aria-label', i18n.t('displaySettingsHelpTitle'));
    helpBtn.setAttribute('aria-expanded', 'false');

    const escapeHtml = (value) => String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');

    const helpPopover = document.createElement('div');
    helpPopover.className = 'fft-help-popover plot-settings-help-popover';
    helpPopover.hidden = true;
    helpPopover.innerHTML = `
        <div class="plot-settings-help-title">${escapeHtml(i18n.t('displaySettingsHelpTitle'))}</div>
        <div class="plot-settings-help-row">
            <span>${escapeHtml(i18n.t('displaySettingsHelpTimeLabel'))}</span>
            <p>${escapeHtml(i18n.t('displaySettingsHelpTime'))}</p>
        </div>
        <div class="plot-settings-help-row">
            <span>${escapeHtml(i18n.t('displaySettingsHelpTrajectoryLabel'))}</span>
            <p>${escapeHtml(i18n.t('displaySettingsHelpTrajectory'))}</p>
        </div>
        <div class="plot-settings-help-row">
            <span>${escapeHtml(i18n.t('displaySettingsHelpLargeFilesLabel'))}</span>
            <p>${escapeHtml(i18n.t('displaySettingsHelpLargeFiles'))}</p>
        </div>
        <div class="plot-settings-help-row">
            <span>${escapeHtml(i18n.t('displaySettingsHelpDataLabel'))}</span>
            <p>${escapeHtml(i18n.t('displaySettingsHelpData'))}</p>
        </div>`;

    helpBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const show = helpPopover.hidden;
        helpPopover.hidden = !show;
        helpBtn.setAttribute('aria-expanded', String(show));
    });

    helpWrap.append(helpBtn, helpPopover);
    heading.append(headingIcon, title);
    header.append(heading, headerCloseBtn);

    const intro = document.createElement('p');
    intro.className = 'plot-settings-intro';
    intro.textContent = i18n.t('displaySettingsIntro');

    const form = document.createElement('div');
    form.className = 'plot-settings-form';

    const options = [
        ['2000', 'timeseriesDownsampling2k'],
        ['4000', 'timeseriesDownsampling4k'],
        ['6000', 'timeseriesDownsampling6k'],
        ['8000', 'timeseriesDownsampling8k'],
        ['10000', 'timeseriesDownsampling10k'],
        ['none', 'displaySettingsEveryPoint'],
    ];

    const currentValue = (value) => value == null ? 'none' : String(Math.round(Number(value)));
    const makeSelect = (id, labelKey, helpKey, value, selectOptions = options) => {
        const field = document.createElement('label');
        field.className = 'plot-settings-field';
        field.setAttribute('for', id);

        const label = document.createElement('span');
        label.className = 'plot-settings-label';
        label.textContent = i18n.t(labelKey);

        const select = document.createElement('select');
        select.id = id;
        select.className = 'plot-settings-select';
        for (const [optionValue, optionKey] of selectOptions) {
            const option = document.createElement('option');
            option.value = optionValue;
            option.textContent = i18n.t(optionKey);
            select.appendChild(option);
        }
        select.value = currentValue(value);

        const help = document.createElement('span');
        help.className = 'plot-settings-help';
        help.textContent = i18n.t(helpKey);

        field.append(label, select, help);
        return { field, select };
    };

    const timeControl = makeSelect(
        'timeseries-downsampling',
        'displaySettingsTimeDetail',
        'displaySettingsTimeDetailHelp',
        this.plotManager.timeseriesVisualMaxPoints,
    );
    const trajectoryControl = makeSelect(
        'phase-downsampling',
        'displaySettingsTrajectoryDetail',
        'displaySettingsTrajectoryDetailHelp',
        this.plotManager.phaseVisualMaxPoints,
    );

    const downsamplingSection = document.createElement('section');
    downsamplingSection.className = 'plot-settings-section downsampling-settings';

    const downsamplingHeader = document.createElement('div');
    downsamplingHeader.className = 'plot-settings-section-header';

    const downsamplingHeading = document.createElement('div');
    downsamplingHeading.className = 'plot-settings-section-title';
    downsamplingHeading.textContent = i18n.t('downsampling');

    downsamplingHeader.append(downsamplingHeading, helpWrap);

    const panZoomOptions = [
        ['auto', 'panZoomRefreshAuto'],
        ['smooth', 'panZoomRefreshSmooth'],
        ['responsive', 'panZoomRefreshResponsive'],
    ];

    const panZoomControl = makeSelect(
        'pan-zoom-refresh-mode',
        'panZoomRefreshMode',
        'panZoomRefreshModeHelp',
        this.advancedSettings?.panZoomRefreshMode || 'auto',
        panZoomOptions,
    );
    panZoomControl.select.value = ['auto', 'smooth', 'responsive'].includes(this.advancedSettings?.panZoomRefreshMode)
        ? this.advancedSettings.panZoomRefreshMode
        : 'auto';

    const fileSection = document.createElement('section');
    fileSection.className = 'plot-settings-section file-loading-settings';

    const fileIntro = document.createElement('p');
    fileIntro.className = 'plot-settings-section-intro';
    fileIntro.textContent = i18n.t('fileLoadingSettingsIntro');

    const fileGrid = document.createElement('div');
    fileGrid.className = 'file-limit-grid';

    const makeNumberField = (key, labelKey, helpKey, min, max) => {
        const field = document.createElement('label');
        field.className = 'file-limit-field';
        field.setAttribute('for', key);

        const label = document.createElement('span');
        label.className = 'plot-settings-label';
        label.textContent = i18n.t(labelKey);

        const inputWrap = document.createElement('span');
        inputWrap.className = 'file-limit-input-wrap';

        const input = document.createElement('input');
        input.id = key;
        input.className = 'file-limit-input';
        input.type = 'number';
        input.min = String(min);
        input.max = String(max);
        input.step = '1';
        input.value = String(this.advancedSettings?.[key] ?? this._defaultAdvancedSettings()[key]);

        const unit = document.createElement('span');
        unit.className = 'file-limit-unit';
        unit.textContent = 'MB';
        inputWrap.append(input, unit);

        const help = document.createElement('span');
        help.className = 'plot-settings-help';
        help.textContent = i18n.t(helpKey);

        field.append(label, inputWrap, help);
        return { field, input, key };
    };

    const fileLimitControls = [
        makeNumberField('csvFullLoadMb', 'csvFullLoadLimit', 'csvFullLoadLimitHelp', 10, 1000),
        makeNumberField('parquetFullLoadMb', 'parquetFullLoadLimit', 'parquetFullLoadLimitHelp', 10, 1000),
        makeNumberField('matlabFullLoadMb', 'matlabFullLoadLimit', 'matlabFullLoadLimitHelp', 10, 2048),
        makeNumberField('excelFullLoadMb', 'excelFullLoadLimit', 'excelFullLoadLimitHelp', 10, 500),
        makeNumberField('pickleFullLoadMb', 'pickleFullLoadLimit', 'pickleFullLoadLimitHelp', 10, 1000),
        makeNumberField('pypsaNetcdfFullLoadMb', 'pypsaNetcdfFullLoadLimit', 'pypsaNetcdfFullLoadLimitHelp', 50, 2048),
    ];

    const compactControl = makeNumberField('csvCompactHintMb', 'csvCompactHintLimit', 'csvCompactHintLimitHelp', 100, 4096);
    compactControl.field.classList.add('compact-format-limit-field');

    const compactHelp = document.createElement('button');
    compactHelp.type = 'button';
    compactHelp.className = 'fft-help-btn compact-format-help-btn';
    compactHelp.textContent = '?';
    compactHelp.title = i18n.t('compactFormatHelpTitle');
    compactHelp.setAttribute('aria-label', i18n.t('compactFormatHelpTitle'));
    compactHelp.setAttribute('aria-expanded', 'false');

    const compactPopover = document.createElement('div');
    compactPopover.className = 'fft-help-popover compact-format-help-popover';
    compactPopover.hidden = true;
    compactPopover.textContent = i18n.t('compactFormatHelpBody');

    const compactLabel = compactControl.field.querySelector('.plot-settings-label');
    const compactLabelWrap = document.createElement('span');
    compactLabelWrap.className = 'compact-format-label-wrap';
    compactLabel.replaceWith(compactLabelWrap);
    compactLabelWrap.append(compactLabel, compactHelp, compactPopover);
    compactHelp.addEventListener('click', (event) => {
        event.stopPropagation();
        const show = compactPopover.hidden;
        compactPopover.hidden = !show;
        compactHelp.setAttribute('aria-expanded', String(show));
    });

    const applyFileSettings = () => {
        const next = { ...(this.advancedSettings || {}) };
        for (const control of [...fileLimitControls, compactControl]) {
            next[control.key] = Number(control.input.value);
        }
        this._saveAdvancedSettings(next);
        for (const control of [...fileLimitControls, compactControl]) {
            control.input.value = String(this.advancedSettings[control.key]);
        }
    };

    for (const control of [...fileLimitControls, compactControl]) {
        control.input.addEventListener('change', applyFileSettings);
    }

    const applyPanZoomSettings = () => {
        const nextMode = panZoomControl.select.value;
        this.plotManager.setRelayoutRefreshMode(nextMode);
        this._saveAdvancedSettings({ ...(this.advancedSettings || {}), panZoomRefreshMode: nextMode });
        panZoomControl.select.value = this.advancedSettings.panZoomRefreshMode;
    };
    panZoomControl.select.addEventListener('change', applyPanZoomSettings);

    fileGrid.append(...fileLimitControls.map(control => control.field), compactControl.field);
    fileSection.append(fileGrid);

    const applySettings = () => {
        const timeRaw = timeControl.select.value;
        const trajectoryRaw = trajectoryControl.select.value;
        this.plotManager.setTimeseriesDownsamplingLimit(timeRaw === 'none' ? null : Number(timeRaw));
        this.plotManager.setPhaseDownsamplingLimit(trajectoryRaw === 'none' ? null : Number(trajectoryRaw));
    };

    timeControl.select.addEventListener('change', applySettings);
    trajectoryControl.select.addEventListener('change', applySettings);
    form.classList.add('plot-settings-form-compact');

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'modal-btn modal-btn-cancel plot-settings-reset';
    resetBtn.textContent = i18n.t('resetDisplaySettings');
    resetBtn.addEventListener('click', () => {
        timeControl.select.value = '2000';
        trajectoryControl.select.value = '4000';
        applySettings();
        this._resetAdvancedSettings();
        this.plotManager.setRelayoutRefreshMode(this.advancedSettings.panZoomRefreshMode);
        panZoomControl.select.value = this.advancedSettings.panZoomRefreshMode;
        for (const control of [...fileLimitControls, compactControl]) {
            control.input.value = String(this.advancedSettings[control.key]);
        }
    });

    form.append(timeControl.field, trajectoryControl.field, panZoomControl.field);
    downsamplingSection.append(downsamplingHeader, form);

    const buttons = document.createElement('div');
    buttons.className = 'modal-buttons plot-settings-buttons';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'modal-btn modal-btn-confirm';
    closeBtn.textContent = i18n.t('helpClose');

    buttons.append(resetBtn, closeBtn);

    const settingsMain = document.createElement('div');
    settingsMain.className = 'plot-settings-main';

    const settingsSidebar = document.createElement('nav');
    settingsSidebar.className = 'plot-settings-sidebar';
    settingsSidebar.setAttribute('role', 'tablist');
    settingsSidebar.setAttribute('aria-label', i18n.t('displaySettingsTitle'));

    const settingsPanels = document.createElement('div');
    settingsPanels.className = 'plot-settings-panels';

    const makeTopicButton = (id, label, icon, color, panelId) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.id = id;
        button.className = 'plot-settings-topic-button';
        button.setAttribute('role', 'tab');
        button.setAttribute('aria-controls', panelId);
        button.style.setProperty('--settings-topic-color', color);
        button.innerHTML = `<span class="plot-settings-topic-icon">${helpIcon(icon, 'plot-settings-topic-icon-svg')}</span><span class="plot-settings-topic-label"></span>`;
        button.querySelector('.plot-settings-topic-label').textContent = label;
        return button;
    };

    const visualTab = makeTopicButton(
        'plot-settings-visual-tab',
        i18n.t('visualSettingsTitle'),
        'chart',
        '#8b5cf6',
        'plot-settings-visual-panel',
    );
    const fileTab = makeTopicButton(
        'plot-settings-file-tab',
        i18n.t('fileLoadingSettingsTitle'),
        'folder',
        '#f59e0b',
        'plot-settings-file-panel',
    );

    const makePanelHeading = (titleText, introElement, icon, color) => {
        const panelHeader = document.createElement('div');
        panelHeader.className = 'plot-settings-panel-header';
        panelHeader.style.setProperty('--settings-topic-color', color);
        const iconWrap = document.createElement('span');
        iconWrap.className = 'plot-settings-panel-icon';
        iconWrap.innerHTML = helpIcon(icon, 'plot-settings-panel-icon-svg');
        const copy = document.createElement('div');
        copy.className = 'plot-settings-panel-heading-copy';
        const panelTitle = document.createElement('h3');
        panelTitle.textContent = titleText;
        copy.append(panelTitle, introElement);
        panelHeader.append(iconWrap, copy);
        return panelHeader;
    };

    const visualPanel = document.createElement('section');
    visualPanel.id = 'plot-settings-visual-panel';
    visualPanel.className = 'plot-settings-panel';
    visualPanel.setAttribute('role', 'tabpanel');
    visualPanel.setAttribute('aria-labelledby', visualTab.id);
    visualPanel.tabIndex = 0;
    visualPanel.append(
        makePanelHeading(i18n.t('visualSettingsTitle'), intro, 'chart', '#8b5cf6'),
        downsamplingSection,
    );

    const filePanel = document.createElement('section');
    filePanel.id = 'plot-settings-file-panel';
    filePanel.className = 'plot-settings-panel';
    filePanel.setAttribute('role', 'tabpanel');
    filePanel.setAttribute('aria-labelledby', fileTab.id);
    filePanel.tabIndex = 0;
    filePanel.append(
        makePanelHeading(i18n.t('fileLoadingSettingsTitle'), fileIntro, 'folder', '#f59e0b'),
        fileSection,
    );

    const tabs = [visualTab, fileTab];
    const panels = [visualPanel, filePanel];
    const selectSettingsTopic = (index, focus = false) => {
        tabs.forEach((tab, tabIndex) => {
            const selected = tabIndex === index;
            tab.classList.toggle('active', selected);
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            panels[tabIndex].hidden = !selected;
        });
        settingsPanels.scrollTop = 0;
        if (focus) tabs[index]?.focus();
    };
    tabs.forEach((tab, index) => {
        tab.addEventListener('click', () => selectSettingsTopic(index));
        tab.addEventListener('keydown', event => {
            let next = null;
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % tabs.length;
            else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = tabs.length - 1;
            if (next == null) return;
            event.preventDefault();
            selectSettingsTopic(next, true);
            tabs[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
    });

    settingsSidebar.append(...tabs);
    settingsPanels.append(...panels);
    settingsMain.append(settingsSidebar, settingsPanels);
    content.append(header, settingsMain, buttons);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    selectSettingsTopic(0);

    let settled = false;
    const finish = () => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', escHandler);
        Modal.close(overlay, previousActive);
    };

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            finish();
            return;
        }
        if (!helpPopover.hidden && !e.target.closest('.plot-settings-help-wrap')) {
            helpPopover.hidden = true;
            helpBtn.setAttribute('aria-expanded', 'false');
        }
        if (!compactPopover.hidden && !e.target.closest('.compact-format-label-wrap')) {
            compactPopover.hidden = true;
            compactHelp.setAttribute('aria-expanded', 'false');
        }
    });
    const escHandler = (e) => {
        if (e.key === 'Tab') {
            const focusable = [...modal.querySelectorAll('button:not([disabled]), select:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
                .filter(element => !element.hidden && element.offsetParent !== null);
            if (focusable.length) {
                const first = focusable[0];
                const last = focusable[focusable.length - 1];
                if (e.shiftKey && document.activeElement === first) {
                    e.preventDefault();
                    last.focus();
                } else if (!e.shiftKey && document.activeElement === last) {
                    e.preventDefault();
                    first.focus();
                }
            }
            return;
        }
        if (e.key === 'Escape' && !helpPopover.hidden) {
            e.preventDefault();
            helpPopover.hidden = true;
            helpBtn.setAttribute('aria-expanded', 'false');
            return;
        }
        if (e.key === 'Escape' && !compactPopover.hidden) {
            e.preventDefault();
            compactPopover.hidden = true;
            compactHelp.setAttribute('aria-expanded', 'false');
            return;
        }
        if (e.key === 'Escape') finish();
    };
    document.addEventListener('keydown', escHandler);
    headerCloseBtn.addEventListener('click', finish);
    closeBtn.addEventListener('click', finish);

    requestAnimationFrame(() => overlay.classList.add('show'));
    setTimeout(() => visualTab.focus(), 100);
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
        this._closePeerMenus('extra');
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
        if (options.titleKey) item.title = i18n.t(options.titleKey);

        const iconSpan = document.createElement('span');
        iconSpan.className = 'extra-menu-icon';
        if (options.iconClass) iconSpan.classList.add(options.iconClass);
        if (options.iconHtml) iconSpan.innerHTML = icon;
        else iconSpan.textContent = icon;

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
        this.showFeedbackForm();
    });

    const saveViewItem = makeAction('💾', 'extraSaveViewJson', () => {
        this.saveViewSession().catch(err => {
            console.error('Save view failed:', err);
            Modal.alert(i18n.t('sessionLoadFailedTitle'), err?.message || String(err), { icon: '💾' });
        });
    }, { titleKey: 'extraSaveViewJsonTooltip' });

    const saveProjectItem = makeAction('📦', 'extraSaveProjectZip', () => {
        this.saveProjectSession().catch(err => {
            console.error('Save project failed:', err);
            Modal.alert(i18n.t('sessionLoadFailedTitle'), err?.message || String(err), { icon: '📦' });
        });
    }, { titleKey: 'extraSaveProjectZipTooltip' });

    const loadSessionItem = makeAction('📂', 'extraLoadSessionProject', () => {
        this.openSessionOrProjectFromUser().catch(err => {
            if (err?.name === 'AbortError') return;
            console.error('Load session failed:', err);
            Modal.alert(i18n.t('sessionLoadFailedTitle'), err?.message || String(err), { icon: '📂' });
        });
    }, { titleKey: 'extraLoadSessionProjectTooltip' });

    const displaySettingsItem = makeAction(
        '⛭',
        'extraDisplaySettings',
        () => this.showDisplaySettings(),
        {
            titleKey: 'extraDisplaySettingsTooltip',
            iconClass: 'extra-menu-icon-settings',
        },
    );

    const helpItem = makeAction('?', 'help', () => {
        this.showHelp();
    });

    const desktopDownloadItem = this.capabilities?.isDesktop
        ? makeAction('🌐', 'extraOnlineVersion', () => {
            window.open(ONLINE_VERSION_URL, '_blank', 'noopener');
        }, { titleKey: 'extraOnlineVersionTooltip' })
        : makeAction('📦', 'extraStandalone', () => {
            this._downloadDesktopPackage();
        });

    const openTempItem = makeAction(
        `<img src="${OPENMODELICA_MODELING_ICON_PATH}" alt="">`,
        'openOpenModelicaTemp',
        () => {
            this._copyOpenModelicaTempPathToClipboard().catch(err => {
                console.error('Copy OpenModelica temp path failed:', err);
                alert(i18n.t('errorLoading') + ': ' + (err?.message || String(err)));
            });
        },
        { iconHtml: true },
    );

    const dymolaDirItem = makeAction(
        `<img src="${DYMOLA_LOGO_ICON_PATH}" alt="">`,
        'openDymolaDirectory',
        () => {
            this._copyDymolaDirectoryPathToClipboard().catch(err => {
                console.error('Copy Dymola directory path failed:', err);
                alert(i18n.t('errorLoading') + ': ' + (err?.message || String(err)));
            });
        },
        { iconHtml: true },
    );

    const versionRow = document.createElement('div');
    versionRow.className = 'example-menu-item extra-menu-static extra-version-row';

    const versionIcon = document.createElement('span');
    versionIcon.className = 'extra-menu-icon';
    versionIcon.textContent = '🏷';

    const versionLabel = document.createElement('span');
    versionLabel.className = 'example-name';
    versionLabel.textContent = i18n.t('extraVersion');

    const versionValue = document.createElement('span');
    versionValue.className = 'example-badge extra-version-badge';
    versionValue.textContent = `v${APP_VERSION}`;

    // Build provenance (commit + date) injected by Vite; helps testers report
    // exactly which build they are running on the rolling web version.
    const buildParts = [];
    if (BUILD_SHA) buildParts.push(`#${BUILD_SHA}`);
    if (BUILD_DATE) buildParts.push(BUILD_DATE.slice(0, 10));
    const buildText = buildParts.join(' · ');

    const versionBuild = document.createElement('span');
    versionBuild.className = 'extra-version-build';
    versionBuild.textContent = buildText;

    versionRow.title = buildText ? `v${APP_VERSION} — ${buildText}` : `v${APP_VERSION}`;

    versionRow.append(versionIcon, versionLabel, versionValue);
    if (buildText) versionRow.append(versionBuild);

    const items = [saveViewItem, saveProjectItem, loadSessionItem, displaySettingsItem];
    if (this.capabilities?.canUseLocalPath) {
        items.push(openTempItem, dymolaDirItem);
    }
    items.push(desktopDownloadItem, feedbackItem, versionRow, helpItem);
    menu.append(...items);
};

proto.showFeedbackForm = function() {
    const previousActive = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay feedback-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal-dialog feedback-dialog';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'feedback-title');

    const form = document.createElement('form');
    form.className = 'modal-content feedback-content';

    const header = document.createElement('div');
    header.className = 'feedback-header';

    const icon = document.createElement('div');
    icon.className = 'modal-icon feedback-icon';
    icon.textContent = '💬';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'feedback-title-wrap';
    const title = document.createElement('h2');
    title.id = 'feedback-title';
    title.className = 'modal-title';
    title.textContent = i18n.t('feedbackTitle');
    const intro = document.createElement('p');
    intro.className = 'feedback-intro';
    intro.textContent = i18n.t('feedbackIntro');
    titleWrap.append(title, intro);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'desktop-download-close feedback-close';
    closeButton.setAttribute('aria-label', i18n.t('helpClose'));
    closeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6 6 18"/></svg>';

    header.append(icon, titleWrap, closeButton);

    const fields = document.createElement('div');
    fields.className = 'feedback-fields';

    const contact = this._createFeedbackField('feedbackContactLabel', 'input', {
        type: 'email',
        autocomplete: 'email',
        placeholder: i18n.t('feedbackContactPlaceholder'),
    });
    const category = this._createFeedbackField('feedbackCategoryLabel', 'select');
    [
        ['bug', i18n.t('feedbackCategoryBug')],
        ['idea', i18n.t('feedbackCategoryIdea')],
        ['question', i18n.t('feedbackCategoryQuestion')],
    ].forEach(([value, label]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        category.control.appendChild(option);
    });
    const summary = this._createFeedbackField('feedbackSummaryLabel', 'input', {
        type: 'text',
        required: true,
        maxlength: '140',
        placeholder: i18n.t('feedbackSummaryPlaceholder'),
    });
    const details = this._createFeedbackField('feedbackDetailsLabel', 'textarea', {
        required: true,
        rows: '5',
        placeholder: i18n.t('feedbackDetailsPlaceholder'),
    });
    const expected = this._createFeedbackField('feedbackExpectedLabel', 'textarea', {
        rows: '3',
        placeholder: i18n.t('feedbackExpectedPlaceholder'),
    });
    fields.append(contact.wrap, category.wrap, summary.wrap, details.wrap, expected.wrap);

    const attachmentSection = document.createElement('div');
    attachmentSection.className = 'feedback-attachments';

    const pasteZone = document.createElement('div');
    pasteZone.className = 'feedback-paste-zone';
    pasteZone.tabIndex = 0;
    pasteZone.textContent = i18n.t('feedbackPasteZone');

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.multiple = true;
    fileInput.className = 'feedback-file-input';

    const fileButton = document.createElement('button');
    fileButton.type = 'button';
    fileButton.className = 'modal-btn modal-btn-cancel feedback-file-button';
    fileButton.textContent = i18n.t('feedbackChooseFiles');

    const fileList = document.createElement('div');
    fileList.className = 'feedback-file-list';
    fileList.textContent = i18n.t('feedbackNoFiles');

    const safety = document.createElement('p');
    safety.className = 'feedback-safety';
    safety.textContent = i18n.t('feedbackSafetyNote');

    attachmentSection.append(pasteZone, fileInput, fileButton, fileList, safety);

    const nextSteps = document.createElement('div');
    nextSteps.className = 'feedback-next-steps';
    const nextTitle = document.createElement('h3');
    nextTitle.textContent = i18n.t('feedbackNextTitle');
    const githubStep = document.createElement('p');
    githubStep.textContent = i18n.t('feedbackNextGithub');
    const emailStep = document.createElement('p');
    emailStep.textContent = i18n.t('feedbackNextEmail');
    nextSteps.append(nextTitle, githubStep, emailStep);

    const actions = document.createElement('div');
    actions.className = 'modal-buttons feedback-actions';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'modal-btn modal-btn-cancel';
    cancelButton.textContent = i18n.t('cancel');
    const emailButton = document.createElement('button');
    emailButton.type = 'button';
    emailButton.className = 'modal-btn modal-btn-cancel';
    emailButton.textContent = i18n.t('feedbackEmailInstead');
    const issueButton = document.createElement('button');
    issueButton.type = 'submit';
    issueButton.className = 'modal-btn modal-btn-confirm';
    issueButton.textContent = i18n.t('feedbackOpenIssue');
    actions.append(cancelButton, emailButton, issueButton);

    form.append(header, fields, attachmentSection, nextSteps, actions);
    modal.appendChild(form);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    const attachedFiles = [];
    const releasePreview = (attachment) => {
        if (attachment?.previewUrl) {
            URL.revokeObjectURL(attachment.previewUrl);
            attachment.previewUrl = '';
        }
    };
    const finish = () => {
        attachedFiles.forEach(releasePreview);
        Modal.close(overlay, previousActive);
    };
    const renderFiles = () => {
        if (!attachedFiles.length) {
            fileList.textContent = i18n.t('feedbackNoFiles');
            return;
        }
        const total = attachedFiles.reduce((sum, attachment) => sum + attachment.file.size, 0);
        fileList.innerHTML = '';
        const list = document.createElement('ul');
        attachedFiles.forEach((attachment, index) => {
            const file = attachment.file;
            const row = document.createElement('li');
            if (attachment.previewUrl) {
                const preview = document.createElement('img');
                preview.className = 'feedback-file-preview';
                preview.src = attachment.previewUrl;
                preview.alt = file.name || `attachment-${index + 1}`;
                row.appendChild(preview);
            } else {
                const icon = document.createElement('span');
                icon.className = 'feedback-file-generic';
                icon.textContent = 'FILE';
                row.appendChild(icon);
            }

            const meta = document.createElement('span');
            meta.className = 'feedback-file-meta';
            const name = document.createElement('span');
            name.className = 'feedback-file-name';
            name.textContent = file.name || `attachment-${index + 1}`;
            const size = document.createElement('span');
            size.className = 'feedback-file-size';
            size.textContent = this._formatFeedbackBytes(file.size);
            meta.append(name, size);

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = i18n.t('feedbackRemoveFile');
            remove.addEventListener('click', () => {
                const [removed] = attachedFiles.splice(index, 1);
                releasePreview(removed);
                renderFiles();
            });
            row.append(meta, remove);
            list.appendChild(row);
        });
        fileList.appendChild(list);
        const totalLine = document.createElement('div');
        totalLine.className = total > FEEDBACK_MAX_PACKAGE_BYTES ? 'feedback-total is-too-large' : 'feedback-total';
        totalLine.textContent = i18n.t('feedbackTotalSize').replace('{size}', this._formatFeedbackBytes(total));
        fileList.appendChild(totalLine);
    };
    const addFiles = (files, source = 'file') => {
        Array.from(files || []).forEach((file, index) => {
            if (!file) return;
            const name = this._feedbackAttachmentName(file, attachedFiles, { source, index });
            const wrappedFile = new File([file], name, { type: file.type || 'application/octet-stream', lastModified: file.lastModified || Date.now() });
            attachedFiles.push({
                file: wrappedFile,
                previewUrl: wrappedFile.type.startsWith('image/') ? URL.createObjectURL(wrappedFile) : '',
            });
        });
        renderFiles();
    };
    const collectFeedback = () => ({
        contact: contact.control.value.trim(),
        category: category.control.value,
        summary: summary.control.value.trim(),
        details: details.control.value.trim(),
        expected: expected.control.value.trim(),
        appVersion: APP_VERSION,
        buildSha: BUILD_SHA,
        buildDate: BUILD_DATE,
        pageUrl: window.location.href,
        userAgent: navigator.userAgent,
        createdAt: new Date().toISOString(),
        attachmentNames: attachedFiles.map(attachment => attachment.file.name),
    });
    const ensureValid = () => {
        if (!form.reportValidity()) return false;
        const total = attachedFiles.reduce((sum, attachment) => sum + attachment.file.size, 0);
        if (total > FEEDBACK_MAX_PACKAGE_BYTES) {
            Modal.alert(i18n.t('feedbackPackageTooLargeTitle'), i18n.t('feedbackPackageTooLargeBody'), { icon: 'ZIP' });
            return false;
        }
        return true;
    };
    const downloadPackage = async () => {
        if (!ensureValid()) return null;
        const feedback = collectFeedback();
        const zipEntries = {
            'feedback.json': strToU8(`${JSON.stringify(feedback, null, 2)}\n`),
            'feedback.txt': strToU8(this._formatFeedbackIssueBody(feedback, true)),
        };
        const used = new Set(Object.keys(zipEntries).map(name => name.toLowerCase()));
        for (const attachment of attachedFiles) {
            const file = attachment.file;
            const path = `attachments/${this._uniqueFeedbackArchiveName(file.name, used)}`;
            zipEntries[path] = new Uint8Array(await file.arrayBuffer());
        }
        const zip = zipSync(zipEntries, { level: 6 });
        const filename = this._feedbackPackageFileName(feedback);
        if (typeof this._downloadBlob === 'function') {
            this._downloadBlob(new Blob([zip], { type: 'application/zip' }), filename);
        } else {
            this._downloadFeedbackBlob(new Blob([zip], { type: 'application/zip' }), filename);
        }
        return { feedback, filename };
    };
    const openIssue = (feedback, filename) => {
        const subject = `[Time Series Explorer] ${feedback.summary || i18n.t('extraFeedback')}`;
        const body = this._formatFeedbackIssueBody(feedback, false, filename);
        const params = new URLSearchParams({
            title: subject,
            body,
            labels: 'feedback',
        });
        window.open(`${FEEDBACK_ISSUES_URL}?${params.toString()}`, '_blank', 'noopener');
    };
    const openEmail = (feedback, filename) => {
        const subject = `[Time Series Explorer feedback] ${feedback.summary || i18n.t('extraFeedback')}`;
        const body = this._formatFeedbackEmailBody(feedback, filename);
        const params = new URLSearchParams({ subject, body });
        window.open(`mailto:${encodeURIComponent(FEEDBACK_EMAIL)}?${params.toString()}`, '_blank', 'noopener');
    };
    const prepareForExternalSend = async () => {
        if (!ensureValid()) return null;
        if (!attachedFiles.length) return { feedback: collectFeedback(), filename: '' };
        return await downloadPackage();
    };

    fileButton.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
        addFiles(fileInput.files);
        fileInput.value = '';
    });
    pasteZone.addEventListener('paste', (event) => {
        addFiles(event.clipboardData?.files || [], 'paste');
    });
    pasteZone.addEventListener('dragover', (event) => {
        event.preventDefault();
        pasteZone.classList.add('is-dragover');
    });
    pasteZone.addEventListener('dragleave', () => pasteZone.classList.remove('is-dragover'));
    pasteZone.addEventListener('drop', (event) => {
        event.preventDefault();
        pasteZone.classList.remove('is-dragover');
        addFiles(event.dataTransfer?.files || []);
    });
    emailButton.addEventListener('click', () => {
        prepareForExternalSend().then(result => {
            if (result) openEmail(result.feedback, result.filename);
        }).catch(err => {
            console.error('Feedback email failed:', err);
            Modal.alert(i18n.t('feedbackPackageFailedTitle'), err?.message || String(err), { icon: 'ZIP' });
        });
    });
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        prepareForExternalSend()
            .then(result => {
                if (result) openIssue(result.feedback, result.filename);
            })
            .catch(err => {
                console.error('Feedback submit failed:', err);
                Modal.alert(i18n.t('feedbackPackageFailedTitle'), err?.message || String(err), { icon: 'ZIP' });
            });
    });
    closeButton.addEventListener('click', finish);
    cancelButton.addEventListener('click', finish);

    requestAnimationFrame(() => overlay.classList.add('show'));
    setTimeout(() => summary.control.focus(), 100);
};

proto._createFeedbackField = function(labelKey, tagName, attributes = {}) {
    const wrap = document.createElement('label');
    wrap.className = 'feedback-field';
    const label = document.createElement('span');
    label.textContent = i18n.t(labelKey);
    const control = document.createElement(tagName);
    control.className = 'feedback-control';
    Object.entries(attributes).forEach(([key, value]) => {
        if (value === true) control.setAttribute(key, '');
        else if (value !== false && value != null) control.setAttribute(key, value);
    });
    wrap.append(label, control);
    return { wrap, control };
};

proto._formatFeedbackIssueBody = function(feedback, includeAttachmentList = false, packageFilename = '') {
    const lines = [
        'Time Series Explorer feedback',
        '',
        `Category: ${feedback.category}`,
        `Contact: ${feedback.contact || 'not provided'}`,
        `Summary: ${feedback.summary}`,
        '',
        'Details:',
        feedback.details || '-',
        '',
        'Expected / useful context:',
        feedback.expected || '-',
        '',
        'Build:',
        `Version: ${feedback.appVersion}`,
        `Commit: ${feedback.buildSha}`,
        `Build date: ${feedback.buildDate || '-'}`,
        `URL: ${feedback.pageUrl}`,
        `User agent: ${feedback.userAgent}`,
    ];
    if (packageFilename) {
        lines.push('', `Attach the downloaded package to the GitHub issue if it is safe to share: ${packageFilename}`);
    }
    if (includeAttachmentList) {
        lines.push('', 'Attachments:', ...(feedback.attachmentNames.length ? feedback.attachmentNames : ['none']));
    }
    return `${lines.join('\n')}\n`;
};

proto._formatFeedbackEmailBody = function(feedback, packageFilename = '') {
    const lines = [
        this._formatFeedbackIssueBody(feedback, false, ''),
        'No GitHub account:',
        'Please send this email to the maintainer. The maintainer can create the GitHub issue from this report.',
    ];
    if (packageFilename) {
        lines.push('', `Please attach the downloaded zip file to this email: ${packageFilename}`);
    }
    return `${lines.join('\n')}\n`;
};

proto._formatFeedbackBytes = function(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

proto._feedbackAttachmentName = function(file, attachments, options = {}) {
    const source = options.source || 'file';
    const original = String(file?.name || '').trim();
    const type = String(file?.type || '');
    const extensionFromType = type.includes('/') ? type.split('/').pop().replace('jpeg', 'jpg').replace(/[^a-z0-9]/gi, '') : '';
    const originalExtensionMatch = /\.([A-Za-z0-9]{1,8})$/.exec(original);
    const originalExtension = originalExtensionMatch ? originalExtensionMatch[1] : '';
    const extension = (originalExtension || extensionFromType || 'bin').toLowerCase();
    const isGenericClipboardImage = source === 'paste'
        && type.startsWith('image/')
        && (!original || /^image\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(original));

    const base = isGenericClipboardImage
        ? `screenshot-${this._nextFeedbackScreenshotNumber(attachments)}`
        : this._safeFeedbackFileName(original || `attachment-${(options.index || 0) + 1}`);

    const withExtension = /\.[A-Za-z0-9]{1,8}$/.test(base) ? base : `${base}.${extension}`;
    return this._uniqueFeedbackDisplayName(withExtension, attachments);
};

proto._nextFeedbackScreenshotNumber = function(attachments) {
    let highest = 0;
    for (const attachment of attachments || []) {
        const match = /^screenshot-(\d+)\./i.exec(attachment?.file?.name || '');
        if (match) highest = Math.max(highest, Number(match[1]) || 0);
    }
    return highest + 1;
};

proto._uniqueFeedbackDisplayName = function(filename, attachments) {
    const safe = this._safeFeedbackFileName(filename);
    const used = new Set((attachments || []).map(attachment => String(attachment?.file?.name || '').toLowerCase()));
    let candidate = safe;
    let index = 2;
    while (used.has(candidate.toLowerCase())) {
        const dot = safe.lastIndexOf('.');
        candidate = dot > 0
            ? `${safe.slice(0, dot)}-${index}${safe.slice(dot)}`
            : `${safe}-${index}`;
        index += 1;
    }
    return candidate;
};

proto._feedbackPackageFileName = function(feedback) {
    const stamp = feedback.createdAt.slice(0, 19).replace(/[T:]/g, '-');
    const summary = this._safeFeedbackFileName(feedback.summary || 'feedback').slice(0, 48) || 'feedback';
    return `timeseries-explorer-feedback-${stamp}-${summary}.zip`;
};

proto._safeFeedbackFileName = function(name) {
    return String(name || 'attachment')
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '-')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'attachment';
};

proto._uniqueFeedbackArchiveName = function(filename, used) {
    const safe = this._safeFeedbackFileName(filename);
    let candidate = safe;
    let index = 2;
    while (used.has(`attachments/${candidate}`.toLowerCase())) {
        const dot = safe.lastIndexOf('.');
        candidate = dot > 0
            ? `${safe.slice(0, dot)}-${index}${safe.slice(dot)}`
            : `${safe}-${index}`;
        index += 1;
    }
    used.add(`attachments/${candidate}`.toLowerCase());
    return candidate;
};

proto._downloadFeedbackBlob = function(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
};

proto._downloadDesktopPackage = async function() {
    try {
        const response = await fetch(DESKTOP_MANIFEST_PATH, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Missing manifest: ${response.status}`);

        const manifest = await response.json();
        if (!manifest || typeof manifest !== 'object') throw new Error('Invalid desktop download manifest');

        let publishedAssets = null;
        if (manifest.releaseApiUrl) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 4000);
            try {
                const releaseResponse = await fetch(manifest.releaseApiUrl, {
                    cache: 'no-store',
                    headers: { Accept: 'application/vnd.github+json' },
                    signal: controller.signal,
                });
                if (releaseResponse.status === 404) {
                    publishedAssets = new Map();
                } else if (releaseResponse.ok) {
                    const release = await releaseResponse.json();
                    publishedAssets = new Map(
                        (Array.isArray(release?.assets) ? release.assets : [])
                            .filter(asset => asset?.name && asset?.browser_download_url)
                            .map(asset => [asset.name, asset.browser_download_url]),
                    );
                }
            } catch (_) {
                // Keep the manifest status when GitHub is offline or rate-limited.
            } finally {
                clearTimeout(timeout);
            }
        }

        this._showDesktopDownloadDialog(manifest, publishedAssets);
    } catch {
        Modal.alert(i18n.t('extraStandalone'), i18n.t('extraStandaloneUnavailableBody'), { icon: '📦' });
    }
};

proto._showDesktopDownloadDialog = function(manifest, publishedAssets = null) {
    const previousActive = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay desktop-download-overlay';

    const modal = document.createElement('div');
    modal.className = 'modal-dialog desktop-download-dialog';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'desktop-download-title');
    modal.setAttribute('aria-describedby', 'desktop-download-intro');

    const content = document.createElement('div');
    content.className = 'modal-content desktop-download-content';

    const header = document.createElement('header');
    header.className = 'desktop-download-header';
    const heading = document.createElement('div');
    heading.className = 'desktop-download-heading';
    const headingIcon = document.createElement('span');
    headingIcon.className = 'desktop-download-heading-icon';
    headingIcon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v11m0 0 4-4m-4 4-4-4"/><path d="M5 18v2h14v-2"/></svg>';
    const headingCopy = document.createElement('div');
    headingCopy.className = 'desktop-download-heading-copy';
    const title = document.createElement('h2');
    title.id = 'desktop-download-title';
    title.textContent = i18n.t('desktopDownloadTitle');
    const version = document.createElement('span');
    version.className = 'desktop-download-version';
    version.textContent = `v${manifest.version || APP_VERSION} · ${i18n.t('desktopDownloadBeta')}`;
    headingCopy.append(title, version);
    heading.append(headingIcon, headingCopy);

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'desktop-download-close';
    closeButton.title = i18n.t('helpClose');
    closeButton.setAttribute('aria-label', i18n.t('helpClose'));
    closeButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    header.append(heading, closeButton);

    const intro = document.createElement('p');
    intro.id = 'desktop-download-intro';
    intro.className = 'desktop-download-intro';
    intro.textContent = i18n.t('desktopDownloadIntro');

    const legacyWindowsAssets = [
        {
            kind: 'installer',
            format: 'EXE',
            architecture: manifest.architecture || 'x64',
            fileName: manifest.fileName,
            url: manifest.downloadUrl || manifest.url,
        },
        {
            kind: 'portable',
            format: 'EXE',
            architecture: manifest.architecture || 'x64',
            fileName: manifest.portableFileName,
            url: manifest.portableUrl || manifest.zipUrl,
        },
    ];

    const defaults = {
        windows: {
            nameKey: 'desktopDownloadWindows',
            requirementKey: 'desktopDownloadWindowsRequirement',
            status: manifest.downloadUrl ? 'available' : 'coming-soon',
            assets: legacyWindowsAssets,
        },
        macos: {
            nameKey: 'desktopDownloadMacos',
            requirementKey: 'desktopDownloadMacosRequirement',
            status: 'coming-soon',
            assets: [
                { kind: 'installer', format: 'DMG', architecture: 'Apple silicon / Intel' },
                { kind: 'portable', format: 'ZIP', architecture: 'Apple silicon / Intel' },
            ],
        },
        linux: {
            nameKey: 'desktopDownloadLinux',
            requirementKey: 'desktopDownloadLinuxRequirement',
            status: 'coming-soon',
            assets: [
                { kind: 'installer', format: 'DEB', architecture: 'x86_64' },
                { kind: 'portable', format: 'AppImage', architecture: 'x86_64' },
            ],
        },
    };

    const cards = document.createElement('div');
    cards.className = 'desktop-download-grid';

    for (const platformId of ['windows', 'macos', 'linux']) {
        const fallback = defaults[platformId];
        const platform = manifest.platforms?.[platformId] || fallback;
        const assets = Array.isArray(platform.assets) && platform.assets.length ? platform.assets : fallback.assets;
        const assetStates = assets.map(asset => {
            const githubNormalizedName = asset.fileName?.replaceAll(' ', '.');
            const verifiedUrl = asset.fileName && publishedAssets instanceof Map
                ? publishedAssets.get(asset.fileName) || publishedAssets.get(githubNormalizedName)
                : null;
            const canTrustManifest = !(publishedAssets instanceof Map) && platform.status === 'available';
            return {
                ...asset,
                url: verifiedUrl || asset.url || '',
                available: Boolean((verifiedUrl || (canTrustManifest && asset.url)) && asset.fileName),
            };
        });
        const downloadable = assetStates.filter(asset => asset.available);
        const expectedDownloads = assetStates.filter(asset => asset.url && asset.fileName);
        const fullyReady = expectedDownloads.length > 0 && downloadable.length === expectedDownloads.length;
        const status = fullyReady
            ? 'available'
            : platform.status === 'coming-soon'
                ? 'coming-soon'
                : 'publishing';

        const card = document.createElement('section');
        card.className = `desktop-platform-card desktop-platform-${platformId} is-${status}`;
        card.setAttribute('aria-labelledby', `desktop-platform-${platformId}-title`);
        const cardTop = document.createElement('div');
        cardTop.className = 'desktop-platform-top';
        const logoWrap = document.createElement('span');
        logoWrap.className = 'desktop-platform-logo-wrap';
        const logo = document.createElement('img');
        logo.className = `desktop-platform-logo desktop-platform-logo-${platformId}`;
        logo.src = DESKTOP_PLATFORM_ICON_PATHS[platformId];
        logo.alt = '';
        logo.setAttribute('aria-hidden', 'true');
        logoWrap.appendChild(logo);

        const cardHeading = document.createElement('div');
        cardHeading.className = 'desktop-platform-heading';
        const cardTitle = document.createElement('h3');
        cardTitle.id = `desktop-platform-${platformId}-title`;
        cardTitle.textContent = i18n.t(fallback.nameKey);
        const requirement = document.createElement('p');
        requirement.textContent = platform.requirement || i18n.t(fallback.requirementKey);
        cardHeading.append(cardTitle, requirement);

        const statusBadge = document.createElement('span');
        statusBadge.className = `desktop-platform-status is-${status}`;
        statusBadge.textContent = i18n.t(
            status === 'available'
                ? 'desktopDownloadReady'
                : status === 'publishing'
                    ? 'desktopDownloadPublishing'
                    : 'desktopDownloadComingSoon',
        );
        cardTop.append(logoWrap, cardHeading, statusBadge);

        const actions = document.createElement('div');
        actions.className = 'desktop-download-actions';
        for (const asset of assetStates) {
            const label = i18n.t(asset.kind === 'portable' ? 'desktopDownloadPortable' : 'desktopDownloadInstaller');
            const control = document.createElement(asset.available ? 'a' : 'button');
            control.className = `desktop-download-action desktop-download-action-${asset.kind || 'installer'}`;
            if (asset.available) {
                control.href = asset.url;
                control.target = '_blank';
                control.rel = 'noopener noreferrer';
                control.download = asset.fileName;
                control.setAttribute('aria-label', `${label} ${cardTitle.textContent} ${asset.architecture || ''}`.trim());
            } else {
                control.type = 'button';
                control.disabled = true;
                control.title = i18n.t(status === 'publishing' ? 'desktopDownloadPublishingHint' : 'desktopDownloadUnavailableHint');
            }
            const actionLabel = document.createElement('strong');
            actionLabel.textContent = label;
            const actionMeta = document.createElement('span');
            actionMeta.textContent = [asset.format, asset.architecture].filter(Boolean).join(' · ');
            control.append(actionLabel, actionMeta);
            actions.appendChild(control);
        }
        card.append(cardTop, actions);
        cards.appendChild(card);
    }

    const footer = document.createElement('footer');
    footer.className = 'desktop-download-footer';
    const notes = document.createElement('div');
    notes.className = 'desktop-download-notes';
    const note = document.createElement('p');
    note.textContent = i18n.t('desktopDownloadBetaNote');
    const unsignedNote = document.createElement('p');
    unsignedNote.className = 'desktop-download-unsigned-note';
    unsignedNote.textContent = i18n.t('desktopDownloadUnsignedNote');
    notes.append(note, unsignedNote);

    const footerActions = document.createElement('div');
    footerActions.className = 'desktop-download-footer-actions';
    if (manifest.releaseUrl) {
        const releaseLink = document.createElement('a');
        releaseLink.className = 'desktop-download-release-link';
        releaseLink.href = manifest.releaseUrl;
        releaseLink.target = '_blank';
        releaseLink.rel = 'noopener noreferrer';
        releaseLink.textContent = i18n.t('desktopDownloadReleaseDetails');
        footerActions.appendChild(releaseLink);
    }
    const footerClose = document.createElement('button');
    footerClose.type = 'button';
    footerClose.className = 'modal-btn modal-btn-confirm desktop-download-footer-close';
    footerClose.textContent = i18n.t('helpClose');
    footerActions.appendChild(footerClose);
    footer.append(notes, footerActions);

    content.append(header, intro, cards, footer);
    modal.appendChild(content);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    let settled = false;
    const finish = () => {
        if (settled) return;
        settled = true;
        document.removeEventListener('keydown', keyHandler);
        Modal.close(overlay, previousActive);
    };
    const keyHandler = event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            finish();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...modal.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
            .filter(element => element.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };
    closeButton.addEventListener('click', finish);
    footerClose.addEventListener('click', finish);
    overlay.addEventListener('click', event => {
        if (event.target === overlay) finish();
    });
    document.addEventListener('keydown', keyHandler);
    requestAnimationFrame(() => overlay.classList.add('show'));
    setTimeout(() => closeButton.focus(), 100);
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

        if (ex.projectPath) {
            token.committed = true;
            await this._loadProjectExample(ex, { replaceConfirmed: true, silent: true, preserveTheme: true });
            return;
        }

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
            this._reapplyDataToolVariables?.(fileId, data);
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

proto._loadProjectExample = async function(example, options = {}) {
    const response = await fetch(example.projectPath, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Cannot load example project: ${response.status}`);
    const bytes = await response.arrayBuffer();
    const name = example.projectFileName || example.projectPath.split('/').pop() || `${example.id}.zip`;
    const file = new File([bytes], name, { type: 'application/zip' });
    return this.loadSessionOrProjectFile(file, options);
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
    const existingHelp = document.querySelector('.help-backdrop');
    if (existingHelp) {
        const existingClose = existingHelp.querySelector('.help-modal-close');
        if (existingClose) existingClose.click();
        else existingHelp.remove();
    }
    const previouslyFocused = document.activeElement;

    const backdrop = document.createElement('div');
    backdrop.className = 'help-backdrop';

    const modal = document.createElement('div');
    modal.className = 'help-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'help-modal-title');

    const header = document.createElement('div');
    header.className = 'help-modal-header';
    const heading = document.createElement('div');
    heading.className = 'help-modal-heading';
    const headingIcon = document.createElement('span');
    headingIcon.className = 'help-modal-heading-icon';
    headingIcon.innerHTML = helpIcon('compass', 'help-modal-heading-svg');
    const title = document.createElement('h2');
    title.id = 'help-modal-title';
    title.textContent = i18n.t('helpTitle');
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'help-modal-close';
    closeBtn.title = i18n.t('helpClose');
    closeBtn.setAttribute('aria-label', i18n.t('helpClose'));
    closeBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>';
    heading.append(headingIcon, title);
    header.append(heading, closeBtn);

    const main = document.createElement('div');
    main.className = 'help-modal-main';

    const sidebar = document.createElement('nav');
    sidebar.className = 'help-topic-sidebar';
    sidebar.setAttribute('aria-label', i18n.t('helpTitle'));
    sidebar.setAttribute('role', 'tablist');

    const body = document.createElement('div');
    body.className = 'help-modal-body';

    const tabs = [];
    const panels = [];
    const selectTopic = (index, focus = false) => {
        tabs.forEach((tab, tabIndex) => {
            const selected = tabIndex === index;
            tab.classList.toggle('active', selected);
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            panels[tabIndex].hidden = !selected;
        });
        if (focus) tabs[index]?.focus();
        body.scrollTop = 0;
    };

    HELP_TOPICS.forEach((topic, index) => {
        const sectionId = `help-section-${topic.section}`;
        const tabId = `help-topic-${topic.section}`;
        const label = i18n.t(`helpSec${topic.section}Title`);
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.id = tabId;
        tab.className = 'help-topic-button';
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', sectionId);
        tab.style.setProperty('--help-topic-color', topic.color);
        tab.innerHTML = `<span class="help-topic-icon">${helpIcon(topic.icon)}</span><span class="help-topic-label"></span>`;
        tab.querySelector('.help-topic-label').textContent = label;
        tab.addEventListener('click', () => selectTopic(index));
        tab.addEventListener('keydown', event => {
            let next = null;
            if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % HELP_TOPICS.length;
            else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + HELP_TOPICS.length) % HELP_TOPICS.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = HELP_TOPICS.length - 1;
            if (next == null) return;
            event.preventDefault();
            selectTopic(next, true);
            tabs[next]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });

        const sec = document.createElement('section');
        sec.id = sectionId;
        sec.className = 'help-section';
        sec.setAttribute('role', 'tabpanel');
        sec.setAttribute('aria-labelledby', tabId);
        sec.tabIndex = 0;
        sec.style.setProperty('--help-topic-color', topic.color);
        const sectionHeading = document.createElement('div');
        sectionHeading.className = 'help-section-heading';
        const sectionIcon = document.createElement('span');
        sectionIcon.className = 'help-section-icon';
        sectionIcon.innerHTML = helpIcon(topic.icon);
        const h3 = document.createElement('h3');
        h3.textContent = label;
        sectionHeading.append(sectionIcon, h3);
        const content = document.createElement('div');
        content.className = 'help-section-content';
        content.innerHTML = i18n.t(`helpSec${topic.section}Body`);
        sec.append(sectionHeading, content);
        sidebar.appendChild(tab);
        body.appendChild(sec);
        tabs.push(tab);
        panels.push(sec);
    });

    main.append(sidebar, body);
    modal.append(header, main);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    selectTopic(0);

    const close = () => {
        document.removeEventListener('keydown', onDocumentKeydown);
        backdrop.remove();
        previouslyFocused?.focus?.();
    };
    const onDocumentKeydown = event => {
        if (event.key === 'Escape') {
            event.preventDefault();
            close();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...modal.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
            .filter(element => !element.hidden && element.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    };
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onDocumentKeydown);
    requestAnimationFrame(() => tabs[0]?.focus());
};

// ─── Drag-and-drop file loading ────────────────────────────────

proto.showSupportedFormats = function() {
    Modal.alert(i18n.t('supportedFormatsTitle'), i18n.t('supportedFormatsBody'), {
        iconHtml: `<svg class="supported-formats-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect x="3.5" y="4.5" width="17" height="15" rx="2"></rect>
            <path d="M3.5 9.5h17M9 4.5v15M15 4.5v15M3.5 14.5h17"></path>
        </svg>`,
        html: true,
        className: 'modal-dialog-supported-formats',
    });
};

proto.initDragAndDrop = function() {
    const dropZone = document.getElementById('drop-zone');
    let dragDepth = 0;
    let wasInitiallyVisible = dropZone.classList.contains('active');
    const containsFiles = event => Array.from(event.dataTransfer?.types || []).includes('Files');
    const hideDropTarget = () => {
        dragDepth = 0;
        dropZone.classList.remove('dragging', 'subsequent-drop', 'initial-file-drop');
        if (!wasInitiallyVisible && this.files?.size) dropZone.classList.remove('active');
    };

    // The initial drop zone is hidden after the first load, so file drops must
    // be captured at document level to keep working while plots are visible.
    document.addEventListener('dragenter', (e) => {
        if (!containsFiles(e)) return;
        e.preventDefault();
        if (dragDepth === 0) wasInitiallyVisible = dropZone.classList.contains('active');
        dragDepth++;
        dropZone.classList.add('subsequent-drop');
        dropZone.classList.toggle('initial-file-drop', !this.files?.size);
        dropZone.classList.add('active', 'dragging');
    });
    document.addEventListener('dragover', (e) => {
        if (!containsFiles(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    document.addEventListener('dragleave', (e) => {
        if (dragDepth === 0) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) hideDropTarget();
    });
    window.addEventListener('blur', hideDropTarget);
    document.addEventListener('drop', async (e) => {
        if (!containsFiles(e)) return;
        e.preventDefault();
        hideDropTarget();
        const files = await this._getDroppedResultFiles(e.dataTransfer);
        if (!files.length) { alert(i18n.t('invalidFile')); return; }
        await this.loadFiles(files);
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

    const updateProxy = () => {
        const rect = sidebar.getBoundingClientRect();
        const hidden = sidebar.classList.contains('hidden') || rect.width < 2;
        proxy.style.display = hidden ? 'none' : '';
        // Keep the resize target fully outside the scrollable sidebar. Firefox
        // reports native scrollbar presses as pointer events on the sidebar,
        // so any inside-edge hit target can steal scrollbar interaction.
        proxy.style.left = `${rect.right}px`;
        proxy.style.top = `${rect.top}px`;
        proxy.style.height = `${rect.height}px`;
    };

    const startResize = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
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
