/**
 * OpenModelica MAT v4 Parser (JavaScript)
 * Based on python/read_mat.py
 *
 * Reads OpenModelica .mat result files and builds a hierarchical
 * structure of variables and components.
 */

class MatParser {
    constructor() {
        this.ELEM_SIZES = {
            0: 8,  // double
            1: 4,  // float
            2: 4,  // int32
            3: 2,  // int16
            4: 2,  // uint16
            5: 1   // uint8
        };
    }

    /**
     * Parse a .mat file from an ArrayBuffer
     * @param {ArrayBuffer} buffer - The file content as ArrayBuffer
     * @returns {Object} Parsed result with metadata and variables
     */
    async parse(buffer) {
        const matrices = this._readMatrices(buffer);

        // Validate required matrices
        const required = ['Aclass', 'name', 'dataInfo'];
        for (const key of required) {
            if (!matrices[key]) {
                throw new Error(`Missing '${key}' matrix. Found: ${Object.keys(matrices).join(', ')}`);
            }
        }

        // Detect binTrans format
        const needsTranspose = this._detectBinTrans(matrices);

        // Helper functions
        const getMeta = (name) => {
            const data = matrices[name].data;
            return needsTranspose ? this._transpose(data) : data;
        };

        const getData = (name) => {
            return matrices[name].data;  // Data matrices are never transposed
        };

        // Parse variable names and descriptions
        const varNames = this._charsToStrings(getMeta('name'));
        let descriptions = new Array(varNames.length).fill('');
        if (matrices['description']) {
            descriptions = this._charsToStrings(getMeta('description'));
            while (descriptions.length < varNames.length) {
                descriptions.push('');
            }
        }

        // Parse dataInfo
        const dataInfo = getMeta('dataInfo');
        if (dataInfo.length !== varNames.length) {
            throw new Error(
                `dataInfo rows (${dataInfo.length}) != names (${varNames.length}). ` +
                `binTrans=${needsTranspose}`
            );
        }

        // Collect data matrices
        const dataMats = {};
        for (const [key] of Object.entries(matrices)) {
            if (key.startsWith('data_') && !isNaN(parseInt(key.substring(5)))) {
                const idx = parseInt(key.substring(5));
                dataMats[idx] = getData(key);
            }
        }

        // Build result
        const result = {
            filename: '',
            metadata: {},
            variables: {},    // flat dict: name -> variable
            tree: {}          // hierarchical tree
        };

        let timeVar = null;

        // Process each variable
        for (let i = 0; i < varNames.length; i++) {
            const varName = varNames[i];
            const matIdx = dataInfo[i][0];     // 0=abscissa, 1=parameter, 2+=variable
            const colIdx = dataInfo[i][1];     // 1-based row, negative=negate
            const interp = dataInfo[i][2];     // interpolation type

            // Resolve data matrix
            const actualMat = matIdx > 0 ? matIdx : 2;
            const negate = colIdx < 0;
            const row = Math.abs(colIdx) - 1;

            if (!dataMats[actualMat]) {
                continue;
            }

            const dm = dataMats[actualMat];
            if (row < 0 || row >= dm.length) {
                continue;
            }

            let values = dm[row];
            if (negate) {
                values = values.map(v => -v);
            }

            const kind = {
                0: 'abscissa',
                1: 'parameter',
                2: 'variable'
            }[matIdx] || 'variable';

            const interpStr = {
                0: 'discrete',
                1: 'linear'
            }[Math.abs(interp)] || String(interp);

            // Detect data type
            const dataType = this._detectDataType(values, kind);

            const variable = {
                name: varName,
                data: values,
                description: descriptions[i],
                kind: kind,
                dataType: dataType,
                interpolation: interpStr,
                negate: negate
            };

            result.variables[varName] = variable;

            if (kind === 'abscissa') {
                timeVar = variable;
            }
        }

        // Set metadata
        if (timeVar) {
            result.metadata = {
                numVariables: Object.keys(result.variables).length,
                numParams: Object.values(result.variables).filter(v => v.kind === 'parameter').length,
                numTimevarying: Object.values(result.variables).filter(v => v.kind === 'variable').length,
                numTimesteps: timeVar.data.length,
                timeStart: timeVar.data[0],
                timeEnd: timeVar.data[timeVar.data.length - 1],
                binTrans: needsTranspose,
                timeName: timeVar.name
            };
        }

        // Build hierarchical tree
        result.tree = this._buildTree(result.variables);

        return result;
    }

