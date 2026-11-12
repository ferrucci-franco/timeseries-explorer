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

// A results table as tab-separated text, one line per row: pasted into a
// spreadsheet, every cell lands in a cell of its own. A cell spanning several
// columns is followed by empty ones, so the columns below it stay aligned;
// trailing empties are dropped (a group heading is just its name).
export function tableText(table) {
    const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    return Array.from(table?.rows || []).map(row => {
        const cells = [];
        for (const cell of Array.from(row.cells || [])) {
            cells.push(clean(cell.textContent));
            for (let i = 1; i < (Number(cell.colSpan) || 1); i++) cells.push('');
        }
        return cells.join('\t').replace(/\t+$/, '');
    }).filter(line => line.trim()).join('\n');
}

// Visible text as lines: blank lines and the template's indentation dropped.
// innerText follows the line breaks the reader sees (a <br> is one); outside
// a laid-out page there is only textContent.
export function blockText(el) {
    const raw = el ? (typeof el.innerText === 'string' ? el.innerText : el.textContent) : '';
    return String(raw || '').split('\n')
        .map(line => line.replace(/[ \t ]+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
}
