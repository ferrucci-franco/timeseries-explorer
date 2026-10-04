/**
 * When the app switches to its phone layout (docs/phone-web-specification.md §3).
 *
 * Decided from the viewport alone, never the user agent. A phone held upright
 * is narrow; a phone held sideways is wide enough for the desktop layout but
 * far too short for it (844 × 390), which is why height counts too. Tablets
 * (short edge 744 px and up) keep the desktop layout.
 *
 * Pure, so it can be tested without a browser.
 */
export const COMPACT_MAX_WIDTH = 600;
export const COMPACT_MAX_HEIGHT = 500;

export const LAYOUT_OVERRIDES = Object.freeze(['auto', 'compact', 'full']);
export const LAYOUT_OVERRIDE_STORAGE_KEY = 'omv_layout_override';

export function normalizeLayoutOverride(value) {
    return LAYOUT_OVERRIDES.includes(value) ? value : 'auto';
}

export function viewportWantsCompact(width, height) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
    return width < COMPACT_MAX_WIDTH || height < COMPACT_MAX_HEIGHT;
}

export function shouldUseCompactLayout({ width, height, override = 'auto' } = {}) {
    const mode = normalizeLayoutOverride(override);
    if (mode === 'compact') return true;
    if (mode === 'full') return false;
    return viewportWantsCompact(width, height);
}

/**
 * The viewport size to decide with.
 *
 * A mobile browser that finds the page wider than the screen zooms out and
 * widens the layout viewport to fit it: a 390 px phone showing the desktop
 * layout reports innerWidth 810. Deciding from that number would keep the
 * desktop layout forever, since it is what makes the page wide. The screen's
 * own size is immune, so the window can never count as larger than the screen.
 * iOS reports the screen in portrait whatever the orientation, so it is turned
 * to match the window first.
 */
export function effectiveViewportSize({ innerWidth, innerHeight, screenWidth, screenHeight } = {}) {
    let width = Number(innerWidth);
    let height = Number(innerHeight);
    const sw = Number(screenWidth);
    const sh = Number(screenHeight);
    if (Number.isFinite(sw) && Number.isFinite(sh) && sw > 0 && sh > 0 && width > 0 && height > 0) {
        const landscape = width > height;
        const screenLong = Math.max(sw, sh);
        const screenShort = Math.min(sw, sh);
        width = Math.min(width, landscape ? screenLong : screenShort);
        height = Math.min(height, landscape ? screenShort : screenLong);
    }
    return { width, height };
}

/** Sideways: the navigation becomes a rail and sheets come in from the side. */
export function isLandscapeViewport(width, height) {
    return Number.isFinite(width) && Number.isFinite(height) && width > height;
}
