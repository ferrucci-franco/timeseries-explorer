import h5wasm from 'h5wasm';
import MatParser from './mat-parser.js';
import PypsaNetcdfParser from './pypsa-netcdf-parser.js';
import { PYPSA_NETCDF_DEFAULT_EAGER_LIMIT_BYTES } from './pypsa-netcdf-limits.js';
import { netcdfContainerError, sniffNetcdfContainer } from './netcdf-sniff.js';
import { openNetcdf3 } from '../gridded/nc3-reader.js';
import { BufferByteSource } from '../gridded/byte-source.js';
import {
    DESCRIPTION_KEYS,
    NON_STANDARD_CALENDARS,
    UNIT_KEYS,
    attrText,
    attrValue,
    attrsFromHdf5,
    cfTimeUnits,
    decodeNumeric,
    flatten,
    parseDate,
    plainTimeUnitScaleMs,
    scalar,
} from './netcdf-cf.js';

const UNSUPPORTED_NODE = 'Unsupported variables';
const PARTIAL_NODE = 'Partially loaded variables';
const METADATA_NODE = 'File metadata';
const COORDINATES_NODE = 'Coordinates';
const MAX_GENERATED_SERIES = 10000;
// Series are cut out of whole arrays, never read one at a time. A per-series
// hyperslab looked cheap and was the single largest cost in the reader: on a
// chunked, compressed variable every slice decompresses every chunk it touches,
// so 5,000 series on a [24, 161, 209] ERA5 field decompressed the whole field
// 5,000 times — 75 s for a 3.6 MB file whose variable reads whole in 15 ms.
// Up to this many values a variable is read in one call; past it, it is read in
// slabs along its sample axis, so the memory held at once stays bounded and the
// file is still decompressed once.
const WHOLE_READ_VALUE_LIMIT = 32 * 1024 * 1024;
const SLAB_VALUE_TARGET = 8 * 1024 * 1024;
// A gridded variable can expose tens of thousands (or millions) of spatial
// points. Rejecting the whole variable leaves otherwise valid climate files
// looking as if they failed to load. A bounded, evenly spaced subset is loaded
// instead.
//
// How large that subset may be is not a count, because a count is the wrong
// unit. What a slice costs to hold is dominated by the length of the time
// axis: a slice of ECMWF ERA-40 (62 steps) is 500 bytes, a slice of a daily
// century run (31,025 steps) is 240 kB. So the allowance is a budget of
// retained VALUES, divided by the sample count — 2,000,000 values is 16 MB of
// float64, and no file in the measured corpus retains more than that per
// variable. The floor is there because a field sampled too thinly stops being
// a field: below roughly an 8 x 8 grid there is nothing left to look at.
//
// Deliberately absent: a per-variable slice ceiling. An earlier draft capped
// every variable at 512, then 2,048, and both numbers thinned variables that
// main had loaded whole (sresa1b's `ua`, 4,352 slices) — a regression paid for
// nothing, since the file-wide MAX_GENERATED_SERIES already bounds the total.
// Measured with scripts/bench-netcdf-grid.mjs; the numbers are in
// docs/netcdf-gridded-subsampling.md.
const SERIES_VALUE_BUDGET_PER_VARIABLE = 2000000;
const MIN_SERIES_PER_VARIABLE = 64;
const TIME_LIKE_NAME = /^(time|times|date|datetime|timestamp|timestamps|time_?offset|time_?obs|observation_?time|time_?nominal|time_?valid)$/i;
function toArray(value) {
    if (value == null) return [];
    if (Array.isArray(value)) return value;
    if (ArrayBuffer.isView(value)) return Array.from(value);
    return [value];
}

function product(values) {
    return values.reduce((total, value) => total * value, 1);
}

function basename(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    return parts.at(-1) || 'variable';
}

function dirname(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    parts.pop();
    return parts.length ? `/${parts.join('/')}` : '/';
}

function joinPath(parent, child) {
    return parent === '/' ? `/${child}` : `${parent}/${child}`;
}

function idSegment(value) {
    return encodeURIComponent(String(value ?? ''));
}

function isNumericValue(value) {
    return typeof value === 'number' || typeof value === 'bigint';
}

function numericArray(value) {
    return Float64Array.from(flatten(value), item => Number(item));
}

function combinations(shape) {
    if (!shape.length) return [[]];
    const result = [];
    const current = new Array(shape.length).fill(0);
    const visit = axis => {
        if (axis === shape.length) {
            result.push([...current]);
            return;
        }
        for (let index = 0; index < shape[axis]; index++) {
            current[axis] = index;
            visit(axis + 1);
        }
    };
    visit(0);
    return result;
}

/**
 * How many indexes to keep along each axis so that their product stays within
 * the budget.
 *
 * Scaling every axis by the same factor is the obvious thing and the wrong
 * one: on a [level=8, lat=73, lon=144] grid it rounds the level axis away to a
 * single level while the horizontal axes still keep a dozen each, so what
 * comes back is one altitude rather than a thinned volume. Filling the
 * shortest axis first — it is the one most likely to fit whole — and dividing
 * what is left among the rest keeps every dimension represented.
 */
