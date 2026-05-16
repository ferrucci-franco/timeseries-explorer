import i18n from '../i18n/index.js';

/**
 * LayoutManager — recursive binary split layout engine
 *
 * Layout tree nodes:
 *   { type: 'panel', id: string, plotConfig: null }
 *   { type: 'split', id: string, direction: 'h'|'v', ratio: number, children: [node, node] }
 *
 * direction 'h' → horizontal divider → top/bottom children
 * direction 'v' → vertical divider  → left/right children
 */
export default class LayoutManager {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.root = this._makePanel();
        this._resizing = null;   // active resize state
        this._scrollResizing = null;
        this._scrollResizeRAF = null;
        this.scrollablePlotArea = false;
        this._pendingRevealPanelId = null;

        // Optional hooks set by PlotManager
        this.onPanelMount   = null;  // (panelId, panelEl) => void
        this.onPanelUnmount = null;  // (panelId) => void

        this._bindGlobalEvents();
    }

    // ─── Public API ────────────────────────────────────────────────

    /** Re-render the whole layout tree into the container. */
    render() {
        const restoreScrollTop = this.scrollablePlotArea ? this.container.scrollTop : null;
        const revealPanelId = this._pendingRevealPanelId;
        this._pendingRevealPanelId = null;
        this.container.innerHTML = '';
        this._renderNode(this.root, this.container);
        this._applyScrollableLayout();
        if (restoreScrollTop != null) {
            this.container.scrollTop = Math.min(restoreScrollTop, this.container.scrollHeight);
            requestAnimationFrame(() => {
                this.container.scrollTop = Math.min(restoreScrollTop, this.container.scrollHeight);
                if (revealPanelId) this._revealPanel(revealPanelId);
            });
        } else if (revealPanelId) {
            requestAnimationFrame(() => this._revealPanel(revealPanelId));
        }
    }

    setScrollablePlotArea(enabled) {
        const wasEnabled = this.scrollablePlotArea;
        this.scrollablePlotArea = !!enabled;
        if (this.scrollablePlotArea && !wasEnabled) {
            this._captureCurrentPanelHeights(this.root);
        }
        this._applyScrollableLayout();
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    }

    wouldDisableScrollableCompressTooMuch() {
        return this.getPanelCount() > 1
            && this.getCompressedPanelHeightEstimate() < LayoutManager.MIN_COMPRESSED_PANEL_HEIGHT;
    }

    getPanelCount() {
        return this._collectPanelIds(this.root).length;
    }

    getCompressedPanelHeightEstimate() {
        const rect = this.container.getBoundingClientRect();
        if (!rect.height) return Infinity;
        return this._estimateSmallestPanelHeight(this.root, rect.height);
    }

    /** Split a panel by id.
     *  direction: 'h' (top/bottom) or 'v' (left/right)
     *  before:    true  → new panel goes left/above the existing one
     *             false → new panel goes right/below (default)
     */
    splitPanel(panelId, direction, before = false) {
        const result = this._findNode(this.root, null, panelId);
        if (!result) return;
        const { node, parent, side } = result;

        const newPanel = this._makePanel();
        const newSplit = {
            type: 'split',
            id: this._uid(),
            direction,
            ratio: 0.5,
            children: before ? [newPanel, node] : [node, newPanel],
        };

        this._replaceNode(parent, side, newSplit);
        if (this.scrollablePlotArea && direction === 'h' && !before) {
            this._pendingRevealPanelId = newPanel.id;
        }
        this.render();
    }

    /** Close (remove) a panel — sibling takes its space. */
    closePanel(panelId) {
        // Cannot close the root panel
        if (this.root.id === panelId) return;
        if (this.onPanelUnmount) this.onPanelUnmount(panelId);

        const result = this._findNode(this.root, null, panelId);
        if (!result) return;
        const { node, parent, side } = result;

        // The sibling is the other child of the parent split
        const siblingIdx = side === 0 ? 1 : 0;
        const sibling = parent.children[siblingIdx];

        // Find the grandparent and replace the parent split with the sibling
        const grandResult = this._findNode(this.root, null, parent.id);
        if (grandResult) {
            this._replaceNode(grandResult.parent, grandResult.side, sibling);
        } else {
            // parent IS root
            this.root = sibling;
        }

        this.render();
    }

    /** Reset to a rows×cols grid of empty panels. */
    resetToGrid(rows, cols) {
        if (this.onPanelUnmount) {
            this._collectPanelIds(this.root).forEach(id => this.onPanelUnmount(id));
        }
        // Build grid: split into rows first (horizontal splits), then each row into cols
        const makeRow = (n) => {
            if (n === 1) return this._makePanel();
            const left  = this._makePanel();
            const right = makeRow(n - 1);
            // Ratio divides space evenly: first panel gets 1/n of remaining
            return { type: 'split', id: this._uid(), direction: 'v', ratio: 1/n, children: [left, right] };
        };
        const makeRowEven = (n) => {
            // Binary split for even division
            if (n === 1) return this._makePanel();
            const panels = Array.from({ length: n }, () => this._makePanel());
            const build = (arr) => {
                if (arr.length === 1) return arr[0];
                const mid = Math.floor(arr.length / 2);
                return { type: 'split', id: this._uid(), direction: 'v', ratio: 0.5,
                         children: [build(arr.slice(0, mid)), build(arr.slice(mid))] };
            };
            return build(panels);
        };

        const rowNodes = Array.from({ length: rows }, () => makeRowEven(cols));
        const buildRows = (arr) => {
            if (arr.length === 1) return arr[0];
            const mid = Math.floor(arr.length / 2);
            return { type: 'split', id: this._uid(), direction: 'h', ratio: 0.5,
                     children: [buildRows(arr.slice(0, mid)), buildRows(arr.slice(mid))] };
        };
        this.root = buildRows(rowNodes);
        this.render();
    }

    /** Reset to a single empty panel. */
    reset() {
        if (this.onPanelUnmount) {
            this._collectPanelIds(this.root).forEach(id => this.onPanelUnmount(id));
        }
        this.root = this._makePanel();
        this.render();
    }

    /** Collect all panel ids in the tree. */
    _collectPanelIds(node) {
        if (node.type === 'panel') return [node.id];
        return [
            ...this._collectPanelIds(node.children[0]),
            ...this._collectPanelIds(node.children[1]),
        ];
    }

    // ─── Rendering ─────────────────────────────────────────────────

    _renderNode(node, container) {
        if (node.type === 'panel') {
            this._renderPanel(node, container);
        } else {
            this._renderSplit(node, container);
        }
    }

    _renderPanel(node, container) {
        const el = document.createElement('div');
        el.className = 'layout-panel';
        el.dataset.id = node.id;

        // Toolbar
        const toolbar = document.createElement('div');
        toolbar.className = 'layout-panel-toolbar';
        this._bindToolbarScroll(toolbar);

        const btnSplitR = this._makeToolbarBtn('▶', i18n.t('splitRight'),  () => this.splitPanel(node.id, 'v', false));
        const btnSplitL = this._makeToolbarBtn('◀', i18n.t('splitLeft'),   () => this.splitPanel(node.id, 'v', true));
        const btnSplitD = this._makeToolbarBtn('▼', i18n.t('splitDown'),   () => this.splitPanel(node.id, 'h', false));
        const btnSplitU = this._makeToolbarBtn('▲', i18n.t('splitUp'),     () => this.splitPanel(node.id, 'h', true));
        const btnClose  = this._makeToolbarBtn('✕', i18n.t('closePanel'),  () => this.closePanel(node.id));
        btnClose.classList.add('close-panel-btn');

        // Hide close button on root panel
        if (this.root.id === node.id) {
            btnClose.style.display = 'none';
        }

        toolbar.appendChild(btnSplitL);
        toolbar.appendChild(btnSplitR);
        toolbar.appendChild(btnSplitD);
        toolbar.appendChild(btnSplitU);
        toolbar.appendChild(btnClose);
        el.appendChild(toolbar);

        // Placeholder content
        const placeholder = document.createElement('div');
        placeholder.className = 'layout-panel-placeholder';
        placeholder.innerHTML = `<span>${i18n.t('dropVariableHere')}</span>`;
        el.appendChild(placeholder);

        container.appendChild(el);

        // Notify PlotManager after the element is in the DOM
        if (this.onPanelMount) this.onPanelMount(node.id, el);
    }

    _renderSplit(node, container) {
        const el = document.createElement('div');
        el.className = `layout-split layout-split-${node.direction}`;
        el.dataset.id = node.id;

        // First child
        const child0 = document.createElement('div');
        child0.className = 'layout-split-child';
        child0.style.flex = String(node.ratio);
        this._renderNode(node.children[0], child0);

        // Resize handle
        const handle = document.createElement('div');
        handle.className = `layout-resize-handle layout-resize-handle-${node.direction}`;
        handle.addEventListener('mousedown', (e) => {
            this._startResize(e, node, el);
        });

        // Second child
        const child1 = document.createElement('div');
        child1.className = 'layout-split-child';
        child1.style.flex = String(1 - node.ratio);
        this._renderNode(node.children[1], child1);

        el.appendChild(child0);
        el.appendChild(handle);
        el.appendChild(child1);
        container.appendChild(el);
    }

    _applyScrollableLayout() {
        if (!this.container) return;
        this.container.classList.toggle('plots-area-scrollable', this.scrollablePlotArea);
        const rootEl = this.container.firstElementChild;
        if (!rootEl) return;

        if (!this.scrollablePlotArea) {
            rootEl.style.height = '';
            rootEl.style.minHeight = '';
            this.container.scrollTop = 0;
            rootEl.querySelector(':scope > .layout-scroll-resize-handle')?.remove();
            this._applyFitLayoutNode(this.root);
            return;
        }

        this._ensureScrollablePanelHeights(this.root);
        const targetHeight = this._scrollableNodeHeight(this.root);
        rootEl.style.height = `${targetHeight}px`;
        rootEl.style.minHeight = `${targetHeight}px`;
        this._applyScrollableNodeLayout(this.root);
        this._ensureScrollResizeHandle(rootEl);
    }

    _minimumScrollableHeight(node) {
        return this._scrollableNodeHeight(node);
    }

    _ensureScrollablePanelHeights(node) {
        if (node.type === 'panel') {
            if (!Number.isFinite(node.scrollHeight) || node.scrollHeight < LayoutManager.MIN_SCROLL_PANEL_HEIGHT) {
                const currentHeight = this._currentPanelSlotHeight(node.id);
                node.scrollHeight = Math.max(LayoutManager.MIN_SCROLL_PANEL_HEIGHT, currentHeight);
            }
            return;
        }
        this._ensureScrollablePanelHeights(node.children[0]);
        this._ensureScrollablePanelHeights(node.children[1]);
    }

    _captureCurrentPanelHeights(node) {
        if (node.type === 'panel') {
            const currentHeight = this._currentPanelSlotHeight(node.id);
            if (currentHeight > 0) {
                node.scrollHeight = Math.max(LayoutManager.MIN_SCROLL_PANEL_HEIGHT, currentHeight);
            }
            return;
        }
        this._captureCurrentPanelHeights(node.children[0]);
        this._captureCurrentPanelHeights(node.children[1]);
    }

    _currentPanelSlotHeight(panelId) {
        const panelEl = this.container.querySelector(`.layout-panel[data-id="${panelId}"]`);
        if (!panelEl) return 0;
        const slotEl = panelEl.parentElement?.classList.contains('layout-split-child')
            ? panelEl.parentElement
            : panelEl;
        return slotEl.getBoundingClientRect().height || 0;
    }

    _scrollableNodeHeight(node) {
        if (node.type === 'panel') return Math.max(LayoutManager.MIN_SCROLL_PANEL_HEIGHT, node.scrollHeight || 0);
        if (node.direction === 'h') {
            return this._scrollableNodeHeight(node.children[0])
                + this._scrollableNodeHeight(node.children[1])
                + LayoutManager.SPLIT_HANDLE_THICKNESS;
        }
        return Math.max(
            this._scrollableNodeHeight(node.children[0]),
            this._scrollableNodeHeight(node.children[1]),
        );
    }

    _applyScrollableNodeLayout(node) {
        if (node.type === 'panel') return;
        const splitEl = this.container.querySelector(`.layout-split[data-id="${node.id}"]`);
        const children = splitEl?.querySelectorAll(':scope > .layout-split-child');
        if (children?.length === 2) {
            if (node.direction === 'h') {
                children[0].style.flex = `0 0 ${this._scrollableNodeHeight(node.children[0])}px`;
                children[1].style.flex = `0 0 ${this._scrollableNodeHeight(node.children[1])}px`;
            } else {
                children[0].style.flex = String(node.ratio);
                children[1].style.flex = String(1 - node.ratio);
            }
        }
        this._applyScrollableNodeLayout(node.children[0]);
        this._applyScrollableNodeLayout(node.children[1]);
    }

    _applyFitLayoutNode(node) {
        if (node.type === 'panel') return;
        const splitEl = this.container.querySelector(`.layout-split[data-id="${node.id}"]`);
        const children = splitEl?.querySelectorAll(':scope > .layout-split-child');
        if (children?.length === 2) {
            children[0].style.flex = String(node.ratio);
            children[1].style.flex = String(1 - node.ratio);
        }
        this._applyFitLayoutNode(node.children[0]);
        this._applyFitLayoutNode(node.children[1]);
    }

    _setNodeHeightFromBottom(node, targetHeight) {
        const currentHeight = this._scrollableNodeHeight(node);
        this._adjustNodeBottomHeight(node, targetHeight - currentHeight);
    }

    _adjustNodeBottomHeight(node, delta) {
        if (!delta) return;
        if (node.type === 'panel') {
            node.scrollHeight = Math.max(
                LayoutManager.MIN_SCROLL_PANEL_HEIGHT,
                (node.scrollHeight || LayoutManager.MIN_SCROLL_PANEL_HEIGHT) + delta,
            );
            return;
        }

        if (node.direction === 'h') {
            this._adjustNodeBottomHeight(node.children[1], delta);
            return;
        }

        const targetHeight = Math.max(LayoutManager.MIN_SCROLL_PANEL_HEIGHT, this._scrollableNodeHeight(node) + delta);
        this._setNodeHeightFromBottom(node.children[0], targetHeight);
        this._setNodeHeightFromBottom(node.children[1], targetHeight);
    }

    _estimateSmallestPanelHeight(node, availableHeight) {
        if (node.type === 'panel') return availableHeight;
        if (node.direction === 'h') {
            const usable = Math.max(0, availableHeight - LayoutManager.SPLIT_HANDLE_THICKNESS);
            return Math.min(
                this._estimateSmallestPanelHeight(node.children[0], usable * node.ratio),
                this._estimateSmallestPanelHeight(node.children[1], usable * (1 - node.ratio)),
            );
        }
        return Math.min(
            this._estimateSmallestPanelHeight(node.children[0], availableHeight),
            this._estimateSmallestPanelHeight(node.children[1], availableHeight),
        );
    }

    _ensureScrollResizeHandle(rootEl) {
        let handle = rootEl.querySelector(':scope > .layout-scroll-resize-handle');
        if (handle) return;
        handle = document.createElement('div');
        handle.className = 'layout-scroll-resize-handle';
        handle.title = i18n.t('resizeScrollablePlotArea');
        handle.addEventListener('mousedown', (e) => this._startScrollResize(e, rootEl));
        rootEl.appendChild(handle);
    }

    _revealPanel(panelId) {
        if (!this.scrollablePlotArea) return;
        const panelEl = this.container.querySelector(`.layout-panel[data-id="${panelId}"]`);
        if (!panelEl) return;
        const panelRect = panelEl.getBoundingClientRect();
        const containerRect = this.container.getBoundingClientRect();
        if (panelRect.bottom > containerRect.bottom) {
            this.container.scrollTop += panelRect.bottom - containerRect.bottom + 8;
        } else if (panelRect.top < containerRect.top) {
            this.container.scrollTop -= containerRect.top - panelRect.top + 8;
        }
    }

    _makeToolbarBtn(label, title, onClick) {
        const btn = document.createElement('button');
        btn.className = 'layout-toolbar-btn';
        btn.textContent = label;
        btn.title = title;
        btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        return btn;
    }

    _bindToolbarScroll(toolbar) {
        if (toolbar._scrollBound) return;
        toolbar._scrollBound = true;

        const updateScrollHints = () => {
            const max = Math.max(0, toolbar.scrollWidth - toolbar.clientWidth);
            toolbar.classList.toggle('can-scroll-left', toolbar.scrollLeft > 1);
            toolbar.classList.toggle('can-scroll-right', toolbar.scrollLeft < max - 1);
            toolbar.classList.toggle('is-scrollable', max > 1);
        };

        toolbar.addEventListener('wheel', (e) => {
            const max = Math.max(0, toolbar.scrollWidth - toolbar.clientWidth);
            if (max <= 1) return;

            const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            if (!delta) return;

            const before = toolbar.scrollLeft;
            toolbar.scrollLeft = Math.max(0, Math.min(max, before + delta));
            if (toolbar.scrollLeft !== before) {
                e.preventDefault();
                e.stopPropagation();
                updateScrollHints();
            }
        }, { passive: false });

        toolbar.addEventListener('scroll', updateScrollHints, { passive: true });

        if (typeof ResizeObserver !== 'undefined') {
            const ro = new ResizeObserver(updateScrollHints);
            ro.observe(toolbar);
            toolbar._scrollResizeObserver = ro;
        }

        const mo = new MutationObserver(() => requestAnimationFrame(updateScrollHints));
        mo.observe(toolbar, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
        toolbar._scrollMutationObserver = mo;

        requestAnimationFrame(updateScrollHints);
    }

    // ─── Resize ────────────────────────────────────────────────────

    _startResize(e, splitNode, splitEl) {
        e.preventDefault();
        const rect = splitEl.getBoundingClientRect();
        this._resizing = { splitNode, splitEl, rect };
        if (this.scrollablePlotArea && splitNode.direction === 'h') {
            this._ensureScrollablePanelHeights(this.root);
            this._resizing.scrollMode = true;
            this._resizing.startY = e.clientY;
            this._resizing.targetNode = splitNode.children[0];
            this._resizing.startHeight = this._scrollableNodeHeight(splitNode.children[0]);
        }
        document.body.style.cursor = splitNode.direction === 'v' ? 'ew-resize' : 'ns-resize';
        splitEl.classList.add('resizing');
    }

    _startScrollResize(e, rootEl) {
        if (!this.scrollablePlotArea) return;
        e.preventDefault();
        e.stopPropagation();
        this._scrollResizing = {
            rootEl,
            startY: e.clientY,
            lastY: e.clientY,
            lastDeltaY: 0,
            targetNode: this.root,
            startHeight: this._scrollableNodeHeight(this.root),
        };
        rootEl.classList.add('scroll-resizing');
        document.body.style.cursor = 'ns-resize';
        document.body.style.userSelect = 'none';
        this._scrollResizeRAF = requestAnimationFrame(() => this._tickScrollResize());
    }

    _onMouseMove(e) {
        if (this._scrollResizing) {
            const { startY, startHeight, targetNode } = this._scrollResizing;
            this._scrollResizing.lastDeltaY = e.clientY - this._scrollResizing.lastY;
            this._scrollResizing.lastY = e.clientY;
            this._setNodeHeightFromBottom(targetNode, startHeight + e.clientY - startY);
            this._applyScrollableLayout();
            if (this._scrollResizing.lastDeltaY >= 0) {
                this.container.scrollTop = this.container.scrollHeight;
            }
            return;
        }

        if (!this._resizing) return;
        const { splitNode, splitEl, rect } = this._resizing;

        if (this._resizing.scrollMode) {
            const { startY, startHeight, targetNode } = this._resizing;
            this._setNodeHeightFromBottom(targetNode, startHeight + e.clientY - startY);
            this._applyScrollableLayout();
            return;
        }

        let ratio;
        if (splitNode.direction === 'v') {
            ratio = (e.clientX - rect.left) / rect.width;
        } else {
            ratio = (e.clientY - rect.top) / rect.height;
        }

        ratio = Math.max(0.1, Math.min(0.9, ratio));
        splitNode.ratio = ratio;

        // Update flex values live (without full re-render)
        const children = splitEl.querySelectorAll(':scope > .layout-split-child');
        if (children.length === 2) {
            children[0].style.flex = String(ratio);
            children[1].style.flex = String(1 - ratio);
        }
    }

    _tickScrollResize() {
        if (!this._scrollResizing) {
            this._scrollResizeRAF = null;
            return;
        }

        const rect = this.container.getBoundingClientRect();
        const edge = 10;
        const isPushingDown = this._scrollResizing.lastDeltaY >= 0;
        const isAtBottomEdge = this._scrollResizing.lastY >= rect.bottom - edge;
        if (isPushingDown && isAtBottomEdge) {
            const pressure = Math.min(1, Math.max(0, this._scrollResizing.lastY - (rect.bottom - edge)) / edge);
            const targetNode = this._scrollResizing.targetNode;
            const targetHeight = this._scrollableNodeHeight(targetNode) + 1 + pressure * 5;
            this._setNodeHeightFromBottom(targetNode, targetHeight);
            this._scrollResizing.startHeight = this._scrollableNodeHeight(targetNode);
            this._scrollResizing.startY = this._scrollResizing.lastY;
            this._applyScrollableLayout();
            this.container.scrollTop = this.container.scrollHeight;
        }

        this._scrollResizeRAF = requestAnimationFrame(() => this._tickScrollResize());
    }

    _onMouseUp() {
        if (this._scrollResizing) {
            const { rootEl } = this._scrollResizing;
            rootEl.classList.remove('scroll-resizing');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            this._scrollResizing = null;
            if (this._scrollResizeRAF) {
                cancelAnimationFrame(this._scrollResizeRAF);
                this._scrollResizeRAF = null;
            }
            requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
            return;
        }

        if (!this._resizing) return;
        const { splitEl } = this._resizing;
        splitEl.classList.remove('resizing');
        document.body.style.cursor = '';
        this._resizing = null;
        this._applyScrollableLayout();
    }

    _bindGlobalEvents() {
        document.addEventListener('mousemove', (e) => this._onMouseMove(e));
        document.addEventListener('mouseup',   ()  => this._onMouseUp());
    }

    // ─── Tree helpers ──────────────────────────────────────────────

    /**
     * Find a node by id, returning { node, parent, side }.
     * parent=null and side=null if node is root.
     */
    _findNode(current, parent, targetId, side = null) {
        if (current.id === targetId) {
            return { node: current, parent, side };
        }
        if (current.type === 'split') {
            return (
                this._findNode(current.children[0], current, targetId, 0) ||
                this._findNode(current.children[1], current, targetId, 1)
            );
        }
        return null;
    }

    /** Replace a child of parent (or root if parent is null). */
    _replaceNode(parent, side, newNode) {
        if (parent === null) {
            this.root = newNode;
        } else {
            parent.children[side] = newNode;
        }
    }

    _makePanel() {
        return { type: 'panel', id: this._uid(), plotConfig: null };
    }

    _uid() {
        return 'p_' + Math.random().toString(36).slice(2, 9);
    }

    static MIN_SCROLL_PANEL_HEIGHT = 260;
    static MIN_COMPRESSED_PANEL_HEIGHT = 180;
    static SPLIT_HANDLE_THICKNESS = 4;
}
