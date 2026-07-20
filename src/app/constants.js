const IS_FILE_PROTOCOL = typeof window !== 'undefined' && window.location?.protocol === 'file:';
const PUBLIC_BASE = globalThis.__OMV_PUBLIC_BASE__ || (IS_FILE_PROTOCOL ? './public/' : './');

const EXAMPLES = [
    {
        id: 'pendulum',
        nameKey: 'examplePendulum',
        baseName: 'ExampleSimplePendulum',
        script: `${PUBLIC_BASE}examples/example-data.js`,
        modelicaPath: `${PUBLIC_BASE}examples/ExampleSimplePendulum.mo`,
        modelicaFileName: 'ExampleSimplePendulum.mo',
        getDataB64: () => (typeof EXAMPLE_DATA_B64 !== 'undefined' ? EXAMPLE_DATA_B64 : null),
        applyLayout: (pm, fileId, panels) => pm.setExampleLayout(fileId, panels),
    },
    {
        id: 'lorenz',
        nameKey: 'exampleLorenz',
        baseName: 'LorenzSystem_res',
        script: `${PUBLIC_BASE}examples/lorenz-data.js`,
        modelicaPath: `${PUBLIC_BASE}examples/LorenzSystem.mo`,
        modelicaFileName: 'LorenzSystem.mo',
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

const RESULT_FILE_EXTENSIONS = ['.mat', '.csv', '.txt', '.parquet', '.nc', '.netcdf', '.pkl', '.pickle', '.xlsx', '.xlsm', '.xls', '.ods'];
const APP_VERSION = '0.1.0-beta.2';
const DESKTOP_MANIFEST_PATH = './downloads/desktop.json';
const DESKTOP_PLATFORM_ICON_PATHS = {
    windows: `${PUBLIC_BASE}images/platforms/windows.svg`,
    macos: `${PUBLIC_BASE}images/platforms/apple.svg`,
    linux: `${PUBLIC_BASE}images/platforms/linux.svg`,
};
const DYMOLA_LOGO_ICON_PATH = `${PUBLIC_BASE}images/dymola-logo.jpg`;
const OPENMODELICA_MODELING_ICON_PATH = `${PUBLIC_BASE}images/openmodelica-modeling.png`;
const RESET_LAYOUT_ICON_SVG = `<svg class="reset-layout-glyph" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <path fill="#c6e5fb" stroke="#c6e5fb" d="M6 6h52v52H6z"/>
    <path fill="#8ccaf7" d="M6 58h52V6z"/>
    <path fill="none" stroke="#ef8b78" stroke-width="2" d="M6 6h52v52H6zM6 58 58 6M32 6v52M6 32h52"/>
</svg>`;

export { APP_VERSION, DESKTOP_MANIFEST_PATH, DESKTOP_PLATFORM_ICON_PATHS, DYMOLA_LOGO_ICON_PATH, EXAMPLES, DERIVED_FUNCTIONS, DERIVED_FUNCTION_ALIASES, OPENMODELICA_MODELING_ICON_PATH, RESET_LAYOUT_ICON_SVG, RESULT_FILE_EXTENSIONS };
