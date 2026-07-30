# Análisis "Integral" — requerimientos e implementación

> Estado: **implementado** en la rama `claude/integral-curves-analysis-bd46ad` (base `f091128`), incluido el camino lazy (DuckDB) y las magnitudes por día y media.
> Motivación: totales energéticos sobre series temporales de redes eléctricas (archivos PyPSA): potencia [MW] → energía [MWh].
> §16 lista las decisiones que se tomaron sin consultar y §17 lo que quedó fuera.
> Cada afirmación sobre el código está anclada como `archivo:línea`.

---

## 1. Alcance

Un **modo de análisis nuevo de la familia Timeseries** (`mode: 'integral'`) que calcula la **integral definida** — un escalar por señal — sobre el rango activo, y la muestra como **gráfico de barras** (vertical u horizontal) y, opcionalmente, como **gráfico de torta**.

No confundir con **Data Tools → Integral**, que produce la integral **acumulada** (una serie nueva) — [`src/compute/kernels/integral.js:68`](../src/compute/kernels/integral.js:68). Comparten método y semántica de Δt; son funcionalidades distintas.

### 1.1 Base heredada de PR #18

El trabajo previo sobre "integral over missing data" definió el vocabulario que este análisis reutiliza, en vez de inventar uno paralelo:

- `gapPolicy` (`zero` / `interpolate` / `propagate`) — [`shared.js:98`](../src/compute/kernels/shared.js:98)
- la compuerta de **paso nominal** de `detectSamplingGaps`: donde el eje no tiene un paso, un Δt largo es muestreo real, no un hueco — [`sampling-gaps.js:60`](../src/utils/sampling-gaps.js:60)
- el reporte de `uncoveredTime` como propiedad **del archivo**, no de la política elegida

El kernel nuevo consume `detectSamplingGaps` y reexporta `bridgeNonFinite` desde el kernel acumulado, de modo que **una fila ausente y una celda vacía dan el mismo número** en los dos análisis.

---

## 2. Punto de entrada

| Ítem | Valor | Anclaje |
|---|---|---|
| `mode` interno | `'integral'` | — |
| Botón | `Integral`, a la derecha de `Profile` | [`interaction-methods.js:3795`](../src/plots/methods/interaction-methods.js:3795) |
| Clase CSS | `timeseries-integral-btn` | idem |
| i18n | `integralModeLabel` / `integralMode` | `translations.js` (en/es/fr/it) |

El modo se registró en los ~20 puntos de `plot-manager.js` que enumeran la familia Timeseries (creación, teardown, resize, tema, autoscale, sesión, toolbar). El test `scripts/test-integral-analysis.mjs` §11 verifica esos anclajes: un modo que calcula bien pero no está registrado se rompe al cambiar de panel o al recargar la sesión.

---

## 3. Layout

Idéntico al de Profile / Histogram, reutilizando su CSS (`hist-container`, `hist-topbar`, `hist-splitter`, `hist-options`):

- panel de serie temporal + panel de resultado, con **splitter** arrastrable y `split` persistido;
- topbar con `V/H`, `Hide time series`, `Reset`, `Options`;
- panel lateral derecho de opciones;
- el pane temporal lleva la clase `plotly-mode-integral-time`.

---

## 4. Bloque Range (copia exacta)

Réplica literal del bloque de Profile ([`temporal-profile-methods.js:1290`](../src/plots/methods/temporal-profile-methods.js:1290)), verificada en la app:

1. Fila `Range` con segmented **Full / Selection** (`fftRange`, `fftRangeFull`, `fftRangeSelection`), mismo `wrapperClass: 'fft-segmented'`, mismos tooltips.
2. `fft-range-grid` con **Start** y **End**: input + slider, ambos `disabled` en modo Full.
3. `datetime-local` con `step="1"` en eje calendario; `number` en eje numérico.
4. Banda verde `rgba(67,160,71,0.14)` con dos líneas `#43a047` — [`integral-methods.js`](../src/plots/methods/integral-methods.js), `_integralSelectionShapes`.
5. Arrastre idéntico: tolerancia de 12 px en los bordes → `ew-resize`; dentro de la banda → manito (`grab`/`grabbing`).
6. CSS: `.plotly-mode-integral-time` agregado a los cuatro grupos de selectores de cursor — [`content.css:2668-2698`](../src/styles/content.css:2668).

