# File formats in detail

What the readers of the less common formats accept and how each file becomes
signals. The short list of formats is in the [README](../README.md#supported-files)
and in the [user manual](https://www.unditas.com/manual/#topic-formats); CSV has
pages of its own ([csv-loading.md](csv-loading.md),
[csv-robust-parsing.md](csv-robust-parsing.md)).

## Audio support

Recordings open as one signal per channel (`Mono`, or `Left`/`Right`) on a time
axis in elapsed seconds, built from the file's own sample rate. Accepted:
`.wav`, `.mp3`, `.m4a`, `.m4b`, `.mp4`, `.aac`, `.flac`, `.ogg`, `.oga`,
`.opus`, `.aif`, `.aiff`, `.aifc`, `.caf`, `.3gp`, `.3gpp`, `.amr`, `.webm`,
`.weba` — which covers phone voice memos (iPhone `.m4a`; Android `.m4a`,
`.3gp`, `.webm`) and WhatsApp voice messages, which download as an audio-only
`.mp4`. A `Recording` node in the variable tree carries the sample rate,
channel count, duration and format.

`.mp4` and `.m4a` are the same ISO base-media container under two names, so
nothing decodes differently between them; an `.mp4` that turns out to carry a
video track and no sound track is refused with a message that says exactly
that, instead of a generic decode failure.

WAV is decoded by `src/parsers/audio-decode.js` itself (PCM 8/16/24/32-bit,
32/64-bit float, and G.711 A-law/mu-law), so it works with no audio engine
present — including in Node, where `npm run test:audio` exercises it. Apple
Lossless (`.m4a` recorded with the Voice Memos "Lossless" quality setting) is
also decoded by the app's own code, `src/parsers/alac-decoder.js`, because no
browser except Safari ships an ALAC decoder; `npm run test:alac` verifies that
decode is bit-exact. Every other container is handed to the browser's own
`decodeAudioData`, on a context created at the sample rate read from the
container header so the samples come back at the file's rate rather than the
sound card's. This is the one format the app decodes on the main thread: Web
Audio does not exist inside a Worker.

Because a small file can decode into a very large one, the size limit for audio
is measured on the decoded samples rather than on the file, and is asked about
between decoding and building the columns (Settings → File loading → Audio
full-load limit).

## Micro-Cap support

Micro-Cap numeric output — the text files the simulator writes next to its
analyses (`.tno` for transient, `.ano` for AC, `.dno` for DC) — opens
directly, banner, `Limits`/`Stepping Options` prose and all. The same content
saved or renamed as `.txt`/`.out` is recognized by its asterisk banner and
routed to the same reader instead of the CSV path. The first table column
(`T`, `F`, ...) becomes the file's X axis with its printed unit; every other
column becomes a signal named as printed (`v(C1)`, `DB(V(2))`, `PD(R3)`) with
its unit shown in the tree and used for plot legends.

Parameter stepping is the interesting case: a stepped file repeats the
waveform table once per step combination. Each signal then becomes a group in
the variable tree holding one entry per run, labelled by the stepped values
that actually differ between runs (`C1=10u, V1=12`), so overlaying one signal
across all step values is a matter of picking leaves from one group. Runs
whose tables share the same printed time grid (the usual interpolated output)
line up exactly; `Actual Waveform Values` grids that differ per run are placed
on the union of their time points, with gaps where a run has no sample.
`npm run test:microcap` exercises the reader against the fixtures under
`test-files/microcap/`.

## netCDF support

The `.nc`, `.nc4`, `.netcdf` and `.cdf` loader reads netCDF3 (Classic,
64-bit offset and CDF-5) and netCDF4/HDF5. What a file is gets decided from its
bytes, not its name: a ZIP or a saved error page named `.nc` is reported as
what it is, with what to do about it.

**GRIB** (`.grib`, `.grb`, `.grib2`, `.grb2`, or a GRIB saved as `.nc`), the
format ERA5 is stored in and the one the Climate Data Store sends by default,
opens on the same map: GRIB1 and GRIB2 on regular latitude/longitude grids,
with simple, complex (with or without spatial differencing) or IEEE packing,
and bitmaps. It is read by parts too: the messages are listed from their
headers and a field is decoded when a map or a series needs it (a week of
hourly global ERA5 at 0.25°, 350 MB, opens in about 3 s). JPEG 2000, PNG and
CCSDS packing, spectral fields and Gaussian or rotated grids are named in the
error, with the command to convert them.

**Files of series** (stations, PyPSA networks) are read by parts in the parse
worker too: the file is never copied whole into memory, so a 600 MB station
archive opens in a few seconds. The netCDF limit in Settings → File loading
applies to what the file loads (the series it keeps), not to its size; above
it the app asks before loading.

**Gridded files** (ERA5, CMIP, regular lat/lon grids) open on a map, read by
parts in a worker, so their size is not limited by memory (a multi-GB ERA5
month opens in a couple of seconds). The map view has offline Natural Earth
coastlines, a time slider with playback, a level selector and palettes. Its
colour scale is fitted to the whole period and stays fixed while the time
moves, so colours compare across steps. One "Color range" button holds it all:
the two ends (typed by hand), the palette, and the fits (whole period, exact
period, current step, visible area; optional percentile clipping and centring
on zero), with the one in use marked in blue. On a desktop the map opens in a
tab of its own ("Map 1", or the empty tab on screen), so the plots of the other
tabs stay as they were; its variable and level open the side panel, and the
colour range, the download and Close map end the map's title line (on the
map's own tab, Close closes the tab, and the file's Map button blinks to show
where the map comes back from). The map opens in **Navigate** (a thin cross
with a small hand, its centre the point the inspector reads: drag or
right-drag to pan, wheel or pinch to zoom; on a trackpad, two fingers up or
down zoom and in any other direction pan; a click pins the cell under it);
an analysis panel next to it turns it into series:

- **Point**: click the map (or drag the orange ring, or type a latitude and
  longitude), then extract the time series of the nearest grid cell, or one
  interpolated bilinearly between the four cells around the point. A dotted
  outline under the ring shows the cells the value comes from (the edges of
  the nearest cell, or the square joining the four cell centres); extracted
  bilinear points are drawn as diamonds, nearest-cell points as circles.
- **Region**: draw a box or type its North/West/East/South limits (as in the
  Copernicus CDS form), adjust it on the map, then extract the area-weighted
  (cos latitude, or cell area when the file has latitude bounds) mean, minimum
  and maximum for every time step: three series. The box moves from inside and
  resizes from its edges.

Escape goes back to Navigate from Point or Region.

Large files are read by parts, never whole: a global hourly ERA5 month at
0.25° (1.7 GB) opens in about 2 s, and a point or region series over its 744
steps takes about 5 s on 4 cores, split along time between several workers.

On a **phone** the map takes the width of the screen (the colour bar under
it, upright) and is as tall as the grid needs; the time bar, the tools and the
extractions scroll under it. A finger pans and pinches the map, a tap places
the point, a finger draws or drags the box; once a point or a box is placed,
"Extract" floats over the map, and holding a point or a box opens its menu
(extract, reuse, remove).

An **inspector** in the panel reads the cell under the pointer: where
it is, its row and column in the grid, its value with units, and the step and
level on screen. "Copy" puts that reading on the clipboard as one line. A click
in Navigate pins the cell (its outline stays, and the inspector stays on it,
following the time step while Play runs); a right click pins it and opens a
menu with "Copy reading". A click on it again, or Escape, lets it go.

A "?" next to the tools explains how a point's value and a region's mean,
minimum and maximum are computed. Both tools read the level on the map, or any set of levels (all of them, say),
in one pass: one series per level. Each place gets a colour and a tag (P1,
R1…) shared by the map, the panel list and the preview, and is a folder of the
variable tree. "+ Another variable at P1", under the place's series (or in its
right-click menu), lights the Variable menu up: the variable (or level) picked
there next is read at P1, the same way P1 was read, and joins the same folder.
After an extraction the tree scrolls to "Extractions", opens it, and the folder
and the new series blink together. A click on a point or a box's edge selects it (and its
row, and the other way round); a right click (without dragging) opens a menu
to extract or remove it, Delete removes the selected one, and the trash icon empties the list.

