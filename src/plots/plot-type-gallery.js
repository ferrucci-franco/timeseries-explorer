// The plot types of a panel, as a gallery: what each looks like, its name and
// the key of the one line that says what it draws.
//
// They used to be seven buttons in a row — "2D+t", "▶x 2D" — whose labels
// only meant something to who already knew them. marks-methods.js lays these
// out as cards, the same way as the analyses (analysis-gallery.js), behind one
// button that names the type that is on.
//
// The drawings are 96 × 56 and use the classes of the analyses' drawings, plus
// `art-dot` (the state of an animation) and `art-tile` (a dashboard card).
import { ANALYSIS_ART } from './analysis-gallery.js';

const art = (body) => `<svg viewBox="0 0 96 56" aria-hidden="true" focusable="false">${body}</svg>`;
const AXES_2D = '<path class="art-faint" d="M8 6v42h82"/>';
// Three axes from one corner: x to the right, y towards the viewer, z up.
const AXES_3D = '<path class="art-faint" d="M30 38h58M30 38V6M30 38L8 52"/>';
const PLAY = '<path class="art-dot" d="M80 6l10 6-10 6z"/>';

// A curve wound round the time axis: x–y turning while t runs to the right.
const helix = () => {
    const points = [];
    for (let i = 0; i <= 96; i++) {
        const u = i / 96;
        const angle = u * Math.PI * 2 * 4;
        const x = 30 + 54 * u - 7 * Math.cos(angle);
        const y = 32 - 15 * Math.sin(angle) + 4 * Math.cos(angle);
        points.push(`${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`);
    }
    return points.join('');
};

const ORBIT_3D = 'M38 30c-6-12 10-22 20-12s24 12 24 0-16-14-24-2-10 22-20 14z';

export const PLOT_TYPE_ART = {
    timeseries: ANALYSIS_ART.timeseries,
    dashboard: art(
        '<rect class="art-tile" x="7" y="7" width="38" height="42" rx="4"/>'
        + '<path class="art-line" d="M15 36a11 11 0 1 1 22 0"/><path class="art-line" d="M26 35l6-8"/>'
        + '<rect class="art-tile" x="51" y="7" width="38" height="18" rx="4"/>'
        + '<path class="art-faint" d="M57 13h12"/><path class="art-line" d="M57 19h20"/>'
        + '<rect class="art-tile" x="51" y="31" width="38" height="18" rx="4"/>'
        + '<path class="art-faint" d="M57 37h16"/><path class="art-line" d="M57 43h14"/>'),
    phase2d: art(
        AXES_2D
        + '<ellipse class="art-fill" cx="50" cy="27" rx="30" ry="13" transform="rotate(-22 50 27)"/>'
        + '<ellipse class="art-line" cx="50" cy="27" rx="30" ry="13" transform="rotate(-22 50 27)"/>'),
    phase2dt: art(AXES_3D + `<path class="art-line" d="${helix()}"/>`),
    phase3d: art(AXES_3D + `<path class="art-line" d="${ORBIT_3D}"/>`),
    'state-anim-2': art(
        AXES_2D
        + '<ellipse class="art-faint art-dashed" cx="48" cy="28" rx="28" ry="13" transform="rotate(-22 48 28)"/>'
        + '<path class="art-line" d="M22 37c-3-8 8-19 24-23s28 1 29 8"/>'
        + '<circle class="art-dot" cx="75" cy="22" r="4.5"/>' + PLAY),
    'state-anim-3': art(
        AXES_3D
        + `<path class="art-faint art-dashed" d="${ORBIT_3D}"/>`
        + '<path class="art-line" d="M38 30c-6-12 10-22 20-12s24 12 24 0"/>'
        + '<circle class="art-dot" cx="82" cy="18" r="4.5"/>' + PLAY.replace('M80 6l10 6-10 6z', 'M8 6l10 6-10 6z')),
};

// In the order of the gallery. `key` is what a card is known by; `short` is
// what the toolbar button says while the type is on (a translation key when
// `shortKey`, else the label the old buttons carried).
export const PLOT_TYPES = [
    { key: 'timeseries', mode: 'timeseries', labelKey: 'modeTimeseries', shortKey: 'modeTimeseries' },
    { key: 'dashboard', mode: 'dashboard', labelKey: 'compactPlotTypeDashboard', shortKey: 'plotTypeShortDashboard' },
    { key: 'phase2d', mode: 'phase2d', labelKey: 'compactPlotType2d', short: '2D' },
    { key: 'phase2dt', mode: 'phase2dt', labelKey: 'compactPlotType2dt', short: '2D+t' },
    { key: 'phase3d', mode: 'phase3d', labelKey: 'compactPlotType3d', short: '3D' },
    { key: 'state-anim-2', mode: 'state-anim', dim: 2, labelKey: 'compactPlotTypeAnim2d', short: '▶x 2D' },
    { key: 'state-anim-3', mode: 'state-anim', dim: 3, labelKey: 'compactPlotTypeAnim3d', short: '▶x 3D' },
];

export const plotTypeDescKey = key => `plotTypeDesc_${key.replace(/-/g, '_')}`;

const TIME_SERIES_FAMILY = new Set(['timeseries', 'fft', 'histogram', 'heatmap', 'temporal-profile', 'integral', 'curve-fit', 'trend']);
const PAIR_FAMILY = new Set(['phase2d', 'correlation']);

// The type a plot is of: an analysis is still a time series, Correlation is
// still a 2D plot, and an animation is of the dimension of its state.
export function plotTypeOf(mode, stateAnimDim) {
    const primary = TIME_SERIES_FAMILY.has(mode) ? 'timeseries' : (PAIR_FAMILY.has(mode) ? 'phase2d' : mode);
    return PLOT_TYPES.find(type => type.mode === primary && (!type.dim || type.dim === (stateAnimDim || 2))) || null;
}
