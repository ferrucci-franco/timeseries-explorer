import { unzlibSync } from 'fflate';
import h5wasm from 'h5wasm';
import MatParser from './mat-parser.js';

const HDF5_MAGIC = [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a];
const MAT5_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 9, 12, 13, 14, 15, 16, 17, 18]);
const TYPE_NAMES = {
    1: 'int8', 2: 'uint8', 3: 'int16', 4: 'uint16', 5: 'int32', 6: 'uint32',
    7: 'single', 9: 'double', 12: 'int64', 13: 'uint64', 16: 'utf8', 17: 'utf16', 18: 'utf32',
};
const CLASS_NAMES = {
    1: 'cell', 2: 'struct', 3: 'object', 4: 'char', 5: 'sparse', 6: 'double',
    7: 'single', 8: 'int8', 9: 'uint8', 10: 'int16', 11: 'uint16',
    12: 'int32', 13: 'uint32', 14: 'int64', 15: 'uint64',
};

function bytesStartWith(buffer, signature) {
    if (!buffer || buffer.byteLength < signature.length) return false;
    const bytes = new Uint8Array(buffer, 0, signature.length);
    return signature.every((value, index) => bytes[index] === value);
}

function decodeAscii(bytes) {
    return new TextDecoder('latin1').decode(bytes).replace(/\0+$/g, '');
}

function product(shape) {
    return shape.reduce((total, size) => total * Math.max(0, Number(size) || 0), 1);
}

function numericValue(value) {
    if (typeof value === 'bigint') {
        return Number(value);
    }
    if (typeof value === 'boolean') return value ? 1 : 0;
    return Number(value);
}

function numericArray(value) {
    if (value == null) return [];
    const source = ArrayBuffer.isView(value) || Array.isArray(value) ? value : [value];
    return Array.from(source, numericValue);
}

function previewValues(values, limit = 5) {
    return Array.from(values || []).slice(0, limit).map(value => {
        if (typeof value === 'string') return JSON.stringify(value.length > 28 ? `${value.slice(0, 25)}…` : value);
        const number = numericValue(value);
        return Number.isFinite(number) ? Number(number.toPrecision(6)).toString() : String(value);
    }).join(', ');
}

function shapeLabel(shape) {
    return (shape?.length ? shape : [1, 1]).join(' × ');
}

function isNumericClass(className) {
    return /^(?:numeric|double|single|u?int(?:8|16|32|64)|logical|sparse)$/i.test(String(className || ''));
}

function defaultSelected(descriptor) {
    return descriptor.selectable && descriptor.elementCount > 0;
}

export function detectMatFileVersion(buffer) {
    if (bytesStartWith(buffer, HDF5_MAGIC)) return '7.3';
    if (buffer?.byteLength >= 128) {
        const header = decodeAscii(new Uint8Array(buffer, 0, Math.min(116, buffer.byteLength)));
        if (/^MATLAB 7\.3 MAT-file/i.test(header)) return '7.3';
        if (/^MATLAB (?:5\.0 )?MAT-file/i.test(header)) return '5-7';
    }
    return '4';
}

class Mat5Reader {
    constructor(buffer) {
        this.buffer = buffer;
        const marker = decodeAscii(new Uint8Array(buffer, 126, 2));
        this.littleEndian = marker === 'IM';
        if (!this.littleEndian && marker !== 'MI') throw new Error('Invalid MATLAB Level 5 endian marker.');
    }

    read() {
        const nodes = [];
        this._readElements(new Uint8Array(this.buffer, 128), nodes, '');
        return nodes;
    }

    _readElements(bytes, nodes, prefix) {
        let offset = 0;
        while (offset + 8 <= bytes.byteLength) {
            const tag = this._tag(bytes, offset);
            if (!tag || tag.nextOffset <= offset || tag.dataOffset + tag.length > bytes.byteLength) break;
            const payload = bytes.subarray(tag.dataOffset, tag.dataOffset + tag.length);
            if (tag.type === 15) {
                const inflated = unzlibSync(payload);
                this._readElements(inflated, nodes, prefix);
            } else if (tag.type === 14) {
                const node = this._matrix(payload, prefix);
                if (node) nodes.push(node);
            }
            offset = tag.nextOffset;
        }
    }

