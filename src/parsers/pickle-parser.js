import * as pickleparser from 'pickleparser';
import MatParser from './mat-parser.js';
import {
    PICKLE_DEFAULT_EAGER_LIMIT_BYTES,
    PICKLE_DEFAULT_INTERNAL_LIMITS,
} from './pickle-limits.js';

const { Parser } = pickleparser;

const UNSUPPORTED_COLUMNS_NODE = 'Unsupported columns';
const NAT_INT64 = -9223372036854775808n;

function idSegment(value) {
    return encodeURIComponent(String(value ?? ''));
}

function toUint8Array(buffer) {
    if (buffer instanceof Uint8Array) return buffer;
    if (ArrayBuffer.isView(buffer)) {
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    return new Uint8Array(buffer || new ArrayBuffer(0));
}

function pickleError(code, message, detail = {}) {
    const err = new Error(message);
    err.code = code;
    Object.assign(err, detail);
    return err;
}

function compressedPickleFormat(bytes) {
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
    if (bytes.length >= 6 && bytes[0] === 0xfd && bytes[1] === 0x37 && bytes[2] === 0x7a && bytes[3] === 0x58 && bytes[4] === 0x5a) return 'xz';
    if (bytes.length >= 3 && bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) return 'bzip2';
    if (bytes.length >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) return 'zstd';
    return '';
}

function mapGet(value, key, fallback = undefined) {
    if (value instanceof Map) return value.has(key) ? value.get(key) : fallback;
    if (value && Object.prototype.hasOwnProperty.call(value, key)) return value[key];
    return fallback;
}

function mapEntries(value) {
    if (value instanceof Map) return Array.from(value.entries());
    if (value && typeof value === 'object') return Object.entries(value);
    return [];
}

function asArray(value) {
    if (value == null) return [];
    if (Array.isArray(value)) return value;
    if (ArrayBuffer.isView(value)) return Array.from(value);
    if (value instanceof Map) return Array.from(value.values());
    return [value];
}

function asString(value) {
    if (value instanceof PandasTimestamp) return value.toString();
    if (Array.isArray(value)) return value.map(asString).join('.');
    if (value === null || value === undefined) return '';
    return String(value);
}

function product(shape) {
    return shape.reduce((acc, value) => acc * Math.max(0, Number(value) || 0), 1);
}

function bytesToAscii(bytes) {
    if (typeof bytes === 'string') return bytes;
    if (!ArrayBuffer.isView(bytes)) return String(bytes ?? '');
    return Array.from(bytes, byte => String.fromCharCode(byte)).join('');
}

function decodeUtf16CodeUnits(values) {
    return values.map(value => String.fromCharCode(Number(value) || 0)).join('').replace(/\0+$/g, '');
}

function normalizeScalar(value) {
    if (value instanceof PandasTimestamp) return value.valueMs;
    if (value instanceof PickleNumpyScalar) return normalizeScalar(value.value);
    if (typeof value === 'bigint') return Number(value);
    return value;
}

function isNumericScalar(value) {
    const normalized = normalizeScalar(value);
    return typeof normalized === 'number' && Number.isFinite(normalized);
}

function isStringLike(value) {
    return typeof value === 'string' || value instanceof String;
}

function sameAxisValues(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        const av = Number(a[i]);
        const bv = Number(b[i]);
        if (Number.isNaN(av) && Number.isNaN(bv)) continue;
        if (av !== bv) return false;
    }
    return true;
}

class PickleContext {
    constructor(limits = {}) {
        this.limits = { ...PICKLE_DEFAULT_INTERNAL_LIMITS, ...limits };
        this.constructedObjects = 0;
        this.arrayBytes = 0;
        this.precisionWarnings = [];
    }

    countObject(label = 'object') {
        this.constructedObjects += 1;
        if (this.constructedObjects > this.limits.maxConstructedObjects) {
            throw pickleError('PICKLE_LIMIT_EXCEEDED', `Pickle object limit exceeded while constructing ${label}.`);
        }
    }

    countArrayBytes(bytes, label = 'ndarray') {
        this.arrayBytes += Math.max(0, Number(bytes) || 0);
        if (this.arrayBytes > this.limits.maxArrayBytes) {
            throw pickleError('PICKLE_LIMIT_EXCEEDED', `Pickle array data exceeds the configured limit while reading ${label}.`);
        }
    }

    warnPrecision(label, value) {
        this.precisionWarnings.push({ name: String(label || 'value'), value: String(value) });
    }
}

class PickleDType {
    constructor(spec = 'f8') {
        this.spec = spec instanceof PickleDType ? spec.spec : String(spec ?? 'O');
        this.byteOrder = '=';
        this.kind = 'object';
        this.itemSize = 0;
        this.unit = '';
        this.names = null;
        this.fields = null;
        this._parseSpec(this.spec);
    }

    __setstate__(state) {
        const values = asArray(state);
        if (typeof values[1] === 'string' && values[1]) this.byteOrder = values[1];
        if (Array.isArray(values[3])) this.names = values[3];
        if (values[4]) this.fields = values[4];
        if (Number.isFinite(Number(values[5])) && Number(values[5]) > 0) this.itemSize = Number(values[5]);
    }

    _parseSpec(spec) {
        const text = String(spec || 'O');
        const match = text.match(/^([<>=|])?([A-Za-z?])(\d+)?(?:\[(.+)\])?$/);
        if (!match) {
            this.kind = 'object';
            return;
        }
        this.byteOrder = match[1] || '=';
        const code = match[2];
        const size = match[3] ? Number(match[3]) : 0;
        this.unit = match[4] || '';
        if (code === '?' || code === 'b' && size === 1) {
            this.kind = 'bool';
            this.itemSize = 1;
        } else if (code === 'f' || code === 'd') {
            this.kind = 'float';
            this.itemSize = size || (code === 'd' ? 8 : 4);
        } else if (code === 'i' || code === 'l') {
            this.kind = 'int';
            this.itemSize = size || 8;
        } else if (code === 'u') {
            this.kind = 'uint';
            this.itemSize = size || 8;
        } else if (code === 'M') {
            this.kind = 'datetime';
            this.itemSize = size || 8;
        } else if (code === 'm') {
            this.kind = 'timedelta';
            this.itemSize = size || 8;
        } else if (code === 'O') {
            this.kind = 'object';
            this.itemSize = 0;
        } else if (code === 'U') {
            this.kind = 'unicode';
            this.itemSize = (size || 0) * 4;
        } else if (code === 'S' || code === 'a') {
            this.kind = 'bytes';
            this.itemSize = size || 1;
        } else {
            this.kind = 'object';
            this.itemSize = size || 0;
        }
    }

    toString() {
        return this.spec;
    }
}

