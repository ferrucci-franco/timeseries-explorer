import h5wasm from 'h5wasm';
import { NetCDFReader } from 'netcdfjs';
import MatParser from './mat-parser.js';
import PypsaNetcdfParser from './pypsa-netcdf-parser.js';
import { PYPSA_NETCDF_DEFAULT_EAGER_LIMIT_BYTES } from './pypsa-netcdf-limits.js';

const HDF5_MAGIC = '89 48 44 46 0D 0A 1A 0A';
const NETCDF3_MAGICS = new Map([
    ['43 44 46 01', 'netcdf3-classic'],
    ['43 44 46 02', 'netcdf3-64-bit-offset'],
]);
const CDF5_MAGIC = '43 44 46 05';
const UNSUPPORTED_NODE = 'Unsupported variables';
const METADATA_NODE = 'File metadata';
const COORDINATES_NODE = 'Coordinates';
const MAX_GENERATED_SERIES = 10000;
const TECHNICAL_ATTRIBUTES = new Set([
    'CLASS', 'NAME', 'REFERENCE_LIST', 'DIMENSION_LIST',
    '_Netcdf4Coordinates', '_Netcdf4Dimid', '_NCProperties',
]);
const DESCRIPTION_KEYS = ['long_name', 'description', 'standard_name', 'title'];
const UNIT_KEYS = ['units', 'unit', 'display_unit', 'displayUnit'];
const TIME_LIKE_NAME = /^(time|times|date|datetime|timestamp|timestamps|time_?offset|time_?obs|observation_?time|time_?nominal|time_?valid)$/i;
const TIME_UNIT_SCALES_MS = {
    day: 86400000, days: 86400000,
    hour: 3600000, hours: 3600000, hr: 3600000, hrs: 3600000,
    minute: 60000, minutes: 60000, min: 60000, mins: 60000,
    second: 1000, seconds: 1000, sec: 1000, secs: 1000, s: 1000,
    millisecond: 1, milliseconds: 1, msec: 1, msecs: 1, ms: 1,
    microsecond: 0.001, microseconds: 0.001, usec: 0.001, usecs: 0.001, us: 0.001, 'µs': 0.001,
    nanosecond: 0.000001, nanoseconds: 0.000001, nsec: 0.000001, nsecs: 0.000001, ns: 0.000001,
};

function magic(buffer, length) {
    return [...new Uint8Array(buffer, 0, Math.min(length, buffer.byteLength))]
        .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');
}

function toArray(value) {
    if (value == null) return [];
    if (Array.isArray(value)) return value;
    if (ArrayBuffer.isView(value)) return Array.from(value);
    return [value];
}

function flatten(value, target = []) {
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        for (const item of value) flatten(item, target);
    } else {
        target.push(value);
    }
    return target;
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

function scalar(value) {
    if (typeof value === 'bigint') {
        const converted = Number(value);
        return Number.isSafeInteger(converted) ? converted : String(value);
    }
    return value;
}

function normalizedAttributeValue(value) {
    if (value == null) return value;
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        const values = flatten(value).map(scalar);
        if (!values.length) return undefined;
        return values.length === 1 ? values[0] : values;
    }
    if (typeof value === 'object') return undefined;
    return scalar(value);
}

function attrsFromHdf5(entity, { includeTechnical = false } = {}) {
    const attrs = {};
    for (const [name, attribute] of Object.entries(entity?.attrs || {})) {
        if (!includeTechnical && TECHNICAL_ATTRIBUTES.has(name)) continue;
        const value = normalizedAttributeValue(attribute?.value);
        if (value !== undefined && value !== null && value !== '') attrs[name] = value;
    }
    return attrs;
}

