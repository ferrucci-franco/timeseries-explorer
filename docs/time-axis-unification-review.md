# Revisión técnica adversarial — Time-axis unification

Documento revisado: `docs/time-axis-unification-design.md`

Worktree: `worktree-feature+mixed-xaxis-plot`

Commit revisado: `2f5239d`

## 1. Veredicto general: CON-FALLAS-SERIAS

La dirección conceptual es valiosa —hacer explícito el tiempo transcurrido y separar interpretación de visualización—, pero el documento no es seguro para implementar como está.

Los defectos determinantes son:

- Equipara implícitamente cualquier eje numérico con tiempo transcurrido. El repositorio admite ejes numéricos cuya semántica puede ser coordenada, índice, Unix epoch u otra cantidad.
- La firma propuesta sirve como compatibilidad de render, pero no como elegibilidad común para FFT, heatmap, temporal-profile, correlation y demás modos.
- Dos de los cuatro síntomas no tienen exactamente la causa inmediata que declara el documento.
- El modelo no cubre CF-time no gregoriano, codificaciones absolutas, alta resolución ni el round-trip de todas las unidades existentes.
- La secuencia por fases permitiría introducir campos que los normalizadores y las sesiones descartarían antes de implementar persistencia.

## 2. Citas verificadas

| Cita del documento | Resultado | Evidencia real |
|---|---|---|
| `src/plots/plot-manager.js:2455-2470` | **CONFIRMADA** | El guard compara `_timeKind` y `_timeDisplayMode` en `:2460-2462`; por eso datetime-elapsed y numeric no son compatibles. |
| `src/plots/plot-manager.js:2147-2149, 2185-2187` | **CONFIRMADA** | Ambos caminos de agregado/clonado muestran la alerta de ejes incompatibles. |
| `src/plots/plot-manager.js:2472-2474` | **CONFIRMADA** | El mismo guard se aplica a timeseries, phase2dt, FFT, histogram, heatmap, temporal-profile y correlation. |
| `src/plots/methods/data-methods.js:152-155` | **CONFIRMADA** | `_timeKind` sólo distingue datetime de numeric; incluso los demás casos terminan como numeric. |
| `src/plots/methods/data-methods.js:157-234` | **CONFIRMADA** | Existen los caminos generated-index, duration, calendar y step citados. El step custom debe ser positivo en `:216-218`. |
| `src/plots/methods/data-methods.js:236-242` | **CONFIRMADA CON SALVEDAD** | La función existe, pero un generated-duration devuelve `index`, no una categoría elapsed/duration, en `:239`. |
| `src/plots/methods/data-methods.js:323-346` | **CONFIRMADA** | El datetime elapsed resta el origen; el generated-index usa fila × step y, salvo alta resolución, suma el origen calendario. |
| `src/plots/methods/data-methods.js:264-274, 457-493` | **CONFIRMADA** | Calendar normal usa `type:'date'`; duration y calendar sub-ms usan eje lineal con ticks calculados. |
| `src/plots/methods/data-methods.js:629-659` | **CONFIRMADA** | Títulos y unidades dependen del modo y del origen del eje. |
| `src/plots/plot-manager.js:3162-3199` | **INCORRECTA** | `_mapTimeRangeBetweenModes` empieza en `:3174`, no `:3162`. Su único uso observado es restaurar el `xRange` de un timeseries en `plot-manager.js:175-207`; no implementa “zoom/crop persistence”. El propio UI borra crop/shift al cambiar ciertos modos en `file-methods.js:2833-2837`. |
| `src/app/methods/file-methods.js:2547, 2552-2557, 2798-2859` | **CONFIRMADA** | El modo se deriva directamente de `timeVar.timeKind`; el selector aparece sólo para datetime y los controles de step sólo para index. “Sin controles de modo/reindex” es correcto, aunque numeric sí conserva crop, shift, gain y offset. |
| `src/ui/csv-parsing-preview-dialog.js:39-42` | **CONFIRMADA** | `TIME_FORMATS` contiene únicamente Auto y Custom. |
| `src/ui/csv-parsing-preview-dialog.js:337-410` | **INCORRECTA** | El rango citado termina antes que la función. Con Auto, una columna seleccionada manualmente puede producir `kind:'numeric', strategy:'numeric'` en `:415-445`. Falta una opción explícita “numeric elapsed + unit”, pero “manual time = datetime hard-wired” es falso. |
| `src/parsers/csv-time-detection.js:335-398` | **INCORRECTA COMO EVIDENCIA COMPLETA** | Sí prueba `s→%S`, `SSS→%f` y el anclaje 2001 en `:351-353, 380-391`; no prueba los errores de valores. Esos ocurren en el parser real, `:1214-1273`: `0` no satisface el literal `.SSS` y segundos mayores que 59 son rechazados en `:1271`. |
| `src/parsers/matlab-mat-file.js:657-658` | **INCORRECTA PARA LA AFIRMACIÓN HECHA** | Esos campos están en `metadata`, no necesariamente en la variable temporal. La variable sólo recibe `timeKind` si es datetime en `:628-637`; numeric e index no lo reciben. `_getTimeVar` no fusiona metadata, sólo devuelve la abscisa (`plot-manager.js:3061-3064`). |
| `src/ui/mat-variable-picker-dialog.js:127-130, 425-426` | **CONFIRMADA** | Existe la selección explícita Index y se emite `timeMode:'index'`. |
| `src/parsers/csv-parser.js:151-157, 442-448` | **INCORRECTA PARA “CADA VARIABLE TIENE timeKind”** | Sólo datetime e index asignan `timeVariable.timeKind`; numeric queda sin ese campo (`csv-parser.js:139-160`). |
| `src/parsers/netcdf-parser.js:509-529` | **CONFIRMADA CON ALCANCE LIMITADO** | CF estándar, offsets y strings parseables se convierten a epoch-ms datetime. Los calendarios no gregorianos se excluyen expresamente en `:512` y quedan raw numeric en `:530-532`. |
| `src/parsers/pickle-parser.js:1144-1198` | **CONFIRMADA** | Distingue datetime, range, multi-index, numeric e index y copia los campos de eje a la variable. |
| `src/parsers/pypsa-netcdf-parser.js:261, 286, 313` | **CONFIRMADA** | Cubre strings datetime, CF datetime y fallback index. |
| `src/plots/methods/data-methods.js:190-193, 475-493` | **CONFIRMADA** | Existe el camino especial de calendar generado sub-ms. |
| `src/plots/methods/data-methods.js:471` | **INCORRECTA** | `:471` llama a `_formatElapsedDateTime`; su definición está en `:528-548`. Además ya soporta negativos con prefijo de signo en `:530, 547`. |
| `src/plots/methods/data-methods.js:495+` | **CONFIRMADA** | `_durationTickValues` calcula ticks desde `ceil(min/step)` y funciona con mínimos negativos (`:495-516`). |

