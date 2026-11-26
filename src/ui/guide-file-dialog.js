// The file dialog the demos open, drawn in the guide's frame.
//
// A demo that says "open this file" and then has the file appear by itself
// skips the one step a reader would take. The browser's own dialog cannot be
// used for that: a script may not drive it, it belongs to the operating system
// and it would cover the page. So this draws a stand-in — a plain Open window
// with a folder, a few files and the Open button — in the style of the
// simulation tool beside it (guide-om-stage.js), and the demo points at it
// with the ordinary pointer.
//
// It also makes the real pickers harmless while a demo runs, because the demo
// presses the app's REAL button: without that, pressing it could open the
// browser's own dialog over the guide, where no script could close it again.
// Nothing else about the app is changed; the file is then opened the way a
// drop opens one.

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CSS = `
.gfd { position:fixed; inset:0; z-index:2147482100; background:rgba(12,16,24,.34); opacity:0;
       pointer-events:none; transition:opacity .25s ease; display:flex; align-items:center; justify-content:center }
.gfd.on { opacity:1; pointer-events:auto }
.gfd-win { width:660px; background:#f0f0f0; color:#1b1b1b; border:1px solid #8a8a8a;
           font:13px/1.35 "Segoe UI", system-ui, sans-serif; box-shadow:0 18px 50px rgba(0,0,0,.45);
           transform:translateY(10px); transition:transform .25s ease }
.gfd.on .gfd-win { transform:none }
.gfd-win * { box-sizing:border-box }
.gfd-title { height:32px; display:flex; align-items:center; gap:9px; padding:0 0 0 11px; background:#fff;
             border-bottom:1px solid #e2e2e2; font-size:13.5px; font-weight:600 }
.gfd-title .sp { flex:1 }
.gfd-title .w { width:44px; height:32px; display:grid; place-items:center; font-weight:400; color:#333 }
.gfd-path { display:flex; align-items:center; gap:7px; padding:8px 11px }
.gfd-path .box { flex:1; height:26px; border:1px solid #a0a0a0; background:#fff; display:flex; align-items:center;
                 gap:6px; padding:0 8px; font-size:13px }
.gfd-path .box b { font-weight:600 }
.gfd-cols { display:flex; background:#f6f6f6; border-top:1px solid #dcdcdc; border-bottom:1px solid #dcdcdc;
            font-size:12.5px; color:#444 }
.gfd-cols div { padding:3px 9px; border-right:1px solid #e2e2e2 }
.gfd-n { flex:1 } .gfd-d { width:150px } .gfd-s { width:96px; text-align:right }
.gfd-list { height:208px; background:#fff; padding:3px 0; overflow:hidden }
.gfd-row { display:flex; align-items:center; height:26px; font-size:13px }
.gfd-row .gfd-n { display:flex; align-items:center; gap:8px; padding-left:9px }
.gfd-row .gfd-d { padding-left:9px; color:#333 }
.gfd-row .gfd-s { padding-right:12px; color:#333 }
.gfd-row.sel { background:#cde3f7 }
.gfd-ico { width:17px; height:17px; border-radius:2px; display:grid; place-items:center; font-size:8px;
           font-weight:700; color:#fff }
.gfd-foot { display:flex; align-items:center; gap:9px; padding:10px 11px }
.gfd-foot .lb { font-size:13px }
.gfd-name { flex:1; height:26px; border:1px solid #a0a0a0; background:#fff; display:flex; align-items:center;
            padding:0 8px; font-size:13px }
.gfd-type { width:146px; height:26px; border:1px solid #a0a0a0; background:#fff; display:flex; align-items:center;
            justify-content:space-between; padding:0 6px 0 8px; font-size:13px }
.gfd-btn { min-width:88px; height:27px; border:1px solid #a0a0a0; background:#e9e9e9; display:grid;
           place-items:center; font-size:13px }
.gfd-btn.main { border-color:#2a6fb5; background:#dceaf7; font-weight:600 }
`;

