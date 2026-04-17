/**
 * OpenModelica Viewer - Main Application
 */

const EXAMPLES = [
    {
        id: 'pendulum',
        nameKey: 'examplePendulum',
        baseName: 'ExampleSimplePendulum',
        script: 'example-data.js',
        getDataB64: () => (typeof EXAMPLE_DATA_B64 !== 'undefined' ? EXAMPLE_DATA_B64 : null),
        applyLayout: (pm, fileId, panels) => pm.setExampleLayout(fileId, panels),
    },
    {
        id: 'lorenz',
        nameKey: 'exampleLorenz',
        baseName: 'LorenzSystem_res',
        script: 'lorenz-data.js',
        grid: { rows: 1, cols: 1 },
        getDataB64: () => (typeof LORENZ_DATA_B64 !== 'undefined' ? LORENZ_DATA_B64 : null),
        applyLayout: (pm, fileId, panels) => pm.setLorenzExampleLayout(fileId, panels),
    },
    { id: 'placeholder2', nameKey: 'examplePlaceholder2', getDataB64: () => null },
];

const DERIVED_FUNCTIONS = [
    { name: 'sqrt', arity: 1 },
    { name: 'abs', arity: 1 },
    { name: 'log', arity: 1 },
    { name: 'log10', arity: 1 },
    { name: 'power', arity: 2 },
    { name: 'root', arity: 2 },
];

const DERIVED_FUNCTION_ALIASES = new Map([
    ['pow', 'power'],
    ['square', 'square'],
    ['sqr', 'square'],
]);

class OpenModelicaViewer {
    constructor() {
        this.parser      = new MatParser();
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
        this._exampleLoading = false;
        this._exampleLoadToken = null;
        this._exampleLoadingEscHandler = null;

        this.layoutManager = new LayoutManager('plots-area');
        this.plotManager   = new PlotManager(this.parser);

        this.layoutManager.onPanelMount   = (id, el) => this.plotManager.onPanelMount(id, el);
        this.layoutManager.onPanelUnmount = (id)     => this.plotManager.onPanelUnmount(id);

        this.applyTheme(this.theme);
        this.initEventListeners();
        this.initDragAndDrop();
        this.initSidebarResize();
        i18n.setLanguage('en');
        this._setDropZoneStatus(false);

        this.layoutManager.render();
    }

    // ─── File management ───────────────────────────────────────────

    get activeFileId() { return this.plotManager.activeFileId; }

