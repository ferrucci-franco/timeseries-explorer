// The gridded dataset engine: what a gridded netCDF file contains, and the
// three reads the map view is built on — one map, one point's time series, and
// statistics over a region for every time step.
//
// It runs inside a Worker (src/workers/gridded-worker.js) and holds the files
// open there, reading by parts: h5wasm on a WORKERFS mount for netCDF4, the
// by-parts netCDF3 reader for the rest. Nothing here touches the DOM, so the
// same code is exercised directly by scripts/test-gridded-dataset.mjs on
// in-memory buffers.
//
// Every request is in coordinates, never indices: the main thread says "the
// cell nearest 45.2 N, 3.5 E" or "the box 42-51 N, 5 W-8 E", and the index
// arithmetic (descending latitude, 0..360 longitude rolled to -180..180, a box
// that wraps the antimeridian) stays here.

import { openHdf5 } from './hdf5-input.js';
import { openGrib, scanGribAsync } from './grib-reader.js';
import NetcdfParser from '../parsers/netcdf-parser.js';
import { netcdfContainerError, sniffNetcdfContainer } from '../parsers/netcdf-sniff.js';
import {
    DESCRIPTION_KEYS,
    UNIT_KEYS,
    attrText,
    attrValue,
    attrsFromHdf5,
    cfTimeUnits,
    decodeNumeric,
    flatten,
} from '../parsers/netcdf-cf.js';
import { BufferByteSource, FileByteSource } from './byte-source.js';
import { decodeCfTime } from './cf-time.js';
import { openNetcdf3 } from './nc3-reader.js';

const TIME_NAME = /^(time|times|valid_time|date|datetime|t)$/i;
const LAT_NAME = /^(lat|lats|latitude|nav_lat|xlat|y_?lat|rlat_?deg)$/i;
const LON_NAME = /^(lon|lons|long|longitude|nav_lon|xlong|x_?lon)$/i;
const LEVEL_NAME = /^(level|levels|lev|plev|pressure_level|pressure|isobaricinhpa|isobaric|height|depth|altitude|alt|z|model_level|model_level_number|hybrid|sigma|bottom_top|soil_?layer|depthbelowlandlayer)$/i;
const LEVEL_STANDARD_NAMES = new Set([
    'air_pressure', 'altitude', 'height', 'depth', 'model_level_number',
    'atmosphere_hybrid_sigma_pressure_coordinate', 'atmosphere_sigma_coordinate',
    'atmosphere_ln_pressure_coordinate', 'ocean_sigma_coordinate', 'ocean_s_coordinate',
    'height_above_reference_ellipsoid', 'geopotential_height', 'depth_below_surface',
]);
const PRESSURE_UNITS = /^(pa|hpa|kpa|mb|mbar|millibar|millibars|bar|atm)$/i;
const LAT_UNITS = /^(degrees?_?n(orth)?|degree_n|degrees?n|deg_n)$/i;
const LON_UNITS = /^(degrees?_?e(ast)?|degree_e|degrees?e|deg_e)$/i;
// One read of a region or a column is at most this many values; a longer time
// span is read in blocks, which is also where progress is reported and a
// cancel is noticed.
const BLOCK_VALUE_TARGET = 4 * 1024 * 1024;
const MIN_PROGRESS_BLOCKS = 40;


function basename(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    return parts.at(-1) || '';
}

function product(values) {
    return values.reduce((total, value) => total * value, 1);
}

function flatNumbers(value) {
    if (ArrayBuffer.isView(value)) return value;
    return flatten(value);
}

function tick() {
    return new Promise(resolve => setTimeout(resolve, 0));
}

export class CancelledError extends Error {
    constructor() {
        super('Cancelled');
        this.name = 'AbortError';
        this.cancelled = true;
    }
}

function readHead(input) {
    if (input.buffer) return new Uint8Array(input.buffer, 0, Math.min(input.buffer.byteLength, 4096));
    return new FileByteSource(input.file).read(0, 4096);
}

/** Opens one file and lists its variables as reader-neutral descriptors. */
async function openMember(input, parser, job = null) {
    const filename = input.filename || input.file?.name || 'dataset.nc';
    const { kind } = sniffNetcdfContainer(readHead(input));
    if (kind === 'hdf5') {
        // Mounted, never copied, inside the Worker (see hdf5-input.js).
        const opened = await openHdf5(input);
        const file = opened.file;
        const rootKeys = file.keys().sort();
        const pypsa = parser.pypsaParser._looksLikePypsa(rootKeys);
        const descriptors = pypsa ? [] : parser._hdf5Descriptors(file);
        return {
            filename,
            storageFormat: 'netcdf4-hdf5',
            pypsa,
            globalAttrs: attrsFromHdf5(file),
            descriptors,
            close() {
                opened.close();
            },
        };
    }
    if (kind === 'netcdf3-classic' || kind === 'netcdf3-64-bit-offset' || kind === 'cdf5') {
        const source = input.buffer ? new BufferByteSource(input.buffer) : new FileByteSource(input.file);
        const opened = openNetcdf3(source);
        return { filename, storageFormat: opened.storageFormat, pypsa: false, globalAttrs: opened.globalAttrs, descriptors: opened.descriptors, close() {} };
    }
    if (kind === 'grib') {
        // Its messages listed by their headers; a field is decoded when read.
        // A long file is walked in turns, so that a cancel is heard.
        const source = input.buffer ? new BufferByteSource(input.buffer) : new FileByteSource(input.file);
        const opened = openGrib(source, await scanGribAsync(source, async () => {
            await tick();
            if (job?.cancelled) throw new CancelledError();
        }));
        return { filename, storageFormat: opened.storageFormat, pypsa: false, globalAttrs: opened.globalAttrs, descriptors: opened.descriptors, close() {} };
    }
    throw netcdfContainerError(kind);
}

