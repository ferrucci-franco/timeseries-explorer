# Data tools: filling, detrending, filtering and resampling — design note

> Status: **implemented**.
> Scope: four new entries in the sidebar *Data tools* picker — *Fill missing
> data*, *Detrend*, *Digital filter* and *Resample*. The original four tools are
> untouched. §§1–4b and 5–7 cover filling and resampling; §9 covers detrending
> and filtering.

## 1. Two different problems

Both tools are about the sampling of a series, and they are deliberately
separate because they answer different questions:

| | *Fill missing data* | *Resample* |
|---|---|---|
| Question | "what was the signal doing where the file has nothing?" | "what would this look like sampled at Δt?" |
| Output length | the same | different, by design |
| Output time axis | the file's own | a new uniform one |
| Output lives in | a variable of the file | **a new file** |
| Appears in the Transformations table | yes | no |
| Live dashed preview | yes | no |

Keeping them apart is what lets each one be honest. The resampler never invents
data across a hole (§4), and the filler never moves a sample. Run the filler
first if you want a resample to cross a gap; that is a decision with its own
parameters, and it is made in the tool that owns them.

## 2. Filling: `src/compute/kernels/interpolate.js`

Seven methods, all local, all evaluated in **time** rather than row number
whenever the axis allows it (finite and non-decreasing — see §6; otherwise the
row number *is* the honest coordinate and the panel says so afterwards).

| Method | What it is | When |
|---|---|---|
| `linear` | straight line between the samples either side | the default; nothing to justify |
| `pchip` | Fritsch–Carlson cubic Hermite | curved data where an overshoot would be a lie (a level, a concentration, anything bounded) |
| `akima` | Akima cubic Hermite | smoother through curvature, shrugs off one wild neighbour; no monotonicity guarantee |
| `smooth` | Gaussian-weighted local linear regression | **noisy** data — see below |
| `nearest` / `previous` / `next` | zero-order holds | sampled-and-held signals, setpoints, states |

`pchip` and `akima` are computed from at most three valid samples each side of
the hole, never from a spline fitted across the whole series. That is not an
approximation: both estimators are local by definition, and it is what keeps the
cost per hole to a few dozen operations on a multi-million-sample trace.

### The smoothed method

This is the one the other six cannot do. A linear bridge is anchored on exactly
two samples, and on a noisy signal those two samples are noise too — their
errors go straight into the bridge, and a bridge between two readings that both
happen to sit high comes out high along its whole length.

`smooth` instead fits a straight line through the surrounding valid samples,
weighted by `exp(-½(Δrow/σ)²)` with `σ = window/4`, and evaluates it at the
missing time. The fit is in x, so the trend it extends is the real one; the
weights decay with row distance, so the window covers a comparable number of
samples even where the axis is irregular. It reduces to the weighted mean when
the fit is degenerate, and to the plain linear bridge when the window caught no
valid sample at all — never to NaN, because the run was already accepted for
filling. The window is a slider, shown only for this method.

### The gap limit

`maxGap` is the number of *consecutive* missing samples a run may have and still
be filled. Runs longer than it are left exactly as they are, and the panel
reports how many, how long the worst one was, and how many samples in total.

This is the same argument as the integral's gap policy: over three missing
samples a linear bridge is a fair guess, over three hours it is fiction, and the
difference has to be the user's to set. The control is a slider **plus a number
box**, and the box is deliberately unbounded above — 5000 samples is a
legitimate limit, and it does not deserve a 5000-wide slider nobody can aim.
Typing past the slider parks it at its maximum and the read-out shows the real
number. An empty box means no limit at all, and says "no limit" rather than
printing `1000000000` (a finite sentinel, so that a saved session round-trips it
through `JSON.stringify`, which would turn `Infinity` into `null`).

Leading and trailing runs are extrapolation, not interpolation — there is no
second endpoint to bridge to — so they are left alone unless *Missing at the
ends* is set to hold the nearest known value.

## 3. Resampling: `src/compute/kernels/regrid.js`

Not to be confused with `resample.js` next to it, which is min/max decimation
for the *drawing* path and never touches stored data.

Three ways to say what grid you want, all resolving to one Δt through
`planResampleGrid`:

- **New Δt** — an absolute step, in seconds on a calendar axis and in the axis's
  own units otherwise. Explicitly **not** required to divide the original Δt.