---

## 5. Cálculo

Kernel puro nuevo: [`src/compute/kernels/definite-integral.js`](../src/compute/kernels/definite-integral.js). Sin DOM, sin i18n, con códigos de error estables.

### 5.1 Qué lo distingue de "el último valor de la acumulada"

1. **Los bordes del rango se respetan exactamente**: un intervalo que cruza `t_start`/`t_end` se recorta y su extremo se **interpola**, así el total varía de forma continua al arrastrar la banda en vez de saltar cada vez que el borde cruza una muestra. Es el mismo tratamiento que el heatmap lazy ya da a los bordes de celda ([`duckdb-source.js:1726`](../src/data/duckdb-source.js:1726)).
2. **Se pueden quitar días enteros** del dominio de integración, lo que exige recortar en medianoche.
3. **Reporta cuánto del rango cubrió realmente**. Con cualquier política que no sea `interpolate` un hueco no aporta nada, así que el número es una **cota inferior** — y un gráfico de barras que oculte eso es peor que no tener gráfico.

### 5.2 Método (dropdown `Rule`)

`trapezoidal` (default) y `rectangular` (izquierda), los mismos valores que Data Tools ([`shared.js:84`](../src/compute/kernels/shared.js:84)).

### 5.3 Base temporal

| Eje X | Δt | Opciones por día |
|---|---|---|
| Calendar / datetime | segundos | **sí** |
| Numérico con unidad conocida (`s`, `min`, `h`, `d`, `ms`…) | convertido a segundos | no |
| Numérico con unidad desconocida | se asume segundos + warning `integralAssumedSeconds` | no |
| Índice | por muestra; unidad `·samples` | no |

La tabla de conversión está en [`integral-presentation.js`](../src/utils/integral-presentation.js), `TIME_UNIT_SECONDS`. Un eje en horas se **convierte**, no se adivina; solo lo irreconocible dispara el warning.

### 5.4 Rechazos

- timestamps desordenados → `reason: 'unsorted'`, sin barra (igual que el heatmap);
- menos de 2 muestras → `'noData'`;
- todos los días descartados → `'allDiscarded'`, distinto de "sin datos".

---

## 6. Valores faltantes (dropdown `Missing values`)

| Valor | Etiqueta | Semántica |
|---|---|---|
| `zero` (**default**) | Assume zero | El segmento no aporta nada. El total es cota inferior. |
| `interpolate` | Interpolate across | Se puentea linealmente. Una fila ausente y una celda vacía dan el mismo número. |
| `discard-day-own` | Discard the whole day (this signal) | El día calendario UTC que contiene el hueco sale del dominio, solo para esa señal. |
| `discard-day-all` | Discard the whole day (all signals) | Sale para **todas**, así todas las barras integran la misma duración. |

Precisiones implementadas:

1. **Día** = día calendario **UTC** `[00:00, 24:00)`.
2. **Huecos temporales** (filas ausentes) cuentan igual que NaN, detectados con la compuerta de paso nominal compartida.
3. Los intervalos que cruzan el borde de un día descartado se **recortan** en el borde.
4. `discard-day-all` hace **dos pasadas**: `collectMissingDays` por señal, unión, y recién entonces el total de cada una. Es la única forma de que todas las barras reclamen la misma duración.
5. `propagate` **no** se ofrece: para un escalar degenera en "sin barra", que ya es la salida vacía.

El kernel devuelve tres duraciones distintas y no las mezcla:
`coveredTime` (lo integrado), `uncoveredTime` (lo que el **archivo** no tiene — se reporta bajo toda política, incluida `interpolate`) y `discardedTime` (lo que la política de días sacó).

