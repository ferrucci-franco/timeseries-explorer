# Time-axis unification — design & implementation plan (v4, post-review-3)

> Status: **design proposal, analysis only — no product code changed.**
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
| H5 — reader surface underestimated (`_fftTimeKind`, `metadata.timeKind`) | §3, §9: Phase 0 enumerates & migrates **all** readers; `_fftTimeKind` must be located (possible latent bug). |
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

**Single resolver, full reader inventory (H5).** `_timeAxisModel(fileId)` becomes the one place that derives semantics (metadata + abscissa variable + `timeSourceStrategy` + `interpretationOverride`). Phase 0 must migrate **every** existing reader onto it — not only `_timeKind` (`data-methods.js:152` **(v)**) and `_timeDisplayMode` (`:236` **(v)**), but also **`_fftTimeKind`** (used by correlation/heatmap/histogram/temporal-profile/interaction; **definition not locatable by search** — see §9/§12) and direct `metadata.timeKind` reads in **data-tools** (`data-tools-methods.js:1028-1031` **(v)**) and **live-update** (`live-update-methods.js:726` **(v)**).

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

**Phase 0 — Canonical core + adapters + persistence + full reader migration (lands together; no behavior change).**
`_timeAxisModel` resolver (applies `interpretationOverride`); legacy→canonical adapter (§6); **migrate every reader** — `_timeKind`, `_timeDisplayMode`, `_fftTimeKind` (locate/define it first; see §12), and direct `metadata.timeKind` reads in data-tools & live-update — onto the resolver or thin wrappers; extend **both** normalizers (`data-methods.js:99-133` **(v)**, `file-methods.js:2499-2533` **(v)**); session bump + migrator (loader rejects mismatched version by exact equality, `session-methods.js:312-314` **(v)**) incl. tagged crop/shift. *Acceptance:* identical displays/titles/signatures; **two generic-numeric files still overlay (C1 non-regression)**; v1 sessions migrate; golden snapshots unchanged.

**Phase 1 — renderSignature guard + `resolvePanelTimeAxis` + mixed-overlay correctness (timeseries/phase2dt).**
Replace the guard; broaden for `elapsed`/`absolute`/identical-`raw`; distinct semantics stay incompatible. Implement `PanelTimeAxisState` and apply to layout/ticks/title **and hover and export in the same phase**: cross-file hover no longer returns NaN for numeric↔elapsed (`data-methods.js:804-823` **(v)**, gate at `:816`); CSV export emits **per-trace** time columns (`plot-manager.js:1938-1965`). Revalidate mixed traces on transform change (`setFileTransform` rebuilds without re-checking, `plot-manager.js:175-207` **(v)**). Actionable alerts.

**Phase 2 — Unified menu + unit conversion + value-preserving numeric→(duration|calendar) + data-tools.**
Capability-driven menu; `availableSources`/`selectedSource`; full unit selector; `userOriginDate`; `interpretationOverride` for all formats. Lazy filters translate raw↔canonical both ways (`duckdb-source.js:513-525`). Data-tools derivative/integral use canonical seconds, not raw deltas (`data-tools-methods.js:1035-1043` **(v)**).

**Phase 3 — Parse dialog: explicit encodings.**
Add Format entries `Numeric elapsed (unit)`, `Unix epoch (s/ms)`, `Excel serial`, `MATLAB datenum`; numeric/absolute branch in `buildManualTimeSource` (`csv-parsing-preview-dialog.js:337-445`); offer an elapsed/duration parse so `s.SSS`-style columns bypass the 2001 clock parser.

**Phase 4 — Per-mode operation contracts + Live Update.**
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

1. **`_fftTimeKind` definition not locatable by search** (used in 6 files, 2 sites guard with `?.`). Must be found before Phase 0 reader migration; possibly a latent bug, tracked separately.
2. **CF non-gregorian**: elapsed only for fixed sub-units (s…week); month/year CF unrepresentable (raw). No gregorian calendar/heatmap.
3. **Sub-ms / us / ns precision**: keep the relative-high-res path (`data-methods.js:334-343, 475-493`); never force `absoluteMs`. Pickle truncates BigInt ns→ms today (`pickle-parser.js:499-506`) — standing limit.
4. **Export CSV** per-trace time columns must ship with Phase 1 (currently first-trace-for-all, `plot-manager.js:1938-1965`).
5. **histogram/correlation** true time dependency depth unclear — conservative pending analysis.
6. **year Δt** not fixed-length; row-index step only, with a warning.

---

## 13. Summary

v4 keeps the architecture and fixes review-3's concrete defects: `raw`/`unknown` axes stay overlay-compatible by unit token (**no numeric↔numeric regression**), `absoluteMs` covers **row-count→absolute**, `resolvePanelTimeAxis` is **provably order-independent** with a deterministic shared origin, the **full reader surface** (incl. `_fftTimeKind`) is migrated in Phase 0, crop/shift is canonicalized across **all four domains**, and CF non-gregorian elapsed is scoped to **fixed units**. The design is now internally consistent; a future external review pass is still advisable before merging product code.
