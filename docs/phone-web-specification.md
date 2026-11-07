# Phone Web Specification

Status: first slice built (2026-10-04), extended since. It covers time series and
every analysis of the desktop — FFT, the histogram, the calendar heatmap, the
temporal profile, the integral, correlation and the 2D curve fit — 2D, 2D + t and
3D plots and state animations, the measurement cursors, plus CSV parsing.

Built:

- compact-mode activation, with the Automatic / Phone / Full override in More, and a
  **Mobile version** entry in the desktop ☰ menu to switch a large screen to it;
- the app bar, the bottom navigation and the landscape rail;
- sheets with Back integration;
- one plot at a time, with the plot list in the Plot sheet;
- the Data sheet, with tap-to-plot and the per-file page;
- the Plot sheet: view and signals, and the desktop's two panel menus as rows of
  it — **View** (last view, log axes, stack, Y2, line shape; 2D display, 1:1 and its
  log axes; a 3D scene's projection, camera presets and rotations) and **Marks**
  (NaN, gaps, repeated, samples), with the gaps settings opening their panel on the
  plot. Both are built from the same models the desktop dropdowns are drawn from, so
  a new item in either menu reaches the phone with no work;
- the Analyze sheet: time series, FFT, histogram, calendar heatmap, temporal profile,
  integral, correlation and the 2D curve fit, each analysis with its options lent to
  the sheet and its
  top-bar buttons (reset, V/H, hide the time series) as buttons there; the histogram's
  log counts, in the View menu on the desktop, is a button there too, and the
  heatmap's, correlation's and the fit's **Update** appear while appended data is
  waiting to be folded in. Correlation and the **curve fit** are the analyses of the
  2D family: they read the plot's pairs, keep them when turned on or off, and their
  "None" entry leaves the 2D plot rather than a time series. The fit is not a mode —
  a 2D plot opens it over itself — so the sheet reads the plot's own state to know it
  is on, takes a plot that is not 2D there first, and its pair, fit type (none,
  linear, quadratic, power), equation, coefficients and metrics are the drawer it
  lends;
- 2D (x–y), 2D + t (x–y along time) and 3D (x–y–z) plots: the plot type in the Plot
  sheet, x then y (then z) by tapping in Data, the curves listed with removal, the
  1:1 aspect in 2D, and the 3D scene's gestures (pan with a slow double tap) in
  2D + t as in 3D;
- 2D and 3D state animations: x₁, x₂ (x₃) by tapping in Data, a tap on one
  assigned takes it off; play, time slider, time and speed on the plot, what it
  draws as switches in the Plot sheet;
- derived variables (§5.7): **New variable** beside Open file in Data, and a
  row in Analyze; a page of its own with a formula field driven by its own keys,
  Variables / Functions / 123 tabs, live checking and a preview of the values,
  Σ Combine several, Create with "Plot n"; the tree's ✎ edits and × deletes;
- data tools (§5.8): a hub in Analyze with the ten tools as tiles in four
  families and the file's transformations as cards; a page per tool, at half
  height so the dotted preview is watched on the plot above it, with the signal
  chosen from a list, the side panel's controls at a finger's size (− and +
  that repeat, a segmented choice, every "?" a help page), and Create, Update
  and Delete; the tree's ✎ on a tool's output opens its page;
- the More sheet: layout, language, theme, examples and menu;
- the CSV parsing dialog of §5.6;
- on the plot: faint fit X / fit Y / fit both buttons in its corner, and the window
  zoom of §6.1 (a slow double tap);
- the measurement cursors (§6.4): A|B in the plot's corner and a switch in the Plot
  sheet; a tab at the foot of each line to drag it, waiting at the edge when the
  cursor is out of view; their reading in a Cursors sheet, with step arrows; Δx and
  Δy in the app bar while that sheet is hidden;
- help full screen, and the bottom bar's icons each in their own colour.

The code is in `src/app/methods/compact-methods.js`,
`src/app/methods/compact-analyses.js` (what each analysis is on a phone, §11),
`src/app/methods/compact-cursor-methods.js`,
`src/app/methods/compact-derived-methods.js` (derived variables, §5.7),
`src/app/methods/compact-tools-methods.js` (data tools, §5.8),
`src/ui/compact-layout.js`, `src/utils/cursor-handles.js` and
`src/styles/compact.css`. The tests are `npm run test:compact-layout`,
`npm run test:compact-derived`, `npm run test:compact-tools`,
`npm run test:cursor-handles`, `npm run e2e:compact-layout`,
`npm run e2e:compact-derived` and `npm run e2e:compact-tools`.

Not built yet:

- tap readouts beyond Plotly's own;
- export through Web Share;
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
the screen to decide layout. More offers **Layout: Automatic / Mobile / Full** so a
user can override in either direction, and the desktop ☰ menu offers **Mobile version**
to reach it from a large screen; the choice is remembered per device.

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
- **The way back, sideways.** The side sheet's Hide chevron sends it off the right
  edge, while the rail is on the left. A pill stays on that right edge while the
  sheet is hidden, pointing at it, and a tap brings the same sheet back. Upright the
  chevron points down at the bottom bar, which is the way back, and there is no pill.
- **One set of controls.** Whatever a sheet or a dialog lends from the desktop is
  drawn as the phone's own: rounded fields of one height and tint, one drawn chevron
  on every pick-list (never the browser's arrow or iOS's up-and-down one), dates and
  numbers in the app's typeface, one slider with a thumb a finger finds, one
  segmented control with the choice that is on filled with the accent, one round
  tinted "?" and drawn icons where the desktop shows emoji. The layer is the
  "One set of controls" section at the foot of `src/styles/compact.css`.
- **Tablets.** Upright, the sheet spans the screen but its content keeps a measure of
  about 680 px, centred; sideways it is a side sheet as on a phone.

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

An overlay legend starts hidden on the phone, behind a floating button of the same
size at its corner (top left by default, opposite the fit buttons); a tap opens it
below the button and a second tap closes it. An overlay legend never pushes the plot's
margins, however long its names: it lies on the plot instead of shrinking it. On a
desktop the same button minimizes and restores the legend, which starts shown unless
it is wider than 40 % of the plot; choosing any legend setting shows every legend again
(`src/ui/legend-toggle.js`).

### 5.3 Analyze

Analyze holds whatever produces new numbers.

- **Analysis workspaces**: FFT, histogram, heatmap, temporal profile, integral and
  correlation. On the phone:
  - the workspace's plot fills the plot area;
  - its options panel (`aside.fft-options`) becomes the content of the Analyze sheet;
  - in portrait, FFT's time and spectrum panes stack vertically.
  - each is chosen from a radio list led by its drawing, in the hand of the data
    tools' tiles (§5.8): grey, and in the accent colour once chosen, with the radio
    at the end of the row. "None" draws the plot that is left — a time series, or
    a 2D plot. The drawing is the entry's `icon` (`offIcon` for "None") in
    `compact-analyses.js`.
- **Data tools** (§5.8): outliers, derivative, integrate, moving average,
  interpolate, detrend, filter, resample, xcorr and collapse.
- **Derived variables** (§5.7), also reached from Data.
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

### 5.7 Derived variables

On the desktop a formula is written in a one-line box in the side panel, or in
the large editor driven with the mouse. Neither fits a phone: the box is in a
320 px column the Data sheet hides, the editor is a grid of small chips laid
out for a pointer, and a phone keyboard keeps every bracket and operator on
its second page. The phone has a page of its own, built like a calculator:

- **Reached from** **New variable** beside Open file in Data, the Derived
  variables row in Analyze (with how many the file has), and the ✎ of a formula
  row in the tree, which opens the same page on that variable (**Update**, and
  **Delete this variable** at its foot). The tree's × deletes, after asking.
  The page is pushed inside the sheet it was opened from, at full height:
  Back returns to that sheet.
- **Name**, then the **formula**. The formula field opens with
  `inputmode="none"`: it shows its cursor, and no system keyboard covers the
  page. A row of keys under it writes `+ − × ÷ ^ ( )`; the keys never take
  the focus, so the cursor stays where it was. **⌫** takes back what one tap
  wrote — a whole name, an operator with its spaces, an empty `name()` — and
  repeats when held. **⌨** hands the field to the system keyboard (and back);
  while typing, a strip of suggestions follows the name under the cursor.
- **Variables / Functions / 123** tabs below:
  - *Variables*: every variable of the file, with its description or formula,
    and a filter. A tap writes the name at the cursor; one tapped right after
    another is joined with `+`, so five taps write a sum. The ones the formula
    reads are marked. While editing, the variable itself and whatever is
    built on it are left out.
  - *Functions*: by group, each with its signature and what it does (there is
    no hover to say it), then the constants and the formula help. A function
    wraps the selection, or opens with the cursor inside; after an operand it
    multiplies.
  - *123*: digits, `.` `,`, π, e, a space, the cursor arrows, ⌫ and ✓.
- **Σ Combine several…** is a page: tick the variables (numbered in order),
  choose sum, mean, min or max, see the call, **Insert**.
- **Checked as it is written**: compiled and run against the file. An error is
  said under the field. A valid formula gets **Preview ↓** in that line, which
  brings up the preview at the foot of the page: a 150 px chart of the values
  (each column's low and high, as a plot of many samples draws them, with the
  top, the bottom and zero marked at its left edge), with their count, min,
  max and how many are not numbers.
- **The cursor** is read from what the user does in the field and from
  `selectionchange`, never from focus or blur: iOS moves the cursor to the
  start when a page focuses a field and does not announce it when the page
  puts it back. `e2e:compact-derived` emulates that.
- **Footer**, always in reach: ✕ (discard), **Plot n** (put it on the plot on
  screen at once; on by default and remembered; only where a tap in Data adds a
  signal), and **Create** — enabled once there is a name and a valid formula,
  and saying what is missing otherwise.
- After Create the page closes, the sheet returns to its height, a toast says
  what was created and where, and the new row is brought into view in the tree
  and lit for a moment. After an Update the plot on screen fits its Y to the
  new values.
- **Leaving without Create** (hiding the sheet, Back) keeps a draft for the
  next New variable; ✕ discards it. A refresh of the sheet underneath (a plot
  redrawn, the language changed) never throws the page away.
- One code path: the page fills the side panel's fields and presses its
  Create, so creating, editing, renaming and every check are the desktop's.

### 5.8 Data tools

On the desktop the tools are a column of the side panel: a dropdown of tools,
a dropdown of signals, a form that unfolds under them, three buttons and a
two-line table of what was made. On a phone that column is hidden in the Data
sheet, every dropdown and "?" is a small target, the help is a popover placed
for a mouse, and the dotted preview the panel draws is on a plot a full sheet
covers. The phone has pages of its own:

- **The hub**, reached from Analyze (**Data tools**, under New signals, saying
  how many transformations the file has, or which tool is waiting):
  - the tools as **tiles in four families**, each with its drawing, tinted by
    family, and one line of what it does (there is no hover to say it):
    *Clean* (remove outliers, fill NaN, collapse repeated timestamps),
    *Calculus* (derivative, integral), *Smooth and filter* (moving average,
    detrend, digital filter), *Resample and compare* (resample,
    cross-correlation). A tool a memory-saving file cannot run is a dimmed
    tile that says so;
  - the file's **transformations as cards**, in chain order: the result on
    the first line, where it came from and how on the second. The card is the
    edit; ✓/+ *Plot n* puts the result on the plot on screen or takes it off;
    🗑 asks on the card itself, with how many are built on it, and deletes the
    chain;
  - the panel's verdict (what was created, how many outliers, a caveat) above
    the cards, gone by itself as on the desktop;
  - a draft or an edit left waiting, first, with **Continue** and **Discard**.
- **A tool's page**, pushed over the hub:
  - it opens at **half height** when half the screen leaves room (≥ 700 px
    tall): the plot stays live above it, and that is where the result is seen.
    A shorter phone gets the whole height; its strip then offers **See the
    plot**, which halves the sheet;
  - **the signal** is a row that opens a list (searchable past eight entries,
    the ones on the plot on screen first, each with its points and unit). It
    starts on the first signal of the plot on screen the tool takes, so the
    preview is there from the first tap. Resample and Collapse start on *all
    variables*, as on the desktop;
  - **a strip** says what the plot shows: the result dotted, following the
    settings; the edited curve itself, live; that the settings are not complete
    yet; or, when the source is not on the plot, **Show it**, which puts it
    there and starts the preview. A tool whose result is a new dataset says
    where it will go instead;
  - **the settings are the side panel's own controls**, lent to the page and
    returned when it closes, at a finger's size: 46 px fields and native
    selects (the system picker), sliders with a 28 px thumb, numbers with − and
    + (44 px, repeating when held; only on a field with a step of its own, not
    on a typed cut-off or Δt), the keypad that suits the field (digits for a
    count, the decimal pad for a positive value, the full keyboard where a
    minus sign may be needed — iOS keypads have none), *Replace with NaN /
    Interpolate* as a segmented control, and every **?** a help page with Back
    (a "more" link inside one is a page too). The **?** beside the description
    lists every help topic of the tool;
  - **the name** of the result (or of the new dataset), with the panel's
    rename lock while editing, and the live-chain switch when others are built
    on it;
  - the **footer**, always in reach: ✕ (Clear, or Cancel for an edit — the
    live values are put back), **Plot n** (whether the result goes on the plot
    on screen; remembered; *Plot it* for a new dataset), and **Create** /
    **Update**, disabled with the reason written under it while the panel would
    refuse it;
  - while editing, **Delete** at the foot, asked in place.
- **Leaving.** Back from a page keeps a new draft (the hub offers it) and
  abandons an edit. Hiding the sheet keeps either, preview included, so the
  plot can be looked at full size; Analyze then wears a dot, and its row goes
  straight back to the page. A refresh of the sheet underneath, a language
  change, never throws the page away.
- **The tree's ✎** on a tool's output opens its page, editing.
- On a phone the preview is drawn on the plot on screen only: one plot is seen
  at a time, and a curve on another would be drawn for nobody.
- **One code path.** The page sets the panel's tool and signal through their
  own controls and presses its Create; computing, previewing, editing,
  renaming, chaining and every check are the desktop's. A tool added to the
  desktop's picker fails `npm run test:compact-tools` until
  `COMPACT_TOOL_GROUPS` places it (§11).

## 6. Touch

### 6.1 Ownership

- A touch that starts on the plot belongs to the plot until every finger lifts. One
  finger pans, two fingers pinch, a tap selects. This already exists in
  `src/ui/plot-touch-gestures.js` and `src/ui/plot-3d-gestures.js` and is reused as
  is.
- Window zoom, the box zoom a mouse draws: tap, then touch again within 0.7 s. If
  that second touch drags (or is held), the drag draws a horizontal window and the
  plot zooms to it. If it is a slow tap (0.3 s or more after the first), the plot
  says "drag across the plot…" and the next drag draws the window. A quick double
  tap stays Plotly's reset. Time series and FFT panes only.
- A touch that starts on a sheet's handle moves the sheet. Inside a sheet, vertical
  drag scrolls its content.
- **No edge-swipe gestures.** Android's gesture navigation and Safari both reserve
  the screen edges for Back. Every destination is a visible button.

### 6.2 No hover

Phones have no hover, so anything that depends on it needs a tap equivalent:

- hover readouts and hover sync become **tap to show the value at that point**;
- tooltips on icons become labels or long-press hints;
- cursors are moved by dragging a tab with a 44 px reach (§6.4).

### 6.3 Back behaves like Back

Opening a sheet or a sub-page adds a browser history entry. The system Back gesture
(Android) and the edge swipe (Safari) then close the top layer instead of leaving the
site. Back from the bare plot behaves normally.

### 6.4 Measurement cursors

The cursors are the desktop's A and B: the same state on the plot and the same
measurements. Only how they are reached and read changes.

- **On and off**: A|B among the plot's corner buttons (on the time pane, or on
  FFT's spectrum when its time pane is hidden), and a switch in the Plot sheet.
  Turning them on opens their sheet.
- **Moving one**: each line has a tab at its foot, 28 px drawn and 44 px to the
  touch, so a finger grabs the cursor and not the pan; the line itself still takes
  a finger within 18 px. Two tabs closer than a tab's width are not drawn on top of
  each other: B's goes one row up. A tab does not cover the dot that reads its
  curve: where the curve runs along the bottom (a spectrum's floor) the tab sits
  just above the dot.
- **Out of view**: a cursor past an edge leaves its tab at that edge (‹A, B›).
  Dragging it brings the cursor to the finger.
- **Both together**: a tab (or line) held still for 0.45 s, then dragged, moves A
  and B together, as Ctrl and drag does with a mouse.
- **The reading**: the desktop's floating box is not shown. Its values go to a
  Cursors sheet, which behaves like the others: half the screen under the plot when
  upright, beside it when sideways, the whole screen on request. From the top: in FFT
  a Time / Spectrum switch; the values; for each cursor its trace and ◀ ▶ arrows;
  what the arrows step to (sample, peak, trough, zero; sample by default, the fine
  adjustment a finger cannot make by dragging); the A–B line; Copy and Turn off. An
  arrow held down keeps stepping.
- **Small screens**: hidden, the sheet leaves Δx and Δy in the app bar, in the file
  name's place (in FFT, those of the view chosen in the sheet: Δf on the spectrum), with a finger that says a tap there opens it again (it taps twice
  as the sheet goes; under 420 px it takes the A B letters' place). The plot then has the whole screen and
  the measurement is still read.
- **FFT with its time pane hidden**: the time pane's cursors go with it; A|B moves
  to the spectrum, and a short notice says the cursors now read the spectrum, as the
  app bar then does. Shown again, the time pane is read again (unless Spectrum was
  chosen in the sheet). Hide time series, like every toggle in the Analyze sheet,
  is lit while it is on.
- Rotation keeps the cursors, like everything else (§7). A new analysis closes them,
  as on the desktop.

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

For an **analysis** the rule is enforced in code. Its placement is one entry in
`src/app/methods/compact-analyses.js`: the radio in the Analyze sheet, whether a tap
in Data gives it a signal or half a pair (and how either comes off again), the pane
it draws beside its time pane (and how that pane's axes are fitted, or that nothing
on it can be), what turning it off leaves, its reset, the rest of its top bar, and
the options panel it lends to the sheet. An analysis that is not a mode of its own —
one a plot opens over itself, as a 2D plot does its curve fit — says so in the same
entry: the plot mode it lives on, how it is recognised on a plot, and how it is
turned on and off. The phone asks the plot which analysis it carries, never the mode
alone. Nothing else in the compact layout names an analysis — the sets it reads are
derived from those entries — and `npm run test:compact-layout` fails when the desktop
Analysis menu offers an analysis that file does not describe.

A new item in the **View** or **Marks** menu needs nothing at all: the Plot sheet
builds its rows from the same models the desktop dropdowns are drawn from
(`_viewMenuModel` and `_marksMenuModel` in `src/plots/methods/marks-methods.js`), so
an item added there arrives on the phone as a switch, a segmented choice, a numeric
field or a button, by its kind. The CSS side is three
selectors: the analysis's top-bar groups, its options panel and its edge rail, hidden
in `src/styles/compact.css` so only its status stays on the plot (an analysis built
on the FFT shell, as correlation and the fit are, is covered by its selectors
already).

A new **data tool** needs one line: its family in `COMPACT_TOOL_GROUPS`
(`src/app/methods/compact-tools-methods.js`), plus its drawing and its
one-line description (`compactToolDesc_<tool>`) in the four languages. Its
settings are its block of the side panel (`.data-tool-controls[data-tool-kind]`),
lent to the phone's page as they are: number fields with a step get − and +, a
"?" with `aria-controls` becomes a help page, with no work. `npm run
test:compact-tools` fails when the desktop's picker offers a tool that table
does not place.

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
