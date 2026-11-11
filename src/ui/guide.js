// Animated guide: short demos of features that are easy to miss.
//
// The real app runs in a frame, in demo mode (src/app/demo-mode.js: nothing is
// read from or saved to the browser), and a script drives it with the same
// pointer, drag and key events a person would make. A pointer is drawn over it,
// a camera zooms on the part that matters, and each step has one short caption.
// Each demo loops, like an animated picture; the list (or ‹ ›) chooses another.
//
// The demos themselves are in guide-chapters.js. This file is the window and
// the driver: nothing in it knows what any demo shows.
//
// The same demos can be opened one at a time, by id: `guide.open('fft')`. That
// is what a "tip of the day" would call.

import i18n from '../i18n/index.js';
import { GUIDE_CHAPTERS, GUIDE_GROUPS } from './guide-chapters.js';

const ABORT = { abort: true };

// The size of the app inside the frame, in its own pixels. Scaled to the room
// there is; the camera brings the part being shown back to a readable size.
const FRAME_WIDTH = 1120;
const FRAME_HEIGHT = 700;

const L = (o) => (o == null ? '' : typeof o === 'string' ? o : (o[i18n.currentLang] || o.en || ''));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ease = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const el = (tag, attrs, html) => {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (html != null) e.innerHTML = html;
    return e;
};

const TX = {
    title: { en: 'Animated guide', fr: 'Guide animé', es: 'Guía animada', it: 'Guida animata', zh: '动画指南' },
    prev: { en: 'Previous', fr: 'Précédent', es: 'Anterior', it: 'Precedente', zh: '上一个' },
    next: { en: 'Next', fr: 'Suivant', es: 'Siguiente', it: 'Successivo', zh: '下一个' },
    pause: { en: 'Pause', fr: 'Pause', es: 'Pausa', it: 'Pausa', zh: '暂停' },
    play: { en: 'Play', fr: 'Lecture', es: 'Reproducir', it: 'Riproduci', zh: '播放' },
    ref: { en: 'Full reference', fr: 'Référence complète', es: 'Referencia completa', it: 'Riferimento completo', zh: '完整参考' },
    close: { en: 'Close', fr: 'Fermer', es: 'Cerrar', it: 'Chiudi', zh: '关闭' },
    loading: { en: 'Loading…', fr: 'Chargement…', es: 'Cargando…', it: 'Caricamento…', zh: '加载中…' },
    chapters: { en: 'Topics', fr: 'Thèmes', es: 'Temas', it: 'Argomenti', zh: '主题' },
};

/** The guide needs to script a same-origin frame, which a page opened from disk cannot do. */
export function guideIsAvailable() {
    return typeof window !== 'undefined' && window.location?.protocol !== 'file:';
}

// ─── The driver of one demo (one run of one chapter) ───────────────────────

class Demo {
    constructor(guide, W) {
        this.guide = guide;
        this.W = W;
        this.doc = W.document;
        this.app = W.app;
        this.x = guide.VW * 0.6;
        this.y = guide.VH * 0.55;
        this.isDown = false;
        this.downEl = null;
        this.dead = false;
        this.inject();
    }

    L(o) { return L(o); }
    check() { if (this.dead) throw ABORT; }
    frame() { return new Promise((r) => requestAnimationFrame(r)).then(() => this.check()); }

    // Waits stop while the demo is paused.
    async wait(ms) {
        let elapsed = 0;
        let last = performance.now();
        while (elapsed < ms) {
            await this.frame();
            const now = performance.now();
            if (!this.guide.paused) elapsed += Math.min(100, now - last) * this.guide.speed;
            last = now;
        }
    }

    /** Wait for something the app does in its own time (a file parsed, a plot drawn). */
    async until(cond, ms = 8000) {
        const t0 = performance.now();
        for (;;) {
            let ok = false;
            try { ok = !!cond(); } catch (_) { ok = false; }
            if (ok) return true;
            if (performance.now() - t0 > ms) return false;
            await this.frame();
        }
    }

    $(s) { return this.doc.querySelector(s); }
    $$(s) { return Array.from(this.doc.querySelectorAll(s)); }

    /** The first visible element matching the selector whose text matches. */
    byText(selector, text) {
        const test = text instanceof RegExp ? (s) => text.test(s) : (s) => s.trim() === text;
        return this.$$(selector).find((e) => e.getClientRects().length && test(e.textContent || '')) || null;
    }

