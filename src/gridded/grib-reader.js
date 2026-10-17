// GRIB, read by parts, as the same variables a netCDF file gives.
//
// ERA5 is GRIB natively, and GRIB is what the Climate Data Store sends when
// the format is left at its default. A GRIB file is a sequence of messages,
// one 2-D field each (a parameter, at one level, at one time). The file is
// walked once, reading only the section headers, to list the fields and where
// their bits are; a field is decoded when a map or a series needs it. Fields
// are then gathered into variables (time, level, latitude, longitude) and
// described exactly as the netCDF readers describe theirs, so the gridded
// view, the series and the parallel reads work on them unchanged.
//
// Covered: GRIB1 and GRIB2 on regular latitude/longitude grids, simple
// packing (GRIB1 grid-point, GRIB2 template 5.0), GRIB2 complex packing with
// or without spatial differencing (5.2, 5.3), IEEE floats (5.4), bitmaps. That
// is what the CDS sends for ERA5 on its regular grids. JPEG 2000, PNG and
// CCSDS packing, spectral fields, Gaussian and other grids are refused with a
// message that says which, so the user knows to convert (cdo, ecCodes).

const MISSING = NaN;

export class GribUnsupportedError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GribUnsupportedError';
        this.code = 'GRIB_UNSUPPORTED';
    }
}

// ---- Bytes ---------------------------------------------------------------

function uint(bytes, offset, count) {
    let value = 0;
    for (let index = 0; index < count; index++) value = value * 256 + bytes[offset + index];
    return value;
}

// GRIB's signed integers are sign and magnitude, not two's complement.
function sint(bytes, offset, count) {
    const first = bytes[offset];
    const magnitude = uint(bytes, offset, count) - (first & 0x80) * 2 ** (8 * (count - 1));
    return first & 0x80 ? -magnitude : magnitude;
}

function ibmFloat(bytes, offset) {
    const sign = bytes[offset] & 0x80 ? -1 : 1;
    const exponent = bytes[offset] & 0x7f;
    const mantissa = uint(bytes, offset + 1, 3);
    return sign * mantissa * 2 ** -24 * 16 ** (exponent - 64);
}

function ieeeFloat(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(0, false);
}

class BitReader {
    constructor(bytes, bitOffset = 0) {
        this.bytes = bytes;
        this.position = bitOffset;
    }

    read(count) {
        let value = 0;
        let remaining = count;
        while (remaining > 0) {
            const byte = this.bytes[this.position >> 3];
            const used = this.position & 7;
            const take = Math.min(8 - used, remaining);
            const bits = (byte >> (8 - used - take)) & ((1 << take) - 1);
            value = value * (1 << take) + bits;
            this.position += take;
            remaining -= take;
        }
        return value;
    }

    alignToByte() {
        this.position = (this.position + 7) & ~7;
    }
}

/** `count` unsigned integers of `width` bits from `bytes`, from bit `bitOffset`. */
function unpack(bytes, count, width, bitOffset = 0) {
    const out = new Float64Array(count);
    if (width === 0) return out;
    if (bitOffset === 0 && (width === 8 || width === 16 || width === 24 || width === 32)) {
        const step = width / 8;
        for (let index = 0, at = 0; index < count; index++, at += step) {
            let value = 0;
            for (let byte = 0; byte < step; byte++) value = value * 256 + bytes[at + byte];
            out[index] = value;
        }
        return out;
    }
    const reader = new BitReader(bytes, bitOffset);
    for (let index = 0; index < count; index++) out[index] = reader.read(width);
    return out;
}

// ---- Tables: names for the parameters ERA5 carries -------------------------

