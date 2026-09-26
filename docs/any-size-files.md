# Archivos de cualquier tamaño: qué falta y cómo cerrarlo

**Estado: estudio, sin implementar.** Continúa `docs/file-size-limits.md`.
Aquel documento estudió los *límites*; este estudia lo que la pregunta de fondo
pedía en realidad: *que la herramienta lea archivos de cualquier tamaño*. Todo lo
que afirma sobre el código fue verificado en la fuente; lo que es propuesta está
marcado como tal.

---

## 1. Qué significa "cualquier tamaño"

La pregunta que lo originó fue *"¿podría leer un CSV de 5 GB entero, sin
lazy?"*. La respuesta corta a esa pregunta literal está en la sección 3 y es no.
Pero la pregunta literal no es la que importa. "Leer cualquier tamaño" son tres
cosas distintas, y hoy la app cumple una y media:

1. **Abrir** un archivo de cualquier tamaño. Para CSV y Parquet ya es cierto: el
   camino lazy los abre sin materializarlos, y lo único que crece con el tamaño
   es el tiempo de cada consulta. Para MAT, Excel, pickle, netCDF y audio no es
   cierto, y no puede serlo por la vía eager (sección 3).
2. **Que todas las funciones trabajen sobre el archivo completo** aunque esté
   abierto en lazy. Hoy no: en lazy, las herramientas de datos están
   deshabilitadas salvo una, la FFT tiene tope, la exportación escribe el
   resumen y el proyecto no se guarda (sección 2).
3. **Que el resultado también pueda ser de cualquier tamaño**: la derivada de
   una señal de 200 millones de muestras tiene 200 millones de muestras, y
   tiene que vivir en algún lado que no sea la RAM.

Este documento es sobre 2 y 3. La tesis: la pieza que falta no es "eager más
grande" sino **un lector de columnas por trozos**, y sobre él, una estrategia
por herramienta. El blueprint de optimización ya lo nombra
(`docs/optimization-blueprint.md`, §2.5, "unified column source"); aquí se le da
forma y se recorren los consumidores uno por uno.

---

## 2. Lo que el camino lazy hace y no hace hoy

Verificado en `src/data/duckdb-source.js`, `src/app/methods/data-tools-methods.js`,
`src/app/methods/session-methods.js` y `src/plots/methods/fft-methods.js`.

### Lo que hace

- **Abre como `VIEW`** sobre `read_csv` / `read_parquet` (`_loadIntoLegacy`).
  Nada se materializa en el heap de WASM. El resumen que ve el usuario es un
  **muestreo reservoir de 10 000 filas** (`overviewPoints`), y en VIEW mode ni
  siquiera se cuenta el total de filas para CSV — `totalRows` queda `null` a
  propósito, porque contar es un escaneo completo.
- **Consultas por ventana**: `getColumnsRange` (min/max por bucket, ~4 000
  puntos) para dibujar; `getRawColumnsRange` (filas crudas, `LIMIT maxRows`,
  **sin `ORDER BY`**: orden físico del archivo, porque ordenar millones de filas
  es lo que agota la memoria de DuckDB-WASM) para la FFT y la fase.
- **Análisis exactos empujados a SQL**, sin traer filas a JS: heatmap
  calendario, integral definida por día, perfil temporal, trayectoria de fase,
  correlaciones por pares, intervalos faltantes, `countOutOfBounds`. Es el
  patrón que este documento extiende.
- **Una herramienta de datos**: *quitar outliers por cotas*. No como array: como
  **expresión SQL** (`_lazyDataToolDefinition` → `_duckdbDataTool`,
  `_duckdbCol`), una columna virtual que cada consulta por ventana evalúa. Cero
  memoria, exacta, y sobrevive a recargas porque es una definición.
- **Streaming real desde DuckDB**: `_interactiveQueryUnlocked` usa
  `conn.send(sql)` y obtiene un `RecordBatchReader` — DuckDB produce el
  resultado por lotes. Lo que hoy lo desaprovecha es la línea siguiente:
  `reader.readAll()` junta todos los lotes en una tabla Arrow antes de devolver.
  **La mitad del lector por trozos ya existe**; falta iterar el reader en lugar
  de vaciarlo.

### Lo que no hace, con las palabras exactas que ve el usuario