    _tag(bytes, offset) {
        if (offset + 8 > bytes.byteLength) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const regularType = view.getUint32(offset, this.littleEndian);
        if (MAT5_TYPES.has(regularType)) {
            const length = view.getUint32(offset + 4, this.littleEndian);
            return {
                type: regularType,
                length,
                dataOffset: offset + 8,
                // SciPy/MATLAB Level 5 writers commonly place consecutive
                // miCOMPRESSED elements without the usual 64-bit padding.
                nextOffset: offset + 8 + (regularType === 15 ? length : Math.ceil(length / 8) * 8),
            };
        }
        const type = view.getUint16(offset, this.littleEndian);
        const length = view.getUint16(offset + 2, this.littleEndian);
        if (!MAT5_TYPES.has(type) || length > 4) return null;
        return { type, length, dataOffset: offset + 4, nextOffset: offset + 8, small: true };
    }

    _subelements(bytes) {
        const tags = [];
        let offset = 0;
        while (offset + 8 <= bytes.byteLength) {
            const tag = this._tag(bytes, offset);
            if (!tag || tag.nextOffset <= offset || tag.dataOffset + tag.length > bytes.byteLength) break;
            tags.push({ ...tag, bytes: bytes.subarray(tag.dataOffset, tag.dataOffset + tag.length) });
            offset = tag.nextOffset;
        }
        return tags;
    }

    _matrix(payload, prefix) {
        const parts = this._subelements(payload);
        if (parts.length < 3) return null;
        const flags = this._numbers(parts[0]);
        const classId = Number(flags[0] || 0) & 0xff;
        const className = CLASS_NAMES[classId] || `class-${classId}`;
        const flagBits = Number(flags[0] || 0);
        const shape = this._numbers(parts[1]).map(value => Math.max(0, Number(value) || 0));
        const encodedName = decodeAscii(parts[2].bytes);
        const localName = encodedName || 'unnamed';
        const path = prefix ? (encodedName ? `${prefix}.${localName}` : prefix) : localName;
        const complex = !!(flagBits & 0x0800);
        const logical = !!(flagBits & 0x0200);
        const base = { name: localName, path, className: logical ? 'logical' : className, shape, complex, logical, children: [] };

        if (classId === 1) return this._cell(base, parts.slice(3));
        if (classId === 2 || classId === 3) return this._struct(base, parts.slice(3));
        if (classId === 5) return this._sparse(base, parts.slice(3));
        if (classId === 4) {
            const codes = parts[3] ? this._numbers(parts[3]) : [];
            base.text = String.fromCodePoint(...codes.filter(code => code > 0 && code <= 0x10ffff));
            base.data = codes;
            base.layout = 'column-major';
            return base;
        }

        base.data = parts[3] ? this._numbers(parts[3]) : [];
        base.imaginary = complex && parts[4] ? this._numbers(parts[4]) : null;
        base.storageType = parts[3] ? TYPE_NAMES[parts[3].type] || String(parts[3].type) : className;
        base.layout = 'column-major';
        return base;
    }

    _nestedMatrix(tag, prefix) {
        if (tag?.type !== 14) return null;
        return this._matrix(tag.bytes, prefix);
    }

    _cell(base, parts) {
        const count = product(base.shape);
        for (let index = 0; index < Math.min(count, parts.length); index++) {
            const child = this._nestedMatrix(parts[index], `${base.path}{${index + 1}}`);
            if (child) base.children.push(child);
        }
        return base;
    }

