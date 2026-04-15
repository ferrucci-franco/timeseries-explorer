/**
 * Modal Dialog System
 * Provides custom modal dialogs with better UX than browser's native confirm()
 */

const Modal = {
    /**
     * Show a confirmation dialog
     * @param {string} message - The message to display
     * @param {Object} options - Optional configuration
     * @returns {Promise<boolean>} - Resolves to true if confirmed, false if cancelled
     */
    confirm(message, options = {}) {
        return new Promise((resolve) => {
            // Create overlay
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            // Create modal
            const modal = document.createElement('div');
            modal.className = 'modal-dialog';

            // Modal content
            const content = document.createElement('div');
            content.className = 'modal-content';

            // Icon
            const icon = document.createElement('div');
            icon.className = 'modal-icon';
            icon.textContent = options.icon || '⚠️';
            content.appendChild(icon);

            // Message
            const messageDiv = document.createElement('div');
            messageDiv.className = 'modal-message';
            messageDiv.textContent = message;
            content.appendChild(messageDiv);

            // Buttons
            const buttons = document.createElement('div');
            buttons.className = 'modal-buttons';

            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'modal-btn modal-btn-cancel';
            cancelBtn.textContent = i18n.t('cancel');
            cancelBtn.addEventListener('click', () => {
                this.close(overlay);
                resolve(false);
            });

            const confirmBtn = document.createElement('button');
            confirmBtn.className = 'modal-btn modal-btn-confirm';
            confirmBtn.textContent = i18n.t('confirm');
            confirmBtn.addEventListener('click', () => {
                this.close(overlay);
                resolve(true);
            });

            buttons.appendChild(cancelBtn);
            buttons.appendChild(confirmBtn);
            content.appendChild(buttons);

            modal.appendChild(content);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            // Focus confirm button
            setTimeout(() => confirmBtn.focus(), 100);

            // Close on overlay click
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    this.close(overlay);
                    resolve(false);
                }
            });

            // Close on ESC key
            const escHandler = (e) => {
                if (e.key === 'Escape') {
                    this.close(overlay);
                    resolve(false);
                    document.removeEventListener('keydown', escHandler);
                }
            };
            document.addEventListener('keydown', escHandler);

            // Animate in
            requestAnimationFrame(() => {
                overlay.classList.add('show');
            });
        });
    },

    /**
     * Show an informational/error dialog with a single close button.
     * @param {string} title - Short heading
     * @param {string} body  - Body message (plain text or HTML if options.html)
     * @param {Object} [options] - { icon, html }
     */
    alert(title, body, options = {}) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';

            const modal = document.createElement('div');
            modal.className = 'modal-dialog modal-dialog-alert';
            if (options.className) {
                modal.classList.add(...String(options.className).split(/\s+/).filter(Boolean));
            }

            const content = document.createElement('div');
            content.className = 'modal-content';

            const icon = document.createElement('div');
            icon.className = 'modal-icon';
            icon.textContent = options.icon || '⚠️';
            content.appendChild(icon);

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

            const buttons = document.createElement('div');
            buttons.className = 'modal-buttons';

            const closeBtn = document.createElement('button');
            closeBtn.className = 'modal-btn modal-btn-confirm';
            closeBtn.textContent = i18n.t('compareFilesClose') || 'Close';
            closeBtn.addEventListener('click', () => { this.close(overlay); resolve(); });

            buttons.appendChild(closeBtn);
            content.appendChild(buttons);
            modal.appendChild(content);
            overlay.appendChild(modal);
            document.body.appendChild(overlay);

            setTimeout(() => closeBtn.focus(), 100);

            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) { this.close(overlay); resolve(); }
            });

            const escHandler = (e) => {
                if (e.key === 'Escape') {
                    this.close(overlay);
                    resolve();
                    document.removeEventListener('keydown', escHandler);
                }
            };
            document.addEventListener('keydown', escHandler);

            requestAnimationFrame(() => overlay.classList.add('show'));
        });
    },

    /**
     * Close and remove a modal
     * @param {HTMLElement} overlay - The overlay element to remove
     */
    close(overlay) {
        overlay.classList.remove('show');
        setTimeout(() => {
            if (overlay.parentNode) {
                overlay.parentNode.removeChild(overlay);
            }
        }, 300);
    }
};
