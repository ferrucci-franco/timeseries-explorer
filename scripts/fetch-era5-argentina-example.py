"""Writes the ERA5 example files over Argentina from real reanalysis data.

Both files hold **real ERA5 values**, read from the NSF NCAR copy of ERA5 on
AWS Open Data (RDA ds633.0, ERA5 converted from GRIB to netCDF4), and are
rewritten in the layout the Copernicus CDS has produced since 2024-09, which is
what a user actually downloads and brings to the app:

    valid_time int64 (seconds since 1970), latitude descending, longitude in
    -180..180, `number` scalar, `expver` string per step, float32 data with a
    NaN fill, zlib + shuffle, one map per chunk.

The window is the cold outbreak of 2-4 August 2024, picked by scanning June,
July and August 2024 over the box for the window where the mean temperature
falls most between its first and its last six hours, in the northern half and
in the southern half at once (comparing the same hours of the day, so the
diurnal cycle cancels out). In those two days the cold air crosses the whole
country: the south loses 5 K and the north 11 K, so every map in the loop
differs from the one before and the front is visible moving north.

    python3 scripts/fetch-era5-argentina-example.py            # both files
    python3 scripts/fetch-era5-argentina-example.py --only demo
    python3 scripts/fetch-era5-argentina-example.py --cache /tmp/era5.npz

Needs network access to nsf-ncar-era5.s3.amazonaws.com and `numpy`, `h5py`,
`fsspec`, `requests`, `netCDF4`. Only the HDF5 chunks the box needs are read
(a few tens of MB), never the 1.1 GB monthly files whole.

Provenance, licence and attribution: see docs/era5-argentina-example.md and
THIRD_PARTY_LICENSES.md. ERA5 is published by Copernicus/ECMWF under
CC-BY-4.0; the netCDF4 copy is the NSF NCAR RDA ds633.0 dataset
(https://doi.org/10.5065/BH6N-5N20).
"""
import argparse
import os
import time

import fsspec
import h5py
import netCDF4 as nc
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..'))

# Argentina, with enough margin to show the coastline and the Andes crest.
LAT_S, LAT_N = -56.0, -21.0
LON_W, LON_E = -74.0, -52.0

# The cold outbreak: 2024-08-02 12 UTC, 48 hourly steps.
MONTH, MONTH_LAST, HOUR0, NSTEPS = '202408', '31', (2 - 1) * 24 + 12, 48
EVENT = 'cold outbreak of 2-4 August 2024'

URL = ('https://nsf-ncar-era5.s3.amazonaws.com/e5.oper.an.sfc/{ym}/'
       'e5.oper.an.sfc.{code}.ll025sc.{ym}0100_{ym}{last}23.nc')

# (RDA file code, dataset in that file, CDS short name, long name, units)
VARIABLES = [
    ('128_167_2t', 'VAR_2T', 't2m', '2 metre temperature', 'K'),
    ('128_168_2d', 'VAR_2D', 'd2m', '2 metre dewpoint temperature', 'K'),
    ('128_165_10u', 'VAR_10U', 'u10', '10 metre U wind component', 'm s**-1'),
    ('128_166_10v', 'VAR_10V', 'v10', '10 metre V wind component', 'm s**-1'),
    ('128_151_msl', 'MSL', 'msl', 'Mean sea level pressure', 'Pa'),
    ('128_164_tcc', 'TCC', 'tcc', 'Total cloud cover', '(0 - 1)'),
]

# The two files: the full example, and the small one the animated guide ships.
FULL = dict(path=os.path.join(ROOT, 'public', 'examples', 'era5-argentina-cold-front.nc'),
            time_stride=1, space_stride=1, nsteps=24, hour_offset=0,
            variables=['t2m', 'd2m', 'u10', 'v10', 'msl', 'tcc'], complevel=4)
DEMO = dict(path=os.path.join(ROOT, 'public', 'examples', 'guide', 'era5_argentina.nc'),
            time_stride=3, space_stride=2, nsteps=48, hour_offset=0,
            variables=['t2m', 'u10', 'v10', 'msl'], complevel=9)

EPOCH_SHIFT = 2208988800  # seconds between 1900-01-01 and 1970-01-01


def read_window(verbose=True, cache=None):
    """Fetch the box for every variable, reading only the chunks it covers."""
    if cache and os.path.exists(cache):
        held = np.load(cache)
        print(f'  (from the cache {cache})')
        return ({short: held[short] for _c, _d, short, _l, _u in VARIABLES},
                dict(lat=held['lat'], lon=held['lon'], hours=held['hours']))
    fs = fsspec.filesystem('http', block_size=4 * 1024 * 1024)
    out, grid = {}, {}
    for code, ds_name, short, _long, _units in VARIABLES:
        started = time.time()
        with fs.open(URL.format(ym=MONTH, last=MONTH_LAST, code=code)) as handle:
            with h5py.File(handle, 'r') as h5:
                lat, lon = h5['latitude'][:], h5['longitude'][:]
                i0 = int(np.searchsorted(-lat, -LAT_N))        # lat runs 90 -> -90
                i1 = int(np.searchsorted(-lat, -LAT_S)) + 1
                j0 = int(np.searchsorted(lon, LON_W % 360.0))   # lon runs 0 -> 359.75
                j1 = int(np.searchsorted(lon, LON_E % 360.0)) + 1
                out[short] = h5[ds_name][HOUR0:HOUR0 + NSTEPS, i0:i1, j0:j1]
                if not grid:
                    grid = dict(lat=lat[i0:i1],
                                # back to the -180..180 the CDS gives for this area
                                lon=((lon[j0:j1] + 180.0) % 360.0) - 180.0,
                                hours=h5['time'][HOUR0:HOUR0 + NSTEPS].astype('i8'))
        if verbose:
            values = out[short]
            print(f'  {short:4s} {values.shape} {np.nanmin(values):10.2f}'
                  f' .. {np.nanmax(values):10.2f} {_units:8s} {time.time() - started:4.1f}s')
    if cache:
        np.savez(cache, **out, **grid)
    return out, grid


