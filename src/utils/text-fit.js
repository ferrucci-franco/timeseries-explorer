// Fitting a label to the room a plot has for it, in characters: Plotly's
// hover labels and axis titles never wrap or shorten on their own, so a long
// name (an extraction's, with the box it was read in) ran off a phone's
// screen, its value with it.

/**
 * Split `text` into lines of at most `max` characters, breaking after a
 * " · ", a comma or a space where it can, and inside a word only when a word
 * alone is longer than a line. `reserve` characters are kept free on the last
 * line, for what follows it (" = 277.8 K" in a hover label).
 */
export function wrapText(text, max, { reserve = 0 } = {}) {
    const source = String(text ?? '');
    if (!(max > 0) || source.length <= max - reserve) return [source];
    const lines = [];
    let rest = source;
    while (rest.length > max) {
        const window = rest.slice(0, max + 1);
        let cut = -1;
        for (const separator of [' · ', ', ', ' ']) {
            const at = window.lastIndexOf(separator);
            if (at > max * 0.3) {
                cut = at + separator.length;
                break;
            }
        }
        if (cut <= 0) cut = max;
        lines.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    if (rest) lines.push(rest);
    // The last line, with what follows it, must fit too.
    const last = lines[lines.length - 1];
    if (reserve > 0 && last.length > max - reserve && max - reserve > 8) {
        lines.splice(lines.length - 1, 1, ...wrapText(last, max - reserve));
    }
    return lines;
}

/** `text` cut to `max` characters, ending in "…" when it was cut. */
export function fitText(text, max) {
    const source = String(text ?? '');
    if (!(max > 1) || source.length <= max) return source;
    return `${source.slice(0, max - 1).trimEnd()}…`;
}
