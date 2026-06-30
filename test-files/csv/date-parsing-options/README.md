# CSV date parsing option fixtures

Small files for manually testing `Adjust CSV parsing`. Every CSV has at most 10 lines.

- `01_iso_ymd_datetime.csv`: single datetime column, `yyyy-MM-dd HH:mm:ss`.
- `02_eu_dmy_slash_datetime.csv`: single datetime column, `dd/MM/yyyy HH:mm`.
- `03_us_mdy_slash_datetime.csv`: single datetime column, `MM/dd/yyyy hh:mm`.
- `04_spanish_month_names.csv`: Spanish month names/abbreviations.
- `05_french_month_names_semicolon.csv`: French month names, semicolon delimiter, decimal comma.
- `06_italian_month_names.csv`: Italian month names/abbreviations.
- `07_portuguese_month_names.csv`: Portuguese month names/abbreviations.
- `08_dirty_preamble_blank_lines.csv`: useless preamble plus blank lines before/inside data.
- `09_year_only.csv`: date/time parts mode, year only.
- `10_month_only.csv`: date/time parts mode, month only.
- `11_year_month_parts.csv`: date/time parts mode, year + month.
- `12_year_month_day_parts.csv`: date/time parts mode, year + month + day.
- `13_hour_values_as_index.csv`: numeric `0..24` hour-like column intended as an existing index, not a clock datetime.
- `14_existing_index_repeated.csv`: existing monotonic index column with repeated values.
- `15_separate_date_time_columns.csv`: separate date and clock time columns.

