import MatParser from '../parsers/mat-parser.js';
import CsvParser from '../parsers/csv-parser.js';
import i18n from '../i18n/index.js';
import Modal from '../ui/modal.js';
import LayoutManager from '../ui/layout-manager.js';
import PlotManager from '../plots/plot-manager.js';
import { installFileMethods } from './methods/file-methods.js';
import { installUiMethods } from './methods/ui-methods.js';
import { installDerivedMethods } from './methods/derived-methods.js';
import { installDataToolsMethods } from './methods/data-tools-methods.js';
import { installTreeMethods } from './methods/tree-methods.js';
import { installSessionMethods } from './methods/session-methods.js';
import { installLiveUpdateMethods } from './methods/live-update-methods.js';
import { initialCapabilities, resolveCapabilities } from './capabilities.js';

class OpenModelicaViewer {
    constructor() {
        this.parser      = new MatParser();
        this.csvParser   = new CsvParser(this.parser);
        this.files       = new Map();   // fileId → { file, name }
        this._nextFileId = 1;
        this.theme       = OpenModelicaViewer.getStartupTheme();
        this.language    = 'en';
        this.showDescriptions = false;
        this.sortAlphabetical = true;
        this._currentTree     = null;
        this._filterText      = '';
        this._loadedScripts   = new Set();
        this.derivedByFile    = new Map();
        this.dataToolVariablesByFile = new Map();
        this._suggestionIndex = 0;
        this.selectedVariables = new Set();
        this._expandedFileTransforms = new Set();
        this._exampleLoading = false;
        this._exampleLoadToken = null;
        this._exampleLoadingEscHandler = null;
        this.reloadAsNewVersionMode = false;
        this.scrollablePlotArea = false;
        this.mouseWheelZoom = true;
        this.capabilities = initialCapabilities();
        this.advancedSettings = this._loadAdvancedSettings();

        this.layoutManager = new LayoutManager('plots-area');
        this.plotManager   = new PlotManager(this.parser);
        this.plotManager.setRelayoutRefreshMode(this.advancedSettings.panZoomRefreshMode);
        this.layoutManager.setScrollablePlotArea(this.scrollablePlotArea);

        this.layoutManager.onPanelMount   = (id, el) => this.plotManager.onPanelMount(id, el);
        this.layoutManager.onPanelUnmount = (id)     => this.plotManager.onPanelUnmount(id);

        this.applyTheme(this.theme);
        this.initEventListeners();
        this.initDragAndDrop();
        this.initSidebarResize();
        i18n.setLanguage('en');
        this._setDropZoneStatus(false);

        this.layoutManager.render();
        this._updateActionButtons();
        this._applyReloadModeUI();
        this._applyCapabilitiesToUi();
        this._refreshCapabilities();
    }

    // ─── File management ───────────────────────────────────────────

    get activeFileId() { return this.plotManager.activeFileId; }

    // ─── Theme & language ──────────────────────────────────────────

    static getStartupTheme() {
        const hour = new Date().getHours();
        return hour >= 7 && hour < 18 ? 'light' : 'dark';
    }

