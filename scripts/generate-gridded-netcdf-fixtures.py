"""Small gridded netCDF fixtures for the gridded-dataset tests.

They copy the layouts that broke the viewer, at a few KB each:

- era5-like-new-cds.nc        netCDF4 as the Copernicus CDS writes it since 2024:
                              valid_time int64 seconds since 1970, pressure_level
                              float64 decreasing, latitude descending, longitude
                              0..315, float32 data with NaN fill, zlib + shuffle,
                              chunks of one map, `number` scalar and `expver`
                              string.
- era5-like-legacy-cds.nc     netCDF3 64-bit offset as the legacy CDS wrote it:
                              unlimited `time` int32 hours since 1900, int16
                              packed t2m on a 5 x 7 grid. Two record variables
                              and an odd-sized short record is the case netcdfjs
                              misread (it kept the record padding as data).
- era5-like-instant-accum.zip The ZIP the new CDS sends when a request mixes
                              instantaneous and accumulated variables.
- cmip-noleap.nc              netCDF3 classic, `days since 2000-01-01` in the
                              `noleap` calendar.
- cdf5-grid.nc                netCDF3 64-bit data (CDF-5).
- era5-like-time-chunked.nc   the new CDS layout as it comes for a long hourly
                              request: chunks of many steps along time (the
                              CDS writes 2920, four months of hours) by a part
                              of the grid, so one map spans several chunks.

Regenerate with:  python3 scripts/generate-gridded-netcdf-fixtures.py
(needs numpy and netCDF4)
"""
import os
import tempfile
import zipfile

import netCDF4 as nc
import numpy as np

OUT = os.path.join(os.path.dirname(__file__), '..', 'test-files', 'netcdf')


def field(nt, lat, lon, offset=0.0, nlev=None):
    t = np.arange(nt)[:, None, None]
    la = lat[None, :, None]
    lo = lon[None, None, :]
    base = 280.0 + offset + 0.1 * la + 0.01 * lo + t
    if nlev:
        base = np.stack([base - 10.0 * k for k in range(nlev)], axis=1)
    return base.astype('float32')


def new_cds(path, variables, nt=4, levels=None):
    lat = np.array([75.0, 45.0, 15.0, -15.0, -45.0, -75.0])
    lon = np.arange(0.0, 360.0, 45.0)
    ds = nc.Dataset(path, 'w', format='NETCDF4')
    ds.Conventions = 'CF-1.7'
    ds.institution = 'European Centre for Medium-Range Weather Forecasts'
    ds.history = 'Time Series Explorer test fixture (new CDS layout)'
    ds.createDimension('valid_time', nt)
    if levels is not None:
        ds.createDimension('pressure_level', len(levels))
    ds.createDimension('latitude', len(lat))
    ds.createDimension('longitude', len(lon))
    number = ds.createVariable('number', 'i8')
    number.long_name = 'ensemble member numerical id'
    number.units = '1'
    number.assignValue(0)
    vt = ds.createVariable('valid_time', 'i8', ('valid_time',))
    vt.long_name = 'time'
    vt.standard_name = 'time'
    vt.units = 'seconds since 1970-01-01'
    vt.calendar = 'proleptic_gregorian'
    vt[:] = 1704067200 + 3600 * np.arange(nt)
    if levels is not None:
        pl = ds.createVariable('pressure_level', 'f8', ('pressure_level',))
        pl.units = 'hPa'
        pl.long_name = 'pressure'
        pl.standard_name = 'air_pressure'
        pl.positive = 'down'
        pl[:] = levels
    la = ds.createVariable('latitude', 'f8', ('latitude',))
    la.units = 'degrees_north'
    la.standard_name = 'latitude'
    la[:] = lat
    lo = ds.createVariable('longitude', 'f8', ('longitude',))
    lo.units = 'degrees_east'
    lo.standard_name = 'longitude'
    lo[:] = lon
    ex = ds.createVariable('expver', str, ('valid_time',))
    for index in range(nt):
        ex[index] = '0001'
    for name, long_name, units, offset, with_levels in variables:
        dims = ('valid_time', 'pressure_level', 'latitude', 'longitude') if with_levels else ('valid_time', 'latitude', 'longitude')
        chunks = (1, 1, len(lat), len(lon)) if with_levels else (1, len(lat), len(lon))
        var = ds.createVariable(name, 'f4', dims, zlib=True, complevel=1, shuffle=True,
                                chunksizes=chunks, fill_value=np.float32('nan'))
        var.long_name = long_name
        var.units = units
        var.coordinates = 'number valid_time latitude longitude expver'
        data = field(nt, lat, lon, offset, len(levels) if with_levels else None)
        if not with_levels:
            data[0, 0, 0] = np.nan  # one missing cell, so area statistics must skip it
        var[:] = data
    ds.close()