- **Rate factor** — 2 doubles the sample rate, 0.5 halves it.
- **Number of samples** — spanning the same interval.

The field opens holding the file's *own* Δt, so any edit reads as a change from
the status quo, and a live summary states the result before anything is
committed: `Δt 0.1 → 0.35 s · 201 → 58 samples · downsample ×3.5`. A grid that
cannot work (a Δt longer than the recording, one that would need twenty million
samples) says so there and disables the commit buttons.

### Two families of method

**Point methods** — `linear`, `pchip`, `akima`, `nearest`, `previous` — ask what
the signal was doing at *t* and read the curve there. Correct for upsampling.
Wrong for a large downsample: reading one instant per second out of a 1 kHz
signal aliases everything above 0.5 Hz into the result, and the alias is
indistinguishable from real slow structure. (`scripts/test-interpolate-regrid.mjs`
makes this concrete with a ±1 alternation that point-sampling turns into a
constant +1.)

**Bin methods** — `mean`, `median`, `min`, `max` — ask what the signal did over
the interval around *t* and reduce every source sample in it. `mean` is a boxcar
low-pass followed by sampling, i.e. the anti-aliased downsample; `median` is its
outlier-proof sibling; `min`/`max` keep the envelope, so a spike survives a 100×
reduction instead of being averaged away. Bins are centred on their grid point
(`[t − Δt/2, t + Δt/2)`) so the reduced series stays in phase with the original.

## 4. Holes are not bridged by the resampler

A target sample whose surrounding *source pair* contains a non-finite value
comes out missing. An empty bin comes out missing. The panel reports the total.

The alternative — quietly interpolating across the hole — would hide it inside
an operation the user asked to do for an unrelated reason, which is exactly the
defect the integral's gap policy exists to correct. *Fill missing data* is the
tool that makes that decision, with the parameters that decision needs.

## 4b. Repeated timestamps

A Modelica result writes **two rows at every event** — the value before it and
the value after it — and one more at the end of the simulation. The bundled
Simple Pendulum example ends `[…, 19.999, 20, 20]`, and a file with a state
machine in it has such a pair at every switch.

Both tools therefore accept a **non-decreasing** axis; only a step *backwards*
is refused, because no reading of one puts a value in the right place. The
first cut of this feature demanded strictly increasing timestamps and refused
the app's own example, which is how the rule was found.

What a tie means, concretely:

- **Bin methods** never cared: a bin aggregates whatever falls inside it, so one
  straddling an event averages both sides of the discontinuity.
- **Point methods** resolve a target time landing exactly on a repeat to the
  value **after** the event (the search takes the last source sample at or
  before *t*). A signal read at the instant it switches has already switched.
- **Cubic slopes** never build a secant across the zero-width interval a repeat
  creates — that is a divide by zero wearing the costume of a slope. Both
  kernels prune their local point list outwards from the interval being fitted,
  keeping the two samples that actually frame it and admitting a neighbour only
  when it sits at a strictly different time.
- **Filling** keeps interpolating in time. Before the fix, one repeated
  timestamp anywhere in a 20 000-sample file sent the whole fill down the
  row-number path — and then announced that the file's time axis was unusable.

## 5. Why a resample is a file

`PlotManager._getTimeVar` ([plot-manager.js:3354](../src/plots/plot-manager.js:3354))
finds a file's time axis by scanning `data.variables` for the single
`kind: 'abscissa'`. A file has exactly one, and nothing anywhere gives a
*variable* an axis of its own — `independentIndex`
([data-methods.js:1130](../src/plots/methods/data-methods.js:1130)) can only
take a prefix of the shared one.

So a resampled variable stored back into the source file would be drawn against
the old axis, silently, at the wrong times. A new file gets a new axis for free,
and the multi-file machinery already handles everything that follows: the two
overlay on one panel when their axes are compatible (which they are — same
semantics, same unit), the incompatible-axis guard catches it when they are not,
and per-trace CSV export already emits one time column per trace.

That choice has consequences, all deliberate:

- **The whole file is resampled**, not one variable. A dataset with one column on
  the new grid and the rest left behind is not a dataset. The picker still lets
  you narrow it to a single variable. Parameters (constants) are copied through
  untouched; strings, booleans and variables whose length does not match the
  abscissa are left out.
