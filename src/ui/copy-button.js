// The small "copy to the clipboard" button: the cursors' readout first (#178),
// then every analysis whose result is text — the curve fit, the integral
// table, the Σ statistics. One look, one confirmation, wherever it sits.
import i18n from '../i18n/index.js';
import { copyTextToClipboard } from '../utils/clipboard.js';

export const COPY_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="13" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V5a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;
export const COPIED_ICON = `<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" focusable="false"><path d="M4 12.5l5 5L20 6.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// A check mark (or a red outline) for a moment, then the button as it was.
// The title says the outcome meanwhile, for a reader who cannot see colour.
export function showCopyResult(btn, copied, idleTitle) {
    const label = i18n.t(copied ? 'cursorCopied' : 'cursorCopyFailed');
    clearTimeout(btn._copiedTimer);
    btn.classList.toggle('copied', copied);
    btn.classList.toggle('copy-failed', !copied);
    btn.innerHTML = copied ? COPIED_ICON : COPY_ICON;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn._copiedTimer = setTimeout(() => {
        btn.classList.remove('copied', 'copy-failed');
        btn.innerHTML = COPY_ICON;
        btn.title = idleTitle;
        btn.setAttribute('aria-label', idleTitle);
    }, 1500);
}

// getText is called on the click, so the button copies what is shown then,
// not what was shown when it was made.
export function createCopyButton(getText, { title = i18n.t('copyResults'), className = '' } = {}) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `copy-results-btn${className ? ` ${className}` : ''}`;
    btn.innerHTML = COPY_ICON;
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        let text = '';
        try { text = String(getText() || ''); } catch (_) { text = ''; }
        // Nothing computed yet: nothing happened, so nothing to confirm.
        if (!text) return;
        showCopyResult(btn, await copyTextToClipboard(text), title);
    });
    return btn;
}

// The button at the end of a section heading, the heading laid out as a row.
export function appendCopyButton(heading, getText, options = {}) {
    if (!heading) return null;
    const btn = createCopyButton(getText, options);
    heading.classList.add('has-copy-btn');
    heading.appendChild(btn);
    return btn;
}