// ECMWF GRIB1 local table 128 (and 228 for the 100 m wind), by parameter
// number: short name, long name, units. Anything else is named by its codes.
const GRIB1_ECMWF = {
    128: {
        31: ['ci', 'Sea ice area fraction', '(0 - 1)'], 34: ['sst', 'Sea surface temperature', 'K'],
        59: ['cape', 'Convective available potential energy', 'J kg**-1'], 129: ['z', 'Geopotential', 'm**2 s**-2'],
        130: ['t', 'Temperature', 'K'], 131: ['u', 'U component of wind', 'm s**-1'], 132: ['v', 'V component of wind', 'm s**-1'],
        133: ['q', 'Specific humidity', 'kg kg**-1'], 134: ['sp', 'Surface pressure', 'Pa'], 135: ['w', 'Vertical velocity', 'Pa s**-1'],
        137: ['tcwv', 'Total column vertically-integrated water vapour', 'kg m**-2'], 138: ['vo', 'Vorticity (relative)', 's**-1'],
        141: ['sd', 'Snow depth', 'm of water equivalent'], 142: ['lsp', 'Large-scale precipitation', 'm'],
        143: ['cp', 'Convective precipitation', 'm'], 144: ['sf', 'Snowfall', 'm of water equivalent'],
        151: ['msl', 'Mean sea level pressure', 'Pa'], 155: ['d', 'Divergence', 's**-1'], 157: ['r', 'Relative humidity', '%'],
        159: ['blh', 'Boundary layer height', 'm'], 164: ['tcc', 'Total cloud cover', '(0 - 1)'],
        165: ['10u', '10 metre U wind component', 'm s**-1'], 166: ['10v', '10 metre V wind component', 'm s**-1'],
        167: ['2t', '2 metre temperature', 'K'], 168: ['2d', '2 metre dewpoint temperature', 'K'],
        169: ['ssrd', 'Surface short-wave (solar) radiation downwards', 'J m**-2'], 172: ['lsm', 'Land-sea mask', '(0 - 1)'],
        175: ['strd', 'Surface long-wave (thermal) radiation downwards', 'J m**-2'], 176: ['ssr', 'Surface net short-wave (solar) radiation', 'J m**-2'],
        177: ['str', 'Surface net long-wave (thermal) radiation', 'J m**-2'], 182: ['e', 'Evaporation', 'm of water equivalent'],
        203: ['o3', 'Ozone mass mixing ratio', 'kg kg**-1'], 228: ['tp', 'Total precipitation', 'm'],
        235: ['skt', 'Skin temperature', 'K'], 246: ['clwc', 'Specific cloud liquid water content', 'kg kg**-1'],
        247: ['ciwc', 'Specific cloud ice water content', 'kg kg**-1'], 248: ['cc', 'Fraction of cloud cover', '(0 - 1)'],
    },
    228: {
        29: ['i10fg', 'Instantaneous 10 metre wind gust', 'm s**-1'],
        246: ['100u', '100 metre U wind component', 'm s**-1'], 247: ['100v', '100 metre V wind component', 'm s**-1'],
    },
};

// GRIB2, by discipline, category and number, with the first fixed surface
// where it decides the name (2 m temperature is "t" at 2 m above ground).
function grib2Parameter(discipline, category, number, surfaceType, surfaceValue) {
    const at = (type, value) => surfaceType === type && Math.abs(surfaceValue - value) < 1e-6;
    if (discipline === 0 && category === 0 && number === 0) {
        if (at(103, 2)) return ['2t', '2 metre temperature', 'K'];
        if (surfaceType === 1) return ['skt', 'Skin temperature', 'K'];
        return ['t', 'Temperature', 'K'];
    }
    if (discipline === 0 && category === 0 && number === 6) return at(103, 2) ? ['2d', '2 metre dewpoint temperature', 'K'] : ['dpt', 'Dew point temperature', 'K'];
    if (discipline === 0 && category === 2 && (number === 2 || number === 3)) {
        const c = number === 2 ? 'u' : 'v';
        const C = c.toUpperCase();
        if (at(103, 10)) return [`10${c}`, `10 metre ${C} wind component`, 'm s**-1'];
        if (at(103, 100)) return [`100${c}`, `100 metre ${C} wind component`, 'm s**-1'];
        return [c, `${C} component of wind`, 'm s**-1'];
    }
    const table = {
        '0.0.4': ['tmax', 'Maximum temperature', 'K'], '0.0.5': ['tmin', 'Minimum temperature', 'K'],
        '0.1.0': ['q', 'Specific humidity', 'kg kg**-1'], '0.1.1': ['r', 'Relative humidity', '%'],
        '0.1.3': ['tcwv', 'Total column vertically-integrated water vapour', 'kg m**-2'],
        '0.1.8': ['tp', 'Total precipitation', 'kg m**-2'], '0.1.52': ['tprate', 'Total precipitation rate', 'kg m**-2 s**-1'],
        '0.2.8': ['w', 'Vertical velocity', 'Pa s**-1'], '0.2.12': ['vo', 'Vorticity (relative)', 's**-1'], '0.2.13': ['d', 'Divergence', 's**-1'],
        '0.2.22': ['fg', 'Wind gust', 'm s**-1'],
        '0.3.0': surfaceType === 1 ? ['sp', 'Surface pressure', 'Pa'] : ['pres', 'Pressure', 'Pa'],
        '0.3.1': ['msl', 'Mean sea level pressure', 'Pa'], '0.3.4': ['z', 'Geopotential', 'm**2 s**-2'], '0.3.5': ['gh', 'Geopotential height', 'gpm'],
        '0.3.18': ['blh', 'Boundary layer height', 'm'],
        '0.4.7': ['ssrd', 'Surface short-wave (solar) radiation downwards', 'J m**-2'],
        '0.5.3': ['strd', 'Surface long-wave (thermal) radiation downwards', 'J m**-2'],
        '0.6.1': ['tcc', 'Total cloud cover', '%'], '0.7.6': ['cape', 'Convective available potential energy', 'J kg**-1'],
        '0.14.2': ['tco3', 'Total column ozone', 'DU'], '2.0.0': ['lsm', 'Land-sea mask', '(0 - 1)'],
        '10.3.0': ['sst', 'Sea surface temperature', 'K'], '10.2.0': ['ci', 'Sea ice area fraction', '(0 - 1)'],
    };
    return table[`${discipline}.${category}.${number}`] || null;
}

