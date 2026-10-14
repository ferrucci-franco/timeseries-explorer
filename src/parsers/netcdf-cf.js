// CF/netCDF conventions shared by the series reader (netcdf-parser.js) and the
// gridded dataset engine (src/gridded/): attribute normalization, CF time
// units, packing and fill values. One copy, so the two readers can never
// disagree about what a file's time axis or a packed value means.

export const TECHNICAL_ATTRIBUTES = new Set([
    'CLASS', 'NAME', 'REFERENCE_LIST', 'DIMENSION_LIST',
    '_Netcdf4Coordinates', '_Netcdf4Dimid', '_NCProperties',
]);
export const DESCRIPTION_KEYS = ['long_name', 'description', 'standard_name', 'title'];
export const NON_STANDARD_CALENDARS = new Set(['360_day', '365_day', '366_day', 'noleap', 'all_leap']);
export const UNIT_KEYS = ['units', 'unit', 'display_unit', 'displayUnit'];
export const TIME_UNIT_SCALES_MS = {
    day: 86400000, days: 86400000,
    hour: 3600000, hours: 3600000, hr: 3600000, hrs: 3600000,
    minute: 60000, minutes: 60000, min: 60000, mins: 60000,
    second: 1000, seconds: 1000, sec: 1000, secs: 1000, s: 1000,
    millisecond: 1, milliseconds: 1, msec: 1, msecs: 1, ms: 1,
    microsecond: 0.001, microseconds: 0.001, usec: 0.001, usecs: 0.001, us: 0.001, 'µs': 0.001,
    nanosecond: 0.000001, nanoseconds: 0.000001, nsec: 0.000001, nsecs: 0.000001, ns: 0.000001,
};

export function flatten(value, target = []) {
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        for (const item of value) flatten(item, target);
    } else {
        target.push(value);
    }
    return target;
}

export function scalar(value) {
    if (typeof value === 'bigint') {
        const converted = Number(value);
        return Number.isSafeInteger(converted) ? converted : String(value);
    }
    return value;
}

export function normalizedAttributeValue(value) {
    if (value == null) return value;
    if (Array.isArray(value) || ArrayBuffer.isView(value)) {
        const values = flatten(value).map(scalar);
        if (!values.length) return undefined;
        return values.length === 1 ? values[0] : values;
    }
    if (typeof value === 'object') return undefined;
    return scalar(value);
}

export function attrsFromHdf5(entity, { includeTechnical = false } = {}) {
    const attrs = {};
    for (const [name, attribute] of Object.entries(entity?.attrs || {})) {
        if (!includeTechnical && TECHNICAL_ATTRIBUTES.has(name)) continue;
        const value = normalizedAttributeValue(attribute?.value);
        if (value !== undefined && value !== null && value !== '') attrs[name] = value;
    }
    return attrs;
}

export function attrsFromNetcdf3(attributes = []) {
    return Object.fromEntries(attributes
        .map(attribute => [attribute.name, normalizedAttributeValue(attribute.value)])
        .filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

export function attrValue(attrs, names) {
    const entries = Object.entries(attrs || {});
    for (const wanted of names) {
        const found = entries.find(([name]) => name.toLowerCase() === wanted.toLowerCase());
        if (found) return found[1];
    }
    return undefined;
}

export function attrText(attrs, names) {
    const value = attrValue(attrs, names);
    if (Array.isArray(value)) return value.map(item => String(item)).join(', ');
    return value == null ? '' : String(value);
}

export function parseDate(value) {
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

export function cfTimeUnits(units) {
    const match = String(units || '').trim().match(/^([A-Za-zµ]+)\s+since\s+(.+)$/i);
    if (!match) return null;
    const unit = match[1].toLowerCase();
    const scaleMs = TIME_UNIT_SCALES_MS[unit];
    const originMs = parseDate(match[2]);
    return Number.isFinite(scaleMs) && Number.isFinite(originMs)
        ? { scaleMs, originMs, originText: match[2] }
        : null;
}

export function plainTimeUnitScaleMs(units) {
    const unit = String(units || '').trim().toLowerCase().match(/^([a-zµ]+)/)?.[1];
    return TIME_UNIT_SCALES_MS[unit] || null;
}

// Called on every map, column and region the gridded view reads (a global
// ERA5 map is a million values), so it is a plain loop: the closure-per-value
// form it replaced spent more time here than the file read itself.
export function decodeNumeric(values, attrs) {
    const fills = [attrValue(attrs, ['_FillValue']), attrValue(attrs, ['missing_value'])]
        .flatMap(value => Array.isArray(value) ? value : [value])
        .filter(value => value !== undefined && value !== null)
        .map(Number)
        .filter(fill => !Number.isNaN(fill));
    const rawScale = Number(attrValue(attrs, ['scale_factor']) ?? 1);
    const rawOffset = Number(attrValue(attrs, ['add_offset']) ?? 0);
    const scale = Number.isFinite(rawScale) ? rawScale : 1;
    const offset = Number.isFinite(rawOffset) ? rawOffset : 0;
    const count = values.length;
    const out = new Float64Array(count);
    const fillCount = fills.length;
    const fill0 = fills[0];
    for (let index = 0; index < count; index++) {
        const raw = values[index];
        const value = typeof raw === 'number' ? raw : Number(raw);
        // A NaN fill needs no test: NaN stays NaN through the scaling.
        if (fillCount === 1 ? value === fill0 : (fillCount > 1 && fills.includes(value))) {
            out[index] = NaN;
        } else {
            out[index] = value * scale + offset;
        }
    }
    return out;
}
