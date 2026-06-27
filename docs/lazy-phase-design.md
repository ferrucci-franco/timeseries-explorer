# Lazy Phase Plots Design

Status: design checkpoint only. Do not implement until reviewed.

## Goal

For DuckDB/lazy files, `phase2d`, `phase2dt`, and `phase3d` must draw the real trajectory of the file, not the in-memory overview sample. Today these plots read `variables[].data`; in lazy mode that data is the overview reservoir, around 10k random rows. That is acceptable as a file overview for time-series previews, but it is not correct for phase portraits because the temporal path is part of the signal.

Eager files keep the current synchronous path unchanged.

## Non-goals

- Do not change the eager phase implementation.
- Do not change `getColumnsRange` semantics for normal time-series traces.
- Do not use bucket averages for phase.
- Do not reuse the lazy overview reservoir as the final phase data.

## Core Decision

Add a new DuckDB source method, tentatively:

```js
source.getPhaseTrajectory(legacyData, varNames, options)
```

instead of extending `getColumnsRange`.

Reason: `getColumnsRange` means "viewport-bounded time-series data" and may reduce rows with bucket `AVG`. Phase plots need a different contract: full-trajectory, row-aligned, real source samples, decimated by temporal stride.

The method should reuse existing DuckDBSource infrastructure where possible:

- `_interactiveQuery()` for cancellation.
- `_quoteIdent()` and `_numericLiteral()` for SQL safety.
- `_extractColumnAsFloat64()` for Arrow extraction.
- source-level cache bookkeeping, but with a separate phase cache namespace.

## Sampling Method

Use stride decimation over real rows in temporal order.

For the normal desktop/lazy CSV path, prefer physical file order instead of a full `ORDER BY time` sort. Microgrid result files and live-update logs are expected to be written in increasing time order, and live-update already depends on that invariant. If the file is monotonic in physical order, `ROW_NUMBER() OVER ()` can stride through the scan without forcing DuckDB-WASM to sort a multi-GB CSV.

Before trusting physical order, validate monotonicity for the time column. If monotonicity fails, do not silently run a full sort on a multi-GB CSV; either fall back only when the file/format is small enough to make the sort safe, or ask the user to convert to Parquet/use a sorted file.

For a requested visual budget `B`, select approximately every `stride`-th row from the full cropped trajectory:

```text
stride = max(1, ceil((rowCount - 1) / max(B - 1, 1)))
```

Always keep the first and last cropped row when present. Every plotted point must come from one real row in the source file.

Do not use:

- reservoir overview samples, because row gaps are random and temporal continuity is false;
- bucket `AVG(x), AVG(y), AVG(z)`, because averaging axes independently smooths and can collapse loops, limit cycles, hysteresis, and fast transitions.

The time-series lazy shortcut "overview is dense enough, skip DuckDB" is invalid for phase. At most the previous rendered phase trace can remain on screen while a new lazy trajectory is loading; the final trace must come from DuckDB stride data.

## Budget Mapping

Use `phaseVisualMaxPoints`.

- Numeric menu values map directly.
- `none` maps to the maximum numeric value exposed by the phase downsampling menu, using the same dynamic menu-limit pattern added for time-series downsampling.
- Current observed menu maximum is 10000, but implementation should read it dynamically and keep `PlotManager.MAX_MENU_VISUAL_POINTS` as the test/DOM fallback.

This keeps lazy phase monotonic and capped. "None" must not mean unlimited for lazy files.

## DuckDB Query Shape

The query covers the full file trajectory, constrained only by the file crop. It does not use the visible zoom range.

Use separate SQL steps rather than `COUNT(*) OVER ()`. A scalar `COUNT(*)` pass is streaming and cheap in memory; a global window count risks materializing too much state in WASM.

Step 0, validate that physical row order is monotonic by time:

