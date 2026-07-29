# Data tool UI redesign — specification

> Status: **implemented** — every decision below is in the code; see §9 for what
> was left out and why.
> Branch: `claude/data-tool-ui-redesign-40f22e`. Base commit: `0f99492`.
> Scope: the sidebar *Data tools* section only. Derived variables (formulas) are
> deliberately left alone.

## 1. Why

The data tool works, but the user cannot see what it did. Every fact the panel
would need to show already exists in memory — `dataToolVariablesByFile`
([viewer-app.js:31](../src/app/viewer-app.js:31)) is a
`Map<fileId, Map<variableName, definition>>`, and each definition carries
`{ name, tool, targetMode, sourceName, method, params, replacement, steps[], originalData }`.
None of it reaches the screen. The only hint is a `(modified)` suffix in the
variable tree ([tree-methods.js:449](../src/app/methods/tree-methods.js:449)).

Three concrete defects follow from that:

1. **Everything auto-applies, including the name field.** The output-name input
   is wired to `_scheduleDataToolAutoApply()` with a 350 ms debounce
   ([data-tools-methods.js:79](../src/app/methods/data-tools-methods.js:79)).
   Pausing while typing commits a variable under a half-typed name. There is no
   moment at which the user says "now".
2. **Chaining is implicit, and silently overwrites.** Selecting a tool-created
   variable as the source in modify mode appends a step to its `steps[]`
   (`_applyDataToolAppendToCreatedVariable`,
   [data-tools-methods.js:602](../src/app/methods/data-tools-methods.js:602)) —
   unless the last step uses the same tool, in which case it *replaces* it
   (`replaceLast`). The user has no way to predict which happens.
3. **Reset guesses.** `_findOutlierResetDefinition` falls back to scanning every
   definition for one with a matching `sourceName`. A button that guesses what
   to undo.

## 2. Decisions

| # | Decision |
|---|---|
| D1 | The transformation table is **per file**, showing the active file only. Variables are per file and are not reachable without selecting the file. |
| D2 | Data tools **only create new variables**. Modify-in-place is dropped. |
| D3 | The table stays minimal: source name, result name, tool name. **No parameters** — future tools may carry many. |
| D4 | Rows are **two lines**, because the sidebar is narrow. |
| D5 | Nothing is written until the user presses a button. `Create` / `Create and plot` / `Clear`. |
| D6 | `Clear` resets the form only. Deleting a transformation is the row's trash button. The two were conflated in the old `Reset`. |
| D7 | Editing opens the same panel, pre-filled, with `Update` / `Update and plot` / `Cancel`. |
| D8 | The output name is **read-only while editing**, unlocked by a small pencil button. |
| D9 | Chaining needs no special mechanism: a transformed variable is just another entry in the source picker. `steps[]` is retired. |
| D10 | While drafting, a **dashed preview trace** updates live and writes nothing. While editing, the **real trace** updates live. |
| D11 | Editing a variable with dependents recomputes the whole chain live, behind a checkbox that defaults to on. |
| D12 | Suggested output names keep the existing scheme (`velocity ddt`, `velocity avg`, …). |

Decisions deliberately **not** taken: merging this table with the derived
variables list (D9 makes it unnecessary — a formula variable is selectable as a
source like any other), and a multi-file view (D1).

## 3. The panel

```
Data tools
┌──────────────────────────────────────────┐
│ Tool        [ Moving average        ▾ ]  │
│ Variable    [ velocity              ▾ ]  │
│ Output name [ velocity avg    ] [✎]      │
│                                          │
│ Window      [────●──────]  21            │
│                                          │
│ ☑ Live-update chain (2 variables)        │  ← only when editing with dependents
│                                          │
│ [ Create ] [ Create and plot ] [ Clear ] │
│ message line                             │
└──────────────────────────────────────────┘

Transformations
┌──────────────────────────────────────────┐
│ velocity → velocity avg                  │
│ Moving average                    ✎  🗑  │
│                                          │
│ velocity avg → velocity avg ddt          │
│ Derivative                        ✎  🗑  │
└──────────────────────────────────────────┘
```

### 3.1 States

```
empty ──select tool+variable──▶ draft ──Create──▶ committed (row appears)
                                 │
                                 └──Clear──▶ empty

row ✎ ──▶ editing ──Update──▶ committed
             └──Cancel──▶ empty  (any live change is rolled back)
```

The panel holds a **draft** that never touches `dataToolVariablesByFile`.
`applyDataTool` runs only from a button.

### 3.2 Buttons

| State | Buttons |
|---|---|
| Draft | `Create` · `Create and plot` · `Clear` |
| Editing | `Update` · `Update and plot` · `Cancel` |

`Create` is disabled until the draft is valid, and the message line says why:
no variable chosen, name already taken, tool unsupported on lazy data.

`Create and plot` commits and adds the trace to the active panel, creating one
if none exists.

### 3.3 The name field

The name field triggers **no computation, ever**. It is validated on input
(empty, collision) and read once at commit time. This is the direct fix for
"typing a name creates variables".

While editing, the field is disabled and carries a pencil button. Pressing it
enables renaming; committing the rename updates the table row, the variable
tree, and any plotted trace label. A rename never recomputes anything: the
values are unchanged, only the key moves.

