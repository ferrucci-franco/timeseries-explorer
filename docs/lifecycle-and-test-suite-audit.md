# Silent lifecycle and release-test audit

Date: 2026-07-31
Audited base: `origin/main` at `3a63ace` (`v0.2.0`)
Audit branch: `codex/lifecycle-audit`

## Executive summary

The audit confirmed two silent lifecycle leaks:

1. Every layout render abandons one toolbar `ResizeObserver` and one toolbar
   `MutationObserver` per panel.
2. Every remounted cursor information box abandons one document
   `mousemove`/`mouseup` listener pair, including after the panel is closed.

Neither finding produced an exception, an application error, or a console
error. Neither produced a direct visible symptom during reproduction; both
were observable only through lifecycle instrumentation.

A third ordering hazard was exposed by artificially delaying Plotly completion
promises: histogram setup can install an observer on a panel that was remounted
while the promise was pending. It is not a confirmed finding for the target bug
class because ordinary scheduling did not reproduce it and the forced run did
emit Plotly errors.

All 94 release scripts passed with both confirmed leaks present. The most
relevant test, `test:panel-detach-on-render`, also passed independently. It
checks an isolated callback sequence and a whitelist of source patterns, not
real observer/listener ownership across browser remounts and closes.

This report contains no application-code changes.

## Scope and method

The diffs of PRs #35 and #36 were read first and treated as the lifecycle
specification. The review then followed every identified DOM discard or rebuild
route through stored DOM references, observers, document listeners, timers,
animation-frame handles, cancellation tokens, and one-time setup guards.

Runtime verification used the Vite application on a pinned local port, built-in
example projects, and temporary instrumentation that wrapped document listener
registration and observer construction. The instrumentation was removed after
the observations were captured.

### Trigger/state matrix

| Trigger | DOM effect | DOM-bound state reviewed | Result |
|---|---|---|---|
| Language change | Full `LayoutManager.render()` wipe/remount | Plot divs, analysis divs, plot observers, cursor listeners, toolbar observers, handler guards | Plot-owned state was released; toolbar observers leaked. Cursor-box listeners leaked when their boxes existed. |
| Panel split | Full layout wipe/remount | Same as language change | Same toolbar exposure; PlotManager observers did not remain on detached panels in the ordinary run. |
| Panel close | Unmount plus layout render | Plotly divs, plot observers, keyed cursor listeners, cursor-box listeners | Stored PlotManager families were released; cursor-box document listeners survived close. |
| Layout reset/session layout restore | Full layout wipe/remount | Same layout-owned and plot-owned state | Reaches the same detach path; inherits the toolbar-observer finding. |
| Mode switch | `_destroyChart` followed by rebuild | Mode div/container references, handlers, observers, timers and analysis tokens | Reviewed teardown path was reached before rebuild. |
| Theme change | Plotly relayout, no layout DOM replacement | Live plot divs and observer/listener counts | Clean in runtime verification; counts and graph population were unchanged. |
| Live-update refresh | `updateFileData` and affected-panel rebuild | File-backed queries, plot state, chart teardown | Static path reaches `_rebuildPanel`, which destroys first. Light Web cannot exercise Desktop live update. |
| Data-tool apply | `updateFileData` or explicit panel rebuild | Derived data, cached plot state and chart DOM | Static path reaches teardown-first rebuild. |
| File reload/reparse | `updateFileData` and panel rebuild | File data, lazy source, plot DOM and queries | Static path reaches teardown-first rebuild. |
| Window resize | No DOM discard | Existing plot and toolbar resize observers | No lifecycle mismatch found. |
| Sidebar resize | No chart DOM discard | Existing chart observers and relayout path | No lifecycle mismatch found. |

### State families reviewed

- Panel-state element references: `div`, analysis `*Div`, `*Container`, and
  related mode-specific elements.
- Plot and toolbar `ResizeObserver`s and toolbar `MutationObserver`s.
- Document listeners for cursors, analysis selections, splitters, panning,
  state animation, phase-fit shells, and cursor boxes.
- Debounce timers, loading timers, analysis scheduling handles, animation
  frames, worker/query cancellation tokens, and render tokens.
- Boolean and identity guards with names such as `*Bound`, `*Installed`,
  `*Ready`, and handler-div keys.
- Promise continuations following `Plotly.newPlot`, detail loading, lazy
  queries, and analysis recomputation.

## Confirmed findings

### 1. Layout render leaks every discarded toolbar's observers