- **The file is a derived dataset** (§5c): it carries its recipe, is listed
  under its source, has a Transformations row, is edited in place, follows a
  reload of the source and is saved to a session as that recipe. Re-running
  under the same file name still rewrites that file in place; a different name
  makes a second dataset.
- **The file can still serialize itself.** The entry carries a lazy
  `syntheticBytes()` that renders the dataset as CSV on demand, which is what
  the *save to disk* button writes. A project session no longer needs it — the
  recipe is what gets saved — but an orphaned dataset (its source closed out
  from under it in an older session) is still a plain file with bytes. Lazily,
  because a multi-million-sample grid should not become a string until
  something asks.

### 5b. Saying that the file is not on disk

A resampled file looks exactly like a loaded one in the files list — same name,
same variables, same plots — and vanishes when the tab closes. Nothing said so.
The row showed the absence rather than the fact: no size, no path in the
tooltip, which is not something a reader notices.

Three places now state it, all reading one predicate,
`_isInMemoryFile` — an entry with a `syntheticBytes()` hook and no `file`,
`buffer` or `localPath`:

- an amber **in memory** badge on the row, with the whole explanation in its
  tooltip (including that a project session does keep it);
- a save button beside it that writes the CSV. Where the browser offers a save
  dialog it is used, so the user picks the path and the write is confirmed;
  where it does not — Firefox, Safari — it falls back to a download, the same
  two branches `_pickBrowserParquetDestination` already faces. Backing out of
  the dialog is a decision, not a failure, and reports nothing. It sits ahead of
  the format controls (CSV parsing, MAT arrays, transform), because it is about
  whether the file exists at all rather than how it is read, and its icon is
  drawn as an SVG: `⤓` as a glyph renders hairline thin at 0.85 rem and vanishes
  among the controls beside it, which is the opposite of what a button resolving
  a warning should do;
- one sentence in the message the resample already prints, at the moment the
  user is certainly looking.

The badge does **not** disappear once a copy has been written, and this is the
point: a CSV on disk is not the same as this entry being backed by one. Reload
the app and the file is still gone. What the save adds is a second tooltip line
naming the copy — cleared on a rewrite, since the copy is then stale.

**Reload is refused with a reason.** Pressing Reload on one of these files used
to reach `_readLatestBuffer` and raise `No buffer available` through a native
`alert()` — a message about an internal field, thrown at the bottom of a parse
path, that says nothing about why. `_refuseReloadOfInMemoryFile` catches it at
the top of both reload entry points (`reloadActiveFile` and
`reloadActiveFileAsNewVersion`) while the reason is still known, and names the
way forward: write it out, then open that CSV like any other file and close this
copy. If a copy already exists the advice skips straight to opening it.

### 5c. Derived datasets

A resampled file used to be an orphan: it knew which file it came from and
nothing else. Changing the Δt meant filling the form again and typing the same
name; a view session lost it; a project session stored its rows. The user's
question was the right one — *why is a result that needs its own axis a
second-class file?* — and the answer is `derived-dataset-methods.js`.

The file entry gains one field:

```js
entry.derivedDataset = { tool: 'resample', sourceFileId, sourceName, params }
```

Everything else follows from having that recipe:

