# Real-world CSV benchmark

This folder measures how Time Series Explorer's CSV reader opens the files in
`test-files/csv-real-world`. These are exports from instruments, data loggers,
PLC and SCADA systems and weather services, collected with their sources and
licences in that folder's `manifest.jsonl` and `README.md`. CleverCSV and pandas
read the same files for comparison.

`bench/dialect` asks one question of 4,000 GitHub files: which delimiter and
quote? This benchmark asks the question a user of a measurement file has: does
the file open, right, the first time?

## Protocol

- **Corpus.** The corpus has 144 files from 4 domains: lab instruments,
  industrial and energy, field and environment, and mechanical, chemical and
  biomedical. Their metadata is written in 18 languages and 13 encodings.
  One optional large file could not be fetched from this environment, because
  Zenodo is not on its network allowlist. That leaves 143 files, 132 of them
  single tables.
- **Labels.** `make-labels.py` writes `labels.jsonl`, with line numbers counted
  from 0.
  - Defaults come from the manifest: encoding family, delimiter, decimal
    separator and the number of preamble lines.
  - 33 files whose manifest entry did not match the file were read line by line
    and labelled by hand. They are marked `reviewed` and carry a note.
  - 11 files are not one table: several record types, several tables, reports,
    configuration files, INI sections or multiple segments. They are scored on
    encoding, delimiter and decimal only.
  - The labels were written before the reader was changed. Three were corrected
    afterwards; they are listed under "Label corrections".
- **Metrics.**

  | Metric | A file passes when |
  |---|---|
  | Encoding | The encoding family is right. ASCII counts as UTF-8. |
  | Delimiter | The delimiter is right. Any run of spaces counts as whitespace, and a one-column table has none. |
  | Decimal | The decimal separator is right. |
  | Data start | The first data row is within one line of the label. Tables only. |
  | Useful read | The read succeeds, gives a numeric column that is at least half numbers (a text column for state logs), and returns at least half the rows the file holds. Tables only. |
  | Right first time | All of the above, with default settings. Tables only. |

- **Our reader.** `run-ours.mjs` runs `CsvParser.inspectSample` on the first
  2 MiB of each file, as the app's dialog does, and `CsvParser.parse` on the
  whole file.
  - The whitespace reader skips blank lines, so its row numbers are mapped back
    to line numbers.
  - "Before" is the same script run on `main` at 25b6229, before any change
    measured here.
- **Baselines.** `run-baselines.py` runs three readers:
  - `pandas.read_csv(path)`;
  - pandas with `sep=None, engine='python'`, which uses `csv.Sniffer` to
    detect the delimiter;
  - CleverCSV 0.8.5, using `read_dataframe` with its own encoding and dialect
    detection.

  None of them looks for a preamble: their data starts on line 1, or on line 0
  without a header. pandas always reads `.` as the decimal separator. These are
  the readers' default behaviours, so the comparison measures what a user gets
  without changing any settings. It does not measure what an expert could set
  each reader to do.

## Results

Files read correctly. Encoding, delimiter and decimal are scored on 143 files.
The other three columns are scored on the 132 single tables.

| Reader | Encoding | Delimiter | Decimal | Data start | Useful read | Right first time |
|---|---|---|---|---|---|---|
| Time Series Explorer | **143 (100%)** | **143 (100%)** | **142 (99.3%)** | **128 (97.0%)** | **131 (99.2%)** | **126 (95.5%)** |
| Time Series Explorer, before | 135 (94.4%) | 141 (98.6%) | 137 (95.8%) | 116 (87.9%) | 128 (97.0%) | 109 (82.6%) |
| CleverCSV 0.8.5 | 87 (60.8%) | 85 (59.4%) | 117 (81.8%) | 55 (41.7%) | 63 (47.7%) | 35 (26.5%) |
| pandas, `sep=None` | 81 (56.6%) | 73 (51.0%) | 117 (81.8%) | 48 (36.4%) | 59 (44.7%) | 34 (25.8%) |
| pandas, defaults | 84 (58.7%) | 62 (43.4%) | 117 (81.8%) | 52 (39.4%) | 54 (40.9%) | 31 (23.5%) |

