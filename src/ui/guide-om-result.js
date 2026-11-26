// A simulation result the way OpenModelica writes one, built in the browser.
//
// The "Load as new" demo of the animated guide (guide-chapters.js) needs three
// runs of the same model with one parameter changed. Downloading three result
// files would go against what the guide promises — nothing travels but the app
// itself — so the runs are computed here and written as a real OpenModelica
// MAT v4 trajectory file, the same layout `src/parsers/mat-parser.js` reads
// from OMEdit and Dymola: an `Aclass` that says `binTrans`, the variable names
// and descriptions, a `dataInfo` row per variable, the parameters in `data_1`
// and the trajectories in `data_2`.
//
// The model is the pendulum of `public/examples/ExampleSimplePendulum.mo`,
// which the app already ships, so the demo shows a file a reader can also
// produce for themselves:
//
//   der(theta) = omega
//   der(omega) = -(g / L) * sin(theta) - (b / (m * L * L)) * omega
//
// `b` is the viscous damping the demo changes between runs; a larger `b` damps
// the swing faster, which is what makes the three runs worth overlaying.

const DEG = 180 / Math.PI;

// name, description — the descriptions carry the unit in brackets, which is
// where the app reads a unit from (MatParser._extractUnit).
const SERIES = [
    ['time', 'Simulation time [s]'],
    ['omega', 'Angular velocity [rad/s]'],
    ['theta', 'Angle [rad]'],
    ['der(omega)', 'der(Angular velocity) [s-2]'],
    ['der(theta)', 'der(Angle) [Hz]'],
    ['Ekin', 'Kinetic energy [J]'],
    ['Epot', 'Potential energy [J]'],
    ['Etot', 'Total mechanical energy [J]'],
    ['omega_deg_s', 'Angular velocity (deg/s)'],
    ['theta_deg', 'Angle (deg)'],
    ['x', 'Horizontal position [m]'],
    ['y', 'Vertical position [m]'],
];

const PARAMETERS = [
    ['L', 'Pendulum length [m]'],
    ['b', 'Viscous rotational damping (N.m.s) [N.m.s/rad]'],
    ['g', 'Gravity [m/s2]'],
    ['m', 'Mass [kg]'],
    ['omega0_deg', 'Initial angular velocity (deg/s)'],
    ['theta0_deg', 'Initial angle (deg)'],
];

/** The pendulum, integrated with a fixed-step RK4 — the same result every run. */
function simulate({ L, b, g, m, theta0, omega0, stopTime, interval }) {
    const steps = Math.round(stopTime / interval);
    const alpha = (theta, omega) => -(g / L) * Math.sin(theta) - (b / (m * L * L)) * omega;
    const rows = SERIES.map(() => new Float64Array(steps + 1));
    let theta = theta0;
    let omega = omega0;
    for (let i = 0; i <= steps; i++) {
        const t = i * interval;
        const dOmega = alpha(theta, omega);
        const Ekin = 0.5 * m * (L * omega) ** 2;
        const Epot = m * g * L * (1 - Math.cos(theta));
        const values = [t, omega, theta, dOmega, omega, Ekin, Epot, Ekin + Epot,
            omega * DEG, theta * DEG, L * Math.sin(theta), -L * Math.cos(theta)];
        for (let r = 0; r < rows.length; r++) rows[r][i] = values[r];
        if (i === steps) break;
        const h = interval;
        const k1t = omega;
        const k1o = alpha(theta, omega);
        const k2t = omega + (h / 2) * k1o;
        const k2o = alpha(theta + (h / 2) * k1t, omega + (h / 2) * k1o);
        const k3t = omega + (h / 2) * k2o;
        const k3o = alpha(theta + (h / 2) * k2t, omega + (h / 2) * k2o);
        const k4t = omega + h * k3o;
        const k4o = alpha(theta + h * k3t, omega + h * k3o);
        theta += (h / 6) * (k1t + 2 * k2t + 2 * k3t + k4t);
        omega += (h / 6) * (k1o + 2 * k2o + 2 * k3o + k4o);
    }
    return rows;
}

// ── Writing MAT v4 ─────────────────────────────────────────────────────────
//
// Every matrix is a 20-byte header (type, rows, columns, imaginary flag, the
// length of its name), the name, and then the values column by column. `mopt`
// encodes the machine (0: little-endian IEEE), the precision (0 double,
// 2 int32, 5 uint8) and whether the matrix is text.

class MatWriter {
    constructor() {
        this.parts = [];
    }

