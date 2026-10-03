# Portable Phone Application Specification

Status: product requirements; not implemented.

This document defines the phone experience for Time Series Explorer. It supersedes
the product-scope decisions in `docs/mobile-mini-viewer-design.md` wherever the two
documents conflict. The earlier document remains useful implementation research,
especially its findings about iOS viewports, memory limits, touch handling, and
avoiding user-agent detection.

## 1. Product vision

Time Series Explorer on a phone is a fast, local viewer for measurement and
simulation files. A user should be able to open a supported file from the operating
system, select signals, inspect the plot, and return to the file in a few seconds.

The plot is the primary screen. Controls are available when needed and disappear
completely when the user returns to the plot. Small screens must never show stacked,
overlapping, or compressed desktop menus.

The installed application should be offered as an application for supported files
and, where the operating system permits it, may be selected as the user's default
handler. Files remain on the device and are not uploaded for parsing or plotting.

## 2. Success criteria

The phone version is successful when all of the following are true:

1. A supported local file can launch the application from the system file manager,
   mail client, chat application, cloud-drive client, or in-app file picker.
2. The user can reach a readable time-series plot without learning a desktop layout.
3. The plot uses the full available screen while menus are closed.
4. Menus never overlap each other or leave an unusably small plot between them.
5. Portrait and landscape orientations both work, and rotating the device preserves
   the loaded files, selected signals, active plot, zoom range, and open workflow.
6. Touch gestures for menus are predictable and do not steal ordinary pan, zoom, or
   cursor gestures from the plot.
7. Opening and viewing a file works offline after the application and required format
   components have been installed.
8. Unsupported, damaged, or excessively large files fail with a useful message and
   do not leave the application in a broken state.

## 3. Product form and platform behavior

The target product is an installable phone application that reuses the current local
parsers and plotting engine. A browser/PWA version may provide the same compact
interface, but browser support alone is not sufficient for the operating-system file
integration required here.

The first supported platform targets are Android and iOS:

- **Android:** register supported MIME types and file extensions for system open and
  share intents. Android may allow the user to choose Time Series Explorer as the
  default handler for a file type. The app must accept `content://` URIs without
  requiring broad storage permission.
- **iOS:** declare supported document types and accept files through Open In, the
  document picker, and the share sheet. iOS does not provide a general user-selectable
  default application for arbitrary data-file types; the product must describe this
  as **Open with Time Series Explorer**, not promise a system default that iOS cannot
  provide.
- **Web/PWA fallback:** use the installed web-app file-handling path where supported.
  Otherwise, present the normal file picker. The compact interface and file contents
  must behave consistently with the installed application.

Platform packaging technology is an implementation decision. It must preserve the
existing rule that parsing and plotting happen locally and must not require a server
to translate user files.

## 4. Supported input

The phone application must consume the same normalized parser output as the existing
application. It must not create phone-specific versions of individual parsers.

The initial file-open integration covers formats already supported by the project:

- delimited and measurement text: `.csv`, `.txt`, `.text`, `.tsv`, `.tab`, `.dat`,
  `.asc`, `.prn`, `.log`, and `.out`;
- MATLAB, OpenModelica, and Dymola result files: `.mat`;
- spreadsheets: `.xlsx`, `.xlsm`, `.xlsb`, `.xls`, and `.ods`;
- columnar data: `.parquet`;
- netCDF and HDF5-family data: `.nc`, `.netcdf`, `.cdf`, `.h5`, and `.hdf5`;
- pandas pickle files supported by the existing safe reader: `.pkl` and `.pickle`;
- Micro-Cap numeric output: `.tno`, `.ano`, and `.dno`;
- audio formats currently recognized by the application, including WAV, MP3, M4A,
  AAC, FLAC, Ogg/Opus, AIFF, CAF, 3GP, AMR, WebM, and audio-only MP4.

Unknown text-like extensions may still be offered to the existing content sniffer.
Registering an extension with the operating system must not imply that every possible
file using that extension is valid. The existing parser remains authoritative.

## 5. Primary user journey

### 5.1 Launch with a file

1. The operating system passes one or more files to Time Series Explorer.
2. The application immediately shows the file name and a determinate progress value
   when progress can be measured. Parsing must be cancellable.
3. A successful parse opens the signal-selection drawer. If the format has one clear
   plottable signal, the application may select it automatically but must still make
   that choice visible.
4. The user selects signals and activates **View plot**.
5. The drawer closes and the plot occupies the available viewport.

