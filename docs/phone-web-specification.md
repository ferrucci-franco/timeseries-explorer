# Phone Web Specification

Status: first slice built (2026-10-04). It covers time series and FFT, plus CSV
parsing.

Built:

- compact-mode activation, with the Automatic / Phone / Full override in More;
- the app bar, the bottom navigation and the landscape rail;
- sheets with Back integration;
- one plot at a time, with the plot list in the Plot sheet;
- the Data sheet, with tap-to-plot and the per-file page;
- the Plot sheet: view and signals;
- the Analyze sheet: time series and FFT, with the FFT options;
- the More sheet: layout, language, theme, examples and menu;
- the CSV parsing dialog of §5.6.

The code is in `src/app/methods/compact-methods.js`, `src/ui/compact-layout.js` and
`src/styles/compact.css`. The tests are `npm run test:compact-layout` and
`npm run e2e:compact-layout`.

Not built yet:

- the other analyses and plot modes;
- View and Marks;
- cursors and tap readouts;
- export through Web Share;
- derived variables and data tools on the phone;
- the web manifest and the service worker (§8);
- deferring Plotly;
- the phone file-size defaults (§9).

This document replaces `docs/portable-phone-app-specification.md` (deleted) and
supersedes `docs/mobile-mini-viewer-design.md`. The MINI document's scope, routing and
fallback decisions no longer apply; its "iOS traps found the hard way" section remains
valid and is referenced from §7.

## 1. Goal

The online version at www.unditas.com must work very well on a phone. Someone who
opens it on a phone should find the same product as on a large monitor — the same
files, the same plots, the same analysis — arranged for a small touch screen, not a
desktop page squeezed into one.

## 2. Settled decisions

These were decided on 2026-10-04 and frame everything below.

| Question | Decision |
|---|---|
| Native app (stores, Capacitor, intents) | **No.** Web only. |
| Scope on the phone | **Full viewer and analysis**, delivered in stages (§12). |
| Architecture | **Compact mode of the same app**, not a separate entry point. |
| Navigation | **Bottom navigation bar with sheets** (navigation rail in landscape). |
| Installable | **Yes, PWA with offline support.** |

Consequences:

- There is one application and one code path for data, plots and analysis. Compact
  mode changes only *where* controls live and *how* they are reached.
- Every new desktop feature must state where it lives in compact mode (§11).
- Things the web cannot do on phones are out of scope, without apology: iOS
  "Open with", default-handler registration, file watching (live update), and
  local-directory integrations of the desktop build.

## 3. Compact mode

### 3.1 Activation

Compact mode is chosen from viewport geometry, never from the user agent.

Proposed rule, to be validated with the matrix in §13:

```
compact  =  viewport width < 600 CSS px
         or viewport height < 500 CSS px
```

The second clause catches phones in landscape (e.g. 844 × 390), where the desktop
layout has width to spare but no height. Tablets (short edge ≥ 744 px) stay in the
desktop layout.

The state is a single class on the root element (`html.compact`) set by one module
that listens to viewport changes. CSS and JS read that class; no other code measures
the screen to decide layout. Settings offers **Layout: Automatic / Compact / Full** so
a user can override in either direction; the choice is remembered per device.

### 3.2 One mobile strategy

The current small-screen rules are replaced, not extended:

- `@media (max-width: 768px)` and `@media (max-width: 600px)` in
  `src/styles/overlays.css` (floating sidebar, stacked sidebar, scrolling top bar,
  single-column split panels, hidden modebar);
- the scattered narrow-screen rules for dialogs and workspaces in `base.css` and
  `content.css`, where compact mode supersedes them.

Their useful parts are absorbed into compact mode. Leaving two strategies active at
once is what made the previous attempts fragile.

### 3.3 Desktop is untouched

With compact mode off, the desktop layout, split panels, sidebar and toolbars behave
exactly as today. Switching modes (rotation of a tablet, Settings override) must not
lose state (§7).

## 4. Layout

### 4.1 Portrait

```
┌──────────────────────────┐
│ ☰ Plot 2 of 3 ▾   file ⋮ │  app bar (one line)
├──────────────────────────┤
│                          │
│                          │
│          PLOT            │  active plot, all remaining space
│                          │
│                          │
├──────────────────────────┤
│  Data   Plot   Analyze  More │  bottom navigation bar
└──────────────────────────┘
```