    // The pointer and the effects drawn inside the frame.
    inject() {
        const doc = this.doc;
        const st = doc.createElement('style');
        st.textContent = `
#gcur{position:fixed; left:0; top:0; z-index:2147483646; pointer-events:none; will-change:transform}
#gcur .arr{position:absolute; left:-3px; top:-2px; width:26px; height:30px; transform-origin:3px 2px; transform:scale(var(--k)); transition:transform .1s}
#gcur.down .arr{transform:scale(calc(var(--k) * .86))}
#gcur .chip{position:absolute; left:18px; top:22px; padding:3px 8px; border-radius:7px; background:#2563eb; color:#fff; font:600 12px/1.3 system-ui,sans-serif; white-space:nowrap; box-shadow:0 4px 12px rgba(0,0,0,.3); transform-origin:0 0; transform:scale(var(--k)); opacity:0; transition:opacity .12s}
#gcur.carry .chip{opacity:1}
.grip{position:fixed; z-index:2147483645; pointer-events:none; left:0; top:0; width:40px; height:40px; margin:-20px 0 0 -20px; border-radius:50%; border:3px solid #2563eb; animation:grip .55s ease-out forwards}
@keyframes grip{from{transform:scale(calc(var(--k) * .3)); opacity:.95} to{transform:scale(calc(var(--k) * 1.5)); opacity:0}}
.gmenu{position:fixed; z-index:2147483640; min-width:120px; max-height:260px; overflow:hidden; padding:4px; border-radius:8px; border:1px solid rgba(0,0,0,.25); background:#fff; color:#111; font:14px/1.3 system-ui,sans-serif; box-shadow:0 10px 30px rgba(0,0,0,.3)}
.gmenu div{padding:5px 10px; border-radius:5px; white-space:nowrap}
.gmenu div.cur{font-weight:600}
.gmenu div.hot{background:#2563eb; color:#fff}
body.theme-dark .gmenu{background:#2b2b2b; color:#eee; border-color:rgba(255,255,255,.25)}
html.demo *{scroll-behavior:auto !important}`;
        doc.head.appendChild(st);
        const c = doc.createElement('div');
        c.id = 'gcur';
        c.innerHTML = '<svg class="arr" viewBox="0 0 26 30"><path d="M3 2 L3 24 L8.6 18.6 L12.6 27.6 L16.4 26 L12.5 17.2 L20.5 17.2 Z" fill="#111" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg><span class="chip"></span>';
        doc.body.appendChild(c);
        this.cur = c;
        this.chip = c.querySelector('.chip');
        this.k();
        this.draw();
    }

    // The pointer keeps a comfortable size on screen whatever the scale of the frame.
    k() {
        if (this.cur) this.cur.style.setProperty('--k', String(Math.max(0.9, Math.min(2.2, 1 / (this.guide.s0 * this.guide.cz)))));
    }
    draw() { this.cur.style.transform = `translate(${this.x}px, ${this.y}px)`; }
    ripple() {
        const r = this.doc.createElement('div');
        r.className = 'grip';
        r.style.left = `${this.x}px`;
        r.style.top = `${this.y}px`;
        r.style.setProperty('--k', this.cur.style.getPropertyValue('--k'));
        this.doc.body.appendChild(r);
        setTimeout(() => r.remove(), 700);
    }

    // A target: [x, y] pixels of the frame · 'selector' · element ·
    // {sel|el, ax, ay, dx, dy} a point of an element (ax, ay: 0…1 across it).
    pos(t) {
        if (Array.isArray(t)) return { x: t[0], y: t[1] };
        if (typeof t === 'string') {
            const e = this.$(t);
            if (!e) throw new Error(`guide: no ${t}`);
            t = { el: e };
        }
        if (t && t.nodeType === 1) t = { el: t };
        if (t && t.sel) {
            const e = this.$(t.sel);
            if (!e) throw new Error(`guide: no ${t.sel}`);
            t = { ...t, el: e };
        }
        if (t && t.el) {
            const r = t.el.getBoundingClientRect();
            return {
                x: r.left + r.width * (t.ax != null ? t.ax : 0.5) + (t.dx || 0),
                y: r.top + r.height * (t.ay != null ? t.ay : 0.5) + (t.dy || 0),
                el: t.el,
            };
        }
        throw new Error('guide: bad target');
    }

    rect(t) {
        // Several targets: the rectangle around all of them.
        if (Array.isArray(t) && t.length && typeof t[0] !== 'number') {
            const rs = t.map((q) => this.rect(q));
            const x0 = Math.min(...rs.map((r) => r.x));
            const y0 = Math.min(...rs.map((r) => r.y));
            const x1 = Math.max(...rs.map((r) => r.x + r.w));
            const y1 = Math.max(...rs.map((r) => r.y + r.h));
            return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        }
        if (typeof t === 'string') {
            const e = this.$(t);
            if (!e) throw new Error(`guide: no ${t}`);
            t = e;
        }
        if (t && t.nodeType === 1) {
            const r = t.getBoundingClientRect();
            return { x: r.left, y: r.top, w: r.width, h: r.height };
        }
        if (Array.isArray(t)) return { x: t[0], y: t[1], w: t[2], h: t[3] };
        const p = this.pos(t);
        return { x: p.x - 60, y: p.y - 60, w: 120, h: 120 };
    }

    // ── Events ──

    under() { return this.doc.elementFromPoint(this.x, this.y) || this.doc.body; }

    ptr(type, target) {
        const W = this.W;
        target.dispatchEvent(new W.PointerEvent(type, {
            bubbles: true, cancelable: true, composed: true, view: W,
            clientX: this.x, clientY: this.y, screenX: this.x, screenY: this.y,
            pointerId: 1, pointerType: 'mouse', isPrimary: true,
            button: type === 'pointermove' ? -1 : 0, buttons: this.isDown ? 1 : 0,
            ctrlKey: !!this.ctrl, metaKey: false,
        }));
    }

    mouse(type, target, extra) {
        const W = this.W;
        target.dispatchEvent(new W.MouseEvent(type, {
            bubbles: true, cancelable: true, composed: true, view: W,
            clientX: this.x, clientY: this.y, screenX: this.x, screenY: this.y,
            button: 0, buttons: this.isDown ? 1 : 0, detail: 1, ctrlKey: !!this.ctrl, metaKey: false, ...(extra || {}),
        }));
    }