---

## 7. Puntos o períodos, y los días de los extremos

### 7.1 `Cada muestra dura hasta la siguiente` (default **on**)

Checkbox en **Data handling**. Es una afirmación sobre lo que *significan* las marcas de tiempo, no una regla de cuadratura. El tooltip plantea la pregunta y la trabaja con un ejemplo concreto, porque la etiqueta sola no alcanza: ¿una marca de tiempo señala un **instante** o el **tramo de tiempo que le sigue**?

- **Tramos** (on): cada muestra se mantiene hasta la siguiente, así que la última se mantiene **un paso nominal** más. 24 muestras horarias abarcan **24 h**, y un día de cuartos de hora integra 24 h exactas. Las herramientas de sistemas energéticos **tales como PyPSA** escriben este tipo — cada snapshot representa un período y lleva una ponderación — y por eso es el default acá.
- **Instantes** (off): la señal solo se conoce *en* cada muestra, el área entre dos es un trapecio y nada puede decirse más allá de la última. Las mismas 24 muestras horarias abarcan 23 h. Un datalogger que registra una temperatura suele escribir de este tipo.

Precisiones: el tramo final se mantiene **constante** al último valor (no extrapola la pendiente), se recorta por el rango y por medianoche como cualquier otro intervalo, y **solo existe si el eje tiene un paso nominal** — sin él no hay largo defendible que darle, y usar la mediana de un montón de distancias sin relación sería una adivinanza disfrazada de dato.

En modo Full el **dominio** llega un paso más allá de la última muestra; un rango que el usuario tipeó o arrastró nunca se ensancha.

### 7.2 `Discard incomplete start/end days`

Checkbox, **default off**, habilitado solo con eje calendario. Descarta el primer y el último día UTC del rango cuando los datos no lo cubren de extremo a extremo.

**Las dos opciones tienen que coincidir, y ahora coinciden.** La tolerancia del final es de un paso nominal **solo bajo la lectura de períodos** — porque ahí ese paso efectivamente se integra. Con datos cada 15 min que terminan un 2 de febrero a las 23:45:

| Lectura | Días descartados | Duración reportada | Total |
|---|---|---|---|
| Tramos (default) | 1 (el primer día ragged) | **32 d** | 76 800 MW·h |
| Instantes | 2 (también el último) | **31 d** | 74 400 MW·h |

Antes decía *32 días* habiendo integrado 31 d 23 h 45 min: la opción declaraba el día completo y la cuadratura cubría un paso menos. Reportar una duración que no se integró es lo único que ninguna de las dos lecturas permite.

La lectura usada viaja en el resultado y sale en la exportación (`sample_reading`: `periods` / `points`): un total no es auditable sin ella.
---

## 8. Unidades

### 8.1 Checkbox global "Add units to the legends"

- Dentro del grupo **Legend**, debajo de los radio buttons de posición — `id="legend-units"`, **default off**. Es un ajuste de leyenda, así que va con los otros ajustes de leyenda.
- Se aplica en `_traceName(label, fileId, options)` ([`plot-manager.js:3606`](../src/plots/plot-manager.js:3606)), el único constructor de nombres de leyenda.
- Los llamadores que ya agregaban la unidad por su cuenta (headers del CSV, tabla de estadísticas, hovers) pasan `{ units: false }`, así no aparece dos veces.
- Cambiarlo **reconstruye** los paneles: varios modos usan el nombre de traza como identidad para el click en la leyenda, y un `restyle` los desincronizaría.
- Persiste en la sesión.

### 8.2 Warning por unidades heterogéneas

Si las señales visibles tienen unidades distintas: warning `integralMixedUnits`, el eje de valores **queda sin unidad** (elegir una sería mentir) y la torta se deshabilita. Si conviven señales con y sin unidad, warning más suave `integralUnknownUnits`.

### 8.2b Cuando el archivo no declara unidad

