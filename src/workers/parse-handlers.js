// Off-thread file parsing for every format the viewer accepts.
//
// Before this, only CSV was parsed in a worker (result-parser-worker.js).
// `.mat`, `.pkl`, `.nc` and spreadsheets all decoded synchronously on the UI
// thread — the Excel path in file-methods.js even documents "tens of seconds of
// blocked main thread" in its own comment.
//
// Each parser is imported dynamically so the first message does not drag
// h5wasm (4.4 MB) and the xlsx bundle (500 KB) into the worker regardless of
// which format was actually opened.
//
// Note on "chunked": genuine incremental parsing is only possible for CSV and
// Parquet, which already have it through DuckDB. A .mat v7.3 or a .xlsx must
// decompress its whole container before any column exists, so for those formats
// moving off-thread is the win available — it does not make them faster, it
// stops them freezing the interface.

import MatParser from '../parsers/mat-parser.js';

// The netCDF files being read by parts into the engine, by the id the main
// thread gave each one: a reader holds the file open (a mounted HDF5, a byte
// source) between one block and the next.
const columnarReaders = new Map();

let baseParser = null;
function getBaseParser() {
    // The format parsers all delegate shared normalization (data-type
    // detection, tree building) to this one.
    if (!baseParser) baseParser = new MatParser();
    return baseParser;
}

export const PARSE_HANDLERS = {
    'parse:csv': async ({ filename, buffer, csvProfile }) => {
        const { default: CsvParser } = await import('../parsers/csv-parser.js');
        const parser = new CsvParser();
        const data = csvProfile?.profileSource === 'user'
            ? await parser.parseWithProfile(buffer, csvProfile)
            : await parser.parse(buffer);
        data.filename = filename || '';
        return { result: data };
    },

    'parse:mat': async ({ filename, buffer, inspection, selection }) => {
        const { default: Parser } = await import('../parsers/matlab-mat-file.js');
        const parser = new Parser(getBaseParser());
        return { result: await parser.parse(buffer, filename, { inspection, selection }) };
    },

    'parse:pickle': async ({ filename, buffer, maxFileBytes }) => {
        const { default: Parser } = await import('../parsers/pickle-parser.js');
        const parser = new Parser(getBaseParser());
        return { result: await parser.parse(buffer, filename, { maxFileBytes }) };
    },

    // A File is read by parts here (never copied whole), and bounded by the
    // series it loads rather than by its size; a buffer is the old way.
    'parse:netcdf': async ({ filename, buffer, file, maxFileBytes, maxLoadBytes }) => {
        const { default: Parser } = await import('../parsers/netcdf-parser.js');
        const parser = new Parser(getBaseParser());
        if (file) return { result: await parser.parseFile(file, filename, { maxLoadBytes }) };
        return { result: await parser.parse(buffer, filename, { maxFileBytes }) };
    },

    // ─── A netCDF file by parts, for a memory-saving dataset ───────────────
    //
    // The file is read here because it can only be read here: FileReaderSync,
    // and the WORKERFS h5wasm is mounted on, exist in a worker and nowhere
    // else. DuckDB-WASM is on the main thread, so the blocks are handed over
    // one at a time, pulled: the ingest asks for the next only once it has
    // appended the last, which is what keeps this side from running ahead of
    // the engine. See src/data/netcdf-columns-client.js.
    'netcdf-columns:open': async ({ id, file, filename }) => {
        const { openNetcdfColumns } = await import('../parsers/netcdf-columns.js');
        const reader = await openNetcdfColumns({ file, filename }, { parser: getBaseParser(), filename });
        // Null is "not a file this reader takes": the caller opens it the way
        // it was always opened.
        if (!reader) return { result: null };
        columnarReaders.get(id)?.close();
        columnarReaders.set(id, reader);
        return { result: reader.description };
    },

    'netcdf-columns:block': async ({ id, rowStart, rows }) => {
        const reader = columnarReaders.get(id);
        if (!reader) throw Object.assign(new Error('The netCDF reader is no longer open.'), { code: 'COLUMNAR_NOT_OPEN' });
        const block = reader.readBlock(Number(rowStart) || 0, Number(rows) || 0);
        return { result: block, transfer: block.columns.map(column => column.buffer) };
    },

    'netcdf-columns:close': async ({ id }) => {
        columnarReaders.get(id)?.close();
        columnarReaders.delete(id);
        return { result: true };
    },

    'parse:microcap': async ({ filename, buffer }) => {
        const { default: Parser } = await import('../parsers/microcap-parser.js');
        const parser = new Parser(getBaseParser());
        return { result: await parser.parse(buffer, filename) };
    },

    // Spreadsheets are not parsed directly by the app: the chosen sheet is
    // serialized to deterministic CSV text and fed to the CSV pipeline. Both
    // halves of that (decoding the workbook, serializing the sheet) are the
    // expensive part, so both happen here. The sheet list comes back with it so
    // the picker dialog can be built without re-decoding on the main thread.
    'parse:excelToCsv': async ({ buffer, preferredSheet }) => {
        const excel = await import('../parsers/excel-workbook.js');
        const workbook = excel.readWorkbook(await excel.loadXlsxModule(), buffer);
        const sheets = excel.listSheets(workbook);
        // What the picker needs, and how a sheet too large to build is told
        // apart from an empty one — both of which the caller used to work out
        // by decoding the workbook itself, on the main thread.
        const unreadable = excel.unreadableSheetNames(workbook);
        const inventory = { sheets, unreadable, sheetNames: sheets.map(s => s.name) };
        const sheetName = resolveSheetName(sheets, preferredSheet);
        if (!sheetName || unreadable.includes(sheetName)) {
            return { result: { csvBuffer: null, sheetName: '', ...inventory } };
        }
        const csvBuffer = excel.csvTextToBuffer(excel.sheetToCsvText(workbook, sheetName));
        return {
            result: { csvBuffer, sheetName, ...inventory },
            transfer: [csvBuffer],
        };
    },
};

