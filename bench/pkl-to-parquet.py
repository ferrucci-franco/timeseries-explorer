#!/usr/bin/env python3
"""Convert a pandas pickle (.pkl) dataframe to Parquet.

This is a preparation utility for pandas workflows. The viewer can open small
uncompressed pandas DataFrame/Series pickles directly, but pickle loading is
eager. For large or compressed pickles, convert to Parquet so the app can use
lazy DuckDB loading.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert a pandas DataFrame pickle to Parquet."
    )
    parser.add_argument("input", type=Path, help="Input .pkl/.pickle file")
    parser.add_argument(
        "output",
        type=Path,
        nargs="?",
        help="Output .parquet path (defaults to input name with .parquet)",
    )
    parser.add_argument(
        "--compression",
        default="zstd",
        choices=["zstd", "snappy", "gzip", "brotli", "none"],
        help="Parquet compression codec",
    )
    parser.add_argument(
        "--drop-index",
        action="store_true",
        help="Do not export the dataframe index as columns",
    )
    parser.add_argument(
        "--overwrite",
        "-f",
        action="store_true",
        help="Replace output if it already exists",
    )
    return parser.parse_args()


def flatten_column_label(label: object) -> str:
    if isinstance(label, tuple):
        parts = [str(part) for part in label if part is not None and str(part) != ""]
        return " / ".join(parts) if parts else "value"
    return str(label)


def make_unique(names: list[str]) -> list[str]:
    seen: dict[str, int] = {}
    out: list[str] = []
    for raw_name in names:
        base = raw_name.strip() or "column"
        count = seen.get(base, 0) + 1
        seen[base] = count
        out.append(base if count == 1 else f"{base}_{count}")
    return out


def normalize_dataframe(df, drop_index: bool):
    if drop_index:
        out = df.reset_index(drop=True).copy()
    else:
        out = df.reset_index()

    out.columns = make_unique([flatten_column_label(col) for col in out.columns])
    return out


def main() -> int:
    args = parse_args()
    input_path = args.input.resolve()
    output_path = (args.output or input_path.with_suffix(".parquet")).resolve()

    if not input_path.exists():
        print(f"error: input not found: {input_path}", file=sys.stderr)
        return 2
    if output_path.exists() and not args.overwrite:
        print(f"error: output already exists: {output_path}", file=sys.stderr)
        print("       pass --overwrite to replace it.", file=sys.stderr)
        return 2

    try:
        import pandas as pd
    except ImportError:
        print("error: pandas is required. Install pandas plus pyarrow or fastparquet.", file=sys.stderr)
        return 2

    try:
        df = pd.read_pickle(input_path)
    except Exception as exc:
        print(f"error: could not read pickle: {exc}", file=sys.stderr)
        return 1

    if not hasattr(df, "to_parquet"):
        print("error: pickle did not contain a pandas DataFrame-like object.", file=sys.stderr)
        return 1

    out = normalize_dataframe(df, drop_index=args.drop_index)
    compression = None if args.compression == "none" else args.compression

    try:
        out.to_parquet(output_path, index=False, compression=compression)
    except Exception as exc:
        print(f"error: could not write parquet: {exc}", file=sys.stderr)
        print("       Install pyarrow or fastparquet if no Parquet engine is available.", file=sys.stderr)
        return 1

    in_mb = input_path.stat().st_size / (1024 * 1024)
    out_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"Input:  {input_path} ({in_mb:.1f} MB)")
    print(f"Output: {output_path} ({out_mb:.1f} MB)")
    print(f"Rows:   {len(out):,}")
    print(f"Cols:   {len(out.columns):,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
