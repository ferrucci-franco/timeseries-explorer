# Time-axis unification — design & implementation plan (v2, post-review)

> Status: **design proposal, analysis only — no product code changed.**
> Branch: `worktree-feature+mixed-xaxis-plot`. Base commit: `2f5239d`.
> This is a full rewrite of v1 after the adversarial review in `docs/time-axis-unification-review.md`.
> Every code claim is anchored to `file:line`. Citations marked **(v)** were re-verified against the code during this rewrite; the rest were cross-checked against the review, which proved accurate on every point independently verified.
> Audience: implementers and reviewers (incl. AI review). Self-contained.

---

## 0. What changed vs v1 (review disposition)

| Review objection (severity) | Disposition | Structural change in v2 |
|---|---|---|
| C1 — "numeric" is treated as elapsed seconds | **ACCEPTED** | New **semantic/encoding taxonomy**; unknown numeric defaults to `raw`, never `seconds`. |
| C2 — one render signature can't gate all modes | **ACCEPTED** | Split into **renderSignature** (coordinate sharing) vs **operationCapabilities** (per-mode contracts). |
| H3 — four symptoms ≠ one immediate cause | **ACCEPTED PARTIALLY** | Reframed as **one design deficiency, four distinct proximate causes**. |
| H4 — duration+seconds mixing isn't free | **ACCEPTED** | New **`effectivePanelDisplay`** resolver spanning layout/ticks/hover/title/export/sync. |
| H5 — phase order would drop new state | **ACCEPTED** | Phase 0 now lands model + both normalizers + session migrator + parser adapter **together**. |
| H6 — "each elapsed from own t=0" is a policy | **ACCEPTED** | Explicit, persisted **alignmentPolicy**. |
| M7 — negative-time diagnosis outdated | **ACCEPTED** | Reframed constraints as **monotonicity / positive-step**, not `time ≥ 0`. |
| Citation errors (several) | **ACCEPTED** | All corrected below. |

Nothing in the review was rejected outright. The only *partial* is H3: the review is right that the four symptoms have different **immediate** causes, but they still share a single **design-level** deficiency, which this document keeps as the organizing theme (see §1).

---

## 1. Revised root cause

There is **one design deficiency** with **four distinct proximate causes**. v1 over-claimed "one immediate cause"; that was wrong.

**Design deficiency (shared):**
(a) Time has no first-class *semantic + encoding* model — the codebase carries only a coarse `datetime | numeric` split, assigned **inconsistently** between parser *metadata* and the *abscissa variable*; and
(b) both **display availability** and **overlay eligibility** are gated on that coarse split.

**Proximate causes (distinct, each verified):**

| # | Symptom | Proximate cause | Evidence |
|---|---|---|---|
| S1 | datetime + numeric-seconds cannot overlay | Overlay guard compares provenance `(_timeKind, _timeDisplayMode)` | `src/plots/plot-manager.js:2460-2462` **(v)** |
| S2 | numeric `.mat` has no time controls | Transform panel gates on `timeVar.timeKind`; compounded by metadata-vs-variable inconsistency (numeric/index variables carry no `timeKind`; only metadata does) | `src/app/methods/file-methods.js:2552-2557, 2798, 2859` **(v)**; `src/parsers/matlab-mat-file.js:628-637` vs `:657-658` **(v)**; `_getTimeVar` returns only the abscissa: `src/plots/plot-manager.js:3061-3064` **(v)**; OpenModelica delegates to a legacy parser that never sets abscissa `timeKind`: `matlab-mat-file.js:327-339`, `mat-parser.js:135-164` |
| S3 | CSV Format can't assert "seconds" | No explicit numeric-elapsed+unit assertion and no override when Auto misdetects; `Custom` is datetime-only. **Not** "manual = datetime hard-wired": Auto already yields `kind:'numeric'` for a manually chosen column | `src/ui/csv-parsing-preview-dialog.js:39-42` **(v)**, numeric fallback at `:432-445` **(v)** |
| S4 | `s.SSS` anchors to 2001 and breaks | The datetime pattern parser reads `s.SSS` as clock time-of-day with default year 2001 and clock-second validation; there is no elapsed/duration parse path | `src/parsers/csv-time-detection.js:1252` (year←2001), `:1271` (seconds>59 → NaN), literal `.` at `:1248` **(v)**; token map/anchor `:335-398, 380-391` **(v)** |

So the fix must address the shared deficiency (introduce first-class time semantics) **and** each proximate cause, but they are not a single line.

---

