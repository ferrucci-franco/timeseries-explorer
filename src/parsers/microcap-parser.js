// Micro-Cap numeric output (.tno/.ano/.dno).
//
// Micro-Cap (Spectrum Software's SPICE simulator) writes analysis results as
// plain text: an asterisk banner, optional "Limits"/"Stepping Options" prose,
// then one whitespace-separated table of waveform values per run. Parameter
// stepping repeats the banner + table once per step combination, so a single
// file can hold dozens of runs of the same signals:
//
//     *****************************************************
//     ***                Temperature=27                 ***
//     ***                    C1=10u                     ***
//     *****************************************************
//
//     Temperature=27 C1=10u V1=12
//
//     Interpolated Waveform Values
//     ============================
//                T       v(C1)
//           (Secs)         (V)
//        0.000E+00  -2.400E-09
//        1.111E-04   2.777E-04
//
// The tree groups by SIGNAL, not by run — one node per waveform holding one
// variable per step combination — because the point of stepping is overlaying
// the same signal across parameter values. Run labels list only the parameters
// that actually vary between runs (a Temperature=27 constant across every run
// would otherwise repeat in every label). Files without stepping put their
// signals directly under the file, no wrapper group.
//
// The app allows one abscissa per file, but "Actual Waveform Values" tables
// have per-run adaptive timesteps. All runs are therefore placed on the union
// of their time points; runs sampled on the same grid (the common interpolated
// output) merge losslessly, and differing grids leave NaN where a run has no
// sample — which the plots already render as gaps.

import MatParser from './mat-parser.js';
import { looksLikeMicroCapText } from './microcap-sniff.js';

// Strict on purpose: Number() would also accept '0x1F', 'Infinity' and ''.
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
// A stepped-parameter token, e.g. `C1=10u` or `V1=19.2`.
const NAME_VALUE = /^([^\s=]+)=(\S+)$/;

const isNumericToken = (token) => NUMBER.test(token);
const tokensOf = (line) => line.trim().split(/\s+/);

export default class MicroCapParser {
    constructor(structureParser) {
        this.structureParser = structureParser || new MatParser();
    }

    async parse(buffer, filename, _options = {}) {
        const text = this._decodeText(buffer);
        const { tables, analysis } = this._scanTables(text);
        if (!tables.length) {
            const err = new Error(`No waveform value tables found in "${filename}" — not recognized as Micro-Cap numeric output.`);
            err.code = 'MICROCAP_NO_TABLES';
            throw err;
        }
        return this._buildResult(tables, analysis, filename);
    }