def legacy(path):
    lat = np.array([60.0, 50.0, 40.0, 30.0, 20.0], dtype='f4')
    lon = np.array([-30.0, -20.0, -10.0, 0.0, 10.0, 20.0, 30.0], dtype='f4')
    ds = nc.Dataset(path, 'w', format='NETCDF3_64BIT_OFFSET')
    ds.Conventions = 'CF-1.6'
    ds.createDimension('longitude', len(lon))
    ds.createDimension('latitude', len(lat))
    ds.createDimension('time', None)
    lo = ds.createVariable('longitude', 'f4', ('longitude',))
    lo.units = 'degrees_east'
    lo[:] = lon
    la = ds.createVariable('latitude', 'f4', ('latitude',))
    la.units = 'degrees_north'
    la[:] = lat
    t = ds.createVariable('time', 'i4', ('time',))
    t.units = 'hours since 1900-01-01 00:00:00.0'
    t.calendar = 'gregorian'
    t[:] = 1086000 + np.arange(3)
    data = field(3, lat.astype('f8'), lon.astype('f8'))
    v = ds.createVariable('t2m', 'i2', ('time', 'latitude', 'longitude'), fill_value=np.int16(-32767))
    v.scale_factor = 0.01
    v.add_offset = 280.0
    v.missing_value = np.int16(-32767)
    v.units = 'K'
    v.long_name = '2 metre temperature'
    v.set_auto_maskandscale(False)
    v[:] = np.round((data - 280.0) / 0.01).astype('i2')
    ds.close()


def noleap(path):
    ds = nc.Dataset(path, 'w', format='NETCDF3_CLASSIC')
    ds.createDimension('time', 4)
    ds.createDimension('lat', 3)
    ds.createDimension('lon', 4)
    t = ds.createVariable('time', 'f8', ('time',))
    t.units = 'days since 2000-01-01 00:00:00'
    t.calendar = 'noleap'
    t.axis = 'T'
    # 2000-03-01 is day 59 in noleap (no Feb 29); day 365 is 2001-01-01.
    t[:] = [0.0, 59.0, 365.0, 424.0]
    la = ds.createVariable('lat', 'f8', ('lat',))
    la.units = 'degrees_north'
    la[:] = [-30.0, 0.0, 30.0]
    lo = ds.createVariable('lon', 'f8', ('lon',))
    lo.units = 'degrees_east'
    lo[:] = [0.0, 90.0, 180.0, 270.0]
    v = ds.createVariable('tas', 'f4', ('time', 'lat', 'lon'))
    v.units = 'K'
    v.long_name = 'Near-Surface Air Temperature'
    v[:] = np.arange(4 * 3 * 4, dtype='f4').reshape(4, 3, 4)
    ds.close()