## 2. The canonical model (complete)

Each file's time axis is described by a **TimeAxisModel** split into *intrinsic* (what the raw values are) and *display* (how the user shows them).

```
TimeAxisModel = {

  // ── INTRINSIC — set by the parser/adapter; immutable description of raw values ──
  semantic:    'absolute' | 'elapsed' | 'count' | 'coordinate' | 'unknown'
  encoding:    'epoch-ms' | 'unix-s' | 'excel-serial' | 'matlab-datenum'
             | 'cf-time'  | 'elapsed-number' | 'row-count' | 'raw-number'
  calendarId:  'gregorian' | '360_day' | '365_day' | '366_day' | 'noleap' | 'all_leap' | 'none'
  rawUnit:     'ps'|'ns'|'us'|'ms'|'s'|'min'|'h'|'d'|'week'|'year' | null
  originMs:    number | null          // absolute anchor (epoch ms) if intrinsically known
  availableSources: subset of ['values','row-index']

  // ── DISPLAY — set by the unified menu; user-editable ──
  selectedSource:  'values' | 'row-index'
  display:         'calendar' | 'duration' | 'seconds' | 'index' | 'raw'
  displayUnit:     unit                // axis scaling for seconds/raw
  userOriginDate:  ISO | null          // required when display='calendar' and originMs is null
  calendarFormat:  '24h' | 'ampm'
  alignmentPolicy: 'per-series-zero' | 'shared-absolute-origin'
  deltaT:          { value, unit } | null   // when selectedSource='row-index'

  // ── existing transform fields, unchanged ──
  timeShift, gain, yOffset, cropStart, cropEnd, timeStepMode, customTimeStep, timeStepOriginMode, timeStepOriginDate
}
```

### 2.1 Canonical derivations (with the missing formula v1 omitted)

```
unitToSeconds(u): ps→1e-12 … s→1 … d→86400, week→604800, year→(flag: not fixed-length; only for row-index step, warn)

rawToSeconds(v)   = v · unitToSeconds(rawUnit)              // when semantic='elapsed'
absoluteMs(v)     = decode(encoding, v)                      // epoch-ms | unix-s·1000 | excel/datenum/cf → epoch-ms
elapsedSeconds(row):
    semantic='elapsed'                → rawToSeconds(value(row)) [+ row-index: row·deltaTs]
    semantic='absolute'               → (absoluteMs(row) − originMs)/1000      // matches datetime path data-methods.js:323-330 (v)
    semantic='count'                  → row·deltaTs  (only if a Δt is asserted; else undefined)
    semantic∈{coordinate,unknown}     → undefined
```

**Key correction (C1):** `elapsedSeconds` is **undefined** for `coordinate`/`unknown`. A bare numeric column (e.g. Parquet first column, or `test-files/csv/15_unix_timestamp_seconds.csv` before the user asserts `unix-s`) is `semantic:'unknown'`/`'coordinate'` and gets `display:'raw'` — it is **not** auto-interpreted as elapsed seconds and does **not** join `elapsed-seconds` overlays.

### 2.2 Default display resolution

| semantic + calendar | default display | also offered | notes |
|---|---|---|---|
| absolute, gregorian | calendar | duration, seconds (rel. origin) | today's datetime files |
| absolute, non-gregorian | **raw** (locked) | — | CF `360_day`/`noleap`… have no gregorian `Date`; see Pending Risks |
| elapsed | **seconds** (negative-safe, scientific default) | duration, calendar (needs `userOriginDate`) | Modelica `.mat`, elapsed CSV |
| count | index | seconds/duration only if Δt asserted | generated index |
| coordinate / unknown | **raw** | nothing until user asserts semantic | **no auto-seconds** |

---

## 3. Parse ↔ display rules (anti-duplication)

| Layer | Decides | Format-specific? | Output |
|---|---|---|---|
| **Parse / reparse** | The *intrinsic* fields: which column/array is time; its `semantic`/`encoding`/`calendarId`/`rawUnit`/`originMs`. | **Yes** | a `TimeAxisModel` intrinsic block |
| **"Time axis" menu** (post-load) | The *display* fields only. | **No — identical everywhere** | mutations to the same `transform` model |

**Golden rule (confirmed decision):** *parse decides what the value is; the menu decides how it looks; one shared component; one source of truth.* The parse dialog never owns duration/calendar-from-origin logic — it only asserts intrinsic encoding. A preview in the dialog renders the same shared component and writes the same model.

