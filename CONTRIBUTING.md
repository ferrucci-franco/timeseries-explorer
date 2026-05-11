# Contributing

## Local run

Start the local server:

```powershell
.\serve.bat
```

Open the URL shown in the terminal.

Alternative Vite workflow:

```powershell
npm install
npm run dev
```

## Where to change things

### File loading, reload, transforms

Start in:

- `src/app/methods/file-methods.js`

### Top bar, examples, help, drag-and-drop, sidebar resize

Start in:

- `src/app/methods/ui-methods.js`

### Derived variables and formula autocomplete

Start in:

- `src/app/methods/derived-methods.js`

### Variable tree, selection, sidebar tree rendering

Start in:

- `src/app/methods/tree-methods.js`

### Plot logic, Plotly behavior, cursors, hover, 3D controls

Start in:

- `src/plots/plot-manager.js`
- `src/plots/methods/data-methods.js`
- `src/plots/methods/state-methods.js`
- `src/plots/methods/interaction-methods.js`

### Layout split panels

Start in:

- `src/ui/layout-manager.js`

### Modal dialogs

Start in:

- `src/ui/modal.js`

### Parsing `.mat` and `.csv`

Start in:

- `src/parsers/mat-parser.js`
- `src/parsers/csv-parser.js`

### Translations

Start in:

- `src/i18n/translations.js`

### Styling

Start in:

- `src/styles/base.css`
- `src/styles/sidebar.css`
- `src/styles/content.css`
- `src/styles/overlays.css`

## Editing rules for this repo

- Prefer small, localized changes.
- Keep logic in `src/`; avoid growing `app.js`.
- Treat `app.js` as the browser entrypoint only.
- Keep translation keys centralized in `src/i18n/translations.js`.
- If a file starts getting too large, split by responsibility rather than by arbitrary line count.

## Sanity checks after changes

At minimum:

1. Run `.\serve.bat`
2. Open the app in the browser
3. Check browser console for errors
4. Smoke test the affected feature

Recommended smoke tests:

1. Load a `.mat` or `.csv` file
2. Drag variables to a panel
3. Change plot mode
4. Toggle theme and language
5. Open help or example menu if the change touched UI behavior

## Build check

Before publishing:

```powershell
npm run build
```

This generates the portable download artifacts first and then the final published `dist/` output. Use `npm run build:web` only when you explicitly want a web-only build without refreshing the stand-alone package.

## Related docs

- `README.md`
- `docs/architecture.md`
- `docs/pro-roadmap.md`
