# Large files (≥ 500 MB)

The browser tab DuckDB-WASM runs inside has a hard memory ceiling of about
**3 GiB on Firefox / 4 GiB on Chrome**. Multi-GB CSV files do not fit there
during parsing (the parser needs the file *plus* intermediate state).

The viewer handles this in two complementary ways:

## 1. Best path — convert CSV → Parquet once, then load Parquet

Parquet is columnar, compressed, and supports projection / predicate
pushdown. A typical 1 GB CSV converts to ~100–200 MB of Parquet and queries
load roughly an order of magnitude faster from the browser.

A small Node script ships with the project:

```bash
# One-time setup (already done if you installed the project):
npm install

# Convert any CSV to Parquet (works offline, no browser memory cap):
node bench/csv-to-parquet.mjs path/to/big.csv

# Output goes alongside the input as big.parquet, ZSTD-compressed.
# Override target path / compression:
node bench/csv-to-parquet.mjs big.csv out/dest.parquet --compression snappy
node bench/csv-to-parquet.mjs big.csv --overwrite
```

The script uses native DuckDB (the `duckdb` devDependency) so there is no
WASM memory ceiling — even multi-GB CSVs convert in one go.

Once you have `big.parquet`, drop or open it in the viewer the same way you
would a CSV. The viewer auto-detects the extension, registers the file with
DuckDB-WASM in lazy mode, and routes all zoom queries through the columnar
file directly. No further conversion needed.

## 2. Other conversion options

If you prefer not to use the Node script:

```bash
# DuckDB CLI (https://duckdb.org/docs/installation/):
duckdb -c "COPY (SELECT * FROM read_csv_auto('big.csv')) TO 'big.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)"

# Python with pandas + pyarrow:
python -c "import pandas as pd; pd.read_csv('big.csv').to_parquet('big.parquet', compression='zstd')"
```

The viewer accepts any Parquet that conforms to the same schema your
original CSV did (time column + numeric columns).

## 3. Falling back: load the CSV directly

The viewer will still try to open a > 500 MB CSV through the lazy DuckDB
path. It works for files that comfortably fit DuckDB's WASM budget
(roughly: numeric-only CSVs up to ~700 MB on Firefox, ~1 GB on Chrome).
Above that the load may fail with a memory error — at which point the
console warning instructs you to convert to Parquet using one of the
commands above.

## When NOT to bother

For files under ~500 MB the lazy DuckDB-WASM path handles CSV directly.
There is no benefit to converting first — the viewer already
materializes a downsampled overview in memory and queries the full file
on zoom-in. See [bench/baseline.md](../bench/baseline.md) for measured
timings.