class PickleNumpyScalar {
    constructor(value) {
        this.value = value;
    }
}

class PickleNumpyArray {
    constructor(context, subtype = null, shape = [], dtype = new PickleDType('f8')) {
        this.context = context;
        this.context?.countObject('numpy.ndarray');
        this.subtype = subtype;
        this.shape = Array.isArray(shape) ? shape.map(Number) : [];
        this.dtype = dtype instanceof PickleDType ? dtype : new PickleDType(dtype);
        this.fortranOrder = false;
        this.data = [];
        this.precisionLoss = false;
        this.unsupported = false;
    }

    __setstate__(state) {
        const values = asArray(state);
        const shape = Array.isArray(values[1]) ? values[1] : this.shape;
        const dtype = values[2] instanceof PickleDType ? values[2] : new PickleDType(values[2]);
        const fortranOrder = Boolean(values[3]);
        const raw = values.length >= 5 ? values[4] : values[0];
        this.shape = shape.map(Number);
        this.dtype = dtype;
        this.fortranOrder = fortranOrder;
        this._validateShape();
        this.data = this._decodeData(raw);
    }

    _validateShape() {
        if (this.shape.length > (this.context?.limits.maxShapeRank || 8)) {
            throw pickleError('PICKLE_LIMIT_EXCEEDED', `Unsupported ndarray rank ${this.shape.length}.`);
        }
        const elements = product(this.shape);
        if (elements > (this.context?.limits.maxArrayElements || Number.MAX_SAFE_INTEGER)) {
            throw pickleError('PICKLE_LIMIT_EXCEEDED', `Unsupported ndarray size ${elements}.`);
        }
    }

    _decodeData(raw) {
        if (raw == null) return [];
        if (Array.isArray(raw)) return raw.map(normalizeScalar);
        if (raw instanceof PickleNumpyArray) return raw.toArray();
        if (!ArrayBuffer.isView(raw)) return asArray(raw).map(normalizeScalar);

        const bytes = toUint8Array(raw);
        this.context?.countArrayBytes(bytes.byteLength, `ndarray ${this.dtype}`);
        const count = this.shape.length ? product(this.shape) : Math.floor(bytes.byteLength / Math.max(1, this.dtype.itemSize || 1));
        const littleEndian = this.dtype.byteOrder !== '>';
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const out = new Array(count);
        const itemSize = Math.max(1, this.dtype.itemSize || 1);

        if (this.dtype.kind === 'float') {
            for (let i = 0; i < count; i++) {
                const offset = i * itemSize;
                out[i] = itemSize === 4 ? view.getFloat32(offset, littleEndian) : view.getFloat64(offset, littleEndian);
            }
            return out;
        }
        if (this.dtype.kind === 'int' || this.dtype.kind === 'uint') {
            for (let i = 0; i < count; i++) {
                const offset = i * itemSize;
                let value;
                if (itemSize === 1) value = this.dtype.kind === 'uint' ? view.getUint8(offset) : view.getInt8(offset);
                else if (itemSize === 2) value = this.dtype.kind === 'uint' ? view.getUint16(offset, littleEndian) : view.getInt16(offset, littleEndian);
                else if (itemSize === 4) value = this.dtype.kind === 'uint' ? view.getUint32(offset, littleEndian) : view.getInt32(offset, littleEndian);
                else {
                    const big = this.dtype.kind === 'uint' ? view.getBigUint64(offset, littleEndian) : view.getBigInt64(offset, littleEndian);
                    value = Number(big);
                    if (!Number.isSafeInteger(value)) {
                        this.precisionLoss = true;
                        this.context?.warnPrecision('int64/uint64 column', big);
                    }
                }
                out[i] = value;
            }
            return out;
        }
        if (this.dtype.kind === 'bool') {
            for (let i = 0; i < count; i++) out[i] = bytes[i] ? 1 : 0;
            return out;
        }
        if (this.dtype.kind === 'datetime' || this.dtype.kind === 'timedelta') {
            const scale = this.dtype.kind === 'datetime'
                ? datetimeUnitToMs(this.dtype.unit || 'ns')
                : timedeltaUnitToSeconds(this.dtype.unit || 'ns');
            for (let i = 0; i < count; i++) {
                const rawValue = view.getBigInt64(i * itemSize, littleEndian);
                if (rawValue === NAT_INT64) {
                    out[i] = NaN;
                } else {
                    out[i] = this.dtype.kind === 'datetime'
                        ? Number(rawValue) * scale
                        : Number(rawValue) * scale;
                }
            }
            return out;
        }
        if (this.dtype.kind === 'unicode' && itemSize > 0) {
            for (let i = 0; i < count; i++) {
                const chars = [];
                for (let offset = i * itemSize; offset < (i + 1) * itemSize; offset += 4) {
                    chars.push(view.getUint32(offset, littleEndian));
                }
                out[i] = decodeUtf16CodeUnits(chars);
            }
            return out;
        }
        if (this.dtype.kind === 'bytes' && itemSize > 0) {
            for (let i = 0; i < count; i++) {
                out[i] = bytesToAscii(bytes.subarray(i * itemSize, (i + 1) * itemSize)).replace(/\0+$/g, '');
            }
            return out;
        }

        this.unsupported = true;
        return [];
    }

    flatIndex(indexes) {
        if (!this.shape.length) return 0;
        if (this.fortranOrder) {
            let stride = 1;
            let flat = 0;
            for (let i = 0; i < indexes.length; i++) {
                flat += indexes[i] * stride;
                stride *= this.shape[i] || 1;
            }
            return flat;
        }
        let stride = 1;
        let flat = 0;
        for (let i = this.shape.length - 1; i >= 0; i--) {
            flat += (indexes[i] || 0) * stride;
            stride *= this.shape[i] || 1;
        }
        return flat;
    }

    at(...indexes) {
        return this.data[this.flatIndex(indexes)];
    }

    toArray() {
        return Array.from(this.data || []);
    }
}

class SliceObject {
    constructor(start = null, stop = null, step = null) {
        this.start = start == null ? 0 : Number(start);
        this.stop = stop == null ? 0 : Number(stop);
        this.step = step == null ? 1 : Number(step);
    }

    toIndexes(length = null) {
        const stop = this.stop == null && length != null ? length : this.stop;
        const out = [];
        const step = this.step || 1;
        if (step > 0) {
            for (let i = this.start || 0; i < stop; i += step) out.push(i);
        } else {
            for (let i = this.start || 0; i > stop; i += step) out.push(i);
        }
        return out;
    }
}

class BlockPlacement {
    constructor(value = []) {
        this.value = value;
    }

    __setstate__(state) {
        this.value = state;
    }

