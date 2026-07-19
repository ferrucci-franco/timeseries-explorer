# Time Series Explorer

Frontend web app for visualizing general MATLAB MAT v4-v7.3 arrays, OpenModelica, Dymola, CSV, Parquet, PyPSA netCDF, and small pandas pickle result files.

Created by [Franco Ferrucci](https://github.com/ferrucci-franco). A technical
publication about the application is [in preparation](PUBLICATION.md).
Citation metadata for the software is available in [CITATION.cff](CITATION.cff).

## Versions and local runs

The app is split by runtime capability, not by duplicated source branches:

- **Light Web**: the GitHub Pages/static version. It runs in the browser sandbox and keeps the core viewer features.
- **Web Preview**: the same web app launched with `serve.bat`; useful for checking the GitHub Pages behavior before pushing.
- **Full Desktop**: the Electron wrapper. It reuses the same app code and is the base for Live Update, native local-file features, and very large files.

Use the local server helper for Web Preview:

```powershell
.\serve.bat
```

Then open the URL shown in the terminal, usually:

```text
http://localhost:8000/index.html
```

Live Update is a Full Desktop feature. The local server helper is kept for development and local testing of the web app, and should match the GitHub Pages feature set.

For normal web development without the local file API, use Vite:

```powershell
npm install
npm run dev
```

To run the current Full Desktop wrapper:

```powershell
npm run desktop
```

It builds the web app into `dist/`, starts an Electron-local localhost server, and opens the app as Full Desktop.
On Windows, you can also double-click `start-full-desktop.bat`. The first run installs missing npm dependencies if needed.

To build Windows desktop artifacts:

```powershell
npm run desktop:dist
```

The generated files are written to `desktop-dist/`:

- `Time Series Explorer-<version>-setup-x64.exe`: Windows installer.
- `Time Series Explorer-<version>-portable-x64.exe`: portable executable.

If the repository lives in a synced folder such as OneDrive and Windows locks
`desktop-dist/`, set `OMV_DIST_OUTPUT` to a non-synced directory before running
the same packaging scripts:

```powershell
$env:OMV_DIST_OUTPUT = 'C:\temp\tse-pack-output'
npm run desktop:pack
```

When `OMV_DIST_OUTPUT` is unset, packaging keeps the default `desktop-dist/`
output path.

## Project map

- `index.html`: static shell for the app
- `app.js`: browser entrypoint
- `electron`: Electron wrapper for the Full Desktop runtime
- `serve.bat`: local HTTP server launcher for development/testing
- `package.json`: npm scripts and frontend tooling
- `vite.config.js`: dev/build server configuration
- `public`: files copied as-is into the final build
- `src/app`: top-level application orchestration
- `src/plots`: plot lifecycle, modes, interactions, Plotly integration
- `src/parsers`: eager file parsers for MATLAB/OpenModelica/Dymola `.mat`, `.csv`, PyPSA netCDF, and pandas pickle inputs
- `src/ui`: layout engine and modal helpers
- `src/i18n`: translations and DOM localization
- `src/styles`: split CSS source files
- `docs`: architecture and roadmap notes

## Architecture at a glance

- `viewer-app.js` wires together parsing, layout, i18n, and plot management.
- `PlotManager` owns plot state and Plotly behavior.
- `LayoutManager` owns the split-panel workspace.
- Parsers normalize input files into a common in-memory structure.
- App methods are split by responsibility to reduce context size when editing.

More detail: [docs/architecture.md](docs/architecture.md)

## Production build

Create a production bundle with:

```powershell
npm run build
```

This command builds the published web app only. The GitHub Pages version should not generate or publish the old portable-web download as the main offline app.

If you explicitly need the old portable-web package for development or archival testing:

```powershell
npm run build:portable
```

The published Light Web output is generated in `dist/`. This is the output intended for GitHub Pages.

## Portable/offline build

The portable web package supports two offline modes:

- Basic mode: open `index.html` directly after extracting the zip.
- Local browser mode: run the platform start script (`start-windows.bat`, `start-linux.sh`, or `start-macos.command`) to serve the same app at `http://127.0.0.1`.

The local browser mode bundles the Node runtime from the platform that built the zip, starts a localhost-only server, and opens the browser without requiring users to install Python, Node, npm, or internet access. Live Update belongs to the Full Desktop app.

## License

Time Series Explorer's own source code is licensed under the permissive
[MIT License](LICENSE). It may be used, modified, and redistributed, including
for commercial purposes, provided that the copyright and license notice are
preserved. Third-party components retain their own licenses; the principal
libraries are listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
