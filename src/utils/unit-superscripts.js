// Units as people read them: "m s**-1" and "m s-1" are how netCDF files spell
// m s⁻¹ (ERA5 writes the first, CF/UDUNITS the second). Exponents become
// Unicode superscripts, which every label, tooltip, input and CSV header can
// show; nothing else in the string changes.
//
// An explicit power (** or ^) is always one. A bare number after a symbol
// ("s-1", "m2") is only taken for a power after a known unit symbol, so a name
// that happens to end in a digit ("CO2 ppm", "PM10") is left alone.

const SUPERSCRIPT = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹', '-': '⁻', '+': '⁺' };
const superscript = power => [...power].map(char => SUPERSCRIPT[char] ?? char).join('');

const UNIT_SYMBOLS = [
    'kg', 'g', 'mg', 'km', 'm', 'cm', 'mm', 'um', 'µm', 'nm',
    's', 'ms', 'min', 'h', 'hr', 'day', 'd',
    'K', 'Pa', 'hPa', 'kPa', 'W', 'kW', 'J', 'kJ', 'N', 'mol', 'rad', 'sr', 'Hz', 'V', 'A',
    'degree', 'degrees', 'deg',
];
const SYMBOLS = UNIT_SYMBOLS.sort((a, b) => b.length - a.length).map(symbol => symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
const EXPLICIT_POWER = /\s*(?:\*\*|\^)\s*\(?([+-]?\d+)\)?/g;
const IMPLICIT_POWER = new RegExp(`(^|[\\s.·*/(])(${SYMBOLS})([+-]?\\d+)(?=$|[\\s.·*/)])`, 'g');

/**
 * @param {string} units as written in the file
 * @returns {string} the same units with their powers as superscripts
 */
export function formatUnitPowers(units) {
    if (typeof units !== 'string' || !units) return units;
    return units
        .replace(EXPLICIT_POWER, (_, power) => superscript(power))
        .replace(IMPLICIT_POWER, (_, before, symbol, power) => `${before}${symbol}${superscript(power)}`);
}