    toIndexes(length = null) {
        return placementToIndexes(this.value, length);
    }
}

class PandasBlock {
    constructor(values = null, placement = null, ndim = null) {
        this.values = values;
        this.placement = placement;
        this.ndim = ndim;
    }

    __setstate__(state) {
        if (state instanceof Map) {
            this.values = mapGet(state, 'values', this.values);
            this.placement = mapGet(state, 'mgr_locs', mapGet(state, 'placement', this.placement));
            this.ndim = mapGet(state, 'ndim', this.ndim);
        } else if (Array.isArray(state)) {
            this.values = state[0] ?? this.values;
            this.placement = state[1] ?? this.placement;
            this.ndim = state[2] ?? this.ndim;
        }
    }
}

class PandasBlockManager {
    constructor(context, blocks = [], axes = []) {
        this.context = context;
        this.context?.countObject('pandas.BlockManager');
        this.blocks = asArray(blocks);
        this.axes = asArray(axes);
    }

    __setstate__(state) {
        if (state instanceof Map) {
            this.blocks = asArray(mapGet(state, 'blocks', mapGet(state, '_blocks', this.blocks)));
            this.axes = asArray(mapGet(state, 'axes', mapGet(state, '_axes', this.axes)));
            return;
        }
        if (Array.isArray(state)) {
            if (state.length >= 4 && Array.isArray(state[1]) && Array.isArray(state[2])) {
                this.axes = asArray(state[0]);
                this.blocks = state[1].map((values, index) => new PandasBlock(values, state[2][index], null));
                return;
            }
            if (state.length >= 2) {
                this.blocks = asArray(state[0]);
                this.axes = asArray(state[1]);
            }
        }
    }
}

class PandasArrayManager extends PandasBlockManager {
    constructor(context, arrays = [], axes = []) {
        super(context, [], axes);
        this.arrays = asArray(arrays);
    }

    __setstate__(state) {
        if (state instanceof Map) {
            this.arrays = asArray(mapGet(state, 'arrays', mapGet(state, '_arrays', this.arrays)));
            this.axes = asArray(mapGet(state, 'axes', mapGet(state, '_axes', this.axes)));
        } else if (Array.isArray(state)) {
            this.arrays = asArray(state[0]);
            this.axes = asArray(state[1]);
        }
    }
}

class PandasDataFrame {
    constructor(context) {
        this.context = context;
        this.context?.countObject('pandas.DataFrame');
        this._mgr = null;
        this.attrs = {};
    }

    __setstate__(state) {
        this.state = state;
        this._mgr = mapGet(state, '_mgr', mapGet(state, '_data', this._mgr));
        this.attrs = mapGet(state, 'attrs', this.attrs);
    }
}

class PandasSeries {
    constructor(context) {
        this.context = context;
        this.context?.countObject('pandas.Series');
        this._mgr = null;
        this.name = undefined;
    }

    __setstate__(state) {
        this.state = state;
        this._mgr = mapGet(state, '_mgr', mapGet(state, '_data', this._mgr));
        this.name = mapGet(state, '_name', mapGet(state, 'name', this.name));
    }
}

class PandasIndex {
    constructor(kind = 'index', values = [], options = {}) {
        this.kind = kind;
        this.values = values;
        this.name = options.name;
        this.names = options.names || (options.name !== undefined ? [options.name] : null);
        this.start = Number(options.start ?? 0);
        this.stop = Number(options.stop ?? values.length ?? 0);
        this.step = Number(options.step ?? 1);
        this.levels = options.levels || [];
        this.codes = options.codes || options.labels || [];
    }
}

class PandasTimestamp {
    constructor(value = NaN) {
        if (typeof value === 'bigint') this.valueMs = Number(value / 1000000n);
        else if (typeof value === 'number') this.valueMs = Math.abs(value) > 1e12 ? value / 1e6 : value;
        else if (ArrayBuffer.isView(value) && value.byteLength >= 8) {
            const bytes = toUint8Array(value);
            const raw = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(0, true);
            this.valueMs = raw === NAT_INT64 ? NaN : Number(raw / 1000000n);
        } else {
            const parsed = Date.parse(String(value ?? ''));
            this.valueMs = Number.isFinite(parsed) ? parsed : NaN;
        }
    }

    __setstate__(state) {
        const value = Array.isArray(state) ? state[0] : state;
        const next = new PandasTimestamp(value);
        this.valueMs = next.valueMs;
    }

    toString() {
        return Number.isFinite(this.valueMs) ? new Date(this.valueMs).toISOString() : 'NaT';
    }
}

class UnsupportedPandasExtension {
    constructor(type = 'pandas extension array') {
        this.unsupported = true;
        this.type = type;
        this.values = [];
    }

    __setstate__(state) {
        this.state = state;
    }
}

class PandasNDArrayBackedExtension {
    constructor(type = 'pandas ndarray-backed array') {
        this.type = type;
        this.values = [];
        this.dtype = null;
        this.attrs = {};
    }

    __setstate__(state) {
        if (state instanceof Map) {
            this.values = mapGet(state, '_data', mapGet(state, 'data', this.values));
            this.dtype = mapGet(state, 'dtype', this.dtype);
            this.attrs = state;
            return;
        }
        const values = asArray(state);
        for (const value of values) {
            if (value instanceof PickleNumpyArray || value instanceof PandasNDArrayBackedExtension) {
                this.values = value;
            } else if (value instanceof PickleDType || value instanceof UnsupportedPandasExtension) {
                this.dtype = value;
            } else if (value instanceof Map || (value && typeof value === 'object' && !Array.isArray(value))) {
                this.attrs = value;
            }
        }
    }

    toArray() {
        return arrayLikeValues(this.values);
    }
}

function datetimeUnitToMs(unit) {
    const normalized = String(unit || 'ns').toLowerCase();
    if (normalized === 's') return 1000;
    if (normalized === 'ms') return 1;
    if (normalized === 'us' || normalized === 'microseconds') return 0.001;
    if (normalized === 'ns' || normalized === 'nanoseconds') return 0.000001;
    if (normalized === 'm') return 60 * 1000;
    if (normalized === 'h') return 60 * 60 * 1000;
    if (normalized === 'd') return 24 * 60 * 60 * 1000;
    return 0.000001;
}

function timedeltaUnitToSeconds(unit) {
    const normalized = String(unit || 'ns').toLowerCase();
    if (normalized === 's') return 1;
    if (normalized === 'ms') return 0.001;
    if (normalized === 'us' || normalized === 'microseconds') return 0.000001;
    if (normalized === 'ns' || normalized === 'nanoseconds') return 0.000000001;
    if (normalized === 'm') return 60;
    if (normalized === 'h') return 60 * 60;
    if (normalized === 'd') return 24 * 60 * 60;
    return 0.000000001;
}

