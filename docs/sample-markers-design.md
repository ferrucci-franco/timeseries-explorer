# Sample Markers Design ("Samples" toggle)

Status: v1 built (eager files). The **Repeated** toggle
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
  drawn"), the panel says so in two ways (changed after first use — see below):
  - **The button waits.** It stays pressed but is drawn with a dashed border and no
    fill (`.samples-waiting`), and its tooltip gives the reason: *Zoom in to see the
    samples*. This lasts for as long as the reason does, and never covers the plot.
  - **A pill, once.** Right after the click that turns the toggle on, if nothing
    qualifies, the pill *Zoom in to see the samples* appears for 3 s
    (`SAMPLES_HINT_MS`) so the click visibly did something, then goes. Later zooms
    never bring it back; the button carries the state from then on.

  If only some traces qualify, those get dots and the rest stay plain lines — the
  button is not waiting.

  First version: the pill stayed for as long as the view was zoomed out. In use it
  sat over the curve most of the time, since zoomed out is where a panel spends most
  of it — it was annoying. Options weighed: a pill that fades by itself; the state on
  the button only; both; a small corner badge. Chosen: both — the pill explains the
  first time, the button remembers.

## When dots are drawn

Decided **per trace** (two files in one panel may be sampled very differently),
wherever the panel's visual data is refreshed (`_refreshTimeseriesVisuals`: after
creation, on each zoom or pan, and during a live drag when that refresh runs). The
test is a binary search and a division, and the hysteresis keeps it steady, so there
is no need to hold it back until the drag settles. Both conditions must hold:

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

Mean horizontal spacing between visible **positions** (distinct x values) must be at
least **P pixels**:

```
pxPerPosition = plotAreaWidthPx / visiblePositions   (per trace)
```

- `plotAreaWidthPx` = `div._fullLayout.xaxis._length`.
- `visiblePositions` = distinct x values among the samples inside the current x range
  (`countDistinctPositions` in `src/utils/sample-markers.js`). The range itself comes
  from a binary search on the time vector (`_lowerBound` / `_upperBound`); the count is
  a linear scan of that range, done only when the window is exact (so at most the
  visual budget, 2000 by default) and skipped past `SAMPLE_POSITION_SCAN_LIMIT`
  samples (downsampling off), where the row count stands in.
- **Why positions and not rows** (changed after first use): rows that share one instant
  sit in one column and take no extra horizontal room. A logger that stamps to the
  second under a 10 Hz loop puts ten rows at each position; counting rows kept its dots
  off until the view was zoomed ten times further than any other file needed, and they
  then appeared ~40 px apart.
- **Hysteresis** to avoid flicker when zooming around the threshold: dots turn **on**
  at `pxPerPosition ≥ P_ON` and turn **off** at `pxPerPosition < P_OFF`.

Internal flags, one place, easy to change (`src/utils/sample-markers.js`, exposed as
static fields on `PlotManager`):

```js
SAMPLE_MARKERS_MIN_PX_ON  = 8;   // dots appear at ≥ 8 px per position
SAMPLE_MARKERS_MIN_PX_OFF = 6;   // and disappear below 6 px
```

The first values were 4 / 3 px. Spacing is measured centre to centre, so it has to
clear the 5 px dot itself: at 4 px the dots touched and a trace read as a thick bead
necklace. 8 px leaves a visible gap of about 3 px.

Not exposed in Preferences.

Why stairs can do without condition 2 and dots cannot: a staircase squeezed below a
pixel per step degrades into something that looks like the line — harmless. Dots do not
degrade; they pile up into a smear that hides the curve.

With P = 8 px a trace carries at most ~width/8 positions (≈ 125–250 on a normal panel), which
also bounds the rendering cost (see Performance).

## Appearance

- Trace mode becomes `lines+markers`; the line stays.
- Normal sample: filled circle, trace colour, size ≈ 5 px.
- NaN samples get no dot (Plotly skips them); Missing/NaN line breaks are unaffected.
- Stepped traces: the dot sits at each sample, i.e. at the start of each step.
- PNG/SVG export: what is on screen.

## Repeated timestamps

Where a file repeats timestamps is a property of the file and must be findable at any
zoom, whereas dots exist only when zoomed in. That is the **Repeated** toggle
([repeated-timestamps-indicator-design.md](repeated-timestamps-indicator-design.md)).

The two meet on the dots: turning Repeated on turns Samples on with it, and where a
trace has dots, Repeated puts a red ring on each repeated sample (with identical y,
the dots of a burst overlap exactly, so the ring is what shows it). *Samples* alone
draws only plain dots.

What *Samples* owes **Repeated**: `plot._sampleMarkerState` says, per trace, whether
dots are drawn now (Repeated leaves such a file off its zoomed-out strip), and the trace
builder hands Repeated the exact window the dots were drawn from.

## Scope

In:

- time-series panels (`plot.mode === 'timeseries'`), Y and Y2 axes;
- eager (in-memory) files.

Out, v1:

- **stacked** mode — the drawn y is cumulative, so a dot would not be the sample; the
  button is disabled there, as Y2 disables stacking today;
- time panes of FFT, Histogram, Heatmap, Temporal profile, Integral;
- the data-tool preview trace (`markersOnly`), which already draws its own markers.

Lazy (DuckDB, "memory-saving mode") files — checked, and left out of v1:

- Zoomed out, the time-series panel draws a lazy trace from the in-memory overview,
  a sample of the file that is not its rows, so condition 1 can never hold there.
- Zoomed in, `DuckDbSource._queryColumnsRange` does have a `raw` mode: when the
  estimated rows in the window are ≤ ~1.2 × the budget it returns the rows
  themselves rather than min/max buckets (`_perf.mode === 'raw'`). Dots on lazy
  files are therefore possible as a follow-up: carry that mode to
  `_applyBatchedTimeseriesRestyle` as the `exact` flag, with the visible count from
  the returned rows.
- Until then a lazy trace never gets dots. If every candidate trace on the panel is
  lazy, the button's tooltip (and the one-off pill) say so (*Samples are not shown yet
  for files loaded in memory-saving mode*) instead of asking the user to zoom in,
  which would not help.

## Performance

- Dots are only ever drawn on ≤ ~width/P positions per trace (more rows only where rows
  share an instant, and never more than the visual budget), so SVG `scatter` is fine.
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
