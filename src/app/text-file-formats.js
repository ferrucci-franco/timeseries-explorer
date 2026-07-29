// Which files are delimited text tables.
//
// The app has always treated `.csv` as the one text format worth special
// handling — the Parquet conversion offer required exactly that extension —
// even though the CSV reader itself never checked the extension and happily
// parsed `.txt` and anything else that sniffed as text. Measurement logs,
// Modelica CombiTimeTable files and instrument exports routinely use `.txt`,
// `.dat` or `.asc`, and DuckDB's read_csv does not care what the file is
// called either.
//
// Three answers rather than two, because the right behaviour differs:
//   'text'    known delimited-text extension — treat as a text table
//   'binary'  known container we must never feed to the text path
//   'unknown' no opinion; the caller may sniff the bytes or offer anyway
//
// Keeping 'unknown' separate from 'binary' is the point. A file called
// `measurements.log` should be allowed through; `results.mat` must not be.

export const TEXT_TABLE_EXTENSIONS = Object.freeze([
    '.csv',
    '.txt',
    '.text',
    '.tsv',
    '.tab',
    '.dat',
    '.asc',
    '.prn',
    '.log',
    '.out',
]);

// Recordings the app reads as one signal per channel.
//
// `.amr` and `.3gp` are here even though no browser ships an AMR decoder:
// they are what some Android voice recorders still produce, and accepting the
// file in order to say "no decoder for AMR — convert it to WAV" is more use
// than refusing it as an unknown extension and leaving the user guessing.
export const AUDIO_EXTENSIONS = Object.freeze([
    '.wav', '.wave',
    '.mp3',
    '.m4a', '.m4b', '.aac',
    '.flac',
    '.ogg', '.oga', '.opus',
    '.aif', '.aiff', '.aifc',
    '.caf',
    '.3gp', '.3gpp', '.amr',
    '.webm', '.weba',
]);

// Formats the app reads through a dedicated reader, plus common archives and
// media that would only ever be a mistake here. Parquet is on this list
// because it is binary and already has its own path.
export const BINARY_EXTENSIONS = Object.freeze([
    '.mat',
    '.parquet',
    '.pkl', '.pickle',
    '.nc', '.netcdf', '.cdf', '.h5', '.hdf5',
    '.xlsx', '.xlsm', '.xlsb', '.xls', '.ods',
    ...AUDIO_EXTENSIONS,
    '.zip', '.gz', '.bz2', '.xz', '.7z', '.rar', '.tar',
    '.png', '.jpg', '.jpeg', '.gif', '.pdf',
    '.exe', '.dll', '.so', '.dylib',
    '.json', '.xml',
]);

// Spreadsheets are binary, but unlike the rest of that list the app can turn
// one into a table — the chosen sheet becomes CSV text on the way in. Anything
// that offers to convert a file has to tell those two groups apart.
export const SPREADSHEET_EXTENSIONS = Object.freeze([
    '.xlsx', '.xlsm', '.xlsb', '.xls', '.ods',
]);

const TEXT = new Set(TEXT_TABLE_EXTENSIONS);
const BINARY = new Set(BINARY_EXTENSIONS);
const SPREADSHEET = new Set(SPREADSHEET_EXTENSIONS);
const AUDIO = new Set(AUDIO_EXTENSIONS);

const normalize = (extension) => String(extension || '').toLowerCase();

/** @returns {'text'|'binary'|'unknown'} */
export function classifyExtension(extension) {
    const ext = normalize(extension);
    // No extension at all is common for exported logs; it is not evidence of
    // a binary container.
    if (!ext) return 'unknown';
    if (TEXT.has(ext)) return 'text';
    if (BINARY.has(ext)) return 'binary';
    return 'unknown';
}

/** Known-good delimited text. */
export function isTextTableExtension(extension) {
    return classifyExtension(extension) === 'text';
}

/**
 * May this file be handled as a text table?
 *
 * True for known text extensions and for unrecognised ones — the latter because
 * refusing them is what forced people to rename files. False only for formats
 * we know are something else.
 */
export function mayBeTextTable(extension) {
    return classifyExtension(extension) !== 'binary';
}

/** A workbook the app can read a sheet out of. */
export function isSpreadsheetExtension(extension) {
    return SPREADSHEET.has(normalize(extension));
}

/** A recording the app reads as one signal per channel. */
export function isAudioExtension(extension) {
    return AUDIO.has(normalize(extension));
}
