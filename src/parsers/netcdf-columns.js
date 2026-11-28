// A netCDF file's series read by parts, as a columnar reader.
//
// NetcdfParser already reads a netCDF without ever holding the file: netCDF3
// through byte ranges (src/gridded/nc3-reader.js) and netCDF4 through h5wasm
// mounted with WORKERFS (src/gridded/hdf5-input.js). What it holds is the
// series it builds — one Float64Array each — and that is the limit a large
// file runs into: a bounded subset of 500 grid points over a million steps is
// four gigabytes of arrays, so the file is refused before it is read.
//
// This reader hands the same series out a stretch of time steps at a time, for
// src/data/columnar-ingest.js to copy into tables of the engine and adopt as a
// memory-saving (lazy) dataset. Nothing downstream knows the rows came from a
// netCDF: every analysis, data tool and export reads them as it reads a lazy
// CSV's.
//
// The same series, exactly. Which coordinate is the X axis, which variables
// align with it, how many series each expands into and which of them are kept
// is decided by NetcdfParser._planGeneric — the same function the in-memory
// path runs, not a second reading of the rules — and each block of values goes
// through the same `decodeNumeric` (the _FillValue and the scale_factor of the
// variable, per value), so a block holds the doubles the whole series would
// have held at those rows.
//
// What it does not do:
//
//   · The X coordinate is read whole, as the in-memory path reads it: every
//     decision about the axis is made from its values, and its calendar is
//     applied to them. That is 8 bytes a step — about 250 MB at 30 million
//     steps — so a file whose *time axis alone* does not fit is still left to
//     the in-memory path. What this lifts is the cost of the series, which is
//     where the size of a netCDF is: one per variable per grid point.
//   · A variable that cannot be read by parts (no `supportsSlice`) is left to
//     the in-memory path, whole.
//   · A PyPSA network has its own parser and is left to it.
//
// Null means "open it the way it was always opened", never an error of its own.

import { BufferByteSource, FileByteSource } from '../gridded/byte-source.js';
import { openHdf5 } from '../gridded/hdf5-input.js';
import { openNetcdf3 } from '../gridded/nc3-reader.js';
import NetcdfParser from './netcdf-parser.js';
import { attrsFromHdf5, decodeNumeric } from './netcdf-cf.js';
import { sniffNetcdfContainer } from './netcdf-sniff.js';

// Values handed over per block, across every series. 4 M doubles is 32 MB held
// at once, the same order as the engine's own insert budget.
export const NETCDF_BLOCK_VALUES = 4 * 1024 * 1024;
const NETCDF3_KINDS = new Set(['netcdf3-classic', 'netcdf3-64-bit-offset', 'cdf5']);
const NO_VALUES = new Float64Array(0);

function abortError() {
    const error = new Error('Aborted');
    error.name = 'AbortError';
    return error;
}

function sliceToFloat64(values, start, end) {
    if (values instanceof Float64Array) return values.slice(start, end);
    const out = new Float64Array(Math.max(0, end - start));
    for (let index = start; index < end; index++) out[index - start] = Number(values[index]);
    return out;
}

/**
 * The series of a netCDF file as a columnar reader, or null when this reader
 * does not take the file.
 *
 * @param {Blob|File|{file?: Blob, buffer?: ArrayBuffer|Uint8Array}} input
 * @param {{ parser: object, filename?: string }} options the structure parser
 *   (the app's MatParser) and the file's name
 */