    _struct(base, parts) {
        if (parts.length < 2) return base;
        const fieldLength = Number(this._numbers(parts[0])[0] || 0);
        const namesBytes = parts[1].bytes;
        const fields = [];
        for (let offset = 0; fieldLength > 0 && offset < namesBytes.length; offset += fieldLength) {
            fields.push(decodeAscii(namesBytes.subarray(offset, offset + fieldLength)));
        }
        const matrices = parts.slice(2);
        const instances = Math.max(1, product(base.shape));
        for (let instance = 0; instance < instances; instance++) {
            for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
                const tag = matrices[instance * fields.length + fieldIndex];
                const instancePrefix = instances > 1 ? `${base.path}(${instance + 1})` : base.path;
                const child = this._nestedMatrix(tag, instancePrefix);
                if (!child) continue;
                const oldPath = child.path;
                child.name = fields[fieldIndex] || child.name;
                child.path = `${instancePrefix}.${child.name}`;
                this._rebaseChildren(child, oldPath, child.path);
                base.children.push(child);
            }
        }
        return base;
    }

    _rebaseChildren(node, oldPrefix, newPrefix) {
        for (const child of node.children || []) {
            if (child.path === oldPrefix) child.path = newPrefix;
            else if (child.path.startsWith(`${oldPrefix}.`)) child.path = `${newPrefix}${child.path.slice(oldPrefix.length)}`;
            this._rebaseChildren(child, oldPrefix, newPrefix);
        }
    }

    _sparse(base, parts) {
        const rows = Number(base.shape[0] || 0);
        const cols = Number(base.shape[1] || 0);
        const ir = parts[0] ? this._numbers(parts[0]) : [];
        const jc = parts[1] ? this._numbers(parts[1]) : [];
        const real = parts[2] ? this._numbers(parts[2]) : [];
        const imag = base.complex && parts[3] ? this._numbers(parts[3]) : null;
        base.data = new Array(rows * cols).fill(0);
        base.imaginary = imag ? new Array(rows * cols).fill(0) : null;
        for (let col = 0; col < cols; col++) {
            for (let cursor = Number(jc[col] || 0); cursor < Number(jc[col + 1] || 0); cursor++) {
                const row = Number(ir[cursor]);
                if (row >= 0 && row < rows) {
                    base.data[col * rows + row] = numericValue(real[cursor]);
                    if (base.imaginary) base.imaginary[col * rows + row] = numericValue(imag[cursor]);
                }
            }
        }
        base.layout = 'column-major';
        base.storageType = 'sparse';
        return base;
    }

    _numbers(tag) {
        const bytes = tag?.bytes || new Uint8Array();
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const result = [];
        const read = {
            1: [1, (o) => view.getInt8(o)], 2: [1, (o) => view.getUint8(o)],
            3: [2, (o) => view.getInt16(o, this.littleEndian)], 4: [2, (o) => view.getUint16(o, this.littleEndian)],
            5: [4, (o) => view.getInt32(o, this.littleEndian)], 6: [4, (o) => view.getUint32(o, this.littleEndian)],
            7: [4, (o) => view.getFloat32(o, this.littleEndian)], 9: [8, (o) => view.getFloat64(o, this.littleEndian)],
            12: [8, (o) => view.getBigInt64(o, this.littleEndian)], 13: [8, (o) => view.getBigUint64(o, this.littleEndian)],
            16: [1, (o) => view.getUint8(o)], 17: [2, (o) => view.getUint16(o, this.littleEndian)],
            18: [4, (o) => view.getUint32(o, this.littleEndian)],
        }[tag?.type];
        if (!read) return result;
        for (let offset = 0; offset + read[0] <= bytes.byteLength; offset += read[0]) result.push(read[1](offset));
        return result;
    }
}

export default class MatlabMatFile {
    constructor(structureParser = null) {
        this.structureParser = structureParser || new MatParser();
        this._sequence = 0;
    }

    async inspect(buffer, filename = '') {
        if (!buffer?.byteLength) throw new Error('The MAT file is empty.');
        const version = detectMatFileVersion(buffer);
        if (version === '4') return this._inspectV4(buffer, filename);
        if (version === '7.3') return this._inspectV73(buffer, filename);
        return this._inspectV5(buffer, filename);
    }

    async parse(buffer, filename = '', options = {}) {
        const inspection = options.inspection || await this.inspect(buffer, filename);
        if (inspection.kind === 'modelica') return inspection.data || this.structureParser.parse(buffer);
        return this.materialize(inspection, options.selection || null, filename);
    }