| Función | En lazy | Cadena |
|---|---|---|
| Herramientas de datos (derivada, integral, media móvil, picos, relleno, detrend, filtro, remuestreo) | deshabilitadas (`_syncDataToolPickerOptions`) | *"Data tools are disabled for lazy DuckDB-backed files. Load an eager file to edit signal values."* |
| Outliers, métodos que no son cotas (picos, IQR) | deshabilitados | *"Lazy files use hard bounds and replace out-of-bounds values with NaN."* |
| Derivadas del eje de tiempo (`index`, `delta`) | calculadas **sobre el overview**, no exactas (`derived-methods.js`, comentario en la cabecera) | — |
| FFT | filas crudas hasta `_fftHardMaxNfft` vía `getRawColumnsRange` | *"Selection is too large for FFT (live limit {live} NFFT; hard limit {hard})"* |
| Exportar CSV | escribe las trazas del panel — para lazy, el resumen (`_exportCSV` → `_appendTimeseriesExportColumns`; el blueprint lo señala en §1.6) | — |
| Guardar proyecto | rechazado | *"A complete project cannot be saved while these files are using memory-saving mode. Increase their full-load limit in Settings and reload them, or save a view instead"* |

La última cadena merece una nota: para un CSV de 5 GB, "subí el límite y
recargá" es un consejo que no se puede seguir (sección 3). El mensaje describe
un mundo donde lazy es una preferencia; para archivos grandes es la única
opción, y el proyecto debería poder guardarse igual (sección 6).

### Lo que cuesta, en CSV, que no se ve

Una `VIEW` sobre `read_csv` **no tiene índice**. Cada consulta por ventana —
cada zoom — vuelve a escanear el archivo entero desde el disco. Para 500 MB es
imperceptible; para 5 GB son decenas de segundos por zoom; para 50 GB, minutos.
No es un problema de memoria sino de tiempo, y no tiene arreglo dentro del CSV.
Parquet lo tiene: estadísticas por *row group* → *predicate pushdown* → un zoom
lee solo los grupos que caen en la ventana. La app ya ofrece la conversión
(nativa en escritorio, en WASM en la web) antes de abrir un texto grande.
"Cualquier tamaño" para CSV es, honestamente, **"cualquier tamaño, y convertí a
Parquet cuando el zoom empiece a doler"**. Este documento no cambia eso.

---

## 3. Por qué "eager de 5 GB" no es la respuesta

Resumen de lo verificado en `_parseFile`:

- El camino eager hace `CREATE TABLE … AS SELECT * FROM read_csv(…)`: la tabla
  entera dentro del heap de WASM, que es un espacio de 4 GiB (medido en el
  binario, `docs/file-size-limits.md` §Addenda). Un CSV numérico de 5 GB son
  ~500 M valores ≈ 4 GB de tabla: no entra. DuckDB devuelve OOM.
- El respaldo es el parser JS antiguo, que lee el archivo como **un string**:
  tope de V8 medido en 536 870 888 caracteres (~512 MiB).
- Aunque se reescribiera el camino eager para no crear la tabla (es posible:
  `VIEW` + lotes → `Float64Array`), el resultado son ~4 GB de columnas más una
  columna igual por cada herramienta aplicada. Con 16 GB de RAM es posible y
  justo; y cada función seguiría dependiendo del tamaño: exportar, guardar,
  FFT.

La conclusión no es "no se puede" sino "no es por ahí". Lo que escala es
**mantener el archivo en lazy y hacer que cada función sepa trabajar por
trozos**.

---

## 4. La pieza que falta: un lector de columnas por trozos

### Contrato (propuesta)

```js
// src/data/column-stream.js  (nombre tentativo)
for await (const chunk of streamColumns(data, varNames, options)) {
    // chunk = { x: Float64Array, yByVar: Map<name, Float64Array>, rowStart, last }
}
```

- `options`: `{ t0, t1, chunkRows = 262144, signal }`. Rango opcional; por
  defecto, todo.
- **Lazy**: la misma consulta que `getRawColumnsRange` (proyección, `t`, sin
  `ORDER BY`), pero iterando el `RecordBatchReader` de `conn.send()` en vez de
  `readAll()`. Memoria en JS: un lote a la vez. Cancelación: el `signal` que
  `_interactiveQuery` ya honra.
