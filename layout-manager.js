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
class LayoutManager {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.root = this._makePanel();
        this._resizing = null;   // active resize state

        // Optional hooks set by PlotManager
        this.onPanelMount   = null;  // (panelId, panelEl) => void
        this.onPanelUnmount = null;  // (panelId) => void

        this._load();
        this._bindGlobalEvents();
    }

    // ─── Public API ────────────────────────────────────────────────

    /** Re-render the whole layout tree into the container. */
    render() {
        this.container.innerHTML = '';
        this._renderNode(this.root, this.container);
        this._save();
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

    _makeToolbarBtn(label, title, onClick) {
        const btn = document.createElement('button');
        btn.className = 'layout-toolbar-btn';
        btn.textContent = label;
        btn.title = title;
        btn.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        return btn;
    }

    // ─── Resize ────────────────────────────────────────────────────

    _startResize(e, splitNode, splitEl) {
        e.preventDefault();
        const rect = splitEl.getBoundingClientRect();
        this._resizing = { splitNode, splitEl, rect };
        document.body.style.cursor = splitNode.direction === 'v' ? 'ew-resize' : 'ns-resize';
        splitEl.classList.add('resizing');
    }

    _onMouseMove(e) {
        if (!this._resizing) return;
        const { splitNode, splitEl, rect } = this._resizing;

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

    _onMouseUp() {
        if (!this._resizing) return;
        const { splitEl } = this._resizing;
        splitEl.classList.remove('resizing');
        document.body.style.cursor = '';
        this._resizing = null;
        this._save();   // persist ratio after drag
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

    // ─── Persistence ───────────────────────────────────────────────

    _save() {
        try {
            localStorage.setItem('om-layout', JSON.stringify(this.root));
        } catch (_) {}
    }

    _load() {
        try {
            const saved = localStorage.getItem('om-layout');
            if (saved) {
                this.root = JSON.parse(saved);
            }
        } catch (_) {}
    }
}
