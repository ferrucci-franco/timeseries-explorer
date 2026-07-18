import i18n from '../i18n/index.js';
import Modal from './modal.js';

function isVector(entry) {
    return (entry.shape || []).filter(size => size > 1).length <= 1 && entry.elementCount > 1;
}

function isMatrix(entry) {
    return entry.selectable && entry.shape?.length === 2 && entry.shape[0] > 1 && entry.shape[1] > 1;
}

function isMonotonic(entry) {
    if (!entry?.data || entry.data.length < 2) return false;
    let previous = Number(entry.data[0]);
    for (let index = 1; index < entry.data.length; index++) {
        const value = Number(entry.data[index]);
        if (!Number.isFinite(value) || value < previous) return false;
        previous = value;
    }
    return true;
}

function formatValue(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return String(value ?? '');
    return Math.abs(number) >= 1e6 || (Math.abs(number) > 0 && Math.abs(number) < 1e-4)
        ? number.toExponential(4)
        : Number(number.toPrecision(6)).toString();
}

function matrixSeries(entry, sampleAxis, seriesIndex) {
    const [rows, columns] = entry.shape;
    const length = sampleAxis === 0 ? rows : columns;
    return Array.from({ length }, (_, sampleIndex) => {
        const row = sampleAxis === 0 ? sampleIndex : seriesIndex;
        const column = sampleAxis === 0 ? seriesIndex : sampleIndex;
        const offset = entry.layout === 'column-major'
            ? column * rows + row
            : row * columns + column;
        return entry.data[offset];
    });
}

function seriesPreview(values) {
    const preview = values.slice(0, 5).map(formatValue).join(', ');
    return values.length > 5 ? `${preview}, …` : preview;
}

