# Mobile MINI Viewer Design

Status: requirements agreed, not implemented. Nothing here is built yet.

## Goal

Someone who opens the app from a phone must find something that reads as a finished,
if small, product. The reason is not that phones are a target platform for analysis —
they are not — but that a broken-looking first impression on a phone costs the visit
on a large monitor that would have followed. This document specifies a separate,
deliberately tiny mobile entry point (MINI) and records why the alternatives were
rejected, so the analysis does not have to be redone when the work starts.

## Scope, as a criterion rather than a list

A feature list invites negotiation over each item. The line is drawn once:

- **In** — anything that is *looking*: opening a file, choosing and removing signals,
  panning and zooming the curve, the legend, autoscale.
- **Out** — anything that produces *a new number*: cursors, measurements, FFT,
  statistics, histograms, correlations, integrals, export.

FFT is the explicit test case. Its engine is standalone (`src/utils/fft.js`, no
imports at all) so it is cheap to add, and being cheap is exactly the trap. It stays
out. If the criterion ever has to be argued about, the answer is out.

The whole product surface is three screens: open a file, pick signals, see the curve.

## Non-goals

- No analysis modes of any kind.
- No adaptation of the desktop UI. MINI does not reuse `src/plots` or `src/app`.
- No per-format code in MINI (see "generic over the engine" below).
- Tablets are out of scope here. They have room for the desktop layout and are a
  separate question — currently unverified, see "Open questions".

## What already exists and can be reused for free

This is what makes a separate mobile UI cheap in this codebase rather than the usual
maintenance trap. Measured on `8d6d6f9`:

| | lines | notes |
|---|---|---|
| Reusable engine | 17,570 | `src/parsers` 8,569 + `src/compute` 3,348 + `src/data` 5,653 |
| Desktop UI | 44,004 | `src/plots` 22,886 + `src/app` 16,740 + `src/ui` 4,378 |

**All 16 parsers import zero UI modules.** So does the FFT engine. The build already
code-splits them: `csv-parser`, `netcdf-parser` and `pickle-parser` ship as their own
~40 KB chunks, and DuckDB, HDF5 and xlsx are deferred until a file needs them.

MINI therefore duplicates none of the expensive part. It imports it. The usual reason
separate mobile sites rot — duplicated domain logic drifting apart — does not apply.

## Entry payload

What a phone downloads today before anything is on screen:

```
index.js    6.15 MB raw  ->  1.83 MB gzip  ->  1.35 MB brotli
index.css   0.15 MB      ->  0.02 MB

of which Plotly:  4.62 MB raw / 1.40 MB gzip  ~= 75% of the entry payload
```

1.35 MB is not catastrophic, and this should not be oversold as the reason for MINI.
But three quarters of it is the full charting library, carrying forty-odd chart types
MINI would never draw. With a basic Plotly bundle (scatter only) and none of the
desktop UI, MINI should land near 0.4–0.5 MB. A real improvement of roughly 3x, not a
transformation.

## The two rules MINI must not break

**Generic over the engine.** MINI renders whatever variables the parser returns. The
first `if (format === 'netcdf')` inside MINI is the moment it starts to rot, because
from then on every new parser is double work. The engine already returns a uniform
shape; MINI must consume only that.

**Stricter memory limits than desktop, not looser.** A phone has far less RAM than the
laptop the desktop limits were tuned for. The engine already carries the machinery
(`src/app/file-size-limits.js`, the DuckDB deferred view mode) and MINI must inherit
it with lower thresholds. What MINI does when a file is too large is a design decision,
not an implementation detail: say so before attempting it and offer the desktop link
there, because a tab that dies is precisely the first impression this whole document
exists to prevent.

## Routing and the notice

Phones get MINI, selected by screen size — never by user-agent sniffing, which is
fragile and strands people who want the full app. A visible link to the desktop
version is always available, and the choice is remembered so the notice does not
reappear on every visit.

The notice must be dismissible, and its tone matters more than its accuracy. The
rejected wording was *"a very small screen was detected to show the full version"*:
precise, but it reads as an apology and blames the reader's device. Someone whose
first sentence is "we cannot show you the good one" has already decided the product
is limited.

Say instead what exists on the other side. Something in the spirit of:

> **Quick viewer for your phone** — open a file and look at the curves. The full
> analysis suite (FFT, histograms, correlations, integrals) is on the desktop version.

Same information, but naming what is elsewhere leaves the reader thinking the product
is *bigger* than what they are seeing, which is the outcome this document is for.

The desktop link must warn that the desktop version is not adapted to this screen, and
land the user in the fallback described next.

