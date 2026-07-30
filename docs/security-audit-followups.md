# Security audit — deliberate follow-ups

A full security/maintenance/portability audit was remediated on 2026-07-29. Everything
that could be fixed without changing what the app does was fixed and is covered by the
release suite. This file records what was **not** done, and why, so the next reader does
not have to re-derive the reasoning — or re-open a decision that was already made.

Each item was reviewed and consciously deferred. None is exploitable today without a
prior compromise of the renderer.

## Content-Security-Policy (renderer and web)

There is no CSP anywhere. The reason it is not a one-line fix: `duckdb-wasm` and `h5wasm`
need `wasm-unsafe-eval`, both spawn workers that would need `worker-src blob:`, and
`index.html` runs two inline scripts (the theme guess and the analytics endpoint) that
would need moving to files or nonces.

Worth knowing before attempting it: the audit report's suggested policy is stale — it
allows `googletagmanager.com`, but analytics is GoatCounter now
(`https://ferrucci-franco.goatcounter.com/count`).

A safe first step is `Content-Security-Policy-Report-Only`, which blocks nothing and logs
what a real policy would have broken.

The injection half of this risk is closed: the one unescaped DOM sink (the histogram
summary) is fixed and tested.

## `sandbox: true` on the BrowserWindow

`webPreferences.sandbox` is `false`. It cannot simply be flipped: `electron/preload.cjs`
calls `require('os')` for `homedir`, `tmpdir` and `userInfo().username`, and `os` is not
available in a sandboxed preload. Those three values feed the OpenModelica/Dymola
"copy path" helpers.

The way to do it is to compute them in main and pass them through
`webPreferences.additionalArguments`, then read them from `process.argv` in the preload.
That needs verification against a packaged build, not just `npm run desktop`.

## A main-process path allowlist for the file IPC

`omv:read-file`, `omv:read-file-slice` and `omv:stat-file` resolve any renderer-supplied
path; `omv:convert-to-parquet` writes to any renderer-supplied output path. Only
`omv:delete-temporary-parquet` confines itself.

The correct fix is an allowlist of paths the user actually granted, canonicalized with
`fs.realpath` before comparing. The work is not the check — it is registering every way a
path legitimately arrives: the open/save dialogs, drag & drop, the bundled examples, and
Live Update with a path typed by the user. Miss one and that route stops working.

This is defense in depth: it only matters if the renderer is already compromised, and
the offline shell has no standing web surface (`onBeforeRequest` cancels non-allowed URLs,
`will-navigate` blocks external navigation).

## A per-session token on the loopback server

`/__omv_local__/*` now validates the `Host` header (and `Origin` when present), which is
what kills DNS rebinding — the only way a web page could reach it. A per-session random
token in the renderer URL would be belt and braces on top of that, at the cost of
threading the token through both the Electron window URL and the portable server.

## HDF5 / netCDF decompressed-byte budget

The size gate measures the file on disk. HDF5 supports per-chunk gzip/szip, so a file
under the limit can hold datasets that decompress to many GiB, and `object.value` reads
them whole.

The MAT reader now has exactly this budget (see `matlab-mat-limits.js`), but the HDF5 path
is harder: it needs dataset shapes summed and multiplied by dtype size before anything is
materialized, and the limit has to be chosen so it does not start refusing files that
open today. In practice h5wasm decompresses into the wasm32 heap (~2–4 GiB cap) and tends
to throw `RangeError` rather than exhaust host RAM, which is a recoverable local
self-DoS on a viewer where the user opened their own file.

## Reload serving stale content on Safari

`_shouldReselectFileForReload` gates the reselect prompt on `_isChromeOrEdge()`. Safari
never gets a `FileSystemFileHandle`, so Reload falls back to `entry.file.arrayBuffer()`,
whose failure is now logged but still falls back to the load-time snapshot. If the file
changed on disk, a Safari user clicks Reload, sees no error, and gets the old data.

Dropping the browser gate is the fix, at the cost of a reselect dialog on every
non-Chromium Reload. That is a UX call, not a bug fix.

## Code signing and notarization

`build.mac` and `build.win` declare no signing identity, `hardenedRuntime` or `notarize`,
and CI holds no signing secrets. Published `.dmg`/`.zip`/`.exe` ship unsigned.

`docs/desktop-release.md` permits this for a beta **provided the release notes disclose
both warnings**. They now do, and `scripts/test-desktop-release-config.mjs` fails the
release if either the Windows SmartScreen or the macOS Gatekeeper disclosure goes missing.
Signing needs an Apple Developer certificate and an Authenticode certificate — a purchase
decision, not an engineering one.

## Smaller, knowingly left alone

- **No watchdog on the parse worker.** `WorkerPool` now handles `error` and `messageerror`,
  so the remaining hole is a hard OS kill that fires neither. Any timeout would have to be
  longer than a legitimate multi-minute parse of a 1 GB file, which makes it a policy
  choice rather than a fix.
- **GitHub Actions pinned to major tags, not commit SHAs.** All of them are first-party
  `actions/*`. Pinning to SHAs means a Dependabot rule to keep them current.
- **`xlsx` installed from the SheetJS CDN tarball.** This is the vendor's own recommended
  install and 0.20.3 post-dates both known CVEs; the registry alternative (0.18.5) is the
  vulnerable one. The residual risk is silent staleness, so watch SheetJS advisories by
  hand.
- **One `brace-expansion` advisory stays open.** The tree already holds the newest
  published version of every line (1.1.17 / 2.1.3 / 5.0.8); npm's only offered remedy is a
  major downgrade of `electron-builder`. It is an install-time toolchain dependency and
  `build.files` excludes it from the packaged app.
- **The god files were not split.** `interaction-methods.js`, `file-methods.js`,
  `ui-methods.js` and `DuckDbSource` are still 3–4k lines each. Mechanical, independently
  shippable, and better as their own branches than mixed into a security pass.
