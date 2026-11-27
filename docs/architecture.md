# Architecture Notes

## Entry flow

1. `index.html` loads `app.js`.
2. `app.js` instantiates `OpenModelicaViewer` from `src/app/viewer-app.js`.
3. `OpenModelicaViewer` composes:
   - `MatParser`
   - `CsvParser`
   - `LayoutManager`
   - `PlotManager`
   - `i18n`

## Folder roles

### `src/app`

Owns top-level app orchestration and browser-facing workflows.

- `viewer-app.js`
  - main application class
  - shared state container for files, language, theme, and UI workflow
- `constants.js`
  - app-level constants and example definitions
- `methods/file-methods.js`
  - file load/reload/remove/transform logic
- `methods/ui-methods.js`
  - event listeners, examples, help, drag/drop, sidebar resize
- `methods/derived-methods.js`
  - derived-variable parser, evaluator, autocomplete
- `methods/tree-methods.js`
  - variable-tree rendering and selection behavior
- `methods/session-methods.js`
  - saved views (JSON) and projects (ZIP); matching a view's files to the
    open ones, and the dialog (`src/ui/session-file-remap-dialog.js`) that
    lets another open file stand in for one the view was saved with
- `methods/tab-methods.js`
  - tabs (web and Full Desktop): only the tab on screen has panels; the others are kept
    as a saved view keeps them (layout tree + plot sessions) and put back
    through the same restore code
