const IS_FILE_PROTOCOL = typeof window !== 'undefined' && window.location?.protocol === 'file:';
const PUBLIC_BASE = globalThis.__OMV_PUBLIC_BASE__ || (IS_FILE_PROTOCOL ? './public/' : './');

const EXAMPLES = [
    {
        id: 'pendulum',
        nameKey: 'examplePendulum',
        baseName: 'ExampleSimplePendulum',
        script: `${PUBLIC_BASE}examples/example-data.js`,
        getDataB64: () => (typeof EXAMPLE_DATA_B64 !== 'undefined' ? EXAMPLE_DATA_B64 : null),
        applyLayout: (pm, fileId, panels) => pm.setExampleLayout(fileId, panels),
    },
    {
        id: 'lorenz',
        nameKey: 'exampleLorenz',
        baseName: 'LorenzSystem_res',
        script: `${PUBLIC_BASE}examples/lorenz-data.js`,
        grid: { rows: 1, cols: 1 },
        getDataB64: () => (typeof LORENZ_DATA_B64 !== 'undefined' ? LORENZ_DATA_B64 : null),
        applyLayout: (pm, fileId, panels) => pm.setLorenzExampleLayout(fileId, panels),
    },
    { id: 'placeholder2', nameKey: 'examplePlaceholder2', getDataB64: () => null },
];

const DERIVED_FUNCTIONS = [
    { name: 'sqrt', arity: 1 },
    { name: 'abs', arity: 1 },
    { name: 'log', arity: 1 },
    { name: 'log10', arity: 1 },
    { name: 'power', arity: 2 },
    { name: 'root', arity: 2 },
];

const DERIVED_FUNCTION_ALIASES = new Map([
    ['pow', 'power'],
    ['square', 'square'],
    ['sqr', 'square'],
]);

const RESULT_FILE_EXTENSIONS = ['.mat', '.csv'];
const APP_VERSION = '0.1.0';
const STANDALONE_MANIFEST_PATH = './downloads/standalone.json';

export { APP_VERSION, EXAMPLES, DERIVED_FUNCTIONS, DERIVED_FUNCTION_ALIASES, RESULT_FILE_EXTENSIONS, STANDALONE_MANIFEST_PATH };