    _inspectV4(buffer, filename) {
        const matrices = this.structureParser._readMatrices(buffer);
        const names = Object.keys(matrices);
        if (['Aclass', 'name', 'dataInfo'].every(name => matrices[name])) {
            return this.structureParser.parse(buffer).then(data => ({
                version: '4', kind: 'modelica', filename, data, entries: [],
            }));
        }
        const entries = names.map(name => {
            const matrix = matrices[name];
            const flat = matrix.data.flat();
            const v4Class = matrix.T === 1
                ? 'char'
                : ({ 0: 'double', 1: 'single', 2: 'int32', 3: 'int16', 4: 'uint16', 5: 'uint8' }[matrix.P] || `type-${matrix.P}`);
            return this._descriptor({
                path: name, name, className: v4Class,
                storageType: `mat-v4-${matrix.P}`, shape: [matrix.mrows, matrix.ncols], data: flat,
                text: matrix.T === 1 ? String.fromCodePoint(...flat.filter(code => code > 0 && code <= 0x10ffff)) : '',
                imaginary: matrix.imaginaryData?.flat() || null, complex: !!matrix.imaginaryData, layout: 'row-major',
            });
        });
        return { version: '4', kind: 'general', filename, entries };
    }

    _inspectV5(buffer, filename) {
        const nodes = new Mat5Reader(buffer).read();
        const entries = [];
        const visit = node => {
            if (node.children?.length) node.children.forEach(visit);
            if (node.data || node.text != null) entries.push(this._descriptor(node));
        };
        nodes.forEach(visit);
        if (!entries.length) throw new Error('The MATLAB Level 5 file contains no readable arrays.');
        return { version: '5-7', kind: 'general', filename, entries };
    }

