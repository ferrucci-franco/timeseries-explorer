# Integral fixtures: gaps, missing values and irregular sampling

Fixtures for auditing how `Data tools > Integral` behaves when the time axis is
not a clean constant step.

## The signal

Every file (except `09` and `10`) samples the same triangular power pulse, in kW,
over 0..7200 s:

```
P(t) = 0                    t <= 1800
     = (t - 1800) / 15       1800 < t <= 2700    (0 -> 60 kW)
     = (3600 - t) / 15       2700 < t <  3600    (60 -> 0 kW)
     = 0                     t >= 3600
```

It is piecewise linear with breakpoints at 1800, 2700 and 3600 s, all multiples
of the 60 s sampling step. **The trapezoidal rule is therefore exact on the
complete data**, and the reference value is

```
integral = 0.5 * 1800 s * 60 kW = 54000 kW*s = 15 kWh
```

Any deviation from 54000 is produced by the tool, not by discretisation error.
`10_gap_hides_pulse.csv` uses a narrower pulse worth 18000 kW*s;
`09_dst_spring_forward.csv` is a flat 60 kW over 121 contiguous minutes,
i.e. 435600 kW*s.

## Files

| File | Case | Description |
| --- | --- | --- |
| `01_baseline_regular.csv` | reference | 60 s step, no gaps, no missing values. |
| `02_irregular_timestep_genuine.csv` | (a) | Non-constant step, but every row is a real measurement and every breakpoint is sampled. |
| `03_constant_step_missing_rows.csv` | (b) | 60 s step; the rows from 2040 s to 3360 s are simply absent from the file. |
| `04_constant_step_missing_values.csv` | (b') | Same span missing, but the rows exist with an empty value cell. |
| `05_jitter_no_gaps.csv` | (c) | Nominal 60 s step with +/-2 s jitter; nothing is missing. |
| `06_jitter_with_missing_rows.csv` | (d) | Jitter *and* the 2040..3360 s gap. |
| `07_duplicate_timestamps.csv` | extra | Repeated timestamps (dt = 0). |
| `08_unsorted_timestamps.csv` | extra | A block of rows out of chronological order (dt < 0). |
| `09_dst_spring_forward.csv` | extra | Local wall-clock timestamps across Europe/Madrid 2024-03-31 02:00 -> 03:00. The 1 h jump is *not* missing data. |
| `10_gap_hides_pulse.csv` | extra | The gap spans a whole event and both endpoints read 0 kW. |
| `11_elapsed_seconds_missing_rows.csv` | extra | Same gap as `03` with a numeric elapsed-seconds abscissa. |
| `12_no_time_column.csv` | extra | Same rows as `03` with no time column: the abscissa is the row index. |
| `13_multimodal_step_balanced.csv` | (e) | The sampling RATE changes mid-file: 300 s where the signal is flat, 60 s across the pulse. Nothing is missing. |
| `14_multimodal_step_skewed.csv` | (e) | Same idea with the fine rate dominating the count: 60 s for the first hour, 600 s after. |

## Measured behaviour

Results of running `computeIntegral` (`src/compute/kernels/integral.js`) on each
file. Units kW*s.

| File | trapezoidal | rectangular | true | error |
| --- | ---: | ---: | ---: | ---: |
| `01` | 54000 | 54000 | 54000 | 0 % |
| `02` | 54000 | 54060 | 54000 | 0 % / +0.1 % |
| `03` | 24960 | 24960 | 54000 | **-53.8 %** |
| `04` | 3840 | 4800 | 54000 | **-92.9 %** |
| `05` | 54002 | 53999.5 | 54000 | ~0 % |
| `06` | 24921.9 | 24883.5 | 54000 | **-53.8 %** |
| `07` | 54000 | 54000 | 54000 | 0 % |
| `08` | 61320 | 46800 | 54000 | **+13.6 % / -13.3 %** (warns: 6 negative dt) |
| `09` | 648000 | 648000 | 435600 | **+48.8 %** |
| `10` | 0 | 0 | 18000 | **-100 %** |
| `11` | 24960 | 24960 | 54000 | **-53.8 %** |
| `12` | 80 | 80 | n/a | dimensionless; the gap is invisible |

## Missing/NaN detection

The same fixtures drive the `Missing/NaN` overlay. `detectSamplingGaps` first
decides whether the series has a nominal step at all; only then does it claim
gaps. `agreement` is the fraction of steps within 10 % of the median.

| File | median step | agreement | nominal step | reason | gaps | NaN runs |
| --- | ---: | ---: | --- | --- | ---: | ---: |
| `01` | 60 s | 100 % | yes | — | 0 | 0 |
| `02` | 300 s | 44 % | **no** | `irregularStep` | 0 | 0 |
| `03` | 60 s | 99 % | yes | — | 1 | 0 |
| `04` | 60 s | 100 % | yes | — | 0 | 1 |
| `05` | 60 s | 100 % | yes | — | 0 | 0 |
| `06` | 60 s | 99 % | yes | — | 1 | 0 |
| `07` | 60 s | 100 % | yes | — | 0 | 0 |
| `08` | — | — | **no** | `nonMonotonic` | 0 | 0 |
| `09` | 60 s | 99 % | yes | — | 1 | 0 |
| `10` | 60 s | 99 % | yes | — | 1 | 0 |
| `11` | 60 | 99 % | yes | — | 1 | 0 |
| `12` | 1 | 100 % | yes | — | 0 | 0 |
| `13` | 60 s | 63 % | **no** | `irregularStep` | 0 | 0 |
| `14` | 60 s | 91 % | yes | — | **6 (false)** | 0 |

`02`, `08` and `13` show no gap bands and raise a notice explaining why; their
NaN regions, if any, are still banded.

Two false positives remain, both by construction rather than by oversight:

- `09` — the DST jump is indistinguishable from a real hour of missing samples
  using the time vector alone.
- `14` — when a rate change leaves the fine rate dominant in COUNT, agreement
  stays above the gate and each coarse step is reported as a gap (9 phantom
  missing samples each). An agreement statistic cannot separate this from real
  dropouts; the structural difference is that a rate change produces a
  contiguous run of identical off-nominal steps, while dropouts are isolated.
  `13` and `14` are the same defect on either side of the threshold.

## Reading of the integral numbers

- **Absent rows (`03`, `06`, `11`)** are filled by a straight line between the
  surviving endpoints (trapezoidal) or by holding the last value (rectangular).
  `24960 = 3840 outside the gap + 21120 = (16+16)/2 * 1320 s` — exactly the
  linear interpolation.
- **Empty cells (`04`)** are not interpolated at all: every segment touching a
  NaN is dropped, so the whole gap contributes 0 and the cumulative curve
  flat-lines. `3840` is precisely the area outside the gap.
- **Irregular sampling and jitter (`02`, `05`) are not a problem in themselves** —
  they are accurate to ~0 %. Only missing data is.
- The result is **silent** in every case: no warning is raised except for the
  negative-dt case `08`.