Extractions become variables of the file in the explorer, named by the
quantity ("2 metre temperature (t2m) · 45°N 90°E"), where FFT, integrals,
heatmaps and cursors work on them. "Plot selected in new tab" plots the checked
ones in a new tab at the end, named after the places ("P1, R1"; "P1-1" when
that name is taken), and moves to it; the map keeps its own tab, and comes
back with it. On a phone the series are plotted in the panels, the map closing,
with "Back to the map" over them.
In the preview under the map, curves that do not share a unit do not share an
axis either: the first unit keeps the left axis and the others go to a second
one on the right, each axis titled with the units it carries.
Units show their powers as superscripts ("m s**-1" → m s⁻¹). The map and the extractions export through
the same dialog as the plot panels (CSV, PNG, SVG). The ZIP the Copernicus CDS sends for mixed instantaneous/accumulated
requests is listed and can be opened as one dataset, and several files with
the same grid (consecutive months) can be joined in time. CF calendars
`noleap`, `all_leap`, `360_day` and `julian` are decoded.

A saved **project** keeps the map whole: every file the dataset was opened from
(a CDS ZIP read as one dataset, or months joined in time, keep all of theirs)
and the way they were joined, the places extracted on it with their series and
their values, what the map was showing (variable, level and step, palette,
colour range, zoom, and whether the list of series was folded away) and the
panels that plotted those series. Opening the project puts all of it back, with
the same names in the variable tree; a view session (JSON) does the same over
the file opened again.

**Series files** (station data, ARM, PyPSA) keep the series explorer: CF time
coordinates, units, scale and offset packing, missing values, groups and
dimension scales are normalized into plottable series, one shared X coordinate
per file.

Design, diagnosis and roadmap:
[`docs/netcdf-gridded-viewer-spec.md`](netcdf-gridded-viewer-spec.md).