// Levels: what the netCDF view calls them, by GRIB1 level type (table 3) or
// GRIB2 surface type (code table 4.5).
const LEVEL_KINDS = {
    isobaric: { name: 'pressure_level', units: 'hPa', longName: 'pressure', standardName: 'air_pressure', positive: 'down' },
    height: { name: 'height', units: 'm', longName: 'height above ground', positive: 'up' },
    hybrid: { name: 'hybrid', units: '1', longName: 'hybrid level', positive: 'down' },
    depth: { name: 'depth', units: 'm', longName: 'depth below land surface', positive: 'down' },
    potentialVorticity: { name: 'potential_vorticity', units: 'K m**2 kg**-1 s**-1', longName: 'potential vorticity surface' },
    theta: { name: 'theta', units: 'K', longName: 'potential temperature level' },
};

function grib1Level(type, bytes, offset) {
    switch (type) {
    case 1: return { kind: 'surface', value: 0 };
    case 100: return { kind: 'isobaric', value: uint(bytes, offset, 2) };
    case 102: return { kind: 'meanSea', value: 0 };
    case 105: return { kind: 'height', value: uint(bytes, offset, 2) };
    case 109: return { kind: 'hybrid', value: uint(bytes, offset, 2) };
    case 112: return { kind: 'depth', value: bytes[offset + 1] / 100 };
    case 113: return { kind: 'theta', value: uint(bytes, offset, 2) };
    case 117: return { kind: 'potentialVorticity', value: uint(bytes, offset, 2) };
    case 200: return { kind: 'entireAtmosphere', value: 0 };
    default: return { kind: `level${type}`, value: uint(bytes, offset, 2) };
    }
}

function grib2Level(type, scale, scaled) {
    const value = scaled === 0xffffffff || scale === 0xff ? 0 : scaled / 10 ** (scale > 127 ? -(scale - 128) : scale);
    switch (type) {
    case 1: return { kind: 'surface', value: 0 };
    case 100: return { kind: 'isobaric', value: value / 100 };
    case 101: return { kind: 'meanSea', value: 0 };
    case 103: return { kind: 'height', value };
    case 105: return { kind: 'hybrid', value };
    case 106: return { kind: 'depth', value };
    case 107: return { kind: 'theta', value };
    case 109: return { kind: 'potentialVorticity', value };
    case 8: case 10: return { kind: 'entireAtmosphere', value: 0 };
    default: return { kind: `level${type}`, value };
    }
}

// Time units of GRIB1 table 4 / GRIB2 code table 4.4, in seconds.
const TIME_UNIT_SECONDS = { 0: 60, 1: 3600, 2: 86400, 10: 3 * 3600, 11: 6 * 3600, 12: 12 * 3600, 13: 900, 14: 1800, 254: 1 };

function timeUnitSeconds(unit) {
    const seconds = TIME_UNIT_SECONDS[unit];
    if (!seconds) throw new GribUnsupportedError(`GRIB time unit ${unit} is not supported.`);
    return seconds;
}

// ---- Walking the messages ------------------------------------------------

const GRIB = [0x47, 0x52, 0x49, 0x42];

function findGrib(source, from) {
    const block = 64 * 1024;
    for (let offset = from; offset < source.size; offset += block - 3) {
        const bytes = source.read(offset, Math.min(block, source.size - offset));
        for (let index = 0; index + 3 < bytes.length; index++) {
            if (bytes[index] === GRIB[0] && bytes[index + 1] === GRIB[1] && bytes[index + 2] === GRIB[2] && bytes[index + 3] === GRIB[3]) return offset + index;
        }
        if (offset + block >= source.size) break;
    }
    return -1;
}