Muchos archivos no traen unidades — un netCDF de PyPSA no trae **ninguna**, ni siquiera en el eje temporal — y el panel **no la inventa**. Escribir la integral de una señal no declarada como `h` afirmaba que la señal era adimensional, y convertía una energía en lo que se lee como una duración; con datos más grandes la escala Auto llegaba a ofrecer `kh`, kilohoras.

Ahora se marca: `[?]·h`, `[?]·h/d`, y la media `[?]`. Los corchetes además la mantienen **fuera de la aritmética de prefijos**, así que nunca puede volverse `kh`: se muestra `[?]·h ×10⁶`. El título del eje no duplica los corchetes (`Integral [?]·h`, no `Integral [[?]·h]`).

El mismo arreglo se aplicó al **Calendar Heatmap**, que tenía el bug idéntico. Dejar dos respuestas contradictorias en la misma app sería peor que tocar una feature ya publicada.

Y se cerró un agujero en los warnings: `integralUnknownUnits` solo saltaba si *algunas* señales tenían unidad. Cuando **ninguna** la tiene — el caso de PyPSA — no avisaba nada, justo cuando más falta hacía. Ahora existe `integralNoUnits`.

### 8.2c `Unidad de las señales` — declararla a mano

Campo de texto libre en **Integration**, arriba de `Integral unit`. El espacio de unidades es infinito, así que un dropdown solo podría estar incompleto; en cambio el panel **lee de vuelta lo que entendió**, en una línea debajo del campo:

- escribís `MW` → *“Totals read MW·h · scaled: kW·h / GW·h / TW·h”*
- escribís `pu` → *“Totals read pu·h · scaling shown as ×10ⁿ”*

Precisiones:

1. **Es una etiqueta, no una conversión.** Ningún número cambia, solo cómo se llaman. Verificado: los totales son idénticos dígito a dígito antes y después de escribir la unidad.
2. **Se aplica a todas las señales del panel** y reemplaza lo que dijeran los archivos. Comparar totales solo tiene sentido en una unidad —el panel ya se niega a comparar dos— así que declarar una es declararlas todas, y el warning de unidades mezcladas cede el lugar.
3. **Vive solo en este panel.** La misma señal en otro panel sigue como estaba, igual que el sidebar y los otros modos. El tooltip lo dice.
4. **Llega a la leyenda de la serie temporal de este panel** cuando *Add units to the legends* está activo. El reetiquetado se hace **dentro del módulo Integral**, no en el `_traceName` compartido: el override es local por diseño, y enseñárselo a la función global invitaría a que otro panel heredara una unidad que su archivo nunca declaró.
5. **Es una nota, no un warning.** El panel registra *“Unit MW was typed into this panel, not read from the files”* en un canal neutro: nada está mal, algo simplemente vale la pena saberlo. Pintarlo de ámbar en cada recálculo enseñaría a ignorar el ámbar, y entonces un warning de verdad tampoco se leería.
6. **La exportación lo registra** en `value_unit_source`: `file` / `declared` / `none`. `MW·h` leído de un archivo y `MW·h` tipeado en el panel son la misma cadena y afirmaciones muy distintas.

#### Qué unidades aceptan prefijo

La regla era *“¿parece una unidad?”* — cualquier token de 1 a 3 letras. Erraba en las dos direcciones: `pu` se volvía `kpu` y `°C` se volvía `k°C`, mientras que cualquier cosa más larga se rechazaba fuera lo que fuera. Ahora la regla es *“¿conozco esta base?”*, contra una tabla de bases SI más el vocabulario eléctrico. Lo desconocido **conserva su forma y muestra la década aparte**, que nunca está mal, solo menos lindo.

| Escribís | Escala ×10³ |
|---|---|
| `MW` / `kW` / `W` | GW·h / MW·h / kW·h |
| `Mvar` / `MVA` / `kV` | Gvar·h / GVA·h / MV·h |
| `pu` / `°C` / `%` / `p.u.` | sin plegar, `×10³` aparte |

