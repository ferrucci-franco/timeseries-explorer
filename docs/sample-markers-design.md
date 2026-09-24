# Sample Markers Design ("Samples" toggle)

Status: specified, not built. Build this first; the **Repeated** toggle
([repeated-timestamps-indicator-design.md](repeated-timestamps-indicator-design.md))
builds on it.

Context: bug report on *Collapse repeated timestamps*. Points (a) and (b) of that report
(the tool writes every variable; "Create and plot" opens a new panel) are tracked
separately. Point (c), locating repeated timestamps, is the **Repeated** toggle. This
document specifies point (d): a way to see every real sample as a dot.

## Goal

A drawn line says nothing about where the data is. Between two samples the line is
interpolation; at a repeated timestamp it is a vertical segment that looks exactly like
a steep edge. Drawing each sample as a dot shows where the samples are and how dense
they are — and, as a side effect, several samples with different y at one instant show
as a vertical column of dots.

The dots must never lie: a dot is drawn only on a real sample, never on a decimated
envelope point, and only when there is room on screen to tell dots apart.

## UI

- A toggle button **Samples** in the time-series panel toolbar, next to **Missing/NaN**
  (`timeseries-missing-btn` in `src/plots/methods/interaction-methods.js`).
  - Labels: EN *Samples*, ES *Muestras*, FR *Échantillons* (other locales follow the
    existing i18n table).
  - Tooltip (EN): *Show every sample as a dot when zoomed in enough.*
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

## Repeated timestamps

Not this feature's job. Where a file repeats timestamps is a property of the file and
must be findable at any zoom, whereas dots exist only when zoomed in. That is specified
in [repeated-timestamps-indicator-design.md](repeated-timestamps-indicator-design.md)
(the **Repeated** toggle).

The two toggles meet in one place: when both are on and a trace has dots, the
**Repeated** feature draws its ring on the repeated samples. *Samples* alone draws only
plain dots — with different y, repeats already show as a vertical column of dots; with
identical y they overlap, which is why the ring belongs to **Repeated**.

The only contract *Samples* owes **Repeated**: expose, per trace, whether dots are
currently drawn and the visible raw slice `[start, end)` they were drawn from.

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
- The per-trace decision is a binary search plus a division.
- Crossing the threshold changes `mode`/`marker` of the affected traces; prefer a
  `Plotly.restyle` on those trace indexes over a full rebuild when possible.

## Tests

- Unit: the decision function (conditions 1 and 2, hysteresis on/off, per-trace
  independence, downsampling off).
- A fixture with repeated timestamps with different y (reuse the
  collapse-repeated-timestamps test file) showing a vertical column of dots once
  zoomed in.
- i18n keys present in every locale.
- Session save/restore of `showSamples`.
