# Time-axis unification — design & implementation plan (v4, post-review-3)

> Status: **partially implemented — Phases 0–1 shipped, Phase 2 menu shipped; see §14 for the live status and what is deferred.**
> Branch: `worktree-feature+mixed-xaxis-plot`. Base commit: `2f5239d`.
> v4 incorporates the third (self) review of v3. Every code claim is anchored to `file:line`; **(v)** marks claims re-verified against the code.
> Iteration history in-repo: `time-axis-unification-review.md` (v1), `-review-2.md` (v2), `-review-3.md` (v3). Self-contained.

---

## 0. Disposition of review-3 (v3 → v4)

All seven finding-groups **ACCEPTED**; architecture unchanged, fixes are local.

| Review-3 finding | Fix in v4 |
|---|---|
| C1 — v3 would drop today's numeric↔numeric overlay; internal contradiction on `raw` matching | §4.1: **render-compatibility of `raw` is by identical unit token (incl. unitless)**, preserving numeric↔numeric; removed the "unknown never matches" contradiction. |
| C2 — `absoluteMs` omits `row-count → absolute` (generated calendar from index) | §2.1: added the `row-count → absolute` branch. |
| H3 — `resolvePanelTimeAxis` fell back to "primary" unit → order-dependent | §5: **order-independent** `effectiveUnit` rule (finest unit / explicit panel choice); "primary" removed. |
| H4 — `referenceOriginMs` source undefined | §5: **deterministic** `referenceOriginMs` (min `originMs` of absolute traces, or explicit panel origin), persisted. |
| H5 — reader surface underestimated (`_fftTimeKind`, `metadata.timeKind`) | §3, §9: Phase 0 enumerates & migrates **all** readers. **Resolved:** `_fftTimeKind` is defined at `fft-methods.js:1059` **(v)**; it was invisible to search because that file (and `phase2d-fit-methods.js`) contain raw `NUL` bytes used as key separators — a searchability hazard, not a runtime bug (§12.1). |
| H6 — crop/shift domain omits index/raw | §8: tagged domain ∈ `{canonical-seconds, epoch-ms, row-index, raw:<unit>}`. |
| M7/M8/M9 — golden-rule wording; CF non-fixed units; temporal-profile capability wording | §3, §2.2/§4.2, §4.2 fixed. |

---

## 1. Root cause (validated across three reviews)

One **design deficiency** — time has no first-class *semantic + storage encoding* model (only a coarse `datetime|numeric` split, assigned inconsistently between parser metadata and the abscissa variable), and both display availability and overlay eligibility are gated on that split — with **four distinct proximate causes**:

| # | Symptom | Proximate cause | Evidence |
|---|---|---|---|
| S1 | datetime + numeric-seconds cannot overlay | guard compares provenance | `plot-manager.js:2460-2462` **(v)** |
| S2 | numeric `.mat` has no time controls | panel gates on `timeVar.timeKind`; metadata/variable inconsistency | `file-methods.js:2552-2557, 2798, 2859` **(v)**; `matlab-mat-file.js:628-637` vs `:657-658` **(v)**; `_getTimeVar` returns only abscissa `plot-manager.js:3061-3064` **(v)** |
| S3 | CSV Format can't assert "seconds" | no explicit numeric-elapsed+unit assertion; Auto already yields numeric | `csv-parsing-preview-dialog.js:39-42`, numeric fallback from `:431` **(v)** |
| S4 | `s.SSS` anchors to 2001, breaks | datetime clock parser (year←2001, clock-second validation); no elapsed parse | `csv-time-detection.js:1252, 1271`; literal escaped at `:1245` **(v)** |

---

## 2. The canonical model (v4)

Two blocks: **intrinsic** (raw description, parser-seeded, user-overridable) and **display preference** (per file). The *effective* display/unit/alignment are decided at the **panel** (§5).

