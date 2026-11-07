# Exhaustive profile search: a measured negative result

**Question.** Would a brute-force search make the reader better? The idea:
try every candidate reading of the first lines, rank the readings by score,
and confirm the best ones on other parts of the file.

**Answer.** Not on this corpus. Nothing in the parser was changed. The
experiment is kept so it can be reproduced and cited.

## What was tried

The corpus, reference and split are those of `README.md`: half A for
development and half B held out. For every file, `search-features.mjs`
records each candidate delimiter with:

- the table score and data consistency the reader already uses;
- the quoting `_detectQuoting` finds for that delimiter;
- the share of rows that fit the header's width, and the share of cells of a
  known type, in the first 256 KiB;
- the same two measures and the consistency on a 64 KiB segment from the
  middle and one from the end of the file. These validation segments exist
  for files larger than the scoring window: 179 files in A and about as many
  in B.

The candidates are the reader's five delimiters (`,` `;` tab `|` and spaces)
plus 13 extra punctuation marks: `: = # ^ ~ ! & % * + / - _`.

`search-rules.py` then compares, without parsing again:

1. the current rule (`CsvParser._pickDelimiter`);
2. the extra delimiters, admitted when their consistency beats the best
   standard candidate by a factor k between 1.0 and 2.0;
3. validation: the current choice is replaced by another candidate that still
   reads the middle and end of the file when the current one does not;
4. both together;
5. preferring tab over spaces when the tab reading is a clean table;
6. the margin between the best and second-best consistency, as a confidence
   to decide when to ask the reader.

## Results

Dialect accuracy in % (delimiter, quote and escape all right):

| Rule | Half A (1,912) | Half B, held out (2,113) |
|---|---|---|
| Current | 97.38 | 96.83 |
| Extra delimiters, k = 1.5 | 96.65 | 96.07 |
| Extra delimiters, k = 2.0 | 96.65 | 96.31 |
| Validation segments | 97.44 | 96.78 |
| Extra delimiters and validation | 96.71 | 96.02 |
| Tab over spaces | 97.54 | 96.88 |

None of the variants changes how the 68 files in `test-files` are read, with
one exception: the extra delimiters change `12_no_time_column.csv`.

Confidence from the margin on half B:

| Flag files when the margin is below | Files flagged | Errors caught (of 67) |
|---|---|---|
| 0.02 | 23 (1.1%) | 0 |
| 0.1 | 28 (1.3%) | 0 |
| 0.3 | 33 (1.6%) | 3 |

Where the 67 errors on half B lie:

| Cause | Files |
|---|---|
| The right candidate was among ours but ranked lower | 28 |
| Quote or escape detection disagrees | about 33 |
| A backtick quote, an escape or a `#` delimiter the reader does not support | 6 |

## Reading

- **Extra delimiters.** They cost 0.5 to 0.8 points on the held-out half.
  Splitting on `:`, `/` or `-` cuts times, dates and codes into regular-looking
  numeric pieces that score well. This is the failure mode of searching more
  widely with the same score.
- **Validation segments.** They change one or two files either way. Most files
  in the corpus fit in the first 256 KiB. When a file is larger, its middle and
  end read like its start under every candidate.
- **The tab preference.** It gains 3 files on A and 1 on B, which is within
  noise, so it is not adopted.
- **The margin.** It does not predict errors: at 1.3% of files flagged it
  caught none. When the reader is wrong, it is wrong with a clear margin. Asking
  the reader on a low margin would interrupt correct files and leave wrong ones
  alone.
- **The 28 ranking errors.** They are mostly files where two readings are both
  defensible (tab or spaces, comma or spaces, files of a few lines), and where
  the reference follows a convention rather than a fact. The upper bound is
  98.9% on A if every file took its best candidate, but no principled feature
  separates those cases. A ranker trained on so few would fit the
  development half.

Brute force needs a better score, not a larger search. The parts of the
idea that were measured to help were already in the reader: consistency
scoring, the restricted candidate set, and the separate detection of quoting.

## Reproduce

```sh
node bench/dialect/search-features.mjs bench/data/dialect/github B > features_B.jsonl
node bench/dialect/search-features.mjs path/to/flat-folder-of-csvs > features_fixtures.jsonl
python3 bench/dialect/search-rules.py --features features_B.jsonl --fixtures features_fixtures.jsonl
```