    /**
     * Read all matrices from MAT v4 file
     * @private
     */
    _readMatrices(buffer) {
        const view = new DataView(buffer);
        const fileSize = buffer.byteLength;
        let offset = 0;
        const matrices = {};

        while (offset + 20 <= fileSize) {
            // Try little-endian first
            let mopt = view.getInt32(offset, true);
            let mrows = view.getInt32(offset + 4, true);
            let ncols = view.getInt32(offset + 8, true);
            let imagf = view.getInt32(offset + 12, true);
            let namlen = view.getInt32(offset + 16, true);
            let M = Math.floor(mopt / 1000);
            let littleEndian = true;

            // Validate and try big-endian if needed
            if (M > 1 || mrows < 0 || ncols < 0 || namlen < 1 || namlen > 100000) {
                mopt = view.getInt32(offset, false);
                mrows = view.getInt32(offset + 4, false);
                ncols = view.getInt32(offset + 8, false);
                imagf = view.getInt32(offset + 12, false);
                namlen = view.getInt32(offset + 16, false);
                M = Math.floor(mopt / 1000);
                littleEndian = false;

                if (mrows < 0 || ncols < 0 || namlen < 1) {
                    break;
                }
            }

            const P = Math.floor((mopt % 100) / 10);
            const elemSize = this.ELEM_SIZES[P] || 8;

            offset += 20;

            // Read name
            const nameBytes = new Uint8Array(buffer, offset, namlen);
            let name = '';
            for (let i = 0; i < namlen; i++) {
                if (nameBytes[i] === 0) break;
                name += String.fromCharCode(nameBytes[i]);
            }
            offset += namlen;

            // Read data
            const numElements = mrows * ncols;
            const data = this._readMatrixData(buffer, offset, numElements, P, littleEndian);
            offset += numElements * elemSize;

            // Skip imaginary part if present
            if (imagf) {
                offset += numElements * elemSize;
            }

            // Reshape: column-major to row-major
            const reshaped = this._reshapeColumnMajor(data, mrows, ncols);

            matrices[name] = {
                name: name,
                mrows: mrows,
                ncols: ncols,
                P: P,
                data: reshaped
            };
        }

        return matrices;
    }

    /**
     * Read matrix data based on type
     * @private
     */
    _readMatrixData(buffer, offset, numElements, P, littleEndian) {
        const view = new DataView(buffer);
        const data = [];

        for (let i = 0; i < numElements; i++) {
            let value;
            switch (P) {
                case 0: // double
                    value = view.getFloat64(offset + i * 8, littleEndian);
                    break;
                case 1: // float
                    value = view.getFloat32(offset + i * 4, littleEndian);
                    break;
                case 2: // int32
                    value = view.getInt32(offset + i * 4, littleEndian);
                    break;
                case 3: // int16
                    value = view.getInt16(offset + i * 2, littleEndian);
                    break;
                case 4: // uint16
                    value = view.getUint16(offset + i * 2, littleEndian);
                    break;
                case 5: // uint8
                    value = view.getUint8(offset + i);
                    break;
                default:
                    value = view.getFloat64(offset + i * 8, littleEndian);
            }
            data.push(value);
        }

        return data;
    }

    /**
     * Reshape column-major flat array to row-major 2D array
     * @private
     */
    _reshapeColumnMajor(data, mrows, ncols) {
        const result = [];
        for (let i = 0; i < mrows; i++) {
            const row = [];
            for (let j = 0; j < ncols; j++) {
                row.push(data[j * mrows + i]);
            }
            result.push(row);
        }
        return result;
    }

    /**
     * Transpose a 2D array
     * @private
     */
    _transpose(matrix) {
        if (!matrix || matrix.length === 0) return matrix;
        const rows = matrix.length;
        const cols = matrix[0].length;
        const result = [];
        for (let j = 0; j < cols; j++) {
            const row = [];
            for (let i = 0; i < rows; i++) {
                row.push(matrix[i][j]);
            }
            result.push(row);
        }
        return result;
    }