If the application is already running, a newly opened file joins the current session.
It must not silently replace or discard files already loaded.

### 5.2 Launch without a file

The empty state presents one primary action, **Open file**, plus a short list of recent
file names when the platform can safely retain access. A recent item that can no longer
be read must request access again rather than failing silently.

### 5.3 Return to controls

From the plot, the user can:

- swipe inward from the left edge or use a visible button to open files and signals;
- swipe inward from the right edge or use a visible button to open plot actions,
  analysis tools, and settings;
- close an open drawer by swiping it toward its source edge, pressing its close or
  done control, tapping the system Back action where applicable, or using Escape with
  an attached keyboard.

Every essential action must have a visible control. Edge gestures are accelerators,
not the only way to operate the application.

## 6. Compact-screen layout

### 6.1 Layout regions

The compact interface has three mutually exclusive regions:

1. **Plot workspace:** the default region and the only region visible while viewing.
2. **Left drawer:** files, sheets or datasets, variables, and signal selection.
3. **Right drawer:** plot mode, plot actions, analysis tools, export, help, and
   settings.

A drawer occupies the complete usable viewport, including its own header and scroll
area. It respects safe-area insets and browser or operating-system bars. Opening one
drawer closes the other before the new drawer enters. The plot may remain mounted
behind the drawer to preserve state, but it is not interactive or exposed to assistive
technology while covered.

Dialogs launched from a drawer replace that drawer's content or appear as a single
full-screen dialog. A dialog, drawer, popover, and menu must never form multiple
interactive layers on a phone.

### 6.2 Plot workspace

With drawers closed, the plot receives all space except a compact application bar.
The bar contains only:

- the left-drawer button;
- the current file or view title, truncated without covering controls;
- the right-drawer button;
- a visible loading or error indicator when required.

Plot controls that are used continuously may appear as a compact overlay or toolbar,
provided they do not cover axis labels, legends, or data. Overflow actions belong in
the right drawer. No control row may cause horizontal page scrolling.

Phone mode shows one active plot workspace at a time. If the current session contains
multiple plots, the user switches between them with an explicit plot selector or a
documented page gesture; the desktop split-panel grid is not squeezed into the phone
viewport.

### 6.3 Compact-mode selection

Compact mode is selected from available layout space and input capabilities, never
from a user-agent string. It must activate whenever the desktop layout cannot provide
a usable plot and controls without overlap. Users must also be able to select compact
mode manually on larger touch devices and return to the full layout where supported.

The breakpoint is an implementation value validated by the acceptance matrix below;
it is not a product definition of what counts as a phone.

## 7. Orientation and viewport changes

Portrait and landscape are equal supported states. The application must not require,
force, or simulate a particular orientation.

On rotation or viewport resize:

- the active plot resizes to the new usable viewport;
- axis ranges, selected signals, cursor positions, plot mode, and active file remain
  unchanged;
- an open drawer remains on the same logical screen and is reflowed, not dismissed;
- scroll position within a variable list is retained where practical;
- safe areas, display cutouts, and dynamic browser bars are recalculated;
- an on-screen keyboard changes the available content area without causing the whole
  application to scale down.

On iOS, layout must use the visual viewport and safe-area insets where appropriate.
It must not rely on element fullscreen or orientation lock, because those capabilities
are unavailable or restricted on iPhone.

## 8. Touch and gesture rules

Gesture ownership is decided at touch start and remains stable until all participating
touches end.

- A one-finger drag beginning inside a narrow left or right edge activation zone may
  open the corresponding drawer.
- A one-finger drag beginning on the plot belongs to the plot, even if the finger later
  reaches an edge.
- A two-finger gesture on the plot belongs to plot zoom or other existing plot
  interaction and never opens a drawer.
- An open drawer owns vertical scrolling inside its content. A predominantly
  horizontal gesture toward its source edge may close it.
- Native system edge gestures take precedence. The interface must remain fully usable
  with buttons when the operating system reserves an edge.
- Gesture thresholds must reject taps and normal finger jitter, and must not trigger a
  drawer from vertical list scrolling.

The plot must support the existing touch behaviors appropriate to its mode, including
pan, pinch zoom, tap selection, cursors, and 3D interaction. Controls must explain any
mode that changes what a one-finger drag does.

## 9. Menus and workflows

Menu content is organized by task rather than copying desktop geometry:

