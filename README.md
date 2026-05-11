# OpenModelica Viewer

Frontend web app for visualizing OpenModelica, Dymola, and CSV result files.

## Run locally

Use the local server helper:

```powershell
.\serve.bat
```

Then open the URL shown in the terminal, usually:

```text
http://localhost:8000/index.html
```

Or use Vite:

```powershell
npm install
npm run dev
```

## Project map

- `index.html`: static shell for the app
- `app.js`: browser entrypoint
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

The published output is generated in `dist/`.