```
TimeAxisModel = {

  // ── INTRINSIC (parser-seeded; overridable via interpretationOverride) ──
  semantic:        'absolute' | 'elapsed' | 'count' | 'coordinate' | 'unknown'
  storageEncoding: 'epoch-ms' | 'unix-s' | 'raw-number' | 'row-count'   // what the stored array actually holds
  sourceEncoding:  'epoch-ms'|'excel-serial'|'matlab-datenum'|'cf-time'|'unix-s'|'elapsed-number'|'raw'|'row-count' // provenance
  storageUnit:     'ps'|'ns'|'us'|'ms'|'s'|'min'|'h'|'d'|'week' | null  // unit of raw-number values (fixed-length only)
  calendarId:      'gregorian'|'360_day'|'365_day'|'366_day'|'noleap'|'all_leap'|'none'
  decodeOrigin:    number(epochMs) | null   // anchor to turn relative raw → absolute (CF offset / asserted unix / index calendar)
  deltaTSeconds:   number | null            // seconds per row when storageEncoding='row-count'
  availableSources: subset of ['values','row-index']

  // ── DISPLAY PREFERENCE (per-file; the panel may override, see §5) ──
  preferredDisplay: 'calendar'|'duration'|'seconds'|'index'|'raw'
  preferredUnit:    unit
  userOriginDate:   ISO | null
  elapsedReferenceMs: number | null       // t=0 for elapsed display; null → per-series raw[0]
  calendarFormat:   '24h'|'ampm'
  deltaT:           { value, unit } | null // row-index step (source of deltaTSeconds)
  selectedSource:   'values'|'row-index'
  interpretationOverride: { semantic, storageEncoding, storageUnit, decodeOrigin } | null

  // ── existing transform fields — canonical domain per §8 ──
  timeShift, gain, yOffset, cropStart, cropEnd, timeStepMode, customTimeStep, timeStepOriginMode, timeStepOriginDate
}
```

### 2.1 Canonical derivations (no double-decode; complete cases — C2)

Parsers convert Excel/MATLAB/decimal-year/CF-gregorian to **epoch-ms before storing** (`csv-time-detection.js:1043-1058` **(v)**; NetCDF CF gregorian as `originMs + raw·scaleMs`, `netcdf-parser.js:512-523` **(v)**). Decoding therefore uses **`storageEncoding`**; `sourceEncoding` is provenance only.

```
absoluteMs(row):
  storageEncoding='epoch-ms'   → value(row)
  storageEncoding='unix-s'     → value(row)·1000
  storageEncoding='raw-number' & decodeOrigin≠null & storageUnit fixed
                               → decodeOrigin + value(row)·unitToMs(storageUnit)
  storageEncoding='row-count'  & decodeOrigin≠null & deltaTSeconds≠null      // C2: generated calendar from index
                               → decodeOrigin + row·deltaTSeconds·1000
  else                         → undefined

elapsedSeconds(row):
  semantic='elapsed'  → (rawValue(row) − refRaw)·unitToSeconds(storageUnit)          // refRaw from elapsedReferenceMs or raw[0]
  semantic='absolute' → (absoluteMs(row) − elapsedRefMs)/1000                          // matches data-methods.js:323-330 (v)
  semantic='count'    → row·deltaTSeconds  (deltaTSeconds≠null)
  semantic∈{coordinate,unknown} → undefined
```

`decodeOrigin` anchors raw→absolute; `elapsedReferenceMs` is the display t=0. Independent (§2 fields).

### 2.2 Default semantic resolution (conservative; fixed units only)

| Intrinsic | semantic | default display | auto? |
|---|---|---|---|
| datetime parsed / epoch-ms / gregorian | absolute | calendar | yes |
| numeric with **strong provenance** of elapsed (e.g. OpenModelica "Simulation time [s]") | elapsed | seconds | yes |
| generic numeric (`[s]` alone, DuckDB first column, bare CSV numeric) | **unknown** | **raw** | **no** — but see C1: two identical-unit `raw` axes still overlay (§4.1) |
| Unix epoch numeric (detected/asserted) | absolute | calendar | assert |
| CF gregorian | absolute | calendar | yes |
| CF non-gregorian, **fixed sub-unit** (s/min/h/d/week) | elapsed | seconds/duration | yes (no gregorian calendar) |
| CF non-gregorian, **month/year unit** | coordinate | raw | no — non-fixed length, unrepresentable (M8) |
| generated row index | count | index | yes |

