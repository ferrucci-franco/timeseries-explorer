/**
 * CSV result parser.
 *
 * Expected format:
 *   time,variable_a,variable_b
 *   0,1.2,3.4
 *   0.1,1.3,3.5
 *
 * The first non-empty row is the header. The parser detects a time vector from
 * common time headers, including split Date + Time columns. If no explicit time
 * columns are found, it generates a zero-based index abscissa. Headerless
 * numeric files are also supported; column names are generated automatically.
 */
import MatParser from './mat-parser.js';
import { detectCsvTimeAxis, isMonthNameDateCell, looksLikeUnitText, parseCsvNumber, parseCsvTimeValue } from './csv-time-detection.js';
import { columnSampleCounts, forcedColumnTypes, isMissingNumberCell, isMostlyNumericColumn } from './csv-column-types.js';
import { inlineUnitSplitCollides } from '../utils/inline-unit-headers.js';
import { buildCsvTree, resolveCsvGrouping } from './csv-tree-grouping.js';
import { repeatedTimestampSummary } from '../utils/repeated-timestamps.js';
import {
    csvNumberFormat,
    decodeCsvBytes,
    detectLineEnding,
    trimmedTableWidth,
    detectCsvNumberFormat,
    fitCsvRowToWidth,
    fitCsvTableRows,
    minimumRowWidth,
    normalizeRaggedRowPolicy,
    sanitizeCsvText,
} from './csv-text-normalize.js';

// Delimiters tried when a file does not say. '|' is what database dumps and
// several SCADA exports use; it never appears inside a number or a date.
const DELIMITER_CANDIDATES = [',', ';', '\t', '|', 'whitespace'];
// A quoted field longer than this, or spanning more lines, is not one: its
// opening quote was a stray character (5" for inches, a PLC string field cut
// short), and honouring it would swallow the rest of the file into one cell.
const MAX_QUOTED_FIELD_CHARS = 65536;
const MAX_QUOTED_FIELD_LINES = 100;
// How much more consistent (CleverCSV's Q) another delimiter must read the
// sample than the table reading's choice before it replaces it.
const CONSISTENCY_OVERRIDE = 1.25;

// "[m/s]" -> "m/s": a units row that writes its units in brackets would
// otherwise become "[[m/s]]" in the description.
export function stripUnitBrackets(unit) {
    const match = String(unit).match(/^\[([^\[\]]+)\]$|^\(([^()]+)\)$|^\{([^{}]+)\}$/);
    return match ? (match[1] ?? match[2] ?? match[3]).trim() : unit;
}

// Both of these now live in csv-column-types.js, so the DuckDB path reads the
// same rules: "NaN" is a missing number, and an empty column is not text.
// Re-exported because the CSV parser is where callers look for them.
export { isMissingNumberCell };

export function normalizeCsvRowFilter(filter) {
    if (!filter || filter.enabled !== true) return null;
    const columnIndex = Number(filter.columnIndex);
    if (!Number.isInteger(columnIndex) || columnIndex < 0) return null;
    const operator = ['!=', 'is_numeric'].includes(filter.operator) ? filter.operator : '==';
    return {
        enabled: true,
        columnIndex,
        operator,
        value: String(filter.value ?? '').trim(),
    };
}

export function csvRowMatchesFilter(row, filter, options = {}) {
    const normalized = normalizeCsvRowFilter(filter);
    if (!normalized) return true;
    const raw = String(row?.[normalized.columnIndex] ?? '').trim();
    if (normalized.operator === 'is_numeric') {
        return Number.isFinite(parseCsvNumber(raw, options.delimiter || ',', options.decimalSeparator || 'auto', options.thousandsSeparator || 'auto'));
    }
    const matches = raw === normalized.value;
    return normalized.operator === '!=' ? !matches : matches;
}

export default class CsvParser {
    constructor(structureParser) {
        this.structureParser = structureParser || new MatParser();
        this._utf8Decoder = typeof TextDecoder !== 'undefined'
            ? new TextDecoder('utf-8', { fatal: true })
            : null;
        this._latin1Decoder = typeof TextDecoder !== 'undefined'
            ? new TextDecoder('windows-1252')
            : null;
    }

    async parse(buffer, options = {}) {
        const decoded = this._decodeTextWithEncoding(buffer, options.encoding || 'auto');
        const text = decoded.text;
        const delimiter = this._detectDelimiter(text);
        const quoting = this._detectQuoting(text, delimiter);
        const rows = this._parseRows(text, delimiter, this._quoteOptions(quoting))
            .map(row => row.map(cell => cell.trim()));

        if (!rows.some(row => row.some(cell => cell !== ''))) {
            throw new Error('CSV must contain at least one data row.');
        }

        const table = this._detectTableRows(rows, delimiter);
        const hasHeader = table.hasHeader;
        const headerRow = rows[table.headerIndex] || [];
        let rawHeaders = hasHeader ? headerRow : headerRow.map((_, index) => `column_${index + 1}`);
        if (rawHeaders.length < 1) throw new Error('CSV must contain at least one column.');

        const fitted = fitCsvTableRows(rows, table.dataStartIndex, headerRow);
        let dataRows = fitted.rows;
        if (dataRows.length < 1) {
            throw new Error('CSV must contain at least one data row.');
        }
        ({ rawHeaders, dataRows } = this._withoutEmptyTrailingColumns(rawHeaders, dataRows));
        const headers = this._detectedHeaders(rawHeaders, rows, table);
        const timeSource = detectCsvTimeAxis(rawHeaders, dataRows, { delimiter });
        if (!timeSource.ok) throw new Error(timeSource.reason);
        const detectedNumberFormat = this._detectNumberFormat(dataRows, delimiter, timeSource);
        const { decimalSeparator, thousandsSeparator } = csvNumberFormat({ detectedNumberFormat });
        const variableHeaders = headers
            .map((header, index) => ({ header, index }))
            .filter(({ index }) => !timeSource.sourceIndexes.includes(index));
        const timeValues = [];
        const variableColumns = variableHeaders.map(() => ({
            numericValues: [],
            stringValues: [],
            nonEmptyCount: 0,
            finiteCount: 0
        }));
        let timeKind = timeSource.kind;
        let timeOriginMs = null;
        let invalidTimeRows = 0;

        for (let r = 0; r < dataRows.length; r++) {
            const row = dataRows[r];
            if (!row.some(cell => cell !== '')) continue;

            const timeValue = parseCsvTimeValue(timeSource, row, timeValues.length, delimiter, { decimalSeparator, thousandsSeparator });
            if (!Number.isFinite(timeValue)) {
                invalidTimeRows++;
                continue;
            }
            timeValues.push(timeValue);
            if (timeKind === 'datetime' && timeOriginMs === null) timeOriginMs = timeValue;

            for (let c = 0; c < variableHeaders.length; c++) {
                const sourceIndex = variableHeaders[c].index;
                const rawValue = String(row[sourceIndex] ?? '').trim();
                const numericValue = parseCsvNumber(rawValue, delimiter, decimalSeparator, thousandsSeparator);
                const column = variableColumns[c];
                column.numericValues.push(numericValue);
                column.stringValues.push(rawValue);
                if (rawValue !== '' && !isMissingNumberCell(rawValue)) column.nonEmptyCount++;
                if (Number.isFinite(numericValue)) {
                    column.finiteCount++;
                }
            }
        }

        if (!timeValues.length) {
            throw new Error('CSV does not contain time values.');
        }
        let reorderedRows = 0;
        if (timeKind !== 'index') {
            reorderedRows = this._sortTimeSeriesByTime(timeValues, variableColumns);
            if (timeKind === 'datetime') timeOriginMs = timeValues[0];
        }
        const datetimeRepeats = timeKind === 'datetime' ? repeatedTimestampSummary(timeValues) : null;

        const result = {
            filename: '',
            metadata: {},
            variables: {},
            tree: {}
        };

        const timeVariable = {
            name: timeSource.name,
            data: timeValues,
            description: timeSource.description,
            kind: 'abscissa',
            timeSourceStrategy: timeSource.strategy || null,
            dataType: this.structureParser._detectDataType(timeValues, 'abscissa'),
            isConstant: this.structureParser._isConstantValues(timeValues),
            interpolation: 'linear',
            negate: false,
            source: 'csv'
        };
        if (timeKind === 'datetime') {
            timeVariable.timeKind = 'datetime';
            // Repeated stamps are reported, never acted on: a burst of rows at
            // one instant is no reason to throw away the rest of the column (#154).
            timeVariable.timeDisplayMode = 'calendar';
            timeVariable.timeOriginMs = timeOriginMs;
            timeVariable.description = timeSource.description || '[datetime]';
        } else if (timeKind === 'index') {
            timeVariable.timeKind = 'index';
            timeVariable.timeStepMode = 'index';
            timeVariable.description = timeSource.description || '[index]';
        }
        result.variables[timeVariable.name] = timeVariable;
        const usedVariableNames = new Set([timeVariable.name]);
        const numericColumnIndexes = [];

        for (let c = 0; c < variableHeaders.length; c++) {
            const header = variableHeaders[c].header;
            const column = variableColumns[c];
            const isStringColumn = !isMostlyNumericColumn(column);
            if (!isStringColumn) numericColumnIndexes.push(variableHeaders[c].index);
            const values = isStringColumn ? column.stringValues : column.numericValues;
            let name = header.name;
            if (usedVariableNames.has(name)) {
                const base = name;
                let suffix = 2;
                while (usedVariableNames.has(`${base}_${suffix}`)) suffix++;
                name = `${base}_${suffix}`;
            }
            usedVariableNames.add(name);
            result.variables[name] = {
                name,
                data: values,
                description: header.description,
                kind: 'variable',
                dataType: isStringColumn ? 'string' : this.structureParser._detectDataType(values, 'variable'),
                isConstant: this.structureParser._isConstantValues(values),
                interpolation: 'linear',
                negate: false,
                source: 'csv'
            };
        }

        const timeVar = result.variables[timeVariable.name];
        result.metadata = {
            numVariables: Object.keys(result.variables).length,
            numParams: 0,
            numTimevarying: variableHeaders.length,
            numTimesteps: timeVar.data.length,
            timeStart: timeVar.data[0],
            timeEnd: timeVar.data[timeVar.data.length - 1],
            csv: true,
            delimiter,
            hasHeader,
            skippedRows: table.headerIndex,
            skippedRowsAfterHeader: Math.max(0, table.dataStartIndex - table.headerIndex - (hasHeader ? 1 : 0)),
            skippedInvalidTimeRows: invalidTimeRows,
            skippedColumnCountRows: fitted.dropped,
            repairedColumnCountRows: fitted.repaired,
            reorderedRows,
            timeName: timeVar.name,
            timeKind,
            timeDisplayMode: timeVar.timeDisplayMode || 'numeric',
            timeOriginMs,
            timeSourceColumns: timeSource.sourceIndexes.map(index => rawHeaders[index] || `column_${index + 1}`),
            datetimeRepeats,
            numericColumnIndexes,
            unitRowIndex: table.unitRowIndex ?? null,
            encoding: decoded.encoding,
            removedInvisibleChars: decoded.removedChars,
            detectedNumberFormat,
        };

        this._attachTree(result, null);
        return result;
    }

