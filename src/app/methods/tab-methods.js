import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';
import { createTopBarScrollIndicator, placeTopBarMenu } from '../../ui/top-bar-scroll.js';

/**
 * Tabs: several screens of panels over the same open files, in the web build
 * and in Full Desktop alike (not in the phone layout, which has no top bar).
 *
 * A tab left is parked as it is: its panels, their charts and their state
 * move off screen, untouched, and come back the same — nothing is drawn or
 * computed again (a Fourier spectrum, a correlation, a fit). That holds while
 * nothing they draw changed meanwhile: the files, their data (Live Update, a
 * reload, a data tool) and the settings that decide how a plot looks. When
 * something did, or when more tabs are parked than MAX_PARKED_TABS, a tab is
 * kept the way a saved view keeps it — the layout tree and each panel's plot
 * session — and comes back through the code that restores a view
 * (_applySessionLayout / _applySessionPlots), drawn again from what is there
 * now. So a tab survives what a view survives: a file closed meanwhile only
 * takes its traces with it, a reload that renamed a signal only drops that
 * trace.
 *
 * In a saved view (session-methods.js) `tabs` lists every tab. The one on
 * screen is the view's own `layout` and `plots`, so a view written before
 * tabs existed opens as one tab, and one written with tabs still opens, as
 * that one tab, in a version that has none.
 */
// Parked tabs keep their charts. A chart drawn with WebGL (a long series, a
// 3D scene) holds a WebGL context, of which a browser gives a page about 16
// and silently drops the oldest past that, blanking its chart. So the canvases
// of every chart, on screen and parked, are held under a budget: past it, the
// parked tab seen longest ago that has any gives its charts up and is kept as
// a saved view. Charts drawn in SVG cost no context; their tabs are only held
// to a count.
const MAX_PARKED_TABS = 12;
const MAX_WEBGL_CANVASES = 12;

function webglCanvasCount(root) {
    return root ? root.querySelectorAll('canvas.gl-canvas, .gl-container canvas').length : 0;
}

