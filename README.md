# Time Series Explorer

Frontend web app for visualizing OpenModelica, Dymola, and CSV result files.

## Versions and local runs

The app is split by runtime capability, not by duplicated source branches:

- **Light Web**: the GitHub Pages/static version. It runs in the browser sandbox and keeps the core viewer features.
- **Light Local**: the same web app launched with `serve.bat`; it adds the localhost file API used by Live Update.
- **Full Desktop**: the Electron wrapper. It reuses the same app code and is the base for native local-file features.

Use the local server helper for Light Local:

```powershell
.\serve.bat
```

Then open the URL shown in the terminal, usually:

```text
http://localhost:8000/index.html
```

This is also the recommended local workflow for Live Update. When Node is available, `serve.bat` starts the Time Series Explorer local server, which serves the app and exposes the localhost-only file API used to follow growing CSV files by path in browsers such as Firefox.

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

## Project map

- `index.html`: static shell for the app
- `app.js`: browser entrypoint
- `electron`: Electron wrapper for the Full Desktop runtime
- `serve.bat`: local HTTP server launcher for development/use
- `package.json`: npm scripts and frontend tooling
- `vite.config.js`: dev/build server configuration
- `public`: files copied as-is into the final build
- `src/app`: top-level application orchestration
- `src/plots`: plot lifecycle, modes, interactions, Plotly integration
- `src/parsers`: `.mat` and `.csv` parsing
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

More detail: [docs/architecture.md](/c:/Users/ferrucci/OneDrive/UPF/courses/GitHub_Electronics/openmodelica-viewer/docs/architecture.md)

## Production build

Create a production bundle with:

```powershell
npm run build
```

This command now generates the portable download artifacts first, then builds the published web app so `dist/` includes the stand-alone download package.

If you only want the web bundle without regenerating the portable package:

```powershell
npm run build:web
```

The published Light Web output is generated in `dist/`. This is the output intended for GitHub Pages.

## Portable/offline build

The portable package supports two offline modes:

- Basic mode: open `index.html` directly after extracting the zip.
- Local live mode: run the platform start script (`start-windows.bat`, `start-linux.sh`, or `start-macos.command`) to serve the same app at `http://127.0.0.1`.

The local live mode bundles the Node runtime from the platform that built the zip, starts a localhost-only server, opens the browser, and enables live update by local file path without requiring users to install Python, Node, npm, or internet access.
