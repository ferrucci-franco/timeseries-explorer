# Animated guide

**Menu → Animated guide** (also a button in the Help window) opens short demos
of features that are easy to miss. Each demo loops like an animated picture, but
it is not a recording: the real app runs in a frame and a script drives it with
the events a person would make.

That choice has three consequences worth knowing:

- A demo is always up to date with the app's look, language and theme — there is
  no GIF to record again after a restyle.
- A demo breaks when the control it clicks moves. `npm run e2e:guide` plays every
  demo to its end and fails on the first one that cannot find its target; run it
  after rearranging a toolbar or a dialog.
- Nothing is downloaded but the app itself. The data is generated in the browser
  (seeded, so every run shows the same curves); the exceptions are the two
  files under `public/examples/guide/`, fetched by the demo that needs them: a
  175 KB PyPSA network and 1.6 MB of real ERA5 over Argentina — a week of it,
  because the ERA5 demo ends on a temporal profile, and two days fold into a
  profile that shows nothing.

Until the guide has been opened once, a small dot on the menu button (and on the
entry) points at it; the only thing remembered is that it was opened
(`omv_guide_seen` in the browser's storage).

## Files

| File | What it is |
| --- | --- |
| `src/ui/guide.js` | The window (list, screen, camera, captions) and the driver of a demo (pointer, gestures). Knows nothing about any particular demo. |
| `src/ui/guide-chapters.js` | The demos, their texts in five languages, and their made-up data. |
| `src/app/demo-mode.js` | `?demo`: what the copy of the app inside the frame does differently. |
| `src/styles/guide.css` | The window's styles. |
| `scripts/gen-guide-pypsa-example.py` | Writes `public/examples/guide/island_grid.nc` (needs `pypsa`, `highspy`, `netcdf4`). |
| `scripts/fetch-era5-argentina-example.py` | Writes `public/examples/guide/era5_argentina.nc`, real ERA5 (`--only demo`). See `docs/era5-argentina-example.md`. |
| `scripts/test-guide-chapters.mjs` | Every chapter complete, every text in every language. No browser. |
| `scripts/e2e-guide.mjs` | Plays every demo in a real browser. |

## Demo mode

The frame loads `index.html?demo&lang=…&theme=…`, afresh for every run, so each
loop starts from a clean app. In that mode the app:

- reads and writes nothing in the browser's storage (settings, layout choice).
  The frame shares its origin with the app around it, so a write would be a
  trace left in that app's storage, and a read would make a demo depend on what
  the person did before. A per-viewer convenience — a collapsed section, a
  panel's height, a hint already seen — goes through `readLocal`, `writeLocal`
  and `removeLocal` of `src/app/demo-mode.js`, which do nothing in demo mode;
  `scripts/e2e-guide.mjs` compares the storage before and after every demo, and
  that is how the gridded view's own `localStorage` calls were caught;
- does not count a page view and shows no first-visit hint;
- uses the desktop layout whatever the screen;
- reads CSV with the in-memory parser, because the query engine keeps a database
  in the origin's private file system that the app around the frame is using.

The guide is not offered where it cannot run: on the phone layout (its demos show
the desktop layout), inside its own frame, and on a page opened from disk
(`file://`), where a page may not script a frame.

## Adding a demo

Add an entry to `GUIDE_CHAPTERS` in `src/ui/guide-chapters.js`:

```js
{
    id: 'histogram', g: 'analysis', icon: '▮', est: 25000,
    t: say('Histogram', 'Histogramme', 'Histograma', 'Istogramma', '直方图'),
    d: say('…one paragraph, shown under the screen…', '…', '…', '…', '…'),
    async setup(d) {                       // hidden behind "Loading…"
        await d.loadText('data.csv', makeCsv());
    },
    async run(d) {                         // what the person watches
        d.say(say('Drag a signal onto a panel', '…', '…', '…', '…'));
        await d.plot('load_kW');
        await d.analysis('histogram');
        await d.wait(2000);
    },
}
```

Rules of thumb: one idea per demo, 25–40 seconds, a caption of a few words per
step — the demo shows, the caption only names what is happening. `est` is the
expected duration in milliseconds, for the progress bar of the first run.

### What a demo can do (`d`)

| Call | Does |
| --- | --- |
| `d.say(text)` | The caption under the screen. |
| `d.wait(ms)` | Wait (stops while paused). |
| `d.until(() => cond, ms)` | Wait for the app: a file parsed, a plot drawn. It **reports**, it does not raise: where the demo cannot go on without it (the ERA5 demo and its extracted point), throw, so `e2e:guide` fails instead of playing a caption that lies. |
| `d.cam(target, scale)` / `d.cam(null)` | Zoom on an element (or several: an array), or show the whole app. |
| `d.move(target)` / `d.tap(target)` | Move the pointer; click. A target is a selector, an element, `[x, y]`, or `{ el, ax, ay }` for a point of an element. |
| `d.drag(from, to)` | Press, move, release: a zoom box on a plot, a splitter. |
| `d.plot(name, panelIndex)` | Drag a variable from the tree onto a panel. |
| `d.folder(label)` | Open or close a folder of the tree. |
| `d.select(names)` | Select variables of the tree: a click, then Ctrl+click on each, in order (X, Y, Z of a phase plot). |
| `d.plotType(key, panelIndex)` | Change what a panel draws: `'timeseries'`, `'dashboard'`, `'phase2d'`, `'phase2dt'`, `'phase3d'`, `'state-anim-2'`, `'state-anim-3'`, confirming when the change empties the panel. |
| `d.analysis(mode, panelIndex)` | Turn an analysis on: `'fft'`, `'histogram'`, `'heatmap'`, `'temporal-profile'`, `'integral'`. |
| `d.choose(select, value)` | Pick in a drop-down list (a look-alike list is drawn, since a script cannot open the browser's own). |
| `d.slide(rangeInput, value)` | Drag a slider. |
| `d.type(input, text)` | Type in a field. |
| `d.reveal(element)` | Scroll its panel so that it is in view. |
| `d.loadText(name, text)`, `d.loadPublic(path)`, `d.loadBundledResult(script, name)` | Open data, in `setup`. |
| `d.$(sel)`, `d.$$(sel)`, `d.panel(i)`, `d.app` | The frame's document and app, for anything else. |

Two helpers in `guide-chapters.js` turn what a plot draws into a place to point
at: `plotArea(gd, fx, fy)`, a fraction of a plot's drawing area, and
`mapPoint(gd, lon, lat)`, a longitude and a latitude on the gridded map — which
is how the ERA5 demo puts its point on Buenos Aires and not on a corner. Both
read Plotly's own layout, so they are called with the camera at rest.

`d.analysis()` is the only place that knows where the analyses are in a panel's
toolbar. When that part of the toolbar is redesigned, change it there and both
analysis demos follow. `d.plotType()` is the same for the plot types.

Prefer selectors that do not depend on the language: a class, a `data-` attribute,
the `value` of an option (`listWith(root, 'hann')`), never a label.

## Opening one demo from elsewhere

```js
app.openGuide('fft');   // 'csv-parsing', 'time-dashboard', 'phase-plots', 'fft', 'temporal-profile', 'modelica', 'pypsa'
```

opens the guide on that demo. A "tip of the day", or a "show me" link next to a
feature, needs nothing more than this call.
