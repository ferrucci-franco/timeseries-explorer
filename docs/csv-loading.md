# How a CSV is loaded

This note follows a delimited text file (`.csv`, `.txt`, `.tsv`, `.dat`, …)
from the moment it is dropped on the app to the moment its curves are drawn.
It covers the two ways the app holds it, **whole** (in memory) or in
**memory-saving mode** (lazy). It also covers which reader parses it and when
the parsing dialog and the Parquet conversion come in.

Checked against the code at `b330bb7` (12 Nov 2026). Function names are given
so each step can be found. Most of it is in `src/app/methods/file-methods.js`
and `src/data/duckdb-source.js`.

What each reader repairs (encodings, separators, number formats, dates,
short rows) and how the two readers are kept equal is in
[`csv-robust-parsing.md`](csv-robust-parsing.md); it is not repeated here.

## Summary

| Situation | Reader | How it is held |
|---|---|---|
| UTF-8 text, below **CSV full load limit** (300 MB) | DuckDB-WASM | Whole: every row in typed arrays |
| UTF-8 text, at or above the limit | DuckDB-WASM | Memory-saving: a 10 000-row overview; zoom asks DuckDB |
| Whole load runs out of memory | DuckDB-WASM, again | Memory-saving, with a notice saying why |
| Not UTF-8 (UTF-16, Windows-1252, …), or DuckDB fails | JS reader (`CsvParser`) | Whole; refused at 450 MB and above |
| No DuckDB (portable `file://` build, the guide's demo frame) | JS reader | Whole; refused at 450 MB and above |
| A sheet of an Excel workbook | JS reader, over the sheet turned into CSV | Whole |
| At or above **Suggest conversion above** (500 MB) | — | Asked first: convert to Parquet, review the structure, or open as text |

Both limits are in Settings (`csvFullLoadMb`, `csvCompactHintMb` in
`_defaultAdvancedSettings`, `src/app/viewer-app.js`). They are the same in
the browser and on the desktop.

## 1. Before reading: the large-file offer

`loadFile` calls `_maybeConvertLargeCsvBeforeLoad` first. For a text table at
or above **Suggest conversion above** (default 500 MB), whatever its
extension, the dialog "Large text file detected" offers:

- **Review / adjust structure...**: the parsing dialog (section 4), then the
  same offer again with the reviewed settings;
- **Convert, save and open**: writes a Parquet file and opens that instead;
- **Convert temporary and open**: desktop only. A Parquet file the app
  deletes on exit. The browser has nowhere to keep one, so the button is not
  shown there;
- **Open as text anyway**: goes on to the CSV path below; the answer is
  remembered for this file;
- **Cancel**.

It asks before the load on purpose: afterwards the user would already have
waited for the slow path they were being offered a way out of.

The desktop converts with native DuckDB (`omvDesktop.convertToParquet`),
which has no WASM memory ceiling. The browser converts in DuckDB-WASM
(`convertCsvFileToParquet`), reading the file in slices, and saves the result
where the user chooses. Both use the same reading SQL as the loader, so a
profile reviewed in the dialog means the same thing in both.

Below that size there is no question: a file between 300 and 500 MB opens
in memory-saving mode without asking. A file at or above the hint size that
is opened as text anyway also gets a non-blocking notice
(`_showLargeCsvParquetHint`) with a button to convert it later.

## 2. The sample and the profile

Before parsing, `_inspectCsvSample` reads the first **1 MB** of the file
(`_readFileSampleBuffer`) and `CsvParser.inspectSample` describes up to 700
rows of it. This *profile* holds the encoding, delimiter, header and units
rows, time column and its format, decimal and thousands separators, columns
to skip, and so on. It decides which reader is used (the encoding) and
travels with the file (`data.metadata.csvProfile`), so a reload or a live
update reads the file the same way.

A profile the user confirmed in the parsing dialog (`profileSource: 'user'`)
replaces the detected one and is never second-guessed: a column type chosen
there is not rescanned.

## 3. Which reader, and whole or lazy

`_parseCsvResultBuffer` makes the decision.

**DuckDB first.** When DuckDB-WASM is available (`_canUseDuckDb`) and the
file is UTF-8 (or its encoding is unknown), the file goes to
`DuckDbSource.parseCsvFile`. The file is not read into memory first:
`_canParseFromFile` leaves known text extensions unread, so DuckDB streams
them from the browser's file handle.

**Whole or lazy** is decided by `_loadWholeOrLazy`:

- size **below** the CSV full load limit: whole;
- size **at or above** it: memory-saving mode;
- limit set to **0**: whole at any size;
- a whole load that fails for lack of memory is retried in memory-saving
  mode (`metadata.lazyReason = 'memory'`, which the notice reports). Any
  other error is not a question of size and is thrown as it came.

**JS reader as fallback.** The in-memory reader (`src/parsers/csv-parser.js`,
in a worker when one is available) reads:

- text that is not UTF-8, which DuckDB is not given;
- a file DuckDB failed on. Examples are whitespace-aligned columns (not
  supported in SQL), or no usable time column;
- everything, when DuckDB is unavailable;
- the CSV view of an Excel sheet, which exists only as a buffer.

It reads the whole file as one string, so it is refused at **450 MB**
(`LEGACY_CSV_FALLBACK_MAX_BYTES`). The error then says to convert the file to
Parquet. With a user-confirmed profile it reads with `parseWithProfile`;
otherwise with `parse`, its own automatic reading.

## 4. The parsing dialog

`src/ui/csv-parsing-preview-dialog.js`. Small files open without it: the
detection is used as is. The dialog opens only when asked:

- **Adjust CSV parsing...** (the ▦ button on a loaded file):
  `adjustCsvParsing`. Confirming re-reads the file with the new profile,
  through the same path as a first load, and keeps derived variables and
  data-tool results;
- **Review / adjust structure...** in the large-file offer (section 1);
- before every conversion to Parquet: from the menu, from the large-file
  notice, and for spreadsheets. A conversion of a misread file would bake the
  mistake into a file that looks authoritative.

It shows a 2 MB stretch of the file (the start; a large file also offers
other regions in a menu), how each cell is read and the type each column will
get. Typed options apply
on blur, on Enter or with **Update preview**. If the confirm click is what
applies a pending edit, the dialog stays open to show it and asks again.
Settings can be saved to a `.parsing.json` file and loaded back.

## 5. Whole: what DuckDB does

`_loadIntoLegacy`, eager branch:

1. `CREATE TABLE … AS SELECT * FROM read_csv(…)`, with the reading options
   built from the profile (`_csvReadExpr`) and its row filter. It is a
   temporary table when the database lives in OPFS, so rows read once do not
   go through the disk.
2. One scan (`_scanCsvLoad`) counts the rows, finds the time range and types
   every column left on auto over **all** rows. A column is numeric or text
   by the count of its cells over the whole file
   (`isMostlyNumericColumn`, the same rule as the JS reader), not by the
   first rows.
3. The projection (`_projectionSql`) casts each column. A column with cells
   DuckDB's cast refuses (`1,203.5`, `−3`, `1.5D+02`…) gets the per-cell
   number rules in SQL.
4. All rows are read, ordered by time and then by file position (`rowid`),
   which gives the same order as the JS reader's stable sort. They become
   `Float64Array` columns. The table is dropped and the file unregistered:
   from here on the data is in memory like any other format's.

## 6. Memory-saving mode (lazy)

`_loadIntoLegacy`, lazy branch. The file is never copied into DuckDB:

1. `CREATE VIEW … AS SELECT * FROM read_csv(…)`. Every later query re-reads
   the CSV from the file handle; DuckDB reads only the columns it needs.
2. The same one-pass scan as in whole mode: types, row count and time range.
   A lazy file pays no extra pass for them.
3. The **overview**: a reservoir sample of 10 000 rows, ordered by time. This
   is what the variables hold in memory (`data.variables[*].data`), and what
   the panels draw at first.
4. `data._duckdb` keeps the view, the file handle and the reading SQL. Each
   variable keeps its number format (`_duckdbNumberFormat`) so every later
   query reads the column as the scan did.

While the file is open:

- **Zoom and pan** ask for the visible window (`getColumnsRange`): DuckDB
  groups the rows of `[t0, t1]` into at most a few thousand time buckets, one
  scan for all the traces of the same file, cached. Panels show "Loading
  detail" while it runs (`_refreshTimeseriesVisualsLazy`).
- **Analyses and data tools** read the rows they need from DuckDB, in SQL or
  in chunks, not from the overview: FFT, histogram, heatmap, profile,
  integral, curve fits, derivative, filters… What each one does and its
  limits are in [`any-size-files.md`](any-size-files.md).
- **Data-tool results** (a moving average is a column as long as the file)
  are kept on disk by default, in the storage the browser gives the app
  (OPFS). There they can grow past the memory there is, and they are kept for
  the next time the same file is opened. Where there is no such storage, or
  when **Results of the data tools** is set to memory, they are held in
  memory up to **Results in memory** (`lazyResultsMb`, 1 GB).
- Some things need every sample in memory and are not offered: audio
  playback, saving a complete project with the data.

A CSV in this mode is re-read on every query that needs rows. Parquet is
columnar and compressed, which is why converting a large CSV once (section 1)
makes everything after it faster. A `.parquet` file has its own limit
(**Parquet full load limit**, 100 MB in the browser, 200 MB on the desktop)
and the same two modes.

## 7. After the load

The result has the same shape whichever reader produced it: `variables`,
`metadata`, `tree`. `loadFile` registers it, draws the variables tree and
shows the time-axis warnings if any (`_showDatetimeAxisWarningIfNeeded`). The
profile stays on the file, and the reload, live update and **Adjust CSV
parsing...** use it.

## Tests

- `test:csv-duckdb-parity`: every CSV in `test-files` through the JS reader,
  DuckDB whole and DuckDB lazy; variables, types, numbers, text and order
  must agree.
- `test:csv-robust-parsing`, `test:csv-sql-datetime`, `test:csv-robust-duckdb`:
  see [`csv-robust-parsing.md`](csv-robust-parsing.md).
- `e2e:csv-robust-parsing`: one file through the JS reader (UTF-16) and
  through DuckDB-WASM (UTF-8) in Chromium, and the dialog.
- `e2e:full-load-fallback`: the 300 MB default, a limit of 0, and a whole
  load that does not fit opening in memory-saving mode.
- `e2e:lazy-data-tools`, `e2e:lazy-histogram`, `e2e:lazy-heatmap-profile`,
  `e2e:lazy-disk-results`: the analyses and tools on a lazy file.
- `e2e:csv-folders`: the parsing dialog, saving and loading its settings.

## Related documents

- [`csv-robust-parsing.md`](csv-robust-parsing.md): what both readers detect
  and repair, and how they are kept equal. Current.
- [`any-size-files.md`](any-size-files.md) (Spanish): how each tool works in
  memory-saving mode, phase by phase. Current, but a log of the work.
- [`file-size-limits.md`](file-size-limits.md) (Spanish): the study behind the
  limits. Its main table predates the 300 MB default; see its "Addenda 2".
- [`large-files.md`](large-files.md): the Node converter script
  (`bench/csv-to-parquet.mjs`) and pandas pickles. Its thresholds are older
  than this note.
