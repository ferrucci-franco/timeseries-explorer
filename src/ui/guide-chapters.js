// The demos of the animated guide (see guide.js).
//
// Each chapter opens some data in a fresh copy of the app (`setup`, hidden
// behind the "Loading…" veil) and then plays the feature with the gestures of a
// person (`run`): d.tap, d.plot, d.choose, d.slide, d.type…, with one short
// caption per step (d.say) and a camera that looks where it happens (d.cam).
//
// To add a demo: add a chapter here. Keep the captions short — the demo shows.
// Every text is { en, fr, es, it, zh }; a missing language falls back to English.
//
// The data is made up and generated here, seeded, so nothing has to be
// downloaded and every run shows the same curves. The exception is the PyPSA
// network, a small file under public/examples/guide/ written by
// scripts/gen-guide-pypsa-example.py.

import { pendulumResultMat, PENDULUM_RUNS } from './guide-om-result.js';

const say = (en, fr, es, it, zh) => ({ en, fr, es, it, zh });

export const GUIDE_GROUPS = {
    import: say('Import', 'Importer', 'Importar', 'Importare', '导入'),
    plots: say('Plots', 'Graphiques', 'Gráficos', 'Grafici', '图表'),
    signals: say('New signals', 'Nouveaux signaux', 'Nuevas señales', 'Nuovi segnali', '新信号'),
    analysis: say('Analysis', 'Analyse', 'Análisis', 'Analisi', '分析'),
    tools: say('With your tools', 'Avec vos outils', 'Con sus herramientas', 'Con i tuoi strumenti', '配合你的工具'),
};

// ─── Made-up data ──────────────────────────────────────────────────────────

function random(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}
const pad2 = (n) => String(n).padStart(2, '0');

// A logger that writes US dates (month first) in a Date and a Time column.
// Nine days in March: every date is also a valid day-first date, which is the
// case no reader can settle by itself.
function loggerCsv() {
    const rnd = random(11);
    const lines = ['Date,Time,power_kW,temperature_C'];
    for (let i = 0; i < 24 * 9; i++) {
        const d = new Date(Date.UTC(2025, 2, 1, i));
        const h = d.getUTCHours();
        const sun = Math.max(0, Math.sin((Math.PI * (h - 6)) / 12));
        const power = 4.6 * sun * (0.75 + 0.25 * rnd());
        const temp = 12 + 7 * Math.sin((Math.PI * (h - 9)) / 12) + 0.6 * (rnd() - 0.5) + 0.3 * (i / 24);
        lines.push(`${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}/${d.getUTCFullYear()},${pad2(h)}:00,${power.toFixed(3)},${temp.toFixed(2)}`);
    }
    return lines.join('\n');
}

// A vibration with two tones (50 Hz and 120 Hz) buried in noise, sampled at 1 kHz.
function motorCsv() {
    const rnd = random(42);
    const lines = ['time,vibration,current'];
    for (let i = 0; i < 4000; i++) {
        const t = i / 1000;
        const vibration = Math.sin(2 * Math.PI * 50 * t) + 0.5 * Math.sin(2 * Math.PI * 120 * t) + 1.6 * (rnd() - 0.5);
        const current = 2 * Math.sin(2 * Math.PI * 50 * t + 1) + 0.2 * (rnd() - 0.5);
        lines.push(`${t.toFixed(3)},${vibration.toFixed(4)},${current.toFixed(4)}`);
    }
    return lines.join('\n');
}

// Eight weeks of hourly consumption of a building: a morning and an evening
// peak on working days, a flatter weekend.
function buildingCsv() {
    const rnd = random(7);
    const lines = ['timestamp,load_kW,pv_kW'];
    const t0 = Date.UTC(2025, 2, 3);
    for (let i = 0; i < 24 * 7 * 8; i++) {
        const d = new Date(t0 + i * 3600e3);
        const h = d.getUTCHours();
        const workday = (d.getUTCDay() + 6) % 7 < 5;
        const load = workday
            ? 30 + 25 * Math.exp(-((h - 9) ** 2) / 8) + 35 * Math.exp(-((h - 19) ** 2) / 6)
            : 28 + 22 * Math.exp(-((h - 13) ** 2) / 18);
        const pv = Math.max(0, 40 * Math.sin((Math.PI * (h - 6)) / 12)) * (0.5 + 0.5 * rnd());
        lines.push(`${d.toISOString().slice(0, 19).replace('T', ' ')},${(load + 6 * (rnd() - 0.5)).toFixed(2)},${pv.toFixed(2)}`);
    }
    return lines.join('\n');
}

// The speed of a motor shaft read from an encoder: a ramp up, a plateau, a
// ramp down, with measurement noise and four glitches of the counter.
function shaftSpeedCsv() {
    const rnd = random(5);
    const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
    const glitches = new Map([[310, 7], [777, -6], [1130, 7], [1502, -5]]);
    const lines = ['time [s],speed [rad/s]'];
    for (let i = 0; i < 2000; i++) {
        const t = i / 100;
        const speed = 10 * (smooth((t - 2) / 5) - smooth((t - 12) / 5)) + 0.6 * (rnd() - 0.5) + (glitches.get(i) || 0);
        lines.push(`${t.toFixed(2)},${speed.toFixed(4)}`);
    }
    return lines.join('\n');
}

// Two hours of a thermal loop — a heat exchanger fed by a pump with stages —
// logged every ten seconds: the volume flow, and the water temperature at the
// inlet and at the outlet. The pump changes stage four times and is off for a
// quarter of an hour; the outlet follows each change with a first-order lag,
// and the inlet drifts slowly upwards. With `heat`, the file holds the heat
// flow instead of the two temperatures, as a logger that computes it would:
// flow / 60 × 4.186 × (T_out − T_in), in kW (water: 1 kg per litre,
// 4.186 kJ/(kg·K)).
function thermalLoopCsv({ heat = false } = {}) {
    const rnd = random(23);
    const lines = [heat ? 'timestamp,flow_Lpm [L/min],heat [kW]' : 'timestamp,flow_Lpm [L/min],T_in [°C],T_out [°C]'];
    const t0 = Date.UTC(2026, 4, 18, 9, 0, 0);
    const step = 1 / 6; // minutes
    let rise = 11;
    for (let i = 0; i <= 720; i++) {
        const minute = i * step;
        const stage = minute < 10 ? 12 : minute < 35 ? 24 : minute < 50 ? 0 : minute < 80 ? 18 : 30;
        const flow = stage ? stage + 0.3 * (rnd() - 0.5) : 0;
        // The exchanger warms a slower flow more; with the pump off the water
        // standing in it creeps towards the hot side.
        rise += ((stage ? 14 - 0.25 * stage : 20) - rise) * (step / (stage ? 3 : 12));
        const tIn = 40 + 3 * (minute / 120) + 0.15 * (rnd() - 0.5);
        const tOut = tIn + rise + 0.2 * (rnd() - 0.5);
        const stamp = new Date(t0 + i * 10000).toISOString().slice(0, 19).replace('T', ' ');
        const cells = heat
            ? [flow.toFixed(2), ((flow / 60) * 4.186 * (tOut - tIn)).toFixed(3)]
            : [flow.toFixed(2), tIn.toFixed(2), tOut.toFixed(2)];
        lines.push(`${stamp},${cells.join(',')}`);
    }
    return lines.join('\n');
}

// An oven whose set point is stepped up at t = 60 s: the temperature answers
// as a first-order system with a time constant of 90 s, plus sensor noise.
function ovenStepCsv() {
    const rnd = random(31);
    const lines = ['time [s],temperature [°C]'];
    for (let i = 0; i < 1200; i++) {
        const t = i * 0.5;
        const temperature = 22 + (t < 60 ? 0 : 38 * (1 - Math.exp(-(t - 60) / 90))) + 0.5 * (rnd() - 0.5);
        lines.push(`${t.toFixed(1)},${temperature.toFixed(3)}`);
    }
    return lines.join('\n');
}

// A leak test: a vessel is pressurised, settles for a few minutes while the
// gas cools, and then loses about 0.012 bar per minute.
function leakTestCsv() {
    const rnd = random(57);
    const lines = ['time [min],pressure [bar]'];
    for (let i = 0; i <= 720; i++) {
        const t = i / 12;
        const pressure = 7.6 + 0.4 * Math.exp(-t / 3) - 0.012 * t + 0.03 * (rnd() - 0.5);
        lines.push(`${t.toFixed(3)},${pressure.toFixed(4)}`);
    }
    return lines.join('\n');
}

// A process line as its logger writes it, four rows a second, the time in
// seconds since it started: the pressure of a circuit, its flow and the
// current of the pump's motor. From the row
// `eventAt` on, the pressure falls away — a filter clogging — the flow goes
// with it and the motor draws more.
const LINE_HEADER = 'time [s],pressure_bar,flow_m3h,motor_A';
const LINE_CHANNELS = [{ name: 'pressure_bar', unit: 'bar' }, { name: 'flow_m3h', unit: 'm³/h' }, { name: 'motor_A', unit: 'A' }];
function processLine() {
    const rnd = random(77);
    return (i, eventAt = Infinity) => {
        const since = Math.max(0, i - eventAt) / 4; // seconds into the event
        const fall = 1 - Math.exp(-since / 1.6);
        const pressure = 6.2 - 2.4 * fall + 0.25 * Math.sin(i / 9) + 0.12 * (rnd() - 0.5);
        const flow = 12 - 3.6 * fall + 0.4 * Math.sin(i / 14 + 1) + 0.2 * (rnd() - 0.5);
        const current = 9 + 1.9 * fall + 0.3 * Math.sin(i / 6) + 0.15 * (rnd() - 0.5);
        return `${(i / 4).toFixed(2)},${pressure.toFixed(2)},${flow.toFixed(2)},${current.toFixed(2)}`;
    };
}

// ─── Small helpers ─────────────────────────────────────────────────────────

/** The drop-down list, inside `root`, that offers this value. */
function listWith(root, value) {
    const found = Array.from(root.querySelectorAll('select')).find((s) => Array.from(s.options).some((o) => o.value === value));
    if (!found) throw new Error(`guide: no list offering ${value}`);
    return found;
}

/** Where a data point of a Plotly plot is, in pixels of the frame. */
function plotPoint(gd, x, y) {
    const r = gd.getBoundingClientRect();
    const xa = gd._fullLayout.xaxis;
    const ya = gd._fullLayout.yaxis;
    return [r.left + xa._offset + xa.l2p(xa.d2l(x)), r.top + ya._offset + ya.l2p(ya.d2l(y))];
}

/**
 * The pixel of a longitude and a latitude on the gridded map, so that a demo
 * can point at a place and not at a corner of the drawing area. Like
 * `plotArea`, it mixes the element's rectangle with Plotly's own layout, so it
 * is read with the camera at rest.
 */
function mapPoint(gd, lon, lat) {
    const r = gd.getBoundingClientRect();
    const xa = gd._fullLayout.xaxis;
    const ya = gd._fullLayout.yaxis;
    return [r.left + xa._offset + xa.l2p(lon), r.top + ya._offset + ya.l2p(lat)];
}

/** A point of a plot's drawing area, as fractions of it (0,0 = top left). */
function plotArea(gd, fx, fy) {
    const r = gd.getBoundingClientRect();
    const xa = gd._fullLayout.xaxis;
    const ya = gd._fullLayout.yaxis;
    return [r.left + xa._offset + xa._length * fx, r.top + ya._offset + ya._length * fy];
}

/** Where a time (an x value) is on a plot, at a fraction of the drawing area's height. */
function plotAt(gd, x, fy = 0.5) {
    const r = gd.getBoundingClientRect();
    const xa = gd._fullLayout.xaxis;
    const ya = gd._fullLayout.yaxis;
    return [r.left + xa._offset + xa.l2p(xa.d2l(x)), r.top + ya._offset + ya._length * fy];
}

/** The time-series plot of a panel — with an analysis on, the pane that keeps the signal. */
function timePlot(d, panelIndex = 0) {
    return d.app.plotManager.plots.get(d.panel(panelIndex)?.dataset.id)?.div || null;
}

/** True while an analysis of this panel is still computing (its pill is up). */
function computing(d, panelIndex = 0) {
    return !!d.panel(panelIndex)?.querySelector('.analysis-computing-indicator.active');
}

/**
 * Drag an edge of the green stretch an analysis works on ('x1' its start, 'x2'
 * its end) to a time, on the plot. Where the edge is now is read from the
 * field that shows it in the analysis' options.
 */
async function dragRangeEdge(d, key, to, { fy = 0.5, panelIndex = 0 } = {}) {
    const field = d.panel(panelIndex).querySelector(`[data-analysis-range-key="${key}"][data-analysis-range-role="slider"]`);
    if (!field) throw new Error(`guide: no range bound ${key}`);
    const gd = timePlot(d, panelIndex);
    await d.drag(plotAt(gd, Number(field.value), fy), plotAt(gd, to, fy), { ms: 1100 });
}

// ─── The chapters ──────────────────────────────────────────────────────────