    /**
     * Detect binTrans format from Aclass matrix
     * @private
     */
    _detectBinTrans(matrices) {
        const ac = matrices['Aclass'].data;
        let acStrings = this._charsToStrings(ac);

        if (acStrings.length >= 4 && acStrings[0].startsWith('Atrajectory')) {
            return acStrings[3].toLowerCase().includes('bintrans');
        }

        // Try transposed
        const acT = this._transpose(ac);
        acStrings = this._charsToStrings(acT);
        if (acStrings.length >= 4 && acStrings[0].startsWith('Atrajectory')) {
            return acStrings[3].toLowerCase().includes('bintrans');
        }

        return false;
    }

    /**
     * Convert 2D char-code matrix to array of strings
     * @private
     */
    _charsToStrings(data2d) {
        const strings = [];
        for (const row of data2d) {
            let str = '';
            for (const c of row) {
                const ci = Math.floor(c);
                if (ci === 0) break;
                str += String.fromCharCode(ci);
            }
            strings.push(str.trim());
        }
        return strings;
    }

    /**
     * Build hierarchical tree from flat variables dict
     * @private
     */
    /**
     * Split a Modelica variable name into tree path segments and a leaf name,
     * handling function wrappers like der(), pre(), etc.
     *
     * Examples:
     *   "der(Capacitor1.v)"  -> { path: ["Capacitor1"], leaf: "der(v)" }
     *   "a.b.der(c.d)"       -> { path: ["a", "b", "c"], leaf: "der(d)" }
     *   "der(Qtotal)"        -> { path: [], leaf: "der(Qtotal)" }
     *   "Capacitor1.v"       -> { path: ["Capacitor1"], leaf: "v" }
     *   "simple"             -> { path: [], leaf: "simple" }
     *
     * @param {string} varName
     * @returns {{ path: string[], leaf: string }}
     */
    splitModelicaName(varName) {
        // Match an optional dot-separated prefix, then func(inner)
        // e.g. "a.b.der(c.d.e)" -> prefix="a.b.", func="der", inner="c.d.e"
        const funcMatch = varName.match(/^((?:[^.(]+\.)*?)([^.(]+)\(([^)]+)\)$/);

        if (funcMatch) {
            const prefix  = funcMatch[1]; // e.g. "a.b."  (may be empty)
            const func    = funcMatch[2]; // e.g. "der"
            const inner   = funcMatch[3]; // e.g. "c.d.e"

            const prefixParts = prefix ? prefix.replace(/\.$/, '').split('.') : [];
            const innerParts  = inner.split('.');

            // All inner parts except the last become path segments
            const path = [...prefixParts, ...innerParts.slice(0, -1)];
            const leaf = `${func}(${innerParts[innerParts.length - 1]})`;

            return { path, leaf };
        }

        // Plain dotted name — no function wrapper
        const parts = varName.split('.');
        return {
            path: parts.slice(0, -1),
            leaf: parts[parts.length - 1]
        };
    }

    _buildTree(variables) {
        const tree = {
            _type: 'root',
            _name: '',
            _children: {},
            _variables: {}
        };

        for (const [name, variable] of Object.entries(variables)) {
            const { path, leaf } = this.splitModelicaName(name);
            let node = tree;

            // Navigate/create component nodes
            for (let i = 0; i < path.length; i++) {
                const part = path[i];
                if (!node._children[part]) {
                    node._children[part] = {
                        _type: 'component',
                        _name: part,
                        _fullName: path.slice(0, i + 1).join('.'),
                        _children: {},
                        _variables: {}
                    };
                }
                node = node._children[part];
            }

            // Add variable to leaf node
            node._variables[leaf] = variable;
        }

        return tree;
    }

    /**
     * Get info string for a variable (for display)
     * @param {Object} variable
     * @returns {string}
     */
    getVariableInfo(variable) {
        const unit = this._extractUnit(variable.description);

        if (variable.kind === 'parameter') {
            const val = variable.data && variable.data.length > 0 ? variable.data[0] : undefined;
            if (val === undefined || val === null || isNaN(val)) {
                return `= ?${unit}`;
            }
            return `= ${this._formatNumber(val)}${unit}`;
        } else if (variable.kind === 'abscissa') {
            return `[${variable.data.length} pts]${unit}`;
        } else {
            // Show data type for regular variables
            const typeLabel = variable.dataType ? ` (${variable.dataType})` : '';
            return `[${variable.data.length} pts]${unit}${typeLabel}`;
        }
    }

    /**
     * Extract unit from description
     * @private
     */
    _extractUnit(description) {
        if (!description) return '';
        const match = description.match(/\[([^\]]+)\]/);
        if (match) {
            const parts = match[1].split('|');
            // Prefer displayUnit (after |) over the SI base unit expression (before |)
            const unit = (parts[1] ?? parts[0]).trim();
            if (unit && !unit.startsWith('#')) {
                return ` [${unit}]`;
            }
        }
        return '';
    }

