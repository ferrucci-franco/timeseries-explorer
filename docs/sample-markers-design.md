# Sample Markers Design ("Samples" toggle)

Status: specified, not built.

Context: bug report on *Collapse repeated timestamps*. Points (a)–(c) of that report
(the tool writes every variable, "Create and plot" opens a new panel, no way to see
where the repeats are) are tracked separately. This document specifies point (d), the
prerequisite: a way to see every real sample as a dot, so that repeated timestamps —
and sampling in general — can be read straight off the time-series panel.

## Goal

A drawn line says nothing about where the data is. Between two samples the line is
interpolation; at a repeated timestamp it is a vertical segment that looks exactly like
a steep edge. Drawing each sample as a dot makes both visible:

- where the samples are, and how dense they are;
- where several samples share one instant (a vertical column of dots at one x).

The dots must never lie: a dot is drawn only on a real sample, never on a decimated
envelope point, and only when there is room on screen to tell dots apart.

## UI

- A toggle button **Samples** in the time-series panel toolbar, next to **Missing/NaN**
  (`timeseries-missing-btn` in `src/plots/methods/interaction-methods.js`).
  - Labels: EN *Samples*, ES *Muestras*, FR *Échantillons* (other locales follow the
    existing i18n table).
  - Tooltip (EN): *Show every sample as a dot when zoomed in enough; highlights
    repeated timestamps.*
- **Off by default.** State lives on the plot as `plot.showSamples` and is saved and
  restored with the session, exactly like `showMissingData`
  (`src/app/methods/session-methods.js`).
- Toggling rebuilds the panel while keeping the view (`_capturePlotView` +
  `_rebuildPanel`), the same pattern as `_toggleMissingData`.
- When the toggle is on but **no** visible trace qualifies (section "When dots are
  drawn"), a discreet notice is shown in the panel: *Zoom in to see the samples*
  (reuse the mechanism of the Missing/NaN "too dense" notice,
  `_setMissingDensityNotice`). If only some traces qualify, those get dots and the rest
  stay plain lines — no notice.

## When dots are drawn

Decided **per trace** (two files in one panel may be sampled very differently), on each
settled relayout (`plotly_relayout` → `_onRelayout`), not during a drag
(`plotly_relayouting`). Both conditions must hold:

### Condition 1 — exact data (same branch as stairs)

The trace's visual data must be the raw samples of the visible window, not the min/max
envelope. This is **the same branch that makes stairs exact**:
`_buildTimeseriesVisualData` → `visualPairForRange` copies the window verbatim when it
holds ≤ `timeseriesVisualMaxPoints` samples (default 2000) and decimates otherwise.
Stepped (`hv`) traces are not a special case there (see the comment above
`_buildTimeseriesVisualData` in `src/plots/methods/data-methods.js`), so dots and stairs
share one definition of "exact" and cannot disagree.

The decision must be taken from that branch (e.g. the builder reports
`decimated: true|false`), not re-derived elsewhere.

When the user turns downsampling off (`timeseriesVisualMaxPoints == null`) condition 1
always holds and condition 2 alone decides.

### Condition 2 — legibility (new; stairs do not have it)

Mean horizontal spacing between visible samples must be at least **P pixels**:

```
pxPerSample = plotAreaWidthPx / visibleSampleCount   (per trace)
```

- `plotAreaWidthPx` = `div._fullLayout.xaxis._length`.
- `visibleSampleCount` = samples whose x lies in the current x range, obtained by
  binary search on the time vector (`_lowerBound` / `_upperBound`), so the test is
  O(log n) per trace.
- **Hysteresis** to avoid flicker when zooming around the threshold: dots turn **on**
  at `pxPerSample ≥ P_ON` and turn **off** at `pxPerSample < P_OFF`.

Internal flags, one place, easy to change (static fields on `PlotManager`, next to
`DEFAULT_VISUAL_MAX_POINTS_TIMESERIES`):

```js
static SAMPLE_MARKERS_MIN_PX_ON  = 4;   // dots appear at ≥ 4 px per sample
static SAMPLE_MARKERS_MIN_PX_OFF = 3;   // and disappear below 3 px
```

Not exposed in Preferences.

Why stairs can do without condition 2 and dots cannot: a staircase squeezed below a
pixel per step degrades into something that looks like the line — harmless. Dots do not
degrade; they pile up into a smear that hides the curve.

With P = 4 px a trace carries at most ~width/4 dots (≈ 250–500 on a normal panel), which
also bounds the rendering cost (see Performance).

## Appearance

- Trace mode becomes `lines+markers`; the line stays.
- Normal sample: filled circle, trace colour, size ≈ 5 px.
- NaN samples get no dot (Plotly skips them); Missing/NaN line breaks are unaffected.
- Stepped traces: the dot sits at each sample, i.e. at the start of each step.
- PNG/SVG export: what is on screen.

## Repeated timestamps (highlighted in this feature)

With plain dots, samples at one instant with **different y** already show as a vertical
column. Samples at one instant with the **same y** overlap exactly and are invisible —
so repeats are highlighted explicitly:

- A sample is *repeated* when its x equals the x of the previous or next sample of the
  same trace. Same equality rule as `repeatedTimestampSummary`
  (`src/utils/repeated-timestamps.js`): exact equality, a non-finite x breaks a run.
  Add a helper there that returns the run structure for a `[start, end)` slice; it runs
  only over the visible raw slice (≤ budget), so it is cheap.
- Repeated samples are drawn with a distinct marker via per-point marker arrays:
  open ring, larger (≈ 10 px), contrasting colour (one fixed "warning" colour valid in
  light and dark themes), drawn over the normal dot. A burst of identical (x, y) thus
  still shows as one ring even though the dots overlap.
- Hover on a repeated sample appends *×k at this instant* (k = run length), carried in
  `customdata`. This matters because Plotly's hover picks only one of the coincident
  points.
- The highlight follows the same two conditions: no rings when dots are not drawn.
  Locating repeats at coarser zoom is point (c) of the bug report and out of scope here;
  this helper is designed to be reused by it.

## Scope

In:

- time-series panels (`plot.mode === 'timeseries'`), Y and Y2 axes;
- eager (in-memory) files.

Out, v1:

- **stacked** mode — the drawn y is cumulative, so a dot would not be the sample; the
  button is disabled there, as Y2 disables stacking today;
- time panes of FFT, Histogram, Heatmap, Temporal profile, Integral;
- the data-tool preview trace (`markersOnly`), which already draws its own markers.

To verify before building:

- **Lazy (DuckDB) files.** Check whether a small visible window returns raw rows or
  buckets. If raw rows, the same two conditions apply; if buckets, no dots (condition 1
  fails) and the notice is shown.

## Performance

- Dots are only ever drawn on ≤ ~width/P points per trace, so SVG `scatter` is fine.
  GL is already not used at that size (`GL_POINT_THRESHOLD = 50000`), so no
  `scatter ↔ scattergl` switching is introduced.
- The per-trace decision is a binary search plus a division; the repeat scan is linear
  in the visible raw slice only.
- Crossing the threshold changes `mode`/`marker` of the affected traces; prefer a
  `Plotly.restyle` on those trace indexes over a full rebuild when possible.

## Tests

- Unit: the decision function (conditions 1 and 2, hysteresis on/off, per-trace
  independence, downsampling off).
- Unit: the repeated-run helper on a slice (runs at slice edges, NaN breaking a run,
  identical (x, y) bursts).
- A fixture with repeated timestamps (reuse the collapse-repeated-timestamps test file)
  showing rings at the repeats once zoomed in.
- i18n keys present in every locale.
- Session save/restore of `showSamples`.