function numpyScalar(dtype, raw) {
    const array = new PickleNumpyArray(null, null, [1], dtype instanceof PickleDType ? dtype : new PickleDType(dtype));
    array.__setstate__([1, [1], array.dtype, false, raw]);
    return new PickleNumpyScalar(array.data[0]);
}

function numpyFromBuffer(context, raw, dtype, count = -1, offset = 0) {
    const bytes = toUint8Array(raw).subarray(Number(offset) || 0);
    const dt = dtype instanceof PickleDType ? dtype : new PickleDType(dtype);
    const itemSize = Math.max(1, dt.itemSize || 1);
    const n = Number(count) >= 0 ? Number(count) : Math.floor(bytes.byteLength / itemSize);
    const array = new PickleNumpyArray(context, null, [n], dt);
    array.__setstate__([1, [n], dt, false, bytes.subarray(0, n * itemSize)]);
    return array;
}

function newIndexFromState(cls, state) {
    const className = cls?.__pickleClassName || cls?.name || 'Index';
    const kind = /RangeIndex/.test(className) ? 'range'
        : /DatetimeIndex/.test(className) ? 'datetime'
        : /MultiIndex/.test(className) ? 'multi'
        : 'index';
    const data = mapGet(state, 'data', mapGet(state, '_data', []));
    const name = mapGet(state, 'name', undefined);
    if (kind === 'range') {
        return new PandasIndex('range', [], {
            start: mapGet(state, 'start', 0),
            stop: mapGet(state, 'stop', mapGet(state, '_stop', 0)),
            step: mapGet(state, 'step', 1),
            name,
        });
    }
    if (kind === 'multi') {
        return new PandasIndex('multi', [], {
            levels: asArray(mapGet(state, 'levels', [])),
            codes: asArray(mapGet(state, 'codes', mapGet(state, 'labels', []))),
            names: mapGet(state, 'names', null),
        });
    }
    const values = arrayLikeValues(data);
    return new PandasIndex(kind, values, { name });
}

function newDatetimeIndex(cls, state) {
    const index = newIndexFromState(cls, state);
    index.kind = 'datetime';
    return index;
}

function placementToIndexes(placement, length = null) {
    if (placement instanceof BlockPlacement) return placement.toIndexes(length);
    if (placement instanceof SliceObject) return placement.toIndexes(length);
    if (placement instanceof PickleNumpyArray) return placement.toArray().map(Number);
    if (Array.isArray(placement)) return placement.map(Number).filter(Number.isFinite);
    if (Number.isFinite(Number(placement))) return [Number(placement)];
    if (length != null) return Array.from({ length }, (_, index) => index);
    return [];
}

function arrayLikeValues(value) {
    if (value instanceof PickleNumpyArray) return value.toArray();
    if (value instanceof PandasNDArrayBackedExtension) return value.toArray();
    if (value instanceof PandasIndex) return indexLabels(value).map(label => Array.isArray(label) ? label.join('.') : label);
    if (value instanceof PandasTimestamp) return [value.valueMs];
    if (Array.isArray(value)) return value.map(normalizeScalar);
    if (ArrayBuffer.isView(value)) return Array.from(value);
    if (value instanceof Map) return Array.from(value.values()).map(normalizeScalar);
    return value == null ? [] : [normalizeScalar(value)];
}

function indexLabels(index) {
    if (!(index instanceof PandasIndex)) return arrayLikeValues(index);
    if (index.kind === 'range') {
        const out = [];
        const step = index.step || 1;
        for (let value = index.start; step >= 0 ? value < index.stop : value > index.stop; value += step) out.push(value);
        return out;
    }
    if (index.kind === 'multi') {
        const levels = index.levels.map(level => indexLabels(level instanceof PandasIndex ? level : new PandasIndex('index', arrayLikeValues(level))));
        const codes = index.codes.map(code => arrayLikeValues(code).map(Number));
        const length = codes.reduce((max, code) => Math.max(max, code.length), 0);
        const rows = [];
        for (let row = 0; row < length; row++) {
            rows.push(codes.map((code, levelIndex) => {
                const idx = code[row];
                return idx >= 0 ? levels[levelIndex]?.[idx] : '';
            }));
        }
        return rows;
    }
    return arrayLikeValues(index.values);
}

function makeIndexClass(name) {
    function PickleIndexClass(...args) {
        return new PandasIndex(name.includes('Range') ? 'range' : name.includes('Datetime') ? 'datetime' : name.includes('Multi') ? 'multi' : 'index', args);
    }
    PickleIndexClass.__pickleClassName = name;
    return PickleIndexClass;
}

function unsupportedClass(type) {
    return function UnsupportedPandasExtensionFactory(..._args) {
        return new UnsupportedPandasExtension(type);
    };
}

function ndarrayBackedClass(type) {
    return function PandasNDArrayBackedExtensionFactory(..._args) {
        return new PandasNDArrayBackedExtension(type);
    };
}

class PickleNameResolver {
    constructor(context) {
        this.context = context;
        this.registry = new Map();
        this._install();
    }

    register(module, name, value) {
        this.registry.set(`${module}.${name}`, value);
    }

    alias(fromModule, fromName, toModule, toName) {
        this.registry.set(`${fromModule}.${fromName}`, this.registry.get(`${toModule}.${toName}`));
    }

    resolve(module, name) {
        const key = `${module}.${name}`;
        if (this.registry.has(key)) return this.registry.get(key);
        throw pickleError('PICKLE_UNSUPPORTED_OBJECT', `Unsupported pickled object: ${key}`, { type: key });
    }

