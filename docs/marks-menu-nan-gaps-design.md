# Marks Menu, NaN/Inf and Gaps Design

Status: implemented. Replaces the single **Missing/NaN** toggle of the time-series
toolbar with two tools, **NaN/Inf** and **Gaps**, and gathers every display toggle of
a time-series panel into one **Marks** dropdown.

Related: [repeated-timestamps-indicator-design.md](repeated-timestamps-indicator-design.md),
[sample-markers-design.md](sample-markers-design.md).

## Why

User feedback on Missing/NaN:

1. **The gap heuristic was opaque and often wrong.** The nominal step Δt was the median
   of the positive steps, and a series only "had" a step when ≥ 80 % of the steps were
   within ±10 % of that median. Below that, *no gap was drawn at all*. The consequence
   was backwards: the more data a file was missing (more than 20 % of the steps being
   gaps), the less the tool reported. The lazy (DuckDB) path estimated its own Δt per
   **viewport**, so bands appeared and vanished with the zoom, and could disagree with
   the in-memory path on the same file. The Δt used was never shown.
2. **Two different questions in one button.** A NaN/Inf is a property of a *value* of
   one variable; exact, needs no assumption. A gap is a property of the *time axis* of a
   file; it needs a nominal step and a threshold. Mixing them made "Missing" ambiguous
   (a NaN is missing data too) and gave the Δt settings no natural home.
3. **Full-height bands for NaN hid other traces.** A NaN run of one variable was painted
   over the whole plot height, covering the other variables, which have data there.
4. **Toolbar space.** Stack, Y2, Missing/NaN, Samples and Repeated were five buttons;
   the line shape (stairs/linear) was only reachable through the legend context menu,
   i.e. practically hidden.

## Marks menu

One button in the time-series tools group, **Marks ▾** (ES *Marcas*, FR *Marques*,
IT *Marcature*), replaces the Stack, Y2, Missing/NaN, Samples and Repeated buttons.

```
[Marks (2) ▾]
 ┌─────────────────────────────────┐
 │ ☑ NaN/Inf                       │
 │ ☑ Gaps                       ⚙  │
 │ ☐ Repeated                      │
 │ ☐ Samples                       │
 │ ─────────────────────────────── │
 │ ☐ Stack                         │
 │ ☐ Y2                            │
 │ ─────────────────────────────── │
 │ Line  ● Auto ○ Linear ○ Stairs  │
 └─────────────────────────────────┘
```

- The button shows how many toggles are on (`Marks (2)`) and is styled active when any
  is, so a closed menu still says something is drawn.
- The menu is a popup (`role="menu"`) of `menuitemcheckbox` / `menuitemradio` items.
  It **stays open** while toggling, so several marks can be set in one visit; Escape,
  a click outside, or the button close it. It is rebuilt from the plot state every time
  the toolbar is re-rendered, so it never shows a stale check.
- Every toggle keeps its existing behaviour and its existing rules:
  - Repeated turns Samples on with it (and off again if it did so).
  - Repeated is disabled with its tooltip when no file on the panel repeats an instant.
  - Samples is disabled while stacked; Stack and Y2 exclude each other.
  - The "waiting" states of Samples and Repeated (dashed item, reason in the tooltip)
    carry over to the menu items.
- **Line shape** is a panel-level choice:
  - *Auto*: each trace follows its variable (`_variableDefaultsToStairs`), i.e. no
    per-trace override. This is the default.
  - *Linear* / *Stairs*: sets the override on every trace of the panel.
  - When the traces carry different overrides (set through the legend menu, which is
    kept for per-trace control) no radio is checked.
  - Nothing new is persisted: the state is derived from `trace.lineShape`, which the
    session already saves.
- The FFT pane is unchanged: it keeps drawing gaps and NaN runs as full-height bands,
  always, with the classic detector (the uniformity gate the FFT relies on).

## NaN/Inf

A strip along the top of the plot, like the zoomed-out Repeated bars, instead of
full-height bands.

- **Position.** Just below the Repeated strip; when Repeated is off it moves up to the
  top edge. Fixed height in pixels (`ysizemode: 'pixel'`), so it reads the same on a
  small and a tall panel.
- **Density, per screen column.** The visible range is cut into columns
  (`NAN_STRIP_COLUMN_PX = 2` px). For each column and each visible trace the fraction
  `nNaN / nSamples` is computed; the column takes the **largest** fraction among the
  traces (a variable that is fully missing there must read as fully missing, whatever
  the others do). The fraction is quantized to four levels and mapped to opacity, with
  a floor so that a single NaN among millions stays visible:

  | fraction | level | opacity |
  |---|---|---|
  | (0, 10 %) | 1 | 0.35 |
  | [10 %, 50 %) | 2 | 0.55 |
  | [50 %, 100 %) | 3 | 0.8 |
  | 100 % | 4 | 1.0 |

  Adjacent columns of the same level merge into one bar. This keeps the useful parts of
  the old amber levels (the "dense" wash that showed *where* scattered NaN sit, and the
  lazy "partial vs full" distinction) and makes them exact, without covering the curve.
- **Colour.** Violet (dark theme `#b388ff`, light `#7e57c2`): distinct from the red of
  Repeated and the amber of Gaps.
- **Hover.** Our own label, like Repeated (Plotly gives shapes no hover):
  *NaN/Inf: 37 of 1 200 samples (3 %)* plus the variable names when several traces
  contribute.
- **Line breaks: always.** Independent of the toggle, a time-series trace never draws a
  straight segment across a run of NaN/Inf values of its own. (Before, the break was
  added only while Missing/NaN was on.) When the runs visible are denser than the
  pixels (the old "dense" rule), the breaks are skipped, as before, so the downsampled
  envelope is not shredded into invisible fragments.
