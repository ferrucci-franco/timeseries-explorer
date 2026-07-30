# Optimization Blueprint — 6 Milestones

Status: **design only, no code written.** Audit + implementation plan.

Architectural mandate honoured throughout: every item below executes in the
browser sandbox (or the Electron renderer). No new cloud dependency, no
backend, no CDN fetch at runtime. Where a proposed library defaults to
remote fetching (Transformers.js), that is called out explicitly with the
offline pinning required.

---

## 1. Repository audit — where the time actually goes

The repo is in much better shape than the brief assumes. DuckDB-WASM already
runs in its own worker, `scattergl` is already on, viewport decimation already
exists, and `bench/baseline.md` already contains a measured Phase-0 diagnosis.
So the bottlenecks are **not** the obvious ones. They are these six.

### 1.1 Only CSV is off the main thread — every other parser blocks it

`src/workers/result-parser-worker.js` is the only parse worker, and
`_canUseParserWorker()` ([file-methods.js:1999](src/app/methods/file-methods.js:1999))
disables even that under `file://`.

Everything else parses synchronously in the UI thread:

| Format | Entry point | Cost |
|---|---|---|
| `.mat` (v4/v5/v7/v7.3) | [`_parseMatlabResultBuffer`](src/app/methods/file-methods.js:1357) → `matlab-mat-file.js` (913 lines) + `h5wasm` + `matlab-mcos.js` | inflate + MCOS walk, fully blocking |
| `.nc` / `.netcdf` | [`_parsePypsaNetcdfResultBuffer`](src/app/methods/file-methods.js:1367) | blocking |
| `.pkl` | [`_parsePickleResultBuffer`](src/app/methods/file-methods.js:1455) | blocking |
| `.xlsx/.xls/.ods` | [`_parseExcelResultBuffer`](src/app/methods/file-methods.js:1374) | blocking — the code itself documents *"tens of seconds of blocked main thread"* at [file-methods.js:1414](src/app/methods/file-methods.js:1414) |

Measured legacy CSV cost from `bench/baseline.md`: **7 610 ms** of CPU for a
100 MB / 1.5 M-row file, with a **13–19× heap expansion** because columns are
boxed JS arrays. 1 GB fails outright on the `0x1fffffe8` string ceiling.

`_parseCsvInWorker` also does `buffer.slice(0)`
([file-methods.js:2062](src/app/methods/file-methods.js:2062)) — a full copy of
the file **before** transferring it. For a 500 MB file that is a 500 MB
allocation that exists only to be given away.

### 1.2 The Data Tools math is the single hottest blocking region

All four tools run synchronously over the full array, on the main thread, in
[`data-tools-methods.js`](src/app/methods/data-tools-methods.js):

- [`_computeDerivativeValues:941`](src/app/methods/data-tools-methods.js:941)
- [`_computeIntegralValues:976`](src/app/methods/data-tools-methods.js:976)
- [`_computeMovingAverageValues:1002`](src/app/methods/data-tools-methods.js:1002)
- [`_detectSpikeOutliers:1066`](src/app/methods/data-tools-methods.js:1066)

Three specific defects:

1. **Typed arrays are un-typed on entry.** Every one of them opens with
   `Array.from(sourceValues || [], Number)` (lines 942, 977, 1003). A
   `Float64Array` arriving from DuckDB/Arrow is converted into a boxed JS
   array — ~3× the memory, pointer-chasing loads, and the JIT loses the
   unboxed-double fast path. Output is `new Array(n)` too, so the result is
   boxed as well and has to be re-marshalled for Plotly.

2. **`_detectSpikeOutliers` is quadratic-ish and allocation-bound.** Per
   sample it builds a `local` array, **sorts it**, `.map()`s it into a
   deviations array, and **sorts that too** (lines 1080–1092). That is
   `O(n · w log w)` with **two heap allocations per sample**. At 5 M samples
   and a 31-wide window: ~10 M short-lived arrays and ~300 M comparisons, all
   between two paint frames. Nothing can keep 60 fps through that. A
   streaming median/MAD over a two-heap or histogram structure is `O(n log w)`
   with zero per-sample allocation.

3. **No yielding, no cancellation.** `_scheduleOutlierAutoApply:293` debounces
   the *trigger*, but the work itself is one un-interruptible block. Moving a
   sensitivity slider enqueues a full recompute that cannot be aborted when
   the next tick arrives.

`fft-methods.js` already does this correctly via
[`fft-worker.js`](src/workers/fft-worker.js) with buffer transfer — that file is
the template the other four should follow.

### 1.3 The derived-variable engine is a tree-walking interpreter

[`derived-methods.js:61–295`](src/app/methods/derived-methods.js:61) is
tokenizer → recursive-descent parser → **AST interpreter**. The parser is fine.
The evaluator is the problem:

- Every binary node materializes a fresh `new Array(n)`
  ([:222](src/app/methods/derived-methods.js:222)).
