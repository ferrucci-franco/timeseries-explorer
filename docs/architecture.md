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
- `methods/analysis-job-methods.js`
  - how the analyses compute without holding the main thread: the signal of a
    run, and an analysis job given the rows of a range held in memory; see
    [Analysis jobs](#analysis-jobs) below
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
- `analysis-side.js`
  - an analysis' side panel: its own buttons (V/H, hide the time series,
    Reset, Options, status) as the header of its options drawer, rather than
    a bar across the whole panel above the plots
- `methods/dashboard-methods.js`
  - Dashboard mode: the panel's traces as cards with their value (the last
    one read, or the one at the instant of a time slider); a card's unit is
    written into the variable's description and saved with the file

### `src/parsers`

Normalizes input files into a common structure:

- `variables`
- `metadata`
- `tree`

This lets the rest of the app treat MAT and CSV similarly.

### `src/ui`

Reusable UI building blocks outside the main app class.

- `layout-manager.js`
  - recursive split-panel workspace
- `modal.js`
  - custom modal dialogs

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

## Analysis jobs

An analysis of a file in memory used to run its kernel on the main thread, in
one task: the page did not answer, and the computing pill's Cancel could not be
pressed, for as long as the kernel took (`docs/analysis-responsiveness.md` has
the measurements: up to 44 s). Every analysis now computes as an **analysis
job**; the FFT keeps the worker it already had.

- `src/compute/analysis-kernels.js` is the registry of kernels: one entry per
  computation (`histogram:stats`, `heatmap:build`, `profile:build`,
  `integral:compute`, `correlation:pearson`, `fit:curve`, `fit:trend`,
  `fit:pair`, …), each a thin call of the kernel module the analysis always
  used. A kernel is `(job, params) => result`: it reads the job's columns
  (`job.col(name)`), may keep state between calls (`job.state`), and takes and
  returns plain data.
- `src/core/analysis-jobs.js` is the client. `openAnalysisJob({ signal })`
  gives a job; `feedAnalysisJob(job, columns, { start, end })` hands it rows of
  arrays in memory, 2¹⁹ at a time, each chunk a copy that is transferred, with
  a turn of the event loop between chunks; `job.run(kernel, params)` runs a
  kernel on them; `job.close()` ends it.
- The job lives in a compute worker (`src/workers/compute-worker.js`, the Data
  tools' worker script, in workers of its own: the pool's supersede drops a
  result but lets the kernel run on, and a twenty-second fit has to be
  stopped). An abort of the job's signal **terminates the worker**; a job that
  ends hands its worker back, warm, for the next one.
- Where there is no worker (a page opened from `file://` that brought none, a
  Node test), and for a column that is not a typed array (a cropped file's
  values are a plain `Array`, which may hold `null`), the job runs on the
  caller's thread through the same registry. So a result does not depend on
  where it was computed: `scripts/test-analysis-kernels.mjs` compares, bit for
  bit, each kernel called directly, as a job on the caller's thread and as a
  job in the real worker module.
- `src/plots/methods/analysis-job-methods.js` is what the analyses call:
  `_analysisJobSignal(plot)` — the signal of one run's job: the panel's shared
  run signal (`_analysisRunSignal(plot, slot)` in `analysis-busy-methods.js`,
  which a lazy file's queries also use, each analysis in its own slot) in the
  jobs' slot. It is tied to the panel's signal (Cancel aborts it) and aborted
  by the run that replaces it and by `_abortAnalysisJob(plot)`, which every
  `_schedule…Recompute` calls before its debounce; `_analysisTraceScope(trace,
  range)` — the rows of a range as positions in the signal's arrays, not yet
  copied; `_analysisJobOver…` — a job fed those rows.
- A job times its kernels where they run (`kernelMs`, `onKernel`), and
  `_measureAnalysisKernel` projects the automatic preview of a range from that
  time rather than from the clock, which would count the worker's start too.
- The fits (curve fit, trend, 2D fit) return their results synchronously to
  what draws them. With a worker to compute in, a fit of a signal in memory is
  left *pending*, exactly as a lazy file's is, and painted when its job
  answers (`inMemory` on the pending result); without one it is computed on
  the spot, as before.

A new analysis registers its kernel there and runs it through a job: the
kernel then never holds the page, and Cancel works on a file in memory as on a
lazy one.

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
