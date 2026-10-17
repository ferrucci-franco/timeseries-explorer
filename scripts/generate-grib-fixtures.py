"""GRIB fixtures written by ecCodes itself (pip install eccodes; run
`python3 scripts/generate-grib-fixtures.py`): ERA5-like regular lat/lon fields,
GRIB1 and GRIB2, simple and complex packing, with a bitmap, on pressure levels.
The values follow field(lat, lon, step, level) so a reader can be checked
exactly (to the packing precision)."""
import os, sys, numpy as np, eccodes as ec

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test-files", "grib")

def field(lat, lon, step, level=0, offset=0):
    return 280 + offset + 0.1 * lat + 0.01 * lon + step - 0.01 * level

def write(path, edition, packing, params, steps, levels, lat, lon, missing=False, date=20240101):
    with open(os.path.join(OUT, path), 'wb') as out:
        for step in range(steps):
            for short, level_type, level, offset in [(p, lt, lv, off) for (p, lt, off) in params for lv in (levels if lt == 'isobaricInhPa' else [0])]:
                sample = 'regular_ll_sfc_grib1' if edition == 1 else 'regular_ll_sfc_grib2'
                h = ec.codes_grib_new_from_samples(sample)
                ec.codes_set(h, 'Ni', len(lon)); ec.codes_set(h, 'Nj', len(lat))
                ec.codes_set(h, 'latitudeOfFirstGridPointInDegrees', float(lat[0]))
                ec.codes_set(h, 'latitudeOfLastGridPointInDegrees', float(lat[-1]))
                ec.codes_set(h, 'longitudeOfFirstGridPointInDegrees', float(lon[0]))
                ec.codes_set(h, 'longitudeOfLastGridPointInDegrees', float(lon[-1]))
                ec.codes_set(h, 'iDirectionIncrementInDegrees', float(abs(lon[1] - lon[0])))
                ec.codes_set(h, 'jDirectionIncrementInDegrees', float(abs(lat[1] - lat[0])))
                ec.codes_set(h, 'centre', 'ecmf')
                ec.codes_set(h, 'dataDate', date); ec.codes_set(h, 'dataTime', step * 100 % 2400)
                if step >= 24: ec.codes_set(h, 'dataDate', date + step // 24)
                if level_type == 'isobaricInhPa' or edition == 1: ec.codes_set(h, 'typeOfLevel', level_type)
                ec.codes_set(h, 'shortName', short)
                if level_type == 'isobaricInhPa': ec.codes_set(h, 'level', level)
                ec.codes_set(h, 'bitsPerValue', 16)
                values = np.array([[field(la, lo, step, level, offset) for lo in lon] for la in lat]).ravel()
                if missing:
                    ec.codes_set(h, 'bitmapPresent', 1); ec.codes_set(h, 'missingValue', 9999)
                    values[0] = 9999  # first cell missing
                if packing != 'grid_simple': ec.codes_set(h, 'packingType', packing)
                ec.codes_set_values(h, values)
                ec.codes_write(h, out); ec.codes_release(h)

lat = np.arange(60, -61, -30.0)          # 60..-60 descending, 5 rows
lon = np.arange(0, 360, 45.0)            # 0..315, 8 columns (global, 0..360)
write('era5-grib1-sfc.grib', 1, 'grid_simple', [('2t', 'surface', 5), ('msl', 'surface', 100000)], 4, [], lat, lon, missing=True)
write('era5-grib2-sfc.grib2', 2, 'grid_simple', [('2t', 'surface', 5)], 4, [], lat, lon, missing=True)
write('era5-grib2-complex.grib2', 2, 'grid_complex_spatial_differencing', [('2t', 'surface', 5)], 3, [], lat, lon)
write('era5-grib1-pl.grib', 1, 'grid_simple', [('t', 'isobaricInhPa', 0)], 3, [850, 500], lat, lon)
write('era5-grib2-pl.grib2', 2, 'grid_simple', [('t', 'isobaricInhPa', 0), ('u', 'isobaricInhPa', 10)], 2, [850, 500], lat, lon)
# A message ecCodes packs with CCSDS, which the reader refuses in words.
h = ec.codes_grib_new_from_samples('regular_ll_sfc_grib2')
ec.codes_set(h, 'Ni', len(lon)); ec.codes_set(h, 'Nj', len(lat))
ec.codes_set(h, 'latitudeOfFirstGridPointInDegrees', 60.0); ec.codes_set(h, 'latitudeOfLastGridPointInDegrees', -60.0)
ec.codes_set(h, 'longitudeOfFirstGridPointInDegrees', 0.0); ec.codes_set(h, 'longitudeOfLastGridPointInDegrees', 315.0)
ec.codes_set(h, 'iDirectionIncrementInDegrees', 45.0); ec.codes_set(h, 'jDirectionIncrementInDegrees', 30.0)
ec.codes_set(h, 'shortName', '2t'); ec.codes_set(h, 'packingType', 'grid_ccsds')
ec.codes_set_values(h, np.array([[field(la, lo, 0) for lo in lon] for la in lat]).ravel())
with open(os.path.join(OUT, 'ccsds.grib2'), 'wb') as out:
    ec.codes_write(h, out)
ec.codes_release(h)
print('ok')
