# Repeated Timestamps Indicator Design ("Repeated" toggle)

Status: specified, not built. Build after the **Samples** toggle
([sample-markers-design.md](sample-markers-design.md)), which it uses when zoomed in.

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

- A toggle button **Repeated** in the time-series panel toolbar, right after
  **Missing/NaN**.
  - Labels: EN *Repeated*, ES *Repetidos*, FR *Répétés* (other locales follow the
    existing i18n table).
  - Tooltip (EN): *Mark instants where the time axis repeats (several rows at the same
    time).*
- **Off by default.** State `plot.showRepeated`, saved/restored with the session like
  `showMissingData`.
- **Disabled** (with a tooltip saying why) when no file in the panel has a repeat run,
  so the button itself answers "are there any?". The per-file count is known at load
  (see Data).
- Toggling rebuilds the panel keeping the view, same pattern as `_toggleMissingData`.

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
- **Dense view**: when more than half of the pixel columns carry a mark (same rule as
  `_missingViewIsDense`), individual marks carry no information. Draw a faint wash on
  the strip only over the regions that hold repeats, and show the notice *Repeated
  timestamps too dense to resolve here — zoom in for detail* (reuse
  `_setMissingDensityNotice`'s mechanism with its own text).
- Cap: at most one mark per pixel column, so the count is bounded by the plot width.

### Zoomed in (runs are resolved individually)

- One mark per run, at its exact time, hover *×k at this instant* (+ file name).
- A faint thin vertical guide line from the mark down through the plot area, drawn
  below the traces, so the eye finds the matching place on the curve.
- If **Samples** is also on and the trace has dots (both of its conditions hold), the
  repeated samples of that trace get a **ring**: open circle, ≈ 10 px, one fixed
  contrasting colour valid in light and dark themes, drawn over the dot. A burst of
  identical (x, y) is thus visible even though its dots overlap exactly. Hover on the
  sample appends *×k at this instant* — needed because Plotly's hover picks only one of
  several coincident points.

### Marks: rendering

- Marks are markers (e.g. `triangle-down`) in one helper trace per panel, placed on an
  overlaying y axis with fixed range `[0, 1]`, no ticks, no legend entry; the strip is
  the top few pixels of that axis. A trace (not layout shapes) because marks need
  hover. Colour per file when the panel holds several files, else the fixed
  contrasting colour.
- Guide lines are layout shapes (`xref: 'x'`, `yref: 'paper'`, `layer: 'below'`).
- **Risk to handle:** code that maps a Plotly trace index back to `plot.traces` must
  skip the helper trace — the same care the phase-2D fit curves need. Append it after
  all data traces and tag it (e.g. `meta: { role: 'repeated-marks' }`).

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
  column; for an unsorted one, state it in the hover, or disable the toggle as
  Missing/NaN does for unsorted time.
- Zoomed in far enough that the window holds few runs, return the runs themselves
  (`t`, `c`) instead of buckets.
- Cancel/refresh on relayout with a token, like `_refreshLazyMissingBands`.

## Scope

In: time-series panels, Y and Y2, eager and lazy files.

Out, v1: stacked mode (marks are fine, but rings are not — they follow *Samples*, which
is off in stacked mode); time panes of FFT / Histogram / Heatmap / Temporal profile /
Integral.

## Interaction with the collapse tool

The indicator is also the before/after check for *Collapse repeated timestamps*:
the original file shows marks, the collapsed one shows none (button disabled). This is
the comparison point (b) of the bug report wants in the same panel.

## Tests

- Unit: `repeatedTimestampRuns` — runs at the start/end of the vector, NaN breaking a
  run, runs of 2 vs 3+, `REPEATED_MARK_MIN_RUN` filter, agreement with
  `repeatedTimestampSummary` (count and longest run).
- Unit: per-pixel coalescing and the dense rule.
- Unit: the lazy SQL builder and its result reducer.
- Fixture: the collapse-repeated-timestamps test file — marks at zoom out, individual
  marks + rings (with *Samples* on) at zoom in; button disabled on the collapsed result.
- i18n keys present in every locale; session save/restore of `showRepeated`.