    dragEvent(type, target) {
        const W = this.W;
        return target.dispatchEvent(new W.DragEvent(type, {
            bubbles: true, cancelable: true, composed: true, view: W,
            clientX: this.x, clientY: this.y, dataTransfer: this.dt,
        }));
    }

    // What a moving mouse tells the page: hover while it is up, a drag while down.
    // (Plotly reads mouse events, the app's own controls pointer events.)
    moved() {
        const e = this.under();
        if (this.dt) {
            // An HTML drag in progress: the page only hears drag events.
            if (e !== this.lastOver) {
                if (this.lastOver?.isConnected) this.dragEvent('dragleave', this.lastOver);
                this.dragEvent('dragenter', e);
                this.lastOver = e;
            }
            this.dragEvent('dragover', this.under());
            return;
        }
        this.ptr('pointermove', e);
        this.mouse('mousemove', e);
        if (!this.isDown && e !== this.lastHover) {
            if (this.lastHover?.isConnected) {
                this.ptr('pointerleave', this.lastHover);
                this.mouse('mouseout', this.lastHover, { relatedTarget: e });
            }
            this.mouse('mouseover', e, { relatedTarget: this.lastHover || null });
            this.lastHover = e;
        }
    }

    // ── Gestures ──

    async move(t, ms, curve) {
        const p = this.pos(t);
        const x0 = this.x;
        const y0 = this.y;
        const d = Math.hypot(p.x - x0, p.y - y0);
        if (ms == null) ms = Math.min(950, 260 + d * 0.95);
        let elapsed = 0;
        let last = performance.now();
        while (elapsed < ms) {
            await this.frame();
            const now = performance.now();
            if (!this.guide.paused) elapsed += Math.min(50, now - last) * this.guide.speed;
            last = now;
            const k = Math.min(1, elapsed / ms);
            const u = curve === 'out' ? 1 - Math.pow(1 - k, 3) : ease(k);
            this.x = x0 + (p.x - x0) * u;
            this.y = y0 + (p.y - y0) * u;
            this.draw();
            this.moved();
        }
        return p;
    }

    down() {
        const e = this.under();
        this.downEl = e;
        this.isDown = true;
        this.cur.classList.add('down');
        this.ptr('pointerdown', e);
        this.mouse('mousedown', e);
        const f = e.closest && e.closest('input, textarea, select, button');
        if (f) { try { f.focus({ preventScroll: true }); } catch (_) { /* not focusable */ } }
    }

    up(click) {
        const e = this.downEl;
        const over = this.under();
        this.isDown = false;
        this.cur.classList.remove('down');
        this.ptr('pointerup', over);
        this.mouse('mouseup', over);
        // A click needs the press and the release on the same element.
        if (click !== false && e && e.isConnected && (over === e || e.contains(over) || over.contains(e))) this.mouse('click', e);
        this.downEl = null;
    }

    // opts.ctrl: with Ctrl held (shown as a key on the screen).
    async tap(t, opts = {}) {
        if (t != null) await this.move(t, opts.ms);
        await this.wait(opts.pre != null ? opts.pre : 140);
        if (opts.ctrl) this.guide.showKey('Ctrl');
        this.ctrl = !!opts.ctrl;
        try {
            this.down();
            this.ripple();
            await this.wait(opts.hold || 90);
            this.up(opts.click);
        } finally {
            this.ctrl = false;
        }
        await this.wait(opts.after != null ? opts.after : 300);
    }

    // Press, move along the points, release (a zoom box on a plot, a splitter, a cursor).
    async drag(from, to, opts = {}) {
        if (from != null) await this.move(from);
        await this.wait(160);
        this.down();
        await this.wait(opts.pause || 140);
        const points = Array.isArray(to) && to.length && typeof to[0] !== 'number' ? to : [to];
        for (const p of points) await this.move(p, opts.ms, opts.curve);
        await this.wait(opts.end || 160);
        this.up(false);
        await this.wait(opts.after != null ? opts.after : 300);
    }

    // Drag something the page marks draggable (a variable of the tree) and drop
    // it on a target. The browser runs such a drag itself and tells the page
    // through drag events only, so those are the events sent here.
    async dragDrop(from, to, opts = {}) {
        const p = await this.move(from);
        const source = (p.el && p.el.closest('[draggable="true"]')) || this.under().closest('[draggable="true"]');
        if (!source) throw new Error('guide: nothing to drag here');
        await this.wait(160);
        this.cur.classList.add('down');
        this.ripple();
        this.ptr('pointerdown', this.under());
        this.mouse('mousedown', this.under());
        await this.wait(160);
        this.dt = new this.W.DataTransfer();
        this.lastOver = null;
        if (!this.dragEvent('dragstart', source)) {
            this.dt = null;
            this.cur.classList.remove('down');
            throw new Error('guide: the drag was refused');
        }
        this.chip.textContent = opts.label || source.dataset.varName || '';
        this.cur.classList.add('carry');
        try {
            const points = Array.isArray(to) && to.length && typeof to[0] !== 'number' ? to : [to];
            for (const q of points) await this.move(q, opts.ms != null ? opts.ms : 1100);
            await this.wait(opts.end != null ? opts.end : 350);
            // (the hint a panel shows while dragging replaces what is under the pointer)
            this.dragEvent('drop', this.under());
        } finally {
            if (source.isConnected) this.dragEvent('dragend', source);
            this.dt = null;
            this.lastOver = null;
            this.cur.classList.remove('carry', 'down');
        }
        await this.wait(opts.after != null ? opts.after : 500);
    }

