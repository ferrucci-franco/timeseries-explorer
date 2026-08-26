// Recognizing Micro-Cap numeric output from its first bytes.
//
// Micro-Cap's own extensions (.tno/.ano/.dno) are routed by name, but people
// also save or rename this output as `.txt`/`.out` — extensions the app
// streams to DuckDB as delimited text without ever reading the bytes. This
// check is what lets the loader read a small head sample and reroute before
// that happens, so it lives in its own module: file-methods.js imports it
// statically without dragging the whole parser into the main bundle.

export const MICROCAP_SNIFF_BYTES = 4096;

// The banner is the one part of the format that survives every output option:
// a full-width line of asterisks with a "Micro-Cap <version>" line inside the
// block. Requiring both keeps a CSV that merely mentions Micro-Cap in a
// comment from being rerouted.
export function looksLikeMicroCapText(text) {
    if (!text) return false;
    const head = String(text).slice(0, MICROCAP_SNIFF_BYTES);
    return /^\*{20,}\s*$/m.test(head) && /Micro-Cap/i.test(head);
}
