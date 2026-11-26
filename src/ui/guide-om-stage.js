// The simulation tool drawn beside the app, for the "Load as new" demo.
//
// That demo is about what happens between two runs of a simulation, and half
// of it happens in OpenModelica: you change a parameter, simulate again — the
// model is not recompiled, only run — and the result file is overwritten. A
// caption could say so, but the point of the guide is to show.
//
// So this draws a stand-in for OMEdit: a picture in HTML, inside the frame of
// the guide, over the app. It is NOT OpenModelica and does not claim to be one
// — nothing is installed, nothing runs, no screenshot is shipped. It follows
// the real window closely enough for a reader who uses OMEdit to recognize
// where they are: the Libraries and Elements browsers, the text view of the
// model, the Messages browser with its Compilation and Output tabs and its
// progress bar, the Variables browser of the Plotting perspective with the
// parameters in editable boxes, and the menu that the right button opens on
// the result — Delete Result, Re-simulate, Re-simulate Setup.
//
// Its strings are the English ones of that window, and they are not
// translated: the guide's captions are what speaks the reader's language.
//
// It is dumb on purpose: it draws, and the demo drives it with the same
// pointer and the same waits as the rest (so Pause stops it too). The demo
// reaches its controls through `stage.el`.

const WIDTH = 1400;
const HEIGHT = 860;

// What the Messages browser prints. The compilation lines end with the ones a
// real build prints last — the linker command and mingw32-make leaving the
// temporary build directory — because that is what the tab shows when a person
// looks at it. The path is a neutral one: a build directory is under the
// user's name on a real machine, and no one's user name belongs in a demo.
const COMPILE_LINES = [
    'Translation of ExampleSimplePendulum completed.',
    'Compiling the generated code…',
    'gcc -falign-functions -mstackrealign -msse2 -mfpmath=sse -c -o ExampleSimplePendulum.o',
    '  -IC:/OpenModelica1.25.1-64bit/include/omc/c -IC:/OpenModelica1.25.1-64bit/include',
    'gcc -o ExampleSimplePendulum.exe ExampleSimplePendulum.o -LC:/OpenModelica1.25.1-64bit/lib"',
    '  -fopenmp -Wl,-Bstatic -lregex -ltre -lintl -liconv -lexpat -lpthread -loleaut32',
    '  -lSimulationRuntimeC -Wl,-Bdynamic -lomcgc -lryu -lopenblas -lstdc++',
    "mingw32-make: Leaving directory 'C:/Temp/OpenModelica/OMEdit/ExampleSimplePendulum'",
    'Compilation process finished successfully.',
];

const OUTPUT_LINES = [
    'The initialization finished successfully without homotopy method.',
    '› ### STATISTICS ###',
    'The simulation finished successfully.',
];

// The rows of the Variables browser: name, value, unit. The values are the
// ones a reader sees in OMEdit — the variables at the cursor's time, the
// parameters in a box because they can be changed and the model re-simulated.
const VARIABLE_ROWS = [
    ['Ekin', '0.350215…', ''],
    ['Epot', '0.041231…', ''],
    ['Etot', '0.391447…', ''],
    ['L', 'box:1.0', 'm'],
    ['b', 'box:0.1', 'N.m.s/rad'],
    ['der(omega)', '-0.98217…', ''],
    ['der(theta)', '0.836917…', ''],
    ['g', 'box:9.81', 'm/s2'],
    ['m', 'box:1.0', 'kg'],
    ['omega', '0.836917…', ''],
    ['omega0_deg', 'box:0.0', ''],
    ['omega_deg_s', '47.95182…', ''],
    ['theta', '0.091716…', ''],
    ['theta0_deg', 'box:45.0', ''],
    ['theta_deg', '5.254990…', ''],
    ['x', '0.091588…', ''],
    ['y', '-0.99579…', ''],
];

