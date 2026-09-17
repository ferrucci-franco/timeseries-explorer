import { AUDIO_EXTENSIONS } from './text-file-formats.js';

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
    {
        id: 'powergrid-timeseries',
        nameKey: 'examplePowergridTimeseries',
        projectPath: `${PUBLIC_BASE}examples/Powergrid-timeseries-example.zip`,
        projectFileName: 'Powergrid-timeseries-example.zip',
        getDataB64: () => null,
    },
    {
        id: 'noisy-chirp-fourier-transform',
        nameKey: 'exampleNoisyChirpFourierTransform',
        projectPath: `${PUBLIC_BASE}examples/noisy_chirp_fft.zip`,
        projectFileName: 'noisy_chirp_fft.zip',
        getDataB64: () => null,
    },
    {
        id: 'correlation-curve-fitting',
        nameKey: 'exampleCorrelationCurveFitting',
        projectPath: `${PUBLIC_BASE}examples/correlated_signals_example.zip`,
        projectFileName: 'correlated_signals_example.zip',
        getDataB64: () => null,
    },
];

// `arity` is the exact operand count; `minArity` marks a variadic function, which
// accepts that many operands or more. min/max are the only variadic ones: they
// compare sample by sample across however many operands they are given, which is
// what lets `min(x, 0)`, `min(x, y)` and `min([x, y, z])` all be the same call
// (a bracketed list is flattened into the argument list — see src/expr/compile.js).
const DERIVED_FUNCTIONS = [
    { name: 'sqrt', arity: 1 },
    { name: 'abs', arity: 1 },
    { name: 'log', arity: 1 },
    { name: 'log10', arity: 1 },
    // Radians, like every other maths library. The help popover says so, because
    // sin(90) returning 0.894 is the first thing that would otherwise be read as
    // a bug.
    { name: 'sin', arity: 1 },
    { name: 'cos', arity: 1 },
    { name: 'tan', arity: 1 },
    { name: 'asin', arity: 1 },
    { name: 'acos', arity: 1 },
    { name: 'atan', arity: 1 },
    // The hyperbolic three take a plain number, not an angle — no radians to
    // mention, and no domain limit either: they are defined everywhere.
    { name: 'sinh', arity: 1 },
    { name: 'cosh', arity: 1 },
    { name: 'tanh', arity: 1 },
    // The shape pair. `sign` is the ordinary signum (1 / -1 / 0), which is what
    // MATLAB, NumPy and Modelica all mean by the name, so a formula written
    // elsewhere keeps its meaning here. `step` is the unit step, 1 from zero
    // upwards: it is what gives a square wave built out of a sine a defined
    // value where the sine sits exactly on zero, and it gates and rectifies
    // (`x*step(x)`, `step(time - 5)`) on its own.
    { name: 'sign', arity: 1 },
    { name: 'step', arity: 1 },
    { name: 'min', minArity: 2 },
    { name: 'max', minArity: 2 },
    { name: 'power', arity: 2 },
    { name: 'root', arity: 2 },
    { name: 'diff', arity: 1 },
];

const DERIVED_FUNCTION_ALIASES = new Map([
    ['pow', 'power'],
    ['square', 'square'],
    ['sqr', 'square'],
    ['minimum', 'min'],
    ['maximum', 'max'],
    ['arcsin', 'asin'],
    ['arccos', 'acos'],
    ['arctan', 'atan'],
    ['sgn', 'sign'],
    ['signum', 'sign'],
    ['heaviside', 'step'],
]);

// Named numbers, so a formula can be written the way it is written on paper:
// `sin(2*pi*1000*time)` rather than `sin(6.283185307179586*1000*time)`.
//
// A file's own variables ALWAYS win. A name is looked up here only when the
// loaded file has nothing by that name, so a result file carrying a column
// called `pi` or `e` keeps meaning exactly what it meant before this existed —
// no saved formula can change value. Backticks still force the variable reading
// (`` `pi` `` is the column, never the number).
//
// `math.pi` / `math.e` are the way out when a file does shadow them: a dot is
// already a legal character in a name, so this needs no grammar, and nothing
// produces a signal called `math.pi`. Lookup is case-insensitive, as it is for
// function names.
const DERIVED_CONSTANTS = new Map([
    ['pi', Math.PI],
    ['math.pi', Math.PI],
    ['e', Math.E],
    ['math.e', Math.E],
]);

const RESULT_FILE_EXTENSIONS = ['.mat', '.csv', '.txt', '.parquet', '.nc', '.netcdf', '.pkl', '.pickle', '.xlsx', '.xlsm', '.xls', '.ods', ...AUDIO_EXTENSIONS];
const APP_VERSION = '0.3.0';
// Injected at build time by Vite (see vite.config.js). Fall back to placeholders
// when running outside a Vite build (e.g. Node test scripts), where the globals
// are undeclared; `typeof` avoids a ReferenceError in that case.
const BUILD_SHA = typeof __GIT_SHA__ !== 'undefined' ? __GIT_SHA__ : 'dev';
const BUILD_DATE = typeof __BUILD_DATE__ !== 'undefined' ? __BUILD_DATE__ : '';
const FEEDBACK_ISSUES_URL = 'https://github.com/ferrucci-franco/timeseries-explorer/issues/new';
const FEEDBACK_EMAIL = 'ferruccifranco@gmail.com';
const ONLINE_VERSION_URL = 'https://ferrucci-franco.github.io/timeseries-explorer/';
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

export { APP_VERSION, BUILD_SHA, BUILD_DATE, DESKTOP_MANIFEST_PATH, DESKTOP_PLATFORM_ICON_PATHS, DYMOLA_LOGO_ICON_PATH, EXAMPLES, DERIVED_CONSTANTS, DERIVED_FUNCTIONS, DERIVED_FUNCTION_ALIASES, FEEDBACK_EMAIL, FEEDBACK_ISSUES_URL, ONLINE_VERSION_URL, OPENMODELICA_MODELING_ICON_PATH, RESET_LAYOUT_ICON_SVG, RESULT_FILE_EXTENSIONS };
