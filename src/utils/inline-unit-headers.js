// Is "name(something)" a name with a unit, or just a name?
//
// A header like `speed (m/s)` carries its unit inline, and splitting it is
// right. A header like `v(V1)` is a signal name — the voltage at node V1 — and
// splitting it throws the identity away. Both look identical to a pattern.
//
// What tells them apart is the rest of the row. Units repeat: a Microcap run
// has three columns in volts. Names do not. So when splitting makes two
// DIFFERENT headers collide on the same name, the parenthesised part was the
// thing that told them apart, and it is not a unit:
//
//   v(V1)  v(OUT_1)  v(OUT_2)   ->  v, v, v        collision: these are names
//   time (s)  speed (m/s)       ->  time, speed    no collision: these are units
//
// Without this rule a Microcap file lost every signal it had, and the sidebar
// listed `v`, `v_2`, `v_3`, `i`, `i_2`… with the real names demoted to units
// (#53) — the deduplicator renaming them being the second half of the damage.
//
// Pure (no DOM, no parser) so both the dialog and the parser can share the one
// rule, and so the offline suite can cover it.

/**
 * @param {string[]} rawHeaders  the header cells as they appear in the file
 * @param {Array<{name:string, unit?:string}>} parsed  the same cells after an
 *        inline-unit split, in the same order
 * @returns {boolean} true when the split collapsed distinct headers together,
 *        which means the split is wrong for this row
 */
export function inlineUnitSplitCollides(rawHeaders, parsed) {
    const raws = Array.isArray(rawHeaders) ? rawHeaders : [];
    const rows = Array.isArray(parsed) ? parsed : [];
    // Only the cells a unit was actually taken from can be evidence: a column
    // with no parentheses is untouched by the split and says nothing about it.
    const byName = new Map();
    for (let i = 0; i < rows.length; i++) {
        const entry = rows[i];
        if (!entry || !entry.unit) continue;
        const raw = String(raws[i] ?? '').trim();
        const name = String(entry.name ?? '').trim();
        if (!raw || !name) continue;
        const seen = byName.get(name);
        // Two columns with the SAME raw header are an ordinary duplicate, which
        // the deduplicator handles; only differing headers are evidence.
        if (seen !== undefined && seen !== raw) return true;
        byName.set(name, raw);
    }
    return false;
}
