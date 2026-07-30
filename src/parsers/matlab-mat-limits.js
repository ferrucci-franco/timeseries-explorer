export const MATLAB_MAT_WEB_EAGER_LIMIT_BYTES = 250 * 1024 * 1024;
export const MATLAB_MAT_DESKTOP_EAGER_LIMIT_BYTES = 1024 * 1024 * 1024;

// The size gates above measure the file on disk. Inside a Level 5 MAT file the
// elements may be zlib-compressed, so those gates say nothing about how much
// memory the file asks for once inflated — a few KB of zeros expands ~1000:1,
// which is how a tiny file used to take the tab down.
//
// This is an absolute ceiling, not a compression ratio, and the difference
// matters. A ratio cannot tell a decompression bomb from ordinary data, because
// they are the same thing: measured on 8 MB of Float64, a constant signal
// compresses 683:1, a zero-filled one 1022:1 and an all-NaN one 683:1, while a
// sine or a ramp only manages 1.1–1.6:1. Simulation results are full of the
// first kind — parameters stored as full-length traces, and NaN padding for
// variables that exist during part of the run — so a 20:1 rule refused
// perfectly good Modelica/Dymola files and told their owner the file was corrupt.
//
// So the question this limit answers is "will it fit", not "is it suspicious".
// The ceiling sits above what either build can actually hold (a MAT that
// inflates past it would exhaust the heap anyway) and below the ~2 GiB cap on a
// single JS array, which keeps a bomb to one bounded refusal instead of an
// unrecoverable death hundreds of GB in.
export const MATLAB_MAT_MAX_INFLATED_BYTES = 1536 * 1024 * 1024;

// A declared shape is a claim by the file, not a measurement. A sparse matrix
// declaring [2, 2^30] is a valid JS array length and a dense fill of tens of GB
// from a few hundred bytes. The dense readers cannot hold this many elements
// anyway, so refusing is strictly better than dying.
export const MATLAB_MAT_MAX_DENSE_ELEMENTS = 25_000_000;
