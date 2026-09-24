/**
 * The little control that collapses a panel from its own edge.
 *
 * Both panels it serves could already be collapsed — the sidebar from the top
 * bar, an analysis options panel from its toolbar — but only from somewhere
 * else on screen. The top bar itself has no other control: once it is gone,
 * the pill on its lower edge is the only way back. The hand is at the panel's border, having just resized it or
 * just read the last control in it, and had to travel to a toolbar to put the
 * panel away.
 *
 * The rail is what makes this possible without touching the layout: a flex item
 * of zero width, sitting exactly where the two panels meet, that the button
 * hangs off. Nothing moves, and the divider keeps the width it has always had —
 * the pill floats over it.
 */
import i18n from '../i18n/index.js';

// One chevron, pointing left, turned by CSS for the other three cases: a rail
// on the right points the other way, and collapsing flips it again.
const CHEVRON = '<svg class="edge-toggle-chevron" viewBox="0 0 8 16" aria-hidden="true" focusable="false">'
    + '<path d="M6 2.5 1.8 8 6 13.5" fill="none" stroke="currentColor" stroke-width="1.6"'
    + ' stroke-linecap="round" stroke-linejoin="round"/></svg>';

function applyState(button, collapsed) {
    button.classList.toggle('is-collapsed', !!collapsed);
    const label = i18n.t(collapsed ? button.dataset.showKey : button.dataset.hideKey);
    button.title = label;
    button.setAttribute('aria-label', label);
    // aria-expanded, not aria-pressed: this is a disclosure for the panel
    // beside it, the same thing the toolbar button reports.
    button.setAttribute('aria-expanded', String(!collapsed));
}

/**
 * @param {object} options
 * @param {'left'|'right'|'top'} options.side which side of the rail the panel is on
 * @param {boolean} options.collapsed the panel's state right now
 * @param {string} options.hideKey translation key for the collapsing action
 * @param {string} options.showKey translation key for the restoring action
 * @param {() => void} options.onToggle
 * @returns {HTMLDivElement} the rail, to be inserted where the panels meet
 */
export function createEdgeToggle({ side, collapsed = false, hideKey, showKey, onToggle }) {
    const rail = document.createElement('div');
    const railSide = side === 'right' || side === 'top' ? side : 'left';
    rail.className = `edge-toggle-rail edge-toggle-rail-${railSide}`;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'edge-toggle';
    button.dataset.hideKey = hideKey;
    button.dataset.showKey = showKey;
    button.innerHTML = CHEVRON;
    button.addEventListener('click', (event) => {
        // A panel's own click handling (legend menus, panel focus) must not
        // also fire: the pill is about the panel's frame, not its contents.
        event.preventDefault();
        event.stopPropagation();
        onToggle();
    });
    // The sidebar's resize proxy sits on this same edge and starts a drag on
    // pointerdown. Without this the pill would begin a resize under the finger
    // and the click that follows would read as an accidental one.
    button.addEventListener('pointerdown', (event) => event.stopPropagation());

    rail.appendChild(button);
    applyState(button, collapsed);
    return rail;
}

/** Bring the control back in step after the panel was collapsed from elsewhere. */
export function syncEdgeToggle(root, collapsed) {
    const button = root?.querySelector?.('.edge-toggle');
    if (button) applyState(button, collapsed);
}