export const GUIDE_CHAPTERS = [
    {
        id: 'csv-parsing', g: 'import', icon: '▦', est: 30000,
        t: say('Re-read a CSV your way', 'Relire un CSV à votre façon', 'Releer un CSV a su manera', 'Rileggere un CSV a modo tuo', '按你的方式重新解析 CSV'),
        d: say(
            'The app guesses the delimiter, the decimals, the units and the dates of a text file. When it guesses wrong, <b>▦</b> next to the file name opens the same choices again — with a live preview — without reloading the file or losing your plots.',
            'L’application devine le séparateur, les décimales, les unités et les dates d’un fichier texte. Si elle se trompe, <b>▦</b> à côté du nom du fichier rouvre ces choix — avec un aperçu en direct — sans recharger le fichier ni perdre vos graphiques.',
            'La app adivina el separador, los decimales, las unidades y las fechas de un archivo de texto. Si se equivoca, <b>▦</b> junto al nombre del archivo vuelve a abrir esas opciones — con vista previa en vivo — sin recargar el archivo ni perder los gráficos.',
            'L’app indovina separatore, decimali, unità e date di un file di testo. Se sbaglia, <b>▦</b> accanto al nome del file riapre quelle scelte — con anteprima dal vivo — senza ricaricare il file né perdere i grafici.',
            '应用会自动判断文本文件的分隔符、小数点、单位和日期。判断有误时，文件名旁的 <b>▦</b> 可重新打开这些选项（带实时预览），无需重新加载文件，图表也不会丢失。',
        ),
        async setup(d) {
            await d.loadText('logger_march.csv', loggerCsv());
            // The curve is already on a panel, as it would be after a first look.
            d.app.plotManager._handleVariableDrop(d.panel(0).dataset.id, ['power_kW'], d.panel(0), { axis: 'y' });
            await d.until(() => d.$('.layout-panel .js-plotly-plot'), 6000);
        },
        async run(d) {
            d.say(say(
                'Nine days in March… drawn as nine months',
                'Neuf jours de mars… tracés comme neuf mois',
                'Nueve días de marzo… dibujados como nueve meses',
                'Nove giorni di marzo… disegnati come nove mesi',
                '三月的九天……却被画成了九个月',
            ));
            await d.wait(2600);
            d.say(say(
                '<b>03/04</b> was read as 3 April, not March 4',
                '<b>03/04</b> a été lu comme le 3 avril, pas le 4 mars',
                '<b>03/04</b> se leyó como 3 de abril, no 4 de marzo',
                '<b>03/04</b> è stato letto come 3 aprile, non 4 marzo',
                '<b>03/04</b> 被读成了 4 月 3 日，而不是 3 月 4 日',
            ));
            await d.wait(2400);
            const button = d.$('.file-entry.active .file-entry-csv-parsing');
            await d.cam(['#files-section', '#variables-tree'], 1.5, 700);
            d.say(say(
                '<b>▦</b> next to the file: adjust how it is read',
                '<b>▦</b> à côté du fichier : ajuster sa lecture',
                '<b>▦</b> junto al archivo: ajustar cómo se lee',
                '<b>▦</b> accanto al file: regola come viene letto',
                '文件旁的 <b>▦</b>：调整读取方式',
            ));
            await d.tap(button, { after: 200 });
            await d.until(() => d.$('.csv-preview-overlay.show .csv-preview-side'), 6000);
            await d.wait(500);
            const dialog = d.$('.csv-preview-dialog');
            await d.cam(dialog, 1.05, 900);
            d.say(say(
                'The file as it will be read, row by row',
                'Le fichier tel qu’il sera lu, ligne par ligne',
                'El archivo tal como se leerá, fila por fila',
                'Il file come verrà letto, riga per riga',
                '逐行预览文件将被如何读取',
            ));
            await d.wait(2200);
            const order = listWith(dialog, 'MDY');
            await d.reveal(order);
            d.say(say(
                'Date order: <b>month first</b>',
                'Ordre de la date : <b>le mois d’abord</b>',
                'Orden de la fecha: <b>primero el mes</b>',
                'Ordine della data: <b>prima il mese</b>',
                '日期顺序：<b>月在前</b>',
            ));
            await d.choose(order, 'MDY');
            await d.wait(900);
            d.say(say(
                'The preview follows at once',
                'L’aperçu suit aussitôt',
                'La vista previa se actualiza al instante',
                'L’anteprima si aggiorna subito',
                '预览立即更新',
            ));
            await d.move({ sel: '.csv-preview-dialog table tbody tr:nth-child(4) td:nth-child(2)' }).catch(() => {});
            await d.wait(1800);
            await d.tap('.csv-preview-dialog .modal-btn-confirm', { after: 300 });
            await d.until(() => !d.$('.csv-preview-overlay.show'), 6000);
            await d.cam(null, null, 900);
            d.say(say(
                'The dates are right now. <b>⛶</b> fits the view',
                'Les dates sont justes. <b>⛶</b> ajuste la vue',
                'Las fechas ya son correctas. <b>⛶</b> ajusta la vista',
                'Ora le date sono giuste. <b>⛶</b> adatta la vista',
                '日期已正确。<b>⛶</b> 自适应视图',
            ));
            await d.wait(900);
            await d.tap(d.panel(0).querySelector('.panel-autoscale-btn'));
            await d.wait(1500);
            d.say(say(
                'Same plot, right dates — nothing to reload',
                'Même graphique, bonnes dates — rien à recharger',
                'El mismo gráfico, con las fechas correctas — sin recargar nada',
                'Stesso grafico, date giuste — niente da ricaricare',
                '同一张图，日期已正确——无需重新加载',
            ));
            await d.wait(1200);
        },
    },

    {
        id: 'time-dashboard', g: 'plots', icon: '▤', est: 32000,
        t: say('Several signals, and the dashboard', 'Plusieurs signaux, et le tableau de bord', 'Varias señales, y el tablero', 'Più segnali, e la dashboard', '多个信号与仪表板'),
        d: say(
            '<b>Ctrl+click</b> in the tree selects several variables, and one drag puts them all on a panel. The <b>plot type</b> button of the panel turns the same signals into a <b>dashboard</b>: a card per signal with its value, the last one or the one at the instant of the slider.',
            '<b>Ctrl+clic</b> dans l’arbre sélectionne plusieurs variables, et un seul glisser les met toutes sur un panneau. Le bouton du <b>type de graphique</b> transforme les mêmes signaux en <b>tableau de bord</b> : une carte par signal avec sa valeur, la dernière ou celle de l’instant du curseur.',
            '<b>Ctrl+clic</b> en el árbol selecciona varias variables, y un solo arrastre las pone todas en un panel. El botón del <b>tipo de gráfico</b> convierte esas mismas señales en un <b>tablero</b>: una tarjeta por señal con su valor, el último o el del instante del deslizador.',
            '<b>Ctrl+clic</b> nell’albero seleziona più variabili, e un solo trascinamento le mette tutte su un pannello. Il pulsante del <b>tipo di grafico</b> trasforma gli stessi segnali in una <b>dashboard</b>: una scheda per segnale con il suo valore, l’ultimo o quello dell’istante del cursore.',
            '在变量树中 <b>Ctrl+点击</b> 可选中多个变量，一次拖动即可全部放到面板上。面板的<b>图表类型</b>按钮能把同样的信号变成<b>仪表板</b>：每个信号一张卡片，显示最新值或滑块所选时刻的值。',
        ),
        async setup(d) {
            await d.loadBundledResult('examples/lorenz-data.js', 'LorenzSystem_res.mat');
        },
        async run(d) {
            const panel = d.panel(0);
            d.say(say(
                '<b>Ctrl+click</b> to select x, y and z…',
                '<b>Ctrl+clic</b> pour sélectionner x, y et z…',
                '<b>Ctrl+clic</b> para seleccionar x, y y z…',
                '<b>Ctrl+clic</b> per selezionare x, y e z…',
                '<b>Ctrl+点击</b> 选中 x、y 和 z……',
            ));
            await d.select(['x', 'y', 'z']);
            d.say(say(
                '…and drag them together',
                '…et glissez-les ensemble',
                '…y arrástrelas juntas',
                '…e trascinale insieme',
                '……然后一起拖动',
            ));
            await d.plot('x', 0, { label: 'x, y, z' });
            await d.until(() => panel.querySelector('.js-plotly-plot'), 5000);
            d.say(say(
                'Three signals against time, in one drag',
                'Trois signaux en fonction du temps, en un seul glisser',
                'Tres señales en función del tiempo, en un solo arrastre',
                'Tre segnali nel tempo, con un solo trascinamento',
                '一次拖动，三个信号随时间变化',
            ));
            await d.wait(2200);

            const typeButton = panel.querySelector('.plot-type-btn');
            await d.cam({ el: typeButton, ax: 0.5 }, 1.6, 700);
            d.say(say(
                'The <b>plot type</b>: what the panel draws',
                'Le <b>type de graphique</b> : ce que dessine le panneau',
                'El <b>tipo de gráfico</b>: qué dibuja el panel',
                'Il <b>tipo di grafico</b>: che cosa disegna il pannello',
                '<b>图表类型</b>：面板绘制什么',
            ));
            await d.wait(900);
            await d.plotType('dashboard');
            await d.cam(null, null, 800);
            d.say(say(
                '<b>Dashboard</b>: a card per signal, with its value',
                '<b>Tableau de bord</b> : une carte par signal, avec sa valeur',
                '<b>Tablero</b>: una tarjeta por señal, con su valor',
                '<b>Dashboard</b>: una scheda per segnale, con il suo valore',
                '<b>仪表板</b>：每个信号一张卡片，显示其数值',
            ));
            await d.until(() => panel.querySelector('.dashboard-card'), 4000);
            await d.wait(2000);

            const slider = panel.querySelector('.dashboard-slider');
            if (slider) {
                d.say(say(
                    'The slider: the values at any instant',
                    'Le curseur : les valeurs à n’importe quel instant',
                    'El deslizador: los valores en cualquier instante',
                    'Il cursore: i valori in qualsiasi istante',
                    '滑块：任意时刻的数值',
                ));
                const lo = Number(slider.min || 0);
                const hi = Number(slider.max || 100);
                await d.slide(slider, lo + (hi - lo) * 0.35, { ms: 2200 });
                await d.wait(1600);
                const latest = panel.querySelector('.dashboard-latest-btn');
                if (latest) {
                    d.say(say(
                        '<b>Latest</b>: back to the last value read',
                        '<b>Dernière</b> : retour à la dernière valeur lue',
                        '<b>Último</b>: vuelve al último valor leído',
                        '<b>Ultimo</b>: torna all’ultimo valore letto',
                        '<b>最新</b>：回到最新读数',
                    ));
                    await d.tap(latest);
                    await d.wait(1600);
                }
            }
        },
    },

    {
        id: 'phase-plots', g: 'plots', icon: '◎', est: 60000,
        t: say('Phase plots: 2D, 2D+t, 3D, ▶x', 'Plans de phase : 2D, 2D+t, 3D, ▶x', 'Diagramas de fase: 2D, 2D+t, 3D, ▶x', 'Diagrammi di fase: 2D, 2D+t, 3D, ▶x', '相图：2D、2D+t、3D、▶x'),
        d: say(
            'The <b>plot type</b> button also draws signals against each other: one against another <b>2D</b>, the same curve along time <b>2D+t</b>, three signals in space <b>3D</b>, and the state moving with its derivative <b>▶x 2D</b>, <b>▶x 3D</b>. Variables selected with <b>Ctrl+click</b> fill X, Y, Z in the order they were picked.',
            'Le bouton du <b>type de graphique</b> trace aussi des signaux l’un contre l’autre : un en fonction d’un autre <b>2D</b>, la même courbe dans le temps <b>2D+t</b>, trois signaux dans l’espace <b>3D</b>, et l’état qui bouge avec sa dérivée <b>▶x 2D</b>, <b>▶x 3D</b>. Les variables choisies au <b>Ctrl+clic</b> remplissent X, Y, Z dans l’ordre de sélection.',
            'El botón del <b>tipo de gráfico</b> también dibuja señales unas contra otras: una contra otra <b>2D</b>, la misma curva a lo largo del tiempo <b>2D+t</b>, tres señales en el espacio <b>3D</b>, y el estado moviéndose con su derivada <b>▶x 2D</b>, <b>▶x 3D</b>. Las variables elegidas con <b>Ctrl+clic</b> llenan X, Y, Z en el orden en que se eligieron.',
            'Il pulsante del <b>tipo di grafico</b> disegna anche segnali l’uno contro l’altro: uno contro un altro <b>2D</b>, la stessa curva lungo il tempo <b>2D+t</b>, tre segnali nello spazio <b>3D</b>, e lo stato in movimento con la sua derivata <b>▶x 2D</b>, <b>▶x 3D</b>. Le variabili scelte con <b>Ctrl+clic</b> riempiono X, Y, Z nell’ordine in cui sono state scelte.',
            '<b>图表类型</b>按钮还能把信号相互对照绘制：一个对另一个 <b>2D</b>、同一曲线沿时间展开 <b>2D+t</b>、三个信号构成空间曲线 <b>3D</b>，以及状态随其导数运动 <b>▶x 2D</b>、<b>▶x 3D</b>。用 <b>Ctrl+点击</b> 选中的变量按选择顺序填入 X、Y、Z。',
        ),
        async setup(d) {
            await d.loadBundledResult('examples/lorenz-data.js', 'LorenzSystem_res.mat');
        },
        async run(d) {
            const panel = d.panel(0);
            await d.cam({ el: panel.querySelector('.plot-type-btn'), ax: 0.5 }, 1.6, 700);
            d.say(say(
                '<b>Plot type</b> → <b>2D</b>: one signal against another',
                '<b>Type de graphique</b> → <b>2D</b> : un signal en fonction d’un autre',
                '<b>Tipo de gráfico</b> → <b>2D</b>: una señal contra otra',
                '<b>Tipo di grafico</b> → <b>2D</b>: un segnale contro un altro',
                '<b>图表类型</b> → <b>2D</b>：一个信号对另一个信号',
            ));
            await d.plotType('phase2d');
            await d.cam(null, null, 700);
            d.say(say(
                'Select X, then Y — x and z — and drag',
                'Sélectionnez X, puis Y — x et z — et glissez',
                'Elija X y luego Y — x y z — y arrastre',
                'Scegli X, poi Y — x e z — e trascina',
                '先选 X 再选 Y——x 和 z——然后拖动',
            ));
            await d.select(['x', 'z']);
            await d.plot('x', 0, { label: 'x, z' });
            await d.until(() => panel.querySelector('.js-plotly-plot'), 5000);
            d.say(say(
                'The butterfly of the Lorenz attractor',
                'Le papillon de l’attracteur de Lorenz',
                'La mariposa del atractor de Lorenz',
                'La farfalla dell’attrattore di Lorenz',
                '洛伦兹吸引子的“蝴蝶”',
            ));
            await d.wait(2000);

            d.say(say(
                '<b>2D+t</b>: the same curve, unrolled along time',
                '<b>2D+t</b> : la même courbe, déroulée dans le temps',
                '<b>2D+t</b>: la misma curva, desplegada en el tiempo',
                '<b>2D+t</b>: la stessa curva, srotolata nel tempo',
                '<b>2D+t</b>：同一条曲线沿时间展开',
            ));
            await d.plotType('phase2dt');
            await d.cam(null, null, 600);
            await d.plot('x', 0, { label: 'x, z' });
            await d.until(() => panel.querySelector('.js-plotly-plot'), 5000);
            await d.wait(2000);

            d.say(say(
                '<b>3D</b>: three signals — x, y, z',
                '<b>3D</b> : trois signaux — x, y, z',
                '<b>3D</b>: tres señales — x, y, z',
                '<b>3D</b>: tre segnali — x, y, z',
                '<b>3D</b>：三个信号——x、y、z',
            ));
            await d.plotType('phase3d');
            await d.cam(null, null, 600);
            await d.select(['x', 'y', 'z']);
            await d.plot('x', 0, { label: 'x, y, z' });
            await d.until(() => panel.querySelector('.js-plotly-plot'), 5000);
            d.say(say(
                'Drag to turn it around',
                'Glissez pour le faire tourner',
                'Arrastre para girarlo',
                'Trascina per ruotarlo',
                '拖动即可旋转',
            ));
            await d.wait(500);
            const scene = panel.querySelector('.js-plotly-plot');
            await d.drag({ el: scene, ax: 0.42, ay: 0.55 }, [{ el: scene, ax: 0.62, ay: 0.5 }], { ms: 1400 });
            await d.wait(1000);

            d.say(say(
                '<b>▶x 3D</b>: the state moving, with its derivative',
                '<b>▶x 3D</b> : l’état qui bouge, avec sa dérivée',
                '<b>▶x 3D</b>: el estado en movimiento, con su derivada',
                '<b>▶x 3D</b>: lo stato in movimento, con la sua derivata',
                '<b>▶x 3D</b>：运动中的状态及其导数',
            ));
            await d.plotType('state-anim-3');
            await d.cam(null, null, 600);
            await d.plot('x', 0, { label: 'x, y, z' });
            await d.until(() => panel.querySelector('.js-plotly-plot'), 5000);
            await d.wait(600);
            const play = panel.querySelector('.sa-play-btn');
            if (play) {
                d.say(say(
                    '<b>▶</b> plays the trajectory: <b>ẋ</b> is the arrow',
                    '<b>▶</b> joue la trajectoire : <b>ẋ</b> est la flèche',
                    '<b>▶</b> reproduce la trayectoria: <b>ẋ</b> es la flecha',
                    '<b>▶</b> riproduce la traiettoria: <b>ẋ</b> è la freccia',
                    '<b>▶</b> 播放轨迹：箭头即 <b>ẋ</b>',
                ));
                await d.tap(play);
            }
            await d.cam(panel.querySelector('.js-plotly-plot') || panel, 1.35, 900);
            await d.wait(3600);
        },
    },
    {
        id: 'data-tools', g: 'signals', icon: '⚒', est: 40000,
        t: say('Data tools: clean, filter, differentiate', 'Outils de données : nettoyer, filtrer, dériver', 'Herramientas de datos: limpiar, filtrar, derivar', 'Strumenti dati: pulire, filtrare, derivare', '数据工具：清理、滤波、求导'),
        d: say(
            'The <b>Data tools</b> of the side panel make new signals out of the ones in the file: take the spikes out, filter the noise with a designed low-pass, differentiate, integrate, resample… Each tool previews its result on the plot before it is created, and every result is a signal like any other — the next tool can start from it.',
            'Les <b>Outils de données</b> du panneau latéral créent de nouveaux signaux à partir de ceux du fichier : retirer les pics, filtrer le bruit avec un passe-bas calculé, dériver, intégrer, rééchantillonner… Chaque outil montre un aperçu de son résultat sur le graphique avant de le créer, et chaque résultat est un signal comme les autres — l’outil suivant peut en partir.',
            'Las <b>Herramientas de datos</b> del panel lateral crean señales nuevas a partir de las del archivo: quitar los picos, filtrar el ruido con un pasa bajos diseñado, derivar, integrar, remuestrear… Cada herramienta muestra una vista previa de su resultado en el gráfico antes de crearlo, y cada resultado es una señal como cualquier otra — la siguiente herramienta puede partir de ella.',
            'Gli <b>Strumenti dati</b> del pannello laterale creano nuovi segnali da quelli del file: togliere i picchi, filtrare il rumore con un passa-basso progettato, derivare, integrare, ricampionare… Ogni strumento mostra un’anteprima del risultato sul grafico prima di crearlo, e ogni risultato è un segnale come gli altri — lo strumento successivo può partire da lì.',
            '侧栏的<b>数据工具</b>用文件里的信号生成新信号：去掉尖峰、用设计好的低通滤除噪声、求导、积分、重采样……每个工具在创建前都会在图上预览结果，而每个结果都和普通信号一样——下一个工具可以接着用它。',
        ),
        async setup(d) {
            await d.loadText('shaft_speed.csv', shaftSpeedCsv());
            // The measured signal is already on a panel, as after a first look.
            d.app.plotManager._handleVariableDrop(d.panel(0).dataset.id, ['speed'], d.panel(0), { axis: 'y' });
            await d.until(() => d.$('.layout-panel .js-plotly-plot')?._fullLayout, 6000);
        },
        async run(d) {
            const tools = d.$('.data-tools-section');
            const source = d.$('#outlier-variable');
            const createAndPlot = d.$('#data-tool-create-plot');
            // (the list of transformations under the tools: one row per signal made)
            const made = () => d.$$('#data-tool-table .data-tool-row').length;
            // A tool is opened by its tile; its form opens on the signal to pick.
            const open = async (tool) => {
                await d.reveal(tools);
                await d.cam(tools, 1.5, 700);
                await d.tap(`.data-tool-tile[data-tool="${tool}"]`, { after: 200 });
                const opened = await d.until(() => d.$('#data-tool-select').value === tool && source.getClientRects().length, 4000);
                if (!opened) throw new Error(`guide: the data tool ${tool} did not open`);
                await d.reveal(source);
                await d.cam(tools, 1.5, 500);
            };
            // The signal the tool before this one made is the last of the list.
            const pickLast = async () => {
                await d.choose(source, source.options[source.options.length - 1].value, { after: 300 });
            };
            // Create and plot: the result joins the others on the panel, and the
            // gallery of tools comes back.
            const create = async () => {
                const before = made();
                await d.reveal(createAndPlot);
                await d.tap(createAndPlot, { after: 200 });
                const created = await d.until(() => d.$('#data-tool-select').value === '' && made() > before, 8000);
                if (!created) throw new Error('guide: the data tool did not create its signal');
            };

            d.say(say(
                'A shaft speed from an encoder: noise, and a few spikes',
                'La vitesse d’un arbre lue par un codeur : du bruit, et quelques pics',
                'La velocidad de un eje leída por un encoder: ruido, y algunos picos',
                'La velocità di un albero letta da un encoder: rumore, e qualche picco',
                '编码器测得的轴转速：有噪声，还有几个尖峰',
            ));
            await d.wait(1800);

            // ── Remove outliers ──
            d.say(say(
                '<b>Data tools</b> → <b>Remove outliers</b>',
                '<b>Outils de données</b> → <b>Supprimer les valeurs aberrantes</b>',
                '<b>Herramientas de datos</b> → <b>Eliminar valores atípicos</b>',
                '<b>Strumenti dati</b> → <b>Rimuovi valori anomali</b>',
                '<b>数据工具</b> → <b>去除离群值</b>',
            ));
            await open('removeOutliers');
            await d.choose(source, 'speed', { after: 300 });
            const interpolate = d.$('#outlier-replacement-wrap input[value="interpolate"]');
            await d.reveal(interpolate);
            d.say(say(
                '<b>Interpolate</b>: each spike is replaced, not left as a gap',
                '<b>Interpoler</b> : chaque pic est remplacé, sans laisser de trou',
                '<b>Interpolar</b>: cada pico se reemplaza, sin dejar un hueco',
                '<b>Interpola</b>: ogni picco viene sostituito, senza lasciare un buco',
                '<b>插值</b>：每个尖峰都被替换，不留空缺',
            ));
            await d.tap(interpolate, { after: 300 });
            await d.cam(null, null, 800);
            d.say(say(
                'The dashed curve is the preview: the spikes are gone',
                'La courbe en tirets est l’aperçu : les pics ont disparu',
                'La curva de trazos es la vista previa: los picos desaparecieron',
                'La curva tratteggiata è l’anteprima: i picchi sono spariti',
                '虚线是预览：尖峰不见了',
            ));
            await d.wait(1200);
            await create();

            // ── A designed low-pass ──
            d.say(say(
                '<b>Digital filter</b>, on the signal just made',
                '<b>Filtre numérique</b>, sur le signal qui vient d’être créé',
                '<b>Filtro digital</b>, sobre la señal recién creada',
                '<b>Filtro digitale</b>, sul segnale appena creato',
                '<b>数字滤波器</b>，作用在刚生成的信号上',
            ));
            await open('filter');
            await pickLast();
            const cutoff = d.$('#filter-design-cutoff');
            await d.reveal(cutoff);
            d.say(say(
                'A <b>Low-pass</b> is designed from its cut-off frequency: 1 Hz',
                'Un <b>Passe-bas</b> est calculé à partir de sa fréquence de coupure : 1 Hz',
                'Un <b>Pasa bajos</b> se diseña a partir de su frecuencia de corte: 1 Hz',
                'Un <b>Passa-basso</b> si progetta dalla sua frequenza di taglio: 1 Hz',
                '<b>低通</b>滤波器由截止频率设计：1 Hz',
            ));
            await d.type(cutoff, '1');
            const direction = d.$('#filter-mode');
            await d.reveal(direction);
            d.say(say(
                '<b>Forward and back</b>: the filter adds no delay',
                '<b>Aller-retour</b> : le filtre n’ajoute aucun retard',
                '<b>Ida y vuelta</b>: el filtro no agrega retardo',
                '<b>Avanti e indietro</b>: il filtro non aggiunge ritardo',
                '<b>前向再后向</b>：滤波不带来延迟',
            ));
            await d.choose(direction, 'zeroPhase', { after: 300 });
            await d.cam(null, null, 800);
            await d.wait(900);
            await create();

            // ── Its derivative ──
            d.say(say(
                '<b>Derivative</b> of the filtered speed: the acceleration',
                '<b>Dérivée</b> de la vitesse filtrée : l’accélération',
                '<b>Derivada</b> de la velocidad filtrada: la aceleración',
                '<b>Derivata</b> della velocità filtrata: l’accelerazione',
                '对滤波后的转速求<b>导数</b>：得到加速度',
            ));
            await open('derivative');
            await pickLast();
            await d.type('#outlier-output-name', 'acceleration', { enter: false, speed: 60 });
            await d.cam(null, null, 800);
            await create();
            d.say(say(
                'Three tools in a chain — each result is a signal of the file',
                'Trois outils à la chaîne — chaque résultat est un signal du fichier',
                'Tres herramientas en cadena — cada resultado es una señal del archivo',
                'Tre strumenti in catena — ogni risultato è un segnale del file',
                '三个工具串联——每个结果都是文件里的一个信号',
            ));
            await d.move(plotArea(d.$('.layout-panel .js-plotly-plot'), 0.3, 0.45));
            await d.wait(2200);
        },
    },

    {
        id: 'derived-variables', g: 'signals', icon: 'ƒ', est: 35000,
        t: say('Derived variables: a formula of signals', 'Variables dérivées : une formule de signaux', 'Variables derivadas: una fórmula de señales', 'Variabili derivate: una formula di segnali', '派生变量：用信号写公式'),
        d: say(
            '<b>New variable…</b> in the side panel computes a signal from the others with a formula: here the heat flow of a thermal loop, <b>flow × heat capacity × temperature difference</b>. The names of the signals are offered as you type, and the new variable is plotted, filtered and analysed like a measured one.',
            '<b>Nouvelle variable…</b> dans le panneau latéral calcule un signal à partir des autres avec une formule : ici le flux de chaleur d’une boucle thermique, <b>débit × capacité thermique × écart de température</b>. Les noms des signaux sont proposés pendant la frappe, et la nouvelle variable se trace, se filtre et s’analyse comme une mesure.',
            '<b>Nueva variable…</b> en el panel lateral calcula una señal a partir de las otras con una fórmula: aquí el flujo de calor de un lazo térmico, <b>caudal × capacidad calorífica × diferencia de temperatura</b>. Los nombres de las señales se ofrecen mientras escribe, y la nueva variable se grafica, se filtra y se analiza como una medida.',
            '<b>Nuova variabile…</b> nel pannello laterale calcola un segnale dagli altri con una formula: qui il flusso di calore di un circuito termico, <b>portata × capacità termica × differenza di temperatura</b>. I nomi dei segnali vengono proposti mentre scrivi, e la nuova variabile si traccia, si filtra e si analizza come una misura.',
            '侧栏的<b>新建变量…</b>用公式由其他信号算出一个新信号：这里是热力回路的热流量，<b>流量 × 比热容 × 温差</b>。输入时会提示信号名，新变量可以像实测信号一样绘图、滤波和分析。',
        ),
        async setup(d) {
            await d.loadText('thermal_loop.csv', thermalLoopCsv());
        },
        async run(d) {
            const suggestion = (name) => d.$$('#derived-suggestions .derived-suggestion')
                .find((e) => e.dataset.suggestionName === name && e.getClientRects().length);
            d.say(say(
                'A thermal loop: the flow, the inlet and the outlet temperature',
                'Une boucle thermique : le débit, la température d’entrée et de sortie',
                'Un lazo térmico: el caudal, la temperatura de entrada y la de salida',
                'Un circuito termico: la portata, la temperatura di ingresso e di uscita',
                '一个热力回路：流量、进口温度和出口温度',
            ));
            await d.select(['flow_Lpm', 'T_in', 'T_out']);
            await d.plot('flow_Lpm', 0, { label: 'flow_Lpm, T_in, T_out' });
            await d.until(() => d.panel(0).querySelector('.js-plotly-plot')?._fullLayout, 5000);
            await d.wait(1600);

            const section = d.$('.derived-section');
            await d.reveal(section);
            await d.cam(section, 1.5, 700);
            d.say(say(
                '<b>New variable…</b>: a name, and a formula',
                '<b>Nouvelle variable…</b> : un nom, et une formule',
                '<b>Nueva variable…</b>: un nombre y una fórmula',
                '<b>Nuova variabile…</b>: un nome e una formula',
                '<b>新建变量…</b>：一个名字，一个公式',
            ));
            await d.tap('#derived-toggle', { after: 300 });
            await d.until(() => d.$('#derived-name').getClientRects().length, 3000);
            await d.reveal('#derived-create');
            await d.cam(section, 1.5, 500);
            await d.type('#derived-name', 'heat_kW', { enter: false, speed: 70 });

            d.say(say(
                'Type a few letters: the signals of the file are offered',
                'Tapez quelques lettres : les signaux du fichier sont proposés',
                'Escriba unas letras: se ofrecen las señales del archivo',
                'Scrivi qualche lettera: vengono proposti i segnali del file',
                '输入几个字母：文件里的信号就会被提示出来',
            ));
            await d.type('#derived-formula', 'flo', { enter: false, change: false, speed: 160 });
            if (!await d.until(() => suggestion('flow_Lpm'), 3000)) throw new Error('guide: the formula field did not offer flow_Lpm');
            await d.wait(500);
            await d.tap(suggestion('flow_Lpm'), { after: 400 });
            d.say(say(
                'Heat flow in kW: flow × heat capacity × temperature difference',
                'Flux de chaleur en kW : débit × capacité thermique × écart de température',
                'Flujo de calor en kW: caudal × capacidad calorífica × diferencia de temperatura',
                'Flusso di calore in kW: portata × capacità termica × differenza di temperatura',
                '热流量（kW）：流量 × 比热容 × 温差',
            ));
            await d.type('#derived-formula', ' / 60 * 4.186 * (T_out - T_in)', { append: true, enter: false, change: false, speed: 75 });
            await d.wait(900);
            await d.tap('#derived-create', { after: 300 });
            if (!await d.until(() => d.app.plotManager.data?.variables?.heat_kW, 6000)) throw new Error('guide: heat_kW was not created');

            await d.cam(null, null, 800);
            const split = d.panel(0).querySelectorAll('.layout-panel-toolbar > .layout-toolbar-btn')[2];
            d.say(say(
                '<b>▼</b> splits the panel: <b>heat_kW</b> under the measurements',
                '<b>▼</b> divise le panneau : <b>heat_kW</b> sous les mesures',
                '<b>▼</b> divide el panel: <b>heat_kW</b> bajo las medidas',
                '<b>▼</b> divide il pannello: <b>heat_kW</b> sotto le misure',
                '<b>▼</b>拆分面板：把 <b>heat_kW</b> 放在实测信号下方',
            ));
            await d.tap(split);
            await d.until(() => d.panels().length === 2, 3000);
            // (the three measurements are still selected: only the new one is dragged)
            const row = await d.variable('heat_kW');
            await d.tap({ el: row.querySelector('.tree-label') || row }, { after: 200 });
            await d.plot('heat_kW', 1);
            if (!await d.until(() => d.panel(1).querySelector('.js-plotly-plot')?._fullLayout, 6000)) throw new Error('guide: heat_kW was not plotted');
            await d.wait(600);

            const heat = d.panel(1).querySelector('.js-plotly-plot');
            d.say(say(
                'It jumps with every pump stage, then settles as the outlet follows',
                'Il saute à chaque palier de la pompe, puis se stabilise quand la sortie suit',
                'Salta con cada etapa de la bomba y luego se estabiliza cuando la salida la sigue',
                'Salta a ogni stadio della pompa, poi si assesta quando l’uscita segue',
                '水泵每换一档它就跳变，随后随出口温度稳定下来',
            ));
            await d.move(plotArea(heat, 0.1, 0.35));
            await d.move(plotArea(heat, 0.2, 0.3), 900);
            await d.wait(1500);
            d.say(say(
                'Pump off: no flow, so the heat flow reads zero',
                'Pompe arrêtée : pas de débit, donc un flux de chaleur nul',
                'Bomba apagada: sin caudal, el flujo de calor marca cero',
                'Pompa ferma: nessuna portata, quindi il flusso di calore è zero',
                '水泵停机：没有流量，热流量就是零',
            ));
            await d.move(plotArea(heat, 0.35, 0.85), 900);
            await d.wait(2200);
        },
    },

    {
        id: 'fft', g: 'analysis', icon: '∿', est: 34000,
        t: say('Frequency spectrum (FFT)', 'Spectre de fréquence (FFT)', 'Espectro de frecuencia (FFT)', 'Spettro di frequenza (FFT)', '频谱 (FFT)'),
        d: say(
            'Any time-series panel can show the spectrum of its signals: <b>Analysis ▾ → Fourier (FFT)</b>. Choose a window, analyse only a part of the record, limit the frequency axis, and read the peaks with the pointer.',
            'Tout panneau de séries temporelles peut montrer le spectre de ses signaux : <b>Analyse ▾ → Fourier (FFT)</b>. Choisissez une fenêtre, n’analysez qu’une partie de l’enregistrement, limitez l’axe des fréquences et lisez les pics avec le pointeur.',
            'Cualquier panel de series temporales puede mostrar el espectro de sus señales: <b>Análisis ▾ → Fourier (FFT)</b>. Elija una ventana, analice solo una parte del registro, limite el eje de frecuencia y lea los picos con el puntero.',
            'Ogni pannello di serie temporali può mostrare lo spettro dei suoi segnali: <b>Analisi ▾ → Fourier (FFT)</b>. Scegli una finestra, analizza solo una parte della registrazione, limita l’asse delle frequenze e leggi i picchi con il puntatore.',
            '任何时间序列面板都能显示信号的频谱：<b>分析 ▾ → Fourier (FFT)</b>。可选择窗函数、只分析记录的一部分、限制频率轴，并用指针读取峰值。',
        ),
        async setup(d) {
            await d.loadText('motor_vibration.csv', motorCsv());
        },
        async run(d) {
            d.say(say(
                'Drag a signal onto a panel',
                'Glissez un signal sur un panneau',
                'Arrastre una señal a un panel',
                'Trascina un segnale su un pannello',
                '把信号拖到面板上',
            ));
            await d.plot('vibration');
            await d.until(() => d.$('.layout-panel .js-plotly-plot'), 5000);
            d.say(say(
                'Noise… what is in it?',
                'Du bruit… que contient-il ?',
                'Ruido… ¿qué hay dentro?',
                'Rumore… cosa c’è dentro?',
                '一片噪声……里面有什么？',
            ));
            await d.wait(1800);
            const toolbar = d.panel(0).querySelector('.layout-panel-toolbar');
            await d.cam({ el: toolbar, ax: 0.62 }, 1.5, 700);
            d.say(say(
                '<b>Analysis ▾</b> → Fourier (FFT)',
                '<b>Analyse ▾</b> → Fourier (FFT)',
                '<b>Análisis ▾</b> → Fourier (FFT)',
                '<b>Analisi ▾</b> → Fourier (FFT)',
                '<b>分析 ▾</b> → Fourier (FFT)',
            ));
            await d.analysis('fft');
            await d.until(() => d.$('.fft-spectrum-pane .js-plotly-plot')?._fullLayout && /ready/.test(d.$('.fft-status')?.className || ''), 8000);
            await d.cam(null, null, 900);
            const spectrum = d.$('.fft-spectrum-pane .js-plotly-plot');
            d.say(say(
                'The signal above, its spectrum below',
                'Le signal en haut, son spectre en bas',
                'Arriba la señal, abajo su espectro',
                'Sopra il segnale, sotto il suo spettro',
                '上方是信号，下方是它的频谱',
            ));
            await d.wait(2000);

            // Read the two peaks with the pointer.
            await d.cam(spectrum, 1.25, 800);
            d.say(say(
                'Two tones: <b>50 Hz</b> and <b>120 Hz</b>',
                'Deux tons : <b>50 Hz</b> et <b>120 Hz</b>',
                'Dos tonos: <b>50 Hz</b> y <b>120 Hz</b>',
                'Due toni: <b>50 Hz</b> e <b>120 Hz</b>',
                '两个频率成分：<b>50 Hz</b> 和 <b>120 Hz</b>',
            ));
            await d.move(plotPoint(spectrum, 50, 0.5));
            await d.wait(1300);
            await d.move(plotPoint(spectrum, 120, 0.3));
            await d.wait(1300);

            // Options: a window, then the frequency axis.
            const options = d.$('.fft-options');
            await d.cam([spectrum, options], 1.1, 800);
            const windowList = listWith(options, 'hann');
            await d.reveal(windowList);
            d.say(say(
                'A <b>window</b> narrows the foot of the peaks',
                'Une <b>fenêtre</b> affine le pied des pics',
                'Una <b>ventana</b> afina la base de los picos',
                'Una <b>finestra</b> restringe la base dei picchi',
                '<b>窗函数</b>让峰的底部更窄',
            ));
            await d.choose(windowList, 'hann');
            await d.wait(1200);
            const fmax = d.$$('.fft-axis-limit-slider')[1];
            await d.reveal(fmax);
            d.say(say(
                'Limit the frequency axis to look closer',
                'Limitez l’axe des fréquences pour voir de plus près',
                'Limite el eje de frecuencia para ver más de cerca',
                'Limita l’asse delle frequenze per guardare più da vicino',
                '限制频率轴，看得更仔细',
            ));
            const lo = Number(fmax.min || 0);
            const hi = Number(fmax.max || 100);
            await d.slide(fmax, lo + (hi - lo) * 0.4, { ms: 1300 });
            await d.wait(1200);

            // Only a part of the record.
            const segmented = options.querySelector('.fft-segmented');
            await d.reveal(segmented);
            await d.cam(null, null, 800);
            d.say(say(
                '<b>Selection</b>: the spectrum of a part of the record',
                '<b>Sélection</b> : le spectre d’une partie de l’enregistrement',
                '<b>Selección</b>: el espectro de una parte del registro',
                '<b>Selezione</b>: lo spettro di una parte della registrazione',
                '<b>选区</b>：只看记录中一段的频谱',
            ));
            await d.tap(segmented.querySelectorAll('button')[1]);
            await d.wait(500);
            const end = d.$$('.fft-range-bound .fft-range-input')[1];
            const e0 = Number(end.min || 0);
            const e1 = Number(end.max || 100);
            await d.slide(end, e0 + (e1 - e0) * 0.3, { ms: 1400 });
            await d.wait(1400);
        },
    },

    {
        id: 'temporal-profile', g: 'analysis', icon: '◔', est: 30000,
        t: say('Temporal profile', 'Profil temporel', 'Perfil temporal', 'Profilo temporale', '时间剖面'),
        d: say(
            'What does a typical day look like? <b>Analysis ▾ → Temporal profile</b> folds a long record onto one day, week, month or year and draws the mean with its spread — all days together, or working days and weekends apart.',
            'À quoi ressemble une journée type ? <b>Analyse ▾ → Profil temporel</b> replie un long enregistrement sur un jour, une semaine, un mois ou une année et trace la moyenne avec sa dispersion — tous les jours ensemble, ou jours ouvrés et week-ends séparés.',
            '¿Cómo es un día típico? <b>Análisis ▾ → Perfil temporal</b> pliega un registro largo sobre un día, una semana, un mes o un año y dibuja la media con su dispersión — todos los días juntos, o laborables y fines de semana por separado.',
            'Com’è una giornata tipo? <b>Analisi ▾ → Profilo temporale</b> ripiega una lunga registrazione su un giorno, una settimana, un mese o un anno e disegna la media con la sua dispersione — tutti i giorni insieme, o feriali e fine settimana separati.',
            '典型的一天是什么样？<b>分析 ▾ → 时间剖面</b>把一段长记录折叠到一天、一周、一月或一年上，画出均值及其离散程度——所有日子合在一起，或工作日与周末分开。',
        ),
        async setup(d) {
            await d.loadText('building_load.csv', buildingCsv());
        },
        async run(d) {
            d.say(say(
                'Eight weeks of hourly consumption',
                'Huit semaines de consommation horaire',
                'Ocho semanas de consumo horario',
                'Otto settimane di consumi orari',
                '八周的逐小时用电量',
            ));
            await d.plot('load_kW');
            await d.until(() => d.$('.layout-panel .js-plotly-plot'), 5000);
            await d.wait(1500);
            const toolbar = d.panel(0).querySelector('.layout-panel-toolbar');
            await d.cam({ el: toolbar, ax: 0.62 }, 1.5, 700);
            d.say(say(
                '<b>Analysis ▾</b> → Temporal profile',
                '<b>Analyse ▾</b> → Profil temporel',
                '<b>Análisis ▾</b> → Perfil temporal',
                '<b>Analisi ▾</b> → Profilo temporale',
                '<b>分析 ▾</b> → 时间剖面',
            ));
            await d.analysis('temporal-profile');
            const segs = () => d.$$('.layout-panel .hist-seg-btn');
            await d.until(() => segs().length >= 7 && d.$$('.layout-panel .js-plotly-plot').length >= 2, 8000);
            await d.cam(null, null, 900);
            d.say(say(
                'The average day: mean and <b>±1σ</b> band, hour by hour',
                'La journée moyenne : moyenne et bande <b>±1σ</b>, heure par heure',
                'El día promedio: media y banda <b>±1σ</b>, hora por hora',
                'La giornata media: media e banda <b>±1σ</b>, ora per ora',
                '平均的一天：逐小时的均值与 <b>±1σ</b> 区间',
            ));
            await d.wait(2600);

            // segs(): [Day, Week, Month, Year, Multi-year, All days, By day type, Columns, Mean line, ±1σ]
            d.say(say(
                '<b>By day type</b>: working days and weekends apart',
                '<b>Par type de jour</b> : jours ouvrés et week-ends séparés',
                '<b>Por tipo de día</b>: laborables y fines de semana por separado',
                '<b>Per tipo di giorno</b>: feriali e fine settimana separati',
                '<b>按日类型</b>：工作日与周末分开',
            ));
            await d.reveal(segs()[6]);
            await d.tap(segs()[6]);
            await d.wait(2600);

            d.say(say(
                'Period <b>Week</b>: the average week',
                'Période <b>Semaine</b> : la semaine moyenne',
                'Período <b>Semana</b>: la semana promedio',
                'Periodo <b>Settimana</b>: la settimana media',
                '周期选<b>周</b>：平均的一周',
            ));
            await d.reveal(segs()[1]);
            await d.tap(segs()[1]);
            await d.wait(2600);

            const profile = d.$$('.layout-panel .js-plotly-plot')[1];
            d.say(say(
                'Point at the curve to read a value',
                'Pointez la courbe pour lire une valeur',
                'Apunte a la curva para leer un valor',
                'Punta la curva per leggere un valore',
                '指向曲线即可读数',
            ));
            await d.move(plotArea(profile, 0.12, 0.45));
            await d.move(plotArea(profile, 0.62, 0.4), 1600);
            await d.wait(1200);
        },
    },

    {
        id: 'curve-fit', g: 'analysis', icon: '⌒', est: 28000,
        t: say('Curve fit: a time constant', 'Ajustement de courbes : une constante de temps', 'Ajuste de curvas: una constante de tiempo', 'Adattamento curve: una costante di tempo', '曲线拟合：求时间常数'),
        d: say(
            '<b>Analysis ▾ → Curve fit</b> fits a line, a parabola, a power law, an exponential or a <b>first-order response</b> to a stretch of a signal. Place the green stretch on the plot, choose the model, and read the parameters — here the time constant <b>τ</b> of a temperature settling after a step — with the residuals in the pane below.',
            '<b>Analyse ▾ → Ajustement de courbes</b> ajuste une droite, une parabole, une loi de puissance, une exponentielle ou une <b>réponse du premier ordre</b> sur un tronçon d’un signal. Placez le tronçon vert sur le graphique, choisissez le modèle et lisez les paramètres — ici la constante de temps <b>τ</b> d’une température qui se stabilise après un échelon — avec les résidus dans le volet du bas.',
            '<b>Análisis ▾ → Ajuste de curvas</b> ajusta una recta, una parábola, una ley de potencia, una exponencial o una <b>respuesta de primer orden</b> a un tramo de una señal. Coloque el tramo verde en el gráfico, elija el modelo y lea los parámetros — aquí la constante de tiempo <b>τ</b> de una temperatura que se estabiliza tras un escalón — con los residuos en el panel de abajo.',
            '<b>Analisi ▾ → Adattamento curve</b> adatta una retta, una parabola, una legge di potenza, un’esponenziale o una <b>risposta del primo ordine</b> a un tratto di un segnale. Posiziona il tratto verde sul grafico, scegli il modello e leggi i parametri — qui la costante di tempo <b>τ</b> di una temperatura che si assesta dopo un gradino — con i residui nel riquadro in basso.',
            '<b>分析 ▾ → 曲线拟合</b>可对信号的一段拟合直线、抛物线、幂函数、指数或<b>一阶响应</b>。在图上放好绿色区段，选择模型，然后读取参数——这里是温度在阶跃后趋于稳定的时间常数 <b>τ</b>——下方窗格显示残差。',
        ),
        async setup(d) {
            await d.loadText('oven_step.csv', ovenStepCsv());
        },
        async run(d) {
            const panel = d.panel(0);
            const fitted = () => {
                const result = d.app.plotManager.plots.get(panel.dataset.id)?._curveFitResults?.[0]?.result;
                return !computing(d) && result?.fit?.status === 'ok' ? result.fit : null;
            };
            d.say(say(
                'An oven after a step of its set point',
                'Un four après un échelon de sa consigne',
                'Un horno tras un escalón de su consigna',
                'Un forno dopo un gradino del setpoint',
                '设定值阶跃之后的炉温',
            ));
            await d.plot('temperature');
            await d.until(() => panel.querySelector('.js-plotly-plot')?._fullLayout, 5000);
            await d.wait(1400);
            await d.cam({ el: panel.querySelector('.layout-panel-toolbar'), ax: 0.62 }, 1.5, 700);
            d.say(say(
                '<b>Analysis ▾</b> → Curve fit',
                '<b>Analyse ▾</b> → Ajustement de courbes',
                '<b>Análisis ▾</b> → Ajuste de curvas',
                '<b>Analisi ▾</b> → Adattamento curve',
                '<b>分析 ▾</b> → 曲线拟合',
            ));
            await d.analysis('curve-fit');
            if (!await d.until(() => panel.querySelector('.curve-fit-options .phase2d-fit-type-select') && timePlot(d)?._fullLayout, 8000)) {
                throw new Error('guide: the curve fit did not open');
            }
            await d.cam(null, null, 800);

            const type = panel.querySelector('.curve-fit-options .phase2d-fit-type-select');
            d.say(say(
                'Fit type: <b>First-order response + offset</b>',
                'Type d’ajustement : <b>Réponse du premier ordre + décalage</b>',
                'Tipo de ajuste: <b>Respuesta de primer orden + offset</b>',
                'Tipo di adattamento: <b>Risposta del primo ordine + offset</b>',
                '拟合类型：<b>一阶响应 + 偏移</b>',
            ));
            await d.choose(type, 'first-order-offset');
            if (!await d.until(fitted, 15000)) throw new Error('guide: no first-order fit');
            await d.wait(700);

            d.say(say(
                'Drag the edges of the green stretch: from the step to the plateau',
                'Glissez les bords du tronçon vert : de l’échelon au palier',
                'Arrastre los bordes del tramo verde: del escalón a la meseta',
                'Trascina i bordi del tratto verde: dal gradino al plateau',
                '拖动绿色区段的两条边：从阶跃处到平台',
            ));
            await dragRangeEdge(d, 'x1', 63, { fy: 0.6 });
            await dragRangeEdge(d, 'x2', 540, { fy: 0.6 });
            // The fit follows the stretch: wait for the one of the new range.
            if (!await d.until(() => Math.abs((fitted()?.timeConstant || 0) - 90) < 15, 15000)) throw new Error('guide: the fit did not follow the stretch');
            d.say(say(
                'The dashed curve is the fit; its residuals are below',
                'La courbe en tirets est l’ajustement ; ses résidus sont en dessous',
                'La curva de trazos es el ajuste; sus residuos están debajo',
                'La curva tratteggiata è l’adattamento; i residui sono sotto',
                '虚线是拟合曲线；下方是它的残差',
            ));
            await d.wait(2200);

            const result = panel.querySelector('.curve-fit-options .phase2d-fit-result');
            await d.reveal(panel.querySelector('.curve-fit-options .phase2d-fit-stats') || result);
            await d.cam(result, 1.7, 800);
            d.say(say(
                'The time constant: <b>τ ≈ 90 s</b> — with the gain K and R²',
                'La constante de temps : <b>τ ≈ 90 s</b> — avec le gain K et R²',
                'La constante de tiempo: <b>τ ≈ 90 s</b> — con la ganancia K y R²',
                'La costante di tempo: <b>τ ≈ 90 s</b> — con il guadagno K e R²',
                '时间常数：<b>τ ≈ 90 s</b>——还有增益 K 和 R²',
            ));
            const tau = Array.from(result.querySelectorAll('.phase2d-fit-coeff')).find((e) => e.querySelector('.phase2d-fit-coeff-k')?.textContent.trim() === 'τ');
            await d.move({ el: tau || result, ax: 0.7 });
            await d.wait(3000);
            await d.cam(null, null, 800);
            await d.wait(600);
        },
    },

    {
        id: 'trend', g: 'analysis', icon: '⟋', est: 28000,
        t: say('Trend: mean and slope of a stretch', 'Tendance : moyenne et pente d’un tronçon', 'Tendencia: media y pendiente de un tramo', 'Tendenza: media e pendenza di un tratto', '趋势：一段的均值与斜率'),
        d: say(
            'Is a signal drifting, and how fast? <b>Analysis ▾ → Trend analysis</b> takes stretches of a signal and gives the mean, the spread and the slope of each — with a line, a parabola or an exponential drawn over it — in a table that compares the stretches.',
            'Un signal dérive-t-il, et à quelle vitesse ? <b>Analyse ▾ → Analyse de tendance</b> prend des tronçons d’un signal et donne la moyenne, la dispersion et la pente de chacun — avec une droite, une parabole ou une exponentielle tracée par-dessus — dans un tableau qui compare les tronçons.',
            '¿Una señal deriva, y a qué ritmo? <b>Análisis ▾ → Análisis de tendencia</b> toma tramos de una señal y da la media, la dispersión y la pendiente de cada uno — con una recta, una parábola o una exponencial dibujada encima — en una tabla que compara los tramos.',
            'Un segnale sta derivando, e a che velocità? <b>Analisi ▾ → Analisi di tendenza</b> prende tratti di un segnale e dà la media, la dispersione e la pendenza di ciascuno — con una retta, una parabola o un’esponenziale disegnata sopra — in una tabella che confronta i tratti.',
            '信号在漂移吗？漂得多快？<b>分析 ▾ → 趋势分析</b>选取信号的若干区段，给出每段的均值、离散程度和斜率——并可叠加直线、抛物线或指数曲线——再用一张表比较各段。',
        ),
        async setup(d) {
            await d.loadText('leak_test.csv', leakTestCsv());
        },
        async run(d) {
            const panel = d.panel(0);
            const options = () => panel.querySelector('.trend-options');
            d.say(say(
                'A leak test: is the pressure falling, and how fast?',
                'Un essai d’étanchéité : la pression baisse-t-elle, et à quelle vitesse ?',
                'Una prueba de fugas: ¿baja la presión, y a qué ritmo?',
                'Una prova di tenuta: la pressione scende, e a che velocità?',
                '一次泄漏测试：压力在下降吗？降得多快？',
            ));
            await d.plot('pressure');
            await d.until(() => panel.querySelector('.js-plotly-plot')?._fullLayout, 5000);
            await d.wait(1500);
            await d.cam({ el: panel.querySelector('.layout-panel-toolbar'), ax: 0.62 }, 1.5, 700);
            d.say(say(
                '<b>Analysis ▾</b> → Trend analysis',
                '<b>Analyse ▾</b> → Analyse de tendance',
                '<b>Análisis ▾</b> → Análisis de tendencia',
                '<b>Analisi ▾</b> → Analisi di tendenza',
                '<b>分析 ▾</b> → 趋势分析',
            ));
            await d.analysis('trend');
            if (!await d.until(() => options()?.querySelector('.trend-stats') && timePlot(d)?._fullLayout && !computing(d), 10000)) {
                throw new Error('guide: the trend analysis did not open');
            }
            await d.cam(null, null, 800);

            d.say(say(
                'Drag the green stretch past the settling of the first minutes',
                'Glissez le tronçon vert après la stabilisation des premières minutes',
                'Arrastre el tramo verde más allá del asentamiento de los primeros minutos',
                'Trascina il tratto verde oltre l’assestamento dei primi minuti',
                '把绿色区段拖到最初几分钟的稳定过程之后',
            ));
            await dragRangeEdge(d, 'x2', 56, { fy: 0.75 });
            await dragRangeEdge(d, 'x1', 15, { fy: 0.75 });
            await d.until(() => !computing(d), 8000);
            d.say(say(
                'The dotted line is its <b>mean</b>',
                'La ligne pointillée est sa <b>moyenne</b>',
                'La línea punteada es su <b>valor medio</b>',
                'La linea punteggiata è la sua <b>media</b>',
                '点线是它的<b>均值</b>',
            ));
            await d.wait(1800);

            const linear = options().querySelector('input[data-trend-curve="linear"]');
            await d.reveal(linear);
            d.say(say(
                '<b>Linear</b>: a line through the stretch',
                '<b>Linéaire</b> : une droite à travers le tronçon',
                '<b>Lineal</b>: una recta a través del tramo',
                '<b>Lineare</b>: una retta attraverso il tratto',
                '<b>线性</b>：过这一段的一条直线',
            ));
            await d.tap(linear, { after: 300 });
            const slope = () => Array.from(options().querySelectorAll('.trend-fit-block .phase2d-fit-coeff'))
                .find((e) => e.querySelector('.phase2d-fit-coeff-k')?.textContent.trim() === 'a');
            if (!await d.until(() => !computing(d) && slope() && timePlot(d).data.length >= 3, 10000)) throw new Error('guide: no linear trend');
            await d.wait(1600);

            await d.reveal(options().querySelector('.trend-fit-block'));
            await d.cam([options().querySelector('.trend-stats'), options().querySelector('.trend-fit-block')], 1.7, 800);
            d.say(say(
                'Mean, σ — and the slope <b>a ≈ −0.012 bar/min</b>: the leak rate',
                'Moyenne, σ — et la pente <b>a ≈ −0,012 bar/min</b> : le débit de fuite',
                'Media, σ — y la pendiente <b>a ≈ −0,012 bar/min</b>: la tasa de fuga',
                'Media, σ — e la pendenza <b>a ≈ −0,012 bar/min</b>: il tasso di perdita',
                '均值、σ——以及斜率 <b>a ≈ −0.012 bar/min</b>：即泄漏速率',
            ));
            await d.move({ el: slope(), ax: 0.7 });
            await d.wait(3200);
            await d.cam(null, null, 800);
            await d.wait(600);
        },
    },

    {
        id: 'measure', g: 'analysis', icon: '⇔', est: 40000,
        t: say('Measure: cursors, statistics, integral', 'Mesurer : curseurs, statistiques, intégrale', 'Medir: cursores, estadísticas, integral', 'Misurare: cursori, statistiche, integrale', '测量：光标、统计与积分'),
        d: say(
            'Three ways to put a number on a curve. <b>A|B</b>, the measurement cursors: two lines to drag, with the time and the value between them. <b>Σ</b>: minimum, maximum, mean and RMS of every signal of the panel. And <b>Analysis ▾ → Integral</b>: the area under a signal over a stretch — the energy, when the signal is a power.',
            'Trois façons de mettre un chiffre sur une courbe. <b>A|B</b>, les curseurs de mesure : deux lignes à glisser, avec le temps et la valeur entre elles. <b>Σ</b> : minimum, maximum, moyenne et RMS de chaque signal du panneau. Et <b>Analyse ▾ → Intégrale</b> : l’aire sous un signal sur un tronçon — l’énergie, quand le signal est une puissance.',
            'Tres maneras de ponerle un número a una curva. <b>A|B</b>, los cursores de medida: dos líneas para arrastrar, con el tiempo y el valor entre ellas. <b>Σ</b>: mínimo, máximo, media y RMS de cada señal del panel. Y <b>Análisis ▾ → Integral</b>: el área bajo una señal en un tramo — la energía, cuando la señal es una potencia.',
            'Tre modi per dare un numero a una curva. <b>A|B</b>, i cursori di misura: due linee da trascinare, con il tempo e il valore tra di esse. <b>Σ</b>: minimo, massimo, media e RMS di ogni segnale del pannello. E <b>Analisi ▾ → Integrale</b>: l’area sotto un segnale su un tratto — l’energia, quando il segnale è una potenza.',
            '给曲线读数的三种方式。<b>A|B</b> 测量光标：拖动两条线，读出它们之间的时间差和数值差。<b>Σ</b>：面板中每个信号的最小值、最大值、均值和 RMS。还有<b>分析 ▾ → 积分</b>：信号在一段上的面积——当信号是功率时，就是能量。',
        ),
        async setup(d) {
            await d.loadText('thermal_loop.csv', thermalLoopCsv({ heat: true }));
            // The heat flow is already on a panel, as after a first look.
            d.app.plotManager._handleVariableDrop(d.panel(0).dataset.id, ['heat'], d.panel(0), { axis: 'y' });
            await d.until(() => d.$('.layout-panel .js-plotly-plot')?._fullLayout, 6000);
        },
        async run(d) {
            const panel = d.panel(0);
            const minute = (m) => Date.UTC(2026, 4, 18, 9, 0, 0) + m * 60000;
            const toolbar = panel.querySelector('.layout-panel-toolbar');
            d.say(say(
                'The heat flow of a thermal loop, over two hours',
                'Le flux de chaleur d’une boucle thermique, sur deux heures',
                'El flujo de calor de un lazo térmico, durante dos horas',
                'Il flusso di calore di un circuito termico, in due ore',
                '一个热力回路两小时内的热流量',
            ));
            await d.wait(1500);

            // ── Cursors ──
            const cursorButton = panel.querySelector('.cursor-btn');
            await d.cam({ el: toolbar, ax: 0.95 }, 1.6, 700);
            d.say(say(
                '<b>A|B</b>: the measurement cursors',
                '<b>A|B</b> : les curseurs de mesure',
                '<b>A|B</b>: los cursores de medida',
                '<b>A|B</b>: i cursori di misura',
                '<b>A|B</b>：测量光标',
            ));
            await d.tap(cursorButton, { after: 300 });
            if (!await d.until(() => panel.querySelector('.cursor-overlay-line-a') && panel.querySelector('.cursor-info-values'), 4000)) {
                throw new Error('guide: the cursors did not open');
            }
            await d.cam(null, null, 800);
            const gd = timePlot(d);
            d.say(say(
                'Drag <b>A</b> to where the pump stops, <b>B</b> to where it starts again',
                'Glissez <b>A</b> à l’arrêt de la pompe, <b>B</b> à son redémarrage',
                'Arrastre <b>A</b> hasta donde se detiene la bomba, <b>B</b> hasta donde arranca de nuevo',
                'Trascina <b>A</b> dove la pompa si ferma, <b>B</b> dove riparte',
                '把 <b>A</b> 拖到水泵停机处，<b>B</b> 拖到重新启动处',
            ));
            await d.drag({ el: panel.querySelector('.cursor-overlay-line-a'), ay: 0.55 }, plotAt(gd, minute(35), 0.55), { ms: 1200 });
            await d.drag({ el: panel.querySelector('.cursor-overlay-line-b'), ay: 0.7 }, plotAt(gd, minute(50), 0.7), { ms: 1200 });
            const values = panel.querySelector('.cursor-info-values');
            await d.cam(panel.querySelector('.cursor-info-box'), 1.7, 800);
            d.say(say(
                '<b>ΔX</b>: the pump was off for a quarter of an hour',
                '<b>ΔX</b> : la pompe est restée arrêtée un quart d’heure',
                '<b>ΔX</b>: la bomba estuvo apagada un cuarto de hora',
                '<b>ΔX</b>: la pompa è rimasta ferma un quarto d’ora',
                '<b>ΔX</b>：水泵停了一刻钟',
            ));
            await d.move({ el: values, ax: 0.5, ay: 0.55 });
            await d.wait(2600);
            await d.cam(null, null, 700);
            await d.tap(panel.querySelector('.cursor-info-box .cursor-close-btn'), { after: 300 });

            // ── Σ ──
            d.say(say(
                '<b>Σ</b>: minimum, maximum, mean and RMS of each signal',
                '<b>Σ</b> : minimum, maximum, moyenne et RMS de chaque signal',
                '<b>Σ</b>: mínimo, máximo, media y RMS de cada señal',
                '<b>Σ</b>: minimo, massimo, media e RMS di ogni segnale',
                '<b>Σ</b>：每个信号的最小值、最大值、均值和 RMS',
            ));
            await d.cam({ el: toolbar, ax: 0.95 }, 1.6, 600);
            await d.tap(panel.querySelector('.panel-stats-btn'), { after: 150 });
            await d.cam(null, null, 250);
            if (!await d.modalOk({ read: 2000, after: 400 })) throw new Error('guide: no statistics');

            // ── Integral ──
            await d.cam({ el: toolbar, ax: 0.62 }, 1.5, 600);
            d.say(say(
                '<b>Analysis ▾</b> → Integral: power over time is energy',
                '<b>Analyse ▾</b> → Intégrale : une puissance dans le temps, c’est une énergie',
                '<b>Análisis ▾</b> → Integral: potencia en el tiempo es energía',
                '<b>Analisi ▾</b> → Integrale: una potenza nel tempo è un’energia',
                '<b>分析 ▾</b> → 积分：功率对时间积分就是能量',
            ));
            await d.analysis('integral');
            const total = () => (panel.querySelector('.integral-summary')?.textContent || '');
            if (!await d.until(() => /kW·h/.test(total()) && timePlot(d)?._fullLayout && !computing(d), 10000)) throw new Error('guide: no integral');
            await d.cam(null, null, 800);
            d.say(say(
                'The whole record: the energy delivered, in <b>kW·h</b>',
                'Tout l’enregistrement : l’énergie fournie, en <b>kW·h</b>',
                'Todo el registro: la energía entregada, en <b>kW·h</b>',
                'Tutta la registrazione: l’energia fornita, in <b>kW·h</b>',
                '整段记录：输送的能量，单位 <b>kW·h</b>',
            ));
            await d.wait(2200);

            const selection = panel.querySelector('.integral-options [data-analysis-range-full="false"]');
            await d.reveal(selection);
            d.say(say(
                '<b>Selection</b>: the energy of one stretch — drag its edges',
                '<b>Sélection</b> : l’énergie d’un seul tronçon — glissez ses bords',
                '<b>Selección</b>: la energía de un solo tramo — arrastre sus bordes',
                '<b>Selezione</b>: l’energia di un solo tratto — trascina i bordi',
                '<b>选区</b>：只算一段的能量——拖动它的两条边',
            ));
            await d.tap(selection, { after: 400 });
            await d.until(() => !computing(d) && timePlot(d)?._fullLayout, 8000);
            const before = total();
            await dragRangeEdge(d, 'x2', minute(80), { fy: 0.3 });
            await dragRangeEdge(d, 'x1', minute(50), { fy: 0.3 });
            if (!await d.until(() => !computing(d) && total() !== before, 10000)) throw new Error('guide: the integral did not follow the selection');
            d.say(say(
                'Half an hour at the third pump stage: about 6 kW·h',
                'Une demi-heure au troisième palier de la pompe : environ 6 kW·h',
                'Media hora en la tercera etapa de la bomba: unos 6 kW·h',
                'Mezz’ora al terzo stadio della pompa: circa 6 kW·h',
                '水泵第三档的半小时：约 6 kW·h',
            ));
            await d.move({ el: panel.querySelector('.integral-summary'), ax: 0.3 }).catch(() => {});
            await d.wait(2800);
        },
    },

    {
        id: 'modelica', g: 'tools', icon: '⚙', est: 36000,
        t: say('With OpenModelica and Dymola', 'Avec OpenModelica et Dymola', 'Con OpenModelica y Dymola', 'Con OpenModelica e Dymola', '配合 OpenModelica 与 Dymola'),
        d: say(
            'Drop the result of a simulation (<b>Model_res.mat</b>, <b>dsres.mat</b>) on the window. The model’s hierarchy, units and parameters are kept; a phase plot is two drags away; and after simulating again, <b>🔄</b> reloads the file and keeps every plot.',
            'Déposez le résultat d’une simulation (<b>Model_res.mat</b>, <b>dsres.mat</b>) sur la fenêtre. La hiérarchie du modèle, les unités et les paramètres sont conservés ; un plan de phase est à deux glissers ; et après une nouvelle simulation, <b>🔄</b> recharge le fichier en gardant tous les graphiques.',
            'Suelte el resultado de una simulación (<b>Model_res.mat</b>, <b>dsres.mat</b>) sobre la ventana. Se conservan la jerarquía del modelo, las unidades y los parámetros; un diagrama de fase está a dos arrastres; y tras simular de nuevo, <b>🔄</b> recarga el archivo y mantiene todos los gráficos.',
            'Rilascia il risultato di una simulazione (<b>Model_res.mat</b>, <b>dsres.mat</b>) sulla finestra. Gerarchia del modello, unità e parametri sono conservati; un diagramma di fase è a due trascinamenti; e dopo una nuova simulazione <b>🔄</b> ricarica il file mantenendo tutti i grafici.',
            '把仿真结果（<b>Model_res.mat</b>、<b>dsres.mat</b>）拖到窗口上。模型层级、单位和参数都会保留；拖两下就能得到相图；重新仿真后，<b>🔄</b> 会重新加载文件并保留所有图表。',
        ),
        async setup(d) {
            await d.loadBundledResult('examples/example-data.js', 'ExampleSimplePendulum_res.mat');
        },
        async run(d) {
            await d.cam(['#files-section', '#variables-tree'], 1.4, 600);
            d.say(say(
                'A pendulum simulated in OpenModelica: <b>…_res.mat</b>',
                'Un pendule simulé dans OpenModelica : <b>…_res.mat</b>',
                'Un péndulo simulado en OpenModelica: <b>…_res.mat</b>',
                'Un pendolo simulato in OpenModelica: <b>…_res.mat</b>',
                '在 OpenModelica 中仿真的单摆：<b>…_res.mat</b>',
            ));
            await d.move({ sel: '.file-entry.active .file-entry-name' });
            await d.wait(1800);
            d.say(say(
                'Variables with their units — and the model’s parameters',
                'Les variables avec leurs unités — et les paramètres du modèle',
                'Las variables con sus unidades — y los parámetros del modelo',
                'Le variabili con le loro unità — e i parametri del modello',
                '变量及其单位——还有模型参数',
            ));
            const theta = await d.variable('theta');
            await d.move({ el: theta, ax: 0.6 });
            await d.wait(900);
            const param = await d.variable('L');
            await d.move({ el: param, ax: 0.6 });
            await d.wait(1600);

            await d.cam(null, null, 800);
            d.say(say(
                'Drag variables onto a panel',
                'Glissez des variables sur un panneau',
                'Arrastre variables a un panel',
                'Trascina le variabili su un pannello',
                '把变量拖到面板上',
            ));
            await d.plot('theta');
            await d.plot('omega');
            await d.wait(1000);

            // A second panel, for a phase plot.
            const split = d.panel(0).querySelectorAll('.layout-panel-toolbar > .layout-toolbar-btn')[1];
            d.say(say(
                '<b>▶</b> splits the panel',
                '<b>▶</b> divise le panneau',
                '<b>▶</b> divide el panel',
                '<b>▶</b> divide il pannello',
                '<b>▶</b> 拆分面板',
            ));
            await d.tap(split);
            await d.until(() => d.panels().length === 2, 3000);
            await d.wait(700);
            d.say(say(
                '<b>2D</b>: a phase plot — drop X, then Y',
                '<b>2D</b> : un plan de phase — déposez X, puis Y',
                '<b>2D</b>: un diagrama de fase — suelte X y luego Y',
                '<b>2D</b>: un diagramma di fase — rilascia X, poi Y',
                '<b>2D</b>：相图——先拖入 X，再拖入 Y',
            ));
            await d.plotType('phase2d', 1);
            await d.wait(500);
            await d.plot('theta', 1, { ax: 0.5 });
            await d.plot('omega', 1, { ax: 0.5 });
            await d.until(() => d.panel(1).querySelector('.js-plotly-plot'), 4000);
            d.say(say(
                'The spiral of a damped pendulum',
                'La spirale d’un pendule amorti',
                'La espiral de un péndulo amortiguado',
                'La spirale di un pendolo smorzato',
                '阻尼单摆的螺旋轨迹',
            ));
            await d.wait(2200);

            await d.cam({ el: d.$('.top-bar-right'), ax: 0.3 }, 1.6, 800);
            d.say(say(
                'Simulated again? <b>🔄</b> reloads the result, plots kept',
                'Nouvelle simulation ? <b>🔄</b> recharge le résultat, graphiques conservés',
                '¿Simuló de nuevo? <b>🔄</b> recarga el resultado y conserva los gráficos',
                'Nuova simulazione? <b>🔄</b> ricarica il risultato, grafici mantenuti',
                '重新仿真了？<b>🔄</b> 重新加载结果，图表保留',
            ));
            await d.move('#reload-file');
            await d.wait(2400);
        },
    },

    {
        id: 'load-as-new', g: 'tools', icon: '⧉', est: 75000,
        t: say('Modelica: compare runs of a simulation', 'Modelica : comparer des exécutions',
            'Modelica: comparar corridas de una simulación', 'Modelica: confrontare esecuzioni di una simulazione',
            'Modelica：比较多次仿真运行'),
        d: say(
            'A simulation writes its result over the previous one. The switch next to <b>🔄</b> turns Reload into <b>Reload as new</b>: the run that was loaded is kept as another version instead of being replaced. Then <b>⧉</b>, in the toolbar of the panel, draws the variables already plotted from every loaded file — one curve per run, in one plot.',
            'Une simulation écrit son résultat par-dessus le précédent. L’interrupteur à côté de <b>🔄</b> transforme Recharger en <b>Recharger comme nouvelle version</b> : l’exécution déjà chargée est conservée au lieu d’être remplacée. Ensuite <b>⧉</b>, dans la barre du panneau, trace les variables déjà affichées depuis tous les fichiers chargés — une courbe par exécution, dans un seul graphique.',
            'Una simulación escribe su resultado encima del anterior. El interruptor junto a <b>🔄</b> convierte Recargar en <b>Recargar como nueva versión</b>: la corrida ya cargada se conserva en vez de reemplazarse. Después <b>⧉</b>, en la barra del panel, dibuja las variables ya graficadas desde todos los archivos cargados — una curva por corrida, en un solo gráfico.',
            'Una simulazione scrive il suo risultato sopra il precedente. L’interruttore accanto a <b>🔄</b> trasforma Ricarica in <b>Ricarica come nuova versione</b>: l’esecuzione già caricata viene conservata invece di essere sostituita. Poi <b>⧉</b>, nella barra del pannello, traccia le variabili già mostrate da tutti i file caricati — una curva per esecuzione, in un solo grafico.',
            '仿真会把结果覆盖在上一次之上。<b>🔄</b> 旁边的开关把“重新加载”变成<b>作为新版本重新加载</b>：已加载的那次运行会被保留，而不是被替换。然后用面板工具栏里的 <b>⧉</b>，把已绘制的变量从所有已加载文件中一并画出——每次运行一条曲线，同在一张图上。',
        ),
        async setup(d) {
            // Three runs of ExampleSimplePendulum with more and more damping,
            // computed here and written as OpenModelica result files
            // (guide-om-result.js): nothing is downloaded.
            d.runs = PENDULUM_RUNS.map((b) => pendulumResultMat({ b }));
            d.om();
        },
        async run(d) {
            const om = d.om();
            const file = 'ExampleSimplePendulum_res.mat';
            const compareButton = () => d.panel(0).querySelector('.compare-files-btn');

            // ── The first run, in the simulation tool ──
            om.show();
            await d.wait(700);
            d.say(say(
                'A model in OpenModelica — <b>Simulate</b>',
                'Un modèle dans OpenModelica — <b>Simulate</b>',
                'Un modelo en OpenModelica — <b>Simulate</b>',
                'Un modello in OpenModelica — <b>Simulate</b>',
                'OpenModelica 中的一个模型——<b>Simulate</b>',
            ));
            await d.cam(om.el.simulate, 2.2, 700);
            await d.tap(om.el.simulate, { after: 400 });

            d.say(say(
                'It is translated to C, compiled, and then run',
                'Il est traduit en C, compilé, puis exécuté',
                'Se traduce a C, se compila y luego se ejecuta',
                'Viene tradotto in C, compilato e poi eseguito',
                '先翻译成 C、编译，然后运行',
            ));
            await d.cam(om.el.messages, 1.5, 600);
            om.tab('Compilation');
            om.progress(8, 'Compiling ExampleSimplePendulum. Please wait for a while.');
            for (const [i, line] of om.COMPILE_LINES.entries()) {
                om.line(line);
                om.progress(Math.min(70, 8 + i * 8), 'Compiling ExampleSimplePendulum. Please wait for a while.');
                await d.wait(290);
            }
            om.tab('Output');
            om.progress(86, 'Running simulation of ExampleSimplePendulum. Please wait for a while.');
            for (const line of om.OUTPUT_LINES) {
                om.line(line);
                await d.wait(320);
            }
            om.progress(100, 'Simulation of ExampleSimplePendulum finished.');
            await d.wait(550);

            om.perspective('plotting');
            om.curve(0.1);
            d.say(say(
                'The result is a file: <b>ExampleSimplePendulum_res.mat</b>',
                'Le résultat est un fichier : <b>ExampleSimplePendulum_res.mat</b>',
                'El resultado es un archivo: <b>ExampleSimplePendulum_res.mat</b>',
                'Il risultato è un file: <b>ExampleSimplePendulum_res.mat</b>',
                '结果就是一个文件：<b>ExampleSimplePendulum_res.mat</b>',
            ));
            await d.cam(om.el.variables, 1.5, 700);
            await d.wait(1100);

            // ── That file, here ──
            await d.cam(null, null, 500);
            om.hide();
            await d.wait(600);
            d.say(say(
                'Open that file here',
                'Ouvrez ce fichier ici',
                'Abra ese archivo aquí',
                'Apri quel file qui',
                '在这里打开那个文件',
            ));
            const picker = d.fileDialog();
            const openButton = d.$('#file-select-btn') || d.$('#load-new-file');
            await d.cam(openButton, 2.4, 600);
            await d.tap(openButton, { after: 350 });
            await d.cam(null, null, 300);
            picker.show();
            await d.wait(700);
            d.say(say(
                'The result of the run, among what the build left',
                'Le résultat de l’exécution, parmi ce qu’a laissé la compilation',
                'El resultado de la corrida, entre lo que dejó la compilación',
                'Il risultato dell’esecuzione, tra ciò che ha lasciato la compilazione',
                '这次运行的结果，就在编译留下的文件里',
            ));
            await d.tap(picker.row(file), { after: 250 });
            picker.select(file);
            await d.wait(550);
            await d.tap(picker.el.open, { after: 250 });
            picker.hide();
            await d.wait(400);
            await d.loadFile(file, d.runs[0]);
            await d.plot('theta');
            await d.until(() => d.panel(0).querySelector('.js-plotly-plot'), 8000);
            await d.wait(900);

            // ── Another run: a parameter changed, no compiling ──
            // The third run is the second one again, so it is played faster:
            // by then the viewer knows where this is going.
            for (const round of [1, 2]) {
                const damping = PENDULUM_RUNS[round];
                const pace = round === 1 ? 1 : 0.7;
                const w = (ms) => d.wait(Math.round(ms * pace));
                om.show();
                om.perspective('plotting');
                await w(600);
                d.say(round === 1 ? say(
                    'Back in OpenModelica: change a parameter',
                    'De retour dans OpenModelica : changez un paramètre',
                    'De vuelta en OpenModelica: cambie un parámetro',
                    'Di nuovo in OpenModelica: cambia un parametro',
                    '回到 OpenModelica：改一个参数',
                ) : say(
                    'A third run, with more damping again',
                    'Une troisième exécution, encore plus amortie',
                    'Una tercera corrida, con más amortiguación',
                    'Una terza esecuzione, ancora più smorzata',
                    '第三次运行，阻尼再大一些',
                ));
                await d.cam(om.el.damping, 3, Math.round(700 * pace));
                await d.move(om.el.damping);
                om.value('b', '', true);
                for (const text of [String(damping)[0], String(damping).slice(0, 2), String(damping)]) {
                    om.value('b', text, true);
                    await w(230);
                }
                await w(400);
                om.value('b', String(damping), false);

                d.say(say(
                    'Right button on the result: <b>Re-simulate</b>',
                    'Bouton droit sur le résultat : <b>Re-simulate</b>',
                    'Botón derecho sobre el resultado: <b>Re-simulate</b>',
                    'Tasto destro sul risultato: <b>Re-simulate</b>',
                    '在结果上点右键：<b>Re-simulate</b>',
                ));
                await d.cam(om.el.variables, 1.5, Math.round(600 * pace));
                await d.move(om.el.resultRoot);
                om.menu(true);
                await w(650);
                await d.tap(om.el.resimulateItem, { after: Math.round(250 * pace) });
                om.menu(false);

                d.say(say(
                    'Only the run is repeated — nothing is compiled again',
                    'Seule l’exécution est refaite — rien n’est recompilé',
                    'Sólo se repite la ejecución — no se compila de nuevo',
                    'Viene ripetuta solo l’esecuzione — non si ricompila',
                    '只重复运行——不再编译',
                ));
                await d.cam(om.el.messages, 1.5, Math.round(600 * pace));
                om.tab('Output');
                om.progress(45, 'Running simulation of ExampleSimplePendulum. Please wait for a while.');
                for (const line of om.OUTPUT_LINES) {
                    om.line(line);
                    await w(300);
                }
                om.progress(100, 'Simulation of ExampleSimplePendulum finished.');
                om.curve(damping);
                await w(450);
                await d.cam(om.el.plot, 1.2, Math.round(600 * pace));
                await w(900);

                // ── Reload as new: the previous run is kept ──
                await d.cam(null, null, 450);
                om.hide();
                // The file on disk is the one the new run has just written.
                d.restage(d.runs[round], file);
                await w(500);
                if (round === 1) {
                    d.say(say(
                        'The file was overwritten. The switch: <b>AS NEW</b>',
                        'Le fichier a été écrasé. L’interrupteur : <b>AS NEW</b>',
                        'El archivo se sobrescribió. El interruptor: <b>AS NEW</b>',
                        'Il file è stato sovrascritto. L’interruttore: <b>AS NEW</b>',
                        '文件被覆盖了。这个开关：<b>AS NEW</b>',
                    ));
                    await d.cam('.reload-file-split', 2.6, 700);
                    await d.tap('#reload-as-version-toggle', { after: 350 });
                    await d.until(() => d.app.reloadAsNewVersionMode, 2000);
                    await d.wait(500);
                } else {
                    await d.cam('.reload-file-split', 2.6, 500);
                }
                d.say(say(
                    '<b>🔄</b> keeps the run that was loaded, and adds the new one',
                    '<b>🔄</b> conserve l’exécution chargée et ajoute la nouvelle',
                    '<b>🔄</b> conserva la corrida cargada y agrega la nueva',
                    '<b>🔄</b> conserva l’esecuzione caricata e aggiunge la nuova',
                    '<b>🔄</b> 保留已加载的那次运行，并加入新的一次',
                ));
                await d.tap('#reload-file', { after: 150 });
                // Out of the zoom on the button at once: what answers is a
                // dialog in the middle of the window, not the button.
                await d.cam(null, null, 250);
                await d.modalOk({ read: Math.round(1600 * pace), after: 450 });
                await d.cam('#files-section', 1.5, 600);
                await w(800);

                // ── One plot, one curve per run ──
                d.say(say(
                    '<b>⧉</b> draws what is plotted, from every file',
                    '<b>⧉</b> trace ce qui est affiché, depuis tous les fichiers',
                    '<b>⧉</b> dibuja lo que está graficado, desde todos los archivos',
                    '<b>⧉</b> traccia ciò che è mostrato, da tutti i file',
                    '<b>⧉</b> 把已绘制的内容从所有文件中一并画出',
                ));
                await d.cam(compareButton(), 2.4, Math.round(700 * pace));
                await d.tap(compareButton(), { after: 150 });
                await d.cam(null, null, 250);
                await d.modalOk({ read: Math.round(1300 * pace), after: 450 });
                await d.cam(null, null, 600);
                await w(1300);
            }

            d.say(say(
                'Three runs of one model, one plot',
                'Trois exécutions d’un modèle, un seul graphique',
                'Tres corridas de un modelo, un solo gráfico',
                'Tre esecuzioni di un modello, un solo grafico',
                '同一模型的三次运行，一张图',
            ));
            await d.wait(1800);
        },
    },

    {
        id: 'pypsa', g: 'tools', icon: '⚡', est: 38000,
        t: say('With PyPSA', 'Avec PyPSA', 'Con PyPSA', 'Con PyPSA', '配合 PyPSA'),
        d: say(
            'Save a network with <b>n.export_to_netcdf("network.nc")</b> and drop the file on the window. Every component — buses, generators, lines, loads, storage — is a folder with its time series and its static attributes, ready to plot without writing a line of matplotlib.',
            'Enregistrez un réseau avec <b>n.export_to_netcdf("network.nc")</b> et déposez le fichier sur la fenêtre. Chaque composant — nœuds, générateurs, lignes, charges, stockage — est un dossier avec ses séries temporelles et ses attributs statiques, prêt à tracer sans une ligne de matplotlib.',
            'Guarde una red con <b>n.export_to_netcdf("network.nc")</b> y suelte el archivo sobre la ventana. Cada componente — nodos, generadores, líneas, cargas, almacenamiento — es una carpeta con sus series temporales y sus atributos estáticos, lista para graficar sin escribir una línea de matplotlib.',
            'Salva una rete con <b>n.export_to_netcdf("network.nc")</b> e rilascia il file sulla finestra. Ogni componente — nodi, generatori, linee, carichi, accumulo — è una cartella con le sue serie temporali e i suoi attributi statici, pronta da tracciare senza una riga di matplotlib.',
            '用 <b>n.export_to_netcdf("network.nc")</b> 保存网络，然后把文件拖到窗口上。每个组件——节点、发电机、线路、负荷、储能——都是一个文件夹，包含其时间序列和静态属性，无需写一行 matplotlib 即可绘图。',
        ),
        async setup(d) {
            await d.loadPublic('examples/guide/island_grid.nc');
        },
        async run(d) {
            await d.cam(['#files-section', '#variables-tree'], 1.4, 600);
            d.say(say(
                'A network saved with <b>n.export_to_netcdf()</b>',
                'Un réseau enregistré avec <b>n.export_to_netcdf()</b>',
                'Una red guardada con <b>n.export_to_netcdf()</b>',
                'Una rete salvata con <b>n.export_to_netcdf()</b>',
                '用 <b>n.export_to_netcdf()</b> 保存的网络',
            ));
            await d.move({ sel: '.file-entry.active .file-entry-name' });
            await d.wait(1900);
            d.say(say(
                'One folder per component',
                'Un dossier par composant',
                'Una carpeta por componente',
                'Una cartella per componente',
                '每个组件一个文件夹',
            ));
            await d.folder('Generators');
            await d.wait(600);
            await d.folder('Solar farm');
            await d.wait(500);
            d.say(say(
                'Its time series, and its <b>static attributes</b>',
                'Ses séries temporelles, et ses <b>attributs statiques</b>',
                'Sus series temporales y sus <b>atributos estáticos</b>',
                'Le sue serie temporali e i suoi <b>attributi statici</b>',
                '它的时间序列，以及<b>静态属性</b>',
            ));
            await d.folder('Static attributes');
            await d.wait(1900);
            await d.folder('Static attributes');

            await d.cam(null, null, 800);
            d.say(say(
                'Dispatch of the week: drag <b>p</b> of each generator',
                'Production de la semaine : glissez <b>p</b> de chaque générateur',
                'Despacho de la semana: arrastre <b>p</b> de cada generador',
                'Dispacciamento della settimana: trascina <b>p</b> di ogni generatore',
                '一周的出力：把每台发电机的 <b>p</b> 拖进来',
            ));
            await d.plot('pypsa:generators/Solar%20farm/p', 0, { label: 'Solar farm · p' });
            await d.folder('Solar farm');
            await d.folder('Wind park');
            await d.plot('pypsa:generators/Wind%20park/p', 0, { label: 'Wind park · p' });
            await d.folder('Wind park');
            await d.folder('Diesel plant');
            await d.plot('pypsa:generators/Diesel%20plant/p', 0, { label: 'Diesel plant · p' });
            await d.folder('Diesel plant');
            await d.wait(900);

            const view = d.panel(0).querySelector('.panel-view-btn');
            d.say(say(
                '<b>View ▾ → Stack</b>: who covers the demand, hour by hour',
                '<b>Vue ▾ → Empiler</b> : qui couvre la demande, heure par heure',
                '<b>Vista ▾ → Apilar</b>: quién cubre la demanda, hora por hora',
                '<b>Vista ▾ → Impila</b>: chi copre la domanda, ora per ora',
                '<b>视图 ▾ → 堆叠</b>：逐小时看谁在满足负荷',
            ));
            await d.tap(view);
            await d.until(() => d.$('.timeseries-marks-menu .marks-menu-item[data-mark="stack"]'), 2000);
            await d.wait(500);
            await d.tap('.timeseries-marks-menu .marks-menu-item[data-mark="stack"]');
            await d.wait(400);
            if (d.$('.timeseries-marks-menu')) await d.tap(view);
            await d.wait(2200);

            // The battery, on a panel of its own.
            const split = d.panel(0).querySelectorAll('.layout-panel-toolbar > .layout-toolbar-btn')[2];
            d.say(say(
                'And the battery below: <b>state_of_charge</b>',
                'Et la batterie en dessous : <b>state_of_charge</b>',
                'Y la batería debajo: <b>state_of_charge</b>',
                'E la batteria sotto: <b>state_of_charge</b>',
                '下方是电池：<b>state_of_charge</b>',
            ));
            await d.tap(split);
            await d.until(() => d.panels().length === 2, 3000);
            await d.folder('Generators');
            await d.folder('Storage Units');
            await d.folder('Battery');
            await d.plot('pypsa:storage_units/Battery/state_of_charge', 1, { label: 'Battery · state_of_charge' });
            await d.wait(2200);
        },
    },

    {
        id: 'era5-maps', g: 'tools', icon: '⊞', est: 72000,
        t: say('With ERA5 and other grids', 'Avec ERA5 et autres grilles', 'Con ERA5 y otras grillas', 'Con ERA5 e altre griglie', '配合 ERA5 等网格数据'),
        d: say(
            'A netCDF of a model or a reanalysis — ERA5 from the Copernicus CDS, WRF, a CMIP run — opens on a <b>map</b>, not as ten thousand loose series. Choose the variable, play the time, and take the series of a point, or the average of a box, into the plots where the FFT, the fits and the cursors are.',
            'Un netCDF de modèle ou de réanalyse — ERA5 du CDS Copernicus, WRF, une simulation CMIP — s’ouvre sur une <b>carte</b>, et non en dix mille séries éparses. Choisissez la variable, lancez le temps, puis emportez la série d’un point, ou la moyenne d’une zone, vers les graphiques où sont la FFT, les ajustements et les curseurs.',
            'Un netCDF de un modelo o de un reanálisis — ERA5 del CDS de Copernicus, WRF, una corrida CMIP — abre en un <b>mapa</b>, no en diez mil series sueltas. Elija la variable, reproduzca el tiempo y lleve la serie de un punto, o el promedio de una zona, a los gráficos donde están la FFT, los ajustes y los cursores.',
            'Un netCDF di un modello o di una rianalisi — ERA5 dal CDS di Copernicus, WRF, una corsa CMIP — si apre su una <b>mappa</b>, non in diecimila serie sparse. Scegli la variabile, avvia il tempo e porta la serie di un punto, o la media di un’area, nei grafici dove stanno FFT, fit e cursori.',
            '模式或再分析的 netCDF——Copernicus CDS 的 ERA5、WRF、CMIP 试验——会打开为一张<b>地图</b>，而不是上万条零散序列。选择变量、播放时间，再把某一点的序列或某片区域的平均值送进图表，那里有 FFT、拟合和游标。',
        ),
        async setup(d) {
            await d.loadPublic('examples/guide/era5_argentina.nc');
            await d.until(() => d.$('#gridded-view:not([hidden]) .gridded-map .main-svg'), 20000);
        },
        async run(d) {
            const map = () => d.$('#gridded-view .gridded-map');
            // The map view names an extraction's series in the order they are
            // made, so the first point's series is this one.
            const POINT_SERIES = 'grid:x1';
            // The place of an extraction is written in coordinates, which no
            // language translates: the way to find its row, and its folder,
            // without naming them.
            const placeRow = () => d.$$('#variables-tree .tree-item')
                .find((e) => /34\.5°S 58\.5°W/.test(e.textContent));
            const seriesRow = () => d.$$('#variables-tree .tree-item')
                .find((e) => e.dataset.varName === POINT_SERIES);
            // A row of a closed folder is in the tree but not on screen, and a
            // drag has to start where the pointer can be seen: open the folder
            // this row sits in (its node's parent node is that folder).
            const onScreen = (row) => !!row?.getClientRects().length;
            const openFolderOf = async (row) => {
                const folder = row?.closest('.tree-node')?.parentElement?.closest('.tree-node');
                const head = folder?.querySelector('.tree-item');
                if (head) await d.tap({ el: head.querySelector('.tree-label') || head });
            };

            await d.cam(['#files-section'], 1.4, 600);
            d.say(say(
                'ERA5 over Argentina, as the Copernicus CDS writes it',
                'ERA5 sur l’Argentine, tel que l’écrit le CDS Copernicus',
                'ERA5 sobre Argentina, tal como lo escribe el CDS de Copernicus',
                'ERA5 sull’Argentina, come lo scrive il CDS di Copernicus',
                '阿根廷上空的 ERA5，正是 Copernicus CDS 写出的样子',
            ));
            await d.move({ sel: '.file-entry.active .file-entry-name' });
            await d.wait(1600);

            await d.cam(null, null, 700);
            d.say(say(
                'It opens on a map: no series to pick first',
                'Il s’ouvre sur une carte : aucune série à choisir d’abord',
                'Abre en un mapa: no hay que elegir series primero',
                'Si apre su una mappa: nessuna serie da scegliere prima',
                '它直接打开为地图：无需先挑选序列',
            ));
            await d.wait(1500);

            d.say(say(
                'Every variable of the file, at the top of the panel',
                'Toutes les variables du fichier, en haut du panneau',
                'Todas las variables del archivo, arriba del panel',
                'Tutte le variabili del file, in cima al pannello',
                '文件里的每个变量，都在面板顶部',
            ));
            await d.choose('#gridded-view [data-role="variable"]', '/t2m');
            await d.wait(700);

            // ── The week, played and then scrubbed by hand ──
            d.say(say(
                'A week of maps, eight a day: <b>▶</b>',
                'Une semaine de cartes, huit par jour : <b>▶</b>',
                'Una semana de mapas, ocho por día: <b>▶</b>',
                'Una settimana di mappe, otto al giorno: <b>▶</b>',
                '一周的地图，每天八张：<b>▶</b>',
            ));
            await d.choose('#gridded-view [data-role="speed"]', '8');
            await d.tap('#gridded-view [data-step="play"]');
            await d.wait(3000);
            d.say(say(
                'On the 2nd the cold air climbs from Patagonia',
                'Le 2, l’air froid remonte de Patagonie',
                'El día 2 el aire frío sube desde la Patagonia',
                'Il giorno 2 l’aria fredda risale dalla Patagonia',
                '2 日，冷空气自巴塔哥尼亚北上',
            ));
            await d.wait(5000);
            if (d.$('#gridded-view [data-step="play"]')?.dataset.icon === 'pause') {
                await d.tap('#gridded-view [data-step="play"]');
            }
            d.say(say(
                'Or slide the time by hand',
                'Ou faites glisser le temps à la main',
                'O deslice el tiempo a mano',
                'Oppure scorri il tempo a mano',
                '也可以手动拖动时间',
            ));
            await d.slide('#gridded-view [data-role="time"]', 12, { ms: 1500 });
            await d.wait(900);

            // ── A point ──
            d.say(say(
                'The <b>Point</b> tool reads one cell: here, Buenos Aires',
                'L’outil <b>Point</b> lit une maille : ici, Buenos Aires',
                'La herramienta <b>Punto</b> lee una celda: acá, Buenos Aires',
                'Lo strumento <b>Punto</b> legge una cella: qui, Buenos Aires',
                '<b>点</b>工具读取一个网格单元：这里是布宜诺斯艾利斯',
            ));
            await d.tap('#gridded-view [data-mode="point"]');
            await d.wait(400);
            await d.tap(mapPoint(map(), -58.5, -34.5));
            await d.wait(1600);

            d.say(say(
                'Extract it: every step of that cell becomes a series',
                'Extrayez-la : chaque pas de cette maille devient une série',
                'Extraerla: cada paso de esa celda se vuelve una serie',
                'Estraila: ogni passo di quella cella diventa una serie',
                '提取之后，该单元的每个时次就构成一条序列',
            ));
            await d.tap('#gridded-view [data-action="extract-point"]');
            // `until` only reports, so the demo says out loud what it could not
            // do: e2e:guide fails on a throw, not on a caption that lies.
            const extracted = await d.until(() => /34\.5°S 58\.5°W/.test(
                d.$('#gridded-view [data-role="results-body"]')?.textContent || ''), 15000);
            if (!extracted) throw new Error('guide: the point over Buenos Aires was not extracted');

            // ── Its curve, without leaving the map ──
            const preview = await d.until(() => !d.$('#gridded-view [data-role="preview"]')?.hidden, 10000);
            if (!preview) throw new Error('guide: the preview of the extracted series did not open');
            d.say(say(
                'Its curve is right there, under the map',
                'Sa courbe est là, sous la carte',
                'Su curva queda ahí, bajo el mapa',
                'La sua curva è lì, sotto la mappa',
                '它的曲线就在地图下方',
            ));
            await d.move({ sel: '#gridded-view [data-role="preview-chart"]', ax: 0.45 });
            await d.wait(2000);

            // Hiding it gives the map its height back — which is what the box
            // about to be drawn needs.
            const toggle = '#gridded-view .gridded-panel [data-action="toggle-results"]';
            d.say(say(
                '<b>Hide</b> gives the map its height back',
                '<b>Masquer</b> rend à la carte sa hauteur',
                '<b>Ocultar</b> le devuelve al mapa su altura',
                '<b>Nascondi</b> restituisce alla mappa la sua altezza',
                '<b>隐藏</b>后地图恢复原来的高度',
            ));
            await d.tap(toggle);
            await d.wait(1100);

            // ── A box ──
            d.say(say(
                'The <b>Region</b> tool: a box over the Pampa',
                'L’outil <b>Zone</b> : un rectangle sur la Pampa',
                'La herramienta <b>Región</b>: un rectángulo sobre la Pampa',
                'Lo strumento <b>Regione</b>: un rettangolo sulla Pampa',
                '<b>区域</b>工具：在潘帕草原上框一个矩形',
            ));
            await d.tap('#gridded-view [data-mode="region"]');
            await d.wait(400);
            await d.drag(mapPoint(map(), -66, -31), mapPoint(map(), -58, -38), { ms: 1300 });
            await d.wait(700);
            d.say(say(
                'Its mean, minimum and maximum, weighted by cos(latitude)',
                'Sa moyenne, son minimum et son maximum, pondérés par cos(latitude)',
                'Su media, su mínimo y su máximo, ponderados por cos(latitud)',
                'La sua media, il minimo e il massimo, pesati per cos(latitudine)',
                '它的平均、最小与最大值，按 cos(纬度) 加权',
            ));
            await d.tap('#gridded-view [data-action="extract-region"]');
            const region = await d.until(() => d.$$('#gridded-view .gridded-result').length >= 2, 30000);
            if (!region) throw new Error('guide: the region was not extracted');
            await d.wait(1200);

            d.say(say(
                '<b>Show</b>: the point and the box, still on the map',
                '<b>Afficher</b> : le point et la zone, toujours sur la carte',
                '<b>Mostrar</b>: el punto y la caja, sin salir del mapa',
                '<b>Mostra</b>: il punto e l’area, sempre sulla mappa',
                '<b>显示</b>：点与区域，仍在地图上',
            ));
            await d.tap(toggle);
            await d.wait(2600);

            // ── Both of them in the tree ──
            d.say(say(
                'Both are in the tree, under <b>Extractions</b>',
                'Les deux sont dans l’arbre, sous <b>Extractions</b>',
                'Las dos están en el árbol, bajo <b>Extracciones</b>',
                'Entrambe sono nell’albero, sotto <b>Estrazioni</b>',
                '两者都在左侧的树里，位于<b>提取</b>之下',
            ));
            await d.cam(['#files-section', '#variables-tree'], 1.35, 700);
            if (!onScreen(placeRow())) await openFolderOf(placeRow());
            if (!onScreen(placeRow())) throw new Error('guide: the extractions are not in the tree');
            await d.move({ el: placeRow() });
            await d.wait(1800);

            d.say(say(
                'Each place is a folder: open it for its series',
                'Chaque lieu est un dossier : ouvrez-le pour ses séries',
                'Cada lugar es una carpeta: ábrala para ver sus series',
                'Ogni luogo è una cartella: aprila per le sue serie',
                '每个地点都是一个文件夹：打开它就能看到序列',
            ));
            if (!onScreen(seriesRow())) await openFolderOf(seriesRow());
            if (!onScreen(seriesRow())) throw new Error('guide: the extracted series is not on screen');
            await d.move({ el: seriesRow() });
            await d.wait(2000);
            await d.cam(null, null, 700);

            // ── Out of the map, into the plots ──
            d.say(say(
                '<b>Close map</b>: the file stays, and so do they',
                '<b>Fermer la carte</b> : le fichier reste, elles aussi',
                '<b>Cerrar mapa</b>: el archivo queda, y ellas también',
                '<b>Chiudi mappa</b>: il file resta, e anche loro',
                '<b>关闭地图</b>：文件还在，它们也在',
            ));
            await d.tap('#gridded-view [data-action="close"]');
            const closed = await d.until(() => d.$('#gridded-view')?.hidden, 10000);
            if (!closed) throw new Error('guide: the map did not close');
            await d.wait(900);

            d.say(say(
                'Drag one onto a panel, like any other series',
                'Glissez-en une sur un panneau, comme toute autre série',
                'Arrastre una a un panel, como cualquier otra serie',
                'Trascinane una su un pannello, come ogni altra serie',
                '把其中一条拖到面板上，和普通序列一样',
            ));
            // Closing the map redraws the tree, so the folder may be shut again.
            if (!onScreen(seriesRow())) await openFolderOf(seriesRow());
            if (!onScreen(seriesRow())) throw new Error('guide: nothing visible to drag onto the panel');
            await d.plot(POINT_SERIES, 0, { label: 'P1 · t2m' });
            const drawn = await d.until(() => d.$('.layout-panel .js-plotly-plot'), 20000);
            if (!drawn) throw new Error('guide: the extracted series did not reach the plots');
            await d.wait(1600);

            // ── And an analysis on it ──
            d.say(say(
                'And a <b>temporal profile</b> over it',
                'Et un <b>profil temporel</b> dessus',
                'Y encima un <b>perfil temporal</b>',
                'E sopra un <b>profilo temporale</b>',
                '再对它做一个<b>时间廓线</b>',
            ));
            await d.analysis('temporal-profile', 0);
            await d.wait(2600);
            d.say(say(
                'Seven days folded into one: the daily cycle',
                'Sept jours repliés en un seul : le cycle diurne',
                'Siete días plegados en uno: el ciclo diario',
                'Sette giorni ripiegati in uno: il ciclo diurno',
                '七天叠成一天：日变化',
            ));
            await d.wait(2800);
        },
    },

    {
        id: 'live-update', g: 'tools', icon: '⏺', est: 41000,
        t: say('Live Update: a file still being written', 'Live Update : un fichier encore en cours d’écriture', 'Live Update: un archivo que aún se está escribiendo', 'Live Update: un file ancora in scrittura', '实时更新：仍在写入的文件'),
        d: say(
            'A data logger keeps adding rows to its CSV while you look at it. In the <b>Full Desktop</b> edition, <b>Live Update</b> follows the file: every few seconds it reads only the rows that were added and extends every plot of it — time series and dashboards together — without reloading. Here a stand-in logger writes the file; what follows it is the app’s own Live Update.',
            'Un enregistreur ajoute des lignes à son CSV pendant que vous le regardez. Dans l’édition <b>Full Desktop</b>, <b>Live Update</b> suit le fichier : toutes les quelques secondes il ne lit que les lignes ajoutées et prolonge tous ses graphiques — séries temporelles et tableaux de bord ensemble — sans recharger. Ici un enregistreur factice écrit le fichier ; ce qui le suit est le vrai Live Update de l’application.',
            'Un registrador sigue agregando filas a su CSV mientras usted lo mira. En la edición <b>Full Desktop</b>, <b>Live Update</b> sigue el archivo: cada pocos segundos lee solo las filas agregadas y prolonga todos sus gráficos — series temporales y dashboards a la vez — sin recargar. Aquí un registrador simulado escribe el archivo; lo que lo sigue es el Live Update real de la app.',
            'Un data logger continua ad aggiungere righe al suo CSV mentre lo guardi. Nell’edizione <b>Full Desktop</b>, <b>Live Update</b> segue il file: ogni pochi secondi legge solo le righe aggiunte e prolunga tutti i suoi grafici — serie temporali e dashboard insieme — senza ricaricare. Qui un logger simulato scrive il file; a seguirlo è il vero Live Update dell’app.',
            '数据记录仪在你查看 CSV 的同时仍在往里追加数据行。在<b>完整桌面版（Full Desktop）</b>中，<b>实时更新</b>会跟随该文件：每隔几秒只读取新增的行，并延长它的所有图表——时间序列和仪表板一起更新——无需重新加载。这里由一个模拟记录仪写文件；跟随它的则是应用真正的实时更新功能。',
        ),
        async setup(d) {
            // The logger and its file (guide-live-logger.js): a stand-in, like
            // the simulation tool of "Load as new". The file is what it has
            // written so far, and the app is given the path it would have on a
            // disk — which is what the desktop edition knows of a file it opens.
            const logger = d.liveLogger({ title: 'DATA LOGGER · LINE 3', name: 'line_3.csv', path: 'D:\\logs\\line_3.csv', channels: LINE_CHANNELS });
            d.line = { row: processLine(), eventAt: Infinity, on: false };
            logger.header(LINE_HEADER);
            logger.write(Array.from({ length: 60 }, (_, i) => d.line.row(i)));
            await d.loadFile(logger.name, logger.bytes(), { localPath: logger.path });
        },
        async run(d) {
            const logger = d.liveLogger();
            const line = d.line;
            const app = d.app;
            const fileId = app.activeFileId;
            const loaded = () => app._liveUpdateRowCount(fileId);
            const NAMES = LINE_CHANNELS.map((ch) => ch.name);

            // The logger writes four rows a second from now to the end of the
            // demo, whatever the app is doing — on the demo's clock, so Pause
            // stops it as it stops everything else.
            line.on = true;
            logger.recording(true);
            (async () => {
                while (line.on) {
                    logger.write([line.row(logger.rows(), line.eventAt)]);
                    await d.wait(250);
                }
            })().catch(() => { /* the demo was closed */ });

            logger.show();
            await d.cam(logger.el.panel, 1.7, 700);
            d.say(say(
                'A logger on a process line is still writing <b>line_3.csv</b>',
                'Un enregistreur sur une ligne de procédé écrit encore <b>line_3.csv</b>',
                'Un registrador en una línea de proceso sigue escribiendo <b>line_3.csv</b>',
                'Un logger su una linea di processo sta ancora scrivendo <b>line_3.csv</b>',
                '生产线上的记录仪仍在写入 <b>line_3.csv</b>',
            ));
            await d.wait(2600);

            // ── The file as it was when it was opened ──
            await d.cam(null, null, 700);
            d.say(say(
                'The file, as it was when it was opened: three channels',
                'Le fichier, tel qu’il était à l’ouverture : trois voies',
                'El archivo, tal como estaba al abrirlo: tres canales',
                'Il file, com’era all’apertura: tre canali',
                '文件打开时的样子：三个通道',
            ));
            await d.select(NAMES);
            await d.plot(NAMES[0], 0, { label: NAMES.join(', ') });
            await d.until(() => d.panel(0).querySelector('.js-plotly-plot')?._fullLayout, 6000);
            await d.wait(700);

            const split = d.panel(0).querySelectorAll('.layout-panel-toolbar > .layout-toolbar-btn')[1];
            d.say(say(
                'A second panel, as a <b>Dashboard</b>: a card per channel',
                'Un second panneau, en <b>Tableau de bord</b> : une carte par voie',
                'Un segundo panel, como <b>Dashboard</b>: una tarjeta por canal',
                'Un secondo pannello, come <b>Dashboard</b>: una scheda per canale',
                '第二个面板设为<b>仪表板</b>：每个通道一张卡片',
            ));
            await d.tap(split);
            await d.until(() => d.panels().length === 2, 3000);
            await d.plotType('dashboard', 1);
            await d.plot(NAMES[0], 1, { ax: 0.5, label: NAMES.join(', ') });
            if (!await d.until(() => d.panel(1).querySelectorAll('.dashboard-card').length >= NAMES.length, 6000)) {
                throw new Error('guide: the dashboard has no cards');
            }
            await d.wait(900);

            // ── Live Update ──
            const button = d.$('#live-update-file');
            await d.cam(d.$('.live-update-topbar-wrap') || button, 2.4, 700);
            d.say(say(
                '<b>Live Update</b> — in the <b>Full Desktop</b> edition',
                '<b>Live Update</b> — dans l’édition <b>Full Desktop</b>',
                '<b>Live Update</b> — en la edición <b>Full Desktop</b>',
                '<b>Live Update</b> — nell’edizione <b>Full Desktop</b>',
                '<b>实时更新</b>——<b>完整桌面版（Full Desktop）</b>的功能',
            ));
            await d.wait(900);
            const before = loaded();
            // What the logger writes two and a half seconds from now on is the event.
            line.eventAt = logger.rows() + 22;
            await d.tap(button, { after: 300 });
            if (!await d.until(() => app.files.get(fileId)?.liveUpdate?.enabled, 5000)) throw new Error('guide: Live Update did not start');
            await d.cam(null, null, 700);
            d.say(say(
                'The rows written since the file was opened arrive first',
                'Les lignes écrites depuis l’ouverture arrivent d’abord',
                'Primero llegan las filas escritas desde que se abrió',
                'Per prime arrivano le righe scritte dopo l’apertura',
                '打开文件之后写入的行先到',
            ));
            if (!await d.until(() => loaded() > before, 8000)) throw new Error('guide: Live Update read no new rows');
            await d.wait(2600);
            d.say(say(
                'Then every two seconds: the curves grow, the cards follow',
                'Puis toutes les deux secondes : les courbes s’allongent, les cartes suivent',
                'Luego cada dos segundos: las curvas crecen, las tarjetas las siguen',
                'Poi ogni due secondi: le curve crescono, le schede seguono',
                '之后每两秒一次：曲线延长，卡片随之更新',
            ));
            await d.wait(3200);
            d.say(say(
                'The pressure falls away — seen as the logger writes it',
                'La pression chute — vue au moment où l’enregistreur l’écrit',
                'La presión cae — vista mientras el registrador la escribe',
                'La pressione crolla — vista mentre il logger la scrive',
                '压力骤降——记录仪一写入就能看到',
            ));
            await d.move({ el: d.panel(1).querySelector('.dashboard-card'), ax: 0.5, ay: 0.6 });
            await d.wait(5200);
            // The event has been written: wait for the poll that brings it.
            if (!await d.until(() => loaded() >= line.eventAt + 16, 12000)) throw new Error('guide: the event did not arrive');
            await d.wait(1200);

            // ── And off ──
            await d.cam(d.$('.live-update-topbar-wrap') || button, 2.4, 700);
            d.say(say(
                'The same button pauses it: the plots keep what has arrived',
                'Le même bouton le met en pause : les graphiques gardent ce qui est arrivé',
                'El mismo botón lo pausa: los gráficos conservan lo que llegó',
                'Lo stesso pulsante lo mette in pausa: i grafici tengono ciò che è arrivato',
                '同一个按钮可暂停：图表保留已到达的数据',
            ));
            await d.tap(button, { after: 300 });
            if (!await d.until(() => !app.files.get(fileId)?.liveUpdate?.enabled, 4000)) throw new Error('guide: Live Update did not pause');
            await d.cam(null, null, 700);
            await d.wait(1600);
            line.on = false;
        },
    },
];