export async function openNetcdfColumns(input, { parser, filename = '' } = {}) {
    const file = input?.file || (input && typeof input.slice === 'function' ? input : null);
    const buffer = input?.buffer || null;
    if (!file && !buffer) return null;
    const name = filename || file?.name || '';
    const source = file ? new FileByteSource(file) : new BufferByteSource(buffer);
    if (!source.size) return null;

    const netcdf = new NetcdfParser(parser);
    const { kind } = sniffNetcdfContainer(source.read(0, Math.min(source.size, 4096)));
    let descriptors;
    let globalAttrs;
    let storageFormat;
    let close = () => {};
    if (kind === 'hdf5') {
        const opened = await openHdf5(file ? { file, filename: name } : { buffer, filename: name });
        try {
            const rootKeys = opened.file.keys().sort();
            // A PyPSA network is a different dataset altogether, built by its
            // own parser from tables that are not series on a shared axis.
            if (netcdf.pypsaParser._looksLikePypsa(rootKeys)) {
                opened.close();
                return null;
            }
            descriptors = netcdf._hdf5Descriptors(opened.file);
            globalAttrs = attrsFromHdf5(opened.file);
            storageFormat = 'netcdf4-hdf5';
            close = () => opened.close();
        } catch (error) {
            opened.close();
            throw error;
        }
    } else if (NETCDF3_KINDS.has(kind)) {
        const opened = openNetcdf3(source);
        descriptors = opened.descriptors;
        globalAttrs = opened.globalAttrs;
        storageFormat = opened.storageFormat;
    } else {
        return null;
    }

    try {
        const plan = netcdf._planGeneric(descriptors, globalAttrs, name, storageFormat);
        const axis = plan.axis;
        const rows = axis.length;
        if (!(rows > 0)) {
            close();
            return null;
        }

        // The series, in the order the in-memory path creates them, grouped by
        // the variable they are cut from so each is read once per block.
        const series = [];
        const groups = [];
        for (const [planIndex, item] of plan.plans.entries()) {
            const expanded = netcdf._expandPlan(plan.result, item, plan.limits[planIndex], descriptors, plan.readFlat);
            if (!expanded) continue;
            if (!item.descriptor.supportsSlice) {
                close();
                return null;
            }
            const group = { plan: item, combinations: [], columns: [] };
            for (const combination of expanded.sample.combinations) {
                const selectors = netcdf._seriesSelectors(item.descriptor, item.otherAxes, combination, expanded.labelsByAxis);
                const declared = netcdf._seriesVariable(item.descriptor, selectors, NO_VALUES);
                const column = series.length + 1;
                series.push({ descriptor: item.descriptor, selectors, name: declared.name, declared });
                group.combinations.push(combination);
                group.columns.push(column);
            }
            if (group.combinations.length) groups.push(group);
        }
        if (!series.length) {
            close();
            return null;
        }

        const axisValues = axis.variable.data;
        const timeName = axis.variable.name;
        const variables = [
            {
                name: timeName,
                description: axis.variable.description,
                kind: 'abscissa',
                interpolation: 'linear',
                negate: false,
                column: 0,
                extra: {
                    displayName: axis.variable.displayName,
                    units: axis.variable.units,
                    // What the axis is, as the in-memory path decided it over
                    // the same values: the dataset's own guess is made from a
                    // column of a table and calls a time axis "real".
                    dataType: axis.variable.dataType,
                    isConstant: axis.variable.isConstant,
                    timeKind: axis.variable.timeKind,
                    timeDisplayMode: axis.variable.timeDisplayMode,
                    timeOriginMs: axis.variable.timeOriginMs,
                    timeSourceStrategy: axis.variable.timeSourceStrategy,
                    netcdf: axis.variable.netcdf,
                },
            },
            ...series.map((item, index) => ({
                name: item.name,
                description: item.declared.description,
                kind: 'variable',
                interpolation: item.declared.interpolation,
                negate: false,
                column: index + 1,
                extra: {
                    displayName: item.declared.displayName,
                    units: item.declared.units,
                    netcdf: item.declared.netcdf,
                },
            })),
        ];

        const metadata = {
            ...plan.result.metadata,
            generatedSeriesCount: series.length,
            skippedVariablesCount: plan.result.metadata.skippedVariables.length,
            partialVariablesCount: plan.result.metadata.partialVariables.length,
        };

        // The rows of one block, over every series: the engine's insert budget
        // rounded to whole chunks of the time axis where the file has them, so
        // a chunk is never decompressed for two blocks in a row.
        const columns = series.length + 1;
        let rowsPerBlock = Math.max(1, Math.floor(NETCDF_BLOCK_VALUES / columns));
        const chunkSteps = groups
            .map(group => Number(group.plan.descriptor.chunks?.[group.plan.alignment.axis]))
            .filter(steps => Number.isInteger(steps) && steps > 0);
        if (chunkSteps.length) {
            const step = Math.max(...chunkSteps);
            // Up to four times the budget to meet a chunk; past that the chunk
            // is larger than anything this would hold and the budget wins.
            if (step <= rowsPerBlock * 4) rowsPerBlock = Math.max(step, Math.floor(rowsPerBlock / step) * step);
        }

        return {
            format: 'netcdf',
            rows,
            columns,
            timeColumn: 0,
            timeName,
            timeKind: axis.variable.timeKind === 'datetime' ? 'datetime' : 'numeric',
            variables,
            metadata,
            bytes: rows * columns * 8,
            close,
            // The tree the in-memory path would have built: the series grouped
            // by the dataset each was cut from, under the file's dimensions,
            // its global attributes and the coordinates it did not plot.
            buildTree(built, adopted = null) {
                const tree = plan.result.tree;
                const builtTimeName = adopted?.metadata?.timeName || timeName;
                const timeVariable = built[builtTimeName];
                if (timeVariable) {
                    // The axis the plan put there holds every step it read;
                    // the dataset's holds the overview, and is the object the
                    // rest of the app has.
                    delete tree._variables[axis.variable.displayName || timeName];
                    tree._variables[timeVariable.displayName || builtTimeName] = timeVariable;
                }
                for (const item of series) {
                    const variable = built[item.name];
                    if (variable) netcdf._addSeriesTree(tree, item.descriptor, item.selectors, variable);
                }
                netcdf._addSkippedTree(tree, metadata.skippedVariables);
                netcdf._addPartialTree(tree, metadata.partialVariables);
                return tree;
            },
            async *blocks({ signal = null, blockBytes = 0 } = {}) {
                const perBlock = blockBytes > 0
                    ? Math.max(1, Math.floor(blockBytes / (8 * columns)))
                    : rowsPerBlock;
                for (let rowStart = 0; rowStart < rows; rowStart += perBlock) {
                    if (signal?.aborted) throw abortError();
                    const count = Math.min(perBlock, rows - rowStart);
                    const block = new Array(columns);
                    block[0] = sliceToFloat64(axisValues, rowStart, rowStart + count);
                    for (const group of groups) {
                        const gathered = netcdf._readSeriesSlab(
                            group.plan.descriptor, group.plan.alignment.axis, group.plan.otherAxes,
                            group.combinations, rowStart, count,
                        );
                        group.columns.forEach((column, index) => {
                            block[column] = decodeNumeric(gathered[index], group.plan.descriptor.userAttrs);
                        });
                    }
                    if (signal?.aborted) throw abortError();
                    yield { rowStart, rows: count, columns: block };
                }
            },
        };
    } catch (error) {
        close();
        throw error;
    }
}
