# Performance optimization — measured results

Work items 1–4 from [optimization-blueprint.md](optimization-blueprint.md), one
commit each. Every number below was produced by a script in this repo and can
be reproduced.

**Machine:** Windows 11, Node v24.14.1.
**Data:** synthetic 9-signal engineering trace with injected spikes, NaN gaps,
duplicate timestamps and a time discontinuity — `scripts/gen-perf-fixtures.py`.
**Tiers:** small 150 000 rows (~11 MB), medium 1 500 000 (~118 MB),
large 7 500 000 (~590 MB).

## How to reproduce

```bash
python scripts/gen-perf-fixtures.py
```

```bash
npm run bench:data-tools -- --json bench/results/point1-data-tools.json
```

```bash
npm run bench:zoom -- --json bench/results/point2-zoom.json
```

```bash
npm run bench:parse -- --json bench/results/point3-parse.json
```

```bash
npm run bench:derived -- --json bench/results/point4-derived.json
```

Correctness is verified separately and must be read alongside the timings — a
faster kernel that returns different numbers is worthless:

```bash
npm run test:compute-kernels
```

```bash
npm run test:resample-kernel
```

```bash
npm run test:parse-worker
```

```bash
npm run test:expr-compiler
```

Both compare against frozen verbatim copies of the pre-rewrite code
(`bench/legacy-*.mjs`) and assert **bit-for-bit** equality, not approximate
agreement.

### A note on measurement method

Each measurement runs in its own child process. This is not ceremony. The
legacy spike detector allocates roughly two arrays per sample, and running it
leaves the heap in a state where V8's incremental marking bleeds into whatever
is timed next. Measured in a shared process the rewritten kernel came out at
354 ms; measured clean, the same code takes 53 ms. Sharing a process between
the two implementations understated the win by about 7×.

---

## Point 1 — Data Tools math off the main thread

**What changed**

- The four algorithms moved out of `data-tools-methods.js` into
  `src/compute/kernels/` as pure functions over `Float64Array`: no DOM, no
  i18n, no `this`, importable from a worker. They no longer open with
  `Array.from(sourceValues, Number)`, which allocated and converted a full copy
  of the column on entry even when the caller already had typed data.
- **The spike detector was rewritten.** It used to build a scratch array of the
  51-wide window for *every sample*, sort it, map it into a second array of
  absolute deviations, and sort that too — two heap allocations and ~600
  comparator calls per sample. It now keeps the window itself sorted as it
  slides, so the median is a rank lookup, and derives the MAD without
  materializing the deviations at all: against a sorted window the deviations
  form two already-ascending runs, so the median deviation is the k-th element
  of a merge of two sorted sequences — a ~27-step walk with no allocation.
- `src/core/worker-pool.js` + `src/workers/compute-worker.js` run the whole
  tool pipeline off-thread in one round-trip, with last-one-wins cancellation
  keyed per output variable (dragging the sensitivity slider supersedes the run
  already in flight instead of queueing behind it). Falls back to in-thread
  execution wherever workers are unavailable — `file://`, the Node harnesses, a
  crashed pool — so behaviour never depends on the transport.

**Measured** (`bench/results/point1-data-tools.json`)

| Operation | Tier (rows) | Before | After | Speedup |
| :--- | ---: | ---: | ---: | ---: |
| derivative/centered | small (150,000) | 6.92 ms | 3.97 ms | 1.74× |
| derivative/difference | small (150,000) | 6.17 ms | 0.57 ms | 11× |
| integral/trapezoidal | small (150,000) | 6.45 ms | 1.54 ms | 4.20× |
| movingAverage/w=21 | small (150,000) | 6.22 ms | 1.86 ms | 3.35× |
| movingAverage/w=501 | small (150,000) | 6.29 ms | 1.87 ms | 3.37× |
| outliers/iqr | small (150,000) | 50 ms | 15 ms | 3.25× |
| interpolateOutliers | small (150,000) | 7.52 ms | 1.21 ms | 6.19× |
| **outliers/spike** | small (150,000) | **931 ms** | **53 ms** | **18×** |
| derivative/centered | medium (1,500,000) | 54 ms | 15 ms | 3.71× |
| derivative/difference | medium (1,500,000) | 50 ms | 4.77 ms | 10× |
| integral/trapezoidal | medium (1,500,000) | 67 ms | 18 ms | 3.82× |
| movingAverage/w=21 | medium (1,500,000) | 66 ms | 19 ms | 3.53× |
| movingAverage/w=501 | medium (1,500,000) | 62 ms | 18 ms | 3.38× |
| outliers/iqr | medium (1,500,000) | 615 ms | 162 ms | 3.80× |
| interpolateOutliers | medium (1,500,000) | 79 ms | 11 ms | 7.38× |
| **outliers/spike** | medium (1,500,000) | **48.1 s** | **497 ms** | **97×** |
| derivative/centered | large (7,500,000) | 298 ms | 82 ms | 3.62× |
| derivative/difference | large (7,500,000) | 258 ms | 25 ms | 10× |
| integral/trapezoidal | large (7,500,000) | 324 ms | 79 ms | 4.13× |
| movingAverage/w=21 | large (7,500,000) | 337 ms | 94 ms | 3.58× |
| movingAverage/w=501 | large (7,500,000) | 418 ms | 111 ms | 3.76× |
| outliers/iqr | large (7,500,000) | 17.6 s | 1.20 s | 15× |
| interpolateOutliers | large (7,500,000) | 2.07 s | 60 ms | 35× |
| **outliers/spike** | large (7,500,000) | **311.6 s** (extrapolated) | **12.6 s** | **25×** |

