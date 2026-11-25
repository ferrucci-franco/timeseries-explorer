# Principal third-party software

Time Series Explorer is distributed under the MIT License. Third-party
components remain the property of their respective authors and retain their
own licenses. The principal runtime components are:

| Component | Purpose | License |
| --- | --- | --- |
| [Plotly.js](https://github.com/plotly/plotly.js) | Interactive 2D and 3D plots | MIT |
| [DuckDB](https://github.com/duckdb/duckdb) and [DuckDB-Wasm](https://github.com/duckdb/duckdb-wasm) | Queries and memory-saving access to large tabular files | MIT |
| [SheetJS Community Edition](https://git.sheetjs.com/SheetJS/sheetjs) | Excel and LibreOffice workbook import | Apache-2.0 |
| [h5wasm](https://github.com/usnistgov/h5wasm) | HDF5/MAT v7.3 access in WebAssembly | NIST software notice and bundled HDF5 license terms |
| [netcdfjs](https://github.com/cheminfo/netcdfjs) | netCDF3 parsing in web and desktop runtimes | MIT |
| [fflate](https://github.com/101arrowz/fflate) | ZIP compression and extraction | MIT |
| [pickleparser](https://github.com/ewfian/pickleparser) | pandas/Python pickle parsing | MIT |
| [Electron](https://github.com/electron/electron) | Full Desktop version runtime | MIT |
| [Simple Icons](https://github.com/simple-icons/simple-icons) | Apple and Linux SVG marks in the Desktop download selector | CC0-1.0; third-party trademarks remain with their owners |
| [GoatCounter](https://github.com/arp242/goatcounter) `count.js` | Cookie-free page-view counting in the web version only | ISC (the wider project is EUPL-1.2) |

Build tools and transitive packages are recorded in `package-lock.json`.
Their inclusion does not change the Time Series Explorer license, and their
copyright and license notices must be preserved as required by each package.

This overview is provided for convenience. The license text distributed with
each dependency is authoritative for that component.

## Natural Earth coastlines and borders (`public/geo/natural-earth-*.json`)

Coastline and country-border lines at 1:110m and 1:50m, derived from
[Natural Earth](https://www.naturalearthdata.com/) vector data (public domain)
through the TopoJSON redistribution [world-atlas](https://github.com/topojson/world-atlas)
2.0.2 (ISC license, Copyright 2013-2019 Michael Bostock). Converted to plain
polylines for the gridded netCDF map view.

## ERA5 example data (`public/examples/era5-argentina-*.nc`, `public/examples/guide/era5_argentina.nc`)

Surface fields of the ERA5 reanalysis over Argentina for August 2024,
produced by the [Copernicus Climate Change Service](https://climate.copernicus.eu/)
at ECMWF and published under the Creative Commons Attribution 4.0 licence
(CC-BY-4.0). Read from the NSF NCAR curated netCDF4 copy of ERA5 on AWS Open
Data (Research Data Archive dataset `ds633.0`,
[doi:10.5065/BH6N-5N20](https://doi.org/10.5065/BH6N-5N20)).

> Contains modified Copernicus Climate Change Service information, 2024.
> Neither the European Commission nor ECMWF is responsible for any use of the
> Copernicus information or data it contains.

The modification is packaging only — a box cut out of the global grid,
rewritten in the layout the Copernicus CDS writes, and subsampled for the
smaller of the two files; the values are unchanged. See
`docs/era5-argentina-example.md` and the files' own global attributes.

