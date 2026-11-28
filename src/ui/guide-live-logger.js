// The data logger drawn beside the app, for the "Live Update" demo — and the
// file reads of the desktop edition that Live Update is built on.
//
// Live Update follows a file while something is still writing it: every few
// seconds the app asks how long the file is now, reads only the bytes that
// were added, and appends the complete rows to the signals already loaded.
// That is a feature of the Full Desktop edition, because it needs a path on
// disk and a way to read a slice of it: the desktop bridge `omvDesktop`
// (electron/preload.cjs: `statFile`, `readFileSlice`). The guide runs the web
// app in a frame, where there is neither a logger nor a disk.
//
// So this file stands in for both, in the guide's frame only:
//
//  - A small window, a picture in HTML, of a program that is NOT the app:
//    a data logger on a process line, its channels with their last values, the
//    file it is writing and a row counter that ticks. It has its own title
//    bar, which says that it is simulated, and it is drawn on a strip of
//    desktop under the app's window (guide.js, a chapter's `below`), in the
//    guide's own page: nothing of it lies over the app, or is in the app's
//    document. It is dumb on purpose: the demo hands it the rows (`write`),
//    with the same waits as the rest, so Pause stops the logger too. Its few
//    words come from the demo, in the reader's language.
//
//  - The thinnest bridge that gives the app what the desktop bridge gives it:
//    the size and date of the file, and the bytes between two offsets — of the
//    text the panel has written so far, which is the "file". With it the frame
//    is told it is the desktop edition, so the Live Update button is enabled
//    there.
//
// Everything after that is the app's own code, unchanged: the button, the
// poll every two seconds (`_pollLiveUpdate`), the probe of the appended bytes
// (`_readLiveUpdateAppendProbe`), the rows parsed and appended
// (`_applyLiveUpdateAppendProbe`), the panels redrawn in place and the
// dashboard cards following. Nothing here draws a curve or a card.
//
// Outside the guide nothing of this exists: the bridge is installed on the
// frame's window by the demo that asks for it, and refuses any other page.

const CSS = `
.glog{position:absolute; left:14px; top:9px; width:640px; box-sizing:border-box; border-radius:8px; border:1px solid #0b1220; overflow:hidden;
  background:#111827; color:#e5e7eb; font:12px/1.35 system-ui,sans-serif; box-shadow:0 6px 18px rgba(0,0,0,.45)}
.glog-title{display:flex; align-items:center; gap:8px; height:24px; padding:0 10px; background:#e5e7eb; color:#111827; font-weight:600; font-size:12px}
.glog-title .sp{flex:1}
.glog-title .w{color:#6b7280; font-weight:400; letter-spacing:.5em}
.glog-body{display:flex; align-items:center; gap:14px; padding:9px 12px 10px}
.glog-led{width:10px; height:10px; flex:none; border-radius:50%; background:#374151}
.glog.rec .glog-led{background:#ef4444; box-shadow:0 0 6px #ef4444}
.glog.tick .glog-led{background:#fca5a5}
.glog-rec{font-weight:700; letter-spacing:.06em; font-size:11px; color:#6b7280}
.glog.rec .glog-rec{color:#fca5a5}
.glog-ch{display:grid; grid-template-columns:auto auto; gap:0 10px; flex:none; padding:5px 9px; border-radius:6px; background:#0b1220;
  font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.glog-ch .n{color:#93c5fd}
.glog-ch .v{color:#f9fafb; text-align:right; min-width:74px; font-variant-numeric:tabular-nums}
.glog-file{display:flex; flex-direction:column; gap:3px; color:#9ca3af; min-width:0}
.glog-file b{color:#fde68a; font-weight:600}
.glog-rows{color:#f9fafb; font-variant-numeric:tabular-nums}`;

/**
 * Build the logger's window on the strip under the app, and install the file
 * bridge on the frame's window.
 *
 * @param {HTMLElement} host the strip of desktop under the app (in the guide's page)
 * @param {Window} W the window of the guide's frame
 * @param {{ title: string, writing?: string, rows?: string, name: string, path: string,
 *   channels: Array<{ name: string, unit?: string }> }} options
 *   `title` is the title bar; `writing` and `rows` the two labels, already in
 *   the reader's language; `channels` are the columns after the time column,
 *   in the file's order.
 */