"Right first time" compared file by file with our reader, using McNemar's
exact test (two-sided):

| Compared with | Only ours right | Only the other right | p |
|---|---|---|---|
| Our reader before | 17 | 0 | 1.5e-5 |
| CleverCSV 0.8.5 | 92 | 1 | 1.9e-26 |
| pandas, `sep=None` | 94 | 2 | 1.2e-25 |
| pandas, defaults | 97 | 2 | 1.6e-26 |

### Reading the results

- **Disclosure.** The changes were developed on this corpus. The labels were
  fixed first, and each change was kept only if it held on the 68 files in
  `test-files` and on both halves of the CSV_Wrangling set (see below). Even
  so, 95.5% is a development score. It is not a held-out score.
- **Out-of-sample figure.** The "before" row is the reader as it stood before
  anyone looked at these files. Its 82.6% against CleverCSV's 26.5% is the
  comparison to cite as evidence that the approach generalises.
- **Where the baselines lose.** Most files from instruments and loggers start
  with a preamble: instrument settings, a station description, or a units row.
  A reader that assumes the header is on line 0 mixes the preamble into the
  table. Legacy encodings and decimal commas account for most of the rest.
- **The comparison is narrow.** CleverCSV detects dialects. It was not designed
  to find where a table starts, so its low "data start" score says little about
  it. The dialect comparison in `bench/dialect` is the fair test of that part.

## What changed

Every rule below is unit-tested in `scripts/test-csv-robust-parsing.mjs`, in
the section "Real-world corpus fixes". Each one is listed with the files that
motivated it.

- **Legacy code pages** (`detectLegacyEncoding` in `csv-text-normalize.js`).
  When a file is neither UTF-8 nor UTF-16, every candidate encoding is decoded
  and judged by the text it produces:
  - Shift_JIS when the text has kana;
  - EUC-KR when it has Hangul and almost no Hanja (GB2312 bytes also decode as
    EUC-KR);
  - GBK or Big5 when it has ideographs;
  - Windows-1251, DOS 866 or KOI8-R when the text is made of whole words of
    Cyrillic letters, preferring the reading with more lower case;
  - Windows-1250 only on evidence that cannot be read the Western way, such as
    ł (³ in 1252) or the Slovak ý;
  - Windows-1252 otherwise.

  Every reading must produce runs of letters, because a Spanish "AÑO" also
  decodes as GBK, to one ideograph between two Latin letters. Files: JMA ×2,
  AIM, SGCC, the CP949 wind turbine, the COMTRADE configurations ×2 and the
  Fluke.
- **Quoted decimal commas with a comma delimiter.** `"2,0825"` is a decimal
  comma: in a comma-delimited file, a comma inside a cell can only come from
  quotes. Only `"1,234"` stays undecided until the file's number format settles
  it. The dialog now offers a decimal comma with a comma delimiter, and DuckDB
  reads it with `decimal_separator=','`. Files: machine-axis logger, ECCC,
  MoTeC.
- **A separator after four or more digits is decimal.** `46622,538` cannot be
  a thousands group. File: SMA Sunny Beam.
- **A date that carries its clock.** A date such as "2022-02-01 01:00" is the
  time axis even when an hour column stands beside it. It still gives way to a
  real date-plus-time pair. File: ECCC.
- **Missing values.** `NULL`, `None`, `N/A`, `#N/A` and runs of up to three
  dashes count as missing values, like `NaN`. `NA` does not, because it is
  also sodium's column name. Files: SGCC, Davis, and the ECB fixture, whose
  `N/A` columns now load as numbers.
- **12-hour clocks** such as "10/13/23 01:45:00 PM" count as dates when the
  reader looks for data rows. File: HOBO.