`[s]` sets *scale*, not *elapsed-vs-epoch* (`test-files/csv/15_unix_timestamp_seconds.csv` is `[s]` yet absolute).

---

## 3. Parse ↔ display rules (reframed — M7)

**Rule:** the parse layer **seeds** the intrinsic meaning; the user may **override** it through the single `interpretationOverride` field; the display menu chooses only *presentation*. Crucially, meaning and presentation are **never** decided by two separate code paths — both the import dialog and the post-load menu write the same model, read back through one resolver. This keeps the original anti-duplication guarantee while allowing reclassification.

**Single resolver, full reader inventory (H5).** `_timeAxisModel(fileId)` becomes the one place that derives semantics (metadata + abscissa variable + `timeSourceStrategy` + `interpretationOverride`). Phase 0 must migrate **every** existing reader onto it — not only `_timeKind` (`data-methods.js:152` **(v)**) and `_timeDisplayMode` (`:236` **(v)**), but also **`_fftTimeKind`** (defined at `fft-methods.js:1059` **(v)**; a *third* classifier, display- and index-aware — returns `index` for pure generated-index, `datetime` for non-high-res calendar, else `numeric`; used by correlation/heatmap/histogram/temporal-profile/interaction) and direct `metadata.timeKind` reads in **data-tools** (`data-tools-methods.js:1028-1031` **(v)**) and **live-update** (`live-update-methods.js:726` **(v)**). Note: `fft-methods.js` and `phase2d-fit-methods.js` are invisible to ripgrep/`git` content search due to raw `NUL` bytes (§12.1), so any grep-based reader enumeration will silently miss them.

---

## 4. renderSignature, operationCapabilities, override

### 4.1 renderSignature — coordinate sharing (C1 fixed)

| effective display | renderSignature |
|---|---|
| calendar | `date` |
| duration / seconds | `linear:elapsed-seconds` |
| index | `linear:count` |
| raw | `linear:raw:<unit\|∅>` |

**Compatibility rule:** two axes can share coordinates **iff their renderSignature is identical**. For `raw`, "identical" means the same unit token, where *unitless* is a valid token `∅`. Consequences:
- `duration` and `seconds` share `linear:elapsed-seconds` ⇒ mixable (task b).
- **Two generic-numeric (`unknown`/`raw`) axes with the same unit — including both unitless — are compatible, preserving today's numeric↔numeric overlay** (`plot-manager.js:2460-2462` **(v)** currently allows it). This removes v3's contradiction.
- `unknown`/`raw` is compatible only with an *identical* `raw` axis; it never matches `date`/`elapsed-seconds`/`count`, and it never satisfies analysis-mode `operationCapabilities` until reclassified.

### 4.2 operationCapabilities — per-mode contracts (independent of renderSignature)

Predicates: `hasGregorianCalendar` (absolute ∧ gregorian), `hasElapsed` (elapsed, or absolute, or CF-nongreg with fixed unit), `hasPhysicalTimeUnit`, `isMonotonic`, `isUniform`, `supportsFrequencyHz` (physical ∧ uniform ∧ monotonic).

| Mode | requires | evidence |
|---|---|---|
| timeseries / phase2dt | equal renderSignature | `plot-manager.js:2460-2462, 2472-2474` **(v)** |
| histogram | equal renderSignature (conservative) | guard in `histogram-methods.js:112` **(v)** + `plot-manager.js:2472-2474` |
| fft | `isMonotonic` ∧ `isUniform`; Hz needs `hasPhysicalTimeUnit`; index→cycles/sample | `utils/fft.js:254-299` **(v)** |
| heatmap | `hasGregorianCalendar` ∧ display=calendar | `heatmap-methods.js:339-365` **(v)** |
| temporal-profile | **kind datetime** (`_fftTimeKind==='datetime'`), not display=calendar | `temporal-profile-methods.js:577, 583` **(v)** |
| correlation | equal renderSignature; pair alignment TBD | `plot-manager.js:2472-2474` **(v)** |

