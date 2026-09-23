// Variable names set apart inside a sentence.
//
// A message such as "delta, delta2 were built from Left without 165Hz" reads as
// one run of words: nothing tells where a name starts or ends. The names are
// wrapped in a private marker when the sentence is assembled, and each place
// that shows it turns the marker into what it can render: bold in the DOM,
// <strong> in HTML (escaped — names come from files), quotes in a tooltip.

const MARK = '\u0001';

// One name, marked for emphasis. Marker characters inside it are dropped so a
// name can never close the emphasis early.
export function emphasize(name) {
    return `${MARK}${String(name ?? '').split(MARK).join('')}${MARK}`;
}

// Several names, each marked, in a comma-separated list.
export function emphasizeList(names) {
    return (names || []).map(emphasize).join(', ');
}

// Into an element: plain text for the prose, <strong> for the names. No HTML is
// parsed, so a name cannot inject markup.
export function setEmphasizedText(element, text) {
    if (!element) return;
    element.textContent = '';
    const doc = element.ownerDocument || globalThis.document;
    String(text ?? '').split(MARK).forEach((part, index) => {
        if (!part) return;
        if (index % 2 === 1 && doc?.createElement) {
            const strong = doc.createElement('strong');
            strong.textContent = part;
            element.appendChild(strong);
        } else if (doc?.createTextNode) {
            element.appendChild(doc.createTextNode(part));
        } else {
            element.textContent += part;
        }
    });
}

const escapeHTML = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// As HTML, for a dialog that takes markup: everything escaped, names in <strong>.
export function emphasizedToHtml(text) {
    return String(text ?? '').split(MARK)
        .map((part, index) => (index % 2 === 1 ? `<strong>${escapeHTML(part)}</strong>` : escapeHTML(part)))
        .join('');
}

// As plain text, for a tooltip, which cannot be bold: names in quotes.
export function emphasizedToPlain(text) {
    return String(text ?? '').split(MARK)
        .map((part, index) => (index % 2 === 1 ? `“${part}”` : part))
        .join('');
}