    _install() {
        const context = this.context;
        const NdArrayClass = function (...args) { return new PickleNumpyArray(context, ...args); };
        const DTypeFactory = function (...args) { return new PickleDType(...args); };
        const DataFrameClass = function (..._args) { return new PandasDataFrame(context); };
        const SeriesClass = function (..._args) { return new PandasSeries(context); };
        const BlockManagerClass = function (...args) { return new PandasBlockManager(context, ...args); };
        const ArrayManagerClass = function (...args) { return new PandasArrayManager(context, ...args); };
        const BlockPlacementClass = function (...args) { return new BlockPlacement(...args); };
        const TimestampClass = function (...args) { return new PandasTimestamp(...args); };

        for (const prefix of ['numpy.core.multiarray', 'numpy._core.multiarray']) {
            this.register(prefix, '_reconstruct', (_subtype, shape, dtype) => new PickleNumpyArray(context, _subtype, shape, dtype));
            this.register(prefix, 'scalar', (dtype, raw) => numpyScalar(dtype, raw));
        }
        for (const prefix of ['numpy.core.numeric', 'numpy._core.numeric']) {
            this.register(prefix, '_frombuffer', (raw, dtype, count, offset) => numpyFromBuffer(context, raw, dtype, count, offset));
        }
        this.register('numpy', 'ndarray', NdArrayClass);
        this.register('numpy', 'dtype', DTypeFactory);
        this.register('numpy.core.multiarray', 'ndarray', NdArrayClass);
        this.register('numpy._core.multiarray', 'ndarray', NdArrayClass);

        this.register('builtins', 'slice', (start, stop, step) => new SliceObject(start, stop, step));
        this.register('__builtin__', 'slice', (start, stop, step) => new SliceObject(start, stop, step));
        this.register('builtins', 'getattr', (obj, attr) => obj?.[attr]);
        this.register('copyreg', '_reconstructor', (cls, _base, state) => {
            const obj = Reflect.construct(cls, []);
            if (obj.__setstate__) obj.__setstate__(state);
            return obj;
        });
        this.register('functools', 'partial', (fn, ...bound) => (...args) => fn(...bound, ...args));
        this.register('_codecs', 'encode', (value, encoding = 'latin1') => {
            if (ArrayBuffer.isView(value)) return value;
            const text = String(value ?? '');
            const normalized = String(encoding || '').toLowerCase().replace(/[-_]/g, '');
            if (normalized === 'latin1' || normalized === 'iso88591') {
                return Uint8Array.from(text, char => char.charCodeAt(0) & 0xff);
            }
            return new TextEncoder().encode(text);
        });
        this.register('codecs', 'encode', this.registry.get('_codecs.encode'));

        this.register('pandas.core.frame', 'DataFrame', DataFrameClass);
        this.register('pandas.core.series', 'Series', SeriesClass);
        this.register('pandas.core.internals.managers', 'BlockManager', BlockManagerClass);
        this.register('pandas.core.internals.managers', 'SingleBlockManager', BlockManagerClass);
        this.register('pandas.core.internals.array_manager', 'ArrayManager', ArrayManagerClass);
        this.register('pandas._libs.internals', 'BlockPlacement', BlockPlacementClass);
        this.register('pandas._libs.internals', '_unpickle_block', (values, placement, ndim) => new PandasBlock(values, placement, ndim));
        this.register('pandas.core.internals.blocks', 'new_block', (values, placement, ndim) => new PandasBlock(values, placement, ndim));
        for (const blockName of ['Block', 'NumpyBlock', 'NumericBlock', 'ObjectBlock', 'DatetimeLikeBlock', 'ExtensionBlock']) {
            this.register('pandas.core.internals.blocks', blockName, function (...args) { return new PandasBlock(...args); });
        }
        this.register('pandas._libs.arrays', '__pyx_unpickle_NDArrayBacked', (cls, _checksum, state) => {
            const obj = typeof cls === 'function' ? Reflect.construct(cls, []) : new PandasNDArrayBackedExtension();
            if (state != null && obj.__setstate__) obj.__setstate__(state);
            return obj;
        });
        this.register('pandas.core.arrays.datetimes', 'DatetimeArray', ndarrayBackedClass('pandas.core.arrays.datetimes.DatetimeArray'));
        this.register('pandas.core.arrays.timedeltas', 'TimedeltaArray', ndarrayBackedClass('pandas.core.arrays.timedeltas.TimedeltaArray'));

        const IndexClass = makeIndexClass('Index');
        const RangeIndexClass = makeIndexClass('RangeIndex');
        const DatetimeIndexClass = makeIndexClass('DatetimeIndex');
        const MultiIndexClass = makeIndexClass('MultiIndex');
        this.register('pandas.core.indexes.base', 'Index', IndexClass);
        this.register('pandas.core.indexes.base', '_new_Index', newIndexFromState);
        this.register('pandas.core.indexes.range', 'RangeIndex', RangeIndexClass);
        this.register('pandas.core.indexes.numeric', 'Int64Index', IndexClass);
        this.register('pandas.core.indexes.numeric', 'UInt64Index', IndexClass);
        this.register('pandas.core.indexes.numeric', 'Float64Index', IndexClass);
        this.register('pandas.core.indexes.datetimes', 'DatetimeIndex', DatetimeIndexClass);
        this.register('pandas.core.indexes.datetimes', '_new_DatetimeIndex', newDatetimeIndex);
        this.register('pandas.core.indexes.multi', 'MultiIndex', MultiIndexClass);

        this.register('pandas._libs.tslibs.timestamps', 'Timestamp', TimestampClass);
        this.register('pandas._libs.tslibs.nattype', 'NaTType', class { constructor() { return new PandasTimestamp(NaN); } });
        this.register('pandas._libs.tslibs.nattype', '_make_NaT', () => new PandasTimestamp(NaN));
        this.register('pytz', '_p', (zone, utcOffset, dstOffset, label) => ({ type: 'pytz', zone, utcOffset, dstOffset, label }));
        this.register('pytz', 'timezone', zone => ({ type: 'pytz', zone }));
        for (const offsetName of ['Hour', 'Minute', 'Second', 'Milli', 'Micro', 'Nano', 'Day', 'MonthEnd', 'MonthBegin', 'YearEnd', 'YearBegin', 'BusinessDay']) {
            this.register('pandas._libs.tslibs.offsets', offsetName, (...args) => ({ type: `pandas offset ${offsetName}`, args }));
        }

        for (const [module, name] of [
            ['pandas.core.arrays.integer', 'IntegerArray'],
            ['pandas.core.arrays.boolean', 'BooleanArray'],
            ['pandas.core.arrays.floating', 'FloatingArray'],
            ['pandas.core.arrays.categorical', 'Categorical'],
            ['pandas.core.dtypes.dtypes', 'CategoricalDtype'],
            ['pandas.core.dtypes.dtypes', 'DatetimeTZDtype'],
        ]) {
            this.register(module, name, unsupportedClass(`${module}.${name}`));
        }
    }
}