// Hand the parsed columns back by transfer instead of letting structured clone
// copy them. On a 590 MB source that is ~60 MB of Float64Array per file that
// would otherwise be duplicated on the way out of the worker and immediately
// discarded here. Only typed-array column data qualifies; anything the worker
// still needs is not in the result object by then.
export function collectColumnBuffers(result) {
    const buffers = new Set();
    const variables = result?.variables;
    if (!variables) return [];
    for (const key of Object.keys(variables)) {
        const buffer = variables[key]?.data?.buffer;
        // A subarray view shares its buffer with siblings; the Set dedupes, and
        // transferring a shared buffer once is correct because the whole file's
        // worth of views moves with it.
        if (buffer instanceof ArrayBuffer && buffer.byteLength > 0) buffers.add(buffer);
    }
    return [...buffers];
}

function resolveSheetName(sheets, preferred) {
    if (preferred && sheets.some(sheet => sheet.name === preferred)) return preferred;
    const withData = sheets.find(sheet => sheet.hasData !== false);
    return withData?.name || sheets[0]?.name || '';
}

// Serialized form of an error, preserving the fields the UI needs.
export function serializeWorkerError(err) {
    return {
        name: err?.name || 'Error',
        message: err?.message || String(err),
        code: err?.code || '',
        stack: err?.stack || '',
        // Parsers attach their own fields (pickle reports .format and .type)
        // and the UI turns them into translated messages, so a fixed
        // name/message pair would lose the diagnosis.
        details: ownProps(err),
    };
}

// Own enumerable properties of an Error, minus the ones already sent above.
function ownProps(err) {
    if (!err || typeof err !== 'object') return {};
    const out = {};
    for (const key of Object.keys(err)) {
        if (key === 'code' || key === 'stack' || key === 'message' || key === 'name') continue;
        const value = err[key];
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
    }
    return out;
}