- **Eager**: trocear el `Float64Array` que ya está en memoria. Los consumidores
  no distinguen un origen del otro; es lo que permite escribir cada herramienta
  una sola vez.
- **Longitud desconocida**: en VIEW mode `totalRows` es `null`. Los consumidores
  no pueden preasignar; acumulan en trozos crecientes o hacen dos pasadas. Un
  `COUNT(*)` previo es un escaneo completo — aceptable si el consumidor va a
  hacer varias pasadas de todas formas.
- **Orden**: físico, no temporal. Es la misma apuesta que `getRawColumnsRange` y
  `getPhaseTrajectory` ya hacen, con la misma red: la compuerta de monotonía de
  la FFT. Un consumidor que necesite orden temporal estricto lo comprueba sobre
  la marcha (`x[i] >= x[i-1]`) y se detiene con un mensaje si no se cumple.

### Un detalle de concurrencia que no es menor

`_withConnectionLock` serializa las consultas sobre **una** conexión. Un stream
que recorra 5 GB tiene el lock durante minutos, y mientras tanto ningún zoom
responde. Dos salidas: ceder el lock entre lotes (cada lote es una consulta
`LIMIT/OFFSET` — caro sobre CSV, que re-escanea), o **una segunda conexión de
DuckDB para trabajos largos**, que duckdb-wasm permite. La segunda es la
correcta; la primera es lo que se haría si no existiera.

### Pruebas

Mismo patrón que `scripts/test-missing-lazy.mjs`: los constructores de SQL como
funciones puras (como `missing-buckets-sql.js`) probados con DuckDB nativo
(`runDuckDb` de `csv-to-parquet-core.js`), y la iteración por lotes probada con
un CSV generado (`scripts/gen-*-large-csv.py` ya existen) contra la lectura
eager del mismo archivo: paridad valor a valor.

---

## 5. Los consumidores, uno por uno

Lo que cada herramienta necesita del *vecindario* de una muestra decide cómo
puede correr sobre trozos. Tres familias:

- **Puntual**: cada salida depende solo de su entrada. Se expresa en SQL como
  columna virtual (el modelo de `_lazyDataToolDefinition`) y no cuesta memoria.
- **Ventana o estado**: cada salida depende de ±*k* vecinos o de todo lo
  anterior. Corre sobre el stream con **solape** de *k* filas entre trozos, o
  con **estado** que se lleva de un trozo al siguiente. El kernel existente se
  reutiliza; lo nuevo es el ejecutor que corta, solapa y pega.
- **Global**: necesita toda la serie a la vez (o un agregado de toda la serie
  antes de empezar). Dos pasadas, o materialización.