- Every unary/function node does `.map(fn)` with a closure
  ([:206](src/app/methods/derived-methods.js:206),
  [:238](src/app/methods/derived-methods.js:238)).

For the brief's own example, `sqrt(x^2 + y^2)` over 5 M samples: 5 intermediate
boxed arrays ≈ **800 MB of transient garbage**, plus a megamorphic call per
element per node. A fused single-pass kernel does the same work in one
`Float64Array` with one pass.

Worse, this is not a one-off: `_reapplyDerivedVariable`
([:517](src/app/methods/derived-methods.js:517)) re-runs the whole thing on
every reload and on **every live-update append**.

The function set is also thin — `sqrt abs log log10 square diff root power`.
No comparisons, no conditionals, no reductions, no `min/max/clamp`,
no trig.

### 1.4 Rendering is *not* the bottleneck — the marshalling that feeds it is

Plotly is imported through a single shim, [`src/vendor/plotly.js`](src/vendor/plotly.js),
by 9 modules. `scattergl` engages above `GL_POINT_THRESHOLD = 50000`, and
decimation to 2 000 points is already in place
([`DEFAULT_VISUAL_MAX_POINTS_TIMESERIES`](src/plots/plot-manager.js:3613)).

But the path that produces those 2 000 points runs on the main thread on
**every relayout event**, in [`data-methods.js`](src/plots/methods/data-methods.js):

- [`_buildTimeseriesVisualData:1269`](src/plots/methods/data-methods.js:1269)
  does `timeData.slice(start, end)` **and** `values.slice(start, end)` — two
  full copies of the visible window before any reduction. Zoomed to 80 % of a
  5 M-point trace, that is two 4 M-element array copies **per zoom event, per
  trace**.
- [`_downsampleTimeseries:1207`](src/plots/methods/data-methods.js:1207) then
  scans that copy and rebuilds two more arrays through
  [`_pickIndexed:1186`](src/plots/methods/data-methods.js:1186), which returns a
  boxed `new Array`.
- [`_getTransformedVariableData:1150`](src/plots/methods/data-methods.js:1150)
  `.map()`s the entire variable whenever gain/offset ≠ identity. It is cached,
  but the cache key includes `gain`, so dragging a gain slider invalidates it
  every frame.

Measured in `bench/baseline.md`: **zoom worst 168–188 ms** against a 16 ms
target. That is ~6 fps — and essentially none of it is GPU time.

**This reframes milestone 2.** Handing these arrays to a WebGPU pipeline
instead of Plotly's WebGL one changes the ~1 ms that is actually GPU-bound and
leaves the ~170 ms of copying untouched. See §2.2 for the recommended
sequencing.

### 1.5 "Live" today means polling a file on disk, desktop-only

[`live-update-methods.js`](src/app/methods/live-update-methods.js) polls a file
handle every `intervalSec` (default 2 s), diffs by size/offset, and appends the
delta through
[`appendCsvDelta`](src/data/duckdb-source.js:217) (capped at 1 M rows / 256 MB
by `duckdb-live-limits.js`). It is gated to Electron by
`canUseLiveUpdate: desktop` ([capabilities.js:46](src/app/capabilities.js:46)).

There is **no socket transport of any kind** in the repo. But the hard part is
already built: append → re-apply derived variables → re-apply Data Tools
definitions → incremental replot. A WebSocket/MQTT source only has to feed the
same append path. This is the cheapest milestone of the six.

### 1.6 Export is one string-concatenating CSV writer

The only real exporter is `_exportPanelCsv` in
[`plot-manager.js:~2050–2210`](src/plots/plot-manager.js:2195), which builds an
array of joined strings and calls `rows.join('\n')` into a single `Blob`
([:2199](src/plots/plot-manager.js:2199)). A 5 M × 10 export is a multi-GB
JS string — it will OOM well before it downloads. Same shape in
[`_downloadCsvColumns`](src/plots/methods/phase2d-fit-methods.js:1385).

There is **no `.mat` writer and no Parquet writer**.
`canExportParquet` ([capabilities.js:47](src/app/capabilities.js:47)) is
declared twice and **read nowhere** — it is a dead flag. Parquet conversion
exists only as a Node script (`bench/csv-to-parquet.mjs` →
`src/data/csv-to-parquet-core.js`) against the *native* `duckdb` package.

And critically: the CSV export writes the **panel's traces**, which for a lazy
DuckDB file means the *downsampled overview*, not the exact data. There is no
"export my cleaned, derived dataset" path at all.

### 1.7 Cross-cutting: no cross-origin isolation, no worker pool

- No `COOP`/`COEP` headers anywhere (`vite.config.js`, `scripts/portable-server.mjs`,
  `electron/main.cjs`, `index.html`). Therefore no `SharedArrayBuffer`,
  therefore duckdb-wasm loads its **single-threaded `eh` bundle** instead of
  `eh-mt`, and any future threaded WASM (ONNX Runtime Web, SIMD kernels) is
  capped at one thread. Two response headers unlock real parallelism across
  milestones 1, 4 and 6.