function regularGrid(ni, nj, lat1, lon1, lat2, lon2, scan) {
    if (!(ni > 1 && nj > 0)) throw new GribUnsupportedError('This GRIB grid has no rows or columns.');
    let span = lon2 - lon1;
    if (scan & 0x80) span = -(((lon1 - lon2) % 360) + 360) % 360;
    else if (span < 0) span += 360;
    // To a millionth of a degree, GRIB2's own resolution: 359.9, not 359.90000000000003.
    const round = value => Math.round(value * 1e6) / 1e6;
    const lon = Float64Array.from({ length: ni }, (_, index) => round(lon1 + (span * index) / (ni - 1)));
    const lat = Float64Array.from({ length: nj }, (_, index) => round(nj === 1 ? lat1 : lat1 + ((lat2 - lat1) * index) / (nj - 1)));
    if (scan & 0x10) throw new GribUnsupportedError('This GRIB grid scans rows in alternate directions, which is not supported.');
    return { ni, nj, lat, lon, columnMajor: (scan & 0x20) !== 0, signature: `${ni}x${nj}:${lat1},${lon1}:${lat2},${lon2}:${scan & 0xe0}` };
}

function grib1Fields(source, offset, head) {
    let length = uint(head, 4, 3);
    const large = (length & 0x800000) !== 0;
    const pdsLength = uint(source.read(offset + 8, 3), 0, 3);
    const pds = source.read(offset + 8, pdsLength);
    const flags = pds[7];
    let at = offset + 8 + pdsLength;
    let gds = null;
    if (flags & 0x80) {
        const gdsLength = uint(source.read(at, 3), 0, 3);
        gds = source.read(at, gdsLength);
        at += gdsLength;
    }
    let bitmap = null;
    if (flags & 0x40) {
        const bmsLength = uint(source.read(at, 3), 0, 3);
        const bms = source.read(at, 6);
        if (uint(bms, 4, 2) !== 0) throw new GribUnsupportedError('This GRIB1 file uses a predefined bitmap, which is not supported.');
        bitmap = { offset: at + 6, length: bmsLength - 6 };
        at += bmsLength;
    }
    let bdsLength = uint(source.read(at, 3), 0, 3);
    if (large) {
        // ECMWF's convention for messages over 8 MB: the 24-bit length counts
        // in units of 120 bytes, and the data section's length is corrected.
        length = (length & 0x7fffff) * 120 - bdsLength + 4;
        bdsLength = offset + length - 4 - at;
    }
    if (!gds) throw new GribUnsupportedError('This GRIB1 message has no grid description.');
    if (gds[5] !== 0) throw new GribUnsupportedError(`This GRIB1 file is on a grid of type ${gds[5]} (only regular latitude/longitude grids are supported; regrid it with cdo remapbil or the CDS "grid" option).`);
    const scale = 0.001;
    const grid = regularGrid(
        uint(gds, 6, 2), uint(gds, 8, 2),
        sint(gds, 10, 3) * scale, sint(gds, 13, 3) * scale,
        sint(gds, 17, 3) * scale, sint(gds, 20, 3) * scale, gds[27],
    );
    const bdsHead = source.read(at, 11);
    if (bdsHead[3] & 0x80) throw new GribUnsupportedError('This GRIB1 file holds spherical harmonics (a spectral field); convert it to a grid first.');
    if (bdsHead[3] & 0x40) throw new GribUnsupportedError('This GRIB1 file uses second-order packing, which is not supported; repack it with ecCodes (grib_set -r -s packingType=grid_simple).');
    const year = (pds[24] - 1) * 100 + pds[12];
    const reference = Date.UTC(year, pds[13] - 1, pds[14], pds[15], pds[16]);
    const unit = timeUnitSeconds(pds[17]);
    const range = pds[20];
    const step = range === 10 ? uint(pds, 18, 2) : (range >= 2 && range <= 5 ? pds[19] : pds[18]);
    const table = pds[3];
    const number = pds[8];
    const known = GRIB1_ECMWF[table]?.[number];
    return [{
        edition: 1,
        offset,
        length,
        time: reference + step * unit * 1000,
        parameter: known ? { key: `1:${table}:${number}`, shortName: known[0], longName: known[1], units: known[2] }
            : { key: `1:${table}:${number}`, shortName: `param${number}.${table}`, longName: `GRIB1 parameter ${number} (table ${table})`, units: '' },
        level: grib1Level(pds[9], pds, 10),
        grid,
        bitmap,
        packing: {
            template: 'grib1-simple',
            dataOffset: at + 11,
            dataLength: bdsLength - 11,
            reference: ibmFloat(bdsHead, 6),
            binaryScale: sint(bdsHead, 4, 2),
            decimalScale: sint(pds, 26, 2),
            bits: bdsHead[10],
        },
    }];
}

