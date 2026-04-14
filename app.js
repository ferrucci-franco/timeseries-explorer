/**
 * OpenModelica Viewer - Main Application
 */

const EXAMPLES = [
    {
        id: 'pendulum',
        nameKey: 'examplePendulum',
        baseName: 'ExampleSimplePendulum',
        getDataB64: () => (typeof EXAMPLE_DATA_B64 !== 'undefined' ? EXAMPLE_DATA_B64 : null),
        applyLayout: (pm, fileId, panels) => pm.setExampleLayout(fileId, panels),
    },
    { id: 'placeholder1', nameKey: 'examplePlaceholder1', getDataB64: () => null },
    { id: 'placeholder2', nameKey: 'examplePlaceholder2', getDataB64: () => null },
];

class OpenModelicaViewer {
    constructor() {
        this.parser      = new MatParser();
        this.files       = new Map();   // fileId → { file, name }
        this._nextFileId = 1;
        this.theme       = 'light';
        this.language    = 'en';
        this.showDescriptions = false;
        this.sortAlphabetical = false;
        this._currentTree     = null;
        this._filterText      = '';

        this.layoutManager = new LayoutManager('plots-area');
        this.plotManager   = new PlotManager(this.parser);

        this.layoutManager.onPanelMount   = (id, el) => this.plotManager.onPanelMount(id, el);
        this.layoutManager.onPanelUnmount = (id)     => this.plotManager.onPanelUnmount(id);

        this.initEventListeners();
        this.initDragAndDrop();
        this.initSidebarResize();
        i18n.setLanguage('en');

        this.layoutManager.render();
    }

    // ─── File management ───────────────────────────────────────────

    get activeFileId() { return this.plotManager.activeFileId; }

    async loadFile(file) {
        if (!file.name.endsWith('.mat')) { alert(i18n.t('invalidFile')); return; }

        try {
            document.getElementById('file-name').textContent = `Loading ${file.name}…`;
            const buffer = await (file.arrayBuffer ? file.arrayBuffer() : this._readAsArrayBuffer(file));
            const data   = await this.parser.parse(buffer);

            const fileId   = `f${this._nextFileId++}`;
            const baseName = file.name.replace(/\.mat$/i, '');
            this.files.set(fileId, { file, buffer, name: baseName });

            // PlotManager takes ownership of the data
            this.plotManager.addFile(fileId, baseName, data);

            // Hide drop zone after first file
            document.getElementById('drop-zone').classList.remove('active');

            this._updateTopBar();
            this._renderFilesList();
            this.renderVariablesTree(data.tree);
            this._updateActionButtons();

            console.log('Loaded:', file.name, '— variables:', Object.keys(data.variables).length);
        } catch (err) {
            console.error('Error loading file:', err);
            alert(i18n.t('errorLoading') + ': ' + (err?.message || String(err)));
            document.getElementById('file-name').textContent = '';
        }
    }

    async reloadActiveFile() {
        const id = this.plotManager.activeFileId;
        if (!id) return;
        const entry = this.files.get(id);
        if (!entry) return;

        document.getElementById('file-name').textContent = `Loading ${entry.name}.mat…`;

        // Try native File.arrayBuffer() first (most reliable for re-reads),
        // then fall back to the cached buffer from initial load.
        let buffer;
        if (entry.file?.arrayBuffer) {
            try { buffer = await entry.file.arrayBuffer(); } catch (_) {}
        }
        if (!buffer) buffer = entry.buffer;
        if (!buffer) throw new Error('No buffer available');

        const data = await this.parser.parse(buffer);

        this.plotManager.updateFileData(id, data);
        this._updateTopBar();
        this.renderVariablesTree(data.tree);
    }

    async removeFile(fileId) {
        if (!this.files.has(fileId)) return;

        if (this.plotManager.hasTracesForFile(fileId)) {
            const ok = await Modal.confirm(i18n.t('closeFileWarning'), { icon: '📂' });
            if (!ok) return;
        }

        this.plotManager.removeFile(fileId);
        this.files.delete(fileId);

        // Switch sidebar to new active file (if any)
        const newActiveId = this.plotManager.activeFileId;
        if (newActiveId) {
            const d = this.plotManager.files.get(newActiveId)?.data;
            if (d) this.renderVariablesTree(d.tree);
        } else {
            document.getElementById('variables-tree').innerHTML = '';
            document.getElementById('drop-zone').classList.add('active');
        }

        this._updateTopBar();
        this._renderFilesList();
        this._updateActionButtons();
    }

