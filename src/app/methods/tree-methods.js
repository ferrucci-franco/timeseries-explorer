import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';
import { namesBetween } from '../../utils/selection-range.js';
import { installTouchDragSource, isTouchCapable } from '../../ui/touch-drag.js';

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
    this._renderDerivedDatasetsSection(container, filter, autoExpand);
    this._syncDataTools?.();
};

proto._clearVariableSelection = function() {
    // The anchor goes even when the set was already empty: it is the one thing
    // that outlives a cleared selection, and a range starting from a variable
    // the user last touched three files ago is not a range they asked for.
    this._selectionAnchor = null;
    if (!this.selectedVariables || this.selectedVariables.size === 0) return;
    this.selectedVariables.clear();
    this._syncVariableSelectionUI();
};

proto._retainVariableSelectionForData = function(data) {
    const present = data?.variables || {};
    if (this._selectionAnchor && !present[this._selectionAnchor]) this._selectionAnchor = null;
    if (!this.selectedVariables || this.selectedVariables.size === 0) return;
    const variables = present;
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
    // Every click that is not a Shift+click sets where the next range starts.
    this._selectionAnchor = varName;
    this._syncVariableSelectionUI();
};

// The selectable leaves, in the order they are shown.
//
// Read from the DOM rather than from the data, because "contiguous" is a
// question about what the user is looking at: the tree's own order, with
// collapsed groups and filtered-out variables absent. `offsetParent` is null
// for anything inside a `display: none` ancestor, which is what a collapsed
// group is.
//
// The selector is the one _syncVariableSelectionUI uses — active file only, no
// foreign leaves — plus the class that marks a leaf Ctrl+click would refuse.
proto._visibleSelectableVariableNames = function() {
    return [...document.querySelectorAll(
        '.tree-item[data-var-name]:not([data-file-id]):not(.tree-item-nonplottable)')]
        .filter(item => item.offsetParent !== null)
        .map(item => item.dataset.varName);
};

// Shift+click: everything from the anchor to here. The anchor stays where it
// is, so a second Shift+click re-ranges from the same starting point instead
// of walking away from it — that is what makes "click, shift-click, shift-click
// a bit further" behave the way it does everywhere else.
proto._selectVariableRange = function(varName, { add = false } = {}) {
    const range = namesBetween(this._visibleSelectableVariableNames(), this._selectionAnchor, varName);
    if (!range.length) return;
    if (!add) this.selectedVariables.clear();
    for (const name of range) this.selectedVariables.add(name);
    // No anchor yet (a Shift+click out of nowhere): this click becomes one, so
    // the next Shift+click has somewhere to range from.
    if (!this._selectionAnchor) this._selectionAnchor = varName;
    this._syncVariableSelectionUI();
};