    /**
     * The sidebar tree for a parsed table, and the folders it was cut into
     * (metadata.csvGrouping), from the profile's `grouping` setting — auto
     * when there is none, which is every file nobody has adjusted.
     */
    _attachTree(result, grouping) {
        const timeName = result.metadata?.timeName;
        const names = Object.keys(result.variables).filter(name => name !== timeName);
        const resolved = resolveCsvGrouping(grouping, names);
        result.tree = buildCsvTree(result.variables, resolved);
        result.metadata.csvGrouping = resolved;
        return result;
    }

    /**
     * Headers for an automatically detected table. A units row of its own
     * means the titles are names and nothing more — a "(1)" in
     * "Box (1)" is part of the device, not a unit to cut out — so they are
     * kept whole and the units come from that row, as the parsing dialog does
     * for "Units: row".
     */
    _detectedHeaders(rawHeaders, rows, table) {
        const unitRowIndex = table?.hasHeader ? table.unitRowIndex : null;
        if (!Number.isInteger(unitRowIndex)) return this._makeUniqueHeaders(rawHeaders);
        const unitRow = rows[unitRowIndex] || [];
        return this._makeUniquePlainHeaders(rawHeaders).map((header, index) => {
            const unit = String(unitRow[index] ?? '').trim();
            return unit ? { ...header, description: `[${stripUnitBrackets(unit)}]` } : header;
        });
    }

    inspectSample(buffer, options = {}) {
        const decoded = this._decodeTextWithEncoding(buffer, options.encoding || 'auto');
        const text = decoded.text;
        const delimiter = options.delimiter || this._detectDelimiter(text);
        const maxRows = Math.max(20, Number(options.maxRows) || 700);
        const quoting = options.quoting || this._detectQuoting(text, delimiter);
        const rows = this._parseRows(text, delimiter, { maxRows: maxRows * 4, ...this._quoteOptions(quoting) })
            .map(row => row.map(cell => cell.trim()))
            .slice(0, maxRows);

        if (!rows.some(row => row.some(cell => cell !== ''))) {
            throw new Error('CSV sample must contain at least one data row.');
        }

        const table = this._detectTableRows(rows, delimiter);
        const hasHeader = table.hasHeader;
        const headerRow = rows[table.headerIndex] || [];
        let rawHeaders = hasHeader ? headerRow : headerRow.map((_, index) => `column_${index + 1}`);
        if (rawHeaders.length < 1) throw new Error('CSV sample must contain at least one column.');

        const fitted = fitCsvTableRows(rows, table.dataStartIndex, headerRow);
        let dataRows = fitted.rows;
        if (dataRows.length < 1) {
            throw new Error('CSV sample must contain at least one data row.');
        }
        const fullWidth = rawHeaders.length;
        ({ rawHeaders, dataRows } = this._withoutEmptyTrailingColumns(rawHeaders, dataRows));
        // Cells the rows carry past the table's width, now counting the
        // unnamed empty columns just dropped.
        const trailingEmptyCells = Math.max(fitted.trailingEmpty, 0) + (fullWidth - rawHeaders.length);

        const headers = this._detectedHeaders(rawHeaders, rows, table);
        const timeSource = detectCsvTimeAxis(rawHeaders, dataRows, { delimiter });
        if (!timeSource.ok) throw new Error(timeSource.reason);
        const unitRowIndex = hasHeader && Number.isInteger(table.unitRowIndex) ? table.unitRowIndex : null;
        const detectedNumberFormat = this._detectNumberFormat(dataRows, delimiter, timeSource);

        return {
            delimiter,
            encoding: decoded.encoding,
            encodingDetection: decoded.detection,
            // How fields are quoted: '' when nothing in the sample is.
            quoteChar: quoting.quoteChar,
            ...(quoting.escapeChar ? { escapeChar: quoting.escapeChar } : {}),
            // What was cleaned and what the numbers look like. Facts about the
            // sample, kept next to the reader's settings so every reader of
            // the profile (worker, DuckDB, the converter) applies the same.
            ...(decoded.removedChars ? { removedInvisibleChars: decoded.removedChars } : {}),
            detectedNumberFormat,
            ...(trailingEmptyCells ? { trailingEmptyCells } : {}),
            lineEnding: detectLineEnding(text, table.dataStartIndex),
            ...(fitted.dropped ? { sampleColumnCountMismatches: fitted.dropped } : {}),
            hasHeader,
            headerIndex: table.headerIndex,
            dataStartIndex: table.dataStartIndex,
            skippedRows: table.headerIndex,
            skippedRowsAfterHeader: Math.max(0, table.dataStartIndex - table.headerIndex - (hasHeader ? 1 : 0)),
            rawHeaders,
            headers,
            // Only said when found: a profile without unitsMode keeps the
            // legacy header rules (see _normalizeProfileHeaders).
            ...(unitRowIndex !== null ? { unitsMode: 'row', unitRowIndex } : {}),
            timeSource: this._serializeTimeSource(timeSource),
            sampleRows: dataRows.slice(0, Math.min(dataRows.length, 100)),
        };
    }

    inspectPreview(buffer, options = {}) {
        const decoded = this._decodeTextWithEncoding(buffer, options.encoding || 'auto');
        const text = decoded.text;
        const maxRows = Math.max(1, Number(options.maxRows) || 50);
        const delimiter = options.delimiter || this._detectDelimiter(text);
        const warnings = [];
        const quoting = this._detectQuoting(text, delimiter);
        const quoteOptions = this._quoteOptions(quoting);
        const allRows = this._parseRows(text, delimiter, { maxRows: Math.max(maxRows, Math.min(120, maxRows + 20)), ...quoteOptions })
            .map(row => row.map(cell => String(cell ?? '').trim()));
        const profileRows = this._parseRows(text, delimiter, { maxRows: Math.max(120, maxRows * 4), ...quoteOptions })
            .map(row => row.map(cell => String(cell ?? '').trim()));
        const nonEmptyRows = profileRows.filter(row => row.some(cell => cell !== ''));
        const rows = allRows.slice(0, maxRows);

        let profile = null;
        try {
            profile = this.inspectSample(buffer, { maxRows: Math.max(50, maxRows), delimiter, encoding: options.encoding || 'auto', quoting });
        } catch (err) {
            warnings.push(err?.message || String(err));
            const headerIndex = nonEmptyRows.findIndex(row => row.length >= 2);
            const sourceRow = nonEmptyRows[headerIndex >= 0 ? headerIndex : 0] || [];
            const rawHeaders = sourceRow.length >= 2
                ? sourceRow
                : ['column_1', 'column_2'];
            profile = {
                delimiter,
                encoding: decoded.encoding,
                hasHeader: headerIndex >= 0 && this._looksLikeHeaderRow(sourceRow, nonEmptyRows.slice(headerIndex + 1), delimiter),
                headerIndex: Math.max(0, headerIndex),
                dataStartIndex: Math.max(0, headerIndex + 1),
                skippedRows: Math.max(0, headerIndex),
                skippedRowsAfterHeader: 0,
                rawHeaders,
                headers: this._makeUniqueHeaders(rawHeaders),
                timeSource: {
                    ok: true,
                    kind: 'index',
                    mode: 'generated-index',
                    strategy: 'generated-index',
                    sourceIndexes: [],
                    sourceHeaders: [],
                    name: 'index',
                    description: '[index]',
                    confidence: 1,
                    format: { generated: true },
                    warnings: [],
                },
                sampleRows: nonEmptyRows.slice(Math.max(0, headerIndex + 1), Math.max(0, headerIndex + 101)),
            };
        }

        return {
            delimiter,
            encoding: decoded.encoding,
            encodingDetection: decoded.detection,
            removedInvisibleChars: decoded.removedChars,
            rows,
            profile,
            warnings,
        };
    }