- **Files and signals:** open, loaded files, sheets or datasets, variable search,
  variable tree, selection, and remove file.
- **Plot:** active plot selector, plot type, axes, legend, autoscale, and display
  options.
- **Analyze:** analysis tools supported by the current application. Long-running work
  shows progress and can be cancelled.
- **Export and share:** available data and image exports, using the operating system's
  share or save destination where possible.
- **Settings and help:** preferences, file-loading limits, language, theme, help,
  feedback, and application information.

Navigating into a submenu uses a full-screen child page with a title and Back action.
Returning restores the parent page's scroll position and draft selections. Applying a
setting must not unexpectedly close the complete workflow unless the action explicitly
says **Done**, **Apply**, or **View plot**.

## 10. File-association behavior

### 10.1 Incoming files

The application accepts files from:

- an operating-system Open or Open with action;
- a share intent or share sheet;
- the system document picker;
- the application's own Open file action;
- a compatible installed PWA file-handling launch.

Incoming files are copied only when required for reliable access. Temporary copies are
removed according to an explicit cache policy. The source file is treated as read-only;
the viewer never modifies it in place.

If several files arrive together, they are queued and each result is reported. One bad
file does not cancel successful files unless the user cancels the whole batch.

### 10.2 Default-handler objective

On Android, acceptance means that supported files list Time Series Explorer in the
system chooser and can launch directly after the user selects **Always** when Android
offers that choice.

On iOS, acceptance means that supported files can be sent to Time Series Explorer from
the document interaction and share interfaces. The application must not claim to be an
iOS default handler when the operating system offers no such setting.

On the web, acceptance means that a compatible installed PWA receives supported files
through the browser's file-handling API. Other browsers use the in-app picker.

## 11. Local processing, privacy, and security

- File contents are parsed and plotted locally.
- Opening a file never uploads it or its metadata automatically.
- Analytics, feedback, links, and update checks must not include file names, paths,
  signal names, values, screenshots, or derived results without an explicit user
  action and preview.
- Network loss must not prevent opening formats whose required parser components are
  already installed.
- File names and recent-file references are stored only as needed for the documented
  recent-files feature and can be cleared from settings.
- Malformed input is handled as untrusted data. Parsing limits, safe pickle behavior,
  and existing content sniffing remain in force.
- Export never overwrites the source file without a separate, explicit confirmation
  from the operating system and the user.

## 12. Performance and resource behavior

The UI shell should become interactive within two seconds on the agreed reference
mid-range phone after a warm launch. Every tap must show visual feedback within 100 ms.
Drawer and orientation transitions should remain visually smooth and avoid work that
reparses files or redraws every hidden plot during each animation frame.

Phone-specific file-size and decoded-memory limits must be lower than desktop limits
and based on available resources where the platform exposes them. Before starting a
load likely to exceed the safe limit, the application must explain the risk and offer
cancel, a supported reduced or deferred-loading mode, or guidance to use the desktop
edition. It must never intentionally continue until the operating system kills the
application.

Backgrounding and resuming should preserve the active session while the process
remains available. If the operating system terminates the process, the next launch
restores safe preferences and recent-file references, then requests file access again
when required; it must not pretend that in-memory plot data survived.

## 13. Accessibility

- Interactive targets are at least 44 by 44 CSS pixels, with spacing that avoids
  accidental activation.
- Text and essential controls meet WCAG 2.2 AA contrast requirements in every theme.
- Dynamic type or browser text scaling up to 200% does not hide essential actions or
  introduce overlapping controls.
- Drawers and dialogs expose correct names, roles, states, and navigation order.
- Opening a drawer moves focus into it; closing returns focus to its opener.
- Screen readers do not traverse the covered plot while a full-screen drawer is open.
- Reduced-motion preferences replace drawer slides and animated plot transitions with
  immediate or minimal-motion changes.
- All essential workflows support an attached keyboard and switch-style navigation.
- No instruction depends only on color, orientation, hover, or an edge gesture.

## 14. Error handling

Errors use plain language and identify the affected file without exposing its full
private path. At minimum, distinct messages are required for:

- unsupported format or unsupported variant;
- damaged or incomplete file;
- password-protected or encrypted file;
- file permission revoked or provider unavailable;
- file exceeds safe phone limits;
- parser or decoder component unavailable offline;
- insufficient memory or storage;
- export or share destination failure.

After an error, the user can retry, choose another file, remove the failed item, or
return to an already loaded plot. Error details suitable for a bug report are available
without replacing the human-readable summary.

