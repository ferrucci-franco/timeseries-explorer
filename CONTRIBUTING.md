# Contributing

Contributions of every size are welcome: bug reports, questions, example files,
documentation fixes and code.

## Reporting problems

Open an issue at
<https://github.com/ferrucci-franco/timeseries-explorer/issues>, or use the
app's Feedback command (see [docs/feedback.md](docs/feedback.md)), which files
one for you from inside the app — screenshots included, and with the app
version and your browser already filled in. It needs no GitHub account.

A useful report says which edition you used (web, Full Desktop or portable),
what you did, what you expected and what happened instead. If a particular file
triggers the problem, attach it or a reduced version of it only if its contents
can be shared publicly; otherwise describe its format and size.

## Asking for help

Questions about how to do something are welcome as issues too; there is no
separate forum. Check the in-app Help first: it documents every feature and
the file formats in detail. If you have no GitHub account, the Feedback command
sends the question for you.

## Proposing changes

1. For anything larger than a small fix, open an issue first to discuss the
   approach.
2. Fork the repository and create a branch from `main`.
3. Make the change, following the editing rules and checks below, and add or
   update tests in `scripts/test-*.mjs` when behaviour changes.
4. Run `npm run test:release` (and `npm run e2e` for plotting or UI changes).
5. Open a pull request describing what changed and why. CI runs the full test
   suite and a production build on every pull request.

## Local run

Start the local server:

```powershell
.\serve.bat
```

Open the URL shown in the terminal.

Alternative Vite workflow:

```powershell
npm install
npm run dev
```

## Where to change things

### File loading, reload, transforms

Start in:

- `src/app/methods/file-methods.js`

### Top bar, examples, help, drag-and-drop, sidebar resize

Start in:

- `src/app/methods/ui-methods.js`
- `src/ui/app-fullscreen.js` (the full-screen button and its exit pill)
- `src/styles/base.css` (`--top-bar-height`, `--top-bar-control-height`; a
  switch that stays pressed carries `aria-pressed="true"`, which is what
  colours it)

### Derived variables and formula autocomplete

Start in:

- `src/app/methods/derived-methods.js`
- `src/app/methods/compact-derived-methods.js` (the phone layout's editor)

### Data tools

Start in:

- `src/app/methods/data-tools-methods.js` (and the tool modules beside it)
- `src/app/methods/compact-tools-methods.js` (the phone layout's pages)

### Variable tree, selection, sidebar tree rendering

Start in:

- `src/app/methods/tree-methods.js`

### Plot logic, Plotly behavior, cursors, hover, 3D controls

Start in:

- `src/plots/plot-manager.js`
- `src/plots/methods/data-methods.js`
- `src/plots/methods/state-methods.js`
- `src/plots/methods/interaction-methods.js`

### Layout split panels

Start in:

- `src/ui/layout-manager.js`

### Modal dialogs

Start in:

- `src/ui/modal.js`

### Parsing `.mat` and `.csv`

Start in:

- `src/parsers/mat-parser.js`
- `src/parsers/mat-v4-stream.js`, `src/parsers/netcdf-columns.js` and
  `src/data/columnar-ingest.js` (a simulation result or a netCDF past its
  limit, read by parts into a memory-saving dataset)
- `src/parsers/csv-parser.js`

### Translations

Start in:

- `src/i18n/translations.js`

### Styling

Start in:

- `src/styles/base.css`
- `src/styles/sidebar.css`
- `src/styles/content.css`
- `src/styles/overlays.css`

## Editing rules for this repo

- Prefer small, localized changes.
- Keep logic in `src/`; avoid growing `app.js`.
- Treat `app.js` as the browser entrypoint only.
- Keep translation keys centralized in `src/i18n/translations.js`.
- If a file starts getting too large, split by responsibility rather than by arbitrary line count.

### New analyses and data tools must work in memory-saving (lazy) mode

A large file can be opened in memory-saving mode: it stays in DuckDB-WASM and
only a decimated overview is held in memory. Every analysis, data tool and
export must give the same result there as for a file loaded in memory, over
every row in its range, never over the overview. When you add or change one:

- read the file, not the overview: SQL in `src/data/duckdb-source.js`, or a
  chunked stream (`streamColumns`, `src/data/column-stream.js`) through a kernel
  that accumulates chunk by chunk (for several passes, `src/utils/fit-passes.js`,
  or `definiteIntegralPasses` in `src/compute/kernels/definite-integral.js`);
- run the same kernel code on both paths, so the results match;
- do not cap or sample silently; prefer streaming past a limit, and if a gap
  remains, say so in the UI and record it in `docs/any-size-files.md`;
- show progress and allow cancelling when it takes time;
- add a parity test on a real DuckDB-WASM engine, like
  `scripts/test-lazy-histogram.mjs` or `scripts/test-lazy-curve-fit.mjs`.

`CLAUDE.md` states the same rule for Claude Code sessions.

### Every analysis shows a computing pill with a Cancel button

While an analysis recomputes, the result already drawn stays on screen and can
still be explored. A pill over it says the analysis is calculating, and its
**Cancel** button stops the calculation and keeps what is shown, with the
settings it was computed with put back in the options panel. A new analysis
does the same:

- show the shared pill (`_setAnalysisComputing` in
  `src/plots/methods/analysis-busy-methods.js`);
- pass `_analysisSignal(plot)` to its DuckDB queries and streams — or, where
  a newer run supersedes the one in flight, a run signal tied to it
  (`_analysisRunSignal(plot, slot)`), aborted from the analysis' schedule
  (`_abortAnalysisRun`), as the FFT, the heatmap, the temporal profile, the
  pair correlation and the integral do;
- register its pane, its tokens and where its settings live there;
- compute off the main thread for a file in memory too: its kernel as a
  function of plain data, run through `_analysisKernelOnRows` (a job on the
  compute worker when the rows are many), so the page and Cancel stay usable;
- extend `scripts/e2e-analysis-cancel.mjs` (lazy files) and
  `scripts/e2e-analysis-cancel-memory.mjs` and `scripts/test-analysis-jobs.mjs`
  (files in memory).
- list it in `scripts/bench-analysis-responsiveness.mjs`: `npm run
  e2e:analysis-responsive` fails when an action on an analysis runs a
  computation task of more than 250 ms, and when the menus offer an analysis
  it does not measure.

`CLAUDE.md` has the details.

## Sanity checks after changes

At minimum:

1. Run `.\serve.bat`
2. Open the app in the browser
3. Check browser console for errors
4. Smoke test the affected feature

Recommended smoke tests:

1. Load a `.mat` or `.csv` file
2. Drag variables to a panel
3. Change plot mode
4. Toggle theme and language
5. Open help or example menu if the change touched UI behavior

## Automated tests

- `npm run test:release` runs the offline unit suite (every `test:*` script). It
  runs the code against hand-made stubs and needs no browser.
- `npm run e2e` drives the real app in Chromium through Playwright. It covers
  what the stubs cannot show: Plotly's own behaviour and a browser clock in a
  time zone other than UTC (the A|B cursors on a date axis, #176). Install the
  browser once with `npx playwright install chromium`.
  Every one of those scripts imports `scripts/support/e2e-navigation-log.mjs`
  for its effect: it prints nothing while a run goes well, and names any
  navigation the script did not ask for — with the address, so a `?build=` one
  reads as the version check and the same address as a reload — plus the
  reason the page gave for it and a renderer that crashed. A page lost in the
  middle of a check used to leave nothing to go on (#394). A new e2e script
  wants that import line too, and `npm run e2e:navigation-log` is what keeps
  the helper honest.

CI runs both on every pull request and on every push to `main`.

## Build check

Before publishing:

```powershell
npm run build
```

This builds the published web app into `dist/` (the same as `npm run build:web`). The stand-alone portable package is a separate, explicit step: `npm run build:portable`.

## Related docs

- `README.md`
- `docs/README.md` (index of the documentation)
- `docs/architecture.md`
- `docs/pro-roadmap.md`
