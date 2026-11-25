// The app's own full screen: a button in the top bar and an exit pill.
//
// F11 is the browser's full screen: pointing at the top edge brings its tab
// and address bars back over the plots, and a page cannot change that. This
// uses the page's Fullscreen API instead, where the top edge shows no browser
// bar; the app shows its own semi-transparent pill there to leave.
//
// Ported from the owner's other apps (ferrucci-lab.com, `fullscreen.js`), this
// one piece only, into this app's own modules: the texts come from
// src/i18n/translations.js and the styles are in src/styles/base.css.
//
//   const fs = installAppFullscreen({ button, texts: () => ({ fullscreen, exitFullscreen, exitPill }) });
//   fs.refresh();   // after a language change
//
// The icon is a screen with two arrows, not four corners: the Auto-fit button
// beside it is a square of four corners already.
//
// Where the browser has no page full screen (iPhone Safari), the button is
// hidden. F11 is taken where the browser lets a page take it, and enters this
// mode instead. On entry the browser still shows its own short "press Esc"
// notice: a page cannot remove it.

const SCREEN = '<rect x="3" y="3.5" width="18" height="13" rx="2"/><path d="M8.5 20.5h7M12 16.5v4"/>';
const ICON_ENTER = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${SCREEN}<path d="M13.5 9l3-3M16.5 6H14M16.5 6v2.5M10.5 11l-3 3M7.5 14H10M7.5 14v-2.5"/></svg>`;
const ICON_EXIT = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${SCREEN}<path d="M17 5.5l-3 3M14 8.5h2.5M14 8.5V6M7 14.5l3-3M10 11.5H7.5M10 11.5V14"/></svg>`;
const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const DEFAULT_TEXTS = { fullscreen: 'Full screen', exitFullscreen: 'Exit full screen', exitPill: 'Exit full screen (Esc)' };
// Only the very top edge brings the pill back, as the browser would bring its
// bar back in F11 mode: pointing at the top bar's own buttons just below must
// not cover them.
const EDGE_PX = 6;

export function installAppFullscreen({ button = null, texts = null, doc = document } = {}) {
    const root = doc.documentElement;
    const currentTexts = () => ({ ...DEFAULT_TEXTS, ...(typeof texts === 'function' ? texts() : (texts || {})) });
    const enabled = !!(doc.fullscreenEnabled || doc.webkitFullscreenEnabled);
    if (!enabled || !(root.requestFullscreen || root.webkitRequestFullscreen)) {
        if (button) button.hidden = true;
        return { refresh() {}, isFullscreen: () => false, toggle() {} };
    }
    const isFullscreen = () => !!(doc.fullscreenElement || doc.webkitFullscreenElement);
    const swallow = (result) => { if (result && typeof result.catch === 'function') result.catch(() => {}); };
    const enter = () => swallow(root.requestFullscreen ? root.requestFullscreen({ navigationUI: 'hide' }) : root.webkitRequestFullscreen());
    const exit = () => swallow(doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen());
    const toggle = () => { try { if (isFullscreen()) exit(); else enter(); } catch (_) { /* refused by the browser */ } };

    const pill = doc.createElement('button');
    pill.type = 'button';
    pill.className = 'app-fullscreen-pill';
    doc.body.appendChild(pill);
    let hideTimer = 0;
    const hide = () => { clearTimeout(hideTimer); hideTimer = 0; pill.classList.remove('show'); };
    const show = (ms) => {
        clearTimeout(hideTimer);
        hideTimer = 0;
        pill.classList.add('show');
        if (ms) hideTimer = setTimeout(hide, ms);
    };

    function refresh() {
        const t = currentTexts();
        const on = isFullscreen();
        if (button) {
            const slot = button.querySelector('.icon') || button;
            slot.innerHTML = on ? ICON_EXIT : ICON_ENTER;
            button.title = on ? t.exitFullscreen : t.fullscreen;
            button.setAttribute('aria-label', button.title);
            button.setAttribute('aria-pressed', String(on));
            button.classList.toggle('active', on);
        }
        pill.innerHTML = `${ICON_CLOSE}<span></span>`;
        pill.lastChild.textContent = t.exitPill;
        pill.setAttribute('aria-label', t.exitFullscreen);
    }

    button?.addEventListener('click', (event) => { toggle(); if (event.detail) button.blur(); });
    pill.addEventListener('click', () => { hide(); exit(); });
    const onChange = () => { refresh(); if (isFullscreen()) show(2500); else hide(); };
    doc.addEventListener('fullscreenchange', onChange);
    doc.addEventListener('webkitfullscreenchange', onChange);

    // The pill goes away as soon as the pointer leaves it (and the band above
    // it) toward the page.
    let leaveTimer = 0;
    const stay = () => { clearTimeout(leaveTimer); leaveTimer = 0; };
    doc.addEventListener('mousemove', (event) => {
        if (!isFullscreen()) return;
        if (event.clientY <= EDGE_PX) { stay(); show(0); return; }
        if (!pill.classList.contains('show')) return;
        const box = pill.getBoundingClientRect();
        const near = event.clientY <= box.bottom + 4 && event.clientX >= box.left - 24 && event.clientX <= box.right + 24;
        if (pill.matches(':hover') || near) stay();
        else if (!leaveTimer) leaveTimer = setTimeout(() => { leaveTimer = 0; hide(); }, 250);
    }, { passive: true });
    doc.addEventListener('touchstart', (event) => {
        if (isFullscreen() && event.touches[0] && event.touches[0].clientY <= 16) show(3000);
    }, { passive: true });
    // F11: this full screen instead of the browser's, where the browser lets a
    // page take the key.
    doc.addEventListener('keydown', (event) => {
        if (event.key !== 'F11' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        event.preventDefault();
        toggle();
    }, true);

    refresh();
    return { refresh, isFullscreen, toggle };
}