export function createLiveLoggerStage(host, W, options) {
    const frameDoc = W.document;
    // The guide's frame, and nothing else: this turns a page into "the desktop
    // edition" as far as file reads go.
    if (!frameDoc.documentElement.classList.contains('demo') || !/[?&]demo(&|=|$)/.test(W.location.search)) {
        throw new Error('guide: the stand-in logger belongs to the guide\'s frame');
    }
    if (!host || host.hidden) throw new Error('guide: the stand-in logger needs a strip under the app (the chapter\'s `below`)');
    const { title, writing = 'writing to', rows: rowsLabel = 'rows', name, path, channels } = options;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const doc = host.ownerDocument;

    if (!doc.getElementById('glog-style')) {
        const style = doc.createElement('style');
        style.id = 'glog-style';
        style.textContent = CSS;
        doc.head.appendChild(style);
    }
    const stage = doc.createElement('div');
    stage.className = 'glog';
    stage.innerHTML = `
      <div class="glog-title"><span>▤</span><span>${esc(title)}</span><span class="sp"></span><span class="w">–□×</span></div>
      <div class="glog-body">
        <i class="glog-led"></i><span class="glog-rec">REC</span>
        <div class="glog-ch">${channels.map((ch) => `<span class="n">${esc(ch.name)}</span><span class="v" data-ch="${esc(ch.name)}">—</span>`).join('')}</div>
        <div class="glog-file"><span>${esc(writing)} <b>${esc(name)}</b></span><span><span class="glog-rows">0</span> ${esc(rowsLabel)}</span></div>
      </div>`;
    host.appendChild(stage);

    // ── The "file": what the logger has written so far ──
    const encoder = new W.TextEncoder();
    let bytes = new Uint8Array(0);
    let rows = 0;
    let modified = Date.now();
    const append = (text) => {
        const more = encoder.encode(text);
        const next = new Uint8Array(bytes.length + more.length);
        next.set(bytes);
        next.set(more, bytes.length);
        bytes = next;
        modified = Date.now();
    };

    // ── What the desktop bridge gives Live Update (electron/preload.cjs) ──
    // statFile and readFileSlice are the two it polls with; the rest is what
    // the app expects of any `omvDesktop`.
    W.omvDesktop = {
        platform: 'demo',
        setTheme() {},
        setSpellcheck() {},
        statFile: async () => ({ ok: true, size: bytes.length, lastModified: modified, name }),
        readFileSlice: async ({ start, end }) => ({ ok: true, bytes: bytes.slice(start, end).buffer }),
        readFile: async () => ({ ok: true, bytes: bytes.slice().buffer, name, lastModified: modified }),
        selectFilePath: async () => path,
    };
    // The frame's app was told at start-up that it is the web version. It is
    // asked again now that the bridge is there, the way it asks at start-up.
    const app = W.app;
    app.capabilities = { ...app.capabilities, runtime: 'full-desktop', label: 'Full Desktop', isDesktop: true, canUseLiveUpdate: true, canUseLocalPath: true };
    app._applyCapabilitiesToUi?.();
    app._updateActionButtons?.();
    app._updateLiveUpdateTopBar?.();

    const api = {
        root: stage,
        name,
        path,

        /** The light of the logger: recording, or stopped. */
        recording(on) { stage.classList.toggle('rec', !!on); },

        /** The first line of the file. */
        header(line) { append(`${line}\n`); },

        /**
         * Write rows at the end of the file: lines of text as the file holds
         * them, the time first. The panel shows the last one and counts them.
         */
        write(lines) {
            if (!lines.length) return;
            append(lines.map((line) => `${line}\n`).join(''));
            rows += lines.length;
            const last = lines[lines.length - 1].split(',');
            channels.forEach((ch, i) => {
                const cell = stage.querySelector(`[data-ch="${ch.name}"]`);
                if (cell) cell.textContent = `${last[i + 1] ?? ''}${ch.unit ? ` ${ch.unit}` : ''}`;
            });
            stage.querySelector('.glog-rows').textContent = String(rows);
            stage.classList.add('tick');
            W.setTimeout(() => stage.classList.remove('tick'), 140);
        },

        /** The file as it is now, to open it in the app. */
        bytes() { return bytes.slice(); },
        rows() { return rows; },

        /**
         * Where the window is, in the pixels of the guide's screen — what
         * `d.cam` takes — since it is not in the frame's document.
         */
        area() {
            const scale = host.getBoundingClientRect().width / host.offsetWidth || 1;
            const box = stage.getBoundingClientRect();
            const cam = host.parentElement.getBoundingClientRect();
            return [(box.left - cam.left) / scale, (box.top - cam.top) / scale, box.width / scale, box.height / scale];
        },
    };
    return api;
}
