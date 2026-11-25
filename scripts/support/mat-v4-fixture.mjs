// A MAT v4 trajectory file built in memory, for the tests of the reader that
// goes through such a file by parts (scripts/test-lazy-mat.mjs,
// scripts/e2e-lazy-mat.mjs).
//
// ── A MAT v4 trajectory, written the way OpenModelica writes it ──────────────
export function matrix(name, mrows, ncols, P, T, fill, littleEndian = true) {
    const size = { 0: 8, 1: 4, 2: 4, 5: 1 }[P];
    const nameBytes = Buffer.from(`${name}\0`, 'latin1');
    const out = Buffer.alloc(20 + nameBytes.length + mrows * ncols * size);
    const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
    // M = 0 little endian, 1 big endian.
    [(littleEndian ? 0 : 1000) + P * 10 + T, mrows, ncols, 0, nameBytes.length].forEach((v, i) => view.setInt32(i * 4, v, littleEndian));
    nameBytes.copy(out, 20);
    const at0 = 20 + nameBytes.length;
    for (let j = 0; j < ncols; j++) {
        for (let i = 0; i < mrows; i++) {
            const at = at0 + (j * mrows + i) * size;
            const v = fill(i, j);
            if (P === 0) view.setFloat64(at, v, littleEndian);
            else if (P === 1) view.setFloat32(at, v, littleEndian);
            else if (P === 2) view.setInt32(at, v, littleEndian);
            else view.setUint8(at, v);
        }
    }
    return out;
}
// Text, binTrans: one string per column.
export function textMatrix(name, strings, littleEndian) {
    const bytes = strings.map(s => Buffer.from(s, 'utf8'));
    const width = Math.max(1, ...bytes.map(b => b.length));
    return matrix(name, width, strings.length, 5, 1, (i, j) => bytes[j][i] ?? 0, littleEndian);
}
export function trajectory({ names, descriptions, info, params, series, steps, value, P = 0, littleEndian = true }) {
    return Buffer.concat([
        textMatrix('Aclass', ['Atrajectory', '1.1', '', 'binTrans'], littleEndian),
        textMatrix('name', names, littleEndian),
        textMatrix('description', descriptions, littleEndian),
        matrix('dataInfo', 4, names.length, 2, 0, (i, j) => info[j][i] ?? 0, littleEndian),
        matrix('data_1', params.length, 2, 0, 0, (i) => params[i], littleEndian),
        matrix('data_2', series, steps, P, 0, value, littleEndian),
    ]);
}