- **Rows with fewer values.** A row that holds only values, too few to look like
  data on its own (a time with no reading before sunrise), counts as data next
  to the table. It is never taken for a header. Files: SMA.
- **One value per line.** A long run of rows with a single number, under a
  key/value preamble, is the table. Files: EZChrom, Yokogawa DL850.
- **Settings, then a blank line, then the table.** When a block of up to three
  rows sits above a blank line, and those rows have words or gaps where the
  table below has numbers, the data starts after the blank line. Files:
  Beckhoff ×2, AIM.
- **A single record.** One data row at the end of the file, under its header,
  is a table. File: Campbell TOA5 status table.
- **Spaces inside numbers.** Spaces count inside a number only as thousands
  groups or after a sign. Before, `0        299` read as 299, so a fixed-width
  file with decimal commas was split on the comma. File: Mettler STARe.

## Remaining failures

Six tables are still not right first time:

| File | Why |
|---|---|
| siemens-wincc | Unquoted decimal commas in a comma-delimited file. Every row then has one cell too many, and no reader can tell which comma is which. |
| tektronix_excel_resaved | The data starts after a metadata block that was copied in from a separate file. |
| smhi | A notes column makes the header two cells wider than most data rows. Reading it would need a new profile setting. |
| empatica | Line 0 is the start time and line 1 the sample rate. This is a format convention, not a table. |
| dexcom | Patient and alert rows with empty timestamps sit under the real header. We take the header from the last of those rows. |
| sma-sunnybeam | Read correctly, but 60% of its rows have no value (night), which fails the "at least half numbers" rule of "useful read". The metric is kept as it was fixed. |

## Label corrections after scoring

Each correction applies a rule stated before scoring, or a count anyone can
repeat. They are kept apart, in `CORRECTED` in `make-labels.py`, and marked
`corrected` in `labels.jsonl`.

| File | Change | Why |
|---|---|---|
| ezchrom | delimiter `,` → none | One value per row: the data has no delimiter. The empatica label already followed this rule. |
| biologic modulobat | rows 126 → 33 | 126 is the file's line count; 33 data rows follow the 94-line header. |
| princeton versastudio | rows 513 → 61 | 513 is the line count; 61 data rows are followed by 330 lines of XML layout. |

The corrections apply to every reader. Without them, our reader scores 123 of
132 (93.2%) instead of 126, the "before" reader 107 (81.1%) instead of 109, and
the baselines score the same.

## No regressions elsewhere

- **CSV_Wrangling** (`bench/dialect`). Half A stays at 97.38% and the held-out
  half B at 96.83%, both unchanged.
- **The fixtures in `test-files/csv`.** Compared with the reader before this
  work and the earlier dialect work, only two files read differently.
  `05_french_month_names_semicolon.csv` was fixed by the dialect work already
  on `main`. `ecb_euro_exchange_rates_daily.csv` now reads its `N/A` columns as
  numbers instead of text.
- **Tests.** `npm run test:release` passes. One assertion that pinned the old
  behaviour, `"1,5"` in a comma file being NaN, was updated.
- **Speed.** Parsing a 14.6 MB file takes as long as on `main`, within
  run-to-run noise of ±50 ms over about 750 ms.

## Reproduce

```sh
node bench/real-world/run-ours.mjs > bench/real-world/results/ours.jsonl
pip install pandas clevercsv==0.8.5
python3 bench/real-world/run-baselines.py > bench/real-world/results/baselines.jsonl
python3 bench/real-world/make-labels.py
python3 bench/real-world/score.py                 # the tables above
python3 bench/real-world/score.py --list "Time Series Explorer"
```

For the "before" row, copy `run-ours.mjs` into a checkout of 25b6229 and run
it there, writing to `results/ours-before.jsonl`. The optional large files
come from `node test-files/csv-real-world/verify.mjs --fetch`.

Environment: Node 22.23, Python 3.13, pandas 3.1.1, CleverCSV 0.8.5.