    setLanguage(lang) {
        this.language = lang;
        i18n.setLanguage(lang);
        document.querySelectorAll('.lang-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
        });
        this._applyReloadModeUI();
        this._applyCapabilitiesToUi();
        this._updateLiveUpdateTopBar?.();
        if (typeof this._syncLegendCornerPicker === 'function') this._syncLegendCornerPicker();
        if (typeof this._syncHoverCornerPicker === 'function') this._syncHoverCornerPicker();
        if (typeof this._syncDataTools === 'function') this._syncDataTools();
        this._renderFilesList();
        if (this._currentTree) this._renderFilteredTree();
        this.layoutManager.render();
    }

    toggleTheme() {
        this.theme = this.theme === 'light' ? 'dark' : 'light';
        this.applyTheme(this.theme);
    }

    applyTheme(theme) {
        this.theme = theme;
        document.body.classList.remove('theme-light', 'theme-dark');
        document.body.classList.add(`theme-${this.theme}`);
        document.querySelector('#theme-toggle .icon').textContent = this.theme === 'light' ? '🌙' : '☀️';
        this.plotManager.setTheme(this.theme);
    }

    // ─── Helpers ──────────────────────────────────────────────────

    _readAsArrayBuffer(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload  = (e) => resolve(e.target.result);
            r.onerror = () => reject(new Error(`Cannot read file: ${file.name}`));
            r.readAsArrayBuffer(file);
        });
    }

    async _refreshCapabilities() {
        this.capabilities = await resolveCapabilities(this.capabilities);
        this._applyCapabilitiesToUi();
        this._updateActionButtons?.();
        this._updateLiveUpdateTopBar?.();
    }

    _applyCapabilitiesToUi() {
        const caps = this.capabilities || initialCapabilities();
        document.body.dataset.omvRuntime = caps.runtime;

        const badge = document.getElementById('runtime-badge');
        if (badge) {
            badge.textContent = caps.label;
            badge.title = this._capabilitiesSummary(caps);
        }

        const liveWrap = document.querySelector('.live-update-topbar-wrap');
        if (liveWrap) {
            liveWrap.hidden = false;
            liveWrap.title = caps.canUseLiveUpdate
                ? ''
                : i18n.t('liveUpdateDesktopOnly');
        }

        const notice = document.getElementById('light-version-notice');
        if (notice) {
            notice.hidden = !caps.showRuntimeNotice;
            notice.innerHTML = this._runtimeNoticeHtml(caps);
        }
    }

    _capabilitiesSummary(caps) {
        if (caps.isDesktop) return 'Full Desktop: native local capabilities enabled.';
        return 'Light Web: browser-only version for GitHub Pages/static hosting.';
    }

    _runtimeNoticeHtml(caps) {
        const noticeMode = caps.isDesktop ? 'Desktop' : 'Web';
        const mode = i18n.t(`runtimeNotice${noticeMode}Kicker`);
        const title = i18n.t(`runtimeNotice${noticeMode}Title`);
        const body = i18n.t(`runtimeNotice${noticeMode}Body`);
        const privacy = i18n.t('runtimeNoticePrivacy');
        const desktop = caps.isDesktop ? '' : i18n.t('runtimeNoticeDesktopDownload');
        const featureList = i18n.t(`runtimeNotice${noticeMode}Features`);
        const features = (Array.isArray(featureList) ? featureList : []).map(feature => `<li>${this._escapeHtml(feature)}</li>`).join('');
        return `
            <div class="light-notice-kicker">${mode}</div>
            <h3>${title}</h3>
            <p>${this._escapeHtml(body)}</p>
            <p class="light-notice-privacy">${this._escapeHtml(privacy)}</p>
            ${desktop ? `<p>${this._escapeHtml(desktop)}</p>` : ''}
            ${features ? `<ul>${features}</ul>` : ''}
        `;
    }

    _escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    _defaultAdvancedSettings() {
        const desktop = !!this.capabilities?.isDesktop;
        return {
            csvFullLoadMb: 150,
            excelFullLoadMb: desktop ? 150 : 50,
            pickleFullLoadMb: desktop ? 200 : 80,
            pypsaNetcdfFullLoadMb: desktop ? 1024 : 250,
            csvCompactHintMb: 500,
            panZoomRefreshMode: 'auto',
        };
    }

    _loadAdvancedSettings() {
        const defaults = this._defaultAdvancedSettings();
        let saved = null;
        try {
            saved = JSON.parse(globalThis.localStorage?.getItem('omv_advanced_settings') || 'null');
        } catch (_) {
            saved = null;
        }
        return this._normalizeAdvancedSettings({ ...defaults, ...(saved || {}) });
    }

    _normalizeAdvancedSettings(settings = {}) {
        const defaults = this._defaultAdvancedSettings();
        const ranges = {
            csvFullLoadMb: [10, 1000],
            excelFullLoadMb: [10, 500],
            pickleFullLoadMb: [10, 1000],
            pypsaNetcdfFullLoadMb: [50, 2048],
            csvCompactHintMb: [100, 4096],
        };
        const next = {};
        for (const [key, fallback] of Object.entries(defaults)) {
            if (key === 'panZoomRefreshMode') {
                next[key] = ['auto', 'smooth', 'responsive'].includes(settings[key]) ? settings[key] : fallback;
                continue;
            }
            const [min, max] = ranges[key] || [1, Number.MAX_SAFE_INTEGER];
            const raw = Number(settings[key]);
            const value = Number.isFinite(raw) ? raw : fallback;
            next[key] = Math.round(Math.min(max, Math.max(min, value)));
        }
        return next;
    }

    _saveAdvancedSettings(settings = this.advancedSettings) {
        this.advancedSettings = this._normalizeAdvancedSettings(settings);
        try {
            globalThis.localStorage?.setItem('omv_advanced_settings', JSON.stringify(this.advancedSettings));
        } catch (_) {}
        return this.advancedSettings;
    }

    _resetAdvancedSettings() {
        this.advancedSettings = this._defaultAdvancedSettings();
        try {
            globalThis.localStorage?.removeItem('omv_advanced_settings');
        } catch (_) {}
        return this.advancedSettings;
    }
}

installFileMethods(OpenModelicaViewer);
installUiMethods(OpenModelicaViewer);
installDerivedMethods(OpenModelicaViewer);
installDataToolsMethods(OpenModelicaViewer);
installTreeMethods(OpenModelicaViewer);
installSessionMethods(OpenModelicaViewer);
installLiveUpdateMethods(OpenModelicaViewer);

export default OpenModelicaViewer;