proto._syncVariableSelectionUI = function() {
    // Selection is a set of names of the ACTIVE file; a dataset's leaf (drawn in
    // its source's tree, carrying its own file id) is never part of it.
    document.querySelectorAll('.tree-item[data-var-name]:not([data-file-id])').forEach(item => {
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
        .filter(([, variable]) => variable.derived && !variable.previewOnly)
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

// The datasets derived from the active file — a resample, say — each with its
// variables ready to drag onto a panel, and the three things one does with a
// dataset: edit its recipe, save it to disk, close it. The variables belong to
// ANOTHER file (the dataset has its own axis), which is why every leaf here
// carries the dataset's file id.
proto._renderDerivedDatasetsSection = function(parentElement, filter, autoExpand) {
    const fileId = this.activeFileId;
    const datasets = fileId ? (this._derivedDatasetsOf?.(fileId) || []) : [];
    if (!datasets.length) return;

    const items = [];
    for (const [datasetId, entry] of datasets) {
        const data = this.plotManager.files.get(datasetId)?.data;
        const entries = Object.entries(data?.variables || {})
            .filter(([, variable]) => !variable?.previewOnly)
            .filter(([name, variable]) => this._variableMatchesFilter(name, variable, filter));
        const nameMatches = !filter || String(entry.name || '').toLowerCase().includes(filter);
        if (!entries.length && !nameMatches) continue;
        items.push({ datasetId, entry, entries });
    }
    if (!items.length) return;

    const familyDiv = document.createElement('div');
    familyDiv.className = 'tree-node';
    const familyItem = document.createElement('div');
    familyItem.className = 'tree-item derived-tree-header derived-datasets-header';
    const familyToggle = document.createElement('span');
    familyToggle.className = 'tree-toggle expanded';
    familyToggle.textContent = '▸';
    const familyIcon = document.createElement('span');
    familyIcon.className = 'tree-icon';
    familyIcon.textContent = '▤';
    const familyLabel = document.createElement('span');
    familyLabel.className = 'tree-label';
    familyLabel.textContent = i18n.t('derivedDatasets');
    const familyInfo = document.createElement('span');
    familyInfo.className = 'tree-info';
    familyInfo.textContent = `(${items.length})`;
    familyItem.append(familyToggle, familyIcon, familyLabel, familyInfo);
    const familyChildren = document.createElement('div');
    familyChildren.className = 'tree-children derived-tree-children';
    familyItem.addEventListener('click', (e) => {
        e.stopPropagation();
        const collapsed = familyChildren.classList.toggle('collapsed');
        familyToggle.classList.toggle('expanded', !collapsed);
    });

    for (const { datasetId, entry, entries } of items) {
        const nodeDiv = document.createElement('div');
        nodeDiv.className = 'tree-node';
        const itemDiv = document.createElement('div');
        itemDiv.className = 'tree-item derived-dataset-item';
        itemDiv.dataset.datasetId = datasetId;
        const toggle = document.createElement('span');
        toggle.className = 'tree-toggle' + (autoExpand ? ' expanded' : '');
        toggle.textContent = '▸';
        const icon = document.createElement('span');
        icon.className = 'tree-icon';
        icon.textContent = '▤';
        const label = document.createElement('span');
        label.className = 'tree-label';
        label.textContent = this._fileDisplayName(entry);
        label.title = this._derivedDatasetDescription?.(entry.derivedDataset) || '';
        const info = document.createElement('span');
        info.className = 'tree-info';
        info.textContent = `(${entries.length})`;
        itemDiv.append(toggle, icon, label, info);

        const action = (className, html, titleKey, handler) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `tree-dataset-action ${className}`;
            button.innerHTML = html;
            button.title = i18n.t(titleKey);
            button.setAttribute('aria-label', `${i18n.t(titleKey)}: ${entry.name}`);
            button.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                handler();
            });
            button.addEventListener('dragstart', e => e.preventDefault());
            return button;
        };
        // One button, as on a derived variable's leaf. Editing lives in the
        // Transformations table and saving in the files list: a second copy of
        // either here was one more place to look for the same thing.
        itemDiv.appendChild(action('tree-dataset-remove', 'x', 'derivedDatasetRemoveTitle', () => this._removeDerivedDataset(datasetId)));

        const childrenDiv = document.createElement('div');
        childrenDiv.className = 'tree-children' + (autoExpand ? '' : ' collapsed');
        itemDiv.addEventListener('click', (e) => {
            e.stopPropagation();
            const collapsed = childrenDiv.classList.toggle('collapsed');
            toggle.classList.toggle('expanded', !collapsed);
        });
        this._renderVarLeaves(entries, childrenDiv, { fileId: datasetId });
        nodeDiv.append(itemDiv, childrenDiv);
        familyChildren.appendChild(nodeDiv);
    }

    familyDiv.append(familyItem, familyChildren);
    parentElement.appendChild(familyDiv);
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
    // Leaves of a derived dataset live in another file than the tree they are
    // drawn in; everything file-specific below reads this id, not the active one.
    const leafFileId = options.fileId || this.activeFileId;
    const foreign = !!options.fileId && options.fileId !== this.activeFileId;
    for (const [name, variable] of entries) {
        const nodeDiv = document.createElement('div');
        nodeDiv.className = 'tree-node' + (variable.derived ? ' tree-node-derived' : '');

        const itemDiv = document.createElement('div');
        itemDiv.className = 'tree-item' + (variable.derived ? ' tree-item-derived' : '');
        itemDiv.classList.toggle('tree-item-modified', !!variable.dataToolModified);
        itemDiv.classList.toggle('selected', !foreign && this.selectedVariables.has(variable.name));
        const canPlot = variable.plottable !== false && variable.dataType !== 'string';
        itemDiv.classList.toggle('tree-item-nonplottable', !canPlot);
        itemDiv.setAttribute('draggable', canPlot ? 'true' : 'false');
        itemDiv.setAttribute('data-var-name', variable.name);
        if (foreign) itemDiv.setAttribute('data-file-id', leafFileId);

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
        // The "[N pts]" prefix gets its own span, so the sidebar's point-count
        // toggle can hide it and leave the unit and type in view.
        const infoText = this.parser.getVariableInfo(variable);
        const countMatch = /^\[\d+ pts\]/.exec(infoText);
        if (countMatch) {
            const count = document.createElement('span');
            count.className = 'tree-info-count';
            count.textContent = countMatch[0];
            info.append(count, infoText.slice(countMatch[0].length));
        } else {
            info.textContent = infoText;
        }

        itemDiv.append(spacer, icon, label, info);
        if (canPlot && variable.kind !== 'abscissa') {
            const inverted = this.plotManager.isVariableSignInverted(leafFileId, variable.name);
            const signToggle = document.createElement('button');
            signToggle.type = 'button';
            signToggle.className = 'tree-sign-toggle';
            this._syncVariableSignToggle(signToggle, inverted);
            signToggle.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const currentInverted = this.plotManager.isVariableSignInverted(leafFileId, variable.name);
                this.plotManager.setVariableSignInverted(leafFileId, variable.name, !currentInverted);
                const nextInverted = this.plotManager.isVariableSignInverted(leafFileId, variable.name);
                this._syncVariableSignToggle(signToggle, nextInverted);
            });
            signToggle.addEventListener('dragstart', event => event.preventDefault());
            itemDiv.appendChild(signToggle);
        }
        if (variable.kind === 'abscissa') {
            // The time-axis row is the one place a user looks when thinking about
            // time, so it carries the shortcut to the inspector — same dialog the
            // file's "Time axis" panel opens.
            const inspect = document.createElement('button');
            inspect.type = 'button';
            inspect.className = 'tree-time-axis-inspect';
            inspect.textContent = '🕐';
            inspect.title = i18n.t('timeAxisInspectButton');
            inspect.setAttribute('aria-label', i18n.t('timeAxisInspectButton'));
            inspect.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this._openTimeAxisInspector(leafFileId);
            });
            inspect.addEventListener('dragstart', event => event.preventDefault());
            itemDiv.appendChild(inspect);
        }
        // A formula variable (not a Data Tools output or a time-axis signal,
        // which share this section) is edited in the formula form.
        const formulaEntry = options.derivedActions
            ? this.derivedByFile?.get(leafFileId)?.get(variable.name)
            : null;
        const editFormula = formulaEntry?.formula
            ? (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._editDerivedVariable(variable.name);
            }
            : null;
        if (editFormula) {
            const edit = document.createElement('button');
            edit.type = 'button';
            edit.className = 'tree-derived-edit';
            edit.textContent = '✎';
            edit.title = i18n.t('derivedEdit');
            edit.setAttribute('aria-label', i18n.t('derivedEdit'));
            edit.addEventListener('click', editFormula);
            edit.addEventListener('dragstart', (e) => e.preventDefault());
            itemDiv.appendChild(edit);
        }
        if (options.derivedActions) {
            const remove = document.createElement('button');
            remove.className = 'tree-derived-remove';
            remove.type = 'button';
            // The multiplication sign, not the letter: an "x" sits on the text
            // baseline and reads low in the square button.
            remove.textContent = '×';
            remove.title = i18n.t('derivedDeleteTitle');
            remove.setAttribute('aria-label', i18n.t('derivedDeleteTitle'));
            remove.addEventListener('click', (e) => {
                e.stopPropagation();
                void this._removeDerivedVariable(variable.name);
            });
            remove.addEventListener('dragstart', (e) => e.preventDefault());
            itemDiv.appendChild(remove);
        }

        // A Data Tools output shares this section with the formulas, so it says
        // where it came from; its recipe is edited in the Data Tools panel.
        const toolOutput = options.derivedActions && !formulaEntry?.formula
            && !!this.dataToolVariablesByFile?.get(leafFileId)?.get(variable.name);
        if (editFormula) {
            // The formula is what a derived variable IS, so it is always on show
            // under the name rather than tucked into a tooltip — and it is read
            // from the registry, which a rename of an operand rewrites. Read-only:
            // editing goes through the ✎ button, never a stray click on the text.
            const formulaDiv = document.createElement('div');
            formulaDiv.className = 'tree-description tree-derived-formula show';
            formulaDiv.textContent = `= ${formulaEntry.formula}`;
            formulaDiv.title = formulaEntry.formula;
            nodeDiv.append(itemDiv, formulaDiv);
        } else if (toolOutput) {
            const originDiv = document.createElement('div');
            originDiv.className = 'tree-description tree-derived-origin show';
            originDiv.textContent = i18n.t('derivedFromDataTools');
            // The full recipe, for whoever wants it.
            if (variable.description) originDiv.title = variable.description;
            nodeDiv.append(itemDiv, originDiv);
        } else if (variable.description) {
            const descDiv = document.createElement('div');
            descDiv.className = 'tree-description' + (this.showDescriptions ? ' show' : '');
            descDiv.textContent = variable.description;
            nodeDiv.append(itemDiv, descDiv);
        } else {
            nodeDiv.appendChild(itemDiv);
        }

        itemDiv.addEventListener('click', (e) => {
            if (e.target.closest('.tree-derived-remove, .tree-derived-edit, .tree-sign-toggle')) return;
            if (!canPlot) {
                if (this.selectedVariables.size > 0) this._clearVariableSelection();
                return;
            }
            // Multi-selection is a set of names of the active file. A foreign leaf
            // is dragged on its own; it neither joins nor clears that set.
            if (foreign) return;
            if (e.shiftKey) {
                // Shift+click extends the browser's own text selection, which
                // would streak the sidebar blue behind the range.
                e.preventDefault();
                window.getSelection?.()?.removeAllRanges();
                this._selectVariableRange(variable.name, { add: e.ctrlKey || e.metaKey });
            } else if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                this._toggleVariableSelection(variable.name);
            } else if (this.selectedVariables.size > 0) {
                this._clearVariableSelection();
            } else {
                // A plain click on an empty selection selects nothing, as
                // before — but it is still where a following Shift+click
                // should range from.
                this._selectionAnchor = variable.name;
            }
        });
        itemDiv.addEventListener('dragstart', (e) => {
            if (!canPlot) {
                e.preventDefault();
                return;
            }
            const varNames = foreign ? [variable.name] : this._selectedVariableNamesForDrag(variable.name);
            if (!varNames.length) {
                e.preventDefault();
                return;
            }
            e.dataTransfer.setData('application/x-openmodelica-variables', JSON.stringify({
                type: 'variables',
                names: varNames,
                ...(foreign ? { fileId: leafFileId } : {}),
            }));
            e.dataTransfer.setData('text/plain', varNames[0] || variable.name);
            e.dataTransfer.effectAllowed = 'copy';
            document.querySelectorAll('.tree-item.selected').forEach(item => item.classList.add('dragging'));
            itemDiv.classList.add('dragging');
        });
        itemDiv.addEventListener('dragend', () => {
            document.querySelectorAll('.tree-item.dragging').forEach(item => item.classList.remove('dragging'));
        });
        // The same drag, for a finger. dragstart is a mouse event and never
        // fires for a touch, so without this the tree could put nothing on a
        // panel at all on a tablet (#110).
        if (isTouchCapable()) {
            installTouchDragSource(itemDiv, {
                canDrag: () => canPlot,
                payload: () => {
                    const names = foreign ? [variable.name] : this._selectedVariableNamesForDrag(variable.name);
                    if (!names.length) return null;
                    const label = variable.displayName || variable.name;
                    return { names, label, ...(foreign ? { fileId: leafFileId } : {}) };
                },
                onStart: () => itemDiv.classList.add('dragging'),
                onMove: point => this.plotManager.showTouchDropHint(point),
                onDrop: (payload, point) => this.plotManager.dropVariablesAtPoint(payload, point),
                onEnd: () => {
                    itemDiv.classList.remove('dragging');
                    this.plotManager.clearTouchDropHints();
                },
            });
        }

        parentElement.appendChild(nodeDiv);
    }
};

// Point counts are hidden with one class on the sidebar, so the tree does not
// have to be rebuilt and newly rendered leaves follow the setting on their own.
proto.togglePointCounts = function(show) {
    document.getElementById('sidebar')?.classList.toggle('hide-point-counts', !show);
    document.getElementById('toggle-point-counts')?.classList.toggle('active', !!show);
};

proto.toggleDescriptions = function(show) {
    document.querySelectorAll('.tree-description:not(.tree-derived-formula):not(.tree-derived-origin)').forEach(d => d.classList.toggle('show', show));
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