const MODEL_LINES = [
    ['model', ' ExampleSimplePendulum'],
    ['  parameter', ' Real L(unit="m") = 1;'],
    ['  parameter', ' Real b(unit="N.m.s/rad") = 0.1;'],
    ['  parameter', ' Real g(unit="m/s2") = 9.81;'],
    ['  parameter', ' Real m(unit="kg") = 1;'],
    ['  parameter', ' Real omega0_deg = 0;'],
    ['  parameter', ' Real theta0_deg = 45;'],
    ['', ''],
    ['', '  Real omega(start = omega0_deg * Modelica.Constants.pi / 180);'],
    ['', '  Real theta(start = theta0_deg * Modelica.Constants.pi / 180);'],
    ['', '  Real Ekin;'],
    ['', '  Real Epot;'],
    ['', '  Real Etot;'],
    ['', '  Real omega_deg_s;'],
    ['', '  Real theta_deg;'],
    ['', '  Real x;'],
    ['', '  Real y;'],
    ['equation', ''],
    ['', '  der(theta) = omega;'],
    ['', '  der(omega) = -(g / L) * sin(theta) - (b / (m * L * L)) * omega;'],
    ['', ''],
    ['', '  Ekin = 0.5 * m * (L * omega) ^ 2;'],
    ['', '  Epot = m * g * L * (1 - cos(theta));'],
    ['', '  Etot = Ekin + Epot;'],
    ['', '  omega_deg_s = omega * 180 / Modelica.Constants.pi;'],
    ['', '  theta_deg = theta * 180 / Modelica.Constants.pi;'],
    ['', '  x = L * sin(theta);'],
    ['', '  y = -L * cos(theta);'],
    ['end', ' ExampleSimplePendulum;'],
];

