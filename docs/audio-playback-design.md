# Audio Playback Design

Status: phase 1 is built (the player and the panel's transport strip, issue #89),
and it is where the feature stops, with its two follow-ups built too: All | Visible
window (#375) and WAV export (#92). Where use has
corrected the specification, this document says what was changed and why rather than
quietly reading as if it had always said so.

## What was built, what is next, what was dropped

Decided 2026-11-15. This is a time-series explorer with a player in it, not an audio
tool, and phase 1 already does what #86 asked for: play a recording, pick the original
or the filtered trace as the source, loop or once, over the analysis selection.

- **Built — phase 1 (#89):** the player, the panel's transport strip, the phone's Sound
  section.
- **Built — #375:** in timeseries mode the strip offers **All | Visible window**, the
  panel's current x range. See "The range" below for why this replaces the panel-level
  selection, and "Visible window" for how it behaves. With it, a file in memory-saving
  mode (☘) plays: the range is read from the file (see "Performance and limits").
- **Built — #92:** WAV export, as specified under "WAV export", without reverse.
- **Dropped — phase 2 (#90), the panel-level selection.** Lifting `{ rangeFull, x1, x2 }`
  out of the analyses touches all nine of them, the restore of old sessions and
  Cancel's restore of an analysis' settings — all to give the strip a range in
  timeseries mode, which #375 gives for almost nothing.
- **Dropped — phase 3 (#91):** stereo routing (`🎧`), reverse, the `C` key.
- **Dropped — phase 5 (#93):** the tree `▶`, *Create and listen*, the keyboard map,
  persisting the listening state in views.

The sections below still describe the dropped parts, marked as such, so that the
reasoning is at hand if one of them is ever wanted after all.

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
| file in memory-saving mode (☘) | yes, since #375 | the range is read from the file, every row of it, not from the overview (see "Performance and limits") |
| a formula over a ☘ file with no SQL form | no | it exists only over the overview; there is no column to read |

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

### On a phone

The phone layout (docs/phone-web-specification.md) hides the panel toolbar, so the
🔊 button becomes a **Sound** switch in the Plot sheet. It opens the same strip
under the plot and puts the sheet away; where nothing can be heard it is disabled
and the tooltip's reason is written under it. `compact.css` lays the strip out in
three rows at a finger's size (transport, time and mute; the seek bar across the
screen; the signal, Remove DC and ⬇, the WAV export) and hides the volume slider, which the phone's
own buttons replace; the rows wrap, so a long signal name cannot push the buttons
over each other. Tap-to-seek works as the click does, and never from a tap on a
button over the plot (`AUDIO_SEEK_IGNORED`: the phone's Fit buttons moved the
playhead). On an iPhone, Web Audio is "ambient" sound that the silent switch mutes,
so the page declares itself a player (`navigator.audioSession.type = 'playback'`,
Safari 17+) and, on iOS WebKit (Safari, and Chrome on an iPhone, which is WebKit
too), plays a silent looping `<audio>` while the strip sounds — the platform's
way into media playback where that API is missing or not passed on
(`keepIosMediaSession`); the context is resumed from any state but running (Safari's
"interrupted" included) with a silent sample started in the tap; and a context
the browser still holds back — its clock, and so the playhead, standing still — is
said in the strip after a second ("tap ▶ again"), and that tap retries. The strip watches its own
height (`_heightObserver`), so the chart gives it room when its note line appears —
which also fixed the desktop strip covering the chart's x axis when a note came.
Tested by `npm run e2e:compact-audio`.

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

> **Dropped (#90).** What is built: in an analysis mode the analysis selection plays,
> exactly as described below. In timeseries mode the strip offers **All | Visible
> window** (#375, "Visible window" below) instead of carrying a selection of its own.
> That is still two states, never three, so the rule that withdrew the cascade at the
> end of this section holds: the visible window is no longer one level among four, it
> is the only alternative to everything, and only where no analysis selection exists.

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

### Visible window (#375, built)

In timeseries mode the strip carries two joined buttons, **All | Visible window**
(`.audio-window`, after Loop), All first. On a phone the same choice is in the Plot
sheet's Sound section, under the switch, and not in the strip. It belongs to the panel's
listening state (`plot.audio.window`), like loop and volume. In an analysis mode the
buttons are hidden and the analysis selection plays; back in timeseries mode the choice
is as it was left.

- **What sounds:** the plot's x range (`_fullLayout.xaxis.range`) clamped to the signal.
  The rows are those whose time t has lo ≤ t ≤ hi, both ends included — the rule a lazy
  file's rows are read by, so a range holds the same samples either way. A window panned
  off the signal holds nothing of it and says so; it does not fall back to the whole
  record.
- **The readout** gives the length of what is playing, as for a selection.
- **Zoom or pan while it plays** never cuts the sound. Looping, the new window is built
  (read from the file, on a lazy one) and scheduled on the audio clock to start exactly
  where the current turn of the loop ends; the old take is told to stop at that same
  instant, and the edge fades of the two buffers meet there as on any turn of the loop
  (`_audioPrepareSeam`, `_audioScheduleSeam`). Playing once, the take runs out as it was
  and the next play is the new window. A zoom back to where it was before the seam drops
  the waiting window. The change is noticed by the same poll that follows a moved
  analysis bound (`_followAudioSourceChange`), after the zoom has held still for 250 ms.
  A moved analysis bound, a recomputed signal, another source or Remove DC still follow
  at once, keeping the instant, as before.
- **Paused**, the strip measures against the window it would play now: the readout's
  length and a click on the plot follow the zoom, and the instant is kept where the new
  window still holds it (`_audioSettleIdleRange`). The last buffer is kept aside, so
  zooming back plays without building it again.
- **Limits**, the same as for any range, said before Play is pressed: shorter than
  50 ms ("zoom out") or more than `MAX_BUFFER_SAMPLES` samples ("zoom in").

Tested by `scripts/test-audio-player.mjs` (the range, the clamp, the seam scheduled on a
stand-in audio clock, the next play without loop, a zoom back) and
`scripts/e2e-audio-window.mjs` (Chromium: the buttons, the window played, a pan while
looping heard at the seam, without loop at the next play, the 50 ms note, the buttons
gone in Fourier mode, a lazy file's window read from the file); the phone's sheet by
`npm run e2e:compact-audio`.

## Output: what sounds, and where

`plot.traces` already holds `{ varName, color, fileId, axis }` per trace, which is
exactly the list the strip needs.

- A **Fuente** selector lists the panel's visible traces by name, each with the colour
  swatch it has in the legend.
- **Mono by default**: the source plays through both speakers. Nothing about stereo
  has to be decided in order to listen to a curve.
- **Stereo is opt-in** *(dropped, #91)*: a `🎧` button reveals two small selectors, left and right, each
  with the same list plus "—" (silence). It fills itself in when the two visible traces
  are `Left` and `Right` of the same file — the parser marks the channel in
  `variable.audio.channelIndex`.
- Putting two different signals in the two ears is didactic for hearing *what changed*,
  but the ear localises, and that biases any judgement of "which sounds better". The
  help says so; for judging, alternate instead.

### Comparison is switching the source

*(The `C` key is dropped with #91; switching through the dropdown is what exists.)*

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
  click — at 44.1 kHz that is 2 205 samples, ten times the 5 ms fade at each end. (The
  code first refused below 10 ms; it was brought to this specification with #375.)

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
  comparator (phase 3, dropped) and would have to be a deliberate choice there.
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

> **Built (#92).** As specified below, without reverse; "As built" at the end of this
> section records the decisions the specification left open.

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
- ~~Reverse is a checkbox, because reversing sample order is exact.~~ Dropped with #91.
- Stereo in the file is only a channel layout: one playable trace per channel,
  pre-filled with `Left` / `Right` of the same recording.
- On a file in memory-saving mode (☘) the export writes **every row of the range**,
  streamed and encoded chunk by chunk, never the overview — CLAUDE.md's rule for
  anything that reads a signal's values — with progress, Cancel and a parity test.
- Proposed name `voz__Left_filtered__1.204-3.051s.wav`, through the dialog's existing
  name sanitiser.
- Estimated size before saving. 16-bit stereo at 44.1 kHz is about 10.6 MB per minute.

Minor open point: the dialog remembers the last format used in a module-level
`remembered` object. Opening from the strip preselects WAV and therefore makes WAV the
remembered format for the panel's own `⬇` afterwards. That is consistent with how every
other choice in that dialog behaves, and a second export is more likely to be another
audio; it is a one-line decision if the opposite is preferred. *(Built that way. Where
WAV is then disabled — a panel with nothing to hear — the dialog opens on the first
format it can offer instead.)*

### As built

- **Code:** the format and its options block in `src/ui/plot-export-dialog.js` (the
  dialog stays pure DOM: it is handed the playable traces, the range in words, and two
  functions, the estimate and the proposed name); the plan, the estimate, the name and
  the writer in `src/plots/methods/audio-wav-methods.js`; the routing, the overlay and
  the save in `src/plots/methods/export-methods.js`; the writer in
  `src/utils/wav-encode.js`; the strip's `⬇` (`.audio-export`, last in its row; on a
  phone at the end of the signal's row).
- **The options:** Mono | Stereo; for mono the signal that sounds, for stereo a signal
  per channel, pre-filled with `Left` / `Right` of one recording when both are in the
  panel (`variable.audio.channelIndex`), otherwise with the signal that sounds and the
  next one of its file. Mono is the default, because it is what the strip plays. Then
  16-bit PCM | 32-bit float (the last one used is remembered), the range in words
  (*the whole record*, *the visible window* or *the analysis selection*, with its
  bounds), and the estimate: size, rate, channels and length.
- **What it writes** is the strip's own kernel (`src/utils/audio-samples.js`): the
  range's rows (lo ≤ t ≤ hi), each channel minus its mean when Remove DC is on, one gain
  for all channels that puts the largest peak at −1 dBFS — a stereo file keeps the
  balance between its channels, where the strip normalises the one signal it plays —
  missing samples as silence, and the 5 ms fade at each end that the strip plays. The
  16-bit samples are those 32-bit samples times 32 767, rounded, so −1 and 1 are
  symmetric; the float file holds them as they are. The header's rate is the signal's,
  rounded to a whole hertz (a rate read from a time vector is 44 099.999 999 7).
  Float files carry the extended `fmt ` chunk and the `fact` chunk a non-PCM WAV is
  meant to have. The app's own WAV reader reads both back (`scripts/test-wav-encode.mjs`).
- **Disabled, with why:** in a panel with nothing that can be heard (the strip's own
  reasons, naming the signal), in a mode with no 🔊, for two channels from two files
  (they would not share a time axis), for a range under 50 ms and for a file past
  4 GB (a RIFF size is 32-bit).
- **How it is written:** two passes over the rows of the range (`_audioVisitRange`):
  the first counts them and finds each mean and the peak, the second writes each chunk
  as an `ArrayBuffer` part of a `Blob`, behind a header that already knows the frame
  count. There is no buffer limit here, unlike playback: a range too long to play can
  still be written. A long export — a lazy file, or two million samples or more — shows
  the busy overlay with the samples read and written, and its Cancel aborts the work
  (and the read of the file); nothing is saved then.
- **On a file in memory-saving mode** both passes stream the rows from the file, so the
  file is not bound by memory and is byte for byte the file the same rows give in
  memory (`scripts/test-lazy-audio.mjs`; `scripts/e2e-wav-export.mjs` checks a lazy
  window, written from the browser, against the CSV's own rows). If the file changes
  between the two passes (a live update) the export stops and says so.

## Entry points

*(Only the `🔊` button is built. The rest of this list was phase 5 and is dropped, #93.)*

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
- **Files in memory-saving mode (☘) play from the file** (since #375; before, the button
  was disabled, since only the overview is in memory). The range that sounds is read
  from the file, every row of it (`_audioLazyRangeSamples` in
  `src/plots/methods/audio-lazy-methods.js`), and goes through the same kernel as a
  signal in memory (`src/utils/audio-samples.js`: one pass that sums, finds the extremes
  and checks the steps, one that writes the samples), so it sounds the same, sample for
  sample (`scripts/test-lazy-audio.mjs`). The strip shows how many samples it has read,
  with a Cancel; Stop, Pause, another range or another panel playing abort the read. The
  gate is read without reading the file: a column the file query can give, a time axis
  in seconds, and the rate of the file's rows over its span. Whether every step is the
  same cannot be told from the overview, so it is checked on the rows of the range when
  they are read: a range across a gap is refused then (in memory the whole signal is
  refused upfront, so a lazy file can play a stretch that does not reach its gap). The
  limit is the buffer's, as in memory. Recorded in `docs/any-size-files.md`.
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

*(Dropped with #93; the strip is operated with its buttons.)*

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
  playhead; the range (All | Visible window in timeseries mode, #375).
- `src/utils/audio-samples.js` (built) — the kernel that turns the rows of a range into
  samples, in passes that accumulate chunk by chunk.
- `src/plots/methods/audio-lazy-methods.js` (built) — the rows of a range wherever the
  file is held, and a lazy file's range read from the file.
- `src/plots/methods/fft-methods.js` and friends — reading, and in timeseries mode
  writing, the panel's `{ rangeFull, x1, x2 }`.
- `src/ui/plot-export-dialog.js` — the WAV format and its options block (built, #92).
- A new `src/utils/wav-encode.js` — PCM 16 / float 32 writer (built, chunked).
- `src/plots/methods/audio-wav-methods.js` (built) — what the dialog offers for WAV,
  its estimate and name, and the two-pass writer.
- `src/app/methods/filter-methods.js` — the *Create and listen* button.
- `src/app/methods/session-methods.js` — persisting the listening state in views.
- `src/i18n/translations.js` — all strings.
