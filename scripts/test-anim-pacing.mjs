// A state animation shares the page with the hand using it (ui/anim-pacing.js).
import assert from 'node:assert/strict';

import {
    TOUCH_RELEASE_HOLD_MS,
    animHeldByTouch,
    installAnimTouchHold,
    nextFrameAt,
    resetAnimTouchHold,
} from '../src/ui/anim-pacing.js';

// ── A frame waits as long as the last one took ──────────────────────────────
assert.equal(nextFrameAt(1000, 100), 1100, 'a 100 ms frame leaves the page 100 ms to itself');
assert.equal(nextFrameAt(1000, 2), 1002, 'a cheap frame (the desktop) changes nothing that matters');
assert.equal(nextFrameAt(1000, NaN), 1000, 'an unmeasured frame waits for nothing');
assert.equal(nextFrameAt(1000, -5), 1000);

// ── A finger on the screen holds playback still ─────────────────────────────
const listeners = {};
const target = { addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); } };
resetAnimTouchHold();
installAnimTouchHold(target);
installAnimTouchHold(target);
assert.equal(listeners.touchstart.length, 1, 'listened for once per page');
assert.equal(animHeldByTouch(), false, 'no finger, no hold');

listeners.touchstart[0]({ touches: [{}] });
assert.equal(animHeldByTouch(), true, 'a finger down holds it');
assert.equal(animHeldByTouch(performance.now() + 60_000), true, 'for as long as the finger stays');

listeners.touchend[0]({ touches: [{}] });
assert.equal(animHeldByTouch(performance.now() + 60_000), true, 'a second finger still down keeps the hold');

listeners.touchend[0]({ touches: [] });
const lifted = performance.now();
assert.equal(animHeldByTouch(lifted), true, 'just lifted: Safari is still turning the tap into a click');
assert.equal(animHeldByTouch(lifted + TOUCH_RELEASE_HOLD_MS + 5), false, 'and then it plays on');

listeners.touchstart[0]({ touches: [{}] });
listeners.touchcancel[0]({ touches: [] });
assert.equal(animHeldByTouch(performance.now() + TOUCH_RELEASE_HOLD_MS + 5), false, 'a cancelled touch ends it too');

console.log('anim pacing: ok');