Severity ranking: highest of the confirmed findings because it requires no
optional feature; every layout render with panels creates more retained state.

Invariant violated: every observer registered during setup must have a release
path reached before its target DOM is discarded.

Code path:

- [`LayoutManager.render()`](../src/ui/layout-manager.js#L34) announces plot
  detach and then clears the layout container with `innerHTML = ''`.
- [`_bindToolbarScroll`](../src/ui/layout-manager.js#L449) creates a
  `ResizeObserver` and `MutationObserver`, observes the toolbar, and stores them
  only on that toolbar node.
- PlotManager's detach hook cannot release state owned only by the discarded
  toolbar node.

Exact reproduction:

1. Load the built-in Simple Pendulum project, which creates four panels.
2. Change language EN -> FR -> ES -> IT -> EN.
3. After each settled render, count observer targets and test each target's
   `isConnected` value.

Observed:

| Point | Detached resize targets | Detached mutation targets |
|---|---:|---:|
| After project load | 1 | 1 |
| After FR | 5 | 5 |
| After ES | 9 | 9 |
| After IT | 13 | 13 |
| After EN | 17 | 17 |

Each four-panel render added exactly four detached targets of each observer
type. No application error or console error was emitted.

Smallest fix: before the layout container is cleared, enumerate the current
`.layout-panel-toolbar` elements and disconnect their
`_scrollResizeObserver` and `_scrollMutationObserver` instances.

Would a user notice? No direct symptom appeared. Only instrumentation exposed
the retained observers. No secondary memory or responsiveness effect was
measured, so none is claimed here.

### 2. Cursor information-box remounts leak document listener pairs

Invariant violated: every document-level listener must be retained for removal,
and every remount and teardown route must reach that removal.

Code path:

- [`_ensureCursorBoxDrag`](../src/plots/methods/interaction-methods.js#L3856)
  marks the current box with `box._dragBound`.
- It then registers anonymous permanent `document.mousemove` and
  `document.mouseup` handlers.
- The handlers are not stored on panel state and `_destroyChart` cannot remove
  them. The node-local latch disappears with the old box, so the replacement
  box registers another pair.

Exact reproduction:

1. Load Simple Pendulum.
2. Enable A|B measurement cursors in a time-series panel so its cursor
   information box is created.
3. Change language to FR, then ES, remounting the box twice.
4. Close the cursor-enabled panel.

Observed document listener counts:

| Point | `mousemove` | `mouseup` |
|---|---:|---:|
| Before opening the box | 3 | 3 |
| First cursor box | 4 | 4 |
| After FR remount | 5 | 5 |
| After ES remount | 6 | 6 |
| After panel close; zero cursor boxes remain | 5 | 5 |

The remaining live paths accounted for two pairs: the global layout path and
the remaining cursor view. Three pairs created by the discarded boxes remained
registered. No application error or console error was emitted.

Smallest robust fix: give each view's cursor-box listener pair a key on `plot`,
release the previous pair when a replacement box binds, and sweep that key
family from `_destroyChart`. Installing only during a drag is insufficient by
itself because a panel can disappear while a drag is active.

Would a user notice? No direct symptom appeared. The abandoned handlers remain
idle because their closed-over `drag` state is null.

## Unconfirmed suspicions

### Dual-pane Plotly continuations can resume into a remounted panel

Several initial-chart continuations do not consistently validate their
captured panel and graph divs before installing handlers or assigning
`plot.resizeObserver`. Histogram is the clearest example in
[`histogram-methods.js`](../src/plots/methods/histogram-methods.js#L235).
Calendar heatmap already performs an identity check at line 524.

What was tried:

- Ordinary scheduling: switched language 30 ms into the analysis-heavy Noisy
  Chirp project load. Both graphs remained, the detached panel-observer count
  stayed at zero, and no errors were logged.
- Adversarial scheduling: temporarily delayed Plotly completion promises by
  600 ms, switched a panel to Histogram, and changed language after 80 ms. One
  observer was attached to the discarded panel and remained after that panel
  was closed.

Why this is not confirmed for the requested class: the ordinary run was clean,
and the forced run emitted two Plotly errors saying that resize must receive a
displayed plot div. The forced schedule therefore exposed a real ordering
hazard but not a silent failure under normal reproduction.

If reproduced naturally, the smallest fix is an early continuation guard that
checks the current plot object, expected mode, captured div identities, and
`panelEl.isConnected` before any listener, observer, or state installation.
Histogram, temporal profile, integral, and correlation should use the same
rule.

## Release-test audit

### Result

`npm run test:release` completed successfully in an uninterrupted 164.1-second
run:

> All 94 release tests passed.

Both confirmed lifecycle leaks were present during that run. The targeted
`npm run test:panel-detach-on-render` and
`npm run test:crlf-assumptions` commands also passed independently.

Classification totals:

- 10 source/configuration-shape tests.
- 42 mixed tests with executable behavior plus source-pinned subclaims.
- 40 tests with substantial behavioral force for their primary claim.
- 2 repository meta-tests.

Together these account for all 94 release scripts.

### Source/configuration-shape tests

These can pass while the corresponding UI behavior is broken if the expected
source text remains.

| Test | What it actually pins |
|---|---|
| `test:data-tool-panel-layout` | Cross-file IDs, selectors, classes, CSS declarations, source event names, and counts. |
| `test:desktop-download` | Manifest and translations plus dialog/CSS source tokens. It does not operate the dialog. |
| `test:desktop-release` | Package, manifest, workflow, builder, asset-name, and release-note configuration text. |
| `test:feedback-form` | A sliced source-method body, translation counts, and CSS declarations. It does not interact with a form. |
| `test:help-layout` | Help text/counts, source ARIA tokens, CSS, and repository metadata. It does not open or navigate Help. |
| `test:loading-overlay-layout` | Two CSS declarations extracted from one rule. |
| `test:parquet-converter-menu` | Menu wiring strings and bounded source windows. It does not operate the menu. |
| `test:settings-layout` | Source control IDs, ARIA tokens, translations, and CSS. It does not open Settings. |
| `test:sidebar-resize` | Three regexes against a sliced method body. It does not drag the sidebar. |
| `test:spreadsheet-parquet` | Mostly bounded source windows, token ordering, translations, and wiring. `test:parquet-conversion-sql` separately covers conversion-core behavior. |

### Mixed tests

These execute useful kernels, helpers, fixtures, or VM-isolated method
fragments, but their wiring or UI subclaims remain source-text assertions. A
kernel regression normally fails them; a browser-integration regression can
leave them green.

Plot and analysis group:

- `test:analysis-measured-range`
- `test:analysis-selection`
- `test:autoscale-axis`
- `test:calendar-axis`
- `test:calendar-heatmap`
- `test:correlation`
- `test:fft`
- `test:fft-refused-settings`
- `test:fft-time-format`
- `test:histogram`
- `test:integral-analysis`
- `test:large-analysis`
- `test:lazy-phase`
- `test:missing-data`
- `test:missing-lazy`
- `test:mode-toolbar`
- `test:panel-detach-on-render`
- `test:regression`
- `test:state-animation`
- `test:temporal-profile`
- `test:time-axis-variables`

Loading, desktop, and integration group:

- `test:audio`
- `test:crash-reporting`
- `test:csv-elapsed`
- `test:csv-export`
- `test:data-tools-sampling`
- `test:desktop-paths`
- `test:desktop-zoom`
- `test:duckdb-lifecycle`
- `test:electron-navigation`
- `test:file-size-limits`
- `test:in-memory-file`
- `test:large-files-help`
- `test:live-update`
- `test:load-error-messages`
- `test:matlab`
- `test:modelica-units`
- `test:netcdf`
- `test:pypsa`
- `test:session-project`
- `test:text-file-formats`
- `test:variable-sign`

`test:panel-detach-on-render` is the most relevant mixed example. It executes
an isolated `render()` body and proves the detach callbacks precede the wipe,
but teardown coverage is a whitelist of source patterns. It never mounts real
panels, counts observers/listeners, or closes a remounted panel. It therefore
passed with both confirmed leaks.

### Tests with substantial behavioral force

These exercise real imports, fixtures, workers, HTTP behavior, generated SQL,
or extracted method execution for their primary claim:

- `test:capabilities`
- `test:compute-kernels`
- `test:correlation-lazy`
- `test:csv`
- `test:csv-to-parquet`
- `test:cursor-y2`
- `test:data-tools`
- `test:definite-integral`
- `test:desktop-streamable`
- `test:detrend-filter`
- `test:eager-detail-remount`
- `test:excel`
- `test:export-dialog`
- `test:expr-compiler`
- `test:file-transform`
- `test:i18n-consistency`
- `test:interpolate-regrid`
- `test:local-file-http`
- `test:native-autoscale-loading`
- `test:operation-capabilities`
- `test:panel-time-axis`
- `test:parquet-conversion-sql`
- `test:parquet-loading`
- `test:parquet-pandas`
- `test:parse-worker`
- `test:phase2d`
- `test:pickle`
- `test:pypsa-session`
- `test:regression-conditioning`
- `test:regression-lazy`
- `test:resample-kernel`
- `test:sampling-gaps`
- `test:session-state`
- `test:temporal-profile-lazy`
- `test:time-axis-fixtures`
- `test:time-axis-model`
- `test:time-axis-readers`
- `test:time-axis-transform`
- `test:timeseries-stack`
- `test:timeseries-y-expand`

This classification does not imply complete browser wiring coverage. For
example, `test:eager-detail-remount` behaviorally executes the relevant
extracted block but does not render the full application.

### Repository meta-tests

- `test:source-encoding` checks source decoding/NUL assumptions, not
  application behavior.
- `test:crlf-assumptions` scans 58 file-reading test scripts for fragile
  newline assumptions. Its normalization exemption is script-wide: the
  presence of any `.replace(/\r\n/g, '\n')` exempts every read in that script.
  A later unnormalised read in an already-exempt script would not be inspected.

### Tests that can report green without exercising their subject

No wholly unconditional always-passing script like the historical CRLF slice
failure was confirmed. The following conditional green paths remain:

- `test:pickle`, `test:pypsa`, and `test:pypsa-session` call
  `process.exit(0)` when fixtures are absent outside CI. They throw in CI, but a
  developer release run can report green without their subject executing.
- `test:parse-worker` skips individual missing fixtures. Its hard-coded
  transfer and error cases prevent the entire script from becoming a no-op
  when the committed base fixtures exist.
- `test:csv` deliberately skips the git-ignored
  `bench/data/datacenters_load_2030.csv`; that skip occurred in the release
  run.

Unchecked `indexOf` slices were reviewed. Their positive assertions generally
fail when the starting anchor is absent; no second whole-script vacuity was
confirmed.

### Highest-cost behavior with no effective coverage

Ranked by how quietly failure would reach users:

1. A real-browser lifecycle sequence that counts observers and document
   listeners across language remount, split, and close, then requires zero
   panel-owned state after close.
2. Real analysis interactions after remount: Plotly handler presence and
   working zoom recomputation, legend actions, and double-click autoscale,
   rather than source text saying handlers are identity-keyed.
3. Delayed async chart completion followed by remount or mode change, requiring
   every continuation to reject captured detached DOM.
4. End-to-end panel rebuilds during live update, data-tool apply, file reload,
   and session restore while panels occupy analysis modes.

These are intentionally the small set where a silent failure would be most
expensive; this audit does not propose browser tests for every feature.

## Checked and found clean

- PR #35's eager-detail continuation revalidates mode, current panel identity,
  and `isConnected`; its dedicated behavioral test passes.
- PR #36's `onPanelDetach -> _destroyChart` chain runs before the layout wipe.
- PlotManager-owned resize observers, Plotly divs, cancellation tokens,
  deferred handles, and `_cursorDocListeners_<viewId>` keys are released by
  `_destroyChart`.
- Remaining plot-handler installation guards reviewed in the analysis modes
  are tied to DOM-node identity or stored on the DOM node itself rather than a
  panel-state boolean.
- `_rebuildPanel` destroys before rebuilding; data-tool apply, file reload,
  live-update refresh, and session reapplication reach that path.
- Theme switching did not recreate graph DOM or change lifecycle counts: two
  graphs remained, observer/listener counts were unchanged, and detached panel
  observers stayed at zero.
- Ordinary panel split/close did not leave PlotManager resize observers attached
  to detached panel elements.
- The ordinary Noisy Chirp remount race retained both graphs, left zero detached
  panel observers, and produced no application error.
- Window and sidebar resizing do not discard chart DOM in the reviewed paths.
- Phase-fit and state-animation document-listener cleanup paths are explicit and
  reached from chart teardown.
- Temporary audit instrumentation was removed; the audited worktree returned
  clean before this report-only commit.

## Validation record

- `npm install`: completed.
- `npm run test:panel-detach-on-render`: passed on the audited, unfixed base.
- `npm run test:crlf-assumptions`: passed; 58 file-reading scripts scanned.
- `npm run test:release`: passed all 94 scripts in 164.1 seconds.
- Browser console during the two confirmed reproductions: no application or
  Plotly errors. The only warning was GoatCounter declining to count localhost.