- **Where it shows.** In the source file's variable tree, a family *Derived
  datasets* after *Derived variables*, one node per dataset with its variables
  as leaves. The leaves belong to another file, so each carries the dataset's
  file id (`data-file-id`) and a drag from one names that file in the payload;
  `PlotManager._handleVariableDrop` adds the trace with that file active
  (`withActiveFile`) and puts the active file back. Multi-selection stays a set
  of names of the active file; a foreign leaf is dragged on its own. In the
  files list the dataset sits indented under its source with a `↳` and a
  *derived* badge (the amber *in memory* badge is dropped there — the tooltip
  says it, and two badges hid the name). In the Transformations table it has a
  row of its own, *all variables → name*, with the same edit and delete
  buttons as a variable. Each action has one home: editing in that row, saving
  to disk in the files list, closing in all three places (the tree node keeps
  only its `x`, like a derived variable's leaf). Earlier versions repeated the
  pencil and the save button on the tree node, and that was one more place to
  look for the same thing.
- **Editing.** The pencil reopens the tool with the recipe's parameters and the
  dataset's name, in the source file's panel; the buttons read *Update* and a
  banner names the dataset. Opening is announced first — the message line
  reads "Opening *name* for editing…" and the Create buttons go dead — because
  switching to the source re-renders the sidebar and the tool's sync measures
  the source axis, a visible pause on a long file. The cross-correlation panel
  keeps that measurement per axis array (`_xcorrAxisStep`), as the resampler
  already did, so the sync no longer sorts every Δt three times over.
  Committing recomputes through the one shared path,
  `_computeResampleDataset`, and rewrites the same file even under a new name.
  Panels drawing it are rebuilt by `updateFileData`, as for a variable. The
  source stays the active file throughout — that is where the dataset is
  listed and where the user was working.
- **Reload.** Reloading the source recomputes every dataset derived from it,
  and datasets derived from those, in order. Reloading a dataset itself is that
  recompute (it used to be refused: a file with no bytes had nothing to read).
- **Sessions.** The dataset is not a file of the session. It is recorded under
  its source's metadata as `derivedDatasets: [{ id, name, tool, sourceName,
  params, transform, invertedVariables, derivedDatasets }]` — nested, so a
  chain restores in order — and rebuilt from the recipe after the source's
  generated variables are back (a resample may include one of them) and
  before the plots (which reference the dataset by the id the record keeps;
  `_restoreDerivedDatasets` maps it in `fileMap`). A project session therefore
  stores no rows for it. Restoring a session over open files first closes the
  datasets those files already carry: the session brings its own recipes.
- **Closing.** Closing a source closes what was derived from it, after one
  question that names the datasets and reminds the user they can be saved to
  disk first. The question covers the plots too, so there is no second dialog.
  The cascade defers panel rebuilds to the close that started it
  (`removeFile(id, { deferRebuild })`, then `{ rebuildAll }`): back-to-back
  rebuilds of the same panel raced inside Plotly.

Three smaller things round it off:

- **Create and plot** depends on what the dataset's axis means. A
  cross-correlation's lag axis is not time: its curve goes on an *empty*
  time-series panel, and when there is none a new panel opens below the last
  one (`_openPanelForDataset`) rather than drawing a lag over a time axis. A
  resample keeps the source's time axis, only with another Δt, so its curve
  goes on the panel already drawing the source variable (or the first panel
  drawing anything), as a derived variable's does — the comparison with the
  original is the point (`_plotDerivedDatasetVariable`'s `alongside`
  option). The dataset is registered with its panel rebuild deferred: the
  split's own render redraws every panel once, and two rebuilds in flight
  together raced inside Plotly.
- **No parsing button.** The ▦ button of the files list is hidden on a dataset:
  nothing was parsed, so there is nothing to adjust, and the rows themselves
  are on a panel already (a read-only table of the first rows was tried and
  dropped — the curve says more).
- **The pencil says what it did.** Editing scrolls the Data tools panel into
  view and the message line reads "Editing *name*: change the parameters
  below and press Update", because the button sits below the form it just
  filled.
- **The CSV a dataset writes carries units in its headers** (`lag [s]`,
  `x [V]`), the form the CSV parser reads straight back into a name and a
  unit. Which is also why a variable description must never carry a bracketed
  token that is not its unit.

And one thing that is not about datasets: **every commit shows it is
working**. The Create buttons go dead the moment they are pressed and, if
the run is still going 250 ms later, the message line turns into a small
spinner with "Computing *tool*…" — so a filter over a million samples is
visibly in progress and a fast tool never flashes it (`_beginDataToolBusy`).

And the message line itself has rules (`_setOutlierMessage`). A success
notice goes away by itself after 6 s; a *warning* — an action that completed
with a caveat, such as "131 769 new samples are missing" after a resample
over holes — after 15 s, long enough to read the numbers; an error stays,
since it names something the user has to change; a "computing" line is the
commit's to take down. And every message remembers the file it was said
about: when the active file changes, or the last file is closed, the sync
drops it (only a "computing" line rides through). Before this the resample's
holes notice was typed as an error, so it never went away and outlived every
file it could have referred to (#55).

The per-tool compute stays with the tool; the module only knows how to ask
for it. The cross-correlation (§10) is the second recipe.

### 5d. Measuring the axis once

Every tool that reasons in time asks how the file is sampled — the filter for
its sample rate and its gap note, the cross-correlation for its lag unit, the
resampler and the interpolator for their gap notes — and a sync of the panel
asks several times over. The measurement (`detectSamplingGaps`) used to build
a plain array of every Δt and sort it with a comparator: most of a second on a
minute of audio at 48 kHz, and the panel called it thirty-eight times between
picking the variable and pressing Create — twenty-two seconds with the
interface frozen while the filter itself took 64 ms in the worker.

Two changes. The median is now a selection (`medianInPlace`, Hoare's
partition on a `Float64Array`, O(n)) rather than a sort, which is ten times
faster; `medianStep` in the resample kernel uses it too. And the app makes the
measurement once per axis array (`_axisStepInfo`, a `WeakMap` keyed by the
array): a reload or a recompute makes a new array, so nothing can go stale,
and a closed file's entry is collected with it. The resampler's
"complete missing timestamps" judgement, a separate pass, is made only while
that tool is on screen instead of on every file load.

The same three rules then went through the rest of the panel, because the
mistake is easy to make again.

- **Measure once, per array, for every measurement** — not just the sampling
  step. `_memoByArray(key, values, compute)` is the one place that holds them:
  the step, the runs of missing values (`_interpolateRuns`), whether the
  sampling is regular (`_resampleRegularSampling`), the span and native Δt
  (`_resampleAxisMeasure`). These had a single-entry cache each, which a user
  alternating between the two channels of a stereo recording missed every
  time. Identity is a sound key because nothing here mutates a series in
  place.
- **Do not measure for a tool nobody is looking at.** A reset of the
  parameters runs on every tool change and seeded the resampler's Δt and the
  cross-correlation's lag range — two passes over the axis — whichever tool
  was selected; each tool now seeds its own on the way in. The
  cross-correlation's lag-unit label did the same on every file load.
- **Do not compute a preview nobody can see.** The draft preview is a dashed
  trace beside the source curve, so with no panel drawing that source it had
  nowhere to go — and it was a whole-series run plus a copy of the values and
  the time axis, thrown away on arrival. `_runDataToolPreview` now asks for
  the panel first, the same question `_drawDataToolPreviewTrace` asked after
  the fact. An edit is different: it writes into the live variable, which its
  own panels follow, so it runs regardless.

Measured on a minute of audio at 48 kHz (2.88 M samples), picking each tool in
turn, choosing the signal and nudging one parameter, with nothing plotted:
main-thread blocking fell from 0.1–0.8 s per tool to zero, except the two
tools that legitimately measure something to fill their own form (the
resampler's Δt, the interpolator's missing-run count) at around 130 ms once
per file.

What is left, when the signal IS on a panel, is Plotly: redrawing a
2.88 M-point trace for the live preview costs seconds per parameter change,
and so does drawing the signal in the first place. That is the plotting
story, not this one.

## 6. Where the work runs

Filling goes through the existing `dataTool:pipeline` worker op, so it chains
with the other tools and previews without blocking the UI.

Resampling has its own op, `dataTool:resample`, which takes every column at once:
the grid and the source-axis validation are shared, so a twenty-variable file is
one round-trip rather than twenty. Both fall back to running in-thread when no
worker is available (`file://`, Node harnesses, a crashed pool), and the payload
is rebuilt for the fallback — posting with a transfer list neuters the buffers on
this side, so the inline path cannot be handed the arrays that were just given
away.

