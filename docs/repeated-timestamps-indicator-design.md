# Repeated Timestamps Indicator Design ("Repeated" toggle)

Status: v1 built for in-memory files. Memory-saving (DuckDB) files are not marked
yet (see "Lazy (DuckDB) files"). Uses the **Samples** toggle
([sample-markers-design.md](sample-markers-design.md)) for the rings when zoomed in.

Where the build departs from the first draft of this spec, the section says so.

Context: bug report on *Collapse repeated timestamps*, point (c): the user has no way to
see *where* a file repeats timestamps, so cannot judge what the collapse tool will do,
nor compare before and after.

## Goal

Show where the time axis holds the same instant on consecutive rows — **at any zoom**,
the way **Missing/NaN** shows gaps and NaN runs at any zoom.

Why a feature of its own, and not part of *Samples*: dots exist only when zoomed in,
while "where are the repeats?" is a question about the whole file, asked precisely when
the user does not yet know where to zoom. Why not part of *Missing/NaN*: a repeated
timestamp is not missing data, it is extra data; mixing them would muddy both the bands
and the "irregular sampling" notice.

## Definition

A **repeat run** is a maximal sequence of ≥ 2 consecutive rows with the same time value.

- Same equality rule as `repeatedTimestampSummary` (`src/utils/repeated-timestamps.js`):
  exact equality on the stored numeric time; a non-finite time breaks a run.
- Applies to **every time-axis kind** (datetime, numeric seconds, elapsed). Note: the
  existing load notice only looks at datetime columns; this indicator does not have
  that restriction.
- A run is described by `{ t, start, length }` (time value, first row index, rows).
- It is a property of the **file's time vector**, not of a variable: all variables of
  one file share the same runs.
- Minimum run length shown: internal flag, default 2 (every repeat).

  ```js
  static REPEATED_MARK_MIN_RUN = 2;   // on PlotManager
  ```

  Consequence to be aware of: Modelica results write every event as a 2-row repeat, so
  on such files the indicator lights up at every event. That is correct (they are
  repeats) and is exactly what a user asking this question wants to see. Raising the
  flag to 3 would match `REPEATED_TIMESTAMP_RUN_NOTICE`.

## UI

- A toggle button **Repeated** in the time-series panel toolbar, after **Samples**
  (order: Missing/NaN, Samples, Repeated).
  - Labels: EN *Repeated*, ES *Repetidos*, FR *Répétés*, IT *Ripetuti*.
  - Tooltip (EN): *Mark instants where the time axis repeats (several rows at the same
    time).*
- **Off by default.** State `plot.showRepeated`, saved/restored with the session like
  `showMissingData`.
- **Disabled** when no file on the panel has a repeat run, with the tooltip *No
  repeated timestamps in the files on this panel* — the button itself answers "are
  there any?". Runs are computed on first need and cached per time array
  (`_repeatedRunsForTimes`), so this costs one O(n) scan per file.
- Toggling rebuilds the panel keeping the view, same pattern as `_toggleMissingData`.
- **Same convention as Samples** for "nothing to draw here": the button stays pressed
  but *waits* (dashed border, `.repeated-waiting`) with the reason in its tooltip —
  too dense here, or memory-saving files only — and a pill with that reason appears
  **once**, for 3 s, after the click that turns the toggle on. Later zooms never bring
  the pill back.

## Presentation

A repeat has zero width in time, so a band (as Missing/NaN draws) has nothing to cover.
Instead, **marks on a thin strip along the top of the plot area** (a "rug"), which never
cover the data.

### Zoomed out (many repeats per pixel)

- Runs are **coalesced per pixel column** of the visible range: one mark per column
  that holds at least one run. Clip to the visible range *before* coalescing, as
  `_adaptiveGapBandShapes` does, so the marks line up with what is on screen.
- Hover on a mark: *12 repeated instants, longest ×4* (and the file name when the panel
  holds several files).
- **Dense view**: when more than half of the columns carry a mark, individual marks
  carry no information. A thin wash on the strip covers the stretches that hold repeats
  (adjacent marked columns merged), and the button waits with *Repeated timestamps too
  dense to resolve here — zoom in for detail* (see UI).
- Columns are 3 px wide (`REPEATED_MARK_COLUMN_PX`): at most one mark per column, so the
  count is bounded by the plot width.

### Zoomed in (runs are resolved individually)

- One mark per run, at its exact time, hover *×k at this instant* (+ file name).
- A faint thin vertical guide line from the mark down through the plot area, drawn
  below the traces, so the eye finds the matching place on the curve — only while there
  are at most `REPEATED_GUIDE_MAX` (10) marks. A logger that repeats every second would
  otherwise put a line on every second, which hides the curve (first value was 40).
- If **Samples** is also on and the trace has dots (both of its conditions hold), the
  repeated samples of that trace get a **ring**: open circle, ≈ 10 px, one fixed
  contrasting colour valid in light and dark themes (symbol `circle-open-dot`, which
  replaces the dot with a ring around a centre dot). A burst of
  identical (x, y) is thus visible even though its dots overlap exactly. Hover on the
  sample appends *×k at this instant* — needed because Plotly's hover picks only one of
  several coincident points.

### Marks: rendering

