# How long each analysis holds the main thread

> Status: **measurements, before any fix** (2026-11-15, on top of the lazy-FFT
> fix of #174). Nothing in the app was changed to produce them. The work they
> call for is split into the issues listed under "The work, by issue"; each
> fix adds its own after numbers here when it lands.

Issue #174 was a lazy FFT that froze the page: on a 10 M-row file the read of
its rows was one main-thread task of eight seconds. That is fixed
(`docs/any-size-files.md`, "la FFT lazy no congela la página") and guarded by
`scripts/e2e-lazy-fft-responsive.mjs`. This document asks the same question of
**every other analysis**, on a file in memory-saving (lazy) mode and on the
same file loaded in memory (eager): while it computes, can the page still be
used?

The short answer:

- **On a file in memory, no analysis but the FFT leaves the page usable.**
  Every kernel runs on the main thread, in one task: 0.3–3.8 s with ordinary
  settings on 10 M rows, 19–44 s for an exponential fit. The computing pill is
  drawn, but its Cancel button cannot be pressed until the result is there.
- **On a lazy file, two things hold the thread**: the histogram (0.6–1.7 s:
  the quartiles, sorted after the read), and the exponential fits — of the
  curve fit, the trend and the 2D curve fit — whenever the range holds no more
  than 6 M rows (1.1–2.9 s at 1 M rows, 10 s at 4 M).
- **What is computed in SQL is fine for the thread** (heatmap, temporal
  profile, integral, pair correlation, the trend's sums, the 2D trajectory),
  but a newer request does not stop the query it supersedes, so a change made
  while one is running waits for both.

## The work, by issue

One issue per thing to fix; what is best attacked together shares an issue.
Each issue carries the numbers and the cause from this document, what "done"
means, and a suggested model and effort for the session that takes it.

| Issue | What | Sections here | Order | Suggested |
|---|---|---|---|---|
| #381 | **In-memory analyses on the compute worker**: every kernel but the FFT's runs on the main thread (0.3–44 s). One shared analysis job with a per-run abort; the 2D fit computed once; Cancel working on in-memory files, the 2D fit's typed bound included | "Offenders, ranked" 1–3, 5, 7, 8, 10–12; "Other defects" 4 | first: the base for #382 and #383 | Opus, high |
| #382 | **Lazy exponential fits** (curve fit, trend, 2D fit): 1–3 s at 1 M rows in range, 10 s at 4 M. Stream to the worker; polish the kept rows there; abort at schedule time | "Offenders, ranked" 4, 6; "Lazy fits over a 4 M-row range" | after #381 | Opus, high |
| #383 | **Lazy histogram**: quartiles and counting after the read, 0.6–1.7 s. In the worker; skipped when nothing reads them; abort at schedule time | "Offenders, ranked" 9; "Histogram" | after #381 | Opus, medium |
| #384 | **Lazy SQL analyses: the superseded query is not stopped** (heatmap, temporal profile, pair correlation: the result takes twice as long), and **Trend does not report a Cancel** (DuckDB's interrupt is not an `AbortError`) | "A request in flight when a newer one arrives"; "Other defects" 3 | independent | Opus, high |
| #385 | **Lazy integral**: out of memory at 10 M rows, refused on a numeric axis, superseded query not stopped | "Other defects" 1, 2; "Integral" | independent | Opus, high |
| #386 | **Borderline, 200–400 ms** on 10 M rows in memory: FFT of 2¹⁸ samples or fewer, the cross-correlation panel's axis, building a time pane | "Offenders, ranked", the borderline list | independent | Sonnet, medium |
| #387 | **Temporal profile in memory**: the range block keeps showing the preview after it is widened to the whole file | "Other defects" 5 | with #381 (same code path) | Sonnet, medium |
| #388 | **Cross-correlation tool on a lazy file past its budget**: 14 s of queries with no cancel signal, then the refusal | "Other defects" 6 | independent | Sonnet, medium |
| #389 | **A CI check** that no analysis holds the page more than 250 ms, from this harness | "Running it" | last | Sonnet, medium |

Not in this list because it is not a defect: the paint of each result
(`Plotly.react`, and the WebGL commit that headless Chromium does in
software), measured apart from the computation throughout.

## What was measured

`scripts/bench-analysis-responsiveness.mjs` (`npm run
bench:analysis-responsiveness`) drives the real app in headless Chromium, as
the lazy-FFT check does, and generalises it.

**Files.** Generated CSVs of `time,a,b`, 1.2 M and 10 M rows:

| File | Rows | Size | Used for |
|---|---|---|---|
| numeric time axis, 4 kHz | 1.2 M | 32 MB | everything but the calendar analyses |
| numeric time axis, 4 kHz | 10 M | 272 MB | the same |
| calendar time axis, a row every 3 s | 1.2 M | 43 MB | heatmap, temporal profile, integral |
| calendar time axis, a row every 3 s | 10 M | 362 MB | the same |

Each is opened twice: **lazy** (the CSV full-load limit set to 2 MB) and
**eager** (the limit set to 0: in memory whatever the size). Loading 10 M rows
in memory works (13–14 s), so the large file is measured in both modes. With
the default limit (300 MB) the 272 MB file *is* loaded in memory: the eager
column at 10 M is what a user gets without touching a setting.

**Analyses.** Every entry of the Analysis menu of a time-series panel (FFT,
histogram, heatmap, temporal profile, integral, curve fit, trend) and of a 2D
plot (correlation of the pairs, curve fit), on one signal (`a`) or one pair
(`b → a`). Besides them: the 2D plot itself (its trajectory), the
Cross-correlation data tool, the audio strip (prepare and play), and the plain
time series as a baseline.

**Actions**, in this order on each analysis:

| Action | What is done |
|---|---|
| open | the analysis is picked |
| type | both bounds of the range are typed in: 10 % … 90 % of the file |
| param | one parameter is changed (table below), measured, and put back |
| drag | a bound is typed (5 %), and while that recompute is in flight the slider of the same bound is dragged to 40 % and let go; measured from the release |
| cancel | a recompute is asked for (15 % … 85 %) and Cancel is pressed on the computing pill, with the mouse |

| Analysis | The parameter changed | A second, heavier one |
|---|---|---|
| FFT | window: none → Hann | |
| Histogram | bins: automatic → 40 | |
| Heatmap | week × day → day × hour | |
| Temporal profile | period: day → week | |
| Integral | trapezoidal → rectangular; on the calendar file, group by: none → day | |
| Curve fit | model: linear → quadratic | quadratic → exponential |
| Trend | value band on | exponential on |
| Correlation (pairs) | — (one method) | |
| 2D curve fit | model: linear → quadratic | quadratic → exponential |

**What a row says.**

- *Longest task: computation / in Plotly / no JS*. Every main-thread task over
  50 ms is recorded (`PerformanceObserver`, `longtask`) and split with a CPU
  profile of the action (V8's sampler through CDP, a sample every 0.5 ms) into
  three parts: time with a Plotly function on the stack (building and drawing
  the chart); time with no JavaScript running at all (style, layout and the
  compositor's commit); and the rest — the app's own code, Arrow, the garbage
  collector: **the computation and the read**. Each column is the largest such
  part of any one task. Over 250 ms, the computation is in bold.
- *Longest task overall*: the longest task, whatever it did.
- *Frame gap*: the longest wait between two animation frames beyond a frame's
  own 17 ms. A cross-check that does not use the `longtask` observer; a 10 ms
  timer is watched the same way and agrees with it throughout.
- *Time to result*: from the action to the computing pill going off (for
  `drag`, from the release; for `cancel`, how long the press on Cancel waited
  for the page to take it).
- *A newer request stops the one in flight*: what became, at the release of the
  slider, of the read the typed bound had started. On a lazy file the queries
  and streams are logged with their signals; see below for how the question is
  made answerable on any machine.

**The paint is not the computation.** Headless Chromium draws WebGL in
software. A bare `Plotly.react` of a 12 000-point `scattergl` spectrum is one
task of ~320 ms here (measured for the FFT fix), and the canvas is then handed
to the compositor in a second task of 240–380 ms in which no JavaScript runs —
a trace shows it as one `Commit`. Those are the *in Plotly* and *no JS*
columns. They happen once per result, they do not grow with the file, and with
a GPU they are another matter; they are reported and kept apart, and nothing
is called an offender because of them.

**"In flight", on any machine.** Whether a newer request aborts the older one
can only be seen if the older one is still running when the newer one arrives,
and on a small file a query is over in a tenth of a second. So during the
`drag` action — and only there — what the typed bound starts on a lazy file is
slowed down by the harness: a stream's chunks arrive 150 ms apart and a
query's answer is held back, until one second after the release, unless its
signal aborts first. What the release starts is not slowed. On a file in
memory there is nothing to slow: the drag begins at once, the recompute of the
typed bound starts under it, and what is recorded is how long the slider's
events waited.

**The profile's cost.** The tables come from runs under the profiler. The same
actions without it (`--profile=false`) give the same numbers within the spread
between two runs: histogram, 1.2 M eager, open / type / param: 694 / 499 /
552 ms with it, 653 / 510 / 597 ms without; exponential curve fit: 1155 ms
with, 1110 ms without.

**The machine, and the spread.** Chromium 153 headless on 4 cores of a Xeon at
2.1 GHz shared with other jobs, 16 GB. The matrix was run twice, about an hour
apart (the first time with an earlier version of the harness, which did not
put a changed parameter back before the next action). Where the two runs
measured the same thing, tasks over 150 ms differed by a factor of 0.6 to 1.4
(median 0.8 at 1.2 M rows, 1.05 at 10 M). Nothing called an offender below was
under 250 ms in either run; the cells that crossed the line from one run to
the other are the ones listed as borderline. The tables are the second run.

## Summary

The longest **computation** task of each analysis, in ms, over all the actions
with ordinary settings; the exponential fits are on their own lines. Bold: over
250 ms.

| Analysis | 1.2 M lazy | 1.2 M eager | 10 M lazy | 10 M eager |
|---|---|---|---|---|
| FFT | 37 | 131 | 93 | **266** ¹ |
| Histogram | **662** | **1028** | **1673** | **1724** |
| Heatmap | 28 | **510** | 144 | **2861** |
| Temporal profile | 20 | **459** | 17 | **3757** |
| Integral, numeric time axis | refused ² | 137 | refused ² | **1186** |
| Integral, calendar time axis | 21 | 195 | fails ³ | **1291** |
| Curve fit: linear, quadratic | 165 ⁴ | 131 | 81 | **879** |
| Curve fit: exponential | **2823** | **1199** | 102; **10464** ⁵ | **18576** |
| Trend: mean, linear, quadratic, value band | 12 | 177 | 14 | **1040** |
| Trend: exponential | **1074** | **1228** | 89; **10751** ⁵ | **18851** |
| Correlation of the pairs | 12 | 47 | 11 | **358** |
| 2D curve fit: linear, quadratic | 16 | 126 | 33 | **1001** |
| 2D curve fit: exponential | **2924** | **5676** | 161; **10107** ⁵ | **44167** |
| 2D plot: the trajectory | 6 | 5 | 0 | 11 |
| Cross-correlation tool | 43 | 52 | 0; refused past 8 M rows | 230 ¹ |
| Audio: prepare and play | 0 | 0 | 65 | 0 |
| *The time series itself (baseline)* | 22 | 91 | 17 | **331** |

¹ Borderline: over 250 ms in one of the two runs, under it in the other (FFT
266 and 208; the cross-correlation panel 230 and 297).
² The Integral analysis has no lazy path for a numeric time axis: *"this large
(lazy) signal has no exact source column, or its file has no calendar time
axis"*.
³ The query fails after 12–16 s: DuckDB-WASM runs out of memory. See "Other
defects".
⁴ Over a range of 0.96 M rows. This path serves up to 2 M rows
(`FIT_MAX_LAZY_ROWS`), with twice the work.
⁵ Two ranges of the 10 M file: 8 M rows (10 % … 90 %), streamed pass by pass,
and 4 M rows (30 % … 70 %, `--range=0.3,0.7`), where the rows are kept after
the second pass and the fit is polished in memory.

### Offenders, ranked

By the longest computation task, over the `open`, `type` and `param` actions.
"10 M" and "1.2 M" are the file; the range is 80 % of it unless said
otherwise.

| # | Analysis, mode | Longest computation task | What runs in it |
|---|---|---|---|
| 1 | 2D curve fit, in memory — exponential | 44.2 s (10 M), 5.7 s (1.2 M) | `fitPair` → `expFamilyFitSteps` → `brent` → `solveForRate` → `add` → `basis` (`src/utils/exp-fit.js`), on the main thread — and **twice** per recompute: `_computePhase2dFits` is called by `_schedulePhase2dFitRecompute` and again by `_buildPhase2dFitCurveTraces` during the redraw, and keeps nothing between the two |
| 2 | Trend, in memory — exponential | 18.9 s (10 M), 1.2 s (1.2 M) | `_computeTrends` → `_trendFromRows` → `_trendExpFromRows` → `fitPair` → the same `exp-fit.js` loop |
| 3 | Curve fit, in memory — exponential | 18.6 s (10 M), 1.2 s (1.2 M) | `_computeCurveFits` → `_curveFitFromRows` → `fitPair` → the same loop |
| 4 | Curve fit, trend and 2D curve fit, **lazy** — exponential, 2–6 M rows in the range | 10.1–10.8 s at 4 M rows | `runPassesOnChunks` → `expFamilyFitSteps`: the rows are kept after the second streamed pass (`FIT_KEEP_LAZY_ROWS`) and the polish — some twenty evaluations of `basis` over every kept row — runs between two passes, in one task |
| 5 | Temporal profile, in memory | 2.6–3.8 s (10 M), 0.37–0.46 s (1.2 M) | `_recomputeTemporalProfile` → `buildTemporalProfile` → `periodInfo` → `floorUtcDay` / `floorUtcWeek` (`src/utils/temporal-profile.js`) |
| 6 | Curve fit, trend and 2D curve fit, **lazy** — exponential, up to 2 M rows | 2.8–2.9 s (curve fit, 2D fit), 1.1 s (trend) at 0.96 M rows | `_fetchLazyFitRows` reads the range in one `getRawColumnsRange`; then `_curveFitFromRows`, `_trendLazyExpFit` or the 2D fit's `fitPair`, on the main thread. The curve fit's linear and quadratic models go the same way: 137–165 ms at 0.96 M rows |
| 7 | Heatmap, in memory | 2.1–2.9 s (10 M), 0.38–0.51 s (1.2 M) | `_recomputeCalendarHeatmap` → `buildCalendarHeatmap` → `aggregateCalendarHeatmap` (`ensure`, `utcIsoDayParts`, `floorUtcDay`, `calendarHeatmapCellCore`; `src/utils/calendar-heatmap.js`) |
| 8 | Histogram, in memory | 1.2–1.7 s (10 M), 0.55–1.03 s (1.2 M) | `_recomputeHistogramNow` → `histogramFiniteStats` (a pass, a copy into an `Array` and a comparator sort, `src/utils/histogram.js:57–97`) and `countHistogramBins` |
| 9 | Histogram, **lazy** | 1.0–1.7 s (10 M), 0.57–0.66 s (1.2 M) | after the stream: `_lazyHistogramStats` → the same `histogramFiniteStats`, over the values it kept or, past `HISTOGRAM_EXACT_QUANTILE_MAX_N`, over the 2 M-value stride sample |
| 10 | Integral, in memory | 0.35–1.3 s (10 M) | `_recomputeIntegral` → `computeDefiniteIntegral` → `scanGaps` → `detectSamplingGaps` → `medianInPlace` / `selectKth`; grouped by day, `_integralEagerGroups` on top |
| 11 | Curve fit, trend and 2D curve fit, in memory — linear, quadratic, value band | 0.63–1.04 s (10 M) | `fitPair` / the trend's passes → `chunk` (`src/utils/correlation.js:53`, `src/utils/regression.js:212`, `src/utils/trend-fit.js:113`), the slices that feed them, and for the 2D fit the second fit of the redraw |
| 12 | Correlation of the pairs, in memory | 250–358 ms (10 M) | `_refreshCorrelationResults` → `pearsonCorrelation` → `pairwiseMoments` → `chunk` (`src/utils/correlation.js:53`), and the slices of `_correlationPairSeries` |

Borderline, around 250 ms in one run and under it in the other:

- **FFT, in memory, at or under 2¹⁸ samples** (the first result of a 10 M file,
  which is cut to a clean block of 262 144 samples): 191–266 ms. Under
  `FFT_WORKER_THRESHOLD_POINTS` the spectrum is computed on the main thread:
  `computeAmplitudeSpectrum` → `analyzeSampling` → `median`
  (`src/utils/fft.js:695`) and `fftRadix2`.
- **The Cross-correlation tool's panel, file in memory**: 230–297 ms when the
  tool is picked on 10 M rows — `_seedXcorrDefaults` → `_xcorrAxis` →
  `_axisStepInfo` → `detectSamplingGaps` → `selectKth`. Creating the dataset
  is in the worker; the longest task it leaves on the main thread is
  158–195 ms.
- **Building a time pane over 10 M rows in memory**: 220–400 ms each time an
  analysis is opened, and 290–340 ms for the time series itself —
  `_buildTimeLayout` → `_finiteExtent` (`src/plots/plot-manager.js:4491`) over
  every value, and `decimateRangeIndexes`. In the curve fit it runs again on
  every recompute (`_refreshCurveFitResiduals` → `_buildCurveFitResidualLayout`).
  Not an analysis kernel, but it is in every `open` row of the eager 10 M file.

### What is fine

- **FFT**, both modes: 6–131 ms of computation while the rows are read and
  transformed (the fix of #174), apart from the borderline first block above.
  Its tasks of 240–380 ms are the paint: 40–265 ms in `Plotly.react` and the
  commit that follows.
- **Heatmap, temporal profile, integral (calendar axis), correlation of the
  pairs, the trend's sums, the 2D plot's trajectory, on a lazy file**: SQL in
  DuckDB's worker; the main thread sees a small result (0–28 ms; 144–185 ms
  for the day × hour heatmap of 10 M rows).
- **A lazy fit past 6 M rows**: every pass is a stream of the file, 62–161 ms
  a chunk at most. It is long — 186–200 s for an exponential over 8 M rows —
  but the page is free and Cancel works.
- **The 2D plot** (0–11 ms), **the audio strip** (a lazy read in chunks,
  0–65 ms; in memory nothing over 50 ms), **the Cross-correlation tool on a
  lazy file** (a stream, then the worker).

### A request in flight when a newer one arrives

| | Lazy | In memory |
|---|---|---|
| FFT | stopped at once (0–1 ms after the release; the read ends 9–81 ms later) | its worker is terminated |
| Histogram | stopped when the new run starts, 159–170 ms after the release (the debounce and a frame); the read ends 119–184 ms later | on the main thread: the slider waited 0.7 s (1.2 M), 1.3 s (10 M) |
| Curve fit, trend, 2D curve fit | stopped when the new run starts, 165–191 ms after the release | on the main thread: 0.14–0.78 s |
| Heatmap, temporal profile, integral, correlation of the pairs | **not stopped: the superseded query runs to its end**, and the new one waits for it on the shared connection | on the main thread: 0.3–3.5 s (10 M) |

The cost of the last lazy line shows in the time to result after a drag,
against a range typed with nothing in flight: heatmap 20.5 s against 10.8 s,
temporal profile 33.0 s against 18.0 s, correlation 6.9 s against 3.6 s (10 M
rows); integral 6.0 s against 3.8 s (1.2 M rows). These analyses share one
cancel signal per panel between consecutive runs (`_analysisSignal`): a
superseded run is dropped by its token when it returns, not aborted.

### Cancel

- **Lazy**: the press is taken in 1–13 ms (72–78 ms twice, in the 2D curve
  fit) and the read in flight is aborted, in every analysis,
  and the range is put back.
- **In memory**: the pill is drawn one frame before the kernel starts, and the
  kernel then holds the thread. In 14 of the 20 cases (ten analyses, two
  sizes) the pill was gone — the result drawn — before the page could take a
  press, 0.17–2.8 s after the change. Cancel works where the press lands
  before the kernel starts: the FFT, and the fastest of the others.

## What holds the thread

Each offender's task, from the CPU profile: the chain of app functions the
time was spent under, and the code that was running (self time). The list per
file and mode is under each table of "Full results".

**Exponential fits** (`exponential`, `exponential-offset`, `first-order`,
`first-order-offset`). All the time is in `basis` (`Math.expm1` per row) and
`add` (`src/utils/exp-fit.js:79`, `:105`), called by `brent`'s polish through
`solveForRate`: once the rate is located on 20 000 strided rows, each
evaluation of the polish is a pass over every row. At 8 M rows in memory that
is 15.8 s of `basis` and 1.4 s of `add` in the curve fit. The same generator
(`expFamilyFitSteps`) serves four paths:

- in memory, `runPassesOnArrays` on the main thread (curve fit, trend, 2D fit);
- lazy, up to 2 M rows: one read, then `runPassesOnArrays` on the main thread;
- lazy, 2–6 M rows: `runPassesOnChunks`; the passes are streams, but the
  polish over the kept rows runs inside the generator between two of them;
- lazy, past 6 M rows: every evaluation is its own streamed pass — nothing
  holds the thread.

**The 2D fit fits twice.** With one pair and the exponential model, 1.2 M rows
in memory, one change of model calls `_computePhase2dFits` twice, 2 971 ms and
3 117 ms: once in `_schedulePhase2dFitRecompute` (inside
`_measureAnalysisKernel`) and once in `_buildPhase2dFitCurveTraces` when
`_rerenderPhase2dPlot` rebuilds the traces. The lazy path keeps its fit
(`plot._phase2dLazyFits`); the eager one keeps nothing.

**Histogram.** `histogramFiniteStats(values)` makes a first pass for the count
and the extremes, a second that copies every finite value into a plain `Array`
with `push`, and sorts it with `(a, b) => a - b`: at 10 M rows in memory,
0.7–1.0 s in the function and 0.43–0.57 s in the comparator. On a lazy file
the stream itself is cheap; it is this same function, called once the stream
has ended on the values it kept (`_lazyHistogramStats`), that makes the task:
0.63–0.9 s and 0.44–0.63 s at 10 M. Two details:

- the quartiles only choose an automatic bin count, but they are computed
  whatever the bin mode — in memory always (bins set to 40, 10 M: the
  comparator still runs 430 ms), and on a lazy file whenever the values were
  kept (1.2 M, bins set to 40: 571 ms). Past 2 M values, where a lazy file
  does not keep them, a manual bin count costs nothing (10 M lazy: 0 ms);
- `countHistogramBins` adds 74 ms at 10 M in memory.

**Heatmap, in memory.** `aggregateCalendarHeatmap`
(`src/utils/calendar-heatmap.js:264`) 1.0–1.2 s of self time at 10 M rows,
with `ensure` (`:368`) 0.73–0.76 s, `floorUtcDay` (`:97`) 0.98 s,
`utcIsoDayParts` (`:103`) 0.16–0.41 s, `calendarHeatmapCellCore` (`:147`)
0.31 s.

**Temporal profile, in memory.** `floorUtcDay`
(`src/utils/temporal-profile.js:44`) 1.1 s, `buildTemporalProfile` (`:285`)
0.86–1.2 s, `periodInfo` (`:101`) 0.5 s, `floorUtcWeek` (`:49`) 0.54 s for the
weekly period. On opening, the automatic preview (262 144 samples) is
measured, the whole file is projected under the 5 s the app allows a kernel
(`ANALYSIS_AUTO_LIMIT_BUDGET_MS`), and the whole file is computed: the first
result of a 10 M file is a 2.5–2.8 s task.

**Integral, in memory.** `computeDefiniteIntegral`
(`src/compute/kernels/definite-integral.js:557`) 0.29–0.37 s;
`detectSamplingGaps` with `medianInPlace` / `selectKth`
(`src/utils/sampling-gaps.js`) 0.13–0.74 s; the slices of
`_integralSeriesForTrace` 0.08–0.11 s; grouped by day,
`_integralEagerGroups` (`src/plots/methods/integral-methods.js:1244`) 0.44 s
more.

**Linear and quadratic fits, the trend's sums, the pair correlation, in
memory.** The accumulating `chunk` functions of `src/utils/correlation.js:53`,
`src/utils/regression.js:212` and `src/utils/trend-fit.js:113` (`masked`,
`:98`, with a value band), 0.15–0.47 s each at 8 M rows, plus the copies that
feed them (`_curveFitEagerRows`, `_trendEagerRows`, `_phase2dPairSeries`,
`_correlationPairSeries`: 0.07–0.17 s), `shiftedTime`, and in the curve fit
the residuals (`push`, `src/plots/curve-fit-state.js:168`) and the
`_finiteExtent` of the residual pane (0.1 s).

**Lazy fits up to 2 M rows.** `_fetchLazyFitRows`
(`src/plots/methods/fit-lazy-methods.js`) is one `getRawColumnsRange`, then
`_transformFetchedPhaseTrajectory` and a per-row cut of the range, then the
fit on the main thread. With the exponential the fit is everything (2.4–2.5 s
of `basis` in a 2.9 s task). With a linear or quadratic model the 137–223 ms
task at 0.96 M rows is the read's conversion, the transform, the fit and the
residuals together; at the 2 M rows this path serves, twice that.

## Other defects found on the way

Not long tasks, but seen while measuring. Nothing here was fixed.

1. **Integral on a lazy file of 10 M rows fails.** `getDefiniteIntegralByDay`
   ends, after 12–16 s, in *"Out of Memory Error: could not allocate block of
   size 256.0 KiB (1.4 GiB/1.4 GiB used)"*; the panel says *"the file could
   not be queried for this total"*. At 1.2 M rows it answers, in 3.6–5.1 s.
2. **Integral on a lazy file with a numeric time axis is refused**
   (`integralLazyUnsupported`). The panel says so; the gap has no row in the
   table of `docs/any-size-files.md`.
3. **Trend, lazy: after Cancel the status line does not say cancelled.** The
   query is interrupted and the range is put back, but DuckDB's interrupt
   reaches `_runTrendLazyBatch` as a plain `Error`, not an `AbortError`
   (`_interactiveQueryUnlocked` does not turn it into one, as `_streamSql`
   does); the batch logs *"[trend] lazy query failed"* and repaints, and the
   repaint writes *"Segments: 1"* over *"Calculation cancelled…"*.
   `scripts/e2e-analysis-cancel.mjs` does not see it: its hung queries reject
   with an `AbortError` of their own.
4. **2D curve fit, in memory: Cancel does not put the range back.** The status
   says *"the previous result and its settings are back"* and the curve is the
   previous one, but the bound that was typed stays typed: the settings of the
   new request had already been noted as those of the result on screen
   (`_rememberAnalysisSettings`, from a status line written before the fit
   ran). The cancel e2e covers lazy files only.
5. **Temporal profile, in memory: after the automatic preview is widened back
   to the whole file, the range block still shows the preview.** The state is
   `rangeFull: true` and the profile is of the whole file, but *Selection*
   stays pressed and the two sliders stay on the 262 144-sample block.
6. **The Cross-correlation tool refuses a lazy file past 8 M rows**
   (`LAZY_XCORR_MAX_ROWS`), as documented; picking the tool on the 10 M file
   first spends 14 s measuring its time axis (four aggregate queries, none
   with a cancel signal).

## Not measured

- **The paint with a GPU.** Everything here is software WebGL; the *in Plotly*
  and *no JS* columns say little about a real screen.
- **The selection dragged on the plot itself.** The range was changed through
  the range block's fields and sliders. Dragging the green band on the time
  pane goes through each analysis' own pointer handlers, which redraw while
  the pointer moves; that was not driven.
- **More than one signal, fit, segment or pair, and panels of several files.**
  One of each. The cost of the kernels grows with their number.
- **Parquet, and the other formats.** CSV only. A lazy CSV is a view over
  `read_csv` with no index, which is why every SQL analysis rescans the file
  (3–18 s at 10 M rows); Parquet reads differently.
- **Files past 10 M rows**, and the sizes in between — in particular where the
  automatic preview of an in-memory analysis stops being widened back (its
  projection passes 5 s).
- **Integral on a lazy file with a numeric axis** (refused) **and on the lazy
  10 M calendar file** (fails): there is no computation to time.
- **The Cross-correlation tool on the lazy 10 M file** (refused past 8 M rows).
- **The panel's statistics (Σ), the exports (CSV, WAV), the dashboard, the
  state band, the 3D and animated plots, the phone layout**: not analyses of
  the menu.
- **Other browsers.** Chromium only.

## Full results

The second run of the whole matrix. Times in ms; bold: over 250 ms.

Under each table, *What held the thread* names, for the task with the most
computation, the chain of app functions the time was spent under (outermost
first) and the code that was running, with its self time — one line per file,
mode and function found running, for the action where it ran longest.

In the note of a `cancel` row, *"could not be pressed"* means the page could
not be asked where the pill was until the result had come: the thread was held
from the frame after the pill was drawn. *"Too late"* means the press was sent
and landed after the pill had gone.

### Time series (the plot itself)

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.2 M | lazy | open | 22 | 145 | 1 | 169 | 164 | 113 |  |  |
| 1.2 M | eager | open | 91 | 105 | 1 | 197 | 183 | 206 |  |  |
| 10.0 M | lazy | open | 17 | 106 | 1 | 124 | 124 | 90 |  |  |
| 10.0 M | eager | open | **331** | 95 | 6 | **432** | 418 | 450 |  |  |

What held the thread:

- **10.0 M, eager, open**: a task of 432 ms, 331 ms of it computation. Under `_createChart (src/plots/plot-manager.js:1933)` → `proto._buildPlotData (src/plots/methods/data-methods.js:1859)` → `proto._buildTimeLayout (src/plots/methods/data-methods.js:2416)` → `_finiteExtent (src/plots/plot-manager.js:4491)`. Self: `_finiteExtent (src/plots/plot-manager.js:4491)` 111 ms, `decimateRangeIndexes (src/compute/kernels/resample.js:37)` 71 ms, `isNonDecreasing (src/utils/nan-strip.js:54)` 51 ms, `analyzeAudioSampling (src/plots/methods/audio-methods.js:168)` 42 ms.

### FFT

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.2 M | lazy | open | 37 | 214 | 277 | **278** | 271 | 2761 |  |  |
| 1.2 M | lazy | type | 12 | 44 | 237 | 237 | 221 | 1266 |  |  |
| 1.2 M | lazy | param: window: none → Hann | 9 | 61 | 273 | **273** | 257 | 1436 |  |  |
| 1.2 M | lazy | drag | 7 | 66 | 246 | 247 | 229 | 1029 | yes: aborted 0 ms after, ended 9 ms later | slider events waited ≤ 5 ms |
| 1.2 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | 4 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 1.2 M | eager | open | 131 | 200 | 280 | **280** | 263 | 1339 |  |  |
| 1.2 M | eager | type | 14 | 44 | 289 | **290** | 273 | 830 |  |  |
| 1.2 M | eager | param: window: none → Hann | 8 | 60 | 268 | **268** | 251 | 993 |  |  |
| 1.2 M | eager | drag | 6 | 68 | 257 | **257** | 239 | 622 | yes: its worker is terminated | slider events waited ≤ 6 ms |
| 1.2 M | eager | cancel | 0 | 0 | 0 | 0 | 0 | 3 |  | cancelled; the range is back |
| 10.0 M | lazy | open | 93 | 245 | 378 | **379** | 362 | 17376 |  |  |
| 10.0 M | lazy | type | 42 | 37 | 251 | **252** | 235 | 9416 |  |  |
| 10.0 M | lazy | param: window: none → Hann | 46 | 58 | 274 | **274** | 259 | 9332 |  |  |
| 10.0 M | lazy | drag | 28 | 54 | 249 | 249 | 233 | 7564 | yes: aborted 1 ms after, ended 21 ms later | slider events waited ≤ 4 ms |
| 10.0 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | 11 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 10.0 M | eager | open | **266** | 265 | 357 | **534** | 524 | 705 |  | range: 3 % of the file |
| 10.0 M | eager | type | 84 | 78 | 264 | **264** | 248 | 6124 |  |  |
| 10.0 M | eager | param: window: none → Hann | 114 | 73 | 263 | **264** | 251 | 6200 |  |  |
| 10.0 M | eager | drag | 60 | 77 | 310 | **310** | 294 | 4259 | yes: its worker is terminated | slider events waited ≤ 106 ms |
| 10.0 M | eager | cancel | 90 | 0 | 0 | 90 | 76 | 19 |  | cancelled; the range is back |

What held the thread:

- **10.0 M, eager, open**: a task of 534 ms, 266 ms of it computation. Under `proto._refreshFftSpectrumPlot (src/plots/methods/fft-methods.js:1457)` → `proto._computeFftSpectrumForSeries (src/plots/methods/fft-methods.js:2040)` → `computeAmplitudeSpectrum (src/utils/fft.js:411)` → `analyzeSampling (src/utils/fft.js:339)` → `median (src/utils/fft.js:695)`. Self: `median (src/utils/fft.js:695)` 123 ms, `(garbage collector)` 31 ms, `fftRadix2 (src/utils/fft.js:202)` 28 ms, `computeAmplitudeSpectrum (src/utils/fft.js:411)` 25 ms.

### Histogram

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.2 M | lazy | open | **662** | 69 | 1 | **686** | 674 | 1369 |  |  |
| 1.2 M | lazy | type | **619** | 17 | 1 | **636** | 623 | 1476 |  |  |
| 1.2 M | lazy | param: bins: auto → 40 | **571** | 16 | 1 | **588** | 589 | 1352 |  |  |
| 1.2 M | lazy | drag | **306** | 20 | 0 | **326** | 312 | 955 | yes: aborted 159 ms after, ended 122 ms later | slider events waited ≤ 4 ms |
| 1.2 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | 4 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 1.2 M | eager | open | **1028** | 135 | 1 | **1051** | 1040 | 1235 |  |  |
| 1.2 M | eager | type | **545** | 15 | 0 | **560** | 546 | 728 |  |  |
| 1.2 M | eager | param: bins: auto → 40 | **555** | 16 | 1 | **572** | 559 | 728 |  |  |
| 1.2 M | eager | drag | **343** | 16 | 1 | **360** | 348 | 529 | no: on the main thread, which it held 702 ms | slider events waited ≤ 702 ms |
| 1.2 M | eager | cancel | **453** | 15 | 1 | **470** | 458 | — |  | could not be pressed: the thread was held until the result came, 635 ms after the change |
| 10.0 M | lazy | open | **1673** | 75 | 2 | **1675** | 1665 | 15242 |  |  |
| 10.0 M | lazy | type | **1204** | 0 | 0 | **1204** | 1189 | 13148 |  |  |
| 10.0 M | lazy | param: bins: auto → 40 | 0 | 0 | 0 | 0 | 0 | 8122 |  |  |
| 10.0 M | lazy | drag | **965** | 0 | 0 | **965** | 953 | 10646 | yes: aborted 170 ms after, ended 179 ms later | slider events waited ≤ 1 ms |
| 10.0 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | 2 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 10.0 M | eager | open | **1724** | 137 | 3 | **1756** | 1744 | 2169 |  |  |
| 10.0 M | eager | type | **1498** | 16 | 1 | **1515** | 1502 | 1682 |  |  |
| 10.0 M | eager | param: bins: auto → 40 | **1374** | 15 | 0 | **1389** | 1375 | 1557 |  |  |
| 10.0 M | eager | drag | **1150** | 19 | 1 | **1169** | 1157 | 1342 | no: on the main thread, which it held 1311 ms | slider events waited ≤ 1311 ms |
| 10.0 M | eager | cancel | **1394** | 17 | 0 | **1411** | 1398 | — |  | could not be pressed: the thread was held until the result came, 1579 ms after the change |

What held the thread:

- **1.2 M, lazy, open**: a task of 686 ms, 662 ms of it computation. Under `proto._lazyHistogramStats (src/plots/methods/histogram-lazy-methods.js:158)` → `histogramFiniteStats (src/utils/histogram.js:57)`. Self: `histogramFiniteStats (src/utils/histogram.js:57)` 344 ms, `(anonymous) (src/utils/histogram.js:96)` 231 ms, `(garbage collector)` 65 ms.
- **1.2 M, lazy, param: bins: auto → 40**: a task of 588 ms, 571 ms of it computation. Under `proto._lazyHistogramStats (src/plots/methods/histogram-lazy-methods.js:158)`. Self: `proto._lazyHistogramStats (src/plots/methods/histogram-lazy-methods.js:158)` 305 ms, `(anonymous) (src/utils/histogram.js:96)` 196 ms, `(garbage collector)` 62 ms.
- **1.2 M, eager, open**: a task of 1051 ms, 1028 ms of it computation. Under `proto._recomputeHistogram (src/plots/methods/histogram-methods.js:535)` → `proto._recomputeHistogramNow (src/plots/methods/histogram-methods.js:563)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)` → `histogramFiniteStats (src/utils/histogram.js:57)`. Self: `histogramFiniteStats (src/utils/histogram.js:57)` 584 ms, `(anonymous) (src/utils/histogram.js:96)` 298 ms, `(garbage collector)` 124 ms.
- **1.2 M, eager, param: bins: auto → 40**: a task of 572 ms, 555 ms of it computation. Under `proto._recomputeHistogram (src/plots/methods/histogram-methods.js:535)` → `proto._recomputeHistogramNow (src/plots/methods/histogram-methods.js:563)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)`. Self: `(anonymous) (src/plots/methods/histogram-methods.js:605)` 308 ms, `(anonymous) (src/utils/histogram.js:96)` 173 ms, `(garbage collector)` 57 ms.
- **10.0 M, lazy, open**: a task of 1675 ms, 1673 ms of it computation. Under `proto._lazyHistogramStats (src/plots/methods/histogram-lazy-methods.js:158)` → `histogramFiniteStats (src/utils/histogram.js:57)`. Self: `histogramFiniteStats (src/utils/histogram.js:57)` 905 ms, `(anonymous) (src/utils/histogram.js:96)` 632 ms, `(garbage collector)` 131 ms.
- **10.0 M, eager, open**: a task of 1756 ms, 1724 ms of it computation. Under `proto._recomputeHistogram (src/plots/methods/histogram-methods.js:535)` → `proto._recomputeHistogramNow (src/plots/methods/histogram-methods.js:563)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)` → `histogramFiniteStats (src/utils/histogram.js:57)`. Self: `histogramFiniteStats (src/utils/histogram.js:57)` 1008 ms, `(anonymous) (src/utils/histogram.js:96)` 567 ms, `countHistogramBins (src/utils/histogram.js:208)` 74 ms.
- **10.0 M, eager, type**: a task of 1515 ms, 1498 ms of it computation. Under `proto._recomputeHistogram (src/plots/methods/histogram-methods.js:535)` → `proto._recomputeHistogramNow (src/plots/methods/histogram-methods.js:563)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)`. Self: `(anonymous) (src/plots/methods/histogram-methods.js:605)` 754 ms, `(anonymous) (src/utils/histogram.js:96)` 522 ms, `(garbage collector)` 118 ms.

### Heatmap

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.2 M | lazy | open | 28 | 180 | 1 | 208 | 203 | 1452 |  |  |
| 1.2 M | lazy | type | 0 | 0 | 0 | 0 | 0 | 1369 |  |  |
| 1.2 M | lazy | param: week × day → day × hour | 23 | 50 | 1 | 73 | 69 | 1938 |  |  |
| 1.2 M | lazy | drag | 0 | 0 | 0 | 0 | 0 | 1807 | no: 1 of 1 read ran to its end | slider events waited ≤ 1 ms |
| 1.2 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | 3 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 1.2 M | eager | open | **377** | 184 | 2 | **406** | 394 | 654 |  |  |
| 1.2 M | eager | type | **382** | 16 | 0 | **398** | 384 | 565 |  |  |
| 1.2 M | eager | param: week × day → day × hour | **510** | 61 | 1 | **573** | 560 | 738 |  |  |
| 1.2 M | eager | drag | 189 | 21 | 1 | 211 | 197 | 220 | no: on the main thread, which it held 424 ms | slider events waited ≤ 424 ms |
| 1.2 M | eager | cancel | 250 | 14 | 4 | **268** | 254 | — |  | could not be pressed: the thread was held until the result came, 437 ms after the change |
| 10.0 M | lazy | open | 28 | 103 | 1 | 121 | 118 | 11532 |  |  |
| 10.0 M | lazy | type | 19 | 46 | 1 | 65 | 60 | 10843 |  |  |
| 10.0 M | lazy | param: week × day → day × hour | 144 | 51 | 0 | 195 | 196 | 15852 |  |  |
| 10.0 M | lazy | drag | 0 | 0 | 0 | 0 | 33 | 20519 | no: 1 of 1 read ran to its end | slider events waited ≤ 3 ms |
| 10.0 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | 4 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 10.0 M | eager | open | **2861** | 199 | 4 | **2899** | 2887 | 3333 |  |  |
| 10.0 M | eager | type | **2624** | 25 | 0 | **2650** | 2637 | 2824 |  |  |
| 10.0 M | eager | param: week × day → day × hour | **2807** | 43 | 1 | **2851** | 2837 | 3012 |  |  |
| 10.0 M | eager | drag | **2134** | 24 | 1 | **2159** | 2145 | 2170 | no: on the main thread, which it held 2633 ms | slider events waited ≤ 2633 ms |
| 10.0 M | eager | cancel | **2375** | 22 | 0 | **2398** | 2385 | — |  | could not be pressed: the thread was held until the result came, 2562 ms after the change |

What held the thread:

- **1.2 M, eager, param: week × day → day × hour**: a task of 573 ms, 510 ms of it computation. Under `proto._recomputeCalendarHeatmap (src/plots/methods/heatmap-methods.js:928)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)` → `buildCalendarHeatmap (src/utils/calendar-heatmap.js:766)` → `aggregateCalendarHeatmap (src/utils/calendar-heatmap.js:264)`. Self: `aggregateCalendarHeatmap (src/utils/calendar-heatmap.js:264)` 171 ms, `ensure (src/utils/calendar-heatmap.js:368)` 155 ms, `calendarHeatmapCellCore (src/utils/calendar-heatmap.js:147)` 49 ms, `floorUtcHour (src/utils/calendar-heatmap.js:91)` 32 ms.
- **10.0 M, eager, open**: a task of 2899 ms, 2861 ms of it computation. Under `proto._recomputeCalendarHeatmap (src/plots/methods/heatmap-methods.js:928)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)` → `buildCalendarHeatmap (src/utils/calendar-heatmap.js:766)` → `aggregateCalendarHeatmap (src/utils/calendar-heatmap.js:264)`. Self: `aggregateCalendarHeatmap (src/utils/calendar-heatmap.js:264)` 981 ms, `ensure (src/utils/calendar-heatmap.js:368)` 758 ms, `utcIsoDayParts (src/utils/calendar-heatmap.js:103)` 408 ms, `buildCalendarHeatmap (src/utils/calendar-heatmap.js:766)` 156 ms.
- **10.0 M, eager, drag**: a task of 2159 ms, 2134 ms of it computation. Under `proto._recomputeCalendarHeatmap (src/plots/methods/heatmap-methods.js:928)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)` → `buildCalendarHeatmap (src/utils/calendar-heatmap.js:766)`. Self: `buildCalendarHeatmap (src/utils/calendar-heatmap.js:766)` 825 ms, `aggregateCalendarHeatmap (src/utils/calendar-heatmap.js:264)` 727 ms, `utcIsoDayParts (src/utils/calendar-heatmap.js:103)` 208 ms, `floorUtcDay (src/utils/calendar-heatmap.js:97)` 92 ms.

### Temporal profile

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.2 M | lazy | open | 20 | 118 | 0 | 138 | 129 | 2088 |  |  |
| 1.2 M | lazy | type | 0 | 0 | 0 | 0 | 41 | 2408 |  |  |
| 1.2 M | lazy | param: period: day → week | 0 | 0 | 0 | 0 | 35 | 1845 |  |  |
| 1.2 M | lazy | drag | 0 | 0 | 0 | 0 | 0 | 1652 | no: 1 of 1 read ran to its end | slider events waited ≤ 0 ms |
| 1.2 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | 4 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 1.2 M | eager | open | **446** | 129 | 1 | **470** | 458 | 646 |  |  |
| 1.2 M | eager | type | **365** | 15 | 0 | **380** | 367 | 532 |  |  |
| 1.2 M | eager | param: period: day → week | **459** | 36 | 1 | **495** | 481 | 619 |  |  |
| 1.2 M | eager | drag | 162 | 15 | 0 | 177 | 163 | 332 | no: on the main thread, which it held 453 ms | slider events waited ≤ 453 ms |
| 1.2 M | eager | cancel | **305** | 16 | 0 | **321** | 308 | — |  | could not be pressed: the thread was held until the result came, 471 ms after the change |
| 10.0 M | lazy | open | 17 | 102 | 1 | 121 | 112 | 17644 |  |  |
| 10.0 M | lazy | type | 0 | 0 | 0 | 0 | 35 | 17997 |  |  |
| 10.0 M | lazy | param: period: day → week | 0 | 0 | 0 | 0 | 0 | 17102 |  |  |
| 10.0 M | lazy | drag | 0 | 0 | 0 | 0 | 0 | 32968 | no: 1 of 1 read ran to its end | slider events waited ≤ 4 ms |
| 10.0 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | 3 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 10.0 M | eager | open | **2809** | 149 | 5 | **2834** | 2821 | 3293 |  | the whole file: the automatic preview was widened back (the range block still shows the preview: “Other defects”, 5) |
| 10.0 M | eager | type | **2812** | 21 | 7 | **2839** | 2825 | 2984 |  |  |
| 10.0 M | eager | param: period: day → week | **3359** | 44 | 4 | **3407** | 3394 | 3521 |  |  |
| 10.0 M | eager | drag | **3757** | 21 | 10 | **3788** | 3775 | 3921 | no: on the main thread, which it held 3461 ms | slider events waited ≤ 3461 ms |
| 10.0 M | eager | cancel | **2629** | 13 | 9 | **2651** | 2638 | — |  | could not be pressed: the thread was held until the result came, 2798 ms after the change |

What held the thread:

- **1.2 M, eager, open**: a task of 470 ms, 446 ms of it computation. Under `proto._recomputeTemporalProfile (src/plots/methods/temporal-profile-methods.js:702)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)` → `buildTemporalProfile (src/utils/temporal-profile.js:285)` → `periodInfo (src/utils/temporal-profile.js:101)` → `floorUtcDay (src/utils/temporal-profile.js:44)`. Self: `floorUtcDay (src/utils/temporal-profile.js:44)` 140 ms, `buildTemporalProfile (src/utils/temporal-profile.js:285)` 135 ms, `periodInfo (src/utils/temporal-profile.js:101)` 77 ms, `(garbage collector)` 34 ms.
- **1.2 M, eager, param: period: day → week**: a task of 495 ms, 459 ms of it computation. Under `proto._recomputeTemporalProfile (src/plots/methods/temporal-profile-methods.js:702)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)` → `buildTemporalProfile (src/utils/temporal-profile.js:285)`. Self: `buildTemporalProfile (src/utils/temporal-profile.js:285)` 175 ms, `floorUtcDay (src/utils/temporal-profile.js:44)` 145 ms, `floorUtcWeek (src/utils/temporal-profile.js:49)` 78 ms.
- **10.0 M, eager, type**: a task of 2839 ms, 2812 ms of it computation. Under `proto._recomputeTemporalProfile (src/plots/methods/temporal-profile-methods.js:702)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)` → `buildTemporalProfile (src/utils/temporal-profile.js:285)` → `periodInfo (src/utils/temporal-profile.js:101)` → `floorUtcDay (src/utils/temporal-profile.js:44)`. Self: `floorUtcDay (src/utils/temporal-profile.js:44)` 1117 ms, `buildTemporalProfile (src/utils/temporal-profile.js:285)` 903 ms, `periodInfo (src/utils/temporal-profile.js:101)` 509 ms.
- **10.0 M, eager, drag**: a task of 3788 ms, 3757 ms of it computation. Under `proto._recomputeTemporalProfile (src/plots/methods/temporal-profile-methods.js:702)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)` → `buildTemporalProfile (src/utils/temporal-profile.js:285)`. Self: `buildTemporalProfile (src/utils/temporal-profile.js:285)` 1354 ms, `floorUtcDay (src/utils/temporal-profile.js:44)` 1282 ms, `periodInfo (src/utils/temporal-profile.js:101)` 665 ms, `binIndexForTimestamp (src/utils/temporal-profile.js:327)` 163 ms.

### Integral

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.2 M | lazy | open | 9 | 97 | 1 | 106 | 104 | 124 |  | the app says: “a: this large (lazy) signal has no exact source column, or its file has no calendar time axis” |
| 1.2 M | lazy | type | 0 | 0 | 0 | 0 | 0 | 166 |  | the app says: “a: this large (lazy) signal has no exact source column, or its file has no calendar time axis” |
| 1.2 M | lazy | param: trapezoidal → rectangular | 0 | 0 | 0 | 0 | 0 | 177 |  |  |
| 1.2 M | lazy | drag | 0 | 0 | 0 | 0 | 0 | 175 | nothing in flight | the typed range was not in flight when the drag began; slider events waited ≤ 1 ms |
| 1.2 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | — |  | no pill to press: the result came first, 175 ms after the change |
| 1.2 M | eager | open | 137 | 101 | 1 | 167 | 159 | 307 |  |  |
| 1.2 M | eager | type | 69 | 13 | 0 | 82 | 70 | 251 |  |  |
| 1.2 M | eager | param: trapezoidal → rectangular | 104 | 13 | 0 | 117 | 104 | 278 |  |  |
| 1.2 M | eager | drag | 48 | 15 | 0 | 63 | 51 | 226 | nothing in flight | slider events waited ≤ 57 ms |
| 1.2 M | eager | cancel | 0 | 0 | 0 | 0 | 0 | 3 |  | cancelled; the range is back |
| 10.0 M | lazy | open | 8 | 99 | 0 | 107 | 95 | 118 |  | the app says: “a: this large (lazy) signal has no exact source column, or its file has no calendar time axis” |
| 10.0 M | lazy | type | 0 | 0 | 0 | 0 | 36 | 177 |  | the app says: “a: this large (lazy) signal has no exact source column, or its file has no calendar time axis” |
| 10.0 M | lazy | param: trapezoidal → rectangular | 0 | 0 | 0 | 0 | 0 | 183 |  |  |
| 10.0 M | lazy | drag | 0 | 0 | 0 | 0 | 0 | 182 | nothing in flight | the typed range was not in flight when the drag began; slider events waited ≤ 2 ms |
| 10.0 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | — |  | no pill to press: the result came first, 186 ms after the change |
| 10.0 M | eager | open | **771** | 201 | 4 | **793** | 783 | 1224 |  |  |
| 10.0 M | eager | type | **1186** | 13 | 10 | **1209** | 1197 | 1385 |  |  |
| 10.0 M | eager | param: trapezoidal → rectangular | **811** | 10 | 1 | **821** | 808 | 980 |  |  |
| 10.0 M | eager | drag | **352** | 17 | 1 | **370** | 357 | 542 | no: on the main thread, which it held 538 ms | slider events waited ≤ 538 ms |
| 10.0 M | eager | cancel | **506** | 15 | 0 | **521** | 510 | — |  | could not be pressed: the thread was held until the result came, 685 ms after the change |

What held the thread:

- **10.0 M, eager, type**: a task of 1209 ms, 1186 ms of it computation. Under `proto._recomputeIntegral (src/plots/methods/integral-methods.js:920)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)` → `computeDefiniteIntegral (src/compute/kernels/definite-integral.js:557)` → `scanGaps (src/compute/kernels/definite-integral.js:277)` → `detectSamplingGaps (src/utils/sampling-gaps.js:60)` → `medianInPlace (src/utils/sampling-gaps.js:172)` → `selectKth (src/utils/sampling-gaps.js:143)`. Self: `selectKth (src/utils/sampling-gaps.js:143)` 367 ms, `computeDefiniteIntegral (src/compute/kernels/definite-integral.js:557)` 287 ms, `medianInPlace (src/utils/sampling-gaps.js:172)` 229 ms, `detectSamplingGaps (src/utils/sampling-gaps.js:60)` 147 ms.
- **10.0 M, eager, param: trapezoidal → rectangular**: a task of 821 ms, 811 ms of it computation. Under `proto._recomputeIntegral (src/plots/methods/integral-methods.js:920)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)` → `computeDefiniteIntegral (src/compute/kernels/definite-integral.js:557)`. Self: `computeDefiniteIntegral (src/compute/kernels/definite-integral.js:557)` 303 ms, `selectKth (src/utils/sampling-gaps.js:143)` 167 ms, `scanGaps (src/compute/kernels/definite-integral.js:277)` 141 ms, `proto._integralSeriesForTrace (src/plots/methods/integral-methods.js:902)` 78 ms.
- **10.0 M, eager, cancel**: a task of 521 ms, 506 ms of it computation. Under `proto._recomputeIntegral (src/plots/methods/integral-methods.js:920)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)`. Self: `(anonymous) (src/plots/methods/integral-methods.js:985)` 252 ms, `detectSamplingGaps (src/utils/sampling-gaps.js:60)` 104 ms, `proto._integralSeriesForTrace (src/plots/methods/integral-methods.js:902)` 83 ms, `medianInPlace (src/utils/sampling-gaps.js:172)` 44 ms.

### Integral (calendar axis)

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.2 M | lazy | open | 21 | 146 | 1 | 167 | 158 | 4713 |  |  |
| 1.2 M | lazy | type | 0 | 0 | 0 | 0 | 0 | 3761 |  |  |
| 1.2 M | lazy | param: group by: none → day | 5 | 56 | 0 | 61 | 58 | 3561 |  |  |
| 1.2 M | lazy | drag | 0 | 0 | 0 | 0 | 0 | 5985 | no: 1 of 1 read ran to its end | slider events waited ≤ 2 ms |
| 1.2 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | 2 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 1.2 M | eager | open | 98 | 99 | 2 | 131 | 122 | 252 |  |  |
| 1.2 M | eager | type | 134 | 13 | 1 | 148 | 136 | 321 |  |  |
| 1.2 M | eager | param: group by: none → day | 195 | 35 | 1 | 230 | 221 | 388 |  |  |
| 1.2 M | eager | drag | 47 | 11 | 0 | 58 | 48 | 228 | nothing in flight | slider events waited ≤ 81 ms |
| 1.2 M | eager | cancel | 0 | 0 | 0 | 0 | 0 | 4 |  | cancelled; the range is back |
| 10.0 M | lazy | open | 18 | 119 | 1 | 138 | 135 | 15786 |  | the app says: “a: the file could not be queried for this total” |
| 10.0 M | lazy | type | 0 | 0 | 0 | 0 | 0 | 13614 |  | the app says: “a: the file could not be queried for this total” |
| 10.0 M | lazy | param: group by: none → day | 0 | 0 | 0 | 0 | 0 | 11865 |  |  |
| 10.0 M | lazy | drag | 0 | 0 | 0 | 0 | 0 | 23280 | no: 1 of 1 read ran to its end | slider events waited ≤ 1 ms |
| 10.0 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | 2 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 10.0 M | eager | open | **663** | 149 | 2 | **693** | 684 | 951 |  |  |
| 10.0 M | eager | type | **685** | 12 | 0 | **697** | 685 | 859 |  |  |
| 10.0 M | eager | param: group by: none → day | **1291** | 70 | 0 | **1361** | 1368 | 1523 |  |  |
| 10.0 M | eager | drag | **536** | 26 | 0 | **562** | 551 | 733 | no: on the main thread, which it held 613 ms | slider events waited ≤ 613 ms |
| 10.0 M | eager | cancel | **564** | 13 | 0 | **577** | 566 | — |  | could not be pressed: the thread was held until the result came, 749 ms after the change |

What held the thread:

- **10.0 M, eager, type**: a task of 697 ms, 685 ms of it computation. Under `proto._recomputeIntegral (src/plots/methods/integral-methods.js:920)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)` → `computeDefiniteIntegral (src/compute/kernels/definite-integral.js:557)`. Self: `computeDefiniteIntegral (src/compute/kernels/definite-integral.js:557)` 316 ms, `detectSamplingGaps (src/utils/sampling-gaps.js:60)` 126 ms, `(anonymous) (src/compute/kernels/definite-integral.js:247)` 81 ms, `proto._integralSeriesForTrace (src/plots/methods/integral-methods.js:902)` 78 ms.
- **10.0 M, eager, param: group by: none → day**: a task of 1361 ms, 1291 ms of it computation. Under `proto._recomputeIntegral (src/plots/methods/integral-methods.js:920)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)` → `proto._integralEagerGroups (src/plots/methods/integral-methods.js:1244)`. Self: `(anonymous) (src/plots/methods/integral-methods.js:1251)` 443 ms, `(anonymous) (src/plots/methods/integral-methods.js:985)` 331 ms, `(anonymous) (src/compute/kernels/definite-integral.js:247)` 149 ms, `proto._integralSeriesForTrace (src/plots/methods/integral-methods.js:902)` 112 ms.
- **10.0 M, eager, cancel**: a task of 577 ms, 564 ms of it computation. Under `proto._recomputeIntegral (src/plots/methods/integral-methods.js:920)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)`. Self: `(anonymous) (src/plots/methods/integral-methods.js:985)` 293 ms, `detectSamplingGaps (src/utils/sampling-gaps.js:60)` 117 ms, `proto._integralSeriesForTrace (src/plots/methods/integral-methods.js:902)` 83 ms, `(anonymous) (src/compute/kernels/definite-integral.js:247)` 56 ms.

### Curve fit

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.2 M | lazy | open | 13 | 94 | 1 | 108 | 109 | 117 |  | range: 33 % of the file |
| 1.2 M | lazy | type | 137 | 75 | 5 | 190 | 186 | 674 |  |  |
| 1.2 M | lazy | param: linear → quadratic | 165 | 90 | 8 | 233 | 222 | 819 |  |  |
| 1.2 M | lazy | param: quadratic → exponential | **2823** | 86 | 9 | **2917** | 2916 | 3297 |  |  |
| 1.2 M | lazy | drag | 83 | 70 | 0 | 143 | 144 | 665 | yes: aborted 175 ms after, ended 56 ms later | slider events waited ≤ 0 ms |
| 1.2 M | lazy | cancel | 7 | 89 | 2 | 98 | 91 | 3 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 1.2 M | eager | open | 52 | 101 | 1 | 154 | 142 | 178 |  | range: 33 % of the file |
| 1.2 M | eager | type | 131 | 99 | 1 | 231 | 219 | 224 |  |  |
| 1.2 M | eager | param: linear → quadratic | 125 | 56 | 1 | 182 | 168 | 160 |  |  |
| 1.2 M | eager | param: quadratic → exponential | **1199** | 47 | 1 | **1247** | 1233 | 1237 |  |  |
| 1.2 M | eager | drag | 70 | 55 | 0 | 125 | 112 | 241 | no: on the main thread, which it held 220 ms | slider events waited ≤ 220 ms |
| 1.2 M | eager | cancel | 104 | 77 | 0 | 181 | 168 | — |  | could not be pressed: the thread was held until the result came, 165 ms after the change |
| 10.0 M | lazy | open | 17 | 99 | 1 | 117 | 110 | 125 |  | range: 33 % of the file |
| 10.0 M | lazy | type | 81 | 68 | 0 | 81 | 75 | 10395 |  |  |
| 10.0 M | lazy | param: linear → quadratic | 62 | 88 | 1 | 94 | 81 | 13975 |  |  |
| 10.0 M | lazy | param: quadratic → exponential | 102 | 53 | 2 | 102 | 88 | 185814 |  |  |
| 10.0 M | lazy | drag | 65 | 76 | 1 | 79 | 69 | 8833 | yes: aborted 182 ms after, ended 46 ms later | slider events waited ≤ 4 ms |
| 10.0 M | lazy | cancel | 3 | 56 | 1 | 60 | 50 | 1 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 10.0 M | eager | open | **377** | 134 | 8 | **519** | 514 | 651 |  | range: 33 % of the file |
| 10.0 M | eager | type | **633** | 55 | 4 | **693** | 679 | 683 |  |  |
| 10.0 M | eager | param: linear → quadratic | **879** | 57 | 5 | **941** | 928 | 918 |  |  |
| 10.0 M | eager | param: quadratic → exponential | **18576** | 58 | 6 | **18639** | 18626 | 18628 |  |  |
| 10.0 M | eager | drag | **473** | 50 | 4 | **527** | 514 | 654 | no: on the main thread, which it held 743 ms | slider events waited ≤ 743 ms |
| 10.0 M | eager | cancel | **641** | 57 | 4 | **702** | 688 | — |  | could not be pressed: the thread was held until the result came, 706 ms after the change |

What held the thread:

- **1.2 M, lazy, param: quadratic → exponential**: a task of 2917 ms, 2823 ms of it computation. Under `proto._refreshCurveFitLazy (src/plots/methods/curve-fit-methods.js:282)` → `proto._curveFitFromRows (src/plots/methods/fit-lazy-methods.js:137)` → `fitPair (src/utils/regression.js:393)` → `runPassesOnArrays (src/utils/fit-passes.js:21)` → `expFamilyFitSteps (src/utils/exp-fit.js:271)` → `brent (src/utils/exp-fit.js:214)` → `solveForRate (src/utils/exp-fit.js:88)` → `add (src/utils/exp-fit.js:105)` → `basis (src/utils/exp-fit.js:79)`. Self: `basis (src/utils/exp-fit.js:79)` 2426 ms, `add (src/utils/exp-fit.js:105)` 163 ms.
- **1.2 M, eager, param: quadratic → exponential**: a task of 1247 ms, 1199 ms of it computation. Under `proto._computeCurveFits (src/plots/methods/curve-fit-methods.js:238)` → `proto._curveFitFromRows (src/plots/methods/fit-lazy-methods.js:137)` → `fitPair (src/utils/regression.js:393)` → `runPassesOnArrays (src/utils/fit-passes.js:21)` → `expFamilyFitSteps (src/utils/exp-fit.js:271)` → `brent (src/utils/exp-fit.js:214)` → `solveForRate (src/utils/exp-fit.js:88)` → `add (src/utils/exp-fit.js:105)` → `basis (src/utils/exp-fit.js:79)`. Self: `basis (src/utils/exp-fit.js:79)` 870 ms, `add (src/utils/exp-fit.js:105)` 99 ms.
- **10.0 M, eager, type**: a task of 693 ms, 633 ms of it computation. Under `proto._computeCurveFits (src/plots/methods/curve-fit-methods.js:238)` → `proto._curveFitFromRows (src/plots/methods/fit-lazy-methods.js:137)` → `fitPair (src/utils/regression.js:393)` → `runPassesOnArrays (src/utils/fit-passes.js:21)` → `chunk (src/utils/correlation.js:53)`. Self: `chunk (src/utils/correlation.js:53)` 159 ms, `proto._curveFitFromRows (src/plots/methods/fit-lazy-methods.js:137)` 113 ms, `_finiteExtent (src/plots/plot-manager.js:4491)` 105 ms, `proto._curveFitEagerRows (src/plots/methods/curve-fit-methods.js:228)` 76 ms.
- **10.0 M, eager, param: linear → quadratic**: a task of 941 ms, 879 ms of it computation. Under `proto._computeCurveFits (src/plots/methods/curve-fit-methods.js:238)` → `proto._curveFitFromRows (src/plots/methods/fit-lazy-methods.js:137)` → `fitPair (src/utils/regression.js:393)` → `runPassesOnArrays (src/utils/fit-passes.js:21)`. Self: `chunk (src/utils/regression.js:212)` 195 ms, `runPassesOnArrays (src/utils/fit-passes.js:21)` 172 ms, `proto._curveFitFromRows (src/plots/methods/fit-lazy-methods.js:137)` 163 ms, `_finiteExtent (src/plots/plot-manager.js:4491)` 103 ms.
- **10.0 M, eager, param: quadratic → exponential**: a task of 18639 ms, 18576 ms of it computation. Under `proto._computeCurveFits (src/plots/methods/curve-fit-methods.js:238)` → `proto._curveFitFromRows (src/plots/methods/fit-lazy-methods.js:137)` → `fitPair (src/utils/regression.js:393)` → `runPassesOnArrays (src/utils/fit-passes.js:21)` → `expFamilyFitSteps (src/utils/exp-fit.js:271)` → `brent (src/utils/exp-fit.js:214)` → `solveForRate (src/utils/exp-fit.js:88)` → `add (src/utils/exp-fit.js:105)` → `basis (src/utils/exp-fit.js:79)`. Self: `basis (src/utils/exp-fit.js:79)` 15812 ms, `add (src/utils/exp-fit.js:105)` 1419 ms.
- **10.0 M, eager, drag**: a task of 527 ms, 473 ms of it computation. Under `proto._paintCurveFits (src/plots/methods/curve-fit-methods.js:394)` → `proto._refreshCurveFitResiduals (src/plots/methods/curve-fit-methods.js:620)` → `proto._buildCurveFitResidualLayout (src/plots/methods/curve-fit-methods.js:581)` → `proto._buildTimeLayout (src/plots/methods/data-methods.js:2416)`. Self: `_finiteExtent (src/plots/plot-manager.js:4491)` 109 ms, `chunk (src/utils/correlation.js:53)` 106 ms, `proto._curveFitFromRows (src/plots/methods/fit-lazy-methods.js:137)` 67 ms, `proto._curveFitEagerRows (src/plots/methods/curve-fit-methods.js:228)` 52 ms.
- **10.0 M, eager, cancel**: a task of 702 ms, 641 ms of it computation. Under `proto._computeCurveFits (src/plots/methods/curve-fit-methods.js:238)` → `proto._curveFitFromRows (src/plots/methods/fit-lazy-methods.js:137)` → `fitPair (src/utils/regression.js:393)` → `runPassesOnArrays (src/utils/fit-passes.js:21)`. Self: `runPassesOnArrays (src/utils/fit-passes.js:21)` 174 ms, `_finiteExtent (src/plots/plot-manager.js:4491)` 107 ms, `proto._curveFitFromRows (src/plots/methods/fit-lazy-methods.js:137)` 102 ms, `push (src/plots/curve-fit-state.js:168)` 66 ms.

### Trend

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.2 M | lazy | open | 12 | 81 | 0 | 93 | 88 | 921 |  | range: 33 % of the file |
| 1.2 M | lazy | type | 0 | 0 | 0 | 0 | 40 | 884 |  |  |
| 1.2 M | lazy | param: value band on | 4 | 65 | 0 | 69 | 58 | 981 |  |  |
| 1.2 M | lazy | param: exponential on | **1074** | 64 | 0 | **1126** | 1126 | 2302 |  |  |
| 1.2 M | lazy | drag | 3 | 55 | 0 | 58 | 56 | 1050 | yes: aborted 170 ms after, ended 41 ms later | slider events waited ≤ 2 ms |
| 1.2 M | lazy | cancel | 11 | 61 | 2 | 71 | 69 | 3 |  | pressed, but the status line does not say cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 1.2 M | eager | open | 53 | 78 | 3 | 113 | 101 | 168 |  | range: 33 % of the file |
| 1.2 M | eager | type | 132 | 39 | 0 | 171 | 158 | 174 |  |  |
| 1.2 M | eager | param: value band on | 177 | 80 | 0 | **257** | 243 | 201 |  |  |
| 1.2 M | eager | param: exponential on | **1228** | 62 | 0 | **1290** | 1277 | 1257 |  |  |
| 1.2 M | eager | drag | 81 | 39 | 1 | 121 | 108 | 253 | no: on the main thread, which it held 178 ms | slider events waited ≤ 178 ms |
| 1.2 M | eager | cancel | 120 | 58 | 0 | 178 | 166 | — |  | could not be pressed: the thread was held until the result came, 165 ms after the change |
| 10.0 M | lazy | open | 12 | 107 | 1 | 121 | 111 | 6119 |  | range: 33 % of the file |
| 10.0 M | lazy | type | 10 | 74 | 0 | 84 | 80 | 7697 |  |  |
| 10.0 M | lazy | param: value band on | 14 | 95 | 0 | 109 | 95 | 8011 |  |  |
| 10.0 M | lazy | param: exponential on | 89 | 64 | 1 | 89 | 82 | 196372 |  |  |
| 10.0 M | lazy | drag | 3 | 67 | 1 | 71 | 61 | 5949 | yes: aborted 165 ms after, ended 94 ms later | slider events waited ≤ 2 ms |
| 10.0 M | lazy | cancel | 7 | 90 | 4 | 101 | 105 | 13 |  | pressed, but the status line does not say cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 10.0 M | eager | open | **318** | 91 | 5 | **346** | 333 | 574 |  | range: 33 % of the file |
| 10.0 M | eager | type | **864** | 57 | 1 | **922** | 909 | 911 |  |  |
| 10.0 M | eager | param: value band on | **1040** | 47 | 0 | **1087** | 1074 | 1081 |  |  |
| 10.0 M | eager | param: exponential on | **18851** | 48 | 0 | **18899** | 18886 | 18874 |  |  |
| 10.0 M | eager | drag | **547** | 36 | 0 | **583** | 570 | 713 | no: on the main thread, which it held 776 ms | slider events waited ≤ 776 ms |
| 10.0 M | eager | cancel | **546** | 37 | 0 | **583** | 569 | — |  | could not be pressed: the thread was held until the result came, 574 ms after the change |

What held the thread:

- **1.2 M, lazy, param: exponential on**: a task of 1126 ms, 1074 ms of it computation. Under `proto._trendLazyExpFit (src/plots/methods/trend-lazy-methods.js:572)` → `fitPair (src/utils/regression.js:393)` → `runPassesOnArrays (src/utils/fit-passes.js:21)` → `expFamilyFitSteps (src/utils/exp-fit.js:271)` → `brent (src/utils/exp-fit.js:214)` → `solveForRate (src/utils/exp-fit.js:88)` → `add (src/utils/exp-fit.js:105)` → `basis (src/utils/exp-fit.js:79)`. Self: `basis (src/utils/exp-fit.js:79)` 824 ms, `add (src/utils/exp-fit.js:105)` 93 ms.
- **1.2 M, eager, param: exponential on**: a task of 1290 ms, 1228 ms of it computation. Under `proto._computeTrends (src/plots/methods/trend-lazy-methods.js:323)` → `proto._trendFromRows (src/plots/methods/trend-lazy-methods.js:260)` → `proto._trendExpFromRows (src/plots/methods/trend-lazy-methods.js:269)` → `fitPair (src/utils/regression.js:393)` → `runPassesOnArrays (src/utils/fit-passes.js:21)` → `expFamilyFitSteps (src/utils/exp-fit.js:271)` → `brent (src/utils/exp-fit.js:214)` → `solveForRate (src/utils/exp-fit.js:88)` → `add (src/utils/exp-fit.js:105)` → `basis (src/utils/exp-fit.js:79)`. Self: `basis (src/utils/exp-fit.js:79)` 898 ms, `add (src/utils/exp-fit.js:105)` 105 ms, `runPassesOnArrays (src/utils/fit-passes.js:21)` 78 ms.
- **10.0 M, eager, open**: a task of 346 ms, 318 ms of it computation. Under `proto._computeTrends (src/plots/methods/trend-lazy-methods.js:323)` → `proto._trendFromRows (src/plots/methods/trend-lazy-methods.js:260)` → `runPassesOnArrays (src/utils/fit-passes.js:21)` → `chunk (src/utils/trend-fit.js:113)`. Self: `chunk (src/utils/trend-fit.js:113)` 157 ms, `chunk (src/utils/regression.js:212)` 81 ms, `proto._trendEagerRows (src/plots/methods/trend-lazy-methods.js:252)` 31 ms, `shiftedTime (src/plots/curve-fit-state.js:113)` 18 ms.
- **10.0 M, eager, type**: a task of 922 ms, 864 ms of it computation. Under `proto._computeTrends (src/plots/methods/trend-lazy-methods.js:323)` → `proto._trendFromRows (src/plots/methods/trend-lazy-methods.js:260)` → `runPassesOnArrays (src/utils/fit-passes.js:21)` → `chunk (src/utils/trend-fit.js:113)` → `chunk (src/utils/correlation.js:53)`. Self: `chunk (src/utils/correlation.js:53)` 375 ms, `chunk (src/utils/trend-fit.js:153)` 225 ms, `runPassesOnArrays (src/utils/fit-passes.js:21)` 81 ms, `proto._trendEagerRows (src/plots/methods/trend-lazy-methods.js:252)` 74 ms.
- **10.0 M, eager, param: value band on**: a task of 1087 ms, 1040 ms of it computation. Under `proto._computeTrends (src/plots/methods/trend-lazy-methods.js:323)` → `proto._trendFromRows (src/plots/methods/trend-lazy-methods.js:260)` → `runPassesOnArrays (src/utils/fit-passes.js:21)` → `chunk (src/utils/trend-fit.js:113)` → `chunk (src/utils/correlation.js:53)`. Self: `masked (src/utils/trend-fit.js:98)` 318 ms, `chunk (src/utils/correlation.js:53)` 243 ms, `chunk (src/utils/regression.js:212)` 144 ms, `proto._trendEagerRows (src/plots/methods/trend-lazy-methods.js:252)` 91 ms.
- **10.0 M, eager, param: exponential on**: a task of 18899 ms, 18851 ms of it computation. Under `proto._computeTrends (src/plots/methods/trend-lazy-methods.js:323)` → `proto._trendFromRows (src/plots/methods/trend-lazy-methods.js:260)` → `proto._trendExpFromRows (src/plots/methods/trend-lazy-methods.js:269)` → `fitPair (src/utils/regression.js:393)` → `runPassesOnArrays (src/utils/fit-passes.js:21)` → `expFamilyFitSteps (src/utils/exp-fit.js:271)` → `brent (src/utils/exp-fit.js:214)` → `solveForRate (src/utils/exp-fit.js:88)` → `add (src/utils/exp-fit.js:105)` → `basis (src/utils/exp-fit.js:79)`. Self: `basis (src/utils/exp-fit.js:79)` 16084 ms, `add (src/utils/exp-fit.js:105)` 1381 ms.
- **10.0 M, eager, drag**: a task of 583 ms, 547 ms of it computation. Under `proto._computeTrends (src/plots/methods/trend-lazy-methods.js:323)` → `proto._trendFromRows (src/plots/methods/trend-lazy-methods.js:260)` → `runPassesOnArrays (src/utils/fit-passes.js:21)`. Self: `runPassesOnArrays (src/utils/fit-passes.js:21)` 277 ms, `chunk (src/utils/regression.js:212)` 148 ms, `proto._trendEagerRows (src/plots/methods/trend-lazy-methods.js:252)` 61 ms, `shiftedTime (src/plots/curve-fit-state.js:113)` 31 ms.

### 2D plot (trajectory b → a)

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.2 M | lazy | open | 6 | 100 | 0 | 106 | 96 | 1165 |  |  |
| 1.2 M | eager | open | 5 | 52 | 0 | 57 | 51 | 33 |  |  |
| 10.0 M | lazy | open | 0 | 0 | 0 | 0 | 50 | 6634 |  |  |
| 10.0 M | eager | open | 11 | 40 | 0 | 51 | 44 | 34 |  |  |

### Correlation (pairs)

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.2 M | lazy | open | 12 | 48 | 1 | 61 | 52 | 644 |  |  |
| 1.2 M | lazy | type | 0 | 0 | 0 | 0 | 0 | 419 |  |  |
| 1.2 M | lazy | drag | 0 | 0 | 0 | 0 | 0 | 664 | no: 1 of 1 read ran to its end | slider events waited ≤ 28 ms |
| 1.2 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | 2 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 1.2 M | eager | open | 47 | 37 | 1 | 85 | 85 | 142 |  |  |
| 1.2 M | eager | type | 44 | 11 | 0 | 55 | 43 | 70 |  |  |
| 1.2 M | eager | drag | 0 | 0 | 0 | 0 | 0 | 201 | nothing in flight | slider events waited ≤ 54 ms |
| 1.2 M | eager | cancel | 0 | 0 | 0 | 0 | 0 | 2 |  | cancelled; the range is back |
| 10.0 M | lazy | open | 11 | 44 | 1 | 56 | 51 | 3641 |  |  |
| 10.0 M | lazy | type | 0 | 0 | 0 | 0 | 0 | 3608 |  |  |
| 10.0 M | lazy | drag | 0 | 0 | 0 | 0 | 0 | 6941 | no: 1 of 1 read ran to its end | slider events waited ≤ 22 ms |
| 10.0 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | 2 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 10.0 M | eager | open | **358** | 38 | 14 | **378** | 364 | 686 |  |  |
| 10.0 M | eager | type | 250 | 7 | 0 | **257** | 243 | 273 |  |  |
| 10.0 M | eager | drag | 174 | 7 | 0 | 181 | 169 | 349 | no: on the main thread, which it held 313 ms | slider events waited ≤ 313 ms |
| 10.0 M | eager | cancel | 232 | 10 | 0 | 242 | 229 | — |  | could not be pressed: the thread was held until the result came, 249 ms after the change |

What held the thread:

- **10.0 M, eager, open**: a task of 378 ms, 358 ms of it computation. Under `proto._refreshCorrelationResults (src/plots/methods/correlation-methods.js:688)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)` → `pearsonCorrelation (src/utils/correlation.js:108)` → `pairwiseMoments (src/utils/correlation.js:33)` → `chunk (src/utils/correlation.js:53)`. Self: `chunk (src/utils/correlation.js:53)` 231 ms, `proto._correlationPairSeries (src/plots/methods/correlation-methods.js:616)` 93 ms, `toFinite (src/utils/correlation.js:14)` 21 ms.

### 2D curve fit

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.2 M | lazy | open | 16 | 65 | 85 | 86 | 120 | 128 |  |  |
| 1.2 M | lazy | type | 0 | 0 | 79 | 79 | 67 | 685 |  |  |
| 1.2 M | lazy | param: linear → quadratic | 0 | 0 | 74 | 74 | 70 | 1315 |  |  |
| 1.2 M | lazy | param: quadratic → exponential | **2924** | 26 | 1 | **2951** | 2937 | 3477 |  |  |
| 1.2 M | lazy | drag | 0 | 0 | 68 | 68 | 70 | 602 | yes: aborted 185 ms after, ended 13 ms later | slider events waited ≤ 59 ms |
| 1.2 M | lazy | cancel | 0 | 0 | 0 | 0 | 63 | 2 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 1.2 M | eager | open | 51 | 45 | 50 | 97 | 90 | 145 |  |  |
| 1.2 M | eager | type | 111 | 27 | 0 | 138 | 127 | 151 |  |  |
| 1.2 M | eager | param: linear → quadratic | 126 | 35 | 0 | 161 | 151 | 179 |  |  |
| 1.2 M | eager | param: quadratic → exponential | **5676** | 22 | 0 | **5698** | 5687 | 5712 |  |  |
| 1.2 M | eager | drag | 53 | 18 | 0 | 71 | 78 | 249 | no: on the main thread, which it held 137 ms | slider events waited ≤ 137 ms |
| 1.2 M | eager | cancel | 90 | 31 | 0 | 121 | 123 | — |  | too late: the pill was gone when the press landed, 137 ms after it |
| 10.0 M | lazy | open | 11 | 73 | 0 | 84 | 82 | 144 |  |  |
| 10.0 M | lazy | type | 0 | 0 | 0 | 0 | 0 | 3563 |  |  |
| 10.0 M | lazy | param: linear → quadratic | 11 | 63 | 0 | 74 | 69 | 8141 |  |  |
| 10.0 M | lazy | param: quadratic → exponential | 161 | 0 | 2 | 163 | 149 | 200298 |  |  |
| 10.0 M | lazy | drag | 0 | 0 | 0 | 0 | 38 | 3558 | yes: aborted 172 ms after, ended 7 ms later | slider events waited ≤ 33 ms |
| 10.0 M | lazy | cancel | 33 | 47 | 2 | 82 | 90 | 3 |  | cancelled; 1 of 1 read aborted, 0 still running; the range is back |
| 10.0 M | eager | open | **403** | 32 | 7 | **442** | 444 | 485 |  |  |
| 10.0 M | eager | type | **770** | 38 | 0 | **808** | 796 | 820 |  |  |
| 10.0 M | eager | param: linear → quadratic | **1001** | 21 | 0 | **1022** | 1012 | 1040 |  |  |
| 10.0 M | eager | param: quadratic → exponential | **44167** | 23 | 0 | **44190** | 44178 | 44201 |  |  |
| 10.0 M | eager | drag | **370** | 19 | 0 | **389** | 386 | 543 | no: on the main thread, which it held 668 ms | slider events waited ≤ 668 ms |
| 10.0 M | eager | cancel | **630** | 24 | 1 | **655** | 652 | 3 |  | cancelled; the range is NOT put back |

What held the thread:

- **1.2 M, lazy, param: quadratic → exponential**: a task of 2951 ms, 2924 ms of it computation. Under `fitPair (src/utils/regression.js:393)` → `runPassesOnArrays (src/utils/fit-passes.js:21)` → `expFamilyFitSteps (src/utils/exp-fit.js:271)` → `brent (src/utils/exp-fit.js:214)` → `solveForRate (src/utils/exp-fit.js:88)` → `add (src/utils/exp-fit.js:105)` → `basis (src/utils/exp-fit.js:79)`. Self: `basis (src/utils/exp-fit.js:79)` 2498 ms, `add (src/utils/exp-fit.js:105)` 196 ms.
- **1.2 M, eager, param: quadratic → exponential**: a task of 5698 ms, 5676 ms of it computation. Under `run (src/plots/methods/phase2d-fit-methods.js:1157)` → `proto._rerenderPhase2dPlot (src/plots/methods/phase2d-fit-methods.js:528)` → `proto._buildPlotData (src/plots/methods/data-methods.js:1859)` → `proto._buildPhase2DTraces (src/plots/methods/data-methods.js:2522)` → `proto._buildPhase2dFitCurveTraces (src/plots/methods/phase2d-fit-methods.js:410)` → `proto._computePhase2dFits (src/plots/methods/phase2d-fit-methods.js:200)` → `fitPair (src/utils/regression.js:393)` → `runPassesOnArrays (src/utils/fit-passes.js:21)` → `expFamilyFitSteps (src/utils/exp-fit.js:271)` → `brent (src/utils/exp-fit.js:214)` → `solveForRate (src/utils/exp-fit.js:88)` → `add (src/utils/exp-fit.js:105)` → `basis (src/utils/exp-fit.js:79)`. Self: `basis (src/utils/exp-fit.js:79)` 5042 ms, `add (src/utils/exp-fit.js:105)` 349 ms.
- **10.0 M, eager, open**: a task of 442 ms, 403 ms of it computation. Under `proto._buildPhase2dFitTimeLayout (src/plots/methods/phase2d-fit-methods.js:759)` → `proto._buildTimeLayout (src/plots/methods/data-methods.js:2416)` → `_finiteExtent (src/plots/plot-manager.js:4491)`. Self: `_finiteExtent (src/plots/plot-manager.js:4491)` 251 ms, `decimateRangeIndexes (src/compute/kernels/resample.js:37)` 123 ms, `proto._buildTimeLayout (src/plots/methods/data-methods.js:2416)` 20 ms.
- **10.0 M, eager, type**: a task of 808 ms, 770 ms of it computation. Under `run (src/plots/methods/phase2d-fit-methods.js:1157)` → `proto._rerenderPhase2dPlot (src/plots/methods/phase2d-fit-methods.js:528)` → `proto._buildPlotData (src/plots/methods/data-methods.js:1859)` → `proto._buildPhase2DTraces (src/plots/methods/data-methods.js:2522)` → `proto._buildPhase2dFitCurveTraces (src/plots/methods/phase2d-fit-methods.js:410)` → `proto._computePhase2dFits (src/plots/methods/phase2d-fit-methods.js:200)` → `fitPair (src/utils/regression.js:393)` → `runPassesOnArrays (src/utils/fit-passes.js:21)` → `chunk (src/utils/correlation.js:53)`. Self: `chunk (src/utils/correlation.js:53)` 469 ms, `proto._phase2dPairSeries (src/plots/methods/phase2d-fit-methods.js:177)` 171 ms, `proto._phase2dRangeLimitedVisual (src/plots/methods/phase2d-fit-methods.js:453)` 77 ms, `(garbage collector)` 44 ms.
- **10.0 M, eager, param: linear → quadratic**: a task of 1022 ms, 1001 ms of it computation. Under `run (src/plots/methods/phase2d-fit-methods.js:1157)` → `proto._rerenderPhase2dPlot (src/plots/methods/phase2d-fit-methods.js:528)` → `proto._buildPlotData (src/plots/methods/data-methods.js:1859)` → `proto._buildPhase2DTraces (src/plots/methods/data-methods.js:2522)` → `proto._buildPhase2dFitCurveTraces (src/plots/methods/phase2d-fit-methods.js:410)` → `proto._computePhase2dFits (src/plots/methods/phase2d-fit-methods.js:200)` → `fitPair (src/utils/regression.js:393)` → `runPassesOnArrays (src/utils/fit-passes.js:21)` → `chunk (src/utils/regression.js:212)`. Self: `chunk (src/utils/regression.js:212)` 384 ms, `chunk (src/utils/correlation.js:53)` 327 ms, `proto._phase2dPairSeries (src/plots/methods/phase2d-fit-methods.js:177)` 163 ms, `proto._phase2dRangeLimitedVisual (src/plots/methods/phase2d-fit-methods.js:453)` 73 ms.
- **10.0 M, eager, param: quadratic → exponential**: a task of 44190 ms, 44167 ms of it computation. Under `run (src/plots/methods/phase2d-fit-methods.js:1157)` → `proto._measureAnalysisKernel (src/plots/methods/interaction-methods.js:1455)` → `proto._computePhase2dFits (src/plots/methods/phase2d-fit-methods.js:200)` → `fitPair (src/utils/regression.js:393)` → `runPassesOnArrays (src/utils/fit-passes.js:21)` → `expFamilyFitSteps (src/utils/exp-fit.js:271)` → `brent (src/utils/exp-fit.js:214)` → `solveForRate (src/utils/exp-fit.js:88)` → `add (src/utils/exp-fit.js:105)` → `basis (src/utils/exp-fit.js:79)`. Self: `basis (src/utils/exp-fit.js:79)` 39630 ms, `add (src/utils/exp-fit.js:105)` 2864 ms.

### Cross-correlation (data tool)

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.2 M | lazy | open | 0 | 0 | 0 | 0 | 0 | 1669 |  | the tool is picked: its panel measures the time axis |
| 1.2 M | lazy | param: create the dataset (max lag 75) | 43 | 96 | 2 | 140 | 141 | 2125 |  | dataset created |
| 1.2 M | eager | open | 52 | 0 | 0 | 52 | 43 | 52 |  | the tool is picked: its panel measures the time axis |
| 1.2 M | eager | param: create the dataset (max lag 75) | 37 | 52 | 1 | 81 | 124 | 1528 |  | dataset created |
| 10.0 M | lazy | open | 0 | 0 | 0 | 0 | 67 | 14525 |  | the tool is picked: its panel measures the time axis |
| 10.0 M | lazy | param: create the dataset (max lag 625) | 0 | 0 | 0 | 0 | 0 | 23 |  | not created: The cross-correlation reads both signals whole, and this file has more rows than it holds in memory (8 million). Resample it to a coarser Δt |
| 10.0 M | eager | open | 230 | 0 | 0 | 230 | 218 | 230 |  | the tool is picked: its panel measures the time axis |
| 10.0 M | eager | param: create the dataset (max lag 625) | 158 | 71 | 6 | 191 | 181 | 11823 |  | dataset created |

### Audio (prepare and play)

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.2 M | lazy | open | 0 | 0 | 0 | 0 | 0 | 634 |  | playing, 1200000 frames; 4,000 Hz played at 44,100 Hz (resampled by the browser) |
| 1.2 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | 369 |  | read stopped 32 ms after |
| 1.2 M | eager | open | 0 | 0 | 0 | 0 | 47 | 63 |  | playing, 1200000 frames; 4,000 Hz played at 44,100 Hz (resampled by the browser) |
| 10.0 M | lazy | open | 65 | 0 | 1 | 66 | 49 | 4029 |  | playing, 10000000 frames; 4,000 Hz played at 44,100 Hz (resampled by the browser) |
| 10.0 M | lazy | cancel | 0 | 0 | 0 | 0 | 0 | 364 |  | read stopped 26 ms after |
| 10.0 M | eager | open | 0 | 0 | 0 | 0 | 179 | 188 |  | playing, 10000000 frames; 4,000 Hz played at 44,100 Hz (resampled by the browser) |

### Lazy fits over a 4 M-row range

The 10 M file, lazy, the range typed as 30 % … 70 % (`--range=0.3,0.7`): the
case between `FIT_MAX_LAZY_ROWS` (2 M) and `FIT_KEEP_LAZY_ROWS` (6 M), which
the 10 % … 90 % range of the matrix does not reach.

#### Curve fit

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 10.0 M | lazy | open | 12 | 105 | 1 | 117 | 112 | 128 |  | range: 33 % of the file |
| 10.0 M | lazy | type | 59 | 69 | 1 | 84 | 79 | 7276 |  |  |
| 10.0 M | lazy | param: linear → quadratic | 68 | 54 | 1 | 68 | 57 | 9979 |  |  |
| 10.0 M | lazy | param: quadratic → exponential | **10464** | 57 | 1 | **10464** | 10455 | 21080 |  |  |

What held the thread:

- **10.0 M, lazy, param: quadratic → exponential**: a task of 10464 ms, 10464 ms of it computation. Under `runPassesOnChunks (src/utils/fit-passes.js:35)` → `expFamilyFitSteps (src/utils/exp-fit.js:271)` → `brent (src/utils/exp-fit.js:214)` → `solveForRate (src/utils/exp-fit.js:88)` → `add (src/utils/exp-fit.js:105)` → `basis (src/utils/exp-fit.js:79)`. Self: `basis (src/utils/exp-fit.js:79)` 9619 ms, `add (src/utils/exp-fit.js:105)` 686 ms.

#### Trend

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 10.0 M | lazy | open | 12 | 65 | 1 | 77 | 64 | 6013 |  | range: 33 % of the file |
| 10.0 M | lazy | type | 13 | 59 | 1 | 73 | 64 | 6322 |  |  |
| 10.0 M | lazy | param: value band on | 17 | 81 | 0 | 90 | 77 | 6034 |  |  |
| 10.0 M | lazy | param: exponential on | **10751** | 59 | 1 | **10795** | 10789 | 24492 |  |  |

What held the thread:

- **10.0 M, lazy, param: exponential on**: a task of 10795 ms, 10751 ms of it computation. Under `runPassesOnChunks (src/utils/fit-passes.js:35)` → `expFamilyFitSteps (src/utils/exp-fit.js:271)` → `brent (src/utils/exp-fit.js:214)` → `solveForRate (src/utils/exp-fit.js:88)` → `add (src/utils/exp-fit.js:105)` → `basis (src/utils/exp-fit.js:79)`. Self: `basis (src/utils/exp-fit.js:79)` 9930 ms, `add (src/utils/exp-fit.js:105)` 707 ms.

#### 2D curve fit

| Rows | Mode | Action | Longest task: computation | in Plotly | no JS (render) | Longest task overall | Frame gap | Time to result | A newer request stops the one in flight | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 10.0 M | lazy | open | 10 | 56 | 0 | 66 | 57 | 114 |  |  |
| 10.0 M | lazy | type | 0 | 0 | 0 | 0 | 0 | 2837 |  |  |
| 10.0 M | lazy | param: linear → quadratic | 0 | 0 | 0 | 0 | 33 | 6314 |  |  |
| 10.0 M | lazy | param: quadratic → exponential | **10107** | 28 | 1 | **10135** | 10121 | 19915 |  |  |

What held the thread:

- **10.0 M, lazy, param: quadratic → exponential**: a task of 10135 ms, 10107 ms of it computation. Under `runPassesOnChunks (src/utils/fit-passes.js:35)` → `expFamilyFitSteps (src/utils/exp-fit.js:271)` → `brent (src/utils/exp-fit.js:214)` → `solveForRate (src/utils/exp-fit.js:88)` → `add (src/utils/exp-fit.js:105)` → `basis (src/utils/exp-fit.js:79)`. Self: `basis (src/utils/exp-fit.js:79)` 9279 ms, `add (src/utils/exp-fit.js:105)` 669 ms.

## Running it

```
npm run bench:analysis-responsiveness -- --dir=<where the CSVs go> --out=results.json
node scripts/bench-analysis-responsiveness.mjs --report=a.json,b.json
```

`--rows`, `--modes`, `--analyses` and `--actions` narrow the matrix (an
analysis is always opened and given its range first); `--range=lo,hi` changes
the range typed; `--report` prints the tables of earlier `--out` files, as
above. The CSVs are generated on the first run (710 MB for the four) and kept
in `--dir`. The whole matrix takes about 45 minutes here: 9 and 4 minutes for
the 1.2 M file lazy and eager, 23 and 8 for the 10 M one.

It is a measurement, not a check: it asserts nothing and is in no CI chain.