def cdf5(path):
    ds = nc.Dataset(path, 'w', format='NETCDF3_64BIT_DATA')
    ds.createDimension('time', None)
    ds.createDimension('lat', 2)
    ds.createDimension('lon', 3)
    t = ds.createVariable('time', 'i8', ('time',))
    t.units = 'hours since 2020-01-01'
    t[:] = [0, 6]
    la = ds.createVariable('lat', 'f4', ('lat',))
    la.units = 'degrees_north'
    la[:] = [10.0, 20.0]
    lo = ds.createVariable('lon', 'f4', ('lon',))
    lo.units = 'degrees_east'
    lo[:] = [100.0, 110.0, 120.0]
    v = ds.createVariable('pr', 'u2', ('time', 'lat', 'lon'))
    v.units = 'mm'
    v[:] = np.arange(12, dtype='u2').reshape(2, 2, 3) + 60000
    ds.close()


def time_chunked(path, nt=96, chunk=48):
    lat = np.array([75.0, 45.0, 15.0, -15.0, -45.0, -75.0])
    lon = np.arange(0.0, 360.0, 45.0)
    ds = nc.Dataset(path, 'w', format='NETCDF4')
    ds.Conventions = 'CF-1.7'
    ds.history = 'Time Series Explorer test fixture (new CDS layout, chunked along time)'
    ds.createDimension('valid_time', nt)
    ds.createDimension('pressure_level', 1)
    ds.createDimension('latitude', len(lat))
    ds.createDimension('longitude', len(lon))
    t = ds.createVariable('valid_time', 'i8', ('valid_time',))
    t.units = 'seconds since 1970-01-01'
    t.calendar = 'proleptic_gregorian'
    t.standard_name = 'time'
    t[:] = 1704067200 + 3600 * np.arange(nt)
    level = ds.createVariable('pressure_level', 'f8', ('pressure_level',))
    level.units = 'hPa'
    level.standard_name = 'air_pressure'
    level[:] = [850.0]
    la = ds.createVariable('latitude', 'f8', ('latitude',))
    la.units = 'degrees_north'
    la.standard_name = 'latitude'
    la[:] = lat
    lo = ds.createVariable('longitude', 'f8', ('longitude',))
    lo.units = 'degrees_east'
    lo.standard_name = 'longitude'
    lo[:] = lon
    v = ds.createVariable('t', 'f4', ('valid_time', 'pressure_level', 'latitude', 'longitude'),
                          zlib=True, shuffle=True, complevel=1, fill_value=np.float32(np.nan),
                          chunksizes=(chunk, 1, 3, 4))
    v.units = 'K'
    v.long_name = 'Temperature'
    v.standard_name = 'air_temperature'
    v[:] = field(nt, lat, lon)[:, None, :, :]
    ds.close()


def main():
    os.makedirs(OUT, exist_ok=True)
    time_chunked(os.path.join(OUT, 'era5-like-time-chunked.nc'))
    new_cds(os.path.join(OUT, 'era5-like-new-cds.nc'), [
        ('t', 'Temperature', 'K', 0.0, True),
        ('t2m', '2 metre temperature', 'K', 5.0, False),
    ], levels=[850.0, 500.0])
    legacy(os.path.join(OUT, 'era5-like-legacy-cds.nc'))
    noleap(os.path.join(OUT, 'cmip-noleap.nc'))
    cdf5(os.path.join(OUT, 'cdf5-grid.nc'))
    with tempfile.TemporaryDirectory() as tmp:
        instant = os.path.join(tmp, 'data_stream-oper_stepType-instant.nc')
        accum = os.path.join(tmp, 'data_stream-oper_stepType-accum.nc')
        new_cds(instant, [('t2m', '2 metre temperature', 'K', 0.0, False)])
        new_cds(accum, [('tp', 'Total precipitation', 'm', -280.0, False)])
        with zipfile.ZipFile(os.path.join(OUT, 'era5-like-instant-accum.zip'), 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.write(instant, os.path.basename(instant))
            archive.write(accum, os.path.basename(accum))


if __name__ == '__main__':
    main()
