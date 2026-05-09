# Architecture Notes

## Entry flow

1. `index.html` loads `app.js`.
2. `app.js` instantiates `OpenModelicaViewer` from `src/app/viewer-app.js`.
3. `OpenModelicaViewer` composes:
   - `MatParser`
   - `CsvParser`
   - `LayoutManager`
   - `PlotManager`
   - `i18n`

## Folder roles

### `src/app`

Owns top-level app orchestration and browser-facing workflows.

- `viewer-app.js`
  - main application class
  - shared state container for files, language, theme, and UI workflow
- `constants.js`
  - app-level constants and example definitions
- `methods/file-methods.js`
  - file load/reload/remove/transform logic
- `methods/ui-methods.js`
  - event listeners, examples, help, drag/drop, sidebar resize
- `methods/derived-methods.js`
  - derived-variable parser, evaluator, autocomplete
- `methods/tree-methods.js`
  - variable-tree rendering and selection behavior

### `src/plots`

Owns plot state and every Plotly-driven behavior.

- `plot-manager.js`
  - main plot state owner
  - plot lifecycle
  - public plot API used by the app
- `methods/data-methods.js`
  - transforms, downsampling, trace and layout builders
- `methods/state-methods.js`
  - state animation mode
- `methods/interaction-methods.js`
  - hover sync, cursors, 3D controls, toolbar actions

### `src/parsers`

Normalizes input files into a common structure:

- `variables`
- `metadata`
- `tree`

This lets the rest of the app treat MAT and CSV similarly.

### `src/ui`

Reusable UI building blocks outside the main app class.

- `layout-manager.js`
  - recursive split-panel workspace
- `modal.js`
  - custom modal dialogs

### `src/i18n`

- `index.js`
  - active language and DOM translation updates
- `translations.js`
  - all translation strings

### `src/styles`

Split CSS source by concern:

- `base.css`
- `sidebar.css`
- `content.css`
- `overlays.css`
- `index.css`

## Design intent

The structure is optimized for:

- smaller files with narrower responsibility
- easier human maintenance
- smaller context windows for coding agents
- safer refactors than the original monolithic files

## Editing guidance

- If the issue is about file loading, start in `src/app/methods/file-methods.js`.
- If it is about panel layout or split behavior, start in `src/ui/layout-manager.js`.
- If it is about traces, axes, cursors, hover, or Plotly behavior, start in `src/plots`.
- If it is about labels or translations, start in `src/i18n/translations.js`.
- If it is about tree rendering or sidebar variable selection, start in `src/app/methods/tree-methods.js`.
