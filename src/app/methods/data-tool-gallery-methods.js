// The data tools of the side panel, as a gallery.
//
// The tools used to be a dropdown: eleven names behind "Choose a tool", which
// said neither what there was nor what any of it did. Here they are tiles, in
// the four families the phone's hub already uses (data-tool-catalog.js), each
// with its drawing; pointing at one says what it does. Two densities, because
// a side panel is narrow and a laptop screen is short: tiles with names, or
// drawings only. The choice is kept; the first time, it follows the height of
// the window.
//
// Opening a tool folds the gallery into a header that names it, with a way
// back, and the form unfolds under it as before.
//
// Nothing about which tool is open lives here. The <select> of index.html
// still holds it, off screen: a tile sets it and fires its `change`, and
// _syncDataToolGallery() redraws from it. So the phone's pages, the session
// restore and the "edit" of a transformation, which all write that select,
// need to know nothing about the gallery.
import i18n from '../../i18n/index.js';
import { DATA_TOOL_GROUPS, DATA_TOOL_ICONS, dataToolDescKey, dataToolGroupOf } from '../data-tool-catalog.js';

const DENSITY_STORAGE_KEY = 'omv.dataTools.density';
// Under this window height the gallery opens as drawings only, so it does not
// push the rest of the panel out of a 1366 × 768 screen.
export const DATA_TOOL_GALLERY_MIN_HEIGHT = 800;
const HOVERCARD_DELAY_MS = 350;

export function defaultDataToolDensity(viewportHeight) {
    return Number.isFinite(viewportHeight) && viewportHeight < DATA_TOOL_GALLERY_MIN_HEIGHT ? 'compact' : 'gallery';
}

function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
}

// Text that follows the language: the key is left on the node, so the i18n
// pass that runs on a language change rewrites it with everything else.
function setI18nText(node, key) {
    if (!node) return;
    node.setAttribute('data-i18n', key);
    node.textContent = i18n.t(key);
}

function glyph(tool, extra = '') {
    const node = make('span', `data-tool-glyph${extra ? ` ${extra}` : ''}`);
    node.setAttribute('aria-hidden', 'true');
    node.innerHTML = DATA_TOOL_ICONS[tool] || '';
    return node;
}

