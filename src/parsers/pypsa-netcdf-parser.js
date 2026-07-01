import h5wasm from 'h5wasm';
import MatParser from './mat-parser.js';

const HDF5_MAGIC = '89 48 44 46 0D 0A 1A 0A';
const SMALL_FILE_LIMIT_BYTES = 100 * 1024 * 1024;
const STATIC_ATTRIBUTES_NODE = 'Static attributes';
const GENERIC_NETCDF_ERROR = 'Generic netCDF/HDF5 files are not supported yet. Please open a PyPSA-exported netCDF4/HDF5 network.';
const STATIC_DESCRIPTION_KEYS = [
    'carrier',
    'bus',
    'bus0',
    'bus1',
    'control',
    'p_nom',
    'p_nom_opt',
    'p_nom_extendable',
    'p_nom_max',
    's_nom',
    's_nom_opt',
    'e_nom',
    'e_nom_opt',
    'capital_cost',
    'marginal_cost',
];

function hdf5Magic(buffer) {
    return [...new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength))]
        .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
        .join(' ');
}

function toArray(value) {
    if (value == null) return [];
    if (Array.isArray(value)) return value;
    if (ArrayBuffer.isView(value)) return Array.from(value);
    return [value];
}

function numberArray(value) {
    return Float64Array.from(toArray(value), item => Number(item));
}

function normalizeScalar(value) {
    if (typeof value === 'bigint') {
        const numeric = Number(value);
        return Number.isSafeInteger(numeric) ? numeric : String(value);
    }
    return value;
}

function isDataset(obj) {
    return obj?.type === 'Dataset';
}

function componentTitle(component) {
    return String(component || '')
        .replace(/_/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
}

function idSegment(value) {
    return encodeURIComponent(String(value ?? ''));
}

function parsePypsaDate(value) {
    const text = String(value ?? '').trim();
    let match = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/);
    if (match) {
        const [, y, mo, d, h, mi, s = '0', frac = ''] = match;
        const ms = frac ? Number(`0.${frac}`) * 1000 : 0;
        return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Math.round(ms));
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : NaN;
}

export default class PypsaNetcdfParser {
    constructor(structureParser) {
        this.structureParser = structureParser || new MatParser();
        this._sequence = 0;
    }

    async parse(buffer, filename = '') {
        if (!buffer || !buffer.byteLength) throw new Error('PyPSA netCDF file is empty.');
        if (buffer.byteLength > SMALL_FILE_LIMIT_BYTES) {
            throw new Error('PyPSA netCDF support is currently limited to small files. Large PyPSA networks need the planned lazy data-source path.');
        }
        if (hdf5Magic(buffer) !== HDF5_MAGIC) {
            throw new Error('This netCDF file is not HDF5/netCDF4. PyPSA netCDF support currently expects PyPSA-exported netCDF4/HDF5 files.');
        }

        const module = await h5wasm.ready;
        const { FS } = module;
        const virtualPath = `/pypsa-${Date.now()}-${this._sequence++}.nc`;
        FS.writeFile(virtualPath, new Uint8Array(buffer));

        const file = new h5wasm.File(virtualPath, 'r');
        try {
            return this._parseFile(file, filename);
        } finally {
            file.close();
            try {
                FS.unlink(virtualPath);
            } catch {
                // Best-effort cleanup of the Emscripten in-memory file.
            }
        }
    }