    setActiveFile(fileId) {
        if (!this.files.has(fileId)) return;
        this.plotManager.setActiveFile(fileId);
        const d = this.plotManager.files.get(fileId)?.data;
        if (d) this.renderVariablesTree(d.tree);
        this._updateTopBar();
        this._renderFilesList();
    }

    _updateTopBar() {
        const id   = this.plotManager.activeFileId;
        const name = id ? (this.files.get(id)?.name ?? '') : '';
        document.getElementById('file-name').textContent = name ? `${name}.mat` : '';
    }

    _updateActionButtons() {
        const hasFiles = this.files.size > 0;
        document.getElementById('reload-file').disabled  = !hasFiles;
        document.getElementById('auto-zoom').disabled    = !hasFiles;
        document.getElementById('clear-plots').disabled  = !hasFiles;
    }

    _renderFilesList() {
        const list = document.getElementById('files-list');
        list.innerHTML = '';
        for (const [fileId, { name }] of this.files) {
            const entry = document.createElement('div');
            entry.className = 'file-entry' + (fileId === this.activeFileId ? ' active' : '');

            const nameSpan = document.createElement('span');
            nameSpan.className = 'file-entry-name';
            nameSpan.textContent = name;
            nameSpan.title = name + '.mat';
            nameSpan.addEventListener('click', () => this.setActiveFile(fileId));

            const closeBtn = document.createElement('button');
            closeBtn.className = 'file-entry-close';
            closeBtn.textContent = '✕';
            closeBtn.title = i18n.t('closeFile');
            closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.removeFile(fileId); });