const CSS = `
.omx { position:fixed; inset:0; z-index:2147482000; background:#20242a; opacity:0;
       pointer-events:none; transition:opacity .45s ease; display:flex; align-items:center; justify-content:center }
.omx.on { opacity:1; pointer-events:auto }
.omx-win { width:${WIDTH}px; height:${HEIGHT}px; transform-origin:center center; background:#f0f0f0; color:#1b1b1b;
           font:13px/1.35 "Segoe UI", system-ui, sans-serif; display:flex; flex-direction:column;
           border:1px solid #8a8a8a; box-shadow:0 18px 60px rgba(0,0,0,.5) }
.omx-win * { box-sizing:border-box }
.omx-title { height:32px; display:flex; align-items:center; gap:9px; padding-left:9px; background:#fff;
             border-bottom:1px solid #e2e2e2; font-size:13.5px; font-weight:600 }
.omx-title .sp { flex:1 }
.omx-title .w { width:46px; height:32px; display:grid; place-items:center; font-weight:400; color:#333 }
.omx-menu { height:27px; display:flex; align-items:center; padding:0 7px; background:#fff;
            border-bottom:1px solid #dcdcdc; font-size:13px }
.omx-menu span { padding:3px 9px }
.omx-tools { height:40px; display:flex; align-items:center; gap:2px; padding:0 7px; background:#f6f6f6;
             border-bottom:1px solid #b4b4b4 }
.omx-ic { width:30px; height:30px; border:1px solid transparent; border-radius:3px; display:grid;
          place-items:center; font-size:15px; color:#3b4a5a }
.omx-ic.sep { width:1px; height:24px; background:#cfcfcf; margin:0 5px; border:0; border-radius:0 }
.omx-ic.hot { border-color:#7fb0e0; background:#dceaf7 }
.omx-ic svg { width:19px; height:19px }
.omx-body { flex:1; display:flex; min-height:0 }
.omx-left { width:362px; display:flex; flex-direction:column; border-right:1px solid #b4b4b4 }
.omx-dock { display:flex; flex-direction:column; min-height:0; background:#f0f0f0 }
.omx-dhead { height:24px; display:flex; align-items:center; padding:0 5px 0 7px; background:#eee;
             border-bottom:1px solid #dcdcdc; font-size:13px }
.omx-dhead .sp { flex:1 }
.omx-dhead i { font-style:normal; color:#555; font-size:12px; padding:0 3px }
.omx-filter { display:flex; align-items:center; gap:4px; padding:5px 6px }
.omx-field { height:24px; border:1px solid #a0a0a0; background:#fff; font-size:13px; padding:1px 6px;
             display:flex; align-items:center; color:#9a9a9a; flex:1 }
.omx-fic { font-size:13px; width:17px; text-align:center }
.omx-scroll { width:14px; background:#f0f0f0; border-left:1px solid #e0e0e0 }
.omx-tree { flex:1; background:#fff; overflow:hidden; display:flex }
.omx-tree .items { flex:1; padding-top:3px }
.omx-row { display:flex; align-items:center; gap:6px; height:24px; padding:0 8px; white-space:nowrap }
.omx-row .chev { width:10px; color:#777; font-size:10px }
.omx-row .ico { width:19px; height:19px; border-radius:2px; display:grid; place-items:center;
                font-size:11px; font-weight:700; color:#fff }
.omx-row.sel { background:#e6eef6; font-weight:600 }
.omx-list { flex:1; background:#fff; font-size:13px; padding:4px 0; overflow:hidden }
.omx-list div { height:20px; padding:0 10px }
.omx-center { flex:1; display:flex; flex-direction:column; min-width:0; min-height:0 }
.omx-ctab { height:26px; display:flex; align-items:center; background:#f0f0f0; border-bottom:1px solid #b4b4b4 }
.omx-ctab .ti { width:30px; display:grid; place-items:center; color:#1456a0 }
.omx-ctab .tt { flex:1; text-align:center; font-size:13px }
.omx-ctab .cx { width:24px; height:18px; margin-right:5px; background:#e81123; color:#fff;
                display:grid; place-items:center; border-radius:2px; font-size:11px }
.omx-crow { height:26px; display:flex; align-items:center; background:#f6f6f6; border-bottom:1px solid #b4b4b4;
            font-size:13px }
.omx-crow .cell { padding:0 11px; height:100%; display:flex; align-items:center; border-right:1px solid #dcdcdc }
.omx-crow .grow { flex:1 }
.omx-code { flex:1; background:#fff; display:flex; overflow:hidden; position:relative;
            font:14px/1.57 Consolas, "DejaVu Sans Mono", monospace }
.omx-gut { width:44px; text-align:right; padding:4px 9px 0 0; color:#8a8a8a; user-select:none }
.omx-code pre { margin:0; padding:4px 0 0 6px; flex:1 }
.omx-kw { color:#0000a0; font-weight:600 }
.omx-hl { position:absolute; left:44px; right:14px; height:22px; background:#eaf2fb }
.omx-msgs { height:212px; flex:none; border-top:1px solid #b4b4b4 }
.omx-mtabs { display:flex; align-items:center; gap:2px; padding:4px 6px 0; background:#f0f0f0 }
.omx-mtabs .t { padding:4px 13px; font-size:13px; border:1px solid transparent }
.omx-mtabs .t.on { background:#fff; border-color:#b4b4b4; border-bottom-color:#fff }
.omx-mtabs .t .x { background:#e81123; color:#fff; font-size:10px; padding:0 3px; margin-left:7px; border-radius:2px }
.omx-run { display:flex; align-items:center; gap:9px; padding:5px 8px; font-size:13px }
.omx-run .txt { white-space:nowrap }
.omx-prog { flex:1; height:21px; background:#fff; border:1px solid #a0a0a0; position:relative }
.omx-prog i { display:block; height:100%; background:#12a52a; transition:width .25s linear }
.omx-prog span { position:absolute; inset:0; display:grid; place-items:center; font-size:12px }
.omx-btn { border:1px solid #a0a0a0; background:#e9e9e9; padding:3px 12px; font-size:13px; white-space:nowrap }
.omx-btn.off { color:#9a9a9a }
.omx-subtabs { display:flex; gap:2px; padding:0 8px }
.omx-subtabs .t { padding:3px 14px; font-size:13px; border:1px solid #b4b4b4; background:#f0f0f0 }
.omx-subtabs .t.on { background:#fff; border-bottom-color:#fff }
.omx-log { height:104px; margin:0 8px 8px; background:#fff; border:1px solid #a0a0a0; padding:5px 8px;
           font:13px/1.5 Consolas, "DejaVu Sans Mono", monospace; overflow:hidden; color:#111 }
.omx-log div:last-child { color:#1a3fa0 }
.omx-status { height:28px; display:flex; align-items:center; justify-content:flex-end; background:#f0f0f0;
              border-top:1px solid #dcdcdc; padding-right:6px; font-size:13px }
.omx-status .lc { margin-right:14px; color:#333 }
.omx-status .p { display:flex; align-items:center; gap:6px; padding:4px 13px }
.omx-status .p.on { background:#cde3f7 }
.omx-plot { flex:1; display:flex; flex-direction:column; background:#fff; min-width:0; overflow:hidden }
.omx-ptools { height:34px; display:flex; align-items:center; gap:8px; padding:0 9px; background:#fafafa;
              border-bottom:1px solid #dcdcdc; font-size:13px }
.omx-combo { height:24px; min-width:110px; border:1px solid #a0a0a0; background:#fff; display:flex;
             align-items:center; justify-content:space-between; padding:0 5px 0 7px; font-size:13px; color:#111 }
.omx-chk { display:inline-flex; align-items:center; gap:6px }
.omx-chk i { width:13px; height:13px; border:1px solid #8a8a8a; background:#fff; display:inline-block }
.omx-vars { width:420px; border-left:1px solid #b4b4b4 }
.omx-vhead { display:flex; align-items:center; gap:8px; padding:4px 7px; font-size:13px }
.omx-pbar { height:8px; background:#1a6fc4; width:20px; margin:3px 7px }
.omx-time { display:flex; align-items:center; gap:8px; padding:4px 7px; color:#1456a0; font-size:17px }
.omx-time .lb { font-size:13px; color:#111 }
.omx-time .f { flex:1 }
.omx-cols { display:flex; background:#f0f0f0; border-top:1px solid #dcdcdc; border-bottom:1px solid #dcdcdc;
            font-size:13px }
.omx-cols div { padding:3px 7px; border-right:1px solid #dcdcdc }
.omx-c1 { width:166px } .omx-c2 { width:82px } .omx-c3 { width:94px } .omx-c4 { flex:1 }
.omx-vrow { display:flex; align-items:center; height:21px; font-size:13px }
.omx-vrow .omx-c1 { display:flex; align-items:center; gap:6px; padding-left:26px }
.omx-vrow.root .omx-c1 { padding-left:6px }
.omx-vrow.root.sel { background:#e6eef6 }
.omx-cbox { width:13px; height:13px; border:1px solid #8a8a8a; background:#fff; display:inline-grid;
            place-items:center; font-size:10px; color:#111 }
.omx-val { padding:0 7px }
.omx-box { border:1px solid #8a8a8a; background:#fff; height:18px; display:inline-flex; align-items:center;
           padding:0 5px; font-style:italic; min-width:70px; margin-left:3px }
.omx-box.edit { outline:2px solid #1a6fc4; outline-offset:-2px; font-style:normal }
.omx-ctx { position:absolute; background:#fff; border:1px solid #a0a0a0; box-shadow:0 7px 20px rgba(0,0,0,.3);
           padding:3px; font-size:13px; width:214px; display:none }
.omx-ctx.on { display:block }
.omx-ctx div { display:flex; align-items:center; gap:9px; padding:6px 9px }
.omx-ctx div.hot { background:#cde3f7 }
.omx-ctx div.dim { color:#9a9a9a }
.omx-ctx .k { margin-left:auto; color:#777 }
.omx-ctx hr { border:0; border-top:1px solid #e3e3e3; margin:3px 0 }
`;

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

