import i18n from '../../i18n/index.js';

export function installTreeMethods(TargetClass) {
    const proto = TargetClass.prototype;
proto.renderVariablesTree = function(tree) {
    this._currentTree = tree;
    if (!tree) {
        const container = document.getElementById('variables-tree');
        if (container) container.innerHTML = '';
        return;
    }
    this._renderFilteredTree();
};

proto._renderFilteredTree = function() {
    const container = document.getElementById('variables-tree');
    container.innerHTML = '';
    const filter = this._filterText;
    const autoExpand = filter.length > 0;
    this._renderTreeNode(this._currentTree, container, 0, filter, autoExpand);
    this._renderDerivedTreeSection(container, filter, autoExpand);
};

proto._clearVariableSelection = function() {
    if (!this.selectedVariables || this.selectedVariables.size === 0) return;
    this.selectedVariables.clear();
    this._syncVariableSelectionUI();
};

proto._toggleVariableSelection = function(varName) {
    if (this.selectedVariables.has(varName)) {
        this.selectedVariables.delete(varName);
    } else {
        this.selectedVariables.add(varName);
    }
    this._syncVariableSelectionUI();
};

proto._syncVariableSelectionUI = function() {
    document.querySelectorAll('.tree-item[data-var-name]').forEach(item => {
        item.classList.toggle('selected', this.selectedVariables.has(item.dataset.varName));
    });
};

proto._selectedVariableNamesForDrag = function(varName) {
    if (!this.selectedVariables.has(varName)) return [varName];
    const data = this.activeFileId ? this.plotManager.files.get(this.activeFileId)?.data : null;
    return [...this.selectedVariables].filter(name => {
        const variable = data?.variables?.[name];
        return variable && variable.dataType !== 'string';
    });
};

proto._renderDerivedTreeSection = function(parentElement, filter, autoExpand) {
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
};

/**
 * Check if a tree node (or any descendant) contains a variable whose
 * full name matches the filter text (substring, case-insensitive).
 */
proto._nodeMatchesFilter = function(node, filter) {
    if (!filter) return true;
    for (const variable of Object.values(node._variables || {})) {
        if (variable.name.toLowerCase().includes(filter)) return true;
    }
    for (const child of Object.values(node._children || {})) {
        if (this._nodeMatchesFilter(child, filter)) return true;
    }
    return false;
};

proto._renderTreeNode = function(node, parentElement, level, filter, autoExpand) {
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
};

proto._renderVarLeaves = function(entries, parentElement, options = {}) {
    for (const [name, variable] of entries) {
        const nodeDiv = document.createElement('div');
        nodeDiv.className = 'tree-node' + (variable.derived ? ' tree-node-derived' : '');

        const itemDiv = document.createElement('div');
        itemDiv.className = 'tree-item' + (variable.derived ? ' tree-item-derived' : '');
        itemDiv.classList.toggle('selected', this.selectedVariables.has(variable.name));
        const canPlot = variable.dataType !== 'string';
        itemDiv.setAttribute('draggable', canPlot ? 'true' : 'false');
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
            if (!canPlot) {
                e.preventDefault();
                return;
            }
            const varNames = this._selectedVariableNamesForDrag(variable.name);
            if (!varNames.length) {
                e.preventDefault();
                return;
            }
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
};

proto.toggleDescriptions = function(show) {
    document.querySelectorAll('.tree-description').forEach(d => d.classList.toggle('show', show));
};

proto.expandAllTree = function() {
    document.querySelectorAll('.tree-children').forEach(d => d.classList.remove('collapsed'));
    document.querySelectorAll('.tree-toggle').forEach(t => { if (t.textContent === '▸') t.classList.add('expanded'); });
};

proto.collapseAllTree = function() {
    document.querySelectorAll('.tree-children').forEach(d => d.classList.add('collapsed'));
    document.querySelectorAll('.tree-toggle').forEach(t => t.classList.remove('expanded'));
};

}
