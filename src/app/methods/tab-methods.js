import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';
import { placeTopBarMenu } from '../../ui/top-bar-scroll.js';

/**
 * Tabs: several screens of panels over the same open files, in the web build
 * and in Full Desktop alike (not in the phone layout, which has no top bar).
 *
 * Only the tab on screen has panels. The others are kept the way a saved view
 * keeps them — the layout tree and each panel's plot session — and a switch
 * puts one back through the same code that restores a view
 * (_applySessionLayout / _applySessionPlots). So a tab survives what a view
 * survives: a file closed meanwhile only takes its traces with it, a reload
 * that renamed a signal only drops that trace.
 *
 * In a saved view (session-methods.js) `tabs` lists every tab. The one on
 * screen is the view's own `layout` and `plots`, so a view written before
 * tabs existed opens as one tab, and one written with tabs still opens, as
 * that one tab, in a version that has none.
 */
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
            tabs.items[tabs.activeIndex].snapshot = this._captureActiveTabSnapshot();
            tabs.activeIndex = index;
            const target = tabs.items[index];
            const snapshot = target.snapshot;
            target.snapshot = null;
            this._renderTabs();
            await this._restoreTabSnapshot(snapshot);
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
    // The map of a gridded dataset covers the panels: they are what is changing.
    if (typeof this._griddedState === 'function' && this._griddedState().visibleFileId) this._hideGriddedView?.();
};

proto._afterTabChange = function() {
    this._renderTabs();
    this._updateActionButtons?.();
};

proto.addTab = async function() {
    if (this._tabSwitching) await this._tabSwitching;
    const tabs = this._ensureTabsState();
    tabs.items.splice(tabs.activeIndex + 1, 0, this._newTabItem());
    await this.switchTab(tabs.activeIndex + 1);
};

proto.duplicateTab = async function(index) {
    if (this._tabSwitching) await this._tabSwitching;
    const tabs = this._ensureTabsState();
    const source = tabs.items[index];
    if (!source) return;
    const snapshot = index === tabs.activeIndex ? this._captureActiveTabSnapshot() : this._cloneSerializable(source.snapshot);
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
    return (tabs.items[index]?.snapshot?.plots || [])
        .some(plot => plot.traces?.length || plot.phaseTraces?.length);
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
        tabs.items.splice(index, 1);
        if (index < tabs.activeIndex) tabs.activeIndex -= 1;
        this._renderTabs();
        return true;
    }
    this._prepareTabLeave();
    tabs.items.splice(index, 1);
    tabs.activeIndex = Math.min(index, tabs.items.length - 1);
    const target = tabs.items[tabs.activeIndex];
    const snapshot = target.snapshot;
    target.snapshot = null;
    this._renderTabs();
    this._tabSwitching = this._restoreTabSnapshot(snapshot);
    try { await this._tabSwitching; } finally { this._tabSwitching = null; }
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
    strip.replaceChildren();
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
            const from = Number(event.dataTransfer?.getData('application/x-omv-tab'));
            tab.classList.remove('drag-over');
            if (!Number.isInteger(from)) return;
            event.preventDefault();
            event.stopPropagation();
            this.moveTab(from, index);
        });
        strip.appendChild(tab);
    });

    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'workspace-tab-add';
    add.textContent = '+';
    add.title = this._tabCtrlShortcuts() ? `${i18n.t('tabNew')} (Ctrl+T)` : i18n.t('tabNew');
    add.setAttribute('aria-label', i18n.t('tabNew'));
    add.addEventListener('click', () => this.addTab());
    strip.appendChild(add);

    strip.querySelector('.workspace-tab.active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
};

proto._startTabRename = function(index) {
    const strip = document.getElementById('workspace-tabs');
    const tab = strip?.querySelector(`.workspace-tab[data-index="${index}"]`);
    const label = tab?.querySelector('.workspace-tab-label');
    const item = this._ensureTabsState().items[index];
    if (!tab || !label || !item) return;
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
    this._closeTabMenu?.();
    const tabs = this._ensureTabsState();
    const menu = document.createElement('div');
    menu.className = 'example-menu workspace-tab-menu';
    menu.setAttribute('role', 'menu');
    const add = (labelKey, disabled, run) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'example-menu-item';
        item.setAttribute('role', 'menuitem');
        item.textContent = i18n.t(labelKey);
        item.disabled = !!disabled;
        item.addEventListener('click', event => {
            event.stopPropagation();
            this._closeTabMenu();
            run();
        });
        menu.appendChild(item);
    };
    add('tabRename', false, () => this._startTabRename(index));
    add('tabDuplicate', false, () => this.duplicateTab(index));
    add('tabClose', tabs.items.length <= 1, () => this.closeTab(index));
    document.body.appendChild(menu);
    placeTopBarMenu(menu, anchor);
    const onPointer = event => { if (!menu.contains(event.target)) this._closeTabMenu(); };
    const onKey = event => { if (event.key === 'Escape') this._closeTabMenu(); };
    setTimeout(() => {
        if (!menu.isConnected) return;
        document.addEventListener('pointerdown', onPointer, true);
        document.addEventListener('keydown', onKey, true);
    }, 0);
    this._closeTabMenu = () => {
        document.removeEventListener('pointerdown', onPointer, true);
        document.removeEventListener('keydown', onKey, true);
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
            : {
                name: item.name || '',
                layout: this._cloneSerializable(item.snapshot?.layout || null),
                plots: this._cloneSerializable(item.snapshot?.plots || []),
            })),
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
            if (patch.key) plot[patch.key] = !!patch.value;
        }
    });
};

}