## 7. Not done

- **No resample recipe in a view session.** The resampled file is matched back by
  name and variables like any other open file; a *project* session round-trips it
  through its CSV bytes. Storing the recipe and regenerating on restore would be
  cheaper on disk, and is a follow-up.
- **No frequency-domain resampling** (sinc / polyphase). `mean` covers the
  anti-aliasing that matters for inspection. The filter tool can now *design* an
  IIR low-pass (§9), but the resampler does not call it: a decimator that
  filters and then picks every k-th sample is still a follow-up.
- **No elliptic (Cauer) family and no response plot** in the filter designer.
  Both were considered and deferred: the elliptic prototype needs Jacobi
  elliptic functions, and a live |H(f)| plot in the sidebar is a feature of its
  own.
- **Nothing for lazy DuckDB files.** Both tools need the values, and a lazy file
  holds column references. Same restriction the derivative and integral already
  carry.

## 8. Tests

- `scripts/test-interpolate-regrid.mjs` — the kernels: time-vs-row coordinates,
  the gap limit, edge runs, exactness on a straight line for every method that
  claims it, pchip's no-overshoot, the smoothed fill beating linear on noise,
  grid construction including a non-commensurate Δt, bin edges, aliasing,
  repeated timestamps (a Modelica event step, and the pendulum's repeated final
  sample), and the refusal of a backwards axis.