**Single resolver.** Introduce `_timeAxisModel(fileId)` as the *only* reader of time semantics, reconciling the current split (parser metadata + abscissa variable + `timeSourceStrategy`). This replaces scattered `_getTimeVar().timeKind` reads (`plot-manager.js:3061-3064` **(v)**) and the metadata/variable inconsistency (`matlab-mat-file.js:628-637` vs `:657-658` **(v)**; `csv-parser.js:139-160` sets `timeVariable.timeKind` only for datetime/index).

---

## 4. renderSignature vs operationCapabilities (C2)

Two **independent** decisions. v1 conflated them.

### 4.1 renderSignature — *can two traces share Plotly coordinates?*

| display | renderSignature |
|---|---|
| calendar | `date` |
| duration | `linear:elapsed-seconds` |
| seconds | `linear:elapsed-seconds` |
| index | `linear:count` |
| raw | `linear:raw:<unit?>` |

- `duration` and `seconds` share `linear:elapsed-seconds` ⇒ **mixable** (task b), falling out of the model.
- `raw` is compatible only with an **identical** `raw:<semantic+unit>`; `unknown` is never auto-compatible.
- This governs **only** whether traces can co-plot on one axis. It is **not** an operation gate.

### 4.2 operationCapabilities — *what a mode requires*, derived predicates

`hasAbsoluteGregorianCalendar`, `hasPhysicalTimeUnit`, `isMonotonic`, `isUniform`, `hasKnownRate`, `supportsFrequencyHz`, `hasElapsed`.

Each analysis mode declares required capabilities and enforces them **independently of renderSignature** (evidence for the current, stricter-than-render requirements):

| Mode | Requires | Evidence |
|---|---|---|
| timeseries | render-compatible x (same renderSignature) | guard `plot-manager.js:2460-2462` **(v)** |
| phase2dt | same as timeseries | `plot-manager.js:2472-2474` **(v)** |
| histogram | render-compatible time (conservative; real dependency weaker — revisit) | `plot-manager.js:2105, 2473` **(v)** |
| fft | `isMonotonic` + `isUniform`; `supportsFrequencyHz` only if physical unit; index→cycles/sample | `src/utils/fft.js:254-299` **(v)** |
| heatmap | `hasAbsoluteGregorianCalendar` **and** display=calendar; rejects generated non-calendar index | `src/plots/methods/heatmap-methods.js:339-365` **(v)** |
| temporal-profile | datetime (calendar) traces; non-datetime skipped/warned | `src/plots/methods/temporal-profile-methods.js:576-590` **(v)** |
| correlation | render-compatible time; cross-file pair alignment TBD | `plot-manager.js:2472-2474` **(v)** |

**Scope decision (review correction 7):** the broadened overlay in Phase 1 applies **only** to `timeseries`/`phase2dt` with explicit `elapsed` or matching `absolute`. Heatmap/FFT/temporal-profile/correlation keep their current strict contracts and are broadened later, per mode, with their own tests.

---

## 5. Alignment policy (H6)

Two elapsed series from different origins can overlap numerically and imply a **false simultaneity**. The origin today is resolved from several fallbacks (`timeOriginMs` → metadata → `timeStart` → first datum): `src/plots/methods/data-methods.js:292-309` **(v)**. Therefore alignment is a **policy**, not a byproduct:

- `per-series-zero` — each series drawn from its own `t=0` (default when overlaying `elapsed`). A visible panel note states the axes are per-series-relative.
- `shared-absolute-origin` — align on real timestamps (only when all series are `absolute`, or the user assigns an origin to `elapsed` series).

The policy is **shown in the panel and persisted** in the model. Mixing `elapsed` with `absolute` forces the user to choose: treat all as elapsed (per-series-zero) or assign an origin to the elapsed series (→ absolute, shared origin).

---

## 6. Legacy → canonical matrix

Adapter mapping (used by `_timeAxisModel`; no data migration, pure derivation):

| Current state (timeKind / displayMode / strategy) | semantic | encoding | default display |
|---|---|---|---|
| datetime / calendar / (csv/nc/pickle datetime) | absolute | epoch-ms | calendar |
| datetime / elapsedSeconds | absolute | epoch-ms | seconds |
| datetime / elapsedDateTime | absolute | epoch-ms | duration |
| numeric, header/unit says seconds (elapsed) | elapsed | elapsed-number (unit=s) | seconds |
| numeric, **unknown** (DuckDB first col, bare CSV numeric) | unknown | raw-number | **raw** |
| numeric, Unix epoch (asserted) | absolute | unix-s | calendar |
| numeric, Excel serial / MATLAB datenum (asserted/detected) | absolute | excel-serial / matlab-datenum | calendar |
| index / index / generated-index | count | row-count | index |
| index + calendar origin (`timeStepOriginMode='calendar'`) | count→absolute | row-count + origin | calendar |
| CF-time gregorian | absolute | cf-time (gregorian) | calendar |
| CF-time non-gregorian (`360_day`…) | coordinate | cf-time (non-greg) | **raw** (locked) |