CF non-gregorian with a **fixed** unit: `hasElapsed=true`, `hasPhysicalTimeUnit=true` (unit preserved on the variable, `netcdf-parser.js:544` **(v)**), `hasGregorianCalendar=false` ⇒ seconds/duration/physical-FFT allowed; only calendar & calendar-heatmap blocked. Month/year CF units → `coordinate`/`raw` (M8).

### 4.3 interpretationOverride — universal reclassification

The unified menu exposes, for **every** format, an "Interpret time as…" control setting `interpretationOverride` (semantic/storageEncoding/storageUnit/decodeOrigin). This is how an unrecognized numeric `.mat`/Parquet/NetCDF-raw/pickle column becomes `elapsed`/`absolute` post-load; the CSV parse dialog is the import-time entry point to the same field. `_timeAxisModel` applies the override before deriving.

---

## 5. Panel-level display resolution (order-independent — H3, H4)

```
PanelTimeAxisState = { effectiveDisplay, effectiveUnit, alignmentPolicy, referenceOriginMs }

resolvePanelTimeAxis(panel):                        # deterministic, order-independent
  T = visible time traces
  S = { renderSignature(t) for t in T }
  assert |S| == 1                                    # guard blocks mixing; else incompatible
  sig = the single signature
  if sig == 'date':
     effectiveDisplay='calendar'; referenceOriginMs=null(absolute); effectiveUnit=n/a
  elif sig == 'linear:elapsed-seconds':
     effectiveDisplay = ('duration' if every t prefers 'duration' else 'seconds')      # any 'seconds' ⇒ seconds
     effectiveUnit    = panel.unitChoice                                               # explicit user choice, else…
                        ?? finestUnit({ preferredUnit(t) for t in T })                 # deterministic, order-independent
     alignmentPolicy  = panel.alignmentPolicy ?? 'per-series-zero'
     referenceOriginMs= (alignmentPolicy=='shared-absolute-origin')
                        ? (panel.userOriginMs ?? min({ originMs(t) for absolute t in T }))   # deterministic (H4)
                        : null
  elif sig == 'linear:count':   effectiveDisplay='index'; effectiveUnit='count'
  elif sig == 'linear:raw:U':   effectiveDisplay='raw';   effectiveUnit=U
```

Normative invariants (testable):
1. All elapsed traces are seconds internally; presentation (duration/seconds) and unit label are chosen **once per panel**.
2. `duration + seconds` ⇒ **seconds** (negative-safe default).
3. **Order independence:** the result is a function of the *set* of `{renderSignature, preferredDisplay, preferredUnit, originMs}`, never of insertion order. `effectiveUnit` uses `finestUnit(...)` (a commutative reduction), **not** any "primary" trace. `referenceOriginMs` uses `min(...)` (also commutative).
4. `shared-absolute-origin` uses one panel `referenceOriginMs`; `per-series-zero` draws each trace from its own raw[0] with a visible "per-series relative" note.

`effectivePanelDisplay` is applied consistently to **layout, ticks (clearing `tickmode/tickvals/ticktext` when leaving array-tick modes — the relayout helper emits only present keys, `data-methods.js:276-281` **(v)**), hover/customdata, axis title, CSV export, and cross-panel sync**.

---

## 6. Legacy → canonical matrix

| Current (timeKind / mode / strategy) | semantic | storageEncoding | storageUnit / deltaT | default display |
|---|---|---|---|---|
| datetime / calendar | absolute | epoch-ms | — | calendar |
| datetime / elapsedSeconds | absolute | epoch-ms | — | seconds |
| datetime / elapsedDateTime | absolute | epoch-ms | — | duration |
| numeric, strong-provenance elapsed | elapsed | raw-number | s (etc.) | seconds |
| numeric, generic/unknown | unknown | raw-number | (nominal unit or ∅) | raw (still overlays identical raw — C1) |
| numeric, Unix epoch (detected/asserted) | absolute | unix-s | — | calendar |
| CSV Excel-serial / MATLAB-datenum | absolute | epoch-ms (pre-converted) | — | calendar |
| index / generated-index | count | row-count | deltaTSeconds | index |
| index + calendar origin | count→absolute | row-count + decodeOrigin | deltaTSeconds | calendar |
| CF-time gregorian | absolute | epoch-ms (pre-converted) | — | calendar |
| CF-time non-gregorian (fixed unit) | elapsed | raw-number | CF unit (e.g. d) | seconds |
| CF-time non-gregorian (month/year) | coordinate | raw-number | — | raw |