- `scripts/test-data-tools-sampling.mjs` — the panel: the tool taxonomy, reading
  every form, the box-past-the-slider behaviour, the seconds↔milliseconds
  conversion on a calendar axis, the summary's numbers, the shape of the file a
  resample produces, the CSV serializer, and the stability gate as the panel
  enforces it.
- `scripts/test-derived-datasets.mjs` — the recipe's whole life: stored on
  commit, recomputed from the source's current data through a chain, reopened
  for editing and rewritten in place under a new name, serialized under the
  source and restored with its id mapped, closed with its source after one
  question (and never a second one), and left alone when orphaned.
- `scripts/test-xcorr.mjs` — the cross-correlation kernel (the MATLAB sign on
  a delayed copy both ways, the four normalisations by definition, mean
  removal, holes as removed pairs, the FFT route against the direct one) and
  its panel (Δt and lag range on seconds, calendar, index and declared-unit
  axes, every refusal, the lag-axis dataset with the peak as parameters, the
  sign sentence, and the recipe round trip through the derived-dataset
  machinery).
- `scripts/test-detrend-filter.mjs` — the detrend fits (exactness on a line and a
  parabola, an epoch-ms axis, holes, the moving-average high-pass) and the
  filter (coefficient parsing, Schur–Cohn cross-checked against root finding on
  eight denominators, unit-circle poles, steady-state initialisation, zero-phase
  symmetry, and per-run restart at a hole).
- `scripts/test-filter-design.mjs` — the designer: MATLAB's `butter` coefficients
  to the printed digits, the textbook Chebyshev and Bessel prototype poles, and
  for every family × response × six orders the property each family promises
  (−3 dB / −ripple / −attenuation at the cut-off, DC and Nyquist passed or
  stopped, the passband within bounds, the stopband below the attenuation);
  the section cascade against the b/a path where both are sound, and the
  order-8 case where only the cascade is; the panel's sample-rate reading on
  seconds, milliseconds, calendar, index and irregular axes; every refusal
  code; and the session round-trip of a designed definition.

## 9. Detrend and the digital filter

Both are ordinary variable-producing tools: same length, same axis, full
preview, table, chaining and editing.

### Detrend

Every method is a **subtraction**, so the residual is in the signal's units and
adding the trend back reconstructs the original exactly. Nothing is rescaled.

| Method | Removes |
|---|---|
| `linear` | the least-squares straight line (the default) |
| `mean` | the offset only |
| `polynomial` | a fit of order 2–8 |
| `movingAverage` | a centred moving-average baseline — a high-pass that follows a wandering floor a polynomial cannot |
| `firstSample` | the first value, so the series starts at zero |

`mean` and `linear` are orders 0 and 1 of the same solver: one place where a fit
can be wrong instead of three. The fit runs on a **centred and scaled** abscissa,
u = (x − mid)/half ∈ [−1, 1] — a datetime axis carries ~1.8e12 as epoch
milliseconds, and u³ of that is out of useful double precision before the fit
starts. When the normal equations come out singular the order **steps down**
rather than giving up: with every sample at the same instant a line is
undetermined but the mean is not, and handing the signal back untouched would
hide something real. Non-finite samples take no part in the fit and stay
non-finite. For a linear detrend the panel reports the drift it removed, per
second on a real time axis and per sample without one — the one number that
makes a detrend checkable, since the result looks trendless either way.

### Digital filter

`a₀·y[n] = b₀·x[n] + b₁·x[n−1] + … − a₁·y[n−1] − …`. The coefficients come from
one of two places, chosen at the top of the panel:

- **Design from a specification** (the default) — family, response, order and
  cut-off; see *Designing a filter* below.
- **Type b and a** — the coefficients as they are. Nothing guesses. Both boxes
  accept commas, spaces, newlines and MATLAB/NumPy brackets, because
  coefficients are pasted far more often than typed.