## The desktop fallback, and the branch that already implements it

`claude/landscape-touch-gestures-90d3fe` (pushed, unmerged, two commits) lays the whole
app out on a fixed 1152px virtual stage and scales it to the screen, with a two-finger
pinch to zoom the app like an image and finger gestures on the charts. It was built as
the *primary* phone experience. It is not. It is the **fallback** reached from MINI's
desktop link, and in that role its weaknesses stop mattering: nobody expects comfort
there, and the pinch is the point.

**Remove the quarter-turn rotation before reusing it.** The rotation existed to make
the app as large as possible when this was the primary experience. As a fallback it is
not needed, and it is the sole cause of a family of problems:

- Dialogs are appended to `<body>`, outside the stage, so they do not rotate with the
  app. Measured: stage at rotation 90 and scale 0.637, overlay at `[0, 0, 402, 734]`
  with `transform: none`. The app reads sideways and the dialog reads upright.
- With iOS rotation lock on, it forces the reader to physically turn the phone.
- It is what introduces a second coordinate system — the axis swap that the plot
  gestures, the top-bar slide and the popover positioning all have to undo.

Without it the stage collapses to one idea: scale to fit, pinch to read. Portrait
renders at 0.35 instead of 0.64 — smaller, but the premise of the fallback is that you
will pinch anyway. A reader who unlocks rotation and turns the phone gets 0.76 from the
browser, with no code involved.

## Why scaling the desktop was rejected as the primary experience

It preserves everything — the same layout, so nothing can be misaligned, and every
feature stays reachable. But text renders around 9 CSS px. It can be looked at; it
cannot be worked in. It reads as a desktop application squeezed into a phone: honest,
not inviting.

The stronger signal was that every problem found while building it was second-order
from the same cause: `vw` units measuring the phone instead of the 1152px layout,
narrow-screen media queries firing over a layout with room to spare, dialogs outside
the coordinate system, rotation the dialogs do not follow. None were isolated bugs.
All came from two coordinate systems coexisting, which usually means the approach is
fighting the browser rather than using it.

Note also that the project already had a mobile strategy before this: the
`@media (max-width: 768px)` block in `overlays.css` turns the sidebar into an overlay
drawer. The stage had to disable it (`html:not(.phone-stage)`) to work. Two strategies
were in the codebase at once.

## iOS traps found the hard way

All four were discovered on a real iPhone after the emulator showed nothing wrong.
Firefox's responsive mode (F12, Ctrl+Shift+M) faithfully reproduces viewport size,
DPR, media queries and touch events — it is the right tool for layout questions such
as the tablet one — and reproduces none of these:

1. **Safari's toolbars overlay the page** instead of shrinking it, so `innerHeight`
   counts space behind the bar. Measure `visualViewport` instead, and take the smaller
   of the two. A keyboard also shrinks the visual viewport, by much more; ignore drops
   below ~60% of the window or the app is re-fitted into the strip above the keyboard.
2. **Safari has a per-site page zoom** that changes the layout viewport. A real iPhone
   reported `innerWidth 814` on a 402 px screen. `screen.width/height` is immune and
   reported 402x874 correctly — phone detection should use it. The current detection in
   the pushed branch uses `innerWidth` and is defeated by this.
3. **iPhone Safari has no element fullscreen at all** (iPad does). A fullscreen button
   is dead there, and being the only visible control it reads as the app being broken.
4. **Orientation cannot be locked** on iOS. `screen.orientation.lock` is Android and
   fullscreen only.

The only way to reclaim the toolbar's space on iOS is Add to Home Screen, which the
`apple-mobile-web-app-capable` meta enables. Standalone landscape gained about 29% of
stage height on the test device.

## Packaging

A second entry point is a Vite multi-page build: one `rollupOptions.input` entry and a
second HTML file. Same repository, same branch, same deploy. No second project.

## Open questions

- **Large files on a phone.** What thresholds, and what MINI says when they are
  exceeded. Must be decided before implementation, not during.
- **Remembering the version choice.** Where it is stored and how the user reverses it.
- **Tablets.** The pushed branch treats a short edge over 560 CSS px as "not a phone",
  so tablets get the desktop layout untouched. An iPad's 744–834 px short edge suggests
  that is right, but it was assumed, not measured. Verifiable in Firefox's responsive
  mode without a device.

## Settled, do not re-litigate

- The scope criterion above, and FFT being outside it.
- MINI stays generic over the engine.
- The notice names what is on desktop rather than apologising for the screen.
- Screen size decides routing, never the user agent.
- Scaling the desktop app is the fallback, not the primary phone experience.
