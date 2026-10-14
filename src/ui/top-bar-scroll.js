/**
 * The top bar's row of controls, when the window is too narrow for it.
 *
 * A small laptop at 125 % scaling, or a window snapped to half the screen, is
 * narrower than the row of buttons. The row used to keep its width and push
 * the last buttons (theme, menu) off the window with no way to reach them. It
 * now scrolls: a touchpad or a finger swipes it, and a mouse wheel turns into
 * a sideways scroll over it, since a mouse has no other way to do that.
 *
 * Scrolling clips whatever overflows the row, and the row's menus open below
 * it. They are therefore placed with fixed coordinates under their button,
 * which overflow does not clip, and follow the button while the row scrolls.
 */

const MENU_GAP = 4;
const WINDOW_MARGIN = 8;

const openMenus = new Map();

function updateScrollHints(row) {
    const max = row.scrollWidth - row.clientWidth;
    row.classList.toggle('can-scroll-left', max > 1 && row.scrollLeft > 1);
    row.classList.toggle('can-scroll-right', max > 1 && row.scrollLeft < max - 1);
}

function place(menu, anchor) {
    const rect = anchor.getBoundingClientRect();
    menu.style.position = 'fixed';
    menu.style.top = `${Math.round(rect.bottom + MENU_GAP)}px`;
    menu.style.bottom = 'auto';
    // Right-aligned under its button, as before, but never past either edge
    // of the window: with the row scrolled, a button can sit near the left.
    const width = menu.offsetWidth;
    const viewport = document.documentElement.clientWidth;
    // Anchored by its right edge, so a menu that re-renders while open (the
    // live update menu does) keeps lining up with its button.
    const right = Math.min(rect.right, viewport - WINDOW_MARGIN);
    if (right - width < WINDOW_MARGIN) {
        menu.style.left = `${WINDOW_MARGIN}px`;
        menu.style.right = 'auto';
    } else {
        menu.style.left = 'auto';
        menu.style.right = `${Math.round(viewport - right)}px`;
    }
}

function replaceOpenMenus() {
    for (const [menu, anchor] of openMenus) {
        if (menu.hidden || !menu.isConnected) openMenus.delete(menu);
        else place(menu, anchor);
    }
}

/**
 * Position a top bar menu that has just been shown under its anchor (the
 * button, or the wrapper of a split button).
 */
export function placeTopBarMenu(menu, anchor) {
    if (!menu || !anchor) return;
    place(menu, anchor);
    openMenus.set(menu, anchor);
}

// The brand (title, subtitle, runtime badge) shrinks first, its subtitle
// ending in an ellipsis. When even that is too much the badge goes, then the
// whole brand: a sliver of a clipped "T" next to the language buttons only
// looks broken. A squeezed brand stays in the layout, invisible, so its title
// can still be measured to decide when it fits again.
let badgeWidth = 0;

function updateBrand(topBar, brand, row) {
    const title = brand.querySelector('h1');
    if (!title) return;
    const badge = brand.querySelector('.runtime-badge');
    if (badge?.offsetWidth) badgeWidth = badge.offsetWidth;
    const style = getComputedStyle(topBar);
    const room = topBar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        - row.scrollWidth;
    const gap = parseFloat(getComputedStyle(brand).columnGap) || 0;
    // The text, not the heading: a block, it is as wide as the brand.
    const range = document.createRange();
    range.selectNodeContents(title);
    const titleWidth = Math.ceil(range.getBoundingClientRect().width) + gap;
    brand.classList.toggle('is-squeezed', room < titleWidth);
    brand.classList.toggle('without-badge', room < titleWidth + badgeWidth + gap);
}

/** Make the row scroll sideways when it does not fit. Call once. */
export function initTopBarScroll(row) {
    if (!row) return;
    const topBar = row.closest('.top-bar');
    const brand = topBar?.querySelector('.top-bar-left');
    const refresh = () => {
        if (brand) updateBrand(topBar, brand, row);
        updateScrollHints(row);
        replaceOpenMenus();
    };
    row.addEventListener('scroll', () => {
        updateScrollHints(row);
        replaceOpenMenus();
    }, { passive: true });
    window.addEventListener('resize', refresh);
    if (typeof ResizeObserver === 'function') {
        // The bar for the window, the title for a change of language.
        const observer = new ResizeObserver(refresh);
        observer.observe(topBar || row);
        const title = brand?.querySelector('h1');
        if (title) observer.observe(title);
    }

    row.addEventListener('wheel', (event) => {
        if (event.ctrlKey || row.scrollWidth <= row.clientWidth) return;
        // A menu scrolls its own content; a sideways gesture already scrolls
        // the row by itself.
        if (event.target.closest?.('.example-menu')) return;
        if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
        const lineScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? row.clientWidth : 1;
        const before = row.scrollLeft;
        row.scrollLeft += event.deltaY * lineScale;
        if (row.scrollLeft !== before) event.preventDefault();
    }, { passive: false });

    refresh();
}
