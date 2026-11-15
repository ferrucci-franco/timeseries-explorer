// A trace's colour and its place among the plot's traces (#371): the pure
// part, with no DOM or Plotly, so it is unit-tested on its own
// (scripts/test-legend-trace-menu.mjs). The menu and the popover that use it
// are in plots/methods/trace-style-methods.js.
//
// A colour belongs to the trace state (plot.traces[i].color, or a pair's in
// plot.phaseTraces), and every analysis draws a series in the colour of its
// trace state, so changing it there recolours them all. The order is the
// order of that array: the legend lists it, and the last is drawn on top.

// The palette offered first: the colours a new trace gets (PlotManager.COLORS),
// then eight more that read on a light and a dark background alike.
export const TRACE_COLOR_SWATCHES = [
    '#2196f3', '#ff5722', '#4caf50', '#ff9800', '#9c27b0', '#00bcd4', '#f44336', '#8bc34a',
    '#3f51b5', '#e91e63', '#009688', '#795548', '#607d8b', '#cddc39', '#ffc107', '#673ab7',
];

export const TRACE_MOVES = ['up', 'down', 'first', 'last'];

const clampByte = value => Math.max(0, Math.min(255, Math.round(value)));
const hexByte = value => clampByte(value).toString(16).padStart(2, '0');

function hslToHex(h, s, l) {
    const hue = ((h % 360) + 360) % 360;
    const sat = Math.max(0, Math.min(1, s));
    const lum = Math.max(0, Math.min(1, l));
    const c = (1 - Math.abs(2 * lum - 1)) * sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = lum - c / 2;
    const [r, g, b] = hue < 60 ? [c, x, 0]
        : hue < 120 ? [x, c, 0]
        : hue < 180 ? [0, c, x]
        : hue < 240 ? [0, x, c]
        : hue < 300 ? [x, 0, c]
        : [c, 0, x];
    return `#${hexByte((r + m) * 255)}${hexByte((g + m) * 255)}${hexByte((b + m) * 255)}`;
}

// A colour as '#rrggbb' (what a session saves), or null when it is
// none the app writes: '#rgb', '#rrggbb', 'rgb(…)' and the 'hsl(…)' a trace
// gets once the palette is used up (PlotManager._nextTraceColor).
export function traceColorHex(color) {
    const text = String(color ?? '').trim().toLowerCase();
    let match = /^#([0-9a-f]{6})$/.exec(text);
    if (match) return `#${match[1]}`;
    match = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
    if (match) return `#${match[1]}${match[1]}${match[2]}${match[2]}${match[3]}${match[3]}`;
    match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(text);
    if (match) return `#${hexByte(+match[1])}${hexByte(+match[2])}${hexByte(+match[3])}`;
    match = /^hsla?\(\s*([-\d.]+)(?:deg)?\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/.exec(text);
    if (match) return hslToHex(+match[1], +match[2] / 100, +match[3] / 100);
    return null;
}

const clampUnit = value => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

// The picker of a colour of one's own works in hue (0–360), saturation and
// value (0–1): a square of saturation by value, and a strip of hue beside it.
// A hex colour as that triple; null when it is not a colour (traceColorHex).
export function hexToHsv(color) {
    const hex = traceColorHex(color);
    if (!hex) return null;
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b);
    const delta = max - Math.min(r, g, b);
    let h = 0;
    if (delta > 0) {
        h = max === r ? ((g - b) / delta) % 6
            : max === g ? (b - r) / delta + 2
            : (r - g) / delta + 4;
        h = (h * 60 + 360) % 360;
    }
    return { h, s: max === 0 ? 0 : delta / max, v: max };
}

// And back: the '#rrggbb' of a hue, saturation and value.
export function hsvToHex(h, s, v) {
    const hue = (((Number.isFinite(h) ? h : 0) % 360) + 360) % 360;
    const sat = clampUnit(s);
    const val = clampUnit(v);
    const c = val * sat;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = val - c;
    const [r, g, b] = hue < 60 ? [c, x, 0]
        : hue < 120 ? [x, c, 0]
        : hue < 180 ? [0, c, x]
        : hue < 240 ? [0, x, c]
        : hue < 300 ? [x, 0, c]
        : [c, 0, x];
    return `#${hexByte((r + m) * 255)}${hexByte((g + m) * 255)}${hexByte((b + m) * 255)}`;
}

// Where `where` puts the item at `index` in a list of `length`, or -1 when it
// would stay where it is (a move that does nothing is offered disabled).
export function traceMoveTarget(length, index, where) {
    if (!Number.isInteger(index) || index < 0 || index >= length) return -1;
    const target = where === 'up' ? index - 1
        : where === 'down' ? index + 1
        : where === 'first' ? 0
        : where === 'last' ? length - 1
        : index;
    return target === index || target < 0 || target >= length ? -1 : target;
}

// Which moves do something for `item` of `list`: { up, down, first, last }.
export function traceMovesAvailable(list, item) {
    const items = Array.isArray(list) ? list : [];
    const index = items.indexOf(item);
    return Object.fromEntries(TRACE_MOVES.map(where =>
        [where, traceMoveTarget(items.length, index, where) >= 0]));
}

// Moves `item` within `list` in place; true when the order changed.
export function moveTraceInList(list, item, where) {
    if (!Array.isArray(list)) return false;
    const index = list.indexOf(item);
    const target = traceMoveTarget(list.length, index, where);
    if (target < 0) return false;
    list.splice(index, 1);
    list.splice(target, 0, item);
    return true;
}

// Sets `trace.color` to a colour the app can draw; true when it changed.
// A colour it cannot read is refused rather than stored.
export function setTraceColor(trace, color) {
    if (!trace) return false;
    const hex = traceColorHex(color);
    if (!hex) return false;
    if (traceColorHex(trace.color) === hex) return false;
    trace.color = hex;
    return true;
}
