// Geometry for the phone "stage": the whole app is laid out at a fixed virtual
// desktop size and then mapped onto the physical screen with one CSS transform.
//
// Two things fall out of that single transform. The app always reads landscape
// — when the phone is held upright the stage is simply rotated a quarter turn,
// which is the only orientation lock that works everywhere (the native
// screen.orientation.lock is Android-and-fullscreen only, and absent on iOS).
// And because the fit is a scale, the user can pinch the result like an image
// to read the small print.
//
// Everything here is pure arithmetic on plain objects so it can be unit tested
// without a DOM; ../ui/mobile-viewport.js owns the elements and the listeners.

// The virtual width the app is laid out at. Bigger means more of the app on
// screen at once and smaller text; this is about a small laptop, which keeps
// the sidebar and one panel comfortably side by side.
export const DESIGN_WIDTH = 1152;

// A phone, as opposed to a tablet or a touch laptop: the short edge has to be
// narrow enough that the desktop layout genuinely does not fit. An iPad mini
// (744 CSS px across) stays on the normal layout.
export const PHONE_SHORT_EDGE_MAX = 560;

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 8;

export const IDENTITY_MATRIX = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function isPhoneViewport({ width, height, coarsePointer, maxTouchPoints = 0 } = {}) {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
    if (width <= 0 || height <= 0) return false;
    if (!coarsePointer && !(maxTouchPoints > 0)) return false;
    return Math.min(width, height) <= PHONE_SHORT_EDGE_MAX;
}

// The stage always has exactly the fit box's aspect ratio, so the fit leaves no
// letterbox on either side and `baseScale` is the same number for both axes.
//
// `portrait` is passed in rather than inferred whenever the caller knows the
// DEVICE orientation: an on-screen keyboard can leave a box that is wider than
// it is tall on a phone that is still upright, and inferring from the box would
// un-rotate the app mid-keystroke.
export function fitStageGeometry(viewportWidth, viewportHeight, options = {}) {
    const { designWidth = DESIGN_WIDTH } = options;
    const vw = Math.max(1, viewportWidth);
    const vh = Math.max(1, viewportHeight);
    const portrait = options.portrait ?? (vh > vw);
    const stageWidth = designWidth;
    // Rotated, the stage's long edge lies along the box's height, so which
    // dimension sets the scale swaps with the quarter turn.
    const stageHeight = portrait ? designWidth * (vw / vh) : designWidth * (vh / vw);
    const baseScale = (portrait ? vh : vw) / designWidth;
    return {
        stageWidth,
        stageHeight,
        baseScale,
        // A quarter turn clockwise puts the stage's long edge along the
        // phone's long edge; the translate afterwards pulls it back on screen,
        // because rotating about the top-left corner swings it out to the left.
        rotation: portrait ? 90 : 0,
        baseTx: portrait ? vw : 0,
        baseTy: 0,
        viewportWidth: vw,
        viewportHeight: vh,
    };
}

// M = translate(panX, panY) · scale(zoom) · translate(baseTx, baseTy)
//       · rotate(rotation) · scale(baseScale)
//
// The pan/zoom pair is the user's pinch and lives outside the fit, so it is a
// plain screen-space image transform: `panX`/`panY` are screen pixels and
// `zoom` is 1 at "fit to screen".
export function composeStageMatrix(geometry, view = { zoom: 1, panX: 0, panY: 0 }) {
    const zoom = Number.isFinite(view.zoom) ? view.zoom : 1;
    const panX = Number.isFinite(view.panX) ? view.panX : 0;
    const panY = Number.isFinite(view.panY) ? view.panY : 0;
    const scale = zoom * geometry.baseScale;
    // Only right angles ever occur, so the exact 0/1 avoids the 6e-17 that
    // Math.cos(Math.PI / 2) would smear through every inverse.
    const cos = geometry.rotation === 90 ? 0 : 1;
    const sin = geometry.rotation === 90 ? 1 : 0;
    return {
        a: scale * cos,
        b: scale * sin,
        c: -scale * sin,
        d: scale * cos,
        e: panX + zoom * geometry.baseTx,
        f: panY + zoom * geometry.baseTy,
    };
}