Evidence: DuckDB first-numeric selection `duckdb-source.js:2456-2475` **(v)**; CF gregorian vs excluded `netcdf-parser.js:503-533` **(v)**; Excel/datenum/decimal-year→epoch `csv-time-detection.js:1043-1058` **(v)**; generated calendar from index `data-methods.js:334-346` **(v)**.

---

## 7. Compatibility matrix by plot mode

| Mode | renderSignature | operationCapabilities | Phase-1 overlay |
|---|---|---|---|
| timeseries | equal | — | **yes** (elapsed/absolute/identical-raw) |
| phase2dt | equal | — | **yes** |
| histogram | equal (conservative) | — | later |
| fft | per-file | monotonic+uniform; Hz needs physical unit | later |
| heatmap | per-file | gregorian calendar | later |
| temporal-profile | per-file | kind datetime | later |
| correlation | equal | pair alignment | later |

---

## 8. Crop / shift / zoom canonicalization (all domains — H6)

Today crop/shift are parsed/applied in the **active display units** (`data-methods.js:550-575` **(v)**) with four domains — calendar, index (row units), duration/seconds, numeric (`file-methods.js:3034-3045` **(v)**) — and the UI clears them on mode change (`file-methods.js:2833-2837` **(v)**).

**Decision:** store crop/shift as a **tagged value** `{ domain, value }` with `domain ∈ { epoch-ms, canonical-seconds, row-index, raw:<unit> }`:
- `absolute` → `epoch-ms`; `elapsed` → `canonical-seconds`; `count`/index → `row-index`; `coordinate`/`unknown`(raw) → `raw:<unit>`.
- Display-time conversions happen at render only.
- The session migrator converts legacy display-unit crop/shift into the tagged form using the axis mode captured at save time.
- Zoom restoration: the sole caller of `_mapTimeRangeBetweenModes` restores timeseries `xRange` at `plot-manager.js:205` **(v)** — extend it across the four domains.
- Tests: crop/shift survive unit/origin/source change on every domain incl. index and raw; zoom restoration across a unit change.

---

## 9. Phased plan

**Phase 0 — Canonical core + display-reader migration (no behavior change). — DONE.**
`_timeAxisModel` resolver + `_renderSignature` + `_operationCapabilities` (commit 4ad46af); `_fftTimeKind` routed through it (919d4b2); **core inversion** — `_timeAxisModel` now computes from raw primitives and `_timeKind` / `_timeDisplayMode` / `_timeUnitLabel` are thin wrappers over it (d04fd84). Equivalence proven by `scripts/test-time-axis-model.mjs` + `scripts/test-time-axis-readers.mjs`; the whole runnable suite passes (44/44; the 3 session suites need a `fflate` dep missing in the worktree). *Acceptance met:* identical displays/titles/signatures; two generic-numeric files still share a render signature (C1).

> **Re-scoped from Phase 0 → Phase 2/4 (deliberate):** extending the two transform normalizers (`data-methods.js:99-133`, `file-methods.js:2499-2533`) and the session v1→v2 migrator (`session-methods.js:312-314`, incl. tagged crop/shift) are moved to **Phase 2**, where the new persisted fields first exist — adding them empty now would break exact-shape tests for zero behavior gain and cannot be validated here (session round-trip is unrunnable until the worktree `fflate` dep is restored). The direct `metadata.timeKind` reads in **data-tools** (delta-scaling) and **live-update** (change detection) stay in **Phase 2/4** because they read parser metadata, not display state, so rerouting them changes semantics. `interpretationOverride` has no field yet (Phase 2/3 menu), so the resolver has nothing to apply.

