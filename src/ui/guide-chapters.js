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

const say = (en, fr, es, it, zh) => ({ en, fr, es, it, zh });

export const GUIDE_GROUPS = {
    import: say('Import', 'Importer', 'Importar', 'Importare', '导入'),
    plots: say('Plots', 'Graphiques', 'Gráficos', 'Grafici', '图表'),
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

/** A point of a plot's drawing area, as fractions of it (0,0 = top left). */
function plotArea(gd, fx, fy) {
    const r = gd.getBoundingClientRect();
    const xa = gd._fullLayout.xaxis;
    const ya = gd._fullLayout.yaxis;
    return [r.left + xa._offset + xa._length * fx, r.top + ya._offset + ya._length * fy];
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
];
