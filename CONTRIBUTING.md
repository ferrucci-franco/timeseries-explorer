# Contributing

Contributions of every size are welcome: bug reports, questions, example files,
documentation fixes and code.

## Reporting problems

Open an issue at
<https://github.com/ferrucci-franco/timeseries-explorer/issues>. The app's
Feedback command (see [docs/feedback.md](docs/feedback.md)) prefills one for
you, with the app version and your browser, and can package screenshots and
files into a zip for you to attach.

A useful report says which edition you used (web, Full Desktop or portable),
what you did, what you expected and what happened instead. If a particular file
triggers the problem, attach it or a reduced version of it only if its contents
can be shared publicly; otherwise describe its format and size.

## Asking for help

Questions about how to do something are welcome as issues too; there is no
separate forum. Check the in-app Help first: it documents every feature and
the file formats in detail. If you prefer not to use GitHub, the Feedback
command also offers an email fallback.

## Proposing changes

1. For anything larger than a small fix, open an issue first to discuss the
   approach.
2. Fork the repository and create a branch from `main`.
3. Make the change, following the editing rules and checks below, and add or
   update tests in `scripts/test-*.mjs` when behaviour changes.
4. Run `npm run test:release` (and `npm run e2e` for plotting or UI changes).
5. Open a pull request describing what changed and why. CI runs the full test
   suite and a production build on every pull request.

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

## Automated tests

- `npm run test:release` runs the offline unit suite (every `test:*` script). It
  runs the code against hand-made stubs and needs no browser.
- `npm run e2e` drives the real app in Chromium through Playwright. It covers
  what the stubs cannot show: Plotly's own behaviour and a browser clock in a
  time zone other than UTC (the A|B cursors on a date axis, #176). Install the
  browser once with `npx playwright install chromium`.

CI runs both on every pull request and on every push to `main`.

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