- No worker pool, no shared cancellation token, no transferable discipline.
  Each feature that wanted a worker hand-rolled its own lifecycle
  (`_getParserWorker`, `_computeFftSpectrumInWorker`).
- ~~`src/parsers/csv-time-detection_option.js` (941 lines) looks like a stale
  fork of `csv-time-detection.js` (1 406 lines).~~ Confirmed stale and deleted:
  nothing imported it, and it was missing exports the live file has
  (`parseCsvTimeValue`, `customDatetimePatternInfo`), so it could never have
  substituted for it. Git history keeps it.
- `fft-methods.js` and `phase2d-fit-methods.js` contain raw NUL bytes and are
  invisible to `grep`. Any refactor touching them needs care.

### 1.8 Audit summary — ranked by payoff per unit of risk

| # | Bottleneck | Fix | Effort | Payoff |
|---|---|---|---|---|
| 1 | Data Tools math on main thread, boxed arrays, `O(n·w log w)` spike detector | Compute worker + typed arrays + streaming median | M | **Very high** |
| 2 | Zoom copies the visible window twice per event | Index-range decimation without `slice`, into `Float64Array` | S | **Very high** |
| 3 | `.mat`/`.pkl`/`.nc`/`.xlsx` parse on main thread | Generalize the existing parse worker | M | High |
| 4 | Derived-variable AST interpreter | Fused compiled kernels | M | High |
| 5 | No COOP/COEP | Two headers + Electron `onHeadersReceived` | XS | High (multiplier) |
| 6 | No streaming input | Transport layer feeding `appendCsvDelta` | M | High (new capability) |
| 7 | Export writers missing / OOM-prone | Streaming writers + DuckDB `COPY TO` Parquet | M | High (new capability) |
| 8 | No anomaly detection | Worker-side IF/STL, ONNX optional | L | Medium-high |
| 9 | Plotly WebGL trace layer | WebGPU line layer | L | **Low until #2 lands** |

---

## 2. Implementation blueprints

### 2.0 New directory structure

```
src/
  core/                        # NEW — shared infrastructure for M1/M4/M5/M6
    worker-pool.js             #   N-worker pool, round-robin + backpressure
    task-client.js             #   promise/AsyncIterable wrapper, cancellation tokens
    transfer.js                #   transferable collection, zero-copy helpers
    chunked.js                 #   chunk/yield scheduler for main-thread fallback
    column.js                  #   canonical Float64Array/BigInt64Array column type

  workers/
    fft-worker.js              # EXISTING — folded into compute-worker in step 1.4
    result-parser-worker.js    # EXISTING — renamed/extended to parse-worker.js
    parse-worker.js            # NEW — all formats, chunked, progress events
    compute-worker.js          # NEW — derivative/integral/MA/outliers/FFT
    expr-worker.js             # NEW — M4 compile + evaluate
    export-worker.js           # NEW — M5 streaming writers
    anomaly-worker.js          # NEW — M6 inference

  compute/                     # NEW — pure kernels, no DOM, importable from workers
    kernels/derivative.js
    kernels/integral.js
    kernels/moving-average.js
    kernels/outliers.js        #   streaming median/MAD, no per-sample alloc
    kernels/resample.js        #   min-max decimation writing into a caller buffer

  gpu/                         # NEW — M2
    device.js                  #   adapter/device acquisition + feature probe
    line-renderer.js           #   the public surface used by plot-manager
    pipelines/line-strip.wgsl
    pipelines/line-strip.js
    buffer-pool.js             #   persistent GPU vertex buffers per trace
    fallback.js                #   graceful degradation to the current Plotly path

  live/                        # NEW — M3
    gateway.js                 #   connection registry, reconnect, status
    transports/websocket.js
    transports/mqtt.js         #   MQTT-over-WS
    transports/sse.js          #   optional third transport, ~40 lines
    schema.js                  #   payload → {t, values[]} mapping + validation
    ring-buffer.js             #   bounded Float64Array ring per channel
    ingest-bridge.js           #   ring → appendCsvDelta-equivalent

  expr/                        # NEW — M4
    parse.js                   #   moved from derived-methods.js (unchanged grammar)
    ir.js                      #   AST → stack IR + constant folding
    emit-js.js                 #   IR → fused JS kernel (baseline, always available)
    emit-wasm.js               #   IR → WASM module bytes (f64 + optional v128)
    runtime.js                 #   compile cache, dispatch, feature detection
    builtins.js                #   extended function table

  export/                      # NEW — M5
    export-manager.js          #   UI-facing orchestrator + dialog state
    source.js                  #   unified column reader (eager | DuckDB lazy)
    writers/csv-writer.js      #   streaming, chunked
    writers/mat-writer.js      #   MAT Level 5, fflate deflate
    writers/parquet-writer.js  #   DuckDB-WASM COPY TO
    sink.js                    #   FileSystemWritableFileStream | Blob | Electron

  ml/                          # NEW — M6
    anomaly-engine.js          #   public API, model registry
    features.js                #   rolling window feature extraction
    detectors/isolation-forest.js
    detectors/robust-zscore.js #   STL-lite residual + rolling MAD
    detectors/onnx-detector.js #   ONNX Runtime Web, local assets only
    models/                    #   bundled .onnx (opt-in, see §2.6 packaging note)
```