### 8.3 Unidad de la integral (dropdown)

`per hour ( · h )` (default) y `per second ( · s )`. Formato `MW·h`, la misma convención que ya usa el calendar heatmap ([`heatmap-methods.js:156`](../src/plots/methods/heatmap-methods.js:156)). Sin unidad de origen → `h` a secas.

### 8.4 Escala y formato

- Dropdown `Scale`: `Auto` (default), `×1`, `k`, `M`, `G`, `T`, `m`, `µ`.
- `Auto` elige **un único exponente para todo el panel** a partir del mayor total. Un prefijo por señal haría incomparables las barras, que es lo único que un gráfico de barras no puede hacer.
- El factor se **pliega dentro de la unidad**: `MW·h` × 10³ se muestra como `GW·h`, nunca `GMW·h`. Solo se reconocen los prefijos inequívocos `k/M/G/T` dentro de la unidad (quitar una `m` minúscula convertiría metros en milis).
- Una unidad que no admite prefijo (`p.u.`) conserva su forma y la década se **enuncia**: `p.u.·h ×10³`.
- 4 cifras significativas con separador de miles del locale; el valor completo va en el hover, el resumen y la exportación.
- Checkbox `Show values on bars` (default on).

---

## 9. Visualización

### 9.1 Barras

Una barra por señal visible, con su color de traza. Segmented `Vertical` (default) / `Horizontal`; el eje de valores incluye el cero. Dropdown `Order`: `As in panel` (default), `Largest first`, `Smallest first`.

**Dropdown `Show`** — qué magnitud llevan las barras:

| Valor | Qué es | Unidad |
|---|---|---|
| `Total` (**default**) | La integral definida | `MW·h` |
| `Per day` | El total dividido por la duración integrada **en días** | `MW·h/d` |
| `Mean value` | El total dividido por **toda** la duración integrada: el nivel constante que produciría la misma área | `MW` |

Las tres salen del **mismo par de números** — el área y la duración realmente integrada — así que no pueden contradecirse entre sí. El eje nombra la que está dibujada: dejarlo en "Integral" mientras las barras muestran una media sería una etiqueta que contradice los números.

**Las tres se muestran siempre** en el resumen, en el hover y en la exportación, sea cual sea la dibujada: un total sin su media esconde sobre cuánto tiempo está repartido, y una media sin su cobertura esconde de cuántos datos sale. `Per day` solo existe con eje calendario; en un eje numérico no hay día por el que dividir y no se inventa uno.

### 9.2 Torta — plot propio

Checkbox **default off**. Solo se dibuja si todas las señales comparten **una unidad** y **un signo**. Si no, se oculta **y se dice por qué** (`integralPieMixedSigns` / `integralPieMixedUnits`): una torta no puede representar una suma con cancelaciones, y en redes eléctricas eso pasa siempre (un almacenamiento carga y descarga).

Va en **su propio pane, con su propio splitter arrastrable**, no comprimida en un rincón del gráfico de barras. El corte interno corre **perpendicular al externo**, así ningún pane queda como una astilla:

| Layout externo (botón V/H) | Corte interno |
|---|---|
| Vertical (dos filas) | dos columnas: barras a la izquierda, torta a la derecha |
| Horizontal (dos columnas) | dos filas: torta debajo de las barras |

Sin torta la grilla interna colapsa a una sola celda y las barras recuperan el pane completo. El cursor del splitter sigue el eje (`col-resize` / `row-resize`) y la fracción (`pieSplit`, default 0.62) persiste en la sesión.

Las barras van **sin alpha**: una barra translúcida sobre una línea de grilla se lee como un color distinto del mismo color en la porción de torta de al lado.

---

## 10. Panel lateral

`Range` → `Start`/`End` → **Integration** (`Rule`, `Integral unit`, `Scale`) → **Data handling** (`Discard incomplete start/end days`, `Missing values`) → **Display** (`Show`, `Bars`, `Order`, `Show pie chart`, `Show values on bars`) → **Summary**.

