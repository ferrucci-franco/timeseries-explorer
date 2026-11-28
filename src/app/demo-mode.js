// Demo mode: the copy of the app that runs inside the animated guide's frame
// (src/ui/guide.js), opened as `index.html?demo&lang=…&theme=…`.
//
// A script drives that copy to show a feature, and the frame is loaded afresh
// for every run. So it must behave like a first visit every time, and leave no
// trace: nothing read from or written to the browser's storage, no page view
// counted, no first-visit hints, the desktop layout whatever the screen, and
// the in-memory CSV reader (the query engine keeps a database in the origin's
// private file system, which the app around the frame is already using).
//
// One demo shows the phone layout: its frame is opened as
// `?demo&layout=compact&…`, at a phone's size. That copy uses the phone layout
// whatever the screen, and takes itself for a touch screen — the guide plays
// it with a finger (touch events) on a computer that may have none, and the
// plots only listen to fingers where there is a touch screen.

const params = (() => {
    try {
        return new URLSearchParams(globalThis.location?.search || '');
    } catch (_) {
        return new URLSearchParams('');
    }
})();

export const DEMO_MODE = params.has('demo');

/** The layout of the guide's frame: 'full' (desktop), or 'compact' for the demo of the phone layout. */
export const DEMO_LAYOUT = DEMO_MODE && params.get('layout') === 'compact' ? 'compact' : 'full';

// isTouchCapable() (src/ui/touch-drag.js) asks for this property, or for
// touch points the browser reports; a script cannot give it the second.
if (DEMO_LAYOUT === 'compact' && typeof window !== 'undefined' && !('ontouchstart' in window)) {
    window.ontouchstart = null;
}

export function demoParam(name) {
    return DEMO_MODE ? params.get(name) : null;
}

/**
 * A per-viewer convenience kept in the browser's storage — a collapsed
 * section, a panel's height, a hint already seen.
 *
 * In demo mode these do nothing and read nothing: the frame shares its origin
 * with the app around it, so a write here would be a trace left in the real
 * app's storage, and a read would make the demo depend on what that person
 * happened to do before (`scripts/e2e-guide.mjs` checks both). Storage can
 * also be unavailable or full, so every call is guarded.
 */
export function readLocal(key) {
    if (DEMO_MODE) return null;
    try { return globalThis.localStorage?.getItem(key) ?? null; } catch (_) { return null; }
}

export function writeLocal(key, value) {
    if (DEMO_MODE) return;
    try { globalThis.localStorage?.setItem(key, String(value)); } catch (_) { /* not kept */ }
}

export function removeLocal(key) {
    if (DEMO_MODE) return;
    try { globalThis.localStorage?.removeItem(key); } catch (_) { /* not kept */ }
}
