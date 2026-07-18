import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';

export function transposeMatrixSeries(series) {
    if (!Array.isArray(series) || !series.length) return [];
    const sampleLength = series[0]?.length || 0;
    if (!sampleLength || series.some(values => values?.length !== sampleLength)) return [];
    return Array.from({ length: sampleLength }, (_, sample) =>
        Float64Array.from(series, values => values[sample]));
}

export function installTreeMethods(TargetClass) {
    const proto = TargetClass.prototype;
proto.renderVariablesTree = function(tree) {
    this._currentTree = tree;
    if (!tree) {
        const container = document.getElementById('variables-tree');
        if (container) container.innerHTML = '';
        this._syncDataTools?.();
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
    this._syncDataTools?.();
};

proto._clearVariableSelection = function() {
    if (!this.selectedVariables || this.selectedVariables.size === 0) return;
    this.selectedVariables.clear();
    this._syncVariableSelectionUI();
};

proto._retainVariableSelectionForData = function(data) {
    if (!this.selectedVariables || this.selectedVariables.size === 0) return;
    const variables = data?.variables || {};
    let changed = false;
    for (const name of [...this.selectedVariables]) {
        if (!variables[name]) {
            this.selectedVariables.delete(name);
            changed = true;
        }
    }
    if (changed) this._syncVariableSelectionUI();
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
        return variable && variable.plottable !== false && variable.dataType !== 'string';
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
proto._variableMatchesFilter = function(name, variable, filter) {
    if (!filter) return true;
    const haystack = [
        name,
        variable?.name,
        variable?.displayName,
        variable?.description,
        variable?.pypsa?.component,
        variable?.pypsa?.asset,
        variable?.pypsa?.attribute,
    ];
    return haystack.some(value => String(value || '').toLowerCase().includes(filter));
};

proto._nodeMatchesFilter = function(node, filter) {
    if (!filter) return true;
    for (const [name, variable] of Object.entries(node._variables || {})) {
        if (this._variableMatchesFilter(name, variable, filter)) return true;
    }
    for (const child of Object.values(node._children || {})) {
        if (this._nodeMatchesFilter(child, filter)) return true;
    }
    return false;
};

proto._transposeMatlabMatrixNode = async function(node) {
    const matrix = node?._matlabMatrix;
    const fileId = this.activeFileId;
    const fileEntry = fileId ? this.plotManager?.files?.get(fileId) : null;
    const data = fileEntry?.data;
    if (!matrix || !data) return false;

    const oldEntries = Object.entries(data.variables || {})
        .filter(([, variable]) => variable?.matlab?.path === matrix.path && variable.kind === 'variable');
    if (!oldEntries.length || oldEntries.some(([, variable]) => !variable.independentIndex)) return false;

    const oldNames = new Set(oldEntries.map(([name]) => name));
    const removedNames = new Set(oldNames);
    const derived = this.derivedByFile?.get(fileId);
    if (derived) {
        let changed = true;
        while (changed) {
            changed = false;
            for (const [name, entry] of derived) {
                if (removedNames.has(name)) continue;
                let dependencies = [];
                try {
                    dependencies = this._tokenizeDerivedFormula(entry.formula, data.variables)
                        .filter(token => token.type === 'name')
                        .map(token => token.value);
                } catch (_) {
                    dependencies = [...removedNames].filter(variableName => String(entry.formula || '').includes(variableName));
                }
                if (dependencies.some(dependency => removedNames.has(dependency))) {
                    removedNames.add(name);
                    changed = true;
                }
            }
        }
    }

    const plotUsesMatrix = [...(this.plotManager?.plots?.values?.() || [])].some(plot =>
        (plot.traces || []).some(trace => trace.fileId === fileId && removedNames.has(trace.varName))
        || (plot.phaseTraces || []).some(trace => trace.fileId === fileId
            && [trace.x, trace.y, trace.z].some(name => removedNames.has(name)))
        || (plot.stateSlots?.fileId === fileId
            && [...(plot.stateSlots.x || []), ...(plot.stateSlots.dx || [])].some(name => removedNames.has(name))));
    const hasDependentDerived = [...removedNames].some(name => !oldNames.has(name));
    if (plotUsesMatrix || hasDependentDerived) {
        const confirmed = await Modal.confirm(
            i18n.t('matlabMatrixTransposeConfirm').replace('{matrix}', matrix.path),
            { icon: '↔', title: i18n.t('matlabMatrixTranspose') },
        );
        if (!confirmed) return false;
    }

    const originalShape = [...matrix.shape];
    const currentOrientation = matrix.orientation || oldEntries[0][1].matlab?.sampleAxisMode || 'rows';
    const nextOrientation = currentOrientation === 'columns' ? 'rows' : 'columns';
    const nextDisplayShape = currentOrientation === 'columns'
        ? [...originalShape]
        : [originalShape[1], originalShape[0]];
    const complex = oldEntries.some(([, variable]) => variable.matlab?.complex);
    const seriesIndex = name => Number(name.match(/\[(\d+)\](?:\.(?:real|imag))?$/)?.[1] || 0);
    const componentEntries = component => oldEntries
        .filter(([name]) => complex
            ? name.endsWith(`.${component}`)
            : component === 'real' && !name.endsWith('.imag'))
        .sort((left, right) => seriesIndex(left[0]) - seriesIndex(right[0]));
    const matrixName = String(matrix.path || '').replace(/\//g, '.');
    const newVariables = new Map();

    for (const component of complex ? ['real', 'imag'] : ['real']) {
        const sourceEntries = componentEntries(component);
        if (!sourceEntries.length) continue;
        const transposed = transposeMatrixSeries(sourceEntries.map(([, variable]) => variable.data));
        if (!transposed.length) return false;
        const template = sourceEntries[0][1];
        transposed.forEach((values, index) => {
            const name = `${matrixName}[${index + 1}]${complex ? `.${component}` : ''}`;
            const variable = {
                ...template,
                name,
                data: values,
                dataType: this.parser._detectDataType(values, 'variable'),
                isConstant: this.parser._isConstantValues(values),
                sampleIndexLength: values.length,
                dataToolModified: false,
                matlab: {
                    ...template.matlab,
                    sampleAxisMode: nextOrientation,
                    displayShape: [...nextDisplayShape],
                },
            };
            newVariables.set(name, variable);
        });
    }

    for (const name of removedNames) {
        delete data.variables[name];
        derived?.delete(name);
        this.selectedVariables?.delete(name);
        fileEntry.invertedVariables?.delete(name);
    }
    for (const [name, variable] of newVariables) data.variables[name] = variable;

    node._variables = {};
    for (const [name, variable] of newVariables) {
        const suffix = name.startsWith(matrixName) ? name.slice(matrixName.length).replace(/^\./, '') : name;
        node._variables[suffix] = variable;
    }
    matrix.orientation = nextOrientation;
    matrix.displayShape = [...nextDisplayShape];
    node._info = `(${nextDisplayShape.join(' × ')})`;

    data.metadata.matlab ||= {};
    data.metadata.matlab.matrixOrientations ||= {};
    data.metadata.matlab.matrixOrientations[matrix.path] = nextOrientation;
    const sourceEntry = this.files?.get(fileId);
    if (sourceEntry) sourceEntry.matlab = {
        ...(sourceEntry.matlab || {}),
        ...data.metadata.matlab,
        matrixOrientations: { ...data.metadata.matlab.matrixOrientations },
    };
    const syntheticIndex = Object.values(data.variables).find(variable => variable.syntheticIndex);
    if (syntheticIndex) {
        const longest = Math.max(1, ...Object.values(data.variables)
            .filter(variable => variable.independentIndex && variable.kind === 'variable')
            .map(variable => variable.data?.length || 0));
        syntheticIndex.data = Float64Array.from({ length: longest }, (_, index) => index);
        data.metadata.numTimesteps = longest;
        data.metadata.timeStart = 0;
        data.metadata.timeEnd = longest - 1;
    }
    data.metadata.numVariables = Object.keys(data.variables).length;
    data.metadata.numTimevarying = Object.values(data.variables)
        .filter(variable => variable.kind === 'variable').length;
    fileEntry._transformCache = null;

    for (const [panelId, plot] of this.plotManager.plots) {
        const beforeTraces = plot.traces.length;
        const beforePhase = plot.phaseTraces.length;
        plot.traces = plot.traces.filter(trace => !(trace.fileId === fileId && removedNames.has(trace.varName)));
        plot.phaseTraces = plot.phaseTraces.filter(trace => !(trace.fileId === fileId
            && [trace.x, trace.y, trace.z].some(name => removedNames.has(name))));
        let stateChanged = false;
        if (plot.stateSlots?.fileId === fileId
            && [...(plot.stateSlots.x || []), ...(plot.stateSlots.dx || [])].some(name => removedNames.has(name))) {
            plot.stateSlots = { x: [], dx: [], fileId: null };
            stateChanged = true;
        }
        if (plot.phasePending?.fileId === fileId
            && [plot.phasePending.x, plot.phasePending.y, plot.phasePending.z].some(name => removedNames.has(name))) {
            plot.phasePending = { x: null, y: null, z: null, fileId: null };
            stateChanged = true;
        }
        if (beforeTraces !== plot.traces.length || beforePhase !== plot.phaseTraces.length || stateChanged) {
            this.plotManager._rebuildPanel(panelId);
        }
    }

    this._currentTree = data.tree;
    return true;
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
        allVarEntries = allVarEntries.filter(([name, v]) => this._variableMatchesFilter(name, v, filter));
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
        info.textContent = child._info || `(${this.parser.countVariables(child)})`;

        itemDiv.append(toggle, icon, label, info);
        const canTransposeMatrix = child._matlabMatrix
            && Object.values(child._variables || {}).some(variable => variable.independentIndex);
        if (canTransposeMatrix) {
            const transpose = document.createElement('button');
            transpose.type = 'button';
            transpose.className = 'tree-matrix-transpose';
            transpose.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 8 3 12l4 4M3 12h18M17 8l4 4-4 4"/></svg>';
            transpose.title = i18n.t('matlabMatrixTranspose');
            transpose.setAttribute('aria-label', `${i18n.t('matlabMatrixTranspose')}: ${name}`);
            transpose.addEventListener('click', async event => {
                event.preventDefault();
                event.stopPropagation();
                if (transpose.disabled) return;
                transpose.disabled = true;
                try {
                    const changed = await this._transposeMatlabMatrixNode(child);
                    if (changed) {
                        info.textContent = child._info || `(${this.parser.countVariables(child)})`;
                        childrenDiv.replaceChildren();
                        this._renderTreeNode(child, childrenDiv, level + 1, filter, false);
                    }
                } finally {
                    transpose.disabled = false;
                }
            });
            itemDiv.appendChild(transpose);
        }

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

proto._syncVariableSignToggle = function(button, inverted) {
    if (!button) return;
    button.classList.toggle('active', inverted);
    button.innerHTML = inverted
        ? '<svg viewBox="0 0 20 14" aria-hidden="true"><path d="M5 7h10"/></svg>'
        : '<svg viewBox="0 0 20 14" aria-hidden="true"><path d="M6.5 5h7M10 1.5v7M6.5 12.5h7"/></svg>';
    button.title = i18n.t(inverted ? 'variableSignRestore' : 'variableSignInvert');
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(inverted));
};

proto._renderVarLeaves = function(entries, parentElement, options = {}) {
    for (const [name, variable] of entries) {
        const nodeDiv = document.createElement('div');
        nodeDiv.className = 'tree-node' + (variable.derived ? ' tree-node-derived' : '');

        const itemDiv = document.createElement('div');
        itemDiv.className = 'tree-item' + (variable.derived ? ' tree-item-derived' : '');
        itemDiv.classList.toggle('tree-item-modified', !!variable.dataToolModified);
        itemDiv.classList.toggle('selected', this.selectedVariables.has(variable.name));
        const canPlot = variable.plottable !== false && variable.dataType !== 'string';
        itemDiv.classList.toggle('tree-item-nonplottable', !canPlot);
        itemDiv.setAttribute('draggable', canPlot ? 'true' : 'false');
        itemDiv.setAttribute('data-var-name', variable.name);

        const spacer = document.createElement('span');
        spacer.className = 'tree-toggle';

        const icon  = document.createElement('span');
        icon.className = 'tree-icon';
        icon.textContent = this.parser.getVariableIcon(variable);

        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = variable.dataToolModified ? `${name} ${i18n.t('outlierModifiedSuffix')}` : name;
        label.title = variable.description || name;

        const info = document.createElement('span');
        info.className = 'tree-info';
        info.textContent = this.parser.getVariableInfo(variable);

        itemDiv.append(spacer, icon, label, info);
        if (canPlot && variable.kind !== 'abscissa') {
            const inverted = this.plotManager.isVariableSignInverted(this.activeFileId, variable.name);
            const signToggle = document.createElement('button');
            signToggle.type = 'button';
            signToggle.className = 'tree-sign-toggle';
            this._syncVariableSignToggle(signToggle, inverted);
            signToggle.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const currentInverted = this.plotManager.isVariableSignInverted(this.activeFileId, variable.name);
                this.plotManager.setVariableSignInverted(this.activeFileId, variable.name, !currentInverted);
                const nextInverted = this.plotManager.isVariableSignInverted(this.activeFileId, variable.name);
                this._syncVariableSignToggle(signToggle, nextInverted);
            });
            signToggle.addEventListener('dragstart', event => event.preventDefault());
            itemDiv.appendChild(signToggle);
        }
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
            if (e.target.closest('.tree-derived-remove, .tree-sign-toggle')) return;
            if (!canPlot) {
                if (this.selectedVariables.size > 0) this._clearVariableSelection();
                return;
            }
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