---

### 2.1 Milestone 1 — Multi-threading

**Step 1.1 — Cross-origin isolation (do this first; it multiplies M1/M4/M6).**

- `vite.config.js`: add `server.headers` and `preview.headers` with
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`.
- `scripts/portable-server.mjs`: same two headers on every response.
- `electron/main.cjs`: `session.defaultSession.webRequest.onHeadersReceived`
  to inject both.
- `src/app/capabilities.js`: add `crossOriginIsolated: globalThis.crossOriginIsolated === true`
  and `hardwareThreads: navigator.hardwareConcurrency || 4`.
- Verify duckdb-wasm switches to the `eh-mt` bundle in `duckdb-source.js:_bootstrap`.

Risk: `require-corp` breaks any cross-origin subresource. The app is
offline-first with everything under `public/` and `src/vendor/`, so the blast
radius is limited to the analytics path — check `src/analytics/analytics.js`
before flipping it, since it loads `count.js` from `gc.zgo.at`.

**Step 1.2 — `src/core/worker-pool.js` + `task-client.js`.**

One pool, `min(4, hardwareConcurrency - 1)` workers, each a module worker
speaking one envelope:

```
{ id, op, payload, transfer[] }  →  { id, ok, result | error, progress? }
```

Cancellation is a monotonic token per UI interaction: the client drops stale
results, and long ops poll an `Atomics`-backed abort flag (available once
step 1.1 lands; falls back to chunk-boundary checks otherwise).

**Step 1.3 — Generalize the parse worker.**

- Rename `result-parser-worker.js` → `src/workers/parse-worker.js`; keep the old
  filename as a re-export for one release so session/desktop packaging paths
  (`package.json` `build.files` lists `src/parsers/**/*`) don't break.
- Add ops: `parse:mat`, `parse:pickle`, `parse:netcdf`, `parse:excel`, plus the
  existing `parse:csv`. Each dynamically imports its parser so the worker's
  first message doesn't pull in `h5wasm` + `xlsx` unconditionally.
- `file-methods.js`: route `_parseMatlabResultBuffer:1357`,
  `_parsePickleResultBuffer:1455`, `_parsePypsaNetcdfResultBuffer:1367` and
  `_parseExcelResultBuffer:1374` through the pool, keeping the existing
  main-thread implementations as the `workerUnavailable` fallback (the pattern
  at [file-methods.js:1978](src/app/methods/file-methods.js:1978) already does
  exactly this for CSV — reuse it verbatim).
- Delete the `buffer.slice(0)` at
  [file-methods.js:2062](src/app/methods/file-methods.js:2062); transfer the
  original and re-read from `entry.file` on the (rare) paths that need the
  buffer again.
- Emit `progress` messages every N MB so the existing loading overlay shows a
  real bar instead of a spinner.

Caveat worth surfacing to the user: Excel and `.mat` v7.3 must decompress the
whole container before any column exists, so "chunked parsing" for those means
*chunked yielding*, not incremental results. Genuine streaming is only
available for CSV (already done, via DuckDB) and Parquet (row groups).

**Step 1.4 — Move the math out.**

- Extract the four algorithms from `data-tools-methods.js` into
  `src/compute/kernels/*.js` as pure functions over `Float64Array`:
  `fn(src: Float64Array, time: Float64Array|null, params, out: Float64Array) → meta`.
  No `Array.from`, no `new Array`, caller-owned output buffer.
- Rewrite `outliers.js`'s spike path: one pass with an order-statistic
  structure (dual heap or a 2048-bucket histogram over a running range) for the
  rolling median and rolling MAD. Target `O(n log w)`, zero allocation inside
  the loop. Keep `_keepReturningOutlierRuns` semantics bit-for-bit — it is
  covered by `scripts/test-data-tools.mjs`.
- `src/workers/compute-worker.js` hosts the kernels, plus the existing
  `computeAmplitudeSpectrum` op so `fft-worker.js` can be retired.
- `data-tools-methods.js` keeps all UI/config/naming logic and calls
  `taskClient.run('compute:outliers', …)`; the synchronous kernels stay as the
  fallback path.
- Pipeline mode (`_buildDataToolPipelineResult:791`) becomes a single worker
  round-trip carrying the whole step list, not one per step.

**Acceptance:** with `scripts/test-data-tools.mjs` green, a 5 M-row spike
detection must produce no main-thread task longer than 16 ms, and must be
cancellable mid-flight by moving the sensitivity slider.

---

### 2.2 Milestone 2 — WebGPU

**A concern about this milestone, stated once.** The audit (§1.4) shows zoom
costs 168–188 ms of which the GPU share is ~1 ms. Plotly's `scattergl` is
already a WebGL2 pipeline; swapping it for WebGPU changes the fast part.
**The 170 ms is `Array.prototype.slice` and boxed-array rebuilds on the main
thread.** My recommendation is to land step 2.1 below first — it is small,
low-risk, and should get zoom under 33 ms on its own — then decide whether the
full pipeline is still warranted. I have specified it in full either way, and
scoped it so it does not require replacing Plotly.

**Step 2.1 — Kill the copies (do this regardless of WebGPU).**

In [`data-methods.js`](src/plots/methods/data-methods.js):

- `_buildTimeseriesVisualData:1269`: drop the two `.slice()` calls. Pass
  `(start, end)` into the decimator and let it scan the source in place.
- `_downsampleTimeseries:1207`: accept `(src, srcStart, srcEnd, outX, outY)`
  and write directly into two reusable `Float64Array`s owned by the plot
  (`plot._visualBuffers`), sized `2 × maxPoints`. Zero allocation per zoom.
- `_pickIndexed:1186`: return typed arrays.
- `_getTransformedVariableData:1150`: apply gain/offset **inside** the
  decimation loop on the 2 000 surviving points rather than `.map()`ing 5 M.
  This alone removes the gain-slider stall.
- Move the decimation kernel to `src/compute/kernels/resample.js` so the
  compute worker can also produce visual buffers off-thread for the first
  paint.

Expected: zoom 168 ms → well under 33 ms with no rendering change at all.

**Step 2.2 — GPU device + capability probe.**

`src/gpu/device.js` requests an adapter once, caches the device, and exposes
`isGpuAvailable()`. `capabilities.js` gains `canUseWebGpu`. Everything below is
strictly opt-in behind that flag with `src/gpu/fallback.js` returning the
current Plotly path.

**Step 2.3 — Hybrid line layer, not a Plotly replacement.**

Plotly owns 9 modules and every axis, legend, cursor, hover-sync, annotation
and export behaviour in this app. Replacing it is a rewrite, not an
optimization. The workable design keeps Plotly as the **chrome** and puts a
GPU canvas **behind** the trace area:

- `plot-manager.js:_createPlot` (~[:1271](src/plots/plot-manager.js:1271))
  inserts a `<canvas>` positioned to Plotly's plot-area rect, below the SVG
  overlay.
- Traces above a threshold (`GPU_POINT_THRESHOLD`, start at 200 k) render as
  `visible: false` in Plotly and are drawn by `src/gpu/line-renderer.js`.
  Everything else — axes, ticks, legend, hover, cursors, the measurement tool
  — stays Plotly and stays correct.
- `_onRelayout` pushes the new x/y range into a uniform buffer; the renderer
  redraws from **already-resident** vertex buffers. That is the actual win:
  pan/zoom becomes a uniform update, not a data re-upload.

**Step 2.4 — Buffers and pipeline.**

- `buffer-pool.js`: one persistent `GPUBuffer` per (fileId, varName) holding
  interleaved `f32 x, y`. Uploaded once at trace creation, refreshed only on
  transform/live-append. Budget-capped with LRU eviction; f32 for position with
  a per-trace f64 origin offset passed as a uniform, so precision holds for
  epoch-millisecond time axes.
- `line-strip.wgsl`: instanced quad expansion for wide lines (2 triangles per
  segment, `instance_index` → segment), or `line-strip` topology for 1 px.
  Vertex shader does `(value - origin) * scale` in f32.
- Decimation stays on the CPU side (`resample.js`) — 2 000 points is already
  cheap; the point of the GPU buffer is that *full-resolution* data can live
  resident so zoom no longer needs a CPU pass at all. That is the version of
  this milestone that actually delivers "multi-million-point smooth zoom":
  upload once, then zoom is a uniform write.

**Step 2.5 — Fallback ladder.** WebGPU → current `scattergl` → SVG `scatter`.
`gpu/fallback.js` decides once at plot creation and never mid-session.

---

### 2.3 Milestone 3 — "Local Live" (WebSockets & MQTT)

Lowest risk of the six: the ingest half already exists.

**Step 3.1 — Transports.** `src/live/transports/websocket.js` wraps native
`WebSocket` with exponential-backoff reconnect and a status enum.
`src/live/transports/mqtt.js` uses `mqtt` (npm) over `ws://` — it is the only
new runtime dependency in this whole plan, ~40 KB gzipped, and it must be
bundled locally (Vite handles it; the Electron `build.files` list needs no
change since it is bundled into `dist/`). `sse.js` is ~40 lines and covers
"just curl into an EventSource" Python scripts.

**Step 3.2 — Schema mapping.** `src/live/schema.js` turns an arbitrary payload
into `{ t: number, values: Float64Array }`:
- JSON object with configurable key paths (`$.timestamp`, `$.sensors.temp`)
- CSV line
- raw numeric array with a declared channel order
- MQTT topic-per-channel (topic → channel index)

Time source: payload field, or client-arrival `performance.timeOrigin + now`
when absent. Both must be explicit in the UI — silently stamping arrival time
is how live plots end up lying about latency.

**Step 3.3 — Ring buffer + backpressure.** `ring-buffer.js` holds a bounded
`Float64Array` per channel (default 1 M samples, configurable). A 10 kHz source
must never mean 10 000 replots/second: the bridge coalesces on
`requestAnimationFrame` and flushes to storage on a fixed cadence.

**Step 3.4 — Bridge to the existing pipeline.** `ingest-bridge.js` creates a
synthetic file entry that looks exactly like a live-updating CSV, so the
already-working machinery in
[`live-update-methods.js`](src/app/methods/live-update-methods.js) applies
unchanged: derived variables re-applied, Data Tools definitions re-applied,
incremental replot, the 1 M-row / 256 MB caps in `duckdb-live-limits.js`.
Concretely: refactor `toggleLiveUpdate`/`_applyLiveAppend` to take a *source
interface* (`{ poll() }` for files, `{ subscribe(cb) }` for sockets) instead of
assuming a file handle.

**Step 3.5 — Capabilities and UI.** `canUseLiveStream: true` in **both**
runtimes — unlike file polling, sockets work fine in the browser. New sidebar
section "Live source" with URL/broker, topic(s), schema mapping, connection
status, and sample-rate readout. Extend the existing live-update top-bar menu
rather than adding a second control.

**Security note.** A page served over `https://` (GitHub Pages) cannot open
`ws://localhost` under mixed-content rules — Chrome permits `ws://127.0.0.1`
but not `ws://<lan-ip>`. Document this: the LAN/IoT use case is the local-dev
server, the portable server, or Electron. Also: never auto-connect to a URL
from a session file without an explicit confirm — a `.tse` session is
untrusted input.

---

### 2.4 Milestone 4 — Compiled expression engine

**A note on approach.** Compiling exprtk to WASM ships a C++ *parser and
interpreter* into the browser; the interpreter loop is still there, just in
WASM. And this workload is memory-bandwidth-bound, not scalar-math-bound — a
fused JS kernel over `Float64Array` is already within ~1.2× of native for
`sqrt(x*x + y*y)`. The genuine near-native win comes from **emitting a WASM
module from the AST at runtime**, which also unlocks `v128` SIMD (2 f64 lanes)
— something JS cannot express. Plan below does JS codegen first (cheap,
always available, ~90 % of the win) and WASM emission second (the remaining
win + SIMD). Both are specified.

**Step 4.1 — Extract the parser.** Move `_tokenizeDerivedFormula:78`,
`_parseDerivedExpression:134` and `_normalizeDerivedFunctionName:128` verbatim
from `derived-methods.js` into `src/expr/parse.js`. Grammar unchanged, so
`scripts/test-*` and existing sessions keep working. `derived-methods.js` keeps
only UI: the form, autocomplete, suggestions, tree wiring.

**Step 4.2 — IR + constant folding.** `src/expr/ir.js` lowers the AST to a flat
stack IR, folds constant subtrees, hoists scalars (parameters, `data.length===1`
variables) out of the loop, and resolves each `name` to a column slot index.

**Step 4.3 — JS codegen (baseline).** `src/expr/emit-js.js` builds one function
source string from the IR and instantiates it with `new Function`:

```
(cols, out, n) => { const c0=cols[0], c1=cols[1];
  for (let i=0;i<n;i++) out[i] = Math.sqrt(c0[i]*c0[i] + c1[i]*c1[i]); }
```

One pass, one output `Float64Array`, zero intermediates. Cached by formula
string in `runtime.js`.

`new Function` is `unsafe-eval`. The app currently ships **no CSP** (§1.7), so
this works today — but step 1.1 is the moment to add one, and if a CSP is
added the JS path must be gated behind the WASM path. Note that WASM
compilation needs `'wasm-unsafe-eval'`, which is strictly narrower. Decide this
explicitly rather than discovering it.

**Step 4.4 — WASM emission.** `src/expr/emit-wasm.js` encodes a minimal module
binary (type/function/memory/export sections + a body of `f64.load`,
`f64.mul`, `f64.sqrt`, `call` for `log`/`pow`) — roughly 300 lines of byte
encoder, no toolchain, no build step, no new dependency. Columns are placed in
the module's linear memory (or an imported `WebAssembly.Memory` backed by the
worker's buffers). `WebAssembly.validate` + a numeric self-check against the JS
kernel on first compile; any mismatch falls back to JS permanently.

Optional `v128` variant: `f64x2.mul` / `f64x2.sqrt` on 2-wide lanes, guarded by
a SIMD feature probe. ~1.6–1.8× on top of scalar WASM for the arithmetic-heavy
formulas.

**Step 4.5 — Extend the language.** With a compiler in place these become
nearly free and are what users actually ask for: `min max clamp sign floor ceil
round exp sin cos tan atan2 hypot mod`, comparisons + `if(cond, a, b)`,
reductions (`mean sum std cumsum`), and rolling forms (`movmean(x, w)`) that
map onto the M1 kernels. Ship them in `builtins.js` and add the descriptions to
`src/i18n/translations.js` (all 4 locales).

**Step 4.6 — Worker + live path.** `src/workers/expr-worker.js` runs compile +
evaluate. `_reapplyDerivedVariable:517` gets an **incremental** mode: on a live
append, evaluate the kernel only over `[oldLength, newLength)` and append,
instead of recomputing 5 M samples every 2 seconds.

**Acceptance:** `sqrt(x^2+y^2)` over 5 M samples — measure interpreter baseline,
then JS kernel, then WASM, then SIMD. Publish the table in `bench/`. If WASM
does not beat JS codegen by a meaningful margin on the real hardware, ship the
JS path and say so; the compiler is the win, the target ISA is an
implementation detail.

---

### 2.5 Milestone 5 — Universal local export engine

**Step 5.1 — Unified column source.** `src/export/source.js` yields
`{ name, unit, chunk: Float64Array }` for any variable, hiding two very
different backends:
- eager files → slice the in-memory column
- lazy DuckDB files → `SELECT` in row batches (extend `getRawColumnsRange`,
  [duckdb-source.js:375](src/data/duckdb-source.js:375))

This is the piece that fixes the real defect in §1.6: export must read the
**exact** data, with derived variables and Data Tools edits applied, not the
plot's downsampled overview. It must also honour crop/shift/sign transforms
and let the user choose "visible range" vs "full dataset" explicitly.

**Step 5.2 — Sink abstraction.** `src/export/sink.js`:
1. `showSaveFilePicker()` → `FileSystemWritableFileStream` (true streaming,
   Chrome/Edge — no size ceiling)
2. Electron → `omvDesktop` save dialog + streamed write (the download-dialog
   plumbing already exists, `scripts/test-desktop-download-dialog.mjs`)
3. Blob fallback for Firefox/Safari, with a size warning above ~500 MB

**Step 5.3 — CSV writer.** `src/export/writers/csv-writer.js`: chunked
`TextEncoder` → sink. Configurable delimiter, decimal separator, precision,
line ending, and time format (ISO 8601 / epoch ms / elapsed seconds) reusing
the existing elapsed logic covered by `scripts/test-csv-elapsed-format.mjs`.
Replaces the `rows.join('\n')` at
[plot-manager.js:2199](src/plots/plot-manager.js:2199).

**Step 5.4 — MAT writer.** `src/export/writers/mat-writer.js` emits **MAT-file
Level 5**: 128-byte header, then one `miMATRIX` per variable
(`mxDOUBLE_CLASS`, column-major), optionally `miCOMPRESSED` via **`fflate`
which is already a dependency** — no new package. Two layouts:
`struct` (`data.time`, `data.<var>`, `data.units`) and `timetable`-compatible.
Round-trip test: write → re-read with the existing
[`matlab-mat-file.js`](src/parsers/matlab-mat-file.js) parser and assert
bit-equality; plus a fixture check via `scripts/make-mat-fixtures.py`.

v7.3/HDF5 output is deliberately **out of scope** — `h5wasm` write support
would double this milestone for a format Level 5 already covers up to 2 GB
per variable. Flag it as a follow-up.

**Step 5.5 — Parquet writer.** `src/export/writers/parquet-writer.js` uses
**DuckDB-WASM itself**: register the cleaned columns as an Arrow table
(`insertArrowTable`), then
`COPY (SELECT …) TO 'out.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)` into the
WASM virtual FS, then `copyFileToBuffer()` → sink. Zero new dependency, fully
client-side, and it works for lazy files without ever materializing them
(`COPY (SELECT … FROM <handle>) TO …` runs entirely inside DuckDB).

Write pandas-compatible metadata by reusing
[`parquet-pandas-metadata.js`](src/data/parquet-pandas-metadata.js) so
`pd.read_parquet()` restores the time index.

**This makes `canExportParquet: desktop` wrong.** Change it to
`canExportParquet: canUseDuckDbWasm` — Parquet export becomes available in the
browser. (Or delete the flag; §1.6 shows nothing reads it today.)

**Step 5.6 — UI.** One "Export data" dialog replacing the CSV-only toolbar
button: format, variable selection, range (visible/full/custom), time format,
precision, compression, plus a size estimate. New i18n keys in all 4 locales.

---

### 2.6 Milestone 6 — Privacy-first local anomaly detection

**Packaging note up front.** Transformers.js defaults to fetching models from
the HuggingFace CDN at runtime. That violates the offline-first mandate and
would be blocked by the Electron navigation policy
(`electron/navigation-policy.cjs`). If it is used at all it must be pinned:
`env.allowRemoteModels = false`, `env.localModelPath = './models/'`, assets
committed under `public/`. And a time-series transformer is 20–100 MB — on a
desktop installer that is a real cost. Recommendation: ship the classical
detectors as the default (they are excellent for this problem, ~30 KB, instant)
and make ONNX a **pluggable, opt-in** backend with a user-supplied `.onnx`.

**Step 6.1 — Feature extraction.** `src/ml/features.js` computes rolling-window
features — mean, std, min, max, slope, MAD, zero-crossings, spectral centroid
(reusing [`src/utils/fft.js`](src/utils/fft.js)) — over `Float64Array` with the
same no-allocation discipline as M1. For lazy files, push this into SQL: DuckDB
window functions over the source file, following the pattern already
established in `temporal-profile-sql.js` and `missing-buckets-sql.js`.

**Step 6.2 — Classical detectors (default, ship first).**
- `detectors/isolation-forest.js` — 100 trees × 256-sample subsample, trained
  in the worker in well under a second for millions of rows, anomaly score per
  window. ~250 lines, no dependency.
- `detectors/robust-zscore.js` — trend/seasonal decomposition (STL-lite via
  the existing `temporal-profile.js` seasonal machinery) + rolling MAD on the
  residual. Catches drift and level shifts, which Isolation Forest does not.

These reuse the streaming median/MAD structure written for M1 step 1.4.

**Step 6.3 — ONNX backend (optional).** `detectors/onnx-detector.js` wraps
`onnxruntime-web` with `wasmPaths` pointed at locally bundled `.wasm`, WebGPU
execution provider when §2.2's device probe says yes, WASM otherwise. Threads
require the COOP/COEP from step 1.1 — another reason to do it first. Model
assets under `public/models/`, added to `build.files` in `package.json`.

**Step 6.4 — `anomaly-worker.js` + engine.** Same pool/cancellation as M1.
Training and inference both off-thread, with progress events.

**Step 6.5 — Presentation.** Anomaly scores become a derived variable
(so they flow through the existing plot/export/session machinery for free) plus
a highlight overlay on the timeseries panel reusing the outlier-marker
rendering already in `data-methods.js`. A results panel lists ranked anomalies
with jump-to-time. Session persistence: store the *config*, not the trained
model (`session-methods.js`).

**Framing.** Label the output "candidate anomalies" with the score and the
detector that fired, never "anomalies" flatly. An unsupervised detector on
engineering data produces false positives, and a plot that asserts otherwise
will cost the user more time than it saves.

---

## 3. Recommended sequencing

| Phase | Contents | Why here |
|---|---|---|
| **0** | Step 1.1 (COOP/COEP), `src/core/` pool + task client | Multiplier for everything; nothing else depends on ordering |
| **1** | Step 2.1 (kill the zoom copies) | Smallest diff, biggest measured win, zero new tech |
| **2** | M1 steps 1.3–1.4 (parse + compute workers) | The actual "60 fps during heavy math" requirement |
| **3** | M4 (expression compiler) | Reuses the pool; unlocks incremental live evaluation |
| **4** | M3 (live transports) | Ingest half already exists; needs M4's incremental path to be useful at rate |
| **5** | M5 (export engine) | Independent; high user value; no perf risk |
| **6** | M6 (anomaly detection) | Depends on M1 kernels and COOP/COEP |
| **7** | M2 steps 2.2–2.5 (WebGPU) | Re-evaluate after phase 1 — may be unnecessary |

Every phase ships behind a capability flag with the current path as fallback,
and adds a `scripts/test-*.mjs` entry wired into `npm run test:release`. The
existing 60-script test suite is the safety net that makes this refactor
tractable — it should stay green at every step, and `bench/baseline.md` should
gain a row per phase.

## 4. Open questions for the user

1. **Target hardware.** WebGPU on Electron 42 is fine; on GitHub Pages a
   meaningful share of visitors will not have it. Is the perf target the
   desktop build, the web build, or both equally?
2. **CSP.** Adding one blocks `new Function` (M4 step 4.3). Ship a CSP and go
   WASM-only, or stay CSP-free and keep the JS codegen path?
3. **Model size budget for M6.** Classical-only (~30 KB) or is a bundled ONNX
   model of tens of MB acceptable in the installer?
4. ~~**`csv-time-detection_option.js`** — dead fork, or intentional?~~ Answered:
   dead fork, deleted. M1 only has to keep `csv-time-detection.js` working.