## 3. Fallas y supuestos inválidos

### Críticas

1. **“Numeric” no significa “elapsed seconds”.**

   DuckDB elige como tiempo una columna con nombre temporal o, si no existe, la primera columna numérica; cualquier tipo numérico queda como `timeKind:'numeric'` sin unidad ni semántica (`src/data/duckdb-source.js:2456-2475`). El repositorio incluso contiene Unix epoch seconds alrededor de 1.735×10⁹ (`test-files/csv/15_unix_timestamp_seconds.csv:1-5`).

   Asignar por defecto `unit=s, display=seconds` puede reinterpretar una coordenada arbitraria, mostrar epoch como “elapsed” o permitir overlays inválidos. Hace falta distinguir al menos:

   `absolute-datetime | absolute-numeric | elapsed | count | coordinate | unknown`.

2. **La firma `{datetime | elapsed-seconds | count}` no puede ser el único guard para todos los modos.**

   Heatmap exige datetime y calendar explícitamente (`src/plots/methods/heatmap-methods.js:339-365`). Temporal-profile ignora y advierte sobre trazas no datetime (`src/plots/methods/temporal-profile-methods.js:576-590, 635-640`). FFT exige tiempos estrictamente crecientes y uniformes y deriva la unidad de frecuencia del tipo (`src/utils/fft.js:254-299`).

   Se necesitan dos decisiones distintas:

   - `renderSignature`: si dos trazas pueden compartir coordenadas Plotly.
   - `operationCapabilities`: calendar bins, sampling uniforme, unidad física conocida, monotonicidad, etc.

### Altas

3. **Los cuatro síntomas no comparten literalmente una única causa inmediata.**

   - Síntoma 1: la explicación es correcta (`plot-manager.js:2460-2462`).
   - Síntoma 2: existe gating, pero también metadata inconsistente entre OpenModelica, MAT genérico y la variable temporal. OpenModelica delega al parser viejo (`matlab-mat-file.js:327-339`), que no asigna `timeKind` a la abscisa (`mat-parser.js:135-164`).
   - Síntoma 3: falta una aserción explícita con unidad, pero Auto ya acepta una selección manual numeric (`csv-parsing-preview-dialog.js:415-445`).
   - Síntoma 4: intervienen el regex de `s.SSS`, el literal decimal y la validación de segundos de reloj (`csv-time-detection.js:1214-1273`), no sólo la ausencia de elapsed.

