#!/usr/bin/env python
"""Generate small Parquet time-series fixtures with MultiIndex columns.

The three output files contain the same DatetimeIndex and 1,000 samples, but
their signal columns have respectively 2, 3, and 4 MultiIndex levels. Run from
a terminal or automation job with:

    mamba run -n thesys_01 python scripts/gen-multiindex-parquet.py

Files are written to ``test-files/parquet`` by default.  Use ``--out-dir`` or
``--rows`` to override those defaults.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT_DIR = REPO_ROOT / "test-files" / "parquet"


def column_tuples(levels: int) -> tuple[list[str], list[tuple[str, ...]]]:
    """Return meaningful, unique labels for the requested column depth."""
    if levels == 2:
        return ["asset", "variable"], [
            ("generator_01", "power"),
            ("generator_01", "temperature"),
            ("load_01", "power"),
            ("load_01", "voltage"),
        ]
    if levels == 3:
        return ["area", "asset", "variable"], [
            ("north", "generator_01", "power"),
            ("north", "generator_01", "temperature"),
            ("south", "load_01", "power"),
            ("south", "load_01", "voltage"),
        ]
    if levels == 4:
        return ["scenario", "area", "asset", "variable"], [
            ("base", "north", "generator_01", "power"),
            ("base", "north", "generator_01", "temperature"),
            ("stress", "south", "load_01", "power"),
            ("stress", "south", "load_01", "voltage"),
        ]
    raise ValueError("levels must be 2, 3, or 4")


def make_frame(rows: int, levels: int, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed + levels)
    sample = np.arange(rows, dtype=float)
    data = np.column_stack(
        [
            50 + 8 * np.sin(2 * np.pi * sample / 144),
            20 + 3 * np.cos(2 * np.pi * sample / 288),
            35 + 5 * np.sin(2 * np.pi * sample / 96 + 0.7),
            230 + 2 * np.cos(2 * np.pi * sample / 72) + rng.normal(0, 0.15, rows),
        ]
    )
    names, tuples = column_tuples(levels)
    columns = pd.MultiIndex.from_tuples(tuples, names=names)
    index = pd.date_range("2026-01-01", periods=rows, freq="5min", name="timestamp")
    return pd.DataFrame(data, index=index, columns=columns)


def make_all_frames(rows: int = 1000, seed: int = 42) -> dict[int, pd.DataFrame]:
    if not 1 <= rows <= 1000:
        raise ValueError("rows must be between 1 and 1000")
    return {levels: make_frame(rows, levels, seed) for levels in (2, 3, 4)}


def write_frames(
    frames_to_write: dict[int, pd.DataFrame],
    out_dir: Path = DEFAULT_OUT_DIR,
) -> list[Path]:
    destination = Path(out_dir).expanduser().resolve()
    destination.mkdir(parents=True, exist_ok=True)
    outputs = []
    for levels, frame in frames_to_write.items():
        output = destination / f"timeseries-multiindex-{levels}-levels.parquet"
        frame.to_parquet(output, engine="pyarrow", compression="snappy", index=True)
        outputs.append(output)
        print(f"wrote {output} ({len(frame):,} rows, {levels} column levels)")
    return outputs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("-n", "--rows", type=int, default=1000, help="samples per file (default: 1000)")
    parser.add_argument("-o", "--out-dir", type=Path, default=DEFAULT_OUT_DIR, help="output directory")
    parser.add_argument("--seed", type=int, default=42, help="random seed")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not 1 <= args.rows <= 1000:
        raise SystemExit("--rows must be between 1 and 1000")

    cli_frames = make_all_frames(args.rows, args.seed)
    write_frames(cli_frames, args.out_dir)


if __name__ == "__main__":
    main()