    _decodeText(buffer) {
        if (typeof buffer === 'string') return buffer;
        const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer)
            : ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
            : new Uint8Array(0);
        // Micro-Cap output is ASCII; non-fatal UTF-8 keeps any stray byte from
        // aborting the load.
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }

    // One pass over the lines. Everything that is not a parameter banner, a
    // section underline or a waveform table is prose (Limits, Stepping
    // Options, dates) and is skipped without being modeled.
    _scanTables(text) {
        const lines = text.split(/\r?\n/);
        const tables = [];
        let params = new Map();     // current run's stepped parameters
        let section = '';           // nearest preceding "=====" underlined title
        let analysis = '';          // e.g. "Transient Analysis of circuit1"
        let prevNonEmpty = '';

        for (let i = 0; i < lines.length; ) {
            const line = lines[i].trim();
            if (!line) { i++; continue; }

            if (/^=+$/.test(line)) {
                section = prevNonEmpty;
                prevNonEmpty = line;
                i++;
                continue;
            }

            // Banner rows: `***  C1=10u  ***` carries a parameter, the header
            // block carries the analysis title.
            if (/^\*.*\*$/.test(line)) {
                const inner = line.replace(/^\*+/, '').replace(/\*+$/, '').trim();
                const named = inner.match(NAME_VALUE);
                if (named && !inner.includes(' ')) {
                    params.set(named[1], named[2]);
                } else if (!analysis && /analysis/i.test(inner)) {
                    analysis = inner;
                }
                prevNonEmpty = line;
                i++;
                continue;
            }

            const tokens = tokensOf(line);

            // The plain `Temperature=27 C1=10u V1=12` line restates the run's
            // complete parameter set, so it replaces rather than merges.
            if (tokens.every(t => NAME_VALUE.test(t))) {
                params = new Map(tokens.map(t => {
                    const m = t.match(NAME_VALUE);
                    return [m[1], m[2]];
                }));
                prevNonEmpty = line;
                i++;
                continue;
            }

            const table = this._probeTable(lines, i, tokens);
            if (table) {
                tables.push({ ...table, params: new Map(params), section });
                prevNonEmpty = line;
                i = table.endIndex;
                continue;
            }

            prevNonEmpty = line;
            i++;
        }
        return { tables, analysis };
    }

    // A table is a header line (>= 2 non-numeric column names), an optional
    // units row of `(...)` tokens, and consecutive all-numeric rows of the
    // same width. Requiring two rows (or one plus a units row) keeps prose
    // like `From  12` from qualifying. Column names are assumed not to
    // contain spaces — true of Micro-Cap expressions (`v(C1)`, `DB(V(2))`).
    _probeTable(lines, start, headerTokens) {
        if (headerTokens.length < 2 || headerTokens.every(isNumericToken)) return null;
        let j = start + 1;
        let units = null;
        if (j < lines.length) {
            const unitTokens = tokensOf(lines[j].trim());
            if (unitTokens.length === headerTokens.length && unitTokens.every(t => /^\(.+\)$/.test(t))) {
                units = unitTokens.map(t => t.slice(1, -1));
                j++;
            }
        }
        const rows = [];
        while (j < lines.length) {
            const line = lines[j].trim();
            if (!line) break;
            const tokens = tokensOf(line);
            if (tokens.length !== headerTokens.length || !tokens.every(isNumericToken)) break;
            rows.push(tokens.map(Number));
            j++;
        }
        if (rows.length < 2 && !(units && rows.length >= 1)) return null;
        return { columns: headerTokens, units: units || headerTokens.map(() => ''), rows, endIndex: j };
    }

    _buildResult(tables, analysis, filename) {
        // Group tables into runs by their parameter snapshot; a run may span
        // several tables (Micro-Cap pages wide output into column blocks).
        const runs = [];
        const runsByKey = new Map();
        for (const table of tables) {
            const key = JSON.stringify([...table.params.entries()]);
            let run = runsByKey.get(key);
            if (!run) {
                run = { key, params: table.params, tables: [] };
                runsByKey.set(key, run);
                runs.push(run);
            }
            run.tables.push(table);
        }

        const runLabels = this._runLabels(runs);
        const timeAxis = this._unionTimeAxis(tables);
        const signals = this._collectSignals(runs, timeAxis);

        const sp = this.structureParser;
        const variables = Object.create(null);
        const tree = { _type: 'root', _name: '', _children: Object.create(null), _variables: Object.create(null) };
        const usedNames = new Set();
        const uniqueName = (base) => {
            let name = base;
            for (let suffix = 2; usedNames.has(name); suffix++) name = `${base}_${suffix}`;
            usedNames.add(name);
            return name;
        };

        const first = tables[0];
        const timeUnit = first.units[0] || '';
        const timeName = uniqueName(first.columns[0]);
        const timeLabel = timeUnit ? `${timeName} [${timeUnit}]` : timeName;
        const timeVariable = {
            name: timeName,
            data: timeAxis.values,
            description: timeLabel,
            kind: 'abscissa',
            dataType: sp._detectDataType(timeAxis.values, 'abscissa'),
            isConstant: sp._isConstantValues(timeAxis.values),
            interpolation: 'linear',
            negate: false,
            source: 'microcap',
        };
        variables[timeName] = timeVariable;
        tree._variables[timeLabel] = timeVariable;

        const multiRun = runs.length > 1;
        for (const signal of signals) {
            const runLabel = runLabels.get(signal.runKey) || '';
            const baseName = signal.section ? `${signal.column} (${signal.section})` : signal.column;
            const name = uniqueName(multiRun && runLabel ? `${baseName} @ ${runLabel}` : baseName);
            const unitTag = signal.unit ? ` [${signal.unit}]` : '';
            const variable = {
                name,
                data: signal.data,
                description: `${baseName}${runLabel ? ` @ ${runLabel}` : ''}${unitTag}`,
                kind: 'variable',
                dataType: sp._detectDataType(signal.data, 'variable'),
                isConstant: sp._isConstantValues(signal.data),
                interpolation: 'linear',
                negate: false,
                source: 'microcap',
            };
            variables[name] = variable;

            const groupLabel = `${baseName}${unitTag}`;
            if (multiRun) {
                let node = tree._children[groupLabel];
                if (!node) {
                    node = { _type: 'component', _name: groupLabel, _fullName: groupLabel, _children: Object.create(null), _variables: Object.create(null) };
                    tree._children[groupLabel] = node;
                }
                node._variables[runLabel || name] = variable;
            } else {
                tree._variables[groupLabel] = variable;
            }
        }

        const signalCount = Object.keys(variables).length - 1;
        return {
            filename,
            variables,
            tree,
            metadata: {
                format: 'microcap',
                source: 'microcap',
                analysis,
                runCount: runs.length,
                numVariables: Object.keys(variables).length,
                numParams: 0,
                numTimevarying: signalCount,
                numTimesteps: timeAxis.values.length,
                rowCount: timeAxis.values.length,
                columnCount: signalCount + 1,
                timeName,
                timeKind: 'numeric',
                timeDisplayMode: 'numeric',
                timeOriginMs: null,
                timeStart: timeAxis.values[0],
                timeEnd: timeAxis.values[timeAxis.values.length - 1],
                datetimeAxisStalled: false,
            },
        };
    }

    // Only the parameters that differ between runs go into the labels. When
    // nothing varies (a single run, or no stepping information at all) the
    // labels fall back to run numbers — and to '' for the single-run case,
    // which callers use to skip grouping entirely.
    _runLabels(runs) {
        const labels = new Map();
        if (runs.length <= 1) {
            labels.set(runs[0]?.key, '');
            return labels;
        }
        const names = [];
        const seen = new Set();
        for (const run of runs) {
            for (const name of run.params.keys()) {
                if (!seen.has(name)) { seen.add(name); names.push(name); }
            }
        }
        const varying = names.filter(name => {
            const values = new Set(runs.map(run => run.params.get(name)));
            return values.size > 1;
        });
        runs.forEach((run, index) => {
            const label = varying
                .filter(name => run.params.has(name))
                .map(name => `${name}=${run.params.get(name)}`)
                .join(', ');
            labels.set(run.key, label || `Run ${index + 1}`);
        });
        return labels;
    }

    // Exact-value union of every table's first column. Values come from the
    // same printed text, so runs sharing a grid produce identical doubles and
    // the union degenerates to that grid with no NaN padding.
    _unionTimeAxis(tables) {
        const seen = new Set();
        const all = [];
        for (const table of tables) {
            for (const row of table.rows) {
                const t = row[0];
                if (!seen.has(t)) { seen.add(t); all.push(t); }
            }
        }
        all.sort((a, b) => a - b);
        const values = Float64Array.from(all);
        const index = new Map();
        for (let i = 0; i < values.length; i++) index.set(values[i], i);
        return { values, index };
    }

    // One signal per (run, column), sampled onto the union axis. A column name
    // repeated within a run under different section titles (Actual next to
    // Interpolated waveform values) keeps both, tagged with a shortened
    // section name; a repeat under the same title overwrites, which is what a
    // paged column block re-listing the abscissa amounts to.
    _collectSignals(runs, timeAxis) {
        const signals = [];
        const byKey = new Map();
        for (const run of runs) {
            for (const table of run.tables) {
                for (let c = 1; c < table.columns.length; c++) {
                    const column = table.columns[c];
                    const unit = table.units[c] || '';
                    const plainKey = `${run.key}\u0000${column}`;
                    let signal = byKey.get(plainKey);
                    if (signal && signal.sectionTitle !== table.section) {
                        // Retag the existing signal with its section and store
                        // this one under its own.
                        if (!signal.section) {
                            byKey.delete(plainKey);
                            signal.section = this._shortSection(signal.sectionTitle);
                            byKey.set(`${plainKey}\u0000${signal.sectionTitle}`, signal);
                        }
                        const sectionKey = `${plainKey}\u0000${table.section}`;
                        signal = byKey.get(sectionKey);
                        if (!signal) {
                            signal = this._newSignal(run.key, column, unit, table.section, this._shortSection(table.section), timeAxis);
                            byKey.set(sectionKey, signal);
                            signals.push(signal);
                        }
                    } else if (!signal) {
                        signal = this._newSignal(run.key, column, unit, table.section, '', timeAxis);
                        byKey.set(plainKey, signal);
                        signals.push(signal);
                    }
                    for (const row of table.rows) {
                        const at = timeAxis.index.get(row[0]);
                        if (at !== undefined) signal.data[at] = row[c];
                    }
                }
            }
        }
        return signals;
    }

    _newSignal(runKey, column, unit, sectionTitle, section, timeAxis) {
        const data = new Float64Array(timeAxis.values.length).fill(NaN);
        return { runKey, column, unit, sectionTitle, section, data };
    }

    // 'Actual Waveform Values' → 'Actual'; anything unrecognized is kept
    // whole so the two colliding signals stay distinguishable.
    _shortSection(title) {
        const short = String(title || '').replace(/\s*waveform values\s*$/i, '').trim();
        return short || String(title || '').trim() || 'values';
    }
}

export { looksLikeMicroCapText };