- **App bar.** It holds the active-plot selector (§4.4) and the file name, truncated.
  It also shows a loading or error indicator when one applies. Nothing else goes in it.
- **Plot.** It gets all space between the two bars.
- **Bottom navigation.** It has four destinations (§5), each with an icon and a short
  label. The labels must fit in EN/ES/FR/IT at 320 px width.

### 4.2 Landscape

The bottom bar would cost too much of the ~390 px of height. In landscape it becomes a
**navigation rail** on the left edge with the same four destinations. The app bar
shrinks or merges into the rail. Sheets become **side sheets** (§4.3) on the right.

### 4.3 Sheets

Each destination opens a sheet.

- **Portrait.** Sheets are bottom sheets with two resting heights:
  - *Half.* The plot stays visible and live above the sheet.
  - *Full.* The sheet covers the plot.
- **Landscape.** Sheets are side sheets of about `min(50%, 420px)`, with the plot
  visible beside them.
- **Half and side sheets push the plot instead of covering it.** The plot is resized
  to the remaining area once the sheet settles, never during the drag animation. This
  is what lets a user tick signals and watch the curve change.
- **One sheet at a time.** Opening a destination replaces the current sheet. A
  sheet, a popover and a dialog never stack.
- **Sub-pages.** Going deeper (e.g. Plot → Marks → Gaps) pushes a page inside the same
  sheet, with a title and a Back control. Going back restores the parent's scroll
  position.
- **Closing.** A sheet closes by tapping its destination again, by dragging the handle
  down, with the system Back gesture or button (§6.3), or with Escape.

### 4.4 One plot at a time

The desktop split tree is kept intact in state but is not drawn in compact mode. The
user sees one panel at a time and switches with the **plot selector** in the app bar,
a list of plots with a short summary of each. The selector also offers **New plot**
and **Remove plot**. Returning to the desktop layout shows the original split
geometry.

Horizontal swipe is **not** used to switch plots, because one-finger drag belongs to
the plot (§6).

### 4.5 Empty state

With no file loaded, the plot area shows:

- one primary action, **Open file**;
- **Try an example**;
- one line saying that files are processed on the device and never uploaded.

## 5. Where everything goes

### 5.1 Data

Data holds files and signals.

- **Open file**, and the list of loaded files with reload and remove.
- Sheet, dataset or MAT variable pickers, shown as full-sheet pages.
- The variable tree with filter, sort and expand/collapse.
- **Tap a variable to add it to or remove it from the active plot.** Drag-and-drop
  onto panels remains a desktop gesture.
- Time-axis inspector and the CSV parsing preview, as full-screen pages.

### 5.2 Plot

Plot holds everything the per-panel toolbar does today for the active plot. The
compact mode hides the panel toolbar.

- Plot mode: timeseries, phase 2D, phase 2D+t, phase 3D, state animation 2D/3D.
- Autoscale, and linked time axes.
- **View**: log, stack, Y2, line shape.
- **Marks**: NaN, gaps, repeated, samples.
- Legend position, cursors, compare files, audio strip, statistics (Σ).
- **Export** (§8.3).

Autoscale and the cursor toggle may also appear as a small floating button cluster
on the plot. That cluster must avoid axes, legend and data, and must stay at most two
buttons.

### 5.3 Analyze

Analyze holds whatever produces new numbers.

- **Analysis workspaces**: FFT, histogram, heatmap, temporal profile, integral and
  correlation. On the phone:
  - the workspace's plot fills the plot area;
  - its options panel (`aside.fft-options`) becomes the content of the Analyze sheet;
  - in portrait, FFT's time and spectrum panes stack vertically.
- **Data tools**: outliers, derivative, integrate, moving average, interpolate,
  detrend, filter, resample, xcorr and collapse.
- **Derived variables.**
- Phase-2D fit.

### 5.4 More

More holds everything app-level.

- Examples.
- Save view, save or load a session, and convert to Parquet.
- **Settings**, as a full sheet with topic sub-pages. It includes the layout override
  (§3.1) and the file limits (§9).
- Language, theme, help, feedback and version.
- **Install app** (§8.1) when the browser allows it.

