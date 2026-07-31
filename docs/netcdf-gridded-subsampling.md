# Gridded netCDF: partial load

A netCDF variable shaped `[time, lat, lon]` has to be flattened into one series
per spatial point before it can be drawn as a time series. A 101 × 101 grid is
**10,201 series from a single variable**, and real climate files are routinely
larger.

`MAX_GENERATED_SERIES` caps a file at 10,000 generated series. That cap exists
for a reason — expanding a large grid unbounded will hang the app — but the way
it was enforced was the problem.

## What it used to do

If expanding a variable would cross the cap, the variable was **rejected
whole**:

```js
if (seriesCount < 1 || result.metadata.generatedSeriesCount + seriesCount > MAX_GENERATED_SERIES) {
    this._skip(result, descriptor, 'Expanding this variable would exceed the … safety limit.');
    continue;
}
```

And because a file whose variables are all rejected generates no series at all,
the parse then failed outright:

```
ECMWF_ERA-40_subset.nc  →  "The netCDF file did not expose any numeric
                            variables aligned with its selected X coordinate."
```

Three of the fourteen files in the corpus below failed exactly that way.
Ordinary, well-formed climate files, refused.

## What it does now

Each gridded variable loads an evenly spaced subset of its points. The partial
load is recorded in `metadata.partialVariables`, surfaced in the UI, and given
its own node in the variable tree.

Three rules decide how large the subset is. None of them is a slice count,
because a slice count is the wrong unit.

### 1. A budget of retained values, not of slices

What a slice costs is dominated by the length of the time axis. A slice of
ECMWF ERA-40 (62 steps) is 500 bytes; a slice of a daily century run (31,025
steps) is 240 kB. So the allowance is

```
ceiling = max(MIN_SERIES_PER_VARIABLE, SERIES_VALUE_BUDGET_PER_VARIABLE / sampleCount)
```

with `SERIES_VALUE_BUDGET_PER_VARIABLE = 2,000,000` values — 16 MB of float64.
No file in the corpus retains more than that per variable. The floor of 64 is
there because a field sampled below roughly 8 × 8 stops being a field; it binds
past about 31,000 samples.

### 2. The file-wide limit, divided fairly

This is the part a per-variable constant cannot express. ECMWF ERA-40 holds
seventeen variables on the same 73 × 144 grid. Hand the first few a large
allowance and they eat the file's whole 10,000-series budget, and the rest are
rejected — the same disappearing-variable failure, moved one step down the file.
So the shortest requests are satisfied first and the rest divide what is left.
All seventeen come back, with 576 slices each.

### 3. No per-variable slice ceiling

Earlier drafts capped every variable at a fixed number — 512, then 2,048. Both
thinned variables that the old code had loaded whole: `sresa1b`'s `ua` is 4,352
slices, comfortably under the file-wide cap, and there was no reason to touch
it. `MAX_GENERATED_SERIES` already bounds the total, so the ceiling bought
nothing and cost real data. There is no constant of that kind any more.

## The sampling is spatial

The subset is thinned **along each axis independently**, not along the flattened
index. Walking the flattened order takes whole leading latitude rows and none of
the others — a band, not a sample of the field.

Counts are assigned shortest-axis-first, so a short axis is not rounded away
while a long one keeps hundreds. On `rhum.2003.nc`, shaped
`[time=365, level=8, lat=73, lon=144]`, that yields:

```
5,408 of 84,096 slices — 8 of 8 level × 26 of 73 lat × 26 of 144 lon
```

All eight levels survive. Both ends of every axis are included, so the subset
spans the full extent of each dimension.

**It is still not a statistical sample.** Evenly spaced points are enough to
look at the shape of a field. Totals, averages and extremes computed over the
loaded slices are not those of the full grid, and area weighting is gone. The
detail dialog says so in as many words; this is a stated limitation, not a bug
filed for later.

## Measured

