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
import { detectCsvTimeAxis, parseCsvNumber, parseCsvTimeValue } from './csv-time-detection.js';

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

    async parse(buffer) {
        const text = this._decodeText(buffer);
        const delimiter = this._detectDelimiter(text);
        const rows = this._parseRows(text, delimiter)
            .map(row => row.map(cell => cell.trim()))
            .filter(row => row.some(cell => cell !== ''));

        if (rows.length < 1) {
            throw new Error('CSV must contain at least one data row.');
        }

        const table = this._detectTableRows(rows, delimiter);
        const hasHeader = table.hasHeader;
        const headerRow = rows[table.headerIndex] || [];
        const rawHeaders = hasHeader ? headerRow : headerRow.map((_, index) => `column_${index + 1}`);
        if (rawHeaders.length < 2) {
            throw new Error('CSV must contain at least two columns.');
        }

        const dataRows = rows.slice(table.dataStartIndex).filter(row => row.length === rawHeaders.length);
        if (dataRows.length < 1) {
            throw new Error('CSV must contain at least one data row.');
        }
        const headers = this._makeUniqueHeaders(rawHeaders);
        const timeSource = detectCsvTimeAxis(rawHeaders, dataRows, { delimiter });
        if (!timeSource.ok) throw new Error(timeSource.reason);
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

            const timeValue = timeSource.parse(row, timeValues.length);
            if (!Number.isFinite(timeValue)) {
                invalidTimeRows++;
                continue;
            }
            timeValues.push(timeValue);
            if (timeKind === 'datetime' && timeOriginMs === null) timeOriginMs = timeValue;

            for (let c = 0; c < variableHeaders.length; c++) {
                const sourceIndex = variableHeaders[c].index;
                const rawValue = String(row[sourceIndex] ?? '').trim();
                const numericValue = parseCsvNumber(rawValue, delimiter);
                const column = variableColumns[c];
                column.numericValues.push(numericValue);
                if (column.stringValues) column.stringValues.push(rawValue);
                if (rawValue !== '') column.nonEmptyCount++;
                if (Number.isFinite(numericValue)) {
                    column.finiteCount++;
                    column.stringValues = null;
                }
            }
        }

        if (!timeValues.length) {
            throw new Error('CSV does not contain time values.');
        }
        if (timeKind !== 'index') {
            this._sortTimeSeriesByTime(timeValues, variableColumns);
            if (timeKind === 'datetime') timeOriginMs = timeValues[0];
        }

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
            dataType: this.structureParser._detectDataType(timeValues, 'abscissa'),
            isConstant: this.structureParser._isConstantValues(timeValues),
            interpolation: 'linear',
            negate: false,
            source: 'csv'
        };
        if (timeKind === 'datetime') {
            timeVariable.timeKind = 'datetime';
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

        for (let c = 0; c < variableHeaders.length; c++) {
            const header = variableHeaders[c].header;
            const column = variableColumns[c];
            const isStringColumn = column.nonEmptyCount > 0 && column.finiteCount === 0;
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
            timeName: timeVar.name,
            timeKind,
            timeDisplayMode: timeVar.timeDisplayMode || 'numeric',
            timeOriginMs,
            timeSourceColumns: timeSource.sourceIndexes.map(index => rawHeaders[index] || `column_${index + 1}`)
        };

        result.tree = this.structureParser._buildTree(result.variables);
        return result;
    }

    inspectSample(buffer, options = {}) {
        const text = this._decodeText(buffer);
        const delimiter = options.delimiter || this._detectDelimiter(text);
        const maxRows = Math.max(20, Number(options.maxRows) || 700);
        const rows = this._parseRows(text, delimiter)
            .map(row => row.map(cell => cell.trim()))
            .filter(row => row.some(cell => cell !== ''))
            .slice(0, maxRows);

        if (rows.length < 1) {
            throw new Error('CSV sample must contain at least one data row.');
        }

        const table = this._detectTableRows(rows, delimiter);
        const hasHeader = table.hasHeader;
        const headerRow = rows[table.headerIndex] || [];
        const rawHeaders = hasHeader ? headerRow : headerRow.map((_, index) => `column_${index + 1}`);
        if (rawHeaders.length < 2) {
            throw new Error('CSV sample must contain at least two columns.');
        }

        const dataRows = rows
            .slice(table.dataStartIndex)
            .filter(row => row.length === rawHeaders.length);
        if (dataRows.length < 1) {
            throw new Error('CSV sample must contain at least one data row.');
        }

        const headers = this._makeUniqueHeaders(rawHeaders);
        const timeSource = detectCsvTimeAxis(rawHeaders, dataRows, { delimiter });
        if (!timeSource.ok) throw new Error(timeSource.reason);

        return {
            delimiter,
            hasHeader,
            headerIndex: table.headerIndex,
            dataStartIndex: table.dataStartIndex,
            skippedRows: table.headerIndex,
            skippedRowsAfterHeader: Math.max(0, table.dataStartIndex - table.headerIndex - (hasHeader ? 1 : 0)),
            rawHeaders,
            headers,
            timeSource: this._serializeTimeSource(timeSource),
            sampleRows: dataRows.slice(0, Math.min(dataRows.length, 100)),
        };
    }

    parseRowsWithProfile(text, profile, options = {}) {
        const delimiter = profile?.delimiter || ',';
        const rawHeaders = profile?.rawHeaders || [];
        const headers = profile?.headers || this._makeUniqueHeaders(rawHeaders);
        const timeSource = profile?.timeSource || {};
        const expectedColumns = rawHeaders.length;
        const startRowIndex = Math.max(0, Number(options.startRowIndex) || 0);
        const rows = this._parseRows(text, delimiter)
            .map(row => row.map(cell => cell.trim()))
            .filter(row => row.some(cell => cell !== ''));

        const timeIndexes = new Set(timeSource.sourceIndexes || []);
        const variableHeaders = headers
            .map((header, index) => ({ header, index }))
            .filter(({ index }) => !timeIndexes.has(index));
        const timeValues = [];
        const variables = new Map(variableHeaders.map(({ header }) => [header.name, []]));
        const rawRows = [];

        for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            if (expectedColumns && row.length !== expectedColumns) {
                const err = new Error(`CSV row has ${row.length} columns; expected ${expectedColumns}.`);
                err.code = 'LIVE_UPDATE_COLUMN_COUNT';
                throw err;
            }
            if (profile?.hasHeader && rawHeaders.length && row.join('\u0001') === rawHeaders.join('\u0001')) {
                const err = new Error('CSV header row appeared again in appended data.');
                err.code = 'LIVE_UPDATE_HEADER_REPEATED';
                throw err;
            }

            const timeValue = parseCsvTimeValue(timeSource, row, startRowIndex + timeValues.length, delimiter);
            if (!Number.isFinite(timeValue)) {
                const err = new Error('CSV appended row has an invalid time value.');
                err.code = 'LIVE_UPDATE_INVALID_TIME';
                throw err;
            }
            timeValues.push(timeValue);
            rawRows.push(row);

            for (const { header, index } of variableHeaders) {
                const rawValue = String(row[index] ?? '').trim();
                const numericValue = parseCsvNumber(rawValue, delimiter);
                variables.get(header.name).push(Number.isFinite(numericValue) ? numericValue : rawValue);
            }
        }

        return { rows: rawRows, timeValues, variables };
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

    _decodeText(buffer) {
        if (typeof buffer === 'string') return buffer.replace(/^\uFEFF/, '');
        if (this._utf8Decoder) {
            try {
                return this._utf8Decoder.decode(buffer).replace(/^\uFEFF/, '');
            } catch (_) {
                if (this._latin1Decoder) {
                    return this._latin1Decoder.decode(buffer).replace(/^\uFEFF/, '');
                }
            }
        }

        let text = '';
        const bytes = new Uint8Array(buffer);
        for (const b of bytes) text += String.fromCharCode(b);
        return text.replace(/^\uFEFF/, '');
    }

    _detectDelimiter(text) {
        const candidates = [',', ';', '\t', 'whitespace'];
        let best = { delimiter: ',', score: -Infinity };
        const sampleText = String(text).slice(0, 262144);

        for (const delimiter of candidates) {
            const rows = this._parseRows(sampleText, delimiter)
                .filter(row => row.some(cell => cell.trim() !== ''))
                .slice(0, 500);
            if (!rows.length) continue;

            const table = this._detectTableRows(rows, delimiter);
            const headerWidth = rows[table.headerIndex]?.length || 0;
            const dataRows = rows
                .slice(table.dataStartIndex, Math.min(rows.length, table.dataStartIndex + 50))
                .filter(row => row.length === headerWidth && this._isDataLikeRow(row, delimiter));
            if (rows.length > table.dataStartIndex && dataRows.length === 0) continue;
            const score = table.score + headerWidth * 25 + dataRows.length * 12 - table.headerIndex * 0.25;
            if (headerWidth > 1 && score > best.score) best = { delimiter, score };
        }

        return best.delimiter;
    }

    _parseRows(text, delimiter) {
        if (delimiter === 'whitespace') {
            return String(text)
                .split(/\r?\n|\r/)
                .map(line => line.trim())
                .filter(line => line !== '')
                .map(line => line.split(/\s+/));
        }

        const rows = [];
        let row = [];
        let cell = '';
        let inQuotes = false;

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];

            if (ch === '"') {
                if (inQuotes && text[i + 1] === '"') {
                    cell += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
                continue;
            }

            if (!inQuotes && ch === delimiter) {
                row.push(cell);
                cell = '';
                continue;
            }

            if (!inQuotes && (ch === '\n' || ch === '\r')) {
                row.push(cell);
                rows.push(row);
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

    _sortTimeSeriesByTime(timeValues, variableColumns) {
        if (!Array.isArray(timeValues) || timeValues.length < 2) return;
        let sorted = true;
        for (let i = 1; i < timeValues.length; i++) {
            if (timeValues[i] < timeValues[i - 1]) {
                sorted = false;
                break;
            }
        }
        if (sorted) return;

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
    }

    _looksLikeHeaderRow(row, followingRows = [], delimiter = ',') {
        const cells = (row || []).map(cell => String(cell ?? '').trim()).filter(Boolean);
        if (!cells.length) return true;
        if (this._isDataLikeRow(row, delimiter)
            && followingRows.some(following => this._isDataLikeRow(following, delimiter))) {
            return false;
        }
        const numericCount = cells.filter(cell => Number.isFinite(parseCsvNumber(cell, delimiter))).length;
        if (numericCount === cells.length) return false;

        const sampledRows = followingRows.slice(0, 5);
        const followingNumeric = sampledRows.filter(r => {
            const values = (r || []).map(cell => String(cell ?? '').trim()).filter(Boolean);
            return values.length && values.filter(cell => Number.isFinite(parseCsvNumber(cell, delimiter))).length === values.length;
        }).length;

        return !(numericCount >= Math.max(2, Math.ceil(cells.length * 0.8)) && followingNumeric >= Math.max(1, sampledRows.length - 1));
    }

    _detectTableRows(rows, delimiter = ',') {
        const limit = Math.min(rows.length, 250);
        let best = null;

        for (let headerIndex = 0; headerIndex < limit; headerIndex++) {
            const header = rows[headerIndex] || [];
            const width = header.length;
            if (width < 2) continue;

            let dataStartIndex = -1;
            let dataCount = 0;
            let skippedAfterHeader = 0;
            const lookaheadEnd = Math.min(rows.length, headerIndex + 30);

            if (this._isDataLikeRow(header, delimiter)) {
                dataStartIndex = headerIndex;
                dataCount = 1;
            }

            for (let i = headerIndex + 1; i < lookaheadEnd; i++) {
                const row = rows[i] || [];
                if (row.length !== width) {
                    if (dataCount === 0) skippedAfterHeader++;
                    continue;
                }
                if (this._isDataLikeRow(row, delimiter)) {
                    if (dataStartIndex < 0) dataStartIndex = i;
                    dataCount++;
                    continue;
                }
                if (dataCount === 0) {
                    skippedAfterHeader++;
                    continue;
                }
                break;
            }

            if (dataStartIndex < 0 || dataCount < 2) continue;
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
                best = { headerIndex: effectiveHeaderIndex, dataStartIndex, hasHeader, score };
            }
        }

        if (best) return best;
        const hasHeader = this._looksLikeHeaderRow(rows[0], rows.slice(1), delimiter);
        return { headerIndex: 0, dataStartIndex: hasHeader ? 1 : 0, hasHeader, score: 0 };
    }

    _isDataLikeRow(row, delimiter = ',') {
        const cells = row || [];
        const nonEmpty = cells.filter(cell => String(cell ?? '').trim() !== '');
        if (nonEmpty.length < 2) return false;
        const numericCount = nonEmpty.filter(cell => Number.isFinite(parseCsvNumber(cell, delimiter))).length;
        const dateTimeCount = nonEmpty.filter(cell => this._looksLikeDateTimeCell(cell)).length;
        const dataCount = numericCount + dateTimeCount;
        return dataCount >= Math.max(2, Math.ceil(nonEmpty.length * 0.5));
    }

    _looksLikeDateTimeCell(value) {
        const text = String(value ?? '').trim();
        return /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(text)
            || /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(text)
            || /^\d{1,2}[-/]\d{1,2}[ T]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text);
    }

    _isUnitLikeRow(row, delimiter = ',') {
        const cells = (row || []).map(cell => String(cell ?? '').trim()).filter(Boolean);
        if (cells.length < 2) return false;
        const numericCount = cells.filter(cell => Number.isFinite(parseCsvNumber(cell, delimiter))).length;
        if (numericCount > 0) return false;
        const unitish = cells.filter(cell =>
            /^(?:no\.?|time|ms|s|sec|min|h|hr|degc|degf|k|v|a|w|kw|pa|bar|m\/s|%|ao\d+|a\d+)$/i.test(cell)
            || /^[a-zA-Z%°µ\/\-\d]+$/.test(cell)
        ).length;
        return unitish / cells.length >= 0.7;
    }

    _makeUniqueHeaders(rawHeaders) {
        const seen = new Map();
        return rawHeaders.map((raw, index) => {
            const parsed = this._parseHeader(raw, index);
            const base = parsed.name;
            const count = (seen.get(base) || 0) + 1;
            seen.set(base, count);
            return {
                name: count === 1 ? base : `${base}_${count}`,
                description: parsed.description
            };
        });
    }

    _parseHeader(rawHeader, index) {
        const fallback = index === 0 ? 'time' : `column_${index + 1}`;
        const raw = String(rawHeader || '').trim();
        if (!raw) return { name: fallback, description: '' };

        const bracketUnit = raw.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
        if (bracketUnit) {
            return {
                name: this._sanitizeHeaderName(bracketUnit[1], fallback),
                description: `[${bracketUnit[2].trim()}]`
            };
        }

        const parenUnit = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
        if (parenUnit) {
            return {
                name: this._sanitizeHeaderName(parenUnit[1], fallback),
                description: `[${parenUnit[2].trim()}]`
            };
        }

        return { name: this._sanitizeHeaderName(raw, fallback), description: '' };
    }

    _sanitizeHeaderName(name, fallback) {
        const cleaned = String(name || '').trim();
        return cleaned || fallback;
    }

}
