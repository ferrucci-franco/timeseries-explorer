// A button at the corner of every overlay legend that hides and shows it.
//
// A long variable name makes a long legend, and an overlay legend lies on the
// curve — on a phone it also lay over the fit buttons. The button stays at the
// legend's corner; the legend, while shown, is moved aside to clear it
// (utils/legend-toggle-layout.js says where).
//
// On the phone the legend starts hidden and the button opens it. On a desktop
// it starts shown, unless it is wide enough to cover a good part of the plot.
// Once the reader opens or closes a legend, that choice is kept for that plot
// (redraws, new curves) until the legend settings in the sidebar change.
//
// Hiding is a class on the plot and the move is a CSS `translate` on Plotly's
// legend group: neither touches the figure, so redraws, legend clicks and
// image exports (which always carry the legend) work as they did.
import i18n from '../i18n/index.js';
import {
    legendStartsCollapsed,
    legendToggleGeometry,
    overlayLegendCorner,
} from '../utils/legend-toggle-layout.js';

const COLLAPSED_CLASS = 'legend-collapsed';
const BUTTON_CLASS = 'legend-toggle-btn';

// A list with its colour marks: what a legend looks like.
const ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">'
    + '<line x1="4" y1="7" x2="7" y2="7"/><line x1="10" y1="7" x2="20" y2="7"/>'
    + '<line x1="4" y1="12" x2="7" y2="12"/><line x1="10" y1="12" x2="20" y2="12"/>'
    + '<line x1="4" y1="17" x2="7" y2="17"/><line x1="10" y1="17" x2="17" y2="17"/>'
    + '</svg>';

// The reader's own choice, per plot: { desktop?: boolean, compact?: boolean },
// true for hidden. Keyed by panel and pane rather than by div, because a
// panel's chart is a new div after each rebuild.
const choices = new Map();
const installed = new Set();

const isCompact = () => typeof document !== 'undefined'
    && document.documentElement.classList.contains('compact');

function plotKey(div) {
    const panelId = div.closest?.('.layout-panel')?.dataset?.id || '';
    const pane = String(div.className || '').match(/plotly-mode-[\w-]+/)?.[0] || '';
    return panelId || pane ? `${panelId}|${pane}` : null;
}

function legendBox(div, legendEl) {
    const bg = legendEl.querySelector(':scope > rect.bg');
    const width = Number(bg?.getAttribute('width'));
    const height = Number(bg?.getAttribute('height'));
    if (!(width > 0) || !(height > 0)) return null;
    const match = /translate\(\s*([-\d.e]+)[\s,]+([-\d.e]+)\s*\)/.exec(legendEl.getAttribute('transform') || '');
    if (!match) return null;
    // The SVG's own offset in the div, which is 0 for a plain Plotly plot.
    const svg = div.querySelector('.main-svg');
    const svgRect = svg?.getBoundingClientRect?.();
    const divRect = div.getBoundingClientRect();
    const offX = svgRect ? svgRect.left - divRect.left : 0;
    const offY = svgRect ? svgRect.top - divRect.top : 0;
    return { left: Number(match[1]) + offX, top: Number(match[2]) + offY, width, height };
}

function removeToggle(div) {
    div.classList?.remove(COLLAPSED_CLASS);
    const legendEl = div.querySelector?.('.infolayer .legend');
    if (legendEl) legendEl.style.translate = '';
    div._legendToggleBtn?.remove();
    div._legendToggleBtn = null;
}

function ensureButton(div) {
    let btn = div._legendToggleBtn;
    if (btn && btn.parentNode === div) return btn;
    btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BUTTON_CLASS;
    btn.innerHTML = ICON;
    btn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const key = plotKey(div);
        if (!key) return;
        const mode = isCompact() ? 'compact' : 'desktop';
        const collapsed = div.classList.contains(COLLAPSED_CLASS);
        choices.set(key, { ...(choices.get(key) || {}), [mode]: !collapsed });
        syncLegendToggle(div);
    });
    // Neither the panel's drag handling nor its focus click should see it.
    btn.addEventListener('pointerdown', (event) => event.stopPropagation());
    btn.addEventListener('mousedown', (event) => event.stopPropagation());
    div.appendChild(btn);
    div._legendToggleBtn = btn;
    return btn;
}

/** Bring one plot's legend button in step with its legend. */
export function syncLegendToggle(div) {
    if (!div?.isConnected) return;
    const fullLayout = div._fullLayout;
    const legendEl = div.querySelector('.infolayer .legend');
    const corner = fullLayout?.showlegend ? overlayLegendCorner(fullLayout.legend) : null;
    const box = corner && legendEl && legendEl.querySelector('.traces') ? legendBox(div, legendEl) : null;
    const key = plotKey(div);
    if (!box || !key) {
        removeToggle(div);
        return;
    }
    const compact = isCompact();
    const own = choices.get(key)?.[compact ? 'compact' : 'desktop'];
    const collapsed = typeof own === 'boolean'
        ? own
        : legendStartsCollapsed({ compact, legendWidth: box.width, plotWidth: fullLayout._size?.w });

    const btn = ensureButton(div);
    btn.classList.toggle('is-open', !collapsed);
    btn.setAttribute('aria-expanded', String(!collapsed));
    const label = i18n.t(collapsed ? 'legendToggleShow' : 'legendToggleHide');
    btn.title = label;
    btn.setAttribute('aria-label', label);

    const buttonSize = btn.offsetWidth || (compact ? 38 : 22);
    const { button, shift } = legendToggleGeometry({
        box, corner, buttonSize, gap: compact ? 6 : 4, vertical: compact,
    });
    btn.style.left = `${Math.round(button.left)}px`;
    btn.style.top = `${Math.round(button.top)}px`;
    div.classList.toggle(COLLAPSED_CLASS, collapsed);
    legendEl.style.translate = collapsed ? '' : `${shift.x}px ${shift.y}px`;
}

/** Bring every plot on the page in step: after a layout or language switch. */
export function syncAllLegendToggles() {
    for (const div of installed) {
        if (div.isConnected) syncLegendToggle(div);
        else installed.delete(div);
    }
}

/**
 * Forget what the reader chose: the legend settings changed, so each legend
 * goes back to how it starts.
 */
export function resetLegendToggles() {
    choices.clear();
    syncAllLegendToggles();
}

let observing = false;
function observePage() {
    if (observing || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
    observing = true;
    let pending = false;
    // The phone layout comes and goes with a class on <html>: it changes the
    // button and where the legend moves, not the figure.
    new MutationObserver(() => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            syncAllLegendToggles();
        });
    }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
}

/** Called for every plot as it is drawn (vendor/plotly.js onPlotDrawn). */
export function installLegendToggle(div) {
    if (!div || typeof div.on !== 'function') return;
    observePage();
    // Plotly.newPlot drops every listener on the div: the one redraws need is
    // put back each time, never twice.
    if (!div._legendToggleSync) div._legendToggleSync = () => syncLegendToggle(div);
    div.removeListener?.('plotly_afterplot', div._legendToggleSync);
    div.on('plotly_afterplot', div._legendToggleSync);
    for (const old of installed) if (!old.isConnected) installed.delete(old);
    installed.add(div);
    syncLegendToggle(div);
}