| Herramienta (kernel) | Vecindario | Estrategia | Nota |
|---|---|---|---|
| Outliers por cotas (`detectBoundsOutliers`) | puntual | SQL, **ya hecho** | — |
| Derivada (`computeDerivative`) | ±1 (centrada), 1 (diferencia) | SQL `LAG`/`LEAD` como columna virtual; o stream con solape 1 | La SQL es exacta y no materializa nada. Δt = 0 y no finitos: replicar la semántica del kernel en el `CASE`. |
| Media móvil (`computeMovingAverage`) | ventana *w* | stream con solape *w*; o SQL `AVG() OVER (ROWS BETWEEN l PRECEDING AND r FOLLOWING)` | El kernel salta no finitos con una suma corrida cuyo orden de operaciones se preservó a propósito; la SQL no es bit-exacta. Stream para paridad, SQL para cero memoria. |
| Integral (`computeIntegral`) | estado (acumulado) | stream con estado | `SUM() OVER (ROWS UNBOUNDED PRECEDING)` es posible pero cada zoom re-escanea desde el inicio del archivo: correcto y lento. |
| Picos (`detectSpikeOutliers`) | ventana `half` | stream con solape `half` | `scanSpikeCandidates` ya trabaja con una ventana ordenada incremental; solo hay que alimentarla por trozos. |
| Outliers IQR (`detectIqrOutliers`) | global (cuantiles) | dos pasadas: `quantile_cont` en SQL, luego predicado puntual en SQL | Termina siendo una columna virtual. |
| Detrend media / lineal / polinomio (`computeDetrend`) | global (ajuste) + puntual (aplicar) | dos pasadas: agregados o ajuste por mínimos cuadrados sobre el stream; aplicar como SQL | El ajuste polinómico acumula momentos por trozo: una pasada. |
| Detrend por media móvil / primera muestra | como media móvil / puntual | idem | — |
| Filtro IIR hacia adelante (`applyFilter`) | estado | stream con estado | Los modos de arranque (`steady`, `zero`, `level`, `past`) se resuelven con el primer trozo. |
| Filtro IIR de fase cero | dos pasadas, la segunda **al revés** | stream de ida al *sink*; segunda pasada leyendo el sink en orden inverso | Leer un CSV al revés en SQL es `ORDER BY t DESC` = sort completo. Por eso la segunda pasada lee el resultado de la primera, no la fuente. |
| Rellenar faltantes (`fillMissingValues`) | vecinos a ambos lados del hueco | stream con solape acotado por el hueco más largo | Si un hueco supera un trozo, el ejecutor extiende el solape para ese hueco. Los 7 métodos son locales (`data-tool-sampling.md` §2). |
| Remuestreo (`runResample`) | bucket (estado en el borde) | stream con estado; o SQL `GROUP BY floor(t/Δt)` | Precedente: *Resample* ya produce **un archivo nuevo**. La semántica de huecos del kernel (§4 de `data-tool-sampling.md`) no es trivial en SQL; stream para paridad. |
| Correlación cruzada (`runCrossCorrelation`) | global (FFT de ambas) | materializar con presupuesto, o tope como la FFT | Otro estudio si hace falta. |
| FFT | global por definición | tope actual (`_fftHardMaxNfft`), correcto | Para series enormes la respuesta es otra (Welch por trozos), no "más memoria". |
| Exportar CSV/Parquet exacto | puntual | stream → *sink* | Blueprint §2.5. Cierra el defecto de exportar el resumen. |
| Guardar proyecto | — | guardar la **definición**, no los bytes (sección 6) | — |

---

## 6. Dónde vive el resultado: el *sink*

Un resultado de cualquier tamaño necesita tres destinos, elegidos por tamaño:

**(a) Columna virtual SQL.** Cero memoria, exacta, sobrevive a recargas.
Extiende `_lazyDataToolDefinition` de "solo cotas" a toda la familia puntual y
a las ventanas pequeñas expresables (derivada, media móvil si se acepta la
no-paridad, IQR tras la pasada de cuantiles, detrend tras el ajuste). Es el
destino por defecto siempre que exista.

**(b) `Float64Array` en memoria, con presupuesto.** Cuando la salida cabe (por
ejemplo, `filas × 16 bytes` por debajo de un umbral configurable), la variable
nueva es eager aunque el archivo siga lazy. Es la integración más delicada:
hoy `variables[]` de un archivo lazy mezcla overview y `_duckdbCol`, y el
manejador de ventana del plot pide todo por SQL. Una variable "materializada
completa" tiene que servirse desde JS (un `slice` por tiempo, que exige el eje
ordenado — de nuevo la comprobación de monotonía) sin que el resto del panel se
entere. Requiere tocar `plot-manager.js` donde se decide lazy/eager por traza.

**(c) Parquet en disco, y reabrir lazy.** Para todo lo que no cabe. DuckDB-WASM
puede escribir Parquet desde columnas JS sin dependencias nuevas:
`insertArrowTable` (la app aún no lo usa) + `COPY … TO 'x.parquet'` +
`copyFileToBuffer` — el mismo camino que `_convertToParquet` ya recorre para
CSV. En escritorio, DuckDB nativo escribe directo a disco
(`omvDesktop.convertToParquet` existe). El resultado se abre como otro archivo
lazy, con lo que **cualquier herramienta sobre cualquier tamaño produce algo
de cualquier tamaño**, y el ciclo cierra. El precedente en la app es el
remuestreo, que ya crea "un archivo nuevo"; y en la web, donde no hay disco
propio, el archivo nuevo es una descarga que el usuario vuelve a abrir.