function grib2Fields(source, offset, head) {
    const length = uint(head, 8, 8);
    const discipline = head[6];
    const end = offset + length;
    const fields = [];
    let at = offset + 16;
    let reference = null;
    let grid = null;
    let product = null;
    let packing = null;
    let bitmap = null;
    while (at + 4 <= end) {
        const peek = source.read(at, Math.min(5, end - at));
        if (peek[0] === 0x37 && peek[1] === 0x37 && peek[2] === 0x37 && peek[3] === 0x37) break;
        const sectionLength = uint(peek, 0, 4);
        const number = peek[4];
        if (!(sectionLength > 0)) break;
        // The bitmap and the data stay in the file; every other section is small.
        const section = number === 6 || number === 7 ? source.read(at, Math.min(sectionLength, 6)) : source.read(at, sectionLength);
        if (number === 1) {
            reference = Date.UTC(uint(section, 12, 2), section[14] - 1, section[15], section[16], section[17], section[18]);
        } else if (number === 3) {
            const template = uint(section, 12, 2);
            if (template !== 0) throw new GribUnsupportedError(`This GRIB2 file is on a grid of template 3.${template} (only regular latitude/longitude, 3.0, is supported; regrid it with cdo remapbil or the CDS "grid" option).`);
            const basic = uint(section, 38, 4);
            const subdivisions = uint(section, 42, 4);
            const unit = basic === 0 || basic === 0xffffffff || subdivisions === 0 || subdivisions === 0xffffffff ? 1e-6 : basic / subdivisions;
            grid = regularGrid(
                uint(section, 30, 4), uint(section, 34, 4),
                sint(section, 46, 4) * unit, sint(section, 50, 4) * unit,
                sint(section, 55, 4) * unit, sint(section, 59, 4) * unit, section[71],
            );
        } else if (number === 4) {
            const template = uint(section, 7, 2);
            if (![0, 1, 8, 11].includes(template)) throw new GribUnsupportedError(`This GRIB2 file uses product template 4.${template}, which is not supported.`);
            const unit = timeUnitSeconds(section[17]);
            let time = reference + sint(section, 18, 4) * unit * 1000;
            // A statistic over a period (an accumulation, a maximum) is valid at its end.
            const endAt = template === 8 ? 34 : template === 11 ? 37 : -1;
            if (endAt > 0) time = Date.UTC(uint(section, endAt, 2), section[endAt + 2] - 1, section[endAt + 3], section[endAt + 4], section[endAt + 5], section[endAt + 6]);
            const category = section[9];
            const parameterNumber = section[10];
            const level = grib2Level(section[22], section[23], uint(section, 24, 4));
            const known = grib2Parameter(discipline, category, parameterNumber, section[22], level.value);
            const key = `2:${discipline}:${category}:${parameterNumber}`;
            product = {
                time,
                level,
                parameter: known
                    ? { key: `${key}:${known[0]}`, shortName: known[0], longName: known[1], units: known[2] }
                    : { key, shortName: `param${discipline}.${category}.${parameterNumber}`, longName: `GRIB2 parameter ${discipline}.${category}.${parameterNumber}`, units: '' },
            };
        } else if (number === 5) {
            const template = uint(section, 9, 2);
            const count = uint(section, 5, 4);
            if (template === 0 || template === 2 || template === 3) {
                packing = {
                    template: `grib2-${template}`,
                    count,
                    reference: ieeeFloat(section, 11),
                    binaryScale: sint(section, 15, 2),
                    decimalScale: sint(section, 17, 2),
                    bits: section[19],
                };
                if (template !== 0) {
                    Object.assign(packing, {
                        missingManagement: section[22],
                        groups: uint(section, 31, 4),
                        widthReference: section[35],
                        widthBits: section[36],
                        lengthReference: uint(section, 37, 4),
                        lengthIncrement: section[41],
                        lastLength: uint(section, 42, 4),
                        lengthBits: section[46],
                        order: template === 3 ? section[47] : 0,
                        extraOctets: template === 3 ? section[48] : 0,
                    });
                }
            } else if (template === 4) {
                if (section[11] !== 1) throw new GribUnsupportedError('This GRIB2 file holds 64-bit floats, which are not supported.');
                packing = { template: 'grib2-4', count };
            } else {
                const names = { 40: 'JPEG 2000', 41: 'PNG', 42: 'CCSDS', 50: 'spectral', 51: 'spectral' };
                throw new GribUnsupportedError(`This GRIB2 file uses ${names[template] || `template 5.${template}`} packing, which is not supported yet; repack it with ecCodes (grib_set -r -s packingType=grid_simple in.grib out.grib) or convert it to netCDF (cdo -f nc4 copy).`);
            }
        } else if (number === 6) {
            const indicator = section[5];
            if (indicator === 0) bitmap = { offset: at + 6, length: sectionLength - 6 };
            else if (indicator === 255) bitmap = null;
            else if (indicator !== 254) throw new GribUnsupportedError('This GRIB2 file uses a predefined bitmap, which is not supported.');
        } else if (number === 7) {
            if (!grid || !product || !packing) throw new GribUnsupportedError('A GRIB2 message lacks its grid, product or packing section.');
            fields.push({
                edition: 2,
                offset,
                length,
                time: product.time,
                parameter: product.parameter,
                level: product.level,
                grid,
                bitmap,
                packing: { ...packing, dataOffset: at + 5, dataLength: sectionLength - 5 },
            });
        }
        at += sectionLength;
    }
    return { fields, length };
}