function axisSampleCounts(sizes, limit) {
    const counts = new Array(sizes.length);
    const ascending = sizes.map((size, axis) => ({ size, axis })).sort((a, b) => a.size - b.size || a.axis - b.axis);
    let budget = Math.max(1, limit);
    let remaining = ascending.length;
    for (const item of ascending) {
        const share = Math.max(1, Math.floor(budget ** (1 / remaining)));
        counts[item.axis] = Math.min(item.size, share);
        budget = Math.max(1, Math.floor(budget / counts[item.axis]));
        remaining -= 1;
    }
    return counts;
}

// Evenly spaced along the axis, both ends included, so the subset spans the
// full extent of the dimension. A single index is taken from the middle: on a
// latitude axis the first row is a pole, and a pole is a poor stand-in for a
// hemisphere.
function evenIndexes(size, count) {
    if (count >= size) return Array.from({ length: size }, (_, index) => index);
    if (count <= 1) return [Math.floor((size - 1) / 2)];
    return Array.from({ length: count }, (_, index) => Math.round((index * (size - 1)) / (count - 1)));
}

/**
 * A bounded subset of a grid's points, thinned along each axis rather than
 * along the flattened index. Walking the flattened order takes whole leading
 * rows and none of the rest, which on a lat/lon grid is a band of latitudes,
 * not a sample of the field.
 */
function gridSample(sizes, limit) {
    const total = product(sizes);
    if (total <= limit) return { combinations: combinations(sizes), counts: [...sizes], total };
    const counts = axisSampleCounts(sizes, limit);
    const indexesByAxis = sizes.map((size, axis) => evenIndexes(size, counts[axis]));
    return {
        combinations: combinations(indexesByAxis.map(list => list.length))
            .map(position => position.map((index, axis) => indexesByAxis[axis][index])),
        counts: indexesByAxis.map(list => list.length),
        total,
    };
}

/**
 * How many slices each gridded variable may contribute, given how long the
 * time axis is and how many variables are competing for the file-wide limit.
 *
 * The competition is the part a per-variable constant cannot express. ECMWF
 * ERA-40 holds seventeen variables on the same 73 x 144 grid: hand the first
 * few a large allowance and they consume the file's whole budget, and the
 * remaining variables are rejected outright — the failure this code exists to
 * avoid, moved one step down the file. So the shortest requests are satisfied
 * first and the rest divide what is left, which leaves every variable present.
 */
function seriesLimits(seriesCounts, sampleCount) {
    const ceiling = Math.max(
        MIN_SERIES_PER_VARIABLE,
        Math.floor(SERIES_VALUE_BUDGET_PER_VARIABLE / Math.max(1, sampleCount)),
    );
    const limits = new Array(seriesCounts.length).fill(0);
    const ascending = seriesCounts
        .map((count, index) => ({ want: Math.min(count, ceiling), index }))
        .sort((a, b) => a.want - b.want || a.index - b.index);
    let budget = MAX_GENERATED_SERIES;
    let remaining = ascending.length;
    for (const item of ascending) {
        limits[item.index] = Math.max(0, Math.min(item.want, Math.floor(budget / remaining)));
        budget -= limits[item.index];
        remaining -= 1;
    }
    return limits;
}

/**
 * A numeric view of whatever a reader returned for a variable: typed arrays
 * pass through untouched (h5wasm hands those back), anything nested is
 * flattened once. Never a boxed copy of a typed array — the old reader built a
 * JS Array of every value just to ask whether they were numbers.
 */
function flatValues(value) {
    if (ArrayBuffer.isView(value)) return value;
    if (Array.isArray(value) && !value.some(item => Array.isArray(item) || ArrayBuffer.isView(item))) return value;
    return flatten(value);
}

function rowMajorStrides(shape) {
    const strides = new Array(shape.length).fill(1);
    for (let axis = shape.length - 2; axis >= 0; axis--) strides[axis] = strides[axis + 1] * shape[axis + 1];
    return strides;
}

function isoLabel(milliseconds) {
    if (!Number.isFinite(milliseconds)) return '';
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime())) return '';
    const iso = date.toISOString();
    if (iso.endsWith('T00:00:00.000Z')) return iso.slice(0, 10);
    return iso.replace(/:00\.000Z$/, 'Z').replace(/\.000Z$/, 'Z');
}

function coordinateLabel(value, index) {
    if (value === undefined || value === null || value === '') return String(index);
    if (typeof value === 'number' && !Number.isFinite(value)) return String(index);
    return String(scalar(value));
}

export default class NetcdfParser {
    constructor(structureParser) {
        this.structureParser = structureParser || new MatParser();
        this.pypsaParser = new PypsaNetcdfParser(this.structureParser);
        this._sequence = 0;
    }

