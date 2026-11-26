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
  (seeded, so every run shows the same curves); the one exception is a 175 KB
  PyPSA network under `public/examples/guide/`.

Until the guide has been opened once, a small dot on the menu button (and on the
entry) points at it; the only thing remembered is that it was opened
(`omv_guide_seen` in the browser's storage).

## Files

| File | What it is |
| --- | --- |
| `src/ui/guide.js` | The window (list, screen, camera, captions) and the driver of a demo (pointer, gestures). Knows nothing about any particular demo. |
| `src/ui/guide-chapters.js` | The demos, their texts in five languages, and their made-up data. |
| `src/ui/guide-om-stage.js` | The stand-in for the simulation tool the "Load as new" demo shows (next section). |
| `src/ui/guide-file-dialog.js` | The stand-in Open dialog, and what keeps the browser's own picker out of a demo. |
| `src/ui/guide-om-result.js` | Three runs of `ExampleSimplePendulum`, written as OpenModelica result files in the browser. |
| `src/app/demo-mode.js` | `?demo`: what the copy of the app inside the frame does differently. |
| `src/styles/guide.css` | The window's styles. |
| `scripts/gen-guide-pypsa-example.py` | Writes `public/examples/guide/island_grid.nc` (needs `pypsa`, `highspy`, `netcdf4`). |
| `scripts/test-guide-chapters.mjs` | Every chapter complete, every text in every language. No browser. |
| `scripts/test-guide-mat.mjs` | The generated result files, read back by the app's OpenModelica parser. No browser. |
| `scripts/e2e-guide.mjs` | Plays every demo in a real browser. |

## Demo mode

The frame loads `index.html?demo&lang=…&theme=…`, afresh for every run, so each
loop starts from a clean app. In that mode the app:

- reads and writes nothing in the browser's storage (settings, layout choice);
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
| `d.until(() => cond, ms)` | Wait for the app: a file parsed, a plot drawn. |
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
| `d.modalOk()` | Read the dialog on screen for a moment, then close it by its button. |
| `d.restage(bytes, name)` | Put new bytes behind the open file, so that Reload finds a changed file (next section). |
| `d.om()` | The stand-in for the simulation tool (next section). |
| `d.fileDialog()` | The stand-in Open dialog — and the browser's own picker made harmless. |
| `d.$(sel)`, `d.$$(sel)`, `d.panel(i)`, `d.app` | The frame's document and app, for anything else. |

`d.analysis()` is the only place that knows where the analyses are in a panel's
toolbar. When that part of the toolbar is redesigned, change it there and both
analysis demos follow. `d.plotType()` is the same for the plot types.

Prefer selectors that do not depend on the language: a class, a `data-` attribute,
the `value` of an option (`listWith(root, 'hann')`), never a label.

## The demo that shows the tool next door

"Modelica: compare runs of a simulation" (`load-as-new`) is about what happens between
two runs, and half of that happens in OpenModelica: a parameter is changed, the
model is simulated again — not compiled again — and the result file is
overwritten. Three pieces make that showable without installing anything and
without a recording:

- **A stand-in window** (`guide-om-stage.js`), drawn in HTML over the app
  inside the frame: the Libraries and Elements browsers, the text of the model,
  the Messages browser with its Compilation and Output tabs and its progress
  bar, and the Plotting perspective with the Variables browser, its parameters
  in editable boxes and the menu the right button opens on the result. It is a
  picture, not OpenModelica, and it says so in its own file. Its strings are
  that window's English ones and are **not** translated — the captions are what
  speaks the reader's language. It is dumb: the demo points at `stage.el.*`
  with the ordinary `d.tap`/`d.cam`, and calls `progress`, `line`, `value`,
  `menu` and `curve` to move it on, so Pause stops it like everything else.
- **Real result files** (`guide-om-result.js`): the pendulum of
  `public/examples/ExampleSimplePendulum.mo`, integrated here for three values
  of the damping `b` and written as OpenModelica MAT v4 — `Aclass` with
  `binTrans`, `dataInfo`, the parameters in `data_1`, the trajectories in
  `data_2`. `scripts/test-guide-mat.mjs` reads them back with the app's own
  parser, so a wrong matrix layout fails a test instead of quietly producing a
  tree of nonsense.
- **A stand-in Open dialog** (`guide-file-dialog.js`): the demo presses the
  app's **real** Open button, so the browser's own picker must not appear — a
  script cannot drive it and nothing could close it again. Asking for the stage
  takes `showOpenFilePicker` away from the frame and makes the hidden file
  input's `click()` do nothing; the drawn dialog then shows the working
  directory of the run, result file and build leftovers alike, and the file is
  opened the way a drop opens one. Without it the file appeared by itself,
  which is the one step a reader would have taken.
- **A staged reload** (`d.restage`): the demo presses the real 🔄 with the real
  **AS NEW** switch. For the app to find a changed file, the file entry is
  given a handle whose `getFile()` returns the next run's bytes — what a
  simulation that ran again would have left on disk. Everything after that is
  the app's own code: the hash differs, a new version is created, its notice
  appears, and **⧉** overlays the runs.

If the reload controls or the compare button move, this demo breaks like any
other, and `npm run e2e:guide` says so.

## Opening one demo from elsewhere

```js
app.openGuide('fft');   // 'csv-parsing', 'time-dashboard', 'phase-plots', 'fft', 'temporal-profile', 'modelica', 'load-as-new', 'pypsa'
```

opens the guide on that demo. A "tip of the day", or a "show me" link next to a
feature, needs nothing more than this call.