// The messages one after another: each one's edition and fields.
function* gribMessages(source) {
    let offset = 0;
    while (offset + 16 <= source.size) {
        let head = source.read(offset, 16);
        if (!(head[0] === GRIB[0] && head[1] === GRIB[1] && head[2] === GRIB[2] && head[3] === GRIB[3])) {
            const next = findGrib(source, offset);
            if (next < 0) break;
            offset = next;
            head = source.read(offset, 16);
        }
        const edition = head[7];
        if (edition === 1) {
            const found = grib1Fields(source, offset, head);
            yield { edition, fields: found };
            offset += found[0].length;
        } else if (edition === 2) {
            const found = grib2Fields(source, offset, head);
            yield { edition, fields: found.fields };
            offset += found.length;
        } else {
            throw new GribUnsupportedError(`GRIB edition ${edition} is not supported.`);
        }
    }
}

function scanned(fields, editions) {
    if (!fields.length) throw new GribUnsupportedError('No GRIB message could be read from this file.');
    return { fields, editions: [...editions].sort() };
}

/**
 * The fields of a GRIB file, from a byte source ({size, read(offset, length)}),
 * reading only section headers.
 */
export function scanGrib(source) {
    const fields = [];
    const editions = new Set();
    for (const message of gribMessages(source)) {
        editions.add(message.edition);
        fields.push(...message.fields);
    }
    return scanned(fields, editions);
}

/**
 * scanGrib, stopping every `everyMs` to await `pause()`: a file of tens of
 * thousands of messages takes a while to walk, and the worker only hears a
 * cancel between tasks. `pause` throws to stop the walk.
 */
export async function scanGribAsync(source, pause, everyMs = 50) {
    const fields = [];
    const editions = new Set();
    let paused = Date.now();
    for (const message of gribMessages(source)) {
        editions.add(message.edition);
        fields.push(...message.fields);
        if (Date.now() - paused >= everyMs) {
            await pause();
            paused = Date.now();
        }
    }
    return scanned(fields, editions);
}

// ---- Decoding one field ---------------------------------------------------

function applyBitmap(source, field, packed) {
    const total = field.grid.ni * field.grid.nj;
    if (!field.bitmap) return packed.length === total ? packed : padded(packed, total);
    const bits = source.read(field.bitmap.offset, field.bitmap.length);
    const out = new Float64Array(total);
    let next = 0;
    for (let index = 0; index < total; index++) {
        out[index] = bits[index >> 3] & (0x80 >> (index & 7)) ? packed[next++] : MISSING;
    }
    return out;
}

function padded(values, total) {
    const out = new Float64Array(total).fill(MISSING);
    out.set(values.subarray(0, Math.min(values.length, total)));
    return out;
}

function scaled(integers, { reference, binaryScale, decimalScale }) {
    const binary = 2 ** binaryScale;
    const decimal = 10 ** -decimalScale;
    for (let index = 0; index < integers.length; index++) {
        if (!Number.isNaN(integers[index])) integers[index] = (reference + integers[index] * binary) * decimal;
    }
    return integers;
}

function packedCount(source, field) {
    if (field.packing.count !== undefined) return field.packing.count;
    const total = field.grid.ni * field.grid.nj;
    if (!field.bitmap) return total;
    const bits = source.read(field.bitmap.offset, field.bitmap.length);
    let count = 0;
    for (let index = 0; index < total; index++) if (bits[index >> 3] & (0x80 >> (index & 7))) count += 1;
    return count;
}