    async parseWithProfile(buffer, profile) {
        if (!profile) return this.parse(buffer);
        const decoded = this._decodeTextWithEncoding(buffer, profile.encoding || 'auto');
        const text = decoded.text;
        const delimiter = profile.delimiter || ',';
        const rows = this._parseRows(text, delimiter, this._quoteOptions(profile))
            .map(row => row.map(cell => cell.trim()));

        if (!rows.some(row => row.some(cell => cell !== ''))) {
            throw new Error('CSV must contain at least one data row.');
        }

        const hasHeader = profile.hasHeader !== false;
        const headerIndex = Math.max(0, Number(profile.headerIndex) || 0);
        const dataStartIndex = Math.max(0, Number(profile.dataStartIndex) || (hasHeader ? headerIndex + 1 : headerIndex));
        const headerRow = hasHeader ? (rows[headerIndex] || []) : (rows[dataStartIndex] || []);
        const rawHeaders = Array.isArray(profile.rawHeaders) && profile.rawHeaders.length
            ? profile.rawHeaders.map(header => String(header ?? '').trim())
            : (hasHeader
                ? headerRow
                : headerRow.map((_, index) => `column_${index + 1}`));
        const timeSource = profile.timeSource || {
            ok: true,
            kind: 'index',
            mode: 'generated-index',
            strategy: 'generated-index',
            sourceIndexes: [],
            name: 'index',
            description: '[index]',
        };
        if (rawHeaders.length < 1) {
            throw new Error('CSV must contain at least one column.');
        }
        if (rawHeaders.length < 2 && timeSource.strategy !== 'generated-index') {
            throw new Error('CSV must contain at least two columns.');
        }

        const headers = this._normalizeProfileHeaders(profile.headers, rawHeaders, profile);
        const expectedColumns = rawHeaders.length;
        // The width rows are fitted to is the header's, with the empty cells a
        // header row may end in: a renamed header list is the same width.
        const widthTemplate = rawHeaders.map((header, index) =>
            hasHeader ? String(headerRow[index] ?? header ?? '') : 'x');
        const fitted = fitCsvTableRows(rows, dataStartIndex, widthTemplate, { policy: normalizeRaggedRowPolicy(profile.raggedRows) });
        const widthRows = fitted.rows;
        const discardedColumnCountRows = fitted.dropped;
        const detectedNumberFormat = profile.detectedNumberFormat
            || this._detectNumberFormat(widthRows, delimiter, timeSource);
        const { decimalSeparator, thousandsSeparator } = csvNumberFormat({ ...profile, detectedNumberFormat });
        const rowFilter = normalizeCsvRowFilter(profile.rowFilter);
        const dataRows = widthRows.filter(row => csvRowMatchesFilter(row, rowFilter, { delimiter, decimalSeparator, thousandsSeparator }));
        const filteredRowCount = widthRows.length - dataRows.length;
        if (dataRows.length < 1) {
            throw new Error(rowFilter ? 'CSV row filter excludes all data rows.' : 'CSV must contain at least one data row.');
        }

        const timeIndexes = new Set(Array.isArray(timeSource.sourceIndexes) ? timeSource.sourceIndexes : []);
        const ignoredIndexes = new Set(Array.isArray(profile.ignoredColumns) ? profile.ignoredColumns : []);
        const variableHeaders = headers
            .map((header, index) => ({ header, index }))
            .filter(({ index }) => !timeIndexes.has(index) && !ignoredIndexes.has(index));
        const timeValues = [];
        const variableColumns = variableHeaders.map(() => ({
            numericValues: [],
            stringValues: [],
            nonEmptyCount: 0,
            finiteCount: 0
        }));
        let timeKind = timeSource.kind || 'index';
        let timeOriginMs = null;
        let invalidTimeRows = 0;

        for (let r = 0; r < dataRows.length; r++) {
            const row = dataRows[r];
            if (!row.some(cell => cell !== '')) continue;

            const timeValue = parseCsvTimeValue(timeSource, row, timeValues.length, delimiter, { decimalSeparator, thousandsSeparator });
            if (!Number.isFinite(timeValue)) {
                invalidTimeRows++;
                continue;
            }
            timeValues.push(timeValue);
            if (timeKind === 'datetime' && timeOriginMs === null) timeOriginMs = timeValue;

            for (let c = 0; c < variableHeaders.length; c++) {
                const sourceIndex = variableHeaders[c].index;
                const rawValue = String(row[sourceIndex] ?? '').trim();
                const numericValue = parseCsvNumber(rawValue, delimiter, decimalSeparator, thousandsSeparator);
                const column = variableColumns[c];
                column.numericValues.push(numericValue);
                column.stringValues.push(rawValue);
                if (rawValue !== '' && !isMissingNumberCell(rawValue)) column.nonEmptyCount++;
                if (Number.isFinite(numericValue)) {
                    column.finiteCount++;
                }
            }
        }

        if (!timeValues.length) {
            throw new Error('CSV does not contain time values.');
        }
        let reorderedRows = 0;
        if (timeKind !== 'index') {
            reorderedRows = this._sortTimeSeriesByTime(timeValues, variableColumns);
            if (timeKind === 'datetime') timeOriginMs = timeValues[0];
        }
        const datetimeRepeats = timeKind === 'datetime' ? repeatedTimestampSummary(timeValues) : null;

        const result = {
            filename: '',
            metadata: {},
            variables: {},
            tree: {}
        };

        const timeVariable = {
            name: timeSource.name || 'time',
            data: timeValues,
            description: timeSource.description || (timeKind === 'index' ? '[index]' : ''),
            kind: 'abscissa',
            timeSourceStrategy: timeSource.strategy || null,
            dataType: this.structureParser._detectDataType(timeValues, 'abscissa'),
            isConstant: this.structureParser._isConstantValues(timeValues),
            interpolation: 'linear',
            negate: false,
            source: 'csv'
        };
        if (timeKind === 'datetime') {
            timeVariable.timeKind = 'datetime';
            // Repeated stamps are reported, never acted on: a burst of rows at
            // one instant is no reason to throw away the rest of the column (#154).
            timeVariable.timeDisplayMode = 'calendar';
            timeVariable.timeOriginMs = timeOriginMs;
            timeVariable.description = timeSource.description || '[datetime]';
        } else if (timeKind === 'index') {
            timeVariable.timeKind = 'index';
            timeVariable.timeStepMode = 'index';
            timeVariable.description = timeSource.description || '[index]';
        }
        result.variables[timeVariable.name] = timeVariable;
        const usedVariableNames = new Set([timeVariable.name]);
        const numericColumnIndexes = [];
        // A type chosen in the parsing options wins over the column's own
        // values, exactly as it does on the DuckDB path (csv-column-types.js).
        const forced = forcedColumnTypes(profile);

        for (let c = 0; c < variableHeaders.length; c++) {
            const header = variableHeaders[c].header;
            const column = variableColumns[c];
            const chosen = forced.get(variableHeaders[c].index) || null;
            const isStringColumn = chosen ? chosen === 'text' : !isMostlyNumericColumn(column);
            if (!isStringColumn) numericColumnIndexes.push(variableHeaders[c].index);
            const values = isStringColumn ? column.stringValues : column.numericValues;
            let name = header.name;
            if (usedVariableNames.has(name)) {
                const base = name;
                let suffix = 2;
                while (usedVariableNames.has(`${base}_${suffix}`)) suffix++;
                name = `${base}_${suffix}`;
            }
            usedVariableNames.add(name);
            result.variables[name] = {
                name,
                data: values,
                description: header.description,
                kind: 'variable',
                dataType: isStringColumn ? 'string' : this.structureParser._detectDataType(values, 'variable'),
                isConstant: this.structureParser._isConstantValues(values),
                interpolation: 'linear',
                negate: false,
                source: 'csv'
            };
        }

        const timeVar = result.variables[timeVariable.name];
        result.metadata = {
            numVariables: Object.keys(result.variables).length,
            numParams: 0,
            numTimevarying: variableHeaders.length,
            numTimesteps: timeVar.data.length,
            timeStart: timeVar.data[0],
            timeEnd: timeVar.data[timeVar.data.length - 1],
            csv: true,
            delimiter,
            hasHeader,
            skippedRows: headerIndex,
            skippedRowsAfterHeader: Math.max(0, dataStartIndex - headerIndex - (hasHeader ? 1 : 0)),
            skippedInvalidTimeRows: invalidTimeRows,
            reorderedRows,
            skippedColumnCountRows: discardedColumnCountRows,
            repairedColumnCountRows: fitted.repaired,
            encoding: decoded.encoding,
            removedInvisibleChars: decoded.removedChars,
            detectedNumberFormat,
            skippedFilteredRows: filteredRowCount,
            timeName: timeVar.name,
            timeKind,
            timeDisplayMode: timeVar.timeDisplayMode || 'numeric',
            timeOriginMs,
            timeSourceColumns: (timeSource.sourceIndexes || []).map(index => rawHeaders[index] || `column_${index + 1}`),
            datetimeRepeats,
            numericColumnIndexes,
            csvProfile: { ...profile, delimiter, decimalSeparator, hasHeader, headerIndex, dataStartIndex, rawHeaders, headers, rowFilter, numericColumnIndexes },
        };

        this._attachTree(result, profile.grouping || null);
        return result;
    }