    _parseFile(file, filename) {
        const keys = file.keys().sort();
        if (!this._looksLikePypsa(keys)) throw new Error(GENERIC_NETCDF_ERROR);

        const snapshots = this._readSnapshots(file);
        if (!snapshots) throw new Error('PyPSA netCDF file does not contain a usable snapshots axis.');

        const components = this._componentIndexes(file, keys);
        const metadataByAsset = this._staticMetadataByAsset(file, keys, components);
        const result = {
            filename,
            metadata: {
                format: 'pypsa-netcdf',
                source: 'pypsa',
                timeName: snapshots.name,
                timeKind: snapshots.timeKind,
                timeDisplayMode: snapshots.timeDisplayMode,
                snapshotCount: snapshots.data.length,
                components: components.map(component => ({
                    name: component,
                    count: this._readIndex(file, `${component}_i`).length,
                })),
                staticAttributeCount: 0,
                skippedDynamic: [],
            },
            variables: {},
            tree: this._rootNode(),
        };

        result.variables[snapshots.name] = snapshots;
        result.tree._variables[snapshots.name] = snapshots;

        for (const key of keys) {
            if (!this._isDynamicDatasetName(key)) continue;
            const dataset = this._dataset(file, key);
            const parts = this._dynamicParts(key);
            if (!dataset || !parts) continue;

            const shape = dataset.shape || [];
            const ownIndex = this._readIndex(file, `${key}_i`);
            const axes = this._dynamicAxes(shape, snapshots.data.length, ownIndex.length);
            if (!axes) {
                result.metadata.skippedDynamic.push({
                    name: key,
                    reason: 'Expected a two-dimensional dynamic array with one snapshots axis and one component-index axis.',
                    shape,
                    indexLength: ownIndex.length,
                });
                continue;
            }

            for (let col = 0; col < ownIndex.length; col++) {
                const assetName = ownIndex[col];
                const values = numberArray(dataset.slice(this._dynamicSlice(axes, col)));
                if (values.length !== snapshots.data.length) {
                    result.metadata.skippedDynamic.push({
                        name: `${key}:${assetName}`,
                        reason: `Series length ${values.length} does not match snapshots length ${snapshots.data.length}.`,
                    });
                    continue;
                }

                const variableName = this._variableId(parts.component, assetName, parts.attribute);
                const variable = {
                    name: variableName,
                    displayName: this._variableDisplayName(parts.component, assetName, parts.attribute),
                    data: values,
                    description: this._dynamicDescription(parts.component, assetName, parts.attribute, metadataByAsset),
                    kind: 'variable',
                    dataType: this.structureParser._detectDataType(values, variableName),
                    isConstant: this.structureParser._isConstantValues(values),
                    interpolation: 'linear',
                    negate: false,
                    source: 'pypsa-netcdf',
                    pypsa: {
                        component: parts.component,
                        asset: assetName,
                        attribute: parts.attribute,
                        dataset: key,
                        indexDataset: `${key}_i`,
                    },
                };
                result.variables[variableName] = variable;
                this._addTreeVariable(result.tree, parts.component, assetName, parts.attribute, variable);
            }
        }

        result.metadata.staticAttributeCount = this._addStaticMetadataTree(result.tree, file, components, metadataByAsset);

        if (Object.keys(result.variables).length <= 1) {
            throw new Error('PyPSA netCDF file did not expose any plottable time-series variables.');
        }

        return result;
    }

    _readSnapshots(file) {
        const datetime = this._dataset(file, 'snapshots_snapshot');
        if (datetime?.shape?.length === 1) {
            const labels = toArray(datetime.value);
            const values = Float64Array.from(labels, parsePypsaDate);
            if (values.length && Array.from(values).every(Number.isFinite)) {
                return {
                    name: 'snapshots',
                    data: values,
                    description: '[PyPSA snapshots datetime]',
                    kind: 'abscissa',
                    timeSourceStrategy: 'pypsa-snapshots',
                    dataType: 'numeric',
                    isConstant: this.structureParser._isConstantValues(values),
                    interpolation: 'linear',
                    negate: false,
                    source: 'pypsa-netcdf',
                    timeKind: 'datetime',
                    timeDisplayMode: 'calendar',
                    timeOriginMs: values[0],
                    pypsa: {
                        dataset: 'snapshots_snapshot',
                        indexDataset: 'snapshots',
                    },
                };
            }
        }

        const snapshots = this._dataset(file, 'snapshots');
        if (!snapshots?.shape?.length) return null;
        const values = numberArray(snapshots.value);
        return {
            name: 'snapshots',
            data: values,
            description: '[PyPSA snapshots index]',
            kind: 'abscissa',
            timeSourceStrategy: 'pypsa-snapshots-index',
            dataType: this.structureParser._detectDataType(values, 'snapshots'),
            isConstant: this.structureParser._isConstantValues(values),
            interpolation: 'linear',
            negate: false,
            source: 'pypsa-netcdf',
            timeKind: 'index',
            timeStepMode: 'index',
            pypsa: {
                dataset: 'snapshots',
            },
        };
    }

