/**
 * Modal Dialog System
 * Provides custom modal dialogs with better UX than browser's native confirm()
 */

import i18n from '../i18n/index.js';

const Modal = {
    /**
     * Show a confirmation dialog
     * @param {string} message - The message to display
     * @param {Object} options - Optional configuration
     * @returns {Promise<boolean>} - Resolves to true if confirmed, false if cancelled
     */
    confirm(message, options = {}) {
        return new Promise((resolve) => {
            const previousActive = document.activeElement;
            // Create overlay
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            // Create modal
            const modal = document.createElement('div');
            modal.className = 'modal-dialog';
            if (options.className) {
                modal.classList.add(...String(options.className).split(/\s+/).filter(Boolean));
            }

            // Modal content
            const content = document.createElement('div');
            content.className = 'modal-content';

            // Icon
            const icon = document.createElement('div');
            icon.className = 'modal-icon';
            if (options.iconHtml) icon.innerHTML = options.iconHtml;
            else icon.textContent = options.icon || '⚠️';
            content.appendChild(icon);

            // Message
            const messageDiv = document.createElement('div');
            messageDiv.className = 'modal-message';
            if (options.title) {
                const titleDiv = document.createElement('div');
                titleDiv.className = 'modal-title';
                titleDiv.textContent = options.title;
                content.appendChild(titleDiv);
            }
            if (options.html) messageDiv.innerHTML = message;
            else              messageDiv.textContent = message;
            content.appendChild(messageDiv);

            // Buttons
            const buttons = document.createElement('div');
            buttons.className = 'modal-buttons';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'modal-btn modal-btn-cancel';
            cancelBtn.textContent = options.cancelText || i18n.t('cancel');

            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'modal-btn modal-btn-confirm';
            confirmBtn.textContent = options.confirmText || i18n.t('confirm');

            buttons.appendChild(cancelBtn);
            buttons.appendChild(confirmBtn);
            content.appendChild(buttons);

            modal.appendChild(content);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', escHandler);
                this.close(overlay, previousActive);
                resolve(result);
            };

            // Focus confirm button
            setTimeout(() => confirmBtn.focus(), 100);

            // Close on overlay click
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    finish(false);
                }
            });

            // Close on ESC key
            const escHandler = (e) => {
                if (e.key === 'Escape') {
                    finish(false);
                }
            };
            document.addEventListener('keydown', escHandler);

            cancelBtn.addEventListener('click', () => finish(false));
            confirmBtn.addEventListener('click', () => finish(true));

            // Animate in
            requestAnimationFrame(() => {
                overlay.classList.add('show');
            });
        });
    },

    /**
     * Show a dialog with multiple explicit choices.
     * @param {string} message - The message to display
     * @param {Object} options - { title, icon, choices: [{ value, text, className, autoFocus }] }
     * @returns {Promise<string|null>} - Resolves to the selected value, or null when dismissed
     */
    choice(message, options = {}) {
        return new Promise((resolve) => {
            const previousActive = document.activeElement;
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            const modal = document.createElement('div');
            modal.className = 'modal-dialog modal-dialog-choice';
            if (options.className) {
                modal.classList.add(...String(options.className).split(/\s+/).filter(Boolean));
            }

            const content = document.createElement('div');
            content.className = 'modal-content';

            if (options.icon !== false && options.hideIcon !== true) {
                const icon = document.createElement('div');
                icon.className = 'modal-icon';
                icon.textContent = options.icon || '!';
                content.appendChild(icon);
            }

            if (options.title) {
                const titleDiv = document.createElement('div');
                titleDiv.className = 'modal-title';
                titleDiv.textContent = options.title;
                content.appendChild(titleDiv);
            }

            const messageDiv = document.createElement('div');
            messageDiv.className = 'modal-message';
            messageDiv.textContent = message;
            content.appendChild(messageDiv);

            const buttons = document.createElement('div');
            buttons.className = 'modal-buttons modal-buttons-choice';

            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', escHandler);
                this.close(overlay, previousActive);
                resolve(result);
            };

            let focusTarget = null;
            const choices = Array.isArray(options.choices) ? options.choices : [];
            choices.forEach((choice, index) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = `modal-btn ${choice.className || 'modal-btn-cancel'}`;
                btn.textContent = choice.text || String(choice.value ?? '');
                btn.addEventListener('click', () => finish(choice.value ?? null));
                buttons.appendChild(btn);
                if (choice.autoFocus || (!focusTarget && index === 0)) focusTarget = btn;
            });

            content.appendChild(buttons);
            modal.appendChild(content);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            setTimeout(() => focusTarget?.focus?.(), 100);

            // A dialog where every option matters should not be answerable by
            // missing it. Clicking beside the buttons is not a decision, and
            // what it silently chose was never one of them.
            if (!options.requireChoice) {
                overlay.addEventListener('click', (e) => {
                    if (e.target === overlay) finish(null);
                });
            }

            const escHandler = (e) => {
                if (e.key === 'Escape') finish(null);
            };
            document.addEventListener('keydown', escHandler);

            requestAnimationFrame(() => overlay.classList.add('show'));
        });
    },

    /**
     * Show a dialog with a set of checkboxes plus confirm/cancel buttons.
     * Confirm stays disabled while nothing is ticked.
     * @param {string} message - Intro message (HTML when options.html)
     * @param {Object} options - { title, icon, iconHtml, className, html, confirmText, cancelText,
     *                             bodyElement, items: [{ value, label, code, note, description, checked, disabled }] }
     * `bodyElement` is inserted between the message and the list and is kept by
     * reference, so the caller can fill it in later (e.g. when an async
     * computation lands) while the dialog is open. `listTitle` / `listFooterHtml`
     * frame the checkbox group when the dialog holds more than just the list.
     * @returns {Promise<string[]|null>} - Ticked values, or null when dismissed
     */
    checklist(message, options = {}) {
        return new Promise((resolve) => {
            const previousActive = document.activeElement;
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            const modal = document.createElement('div');
            modal.className = 'modal-dialog modal-dialog-checklist';
            if (options.className) {
                modal.classList.add(...String(options.className).split(/\s+/).filter(Boolean));
            }

            const content = document.createElement('div');
            content.className = 'modal-content';

            if (options.icon !== false && options.hideIcon !== true) {
                const icon = document.createElement('div');
                icon.className = 'modal-icon';
                if (options.iconHtml) icon.innerHTML = options.iconHtml;
                else icon.textContent = options.icon || '⚠️';
                content.appendChild(icon);
            }

            if (options.title) {
                const titleDiv = document.createElement('div');
                titleDiv.className = 'modal-title';
                titleDiv.textContent = options.title;
                content.appendChild(titleDiv);
            }

            const messageDiv = document.createElement('div');
            messageDiv.className = 'modal-message';
            if (options.html) messageDiv.innerHTML = message;
            else              messageDiv.textContent = message;
            content.appendChild(messageDiv);

            if (options.bodyElement) content.appendChild(options.bodyElement);

            // The list and its framing live in one wrapper so a caller can put
            // them beside the body element instead of under it.
            const listWrap = document.createElement('div');
            listWrap.className = 'modal-checklist-section';
            if (options.listTitle) {
                const listTitle = document.createElement('div');
                listTitle.className = 'modal-section-title';
                listTitle.textContent = options.listTitle;
                listWrap.appendChild(listTitle);
            }

            const list = document.createElement('div');
            list.className = 'modal-checklist';
            const items = Array.isArray(options.items) ? options.items : [];
            const boxes = items.map((item) => {
                const row = document.createElement('label');
                row.className = 'modal-checklist-item';

                const box = document.createElement('input');
                box.type = 'checkbox';
                box.className = 'modal-checklist-box';
                box.value = String(item.value ?? '');
                box.checked = !!item.checked;
                box.disabled = !!item.disabled;

                const text = document.createElement('div');
                text.className = 'modal-checklist-text';

                const head = document.createElement('div');
                head.className = 'modal-checklist-label';
                head.textContent = item.label || String(item.value ?? '');
                if (item.code) {
                    const code = document.createElement('code');
                    code.className = 'modal-checklist-code';
                    code.textContent = item.code;
                    head.appendChild(code);
                }
                if (item.note) {
                    const note = document.createElement('span');
                    note.className = 'modal-checklist-note';
                    note.textContent = item.note;
                    head.appendChild(note);
                }
                text.appendChild(head);

                if (item.description) {
                    const desc = document.createElement('div');
                    desc.className = 'modal-checklist-description';
                    desc.textContent = item.description;
                    text.appendChild(desc);
                }

                row.append(box, text);
                list.appendChild(row);
                return box;
            });
            listWrap.appendChild(list);
            if (options.listFooterHtml) {
                const footer = document.createElement('div');
                footer.className = 'modal-checklist-footer';
                footer.innerHTML = options.listFooterHtml;
                listWrap.appendChild(footer);
            }
            content.appendChild(listWrap);

            const buttons = document.createElement('div');
            buttons.className = 'modal-buttons';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'modal-btn modal-btn-cancel';
            cancelBtn.textContent = options.cancelText || i18n.t('cancel');

            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'modal-btn modal-btn-confirm';
            confirmBtn.textContent = options.confirmText || i18n.t('confirm');

            const syncConfirm = () => {
                confirmBtn.disabled = !boxes.some(box => box.checked);
            };
            boxes.forEach(box => box.addEventListener('change', syncConfirm));
            syncConfirm();

            buttons.appendChild(cancelBtn);
            buttons.appendChild(confirmBtn);
            content.appendChild(buttons);

            modal.appendChild(content);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', escHandler);
                this.close(overlay, previousActive);
                resolve(result);
            };

            setTimeout(() => confirmBtn.focus(), 100);

            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) finish(null);
            });

            const escHandler = (e) => {
                if (e.key === 'Escape') finish(null);
            };
            document.addEventListener('keydown', escHandler);

            cancelBtn.addEventListener('click', () => finish(null));
            confirmBtn.addEventListener('click', () => {
                if (confirmBtn.disabled) return;
                finish(boxes.filter(box => box.checked).map(box => box.value));
            });

            requestAnimationFrame(() => overlay.classList.add('show'));
        });
    },

    /**
     * Show an informational/error dialog with a single close button.
     * @param {string} title - Short heading
     * @param {string} body  - Body message (plain text or HTML if options.html)
     * @param {Object} [options] - { icon, iconHtml, html, highlightText, tip, checkboxLabel }
     * `highlightText` puts one short string — a generated name, a path — on its
     * own line below the message. `tip` is `{ glyph, text }`: a subordinate note
     * pointing at a feature, with the feature's own button glyph beside it.
     * `checkboxLabel` adds an unticked box above the button, for "do not show
     * this again" on a notice the user may not want twice.
     * @returns {Promise<void|{checked: boolean}>} - The box state when
     * `checkboxLabel` was given, and nothing otherwise. Dismissing the dialog
     * with ESC or an overlay click reports the box as the user left it.
     */
    alert(title, body, options = {}) {
        return new Promise((resolve) => {
            const previousActive = document.activeElement;
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            const modal = document.createElement('div');
            modal.className = 'modal-dialog modal-dialog-alert';
            if (options.className) {
                modal.classList.add(...String(options.className).split(/\s+/).filter(Boolean));
            }

            const content = document.createElement('div');
            content.className = 'modal-content';

            if (options.icon !== false && options.hideIcon !== true) {
                const icon = document.createElement('div');
                icon.className = 'modal-icon';
                if (options.iconHtml) icon.innerHTML = options.iconHtml;
                else icon.textContent = options.icon || '⚠️';
                content.appendChild(icon);
            }

            if (title) {
                const titleDiv = document.createElement('div');
                titleDiv.className = 'modal-title';
                titleDiv.textContent = title;
                content.appendChild(titleDiv);
            }

            const messageDiv = document.createElement('div');
            messageDiv.className = 'modal-message';
            if (options.html) messageDiv.innerHTML = body;
            else              messageDiv.textContent = body;
            content.appendChild(messageDiv);

            // A generated name is the one string the user has to read exactly,
            // so it gets its own line instead of being spliced into a sentence
            // where a wrap can cut it in two. textContent, never innerHTML:
            // this carries a file name.
            if (options.highlightText) {
                const highlight = document.createElement('div');
                highlight.className = 'modal-alert-highlight';
                highlight.textContent = options.highlightText;
                content.appendChild(highlight);
            }

            // A pointer to a feature the user is now in a position to want.
            // The glyph is the one on the real button, so the note teaches
            // what to look for rather than describing it in words.
            if (options.tip?.text) {
                const tip = document.createElement('div');
                tip.className = 'modal-alert-tip';
                if (options.tip.glyph) {
                    const glyph = document.createElement('span');
                    glyph.className = 'modal-alert-tip-glyph';
                    glyph.textContent = options.tip.glyph;
                    glyph.setAttribute('aria-hidden', 'true');
                    tip.appendChild(glyph);
                }
                const text = document.createElement('span');
                text.textContent = options.tip.text;
                tip.appendChild(text);
                content.appendChild(tip);
            }

            // Collapsed technical detail. When a raw browser error is replaced
            // by a translated explanation, the original still has to be
            // reachable — otherwise a bug report loses the one string that
            // identifies the failure. textContent, never innerHTML: this can
            // carry arbitrary text out of a file or a third-party library.
            if (options.details) {
                const details = document.createElement('details');
                details.className = 'modal-details';
                const summary = document.createElement('summary');
                summary.textContent = options.detailsLabel || 'Details';
                const pre = document.createElement('pre');
                pre.className = 'modal-details-text';
                pre.textContent = String(options.details);
                details.append(summary, pre);
                content.appendChild(details);
            }

            // A notice worth showing once is not worth showing every time. The
            // box sits above the button and never gates it: this dialog only
            // reports, so closing it must stay a single click.
            let checkbox = null;
            if (options.checkboxLabel) {
                const row = document.createElement('label');
                row.className = 'modal-alert-checkbox';
                checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                const text = document.createElement('span');
                text.textContent = options.checkboxLabel;
                row.append(checkbox, text);
                content.appendChild(row);
            }

            const buttons = document.createElement('div');
            buttons.className = 'modal-buttons';

            const closeBtn = document.createElement('button');
            closeBtn.className = 'modal-btn modal-btn-confirm';
            closeBtn.textContent = i18n.t('helpClose');

            buttons.appendChild(closeBtn);
            content.appendChild(buttons);
            modal.appendChild(content);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                document.removeEventListener('keydown', escHandler);
                const state = checkbox ? { checked: checkbox.checked } : undefined;
                this.close(overlay, previousActive);
                resolve(state);
            };

            setTimeout(() => closeBtn.focus(), 100);

            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) finish();
            });

            const escHandler = (e) => {
                if (e.key === 'Escape') {
                    finish();
                }
            };
            document.addEventListener('keydown', escHandler);
            closeBtn.addEventListener('click', finish);

            requestAnimationFrame(() => overlay.classList.add('show'));
        });
    },

    /**
     * Close and remove a modal
     * @param {HTMLElement} overlay - The overlay element to remove
     */
    close(overlay, previousActive = null) {
        overlay.style.pointerEvents = 'none';
        overlay.classList.remove('show');
        setTimeout(() => {
            if (overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
            if (previousActive && typeof previousActive.focus === 'function' && document.contains(previousActive)) {
                try { previousActive.focus({ preventScroll: true }); } catch (_) {}
            }
            window.dispatchEvent(new Event('resize'));
        }, 300);
    }
};

export default Modal;
