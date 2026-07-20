# Generic netCDF examples

- `generic-timeseries-classic.nc`: netCDF3 Classic time series with a CF time coordinate, scaled values, a fill value, a station dimension, and an intentionally unaligned frequency-domain variable.
- `generic-timeseries-64bit-offset.nc`: the same dataset encoded as netCDF3 64-bit-offset (CDF-2).
- `generic-grouped-netcdf4.netcdf`: grouped netCDF4/HDF5 data with dimension scales, both time-first and time-last matrices, string coordinate labels, global attributes, and an intentionally unaligned variable.

Regenerate both fixtures with:

```powershell
node scripts/generate-generic-netcdf-fixtures.mjs
```

The parser assertions live in `scripts/test-generic-netcdf-parser.mjs` and run through `npm run test:netcdf` and the release suite.