function attrsFromNetcdf3(attributes = []) {
    return Object.fromEntries(attributes
        .map(attribute => [attribute.name, normalizedAttributeValue(attribute.value)])
        .filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function attrValue(attrs, names) {
    const entries = Object.entries(attrs || {});
    for (const wanted of names) {
        const found = entries.find(([name]) => name.toLowerCase() === wanted.toLowerCase());
        if (found) return found[1];
    }
    return undefined;
}

function attrText(attrs, names) {
    const value = attrValue(attrs, names);
    if (Array.isArray(value)) return value.map(item => String(item)).join(', ');
    return value == null ? '' : String(value);
}

function parseDate(value) {
    const text = String(value ?? '').replace(/\0/g, '').trim().replace(/^(\d{4}-\d{2}-\d{2})_(\d{2}:\d{2}:\d{2})/, '$1T$2');
    if (!text || /^[+-]?\d+(?:\.\d+)?$/.test(text)) return NaN;
    const match = text.match(/^(\d{1,4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d+))?)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?)?$/);
    if (!match) {
        const parsed = Date.parse(text);
        return Number.isFinite(parsed) ? parsed : NaN;
    }
    const [, year, month, day, hour = '0', minute = '0', second = '0', fraction = '', zone = 'Z'] = match;
    const milliseconds = fraction ? Math.round(Number(`0.${fraction}`) * 1000) : 0;
    const normalizedZone = zone === 'Z' || zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
    const date = [year.padStart(4, '0'), month.padStart(2, '0'), day.padStart(2, '0')].join('-');
    const time = [hour.padStart(2, '0'), minute.padStart(2, '0'), second.padStart(2, '0')].join(':');
    return Date.parse(`${date}T${time}.${String(milliseconds).padStart(3, '0')}${normalizedZone}`);
}

function cfTimeUnits(units) {
    const match = String(units || '').trim().match(/^([A-Za-zµ]+)\s+since\s+(.+)$/i);
    if (!match) return null;
    const unit = match[1].toLowerCase();
    const scaleMs = TIME_UNIT_SCALES_MS[unit];
    const originMs = parseDate(match[2]);
    return Number.isFinite(scaleMs) && Number.isFinite(originMs)
        ? { scaleMs, originMs, originText: match[2] }
        : null;
}

function plainTimeUnitScaleMs(units) {
    const unit = String(units || '').trim().toLowerCase().match(/^([a-zµ]+)/)?.[1];
    return TIME_UNIT_SCALES_MS[unit] || null;
}

function isNumericValue(value) {
    return typeof value === 'number' || typeof value === 'bigint';
}

function numericArray(value) {
    return Float64Array.from(flatten(value), item => Number(item));
}

function decodeNumeric(values, attrs) {
    const fillValues = [attrValue(attrs, ['_FillValue']), attrValue(attrs, ['missing_value'])]
        .flatMap(value => Array.isArray(value) ? value : [value])
        .filter(value => value !== undefined && value !== null)
        .map(Number);
    const scale = Number(attrValue(attrs, ['scale_factor']) ?? 1);
    const offset = Number(attrValue(attrs, ['add_offset']) ?? 0);
    return Float64Array.from(values, raw => {
        const value = Number(raw);
        if (fillValues.some(fill => (Number.isNaN(fill) && Number.isNaN(value)) || value === fill)) return NaN;
        return value * (Number.isFinite(scale) ? scale : 1) + (Number.isFinite(offset) ? offset : 0);
    });
}