Con eje no calendario quedan deshabilitados: el checkbox de extremos, las dos opciones por día y `Per day` — con tooltip que explica por qué.

La tabla `Summary` lista **Signal · Integral · Per day · Mean value · Coverage**.

---

## 11. Resumen y warnings

Tabla `Summary` con Signal (chip de color) · Integral · Per day · Mean value · Coverage (`días incluidos / días del rango`), con **líneas separadoras verticales entre columnas**. Una cifra y su unidad son *una* columna partida en dos celdas (dígitos a la derecha, unidad a la izquierda), así que la línea va **después de la unidad**: entre `2.988` y `MW·h/d` se leería como dos cifras distintas. Es más ancha que el panel, así que scrollea horizontal con una barra **de tamaño real y siempre dibujada** — una overlay que aparece solo al pasar el mouse no deja ninguna señal de que hay columnas a la derecha — y deja aire debajo para que la última fila no quede pegada al borde.

**La barra superior lleva el resumen, no el texto de los warnings.** Dice qué es: `3 signals totalled over 9.96 d`. Si las señales no cubrieron la misma duración, nombrar una sería afirmar algo falso sobre las otras, así que usa `integralStatusMixed` y apunta al resumen. Cuando hay warnings solo se agrega un puntero corto (`Warning: see the message in the Integral side panel`); el texto completo va en el panel lateral y en el tooltip — es el mismo reparto que ya hacen FFT y Profile.

Warnings implementados: `integralNoData`, `integralAllDiscarded`, `integralUnsorted`, `integralIndexAxis`, `integralAssumedSeconds`, `integralMixedUnits`, `integralUnknownUnits`, `integralUnequalCoverage`, `integralUncovered`, `integralUncoveredInterpolated`, `integralLazyUnsupported`, `integralPieMixedSigns`, `integralPieMixedUnits` — los cuatro idiomas.

`integralUnequalCoverage` es el importante: cuando las señales integran duraciones distintas, las barras dejan de ser comparables y el panel lo dice en voz alta.

---

## 12. Exportación

Desde el **diálogo de exportación** del panel (botón *download*, que en main reemplazó al botón CSV). El modo Integral es el primero con **tres** gráficos, y el diálogo los ofrece los tres:

| Opción | id | Nombre de archivo |
|---|---|---|
| Time series | `time` | `integral_time.png` |
| Bars | `bars` | `integral_bars.png` |
| Pie chart | `pie` | `integral_pie.png` |

Precisiones: **Bars** viene preseleccionado (es el pane en el que el usuario está trabajando); la torta **solo se ofrece si hay una dibujada** —el div existe siempre, y exportar uno vacío devolvería un cuadrado en blanco—; y si todavía no hay ningún total, la opción CSV aparece **deshabilitada con el motivo** (`exportCsvUnavailableIntegral`) en vez de no hacer nada al hacer clic.

El CSV exporta la **tabla de resultados**, no la serie: una fila por señal con `signal, file, value_unit, integral, integral_unit, per_day, per_day_unit, mean, mean_unit, method, missing_policy, range_start, range_end, covered, uncovered, discarded_days, days_in_range, samples`. Las tres magnitudes salen juntas siempre: cuál estaba en pantalla es una elección de visualización, no una propiedad del dato. El valor va **sin escalar** y las marcas de tiempo en ISO — el prefijo del panel sirve para leer un gráfico, no una planilla.

---

## 13. Persistencia, i18n, tests