function coordinateRole(descriptor) {
    const attrs = descriptor.userAttrs || {};
    const name = descriptor.name;
    const units = attrText(attrs, UNIT_KEYS).trim();
    const standardName = String(attrValue(attrs, ['standard_name']) || '').toLowerCase();
    const axis = String(attrValue(attrs, ['axis']) || '').toUpperCase();
    if (axis === 'T' || standardName === 'time' || cfTimeUnits(units) || TIME_NAME.test(name)) return 't';
    if (standardName === 'latitude' || LAT_UNITS.test(units) || (LAT_NAME.test(name) && (!units || /degree/i.test(units)))) return 'y';
    if (standardName === 'longitude' || LON_UNITS.test(units) || (LON_NAME.test(name) && (!units || /degree/i.test(units)))) return 'x';
    if (axis === 'Z' || attrValue(attrs, ['positive']) !== undefined || LEVEL_STANDARD_NAMES.has(standardName)
        || LEVEL_NAME.test(name) || PRESSURE_UNITS.test(units)) return 'z';
    return 'other';
}

/** One member file, described: coordinates by dimension, data variables with their axis roles. */
function describeMember(member) {
    const byPath = new Map(member.descriptors.map(item => [item.path, item]));
    const coordinateFor = dimension => {
        const direct = byPath.get(dimension);
        if (direct && direct.shape.length === 1) return direct;
        const name = basename(dimension);
        return member.descriptors.find(item => item.shape.length === 1 && item.name === name && item.dimensions[0] && basename(item.dimensions[0]) === name) || null;
    };
    const boundsPaths = new Set();
    for (const descriptor of member.descriptors) {
        const bounds = attrValue(descriptor.userAttrs, ['bounds']);
        if (bounds) boundsPaths.add(`/${String(bounds).replace(/^\//, '')}`);
    }
    const coordinatePaths = new Set();
    const dims = new Map();
    for (const descriptor of member.descriptors) {
        descriptor.dimensions.forEach((dimension, axis) => {
            const name = basename(dimension) || `dim${axis}`;
            if (dims.has(name)) return;
            const coordinate = coordinateFor(dimension);
            if (coordinate) coordinatePaths.add(coordinate.path);
            dims.set(name, {
                name,
                size: descriptor.shape[axis],
                coordinate,
                role: coordinate ? coordinateRole(coordinate) : 'other',
            });
        });
    }
    const variables = [];
    for (const descriptor of member.descriptors) {
        if (coordinatePaths.has(descriptor.path) || boundsPaths.has(descriptor.path)) continue;
        if (/_(bnds|bounds)$|^bnds$/i.test(descriptor.name)) continue;
        if (descriptor.numeric === false || descriptor.textual) continue;
        const dimNames = descriptor.dimensions.map((dimension, axis) => basename(dimension) || `dim${axis}`);
        const roles = dimNames.map(name => dims.get(name)?.role || 'other');
        const yAxis = roles.indexOf('y');
        const xAxis = roles.indexOf('x');
        const mapable = descriptor.shape.length >= 2 && yAxis >= 0 && xAxis >= 0
            && roles.filter(role => role === 'y').length === 1 && roles.filter(role => role === 'x').length === 1;
        variables.push({ descriptor, dimNames, roles, mapable });
    }
    return { dims, variables };
}

function lonDisplayOrder(lon) {
    const wrapped = Array.from(lon, value => (value > 180 ? value - 360 : value));
    const breaks = [];
    for (let index = 1; index < wrapped.length; index++) if (wrapped[index] < wrapped[index - 1]) breaks.push(index);
    if (!breaks.length) return { order: wrapped.map((_, index) => index), values: Float64Array.from(wrapped) };
    if (breaks.length === 1 && wrapped.at(-1) < wrapped[0]) {
        const k = breaks[0];
        const order = [...Array.from({ length: wrapped.length - k }, (_, i) => k + i), ...Array.from({ length: k }, (_, i) => i)];
        return { order, values: Float64Array.from(order, index => wrapped[index]) };
    }
    return { order: Array.from(lon, (_, index) => index), values: Float64Array.from(lon) };
}

function circularDistance(a, b) {
    const d = Math.abs((((a - b) % 360) + 540) % 360 - 180);
    return d;
}

export class GriddedDataset {
    /**
     * @param {Array<{file?: File, buffer?: ArrayBuffer, filename?: string}>} inputs
     * @param {{mode?: 'single'|'concat-time'|'merge-variables', title?: string}} options
     */
    static async open(inputs, options = {}, job = null) {
        const parser = new NetcdfParser();
        const members = [];
        try {
            for (const input of inputs) {
                if (job?.cancelled) throw new CancelledError();
                members.push(await openMember(input, parser, job));
            }
        } catch (error) {
            for (const member of members) member.close();
            throw error;
        }
        const dataset = new GriddedDataset(members, options);
        try {
            dataset._build(options.mode || (members.length > 1 ? 'merge-variables' : 'single'));
        } catch (error) {
            dataset.close();
            throw error;
        }
        return dataset;
    }

    constructor(members, options) {
        this.members = members;
        this.title = options.title || members.map(member => member.filename).join(' + ');
        this.axes = new Map();
        this.variables = new Map();
        this.grids = new Map();
        this.gridded = false;
    }

    close() {
        for (const member of this.members) member.close();
        this.members = [];
    }