Hidden in compact mode, because they are desktop-only or meaningless on a phone:

- live update;
- OpenModelica and Dymola directories;
- desktop zoom;
- wheel-zoom and hover-sync options;
- the "download desktop" dialog, which becomes a plain link in More.

### 5.5 Dialogs and menus

- Every `src/ui/modal.js` dialog, plus the settings, help, feedback, export and
  picker dialogs, is full-screen in compact mode.
- Anchored dropdowns are replaced by sheet sub-pages or by an action list inside the
  current sheet. This covers `_openPanelDropdown`, the axis menu and the top-bar
  menus.
- Inline help popovers (`?` buttons) open as a sub-page or an expandable block. They
  are never floating boxes positioned with fixed coordinates.

### 5.6 Per-file actions and the CSV parsing dialog

**Per-file actions.** On the desktop, each file row in the sidebar carries small icon
buttons:

- ▦ CSV parsing;
- ⛭ transform (time shift, gain, offset, crop);
- save;
- MAT arrays;
- remove.

In compact mode the row shows the file name, its badges and one **⋯** button. That
button opens a **file page** inside the Data sheet, listing every action that applies
to that file as a full-width touch target:

- Adjust parsing (CSV and text only);
- Transform;
- Time-axis inspector;
- Reload;
- Convert to Parquet;
- Save;
- Remove.

**The CSV parsing dialog** (`src/ui/csv-parsing-preview-dialog.js`) is reached from
four places:

- the file page;
- the large-CSV preflight ("Review / adjust structure…");
- Convert to Parquet, from the menu, for both text files and spreadsheets;
- the large-CSV conversion notice.

In compact mode it behaves the same from all four.

- **Full-screen layer**, not a sheet, because it is an Apply/Cancel workflow.
  - At the top: **✕** (cancel), the title, and **⋮** with *Reset auto* and
    *Re-detect*.
  - At the bottom: a sticky primary **Apply parsing** button.
- **Portrait: two tabs, Preview and Options.**
  - A **status strip** sits between the tabs and the content and is always visible.
    It shows valid time rows, the column count, or the reason Apply is blocked, so
    the effect of an option is seen without switching tabs.
  - In landscape, the preview and the options sit side by side.
- **Options are grouped in collapsible sections**, each with a one-line summary when
  collapsed:
  - **File**: delimiter, decimal separator, encoding, sample, and lines shown.
  - **Structure**: header row, units, first data row, and row filter.
  - **Time axis**: mode, columns, format or pattern, and date order.
  - **Columns**: a list with a checkbox, an editable name and an editable unit per
    column. It replaces the inputs placed in the grid header on the desktop.
- **Preview grid.**
  - The grid scrolls on both axes inside itself, with the row-number column and the
    header row sticky.
  - **Tapping a row** opens an action list: *Use as header row / units row / first
    data row*. It replaces the desktop's click-to-assign.
  - Long-pressing a cell shows its full text.
- **Help** (time-axis modes, the pattern reference, date order) opens as sub-pages
  with Back.
  - System Back closes the help first, then the dialog.
  - If edits have not been applied, closing the dialog asks for confirmation first.
- **Keyboard.**
  - The focused input stays visible above the on-screen keyboard.
  - Row numbers use `inputmode="numeric"`.
  - Choices use native `<select>`.

## 6. Touch

### 6.1 Ownership

- A touch that starts on the plot belongs to the plot until every finger lifts. One
  finger pans, two fingers pinch, a tap selects. This already exists in
  `src/ui/plot-touch-gestures.js` and `src/ui/plot-3d-gestures.js` and is reused as
  is.
- A touch that starts on a sheet's handle moves the sheet. Inside a sheet, vertical
  drag scrolls its content.
- **No edge-swipe gestures.** Android's gesture navigation and Safari both reserve
  the screen edges for Back. Every destination is a visible button.

### 6.2 No hover

Phones have no hover, so anything that depends on it needs a tap equivalent:

- hover readouts and hover sync become **tap to show the value at that point**;
- tooltips on icons become labels or long-press hints;
- cursors are placed by tap and moved by dragging a handle at least 44 px wide.

### 6.3 Back behaves like Back

