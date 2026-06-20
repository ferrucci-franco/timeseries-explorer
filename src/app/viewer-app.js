import MatParser from '../parsers/mat-parser.js';
import CsvParser from '../parsers/csv-parser.js';
import i18n from '../i18n/index.js';
import Modal from '../ui/modal.js';
import LayoutManager from '../ui/layout-manager.js';
import PlotManager from '../plots/plot-manager.js';
import { installFileMethods } from './methods/file-methods.js';
import { installUiMethods } from './methods/ui-methods.js';
import { installDerivedMethods } from './methods/derived-methods.js';
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

        this.layoutManager = new LayoutManager('plots-area');
        this.plotManager   = new PlotManager(this.parser);
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
        if (typeof this._syncLegendCornerPicker === 'function') this._syncLegendCornerPicker();
        if (typeof this._syncHoverCornerPicker === 'function') this._syncHoverCornerPicker();
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
            liveWrap.hidden = !caps.canUseLiveUpdate;
            liveWrap.title = caps.canUseLiveUpdate
                ? ''
                : 'Live Update is available in the local server or Full Desktop version.';
        }

        const notice = document.getElementById('light-version-notice');
        if (notice) {
            notice.hidden = !caps.showRuntimeNotice;
            notice.innerHTML = this._runtimeNoticeHtml(caps);
        }
    }

    _capabilitiesSummary(caps) {
        if (caps.isDesktop) return 'Full Desktop: native local capabilities enabled.';
        if (caps.isLocalServer) return 'Light Local: static app plus localhost file API.';
        return 'Light Web: browser-only version for GitHub Pages/static hosting.';
    }

    _runtimeNoticeHtml(caps) {
        const noticeMode = caps.isDesktop ? 'Desktop' : (caps.isLocalServer ? 'Local' : 'Web');
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
}

installFileMethods(OpenModelicaViewer);
installUiMethods(OpenModelicaViewer);
installDerivedMethods(OpenModelicaViewer);
installTreeMethods(OpenModelicaViewer);
installSessionMethods(OpenModelicaViewer);
installLiveUpdateMethods(OpenModelicaViewer);

export default OpenModelicaViewer;