    _decodeAxis(dim) {
        const coordinate = dim.coordinate;
        const axis = { name: dim.name, role: dim.role, size: dim.size, units: '', longName: '', positive: '' };
        if (!coordinate) {
            axis.values = Float64Array.from({ length: dim.size }, (_, index) => index);
            axis.labels = Array.from(axis.values, value => String(value));
            axis.kind = 'index';
            return axis;
        }
        const attrs = coordinate.userAttrs || {};
        axis.units = attrText(attrs, UNIT_KEYS);
        axis.longName = attrText(attrs, DESCRIPTION_KEYS);
        axis.positive = String(attrValue(attrs, ['positive']) || '');
        axis.coordinatePath = coordinate.path;
        const raw = coordinate.textual ? [] : flatNumbers(coordinate.read());
        if (dim.role === 't') {
            const decoded = decodeCfTime(raw, axis.units, attrValue(attrs, ['calendar']));
            axis.values = decoded.values;
            axis.labels = decoded.labels;
            axis.kind = decoded.kind;
            axis.calendar = decoded.calendar;
            axis.unitsLabel = decoded.unitsLabel;
            return axis;
        }
        if (coordinate.textual) {
            axis.values = Float64Array.from({ length: dim.size }, (_, index) => index);
            axis.labels = Array.from(axis.values, value => String(value));
            axis.kind = 'index';
            return axis;
        }
        axis.values = Float64Array.from(raw, value => Number(value));
        axis.labels = Array.from(axis.values, value => String(Number(value.toPrecision(8))));
        axis.kind = 'numeric';
        return axis;
    }

    _build(mode) {
        const described = this.members.map(member => describeMember(member));
        const anyMapable = described.some(item => item.variables.some(variable => variable.mapable));
        this.gridded = anyMapable && !this.members.some(member => member.pypsa);
        if (!this.gridded) return;

        if (mode === 'concat-time') this._buildConcatenated(described);
        else this._buildMerged(described);
        this.primaryTimeDim = [...this.variables.values()].find(variable => variable.mapable && variable.timeDim)?.timeDim || null;
    }

    _registerVariable(entry, segments, keySuffix = '') {
        const { descriptor, dimNames, roles, mapable } = entry;
        const key = `${descriptor.path}${keySuffix}`;
        const attrs = descriptor.userAttrs || {};
        const timeAxis = roles.indexOf('t');
        this.variables.set(key, {
            key,
            name: descriptor.name + keySuffix,
            path: descriptor.path,
            longName: attrText(attrs, ['long_name', 'description', 'standard_name']),
            standardName: String(attrValue(attrs, ['standard_name']) || ''),
            units: attrText(attrs, UNIT_KEYS),
            attrs,
            dimNames,
            roles,
            mapable,
            timeDim: timeAxis >= 0 ? dimNames[timeAxis] : null,
            shape: dimNames.map(name => this.axes.get(name)?.size ?? descriptor.shape[dimNames.indexOf(name)]),
            segments,
        });
    }

    _buildMerged(described) {
        const seenNames = new Set();
        described.forEach((member, memberIndex) => {
            for (const dim of member.dims.values()) {
                const existing = this.axes.get(dim.name);
                if (!existing) this.axes.set(dim.name, this._decodeAxis(dim));
                else if (existing.size !== dim.size) {
                    throw Object.assign(new Error(`The files do not share the dimension "${dim.name}" (${existing.size} vs ${dim.size}).`), { code: 'GRIDDED_INCOMPATIBLE' });
                }
            }
            for (const entry of member.variables) {
                const suffix = seenNames.has(entry.descriptor.path) ? ` (${memberIndex + 1})` : '';
                seenNames.add(entry.descriptor.path);
                this._registerVariable(entry, [{ member: memberIndex, descriptor: entry.descriptor, tStart: 0, tCount: null }], suffix);
            }
        });
    }

    _buildConcatenated(described) {
        // Members in time order, whatever order the files were picked in.
        const timeDimOf = member => [...member.dims.values()].find(dim => dim.role === 't');
        const firstTimes = described.map(member => {
            const dim = timeDimOf(member);
            return dim ? this._decodeAxis(dim) : null;
        });
        if (firstTimes.some(axis => !axis)) {
            throw Object.assign(new Error('Every file needs a time dimension to be joined along it.'), { code: 'GRIDDED_INCOMPATIBLE' });
        }
        const order = described.map((_, index) => index).sort((a, b) => firstTimes[a].values[0] - firstTimes[b].values[0]);
        const reference = described[order[0]];
        const timeName = timeDimOf(reference).name;
        const signature = member => member.variables.filter(entry => entry.mapable).map(entry => entry.descriptor.path).sort().join('|');
        for (const index of order) {
            const member = described[index];
            if (timeDimOf(member).name !== timeName || signature(member) !== signature(reference)) {
                throw Object.assign(new Error('The files do not hold the same variables, so they cannot be joined in time.'), { code: 'GRIDDED_INCOMPATIBLE' });
            }
            for (const dim of member.dims.values()) {
                if (dim.role === 't') continue;
                const refDim = reference.dims.get(dim.name);
                if (refDim && refDim.size !== dim.size) {
                    throw Object.assign(new Error(`The files do not share the grid ("${dim.name}": ${refDim.size} vs ${dim.size}).`), { code: 'GRIDDED_INCOMPATIBLE' });
                }
            }
        }
        for (const dim of reference.dims.values()) {
            if (dim.role !== 't') this.axes.set(dim.name, this._decodeAxis(dim));
        }
        const parts = order.map(index => firstTimes[index]);
        const time = { ...parts[0] };
        time.size = parts.reduce((total, part) => total + part.size, 0);
        time.values = new Float64Array(time.size);
        time.labels = [];
        let offset = 0;
        for (const part of parts) {
            time.values.set(part.values, offset);
            time.labels.push(...part.labels);
            offset += part.size;
        }
        this.axes.set(timeName, time);
        for (const entry of reference.variables) {
            const path = entry.descriptor.path;
            let tStart = 0;
            const segments = order.map((memberIndex, position) => {
                const memberEntry = described[memberIndex].variables.find(item => item.descriptor.path === path);
                const segment = {
                    member: memberIndex,
                    descriptor: memberEntry?.descriptor || entry.descriptor,
                    tStart,
                    tCount: entry.roles.includes('t') ? parts[position].size : null,
                };
                if (entry.roles.includes('t')) tStart += parts[position].size;
                return segment;
            });
            // Time-invariant variables (a land-sea mask) are the same in every
            // file; the first copy is the variable.
            this._registerVariable(entry, entry.roles.includes('t') ? segments : segments.slice(0, 1));
        }
    }