Evidence: DuckDB first-numeric selection `src/data/duckdb-source.js:2456-2475` **(v)**; CF gregorian vs excluded calendars `src/parsers/netcdf-parser.js:503-532` **(v)** (non-gregorian at `:512`, raw fallback `:531`); Excel/datenum→epoch-ms `csv-time-detection.js:1038-1058, 1362-1379`.

---

## 7. Compatibility matrix by plot mode

| Mode | renderSignature needed | operationCapabilities | overlay in Phase 1? |
|---|---|---|---|
| timeseries | equal signature (`date` \| `elapsed-seconds` \| `count` \| identical `raw`) | — | **yes** (elapsed/absolute) |
| phase2dt | equal signature | — | **yes** |
| histogram | equal signature (conservative) | — | later |
| fft | per-file | `isMonotonic`+`isUniform`; Hz needs physical unit | later |
| heatmap | per-file | `hasAbsoluteGregorianCalendar` + calendar | later |
| temporal-profile | per-file | datetime/calendar | later |
| correlation | equal signature | pair alignment contract | later |

`unknown`/`coordinate` (display `raw`) never satisfies any analysis-mode capability until the user asserts a semantic.

---

## 8. Migration & backward compatibility

1. **Both normalizers** must carry the new transform fields or they are silently dropped: `src/plots/methods/data-methods.js:99-133` **(v)** and `src/app/methods/file-methods.js:2499-2533` **(v)**. Update both in lockstep.
2. **Session versioning.** The loader rejects any non-matching version by exact equality: `src/app/methods/session-methods.js:312-314` **(v)**; the transform is serialized normalized (`:187-224`) and re-normalized on restore (`:700-712`). Therefore: bump `SESSION_VERSION` **and ship a v1→v2 migrator** that maps legacy `(timeKind, timeDisplayMode, …)` to the canonical fields. A round-trip test is mandatory.
3. **Parser outputs.** Prefer deriving intrinsic fields in `_timeAxisModel` (adapter) from existing `timeSourceStrategy`/metadata **without** changing parsers first; add explicit `semantic`/`encoding` to parsers only where derivation is ambiguous (e.g. unit ps/ns/us needs the source unit preserved).

---

## 9. Phased plan (reordered per H5)

**Phase 0 — Canonical core + adapters + persistence (lands together, no behavior change).**
`_timeAxisModel(fileId)` resolver; legacy→canonical adapter (§6); extend **both** normalizers; session v2 + migrator + round-trip; parser metadata preserved (units incl. us/ns). *Acceptance:* every current file yields the same displays/titles/signatures as today; sessions v1 load; golden snapshots unchanged.

**Phase 1 — renderSignature + overlay guard (timeseries/phase2dt only) + effectivePanelDisplay.**
Replace the guard (`plot-manager.js:2455-2470`) with renderSignature comparison, broadened **only** for explicit `elapsed`/`absolute`; `unknown` stays incompatible. Add `effectivePanelDisplay` and apply to **layout, ticks (with `tickmode/tickvals/ticktext` cleanup), hover/customdata, title, export, cross-panel sync** (the relayout helper only emits present keys — `data-methods.js:276-281` **(v)** — so removals must be explicit). Revalidate mixed traces on transform change (today `setFileTransform` rebuilds but does not re-check: `plot-manager.js:175-207` **(v)**). Actionable alert text.

**Phase 2 — Unified capability-driven menu + unit conversion + value-preserving numeric→(duration|calendar).**
`availableSources` vs `selectedSource`; full unit selector; `userOriginDate`; default resolution (`unknown→raw`). Translate lazy filters between raw and canonical units in both directions (`duckdb-source.js:513-525`).

**Phase 3 — Parse dialog: explicit encodings.**
Add Format entries `Numeric elapsed (unit)`, `Unix epoch (s/ms)`, `Excel serial`, `MATLAB datenum`; numeric/absolute branch in `buildManualTimeSource` (`csv-parsing-preview-dialog.js:337-445`); offer an elapsed/duration parse so `s.SSS`-style columns no longer route through the 2001 clock parser.