Everything past that point — direction, initial conditions, the gap policy,
the stability gate, the preview, the table, sessions — is one tool whichever
way the coefficients arrived.

**Stability is a gate, not a warning** — the point of the feature. An IIR filter
feeds its own output back; with a pole on or outside the unit circle the output
reaches ±1e308 within a few thousand samples and is Infinity for the rest,
poisoning every downstream tool, autoscale and export. There is no useful
"unstable" output to look at, so:

- the Create buttons go dead and name the reason,
- the live preview stops drawing,
- reading the config *throws*, so the commit and the preview refuse through one
  check rather than two,
- and `applyFilter` refuses again in the kernel, because a definition restored
  from a session predating this check can also reach it.

The verdict comes from the **Schur–Cohn** test (Levinson step-down), an exact
decision procedure that reads stability off the coefficients in O(N²) with no
iteration to converge or fail. Root-finding (Durand–Kerner) runs too, but only
to say *where* the pole is: "a pole at |z| = 1.03" tells the user which
coefficient to pull back, and "unstable" does not. `test-detrend-filter.mjs`
cross-checks the two on eight denominators — they are computed by completely
different routes, so the agreement is a real check. A pole exactly on the unit
circle is refused: it neither decays nor stays bounded, and it is the singular
point of the step-down itself.

Two more decisions worth naming:

- **Steady-state initial conditions** (scipy's `lfilter_zi`). Starting from rest
  makes a signal sitting at 300 K open with a swing from zero that has nothing to
  do with the data — the most common "the filter broke my signal" report there
  is. The state is pre-loaded as if the input had been constant at its first
  sample forever, so a constant in gives that constant out for any filter with
  unit DC gain.
- **Each run of present samples is filtered on its own.** A single NaN inside an
  IIR recursion enters the state and every sample after it is NaN for the rest of
  the file. Restarting at each hole confines the damage to the hole — the same
  promise the resampler makes, and the panel says when there was more than one
  run, because the filter's transient then appears more than once.

*Forward and back (zero phase)* filters in both directions with odd-reflection
padding, so nothing shifts in time, at the cost of applying the magnitude
response twice. Verified against a symmetric bump: forward moves its peak 15
samples later, zero phase leaves it exactly where it was.

### Designing a filter

Issue #62 asked for the classic families with the user choosing type, order and
cut-off in hertz. The kernel is `src/compute/kernels/filter-design.js`; it takes
the textbook route, which is also MATLAB's (`butter`, `cheby1`, `cheby2`,
`besself`) and scipy's (`iirfilter`):

1. an **analog low-pass prototype** at 1 rad/s — Butterworth, Chebyshev I
   (passband ripple in dB), Chebyshev II (stopband attenuation in dB), or Bessel
   (roots of the reverse Bessel polynomial, found by Durand–Kerner with a Newton
   polish, then normalised so the magnitude is −3 dB at the cut-off, as a user
   who types a cut-off frequency expects);
2. the **analog frequency transformation** to low-pass, high-pass, band-pass or
   band-stop, in zero-pole-gain form;
3. the **bilinear transform**, with the cut-off(s) pre-warped so the digital
   filter lands exactly on the frequency typed.

So "analog filter" is what the families are — the shape of the response — while
what runs is necessarily digital: the data is sampled. The help popover says
this in as many words.

**Sample rate.** Read off the source variable's time axis, never typed:
1 / median Δt, through the same `detectSamplingGaps` the integral and the gap
policy use. The cut-off's unit follows from the axis — hertz for a calendar
axis or a numeric axis whose declared unit is a time unit (`s`, `ms`, `min`,
`h`…), cycles per sample for an index axis (Nyquist 0.5), and "cycles per
*unit*" when the file declared something else. A cut-off at or above Nyquist
is refused with Nyquist spelled out.

**An irregular axis refuses the design.** This is the one place the two
coefficient sources differ. A typed b/a is defined per sample, so the manual
tool runs on an irregular axis and merely warns that its cut-off is not a
frequency. A *designed* filter is a cut-off in hertz and nothing else, and on
unevenly spaced samples that describes nothing — so the panel does not design
one: the Create buttons go dead, the summary names the reason and points at
the resampler, and reading the config throws (same contract as the stability
gate). Isolated dropped samples on an otherwise uniform axis are not
"irregular"; they are handled by the gap policy as before.

