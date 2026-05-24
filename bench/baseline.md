# Baseline — Phase 0 diagnosis (2026-05-23)

Snapshot of performance before any Phase 1+ work.

- **Git ref:** `baseline-pre-optimization` tag · commit `f1ac877` on branch `perf-optimization`.
- **External backup:** `../backup-pre-perf-20260523/` (111 MB, 100 files).
- **Platform:** Windows 11 · Node v24.14.1 · Chrome (latest stable).

## Architecture summary

`OpenModelicaViewer` (`src/app/viewer-app.js`) composes:

- `MatParser` / `CsvParser` (`src/parsers/`)
- `PlotManager` (`src/plots/`) — owns Plotly lifecycle and all visualization modes
- `LayoutManager` (`src/ui/layout-manager.js`) — recursive split-panel workspace
- `i18n`, `Modal` (`src/i18n/`, `src/ui/`)
- Method "mixins" installed onto `OpenModelicaViewer.prototype` from `src/app/methods/*`

### CSV pipeline (status before this work)

1. `loadFile()` → `_parseResultBuffer()` → `_parseCsvResultBuffer()` (`src/app/methods/file-methods.js:422-438`).
2. If `window.location.protocol !== 'file:'` the buffer is **transferred to a Web Worker**
   (`src/workers/result-parser-worker.js`) which runs the **same** `CsvParser.parse()`.
   Under `file://` the worker is skipped and parsing happens on the main thread.
3. `CsvParser.parse()` (`src/parsers/csv-parser.js`):
   - Decodes the **entire buffer to a single JS string** via `TextDecoder` →
     **hard ceiling: ~512 MB per file (`0x1fffffe8` chars)**.
   - Runs a hand-rolled character-by-character row tokenizer (handles quoted
     fields, CRLF, multiple delimiters).
   - Re-parses up to 256 KB four times for delimiter detection (`,`, `;`, tab,
     whitespace).
   - Stores variable data in **plain JS arrays** (`numericValues = []`), not
     typed arrays. Each `push()` allocates.
   - Optional `_sortTimeSeriesByTime` adds an O(n log n) pass with copies if
     time is non-monotonic.

### Plotly path (status before this work)

- 1D timeseries already uses **`scattergl`** automatically when a trace has
  `≥ 50 000` points (`PlotManager.GL_POINT_THRESHOLD = 50000`,
  `src/plots/plot-manager.js:1908`). `type: 'scatter'` (SVG) is only used for
  parameter step-lines (2 points) and an origin-cross marker.
- 2D phase plots use the same `useGL` switch (`data-methods.js:779`).
- **Adaptive downsampling is already implemented**: `plotly_relayout` triggers
  `_onRelayout` → `_refreshTimeseriesVisuals` → `_buildTimeseriesVisualData`
  (`data-methods.js:595`). The latter slices by visible range via
  `_lowerBound`/`_upperBound` and applies min-max bucket downsampling
  (`_downsampleTimeseries`) to a configurable target (default 4 000,
  selectable 2k / 4k / 6k / 8k / 10k / none).
- Zoom updates use `Plotly.restyle()` per trace (good — no full re-plot).
- The downsampler does NOT cancel previous in-flight work; a rapid zoom
  sequence runs each step serially. No `AbortController`, no debouncing.

### What this means for the brief

| Brief assumption | Reality | Impact |
|---|---|---|
| "PapaParse or similar" | Hand-rolled, no streaming | Even more room for DuckDB win |
| "SVG `scatter` blocks plots > 100 k pts" | Already uses `scattergl` at ≥ 50 k | **Phase 2 sweep already mostly done** |
| "No decimation: passes all points" | Already decimates to 4 k via min-max bucket | **Phase 2 redirection needed** |
| "Object arrays vs typed arrays" | Confirmed — plain JS arrays everywhere | Big memory win available |
| File-size ceiling | **~512 MB hard ceiling** (TextDecoder→string) | Blocking issue for "decenas de millones de puntos" |

## Baseline measurements (Node CLI · `bench/cli-bench.mjs`)

Three runs per file. The "best" column is what to compare future optimizations
against. The CLI path measures `CsvParser.parse(ArrayBuffer)` in isolation, no
browser overhead — i.e. roughly equivalent to the time spent *inside* the Web
Worker in the deployed app.

| File | Size MB | Rows | Vars | Delim | Parse best (ms) | Throughput (MB/s) | Heap delta (MB) |
|---|---:|---:|---:|---|---:|---:|---:|
| `bench/data/synth-100mb.csv` | 103.6 | 1 500 000 | 9 | `,` | **7 610** | **13.6** | 1 360 |
| `test-files/csv/sol_total_corrected.csv` | 48.1 | 1 607 040 | 2 | `,` | 5 283 | 9.1 | 909 |
| `test-files/csv/REC_05042024_0958.csv` | 18.3 | 31 106 | 90 | tab | 2 519 | 7.3 | 215 |
| `test-files/csv/Musee-Meteo-Reduit.csv` | 10.5 | 212 448 | 9 | whitespace | 932 | 11.3 | 156 |
| `bench/data/synth-1gb.csv` | 1 047.7 | 15 000 000 | 9 | `,` | **FAIL** | n/a | n/a |

The 1 GB run failed with `RangeError: Cannot create a string longer than 0x1fffffe8 characters` after 1.5 s. This confirms the file-size ceiling at ~512 MB.

### Heap expansion ratio

| File | File size | Heap delta | Expansion |
|---|---:|---:|---:|
| synth-100mb | 103.6 MB | 1 360 MB | **13×** |
| sol_total_corrected | 48.1 MB | 909 MB | **19×** |
| REC_05042024_0958 | 18.3 MB | 215 MB | 12× |
| Musee-Meteo | 10.5 MB | 156 MB | 15× |

