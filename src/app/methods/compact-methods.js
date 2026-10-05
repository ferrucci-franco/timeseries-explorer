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
import Modal from '../../ui/modal.js';
import Plotly, { onPlotDrawn } from '../../vendor/plotly.js';
import { clearPlotHover } from '../../ui/plot-touch-gestures.js';
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
    // Full height / half height: corners out, corners in.
    expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    shrink: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
    // Hiding a sheet is not closing anything: it goes back where it came
    // from, down (or right, when the phone is sideways), and keeps its state.
    hideDown: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
    hideRight: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    caret: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5"/></svg>',
    // The plot's own fit buttons: the same drawings as the desktop toolbar's.
    fitX: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5v14M20 5v14"/><path d="M8 12h8M8 12l3-3M8 12l3 3M16 12l-3-3M16 12l-3 3"/></svg>',
    fitY: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14M5 20h14"/><path d="M12 8v8M12 8l-3 3M12 8l3 3M12 16l-3-3M12 16l3-3"/></svg>',
    fitAll: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>',
    // The More sheet's menu, drawn like the rest of the phone layout.
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5l11 7-11 7z"/></svg>',
    save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h8V3M8 21v-7h8v7"/></svg>',
    archive: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18v4H3z"/><path d="M5 8v12h14V8"/><path d="M10 12h4"/></svg>',
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h6l2 2h10v11H3z"/><path d="M3 11h18"/></svg>',
    convert: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h14l-3-3M20 16H6l3 3"/></svg>',
    gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
    help: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><path d="M12 17.5v.01"/></svg>',
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
    download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8h11v12H8z"/><path d="M5 16V4h11"/></svg>',
};

// The main menu on a phone: its items by what they are for, each with its
// own icon. An item the desktop menu adds later and this table does not know
// still shows, at the end of Tools, with the desktop's own icon.
const MENU_GROUPS = [
    { titleKey: 'compactMenuProject', items: [
        { action: 'extraSaveViewJson', icon: 'save' },
        { action: 'extraSaveProjectZip', icon: 'archive' },
        { action: 'extraLoadSessionProject', icon: 'folder' },
    ] },
    { titleKey: 'compactMenuTools', items: [
        { action: 'extraConvertToParquet', icon: 'convert' },
        { action: 'extraDisplaySettings', icon: 'gear' },
    ] },
    { titleKey: 'compactMenuHelp', items: [
        { action: 'help', icon: 'help' },
        { action: 'extraFeedback', icon: 'chat' },
    ] },
];
// Desktop-only items: an application to download, folders of a local tool.
const MENU_HIDDEN = new Set(['extraStandalone', 'extraOnlineVersion', 'extraPhoneLayout', 'openOpenModelicaTemp', 'openDymolaDirectory']);

// Modes whose plots carry the fit buttons: the ones the phone layout drives.
const FIT_BUTTON_MODES = new Set(['timeseries', 'phase2d', 'fft', 'temporal-profile', 'integral']);
// An analysis's own pane, next to its time pane: which mode draws it. (The
// integral's pie has no axes to fit.)
const ANALYSIS_PANE_MODE = { spectrum: 'fft', profile: 'temporal-profile', integral: 'integral' };
// Where a slow double tap draws a window: the modes with a time axis.
const WINDOW_ZOOM_MODES = new Set(['timeseries', 'fft', 'temporal-profile', 'integral']);

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
    { mode: 'temporal-profile', labelKey: 'analysisItemProfile' },
    { mode: 'integral', labelKey: 'analysisItemIntegral' },
];

// The analyses whose signals the phone layout lists and edits like a time
// series: a tap in Data adds or removes one.
const SIGNAL_LIST_MODES = new Set(['timeseries', 'fft', 'temporal-profile', 'integral']);

// Plot types the phone layout sets up end to end.
const COMPACT_PLOT_TYPES = [
    { mode: 'timeseries', labelKey: 'modeTimeseries' },
    { mode: 'phase2d', labelKey: 'compactPlotType2d' },
    { mode: 'phase3d', labelKey: 'compactPlotType3d' },
    { mode: 'state-anim', dim: 2, labelKey: 'compactPlotTypeAnim2d' },
    { mode: 'state-anim', dim: 3, labelKey: 'compactPlotTypeAnim3d' },
];

// Plots built from signals in roles, one tap per role: x then y (then z)
// for a curve, x₁ x₂ (x₃) for an animation's state.
const PHASE_MODES = new Set(['phase2d', 'phase3d']);
const STATE_SLOT_LABELS = ['x₁', 'x₂', 'x₃'];

const TIME_FAMILY = new Set(['timeseries', 'fft', 'histogram', 'heatmap', 'temporal-profile', 'integral']);

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

const FULLSCREEN_DIALOGS = [
    '.modal-dialog-checklist',
    '.modal-dialog-wide',
    '.modal-dialog-stats',
    '.modal-dialog-excel-sheets',
    '.modal-dialog-mat-variables',
    '.modal-dialog-plot-export',
    '.modal-dialog-csv-pattern-help',
    '.plot-settings-dialog',
    '.feedback-dialog',
    '.desktop-download-dialog',
].join(', ');

