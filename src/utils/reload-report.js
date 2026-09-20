// What a reload has to say for itself, once it is over.
//
// Re-reading a file can change what is under the app's feet in two ways: a
// signal can be gone (its traces go with it), and a derived dataset — a
// resample, a cross-correlation — can stop being computable from what is left.
//
// Neither is a question. The file is already being replaced, and there is
// nothing for the user to decide halfway through, so nothing here stops the
// reload to ask: both are collected and said once, after the overlay is down.

/**
 * Why a dataset could not be recomputed, in words.
 *
 * The tools throw a DataToolError whose message is a TRANSLATION KEY
 * (`dataToolChooseVariable`), so printing `err.message` puts the key itself in
 * front of the user. Translate it when there is a translation; fall back to a
 * real message; and say nothing rather than print a key.
 *
 * @param {unknown} err        the error a recompute threw
 * @param {(key: string) => string} translate  i18n.t, which returns the key when it has no translation
 * @returns {string} a sentence, or '' when all that is known is a key
 */
export function datasetFailureText(err, translate = (key) => key) {
    const code = err?.code || '';
    if (code) {
        const translated = translate(code);
        if (translated && translated !== code) return String(translated);
    }
    const message = err?.message ? String(err.message) : '';
    if (message && message !== code) {
        const translated = translate(message);
        if (translated && translated !== message) return String(translated);
        // A key is recognisable: one word, no spaces, camelCase. Anything else
        // is a message someone wrote to be read.
        if (!/^[a-z][A-Za-z0-9]*$/.test(message)) return message;
    }
    return '';
}

/**
 * The sections of the one notice a reload shows, in the order they are read:
 * what disappeared first (it changed the panels), then what could not be
 * recomputed (it is still on screen, but stale).
 *
 * @param {{dropped?: string[], failures?: {name: string, reason?: string}[]}} outcome
 * @returns {{kind: 'dropped'|'datasets', items: any[]}[]} empty when there is nothing to say
 */
export function reloadNoticeSections({ dropped = [], failures = [] } = {}) {
    const sections = [];
    const names = (dropped || []).filter(name => typeof name === 'string' && name);
    if (names.length) sections.push({ kind: 'dropped', items: names });
    const datasets = (failures || [])
        .filter(failure => failure && failure.name)
        .map(failure => ({ name: String(failure.name), reason: failure.reason ? String(failure.reason) : '' }));
    if (datasets.length) sections.push({ kind: 'datasets', items: datasets });
    return sections;
}
