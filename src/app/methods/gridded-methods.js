// The gridded dataset view: a map of a gridded netCDF file (ERA5, CMIP, ...)
// over the plot area, with a time slider, a level selector and two tools —
// a point and a box — whose results become ordinary variables of the file in
// the explorer, where FFT, integrals, heatmaps and cursors already work.
//
// The data never comes to this thread whole. src/gridded/ holds the files open
// in a worker, by parts; this side asks for one map at a time, or for one
// extraction, and draws. See docs/netcdf-gridded-viewer-spec.md (§4.4).

import i18n from '../../i18n/index.js';
import Modal from '../../ui/modal.js';
import Plotly from '../../vendor/plotly.js';
import { griddedClient, nextDatasetId } from '../../gridded/gridded-client.js';
import { GRIB_EXTENSIONS } from '../constants.js';
import { extractZipEntry, isNetcdfEntryName, listZipEntries } from '../../gridded/zip-reader.js';
import { NETCDF_READABLE_KINDS, sniffNetcdfContainer } from '../../parsers/netcdf-sniff.js';
import { formatUnitPowers } from '../../utils/unit-superscripts.js';
import { claimTouchGestures } from '../../ui/plot-touch-gestures.js';
import { coastlineTrace, coastlineWindow, insideCoastlineWindow } from '../../gridded/coastlines.js';
import { copyTextToClipboard } from '../../utils/clipboard.js';

const GRIDDED_EXTENSIONS = new Set(['.nc', '.nc4', '.netcdf', '.cdf', '.zip', ...GRIB_EXTENSIONS]);
// What the gridded reader opens: netCDF (3, 4, CDF-5) and GRIB.
const GRIDDED_READABLE_KINDS = new Set([...NETCDF_READABLE_KINDS, 'cdf5', 'grib']);
// Above this many cells a map is drawn decimated to the screen; zooming in
// reads the full resolution of what is visible.
const MAX_DRAWN_CELLS = 400 * 1000;
const PALETTES = ['Viridis', 'Cividis', 'Turbo', 'RdBu', 'Greys'];
const PLAY_SPEEDS = [1, 2, 4, 8];
const COASTLINE_FILES = { coarse: 'geo/natural-earth-110m.json', fine: 'geo/natural-earth-50m.json' };
// Zoomed in past this longitude span, the 1:50m coastline replaces the 1:110m one.
const FINE_COAST_SPAN_DEGREES = 70;

// The export button of every plot panel, so the map's reads the same.
const EXPORT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>';
const GLOBE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="8.5" stroke-width="1.8"/><path d="M3.5 12h17M12 3.5c2.6 2.6 2.6 14.4 0 17M12 3.5c-2.6 2.6-2.6 14.4 0 17" stroke-width="1.6"/></svg>';
// The time bar's buttons as drawn icons, all on the same 16-unit box: text
// glyphs (⏮ ▶ ⏸ ▶|) come from different fonts and never line up.
const svgIcon = body => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false" fill="currentColor">${body}</svg>`;
const STEP_ICONS = {
    first: svgIcon('<rect x="2" y="3" width="2" height="10"/><path d="M9 3v10L4.5 8zM14 3v10L9.5 8z"/>'),
    prev: svgIcon('<path d="M10 3v10L4 8z"/><rect x="11" y="3" width="2" height="10"/>'),
    play: svgIcon('<path d="M4 2.5v11L13.5 8z"/>'),
    pause: svgIcon('<rect x="3.5" y="3" width="3" height="10"/><rect x="9.5" y="3" width="3" height="10"/>'),
    next: svgIcon('<rect x="3" y="3" width="2" height="10"/><path d="M6 3v10l6-5z"/>'),
    last: svgIcon('<path d="M2 3v10l4.5-5zM7 3v10l4.5-5z"/><rect x="12" y="3" width="2" height="10"/>'),
};
const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6"/></svg>';
// One colour per extraction, shared by its marker or box on the map, its row
// in the panel and its curves in the preview.
const SERIES_COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf', '#8c564b', '#e377c2'];

const coastlineCache = new Map();

function loadCoastlines(scale) {
    if (!coastlineCache.has(scale)) {
        const base = (typeof window !== 'undefined' && window.__OMV_PUBLIC_BASE__) || './';
        coastlineCache.set(scale, fetch(`${base}${COASTLINE_FILES[scale]}`)
            .then(response => (response.ok ? response.json() : null))
            .catch(() => null));
    }
    return coastlineCache.get(scale);
}

/**
 * Which cells of a map to draw for a view window, and with what stride. A map
 * small enough to draw whole is drawn whole whatever the zoom, so panning
 * never shows an empty edge and zooming never needs a redraw. A larger one
 * is cut to the window plus half of it on every side (room to pan), then
 * decimated by an integer stride so the browser never paints more than
 * MAX_DRAWN_CELLS bricks.
 */
export function gridWindow(map, xRange = null, yRange = null, maxCells = MAX_DRAWN_CELLS) {
    const strideFor = (width, height) => Math.max(1, Math.ceil(Math.sqrt((width * height) / maxCells)));
    const whole = { x0: 0, x1: map.lon.length - 1, y0: 0, y1: map.lat.length - 1, windowed: false };
    if (strideFor(map.lon.length, map.lat.length) === 1 || (!xRange && !yRange)) {
        return { ...whole, stride: strideFor(map.lon.length, map.lat.length) };
    }
    const cut = (axis, range) => {
        if (!range) return [0, axis.length - 1];
        let [low, high] = range[0] <= range[1] ? range : [range[1], range[0]];
        const pad = (high - low) / 2;
        low -= pad;
        high += pad;
        let start = 0;
        while (start < axis.length - 1 && axis[start + 1] < low) start += 1;
        let stop = axis.length - 1;
        while (stop > 0 && axis[stop - 1] > high) stop -= 1;
        return stop >= start ? [start, stop] : [0, axis.length - 1];
    };
    const [x0, x1] = cut(map.lon, xRange);
    const [y0, y1] = cut(map.lat, yRange);
    const windowed = x0 > 0 || y0 > 0 || x1 < map.lon.length - 1 || y1 < map.lat.length - 1;
    return { x0, x1, y0, y1, windowed, stride: strideFor(x1 - x0 + 1, y1 - y0 + 1) };
}

/** The cells gridWindow chose, as heatmap x/y/z arrays. */
export function drawableGrid(map, xRange = null, yRange = null, maxCells = MAX_DRAWN_CELLS) {
    const { x0, x1, y0, y1, stride, windowed } = gridWindow(map, xRange, yRange, maxCells);
    const xs = [];
    for (let column = x0; column <= x1; column += stride) xs.push(column);
    const ys = [];
    for (let row = y0; row <= y1; row += stride) ys.push(row);
    const z = ys.map(row => {
        const out = new Float32Array(xs.length);
        const base = row * map.nx;
        for (let index = 0; index < xs.length; index++) out[index] = map.values[base + xs[index]];
        return out;
    });
    return {
        x: Float64Array.from(xs, column => map.lon[column]),
        y: Float64Array.from(ys, row => map.lat[row]),
        z,
        stride,
        // The lon/lat extent drawn, when it is not the whole map.
        extent: windowed ? { x: [map.lon[x0], map.lon[x1]], y: [map.lat[y0], map.lat[y1]] } : null,
    };
}

/**
 * The cells a point at (lat, lon) is read from, as a closed outline on the
 * map: for "nearest", the edges of that one cell; for "bilinear", the square
 * joining the centres of its four neighbours (fewer at the edge of a regional
 * grid or beyond the outermost latitude), whose corners are marked. Mirrors
 * GriddedDataset._bilinearCells, in the map's display longitudes.
 */