**Phase 1 — renderSignature guard + `resolvePanelTimeAxis` + mixed-overlay correctness (timeseries/phase2dt). — DONE (see §14).**
Replace the guard; broaden for `elapsed`/`absolute`/identical-`raw`; distinct semantics stay incompatible. Implement `PanelTimeAxisState` and apply to layout/ticks/title **and hover and export in the same phase**: cross-file hover no longer returns NaN for numeric↔elapsed (`data-methods.js:804-823` **(v)**, gate at `:816`); CSV export emits **per-trace** time columns (`plot-manager.js:1938-1965`). Revalidate mixed traces on transform change (`setFileTransform` rebuilds without re-checking, `plot-manager.js:175-207` **(v)**). Actionable alerts.

**Phase 2 — Unified menu + unit conversion + value-preserving numeric→(duration|calendar) + data-tools. — MENU + numeric→duration DONE; rest DEFERRED (see §14).**
Capability-driven menu; `availableSources`/`selectedSource`; full unit selector; `userOriginDate`; `interpretationOverride` for all formats. Lazy filters translate raw↔canonical both ways (`duckdb-source.js:513-525`). Data-tools derivative/integral use canonical seconds, not raw deltas (`data-tools-methods.js:1035-1043` **(v)**).

**Phase 3 — Parse dialog: explicit encodings.**
Add Format entries `Numeric elapsed (unit)`, `Unix epoch (s/ms)`, `Excel serial`, `MATLAB datenum`; numeric/absolute branch in `buildManualTimeSource` (`csv-parsing-preview-dialog.js:337-445`); offer an elapsed/duration parse so `s.SSS`-style columns bypass the 2001 clock parser.

**Phase 4 — Per-mode operation contracts + Live Update. — FOUNDATION added; wiring DEFERRED (see §14).**
Wire heatmap/fft/temporal-profile/correlation to `operationCapabilities`. Live Update stops comparing only `metadata.timeKind` (`live-update-methods.js:726` **(v)**): compare the canonical signature or block canonical-field files from live append until handled.

**Phase 5 — Hardening / precision / docs.**
Eager vs lazy axis equivalence; CF non-gregorian fixed-unit elapsed; sub-ms/us/ns precision (keep the relative-high-res path; never force `absoluteMs`); full test matrix (§10).

---

## 10. Tests & acceptance criteria

**Extend existing:** parsers (`test-csv-fixtures`, `test-csv-to-parquet-core`, `test-excel-parser`, `test-matlab-parser`, `test-generic-netcdf-parser`, `test-pickle-parser`, `test-pypsa-netcdf-parser`, `test-parquet-*`); render/transform (`test-calendar-axis`, `test-calendar-heatmap`, `test-file-transform-reset`, `test-mode-toolbar`, `test-timeseries-stack`, `test-histogram`, `test-phase2d`); analysis/lazy (`test-fft`, `test-correlation*`, `test-temporal-profile*`, `test-lazy-phase-logic`, `test-data-tools`, `test-missing*`, `test-regression*`); persistence (`test-session-state-roundtrip`, `test-session-project-save`, `test-pypsa-session`, `test-live-update-logic`).

**New, mandatory:**
1. **Non-regression (C1):** two generic-numeric files still overlay after migration; identical-unit raw axes are compatible; differing-unit raw axes are not.
2. Unknown numeric is not auto-elapsed until `interpretationOverride`.
3. Unix epoch seconds vs elapsed seconds resolve to different semantics.
4. `s/ms/us/ns` converge to identical rendered elapsed.
5. **Order independence (H3):** `resolvePanelTimeAxis` yields the same `effectiveUnit`/`referenceOriginMs` under any trace order; duration+seconds ⇒ seconds.
6. **Alignment (H4):** different origins × `per-series-zero` vs `shared-absolute-origin`; `referenceOriginMs` = min of absolute origins.
7. **Generated calendar (C2):** `row-count → absolute` reproduces `_generatedIndexDisplayTime` values, incl. sub-ms.
8. Transforming a trace after adding it revalidates the panel.
9. Negative time, non-uniform sampling, FFT monotonicity/uniformity.
10. CF `360_day`/`noleap` fixed unit: seconds/duration/physical-FFT allowed; gregorian calendar/heatmap blocked; month/year CF stays raw.
11. `interpretationOverride` reclassifies a numeric `.mat`/Parquet/NetCDF-raw/pickle column post-load.
12. **Crop domains (H6):** crop/shift survive unit/origin/source change on epoch-ms, canonical-seconds, row-index and raw axes.
13. Session v1→v2 migration incl. tagged crop/shift; round-trip of every new field.
14. **Reader unification (H5):** every mode reads semantics through `_timeAxisModel`; `_fftTimeKind` call sites resolve identically.
15. Eager and lazy produce identical axes.