def write_cds_like(spec, fields, grid, verbose=True):
    """Write one file in the new-CDS layout, with the real values."""
    t_sel = slice(spec['hour_offset'], spec['hour_offset'] + spec['nsteps'] * spec['time_stride'],
                  spec['time_stride'])
    s = spec['space_stride']
    lat, lon = grid['lat'][::s], grid['lon'][::s]
    hours = grid['hours'][t_sel]
    os.makedirs(os.path.dirname(spec['path']), exist_ok=True)
    ds = nc.Dataset(spec['path'], 'w', format='NETCDF4')
    ds.Conventions = 'CF-1.7'
    ds.institution = 'European Centre for Medium-Range Weather Forecasts'
    ds.source = ('ERA5 reanalysis (Copernicus Climate Change Service / ECMWF), '
                 'netCDF4 copy from NSF NCAR RDA ds633.0, doi:10.5065/BH6N-5N20')
    ds.licence = 'Copernicus products: CC-BY-4.0. Attribution: Copernicus Climate Change Service / ECMWF'
    ds.title = f'ERA5 surface analysis over Argentina, {EVENT}'
    ds.comment = ('Example file for Time Series Explorer: a box over Argentina cut out of the '
                  'global hourly ERA5 surface analysis and rewritten in the layout the '
                  'Copernicus CDS has produced since 2024-09. Values are the published ERA5 '
                  'values, unmodified'
                  + ('' if s == 1 and spec['time_stride'] == 1 else
                     f', subsampled every {s} grid cells and every {spec["time_stride"]} hours')
                  + '. Made by scripts/fetch-era5-argentina-example.py.')
    ds.history = f'{time.strftime("%Y-%m-%d")}: subset and layout conversion by Time Series Explorer'

    ds.createDimension('valid_time', len(hours))
    ds.createDimension('latitude', len(lat))
    ds.createDimension('longitude', len(lon))

    number = ds.createVariable('number', 'i8')
    number.long_name = 'ensemble member numerical id'
    number.units = '1'
    number.standard_name = 'realization'
    number.assignValue(0)

    vt = ds.createVariable('valid_time', 'i8', ('valid_time',))
    vt.long_name = 'time'
    vt.standard_name = 'time'
    vt.units = 'seconds since 1970-01-01'
    vt.calendar = 'proleptic_gregorian'
    vt[:] = hours * 3600 - EPOCH_SHIFT

    la = ds.createVariable('latitude', 'f8', ('latitude',))
    la.units = 'degrees_north'
    la.standard_name = 'latitude'
    la.long_name = 'latitude'
    la[:] = lat

    lo = ds.createVariable('longitude', 'f8', ('longitude',))
    lo.units = 'degrees_east'
    lo.standard_name = 'longitude'
    lo.long_name = 'longitude'
    lo[:] = lon

    expver = ds.createVariable('expver', str, ('valid_time',))
    for index in range(len(hours)):
        expver[index] = '0001'

    for _code, _ds_name, short, long_name, units in VARIABLES:
        if short not in spec['variables']:
            continue
        var = ds.createVariable(short, 'f4', ('valid_time', 'latitude', 'longitude'),
                                zlib=True, complevel=spec['complevel'], shuffle=True,
                                chunksizes=(1, len(lat), len(lon)),
                                fill_value=np.float32('nan'))
        var.long_name = long_name
        var.units = units
        var.coordinates = 'number valid_time latitude longitude expver'
        var[:] = fields[short][t_sel, ::s, ::s]
    stamps = nc.num2date(hours * 3600 - EPOCH_SHIFT, 'seconds since 1970-01-01',
                         calendar='proleptic_gregorian')
    ds.close()
    size = os.path.getsize(spec['path'])
    if verbose:
        print(f'  {os.path.relpath(spec["path"], ROOT)}: {size / 1e6:.2f} MB, '
              f'{len(spec["variables"])} variables, {len(hours)} steps, '
              f'{len(lat)}x{len(lon)} cells '
              f'({abs(lat[1] - lat[0]):.2f} deg), '
              f'{stamps[0]} .. {stamps[-1]} UTC')
    return size


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--only', choices=['full', 'demo'], help='write just one of the two files')
    ap.add_argument('--cache', help='keep (or reuse) the fetched window in this .npz file')
    args = ap.parse_args()
    print(f'Reading ERA5 {MONTH} over Argentina from AWS Open Data '
          f'(hours {HOUR0}..{HOUR0 + NSTEPS - 1} of the month)')
    started = time.time()
    fields, grid = read_window(cache=args.cache)
    print(f'  grid {grid["lat"].size}x{grid["lon"].size}, '
          f'lat {grid["lat"][0]:.2f}..{grid["lat"][-1]:.2f}, '
          f'lon {grid["lon"][0]:.2f}..{grid["lon"][-1]:.2f}, '
          f'{grid["hours"].size} hours, read in {time.time() - started:.0f}s')
    print('Writing:')
    for spec, name in ((FULL, 'full'), (DEMO, 'demo')):
        if args.only in (None, name):
            write_cds_like(spec, fields, grid)


if __name__ == '__main__':
    main()