    parseRowsWithProfile(text, profile, options = {}) {
        const delimiter = profile?.delimiter || ',';
        // The rows a live update appends are read exactly as the file was:
        // same separators, quoting and row fitting.
        const { decimalSeparator, thousandsSeparator } = csvNumberFormat(profile);
        const rawHeaders = profile?.rawHeaders || [];
        const headers = profile?.headers || this._makeUniqueHeaders(rawHeaders);
        const timeSource = profile?.timeSource || {};
        const expectedColumns = rawHeaders.length;
        const startRowIndex = Math.max(0, Number(options.startRowIndex) || 0);
        const rows = this._parseRows(text, delimiter, this._quoteOptions(profile))
            .map(row => row.map(cell => cell.trim()))
            .filter(row => row.some(cell => cell !== ''));
        const fitOptions = { minWidth: expectedColumns, policy: normalizeRaggedRowPolicy(profile?.raggedRows) };

        const timeIndexes = new Set(timeSource.sourceIndexes || []);
        const ignoredIndexes = new Set(Array.isArray(profile?.ignoredColumns) ? profile.ignoredColumns : []);
        const rowFilter = normalizeCsvRowFilter(profile?.rowFilter);
        const numericIndexes = this._numericColumnIndexSet(profile, { delimiter, decimalSeparator, thousandsSeparator, expectedColumns, timeSource });
        const variableHeaders = headers
            .map((header, index) => ({ header, index }))
            .filter(({ index }) => !timeIndexes.has(index) && !ignoredIndexes.has(index));
        const timeValues = [];
        const variables = new Map(variableHeaders.map(({ header }) => [header.name, []]));
        const rawRows = [];

        for (let r = 0; r < rows.length; r++) {
            const rawRow = rows[r];
            const row = expectedColumns ? fitCsvRowToWidth(rawRow, expectedColumns, fitOptions) : rawRow;
            if (!row) {
                const err = new Error(`CSV row has ${rawRow.length} columns; expected ${expectedColumns}.`);
                err.code = 'LIVE_UPDATE_COLUMN_COUNT';
                throw err;
            }
            if (profile?.hasHeader && rawHeaders.length && row.join('\u0001') === rawHeaders.join('\u0001')) {
                const err = new Error('CSV header row appeared again in appended data.');
                err.code = 'LIVE_UPDATE_HEADER_REPEATED';
                throw err;
            }
            if (!csvRowMatchesFilter(row, rowFilter, { delimiter, decimalSeparator, thousandsSeparator })) continue;

            const timeValue = parseCsvTimeValue(timeSource, row, startRowIndex + timeValues.length, delimiter, { decimalSeparator, thousandsSeparator });
            if (!Number.isFinite(timeValue)) {
                const err = new Error('CSV appended row has an invalid time value.');
                err.code = 'LIVE_UPDATE_INVALID_TIME';
                throw err;
            }
            timeValues.push(timeValue);
            rawRows.push(row);

            for (const { header, index } of variableHeaders) {
                const rawValue = String(row[index] ?? '').trim();
                const numericValue = parseCsvNumber(rawValue, delimiter, decimalSeparator, thousandsSeparator);
                variables.get(header.name).push(numericIndexes.has(index) ? numericValue : rawValue);
            }
        }

        return { rows: rawRows, timeValues, variables };
    }

    _numericColumnIndexSet(profile = {}, options = {}) {
        // A type chosen in the parsing options applies to the rows a live update
        // appends too: the file has not changed its mind about them.
        const withForced = (indexes) => {
            for (const [index, type] of forcedColumnTypes(profile)) {
                if (type === 'numeric') indexes.add(index);
                else indexes.delete(index);
            }
            return indexes;
        };

        if (Array.isArray(profile?.numericColumnIndexes)) {
            return withForced(new Set(profile.numericColumnIndexes
                .map(index => Number(index))
                .filter(index => Number.isInteger(index) && index >= 0)));
        }

        const sampleRows = Array.isArray(profile?.sampleRows) ? profile.sampleRows : [];
        const expectedColumns = Math.max(0, Number(options.expectedColumns) || profile?.rawHeaders?.length || 0);
        if (!sampleRows.length || !expectedColumns) return withForced(new Set());

        const delimiter = options.delimiter || profile?.delimiter || ',';
        const format = csvNumberFormat(profile);
        const decimalSeparator = options.decimalSeparator || format.decimalSeparator;
        const thousandsSeparator = options.thousandsSeparator || format.thousandsSeparator;
        const timeSource = options.timeSource || profile?.timeSource || {};
        const rows = !timeSource?.ok || timeSource.strategy === 'generated-index'
            ? sampleRows
            : sampleRows.filter((row, index) =>
                Number.isFinite(parseCsvTimeValue(timeSource, row, index, delimiter, { decimalSeparator, thousandsSeparator }))
            );
        const numericIndexes = new Set();
        for (let columnIndex = 0; columnIndex < expectedColumns; columnIndex++) {
            const counts = columnSampleCounts(rows, columnIndex, delimiter, decimalSeparator, thousandsSeparator);
            if (isMostlyNumericColumn(counts)) numericIndexes.add(columnIndex);
        }
        return withForced(numericIndexes);
    }

    _serializeTimeSource(timeSource) {
        return {
            ok: !!timeSource.ok,
            kind: timeSource.kind,
            mode: timeSource.mode,
            strategy: timeSource.strategy || null,
            sourceIndexes: Array.isArray(timeSource.sourceIndexes) ? timeSource.sourceIndexes.slice() : [],
            sourceHeaders: Array.isArray(timeSource.sourceHeaders) ? timeSource.sourceHeaders.slice() : [],
            name: timeSource.name,
            description: timeSource.description,
            confidence: timeSource.confidence,
            format: { ...(timeSource.format || {}) },
            warnings: Array.isArray(timeSource.warnings) ? timeSource.warnings.slice() : [],
        };
    }

    _decodeText(buffer, encoding = 'auto') {
        return this._decodeTextWithEncoding(buffer, encoding).text;
    }

    /**
     * Bytes to clean text: decoded (decodeCsvBytes says how the encoding is
     * chosen) and stripped of the invisible characters no value is made of.
     *
     * @returns {{ text: string, encoding: string, detection: string, removedChars: number }}
     */
    _decodeTextWithEncoding(buffer, encoding = 'auto') {
        const decoded = decodeCsvBytes(buffer, String(encoding || 'auto').toLowerCase());
        const sanitized = sanitizeCsvText(decoded.text);
        return {
            text: sanitized.text,
            encoding: decoded.encoding,
            detection: decoded.detection,
            removedChars: sanitized.removed,
        };
    }

    // The row reader's quote options for a profile or a detected quoting.
    // '' (no field was quoted in the sample) still reads "..." as quoted.
    _quoteOptions(quoting) {
        return {
            quote: quoting?.quoteChar === "'" ? "'" : '"',
            escape: quoting?.escapeChar === '\\' ? '\\' : '',
        };
    }

    // A header ending in a delimiter, over columns that are empty: dropped.
    _withoutEmptyTrailingColumns(rawHeaders, dataRows) {
        const width = trimmedTableWidth(rawHeaders, dataRows);
        if (width >= rawHeaders.length) return { rawHeaders, dataRows };
        return {
            rawHeaders: rawHeaders.slice(0, width),
            dataRows: dataRows.map(row => row.slice(0, width)),
        };
    }

    // How the numbers of a table are written, from its data rows. The time
    // columns are left out: a date's dots and commas are not decimal marks.
    _detectNumberFormat(dataRows, delimiter, timeSource = null) {
        const { decimalSeparator, thousandsSeparator } = detectCsvNumberFormat((dataRows || []).slice(0, 2000), {
            delimiter,
            skipColumns: timeSource?.kind === 'datetime' ? (timeSource.sourceIndexes || []) : [],
        });
        return { decimalSeparator, thousandsSeparator };
    }

    _detectDelimiter(text) {
        return this._pickDelimiter(this._scoreDelimiterCandidates(text));
    }