export function matrixToCss(m) {
    return `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;
}

// At zoom 1 the stage covers the viewport exactly, so the visible area is
// simply the viewport scaled by `zoom` and offset by the pan. Keeping that
// area over the viewport is what stops the app being flicked off screen.
export function clampStageView(view, geometry) {
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number.isFinite(view.zoom) ? view.zoom : 1));
    const minPanX = geometry.viewportWidth * (1 - zoom);
    const minPanY = geometry.viewportHeight * (1 - zoom);
    return {
        zoom,
        panX: Math.min(0, Math.max(minPanX, Number.isFinite(view.panX) ? view.panX : 0)),
        panY: Math.min(0, Math.max(minPanY, Number.isFinite(view.panY) ? view.panY : 0)),
    };
}

// Zoom by `factor` while pinning whatever is under (anchorX, anchorY) — the
// midpoint between the two fingers — to that same screen point.
export function zoomStageView(view, factor, anchorX, anchorY, geometry) {
    const zoom = Number.isFinite(view.zoom) ? view.zoom : 1;
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
    const ratio = next / zoom;
    return clampStageView({
        zoom: next,
        panX: anchorX - ratio * (anchorX - view.panX),
        panY: anchorY - ratio * (anchorY - view.panY),
    }, geometry);
}

export function panStageView(view, dx, dy, geometry) {
    return clampStageView({ zoom: view.zoom, panX: view.panX + dx, panY: view.panY + dy }, geometry);
}

export function invertPoint(m, x, y) {
    const det = m.a * m.d - m.b * m.c;
    if (!det) return { x: 0, y: 0 };
    const px = x - m.e;
    const py = y - m.f;
    return { x: (m.d * px - m.c * py) / det, y: (-m.b * px + m.a * py) / det };
}

export function invertDelta(m, dx, dy) {
    const det = m.a * m.d - m.b * m.c;
    if (!det) return { x: 0, y: 0 };
    return { x: (m.d * dx - m.c * dy) / det, y: (-m.b * dx + m.a * dy) / det };
}

// ─── The live stage transform ────────────────────────────────────────────────
//
// Anything that reads a pointer position off the screen and then applies it in
// layout pixels — the plot touch gestures, above all — has to undo the stage
// transform first, or a pinch would pan the wrong axis the moment the phone is
// held upright. The current matrix is kept here rather than in the DOM module
// so those readers do not have to import the DOM module.

let currentMatrix = { ...IDENTITY_MATRIX };
let currentStageBox = null;

export function setStageMatrix(m, stageBox = null) {
    currentMatrix = m ? { ...m } : { ...IDENTITY_MATRIX };
    currentStageBox = stageBox ? { width: stageBox.width, height: stageBox.height } : currentStageBox;
}

export function resetStageMatrix() {
    currentMatrix = { ...IDENTITY_MATRIX };
    currentStageBox = null;
}

export function getStageMatrix() {
    return { ...currentMatrix };
}

// Screen pixels → stage (layout) pixels. Both are no-ops on desktop, where the
// stage matrix is the identity.
export function screenDeltaToStage(dx, dy) {
    return invertDelta(currentMatrix, dx, dy);
}

export function screenPointToStage(x, y) {
    return invertPoint(currentMatrix, x, y);
}

// ─── Where a `position: fixed` element actually lands ────────────────────────
//
// A transformed ancestor becomes the containing block for its fixed
// descendants, so on a phone every `position: fixed` popover INSIDE the stage
// is laid out against the stage rather than the window. Popovers that anchor
// themselves to an element they measured with getBoundingClientRect — which
// reports screen pixels — have to convert, and clamp against the stage too, or
// they open at a plausible-looking but wrong offset from what they explain.
//
// Both are the identity off the phone stage, and for popovers appended to
// <body> (which sits outside the stage) nothing changes either way.

export function fixedPositioningBox(windowWidth, windowHeight) {
    if (currentStageBox) return { ...currentStageBox };
    return { width: windowWidth, height: windowHeight };
}

export function screenRectToFixed(rect) {
    const a = screenPointToStage(rect.left, rect.top);
    const b = screenPointToStage(rect.right, rect.bottom);
    return {
        left: Math.min(a.x, b.x),
        top: Math.min(a.y, b.y),
        right: Math.max(a.x, b.x),
        bottom: Math.max(a.y, b.y),
    };
}
