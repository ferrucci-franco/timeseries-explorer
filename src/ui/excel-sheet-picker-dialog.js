import i18n from '../i18n/index.js';
import Modal from './modal.js';

/**
 * Sheet picker shown when a spreadsheet has more than one non-empty sheet.
 * Resolves with the selected sheet names (each becomes its own dataset),
 * or null when the user cancels.
 */
export default class ExcelSheetPickerDialog {
    static open({ fileName = '', sheets = [] } = {}) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            const modal = document.createElement('div');
            modal.className = 'modal-dialog modal-dialog-excel-sheets';

            const content = document.createElement('div');
            content.className = 'modal-content';

            const icon = document.createElement('div');
            icon.className = 'modal-icon';
            icon.textContent = 'XLS';
            content.appendChild(icon);

            const title = document.createElement('div');
            title.className = 'modal-title';
            title.textContent = i18n.t('excelSheetPickerTitle');
            content.appendChild(title);

            const message = document.createElement('div');
            message.className = 'modal-message';
            message.textContent = i18n.t('excelSheetPickerBody').replace('{file}', fileName);
            content.appendChild(message);

            const list = document.createElement('div');
            list.className = 'excel-sheet-list';
            const checkboxes = [];
            let firstSelectableChecked = false;
            for (const sheet of sheets) {
                const row = document.createElement('label');
                row.className = 'excel-sheet-row';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.value = sheet.name;
                checkbox.disabled = !!sheet.empty;
                if (!sheet.empty && !firstSelectableChecked) {
                    checkbox.checked = true;
                    firstSelectableChecked = true;
                }
                row.appendChild(checkbox);
                checkboxes.push(checkbox);

                const name = document.createElement('span');
                name.className = 'excel-sheet-name';
                name.textContent = sheet.name;
                row.appendChild(name);

                const detail = document.createElement('span');
                detail.className = 'excel-sheet-detail';
                const notes = [];
                if (sheet.empty) {
                    notes.push(i18n.t('excelSheetEmpty'));
                } else {
                    notes.push(`${sheet.rowCount} × ${sheet.colCount}`);
                }
                if (sheet.hidden) notes.push(i18n.t('excelSheetHidden'));
                detail.textContent = notes.join(' · ');
                row.appendChild(detail);

                if (sheet.empty) row.classList.add('excel-sheet-row-empty');
                list.appendChild(row);
            }
            content.appendChild(list);

            const buttons = document.createElement('div');
            buttons.className = 'modal-buttons';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'modal-btn modal-btn-cancel';
            cancelBtn.textContent = i18n.t('cancel');

            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'modal-btn modal-btn-confirm';
            confirmBtn.textContent = i18n.t('excelSheetPickerLoad');

            buttons.append(cancelBtn, confirmBtn);
            content.appendChild(buttons);
            modal.appendChild(content);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            const selectedNames = () => checkboxes
                .filter(checkbox => checkbox.checked && !checkbox.disabled)
                .map(checkbox => checkbox.value);

            const syncConfirm = () => {
                confirmBtn.disabled = !selectedNames().length;
            };
            checkboxes.forEach(checkbox => checkbox.addEventListener('change', syncConfirm));
            syncConfirm();

            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', keyHandler);
                Modal.close(overlay);
                resolve(value);
            };

            const keyHandler = (e) => {
                if (e.key === 'Escape') finish(null);
                if (e.key === 'Enter' && !confirmBtn.disabled) finish(selectedNames());
            };

            cancelBtn.addEventListener('click', () => finish(null));
            confirmBtn.addEventListener('click', () => finish(selectedNames()));
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) finish(null);
            });
            document.addEventListener('keydown', keyHandler);

            setTimeout(() => confirmBtn.focus(), 100);
            requestAnimationFrame(() => overlay.classList.add('show'));
        });
    }
}
