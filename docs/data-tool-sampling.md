# Data tools: filling holes and resampling — design note

> Status: **implemented**.
> Scope: two new entries in the sidebar *Data tools* picker — *Fill missing data*
> and *Resample*. The existing four tools are untouched.

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
whenever the axis allows it (finite and strictly ascending — otherwise the row
number *is* the honest coordinate and the panel says so afterwards).

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

That choice has three consequences, all deliberate:

- **The whole file is resampled**, not one variable. A dataset with one column on
  the new grid and the rest left behind is not a dataset. The picker still lets
  you narrow it to a single variable. Parameters (constants) are copied through
  untouched; strings, booleans and variables whose length does not match the
  abscissa are left out.
- **No Transformations row.** That table lists variables of the current file, and
  this is not one. Re-running under the same file name rewrites that file in
  place, which is the edit story; a different name makes a second file.
- **The file has to be able to serialize itself.** Saving a *project* session
  reads bytes for every open file, and a computed dataset has none — which
  aborted the whole save. The entry therefore carries a lazy
  `syntheticBytes()` that renders the dataset as CSV on demand
  ([session-methods.js](../src/app/methods/session-methods.js)), so a project
  session saves it and reloads it through the ordinary CSV path. Lazily, because
  a multi-million-sample grid should not become a string until something asks.

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
  anti-aliasing that matters for inspection; a proper FIR decimator is a bigger
  feature with its own filter-design controls.
- **Nothing for lazy DuckDB files.** Both tools need the values, and a lazy file
  holds column references. Same restriction the derivative and integral already
  carry.

## 8. Tests

- `scripts/test-interpolate-regrid.mjs` — the kernels: time-vs-row coordinates,
  the gap limit, edge runs, exactness on a straight line for every method that
  claims it, pchip's no-overshoot, the smoothed fill beating linear on noise,
  grid construction including a non-commensurate Δt, bin edges, aliasing, and the
  refusal of a non-ascending axis.
- `scripts/test-data-tools-sampling.mjs` — the panel: the tool taxonomy, reading
  both forms, the box-past-the-slider behaviour, the seconds↔milliseconds
  conversion on a calendar axis, the summary's numbers, the shape of the file a
  resample produces, and the CSV serializer.
