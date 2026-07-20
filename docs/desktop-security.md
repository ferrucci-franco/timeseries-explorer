# Full Desktop security and offline boundary

## Runtime boundary

The Electron renderer loads the packaged application from a loopback-only HTTP server. Requests to any other origin are denied. Popup windows are denied, and intentional HTTP(S) links are handed to the operating system's default browser. The renderer uses context isolation with Node integration disabled.

The application does not require Internet access after installation. There is no automatic updater in the beta channel. Local file reads, Live Update and CSV-to-Parquet conversion are performed on the user's computer.

## Dependency audit

The v0.1.0-beta.1 source dependency audit reports no critical vulnerabilities. It reports high-severity `tar` advisories through `duckdb -> node-gyp` for which npm currently offers no fixed dependency path. These modules are installation/build tooling: the application never exposes tar extraction to user data. The known build-only packages (`node-gyp`, `cacache`, `make-fetch-happen` and `tar`) are explicitly excluded from the packaged application, and the packaged runtime is inspected during release validation.

Release automation fails on critical production advisories. The documented high-severity build-tool exception must be reviewed again when DuckDB updates its dependency chain; it must not be generalized to unrelated advisories.

## Code signing

The initial beta is intentionally unsigned and publishes SHA-256 checksums. A stable release intended for broad promotion should be Authenticode-signed. Certificates and passwords must be stored only as encrypted GitHub Actions secrets.