    /**
     * Format number for display
     * @private
     */
    _formatNumber(num) {
        // Validate that num is a number
        if (typeof num !== 'number' || isNaN(num)) {
            return '?';
        }

        // Handle special cases
        if (!isFinite(num)) {
            return num.toString();  // 'Infinity' or '-Infinity'
        }

        // Format based on magnitude
        if (num === 0) {
            return '0';
        }

        const absNum = Math.abs(num);
        if (absNum < 1e-6 || absNum > 1e6) {
            return num.toExponential(3);
        }

        return num.toPrecision(6);
    }

    /**
     * Detect data type from values
     * @private
     * @param {Array} values - Array of numerical values
     * @param {string} kind - Variable kind (abscissa, parameter, variable)
     * @returns {string} - Data type: 'boolean', 'integer', 'real'
     */
    _detectDataType(values, _kind) {
        if (!values || values.length === 0) {
            return 'real';
        }

        let allInteger = true;
        let allBooleanValues = true;
        let hasZero = false;
        let hasOne = false;

        for (let i = 0; i < values.length; i++) {
            const v = values[i];

            // Skip non-finite values
            if (!Number.isFinite(v)) {
                continue;
            }

            // Check if integer
            if (v !== Math.floor(v)) {
                allInteger = false;
                allBooleanValues = false;
                break; // Found a decimal - it's real
            }

            // Check if boolean (only 0 or 1)
            if (v !== 0 && v !== 1) {
                allBooleanValues = false;
            } else {
                // Track if we have both 0 and 1
                if (v === 0) hasZero = true;
                if (v === 1) hasOne = true;
            }
        }

        // Only boolean if it has BOTH 0 and 1 values (not just constant 0 or constant 1)
        if (allBooleanValues && hasZero && hasOne) return 'boolean';
        if (allInteger) return 'integer';
        return 'real';
    }

    /**
     * Get icon for a variable based on its type
     * @param {Object} variable
     * @returns {string} - Emoji icon
     */
    getVariableIcon(variable) {
        if (variable.kind === 'abscissa') {
            return '🕐';  // Time
        }

        if (variable.kind === 'parameter') {
            return '⚙️';  // Parameter/constant
        }

        // For regular variables, use type-specific icons
        switch (variable.dataType) {
            case 'boolean':
                return '🔘';  // Boolean
            case 'integer':
                return '🔢';  // Integer
            case 'real':
            default:
                return '📈';  // Real/continuous
        }
    }

    /**
     * Count variables in a tree node (recursive)
     * @param {Object} node
     * @returns {number}
     */
    countVariables(node) {
        let count = Object.keys(node._variables || {}).length;
        for (const child of Object.values(node._children || {})) {
            count += this.countVariables(child);
        }
        return count;
    }

    /**
     * Find the derivative variable name for a given variable.
     * Tries "der(name)" first, then common OpenModelica patterns.
     * @param {string} varName - e.g. "pendulum.phi"
     * @param {Object} variables - flat dict of all variables
     * @returns {string|null} - derivative variable name if found
     */
    findDerivative(varName, variables) {
        // Most common: der(varName)
        const derName = `der(${varName})`;
        if (variables[derName]) return derName;
        return null;
    }

    /**
     * Detect vector siblings for a variable like "x[1]" → ["x[1]","x[2]","x[3]"].
     * @param {string} varName - e.g. "body.x[1]"
     * @param {Object} variables - flat dict of all variables
     * @returns {string[]|null} - sorted array of sibling names, or null if not a vector
     */
    findVectorSiblings(varName, variables) {
        const m = varName.match(/^(.+)\[(\d+)\]$/);
        if (!m) return null;
        const base = m[1];
        const siblings = [];
        for (const name of Object.keys(variables)) {
            const sm = name.match(/^(.+)\[(\d+)\]$/);
            if (sm && sm[1] === base) siblings.push(name);
        }
        if (siblings.length < 2) return null;
        siblings.sort((a, b) => {
            const ia = parseInt(a.match(/\[(\d+)\]$/)[1]);
            const ib = parseInt(b.match(/\[(\d+)\]$/)[1]);
            return ia - ib;
        });
        return siblings;
    }
}
