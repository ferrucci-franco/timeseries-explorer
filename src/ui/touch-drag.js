// The DOM half of dragging with a finger (#110).
//
// `createTouchDragGesture` decides WHEN a press becomes a drag; this carries it
// out: the chip that follows the finger so there is something to aim with, the
// hit test under it, and the drop. One finger only — a second one on the screen
// means the user is doing something else (pinching the plot behind), and the
// drag steps out of the way rather than fighting it.

import { createTouchDragGesture } from '../utils/touch-drag-gesture.js';

/** Does this pointer even have a finger behind it? */
export function isTouchCapable() {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
    return (Number(navigator.maxTouchPoints) || 0) > 0 || 'ontouchstart' in window;
}

function makeChip(label, count) {
    const chip = document.createElement('div');
    chip.className = 'touch-drag-chip';
    chip.textContent = count > 1 ? `${label} +${count - 1}` : label;
    chip.setAttribute('aria-hidden', 'true');
    document.body.appendChild(chip);
    return chip;
}

/**
 * Make one element draggable by touch.
 *
 * @param {HTMLElement} element
 * @param {{
 *   canDrag?: () => boolean,
 *   payload: () => ({names: string[], label?: string, fileId?: string}|null),
 *   onStart?: () => void,
 *   onMove?: (point: {clientX: number, clientY: number, target: Element|null}) => void,
 *   onDrop: (payload: object, point: {clientX: number, clientY: number, target: Element|null}) => void,
 *   onEnd?: () => void,
 * }} handlers
 * @returns {() => void} removes the listeners again
 */
export function installTouchDragSource(element, handlers) {
    if (!element || typeof element.addEventListener !== 'function') return () => {};
    const gesture = createTouchDragGesture();
    let timer = null;
    let chip = null;
    let payload = null;

    const pointFrom = (touch) => {
        const clientX = touch?.clientX ?? 0;
        const clientY = touch?.clientY ?? 0;
        // The chip sits under the finger, so it would win every hit test.
        if (chip) chip.style.visibility = 'hidden';
        const target = document.elementFromPoint(clientX, clientY);
        if (chip) chip.style.visibility = '';
        return { clientX, clientY, target };
    };

    const stop = (silent = false) => {
        if (timer) { clearTimeout(timer); timer = null; }
        gesture.cancel();
        chip?.remove();
        chip = null;
        payload = null;
        element.classList.remove('touch-dragging');
        if (!silent) handlers.onEnd?.();
    };

    const onTouchStart = (event) => {
        if (event.touches.length !== 1) { stop(); return; }
        if (handlers.canDrag && !handlers.canDrag()) return;
        const touch = event.touches[0];
        gesture.start(touch.clientX, touch.clientY);
        timer = setTimeout(() => {
            timer = null;
            if (gesture.hold() !== 'dragging') return;
            payload = handlers.payload?.() || null;
            if (!payload?.names?.length) { stop(); return; }
            chip = makeChip(payload.label || payload.names[0], payload.names.length);
            const point = pointFrom(touch);
            chip.style.left = `${point.clientX}px`;
            chip.style.top = `${point.clientY}px`;
            element.classList.add('touch-dragging');
            handlers.onStart?.();
        }, gesture.holdMs);
    };

    const onTouchMove = (event) => {
        if (event.touches.length !== 1) { stop(); return; }
        const touch = event.touches[0];
        if (gesture.state() === 'pressing') {
            // A finger on its way somewhere else: let the list scroll.
            if (gesture.moved(touch.clientX, touch.clientY) === 'idle') stop(true);
            return;
        }
        if (gesture.state() !== 'dragging') return;
        // Now it is ours: the page must not scroll under the drag.
        event.preventDefault();
        const point = pointFrom(touch);
        if (chip) {
            chip.style.left = `${point.clientX}px`;
            chip.style.top = `${point.clientY}px`;
        }
        handlers.onMove?.(point);
    };

    const onTouchEnd = (event) => {
        const dragging = gesture.state() === 'dragging';
        const touch = event.changedTouches?.[0];
        const point = dragging ? pointFrom(touch) : null;
        const dropped = gesture.end() === 'drop';
        const carried = payload;
        stop();
        if (dropped && carried && point) {
            event.preventDefault();
            handlers.onDrop(carried, point);
        }
    };

    element.addEventListener('touchstart', onTouchStart, { passive: true });
    // Not passive: a drag has to be able to stop the page scrolling with it.
    element.addEventListener('touchmove', onTouchMove, { passive: false });
    element.addEventListener('touchend', onTouchEnd);
    element.addEventListener('touchcancel', () => stop());

    return () => {
        stop(true);
        element.removeEventListener('touchstart', onTouchStart);
        element.removeEventListener('touchmove', onTouchMove);
        element.removeEventListener('touchend', onTouchEnd);
    };
}