4. **El fallback duration+seconds no “cae gratis” del modelo.**

   Cada traza construye su propio hover y customdata según su modo (`data-methods.js:1411-1508`), mientras el layout toma el modo de la primera traza (`:1511-1526`). La actualización de ticks también consulta el archivo primario (`interaction-methods.js:1419-1456`) y la sincronización entre paneles exige modos idénticos (`:1475-1483`).

   Hace falta un `effectivePanelDisplay` y aplicarlo consistentemente a layout, ticks, hover, título, exportación y sincronización.

5. **El orden por fases perdería estado.**

   Hay dos normalizadores separados que sólo conservan los campos legacy (`data-methods.js:99-133`; `file-methods.js:2499-2533`). Si `source`, `unit` u `origin` aparecen antes de actualizar ambos y la sesión, serán eliminados.

   Además, la sesión serializa el transform normalizado (`session-methods.js:187-224`) y lo vuelve a normalizar al restaurarlo (`:700-712`). La versión se valida por igualdad exacta (`:305-315`), por lo que un bump sin migrador rechazaría sesiones v1.

6. **“Cada elapsed usa su propio t=0” es una política de alineación, no sólo compatibilidad.**

   El origen actual puede venir de `timeOriginMs`, metadata, `timeStart` o el primer dato (`data-methods.js:292-309`). Dos series con orígenes distintos pueden superponerse numéricamente y aparentar simultaneidad inexistente. Debe mostrarse y persistirse una política como `per-series-zero` frente a `shared-absolute-origin`.

### Media

7. **El diagnóstico sobre tiempo negativo está desfasado.**

   Duration ya sign-prefija negativos (`data-methods.js:528-548`), genera ticks negativos (`:495-516`) y el parser de crop/shift acepta signos (`:577-609`). Las restricciones reales son step generado positivo (`:181-187, 216-218`) y deltas FFT positivos (`src/utils/fft.js:273-291`): son requisitos de avance/monotonicidad, no de `time >= 0`.

## 4. Huecos del modelo canónico

- **Codificación del valor bruto.** Falta expresar si `values` contiene epoch-ms, Unix seconds, elapsed, MATLAB datenum o una coordenada desconocida. Para datetime actual, elapsed se calcula como `(raw-origin)/1000` (`data-methods.js:323-330`), fórmula ausente del modelo propuesto.

- **CF-time no gregoriano.** `360_day`, `noleap`, `all_leap`, etc. quedan numeric deliberadamente (`netcdf-parser.js:503-532`). `origin.ms + elapsed` con `Date` gregoriano no los representa.

- **Unidades y precisión.** NetCDF acepta microsegundos y nanosegundos (`netcdf-parser.js:24-31`); el step custom acepta ps/ns/us y también semanas/años (`data-methods.js:595-609`). La enumeración `s/ms/min/h/d` no conserva unidad ni round-trip.

- **Alta resolución.** El calendario generado sub-ms mantiene segundos relativos en eje lineal para evitar materializar fechas (`data-methods.js:334-343, 475-493`). Convertir siempre a `absoluteMs` puede perder esa estrategia y precisión. Pickle, además, trunca timestamps BigInt ns a ms actualmente (`pickle-parser.js:499-506`).

- **Excel serial, decimal year y MATLAB datenum.** CSV los convierte explícitamente a epoch-ms (`csv-time-detection.js:1038-1058, 1362-1379`), pero el modelo no tiene una representación de “valor raw convertido a absoluto”. MAT genérico tampoco reconoce automáticamente un datenum.

- **Unknown/raw coordinate.** Debe existir un estado conservador que no habilite duration/calendar/FFT-Hz hasta que parser o usuario afirme semántica temporal.

- **Source seleccionado frente a source disponible.** Cambiar a index no debería destruir la referencia al eje original. Conviene separar `availableSources` de `selectedSource`.

## 5. Riesgos de implementación y tests

Riesgos adicionales:

- Un cambio de transform reconstruye paneles pero no vuelve a comprobar compatibilidad de las trazas ya mezcladas (`plot-manager.js:175-207`).
- Hover cross-file todavía rechaza numeric↔elapsed (`data-methods.js:804-823`).
- Las consultas lazy filtran en unidades raw (`duckdb-source.js:513-525`); unidad/origen deben traducirse en ambos sentidos.
- Derivadas e integrales usan delta datetime/1000 o numeric raw, ignorando una futura unidad canónica (`data-tools-methods.js:1020-1043`).
- Live Update sólo compara `metadata.timeKind` (`live-update-methods.js:726`).
- Export CSV usa el tiempo de la primera traza para todas las columnas salvo `independentIndex` (`plot-manager.js:1938-1965`), lo que es peligroso al ampliar overlays.
- Al pasar de duration a seconds deben limpiarse `tickmode/tickvals/ticktext`; el helper de relayout sólo emite propiedades presentes (`data-methods.js:276-281`).