    _componentIndexes(file, keys) {
        return keys
            .filter(key => key.endsWith('_i') && !key.includes('_t_'))
            .map(key => key.slice(0, -2))
            .filter(component => component !== 'snapshots' && component !== 'investment_periods' && this._dataset(file, `${component}_i`))
            .sort();
    }

    _staticMetadataByAsset(file, keys, components) {
        const byAsset = new Map();
        for (const component of components) {
            const assets = this._readIndex(file, `${component}_i`);
            for (const asset of assets) this._assetMetadata(byAsset, component, asset);
        }

        for (const key of keys) {
            const parts = this._staticParts(key, components);
            if (!parts) continue;
            const dataset = this._dataset(file, key);
            if (!dataset?.shape?.length) continue;
            const assets = this._readIndex(file, `${parts.component}_i`);
            if (dataset.shape[0] !== assets.length) continue;
            const values = toArray(dataset.value);
            for (let i = 0; i < assets.length; i++) {
                this._assetMetadata(byAsset, parts.component, assets[i])[parts.attribute] = normalizeScalar(values[i]);
            }
        }
        return byAsset;
    }

    _assetMetadata(byAsset, component, asset) {
        const key = `${component}\u0000${asset}`;
        if (!byAsset.has(key)) byAsset.set(key, {});
        return byAsset.get(key);
    }

    _dynamicDescription(component, assetName, attribute, metadataByAsset) {
        const meta = this._assetMetadata(metadataByAsset, component, assetName);
        const details = [];
        for (const key of STATIC_DESCRIPTION_KEYS) {
            const value = meta[key];
            if (value === undefined || value === null || value === '') continue;
            details.push(`${key}=${String(value)}`);
        }
        const base = `PyPSA ${componentTitle(component)} "${assetName}" ${attribute}`;
        return details.length ? `${base} (${details.join(', ')})` : base;
    }