            entry.appendChild(nameSpan);
            entry.appendChild(closeBtn);
            list.appendChild(entry);
        }
    }

    // ─── Event listeners ───────────────────────────────────────────

    initEventListeners() {
        document.querySelectorAll('.lang-btn').forEach(btn => {
            btn.addEventListener('click', (e) => this.setLanguage(e.target.getAttribute('data-lang')));
        });

        document.getElementById('theme-toggle').addEventListener('click', () => this.toggleTheme());

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
            document.getElementById('file-input').click();
        });

        document.getElementById('toggle-sort').addEventListener('click', (e) => {
            this.sortAlphabetical = !this.sortAlphabetical;
            e.currentTarget.classList.toggle('active', this.sortAlphabetical);
            if (this._currentTree) this._renderFilteredTree();
        });

        document.getElementById('variable-filter').addEventListener('input', (e) => {
            this._filterText = e.target.value.trim().toLowerCase();
            if (this._currentTree) this._renderFilteredTree();
        });

        document.getElementById('expand-all').addEventListener('click',   () => this.expandAllTree());
        document.getElementById('collapse-all').addEventListener('click', () => this.collapseAllTree());

        document.getElementById('file-select-btn').addEventListener('click', () => {
            document.getElementById('file-input').click();
        });

        document.getElementById('file-input').addEventListener('change', async (e) => {
            const files = Array.from(e.target.files || []);
            e.target.value = '';
            for (const f of files) await this.loadFile(f);
        });

        document.getElementById('link-time-axes').addEventListener('change', (e) => {
            this.plotManager.setSyncAxes(e.target.checked);
        });

        document.getElementById('sync-hover').addEventListener('change', (e) => {
            this.plotManager.setSyncHover(e.target.checked);
        });

        document.getElementById('hover-proximity').addEventListener('change', (e) => {
            this.plotManager.setHoverProximity(e.target.checked);
        });

        document.querySelectorAll('input[name="legend-pos"]').forEach(radio => {
            radio.addEventListener('change', (e) => this.plotManager.setLegendPosition(e.target.value));
        });

        document.getElementById('reset-layout').addEventListener('click', async () => {
            const ok = await Modal.confirm(i18n.t('resetLayoutWarning'), { icon: '⬜' });
            if (ok) this.layoutManager.reset();
        });

        document.getElementById('auto-zoom').addEventListener('click',   () => this.plotManager.autoZoomAll());
        document.getElementById('clear-plots').addEventListener('click', () => this.plotManager.clearAll());

        document.getElementById('reload-file').addEventListener('click', () => {
            this.reloadActiveFile().catch(err => {
                console.error('Reload failed:', err);
                alert(i18n.t('errorLoading') + ': ' + (err?.message || String(err)));
                this._updateTopBar();
            });
        });

        this._initExampleMenu();

        document.getElementById('help-btn').addEventListener('click', () => this.showHelp());
    }

    _initExampleMenu() {
        const btn  = document.getElementById('load-example-btn');
        const menu = document.getElementById('example-menu');

        const close = () => {
            menu.hidden = true;
            btn.setAttribute('aria-expanded', 'false');
        };
        const open = () => {
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
    }

    _renderExampleMenu() {
        const menu = document.getElementById('example-menu');
        menu.innerHTML = '';
        for (const ex of EXAMPLES) {
            const item = document.createElement('button');
            item.className = 'example-menu-item';
            item.type = 'button';
            item.setAttribute('role', 'menuitem');

            const available = ex.getDataB64() != null;
            item.disabled = !available;

            const name = document.createElement('span');
            name.className = 'example-name';
            name.textContent = i18n.t(ex.nameKey);
            item.appendChild(name);

            if (!available) {
                const badge = document.createElement('span');
                badge.className = 'example-badge';
                badge.textContent = i18n.t('exampleComingSoon');
                item.appendChild(badge);
            }

            item.addEventListener('click', () => {
                this._closeExampleMenu();
                if (!available) return;
                this.loadExample(ex.id).catch(err => {
                    console.error('Example load failed:', err);
                    alert(i18n.t('errorLoading') + ': ' + (err?.message || String(err)));
                });
            });
            menu.appendChild(item);
        }
    }

    async loadExample(exampleId = 'pendulum') {
        const ex = EXAMPLES.find(e => e.id === exampleId);
        if (!ex) throw new Error(`Unknown example: ${exampleId}`);
        const b64 = ex.getDataB64();
        if (b64 == null) return;
        if (this.plotManager.hasAnyTraces()) {
            const ok = await Modal.confirm(i18n.t('loadExampleWarning'), { icon: '🎓' });
            if (!ok) return;
        }

        // Decode embedded base64 data — works with file:// and http:// alike
        const binary = atob(b64);
        const buffer = new ArrayBuffer(binary.length);
        const view   = new Uint8Array(buffer);
        for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);

        const data   = await this.parser.parse(buffer);

        const baseName   = ex.baseName;
        const existingId = [...this.files.entries()].find(([,e]) => e.name === baseName)?.[0];
        let fileId = existingId;
        if (!fileId) {
            fileId = `f${this._nextFileId++}`;
            this.files.set(fileId, { file: null, buffer, name: baseName });
            this.plotManager.addFile(fileId, baseName, data);
        } else {
            this.files.get(fileId).buffer = buffer;
            this.plotManager.updateFileData(fileId, data);
        }
        this.plotManager.setActiveFile(fileId);

        // Clear plots and build 2×2 grid
        this.plotManager.clearAll();
        this.layoutManager.resetToGrid(2, 2);

        // Wait for panels to mount
        await new Promise(r => setTimeout(r, 50));

        // Collect panel IDs in DOM order: TL, TR, BL, BR
        const panels = [...document.querySelectorAll('.layout-panel')].map(el => el.dataset.id);
        if (panels.length < 4) return;
        const [tlId, trId, blId, brId] = panels;

        // Set state directly — no addTrace, avoids async race conditions
        ex.applyLayout(this.plotManager, fileId, { tlId, trId, blId, brId });

        document.getElementById('drop-zone').classList.remove('active');
        this._updateTopBar();
        this._renderFilesList();
        this._updateActionButtons();
        this.renderVariablesTree(data.tree);
    }

    showHelp() {
        const sections = ['1','2','3','4','5'];

        const backdrop = document.createElement('div');
        backdrop.className = 'help-backdrop';

        const modal = document.createElement('div');
        modal.className = 'help-modal';

        const header = document.createElement('div');
        header.className = 'help-modal-header';
        const title = document.createElement('h2');
        title.textContent = i18n.t('helpTitle');
        const closeBtn = document.createElement('button');
        closeBtn.className = 'help-modal-close';
        closeBtn.textContent = '✕';
        closeBtn.title = i18n.t('helpClose');
        header.append(title, closeBtn);

        const body = document.createElement('div');
        body.className = 'help-modal-body';

        for (const n of sections) {
            const sec = document.createElement('div');
            sec.className = 'help-section';
            const h3 = document.createElement('h3');
            h3.textContent = i18n.t(`helpSec${n}Title`);
            const p = document.createElement('p');
            p.innerHTML = i18n.t(`helpSec${n}Body`);
            sec.append(h3, p);
            body.appendChild(sec);
        }

        modal.append(header, body);
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);

        const close = () => backdrop.remove();
        closeBtn.addEventListener('click', close);
        backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
        document.addEventListener('keydown', function onKey(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
        });
    }

    // ─── Drag-and-drop file loading ────────────────────────────────

    initDragAndDrop() {
        const dropZone = document.getElementById('drop-zone');

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragging');
        });

        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));

        dropZone.addEventListener('drop', async (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragging');
            const files = Array.from(e.dataTransfer.files || []).filter(f => f.name.endsWith('.mat'));
            if (!files.length) { alert(i18n.t('invalidFile')); return; }
            for (const f of files) await this.loadFile(f);
        });
    }

    // ─── Sidebar resize ────────────────────────────────────────────

    initSidebarResize() {
        const sidebar = document.getElementById('sidebar');
        const handle  = document.querySelector('.sidebar-resize-handle');
        let isResizing = false, startX = 0, startWidth = 0;

        handle.addEventListener('mousedown', (e) => {
            isResizing = true; startX = e.clientX; startWidth = sidebar.offsetWidth;
            handle.classList.add('resizing');
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            const w = Math.max(200, Math.min(600, startWidth + e.clientX - startX));
            sidebar.style.width = w + 'px';
        });

        document.addEventListener('mouseup', () => {
            if (!isResizing) return;
            isResizing = false;
            handle.classList.remove('resizing');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        });
    }

    // ─── Variables tree ────────────────────────────────────────────

    renderVariablesTree(tree) {
        this._currentTree = tree;
        this._renderFilteredTree();
    }

    _renderFilteredTree() {
        const container = document.getElementById('variables-tree');
        container.innerHTML = '';
        const filter = this._filterText;
        const autoExpand = filter.length > 0;
        this._renderTreeNode(this._currentTree, container, 0, filter, autoExpand);
    }

    /**
     * Check if a tree node (or any descendant) contains a variable whose
     * full name matches the filter text (substring, case-insensitive).
     */
    _nodeMatchesFilter(node, filter) {
        if (!filter) return true;
        for (const variable of Object.values(node._variables || {})) {
            if (variable.name.toLowerCase().includes(filter)) return true;
        }
        for (const child of Object.values(node._children || {})) {
            if (this._nodeMatchesFilter(child, filter)) return true;
        }
        return false;
    }

    _renderTreeNode(node, parentElement, level, filter, autoExpand) {
        // Collect children entries
        let childrenEntries = Object.entries(node._children || {});
        if (this.sortAlphabetical) {
            childrenEntries.sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
        }

        // Collect variable entries, split into vars and params when sorting
        let allVarEntries = Object.entries(node._variables || {});

        // Filter children and variables
        if (filter) {
            childrenEntries = childrenEntries.filter(([, child]) => this._nodeMatchesFilter(child, filter));
            allVarEntries = allVarEntries.filter(([, v]) => v.name.toLowerCase().includes(filter));
        }

        let varEntries, paramEntries;
        if (this.sortAlphabetical) {
            varEntries   = allVarEntries.filter(([, v]) => v.kind !== 'parameter');
            paramEntries = allVarEntries.filter(([, v]) => v.kind === 'parameter');
            varEntries.sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
            paramEntries.sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
        } else {
            varEntries   = allVarEntries;
            paramEntries = [];
        }

        // Render children (sub-components)
        for (const [name, child] of childrenEntries) {
            const nodeDiv  = document.createElement('div');
            nodeDiv.className = 'tree-node';

            const itemDiv = document.createElement('div');
            itemDiv.className = 'tree-item';

            const toggle = document.createElement('span');
            toggle.className = 'tree-toggle' + (autoExpand ? ' expanded' : '');
            toggle.textContent = '▸';

            const icon  = document.createElement('span');
            icon.className = 'tree-icon';
            icon.textContent = '📦';

            const label = document.createElement('span');
            label.className = 'tree-label';
            label.textContent = name;

            const info = document.createElement('span');
            info.className = 'tree-info';
            info.textContent = `(${this.parser.countVariables(child)})`;

            itemDiv.append(toggle, icon, label, info);

            const childrenDiv = document.createElement('div');
            childrenDiv.className = 'tree-children' + (autoExpand ? '' : ' collapsed');

            itemDiv.addEventListener('click', (e) => {
                e.stopPropagation();
                const collapsed = childrenDiv.classList.toggle('collapsed');
                toggle.classList.toggle('expanded', !collapsed);
            });

            this._renderTreeNode(child, childrenDiv, level + 1, filter, autoExpand);
            nodeDiv.append(itemDiv, childrenDiv);
            parentElement.appendChild(nodeDiv);
        }

        // Render variables (non-parameter when sorted, all when unsorted)
        this._renderVarLeaves(varEntries, parentElement);

        // Render parameters sub-section (only when sorting is active and there are params)
        if (this.sortAlphabetical && paramEntries.length > 0) {
            const paramLabel = document.createElement('div');
            paramLabel.className = 'tree-param-label';
            paramLabel.textContent = 'Parameters';
            parentElement.appendChild(paramLabel);
            this._renderVarLeaves(paramEntries, parentElement);
        }
    }

    _renderVarLeaves(entries, parentElement) {
        for (const [name, variable] of entries) {
            const nodeDiv = document.createElement('div');
            nodeDiv.className = 'tree-node';

            const itemDiv = document.createElement('div');
            itemDiv.className = 'tree-item';
            itemDiv.setAttribute('draggable', 'true');
            itemDiv.setAttribute('data-var-name', variable.name);

            const spacer = document.createElement('span');
            spacer.className = 'tree-toggle';

            const icon  = document.createElement('span');
            icon.className = 'tree-icon';
            icon.textContent = this.parser.getVariableIcon(variable);

            const label = document.createElement('span');
            label.className = 'tree-label';
            label.textContent = name;
            label.title = variable.description || name;

            const info = document.createElement('span');
            info.className = 'tree-info';
            info.textContent = this.parser.getVariableInfo(variable);

            itemDiv.append(spacer, icon, label, info);

            if (variable.description) {
                const descDiv = document.createElement('div');
                descDiv.className = 'tree-description' + (this.showDescriptions ? ' show' : '');
                descDiv.textContent = variable.description;
                nodeDiv.append(itemDiv, descDiv);
            } else {
                nodeDiv.appendChild(itemDiv);
            }

            itemDiv.addEventListener('dragstart', (e) => {
                e.dataTransfer.setData('text/plain', variable.name);
                e.dataTransfer.effectAllowed = 'copy';
                itemDiv.classList.add('dragging');
            });
            itemDiv.addEventListener('dragend', () => itemDiv.classList.remove('dragging'));

            parentElement.appendChild(nodeDiv);
        }
    }

    toggleDescriptions(show) {
        document.querySelectorAll('.tree-description').forEach(d => d.classList.toggle('show', show));
    }

    expandAllTree() {
        document.querySelectorAll('.tree-children').forEach(d => d.classList.remove('collapsed'));
        document.querySelectorAll('.tree-toggle').forEach(t => { if (t.textContent === '▸') t.classList.add('expanded'); });
    }

    collapseAllTree() {
        document.querySelectorAll('.tree-children').forEach(d => d.classList.add('collapsed'));
        document.querySelectorAll('.tree-toggle').forEach(t => t.classList.remove('expanded'));
    }

    // ─── Theme & language ──────────────────────────────────────────

    setLanguage(lang) {
        this.language = lang;
        i18n.setLanguage(lang);
        document.querySelectorAll('.lang-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-lang') === lang);
        });
        this._renderFilesList();
        this.layoutManager.render();
    }

    toggleTheme() {
        this.theme = this.theme === 'light' ? 'dark' : 'light';
        document.body.className = `theme-${this.theme}`;
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

document.addEventListener('DOMContentLoaded', () => { window.app = new OpenModelicaViewer(); });
