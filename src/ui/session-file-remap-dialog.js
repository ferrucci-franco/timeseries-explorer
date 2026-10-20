import i18n from '../i18n/index.js';
import Modal from './modal.js';

/**
 * Shown when a saved view needs a file that is not open: says which one, and
 * lets each be stood in for by one of the open files — the same experiment
 * written to a new file (a logger that names its files by the hour), or the
 * same model run again. The view is the skeleton; the data is whatever file
 * is picked for it.
 *
 * rows: [{
 *   id,                 the session's id for the file
 *   needed,             its name, as the session saved it
 *   required: [names],  the signals the view plots from it
 *   csvProfile,         true when the session brings its own CSV parsing
 *   selected,           fileId preselected, or ''
 * }]
 * candidates: [{ fileId, name, variables: Set }]
 *
 * Resolves with Map(id → fileId), a file left unassigned is not in it, or
 * null when cancelled.
 */
export default class SessionFileRemapDialog {
    static open({ rows = [], candidates = [] } = {}) {
        return new Promise((resolve) => {
            const previousActive = document.activeElement;
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            const modal = document.createElement('div');
            modal.className = 'modal-dialog modal-dialog-session-remap';

            const content = document.createElement('div');
            content.className = 'modal-content';

            const icon = document.createElement('div');
            icon.className = 'modal-icon';
            icon.textContent = 'JSON';
            content.appendChild(icon);

            const title = document.createElement('div');
            title.className = 'modal-title';
            title.textContent = i18n.t('sessionRemapTitle');
            content.appendChild(title);

            const message = document.createElement('div');
            message.className = 'modal-message';
            message.textContent = i18n.t('sessionRemapBody');
            content.appendChild(message);

            const list = document.createElement('div');
            list.className = 'session-remap-list';
            const selects = [];

            const statusOf = (row, fileId) => {
                if (!fileId) return { kind: 'skip', text: i18n.t('sessionRemapSkipped') };
                const candidate = candidates.find(item => item.fileId === fileId);
                // The saved parsing is applied to the picked file first, and the
                // signals are only named once it has been: there is nothing to
                // check them against yet.
                if (row.csvProfile) return { kind: 'ok', text: i18n.t('sessionRemapCsvProfile') };
                if (!row.required.length) return { kind: 'ok', text: i18n.t('sessionRemapNoSignals') };
                const missing = row.required.filter(name => !candidate?.variables?.has(name));
                if (!missing.length) {
                    return { kind: 'ok', text: i18n.t('sessionRemapAllFound').replace('{count}', String(row.required.length)) };
                }
                const shown = missing.slice(0, 4).join(', ') + (missing.length > 4 ? ', …' : '');
                return {
                    kind: 'warn',
                    text: i18n.t('sessionRemapSomeMissing')
                        .replace('{missing}', String(missing.length))
                        .replace('{count}', String(row.required.length))
                        .replace('{names}', shown),
                };
            };

            const sync = () => {
                const taken = new Map(selects.map(({ select }) => [select, select.value]));
                for (const { select, row, status } of selects) {
                    for (const option of select.options) {
                        if (!option.value) continue;
                        option.disabled = [...taken].some(([other, value]) => other !== select && value === option.value);
                    }
                    const state = statusOf(row, select.value);
                    status.className = `session-remap-status ${state.kind}`;
                    status.textContent = state.text;
                }
            };

            rows.forEach((row, index) => {
                const item = document.createElement('div');
                item.className = 'session-remap-row';

                const needed = document.createElement('div');
                needed.className = 'session-remap-needed';
                const caption = document.createElement('span');
                caption.className = 'session-remap-caption';
                caption.textContent = i18n.t('sessionRemapNeeded');
                const name = document.createElement('span');
                name.className = 'session-remap-name';
                name.textContent = row.needed;
                name.title = row.needed;
                needed.append(caption, name);
                if (row.required.length) {
                    const signals = document.createElement('div');
                    signals.className = 'session-remap-signals';
                    const shown = row.required.slice(0, 6).join(', ') + (row.required.length > 6 ? ', …' : '');
                    signals.textContent = shown;
                    signals.title = row.required.join(', ');
                    needed.appendChild(signals);
                }

                const pick = document.createElement('label');
                pick.className = 'session-remap-pick';
                const pickCaption = document.createElement('span');
                pickCaption.className = 'session-remap-caption';
                pickCaption.textContent = i18n.t('sessionRemapUse');
                const select = document.createElement('select');
                select.className = 'session-remap-select';
                select.dataset.row = String(index);
                select.add(new Option(i18n.t('sessionRemapSkipOption'), ''));
                for (const candidate of candidates) select.add(new Option(candidate.name, candidate.fileId));
                select.value = row.selected || '';
                select.addEventListener('change', sync);
                pick.append(pickCaption, select);

                const status = document.createElement('div');
                status.className = 'session-remap-status';

                item.append(needed, pick, status);
                list.appendChild(item);
                selects.push({ select, row, status });
            });
            content.appendChild(list);

            const buttons = document.createElement('div');
            buttons.className = 'modal-buttons';
            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'modal-btn modal-btn-cancel';
            cancelBtn.textContent = i18n.t('cancel');
            const confirmBtn = document.createElement('button');
            confirmBtn.type = 'button';
            confirmBtn.className = 'modal-btn modal-btn-confirm';
            confirmBtn.textContent = i18n.t('sessionRemapApply');
            buttons.append(cancelBtn, confirmBtn);
            content.appendChild(buttons);

            modal.appendChild(content);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);
            sync();

            const result = () => {
                const map = new Map();
                for (const { select, row } of selects) if (select.value) map.set(row.id, select.value);
                return map;
            };

            let settled = false;
            const finish = (value) => {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', keyHandler);
                Modal.close(overlay, previousActive);
                resolve(value);
            };
            const keyHandler = (event) => {
                if (event.key === 'Escape') finish(null);
            };
            cancelBtn.addEventListener('click', () => finish(null));
            confirmBtn.addEventListener('click', () => finish(result()));
            document.addEventListener('keydown', keyHandler);

            setTimeout(() => confirmBtn.focus(), 100);
            requestAnimationFrame(() => overlay.classList.add('show'));
        });
    }
}