const arrowIcon = (color) =>
    `<svg viewBox="0 0 20 20"><path d="M3 10h11M10 5l5 5-5 5" stroke="${color}" stroke-width="2.4" fill="none"
      stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const checkIcon = (color) =>
    `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" fill="${color}"/>
      <path d="M6 10.5l2.6 2.6L14 7.8" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`;
const boxIcon = (color) => `<svg viewBox="0 0 20 20"><rect x="3" y="3" width="14" height="14" rx="2" fill="${color}"/></svg>`;

/** θ(t) of the pendulum, for the curve the plot window draws. */
function curvePath(b, width, height) {
    const stop = 20;
    const theta0 = (45 * Math.PI) / 180;
    const wn = Math.sqrt(9.81);
    const z = b / 2;
    const wd = Math.sqrt(Math.max(1e-9, wn * wn - z * z));
    let path = '';
    for (let i = 0; i <= 600; i++) {
        const t = (i / 600) * stop;
        const y = theta0 * Math.exp(-z * t) * (Math.cos(wd * t) + (z / wd) * Math.sin(wd * t));
        path += `${i ? 'L' : 'M'}${((t / stop) * width).toFixed(1)},${(height / 2 - y * (height / 2)).toFixed(1)} `;
    }
    return path.trim();
}

function plotSvg(b) {
    const w = 506;
    const h = 366;
    const xs = [0, 5, 10, 15, 20];
    const ys = [1, 0.5, 0, -0.5, -1];
    return `<svg width="${w + 96}" height="${h + 78}" style="display:block;margin:0 auto">
      <g transform="translate(62,34)">
        <line x1="${w * 0.18}" y1="-14" x2="${w * 0.3}" y2="-14" stroke="#111" stroke-width="1.6"/>
        <text x="${w * 0.33}" y="-10" font-size="13" fill="#111">theta</text>
        ${ys.map((v, i) => `<line x1="0" y1="${(i * h) / 4}" x2="${w}" y2="${(i * h) / 4}" stroke="#c8c8c8"/>
          <text x="-11" y="${(i * h) / 4 + 5}" text-anchor="end" font-size="13" fill="#222">${v}</text>`).join('')}
        ${xs.map((v, i) => `<line x1="${(i * w) / 4}" y1="0" x2="${(i * w) / 4}" y2="${h}" stroke="#c8c8c8"/>
          <text x="${(i * w) / 4}" y="${h + 20}" text-anchor="middle" font-size="13" fill="#222">${v}</text>`).join('')}
        <rect x="0" y="0" width="${w}" height="${h}" fill="none" stroke="#444"/>
        <path class="omx-curve" d="${curvePath(b, w, h)}" fill="none" stroke="#e00000" stroke-width="1.5"/>
        <text x="${w / 2}" y="${h + 42}" text-anchor="middle" font-size="13.5" fill="#111">time (s)</text>
      </g></svg>`;
}

function leftColumn() {
    const libraries = [
        ['ModelicaReference', '#1a7fc4', 'i'],
        ['ModelicaServices', '#b0b0b0', ''],
        ['Complex', '#9aa0a6', 'C'],
        ['Modelica', '#555', '≋'],
    ];
    const elements = ['L', 'b', 'g', 'm', 'omega0_deg', 'theta0_deg', 'omega', 'theta', 'Ekin', 'Epot'];
    const filterIcons = `<span class="omx-fic" style="color:#e8a317">⤓</span>
        <span class="omx-fic" style="color:#1456a0">⤒</span><span class="omx-fic" style="color:#e8a317">⬇</span>`;
    return `<div class="omx-left">
      <div class="omx-dock" style="flex:1;min-height:0">
        <div class="omx-dhead"><span>Libraries</span><span class="sp"></span><i>▣</i><i>✕</i></div>
        <div class="omx-filter"><div class="omx-field">Filter Classes</div>${filterIcons}</div>
        <div class="omx-tree"><div class="items">
          ${libraries.map(([name, color, glyph]) => `<div class="omx-row"><span class="chev">›</span>
            <span class="ico" style="background:${color}">${glyph}</span><span>${name}</span></div>`).join('')}
          <div class="omx-row sel"><span class="chev"></span>
            <span class="ico" style="background:#1456a0">M</span><span>ExampleSimplePendulum</span></div>
        </div><div class="omx-scroll"></div></div>
      </div>
      <div class="omx-dock" style="height:252px">
        <div class="omx-dhead"><span>Elements</span><span class="sp"></span><i>▣</i><i>✕</i></div>
        <div class="omx-filter"><div class="omx-field">Filter Elements</div>${filterIcons}</div>
        <div class="omx-tree"><div class="omx-list">${elements.map((e) => `<div>${e}</div>`).join('')}</div>
          <div class="omx-scroll"></div></div>
      </div>
    </div>`;
}

function codeView() {
    const lines = MODEL_LINES.map(([keyword, rest]) =>
        (keyword ? `<span class="omx-kw">${esc(keyword)}</span>` : '') + (esc(rest) || (keyword ? '' : '&nbsp;')));
    return `<div class="omx-center">
      <div class="omx-ctab"><span class="ti">▤</span><span class="tt">ExampleSimplePendulum</span><span class="cx">✕</span></div>
      <div class="omx-crow">
        <span class="cell" style="gap:8px;color:#1456a0">⇥ ⚙ ▤ ⓘ</span>
        <span class="cell" style="gap:10px;color:#888">‹ › <span style="color:#c0392b">✕</span></span>
        <span class="cell">Writable</span><span class="cell">Model</span><span class="cell">Text View</span>
        <span class="cell">ExampleSimplePendulum</span>
        <span class="cell grow">C:/Modelica/ExampleSimplePendulum.mo</span><span class="cell">🔒</span></div>
      <div class="omx-code">
        <div class="omx-hl" style="top:158px"></div>
        <div class="omx-gut">${MODEL_LINES.map((_, i) => i + 1).join('<br>')}</div>
        <pre>${lines.join('\n')}</pre><div class="omx-scroll"></div></div>
    </div>`;
}

function variablesDock() {
    const rows = VARIABLE_ROWS.map(([name, value, unit]) => {
        const cell = value.startsWith('box:')
            ? `<span class="omx-box" data-value="${esc(name)}">${esc(value.slice(4))}</span>`
            : `<span class="omx-val">${esc(value)}</span>`;
        return `<div class="omx-vrow" data-row="${esc(name)}">
          <div class="omx-c1"><span class="omx-cbox">${name === 'theta' ? '✔' : ''}</span>${esc(name)}</div>
          <div class="omx-c2">${cell}</div><div class="omx-c3" style="padding-left:7px">${esc(unit)}</div>
          <div class="omx-c4"></div></div>`;
    }).join('');
    const filterIcons = `<span class="omx-fic" style="color:#e8a317">⤓</span>
        <span class="omx-fic" style="color:#1456a0">⤒</span><span class="omx-fic" style="color:#e8a317">⬇</span>`;
    return `<div class="omx-dock omx-vars">
      <div class="omx-dhead"><span>Variables</span><span class="sp"></span><i>▣</i><i>✕</i></div>
      <div class="omx-filter"><div class="omx-field">Filter Variables</div>${filterIcons}</div>
      <div class="omx-vhead"><span>Simulation Time Unit</span>
        <span class="omx-combo" style="flex:1;min-width:0">s <span>▾</span></span></div>
      <div style="padding:0 7px 2px;font-size:13px">Enabled for ExampleSimplePendulum_res.mat</div>
      <div class="omx-pbar"></div>
      <div class="omx-time"><span>⏮</span><span>▶</span><span>⏸</span><span class="lb">Time:</span>
        <span class="f"><span class="omx-field" style="color:#111">0</span></span>
        <span class="lb">Speed:</span><span class="omx-combo" style="min-width:58px">1 <span>▾</span></span></div>
      <div style="height:10px;background:#f0f0f0;text-align:center;font-size:11px;color:#666;line-height:10px">⌃</div>
      <div class="omx-cols"><div class="omx-c1">Variables</div><div class="omx-c2">Value</div>
        <div class="omx-c3">Display Unit</div><div class="omx-c4">Description</div></div>
      <div style="flex:1;background:#fff;overflow:hidden">
        <div class="omx-vrow root" data-row="__root__"><div class="omx-c1">
          <span style="color:#666;font-size:12px">⌄</span>
          <span style="background:#1a4f8a;color:#fff;font-size:8px;width:21px;height:15px;display:inline-grid;
                place-items:center;border-radius:2px">MAT</span>
          <span style="color:#1456a0">ExampleSimplePendulum</span></div>
          <div class="omx-c2"></div><div class="omx-c3"></div><div class="omx-c4"></div></div>
        ${rows}
      </div>
    </div>`;
}

function messagesDock() {
    return `<div class="omx-dock omx-msgs">
      <div class="omx-dhead"><span>Messages</span><span class="sp"></span><i>▣</i><i>✕</i></div>
      <div class="omx-mtabs">
        ${['All', 'Notifications', 'Warnings', 'Errors'].map((t) => `<span class="t">${t}</span>`).join('')}
        <span class="t on">ExampleSimplePendulum <span class="x">✕</span></span></div>
      <div class="omx-run"><span class="txt">Simulation of ExampleSimplePendulum finished.</span>
        <span class="omx-prog"><i style="width:100%"></i><span>100%</span></span>
        <span class="omx-btn off">Cancel Simulation</span><span class="omx-ic" style="width:24px;height:24px">⚙</span>
        <span class="omx-btn">Open Output File</span></div>
      <div class="omx-subtabs">
        <span class="t" data-tab="Compilation">Compilation</span><span class="t on" data-tab="Output">Output</span></div>
      <div class="omx-log"></div>
    </div>`;
}

function toolbar() {
    const common = `<span class="omx-ic">📄</span><span class="omx-ic">📂</span><span class="omx-ic">💾</span>
      <span class="omx-ic">🖫</span><span class="omx-ic sep"></span>
      <span class="omx-ic" style="color:#d6a000">↶</span><span class="omx-ic" style="color:#d6a000">↷</span>
      <span class="omx-ic sep"></span><span class="omx-ic">▦</span><span class="omx-ic">🔍</span>
      <span class="omx-ic">🔍</span><span class="omx-ic">🔍</span><span class="omx-ic">⤡</span>`;
    const modeling = `<span class="omx-ic sep"></span><span class="omx-ic">╲</span>
      <span class="omx-ic">${boxIcon('#2b3a4a')}</span><span class="omx-ic">${boxIcon('#fff')}</span>
      <span class="omx-ic">${boxIcon('#2b3a4a')}</span><span class="omx-ic">T</span><span class="omx-ic">🖼</span>
      <span class="omx-ic sep"></span><span class="omx-ic">${checkIcon('#12a52a')}</span>
      <span class="omx-ic">${checkIcon('#12a52a')}</span><span class="omx-ic">▤</span>
      <span class="omx-ic sep"></span><span class="omx-ic">⇄</span><span class="omx-ic sep"></span>
      <span class="omx-ic" style="color:#1456a0;font-weight:700">S</span>
      <span class="omx-ic omx-simulate" title="Simulate">${arrowIcon('#12a52a')}</span>
      <span class="omx-ic">${arrowIcon('#1a7fc4')}</span><span class="omx-ic">${arrowIcon('#c07a00')}</span>
      <span class="omx-ic">${arrowIcon('#7a4ec4')}</span>`;
    const plotting = `<span class="omx-ic sep"></span><span class="omx-ic" style="color:#c0392b">📉</span>
      <span class="omx-ic" style="color:#1456a0">🌀</span><span class="omx-ic" style="color:#1456a0">📊</span>
      <span class="omx-ic">⚬</span><span class="omx-ic">🧊</span><span class="omx-ic">🎞</span>
      <span class="omx-ic" style="font-size:10px;font-weight:700;color:#1a7f3a">CSV</span><span class="omx-ic">🖊</span>
      <span class="omx-ic sep"></span>
      <span class="omx-ic omx-resimulate" title="Re-simulate" style="color:#c0392b;font-size:18px">⟳</span>
      <span class="omx-ic" style="color:#12a52a;font-weight:700">S</span><span class="omx-ic sep"></span>
      <span class="omx-ic" style="color:#1456a0;font-weight:700">S</span>
      <span class="omx-ic">${arrowIcon('#12a52a')}</span><span class="omx-ic">${arrowIcon('#1a7fc4')}</span>`;
    return `<div class="omx-tools">${common}<span class="omx-modeling-tools">${modeling}</span>
      <span class="omx-plotting-tools" style="display:none">${plotting}</span></div>`;
}

function statusBar() {
    const perspectives = [['Welcome', '🏠'], ['Modeling', '✎'], ['Plotting', '📈'], ['Debugging', '🐞']];
    return `<div class="omx-status"><span class="lc">Ln: 8, Col: 0</span>
      ${perspectives.map(([name, glyph]) =>
        `<span class="p" data-perspective="${name}">${glyph} ${name}</span>`).join('')}</div>`;
}

/**
 * Build the stand-in window inside the frame's document, hidden.
 *
 * @param {Document} doc the document of the guide's frame
 * @returns the stage: `show`/`hide`, the steps of a run, and `el`, the
 *          controls the demo points at.
 */
export function createOmStage(doc) {
    if (!doc.getElementById('omx-style')) {
        const style = doc.createElement('style');
        style.id = 'omx-style';
        style.textContent = CSS;
        doc.head.appendChild(style);
    }
    const stage = doc.createElement('div');
    stage.className = 'omx';
    stage.innerHTML = `<div class="omx-win">
      <div class="omx-title">
        <svg width="17" height="17" viewBox="0 0 16 16"><circle cx="3.5" cy="5" r="2.1" fill="#2a6fb5"/>
          <circle cx="12.5" cy="3.6" r="2.1" fill="#2a6fb5"/><circle cx="8" cy="12.4" r="2.1" fill="#2a6fb5"/>
          <path d="M3.5 5 12.5 3.6 8 12.4Z" fill="none" stroke="#2a6fb5" stroke-width=".9"/></svg>
        <span class="omx-wtitle">OMEdit - OpenModelica Connection Editor</span><span class="sp"></span>
        <span class="w">—</span><span class="w">❐</span><span class="w">✕</span></div>
      <div class="omx-menu">${['File', 'Edit', 'View', 'SSP', 'Simulation', 'Data Reconciliation',
        'Sensitivity Optimization', 'Debug', 'Tools', 'Help'].map((m) => `<span>${m}</span>`).join('')}</div>
      ${toolbar()}
      <div class="omx-body">${leftColumn()}
        <div class="omx-center">
          <div class="omx-modeling" style="flex:1;display:flex;flex-direction:column;min-height:0">${codeView()}</div>
          <div class="omx-plotting" style="flex:1;display:none;min-height:0">
            <div class="omx-plot">
              <div class="omx-ctab"><span class="ti">📈</span><span class="tt">Plot : 1</span><span class="cx">✕</span></div>
              <div class="omx-ptools"><span class="omx-ic" style="color:#1456a0">⤢</span>
                <span class="omx-ic" style="color:#1456a0">⤡</span><span class="omx-combo">Grid <span>▾</span></span>
                <span class="omx-chk"><i></i> Log X</span><span class="omx-chk"><i></i> Log Y</span>
                <span class="omx-ic">🛠</span><span class="omx-ic">💾</span><span class="omx-ic">🖨</span></div>
              <div class="omx-canvas" style="flex:1;padding:6px 0 0">${plotSvg(0.1)}</div></div>
            ${variablesDock()}
          </div>
          ${messagesDock()}
        </div>
      </div>
      ${statusBar()}
      <div class="omx-ctx">
        <div><span style="color:#c0392b">✖</span> Delete Result <span class="k">Del</span></div>
        <div class="dim"><span>⏱</span> Enable Time Controls</div>
        <hr>
        <div class="hot omx-resim-item"><span style="color:#c0392b">⟳</span> Re-simulate</div>
        <div><span style="color:#12a52a">⚙</span> Re-simulate Setup</div>
      </div>
    </div>`;
    doc.body.appendChild(stage);

    const $ = (sel) => stage.querySelector(sel);
    const win = $('.omx-win');
    const log = $('.omx-log');
    const api = {
        root: stage,
        COMPILE_LINES,
        OUTPUT_LINES,

        /**
         * Scale the window into the frame, whatever room the frame has. The
         * stage centres it, and the transform grows from its centre, so the
         * scaled window stays where the centring put it.
         */
        fit() {
            const scale = Math.min(doc.documentElement.clientWidth / WIDTH,
                doc.documentElement.clientHeight / HEIGHT);
            win.style.transform = `scale(${scale})`;
        },

        show() {
            api.fit();
            stage.classList.add('on');
        },

        hide() {
            stage.classList.remove('on');
            api.menu(false);
        },

        /** 'modeling' (the model's text) or 'plotting' (the result and its variables). */
        perspective(which) {
            const plotting = which === 'plotting';
            $('.omx-modeling').style.display = plotting ? 'none' : 'flex';
            $('.omx-plotting').style.display = plotting ? 'flex' : 'none';
            $('.omx-modeling-tools').style.display = plotting ? 'none' : 'contents';
            $('.omx-plotting-tools').style.display = plotting ? 'contents' : 'none';
            stage.querySelectorAll('.omx-status .p').forEach((p) =>
                p.classList.toggle('on', p.dataset.perspective === (plotting ? 'Plotting' : 'Modeling')));
        },

        /** The Compilation or the Output tab of the Messages browser. */
        tab(name) {
            stage.querySelectorAll('.omx-subtabs .t').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
            log.innerHTML = '';
        },

        /** One more line in the tab on show (the demo waits between lines). */
        line(text) {
            const row = doc.createElement('div');
            row.textContent = text;
            log.appendChild(row);
            while (log.children.length > 6) log.firstChild.remove();
        },

        /** The progress row: what it says, and how far the green bar has gone. */
        progress(percent, text) {
            $('.omx-prog i').style.width = `${percent}%`;
            $('.omx-prog span').textContent = `${Math.round(percent)}%`;
            $('.omx-prog span').style.color = percent >= 55 ? '#fff' : '#111';
            $('.omx-run .txt').textContent = text;
            $('.omx-run .omx-btn').classList.toggle('off', percent >= 100);
        },

        /** The value of a parameter in the Variables browser, as typed. */
        value(name, text, editing) {
            const box = stage.querySelector(`.omx-box[data-value="${name}"]`);
            if (!box) return;
            if (text != null) box.textContent = text;
            box.classList.toggle('edit', !!editing);
        },

        /** The menu the right button opens on the result. */
        menu(open) {
            const menu = $('.omx-ctx');
            menu.classList.toggle('on', !!open);
            stage.querySelector('.omx-vrow.root').classList.toggle('sel', !!open);
            if (open) {
                const row = stage.querySelector('.omx-vrow.root').getBoundingClientRect();
                const box = win.getBoundingClientRect();
                const scale = box.width / WIDTH || 1;
                menu.style.left = `${(row.left - box.left) / scale + 64}px`;
                menu.style.top = `${(row.top - box.top) / scale + 14}px`;
            }
        },

        /** Draw the run with this damping in the plot window. */
        curve(b) {
            $('.omx-canvas').innerHTML = plotSvg(b);
        },

        el: {
            simulate: $('.omx-simulate'),
            resimulate: $('.omx-resimulate'),
            resimulateItem: $('.omx-resim-item'),
            resultRoot: stage.querySelector('.omx-vrow.root'),
            damping: stage.querySelector('.omx-box[data-value="b"]'),
            messages: $('.omx-msgs'),
            plot: $('.omx-plot'),
            variables: $('.omx-vars'),
            window: win,
        },
    };
    api.perspective('modeling');
    api.tab('Output');
    for (const text of OUTPUT_LINES) api.line(text);
    api.fit();
    return api;
}
