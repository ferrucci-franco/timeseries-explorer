// Phone presentation: the app is laid out at a fixed virtual desktop size on a
// "stage" element, and one CSS transform scales that stage to fit the screen
// and turns it a quarter turn when the phone is upright — so the app always
// reads landscape whether or not the device will honour an orientation lock.
//
// Everything the user then does to that transform is a plain image zoom: two
// fingers anywhere outside a plot pinch and drag the whole app so the small
// print can be read. One finger is left alone, so buttons, lists and scrolling
// behave exactly as they do on the desktop. Inside a plot the fingers drive the
// axes instead (see ../plots/methods/touch-methods.js), which is why this
// listener sits on the bubble phase: the plot handler claims those touches at
// the capture phase and they never reach here.

import {
    fitStageGeometry,
    composeStageMatrix,
    matrixToCss,
    clampStageView,
    zoomStageView,
    panStageView,
    isPhoneViewport,
    setStageMatrix,
    resetStageMatrix,
    MIN_ZOOM,
} from './viewport-transform.js';

const FIT_VIEW = { zoom: MIN_ZOOM, panX: 0, panY: 0 };

// `?mobile=1` forces the phone stage on any screen and `?mobile=0` forces it
// off — the only way to exercise this layout on a desktop browser, and an
// escape hatch for a phone that would rather have the raw desktop page.
function readModeOverride(search = window.location.search) {
    const value = new URLSearchParams(search).get('mobile');
    if (value === '1' || value === 'true') return true;
    if (value === '0' || value === 'false') return false;
    return null;
}

function detectPhone() {
    const override = readModeOverride();
    if (override !== null) return override;
    return isPhoneViewport({
        width: window.innerWidth,
        height: window.innerHeight,
        coarsePointer: window.matchMedia?.('(pointer: coarse)').matches || false,
        maxTouchPoints: navigator.maxTouchPoints || 0,
    });
}

// Below this fraction of the window the visual viewport is the on-screen
// keyboard, not the browser's chrome. Re-fitting the whole app into the strip
// above a keyboard would be far worse than leaving it alone for the moment.
const KEYBOARD_SHRINK_RATIO = 0.6;

// What the user can actually SEE. iOS Safari's collapsible toolbars overlay the
// page instead of shrinking it, so window.innerHeight counts space that is
// behind the bar — in landscape, where the bar eats a large share of a short
// screen, that pushed the bottom of the app off the display. visualViewport
// reports the real thing; taking the smaller of the two leaves browsers without
// it exactly as they were.
function visibleViewport() {
    const vv = window.visualViewport;
    const width = window.innerWidth;
    const height = window.innerHeight;
    if (!vv) return { width, height, portrait: height > width };
    const usable = vv.height >= height * KEYBOARD_SHRINK_RATIO ? vv.height : height;
    return {
        width: Math.min(vv.width, width),
        height: Math.min(usable, height),
        // Orientation always comes from the window, never from the visible box:
        // a keyboard can make an upright phone's visible strip wider than tall.
        portrait: height > width,
    };
}

// `fullscreenEnabled` is the honest answer where it exists — Safari on an
// iPhone reports the webkit one as false while an iPad reports true.
function fullscreenAvailable() {
    const root = document.documentElement;
    const hasMethod = typeof root.requestFullscreen === 'function'
        || typeof root.webkitRequestFullscreen === 'function';
    const enabled = document.fullscreenEnabled ?? document.webkitFullscreenEnabled ?? true;
    return hasMethod && enabled !== false;
}

function touchPoints(event, count = 2) {
    const points = [];
    for (let i = 0; i < Math.min(count, event.touches.length); i++) {
        points.push({ x: event.touches[i].clientX, y: event.touches[i].clientY });
    }
    return points;
}

class MobileViewport {
    constructor(stage, options = {}) {
        this.stage = stage;
        this.onStageResize = options.onStageResize || null;
        this.view = { ...FIT_VIEW };
        this.geometry = null;
        this.gesture = null;
        this.frame = 0;
        this.controls = null;
        this.fitButton = null;
        this.fullscreenButton = null;
    }

    start() {
        document.documentElement.classList.add('phone-stage');
        this.claimBrowserZoom();
        this.controls = document.getElementById('mobile-view-controls');
        this.fitButton = document.getElementById('mobile-fit-btn');
        this.fullscreenButton = document.getElementById('mobile-fullscreen-btn');
        // An iPhone has no element fullscreen at all, so the button was dead
        // there — and being the only one visible until something is zoomed, it
        // read as the app's controls being broken. Better absent than dead.
        if (!fullscreenAvailable()) {
            this.fullscreenButton?.remove();
            this.fullscreenButton = null;
        }
        this.layout();
        this.bind();
        // Worth asking for even though it only lands on Android in fullscreen:
        // where it works the phone stops rotating under the user, and where it
        // does not the quarter turn above already keeps the app landscape.
        this.requestOrientationLock();
        return this;
    }