- **Memory-saving (DuckDB) files.** The strip comes from the existing per-bucket query
  (`n_missing / n_total`, one bucket per pixel). Line breaks for these files are only
  those the fetched rows themselves carry.

## Gaps

Full-height amber bands, as before. A gap covers a span where the file has **no rows
at all**, so the band hides nothing.

### Nominal step, automatic

`estimateNominalStep` (`src/utils/sampling-gaps.js`) replaces the median as the
automatic Δt for this tool:

1. Positive steps are binned on a log scale (40 bins per e-fold, ≈ 2.5 % wide).
2. For every bin, the steps within ±10 % of it are counted (a sliding window).
3. The winner is the bin with the largest window count; bins within 5 % of that count
   tie, and the **smallest step wins the tie** (gaps are multiples of the step, never
   fractions of it).
4. Δt is the mean of the steps inside the winning window; `agreement` is their share
   of all positive steps.

The same histogram is computed in DuckDB for memory-saving files (one aggregate query
per file, cached on the data object), so both paths agree and **the result does not
depend on the zoom**.

Unlike the median, the mode is not pulled away by a large minority of gaps, and there is
**no all-or-nothing gate**: the gaps are drawn whatever the agreement. When fewer than
80 % of the steps agree, the pill says so (*Irregular sampling: only 62 % of the steps
match Δt = 1 s — check the Gaps settings*). Out-of-order timestamps still disable the
gaps (every distance would be measured along the wrong sequence) and keep their notice.

### Threshold

A step is a gap when `step > factor × Δt`, `factor` = **1.5** by default.

1.5 is not a jitter tolerance. With a regular step, one dropped sample makes the step
2Δt, two make it 3Δt; a step of 1.3Δt is a late sample, not a missing one. 1.5 is the
midpoint between "none missing" and "one missing", i.e. rounding `step / Δt`, the same
rule used to count the missing samples (`round(step / Δt) − 1`). A smaller factor marks
jitter; a larger one ignores short dropouts (e.g. 10 = "only mark gaps of ~10 samples
or more").

### Gaps panel

The first time Gaps is turned on in a panel, a small settings panel opens, already
filled in and with the bands already drawn; later it opens from the ⚙ next to *Gaps* in
the Marks menu.

```
Gaps ─────────────────────────────────── ✕
 data.csv
 Δt  [ 1     ] [ s ▾]   [Auto]
     auto: 1 s · 96 % of the steps
 Threshold [ 1.5 ] × Δt   → gap when step > 1.5 s
 12 gaps · ~340 missing samples
```

- One block per file on the panel: Δt is a property of each file's time axis.
- Calendar axes offer ms / s / min / h / d; other axes show a plain number in the axis
  units.
- Editing Δt switches that file to *manual*; **Auto** re-runs the estimate and switches
  back. Changes apply immediately.
- The result line counts gaps and missing samples over the whole file (in memory), or
  says it is not available for memory-saving files.
- Settings live on the file (`plotManager.files.get(id).gapSettings = { dt, factor }`,
  `dt: null` = auto), so every panel showing the file agrees, and are saved in the
  session with the file.

### Dense views

Unchanged from Missing/NaN: bands are clipped to the view, merged at pixel resolution,
capped at 500, fade from strong (narrow, with a stroke so a one-sample gap is visible
zoomed out) to soft (wide); when there are more gaps than half the pixels, a faint wash
replaces them, line breaks are skipped and the pill says *zoom in*.

## State and compatibility

- `plot.showNaN`, `plot.showGaps` replace `plot.showMissingData`. A session saved with
  `showMissingData: true` opens with both on.
- `files[].gapSettings` added to the session file metadata; absent means auto / 1.5.
- The analysis kernels (integral, IIR, definite integral, data tools) and the FFT pane
  keep using `detectSamplingGaps` with its median and gate, unchanged. The Gaps tool
  uses `detectGapIndices(times, dt, factor)` with the resolved step (row indices in a
  typed array: a wrong manual Δt that makes every step a gap costs one `Int32Array`,
  not millions of objects), and materializes intervals only for the visible range.

## Where it lives

- `src/utils/sampling-gaps.js`: `estimateNominalStep`, `stepHistogram`,
  `nominalStepFromHistogram`, `detectGapIndices`, `nanRunIndices`.
- `src/utils/nan-strip.js`: the strip per screen column, the strip from DuckDB buckets,
  and the in-range line-break / gap intervals.
- `src/data/missing-buckets-sql.js`: step histogram and gap summary SQL,
  `lazyGapsFromBuckets` (DuckDB methods `getStepHistogram`, `getGapSummary`).
- `src/plots/methods/marks-methods.js`: settings, overlays, lazy coordinator, toggles,
  Marks menu, Gaps panel.

## Tests

- `test-nan-gaps-marks`: the mode estimator (regular, jitter, 30 % dropouts where the
  classic gate gives up, ties, histogram rows = in-memory histogram), gap and NaN-run
  scanners, the strip (levels, fast path = linear scan, max across traces, buckets),
  lazy gaps with a fixed Δt, and the plot methods (settings, formatting, line breaks,
  overlay order, notices, lazy step query, lazy coordinator).
- `test-missing-lazy`: the step histogram SQL and `lazyGapsFromBuckets` against real
  DuckDB, in parity with the in-memory path.
- `test-missing-data`: the FFT pane's bands, and the wiring of the new tools.
- `test-mode-toolbar`: Marks menu structure, count, disabled/waiting items, line-shape
  radio.
- `test-session-state-roundtrip`: `showNaN`/`showGaps`, legacy `showMissingData`,
  `gapSettings`.
- `e2e-nan-gaps` (browser): strip and hover, always-on NaN breaks, the Gaps panel
  opening filled in, threshold and manual Δt, Auto, line shape.