The headline is the spike detector: **48 s → 0.5 s on 1.5 M rows.** That is the
operation that made the app appear to hang. The others are 3–11×, which is what
dropping the boxed-array entry conversion and the per-element closures buys.

**Two caveats, stated rather than buried**

1. The 311.6 s legacy figure at the large tier is *extrapolated* linearly from a
   measured 1.5 M-row run. Running it for real costs ~5 minutes per repetition.
   The legacy detector is linear in n at a fixed 51-wide window, so the
   extrapolation is sound, but it is not a measurement and is labelled as such
   in the JSON.
2. At the large tier only, the rewritten kernel takes ~2.5 s on its first call
   in a process and ~11–12 s on every call after it. The cold time is exactly
   linear against the 1.5 M tier — which shows no such gap at all, staying flat
   at ~510 ms across five consecutive runs. The cause was not identified: it
   survives cooldowns between runs, freshly allocated input arrays, forced GC,
   and removing every cold call site and cold allocation branch from the hot
   loop (each of which was verified with `--trace-deopt`). Half the extra time
   does not appear as user CPU at all. **The table reports the slower steady
   state**, so the 25× is a lower bound; `kernelFirstMs` in the JSON carries the
   cold number alongside it.

---

## Point 2 — the zoom path stops copying the viewport

**What changed**

`_buildTimeseriesVisualData` used to do this on every relayout event, for every
trace:

```js
const sliceX = timeData.slice(start, end);
const sliceY = values.slice(start, end);
```

Zoomed to 80 % of a 5 M-point trace that is two 4 M-element copies — made only
to throw away all but 2 000 of the elements. `src/compute/kernels/resample.js`
decimates over the `[start, end)` range in place instead. The output arrays are
still freshly allocated at their exact final size (~2 000 elements), because
Plotly keeps a reference to whatever it is handed and reusing a buffer under it
would corrupt hover; only the index scratch is shared, and it never leaves the
module.

X is deliberately not assumed numeric — `_renderedTracePreview` feeds raw Plotly
x values through this path, which on a calendar axis are strings or Dates. So
decimation reads only Y and returns indexes the caller materializes, preserving
the source type.

**Measured** (`bench/results/point2-zoom.json`) — a 15-step zoom sweep from
fully-zoomed-out to 1/1000th of the trace, on a 4-trace panel, 2 000-point
budget:

| Metric | Tier (points) | Before | After | Speedup |
| :--- | ---: | ---: | ---: | ---: |
| zoom sweep (15 steps × 4 traces) | small (150,000) | 21 ms | 9.48 ms | 2.24× |
| per zoom event | small (150,000) | 0.35 ms | 0.16 ms | 2.24× |
| worst single event | small (150,000) | 1.96 ms | 0.71 ms | 2.77× |
| zoom sweep (15 steps × 4 traces) | medium (1,500,000) | 124 ms | 63 ms | 1.98× |
| per zoom event | medium (1,500,000) | 2.07 ms | 1.05 ms | 1.98× |
| worst single event | medium (1,500,000) | 8.26 ms | 3.59 ms | 2.30× |
| zoom sweep (15 steps × 4 traces) | large (7,500,000) | 673 ms | 253 ms | 2.66× |
| per zoom event | large (7,500,000) | 11 ms | 4.21 ms | 2.66× |
| **worst single event** | large (7,500,000) | **255 ms** | **18 ms** | **14.3×** |

The number that matters is the last row. On a 7.5 M-point trace the widest
viewport — what you get when you hit "reset axes" — cost **255 ms per trace**,
about 4 fps. It now costs 18 ms, which fits inside a 30 fps frame budget and is
close to 60. Below ~1.5 M points the old path was already inside a frame, so
the gain there is real but not something a user would notice.