// What an OpenModelica working directory holds after a run: the model, the
// generated sources, the executable — and the result, which is the one to
// open. The dates and sizes are a picture, like the rest of the window.
const FILES = [
    ['ExampleSimplePendulum.mo', '#1456a0', 'M', '26/11/2026  00:41', '1 KB'],
    ['ExampleSimplePendulum.c', '#6b7280', 'C', '26/11/2026  00:42', '614 KB'],
    ['ExampleSimplePendulum.exe', '#2b3a4a', 'E', '26/11/2026  00:42', '1.284 KB'],
    ['ExampleSimplePendulum_res.mat', '#1a4f8a', 'MAT', '26/11/2026  00:42', '95 KB'],
    ['ExampleSimplePendulum_info.json', '#9aa0a6', 'J', '26/11/2026  00:42', '58 KB'],
];

/**
 * Build the Open window inside the frame's document, hidden.
 *
 * @param {Document} doc the document of the guide's frame
 * @param {Window} W its window, whose pickers are made harmless
 */
export function createFileDialogStage(doc, W) {
    if (!doc.getElementById('gfd-style')) {
        const style = doc.createElement('style');
        style.id = 'gfd-style';
        style.textContent = CSS;
        doc.head.appendChild(style);
    }

    // The app's own button is pressed by the demo, so neither picker may open:
    // the File System Access one is taken away (the app then falls back), and
    // the hidden input is told to do nothing.
    try { delete W.showOpenFilePicker; } catch (_) { /* not configurable */ }
    if (typeof W.showOpenFilePicker === 'function') W.showOpenFilePicker = undefined;
    const input = doc.getElementById('file-input');
    if (input) input.click = () => {};

    const stage = doc.createElement('div');
    stage.className = 'gfd';
    stage.innerHTML = `<div class="gfd-win">
      <div class="gfd-title"><span>📂</span><span>Open</span><span class="sp"></span><span class="w">✕</span></div>
      <div class="gfd-path"><span>↑</span>
        <div class="box">📁 <b>C:</b> › <b>Modelica</b> › <b>ExampleSimplePendulum</b></div>
        <div class="gfd-btn" style="min-width:64px">Search</div></div>
      <div class="gfd-cols"><div class="gfd-n">Name</div><div class="gfd-d">Date modified</div>
        <div class="gfd-s">Size</div></div>
      <div class="gfd-list">
        ${FILES.map(([name, color, glyph, date, size]) => `<div class="gfd-row" data-file="${esc(name)}">
          <div class="gfd-n"><span class="gfd-ico" style="background:${color}">${glyph}</span>${esc(name)}</div>
          <div class="gfd-d">${esc(date)}</div><div class="gfd-s">${esc(size)}</div></div>`).join('')}
      </div>
      <div class="gfd-foot"><span class="lb">File name:</span>
        <div class="gfd-name"></div>
        <div class="gfd-type">All files <span>▾</span></div>
        <div class="gfd-btn main">Open</div><div class="gfd-btn">Cancel</div></div>
    </div>`;
    doc.body.appendChild(stage);

    const rows = new Map();
    stage.querySelectorAll('.gfd-row').forEach((row) => rows.set(row.dataset.file, row));

    return {
        root: stage,
        show() { stage.classList.add('on'); },
        hide() { stage.classList.remove('on'); },

        /** Pick a file in the list: the row takes the selection, the field the name. */
        select(name) {
            rows.forEach((row, key) => row.classList.toggle('sel', key === name));
            stage.querySelector('.gfd-name').textContent = rows.has(name) ? name : '';
        },

        row(name) { return rows.get(name) || null; },

        el: {
            open: stage.querySelector('.gfd-btn.main'),
            cancel: stage.querySelectorAll('.gfd-btn')[2],
            window: stage.querySelector('.gfd-win'),
        },
    };
}
