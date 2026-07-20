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
| [fflate](https://github.com/101arrowz/fflate) | ZIP compression and extraction | MIT |
| [pickleparser](https://github.com/ewfian/pickleparser) | pandas/Python pickle parsing | MIT |
| [Electron](https://github.com/electron/electron) | Full Desktop version runtime | MIT |
| [Simple Icons](https://github.com/simple-icons/simple-icons) | Apple and Linux SVG marks in the Desktop download selector | CC0-1.0; third-party trademarks remain with their owners |

Build tools and transitive packages are recorded in `package-lock.json`.
Their inclusion does not change the Time Series Explorer license, and their
copyright and license notices must be preserved as required by each package.

This overview is provided for convenience. The license text distributed with
each dependency is authoritative for that component.