function decodeComplex(bytes, packing, count) {
    const reader = new BitReader(bytes);
    const extra = [];
    if (packing.order > 0) {
        const width = packing.extraOctets * 8;
        for (let index = 0; index < packing.order + 1; index++) {
            const raw = reader.read(width);
            const sign = 2 ** (width - 1);
            extra.push(raw >= sign ? -(raw - sign) : raw);
        }
    }
    const groups = packing.groups;
    const references = new Float64Array(groups);
    for (let index = 0; index < groups; index++) references[index] = reader.read(packing.bits);
    reader.alignToByte();
    const widths = new Float64Array(groups);
    for (let index = 0; index < groups; index++) widths[index] = reader.read(packing.widthBits) + packing.widthReference;
    reader.alignToByte();
    const lengths = new Float64Array(groups);
    for (let index = 0; index < groups; index++) lengths[index] = packing.lengthReference + reader.read(packing.lengthBits) * packing.lengthIncrement;
    if (groups) lengths[groups - 1] = packing.lastLength;
    reader.alignToByte();
    const out = new Float64Array(count);
    const missing = packing.missingManagement;
    let at = 0;
    for (let group = 0; group < groups && at < count; group++) {
        const width = widths[group];
        const length = lengths[group];
        const reference = references[group];
        const allOnesReference = 2 ** packing.bits - 1;
        if (width === 0) {
            const value = missing && reference === allOnesReference ? MISSING : reference;
            for (let index = 0; index < length && at < count; index++) out[at++] = value;
        } else {
            const allOnes = 2 ** width - 1;
            for (let index = 0; index < length && at < count; index++) {
                const raw = reader.read(width);
                out[at++] = missing && (raw === allOnes || (missing === 2 && raw === allOnes - 1)) ? MISSING : reference + raw;
            }
        }
    }
    if (packing.order > 0) {
        const minimum = extra[packing.order];
        let previous1 = 0;
        let previous2 = 0;
        let seen = 0;
        for (let index = 0; index < count; index++) {
            if (Number.isNaN(out[index])) continue;
            if (seen < packing.order) {
                out[index] = extra[seen];
            } else if (packing.order === 1) {
                out[index] = out[index] + minimum + previous1;
            } else {
                out[index] = out[index] + minimum + 2 * previous1 - previous2;
            }
            previous2 = previous1;
            previous1 = out[index];
            seen += 1;
        }
    }
    return out;
}

/**
 * One field's values, row by row from its first latitude to its last
 * (columns from its first longitude): `grid.nj * grid.ni` numbers, NaN where
 * the bitmap says there is no value.
 */
export function decodeField(source, field) {
    const packing = field.packing;
    const bytes = source.read(packing.dataOffset, packing.dataLength);
    const count = packedCount(source, field);
    let values;
    if (packing.template === 'grib2-4') {
        values = new Float64Array(count);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let index = 0; index < count; index++) values[index] = view.getFloat32(index * 4, false);
    } else if (packing.template === 'grib2-2' || packing.template === 'grib2-3') {
        values = scaled(decodeComplex(bytes, packing, count), packing);
    } else if (packing.bits === 0) {
        values = new Float64Array(count).fill(packing.reference * 10 ** -packing.decimalScale);
    } else {
        values = scaled(unpack(bytes, count, packing.bits), packing);
    }
    values = applyBitmap(source, field, values);
    if (!field.grid.columnMajor) return values;
    const { ni, nj } = field.grid;
    const rows = new Float64Array(ni * nj);
    for (let i = 0; i < ni; i++) for (let j = 0; j < nj; j++) rows[j * ni + i] = values[i * nj + j];
    return rows;
}

// ---- Fields gathered into variables -------------------------------------

function levelLabel(level) {
    const kind = LEVEL_KINDS[level.kind];
    if (level.kind === 'surface') return 'surface';
    if (level.kind === 'meanSea') return 'mean sea level';
    if (level.kind === 'entireAtmosphere') return 'entire atmosphere';
    return kind ? `${level.value} ${kind.units} (${kind.longName})` : `${level.kind} ${level.value}`;
}

/**
 * The fields of a GRIB file as netCDF-like descriptors: one variable per
 * parameter and kind of level (time, level when there are several,
 * latitude, longitude), coordinates as one-dimensional variables, each
 * variable reading its hyperslabs field by field.
 */