**Per-phase gate:** no golden snapshot change in Phase 0; each later phase adds capability without regressing prior snapshots.

*Sampling note:* `test:csv/matlab/netcdf/pickle/calendar-axis` pass; `test:session-state` did not complete in the worktree (missing `node_modules/fflate/esm/browser.js` and a git-ignored bench fixture) — a working persistence test env is a Phase 0 prerequisite.

---

## 11. Corrected citations (cumulative)

| Claim | Correction |
|---|---|
| literal `.` failure at `csv-time-detection.js:1248` | escaped when building regex at `:1245`; `:1248` only runs the match. **(v)** |
| numeric fallback `:432-445` | branch computes from `:431`. **(v)** |
| histogram contract at `plot-manager.js:2105` | `:2105` only defines `usesTimeTraces`; real guard `histogram-methods.js:112` **(v)** + `plot-manager.js:2472-2474`. |
| "year/week not fixed-length" | week is fixed (604800 s, `data-methods.js:604`); only year is variable. **(v)** |
| temporal-profile "datetime/calendar" | code checks kind (`_fftTimeKind==='datetime'`), not display=calendar. **(v)** |
| "only reader of time semantics" | `_fftTimeKind` + direct `metadata.timeKind` reads also exist; enumerated in §3/§9. **(v)** |

---

## 12. Pending risks

1. **Raw `NUL` bytes make two source files invisible to search (tooling hazard, not a runtime bug).** `fft-methods.js` (3 NUL: lines 1286, 1490, 1503) and `phase2d-fit-methods.js` (4 NUL, e.g. line 295) use a literal `\x00` byte as a composite-key separator in template literals instead of the escape `\u0000` used elsewhere (`plot-manager.js:2116` **(v)**). A raw NUL makes ripgrep/`git` treat the file as binary and skip it, which is why `_fftTimeKind` (defined at `fft-methods.js:1059` **(v)**) appeared "missing" in review-3. **Recommended fix:** replace each raw NUL with `\u0000` (semantically identical), restoring plain-text/searchable/diffable files. Do this before Phase 0 so reader enumeration and future diffs are reliable.
2. **CF non-gregorian**: elapsed only for fixed sub-units (s…week); month/year CF unrepresentable (raw). No gregorian calendar/heatmap.
3. **Sub-ms / us / ns precision**: keep the relative-high-res path (`data-methods.js:334-343, 475-493`); never force `absoluteMs`. Pickle truncates BigInt ns→ms today (`pickle-parser.js:499-506`) — standing limit.
4. **Export CSV** per-trace time columns must ship with Phase 1 (currently first-trace-for-all, `plot-manager.js:1938-1965`).
5. **histogram/correlation** true time dependency depth unclear — conservative pending analysis.
6. **year Δt** not fixed-length; row-index step only, with a warning.

---

## 13. Summary

v4 keeps the architecture and fixes review-3's concrete defects: `raw`/`unknown` axes stay overlay-compatible by unit token (**no numeric↔numeric regression**), `absoluteMs` covers **row-count→absolute**, `resolvePanelTimeAxis` is **provably order-independent** with a deterministic shared origin, the **full reader surface** (incl. `_fftTimeKind`) is migrated in Phase 0, crop/shift is canonicalized across **all four domains**, and CF non-gregorian elapsed is scoped to **fixed units**. The design is now internally consistent; a future external review pass is still advisable before merging product code.

---

## 14. Implementation status (live)

