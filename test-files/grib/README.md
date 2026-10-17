# GRIB fixtures (map view)

Written by ecCodes itself with `python3 scripts/generate-grib-fixtures.py`
(`pip install eccodes`), asserted by `scripts/test-gridded-dataset.mjs` and
`scripts/e2e-gridded-netcdf.mjs`. The values follow
`280 + offset + 0.1·lat + 0.01·lon + step − 0.01·level(hPa)` on a 5 × 8 global
grid (60 N … 60 S, 0 … 315 E), so a reader can be checked to the packing
precision.

- `era5-grib1-sfc.grib`: GRIB1, `2t` and `msl` at the surface, 4 hourly steps,
  simple packing with a bitmap (the first cell missing).
- `era5-grib2-sfc.grib2`: GRIB2, `2t` at 2 m above ground, simple packing,
  bitmap.
- `era5-grib2-complex.grib2`: GRIB2 complex packing with spatial differencing.
- `era5-grib1-pl.grib`, `era5-grib2-pl.grib2`: temperature (and `u`) on 850
  and 500 hPa.
- `ccsds.grib2`: CCSDS packing, which the reader refuses in words.