- **Changed twice from the draft.** The draft had a helper trace; it would have had to
  be skipped by every piece of code that maps Plotly trace indexes back to
  `plot.traces` (hover, cursors, autoscale, export). The first build used layout
  **annotations** (`▼` with `hovertext`) instead — but redrawing ~120 of them cost
  ~230 ms per frame and made panning crawl. Marks are now small **path shapes**: a
  triangle sized in pixels (`xsizemode`/`ysizemode: 'pixel'`) anchored at its instant
  (`xanchor`) and hanging from the top edge (`yref: 'paper'`, `yanchor: 1`).
- Their hover is a small label of our own (`_ensureRepeatedHover`, `.repeated-hover-label`):
  Plotly gives shapes none. It follows the pointer along the top strip and names the
  nearest mark within 7 px.
- **Pan and zoom.** Being anchored in data coordinates, marks, guides and wash follow the
  axis by themselves, so they are recomputed only when the view settles, not on every
  frame of a drag (`_refreshTimeseriesVisuals(..., { live: true })`). Measured on a
  60 000-row logger with ten rows a second, 2 min in view: 229 → 43 ms at settle,
  229 → 31 ms per drag frame (16 ms with the toggle off). With Samples also on, the
  ~1 200 dots and rings cost ~65 ms per drag frame; that is SVG drawing one element per
  point (Samples alone: ~43 ms).
- Colour: magenta (`_repeatedColor`), apart from the amber of Missing/NaN. With several
  files on the panel, a mark from one file takes that file's trace colour and its hover
  names the file(s).
- Guide lines and the dense wash are layout shapes as well. All share `layout.shapes`
  with the Missing/NaN bands, so every place that relayouts the bands appends
  `plot._repeatedShapes`, and the refresh sends both in one relayout.

## Data

### Eager (in-memory) files

- Computed **once per file** over the whole time vector, O(n), and cached on the file.
  `repeatedTimestampSummary` already scans the full column at load; extend the module
  with a sibling that also returns the runs:

  ```js
  repeatedTimestampRuns(values) → { runs: Int32Array(start), lengths: Int32Array, count }
  ```

  Times are read from the time vector at `start` (no copy of the values).
- Visible runs: binary search on run times for the visible range; per-pixel coalescing
  is linear in the visible runs.
- Invalidate the cache when the file's time vector changes (live update / append,
  time-axis transforms that change values).

### Lazy (DuckDB) files

**Not built in v1.** A memory-saving file keeps an overview sample in memory, not its
rows, so its repeats cannot be read there. Such a file is skipped: if it is the only
reason the button could have something to show, the button waits with *Repeated
timestamps are not marked yet for files loaded in memory-saving mode*.

The plan for it stands:

- Same idea as `missing-buckets-sql.js`: one aggregate query over the visible range,
  bucketed at ~one bucket per pixel, returning per bucket the number of repeated
  instants and the longest run:

  ```sql
  WITH r AS (
      SELECT t, COUNT(*) AS c FROM <table>
      WHERE t BETWEEN lo AND hi
      GROUP BY t HAVING COUNT(*) >= <min run>
  )
  SELECT <bucket(t)> AS b, COUNT(*) AS instants, MAX(c) AS longest
  FROM r GROUP BY b
  ```

  Put the builder in a pure module (e.g. `src/data/repeated-buckets-sql.js`) so it is
  unit-testable in Node, as the Missing/NaN one is. Note: `GROUP BY t` counts rows at an
  instant anywhere in the file, not only consecutive ones — identical for a sorted time
  column; for an unsorted one, state it in the hover.
- Zoomed in far enough that the window holds few runs, return the runs themselves
  (`t`, `c`) instead of buckets.
- Cancel/refresh on relayout with a token, like `_refreshLazyMissingBands`.
- The buckets map straight onto `repeatedMarksForView`'s output (one mark per column),
  so the drawing code does not change.

## Scope

In: time-series panels, Y and Y2, in-memory files. Memory-saving files: see above.

Out, v1: stacked mode (marks are fine, but rings are not — they follow *Samples*, which
is off in stacked mode); time panes of FFT / Histogram / Heatmap / Temporal profile /
Integral.

## Interaction with the collapse tool

The indicator is also the before/after check for *Collapse repeated timestamps*:
the original file shows marks, the collapsed one shows none (button disabled). This is
the comparison point (b) of the bug report wants in the same panel.

## Tests

- `npm run test:repeated-marks`: `repeatedTimestampRuns` (edges, NaN ending a run,
  unsorted columns, the minimum run, agreement with `repeatedTimestampSummary`),
  `repeatedMarksForView` (per-column grouping, the dense rule and its wash regions,
  bounded by width, several files), and the panel overlay through the real mixin
  (marks, guides, dense state, availability, rings with runs cut by the window edge).
- `test:mode-toolbar`: the button — placement, disabled with no repeats, waiting states.
- `test:session-state-roundtrip`: `showRepeated` saved and restored.
- `npm run e2e:repeated-marks` (Chromium): a clean file disables the button; numeric
  bursts get one mark each with a working hover, a guide when zoomed in, and rings with
  Samples on; a datetime logger stamped to the second (ten rows a second) is too dense
  zoomed out — wash, waiting button, pill once — and gets one mark per second on the
  date axis when zoomed in, without guide lines.
