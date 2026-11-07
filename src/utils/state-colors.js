// Colours of the state bands (docs/state-band-design.md).
//
// Not the trace palette (PlotManager.COLORS): a band the colour of a curve on
// the same panel would claim a link that is not there, and that palette fails
// the colour-vision checks for values drawn side by side. These are the eight
// categorical steps validated with every pair adjacent (a band can put any two
// values next to each other), with their own steps for the dark surface. The
// first three clear every check in both themes; past three some pairs fall
// below the floors, which is why a band never relies on colour alone: the
// value is written inside its run when it fits, it is in the hover, slots 9 to
// 16 repeat the hues with a hatch, and runs are separated by a hairline of the
// background.

export const STATE_PALETTE_LIGHT = [
    '#2a78d6', '#eb6834', '#1baf7a', '#eda100',
    '#e87ba4', '#008300', '#6250d6', '#e34948',
];
export const STATE_PALETTE_DARK = [
    '#3987e5', '#d95926', '#199e70', '#c98500',
    '#d55181', '#008300', '#9085e9', '#e66767',
];
/** Two greys a band alternates when it has too many values to colour. */
export const STATE_NEUTRALS_LIGHT = ['#9e9e9e', '#cfcfcf'];
export const STATE_NEUTRALS_DARK = ['#6e6e6e', '#4a4a4a'];
/** Hatch of the slots past the first eight (Plotly marker.pattern.shape). */
export const STATE_HATCH = '/';

/** Fill and hatch of colour slot `slot` (0-based). */
export function stateSlotStyle(slot, dark = false) {
    const palette = dark ? STATE_PALETTE_DARK : STATE_PALETTE_LIGHT;
    const index = Math.max(0, Math.floor(Number(slot) || 0));
    return {
        color: palette[index % palette.length],
        pattern: index >= palette.length ? STATE_HATCH : '',
    };
}

/** Grey of a band past the value cap, alternating per run. */
export function stateNeutralColor(index, dark = false) {
    const greys = dark ? STATE_NEUTRALS_DARK : STATE_NEUTRALS_LIGHT;
    return greys[Math.abs(Math.floor(Number(index) || 0)) % 2];
}

/**
 * Give every value of `values` not yet in `map` the next free slot, in the
 * order given. `map` is a Map<string, slot>, owned by the panel: a value has
 * one colour in every band of the panel, and a value seen first keeps its
 * colour when another arrives (a zoom never repaints, a live update only adds).
 */
export function assignStateSlots(map, values) {
    for (const value of values || []) {
        if (value === '' || map.has(value)) continue;
        map.set(value, map.size);
    }
    return map;
}

function channel(c) {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a #rrggbb colour. */
export function relativeLuminance(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
    if (!m) return 0;
    const [r, g, b] = [m[1], m[2], m[3]].map(h => channel(parseInt(h, 16)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two #rrggbb colours. */
export function contrastRatio(a, b) {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}

export const STATE_INK_DARK = '#111111';
export const STATE_INK_LIGHT = '#ffffff';

/** The text colour that reads best on a run of colour `fill`. */
export function stateInkFor(fill) {
    return contrastRatio(fill, STATE_INK_DARK) >= contrastRatio(fill, STATE_INK_LIGHT)
        ? STATE_INK_DARK
        : STATE_INK_LIGHT;
}
