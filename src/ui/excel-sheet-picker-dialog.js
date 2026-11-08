import i18n from '../i18n/index.js';
import Modal from './modal.js';

/**
 * Sheet picker shown when a spreadsheet has more than one non-empty sheet.
 * Resolves with the selected sheet names, or null when the user cancels.
 *
 * Opening a workbook, every sheet with data is a switch, all on: the reader
 * turns off what they do not want rather than hunting for what they do. The
 * sheets left off are still listed under the workbook and open from there.
 * The converter (`single`) keeps radio buttons, since it writes one file.
 */
export default class ExcelSheetPickerDialog {
    /**
     * @param {object} options
     * @param {boolean} [options.single] one sheet only — the converter writes
     *   one file, so letting three sheets be ticked would promise something it
     *   is not going to do.
     * @param {string} [options.confirmLabel] i18n key for the confirm button,
     *   because "Load" is the wrong verb when nothing is being loaded.
     */
    static open({ fileName = '', sheets = [], single = false, confirmLabel = 'excelSheetPickerLoad' } = {}) {
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
            message.textContent = i18n.t(single ? 'excelSheetPickerBody' : 'excelSheetPickerBodyWorkbook')
                .replace('{file}', fileName);
            content.appendChild(message);

            const makeSwitch = (input) => {
                input.type = 'checkbox';
                input.setAttribute('role', 'switch');
                input.className = 'excel-sheet-switch-input';
                const track = document.createElement('span');
                track.className = 'excel-sheet-switch';
                track.setAttribute('aria-hidden', 'true');
                return track;
            };

            const list = document.createElement('div');
            list.className = 'excel-sheet-list' + (single ? '' : ' excel-sheet-list-switches');
            const checkboxes = [];
            let firstSelectableChecked = false;

            // One switch for all of them, ahead of the list.
            let allSwitch = null;
            const selectable = sheets.filter(sheet => !sheet.empty);
            if (!single && selectable.length > 1) {
                const row = document.createElement('label');
                row.className = 'excel-sheet-row excel-sheet-row-all';
                allSwitch = document.createElement('input');
                const track = makeSwitch(allSwitch);
                allSwitch.checked = true;
                const name = document.createElement('span');
                name.className = 'excel-sheet-name';
                name.textContent = i18n.t('excelSheetPickerAll');
                row.append(allSwitch, track, name);
                list.appendChild(row);
            }

            for (const sheet of sheets) {
                const row = document.createElement('label');
                row.className = 'excel-sheet-row';

                const checkbox = document.createElement('input');
                let track = null;
                if (single) {
                    checkbox.type = 'radio';
                    checkbox.name = 'omv-excel-sheet';
                } else {
                    track = makeSwitch(checkbox);
                }
                checkbox.value = sheet.name;
                checkbox.disabled = !!sheet.empty;
                if (!sheet.empty && (!single || !firstSelectableChecked)) {
                    checkbox.checked = true;
                    firstSelectableChecked = true;
                }
                row.appendChild(checkbox);
                if (track) row.appendChild(track);
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
                } else if (Number.isFinite(sheet.rowCount) && Number.isFinite(sheet.colCount)) {
                    // A caller that only knows the sheet names says nothing
                    // rather than "undefined × undefined".
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
            confirmBtn.textContent = i18n.t(confirmLabel);

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
                if (allSwitch) {
                    const enabled = checkboxes.filter(checkbox => !checkbox.disabled);
                    const on = enabled.filter(checkbox => checkbox.checked).length;
                    allSwitch.checked = on === enabled.length;
                    allSwitch.indeterminate = on > 0 && on < enabled.length;
                }
            };
            checkboxes.forEach(checkbox => checkbox.addEventListener('change', syncConfirm));
            allSwitch?.addEventListener('change', () => {
                for (const checkbox of checkboxes) {
                    if (!checkbox.disabled) checkbox.checked = allSwitch.checked;
                }
                syncConfirm();
            });
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
