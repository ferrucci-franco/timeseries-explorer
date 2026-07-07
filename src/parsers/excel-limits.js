// Spreadsheet files are zip archives that SheetJS expands fully in memory
// (roughly 10-20x the compressed size), so the eager limits sit well below
// the CSV/Parquet thresholds.
export const EXCEL_WEB_EAGER_LIMIT_BYTES = 50 * 1024 * 1024;
export const EXCEL_DESKTOP_EAGER_LIMIT_BYTES = 150 * 1024 * 1024;
export const EXCEL_DEFAULT_EAGER_LIMIT_BYTES = EXCEL_WEB_EAGER_LIMIT_BYTES;
