function splitPythonTuple(text) {
    const source = String(text || '').trim();
    if (!source.startsWith('(') || !source.endsWith(')')) return null;
    const parts = [];
    let token = '';
    let quote = null;
    let escaped = false;
    let depth = 0;
    for (const char of source.slice(1, -1)) {
        if (escaped) {
            token += char;
            escaped = false;
            continue;
        }
        if (quote && char === '\\') {
            token += char;
            escaped = true;
            continue;
        }
        if (quote) {
            token += char;
            if (char === quote) quote = null;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            token += char;
        } else if (char === '(' || char === '[' || char === '{') {
            depth++;
            token += char;
        } else if (char === ')' || char === ']' || char === '}') {
            depth--;
            token += char;
        } else if (char === ',' && depth === 0) {
            parts.push(token.trim());
            token = '';
        } else {
            token += char;
        }
    }
    if (quote || depth !== 0) return null;
    if (token.trim()) parts.push(token.trim());
    return parts;
}

function pythonLabel(token) {
    const value = String(token || '').trim();
    const quote = value[0];
    if ((quote === "'" || quote === '"') && value.endsWith(quote)) {
        return value.slice(1, -1)
            .replace(/\\n/g, '\n')
            .replace(/\\r/g, '\r')
            .replace(/\\t/g, '\t')
            .replace(new RegExp(`\\\\${quote}`, 'g'), quote)
            .replace(/\\\\/g, '\\');
    }
    if (value === 'None') return 'None';
    return value;
}

export function parsePandasMultiIndexLabel(label, expectedDepth = 0) {
    if (Array.isArray(label)) {
        const path = label.map(value => String(value ?? 'None'));
        return !expectedDepth || path.length === expectedDepth ? path : null;
    }
    const tokens = splitPythonTuple(label);
    if (!tokens || (expectedDepth && tokens.length !== expectedDepth)) return null;
    return tokens.map(pythonLabel);
}

export function pandasColumnPaths(metadata) {
    const depth = Array.isArray(metadata?.column_indexes) ? metadata.column_indexes.length : 0;
    if (depth < 2 || !Array.isArray(metadata?.columns)) return new Map();
    const result = new Map();
    for (const column of metadata.columns) {
        const fieldName = String(column?.field_name ?? '');
        const path = parsePandasMultiIndexLabel(column?.name, depth);
        if (fieldName && path) result.set(fieldName, path);
    }
    return result;
}