export default class MatVariablePickerDialog {
    static open({ fileName = '', version = '', entries = [], initialSelection = null } = {}) {
        return new Promise(resolve => {
            const initialSelectedIds = new Set(initialSelection?.selectedIds || []);
            const hasInitialSelection = Array.isArray(initialSelection?.selectedIds);
            const initialOrientations = initialSelection?.matrixOrientations || {};
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            const modal = document.createElement('div');
            modal.className = 'modal-dialog modal-dialog-mat-variables';
            const content = document.createElement('div');
            content.className = 'modal-content';

            const icon = document.createElement('div');
            icon.className = 'modal-icon';
            icon.textContent = 'MAT';
            const title = document.createElement('div');
            title.className = 'modal-title';
            title.textContent = i18n.t('matPickerTitle');
            const message = document.createElement('div');
            message.className = 'modal-message';
            message.textContent = i18n.t('matPickerBody')
                .replace('{file}', fileName)
                .replace('{version}', version);
            content.append(icon, title, message);

            const toolbar = document.createElement('div');
            toolbar.className = 'mat-picker-toolbar';
            const selectAll = document.createElement('button');
            selectAll.type = 'button';
            selectAll.className = 'modal-btn modal-btn-secondary';
            selectAll.textContent = i18n.t('matPickerSelectAll');
            const selectNone = document.createElement('button');
            selectNone.type = 'button';
            selectNone.className = 'modal-btn modal-btn-secondary';
            selectNone.textContent = i18n.t('matPickerSelectNone');
            const filterWrap = document.createElement('div');
            filterWrap.className = 'variable-filter-wrap mat-picker-filter-wrap';
            const filterInput = document.createElement('input');
            filterInput.className = 'variable-filter mat-picker-filter';
            filterInput.type = 'text';
            filterInput.placeholder = i18n.t('filterVariables');
            filterInput.setAttribute('aria-label', i18n.t('filterVariables'));
            const clearFilter = document.createElement('button');
            clearFilter.className = 'variable-filter-clear';
            clearFilter.type = 'button';
            clearFilter.textContent = '×';
            clearFilter.title = i18n.t('clearVariableFilter');
            clearFilter.setAttribute('aria-label', i18n.t('clearVariableFilter'));
            clearFilter.hidden = true;
            filterWrap.append(filterInput, clearFilter);
            toolbar.append(selectAll, selectNone, filterWrap);
            content.appendChild(toolbar);

            const tableWrap = document.createElement('div');
            tableWrap.className = 'mat-variable-table-wrap';
            const table = document.createElement('table');
            table.className = 'mat-variable-table';
            const thead = document.createElement('thead');
            const header = document.createElement('tr');
            for (const label of ['', i18n.t('matPickerName'), i18n.t('matPickerType'), i18n.t('matPickerSize'), i18n.t('matPickerOverview')]) {
                const th = document.createElement('th');
                th.textContent = label;
                header.appendChild(th);
            }
            thead.appendChild(header);
            const tbody = document.createElement('tbody');
            const rowStates = [];

            const timeRow = document.createElement('label');
            timeRow.className = 'mat-picker-time-row';
            const timeLabel = document.createElement('span');
            timeLabel.textContent = i18n.t('matPickerTime');
            const timeSelect = document.createElement('select');
            timeSelect.className = 'data-tool-select';
            const autoOption = document.createElement('option');
            autoOption.value = '';
            autoOption.textContent = i18n.t('matPickerTimeAuto');
            const indexOption = document.createElement('option');
            indexOption.value = '__index__';
            indexOption.textContent = i18n.t('matPickerTimeIndex');
            indexOption.selected = true;
            timeSelect.append(autoOption, indexOption);
            entries.filter(entry => entry.selectable && isVector(entry)).forEach(entry => {
                const option = document.createElement('option');
                option.value = entry.id;
                option.textContent = `${entry.path} (${entry.shapeLabel})`;
                timeSelect.appendChild(option);
            });
            if (initialSelection?.timeMode === 'auto') timeSelect.value = '';
            else if (initialSelection?.timeMode === 'selected' && initialSelection.timeId) {
                timeSelect.value = initialSelection.timeId;
                if (timeSelect.value !== initialSelection.timeId) timeSelect.value = '__index__';
            } else {
                timeSelect.value = '__index__';
            }

            const orientationById = new Map();
            const expandedIds = new Set();

            const renderChildren = state => {
                state.children.forEach(row => row.remove());
                state.children = [];
                if (!expandedIds.has(state.entry.id)) return;
                const sampleAxis = orientationById.get(state.entry.id) === 'columns' ? 1 : 0;
                const seriesCount = state.entry.shape[sampleAxis === 0 ? 1 : 0];
                const seriesLabel = i18n.t(sampleAxis === 0
                    ? 'matPickerSampleDimensionColumns'
                    : 'matPickerSampleDimensionRows');
                let insertionPoint = state.row;
                for (let index = 0; index < seriesCount; index++) {
                    const values = matrixSeries(state.entry, sampleAxis, index);
                    const row = document.createElement('tr');
                    row.className = 'mat-variable-child-row';
                    const empty = document.createElement('td');
                    const name = document.createElement('td');
                    name.className = 'mat-variable-name';
                    name.textContent = `${seriesLabel} [${index + 1}]`;
                    const type = document.createElement('td');
                    type.textContent = state.entry.complex ? `${state.entry.className} (complex)` : state.entry.className;
                    const size = document.createElement('td');
                    size.textContent = String(values.length);
                    const preview = document.createElement('td');
                    preview.className = 'mat-variable-preview';
                    preview.textContent = seriesPreview(values);
                    row.append(empty, name, type, size, preview);
                    row.hidden = state.row.hidden;
                    insertionPoint.after(row);
                    insertionPoint = row;
                    state.children.push(row);
                }
            };

            for (const entry of entries) {
                const row = document.createElement('tr');
                if (!entry.selectable) row.classList.add('mat-variable-unsupported');
                const checkCell = document.createElement('td');
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = entry.id;
                checkbox.checked = entry.selectable && (hasInitialSelection
                    ? initialSelectedIds.has(entry.id)
                    : !!entry.selected);
                checkbox.disabled = !entry.selectable;
                checkbox.setAttribute('aria-label', entry.path);
                checkCell.appendChild(checkbox);

                const nameCell = document.createElement('td');
                nameCell.className = 'mat-variable-name';
                const nameWrap = document.createElement('span');
                nameWrap.className = 'mat-variable-name-wrap';
                let disclosure = null;
                if (isMatrix(entry)) {
                    row.classList.add('mat-variable-matrix-row');
                    disclosure = document.createElement('button');
                    disclosure.type = 'button';
                    disclosure.className = 'mat-matrix-disclosure';
                    disclosure.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 6 6 6-6 6"/></svg>';
                    disclosure.setAttribute('aria-expanded', 'false');
                    disclosure.setAttribute('aria-label', entry.path);
                    nameWrap.appendChild(disclosure);
                    orientationById.set(entry.id, initialOrientations[entry.id] === 'columns' ? 'columns' : 'rows');
                }
                const name = document.createElement('span');
                name.textContent = entry.path;
                nameWrap.appendChild(name);
                nameCell.appendChild(nameWrap);

                const typeCell = document.createElement('td');
                typeCell.textContent = entry.complex ? `${entry.className} (complex)` : entry.className;
                const sizeCell = document.createElement('td');
                sizeCell.textContent = entry.shapeLabel;
                const previewCell = document.createElement('td');
                previewCell.className = 'mat-variable-preview';
                const preview = document.createElement('span');
                preview.textContent = entry.preview || '—';
                previewCell.appendChild(preview);

                let transpose = null;
                let orientationLabel = null;
                if (isMatrix(entry)) {
                    const controls = document.createElement('span');
                    controls.className = 'mat-matrix-controls';
                    orientationLabel = document.createElement('span');
                    orientationLabel.className = 'mat-matrix-orientation';
                    transpose = document.createElement('button');
                    transpose.type = 'button';
                    transpose.className = 'mat-matrix-transpose';
                    transpose.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 8 3 12l4 4M3 12h18M17 8l4 4-4 4"/></svg>';
                    transpose.title = i18n.t('matPickerTranspose');
                    transpose.setAttribute('aria-label', `${i18n.t('matPickerTranspose')}: ${entry.path}`);
                    controls.append(orientationLabel, transpose);
                    previewCell.appendChild(controls);
                }

                row.append(checkCell, nameCell, typeCell, sizeCell, previewCell);
                tbody.appendChild(row);
                const state = { entry, row, checkbox, disclosure, transpose, orientationLabel, children: [] };
                rowStates.push(state);

                disclosure?.addEventListener('click', () => {
                    const expanded = !expandedIds.has(entry.id);
                    if (expanded) expandedIds.add(entry.id);
                    else expandedIds.delete(entry.id);
                    disclosure.setAttribute('aria-expanded', String(expanded));
                    renderChildren(state);
                });
            }

            table.append(thead, tbody);
            tableWrap.appendChild(table);
            content.appendChild(tableWrap);
            timeRow.append(timeLabel, timeSelect);
            content.appendChild(timeRow);

            const validation = document.createElement('div');
            validation.className = 'mat-picker-validation';
            validation.hidden = true;
            content.appendChild(validation);

            const buttons = document.createElement('div');
            buttons.className = 'modal-buttons';
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'modal-btn modal-btn-cancel';
            cancelBtn.textContent = i18n.t('cancel');
            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'modal-btn modal-btn-confirm';
            confirmBtn.textContent = i18n.t('matPickerImport');
            buttons.append(cancelBtn, confirmBtn);
            content.appendChild(buttons);
            modal.appendChild(content);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            const stateForId = id => rowStates.find(state => state.entry.id === id);
            const applyFilter = () => {
                const filter = filterInput.value.trim().toLowerCase();
                clearFilter.hidden = filterInput.value.length === 0;
                for (const state of rowStates) {
                    const { entry } = state;
                    const matches = !filter || [
                        entry.path,
                        entry.name,
                        entry.className,
                        entry.shapeLabel,
                        entry.preview,
                    ].some(value => String(value || '').toLowerCase().includes(filter));
                    state.row.hidden = !matches;
                    state.children.forEach(row => { row.hidden = !matches; });
                }
            };
            const selectedIds = () => rowStates
                .filter(state => state.checkbox.checked && !state.checkbox.disabled)
                .map(state => state.entry.id);
            const autoTimeEntry = () => rowStates
                .filter(state => state.checkbox.checked && state.entry.selectable && isVector(state.entry))
                .map(state => state.entry)
                .find(entry => /^(?:time|times|t|tiempo|temps|timestamp|timestamps)$/i.test(entry.name) && isMonotonic(entry));
            const activeTimeEntry = () => {
                if (timeSelect.value === '__index__') return null;
                if (timeSelect.value) return stateForId(timeSelect.value)?.entry || null;
                return autoTimeEntry() || null;
            };

            const updateOrientationLabel = state => {
                if (!state.orientationLabel) return;
                const key = orientationById.get(state.entry.id) === 'columns'
                    ? 'matPickerSampleDimensionColumns'
                    : 'matPickerSampleDimensionRows';
                state.orientationLabel.textContent = `${i18n.t('matPickerSampleDimension')}: ${i18n.t(key)}`;
            };

            const sync = () => {
                const explicitTime = timeSelect.value && timeSelect.value !== '__index__'
                    ? stateForId(timeSelect.value)
                    : null;
                if (explicitTime) explicitTime.checkbox.checked = true;
                const timeEntry = activeTimeEntry();
                const timeLength = timeEntry?.elementCount || null;

                for (const state of rowStates) {
                    const { entry, checkbox } = state;
                    checkbox.disabled = !entry.selectable;
                    state.row.classList.toggle('mat-variable-unsupported', !entry.selectable);
                    if (entry.selectable && timeLength && entry.elementCount > 1 && entry !== timeEntry) {
                        const compatible = isMatrix(entry)
                            ? entry.shape.includes(timeLength)
                            : entry.elementCount === timeLength;
                        if (!compatible) {
                            checkbox.checked = false;
                            checkbox.disabled = true;
                            state.row.classList.add('mat-variable-unsupported');
                        }
                    }
                    if (!isMatrix(entry)) continue;
                    let orientation = orientationById.get(entry.id) || 'rows';
                    let sampleAxis = orientation === 'columns' ? 1 : 0;
                    if (timeLength && entry.shape[sampleAxis] !== timeLength) {
                        const compatibleAxis = entry.shape[0] === timeLength ? 0 : (entry.shape[1] === timeLength ? 1 : -1);
                        if (compatibleAxis >= 0) {
                            orientation = compatibleAxis === 0 ? 'rows' : 'columns';
                            orientationById.set(entry.id, orientation);
                            sampleAxis = compatibleAxis;
                            renderChildren(state);
                        }
                    }
                    const alternateAxis = sampleAxis === 0 ? 1 : 0;
                    state.transpose.disabled = !!timeLength && entry.shape[alternateAxis] !== timeLength;
                    state.transpose.title = state.transpose.disabled
                        ? i18n.t('matPickerTransposeBlocked')
                        : i18n.t('matPickerTranspose');
                    updateOrientationLabel(state);
                }

                const lengths = new Set();
                for (const state of rowStates) {
                    if (!state.checkbox.checked || state.checkbox.disabled || state.entry.elementCount <= 1) continue;
                    if (state.entry === timeEntry) {
                        lengths.add(state.entry.elementCount);
                    } else if (isMatrix(state.entry)) {
                        const axis = orientationById.get(state.entry.id) === 'columns' ? 1 : 0;
                        lengths.add(state.entry.shape[axis]);
                    } else {
                        lengths.add(state.entry.elementCount);
                    }
                }
                const incompatible = timeSelect.value !== '__index__' && lengths.size > 1;
                validation.hidden = !incompatible;
                validation.textContent = incompatible ? i18n.t('matPickerIncompatibleLengths') : '';
                confirmBtn.disabled = selectedIds().length === 0 || incompatible;
                applyFilter();
            };

            for (const state of rowStates) {
                state.checkbox.addEventListener('change', sync);
                state.transpose?.addEventListener('click', () => {
                    if (state.transpose.disabled) return;
                    const current = orientationById.get(state.entry.id) || 'rows';
                    orientationById.set(state.entry.id, current === 'rows' ? 'columns' : 'rows');
                    renderChildren(state);
                    sync();
                });
                updateOrientationLabel(state);
            }
            timeSelect.addEventListener('change', sync);
            filterInput.addEventListener('input', applyFilter);
            clearFilter.addEventListener('click', () => {
                if (!filterInput.value) return;
                filterInput.value = '';
                applyFilter();
                filterInput.focus();
            });
            selectAll.addEventListener('click', () => {
                const filtering = filterInput.value.trim().length > 0;
                rowStates.forEach(state => {
                    if (!state.checkbox.disabled && (!filtering || !state.row.hidden)) state.checkbox.checked = true;
                });
                sync();
            });
            selectNone.addEventListener('click', () => {
                rowStates.forEach(state => { state.checkbox.checked = false; });
                sync();
            });
            sync();

            const selection = () => ({
                selectedIds: selectedIds(),
                timeId: timeSelect.value && timeSelect.value !== '__index__' ? timeSelect.value : null,
                timeMode: timeSelect.value === '__index__' ? 'index' : (timeSelect.value ? 'selected' : 'auto'),
                sampleAxisMode: 'auto',
                matrixOrientations: Object.fromEntries(orientationById),
            });
            let settled = false;
            const finish = value => {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', onKeyDown);
                Modal.close(overlay);
                resolve(value);
            };
            const onKeyDown = event => {
                if (event.key === 'Escape') finish(null);
                if (event.key === 'Enter' && !confirmBtn.disabled && event.target?.tagName !== 'SELECT') finish(selection());
            };
            cancelBtn.addEventListener('click', () => finish(null));
            confirmBtn.addEventListener('click', () => finish(selection()));
            overlay.addEventListener('click', event => { if (event.target === overlay) finish(null); });
            document.addEventListener('keydown', onKeyDown);
            requestAnimationFrame(() => overlay.classList.add('show'));
            setTimeout(() => confirmBtn.focus(), 100);
        });
    }
}