function rowMajorOffset(indexes, shape) {
    let offset = 0;
    for (let axis = 0; axis < shape.length; axis++) offset = offset * shape[axis] + indexes[axis];
    return offset;
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

        const magic8 = magic(buffer, 8);
        const magic4 = magic(buffer, 4);
        if (magic8 === HDF5_MAGIC) return this._parseHdf5(buffer, filename);
        if (NETCDF3_MAGICS.has(magic4)) return this._parseNetcdf3(buffer, filename, NETCDF3_MAGICS.get(magic4));
        if (magic4 === CDF5_MAGIC) throw new Error('netCDF CDF-5 files are not supported by the browser reader. Convert the file to netCDF4/HDF5 or netCDF3 Classic.');
        throw new Error('The selected file is not a recognized netCDF3 or netCDF4/HDF5 file.');
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

    _parseNetcdf3(buffer, filename, format) {
        let reader;
        try {
            reader = new NetCDFReader(new Uint8Array(buffer));
        } catch (error) {
            throw new Error(`Could not parse netCDF3 file: ${error?.message || error}`);
        }
        const descriptors = reader.variables.map(variable => ({
            path: `/${variable.name}`,
            name: variable.name,
            group: '/',
            shape: variable.dimensions.map(id => {
                const dimension = reader.dimensions[id];
                return Number(dimension?.size || (dimension?.name === reader.recordDimension.name ? reader.recordDimension.length : 0));
            }),
            dimensions: variable.dimensions.map(id => `/${reader.dimensions[id]?.name || `dimension_${id}`}`),
            attrs: attrsFromNetcdf3(variable.attributes),
            userAttrs: attrsFromNetcdf3(variable.attributes),
            read: () => reader.getDataVariable(variable),
            supportsSlice: false,
        }));
        return this._parseGeneric(descriptors, attrsFromNetcdf3(reader.globalAttributes), filename, format);
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

        for (const descriptor of descriptors) {
            if (descriptor.path === coordinate?.path || coordinatePaths.has(descriptor.path)) continue;
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
            if (seriesCount < 1 || result.metadata.generatedSeriesCount + seriesCount > MAX_GENERATED_SERIES) {
                this._skip(result, descriptor, `Expanding this variable would exceed the ${MAX_GENERATED_SERIES.toLocaleString()}-series safety limit.`);
                continue;
            }
            const labelsByAxis = new Map(otherAxes.map(item => [item.index, this._dimensionLabels(
                descriptor.dimensions[item.index], descriptor.shape[item.index], descriptors, readFlat
            )]));
            const indexes = combinations(otherAxes.map(item => item.size));
            for (const combination of indexes) {
                const fixed = new Map(otherAxes.map((item, index) => [item.index, combination[index]]));
                const rawValues = this._readSeries(descriptor, alignment.axis, fixed, readFlat);
                const values = decodeNumeric(rawValues, descriptor.userAttrs);
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
        this._addSkippedTree(result.tree, result.metadata.skippedVariables);
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
        if (descriptor.shape.length === 2 && descriptor.shape[0] > 1) {
            const values = this._coordinateValues(descriptor, readFlat);
            if (values.length === descriptor.shape[0] && values.every(value => typeof value === 'string')) {
                return { dimension: descriptor.dimensions[0] || descriptor.path, length: descriptor.shape[0] };
            }
        }
        return null;
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
        if (cf && !['360_day', '365_day', '366_day', 'noleap', 'all_leap'].includes(calendar)) {
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
        return coordinate ? readFlat(coordinate) : Array.from({ length: size }, (_, index) => index);
    }

    _readSeries(descriptor, timeAxis, fixed, readFlat) {
        if (descriptor.shape.length === 1) return readFlat(descriptor);
        const ranges = descriptor.shape.map((_, axis) => axis === timeAxis ? [] : [fixed.get(axis), fixed.get(axis) + 1]);
        if (descriptor.supportsSlice) try {
            return flatten(descriptor.read(ranges));
        } catch {
            // Fall back to the row-major full array below.
        }
        const all = readFlat(descriptor);
        const values = [];
        for (let time = 0; time < descriptor.shape[timeAxis]; time++) {
            const indexes = descriptor.shape.map((_, axis) => axis === timeAxis ? time : fixed.get(axis));
            values.push(all[rowMajorOffset(indexes, descriptor.shape)]);
        }
        return values;
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
        return { _type: 'root', _name: '', _children: {}, _variables: {} };
    }

    _ensureNode(root, parts) {
        let node = root;
        let fullName = '';
        for (const part of parts) {
            fullName = fullName ? `${fullName}.${part}` : part;
            if (!node._children[part]) {
                node._children[part] = { _type: 'component', _name: part, _fullName: fullName, _children: {}, _variables: {} };
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