    /** What the main thread needs to build the panel: plain, cloneable data. */
    model() {
        const axes = {};
        for (const [name, axis] of this.axes) {
            axes[name] = {
                name, role: axis.role, size: axis.size, units: axis.units, longName: axis.longName,
                positive: axis.positive, kind: axis.kind, calendar: axis.calendar, unitsLabel: axis.unitsLabel,
                values: Float64Array.from(axis.values), labels: axis.labels,
            };
        }
        const variables = [...this.variables.values()].map(variable => ({
            key: variable.key,
            name: variable.name,
            path: variable.path,
            longName: variable.longName,
            standardName: variable.standardName,
            units: variable.units,
            dimNames: variable.dimNames,
            roles: variable.roles,
            shape: variable.dimNames.map(name => this.axes.get(name)?.size ?? 0),
            mapable: variable.mapable,
            timeDim: variable.timeDim,
            // Time steps per compressed chunk, so a parallel read can split
            // the time axis on chunk boundaries (no chunk read twice).
            timeChunk: variable.timeDim ? Number(variable.segments[0].descriptor.chunks?.[variable.roles.indexOf('t')]) || 1 : 1,
        }));
        return {
            title: this.title,
            gridded: this.gridded,
            members: this.members.map(member => ({ filename: member.filename, storageFormat: member.storageFormat })),
            globalAttrs: this.members[0]?.globalAttrs || {},
            axes,
            variables,
            primaryTimeDim: this.primaryTimeDim || null,
        };
    }

    _variable(key) {
        const variable = this.variables.get(key);
        if (!variable) throw new Error(`Unknown variable ${key}`);
        return variable;
    }

    _grid(variable) {
        const yDim = variable.dimNames[variable.roles.indexOf('y')];
        const xDim = variable.dimNames[variable.roles.indexOf('x')];
        const cacheKey = `${yDim}|${xDim}`;
        if (this.grids.has(cacheKey)) return this.grids.get(cacheKey);
        const lat = this.axes.get(yDim).values;
        const lon = this.axes.get(xDim).values;
        const latFlip = lat.length > 1 && lat[0] > lat[lat.length - 1];
        const yOrder = Array.from(lat, (_, index) => (latFlip ? lat.length - 1 - index : index));
        const { order: xOrder, values: lonDisplay } = lonDisplayOrder(lon);
        const grid = {
            yDim, xDim, lat, lon, yOrder, xOrder,
            latDisplay: Float64Array.from(yOrder, index => lat[index]),
            lonDisplay,
            weights: this._latitudeWeights(yDim, lat),
        };
        this.grids.set(cacheKey, grid);
        return grid;
    }