**El proyecto** es el caso (a) llevado al archivo entero: para un archivo lazy,
guardar la *ruta o handle*, el perfil CSV, las transformaciones y las
herramientas como definiciones, en vez de los bytes. El blueprint dice lo mismo
de los detectores (§2.6: "store the config, not the trained model"), y los
data tools lazy ya viajan así en la sesión (`_duckdbDataTool`). Lo que cambia
es que el `.zip` deja de prometer autocontención para esos archivos y lo dice:
"este proyecto referencia `results.csv`; volvé a elegirlo si se movió", que es
exactamente lo que el diálogo de recarga ya sabe hacer
(`_promptForReloadReselect`).

---

## 7. Plan por fases

En orden de valor visible por esfuerzo:

| Fase | Qué | Costo | Riesgo |
|---|---|---|---|
| 1 | `streamColumns` (lazy por lotes del reader; eager por `slice`), segunda conexión para trabajos largos, pruebas de paridad con DuckDB nativo | 1–2 días | bajo: no cambia nada visible |
| 2 | **Exportación exacta** para lazy sobre el stream (CSV; Parquet vía `COPY` directo) | 1 día | bajo; cierra el defecto §1.6 del blueprint, visible al usuario desde el primer día |
| 3 | Herramientas puntuales y de ventana como **columnas virtuales SQL**: derivada, IQR, detrend (tras su pasada de agregados) | 1–2 días + paridad eager/lazy por herramienta | medio: semántica de no finitos y Δt = 0 |
| 4 | **Ejecutor por trozos** con solape/estado para los kernels JS (integral, media móvil, picos, IIR, relleno, remuestreo) y los sinks (b) y (c) | 1–2 semanas | alto: es la integración con `plot-manager` y la escritura Parquet |
| 5 | Proyecto por definición para archivos lazy | 2–3 días | medio: formato de sesión, compatibilidad hacia atrás |
| 6 | Formatos eager-only → Parquet (Excel ya; MAT, pickle, netCDF no). MAT por variable en lazy es otro estudio: el formato lo permite (cada variable es un elemento con desplazamiento conocido), el lector actual no | por formato | — |

Las fases 1–3 son autónomas y baratas, y dejan la app con exportación exacta y
tres herramientas más en lazy sin materializar un solo array. La 4 es la
inversión grande y la que realmente cumple "cualquier tamaño → cualquier
herramienta → cualquier resultado".

---

## 8. Riesgos y decisiones abiertas

- **Orden físico ≠ orden temporal.** Toda la sección 5 asume que el archivo está
  ordenado por tiempo, como ya lo asumen `getRawColumnsRange` y la fase. Un
  archivo desordenado se detecta sobre la marcha y se rechaza con mensaje; no
  se ordena, porque ordenar es lo que no cabe.
- **Paridad numérica SQL/kernel.** Las sumas flotantes en distinto orden no dan
  el mismo bit. Donde importe (media móvil, remuestreo), stream con el kernel;
  donde no (derivada, cotas, cuantiles), SQL. La prueba de paridad es por
  herramienta y con tolerancia declarada.
- **CSV re-escanea por consulta.** El stream lo paga una vez por pasada; las
  columnas virtuales lo pagan en cada zoom. Para archivos donde eso duela, el
  mensaje correcto es la conversión a Parquet, que ya existe.
- **`totalRows` desconocido** en VIEW mode. Preasignar exige un `COUNT` (un
  escaneo); acumular exige trozos crecientes (2× transitorio). Decisión por
  consumidor.
- **Presupuesto del sink (b).** Un número en Ajustes, en MB, con el mismo
  espíritu de "0 = nunca en memoria, siempre a Parquet" que la Opción A dio a
  los avisos. No hay que inventarlo ahora.
- **La web no tiene disco.** El sink (c) en el navegador es una descarga.
  Aceptable para exportar; incómodo para "aplicá una integral y seguí
  trabajando". En escritorio no hay fricción. Es una razón más para que la
  versión de escritorio sea la de los archivos grandes, y para que la ayuda lo
  diga.

---

## 9. Preguntas para decidir antes de implementar

1. **Prioridad**: ¿exportación exacta primero (fase 2, un día, visible) o
   herramientas (fases 3–4)?
2. **Presupuesto en memoria** para el sink (b): ¿un ajuste más, o directamente
   "todo lo que no sea columna virtual va a Parquet"? Lo segundo es más simple y
   más honesto; lo primero es más rápido para archivos medianos.
3. **Web**: ¿vale la pena el sink (c) como descarga, o las fases 4–5 son de
   escritorio y la web se queda en 1–3?
