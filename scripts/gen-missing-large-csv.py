#!/usr/bin/env python
"""Generate a ~100 MB CSV that stresses the "Missing/NaN" overlay with several
DIFFERENT kinds and densities of missing data, on a real datetime axis.

Run with the mamba/conda Python that has numpy + pandas, e.g.:

    /c/Users/ferrucci/miniforge3/envs/spyder6/python.exe \
        scripts/gen-missing-large-csv.py

Output goes to test-files/csv/missing-large.csv by default (git-ignored; this
generator IS committed, the ~100 MB CSV is not). At ~100 MB the file loads
LAZY by default and EAGER if you raise the size limit above ~100 MB, so it
exercises both paths.

Time axis: datetime column `timestamp`, start 2024-01-01, base step 1 minute,
EXCEPT inside a few "sampling gap" windows where whole rows are dropped so the
timestamps themselves jump (a true gap that affects every column at once).

Five value columns, each with a distinct missing pattern:

    sine_clean    : base sine, NO missing            -> control (no bands ever)
    sine_scatter  : ~1.5% single-sample NaN, uniform -> small missings here/there
    sine_blocks   : ~6 large contiguous NaN blocks    -> big missing sections
    cos_regional  : pattern depends on the time region (4 quarters):
                      Q1 none | Q2 ~1% scatter | Q3 ~12% dense | Q4 blocks
                    -> one trace that shows every level as you pan
    ramp_mixed    : ~1% scatter (written as the literal text "NaN") + 2 medium
                    blocks (written as empty cells) -> tests both missing spellings

Missing values are empty cells (na_rep="") except ramp_mixed's scatter, which
is the literal string "NaN" so the parser's handling of both is covered.

Rows are written in chunks so memory stays bounded.
"""
import argparse
import os

import numpy as np
import pandas as pd

DEFAULT_OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "test-files", "csv", "missing-large.csv",
)

# ── Missing-pattern layout, all in fractions of the total row count `n` ──
# Large NaN blocks for sine_blocks: (start_fraction, length_in_samples).
SINE_BLOCKS = [
    (0.08, 3_000), (0.22, 8_000), (0.40, 20_000),
    (0.55, 5_000), (0.70, 12_000), (0.88, 15_000),
]
# Two medium blocks for ramp_mixed.
RAMP_BLOCKS = [(0.30, 10_000), (0.65, 18_000)]
# Blocks inside cos_regional's Q4 (>= 0.75).
REGIONAL_Q4_BLOCKS = [(0.78, 8_000), (0.85, 12_000), (0.92, 6_000)]
# Sampling-gap windows: whole rows dropped -> the datetime axis jumps here.
SAMPLING_GAPS = [(0.15, 500), (0.45, 5_000), (0.60, 15_000), (0.82, 30_000)]

SCATTER_RATE = 0.015          # sine_scatter, everywhere
REGIONAL_Q2_RATE = 0.01       # cos_regional, [0.25, 0.50)
REGIONAL_Q3_RATE = 0.12       # cos_regional, [0.50, 0.75)  -> triggers "too dense"
RAMP_SCATTER_RATE = 0.01      # ramp_mixed, everywhere (literal "NaN")


def block_mask(i, n, windows):
    """Boolean mask: True where global index i falls inside any (frac, len) block."""
    mask = np.zeros(i.shape, dtype=bool)
    for frac, length in windows:
        start = int(frac * n)
        mask |= (i >= start) & (i < start + length)
    return mask


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-n", "--rows", type=int, default=1_900_000,
                    help="number of 1-minute steps before row drops (default 1,900,000 ~= 100 MB)")
    ap.add_argument("-o", "--out", default=DEFAULT_OUT, help="output CSV path")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--chunk", type=int, default=500_000, help="rows per write chunk")
    args = ap.parse_args()

    n = int(args.rows)
    rng = np.random.default_rng(args.seed)
    start = np.datetime64("2024-01-01T00:00:00")
    step = np.timedelta64(1, "m")  # 1-minute base sampling

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    i0 = 0
    first = True
    total_out = 0
    while i0 < n:
        m = min(args.chunk, n - i0)
        i = np.arange(i0, i0 + m)
        q = i / n  # time-region fraction in [0, 1)

        # ── Signals (continuous in the global index) ──
        sine_clean = np.sin(2 * np.pi * i / 1440) + 0.15 * rng.standard_normal(m)
        sine_scatter = np.sin(2 * np.pi * i / 1440) + 0.15 * rng.standard_normal(m)
        sine_blocks = np.sin(2 * np.pi * i / 997 + 1.3) + 0.15 * rng.standard_normal(m)
        cos_regional = np.cos(2 * np.pi * i / 720) + 0.15 * rng.standard_normal(m)
        frac = (i % 20000) / 20000.0
        ramp = 1.0 - 4.0 * np.abs(frac - 0.5)  # slow triangle in [-1, 1]
        ramp_mixed = ramp + 0.05 * rng.standard_normal(m)

        # ── Apply missing patterns ──
        # sine_clean: nothing.
        # sine_scatter: uniform scatter.
        sine_scatter[rng.random(m) < SCATTER_RATE] = np.nan
        # sine_blocks: big blocks.
        sine_blocks[block_mask(i, n, SINE_BLOCKS)] = np.nan
        # cos_regional: region-dependent.
        reg_scatter = rng.random(m)
        cos_regional[(q >= 0.25) & (q < 0.50) & (reg_scatter < REGIONAL_Q2_RATE)] = np.nan
        cos_regional[(q >= 0.50) & (q < 0.75) & (reg_scatter < REGIONAL_Q3_RATE)] = np.nan
        cos_regional[(q >= 0.75) & block_mask(i, n, REGIONAL_Q4_BLOCKS)] = np.nan

        # ramp_mixed: build as strings so scatter is the literal "NaN" and the
        # two blocks are empty cells.
        ramp_str = np.char.mod("%.4f", ramp_mixed).astype(object)
        ramp_str[rng.random(m) < RAMP_SCATTER_RATE] = "NaN"   # literal text
        ramp_str[block_mask(i, n, RAMP_BLOCKS)] = ""          # empty cell

        # ── Drop whole rows inside the sampling-gap windows ──
        keep = ~block_mask(i, n, SAMPLING_GAPS)

        df = pd.DataFrame({
            "timestamp": start + i * step,
            "sine_clean": sine_clean,
            "sine_scatter": sine_scatter,
            "sine_blocks": sine_blocks,
            "cos_regional": cos_regional,
            "ramp_mixed": ramp_str,
        })[keep]

        df.to_csv(args.out, mode="w" if first else "a", header=first, index=False,
                  float_format="%.4f", na_rep="", date_format="%Y-%m-%d %H:%M:%S")
        first = False
        total_out += int(keep.sum())
        i0 += m
        print(f"  {i0:,}/{n:,} steps ({total_out:,} rows written)", end="\r", flush=True)

    size_mb = os.path.getsize(args.out) / (1024 * 1024)
    span_days = (n - 1) / (60 * 24)
    print(f"\nwrote {args.out}")
    print(f"  {total_out:,} rows ({n - total_out:,} dropped in sampling gaps), "
          f"{size_mb:.1f} MB, span ~{span_days:.0f} days")


if __name__ == "__main__":
    main()