## 4. The table

One row per transformation of the active file, in creation order.

```
line 1:  <source> → <result>
line 2:  <tool name>                    ✎  🗑
```

Source and result are the plain variable names. The tool name is the localized
label (`Moving average`, `Derivative`, `Integral`, `Remove outliers`) with no
parameters (D3).

- **✎** loads the definition into the panel and switches it to editing.
- **🗑** deletes the variable and its definition. If other variables were built
  from it, a confirmation names them and offers to delete the chain; cancelling
  changes nothing.

The table is empty-stated with a one-line hint when the file has no
transformations, and hidden entirely when no file is active.

## 5. Chaining

With create-only mode (D2), chaining is a consequence rather than a feature: a
tool-created variable appears in the source picker, so applying a second tool to
it produces a second row.

```
velocity → velocity avg
Moving average

velocity avg → velocity avg ddt
Derivative
```

The chain reads top to bottom without expanding anything. Accordingly:

- **`steps[]` is retired.** The append/`replaceLast` logic in
  `_applyDataToolAppendToCreatedVariable` is removed. Sessions saved with
  `steps[]` still load: each step is not re-expanded into separate variables
  (that would invent names), it is applied as the stored pipeline for that one
  variable, and the row shows the last tool. New work never produces `steps[]`.
- **Editing a link recomputes downstream, silently**, via the existing
  topological `_orderedDataToolDefinitions` / `_reapplyDataToolDependents`. The
  result message mentions how many dependents were refreshed.
- **Deleting a link warns and offers cascade** (§4).

## 6. Preview and live editing

The one good property of the current auto-apply — dragging a slider and seeing
the effect — is kept, decoupled from writing.

| Situation | What is drawn |
|---|---|
| Drafting | A temporary **dashed** trace, restyled from the source trace's panel, updating as parameters change |
| Editing, variable is plotted | The **real** trace updates live |
| Editing, variable is not plotted | Nothing; the panel offers `Update and plot` |

The preview never writes to `data.variables` nor to the definition registry. It
is discarded on `Clear`, on tool change, on file change, and on commit — where
`Create and plot` promotes it to a real trace.

Debouncing keeps the existing 350 ms and the existing worker pool; a superseded
run is already handled (`err.cancelled`).

### 6.1 Live-update chain

When editing a variable that has dependents, the panel shows:

```
☑ Live-update chain (2 variables)
```

Default on. Only rendered when the count is greater than zero — with no chain it
would be noise. Unchecking limits live redraw to the edited variable; dependents
refresh on `Update`.

If a live recompute is measured slower than ~300 ms, the checkbox clears itself
once and the message line explains why. Deferred until the slowness is observed
in practice.

## 7. Compatibility

- **Saved sessions.** `_serializeDataToolDefinitions` already stores everything
  the table needs; the format does not change. Definitions with
  `targetMode: 'modify'` continue to load and reapply, so old sessions keep
  working, but the UI can no longer produce them.
- **Lazy (DuckDB) files.** Unchanged: only `removeOutliers` with `bounds` is
  supported. The panel says so, and the table shows such rows normally.
- **Element ids.** The panel's ids are still `outlier-*` even though four tools
  share it. Renaming them to `data-tool-*` is worthwhile but is a separate,
  purely mechanical change; this work adds new ids under `data-tool-*` and
  leaves the existing ones alone.

## 8. Where it lives

All of it is in [data-tools-methods.js](../src/app/methods/data-tools-methods.js):

| Piece | Entry point |
|---|---|
| The only writer | `commitDataTool` → `_createDataToolVariable` / `_updateDataToolVariable` |
| Draft / editing state | `clearDataToolForm`, `_clearDataToolDraft`, `_enterDataToolEditing`, `_exitDataToolEditing` |
| Why a commit is blocked | `_dataToolCommitBlocker` |
| Table | `_renderDataToolTable`, `_handleDataToolTableClick` |
| Chain walk | `_dataToolDependents` (over the existing topological `_orderedDataToolDefinitions`) |
| Rename | `_renameDataToolVariable` |
| Delete with cascade | `_deleteDataToolVariable` |
| Preview | `_runDataToolPreview`, `_drawDataToolPreviewTrace`, `_previewEditedVariable`, `_clearDataToolPreview` |

The preview's placeholder variable is `DATA_TOOL_PREVIEW_NAME`, flagged
`previewOnly`; the flag is honoured in the derived tree section
([tree-methods.js](../src/app/methods/tree-methods.js)), the formula
autocomplete ([derived-methods.js](../src/app/methods/derived-methods.js)), the
tool's own source picker, and the session snapshot
([session-methods.js](../src/app/methods/session-methods.js)).

## 9. Not done

- **Lazy (DuckDB) files get no preview.** Their variables are column references
  rather than arrays, so a preview would compute over the overview and draw a
  curve the commit would not reproduce. Editing and committing work normally,
  through the lazy path.
- **The `outlier-*` element ids stay.** Four tools share them, which is
  confusing, but renaming them is a mechanical sweep across HTML, CSS, JS and
  tests that has nothing to do with this change. New ids added here are
  `data-tool-*`.
- **The self-disabling live-chain checkbox (§6.1) is not implemented.** It waits
  for the slowness to be observed rather than predicted.
