"""
Create deterministic CSV files for Live Update manual and automated testing.

Run from Spyder or a terminal. The generated files are small on purpose:
they describe append-only success, partial final lines, duplicate timestamps,
schema/header changes, and restart/truncation scenarios.
"""

from __future__ import annotations

from pathlib import Path


OUTPUT_DIR = Path(__file__).with_name("generated_cases")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="")
    print(f"Wrote {path}")


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    write_text(
        OUTPUT_DIR / "normal_initial.csv",
        "time,temperature,pressure\n"
        "0,20.0,100.0\n"
        "1,20.5,100.2\n",
    )
    write_text(
        OUTPUT_DIR / "normal_appended.csv",
        "time,temperature,pressure\n"
        "0,20.0,100.0\n"
        "1,20.5,100.2\n"
        "2,21.0,100.4\n"
        "3,21.5,100.6\n",
    )
    write_text(
        OUTPUT_DIR / "partial_final_line.csv",
        "time,temperature,pressure\n"
        "0,20.0,100.0\n"
        "1,20.5,100.2\n"
        "2,21.0,",
    )
    write_text(
        OUTPUT_DIR / "duplicate_timestamp.csv",
        "time,temperature,pressure\n"
        "0,20.0,100.0\n"
        "1,20.5,100.2\n"
        "1,21.0,100.4\n",
    )
    write_text(
        OUTPUT_DIR / "equal_timestamp_changed_values.csv",
        "time,temperature,pressure\n"
        "0,20.0,100.0\n"
        "1,20.5,100.2\n"
        "1,99.9,199.9\n",
    )
    write_text(
        OUTPUT_DIR / "schema_changed.csv",
        "time,temperature,pressure,status\n"
        "0,20.0,100.0,ok\n"
        "1,20.5,100.2,ok\n"
        "2,21.0,100.4,ok\n",
    )
    write_text(
        OUTPUT_DIR / "header_changed.csv",
        "time,temp_c,pressure\n"
        "0,20.0,100.0\n"
        "1,20.5,100.2\n"
        "2,21.0,100.4\n",
    )
    write_text(
        OUTPUT_DIR / "truncated_restart.csv",
        "time,temperature,pressure\n"
        "0,18.0,99.0\n",
    )
    write_text(
        OUTPUT_DIR / "generated_index_initial.csv",
        "temperature,pressure\n"
        "20.0,100.0\n"
        "20.5,100.2\n",
    )
    write_text(
        OUTPUT_DIR / "generated_index_appended.csv",
        "temperature,pressure\n"
        "20.0,100.0\n"
        "20.5,100.2\n"
        "21.0,100.4\n"
        "21.5,100.6\n",
    )

    print("Live Update cases generated.")


if __name__ == "__main__":
    main()
