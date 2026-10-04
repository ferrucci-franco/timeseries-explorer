// The phone layout: a compact mode of the same app (docs/phone-web-specification.md).
//
// Nothing here owns data, plots or analysis. It decides *where* the existing
// controls live on a small screen: one plot at a time under a one-line app bar,
// a bottom navigation (a rail when the phone is sideways), and sheets that slide
// over or push the plot. Existing pieces of the desktop UI — the sidebar, the
// examples and main menus, the FFT options panel — are lent to a sheet while it
// is open and put back where they came from when it closes, so every action
// keeps one code path.
import i18n from '../../i18n/index.js';
import {
    LAYOUT_OVERRIDE_STORAGE_KEY,
    effectiveViewportSize,
    isLandscapeViewport,
    normalizeLayoutOverride,
    shouldUseCompactLayout,
} from '../../ui/compact-layout.js';

const SVG = {
    data: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
    plot: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20h18"/><path d="M4 16l5-6 4 4 7-9"/></svg>',
    analyze: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V12M10 20V6M15 20v-9M20 20v-5"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
    shrink: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    caret: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>',
};

const NAV_ITEMS = [
    { id: 'data', labelKey: 'compactNavData' },
    { id: 'plot', labelKey: 'compactNavPlot' },
    { id: 'analyze', labelKey: 'compactNavAnalyze' },
    { id: 'more', labelKey: 'compactNavMore' },
];

// Modes the phone layout drives for now. A panel in any other mode is shown,
// but its controls stay on the desktop layout until they are migrated.
const COMPACT_ANALYSES = [
    { mode: 'timeseries', labelKey: 'compactAnalysisNone' },
    { mode: 'fft', labelKey: 'analysisItemFft' },
];

const MODE_LABEL_KEYS = {
    timeseries: 'modeTimeseries',
    fft: 'analysisItemFft',
    histogram: 'analysisItemHistogram',
    heatmap: 'analysisItemHeatmap',
    'temporal-profile': 'analysisItemProfile',
    integral: 'analysisItemIntegral',
    phase2d: 'modePhase2d',
    phase2dt: 'modePhase2dt',
    phase3d: 'modePhase3d',
    correlation: 'modeCorrelationLabel',
};

// After a sheet settles: Plotly measures its container, so resizing during the
// slide would redraw every frame.
const SHEET_SETTLE_MS = 240;

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

function button(className, label, onClick, { icon = '', title = '' } = {}) {
    const btn = el('button', className);
    btn.type = 'button';
    if (icon) {
        const iconSpan = el('span', 'compact-btn-icon');
        iconSpan.innerHTML = icon;
        btn.appendChild(iconSpan);
    }
    if (label) btn.appendChild(el('span', 'compact-btn-label', label));
    if (title || !label) {
        btn.title = title || '';
        btn.setAttribute('aria-label', title || label || '');
    }
    btn.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick(event);
    });
    return btn;
}

function section(titleText) {
    const wrap = el('section', 'compact-section');
    if (titleText) wrap.appendChild(el('h3', 'compact-section-title', titleText));
    return wrap;
}

