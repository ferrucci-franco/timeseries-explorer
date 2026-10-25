# Agregación por período calendario — Profile "Multi-year" + Integral "Group by"

> Estado: **implementado**.
> Motivación: una serie de precipitación en mm de muchos años. Dos preguntas distintas que antes no tenían respuesta: *¿a qué nivel estuvo cada año?* y *¿cuánta lluvia acumuló cada año?*

---

## 1. El reparto

Las dos preguntas no son la misma y no se contestan en el mismo análisis:

| Pregunta | Operación | Dónde vive |
|---|---|---|
| ¿A qué **nivel** estuvo cada año? | media | **Temporal profile → período `Multi-year`** |
| ¿Cuánto **acumuló** cada año? | integral definida | **Integral → `Group by: Year`** |

El Temporal profile sigue mostrando **siempre la media** (más ±1σ): es lo que su eje Y declara y lo que su arquitectura calcula — una media por sub-período, y después media y desviación entre esas medias. Meterle una integral habría significado dos magnitudes incompatibles en un mismo panel, con la misma etiqueta de eje y unidades distintas. La integral por período se agregó al análisis que *ya* es una integral.

---

## 2. Profile: el período `Multi-year`

`day` … `year` **pliegan** la grabación sobre un período plantilla: todos los eneros del archivo caen sobre el mismo enero. `multi-year` es el único período que **no pliega**.

- **Bins** = los años calendario que abarca el rango (UTC), sobre la línea de tiempo real.
- **Sub-período** = el día UTC.
- Cada bin lleva la **media de las medias diarias** de ese año, y `±1σ` mide cuánto difirieron los días dentro del año.
- `Coverage` por bin = días con dato / días del año presentes en el archivo.
- "Discard incomplete" descarta **días** (el sub-período), y la etiqueta lo dice.
- No hay control de `Resolution`: los bins son años. El panel muestra `1 year (per calendar year)` en lugar de un dropdown deshabilitado.

### 2.1 Por qué el día como sub-período

Un bin cuyo valor fuera la media directa de las muestras del año recibiría `n = 1` período y, por lo tanto, **σ nula**: el modo `±1σ` quedaría sin banda y el hover sin desviación. Con el día como sub-período, el bin conserva la regla que el módulo documenta en su cabecera ("una media por período/bin, después media y σ entre esas medias") y la banda pasa a significar algo concreto: la dispersión día a día dentro del año. Además un día densamente muestreado no pesa más que uno disperso.

### 2.2 Geometría y memoria

Los bins de `multi-year` dependen de los datos, no del período, así que hay que medir el span antes de poder binear: [`scopeSpanMs`](../src/utils/temporal-profile.js) recorre los timestamps en rango (o acepta un span explícito, que es por donde entra el camino lazy). `multiYearBinEdges` es la **única** función que decide qué años hay, y la comparten el kernel eager y el reductor SQL — si cada uno los derivara, podrían diferir en un año y la paridad se rompería en silencio.

Un día pertenece a exactamente **un** año, de modo que cada período necesita **una sola ranura** de acumulación en lugar de `binCount`. Sin eso, treinta años de datos diarios reservarían ~11 000 períodos × 30 bins × 4 arrays tipados: megabytes de ceros. El recorte se expresa con el mecanismo de bins **estructurales** que ya existía para los meses cortos y para el 29 de febrero: para un día, todo bin que no sea su año es estructural, y por eso `nExpectedPeriods` es la cantidad de días *de ese año* y no del registro entero.

### 2.3 El eje X

Los bins plegados llevan horas **relativas** al período plantilla (0…24 h, 0…168 h, …). Los de `multi-year` llevan horas **absolutas** de época, porque están sobre la línea de tiempo real. El resultado lo declara (`absoluteBins: true`) y nombra los años (`binYears`), que es lo que permite al eje poner una marca por año en el centro de su bin en lugar de un número de horas que no significa nada. El hover muestra `Year = 2019`, no `x = 429528`.

### 2.4 Camino lazy (DuckDB)

Mismo corte que el resto del Profile lazy: el período SQL es el día (`periodSql`), el índice de bin es `year(t) - firstYear` y el filtro estructural es `bin_idx = year(period_start) - firstYear`. El span sale de `MIN(t)/MAX(t)` de la consulta de estadísticas — que **ya aplica la selección** —, no de los bordes de la banda: una banda abierta en 2017 sobre un archivo que empieza en 2019 no debe hacer crecer dos bins vacíos. `scripts/test-temporal-profile-lazy.mjs` compara eager contra lazy incluyendo ese caso.

---

## 3. Integral: `Group by`

`Group by: none | day | week | month | year` integra **cada período calendario por separado** en lugar del rango entero de una vez.