// Dialogs whose own ✕ already sits where a finger finds it.
const OWN_CLOSE_BUTTONS = '.plot-settings-header-close, .help-modal-close, .compact-dialog-close';
// Dialogs with a ✕ of their own that the phone layout replaces (it is lost
// in their narrow header): the new ✕ presses it.
const REPLACED_CLOSE_BUTTONS = '.feedback-close, .desktop-download-close';

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
        onPlotDrawn(div => { if (this._compact.active) this._compactSyncFitButtons(div); });
        this.plotManager.onCompactChooseSignals = () => this._openCompactSheet('data', { toggle: false });
        // Dialogs are appended to <body>; the large ones go full screen.
        if (typeof MutationObserver !== 'undefined') {
            new MutationObserver(records => {
                if (!this._compact.active) return;
                for (const record of records) {
                    for (const node of record.addedNodes) {
                        if (node.nodeType === 1 && node.classList.contains('modal-overlay')) this._compactDecorateDialog(node);
                    }
                }
            }).observe(document.body, { childList: true });
        }
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
        // iOS leaves the page zoomed in after a field it zoomed into loses
        // focus; the layout is then wider than the screen and its edges are cut.
        document.addEventListener('focusout', () => {
            if (this._compact.active) setTimeout(() => this._resetCompactZoom(), 0);
        });
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
        this._compactCloseBtn = button('compact-icon-btn compact-sheet-close', '', () => this._closeCompactSheet(), { icon: SVG.hideDown, title: i18n.t('compactHide') });
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

    // Sideways, iOS reports the same safe-area inset on both sides, though
    // the notch (or the island) is on one only: the plot gave up ~50 pt on
    // the side without it. The way the phone is turned says which side it is.
    proto._syncCompactNotchSide = function() {
        const angle = Number(window.screen?.orientation?.angle ?? window.orientation);
        // 90: turned anticlockwise, the top of the phone (and its notch) is on
        // the left; 270 / -90: on the right. Anything else: keep both insets.
        const notch = angle === 90 ? 'left' : (angle === 270 || angle === -90) ? 'right' : '';
        document.documentElement.dataset.compactNotch = notch;
    };

    proto._applyCompactLayout = function() {
        this._syncCompactNotchSide();
        const { width, height } = effectiveViewportSize({
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            screenWidth: window.screen?.width,
            screenHeight: window.screen?.height,
        });
        const want = shouldUseCompactLayout({ width, height, override: this._compact.override });
        const landscape = isLandscapeViewport(width, height);
        const root = document.documentElement;
        // The first run always applies: the boot script in index.html may
        // already have set the classes, but not built anything else.
        const changed = !this._compact.applied || want !== this._compact.active;
        this._compact.applied = true;
        const turned = landscape !== this._compact.landscape;
        this._compact.landscape = landscape;
        root.classList.toggle('compact-landscape', want && landscape);
        this._syncCompactSizeButton?.();
        if (!changed) {
            if (want && turned) {
                this._resetCompactZoom();
                if (this._compact.sheet) this._applyCompactSheetSize();
                this._scheduleCompactResize();
            }
            return;
        }
        this._compact.active = want;
        root.classList.toggle('compact', want);
        this._syncCompactViewportMeta();
        // Empty panels say how to fill them, which differs between layouts.
        this.plotManager.compactLayout = want;
        document.querySelectorAll('#plots-area .layout-panel').forEach(panel => {
            this.plotManager._updatePlaceholder?.(panel.dataset.id, panel);
        });
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

    // iOS Safari zooms the page in when a field with text under 16 px takes
    // focus, and does not zoom back out: the phone layout then overflows the
    // screen, its right edge and one of its bars cut off. maximum-scale=1 stops
    // that zoom. iOS ignores it for pinch gestures (accessibility), so pinch
    // zoom stays available there; other mobile browsers obey it and would lose
    // pinch zoom, so it is only set where WebKit's touch gesture events exist.
    // Detected by feature, not by user agent.
    proto._compactIsIosWebKit = function() {
        return typeof window.GestureEvent !== 'undefined' && (navigator.maxTouchPoints || 0) > 0;
    };

    proto._syncCompactViewportMeta = function({ force = false } = {}) {
        const meta = document.querySelector('meta[name="viewport"]');
        if (!meta) return;
        if (this._compact.baseViewport == null) this._compact.baseViewport = meta.getAttribute('content') || '';
        const base = this._compact.baseViewport;
        const want = this._compact.active && this._compactIsIosWebKit()
            ? `${base}, maximum-scale=1`
            : base;
        if (force || meta.getAttribute('content') !== want) meta.setAttribute('content', want);
    };

    // Rewriting the viewport tag is the only way a page can bring iOS back to
    // scale 1. Only when it is off: a zoom the user pinched is not undone while
    // they are using it, only after a field or a rotation.
    proto._resetCompactZoom = function() {
        if (!this._compact?.active || !this._compactIsIosWebKit()) return;
        const scale = window.visualViewport?.scale ?? 1;
        if (scale <= 1.01) return;
        const meta = document.querySelector('meta[name="viewport"]');
        if (!meta) return;
        meta.setAttribute('content', `${this._compact.baseViewport}, maximum-scale=1, minimum-scale=1`);
        requestAnimationFrame(() => this._syncCompactViewportMeta({ force: true }));
    };

    // A dialog with more than a short question in it takes the whole screen,
    // with a ✕ that stays at the top while its content scrolls. Short choices
    // (a confirmation, "use this row as") stay a centred card.
    proto._compactDecorateDialog = function(overlay) {
        const dialog = overlay.querySelector('.modal-dialog');
        if (!dialog || dialog.classList.contains('modal-dialog-csv-row-actions')) return;
        requestAnimationFrame(() => {
            if (!overlay.isConnected) return;
            const large = dialog.matches(FULLSCREEN_DIALOGS)
                || dialog.scrollHeight > window.innerHeight * 0.55;
            if (!large) return;
            overlay.classList.add('compact-fullscreen-overlay');
            dialog.classList.add('compact-fullscreen-dialog');
            if (overlay.querySelector(OWN_CLOSE_BUTTONS)) return;
            const close = button('compact-icon-btn compact-dialog-close', '', () => {
                // The dialog's own way out: its ✕, its Cancel, its only button,
                // or Escape.
                const own = dialog.querySelector(REPLACED_CLOSE_BUTTONS);
                const cancel = dialog.querySelector('.modal-buttons .modal-btn-cancel');
                const buttons = dialog.querySelectorAll('.modal-buttons .modal-btn');
                if (own) own.click();
                else if (cancel) cancel.click();
                else if (buttons.length === 1) buttons[0].click();
                else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            }, { icon: SVG.close, title: i18n.t('compactClose') });
            // On the overlay, which does not scroll: it stays put while the
            // dialog's content scrolls under it, and takes no room from it.
            overlay.appendChild(close);
        });
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
        this._compactCloseBtn.title = i18n.t('compactHide');
        this._compactCloseBtn.setAttribute('aria-label', i18n.t('compactHide'));
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

    // ── Fit buttons on the plot ─────────────────────────────────────────
    // Three faint buttons in the plot's top-right corner: fit X, fit Y, fit
    // both. A double tap fits everything too, but nobody finds it, and the
    // Plot sheet is a sheet away. They sit inside the plot's own div (Plotly
    // keeps what it did not draw), outside its drag layer, so a finger on them
    // is a press and never a pan.
    proto._compactPlotForDiv = function(div) {
        for (const [panelId, plot] of this.plotManager.plots) {
            if (plot.div === div) return { panelId, plot, pane: 'main' };
            if (plot.fftDiv === div) return { panelId, plot, pane: 'spectrum' };
            if (plot.temporalProfileDiv === div) return { panelId, plot, pane: 'profile' };
            if (plot.integralDiv === div) return { panelId, plot, pane: 'integral' };
        }
        return null;
    };

    proto._compactSyncAllFitButtons = function() {
        if (!this._compact?.active) return;
        for (const plot of this.plotManager.plots.values()) {
            if (plot.div) this._compactSyncFitButtons(plot.div);
            if (plot.fftDiv) this._compactSyncFitButtons(plot.fftDiv);
            if (plot.temporalProfileDiv) this._compactSyncFitButtons(plot.temporalProfileDiv);
            if (plot.integralDiv) this._compactSyncFitButtons(plot.integralDiv);
        }
    };

    proto._compactSyncFitButtons = function(div) {
        if (!div?.isConnected) return;
        const owner = this._compactPlotForDiv(div);
        // A slow double tap draws a time (or frequency) window and zooms to
        // it: the phone's box zoom, where a finger otherwise pans.
        if (owner && !div._touchWindowZoom) {
            div._touchWindowZoom = () => {
                const current = this._compactPlotForDiv(div);
                if (!this._compact.active || !current) return null;
                if (!WINDOW_ZOOM_MODES.has(current.plot.mode)) return null;
                // The integral's bars are per period, not a time axis to window.
                if (current.pane === 'integral') return null;
                return { hint: i18n.t('compactWindowZoomHint') };
            };
        }
        let group = div._compactFitGroup;
        const wanted = !!owner
            && FIT_BUTTON_MODES.has(owner.plot.mode)
            && (owner.pane === 'main' || ANALYSIS_PANE_MODE[owner.pane] === owner.plot.mode)
            && this.plotManager._hasContent(owner.plot)
            && !!div._fullLayout;
        if (!wanted) {
            if (group) group.hidden = true;
            return;
        }
        if (!group || group.parentNode !== div) {
            group = el('div', 'compact-fit-group');
            for (const [axis, icon, titleKey] of [['x', SVG.fitX, 'autoScaleXTitle'], ['y', SVG.fitY, 'autoScaleYTitle'], ['all', SVG.fitAll, 'viewHome']]) {
                const btn = button('compact-fit-btn', '', () => this._compactFit(div, axis), { icon, title: i18n.t(titleKey) });
                btn.dataset.axis = axis;
                group.appendChild(btn);
            }
            div.appendChild(group);
            div._compactFitGroup = group;
        }
        group.hidden = false;
        // The corner of the plotting area, not of the div: clear of the axis
        // labels on the right and of a legend placed above the plot.
        const size = div._fullLayout._size || {};
        group.style.top = `${Math.max(0, Number(size.t) || 0) + 6}px`;
        group.style.right = `${Math.max(0, Number(size.r) || 0) + 6}px`;
    };

    proto._compactFit = function(div, axis) {
        const owner = this._compactPlotForDiv(div);
        if (!owner) return;
        const pm = this.plotManager;
        const { panelId, plot, pane } = owner;
        const relayout = (update) => (update && Object.keys(update).length ? Plotly.relayout(div, update) : Promise.resolve());
        let work;
        if (plot.mode === 'fft' && pane === 'spectrum') {
            // The spectrum alone: its own limits (fMin/fMax, yMin/yMax) still
            // hold, as they do for its desktop reset.
            work = axis === 'all'
                ? () => pm._applyFftAxisLimits(plot)
                : () => relayout(pm._fftAxisLimitUpdate(plot, axis, { visibleOnly: true }));
        } else if (plot.mode === 'temporal-profile' && pane === 'profile') {
            // X goes back to the whole period (0–24 h, a week…), Y fits.
            work = axis === 'all'
                ? () => pm._resetTemporalProfileAnalysisView(plot)
                : () => pm._autoScaleTemporalProfileAxis(plot, axis);
        } else if (plot.mode === 'integral' && pane === 'integral') {
            work = axis === 'all'
                ? () => pm._resetIntegralAnalysisView(plot)
                : () => pm._autoScaleIntegralAxis(plot, axis);
        } else if (plot.mode === 'fft' || plot.mode === 'temporal-profile' || plot.mode === 'integral') {
            // The time pane beside the analysis is the timeseries chart.
            work = axis === 'all'
                ? () => pm._autoScalePlotTimeOnly(plot)
                : () => relayout(pm._autoScaleAxisUpdate(plot, axis, { treatAsTimeseries: true }));
        } else {
            work = axis === 'all'
                ? () => pm._autoScalePlot(panelId, plot)
                : () => pm._autoScalePlotAxis(panelId, plot, axis);
        }
        // The label of the last tap would come back after the fit, over a
        // point that has moved.
        clearPlotHover(div, Plotly);
        pm._runWithEagerDetailLoading(panelId, work);
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
        if (!names.length && plot?.mode === 'state-anim' && plot.stateSlots?.x?.length) {
            names.push(plot.stateSlots.x.join(', '));
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
        // Traces come and go without a redraw of their own (a cleared plot):
        // the fit buttons follow whatever the app bar follows.
        this._compactSyncAllFitButtons();
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

    proto._openCompactSheet = function(id, { toggle = true, focus = null, returnTo = null } = {}) {
        if (!this._compact?.active) return;
        if (this._compact.sheet === id && toggle) {
            this._closeCompactSheet();
            return;
        }
        const wasOpen = !!this._compact.sheet;
        this._releaseCompactPages();
        this._compact.sheet = id;
        this._compact.focus = focus;
        // Where "Done" goes: back to the sheet that sent the user here.
        this._compact.returnTo = returnTo;
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
        const hideIcon = this._compactCloseBtn?.querySelector('.compact-btn-icon');
        if (hideIcon) hideIcon.innerHTML = this._compact?.landscape ? SVG.hideRight : SVG.hideDown;
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

    // Switching a plot's type. Within the time-series family the signals are
    // kept; across families they are not, and the user is asked first, in a
    // dialog rather than the desktop's in-panel banner.
    proto._compactSetPlotMode = async function(mode, stateAnimDim = null) {
        const pm = this.plotManager;
        const panelId = this._compactActivePanelId();
        const plot = panelId ? pm.plots.get(panelId) : null;
        if (!plot) return;
        const sameAnim = mode !== 'state-anim' || (plot.stateAnimDim || 2) === (stateAnimDim || 2);
        if (plot.mode === mode && sameAnim) return;
        if (TIME_FAMILY.has(plot.mode) && TIME_FAMILY.has(mode)) {
            pm._requestModeChange(panelId, mode);
        } else {
            if (pm._hasContent(plot)) {
                const ok = await Modal.confirm(i18n.t('modeChangeClearsTracesWarning'), { icon: '⚠' });
                if (!ok) return;
            }
            pm._setMode(panelId, mode, mode === 'state-anim' ? (stateAnimDim || 2) : null);
        }
        this._compactSyncTreeMarks();
        this._compactUpdateAppBar();
        // The new chart is built asynchronously.
        setTimeout(() => {
            if (this._compact.sheet === 'plot' || this._compact.sheet === 'analyze') this._renderCompactSheetContent();
        }, 60);
    };

    // What a 2D plot is waiting for, in words: an X signal, or the Y to pair
    // with the X already chosen.
    proto._compactPhaseHint = function(plot) {
        if (plot?.mode === 'state-anim') {
            const dim = plot.stateAnimDim || 2;
            const filled = plot.stateSlots?.x?.length || 0;
            return filled < dim
                ? i18n.t('compactStateNext').replace('{slot}', STATE_SLOT_LABELS[filled])
                : i18n.t('compactStateFull').replace('{n}', String(dim));
        }
        const pending = plot?.phasePending;
        if (pending?.x && plot.mode === 'phase3d' && pending.y) {
            return i18n.t('compactPendingZ')
                .replace('{x}', this._compactVarLabel(pending.x, pending.fileId))
                .replace('{y}', this._compactVarLabel(pending.y, pending.fileId));
        }
        if (pending?.x) return i18n.t('compactPendingY').replace('{x}', this._compactVarLabel(pending.x, pending.fileId));
        return i18n.t(plot?.mode === 'phase3d' ? 'compactPhaseHint3d' : 'compactPhaseHint');
    };

    // Does this plot take its signals in roles (x, y, z; x₁, x₂, x₃)?
    const usesRoles = (plot) => PHASE_MODES.has(plot?.mode) || plot?.mode === 'state-anim';

    proto._compactVarLabel = function(varName, fileId) {
        const variable = this.plotManager.files.get(fileId || this.activeFileId)?.data?.variables?.[varName];
        return variable?.displayName || varName;
    };

    proto._compactSyncPhaseBanner = function() {
        const banner = this._compactPhaseBanner;
        if (!banner) return;
        const plot = this.plotManager.plots.get(this._compactActivePanelId());
        const show = usesRoles(plot);
        banner.hidden = !show;
        if (!show) return;
        banner.querySelector('.compact-phase-text').textContent = this._compactPhaseHint(plot);
        banner.querySelector('.compact-phase-cancel').hidden = !(PHASE_MODES.has(plot.mode) && plot.phasePending?.x);
    };

    proto._compactCancelPhasePending = function() {
        const pm = this.plotManager;
        const panelId = this._compactActivePanelId();
        const plot = pm.plots.get(panelId);
        if (!plot) return;
        plot.phasePending = { x: null, y: null, z: null, fileId: null };
        const panelEl = this._compactActivePanelEl();
        if (panelEl) {
            pm._setPendingOverlay?.(panelId, panelEl, false);
            pm._updatePlaceholder?.(panelId, panelEl);
        }
        this._compactSyncTreeMarks();
        this._compactSyncPhaseBanner();
        if (this._compact.sheet === 'plot') this._renderCompactSheetContent();
    };

    proto._compactHelpBox = function() {
        const box = el('div', 'compact-help-box');
        box.appendChild(el('h4', '', i18n.t('compactHelpTitle')));
        const list = el('ul');
        for (const key of ['compactHelpData', 'compactHelpPlot', 'compactHelpAnalyze', 'compactHelpMore', 'compactHelpGestures']) {
            list.appendChild(el('li', '', i18n.t(key)));
        }
        box.append(list, el('p', '', i18n.t('compactHelpBelow')));
        return box;
    };

    // ─── Data: files and signals ──────────────────────────────────

    proto._buildCompactDataPage = function() {
        const node = el('div', 'compact-page compact-page-data');
        // Which plot a tap goes to. Without it, the ✓ beside a signal said
        // "on a plot" without saying which, and with two plots a tap seemed
        // to act on nothing in particular.
        const target = el('div', 'compact-data-target');
        target.setAttribute('aria-live', 'polite');
        node.appendChild(target);
        this._compactDataTarget = target;
        const actions = el('div', 'compact-action-row');
        actions.appendChild(button('compact-primary-btn', i18n.t('compactOpenFile'), () => {
            document.getElementById('load-new-file')?.click();
        }));
        node.appendChild(actions);
        // In a 2D plot a tap is an X, then a Y: the banner says which comes next.
        const banner = el('div', 'compact-phase-banner');
        banner.setAttribute('aria-live', 'polite');
        banner.appendChild(el('span', 'compact-phase-text'));
        banner.appendChild(button('compact-link-btn compact-phase-cancel', i18n.t('cancel'), () => this._compactCancelPhasePending()));
        node.appendChild(banner);
        this._compactPhaseBanner = banner;
        const sidebar = document.getElementById('sidebar');
        const restore = this._lendToCompact(sidebar, node);
        this._compactSyncTreeMarks();
        this._compactSyncPhaseBanner();
        this._compactSyncDataTarget();
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
        const pending = plot?.phasePending;
        if (PHASE_MODES.has(plot?.mode) && pending?.x
            && (pending.x === varName || pending.y === varName)
            && (pending.fileId || this.activeFileId) === ownerId) {
            // A signal of the curve still being chosen, tapped again: changed
            // one's mind.
            this._compactCancelPhasePending();
            return;
        }
        if (plot?.mode === 'state-anim') {
            await this._compactToggleStateVar(panelId, panelEl, plot, varName, ownerId);
            return;
        }
        const removing = !!plot && index >= 0 && SIGNAL_LIST_MODES.has(plot.mode);
        if (removing) {
            if (plot.mode === 'timeseries') pm.removeTrace(panelId, varName, ownerId);
            else if (plot.mode === 'fft') pm._removeFftTraceFromLegend(panelId, plot, plot.traces[index]);
            else if (plot.mode === 'integral') pm._removeIntegralTraceFromLegend(panelId, plot, plot.traces[index]);
            else pm._removeTemporalProfileTraceFromLegend(panelId, plot, plot.traces[index]);
        } else {
            await pm._handleVariableDrop(panelId, [varName], panelEl, { fileId });
        }
        // Say what happened, and to which plot. A 2D plot has its banner.
        const after = pm.plots.get(panelId);
        if (after && SIGNAL_LIST_MODES.has(after.mode)) {
            const nowOn = (after.traces || []).some(trace => trace.varName === varName && trace.fileId === ownerId);
            if (nowOn !== removing) {
                const n = this._compactPanelIds().indexOf(panelId) + 1;
                this._compactToast(i18n.t(removing ? 'compactRemovedFrom' : 'compactAddedTo')
                    .replace('{n}', String(n))
                    .replace('{name}', this._compactVarLabel(varName, ownerId)));
            }
        }
        requestAnimationFrame(() => {
            this._compactSyncTreeMarks();
            this._compactSyncPhaseBanner();
            this._compactUpdateAppBar();
        });
    };

    // An animation's state: a tap assigns the next of x₁, x₂ (x₃), a tap on
    // one assigned takes it off, and a full state says so instead of
    // silently ignoring the tap.
    proto._compactToggleStateVar = async function(panelId, panelEl, plot, varName, ownerId) {
        const pm = this.plotManager;
        const slots = plot.stateSlots || (plot.stateSlots = { x: [], dx: [], fileId: null });
        const dim = plot.stateAnimDim || 2;
        const sameFile = !slots.fileId || slots.fileId === ownerId;
        if (sameFile && slots.x.includes(varName)) {
            slots.x = slots.x.filter(name => name !== varName);
            if (!slots.x.length) {
                pm._clearPanel(panelId);
            } else {
                const data = pm.files.get(slots.fileId)?.data;
                slots.dx = data ? slots.x.map(name => pm.parser.findDerivative(name, data.variables)) : [];
                pm._destroyChart(panelId);
                const placeholder = panelEl.querySelector('.layout-panel-placeholder');
                if (placeholder) placeholder.style.display = '';
                pm._updatePlaceholder(panelId, panelEl);
            }
        } else if (slots.x.length >= dim) {
            this._compactToast(this._compactPhaseHint(plot));
            return;
        } else if (!sameFile) {
            // One file's state at a time: its derivatives come from it.
            this._compactToast(i18n.t('compactStateOneFile'));
            return;
        } else {
            await pm._handleVariableDrop(panelId, [varName], panelEl, { fileId: ownerId === this.activeFileId ? null : ownerId });
        }
        requestAnimationFrame(() => {
            this._compactSyncTreeMarks();
            this._compactSyncPhaseBanner();
            this._compactUpdateAppBar();
        });
    };

    // The bar at the top of Data: "a tap adds to, or removes from: plot n",
    // with the other plots one tap away, and Done to go back.
    proto._compactSyncDataTarget = function() {
        // Built with its page, before the page is in the sheet; a stale one
        // (the page closed) is harmless to refill.
        const bar = this._compactDataTarget;
        if (!bar) return;
        bar.replaceChildren();
        const ids = this._compactPanelIds();
        const activeId = this._compactActivePanelId();
        const plot = activeId ? this.plotManager.plots.get(activeId) : null;
        const head = el('div', 'compact-data-target-head');
        const targetKey = plot?.mode === 'phase2d' ? 'compactTapTargetPhase'
            : plot?.mode === 'phase3d' ? 'compactTapTargetPhase3d'
            : plot?.mode === 'state-anim' ? 'compactTapTargetState'
            : 'compactTapTarget';
        // The same chips whether there is one plot or several: the line reads
        // the same either way, and a second plot only adds a chip.
        head.appendChild(el('span', 'compact-data-target-text', i18n.t(targetKey)));
        head.appendChild(button('compact-link-btn compact-data-done', i18n.t('compactDone'), () => {
            if (this._compact.returnTo) this._openCompactSheet(this._compact.returnTo, { toggle: false });
            else this._closeCompactSheet();
        }));
        bar.appendChild(head);
        const chips = el('div', 'compact-data-target-plots');
        chips.setAttribute('role', 'radiogroup');
        ids.forEach((id, index) => {
            const selected = id === activeId;
            const summary = this._compactPanelSummary(id);
            const chip = button(`compact-target-chip${selected ? ' is-active' : ''}`, i18n.t('compactPlotN').replace('{n}', String(index + 1)), () => {
                if (id !== this._compactActivePanelId()) this._setCompactActivePanel(id);
            }, { title: summary.text ? `${summary.modeLabel} · ${summary.text}` : summary.modeLabel });
            chip.setAttribute('role', 'radio');
            chip.setAttribute('aria-checked', String(selected));
            // Alone, it is the target and there is nothing to choose.
            chip.disabled = ids.length === 1;
            chips.appendChild(chip);
        });
        bar.appendChild(chips);
    };

    // A short line over the plot, then gone.
    proto._compactToast = function(text) {
        if (!text) return;
        let toast = this._compactToastEl;
        if (!toast?.isConnected) {
            toast = el('div', 'compact-toast');
            toast.setAttribute('role', 'status');
            document.body.appendChild(toast);
            this._compactToastEl = toast;
        }
        toast.textContent = text;
        toast.classList.add('is-shown');
        clearTimeout(this._compactToastTimer);
        this._compactToastTimer = setTimeout(() => toast.classList.remove('is-shown'), 1800);
    };

    proto._compactSyncTreeMarks = function() {
        if (!this._compact?.active) return;
        this._compactSyncDataTarget();
        const panelId = this._compactActivePanelId();
        const plot = panelId ? this.plotManager.plots.get(panelId) : null;
        const onPlot = new Set((plot?.traces || []).map(trace => `${trace.fileId}\u0000${trace.varName}`));
        // A 2D plot uses a signal as x or y (or both, in different pairs).
        const roles = new Map();
        const addRole = (fileId, name, role) => {
            if (!name) return;
            const key = `${fileId || this.activeFileId}\u0000${name}`;
            const list = roles.get(key) || [];
            if (!list.includes(role)) list.push(role);
            roles.set(key, list);
        };
        if (PHASE_MODES.has(plot?.mode)) {
            for (const curve of plot.phaseTraces || []) {
                addRole(curve.fileId, curve.x, 'x');
                addRole(curve.fileId, curve.y, 'y');
                if (plot.mode === 'phase3d') addRole(curve.fileId, curve.z, 'z');
            }
        } else if (plot?.mode === 'state-anim') {
            (plot.stateSlots?.x || []).forEach((name, index) => addRole(plot.stateSlots.fileId, name, STATE_SLOT_LABELS[index]));
        }
        // The curve still being chosen: its signals, marked as waiting.
        const pending = new Map();
        if (PHASE_MODES.has(plot?.mode) && plot.phasePending?.x) {
            const fileId = plot.phasePending.fileId || this.activeFileId;
            pending.set(`${fileId}\u0000${plot.phasePending.x}`, 'x …');
            if (plot.phasePending.y) pending.set(`${fileId}\u0000${plot.phasePending.y}`, 'y …');
        }
        document.querySelectorAll('#variables-tree .tree-item[data-var-name]').forEach(item => {
            const key = `${item.dataset.fileId || this.activeFileId}\u0000${item.dataset.varName}`;
            const role = roles.get(key);
            item.classList.toggle('compact-on-plot', onPlot.has(key) || !!role);
            item.classList.toggle('compact-pending', pending.has(key));
            if (pending.has(key)) item.dataset.compactRole = pending.get(key);
            else if (role) item.dataset.compactRole = role.join(', ');
            else delete item.dataset.compactRole;
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

        const typeSection = section(i18n.t('compactPlotType'));
        const typeRow = el('div', 'compact-list compact-radio-list compact-plot-types');
        typeRow.setAttribute('role', 'radiogroup');
        const currentMode = plot?.mode || 'timeseries';
        for (const type of COMPACT_PLOT_TYPES) {
            const selected = type.mode === 'timeseries' ? TIME_FAMILY.has(currentMode)
                : type.mode === 'state-anim' ? currentMode === 'state-anim' && (plot?.stateAnimDim || 2) === type.dim
                : currentMode === type.mode;
            const btn = button(`compact-list-btn compact-radio${selected ? ' is-active' : ''}`, i18n.t(type.labelKey), () => {
                if (!selected) this._compactSetPlotMode(type.mode, type.dim || null);
            });
            btn.dataset.plotType = type.dim ? `${type.mode}-${type.dim}d` : type.mode;
            btn.setAttribute('role', 'radio');
            btn.setAttribute('aria-checked', String(selected));
            typeRow.appendChild(btn);
        }
        typeSection.appendChild(typeRow);
        node.appendChild(typeSection);

        const hasContent = !!plot && pm._hasContent(plot);
        const view = section(i18n.t('compactView'));
        const viewRow = el('div', 'compact-action-row');
        const run = (work) => {
            if (!panelId) return;
            pm._runWithEagerDetailLoading(panelId, work);
        };
        const mode = plot?.mode || 'timeseries';
        if (mode === 'fft') {
            viewRow.appendChild(button('compact-secondary-btn', i18n.t('fftResetLabel'), () => pm._resetFftView(panelId), { title: i18n.t('fftResetView') }));
        } else if (mode === 'temporal-profile') {
            viewRow.appendChild(button('compact-secondary-btn', i18n.t('temporalProfileReset'), () => pm._resetTemporalProfileView(panelId), { title: i18n.t('temporalProfileResetTip') }));
        } else if (mode === 'integral') {
            viewRow.appendChild(button('compact-secondary-btn', i18n.t('integralReset'), () => pm._resetIntegralView(panelId), { title: i18n.t('integralResetTip') }));
        } else if (mode !== 'timeseries') {
            // Fitting X and Y apart means nothing in a phase plot or a 3D scene.
            const autoBtn = button('compact-secondary-btn', '⛶ ' + i18n.t('viewHome'), () => run(() => pm._autoScalePlot(panelId, pm.plots.get(panelId))));
            autoBtn.disabled = !hasContent;
            viewRow.appendChild(autoBtn);
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
        if (PHASE_MODES.has(mode)) {
            this._buildCompactPhasePairs(signals, panelId, plot);
        } else if (mode === 'state-anim') {
            this._buildCompactStateSlots(signals, panelId, plot);
        } else if (!SIGNAL_LIST_MODES.has(mode)) {
            // Phase plots and animations pair their signals in roles (x, y,
            // z, dx/dt) that the phone layout does not edit yet.
            const summary = this._compactPanelSummary(panelId);
            if (summary.names.length) signals.appendChild(el('p', 'compact-plot-signals', summary.names.join(' · ')));
            signals.appendChild(el('p', 'compact-note', i18n.t('compactPlotModeNote')));
            if (hasContent) {
                const clearRow = el('div', 'compact-action-row');
                clearRow.appendChild(button('compact-secondary-btn compact-danger-btn', i18n.t('clearPlot'), () => {
                    pm._clearPanel(panelId);
                    this._compactUpdateAppBar();
                    this._renderCompactSheetContent();
                }));
                signals.appendChild(clearRow);
            }
        } else if (!traces.length) {
            signals.appendChild(el('p', 'compact-note', i18n.t('compactNoSignals')));
            const addRow = el('div', 'compact-action-row');
            addRow.appendChild(button('compact-primary-btn', i18n.t('compactChooseSignals'), () => this._openCompactSheet('data', { toggle: false, returnTo: 'plot' })));
            signals.appendChild(addRow);
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
            // More signals come from Data, where a tap adds one to this plot.
            const addRow = el('div', 'compact-action-row');
            addRow.appendChild(button('compact-primary-btn compact-add-signals-btn', '+ ' + i18n.t('compactAddMoreSignals'), () => this._openCompactSheet('data', { toggle: false, returnTo: 'plot' })));
            signals.appendChild(addRow);
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

    // A 2D plot's curves are x–y pairs: listed with a way to remove each, the
    // X still waiting for its Y, the 1:1 aspect, and the way to add a pair.
    proto._buildCompactPhasePairs = function(container, panelId, plot) {
        const pm = this.plotManager;
        const pairs = plot?.phaseTraces || [];
        const pendingX = plot?.phasePending?.x;
        if (pairs.length || pendingX) {
            const list = el('div', 'compact-list');
            for (const pair of [...pairs]) {
                const row = el('div', 'compact-trace-row');
                const swatch = el('span', 'compact-swatch');
                swatch.style.background = pair.color || 'currentColor';
                const label = [pair.x, pair.y, plot.mode === 'phase3d' ? pair.z : null]
                    .filter(Boolean).map(name => this._compactVarLabel(name, pair.fileId)).join(' / ');
                const name = el('span', 'compact-trace-name', label);
                const remove = button('compact-icon-btn compact-trace-remove', '', async () => {
                    await pm._removePhaseTraceFromLegend(panelId, plot, pair);
                    this._compactSyncTreeMarks();
                    this._compactUpdateAppBar();
                    this._renderCompactSheetContent();
                }, { icon: SVG.close, title: i18n.t('compactRemoveSignal').replace('{name}', label) });
                row.append(swatch, name, remove);
                list.appendChild(row);
            }
            if (pendingX) {
                const row = el('div', 'compact-trace-row compact-trace-pending');
                row.appendChild(el('span', 'compact-trace-name', this._compactPhaseHint(plot)));
                row.appendChild(button('compact-link-btn', i18n.t('cancel'), () => this._compactCancelPhasePending()));
                list.appendChild(row);
            }
            container.appendChild(list);
        } else {
            container.appendChild(el('p', 'compact-note', this._compactPhaseHint(plot)));
        }
        const actions = el('div', 'compact-action-row');
        actions.appendChild(button('compact-secondary-btn', i18n.t('compactChooseSignals'), () => this._openCompactSheet('data', { toggle: false, returnTo: 'plot' })));
        if (pairs.length) {
            actions.appendChild(button('compact-secondary-btn compact-danger-btn', i18n.t('clearPlot'), () => {
                pm._clearPanel(panelId);
                this._compactSyncTreeMarks();
                this._compactUpdateAppBar();
                this._renderCompactSheetContent();
            }));
        }
        container.appendChild(actions);
        if (pairs.length && plot.mode === 'phase2d') {
            const aspect = el('label', 'compact-switch-row');
            const input = el('input');
            input.type = 'checkbox';
            input.checked = !!plot.equalAspect2D;
            input.disabled = !pm._equalAspectAllowed(plot);
            input.addEventListener('change', () => pm._toggleEqualAspect2D(panelId));
            aspect.append(el('span', '', i18n.t('viewEqualAspect')), input);
            container.appendChild(aspect);
        }
    };

    // An animation's state variables, each with its role and a way off; then
    // what the animation draws, as switches (its checkboxes, under the plot
    // on the desktop, are too small and too many for a phone's bar).
    proto._buildCompactStateSlots = function(container, panelId, plot) {
        const pm = this.plotManager;
        const slots = plot?.stateSlots || { x: [], fileId: null };
        if (slots.x.length) {
            const list = el('div', 'compact-list');
            slots.x.forEach((name, index) => {
                const row = el('div', 'compact-trace-row');
                row.appendChild(el('span', 'compact-state-role', STATE_SLOT_LABELS[index]));
                const label = this._compactVarLabel(name, slots.fileId);
                row.appendChild(el('span', 'compact-trace-name', label));
                row.appendChild(button('compact-icon-btn compact-trace-remove', '', async () => {
                    const panelEl = this._compactActivePanelEl();
                    if (panelEl) await this._compactToggleStateVar(panelId, panelEl, plot, name, slots.fileId);
                    this._renderCompactSheetContent();
                }, { icon: SVG.close, title: i18n.t('compactRemoveSignal').replace('{name}', label) }));
                list.appendChild(row);
            });
            container.appendChild(list);
        }
        if (slots.x.length < (plot?.stateAnimDim || 2)) container.appendChild(el('p', 'compact-note', this._compactPhaseHint(plot)));
        const actions = el('div', 'compact-action-row');
        actions.appendChild(button('compact-secondary-btn', i18n.t('compactChooseSignals'), () => this._openCompactSheet('data', { toggle: false, returnTo: 'plot' })));
        if (slots.x.length) {
            actions.appendChild(button('compact-secondary-btn compact-danger-btn', i18n.t('clearPlot'), () => {
                pm._clearPanel(panelId);
                this._compactSyncTreeMarks();
                this._compactUpdateAppBar();
                this._renderCompactSheetContent();
            }));
        }
        container.appendChild(actions);

        const controls = this._compactActivePanelEl()?.querySelector('.state-anim-controls');
        if (!controls) return;
        const display = el('div', 'compact-state-display');
        display.appendChild(el('h3', 'compact-section-title', i18n.t('compactAnimation')));
        for (const [selector, key] of [
            ['.sa-chk-full', 'saFull'], ['.sa-chk-trace', 'saTrace'], ['.sa-chk-arrow', 'saArrowX'],
            ['.sa-chk-dx', 'saArrowDx'], ['.sa-chk-norm', 'saNorm'], ['.sa-chk-dzoom', 'saDZoom'],
        ]) {
            const source = controls.querySelector(selector);
            const holder = source?.closest('.sa-toggle');
            if (!source || holder?.style.display === 'none') continue;
            const row = el('label', 'compact-switch-row');
            const input = el('input');
            input.type = 'checkbox';
            input.checked = source.checked;
            input.addEventListener('change', () => {
                source.checked = input.checked;
                source.dispatchEvent(new Event('change', { bubbles: true }));
            });
            row.append(el('span', '', i18n.t(key)), input);
            display.appendChild(row);
        }
        container.appendChild(display);
    };

    // ─── Analyze ──────────────────────────────────────────────────

    // What an analysis offers in the Analyze sheet: the buttons of its own
    // top bar (hidden on the plot), and its options panel, lent here.
    proto._compactAnalysisControls = function(mode, panelId, plot) {
        const pm = this.plotManager;
        if (mode === 'fft') {
            return {
                titleKey: 'compactFftOptions',
                options: () => pm._fftOptionsPanel(plot),
                actions: [
                    { label: i18n.t('fftResetLabel'), title: i18n.t('fftResetView'), run: () => pm._resetFftView(panelId) },
                    { label: 'V/H', title: i18n.t('fftLayoutToggle'), run: () => {
                        const current = pm._ensureFftState(plot).layout;
                        pm._setFftLayout(panelId, current === 'horizontal' ? 'vertical' : 'horizontal');
                    } },
                    { label: i18n.t('hideTimeSeries'), title: i18n.t('hideTimeSeriesTooltip'), run: () => pm._toggleFftTimeSeries(panelId) },
                ],
            };
        }
        if (mode === 'temporal-profile') {
            const hidden = !!pm._ensureTemporalProfileState(plot).timeSeriesHidden;
            const timeLabel = i18n.t(hidden ? 'temporalProfileShowTime' : 'temporalProfileHideTime');
            return {
                titleKey: 'compactProfileOptions',
                options: () => pm._temporalProfileOptionsPanel(plot),
                actions: [
                    { label: i18n.t('temporalProfileReset'), title: i18n.t('temporalProfileResetTip'), run: () => pm._resetTemporalProfileView(panelId) },
                    { label: 'V/H', title: i18n.t('fftLayoutToggle'), run: () => {
                        const current = pm._ensureTemporalProfileState(plot).layout;
                        pm._setTemporalProfileLayout(panelId, current === 'horizontal' ? 'vertical' : 'horizontal');
                    } },
                    { label: timeLabel, title: timeLabel, run: () => {
                        pm._toggleTemporalProfileTimeSeries(panelId);
                        this._renderCompactSheetContent();
                    } },
                ],
            };
        }
        if (mode === 'integral') {
            const hidden = !!pm._ensureIntegralState(plot).timeSeriesHidden;
            const timeLabel = i18n.t(hidden ? 'integralShowTime' : 'integralHideTime');
            return {
                titleKey: 'compactIntegralOptions',
                options: () => pm._integralOptionsPanel(plot),
                actions: [
                    { label: i18n.t('integralReset'), title: i18n.t('integralResetTip'), run: () => pm._resetIntegralView(panelId) },
                    { label: 'V/H', title: i18n.t('fftLayoutToggle'), run: () => {
                        const current = pm._ensureIntegralState(plot).layout;
                        pm._setIntegralLayout(panelId, current === 'horizontal' ? 'vertical' : 'horizontal');
                    } },
                    { label: timeLabel, title: timeLabel, run: () => {
                        pm._toggleIntegralTimeSeries(panelId);
                        this._renderCompactSheetContent();
                    } },
                ],
            };
        }
        return null;
    };

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
        if (!COMPACT_ANALYSES.some(analysis => analysis.mode === mode)) {
            // The plot is in a mode set up on the full layout (an example's
            // phase plot, a 3D animation): say so, selected, instead of
            // showing two options neither of which is true.
            const current = el('div', 'compact-list-btn compact-radio is-active compact-radio-static');
            current.setAttribute('role', 'radio');
            current.setAttribute('aria-checked', 'true');
            current.appendChild(el('span', 'compact-btn-label', this._compactPanelSummary(panelId).modeLabel));
            list.appendChild(current);
        }
        for (const analysis of COMPACT_ANALYSES) {
            const selected = mode === analysis.mode;
            const item = button(`compact-list-btn compact-radio${selected ? ' is-active' : ''}`, i18n.t(analysis.labelKey), () => {
                if (!panelId || selected) return;
                restoreOptions?.();
                restoreOptions = null;
                // The new chart, and the options panel it lends to this
                // sheet, are built asynchronously; the switch re-renders.
                this._compactSetPlotMode(analysis.mode);
            });
            item.setAttribute('role', 'radio');
            item.setAttribute('aria-checked', String(selected));
            list.appendChild(item);
        }
        choose.appendChild(list);
        node.appendChild(choose);

        const controls = plot ? this._compactAnalysisControls(mode, panelId, plot) : null;
        if (controls) {
            const actions = el('div', 'compact-action-row');
            for (const action of controls.actions) {
                actions.appendChild(button('compact-secondary-btn', action.label, action.run, { title: action.title }));
            }
            choose.appendChild(actions);

            const optionsEl = controls.options();
            if (optionsEl) {
                const optionsSection = section(i18n.t(controls.titleKey));
                optionsSection.classList.add('compact-fft-options');
                const wasHidden = optionsEl.hidden;
                optionsEl.hidden = false;
                const restore = this._lendToCompact(optionsEl, optionsSection);
                restoreOptions = () => {
                    // Rebuilt or torn down meanwhile: the chart owns it again.
                    if (controls.options() !== optionsEl) {
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

    // A row of a phone menu: icon, label, and the line a desktop tooltip
    // would have said, since there is no hover to show it.
    const menuRow = (icon, label, subtitle, onClick) => {
        const row = el('button', 'compact-menu-btn');
        row.type = 'button';
        const iconSpan = el('span', 'compact-btn-icon compact-menu-icon');
        iconSpan.innerHTML = icon;
        const text = el('span', 'compact-menu-text');
        text.appendChild(el('span', 'compact-menu-label', label));
        if (subtitle) text.appendChild(el('span', 'compact-menu-subtitle', subtitle));
        row.append(iconSpan, text);
        row.addEventListener('click', (event) => {
            event.stopPropagation();
            onClick(event);
        });
        return row;
    };

    proto._buildCompactExampleList = function() {
        const list = el('div', 'compact-list compact-menu-list');
        const menu = document.getElementById('example-menu');
        if (!menu) return list;
        this._renderExampleMenu?.();
        for (const source of menu.querySelectorAll('.example-menu-item-row')) {
            const load = source.querySelector('.example-load-btn');
            if (!load) continue;
            const name = load.querySelector('.example-name')?.textContent || load.textContent;
            const item = el('div', 'compact-menu-item');
            const head = el('div', 'compact-menu-row');
            const main = menuRow(SVG.play, name, '', () => {
                // Loading replaces the plot under the sheet: show it.
                this._closeCompactSheet();
                load.click();
            });
            main.disabled = load.disabled;
            if (load.disabled) {
                main.querySelector('.compact-menu-text')
                    .appendChild(el('span', 'compact-menu-subtitle', i18n.t('exampleComingSoon')));
            }
            head.appendChild(main);
            const actions = [...source.querySelectorAll('.example-action-btn')];
            if (actions.length) {
                // Download the model, copy it: a level below loading it.
                const extra = el('div', 'compact-menu-subactions');
                extra.hidden = true;
                for (const action of actions) {
                    const icon = action.classList.contains('example-action-download') ? SVG.download : SVG.copy;
                    extra.appendChild(menuRow(icon, action.title || action.textContent, '', () => action.click()));
                }
                const more = button('compact-icon-btn compact-menu-more', '', () => {
                    extra.hidden = !extra.hidden;
                    more.setAttribute('aria-expanded', String(!extra.hidden));
                }, { icon: SVG.more, title: i18n.t('compactMoreActions') });
                more.setAttribute('aria-expanded', 'false');
                head.appendChild(more);
                item.append(head, extra);
            } else {
                item.appendChild(head);
            }
            list.appendChild(item);
        }
        return list;
    };

    proto._buildCompactMenuGroups = function() {
        const menu = document.getElementById('extra-menu');
        if (!menu) return [];
        this._renderExtraMenu?.();
        const sources = new Map();
        for (const item of menu.querySelectorAll('.extra-menu-item[data-action]')) {
            if (!MENU_HIDDEN.has(item.dataset.action)) sources.set(item.dataset.action, item);
        }
        const row = (source, icon) => menuRow(
            icon,
            source.querySelector('.example-name')?.textContent || source.textContent,
            source.title || '',
            () => source.click(),
        );
        const sections = [];
        const known = new Set(MENU_GROUPS.flatMap(group => group.items.map(entry => entry.action)));
        MENU_GROUPS.forEach((group, index) => {
            const list = el('div', 'compact-list compact-menu-list');
            for (const entry of group.items) {
                const source = sources.get(entry.action);
                if (source) list.appendChild(row(source, SVG[entry.icon]));
            }
            // Anything new lands in Tools, with the desktop menu's own icon.
            if (index === 1) {
                for (const [action, source] of sources) {
                    if (known.has(action)) continue;
                    const glyph = el('span', 'compact-menu-emoji', source.querySelector('.extra-menu-icon')?.textContent || '•');
                    list.appendChild(row(source, glyph.outerHTML));
                }
            }
            if (!list.children.length) return;
            const wrap = section(i18n.t(group.titleKey));
            wrap.appendChild(list);
            sections.push(wrap);
        });
        return sections;
    };

    proto._compactVersionText = function() {
        const row = document.querySelector('#extra-menu .extra-version-row');
        if (!row) return '';
        const version = [row.querySelector('.example-name')?.textContent, row.querySelector('.extra-version-badge')?.textContent]
            .filter(Boolean).join(' ');
        return [version, row.querySelector('.extra-version-build')?.textContent].filter(Boolean).join(' · ');
    };

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

        // The examples and the main menu, as phone lists. Each row presses the
        // desktop menu's own item (rendered, not shown), so every action
        // keeps one code path — and runs inside the tap, which a file picker
        // or the clipboard needs.
        const examples = section(i18n.t('compactExamples'));
        examples.dataset.compactFocus = 'examples';
        examples.appendChild(this._buildCompactExampleList());
        node.appendChild(examples);

        for (const group of this._buildCompactMenuGroups()) node.appendChild(group);

        const version = this._compactVersionText();
        if (version) node.appendChild(el('p', 'compact-note compact-note-muted compact-version', version));

        return {
            title: i18n.t('compactNavMore'),
            node,
            onClose: () => restores.forEach(restore => restore()),
        };
    };
}