Opening a sheet or a sub-page adds a browser history entry. The system Back gesture
(Android) and the edge swipe (Safari) then close the top layer instead of leaving the
site. Back from the bare plot behaves normally.

## 7. Viewport, orientation and lifecycle

- Portrait and landscape are equally supported. Nothing locks or requires an
  orientation.
- **Rotation keeps everything.** That includes loaded files, the active plot, axis
  ranges, cursors, the open sheet and its sub-page, and list scroll positions. The
  DOM is the same app, so rotation should only re-flow the layout and resize Plotly
  once. It must never reparse a file.
- Use the safe-area insets: add `viewport-fit=cover` to the viewport meta and size
  with `svh` and `dvh`.
- On iOS, measure with `visualViewport` and `screen` as described in the MINI
  document's "iOS traps". An on-screen keyboard may shrink the content but must not
  re-fit the whole app.
- iPhone Safari has no element fullscreen and no orientation lock. Neither is used.
- **Backgrounding.** If the browser discards the tab, the next visit restores
  preferences, the layout and the last plot configuration. It then asks for the files
  again: in-memory data cannot survive. It must say so plainly and must not show
  empty plots silently.

## 8. PWA

### 8.1 Installable

- Add a web manifest with name, icons (including maskable), `display: standalone`,
  theme colors, and `start_url` and `scope` set for www.unditas.com.
- **Android/Chromium** shows its own install prompt. More offers **Install app** when
  `beforeinstallprompt` is available.
- **iOS** has no install prompt. More shows a short "Share → Add to Home Screen"
  instruction. Standalone mode removes Safari's toolbars, which MINI measured at about
  29% more plot height in landscape.

### 8.2 Offline

A service worker makes the app open and work without network once installed.

- **Precache**:
  - the app shell, `index.html`, CSS and the main bundle (including Plotly);
  - the light parsers: CSV, MAT, Micro-Cap and pickle;
  - translations and icons.
- **Cache on first use**:
  - DuckDB (WASM and workers, plus the Parquet extension);
  - h5wasm for netCDF and HDF5;
  - xlsx;
  - the audio decoders.
  
  Once a format has been opened online, it opens offline afterwards.
- Settings offers **Make all formats available offline**, which downloads everything
  in the second group.
- **Never cache user files or anything derived from them.**
- **Updates.** A new deployment is detected and the app shows **New version
  available — Reload**. It never silently mixes old and new chunks. Old caches are
  deleted after activation.
- The service worker is web-only. It is not registered in the Electron build.
- Analytics requests fail silently offline and are not queued.

### 8.3 Receiving and sending files

- **Share to the app (Android).** The manifest declares a `share_target` for the
  supported file types. Sharing a CSV from Gmail, WhatsApp, Drive or Files opens the
  installed app with that file loaded. The service worker hands the file to the page
  without storing it beyond that hand-off.
- **File handling (desktop Chromium).** `file_handlers` in the manifest comes almost
  for free and lets an installed desktop PWA open files from the OS.
- **Export.** Exports use the Web Share API (`navigator.share` with files) when it is
  available, so a PNG or CSV can go straight to a chat or to Drive. Otherwise they
  fall back to a normal download.
- A file arriving while files are already loaded joins the session. It never replaces
  what is there silently.

## 9. Memory and file limits

Phones have far less memory than the laptops the current limits were tuned for, and
iOS kills a tab without warning when it runs out.

- In compact mode, the default limits drop to **phone defaults**. These are a
  starting point, to be validated on real devices (§13):

  | Format | Web today | Phone proposal |
  |---|---|---|
  | CSV | 300 MB | 100 MB |
  | Parquet | 100 MB | 50 MB |
  | MATLAB | 250 MB | 80 MB |
  | Excel | 50 MB | 20 MB |
  | Pickle | 80 MB | 30 MB |
  | NetCDF | 250 MB | 80 MB |
  | Decoded audio | 400 MB | 100 MB |

- Where `navigator.deviceMemory` exists (Chromium), it may raise or lower these
  defaults. iOS does not expose it, so the table applies there.
- The existing over-limit dialog and the DuckDB deferred mode are reused. A file above
  the limit is announced **before** the load, with a choice: cancel, try anyway, or
  use the memory-saving mode where the format supports it.