    async parse(buffer, filename = '', options = {}) {
        if (!buffer?.byteLength) throw new Error('netCDF file is empty.');
        const maxFileBytes = Number(options.maxFileBytes || PYPSA_NETCDF_DEFAULT_EAGER_LIMIT_BYTES);
        if (Number.isFinite(maxFileBytes) && maxFileBytes > 0 && buffer.byteLength > maxFileBytes) {
            throw new Error('netCDF support is currently limited to files that fit in memory. Large/lazy netCDF loading is not available yet.');
        }

        const { kind } = sniffNetcdfContainer(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096)));
        if (kind === 'hdf5') return this._parseHdf5(buffer, filename);
        if (kind === 'netcdf3-classic' || kind === 'netcdf3-64-bit-offset' || kind === 'cdf5') return this._parseNetcdf3(buffer, filename);
        throw netcdfContainerError(kind);
    }

    async _parseHdf5(buffer, filename) {
        const module = await h5wasm.ready;
        const virtualPath = `/netcdf-${Date.now()}-${this._sequence++}.nc`;
        module.FS.writeFile(virtualPath, new Uint8Array(buffer));
        const file = new h5wasm.File(virtualPath, 'r');
        try {
            const rootKeys = file.keys().sort();
            if (this.pypsaParser._looksLikePypsa(rootKeys)) return this.pypsaParser._parseFile(file, filename);
            const descriptors = this._hdf5Descriptors(file);
            return this._parseGeneric(descriptors, attrsFromHdf5(file), filename, 'netcdf4-hdf5');
        } finally {
            file.close();
            try {
                module.FS.unlink(virtualPath);
            } catch {
                // Best-effort cleanup of the Emscripten in-memory file.
            }
        }
    }

    _hdf5Descriptors(file) {
        const descriptors = [];
        const dimensionById = new Map();
        const visit = (group, groupPath) => {
            for (const key of group.keys().sort()) {
                const object = group.get(key);
                const path = object?.path || joinPath(groupPath, key);
                if (object?.type === 'Group') {
                    visit(object, path);
                    continue;
                }
                if (object?.type !== 'Dataset') continue;
                const dimId = Number(object.attrs?._Netcdf4Dimid?.value);
                if (Number.isInteger(dimId)) dimensionById.set(dimId, path);
                const typeInfo = this._hdf5TypeInfo(object);
                descriptors.push({
                    path,
                    name: basename(path),
                    group: dirname(path),
                    shape: [...(object.shape || [])].map(Number),
                    attrs: attrsFromHdf5(object, { includeTechnical: true }),
                    userAttrs: attrsFromHdf5(object),
                    dimensions: [],
                    read: ranges => ranges ? object.slice(ranges) : object.value,
                    supportsSlice: true,
                    numeric: typeInfo.numeric,
                    textual: typeInfo.textual,
                    chunks: typeInfo.chunks,
                    raw: object,
                });
            }
        };
        visit(file, '/');

        for (const descriptor of descriptors) {
            const list = descriptor.raw.attrs?.DIMENSION_LIST?.value;
            if (Array.isArray(list)) {
                descriptor.dimensions = list.map((refs, axis) => {
                    try {
                        return file.dereference(Array.isArray(refs) ? refs[0] : refs)?.path || `dimension_${axis}`;
                    } catch {
                        return `dimension_${axis}`;
                    }
                });
            } else {
                const ids = toArray(descriptor.raw.attrs?._Netcdf4Coordinates?.value).map(Number);
                descriptor.dimensions = descriptor.shape.map((_, axis) => dimensionById.get(ids[axis]) || `dimension_${axis}`);
                if (descriptor.shape.length === 1 && String(descriptor.attrs.CLASS || '') === 'DIMENSION_SCALE') {
                    descriptor.dimensions[0] = descriptor.path;
                }
            }
            delete descriptor.raw;
        }
        return descriptors;
    }

    // H5T classes: 0 integer, 1 float, 3 string, 8 enum. Asking the type is free;
    // reading the values to find out, which is what this used to do, cost a full
    // decompression of every variable in the file before anything was drawn.
    _hdf5TypeInfo(object) {
        let metadata = null;
        try {
            metadata = object.metadata;
        } catch {
            metadata = null;
        }
        const typeClass = Number(metadata?.type);
        const chunks = Array.isArray(metadata?.chunks) ? metadata.chunks.map(Number) : null;
        if (!Number.isInteger(typeClass)) return { numeric: undefined, textual: undefined, chunks };
        return { numeric: typeClass === 0 || typeClass === 1 || typeClass === 8, textual: typeClass === 3, chunks };
    }

    // netcdfjs used to read these, and it misreads record variables whose
    // per-record size is not a multiple of four bytes: it keeps the padding
    // between records as data, so every record after the first is shifted by a
    // value. Legacy-CDS ERA5 files are exactly that (int16 fields on odd-sized
    // grids). The by-parts reader follows the file format's padding rules and
    // reads CDF-5 as well.
    _parseNetcdf3(buffer, filename) {
        let opened;
        try {
            opened = openNetcdf3(new BufferByteSource(buffer));
        } catch (error) {
            throw new Error(`Could not parse netCDF3 file: ${error?.message || error}`);
        }
        return this._parseGeneric(opened.descriptors, opened.globalAttrs, filename, opened.storageFormat);
    }

    _parseGeneric(descriptors, globalAttrs, filename, storageFormat) {
        if (!descriptors.length) throw new Error('The netCDF file does not contain any data variables.');
        const coordinateCache = new Map();
        const readFlat = descriptor => {
            if (!coordinateCache.has(descriptor.path)) coordinateCache.set(descriptor.path, flatten(descriptor.read()));
            return coordinateCache.get(descriptor.path);
        };
        const dimensionUsage = this._dimensionUsage(descriptors);
        const coordinate = this._selectCoordinate(descriptors, dimensionUsage, readFlat);
        const axis = coordinate
            ? this._axisFromCoordinate(coordinate, this._coordinateValues(coordinate, readFlat), descriptors, readFlat)
            : this._syntheticAxis(descriptors, dimensionUsage);
        if (!axis) throw new Error('The netCDF file does not contain a usable one-dimensional coordinate or numeric array.');

        const result = {
            filename,
            metadata: {
                format: 'generic-netcdf',
                source: 'netcdf',
                storageFormat,
                timeName: axis.variable.name,
                timeKind: axis.variable.timeKind,
                timeDisplayMode: axis.variable.timeDisplayMode,
                sampleCount: axis.length,
                coordinateDataset: coordinate?.path || null,
                dimensions: [...dimensionUsage.entries()].map(([name, info]) => ({ name, size: info.size, variables: info.count })),
                globalAttributes: globalAttrs,
                skippedVariables: [],
                // Kept apart from skippedVariables: a partially loaded variable
                // is present and plottable, and folding it into the skipped list
                // made the file-type tooltip report it as one that could not be
                // read at all.
                partialVariables: [],
                generatedSeriesCount: 0,
                auxiliaryCoordinateCount: 0,
            },
            variables: { [axis.variable.name]: axis.variable },
            tree: this._rootNode(),
        };
        result.tree._variables[axis.variable.displayName || axis.variable.name] = axis.variable;
        this._addGlobalMetadata(result.tree, globalAttrs);

        const coordinatePaths = new Set(descriptors
            .filter(item => item.shape.length === 1 && item.dimensions[0] === item.path)
            .map(item => item.path));
        if (coordinate) coordinatePaths.add(coordinate.path);
        for (const descriptor of descriptors) {
            if (!coordinatePaths.has(descriptor.path) || descriptor.path === coordinate?.path) continue;
            this._addCoordinateMetadata(result.tree, descriptor, readFlat(descriptor));
            result.metadata.auxiliaryCoordinateCount += 1;
        }

        // Two passes: what every variable would cost has to be known before any
        // one of them is allowed to spend, or the variables that happen to come
        // first in the file take the whole allowance.
        const plans = [];
        for (const descriptor of descriptors) {
            if (descriptor.path === coordinate?.path || coordinatePaths.has(descriptor.path)) continue;
            // Scalars and text labels are context, not data: ERA5's `number`
            // (the ensemble member, 0) and `expver` ("0001" per step) used to be
            // listed under "Unsupported variables", which read as a failure.
            if (descriptor.shape.length === 0 || (descriptor.textual === true && descriptor.shape.length <= 2)) {
                this._addCoordinateMetadata(result.tree, descriptor, this._coordinateValues(descriptor, readFlat));
                result.metadata.auxiliaryCoordinateCount += 1;
                continue;
            }
            const alignment = this._timeAlignment(descriptor, axis);
            if (!alignment) {
                this._skip(result, descriptor, 'No dimension aligns with the selected X coordinate.');
                continue;
            }
            if (!this._descriptorIsNumeric(descriptor, readFlat)) {
                this._skip(result, descriptor, 'Only numeric variables can be plotted.');
                continue;
            }
            const otherAxes = descriptor.shape.map((size, index) => ({ size, index })).filter(item => item.index !== alignment.axis);
            const seriesCount = product(otherAxes.map(item => item.size));
            if (seriesCount < 1) {
                this._skip(result, descriptor, 'The variable has no series to expand along the selected X coordinate.');
                continue;
            }
            plans.push({ descriptor, alignment, otherAxes, seriesCount });
        }

        const limits = seriesLimits(plans.map(plan => plan.seriesCount), axis.length);
        for (const [planIndex, plan] of plans.entries()) {
            const { descriptor, alignment, otherAxes, seriesCount } = plan;
            const limit = limits[planIndex];
            if (limit < 1) {
                this._skip(result, descriptor, `Expanding this variable would exceed the ${MAX_GENERATED_SERIES.toLocaleString()}-series safety limit.`);
                continue;
            }
            const labelsByAxis = new Map(otherAxes.map(item => [item.index, this._dimensionLabels(
                descriptor.dimensions[item.index], descriptor.shape[item.index], descriptors, readFlat
            )]));
            const sample = gridSample(otherAxes.map(item => item.size), limit);
            if (sample.combinations.length < seriesCount) {
                const perAxis = otherAxes.map((item, index) => ({
                    dimension: basename(descriptor.dimensions[item.index]),
                    kept: sample.counts[index],
                    size: item.size,
                }));
                result.metadata.partialVariables.push({
                    name: descriptor.path,
                    reason: `Loaded ${sample.combinations.length.toLocaleString()} of ${seriesCount.toLocaleString()} slices (${perAxis.map(item => `${item.kept} of ${item.size} ${item.dimension}`).join(' x ')}), evenly spaced along each dimension, to keep the dataset responsive.`,
                    shape: descriptor.shape,
                    dimensions: descriptor.dimensions,
                    partial: true,
                    generatedSeriesCount: sample.combinations.length,
                    availableSeriesCount: seriesCount,
                    sampledAxes: perAxis,
                });
            }
            const rawSeries = this._readSeriesBatch(descriptor, alignment.axis, otherAxes, sample.combinations, readFlat);
            for (const [combinationIndex, combination] of sample.combinations.entries()) {
                const fixed = new Map(otherAxes.map((item, index) => [item.index, combination[index]]));
                const values = decodeNumeric(rawSeries[combinationIndex], descriptor.userAttrs);
                const selectors = otherAxes.map(item => ({
                    dimension: basename(descriptor.dimensions[item.index]),
                    index: fixed.get(item.index),
                    label: coordinateLabel(labelsByAxis.get(item.index)?.[fixed.get(item.index)], fixed.get(item.index)),
                }));
                const variable = this._seriesVariable(descriptor, selectors, values);
                result.variables[variable.name] = variable;
                this._addSeriesTree(result.tree, descriptor, selectors, variable);
                result.metadata.generatedSeriesCount += 1;
            }
        }

        result.metadata.skippedVariablesCount = result.metadata.skippedVariables.length;
        result.metadata.partialVariablesCount = result.metadata.partialVariables.length;
        this._addSkippedTree(result.tree, result.metadata.skippedVariables);
        this._addPartialTree(result.tree, result.metadata.partialVariables);
        if (result.metadata.generatedSeriesCount === 0) {
            throw new Error('The netCDF file did not expose any numeric variables aligned with its selected X coordinate.');
        }
        return result;
    }

    _dimensionUsage(descriptors) {
        const usage = new Map();
        for (const descriptor of descriptors) {
            descriptor.dimensions.forEach((dimension, axis) => {
                const info = usage.get(dimension) || { size: descriptor.shape[axis], count: 0 };
                info.count += 1;
                info.size = descriptor.shape[axis];
                usage.set(dimension, info);
            });
        }
        return usage;
    }

    _selectCoordinate(descriptors, dimensionUsage, readFlat) {
        const scored = descriptors.map(descriptor => {
            const axisCandidate = this._coordinateAxisCandidate(descriptor, readFlat);
            if (!axisCandidate) return null;
            const attrs = descriptor.userAttrs;
            const name = descriptor.name.toLowerCase();
            const units = attrText(attrs, UNIT_KEYS);
            const values = this._coordinateValues(descriptor, readFlat);
            let score = 0;
            if (cfTimeUnits(units)) score += 1000;
            if (String(attrValue(attrs, ['axis']) || '').toUpperCase() === 'T') score += 900;
            if (String(attrValue(attrs, ['standard_name']) || '').toLowerCase() === 'time') score += 850;
            if (TIME_LIKE_NAME.test(name)) score += 800;
            else if (name.includes('time')) score += 650;
            if (descriptor.dimensions[0] === descriptor.path) score += 300;
            const axisName = String(attrValue(attrs, ['axis']) || '').toUpperCase();
            const standardName = String(attrValue(attrs, ['standard_name']) || '').toLowerCase();
            if (axisName === 'Z') score -= 300;
            else if (axisName === 'X' || axisName === 'Y') score -= 100;
            if (['longitude', 'latitude', 'projection_x_coordinate', 'projection_y_coordinate'].includes(standardName)) score -= 50;
            score += (dimensionUsage.get(axisCandidate.dimension)?.count || 0) * 10;
            if (values.every(value => isNumericValue(value)) || values.every(value => Number.isFinite(parseDate(value)))) score += 50;
            else score = -1;
            return { descriptor, score, axisCandidate };
        }).filter(item => item && item.score >= 0);
        scored.sort((a, b) => b.score - a.score || a.descriptor.path.localeCompare(b.descriptor.path));
        if (!scored[0]) return null;
        return {
            ...scored[0].descriptor,
            axisDimension: scored[0].axisCandidate.dimension,
            axisLength: scored[0].axisCandidate.length,
        };
    }

    _coordinateAxisCandidate(descriptor, readFlat) {
        if (descriptor.shape.length === 1 && descriptor.shape[0] > 1) {
            return { dimension: descriptor.dimensions[0] || descriptor.path, length: descriptor.shape[0] };
        }
        // A time axis with a single step is still the time axis. Without this a
        // one-instant ERA5 download (a map) took latitude as its X coordinate and
        // turned every longitude into a "series" running pole to pole.
        if (descriptor.shape.length === 1 && descriptor.shape[0] === 1 && this._isTimeCoordinate(descriptor)) {
            return { dimension: descriptor.dimensions[0] || descriptor.path, length: 1 };
        }
        if (descriptor.shape.length === 2 && descriptor.shape[0] > 1 && descriptor.textual !== false) {
            const values = this._coordinateValues(descriptor, readFlat);
            if (values.length === descriptor.shape[0] && values.every(value => typeof value === 'string')) {
                return { dimension: descriptor.dimensions[0] || descriptor.path, length: descriptor.shape[0] };
            }
        }
        return null;
    }

    _isTimeCoordinate(descriptor) {
        const attrs = descriptor.userAttrs || {};
        if (cfTimeUnits(attrText(attrs, UNIT_KEYS))) return true;
        if (String(attrValue(attrs, ['axis']) || '').toUpperCase() === 'T') return true;
        return String(attrValue(attrs, ['standard_name']) || '').toLowerCase() === 'time';
    }

    _coordinateValues(descriptor, readFlat) {
        const values = readFlat(descriptor);
        if (
            descriptor.shape.length === 2
            && descriptor.shape[0] > 1
            && descriptor.shape[1] > 1
            && values.length >= descriptor.shape[0] * descriptor.shape[1]
            && values.every(value => typeof value === 'string')
        ) {
            const width = descriptor.shape[1];
            const relevantValues = values.slice(0, descriptor.shape[0] * descriptor.shape[1]);
            const rows = [];
            for (let offset = 0; offset < relevantValues.length; offset += width) {
                rows.push(relevantValues.slice(offset, offset + width).join('').replace(/\0/g, '').trim());
            }
            return rows;
        }
        return values;
    }

    _axisFromCoordinate(descriptor, rawValues, descriptors = [], readFlat = () => []) {
        const attrs = descriptor.userAttrs;
        const units = attrText(attrs, UNIT_KEYS);
        const calendar = String(attrValue(attrs, ['calendar']) || 'standard').toLowerCase();
        const cf = cfTimeUnits(units);
        let values;
        let timeKind = 'numeric';
        let timeDisplayMode;
        let timeSourceStrategy = 'netcdf-coordinate';
        if (cf && !NON_STANDARD_CALENDARS.has(calendar)) {
            values = Float64Array.from(numericArray(rawValues), value => cf.originMs + value * cf.scaleMs);
            timeKind = 'datetime';
            timeDisplayMode = 'calendar';
            timeSourceStrategy = 'netcdf-cf-time';
        } else {
            const offsetOrigin = this._offsetTimeOrigin(descriptor, descriptors, readFlat);
            if (offsetOrigin) {
                values = Float64Array.from(numericArray(rawValues), value => offsetOrigin.originMs + value * offsetOrigin.scaleMs);
                timeKind = 'datetime';
                timeDisplayMode = 'calendar';
                timeSourceStrategy = offsetOrigin.strategy;
            } else if (rawValues.length && rawValues.every(value => Number.isFinite(parseDate(value)))) {
                const dates = rawValues.map(parseDate);
                values = Float64Array.from(dates);
                timeKind = 'datetime';
                timeDisplayMode = 'calendar';
                timeSourceStrategy = 'netcdf-datetime-coordinate';
            } else {
                values = decodeNumeric(numericArray(rawValues), attrs);
            }
        }
        const name = `netcdf:@axis/${idSegment(descriptor.path)}`;
        return {
            length: values.length,
            dimension: descriptor.axisDimension || descriptor.dimensions[0] || descriptor.path,
            fallbackByLength: !descriptor.dimensions[0],
            variable: {
                name,
                displayName: descriptor.name,
                data: values,
                description: this._description(descriptor, [], true),
                units,
                kind: 'abscissa',
                timeSourceStrategy,
                dataType: 'numeric',
                isConstant: this.structureParser._isConstantValues(values),
                interpolation: 'linear',
                negate: false,
                source: 'netcdf',
                timeKind,
                timeDisplayMode,
                timeOriginMs: timeKind === 'datetime' ? values[0] : undefined,
                netcdf: { dataset: descriptor.path, dimensions: descriptor.dimensions, attrs },
            },
        };
    }

    _offsetTimeOrigin(descriptor, descriptors, readFlat) {
        if (!/time[_-]?offset/i.test(descriptor.name)) return null;
        const scaleMs = plainTimeUnitScaleMs(attrText(descriptor.userAttrs, UNIT_KEYS) || attrText(descriptor.userAttrs, DESCRIPTION_KEYS));
        if (!Number.isFinite(scaleMs)) return null;
        const byName = new Map(descriptors.map(item => [item.name.toLowerCase(), item]));
        const scalarValue = name => {
            const found = byName.get(name.toLowerCase());
            if (!found || found.shape.length > 0) return NaN;
            const value = Number(readFlat(found)[0]);
            return Number.isFinite(value) ? value : NaN;
        };

        const baseTime = scalarValue('base_time');
        if (Number.isFinite(baseTime)) {
            return { originMs: baseTime * 1000, scaleMs, strategy: 'netcdf-time-offset-base-time' };
        }

        const year = scalarValue('start_year');
        const month = scalarValue('start_month');
        const day = scalarValue('start_day');
        if ([year, month, day].every(Number.isFinite)) {
            const hour = scalarValue('start_hour');
            const minute = scalarValue('start_minute');
            const second = scalarValue('start_second');
            const wholeSecond = Number.isFinite(second) ? Math.trunc(second) : 0;
            const millisecond = Number.isFinite(second) ? Math.round((second - wholeSecond) * 1000) : 0;
            return {
                originMs: Date.UTC(year, month - 1, day, Number.isFinite(hour) ? hour : 0, Number.isFinite(minute) ? minute : 0, wholeSecond, millisecond),
                scaleMs,
                strategy: 'netcdf-time-offset-start-parts',
            };
        }

        return null;
    }

    _syntheticAxis(descriptors, dimensionUsage) {
        const dimensions = [...dimensionUsage.entries()]
            .filter(([, info]) => info.size > 1)
            .sort((a, b) => b[1].count - a[1].count || b[1].size - a[1].size);
        let dimension = dimensions[0]?.[0];
        let length = dimensions[0]?.[1]?.size;
        if (!length) {
            const vector = descriptors.find(item => item.shape.length === 1 && item.shape[0] > 1);
            if (!vector) return null;
            dimension = vector.dimensions[0] || null;
            length = vector.shape[0];
        }
        const values = Float64Array.from({ length }, (_, index) => index);
        const name = 'netcdf:@axis/sample';
        return {
            length,
            dimension,
            fallbackByLength: !dimension,
            variable: {
                name,
                displayName: 'sample',
                data: values,
                description: '[Synthetic sample index generated for netCDF data]',
                kind: 'abscissa',
                timeSourceStrategy: 'netcdf-sample-index',
                dataType: 'numeric',
                isConstant: false,
                interpolation: 'linear',
                negate: false,
                source: 'netcdf',
                timeKind: 'index',
                timeStepMode: 'index',
                netcdf: { synthetic: true, dimension },
            },
        };
    }

    _descriptorIsNumeric(descriptor, readFlat) {
        if (typeof descriptor.numeric === 'boolean') return descriptor.numeric && product(descriptor.shape) > 0;
        const values = readFlat(descriptor);
        return values.length > 0 && values.every(isNumericValue);
    }

    _timeAlignment(descriptor, axis) {
        const matches = descriptor.dimensions
            .map((dimension, index) => ({ dimension, index }))
            .filter(item => item.dimension === axis.dimension && descriptor.shape[item.index] === axis.length);
        if (matches.length === 1) return { axis: matches[0].index };
        if (!matches.length && axis.fallbackByLength) {
            const axes = descriptor.shape.map((size, index) => ({ size, index })).filter(item => item.size === axis.length);
            if (axes.length === 1) return { axis: axes[0].index };
        }
        return null;
    }

    _dimensionLabels(dimension, size, descriptors, readFlat) {
        const coordinate = descriptors.find(item => item.path === dimension && item.shape.length === 1 && item.shape[0] === size)
            || descriptors.find(item => item.group === dirname(dimension) && item.name === basename(dimension) && item.shape.length === 1 && item.shape[0] === size);
        if (!coordinate) return Array.from({ length: size }, (_, index) => index);
        const values = readFlat(coordinate);
        const cf = cfTimeUnits(attrText(coordinate.userAttrs, UNIT_KEYS));
        const calendar = String(attrValue(coordinate.userAttrs, ['calendar']) || 'standard').toLowerCase();
        if (cf && !NON_STANDARD_CALENDARS.has(calendar)) {
            // A selector reads "valid_time=2024-01-01T06:00Z", not "=1704088800".
            return values.map((value, index) => isoLabel(cf.originMs + Number(value) * cf.scaleMs) || index);
        }
        return values;
    }

    /**
     * Every requested series of one variable, cut out of the variable read whole
     * (or in slabs along its sample axis when it is large), so each chunk on disk
     * is decompressed once however many series come out of it.
     */
    _readSeriesBatch(descriptor, timeAxis, otherAxes, combinations, readFlat) {
        const shape = descriptor.shape;
        if (shape.length === 1) return [readFlat(descriptor)];
        const length = shape[timeAxis];
        const total = product(shape);
        const outputs = combinations.map(() => new Float64Array(length));
        const gather = (values, valuesShape, timeOffset) => {
            const strides = rowMajorStrides(valuesShape);
            const timeStride = strides[timeAxis];
            const steps = valuesShape[timeAxis];
            combinations.forEach((combination, index) => {
                let base = 0;
                otherAxes.forEach((item, position) => { base += combination[position] * strides[item.index]; });
                const target = outputs[index];
                for (let step = 0; step < steps; step++) target[timeOffset + step] = Number(values[base + step * timeStride]);
            });
        };
        const wholeRead = () => gather(
            descriptor.supportsSlice ? flatValues(descriptor.read()) : flatValues(descriptor.read ? descriptor.read() : readFlat(descriptor)),
            shape,
            0,
        );
        if (!descriptor.supportsSlice || total <= WHOLE_READ_VALUE_LIMIT) {
            wholeRead();
            return outputs;
        }
        const otherSize = Math.max(1, total / Math.max(1, length));
        let block = Math.max(1, Math.floor(SLAB_VALUE_TARGET / otherSize));
        const chunkSteps = Number(descriptor.chunks?.[timeAxis]);
        if (Number.isInteger(chunkSteps) && chunkSteps > 0 && block >= chunkSteps) block = Math.floor(block / chunkSteps) * chunkSteps;
        try {
            for (let start = 0; start < length; start += block) {
                const stop = Math.min(length, start + block);
                const ranges = shape.map((size, axis) => (axis === timeAxis ? [start, stop] : [0, size]));
                const slabShape = shape.map((size, axis) => (axis === timeAxis ? stop - start : size));
                gather(flatValues(descriptor.read(ranges)), slabShape, start);
            }
        } catch {
            wholeRead();
        }
        return outputs;
    }

    _seriesVariable(descriptor, selectors, values) {
        const selectorId = selectors.map(item => `${idSegment(item.dimension)}=${idSegment(item.label)}`).join('/');
        const name = `netcdf:${descriptor.path.split('/').filter(Boolean).map(idSegment).join('/')}${selectorId ? `/${selectorId}` : ''}`;
        const suffix = selectors.map(item => `${item.dimension}=${item.label}`).join(', ');
        const displayName = `${descriptor.path}${suffix ? ` [${suffix}]` : ''}`;
        const units = attrText(descriptor.userAttrs, UNIT_KEYS);
        return {
            name,
            displayName,
            data: values,
            description: this._description(descriptor, selectors),
            units,
            kind: 'variable',
            dataType: this.structureParser._detectDataType(values, name),
            isConstant: this.structureParser._isConstantValues(values),
            interpolation: 'linear',
            negate: false,
            source: 'netcdf',
            netcdf: {
                dataset: descriptor.path,
                dimensions: descriptor.dimensions,
                shape: descriptor.shape,
                selection: Object.fromEntries(selectors.map(item => [item.dimension, { index: item.index, label: item.label }])),
                attrs: descriptor.userAttrs,
            },
        };
    }

    _description(descriptor, selectors, axis = false) {
        const units = attrText(descriptor.userAttrs, UNIT_KEYS);
        const longName = attrText(descriptor.userAttrs, DESCRIPTION_KEYS);
        const details = [longName, units ? `units=${units}` : '', ...selectors.map(item => `${item.dimension}=${item.label}`)].filter(Boolean);
        return `${axis ? 'netCDF coordinate' : 'netCDF variable'} ${descriptor.path}${details.length ? ` (${details.join(', ')})` : ''}`;
    }

    _skip(result, descriptor, reason) {
        result.metadata.skippedVariables.push({
            name: descriptor.path,
            reason,
            shape: descriptor.shape,
            dimensions: descriptor.dimensions,
        });
    }

    _rootNode() {
        return { _type: 'root', _name: '', _children: Object.create(null), _variables: Object.create(null) };
    }

    // Every key here is a path segment out of the file. On a plain object
    // `_children['__proto__']` reads Object.prototype instead of "not there yet",
    // and assigning to it sets the prototype instead of adding a child — so a
    // crafted group name walked the builder into Object.prototype and the parse
    // died on a TypeError rather than saying the file was unsupported. The maps
    // are prototype-less (see _rootNode), which makes a segment just a key.
    _ensureNode(root, parts) {
        let node = root;
        let fullName = '';
        for (const part of parts) {
            fullName = fullName ? `${fullName}.${part}` : part;
            if (!node._children[part]) {
                node._children[part] = { _type: 'component', _name: part, _fullName: fullName, _children: Object.create(null), _variables: Object.create(null) };
            }
            node = node._children[part];
        }
        return node;
    }

    _addSeriesTree(root, descriptor, selectors, variable) {
        const groupParts = descriptor.path.split('/').filter(Boolean);
        const variableName = groupParts.pop();
        const node = this._ensureNode(root, groupParts);
        if (!selectors.length) {
            node._variables[variableName] = variable;
            return;
        }
        const variableNode = this._ensureNode(node, [variableName]);
        const label = selectors.map(item => `${item.dimension}=${item.label}`).join(', ');
        variableNode._variables[label] = variable;
    }

    _addGlobalMetadata(root, attrs) {
        const entries = Object.entries(attrs || {});
        if (!entries.length) return;
        const node = this._ensureNode(root, [METADATA_NODE]);
        node._type = 'metadata';
        for (const [name, value] of entries) {
            node._variables[name] = this._metadataVariable(`netcdf:@global/${idSegment(name)}`, name, value, `Global netCDF attribute ${name}`);
        }
    }

    _addCoordinateMetadata(root, descriptor, values) {
        const node = this._ensureNode(root, [COORDINATES_NODE]);
        node._type = 'metadata';
        const units = attrText(descriptor.userAttrs, UNIT_KEYS);
        node._variables[descriptor.path] = {
            name: `netcdf:@coordinate/${idSegment(descriptor.path)}`,
            displayName: descriptor.path,
            data: values.map(scalar),
            description: `Auxiliary netCDF coordinate ${descriptor.path}${units ? ` (units=${units})` : ''}`,
            units,
            kind: 'parameter',
            dataType: values.every(isNumericValue) ? 'numeric' : 'string',
            isConstant: false,
            interpolation: 'constant',
            negate: false,
            source: 'netcdf',
            plottable: false,
            netcdf: { coordinate: true, dataset: descriptor.path, attrs: descriptor.userAttrs },
        };
    }

    _addSkippedTree(root, skipped) {
        if (!skipped.length) return;
        const node = this._ensureNode(root, [UNSUPPORTED_NODE]);
        node._type = 'metadata';
        for (const item of skipped) {
            const label = item.name;
            node._variables[label] = this._metadataVariable(
                `netcdf:@skipped/${idSegment(item.name)}`,
                label,
                'unsupported',
                `Skipped netCDF variable ${item.name}: ${item.reason} Shape: [${item.shape.join(', ')}]. Dimensions: [${item.dimensions.join(', ')}].`
            );
        }
    }

    // Its own node rather than a corner of "Unsupported variables": these
    // variables did load, and the tree is where someone goes to find out which
    // ones they are holding a sample of.
    _addPartialTree(root, partial) {
        if (!partial.length) return;
        const node = this._ensureNode(root, [PARTIAL_NODE]);
        node._type = 'metadata';
        for (const item of partial) {
            node._variables[item.name] = this._metadataVariable(
                `netcdf:@partial/${idSegment(item.name)}`,
                item.name,
                'partial',
                `Partially loaded netCDF variable ${item.name}: ${item.reason} Shape: [${item.shape.join(', ')}]. Dimensions: [${item.dimensions.join(', ')}].`
            );
        }
    }

    _metadataVariable(name, displayName, value, description) {
        return {
            name,
            displayName,
            data: [value],
            description,
            kind: 'parameter',
            dataType: typeof value === 'string' ? 'string' : 'numeric',
            isConstant: true,
            interpolation: 'constant',
            negate: false,
            source: 'netcdf',
            plottable: false,
            netcdf: { metadata: true },
        };
    }
}