- Estado del panel completo en la sesión, con `_normalizeIntegralState` tolerante a sesiones viejas; los warnings guardados se descartan al restaurar porque describen un cálculo que todavía no corrió.
- 74 claves × 4 idiomas; `test:i18n-consistency` pasa (1394 claves × 4).
- Las **duraciones se leen igual en todo eje**: el kernel cuenta en unidades de abscisa, así que una señal muestreada en segundos reportaba un `20` pelado donde los mismos 20 s en un eje calendario decían `20 s`. `axisDuration()` convierte primero por la unidad del eje (un eje en horas se convierte, no se lee como segundos) y después las dos usan la misma escalera s/min/h/d. Un eje de índice no tiene unidad y sigue diciendo `samples`.
- Tests nuevos: `test:definite-integral` (80 checks, valores analíticos) y `test:integral-analysis` (223 checks). Son **75** tests de release. `test:mode-toolbar` y `test:session-state` extendidos. **Los 73 tests de `npm run test:release` pasan.**

Verificado además en la app real (Vite + Plotly + DuckDB-WASM):

1. Con el fixture `test-files/csv/integral-missing/04_constant_step_missing_values.csv`: política `zero` → 3840, `interpolate` → 24960, exactamente los valores que documenta el README de esas fixtures.
2. **Paridad eager ↔ lazy** sobre un CSV de 320 000 filas (11 MB) con dos celdas vacías y una hora de filas ausentes, cargado **dos veces** —una por debajo y otra por encima del umbral de `csvFullLoadMb`— y con las dos trazas en el mismo panel. Coinciden dígito a dígito `value`, `covered`, `uncovered`, `gapCount`, `nanSegmentCount`, `dayCount`, `medianDt` y `sampleCount` bajo las cuatro políticas, con `discardIncompleteEnds` y con una selección **no alineada a muestras** (25 %–75 % del dominio) — esto último es lo que prueba que la interpolación en los bordes es idéntica en SQL y en JS.

---

## 14. Arquitectura

| Capa | Archivo | Contenido |
|---|---|---|
| Kernel puro | `src/compute/kernels/definite-integral.js` | La integral definida, las políticas y las duraciones |
| Presentación pura | `src/utils/integral-presentation.js` | Estado, unidades, escala, orden, torta, tabla de exportación |
| Modo (DOM/Plotly) | `src/plots/methods/integral-methods.js` | Chart, selección, panel de opciones |

El corte permite testear todo el comportamiento sin Plotly ni DOM, y garantiza que las barras, la torta, el resumen y el CSV lean **el mismo objeto** — si cada uno formateara los modelos por su cuenta, terminarían discrepando.

---

## 15. Archivos lazy (DuckDB)

**Implementado.** `getDefiniteIntegralByDay` ([`duckdb-source.js`](../src/data/duckdb-source.js)) devuelve **una fila por día UTC y por variable**: área, tiempo cubierto, tiempo de hueco, bandera de hueco, nº de muestras y primer/último timestamp del día. `reduceDailyIntegral` ([`definite-integral.js`](../src/compute/kernels/definite-integral.js)) las pliega en el mismo objeto que devuelve el kernel eager.

El corte es deliberado: **el SQL contesta solo "cuánto y dónde", nunca "cuenta o no"**. Todas las políticas de día —descartar para esta señal, para todas, recortar los extremos— se deciden en JS, con las mismas reglas que aplica el camino eager. Eso es lo que impide que los dos caminos se separen con el tiempo.

Decisiones dentro de la consulta:

- **No se filtra por el rango al escanear.** El paso mediano y el veredicto de huecos son propiedades de la serie entera (es lo que ve `detectSamplingGaps` en eager), y un intervalo que cruza el borde del rango necesita su extremo de afuera para interpolar en el límite. Ambas cosas saldrían mal si se filtraran las filas primero; el recorte se hace por intervalo.
- **La compuerta de paso nominal está replicada en SQL** (mediana, 10 % de tolerancia, 80 % de acuerdo con ≥8 pasos), así que un archivo genuinamente irregular tampoco reclama huecos por el camino lazy.
- `interpolate` empareja **muestras finitas consecutivas** en vez de puentear valores: es exactamente equivalente —los valores puenteados caen sobre la recta que las une, y los trapecios de sus trozos suman el trapecio entero— y cuesta un `WHERE` en lugar de cuatro funciones de ventana.
- **El orden de filas no se juzga.** Un escaneo paralelo devuelve las filas en el orden en que terminan los hilos, así que un `LAG` sobre el orden "físico" reporta desorden que es un artefacto del escaneo: disparó sobre un CSV de 320 000 filas perfectamente ordenado. Se reporta `negativeDtCount: 0` —"no se sabe"— en vez de negarse a calcular. `file_row_number` de `read_csv` es la vía si alguna vez hace falta contestarlo; es la misma postura que ya toma el reductor de buckets lazy.

