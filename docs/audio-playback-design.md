# Audio Playback Design

Status: phase 1 is built (the player and the panel's transport strip, issue #89).
Phases 2 to 5 — the panel-level selection, stereo and reverse, WAV export, and the
entry points — are specified here and not built. Where use has corrected the
specification, this document says what was changed and why rather than quietly
reading as if it had always said so.

Issue: [#86 — Play audio files (and its filtered versions!) on the browser](https://github.com/ferrucci-franco/timeseries-explorer/issues/86).

## Goal

Hear the signal that is on screen, and hear what a filter did to it. The app already
decodes audio into one column per channel and already designs and applies IIR filters
that leave their result as another variable on the same grid — so the two series a
student needs to compare are already in memory, aligned sample for sample. What is
missing is not DSP. It is transport: turning a stretch of a `Float64Array` into sound,
drawing where it is, and switching between two signals without losing the instant.

The primary use is a university Signals and Systems course, which sets the bar: a
first-year student must be able to use it without being taught, and nothing shown on
screen may be a polite lie about the data.

## The one decision that is not reversible

**One player for the whole app: one clock, one `AudioContext`, one state object.**

Two independent players cannot be compared — pause one, read the time, find it in the
other, press play, and by the time it sounds the ear has lost the reference. Everything
else in this document is a view decision that can be revisited; this one cannot be
walked back cheaply, so it is settled first.

The strip that carries the player's controls is drawn inside the panel that is
sounding (see "Panel layout"). Because the player is a singleton, moving that strip to
a global dock later is a change of view, not a rewrite.

## Scope, as a criterion rather than a list

**Anything with uniform sampling is playable** — not only the channels of an audio
file. The check is the one the FFT already runs (`analyzeSampling`, see
`src/utils/sampling-gaps.js`): constant Δt within its tolerance and at least two
samples. So a filtered variable, a derived variable and a resampled variable are all
playable, and a series with gaps or a non-uniform DateTime axis is not — its button is
disabled **with the reason written out**, never silently missing.

| | Playable | Why |
|---|---|---|
| `Left`, `Right`, `Mono` | yes | channels of the recording |
| `Left_filtered` | yes | Data Tools output, same grid |
| derived / resampled variable | yes | if Δt stayed uniform |
| series with gaps, non-uniform Δt | no | the time would not be the file's |
| signal with fs below ~3 kHz | no | outside what the audio path takes (see "Sample-rate gate") |
| file in memory-saving mode (☘) | no | only the overview exists, not the samples |

## Panel layout

Four placements were drawn. **Option A is chosen.**

### A — transport strip inside the panel (chosen)

A `🔊` button in the panel toolbar opens a ~30 px strip under the chart. The player is
still a single one: the strip appears in the panel that is sounding and is absent from
the others.

Chosen because the range the audio plays is the panel's own selection, so putting the
controls in that same panel means the relationship never has to be explained — it is
visible. It also adds no global chrome: an app with no audio open looks exactly as it
does today.

Accepted costs: the strip moves between panels as the source changes; it takes height
from a panel that may already be short; and comparing is done through a dropdown
rather than two slots visible at once.

### B — global dock at the foot of the app (recorded, not chosen)

A single collapsible bar across the window, with two named signal slots and a `⇄` that
switches between them live. Its one real advantage was making comparison a first-class
control — and that advantage disappeared once the source dropdown of option A switches
without restarting playback (see "Comparison"). Worth revisiting only if audio ever
grows to several signals at once.

### C — an "Audio" panel mode (rejected)

Audio as another mode of the timeseries family, like Fourier or Histogram. Rejected:
it spends a whole panel on listening in an app where panel space is the scarce
resource, adds another mode button to a crowded toolbar, and introduces a second
waveform rendering path to maintain beside Plotly.

### D — a section in the sidebar (rejected)

Cheapest to build, worst to use: the sidebar already carries files, the tree, derived
variables, nine data tools and the display options — and, decisively, the playhead
would have no home, leaving the controls half a screen away from the curve.

## The range: one selection per panel

The audio has **no range of its own**. It plays the panel's selection — the same one
the analysis uses. The user therefore always sees two states, **Todo | Selección**, and
never three.

This reuses what exists rather than inventing a control: `{ rangeFull, x1, x2 }` with a
segmented control and two editable bounds is already shared by FFT
(`src/plots/methods/fft-methods.js`), histogram, correlation and integral, and only one
of those modes is active in a panel at a time.

- **Panel in an analysis mode** — the selection already exists and its control is
  already in the panel's options, so the audio strip does not repeat it and does not
  restate it either: the readout gives the length of what is playing and the panel
  itself shows the bounds. Dragging one changes what is analysed and what sounds at
  once, because they are the same thing; the sound follows a bound that moves while
  it plays.
- **Panel in timeseries mode** — there is no selection yet, so the audio strip
  **carries the control**: same segmented buttons, same draggable bounds, same
  shading. What it creates belongs to the panel, so switching that panel to Fourier
  afterwards finds the selection already made.

Rules:

- A panel has one selection, one control, and the control stays where it already was.
- The A|B measurement cursors are **not** a second range source. At most a later
  "use the cursors" button that copies A and B into the bounds.
- Moving a bound while sound is playing takes effect **at the end of the current
  loop**, never by cutting mid-way.
- `Todo` does not clear the selection, it ignores it — exactly as the FFT behaves today.
- The range shading and the playhead are drawn in every panel that plots that signal.

A four-level cascade (analysis selection → cursors → visible window → everything) was
specified first and withdrawn: it was too clever, and it immediately produced the
question "so there are three options?", which is the proof that it was.

## Output: what sounds, and where

`plot.traces` already holds `{ varName, color, fileId, axis }` per trace, which is
exactly the list the strip needs.

- A **Fuente** selector lists the panel's visible traces by name, each with the colour
  swatch it has in the legend.
- **Mono by default**: the source plays through both speakers. Nothing about stereo
  has to be decided in order to listen to a curve.
- **Stereo is opt-in**: a `🎧` button reveals two small selectors, left and right, each
  with the same list plus "—" (silence). It fills itself in when the two visible traces
  are `Left` and `Right` of the same file — the parser marks the channel in
  `variable.audio.channelIndex`.
- Putting two different signals in the two ears is didactic for hearing *what changed*,
  but the ear localises, and that biases any judgement of "which sounds better". The
  help says so; for judging, alternate instead.

### Comparison is switching the source

Original and filtered are almost always in the same panel — they are plotted together
precisely to see the difference — so both are already in the **Fuente** dropdown. If
switching it does not restart playback, the comparison is done: same instant, same
range, one click. A 10 ms crossfade covers the switch, and `C` alternates between the
two most recently used sources.

There is therefore **no separate comparator UI in v1**, and nothing is labelled `A|B`:
in this app A and B are the measurement cursors, and they appear in the same panel.

### One panel sounds at a time

Pressing ▶ in another panel **stops the previous one** with a 10 ms fade and takes over.

- The **listening state is per panel** — source, range, channels, loop, reverse and
  playhead position. The **player is one** — context, buffer and clock. Returning to a
  panel and pressing ▶ resumes where it left off.
- The stopped panel keeps its strip open, in a stopped state. Only one panel carries
  the live playhead.
- Genuine simultaneity already exists inside a panel: the L/R assignment, where two
  signals are sample-aligned on one clock. Two unsynchronised signals from two panels
  would just be mud.
- Incidentally, a single context also avoids the browser's cap on concurrent audio
  contexts and does not duplicate the buffer in memory.

## Transport

- Play / pause / stop, `Space` as the shortcut.
- **Always 1×.** There is no playback-speed control in v1.
- **Reverse (`⏪`, key `R`)**, a plain toggle. Web Audio does not accept a negative
  `playbackRate`, so the range's samples are copied in reverse order when the buffer is
  built — exact, and free, since that copy happens anyway. The time axis is untouched;
  the only visible change is that the playhead travels right to left.
- Loop over the range, with a ~5 ms fade at each end so the loop does not click.
- Playhead drawn over the curve in every panel showing that signal; click on the chart
  to seek, drag the playhead to scrub.
- Time readout as `m:ss.cc` and in seconds, plus the range duration.
- Volume and mute, remembered between sessions like the app's other settings.
- Ranges shorter than ~50 ms are refused with an explanation rather than played as a
  click — at 44.1 kHz that is 2 200 samples, less than the fade-in itself.

Playback speed was specified and then dropped, and the reason is worth keeping: at
0.5× the pitch drops an octave (it is resampling; preserving pitch needs a
time-stretching library), so the spectrum being heard stops matching the one the panel
draws. That dragged in a second "heard frequency" axis on the FFT, a moving 20 Hz –
20 kHz audible band, a note about the `1/|a|` amplitude factor of the scaling property,
and a decision about which speed the WAV export bakes in. One decision removed all
five. Reverse stays because it drags in nothing.

## Numerical honesty

- Amplitude: **the peak always goes to −1 dBFS**, with no control over it. A
  three-way Auto / Fixed / Manual selector was built and then removed: the
  first person to use the strip could not tell what it did, and a signal is
  read in its own units on the plot and only needs to be *audible* through the
  speakers. The consequence is recorded rather than hidden — each signal is
  normalised on its own, so a filter that removes energy is not heard as
  quieter. Level-matched comparison, when it is wanted, belongs with the
  comparator (phase 3) and has to be a deliberate choice there.
- Clipping is reported with the number of clipped samples, not applied silently.
- DC removal before playback (checkbox, on by default) so the speaker does not thump.
- NaNs and gaps play as silence, and the strip says how many there were.
- When the signal's fs differs from the audio context's, it is stated:
  `44 100 Hz → 48 000 Hz (resampled)`.
- Soft limiter on the output and a moderate starting volume: half a class listens on
  headphones.

### Sample-rate gate

Between ~3 kHz and 384 kHz the signal plays as it is and the browser resamples to its
context rate. Below that the button is disabled with the reason written out. The
accepted consequence is that a 2 kHz vibration signal cannot be heard until
sonification arrives (see "Not in v1").

## WAV export

A fourth format in the panel's existing export dialog (`src/ui/plot-export-dialog.js`),
beside Data (CSV), Image (PNG) and Vector (SVG). The dialog already models a format as
`{ id, label, hint, ext, disabled, blockedReason }` and already knows how to offer one
**disabled with its reason** — which is how it treats CSV in a panel with no table — so
a WAV that cannot be written uses that same mechanism. The audio options appear only
when WAV is selected, exactly as the 1×–4× quality appears only for PNG.

Two doors, one window: the panel's `⬇` opens the dialog as always, and a `⬇` in the
audio strip opens **the same dialog with WAV preselected** and its options filled in
from what is currently sounding, focus on the name field.

What it writes:

- **The signal's own sample rate**, not the browser context's. The file is the signal,
  not what came out of this machine's speakers.
- **16-bit PCM** by default, **32-bit float** as an option for re-analysis without
  clipping.
- The range, the source, the channel assignment and the gain are baked in — what you
  hear.
- Reverse is a checkbox, because reversing sample order is exact.
- Proposed name `voz__Left_filtered__1.204-3.051s.wav`, through the dialog's existing
  name sanitiser.
- Estimated size before saving. 16-bit stereo at 44.1 kHz is about 10.6 MB per minute.

Minor open point: the dialog remembers the last format used in a module-level
`remembered` object. Opening from the strip preselects WAV and therefore makes WAV the
remembered format for the panel's own `⬇` afterwards. That is consistent with how every
other choice in that dialog behaves, and a second export is more likely to be another
audio; it is a one-line decision if the opposite is preferred.

## Entry points

- `🔊` in the panel toolbar sends the visible curve to the player with the panel's
  current selection as its range.
- `▶` on hover over a variable in the tree, to listen without plotting first.
- In Data Tools → Filter, a third button beside *Create* and *Create and plot*:
  **Create and listen** — plots input and result in the same panel, opens the strip and
  leaves the filtered one as the source, with the other already in the dropdown.
- Save view (.json) and save project (.zip) restore source, range, channels, loop,
  reverse, gain and volume, so a class is prepared once and opens ready.
- With no playable signal open, nothing appears. The app without audio is the app of
  today.

## Performance and limits

- The buffer is built **from the range only**, never from a whole file's twenty-odd
  million samples, and in chunks when the range is long.
- Float64 → Float32 conversion happens once per range, when handing over to Web Audio.
- The audio context is created inside the user's click (browser autoplay policy).
- **Files in memory-saving mode (☘) do not play.** The button is disabled and explains
  why: only the ~10 000-point overview is in memory, so what would be played is not the
  recording. This matches how the exact data tools already behave.
- Identical in Light Web and Full Desktop — Web Audio exists in both, there is no
  desktop-only behaviour here.
- Closing the file, changing language or resetting the layout stops the sound and
  clears the player.

## Accessibility and i18n

- The whole strip is keyboard operable, with visible focus and `aria-label` on every
  control.
- All strings go in `src/i18n/translations.js`, in every language the app ships.
- The playhead animation respects `prefers-reduced-motion`.
- Its own help entry covering range, comparison, normalisation and the sample-rate gate.

## Keyboard

Active while the strip is open and focus is not in a text field.

| Key | Action |
|---|---|
| `Space` | Play / pause |
| `C` | Switch between the two most recent sources, keeping the position |
| `L` | Loop the range |
| `R` | Reverse |
| `←` `→` | ±1 s; with `Shift`, ±0.1 s |
| `0` | Back to the start of the range |
| `M` | Mute |
| `Esc` | Stop and close the strip |

## Not in v1

- **Playback speed** (0.25×–4×) and, inseparable from it, a second "heard frequency"
  axis on the FFT plus the audible band. It is the Fourier scaling property made
  audible — good teaching material, but a feature with a tail, not a loose control.
- **Sonification** of signals whose fs is outside the audible band. It forces the user
  to choose a playback rate *and* to decide what happens to content outside
  20 Hz – 20 kHz. Two new decisions, neither with a sensible default.
- **Spectrogram.** It deserves its own issue: it is a panel mode, not a player feature.
- Recording from the microphone.
- Filtering live through Web Audio instead of over the already-computed data.
- Mixing several signals at once (multitrack).

## Where the code would go

- `src/plots/methods/interaction-methods.js` — the `🔊` toolbar button, beside
  `_injectModeButtons`.
- A new `src/plots/methods/audio-methods.js` — the player singleton, the strip, the
  playhead.
- `src/plots/methods/fft-methods.js` and friends — reading, and in timeseries mode
  writing, the panel's `{ rangeFull, x1, x2 }`.
- `src/ui/plot-export-dialog.js` — the WAV format and its options block.
- A new `src/utils/wav-encode.js` — PCM 16 / float 32 writer.
- `src/app/methods/filter-methods.js` — the *Create and listen* button.
- `src/app/methods/session-methods.js` — persisting the listening state in views.
- `src/i18n/translations.js` — all strings.