    async loadFile(file) {
        if (!file.name.endsWith('.mat')) { alert(i18n.t('invalidFile')); return; }

        try {
            document.getElementById('file-name').textContent = `Loading ${file.name}…`;
            const buffer = await (file.arrayBuffer ? file.arrayBuffer() : this._readAsArrayBuffer(file));
            const contentHash = await this._hashBuffer(buffer);
            const data   = await this.parser.parse(buffer);

            const fileId   = `f${this._nextFileId++}`;
            const baseName = file.name.replace(/\.mat$/i, '');
            this.files.set(fileId, { file, buffer, contentHash, name: baseName });

            // PlotManager takes ownership of the data
            this.plotManager.addFile(fileId, baseName, data);

            // Hide drop zone after first file
            document.getElementById('drop-zone').classList.remove('active');

            this._updateTopBar();
            this._renderFilesList();
            this._clearVariableSelection();
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

        const buffer = await this._readLatestBuffer(entry);
        const contentHash = await this._hashBuffer(buffer);

        const data = await this.parser.parse(buffer);
        this._reapplyDerivedVariables(id, data);

        entry.buffer = buffer;
        entry.contentHash = contentHash;
        this.plotManager.updateFileData(id, data);
        this._updateTopBar();
        this._clearVariableSelection();
        this.renderVariablesTree(data.tree);
    }

    async reloadActiveFileAsNewVersion() {
        const sourceId = this.plotManager.activeFileId;
        if (!sourceId) return;
        const source = this.files.get(sourceId);
        if (!source) return;

        const name = this._nextVersionName(source.name);
        document.getElementById('file-name').textContent = `Loading ${name}.mat…`;

        const buffer = await this._readLatestBuffer(source);
        const contentHash = await this._hashBuffer(buffer);
        const sourceHash = source.contentHash || (source.buffer ? await this._hashBuffer(source.buffer) : '');
        if (!source.contentHash && sourceHash) source.contentHash = sourceHash;
        if (sourceHash && contentHash === sourceHash) {
            document.getElementById('file-name').textContent = `${source.name}.mat`;
            await Modal.alert(i18n.t('reloadAsNewVersion'), i18n.t('reloadUnchangedNoVersion'), { icon: '🔄' });
            this._updateTopBar();
            return;
        }

        const data = await this.parser.parse(buffer);

        const fileId = `f${this._nextFileId++}`;
        this._copyDerivedDefinitions(sourceId, fileId);
        this._reapplyDerivedVariables(fileId, data);
        this.files.set(fileId, {
            file: source.file,
            buffer,
            contentHash,
            name,
        });
        this.plotManager.addFile(fileId, name, data);
        this.plotManager.setActiveFile(fileId);

        document.getElementById('drop-zone').classList.remove('active');
        this._updateTopBar();
        this._renderFilesList();
        this._clearVariableSelection();
        this.renderVariablesTree(data.tree);
        this._updateActionButtons();
    }

    async _readLatestBuffer(entry) {
        // Try native File.arrayBuffer() first (most reliable for re-reads),
        // then fall back to the cached buffer from initial load.
        let buffer;
        if (entry.file?.arrayBuffer) {
            try { buffer = await entry.file.arrayBuffer(); } catch (_) {}
        }
        if (!buffer) buffer = entry.buffer;
        if (!buffer) throw new Error('No buffer available');
        return buffer;
    }

    _nextVersionName(name) {
        const base = String(name || 'results').replace(/\s+#\d+$/, '');
        let maxVersion = 1;
        for (const { name: existingName } of this.files.values()) {
            if (existingName === base) {
                maxVersion = Math.max(maxVersion, 1);
                continue;
            }
            const match = String(existingName).match(new RegExp(`^${this._escapeRegExp(base)}\\s+#(\\d+)$`));
            if (match) maxVersion = Math.max(maxVersion, Number(match[1]));
        }
        return `${base} #${maxVersion + 1}`;
    }

    _escapeRegExp(text) {
        return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    async _hashBuffer(buffer) {
        if (typeof crypto !== 'undefined' && crypto.subtle?.digest) {
            const digest = await crypto.subtle.digest('SHA-256', buffer);
            return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
        }

        const bytes = new Uint8Array(buffer);
        let hash = 2166136261;
        for (let i = 0; i < bytes.length; i++) {
            hash ^= bytes[i];
            hash = Math.imul(hash, 16777619) >>> 0;
        }
        return `fnv1a32:${bytes.length}:${hash.toString(16).padStart(8, '0')}`;
    }

    _copyDerivedDefinitions(sourceId, targetId) {
        const sourceDerived = this.derivedByFile.get(sourceId);
        if (!sourceDerived?.size) return;

        const targetDerived = new Map();
        for (const [name, entry] of sourceDerived) {
            targetDerived.set(name, { name, formula: entry.formula, variable: null });
        }
        this.derivedByFile.set(targetId, targetDerived);
    }

    async removeFile(fileId) {
        if (!this.files.has(fileId)) return;

        if (this.plotManager.hasTracesForFile(fileId)) {
            const ok = await Modal.confirm(i18n.t('closeFileWarning'), { icon: '📂' });
            if (!ok) return;
        }

        this.plotManager.removeFile(fileId);
        this.files.delete(fileId);
        this.derivedByFile.delete(fileId);
        this._clearVariableSelection();

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
        this._clearVariableSelection();
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
        document.getElementById('reload-file-menu-btn').disabled = !hasFiles;
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
        this._initOpenFileMenu();

        document.getElementById('toggle-sort').addEventListener('click', (e) => {
            this.sortAlphabetical = !this.sortAlphabetical;
            e.currentTarget.classList.toggle('active', this.sortAlphabetical);
            if (this._currentTree) this._renderFilteredTree();
        });
        document.getElementById('toggle-sort').classList.toggle('active', this.sortAlphabetical);

        document.getElementById('variable-filter').addEventListener('input', (e) => {
            this._filterText = e.target.value.trim().toLowerCase();
            if (this._currentTree) this._renderFilteredTree();
        });

        document.getElementById('expand-all').addEventListener('click',   () => this.expandAllTree());
        document.getElementById('collapse-all').addEventListener('click', () => this.collapseAllTree());

        document.getElementById('derived-help-toggle').addEventListener('click', (e) => {
            e.stopPropagation();
            this._toggleDerivedHelpPopover();
        });
        document.getElementById('derived-toggle').addEventListener('click', () => this._toggleDerivedForm(true));
        document.getElementById('derived-cancel').addEventListener('click', () => this._toggleDerivedForm(false));
        document.getElementById('derived-create').addEventListener('click', () => this.createDerivedVariable());
        document.getElementById('derived-formula').addEventListener('input', (e) => this._updateDerivedSuggestions(e));
        document.getElementById('derived-formula').addEventListener('keydown', (e) => this._handleDerivedFormulaKeydown(e));
        document.getElementById('derived-name').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.createDerivedVariable();
        });
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.derived-formula-wrap')) this._hideDerivedSuggestions();
            if (!e.target.closest('#derived-help-popover') && !e.target.closest('#derived-help-toggle')) {
                this._toggleDerivedHelpPopover(false);
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !document.getElementById('derived-help-popover')?.hidden) {
                e.preventDefault();
                this._toggleDerivedHelpPopover(false);
                return;
            }
            if (e.key === 'Escape' && this.selectedVariables.size > 0) {
                this._clearVariableSelection();
            }
        });

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
        this._initReloadFileMenu();

        this._initExampleMenu();