function pointStencil(map, lat, lon, method) {
    const lats = map?.lat;
    const lons = map?.lon;
    if (!lats?.length || !lons?.length || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const last = lons.length - 1;
    let x = lon;
    if (lons[last] > 180 && x < 0) x += 360;
    if (lons[0] < 0 && x > 180) x -= 360;
    const outline = (west, east, south, north) => ({
        x: [west, east, east, west, west], y: [south, south, north, north, south],
    });
    const sortedLats = Array.from(lats).sort((a, b) => a - b);
    if (method !== 'bilinear') {
        const nearest = (values, target) => values.reduce((best, value, index) => (Math.abs(value - target) < Math.abs(values[best] - target) ? index : best), 0);
        const half = (values, index) => (values.length < 2 ? 0.5 : Math.abs(values[index === 0 ? 1 : index - 1] - values[index]) / 2);
        const row = nearest(lats, lat);
        const column = nearest(lons, x);
        const dy = half(lats, row);
        const dx = half(lons, column);
        return { ...outline(lons[column] - dx, lons[column] + dx, lats[row] - dy, lats[row] + dy), corners: false };
    }
    let low = 0;
    while (low < sortedLats.length - 2 && sortedLats[low + 1] <= lat) low += 1;
    let south = sortedLats[low];
    let north = sortedLats[Math.min(low + 1, sortedLats.length - 1)];
    // Beyond the outermost latitude only the edge row is read.
    if (lat <= sortedLats[0]) north = south;
    if (lat >= sortedLats[sortedLats.length - 1]) south = north = sortedLats[sortedLats.length - 1];
    const step = last > 0 ? (lons[last] - lons[0]) / last : 360;
    const global = last > 0 && Math.abs(lons[last] - lons[0] + step - 360) < step / 2;
    let west;
    let east;
    if (x >= lons[0] && x <= lons[last]) {
        let index = 0;
        while (index < last - 1 && lons[index + 1] <= x) index += 1;
        west = lons[index];
        east = lons[Math.min(index + 1, last)];
    } else if (global) {
        // Across the seam: the last column and the first, one turn apart.
        west = x < lons[0] ? lons[last] - 360 : lons[last];
        east = x < lons[0] ? lons[0] : lons[0] + 360;
    } else {
        west = east = x < lons[0] ? lons[0] : lons[last];
    }
    return { ...outline(west, east, south, north), corners: true };
}

// How close to the orange box's edge a pointer resizes it rather than moving
// it, in pixels: a mouse is precise, a finger is not.
const BOX_EDGE_PX = { mouse: 6, touch: 16 };
const RING_GRAB_PX = { mouse: 12, touch: 24 };

/**
 * Right-button drag pans a chart, as it does on every plot of the explorer
 * (Plotly's own drag only answers the left button). Both axes move with the
 * mouse. `state.rightPan` is set while the button is down and
 * `state.pannedAt` when a drag ends, so a context menu can tell a click from
 * the end of a pan; `onEnd(pan)` runs on release.
 */
function bindRightDragPan(div, state = {}, onEnd = null) {
    if (!div || div._griddedRightPan) return;
    div._griddedRightPan = true;
    div.addEventListener('mousedown', event => {
        if (event.button !== 2) return;
        const xa = div._fullLayout?.xaxis;
        const ya = div._fullLayout?.yaxis;
        if (!xa?._length || !ya?._length || typeof xa.r2l !== 'function') return;
        const rect = div.getBoundingClientRect();
        const px = event.clientX - rect.left - xa._offset;
        const py = event.clientY - rect.top - ya._offset;
        if (px < 0 || py < 0 || px > xa._length || py > ya._length) return;
        event.preventDefault();
        event.stopPropagation();
        const x0 = xa.range.map(value => xa.r2l(value));
        const y0 = ya.range.map(value => ya.r2l(value));
        const pan = { startX: event.clientX, startY: event.clientY, moved: false, menuAt: null, frame: 0, latest: null };
        state.rightPan = pan;
        const flush = () => {
            pan.frame = 0;
            if (pan.latest) Plotly.relayout(div, pan.latest);
        };
        const move = moveEvent => {
            const dx = moveEvent.clientX - pan.startX;
            const dy = moveEvent.clientY - pan.startY;
            if (!pan.moved && Math.hypot(dx, dy) < 4) return;
            pan.moved = true;
            div.classList.add('gridded-panning');
            const sx = ((x0[1] - x0[0]) / xa._length) * dx;
            const sy = ((y0[1] - y0[0]) / ya._length) * dy;
            pan.latest = {
                'xaxis.range': [xa.l2r(x0[0] - sx), xa.l2r(x0[1] - sx)],
                'yaxis.range': [ya.l2r(y0[0] + sy), ya.l2r(y0[1] + sy)],
            };
            if (!pan.frame) pan.frame = requestAnimationFrame(flush);
        };
        const up = () => {
            window.removeEventListener('mousemove', move, true);
            window.removeEventListener('mouseup', up, true);
            if (pan.frame) {
                cancelAnimationFrame(pan.frame);
                flush();
            }
            div.classList.remove('gridded-panning');
            state.rightPan = null;
            if (pan.moved) state.pannedAt = Date.now();
            onEnd?.(pan);
        };
        window.addEventListener('mousemove', move, true);
        window.addEventListener('mouseup', up, true);
    }, true);
}

/**
 * Two fingers on a trackpad: a swipe up or down zooms (Plotly's wheel zoom,
 * as a mouse wheel does), a swipe in any other direction pans the map, both
 * ways at once. A swipe that starts sideways or diagonally latches into a pan
 * until the fingers rest, so it can turn vertical without starting to zoom
 * (Windows also locks a swipe to one axis, and the lift-and-replace that
 * moves the other way lands within the latch). A pinch (ctrlKey) zooms.
 * The same gesture as on the explorer's plots (_installWheelPan).
 */
function bindWheelPan(div) {
    if (!div || div._griddedWheelPan) return;
    div._griddedWheelPan = true;
    const LATCH_MS = 800;
    // Steeper than this, from the vertical, is a pan (about 20 degrees).
    const PAN_SLOPE = 0.35;
    const state = { panning: false, timer: 0, frame: 0, dx: 0, dy: 0 };
    const flush = () => {
        state.frame = 0;
        const xa = div._fullLayout?.xaxis;
        const ya = div._fullLayout?.yaxis;
        if (!xa?._length || !ya?._length) return;
        const sx = ((xa.range[1] - xa.range[0]) / xa._length) * state.dx;
        // deltaY > 0 scrolls down: the map shows what is further south.
        const sy = -((ya.range[1] - ya.range[0]) / ya._length) * state.dy;
        state.dx = 0;
        state.dy = 0;
        Plotly.relayout(div, {
            'xaxis.range': [xa.range[0] + sx, xa.range[1] + sx],
            'yaxis.range': [ya.range[0] + sy, ya.range[1] + sy],
        });
    };
    div.addEventListener('wheel', event => {
        if (!state.panning) {
            if (event.ctrlKey || Math.abs(event.deltaX) <= PAN_SLOPE * Math.abs(event.deltaY)) return;
            state.panning = true;
        }
        clearTimeout(state.timer);
        state.timer = setTimeout(() => { state.panning = false; }, LATCH_MS);
        // Before Plotly's own wheel handler, which would zoom.
        event.preventDefault();
        event.stopPropagation();
        const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (div.clientHeight || 800) : 1;
        state.dx += event.deltaX * scale;
        state.dy += event.deltaY * scale;
        if (!state.frame) state.frame = requestAnimationFrame(flush);
    }, { capture: true, passive: false });
}

/**
 * A drop-down menu opened next to its button, moved sideways just enough to
 * stay on screen (on a phone the colour menu is wider than the space to the
 * left of its button).
 */
function keepOnScreen(menu, gap = 8) {
    menu.style.transform = '';
    menu.style.maxWidth = `${window.innerWidth - 2 * gap}px`;
    const rect = menu.getBoundingClientRect();
    let shift = 0;
    if (rect.left < gap) shift = gap - rect.left;
    else if (rect.right > window.innerWidth - gap) shift = window.innerWidth - gap - rect.right;
    if (shift) menu.style.transform = `translateX(${Math.round(shift)}px)`;
}

// A drawn box or a click lands between pixels; two decimals of a degree is
// about a kilometre, finer than any reanalysis grid.
function roundCoordinate(value) {
    return Math.round(value * 100) / 100;
}

/**
 * Minimum, maximum and the 1st/99th percentiles of a map (or of the part of
 * it inside a zoom window), the latter from a bounded subsample.
 */
export function mapStats(map, zoom = null) {
    const inRange = (value, range) => !range || (value >= Math.min(range[0], range[1]) && value <= Math.max(range[0], range[1]));
    const rows = [];
    for (let row = 0; row < map.ny; row++) if (inRange(map.lat[row], zoom?.y)) rows.push(row);
    const columns = [];
    for (let column = 0; column < map.nx; column++) if (inRange(map.lon[column], zoom?.x)) columns.push(column);
    const cells = rows.length * columns.length;
    const stride = Math.max(1, Math.floor(cells / 100000));
    const kept = [];
    let min = Infinity;
    let max = -Infinity;
    let index = 0;
    for (const row of rows) {
        const base = row * map.nx;
        for (const column of columns) {
            const value = map.values[base + column];
            index += 1;
            if (!Number.isFinite(value)) continue;
            if (value < min) min = value;
            if (value > max) max = value;
            if (index % stride === 0) kept.push(value);
        }
    }
    if (!Number.isFinite(min)) return { min: NaN, max: NaN, p01: NaN, p99: NaN, steps: 1, total: 1 };
    const sorted = Float64Array.from(kept).sort();
    const quantile = q => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
    return { min, max, p01: quantile(0.01), p99: quantile(0.99), steps: 1, total: 1 };
}

function formatCoordinate(value, positive, negative) {
    if (!Number.isFinite(value)) return '?';
    const rounded = Math.round(Math.abs(value) * 100) / 100;
    return `${rounded}°${value >= 0 ? positive : negative}`;
}

function csvCell(value) {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function safeFileStem(name) {
    return String(name || 'map').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'map';
}

function treeNode(name, type = 'component', fullName = name) {
    return { _type: type, _name: name, _fullName: fullName, _children: Object.create(null), _variables: Object.create(null) };
}

export function installGriddedMethods(TargetClass) {
    const proto = TargetClass.prototype;

    proto._isGriddedCandidateExtension = function(extension) {
        return GRIDDED_EXTENSIONS.has(String(extension || '').toLowerCase());
    };

    proto._griddedState = function() {
        if (!this._gridded) this._gridded = { views: new Map(), visibleFileId: null };
        return this._gridded;
    };

    // ─── Opening ──────────────────────────────────────────────────────────

    proto._griddedContainerMessage = function(kind, fileName) {
        const keys = {
            zip: 'griddedErrorZip',
            grib: 'griddedErrorGrib',
            gzip: 'griddedErrorGzip',
            html: 'griddedErrorHtml',
            json: 'griddedErrorHtml',
            pdf: 'griddedErrorNotData',
            png: 'griddedErrorNotData',
            jpeg: 'griddedErrorNotData',
            empty: 'griddedErrorEmpty',
        };
        return i18n.t(keys[kind] || 'griddedErrorUnknown').replace('{file}', fileName || '');
    };

    proto._sniffFileHead = async function(file) {
        const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
        return sniffNetcdfContainer(head).kind;
    };

    /**
     * Load-batch step, before the loading overlay: ZIP archives are listed and
     * the chosen entries extracted; files that are not data at all are
     * reported in words; gridded files are opened (header only) so that
     * several of them can be offered as one dataset joined in time.
     */
    proto._expandNetcdfEntries = async function(entries) {
        const expanded = [];
        const opened = [];
        for (const item of entries || []) {
            const fileHandle = item?.fileHandle || null;
            let file = item?.file || (fileHandle ? null : item);
            const sourceName = file?.name || fileHandle?.name || '';
            const extension = this._fileExtension(sourceName);
            if (!this._isGriddedCandidateExtension(extension) || item?.netcdfAsSeries) {
                expanded.push(item);
                continue;
            }
            try {
                if (!file && fileHandle?.getFile) file = await fileHandle.getFile();
                if (!file) continue;
                const kind = await this._sniffFileHead(file);
                if (kind === 'zip') {
                    const listed = (await listZipEntries(file)).filter(entry => isNetcdfEntryName(entry.name));
                    if (!listed.length) {
                        // A project archive, or some other ZIP: not ours.
                        if (extension === '.zip') {
                            expanded.push(item);
                            continue;
                        }
                        await Modal.alert(i18n.t('errorLoading'), i18n.t('griddedZipNoNetcdf').replace('{file}', file.name), { icon: '🗜️' });
                        continue;
                    }
                    const members = await this._griddedPickZipEntries(file, listed);
                    if (!members) continue;
                    if (members.files.length > 1 && members.together) {
                        const options = { mode: 'merge-variables', title: this._fileBaseName(file.name) };
                        const result = await this._griddedProbe(members.files, options);
                        if (result?.gridded) {
                            opened.push({ files: members.files, result, options, title: this._fileBaseName(file.name) });
                            continue;
                        }
                    }
                    for (const member of members.files) expanded.push({ file: member, fileHandle: null, localPath: '' });
                    continue;
                }
                if (!GRIDDED_READABLE_KINDS.has(kind)) {
                    if (extension === '.zip') {
                        expanded.push(item);
                        continue;
                    }
                    await Modal.alert(i18n.t('errorLoading'), this._griddedContainerMessage(kind, file.name), { icon: '🌐' });
                    continue;
                }
                const result = await this._griddedProbe([file], {});
                if (result?.gridded) {
                    opened.push({ files: [file], result, title: this._fileBaseName(file.name), fileHandle, localPath: item?.localPath || '' });
                    continue;
                }
                expanded.push({ ...(item?.file || item?.fileHandle ? item : {}), file, fileHandle, netcdfProbed: true });
            } catch (error) {
                console.error('Error opening netCDF file:', error);
                await Modal.alert(i18n.t('errorLoading'), this._griddedErrorText(error, file?.name || sourceName), { icon: '🌐' });
            }
        }
        const joined = await this._griddedOfferJoin(opened);
        for (const group of joined) expanded.push({ griddedOpen: group, file: group.files[0], fileHandle: group.fileHandle || null, localPath: group.localPath || '' });
        return expanded;
    };

    proto._griddedErrorText = function(error, fileName) {
        if (error?.containerKind) return this._griddedContainerMessage(error.containerKind, fileName);
        if (error?.code === 'GRIDDED_INCOMPATIBLE') return `${i18n.t('griddedErrorIncompatible')}\n\n${error.message}`;
        if (error?.code === 'ZIP_DAMAGED') return i18n.t('griddedErrorZipDamaged').replace('{file}', fileName || '');
        if (error?.code === 'GRIB_UNSUPPORTED') return `${i18n.t('griddedErrorGribUnsupported').replace('{file}', fileName || '')}\n\n${error.message}`;
        return error?.message || String(error);
    };

    /** Opens the files in the gridded worker; returns null when it cannot be used. */
    proto._griddedProbe = async function(files, options) {
        const datasetId = nextDatasetId();
        const result = await griddedClient().open(datasetId, files, options);
        return { ...result, datasetId };
    };

    proto._griddedPickZipEntries = async function(file, entries) {
        let chosen = entries;
        let together = false;
        if (entries.length > 1) {
            const body = document.createElement('label');
            body.className = 'gridded-zip-together';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            body.append(checkbox, document.createTextNode(` ${i18n.t('griddedZipTogether')}`));
            const picked = await Modal.checklist(i18n.t('griddedZipMessage').replace('{file}', file.name), {
                title: i18n.t('griddedZipTitle'),
                icon: '🗜️',
                className: 'modal-dialog-gridded-zip',
                confirmText: i18n.t('griddedZipOpen'),
                bodyElement: body,
                items: entries.map((entry, index) => ({
                    value: String(index),
                    label: entry.name,
                    note: this._formatBytes(entry.size),
                    checked: true,
                })),
            });
            if (!picked?.length) return null;
            chosen = picked.map(value => entries[Number(value)]);
            together = checkbox.checked && chosen.length > 1;
        }
        this._showFileLoadingOverlay?.(1);
        this._updateFileLoadingOverlay?.(1, 1, file.name, file.size);
        await this._waitForNextPaint?.();
        try {
            const files = [];
            for (const entry of chosen) files.push(await extractZipEntry(file, entry));
            return { files, together };
        } finally {
            this._hideFileLoadingOverlay?.();
        }
    };

    // Several gridded files picked together that hold the same variables on
    // the same grid are usually consecutive downloads (one per month): offer
    // to read them as one dataset along time.
    proto._griddedOfferJoin = async function(opened) {
        if (opened.length < 2) return opened;
        const signature = result => {
            const model = result.model;
            const vars = model.variables.filter(variable => variable.mapable).map(variable => `${variable.key}:${variable.dimNames.filter(name => model.axes[name]?.role !== 't').map(name => `${name}=${model.axes[name]?.size}`).join(',')}`);
            return `${model.primaryTimeDim}|${vars.sort().join(';')}`;
        };
        const first = signature(opened[0].result);
        if (!opened[0].result.model.primaryTimeDim || !opened.every(group => signature(group.result) === first)) return opened;
        const join = await Modal.confirm(i18n.t('griddedJoinMessage').replace('{count}', String(opened.length)), {
            title: i18n.t('griddedJoinTitle'),
            icon: '🌐',
            confirmText: i18n.t('griddedJoinYes'),
            cancelText: i18n.t('griddedJoinNo'),
        });
        if (!join) return opened;
        const files = opened.flatMap(group => group.files);
        try {
            const options = { mode: 'concat-time', title: `${opened[0].title} (+${opened.length - 1})` };
            const result = await this._griddedProbe(files, options);
            for (const group of opened) griddedClient().close(group.result.datasetId);
            return [{ files, result, options, title: options.title }];
        } catch (error) {
            await Modal.alert(i18n.t('errorLoading'), this._griddedErrorText(error, ''), { icon: '🌐' });
            return opened;
        }
    };

    /**
     * Called from loadFile for netCDF-like files that did not come through a
     * load batch (a project being restored, a reload). Returns the registered
     * dataset, or null when the file is not a grid and the series reader
     * should take it.
     */
    proto._maybeOpenGridded = async function(file, extension, options = {}) {
        if (options.netcdfAsSeries || options.netcdfProbed || !this._isGriddedCandidateExtension(extension)) return null;
        if (options.griddedOpen) return this._registerGriddedDataset(options.griddedOpen, options);
        // A session being restored hands back every file of the dataset and
        // the way they were joined (several months along time, the entries of
        // a CDS ZIP as one dataset), so it opens as the one dataset it was.
        if (options.griddedFiles?.length) {
            const files = options.griddedFiles;
            const openOptions = options.griddedOptions || {};
            const result = await this._griddedProbe(files, openOptions);
            if (!result?.gridded) {
                griddedClient().close(result?.datasetId);
                return null;
            }
            return this._registerGriddedDataset({
                files,
                result,
                options: openOptions,
                title: options.griddedTitle || openOptions.title || this._fileBaseName(files[0].name),
            }, options);
        }
        const kind = await this._sniffFileHead(file);
        if (!GRIDDED_READABLE_KINDS.has(kind)) {
            if (extension === '.zip') return null;
            throw Object.assign(new Error(this._griddedContainerMessage(kind, file.name)), { containerKind: kind });
        }
        const result = await this._griddedProbe([file], {});
        if (!result?.gridded) return null;
        return this._registerGriddedDataset({ files: [file], result, title: this._fileBaseName(file.name) }, options);
    };

    proto._griddedTimeAbscissa = function(model) {
        const axis = model.primaryTimeDim ? model.axes[model.primaryTimeDim] : null;
        if (!axis) {
            return {
                name: 'index', displayName: 'index', data: Float64Array.of(0), kind: 'abscissa',
                timeKind: 'index', timeStepMode: 'index', dataType: 'numeric', isConstant: true,
                interpolation: 'linear', negate: false, source: 'netcdf-gridded',
                description: i18n.t('griddedNoTimeAxis'),
            };
        }
        const datetime = axis.kind === 'datetime';
        return {
            // Named after the file's own time coordinate: it is what the
            // explorer writes under the time axis.
            name: axis.name,
            displayName: axis.name,
            data: Float64Array.from(axis.values),
            kind: 'abscissa',
            timeKind: datetime ? 'datetime' : 'numeric',
            timeDisplayMode: datetime ? 'calendar' : undefined,
            timeOriginMs: datetime ? axis.values[0] : undefined,
            timeSourceStrategy: 'netcdf-cf-time',
            dataType: 'numeric',
            isConstant: axis.values.length < 2,
            interpolation: 'linear',
            negate: false,
            source: 'netcdf-gridded',
            units: datetime ? '' : (axis.unitsLabel || axis.units || ''),
            description: `netCDF coordinate ${axis.name}${axis.unitsLabel ? ` (${axis.unitsLabel})` : ''}`,
        };
    };

    proto._griddedBuildData = function(model, title) {
        const abscissa = this._griddedTimeAbscissa(model);
        const tree = treeNode('', 'root');
        tree._variables[abscissa.displayName] = abscissa;
        const extractions = treeNode(i18n.t('griddedExtractionsNode'));
        extractions._griddedExtractions = true;
        tree._children[extractions._name] = extractions;
        const datasetNode = treeNode(i18n.t('griddedDatasetVariablesNode'), 'metadata');
        for (const variable of model.variables.filter(item => item.mapable)) {
            const shape = variable.dimNames.map((name, index) => `${name}=${variable.shape[index]}`).join(', ');
            // How big the field is, which the shape alone does not say at a
            // glance: 744 × 721 × 1440 is 772 million values.
            const size = i18n.t('griddedVariableValues')
                .replace('{count}', variable.shape.reduce((total, length) => total * (length || 0), 1).toLocaleString());
            datasetNode._variables[variable.name] = {
                name: `grid:@var/${encodeURIComponent(variable.key)}`,
                displayName: variable.name,
                data: [shape],
                description: `${variable.longName || variable.name}${variable.units ? ` [${variable.units}]` : ''} — ${shape} · ${size}`,
                kind: 'parameter', dataType: 'string', isConstant: true, interpolation: 'constant',
                negate: false, source: 'netcdf-gridded', plottable: false,
            };
        }
        tree._children[datasetNode._name] = datasetNode;
        const attrs = Object.entries(model.globalAttrs || {});
        if (attrs.length) {
            const metadataNode = treeNode(i18n.t('griddedFileMetadataNode'), 'metadata');
            for (const [name, value] of attrs) {
                metadataNode._variables[name] = {
                    name: `grid:@global/${encodeURIComponent(name)}`, displayName: name, data: [value],
                    description: `Global netCDF attribute ${name}`, kind: 'parameter',
                    dataType: typeof value === 'string' ? 'string' : 'numeric', isConstant: true,
                    interpolation: 'constant', negate: false, source: 'netcdf-gridded', plottable: false,
                };
            }
            tree._children[metadataNode._name] = metadataNode;
        }
        const values = abscissa.data;
        return {
            filename: title,
            metadata: {
                format: 'gridded-netcdf',
                source: 'netcdf-gridded',
                gridded: true,
                storageFormat: model.members.map(member => member.storageFormat).join(', '),
                timeName: abscissa.name,
                timeKind: abscissa.timeKind,
                timeDisplayMode: abscissa.timeDisplayMode,
                timeOriginMs: abscissa.timeOriginMs,
                sampleCount: values.length,
                numVariables: 0,
                numParams: 0,
                numTimevarying: 0,
                numTimesteps: values.length,
                timeStart: values[0],
                timeEnd: values[values.length - 1],
                globalAttributes: model.globalAttrs || {},
            },
            variables: { [abscissa.name]: abscissa },
            tree,
        };
    };

    /**
     * The model as this side shows it: units with their powers as
     * superscripts ("m s**-1" → "m s⁻¹"). The file's own spelling stays in
     * `unitsRaw`. Time axes keep theirs, which is a CF reference, not a unit.
     */
    proto._griddedDisplayUnits = function(model) {
        for (const variable of model?.variables || []) {
            if (variable.unitsRaw !== undefined) continue;
            variable.unitsRaw = variable.units || '';
            variable.units = formatUnitPowers(variable.units || '');
        }
        for (const axis of Object.values(model?.axes || {})) {
            if (axis.role === 't' || axis.unitsRaw !== undefined) continue;
            axis.unitsRaw = axis.units || '';
            axis.units = formatUnitPowers(axis.units || '');
        }
        return model;
    };

    proto._registerGriddedDataset = function(group, options = {}) {
        const { result } = group;
        const model = this._griddedDisplayUnits(result.model);
        const fileId = `f${this._nextFileId++}`;
        const baseName = group.title || this._fileBaseName(group.files[0]?.name || 'dataset.nc');
        const data = this._griddedBuildData(model, baseName);
        const transform = this._defaultFileTransform();
        const firstFile = group.files[0];
        this.files.set(fileId, {
            file: group.files.length === 1 ? firstFile : null,
            fileHandle: group.files.length === 1 ? (options.fileHandle || group.fileHandle || null) : null,
            localPath: group.files.length === 1 ? (options.localPath || group.localPath || '') : '',
            temporaryParquetPath: '',
            buffer: null,
            contentHash: firstFile ? this._fileFingerprint(firstFile) : '',
            name: baseName,
            extension: this._fileExtension(firstFile?.name || '.nc'),
            transform,
            excel: null,
            matlab: null,
            gridded: { datasetId: result.datasetId, files: group.files, model, options: group.options || {} },
        });
        this.plotManager.addFile(fileId, baseName, data, transform, { deferRebuild: options.deferPlotRebuild === true });
        const state = this._griddedState();
        state.views.set(fileId, this._griddedInitialView(fileId, result.datasetId, model));
        if (!options.deferUi) {
            document.getElementById('drop-zone')?.classList.remove('active');
            this._updateTopBar();
            this._renderFilesList();
            this._clearVariableSelection();
            this.renderVariablesTree(data.tree);
            this._updateActionButtons();
            this._showGriddedView(fileId);
        }
        return { fileId, data, gridded: true };
    };

    proto._griddedInitialView = function(fileId, datasetId, model) {
        const mapable = model.variables.filter(variable => variable.mapable);
        // The variable with the most dimensions first: a pressure-level field
        // over its surface companions, and never `number` or `expver`.
        const first = [...mapable].sort((a, b) => b.dimNames.length - a.dimNames.length)[0] || null;
        return {
            fileId,
            datasetId,
            model,
            variableKey: first?.key || null,
            selection: {},
            palette: 'Viridis',
            // The colour scale stays fixed while the time slider moves, so a
            // colour means the same value at every step. It is fitted to the
            // whole period (a sample of steps) when the variable or the level
            // changes; "follow" re-fits it to every step instead.
            scale: { range: null, stats: null, source: 'sample', robust: false, symmetric: false, follow: false },
            // 'navigate', 'point' or 'region' (the panel's three buttons).
            // Navigate first: a click must not place anything before the
            // user has picked a tool.
            mode: 'navigate',
            // The value at a point: the nearest grid cell, or bilinear
            // interpolation between the four around it.
            pointMethod: 'nearest',
            pendingPoint: null,
            pendingBox: null,
            // The point or box picked on the map: { kind: 'pending-point' |
            // 'pending-box' } or { kind: 'group', id }.
            selected: null,
            groups: [],
            resultsHidden: (() => {
                try { return localStorage.getItem('omv.gridded.resultsHidden') === '1'; } catch { return false; }
            })(),
            groupCount: 0,
            playing: false,
            speed: 2,
            map: null,
            zoom: null,
            requestedMap: null,
            mapInFlight: false,
            job: null,
            extractionCount: 0,
        };
    };

    /**
     * Reload a gridded dataset: open the file again (its latest version when
     * the app can reach it) and rebuild the dataset. Extractions are dropped —
     * they were cut from the data that just changed.
     */
    proto._griddedReload = async function(fileId) {
        const entry = this.files.get(fileId);
        if (!entry?.gridded) return false;
        let files = entry.gridded.files;
        try {
            if (files.length === 1 && entry.fileHandle?.getFile) files = [await entry.fileHandle.getFile()];
            else if (files.length === 1 && entry.localPath && this.capabilities?.isDesktop) files = [await this._readLocalResultPath(entry.localPath)];
        } catch (error) {
            console.warn('[netcdf] could not read the latest version, reopening the one in hand:', error?.message || error);
        }
        this._showFileLoadingOverlay?.(1);
        this._updateFileLoadingOverlay?.(1, 1, this._fileDisplayName(entry), files[0]?.size);
        let result;
        try {
            result = await this._griddedProbe(files, entry.gridded.options || {});
        } catch (error) {
            await Modal.alert(i18n.t('errorLoading'), this._griddedErrorText(error, files[0]?.name || ''), { icon: '🌐' });
            return true;
        } finally {
            this._hideFileLoadingOverlay?.();
        }
        if (!result?.gridded) {
            griddedClient().close(result?.datasetId);
            await Modal.alert(i18n.t('errorLoading'), i18n.t('griddedErrorUnknown').replace('{file}', files[0]?.name || ''), { icon: '🌐' });
            return true;
        }
        const state = this._griddedState();
        const previous = state.views.get(fileId);
        if (previous) {
            previous.playing = false;
            griddedClient().close(previous.datasetId);
        }
        this._griddedDisplayUnits(result.model);
        entry.gridded = { ...entry.gridded, datasetId: result.datasetId, files, model: result.model };
        entry.file = files.length === 1 ? files[0] : entry.file;
        entry.contentHash = files[0] ? this._fileFingerprint(files[0]) : '';
        const data = this._griddedBuildData(result.model, entry.name);
        this.plotManager.updateFileData(fileId, data);
        const view = this._griddedInitialView(fileId, result.datasetId, result.model);
        if (previous && result.model.variables.some(variable => variable.mapable && variable.key === previous.variableKey)) {
            view.variableKey = previous.variableKey;
            view.palette = previous.palette;
            for (const [name, index] of Object.entries(previous.selection)) {
                if (index < (result.model.axes[name]?.size || 0)) view.selection[name] = index;
            }
        }
        state.views.set(fileId, view);
        if (this.plotManager.activeFileId === fileId) this.renderVariablesTree(data.tree);
        if (state.visibleFileId === fileId) this._showGriddedView(fileId);
        return true;
    };

    proto._griddedReleaseFile = function(fileId) {
        const state = this._griddedState();
        const view = state.views.get(fileId);
        if (!view) return;
        view.playing = false;
        if (view.job) griddedClient().cancel(view.job.id);
        griddedClient().close(view.datasetId);
        state.views.delete(fileId);
        if (state.visibleFileId === fileId) this._hideGriddedView();
    };

    // ─── The view ─────────────────────────────────────────────────────────
    //
    // Layout, left to right: the map (with its time bar and, when there are
    // extractions, their preview below it) and the analysis panel. The panel
    // reads top to bottom as the workflow: choose a tool, set a point or a box
    // (by clicking/drawing or by typing coordinates), compute, then work with
    // the extracted series. Nothing is computed until the user asks.

    proto._griddedEnsureDom = function() {
        let root = document.getElementById('gridded-view');
        if (root) return root;
        root = document.createElement('section');
        root.id = 'gridded-view';
        root.className = 'gridded-view';
        root.hidden = true;
        root.innerHTML = `
            <div class="gridded-toolbar">
                <div class="gridded-title" data-role="title"></div>
                <label class="gridded-field"><span data-role="variable-label"></span><select data-role="variable"></select></label>
                <span class="gridded-dims" data-role="dims"></span>
                <span class="gridded-field gridded-scale">
                    <span class="gridded-autofit">
                        <button type="button" data-action="autofit-menu" aria-haspopup="true" aria-expanded="false"><span data-role="autofit-label"></span> ▾</button>
                        <div class="gridded-menu" data-role="autofit-menu" hidden>
                            <div class="gridded-menu-range" data-role="range-row">
                                <span data-role="range-label"></span>
                                <input type="number" step="any" data-role="range-min">
                                <span aria-hidden="true">–</span>
                                <input type="number" step="any" data-role="range-max">
                            </div>
                            <label class="gridded-menu-palette"><span data-role="palette-label"></span><select data-role="palette"></select></label>
                            <hr>
                            <div class="gridded-menu-title" data-role="autofit-title"></div>
                            <button type="button" data-autofit="sample"></button>
                            <button type="button" data-autofit="all"></button>
                            <button type="button" data-autofit="step"></button>
                            <button type="button" data-autofit="visible"></button>
                            <hr>
                            <label><input type="checkbox" data-scale-option="robust"><span data-role="opt-robust"></span></label>
                            <label><input type="checkbox" data-scale-option="symmetric"><span data-role="opt-symmetric"></span></label>
                            <label><input type="checkbox" data-scale-option="follow"><span data-role="opt-follow"></span></label>
                            <p class="gridded-menu-note" data-role="scale-source"></p>
                        </div>
                    </span>
                </span>
                <span class="gridded-toolbar-end">
                    <button type="button" class="gridded-icon-btn" data-action="export-map">${EXPORT_ICON}</button>
                    <button type="button" class="gridded-close" data-action="close"></button>
                </span>
            </div>
            <div class="gridded-main">
                <div class="gridded-map-column">
                    <div class="gridded-body">
                        <div class="gridded-map" data-role="map"></div>
                        <button type="button" class="gridded-primary gridded-map-action" data-action="map-extract" hidden></button>
                    </div>
                    <div class="gridded-status" data-role="status" aria-live="polite"></div>
                    <div class="gridded-timebar" data-role="timebar">
                        <button type="button" class="gridded-step" data-step="first">${STEP_ICONS.first}</button>
                        <button type="button" class="gridded-step" data-step="prev">${STEP_ICONS.prev}</button>
                        <button type="button" class="gridded-step gridded-play" data-step="play">${STEP_ICONS.play}</button>
                        <button type="button" class="gridded-step" data-step="next">${STEP_ICONS.next}</button>
                        <button type="button" class="gridded-step" data-step="last">${STEP_ICONS.last}</button>
                        <input type="range" min="0" max="0" step="1" value="0" data-role="time">
                        <span class="gridded-time-label" data-role="time-label"></span>
                        <select data-role="speed" class="gridded-speed"></select>
                    </div>
                    <div class="gridded-progress" data-role="progress" hidden>
                        <span data-role="progress-label"></span>
                        <progress max="1" value="0" data-role="progress-bar"></progress>
                        <button type="button" data-action="cancel"></button>
                    </div>
                    <div class="gridded-splitter" data-role="splitter" role="separator" aria-orientation="horizontal" tabindex="0" hidden></div>
                    <div class="gridded-preview" data-role="preview" hidden>
                        <div class="gridded-preview-head" data-role="preview-title"></div>
                        <div class="gridded-preview-chart" data-role="preview-chart"></div>
                    </div>
                </div>
                <aside class="gridded-panel" data-role="panel">
                    <section class="gridded-panel-section gridded-inspector" data-role="inspector">
                        <h3 data-role="inspector-heading"></h3>
                        <div class="gridded-inspector-rows">
                            <span data-role="inspector-at-label"></span><span data-role="inspector-at">—</span>
                            <span data-role="inspector-cell-label"></span><span data-role="inspector-cell">—</span>
                            <span data-role="inspector-value-label"></span><span data-role="inspector-value">—</span>
                            <span data-role="inspector-when-label"></span><span data-role="inspector-when">—</span>
                        </div>
                        <button type="button" class="gridded-inspector-copy" data-action="copy-inspector"></button>
                    </section>
                    <section class="gridded-panel-section">
                        <h3 class="gridded-tools-heading"><span data-role="tools-heading"></span><button type="button" class="fft-help-btn gridded-help-btn" data-action="methods-help">?</button></h3>
                        <div class="gridded-modes" role="radiogroup" data-role="modes">
                            <button type="button" class="gridded-mode" data-mode="navigate"></button>
                            <button type="button" class="gridded-mode" data-mode="point"></button>
                            <button type="button" class="gridded-mode" data-mode="region"></button>
                        </div>
                        <p class="gridded-help" data-role="mode-help"></p>
                        <div class="gridded-form" data-form="point" hidden>
                            <div class="gridded-coords gridded-coords-point">
                                <label><span data-role="lat-label"></span><input type="number" step="any" min="-90" max="90" data-input="lat"></label>
                                <label><span data-role="lon-label"></span><input type="number" step="any" min="-180" max="360" data-input="lon"></label>
                            </div>
                            <label class="gridded-point-method">
                                <span data-role="point-method-label"></span>
                                <select data-role="point-method">
                                    <option value="nearest"></option>
                                    <option value="bilinear"></option>
                                </select>
                            </label>
                            <div class="gridded-form-actions">
                                <button type="button" class="gridded-primary" data-action="extract-point"></button>
                                <button type="button" data-action="clear-point"></button>
                            </div>
                        </div>
                        <div class="gridded-form" data-form="region" hidden>
                            <div class="gridded-coords gridded-coords-box">
                                <label class="gridded-north"><span data-role="north-label"></span><input type="number" step="any" min="-90" max="90" data-input="north"></label>
                                <label class="gridded-west"><span data-role="west-label"></span><input type="number" step="any" min="-180" max="360" data-input="west"></label>
                                <label class="gridded-east"><span data-role="east-label"></span><input type="number" step="any" min="-180" max="360" data-input="east"></label>
                                <label class="gridded-south"><span data-role="south-label"></span><input type="number" step="any" min="-90" max="90" data-input="south"></label>
                            </div>
                            <div class="gridded-form-actions">
                                <button type="button" class="gridded-primary" data-action="extract-region"></button>
                                <button type="button" data-action="clear-region"></button>
                            </div>
                        </div>
                        <div class="gridded-levels" data-role="levels-row" hidden>
                            <span data-role="levels-label"></span>
                            <span class="gridded-levels-picker">
                                <button type="button" data-action="levels-menu" aria-haspopup="true" aria-expanded="false"><span data-role="levels-summary"></span> ▾</button>
                                <div class="gridded-menu gridded-levels-menu" data-role="levels-menu" hidden>
                                    <div class="gridded-menu-actions">
                                        <button type="button" data-action="levels-map"></button>
                                        <button type="button" data-action="levels-all"></button>
                                    </div>
                                    <div class="gridded-levels-list" data-role="levels-list"></div>
                                </div>
                            </span>
                        </div>
                        <p class="gridded-scope" data-role="scope"></p>
                    </section>
                    <section class="gridded-panel-section gridded-results">
                        <div class="gridded-results-head">
                            <h3 data-role="results-heading"></h3>
                            <button type="button" class="gridded-results-toggle" data-action="toggle-results" aria-expanded="true"></button>
                            <span class="gridded-results-tools">
                                <button type="button" class="gridded-icon-btn" data-action="remove-all">${TRASH_ICON}</button>
                                <button type="button" class="gridded-icon-btn" data-action="export-series">${EXPORT_ICON}</button>
                            </span>
                        </div>
                        <div class="gridded-results-body" data-role="results-body">
                            <p class="gridded-help" data-role="results-empty"></p>
                            <ul class="gridded-results-list" data-role="results"></ul>
                            <button type="button" class="gridded-primary gridded-plot-btn" data-action="plot"></button>
                            <p class="gridded-help" data-role="plot-help"></p>
                        </div>
                    </section>
                </aside>
            </div>`;
        const host = document.querySelector('.content-area') || document.body;
        host.appendChild(root);
        this._griddedBindDom(root);
        // The map shares the column with the preview, which comes and goes:
        // Plotly only follows window resizes on its own.
        if (typeof ResizeObserver === 'function') {
            const observer = new ResizeObserver(entries => {
                for (const entry of entries) {
                    if (entry.target._fullLayout && entry.contentRect.width > 0 && entry.contentRect.height > 0) {
                        Plotly.Plots.resize(entry.target);
                        // Turned to or from a phone's width: the colour bar
                        // and the margins change sides, the height its fit.
                        const view = entry.target.dataset.role === 'map' && this._griddedVisibleView();
                        const narrow = this._griddedNarrowMap(entry.target);
                        if (view) this._griddedFitPhoneHeight(view, entry.target);
                        if (view && narrow !== entry.target._griddedNarrow) {
                            entry.target._griddedNarrow = narrow;
                            this._griddedSyncMode(view);
                            this._griddedDrawMap(view);
                        }
                    }
                }
            });
            observer.observe(root.querySelector('[data-role="map"]'));
            observer.observe(root.querySelector('[data-role="preview-chart"]'));
        }
        this._griddedRefreshTexts();
        return root;
    };

    proto._griddedEl = function(role) {
        return document.querySelector(`#gridded-view [data-role="${role}"]`);
    };

    proto._griddedInput = function(name) {
        return document.querySelector(`#gridded-view [data-input="${name}"]`);
    };

    proto._griddedVisibleView = function() {
        const state = this._griddedState();
        return state.visibleFileId ? state.views.get(state.visibleFileId) || null : null;
    };

    proto._griddedBindDom = function(root) {
        const view = () => this._griddedVisibleView();
        root.querySelector('[data-role="variable"]').addEventListener('change', event => {
            const current = view();
            if (!current) return;
            current.variableKey = event.target.value;
            // Another variable may have other levels, or none.
            current.extractLevels = null;
            current.zoom = null;
            this._griddedRenderControls(current);
            this._griddedRequestMap(current);
            this._griddedRefitScale(current);
        });
        root.querySelector('[data-role="palette"]').addEventListener('change', event => {
            const current = view();
            if (!current) return;
            current.palette = event.target.value;
            this._griddedDrawMap(current);
        });
        // Typing a bound makes the scale manual; it stays until re-fitted.
        for (const role of ['range-min', 'range-max']) {
            root.querySelector(`[data-role="${role}"]`).addEventListener('change', () => {
                const current = view();
                if (!current) return;
                const min = Number(this._griddedEl('range-min').value);
                const max = Number(this._griddedEl('range-max').value);
                if (Number.isFinite(min) && Number.isFinite(max) && max > min) {
                    current.scale.range = [min, max];
                    current.scale.source = 'manual';
                    current.scale.follow = false;
                    this._griddedSyncScale(current);
                    this._griddedDrawMap(current);
                }
            });
        }
        const menu = root.querySelector('[data-role="autofit-menu"]');
        const menuButton = root.querySelector('[data-action="autofit-menu"]');
        const closeMenu = () => {
            menu.hidden = true;
            menuButton.setAttribute('aria-expanded', 'false');
        };
        menuButton.addEventListener('click', event => {
            event.stopPropagation();
            menu.hidden = !menu.hidden;
            menuButton.setAttribute('aria-expanded', String(!menu.hidden));
            if (!menu.hidden) keepOnScreen(menu);
        });
        document.addEventListener('click', event => {
            if (!menu.hidden && !event.target.closest('.gridded-autofit')) closeMenu();
        });
        menu.addEventListener('keydown', event => {
            if (event.key === 'Escape') { closeMenu(); menuButton.focus(); }
        });
        menu.querySelectorAll('[data-autofit]').forEach(button => {
            button.addEventListener('click', () => {
                const current = view();
                closeMenu();
                if (current) this._griddedAutofit(current, button.dataset.autofit);
            });
        });
        menu.querySelectorAll('[data-scale-option]').forEach(input => {
            input.addEventListener('change', () => {
                const current = view();
                if (!current) return;
                current.scale[input.dataset.scaleOption] = input.checked;
                if (input.dataset.scaleOption === 'follow' && !input.checked && !current.scale.range) {
                    this._griddedAutofit(current, 'sample');
                    return;
                }
                if (current.scale.stats && current.scale.source !== 'manual') current.scale.range = this._griddedRangeFromStats(current.scale);
                this._griddedSyncScale(current);
                this._griddedDrawMap(current);
            });
        });
        root.querySelector('[data-role="point-method"]').addEventListener('change', event => {
            const current = view();
            if (!current) return;
            current.pointMethod = event.target.value === 'bilinear' ? 'bilinear' : 'nearest';
            // The outline under the ring shows the cells the new method reads.
            if (current.pendingPoint) this._griddedDrawMap(current);
        });
        // The levels an extraction reads: the map's by default, or any set
        // of them, all read together.
        const levelsMenu = root.querySelector('[data-role="levels-menu"]');
        const levelsButton = root.querySelector('[data-action="levels-menu"]');
        const closeLevels = () => {
            levelsMenu.hidden = true;
            levelsButton.setAttribute('aria-expanded', 'false');
        };
        levelsButton.addEventListener('click', event => {
            event.stopPropagation();
            levelsMenu.hidden = !levelsMenu.hidden;
            levelsButton.setAttribute('aria-expanded', String(!levelsMenu.hidden));
            if (!levelsMenu.hidden) keepOnScreen(levelsMenu);
        });
        document.addEventListener('click', event => {
            if (!levelsMenu.hidden && !event.target.closest('.gridded-levels-picker')) closeLevels();
        });
        levelsMenu.addEventListener('keydown', event => {
            if (event.key === 'Escape') { closeLevels(); levelsButton.focus(); }
        });
        const setLevels = levels => {
            const current = view();
            if (!current) return;
            current.extractLevels = levels && levels.length ? levels : null;
            this._griddedSyncScope(current);
        };
        levelsMenu.querySelector('[data-action="levels-map"]').addEventListener('click', () => setLevels(null));
        levelsMenu.querySelector('[data-action="levels-all"]').addEventListener('click', () => {
            const current = view();
            const level = current && this._griddedLevelAxis(current, this._griddedVariable(current));
            if (level) setLevels(Array.from({ length: level.axis.size }, (_, index) => index));
        });
        levelsMenu.querySelector('[data-role="levels-list"]').addEventListener('change', () => {
            setLevels([...levelsMenu.querySelectorAll('[data-level]:checked')].map(input => Number(input.dataset.level)));
        });
        this._griddedBindSplitter(root);
        root.querySelectorAll('.gridded-mode').forEach(button => {
            button.addEventListener('click', () => {
                const current = view();
                if (current) this._griddedSetMode(current, button.dataset.mode);
            });
        });
        // Typing coordinates moves the marker or the box as the numbers change;
        // nothing is read from the file until the action button is pressed.
        root.querySelectorAll('[data-input]').forEach(input => {
            input.addEventListener('input', () => {
                const current = view();
                if (!current) return;
                if (input.dataset.input === 'lat' || input.dataset.input === 'lon') current.pendingPoint = this._griddedReadPointInputs();
                else current.pendingBox = this._griddedReadBoxInputs();
                this._griddedSyncActions(current);
                this._griddedDrawOverlaysSoon(current);
            });
            input.addEventListener('keydown', event => {
                if (event.key !== 'Enter') return;
                const current = view();
                if (!current) return;
                if (input.dataset.input === 'lat' || input.dataset.input === 'lon') this._griddedExtractPoint(current);
                else this._griddedExtractRegion(current);
            });
        });
        root.querySelector('[data-role="time"]').addEventListener('input', event => {
            const current = view();
            if (!current) return;
            const dim = this._griddedTimeDim(current);
            if (!dim) return;
            const next = Number(event.target.value);
            current.stepDirection = next < (current.selection[dim] || 0) ? -1 : 1;
            current.selection[dim] = next;
            this._griddedSyncTimeLabel(current);
            this._griddedRequestMap(current);
        });
        root.querySelectorAll('.gridded-step').forEach(button => {
            button.addEventListener('click', () => this._griddedStep(button.dataset.step));
        });
        root.querySelector('[data-role="speed"]').addEventListener('change', event => {
            const current = view();
            if (current) current.speed = Number(event.target.value) || 2;
        });
        root.querySelector('[data-role="results"]').addEventListener('change', event => {
            const current = view();
            const id = event.target.closest('[data-group]')?.dataset.group;
            const setId = event.target.closest('[data-set]')?.dataset.set;
            if (!current || !id || !setId) return;
            const set = current.groups.find(item => item.id === id)?.sets.find(item => item.id === setId);
            if (set) set.checked = event.target.checked;
            this._griddedSyncActions(current);
            this._griddedDrawPreview(current);
        });
        root.addEventListener('click', event => {
            const target = event.target.closest('[data-action]');
            const action = target?.dataset.action;
            if (!action) return;
            const current = view();
            if (action === 'close') {
                // Closed on purpose: no button over the plots asks to come back.
                this._griddedState().returnFileId = null;
                this._hideGriddedView();
            }
            else if (!current) return;
            else if (action === 'cancel' && current.job) griddedClient().cancel(current.job.id);
            else if (action === 'extract-point') this._griddedExtractPoint(current);
            else if (action === 'extract-region') this._griddedExtractRegion(current);
            else if (action === 'map-extract') {
                if (target.dataset.kind === 'point') this._griddedExtractPoint(current);
                else if (target.dataset.kind === 'region') this._griddedExtractRegion(current);
            }
            else if (action === 'clear-point') this._griddedClearPending(current, 'point');
            else if (action === 'clear-region') this._griddedClearPending(current, 'region');
            else if (action === 'remove-group') this._griddedRemoveGroup(current, target.closest('[data-group]')?.dataset.group);
            else if (action === 'remove-set') this._griddedRemoveSet(current, target.closest('[data-group]')?.dataset.group, target.closest('[data-set]')?.dataset.set);
            else if (action === 'reuse-group') this._griddedReusePlace(current, target.closest('[data-group]')?.dataset.group);
            else if (action === 'remove-all') this._griddedRemoveAll(current);
            else if (action === 'toggle-results') this._griddedToggleResults(current);
            else if (action === 'methods-help') this._griddedShowMethodsHelp();
            else if (action === 'export-map') this._griddedExportMap(current);
            else if (action === 'export-series') this._griddedExportSeries(current);
            else if (action === 'plot') this._griddedPlotChecked(current);
            else if (action === 'copy-inspector') this._griddedCopyInspector(current);
        });
        // A row of the list selects its point or box on the map; the
        // checkbox and the ✕ keep their own jobs.
        root.querySelector('[data-role="results"]').addEventListener('click', event => {
            if (event.target.closest('input, [data-action]')) return;
            const current = view();
            const id = event.target.closest('[data-group]')?.dataset.group;
            if (current && id) this._griddedSelect(current, { kind: 'group', id });
        });
        // Delete removes the selected point or box, Escape lets go of it. On
        // the document: a click on the map leaves the focus on the page.
        document.addEventListener('keydown', event => {
            const current = view();
            if (!current?.selected || root.hidden || document.querySelector('.modal-overlay')) return;
            if (event.target.closest?.('input, select, textarea, [contenteditable="true"], .modal-overlay')) return;
            if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                this._griddedDeleteSelected(current);
            } else if (event.key === 'Escape') {
                this._griddedSelect(current, null);
            }
        });
        root.addEventListener('keydown', event => {
            if (event.target.closest('input, select, textarea')) return;
            if (event.key === 'ArrowRight') { this._griddedStep('next'); event.preventDefault(); }
            else if (event.key === 'ArrowLeft') { this._griddedStep('prev'); event.preventDefault(); }
            else if (event.key === ' ' && !event.target.closest('button')) { this._griddedStep('play'); event.preventDefault(); }
        });
    };

    // The boundary between the map and the preview is dragged with the mouse
    // (or moved with the arrow keys); double-click goes back to the default.
    // The height is a per-viewer convenience kept in localStorage.
    proto._griddedBindSplitter = function(root) {
        const splitter = root.querySelector('[data-role="splitter"]');
        const preview = root.querySelector('[data-role="preview"]');
        const column = root.querySelector('.gridded-map-column');
        const storageKey = 'omv.gridded.previewHeight';
        const apply = height => {
            const max = Math.max(120, column.clientHeight - 220);
            const clamped = Math.round(Math.max(90, Math.min(max, height)));
            preview.style.height = `${clamped}px`;
            splitter.setAttribute('aria-valuenow', String(clamped));
            return clamped;
        };
        try {
            const saved = Number(localStorage.getItem(storageKey));
            if (saved > 0) preview.style.height = `${saved}px`;
        } catch { /* storage unavailable: default height */ }
        const save = height => {
            try { localStorage.setItem(storageKey, String(height)); } catch { /* ignore */ }
        };
        splitter.addEventListener('pointerdown', event => {
            event.preventDefault();
            splitter.setPointerCapture(event.pointerId);
            splitter.classList.add('dragging');
            const bottom = preview.getBoundingClientRect().bottom;
            const move = moveEvent => apply(bottom - moveEvent.clientY);
            const up = () => {
                splitter.classList.remove('dragging');
                splitter.removeEventListener('pointermove', move);
                splitter.removeEventListener('pointerup', up);
                splitter.removeEventListener('pointercancel', up);
                save(preview.getBoundingClientRect().height);
            };
            splitter.addEventListener('pointermove', move);
            splitter.addEventListener('pointerup', up);
            splitter.addEventListener('pointercancel', up);
        });
        splitter.addEventListener('dblclick', () => {
            preview.style.height = '';
            try { localStorage.removeItem(storageKey); } catch { /* ignore */ }
        });
        splitter.addEventListener('keydown', event => {
            if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
            event.preventDefault();
            const height = preview.getBoundingClientRect().height + (event.key === 'ArrowUp' ? 24 : -24);
            save(apply(height));
        });
    };

    proto._griddedRefreshTexts = function() {
        const root = document.getElementById('gridded-view');
        if (!root) return;
        const set = (selector, key, attr = 'textContent') => {
            const element = root.querySelector(selector);
            if (element) element[attr] = i18n.t(key);
        };
        set('[data-role="variable-label"]', 'griddedVariable');
        set('[data-role="palette-label"]', 'griddedPalette');
        set('[data-role="range-label"]', 'griddedRangeEnds');
        set('[data-role="range-row"]', 'griddedColorRangeTitle', 'title');
        set('[data-role="range-min"]', 'griddedColorRangeTitle', 'title');
        set('[data-role="range-max"]', 'griddedColorRangeTitle', 'title');
        set('.gridded-menu-palette', 'griddedPaletteTitle', 'title');
        set('[data-role="autofit-title"]', 'griddedAutofitTitle', 'title');
        set('[data-autofit="sample"]', 'griddedAutofitSampleTitle', 'title');
        set('[data-autofit="all"]', 'griddedAutofitAllTitle', 'title');
        set('[data-autofit="step"]', 'griddedAutofitStepTitle', 'title');
        set('[data-autofit="visible"]', 'griddedAutofitVisibleTitle', 'title');
        root.querySelectorAll('[data-scale-option]').forEach(input => {
            const key = { robust: 'griddedScaleRobustTitle', symmetric: 'griddedScaleSymmetricTitle', follow: 'griddedScaleFollowTitle' }[input.dataset.scaleOption];
            if (key) input.closest('label').title = i18n.t(key);
        });
        set('[data-role="range-min"]', 'griddedRangeMin', 'ariaLabel');
        set('[data-role="range-max"]', 'griddedRangeMax', 'ariaLabel');
        set('[data-role="autofit-label"]', 'griddedColorRange');
        set('[data-action="autofit-menu"]', 'griddedAutofitTitle', 'title');
        set('[data-role="autofit-title"]', 'griddedAutofitMenuTitle');
        set('[data-autofit="sample"]', 'griddedAutofitSample');
        set('[data-autofit="all"]', 'griddedAutofitAll');
        set('[data-autofit="step"]', 'griddedAutofitStep');
        set('[data-autofit="visible"]', 'griddedAutofitVisible');
        set('[data-role="opt-robust"]', 'griddedScaleRobust');
        set('[data-role="opt-symmetric"]', 'griddedScaleSymmetric');
        set('[data-role="opt-follow"]', 'griddedScaleFollow');
        set('[data-role="splitter"]', 'griddedSplitterTitle', 'title');
        set('[data-role="splitter"]', 'griddedSplitterTitle', 'ariaLabel');
        set('[data-action="export-map"]', 'griddedExportMapTitle', 'title');
        set('[data-action="export-map"]', 'griddedExportMapTitle', 'ariaLabel');
        set('[data-action="close"]', 'griddedCloseMap');
        set('[data-action="close"]', 'griddedCloseMapTitle', 'title');
        set('[data-action="cancel"]', 'griddedCancel');
        set('[data-role="inspector-heading"]', 'griddedInspector');
        set('[data-role="inspector"]', 'griddedInspectorTitle', 'title');
        set('[data-role="inspector-at-label"]', 'griddedInspectorAt');
        set('[data-role="inspector-cell-label"]', 'griddedInspectorCell');
        set('[data-role="inspector-value-label"]', 'griddedInspectorValue');
        set('[data-role="inspector-when-label"]', 'griddedInspectorWhen');
        set('[data-action="copy-inspector"]', 'griddedInspectorCopy');
        set('[data-action="copy-inspector"]', 'griddedInspectorCopyTitle', 'title');
        set('[data-role="tools-heading"]', 'griddedToolsHeading');
        set('[data-action="methods-help"]', 'griddedMethodsHelp', 'title');
        set('[data-action="methods-help"]', 'griddedMethodsHelp', 'ariaLabel');
        set('[data-role="point-method-label"]', 'griddedPointMethod');
        set('[data-role="point-method"] option[value="nearest"]', 'griddedPointNearest');
        set('[data-role="point-method"] option[value="bilinear"]', 'griddedPointBilinear');
        set('[data-mode="navigate"]', 'griddedModeNavigate');
        set('[data-mode="point"]', 'griddedModePoint');
        set('[data-mode="region"]', 'griddedModeRegion');
        set('[data-role="lat-label"]', 'griddedLatitude');
        set('[data-role="lon-label"]', 'griddedLongitude');
        set('[data-role="north-label"]', 'griddedNorth');
        set('[data-role="south-label"]', 'griddedSouth');
        set('[data-role="west-label"]', 'griddedWest');
        set('[data-role="east-label"]', 'griddedEast');
        set('[data-action="extract-point"]', 'griddedExtractPoint');
        set('[data-action="extract-region"]', 'griddedExtractRegion');
        set('[data-action="clear-point"]', 'griddedClearPoint');
        set('[data-action="clear-region"]', 'griddedClearBox');
        set('[data-role="results-heading"]', 'griddedResultsHeading');
        if (this._griddedVisibleView()) this._griddedSyncResultsToggle(this._griddedVisibleView());
        set('[data-role="results-empty"]', 'griddedResultsEmpty');
        set('[data-action="remove-all"]', 'griddedRemoveAll', 'title');
        set('[data-action="remove-all"]', 'griddedRemoveAll', 'ariaLabel');
        set('[data-action="export-series"]', 'griddedExportSeriesTitle', 'title');
        set('[data-action="export-series"]', 'griddedExportSeriesTitle', 'ariaLabel');
        set('[data-action="plot"]', 'griddedPlotChecked');
        set('[data-role="plot-help"]', 'griddedPlotHelp');
        set('[data-step="first"]', 'griddedFirstStep', 'title');
        set('[data-step="prev"]', 'griddedPrevStep', 'title');
        set('[data-step="play"]', 'griddedPlay', 'title');
        set('[data-step="next"]', 'griddedNextStep', 'title');
        set('[data-step="last"]', 'griddedLastStep', 'title');
        set('[data-role="speed"]', 'griddedSpeed', 'title');
        const palette = root.querySelector('[data-role="palette"]');
        palette.innerHTML = '';
        for (const name of PALETTES) palette.add(new Option(name, name));
        const speed = root.querySelector('[data-role="speed"]');
        speed.innerHTML = '';
        for (const value of PLAY_SPEEDS) speed.add(new Option(i18n.t('griddedSpeedValue').replace('{fps}', String(value)), String(value)));
        const view = this._griddedVisibleView();
        if (view) {
            this._griddedRenderControls(view);
            this._griddedDrawMap(view);
            this._griddedDrawPreview(view);
        }
    };

    proto._showGriddedView = function(fileId) {
        const state = this._griddedState();
        const view = state.views.get(fileId);
        if (!view) return;
        const root = this._griddedEnsureDom();
        if (state.visibleFileId && state.visibleFileId !== fileId) {
            const previous = state.views.get(state.visibleFileId);
            if (previous) previous.playing = false;
        }
        state.visibleFileId = fileId;
        state.returnFileId = null;
        root.hidden = false;
        document.body.classList.add('gridded-view-open');
        if (this.plotManager.activeFileId !== fileId) this.setActiveFile(fileId);
        this._griddedRenderControls(view);
        this._griddedDrawPreview(view);
        if (view.map) this._griddedDrawMap(view);
        else this._griddedRequestMap(view);
        if (!view.scale.range && !view.scale.follow && !view.scaleToken) this._griddedAutofit(view, 'sample');
        this._renderFilesList();
    };

    proto._hideGriddedView = function() {
        const state = this._griddedState();
        const view = this._griddedVisibleView();
        if (view) view.playing = false;
        this._griddedCloseMenu();
        state.visibleFileId = null;
        const root = document.getElementById('gridded-view');
        if (root) root.hidden = true;
        document.body.classList.remove('gridded-view-open');
        this._renderFilesList();
        setTimeout(() => this.plotManager.resizeAll?.(), 30);
    };

    proto._griddedVariable = function(view) {
        return view.model.variables.find(variable => variable.key === view.variableKey) || null;
    };

    proto._griddedTimeDim = function(view) {
        return this._griddedVariable(view)?.timeDim || null;
    };

    proto._griddedRenderControls = function(view) {
        const root = document.getElementById('gridded-view');
        if (!root) return;
        const model = view.model;
        const title = root.querySelector('[data-role="title"]');
        title.textContent = this.files.get(view.fileId)?.name || model.title;
        title.title = model.members.map(member => `${member.filename} (${member.storageFormat})`).join('\n');
        const select = root.querySelector('[data-role="variable"]');
        select.innerHTML = '';
        for (const variable of model.variables.filter(item => item.mapable)) {
            const label = `${variable.name}${variable.longName && variable.longName !== variable.name ? ` — ${variable.longName}` : ''}${variable.units ? ` [${variable.units}]` : ''}`;
            select.add(new Option(label, variable.key));
        }
        select.value = view.variableKey || '';
        const variable = this._griddedVariable(view);
        const dims = root.querySelector('[data-role="dims"]');
        dims.innerHTML = '';
        if (variable) {
            variable.dimNames.forEach((name, index) => {
                const role = variable.roles[index];
                if (role === 'y' || role === 'x' || role === 't') return;
                const axis = model.axes[name];
                if (!axis || axis.size < 2) return;
                const wrap = document.createElement('label');
                wrap.className = 'gridded-field';
                const caption = document.createElement('span');
                caption.textContent = role === 'z' ? i18n.t('griddedLevel') : name;
                const dimSelect = document.createElement('select');
                dimSelect.dataset.dim = name;
                axis.labels.forEach((labelText, position) => {
                    dimSelect.add(new Option(`${labelText}${role === 'z' && axis.units ? ` ${axis.units}` : ''}`, String(position)));
                });
                dimSelect.value = String(view.selection[name] || 0);
                dimSelect.addEventListener('change', () => {
                    view.selection[name] = Number(dimSelect.value);
                    this._griddedSyncScope(view);
                    this._griddedRequestMap(view);
                    this._griddedRefitScale(view);
                });
                wrap.append(caption, dimSelect);
                dims.appendChild(wrap);
            });
        }
        root.querySelector('[data-role="palette"]').value = view.palette;
        this._griddedSyncScale(view);
        root.querySelector('[data-role="speed"]').value = String(view.speed);
        const timeDim = variable?.timeDim;
        const timebar = root.querySelector('[data-role="timebar"]');
        const slider = root.querySelector('[data-role="time"]');
        const size = timeDim ? model.axes[timeDim]?.size || 1 : 1;
        timebar.classList.toggle('gridded-timebar-static', !timeDim || size < 2);
        slider.max = String(Math.max(0, size - 1));
        slider.value = String(timeDim ? view.selection[timeDim] || 0 : 0);
        slider.disabled = !timeDim || size < 2;
        this._griddedSyncTimeLabel(view);
        this._griddedSyncMode(view);
        this._griddedSyncInputs(view);
        this._griddedSyncScope(view);
        this._griddedSyncInspector(view);
        this._griddedRenderResults(view);
    };

    // What an extraction will use, said before it runs: the variable, the
    // level (or other dimensions) chosen in the toolbar, and every time step.
    proto._griddedSyncScope = function(view) {
        const element = this._griddedEl('scope');
        const variable = this._griddedVariable(view);
        if (!element || !variable) return;
        this._griddedSyncLevels(view, variable);
        const level = this._griddedLevelAxis(view, variable);
        const levels = this._griddedExtractionLevels(view, variable);
        let fixed = this._griddedSelectionSuffix(view, variable).replace(/^ @ /, '');
        if (level && levels.length > 1) {
            // Other dimensions as chosen in the toolbar; the levels as chosen here.
            const others = fixed.split(', ').filter(part => part !== this._griddedLevelLabel(level.axis, Number(view.selection[level.name]) || 0));
            fixed = [this._griddedLevelsSummary(view, level, levels), ...others].filter(Boolean).join(', ');
        }
        const steps = variable.timeDim ? view.model.axes[variable.timeDim]?.size || 1 : 1;
        element.textContent = i18n.t('griddedScope')
            .replace('{variable}', variable.name)
            .replace('{level}', fixed ? ` · ${fixed}` : '')
            .replace('{steps}', String(steps));
    };

    proto._griddedLevelsSummary = function(view, level, levels) {
        if (levels.length === level.axis.size) return i18n.t('griddedLevelsAllCount').replace('{count}', String(levels.length));
        if (levels.length <= 3) return levels.map(index => this._griddedLevelLabel(level.axis, index)).join(', ');
        return i18n.t('griddedLevelsCount').replace('{count}', String(levels.length));
    };

    /** The levels row of the panel: shown for a variable with levels, in the point and region tools. */
    proto._griddedSyncLevels = function(view, variable = this._griddedVariable(view)) {
        const row = this._griddedEl('levels-row');
        if (!row) return;
        const level = this._griddedLevelAxis(view, variable);
        row.hidden = !level || view.mode === 'navigate';
        if (!level) return;
        const levels = this._griddedExtractionLevels(view, variable);
        const mapLevel = Number(view.selection[level.name]) || 0;
        const following = !(view.extractLevels || []).length;
        this._griddedEl('levels-label').textContent = i18n.t('griddedLevels');
        row.title = i18n.t('griddedLevelsTitle');
        this._griddedEl('levels-summary').textContent = following
            ? i18n.t('griddedLevelsMap').replace('{level}', this._griddedLevelLabel(level.axis, mapLevel))
            : this._griddedLevelsSummary(view, level, levels);
        const menu = this._griddedEl('levels-menu');
        menu.querySelector('[data-action="levels-map"]').textContent = i18n.t('griddedLevelsMapOnly');
        menu.querySelector('[data-action="levels-all"]').textContent = i18n.t('griddedLevelsAll');
        const list = this._griddedEl('levels-list');
        const chosen = new Set(levels);
        list.innerHTML = '';
        for (let index = 0; index < level.axis.size; index++) {
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.dataset.level = String(index);
            input.checked = chosen.has(index);
            const text = document.createElement('span');
            text.textContent = this._griddedLevelLabel(level.axis, index) + (index === mapLevel ? ` ${i18n.t('griddedLevelsOnMap')}` : '');
            label.append(input, text);
            list.appendChild(label);
        }
    };

    proto._griddedSyncTimeLabel = function(view) {
        const dim = this._griddedTimeDim(view);
        const label = this._griddedEl('time-label');
        const play = document.querySelector('#gridded-view [data-step="play"]');
        if (play) {
            const icon = view.playing ? 'pause' : 'play';
            if (play.dataset.icon !== icon) {
                play.innerHTML = STEP_ICONS[icon];
                play.dataset.icon = icon;
            }
            play.title = i18n.t(view.playing ? 'griddedPause' : 'griddedPlay');
        }
        if (!label) return;
        if (!dim) {
            label.textContent = i18n.t('griddedNoTimeAxis');
            return;
        }
        const axis = view.model.axes[dim];
        const index = view.selection[dim] || 0;
        label.textContent = `${axis.labels[index] ?? index}  (${index + 1}/${axis.size})`;
    };

    /**
     * The inspector (§4.4): the cell under the pointer, said exactly — where
     * it is, which cell of the grid it is, what it holds, and the step and
     * level the map is showing. The reading stays when the pointer leaves the
     * map, so "Copy" can still take it; it is copied as one line.
     */
    proto._griddedInspect = function(view, at) {
        const map = view.map;
        if (!map || !Number.isFinite(at?.lat) || !Number.isFinite(at?.lon)) return null;
        const nearest = (values, target) => {
            let best = 0;
            let distance = Infinity;
            for (let index = 0; index < values.length; index++) {
                const away = Math.abs(values[index] - target);
                if (away < distance) { distance = away; best = index; }
            }
            return best;
        };
        // Half a cell beyond the edge of the grid there is nothing to read:
        // the map shows the geography around the data too.
        const half = (values, index) => (values.length < 2
            ? Infinity
            : Math.abs(values[index === 0 ? 1 : index - 1] - values[index]) / 2);
        const row = nearest(map.lat, at.lat);
        const column = nearest(map.lon, at.lon);
        const inside = Math.abs(map.lat[row] - at.lat) <= half(map.lat, row) + 1e-9
            && Math.abs(map.lon[column] - at.lon) <= half(map.lon, column) + 1e-9;
        // The cell, not the value: the value is read from the map on screen,
        // so the reading follows the step while the slider runs.
        view.inspect = inside ? { row, column, lat: map.lat[row], lon: map.lon[column] } : null;
        this._griddedSyncInspector(view);
        return view.inspect;
    };

    /** The inspector's four lines, and the text "Copy" puts on the clipboard. */
    proto._griddedInspectorText = function(view) {
        const variable = this._griddedVariable(view);
        const reading = view.inspect;
        const axisName = role => {
            const index = variable ? variable.roles.indexOf(role) : -1;
            return index >= 0 ? variable.dimNames[index] : role;
        };
        const map = view.map;
        const cell = reading && map && reading.row < map.ny && reading.column < map.nx
            ? map.values[reading.row * map.nx + reading.column]
            : NaN;
        const value = Number.isFinite(cell) ? String(Number(cell.toPrecision(6))) : null;
        return {
            at: reading ? `${formatCoordinate(reading.lat, 'N', 'S')} ${formatCoordinate(reading.lon, 'E', 'W')}` : '',
            cell: reading ? `${axisName('y')}[${reading.row}], ${axisName('x')}[${reading.column}]` : '',
            value: reading
                ? (value === null
                    ? i18n.t('griddedInspectorNoData')
                    : `${value}${variable?.units ? ` ${variable.units}` : ''}`)
                : '',
            when: this._griddedDimsLabel(view),
            name: variable?.name || '',
        };
    };

    proto._griddedSyncInspector = function(view) {
        const section = this._griddedEl('inspector');
        if (!section) return;
        const text = this._griddedInspectorText(view);
        const write = (role, value) => {
            const element = this._griddedEl(role);
            if (element) element.textContent = value || '—';
        };
        write('inspector-at', text.at);
        write('inspector-cell', text.cell);
        write('inspector-value', text.value);
        write('inspector-when', text.when);
        const copy = section.querySelector('[data-action="copy-inspector"]');
        if (copy) copy.disabled = !view.inspect;
    };

    proto._griddedCopyInspector = async function(view) {
        if (!view?.inspect) return;
        const text = this._griddedInspectorText(view);
        const line = [text.when, text.at, `${text.name}${text.name ? ' = ' : ''}${text.value}`]
            .filter(Boolean).join(' · ');
        const copied = await copyTextToClipboard(line);
        this._griddedSetStatus(copied ? i18n.t('griddedInspectorCopied').replace('{text}', line) : i18n.t('griddedInspectorCopyFailed'), !copied);
    };

    proto._griddedSetMode = function(view, mode) {
        view.mode = mode;
        this._griddedSyncMode(view);
        const div = this._griddedEl('map');
        this._griddedDeactivateShape(div);
        if (div?._fullLayout) Plotly.relayout(div, { dragmode: mode === 'region' ? 'drawrect' : 'pan' });
        // A series is coming: on a large dataset the helper workers start
        // and open the files now, while the point or the box is placed.
        if (mode === 'point' || mode === 'region') griddedClient().prepareParallel(view.datasetId);
    };

    proto._griddedSyncMode = function(view) {
        const root = document.getElementById('gridded-view');
        if (!root) return;
        root.querySelectorAll('.gridded-mode').forEach(button => {
            const active = button.dataset.mode === view.mode;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        root.querySelector('[data-form="point"]').hidden = view.mode !== 'point';
        root.querySelector('[data-form="region"]').hidden = view.mode !== 'region';
        const map = root.querySelector('[data-role="map"]');
        map.classList.toggle('gridded-cursor-navigate', view.mode === 'navigate');
        map.classList.toggle('gridded-cursor-point', view.mode === 'point');
        map.classList.toggle('gridded-cursor-region', view.mode === 'region');
        this._griddedSyncLevels(view);
        // A finger has no right button, Delete key or wheel: on a phone or a
        // tablet the help says what to do with it instead.
        const touch = document.documentElement.classList.contains('compact') || !!window.matchMedia?.('(pointer: coarse)').matches;
        const help = { navigate: 'griddedHelpNavigate', point: 'griddedHelpPoint', region: 'griddedHelpRegion' }[view.mode] || 'griddedHelpNavigate';
        this._griddedEl('mode-help').textContent = i18n.t(touch ? `${help}Touch` : help);
        this._griddedSyncActions(view);
    };

    proto._griddedSyncInputs = function(view) {
        const set = (name, value) => {
            const input = this._griddedInput(name);
            if (input && document.activeElement !== input) input.value = Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : '';
        };
        set('lat', view.pendingPoint?.lat);
        set('lon', view.pendingPoint?.lon);
        const method = this._griddedEl('point-method');
        if (method) method.value = view.pointMethod === 'bilinear' ? 'bilinear' : 'nearest';
        set('north', view.pendingBox?.latMax);
        set('south', view.pendingBox?.latMin);
        set('west', view.pendingBox?.lonMin);
        set('east', view.pendingBox?.lonMax);
        this._griddedSyncActions(view);
    };

    proto._griddedReadPointInputs = function() {
        const lat = Number(this._griddedInput('lat')?.value);
        const lon = Number(this._griddedInput('lon')?.value);
        const filled = this._griddedInput('lat')?.value !== '' && this._griddedInput('lon')?.value !== '';
        if (!filled || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) return null;
        return { lat, lon };
    };

    proto._griddedReadBoxInputs = function() {
        const values = ['north', 'south', 'west', 'east'].map(name => {
            const input = this._griddedInput(name);
            return input?.value === '' ? NaN : Number(input?.value);
        });
        const [north, south, west, east] = values;
        if (!values.every(Number.isFinite) || north <= south || Math.abs(north) > 90 || Math.abs(south) > 90 || west === east) return null;
        // West > east is a box across the antimeridian, as in the CDS form.
        return { latMax: north, latMin: south, lonMin: west, lonMax: east };
    };

    proto._griddedSyncActions = function(view) {
        const root = document.getElementById('gridded-view');
        if (!root) return;
        const busy = !!view.job;
        root.querySelector('[data-action="extract-point"]').disabled = busy || !view.pendingPoint;
        root.querySelector('[data-action="extract-region"]').disabled = busy || !view.pendingBox;
        root.querySelector('[data-action="clear-point"]').disabled = !view.pendingPoint;
        root.querySelector('[data-action="clear-region"]').disabled = !view.pendingBox;
        const checked = (view.groups || []).flatMap(group => group.sets).filter(set => set.checked).length;
        root.querySelector('[data-action="plot"]').disabled = !checked;
        root.querySelector('[data-action="export-series"]').disabled = !(view.groups || []).length;
        root.querySelector('[data-action="remove-all"]').disabled = !(view.groups || []).length;
        this._griddedSyncMapAction(view);
    };

    /**
     * On a phone the extract button of the panel is a scroll away from the
     * map: once a point or a box is placed, the same action floats over the
     * map (gridded.css shows it in the compact layout only).
     */
    proto._griddedSyncMapAction = function(view) {
        const button = document.querySelector('#gridded-view [data-action="map-extract"]');
        if (!button) return;
        const kind = view.mode === 'point' && view.pendingPoint ? 'point'
            : view.mode === 'region' && view.pendingBox ? 'region' : null;
        button.hidden = !kind;
        button.dataset.kind = kind || '';
        button.disabled = !!view.job;
        if (kind) button.textContent = i18n.t(kind === 'point' ? 'griddedExtractPoint' : 'griddedExtractRegion');
    };

    proto._griddedClearPending = function(view, kind) {
        if (kind === 'point') view.pendingPoint = null;
        else view.pendingBox = null;
        if (view.selected?.kind === (kind === 'point' ? 'pending-point' : 'pending-box')) view.selected = null;
        this._griddedSyncInputs(view);
        this._griddedBackToNavigate(view);
        this._griddedDrawMap(view);
    };

    proto._griddedSetStatus = function(text, isError = false) {
        const status = this._griddedEl('status');
        if (!status) return;
        status.textContent = text || '';
        status.classList.toggle('error', !!isError);
    };

    proto._griddedStep = function(step) {
        const view = this._griddedVisibleView();
        const dim = view ? this._griddedTimeDim(view) : null;
        if (!view || !dim) return;
        const size = view.model.axes[dim].size;
        const current = view.selection[dim] || 0;
        if (step === 'play') {
            view.playing = !view.playing;
            this._griddedSyncTimeLabel(view);
            if (view.playing) this._griddedPlayLoop(view);
            return;
        }
        const next = step === 'first' ? 0 : step === 'last' ? size - 1
            : step === 'next' ? Math.min(size - 1, current + 1) : Math.max(0, current - 1);
        if (next === current) return;
        view.stepDirection = next < current ? -1 : 1;
        view.selection[dim] = next;
        this._griddedEl('time').value = String(next);
        this._griddedSyncTimeLabel(view);
        this._griddedRequestMap(view);
    };

    proto._griddedPlayLoop = async function(view) {
        const dim = this._griddedTimeDim(view);
        while (view.playing && dim && this._griddedVisibleView() === view) {
            const started = performance.now();
            const size = view.model.axes[dim].size;
            view.stepDirection = 1;
            view.selection[dim] = ((view.selection[dim] || 0) + 1) % size;
            const slider = this._griddedEl('time');
            if (slider) slider.value = String(view.selection[dim]);
            this._griddedSyncTimeLabel(view);
            await this._griddedRequestMap(view);
            const wait = 1000 / Math.max(1, view.speed) - (performance.now() - started);
            if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        }
        view.playing = false;
        this._griddedSyncTimeLabel(view);
    };

    // Maps already read, by variable and selection, newest last: stepping
    // back and forth, or a loop played again, costs no read. Bounded by
    // bytes, so a global 0.25° grid keeps a dozen and a regional one more.
    const MAP_CACHE_BYTES = 64 * 1024 * 1024;

    // The dataset is in the key: a view reopened on new files reads anew.
    // An index left out is 0, so `{}` and `{ valid_time: 0 }` are one map.
    const mapKey = (view, request) => JSON.stringify([view.datasetId, request.variable,
        Object.entries(request.selection || {}).filter(([, index]) => Number(index) !== 0).sort()]);

    proto._griddedCachedMap = function(view, request) {
        const cache = view.mapCache;
        const key = mapKey(view, request);
        const map = cache?.get(key);
        if (!map) return null;
        cache.delete(key);
        cache.set(key, map);
        return map;
    };

    proto._griddedRememberMap = function(view, request, map) {
        if (!view.mapCache) view.mapCache = new Map();
        const cache = view.mapCache;
        cache.set(mapKey(view, request), map);
        let bytes = 0;
        for (const item of cache.values()) bytes += item.values?.byteLength || 0;
        for (const [key, item] of cache) {
            if (bytes <= MAP_CACHE_BYTES || cache.size <= 2) break;
            bytes -= item.values?.byteLength || 0;
            cache.delete(key);
        }
    };

    proto._griddedFetchMap = async function(view, request) {
        const key = mapKey(view, request);
        // The step read ahead may still be on its way: wait for it rather
        // than read it a second time.
        if (view.prefetch?.key === key) {
            const map = await view.prefetch.promise.catch(() => null);
            if (map) return map;
        }
        const map = await griddedClient().request('map', { datasetId: view.datasetId, ...request }).promise;
        this._griddedRememberMap(view, request, map);
        return map;
    };

    /**
     * Reads the next time step ahead, in the direction the slider or the
     * player last moved, while the one on screen is looked at: the next
     * step then only has to be drawn. Not while a series is being read,
     * which has the worker's attention.
     */
    proto._griddedPrefetchNext = function(view, request) {
        const dim = this._griddedTimeDim(view);
        if (!dim || view.job || !request?.variable) return;
        const size = view.model.axes[dim]?.size || 0;
        const current = Number(request.selection?.[dim]) || 0;
        let next = current + (view.stepDirection || 1);
        if (view.playing) next = ((next % size) + size) % size;
        if (next < 0 || next >= size || next === current) return;
        const ahead = { variable: request.variable, selection: { ...request.selection, [dim]: next } };
        const key = mapKey(view, ahead);
        if (view.mapCache?.has(key) || view.prefetch?.key === key) return;
        const promise = griddedClient().request('map', { datasetId: view.datasetId, ...ahead }).promise.then(map => {
            this._griddedRememberMap(view, ahead, map);
            return map;
        });
        view.prefetch = { key, promise };
        promise.catch(() => null).finally(() => {
            if (view.prefetch?.key === key) view.prefetch = null;
        });
    };

    // Requests coalesce: while a map is being read, only the latest selection
    // is remembered, so dragging the slider never queues a backlog.
    proto._griddedRequestMap = function(view) {
        view.requestedMap = { variable: view.variableKey, selection: { ...view.selection } };
        if (view.mapInFlight) return view.mapInFlight;
        view.mapInFlight = (async () => {
            try {
                while (view.requestedMap) {
                    const request = view.requestedMap;
                    view.requestedMap = null;
                    if (!request.variable) break;
                    try {
                        const map = this._griddedCachedMap(view, request)
                            || await this._griddedFetchMap(view, request);
                        view.map = map;
                        view.mapFor = request;
                        // The next step is read while this one is drawn.
                        if (!view.requestedMap) this._griddedPrefetchNext(view, request);
                        if (view.scale.follow || !view.scale.range) this._griddedSyncScale(view);
                        if (this._griddedVisibleView() === view) await this._griddedDrawMap(view);
                    } catch (error) {
                        this._griddedSetStatus(this._griddedErrorText(error, ''), true);
                        view.playing = false;
                        break;
                    }
                }
            } finally {
                view.mapInFlight = false;
            }
        })();
        return view.mapInFlight;
    };

    proto._griddedRangeFromStats = function(scale) {
        const stats = scale.stats;
        if (!stats || !Number.isFinite(stats.min)) return null;
        let low = scale.robust ? stats.p01 : stats.min;
        let high = scale.robust ? stats.p99 : stats.max;
        if (scale.symmetric) {
            const extent = Math.max(Math.abs(low), Math.abs(high));
            low = -extent;
            high = extent;
        }
        if (!(high > low)) return [low - 0.5, high + 0.5];
        return [low, high];
    };

    // The range the map is drawn with. Until the period's range arrives (it
    // is read in the background), the current step's own.
    proto._griddedCurrentRange = function(view) {
        const scale = view.scale;
        if (!scale.follow && scale.range) return scale.range;
        const stats = view.map ? mapStats(view.map) : null;
        return this._griddedRangeFromStats({ ...scale, stats }) || [0, 1];
    };

    proto._griddedRefitScale = function(view) {
        if (view.scale.follow) {
            this._griddedSyncScale(view);
            return;
        }
        view.scale.range = null;
        view.scale.stats = null;
        this._griddedAutofit(view, 'sample');
    };

    /**
     * Fit the colour scale: to the whole period (a sample of steps, or every
     * step), to the step on screen, or to the part of the map in view.
     */
    proto._griddedAutofit = async function(view, source) {
        const variable = this._griddedVariable(view);
        if (!variable) return;
        let stats = null;
        if (source === 'step' || source === 'visible') {
            if (!view.map) return;
            stats = mapStats(view.map, source === 'visible' ? view.zoom : null);
        } else {
            const token = (view.scaleToken || 0) + 1;
            view.scaleToken = token;
            const selection = { ...view.selection };
            const payload = { variable: variable.key, selection, options: { scope: source === 'all' ? 'all' : 'sample' } };
            if (source === 'all') {
                stats = await this._griddedRunJob(view, 'range', payload, i18n.t('griddedReadingRange'));
            } else {
                this._griddedSetStatus(i18n.t('griddedFittingScale'));
                try {
                    stats = await griddedClient().request('range', { datasetId: view.datasetId, ...payload }).promise;
                } catch (error) {
                    this._griddedSetStatus(this._griddedErrorText(error, ''), true);
                    return;
                }
                this._griddedSetStatus('');
            }
            // A newer fit (another variable or level) has started meanwhile.
            if (!stats || token !== view.scaleToken || variable.key !== view.variableKey) return;
        }
        if (!stats || !Number.isFinite(stats.min)) return;
        view.scale.stats = stats;
        view.scale.source = source;
        view.scale.follow = false;
        view.scale.range = this._griddedRangeFromStats(view.scale);
        this._griddedSyncScale(view);
        this._griddedDrawMap(view);
    };

    proto._griddedSyncScale = function(view) {
        const root = document.getElementById('gridded-view');
        if (!root) return;
        const [low, high] = this._griddedCurrentRange(view);
        const format = value => (Number.isFinite(value) ? String(Number(value.toPrecision(5))) : '');
        for (const [role, value] of [['range-min', low], ['range-max', high]]) {
            const input = this._griddedEl(role);
            if (input && document.activeElement !== input) input.value = format(value);
            if (input) input.disabled = view.scale.follow;
        }
        root.querySelectorAll('[data-scale-option]').forEach(input => {
            input.checked = !!view.scale[input.dataset.scaleOption];
        });
        const stats = view.scale.stats;
        const key = view.scale.follow ? 'griddedScaleSourceFollow' : {
            sample: 'griddedScaleSourceSample',
            all: 'griddedScaleSourceAll',
            step: 'griddedScaleSourceStep',
            visible: 'griddedScaleSourceVisible',
            manual: 'griddedScaleSourceManual',
        }[view.scale.source] || 'griddedScaleSourceSample';
        const text = i18n.t(key)
            .replace('{steps}', String(stats?.steps ?? '…'))
            .replace('{total}', String(stats?.total ?? '…'));
        const note = this._griddedEl('scale-source');
        if (note) note.textContent = text;
        // The way the scale was set, marked in the menu: one of the fits, or
        // the two values typed by hand.
        const source = view.scale.follow ? 'follow' : view.scale.source;
        root.querySelectorAll('[data-autofit]').forEach(item => {
            const active = item.dataset.autofit === source;
            item.classList.toggle('active', active);
            item.setAttribute('aria-pressed', String(active));
        });
        root.querySelector('[data-role="range-row"]')?.classList.toggle('active', source === 'manual');
        const button = root.querySelector('[data-action="autofit-menu"]');
        if (button) {
            const range = low !== undefined && Number.isFinite(low) && Number.isFinite(high) ? `${format(low)} – ${format(high)}` : '';
            button.title = `${i18n.t('griddedAutofitTitle')}${range ? `\n${range}` : ''}\n${text}`;
        }
    };

    proto._griddedColors = function(theme = this.theme) {
        const dark = theme === 'dark';
        return {
            bg: dark ? '#2d2d2d' : '#ffffff',
            font: dark ? '#d0d0d0' : '#333333',
            grid: dark ? '#4a4a4a' : '#e3e3e3',
            coast: dark ? '#f2f2f2' : '#1a1a1a',
            border: dark ? 'rgba(240,240,240,0.55)' : 'rgba(30,30,30,0.45)',
            pending: dark ? '#ff8a65' : '#d84315',
            // Magenta: in none of the palettes, so a selection shows on any map.
            selected: '#e040fb',
        };
    };

    proto._griddedDrawOverlaysSoon = function(view) {
        clearTimeout(view.overlayTimer);
        view.overlayTimer = setTimeout(() => this._griddedDrawMap(view), 60);
    };

    /**
     * What is drawn over the map: the point and the box being set up (orange;
     * both dragged by _griddedBeginEdit) and
     * the extractions already made (in their series' colour, tagged like the
     * list). The selected extraction is drawn heavier.
     */
    proto._griddedOverlays = function(view, colors) {
        const traces = [];
        const shapes = [];
        const annotations = [];
        const annotationGroups = [];
        const selectedId = view.selected?.kind === 'group' ? view.selected.id : null;
        const points = (view.groups || []).filter(group => group.kind === 'point');
        if (points.length) {
            traces.push({
                type: 'scatter', mode: 'markers',
                x: points.map(group => group.geometry.lon), y: points.map(group => group.geometry.lat),
                marker: {
                    // A diamond for a value interpolated between cells, a
                    // circle for the value of one cell.
                    symbol: points.map(group => (group.method === 'bilinear' ? 'diamond' : 'circle')),
                    size: points.map(group => (group.id === selectedId ? 15 : 11) + (group.method === 'bilinear' ? 2 : 0)),
                    color: points.map(group => group.color),
                    line: { color: points.map(group => (group.id === selectedId ? colors.selected : '#ffffff')), width: points.map(group => (group.id === selectedId ? 3 : 2)) },
                },
                hoverinfo: 'skip', showlegend: false,
            });
        }
        for (const group of view.groups || []) {
            const selected = group.id === selectedId;
            if (group.kind === 'region') {
                const box = group.geometry;
                shapes.push({
                    type: 'rect', xref: 'x', yref: 'y', editable: false, name: `group:${group.id}`,
                    x0: box.lonMin, x1: box.lonMax, y0: box.latMin, y1: box.latMax,
                    line: { color: group.color, width: selected ? 3 : 1.5, dash: selected ? 'solid' : 'dash' },
                    fillcolor: selected ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0)',
                });
            }
            const anchor = group.kind === 'point'
                ? { x: group.geometry.lon, y: group.geometry.lat, xshift: 6, yshift: 4 }
                : { x: group.geometry.lonMin, y: group.geometry.latMax, xshift: 0, yshift: 0 };
            annotations.push({
                ...anchor, xref: 'x', yref: 'y', text: `<b>${group.tag}</b>`, showarrow: false,
                xanchor: 'left', yanchor: 'bottom', font: { color: '#ffffff', size: 11 }, bgcolor: group.color, borderpad: 2,
                bordercolor: selected ? colors.selected : group.color, borderwidth: selected ? 2 : 0,
                // Clickable, so the tag selects its extraction too.
                captureevents: true,
            });
            annotationGroups.push(group.id);
        }
        if (view.pendingBox) {
            const box = view.pendingBox;
            shapes.push({
                // Not editable for Plotly, whose resize band is a third of the
                // box on each side: moved and resized by _griddedBeginEdit.
                type: 'rect', xref: 'x', yref: 'y', editable: false, name: 'pending-box',
                x0: box.lonMin, x1: box.lonMax, y0: box.latMin, y1: box.latMax,
                line: { color: colors.pending, width: view.selected?.kind === 'pending-box' ? 3.5 : 2.5 },
                fillcolor: 'rgba(216,67,21,0.10)',
            });
        }
        // Last, so the drag below can move it with a restyle of this trace.
        // (A shape sized in pixels would drag by itself, but once one has
        // been on the map Plotly converts the next rectangle drawn wrongly.)
        if (view.pendingPoint) {
            // The cell or cells the point will be read from, under the ring.
            const stencil = pointStencil(view.map, view.pendingPoint.lat, view.pendingPoint.lon, view.pointMethod);
            if (stencil) {
                traces.push({
                    type: 'scatter', mode: stencil.corners ? 'lines+markers' : 'lines', name: 'pending-stencil',
                    x: stencil.x, y: stencil.y,
                    line: { color: colors.pending, width: 1.5, dash: 'dot' },
                    marker: { size: 6, color: colors.pending, line: { color: '#ffffff', width: 1 } },
                    hoverinfo: 'skip', showlegend: false,
                });
            }
            traces.push({
                type: 'scatter', mode: 'markers', name: 'pending-point',
                x: [view.pendingPoint.lon], y: [view.pendingPoint.lat],
                marker: {
                    symbol: 'circle-open', size: 18, color: colors.pending,
                    line: { width: view.selected?.kind === 'pending-point' ? 4.5 : 3.5 },
                },
                hoverinfo: 'skip', showlegend: false,
            });
        }
        view.annotationGroups = annotationGroups;
        return { traces, shapes, annotations };
    };

    /**
     * A narrow map (an upright phone, or a window a phone wide) gives the
     * width to the map: no axis titles, and the colour bar lies under it
     * instead of beside it. A phone on its side is short of height, not of
     * width, and keeps the bar beside the map.
     */
    proto._griddedNarrowMap = function(div) {
        return (div?.clientWidth || 800) < 600;
    };

    proto._griddedMapMargins = function(narrow) {
        return narrow ? { l: 40, r: 12, t: 26, b: 74 } : { l: 56, r: 96, t: 30, b: 44 };
    };

    /**
     * On a phone the map column is not a fixed share of the screen: the map
     * is as tall as the whole grid needs at the width of the phone (a world
     * map is half as tall as wide), within bounds, and the tools follow
     * right under it rather than below a band of empty paper.
     */
    proto._griddedFitPhoneHeight = function(view, div) {
        const body = div?.parentElement;
        if (!body) return;
        if (!document.documentElement.classList.contains('compact') || !view.map) {
            if (body.style.height) body.style.height = '';
            return;
        }
        const map = view.map;
        const half = (values, index) => (values.length > 1 ? Math.abs(values[1] - values[0]) / 2 : 0.5);
        const spanX = Math.abs(map.lon[map.lon.length - 1] - map.lon[0]) + 2 * half(map.lon);
        const spanY = Math.abs(map.lat[map.lat.length - 1] - map.lat[0]) + 2 * half(map.lat);
        const margin = this._griddedMapMargins(this._griddedNarrowMap(body));
        const width = Math.max(1, body.clientWidth - margin.l - margin.r);
        const wanted = width * Math.min(spanY / spanX, 1.4) + margin.t + margin.b;
        const height = Math.round(Math.max(240, Math.min(wanted, window.innerHeight * 0.62)));
        if (Math.abs(body.offsetHeight - height) > 2) body.style.height = `${height}px`;
    };

    proto._griddedDrawMap = async function(view, { theme = this.theme, transparent = false, target = null } = {}) {
        const div = target || this._griddedEl('map');
        const map = view.map;
        if (!div || !map || (!target && this._griddedVisibleView() !== view)) return;
        if (!target) {
            // Never redraw under a wheel or a drag: Plotly is moving the plot
            // itself, and a redraw would put back the ranges it started from.
            const wait = this._griddedInteractionWait(div);
            if (wait > 0) {
                clearTimeout(view.drawTimer);
                view.drawTimer = setTimeout(() => this._griddedDrawMap(view), wait);
                return;
            }
            clearTimeout(view.drawTimer);
            // The ranges on screen, not the ones remembered at the last event.
            if (view.zoom && div._fullLayout) view.zoom = this._griddedShownRanges(div);
        }
        if (!target) {
            this._griddedFitPhoneHeight(view, div);
            div._griddedNarrow = this._griddedNarrowMap(div);
            this._griddedSyncMapAction(view);
        }
        // An exported image is laid out for its own size, not the screen's.
        const narrow = this._griddedNarrowMap(div);
        // On a phone, even on its side, the degrees say what the axes are.
        const phone = !target && document.documentElement.classList.contains('compact');
        const variable = this._griddedVariable(view);
        const colors = this._griddedColors(theme);
        const grid = drawableGrid(map, view.zoom?.x, view.zoom?.y);
        const [zmin, zmax] = this._griddedCurrentRange(view);
        const lonMin = map.lon[0];
        const lonMax = map.lon[map.lon.length - 1];
        const coastScale = this._griddedCoastScale(view);
        const coast = await loadCoastlines(coastScale) || await loadCoastlines('coarse');
        if (!target && this._griddedVisibleView() !== view) return;
        const ranges = view.zoom || this._griddedFittedRanges(map, div);
        const coastWindow = coastlineWindow(ranges);
        const units = variable?.units ? ` ${variable.units}` : '';
        const traces = [{
            type: 'heatmap',
            x: grid.x,
            y: grid.y,
            z: grid.z,
            zmin,
            zmax,
            zauto: false,
            colorscale: view.palette,
            reversescale: view.palette === 'RdBu',
            // Title above the bar and a bounded tick format, inside a right
            // margin that is already wide enough: the bar never pushes the map
            // as its labels change from one time step to the next.
            colorbar: narrow ? {
                // Under the map, at the bottom of the figure: the map keeps
                // the whole width of a phone.
                orientation: 'h', title: { text: variable?.units || '', side: 'right', font: { size: 11 } },
                thickness: 10, len: 0.92, outlinewidth: 0, x: 0.5, xanchor: 'center',
                yref: 'container', y: 0, yanchor: 'bottom', ypad: 8,
                tickformat: '.4~g', nticks: 6, tickfont: { color: colors.font, size: 10 },
            } : {
                title: { text: variable?.units || '', side: 'top', font: { size: 11 } },
                thickness: 12, len: 0.9, outlinewidth: 0, x: 1.01, xanchor: 'left', xpad: 6,
                tickformat: '.4~g', nticks: 8, tickfont: { color: colors.font, size: 10 },
            },
            hovertemplate: `%{y:.2f}°, %{x:.2f}°<br>%{z:.5~g}${units}<extra></extra>`,
            hoverongaps: false,
        }];
        if (coast) {
            const borders = coastlineTrace(coast.borders, lonMin, lonMax, coastWindow);
            const coastline = coastlineTrace(coast.coastlines, lonMin, lonMax, coastWindow);
            // Drawn as SVG, not WebGL: the WebGL layer is one canvas over the
            // whole figure, and with `constrain: 'domain'` (which shrinks the
            // drawing area to keep a degree square) its clipping left the
            // coast a few pixels outside the axes. An SVG trace is clipped to
            // the axes by Plotly itself, on screen and in an exported image.
            // Cutting the lines to `coastWindow` is what keeps that cheap.
            traces.push({ type: 'scatter', mode: 'lines', x: borders.x, y: borders.y, line: { color: colors.border, width: 0.6 }, hoverinfo: 'skip', showlegend: false });
            traces.push({ type: 'scatter', mode: 'lines', x: coastline.x, y: coastline.y, line: { color: colors.coast, width: 1 }, hoverinfo: 'skip', showlegend: false });
        }
        // An exported image shows the extractions, not what is selected.
        const overlays = this._griddedOverlays(target ? { ...view, selected: null } : view, colors);
        traces.push(...overlays.traces);
        const paper = transparent ? 'rgba(0,0,0,0)' : colors.bg;
        const titleText = grid.stride > 1
            ? `${this._griddedMapTitle(view)}  <span style="font-size:10px;opacity:0.7">(${i18n.t('griddedDecimatedShort').replace('{stride}', String(grid.stride))})</span>`
            : this._griddedMapTitle(view);
        const layout = {
            paper_bgcolor: paper,
            plot_bgcolor: paper,
            font: { color: colors.font, size: 11, family: 'system-ui, sans-serif' },
            margin: this._griddedMapMargins(narrow),
            showlegend: false,
            dragmode: view.mode === 'region' ? 'drawrect' : 'pan',
            title: { text: titleText, font: { size: 12 }, x: 0.01, xanchor: 'left' },
            xaxis: {
                // Copies: Plotly writes into the range arrays it is given.
                range: [...ranges.x],
                title: { text: narrow || phone ? '' : i18n.t('griddedLongitude') },
                gridcolor: colors.grid,
                zeroline: false,
                ticksuffix: '°',
                // Equal degrees on both axes by shrinking the drawing area,
                // never by stretching the latitude axis past the poles.
                constrain: 'domain',
            },
            yaxis: {
                range: [...ranges.y],
                title: { text: narrow || phone ? '' : i18n.t('griddedLatitude') },
                gridcolor: colors.grid,
                zeroline: false,
                ticksuffix: '°',
                scaleanchor: 'x',
                scaleratio: 1,
                constrain: 'domain',
            },
            newshape: { line: { color: colors.pending, width: 2.5 }, fillcolor: 'rgba(216,67,21,0.10)' },
            shapes: overlays.shapes,
            annotations: overlays.annotations,
        };
        const config = {
            ...(this.plotManager._getPlotlyConfig?.() || {}),
            displayModeBar: false,
            scrollZoom: true,
            responsive: true,
            edits: { shapePosition: true },
        };
        const first = !div._fullLayout;
        if (!target) this._griddedDeactivateShape(div);
        await Plotly.react(div, traces, layout, config);
        if (target) return;
        view.drawn = { stride: grid.stride, extent: grid.extent, coastScale, coastWindow };
        this._griddedSyncInspector(view);
        if (first) this._griddedBindPlot(div);
    };

    /**
     * Plotly "activates" an editable shape that is clicked, and then treats
     * the next rectangle drawn as a new outline for that shape and the next
     * click as a mere deactivation. Selection is ours, so no shape is ever
     * left active.
     */
    proto._griddedDeactivateShape = function(div) {
        if (div?._fullLayout && div._fullLayout._activeShapeIndex !== undefined) delete div._fullLayout._activeShapeIndex;
    };

    proto._griddedShownRanges = function(div) {
        const layout = div._fullLayout;
        return { x: [...layout.xaxis.range], y: [...layout.yaxis.range] };
    };

    proto._griddedCoastScale = function(view) {
        const map = view.map;
        const span = view.zoom?.x ? Math.abs(view.zoom.x[1] - view.zoom.x[0]) : Math.abs(map.lon[map.lon.length - 1] - map.lon[0]);
        return span < FINE_COAST_SPAN_DEGREES ? 'fine' : 'coarse';
    };

    /**
     * Milliseconds until the user has stopped moving the map: a button held
     * down on it (pan, box drawing, shape editing) or a wheel turned in the
     * last moments. Plotly applies a wheel zoom 50 ms after the last notch.
     */
    proto._griddedInteractionWait = function(div) {
        const state = div._griddedInteraction;
        if (!state) return 0;
        if (state.pressed) return 150;
        return Math.max(0, state.wheelAt + 250 - Date.now());
    };

    /**
     * Whether the map on screen no longer serves the current zoom: a finer
     * or coarser coastline, a different decimation, or a pan or zoom that
     * left the part of a large grid that was drawn. A grid drawn whole at
     * full resolution needs nothing.
     */
    proto._griddedZoomNeedsRedraw = function(view) {
        const drawn = view.drawn;
        if (!drawn || !view.map) return true;
        if (this._griddedCoastScale(view) !== drawn.coastScale) return true;
        // The coastlines are cut to a window around what was drawn; a pan or
        // a zoom out of it needs them cut again.
        if (view.zoom && !insideCoastlineWindow(drawn.coastWindow, view.zoom)) return true;
        const wanted = gridWindow(view.map, view.zoom?.x, view.zoom?.y);
        if (wanted.stride !== drawn.stride) return true;
        if (!drawn.extent) return wanted.windowed;
        if (!view.zoom) return true;
        const inside = (range, extent) => Math.min(...range) >= Math.min(...extent) && Math.max(...range) <= Math.max(...extent);
        return !inside(view.zoom.x, drawn.extent.x) || !inside(view.zoom.y, drawn.extent.y);
    };

    /**
     * The view that shows the whole grid with equal degrees on both axes and
     * fills the drawing area: a long thin region (a band of latitudes) gets
     * the geography above and below it rather than a sliver of a map, and a
     * tall one gets the longitudes either side — but never past the poles or
     * round the globe a second time. What cannot be filled is left to
     * Plotly's `constrain: 'domain'`, which shrinks the drawing area instead.
     */
    proto._griddedFittedRanges = function(map, div) {
        const dx = map.lon.length > 1 ? Math.abs(map.lon[1] - map.lon[0]) / 2 : 0.5;
        const dy = map.lat.length > 1 ? Math.abs(map.lat[1] - map.lat[0]) / 2 : 0.5;
        let x = [map.lon[0] - dx, map.lon[map.lon.length - 1] + dx];
        let y = [map.lat[0] - dy, map.lat[map.lat.length - 1] + dy];
        const margin = this._griddedMapMargins(this._griddedNarrowMap(div));
        const width = Math.max(1, (div?.clientWidth || 800) - margin.l - margin.r);
        const height = Math.max(1, (div?.clientHeight || 500) - margin.t - margin.b);
        const spanX = x[1] - x[0];
        const spanY = y[1] - y[0];
        const grow = (range, span, limits) => {
            const centre = (range[0] + range[1]) / 2;
            let low = centre - span / 2;
            let high = centre + span / 2;
            if (low < limits[0]) { high += limits[0] - low; low = limits[0]; }
            if (high > limits[1]) { low -= high - limits[1]; high = limits[1]; }
            return [Math.max(limits[0], low), Math.min(limits[1], high)];
        };
        if (spanX / spanY > width / height) {
            y = grow(y, spanX * height / width, [Math.min(-90, y[0]), Math.max(90, y[1])]);
        } else {
            const limits = x[1] > 180 ? [Math.min(0, x[0]), Math.max(360, x[1])] : [Math.min(-180, x[0]), Math.max(180, x[1])];
            x = grow(x, spanY * width / height, limits);
        }
        return { x, y };
    };

    /** What the map is fixed at: the step, the level, any other dimension. */
    proto._griddedDimsLabel = function(view) {
        const variable = this._griddedVariable(view);
        if (!variable) return '';
        const parts = [];
        variable.dimNames.forEach((name, index) => {
            const role = variable.roles[index];
            if (role === 'y' || role === 'x') return;
            const axis = view.model.axes[name];
            if (!axis) return;
            const label = axis.labels[view.selection[name] || 0];
            parts.push(role === 'z' && axis.units ? `${label} ${axis.units}` : label);
        });
        return parts.join(' · ');
    };

    proto._griddedMapTitle = function(view) {
        const variable = this._griddedVariable(view);
        if (!variable) return '';
        return [variable.longName || variable.name, this._griddedDimsLabel(view)].filter(Boolean).join(' · ');
    };

    proto._griddedBindPlot = function(div) {
        const interaction = { pressed: false, wheelAt: 0 };
        div._griddedInteraction = interaction;
        // The boxes take no pointer events (gridded.css), so the wheel always
        // reaches the plot, over a box too.
        div.addEventListener('wheel', () => { interaction.wheelAt = Date.now(); }, { capture: true, passive: true });
        // Pressed, the open hand of Navigate closes (Plotly's drag cover
        // takes the cursor of the plot at the press).
        div.addEventListener('pointerdown', event => {
            interaction.pressed = true;
            if (event.button === 0) div.classList.add('gridded-pressed');
        }, { capture: true });
        const release = () => {
            interaction.pressed = false;
            div.classList.remove('gridded-pressed');
        };
        window.addEventListener('pointerup', release, { capture: true });
        window.addEventListener('pointercancel', release, { capture: true });
        div.addEventListener('pointerdown', event => {
            interaction.down = { x: event.clientX, y: event.clientY };
            if (!event.target.closest?.('.gridded-context-menu')) this._griddedCloseMenu();
        }, { capture: true });
        // The pointer says what a press would do: a hand over what can be
        // picked, the box's resize arrows over its edges.
        const overClasses = ['gridded-over-ring', 'gridded-over-item', 'gridded-over-box-move',
            ...['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(handle => `gridded-over-box-${handle}`)];
        div.addEventListener('mousemove', event => {
            const view = this._griddedVisibleView();
            const at = view && !interaction.pressed && this._griddedEventCoords(div, event);
            if (view && at) this._griddedInspect(view, at);
            let over = null;
            if (at) {
                const target = this._griddedEditTarget(view, at, 'mouse');
                if (target?.kind === 'ring') over = 'gridded-over-ring';
                else if (target?.kind === 'box') over = `gridded-over-box-${target.handle}`;
                else if (this._griddedHitTest(view, at, event, { inside: false })) over = 'gridded-over-item';
            }
            for (const name of overClasses) div.classList.toggle(name, name === over);
        });
        // The orange ring and box follow the mouse when dragged — the box
        // resized from a thin band along its edges, moved from inside. Plotly
        // starts its own pan or drawing on mousedown, so that is stopped first.
        div.addEventListener('mousedown', event => {
            const view = this._griddedVisibleView();
            if (event.button !== 0 || !view) return;
            const at = this._griddedEventCoords(div, event);
            const target = at && this._griddedEditTarget(view, at, 'mouse');
            if (!target) return;
            event.stopPropagation();
            event.preventDefault();
            const edit = this._griddedBeginEdit(view, div, target, at);
            const move = moveEvent => {
                const point = this._griddedEventCoords(div, moveEvent, { clamp: true });
                if (point) edit.move(point);
            };
            const stop = () => {
                window.removeEventListener('mousemove', move, true);
                window.removeEventListener('mouseup', stop, true);
                edit.end();
            };
            window.addEventListener('mousemove', move, true);
            window.addEventListener('mouseup', stop, true);
        }, true);
        // The same with a finger. The plot's own touch gestures (pan, pinch)
        // leave a touch that lands on the ring or the box to this.
        const touchTarget = event => {
            const view = this._griddedVisibleView();
            if (!view || event.touches?.length !== 1) return null;
            const at = this._griddedEventCoords(div, event.touches[0]);
            return at ? { view, at, target: this._griddedEditTarget(view, at, 'touch') } : null;
        };
        claimTouchGestures(div, event => !!interaction.touchEdit || !!touchTarget(event)?.target);
        div.addEventListener('touchstart', event => {
            const found = touchTarget(event);
            if (!found?.target) return;
            // Plotly must not start its own drag (in Region, a new box) under it.
            event.preventDefault();
            event.stopPropagation();
            const edit = this._griddedBeginEdit(found.view, div, found.target, found.at);
            interaction.touchEdit = edit;
            // On the window: a redraw of the shapes can take the touched
            // element out of the page, and its later events would then never
            // reach the map.
            const move = moveEvent => {
                moveEvent.preventDefault();
                const point = this._griddedEventCoords(div, moveEvent.touches[0], { clamp: true });
                if (point) edit.move(point);
            };
            const stop = () => {
                window.removeEventListener('touchmove', move, { capture: true });
                window.removeEventListener('touchend', stop, { capture: true });
                window.removeEventListener('touchcancel', stop, { capture: true });
                interaction.touchEdit = null;
                edit.end();
            };
            window.addEventListener('touchmove', move, { capture: true, passive: false });
            window.addEventListener('touchend', stop, { capture: true });
            window.addEventListener('touchcancel', stop, { capture: true });
        }, { capture: true, passive: false });
        // A finger held still on a point or a box opens its menu (extract,
        // reuse, delete), as the right button does: a phone has neither a
        // right button nor a Delete key.
        const LONG_PRESS_MS = 550;
        const endPress = () => {
            clearTimeout(interaction.longPress?.timer);
            interaction.longPress = null;
        };
        div.addEventListener('touchstart', event => {
            endPress();
            if (event.touches.length !== 1) return;
            const start = { clientX: event.touches[0].clientX, clientY: event.touches[0].clientY, target: event.target };
            interaction.longPress = {
                start,
                timer: setTimeout(() => {
                    interaction.longPress = null;
                    const view = this._griddedVisibleView();
                    const at = view && this._griddedEventCoords(div, start);
                    if (!at || !this._griddedHitTest(view, at, start, { inside: true })) return;
                    interaction.longPressedAt = Date.now();
                    this._griddedOpenMenuAt(div, start);
                }, LONG_PRESS_MS),
            };
        }, { capture: true, passive: true });
        window.addEventListener('touchmove', event => {
            const press = interaction.longPress;
            const touch = event.touches[0];
            if (press && (event.touches.length !== 1 || Math.hypot(touch.clientX - press.start.clientX, touch.clientY - press.start.clientY) > 10)) endPress();
        }, { capture: true, passive: true });
        window.addEventListener('touchend', endPress, { capture: true, passive: true });
        window.addEventListener('touchcancel', endPress, { capture: true, passive: true });
        // A click (not the end of a drag) selects what is under it; in the
        // point tool, a click on empty map places the point there. The place
        // comes from the pixel clicked, not from Plotly's hover, which lags
        // behind a quick click and is missing over cells without data.
        div.addEventListener('click', event => {
            const down = interaction.down;
            if (event.button !== 0 || (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4)) return;
            // The tap that ends a long press opened a menu: it places nothing.
            if (Date.now() - (interaction.longPressedAt || 0) < 1000) return;
            const view = this._griddedVisibleView();
            const at = view && this._griddedEventCoords(div, event);
            if (!at) return;
            const hit = this._griddedHitTest(view, at, event, { inside: false });
            if (hit) {
                this._griddedSelect(view, hit);
            } else if (view.mode === 'point' && Math.abs(at.lat) <= 90) {
                view.pendingPoint = { lat: roundCoordinate(at.lat), lon: roundCoordinate(at.lon) };
                view.selected = { kind: 'pending-point' };
                this._griddedSyncInputs(view);
                this._griddedRenderSelection(view);
                this._griddedDrawMap(view);
            } else if (view.selected) {
                this._griddedSelect(view, null);
            }
        }, true);
        // The right button drags the map, as on every plot; a right click
        // that did not drag opens the menu of the point or box under it.
        // Where the system sends the menu event at the press (Linux, macOS)
        // it waits for the release; where it sends it after (Windows) a drag
        // that just ended keeps it closed.
        bindRightDragPan(div, interaction, pan => {
            if (!pan.moved && pan.menuAt) this._griddedOpenMenuAt(div, pan.menuAt);
        });
        bindWheelPan(div);
        div.addEventListener('contextmenu', event => {
            const at = this._griddedEventCoords(div, event);
            if (!at) return;
            event.preventDefault();
            const where = { clientX: event.clientX, clientY: event.clientY, target: event.target };
            if (interaction.rightPan) {
                interaction.rightPan.menuAt = where;
                return;
            }
            if (Date.now() - (interaction.pannedAt || 0) < 400) return;
            this._griddedOpenMenuAt(div, where);
        }, true);
        div.on('plotly_relayout', update => {
            const view = this._griddedVisibleView();
            if (!view || !update || view.editing) return;
            const keys = Object.keys(update);
            if (update.shapes) {
                // A box just drawn: the one shape without a name.
                const drawn = (div.layout.shapes || []).filter(shape => !shape.name).pop();
                if (drawn) this._griddedSetPendingBox(view, drawn);
                else this._griddedDrawOverlaysSoon(view);
                return;
            }
            const edited = keys.map(key => /^shapes\[(\d+)\]/.exec(key)).find(Boolean);
            if (edited) {
                const shape = (div.layout.shapes || [])[Number(edited[1])];
                // No shape is editable in Plotly's sense (the box is moved
                // here); whatever changed, put it back.
                this._griddedDrawOverlaysSoon(view);
                return;
            }
            if (update['xaxis.autorange']) {
                view.zoom = null;
            } else if (update.autosize) {
                // A resize keeps the zoom; only the whole-map framing depends
                // on the size of the plot.
                if (view.zoom) return;
            } else if (update['xaxis.range[0]'] !== undefined || update['yaxis.range[0]'] !== undefined
                || update['xaxis.range'] !== undefined || update['yaxis.range'] !== undefined) {
                view.zoom = this._griddedShownRanges(div);
                if (!this._griddedZoomNeedsRedraw(view)) return;
            } else {
                return;
            }
            this._griddedDrawMap(view);
        });
    };

    proto._griddedOpenMenuAt = function(div, where) {
        const view = this._griddedVisibleView();
        const at = view && this._griddedEventCoords(div, where);
        if (!at) return;
        const hit = this._griddedHitTest(view, at, where, { inside: true });
        if (!hit) {
            this._griddedCloseMenu();
            return;
        }
        this._griddedSelect(view, hit);
        this._griddedShowMenu(view, hit, where.clientX, where.clientY);
    };

    /**
     * What a press at `at` would grab: the orange ring, or the orange box by
     * one of its edges or corners (n, se, …) or by its inside (move).
     * `pointer` is 'mouse' or 'touch', for how close counts.
     */
    proto._griddedEditTarget = function(view, at, pointer) {
        const { px, py, xa, ya } = at;
        if (view.pendingPoint && Math.hypot(xa.l2p(view.pendingPoint.lon) - px, ya.l2p(view.pendingPoint.lat) - py) <= RING_GRAB_PX[pointer]) {
            return { kind: 'ring' };
        }
        const box = view.pendingBox;
        if (!box) return null;
        const edge = BOX_EDGE_PX[pointer];
        const left = Math.min(xa.l2p(box.lonMin), xa.l2p(box.lonMax));
        const right = Math.max(xa.l2p(box.lonMin), xa.l2p(box.lonMax));
        const top = Math.min(ya.l2p(box.latMin), ya.l2p(box.latMax));
        const bottom = Math.max(ya.l2p(box.latMin), ya.l2p(box.latMax));
        if (px < left - edge || px > right + edge || py < top - edge || py > bottom + edge) return null;
        // A box too small for two edges and an inside is moved, never resized
        // by accident from the wrong side.
        const roomy = right - left > 3 * edge && bottom - top > 3 * edge;
        const vertical = Math.abs(py - top) <= edge ? 'n' : Math.abs(py - bottom) <= edge ? 's' : '';
        const horizontal = Math.abs(px - left) <= edge ? 'w' : Math.abs(px - right) <= edge ? 'e' : '';
        if (roomy && (vertical || horizontal)) return { kind: 'box', handle: vertical + horizontal };
        if (px >= left && px <= right && py >= top && py <= bottom) return { kind: 'box', handle: 'move' };
        return null;
    };

    /**
     * Drag the orange ring or box: `move(at)` follows the pointer, cheaply
     * (a restyle of the ring's trace, a relayout of the box's shape), and
     * `end()` settles it — coordinates, selection, a full redraw.
     */
    proto._griddedBeginEdit = function(view, div, target, startAt) {
        view.editing = true;
        div.classList.add('gridded-dragging');
        let frame = 0;
        let pending = null;
        const flush = () => {
            frame = 0;
            if (pending) pending();
            pending = null;
        };
        const schedule = work => {
            pending = work;
            if (!frame) frame = requestAnimationFrame(flush);
        };
        const finish = kind => {
            if (frame) {
                cancelAnimationFrame(frame);
                flush();
            }
            view.editing = false;
            div.classList.remove('gridded-dragging');
            view.selected = { kind };
            this._griddedSyncInputs(view);
            this._griddedRenderSelection(view);
            this._griddedDrawMap(view);
        };
        if (target.kind === 'ring') {
            const trace = (div.data || []).findIndex(item => item.name === 'pending-point');
            const stencilTrace = (div.data || []).findIndex(item => item.name === 'pending-stencil');
            return {
                move: at => {
                    view.pendingPoint = { lat: roundCoordinate(Math.max(-90, Math.min(90, at.lat))), lon: roundCoordinate(at.lon) };
                    const { lat, lon } = view.pendingPoint;
                    const stencil = stencilTrace >= 0 ? pointStencil(view.map, lat, lon, view.pointMethod) : null;
                    if (trace >= 0) {
                        schedule(() => (stencil
                            ? Plotly.restyle(div, { x: [[lon], stencil.x], y: [[lat], stencil.y] }, [trace, stencilTrace])
                            : Plotly.restyle(div, { x: [[lon]], y: [[lat]] }, [trace])));
                    }
                    this._griddedSyncInputs(view);
                },
                end: () => finish('pending-point'),
            };
        }
        const start = { ...view.pendingBox };
        const crossing = start.lonMin > start.lonMax;
        const handle = target.handle;
        return {
            move: at => {
                const dLon = at.lon - startAt.lon;
                let dLat = at.lat - startAt.lat;
                const box = { ...start };
                if (handle === 'move') {
                    dLat = Math.max(-90 - start.latMin, Math.min(90 - start.latMax, dLat));
                    box.lonMin += dLon;
                    box.lonMax += dLon;
                    box.latMin += dLat;
                    box.latMax += dLat;
                } else {
                    if (handle.includes('n')) box.latMax = start.latMax + dLat;
                    if (handle.includes('s')) box.latMin = start.latMin + dLat;
                    if (handle.includes('w')) box.lonMin = start.lonMin + dLon;
                    if (handle.includes('e')) box.lonMax = start.lonMax + dLon;
                    if (box.latMin > box.latMax) [box.latMin, box.latMax] = [box.latMax, box.latMin];
                    if (!crossing && box.lonMin > box.lonMax) [box.lonMin, box.lonMax] = [box.lonMax, box.lonMin];
                }
                box.latMin = Math.max(-90, box.latMin);
                box.latMax = Math.min(90, box.latMax);
                for (const key of Object.keys(box)) box[key] = roundCoordinate(box[key]);
                view.pendingBox = box;
                const index = (div.layout.shapes || []).findIndex(shape => shape.name === 'pending-box');
                if (index >= 0) {
                    schedule(() => Plotly.relayout(div, {
                        [`shapes[${index}].x0`]: box.lonMin, [`shapes[${index}].x1`]: box.lonMax,
                        [`shapes[${index}].y0`]: box.latMin, [`shapes[${index}].y1`]: box.latMax,
                    }));
                }
                this._griddedSyncInputs(view);
            },
            end: () => finish('pending-box'),
        };
    };

    proto._griddedSetPendingBox = function(view, shape) {
        view.pendingBox = {
            lonMin: roundCoordinate(Math.min(shape.x0, shape.x1)),
            lonMax: roundCoordinate(Math.max(shape.x0, shape.x1)),
            latMin: roundCoordinate(Math.max(-90, Math.min(shape.y0, shape.y1))),
            latMax: roundCoordinate(Math.min(90, Math.max(shape.y0, shape.y1))),
        };
        view.selected = { kind: 'pending-box' };
        if (view.mode !== 'region') {
            view.mode = 'region';
            this._griddedSyncMode(view);
        }
        this._griddedSyncInputs(view);
        this._griddedRenderSelection(view);
        this._griddedDrawOverlaysSoon(view);
    };

    /** A mouse event on the map as plot pixels and longitude/latitude, or null outside the plot. */
    proto._griddedEventCoords = function(div, event, { clamp = false } = {}) {
        const layout = div?._fullLayout;
        if (!layout?.xaxis?._length || !event) return null;
        const rect = div.getBoundingClientRect();
        const xa = layout.xaxis;
        const ya = layout.yaxis;
        let px = event.clientX - rect.left - xa._offset;
        let py = event.clientY - rect.top - ya._offset;
        if (clamp) {
            // A drag may leave the plot; what it moves stays at the border.
            px = Math.max(0, Math.min(xa._length, px));
            py = Math.max(0, Math.min(ya._length, py));
        }
        if (px < 0 || py < 0 || px > xa._length || py > ya._length) return null;
        return { px, py, lon: xa.p2l(px), lat: ya.p2l(py), xa, ya };
    };

    /**
     * The point or box under the pointer: the orange point, then the nearest
     * extracted point, then the orange box, then the smallest extracted box.
     * A box is hit on its edge, or anywhere inside with `inside` (the right
     * button): a plain click inside a box must still place a point there.
     */
    proto._griddedHitTest = function(view, at, event, { inside }) {
        const tagIndex = event?.target?.closest?.('.annotation')?.getAttribute('data-index');
        if (tagIndex !== null && tagIndex !== undefined && view.annotationGroups?.[Number(tagIndex)]) {
            return { kind: 'group', id: view.annotationGroups[Number(tagIndex)] };
        }
        const { px, py, xa, ya } = at;
        const distance = (lon, lat) => Math.hypot(xa.l2p(lon) - px, ya.l2p(lat) - py);
        if (view.pendingPoint && distance(view.pendingPoint.lon, view.pendingPoint.lat) <= 12) return { kind: 'pending-point' };
        let nearest = null;
        for (const group of (view.groups || []).filter(item => item.kind === 'point')) {
            const d = distance(group.geometry.lon, group.geometry.lat);
            if (d <= 10 && (!nearest || d < nearest.d)) nearest = { d, id: group.id };
        }
        if (nearest) return { kind: 'group', id: nearest.id };
        const edge = 6;
        const area = box => {
            const left = Math.min(xa.l2p(box.lonMin), xa.l2p(box.lonMax));
            const right = Math.max(xa.l2p(box.lonMin), xa.l2p(box.lonMax));
            const top = Math.min(ya.l2p(box.latMin), ya.l2p(box.latMax));
            const bottom = Math.max(ya.l2p(box.latMin), ya.l2p(box.latMax));
            const within = px >= left - edge && px <= right + edge && py >= top - edge && py <= bottom + edge;
            if (!within) return null;
            const onEdge = px <= left + edge || px >= right - edge || py <= top + edge || py >= bottom - edge;
            return inside || onEdge ? (right - left) * (bottom - top) : null;
        };
        if (view.pendingBox && area(view.pendingBox) !== null) return { kind: 'pending-box' };
        let smallest = null;
        for (const group of (view.groups || []).filter(item => item.kind === 'region')) {
            const size = area(group.geometry);
            if (size !== null && (!smallest || size < smallest.size)) smallest = { size, id: group.id };
        }
        return smallest ? { kind: 'group', id: smallest.id } : null;
    };

    /**
     * Select a point or box (null clears): it is drawn heavier, its row is
     * marked, and the orange ones bring up their tool and coordinates.
     */
    proto._griddedSelect = function(view, target) {
        view.selected = target;
        if (target?.kind === 'pending-point' && view.mode !== 'point') this._griddedSetMode(view, 'point');
        if (target?.kind === 'pending-box' && view.mode !== 'region') this._griddedSetMode(view, 'region');
        this._griddedRenderSelection(view);
        this._griddedDrawMap(view);
    };

    proto._griddedRenderSelection = function(view) {
        const id = view.selected?.kind === 'group' ? view.selected.id : null;
        document.querySelectorAll('#gridded-view .gridded-result').forEach(row => {
            const selected = row.dataset.group === id;
            row.classList.toggle('selected', selected);
            // On a phone the list is under the map, in the same scroll:
            // bringing the row into view would take the map off the screen.
            if (selected && !document.documentElement.classList.contains('compact')) row.scrollIntoView({ block: 'nearest' });
        });
    };

    proto._griddedDeleteSelected = function(view, target = view.selected) {
        if (!target) return;
        if (target.kind === 'pending-point') this._griddedClearPending(view, 'point');
        else if (target.kind === 'pending-box') this._griddedClearPending(view, 'region');
        else if (target.kind === 'group') this._griddedRemoveGroup(view, target.id);
        view.selected = null;
        this._griddedRenderSelection(view);
    };

    proto._griddedShowMenu = function(view, target, x, y) {
        this._griddedCloseMenu();
        const items = [];
        if (target.kind === 'pending-point') {
            items.push([i18n.t('griddedExtractPoint'), () => this._griddedExtractPoint(view)]);
            items.push([i18n.t('griddedDelete'), () => this._griddedDeleteSelected(view, target)]);
        } else if (target.kind === 'pending-box') {
            items.push([i18n.t('griddedExtractRegion'), () => this._griddedExtractRegion(view)]);
            items.push([i18n.t('griddedDelete'), () => this._griddedDeleteSelected(view, target)]);
        } else {
            const group = (view.groups || []).find(item => item.id === target.id);
            if (!group) return;
            items.push([i18n.t('griddedReuseHere'), () => this._griddedReusePlace(view, group.id)]);
            items.push([i18n.t('griddedDeleteExtraction').replace('{tag}', group.tag), () => this._griddedDeleteSelected(view, target)]);
        }
        const menu = document.createElement('div');
        menu.className = 'gridded-context-menu';
        menu.setAttribute('role', 'menu');
        for (const [label, run] of items) {
            const button = document.createElement('button');
            button.type = 'button';
            button.setAttribute('role', 'menuitem');
            button.textContent = label;
            button.addEventListener('click', () => {
                this._griddedCloseMenu();
                run();
            });
            menu.appendChild(button);
        }
        document.body.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 4)}px`;
        menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 4)}px`;
        const close = event => {
            if (event.type === 'keydown' && event.key !== 'Escape') return;
            if (event.type === 'pointerdown' && menu.contains(event.target)) return;
            this._griddedCloseMenu();
        };
        window.addEventListener('pointerdown', close, true);
        window.addEventListener('keydown', close, true);
        window.addEventListener('wheel', close, { capture: true, passive: true });
        menu.focus?.();
        menu.querySelector('button')?.focus();
        this._griddedMenu = {
            menu,
            remove: () => {
                window.removeEventListener('pointerdown', close, true);
                window.removeEventListener('keydown', close, true);
                window.removeEventListener('wheel', close, { capture: true, passive: true });
                menu.remove();
            },
        };
    };

    proto._griddedCloseMenu = function() {
        this._griddedMenu?.remove();
        this._griddedMenu = null;
    };

    // ─── Extractions ──────────────────────────────────────────────────────

    /**
     * What an extraction is of, in its name: the file's short name alone
     * ("t2m") says nothing to most readers, so the long one goes with it —
     * "2 metre temperature (t2m)".
     */
    proto._griddedQuantity = function(variable) {
        const long = variable.longName && variable.longName !== variable.name ? variable.longName : '';
        return long ? `${long} (${variable.name})` : variable.name;
    };

    proto._griddedSelectionSuffix = function(view, variable, levelIndex = null) {
        const parts = [];
        variable.dimNames.forEach((name, index) => {
            const role = variable.roles[index];
            if (role === 'y' || role === 'x' || role === 't') return;
            const axis = view.model.axes[name];
            if (!axis || axis.size < 2) return;
            const position = role === 'z' && levelIndex !== null ? levelIndex : view.selection[name] || 0;
            const label = axis.labels[position];
            parts.push(role === 'z' && axis.units ? `${label} ${axis.units}` : `${name}=${label}`);
        });
        return parts.length ? ` @ ${parts.join(', ')}` : '';
    };

    /** The level axis of a variable, when it has more than one level. */
    proto._griddedLevelAxis = function(view, variable) {
        const index = variable ? variable.roles.indexOf('z') : -1;
        if (index < 0) return null;
        const name = variable.dimNames[index];
        const axis = view.model.axes[name];
        return axis && axis.size > 1 ? { name, axis } : null;
    };

    proto._griddedLevelLabel = function(axis, index) {
        const label = axis.labels[index];
        return axis.units ? `${label} ${axis.units}` : String(label);
    };

    /**
     * The level indices an extraction reads: those ticked in the panel, or
     * the one on the map. Null for a variable without levels.
     */
    proto._griddedExtractionLevels = function(view, variable) {
        const level = this._griddedLevelAxis(view, variable);
        if (!level) return null;
        const chosen = (view.extractLevels || []).filter(index => index < level.axis.size);
        return chosen.length ? [...chosen].sort((a, b) => a - b) : [Number(view.selection[level.name]) || 0];
    };

    proto._griddedCanExtract = function(view, variable) {
        if (!variable) return false;
        if (!variable.timeDim || variable.timeDim !== view.model.primaryTimeDim) {
            this._griddedSetStatus(i18n.t('griddedNoSeriesForVariable').replace('{name}', variable.name), true);
            return false;
        }
        return true;
    };

    proto._griddedRunJob = async function(view, op, payload, label) {
        if (view.job) {
            this._griddedSetStatus(i18n.t('griddedBusy'), true);
            return null;
        }
        const progressEl = this._griddedEl('progress');
        const bar = this._griddedEl('progress-bar');
        this._griddedEl('progress-label').textContent = label;
        bar.value = 0;
        progressEl.hidden = false;
        const request = griddedClient().request(op, { datasetId: view.datasetId, ...payload }, {
            onProgress: value => { bar.value = value; },
        });
        view.job = request;
        this._griddedSyncActions(view);
        try {
            return await request.promise;
        } catch (error) {
            this._griddedSetStatus(error?.cancelled ? i18n.t('griddedCancelled') : this._griddedErrorText(error, ''), !error?.cancelled);
            return null;
        } finally {
            view.job = null;
            progressEl.hidden = true;
            this._griddedSyncActions(view);
        }
    };

    /**
     * After an extraction (or the orange point or box removed), back to
     * Navigate: the next click on the map pans rather than placing another
     * point by surprise.
     */
    proto._griddedBackToNavigate = function(view) {
        if (view.mode !== 'navigate') this._griddedSetMode(view, 'navigate');
    };

    proto._griddedExtractPoint = async function(view, at = view.pendingPoint) {
        const variable = this._griddedVariable(view);
        if (!at || !this._griddedCanExtract(view, variable)) return;
        const { lat, lon } = at;
        const levels = this._griddedExtractionLevels(view, variable);
        const method = view.pointMethod === 'bilinear' ? 'bilinear' : 'nearest';
        const result = await this._griddedRunJob(view, 'point', {
            variable: variable.key, selection: view.selection, lat, lon, levels, method,
        }, i18n.t('griddedReadingPoint').replace('{lat}', formatCoordinate(lat, 'N', 'S')).replace('{lon}', formatCoordinate(lon, 'E', 'W')));
        if (!result) return;
        const coordinates = `${formatCoordinate(result.cell.lat, 'N', 'S')} ${formatCoordinate(result.cell.lon, 'E', 'W')}`;
        // A bilinear place is the point itself and says so; a nearest one is
        // the grid cell it was read from.
        const where = method === 'bilinear' ? `${coordinates} (${i18n.t('griddedBilinearTag')})` : coordinates;
        const parts = result.byLevel || [{ index: null, values: result.values }];
        const description = i18n.t(method === 'bilinear' ? 'griddedPointDescriptionBilinear' : 'griddedPointDescription')
            .replace('{variable}', variable.longName || variable.name)
            .replace('{where}', coordinates);
        view.pendingPoint = null;
        if (view.selected?.kind === 'pending-point') view.selected = null;
        this._griddedSyncInputs(view);
        const outcome = this._griddedAddSeries(view, {
            kind: 'point',
            method,
            geometry: { lat: result.cell.lat, lon: result.cell.lon },
            where,
            variable,
            sets: parts.map(({ index, values }) => ({
                levelIndex: index,
                items: [{ role: 'value', values, description }],
            })),
        });
        this._griddedBackToNavigate(view);
        if (!outcome) return;
        this._griddedSetStatus(outcome.added
            ? i18n.t('griddedPointDone').replace('{name}', `${outcome.group.tag} · ${this._griddedQuantity(variable)} · ${where}`)
            : i18n.t('griddedAlreadyExtracted').replace('{tag}', outcome.group.tag));
    };

    proto._griddedExtractRegion = async function(view, box = view.pendingBox) {
        const variable = this._griddedVariable(view);
        if (!box || !this._griddedCanExtract(view, variable)) return;
        const where = `${formatCoordinate(box.latMin, 'N', 'S')}–${formatCoordinate(box.latMax, 'N', 'S')}, ${formatCoordinate(box.lonMin, 'E', 'W')}–${formatCoordinate(box.lonMax, 'E', 'W')}`;
        const levels = this._griddedExtractionLevels(view, variable);
        const result = await this._griddedRunJob(view, 'region', {
            variable: variable.key, selection: view.selection, box, levels,
        }, i18n.t('griddedReadingRegion').replace('{where}', where));
        if (!result) return;
        const weighting = i18n.t(result.weighting === 'cell-area' ? 'griddedWeightingArea' : 'griddedWeightingCosLat');
        const describe = key => i18n.t(key)
            .replace('{variable}', variable.longName || variable.name)
            .replace('{where}', where)
            .replace('{cells}', String(result.cells))
            .replace('{weighting}', weighting);
        const parts = result.byLevel || [{ index: null, ...result }];
        view.pendingBox = null;
        if (view.selected?.kind === 'pending-box') view.selected = null;
        this._griddedSyncInputs(view);
        const outcome = this._griddedAddSeries(view, {
            kind: 'region',
            geometry: { ...box },
            where,
            note: i18n.t('griddedRegionNote').replace('{cells}', String(result.cells)).replace('{weighting}', weighting),
            variable,
            sets: parts.map(part => ({
                levelIndex: part.index,
                items: [
                    { role: 'mean', values: part.mean, description: describe('griddedMeanDescription') },
                    { role: 'min', values: part.min, description: describe('griddedMinDescription') },
                    { role: 'max', values: part.max, description: describe('griddedMaxDescription') },
                ],
            })),
        });
        this._griddedBackToNavigate(view);
        if (!outcome) return;
        if (!outcome.added) {
            this._griddedSetStatus(i18n.t('griddedAlreadyExtracted').replace('{tag}', outcome.group.tag));
            return;
        }
        const missing = parts.some(part => Array.from(part.validFraction).some(value => value < 1));
        this._griddedSetStatus(i18n.t('griddedRegionDone')
            .replace('{tag}', outcome.group.tag)
            .replace('{cells}', String(result.cells))
            .replace('{weighting}', weighting)
            + (missing ? ` ${i18n.t('griddedRegionMissing')}` : ''));
    };

    proto._griddedExtractionNode = function(data) {
        let node = Object.values(data.tree._children).find(child => child._griddedExtractions);
        if (!node) {
            node = treeNode(i18n.t('griddedExtractionsNode'));
            node._griddedExtractions = true;
            data.tree._children[node._name] = node;
        }
        return node;
    };

    /** The folder of one place (P1, R1…) under "Extractions". */
    proto._griddedPlaceNode = function(data, group) {
        const parent = this._griddedExtractionNode(data);
        let node = Object.values(parent._children).find(child => child._griddedGroupId === group.id);
        if (!node) {
            const name = `${group.tag} · ${group.where}`;
            node = treeNode(name);
            node._griddedGroupId = group.id;
            parent._children[name] = node;
        }
        return node;
    };

    proto._griddedSameGeometry = function(kind, a, b) {
        const same = (x, y) => Math.abs(x - y) < 1e-6;
        if (kind === 'point') return same(a.lat, b.lat) && same(a.lon, b.lon);
        return same(a.latMin, b.latMin) && same(a.latMax, b.latMax) && same(a.lonMin, b.lonMin) && same(a.lonMax, b.lonMax);
    };

    proto._griddedNextColor = function(view) {
        view.colorCount = (view.colorCount || 0) + 1;
        return SERIES_COLORS[(view.colorCount - 1) % SERIES_COLORS.length];
    };

    /**
     * A place is a point or a box; its series are what was extracted there:
     * one set per variable and level (a value for a point; mean, min and max
     * for a box). The same place extracted again — the same grid cell, the
     * same box — adds its sets to the place it already is, so P1 and R1 are
     * folders, not one-off results. A set already there is not read twice.
     *
     * @returns {{group: object, added: number}|null}
     */
    proto._griddedAddSeries = function(view, { kind, method = null, geometry, where, note = '', variable, sets }) {
        const data = this.plotManager.files.get(view.fileId)?.data;
        if (!data) return null;
        // A point read by interpolation and one read from the nearest cell
        // are different places, even at the same coordinates.
        const pointMethod = kind === 'point' ? (method || 'nearest') : null;
        let group = (view.groups || []).find(item => item.kind === kind
            && (kind !== 'point' || (item.method || 'nearest') === pointMethod)
            && this._griddedSameGeometry(kind, item.geometry, geometry));
        if (!group) {
            view.groupCount = (view.groupCount || 0) + 1;
            const counters = view.tagCounters || (view.tagCounters = { point: 0, region: 0 });
            counters[kind] += 1;
            group = {
                id: `g${view.groupCount}`,
                kind,
                tag: `${kind === 'point' ? 'P' : 'R'}${counters[kind]}`,
                ...(pointMethod ? { method: pointMethod } : {}),
                geometry,
                where,
                note,
                color: this._griddedNextColor(view),
                sets: [],
            };
            view.groups.push(group);
        }
        const folder = this._griddedPlaceNode(data, group);
        const level = this._griddedLevelAxis(view, variable);
        const quantity = this._griddedQuantity(variable);
        let added = 0;
        for (const set of sets) {
            const levelIndex = set.levelIndex ?? (level ? Number(view.selection[level.name]) || 0 : null);
            const suffix = this._griddedSelectionSuffix(view, variable, levelIndex);
            const key = `${variable.key}${suffix}`;
            if (group.sets.some(item => item.key === key)) continue;
            view.setCount = (view.setCount || 0) + 1;
            const levelText = suffix.replace(/^ @ /, '');
            const entry = {
                id: `s${view.setCount}`,
                key,
                // Which field this set was read from, said outright: the
                // label spells it for a reader, these two for the app (a
                // saved session, and whatever asks the dataset again).
                variableKey: variable.key,
                levelIndex: levelIndex ?? null,
                label: `${quantity}${levelText ? ` · ${levelText}` : ''}`,
                short: `${variable.name}${levelText ? ` ${levelText}` : ''}`,
                color: group.sets.length ? this._griddedNextColor(view) : group.color,
                checked: true,
                names: [],
                roles: [],
            };
            for (const item of set.items) {
                view.extractionCount += 1;
                const name = `grid:x${view.extractionCount}`;
                const roleText = item.role === 'value' ? '' : i18n.t(item.role === 'mean' ? 'griddedMean' : item.role === 'min' ? 'griddedMin' : 'griddedMax');
                // In the plots' legends the curve stands alone, so it says
                // where it is from; in its folder, only what it is.
                const displayName = kind === 'point'
                    ? `${group.tag} · ${quantity} · ${where}${suffix}`
                    : `${group.tag} · ${quantity} · ${roleText} [${where}]${suffix}`;
                let leaf = `${entry.label}${roleText ? ` · ${roleText}` : ''}`;
                for (let copy = 2; folder._variables[leaf]; copy++) leaf = `${entry.label}${roleText ? ` · ${roleText}` : ''} (${copy})`;
                const values = Float64Array.from(item.values);
                data.variables[name] = {
                    name,
                    displayName,
                    data: values,
                    description: item.description,
                    units: variable.units || '',
                    kind: 'variable',
                    dataType: this.parser?._detectDataType ? this.parser._detectDataType(values, name) : 'numeric',
                    isConstant: this.parser?._isConstantValues ? this.parser._isConstantValues(values) : false,
                    interpolation: 'linear',
                    negate: false,
                    source: 'netcdf-gridded',
                };
                folder._variables[leaf] = data.variables[name];
                entry.names.push(name);
                entry.roles.push(item.role);
            }
            group.sets.push(entry);
            added += 1;
        }
        this._griddedCommitData(view, data);
        this._griddedRenderResults(view);
        this._griddedDrawPreview(view);
        this._griddedDrawMap(view);
        return { group, added };
    };

    proto._griddedCommitData = function(view, data) {
        data.metadata.numVariables = Object.values(data.variables).filter(variable => variable.kind === 'variable').length;
        data.metadata.numTimevarying = data.metadata.numVariables;
        this.plotManager.updateFileData(view.fileId, data);
        if (this.plotManager.activeFileId === view.fileId) this._renderFilteredTree?.();
    };

    proto._griddedDropVariables = function(data, names) {
        for (const name of names) delete data.variables[name];
    };

    proto._griddedRemoveGroup = function(view, id) {
        const index = view.groups.findIndex(group => group.id === id);
        if (index < 0) return;
        const [group] = view.groups.splice(index, 1);
        if (view.selected?.kind === 'group' && view.selected.id === id) view.selected = null;
        const data = this.plotManager.files.get(view.fileId)?.data;
        if (data) {
            this._griddedDropVariables(data, group.sets.flatMap(set => set.names));
            const parent = this._griddedExtractionNode(data);
            for (const [name, child] of Object.entries(parent._children)) {
                if (child._griddedGroupId === id) delete parent._children[name];
            }
            this._griddedCommitData(view, data);
        }
        this._griddedRenderResults(view);
        this._griddedDrawPreview(view);
        this._griddedDrawMap(view);
    };

    /** One variable and level of a place; the place goes with its last one. */
    proto._griddedRemoveSet = function(view, groupId, setId) {
        const group = (view.groups || []).find(item => item.id === groupId);
        const set = group?.sets.find(item => item.id === setId);
        if (!set) return;
        if (group.sets.length === 1) {
            this._griddedRemoveGroup(view, groupId);
            return;
        }
        group.sets = group.sets.filter(item => item !== set);
        const data = this.plotManager.files.get(view.fileId)?.data;
        if (data) {
            this._griddedDropVariables(data, set.names);
            const folder = this._griddedPlaceNode(data, group);
            for (const [leaf, variable] of Object.entries(folder._variables)) {
                if (set.names.includes(variable?.name)) delete folder._variables[leaf];
            }
            this._griddedCommitData(view, data);
        }
        this._griddedRenderResults(view);
        this._griddedDrawPreview(view);
    };

    proto._griddedRemoveAll = async function(view) {
        const count = (view.groups || []).length;
        if (!count) return;
        const ok = await Modal.confirm(i18n.t('griddedRemoveAllConfirm').replace('{count}', String(count)), {
            title: i18n.t('griddedRemoveAll'),
            icon: '🗑️',
        });
        if (!ok) return;
        const data = this.plotManager.files.get(view.fileId)?.data;
        if (data) {
            this._griddedDropVariables(data, view.groups.flatMap(group => group.sets.flatMap(set => set.names)));
            const node = this._griddedExtractionNode(data);
            for (const name of Object.keys(node._children)) delete node._children[name];
            for (const leaf of Object.keys(node._variables)) delete node._variables[leaf];
            this._griddedCommitData(view, data);
        }
        view.groups = [];
        if (view.selected?.kind === 'group') view.selected = null;
        this._griddedRenderResults(view);
        this._griddedDrawPreview(view);
        this._griddedDrawMap(view);
    };

    /**
     * Put a place back on the map as the orange point or box, to extract
     * another variable or other levels there: the new series join its folder.
     */
    /** How a point's value and a region's statistics are computed, on demand. */
    proto._griddedShowMethodsHelp = function() {
        Modal.alert(i18n.t('griddedMethodsHelpTitle'), `<div class="gridded-help-body">${i18n.t('griddedMethodsHelpBody')}</div>`, {
            html: true,
            icon: false,
            className: 'gridded-help-dialog',
        });
    };

    proto._griddedReusePlace = function(view, id) {
        const group = (view.groups || []).find(item => item.id === id);
        if (!group) return;
        if (group.kind === 'point') {
            view.pendingPoint = { ...group.geometry };
            view.pointMethod = group.method === 'bilinear' ? 'bilinear' : 'nearest';
            view.selected = { kind: 'pending-point' };
            this._griddedSetMode(view, 'point');
        } else {
            view.pendingBox = { ...group.geometry };
            view.selected = { kind: 'pending-box' };
            this._griddedSetMode(view, 'region');
        }
        this._griddedSyncInputs(view);
        this._griddedRenderSelection(view);
        this._griddedDrawMap(view);
        this._griddedSetStatus(i18n.t('griddedReuseStatus').replace(/\{tag\}/g, group.tag));
    };

    // ─── Sessions ─────────────────────────────────────────────────────────
    //
    // What a saved session keeps of a map: the places extracted on it (P1,
    // R1…) with their series and their values, and what the map was showing
    // (variable, level and step, palette, colour range, zoom, and whether the
    // list of series was folded away). The files the dataset was opened from,
    // and how they were joined, are kept beside this by session-methods.js,
    // so a dataset of several months or a CDS ZIP opens again as one dataset.
    //
    // The values travel with the session rather than being read again: a
    // project is restored from its own bytes, offline and in one pass, and a
    // view session applied over the same file shows the same numbers without
    // touching it.

    /** JSON has no NaN; null stands for it, both ways. */
    const sessionNumbers = values => Array.from(values || [], value => (Number.isFinite(value) ? value : null));
    const sessionValues = values => Float64Array.from(values || [], value => (Number.isFinite(value) ? value : NaN));

    /** The leaf name each extracted variable has in its place's folder. */
    proto._griddedLeafNames = function(data) {
        const names = new Map();
        const parent = Object.values(data?.tree?._children || {}).find(child => child._griddedExtractions);
        for (const place of Object.values(parent?._children || {})) {
            for (const [leaf, variable] of Object.entries(place._variables || {})) {
                if (variable?.name) names.set(variable.name, leaf);
            }
        }
        return names;
    };

    proto._griddedSessionState = function(fileId) {
        const view = this._griddedState().views.get(fileId);
        if (!view) return null;
        const data = this.plotManager.files.get(fileId)?.data;
        const leaves = this._griddedLeafNames(data);
        return {
            open: this._griddedState().visibleFileId === fileId,
            variableKey: view.variableKey || null,
            selection: { ...view.selection },
            palette: view.palette,
            scale: {
                range: view.scale.range ? [...view.scale.range] : null,
                stats: view.scale.stats ? { ...view.scale.stats } : null,
                source: view.scale.source || 'sample',
                robust: !!view.scale.robust,
                symmetric: !!view.scale.symmetric,
                follow: !!view.scale.follow,
            },
            zoom: view.zoom ? { x: [...view.zoom.x], y: [...view.zoom.y] } : null,
            extractLevels: view.extractLevels?.length ? [...view.extractLevels] : null,
            pointMethod: view.pointMethod === 'bilinear' ? 'bilinear' : 'nearest',
            resultsHidden: !!view.resultsHidden,
            plotPanelId: view.plotPanelId ?? null,
            counters: {
                groupCount: view.groupCount || 0,
                setCount: view.setCount || 0,
                extractionCount: view.extractionCount || 0,
                colorCount: view.colorCount || 0,
                tagCounters: { ...(view.tagCounters || { point: 0, region: 0 }) },
            },
            groups: (view.groups || []).map(group => ({
                id: group.id,
                kind: group.kind,
                tag: group.tag,
                ...(group.method ? { method: group.method } : {}),
                geometry: { ...group.geometry },
                where: group.where,
                note: group.note || '',
                color: group.color,
                sets: (group.sets || []).map(set => ({
                    id: set.id,
                    key: set.key,
                    variableKey: set.variableKey ?? null,
                    levelIndex: set.levelIndex ?? null,
                    label: set.label,
                    short: set.short,
                    color: set.color,
                    checked: set.checked !== false,
                    items: set.names.map((name, index) => {
                        const variable = data?.variables?.[name] || null;
                        return {
                            name,
                            role: set.roles[index] || 'value',
                            displayName: variable?.displayName || name,
                            leaf: leaves.get(name) || variable?.displayName || name,
                            description: variable?.description || '',
                            units: variable?.units || '',
                            values: sessionNumbers(variable?.data),
                        };
                    }),
                })),
            })),
        };
    };

    /**
     * Put a saved map back: its places and their series (the same `grid:x…`
     * names, in the same folders of the tree, so the panels that plotted them
     * find them again) and what the map was showing. Called while a session is
     * applied, before the panels are rebuilt.
     */
    proto._griddedRestoreSession = function(fileId, saved) {
        const view = this._griddedState().views.get(fileId);
        const data = this.plotManager.files.get(fileId)?.data;
        if (!view || !data || !saved) return false;
        // Whatever this map held before gives way to what the session carries:
        // its variables and its folders leave the tree first.
        this._griddedDropVariables(data, (view.groups || []).flatMap(group => group.sets.flatMap(set => set.names)));
        const extractions = this._griddedExtractionNode(data);
        for (const name of Object.keys(extractions._children)) delete extractions._children[name];
        for (const leaf of Object.keys(extractions._variables)) delete extractions._variables[leaf];
        view.selected = null;
        view.pendingPoint = null;
        view.pendingBox = null;
        const model = view.model;
        if (saved.variableKey && model.variables.some(item => item.mapable && item.key === saved.variableKey)) {
            view.variableKey = saved.variableKey;
        }
        for (const [name, index] of Object.entries(saved.selection || {})) {
            const position = Number(index);
            if (Number.isInteger(position) && position >= 0 && position < (model.axes[name]?.size || 0)) {
                view.selection[name] = position;
            }
        }
        if (PALETTES.includes(saved.palette)) view.palette = saved.palette;
        const scale = saved.scale || {};
        view.scale = {
            range: Array.isArray(scale.range) && scale.range.length === 2 && scale.range.every(Number.isFinite)
                ? [scale.range[0], scale.range[1]]
                : null,
            stats: scale.stats && Number.isFinite(scale.stats.min) ? { ...scale.stats } : null,
            source: scale.source || 'sample',
            robust: !!scale.robust,
            symmetric: !!scale.symmetric,
            follow: !!scale.follow,
        };
        const zoom = saved.zoom;
        view.zoom = Array.isArray(zoom?.x) && Array.isArray(zoom?.y) && [...zoom.x, ...zoom.y].every(Number.isFinite)
            ? { x: [...zoom.x], y: [...zoom.y] }
            : null;
        view.extractLevels = Array.isArray(saved.extractLevels) && saved.extractLevels.length ? [...saved.extractLevels] : null;
        view.resultsHidden = !!saved.resultsHidden;
        view.pointMethod = saved.pointMethod === 'bilinear' ? 'bilinear' : 'nearest';
        if (saved.plotPanelId !== null && saved.plotPanelId !== undefined) view.plotPanelId = saved.plotPanelId;
        const counters = saved.counters || {};
        view.groupCount = Number(counters.groupCount) || 0;
        view.setCount = Number(counters.setCount) || 0;
        view.extractionCount = Number(counters.extractionCount) || 0;
        view.colorCount = Number(counters.colorCount) || 0;
        view.tagCounters = { point: 0, region: 0, ...(counters.tagCounters || {}) };
        view.groups = [];
        for (const saveGroup of saved.groups || []) {
            const group = {
                id: saveGroup.id,
                kind: saveGroup.kind === 'region' ? 'region' : 'point',
                tag: saveGroup.tag,
                ...(saveGroup.kind !== 'region' ? { method: saveGroup.method === 'bilinear' ? 'bilinear' : 'nearest' } : {}),
                geometry: { ...saveGroup.geometry },
                where: saveGroup.where || '',
                note: saveGroup.note || '',
                color: saveGroup.color || this._griddedNextColor(view),
                sets: [],
            };
            view.groups.push(group);
            const folder = this._griddedPlaceNode(data, group);
            for (const saveSet of saveGroup.sets || []) {
                const set = {
                    id: saveSet.id,
                    key: saveSet.key,
                    variableKey: saveSet.variableKey ?? null,
                    levelIndex: saveSet.levelIndex ?? null,
                    label: saveSet.label,
                    short: saveSet.short,
                    color: saveSet.color || group.color,
                    checked: saveSet.checked !== false,
                    names: [],
                    roles: [],
                };
                for (const item of saveSet.items || []) {
                    const values = sessionValues(item.values);
                    const variable = {
                        name: item.name,
                        displayName: item.displayName || item.name,
                        data: values,
                        description: item.description || '',
                        units: item.units || '',
                        kind: 'variable',
                        dataType: this.parser?._detectDataType ? this.parser._detectDataType(values, item.name) : 'numeric',
                        isConstant: this.parser?._isConstantValues ? this.parser._isConstantValues(values) : false,
                        interpolation: 'linear',
                        negate: false,
                        source: 'netcdf-gridded',
                    };
                    data.variables[item.name] = variable;
                    folder._variables[item.leaf || variable.displayName] = variable;
                    set.names.push(item.name);
                    set.roles.push(item.role || 'value');
                }
                group.sets.push(set);
            }
        }
        // Counters written by an older session, or missing: never hand out a
        // name or a tag that is already on the map.
        const maxOf = (values, prefix) => values.reduce((top, value) => {
            const found = new RegExp(`^${prefix}(\\d+)$`).exec(String(value || ''));
            return found ? Math.max(top, Number(found[1])) : top;
        }, 0);
        const sets = view.groups.flatMap(group => group.sets);
        view.groupCount = Math.max(view.groupCount, maxOf(view.groups.map(group => group.id), 'g'));
        view.setCount = Math.max(view.setCount, maxOf(sets.map(set => set.id), 's'));
        view.extractionCount = Math.max(view.extractionCount, maxOf(sets.flatMap(set => set.names), 'grid:x'));
        for (const kind of ['point', 'region']) {
            const prefix = kind === 'point' ? 'P' : 'R';
            view.tagCounters[kind] = Math.max(
                view.tagCounters[kind] || 0,
                maxOf(view.groups.filter(group => group.kind === kind).map(group => group.tag), prefix),
            );
        }
        this._griddedCommitData(view, data);
        if (this._griddedState().visibleFileId === fileId) {
            this._griddedRenderControls(view);
            this._griddedRequestMap(view);
            this._griddedDrawPreview(view);
        }
        return true;
    };

    /**
     * Hide or show the list of extracted series together with their preview
     * under the map, which then takes the whole height. Remembered for the
     * next map (a per-viewer convenience); extracting still works hidden, and
     * the heading counts the series.
     */
    proto._griddedToggleResults = function(view) {
        view.resultsHidden = !view.resultsHidden;
        try { localStorage.setItem('omv.gridded.resultsHidden', view.resultsHidden ? '1' : '0'); } catch { /* storage unavailable */ }
        this._griddedRenderResults(view);
        this._griddedDrawPreview(view);
    };

    proto._griddedSyncResultsToggle = function(view) {
        const toggle = document.querySelector('#gridded-view [data-action="toggle-results"]');
        const body = this._griddedEl('results-body');
        const heading = this._griddedEl('results-heading');
        if (!toggle || !body || !heading) return;
        const hidden = !!view.resultsHidden;
        body.hidden = hidden;
        toggle.textContent = `${hidden ? '▸' : '▾'} ${i18n.t(hidden ? 'griddedShow' : 'griddedHide')}`;
        toggle.title = i18n.t(hidden ? 'griddedShowResultsTitle' : 'griddedHideResultsTitle');
        toggle.setAttribute('aria-expanded', String(!hidden));
        const count = (view.groups || []).reduce((sum, group) => sum + group.sets.length, 0);
        heading.textContent = i18n.t('griddedResultsHeading') + (hidden && count ? ` (${count})` : '');
    };

    proto._griddedRenderResults = function(view) {
        this._griddedSyncResultsToggle(view);
        const list = this._griddedEl('results');
        if (!list) return;
        list.innerHTML = '';
        const button = (action, text, title) => {
            const element = document.createElement('button');
            element.type = 'button';
            element.className = 'gridded-remove';
            element.dataset.action = action;
            element.textContent = text;
            element.title = title;
            element.setAttribute('aria-label', title);
            return element;
        };
        for (const group of view.groups || []) {
            const item = document.createElement('li');
            item.className = 'gridded-result';
            item.dataset.group = group.id;
            item.title = i18n.t('griddedSelectOnMap');
            if (view.selected?.kind === 'group' && view.selected.id === group.id) item.classList.add('selected');
            const head = document.createElement('div');
            head.className = 'gridded-result-head';
            const swatch = document.createElement('span');
            swatch.className = 'gridded-swatch';
            swatch.style.background = group.color;
            swatch.textContent = group.tag;
            const text = document.createElement('span');
            text.className = 'gridded-result-text';
            text.textContent = group.kind === 'point' ? group.where : `[${group.where}]`;
            if (group.note) {
                const note = document.createElement('small');
                note.textContent = group.note;
                text.appendChild(note);
            }
            head.append(swatch, text,
                button('reuse-group', '+', i18n.t('griddedReuseHere')),
                button('remove-group', '✕', i18n.t('griddedRemoveExtraction')));
            const sets = document.createElement('ul');
            sets.className = 'gridded-sets';
            for (const set of group.sets) {
                const row = document.createElement('li');
                row.className = 'gridded-set';
                row.dataset.set = set.id;
                const label = document.createElement('label');
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = set.checked;
                const dot = document.createElement('span');
                dot.className = 'gridded-set-dot';
                dot.style.background = set.color;
                const name = document.createElement('span');
                name.textContent = set.label;
                label.append(checkbox, dot, name);
                row.append(label, button('remove-set', '✕', i18n.t('griddedRemoveSet')));
                sets.appendChild(row);
            }
            item.append(head, sets);
            list.appendChild(item);
        }
        const empty = this._griddedEl('results-empty');
        if (empty) empty.hidden = !!(view.groups || []).length;
        this._griddedSyncActions(view);
    };

    proto._griddedCheckedSeries = function(view) {
        const data = this.plotManager.files.get(view.fileId)?.data;
        const out = [];
        for (const group of view.groups || []) {
            for (const set of group.sets.filter(item => item.checked)) {
                set.names.forEach((name, index) => {
                    const variable = data?.variables?.[name];
                    if (variable) out.push({ group, set, variable, role: set.roles[index] });
                });
            }
        }
        return out;
    };

    proto._griddedDrawPreview = function(view) {
        const panel = this._griddedEl('preview');
        const chart = this._griddedEl('preview-chart');
        if (!panel || !chart) return;
        const series = view.resultsHidden ? [] : this._griddedCheckedSeries(view);
        const splitter = this._griddedEl('splitter');
        if (!series.length) {
            panel.hidden = true;
            if (splitter) splitter.hidden = true;
            return;
        }
        panel.hidden = false;
        if (splitter) splitter.hidden = false;
        this._griddedEl('preview-title').textContent = i18n.t('griddedPreviewTitle');
        const data = this.plotManager.files.get(view.fileId).data;
        const time = data.variables[data.metadata.timeName];
        const datetime = time?.timeKind === 'datetime';
        const colors = this._griddedColors();
        const x = datetime ? Array.from(time.data, value => new Date(value)) : Array.from(time.data);
        // Curves of different units never share an axis. The first unit
        // keeps the left axis and every other one goes to a second axis on
        // the right, each titled with the units it carries, so a preview of
        // temperature and wind together is never read as kelvin. With more
        // than two units the right axis says so, and the legend names the
        // unit of every curve.
        const unitOf = variable => variable.units || '';
        const units = [...new Set(series.map(item => unitOf(item.variable)))];
        const mixed = units.length > 1;
        const roleName = role => (role === 'value' ? '' : ` ${i18n.t(role === 'mean' ? 'griddedMean' : role === 'min' ? 'griddedMin' : 'griddedMax')}`);
        const traces = series.map(({ group, set, variable, role }) => ({
            type: 'scatter',
            mode: 'lines',
            x,
            y: Array.from(variable.data),
            yaxis: !mixed || unitOf(variable) === units[0] ? 'y' : 'y2',
            name: `${group.tag} ${set.short}${roleName(role)}${mixed && unitOf(variable) ? ` [${variable.units}]` : ''}`,
            line: { width: role === 'min' || role === 'max' ? 1 : 1.8, color: set.color, dash: role === 'min' ? 'dot' : role === 'max' ? 'dash' : 'solid' },
            hovertemplate: `${variable.displayName}<br>%{y:.5~g}${variable.units ? ` ${variable.units}` : ''}<extra></extra>`,
        }));
        // On a phone the legend goes above the curves, which keep the width.
        const narrow = chart.clientWidth < 600;
        Plotly.react(chart, traces, {
            paper_bgcolor: colors.bg,
            plot_bgcolor: colors.bg,
            font: { color: colors.font, size: 10, family: 'system-ui, sans-serif' },
            margin: narrow ? { l: 48, r: mixed ? 48 : 12, t: 24, b: 28 } : { l: 56, r: mixed ? 148 : 96, t: 6, b: 28 },
            showlegend: true,
            legend: narrow
                ? { orientation: 'h', x: 0, xanchor: 'left', y: 1, yanchor: 'bottom', font: { size: 10 } }
                : { x: mixed ? 1.13 : 1.01, xanchor: 'left', y: 1, font: { size: 10 } },
            xaxis: { gridcolor: colors.grid, type: datetime ? 'date' : 'linear', title: { text: datetime ? '' : (time.units || time.displayName) } },
            yaxis: { gridcolor: colors.grid, title: { text: units[0] || '' } },
            yaxis2: {
                gridcolor: colors.grid,
                title: { text: units.slice(1).filter(Boolean).join(' / ') },
                overlaying: 'y',
                side: 'right',
                zeroline: false,
                showgrid: false,
                visible: mixed,
            },
        }, { displayModeBar: false, responsive: true }).then(() => {
            // As on the explorer's plots: the right button drags, a finger
            // pans and pinches (installed with every chart), the left button
            // zooms into a box and a double click resets.
            bindRightDragPan(chart);
            if (!chart._griddedNoMenu) {
                chart._griddedNoMenu = true;
                chart.addEventListener('contextmenu', event => event.preventDefault());
            }
        });
    };

    /**
     * The checked extractions in the explorer's plots. The first time they
     * get a panel of their own; after that, the same panel is brought up to
     * date — curves that were unchecked or removed leave it, new ones join —
     * instead of a new panel for every trip between the map and the plots.
     * Only curves of this map's extractions are touched there.
     */
    proto._griddedPlotChecked = function(view) {
        const names = this._griddedCheckedSeries(view).map(item => item.variable.name);
        if (!names.length) return;
        this._griddedState().returnFileId = view.fileId;
        this._hideGriddedView();
        const manager = this.plotManager;
        const own = trace => trace.fileId === view.fileId && String(trace.varName).startsWith('grid:x');
        const panelId = [view.plotPanelId, ...manager.plots.keys()]
            .find(id => id !== undefined && manager.plots.get(id)?.mode === 'timeseries'
                && manager.plots.get(id).traces.some(own));
        // One curve at a time, each after the previous panel has drawn: the
        // first may split the layout, and a split re-renders every panel,
        // which must not overlap another trace being added.
        const settle = () => new Promise(resolve => setTimeout(() => requestAnimationFrame(() => resolve()), 120));
        (async () => {
            await settle();
            if (panelId !== undefined) {
                view.plotPanelId = panelId;
                const plot = manager.plots.get(panelId);
                const stale = plot.traces.filter(own).filter(item => !names.includes(item.varName)).map(item => item.varName);
                // New curves first, so the panel is never left empty (and
                // cleared) between the two steps.
                const panelEl = document.querySelector(`.layout-panel[data-id="${panelId}"]`);
                for (const name of names.filter(item => !plot.traces.some(trace => own(trace) && trace.varName === item))) {
                    if (panelEl) manager.withActiveFile(view.fileId, () => manager.addTrace(panelId, name, panelEl));
                    await settle();
                }
                for (const name of stale) {
                    manager.removeTrace(panelId, name, view.fileId);
                    await settle();
                }
                return;
            }
            this._plotDerivedDatasetVariable?.(view.fileId, names[0]);
            const first = { fileId: view.fileId, name: names[0] };
            for (const name of names.slice(1)) {
                await settle();
                this._plotDerivedDatasetVariable?.(view.fileId, name, { alongside: first });
            }
            await settle();
            view.plotPanelId = [...manager.plots.keys()]
                .find(id => manager.plots.get(id)?.traces.some(trace => own(trace) && trace.varName === names[0]));
        })();
    };

    // ─── Export ───────────────────────────────────────────────────────────
    // The same dialog as every plot panel's download button: CSV for the
    // numbers, PNG or SVG for the figure, with quality and theme.

    proto._griddedExportMap = async function(view) {
        const div = this._griddedEl('map');
        if (!view.map || !div?._fullLayout) return;
        const { default: PlotExportDialog } = await import('../../ui/plot-export-dialog.js');
        const stem = `${safeFileStem(this.files.get(view.fileId)?.name)}_${safeFileStem(this._griddedMapTitle(view))}`;
        const result = await PlotExportDialog.open({
            contextLabel: this._griddedMapTitle(view),
            charts: [{ id: 'map', label: i18n.t('griddedExportMapChart'), width: div.clientWidth, height: div.clientHeight }],
            defaultChartId: 'map',
            defaultBaseName: () => stem,
        });
        if (!result) return;
        if (result.format === 'csv') {
            this._griddedExportMapCsv(view, result.fileName);
            return;
        }
        await this._griddedExportImage(div, result, theme => this._griddedDrawMap(view, theme), () => this._griddedDrawMap(view));
    };

    proto._griddedExportSeries = async function(view) {
        if (!(view.groups || []).length) return;
        const chart = this._griddedEl('preview-chart');
        const { default: PlotExportDialog } = await import('../../ui/plot-export-dialog.js');
        const drawn = !this._griddedEl('preview').hidden && chart?._fullLayout;
        const stem = `${safeFileStem(this.files.get(view.fileId)?.name)}_series`;
        const result = await PlotExportDialog.open({
            contextLabel: i18n.t('griddedResultsHeading'),
            charts: drawn ? [{ id: 'series', label: i18n.t('griddedPreviewTitle'), width: chart.clientWidth, height: chart.clientHeight }] : [],
            defaultChartId: 'series',
            defaultBaseName: () => stem,
        });
        if (!result) return;
        if (result.format === 'csv') {
            this._griddedExportSeriesCsv(view, result.fileName);
            return;
        }
        const redraw = () => this._griddedDrawPreview(view);
        await this._griddedExportImage(chart, result, ({ theme, transparent }) => {
            const realTheme = this.theme;
            this.theme = theme;
            try { this._griddedDrawPreview(view); } finally { this.theme = realTheme; }
            if (transparent) return Plotly.relayout(chart, { paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)' });
            return null;
        }, redraw);
    };

    proto._griddedExportImage = async function(div, { format, scale, theme, fileName }, drawAs, restore) {
        const preset = {
            current: { theme: this.theme, transparent: false },
            light: { theme: 'light', transparent: false },
            dark: { theme: 'dark', transparent: false },
            'light-transparent': { theme: 'light', transparent: true },
        }[theme] || { theme: this.theme, transparent: false };
        const changed = preset.theme !== this.theme || preset.transparent;
        try {
            if (changed) await drawAs({ theme: preset.theme, transparent: preset.transparent });
            const dataUrl = await Plotly.toImage(div, {
                format,
                width: div.clientWidth,
                height: div.clientHeight,
                scale: format === 'png' ? scale : 1,
            });
            const blob = await (await fetch(dataUrl)).blob();
            downloadBlob(blob, fileName);
        } catch (error) {
            Modal.alert(i18n.t('exportFailedTitle'), i18n.t('exportFailedBody'), {
                details: error?.message || String(error),
                detailsLabel: i18n.t('exportFailedDetails'),
            });
        } finally {
            if (changed) await restore();
        }
    };

    proto._griddedExportMapCsv = function(view, fileName) {
        const map = view.map;
        if (!map) return;
        const variable = this._griddedVariable(view);
        const rows = [
            `# ${this._griddedMapTitle(view)}${variable?.units ? ` [${variable.units}]` : ''}`,
            ['lat \\ lon', ...Array.from(map.lon, value => Number(value.toPrecision(10)))].map(csvCell).join(','),
        ];
        for (let row = map.ny - 1; row >= 0; row--) {
            const values = [Number(map.lat[row].toPrecision(10))];
            for (let column = 0; column < map.nx; column++) {
                const value = map.values[row * map.nx + column];
                values.push(Number.isFinite(value) ? Number(value.toPrecision(7)) : '');
            }
            rows.push(values.join(','));
        }
        downloadBlob(new Blob([rows.join('\n') + '\n'], { type: 'text/csv' }), fileName);
    };

    proto._griddedExportSeriesCsv = function(view, fileName) {
        const data = this.plotManager.files.get(view.fileId)?.data;
        if (!data) return;
        const time = data.variables[data.metadata.timeName];
        const checked = this._griddedCheckedSeries(view).map(item => item.variable);
        const columns = checked.length ? checked : (view.groups || []).flatMap(group => group.sets.flatMap(set => set.names.map(name => data.variables[name]).filter(Boolean)));
        if (!columns.length) return;
        const datetime = time.timeKind === 'datetime';
        const header = [time.displayName, ...columns.map(variable => `${variable.displayName}${variable.units ? ` [${variable.units}]` : ''}`)];
        const lines = [header.map(csvCell).join(',')];
        for (let index = 0; index < time.data.length; index++) {
            const cells = [datetime ? new Date(time.data[index]).toISOString() : time.data[index]];
            for (const variable of columns) {
                const value = variable.data[index];
                cells.push(Number.isFinite(value) ? value : '');
            }
            lines.push(cells.map(csvCell).join(','));
        }
        downloadBlob(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }), fileName);
    };

    /**
     * After "Open checked series in the plots", a button over the plots says
     * the map is still there and brings it back — the globe on the file's row
     * alone was too easy to miss.
     */
    proto._griddedSyncReturnButton = function() {
        const host = document.querySelector('.content-area');
        if (!host) return;
        let button = document.getElementById('gridded-return');
        const state = this._griddedState();
        const activeId = this.plotManager?.activeFileId;
        const entry = activeId ? this.files.get(activeId) : null;
        // Only after the map handed its series to the plots: a map closed
        // with "Close map" stays closed (its file row's Map button opens it).
        const show = !!entry?.gridded && state.returnFileId === activeId && state.visibleFileId !== activeId;
        if (!show) {
            if (button) button.hidden = true;
            return;
        }
        if (!button) {
            button = document.createElement('button');
            button.type = 'button';
            button.id = 'gridded-return';
            button.className = 'gridded-return';
            button.addEventListener('click', () => {
                const fileId = this.plotManager.activeFileId;
                if (this.files.get(fileId)?.gridded) this._showGriddedView(fileId);
            });
            host.appendChild(button);
        }
        button.innerHTML = `${GLOBE_ICON}<span></span>`;
        button.querySelector('span').textContent = i18n.t('griddedReturnToMap').replace('{file}', this._fileDisplayName(entry));
        button.title = i18n.t('griddedReturnToMapTitle');
        button.hidden = false;
    };

    proto._griddedApplyTheme = function() {
        const view = this._griddedVisibleView();
        if (!view) return;
        this._griddedDrawMap(view);
        this._griddedDrawPreview(view);
    };
}
