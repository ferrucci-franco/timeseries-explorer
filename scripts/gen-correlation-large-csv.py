#!/usr/bin/env python
"""Generate a LARGE CSV with known Pearson correlations, to exercise the
Correlation mode's lazy/DuckDB path in the browser (a small CSV loads eager).

Run with the mamba/conda Python that has numpy + pandas, e.g.:

    /c/Users/ferrucci/miniforge3/envs/spyder6/python.exe \
        scripts/gen-correlation-large-csv.py -n 3000000

Output goes to test-files/csv/correlation-large.csv by default (git-ignored;
this generator IS committed, the multi-hundred-MB CSV is not). Columns and their
expected correlation to the base signal A mirror test-files/csv/correlation-demo.csv:

    A_x2_plus5     = 2A + 5      -> r(A, .) = +1
    A_neg3_plus10  = -3A + 10    -> r(A, .) = -1
    A_strong       = A + noise   -> r(A, .) ~ +0.9
    A_weak         = 0.3A + noise-> r(A, .) ~ +0.2..0.5
    A_squared      = A^2         -> r(A, .) ~ 0   (nonlinear; Pearson blind)
    indep_B        = B           -> r(A, .) ~ 0   (independent)
    B_strong       = B + noise   -> r(indep_B, .) ~ +0.9
    constant_7     = 7           -> r undefined (zero variance)
    bool_A_pos     = 1 if A>0    -> r(A, .) ~ +0.9
    A_with_gaps    = A w/ ~6% NaN-> r(A, .) = +1 over the valid rows

Rows written in chunks so memory stays bounded for tens of millions of rows.
"""
import argparse
import os

import numpy as np
import pandas as pd

DEFAULT_OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "test-files", "csv", "correlation-large.csv",
)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("-n", "--rows", type=int, default=3_000_000, help="number of rows (default 3,000,000)")
    ap.add_argument("-o", "--out", default=DEFAULT_OUT, help="output CSV path")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--chunk", type=int, default=500_000, help="rows per write chunk")
    args = ap.parse_args()

    n = int(args.rows)
    rng = np.random.default_rng(args.seed)
    start = np.datetime64("2024-01-01T00:00:00")
    step = np.timedelta64(10, "m")  # 10-minute sampling

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    written = 0
    first = True
    while written < n:
        m = min(args.chunk, n - written)
        i = np.arange(written, written + m)                 # global index -> continuous signals
        a = np.sin(2 * np.pi * i / 144) + 0.15 * rng.standard_normal(m)   # symmetric base
        b = np.sin(2 * np.pi * i / 97 + 1.3) + 0.15 * rng.standard_normal(m)  # different freq/phase

        a_gaps = a.copy()
        a_gaps[rng.random(m) < 0.06] = np.nan               # ~6% missing

        df = pd.DataFrame({
            "timestamp": start + i * step,
            "A": a,
            "A_x2_plus5": 2 * a + 5,
            "A_neg3_plus10": -3 * a + 10,
            "A_strong": a + 0.33 * rng.standard_normal(m),
            "A_weak": 0.3 * a + rng.standard_normal(m),
            "A_squared": a * a,
            "indep_B": b,
            "B_strong": b + 0.33 * rng.standard_normal(m),
            "constant_7": np.full(m, 7.0),
            "bool_A_pos": (a > 0).astype(np.int8),
            "A_with_gaps": a_gaps,
        })
        df.to_csv(args.out, mode="w" if first else "a", header=first, index=False,
                  float_format="%.4f", na_rep="", date_format="%Y-%m-%d %H:%M:%S")
        first = False
        written += m
        print(f"  {written:,}/{n:,} rows", end="\r", flush=True)

    size_mb = os.path.getsize(args.out) / (1024 * 1024)
    print(f"\nwrote {args.out}  ({n:,} rows, {size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
