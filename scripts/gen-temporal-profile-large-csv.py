#!/usr/bin/env python3
"""Generate large calendar datasets for Temporal Profile lazy-mode testing.

The default (35 years at 5-minute resolution) creates three CSV files that are
each comfortably above the application's default 150 MB CSV lazy threshold:

  * temporal-profile-happy.csv: complete, finite, regular data
  * temporal-profile-nan.csv: explicit NaN samples (scattered and in blocks)
  * temporal-profile-gaps.csv: rows/timestamps omitted in deterministic blocks

Only Python's standard library is required. Use --years 1 --step-minutes 60 for
a quick functional fixture, or change the application's CSV full-load limit to
10 MB when testing smaller generated files through the lazy path.
"""

from __future__ import annotations

import argparse
import json
import math
from datetime import datetime, timedelta, timezone
from pathlib import Path


HEADER = "timestamp,load_kw,solar_kw,temperature_c\n"


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path,
                        default=Path(__file__).resolve().parents[1] / "test-files" / "csv" / "temporal-profile-lazy")
    parser.add_argument("--years", type=int, default=35,
                        help="Calendar span to generate (default: 35 years, enough to exceed the default lazy threshold).")
    parser.add_argument("--step-minutes", type=int, default=5,
                        help="Regular timestep in minutes (default: 5).")
    parser.add_argument("--start", default="2000-01-01T00:00:00+00:00",
                        help="ISO-8601 UTC start datetime.")
    parser.add_argument("--force", action="store_true", help="Overwrite existing generated files.")
    return parser.parse_args()


def parse_start(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def values_at(timestamp: datetime, index: int) -> tuple[float, float, float]:
    hour = timestamp.hour + timestamp.minute / 60.0
    day_angle = 2.0 * math.pi * timestamp.timetuple().tm_yday / 365.2425
    daily = math.sin(2.0 * math.pi * (hour - 7.0) / 24.0)
    weekday_factor = 0.86 if timestamp.weekday() >= 5 else 1.0
    load = weekday_factor * (42.0 + 9.0 * daily + 4.0 * math.cos(day_angle)) + 0.7 * math.sin(index * 0.017)
    solar_shape = max(0.0, math.sin(math.pi * (hour - 6.0) / 12.0))
    solar = solar_shape * (28.0 + 8.0 * math.sin(day_angle - 0.8))
    temperature = 17.0 + 8.0 * math.sin(day_angle - 1.2) + 3.0 * math.sin(2.0 * math.pi * (hour - 14.0) / 24.0)
    return load, solar, temperature


def nan_mask(index: int, timestamp: datetime, column: int) -> bool:
    # Isolated invalid values exercise per-bin coverage without losing a period.
    if (index + column * 131) % 10_007 == 0:
        return True
    # Eight-hour blocks exercise "Discard incomplete period" at different bins.
    return timestamp.timetuple().tm_yday in (47, 221) and timestamp.hour < 8 and column == 0


def timestamp_is_missing(timestamp: datetime, index: int) -> bool:
    # Six-hour gaps several times per year, including weekdays and weekends.
    day = timestamp.timetuple().tm_yday
    if day in (31, 149, 278) and 3 <= timestamp.hour < 9:
        return True
    # A sparse single-sample omission catches short-gap/boundary behavior.
    return index % 50_021 == 0


def csv_line(timestamp: datetime, values: tuple[float, float, float], nan_case: bool, index: int) -> str:
    formatted = []
    for column, value in enumerate(values):
        formatted.append("NaN" if nan_case and nan_mask(index, timestamp, column) else f"{value:.6f}")
    return f"{timestamp.strftime('%Y-%m-%dT%H:%M:%SZ')},{','.join(formatted)}\n"


def main() -> None:
    args = arguments()
    if args.years < 1:
        raise SystemExit("--years must be at least 1")
    if args.step_minutes < 1:
        raise SystemExit("--step-minutes must be at least 1")
    start = parse_start(args.start)
    end = start + timedelta(days=round(args.years * 365.2425))
    step = timedelta(minutes=args.step_minutes)
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "happy": output_dir / "temporal-profile-happy.csv",
        "nan": output_dir / "temporal-profile-nan.csv",
        "gaps": output_dir / "temporal-profile-gaps.csv",
    }
    existing = [path for path in paths.values() if path.exists()]
    if existing and not args.force:
        names = ", ".join(str(path) for path in existing)
        raise SystemExit(f"Refusing to overwrite: {names}. Pass --force to replace them.")

    handles = {name: path.open("w", encoding="utf-8", newline="", buffering=1024 * 1024)
               for name, path in paths.items()}
    rows = {name: 0 for name in paths}
    timestamp = start
    index = 0
    try:
        for handle in handles.values():
            handle.write(HEADER)
        while timestamp < end:
            values = values_at(timestamp, index)
            handles["happy"].write(csv_line(timestamp, values, False, index))
            handles["nan"].write(csv_line(timestamp, values, True, index))
            rows["happy"] += 1
            rows["nan"] += 1
            if not timestamp_is_missing(timestamp, index):
                handles["gaps"].write(csv_line(timestamp, values, False, index))
                rows["gaps"] += 1
            timestamp += step
            index += 1
            if index % 500_000 == 0:
                print(f"Generated {index:,} regular timestamps through {timestamp.isoformat()}", flush=True)
    finally:
        for handle in handles.values():
            handle.close()

    manifest = {
        "generatedAtUtc": datetime.now(timezone.utc).isoformat(),
        "startUtc": start.isoformat(),
        "endUtcExclusive": end.isoformat(),
        "years": args.years,
        "stepMinutes": args.step_minutes,
        "cases": {
            name: {"file": path.name, "rows": rows[name], "bytes": path.stat().st_size}
            for name, path in paths.items()
        },
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))
    print(f"\nFiles written to: {output_dir}")


if __name__ == "__main__":
    main()
