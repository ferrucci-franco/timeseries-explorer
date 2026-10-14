/**
 * Folders for the variables of a delimited-text table (CSV, TXT, Excel sheet).
 *
 * A table has flat column names, and the sidebar tree is built by cutting each
 * name into a folder path and a leaf. How to cut is a property of the file, not
 * of the format, so it is a setting of the parsing profile:
 *
 *   auto       look at the names and pick one of the modes below
 *   none       no folders: every column at the top level
 *   dots       Modelica-style dotted paths: `motor.inertia.phi`
 *   separator  a separator inside the name: `Power | Inverter 1`, with the
 *              folder on one side of it (`position`: 'prefix' or 'suffix')
 *
 * The dotted cut only splits at a dot that sits between two names, the way
 * Modelica writes a path. The old cut split at every dot, so a device called
 * "Primo 5.0-1" became a folder "Primo 5" holding a leaf "0-1", and
 * "Temp. ambiante" a folder "Temp". Names with no such dot stay whole.
 *
 * App-free on purpose: the CSV parser, the DuckDB source and the parsing
 * dialog all build the same tree from it, and Node tests import it directly.
 */

export const CSV_GROUPING_MODES = ['auto', 'none', 'dots', 'separator'];
export const CSV_GROUPING_POSITIONS = ['auto', 'prefix', 'suffix'];

// Separators auto mode looks for. Only ones that do not occur in ordinary
// names: a slash is a unit ("m/s") or part of a device name ("Card / Box"),
// and a dash or underscore is everywhere.
const AUTO_SEPARATORS = ['|', '::'];
// Share of the columns that must carry the separator for auto to use it.
const AUTO_SEPARATOR_MIN_SHARE = 0.5;

/** A grouping setting with every field present and valid. */
export function normalizeCsvGrouping(grouping) {
    const source = grouping && typeof grouping === 'object' ? grouping : {};
    const mode = CSV_GROUPING_MODES.includes(source.mode) ? source.mode : 'auto';
    const position = CSV_GROUPING_POSITIONS.includes(source.position) ? source.position : 'auto';
    const separator = typeof source.separator === 'string' ? source.separator : '';
    return { mode, separator, position };
}

/**
 * Decide the folders for a list of column names.
 *
 * @param {object} grouping  the setting ({ mode, separator, position })
 * @param {string[]} names   variable names, the time axis left out
 * @returns {{ mode: 'none'|'dots'|'separator', separator?: string,
 *             position?: 'prefix'|'suffix', detected: boolean }}
 *          `detected` is true when auto made the choice.
 */
export function resolveCsvGrouping(grouping, names = []) {
    const setting = normalizeCsvGrouping(grouping);
    const list = (names || []).map(name => String(name ?? ''));
    if (setting.mode === 'none') return { mode: 'none', detected: false };
    if (setting.mode === 'dots') return { mode: 'dots', detected: false };
    if (setting.mode === 'separator') {
        const separator = setting.separator.trim() ? setting.separator.trim() : (detectSeparator(list) || '|');
        const position = setting.position === 'auto'
            ? detectPosition(list, separator)
            : setting.position;
        return { mode: 'separator', separator, position, detected: false };
    }

    // auto
    const separator = detectSeparator(list);
    if (separator) {
        const position = setting.position === 'auto' ? detectPosition(list, separator) : setting.position;
        // Folders are only worth it when some of them hold more than one
        // column; a separator whose every side is unique gives one folder per
        // column and nothing to fold.
        if (sidesRepeat(list, separator, position)) {
            return { mode: 'separator', separator, position, detected: true };
        }
    }
    return { mode: 'dots', detected: true };
}

/** Cut one name into { path, leaf } under a resolved grouping. */
export function splitCsvVariableName(name, resolved) {
    const text = String(name ?? '');
    if (!resolved || resolved.mode === 'none') return { path: [], leaf: text };
    if (resolved.mode === 'separator') return splitBySeparator(text, resolved.separator, resolved.position);
    return splitDottedName(text);
}

/**
 * The sidebar tree for a table's variables.
 *
 * The time axis and the variables listed in `options.rootNames` stay at the
 * top level whatever their names. A leaf that would land on a name already
 * taken in its folder keeps its full name instead, so no column is hidden.
 */
export function buildCsvTree(variables, resolved, options = {}) {
    const rootNames = new Set(options.rootNames || []);
    const tree = {
        _type: 'root',
        _name: '',
        _children: Object.create(null),
        _variables: Object.create(null),
    };
    for (const [name, variable] of Object.entries(variables || {})) {
        const keepAtRoot = variable?.kind === 'abscissa' || rootNames.has(name);
        const { path, leaf } = keepAtRoot ? { path: [], leaf: name } : splitCsvVariableName(name, resolved);
        let node = tree;
        for (let i = 0; i < path.length; i++) {
            const part = path[i];
            if (!node._children[part]) {
                node._children[part] = {
                    _type: 'component',
                    _name: part,
                    _fullName: path.slice(0, i + 1).join('.'),
                    _children: Object.create(null),
                    _variables: Object.create(null),
                };
            }
            node = node._children[part];
        }
        const key = leaf && !(leaf in node._variables) ? leaf : name;
        node._variables[key] = variable;
    }
    return tree;
}

