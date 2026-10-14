// Where the A and B tabs of the measurement cursors sit, on the phone layout.
//
// A cursor is a line the height of the plot. A mouse grabs it to the pixel; a
// finger covers forty of them, hides the line it reaches for, and on a plot
// where one finger pans, a line grabbed anywhere along its height takes the
// pan away from a whole strip of the screen. So on a phone each cursor gets a
// tab at the foot of its line: a target the size of a finger, in the one place
// a finger knows to look for it.
//
// Two rules keep the tabs usable:
//  - a cursor outside the view leaves its tab at the edge it went past, so it
//    can be dragged back in instead of being lost off screen;
//  - two tabs closer than a tab's width are not drawn on top of each other:
//    B's goes one row up.
//
// Coordinates are pixels in the plot's own frame (the div Plotly draws in).

export const CURSOR_HANDLE_SIZE = 28;
// Half a 44 px touch target, around the centre of a tab.
export const CURSOR_HANDLE_REACH = 22;
const ROW_GAP = 6;
const EDGE_INSET = 4;

/**
 * @param {{left:number, right:number, bottom:number, a:number, b:number, size?:number}} geometry
 *   left/right/bottom: the plotting area; a/b: each cursor's pixel (NaN when it has none)
 * @returns {Array<{which:'a'|'b', x:number, y:number, side:null|'left'|'right'}>}
 */
export function cursorHandleLayout({ left, right, bottom, a, b, size = CURSOR_HANDLE_SIZE }) {
    if (![left, right, bottom].every(Number.isFinite) || right <= left) return [];
    const half = size / 2;
    const place = (which, px) => {
        if (!Number.isFinite(px)) return null;
        if (px < left) return { which, x: left + half + EDGE_INSET, side: 'left' };
        if (px > right) return { which, x: right - half - EDGE_INSET, side: 'right' };
        return { which, x: px, side: null };
    };
    const handles = [place('a', a), place('b', b)].filter(Boolean);
    const row = bottom - half - ROW_GAP;
    for (const handle of handles) handle.y = row;
    if (handles.length === 2 && Math.abs(handles[0].x - handles[1].x) < size + ROW_GAP) {
        handles[1].y = row - size - ROW_GAP;
    }
    return handles;
}

/**
 * The tab under a point, if any: the nearest one within reach.
 * @returns {{which:'a'|'b', x:number, y:number, side:null|'left'|'right'}|null}
 */
export function cursorHandleAt(handles, x, y, reach = CURSOR_HANDLE_REACH) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const handle of handles || []) {
        const dx = Math.abs(x - handle.x);
        const dy = Math.abs(y - handle.y);
        if (dx > reach || dy > reach) continue;
        const distance = Math.hypot(dx, dy);
        if (distance < bestDistance) {
            best = handle;
            bestDistance = distance;
        }
    }
    return best;
}
