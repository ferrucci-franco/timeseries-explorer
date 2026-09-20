// The slice of an ordered list between two of its entries.
//
// Shift+click in a tree of variables means "everything from where I was to
// where I just clicked", and which entries those are is a question about the
// list the user is looking at — its order, and what is currently in it. This
// answers only the slicing; the caller decides what the list contains.
//
// Pure (no DOM) so the offline suite can cover the arithmetic that decides
// which variables a gesture selects.

/**
 * Names from `anchor` to `target` inclusive, in list order, whichever way
 * round they appear.
 *
 * @param {string[]} ordered  the selectable entries, in the order shown
 * @param {string|null} anchor  where the range starts; a name no longer in the
 *        list (a collapsed group, a filter that hid it, a reloaded file) is
 *        treated as no anchor at all
 * @param {string} target  the entry just clicked
 * @returns {string[]} the range, or just the target when there is no usable
 *        anchor, or nothing when the target itself is not in the list
 */
export function namesBetween(ordered, anchor, target) {
    const list = Array.isArray(ordered) ? ordered : [];
    const to = list.indexOf(target);
    // Clicking something the list does not contain selects nothing: it is not
    // a range of one, it is a question about an entry that is not there.
    if (to < 0) return [];
    const from = anchor === null || anchor === undefined ? -1 : list.indexOf(anchor);
    // A stale anchor degrades to a plain click rather than to the whole list:
    // selecting everything because the starting point scrolled out of view is
    // the kind of surprise that costs a re-plot.
    if (from < 0) return [target];
    return from <= to ? list.slice(from, to + 1) : list.slice(to, from + 1);
}
