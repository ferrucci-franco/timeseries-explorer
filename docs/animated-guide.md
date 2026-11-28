# Animated guide

**Menu → Animated guide** (also a button on the welcome screen, beside Select File
and Examples, and one in the Help window) opens short demos
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
  (seeded, so every run shows the same curves — a motor shaft, a thermal loop,
  an oven, a leak test, a process line); the exceptions are the two
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
| `src/ui/guide-om-stage.js` | The stand-in for the simulation tool the "Load as new" demo shows (next section). |
| `src/ui/guide-file-dialog.js` | The stand-in Open dialog, and what keeps the browser's own picker out of a demo. |
| `src/ui/guide-om-result.js` | Three runs of `ExampleSimplePendulum`, written as OpenModelica result files in the browser. |
| `src/ui/guide-live-logger.js` | The stand-in data logger of the "Live Update" demo, and the file reads of the desktop edition it is followed through (below). |
| `src/app/demo-mode.js` | `?demo`: what the copy of the app inside the frame does differently. |
| `src/styles/guide.css` | The window's styles. |
| `scripts/gen-guide-pypsa-example.py` | Writes `public/examples/guide/island_grid.nc` (needs `pypsa`, `highspy`, `netcdf4`). |
| `scripts/fetch-era5-argentina-example.py` | Writes `public/examples/guide/era5_argentina.nc`, real ERA5 (`--only demo`). See `docs/era5-argentina-example.md`. |
| `scripts/test-guide-chapters.mjs` | Every chapter complete, every text in every language. No browser. |
| `scripts/test-guide-mat.mjs` | The generated result files, read back by the app's OpenModelica parser. No browser. |
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
- uses the desktop layout whatever the screen — except in the two demos played
  on a device, a phone and a tablet (next section);
- reads CSV with the in-memory parser, because the query engine keeps a database
  in the origin's private file system that the app around the frame is using.

The guide is not offered where it cannot run: on the phone layout (its window
and its demos are drawn for a large screen), inside its own frame, and on a
page opened from disk (`file://`), where a page may not script a frame.

## The demos on a phone and on a tablet

Two demos are played by a finger, in a frame the size of a device and drawn
with its outline: "The same app, on a phone" (`phone`, `device: 'phone'`), the
one demo that shows the phone layout, and "On a tablet: the full workspace"
(`tablet`, `device: 'tablet'`), the desktop layout under a finger. The phone
first; what differs for the tablet follows.

- **The frame.** `DEVICES` in `guide.js` gives the size (375 × 667 CSS pixels,
  a small iPhone: taller ones leave too little of the guide's height per
  pixel) and what is added to the frame's address:
  `?demo&layout=compact&touch=1&…`.
  `Guide.setDevice()` sets the frame's size for the chapter, and the same
  `layout()` that fits the desktop frame fits this one, so the phone is always
  whole inside the guide's window. `.guide-screen-phone` (guide.css) rounds
  the bezel.
- **The layout.** `layout=compact` is read in `src/app/demo-mode.js`
  (`DEMO_LAYOUT`) and nowhere else: `initCompactLayout` takes it as the layout
  choice of the frame instead of `full`, and the boot script of `index.html`,
  which decides the layout before the first paint, reads the same parameter.
  Without `demo` the parameter means nothing, and `?demo` alone is the desktop
  layout played with a mouse.
- **The finger.** The plots only listen to fingers where there is a touch
  screen (`isTouchCapable()`), and the guide runs on computers that have none,
  so that copy of the app is told it has one (`touch=1`, `DEMO_TOUCH` in
  `demo-mode.js`). The driver of
  such a chapter is in touch mode: `d.tap` and `d.drag` send what a finger
  sends — `pointerdown`/`touchstart`, `touchmove`, `touchend`/`pointerup`,
  and then, for a finger that did not travel on a page that did not prevent
  the touch, the `mousedown`/`mouseup`/`click` a browser adds — to the element
  the finger landed on. `d.pinch` puts two fingers down; `d.doubleTap` taps
  twice within a double tap's time. The touch events are plain events carrying
  `touches`, `targetTouches` and `changedTouches`, not `TouchEvent`s, which
  Firefox and Safari on a computer cannot construct. The pointer is drawn as a
  finger's dot, two of them during a pinch. Nothing hovers: `d.move` only
  moves the dot.
- **Nothing else changes.** Storage is untouched as in every demo, the data is
  generated in the browser, and every other chapter is played as before, with
  a mouse in the desktop frame.

