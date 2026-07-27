#!/usr/bin/env python
"""Generate the large synthetic fixtures used by the performance benchmarks.

Output goes to bench/data/ (git-ignored, regenerable). One dataset shape is
rendered into every format the viewer accepts, at three sizes, so a benchmark
number for .mat is comparable to the same number for .csv.

    python scripts/gen-perf-fixtures.py                # all formats, all tiers
    python scripts/gen-perf-fixtures.py --tier small   # one tier
    python scripts/gen-perf-fixtures.py --format csv parquet
    python scripts/gen-perf-fixtures.py --list         # show plan, write nothing

Requires the mambaforge "thesys" env (numpy, pandas, scipy, pyarrow, h5py,
netCDF4, xlsxwriter).

The signal content is deliberately hostile to the code under test:
  * spikes        -> the outlier detector has real work, not a flat array
  * NaN gaps      -> every kernel's non-finite branch is exercised
  * repeated t    -> Delta t == 0, which the derivative path must survive
  * a time jump   -> a gap, so time-aware integration is not trivially uniform
Values are generated from a fixed seed, so every tier is byte-reproducible.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "bench" / "data"

# Row counts chosen so the CSV rendering lands near 10 / 100 / 500 MB with the
# 9 numeric columns below (~69 bytes/row measured). Every other format reuses
# the same row count rather than the same byte size, so the tiers stay
# comparable across formats.
TIERS = {
    "small": 150_000,
    "medium": 1_500_000,
    "large": 7_500_000,
}

# Excel tops out at 1_048_576 rows including the header. The large tier simply
# cannot exist in this format; we cap and say so rather than writing a
# truncated file that silently benchmarks the wrong thing.
XLSX_MAX_DATA_ROWS = 1_048_575

SIGNALS = [
    "motor.speed",
    "motor.torque",
    "grid.voltage",
    "grid.current",
    "battery.soc",
    "battery.temp",
    "load.power",
    "ambient.temp",
    "controller.error",
]

ALL_FORMATS = ["csv", "parquet", "mat", "pkl", "nc", "xlsx"]

SAMPLE_PERIOD = 0.01  # seconds


def build_dataset(n_rows: int, seed: int = 20260726):
    """Return (time, {name: values}) as float64 arrays of length n_rows."""
    rng = np.random.default_rng(seed)
    t = np.arange(n_rows, dtype=np.float64) * SAMPLE_PERIOD

    # A gap in the middle: everything after the midpoint slips by 5 s, so the
    # sampling is not uniform and time-aware kernels cannot shortcut.
    mid = n_rows // 2
    t[mid:] += 5.0
    # A handful of repeated timestamps (Delta t == 0) near the 30% mark.
    dup_at = int(n_rows * 0.3)
    if n_rows > 100:
        t[dup_at : dup_at + 5] = t[dup_at]

    columns: dict[str, np.ndarray] = {}
    for i, name in enumerate(SIGNALS):
        phase = 0.7 * i
        base = (
            50.0 * np.sin(2.0 * np.pi * 0.05 * t + phase)
            + 12.0 * np.sin(2.0 * np.pi * 0.9 * t + phase * 2.0)
            + 0.002 * t * (i + 1)  # slow drift, one per signal
            + 100.0 * (i + 1)  # per-signal offset so ranges differ
        )
        noise = rng.normal(0.0, 1.5, n_rows)
        values = base + noise

        # ~0.05% isolated spikes, amplitude 15-40 sigma. This is what the spike
        # detector is supposed to find.
        n_spikes = max(1, int(n_rows * 0.0005))
        spike_idx = rng.choice(n_rows, size=n_spikes, replace=False)
        spike_mag = rng.uniform(15.0, 40.0, n_spikes) * 1.5
        values[spike_idx] += spike_mag * rng.choice([-1.0, 1.0], n_spikes)

        # ~0.02% NaN gaps, in short runs, on a different set of columns each
        # time so not every row is dirty.
        if i % 3 == 0:
            n_gaps = max(1, int(n_rows * 0.0002))
            gap_starts = rng.choice(max(1, n_rows - 8), size=n_gaps, replace=False)
            for start in gap_starts:
                values[start : start + rng.integers(1, 6)] = np.nan

        columns[name] = values

    return t, columns


def report(path: Path, started: float) -> None:
    size_mb = path.stat().st_size / (1024 * 1024)
    print(f"  wrote {path.name:<34} {size_mb:8.1f} MB  ({time.time() - started:5.1f}s)")


def write_csv(path: Path, t, columns) -> None:
    import pandas as pd

    started = time.time()
    frame = pd.DataFrame({"time": t, **columns})
    frame.to_csv(path, index=False, float_format="%.6g", lineterminator="\n")
    report(path, started)


def write_parquet(path: Path, t, columns) -> None:
    import pyarrow as pa
    import pyarrow.parquet as pq

    started = time.time()
    table = pa.table({"time": t, **columns})
    pq.write_table(table, path, compression="zstd")
    report(path, started)


def write_mat(path: Path, t, columns, n_rows: int) -> None:
    """v5 for the two smaller tiers, v7.3/HDF5 for large (v5 caps near 2 GB)."""
    started = time.time()
    # MATLAB identifiers cannot contain dots; the viewer treats underscores the
    # same way for tree grouping.
    payload = {"time": t.reshape(-1, 1)}
    for name, values in columns.items():
        payload[name.replace(".", "_")] = values.reshape(-1, 1)

    if n_rows >= TIERS["large"]:
        import h5py

        # MAT v7.3 is HDF5 with a specific userblock header.
        with h5py.File(path, "w", userblock_size=512) as handle:
            for key, values in payload.items():
                handle.create_dataset(key, data=values.T, compression=None)
        header = (
            f"MATLAB 7.3 MAT-file, Platform: PCWIN64, "
            f"Created by scripts/gen-perf-fixtures.py"
        ).ljust(116)[:116].encode("ascii")
        with open(path, "r+b") as handle:
            handle.write(header + b"\x00\x00\x00\x00" + b"\x00\x02IM")
    else:
        from scipy.io import savemat

        savemat(path, payload, do_compression=False, format="5")
    report(path, started)


def write_pickle(path: Path, t, columns) -> None:
    import pandas as pd

    started = time.time()
    frame = pd.DataFrame(columns, index=pd.Index(t, name="time"))
    # Uncompressed on purpose: the viewer only reads uncompressed pickles
    # directly (see docs/large-files.md).
    frame.to_pickle(path, compression=None, protocol=4)
    report(path, started)


def write_netcdf(path: Path, t, columns) -> None:
    import netCDF4

    started = time.time()
    with netCDF4.Dataset(path, "w", format="NETCDF4") as ds:
        ds.createDimension("time", len(t))
        time_var = ds.createVariable("time", "f8", ("time",))
        time_var.units = "seconds since 2026-01-01 00:00:00"
        time_var[:] = t
        for name, values in columns.items():
            var = ds.createVariable(name.replace(".", "_"), "f8", ("time",))
            var.units = "unit"
            var[:] = values
    report(path, started)


def write_xlsx(path: Path, t, columns, n_rows: int) -> None:
    import xlsxwriter

    started = time.time()
    capped = min(n_rows, XLSX_MAX_DATA_ROWS)
    if capped < n_rows:
        print(
            f"  note: xlsx capped at {capped:,} rows "
            f"(format maximum is {XLSX_MAX_DATA_ROWS:,}); requested {n_rows:,}"
        )
    book = xlsxwriter.Workbook(str(path), {"constant_memory": True})
    sheet = book.add_worksheet("data")
    sheet.write_row(0, 0, ["time", *columns.keys()])
    names = list(columns)
    # constant_memory mode requires strictly increasing row order.
    for row in range(capped):
        sheet.write_number(row + 1, 0, float(t[row]))
        for col, name in enumerate(names, start=1):
            value = columns[name][row]
            if np.isnan(value):
                sheet.write_blank(row + 1, col, None)
            else:
                sheet.write_number(row + 1, col, float(value))
    book.close()
    report(path, started)


WRITERS = {
    "csv": lambda p, t, c, n: write_csv(p, t, c),
    "parquet": lambda p, t, c, n: write_parquet(p, t, c),
    "mat": write_mat,
    "pkl": lambda p, t, c, n: write_pickle(p, t, c),
    "nc": lambda p, t, c, n: write_netcdf(p, t, c),
    "xlsx": write_xlsx,
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tier", nargs="*", choices=sorted(TIERS), default=sorted(TIERS))
    parser.add_argument("--format", nargs="*", choices=ALL_FORMATS, default=ALL_FORMATS)
    parser.add_argument("--list", action="store_true", help="print the plan and exit")
    parser.add_argument("--force", action="store_true", help="rewrite existing files")
    args = parser.parse_args()

    # Deterministic tier order regardless of argparse ordering.
    tiers = [name for name in ("small", "medium", "large") if name in args.tier]

    if args.list:
        for tier in tiers:
            print(f"{tier}: {TIERS[tier]:,} rows x {len(SIGNALS)} signals -> {args.format}")
        return 0

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for tier in tiers:
        n_rows = TIERS[tier]
        print(f"\n== tier {tier}: {n_rows:,} rows x {len(SIGNALS)} signals ==")
        targets = {
            fmt: OUT_DIR / f"perf-{tier}.{fmt}"
            for fmt in args.format
            if fmt in WRITERS
        }
        pending = {
            fmt: path
            for fmt, path in targets.items()
            if args.force or not path.exists()
        }
        for fmt, path in targets.items():
            if fmt not in pending:
                print(f"  skip  {path.name} (exists; --force to rewrite)")
        if not pending:
            continue

        built = time.time()
        t, columns = build_dataset(n_rows)
        print(f"  built arrays in {time.time() - built:.1f}s")

        for fmt, path in pending.items():
            try:
                WRITERS[fmt](path, t, columns, n_rows)
            except Exception as err:  # keep going; one bad format is not fatal
                print(f"  FAIL  {path.name}: {type(err).__name__}: {err}")
                if path.exists():
                    path.unlink()

        del t, columns

    print(f"\nfixtures in {OUT_DIR}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
