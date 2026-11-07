# CSV dialect detection benchmark

This folder compares Time Series Explorer's CSV reader with CleverCSV and the
detectors published with it. The corpus and the reference dialects are those of
van den Burg, Nazabal and Sutton, "Wrangling messy CSV files by detecting row
and type patterns", *Data Mining and Knowledge Discovery* 33 (2019) 1799-1820,
https://github.com/alan-turing-institute/CSV_Wrangling.

## Protocol

- **Corpus.** We use the GitHub test set: 4,499 files listed with their MD5.
  On 2026-11-07, 4,112 of them could still be downloaded unchanged. 386 URLs
  were gone and 1 file had changed. 4,025 of the 4,112 have an `OK` reference
  dialect, and those are the files scored. The UK government test set could
  not be fetched from this environment, because its network allows only listed
  hosts, so it is not part of these results.
- **Metric.** The metric is the paper's `constant_accuracy_overall.py`. A file
  is correct when delimiter, quote character and escape character all equal the
  reference. "Standard" files have a comma delimiter, an empty or `"` quote and
  no escape. All other files are "messy".
- **Split.** The authors' development set is almost entirely offline: 94 of
  4,533 files remain. We therefore split the test set by MD5. Files starting
  with `0`-`7` form half A, used for development. Files starting with `8`-`f`
  form half B, which was not examined until the final run.
- **Disclosure.** Before the split, we looked once at the aggregate error
  counts of the first version over the whole set. We did not look at
  individual B files.
- **Our reader.** It reads what the app reads: the first 2 MiB, decoded and
  cleaned (`CsvParser._decodeTextWithEncoding`). The delimiter comes from
  `CsvParser._detectDelimiter` and the quoting from `CsvParser._detectQuoting`.
  When the delimiter splits no line, it is reported as `''`.
- **CleverCSV.** We ran version 0.8.5 with `clevercsv.detect_dialect(path)`,
  its default method, on the whole file, with a 300 s timeout.
- **Published results.** HypoParsr, Python's `csv.Sniffer` and the paper's
  CleverCSV come from the authors' result files, restricted to the same files.

## Results

Accuracy in %, on the files available:

| Detector | Half B (held out, 2,113) | Half A (development, 1,912) | All (4,025) |
|---|---|---|---|
| Time Series Explorer | **96.83** | **97.38** | **97.09** |
| CleverCSV 0.8.5 | 95.22 | 93.67 | 94.48 |
| CleverCSV, paper (published) | 94.27 | 93.10 | 93.71 |
| Python csv.Sniffer (published) | 86.32 | 84.41 | 85.42 |
| HypoParsr (published) | 81.40 | 80.18 | 80.82 |

Half B by file type, in %:

| Detector | Standard (1,711) | Messy (402) | No result |
|---|---|---|---|
| Time Series Explorer | 98.25 | 90.80 | 0 |
| CleverCSV 0.8.5 | 96.79 | 88.56 | 21 |

Paired comparison with CleverCSV 0.8.5, using McNemar's exact test:

| Files | Ours only right | CleverCSV only right | p |
|---|---|---|---|
| Half B | 77 | 43 | 0.0024 |
| Half B, only files CleverCSV answered (2,092) | 58 | 43 | 0.16 |
| All | 170 | 65 | 5.2e-12 |

### Reading the results

- **Held-out half B.** On B, our reader is significantly more accurate than
  CleverCSV 0.8.5 over all files.
- **Where the margin comes from.** Much of it is robustness. CleverCSV gives no
  result for 44 files: 37 are encoding or NUL-byte errors and 19 give no
  dialect. Our reader answers every file.
- **Files CleverCSV answered.** There, our reader is ahead (96.89% against
  96.18%), but the difference is not significant on half B.
- **Overstated figures.** The "All" column includes the development half, so it
  overstates the generalisation gap. Report half B.
- **Speed.** Over 4,112 files the reader took 69 s, against 1,050 s for
  CleverCSV. The 95th percentile per file was 0.07 s against 0.99 s.

## What the reader does, and where

- **Delimiter.** `CsvParser._pickDelimiter` keeps the table reading, which
  looks for a header over rows of numbers and dates. It switches to the
  candidate with the highest data consistency Q = P·T from the paper (pattern
  score times type score) when Q is more than 1.25 times higher, or when no
  candidate reads as a numeric table. On half A this raised delimiter accuracy
  from 88.2% to 98.3%. None of the 68 files in `test-files` changed.
- **Spaces.** The space candidate is weighted by the share of rows with two
  numeric cells. Columns of numbers split on spaces; words and dates do not.
- **Quoting.** `_detectQuoting` chooses `"` or `'`. A single quote counts only
  when it closes at a field boundary, so an apostrophe never counts. It reports
  `\` as the escape character when `\"` occurs inside fields more often than
  `""`. The reader, live updates and both DuckDB readers then read the file with
  that quoting.

## Reproduce

```sh
python3 bench/dialect/download.py --set github          # bench/data/dialect (git-ignored)
node bench/dialect/run-ours.mjs bench/data/dialect/github > out_ours_github.jsonl
pip install clevercsv==0.8.5
python3 bench/dialect/run-clevercsv.py bench/data/dialect/github > out_clevercsv_github.jsonl
python3 bench/dialect/score.py --data bench/data/dialect --set github --published \
    out_ours_github.jsonl out_clevercsv_github.jsonl
```

The `results/` folder holds the outputs used above. To score one half, link
its files into a separate folder: MD5 starting `8`-`f` for half B.

Environment: Node 22.23, Python 3.13, CleverCSV 0.8.5, commit after 05ce718.