**The tablet** is a frame of 1024 × 768 (a tablet on its side), opened as
`?demo&layout=auto&touch=1`. `layout=auto` forces nothing: the app's own rule
(`shouldUseCompactLayout` in `src/ui/compact-layout.js`, mirrored by the boot
script) decides from the frame's size, as it does for a real window — the
phone layout below 600 px of width or 500 px of height, the desktop layout
otherwise — so a tablet gets the desktop layout, and the demo throws if it
ever does not. `touch=1` is the same flag as the phone's. On the desktop
layout a finger puts a variable on a panel by pressing it until the app picks
it up (`src/ui/touch-drag.js`, 350 ms) and dragging: in touch mode `d.plot`
and `d.dragDrop` do that, waiting for the app's own chip to appear under the
finger instead of counting the hold. Buttons and menus take taps.

The gestures are the ones of `src/ui/plot-touch-gestures.js`: one finger pans,
two pinch (side by side: the time axis only), two quick taps fit. The window
zoom — tap, then touch again and drag — is `d.tap(point)` followed by
`d.drag(point, to, { pause: 320 })`.

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
expected duration in milliseconds, for the progress bar of the first run. `device: 'phone'`
or `'tablet'` plays the chapter on that device, with a finger (the section above).

### What a demo can do (`d`)