## 15. Functional acceptance tests

### 15.1 Layout matrix

Test at minimum these CSS viewport sizes in both light and dark themes, normal and
200% text scaling where applicable:

| Portrait | Landscape counterpart |
| --- | --- |
| 320 × 568 | 568 × 320 |
| 360 × 800 | 800 × 360 |
| 390 × 844 | 844 × 390 |
| 412 × 915 | 915 × 412 |

For every size:

- no two menus overlap;
- no page-level horizontal scrollbar appears;
- all essential controls remain reachable without browser zoom;
- the closed-menu plot uses the full usable viewport;
- each drawer covers the usable viewport and scrolls internally;
- safe-area insets do not hide controls;
- rotating in either direction preserves the state listed in section 7.

Real-device checks are required on at least one current and one older supported Android
phone, plus one current and one older supported iPhone. Browser emulation alone does
not validate dynamic toolbars, safe areas, memory pressure, file providers, share
intents, or operating-system back gestures.

### 15.2 Gesture tests

- Edge swipe opens the intended drawer.
- Vertical scrolling near an edge does not open a drawer.
- Plot pan beginning on the plot never turns into drawer navigation.
- Pinch zoom never opens or closes a drawer.
- Closing gestures, visible buttons, Android Back, Escape, and accessibility actions
  produce the same final state.
- Rapidly alternating drawers never leaves both visible or the plot input disabled.

### 15.3 File-open tests

For each supported format family, keep at least one small fixture that is opened from:

1. the in-app picker;
2. the Android system chooser;
3. the iOS document or share interface;
4. a cold application launch;
5. an already running session.

Each test verifies the displayed file name, parsed variable tree, selected time axis,
first rendered plot, and a clear failure for an invalid fixture. Android tests also
verify the chooser and **Always** flow where the OS offers it.

### 15.4 Offline and privacy tests

- With network access disabled after installation, representative CSV, spreadsheet,
  MAT, Parquet, netCDF, and audio fixtures still open when their components are part of
  the installed package.
- Opening, plotting, rotating, and closing a local file produces no request containing
  file-derived data.
- Cancelling a parse or removing a file releases its temporary resources.

### 15.5 Performance tests

- Warm shell startup and tap feedback meet the budgets in section 12 on the reference
  device.
- Drawer animation remains smooth with a large variable tree.
- Rotation does not reparse the file.
- Repeated open, view, close, and remove cycles do not show unbounded memory growth.
- A file above the safe limit reaches the documented warning or deferred path instead
  of terminating the application.

## 16. Delivery sequence

1. **Compact responsive shell:** full-screen plot, exclusive left and right drawers,
   portrait/landscape reflow, safe areas, accessible navigation, and gesture ownership.
2. **Core viewing journey:** open, parse, select signals, plot, autoscale, switch active
   plot, remove file, and recover from errors on a phone.
3. **Installed application integration:** Android intents, iOS document/share entry,
   PWA fallback, lifecycle handling, and local export/share destinations.
4. **Feature migration:** expose existing analysis and settings workflows through
   full-screen menu pages without reintroducing desktop overlap.
5. **Hardening:** real-device matrix, offline packaging, memory limits, performance,
   accessibility, and privacy verification.

Each phase must leave the primary open-select-view journey usable. Later feature work
must not delay fixing overlap, orientation, file-open, or data-loss defects.

## 17. Non-goals

- Reproducing the desktop split-panel geometry at phone scale.
- Scaling or rotating a fixed desktop canvas to simulate phone support.
- Requiring landscape orientation.
- Maintaining phone-specific parsing logic.
- Uploading files to a cloud service for normal viewing.
- Editing or overwriting source measurement files.
- Promising system-level default-handler behavior on platforms that do not expose it.
- Hiding essential functionality behind gestures with no visible alternative.

## 18. Decisions required before implementation

The following implementation choices remain open but do not change the functional
requirements above:

- native wrapper or application framework for Android and iOS;
- exact compact-mode breakpoint and edge-swipe activation width;
- reference devices and numeric phone memory limits;
- which analysis tools ship in the first phone release after the core viewing flow;
- cache duration for temporary imported files and recent-file access;
- store distribution, signing, application identifiers, icons, and release channel.

These decisions must be recorded before their implementation starts. They may refine
thresholds and packaging, but they must not weaken the no-overlap layout, orientation,
local-processing, or file-open requirements in this specification.
