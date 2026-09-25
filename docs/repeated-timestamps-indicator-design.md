# Repeated Timestamps Indicator Design ("Repeated" toggle)

Status: v1 built for in-memory files. Memory-saving (DuckDB) files are not marked
yet (see "Lazy (DuckDB) files"). Turns the **Samples** toggle
([sample-markers-design.md](sample-markers-design.md)) on with it, for the rings when
zoomed in.

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

> Since the Marks menu ([marks-menu-nan-gaps-design.md](marks-menu-nan-gaps-design.md)),
> Repeated is an item of the **Marks** dropdown rather than a toolbar button, and
> Missing/NaN is split into **NaN/Inf** (a strip under the Repeated strip) and **Gaps**.
> The disabled and waiting states described below carry over to the item.

- A toggle button **Repeated** in the time-series panel toolbar, after **Samples**
  (order: Missing/NaN, Samples, Repeated).
  - Labels: EN *Repeated*, ES *Repetidos*, FR *Répétés*, IT *Ripetuti*.
  - Tooltip (EN): *Mark instants where the time axis repeats (several rows at the same
    time).*
- **Off by default.** State `plot.showRepeated`, saved/restored with the session like
  `showMissingData`.
- **Turning it on turns Samples on** (changed after use, see "Presentation"), since
  zoomed in the repeats are shown on the Samples dots. Turning Repeated off turns
  Samples off again — but only if Repeated is what turned it on and the user has not
  touched Samples since (`plot._samplesAutoOn`). In a stacked panel Samples stays off.
- **Disabled** when no file on the panel has a repeat run, with the tooltip *No
  repeated timestamps in the files on this panel* — the button itself answers "are
  there any?". Runs are computed on first need and cached per time array
  (`_repeatedRunsForTimes`), so this costs one O(n) scan per file.
- Toggling rebuilds the panel keeping the view, same pattern as `_toggleMissingData`.
- Same convention as Samples when nothing can be drawn: the button stays pressed but
  *waits* (dashed border, `.repeated-waiting`) with the reason in its tooltip, and a
  pill says it once, for 3 s, after the click. For Repeated that only happens when
  memory-saving files are all that could hold repeats. "Too far out to see the rings"
  is the Samples button's to say.

## Presentation

**Changed after use.** The first build drew a triangle per repeat on the top strip,
guide lines down to the curve when zoomed in, a separate wash when too dense, and rings
on the Samples dots. It worked, but it was a lot of marks for one fact, and the
triangles made panning slow. Simplified to two presentations, by zoom:

### Zoomed in: rings on the dots

Where a trace draws its Samples dots, each repeated sample keeps its filled dot in the
trace colour and gets a **red ring** around it (larger marker, 2 px red border). The
hover of the sample says *×k at this instant* — needed because Plotly's hover picks
only one of several coincident points. Runs are counted in the whole column, so a run
cut by the edge of the view still reads its full length. No strip is drawn for a file
whose trace shows its dots.

### Zoomed out: red bars on the top strip

Where no dots can be drawn, the repeats show as **red bars** on a thin strip along the
top of the plot area (`y0: 0.985` to `1` in paper coordinates):

- Runs are grouped by 3 px screen column (`REPEATED_MARK_COLUMN_PX`) of the visible
  range, and adjacent marked columns merge into one bar. So what is drawn is bounded by
  the plot width, whatever the file holds: a single repeat is a thin bar, a logger that
  repeats every second is one bar across.
- Hover on the strip: *12 repeated instants, longest ×4* for the column under the
  pointer (plus the file names when the panel holds several files). Plotly gives shapes
  no hover, so this is a small label of our own (`_ensureRepeatedHover`,
  `.repeated-hover-label`) that names the nearest marked column within 7 px.

### Rendering and cost

- Bars are layout shapes and share `layout.shapes` with the Missing/NaN bands; every
  place that relayouts the bands appends `plot._repeatedShapes`, and the refresh sends
  both in one relayout.
- Being anchored in data coordinates, bars follow a pan by themselves, so they are
  recomputed only when the view settles, not on every frame of a drag
  (`_refreshTimeseriesVisuals(..., { live: true })`).
- History: marks were first annotations (`▼` with `hovertext`). Redrawing ~120 of them
  cost ~230 ms per frame on a 60 000-row logger; pixel-sized path shapes brought that to
  ~31 ms per drag frame, and the bars replace them now. With Samples on, the cost that
  remains is the dots themselves (SVG, one element per point).
- Colour: red (`_repeatedColor`), apart from the amber of Missing/NaN.

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
  `repeatedMarksForView` (per-column grouping, bars merging adjacent columns, bounded by
  width, several files), and the panel overlay through the real mixin (bars, hover
  marks, no bars for a file showing its dots, availability, rings with runs cut by the
  window edge).
- `test:mode-toolbar`: the button — placement, disabled with no repeats, waiting state.
- `test:session-state-roundtrip`: `showRepeated` saved and restored.
- `npm run e2e:repeated-marks` (Chromium): a clean file disables the button; numeric
  bursts — Repeated turns Samples on, a bar per burst with a working hover zoomed out,
  red rings and no bars zoomed in, and turning Repeated off turns that Samples off (but
  leaves a Samples the user switched on); a datetime logger stamped to the second is
  one bar zoomed out and every row ringed zoomed in.