Sigue sin soportarse: un archivo lazy **sin eje temporal calendario**, y una variable lazy sin columna fuente exacta (derivada solo del overview). Ambos casos producen `integralLazyUnsupported` con el motivo, y ninguna barra.

Mientras la consulta corre, el panel muestra la misma píldora de progreso no bloqueante que usan el FFT y el Profile lazy: las barras anteriores siguen legibles.

---

## 16. Decisiones tomadas sin consultar

| # | Tema | Decisión | Por qué |
|---|---|---|---|
| D1 | Nombre | `Integral` | El tooltip lo distingue de Data Tools → Integral |
| D2 | Métodos | Solo trapezoidal + rectangular | Paridad exacta con Data Tools |
| D3 | Bordes del rango | **Interpolar** | Si no, el total salta al arrastrar la banda |
| D4 | Políticas de faltantes | Las 3 pedidas **+ `interpolate`** | Ya existía en el kernel; omitirla habría creado dos vocabularios |
| D5 | Unidades en leyendas | Todos los modos, unidad efectiva | Un solo constructor de nombres |
| D6 | Alcance del warning de unidades | Las trazas del panel | Es donde los totales se comparan |
| D7 | Formato | `MW·h` | Consistencia con el heatmap. Si preferís `MWh`, es un cambio de una línea |
| D8 | Orden de barras | Implementado en v1 | Salía casi gratis |
| D9 | Torta con signos mixtos | **Ocultar + explicar** | Una torta no puede mostrar cancelaciones |
| D10 | Exportación | Botón CSV de la toolbar | Es el entregable natural del análisis |
| D11 | Integral acumulada superpuesta | No | Ya existe en Data Tools |
| D12 | Dónde van la media y el total por día | En el resumen, el hover y la exportación **siempre**, más un dropdown `Show` que elige cuál dibujan las barras | Pedías "en alguna parte"; separarlas del gráfico las escondería, y ponerlas solo en el gráfico obligaría a elegir |
| D13 | Qué es el "valor medio llano" | El total dividido por la duración integrada, en la unidad propia de la señal | Es el nivel constante que daría la misma área; cualquier otra media (aritmética sobre muestras) daría un número distinto con muestreo irregular |
| D14 | Desorden de filas en lazy | Reportar "no se sabe", no negarse | El chequeo de orden físico da falsos positivos en DuckDB (§15) |
| D15 | Estado con coberturas distintas | `integralStatusMixed`, que apunta al resumen | Afirmar una duración sola sería falso para las otras señales |
| D16 | Puntos o períodos | Checkbox, **default períodos** | Es la convención de PyPSA y la que hace que un día de cuartos de hora sean 24 h; el default cambia números respecto de la v1, a cambio de que la duración reportada sea la integrada (§7) |

---

## 17. Limitaciones conocidas

1. **DST**: heredada de `detectSamplingGaps` — un salto de hora de reloj no se distingue de una hora faltante usando solo el vector de tiempo.
2. **Cambio de tasa sesgado** (fixture 14): la misma limitación que documenta PR #18; el detector es compartido a propósito.
3. **FFT y el checkbox de unidades**: las trazas del espectro muestran la unidad de la fuente, correcta para un espectro de amplitud pero no para PSD.
4. **Lazy sin eje calendario** y variables lazy sin columna fuente exacta (§15).
5. **Orden de filas en archivos lazy**: no se detecta el desorden (§15, D14).