    // Only once the phone stage is actually running: a tablet or a touch laptop
    // stays on the desktop layout and keeps the browser's own pinch, which is
    // the only zoom it has.
    claimBrowserZoom() {
        const meta = document.getElementById('viewport-meta');
        if (!meta) return;
        meta.setAttribute('content', `${meta.getAttribute('content')}, maximum-scale=1.0, user-scalable=no`);
    }

    layout({ resetView = false } = {}) {
        const wasPortrait = this.geometry?.rotation === 90;
        const box = visibleViewport();
        this.geometry = fitStageGeometry(box.width, box.height, { portrait: box.portrait });
        const flipped = wasPortrait !== (this.geometry.rotation === 90);
        // A pinch survives the address bar sliding away, but not the phone
        // being physically turned over — the old pan would point nowhere.
        this.view = (resetView || flipped)
            ? { ...FIT_VIEW }
            : clampStageView(this.view, this.geometry);
        this.stage.style.width = `${this.geometry.stageWidth}px`;
        this.stage.style.height = `${this.geometry.stageHeight}px`;
        // The ruler for everything laid out inside: `vw`/`vh` would measure the
        // phone, which is a different — and, under Safari's per-site page zoom,
        // wildly different — number from the stage the layout occupies.
        this.stage.style.setProperty('--app-vw', `${this.geometry.stageWidth}px`);
        this.stage.style.setProperty('--app-vh', `${this.geometry.stageHeight}px`);
        this.apply();
        this.onStageResize?.();
    }

    apply() {
        const matrix = composeStageMatrix(this.geometry, this.view);
        this.stage.style.transform = matrixToCss(matrix);
        // Published so the plot gestures can undo the scale and the rotation
        // when they turn finger movement into axis units, and so popovers know
        // what box their `position: fixed` resolves against.
        setStageMatrix(matrix, { width: this.geometry.stageWidth, height: this.geometry.stageHeight });
        this.controls?.classList.toggle('is-zoomed', this.view.zoom > MIN_ZOOM + 1e-6);
    }

    scheduleApply() {
        if (this.frame) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.apply();
        });
    }

    fit() {
        this.view = { ...FIT_VIEW };
        this.apply();
    }

    bind() {
        let resizeFrame = 0;
        const onResize = () => {
            if (resizeFrame) cancelAnimationFrame(resizeFrame);
            resizeFrame = requestAnimationFrame(() => {
                resizeFrame = 0;
                this.layout();
            });
        };
        window.addEventListener('resize', onResize);
        window.addEventListener('orientationchange', onResize);
        // The toolbar sliding in or out never fires a window resize on iOS.
        window.visualViewport?.addEventListener('resize', onResize);

        document.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
        document.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        document.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
        document.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { passive: false });

        this.fitButton?.addEventListener('click', () => this.fit());
        this.fullscreenButton?.addEventListener('click', () => this.toggleFullscreen());
    }

    onTouchStart(event) {
        if (event.touches.length !== 2) return;
        const points = touchPoints(event);
        this.gesture = {
            startPoints: points,
            startDistance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
            startMidX: (points[0].x + points[1].x) / 2,
            startMidY: (points[0].y + points[1].y) / 2,
            startView: { ...this.view },
        };
    }

    onTouchMove(event) {
        if (!this.gesture || event.touches.length < 2) return;
        event.preventDefault();
        const points = touchPoints(event);
        const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
        const midX = (points[0].x + points[1].x) / 2;
        const midY = (points[0].y + points[1].y) / 2;
        const factor = this.gesture.startDistance > 0 ? distance / this.gesture.startDistance : 1;
        // Both the zoom and the pan are measured from the start of the gesture
        // rather than from the previous frame, so rounding cannot accumulate
        // into a slow drift under the fingers.
        const zoomed = zoomStageView(
            this.gesture.startView, factor,
            this.gesture.startMidX, this.gesture.startMidY,
            this.geometry,
        );
        this.view = panStageView(
            zoomed,
            midX - this.gesture.startMidX,
            midY - this.gesture.startMidY,
            this.geometry,
        );
        this.scheduleApply();
    }

    onTouchEnd(event) {
        if (event.touches.length >= 2) return;
        this.gesture = null;
    }

    async requestOrientationLock() {
        try {
            await screen.orientation?.lock?.('landscape');
        } catch {
            // Refused off fullscreen (Android) or unimplemented (iOS, desktop).
            // The quarter turn in the stage transform covers both cases.
        }
    }

    async toggleFullscreen() {
        try {
            if (document.fullscreenElement) {
                await document.exitFullscreen();
                screen.orientation?.unlock?.();
                return;
            }
            await document.documentElement.requestFullscreen?.();
            await this.requestOrientationLock();
        } catch {
            // Fullscreen can be refused outright (iOS Safari has no element
            // fullscreen on iPhone); the app is already usable without it.
        }
    }
}

export function initMobileViewport(options = {}) {
    const stage = document.getElementById('app-stage');
    if (!stage) return null;
    if (!detectPhone()) {
        resetStageMatrix();
        return null;
    }
    const viewport = new MobileViewport(stage, options).start();
    window.__mobileViewport = viewport;
    return viewport;
}

export { MobileViewport };
