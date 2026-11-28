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
//  - A small panel, a picture in HTML: a logger on a process line, its
//    channels with their last values, the file it is writing and a row counter
//    that ticks. It is NOT a real logger and does not claim to be one. Its
//    strings are English and are not translated — the guide's captions are
//    what speaks the reader's language. It is dumb on purpose: the demo hands
//    it the rows (`write`), with the same waits as the rest, so Pause stops
//    the logger too.
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
// Outside the guide's frame nothing of this exists: the bridge is installed on
// the frame's window by the demo that asks for it, and refuses any other page.

const CSS = `
.glog{position:fixed; left:10px; bottom:10px; z-index:2147483600; width:298px; box-sizing:border-box; padding:9px 11px 10px;
  border-radius:9px; border:1px solid #1f2937; background:#111827; color:#e5e7eb; font:12px/1.35 system-ui,sans-serif;
  box-shadow:0 10px 28px rgba(0,0,0,.4); opacity:0; transform:translateY(8px); pointer-events:none; transition:opacity .25s, transform .25s}
.glog.on{opacity:1; transform:none}
.glog-head{display:flex; align-items:center; gap:7px; font-weight:700; letter-spacing:.04em; font-size:11px; color:#9ca3af}
.glog-head .sp{flex:1}
.glog-led{width:9px; height:9px; border-radius:50%; background:#374151}
.glog.rec .glog-led{background:#ef4444; box-shadow:0 0 6px #ef4444}
.glog.tick .glog-led{background:#fca5a5}
.glog-rec{color:#6b7280}
.glog.rec .glog-rec{color:#fca5a5}
.glog-ch{display:grid; grid-template-columns:1fr auto; gap:1px 10px; margin:7px 0 6px; padding:6px 8px; border-radius:6px; background:#0b1220;
  font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.glog-ch .n{color:#93c5fd}
.glog-ch .v{color:#f9fafb; text-align:right; font-variant-numeric:tabular-nums}
.glog-file{display:flex; gap:6px; align-items:baseline; color:#9ca3af}
.glog-file b{color:#fde68a; font-weight:600}
.glog-file .sp{flex:1}
.glog-rows{color:#f9fafb; font-variant-numeric:tabular-nums}`;

/**
 * Build the logger inside the frame's document, hidden, and install the file
 * bridge on the frame's window.
 *
 * @param {Document} doc the document of the guide's frame
 * @param {Window} W its window
 * @param {{ title?: string, name: string, path: string, channels: Array<{ name: string, unit?: string }> }} options
 *   `channels` are the columns after the time column, in the file's order.
 */
export function createLiveLoggerStage(doc, W, options) {
    // The guide's frame, and nothing else: this turns a page into "the desktop
    // edition" as far as file reads go.
    if (!doc.documentElement.classList.contains('demo') || !/[?&]demo(&|=|$)/.test(W.location.search)) {
        throw new Error('guide: the stand-in logger belongs to the guide\'s frame');
    }
    const { title = 'DATA LOGGER', name, path, channels } = options;
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    if (!doc.getElementById('glog-style')) {
        const style = doc.createElement('style');
        style.id = 'glog-style';
        style.textContent = CSS;
        doc.head.appendChild(style);
    }
    const stage = doc.createElement('div');
    stage.className = 'glog';
    stage.innerHTML = `
      <div class="glog-head"><i class="glog-led"></i><span>${esc(title)}</span><span class="sp"></span><span class="glog-rec">REC</span></div>
      <div class="glog-ch">${channels.map((ch) => `<span class="n">${esc(ch.name)}</span><span class="v" data-ch="${esc(ch.name)}">—</span>`).join('')}</div>
      <div class="glog-file"><span>writing to</span><b>${esc(name)}</b><span class="sp"></span><span class="glog-rows">0</span><span>rows</span></div>`;
    doc.body.appendChild(stage);

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

        show() { stage.classList.add('on'); },
        hide() { stage.classList.remove('on'); },

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

        el: { panel: stage },
    };
    return api;
}