    _header(name, mopt, rows, cols) {
        const head = new ArrayBuffer(20);
        const view = new DataView(head);
        view.setInt32(0, mopt, true);
        view.setInt32(4, rows, true);
        view.setInt32(8, cols, true);
        view.setInt32(12, 0, true);
        view.setInt32(16, name.length + 1, true);
        this.parts.push(new Uint8Array(head));
        const label = new Uint8Array(name.length + 1);
        for (let i = 0; i < name.length; i++) label[i] = name.charCodeAt(i) & 0xff;
        this.parts.push(label);
    }

    /**
     * Strings as a character matrix. `transposed` is how the metadata of a
     * binTrans file is stored: one string per column, so a reader that
     * transposes the matrix gets one string per row.
     */
    text(name, strings, transposed) {
        const width = Math.max(1, ...strings.map((s) => s.length));
        const rows = transposed ? width : strings.length;
        const cols = transposed ? strings.length : width;
        this._header(name, 51, rows, cols);
        const bytes = new Uint8Array(rows * cols);
        strings.forEach((text, i) => {
            for (let c = 0; c < text.length; c++) {
                // Column-major: the character at (row, column) is at column * rows + row.
                const at = transposed ? i * rows + c : c * rows + i;
                bytes[at] = text.charCodeAt(c) & 0xff;
            }
        });
        this.parts.push(bytes);
    }

    /** A matrix of 32-bit integers, given row by row. */
    int32(name, rows) {
        const height = rows.length;
        const width = rows[0].length;
        this._header(name, 20, width, height);
        const bytes = new Uint8Array(height * width * 4);
        const view = new DataView(bytes.buffer);
        rows.forEach((row, i) => row.forEach((value, c) => view.setInt32((i * width + c) * 4, value, true)));
        this.parts.push(bytes);
    }

    /** A matrix of doubles, given row by row (rows: variables, columns: time). */
    doubles(name, rows) {
        const height = rows.length;
        const width = rows[0].length;
        this._header(name, 0, height, width);
        const bytes = new Uint8Array(height * width * 8);
        const view = new DataView(bytes.buffer);
        for (let c = 0; c < width; c++) {
            for (let r = 0; r < height; r++) {
                view.setFloat64((c * height + r) * 8, rows[r][c], true);
            }
        }
        this.parts.push(bytes);
    }

    bytes() {
        const total = this.parts.reduce((sum, part) => sum + part.length, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const part of this.parts) {
            out.set(part, at);
            at += part.length;
        }
        return out;
    }
}

/**
 * One run of ExampleSimplePendulum, as the bytes of `…_res.mat`.
 *
 * @param {object} options  `b` is the damping the demo changes between runs.
 * @returns {Uint8Array} an OpenModelica MAT v4 trajectory file
 */
export function pendulumResultMat({
    L = 1, b = 0.1, g = 9.81, m = 1,
    theta0Deg = 45, omega0Deg = 0,
    stopTime = 20, interval = 0.02,
} = {}) {
    const trajectories = simulate({
        L, b, g, m,
        theta0: theta0Deg / DEG,
        omega0: omega0Deg / DEG,
        stopTime, interval,
    });
    const parameterValues = [L, b, g, m, omega0Deg, theta0Deg];

    const names = [...SERIES.map(([name]) => name), ...PARAMETERS.map(([name]) => name)];
    const descriptions = [...SERIES.map(([, text]) => text), ...PARAMETERS.map(([, text]) => text)];

    // dataInfo, one row per variable: which matrix holds its values (0 the
    // abscissa, 1 a parameter, 2 a trajectory), which row of that matrix
    // (1-based, negative to negate), the interpolation, and a flag the app
    // does not read. The order and the values are those of a result OMEdit
    // writes for this model.
    const dataInfo = [
        [0, 1, 0, -1],
        ...SERIES.slice(1).map((_, i) => [2, i + 2, 0, 0]),
        ...PARAMETERS.map((_, i) => [1, i + 2, 0, 0]),
    ];

    const writer = new MatWriter();
    writer.text('Aclass', ['Atrajectory', '1.1', '', 'binTrans'], false);
    writer.text('name', names, true);
    writer.text('description', descriptions, true);
    writer.int32('dataInfo', dataInfo);
    // data_1: the time span first, then each parameter twice — its value at
    // the start and at the end of the simulation.
    writer.doubles('data_1', [[0, stopTime], ...parameterValues.map((value) => [value, value])]);
    writer.doubles('data_2', trajectories);
    return writer.bytes();
}

/** The runs the demo plays, in order: the same model with more and more damping. */
export const PENDULUM_RUNS = [0.1, 0.4, 0.8];
