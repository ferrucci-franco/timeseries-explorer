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
}

installFileMethods(OpenModelicaViewer);
installUiMethods(OpenModelicaViewer);
installDerivedMethods(OpenModelicaViewer);
installTreeMethods(OpenModelicaViewer);
installSessionMethods(OpenModelicaViewer);
installLiveUpdateMethods(OpenModelicaViewer);

export default OpenModelicaViewer;