    _addStaticMetadataTree(root, file, components, metadataByAsset) {
        let count = 0;
        for (const component of components) {
            const assets = this._readIndex(file, `${component}_i`);
            for (const asset of assets) {
                const meta = this._assetMetadata(metadataByAsset, component, asset);
                const entries = Object.entries(meta)
                    .filter(([, value]) => value !== undefined && value !== null && value !== '')
                    .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }));
                for (const [attribute, value] of entries) {
                    this._addTreeStaticAttribute(root, component, asset, attribute, value);
                    count += 1;
                }
            }
        }
        return count;
    }

    _staticAttributeVariable(component, asset, attribute, value) {
        const stringValue = String(value);
        return {
            name: this._staticVariableId(component, asset, attribute),
            displayName: this._variableDisplayName(component, asset, attribute),
            data: [value],
            description: `PyPSA ${componentTitle(component)} "${asset}" static attribute ${attribute}=${stringValue}`,
            kind: 'parameter',
            dataType: typeof value === 'string' ? 'string' : this.structureParser._detectDataType([Number(value)], 'parameter'),
            isConstant: true,
            interpolation: 'constant',
            negate: false,
            source: 'pypsa-netcdf',
            plottable: false,
            pypsa: {
                component,
                asset,
                attribute,
                static: true,
                dataset: `${component}_${attribute}`,
            },
        };
    }

    _readIndex(file, name) {
        const dataset = this._dataset(file, name);
        if (!dataset?.shape?.length) return [];
        return toArray(dataset.value).map(value => String(value));
    }

    _dynamicAxes(shape, snapshotLength, indexLength) {
        if (!Array.isArray(shape) || shape.length !== 2 || indexLength <= 0) return null;
        const snapshotAxes = [];
        const indexAxes = [];
        for (let axis = 0; axis < shape.length; axis++) {
            if (shape[axis] === snapshotLength) snapshotAxes.push(axis);
            if (shape[axis] === indexLength) indexAxes.push(axis);
        }
        for (const snapshotAxis of snapshotAxes) {
            const componentAxis = snapshotAxis === 0 ? 1 : 0;
            if (shape[componentAxis] === indexLength) return { snapshotAxis, componentAxis };
        }
        if (snapshotLength === indexLength && shape[0] === snapshotLength && shape[1] === indexLength) {
            return { snapshotAxis: 0, componentAxis: 1 };
        }
        return null;
    }

    _dynamicSlice(axes, componentIndex) {
        const ranges = [[], []];
        ranges[axes.componentAxis] = [componentIndex, componentIndex + 1];
        return ranges;
    }

    _dataset(file, name) {
        const obj = file.get(name);
        return isDataset(obj) ? obj : null;
    }

    _looksLikePypsa(keys) {
        const hasSnapshots = keys.includes('snapshots') || keys.includes('snapshots_snapshot');
        const hasComponentIndex = keys.some(key => key.endsWith('_i') && !key.includes('_t_') && key !== 'snapshots_i');
        const hasDynamic = keys.some(key => this._isDynamicDatasetName(key));
        return hasSnapshots && (hasComponentIndex || hasDynamic);
    }

    _isDynamicDatasetName(name) {
        return /^.+_t_.+$/.test(name) && !name.endsWith('_i');
    }

    _dynamicParts(name) {
        const match = name.match(/^(.+)_t_(.+)$/);
        return match ? { component: match[1], attribute: match[2] } : null;
    }

    _staticParts(name, components) {
        for (const component of components) {
            const prefix = `${component}_`;
            if (name.startsWith(prefix) && !name.startsWith(`${component}_t_`) && name !== `${component}_i`) {
                return { component, attribute: name.slice(prefix.length) };
            }
        }
        return null;
    }

    _variableId(component, asset, attribute) {
        return `pypsa:${idSegment(component)}/${idSegment(asset)}/${idSegment(attribute)}`;
    }

    _staticVariableId(component, asset, attribute) {
        return `pypsa:${idSegment(component)}/${idSegment(asset)}/@${idSegment(attribute)}`;
    }

    _variableDisplayName(component, asset, attribute) {
        return `${componentTitle(component)} / ${asset} / ${attribute}`;
    }

    _rootNode() {
        return {
            _type: 'root',
            _name: '',
            _children: {},
            _variables: {},
        };
    }

    _addTreeVariable(root, component, asset, attribute, variable) {
        const assetNode = this._ensureAssetNode(root, component, asset);
        assetNode._variables[attribute] = variable;
    }

    _addTreeStaticAttribute(root, component, asset, attribute, value) {
        const assetNode = this._ensureAssetNode(root, component, asset);
        if (!assetNode._children[STATIC_ATTRIBUTES_NODE]) {
            assetNode._children[STATIC_ATTRIBUTES_NODE] = {
                _type: 'metadata',
                _name: STATIC_ATTRIBUTES_NODE,
                _fullName: `${assetNode._fullName}.${STATIC_ATTRIBUTES_NODE}`,
                _children: {},
                _variables: {},
            };
        }
        assetNode._children[STATIC_ATTRIBUTES_NODE]._variables[attribute] =
            this._staticAttributeVariable(component, asset, attribute, value);
    }

    _ensureAssetNode(root, component, asset) {
        const componentName = componentTitle(component);
        if (!root._children[componentName]) {
            root._children[componentName] = {
                _type: 'component',
                _name: componentName,
                _fullName: componentName,
                _children: {},
                _variables: {},
            };
        }
        const componentNode = root._children[componentName];
        if (!componentNode._children[asset]) {
            componentNode._children[asset] = {
                _type: 'component',
                _name: asset,
                _fullName: `${componentName}.${asset}`,
                _children: {},
                _variables: {},
            };
        }
        return componentNode._children[asset];
    }
}
