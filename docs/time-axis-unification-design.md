# Time-axis unification — design & implementation plan (v3, post-review-2)

> Status: **design proposal, analysis only — no product code changed.**
> Branch: `worktree-feature+mixed-xaxis-plot`. Base commit: `2f5239d`.
> v3 incorporates the second adversarial review of v2. Every code claim is anchored to `file:line`; **(v)** marks claims re-verified against the code during this rewrite.
> Prior artifacts in-repo: `docs/time-axis-unification-review.md` (review of v1). Self-contained.

---

## 0. Disposition of review-2 (v2 → v3)

All eight review-2 findings **ACCEPTED**; none rejected. Structural changes:

| Review-2 finding | Change in v3 |
|---|---|
| B1 — `encoding` conflates source format with stored representation (risk of double-decode) | Split **`storageEncoding`** (what's in the array) from **`sourceEncoding`** (provenance). `absoluteMs` uses `storageEncoding` only. |
| B1b — `originMs` conflates decode anchor with elapsed reference | Split **`decodeOrigin`** (raw→absolute anchor) from **`elapsedReferenceMs`** (t=0 for elapsed display). |
| B2 — no universal channel to reclassify `unknown` for non-CSV formats | Add **`interpretationOverride`** in the common post-load menu; semantics are parser-*seeded* but user-*overridable* (no longer "immutable"). |
| B3 — display/unit/alignment modeled per-file but are panel decisions | New **`PanelTimeAxisState`** + a normative **`resolvePanelTimeAxis`** algorithm (§5). Per-file model keeps only a *preference*; the panel decides. |
| B4 — phases leave broken export/hover/data-tools/live-update | Re-scoped phases (§9): export+hover move to the phase that first enables mixed overlay; data-tools with unit conversion; live-update gated. |
| G5 — crop/shift/zoom not canonicalized | Explicit **canonical crop/shift domain** decision + migration + tests (§8). |
| G6 — CF non-gregorian over-blocked | Separate **`hasElapsed`** from **`hasGregorianCalendar`**; CF `360_day`/`noleap` get seconds/duration/physical-FFT, only gregorian calendar/heatmap blocked. |
| G7 — "[s] ⇒ elapsed" unsafe | Auto-elapsed requires **strong provenance**; generic numeric stays `unknown`. |
| Minor citations | Corrected in-place (§11). |

---

## 1. Root cause (unchanged from v2, validated)

One **design deficiency** — time has no first-class *semantic + storage encoding* model (only a coarse `datetime|numeric` split, assigned inconsistently between parser metadata and the abscissa variable), and both display availability and overlay eligibility are gated on that split — with **four distinct proximate causes**:

| # | Symptom | Proximate cause | Evidence |
|---|---|---|---|
| S1 | datetime + numeric-seconds cannot overlay | guard compares provenance | `plot-manager.js:2460-2462` **(v)** |
| S2 | numeric `.mat` has no time controls | panel gates on `timeVar.timeKind`; metadata/variable inconsistency | `file-methods.js:2552-2557, 2798, 2859` **(v)**; `matlab-mat-file.js:628-637` vs `:657-658` **(v)**; `_getTimeVar` returns only abscissa `plot-manager.js:3061-3064` **(v)** |
| S3 | CSV Format can't assert "seconds" | no explicit numeric-elapsed+unit assertion; Auto already yields numeric | `csv-parsing-preview-dialog.js:39-42`, numeric fallback from `:431` **(v)** |
| S4 | `s.SSS` anchors to 2001, breaks | datetime clock parser (year←2001, clock-second validation); no elapsed parse | `csv-time-detection.js:1252, 1271`; literal escaped at `:1245` **(v)** |

---

## 2. The canonical model (v3)

Two blocks: **intrinsic** (raw description, parser-seeded) and **display preference** (user, per file). The *effective* display/unit/alignment are decided at the **panel** (§5), not here.

```
TimeAxisModel = {

  // ── INTRINSIC (parser-seeded; overridable only via explicit interpretationOverride) ──
  semantic:        'absolute' | 'elapsed' | 'count' | 'coordinate' | 'unknown'
  storageEncoding: 'epoch-ms' | 'unix-s' | 'raw-number' | 'row-count'   // what the stored array actually holds
  sourceEncoding:  'epoch-ms'|'excel-serial'|'matlab-datenum'|'cf-time'|'unix-s'|'elapsed-number'|'raw'|'row-count' // provenance label
  storageUnit:     'ps'|'ns'|'us'|'ms'|'s'|'min'|'h'|'d'|'week' | null  // unit of raw-number values (physical time or coordinate)
  calendarId:      'gregorian'|'360_day'|'365_day'|'366_day'|'noleap'|'all_leap'|'none'
  decodeOrigin:    number(epochMs) | null   // anchor to turn relative raw-number → absolute (CF offset / asserted unix)
  availableSources: subset of ['values','row-index']

  // ── DISPLAY PREFERENCE (per-file; the panel may override, see §5) ──
  preferredDisplay: 'calendar'|'duration'|'seconds'|'index'|'raw'
  preferredUnit:    unit
  userOriginDate:   ISO | null            // when calendar requested and decodeOrigin/absolute is absent
  elapsedReferenceMs: number | null       // t=0 reference for elapsed display; null → per-series raw[0]
  calendarFormat:   '24h'|'ampm'
  deltaT:           { value, unit } | null // when selectedSource='row-index'
  selectedSource:   'values'|'row-index'
  interpretationOverride: { semantic, storageEncoding, storageUnit, decodeOrigin } | null  // user reclassification (§4.3)

  // ── existing transform fields — now with a defined canonical domain (§8) ──
  timeShift, gain, yOffset, cropStart, cropEnd, timeStepMode, customTimeStep, timeStepOriginMode, timeStepOriginDate
}
```

### 2.1 Canonical derivations (no double-decode — B1)

The parsers already convert Excel/MATLAB/decimal-year/CF-gregorian to **epoch-ms before storing** (`csv-time-detection.js:1043-1058` **(v)**; NetCDF CF gregorian stored as `originMs + raw·scaleMs` in `netcdf-parser.js:512-523` **(v)**; the abscissa variable receives the converted values). Therefore decoding uses **`storageEncoding`**, and `sourceEncoding` is provenance/label only.

```
absoluteMs(row):
  storageEncoding='epoch-ms'   → value(row)
  storageEncoding='unix-s'     → value(row)·1000
  storageEncoding='raw-number' & decodeOrigin≠null & storageUnit is physical
                               → decodeOrigin + value(row)·unitToMs(storageUnit)
  else                         → undefined      // count / coordinate-without-anchor / unknown

elapsedSeconds(row):
  semantic='elapsed'  → (rawValue(row) − refRaw)·unitToSeconds(storageUnit)      // refRaw from elapsedReferenceMs or raw[0]
  semantic='absolute' → (absoluteMs(row) − elapsedRefMs)/1000                    // matches datetime path data-methods.js:323-330 (v)
  semantic='count'    → row·deltaTSeconds  (only if Δt asserted)
  semantic∈{coordinate,unknown} → undefined
```

**decodeOrigin vs elapsedReferenceMs (B1b):** `decodeOrigin` anchors *raw→absolute* (e.g. CF "hours since 2000-01-01" if kept relative). `elapsedReferenceMs` is the *display* t=0 for elapsed/duration. They are independent: a series can be absolute (no decodeOrigin needed) yet show elapsed from a user-chosen reference.

### 2.2 Default semantic resolution (B7 — conservative)

| Intrinsic | semantic | default preferredDisplay | auto? |
|---|---|---|---|
| datetime parsed / epoch-ms / gregorian | absolute | calendar | yes |
| numeric with **strong provenance** of elapsed (e.g. OpenModelica "Simulation time [s]") | elapsed | seconds | yes |
| generic numeric (`[s]` header alone, DuckDB first column, bare CSV numeric) | **unknown** | **raw** | **no** — stays raw until asserted |
| Unix epoch numeric (only if detected/asserted) | absolute | calendar | assert |
| CF gregorian | absolute | calendar | yes |
| CF non-gregorian (`360_day`…) | **elapsed** (physical unit, calendar=non-greg) | seconds/duration | yes for elapsed; calendar blocked |
| generated row index | count | index | yes |

`[s]` sets *scale*, not *elapsed-vs-epoch* (`test-files/csv/15_unix_timestamp_seconds.csv` is `[s]` yet absolute). So `unit=s` alone never promotes `unknown→elapsed`.

---

## 3. Parse ↔ display rules (unchanged golden rule)

Parse decides *what the value is* (intrinsic block); the menu decides *how it looks* (display block); one shared component; one source of truth. A single resolver **`_timeAxisModel(fileId)`** is the only reader of time semantics, reconciling parser metadata + abscissa variable + `timeSourceStrategy`, and applying any `interpretationOverride`.

---

## 4. renderSignature, operationCapabilities, and override

### 4.1 renderSignature — coordinate sharing only

| effective display | renderSignature |
|---|---|
| calendar | `date` |
| duration / seconds | `linear:elapsed-seconds` |
| index | `linear:count` |
| raw | `linear:raw:<unit?>` |

`duration` and `seconds` share `linear:elapsed-seconds` ⇒ mixable (task b). `raw` matches only an identical `raw:<semantic+unit>`; `unknown` never auto-matches.

### 4.2 operationCapabilities — per-mode contracts (independent of renderSignature)

Derived predicates: `hasGregorianCalendar` (absolute ∧ gregorian), `hasElapsed` (elapsed, or absolute, or CF-nongreg physical), `hasPhysicalTimeUnit`, `isMonotonic`, `isUniform`, `supportsFrequencyHz` (physical ∧ uniform ∧ monotonic).

| Mode | requires | evidence |
|---|---|---|
| timeseries / phase2dt | equal renderSignature | `plot-manager.js:2460-2462, 2472-2474` **(v)** |
| histogram | equal renderSignature (conservative) | guard invoked in `histogram-methods.js:112` **(v)** + `plot-manager.js:2472-2474` |
| fft | `isMonotonic` ∧ `isUniform`; Hz needs `hasPhysicalTimeUnit`; index→cycles/sample | `utils/fft.js:254-299` **(v)** |
| heatmap | `hasGregorianCalendar` ∧ display=calendar | `heatmap-methods.js:339-365` **(v)** |
| temporal-profile | datetime/calendar traces | `temporal-profile-methods.js:576-590` **(v)** |
| correlation | equal renderSignature; pair alignment contract TBD | `plot-manager.js:2472-2474` **(v)** |

**CF non-gregorian (G6):** `hasElapsed=true`, `hasPhysicalTimeUnit=true` (unit preserved on the variable, `netcdf-parser.js:544` **(v)**), `hasGregorianCalendar=false`. So seconds/duration/physical-FFT are allowed; only calendar & calendar-heatmap are blocked.

### 4.3 interpretationOverride — the universal reclassification channel (B2)

The unified menu exposes, for **every** format, an "Interpret time as…" control that sets `interpretationOverride` (semantic/storageEncoding/storageUnit/decodeOrigin). This is how an unrecognized numeric `.mat`/Parquet/NetCDF-raw/pickle column becomes `elapsed` or `absolute` post-load — the CSV parse dialog is just the *import-time* entry point to the same override. Consequence: semantics are parser-**seeded**, user-**overridable**; `_timeAxisModel` applies the override before deriving anything.

---

## 5. Panel-level display resolution (B3)

Display, unit, alignment, and shared origin are **panel** decisions, not per-file. Per-file we keep only *preferences*.

```
PanelTimeAxisState = { effectiveDisplay, effectiveUnit, alignmentPolicy, referenceOriginMs }

resolvePanelTimeAxis(panel):                         # deterministic, order-independent
  T = visible time traces
  S = { renderSignature(t) for t in T }
  assert |S| == 1  (guard already blocks mixing 'date' with linear)     # else incompatible
  sig = the single signature
  if sig == 'date':
     effectiveDisplay='calendar'; referenceOriginMs=null(absolute); effectiveUnit=n/a
  elif sig == 'linear:elapsed-seconds':
     effectiveDisplay = ('duration' if every t prefers 'duration' else 'seconds')   # any 'seconds' ⇒ seconds
     effectiveUnit    = panel.unitChoice ?? primaryPreferredUnit ?? 's'             # single panel choice
     alignmentPolicy  = panel.alignmentPolicy ?? 'per-series-zero'
     referenceOriginMs= (alignmentPolicy=='shared-absolute-origin') ? panel.sharedOriginMs : null
  elif sig == 'linear:count':   effectiveDisplay='index'
  elif sig == 'linear:raw:U':   effectiveDisplay='raw'; effectiveUnit=U
```

Normative invariants (testable):
1. Internally **all elapsed traces are seconds**; presentation (duration/seconds) and unit label are chosen **once per panel**.
2. `duration + seconds` in a panel ⇒ **seconds** (negative-safe, scientific default).
3. The result depends only on the **set** of trace preferences, never on insertion order.
4. `shared-absolute-origin` uses one panel `referenceOriginMs`; `per-series-zero` shows each trace from its own raw[0] with a visible "per-series relative" note.

`effectivePanelDisplay` is then applied consistently to **layout, ticks (clearing `tickmode/tickvals/ticktext` when leaving array-tick modes — the relayout helper only emits present keys, `data-methods.js:276-281` **(v)**), hover/customdata, axis title, CSV export, and cross-panel sync**.

---

## 6. Legacy → canonical matrix

| Current (timeKind / mode / strategy) | semantic | storageEncoding | storageUnit | default display |
|---|---|---|---|---|
| datetime / calendar | absolute | epoch-ms | — | calendar |
| datetime / elapsedSeconds | absolute | epoch-ms | — | seconds |
| datetime / elapsedDateTime | absolute | epoch-ms | — | duration |
| numeric, strong-provenance elapsed | elapsed | raw-number | s (etc.) | seconds |
| numeric, generic/unknown | unknown | raw-number | null | **raw** |
| numeric, Unix epoch (detected/asserted) | absolute | unix-s | — | calendar |
| CSV Excel-serial / MATLAB-datenum | absolute | epoch-ms (pre-converted) | — | calendar |
| index / generated-index | count | row-count | — | index |
| index + calendar origin | count→absolute | row-count + decodeOrigin | — | calendar |
| CF-time gregorian | absolute | epoch-ms (pre-converted) | — | calendar |
| CF-time non-gregorian | elapsed | raw-number | CF unit (e.g. d) | seconds (no gregorian calendar) |

Evidence: DuckDB first-numeric selection `duckdb-source.js:2456-2475` **(v)**; CF gregorian vs excluded `netcdf-parser.js:503-533` **(v)**; Excel/datenum/decimal-year→epoch `csv-time-detection.js:1043-1058` **(v)**.

---

## 7. Compatibility matrix by plot mode

| Mode | renderSignature | operationCapabilities | Phase-1 overlay |
|---|---|---|---|
| timeseries | equal | — | **yes** (elapsed/absolute) |
| phase2dt | equal | — | **yes** |
| histogram | equal (conservative) | — | later |
| fft | per-file | monotonic+uniform; Hz needs physical unit | later |
| heatmap | per-file | gregorian calendar | later |
| temporal-profile | per-file | datetime/calendar | later |
| correlation | equal | pair alignment | later |

`unknown`/`coordinate` (display `raw`) satisfies no analysis capability until reclassified via `interpretationOverride`.

---

## 8. Crop / shift / zoom canonicalization (G5)

Today `timeShift`/`cropStart`/`cropEnd` are parsed and applied **in the active display units** (`data-methods.js:550-575` **(v)**), and the UI clears them when the mode changes (`file-methods.js:2833-2837` **(v)**). Under the new model, changing unit/origin/source could silently reinterpret persisted values.

**Decision:** store crop/shift as a **tagged canonical value** `{ domain: 'canonical-seconds'|'epoch-ms', value }`:
- `absolute` axes → `epoch-ms`; `elapsed`/`count` → `canonical-seconds`.
- Display-time conversions happen at render only.
- The v1→v2 (now v2→v3) **session migrator** converts legacy display-unit crop/shift into the tagged canonical form using the axis mode captured at save time.
- Tests: crop/shift survive unit change, origin change, and source change; zoom restoration across a unit change maps correctly (the sole caller of `_mapTimeRangeBetweenModes` restores timeseries `xRange` at `plot-manager.js:205` **(v)** — extend it to the new domains).

---

## 9. Phased plan (re-scoped per B4)

**Phase 0 — Canonical core + adapters + persistence (lands together; no behavior change).**
`_timeAxisModel` resolver (applies `interpretationOverride`); legacy→canonical adapter (§6); extend **both** normalizers (`data-methods.js:99-133` **(v)**, `file-methods.js:2499-2533` **(v)**); session bump + migrator (loader rejects mismatched version by exact equality, `session-methods.js:312-314` **(v)**) including tagged crop/shift; preserve parser units incl. us/ns. *Acceptance:* identical displays/titles/signatures; v1 sessions migrate; golden snapshots unchanged.

**Phase 1 — renderSignature guard + `resolvePanelTimeAxis` + mixed-overlay correctness (timeseries/phase2dt).**
Replace the guard; broaden only for explicit `elapsed`/`absolute`; `unknown` stays incompatible. Implement `PanelTimeAxisState` and apply to layout/ticks/title **and, in the same phase, hover and export** (they are wrong the moment a mixed overlay exists): cross-file hover no longer returns NaN for numeric↔elapsed (`data-methods.js:804-823` **(v)**, gate at `:816`); CSV export emits **per-trace** time columns instead of reusing the first trace's for all (`plot-manager.js:1938-1965`). Revalidate mixed traces on transform change (`setFileTransform` rebuilds without re-checking today, `plot-manager.js:175-207` **(v)**). Actionable alerts.

**Phase 2 — Unified menu + unit conversion + value-preserving numeric→(duration|calendar) + data-tools.**
Capability-driven menu; `availableSources`/`selectedSource`; full unit selector; `userOriginDate`; `interpretationOverride` control for all formats. Lazy filters translate raw↔canonical both ways (`duckdb-source.js:513-525`). **Data-tools moves here** (with unit conversion): derivative/integral must use canonical seconds, not raw numeric deltas (`data-tools-methods.js:1035-1043` **(v)**).

**Phase 3 — Parse dialog: explicit encodings.**
Add Format entries `Numeric elapsed (unit)`, `Unix epoch (s/ms)`, `Excel serial`, `MATLAB datenum`; numeric/absolute branch in `buildManualTimeSource` (`csv-parsing-preview-dialog.js:337-445`); offer elapsed/duration parse so `s.SSS`-style columns bypass the 2001 clock parser. This is the import-time front-end to the same `interpretationOverride`.

**Phase 4 — Per-mode operation contracts + Live Update.**
Wire heatmap/fft/temporal-profile/correlation to `operationCapabilities`. **Live Update** must stop comparing only `metadata.timeKind` (`live-update-methods.js:726` **(v)**): either compare the canonical signature or temporarily block canonical-field files from live append until handled.

**Phase 5 — Hardening / precision / docs.**
Eager vs lazy axis equivalence; CF non-gregorian elapsed; sub-ms/us/ns precision (keep relative-high-res path; do not force `absoluteMs`); full test matrix (§10).

---

## 10. Tests & acceptance criteria

**Extend existing:** parsers (`test-csv-fixtures`, `test-csv-to-parquet-core`, `test-excel-parser`, `test-matlab-parser`, `test-generic-netcdf-parser`, `test-pickle-parser`, `test-pypsa-netcdf-parser`, `test-parquet-*`); render/transform (`test-calendar-axis`, `test-calendar-heatmap`, `test-file-transform-reset`, `test-mode-toolbar`, `test-timeseries-stack`, `test-histogram`, `test-phase2d`); analysis/lazy (`test-fft`, `test-correlation*`, `test-temporal-profile*`, `test-lazy-phase-logic`, `test-data-tools`, `test-missing*`, `test-regression*`); persistence (`test-session-state-roundtrip`, `test-session-project-save`, `test-pypsa-session`, `test-live-update-logic`).

**New, mandatory:**
1. Unknown numeric is **not** auto-elapsed (stays `raw`, incompatible) until `interpretationOverride`.
2. Unix epoch seconds vs elapsed seconds resolve to different semantics.
3. `s/ms/us/ns` converge to identical rendered elapsed.
4. `resolvePanelTimeAxis` is **order-independent**; duration+seconds ⇒ seconds; single panel unit; both trace orders identical for layout/ticks/hover/export.
5. Alignment: different origins × `per-series-zero` vs `shared-absolute-origin`.
6. Transforming a trace after adding it revalidates the panel.
7. Negative time, non-uniform sampling, FFT monotonicity/uniformity.
8. CF `360_day`/`noleap`: seconds/duration/physical-FFT allowed; gregorian calendar/heatmap blocked.
9. `interpretationOverride` reclassifies a numeric `.mat`/Parquet/NetCDF-raw/pickle column post-load.
10. Session v1→v2 migration incl. tagged crop/shift; round-trip of every new field.
11. Crop/shift survive unit/origin/source change; zoom restoration across unit change.
12. Eager and lazy produce identical axes.

**Per-phase gate:** no golden snapshot change in Phase 0; each later phase adds capability without regressing prior snapshots.

*Sampling note:* `test:csv/matlab/netcdf/pickle/calendar-axis` pass; `test:session-state` did not complete in the worktree (missing `node_modules/fflate/esm/browser.js` and a git-ignored bench fixture) — a working persistence test env is a Phase 0 prerequisite.

---

## 11. Corrected citations (from review-2)

| v2 claim | Correction |
|---|---|
| literal `.` failure at `csv-time-detection.js:1248` | The literal is escaped when building the regex at `:1245`; `:1248` only runs the match. **(v)** |
| numeric fallback `:432-445` | Branch computes from `:431`. **(v)** |
| histogram contract at `plot-manager.js:2105` | `:2105` only defines `usesTimeTraces`; the real guard is `histogram-methods.js:112` **(v)** + `plot-manager.js:2472-2474`. |
| "year/week not fixed-length" | **Week is fixed** (604800 s; `data-methods.js:604` converts to 7 days). Only **year** is variable. **(v)** |
| test "FFL/FFT" | Typo → FFT. |

---

## 12. Pending risks

1. **CF non-gregorian**: elapsed/physical only; no gregorian calendar/heatmap. Revisit with a calendar-aware library.
2. **Sub-ms / us / ns precision**: keep the relative-high-res path (`data-methods.js:334-343, 475-493`); never force `absoluteMs`. Pickle truncates BigInt ns→ms today (`pickle-parser.js:499-506`) — standing limit.
3. **Export CSV** per-trace time columns must ship with Phase 1 (currently first-trace-for-all, `plot-manager.js:1938-1965`).
4. **histogram/correlation** true time dependency depth unclear — conservative (equal renderSignature) pending analysis.
5. **year Δt** not fixed-length; row-index step only, with a warning.

---

## 13. Summary

v3 keeps the unifying theme and fixes the v2 modeling errors that review-2 caught: **storage vs source encoding** (no double-decode), **decode origin vs elapsed reference**, a **universal interpretation override** so any format's `unknown` can be reclassified, **panel-level** display/unit/alignment with a **normative, order-independent** resolution algorithm, **CF-nongregorian elapsed**, **canonicalized crop/shift/zoom**, and phases where export/hover/data-tools/live-update land **with** the features that break them rather than after.
