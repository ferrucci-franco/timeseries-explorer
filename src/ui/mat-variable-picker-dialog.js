import i18n from '../i18n/index.js';
import Modal from './modal.js';

function isVector(entry) {
    return (entry.shape || []).filter(size => size > 1).length <= 1 && entry.elementCount > 1;
}

export default class MatVariablePickerDialog {
    static open({ fileName = '', version = '', entries = [] } = {}) {
        return new Promise(resolve => {
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
            toolbar.append(selectAll, selectNone);
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
            const checkboxes = [];
            for (const entry of entries) {
                const row = document.createElement('tr');
                if (!entry.selectable) row.classList.add('mat-variable-unsupported');
                const checkCell = document.createElement('td');
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = entry.id;
                checkbox.checked = !!entry.selected && entry.selectable;
                checkbox.disabled = !entry.selectable;
                checkbox.setAttribute('aria-label', entry.path);
                checkCell.appendChild(checkbox);
                checkboxes.push(checkbox);
                const values = [entry.path, entry.complex ? `${entry.className} (complex)` : entry.className, entry.shapeLabel, entry.preview || '—'];
                row.appendChild(checkCell);
                values.forEach((value, index) => {
                    const cell = document.createElement('td');
                    cell.textContent = value;
                    if (index === 0) cell.className = 'mat-variable-name';
                    if (index === 3) cell.className = 'mat-variable-preview';
                    row.appendChild(cell);
                });
                tbody.appendChild(row);
            }
            table.append(thead, tbody);
            tableWrap.appendChild(table);
            content.appendChild(tableWrap);

            const timeRow = document.createElement('label');
            timeRow.className = 'mat-picker-time-row';
            const timeLabel = document.createElement('span');
            timeLabel.textContent = i18n.t('matPickerTime');
            const timeSelect = document.createElement('select');
            timeSelect.className = 'data-tool-select';
            const autoOption = document.createElement('option');
            autoOption.value = '';
            autoOption.textContent = i18n.t('matPickerTimeAuto');
            timeSelect.appendChild(autoOption);
            entries.filter(entry => entry.selectable && isVector(entry)).forEach(entry => {
                const option = document.createElement('option');
                option.value = entry.id;
                option.textContent = `${entry.path} (${entry.shapeLabel})`;
                timeSelect.appendChild(option);
            });
            timeRow.append(timeLabel, timeSelect);
            content.appendChild(timeRow);

            const sampleAxisRow = document.createElement('label');
            sampleAxisRow.className = 'mat-picker-time-row';
            const sampleAxisLabel = document.createElement('span');
            sampleAxisLabel.textContent = i18n.t('matPickerSampleDimension');
            const sampleAxisSelect = document.createElement('select');
            sampleAxisSelect.className = 'data-tool-select';
            for (const [value, key] of [
                ['auto', 'matPickerSampleDimensionAuto'],
                ['rows', 'matPickerSampleDimensionRows'],
                ['columns', 'matPickerSampleDimensionColumns'],
            ]) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = i18n.t(key);
                sampleAxisSelect.appendChild(option);
            }
            sampleAxisRow.append(sampleAxisLabel, sampleAxisSelect);
            content.appendChild(sampleAxisRow);

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

            const selectedIds = () => checkboxes.filter(box => box.checked && !box.disabled).map(box => box.value);
            const sync = () => { confirmBtn.disabled = selectedIds().length === 0; };
            checkboxes.forEach(box => box.addEventListener('change', sync));
            selectAll.addEventListener('click', () => { checkboxes.forEach(box => { if (!box.disabled) box.checked = true; }); sync(); });
            selectNone.addEventListener('click', () => { checkboxes.forEach(box => { box.checked = false; }); sync(); });
            sync();

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
                if (event.key === 'Enter' && !confirmBtn.disabled && event.target?.tagName !== 'SELECT') {
                    finish({ selectedIds: selectedIds(), timeId: timeSelect.value || null, sampleAxisMode: sampleAxisSelect.value });
                }
            };
            cancelBtn.addEventListener('click', () => finish(null));
            confirmBtn.addEventListener('click', () => finish({
                selectedIds: selectedIds(),
                timeId: timeSelect.value || null,
                sampleAxisMode: sampleAxisSelect.value,
            }));
            overlay.addEventListener('click', event => { if (event.target === overlay) finish(null); });
            document.addEventListener('keydown', onKeyDown);
            requestAnimationFrame(() => overlay.classList.add('show'));
            setTimeout(() => confirmBtn.focus(), 100);
        });
    }
}