**Phase 4 — Operation contracts per mode.**
Wire heatmap/fft/temporal-profile/correlation to `operationCapabilities` (not renderSignature). Canonical-unit derivative/integral (`data-tools-methods.js:1020-1043`); Live Update compares canonical signature not `metadata.timeKind` (`live-update-methods.js:726`); export CSV emits per-trace time columns rather than reusing the first trace's for all (`plot-manager.js:1938-1965`); cross-file hover no longer rejects numeric↔elapsed by kind (`data-methods.js:804-823`).

**Phase 5 — Hardening / precision / docs.**
Eager vs lazy axis equivalence; CF non-gregorian & sub-ms precision decisions (§11); full test matrix (§10).

---

## 10. Tests & acceptance criteria

**Run/extend existing:** parsers (`test-csv-fixtures`, `test-csv-to-parquet-core`, `test-excel-parser`, `test-matlab-parser`, `test-generic-netcdf-parser`, `test-pickle-parser`, `test-pypsa-netcdf-parser`, `test-parquet-*`); render/transform (`test-calendar-axis`, `test-calendar-heatmap`, `test-file-transform-reset`, `test-mode-toolbar`, `test-timeseries-stack`, `test-histogram`, `test-phase2d`); analysis/lazy (`test-fft`, `test-correlation*`, `test-temporal-profile*`, `test-lazy-phase-logic`, `test-data-tools`, `test-missing*`, `test-regression*`); persistence (`test-session-state-roundtrip`, `test-session-project-save`, `test-pypsa-session`, `test-live-update-logic`).

**New, mandatory:**
1. Unknown numeric is **not** auto-interpreted as seconds (stays `raw`, incompatible).
2. Unix epoch seconds vs elapsed seconds resolve to different semantics.
3. `s / ms / us / ns` converge to the same rendered elapsed.
4. Different origins × both alignment policies produce the documented axes.
5. Transforming a trace **after** it was added revalidates the panel.
6. duration+seconds mixed in **both** trace orders — layout, ticks, hover, export all consistent.
7. Negative time, non-uniform sampling, and FFL/FFT monotonicity constraints.
8. CF `360_day`/`noleap` stay `raw`/coordinate — no gregorian calendar offered.
9. MAT index/numeric with metadata-on-variable inconsistency resolves correctly via `_timeAxisModel`.
10. Session v1 → v2 migration and round-trip of every new field.
11. Eager and lazy produce **identical** axes.

**Acceptance gate per phase:** no golden snapshot changes in Phase 0; each later phase adds capability without regressing the prior phase's snapshots.

*Sampling note (from the review, reproduced):* `test:csv/matlab/netcdf/pickle/calendar-axis` currently pass; `test:session-state` could not complete in the worktree (missing `node_modules/fflate/esm/browser.js` and a git-ignored bench fixture) — a Phase 0 prerequisite is a working test env for persistence.

---

## 11. Pending risks (unresolved by design; need explicit decisions)

1. **CF non-gregorian calendars** (`360_day`, `noleap`, …) have no gregorian `Date`. Decision taken: keep `coordinate`/`raw`, no calendar/duration/FFT-Hz. Revisit only with a calendar-aware time library.
2. **Sub-ms / us / ns precision.** The generated sub-ms calendar keeps *relative seconds on a linear axis* to avoid materializing `Date` (`data-methods.js:334-343, 475-493`). Forcing `absoluteMs` (Date-ms) would lose precision; the model must preserve the relative-high-res path. Pickle truncates BigInt ns → ms today (`pickle-parser.js:499-506`) — a standing precision limit.
3. **Export CSV** reuses the first trace's time column for all columns except `independentIndex` (`plot-manager.js:1938-1965`); dangerous once overlays broaden. Must become per-trace.
4. **histogram/correlation** real time-dependency depth is unclear; kept conservative (equal renderSignature) pending analysis.
5. **year/week Δt** units are not fixed-length; only meaningful for row-index step with a warning.

---

## 12. Summary

The unifying theme survives review: time lacks a first-class **semantic + encoding** model, and display + overlay are gated on a coarse `datetime|numeric` split. But numeric is **not** elapsed (C1), one render signature is **not** an operation gate (C2), mixed display needs an **effectivePanelDisplay** (H4), and new state must land **with** its normalizers, session migrator, and parser adapter (H5). v2 introduces the semantic taxonomy, separates render from operation capabilities, makes alignment an explicit policy, and reorders the phases so persistence is never outrun by features.