    async key(k, label) {
        this.guide.showKey(label || (k.length === 1 ? k.toUpperCase() : k));
        const W = this.W;
        const tgt = this.doc.activeElement || this.doc.body;
        tgt.dispatchEvent(new W.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
        await this.wait(80);
        tgt.dispatchEvent(new W.KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true }));
        await this.wait(450);
    }

    // Typing in a field: a tap, the old text selected, the new one letter by letter, then Enter.
    async type(t, text, opts = {}) {
        const p = this.pos(t);
        await this.tap(t);
        const f = (p.el && p.el.closest('input, textarea')) || this.doc.activeElement;
        if (!f) return;
        try { f.focus({ preventScroll: true }); f.select(); } catch (_) { /* not text */ }
        await this.wait(250);
        const W = this.W;
        const setter = Object.getOwnPropertyDescriptor(f.tagName === 'TEXTAREA' ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype, 'value').set;
        const put = (v) => { setter.call(f, v); f.dispatchEvent(new W.Event('input', { bubbles: true })); };
        put('');
        let typed = '';
        for (const ch of text) {
            typed += ch;
            put(typed);
            await this.wait(opts.speed || 90);
        }
        await this.wait(200);
        if (opts.enter !== false) {
            this.guide.showKey('↵');
            f.dispatchEvent(new W.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            f.dispatchEvent(new W.Event('change', { bubbles: true }));
            await this.wait(400);
        } else if (opts.change !== false) {
            f.dispatchEvent(new W.Event('change', { bubbles: true }));
        }
    }

    // Choosing in a drop-down list. A script cannot open the browser's own
    // list, so a look-alike is drawn under the field: the pointer goes to the
    // option, and the field then takes the value as it would from a real pick.
    async choose(t, value, opts = {}) {
        const p = this.pos(t);
        const select = p.el && (p.el.tagName === 'SELECT' ? p.el : p.el.querySelector('select'));
        if (!select) throw new Error('guide: not a list');
        const options = Array.from(select.options).filter((o) => !o.hidden && !o.disabled);
        const pick = options.find((o) => o.value === value) || options.find((o) => o.textContent.trim() === value);
        if (!pick) throw new Error(`guide: no option ${value}`);
        await this.tap(select, { click: false, after: 120 });
        const r = select.getBoundingClientRect();
        const menu = this.doc.createElement('div');
        menu.className = 'gmenu';
        // Long lists show the neighbourhood of the option that is picked.
        const at = options.indexOf(pick);
        const first = Math.max(0, Math.min(at - 4, options.length - 9));
        const shown = options.slice(first, first + 9);
        for (const o of shown) {
            const row = this.doc.createElement('div');
            row.textContent = o.textContent;
            if (o.value === select.value) row.classList.add('cur');
            menu.appendChild(row);
        }
        menu.style.minWidth = `${r.width}px`;
        this.doc.body.appendChild(menu);
        const mh = menu.getBoundingClientRect().height;
        const mw = menu.getBoundingClientRect().width;
        const top = r.bottom + 2 + mh > this.guide.VH - 6 ? Math.max(6, r.top - 2 - mh) : r.bottom + 2;
        menu.style.left = `${Math.max(6, Math.min(r.left, this.guide.VW - mw - 6))}px`;
        menu.style.top = `${top}px`;
        try {
            await this.wait(opts.read != null ? opts.read : 450);
            const row = menu.children[shown.indexOf(pick)];
            await this.move(row, 420);
            row.classList.add('hot');
            await this.wait(220);
            this.ripple();
            this.cur.classList.add('down');
            await this.wait(110);
            this.cur.classList.remove('down');
        } finally {
            menu.remove();
        }
        select.value = pick.value;
        select.dispatchEvent(new this.W.Event('input', { bubbles: true }));
        select.dispatchEvent(new this.W.Event('change', { bubbles: true }));
        await this.wait(opts.after != null ? opts.after : 500);
    }

    // Dragging the thumb of a slider to a value (the page hears `input` on the way).
    async slide(t, value, opts = {}) {
        const p = this.pos(t);
        const input = p.el;
        if (!input || input.type !== 'range') throw new Error('guide: not a slider');
        const min = Number(input.min || 0);
        const max = Number(input.max || 100);
        const from = Number(input.value);
        const to = Math.max(min, Math.min(max, value));
        const r = input.getBoundingClientRect();
        const pad = 8;
        const xOf = (v) => r.left + pad + (r.width - 2 * pad) * ((v - min) / ((max - min) || 1));
        const y = r.top + r.height / 2;
        await this.move([xOf(from), y]);
        await this.wait(160);
        this.cur.classList.add('down');
        this.ripple();
        const ms = opts.ms || 900;
        const setter = Object.getOwnPropertyDescriptor(this.W.HTMLInputElement.prototype, 'value').set;
        let elapsed = 0;
        let last = performance.now();
        while (elapsed < ms) {
            await this.frame();
            const now = performance.now();
            if (!this.guide.paused) elapsed += Math.min(50, now - last) * this.guide.speed;
            last = now;
            const v = from + (to - from) * ease(Math.min(1, elapsed / ms));
            setter.call(input, String(v));
            input.dispatchEvent(new this.W.Event('input', { bubbles: true }));
            this.x = xOf(Number(input.value));
            this.y = y;
            this.draw();
        }
        setter.call(input, String(to));
        input.dispatchEvent(new this.W.Event('input', { bubbles: true }));
        input.dispatchEvent(new this.W.Event('change', { bubbles: true }));
        this.cur.classList.remove('down');
        await this.wait(opts.after != null ? opts.after : 400);
    }

    // Scroll the panel that holds this element so that the element is in view, smoothly.
    async reveal(t, ms = 500) {
        const e = typeof t === 'string' ? this.$(t) : t;
        if (!e) return null;
        let p = e.parentElement;
        while (p && p !== this.doc.body && !(p.scrollHeight > p.clientHeight + 2 && /(auto|scroll)/.test(this.W.getComputedStyle(p).overflowY))) p = p.parentElement;
        if (p && p !== this.doc.body) {
            const er = e.getBoundingClientRect();
            const pr = p.getBoundingClientRect();
            let delta = 0;
            if (er.bottom > pr.bottom - 12) delta = er.bottom - pr.bottom + 12 + Math.min(60, pr.height / 4);
            else if (er.top < pr.top + 12) delta = er.top - pr.top - 12;
            if (delta) {
                const y0 = p.scrollTop;
                const y1 = Math.max(0, Math.min(p.scrollHeight - p.clientHeight, y0 + delta));
                const n = Math.max(1, Math.round(ms / 16));
                for (let i = 1; i <= n; i++) {
                    await this.frame();
                    p.scrollTop = y0 + (y1 - y0) * ease(i / n);
                }
            }
        }
        this.unscroll();
        return e;
    }

    // (scrolling inside the frame must never scroll the guide around it)
    unscroll() {
        for (const e of [this.guide.screen, this.guide.stagewrap, this.guide.win, document.scrollingElement]) {
            if (e) { e.scrollTop = 0; e.scrollLeft = 0; }
        }
    }

    say(o) { this.guide.caption(L(o)); }

    // The camera: null = the whole frame; else a zoom on the target(s).
    async cam(t, scale, ms) {
        if (t == null) this.guide.setCam(null);
        else this.guide.setCam(this.rect(t), scale);
        await this.wait(ms != null ? ms : 800);
    }

    // ── What the demos ask of the app ──

    /** Open a file the way a drop on the window would, and wait until it is in. */
    async loadFile(name, content) {
        const before = this.app.files.size;
        const file = new this.W.File([content], name);
        await this.app.loadFile(file);
        await this.until(() => this.app.files.size > before && this.$('#variables-tree .tree-item'), 15000);
        await this.wait(120);
    }

    async loadText(name, text) { return this.loadFile(name, text); }

    /** A file shipped with the app, under public/. */
    async loadPublic(path, name) {
        const base = this.W.__OMV_PUBLIC_BASE__ || './';
        const response = await this.W.fetch(`${base}${path}`);
        if (!response.ok) throw new Error(`guide: cannot fetch ${path}`);
        return this.loadFile(name || path.split('/').pop(), await response.arrayBuffer());
    }

    /**
     * A result file the app ships as a script holding base64 (the 🧪 examples:
     * examples/example-data.js), opened as the file it was made from.
     */
    async loadBundledResult(scriptPath, name) {
        const base = this.W.__OMV_PUBLIC_BASE__ || './';
        const response = await this.W.fetch(`${base}${scriptPath}`);
        if (!response.ok) throw new Error(`guide: cannot fetch ${scriptPath}`);
        const text = await response.text();
        const b64 = (text.match(/"([A-Za-z0-9+/=]{100,})"/) || [])[1];
        if (!b64) throw new Error(`guide: no data in ${scriptPath}`);
        const binary = this.W.atob(b64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return this.loadFile(name, bytes);
    }

    panels() { return this.$$('.layout-panel'); }
    panel(i = 0) { return this.panels()[i] || null; }

    /** The row of a variable in the tree, scrolled into view. */
    async variable(name) {
        const item = this.$$('#variables-tree .tree-item').find((e) => e.dataset.varName === name)
            || this.$$('#variables-tree .tree-item').find((e) => (e.querySelector('.tree-label')?.textContent || '').trim() === name);
        if (!item) throw new Error(`guide: no variable ${name}`);
        await this.reveal(item);
        return item;
    }

    /** Open or close a folder of the tree by its label. */
    async folder(label) {
        // (the same label can be in every branch, "Static attributes": the one in view)
        const item = this.$$('#variables-tree .tree-item').find((e) => !e.dataset.varName
            && e.getClientRects().length
            && (e.querySelector('.tree-label')?.textContent || '').trim() === label);
        if (!item) throw new Error(`guide: no folder ${label}`);
        await this.reveal(item);
        await this.tap({ el: item.querySelector('.tree-label') || item });
        return item;
    }

    /**
     * Select these variables of the tree: a click to clear what was selected,
     * then Ctrl+click on each, in order (the order is the X, Y, Z of a phase plot).
     */
    async select(names) {
        if (this.app.selectedVariables?.size) {
            const first = await this.variable(names[0]);
            await this.tap({ el: first.querySelector('.tree-label') || first }, { after: 200 });
        }
        for (const name of names) {
            const item = await this.variable(name);
            await this.tap({ el: item.querySelector('.tree-label') || item }, { ctrl: true, after: 220 });
        }
    }

    /**
     * Press one of a panel's mode buttons: 'timeseries', 'dashboard', 'phase2d',
     * 'phase2dt', 'phase3d', 'state-anim' (dim 2 or 3). A change that empties the
     * panel asks first; the demo confirms.
     */
    async mode(mode, { dim = null, panelIndex = 0 } = {}) {
        const panel = this.panel(panelIndex);
        const selector = `.mode-btn[data-mode="${mode}"]${dim ? `[data-state-anim-dim="${dim}"]` : ''}`;
        const button = panel?.querySelector(selector);
        if (!button) throw new Error(`guide: no mode button ${mode}`);
        await this.tap(button);
        const confirm = () => panel.querySelector('.mode-change-warning-btn.confirm');
        if (await this.until(confirm, 600)) {
            await this.wait(700);
            await this.tap(confirm());
        }
        await this.until(() => panel.querySelector(selector)?.classList.contains('active'), 3000);
        await this.wait(250);
    }

    /** Drag a variable from the tree onto a panel (ax, ay: where on the panel). */
    async plot(name, panelIndex = 0, { ax = 0.4, ay = 0.5, ...opts } = {}) {
        const item = await this.variable(name);
        const panel = this.panel(panelIndex);
        if (!panel) throw new Error(`guide: no panel ${panelIndex}`);
        await this.dragDrop({ el: item.querySelector('.tree-label') || item }, { el: panel, ax, ay }, { label: name.split('.').pop(), ...opts });
    }

    // Turn an analysis of a time-series panel on: 'fft', 'histogram', 'heatmap',
    // 'temporal-profile', 'integral'; 'timeseries' turns it off.
    //
    // THE ONE PLACE that knows where the analyses are in the toolbar. When that
    // moves (they are being made easier to find), this is what to change — the
    // demos only say which analysis they want.
    async analysis(mode, panelIndex = 0) {
        const panel = this.panel(panelIndex);
        const button = panel?.querySelector('.timeseries-analysis-menu-btn');
        if (!button) throw new Error('guide: no analysis button');
        await this.tap(button);
        await this.until(() => this.$('.panel-analysis-menu'), 2000);
        // The gallery is larger than the zoom on the toolbar: all of it in view.
        if (this.guide.camR) await this.cam([button, this.$('.panel-analysis-menu')], 1.15, 700);
        await this.wait(500);
        const item = this.$(`.panel-analysis-menu .marks-menu-item[data-mark="${mode}"]`);
        if (!item) throw new Error(`guide: no analysis ${mode}`);
        await this.tap(item, { after: 200 });
        await this.until(() => panel.querySelector('.timeseries-analysis-menu-btn')?.dataset.mode === mode, 4000);
    }
}

// ─── The window ────────────────────────────────────────────────────────────

class Guide {
    constructor(app) {
        this.app = app;
        this.paused = false;
        this.cz = 1;
        this.s0 = 1;
        this.idx = 0;
        this.runId = 0;
        this.dur = {};
        // 1 = the pace of a person. The end-to-end check plays faster.
        this.speed = 1;
        // How many demos have played to their end, and the last one that failed:
        // what scripts/e2e-guide.mjs reads.
        this.loops = 0;
        this.lastError = null;
        this.VW = FRAME_WIDTH;
        this.VH = FRAME_HEIGHT;
    }

    build() {
        const back = el('div', { class: 'guide-back' });
        const win = el('div', { class: 'guide', role: 'dialog', 'aria-modal': 'true', 'aria-label': L(TX.title) });
        win.innerHTML = `
      <header class="guide-head">
        <svg viewBox="0 0 24 24" class="guide-logo" aria-hidden="true"><circle cx="12" cy="12" r="9.5"/><path d="M10 8.5v7l6-3.5z" fill="currentColor"/></svg>
        <h2>${esc(L(TX.title))}</h2>
        <button type="button" class="guide-ref">${esc(L(TX.ref))}</button>
        <button type="button" class="guide-x" aria-label="${esc(L(TX.close))}" title="${esc(L(TX.close))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
      </header>
      <div class="guide-body">
        <nav class="guide-list" aria-label="${esc(L(TX.chapters))}"></nav>
        <section class="guide-main">
          <div class="guide-stagewrap">
            <div class="guide-screen">
              <div class="guide-cam"><iframe title="demo" tabindex="-1" aria-hidden="true"></iframe></div>
              <div class="guide-veil"><span>${esc(L(TX.loading))}</span></div>
              <div class="guide-keys"></div>
              <div class="guide-prog"><i></i></div>
            </div>
          </div>
          <div class="guide-capline" aria-live="polite"><div class="guide-cap"></div></div>
          <div class="guide-foot">
            <button type="button" class="guide-nav guide-prev" aria-label="${esc(L(TX.prev))}" title="${esc(L(TX.prev))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
            <div class="guide-info"><h3></h3><p></p></div>
            <button type="button" class="guide-nav guide-pp" aria-label="${esc(L(TX.pause))}" title="${esc(L(TX.pause))}"><svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg><svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg></button>
            <button type="button" class="guide-nav guide-next" aria-label="${esc(L(TX.next))}" title="${esc(L(TX.next))}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>
          </div>
        </section>
      </div>`;
        back.appendChild(win);
        document.body.appendChild(back);
        this.back = back;
        this.win = win;
        const q = (s) => win.querySelector(s);
        this.list = q('.guide-list');
        this.screen = q('.guide-screen');
        this.camEl = q('.guide-cam');
        this.frame = q('iframe');
        this.veil = q('.guide-veil');
        this.cap = q('.guide-cap');
        this.keys = q('.guide-keys');
        this.prog = q('.guide-prog i');
        this.infoH = q('.guide-info h3');
        this.infoP = q('.guide-info p');
        this.ppBtn = q('.guide-pp');
        this.stagewrap = q('.guide-stagewrap');

        // The list of topics, by group.
        const CH = GUIDE_CHAPTERS;
        let g = null;
        CH.forEach((ch, i) => {
            if (ch.g !== g) {
                g = ch.g;
                this.list.appendChild(el('div', { class: 'guide-group' }, esc(L(GUIDE_GROUPS[g]))));
            }
            const b = el('button', { type: 'button', class: 'guide-item', 'data-i': String(i) },
                `<span class="guide-ico" aria-hidden="true">${ch.icon || ''}</span><span class="guide-name">${esc(L(ch.t))}</span>`);
            b.addEventListener('click', () => this.go(i));
            this.list.appendChild(b);
        });
        q('.guide-x').addEventListener('click', () => this.close());
        q('.guide-ref').addEventListener('click', () => { this.close(); this.app.showHelp(); });
        q('.guide-prev').addEventListener('click', () => this.go((this.idx + CH.length - 1) % CH.length));
        q('.guide-next').addEventListener('click', () => this.go((this.idx + 1) % CH.length));
        this.ppBtn.addEventListener('click', () => this.togglePause());
        back.addEventListener('pointerdown', (e) => { if (e.target === back) this.close(); });
        this.onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
            else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); this.go((this.idx + 1) % CH.length); }
            else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); this.go((this.idx + CH.length - 1) % CH.length); }
            else if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); this.togglePause(); }
        };
        // (the keys go to the guide, not to the app behind it)
        document.addEventListener('keydown', this.onKey, true);
        this.ro = new ResizeObserver(() => this.layout());
        this.ro.observe(this.stagewrap);
        this.previousFocus = document.activeElement;
        q('.guide-x').focus({ preventScroll: true });
    }

    layout() {
        if (!this.win) return;
        // (room for the padding and the bezel of the screen)
        const B = parseFloat(getComputedStyle(this.screen).borderTopWidth) || 0;
        const aw = this.stagewrap.clientWidth - 20 - 2 * B;
        const ah = this.stagewrap.clientHeight - 20 - 2 * B;
        const s = Math.max(0.2, Math.min(aw / this.VW, ah / this.VH));
        this.s0 = s;
        this.FW = Math.round(this.VW * s);
        this.FH = Math.round(this.VH * s);
        this.screen.style.width = `${this.FW + 2 * B}px`;
        this.screen.style.height = `${this.FH + 2 * B}px`;
        this.camEl.style.width = `${this.VW}px`;
        this.camEl.style.height = `${this.VH}px`;
        this.frame.style.width = `${this.VW}px`;
        this.frame.style.height = `${this.VH}px`;
        this.applyCam(false);
        if (this.demo) this.demo.k();
    }

    // Camera: null = the whole frame; else the rectangle (pixels of the frame)
    // is zoomed to about the size it would have on a real screen, centred and
    // kept inside the frame.
    setCam(r, scale) {
        this.camR = r ? { r, scale: scale || 1.1 } : null;
        this.applyCam(true);
    }

    applyCam(anim) {
        const s0 = this.s0;
        let z = 1;
        let cx = this.VW / 2;
        let cy = this.VH / 2;
        if (this.camR) {
            const { r, scale } = this.camR;
            z = Math.max(1, Math.min(2.8, scale / s0, (this.VW / Math.max(40, r.w)) * 0.92, (this.VH / Math.max(40, r.h)) * 0.92));
            cx = r.x + r.w / 2;
            cy = r.y + r.h / 2;
        }
        const S = s0 * z;
        let tx = this.FW / 2 - cx * S;
        let ty = this.FH / 2 - cy * S;
        tx = Math.min(0, Math.max(this.FW - this.VW * S, tx));
        ty = Math.min(0, Math.max(this.FH - this.VH * S, ty));
        this.cz = z;
        this.camEl.style.transition = anim ? 'transform .75s cubic-bezier(.45,0,.2,1)' : 'none';
        this.camEl.style.transform = `translate(${tx}px, ${ty}px) scale(${S})`;
        if (this.demo) this.demo.k();
    }

    caption(text) {
        const c = this.cap;
        clearTimeout(this.capT);
        if (!text) { c.classList.remove('on'); c.dataset.t = ''; return; }
        if (c.classList.contains('on') && c.dataset.t === text) return;
        c.classList.remove('on');
        this.capT = setTimeout(() => {
            c.innerHTML = text;
            c.dataset.t = text;
            c.classList.add('on');
        }, c.innerHTML ? 160 : 0);
    }

    showKey(label, soft) {
        const k = el('kbd', { class: soft ? 'soft' : '' }, esc(label));
        this.keys.appendChild(k);
        setTimeout(() => k.classList.add('out'), 900);
        setTimeout(() => k.remove(), 1300);
    }

    togglePause() {
        this.paused = !this.paused;
        this.syncPP();
    }

    syncPP() {
        const b = this.ppBtn;
        b.classList.toggle('paused', this.paused);
        const s = L(this.paused ? TX.play : TX.pause);
        b.title = s;
        b.setAttribute('aria-label', s);
    }

    // Load the frame afresh (a clean app for every run).
    loadFrame() {
        const theme = document.body.classList.contains('theme-dark') ? 'dark' : 'light';
        const q = `demo&lang=${encodeURIComponent(i18n.currentLang)}&theme=${theme}`;
        const f = this.frame;
        return new Promise((resolve) => {
            const done = () => {
                f.removeEventListener('load', done);
                const t0 = performance.now();
                const poll = () => {
                    let W = null;
                    try { W = f.contentWindow; } catch (_) { W = null; }
                    if (W && W.app && W.document.readyState === 'complete') resolve(W);
                    else if (performance.now() - t0 > 15000) resolve(null);
                    else setTimeout(poll, 40);
                };
                poll();
            };
            f.addEventListener('load', done);
            const url = new URL(window.location.href);
            url.search = `?${q}`;
            url.hash = '';
            if (f.dataset.q === q && f.contentWindow && f.contentWindow.location.href !== 'about:blank') f.contentWindow.location.reload();
            else { f.dataset.q = q; f.src = url.href; }
        });
    }

    async go(i, force) {
        const CH = GUIDE_CHAPTERS;
        if (!force && i === this.idx && this.started) return;
        this.idx = i;
        this.started = true;
        const my = ++this.runId;
        if (this.demo) { this.demo.dead = true; this.demo = null; }
        this.paused = false;
        this.syncPP();
        const ch = CH[i];
        this.list.querySelectorAll('.guide-item').forEach((b) => b.classList.toggle('on', +b.dataset.i === i));
        const on = this.list.querySelector('.guide-item.on');
        if (on) on.scrollIntoView({ block: 'nearest', inline: 'center' });
        this.infoH.innerHTML = `<span class="guide-n">${i + 1}/${CH.length}</span> ${esc(L(ch.t))}`;
        this.infoP.innerHTML = L(ch.d);
        this.veil.classList.add('on');
        this.caption(null);
        this.setProg(0, false);
        this.camR = null;
        this.applyCam(false);
        const W = await this.loadFrame();
        if (my !== this.runId || !W) return;
        const d = new Demo(this, W);
        this.demo = d;
        // The demo puts the focus in the frame: the keys of the person still go
        // to the guide, never to the app of the demo.
        const keys = (e) => {
            if (!e.isTrusted) return;
            e.stopPropagation();
            e.preventDefault();
            if (e.type === 'keydown') this.onKey(e);
        };
        W.addEventListener('keydown', keys, true);
        W.addEventListener('keyup', keys, true);
        try {
            if (ch.setup) await ch.setup(d);
            d.check();
            await d.wait(120);
            this.veil.classList.remove('on');
            const t0 = performance.now();
            this.progLoop(my, ch);
            await ch.run(d);
            this.dur[ch.id] = performance.now() - t0;
            this.setProg(1, true);
            await d.wait(ch.endWait || 2200);
            this.caption(null);
        } catch (e) {
            if (e === ABORT || my !== this.runId) return;
            console.error(e);
            this.lastError = e;
            // (a demo that failed: shown as it is for a moment, then again)
            await new Promise((r) => setTimeout(r, 2500));
        }
        if (my !== this.runId) return;
        // Like an animated picture: it starts again.
        this.loops += 1;
        this.go(i, true);
    }

    setProg(u, anim) {
        this.prog.style.transition = anim ? 'width .3s' : 'none';
        this.prog.style.width = `${(u * 100).toFixed(2)}%`;
    }

    progLoop(my, ch) {
        const est = this.dur[ch.id] || ch.est || 20000;
        let acc = 0;
        let last = performance.now();
        const step = () => {
            if (my !== this.runId || !this.win) return;
            const now = performance.now();
            if (!this.paused) acc += now - last;
            last = now;
            this.setProg(Math.min(0.97, acc / est), false);
            if (acc < est * 1.5) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    /** Open on a chapter: its id, its index, or none for the one last seen. */
    open(start) {
        if (this.win) return;
        let index = this.last || 0;
        if (typeof start === 'number') index = start;
        else if (typeof start === 'string') {
            const found = GUIDE_CHAPTERS.findIndex((ch) => ch.id === start);
            if (found >= 0) index = found;
        }
        this.build();
        requestAnimationFrame(() => {
            if (!this.win) return;
            this.back.classList.add('open');
            this.layout();
            this.go(index, true);
        });
    }

    close() {
        if (!this.win) return;
        this.runId++;
        if (this.demo) { this.demo.dead = true; this.demo = null; }
        this.last = this.idx;
        clearTimeout(this.capT);
        document.removeEventListener('keydown', this.onKey, true);
        this.ro.disconnect();
        this.back.remove();
        this.win = null;
        this.back = null;
        this.started = false;
        this.previousFocus?.focus?.({ preventScroll: true });
    }
}

export function createGuide(app) {
    return new Guide(app);
}

export { TX as GUIDE_TEXTS, L as guideText };
