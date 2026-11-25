# The ERA5 example over Argentina

Two files of **real ERA5 reanalysis** ship with the app as the example of a
gridded netCDF dataset: a whole country, several variables, and a weather event
worth watching step by step.

| File | Size | Grid | Steps | Variables |
| --- | ---: | --- | ---: | --- |
| `public/examples/era5-argentina-cold-front.nc` | 3.3 MB | 141 × 89 at 0.25° | 24 hourly, 2024-08-02 12 UTC → 2024-08-03 11 UTC | `t2m`, `d2m`, `u10`, `v10`, `msl`, `tcc` |
| `public/examples/guide/era5_argentina.nc` | 0.47 MB | 71 × 45 at 0.5° | 16 three-hourly, 2024-08-02 12 UTC → 2024-08-04 09 UTC | `t2m`, `u10`, `v10`, `msl` |

The box is 21 °S to 56 °S and 74 °W to 52 °W: Argentina whole, with the Andes
crest, the Patagonian coast, the Río de la Plata and the Malvinas/Falklands in
view. A latitude-longitude box cannot hold one country alone, so the edges of
Chile, Uruguay, Paraguay, Bolivia and Brazil come with it, as they do in any
ERA5 request.

## The event

The window is the **cold outbreak of 2-4 August 2024**. June, July and August
2024 were scanned over the box for the 48-hour window whose mean temperature
falls most from its first six hours to its last six hours, in the northern half
(21-32 °S) and the southern half (42-56 °S) at once. Comparing the same hours of
the day cancels the daily cycle, which otherwise wins every time: in the Chaco
the afternoon alone is worth 10 K.

In those two days the cold air crosses the whole country:

| | first 6 h | last 6 h |
| --- | ---: | ---: |
| north (21-32 °S) | 24.7 °C | 13.8 °C |
| south (42-56 °S) | 6.7 °C | 1.6 °C |
| Buenos Aires (34.5 °S, 58.5 °W) | 21.6 °C | 11.0 °C |

So every map in the loop differs from the one before, and the front is visible
moving north — which is the point of an example meant to be animated.

## Where the data comes from

ERA5 is produced by the Copernicus Climate Change Service at ECMWF. The copy
read here is the **NSF NCAR curated ERA5 on AWS Open Data** (RDA `ds633.0`),
ERA5 converted from GRIB to netCDF4 and public without credentials:

```
s3://nsf-ncar-era5/e5.oper.an.sfc/202408/e5.oper.an.sfc.128_167_2t.ll025sc.2024080100_2024083123.nc
```

One file holds one variable for one month of the globe, 0.25°, hourly — 1.1 GB
each. The generator never downloads one: it opens them over HTTPS and reads
only the HDF5 chunks the box covers (a few tens of MB for the six variables,
about 25 seconds in all).

## What was changed, and what was not

**The values are ERA5's own, unmodified.** What changed is the packaging, so
that the file looks like what a user actually downloads and brings to the app:

- the box is cut out of the global grid, and the demo keeps one cell in two and
  one hour in three (`test:era5-example` checks that the two files agree
  exactly on every shared cell: the small one is the big one's cells, not an
  average or a reinterpolation);
- the layout is the one the Copernicus CDS has written since September 2024 —
  `valid_time` int64 in seconds since 1970, `latitude` descending, `number`
  scalar, `expver` per step, float32 with a NaN fill, zlib + shuffle, one map
  per chunk — instead of the RDA layout (`VAR_2T`, one variable per file,
  `time` in hours since 1900);
- longitudes are written in -180..180, as the CDS gives them for this area,
  instead of ERA5's stored 0..360.

The source, the licence and this conversion are recorded in the files' own
global attributes (`source`, `licence`, `comment`, `history`).

## Licence and attribution

ERA5 is published under the **Creative Commons Attribution 4.0** licence
(CC-BY-4.0), which replaced the Licence to use Copernicus Products on 2 July
2025. Redistribution is allowed with attribution and an indication of changes;
both are in the files and in `THIRD_PARTY_LICENSES.md`.

> Contains modified Copernicus Climate Change Service information, 2024.
> Neither the European Commission nor ECMWF is responsible for any use of the
> Copernicus information or data it contains.

Citation of the netCDF4 copy:

> European Centre for Medium-Range Weather Forecasts. 2019, updated monthly.
> ERA5 Reanalysis (0.25 Degree Latitude-Longitude Grid). Research Data Archive
> at the National Center for Atmospheric Research, Computational and
> Information Systems Laboratory. https://doi.org/10.5065/BH6N-5N20

## Regenerating

```
python3 scripts/fetch-era5-argentina-example.py
python3 scripts/fetch-era5-argentina-example.py --only demo
python3 scripts/fetch-era5-argentina-example.py --cache /tmp/era5.npz
```

Needs network access to `nsf-ncar-era5.s3.amazonaws.com` and `numpy`, `h5py`,
`fsspec`, `requests`, `netCDF4`. `--cache` keeps the fetched window in an
`.npz`, so another cut of the same window costs nothing. The window, the box
and the two files' shapes are constants at the top of the script.

## Tests

`npm run test:era5-example` (in the release suite) opens both files with the
app's own gridded engine and checks the layout, the grid, the sizes they ship
under, the values over Buenos Aires, that the cold outbreak is still in the
data, and that the two files agree on every shared cell.