export function installTabMethods(TargetClass) {
    const proto = TargetClass.prototype;

// Kept as the one place that decides it: tabs were Full Desktop only at first.
proto._tabsEnabled = function() {
    return true;
};

// The browser keeps Ctrl+T, Ctrl+W, Ctrl+Tab and Ctrl+1…9 for its own tabs
// and a page cannot take them, so those are Full Desktop's only. Alt+1…9 is
// left free by the browsers on Windows, and works in both.
proto._tabCtrlShortcuts = function() {
    return !!this.capabilities?.isDesktop;
};

proto._ensureTabsState = function() {
    if (!this.tabs) {
        this.tabs = { items: [this._newTabItem()], activeIndex: 0 };
    }
    return this.tabs;
};

proto._newTabItem = function(name = '') {
    this._nextTabNumber = (this._nextTabNumber || 0) + 1;
    return { id: `tab_${this._nextTabNumber}`, number: this._nextTabNumber, name, snapshot: null };
};

proto._tabDisplayName = function(item) {
    return item?.name || i18n.t('tabDefaultName').replace('{n}', String(item?.number || 1));
};

proto.initTabs = function() {
    this._ensureTabsState();
    if (typeof document === 'undefined') return;
    document.addEventListener('keydown', event => this._handleTabShortcut(event));
    // Plot options applied to every plot reach the tabs off screen too.
    this.plotManager.onApplyToAllPlots = patch => this._applyPlotPatchToHiddenTabs(patch);
    this.plotManager.applyToAllReachesOtherTabs = () => this._tabsEnabled() && this._ensureTabsState().items.length > 1;
    this._renderTabs();
};

// ── Switching ──

proto._captureActiveTabSnapshot = function() {
    // A data tool's draft preview is a drawing, not a trace: never kept.
    this._clearDataToolPreview?.();
    return {
        layout: this._cloneSerializable(this.layoutManager.root),
        plots: this._capturePlotSessions(),
    };
};

// ── Parking ──

// The settings that change how a panel is drawn without changing its data.
proto._tabSettingsStamp = function() {
    const pm = this.plotManager;
    return JSON.stringify([
        this.theme, i18n.currentLang, this.files.size,
        pm.legendPosition, pm.legendOverlayCorner, pm.legendUnits, pm.hoverInfoCorner, pm.hoverProximity,
        pm.timeseriesVisualMaxPoints, pm.phaseVisualMaxPoints, pm.syncAxes,
        this.advancedSettings || {},
    ]);
};

// The files a set of panels draws from, and what each held when they were drawn.
proto._tabFileStamps = function(plots) {
    const ids = new Set();
    for (const plot of plots.values()) {
        for (const trace of plot.traces || []) ids.add(trace.fileId);
        for (const trace of plot.phaseTraces || []) ids.add(trace.fileId);
        if (plot.phasePending?.fileId) ids.add(plot.phasePending.fileId);
        if (plot.stateSlots?.fileId) ids.add(plot.stateSlots.fileId);
    }
    return [...ids].filter(Boolean).map(fileId => {
        const entry = this.plotManager.files.get(fileId);
        return [fileId, entry?.data || null, entry?.dataEpoch || 0];
    });
};

proto._parkedTabIsCurrent = function(parked) {
    if (!parked || parked.settings !== this._tabSettingsStamp()) return false;
    return parked.files.every(([fileId, data, epoch]) => {
        const entry = this.plotManager.files.get(fileId);
        return !!entry && this.files.has(fileId) && entry.data === data && (entry.dataEpoch || 0) === epoch;
    });
};

/**
 * The tab on screen leaves as it is. Its elements move to a holder of the same
 * size off screen — not hidden: a chart that is not displayed is refused by
 * Plotly, and a size that drops to nothing would have every chart redraw
 * itself for it — and its panel states leave the plot manager, so nothing
 * that walks the panels on screen (Live Update, a setting, Clear all) reaches
 * them.
 */
proto._parkActiveTab = function(item) {
    const container = this.layoutManager.container;
    const holder = document.createElement('div');
    holder.className = `${container.className} workspace-tab-parked`;
    holder.setAttribute('aria-hidden', 'true');
    holder.inert = true;
    holder.style.width = `${container.clientWidth}px`;
    holder.style.height = `${container.clientHeight}px`;
    holder.append(...container.childNodes);
    (container.parentNode || document.body).appendChild(holder);
    const plots = new Map();
    for (const panelId of this.layoutManager._collectPanelIds(this.layoutManager.root)) {
        const plot = this.plotManager.plots.get(panelId);
        if (!plot) continue;
        plots.set(panelId, plot);
        this.plotManager.plots.delete(panelId);
    }
    item.snapshot = null;
    item.parked = {
        root: this.layoutManager.root,
        plots,
        holder,
        scrollTop: container.scrollTop,
        files: this._tabFileStamps(plots),
        settings: this._tabSettingsStamp(),
    };
    item.lastShown = (this._tabClock = (this._tabClock || 0) + 1);
    this._limitParkedTabs();
};

proto._unparkTab = function(item) {
    const parked = item.parked;
    item.parked = null;
    const container = this.layoutManager.container;
    container.replaceChildren(...parked.holder.childNodes);
    parked.holder.remove();
    this.layoutManager.root = parked.root;
    for (const [panelId, plot] of parked.plots) this.plotManager.plots.set(panelId, plot);
    container.scrollTop = parked.scrollTop || 0;
    // The window may have changed size meanwhile.
    requestAnimationFrame(() => this.plotManager.resizeAll?.());
};

// A parked tab gives its charts up: kept as a saved view (unless it is being
// closed), its panels torn down the way a closed panel is.
proto._disposeParkedTab = function(item, { keepSnapshot = true } = {}) {
    const parked = item?.parked;
    if (!parked) return;
    if (keepSnapshot) {
        item.snapshot = {
            layout: this._cloneSerializable(parked.root),
            plots: this._capturePlotSessions(parked.plots),
        };
    }
    for (const [panelId, plot] of parked.plots) {
        this.plotManager.plots.set(panelId, plot);
        this.plotManager.onPanelUnmount(panelId);
    }
    parked.holder.remove();
    item.parked = null;
};

proto._limitParkedTabs = function() {
    const parked = this._ensureTabsState().items.filter(item => item.parked);
    parked.sort((a, b) => (a.lastShown || 0) - (b.lastShown || 0));
    while (parked.length > MAX_PARKED_TABS) this._disposeParkedTab(parked.shift());
    const onScreen = webglCanvasCount(this.layoutManager.container);
    let total = onScreen + parked.reduce((sum, item) => sum + webglCanvasCount(item.parked.holder), 0);
    for (const item of [...parked]) {
        if (total <= MAX_WEBGL_CANVASES) break;
        const count = webglCanvasCount(item.parked.holder);
        if (!count) continue;
        this._disposeParkedTab(item);
        total -= count;
    }
};

// What a tab off screen would be saved as.
proto._tabSnapshotOf = function(item) {
    if (item?.parked) {
        return {
            layout: this._cloneSerializable(item.parked.root),
            plots: this._capturePlotSessions(item.parked.plots),
        };
    }
    return this._cloneSerializable(item?.snapshot || null);
};

proto._showTab = async function(item) {
    item.lastShown = (this._tabClock = (this._tabClock || 0) + 1);
    if (item.parked && this._parkedTabIsCurrent(item.parked)) {
        this._unparkTab(item);
        return;
    }
    // Drawn again: new charts, maybe new WebGL contexts, so the parked ones
    // are held to the budget once these are up.
    const settle = () => this._limitParkedTabs();
    this._disposeParkedTab(item);
    const snapshot = item.snapshot;
    item.snapshot = null;
    await this._restoreTabSnapshot(snapshot);
    setTimeout(settle, 1000);
};

// The panels on screen, gone for good (their tab is being closed).
proto._discardActiveTabPanels = function() {
    for (const panelId of this.layoutManager._collectPanelIds(this.layoutManager.root)) {
        this.layoutManager.onPanelUnmount?.(panelId);
    }
    this.layoutManager.container.replaceChildren();
};

proto._identityFileMap = function() {
    return new Map([...this.files.keys()].map(fileId => [fileId, fileId]));
};

proto._restoreTabSnapshot = async function(snapshot) {
    if (snapshot?.layout) {
        this._applySessionLayout(snapshot.layout);
        await this._applySessionPlots(snapshot.plots || [], this._identityFileMap());
    } else {
        this.layoutManager.reset();
    }
};

// Switches run one at a time: a held Ctrl+Tab asks for the next one before
// the panels of the last are back. Only the latest request is kept.
proto.switchTab = async function(index) {
    const tabs = this._ensureTabsState();
    if (this._tabSwitching) {
        this._pendingTabIndex = index;
        return this._tabSwitching;
    }
    if (!Number.isInteger(index) || index < 0 || index >= tabs.items.length || index === tabs.activeIndex) return;
    this._tabSwitching = (async () => {
        try {
            this._prepareTabLeave();
            // A data tool's draft preview is a drawing, not a trace: never kept.
            this._clearDataToolPreview?.();
            this._parkActiveTab(tabs.items[tabs.activeIndex]);
            tabs.activeIndex = index;
            this._renderTabs();
            await this._showTab(tabs.items[index]);
            this._afterTabChange();
        } finally {
            this._tabSwitching = null;
        }
    })();
    await this._tabSwitching;
    const pending = this._pendingTabIndex;
    this._pendingTabIndex = null;
    if (Number.isInteger(pending) && pending !== tabs.activeIndex) await this.switchTab(pending);
};

proto._prepareTabLeave = function() {
    this._closeTabMenu?.();
    this.plotManager._closeMarksMenu?.();
    this.plotManager._closeDashboardCardEditor?.();
    // Nothing plays from a panel that is not on screen.
    this.plotManager.stopAudioPlayback?.();
    // The map of a gridded dataset covers the panels: they are what is changing.
    if (typeof this._griddedState === 'function' && this._griddedState().visibleFileId) this._hideGriddedView?.();
};

proto._afterTabChange = function() {
    this._renderTabs();
    this._updateActionButtons?.();
};

proto.addTab = async function() {
    if (this._tabSwitching) await this._tabSwitching;
    // An index asked for before the tabs changed names another tab now.
    this._pendingTabIndex = null;
    const tabs = this._ensureTabsState();
    tabs.items.splice(tabs.activeIndex + 1, 0, this._newTabItem());
    await this.switchTab(tabs.activeIndex + 1);
};

proto.duplicateTab = async function(index) {
    if (this._tabSwitching) await this._tabSwitching;
    this._pendingTabIndex = null;
    const tabs = this._ensureTabsState();
    const source = tabs.items[index];
    if (!source) return;
    const snapshot = index === tabs.activeIndex ? this._captureActiveTabSnapshot() : this._tabSnapshotOf(source);
    const copy = this._newTabItem(source.name ? `${source.name} (2)` : '');
    copy.snapshot = this._withFreshPanelIds(snapshot);
    tabs.items.splice(index + 1, 0, copy);
    await this.switchTab(index + 1);
};

// Panel ids are keys of plotManager.plots: a copy of a tab needs its own, or
// the two would share one panel state the moment both were ever on screen.
proto._withFreshPanelIds = function(snapshot) {
    if (!snapshot?.layout) return snapshot;
    const ids = new Map();
    const fresh = () => this.layoutManager._uid();
    const walk = node => {
        if (!node) return;
        const id = fresh();
        if (node.type === 'panel') ids.set(node.id, id);
        node.id = id;
        (node.children || []).forEach(walk);
    };
    walk(snapshot.layout);
    for (const plot of snapshot.plots || []) {
        if (ids.has(plot.panelId)) plot.panelId = ids.get(plot.panelId);
    }
    return snapshot;
};

proto._tabHasContent = function(index) {
    const tabs = this._ensureTabsState();
    if (index === tabs.activeIndex) return !!this.plotManager.hasAnyTraces?.();
    const item = tabs.items[index];
    const plots = item?.parked ? [...item.parked.plots.values()] : (item?.snapshot?.plots || []);
    return plots.some(plot => plot.traces?.length || plot.phaseTraces?.length);
};

proto.closeTab = async function(index, options = {}) {
    if (this._tabSwitching) await this._tabSwitching;
    const tabs = this._ensureTabsState();
    if (tabs.items.length <= 1 || !tabs.items[index]) return false;
    if (!options.force && this._tabHasContent(index)) {
        const ok = await Modal.confirm(
            i18n.t('tabCloseConfirm').replace('{name}', this._tabDisplayName(tabs.items[index])),
            { icon: '🗂', confirmText: i18n.t('tabClose') },
        );
        if (!ok) return false;
    }
    if (index !== tabs.activeIndex) {
        this._disposeParkedTab(tabs.items[index], { keepSnapshot: false });
        tabs.items.splice(index, 1);
        if (index < tabs.activeIndex) tabs.activeIndex -= 1;
        this._renderTabs();
        return true;
    }
    this._prepareTabLeave();
    this._discardActiveTabPanels();
    tabs.items.splice(index, 1);
    tabs.activeIndex = Math.min(index, tabs.items.length - 1);
    this._renderTabs();
    this._tabSwitching = this._showTab(tabs.items[tabs.activeIndex]);
    try { await this._tabSwitching; } finally { this._tabSwitching = null; }
    this._afterTabChange();
    // A switch asked for while the tab beside it was being put back.
    const pending = this._pendingTabIndex;
    this._pendingTabIndex = null;
    if (Number.isInteger(pending) && pending !== tabs.activeIndex) await this.switchTab(pending);
    return true;
};

// Every tab closed, one empty tab left in their place; the files stay open.
proto.closeAllTabs = async function(options = {}) {
    if (this._tabSwitching) await this._tabSwitching;
    const tabs = this._ensureTabsState();
    if (!options.force) {
        const ok = await Modal.confirm(
            i18n.t('tabCloseAllConfirm').replace('{count}', String(tabs.items.length)),
            { icon: '⚠️', title: i18n.t('tabCloseAll'), confirmText: i18n.t('tabCloseAll') },
        );
        if (!ok) return false;
    }
    this._pendingTabIndex = null;
    this._prepareTabLeave();
    for (const item of tabs.items) this._disposeParkedTab(item, { keepSnapshot: false });
    this._discardActiveTabPanels();
    this._nextTabNumber = 0;
    this.tabs = { items: [this._newTabItem()], activeIndex: 0 };
    this.layoutManager.reset();
    this._afterTabChange();
    return true;
};

proto.renameTab = function(index, name) {
    const item = this._ensureTabsState().items[index];
    if (!item) return;
    item.name = String(name || '').trim().slice(0, 60);
    this._renderTabs();
};

proto.moveTab = function(from, to) {
    const tabs = this._ensureTabsState();
    if (from === to || !tabs.items[from] || to < 0 || to >= tabs.items.length) return;
    const activeId = tabs.items[tabs.activeIndex].id;
    const [item] = tabs.items.splice(from, 1);
    tabs.items.splice(to, 0, item);
    tabs.activeIndex = tabs.items.findIndex(tab => tab.id === activeId);
    this._renderTabs();
};

// ── Tab strip ──

proto._renderTabs = function() {
    if (typeof document === 'undefined') return;
    const strip = document.getElementById('workspace-tabs');
    if (!strip) return;
    const enabled = this._tabsEnabled();
    // The top bar watches the strip's size to decide how much of the title
    // still fits (top-bar-scroll.js).
    strip.hidden = !enabled;
    if (!enabled) return;
    const tabs = this._ensureTabsState();
    // One row whatever the number of tabs: the tabs scroll sideways inside
    // it, while + and the list of every tab (shown once they no longer fit)
    // stay in reach at its end.
    const scroller = document.createElement('div');
    scroller.className = 'workspace-tabs-scroll';
    strip.replaceChildren(scroller);
    tabs.items.forEach((item, index) => {
        const active = index === tabs.activeIndex;
        const tab = document.createElement('div');
        tab.className = `workspace-tab${active ? ' active' : ''}`;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
        tab.dataset.index = String(index);
        tab.draggable = true;
        const shortcut = index < 8 ? `Alt+${index + 1}` : '';
        const keys = this._tabCtrlShortcuts() ? ` ${i18n.t('tabHintDesktopKeys')}` : '';
        tab.title = `${this._tabDisplayName(item)}${shortcut ? ` (${shortcut})` : ''}\n${i18n.t('tabHint')}${keys}`;

        const label = document.createElement('span');
        label.className = 'workspace-tab-label';
        label.textContent = this._tabDisplayName(item);
        tab.appendChild(label);

        if (tabs.items.length > 1) {
            const close = document.createElement('button');
            close.type = 'button';
            close.className = 'workspace-tab-close';
            close.textContent = '×';
            close.title = i18n.t('tabClose');
            close.setAttribute('aria-label', i18n.t('tabClose'));
            close.addEventListener('click', event => {
                event.stopPropagation();
                this.closeTab(index);
            });
            tab.appendChild(close);
        }

        tab.addEventListener('click', () => this.switchTab(index));
        tab.addEventListener('dblclick', event => {
            event.preventDefault();
            this._startTabRename(index);
        });
        tab.addEventListener('auxclick', event => {
            if (event.button === 1) { event.preventDefault(); this.closeTab(index); }
        });
        tab.addEventListener('contextmenu', event => {
            event.preventDefault();
            this._openTabMenu(index, tab);
        });
        tab.addEventListener('keydown', event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.switchTab(index); }
        });
        tab.addEventListener('dragstart', event => {
            event.dataTransfer?.setData('application/x-omv-tab', String(index));
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
        tab.addEventListener('dragover', event => {
            if (!event.dataTransfer?.types?.includes('application/x-omv-tab')) return;
            event.preventDefault();
            tab.classList.add('drag-over');
        });
        tab.addEventListener('dragleave', () => tab.classList.remove('drag-over'));
        tab.addEventListener('drop', event => {
            tab.classList.remove('drag-over');
            // Only a tab being moved: a file dragged in from the desktop and let
            // go over a tab is the document's to open (ui-methods.js).
            if (!event.dataTransfer?.types?.includes('application/x-omv-tab')) return;
            const raw = event.dataTransfer.getData('application/x-omv-tab');
            const from = raw === '' ? NaN : Number(raw);
            if (!Number.isInteger(from)) return;
            event.preventDefault();
            event.stopPropagation();
            this.moveTab(from, index);
        });
        scroller.appendChild(tab);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'workspace-tab-add';
    add.textContent = '+';
    add.title = this._tabCtrlShortcuts() ? `${i18n.t('tabNew')} (Ctrl+T)` : i18n.t('tabNew');
    add.setAttribute('aria-label', i18n.t('tabNew'));
    add.addEventListener('click', () => this.addTab());

    const list = document.createElement('button');
    list.type = 'button';
    list.className = 'workspace-tabs-overflow';
    list.textContent = '▾';
    list.title = i18n.t('tabList');
    list.setAttribute('aria-label', i18n.t('tabList'));
    list.setAttribute('aria-haspopup', 'menu');
    list.addEventListener('click', event => {
        event.stopPropagation();
        if (this._closeTabMenu) this._closeTabMenu();
        else this._openTabListMenu(list);
    });
    strip.append(add, list);

    // A vertical wheel moves the row sideways: a mouse has no other way to.
    scroller.addEventListener('wheel', event => {
        if (event.ctrlKey || scroller.scrollWidth <= scroller.clientWidth) return;
        if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
        const lineScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientWidth : 1;
        scroller.scrollLeft += event.deltaY * lineScale;
        event.preventDefault();
    }, { passive: false });
    scroller.addEventListener('scroll', () => this._syncTabOverflow(), { passive: true });
    if (!this._tabStripObserver && typeof ResizeObserver === 'function') {
        this._tabStripObserver = new ResizeObserver(() => this._syncTabOverflow());
        this._tabStripObserver.observe(strip);
        // The strip can move without changing size (the title giving way).
        window.addEventListener('resize', () => this._syncTabOverflow());
    }
    scroller.querySelector('.workspace-tab.active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    this._syncTabOverflow();
    // How much of the title still fits depends on how many tabs there are.
    strip.dispatchEvent(new Event('top-bar-content-change', { bubbles: true }));
};

// Whether the tabs fit: the list button shows only when they do not, and a
// fade on either end says there are more tabs that way.
proto._syncTabOverflow = function() {
    const strip = document.getElementById('workspace-tabs');
    const scroller = strip?.querySelector('.workspace-tabs-scroll');
    if (!scroller) return;
    // The slim bar under the tabs, the one the row of buttons has too.
    if (!this._updateTabScrollbar) {
        const topBar = strip.closest('.top-bar');
        this._updateTabScrollbar = topBar
            ? createTopBarScrollIndicator(topBar, () => {
                const current = document.getElementById('workspace-tabs');
                return current && !current.hidden ? current.querySelector('.workspace-tabs-scroll') : null;
            }, 'workspace-tabs-scrollbar')
            : () => {};
    }
    this._updateTabScrollbar();
    const max = scroller.scrollWidth - scroller.clientWidth;
    const overflowing = max > 1;
    strip.classList.toggle('is-overflowing', overflowing);
    scroller.classList.toggle('more-before', overflowing && scroller.scrollLeft > 1);
    scroller.classList.toggle('more-after', overflowing && scroller.scrollLeft < max - 1);
};

proto._startTabRename = function(index) {
    const strip = document.getElementById('workspace-tabs');
    const tab = strip?.querySelector(`.workspace-tab[data-index="${index}"]`);
    const label = tab?.querySelector('.workspace-tab-label');
    const item = this._ensureTabsState().items[index];
    if (!tab || !label || !item) return;
    tab.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'workspace-tab-input';
    input.value = this._tabDisplayName(item);
    input.maxLength = 60;
    input.setAttribute('aria-label', i18n.t('tabRename'));
    tab.draggable = false;
    label.replaceWith(input);
    let done = false;
    const finish = commit => {
        if (done) return;
        done = true;
        if (commit) this.renameTab(index, input.value === this._tabDisplayName({ number: item.number }) ? '' : input.value);
        else this._renderTabs();
    };
    input.addEventListener('keydown', event => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); finish(true); }
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', event => event.stopPropagation());
    input.addEventListener('dblclick', event => event.stopPropagation());
    input.focus();
    input.select();
};

proto._openTabMenu = function(index, anchor) {
    const tabs = this._ensureTabsState();
    this._showTabStripMenu(anchor, [
        { text: i18n.t('tabRename'), run: () => this._startTabRename(index) },
        { text: i18n.t('tabDuplicate'), run: () => this.duplicateTab(index) },
        { text: i18n.t('tabClose'), disabled: tabs.items.length <= 1, run: () => this.closeTab(index) },
        { text: i18n.t('tabCloseAll'), separatorBefore: true, run: () => this.closeAllTabs() },
    ]);
};

// Every tab by name, for when the row no longer shows them all.
proto._openTabListMenu = function(anchor) {
    const tabs = this._ensureTabsState();
    this._showTabStripMenu(anchor, tabs.items.map((item, index) => ({
        text: this._tabDisplayName(item),
        shortcut: index < 8 ? `Alt+${index + 1}` : (index === tabs.items.length - 1 ? 'Alt+9' : ''),
        checked: index === tabs.activeIndex,
        run: () => this.switchTab(index),
    })), 'workspace-tab-list-menu');
};

proto._showTabStripMenu = function(anchor, entries, extraClass = '') {
    this._closeTabMenu?.();
    const menu = document.createElement('div');
    menu.className = `example-menu workspace-tab-menu ${extraClass}`.trim();
    menu.setAttribute('role', 'menu');
    for (const entry of entries) {
        if (entry.separatorBefore) {
            const rule = document.createElement('div');
            rule.className = 'workspace-tab-menu-rule';
            rule.setAttribute('role', 'separator');
            menu.appendChild(rule);
        }
        const item = document.createElement('button');
        item.type = 'button';
        item.className = `example-menu-item${entry.checked ? ' active' : ''}`;
        item.setAttribute('role', entry.checked === undefined ? 'menuitem' : 'menuitemradio');
        if (entry.checked !== undefined) item.setAttribute('aria-checked', String(!!entry.checked));
        const text = document.createElement('span');
        text.className = 'workspace-tab-menu-text';
        text.textContent = entry.text;
        item.appendChild(text);
        if (entry.shortcut) {
            const kbd = document.createElement('kbd');
            kbd.className = 'workspace-tab-menu-key';
            kbd.textContent = entry.shortcut;
            item.appendChild(kbd);
        }
        item.disabled = !!entry.disabled;
        item.addEventListener('click', event => {
            event.stopPropagation();
            this._closeTabMenu();
            entry.run();
        });
        menu.appendChild(item);
    }
    document.body.appendChild(menu);
    placeTopBarMenu(menu, anchor);
    anchor.setAttribute('aria-expanded', 'true');
    menu.querySelector('.example-menu-item.active, .example-menu-item:not(:disabled)')?.focus?.();
    const onPointer = event => { if (!menu.contains(event.target) && !anchor.contains(event.target)) this._closeTabMenu(); };
    const onKey = event => { if (event.key === 'Escape') this._closeTabMenu(); };
    setTimeout(() => {
        if (!menu.isConnected) return;
        document.addEventListener('pointerdown', onPointer, true);
        document.addEventListener('keydown', onKey, true);
    }, 0);
    this._closeTabMenu = () => {
        document.removeEventListener('pointerdown', onPointer, true);
        document.removeEventListener('keydown', onKey, true);
        anchor.setAttribute('aria-expanded', 'false');
        menu.remove();
        this._closeTabMenu = null;
    };
};

// ── Keyboard ──
//
// Everywhere: Alt+1…8 that tab, Alt+9 the last one, F2 rename. Full Desktop
// adds Ctrl+T new tab, Ctrl+W close it, Ctrl+Tab / Ctrl+Shift+Tab and
// Ctrl+PageDown / Ctrl+PageUp next and previous, Ctrl+1…8 and Ctrl+9: it has
// no application menu, so none of these is taken there.
proto._handleTabShortcut = function(event) {
    if (!this._tabsEnabled() || event.defaultPrevented) return;
    if (document.documentElement.classList.contains('compact')) return;
    // A dialog owns the keyboard while it is open.
    if (document.querySelector('.modal-overlay.show')) return;
    const target = event.target;
    const typing = !!target?.closest?.('input, textarea, select, [contenteditable="true"]');
    const tabs = this._ensureTabsState();
    const count = tabs.items.length;
    const ctrl = this._tabCtrlShortcuts();
    const mod = ctrl && !event.altKey && (event.ctrlKey || event.metaKey);
    // The physical key, not the character: Option+1 on a Mac types "¡".
    const digit = /^Digit[1-9]$/.test(event.code || '') ? Number(event.code.slice(5)) : null;
    const goTo = n => this.switchTab(n === 9 ? count - 1 : Math.min(n - 1, count - 1));
    let handled = true;
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && digit && !typing) {
        goTo(digit);
    } else if (event.altKey) {
        handled = false;
    } else if (ctrl && event.ctrlKey && event.key === 'Tab') {
        this.switchTab((tabs.activeIndex + (event.shiftKey ? count - 1 : 1)) % count);
    } else if (ctrl && event.ctrlKey && !event.shiftKey && event.key === 'PageDown') {
        this.switchTab((tabs.activeIndex + 1) % count);
    } else if (ctrl && event.ctrlKey && !event.shiftKey && event.key === 'PageUp') {
        this.switchTab((tabs.activeIndex + count - 1) % count);
    } else if (typing) {
        handled = false;
    } else if (mod && !event.shiftKey && digit) {
        goTo(digit);
    } else if (mod && !event.shiftKey && event.key.toLowerCase() === 't') {
        this.addTab();
    } else if (mod && !event.shiftKey && event.key.toLowerCase() === 'w') {
        this.closeTab(tabs.activeIndex);
    } else if (!event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'F2') {
        this._startTabRename(tabs.activeIndex);
    } else {
        handled = false;
    }
    if (handled) {
        event.preventDefault();
        event.stopPropagation();
    }
};

// ── Saved views ──

proto._captureTabsForSession = function() {
    if (!this._tabsEnabled()) return null;
    const tabs = this._ensureTabsState();
    return {
        activeIndex: tabs.activeIndex,
        items: tabs.items.map((item, index) => (index === tabs.activeIndex
            // The tab on screen is the view's own layout and plots.
            ? { name: item.name || '', active: true }
            : (() => {
                const snapshot = this._tabSnapshotOf(item);
                return { name: item.name || '', layout: snapshot?.layout || null, plots: snapshot?.plots || [] };
            })())),
    };
};

// The tabs off screen of a session, for its required signals.
proto._sessionHiddenTabPlots = function(session) {
    if (!this._tabsEnabled()) return [];
    return (session?.tabs?.items || [])
        .filter(item => !item?.active)
        .flatMap(item => item?.plots || []);
};

// Called while a view is applied, once its file ids can be mapped (after the
// derived datasets are back) and before its own layout goes up.
proto._applySessionTabs = function(session, fileMap) {
    // The view replaces every tab: the parked ones give their charts up.
    for (const item of this.tabs?.items || []) this._disposeParkedTab(item, { keepSnapshot: false });
    this._nextTabNumber = 0;
    const saved = this._tabsEnabled() ? session?.tabs?.items : null;
    if (!Array.isArray(saved) || !saved.length) {
        this.tabs = { items: [this._newTabItem()], activeIndex: 0 };
        this._renderTabs();
        return;
    }
    const items = saved.map(entry => {
        const item = this._newTabItem(String(entry?.name || ''));
        if (!entry?.active && entry?.layout) {
            item.snapshot = {
                layout: this._cloneSerializable(entry.layout),
                plots: this._mapSessionPlotFileIds(entry.plots || [], fileMap),
            };
        }
        return item;
    });
    let activeIndex = saved.findIndex(entry => entry?.active);
    if (activeIndex < 0) activeIndex = Math.min(Math.max(0, Number(session.tabs.activeIndex) || 0), items.length - 1);
    this.tabs = { items, activeIndex };
    this._renderTabs();
};

// The file ids a saved plot session refers to, translated to the open files.
// A trace whose file is not mapped is left out, as a view leaves it out.
proto._mapSessionPlotFileIds = function(plots, fileMap) {
    const map = id => (id != null ? fileMap.get(id) || null : null);
    return (this._cloneSerializable(plots) || []).map(plot => {
        plot.traces = (plot.traces || []).map(trace => ({ ...trace, fileId: map(trace.fileId) })).filter(trace => trace.fileId);
        plot.phaseTraces = (plot.phaseTraces || []).map(trace => ({ ...trace, fileId: map(trace.fileId) })).filter(trace => trace.fileId);
        if (plot.phasePending) plot.phasePending.fileId = map(plot.phasePending.fileId);
        if (plot.stateSlots) plot.stateSlots.fileId = map(plot.stateSlots.fileId);
        return plot;
    });
};

// What "apply to every plot" changed on screen (plots/methods/marks-methods.js),
// or the Live View policy of the top bar, written into the tabs that are not.
proto._applyPlotPatchToHiddenTabs = function(patch) {
    const tabs = this._ensureTabsState();
    tabs.items.forEach((item, index) => {
        if (index === tabs.activeIndex) return;
        if (item.parked) {
            // How the next append is followed changes nothing drawn: the
            // parked panels take it as they are.
            if (patch.liveView) {
                for (const plot of item.parked.plots.values()) {
                    const timeseries = plot.mode === 'timeseries';
                    if (plot.mode !== 'state-anim' && timeseries === (patch.liveView.family === 'timeseries')) {
                        plot.liveView = { ...(plot.liveView || {}), ...patch.liveView.patch };
                    }
                }
                return;
            }
            // A mark or a line shape is drawn: the tab is drawn again when shown.
            this._disposeParkedTab(item);
        }
        for (const plot of item.snapshot?.plots || []) {
            if (patch.liveView) {
                const timeseries = plot.mode === 'timeseries';
                if (plot.mode !== 'state-anim' && timeseries === (patch.liveView.family === 'timeseries')) {
                    plot.liveView = { ...(plot.liveView || {}), ...patch.liveView.patch };
                }
                continue;
            }
            if (plot.mode !== 'timeseries') continue;
            if (patch.lineShape) {
                for (const trace of plot.traces || []) {
                    if (patch.lineShape === 'auto') delete trace.lineShape;
                    else trace.lineShape = patch.lineShape;
                }
            }
            // As on screen: no samples on a stacked plot.
            if (patch.key === 'showSamples' && plot.timeseriesStacked) continue;
            if (patch.key) plot[patch.key] = !!patch.value;
        }
    });
};

}
