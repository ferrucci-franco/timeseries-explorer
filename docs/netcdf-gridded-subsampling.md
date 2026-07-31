# Gridded netCDF: partial load — decision pending

**Status: not in `main`.** This file records an open decision so it is not lost on a
branch. The change it describes lives on `claude/netcdf-gridded-subsampling`, cut from
`main` and unmerged. `main` still behaves the way the "today" section below describes.

## The problem

A netCDF variable shaped `[time, lat, lon]` has to be flattened into one series per
spatial point before it can be drawn as a time series. A 101 × 101 grid is **10,201
series from a single variable**, and real climate files are routinely larger.

`MAX_GENERATED_SERIES` caps a file at 10,000 generated series. That cap exists for a
reason — expanding a large grid unbounded will hang the app — but the way it was enforced
is the problem.

## What `main` does today

If expanding a variable would cross the cap, the variable is **rejected whole**:

```js
if (seriesCount < 1 || result.metadata.generatedSeriesCount + seriesCount > MAX_GENERATED_SERIES) {
    this._skip(result, descriptor, 'Expanding this variable would exceed the … safety limit.');
    continue;
}
```

So an ordinary gridded file opens with its main variable simply absent. It reads as a
failed load rather than as a deliberate limit.

## What the branch does

Loads `MAX_GENERATED_SERIES_PER_VARIABLE = 512` evenly spaced slices instead of refusing,
and records the partial load in `metadata.skippedVariables` with `partial: true`,
`generatedSeriesCount` and `availableSeriesCount`.

Covered by `scripts/test-generic-netcdf-parser.mjs` (a 2 × 101 × 101 grid must yield 512
series and report 10,201 available).

## Why it is not merged

The behaviour is a clear improvement over showing nothing. What is unsettled is that this
is the only change of its kind: **it alters what data the user sees**, not how fast they
see it. It arrived inside a branch about analysis responsiveness, where nobody reviewing
performance would have been looking for it.

Two questions to settle before it lands:

1. **Is 512 the right number?** It is a guess. Nothing measures what a grid of that size
   costs to load, to hold, or to draw. The right number may well depend on the grid, not
   be a constant.

2. **Is a tooltip enough?** The partial load reaches the UI only through the file-type
   tooltip, as a count of affected variables (`_fileTypeTooltip` in
   `src/app/methods/file-methods.js`). A user who does not hover sees a variable that
   looks complete and is not. Every analysis in the app puts this class of warning in a
   panel; this one does not.

A third thing worth knowing rather than deciding: the sampling walks the **flattened**
index, so on a lat/lon grid it thins by row order, not spatially. Fine for looking at a
field, misleading if the subset is treated as representative of the whole.

## Related

- `docs/large-files.md` — the other size limits and why they are where they are.
- `src/parsers/netcdf-parser.js` — `MAX_GENERATED_SERIES`, `sampledCombinations`.