```sql
WITH sequenced AS (
    SELECT
        {timeExpr}::DOUBLE AS t,
        LAG({timeExpr}::DOUBLE) OVER () AS previous_t
    FROM {tableName}
    WHERE {timeExpr} IS NOT NULL
)
SELECT COUNT(*)::BIGINT AS violations
FROM sequenced
WHERE previous_t IS NOT NULL
  AND t < previous_t;
```

If `violations = 0`, use the physical-order stride query below. This avoids a full sort and should behave like a streaming scan.

If `violations > 0`, the file is not in temporal order. For small inputs or already-efficient formats, a sorted fallback can be offered. For multi-GB CSV, a full `ORDER BY time` fallback is an OOM risk in WASM and should not be the default; the UI should recommend converting/sorting to Parquet instead.

While running the monotonicity guard and stride query, temporarily prefer stable physical-order settings in DuckDB (`threads=1`, `preserve_insertion_order=true`) and restore the normal WASM tuning afterwards. This keeps `ROW_NUMBER() OVER ()` tied to scan order instead of parallel chunk scheduling. Because these PRAGMA settings are connection-global, the whole `enter -> stats -> stride -> leave` sequence must run inside a serialized connection section so no other lazy time-series or phase query can interleave while the connection is in phase mode.

Step 1, count cropped rows:

```sql
SELECT COUNT(*)::BIGINT AS n
FROM {tableName}
WHERE {timeExpr} IS NOT NULL
  AND {cropPredicate};
```

Step 2, fetch the stride-selected aligned rows in physical order:

```sql
WITH ordered AS (
    SELECT
        ROW_NUMBER() OVER () - 1 AS rn,
        {timeExpr}::DOUBLE AS t,
        {xCol}::DOUBLE AS v0,
        {yCol}::DOUBLE AS v1,
        {zCol}::DOUBLE AS v2
    FROM {tableName}
    WHERE {timeExpr} IS NOT NULL
      AND {cropPredicate}
)
SELECT t, v0, v1, v2
FROM ordered
WHERE rn = 0
   OR rn = {rowCountMinusOne}
   OR rn % {stride} = 0
ORDER BY rn;
```

Do not add a `LIMIT {budget}` that can evict the last row. With `budget >= 2` and `stride = ceil((rowCount - 1) / (budget - 1))`, the predicate above selects at most `budget` rows while preserving both endpoints. Clamp lazy phase budgets to at least 2 before computing stride.

For `phase2d`, select `t, x, y`.

For `phase2dt`, select `t, x, y`; render as Plotly `x=time`, `y=xVar`, `z=yVar`. This matches the current eager implementation in `_buildPhase2DtTraces()` and its layout comment: phase2dt uses Plotly X for time, Y for the selected x variable, and Z for the selected y variable.

For `phase3d`, select `t, x, y, z`; `t` is still fetched because it drives ordering, crop validation, hover/color extensions, and transform parity.

All axis columns for a phase trace must be fetched in one query so `x[i]`, `y[i]`, `z[i]`, and `t[i]` belong to the same original row.

### SQL Notes

- `timeExpr` should match the existing DuckDB time expression: epoch milliseconds for datetime sources, raw numeric otherwise.
- `cropPredicate` should be generated in source-time units. If a crop transform cannot be inverted safely, query the full file and apply the crop again in JS; this is slower but correct.
- The public crop option for `getPhaseTrajectory()` is `sourceTimeRange`. `sourceRange` may be accepted as a deprecated alias with a warning so future tests/tools do not silently fetch the full trajectory by typo.
- `ORDER BY time` over the full file is not a harmless cost for multi-GB CSV in WASM. It can buffer/sort enough data to OOM. Treat it as a constrained fallback, not the default phase path.
- Physical-order stride also handles duplicate timestamps better than sorting only by time, because it preserves file trajectory order among equal-time rows.
- If a later path needs deterministic ordering for non-monotonic files, add a stable source-row ordinal during registration and sort by `(time, ordinal)` only for formats/sizes where that is safe.

