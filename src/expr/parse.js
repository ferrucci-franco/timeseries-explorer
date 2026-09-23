// Tokenizer and parser for derived-variable formulas.
//
// Moved verbatim out of app/methods/derived-methods.js — same grammar, same
// error strings, same precedence — so existing formulas and saved sessions
// behave identically. Only the evaluator changed (see compile.js); the front
// end was never the problem.

import { DERIVED_CONSTANTS, DERIVED_FUNCTIONS, DERIVED_FUNCTION_ALIASES } from '../app/constants.js';

export function normalizeFunctionName(name) {
    const lower = String(name).toLowerCase();
    if (DERIVED_FUNCTIONS.some(fn => fn.name === lower)) return lower;
    return DERIVED_FUNCTION_ALIASES.get(lower) || '';
}

function nextNonSpaceChar(text, start) {
    let i = start;
    while (i < text.length && /\s/.test(text[i])) i++;
    return text[i] || '';
}

export function tokenize(formula, variables) {
    const tokens = [];
    let i = 0;
    while (i < formula.length) {
        const ch = formula[i];
        if (/\s/.test(ch)) { i++; continue; }
        if ('+-*/^(),[]'.includes(ch)) { tokens.push({ type: ch, value: ch }); i++; continue; }
        if (ch === '`') {
            const end = formula.indexOf('`', i + 1);
            if (end < 0) throw new Error('Missing closing backtick.');
            const name = formula.slice(i + 1, end);
            if (!variables[name]) throw new Error(`Unknown variable "${name}".`);
            tokens.push({ type: 'name', value: name, start: i, end: end + 1, quoted: true });
            i = end + 1;
            continue;
        }
        if (/\d|\./.test(ch)) {
            const match = formula.slice(i).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
            if (!match) throw new Error(`Unexpected "." at position ${i + 1}.`);
            tokens.push({ type: 'number', value: Number(match[0]) });
            i += match[0].length;
            continue;
        }
        if (/[A-Za-z_]/.test(ch)) {
            // Brackets are ambiguous: they subscript a name (`der(x[1])`,
            // `phase[2].v` — Modelica arrays are everywhere in these files) and
            // they also open the operand list of min()/max(). Depth decides. A
            // `]` is part of the name only while this name has an unclosed `[`,
            // so the last bracket of `min([a, b[1]])` stays a token of its own.
            let j = i + 1;
            let depth = 0;
            while (j < formula.length) {
                const c = formula[j];
                if (c === '[') { depth++; j++; continue; }
                if (c === ']') {
                    if (depth === 0) break;
                    depth--;
                    j++;
                    continue;
                }
                if (!/[A-Za-z0-9_.]/.test(c)) break;
                j++;
            }
            const name = formula.slice(i, j);
            const functionName = normalizeFunctionName(name);
            if (nextNonSpaceChar(formula, j) === '(' && functionName) {
                tokens.push({ type: 'func', value: functionName });
                i = j;
                continue;
            }
            if (!variables[name]) {
                // A named number, and only where the file left the name free —
                // see DERIVED_CONSTANTS. It becomes a plain number token here, so
                // nothing downstream (codegen, the compile cache key, the session's
                // reference list) has to know constants exist at all.
                const constant = DERIVED_CONSTANTS.get(name.toLowerCase());
                if (constant !== undefined) {
                    tokens.push({ type: 'number', value: constant });
                    i = j;
                    continue;
                }
                throw new Error(`Unknown variable "${name}".`);
            }
            tokens.push({ type: 'name', value: name, start: i, end: j, quoted: false });
            i = j;
            continue;
        }
        throw new Error(`Unexpected "${ch}" at position ${i + 1}.`);
    }
    return tokens;
}

export function parse(tokens) {
    let pos = 0;
    const peek = () => tokens[pos];
    const take = (type) => (peek()?.type === type ? tokens[pos++] : null);
    const parsePrimary = () => {
        const token = peek();
        if (!token) throw new Error('Unexpected end of formula.');
        if (take('number')) return { type: 'number', value: token.value };
        if (take('name')) return { type: 'name', value: token.value };
        if (take('func')) {
            const name = token.value;
            if (!take('(')) throw new Error(`Missing opening parenthesis after "${name}".`);
            const args = [];
            if (!take(')')) {
                do {
                    args.push(parseAddSub());
                } while (take(','));
                if (!take(')')) throw new Error(`Missing closing parenthesis for "${name}".`);
            }
            return { type: 'func', name, args };
        }
        if (take('(')) {
            const expr = parseAddSub();
            if (!take(')')) throw new Error('Missing closing parenthesis.');
            return expr;
        }
        // `[a, b, c]` — an operand list, not a value. Only min() and max() take
        // one; the compiler rejects it anywhere else (see flattenLists there),
        // where it can name the list in the error instead of a node type.
        if (take('[')) {
            const items = [];
            if (!take(']')) {
                do {
                    items.push(parseAddSub());
                } while (take(','));
                if (!take(']')) throw new Error('Missing closing bracket "]".');
            }
            return { type: 'list', items };
        }
        throw new Error(`Unexpected "${token.value}".`);
    };
    const parsePower = () => {
        let node = parsePrimary();
        if (take('^')) {
            node = { type: 'binary', op: '^', left: node, right: parseUnary() };
        }
        return node;
    };
    const parseUnary = () => {
        if (take('+')) return parseUnary();
        if (take('-')) return { type: 'unary', op: '-', expr: parseUnary() };
        return parsePower();
    };
    const parseMulDiv = () => {
        let node = parseUnary();
        while (peek()?.type === '*' || peek()?.type === '/') {
            const op = tokens[pos++].type;
            node = { type: 'binary', op, left: node, right: parseUnary() };
        }
        return node;
    };
    const parseAddSub = () => {
        let node = parseMulDiv();
        while (peek()?.type === '+' || peek()?.type === '-') {
            const op = tokens[pos++].type;
            node = { type: 'binary', op, left: node, right: parseMulDiv() };
        }
        return node;
    };
    const ast = parseAddSub();
    if (pos < tokens.length) throw new Error(`Unexpected "${tokens[pos].value}".`);
    return ast;
}