This is the cost of storing every cell as a JS Array element (boxed) instead of
a `Float64Array` slot, plus the duplicate `stringValues` retained until a column
is proven numeric (`csv-parser.js:84-88`).

### Format compatibility (regression safety net)

These files exercise the heterogeneity logic. All parse correctly today and
their parse time / variable count / delimiter detection should be preserved
through Phase 1.

| File | Delim | Rows | Parse best (ms) | Notes |
|---|---|---:|---:|---|
| `12_eu_semicolon_decimalcomma.csv` | `;` | 96 | 18.5 | Decimal comma |
| `13_tab_separated.csv` | tab | 500 | 22.4 | |
| `14_pvgis_style_with_comments.csv` | `,` | 72 | 6.8 | Header comments |
| `15_unix_timestamp_seconds.csv` | `,` | 720 | 16.7 | Unix epoch time |
| `16_modelica_combitimetable_format.csv` | whitespace | 200 | 10.5 | Modelica `#` comments |
| `11_seattle_weather_USdate_24k.csv` | `,` | 24 381 | 75.8 | M/D/Y date order |
| `09_tesla_stock_dirty.csv` | `,` | — | **ERROR** | `Invalid time value at CSV data row 1` — preexisting bug, not regression |

## Comparison against the brief's targets

| Task | Target | Min acceptable | Baseline (best) | Status |
|---|---|---|---|---|
| Parse 100 MB / 1.5 M rows | < 500 ms | < 2 s | **7 610 ms** | ❌ 3.8× over min |
| Parse 1 GB / 15 M rows | < 5 s | < 15 s | **N/A — physical fail** | ❌ blocked by string-length ceiling |
| Render initial 1D · 1M points | < 300 ms | < 1 s | not yet measured | pending browser bench |
| Zoom/pan · 5M points | 60 fps | 30 fps | not yet measured | pending browser bench |
| 3 × 500 MB files | < 2 GB RAM | no crash | extrapolation: **expected crash** | each ≈ 5 GB heap when parsed |
| Heatmap 2000×2000 | < 500 ms | < 2 s | not yet measured | pending browser bench |

## How to capture the missing browser metrics

1. `npm install` (first time only).
2. `npm run dev` — Vite serves on `http://127.0.0.1:8000`.
3. Open `http://127.0.0.1:8000/bench/benchmark.html` in Chrome with
   `--enable-precise-memory-info` if you want heap numbers populated.
4. Pick `bench/data/synth-100mb.csv` (and any others you want covered).
5. Click "Run benchmarks". Copy the resulting JSON back into this file under
   "Browser bench results".

## Browser bench results

_(empty — paste JSON from `bench/benchmark.html` here)_

## Reformulated Phase 2 plan

The brief's Phase 2 mostly assumed Plotly was still on SVG with full datasets.
That's not true today. What actually needs doing:

1. **Wire viewport-aware queries to the new data layer.** Today the
   `_buildTimeseriesVisualData` does the slice + downsample in JS over the
   already-in-RAM array. After Phase 1 the data lives in DuckDB; the viewport
   handler must call `getColumnRange(file, col, t0, t1, maxPoints)` instead.
2. **Cancellation / "last query wins."** `_onRelayout` should attach an
   `AbortController` (or a monotonic version token) so a fast zoom drag does
   not enqueue a queue of stale queries.
3. **Typed arrays end-to-end.** Today `data-methods.js:_downsampleTimeseries`
   returns picked subarrays via `_pickIndexed` into a regular array. Make the
   trace data `Float64Array` so Plotly receives typed input.
4. **Re-examine `GL_POINT_THRESHOLD = 50 000`.** With viewport downsampling
   already keeping point counts at 4 k, scattergl rarely activates for
   timeseries. Investigate whether always-on `scattergl` for `lines` mode
   yields better paint latency on big screens, and only fall back to SVG for
   small traces where SVG anti-aliasing wins.
5. **Heatmap path.** Currently no heatmap-specific code exists in the viewer
   (the brief mentioned spectrograms but the app does not have them today).
   When that lands, the `heatmap` Plotly type is fine up to ~1000×1000; above
   that, downsample server-side (DuckDB) to viewport dimensions before passing
   to Plotly.
6. **Multi-file overlay.** Already done via `Plotly.addTraces` /
   `deleteTraces`. No change needed.

Items 1–3 are the meaningful work. Items 4–6 are minor touch-ups.

## Recommended Phase 1 emphasis

Given the diagnosis above, Phase 1 should prioritize (in order):

1. **Solve the 512 MB hard ceiling.** This is non-negotiable; DuckDB-WASM's
   `registerFileHandle` reads the file lazily and never materializes a full
   string, removing the limit.
2. **Cut the 13–19× heap expansion.** Either by storing column data in
   typed arrays inside DuckDB or by serving Plotly directly from DuckDB
   query results (which can return `Float64Array` columns natively via
   Arrow).
3. **Re-establish format-heterogeneity coverage.** The `12`–`16` files plus
   `Musee-Meteo` whitespace and `REC_05042024` tab-delimited must still parse.
   DuckDB's `read_csv_auto` will catch most; the bridge to existing
   detection (decimal comma override, US-vs-EU date order in `11`,
   comment lines in `14`) is the risky part.
4. **Then** measure parse time and decide whether further optimization is
   needed before moving to Phase 2.

The expected order-of-magnitude gain from DuckDB-WASM on the 100 MB synthetic
is ~10–20× on parse time (1 s region) and ~10× on memory.
