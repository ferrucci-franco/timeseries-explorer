// Slightly larger plot text on a phone.
//
// Every layout builder writes its own sizes (11 px for the base font, which
// tick labels inherit, and 10 px for axis titles): right on a desktop screen
// at arm's length, a little small on a phone in the hand. Rather than teach
// twenty builders about the phone layout, the drawing wrapper
// (vendor/plotly.js) passes each layout and relayout update through here while
// the compact layout is on.
//
// Nothing is mutated: builders keep their layouts and pass them back in, and a
// bump applied in place would grow on every redraw.

export const COMPACT_TICK_FONT_BUMP = 1;
export const COMPACT_AXIS_TITLE_FONT_BUMP = 2;

const DEFAULT_BASE_FONT = 12;
const AXIS_KEY = /^[xy]axis\d*$/;

const bumpFont = (font, by, fallback = null) => {
    const size = font?.size ?? fallback;
    if (!Number.isFinite(size)) return font;
    return { ...(font || {}), size: size + by };
};

const bumpTitle = (title) => {
    if (!title || typeof title !== 'object' || !Number.isFinite(title.font?.size)) return title;
    return { ...title, font: bumpFont(title.font, COMPACT_AXIS_TITLE_FONT_BUMP) };
};

const bumpAxis = (axis) => {
    if (!axis || typeof axis !== 'object') return axis;
    const out = { ...axis, title: bumpTitle(axis.title) };
    if (Number.isFinite(axis.tickfont?.size)) out.tickfont = bumpFont(axis.tickfont, COMPACT_TICK_FONT_BUMP);
    if (!('title' in axis)) delete out.title;
    return out;
};

// A full layout, as newPlot and react take it.
export function enlargeLayoutFonts(layout) {
    if (!layout || typeof layout !== 'object') return layout;
    const out = { ...layout, font: bumpFont(layout.font, COMPACT_TICK_FONT_BUMP, DEFAULT_BASE_FONT) };
    for (const key of Object.keys(layout)) {
        if (AXIS_KEY.test(key)) out[key] = bumpAxis(layout[key]);
    }
    return out;
}

// A relayout update: flat attribute strings, some carrying whole objects.
export function enlargeRelayoutFonts(update) {
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
            set(key, bumpAxis(value));
        } else if (/^[xy]axis\d*\.title$/.test(key)) {
            set(key, bumpTitle(value));
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