The implementation took a **pragmatic path**: rather than persist the full `TimeAxisModel` (semantic/storageEncoding/interpretationOverride/tagged-crop) as new session fields, it kept the existing legacy transform fields and added the minimum needed (`numericTimeDisplay`) so `_timeAxisModel` derives the canonical view from primitives. Everything below is on branch `worktree-feature+mixed-xaxis-plot`.

### Shipped

| Area | What | Key commits |
|---|---|---|
| **Phase 0** | Canonical `_timeAxisModel` + `_renderSignature` + `_operationCapabilities`; core inversion (legacy readers derive from the model); `_fftTimeKind` routed through it | `4ad46af`, `919d4b2`, `d04fd84` |
| **Phase 1** | Overlay guard uses `_renderSignature` (full check: stepped reindex = elapsed-seconds allowed; pure Index/count or calendar over elapsed-seconds blocked); `_resolvePanelTimeAxis`; transform-change revalidation (`_transformBreaksOverlay`); cross-file hover follows the panel axis; **CSV export per-trace time columns** | `0098878`, `d72b412`, `0c9cfcd`, `0b1f6b0`, `5afe603` |
| **Phase 2 (menu)** | Unified Source × Format menu for **all** formats incl. numeric `.mat` (Seconds/Duration); **value-preserving numeric→duration** (`numericTimeDisplay`, no /1000); reindex works for numeric/non-detected axes (real row `i`); Δt dropped from the shared axis title; **duration-vs-seconds = order-independent panel consensus** (all-duration ⇒ duration, any seconds ⇒ seconds) across ticks/hover/title/3D; ⚠ "Reindexing assumptions" popover | `af1bdd6`, `0c9cfcd`, `0b1f6b0` |
| **Phase 4 (foundation)** | `_operationCapabilities` sampling predicates `isMonotonic`/`isUniform`/`supportsFrequencyHz` (additive, no production consumer yet) | `cac20a2` |

### Deferred (and why)

These are the remaining design items; each is either a **user-facing UI feature that needs visual verification on localhost** or a **core refactor with real regression risk**, so they were intentionally not done in an autonomous no-confirmation pass:

- **Value-preserving numeric→Calendar** (assign an origin date to a `.mat`'s seconds → `origin + rawSeconds·1000`). Requires flipping `_timeKind` to `datetime` for these files, which ripples into every analysis-mode gate (heatmap/temporal-profile) and needs calendar-format/UTC/origin-parse verification. **Partial workaround already exists:** reindex → "Create a row index vector" → Show as *Calendar* provides a calendar-from-date axis (row×Δt based; the equidistant caveat is now covered by the ⚠ popover).
- **Phase 3 — parse-dialog encodings / S4** (`Numeric elapsed`, `Unix epoch`, `Excel serial`, `MATLAB datenum`, and an elapsed parse so `s.SSS` columns bypass the year-2001 clock parser at `csv-time-detection.js:1250-1272`). Import-dialog UI needing preview verification.
- **`interpretationOverride`** (reclassify an unknown numeric column post-load) — no persisted field yet; entangled with the full model.
- **Full unit selector** (s/ms/min/h/d) and **`userOriginDate`/alignmentPolicy/shared-absolute-origin**.
- **Tagged crop/shift domains** (§8) and the **session v1→v2 migrator** (§13-item) — the pragmatic path avoided new persisted shapes, so no migrator is needed yet; `numericTimeDisplay` round-trips through the existing normalizer.
- **Phase 4 wiring** — gating heatmap/fft/temporal-profile/correlation on `_operationCapabilities` (behavior-changing; risks regressing analysis-mode availability). Live-update's `metadata.timeKind` compare is **correct as-is** (it compares parsed provenance, not display state — rerouting it to `renderSignature` would be wrong).
- **Phase 5** — hardening / eager-vs-lazy axis equivalence / sub-ms precision matrix.

### Tests added

`test-time-axis-model`, `test-time-axis-readers`, `test-panel-time-axis`, `test-operation-capabilities`, `test-csv-export-time-columns`, plus extensions to `test-file-transform-reset`. Full time/session/phase/analysis suites green.