export function installDataToolGalleryMethods(TargetClass) {
    const proto = TargetClass.prototype;

    // The i18n key of a tool's name: the one its <option> already carries.
    proto._dataToolGalleryLabelKey = function(tool) {
        const select = document.getElementById('data-tool-select');
        return [...(select?.options || [])].find(option => option.value === tool)?.getAttribute('data-i18n') || '';
    };

    proto._initDataToolGallery = function() {
        const gallery = document.getElementById('data-tool-gallery');
        const select = document.getElementById('data-tool-select');
        if (!gallery?.appendChild || !select || gallery.childElementCount) return;

        for (const group of DATA_TOOL_GROUPS) {
            const family = make('div', `data-tool-family group-${group.id}`);
            const title = make('div', 'data-tool-family-title');
            setI18nText(title, group.titleKey);
            const tiles = make('div', 'data-tool-tiles');
            for (const tool of group.tools) {
                const tile = make('button', 'data-tool-tile');
                tile.type = 'button';
                tile.dataset.tool = tool;
                tile.tabIndex = -1;
                const name = make('span', 'data-tool-tile-name');
                setI18nText(name, this._dataToolGalleryLabelKey(tool));
                tile.append(glyph(tool), name);
                tiles.appendChild(tile);
            }
            family.append(title, tiles);
            gallery.appendChild(family);
        }
        const tiles = () => [...gallery.querySelectorAll('.data-tool-tile')];
        if (tiles()[0]) tiles()[0].tabIndex = 0;

        gallery.addEventListener('click', (event) => {
            const tile = event.target.closest?.('.data-tool-tile');
            if (!tile) return;
            this._hideDataToolHovercard();
            if (tile.getAttribute('aria-disabled') === 'true') return;
            this._openDataToolFromGallery(tile.dataset.tool);
        });
        // One tab stop for the whole gallery; the arrows move inside it.
        gallery.addEventListener('keydown', (event) => {
            const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
            const all = tiles();
            const at = all.indexOf(document.activeElement);
            let next = -1;
            if (step && at >= 0) next = (at + step + all.length) % all.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = all.length - 1;
            else if (event.key === 'Escape') this._hideDataToolHovercard();
            if (next < 0) return;
            event.preventDefault();
            all.forEach((tile, index) => { tile.tabIndex = index === next ? 0 : -1; });
            all[next].focus();
        });
        gallery.addEventListener('mouseover', (event) => {
            const tile = event.target.closest?.('.data-tool-tile');
            if (tile) this._scheduleDataToolHovercard(tile);
        });
        gallery.addEventListener('mouseleave', () => this._hideDataToolHovercard());
        gallery.addEventListener('focusin', (event) => {
            const tile = event.target.closest?.('.data-tool-tile');
            // Only for a focus the keyboard gave: a click focuses too, and the
            // card would flash over the form that click opens.
            if (tile?.matches?.(':focus-visible')) this._showDataToolHovercard(tile);
        });
        gallery.addEventListener('focusout', () => this._hideDataToolHovercard());
        // Scrolling the panel moves the tiles from under the card, so the card
        // goes; it comes back for the tile the pointer rests on once the
        // scrolling stops. Without the second half, a tile reached by
        // scrolling (the wheel, or a tile brought into view to be pointed at)
        // never got its card: the scroll arrives after the pointer does.
        document.getElementById('sidebar')?.addEventListener('scroll', () => {
            this._hideDataToolHovercard();
            const tile = gallery.querySelector('.data-tool-tile:hover');
            if (tile) this._scheduleDataToolHovercard(tile);
        }, { passive: true });

        document.getElementById('data-tool-active-close')?.addEventListener('click', () => {
            const tool = select.value;
            this._openDataToolFromGallery('');
            gallery.querySelector(`.data-tool-tile[data-tool="${tool}"]`)?.focus?.({ preventScroll: true });
        });

        let density = '';
        try { density = localStorage.getItem(DENSITY_STORAGE_KEY) || ''; } catch { /* not kept */ }
        this._setDataToolDensity(density === 'compact' || density === 'gallery'
            ? density
            : defaultDataToolDensity(window.innerHeight));
        document.getElementById('data-tool-density')?.addEventListener('click', () => {
            const next = gallery.classList.contains('density-compact') ? 'gallery' : 'compact';
            this._setDataToolDensity(next);
            try { localStorage.setItem(DENSITY_STORAGE_KEY, next); } catch { /* not kept */ }
        });
    };

    proto._setDataToolDensity = function(density) {
        const gallery = document.getElementById('data-tool-gallery');
        const button = document.getElementById('data-tool-density');
        if (!gallery) return;
        const compact = density === 'compact';
        gallery.classList.toggle('density-compact', compact);
        if (!button) return;
        // The button offers the other view.
        const titleKey = compact ? 'dataToolDensityGallery' : 'dataToolDensityCompact';
        button.setAttribute('aria-pressed', String(compact));
        button.setAttribute('data-i18n-title', titleKey);
        button.title = i18n.t(titleKey);
    };

    // What the dropdown did when its value changed: the same event, so the
    // draft, the preview and an edit under way are put away by the same code.
    proto._openDataToolFromGallery = function(tool) {
        const select = document.getElementById('data-tool-select');
        if (!select || select.disabled) return;
        select.value = tool;
        if ((select.value || '') !== tool) return;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if (tool) document.getElementById('outlier-variable')?.focus?.({ preventScroll: true });
        // The form is not the height of the gallery it replaces: keep its head
        // (or, on the way back, the gallery) where it can be seen.
        document.getElementById(tool ? 'data-tool-active' : 'data-tool-gallery')?.scrollIntoView?.({ block: 'nearest' });
    };

    // Redraw the gallery from the select: which tool is open, and which tiles
    // can be used (no file: none; a file in memory-saving mode: some).
    proto._syncDataToolGallery = function() {
        const gallery = document.getElementById('data-tool-gallery');
        const select = document.getElementById('data-tool-select');
        if (!gallery?.querySelectorAll || !select) return;
        const tool = select.value || '';
        const noFile = !!select.disabled;
        const options = new Map([...(select.options || [])].map(option => [option.value, option]));

        gallery.hidden = !!tool;
        gallery.classList.toggle('needs-file', noFile);
        for (const tile of gallery.querySelectorAll('.data-tool-tile')) {
            const unavailable = noFile || !!options.get(tile.dataset.tool)?.disabled;
            tile.setAttribute('aria-disabled', String(unavailable));
            tile.dataset.unavailable = noFile ? 'file' : (unavailable ? 'lazy' : '');
        }
        const density = document.getElementById('data-tool-density');
        if (density) density.hidden = !!tool;
        if (tool) this._hideDataToolHovercard();

        const active = document.getElementById('data-tool-active');
        if (!active) return;
        active.hidden = !tool;
        if (!tool || active.dataset.tool === tool) return;
        active.dataset.tool = tool;
        const group = dataToolGroupOf(tool);
        active.className = `data-tool-active group-${group?.id || 'other'}`;
        const glyphNode = document.getElementById('data-tool-active-glyph');
        if (glyphNode) glyphNode.innerHTML = DATA_TOOL_ICONS[tool] || '';
        setI18nText(document.getElementById('data-tool-active-name'), this._dataToolGalleryLabelKey(tool));
        if (group) setI18nText(document.getElementById('data-tool-active-family'), group.titleKey);
        setI18nText(document.getElementById('data-tool-active-desc'), dataToolDescKey(tool));
    };

    // ─── The card that says what a tool does ──────────────────────

    proto._scheduleDataToolHovercard = function(tile) {
        if (this._dataToolHovercardTile === tile) return;
        clearTimeout(this._dataToolHovercardTimer);
        // Once a card is up, moving along the tiles swaps it at once.
        const card = document.getElementById('data-tool-hovercard');
        if (card && !card.hidden) {
            this._showDataToolHovercard(tile);
            return;
        }
        this._dataToolHovercardTimer = setTimeout(() => this._showDataToolHovercard(tile), HOVERCARD_DELAY_MS);
    };

    proto._showDataToolHovercard = function(tile) {
        clearTimeout(this._dataToolHovercardTimer);
        const tool = tile?.dataset?.tool;
        if (!tool || !tile.isConnected) return;
        let card = document.getElementById('data-tool-hovercard');
        if (!card) {
            card = make('div', 'data-tool-hovercard');
            card.id = 'data-tool-hovercard';
            card.setAttribute('role', 'tooltip');
            document.body.appendChild(card);
        }
        const group = dataToolGroupOf(tool);
        card.className = `data-tool-hovercard group-${group?.id || 'other'}`;
        card.replaceChildren();
        const head = make('div', 'data-tool-hovercard-head');
        const text = make('div', 'data-tool-hovercard-text');
        text.append(
            make('div', 'data-tool-hovercard-name', i18n.t(this._dataToolGalleryLabelKey(tool))),
            make('div', 'data-tool-hovercard-family', group ? i18n.t(group.titleKey) : ''),
        );
        head.append(glyph(tool, 'is-large'), text);
        card.append(head, make('div', 'data-tool-hovercard-desc', i18n.t(dataToolDescKey(tool))));
        const why = { file: 'dataToolNeedsFile', lazy: 'compactToolLazyUnavailable' }[tile.dataset.unavailable];
        if (why) card.appendChild(make('div', 'data-tool-hovercard-note', i18n.t(why)));

        card.hidden = false;
        this._dataToolHovercardTile = tile;
        tile.setAttribute('aria-describedby', card.id);

        // Beside the side panel, level with the tile, so it covers neither the
        // tile's neighbours nor the tile itself; under the tile when the panel
        // leaves no room beside it.
        const margin = 8;
        const rect = tile.getBoundingClientRect();
        const panel = document.getElementById('sidebar')?.getBoundingClientRect() || rect;
        const width = card.offsetWidth;
        const height = card.offsetHeight;
        let left = panel.right + margin;
        let top = rect.top + rect.height / 2 - height / 2;
        if (left + width > window.innerWidth - margin) {
            left = panel.left - width - margin;
            if (left < margin) {
                left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
                top = rect.bottom + margin;
                if (top + height > window.innerHeight - margin) top = rect.top - height - margin;
            }
        }
        top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin));
        card.style.left = `${Math.round(left)}px`;
        card.style.top = `${Math.round(top)}px`;
    };

    proto._hideDataToolHovercard = function() {
        clearTimeout(this._dataToolHovercardTimer);
        this._dataToolHovercardTile?.removeAttribute?.('aria-describedby');
        this._dataToolHovercardTile = null;
        const card = typeof document !== 'undefined' ? document.getElementById('data-tool-hovercard') : null;
        if (card && 'hidden' in card) card.hidden = true;
    };
}