    /**
     * Every candidate delimiter, scored two ways.
     *
     * `score` is the table reading this parser was built on: a header over
     * rows of numbers and dates, which is what a measurement file is. It is
     * -Infinity when the candidate finds no such rows.
     *
     * `consistency` is the data-consistency measure of van den Burg, Nazabal
     * and Sutton (2019), CleverCSV's: how regular the rows' lengths are
     * (pattern score) times the share of cells of a known type (type score).
     * It needs no numbers, so it decides files of words, codes and names,
     * where the table reading finds nothing and used to fall back to a comma.
     */
    _scoreDelimiterCandidates(text) {
        const sampleText = String(text).slice(0, 262144);
        const out = [];
        for (const delimiter of DELIMITER_CANDIDATES) {
            if (delimiter !== 'whitespace' && delimiter !== ',' && !sampleText.includes(delimiter)) continue;
            const rows = this._parseRows(sampleText, delimiter, { maxRows: 700 })
                .filter(row => row.some(cell => cell.trim() !== ''))
                .slice(0, 500);
            if (!rows.length) continue;
            let consistency = this._dialectConsistency(rows, delimiter);
            if (delimiter === 'whitespace') {
                // Spaces separate columns of numbers (loggers, simulators);
                // between words or inside a date they are part of the value.
                // Weighted by the share of rows with two numeric cells, a
                // list of names or of "1958-03-06 00:00:00" stays one column.
                const numericRows = rows.filter(row =>
                    row.filter(cell => Number.isFinite(parseCsvNumber(cell, ' '))).length >= 2).length;
                consistency *= numericRows / rows.length;
            }
            const candidate = { delimiter, score: -Infinity, consistency, width: 1 };

            const table = this._detectTableRows(rows, delimiter);
            const header = rows[table.headerIndex] || [];
            const headerWidth = header.length;
            candidate.width = headerWidth;
            const minWidth = minimumRowWidth(header);
            const dataRows = rows
                .slice(table.dataStartIndex, Math.min(rows.length, table.dataStartIndex + 50))
                .map(row => fitCsvRowToWidth(row, headerWidth, { minWidth }))
                .filter(row => row && this._isDataLikeRow(row, delimiter));
            if (headerWidth > 1 && !(rows.length > table.dataStartIndex && dataRows.length === 0)) {
                let score = table.score + headerWidth * 25 + dataRows.length * 12 - table.headerIndex * 0.25;
                if (delimiter === 'whitespace' && dataRows.length) {
                    // Splitting on spaces also splits dates ("1 janvier 2024
                    // 13:05") into more columns, which the width bonus rewards.
                    // A row whose "cells" still hold another delimiter
                    // ("13:05:22;1.234,5;ok") was not split where the file is.
                    const foreign = dataRows.filter(row => row.some(cell => /[;\t|]|,(?!\d)|(?<!\d),/.test(cell))).length;
                    score -= 200 * (foreign / dataRows.length);
                }
                candidate.score = score;
            }
            out.push(candidate);
        }
        return out;
    }

    /**
     * The table reading decides, unless the data consistency clearly
     * prefers another candidate (by more than CONSISTENCY_OVERRIDE), or no
     * candidate reads as a table of numbers at all.
     *
     * Measured on half of the CSV_Wrangling GitHub test set (files whose MD5
     * starts with 0-7, bench/dialect): delimiter accuracy 88.2% with the
     * table reading alone, 96.5% with this rule, and none of the 68 files in
     * test-files reads differently. The other half is kept for evaluation.
     */
    _pickDelimiter(candidates) {
        let table = null;
        for (const candidate of candidates) {
            if (candidate.width > 1 && candidate.score > (table?.score ?? -Infinity)) table = candidate;
        }
        let consistent = null;
        for (const candidate of candidates) {
            if (!consistent || candidate.consistency > consistent.consistency) consistent = candidate;
        }
        if (!table) return consistent?.delimiter || ',';
        if (consistent && consistent.consistency > CONSISTENCY_OVERRIDE * table.consistency) return consistent.delimiter;
        return table.delimiter;
    }

    /**
     * Data consistency Q = P · T of a reading of the rows (van den Burg et
     * al., 2019, eq. 1-3). P rewards rows that share a length and have more
     * than one cell; T is the share of cells that are empty, a number, a
     * date or time, a URL, an e-mail, or plain words.
     */
    _dialectConsistency(rows, delimiter) {
        const lengths = new Map();
        let cells = 0;
        let known = 0;
        for (const row of rows) {
            lengths.set(row.length, (lengths.get(row.length) || 0) + 1);
            for (const cell of row) {
                cells++;
                if (this._isKnownTypeCell(cell, delimiter)) known++;
            }
        }
        let pattern = 0;
        for (const [length, count] of lengths) pattern += count * (Math.max(1e-3, length - 1) / length);
        pattern /= Math.max(1, lengths.size);
        const type = cells ? Math.max(1e-10, known / cells) : 1e-10;
        return pattern * type;
    }

