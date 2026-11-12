# Notes for Claude Code sessions in this repository

The contributor guide is `CONTRIBUTING.md`; the architecture is in
`docs/architecture.md`. This file holds the rules a session must not miss.

## Every analysis and data tool works in memory-saving (lazy) mode

A file can be open in memory (eager) or in memory-saving mode (lazy: the file
stays in DuckDB-WASM and only an overview is in memory). The app must behave the
same in both. So **whenever you add or change an analysis, a data tool, an
export, or anything else that reads a signal's values**, make it work on a lazy
file too, before the pull request:

1. **Every row in its range, never the overview.** On a lazy file the arrays in
   memory are a decimated overview; reading them gives a wrong answer that looks
   right. Read the file instead:
   - a SQL aggregate or expression in `src/data/duckdb-source.js` when the
     result has a SQL form (correlation, linear fits, integrals, heatmap);
   - a chunked stream (`streamColumns` in `src/data/column-stream.js`) when it
     is computed in JavaScript, with the kernel written to accumulate chunk by
     chunk (`src/plots/methods/histogram-lazy-methods.js`,
     `src/plots/methods/fit-lazy-methods.js`);
   - a kernel that needs several passes over the rows: write it as passes
     (`src/utils/fit-passes.js`);
   - a data tool whose output is a new signal: the chunked executor and its
     sink (`src/data/chunk-executor.js`, `src/app/methods/lazy-data-tools-methods.js`).
2. **The same numbers as in memory.** Run the very same kernel code on both
   paths (the eager path feeds it the whole arrays, the lazy path chunks), so
   the results match bit for bit. Where only SQL can do it, match within a
   stated tolerance.
3. **No silent caps or samples.** A row limit, a sample or a refusal on a lazy
   file is a defect unless the UI says so plainly — and then it is recorded as
   a known gap in `docs/any-size-files.md`. Prefer streaming past a limit over
   refusing.
4. **Long work shows progress and can be cancelled** (an `AbortSignal` through
   the stream; a newer request aborts the one it replaces).
5. **A parity test** that loads the same CSV lazily on a real DuckDB-WASM
   engine (the Node build) and in memory, and compares the results:
   `scripts/test-lazy-histogram.mjs` and `scripts/test-lazy-curve-fit.mjs` are
   the models. Register it in `package.json` as a `test:*` script (the release
   suite runs every one). For a UI path, extend the matching
   `scripts/e2e-*.mjs`.

`docs/any-size-files.md` is the plan and the record of what already works in
lazy mode; update it when you close or open a gap.

## Other standing rules

- Every piece of work ends with a pull request merged to `main`, with CI green
  (both jobs: tests and build, and the browser checks).
- User-visible text goes in `src/i18n/translations.js`, in every language there
  (en, fr, es, it, zh).
- Update the docs a change makes stale.
