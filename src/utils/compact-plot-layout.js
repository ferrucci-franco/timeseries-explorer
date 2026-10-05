// Plot text a little larger on a phone, and the X title clear of the ticks.
//
// Every layout builder writes its own sizes (11 px for the base font, which
// tick labels inherit, and 10 px for axis titles): right on a desktop screen
// at arm's length, a little small on a phone in the hand. Rather than teach
// twenty builders about the phone layout, the drawing wrapper
// (vendor/plotly.js) passes each layout and relayout update through here while
// the compact layout is on.
//
// The X title also gets a fixed gap below the tick labels. Its margin is a
// fixed 46 px, which a date axis's two-line labels at phone size overflow, and
// Plotly then pushes the title up against them, or over them. With
// automargin the margin grows to fit, by as much as the labels need, and the
// space between the title and the plot's bottom edge stays as it was.
//
// Nothing is mutated: builders keep their layouts and pass them back in, and a
// bump applied in place would grow on every redraw.

export const COMPACT_TICK_FONT_BUMP = 1;
export const COMPACT_AXIS_TITLE_FONT_BUMP = 2;
export const COMPACT_X_TITLE_STANDOFF = 12;

const DEFAULT_BASE_FONT = 12;
const AXIS_KEY = /^[xy]axis\d*$/;

const bumpFont = (font, by, fallback = null) => {
    const size = font?.size ?? fallback;
    if (!Number.isFinite(size)) return font;
    return { ...(font || {}), size: size + by };
};

const isXAxis = key => key.startsWith('x');
const hasTitleText = title => !!(typeof title === 'string' ? title : title?.text);

const bumpTitle = (title, x = false) => {
    if (!title || typeof title !== 'object') return title;
    let out = title;
    if (Number.isFinite(title.font?.size)) out = { ...out, font: bumpFont(title.font, COMPACT_AXIS_TITLE_FONT_BUMP) };
    if (x && title.text && title.standoff == null) out = { ...out, standoff: COMPACT_X_TITLE_STANDOFF };
    return out;
};

const bumpAxis = (axis, x = false) => {
    if (!axis || typeof axis !== 'object') return axis;
    const out = { ...axis, title: bumpTitle(axis.title, x) };
    if (Number.isFinite(axis.tickfont?.size)) out.tickfont = bumpFont(axis.tickfont, COMPACT_TICK_FONT_BUMP);
    // The standoff only holds when the margin may grow to keep it.
    if (x && hasTitleText(axis.title) && axis.automargin == null) out.automargin = true;
    if (!('title' in axis)) delete out.title;
    return out;
};

// A full layout, as newPlot and react take it.
export function compactPlotLayout(layout) {
    if (!layout || typeof layout !== 'object') return layout;
    const out = { ...layout, font: bumpFont(layout.font, COMPACT_TICK_FONT_BUMP, DEFAULT_BASE_FONT) };
    for (const key of Object.keys(layout)) {
        if (AXIS_KEY.test(key)) out[key] = bumpAxis(layout[key], isXAxis(key));
    }
    return out;
}

// A relayout update: flat attribute strings, some carrying whole objects.
export function compactPlotRelayout(update) {
    if (!update || typeof update !== 'object') return update;
    let out = null;
    const set = (key, value) => {
        if (value === update[key]) return;
        out ||= { ...update };
        out[key] = value;
    };
    for (const [key, value] of Object.entries(update)) {
        if (key === 'font' && value && typeof value === 'object') {
            set(key, bumpFont(value, COMPACT_TICK_FONT_BUMP));
        } else if (key === 'font.size' && Number.isFinite(value)) {
            set(key, value + COMPACT_TICK_FONT_BUMP);
        } else if (AXIS_KEY.test(key)) {
            set(key, bumpAxis(value, isXAxis(key)));
        } else if (/^[xy]axis\d*\.title$/.test(key)) {
            set(key, bumpTitle(value, isXAxis(key)));
        } else if (/^[xy]axis\d*\.title\.font$/.test(key) && Number.isFinite(value?.size)) {
            set(key, bumpFont(value, COMPACT_AXIS_TITLE_FONT_BUMP));
        } else if (/^[xy]axis\d*\.title\.font\.size$/.test(key) && Number.isFinite(value)) {
            set(key, value + COMPACT_AXIS_TITLE_FONT_BUMP);
        } else if (/^[xy]axis\d*\.tickfont\.size$/.test(key) && Number.isFinite(value)) {
            set(key, value + COMPACT_TICK_FONT_BUMP);
        }
    }
    return out || update;
}