    _isKnownTypeCell(value, delimiter = ',') {
        const cell = String(value ?? '').trim();
        if (!cell || isMissingNumberCell(cell) || /^(?:null|none|nil|n\/a|na|-)$/i.test(cell)) return true;
        if (cell.length > 200) return false;
        // Two numbers with a column of spaces between them ("0        299")
        // are two cells of a fixed-width row, split at the wrong character.
        if (/\d\s{2,}[+-]?\d/.test(cell)) return false;
        if (Number.isFinite(parseCsvNumber(cell, delimiter))) return true;
        if (/^[-+]?[$€£¥]?\s?[-+]?\d[\d.,\s]*\s?[%$€£¥]?$/u.test(cell)) return true;
        if (this._looksLikeDateTimeCell(cell) || /^\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s*[AaPp][Mm])?$/.test(cell)) return true;
        if (/^(?:https?|ftp):\/\/\S+$|^www\.\S+$/i.test(cell)) return true;
        if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(cell)) return true;
        if (/^\/[\w.\-/]+$/.test(cell)) return true;
        if (/^(?:\p{N}?\p{L}+[\p{N}\p{L} \-_.()?!¿¡]*|\p{L}?[\p{N}\p{L} \-_.()?!¿¡]+)$/u.test(cell)) return true;
        if (/\p{L}{3}/u.test(cell) && isMonthNameDateCell(cell)) return true;
        return false;
    }

    _parseRows(text, delimiter, options = {}) {
        const maxRows = Math.max(0, Number(options.maxRows) || 0);
        if (delimiter === 'whitespace') {
            const rows = [];
            for (const line of String(text).split(/\r?\n|\r/)) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                rows.push(trimmed.split(/\s+/));
                if (maxRows && rows.length >= maxRows) break;
            }
            return rows;
        }

        // RFC 4180, read leniently. A quote opens a quoted field only at the
        // start of a field, and only when a closing quote follows within
        // reach (_quotedFieldCloses). Anywhere else it is an ordinary
        // character: `5" pipe`, `Temp "A"`, or a string a PLC cut short. The
        // old reader toggled quoting on every quote, so one stray quote made
        // the rest of the file a single cell. Text after a closing quote,
        // before the delimiter, is kept: `"abc"def` reads `abcdef`.
        //
        // The quote is `"` unless the file quotes with `'` (options.quote,
        // from _detectQuoting), and inside a quoted field options.escape
        // (a backslash, when the file writes \") makes the next quote literal.
        const quote = options.quote === "'" ? "'" : options.quote === '' ? '' : '"';
        const escape = options.escape || '';
        const stats = options.stats || null;
        const rows = [];
        let row = [];
        let cell = '';
        let inQuotes = false;
        const n = text.length;

        for (let i = 0; i < n; i++) {
            const ch = text[i];

            if (inQuotes) {
                if (escape && ch === escape && (text[i + 1] === quote || text[i + 1] === escape)) {
                    cell += text[i + 1];
                    i++;
                    continue;
                }
                if (ch === quote) {
                    if (text[i + 1] === quote) {
                        cell += quote;
                        i++;
                    } else {
                        inQuotes = false;
                    }
                    continue;
                }
                cell += ch;
                continue;
            }

            if (quote && ch === quote) {
                if (cell.trim() === '' && this._quotedFieldCloses(text, i + 1, quote, escape, delimiter)) {
                    inQuotes = true;
                    cell = '';
                    if (stats) stats.quotedFields = (stats.quotedFields || 0) + 1;
                } else {
                    cell += ch;
                }
                continue;
            }

            if (ch === delimiter) {
                row.push(cell);
                cell = '';
                continue;
            }

            if (ch === '\n' || ch === '\r') {
                row.push(cell);
                rows.push(row);
                if (maxRows && rows.length >= maxRows) return rows;
                row = [];
                cell = '';
                if (ch === '\r' && text[i + 1] === '\n') i++;
                continue;
            }

            cell += ch;
        }

        row.push(cell);
        rows.push(row);
        return rows;
    }

    // Does the quoted field starting at `from` close, within the size a real
    // quoted cell has? A doubled quote is an escaped one, not the end. A
    // single quote must close where the field ends (before the delimiter or
    // the line end): it is also an apostrophe, and "l'eau" opens nothing.
    _quotedFieldCloses(text, from, quote = '"', escape = '', delimiter = ',') {
        const limit = Math.min(text.length, from + MAX_QUOTED_FIELD_CHARS);
        const q = quote.charCodeAt(0);
        const e = escape ? escape.charCodeAt(0) : -1;
        let lines = 0;
        for (let j = from; j < limit; j++) {
            const ch = text.charCodeAt(j);
            if (ch === e && (text.charCodeAt(j + 1) === q || text.charCodeAt(j + 1) === e)) { j++; continue; }
            if (ch === q) {
                if (text.charCodeAt(j + 1) === q) { j++; continue; }
                if (quote !== "'") return true;
                let k = j + 1;
                while (text[k] === ' ' || text[k] === '\t') k++;
                const next = text[k];
                return next === undefined || next === delimiter || next === '\n' || next === '\r';
            }
            if (ch === 10 && ++lines > MAX_QUOTED_FIELD_LINES) return false;
        }
        return false;
    }

    /**
     * How a file quotes, once its delimiter is known: `"` or `'` (whichever
     * opens more fields that close), or none, and whether a backslash escapes
     * quotes inside them (\" rather than RFC 4180's "").
     *
     * @returns {{ quoteChar: string, escapeChar: string, quotedFields: number }}
     */
    _detectQuoting(text, delimiter) {
        const sample = String(text).slice(0, 262144);
        // Columns split on spaces are never quoted (the reader does not look).
        if (delimiter === 'whitespace') return { quoteChar: '', escapeChar: '', quotedFields: 0 };
        const counts = {};
        for (const quote of ['"', "'"]) {
            if (!sample.includes(quote)) { counts[quote] = 0; continue; }
            const stats = {};
            this._parseRows(sample, delimiter, { maxRows: 2000, quote, stats });
            counts[quote] = stats.quotedFields || 0;
        }
        // A single quote wins only clearly: it is also an apostrophe.
        const quoteChar = counts["'"] >= 3 && counts["'"] > 2 * counts['"'] ? "'" : '"';
        let escapeChar = '';
        if (counts[quoteChar] > 0) {
            const q = quoteChar === '"' ? '"' : "'";
            const d = delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // \" inside a field (not \ closing it before the delimiter), and
            // "" inside a field (not an empty field).
            const escaped = (sample.match(new RegExp(`\\\\${q}(?![${d}\\r\\n])`, 'g')) || []).length;
            const doubled = (sample.match(new RegExp(`[^${d}\\r\\n]${q}${q}[^${d}\\r\\n]`, 'g')) || []).length;
            if (escaped > 0 && escaped >= doubled) escapeChar = '\\';
        }
        return {
            quoteChar: counts[quoteChar] > 0 ? quoteChar : '',
            escapeChar,
            quotedFields: counts[quoteChar] || 0,
        };
    }

    // Put the rows in chronological order, and report how many had to move.
    //
    // The repair itself is nearly always right for a time series, but it is
    // invisible downstream: every later check — the time-axis inspector, the
    // Missing/NaN overlay, the integral's negative-dt warning — sees an already
    // sorted vector and truthfully reports "no time going backwards", which the
    // reader takes to mean the FILE was in order. Returning the count lets the
    // UI say what happened instead of leaving that gap between "the data is
    // fine now" and "the data was fine".
    //
    // The count is rows whose POSITION changed, not the number of backward
    // steps: one block moved out of place produces a handful of backward steps
    // but relocates every row in the block, and the second number is the one a
    // reader means by "my file was reordered".
    _sortTimeSeriesByTime(timeValues, variableColumns) {
        if (!Array.isArray(timeValues) || timeValues.length < 2) return 0;
        let sorted = true;
        for (let i = 1; i < timeValues.length; i++) {
            if (timeValues[i] < timeValues[i - 1]) {
                sorted = false;
                break;
            }
        }
        if (sorted) return 0;

        const order = timeValues
            .map((time, index) => ({ time, index }))
            .sort((a, b) => (a.time - b.time) || (a.index - b.index))
            .map(entry => entry.index);
        const sortedTimes = order.map(index => timeValues[index]);
        for (let i = 0; i < sortedTimes.length; i++) {
            timeValues[i] = sortedTimes[i];
        }
        for (const column of variableColumns) {
            column.numericValues = order.map(index => column.numericValues[index]);
            if (column.stringValues) {
                column.stringValues = order.map(index => column.stringValues[index]);
            }
        }
        return order.reduce((count, sourceIndex, targetIndex) =>
            count + (sourceIndex === targetIndex ? 0 : 1), 0);
    }

    _looksLikeHeaderRow(row, followingRows = [], delimiter = ',') {
        const cells = (row || []).map(cell => String(cell ?? '').trim()).filter(cell => cell && !isMissingNumberCell(cell));
        if (!cells.length) return true;
        if (this._isDataLikeRow(row, delimiter)
            && followingRows.some(following => this._isDataLikeRow(following, delimiter))) {
            return false;
        }
        const numericCount = cells.filter(cell => Number.isFinite(parseCsvNumber(cell, delimiter))).length;
        if (numericCount === cells.length) return false;

        const sampledRows = followingRows.slice(0, 5);
        const followingNumeric = sampledRows.filter(r => {
            const values = (r || []).map(cell => String(cell ?? '').trim()).filter(cell => cell && !isMissingNumberCell(cell));
            return values.length && values.filter(cell => Number.isFinite(parseCsvNumber(cell, delimiter))).length === values.length;
        }).length;

        return !(numericCount >= Math.max(2, Math.ceil(cells.length * 0.8)) && followingNumeric >= Math.max(1, sampledRows.length - 1));
    }

    _detectTableRows(rows, delimiter = ',') {
        const toa5 = this._campbellToa5Table(rows, delimiter);
        if (toa5) return toa5;
        const limit = Math.min(rows.length, 250);
        let best = null;
        let lastWritten = rows.length - 1;
        while (lastWritten >= 0 && !(rows[lastWritten] || []).some(cell => String(cell ?? '').trim() !== '')) lastWritten--;

        for (let headerIndex = 0; headerIndex < limit; headerIndex++) {
            const header = rows[headerIndex] || [];
            const width = header.length;
            if (width < 2) continue;
            // A row with nothing written in it names nothing, so it is not a
            // header candidate. It used to be one — _looksLikeHeaderRow calls
            // an empty row a header — and it beat the real header on score,
            // because the blank spacer sits right above the data and so pays
            // no skipped-rows penalty while the title row two rows up pays for
            // both the units row and the spacer. Logger exports that write
            //     title / names / units / (blank) / data
            // therefore arrived as column_1..column_N with the names and the
            // units both thrown away.
            if (!header.some(cell => String(cell ?? '').trim() !== '')) continue;
            // Nor does a row holding one value and nothing else, the time of
            // a reading that is missing: it is a data row.
            if (!this._isDataLikeRow(header, delimiter) && this._isSparseDataRow(header, delimiter)) continue;
            // Rows may end in empty cells the header does not have (a trailing
            // delimiter), or stop before header cells that are empty.
            const minWidth = minimumRowWidth(header);

            let dataStartIndex = -1;
            let dataCount = 0;
            let skippedAfterHeader = 0;
            // Rows that hold only values, too few to be data-like on their
            // own: "05.11.2023 00:10;" before sunrise, in a solar logger. Right
            // under the header and right before the data, they are its first
            // rows; anywhere else they are skipped like any other row.
            let sparseStart = -1;
            let sparseCount = 0;
            let windowStart = -1;
            let blankAfterShortBlock = false;
            // Two separate budgets, and the difference decides which row wins.
            // Looking for the data: at most 30 rows below the header, so a
            // header is never matched to a table far below it. Counting the
            // data once found: 30 rows from where it starts. That second
            // window used to be headerIndex + 30 as well, which made dataCount
            // — worth 20 points a row — a measure of how close the candidate
            // sat to the data rather than of how much data it explains. Every
            // preamble row above the real header cost it one data row, so on a
            // logger export the first data row itself outscored the title row
            // three rows up and the file arrived unnamed. Anchored at
            // the data, candidates that explain the same table now count the
            // same rows, and the header bonus and the skip penalty decide.
            const headerLookaheadEnd = Math.min(rows.length, headerIndex + 30);

            if (this._isDataLikeRow(header, delimiter)) {
                dataStartIndex = headerIndex;
                dataCount = 1;
            }

            for (let i = headerIndex + 1; i < rows.length; i++) {
                const end = dataStartIndex < 0
                    ? Math.min(rows.length, headerLookaheadEnd + sparseCount, headerIndex + 250)
                    : Math.min(rows.length, Math.max(dataStartIndex + 30, windowStart + 1));
                if (i >= end) break;
                const row = fitCsvRowToWidth(rows[i] || [], width, { minWidth });
                if (!row) {
                    if (dataCount > 0 && dataCount <= 3 && !(rows[i] || []).some(cell => String(cell ?? '').trim() !== '')) {
                        blankAfterShortBlock = true;
                    }
                    if (dataCount === 0) {
                        skippedAfterHeader += 1 + sparseCount;
                        sparseStart = -1;
                        sparseCount = 0;
                    }
                    continue;
                }
                if (this._isDataLikeRow(row, delimiter)) {
                    // A few rows, a blank line, then the table: when the rows
                    // above the blank leave empty or hold words where the
                    // table holds numbers, they were settings ("Port 851",
                    // "SampleTime[ms] 10") or a channel numbering, not data.
                    if (blankAfterShortBlock) {
                        blankAfterShortBlock = false;
                        const block = [];
                        for (let k = dataStartIndex; k < i; k++) {
                            const earlier = fitCsvRowToWidth(rows[k] || [], width, { minWidth });
                            if (earlier) block.push(earlier);
                        }
                        if (block.length && block.every(earlier => this._lacksValuesOf(earlier, row, delimiter))) {
                            skippedAfterHeader += i - dataStartIndex;
                            dataStartIndex = i;
                            windowStart = i;
                            dataCount = 1;
                            continue;
                        }
                    }
                    if (dataStartIndex < 0) {
                        windowStart = i;
                        dataStartIndex = sparseStart >= 0 ? sparseStart : i;
                        dataCount = Math.min(sparseCount, 30);
                    }
                    dataCount++;
                    continue;
                }
                if (this._isSparseDataRow(row, delimiter)) {
                    if (dataStartIndex >= 0) {
                        dataCount++;
                    } else {
                        if (sparseStart < 0) sparseStart = i;
                        sparseCount++;
                    }
                    continue;
                }
                if (dataCount === 0) {
                    skippedAfterHeader += 1 + sparseCount;
                    sparseStart = -1;
                    sparseCount = 0;
                    continue;
                }
                break;
            }

            // One data row is a table only when it ends the file under its
            // header: a status table that logs one record (Campbell TOA5).
            // Anywhere else one row can be a line of settings.
            const loneFinalRow = dataCount === 1 && dataStartIndex === lastWritten && dataStartIndex > headerIndex;
            if (dataStartIndex < 0 || (dataCount < 2 && !loneFinalRow)) continue;
            const following = rows.slice(dataStartIndex, Math.min(rows.length, dataStartIndex + 6));
            let effectiveHeaderIndex = headerIndex;
            let effectiveHeader = header;
            let effectiveSkippedAfterHeader = skippedAfterHeader;
            if (dataStartIndex !== headerIndex
                && headerIndex > 0
                && rows[headerIndex - 1]?.length === width
                && this._isUnitLikeRow(header, delimiter)
                && this._looksLikeHeaderRow(rows[headerIndex - 1], following, delimiter)) {
                effectiveHeaderIndex = headerIndex - 1;
                effectiveHeader = rows[effectiveHeaderIndex];
                effectiveSkippedAfterHeader += 1;
            }
            const hasHeader = dataStartIndex === effectiveHeaderIndex
                ? false
                : this._looksLikeHeaderRow(effectiveHeader, following, delimiter);
            const score =
                dataCount * 20 +
                width * 4 +
                (hasHeader ? 25 : 0) -
                effectiveHeaderIndex * 0.5 -
                effectiveSkippedAfterHeader * 2;

            if (!best || score > best.score) {
                best = { headerIndex: effectiveHeaderIndex, dataStartIndex, hasHeader, score, dataCount };
            }
        }

        // One value per line under a key/value preamble (a chromatograph's
        // export, an oscilloscope channel): no row has two values, so no
        // table above is the data. A long run of such rows, much longer than
        // the best table found, is.
        const single = this._singleValueRun(rows, delimiter);
        if (single && single.length >= 20 && (!best || single.length >= 3 * best.dataCount)) {
            const above = rows[single.start - 1];
            const aboveCells = (above || []).filter(cell => String(cell ?? '').trim() !== '');
            const named = aboveCells.length === 1 && !Number.isFinite(parseCsvNumber(aboveCells[0], delimiter))
                && (above || []).length === (rows[single.start] || []).length;
            const table = {
                headerIndex: named ? single.start - 1 : single.start,
                dataStartIndex: single.start,
                hasHeader: named,
                score: 0,
            };
            table.unitRowIndex = null;
            return table;
        }
        if (best) {
            delete best.dataCount;
            best.unitRowIndex = this._findUnitRowIndex(rows, best, delimiter);
            return best;
        }
        const fallbackHeaderIndex = rows.findIndex(row =>
            (row || []).length >= 2 && row.some(cell => String(cell ?? '').trim() !== '')
        );
        const headerIndex = fallbackHeaderIndex >= 0 ? fallbackHeaderIndex : 0;
        const header = rows[headerIndex] || [];
        const width = header.length || 0;
        const followingRows = rows.slice(headerIndex + 1);
        const hasHeader = this._looksLikeHeaderRow(header, followingRows, delimiter);
        const nextDataIndex = rows.findIndex((row, index) =>
            index > headerIndex
            && row.length === width
            && row.some(cell => String(cell ?? '').trim() !== '')
        );
        return {
            headerIndex,
            dataStartIndex: hasHeader ? (nextDataIndex >= 0 ? nextDataIndex : headerIndex + 1) : headerIndex,
            hasHeader,
            score: 0,
        };
    }

    // A units row sits between the header and the data: right under the
    // header, or right above the first data row.
    _findUnitRowIndex(rows, table, delimiter = ',') {
        if (!table?.hasHeader) return null;
        const width = rows[table.headerIndex]?.length || 0;
        const candidates = [table.headerIndex + 1, table.dataStartIndex - 1];
        for (const index of candidates) {
            if (index <= table.headerIndex || index >= table.dataStartIndex) continue;
            const row = rows[index];
            if (row?.length === width && this._isUnitLikeRow(row, delimiter)) return index;
        }
        return null;
    }

    _isDataLikeRow(row, delimiter = ',') {
        const cells = row || [];
        const nonEmpty = cells.filter(cell => String(cell ?? '').trim() !== '' && !isMissingNumberCell(cell));
        if (nonEmpty.length < 2) return false;
        const numericCount = nonEmpty.filter(cell => Number.isFinite(parseCsvNumber(cell, delimiter))).length;
        const dateTimeCount = nonEmpty.filter(cell => this._looksLikeDateTimeCell(cell)).length;
        const dataCount = numericCount + dateTimeCount;
        return dataCount >= Math.max(2, Math.ceil(nonEmpty.length * 0.5));
    }

    // Campbell Scientific's TOA5, the format of its data loggers: a line that
    // starts "TOA5", then the names, the units ("W m-2", "Decimal degrees"),
    // the processing ("Smp", "Avg"), and the data. Units like those are not
    // units to the units-row test, so the score took them for the header.
    _campbellToa5Table(rows, delimiter = ',') {
        if (String(rows[0]?.[0] ?? '').trim().toUpperCase() !== 'TOA5') return null;
        const names = rows[1] || [];
        if (names.length < 2 || rows.length < 4) return null;
        const units = rows[2] || [];
        let dataStartIndex = -1;
        for (let i = 3; i < Math.min(rows.length, 6); i++) {
            const row = fitCsvRowToWidth(rows[i] || [], names.length, { minWidth: minimumRowWidth(names) });
            if (row && (this._isDataLikeRow(row, delimiter) || this._isSparseDataRow(row, delimiter))) {
                dataStartIndex = i;
                break;
            }
        }
        if (dataStartIndex < 0) return null;
        return {
            headerIndex: 1,
            dataStartIndex,
            hasHeader: true,
            unitRowIndex: units.length === names.length ? 2 : null,
            score: 0,
        };
    }

    // Whether a row is empty or not a number in a column where a data row
    // holds a number.
    _lacksValuesOf(row, dataRow, delimiter = ',') {
        for (let c = 0; c < dataRow.length; c++) {
            if (!Number.isFinite(parseCsvNumber(dataRow[c], delimiter))) continue;
            const cell = String(row[c] ?? '').trim();
            if (!cell || !Number.isFinite(parseCsvNumber(cell, delimiter))) return true;
        }
        return false;
    }

    // The longest run of rows with exactly one cell written, a number.
    _singleValueRun(rows, delimiter = ',') {
        let best = null;
        let start = -1;
        let width = -1;
        const close = (end) => {
            if (start >= 0 && (!best || end - start > best.length)) best = { start, length: end - start };
            start = -1;
        };
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i] || [];
            const written = row.filter(cell => String(cell ?? '').trim() !== '');
            const value = written.length === 1 && (Number.isFinite(parseCsvNumber(written[0], delimiter)) || isMissingNumberCell(written[0]));
            if (value && start >= 0 && row.length === width) continue;
            close(i);
            if (value) { start = i; width = row.length; }
        }
        close(rows.length);
        return best;
    }

    // A row that holds nothing but values, fewer than a data-like row needs:
    // a time and an empty reading, one number between empty cells.
    _isSparseDataRow(row, delimiter = ',') {
        const nonEmpty = (row || []).filter(cell => String(cell ?? '').trim() !== '' && !isMissingNumberCell(cell));
        if (!nonEmpty.length) return false;
        return nonEmpty.every(cell => Number.isFinite(parseCsvNumber(cell, delimiter)) || this._looksLikeDateTimeCell(cell));
    }

    _looksLikeDateTimeCell(value) {
        const text = String(value ?? '').trim();
        return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?\s?(?:Z|[+\-]\d{2}(?::?\d{2})?)?)?$/.test(text)
            // "10/13/23 01:45:00 PM": HOBO and other US loggers write a
            // 12-hour clock.
            || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:\s?[AaPp]\.?[Mm]\.?)?)?$/.test(text)
            || /^\d{1,2}[-/]\d{1,2}[ T]+\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?$/.test(text)
            || /^(?:\d{1,2}\.\d{1,2}\.(?:\d{4}|\d{2})|\d{4}\.\d{1,2}\.\d{1,2})(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?)?$/.test(text)
            // "09-Janvier-2024 07:05:08", "Mon, 15 Jan 2024": without this a
            // file dated with month names had no data-like row, and the
            // delimiter was chosen as if it had no dates at all.
            || (/\p{L}{3}/u.test(text) && /\d/.test(text) && isMonthNameDateCell(text));
    }

    _isUnitLikeRow(row, delimiter = ',') {
        const cells = (row || []).map(cell => String(cell ?? '').trim()).filter(Boolean);
        if (cells.length < 2) return false;
        const numericCount = cells.filter(cell => Number.isFinite(parseCsvNumber(cell, delimiter))).length;
        if (numericCount > 0) return false;
        const unitish = cells.filter(cell =>
            /^(?:no\.?|time|ms|s|sec|min|h|hr|degc|degf|k|v|a|w|kw|pa|bar|m\/s|%|ao\d+|a\d+)$/i.test(cell)
            || /^[a-zA-Z%°µ\/\-\d]+$/.test(cell)
            || /^[a-zA-Z%°µΩ\/\-\d²³·^*.]+$/u.test(cell)
            // "[m/s]", "(°C)", "[kWh/kWp]", "[1]" — and the time column's
            // "[dd.MM.yyyy HH:mm]" — as logger exports write a units row.
            || /^\[[^\[\]]{1,32}\]$|^\([^()]{1,32}\)$|^\{[^{}]{1,32}\}$/.test(cell)
        ).length;
        return unitish / cells.length >= 0.7;
    }

    /**
     * @param {object} [options]
     * @param {boolean} [options.guardNameCollisions] true when this is a fresh
     *        look at a file and nothing has said how units are written. A split
     *        that collapses distinct headers is then read as names, not units:
     *        `v(V1)`, `v(OUT_1)`, `v(OUT_2)` are three signals, and cutting the
     *        parentheses off leaves three columns called `v` for the
     *        deduplicator to rename `v`, `v_2`, `v_3` — the file's own names
     *        gone and the thing that carried them filed as a unit (#53).
     *
     *        False when a SAVED profile is being replayed. Its owner may have a
     *        view that names `Voltage_2`, and quietly deciding those parentheses
     *        were a name after all would break that reference. They can say so
     *        in the parsing dialog; nothing should say it for them.
     */
    _makeUniqueHeaders(rawHeaders, { guardNameCollisions = true } = {}) {
        const split = rawHeaders.map((raw, index) => this._parseHeader(raw, index));
        if (guardNameCollisions && inlineUnitSplitCollides(rawHeaders, split)) {
            return this._makeUniquePlainHeaders(rawHeaders);
        }
        const seen = new Map();
        return rawHeaders.map((raw, index) => {
            const parsed = split[index];
            const base = parsed.name;
            // Case-blind: DuckDB's column names are, so "Decimal degrees" and
            // "decimal degrees" are one name there and the read failed.
            const key = String(base).toLowerCase();
            const count = (seen.get(key) || 0) + 1;
            seen.set(key, count);
            return {
                name: count === 1 ? base : `${base}_${count}`,
                description: parsed.description
            };
        });
    }

    _makeUniquePlainHeaders(rawHeaders) {
        const seen = new Map();
        return rawHeaders.map((raw, index) => {
            const fallback = index === 0 ? 'time' : `column_${index + 1}`;
            const base = this._sanitizeHeaderName(raw, fallback);
            const key = String(base).toLowerCase();
            const count = (seen.get(key) || 0) + 1;
            seen.set(key, count);
            return {
                name: count === 1 ? base : `${base}_${count}`,
                description: ''
            };
        });
    }

    _normalizeProfileHeaders(headers, rawHeaders, profile = null) {
        // Only 'inline' asks for a unit to be cut out of the title. 'none' says
        // there are no units, and 'row' says they live in a row of their own —
        // in both cases a "(V)" or "[kW]" in the header is part of the column's
        // name, and taking it away leaves the reader with two columns called
        // "Voltage" and no way to tell them apart. 'row' used to fall through
        // to the inline parser and lose exactly that. undefined keeps the
        // legacy behavior (auto profiles and pre-unitsMode saved profiles).
        const fallback = profile?.unitsMode === 'inline'
            ? this._makeUniqueInlineHeaders(rawHeaders, profile.inlineUnitFormat || 'auto')
            : (profile?.unitsMode === 'none' || profile?.unitsMode === 'row')
                ? this._makeUniquePlainHeaders(rawHeaders)
                // A profile saved before unitsMode existed. Replay it exactly.
                : this._makeUniqueHeaders(rawHeaders, { guardNameCollisions: false });
        if (!Array.isArray(headers) || !headers.length) return fallback;
        return rawHeaders.map((raw, index) => {
            const header = headers[index];
            if (header && typeof header === 'object') {
                return {
                    name: String(header.name || fallback[index]?.name || `column_${index + 1}`),
                    description: header.description === undefined
                        ? (fallback[index]?.description || '')
                        : String(header.description || ''),
                };
            }
            if (typeof header === 'string' && header.trim()) {
                return { name: header.trim(), description: fallback[index]?.description || '' };
            }
            return fallback[index] || this._parseHeader(raw, index);
        });
    }

    // No collision guard here, unlike _makeUniqueHeaders: reaching this means
    // the reader SET "Units: inline", and that is them saying the parentheses
    // hold units. Two columns that then collapse to one name are their call to
    // make, and test-csv-units-mode.mjs pins it.
    _makeUniqueInlineHeaders(rawHeaders, format = 'auto') {
        const seen = new Map();
        return rawHeaders.map((raw, index) => {
            const parsed = this._parseInlineUnitHeader(raw, index, format);
            const base = parsed.name;
            const count = (seen.get(base) || 0) + 1;
            seen.set(base, count);
            return {
                name: count === 1 ? base : `${base}_${count}`,
                description: parsed.description
            };
        });
    }

    _parseInlineUnitHeader(rawHeader, index, format = 'auto') {
        const fallback = index === 0 ? 'time' : `column_${index + 1}`;
        const raw = String(rawHeader || '').trim();
        if (!raw) return { name: fallback, description: '', unit: '' };

        const patterns = [
            { key: 'paren', re: /^(.*?)\s*\(([^)]+)\)\s*$/ },
            { key: 'bracket', re: /^(.*?)\s*\[([^\]]+)\]\s*$/ },
            { key: 'brace', re: /^(.*?)\s*\{([^}]+)\}\s*$/ },
            { key: 'angle', re: /^(.*?)\s*<([^>]+)>\s*$/ },
            { key: 'slash', re: /^(.*?)\s+\/\s+(.+?)\s*$/ },
        ];
        const candidates = format === 'auto'
            ? patterns
            : patterns.filter(pattern => pattern.key === format);
        for (const pattern of candidates) {
            const match = raw.match(pattern.re);
            if (!match) continue;
            const name = this._sanitizeHeaderName(match[1], fallback);
            const unit = String(match[2] || '').trim();
            // As in the parsing dialog: on Auto, a phrase is part of the name.
            if (format === 'auto' && !looksLikeUnitText(unit)) continue;
            // `unit` travels alongside the description so the caller can ask
            // whether a unit was taken at all (inlineUnitSplitCollides).
            if (unit) return { name, description: `[${unit}]`, unit };
        }
        return { name: this._sanitizeHeaderName(raw, fallback), description: '', unit: '' };
    }

    _parseHeader(rawHeader, index) {
        const fallback = index === 0 ? 'time' : `column_${index + 1}`;
        const raw = String(rawHeader || '').trim();
        if (!raw) return { name: fallback, description: '', unit: '' };

        const bracketUnit = raw.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
        if (bracketUnit && looksLikeUnitText(bracketUnit[2])) {
            return {
                name: this._sanitizeHeaderName(bracketUnit[1], fallback),
                description: `[${bracketUnit[2].trim()}]`,
                unit: bracketUnit[2].trim(),
            };
        }

        const parenUnit = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
        if (parenUnit && looksLikeUnitText(parenUnit[2])) {
            return {
                name: this._sanitizeHeaderName(parenUnit[1], fallback),
                description: `[${parenUnit[2].trim()}]`,
                unit: parenUnit[2].trim(),
            };
        }

        return { name: this._sanitizeHeaderName(raw, fallback), description: '', unit: '' };
    }

    _sanitizeHeaderName(name, fallback) {
        const cleaned = String(name || '').trim();
        return cleaned || fallback;
    }

}