    async _inspectV73(buffer, filename) {
        const module = await h5wasm.ready;
        const virtualPath = `/matlab-${Date.now()}-${this._sequence++}.mat`;
        module.FS.writeFile(virtualPath, new Uint8Array(buffer));
        const file = new h5wasm.File(virtualPath, 'r');
        try {
            const entries = [];
            const addReferencedGroup = (group, displayPrefix, referenceDepth) => {
                const actualPrefix = String(group?.path || '').replace(/^\//, '');
                for (const key of group?.keys?.().sort?.() || []) {
                    const child = file.get(actualPrefix ? `${actualPrefix}/${key}` : key);
                    const childPath = `${displayPrefix}.${key}`;
                    if (child?.type === 'Group') addReferencedGroup(child, childPath, referenceDepth + 1);
                    else addDataset(child, childPath, key, referenceDepth + 1);
                }
            };
            const addDataset = (object, path, name, referenceDepth = 0) => {
                if (object?.type !== 'Dataset' || referenceDepth > 8) return;
                const attrs = object.attrs || {};
                const matlabClassRaw = attrs.MATLAB_class?.value ?? attrs.MATLAB_class;
                const matlabClass = this._hdfString(matlabClassRaw) || this._hdfClassFromDtype(object.dtype);
                const value = object.value;
                const shape = Array.from(object.shape || [numericArray(value).length]);
                const references = Array.isArray(value)
                    ? value.filter(item => item?.ref_data)
                    : (value?.ref_data ? [value] : []);
                if (references.length) {
                    references.forEach((reference, index) => {
                        const target = file.dereference(reference);
                        const suffix = references.length > 1
                            ? (matlabClass === 'cell' ? `{${index + 1}}` : `(${index + 1})`)
                            : '';
                        const targetPath = `${path}${suffix}`;
                        if (target?.type === 'Group') addReferencedGroup(target, targetPath, referenceDepth + 1);
                        else addDataset(target, targetPath, `${name}${suffix}`, referenceDepth + 1);
                    });
                    return;
                }
                if (matlabClass === 'char') {
                    const codes = numericArray(value);
                    entries.push(this._descriptor({ path, name, className: 'char', shape, data: codes,
                        text: String.fromCodePoint(...codes.filter(code => code > 0 && code <= 0x10ffff)), layout: 'row-major' }));
                    return;
                }
                if (value instanceof Map && value.has('real')) {
                    entries.push(this._descriptor({ path, name, className: matlabClass || 'double', storageType: String(object.dtype || ''),
                        shape, data: numericArray(value.get('real')), imaginary: numericArray(value.get('imag')), complex: true,
                        layout: 'row-major' }));
                    return;
                }
                const compoundFields = Array.isArray(object.dtype)
                    ? object.dtype.map(field => Array.isArray(field) ? field[0] : '').map(String)
                    : [];
                if (compoundFields.includes('real') && compoundFields.includes('imag') && Array.isArray(value)) {
                    const realIndex = compoundFields.indexOf('real');
                    const imagIndex = compoundFields.indexOf('imag');
                    entries.push(this._descriptor({ path, name, className: matlabClass || 'double', storageType: 'compound-complex',
                        shape, data: value.map(item => numericValue(item?.[realIndex])),
                        imaginary: value.map(item => numericValue(item?.[imagIndex])), complex: true, layout: 'row-major' }));
                    return;
                }
                if (isNumericClass(matlabClass) || this._hdfNumericValue(value)) {
                    entries.push(this._descriptor({ path, name, className: matlabClass, storageType: String(object.dtype || ''),
                        shape, data: numericArray(value), layout: 'row-major', logical: matlabClass === 'logical' }));
                }
            };
            const walk = (group, prefix = '') => {
                for (const key of group.keys().sort()) {
                    if (!prefix && key === '#refs#') continue;
                    const path = prefix ? `${prefix}/${key}` : key;
                    const object = file.get(path);
                    if (object?.type === 'Group') {
                        walk(object, path);
                        continue;
                    }
                    addDataset(object, path, key);
                }
            };
            walk(file);
            if (!entries.length) throw new Error('The MATLAB v7.3 file contains no readable numeric arrays.');
            return { version: '7.3', kind: 'general', filename, entries };
        } finally {
            file.close();
            try { module.FS.unlink(virtualPath); } catch { /* best effort */ }
        }
    }

    _hdfNumericValue(value) {
        if (ArrayBuffer.isView(value)) return !(value instanceof Uint8Array && typeof value[0] === 'string');
        return Array.isArray(value) && value.every(item => typeof item === 'number' || typeof item === 'bigint' || typeof item === 'boolean');
    }

    _hdfString(value) {
        if (typeof value === 'string') return value.replace(/\0/g, '');
        if (Array.isArray(value) || ArrayBuffer.isView(value)) {
            const values = Array.from(value);
            if (values.every(item => typeof item === 'number')) return decodeAscii(Uint8Array.from(values));
            return values.join('').replace(/\0/g, '');
        }
        return '';
    }

    _hdfClassFromDtype(dtype) {
        const text = String(dtype || '').toLowerCase();
        if (text.includes('float64') || text.includes('<f8') || text.includes('>f8')) return 'double';
        if (text.includes('float32') || text.includes('<f4') || text.includes('>f4')) return 'single';
        const match = text.match(/(u?int)(8|16|32|64)/);
        return match ? `${match[1]}${match[2]}` : 'numeric';
    }

    _descriptor(node) {
        const data = node.data || [];
        const className = node.logical ? 'logical' : node.className || node.storageType || 'numeric';
        const selectable = isNumericClass(className) || !!node.complex;
        const shape = node.shape?.length ? node.shape : [data.length, 1];
        return {
            id: node.path,
            path: node.path,
            name: node.name || node.path.split(/[./]/).pop(),
            className,
            storageType: node.storageType || className,
            shape,
            shapeLabel: shapeLabel(shape),
            elementCount: data.length || product(node.shape || []),
            complex: !!node.complex,
            logical: !!node.logical,
            text: node.text || '',
            preview: node.text ? JSON.stringify(node.text.slice(0, 80)) : previewValues(data),
            selectable,
            selected: defaultSelected({ selectable, elementCount: data.length || product(node.shape || []) }),
            data,
            imaginary: node.imaginary || null,
            layout: node.layout || 'column-major',
        };
    }

    materialize(inspection, selection = null, filename = '') {
        const selectedIds = new Set(selection?.selectedIds || inspection.entries.filter(entry => entry.selected).map(entry => entry.id));
        const selected = inspection.entries.filter(entry => entry.selectable && selectedIds.has(entry.id));
        if (!selected.length) throw new Error('Select at least one numeric MATLAB array.');
        const timeMode = selection?.timeMode || 'auto';
        const timeEntry = timeMode === 'index'
            ? null
            : this._chooseTimeEntry(selected, selection?.timeId || null);
        const matrixOrientations = selection?.matrixOrientations || {};
        const sampleLength = timeEntry?.elementCount || (timeMode === 'index'
            ? this._indexSampleLength(selected, matrixOrientations)
            : this._commonSampleLength(selected, matrixOrientations));
        const variables = {};
        const timeName = timeEntry ? this._safeName(timeEntry.path) : 'index';
        const timeData = timeEntry ? Float64Array.from(timeEntry.data, numericValue) : Float64Array.from({ length: sampleLength }, (_, index) => index);
        variables[timeName] = this._variable(timeName, timeData, 'abscissa', timeEntry, 'MATLAB sample axis');
        if (!timeEntry) variables[timeName].syntheticIndex = true;

        for (const entry of selected) {
            if (entry === timeEntry) continue;
            this._addEntryVariables(
                variables,
                entry,
                sampleLength,
                matrixOrientations[entry.id] || selection?.sampleAxisMode || 'auto',
                timeMode === 'index',
            );
        }
        if (Object.keys(variables).length === 1 && !timeEntry) throw new Error('The selected MATLAB arrays do not contain a usable vector or matrix.');
        const result = {
            filename,
            metadata: {
                format: `mat-v${inspection.version}`,
                source: 'matlab',
                matVersion: inspection.version,
                timeName,
                timeKind: timeEntry ? 'numeric' : 'index',
                numVariables: Object.keys(variables).length,
                numParams: Object.values(variables).filter(variable => variable.kind === 'parameter').length,
                numTimevarying: Object.values(variables).filter(variable => variable.kind === 'variable').length,
                numTimesteps: timeData.length,
                timeStart: timeData[0],
                timeEnd: timeData[timeData.length - 1],
                matlab: {
                    selectedIds: [...selectedIds],
                    timeId: timeEntry?.id || null,
                    timeMode,
                    sampleAxisMode: selection?.sampleAxisMode || 'auto',
                    matrixOrientations: { ...matrixOrientations },
                },
            },
            variables,
        };
        result.tree = this._buildMatlabTree(variables);
        return result;
    }

    _buildMatlabTree(variables) {
        const tree = { _type: 'root', _name: '', _children: {}, _variables: {} };
        const component = (parent, name, fullName) => {
            if (!parent._children[name]) {
                parent._children[name] = {
                    _type: 'component', _name: name, _fullName: fullName,
                    _children: {}, _variables: {},
                };
            }
            return parent._children[name];
        };
        const addVariable = (path, leaf, variable) => {
            let node = tree;
            const parts = [];
            for (const part of path) {
                parts.push(part);
                node = component(node, part, parts.join('.'));
            }
            node._variables[leaf] = variable;
        };

        for (const [name, variable] of Object.entries(variables)) {
            if (variable.syntheticIndex) continue;
            const shape = variable.matlab?.shape || [];
            const displayShape = variable.matlab?.displayShape || shape;
            const matrix = shape.length === 2 && shape[0] > 1 && shape[1] > 1;
            if (!matrix) {
                const { path, leaf } = this.structureParser.splitModelicaName(name);
                addVariable(path, leaf, variable);
                continue;
            }

            const matrixName = this._safeName(variable.matlab.path);
            const { path, leaf } = this.structureParser.splitModelicaName(matrixName);
            let node = tree;
            const parts = [];
            for (const part of path) {
                parts.push(part);
                node = component(node, part, parts.join('.'));
            }
            parts.push(leaf);
            const matrixNode = component(node, leaf, parts.join('.'));
            matrixNode._info = `(${displayShape.join(' × ')})`;
            matrixNode._matlabMatrix = {
                path: variable.matlab.path,
                shape: [...shape],
                displayShape: [...displayShape],
                orientation: variable.matlab.sampleAxisMode || 'rows',
            };
            const suffix = name.startsWith(matrixName)
                ? name.slice(matrixName.length).replace(/^\./, '')
                : name;
            matrixNode._variables[suffix || name] = variable;
        }
        return tree;
    }

    _chooseTimeEntry(entries, requestedId) {
        if (requestedId) return entries.find(entry => entry.id === requestedId && this._isVector(entry)) || null;
        const named = entries.find(entry => this._isVector(entry) && /^(?:time|times|t|tiempo|temps|timestamp|timestamps)$/i.test(entry.name));
        if (named && this._monotonic(named.data)) return named;
        return null;
    }

    _commonSampleLength(entries, matrixOrientations = {}) {
        const counts = new Map();
        for (const entry of entries) {
            const orientation = matrixOrientations[entry.id];
            if (orientation === 'rows' && entry.shape?.[0] > 1) {
                counts.set(entry.shape[0], (counts.get(entry.shape[0]) || 0) + 1);
                continue;
            }
            if (orientation === 'columns' && entry.shape?.[1] > 1) {
                counts.set(entry.shape[1], (counts.get(entry.shape[1]) || 0) + 1);
                continue;
            }
            for (const size of entry.shape || []) if (size > 1) counts.set(size, (counts.get(size) || 0) + 1);
        }
        const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
        return ranked[0]?.[0] || 1;
    }

    _indexSampleLength(entries, matrixOrientations = {}) {
        let longest = 1;
        for (const entry of entries) {
            if (entry.elementCount <= 1) continue;
            const orientation = matrixOrientations[entry.id];
            if (orientation === 'rows' && entry.shape?.[0]) longest = Math.max(longest, entry.shape[0]);
            else if (orientation === 'columns' && entry.shape?.[1]) longest = Math.max(longest, entry.shape[1]);
            else if (this._isVector(entry)) longest = Math.max(longest, entry.elementCount);
            else longest = Math.max(longest, ...(entry.shape || [entry.elementCount]));
        }
        return longest;
    }

    _isVector(entry) {
        return (entry.shape || []).filter(size => size > 1).length <= 1 && entry.elementCount > 1;
    }

    _monotonic(values) {
        if (!values || values.length < 2) return false;
        let previous = numericValue(values[0]);
        for (let index = 1; index < values.length; index++) {
            const value = numericValue(values[index]);
            if (!Number.isFinite(value) || value < previous) return false;
            previous = value;
        }
        return true;
    }

    _addEntryVariables(variables, entry, sampleLength, sampleAxisMode = 'auto', independentIndex = false) {
        const baseName = this._safeName(entry.path);
        if (entry.elementCount === 1) {
            if (entry.complex) {
                variables[`${baseName}.real`] = this._variable(`${baseName}.real`, [numericValue(entry.data[0])], 'parameter', entry, 'real component');
                variables[`${baseName}.imag`] = this._variable(`${baseName}.imag`, [numericValue(entry.imaginary?.[0] || 0)], 'parameter', entry, 'imaginary component');
            } else {
                variables[baseName] = this._variable(baseName, [numericValue(entry.data[0])], 'parameter', entry);
            }
            return;
        }
        const shape = entry.shape || [entry.elementCount];
        let sampleAxis = -1;
        if (sampleAxisMode === 'rows' && (independentIndex || shape[0] === sampleLength)) sampleAxis = 0;
        if (sampleAxisMode === 'columns' && (independentIndex || shape[1] === sampleLength)) sampleAxis = 1;
        if (sampleAxis < 0 && this._isVector(entry)) sampleAxis = shape.findIndex(size => size > 1);
        if (sampleAxis < 0) sampleAxis = shape.findIndex(size => size === sampleLength);
        if (sampleAxis < 0 && independentIndex) {
            sampleAxis = shape.reduce((best, size, axis) => size > (shape[best] || 0) ? axis : best, 0);
        }
        if (sampleAxis < 0) return;
        const entrySampleLength = shape[sampleAxis] || entry.elementCount;
        const seriesCount = Math.max(1, entry.elementCount / entrySampleLength);
        for (let seriesIndex = 0; seriesIndex < seriesCount; seriesIndex++) {
            const values = this._extractSeries(entry, sampleAxis, seriesIndex, entrySampleLength);
            const suffix = seriesCount > 1 ? this._seriesSuffix(shape, sampleAxis, seriesIndex) : '';
            const name = `${baseName}${suffix}`;
            if (entry.complex) {
                variables[`${name}.real`] = this._variable(`${name}.real`, values, 'variable', entry, 'real component');
            } else {
                variables[name] = this._variable(name, values, 'variable', entry);
            }
            const created = entry.complex ? variables[`${name}.real`] : variables[name];
            created.matlab.sampleAxisMode = sampleAxisMode;
            created.matlab.displayShape = sampleAxisMode === 'columns' && shape.length === 2
                ? [shape[1], shape[0]]
                : [...shape];
            if (independentIndex) {
                created.independentIndex = true;
                created.sampleIndexLength = values.length;
            }
            if (entry.complex && entry.imaginary) {
                const imaginaryEntry = { ...entry, data: entry.imaginary, complex: false };
                const rawImaginary = this._extractSeries(imaginaryEntry, sampleAxis, seriesIndex, entrySampleLength);
                variables[`${name}.imag`] = this._variable(`${name}.imag`, rawImaginary, 'variable', entry, 'imaginary component');
                variables[`${name}.imag`].matlab.sampleAxisMode = sampleAxisMode;
                variables[`${name}.imag`].matlab.displayShape = sampleAxisMode === 'columns' && shape.length === 2
                    ? [shape[1], shape[0]]
                    : [...shape];
                if (independentIndex) {
                    variables[`${name}.imag`].independentIndex = true;
                    variables[`${name}.imag`].sampleIndexLength = rawImaginary.length;
                }
            }
        }
    }

    _extractSeries(entry, sampleAxis, seriesIndex, sampleLength) {
        const shape = entry.shape || [sampleLength];
        if (shape.length <= 1) return Float64Array.from(entry.data, numericValue);
        if (shape.length === 2) {
            const [rows, cols] = shape;
            if (entry.layout === 'column-major') {
                if (sampleAxis === 0) return Float64Array.from({ length: rows }, (_, row) => numericValue(entry.data[seriesIndex * rows + row]));
                return Float64Array.from({ length: cols }, (_, col) => numericValue(entry.data[col * rows + seriesIndex]));
            }
            if (sampleAxis === 0) return Float64Array.from({ length: rows }, (_, row) => numericValue(entry.data[row * cols + seriesIndex]));
            return Float64Array.from({ length: cols }, (_, col) => numericValue(entry.data[seriesIndex * cols + col]));
        }
        const strides = this._strides(shape, entry.layout);
        const otherAxes = shape.map((_, axis) => axis).filter(axis => axis !== sampleAxis);
        const coords = new Array(shape.length).fill(0);
        let remainder = seriesIndex;
        for (let index = otherAxes.length - 1; index >= 0; index--) {
            const axis = otherAxes[index];
            coords[axis] = remainder % shape[axis];
            remainder = Math.floor(remainder / shape[axis]);
        }
        return Float64Array.from({ length: sampleLength }, (_, sample) => {
            coords[sampleAxis] = sample;
            return numericValue(entry.data[coords.reduce((offset, coord, axis) => offset + coord * strides[axis], 0)]);
        });
    }

    _strides(shape, layout) {
        const strides = new Array(shape.length).fill(1);
        if (layout === 'column-major') {
            for (let axis = 1; axis < shape.length; axis++) strides[axis] = strides[axis - 1] * shape[axis - 1];
        } else {
            for (let axis = shape.length - 2; axis >= 0; axis--) strides[axis] = strides[axis + 1] * shape[axis + 1];
        }
        return strides;
    }

    _seriesSuffix(shape, sampleAxis, index) {
        const dimensions = shape.filter((_, axis) => axis !== sampleAxis);
        const coords = [];
        let remainder = index;
        for (let axis = dimensions.length - 1; axis >= 0; axis--) {
            coords[axis] = remainder % dimensions[axis] + 1;
            remainder = Math.floor(remainder / dimensions[axis]);
        }
        return `[${coords.join(',')}]`;
    }

    _variable(name, data, kind, entry, detail = '') {
        const values = ArrayBuffer.isView(data) ? data : Float64Array.from(data || [], numericValue);
        const description = [`MATLAB ${entry?.className || 'numeric'} ${entry?.shapeLabel || ''}`, detail].filter(Boolean).join('; ');
        return {
            name, data: values, description, kind,
            dataType: entry?.logical ? 'boolean' : this.structureParser._detectDataType(values, kind),
            isConstant: this.structureParser._isConstantValues(values),
            interpolation: 'linear', negate: false, source: 'matlab',
            matlab: entry ? { path: entry.path, className: entry.className, shape: [...entry.shape], complex: entry.complex } : undefined,
        };
    }

    _safeName(path) {
        return String(path || 'unnamed').replace(/\//g, '.');
    }
}
