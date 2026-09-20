// Which parameters tell one run from another.
//
// Overlaying the same curve from a dozen simulations, the hover names the file
// and nothing else, and a filename is rarely what the runs differ BY: tuning a
// PID, what you want to read off the curve is Kp, Ki, Kd (#51).
//
// The report ends "no estoy seguro cómo se podría configurar esto. Tiene que
// ser fácil e intuitivo", so nothing is configured. The parameters worth
// showing are the ones that DIFFER across the loaded files — a parameter every
// run shares tells you nothing about which run you are looking at, and one
// that only some files have cannot be compared at all. That leaves exactly the
// axes the batch was swept over, which is what the question "who is who" is
// asking about.
//
// Pure (no DOM, no Plotly) so the offline suite can cover the decision.

// Values are compared as text, which is how they will be shown. Two runs
// recorded as 0.1 and 0.100 are the same tuning written twice, and normalising
// through Number keeps them from reading as a difference.
function comparable(value) {
    if (value === null || value === undefined) return '';
    const n = Number(value);
    if (Number.isFinite(n)) return String(n);
    return String(value).trim();
}

/**
 * @param {Array<{fileId:string, parameters:Record<string, *>}>} files
 * @param {object} [options]
 * @param {number} [options.limit] most to report, so a sweep over forty
 *        parameters does not produce a hover nobody can read. Alphabetical, so
 *        which ones survive the cap does not change as files are added.
 * @returns {string[]} the distinguishing parameter names, in display order
 */
export function distinguishingParameterNames(files, { limit = 4 } = {}) {
    const entries = (Array.isArray(files) ? files : []).filter(file => file && file.parameters);
    // One run has nothing to be told apart from.
    if (entries.length < 2) return [];

    const counts = new Map();
    const values = new Map();
    for (const { parameters } of entries) {
        for (const [name, value] of Object.entries(parameters)) {
            counts.set(name, (counts.get(name) || 0) + 1);
            if (!values.has(name)) values.set(name, new Set());
            values.get(name).add(comparable(value));
        }
    }

    return [...counts.keys()]
        // Present everywhere: a parameter only some runs carry cannot say which
        // run this is, it says which files were loaded.
        .filter(name => counts.get(name) === entries.length)
        .filter(name => values.get(name).size > 1)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, Math.max(0, limit));
}

/**
 * The label for one file: `Kp=2.5 · Ki=0.1`, or '' when there is nothing to
 * say. Values are formatted by the caller, which knows the app's number
 * formatting; this only decides what goes in and in what order.
 */
export function runParameterLabel(names, parameters, format = String) {
    if (!Array.isArray(names) || !names.length || !parameters) return '';
    return names
        .filter(name => parameters[name] !== undefined && parameters[name] !== null)
        .map(name => `${name}=${format(parameters[name])}`)
        .join(' · ');
}
