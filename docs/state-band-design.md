# Banda de estados: columnas de texto en la serie temporal

Estado: implementado, en memoria y en memory-saving. Donde la construcción se
apartó del borrador, la sección lo dice, y *Cómo quedó construido* (al final) junta
esas diferencias.

Relacionado: [marks-menu-nan-gaps-design.md](marks-menu-nan-gaps-design.md) (las tiras
NaN/Inf y Repetidos, el precedente de "una franja fina a lo largo del tiempo"),
[csv-robust-parsing.md](csv-robust-parsing.md) y el PR #312 (cómo una columna llega a
ser texto), [sample-markers-design.md](sample-markers-design.md) (los estados "en
espera" de un toggle).

## Por qué

Una columna de texto de un CSV (`estado`, `modo`, `alarma`, `operador`, `turno`) hoy
llega al árbol como variable `dataType: 'string'`, se dibuja atenuada y no se puede
arrastrar: `canPlot` la excluye en `src/app/methods/tree-methods.js:597`, y aunque
llegara, `addTrace` la rechaza en `src/plots/plot-manager.js:1519`. El usuario que
quiere ver *cuándo* una máquina estaba en `RUN` y cuándo en `FAULT`, junto a la
temperatura que sí se dibuja, no tiene forma de hacerlo.

Esas columnas no son números: no tienen magnitud ni orden. Dibujarlas como un trazo
que sube y baja entre categorías (un eje Y de categorías) inventa una altura que no
significa nada y roba espacio vertical a las señales que sí lo necesitan. Lo que
cambia a lo largo del tiempo es **cuál** es el valor, y eso se muestra con **color**,
no con posición.

## Qué se construye

Una **banda de estados**: una franja horizontal de altura fija, en su propio carril
debajo del área de las señales numéricas, que **no avanza en Y** y **cambia de color
cada vez que el valor cambia**. Cada variable de texto arrastrada al panel tiene su
carril; los carriles se apilan desde abajo.

```
   ▲ temperatura
   │        ╭──╮
   │   ╭────╯  ╰───╮          ╭──
   │───╯           ╰──────────╯
   ┼────────────────────────────────▶ t
 estado ████████░░░░░░░░▒▒▒▒████████
        RUN     STOP    FAULT RUN
 modo   ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░
        AUTO                  MANUAL
```

- Un **tramo** (run) es una secuencia máxima de filas consecutivas con el mismo
  valor. El valor rige desde su fila hasta la fila siguiente (semántica de escalón,
  la misma que los booleanos, `_variableDefaultsToStairs` en
  `src/plots/methods/data-methods.js:1970`). El último tramo se extiende un paso
  nominal (`estimateNominalStep`, ya calculado y cacheado para *Gaps*) cuando el
  archivo tiene uno, para que un valor que aparece solo en la última fila se vea.
- Una celda vacía (`''` en memoria, `NULL` en DuckDB) es un valor **ausente**: la
  banda queda en blanco ahí, como un NaN deja un hueco en un trazo numérico. Un
  tramo de ausentes no es un tramo.
- Los timestamps repetidos (varias filas en el mismo instante) producen tramos de
  duración cero; vale la última fila del instante, y la reducción por píxel (abajo)
  los cuenta como cambios.
- No hay interpolación, signo, ganancia ni logaritmo que aplicar: la banda ignora
  `invertedVariables`, los ejes log y el apilado (*Stack*). El botón de signo del
  árbol hoy se crea cuando `canPlot` (`tree-methods.js:635`); al abrir `canPlot` a
  los strings, el botón pasa a exigir además `dataType !== 'string'`, y
  `setVariableSignInverted` sigue ignorándolos (`plot-manager.js:522`).

### Dónde se puede soltar

| modo del panel | qué pasa |
|---|---|
| Series temporales | se dibuja la banda |
| Panel de tarjetas (Dashboard) | la tarjeta muestra el texto. Ya funciona: `_addDashboardCards` no filtra por tipo y `formatDashboardValue` deja pasar strings (`dashboard-methods.js:104`); solo lo impedía el árbol |
| FFT, histograma, heatmap, perfil, integral, correlación, 2D, 2D+t, 3D, animaciones | se rechaza con el pill del panel: *«estado» es texto: solo se dibuja en la serie temporal y en el panel de tarjetas* |
| Fórmulas, herramientas de datos, variables derivadas | sin cambio: siguen excluyendo strings (`derived-methods.js:282`, `data-tools-methods.js:961`) |

Al cambiar un panel de series temporales a un análisis, `drawable()` en `_setMode`
(`plot-manager.js:970`) deja las bandas atrás como hoy deja las tarjetas de texto, y
el pill lo dice una vez. Al volver a series temporales o a tarjetas, se recuperan.

## Color

### Un mapa por panel, por valor

El color sigue al **valor**, no al carril: `RUN` es del mismo color en la banda
`estado_bomba_1` y en `estado_bomba_2` del mismo panel. El mapa vive en el panel
(`plot.stateColors: Map<string, slot>`), se construye por **orden de primera
aparición en el archivo** (no en la vista: hacer zoom no repinta), recorriendo las
bandas en el orden en que se agregaron. Un valor nuevo que trae una actualización en
vivo toma el siguiente slot. El mapa no se guarda en la sesión: con los mismos
archivos y las mismas trazas en el mismo orden se reconstruye igual.

Una elección manual de color por valor (desde el menú de la leyenda) queda fuera de
esta primera versión; cuando exista, se guardará como `plot.stateColorOverrides`.

### Paleta

No se reutiliza `PlotManager.COLORS` (`plot-manager.js:5446`). Es la paleta de los
trazos numéricos del panel, y dos colores iguales en una banda y en una curva
dirían algo falso. Además, pasada por el validador de `dataviz` con todos los pares
(en una banda cualquier par de valores puede quedar lado a lado) falla: naranja
`#FF9800` contra verde `#4CAF50` tiene ΔE 3.6 para protanopía, y `#F44336` contra
`#FF5722` ΔE 4.7 incluso con visión normal.

Se adopta la paleta categórica de referencia de ese mismo método, con sus pasos
para fondo claro y oscuro (el tema oscuro no es una inversión, son pasos propios
validados contra `#1e1e1e`):

| slot | claro | oscuro |
|---|---|---|
| 1 | `#2a78d6` | `#3987e5` |
| 2 | `#eb6834` | `#d95926` |
| 3 | `#1baf7a` | `#199e70` |
| 4 | `#eda100` | `#c98500` |
| 5 | `#e87ba4` | `#d55181` |
| 6 | `#008300` | `#008300` |
| 7 | `#6250d6` | `#9085e9` |
| 8 | `#e34948` | `#e66767` |

Resultado del validador (`--pairs all`, superficies `#ffffff` y `#1e1e1e`): los tres
primeros slots pasan todos los pares en ambos temas; a partir del cuarto hay pares
por debajo del piso (amarillo/naranja ΔE 13.7 normal en claro, 10.6 en oscuro;
rosa/verde ΔE 1.6 deután en oscuro). Por eso la banda **nunca cuenta solo con el
color**:

1. **La etiqueta dentro del tramo.** Cada tramo lleva su texto; Plotly lo oculta
   cuando no cabe (`layout.uniformtext = { mode: 'hide', minsize: 10 }`,
   `textposition: 'inside'`). Zoom suficiente = texto visible, siempre. La tinta
   del texto se elige por contraste contra el color del tramo (oscura sobre
   amarillo, clara sobre azul), nunca el color de la serie.
2. **El hover** dice siempre el valor (ver *Hover*).
3. **Los slots 9 a 16 repiten los ocho colores con trama** (`marker.pattern.shape:
   '/'`), que distingue `#2a78d6` liso de `#2a78d6` rayado sin depender del tono.
4. **Un separador de 1 px** del color del fondo entre tramos (`marker.line`), para
   que dos tramos del mismo valor separados por un ausente, o dos valores de
   colores vecinos, no se fundan.

### Más de 16 valores distintos

Una columna con más valores distintos que `STATE_BAND_MAX_VALUES = 16` (comentarios
libres, identificadores, un nombre por fila) no es una columna de estados y no se
colorea por valor: la banda alterna dos grises neutros en cada cambio, el texto va
en el hover y en la etiqueta del tramo, y el pill lo dice una vez al soltarla:
*«comentario» tiene 1 240 valores distintos: la banda marca los cambios; el texto, en
el hover*. El recuento es sobre el archivo entero (un `Set` en memoria; `COUNT
(DISTINCT)` en DuckDB, cacheado en el objeto de datos del archivo).

## Presentación

### Carriles

- Altura fija en píxeles, `STATE_BAND_LANE_PX = 18`, con `STATE_BAND_LANE_GAP_PX = 4`
  entre carriles, igual criterio que la tira NaN/Inf (5 px fijos): lee igual en un
  panel chico y en uno alto.
- Los carriles se **reservan**, no se superponen: el eje Y principal cede el fondo.
  Con `n` bandas y `H` px de alto del área de dibujo,
  `f = min(n·(18+4) / H, 0.4)`; `yaxis.domain = [f, 1]` (y `yaxis2`, que lo hereda por
  `overlaying: 'y'`) y un tercer eje para las bandas: `yaxis3 = { anchor: 'x',
  domain: [0, f], range: [0, n], visible: false, fixedrange: true }`. Sin bandas,
  todo queda como hoy: `domain: [0, 1]` y sin `yaxis3`. Es el primer uso de
  `domain` en la serie temporal (hoy solo lo usa el heatmap de calendario,
  `heatmap-methods.js:1452`), así que `_buildTimeLayout` (`data-methods.js:2255`)
  gana una sección propia para esto.
- `f` depende del alto en píxeles: se recalcula en el `ResizeObserver` del panel
  (`plot-manager.js:2061`), antes de `Plots.resize`, y cada vez que cambia el número
  de bandas. El cap de 0.4 evita que seis carriles en un panel bajo dejen a las
  señales sin sitio; pasado el cap, los carriles se comprimen por igual.
- El carril `i` (0 = el de arriba) ocupa `y ∈ [n−1−i, n−i]` en `yaxis3`; la barra
  tiene `width: 0.8`, centrada. A la izquierda, en el margen (que junto a los
  carriles no lleva marcas del eje Y), una anotación (`xref: 'paper', x: 0,
  xanchor: 'right', yref: 'y3'`) con el nombre de la variable, cortado a 9
  caracteres; el nombre completo va en su hover.
- **Construido:** el eje de tiempo se ancla a los carriles (`xaxis.anchor: 'y3'`).
  Anclado al eje numérico quedaba a la altura de `yaxis.domain[0]` y dibujaba sus
  marcas y su título encima de las bandas.
- *Fit Y* y el arrastre vertical tocan `yaxis`/`yaxis2`; `yaxis3` es `fixedrange`.
  Las bandas de *Gaps* (altura completa, `yref: 'paper'`) cubren también los
  carriles, y está bien: un hueco de filas es un hueco también para la banda. Las
  tiras NaN/Inf y Repetidos siguen arriba, sin cambio.

### Una traza de barras por banda

Cada banda es **una** traza Plotly de tipo `bar`, horizontal, con un tramo por barra:

```js
{
  type: 'bar', orientation: 'h', yaxis: 'y3',
  y:      runs.map(() => laneCenter),        // constante: no avanza en Y
  base:   runs.map(r => r.t0),               // inicio del tramo (ISO en calendario,
  x:      runs.map(r => r.t1 - r.t0),        //   número en elapsed/numérico);
                                             //   duración en ms o en unidades del eje
  width: 0.8,
  marker: { color: runs.map(r => colorOf(r.value)), pattern: {...}, line: { width: 1, color: bg } },
  text:   runs.map(r => r.value), textposition: 'inside', insidetextanchor: 'middle',
  textfont: { color: runs.map(r => inkOn(colorOf(r.value))) },
  customdata: runs.map(r => [r.value, r.t0Label, r.t1Label, r.durationLabel, r.changes]),
  hovertemplate: '…',
  showlegend: false, hoverlabel: {...}
}
```

Es la forma que usa `px.timeline` (Gantt) de Plotly: `base` admite fechas en un eje
de tipo `date`, y `x` es entonces la duración en milisegundos. En modos *elapsed* y
numérico, `base` y `x` son números en las unidades del eje, como las `x` de
`_plotlyTimeArray` (`data-methods.js:826`).

Una traza por banda, y no una por valor, **conserva el invariante** del que depende
todo el refresco: `plot.traces[i]` es `plot.div.data[i]` y la traza de marcadores de
hover queda después, en `markerTraceIdx` (`_refreshTimeseriesVisuals`,
`interaction-methods.js:308`). El layout lleva `barmode: 'overlay'` y `bargap: 0`;
no hay otras barras en el panel a las que afecte.

### Lo que se dibuja según el zoom

La banda no se construye desde `variable.data` en cada refresco sino desde una
**codificación por tramos** que se calcula una vez por variable y se cachea por
identidad y longitud del array, como `_fullVisualCache`:

```js
{ starts: Int32Array,   // índice de fila donde empieza cada tramo
  values: Uint16Array,  // índice del valor en la tabla de valores de la variable
  table:  string[] }    // valores distintos, en orden de primera aparición
```

Para el rango visible, dos búsquedas binarias en `starts` por tiempo (como
`_lowerBound`/`_upperBound` hoy) dan los tramos a dibujar, más el que empezó antes
de la ventana. Presupuesto `STATE_BAND_MAX_RUNS = 4000` tramos en pantalla; por
encima, **reducción por columna de píxel** (`STATE_BAND_COLUMN_PX = 2`, el mismo
grano que la tira NaN/Inf): cada columna se dibuja del color del valor que más
tiempo ocupa en ella y su hover dice *n cambios en esta columna*. Columnas vecinas
del mismo valor se funden en una barra. Así una columna que cambia en cada fila de
un archivo de millones de filas cuesta tantas barras como píxeles, y hacer zoom
devuelve los tramos exactos.

El refresco en cada zoom sigue el camino de hoy: `_refreshTimeseriesVisuals`
reconstruye la traza para el rango. **Construido:** las bandas no viajan en el
`restyle` de las curvas sino en uno propio (`_refreshStateBands`), con `base`, `x`,
`y`, colores, tramas, `text`, `textfont.color` y `customdata`, y como
`Plotly.update` que repite el tipo y el rango del eje X. Restilar `x` hace que
Plotly vuelva a adivinar el tipo del eje desde los datos, y la `x` de una barra es
una duración en ms: un panel solo de bandas pasaba de fechas a una recta numérica.
`Plotly.update` emite `plotly_update`, no el `plotly_relayout` del que se lee un
zoom, así que nada responde a esa llamada con otro refresco.

**Construido:** los tramos se dibujan recortados a la vista (más un 2 % a cada
lado, para el arrastre). Plotly centra la etiqueta en la barra entera, y un tramo
que salía de la pantalla escribía su valor fuera de ella. El hover conserva el
inicio y el fin reales.

### Leyenda

La traza de barras no entra en la leyenda de Plotly (`showlegend: false`): la
muestra que Plotly daría es el color de la primera barra, que diría algo falso. En
su lugar, una **fila de fichas** propia del panel, `.state-band-legend`, bajo el
título del eje de tiempo (en el espacio que el layout reserva con
`STATE_BAND_LEGEND_PX`), una ficha por valor
del mapa del panel: muestra de color (con trama si la tiene), texto del valor. Se
reconstruye cuando cambian el mapa o las bandas, como se reconstruye el menú
*Marcas* desde el estado del panel. **Construido:** se coloca midiendo el título
del eje; en el teléfono el margen automático lo baja, y una fila fija al borde
inferior quedaba debajo de él. Si no cabe, el margen crece. Una banda con más de
16 valores tiene su propia ficha (*nombre: un gris por cambio*). En la primera
versión no es interactiva;
pulsar una ficha para resaltar ese valor (atenuando los demás tramos) es la
extensión natural.

El menú contextual de la leyenda (`_showLegendTraceMenu`, `plot-manager.js:2193`)
no alcanza a las bandas porque no están en la leyenda. **Construido:** la banda se
quita con **Mayús+clic** sobre la etiqueta de su carril, el mismo gesto que quita
una curva desde la leyenda (el hover de la etiqueta lo dice), y desde la lista de
señales en el teléfono, como cualquier traza. El menú contextual del borrador
quedó fuera.

## Hover, cursores, tarjetas

- **Hover sincronizado** (`_onHover`, `interaction-methods.js:2056`): para una banda
  la línea del cuadro es `■ estado = RUN`, con la muestra cuadrada del color del
  valor en lugar del punto; sin marcador sobre la curva. El índice se busca con
  *última fila en o antes de t* (`lastIndexAtOrBefore`, ya en
  `dashboard-methods.js:88`), no con el más cercano (`_findTimeIdx`): un estado rige
  hacia adelante.
- **Hover nativo de la barra** (`hovertemplate`): valor, desde, hasta, duración; en
  columnas reducidas, además *n cambios*. Las horas se formatean como en el
  `customdata` de los modos calendario y elapsed.
- **Cursores A/B** (`_updateCursorBox`, `interaction-methods.js:3970`): la lectura
  de una banda muestra el valor en A y en B (`RUN → STOP`); `Δy` y pendiente quedan
  vacíos. `_traceInterpolationMode` devuelve `'step'` para una banda y
  `_interpolateAt` devuelve el valor, no `NaN`.
- **Tarjetas**: sin cambio, ya muestran texto. Pasan a ser alcanzables porque el
  árbol deja arrastrar.

## Fuentes de datos

Solo los CSV (en memoria, memory-saving por DuckDB y Parquet) producen series de
texto alineadas con el tiempo; en todos los demás parsers un `'string'` es un
parámetro o metadato con `plottable: false` y `kind: 'parameter'`, y **nada cambia
para ellos**: el árbol sigue leyendo `plottable !== false`. La regla nueva de
`canPlot` es `plottable !== false && (dataType !== 'string' || kind === 'variable')`.

### En memoria

`src/parsers/csv-parser.js:209-230`: `data` es un `Array` de strings recortados,
`''` para la celda vacía. Nada que cambiar en el parser. La codificación por tramos
se calcula desde ese array.

Actualización en vivo (`live-update-methods.js:545`): las columnas string se
extienden sobre el mismo `Array`; la caché por tramos se invalida por longitud, y
los tramos nuevos se codifican de forma incremental desde el último `start`
(el último tramo puede continuar).

### Memory-saving (DuckDB)

Las columnas `VARCHAR` ya se exponen como variables `dataType: 'string'` con
`_duckdbCol` (`_buildLegacyFromArrow`, `duckdb-source.js:4831-4850`), pero las
consultas de rango las descartan: `_valueExpressionSql` castea todo a `DOUBLE`
(`:4691`) y la extracción es `Float64`. La banda **no usa `variable.data`** de un
archivo lazy (es la muestra por zancada de `_overviewSql`, que pierde tramos cortos,
y `refreshOverview` reemplaza el eje de tiempo sin realinear las columnas string,
`:2402-2418`, un desajuste latente que conviene dejar anotado). Usa dos métodos
nuevos del origen, coordinados por rango como las marcas lazy
(`marks-methods.js:534`):

1. `getStateRuns(fileId, column, t0, t1, maxRuns)`: los cambios de valor en el rango,
   más la fila anterior a `t0` (para el tramo que empezó antes):

   ```sql
   WITH v AS (
     SELECT t, trim(col) AS value, LAG(trim(col)) OVER (ORDER BY t) AS prev
     FROM view WHERE t >= t_prev AND t <= t1)
   SELECT t, value FROM v WHERE prev IS DISTINCT FROM value ORDER BY t
   ```

   `trim` iguala el camino lazy al de memoria (`_projectionColumnSql`, `:4576`, no
   recorta `VARCHAR`); `''` y `NULL` son ambos ausentes. Si `COUNT(*)` de cambios en
   el rango supera `maxRuns`, el método devuelve en cambio la reducción por cubeta:
   una cubeta por columna de píxel con `mode(value)` (DuckDB lo tiene) y el número
   de cambios. **Diferencia con memoria:** `mode` elige el valor de más *filas*
   en la columna, no el de más *tiempo*; con un muestreo regular es lo mismo.
   Una columna sin filas conserva el valor de la anterior.
   **Construido:** el tramo que ya regía en el borde izquierdo empieza, para
   DuckDB, en la fila del borde, porque la consulta lee la vista y no lo anterior.
   Ese inicio queda fuera de la pantalla, a la izquierda; solo el "desde" de su
   hover es la fila del borde y no el inicio real del tramo.
2. `getStateValues(fileId, column, limit)`: `SELECT value, MIN(t) FROM … GROUP BY
   value ORDER BY 2 LIMIT limit + 1`, para el mapa de colores en orden de primera
   aparición y el cap de 16; cacheado en el objeto de datos del archivo.

El `LAG` ya se usa para la monotonía del tiempo (`:2970`) y para los intervalos de
la integral; no hay un helper de tramos que reutilizar, es código nuevo en
`src/data/state-runs-sql.js` junto a `missing-buckets-sql.js`.

### Parquet

La conversión escribe las columnas de texto como `VARCHAR`
(`csv-to-parquet-core.js:98-106`) y se releen por el mismo `_buildLegacyFromArrow`:
cubierto por el camino DuckDB.

## Exportación

`_appendTimeseriesExportColumns` (`plot-manager.js:3505`) lee los arrays de las
variables, así que una banda exporta su columna de texto completa, una fila por
muestra, sin cambio de estructura. Lo que **sí** hay que cambiar: `_writeCsvChunks`
(`:3011`) escribe `String(value)` sin entrecomillar; un valor con el delimitador, una
comilla o un salto de línea rompería el archivo. Las columnas string pasan por
`csvTextCell` (`src/utils/csv-cell.js`), como ya hacen los encabezados. El feeder
lazy (`_lazyCsvRowFeeder`, `:3413`) proyecta la columna `VARCHAR` sin cast.

## Estado y sesión

- La entrada de traza no cambia de forma: `{ varName, fileId, color, axis }`. Que sea
  banda se decide al construir, por `dataType === 'string'` de la variable; `axis`
  se ignora. `_sessionTraceExists` (`session-methods.js:1319`) solo mira que la
  variable exista, así que una vista guardada con bandas se restaura sola, y ninguna
  vista anterior puede contener una (se rechazaban), no hay migración.
- `plot.stateColors` no se guarda: es derivable.
- En el teléfono, la lista de señales del Plot sheet muestra la banda como una
  señal más, con la muestra cuadrada; el tap-to-plot del Data sheet pasa por el
  mismo `canPlot`.

## Avisos (i18n, cuatro idiomas)

| clave | EN |
|---|---|
| `stateBandRefusedMode` | *“{name}” is text: it is drawn in the time series and in the dashboard only.* |
| `stateBandTooManyValues` | *“{name}” has {n} distinct values: the band marks the changes; the text is in the hover.* |
| `stateBandLeftBehind` | *Text signals stay behind in this analysis; they come back with the time series.* |
| `stateBandChanges` | *{n} changes in this column* |
| `stateBandHover` | *{value}<br>from {from} to {to} ({duration})* |
| `stateBandRemove` | *Remove band* |

El badge del árbol sigue diciendo `(string)` sin traducir, como hoy (`getVariableInfo`,
`mat-parser.js:487`); cambiarlo es otro tema.

## Dónde vive

- `src/utils/state-runs.js`: codificación por tramos (completa e incremental), el
  corte por rango, la reducción por columna de píxel, la extensión del último tramo,
  el recuento de valores distintos. Puro, sin DOM ni Plotly.
- `src/utils/state-colors.js`: la paleta (claro/oscuro, tramas), el mapa por orden de
  aparición con el cap, la tinta por contraste.
- `src/data/state-runs-sql.js` y los métodos `getStateRuns` / `getStateValues` en
  `duckdb-source.js`.
- `src/plots/methods/state-band-methods.js`: la traza de barras, los dominios de los
  carriles, las anotaciones de carril, la fila de fichas, el coordinador lazy, los
  avisos. Enganchado desde `_addTimeseries`/`_addTimeseriesBatch`, `_buildPlotData`,
  `_buildTimeLayout`, `_refreshTimeseriesVisuals`, el `ResizeObserver`, `_onHover`,
  `_updateCursorBox` y `_setMode`.
- `src/app/methods/tree-methods.js`: la regla nueva de `canPlot` (`:597`, `:125`,
  `:783`, `:811`).
- `src/plots/plot-manager.js`: las compuertas `:1329` y `:1519` pasan a ser por modo;
  `:970` conserva las bandas entre series temporales y tarjetas; exportación `:3011`.
- `src/i18n/translations.js`: las claves de arriba en `en`, `fr`, `es`, `it`.

## Orden sugerido de implementación

1. `state-runs.js` y `state-colors.js` con sus tests: todo lo que se puede probar sin
   navegador.
2. Árbol y compuertas por modo, con los avisos. En este punto una columna string se
   puede soltar en tarjetas y en series temporales (donde todavía no dibuja nada).
3. Traza de barras, dominios de carriles, anotaciones, refresco por zoom y por
   resize. Primero archivos en memoria.
4. Hover, cursores, exportación entrecomillada.
5. Etiquetas dentro del tramo, tramas, fila de fichas.
6. DuckDB: `getStateRuns`, `getStateValues`, coordinador por rango, paridad con
   memoria.
7. Teléfono (lista de señales, sheet), notas de versión.

## Tests

- `scripts/test-state-band.mjs` (`npm run test:state-band`, entra solo en
  `test:release`): codificación por tramos (cambios, recorte, vacíos y `null`,
  timestamps repetidos, última fila con y sin paso, continuación tras un append,
  relectura de una columna más corta), corte por rango con el tramo que rige en el
  borde, reducción por columna (valor dominante, recuento de cambios, fusión de
  columnas iguales, columna mayormente vacía en blanco, zoom de vuelta a lo
  exacto), la fila en-o-antes, paleta y tramas, mapa de colores por orden de
  aparición, tinta por contraste. Y el SQL contra **DuckDB real**: los cambios dan
  los mismos tramos que la lectura en memoria (recortados, `NULL` y `''` como
  ausentes), la fila del borde de una ventana, el tope de filas, las columnas y
  sus cambios, los valores distintos en orden de aparición.
- `test-i18n-consistency`: las claves nuevas en los cuatro idiomas.
- `scripts/e2e-state-band.mjs` (`npm run e2e:state-band`, Chromium, en la cadena
  `npm run e2e`): el árbol deja arrastrar una serie de texto y no le pone signo; la
  banda en su carril bajo la curva, el eje Y de la curva intacto y el de tiempo
  bajo los carriles; un tramo por cambio, el hueco de las celdas vacías, un color
  por valor, la duración de un tramo y del último; las fichas en orden de aparición;
  la columna de 200 valores en grises, con su aviso; etiquetas dentro de los
  tramos; el zoom con los tramos de la ventana; el cuadro de hover sobre la curva,
  sobre una celda vacía y sobre una barra; la fila de la lectura A|B; un análisis
  que deja atrás las bandas, el rechazo al soltar texto en él y la vuelta a la
  serie temporal; las tarjetas del dashboard; la exportación CSV con comillas; una
  vista guardada que las trae de vuelta; Mayús+clic sobre la etiqueta; el tema
  oscuro; y un archivo memory-saving de 400 000 filas cuyos tramos, leídos de
  DuckDB, son los de la lectura en memoria.
- `e2e-dashboard`: una señal de texto vuelve como banda al pasar de tarjetas a
  serie temporal.
- Fixture: `test-files/csv/state-band.csv`, pequeño: `time`, `temperature`, `state`
  (`RUN`/`STOP`/`FAULT`/`IDLE`, con celdas vacías y un timestamp repetido) y `note`
  con un texto distinto por fila, con comas, para el camino de más de 16 valores y
  el entrecomillado.

## Cómo quedó construido

Lo que difiere del borrador, en un lugar:

- **Alta y baja sin redibujar.** Una banda que llega o se va no reconstruye el
  panel: un `relayout` de los carriles (`_stateBandLayoutUpdate`) va primero, para
  que una barra nunca caiga en un eje que todavía no existe, y después
  `addTraces`/`deleteTraces` y el refresco. Reconstruir mientras Plotly terminaba su
  primer dibujo tiraba un error de Plotly sobre un div ya purgado (el mismo riesgo
  que el código ya documenta en #39).
- **Eje de tiempo anclado a los carriles** y **tipo y rango del eje fijados en el
  refresco** (ver *Presentación*).
- **Tramos recortados a la vista**, para que la etiqueta caiga en la parte visible.
- **Mayús+clic** sobre la etiqueta del carril quita la banda, en lugar de un menú.
- **Cursores A|B:** una banda no se elige como traza del cursor (los cursores miden
  curvas: Δy, pendiente, extremos). La lectura agrega una fila por banda visible con
  el valor en A y en B.
- **Exportación de archivos memory-saving:** `_rawRowsSql` lee las columnas de
  texto como `VARCHAR`, el stream las extrae como texto y
  `_transformFetchedPhaseTrajectory` no les aplica ganancia ni signo; el CSV las
  escribe con `csvTextCell`, como las de memoria.
- **Tema:** al cambiar de tema las bandas se repintan con los pasos oscuros de la
  paleta (`_refreshStateBandsForTheme`); el `relayout` del tema no alcanzaba a los
  colores de las barras.
- **Dashboard → serie temporal:** una señal de texto ya no se queda atrás; vuelve
  como banda. `e2e-dashboard` afirmaba lo contrario y se actualizó.
- **Llamadas opcionales:** el código compartido llama a los métodos de banda con
  `?.()`, porque varios tests cargan métodos sueltos sobre un prototipo parcial.
