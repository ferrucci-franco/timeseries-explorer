// Which of a panel's contents survive a change in what a file holds.
//
// Pure: panels in, names out. It lives here rather than in plot-manager.js so
// it can be checked without a browser — the manager imports Plotly.

/**
 * Take off the given panels everything that names a variable the file no
 * longer has.
 *
 * A reload replaces a file's variables wholesale, and one of them can simply
 * be gone: a column dropped from the CSV, a signal removed from the model.
 * The trace builder returns null for a variable that is not there, so the
 * curve vanished — but the entry stayed, in the panel's state, in its legend
 * menu, in the panel statistics and in any view saved afterwards. A panel
 * whose traces were ALL for gone variables was worse: content is counted as
 * `traces.length`, so it went on claiming to have some while drawing nothing.
 *
 * A phase pair needs both of its axes and a state vector needs all of its
 * components, so those go whole rather than half-drawn.
 *
 * Mutates the panels, which is what the caller wants: they are the live state.
 *
 * @param {Iterable<[string, object]>} panelEntries [panelId, plot] pairs
 * @param {string} fileId only this file's traces are judged
 * @param {(name: string) => boolean} present does the new data have it?
 * @returns {{dropped: string[], panels: Set<string>}} the names taken off, and
 *   the panels that changed and must be redrawn
 */
export function dropMissingVariablesFromPanels(panelEntries, fileId, present) {
    const dropped = new Set();
    const panels = new Set();
    const has = (name) => !!name && present(name);

    for (const [panelId, plot] of panelEntries) {
        if (!plot) continue;
        let changed = false;

        if (Array.isArray(plot.traces)) {
            const kept = plot.traces.filter(trace => {
                if (trace?.fileId !== fileId || has(trace?.varName)) return true;
                dropped.add(trace.varName);
                return false;
            });
            if (kept.length !== plot.traces.length) { plot.traces = kept; changed = true; }
        }

        if (Array.isArray(plot.phaseTraces)) {
            const kept = plot.phaseTraces.filter(pair => {
                if (pair?.fileId !== fileId) return true;
                const missing = [pair.x, pair.y, pair.z].filter(Boolean).filter(name => !has(name));
                if (!missing.length) return true;
                missing.forEach(name => dropped.add(name));
                return false;
            });
            if (kept.length !== plot.phaseTraces.length) { plot.phaseTraces = kept; changed = true; }
        }

        const slots = plot.stateSlots;
        if (slots && slots.fileId === fileId) {
            const missing = [...(slots.x || []), ...(slots.dx || [])]
                .filter(Boolean).filter(name => !has(name));
            if (missing.length) {
                missing.forEach(name => dropped.add(name));
                // Emptied rather than removed: the panel reads stateSlots.x
                // directly to decide whether it has content, and an empty
                // vector is how it says it has none.
                plot.stateSlots = { ...slots, x: [], dx: [] };
                changed = true;
            }
        }

        if (changed) panels.add(panelId);
    }

    return { dropped: [...dropped].sort(), panels };
}
