// Writes text to the clipboard. The async Clipboard API is refused outside a
// secure context and by some embedders; the hidden-textarea copy still works
// there. Resolves to whether the text was copied.
export async function copyTextToClipboard(text) {
    if (navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (_) {}
    }

    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', '');
    textArea.style.position = 'fixed';
    textArea.style.left = '-9999px';
    document.body.appendChild(textArea);
    textArea.select();
    try {
        return document.execCommand('copy');
    } catch (_) {
        return false;
    } finally {
        document.body.removeChild(textArea);
    }
}

// The measurement cursors' readout as plain text (#178): which trace each
// cursor reads, then the value rows exactly as the box shows them, one per
// line. The spectrum pane's "1/Δf" note and its help popover explain a row
// rather than being one, so they stay out.
export function cursorReadoutText(valuesEl, traceLines = []) {
    const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const rows = Array.from(valuesEl?.children || [])
        .filter(el => !el.matches?.('.cursor-inverse-spacing-note, .cursor-help-popover'))
        .map(el => clean(el.textContent))
        .filter(Boolean);
    return [...traceLines.map(clean).filter(Boolean), ...rows].join('\n');
}