## Transform Parity

Fetch raw numeric vectors from DuckDB and apply transforms in JS using the same logic as the eager path.

Required parity with eager:

- crop;
- time display mode;
- `timeShift`;
- variable `gain`;
- variable `yOffset`;
- generated/datetime/elapsed time behavior.

Implementation should factor the current eager helpers rather than duplicate logic:

- `_getTransformIndexData(fileId)` is the reference for crop and transformed time indexes.
- `_getTransformedTimeData(fileId)` is the reference for displayed time.
- `_getTransformedVariableData(fileId, varName)` is the reference for gain/offset.

Proposed helper shape:

```js
_transformFetchedPhaseTrajectory(fileId, rawTime, rawByVar, varNames)
```

Return transformed arrays ready for Plotly, and run a final JS crop check even when SQL already applied the crop. This guards against off-by-one or time-mode inversion mistakes.

## PlotManager Integration

The phase builders remain synchronous for eager data:

- `_buildPhase2DTraces(plot)`
- `_buildPhase2DtTraces(plot)`
- `_buildPhase3DTraces(plot)`

For lazy data, they should return either:

- the last known lazy phase result for that trace, if cache is valid; or
- an empty/previous placeholder while an async refresh is scheduled.

Then add a phase-specific refresh path, similar to lazy time-series:

```js
_refreshPhaseVisualsLazy(panelId, plot)
```

The refresh path should:

1. detect phase plots containing `data._duckdb`;
2. compute the phase target budget;
3. group requests by fileId, crop/transform key, and axis-set;
4. call `source.getPhaseTrajectory(...)`;
5. transform the fetched raw arrays in JS;
6. restyle the phase traces with Plotly;
7. relayout axis ranges from the final lazy arrays when needed.

Hook point should be the same panel lifecycle that currently calls `_refreshTimeseriesVisualsLazy(panelId, plot, range)` after plot creation/relayout, not the eager-only trace builders alone. The builders do not currently receive `panelId`, while cancellation and indicators are panel-scoped.

### Layout Extents

`_buildPhase2DLayout()` currently computes axis ranges from transformed in-memory arrays. For lazy phase, those arrays are the reservoir overview and should not define the final extents.

Design:

- initial render may use autorange or previous lazy extents;
- after the async stride fetch completes, compute finite extents from the actual lazy phase arrays and call `Plotly.relayout`;
- preserve `equalAspect2D` behavior after relayout.

## Cache and Cancellation

Add phase-specific panel tokens, separate from zoom tokens:

```js
this._phaseLazyTokens = new Map(); // panelId -> token
```

Cancellation behavior:

- increment token on plot mode change, variable change, file remove, transform change, crop change, budget change, and panel cleanup;
- cancel pending phase timers;
- call `source.cancelActiveQuery()` for active DuckDB phase queries;
- ignore stale results if token no longer matches.

Cache layers:

1. Source-level raw cache in DuckDBSource:
   - table name / file identity;
   - selected raw columns;
   - source-time crop bounds;
   - budget and stride;
   - append/version counters (`appendRows`, `appendBytes`, `totalRows` when available).

2. PlotManager transformed cache:
   - fileId;
   - phase mode;
   - axis var names;
   - budget;
   - crop;
   - time display mode;
   - `timeShift`;
   - gain/yOffset values for selected variables;
   - data version/live-update counters.

Invalidate both on file release/remove. Invalidate transformed cache on transform changes even if raw cache remains reusable.

## UX

Lazy phase should show a non-blocking loading indicator while fetching the real trajectory, similar to the lazy time-series indicator.

Suggested message: `Loading phase trajectory...`

While loading:

- keep the previous valid phase trace if one exists;
- otherwise show an empty trace/skeleton state;
- do not silently show the reservoir overview as if it were final data.

On error:

- clear the loading indicator;
- keep previous rendered data if available;
- surface a visible error consistent with existing plot/file errors.

