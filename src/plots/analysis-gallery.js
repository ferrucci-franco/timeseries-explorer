// The Analysis gallery of a time-series panel: what each analysis looks like
// and the key of the one line that says what it shows.
//
// The Analysis menu used to be a list of names. A name says little to someone
// who has never opened "Temporal profile"; a small drawing of what comes out,
// and a line under it, say it before the click. marks-methods.js lays these
// out as cards.
//
// The drawings are 96 × 56, drawn with three classes the stylesheet colours:
// `art-line` (the result), `art-fill` (its area) and `art-faint` (what it is
// made from, or an axis).
const art = (body) => `<svg viewBox="0 0 96 56" aria-hidden="true" focusable="false">${body}</svg>`;

const HEAT = [
    [0.2, 0.35, 0.55, 0.3, 0.2, 0.15, 0.25],
    [0.45, 0.8, 1, 0.75, 0.5, 0.25, 0.35],
    [0.5, 0.9, 1, 0.85, 0.6, 0.3, 0.4],
    [0.25, 0.4, 0.6, 0.45, 0.3, 0.2, 0.2],
];

export const ANALYSIS_ART = {
    timeseries: art(
        '<path class="art-faint" d="M8 6v42h82"/>'
        + '<path class="art-line" d="M10 34c5-16 9-20 14-8s8 16 13 6 8-22 14-12 8 18 13 10 8-18 13-10 6 8 11 4"/>'),
    fft: art(
        '<path class="art-faint" d="M8 6v42h82"/>'
        + '<path class="art-fill" d="M10 46h10l5-36 5 36h12l4-20 4 20h12l3-10 3 10h18v2H10z"/>'
        + '<path class="art-line" d="M10 46h10l5-36 5 36h12l4-20 4 20h12l3-10 3 10h18"/>'),
    histogram: art(
        '<path class="art-faint" d="M8 48h82"/>'
        + [[12, 8], [23, 18], [34, 31], [45, 38], [56, 27], [67, 14], [78, 6]]
            .map(([x, h]) => `<rect class="art-bar" x="${x}" y="${48 - h}" width="9" height="${h}" rx="1.5"/>`).join('')
        + '<path class="art-line" d="M10 44c12-2 18-10 26-24s12-14 18-4 12 24 34 28"/>'),
    heatmap: art(
        HEAT.map((row, r) => row.map((o, c) => (
            `<rect class="art-cell" x="${9 + c * 11.4}" y="${5 + r * 11.8}" width="9.6" height="10" rx="2" fill-opacity="${o}"/>`
        )).join('')).join('')),
    'temporal-profile': art(
        '<path class="art-faint" d="M8 6v42h82"/>'
        + '<path class="art-fill" d="M10 30c10 0 14-20 26-20s14 22 26 22 14-12 26-12v14c-12 0-14 14-26 14S48 26 36 26 20 44 10 44z"/>'
        + '<path class="art-line" d="M10 37c10 0 14-19 26-19s14 22 26 22 14-13 26-13"/>'),
    integral: art(
        '<path class="art-faint" d="M8 48h82"/>'
        + '<path class="art-fill" d="M24 48V26c6-8 10-12 16-8s10 12 16 8 8-10 14-12v34z"/>'
        + '<path class="art-line" d="M10 38c6-4 10-8 14-12 6-8 10-12 16-8s10 12 16 8 8-10 14-12c6-2 10 2 16 6"/>'
        + '<path class="art-bound" d="M24 12v36M70 8v40"/>'),
};

// The key of the line under a card's name.
export const analysisDescKey = id => `analysisDesc_${id === 'temporal-profile' ? 'profile' : id}`;
