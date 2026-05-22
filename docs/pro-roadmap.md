# Professionalization Roadmap

## Done in this step

- Full snapshot saved in `backup/before_new_structure`
- App migrated to ES modules
- New `src/` structure created
- Architecture notes added for faster onboarding and agent navigation
- `app.js` split into:
  - `src/app/viewer-app.js`
  - `src/app/methods/file-methods.js`
  - `src/app/methods/ui-methods.js`
  - `src/app/methods/derived-methods.js`
  - `src/app/methods/tree-methods.js`
- `plot-manager.js` split into:
  - `src/plots/plot-manager.js`
  - `src/plots/methods/data-methods.js`
  - `src/plots/methods/state-methods.js`
  - `src/plots/methods/interaction-methods.js`
- `i18n` moved under `src/i18n`
- CSS split under `src/styles`
- Legacy root files turned into thin entrypoints/facades

## Next recommended phases

## TODO: DateTime CSV Time Axes

Goal: support CSV files whose first column is DateTime while keeping the current numeric simulation-time behavior safe.

Planned time model:

- Add per-time-variable metadata:
  - `timeKind: 'numeric' | 'datetime'`
  - `timeDisplayMode: 'calendar' | 'elapsed'`
  - `timeOriginMs: number | null`
- For DateTime CSV columns, parse values to numeric Unix milliseconds internally.
- Calendar mode displays real dates/times on axes and hover labels.
- Elapsed mode displays duration from `timeOriginMs`, preserving current numeric workflows.

CSV import:

- Keep time-axis guessing isolated in `src/parsers/csv-time-detection.js`, so the detection logic can be improved/replaced without touching the parser data-shaping code.
- Detect DateTime columns by header and content; do not assume the first column is always time.
- Support split `Date` + `Time` columns, using the combined timestamp as the abscissa and keeping other numeric columns as variables.
- For ambiguous slash dates such as `01/08/2022`, default to day/month/year because this format is common in European measurement logs.
- Preserve classic CSVs where the first column is numeric time.
- Default DateTime imports to elapsed mode first for compatibility.
- Later add an import/settings UI checkbox: "Show as elapsed duration" / "Use calendar time".

Axes:

- Timeseries:
  - `numeric`: current behavior.
  - `datetime + calendar`: Plotly date x-axis.
  - `datetime + elapsed`: numeric elapsed duration axis.
- Phase `2D+t`:
  - Use calendar time on `scene.xaxis` when Plotly 3D date axes behave correctly.
  - If Plotly 3D date axes are unreliable, keep numeric milliseconds and provide custom date tick labels.

Crop and shift:

- Numeric/elapsed mode: existing numeric crop and shift fields.
- Calendar mode: crop fields become date/time inputs and are parsed to Unix milliseconds.
- Calendar mode shift should be duration-based (`ms`, `s`, `min`, `h`, `d`, `w`).
- Avoid month/year shifts initially because their duration depends on calendar context.

Measurement tool:

- Store cursor positions as numbers.
- Calendar mode displays cursor A/B as formatted DateTime.
- `Delta X` displays a human duration.
- `1/Delta X` computes Hz from seconds (`deltaMs / 1000` for DateTime).
- Snap/search remains numeric because Unix milliseconds are ordered.

Synchronized hover:

- `numeric <-> numeric`: sync by numeric x value.
- `datetime calendar <-> datetime calendar`: sync by Unix milliseconds.
- `datetime elapsed <-> datetime elapsed`: sync by elapsed duration.
- `calendar <-> elapsed` from the same origin: convert through origin.
- `datetime <-> unrelated numeric`: skip sync instead of showing misleading markers.

Mixing traces with different time formats:

- Allow multiple calendar DateTime traces in one panel when they use absolute timestamps.
- Allow multiple elapsed traces in one panel because they share duration semantics.
- When mixing calendar and elapsed, require an explicit choice:
  - match by calendar timestamp
  - match by elapsed time from each file start
- When mixing DateTime and plain numeric simulation time, default to elapsed comparison only when the user chooses it.
- If no meaningful mapping exists, block the add/overlay with a clear message.

Compare across files:

- Add an overlay mode:
  - same timestamp
  - same elapsed time from file start
- Calendar/log workflows usually want same timestamp.
- Simulation/experiment workflows usually want same elapsed time.

CSV export:

- Calendar mode exports ISO DateTime.
- Elapsed mode exports numeric duration.
- Include useful time metadata in the header, for example `time [s since 2026-05-15T08:00:00Z]`.

Suggested implementation phases:

1. DateTime detection and metadata in `CsvParser`.
2. Internal calendar/elapsed conversion helpers in `PlotManager`.
3. Timeseries DateTime axes.
4. Calendar-aware crop/shift UI.
5. Measurement and synchronized hover formatting.
6. Phase `2D+t` DateTime axis support.
7. Mixed-time add/overlay rules.

1. Add a real build/dev toolchain
   - `package.json`
   - `vite`
   - `eslint`
   - `prettier`

2. Centralize state
   - file registry
   - UI preferences
   - active layout/panel state
   - derived variable definitions

3. Extract pure domain logic
   - formula parser/evaluator
   - transforms
   - downsampling
   - stats
   - trace-building helpers

4. Add automated tests
   - parsers
   - derived variables
   - transforms
   - downsampling
   - state animation math

5. Improve UX polish
   - notifications instead of `alert()`
   - keyboard shortcuts
   - persistent settings
   - better loading/error states

6. Improve maintainability further
   - per-feature folders
   - shared DOM helpers
   - constants/theme tokens
   - typed JSDoc or TypeScript migration