Corpus: fourteen real files (Unidata examples, ECMWF ERA-40, NCEP reanalysis,
WRF, ECHAM, CMIP, MADIS), 0.03–268 MB. Re-run with:

```bash
node --expose-gc scripts/bench-netcdf-grid.mjs ~/Downloads/netcdf_test_corpus
```

It rewrites the parser's constants into throwaway copies of the module, so any
budget can be measured without editing the checked-in parser.

### Against the old behaviour

| file | before | now |
| --- | --- | --- |
| `ECMWF_ERA-40_subset.nc` | **load fails** | 9,792 series, 17 variables |
| `rhum.2003.nc` | **load fails** | 5,408 series, 1 variable |
| `smith_sandwell_topo_v8_2.nc` | **load fails** | 315 series, 1 variable |
| `tos_O1_2001-2002.nc` | 2 series (the field itself rejected) | 9,902 series |
| `wrfout_v2_Lambert.nc` | 24 variables, 55 skipped | 79 variables, 0 skipped |
| `cami_..._64x128_L26_...nc` | 4 variables, 48 skipped | 32 variables, 20 skipped |
| `sresa1b_ncar_ccsm3-example.nc` | 5,378 series | 5,378 series, unchanged |
| `HRDL_iop12-example.nc` | 186 series | 186 series, unchanged |
| `pres_temp_4D.nc`, `pr_day_GFDL-ESM4…`, `madis-mesonet.nc` | — | unchanged |

Nothing loads less than it did.

### Cost

Retained memory was never the binding constraint. Across the whole corpus the
worst per-file retention after parse is **21 MB** (`rhum.2003.nc`), and moving
the value budget by a factor of four in either direction moves that by single
-digit megabytes.

Parse time is dominated by the reader, not by the subsetting:
`test_echam_spectral-deflated.nc` (115 MB, 127 gridded variables) takes ~113 s
in h5wasm at any budget, and `smith_sandwell_topo_v8_2.nc` (130 MB) ~10 s. Those
are pre-existing costs and this change does not move them.

Browser-side, measured in the running app:

| file | series | load | variable tree render | DOM nodes |
| --- | ---: | ---: | ---: | ---: |
| `ECMWF_ERA-40_subset.nc` | 9,792 | 0.8 s | ~0.4 s | 98,218 |
| `tos_O1_2001-2002.nc` | 9,902 | 4.5 s | ~0.4 s | 99,200 |
| `rhum.2003.nc` | 5,408 | 2.3 s | ~0.2 s | 54,189 |

The tree costs about 10 DOM nodes and 40 µs per series, linearly. **That is the
real ceiling on this whole feature**, and it is set by `MAX_GENERATED_SERIES =
10000`, which this change does not touch. What the change does do is bring more
files up *to* that ceiling — files that used to load two series, or none. If the
tree ever needs to get cheaper, that limit is the lever, not the per-variable
budget.

## What the user sees

Three places, because a tooltip alone was not enough: someone who does not hover
sees a variable that looks complete and is not, and the slices that did load
carry ordinary coordinate labels, so a subset of a field is indistinguishable
from the field.

- **A notice on load** — `_showNetcdfPartialLoadNotice`, the same dismissible
  panel as memory-saving mode, naming the file and how many variables are
  affected.
- **A detail dialog** behind its "Which variables?" action, listing every
  partial variable with its per-axis counts and the caveat above.
- **The file-type badge tooltip**, which now reports partial loads separately
  from variables that could not be aligned at all. One count used to describe
  both, and said the wrong thing about the partial ones.

Plus a `Partially loaded variables` node in the variable tree, so the record
survives dismissing the notice.

## Related

- `docs/large-files.md` — the other size limits and why they are where they are.
- `src/parsers/netcdf-parser.js` — `seriesLimits`, `gridSample`, `axisSampleCounts`.
- `scripts/bench-netcdf-grid.mjs` — the measurement harness.
- `scripts/verify-netcdf-corpus.mjs` — imports a whole corpus and tabulates it.
