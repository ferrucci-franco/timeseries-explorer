// Demo mode: the copy of the app that runs inside the animated guide's frame
// (src/ui/guide.js), opened as `index.html?demo&lang=…&theme=…`.
//
// A script drives that copy to show a feature, and the frame is loaded afresh
// for every run. So it must behave like a first visit every time, and leave no
// trace: nothing read from or written to the browser's storage, no page view
// counted, no first-visit hints, the desktop layout whatever the screen, and
// the in-memory CSV reader (the query engine keeps a database in the origin's
// private file system, which the app around the frame is already using).

const params = (() => {
    try {
        return new URLSearchParams(globalThis.location?.search || '');
    } catch (_) {
        return new URLSearchParams('');
    }
})();

export const DEMO_MODE = params.has('demo');

export function demoParam(name) {
    return DEMO_MODE ? params.get(name) : null;
}