        document.getElementById('help-btn').addEventListener('click', () => this.showHelp());
    }

    _initOpenFileMenu() {
        const btn  = document.getElementById('open-file-menu-btn');
        const menu = document.getElementById('open-file-menu');
        if (!btn || !menu) return;

        const close = () => {
            menu.hidden = true;
            btn.setAttribute('aria-expanded', 'false');
        };
        const open = () => {
            this._renderOpenFileMenu();
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

        this._closeOpenFileMenu = close;
    }

    _renderOpenFileMenu() {
        const menu = document.getElementById('open-file-menu');
        menu.innerHTML = '';

        const tempItem = document.createElement('button');
        tempItem.className = 'example-menu-item';
        tempItem.type = 'button';
        tempItem.setAttribute('role', 'menuitem');
        tempItem.textContent = i18n.t('openOpenModelicaTemp');
        tempItem.addEventListener('click', () => {
            this._closeOpenFileMenu?.();
            this._copyOpenModelicaTempPathAndOpenPicker();
        });
        menu.appendChild(tempItem);
    }

    _initReloadFileMenu() {
        const btn  = document.getElementById('reload-file-menu-btn');
        const menu = document.getElementById('reload-file-menu');
        if (!btn || !menu) return;

        const close = () => {
            menu.hidden = true;
            btn.setAttribute('aria-expanded', 'false');
        };
        const open = () => {
            this._renderReloadFileMenu();
            menu.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
        };

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (btn.disabled) return;
            menu.hidden ? open() : close();
        });

        document.addEventListener('click', (e) => {
            if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !menu.hidden) close();
        });

        this._closeReloadFileMenu = close;
    }

    _renderReloadFileMenu() {
        const menu = document.getElementById('reload-file-menu');
        menu.innerHTML = '';

        const versionItem = document.createElement('button');
        versionItem.className = 'example-menu-item';
        versionItem.type = 'button';
        versionItem.setAttribute('role', 'menuitem');
        versionItem.textContent = i18n.t('reloadAsNewVersion');
        versionItem.disabled = !this.activeFileId;
        versionItem.addEventListener('click', () => {
            this._closeReloadFileMenu?.();
            this.reloadActiveFileAsNewVersion().catch(err => {
                console.error('Reload as new version failed:', err);
                alert(i18n.t('errorLoading') + ': ' + (err?.message || String(err)));
                this._updateTopBar();
            });
        });
        menu.appendChild(versionItem);
    }

    async _copyOpenModelicaTempPathAndOpenPicker() {
        const candidates = this._getOpenModelicaTempCandidates();
        if (!candidates.length) {
            await Modal.alert(i18n.t('openOpenModelicaTemp'), i18n.t('openModelicaTempNoPath'), { icon: '📁' });
            document.getElementById('file-input').click();
            return;
        }

        const path = candidates[0];
        const copied = await this._copyTextToClipboard(path);
        const messageKey = copied ? 'openModelicaTempPathCopied' : 'openModelicaTempPathCopyFailed';
        await Modal.alert(i18n.t('openOpenModelicaTemp'), i18n.t(messageKey).replace('{path}', path), {
            icon: '📋',
            className: 'modal-dialog-temp-path',
        });

        document.getElementById('file-input').click();
    }

    async _copyTextToClipboard(text) {
        if (navigator.clipboard?.writeText) {
            try {
                await navigator.clipboard.writeText(text);
                return true;
            } catch (_) {}
        }

        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.setAttribute('readonly', '');
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        document.body.appendChild(textArea);
        textArea.select();
        try {
            return document.execCommand('copy');
        } catch (_) {
            return false;
        } finally {
            document.body.removeChild(textArea);
        }
    }

    _getOpenModelicaTempCandidates() {
        const userHome = this._inferWindowsUserHomeFromLocation();
        if (userHome) {
            return [
                `${userHome}\\AppData\\Local\\Temp\\OpenModelica\\OMEdit`,
                `${userHome}\\AppData\\Local\\Temp\\OpenModelica`,
            ];
        }

        const linuxUser = this._inferLinuxUserFromLocation();
        if (linuxUser) {
            return [
                `/tmp/OpenModelica${linuxUser}/OMEdit`,
                `/tmp/OpenModelica${linuxUser}`,
            ];
        }

        return [];
    }

    _inferWindowsUserHomeFromLocation() {
        let path = '';
        try {
            path = decodeURIComponent(window.location.href);
        } catch (_) {
            path = window.location.href;
        }

        const match = path.match(/^file:\/\/\/([A-Za-z]:\/Users\/[^/]+)/i);
        return match ? match[1].replace(/\//g, '\\') : '';
    }

    _inferLinuxUserFromLocation() {
        let path = '';
        try {
            path = decodeURIComponent(window.location.href);
        } catch (_) {
            path = window.location.href;
        }

        const match = path.match(/^file:\/\/\/home\/([^/]+)/i);
        return match ? match[1] : '';
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

            const available = ex.getDataB64() != null || !!ex.script;
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
                    this._setExampleLoading(false);
                    console.error('Example load failed:', err);
                    alert(i18n.t('errorLoading') + ': ' + (err?.message || String(err)));
                });
            });
            menu.appendChild(item);
        }
    }

    async loadExample(exampleId = 'pendulum') {
        if (this._exampleLoading) return;
        const ex = EXAMPLES.find(e => e.id === exampleId);
        if (!ex) throw new Error(`Unknown example: ${exampleId}`);

        if (this.plotManager.hasAnyTraces()) {
            const ok = await Modal.confirm(i18n.t('loadExampleWarning'), { icon: '🎓' });
            if (!ok) return;
        }

        const token = this._setExampleLoading(true, i18n.t(ex.nameKey));
        const isCancelled = () => !token || token.cancelled || this._exampleLoadToken !== token;

        try {
            await this._waitForExampleCancelWindow(token);
            if (isCancelled()) return;

            await this._ensureExampleData(ex);
            if (isCancelled()) return;

            const b64 = ex.getDataB64();
            if (b64 == null) return;

            // Decode embedded base64 data — works with file:// and http:// alike
            const binary = atob(b64);
            const buffer = new ArrayBuffer(binary.length);
            const view   = new Uint8Array(buffer);
            for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);

            const contentHash = await this._hashBuffer(buffer);
            const data   = await this.parser.parse(buffer);
            await this._yieldToBrowser();
            if (isCancelled()) return;

            token.committed = true;
            const baseName   = ex.baseName;
            const existingId = [...this.files.entries()].find(([,e]) => e.name === baseName)?.[0];
            let fileId = existingId;
            if (!fileId) {
                fileId = `f${this._nextFileId++}`;
                this.files.set(fileId, { file: null, buffer, contentHash, name: baseName });
                this.plotManager.addFile(fileId, baseName, data);
            } else {
                this.files.get(fileId).buffer = buffer;
                this.files.get(fileId).contentHash = contentHash;
                this._reapplyDerivedVariables(fileId, data);
                this.plotManager.updateFileData(fileId, data);
            }
            this.plotManager.setActiveFile(fileId);

            const grid = ex.grid || { rows: 2, cols: 2 };

            // Clear plots and build the example layout grid
            this.plotManager.clearAll();
            this.layoutManager.resetToGrid(grid.rows, grid.cols);

            // Wait for panels to mount
            await new Promise(r => setTimeout(r, 50));
            if (isCancelled()) return;

            // Collect panel IDs in DOM order: TL, TR, BL, BR for 2×2 examples,
            // or panelId for single-panel examples.
            const panels = [...document.querySelectorAll('.layout-panel')].map(el => el.dataset.id);
            if (panels.length < grid.rows * grid.cols) return;
            const [tlId, trId, blId, brId] = panels;

            // Set state directly — no addTrace, avoids async race conditions
            ex.applyLayout(this.plotManager, fileId, { panelId: panels[0], panels, tlId, trId, blId, brId });

            document.getElementById('drop-zone').classList.remove('active');
            this._updateTopBar();
            this._renderFilesList();
            this._updateActionButtons();
            this._clearVariableSelection();
            this.renderVariablesTree(data.tree);
        } finally {
            if (this._exampleLoadToken === token) this._setExampleLoading(false);
        }
    }

    _setExampleLoading(loading, exampleName = '') {
        this._exampleLoading = loading;
        const btn = document.getElementById('load-example-btn');
        const fileName = document.getElementById('file-name');
        const message = i18n.t('loadingExample').replace('{name}', exampleName);

        if (loading) {
            const token = { cancelled: false };
            this._exampleLoadToken = token;
            if (btn) btn.disabled = true;
            this._setDropZoneStatus(true, message);
            this._showExampleLoadingOverlay(message, token);
            if (fileName) fileName.textContent = message;
            return token;
        }

        if (this._exampleLoadToken) this._exampleLoadToken.cancelled = true;
        this._exampleLoadToken = null;
        if (btn) btn.disabled = false;
        this._setDropZoneStatus(false);
        this._hideExampleLoadingOverlay();
        if (fileName) {
            if (this.activeFileId) this._updateTopBar();
            else fileName.textContent = '';
        }
        return null;
    }

    _showExampleLoadingOverlay(message, token) {
        this._hideExampleLoadingOverlay();

        const overlay = document.createElement('div');
        overlay.id = 'example-loading-overlay';
        overlay.className = 'example-loading-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-live', 'assertive');

        const dialog = document.createElement('div');
        dialog.className = 'example-loading-dialog';

        const spinner = document.createElement('div');
        spinner.className = 'example-loading-spinner';
        spinner.setAttribute('aria-hidden', 'true');

        const title = document.createElement('div');
        title.className = 'example-loading-title';
        title.textContent = message;

        const hint = document.createElement('div');
        hint.className = 'example-loading-hint';
        hint.textContent = i18n.t('loadingExampleCancelHint');

        dialog.append(spinner, title, hint);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        this._exampleLoadingEscHandler = (e) => {
            if (e.key !== 'Escape' || this._exampleLoadToken !== token) return;
            if (token.committed) return;
            e.preventDefault();
            e.stopPropagation();
            token.cancelled = true;
            this._setExampleLoading(false);
        };
        document.addEventListener('keydown', this._exampleLoadingEscHandler, true);
        requestAnimationFrame(() => overlay.classList.add('show'));
        overlay.tabIndex = -1;
        overlay.focus({ preventScroll: true });
    }

    _hideExampleLoadingOverlay() {
        if (this._exampleLoadingEscHandler) {
            document.removeEventListener('keydown', this._exampleLoadingEscHandler, true);
            this._exampleLoadingEscHandler = null;
        }

        const overlay = document.getElementById('example-loading-overlay');
        if (!overlay) return;
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 220);
    }

    _waitForExampleCancelWindow(token, ms = 450) {
        return new Promise(resolve => {
            const started = performance.now();
            const tick = () => {
                if (!token || token.cancelled || this._exampleLoadToken !== token) {
                    resolve();
                    return;
                }
                if (performance.now() - started >= ms) {
                    resolve();
                    return;
                }
                requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
        });
    }

    _yieldToBrowser() {
        return new Promise(resolve => setTimeout(resolve, 0));
    }

    _setDropZoneStatus(show, message = '') {
        const status = document.getElementById('drop-zone-status');
        if (!status) return;
        status.hidden = !show;
        status.textContent = show ? message : '';
    }

    async _ensureExampleData(example) {
        if (example.getDataB64() != null || !example.script) return;
        await this._loadScriptOnce(example.script);
    }

    _loadScriptOnce(src) {
        if (this._loadedScripts.has(src)) return Promise.resolve();
        if ([...document.scripts].some(s => s.getAttribute('src') === src)) {
            this._loadedScripts.add(src);
            return;
        }
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.onload = () => {
                this._loadedScripts.add(src);
                resolve();
            };
            script.onerror = () => reject(new Error(`Cannot load script: ${src}`));
            document.head.appendChild(script);
        });
    }

    showHelp() {
        const sections = ['1','2','3','4','5','6','7','8'];

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
        const proxy = document.createElement('div');
        proxy.className = 'sidebar-resize-proxy';
        document.body.appendChild(proxy);
        let isResizing = false, startX = 0, startWidth = 0;
        const edgeWidth = 14;

        const updateProxy = () => {
            const rect = sidebar.getBoundingClientRect();
            const hidden = sidebar.classList.contains('hidden') || rect.width < 2;
            proxy.style.display = hidden ? 'none' : '';
            proxy.style.left = `${rect.right - 6}px`;
            proxy.style.top = `${rect.top}px`;
            proxy.style.height = `${rect.height}px`;
        };

        const startResize = (e) => {
            isResizing = true; startX = e.clientX; startWidth = sidebar.offsetWidth;
            handle.classList.add('resizing');
            proxy.classList.add('resizing');
            sidebar.classList.add('resizing');
            document.body.style.cursor = 'ew-resize';
            document.body.style.userSelect = 'none';
            proxy.setPointerCapture?.(e.pointerId);
            e.preventDefault();
        };

        handle.addEventListener('pointerdown', startResize);
        proxy.addEventListener('pointerdown', startResize);

        sidebar.addEventListener('pointerdown', (e) => {
            const rect = sidebar.getBoundingClientRect();
            const nearRightEdge = rect.right - e.clientX <= edgeWidth;
            if (nearRightEdge && !sidebar.classList.contains('hidden')) startResize(e);
        }, true);

        sidebar.addEventListener('pointermove', (e) => {
            if (isResizing || sidebar.classList.contains('hidden')) return;
            const rect = sidebar.getBoundingClientRect();
            sidebar.classList.toggle('resize-ready', rect.right - e.clientX <= edgeWidth);
        });

        document.addEventListener('pointermove', (e) => {
            if (!isResizing) return;
            const w = Math.max(200, Math.min(600, startWidth + e.clientX - startX));
            sidebar.style.width = w + 'px';
            updateProxy();
        });

        document.addEventListener('pointerup', (e) => {
            if (!isResizing) return;
            isResizing = false;
            handle.classList.remove('resizing');
            proxy.classList.remove('resizing');
            sidebar.classList.remove('resizing');
            sidebar.classList.remove('resize-ready');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
            proxy.releasePointerCapture?.(e.pointerId);
            updateProxy();
        });

        window.addEventListener('resize', updateProxy);
        new ResizeObserver(updateProxy).observe(sidebar);
        updateProxy();
    }

    // ─── Variables tree ────────────────────────────────────────────

    // ─── Derived variables ─────────────────────────────────────────

    createDerivedVariable() {
        const fileId = this.activeFileId;
        const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
        const nameInput = document.getElementById('derived-name');
        const formulaInput = document.getElementById('derived-formula');
        const name = nameInput.value.trim();
        const formula = formulaInput.value.trim();

        try {
            if (!data) throw new Error('Load a .mat file first.');
            if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(name)) throw new Error('Use a simple name, for example slip or motor.slip.');
            if (!formula) throw new Error('Enter a formula.');
            const existing = data.variables[name];
            if (existing && !existing.derived) throw new Error(`Variable "${name}" already exists.`);

            const result = this._evaluateDerivedFormula(formula, data);
            const variable = {
                name,
                data: result.values,
                description: `Derived: ${formula}`,
                kind: 'variable',
                dataType: this.parser._detectDataType(result.values, 'variable'),
                isConstant: this.parser._isConstantValues(result.values),
                interpolation: 'linear',
                derived: true,
                formula
            };

            data.variables[name] = variable;
            if (!this.derivedByFile.has(fileId)) this.derivedByFile.set(fileId, new Map());
            this.derivedByFile.get(fileId).set(name, { name, formula, variable });

            this._setDerivedMessage(`Created ${name}`, 'ok');
            nameInput.value = '';
            formulaInput.value = '';
            this._hideDerivedSuggestions();
            this._renderFilteredTree();
            this._toggleDerivedForm(false);
            this._rebuildPlotsUsingVariable(fileId, name);
        } catch (err) {
            this._setDerivedMessage(err?.message || String(err), 'error');
        }
    }

    _evaluateDerivedFormula(formula, data) {
        const timeVar = this._getActiveTimeVar(data);
        if (!timeVar?.data?.length) throw new Error('No time vector found.');
        const tokens = this._tokenizeDerivedFormula(formula, data.variables);
        const ast = this._parseDerivedExpression(tokens);
        const n = timeVar.data.length;
        const evaluated = this._evalDerivedNode(ast, data, n);
        const values = evaluated.kind === 'series' ? evaluated.values : Array.from({ length: n }, () => evaluated.value);
        return { values };
    }

    _tokenizeDerivedFormula(formula, variables) {
        const tokens = [];
        let i = 0;
        while (i < formula.length) {
            const ch = formula[i];
            if (/\s/.test(ch)) { i++; continue; }
            if ('+-*/^(),'.includes(ch)) { tokens.push({ type: ch, value: ch }); i++; continue; }
            if (ch === '`') {
                const end = formula.indexOf('`', i + 1);
                if (end < 0) throw new Error('Missing closing backtick.');
                const name = formula.slice(i + 1, end);
                if (!variables[name]) throw new Error(`Unknown variable "${name}".`);
                tokens.push({ type: 'name', value: name });
                i = end + 1;
                continue;
            }
            if (/\d|\./.test(ch)) {
                const match = formula.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
                if (!match) throw new Error(`Unexpected "." at position ${i + 1}.`);
                tokens.push({ type: 'number', value: Number(match[0]) });
                i += match[0].length;
                continue;
            }
            if (/[A-Za-z_]/.test(ch)) {
                let j = i + 1;
                while (j < formula.length && /[A-Za-z0-9_.\[\]]/.test(formula[j])) j++;
                const name = formula.slice(i, j);
                const nextNonSpace = this._nextNonSpaceChar(formula, j);
                const functionName = this._normalizeDerivedFunctionName(name);
                if (nextNonSpace === '(' && functionName) {
                    tokens.push({ type: 'func', value: functionName });
                    i = j;
                    continue;
                }
                if (!variables[name]) throw new Error(`Unknown variable "${name}".`);
                tokens.push({ type: 'name', value: name });
                i = j;
                continue;
            }
            throw new Error(`Unexpected "${ch}" at position ${i + 1}.`);
        }
        return tokens;
    }

    _nextNonSpaceChar(text, start) {
        let i = start;
        while (i < text.length && /\s/.test(text[i])) i++;
        return text[i] || '';
    }

    _normalizeDerivedFunctionName(name) {
        const lower = String(name).toLowerCase();
        if (DERIVED_FUNCTIONS.some(fn => fn.name === lower)) return lower;
        return DERIVED_FUNCTION_ALIASES.get(lower) || '';
    }

    _parseDerivedExpression(tokens) {
        let pos = 0;
        const peek = () => tokens[pos];
        const take = (type) => (peek()?.type === type ? tokens[pos++] : null);
        const parsePrimary = () => {
            const token = peek();
            if (!token) throw new Error('Unexpected end of formula.');
            if (take('number')) return { type: 'number', value: token.value };
            if (take('name')) return { type: 'name', value: token.value };
            if (take('func')) {
                const name = token.value;
                if (!take('(')) throw new Error(`Missing opening parenthesis after "${name}".`);
                const args = [];
                if (!take(')')) {
                    do {
                        args.push(parseAddSub());
                    } while (take(','));
                    if (!take(')')) throw new Error(`Missing closing parenthesis for "${name}".`);
                }
                return { type: 'func', name, args };
            }
            if (take('(')) {
                const expr = parseAddSub();
                if (!take(')')) throw new Error('Missing closing parenthesis.');
                return expr;
            }
            throw new Error(`Unexpected "${token.value}".`);
        };
        const parsePower = () => {
            let node = parsePrimary();
            if (take('^')) {
                node = { type: 'binary', op: '^', left: node, right: parseUnary() };
            }
            return node;
        };
        const parseUnary = () => {
            if (take('+')) return parseUnary();
            if (take('-')) return { type: 'unary', op: '-', expr: parseUnary() };
            return parsePower();
        };
        const parseMulDiv = () => {
            let node = parseUnary();
            while (peek()?.type === '*' || peek()?.type === '/') {
                const op = tokens[pos++].type;
                node = { type: 'binary', op, left: node, right: parseUnary() };
            }
            return node;
        };
        const parseAddSub = () => {
            let node = parseMulDiv();
            while (peek()?.type === '+' || peek()?.type === '-') {
                const op = tokens[pos++].type;
                node = { type: 'binary', op, left: node, right: parseMulDiv() };
            }
            return node;
        };
        const ast = parseAddSub();
        if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos].value}".`);
        return ast;
    }

    _evalDerivedNode(node, data, n) {
        if (node.type === 'number') return { kind: 'scalar', value: node.value };
        if (node.type === 'name') {
            const variable = data.variables[node.value];
            if (!variable) throw new Error(`Unknown variable "${node.value}".`);
            if (variable.kind === 'parameter' || variable.data.length === 1) return { kind: 'scalar', value: Number(variable.data[0]) };
            if (variable.data.length !== n) throw new Error(`"${node.value}" has ${variable.data.length} points, but time has ${n}.`);
            return { kind: 'series', values: variable.data };
        }
        if (node.type === 'unary') {
            const v = this._evalDerivedNode(node.expr, data, n);
            return v.kind === 'scalar' ? { kind: 'scalar', value: -v.value } : { kind: 'series', values: v.values.map(x => -x) };
        }
        if (node.type === 'func') return this._evalDerivedFunction(node, data, n);
        const left = this._evalDerivedNode(node.left, data, n);
        const right = this._evalDerivedNode(node.right, data, n);
        const apply = (a, b) => {
            switch (node.op) {
                case '+': return a + b;
                case '-': return a - b;
                case '*': return a * b;
                case '/': return a / b;
                case '^': return Math.pow(a, b);
                default: throw new Error(`Unknown operator "${node.op}".`);
            }
        };
        if (left.kind === 'scalar' && right.kind === 'scalar') return { kind: 'scalar', value: apply(left.value, right.value) };
        const values = new Array(n);
        for (let i = 0; i < n; i++) values[i] = apply(left.kind === 'series' ? left.values[i] : left.value, right.kind === 'series' ? right.values[i] : right.value);
        return { kind: 'series', values };
    }

    _evalDerivedFunction(node, data, n) {
        const name = node.name;
        const args = node.args.map(arg => this._evalDerivedNode(arg, data, n));
        const arity = args.length;
        const requireArity = (expected, label = name) => {
            if (arity !== expected) throw new Error(`${label}() expects ${expected} argument${expected === 1 ? '' : 's'}.`);
        };
        const valueAt = (arg, i) => arg.kind === 'series' ? arg.values[i] : arg.value;
        const mapUnary = (fn) => {
            const a = args[0];
            if (a.kind === 'scalar') return { kind: 'scalar', value: fn(a.value) };
            return { kind: 'series', values: a.values.map(fn) };
        };
        const mapBinary = (fn) => {
            const [a, b] = args;
            if (a.kind === 'scalar' && b.kind === 'scalar') return { kind: 'scalar', value: fn(a.value, b.value) };
            const values = new Array(n);
            for (let i = 0; i < n; i++) values[i] = fn(valueAt(a, i), valueAt(b, i));
            return { kind: 'series', values };
        };

        if (name === 'sqrt') {
            requireArity(1, name);
            return mapUnary(v => Math.sqrt(v));
        }
        if (name === 'abs') {
            requireArity(1, name);
            return mapUnary(v => Math.abs(v));
        }
        if (name === 'log') {
            requireArity(1, name);
            return mapUnary(v => Math.log(v));
        }
        if (name === 'log10') {
            requireArity(1, name);
            return mapUnary(v => Math.log10(v));
        }
        if (name === 'square') {
            requireArity(1, name);
            return mapUnary(v => v * v);
        }
        if (name === 'root') {
            requireArity(2, name);
            return mapBinary((v, degree) => this._nthRoot(v, degree));
        }
        if (name === 'power') {
            requireArity(2, name);
            return mapBinary((v, exponent) => Math.pow(v, exponent));
        }
        throw new Error(`Unknown function "${name}".`);
    }

    _nthRoot(value, degree) {
        const d = Number(degree);
        if (!Number.isFinite(d) || d === 0) return NaN;
        const rounded = Math.round(d);
        const isIntegerDegree = Math.abs(d - rounded) <= 1e-12;
        let result;
        if (value < 0 && isIntegerDegree && rounded % 2 !== 0) {
            result = -Math.pow(Math.abs(value), 1 / rounded);
        } else {
            result = Math.pow(value, 1 / d);
        }
        return this._cleanDerivedNumber(result);
    }

    _cleanDerivedNumber(value) {
        if (!Number.isFinite(value)) return value;
        const rounded = Math.round(value);
        const tolerance = Math.max(1, Math.abs(value)) * 1e-12;
        return Math.abs(value - rounded) <= tolerance ? rounded : value;
    }

    _getActiveTimeVar(data) {
        return Object.values(data.variables).find(v => v.kind === 'abscissa') || null;
    }

    _reapplyDerivedVariables(fileId, data) {
        const derived = this.derivedByFile.get(fileId);
        if (!derived) return;
        for (const [name, entry] of derived) {
            try {
                const result = this._evaluateDerivedFormula(entry.formula, data);
                const variable = {
                    name,
                    data: result.values,
                    description: `Derived: ${entry.formula}`,
                    kind: 'variable',
                    dataType: this.parser._detectDataType(result.values, 'variable'),
                    isConstant: this.parser._isConstantValues(result.values),
                    interpolation: 'linear',
                    derived: true,
                    formula: entry.formula
                };
                data.variables[name] = variable;
                entry.variable = variable;
            } catch (err) {
                console.warn(`Could not reapply derived variable ${name}:`, err);
            }
        }
    }

    _removeDerivedVariable(name) {
        const fileId = this.activeFileId;
        const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
        if (!fileId || !data) return;
        this.derivedByFile.get(fileId)?.delete(name);
        delete data.variables[name];
        for (const [panelId, plot] of this.plotManager.plots) {
            const beforeTs = plot.traces.length;
            const beforePh = plot.phaseTraces.length;
            plot.traces = plot.traces.filter(t => !(t.fileId === fileId && t.varName === name));
            plot.phaseTraces = plot.phaseTraces.filter(t => !(t.fileId === fileId && (t.x === name || t.y === name || t.z === name)));
            if (beforeTs !== plot.traces.length || beforePh !== plot.phaseTraces.length) this.plotManager._rebuildPanel(panelId);
        }
        this._renderFilteredTree();
    }

    _rebuildPlotsUsingVariable(fileId, name) {
        for (const [panelId, plot] of this.plotManager.plots) {
            const usesTimeseries = plot.traces.some(t => t.fileId === fileId && t.varName === name);
            const usesPhase = plot.phaseTraces.some(t => t.fileId === fileId && (t.x === name || t.y === name || t.z === name));
            if (usesTimeseries || usesPhase) this.plotManager._rebuildPanel(panelId);
        }
    }

    _toggleDerivedForm(show) {
        const form = document.getElementById('derived-form');
        form.classList.toggle('collapsed', !show);
        if (show) {
            this._scrollDerivedFormIntoView();
            document.getElementById('derived-name').focus();
        }
        else {
            this._setDerivedMessage('', '');
            this._hideDerivedSuggestions();
        }
    }

    _scrollDerivedFormIntoView() {
        const section = document.querySelector('.derived-section');
        const sidebar = document.getElementById('sidebar');
        if (!section || !sidebar) return;
        requestAnimationFrame(() => {
            sidebar.scrollTo({
                top: sidebar.scrollHeight,
                behavior: 'smooth'
            });
        });
    }

    _setDerivedMessage(message, type) {
        const el = document.getElementById('derived-message');
        el.textContent = message;
        el.className = `derived-message${type ? ' ' + type : ''}`;
    }

    _toggleDerivedHelpPopover(show) {
        const popover = document.getElementById('derived-help-popover');
        const button = document.getElementById('derived-help-toggle');
        if (!popover || !button) return;
        const willShow = typeof show === 'boolean' ? show : popover.hidden;
        popover.hidden = !willShow;
        button.classList.toggle('active', willShow);
        button.setAttribute('aria-expanded', String(willShow));
    }

    _getDerivedSuggestions(prefix) {
        const data = this.plotManager.data;
        if (!data || !prefix) return [];
        const needle = prefix.toLowerCase();
        const functionSuggestions = DERIVED_FUNCTIONS
            .filter(fn => fn.name.startsWith(needle))
            .map(fn => ({ type: 'function', name: fn.name, kind: 'fn' }));
        const variableSuggestions = Object.entries(data.variables)
            .map(([name, variable]) => ({ name: variable.name || name, variable }))
            .filter(({ name, variable }) => variable.kind !== 'abscissa' && name.toLowerCase().includes(needle))
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
            .slice(0, Math.max(0, 8 - functionSuggestions.length))
            .map(({ name, variable }) => ({
                type: 'variable',
                name,
                kind: variable.kind === 'parameter' ? 'param' : 'var',
            }));
        return [...functionSuggestions, ...variableSuggestions];
    }

    _updateDerivedSuggestions(e) {
        const input = e.target;
        const left = input.value.slice(0, input.selectionStart);
        const match = left.match(/`?([A-Za-z0-9_.\[\]]*)$/);
        const prefix = match ? match[1] : '';
        const suggestions = this._getDerivedSuggestions(prefix);
        const box = document.getElementById('derived-suggestions');
        box.innerHTML = '';
        this._suggestionIndex = 0;
        if (!suggestions.length) { box.hidden = true; return; }
        for (const suggestion of suggestions) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'derived-suggestion';
            btn.dataset.suggestionType = suggestion.type;
            btn.dataset.suggestionName = suggestion.name;
            const name = document.createElement('span');
            name.className = 'derived-suggestion-name';
            name.textContent = suggestion.name;
            const kind = document.createElement('span');
            kind.className = 'derived-suggestion-kind';
            kind.textContent = suggestion.kind;
            btn.append(name, kind);
            btn.addEventListener('mousedown', (ev) => {
                ev.preventDefault();
                this._insertDerivedSuggestion(suggestion);
            });
            box.appendChild(btn);
        }
        this._markActiveSuggestion();
        this._positionDerivedSuggestions();
        box.hidden = false;
    }

    _handleDerivedFormulaKeydown(e) {
        const box = document.getElementById('derived-suggestions');
        const items = [...box.querySelectorAll('.derived-suggestion')];
        if (!box.hidden && items.length) {
            if (e.key === 'ArrowDown') { e.preventDefault(); this._suggestionIndex = (this._suggestionIndex + 1) % items.length; this._markActiveSuggestion(); return; }
            if (e.key === 'ArrowUp') { e.preventDefault(); this._suggestionIndex = (this._suggestionIndex - 1 + items.length) % items.length; this._markActiveSuggestion(); return; }
            if (e.key === 'Tab' || e.key === 'Enter') {
                e.preventDefault();
                this._insertDerivedSuggestionFromElement(items[this._suggestionIndex]);
                return;
            }
            if (e.key === 'Escape') { this._hideDerivedSuggestions(); return; }
        }
        if (e.key === 'Enter') this.createDerivedVariable();
    }

    _insertDerivedSuggestionFromElement(item) {
        if (!item) return;
        this._insertDerivedSuggestion({
            type: item.dataset.suggestionType,
            name: item.dataset.suggestionName,
        });
    }

    _insertDerivedSuggestion(suggestion) {
        const input = document.getElementById('derived-formula');
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const left = input.value.slice(0, start);
        const right = input.value.slice(end);
        const match = left.match(/`?[A-Za-z0-9_.\[\]]*$/);
        const replaceStart = match ? start - match[0].length : start;
        const name = suggestion?.name || '';
        const isFunction = suggestion?.type === 'function';
        const insert = isFunction
            ? `${name}()`
            : (/^[A-Za-z_][A-Za-z0-9_.\[\]]*$/.test(name) ? name : `\`${name}\``);
        input.value = input.value.slice(0, replaceStart) + insert + right;
        const cursor = replaceStart + insert.length - (isFunction ? 1 : 0);
        input.setSelectionRange(cursor, cursor);
        input.focus();
        this._hideDerivedSuggestions();
    }

    _markActiveSuggestion() {
        const items = [...document.querySelectorAll('#derived-suggestions .derived-suggestion')];
        items.forEach((item, i) => item.classList.toggle('active', i === this._suggestionIndex));
    }

    _hideDerivedSuggestions() {
        const box = document.getElementById('derived-suggestions');
        if (box) box.hidden = true;
    }

    _positionDerivedSuggestions() {
        const input = document.getElementById('derived-formula');
        const box = document.getElementById('derived-suggestions');
        const sidebar = document.getElementById('sidebar');
        if (!input || !box || !sidebar) return;
        const inputRect = input.getBoundingClientRect();
        const sidebarRect = sidebar.getBoundingClientRect();
        const spaceBelow = sidebarRect.bottom - inputRect.bottom;
        const spaceAbove = inputRect.top - sidebarRect.top;
        const openUp = spaceBelow < 170 && spaceAbove > spaceBelow;
        box.classList.toggle('open-up', openUp);
        box.style.maxHeight = `${Math.max(96, Math.min(180, (openUp ? spaceAbove : spaceBelow) - 12))}px`;
    }

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
        this._renderDerivedTreeSection(container, filter, autoExpand);
    }

    _clearVariableSelection() {
        if (!this.selectedVariables || this.selectedVariables.size === 0) return;
        this.selectedVariables.clear();
        this._syncVariableSelectionUI();
    }

    _toggleVariableSelection(varName) {
        if (this.selectedVariables.has(varName)) {
            this.selectedVariables.delete(varName);
        } else {
            this.selectedVariables.add(varName);
        }
        this._syncVariableSelectionUI();
    }

    _syncVariableSelectionUI() {
        document.querySelectorAll('.tree-item[data-var-name]').forEach(item => {
            item.classList.toggle('selected', this.selectedVariables.has(item.dataset.varName));
        });
    }

    _selectedVariableNamesForDrag(varName) {
        if (!this.selectedVariables.has(varName)) return [varName];
        const data = this.activeFileId ? this.plotManager.files.get(this.activeFileId)?.data : null;
        return [...this.selectedVariables].filter(name => data?.variables?.[name]);
    }

    _renderDerivedTreeSection(parentElement, filter, autoExpand) {
        const fileId = this.activeFileId;
        const data = fileId ? this.plotManager.files.get(fileId)?.data : null;
        const entries = Object.entries(data?.variables || {})
            .filter(([, variable]) => variable.derived)
            .filter(([, variable]) => !filter || variable.name.toLowerCase().includes(filter));
        if (!entries.length) return;
        entries.sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));

        const nodeDiv = document.createElement('div');
        nodeDiv.className = 'tree-node';
        const itemDiv = document.createElement('div');
        itemDiv.className = 'tree-item';
        const expanded = true;
        const toggle = document.createElement('span');
        toggle.className = 'tree-toggle' + (expanded ? ' expanded' : '');
        toggle.textContent = '▸';
        const icon = document.createElement('span');
        icon.className = 'tree-icon';
        icon.textContent = 'fx';
        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = i18n.t('derivedVariables');
        const info = document.createElement('span');
        info.className = 'tree-info';
        info.textContent = `(${entries.length})`;
        itemDiv.classList.add('derived-tree-header');
        itemDiv.append(toggle, icon, label, info);

        const childrenDiv = document.createElement('div');
        childrenDiv.className = 'tree-children derived-tree-children' + (expanded ? '' : ' collapsed');
        itemDiv.addEventListener('click', (e) => {
            e.stopPropagation();
            const collapsed = childrenDiv.classList.toggle('collapsed');
            toggle.classList.toggle('expanded', !collapsed);
        });
        this._renderVarLeaves(entries, childrenDiv, { derivedActions: true });
        nodeDiv.append(itemDiv, childrenDiv);
        parentElement.appendChild(nodeDiv);
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

    _renderVarLeaves(entries, parentElement, options = {}) {
        for (const [name, variable] of entries) {
            const nodeDiv = document.createElement('div');
            nodeDiv.className = 'tree-node' + (variable.derived ? ' tree-node-derived' : '');

            const itemDiv = document.createElement('div');
            itemDiv.className = 'tree-item' + (variable.derived ? ' tree-item-derived' : '');
            itemDiv.classList.toggle('selected', this.selectedVariables.has(variable.name));
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
            if (options.derivedActions) {
                const remove = document.createElement('button');
                remove.className = 'tree-derived-remove';
                remove.textContent = 'x';
                remove.title = 'Remove';
                remove.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this._removeDerivedVariable(variable.name);
                });
                remove.addEventListener('dragstart', (e) => e.preventDefault());
                itemDiv.appendChild(remove);
            }

            if (variable.description) {
                const descDiv = document.createElement('div');
                descDiv.className = 'tree-description' + (this.showDescriptions ? ' show' : '');
                descDiv.textContent = variable.description;
                nodeDiv.append(itemDiv, descDiv);
            } else {
                nodeDiv.appendChild(itemDiv);
            }

            itemDiv.addEventListener('click', (e) => {
                if (e.target.closest('.tree-derived-remove')) return;
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    this._toggleVariableSelection(variable.name);
                } else if (this.selectedVariables.size > 0) {
                    this._clearVariableSelection();
                }
            });
            itemDiv.addEventListener('dragstart', (e) => {
                const varNames = this._selectedVariableNamesForDrag(variable.name);
                e.dataTransfer.setData('application/x-openmodelica-variables', JSON.stringify({
                    type: 'variables',
                    names: varNames,
                }));
                e.dataTransfer.setData('text/plain', varNames[0] || variable.name);
                e.dataTransfer.effectAllowed = 'copy';
                document.querySelectorAll('.tree-item.selected').forEach(item => item.classList.add('dragging'));
                itemDiv.classList.add('dragging');
            });
            itemDiv.addEventListener('dragend', () => {
                document.querySelectorAll('.tree-item.dragging').forEach(item => item.classList.remove('dragging'));
            });

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

document.addEventListener('DOMContentLoaded', () => { window.app = new OpenModelicaViewer(); });