Tests existentes que deberían correrse y extenderse:

- Parsers: `test-csv-fixtures.mjs`, `test-csv-to-parquet-core.mjs`, `test-excel-parser.mjs`, `test-matlab-parser.mjs`, `test-generic-netcdf-parser.mjs`, `test-pickle-parser.mjs`, `test-pypsa-netcdf-parser.mjs`, `test-parquet-pandas-metadata.mjs`, `test-parquet-loading-mode.mjs`.
- Render/transform: `test-calendar-axis.mjs`, `test-calendar-heatmap.mjs`, `test-file-transform-reset.mjs`, `test-mode-toolbar.mjs`, `test-timeseries-stack.mjs`, `test-histogram.mjs`, `test-phase2d.mjs`.
- Análisis/lazy: `test-fft.mjs`, `test-correlation.mjs`, `test-correlation-lazy.mjs`, `test-temporal-profile.mjs`, `test-temporal-profile-lazy.mjs`, `test-lazy-phase-logic.mjs`, `test-data-tools.mjs`, `test-missing-data.mjs`, `test-missing-lazy.mjs`, `test-regression*.mjs`.
- Persistencia: `test-session-state-roundtrip.mjs`, `test-session-project-save.mjs`, `test-pypsa-session.mjs`, `test-live-update-logic.mjs`.

Casos nuevos imprescindibles:

- Numeric desconocido no se interpreta automáticamente como segundos.
- Unix epoch seconds frente a elapsed seconds.
- s/ms/us/ns convergen al mismo rendered elapsed.
- Orígenes diferentes y ambas políticas de alineación.
- Transformar una traza después de agregarla revalida el panel.
- duration+seconds en ambos órdenes de traza, incluidos hover/export/ticks.
- Negativos, sampling no uniforme y FFT.
- CF `360_day`/`noleap`.
- MAT index/numeric con metadata en la variable.
- Migración de sesión v1 y round-trip de todos los nuevos campos.
- Eager y lazy producen exactamente el mismo eje.

Muestra ejecutada sin modificar archivos: pasaron `test:csv`, `test:matlab`, `test:netcdf`, `test:pickle` y `test:calendar-axis`. `test:session-state` no pudo completarse porque el worktree no contiene `node_modules/fflate/esm/browser.js`; además informó que faltaba el fixture git-ignored de bench.

## 6. Correcciones concretas al documento

1. Reemplazar `CanonicalTimeAxis` por un modelo que separe:

   - `semantic: absolute | elapsed | count | coordinate | unknown`
   - `encoding: epoch-ms | unix-s | excel-serial | matlab-datenum | cf-time | raw`
   - `scaleToSeconds` o unidad ampliada
   - `calendarId`
   - `availableSources` y `selectedSource`
   - `alignmentPolicy`

2. Cambiar el default: sólo fuentes explícitamente detectadas o afirmadas como elapsed reciben `display=seconds`. Un numeric desconocido conserva `display=raw` y firma incompatible.

3. Separar `renderSignature` de los requisitos de cada operación. No reutilizar una firma única como guard de heatmap/FFT/temporal-profile.

4. Definir formalmente `effectivePanelDisplay`, incluyendo limpieza de ticks, hovers, títulos, export y sincronización.

5. Corregir las afirmaciones factuales:

   - CSV: “falta una opción explícita numeric elapsed”, no “manual siempre datetime”.
   - Citar `csv-time-detection.js:1214-1273` para los fallos de `s.SSS`.
   - Citar `_mapTimeRangeBetweenModes` desde `:3174` y describirlo sólo como restauración de vista.
   - Citar `_formatElapsedDateTime` en `:528-548` y reconocer soporte negativo existente.
   - Distinguir metadata de parser de campos presentes en la variable.

6. Reordenar las fases: modelo compartido + adapters legacy + normalizadores + migración de sesión deben aterrizar juntos. Sólo después deben habilitarse menú, conversión de unidades y overlays. Export, lazy queries, data tools y análisis no pueden posponerse como “homogenización” final.

7. Limitar inicialmente el alcance de overlay a timeseries/phase2dt con elapsed explícito. Habilitar los demás modos cuando tengan contratos y pruebas específicos.

## Estado de la revisión

La revisión no modificó código del producto ni el documento de diseño original. Este archivo se añadió únicamente para que la evaluación pueda ser consumida por Claude Code u otras herramientas.