**Second-order sections.** A designed filter of order 8 with a cut-off at
fs/1000 has every pole crowded near z = 1. As one polynomial the coefficients
need more precision than a double carries: rounding alone moves a pole across
the unit circle and Schur–Cohn — rightly — refuses the filter the user asked
for in good faith. `test-filter-design.mjs` demonstrates exactly this: the
expanded polynomial of that design fails `inspectFilter`, the same design as
sections passes `inspectSos`, and a constant goes through it unchanged. So the
kernel factors the design into second-order sections (poles nearest the unit
circle paired with the nearest zeros and placed last, as scipy's `zpk2sos`
does) and `applyFilter` runs the cascade section by section, with one state per
section. Steady-state initialisation propagates the level through each
section's DC gain (scipy's `sosfilt_zi`); the gap policy and zero-phase padding
are unchanged. The expanded b and a are still produced — they are written into
the coefficient boxes, read-only, for reading and pasting elsewhere — but they
never run.

Two consequences follow:

- *Past samples of x and y* is withdrawn for a designed filter. Past samples at
  the outer terminals pin down the state of one section exactly and of a
  cascade not at all (the signals between sections are unknown). The option is
  disabled in design mode; a stored definition that carries it anyway is read
  as steady state.
- The stored definition carries the **sections**, the **specification** (with
  the sample rate and unit it was designed against) and the expanded b/a. The
  sections are what runs again on restore; the specification is what the panel
  reopens with; a definition whose sections do not describe a cascade demotes
  to its b/a, which is at worst the identity. A session from before this
  feature is a manual filter, as it always was.

## 10. Cross-correlation

The second derived-dataset tool, and the first whose axis is not time at all.
Two signals of one file in, r_xy as a function of **lag** out, on a `lag` axis
in the file's time unit (seconds for a calendar axis, the declared unit
otherwise, samples when there is no time axis). Kernel:
`src/compute/kernels/xcorr.js`; panel: `src/app/methods/xcorr-methods.js`.

**The definition and the sign.** r_xy[k] = Σₙ x[n+k]·y[n], the convention of
MATLAB's `xcorr(x, y)` and SciPy's `correlate(x, y)`. A peak at a *positive*
lag means x[n+k] lines up with y[n]: x runs behind y — x is the delayed
signal. The kernel test pins this on a delayed copy in both directions, the
help says it in words, and the message after Create reads it out ("omega
runs behind theta by 0.64 s") because the sign of a lag is the one thing every
user of a cross-correlation gets wrong once. Choosing the same signal twice
gives the autocorrelation, r_xx, even and largest at lag 0.

**Normalisation.** The four of `xcorr` by their names: `none` (the raw sum),
`biased` (÷ N), `unbiased` (÷ the overlapping pairs), `coeff` (÷ √(r_xx[0]·
r_yy[0]), so the autocorrelation is exactly 1 at lag 0 and everything sits
in [−1, 1]). `coeff` is the default. *Remove the mean* is on by default: a
constant offset correlates with everything, and with the means gone `coeff`
is the Pearson coefficient of the two signals at each lag.

**Holes.** A product is counted only when both samples are finite, so a NaN
removes pairs instead of poisoning every lag. `unbiased` divides by the pairs
that exist; `biased` keeps N; a lag with no pair is NaN. The FFT route handles
this with the same arithmetic — the series are zero-filled where missing and
the pair counts come out of the FFT of the two masks, since the correlation of
two indicator functions *is* the overlap count. Direct O(N·L) below four
million multiply-adds, FFT above; the test holds the two routes to 1e-9 with
holes in both series.

**The axis.** A lag is a whole number of samples, so it is a time only on a
uniform Δt: the same `detectSamplingGaps` gate as the filter designer, and an
irregular or backwards axis refuses the tool with the reason. The maximum lag
is typed in the axis unit and converted against the median step; it opens at
a quarter of the record. The dataset carries the peak lag and the peak value
as *parameters*, so they show with their values in the tree next to the curve.

Everything else — recipe, tree family, files-list nesting, Transformations
row, edit in place, reload, sessions, cascade close — is §5c unchanged; the
tool only had to provide `_computeXcorrDataset`, `_writeXcorrForm` and a
description.
