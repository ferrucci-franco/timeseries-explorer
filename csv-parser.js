/**
 * CSV result parser.
 *
 * Expected format:
 *   time,variable_a,variable_b
 *   0,1.2,3.4
 *   0.1,1.3,3.5
 *
 * The first non-empty row is the header. The first column is treated as the
 * abscissa/time vector and every remaining column becomes a time-varying
 * variable, matching the object shape produced by MatParser.
 */
class CsvParser {
    constructor(structureParser) {
        this.structureParser = structureParser || new MatParser();
        this._utf8Decoder = typeof TextDecoder !== 'undefined'
            ? new TextDecoder('utf-8', { fatal: false })
            : null;
    }

    async parse(buffer) {
        const text = this._decodeText(buffer);
        const delimiter = this._detectDelimiter(text);
        const rows = this._parseRows(text, delimiter)
            .map(row => row.map(cell => cell.trim()))
            .filter(row => row.some(cell => cell !== ''));

        if (rows.length < 2) {
            throw new Error('CSV must contain a header row and at least one data row.');
        }

        const rawHeaders = rows[0];
        if (rawHeaders.length < 2) {
            throw new Error('CSV must contain a time column and at least one variable column.');
        }

        const headers = this._makeUniqueHeaders(rawHeaders);
        const columns = headers.map(() => []);

        for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            if (!row.some(cell => cell !== '')) continue;

            for (let c = 0; c < headers.length; c++) {
                const value = this._parseNumber(row[c] ?? '', delimiter);
                if (c === 0 && !Number.isFinite(value)) {
                    throw new Error(`Invalid time value at CSV data row ${r}: "${row[c] ?? ''}"`);
                }
                columns[c].push(value);
            }
        }

        if (!columns[0].length) {
            throw new Error('CSV does not contain numeric time values.');
        }

        const result = {
            filename: '',
            metadata: {},
            variables: {},
            tree: {}
        };

        for (let c = 0; c < headers.length; c++) {
            const header = headers[c];
            const values = columns[c];
            const kind = c === 0 ? 'abscissa' : 'variable';
            const variable = {
                name: header.name,
                data: values,
                description: header.description,
                kind,
                dataType: this.structureParser._detectDataType(values, kind),
                isConstant: this.structureParser._isConstantValues(values),
                interpolation: 'linear',
                negate: false,
                source: 'csv'
            };
            result.variables[variable.name] = variable;
        }

        const timeVar = result.variables[headers[0].name];
        result.metadata = {
            numVariables: Object.keys(result.variables).length,
            numParams: 0,
            numTimevarying: Math.max(0, headers.length - 1),
            numTimesteps: timeVar.data.length,
            timeStart: timeVar.data[0],
            timeEnd: timeVar.data[timeVar.data.length - 1],
            csv: true,
            delimiter,
            timeName: timeVar.name
        };

        result.tree = this.structureParser._buildTree(result.variables);
        return result;
    }

    _decodeText(buffer) {
        if (typeof buffer === 'string') return buffer.replace(/^\uFEFF/, '');
        if (this._utf8Decoder) return this._utf8Decoder.decode(buffer).replace(/^\uFEFF/, '');

        let text = '';
        const bytes = new Uint8Array(buffer);
        for (const b of bytes) text += String.fromCharCode(b);
        return text.replace(/^\uFEFF/, '');
    }

    _detectDelimiter(text) {
        const candidates = [',', ';', '\t'];
        let best = { delimiter: ',', score: -Infinity };

        for (const delimiter of candidates) {
            const rows = this._parseRows(text, delimiter)
                .filter(row => row.some(cell => cell.trim() !== ''))
                .slice(0, 8);
            if (!rows.length) continue;

            const headerWidth = rows[0].length;
            const widths = rows.map(row => row.length);
            const consistentRows = widths.filter(w => w === headerWidth).length;
            const score = headerWidth * 100 + consistentRows * 10 - Math.max(...widths.map(w => Math.abs(w - headerWidth)));
            if (headerWidth > 1 && score > best.score) best = { delimiter, score };
        }

        return best.delimiter;
    }

    _parseRows(text, delimiter) {
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

    _parseNumber(rawValue, delimiter) {
        const raw = String(rawValue || '').trim();
        if (!raw) return NaN;

        const normalized = raw
            .replace(/\s+/g, '')
            .replace(/[dD]([+-]?\d+)$/, 'e$1');

        if (/^[+-]?inf(?:inity)?$/i.test(normalized)) {
            return normalized.startsWith('-') ? -Infinity : Infinity;
        }
        if (/^nan$/i.test(normalized)) return NaN;

        const decimalNormalized = delimiter !== ',' && normalized.includes(',') && !normalized.includes('.')
            ? normalized.replace(',', '.')
            : normalized;

        return Number(decimalNormalized);
    }
}