- `version-check.js`, `methods/version-check-methods.js`
  - the web app moving itself onto a newer deploy (#374): see
    [Web updates](#web-updates) below

### `src/plots`

Owns plot state and every Plotly-driven behavior.

- `plot-manager.js`
  - main plot state owner
  - plot lifecycle
  - public plot API used by the app
- `methods/data-methods.js`
  - transforms, downsampling, trace and layout builders
- `methods/state-methods.js`
  - state animation mode
- `methods/interaction-methods.js`
  - hover sync, cursors, 3D controls, toolbar actions
- `methods/analysis-range-methods.js`
  - the range section every analysis shows (Full / Selection, and the two
    bounds with their sliders): one builder and one sync, so a new analysis
    gets the block rather than a copy of it
  - and one refresh, `_syncAnalysisRangeControls`, for when the range changes
    with nobody touching the controls — the automatic preview widened back to
    the whole file once the measured pass proves it affordable
    (`_reconsiderAutoLimitedRange`). Without it the block describes the range
    that was cut while the panel draws the whole file (#387). One line per
    analysis; `scripts/test-analysis-range.mjs` fails for a new analysis that
    does not add its own
  - a band drawn over the time pane asks `div._fullLayout` first: that is
    Plotly still owning the div, and a relayout on one it has already torn
    down — the panel rebuilt under a range press, a result arriving late —
    throws inside Plotly (#399). The same test fails for an updater that
    does not ask
- `methods/analysis-fit-methods.js`
  - whose the toolbar's Fit X / Fit Y / Fit all are: the time series while it
    is on screen, and the analysis' own pane when it is folded away — which
    is also why that pane carries three floating buttons of its own while
    both are shown
- `methods/trace-style-methods.js` (and `trace-style.js`, its pure part)
  - a trace's colour and its place among the plot's traces, from the legend's
    context menu (built once, in `_showLegendTraceMenu`, for every mode) and
    from a trace's row on the phone; both live in the trace state, so every
    analysis drawn from the series, a saved view and an export follow
- `methods/analysis-busy-methods.js`
  - the computing pill every analysis shows, its Cancel, and the settings
    Cancel puts back; `_analysisPool()` is where an analysis asks for workers
- `../utils/axis-ticks.js`
  - the tick thinning Plotly does for an automatic axis but not for one given
    its own `tickvals`/`ticktext`. An axis that names its own ticks — the
    Heatmap's rows and dates, the Temporal profile's days and months — draws
    every label it is handed, however little room there is, and they run into
    each other on a short subplot or a narrow panel. `fitAxisTicks` keeps
    every nth so what is drawn fits what there is to draw it in. Any new axis
    with `tickmode: 'array'` goes through it, or writes a small bounded list
    of its own (`_durationTickValues`, `periodTickValues`);
    `scripts/test-axis-ticks.mjs` fails for one that does neither
- `analysis-side.js`
  - an analysis' side panel: its own buttons (V/H, hide the time series,
    Reset, Options, status) as the header of its options drawer, rather than
    a bar across the whole panel above the plots
- `methods/dashboard-methods.js`
  - Dashboard mode: the panel's traces as cards with their value (the last
    one read, or the one at the instant of a time slider); a card's unit is
    written into the variable's description and saved with the file

### Analysis jobs

An analysis of a file held in memory computes off the main thread, so the page
— and the Cancel button — stay usable while it does.

- `src/core/analysis-pool.js` — the workers: the Data Tools' worker script
  (`src/workers/compute-worker.js`) in a pool of its own, an
  `ExclusiveWorkerPool` (`src/core/worker-pool.js`). One task per worker; a
  task whose `AbortSignal` fires while it runs has its worker terminated,
  which is the only way to stop synchronous work, and the next task starts a
  fresh one. The Data Tools' `WorkerPool` instead lets a stale task finish and
  drops its result, which suits kernels that take milliseconds.
- `src/compute/analysis/*.js` — each analysis' kernel as one function of plain
  data. The worker's `analysis:*` op and the main thread call the same
  function, so the results are the same bits
  (`scripts/test-analysis-jobs.mjs`).
- In the panel, an in-memory result that is computed on the worker arrives the
  way a lazy file's does: the previous result stays drawn, the pill shows, the
  run's signal stops it, Cancel puts the settings back. A range of few rows
  (`ANALYSIS_INLINE_ROWS`) is computed where it is, and so is everything where
  workers cannot start (Node, a page opened from `file://` without the
  portable build's bundled workers): `_analysisPool()` returns null and the
  same function runs on the main thread.
- The rows a job needs are copied once for it, a block at a time
  (`_analysisRowsForWorker`), and their buffers handed over.
- `_analysisKernelOnRows` is the one place a kernel over in-memory rows is
  run from: a worker job when the rows are many, the function itself
  otherwise; `_analysisSpan` finds the rows of a range without copying them.
- A lazy file's fit with no SQL form uses the same ops: its rows are read as a
  stream and handed over in the chunks they arrive in
  (`_collectLazyFitRows`, `_lazyFitJob`), and `analysis:joined` joins them in
  the worker before running the kernel.
- Every analysis computes this way for a file in memory: Curve fit, Trend,
  Histogram, Heatmap, Temporal profile and Integral on a time series; Curve
  fit and Correlation on a 2D plot (the `analysis:*` ops of the worker). The
  FFT has its own worker. A new analysis does the same, and is added to
  `scripts/e2e-analysis-cancel-memory.mjs` and
  `scripts/test-analysis-jobs.mjs`.

### `src/parsers`

Normalizes input files into a common structure:

- `variables`
- `metadata`
- `tree`

This lets the rest of the app treat MAT and CSV similarly.

A simulation result (`.mat`, MAT v4 trajectory) past its full-load limit is not
parsed whole: `mat-v4-stream.js` reads it by parts — a "columnar reader" — and
`src/data/columnar-ingest.js` copies it into tables of the DuckDB engine, adopted
as a memory-saving (lazy) dataset with the same three members plus `_duckdb`. A
reader of another format that gives the same shape is opened lazily by the same
ingest (`docs/any-size-files.md`, "resultados `.mat` en lazy").

### `src/ui`

Reusable UI building blocks outside the main app class.

- `layout-manager.js`
  - recursive split-panel workspace
- `modal.js`
  - custom modal dialogs
- `app-fullscreen.js`
  - the app's own full screen (the top bar's screen button, and F11 where the
    browser lets a page take it): the page's Fullscreen API, so the top edge
    shows no browser bar, and an amber pill there to leave it. The one piece
    ported from the owner's other apps; texts in `translations.js`, styles in
    `src/styles/base.css`

### `src/i18n`

- `index.js`
  - active language and DOM translation updates
- `translations.js`
  - all translation strings

### `src/styles`

Split CSS source by concern:

- `base.css`
- `sidebar.css`
- `content.css`
- `overlays.css`
- `index.css`

## Web updates

GitHub Pages serves every file, `index.html` included, with
`Cache-Control: max-age=600`, so after a deploy a browser can keep starting
the old build for a while. The build therefore writes its commit to
`dist/version.json` (`{ "sha", "date" }`, a small plugin in `vite.config.js`;
the dev server answers the same path with its own build). On start, and when
the tab comes back into view (at most once every 15 minutes), the app fetches
it with `cache: 'no-store'` and a throwaway query, and compares it with its
own `__GIT_SHA__`:

- same build, or no answer (offline, a 404): nothing happens;
- a different build and nothing open: the page loads again at its own address
  plus `?build=<sha>`. That address is in no cache, the browser's or the CDN's,
  so the new `index.html` comes back for certain, where a plain
  `location.reload()` could get the cached old one. The new page removes the
  query from the address bar;
- a different build with files open (or a dialog, or a load in progress): a
  notice offers the reload, and says it closes the open files.

A reload is recorded in `sessionStorage` before it starts. If the page that
comes back is still the old build, the server is still handing it out, and the
app does not reload again for that build for 30 minutes: never a loop. The
check is off in Full Desktop (it updates through its releases), in the guide's
frame, on `file://` and in a build without a commit. The decisions are in
`src/app/version-check.js` (`npm run test:version-check`); the browser side is
`npm run e2e:version-check`.

## Design intent

The structure is optimized for:

- smaller files with narrower responsibility
- easier human maintenance
- smaller context windows for coding agents
- safer refactors than the original monolithic files

## Editing guidance

- If the issue is about file loading, start in `src/app/methods/file-methods.js`.
- If it is about panel layout or split behavior, start in `src/ui/layout-manager.js`.
- If it is about traces, axes, cursors, hover, or Plotly behavior, start in `src/plots`.
- If it is about labels or translations, start in `src/i18n/translations.js`.
- If it is about tree rendering or sidebar variable selection, start in `src/app/methods/tree-methods.js`.
