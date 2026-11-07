# Robust CSV reading

Files from PLCs, data loggers and old Windows tools often fail to open for
reasons that have nothing to do with the table they hold. This note lists what
the CSV readers now detect and repair, where it lives, and which tests pin it.

## Where it lives

- `src/parsers/csv-text-normalize.js` holds the pure, shared rules: decoding,
  invisible characters, the number format, and fitting rows to the header.
- `src/parsers/csv-parser.js` applies them in `parse`, `inspectSample`,
  `inspectPreview` and `parseWithProfile`.
- `src/data/csv-sql-normalize.js` says the same rules in DuckDB SQL. Both the
  browser's large-file path (`duckdb-source.js`) and the desktop converter
  (`csv-to-parquet-core.js`) use it, so a large file reads like a small one.
- `src/parsers/csv-time-detection.js` reads dates and describes the pattern a
  date column is written in.

## Encoding

`decodeCsvBytes` decides in this order:

1. A byte-order mark: UTF-8, UTF-16 LE or UTF-16 BE.
2. UTF-16 without a BOM, recognised by a zero byte in every other position.
3. Strict UTF-8. A character cut off by the end of a preview sample no longer
   counts against it; it used to turn the whole file into Windows-1252.
4. UTF-8 with a few damaged bytes among many good multi-byte characters.
5. Windows-1252 for everything else.

The dialog offers 18 encodings and labels Auto with what it found, for example
"Auto (UTF-16 LE)". Changing the encoding keeps every other setting.

## Invisible characters

`sanitizeCsvText` removes C0 and C1 control characters except tab and line
breaks, DEL, the soft hyphen, zero-width and bidi marks, word joiners and stray
BOMs. The count is reported as `removedInvisibleChars` in the profile and the
metadata, and the DuckDB readers then clean every column with `regexp_replace`.
Files without such characters pay nothing in SQL.

## Quotes

A quote opens a quoted field only at the start of a field, and only if a closing
quote follows within 64 KiB and 100 lines. Elsewhere it is an ordinary
character. Before, one stray quote (`5"` for inches, a string cut short by the
PLC) made the rest of the file a single cell.

## Rows with the wrong number of cells

`fitCsvRowToWidth` drops empty cells past the header, which a trailing
delimiter produces. It pads a row that stops before header cells that are
empty. Other short rows are left out by default. With the profile setting
`raggedRows: 'pad'` (the dialog's "Keep rows with missing cells") they are kept,
and their missing cells load as empty values. In DuckDB that setting maps to
`null_padding=true`; DuckDB 1.4 already accepts trailing empty cells by itself.

A header that ends in a delimiter over empty columns loses those columns
(`trimmedTableWidth`), so no unnamed empty variable appears.

A row with a different width no longer blocks Apply in the dialog. It is red in
the preview and counted in a warning.

## Line endings

`detectLineEnding` looks at the lines from the first data row on. When they end
in CRLF, the DuckDB readers pass `new_line='\r\n'`. Without it DuckDB skipped
the wrong number of lines, or failed, when the preamble mixed LF and CRLF, and
the preamble and the header were read as data. Building-management exports
write files like that.

## Units in headers

On Auto, brackets hold a unit only when they hold one or two words: "(kW.h)"
is a unit, and "(vierge si fiable)" stays part of the name. A bracket format
chosen by hand in the dialog takes whatever the brackets hold.

## Number format

`detectCsvNumberFormat` looks only at cells that can be read one way. "1,5" or
"3.25" name the decimal separator, "1.234,5" names both separators, and
"1,234" names neither. Conflicting evidence leaves the setting on Auto, which
reads each cell on its own. The result is stored as `detectedNumberFormat`,
next to the reader's own `decimalSeparator` and `thousandsSeparator`.
`csvNumberFormat(profile)` combines the two for every reader.

`parseCsvNumber` also reads a custom decimal mark, thousands grouped by dot,
comma, space, no-break space or apostrophe, and a typographic minus. Plain
numbers take a fast path, which made `parse` about 20% faster on a 15 MB file.

## Delimiter and quoting

The candidates are comma, semicolon, tab, pipe and whitespace. Each one is
scored two ways. The first is the table reading: a header over rows of numbers
and dates. The second is CleverCSV's data consistency, pattern times type
(van den Burg et al., 2019). The table reading decides, unless consistency
prefers another candidate by more than 1.25 times, or no candidate reads as a
numeric table.

Quoting is detected once the delimiter is known: `"` or `'`, and `\` as an
escape character. Every reader then uses it. `bench/dialect/README.md` measures
the result on the paper's corpus. On the held-out half it reaches 96.8%
dialect accuracy, against 95.2% for CleverCSV 0.8.5.

## Delimiter details

The candidates are comma, semicolon, tab, pipe and whitespace. Month-name dates
now count as data when the delimiter is chosen; the French fixture
`05_french_month_names_semicolon.csv` was read with the wrong delimiter before.
A whitespace split whose cells still hold another delimiter is penalised.

## Dates

- Fractions of a second after a comma: `13:05:22,123`.
- Month names in English, French, Spanish, Italian, Portuguese, German and
  Dutch, with accents, abbreviations and an optional weekday: `Mon, 15 Jan
  2024 10:00:00 +0100`, `lundi 1 janvier 2024 13:05`, `15 de enero de 2024`,
  `Jan 15 10:00:00 2024`.
- UTC offsets on ISO and month-name dates.
- German and Dutch time headers: Zeit, Zeitstempel, Datum, Uhrzeit, tijd.

`describeTimeSourcePattern` reads the pattern from the cells. The dialog shows
it for Auto, for example "Detected: d MMMM yyyy HH:mm:ss (French)", and Custom
starts from it. Custom patterns gained `EEE`/`EEEE` (weekday, ignored), any run
of `S` (fraction), `XXX` (offset) and quoted literals such as `'de'`. Every
described pattern parses its column exactly as Auto does.

## Dialog

- Lines shown: 1000 and All were added. All reads up to 32 MiB and shows up to
  10,000 rows. When the file is larger, a warning gives the lines shown and an
  estimate of the total.
- Decimal separator: Auto names what it found, and Custom takes any character
  except the delimiter.
- Thousands separator: Auto, None, comma, dot, space, apostrophe or Custom.
- "Hide invalid lines" stays off by default.
- Hovering a cell shows its raw text in «quotes» (a no-break space shows as
  ⍽), the value it is parsed as with the column's unit, and its type: number,
  text, time axis, missing value, invalid number, column not imported, header,
  units or preamble. A row that is left out says why. The parsed-time column
  shows the instant, the cells it came from and the pattern Auto used.
  `_cellInfo` computes it without the DOM, so it is unit-tested.
- Saved settings files carry `thousandsSeparator` and `raggedRows`.

## Tests

- `npm run test:csv-robust-parsing` covers the parser, the describer, the SQL
  text and the dialog without a DOM.
- `npm run test:csv-robust-duckdb` converts dirty files with the native DuckDB
  and checks the values.
- `npm run e2e:csv-robust-parsing` loads a dirty PLC export in Chromium, as
  UTF-16 through the in-memory parser and as UTF-8 through DuckDB-WASM. It also
  drives the dialog.
