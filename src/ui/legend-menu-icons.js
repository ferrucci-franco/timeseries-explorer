// The icons of the legend's context menu (plot-manager.js,
// _showLegendTraceMenu): one per action, before its label.
//
// Drawn like the rest of the app's icons (the toolbar, the corner buttons, the
// phone layout): a 24×24 box of round-capped strokes in currentColor, so they
// take the menu's text colour in either theme. They are decorative: the label
// stays the button's accessible name.

const ATTRS = 'viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';

const svg = body => `<svg ${ATTRS}>${body}</svg>`;

export const LEGEND_MENU_ICONS = {
    // Show / Hide: the eye, open or struck through, for what the action does.
    show: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    hide: svg('<path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.6 3.5"/>'
        + '<path d="M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7a9.9 9.9 0 0 0 5.4-1.6"/>'
        + '<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3 3l18 18"/>'),
    // Only this trace: a target, the one picked out.
    only: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>'),
    // Remove: the bin (drawn in the danger colour by the menu's CSS).
    remove: svg('<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/>'
        + '<path d="M6 7l1 13h10l1-13"/><path d="M9 7V4h6v3"/>'),
    // To the right / left Y axis: an arrow to the axis on that side.
    axisRight: svg('<path d="M20 4v16"/><path d="M4 12h12M12 8l4 4-4 4"/>'),
    axisLeft: svg('<path d="M4 4v16"/><path d="M20 12H8M12 8l-4 4 4 4"/>'),
    // Line shape: the steps, or the straight line, the action switches to.
    stairs: svg('<path d="M3 19h5v-6h5V7h5V3"/>'),
    linear: svg('<path d="M4 19L20 5"/>'),
    // Colour: a swatch of paint.
    color: svg('<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.8 1.7-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-.9.8-1.7 1.7-1.7H16a5 5 0 0 0 5-5c0-4-4-7.2-9-7.2z"/>'
        + '<circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7" r="1"/>'),
    // Order: one step up or down, or all the way to an end (the bar).
    moveUp: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
    moveDown: svg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
    moveFirst: svg('<path d="M5 4h14"/><path d="M12 20V9M7 13l5-5 5 5"/>'),
    moveLast: svg('<path d="M5 20h14"/><path d="M12 4v11M7 11l5 5 5-5"/>'),
};

export function legendMenuIcon(name) {
    return LEGEND_MENU_ICONS[name] || '';
}
