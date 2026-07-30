export const MATLAB_MAT_WEB_EAGER_LIMIT_BYTES = 250 * 1024 * 1024;
export const MATLAB_MAT_DESKTOP_EAGER_LIMIT_BYTES = 1024 * 1024 * 1024;

// The size gates above measure the file on disk. Inside a Level 5 MAT file the
// elements may be zlib-compressed, so those gates say nothing about how much
// memory the file asks for once inflated — a few KB of zeros expands ~1000:1.
// Real MATLAB files compress in single digits (numeric data does not do much
// better), so 20:1 is far above anything legitimate and far below a bomb. The
// floor keeps small files workable and the ceiling keeps the total inside what a
// renderer can actually hold.
export const MATLAB_MAT_MAX_INFLATION_RATIO = 20;
export const MATLAB_MAT_MIN_INFLATED_BYTES = 64 * 1024 * 1024;
export const MATLAB_MAT_MAX_INFLATED_BYTES = 2 * 1024 * 1024 * 1024;

// A declared shape is a claim by the file, not a measurement. A sparse matrix
// declaring [2, 2^30] is a valid JS array length and a dense fill of tens of GB
// from a few hundred bytes. The dense readers cannot hold this many elements
// anyway, so refusing is strictly better than dying.
export const MATLAB_MAT_MAX_DENSE_ELEMENTS = 25_000_000;

export function matlabMatMaxInflatedBytes(fileBytes) {
    const scaled = Number(fileBytes || 0) * MATLAB_MAT_MAX_INFLATION_RATIO;
    return Math.min(MATLAB_MAT_MAX_INFLATED_BYTES, Math.max(MATLAB_MAT_MIN_INFLATED_BYTES, scaled));
}
