/**
 * The top bar's row of controls, when the window is too narrow for it.
 *
 * A small laptop at 125 % scaling, or a window snapped to half the screen, is
 * narrower than the row of buttons. The row used to keep its width and push
 * the last buttons (theme, menu) off the window with no way to reach them. It
 * now scrolls: a touchpad or a finger swipes it, and a mouse wheel turns into
 * a sideways scroll over it, since a mouse has no other way to do that.
 *
 * A slim bar along the bottom of the top bar shows that the row goes on.
 *
 * Scrolling clips whatever overflows the row, and the row's menus open below
 * it. They are therefore placed with fixed coordinates under their button,
 * which overflow does not clip, and follow the button while the row scrolls.
 */

const MENU_GAP = 4;
const WINDOW_MARGIN = 8;

const openMenus = new Map();

// The fades at the ends say there is more, but are easy to miss. A slim bar
// along the bottom of the top bar says it plainly, and shows how much: drawn
// here rather than left to the browser, whose scrollbar is hidden until
// hovered on many systems (Firefox and Windows 11 by default).
//
// `row` is the element that scrolls, or a function returning it for one that
// is replaced as it is redrawn (the tab strip's).
function createScrollbar(topBar, row) {
    const rowOf = typeof row === 'function' ? row : () => row;
    const track = document.createElement('div');
    track.className = 'top-bar-scrollbar';
    track.setAttribute('aria-hidden', 'true');
    track.hidden = true;
    const thumb = document.createElement('div');
    thumb.className = 'top-bar-scrollbar-thumb';
    track.appendChild(thumb);
    topBar.appendChild(track);

    // Dragging the thumb moves the row with it; a click elsewhere on the track
    // brings that part of the row into view.
    const ratio = () => rowOf().scrollWidth / Math.max(1, track.clientWidth);
    thumb.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const row = rowOf();
        if (!row) return;
        const startX = event.clientX;
        const startScroll = row.scrollLeft;
        const scale = ratio();
        thumb.setPointerCapture?.(event.pointerId);
        track.classList.add('is-dragging');
        const move = (e) => { row.scrollLeft = startScroll + (e.clientX - startX) * scale; };
        const end = () => {
            track.classList.remove('is-dragging');
            thumb.removeEventListener('pointermove', move);
            thumb.removeEventListener('pointerup', end);
            thumb.removeEventListener('pointercancel', end);
        };
        thumb.addEventListener('pointermove', move);
        thumb.addEventListener('pointerup', end);
        thumb.addEventListener('pointercancel', end);
    });
    track.addEventListener('pointerdown', (event) => {
        const row = rowOf();
        if (event.target !== track || !row) return;
        event.preventDefault();
        const x = event.clientX - track.getBoundingClientRect().left;
        row.scrollTo({ left: x * ratio() - row.clientWidth / 2, behavior: 'smooth' });
    });
    return track;
}

function updateScrollbar(track, row) {
    const max = row.scrollWidth - row.clientWidth;
    track.hidden = max <= 1;
    if (track.hidden) return;
    track.style.left = `${row.offsetLeft}px`;
    track.style.width = `${row.offsetWidth}px`;
    const width = row.offsetWidth;
    const thumbWidth = Math.max(24, width * row.clientWidth / row.scrollWidth);
    const thumb = track.firstElementChild;
    thumb.style.width = `${thumbWidth}px`;
    thumb.style.transform = `translateX(${(width - thumbWidth) * (row.scrollLeft / max)}px)`;
}

/**
 * The same slim bar for another row of the top bar (the tabs): `getRow`
 * returns the element that scrolls, or null while there is none. Returns the
 * function that brings the bar up to date; call it on every scroll and
 * resize of the row.
 */
export function createTopBarScrollIndicator(topBar, getRow, className = '') {
    const track = createScrollbar(topBar, getRow);
    if (className) track.classList.add(className);
    return () => {
        const row = getRow();
        if (row) updateScrollbar(track, row);
        else track.hidden = true;
    };
}

function createFade(topBar, side) {
    const fade = document.createElement('div');
    fade.className = `top-bar-fade top-bar-fade-${side}`;
    fade.setAttribute('aria-hidden', 'true');
    fade.hidden = true;
    topBar.appendChild(fade);
    return fade;
}

function updateScrollHints(row, hints) {
    const max = row.scrollWidth - row.clientWidth;
    const { track, start, end } = hints || {};
    if (start) {
        start.hidden = !(max > 1 && row.scrollLeft > 1);
        start.style.left = `${row.offsetLeft}px`;
    }
    if (end) {
        end.hidden = !(max > 1 && row.scrollLeft < max - 1);
        end.style.left = `${row.offsetLeft + row.offsetWidth - end.offsetWidth}px`;
    }
    if (track) updateScrollbar(track, row);
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
    // The tab strip of Full Desktop comes out of the same room: as wide as
    // its tabs, between its minimum and half the bar (base.css).
    const tabs = topBar.querySelector('.workspace-tabs:not([hidden])');
    const tabsStyle = tabs ? getComputedStyle(tabs) : null;
    // Its natural width: the tabs it scrolls, plus + and the list button.
    const scroller = tabs?.querySelector('.workspace-tabs-scroll');
    const tabsWanted = tabs ? tabs.scrollWidth - (scroller?.clientWidth || 0) + (scroller?.scrollWidth || 0) : 0;
    const tabsReserve = tabsStyle
        ? Math.max(parseFloat(tabsStyle.minWidth) || 0, Math.min(tabsWanted, topBar.clientWidth / 2))
            + (parseFloat(tabsStyle.marginLeft) || 0) + (parseFloat(tabsStyle.marginRight) || 0)
        : 0;
    const room = topBar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        - row.scrollWidth - tabsReserve;
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
    const hints = topBar ? {
        track: createScrollbar(topBar, row),
        start: createFade(topBar, 'start'),
        end: createFade(topBar, 'end'),
    } : null;
    const refresh = () => {
        if (brand) updateBrand(topBar, brand, row);
        updateScrollHints(row, hints);
        replaceOpenMenus();
    };
    row.addEventListener('scroll', () => {
        updateScrollHints(row, hints);
        replaceOpenMenus();
    }, { passive: true });
    window.addEventListener('resize', refresh);
    if (typeof ResizeObserver === 'function') {
        // The bar for the window, the title for a change of language.
        const observer = new ResizeObserver(refresh);
        observer.observe(topBar || row);
        const title = brand?.querySelector('h1');
        if (title) observer.observe(title);
        // And the tab strip, which grows with every tab added or renamed.
        const tabs = topBar?.querySelector('.workspace-tabs');
        if (tabs) observer.observe(tabs);
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
