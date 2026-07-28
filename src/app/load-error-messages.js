// Turns the failures that can end a file load into something worth reading.
//
// loadFile already catches everything and shows an app dialog, so structurally
// the user never sees a raw browser error page. What they did see was an app
// dialog with a raw V8 string inside it:
//
//   "Cannot create a string longer than 0x1fffffe8 characters"
//   "Array buffer allocation failed"
//   "Worker crashed"
//
// Cosmetically ours, substantively not. This maps the failures we know how to
// explain onto translated messages, and passes anything else through unchanged
// rather than inventing an explanation for it.
//
// Pure on purpose — no i18n, no DOM — so the table can be tested directly and
// so the same mapping can be reused anywhere a load can fail.

// Ordered: the first match wins, so put the specific patterns above the
// general ones. `test` gets the error itself, not just its message, because
// some cases are identified by `name` or `code`.
const RULES = [
    {
        key: 'loadErrorTextTooLarge',
        // V8 caps a single string at 2^29-24 characters (~512 MB). The legacy
        // CSV reader decodes the whole file into one string, so this is what a
        // >512 MB text file hits when DuckDB is not available to stream it.
        test: err => /Cannot create a string longer than/i.test(err.message),
    },
    {
        key: 'loadErrorPickleArrayTooLarge',
        test: err => /Unsupported ndarray size\s+(\d+)/i.test(err.message),
        params: err => ({ count: Number(err.message.match(/Unsupported ndarray size\s+(\d+)/i)[1]).toLocaleString() }),
    },
    {
        // A worksheet the workbook lists but the reader could not build. It
        // surfaced as "Sheet not found: data", which reads like a naming
        // problem and is not one: the sheet is there, it is just larger than
        // this runtime can hold.
        key: 'loadErrorOutOfMemory',
        test: err => err.code === 'EXCEL_SHEET_UNREADABLE',
    },
    {
        key: 'loadErrorReaderCrashed',
        // A worker that runs out of memory is terminated by the browser; the
        // tab survives, which is why this is a message and not a blank page.
        test: err => err.name === 'WorkerDiedError'
            || /worker (crashed|died|terminated)/i.test(err.message)
            || err.workerCrashed === true,
    },
    {
        key: 'loadErrorQueryEngineMemory',
        // DuckDB-WASM is a 32-bit build: its linear memory cannot exceed 4 GiB
        // no matter how much RAM the machine has, and no setting changes that.
        test: err => /OutOfMemoryException|Out of Memory Error|failed to allocate|could not allocate/i.test(err.message),
    },
    {
        key: 'loadErrorOutOfMemory',
        test: err => /Array buffer allocation failed|Invalid (typed )?array (buffer )?length|out of memory|allocation size overflow/i.test(err.message),
    },
];

/**
 * @param {unknown} error
 * @returns {{ cancelled: boolean, key: string|null, params: object, raw: string }}
 *   `cancelled` marks the user's own abort, which deserves no dialog at all.
 *   `key` is null when we have no better wording than what the error already
 *   says — in that case the raw text IS the message, which is honest.
 *   `raw` is always the original text, for the details pane and bug reports.
 */
export function describeLoadError(error) {
    const err = error instanceof Error ? error : new Error(String(error ?? ''));
    const raw = err.message || String(err);

    if (err.name === 'AbortError' || err.cancelled === true) {
        return { cancelled: true, key: null, params: {}, raw };
    }

    for (const rule of RULES) {
        let matched = false;
        try { matched = rule.test(err); } catch { matched = false; }
        if (!matched) continue;
        let params = {};
        if (rule.params) {
            try { params = rule.params(err); } catch { params = {}; }
        }
        return { cancelled: false, key: rule.key, params, raw };
    }

    return { cancelled: false, key: null, params: {}, raw };
}

/**
 * Fill a translated template. Kept here so the substitution rule lives next to
 * the params that feed it.
 */
export function formatLoadErrorMessage(template, params) {
    let out = String(template ?? '');
    for (const [name, value] of Object.entries(params || {})) {
        out = out.split(`{${name}}`).join(String(value));
    }
    return out;
}