This confirms the audit's finding that the zoom cost was CPU-side data
marshalling, not rendering. No GPU work was involved in any of it.

---

## Point 3 — every format parses off the main thread

**What changed**

Only CSV had a worker. `.mat`, `.pkl`, `.nc` and spreadsheets all decoded
synchronously on the UI thread; the Excel path in `file-methods.js` documented
"tens of seconds of blocked main thread" in its own comment and was right.

`src/workers/parse-handlers.js` now holds one handler per format, each importing
its parser dynamically so opening a CSV does not pull h5wasm (4.4 MB) and the
xlsx bundle (500 KB) into the worker. `src/workers/parse-worker.js` is the
browser shell over it; `scripts/helpers/parse-worker-node.mjs` is the same shell
over `node:worker_threads`, which is what lets the test run the real handler
code across a real thread boundary rather than a second copy written for the
test.

Two things had to survive the move: parsed columns come back by **transfer**
rather than structured clone (~60 MB per file at the large tier that would
otherwise be duplicated and discarded), and parser-specific error fields — the
pickle parser reports `.format` and `.type`, which the UI turns into translated
messages — are serialized alongside `code` and reattached by the pool.

`src/workers/result-parser-worker.js` and its hand-rolled lifecycle are gone;
CSV goes through the same pool as everything else.

**Measured** (`bench/results/point3-parse.json`)

This benchmark does **not** measure throughput. Moving a parser to a worker does
not make it faster — a `.mat` v7.3 or an `.xlsx` has to decompress its whole
container either way. What changes is whether the interface can draw a frame
meanwhile. So the metric is event-loop lag: a timer set for every 2 ms, worst
overshoot recorded. That overshoot *is* the freeze the user sees; 16.7 ms is one
frame at 60 fps.

| Format | Tier | Size | Parse work | Blocked before | Blocked after |
| :--- | :--- | ---: | ---: | ---: | ---: |
| mat | small | 11 MB | 272 ms | **272 ms** | **29 ms** |
| pkl | small | 11 MB | 232 ms | **232 ms** | **16 ms** |
| nc | small | 11 MB | 320 ms | **320 ms** | **22 ms** |
| csv | small | 11 MB | 590 ms | **590 ms** | **70 ms** |
| xlsx | small | 18 MB | 16.6 s | **16.6 s** | **186 ms** |
| mat | medium | 114 MB | 4.00 s | **4.00 s** | **85 ms** |
| pkl | medium | 114 MB | 12.6 s | **12.6 s** | **150 ms** |
| nc | medium | 114 MB | 12.9 s | **12.9 s** | **130 ms** |
| csv | medium | 113 MB | 29.1 s | **29.1 s** | **4.36 s** |
| xlsx | medium | 126 MB | 112.7 s | **112.7 s** | **644 ms** |
| mat | large | 572 MB | 30.8 s | **30.8 s** | **1.90 s** |
| nc | large | 572 MB | 105.0 s | **105.0 s** | **1.02 s** |
| xlsx | large | 126 MB | 40.4 s | **40.4 s** | **91 ms** |

A 126 MB spreadsheet froze the interface for **112 seconds**. It now freezes it
for 0.6 s. That is the whole point of this item.

**What did not go well, stated plainly**

- **CSV at the medium tier still blocks for 4.36 s** on the way back. The legacy
  CSV parser stores columns as plain JS arrays, which have no `ArrayBuffer` to
  transfer, so the result is structured-cloned instead. Mitigating factor: in
  the real app a 113 MB CSV goes through DuckDB, not this parser, and DuckDB
  already returns typed columns from its own worker. Making the legacy parser
  emit `Float64Array` would fix it and is worth doing separately.
- **Two large-tier fixtures could not be parsed at all**, by either path. These
  are pre-existing limits, not regressions, and both are reported by the
  benchmark rather than skipped:
  - `perf-large.pkl` (572 MB): `Unsupported ndarray size 67500000` — a limit in
    the pickle parser.
  - `perf-large.csv` (563 MB): `Cannot create a string longer than 0x1fffffe8
    characters` — the ~512 MB `TextDecoder` ceiling already documented in
    `bench/baseline.md` and `docs/large-files.md`. The app routes files this
    size to DuckDB precisely because of it.
- The residual blocking in the worker column (16–190 ms at small/medium) is the
  result crossing back plus GC on the main thread. Real, but two to three orders
  of magnitude below what it replaced.

---

## Build note

`vite.config.js` gained `worker: { format: 'es' }`. The parse worker loads each
format's parser with a dynamic `import()`, making it a code-splitting build,
which Vite's default `iife` worker format cannot do. The workers were already
created with `{ type: 'module' }`, so this only makes the bundle match the
runtime.