export function installCompactMethods(ViewerClass) {
    const proto = ViewerClass.prototype;

    proto.initCompactLayout = function() {
        let override = 'auto';
        try {
            override = normalizeLayoutOverride(globalThis.localStorage?.getItem(LAYOUT_OVERRIDE_STORAGE_KEY));
        } catch (_) { /* no storage: automatic */ }
        this._compact = {
            active: false,
            landscape: false,
            override,
            sheet: null,          // id of the open sheet
            sheetSize: 'half',    // 'half' | 'full'
            pages: [],            // [{ title, node, onClose }], top is shown
            historyEntries: 0,    // history entries this layout pushed
            ignorePop: false,
            activePanelId: null,
            settleTimer: null,
        };
        this._buildCompactChrome();
        this.layoutManager.onAfterRender = () => this._compactAfterLayoutRender();
        // Picking an example or a menu entry from the More sheet starts
        // something that wants the screen: the sheet gets out of the way.
        const closeAfterPick = (event) => {
            if (!this._compact?.active || this._compact.sheet !== 'more') return;
            if (event.target.closest('.example-load-btn, .extra-menu-item')) {
                setTimeout(() => this._closeCompactSheet(), 0);
            }
        };
        document.getElementById('example-menu')?.addEventListener('click', closeAfterPick);
        document.getElementById('extra-menu')?.addEventListener('click', closeAfterPick);
        // The tree is rebuilt on every filter keystroke and file switch; its
        // "on this plot" marks follow.
        const tree = document.getElementById('variables-tree');
        if (tree && typeof MutationObserver !== 'undefined') {
            let pending = false;
            new MutationObserver(() => {
                if (pending || !this._compact.active) return;
                pending = true;
                requestAnimationFrame(() => {
                    pending = false;
                    this._compactSyncTreeMarks();
                });
            }).observe(tree, { childList: true, subtree: true });
        }

        let frame = null;
        const schedule = () => {
            if (frame) return;
            frame = requestAnimationFrame(() => {
                frame = null;
                this._applyCompactLayout();
            });
        };
        window.addEventListener('resize', schedule);
        window.addEventListener('orientationchange', schedule);
        window.visualViewport?.addEventListener('resize', schedule);
        window.addEventListener('popstate', () => this._onCompactPopState());
        document.addEventListener('keydown', (event) => {
            if (event.key !== 'Escape' || !this._compact.active || !this._compact.sheet) return;
            // A dialog on top handles its own Escape.
            if (document.querySelector('.modal-overlay, .csv-preview-overlay, .help-backdrop')) return;
            if (this._compact.pages.length > 1) this._popCompactPage();
            else this._closeCompactSheet();
        });
        this._applyCompactLayout();
    };

    proto._compactIsActive = function() {
        return !!this._compact?.active;
    };

    proto._setCompactLayoutOverride = function(value) {
        const override = normalizeLayoutOverride(value);
        this._compact.override = override;
        try {
            if (override === 'auto') globalThis.localStorage?.removeItem(LAYOUT_OVERRIDE_STORAGE_KEY);
            else globalThis.localStorage?.setItem(LAYOUT_OVERRIDE_STORAGE_KEY, override);
        } catch (_) { /* remembered for this visit only */ }
        this._applyCompactLayout();
        if (this._compact.active && this._compact.sheet === 'more') this._renderCompactSheetContent();
    };

    // ─── Chrome: app bar, navigation, sheet ───────────────────────

    proto._buildCompactChrome = function() {
        const appBar = el('header', 'compact-appbar');
        appBar.id = 'compact-appbar';
        appBar.hidden = true;
        this._compactPlotButton = button('compact-plot-selector', '', () => this._openCompactSheet('plot', { toggle: false }), { icon: '' });
        this._compactPlotButton.setAttribute('aria-haspopup', 'dialog');
        this._compactPlotLabel = el('span', 'compact-plot-selector-label');
        const caret = el('span', 'compact-plot-selector-caret');
        caret.innerHTML = SVG.caret;
        this._compactPlotButton.append(this._compactPlotLabel, caret);
        this._compactTitle = el('span', 'compact-appbar-title');
        appBar.append(this._compactPlotButton, this._compactTitle);

        const nav = el('nav', 'compact-nav');
        nav.id = 'compact-nav';
        nav.hidden = true;
        this._compactNavButtons = new Map();
        for (const item of NAV_ITEMS) {
            const btn = button('compact-nav-btn', i18n.t(item.labelKey), () => this._openCompactSheet(item.id), { icon: SVG[item.id] });
            btn.dataset.sheet = item.id;
            btn.setAttribute('aria-pressed', 'false');
            this._compactNavButtons.set(item.id, btn);
            nav.appendChild(btn);
        }

        const sheet = el('div', 'compact-sheet');
        sheet.id = 'compact-sheet';
        sheet.hidden = true;
        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'false');
        const handle = el('div', 'compact-sheet-handle');
        handle.setAttribute('aria-hidden', 'true');
        handle.appendChild(el('span', 'compact-sheet-grip'));
        this._installCompactSheetDrag(handle);
        const header = el('div', 'compact-sheet-header');
        this._compactBackBtn = button('compact-icon-btn compact-sheet-back', '', () => this._popCompactPage(), { icon: SVG.back, title: i18n.t('compactBack') });
        this._compactSheetTitle = el('h2', 'compact-sheet-title');
        this._compactSheetTitle.id = 'compact-sheet-title';
        this._compactSheetTitle.tabIndex = -1;
        sheet.setAttribute('aria-labelledby', this._compactSheetTitle.id);
        this._compactSizeBtn = button('compact-icon-btn compact-sheet-size', '', () => this._toggleCompactSheetSize(), { icon: SVG.expand, title: i18n.t('compactExpand') });
        this._compactCloseBtn = button('compact-icon-btn compact-sheet-close', '', () => this._closeCompactSheet(), { icon: SVG.close, title: i18n.t('compactClose') });
        header.append(this._compactBackBtn, this._compactSheetTitle, this._compactSizeBtn, this._compactCloseBtn);
        this._compactSheetBody = el('div', 'compact-sheet-body');
        sheet.append(handle, header, this._compactSheetBody);

        document.body.append(appBar, sheet, nav);
        this._compactAppBar = appBar;
        this._compactNav = nav;
        this._compactSheet = sheet;

        this._buildCompactEmptyState();
    };

    // The drop zone says "drag a file here": there is nothing to drag on a
    // phone. It gets the two things that start a session instead.
    proto._buildCompactEmptyState = function() {
        const content = document.querySelector('#drop-zone .drop-zone-content');
        if (!content || content.querySelector('.compact-empty-extra')) return;
        // The privacy line is already there, in the web version's notice.
        const extra = el('div', 'compact-empty-extra');
        const example = button('compact-secondary-btn compact-try-example', i18n.t('compactTryExample'), () => this._openCompactSheet('more', { toggle: false, focus: 'examples' }));
        extra.append(example);
        const select = content.querySelector('#file-select-btn');
        content.insertBefore(extra, select?.nextSibling || null);
        this._compactEmptyExample = example;
    };

    proto._installCompactSheetDrag = function(handle) {
        let startY = null;
        let startX = null;
        handle.addEventListener('pointerdown', (event) => {
            startY = event.clientY;
            startX = event.clientX;
            handle.setPointerCapture?.(event.pointerId);
        });
        handle.addEventListener('pointerup', (event) => {
            if (startY == null) return;
            const dy = event.clientY - startY;
            const dx = event.clientX - startX;
            startY = null;
            if (Math.abs(dy) < 8 && Math.abs(dx) < 8) {
                this._toggleCompactSheetSize();
                return;
            }
            if (dy > 50) {
                if (this._compact.sheetSize === 'full') this._setCompactSheetSize('half');
                else this._closeCompactSheet();
            } else if (dy < -50) {
                this._setCompactSheetSize('full');
            }
        });
        handle.addEventListener('pointercancel', () => { startY = null; });
    };

    // ─── Activation ───────────────────────────────────────────────

    proto._applyCompactLayout = function() {
        const { width, height } = effectiveViewportSize({
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            screenWidth: window.screen?.width,
            screenHeight: window.screen?.height,
        });
        const want = shouldUseCompactLayout({ width, height, override: this._compact.override });
        const landscape = isLandscapeViewport(width, height);
        const root = document.documentElement;
        const changed = want !== this._compact.active;
        const turned = landscape !== this._compact.landscape;
        this._compact.landscape = landscape;
        root.classList.toggle('compact-landscape', want && landscape);
        if (!changed) {
            if (want && turned) {
                if (this._compact.sheet) this._applyCompactSheetSize();
                this._scheduleCompactResize();
            }
            return;
        }
        this._compact.active = want;
        root.classList.toggle('compact', want);
        this._compactAppBar.hidden = !want;
        this._compactNav.hidden = !want;
        if (want) {
            this._closePeerMenus?.();
            this._compactSyncPanels();
            this._compactRefreshTexts();
        } else {
            this._closeCompactSheet({ silent: true });
            document.querySelectorAll('.layout-panel.compact-active-panel').forEach(node => node.classList.remove('compact-active-panel'));
            document.querySelectorAll('.layout-split-child.compact-path').forEach(node => node.classList.remove('compact-path'));
        }
        this._scheduleCompactResize(0);
    };

    proto._scheduleCompactResize = function(delay = SHEET_SETTLE_MS) {
        clearTimeout(this._compact.settleTimer);
        this._compact.settleTimer = setTimeout(() => {
            requestAnimationFrame(() => this.plotManager.resizeAll());
        }, delay);
    };

    proto._compactRefreshTexts = function() {
        if (!this._compact) return;
        for (const item of NAV_ITEMS) {
            const btn = this._compactNavButtons.get(item.id);
            const label = btn?.querySelector('.compact-btn-label');
            if (label) label.textContent = i18n.t(item.labelKey);
        }
        this._compactNav.setAttribute('aria-label', i18n.t('compactNavigation'));
        this._compactBackBtn.title = i18n.t('compactBack');
        this._compactBackBtn.setAttribute('aria-label', i18n.t('compactBack'));
        this._compactCloseBtn.title = i18n.t('compactClose');
        this._compactCloseBtn.setAttribute('aria-label', i18n.t('compactClose'));
        this._syncCompactSizeButton();
        const exampleLabel = this._compactEmptyExample?.querySelector('.compact-btn-label');
        if (exampleLabel) exampleLabel.textContent = i18n.t('compactTryExample');
        this._compactUpdateAppBar();
        if (this._compact.sheet) this._renderCompactSheetContent();
    };

    // ─── One plot at a time ───────────────────────────────────────

    proto._compactPanelIds = function() {
        return this.layoutManager._collectPanelIds(this.layoutManager.root);
    };

    proto._compactActivePanelId = function() {
        const ids = this._compactPanelIds();
        if (!ids.includes(this._compact?.activePanelId)) this._compact.activePanelId = ids[0] || null;
        return this._compact.activePanelId;
    };

    proto._compactActivePanelEl = function() {
        const id = this._compactActivePanelId();
        return id ? document.querySelector(`#plots-area .layout-panel[data-id="${id}"]`) : null;
    };

    proto._compactAfterLayoutRender = function() {
        if (!this._compact?.active) return;
        this._compactSyncPanels();
        this._scheduleCompactResize(0);
        if (this._compact.sheet === 'plot' || this._compact.sheet === 'analyze') this._renderCompactSheetContent();
    };

    proto._compactSyncPanels = function() {
        const container = document.getElementById('plots-area');
        if (!container) return;
        const activeId = this._compactActivePanelId();
        container.querySelectorAll('.layout-panel').forEach(node => {
            node.classList.toggle('compact-active-panel', node.dataset.id === activeId);
        });
        container.querySelectorAll('.layout-split-child.compact-path').forEach(node => node.classList.remove('compact-path'));
        let node = container.querySelector(`.layout-panel[data-id="${activeId}"]`);
        while (node && node !== container) {
            if (node.classList.contains('layout-split-child')) node.classList.add('compact-path');
            node = node.parentElement;
        }
        this._compactUpdateAppBar();
    };

    proto._setCompactActivePanel = function(panelId) {
        this._compact.activePanelId = panelId;
        this._compactSyncPanels();
        this._scheduleCompactResize(0);
        this._compactSyncTreeMarks();
    };

    proto._compactPanelSummary = function(panelId) {
        const plot = this.plotManager.plots.get(panelId);
        const names = (plot?.traces || []).map(trace => this._compactTraceLabel(trace));
        if (!names.length && plot?.phaseTraces?.length) {
            names.push(...plot.phaseTraces.map(pair => [pair.x, pair.y, pair.z].filter(Boolean).join(' / ')));
        }
        const mode = plot?.mode || 'timeseries';
        const key = mode === 'state-anim'
            ? ((plot?.stateAnimDim || 2) === 3 ? 'modeStateAnim3d' : 'modeStateAnim2d')
            : MODE_LABEL_KEYS[mode];
        const modeLabel = key ? i18n.t(key) : mode;
        return { modeLabel, names, text: names.length ? names.join(', ') : i18n.t('compactPlotEmpty') };
    };

    proto._compactTraceLabel = function(trace) {
        const variable = this.plotManager.files.get(trace.fileId)?.data?.variables?.[trace.varName];
        return variable?.displayName || trace.varName;
    };

    proto._compactUpdateAppBar = function() {
        if (!this._compact?.active) return;
        const ids = this._compactPanelIds();
        const activeId = this._compactActivePanelId();
        const index = Math.max(0, ids.indexOf(activeId));
        this._compactPlotLabel.textContent = i18n.t('compactPlotOf')
            .replace('{n}', String(index + 1))
            .replace('{total}', String(ids.length));
        const activeFile = this.activeFileId != null ? this.files.get(this.activeFileId) : null;
        this._compactTitle.textContent = activeFile ? this._fileDisplayName(activeFile) : i18n.t('appTitle');
        this._compactTitle.title = this._compactTitle.textContent;
    };

    // ─── Sheets ───────────────────────────────────────────────────

    proto._openCompactSheet = function(id, { toggle = true, focus = null } = {}) {
        if (!this._compact?.active) return;
        if (this._compact.sheet === id && toggle) {
            this._closeCompactSheet();
            return;
        }
        const wasOpen = !!this._compact.sheet;
        this._releaseCompactPages();
        this._compact.sheet = id;
        this._compact.focus = focus;
        this._compact.opener = document.activeElement;
        if (!wasOpen) {
            this._compact.sheetSize = 'half';
            this._pushCompactHistory();
        }
        this._compactSheet.hidden = false;
        document.documentElement.classList.add('compact-sheet-open');
        this._applyCompactSheetSize();
        this._compactNavButtons.forEach((btn, key) => btn.setAttribute('aria-pressed', String(key === id)));
        this._renderCompactSheetContent();
        requestAnimationFrame(() => this._compactSheet.classList.add('is-shown'));
        this._scheduleCompactResize();
        setTimeout(() => this._compactSheetTitle.focus?.({ preventScroll: true }), 50);
    };

    proto._closeCompactSheet = function({ fromHistory = false, silent = false } = {}) {
        if (!this._compact?.sheet) return;
        this._releaseCompactPages({ unwind: false });
        this._compact.sheet = null;
        this._compactSheet.classList.remove('is-shown');
        this._compactSheet.hidden = true;
        document.documentElement.classList.remove('compact-sheet-open', 'compact-sheet-full');
        document.querySelector('.main-container')?.removeAttribute('inert');
        this._compactNavButtons.forEach(btn => btn.setAttribute('aria-pressed', 'false'));
        if (!fromHistory) this._unwindCompactHistory();
        else this._compact.historyEntries = 0;
        if (!silent) {
            this._scheduleCompactResize();
            const opener = this._compact.opener;
            if (opener && document.contains(opener)) {
                try { opener.focus({ preventScroll: true }); } catch (_) { /* nothing to return to */ }
            }
        }
    };

    proto._toggleCompactSheetSize = function() {
        this._setCompactSheetSize(this._compact.sheetSize === 'full' ? 'half' : 'full');
    };

    proto._setCompactSheetSize = function(size) {
        if (!this._compact.sheet) return;
        this._compact.sheetSize = size === 'full' ? 'full' : 'half';
        this._applyCompactSheetSize();
        this._scheduleCompactResize();
    };

    proto._applyCompactSheetSize = function() {
        // Sideways, a sheet is always a side sheet: the plot stays beside it.
        const full = this._compact.sheetSize === 'full' && !this._compact.landscape && !!this._compact.sheet;
        document.documentElement.classList.toggle('compact-sheet-full', full);
        // Covered completely, the plot is out of reach for touch and for a
        // screen reader alike.
        const main = document.querySelector('.main-container');
        if (full) main?.setAttribute('inert', '');
        else main?.removeAttribute('inert');
        this._syncCompactSizeButton();
    };

    proto._syncCompactSizeButton = function() {
        if (!this._compactSizeBtn) return;
        const full = this._compact?.sheetSize === 'full';
        this._compactSizeBtn.querySelector('.compact-btn-icon').innerHTML = full ? SVG.shrink : SVG.expand;
        const label = i18n.t(full ? 'compactShrink' : 'compactExpand');
        this._compactSizeBtn.title = label;
        this._compactSizeBtn.setAttribute('aria-label', label);
    };

    // Back closes what is on top instead of leaving the site (§6.3).
    proto._pushCompactHistory = function() {
        try {
            history.pushState({ ...(history.state || {}), compactLayer: (this._compact.historyEntries || 0) + 1 }, '');
            this._compact.historyEntries += 1;
        } catch (_) { /* sandboxed: Back simply is not intercepted */ }
    };

    proto._unwindCompactHistory = function() {
        const entries = this._compact.historyEntries;
        this._compact.historyEntries = 0;
        if (entries > 0) {
            this._compact.ignorePop = true;
            try { history.go(-entries); } catch (_) { this._compact.ignorePop = false; }
        }
    };

    proto._onCompactPopState = function() {
        if (!this._compact) return;
        if (this._compact.ignorePop) {
            this._compact.ignorePop = false;
            return;
        }
        if (!this._compact.sheet) return;
        this._compact.historyEntries = Math.max(0, this._compact.historyEntries - 1);
        if (this._compact.pages.length > 1) this._popCompactPage({ fromHistory: true });
        else this._closeCompactSheet({ fromHistory: true });
    };

    // A sheet is a stack of pages; the root page is the sheet's own content.
    proto._setCompactRootPage = function(page) {
        this._releaseCompactPages();
        this._compact.pages = [page];
        this._showCompactTopPage();
    };

    proto._pushCompactPage = function(page) {
        this._compact.pages.push(page);
        this._pushCompactHistory();
        this._showCompactTopPage();
    };

    proto._popCompactPage = function({ fromHistory = false } = {}) {
        if (this._compact.pages.length <= 1) return;
        const page = this._compact.pages.pop();
        page.onClose?.();
        page.node.remove();
        if (!fromHistory && this._compact.historyEntries > 1) {
            this._compact.historyEntries -= 1;
            this._compact.ignorePop = true;
            try { history.back(); } catch (_) { this._compact.ignorePop = false; }
        }
        this._showCompactTopPage();
    };

    proto._releaseCompactPages = function({ unwind = true } = {}) {
        const pages = this._compact?.pages || [];
        while (pages.length) {
            const page = pages.pop();
            page.onClose?.();
            page.node.remove();
        }
        // Sub-pages pushed history entries of their own; keep only the sheet's.
        if (unwind && this._compact && this._compact.historyEntries > 1 && this._compact.sheet) {
            const extra = this._compact.historyEntries - 1;
            this._compact.historyEntries = 1;
            this._compact.ignorePop = true;
            try { history.go(-extra); } catch (_) { this._compact.ignorePop = false; }
        }
    };

    proto._showCompactTopPage = function() {
        const pages = this._compact.pages;
        const top = pages[pages.length - 1];
        for (const page of pages) {
            page.node.hidden = page !== top;
            if (!page.node.isConnected) this._compactSheetBody.appendChild(page.node);
        }
        this._compactSheetTitle.textContent = top?.title || '';
        this._compactBackBtn.hidden = pages.length <= 1;
        this._compactSheetBody.scrollTop = top?.scrollTop || 0;
    };

    // Lend an element of the desktop UI to a sheet page and get it back later.
    proto._lendToCompact = function(node, target) {
        if (!node) return () => {};
        const marker = document.createComment('compact-lent');
        node.parentNode?.insertBefore(marker, node);
        target.appendChild(node);
        return () => {
            if (marker.parentNode) marker.parentNode.replaceChild(node, marker);
            else node.remove();
        };
    };

    proto._renderCompactSheetContent = function() {
        const id = this._compact.sheet;
        if (!id) return;
        const keepScroll = this._compact.pages.length === 1 && this._compact.pages[0].id === id
            ? this._compactSheetBody.scrollTop
            : 0;
        const builders = {
            data: () => this._buildCompactDataPage(),
            plot: () => this._buildCompactPlotPage(),
            analyze: () => this._buildCompactAnalyzePage(),
            more: () => this._buildCompactMorePage(),
        };
        const page = builders[id]?.();
        if (!page) return;
        page.id = id;
        page.scrollTop = keepScroll;
        this._setCompactRootPage(page);
        const focus = this._compact.focus;
        this._compact.focus = null;
        if (focus) {
            requestAnimationFrame(() => page.node.querySelector(`[data-compact-focus="${focus}"]`)?.scrollIntoView({ block: 'start' }));
        }
    };

    // ─── Data: files and signals ──────────────────────────────────

    proto._buildCompactDataPage = function() {
        const node = el('div', 'compact-page compact-page-data');
        const actions = el('div', 'compact-action-row');
        actions.appendChild(button('compact-primary-btn', i18n.t('compactOpenFile'), () => {
            document.getElementById('load-new-file')?.click();
        }));
        node.appendChild(actions);
        const sidebar = document.getElementById('sidebar');
        const restore = this._lendToCompact(sidebar, node);
        this._compactSyncTreeMarks();
        return {
            title: i18n.t('compactNavData'),
            node,
            onClose: () => restore(),
        };
    };

    // Tapping a variable puts it on the active plot, or takes it off (§5.1).
    proto._compactToggleVariable = async function(varName, fileId = null) {
        const pm = this.plotManager;
        const panelId = this._compactActivePanelId();
        const panelEl = this._compactActivePanelEl();
        if (!panelId || !panelEl) return;
        const plot = pm.plots.get(panelId);
        const ownerId = fileId || this.activeFileId;
        const index = (plot?.traces || []).findIndex(trace => trace.varName === varName && trace.fileId === ownerId);
        if (plot && index >= 0 && (plot.mode === 'timeseries' || plot.mode === 'fft')) {
            if (plot.mode === 'timeseries') pm.removeTrace(panelId, varName, ownerId);
            else pm._removeFftTraceFromLegend(panelId, plot, plot.traces[index]);
        } else {
            await pm._handleVariableDrop(panelId, [varName], panelEl, { fileId });
        }
        requestAnimationFrame(() => {
            this._compactSyncTreeMarks();
            this._compactUpdateAppBar();
        });
    };

    proto._compactSyncTreeMarks = function() {
        if (!this._compact?.active) return;
        const panelId = this._compactActivePanelId();
        const plot = panelId ? this.plotManager.plots.get(panelId) : null;
        const onPlot = new Set((plot?.traces || []).map(trace => `${trace.fileId}\u0000${trace.varName}`));
        document.querySelectorAll('#variables-tree .tree-item[data-var-name]').forEach(item => {
            const fileId = item.dataset.fileId || this.activeFileId;
            item.classList.toggle('compact-on-plot', onPlot.has(`${fileId}\u0000${item.dataset.varName}`));
        });
    };

    // The file row's small icon buttons, gathered on one page of full-width
    // targets (§5.6). Each action is the row's own button, clicked.
    proto._compactOpenFileActions = function(fileId, entry) {
        if (!this._compact?.active || !entry) return;
        const entryData = this.files.get(fileId);
        const node = el('div', 'compact-page compact-page-file');
        const list = el('div', 'compact-list');
        const addAction = (label, icon, onClick, className = '') => {
            const btn = button(`compact-list-btn ${className}`, label, () => {
                this._popCompactPage();
                onClick();
            });
            if (icon) {
                const iconSpan = el('span', 'compact-btn-icon');
                if (icon instanceof Element) iconSpan.appendChild(icon);
                else iconSpan.textContent = icon;
                btn.prepend(iconSpan);
            }
            list.appendChild(btn);
        };
        if (fileId !== this.activeFileId) {
            addAction(i18n.t('compactShowVariables'), '☰', () => this.setActiveFile(fileId));
        }
        const rowButtons = [
            '.file-entry-csv-parsing',
            '.file-entry-mat-arrays',
            '.file-entry-transform',
            '.file-entry-save',
            '.file-entry-close',
        ];
        for (const selector of rowButtons) {
            const source = entry.querySelector(selector);
            if (!source || source.hidden) continue;
            const label = source.getAttribute('aria-label') || source.title || source.textContent;
            const svg = source.querySelector('svg');
            const icon = svg ? svg.cloneNode(true) : (source.textContent || '').trim();
            addAction(label.replace(/\.\.\.$|…$/, ''), selector === '.file-entry-close' ? '✕' : icon, () => source.click(),
                selector === '.file-entry-close' ? 'compact-list-btn-danger' : '');
        }
        node.appendChild(list);
        this._pushCompactPage({
            title: entryData ? this._fileDisplayName(entryData) : i18n.t('compactFileActions'),
            node,
        });
    };

    // ─── Plot ─────────────────────────────────────────────────────

    proto._buildCompactPlotPage = function() {
        const pm = this.plotManager;
        const node = el('div', 'compact-page compact-page-plot');
        const panelId = this._compactActivePanelId();
        const plot = panelId ? pm.plots.get(panelId) : null;

        const plots = section(i18n.t('compactPlots'));
        const list = el('div', 'compact-list');
        const ids = this._compactPanelIds();
        ids.forEach((id, index) => {
            const summary = this._compactPanelSummary(id);
            const item = button(`compact-list-btn compact-plot-item${id === panelId ? ' is-active' : ''}`, '', () => {
                this._setCompactActivePanel(id);
                this._renderCompactSheetContent();
            });
            item.setAttribute('aria-current', id === panelId ? 'true' : 'false');
            const number = el('span', 'compact-plot-number', String(index + 1));
            const text = el('span', 'compact-plot-text');
            text.append(el('span', 'compact-plot-mode', summary.modeLabel), el('span', 'compact-plot-names', summary.text));
            item.append(number, text);
            list.appendChild(item);
        });
        plots.appendChild(list);
        const plotActions = el('div', 'compact-action-row');
        plotActions.appendChild(button('compact-secondary-btn', i18n.t('compactNewPlot'), () => {
            const before = new Set(this._compactPanelIds());
            this.layoutManager.splitPanel(this._compactActivePanelId(), 'h', false);
            const created = this._compactPanelIds().find(id => !before.has(id));
            if (created) this._setCompactActivePanel(created);
            this._updateActionButtons?.();
            this._renderCompactSheetContent();
        }));
        if (ids.length > 1) {
            plotActions.appendChild(button('compact-secondary-btn compact-danger-btn', i18n.t('compactRemovePlot'), () => {
                const current = this._compactActivePanelId();
                const index = ids.indexOf(current);
                this.layoutManager.closePanel(current);
                const remaining = this._compactPanelIds();
                this._setCompactActivePanel(remaining[Math.min(index, remaining.length - 1)] || remaining[0]);
                this._updateActionButtons?.();
                this._renderCompactSheetContent();
            }));
        }
        plots.appendChild(plotActions);
        node.appendChild(plots);

        const hasContent = !!plot && pm._hasContent(plot);
        const view = section(i18n.t('compactView'));
        const viewRow = el('div', 'compact-action-row');
        const run = (work) => {
            if (!panelId) return;
            pm._runWithEagerDetailLoading(panelId, work);
        };
        if (plot?.mode === 'fft') {
            viewRow.appendChild(button('compact-secondary-btn', i18n.t('fftResetLabel'), () => pm._resetFftView(panelId), { title: i18n.t('fftResetView') }));
        } else {
            const autoBtn = button('compact-secondary-btn', '⛶ ' + i18n.t('viewHome'), () => run(() => pm._autoScalePlot(panelId, pm.plots.get(panelId))));
            const xBtn = button('compact-secondary-btn', i18n.t('autoScaleXTitle'), () => run(() => pm._autoScalePlotAxis(panelId, pm.plots.get(panelId), 'x')));
            const yBtn = button('compact-secondary-btn', i18n.t('autoScaleYTitle'), () => run(() => pm._autoScalePlotAxis(panelId, pm.plots.get(panelId), 'y')));
            [autoBtn, xBtn, yBtn].forEach(btn => { btn.disabled = !hasContent; viewRow.appendChild(btn); });
        }
        view.appendChild(viewRow);
        node.appendChild(view);

        const signals = section(i18n.t('compactSignalsOnPlot'));
        const traces = plot?.traces || [];
        if (!traces.length) {
            signals.appendChild(el('p', 'compact-note', i18n.t('compactNoSignals')));
        } else {
            const traceList = el('div', 'compact-list');
            for (const trace of [...traces]) {
                const row = el('div', 'compact-trace-row');
                const swatch = el('span', 'compact-swatch');
                swatch.style.background = trace.color || 'currentColor';
                const label = this._compactTraceLabel(trace);
                const name = el('span', 'compact-trace-name', label);
                const remove = button('compact-icon-btn compact-trace-remove', '', () => {
                    this._compactToggleVariable(trace.varName, trace.fileId).then(() => this._renderCompactSheetContent());
                }, { icon: SVG.close, title: i18n.t('compactRemoveSignal').replace('{name}', label) });
                row.append(swatch, name, remove);
                traceList.appendChild(row);
            }
            signals.appendChild(traceList);
            const clearRow = el('div', 'compact-action-row');
            clearRow.appendChild(button('compact-secondary-btn compact-danger-btn', i18n.t('clearPlot'), () => {
                pm._clearPanel(panelId);
                this._compactSyncTreeMarks();
                this._compactUpdateAppBar();
                this._renderCompactSheetContent();
            }));
            signals.appendChild(clearRow);
        }
        node.appendChild(signals);

        return { title: i18n.t('compactNavPlot'), node };
    };

    // ─── Analyze ──────────────────────────────────────────────────

    proto._buildCompactAnalyzePage = function() {
        const pm = this.plotManager;
        const node = el('div', 'compact-page compact-page-analyze');
        const panelId = this._compactActivePanelId();
        const plot = panelId ? pm.plots.get(panelId) : null;
        const mode = plot?.mode || 'timeseries';
        let restoreOptions = null;

        const choose = section(i18n.t('compactAnalysis'));
        const list = el('div', 'compact-list compact-radio-list');
        list.setAttribute('role', 'radiogroup');
        for (const analysis of COMPACT_ANALYSES) {
            const selected = mode === analysis.mode;
            const item = button(`compact-list-btn compact-radio${selected ? ' is-active' : ''}`, i18n.t(analysis.labelKey), () => {
                if (!panelId || selected) return;
                restoreOptions?.();
                restoreOptions = null;
                pm._requestModeChange(panelId, analysis.mode);
                // The new chart is built asynchronously; the options panel it
                // lends to this sheet exists only once it is.
                setTimeout(() => {
                    if (this._compact.sheet === 'analyze') this._renderCompactSheetContent();
                }, 60);
            });
            item.setAttribute('role', 'radio');
            item.setAttribute('aria-checked', String(selected));
            list.appendChild(item);
        }
        choose.appendChild(list);
        node.appendChild(choose);

        if (mode === 'fft' && plot) {
            const actions = el('div', 'compact-action-row');
            actions.appendChild(button('compact-secondary-btn', i18n.t('fftResetLabel'), () => pm._resetFftView(panelId), { title: i18n.t('fftResetView') }));
            actions.appendChild(button('compact-secondary-btn', 'V/H', () => {
                const current = pm._ensureFftState(plot).layout;
                pm._setFftLayout(panelId, current === 'horizontal' ? 'vertical' : 'horizontal');
            }, { title: i18n.t('fftLayoutToggle') }));
            actions.appendChild(button('compact-secondary-btn', i18n.t('hideTimeSeries'), () => pm._toggleFftTimeSeries(panelId), { title: i18n.t('hideTimeSeriesTooltip') }));
            choose.appendChild(actions);

            const optionsEl = pm._fftOptionsPanel(plot);
            if (optionsEl) {
                const optionsSection = section(i18n.t('compactFftOptions'));
                optionsSection.classList.add('compact-fft-options');
                const wasHidden = optionsEl.hidden;
                optionsEl.hidden = false;
                const restore = this._lendToCompact(optionsEl, optionsSection);
                restoreOptions = () => {
                    // Rebuilt or torn down meanwhile: the chart owns it again.
                    if (plot.fftOptionsEl !== optionsEl) {
                        optionsEl.remove();
                        return;
                    }
                    restore();
                    optionsEl.hidden = wasHidden;
                };
                node.appendChild(optionsSection);
            }
        }
        if (!plot || !pm._hasContent(plot)) {
            node.appendChild(el('p', 'compact-note', i18n.t('compactAnalysisNeedsSignals')));
        }
        node.appendChild(el('p', 'compact-note compact-note-muted', i18n.t('compactMoreAnalysesSoon')));

        return {
            title: i18n.t('compactNavAnalyze'),
            node,
            onClose: () => {
                restoreOptions?.();
                restoreOptions = null;
            },
        };
    };

    // ─── More ─────────────────────────────────────────────────────

    proto._buildCompactMorePage = function() {
        const node = el('div', 'compact-page compact-page-more');
        const restores = [];

        const layout = section(i18n.t('compactLayout'));
        const layoutRow = el('div', 'compact-segmented');
        layoutRow.setAttribute('role', 'radiogroup');
        for (const [value, key] of [['auto', 'compactLayoutAuto'], ['compact', 'compactLayoutCompact'], ['full', 'compactLayoutFull']]) {
            const selected = this._compact.override === value;
            const btn = button(`compact-segment${selected ? ' is-active' : ''}`, i18n.t(key), () => this._setCompactLayoutOverride(value));
            btn.setAttribute('role', 'radio');
            btn.setAttribute('aria-checked', String(selected));
            layoutRow.appendChild(btn);
        }
        layout.appendChild(layoutRow);
        node.appendChild(layout);

        const language = section(i18n.t('compactLanguage'));
        const languageRow = el('div', 'compact-segmented');
        for (const lang of ['en', 'fr', 'es', 'it']) {
            const selected = i18n.currentLang === lang;
            const btn = button(`compact-segment${selected ? ' is-active' : ''}`, lang.toUpperCase(), () => this.setLanguage(lang));
            btn.setAttribute('aria-pressed', String(selected));
            languageRow.appendChild(btn);
        }
        language.appendChild(languageRow);
        const themeLabel = el('label', 'compact-switch-row');
        const themeInput = el('input');
        themeInput.type = 'checkbox';
        themeInput.checked = this.theme === 'dark';
        themeInput.addEventListener('change', () => this.toggleTheme());
        themeLabel.append(el('span', '', i18n.t('compactTheme')), themeInput);
        language.appendChild(themeLabel);
        node.appendChild(language);

        // The desktop menus themselves, lent while the sheet is open: one list
        // of examples and one main menu, whichever layout shows them.
        const examples = section(i18n.t('compactExamples'));
        examples.dataset.compactFocus = 'examples';
        const exampleMenu = document.getElementById('example-menu');
        if (exampleMenu) {
            this._renderExampleMenu?.();
            const wasHidden = exampleMenu.hidden;
            exampleMenu.hidden = false;
            const restore = this._lendToCompact(exampleMenu, examples);
            restores.push(() => { restore(); exampleMenu.hidden = wasHidden; });
        }
        node.appendChild(examples);

        const menuSection = section(i18n.t('extraMenu'));
        const extraMenu = document.getElementById('extra-menu');
        if (extraMenu) {
            this._renderExtraMenu?.();
            const wasHidden = extraMenu.hidden;
            extraMenu.hidden = false;
            const restore = this._lendToCompact(extraMenu, menuSection);
            restores.push(() => { restore(); extraMenu.hidden = wasHidden; });
        }
        node.appendChild(menuSection);

        return {
            title: i18n.t('compactNavMore'),
            node,
            onClose: () => restores.forEach(restore => restore()),
        };
    };
}