- El gráfico pasa a **una columna por período y un color por señal** (`barmode: 'group'`), con leyenda, porque el color es lo único que nombra la señal.
- El eje de categorías se titula `Period`; el eje de valores mantiene la magnitud elegida (`Total` / `Per day` / `Mean value`).
- `Order` queda deshabilitado: las columnas son una línea de tiempo y ordenarlas por tamaño destruiría lo único que una línea de tiempo aporta.
- La torta, si se pide, muestra la **parte que cada período se llevó de UNA señal**. Con dos señales serían dos "todos" en una torta, y se oculta explicando por qué.
- El valor impreso sobre cada barra **omite la unidad** (ya está en el eje) y desaparece por encima de 24 columnas: a 365 columnas los números dejan de ser una lectura y pasan a ser una textura.
- El resumen lista un bloque por señal: sus períodos en orden calendario y, al final, el **total del rango entero** que suman. Más de 200 filas por señal se cortan y remiten al CSV.
- La exportación agrega las columnas `group`, `period`, `period_start`, `period_end`, con una fila por señal y período más la fila del total.

### 3.1 La identidad que sostiene todo

**Agrupar no cambia el total.** El kernel ya honra sus bordes de rango al milisegundo, interpolando el valor en un borde que cae entre dos muestras; integrar ventanas consecutivas que comparten su borde vuelve a sumar la integral del tramo completo. `scripts/test-definite-integral.mjs` verifica Σ(grupos) = total y Σ(duración cubierta) = duración cubierta para `year/month/week/day` × `trapezoidal/rectangular` × `extendLastSample on/off`, con tolerancia 1e-12.

Tres cosas hacen falta para que la identidad se cumpla:

1. **Las ventanas se dejan enteras en los extremos** cuando el rango es la extensión propia de los datos, y se **recortan** cuando el usuario arrastró la banda. Una banda significa exactamente lo que dice; la extensión de los datos es solo donde las muestras se terminan. Dejar entera la última ventana es además lo que le deja lugar al período final que `extendLastSample` le concede a la última muestra.
2. **El paso nominal de la serie se pasa hacia abajo** (`nominalStep`). Un día de una serie horaria, ya recortado, tiene dos muestras: no puede establecer un paso propio (`detectSamplingGaps` necesita ≥3) y, si cada ventana decidiera por su cuenta, leería sus filas faltantes distinto del total sin agrupar — las partes dejarían de sumar el todo. Con el paso heredado, los huecos se juzgan con el mismo umbral 1.5× en todas partes.
3. **Cada ventana se lee con una muestra vecina de cada lado** (`_integralSeriesForTrace`), que es lo que hace que el kernel interpole en el borde del período *y* que el período final de una ventana intermedia quede suprimido: su última muestra no es la última de la serie.

### 3.2 Camino lazy

Sin consulta nueva: `getDefiniteIntegralByDay` ya devuelve una parcial por día UTC, y **todo período de agrupación es un número entero de días UTC**, así que agrupar es una partición de esas parciales (`groupDailyIntegralEntries`) y `reduceDailyIntegral` se aplica por grupo con los mismos parámetros. La única corrección: solo el período que contiene el último día muestreado puede extender esa muestra a su paso siguiente; hacerlo en cada período inventaría un paso de área por período.

### 3.3 Límites

- `Group by` necesita **eje calendario**; con eje índice o numérico los períodos quedan deshabilitados (no hay calendario que inventar).
- Tope de **2000 períodos** (`INTEGRAL_MAX_GROUPS`). Por encima, el panel avisa con el motivo y no dibuja: veinte años por día son 7300 columnas de dos píxeles, y la respuesta honesta es decir que la agrupación es demasiado fina.
- Las semanas abren el **lunes** (igual que en el Profile) y se etiquetan por la fecha de ese lunes. Un número ISO de semana sería más corto y también nombraría un año distinto del año calendario de su lunes uno de cada siete años.
- Si la última pasada rechazó la agrupación, la vista muestra lo que **se calculó**, no lo que el control dice: el panel no puede afirmar columnas que ningún kernel produjo.

---

## 4. Arquitectura

| Capa | Archivo | Qué se agregó |
|---|---|---|
| Kernel profile | `src/utils/temporal-profile.js` | `multi-year`, `multiYearBinEdges`, ranura única por período |
| SQL profile | `src/data/temporal-profile-sql.js` | geometría `multi-year`, bin por año, filtro estructural |
| Kernel integral | `src/compute/kernels/definite-integral.js` | `calendarPeriodWindows`, `utcPeriodStart/End`, `groupDailyIntegralEntries`, `nominalStep` |
| Presentación integral | `src/utils/integral-presentation.js` | `groupBy`, `series`/`categories`, etiquetas de período, exportación agrupada, compuerta de torta |
| Modos (DOM/Plotly) | `temporal-profile-methods.js`, `integral-methods.js` | controles, ejes, resumen, estado |

Tests:

| Archivo | Qué cubre |
|---|---|
| `scripts/test-definite-integral.mjs` | Bordes de período UTC, ventanas, Σ(grupos) = total (eager y lazy), el paso heredado |
| `scripts/test-integral-analysis.mjs` | Estado, series/categorías, exponente compartido, torta, exportación agrupada, cableado |
| `scripts/test-temporal-profile.mjs` | Kernel `multi-year`, geometría, σ entre días, y el reductor SQL sin DuckDB |
| `scripts/test-temporal-profile-lazy.mjs` | Paridad eager/lazy contra DuckDB real (requiere el módulo nativo; corre en CI) |
| `scripts/e2e-calendar-periods.mjs` | El navegador real: controles, columnas por año/mes/día, ejes, resumen, perfil multianual (`npm run e2e:calendar-periods`) |
