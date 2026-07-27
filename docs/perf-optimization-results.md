# Performance optimization — measured results

Work item 1 of 4 from [optimization-blueprint.md](optimization-blueprint.md), one
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

Correctness is verified separately and must be read alongside the timings — a
faster kernel that returns different numbers is worthless:

```bash
npm run test:compute-kernels
```

It compares against a frozen verbatim copy of the pre-rewrite code
(`bench/legacy-data-tools.mjs`) and asserts **bit-for-bit** equality, not
approximate agreement.

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