    // Cell areas on the sphere when the file declares latitude bounds; the
    // cosine of the latitude otherwise, which is the same thing for a regular
    // grid up to a constant.
    _latitudeWeights(yDim, lat) {
        const axis = this.axes.get(yDim);
        const member = this.members[0];
        const coordinate = member.descriptors.find(item => item.path === axis.coordinatePath);
        const boundsName = coordinate ? attrValue(coordinate.userAttrs, ['bounds']) : null;
        const boundsDescriptor = boundsName ? member.descriptors.find(item => item.name === String(boundsName).replace(/^\//, '')) : null;
        if (boundsDescriptor && boundsDescriptor.shape.length === 2 && boundsDescriptor.shape[0] === lat.length && boundsDescriptor.shape[1] === 2) {
            const bounds = flatNumbers(boundsDescriptor.read());
            return {
                kind: 'cell-area',
                values: Float64Array.from(lat, (_, index) => {
                    const a = Number(bounds[2 * index]) * Math.PI / 180;
                    const b = Number(bounds[2 * index + 1]) * Math.PI / 180;
                    return Math.abs(Math.sin(b) - Math.sin(a));
                }),
            };
        }
        return { kind: 'cos-lat', values: Float64Array.from(lat, value => Math.max(0, Math.cos(value * Math.PI / 180))) };
    }

    _segmentFor(variable, timeIndex) {
        if (!variable.timeDim) return { segment: variable.segments[0], local: 0 };
        for (const segment of variable.segments) {
            const count = segment.tCount ?? segment.descriptor.shape[variable.roles.indexOf('t')];
            if (timeIndex >= segment.tStart && timeIndex < segment.tStart + count) return { segment, local: timeIndex - segment.tStart };
        }
        throw new RangeError('Time index out of range.');
    }

    _ranges(variable, selection, overrides) {
        return variable.dimNames.map((name, axis) => {
            if (overrides[axis]) return overrides[axis];
            const role = variable.roles[axis];
            if (role === 'y' || role === 'x') return [0, variable.segments[0].descriptor.shape[axis]];
            const index = Math.max(0, Math.min((this.axes.get(name)?.size ?? 1) - 1, Number(selection?.[name]) || 0));
            return [index, index + 1];
        });
    }

    /**
     * One map at the selected time, level and other indices, in display order:
     * latitude ascending, longitude in -180..180 when the grid is global.
     */
    readMap(key, selection = {}) {
        const variable = this._variable(key);
        if (!variable.mapable) throw new Error(`${variable.name} is not a map.`);
        const grid = this._grid(variable);
        const tAxis = variable.roles.indexOf('t');
        const yAxis = variable.roles.indexOf('y');
        const xAxis = variable.roles.indexOf('x');
        const overrides = {};
        let segment = variable.segments[0];
        if (tAxis >= 0) {
            const found = this._segmentFor(variable, Number(selection[variable.timeDim]) || 0);
            segment = found.segment;
            overrides[tAxis] = [found.local, found.local + 1];
        }
        const ranges = this._ranges(variable, selection, overrides);
        const raw = flatNumbers(segment.descriptor.read(ranges));
        const decoded = decodeNumeric(raw, segment.descriptor.userAttrs);
        const ny = grid.lat.length;
        const nx = grid.lon.length;
        // Strides of the y and x axes inside the slab just read (every other axis has length 1).
        const counts = ranges.map(([start, stop]) => stop - start);
        let yStride = 1;
        let xStride = 1;
        for (let axis = counts.length - 1, stride = 1; axis >= 0; axis--) {
            if (axis === yAxis) yStride = stride;
            if (axis === xAxis) xStride = stride;
            stride *= counts[axis];
        }
        const values = new Float32Array(ny * nx);
        let min = Infinity;
        let max = -Infinity;
        let valid = 0;
        for (let row = 0; row < ny; row++) {
            const fileRow = grid.yOrder[row] * yStride;
            for (let column = 0; column < nx; column++) {
                const value = decoded[fileRow + grid.xOrder[column] * xStride];
                values[row * nx + column] = value;
                if (Number.isFinite(value)) {
                    valid += 1;
                    if (value < min) min = value;
                    if (value > max) max = value;
                }
            }
        }
        return {
            values, ny, nx,
            lat: grid.latDisplay, lon: grid.lonDisplay,
            min: valid ? min : NaN, max: valid ? max : NaN, validCount: valid,
        };
    }

    _nearest(grid, lat, lon) {
        let row = 0;
        let best = Infinity;
        grid.lat.forEach((value, index) => {
            const distance = Math.abs(value - lat);
            if (distance < best) { best = distance; row = index; }
        });
        let column = 0;
        best = Infinity;
        grid.lon.forEach((value, index) => {
            const distance = circularDistance(value, lon);
            if (distance < best) { best = distance; column = index; }
        });
        return { row, column };
    }

    _timeBlocks(variable, valuesPerStep, chunkSteps, timeRange = null) {
        const total = this.axes.get(variable.timeDim)?.size || 1;
        // A slice of the time axis (one worker's share of a parallel read):
        // only the blocks inside it, cut to its ends.
        const [first, stop] = timeRange ? [Math.max(0, timeRange[0]), Math.min(total, timeRange[1])] : [0, total];
        let block = Math.max(1, Math.floor(BLOCK_VALUE_TARGET / Math.max(1, valuesPerStep)));
        block = Math.min(block, Math.max(1, Math.ceil(total / MIN_PROGRESS_BLOCKS)));
        if (chunkSteps > 1 && block > chunkSteps) block = Math.floor(block / chunkSteps) * chunkSteps;
        const blocks = [];
        for (const segment of variable.segments) {
            const count = segment.tCount ?? segment.descriptor.shape[variable.roles.indexOf('t')];
            const from = Math.max(0, first - segment.tStart);
            const to = Math.min(count, stop - segment.tStart);
            for (let start = from; start < to; start += block) {
                blocks.push({ segment, localStart: start, localStop: Math.min(to, start + block), globalStart: segment.tStart + start });
            }
        }
        return { total, blocks, first, length: Math.max(0, stop - first) };
    }

    /**
     * The range of a variable's values over its whole time axis, at the
     * selected level, for a colour scale that means the same at every step.
     *
     * `scope: 'sample'` reads `sampleCount` time steps spread evenly over the
     * period (first and last included): a second or two on a global ERA5
     * month. `scope: 'all'` reads every step, in blocks, with progress.
     * Percentiles 1 and 99 come from a bounded subsample of every step read.
     */
    async valueRange(key, selection = {}, { scope = 'sample', sampleCount = 24 } = {}, job = {}) {
        const variable = this._variable(key);
        const tAxis = variable.roles.indexOf('t');
        const yAxis = variable.roles.indexOf('y');
        const xAxis = variable.roles.indexOf('x');
        const total = tAxis >= 0 ? this.axes.get(variable.timeDim)?.size || 1 : 1;
        let steps;
        if (tAxis < 0) steps = [0];
        else if (scope === 'all' || total <= sampleCount) steps = Array.from({ length: total }, (_, index) => index);
        else {
            // When the file's compressed chunks hold several time steps, reading
            // one step decompresses its whole chunk: the sample then takes every
            // step of a few chunks spread over the period, which costs the same
            // and sees more of the data.
            const chunkSteps = Math.max(1, Number(variable.segments[0].descriptor.chunks?.[tAxis]) || 1);
            const blocks = Math.max(2, Math.min(sampleCount, Math.ceil(total / chunkSteps)));
            const starts = [...new Set(Array.from({ length: blocks }, (_, index) => {
                const chunk = Math.round((index * (Math.ceil(total / chunkSteps) - 1)) / (blocks - 1));
                return chunk * chunkSteps;
            }))];
            const picked = new Set();
            for (const start of starts) {
                for (let step = start; step < Math.min(total, start + Math.min(chunkSteps, Math.ceil(sampleCount * 4 / blocks))); step++) picked.add(step);
            }
            picked.add(total - 1);
            steps = [...picked].sort((a, b) => a - b);
        }
        // Consecutive steps are read together, in blocks the size the
        // column and region reads use; scattered ones one at a time.
        const ny = this.axes.get(variable.dimNames[yAxis]).size;
        const nx = this.axes.get(variable.dimNames[xAxis]).size;
        const perStep = ny * nx;
        const blockSteps = Math.max(1, Math.floor(BLOCK_VALUE_TARGET / perStep));
        const runs = [];
        for (const step of steps) {
            const last = runs.at(-1);
            if (last && step === last[1] && last[1] - last[0] < blockSteps) last[1] = step + 1;
            else runs.push([step, step + 1]);
        }
        const keepPerStep = Math.max(500, Math.floor(200000 / steps.length));
        const kept = [];
        let min = Infinity;
        let max = -Infinity;
        let done = 0;
        for (const [start, stop] of runs) {
            if (job.cancelled) throw new CancelledError();
            for (let globalStart = start; globalStart < stop;) {
                const { segment, local } = this._segmentFor(variable, globalStart);
                const count = segment.tCount ?? segment.descriptor.shape[tAxis] ?? 1;
                const take = tAxis >= 0 ? Math.min(stop - globalStart, count - local) : 1;
                const overrides = tAxis >= 0 ? { [tAxis]: [local, local + take] } : {};
                const ranges = this._ranges(variable, selection, overrides);
                const values = decodeNumeric(flatNumbers(segment.descriptor.read(ranges)), segment.descriptor.userAttrs);
                const stride = Math.max(1, Math.floor(perStep / keepPerStep));
                for (let index = 0; index < values.length; index++) {
                    const value = values[index];
                    if (!Number.isFinite(value)) continue;
                    if (value < min) min = value;
                    if (value > max) max = value;
                    if (index % stride === 0) kept.push(value);
                }
                globalStart += take;
                done += take;
                job.onProgress?.(done / steps.length);
            }
            await tick();
        }
        if (!Number.isFinite(min)) return { min: NaN, max: NaN, p01: NaN, p99: NaN, steps: steps.length, total };
        const sorted = Float64Array.from(kept).sort();
        const quantile = q => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
        return { min, max, p01: quantile(0.01), p99: quantile(0.99), steps: steps.length, total };
    }

    /**
     * The level indices asked for, sorted, and the contiguous range of the
     * level axis that holds them — read in one go: the compressed chunks of
     * a reanalysis usually hold every level, so reading level by level would
     * decompress the same chunks again for each. Null when the variable has
     * no level axis or no levels were asked for.
     */
    _levelPlan(variable, levels) {
        const zAxis = variable.roles.indexOf('z');
        if (zAxis < 0 || !Array.isArray(levels) || !levels.length) return null;
        const size = this.axes.get(variable.dimNames[zAxis])?.size ?? 1;
        const indices = [...new Set(levels.map(Number).filter(index => Number.isInteger(index) && index >= 0 && index < size))].sort((a, b) => a - b);
        if (!indices.length) return null;
        return { zAxis, indices, start: indices[0], stop: indices.at(-1) + 1 };
    }

    /**
     * The four grid cells around (lat, lon) and their bilinear weights, as
     * file row and column indices. Across the seam of a global grid the pair
     * of columns wraps (last, first); outside a regional grid, or beyond the
     * outermost latitude, the value of the edge is kept (weights on one side).
     */
    _bilinearCells(grid, lat, lon) {
        const rows = Array.from(grid.lat, (value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
        let low = 0;
        while (low < rows.length - 2 && rows[low + 1].value <= lat) low += 1;
        const south = rows[low];
        const north = rows[Math.min(low + 1, rows.length - 1)];
        const ty = north.value === south.value ? 0 : Math.max(0, Math.min(1, (lat - south.value) / (north.value - south.value)));
        const lons = grid.lonDisplay;
        const last = lons.length - 1;
        let x = lon;
        if (lons[last] > 180 && x < 0) x += 360;
        if (lons[0] < 0 && x > 180) x -= 360;
        const step = last > 0 ? (lons[last] - lons[0]) / last : 360;
        const global = last > 0 && Math.abs(lons[last] - lons[0] + step - 360) < step / 2;
        let west;
        let east;
        let tx;
        if (x >= lons[0] && x <= lons[last]) {
            west = 0;
            while (west < last - 1 && lons[west + 1] <= x) west += 1;
            east = Math.min(west + 1, last);
            tx = lons[east] === lons[west] ? 0 : (x - lons[west]) / (lons[east] - lons[west]);
        } else if (global) {
            west = last;
            east = 0;
            const span = lons[0] + 360 - lons[last];
            tx = ((x < lons[0] ? x + 360 : x) - lons[last]) / span;
        } else {
            west = x < lons[0] ? 0 : last;
            east = west;
            tx = 0;
        }
        const column = display => grid.xOrder[display];
        return [
            { row: south.index, column: column(west), weight: (1 - ty) * (1 - tx) },
            { row: south.index, column: column(east), weight: (1 - ty) * tx },
            { row: north.index, column: column(west), weight: ty * (1 - tx) },
            { row: north.index, column: column(east), weight: ty * tx },
        ].filter(cell => cell.weight > 0);
    }

    /**
     * The reads that cover a set of file columns: one per run of contiguous
     * columns, except that runs sharing the file's compressed chunks along
     * the longitude axis are read as one span. A chunk is decompressed whole
     * on every read that touches it, so two runs in the same chunk (a box or
     * a bilinear pair across the seam of a 0..360 grid, in an ERA5 file
     * chunked one map per step) would decompress it twice; runs in chunks of
     * their own (small chunks, or contiguous storage) stay apart and read
     * only what they need. Returns [[start, stop, columns]], `columns` being
     * the asked-for columns inside that read.
     */
    _columnReads(variable, columns) {
        const sorted = [...new Set(columns)].sort((a, b) => a - b);
        const runs = [];
        for (const column of sorted) {
            const last = runs.at(-1);
            if (last && column === last[1]) last[1] = column + 1;
            else runs.push([column, column + 1]);
        }
        const xAxis = variable.roles.indexOf('x');
        const chunk = Number(variable.segments[0].descriptor.chunks?.[xAxis]) || 0;
        const reads = [];
        for (const run of runs) {
            const last = reads.at(-1);
            // The chunk index of the previous read's last column and of this
            // run's first: the same chunk means the gap costs no extra decompression.
            if (last && chunk > 0 && Math.floor((last[1] - 1) / chunk) === Math.floor(run[0] / chunk)) last[1] = run[1];
            else reads.push([run[0], run[1]]);
        }
        return reads.map(([start, stop]) => [start, stop, sorted.filter(column => column >= start && column < stop)]);
    }

    /**
     * The series of a few grid cells at each level asked for (or the
     * selected level): `[cell][level]` Float64Arrays over every time step.
     * Every time block is read once, as the window that holds all the cells
     * (the four of a bilinear point read together, not one after the other).
     * `progress(fraction)` reports the share of the work done.
     */
    async _cellsSeries(key, variable, grid, selection, cells, plan, job, progress, timeRange = null) {
        const tAxis = variable.roles.indexOf('t');
        const yAxis = variable.roles.indexOf('y');
        const xAxis = variable.roles.indexOf('x');
        const levelList = plan ? plan.indices : [null];
        if (tAxis < 0) {
            const atLevel = index => (index === null ? selection : { ...selection, [variable.dimNames[plan.zAxis]]: index });
            const maps = levelList.map(index => this.readMap(key, atLevel(index)));
            return cells.map(({ row, column }) => {
                const displayRow = grid.yOrder.indexOf(row);
                const displayColumn = grid.xOrder.indexOf(column);
                return maps.map(map => Float64Array.of(map.values[displayRow * map.nx + displayColumn]));
            });
        }
        const rowStart = Math.min(...cells.map(cell => cell.row));
        const rowStop = Math.max(...cells.map(cell => cell.row)) + 1;
        const reads = this._columnReads(variable, cells.map(cell => cell.column));
        const levelCount = plan ? plan.stop - plan.start : 1;
        const width = reads.reduce((sum, [start, stop]) => sum + stop - start, 0);
        const chunkSteps = Number(variable.segments[0].descriptor.chunks?.[tAxis]) || 1;
        const { blocks, first, length } = this._timeBlocks(variable, levelCount * (rowStop - rowStart) * width, chunkSteps, timeRange);
        const outs = cells.map(() => levelList.map(() => new Float64Array(length)));
        for (const [index, block] of blocks.entries()) {
            if (job.cancelled) throw new CancelledError();
            const steps = block.localStop - block.localStart;
            for (const [readStart, readStop] of reads) {
                const overrides = {
                    [tAxis]: [block.localStart, block.localStop],
                    [yAxis]: [rowStart, rowStop],
                    [xAxis]: [readStart, readStop],
                };
                if (plan) overrides[plan.zAxis] = [plan.start, plan.stop];
                const ranges = this._ranges(variable, selection, overrides);
                const counts = ranges.map(([start, stop]) => stop - start);
                const strides = new Array(counts.length).fill(1);
                for (let axis = counts.length - 2; axis >= 0; axis--) strides[axis] = strides[axis + 1] * counts[axis + 1];
                const values = decodeNumeric(flatNumbers(block.segment.descriptor.read(ranges)), block.segment.descriptor.userAttrs);
                cells.forEach(({ row, column }, position) => {
                    if (column < readStart || column >= readStop) return;
                    const cellBase = (row - rowStart) * strides[yAxis] + (column - readStart) * strides[xAxis];
                    levelList.forEach((level, levelPosition) => {
                        const out = outs[position][levelPosition];
                        const base = cellBase + (plan ? (level - plan.start) * strides[plan.zAxis] : 0);
                        for (let step = 0; step < steps; step++) out[block.globalStart - first + step] = values[base + step * strides[tAxis]];
                    });
                });
            }
            progress?.((index + 1) / blocks.length);
            await tick();
        }
        return outs;
    }

    /**
     * The time series at (lat, lon) at the selected level — or, with
     * `levels` (indices of the level axis), at each of them:
     * `byLevel: [{ index, values }]`, read together.
     *
     * `method: 'nearest'` (the default) takes the grid cell nearest the
     * point; `cell` is that cell. `method: 'bilinear'` interpolates between
     * the four cells around it, weighted by distance along latitude and
     * longitude; `cell` is then the point itself and `neighbours` lists the
     * four cells and their weights. A neighbour without data at a time step
     * (a land cell for a sea variable) is left out and the others' weights
     * renormalised; with none, the step is missing.
     */
    async pointSeries(key, selection, lat, lon, job = {}, { levels = null, method = 'nearest', timeRange = null } = {}) {
        const variable = this._variable(key);
        const grid = this._grid(variable);
        const plan = this._levelPlan(variable, levels);
        const displayLon = value => (value > 180 ? value - 360 : value);
        let cells;
        let cell;
        let neighbours;
        if (method === 'bilinear') {
            cells = this._bilinearCells(grid, lat, lon);
            cell = { lat, lon: displayLon(lon) };
            neighbours = cells.map(item => ({ lat: grid.lat[item.row], lon: displayLon(grid.lon[item.column]), weight: item.weight }));
        } else {
            const { row, column } = this._nearest(grid, lat, lon);
            cells = [{ row, column, weight: 1 }];
            cell = { lat: grid.lat[row], lon: displayLon(grid.lon[column]) };
        }
        const series = await this._cellsSeries(key, variable, grid, selection, cells, plan, job, fraction => job.onProgress?.(fraction), timeRange);
        const levelCount = plan ? plan.indices.length : 1;
        const combined = Array.from({ length: levelCount }, (_, level) => {
            if (cells.length === 1) return series[0][level];
            const length = series[0][level].length;
            const out = new Float64Array(length);
            for (let step = 0; step < length; step++) {
                let sum = 0;
                let weights = 0;
                cells.forEach((item, position) => {
                    const value = series[position][level][step];
                    if (!Number.isFinite(value)) return;
                    sum += value * item.weight;
                    weights += item.weight;
                });
                out[step] = weights > 0 ? sum / weights : NaN;
            }
            return out;
        });
        const extra = neighbours ? { method: 'bilinear', neighbours } : { method: 'nearest' };
        if (!plan) return { values: combined[0], cell, ...extra };
        return { byLevel: plan.indices.map((level, position) => ({ index: level, values: combined[position] })), cell, ...extra };
    }

    /**
     * Area-weighted statistics over a lat/lon box for every time step.
     * The box is in display coordinates (longitude -180..180 for global
     * grids); a box crossing the antimeridian has lonMin > lonMax.
     */
    async regionStats(key, selection, box, job = {}, { levels = null, timeRange = null } = {}) {
        const variable = this._variable(key);
        const grid = this._grid(variable);
        const latMin = Math.min(box.latMin, box.latMax);
        const latMax = Math.max(box.latMin, box.latMax);
        const rows = [];
        grid.lat.forEach((value, index) => { if (value >= latMin && value <= latMax) rows.push(index); });
        const inLon = value => {
            const wrapped = value > 180 ? value - 360 : value;
            if (box.lonMin <= box.lonMax) return (wrapped >= box.lonMin && wrapped <= box.lonMax) || (value >= box.lonMin && value <= box.lonMax);
            return wrapped >= box.lonMin || wrapped <= box.lonMax;
        };
        const columns = [];
        grid.lon.forEach((value, index) => { if (inLon(value)) columns.push(index); });
        if (!rows.length || !columns.length) {
            throw Object.assign(new Error('The box does not contain any grid cell.'), { code: 'GRIDDED_EMPTY_REGION' });
        }
        // Contiguous runs of file columns, joined where they share chunks
        // (a box across the seam of a 0..360 grid): see _columnReads.
        const reads = this._columnReads(variable, columns);
        const rowStart = rows[0];
        const rowStop = rows.at(-1) + 1;
        const plan = this._levelPlan(variable, levels);
        const levelCount = plan ? plan.stop - plan.start : 1;
        const tAxis = variable.roles.indexOf('t');
        const yAxis = variable.roles.indexOf('y');
        const xAxis = variable.roles.indexOf('x');
        const weights = grid.weights.values;
        const totalCells = rows.length * columns.length;
        const valuesPerStep = (rowStop - rowStart) * reads.reduce((sum, [start, stop]) => sum + stop - start, 0) * levelCount;
        const chunkSteps = tAxis >= 0 ? Number(variable.segments[0].descriptor.chunks?.[tAxis]) || 1 : 1;
        const { blocks, first, length: total } = tAxis >= 0
            ? this._timeBlocks(variable, valuesPerStep, chunkSteps, timeRange)
            : { first: 0, length: 1, blocks: [{ segment: variable.segments[0], localStart: 0, localStop: 1, globalStart: 0 }] };
        const stats = () => ({
            mean: new Float64Array(total).fill(NaN),
            min: new Float64Array(total).fill(NaN),
            max: new Float64Array(total).fill(NaN),
            validFraction: new Float64Array(total),
            minLat: new Float64Array(total).fill(NaN),
            minLon: new Float64Array(total).fill(NaN),
            maxLat: new Float64Array(total).fill(NaN),
            maxLon: new Float64Array(total).fill(NaN),
            sum: new Float64Array(total),
            weightSum: new Float64Array(total),
            valid: new Float64Array(total),
        });
        const levelList = plan ? plan.indices : [null];
        const perLevel = levelList.map(() => stats());
        const displayLon = value => (value > 180 ? value - 360 : value);
        for (const [blockIndex, block] of blocks.entries()) {
            if (job.cancelled) throw new CancelledError();
            const steps = block.localStop - block.localStart;
            for (const [readStart, readStop, readColumns] of reads) {
                const overrides = { [yAxis]: [rowStart, rowStop], [xAxis]: [readStart, readStop] };
                if (tAxis >= 0) overrides[tAxis] = [block.localStart, block.localStop];
                if (plan) overrides[plan.zAxis] = [plan.start, plan.stop];
                const ranges = this._ranges(variable, selection, overrides);
                const counts = ranges.map(([start, stop]) => stop - start);
                const strides = new Array(counts.length).fill(1);
                for (let axis = counts.length - 2; axis >= 0; axis--) strides[axis] = strides[axis + 1] * counts[axis + 1];
                const decoded = decodeNumeric(flatNumbers(block.segment.descriptor.read(ranges)), block.segment.descriptor.userAttrs);
                levelList.forEach((level, position) => {
                    const result = perLevel[position];
                    const levelBase = plan ? (level - plan.start) * strides[plan.zAxis] : 0;
                    for (let step = 0; step < steps; step++) {
                        const t = block.globalStart - first + step;
                        const base = levelBase + (tAxis >= 0 ? step * strides[tAxis] : 0);
                        for (const row of rows) {
                            const w = weights[row];
                            const rowBase = base + (row - rowStart) * strides[yAxis];
                            for (const column of readColumns) {
                                const value = decoded[rowBase + (column - readStart) * strides[xAxis]];
                                if (!Number.isFinite(value)) continue;
                                result.valid[t] += 1;
                                result.sum[t] += value * w;
                                result.weightSum[t] += w;
                                if (!(value >= result.min[t])) {
                                    result.min[t] = value;
                                    result.minLat[t] = grid.lat[row];
                                    result.minLon[t] = displayLon(grid.lon[column]);
                                }
                                if (!(value <= result.max[t])) {
                                    result.max[t] = value;
                                    result.maxLat[t] = grid.lat[row];
                                    result.maxLon[t] = displayLon(grid.lon[column]);
                                }
                            }
                        }
                    }
                });
            }
            job.onProgress?.((blockIndex + 1) / blocks.length);
            await tick();
        }
        const finish = result => {
            for (let t = 0; t < total; t++) {
                if (result.weightSum[t] > 0) result.mean[t] = result.sum[t] / result.weightSum[t];
                result.validFraction[t] = result.valid[t] / totalCells;
            }
            delete result.sum;
            delete result.weightSum;
            delete result.valid;
            return result;
        };
        const common = {
            cells: totalCells,
            weighting: grid.weights.kind,
            box: { latMin, latMax, lonMin: box.lonMin, lonMax: box.lonMax },
        };
        if (!plan) return { ...finish(perLevel[0]), ...common };
        return { ...common, byLevel: plan.indices.map((level, position) => ({ index: level, ...finish(perLevel[position]) })) };
    }
}