function validatePickleEnvelope(bytes, limits) {
    const compressed = compressedPickleFormat(bytes);
    if (compressed) {
        throw pickleError(
            'PICKLE_COMPRESSED_UNSUPPORTED',
            `Compressed pickle format ${compressed} is not supported.`,
            { format: compressed }
        );
    }
    if (!bytes.length) throw new Error('Pickle file is empty.');
    if (bytes[0] === 0x80 && bytes.length > 1 && bytes[1] > 5) {
        throw new Error(`Unsupported pickle protocol ${bytes[1]}.`);
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 0;
    let memoEntries = 0;
    const line = () => {
        const next = bytes.indexOf(0x0a, offset);
        offset = next < 0 ? bytes.length : next + 1;
    };
    const skip = count => { offset = Math.min(bytes.length, offset + count); };
    while (offset < bytes.length) {
        const opcode = bytes[offset++];
        switch (opcode) {
            case 0x95: {
                if (offset + 8 > bytes.length) return;
                const frame = Number(view.getBigUint64(offset, true));
                if (frame > limits.maxFrameBytes) {
                    throw pickleError('PICKLE_LIMIT_EXCEEDED', `Pickle frame ${frame} bytes exceeds the configured limit.`);
                }
                offset += 8;
                break;
            }
            case 0x80: skip(1); break;
            case 0x8a: skip(bytes[offset++] || 0); break;
            case 0x8b: { const n = view.getInt32(offset, true); offset += 4 + Math.max(0, n); break; }
            case 0x42: { const n = view.getUint32(offset, true); offset += 4 + n; break; }
            case 0x43: skip((bytes[offset++] || 0)); break;
            case 0x8e: {
                const n = Number(view.getBigUint64(offset, true));
                offset += 8 + n;
                break;
            }
            case 0x58:
            case 0x54: { const n = view.getUint32(offset, true); offset += 4 + n; break; }
            case 0x55:
            case 0x8c: skip((bytes[offset++] || 0)); break;
            case 0x8d: { const n = Number(view.getBigUint64(offset, true)); offset += 8 + n; break; }
            case 0x4a:
            case 0x84: skip(4); break;
            case 0x47: skip(8); break;
            case 0x4d:
            case 0x83: skip(2); break;
            case 0x4b:
            case 0x82: skip(1); break;
            case 0x70:
            case 0x67:
            case 0x49:
            case 0x4c:
            case 0x46:
            case 0x53:
            case 0x56:
            case 0x50: line(); break;
            case 0x63: line(); line(); break;
            case 0x71:
            case 0x72:
            case 0x94:
                memoEntries++;
                if (memoEntries > limits.maxMemoEntries) {
                    throw pickleError('PICKLE_LIMIT_EXCEEDED', `Pickle memo entries exceed the configured limit.`);
                }
                if (opcode === 0x71) skip(1);
                else if (opcode === 0x72) skip(4);
                break;
            default:
                break;
        }
    }
}

export default class PickleParser {
    constructor(structureParser) {
        this.structureParser = structureParser || new MatParser();
    }

    async parse(buffer, filename = '', options = {}) {
        const bytes = toUint8Array(buffer);
        const maxFileBytes = Number(options.maxFileBytes || PICKLE_DEFAULT_EAGER_LIMIT_BYTES);
        if (!bytes.length) throw new Error('Pickle file is empty.');
        if (Number.isFinite(maxFileBytes) && maxFileBytes > 0 && bytes.byteLength > maxFileBytes) {
            throw pickleError('PICKLE_TOO_LARGE', 'Pandas pickle file exceeds the eager loading limit.');
        }

        const internalLimits = { ...PICKLE_DEFAULT_INTERNAL_LIMITS, ...(options.internalLimits || {}) };
        validatePickleEnvelope(bytes, internalLimits);

        const context = new PickleContext(internalLimits);
        const parser = new Parser({
            nameResolver: new PickleNameResolver(context),
            unpicklingTypeOfDictionary: 'Map',
            unpicklingTypeOfSet: 'array',
        });
        const object = parser.parse(bytes);
        return this._toResult(object, filename, context);
    }

    _toResult(object, filename, context) {
        const tables = this._extractTables(object, filename);
        if (!tables.length) {
            throw pickleError('PICKLE_UNSUPPORTED_OBJECT', 'Pickle did not contain a supported pandas DataFrame, Series, or one-level dict.', { type: 'unknown' });
        }
        const firstAxis = tables[0].axis;
        for (const table of tables.slice(1)) {
            if (!sameAxisValues(firstAxis.values, table.axis.values)) {
                throw new Error('All DataFrames/Series in a pandas pickle dict must share the same index. Open them separately or align the indexes before pickling.');
            }
        }

        const result = {
            filename,
            metadata: {
                format: 'pandas-pickle',
                source: 'pandas',
                skippedColumns: [],
                skippedColumnsCount: 0,
                duplicateColumns: [],
                duplicateColumnCount: 0,
                precisionWarnings: context.precisionWarnings,
                precisionLossCount: context.precisionWarnings.length,
            },
            variables: {},
            tree: this._rootNode(),
        };

        const timeVar = this._timeVariable(firstAxis);
        result.variables[timeVar.name] = timeVar;
        result.tree._variables[timeVar.name] = timeVar;

        const usedIds = new Map();
        const allVariables = [];
        for (const table of tables) {
            for (const column of table.columns) {
                const path = [...table.branch, ...column.path].map(part => asString(part) || 'value');
                const duplicateBase = path.join('\u0000');
                const seen = usedIds.get(duplicateBase) || 0;
                usedIds.set(duplicateBase, seen + 1);
                const idPath = path.map(idSegment).join('/') || 'value';
                const variableName = seen ? `pickle:${idPath}#${seen + 1}` : `pickle:${idPath}`;
                if (seen) {
                    result.metadata.duplicateColumns.push({ name: column.displayName, duplicateIndex: seen + 1 });
                }

                const converted = this._numericColumn(column.values);
                if (!converted.ok) {
                    const skipped = { name: column.displayName, reason: converted.reason };
                    result.metadata.skippedColumns.push(skipped);
                    this._addSkippedColumn(result.tree, skipped);
                    continue;
                }

                const variable = {
                    name: variableName,
                    displayName: [...table.branch, column.displayName].filter(Boolean).join('.'),
                    data: converted.data,
                    description: column.description || '',
                    units: undefined,
                    kind: 'variable',
                    dataType: this.structureParser._detectDataType(converted.data, 'variable'),
                    isConstant: this.structureParser._isConstantValues(converted.data),
                    interpolation: 'linear',
                    negate: false,
                    source: 'pandas-pickle',
                    pandas: {
                        column: column.rawLabel,
                        branch: table.branch.length ? table.branch.join('/') : undefined,
                    },
                };
                result.variables[variableName] = variable;
                this._addTreeVariable(result.tree, path, variable);
                allVariables.push(variable);
            }
        }

        if (!allVariables.length) throw new Error('Pandas pickle did not contain any plottable numeric columns.');

        if (firstAxis.timeKind !== 'index') {
            this._sortByTime(timeVar.data, allVariables);
        }

        const datetimeAxisStalled = timeVar.timeKind === 'datetime' && this._isStalledTimeAxis(timeVar.data);
        if (datetimeAxisStalled) {
            timeVar.timeDisplayMode = 'index';
        }
        result.metadata.skippedColumnsCount = result.metadata.skippedColumns.length;
        result.metadata.duplicateColumnCount = result.metadata.duplicateColumns.length;
        result.metadata.numVariables = Object.keys(result.variables).length;
        result.metadata.numParams = 0;
        result.metadata.numTimevarying = allVariables.length;
        result.metadata.numTimesteps = timeVar.data.length;
        result.metadata.rowCount = timeVar.data.length;
        result.metadata.columnCount = allVariables.length;
        result.metadata.timeName = timeVar.name;
        result.metadata.timeKind = timeVar.timeKind || 'numeric';
        result.metadata.timeDisplayMode = timeVar.timeDisplayMode || (timeVar.timeKind === 'index' ? 'index' : 'numeric');
        result.metadata.timeOriginMs = timeVar.timeOriginMs ?? null;
        result.metadata.timeStart = timeVar.data.length ? timeVar.data[0] : 0;
        result.metadata.timeEnd = timeVar.data.length ? timeVar.data[timeVar.data.length - 1] : 0;
        result.metadata.datetimeAxisStalled = datetimeAxisStalled;
        return result;
    }

    _extractTables(object, filename) {
        if (object instanceof PandasDataFrame) return [this._tableFromDataFrame(object, [])];
        if (object instanceof PandasSeries) return [this._tableFromSeries(object, [], filename)];
        if (object instanceof Map) {
            const tables = [];
            for (const [key, value] of object.entries()) {
                const branch = [asString(key) || 'item'];
                if (value instanceof PandasDataFrame) tables.push(this._tableFromDataFrame(value, branch));
                else if (value instanceof PandasSeries) tables.push(this._tableFromSeries(value, branch, filename));
                else throw pickleError('PICKLE_UNSUPPORTED_OBJECT', `Unsupported value in pandas pickle dict: ${branch[0]}`, { type: 'dict value' });
            }
            return tables;
        }
        return [];
    }

    _tableFromDataFrame(frame, branch = []) {
        const manager = frame._mgr;
        if (!manager) throw new Error('Pandas DataFrame pickle does not contain a BlockManager.');
        if (manager instanceof PandasArrayManager) return this._tableFromArrayManager(manager, branch);
        const axes = manager.axes || [];
        const columnIndex = axes[0] || new PandasIndex('range', [], { start: 0, stop: 0, step: 1 });
        const rowIndex = axes[1] || new PandasIndex('range', [], { start: 0, stop: this._managerRowCount(manager), step: 1 });
        const labels = this._columnLabels(columnIndex);
        const rowCount = this._axisFromIndex(rowIndex).values.length || this._managerRowCount(manager);
        const columns = labels.map((label, index) => ({
            path: Array.isArray(label) ? label : [label],
            displayName: Array.isArray(label) ? label.map(asString).join('.') : asString(label),
            rawLabel: label,
            values: [],
            index,
        }));

        for (const block of manager.blocks || []) {
            const values = block.values;
            const placements = placementToIndexes(block.placement, values?.shape?.[0] || columns.length);
            for (let local = 0; local < placements.length; local++) {
                const column = columns[placements[local]];
                if (!column) continue;
                column.values = this._blockColumnValues(values, local, placements.length, rowCount);
            }
        }
        for (const column of columns) {
            if (!column.values.length) column.values = new Array(rowCount).fill(NaN);
        }
        return { branch, axis: this._axisFromIndex(rowIndex, rowCount), columns };
    }

    _tableFromArrayManager(manager, branch = []) {
        const axes = manager.axes || [];
        const columnIndex = axes[0] || new PandasIndex('range', [], { start: 0, stop: manager.arrays.length, step: 1 });
        const rowIndex = axes[1] || new PandasIndex('range', [], { start: 0, stop: arrayLikeValues(manager.arrays[0]).length, step: 1 });
        const labels = this._columnLabels(columnIndex);
        const columns = labels.map((label, index) => ({
            path: Array.isArray(label) ? label : [label],
            displayName: Array.isArray(label) ? label.map(asString).join('.') : asString(label),
            rawLabel: label,
            values: arrayLikeValues(manager.arrays[index]),
            index,
        }));
        return { branch, axis: this._axisFromIndex(rowIndex), columns };
    }

    _tableFromSeries(series, branch = [], filename = '') {
        const manager = series._mgr;
        const rowIndex = manager?.axes?.[0] || new PandasIndex('range', [], { start: 0, stop: this._managerRowCount(manager), step: 1 });
        const rowCount = this._axisFromIndex(rowIndex).values.length || this._managerRowCount(manager);
        let values = [];
        if (manager?.blocks?.[0]) values = this._blockColumnValues(manager.blocks[0].values, 0, 1, rowCount);
        else if (manager?.arrays?.[0]) values = arrayLikeValues(manager.arrays[0]);
        const label = series.name !== undefined && series.name !== null && series.name !== ''
            ? series.name
            : String(filename || 'series').replace(/\.[^.]+$/i, '') || 'series';
        return {
            branch,
            axis: this._axisFromIndex(rowIndex, rowCount),
            columns: [{
                path: [label],
                displayName: asString(label) || 'series',
                rawLabel: label,
                values,
            }],
        };
    }

    _managerRowCount(manager) {
        for (const block of manager?.blocks || []) {
            const shape = block.values?.shape || [];
            if (shape.length >= 2) return Math.max(...shape);
            if (shape.length === 1) return shape[0];
        }
        const firstArray = manager?.arrays?.[0];
        return arrayLikeValues(firstArray).length;
    }

    _columnLabels(index) {
        const labels = indexLabels(index);
        return labels.length ? labels : [];
    }

    _axisFromIndex(index, fallbackLength = 0) {
        if (index instanceof PandasIndex) {
            if (index.kind === 'range') {
                const values = Float64Array.from(indexLabels(index), Number);
                return { values, timeKind: 'index', timeDisplayMode: 'index', timeStepMode: 'index', description: '[index]' };
            }
            if (index.kind === 'datetime') {
                const raw = arrayLikeValues(index.values);
                const values = Float64Array.from(raw, value => Number(normalizeScalar(value)));
                return { values, timeKind: 'datetime', timeDisplayMode: 'calendar', timeOriginMs: values.length ? values[0] : null, description: '[datetime]' };
            }
            if (index.kind === 'multi') {
                const length = indexLabels(index).length || fallbackLength;
                return {
                    values: Float64Array.from({ length }, (_, i) => i),
                    timeKind: 'index',
                    timeDisplayMode: 'index',
                    timeStepMode: 'index',
                    description: '[row MultiIndex flattened to row index]',
                    warning: 'row MultiIndex flattened to row index',
                };
            }
            const values = arrayLikeValues(index.values);
            if (values.every(isNumericScalar)) {
                return { values: Float64Array.from(values, value => Number(normalizeScalar(value))), timeKind: 'numeric', timeDisplayMode: 'numeric', description: '' };
            }
            const length = values.length || fallbackLength;
            return {
                values: Float64Array.from({ length }, (_, i) => i),
                timeKind: 'index',
                timeDisplayMode: 'index',
                timeStepMode: 'index',
                description: '[index]',
            };
        }
        const values = arrayLikeValues(index);
        if (values.every(isNumericScalar)) {
            return { values: Float64Array.from(values, value => Number(normalizeScalar(value))), timeKind: 'numeric', timeDisplayMode: 'numeric', description: '' };
        }
        const length = values.length || fallbackLength;
        return { values: Float64Array.from({ length }, (_, i) => i), timeKind: 'index', timeDisplayMode: 'index', timeStepMode: 'index', description: '[index]' };
    }

    _timeVariable(axis) {
        const variable = {
            name: 'index',
            data: axis.values,
            description: axis.description || '',
            kind: 'abscissa',
            dataType: this.structureParser._detectDataType(axis.values, 'abscissa'),
            isConstant: this.structureParser._isConstantValues(axis.values),
            interpolation: 'linear',
            negate: false,
            source: 'pandas-pickle',
            timeKind: axis.timeKind,
            timeDisplayMode: axis.timeDisplayMode,
            timeStepMode: axis.timeStepMode,
            timeOriginMs: axis.timeOriginMs,
        };
        return variable;
    }

    _blockColumnValues(values, localIndex, placementCount, rowCount) {
        if (values instanceof UnsupportedPandasExtension || values?.unsupported) return values;
        if (values instanceof PickleNumpyArray) {
            if (values.shape.length >= 2) {
                const shape = values.shape;
                const out = new Array(rowCount);
                if (shape[0] === placementCount) {
                    for (let row = 0; row < rowCount; row++) out[row] = values.at(localIndex, row);
                } else if (shape[1] === placementCount) {
                    for (let row = 0; row < rowCount; row++) out[row] = values.at(row, localIndex);
                } else {
                    for (let row = 0; row < rowCount; row++) out[row] = values.data[row] ?? NaN;
                }
                return out;
            }
            if (values.shape.length === 1 && placementCount > 1 && rowCount > 0 && values.data.length >= placementCount * rowCount) {
                const start = localIndex * rowCount;
                return values.data.slice(start, start + rowCount);
            }
            return values.toArray();
        }
        return arrayLikeValues(values);
    }

    _numericColumn(values) {
        if (values instanceof UnsupportedPandasExtension || values?.unsupported) {
            return { ok: false, reason: `Unsupported pandas extension array: ${values.type || 'unknown'}` };
        }
        const array = arrayLikeValues(values);
        if (!array.length) return { ok: false, reason: 'empty column' };
        const meaningful = array.filter(value => value !== null && value !== undefined && !(typeof value === 'number' && Number.isNaN(value)));
        if (!meaningful.length) return { ok: false, reason: 'empty column' };
        if (meaningful.every(value => typeof value === 'boolean')) {
            return { ok: true, data: Float64Array.from(array, value => value ? 1 : 0) };
        }
        if (meaningful.every(isNumericScalar)) {
            return { ok: true, data: Float64Array.from(array, value => value == null ? NaN : Number(normalizeScalar(value))) };
        }
        if (meaningful.every(isStringLike)) return { ok: false, reason: 'string/object column' };
        return { ok: false, reason: 'non-numeric column' };
    }

    _sortByTime(timeValues, variables) {
        if (!timeValues || timeValues.length < 2) return;
        let sorted = true;
        for (let i = 1; i < timeValues.length; i++) {
            if (timeValues[i] < timeValues[i - 1]) {
                sorted = false;
                break;
            }
        }
        if (sorted) return;
        const order = Array.from(timeValues, (time, index) => ({ time, index }))
            .sort((a, b) => (a.time - b.time) || (a.index - b.index))
            .map(entry => entry.index);
        const sortedTimes = order.map(index => timeValues[index]);
        for (let i = 0; i < sortedTimes.length; i++) timeValues[i] = sortedTimes[i];
        for (const variable of variables) {
            const sortedData = order.map(index => variable.data[index]);
            variable.data = Float64Array.from(sortedData);
        }
    }

    _isStalledTimeAxis(timeValues) {
        if (!Array.isArray(timeValues) && !ArrayBuffer.isView(timeValues)) return false;
        if (timeValues.length < 3) return false;
        let previous = NaN;
        let runLength = 0;
        const limit = Math.min(timeValues.length, 1000);
        for (let i = 0; i < limit; i++) {
            const value = Number(timeValues[i]);
            if (!Number.isFinite(value)) {
                previous = NaN;
                runLength = 0;
                continue;
            }
            runLength = value === previous ? runLength + 1 : 1;
            previous = value;
            if (runLength >= 3) return true;
        }
        return false;
    }

    _rootNode() {
        return { _type: 'root', _name: '', _children: {}, _variables: {} };
    }

    _addTreeVariable(root, path, variable) {
        const parts = path.map(part => asString(part) || 'value');
        let node = root;
        for (const part of parts.slice(0, -1)) {
            if (!node._children[part]) {
                node._children[part] = {
                    _type: 'component',
                    _name: part,
                    _fullName: node._fullName ? `${node._fullName}.${part}` : part,
                    _children: {},
                    _variables: {},
                };
            }
            node = node._children[part];
        }
        const leaf = parts[parts.length - 1] || variable.displayName || variable.name;
        let key = leaf;
        let suffix = 2;
        while (node._variables[key]) key = `${leaf} #${suffix++}`;
        node._variables[key] = variable;
    }

    _addSkippedColumn(root, skipped) {
        if (!root._children[UNSUPPORTED_COLUMNS_NODE]) {
            root._children[UNSUPPORTED_COLUMNS_NODE] = {
                _type: 'metadata',
                _name: UNSUPPORTED_COLUMNS_NODE,
                _fullName: UNSUPPORTED_COLUMNS_NODE,
                _children: {},
                _variables: {},
            };
        }
        const node = root._children[UNSUPPORTED_COLUMNS_NODE];
        const label = String(skipped.name || 'column');
        node._variables[label] = {
            name: `pickle:@skipped/${idSegment(label)}`,
            displayName: label,
            data: ['skipped'],
            description: `Skipped pandas pickle column "${label}": ${skipped.reason || 'unsupported column.'}`,
            kind: 'parameter',
            dataType: 'string',
            isConstant: true,
            interpolation: 'constant',
            negate: false,
            source: 'pandas-pickle',
            plottable: false,
            pandas: { skipped: true },
        };
    }
}
