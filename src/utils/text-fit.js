// Fitting a label to the room a plot has for it, in characters: Plotly's
// hover labels and axis titles never wrap or shorten on their own, so a long
// name (an extraction's, with the box it was read in) ran off a phone's
// screen, its value with it. Used by utils/plot-text-fit.js.

// ── Plotly's markup ──────────────────────────────────────────────────────
// Hover templates and axis titles are Plotly's pseudo-HTML: <b>, <i>, <sup>,
// <span style>, <br>, and %{…} placeholders filled at hover time. The two
// functions below count only what is shown, break or cut between words of
// the text, and close the tags still open at a break (opening them again on
// the next line), so the markup stays whole.

const MARKUP_PIECE = /(<[^>]*>|%\{[^}]*\})/;
// A placeholder's text is not known here: a number with its unit, mostly.
const PLACEHOLDER_CHARS = 10;

const tagName = (tag) => (/^<\/?\s*([a-z0-9]+)/i.exec(tag)?.[1] || '').toLowerCase();

function* markupPieces(markup) {
    for (const piece of String(markup ?? '').split(MARKUP_PIECE)) {
        if (!piece) continue;
        if (piece.startsWith('<')) yield { kind: 'tag', text: piece };
        else if (piece.startsWith('%{')) yield { kind: 'placeholder', text: piece };
        else yield { kind: 'text', text: piece };
    }
}

/** How many characters `markup` shows (a placeholder counted as a number). */
export function markupLength(markup) {
    let length = 0;
    for (const piece of markupPieces(markup)) {
        if (piece.kind === 'text') length += piece.text.length;
        else if (piece.kind === 'placeholder') length += piece.text === '%{hovertext}' ? 0 : PLACEHOLDER_CHARS;
    }
    return length;
}

/**
 * Break every line of `markup` (lines are separated by <br>) longer than `max`
 * shown characters, between words; `reserve` characters are kept free at the
 * end of a line that ends in a placeholder's value (" = %{y}").
 */
export function wrapMarkup(markup, max) {
    const source = String(markup ?? '');
    if (!(max > 0) || !Number.isFinite(max)) return source;
    if (!source.split(/<br\s*\/?>/i).some(line => markupLength(line) > max)) return source;
    const open = [];
    let out = '';
    let length = 0;
    const breakLine = () => {
        out += open.slice().reverse().map(tag => `</${tagName(tag)}>`).join('') + '<br>' + open.join('');
        length = 0;
    };
    for (const piece of markupPieces(source)) {
        if (piece.kind === 'tag') {
            const name = tagName(piece.text);
            if (name === 'br') {
                out += piece.text;
                length = 0;
            } else if (piece.text.startsWith('</')) {
                const at = open.map(tagName).lastIndexOf(name);
                if (at >= 0) open.splice(at, 1);
                out += piece.text;
            } else {
                if (!piece.text.endsWith('/>') && name !== 'extra') open.push(piece.text);
                out += piece.text;
            }
            continue;
        }
        if (piece.kind === 'placeholder') {
            const size = piece.text === '%{hovertext}' ? 0 : PLACEHOLDER_CHARS;
            if (length > 0 && length + size > max) breakLine();
            out += piece.text;
            length += size;
            continue;
        }
        // Text: word by word, the spaces kept with the word before them.
        for (const word of piece.text.match(/\S+\s*|\s+/g) || []) {
            const shown = word.trimEnd().length;
            if (length > 0 && length + shown > max) {
                breakLine();
                const trimmed = word.trimStart();
                out += trimmed;
                length += trimmed.length;
                continue;
            }
            out += word;
            length += word.length;
        }
    }
    return out;
}

/**
 * `markup` cut to `max` shown characters, between words where it can, ending
 * in "…" with every tag still open closed.
 */
export function fitMarkup(markup, max) {
    const source = String(markup ?? '');
    if (!(max > 1) || markupLength(source) <= max) return source;
    const open = [];
    let out = '';
    let length = 0;
    let done = false;
    for (const piece of markupPieces(source)) {
        if (done) break;
        if (piece.kind === 'tag') {
            const name = tagName(piece.text);
            if (name === 'br') {
                out += ' ';
                length += 1;
            } else if (piece.text.startsWith('</')) {
                const at = open.map(tagName).lastIndexOf(name);
                if (at >= 0) open.splice(at, 1);
                out += piece.text;
            } else {
                if (!piece.text.endsWith('/>')) open.push(piece.text);
                out += piece.text;
            }
            continue;
        }
        const room = max - 1 - length;
        if (piece.kind === 'placeholder') {
            if (PLACEHOLDER_CHARS > room) { done = true; break; }
            out += piece.text;
            length += PLACEHOLDER_CHARS;
            continue;
        }
        if (piece.text.length <= room) {
            out += piece.text;
            length += piece.text.length;
            continue;
        }
        const cut = piece.text.slice(0, room + 1);
        const space = cut.lastIndexOf(' ');
        out += (space > room * 0.5 ? cut.slice(0, space) : cut.slice(0, room)).trimEnd();
        done = true;
    }
    return `${out}…${open.slice().reverse().map(tag => `</${tagName(tag)}>`).join('')}`;
}