| Call | Does |
| --- | --- |
| `d.say(text)` | The caption under the screen. |
| `d.wait(ms)` | Wait (stops while paused). |
| `d.until(() => cond, ms)` | Wait for the app: a file parsed, a plot drawn. It **reports**, it does not raise: where the demo cannot go on without it (the ERA5 demo and its extracted point), throw, so `e2e:guide` fails instead of playing a caption that lies. |
| `d.cam(target, scale)` / `d.cam(null)` | Zoom on an element (or several: an array), or show the whole app. |
| `d.move(target)` / `d.tap(target)` | Move the pointer; click. A target is a selector, an element, `[x, y]`, or `{ el, ax, ay }` for a point of an element. |
| `d.drag(from, to)` | Press, move, release: a zoom box on a plot, a splitter, a cursor. `{ ctrl: true }` holds Ctrl from the press to the release (both measurement cursors move together). In a phone demo: one finger, which pans a plot. |
| `d.park()` | Take the pointer to the empty stretch of the top bar, so that nothing is lit up or labelled under it. |
| `d.doubleTap(target)` | Two taps in a row (a phone demo: fit the plot). |
| `d.pinch(target, from, to, { angle })` | Phone demos only: two fingers `from` pixels apart around the target, moved until they are `to` apart. |
| `d.plot(name, panelIndex)` | Drag a variable from the tree onto a panel. |
| `d.folder(label)` | Open or close a folder of the tree. |
| `d.select(names)` | Select variables of the tree: a click, then Ctrl+click on each, in order (X, Y, Z of a phase plot). |
| `d.plotType(key, panelIndex)` | Change what a panel draws: `'timeseries'`, `'dashboard'`, `'phase2d'`, `'phase2dt'`, `'phase3d'`, `'state-anim-2'`, `'state-anim-3'`, confirming when the change empties the panel. |
| `d.analysis(mode, panelIndex)` | Turn an analysis on: `'fft'`, `'histogram'`, `'heatmap'`, `'temporal-profile'`, `'integral'`, `'curve-fit'`, `'trend'`. |
| `d.choose(select, value)` | Pick in a drop-down list (a look-alike list is drawn, since a script cannot open the browser's own). |
| `d.slide(rangeInput, value)` | Drag a slider. |
| `d.type(input, text)` | Type in a field. `{ append: true }` goes on after what the field holds (a formula, after a name taken from the suggestions); `{ enter: false }` leaves Enter out. |
| `d.reveal(element)` | Scroll its panel so that it is in view. |
| `d.loadText(name, text)`, `d.loadPublic(path)`, `d.loadBundledResult(script, name)` | Open data, in `setup`. |
| `d.loadFile(name, bytes, { localPath })` | Open bytes as a file; with `localPath`, as the desktop edition opens a file it knows the path of (the Live Update demo). |
| `d.modalOk()` | Read the dialog on screen for a moment, then close it by its button. |
| `d.restage(bytes, name)` | Put new bytes behind the open file, so that Reload finds a changed file (next section). |
| `d.om()` | The stand-in for the simulation tool (next section). |
| `d.fileDialog()` | The stand-in Open dialog — and the browser's own picker made harmless. |
| `d.liveLogger(options)` | The stand-in data logger and its file (the section after next). |
| `d.$(sel)`, `d.$$(sel)`, `d.panel(i)`, `d.app` | The frame's document and app, for anything else. |

Helpers in `guide-chapters.js` turn what a plot draws into a place to point
at: `plotArea(gd, fx, fy)`, a fraction of a plot's drawing area;
`plotAt(gd, x, fy)`, a time on the x axis; and `mapPoint(gd, lon, lat)`, a
longitude and a latitude on the gridded map — which is how the ERA5 demo puts
its point on Buenos Aires and not on a corner. They read Plotly's own layout,
so they are called with the camera at rest.

`legendClick(d, plot, name)` clicks the entry of a curve in a plot's legend,
which hides it, and waits for the plot to do so.

For the analyses that work on a stretch of the signal (curve fit, trend,
integral), `dragRangeEdge(d, 'x1' | 'x2', time)` drags an edge of the green
stretch on the plot, `timePlot(d)` is the pane that keeps the signal, and
`computing(d)` is true while the analysis' computing pill is up — wait on it
(`d.until(() => !computing(d))`), never on a fixed time: the analyses run in a
worker.

`d.analysis()` is the only place that knows where the analyses are in a panel's
toolbar. When that part of the toolbar is redesigned, change it there and both
analysis demos follow. `d.plotType()` is the same for the plot types.

**End on a clean picture.** The last frame of a demo stays on screen for two
seconds before it loops. Park the pointer (`d.park()`) unless pointing at
something is the point, and look at that frame: the driver tells the page
when the pointer enters and leaves an element, as a mouse does, so a card or
a tooltip that is up at the end is one a person would see too.

**A demo plays in the viewer's time zone.** Put a calendar time on a plot only
through `plotAt` (which places the axis' own number); Plotly's `d2l` shifts a
number by the viewer's UTC offset, and a demo that used it dragged its cursors
off the plot everywhere but in UTC. Run a demo with a calendar axis under
another zone before trusting it (`TZ=America/Los_Angeles npm run e2e:guide`).

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

## The demo of a desktop-only feature

"Live Update: a file still being written" (`live-update`) shows a feature of
the Full Desktop edition: following a CSV while a logger is still appending
rows to it. The web version cannot do it — it has no path on disk to go back
to — and its button says so. The guide runs the web app in a frame, so the
demo is staged, the same honest way as the simulation tool above:

- **A stand-in logger** (`guide-live-logger.js`): a program of its own, in
  its own window — a title bar that says "Data logger — simulated", a REC
  light, its channels with their last values, "writing to line_3.csv" and a
  row counter that ticks. It is not drawn over the app: the chapter keeps a
  strip of the screen under the app (`below: 124` on the chapter; `guide.js`
  makes the app's frame that much shorter and draws the strip as a desktop),
  and the window stands there, in the guide's own page, outside the app's
  document. The demo's first caption is about it, with the camera on it
  (`d.cam(logger.area())`), before anything happens in the app. Its few words
  are given by the chapter, in the reader's language. The demo hands it the
  rows, four a second on the demo's own clock, so Pause stops the logger too.
  What it has written so far is the "file".
- **The thinnest desktop bridge**: Live Update reads a file through
  `omvDesktop.statFile` (its size and date) and `omvDesktop.readFileSlice`
  (the bytes between two offsets), which the desktop app's preload provides
  (`electron/preload.cjs`). The stand-in installs an `omvDesktop` with those
  two — answered from the logger's text — on the frame's window, and tells the
  frame's app it is the desktop edition, which is what enables the Live Update
  button there (and why the badge of the frame reads Full Desktop during this
  demo). It refuses to do so anywhere but in the guide's frame, and nothing in
  the app was changed for it: outside that frame Live Update is what it was.
- **Everything else is the app's own code**: the file is opened with the path
  it would have on a disk (`d.loadFile(…, { localPath })`), the demo presses
  the real Live Update button, and from there `_startLiveUpdate`, the poll
  every two seconds (`_pollLiveUpdate`), the probe of the appended bytes
  (`_readLiveUpdateAppendProbe`), the rows parsed and appended
  (`_applyLiveUpdateAppendProbe`), the time-series panel redrawn in place and
  the dashboard's cards and LIVE badge are what the desktop edition runs. No
  curve and no card is drawn by the demo. The same stand-in for the bridge is
  what `scripts/e2e-live-update.mjs` uses to test Live Update in a browser.

The demo waits for the rows to arrive (`d.until` on the number of rows the
app holds) and throws when they do not, so `npm run e2e:guide` fails if the
live path breaks.

## Opening one demo from elsewhere

```js
app.openGuide('fft');   // 'csv-parsing', 'time-dashboard', 'phase-plots', 'data-tools', 'derived-variables', 'fft', 'temporal-profile', 'curve-fit', 'trend', 'measure', 'modelica', 'load-as-new', 'pypsa', 'era5-maps', 'live-update', 'phone', 'tablet'
```

opens the guide on that demo. A "tip of the day", or a "show me" link next to a
feature, needs nothing more than this call.
