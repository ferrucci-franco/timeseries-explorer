"""
Simulate a growing CSV/text result file for OpenModelica Viewer Live Update.

Open this file in Spyder, edit the USER CONFIG section, and run it.
The script copies an initial part of SOURCE_FILE into OUTPUT_FILE, then appends
one data row at a time according to the timestamp column.
"""

from __future__ import annotations

import csv
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path


# =========================
# USER CONFIG
# =========================

# Source file with the complete data.
SOURCE_FILE = r"C:\path\to\complete_result.csv"

# File watched by OpenModelica Viewer Live Update.
OUTPUT_FILE = r"C:\path\to\live_result.csv"

# Time column: use an integer index, or a column name when the file has header.
TIME_COLUMN = 0

# Initial load. If INITIAL_END_TIME is not None, all rows with timestamp <= this
# value are written before live appending starts. Otherwise INITIAL_ROWS is used.
INITIAL_END_TIME = None
INITIAL_ROWS = 10

# Playback speed. 1.0 means real timestamp spacing, 10.0 means 10x faster.
TIME_ACCELERATION = 1.0

# Optional cap so large gaps do not make the script sleep too long.
# Set to None to use the exact timestamp spacing.
MAX_WAIT_SECONDS = 5.0

# Overwrite OUTPUT_FILE at startup.
RESET_OUTPUT = True

# Repeat from the beginning after the last row.
LOOP = False

# Ignore empty lines and comment lines while detecting data rows.
COMMENT_PREFIXES = ("#",)


@dataclass(frozen=True)
class DataRow:
    line_index: int
    text: str
    timestamp: float


def parse_timestamp(value: str) -> float:
    value = value.strip().strip('"').strip("'")
    if not value:
        raise ValueError("empty timestamp")

    normalized = value.replace(",", ".") if "," in value and "." not in value else value
    try:
        return float(normalized)
    except ValueError:
        pass

    iso_value = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        return datetime.fromisoformat(iso_value).timestamp()
    except ValueError:
        pass

    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y"):
        try:
            return datetime.strptime(value, fmt).timestamp()
        except ValueError:
            continue

    raise ValueError(f"cannot parse timestamp: {value!r}")


def detect_dialect(lines: list[str]) -> csv.Dialect:
    sample = "".join(line for line in lines[:50] if line.strip())
    try:
        return csv.Sniffer().sniff(sample, delimiters=",;\t ")
    except csv.Error:
        return csv.get_dialect("excel")


def parse_fields(line: str, dialect: csv.Dialect) -> list[str]:
    if getattr(dialect, "delimiter", ",") == " ":
        return line.strip().split()
    return next(csv.reader([line], dialect))


def is_ignored(line: str) -> bool:
    stripped = line.strip()
    return not stripped or any(stripped.startswith(prefix) for prefix in COMMENT_PREFIXES)


def find_time_column(fields: list[str]) -> int:
    if isinstance(TIME_COLUMN, int):
        if TIME_COLUMN < 0 or TIME_COLUMN >= len(fields):
            raise ValueError(f"TIME_COLUMN index {TIME_COLUMN} is outside the row")
        return TIME_COLUMN

    wanted = str(TIME_COLUMN).strip().lower()
    for index, name in enumerate(fields):
        if name.strip().lower() == wanted:
            return index
    raise ValueError(f"TIME_COLUMN name {TIME_COLUMN!r} was not found in the header")


def load_rows(path: Path) -> tuple[list[str], list[DataRow]]:
    lines = path.read_text(encoding="utf-8-sig").splitlines(keepends=True)
    dialect = detect_dialect(lines)

    candidate_indices = [i for i, line in enumerate(lines) if not is_ignored(line)]
    if not candidate_indices:
        raise ValueError("source file has no data rows")

    first_index = candidate_indices[0]
    first_fields = parse_fields(lines[first_index], dialect)
    time_column = find_time_column(first_fields)

    has_header = not isinstance(TIME_COLUMN, int)
    if isinstance(TIME_COLUMN, int):
        try:
            parse_timestamp(first_fields[time_column])
        except ValueError:
            has_header = True

    data_start_index = first_index + 1 if has_header else first_index
    prefix = lines[:data_start_index]
    rows: list[DataRow] = []

    for index in range(data_start_index, len(lines)):
        line = lines[index]
        if is_ignored(line):
            continue
        fields = parse_fields(line, dialect)
        if time_column >= len(fields):
            raise ValueError(f"line {index + 1} does not contain time column {time_column}")
        rows.append(DataRow(index, line, parse_timestamp(fields[time_column])))

    if not rows:
        raise ValueError("source file has a header but no data rows")
    return prefix, rows


def initial_row_count(rows: list[DataRow]) -> int:
    if INITIAL_END_TIME is not None:
        cutoff = parse_timestamp(str(INITIAL_END_TIME))
        return sum(1 for row in rows if row.timestamp <= cutoff)
    return max(0, min(int(INITIAL_ROWS), len(rows)))


def write_lines(path: Path, lines: list[str], mode: str) -> None:
    with path.open(mode, encoding="utf-8", newline="") as handle:
        handle.writelines(lines)
        handle.flush()


def sleep_for_timestamp_delta(previous: float, current: float) -> None:
    acceleration = max(float(TIME_ACCELERATION), 0.000001)
    wait_seconds = max(0.0, (current - previous) / acceleration)
    if MAX_WAIT_SECONDS is not None:
        wait_seconds = min(wait_seconds, float(MAX_WAIT_SECONDS))
    if wait_seconds > 0:
        time.sleep(wait_seconds)


def run_once(prefix: list[str], rows: list[DataRow], output_path: Path) -> None:
    count = initial_row_count(rows)
    initial_lines = prefix + [row.text for row in rows[:count]]
    write_lines(output_path, initial_lines, "w" if RESET_OUTPUT else "a")
    print(f"Initial load: {count} row(s) written to {output_path}")

    previous_time = rows[count - 1].timestamp if count else rows[0].timestamp
    for row in rows[count:]:
        sleep_for_timestamp_delta(previous_time, row.timestamp)
        write_lines(output_path, [row.text], "a")
        previous_time = row.timestamp
        print(f"Appended source line {row.line_index + 1} at t={row.timestamp:g}")


def main() -> None:
    source_path = Path(SOURCE_FILE).expanduser()
    output_path = Path(OUTPUT_FILE).expanduser()
    if not source_path.is_file():
        raise FileNotFoundError(f"SOURCE_FILE does not exist: {source_path}")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    prefix, rows = load_rows(source_path)
    while True:
        run_once(prefix, rows, output_path)
        if not LOOP:
            break
        print("Loop enabled: restarting from the first row.")

    print("Done.")


if __name__ == "__main__":
    main()