- A user's explicit limit in Settings always wins over the defaults.

## 10. Performance and accessibility

### 10.1 Performance

- **First screen fast.** On a mid-range phone over 4G, the empty state with **Open
  file** must be usable before Plotly finishes loading. Plotly is currently a static
  import of about 1.4 MB gzip. Deferring it until the first plot is a goal of the
  shell phase. The service worker makes repeat visits instant.
- **Tap feedback** appears within 100 ms.
- **Sheet animations** never trigger Plotly redraws. Resize happens once, when the
  sheet settles.
- **Rotation** never reparses a file.

### 10.2 Accessibility

- Touch targets are at least 44 × 44 CSS px.
- Contrast meets WCAG AA in both themes.
- Opening a sheet moves focus into it, and closing returns focus to its opener. The
  covered plot is hidden from screen readers while a full sheet is open.
- Text scaling to 200% must not hide essential actions.
- With reduced motion, sheets appear without slide animation.

## 11. Rule for future features

Every new control, menu, dialog or workspace must state its compact placement in its
design document or PR:

- the destination (Data, Plot, Analyze or More), or "desktop-only, hidden";
- what replaces any hover, drag-and-drop or anchored-popover behavior.

This rule is what keeps "compact mode of the same app" from decaying into a second,
neglected UI.

## 12. Delivery

Each phase leaves the core journey (open → select → view) working on a phone.

1. **Shell.**
   - Compact-mode activation and override.
   - App bar, bottom bar and rail, the sheet component with history integration, and
     one plot at a time with the selector.
   - Removal of the old small-screen media queries.
   - Data sheet with tap-to-plot.
   - Full-screen dialogs.
   - Manifest only, so the app is installable and runs standalone on iOS.
   - Plotly deferred.
2. **Plot.**
   - The Plot sheet: mode, view, marks, legend, statistics and compare.
   - Touch cursors and tap readouts.
   - Export through Web Share.
3. **Analyze.**
   - The analysis workspaces with their options in the sheet.
   - Data tools, derived variables, phase-2D fit, 3D and state animation.
4. **Offline.**
   - Service worker, precache and on-first-use caching.
   - The update prompt and the "all formats offline" option.
   - The Android share target.
5. **Hardening.**
   - Phone limits validated on devices.
   - The real-device matrix.
   - Performance and accessibility passes.

## 13. Acceptance

### 13.1 Viewport matrix

Test these viewports in light and dark themes and in all four languages:

| Portrait | Landscape |
|---|---|
| 320 × 568 | 568 × 320 |
| 360 × 800 | 800 × 360 |
| 390 × 844 | 844 × 390 |
| 412 × 915 | 915 × 412 |

For every size:

- no horizontal page scroll;
- no two layers overlap;
- every essential action is reachable;
- with no sheet open, the plot fills the space between the bars;
- rotation in both directions keeps the state listed in §7;
- 768 × 1024 and 1024 × 768 still get the desktop layout.

### 13.2 Automated checks

Playwright with mobile emulation runs the matrix in CI. It checks overflow, layer
overlap and the open → select → view → rotate journey, using the existing test
fixtures.

### 13.3 Real devices

Use at least one recent iPhone (Safari, browser and standalone) and one mid-range
Android phone (Chrome, browser and installed). Emulation does not reproduce Safari's
toolbars, page zoom, memory kills, share targets or system Back gestures.

### 13.4 Offline and privacy

- With the network off after install, CSV, MAT, Parquet, Excel, netCDF and audio
  fixtures open, for formats that were cached as described in §8.2.
- No request ever contains file contents, file names or derived values.
- Removing a file releases its memory.

## 14. Open questions

- **Breakpoints.** Are the numbers in §3.1 right? Tablets should be measured in
  Firefox responsive mode and on a real iPad.
- **Phone limits.** Validate the §9 numbers by loading growing files on an older
  iPhone until it fails, then keep a margin.
- **Offline scope.** Is "cache on first use" plus the optional "all formats" button
  enough, or should DuckDB be precached despite its size?
- **Plot selector.** Is a list in the app bar enough when a session has many plots,
  or should there be thumbnails?
- **Labels.** Short destination names in the four languages, checked at 320 px.