export function openGrib(source, scan = scanGrib(source)) {
    const { fields, editions } = scan;
    const descriptors = [];
    const coordinate = (path, values, userAttrs) => ({
        path, name: path.slice(1), group: '/', shape: [values.length], attrs: userAttrs, userAttrs,
        dimensions: [path], numeric: true, textual: false, supportsSlice: true,
        read: ranges => (ranges ? values.slice(ranges[0][0], ranges[0][1]) : values.slice()),
    });
    // Coordinates shared where they are the same: one grid, one time axis,
    // one set of levels per kind, named apart only when they differ.
    const named = new Map();
    const unique = (base, signature, build) => {
        const key = `${base}|${signature}`;
        if (named.has(key)) return named.get(key);
        let count = 0;
        for (const existing of named.keys()) if (existing.startsWith(`${base}|`)) count += 1;
        const path = `/${count ? `${base}_${count + 1}` : base}`;
        named.set(key, path);
        descriptors.push(build(path));
        return path;
    };
    const groups = new Map();
    for (const field of fields) {
        const key = `${field.parameter.key}|${field.level.kind}|${field.grid.signature}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(field);
    }
    const shortNames = new Map();
    for (const group of groups.values()) {
        const first = group[0];
        const grid = first.grid;
        const latPath = unique('latitude', `${grid.nj}:${grid.lat[0]}:${grid.lat.at(-1)}`, path => coordinate(path, grid.lat, { units: 'degrees_north', standard_name: 'latitude', long_name: 'latitude' }));
        const lonPath = unique('longitude', `${grid.ni}:${grid.lon[0]}:${grid.lon.at(-1)}`, path => coordinate(path, grid.lon, { units: 'degrees_east', standard_name: 'longitude', long_name: 'longitude' }));
        const times = [...new Set(group.map(field => field.time))].sort((a, b) => a - b);
        const timePath = unique('time', times.join(','), path => coordinate(path, Float64Array.from(times, time => time / 1000), {
            units: 'seconds since 1970-01-01 00:00:00', standard_name: 'time', long_name: 'time', calendar: 'proleptic_gregorian', axis: 'T',
        }));
        const levelValues = [...new Set(group.map(field => field.level.value))].sort((a, b) => a - b);
        const levelKind = LEVEL_KINDS[first.level.kind];
        const multiLevel = levelValues.length > 1;
        let levelPath = null;
        if (multiLevel) {
            // Pressure levels top down, as ERA5's netCDF stores them.
            const ordered = levelKind?.positive === 'down' ? [...levelValues].reverse() : levelValues;
            levelPath = unique(levelKind?.name || first.level.kind, ordered.join(','), path => coordinate(path, Float64Array.from(ordered), {
                units: levelKind?.units || '', long_name: levelKind?.longName || first.level.kind,
                ...(levelKind?.standardName ? { standard_name: levelKind.standardName } : {}),
                ...(levelKind?.positive ? { positive: levelKind.positive } : {}),
                axis: 'Z',
            }));
            levelValues.splice(0, levelValues.length, ...ordered);
        }
        const timeIndex = new Map(times.map((time, index) => [time, index]));
        const levelIndex = new Map(levelValues.map((value, index) => [value, index]));
        const table = Array.from({ length: times.length }, () => new Array(levelValues.length).fill(null));
        for (const field of group) table[timeIndex.get(field.time)][multiLevel ? levelIndex.get(field.level.value) : 0] = field;
        let name = first.parameter.shortName;
        // The same parameter on two kinds of level (t on pressure levels and
        // at the surface) needs two names.
        if (shortNames.has(name)) name = `${name}_${first.level.kind}`;
        shortNames.set(name, true);
        const dimensions = [timePath, ...(levelPath ? [levelPath] : []), latPath, lonPath];
        const shape = [times.length, ...(levelPath ? [levelValues.length] : []), grid.nj, grid.ni];
        const userAttrs = {
            long_name: first.parameter.longName,
            units: first.parameter.units,
            GRIB_shortName: first.parameter.shortName,
            GRIB_edition: first.edition,
            ...(multiLevel ? {} : { GRIB_level: levelLabel(first.level) }),
        };
        let cached = null;
        const decoded = field => {
            if (cached?.field !== field) cached = { field, values: decodeField(source, field) };
            return cached.values;
        };
        descriptors.push({
            path: `/${name}`,
            name,
            group: '/',
            shape,
            attrs: userAttrs,
            userAttrs,
            dimensions,
            numeric: true,
            textual: false,
            supportsSlice: true,
            // One field per step and level, like a netCDF chunked one map at a time.
            chunks: [1, ...(levelPath ? [1] : []), grid.nj, grid.ni],
            read: ranges => {
                const full = shape.map(size => [0, size]);
                const [tRange, ...rest] = ranges || full;
                const lRange = levelPath ? rest[0] : [0, 1];
                const [yRange, xRange] = levelPath ? rest.slice(1) : rest;
                const rows = yRange[1] - yRange[0];
                const columns = xRange[1] - xRange[0];
                const out = new Float64Array((tRange[1] - tRange[0]) * (lRange[1] - lRange[0]) * rows * columns);
                let at = 0;
                for (let t = tRange[0]; t < tRange[1]; t++) {
                    for (let l = lRange[0]; l < lRange[1]; l++) {
                        const field = table[t][l];
                        if (!field) {
                            out.fill(MISSING, at, at + rows * columns);
                            at += rows * columns;
                            continue;
                        }
                        const values = decoded(field);
                        for (let row = yRange[0]; row < yRange[1]; row++) {
                            const base = row * grid.ni;
                            for (let column = xRange[0]; column < xRange[1]; column++) out[at++] = values[base + column];
                        }
                    }
                }
                return out;
            },
        });
    }
    return {
        storageFormat: editions.length === 1 ? `grib${editions[0]}` : 'grib',
        globalAttrs: { GRIB_edition: editions.join(', '), GRIB_messages: fields.length },
        descriptors,
    };
}