## Tests

### DuckDB Method Tests

Create a synthetic file with known aligned rows:

```text
t = 0..N-1
x = t
y = t * 10
z = t * 100
```

Verify:

- returned rows are ordered by time;
- `x`, `y`, `z`, and `t` come from the same original row;
- `N <= budget` returns all rows;
- `N > budget` returns no more than budget rows;
- first and last cropped rows are included;
- no `LIMIT` or off-by-one behavior can drop the last row when the stride predicate already selected near-budget rows;
- `phaseVisualMaxPoints = null` maps to the dynamic max menu value/fallback.

Monotonicity/fallback cases:

- monotonic physical-order CSV uses `ROW_NUMBER() OVER ()` and does not emit a full `ORDER BY time`;
- intentionally shuffled CSV is detected as non-monotonic;
- large non-monotonic CSV does not silently take the full-sort fallback;
- small non-monotonic fixture can use the sorted fallback if that path is implemented.

### Correctness Demonstration

Create circle/spiral trajectories:

```text
t = 0..N-1
x = cos(theta)
y = sin(theta)
z = theta or radius
```

Verify stride preserves the trajectory shape:

- radius error stays near the original curve;
- phase ordering is monotonic in time;
- loop/cycle remains visible.

Add a comparison fixture or benchmark showing bucket `AVG(x), AVG(y)` shrinks/smooths the curve, justifying why phase cannot reuse time-series aggregation.

### Transform Parity Tests

On a small file that can load both eager and lazy:

- compare eager phase arrays against lazy stride arrays when `budget >= rowCount`;
- cover gain, yOffset, timeShift, crop, datetime/elapsed time modes;
- confirm JS post-crop matches eager crop behavior.

### Async/UX Tests

- lazy phase starts and clears the loading indicator;
- changing selected variables cancels/ignores stale results;
- removing a file during an active query does not restyle a dead panel;
- cache hit avoids a second DuckDB query for the same key;
- live-update append invalidates phase cache.

### Smoke Tests

After implementation, run:

- `npm run build:web`;
- existing DuckDB and live-update tests;
- desktop dev smoke with a medium CSV/Parquet;
- packaged `desktop:pack --dir` smoke because this code path touches DuckDB/lazy plotting.

Manual visual smoke:

- load a large synthetic circle/spiral file lazily;
- open `phase2d`, `phase2dt`, and `phase3d`;
- verify the plotted shape is continuous and not reservoir-dented;
- verify `phase2dt` axes match eager: Plotly X=time, Y=selected x variable, Z=selected y variable;
- change downsampling budget and verify monotonic detail increase;
- crop the file and verify phase shows the cropped trajectory only.

## Risks

- A full `ROW_NUMBER() OVER (ORDER BY time)` sort can OOM on multi-GB CSV in DuckDB-WASM. The default path must avoid it by using validated physical order.
- The monotonicity guard itself scans the time column. That is acceptable compared with sorting, but it should be cached per file/version and invalidated on append.
- Non-monotonic multi-GB CSV is a hard case. Prefer an explicit Parquet/sorted-file recommendation over an automatic sort that may crash the renderer.
- Duplicate timestamps are safer with physical-order stride than with time-only sort, but a stable row ordinal may still be useful in a later change.
- Transform parity is easy to drift if SQL applies too much transformation. Keep SQL raw and JS authoritative.
- Axis relayout must not fight user interactions after the first lazy result loads.
- Plotly 3D rendering can become heavy near the max budget; keep the cap enforced.

## Suggested Implementation Phases

1. Add `DuckDbSource.getPhaseTrajectory()` and unit tests for stride/alignment/budget.
2. Add shared JS transform helper and eager-vs-lazy parity tests.
3. Add `PlotManager._refreshPhaseVisualsLazy()` with loading, cache, cancellation, and relayout.
4. Add visual smoke tests and packaged desktop validation.

Stop here for review before coding.