/**
 * The tree of a dataset computed from another file (resample, collapse). A
 * table keeps the folders it was read with — cutting its columns at every dot
 * again would put "Primo 5.0-1" in a folder "Primo 5". Anything else gets
 * `fallbackBuild`, the tree its own format would have.
 */
export function treeForDerivedData(sourceData, metadata, variables, fallbackBuild) {
    const grouping = sourceData?.metadata?.csvGrouping;
    if (!grouping) return fallbackBuild(variables);
    if (metadata) metadata.csvGrouping = { ...grouping };
    return buildCsvTree(variables, grouping);
}

/**
 * A short summary of the folders a grouping produces, for the parsing dialog:
 * { folders: [{ name, count }], topLevel }. Only the first level is counted.
 */
export function summarizeCsvGrouping(names, resolved) {
    const folders = new Map();
    let topLevel = 0;
    for (const name of names || []) {
        const { path } = splitCsvVariableName(name, resolved);
        if (!path.length) {
            topLevel++;
            continue;
        }
        folders.set(path[0], (folders.get(path[0]) || 0) + 1);
    }
    return {
        folders: [...folders.entries()].map(([name, count]) => ({ name, count })),
        topLevel,
    };
}

function detectSeparator(names) {
    if (names.length < 2) return '';
    for (const separator of AUTO_SEPARATORS) {
        const carrying = names.filter(name => hasSplittableSeparator(name, separator)).length;
        if (carrying >= 2 && carrying / names.length >= AUTO_SEPARATOR_MIN_SHARE) return separator;
    }
    return '';
}

function hasSplittableSeparator(name, separator) {
    const parts = String(name).split(separator).map(part => part.trim());
    return parts.length >= 2 && parts.every(Boolean);
}

// The folder is the side with fewer distinct values, the one that repeats
// most: a logger export has a few devices and many quantities per device, so
// "Power | Inverter 1", "Voltage | Inverter 1", "Power | Inverter 2", ...
// folds by inverter, whichever side it is written on. A tie (as many
// quantities as devices) has nothing to go on, and goes to the prefix.
function detectPosition(names, separator) {
    const firsts = new Set();
    const lasts = new Set();
    for (const name of names) {
        if (!hasSplittableSeparator(name, separator)) continue;
        const parts = String(name).split(separator).map(part => part.trim());
        firsts.add(parts[0]);
        lasts.add(parts[parts.length - 1]);
    }
    return lasts.size < firsts.size ? 'suffix' : 'prefix';
}

function sidesRepeat(names, separator, position) {
    const seen = new Set();
    for (const name of names) {
        if (!hasSplittableSeparator(name, separator)) continue;
        const { path } = splitBySeparator(name, separator, position);
        const key = path.join('\u0001');
        if (seen.has(key)) return true;
        seen.add(key);
    }
    return false;
}

function splitBySeparator(name, separator, position) {
    if (!separator || !hasSplittableSeparator(name, separator)) return { path: [], leaf: name };
    const parts = String(name).split(separator).map(part => part.trim());
    if (position === 'suffix') {
        // "Signal | Device | Site": Site > Device > Signal.
        return { path: parts.slice(1).reverse(), leaf: parts[0] };
    }
    return { path: parts.slice(0, -1), leaf: parts[parts.length - 1] };
}

// A dot is a path separator when a name ends before it and a name starts after
// it: `a.b`, `bus[2].v`, `x_1.y`. Not in a number (`5.0`), not before a space
// (`Temp. ext`), not before a digit (`No.1`).
function isPathDot(text, index) {
    const before = text[index - 1];
    const after = text[index + 1];
    return !!before && !!after
        && /[\p{L}\p{N}_\])]/u.test(before)
        && /[\p{L}_]/u.test(after);
}

function splitDottedName(name) {
    // Modelica function wrappers keep their own rule: `a.b.der(c.d)` is the
    // derivative of `c.d` inside `a.b` — the leaf is `der(d)` in a.b.c.
    const funcMatch = name.match(/^((?:[^.(]+\.)*?)([^.(]+)\(([^)]+)\)$/);
    if (funcMatch && isModelicaPath(funcMatch[1].replace(/\.$/, '')) && isModelicaPath(funcMatch[3])) {
        const prefixParts = funcMatch[1] ? funcMatch[1].replace(/\.$/, '').split('.') : [];
        const innerParts = funcMatch[3].split('.');
        return {
            path: [...prefixParts, ...innerParts.slice(0, -1)],
            leaf: `${funcMatch[2]}(${innerParts[innerParts.length - 1]})`,
        };
    }
    const parts = [];
    let start = 0;
    for (let i = 0; i < name.length; i++) {
        if (name[i] === '.' && isPathDot(name, i)) {
            parts.push(name.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(name.slice(start));
    if (parts.length < 2 || parts.some(part => !part.trim())) return { path: [], leaf: name };
    return { path: parts.slice(0, -1), leaf: parts[parts.length - 1] };
}

function isModelicaPath(text) {
    if (!text) return true;
    return text.split('.').every(part => /^[\p{L}_][\p{L}\p{N}_]*(?:\[[^\]]*\])?$/u.test(part));
}
