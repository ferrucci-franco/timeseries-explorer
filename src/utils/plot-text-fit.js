// Long names fitted to a plot's room, for every plot of the app at once
// (src/vendor/plotly.js applies these to everything that reaches Plotly).
//
// Plotly neither wraps a hover label nor shortens an axis title: a curve with
// a long name — an extraction's, with the box it was read in — ran off a
// phone's screen, its value with it, and its axis title past the top of the
// panel. Here the lines of a hover template longer than the plot is wide are
// broken between words, and an axis title longer than its side is cut with
// "…". On a wide plot nothing changes: the names fit.
//
// Sizes in characters, from the plot's pixels (about 7.5 px a character at
// the hover's 13 px, 7 px for a title's): an estimate on the safe side.
//
// Pure: no DOM, no Plotly.

import { fitMarkup, wrapMarkup } from './text-fit.js';

const HOVER_PX_PER_CHAR = 7.5;
const TITLE_PX_PER_CHAR = 7;
// The hover box's padding and the plot's margins, out of the width.
const HOVER_PX_SPARE = 60;
const TITLE_PX_SPARE = 80;

/** Characters a hover label's line may hold on a plot `width` px wide. */
export function hoverCharsFor(width) {
    if (!(width > 0)) return Infinity;
    return Math.max(20, Math.floor((width - HOVER_PX_SPARE) / HOVER_PX_PER_CHAR));
}

function titleCharsFor(size) {
    if (!(size > 0)) return Infinity;
    return Math.max(16, Math.floor((size - TITLE_PX_SPARE) / TITLE_PX_PER_CHAR));
}

/**
 * A trace's hover template, its long lines wrapped to `max` characters. The
 * template it was given is kept (`_hoverTemplateSource`), so a wider plot
 * later wraps it again from the whole text, not from the wrapped one.
 */
export function fitTraceHoverTemplate(trace, max) {
    if (!trace || typeof trace !== 'object' || typeof trace.hovertemplate !== 'string') return trace;
    if (trace.hovertemplate !== trace._hoverTemplateFitted) trace._hoverTemplateSource = trace.hovertemplate;
    const fitted = wrapMarkup(trace._hoverTemplateSource, max);
    trace.hovertemplate = fitted;
    trace._hoverTemplateFitted = fitted;
    return trace;
}

/** A restyle's `hovertemplate` (one value, or one per trace), wrapped. */
export function fitRestyleHoverTemplates(update, max) {
    if (!update || typeof update !== 'object' || !('hovertemplate' in update) || !Number.isFinite(max)) return update;
    const value = update.hovertemplate;
    const fit = template => (typeof template === 'string' ? wrapMarkup(template, max) : template);
    return { ...update, hovertemplate: Array.isArray(value) ? value.map(fit) : fit(value) };
}

const AXIS_KEY = /^([xy])axis\d*$/;

const fitTitle = (title, max) => {
    if (typeof title === 'string') return fitMarkup(title, max);
    if (title && typeof title === 'object' && typeof title.text === 'string') {
        const text = fitMarkup(title.text, max);
        return text === title.text ? title : { ...title, text };
    }
    return title;
};

/**
 * A layout with every axis title shortened to its side of the plot: an X
 * title to the width, a Y title to the height. The layout given is left as
 * it is; a copy comes back when something changed.
 */
export function fitLayoutTitles(layout, { width, height } = {}) {
    if (!layout || typeof layout !== 'object') return layout;
    let out = layout;
    for (const [key, axis] of Object.entries(layout)) {
        const match = AXIS_KEY.exec(key);
        if (!match || !axis || typeof axis !== 'object' || axis.title === undefined) continue;
        const max = titleCharsFor(match[1] === 'x' ? width : height);
        if (!Number.isFinite(max)) continue;
        const title = fitTitle(axis.title, max);
        if (title === axis.title) continue;
        if (out === layout) out = { ...layout };
        out[key] = { ...axis, title };
    }
    return out;
}

/** A relayout's axis titles ('yaxis.title.text', 'yaxis.title'…), shortened. */
export function fitRelayoutTitles(update, { width, height } = {}) {
    if (!update || typeof update !== 'object') return update;
    let out = update;
    for (const [key, value] of Object.entries(update)) {
        const match = /^([xy])axis\d*\.title(\.text)?$/.exec(key);
        if (!match) continue;
        const max = titleCharsFor(match[1] === 'x' ? width : height);
        if (!Number.isFinite(max)) continue;
        const fitted = fitTitle(value, max);
        if (fitted === value) continue;
        if (out === update) out = { ...update };
        out[key] = fitted;
    }
    return out;
}
