# Archivos de cualquier tamaño: qué falta y cómo cerrarlo

**Estado: fases 1, 2, 3 (3a, 3b, 3c) y 4a implementadas; Parquet sin red resuelto (§8); 4b diseñada (sección "Diseño (fase 4b)"); el resto, estudio.** Continúa `docs/file-size-limits.md`.
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
| Herramientas de datos (integral, media móvil, picos, relleno, filtro, remuestreo) | deshabilitadas (`_syncDataToolPickerOptions`); ~~derivada y detrend~~ **resueltas en la fase 3b** (salvo detrend por media móvil) | `dataToolLazyDisabled` |
| Outliers por picos | deshabilitados (IQR: calculado en la fase 3b, pero el menú no lo ofrece para ningún archivo) | `dataToolLazyBoundsOnly` |
| Derivadas del eje de tiempo (`index`, `delta`) | calculadas **sobre el overview**, no exactas (`derived-methods.js`, comentario en la cabecera) | — |
| FFT | filas crudas hasta `_fftHardMaxNfft` vía `getRawColumnsRange` | *"Selection is too large for FFT (live limit {live} NFFT; hard limit {hard})"* |
| Exportar CSV | ~~escribe el resumen~~ **resuelto en la fase 2** para series temporales, también con varios archivos lazy y en memoria mezclados; las variables calculadas sobre el resumen siguen exportándolo, ahora con aviso | `csvExportOverviewNotice` |
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
    // chunk = { x: Float64Array, yByVar: Map<name, Float64Array>, rowStart }
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

### Implementado (fase 1)

- `DuckDBSource.streamColumns(data, vars, { t0, t1, chunkRows, signal })` en
  `src/data/duckdb-source.js`: generador asíncrono que itera el
  `RecordBatchReader` y agrupa lotes en trozos de ~262 144 filas. Corre en una
  **conexión propia** (`_streamConnection`, con su cola `_acquireStreamLock`),
  así que un recorrido largo no bloquea los zoom. Un consumidor que corta antes
  (`break`, `return`, una excepción) cancela la consulta; un `signal` abortado
  lanza `AbortError`.
- La SQL de filas se extrajo a `_rawRowsSql`, que ahora comparten
  `getRawColumnsRange` y el stream: no pueden discrepar sobre qué filas caen en
  un rango. El stream omite la columna `rn` (toda NULL con tiempo real, y
  su extracción es fila a fila).
- `src/data/column-stream.js`: `streamColumns(data, …)` elige el camino; la
  versión eager trocea los arrays en memoria (vistas `subarray` cuando el
  trozo no salta filas) con las mismas reglas que la lazy.
- Cada lote se extrae por separado y se concatena, en vez de construir una
  `arrow.Table`: no depende de que los lotes pasen `instanceof` contra la copia
  de Arrow del módulo.

### Pruebas

`scripts/test-column-stream.mjs` corre el `DuckDBSource` real contra
**DuckDB-WASM en Node** (la build `duckdb-node-blocking` del mismo paquete que
usa la app), no contra DuckDB nativo: es el mismo lector por lotes que recibe
el navegador, y además funciona donde el binario nativo no se puede instalar.
Verifica paridad valor a valor lazy/eager y contra `getRawColumnsRange` sobre
un CSV de 100 003 filas con huecos, cancelación, salida temprana y que un zoom
responde con un stream abierto. Una trampa del entorno de prueba, documentada
en la prueba: en Node la build CJS del motor carga otra copia de Arrow que la
app, y hay que unificarlas en la caché de `require`.

Para las fases siguientes, mismo patrón que `scripts/test-missing-lazy.mjs`: los constructores de SQL como
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
| Derivada (`computeDerivative`) | ±1 (centrada), 1 (diferencia) | SQL `LAG`/`LEAD` como columna virtual, **hecho (3b)** | Exacta bit a bit y en streaming (`STREAMING_WINDOW`). Δt = 0 y no finitos replican el kernel. |
| Media móvil (`computeMovingAverage`) | ventana *w* | forma incremental con estado (suma y conteo corridos), **4b-1** | La suma corrida es sensible al orden: se lleva el estado, no se recalcula por trozo. Bit a bit. |
| Integral (`computeIntegral`) | estado (acumulado) | `SUM() OVER (ROWS UNBOUNDED PRECEDING)` en streaming, **hecho (4a)** salvo la política *interpolar* | Exacta bit a bit. Cada zoom re-escanea desde el inicio del archivo: correcto, y en CSV igual de lento que cualquier zoom. |
| Picos (`detectSpikeOutliers`) | ventana `half` | trozos con solape 25 (+16 para las rachas), en el pool de workers, **4b-3** | Sin estado: la mediana y la MAD de una ventana no dependen del orden de inserción. 10 s por 20 M en JS: por eso en workers. |
| Outliers IQR (`detectIqrOutliers`) | global (cuantiles) | cuantiles exactos por pasadas de histograma, luego predicado puntual en SQL, **hecho (3b)** | `quantile_cont` guardaría la columna entera en memoria: no se usa. Exacto bit a bit. |
| Detrend media / lineal / polinomio (`computeDetrend`) | global (ajuste) + puntual (aplicar) | agregados SQL (`fsum` de potencias), resolver en JS, aplicar como SQL, **hecho (3b)** | El ajuste coincide al redondeo; la resta, bit a bit. |
| Detrend por primera muestra | puntual | **hecho (3b)** | — |
| Detrend por media móvil | como media móvil | **4b-1** | — |
| Filtro IIR hacia adelante (`applyFilter`) | estado | forma incremental con estado, **4b-2** | El umbral de huecos es la pasada de la 4a; el avance `D` retrasa la emisión. |
| Filtro IIR de fase cero | dos pasadas, la segunda **al revés** | ida a un sumidero de trabajo; vuelta leyéndolo por rangos de `rn` en orden inverso, **4b-2** | Leer un CSV al revés en SQL es `ORDER BY t DESC` = sort completo. Un trozo del sumidero al revés cuesta 11 ms (medido). |
| Rellenar faltantes (`fillMissingValues`) | vecinos a ambos lados del hueco | trozos con solape, mirada hacia adelante hasta la próxima muestra finita con tope, en workers, **4b-3** | Los 7 métodos son locales (`data-tool-sampling.md` §2). Un hueco más largo que el tope se omite, como uno más largo que `maxGap`. |
| Remuestreo (`runResample`) | bucket (estado en el borde) | forma incremental con cursor; la salida es un **dataset lazy** cuya tabla es el sumidero, **4b-4** | Precedente: *Resample* ya produce **un archivo nuevo**. El tope de 20 M puntos no aplica: la grilla no se materializa. |
| Colapsar timestamps repetidos (`runCollapseRepeats`) | racha (estado) | forma incremental; dataset lazy, **4b-4** | — |
| Correlación cruzada (`runCrossCorrelation`) | global (FFT de ambas) | la selección en memoria hasta un presupuesto, como la FFT, **4b-4** | La ruta directa O(N·L) no se paga a 20 M × 5 M. |
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
| 4a | Integral, índice y paso del eje en SQL — **hecha** | 1 día | — |
| 4b | **Ejecutor por trozos** con solape/estado para los kernels JS (media móvil, IIR, picos, relleno, remuestreo, colapsar) y el **sumidero** (tabla DuckDB con presupuesto; OPFS / Parquet nativo por encima) — diseño abajo | 1,5–2 semanas en cuatro PR | medio: lectura por unión posicional medida; el riesgo que queda es la reescritura de los kernels |
| 5 | Proyecto por definición para archivos lazy | 2–3 días | medio: formato de sesión, compatibilidad hacia atrás |
| 6 | Formatos eager-only → Parquet (Excel ya; MAT, pickle, netCDF no). MAT por variable en lazy es otro estudio: el formato lo permite (cada variable es un elemento con desplazamiento conocido), el lector actual no | por formato | — |

Las fases 1–3 son autónomas y baratas, y dejan la app con exportación exacta y
tres herramientas más en lazy sin materializar un solo array. La 4 es la
inversión grande y la que realmente cumple "cualquier tamaño → cualquier
herramienta → cualquier resultado".

---

### Implementado (fase 2)

- `_exportCSV` (panel de series temporales): si todas las trazas son columnas
  de **un** archivo lazy (`_lazyTimeseriesCsvPlan`), `_exportLazyTimeseriesCsv`
  recorre el archivo con `streamColumns` y escribe **todas** las filas.
- Cada trozo pasa por `_transformFetchedPhaseTrajectory` — la transformación
  que ya usaban las filas leídas del archivo para la fase — y la columna de
  tiempo por `_formatTimeColumnForExport`: mismo recorte, desplazamiento, modo
  de tiempo, ganancia, signo y offset que la exportación en memoria. La
  paridad es por construcción y además está probada byte a byte.
- El escritor se partió en `_writeCsvChunks` (consume bloques de filas, de un
  iterable asíncrono) y `_writeCsvFile` (un solo bloque, comportamiento
  idéntico al anterior). Un cancel sale del bucle, lo que termina la iteración
  y cancela la consulta en DuckDB. El progreso muestra "N filas" cuando el
  total no se conoce (una `VIEW` de CSV no lo cuenta).
- **Varios archivos** (fase 2b): un panel que mezcla archivos lazy y en
  memoria también sale exacto. Cada archivo lazy se lee con su propio stream
  para todas sus trazas, cada archivo en memoria desde sus arrays, y el CSV se
  arma de a bloques de 65 536 filas tomando las filas siguientes de cada
  archivo a la par (`_lazyCsvRowFeeder`, `_memoryCsvRowFeeder`). Mismo formato
  que en memoria: una columna de tiempo por traza, y las columnas del archivo
  más corto quedan vacías debajo de su última fila.
- Para eso el lector pasó a abrir **una conexión por stream** en vez de una
  conexión de streams compartida con cola: con la cola, dos streams avanzados a
  la par se esperaban mutuamente y la exportación quedaba colgada. Verificado
  con el motor que dos lecturas intercaladas en conexiones distintas dan los
  datos correctos.
- Lo que no se puede leer del archivo (variables calculadas sobre el resumen,
  variables con eje de filas propio) exporta el resumen como antes, pero **con
  aviso** (`csvExportOverviewNotice`). Un error de lectura no escribe nada y lo
  dice (`csvExportReadFailed`).
- Pendiente de esta fase, a propósito: **Parquet** como formato de exportación
  (necesita una opción en el diálogo) y la exportación exacta de paneles de
  fase (hoy exportan la trayectoria decimada que dibujan).

Prueba: `scripts/test-lazy-csv-export.mjs` carga el mismo CSV lazy (DuckDB-WASM
real) y eager, exporta ambos y exige el mismo archivo byte a byte, también con
recorte, desplazamiento, ganancia, offset y signo invertido activos; y un panel
con un archivo en memoria y dos lazy de longitudes distintas (transformaciones
en uno, signo invertido en otro) contra los tres en memoria, y contra los tres
lazy. Verificado que falla si la exportación lazy escribe el tiempo sin
transformar, o la columna de tiempo de otro archivo.

### Implementado (fase 3a): fórmulas en SQL

El estudio original no incluía las **variables calculadas** (fórmulas), y eran
la mejor candidata. Sobre un archivo lazy se evaluaban en JS sobre el resumen
de ~10 000 filas y nada más: el zoom nunca les agregaba detalle
(`interaction-methods.js` las dibujaba siempre desde el resumen), la
exportación escribía el resumen, y el heatmap y el perfil temporal las
rechazaban.

- `src/expr/sql.js` traduce una fórmula a una expresión DuckDB. En un archivo
  lazy, `_evaluateDerivedFormula` la guarda en la variable (`_duckdbExpr`) y
  `_valueExpressionSql` la usa: zoom, exportación, heatmap, perfil, integral por
  día y correlaciones la evalúan sobre el archivo, sin tocarlos (todos pasan
  por `_valueExpressionSql`, y deciden qué pueden servir con `hasSqlValue`).
- **Semántica**: SQL y JavaScript difieren en muchos casos límite, medidos en el
  DuckDB 1.4.3 de la app — `sqrt`/`log`/`asin` fuera de dominio y `sin(∞)` dan
  **error** (tiraban toda la consulta), `log(0)` da error, `sign(NaN)` es 0,
  `NaN > 0` es verdadero, `least` ignora NaN y NULL, `pow(1, ∞)` es 1,
  `min(0, −0)` es +0. La expresión mantiene un invariante: todo valor es un
  número no-NaN o NULL (NULL hace de NaN), las entradas fuera de dominio se
  filtran **antes** de cada función, y `min`/`max`/`sign`/`root` respetan el
  signo del cero. La tabla completa está en la cabecera de `sql.js`.
- **Rendimiento**: nada de `try()`. Con la mitad de las filas fuera de dominio,
  `try()` evalúa fila por fila: 14 s para `log(a*b)` sobre 5 M filas, contra
  0,37 s con la entrada filtrada. Las subexpresiones compuestas se evalúan una
  vez con una lambda (≈ +25 ms por 5 M filas).
- **Qué no se traduce** (y sigue sobre el resumen): `diff()` y `cumsum()`,
  `root()` con grado variable, y fórmulas construidas sobre esas. Al crearlas
  en un archivo lazy la app **avisa** (`derivedLazyOverviewOnly`).
  *Corrección (fase 3b)*: se escribió aquí que `diff`/`cumsum` necesitaban una
  ventana que DuckDB-WASM materializa. Medido después, es falso: `LAG`, `LEAD`
  y `SUM … ROWS UNBOUNDED PRECEDING` con `OVER ()` corren en streaming. Desde
  la fase 3c se traducen (abajo), y también `root()` con grado variable.
- Las siete cachés de consultas usan ahora la expresión en su clave: editar una
  fórmula bajo el mismo nombre no sirve los valores viejos.

Pruebas:
- `scripts/test-formula-sql.mjs`: paridad contra `compile.js` sobre 1 369
  combinaciones de valores extremos (±0, ±∞, NaN, celdas vacías, 1e±308…).
  73 fórmulas escritas y 400 aleatorias de operaciones exactas coinciden **bit
  a bit**, signo del cero incluido; 674 operaciones de 150 fórmulas aleatorias
  con trascendentales coinciden **una por una** con ≤ 1 ulp (las bibliotecas
  matemáticas de V8 y musl no son idénticas; compuestas, las diferencias se
  amplifican en pasos mal condicionados, por eso se compara operación a
  operación). La única excepción aceptada y contada es el redondeo de `root()`
  por encima de 5e11, donde 1 ulp de `pow` cae a un lado u otro del medio.
- `scripts/test-lazy-csv-export.mjs`: una fórmula creada como la crea la app
  sobre un archivo lazy real se exporta **byte a byte** igual que en memoria, el
  zoom trae todas las filas de la ventana, las fórmulas anidadas se traducen,
  editar una fórmula invalida la caché, y `cumsum` cae al resumen con aviso.
- Verificado que ambas fallan si se quita la fórmula del token de caché, la
  comprobación de NULL de `min`/`max`, o la guarda de `log(0)`.

### Implementado (fase 3b): derivada, IQR y detrend en SQL

Tres herramientas más corren sobre archivos lazy, en todas las filas, sin un
solo array: su salida es una variable con `_duckdbExpr` (como una fórmula de la
3a), así que zoom, exportación exacta, heatmap, perfil y correlaciones la leen
sin cambios. El núcleo es `src/data/lazy-tool-sql.js`; la app,
`src/app/methods/lazy-data-tools-methods.js`.

- **Ventanas en streaming.** Medido en DuckDB-WASM 1.4.3 con un CSV de 20 M
  filas: `LAG`, `LEAD` y la suma acumulada con `OVER ()` (sin partición ni
  orden) son `STREAMING_WINDOW` — memoria residente igual a un escaneo simple,
  orden de filas conservado (`t − LAG(t)` = 1 en las 20 M filas), +50 % de
  tiempo. Con `ORDER BY` sí sería un sort completo.
- **Pero una ventana no se puede mezclar con el filtro de tiempo**: en el mismo
  `SELECT` que un `WHERE t BETWEEN …` vería solo las filas del zoom. Por eso es
  una **columna de una subconsulta** sobre todo el archivo
  (`windowedFromSql`), por niveles (una derivada de derivada está un nivel
  arriba), y `DuckDbSource._fromSql(data, variables)` la usa solo en las
  consultas que leen esas variables. El resto no paga nada: la subconsulta
  impide que DuckDB empuje el filtro al escaneo — en una tabla de 20 M filas un
  zoom pasa de 17 ms a 137 ms; en CSV no cambia (se escanea igual). Las
  fórmulas sobre una derivada heredan sus columnas (`_duckdbWindows`).
- **Derivada**: los 4 métodos, eje numérico, calendario (por segundo) e índice
  (cuenta muestras); Δt = 0 o no finito da NaN como el kernel, `difference` no
  divide.
- **IQR**: `quantile_cont` guardaría toda la columna en memoria. En su lugar,
  `exactOrderStatistics` corta el rango en 1024 cubetas, cuenta con un
  `GROUP BY` y solo vuelve a mirar la cubeta que contiene el rango buscado;
  cuando queda ≤ 1 M de valores, los trae y los ordena. Cuartiles exactos →
  mismas vallas (`iqrFences`, exportada del kernel) → mismo resultado bit a bit.
- **Detrend** media / lineal / polinomio: una pasada para el rango de la
  abscisa, otra para Σuᵖ y Σuᵖ·y (`fsum`, suma compensada), el sistema se
  resuelve con el mismo código del kernel (`solveDetrendFit`, exportado). La
  resta se escribe operación por operación como el kernel. Primera muestra:
  `LIMIT 1` en orden de archivo. Media móvil: fase 4.
- **Estadísticas y sesión.** Lo que la SQL no puede saber sola (vallas,
  coeficientes, ancla) se guarda en la definición (`lazyStats`) con la firma de
  la fuente (su SQL y el eje). Al restaurar una sesión o editar la fuente, la
  herramienta se reconstruye al instante y, si la firma cambió, las
  estadísticas se recalculan en segundo plano y se refrescan sus dependientes.
- **Fuentes**: derivada y detrend aceptan cualquier variable con SQL (columna,
  fórmula, otra herramienta); cotas e IQR, columnas del archivo.
- **IQR y el menú**: el detector IQR existe en el kernel y en las sesiones,
  pero el menú no lo ofrece para ningún archivo (solo picos y cotas). En lazy
  se calcula cuando una sesión lo trae; agregarlo al menú es otra decisión.

Rendimiento, 20 M filas / 360 MB de CSV en Node (DuckDB-WASM), memoria
residente plana (~570 MB, la de un escaneo simple) en todos los casos:

| Crear | Tiempo | Pasadas |
|---|---|---|
| Derivada | 7,8 s | refresco del resumen |
| IQR | 27 s | conteo, histograma, valores de 2 cubetas, conteo de outliers, resumen |
| Detrend lineal | 19 s | rango, sumas, resumen |

Pruebas: `scripts/test-lazy-data-tools.mjs`, sobre un CSV lazy real con Δt = 0,
huecos, valores cerca de ±1e308 y empates:
- derivada: 4 métodos × eje numérico / índice × dos columnas, y dos métodos en
  eje calendario, **bit a bit** con el kernel; un zoom al medio del archivo trae
  la derivada centrada correcta en su primera fila; el plan tiene
  `STREAMING_WINDOW` y ningún sort; derivada de derivada, derivada de fórmula y
  fórmula de derivada, bit a bit.
- IQR con 5 combinaciones (incluido un valor justo en la valla): **bit a bit**,
  y el conteo que informa el panel; estadísticos de orden con cubetas mínimas
  (8 cubetas, 50 valores) para forzar varias pasadas.
- detrend: media, lineal y cúbico en eje numérico e índice, al redondeo
  (1e−9 relativo); con los coeficientes del kernel, la resta es bit a bit;
  primera muestra, bit a bit.
- sesión restaurada (estadísticas recalculadas en segundo plano) y edición de
  la fuente (el detrend sobre la derivada se reajusta).
- `scripts/e2e-lazy-data-tools.mjs` (Chromium, en la cadena `npm run e2e`):
  un CSV de 12 MB abre en lazy; el selector ofrece derivada, detrend y
  outliers (solo cotas), detrend sin media móvil; una derivada y un detrend
  creados con "Crear y graficar" se dibujan y un zoom de 10 s trae las 1001
  filas.
- Verificado que falla si se quita la guarda de Δt = 0, si la ventana no se
  agrega al `FROM`, si la valla IQR es inclusiva, si un estadístico de orden
  se corre un lugar, si `u` se calcula con el recíproco, o si la restauración
  no recalcula.

### Implementado (fase 3c): `diff()`, `cumsum()` y `root()` con grado variable

`diff(x)` es la derivada en modo "diferencia" sin dividir por Δt, y `cumsum`
una suma corrida: con las columnas de ventana de la 3b, `src/expr/sql.js` las
traduce como tales. El traductor devuelve, además de la expresión, las columnas
de ventana que lee (`out.windows`), y la variable las lleva en
`_duckdbWindows`, igual que una derivada: `_fromSql` las agrega al `FROM` solo
en las consultas que las leen.

- `diff`: `x[i] − x[i−1]`; la primera muestra toma la diferencia hacia
  adelante, una sola fila da 0, y `diff` de una constante es una serie de
  ceros (también `diff(1/0)`), como en `compile.js`.
- `cumsum`: `SUM(x) OVER (ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`
  suma en orden de fila, secuencialmente — medido: −0 da +0, el desborde da ∞
  sin error, ∞ − ∞ da NaN y queda NaN, como en JavaScript. La única diferencia
  es que `SUM` salta los NULL, mientras que en JavaScript un NaN contamina todo
  lo que sigue: un conteo corrido de NULL lo corrige.
- Anidan: `diff(diff(x))`, `cumsum(diff(x) * y)`, fórmulas sobre ellas, y
  derivadas de la 3b sobre ellas.

- `root(x, g)` con un grado que es una variable: las ramas de `nthRoot`
  (grado entero impar con base negativa, grado cero o no finito) se deciden
  fila por fila en vez de una vez; un grado subnormal hace 1/g infinito, y ahí
  `pow(±1, ±∞)` es NaN en JavaScript y 1 en DuckDB, así que se filtra.

Con esto **toda fórmula** se traduce; solo quedan sobre el resumen las
variables sin SQL propio (índice o paso del eje de tiempo, eje generado) y las
fórmulas construidas sobre ellas.

Pruebas (`scripts/test-formula-sql.mjs`): 17 fórmulas con `diff`/`cumsum` sobre
las 1 369 combinaciones de valores extremos, y 4 sobre 50 000 filas
ordinarias, **bit a bit**; una sola fila; el plan es `STREAMING_WINDOW` sin
sort. `scripts/test-lazy-csv-export.mjs`: `cumsum(speed) + diff(torque)` y una
fórmula encima se exportan byte a byte igual que en memoria. Verificado que
falla sin el conteo de NULL, sin el 0 de una sola fila, sin la diferencia
hacia adelante de la primera fila, o sin el caso de la constante. `root()` con
grado variable: 8 fórmulas sobre las combinaciones extremas y grados
variables en las fórmulas aleatorias, a ≤ 1 ulp por operación; falla sin la
rama impar, sin la guarda de grado 0/∞, o sin la de `pow(1, ∞)`.

### Implementado (fase 4a): integral, índice y paso del eje de tiempo

**Integral acumulada** en archivos lazy, con sus tres métodos (trapecios,
rectángulos, suma) y las políticas de huecos *cero* y *propagar*
(`integralWindows` en `lazy-tool-sql.js`):

- Cada paso del kernel es una columna de ventana: Δt (en segundos en un eje
  de calendario, 1 en uno de índice; un Δt no finito salta el paso), si el
  paso es usable, si es un hueco del eje; la suma corrida
  (`SUM … ROWS UNBOUNDED PRECEDING`) suma en orden de fila como `acc +=`. El
  primer sumando es el valor inicial; un paso que no suma nada suma NULL (sumar
  0 convertiría un −0 acumulado en +0); *propagar* es un conteo corrido de
  pasos malos.
- **Detección de huecos**: `detectSamplingGaps` sobre todo el eje — la mediana
  de los pasos positivos es un estadístico de orden exacto (los pases del IQR,
  generalizados a cualquier expresión: `exactOrderStatisticsOver`), el
  acuerdo del 80 % al 10 % y el umbral de 1,5 × mediana se cuentan con
  agregados. El umbral es el del kernel, al bit.
- Los contadores que muestra el panel (pasos negativos, huecos, celdas vacías,
  tiempo sin cubrir) salen de otra pasada de agregados.
- *Interpolar* queda deshabilitada en lazy (`dataToolLazyIntegralInterpolate`):
  une un hueco hacia la **próxima** muestra finita, una mirada hacia adelante
  que una ventana en streaming no puede hacer.

**Índice y paso del eje de tiempo** (el inspector del eje): en lazy eran el
índice y el Δt de las muestras del *resumen* (de ahí filas 0…9 999 y pasos de
cientos de filas). Ahora son SQL sobre el archivo: el número de fila y la
diferencia de filas consecutivas, en segundos. Y `time` en una fórmula sobre
un eje generado (el número de fila) también se traduce.

**Corrección de la 3c**: una fórmula con `diff`/`cumsum` sobre un archivo lazy
mostraba, sin zoom, su cálculo en JS sobre las muestras del resumen —
diferencias entre muestras separadas por cientos de filas. Ahora una variable
que lee filas vecinas empieza con el resumen vacío y la app lo relee del
archivo (`_refreshLazyOverviewSoon`) al crearla, editarla, restaurarla o
actualizarla en vivo.

Rendimiento: integral por trapecios sobre 20 M filas / 360 MB de CSV, 27 s en
crearse (conteos, mediana de los pasos, acuerdo, contadores y resumen), memoria
residente plana (565 MB).

Pruebas (`scripts/test-lazy-data-tools.mjs`): 3 métodos × 2 políticas × dos
valores iniciales, sobre una grilla de 10 ms con huecos y celdas vacías en eje
numérico y de calendario, más eje de índice, eje irregular y un eje de seis
pasos con medianas distintas: **bit a bit** con el kernel, y los contadores y
el aviso idénticos. Índice y paso bit a bit sobre ambos ejes, y el resumen
releído del archivo. Falla si no se saltan los huecos, sin la propagación, si
el método de rectángulos lee y₁, con la mediana superior en vez del promedio,
sin el refresco del resumen, o si el paso se escala dividiendo por 1000 en vez
de multiplicar por 0,001. El e2e crea una integral desde el panel.

### Diseño (fase 4b): las herramientas que no se escriben en SQL

**Estado: diseño; nada implementado.** Lo que queda después de la 4a son las
herramientas cuya salida no es una expresión sobre la fila y sus vecinas
inmediatas: media móvil (y el detrend por media móvil), filtro digital (hacia
adelante y de fase cero), picos, rellenar faltantes, las políticas *interpolar*
de la integral y de los outliers, remuestreo, colapsar timestamps repetidos y
correlación cruzada. Este diseño las cubre todas, con una excepción explícita
(la correlación cruzada, sección "Global").

#### Por qué no en SQL

Cada una necesita algo que una ventana en streaming no da:

- **Estado que se arrastra** a lo largo de todo el archivo: el filtro IIR
  (`y[n]` depende de `y[n−1]…`), la suma corrida de la media móvil (que el
  kernel mantiene en un orden de sumas y restas fijado a propósito — dos
  medias móviles escritas de otra forma no son bit a bit iguales).
- **Un estadístico por ventana**: los picos comparan cada muestra con la
  mediana y la MAD de sus 51 vecinas. `median() OVER (ROWS BETWEEN 25 PRECEDING
  AND 25 FOLLOWING)` existe, pero DuckDB no lo evalúa en streaming.
- **Mirar hacia adelante hasta la próxima muestra finita**: rellenar un hueco,
  interpolar un outlier, la política *interpolar* de la integral. La distancia
  no está acotada por una constante sino por el hueco más largo del archivo.
- **Dos pasadas, la segunda al revés**: el filtro de fase cero recorre cada
  tramo hacia adelante y después la salida de esa pasada hacia atrás, y el
  estado inicial de la vuelta es la última muestra de la ida.

En memoria todo esto es un array y un bucle. Sobre un archivo que no entra en
memoria hace falta (1) un **ejecutor** que recorra el archivo por trozos
llevando el estado, el solape y la mirada hacia adelante que cada kernel
necesita, y (2) un **sumidero** donde vive un resultado del tamaño del
archivo. Las dos piezas se diseñan abajo, y después cómo lee la app un
resultado que vive en un sumidero.

#### Principio 1: un kernel, dos conductores

Cada kernel de `src/compute/kernels/` que entra en la 4b se reescribe como una
**forma incremental** — un objeto con `push(chunk)` que devuelve las filas de
salida que ya puede emitir y `flush()` al final — y la función de array
completo que existe hoy (`applyFilter`, `computeMovingAverage`, …) pasa a ser
un conductor que crea el objeto, le hace `push` del array entero y `flush`.
Así:

- la paridad eager/lazy es **por construcción**: el mismo código, con las
  mismas sumas en el mismo orden, corre en memoria y por trozos;
- los tests que ya existen para cada kernel (`test-compute-kernels`,
  `test-detrend-filter`, `test-interpolate-regrid`, …) siguen protegiendo la
  forma incremental, porque la conducen;
- el conductor por trozos solo agrega los tests de **borde de trozo**: correr
  el mismo kernel con `chunkRows` de 1, 7 y 1000 filas y exigir bit a bit lo
  que da con un solo trozo.

No todos los kernels tienen el mismo vecindario. Dos familias, que se tratan
distinto:

| Familia | Herramientas | Cómo corre por trozos | Dónde corre |
|---|---|---|---|
| **Sin estado, con solape** — la salida de la fila *i* depende solo de las filas *i ± k* | picos (k = 25 + tolerancia de la expansión de rachas, ≤ 16), rellenar faltantes (k = 3 vecinos válidos por lado en pchip/akima, `ventana/2` en *smooth*; el hueco es la mirada hacia adelante), reemplazo de outliers por interpolación (prev/next válidos) | cada trozo se procesa con *k* filas de solape a cada lado y se descarta el solape; el resultado de una fila no depende de por dónde se cortó, porque el kernel solo mira un multiconjunto de vecinas (la mediana y la MAD de una ventana no dependen del orden en que se insertó) | en el **pool de workers que ya existe** (`dataTool:pipeline` es petición/respuesta sin estado: cada trozo es una petición independiente, y varios trozos corren en paralelo) — necesario para los picos, que cuestan 10 s por 20 M filas |
| **Con estado** — la salida depende de todo lo anterior | filtro IIR (el vector de estado por sección, `lastValid` para los huecos), media móvil (suma y conteo corridos + las últimas `ventana` filas), integral con *interpolar* (el acumulador), remuestreo (el cursor del par fuente y el bin en curso), colapsar (la racha en curso) | un solo objeto que recibe los trozos en orden y lleva el estado entre uno y otro; la mirada hacia adelante que necesita (`right` de la media móvil, el avance `D` del filtro, el hueco de *interpolar*) la provee el ejecutor | en el **hilo principal**, un `await` por trozo (medido: el IIR cuesta 1,3 s por 20 M filas, 17 ms por trozo de 262 144 — no se nota); un worker con estado es una mejora posterior, no una necesidad |

Lo que se conserva de cada kernel al reescribirlo, con el detalle que decide
la paridad:

- **Media móvil**: la suma corrida `sum += / -=` en el orden exacto del kernel
  actual; el estado es `(sum, count)` y las últimas `left` filas (para las
  restas futuras); la mirada hacia adelante es `right`.
- **Filtro IIR hacia adelante**: `states` por sección, `lastValid`,
  `expectedBetween` para los huecos — que necesita `medianDt` del eje entero:
  es la pasada de `_lazySamplingGapThreshold` de la 4a, ya escrita. El avance
  `D` retrasa la emisión `D` filas dentro de cada tramo; al cerrar un tramo las
  últimas `D` salidas son NaN, como hoy.
- **Filtro de fase cero**: por tramo contiguo de muestras finitas: la ida
  (con el relleno `oddExtend` de `3 × orden` muestras, que necesita las
  primeras `3 × orden` filas del tramo como mirada hacia adelante) escribe a un
  **sumidero de trabajo**; la vuelta lee ese sumidero **al revés**, empezando
  por la última muestra del tramo (que es su estado inicial). Un archivo sin
  NaN es un solo tramo del largo del archivo: por eso la vuelta no puede ser
  "guardar el tramo en memoria".
- **Picos**: `scanSpikeCandidates` sobre el trozo con solape 25 a cada lado, y
  `keepReturningOutlierRuns` sobre los candidatos con solape 25 + 16 (la
  expansión de una racha hasta `maxRun`). Bit a bit: ambas funciones leen
  ventanas, no historial.
- **Rellenar faltantes** y **reemplazo por interpolación**: la mirada hacia
  adelante es "hasta la próxima muestra finita" y por eso el ejecutor la
  extiende trozo a trozo mientras haga falta, con un **tope**
  (`LOOKAHEAD_MAX_ROWS`, propuesta 4 M filas ≈ 32 MB por columna): un hueco más
  largo que el tope no se rellena y se cuenta como *omitido*, igual que uno más
  largo que `maxGap` — el panel ya sabe decirlo. `edges: hold` al final del
  archivo es el `flush()`.
- **Integral con *interpolar***: `bridgeNonFinite` por tramo de NaN, con la
  misma mirada hacia adelante; el acumulador es el estado. Las políticas *cero*
  y *propagar* siguen en SQL (4a).
- **Remuestreo** y **colapsar**: producen **otro eje** (sección "Datasets
  nuevos"); el kernel es secuencial con un cursor, y la grilla no se
  materializa (se genera al vuelo), con lo que el tope de 20 M puntos del
  remuestreo (`RESAMPLE_MAX_POINTS`, que existe para no reservar un array) no
  aplica en lazy. El paso nominal y el rango (primera y última muestra) salen
  de las pasadas de agregados de la 4a.

#### Principio 2: el ejecutor

Un módulo, `src/data/chunk-executor.js`, sin DOM, con un contrato:

```
runChunkedJob({
    data, sourceNames,          // el archivo lazy y las columnas que lee
    kernel,                     // la forma incremental: push(chunk) → filas de salida, flush()
    overlap: { before, after }, // filas de solape (familia sin estado)
    lookahead: { until, cap },  // mirada hacia adelante variable: predicado sobre la fila, y tope
    sink,                       // dónde escribir (abajo)
    chunkRows, signal, onProgress,
})
```

- Lee con `streamColumns` (fase 1), que ya recorre el archivo entero en
  orden físico sin sostenerlo, con una conexión propia para no bloquear el
  zoom.
- **Alineación con el archivo.** El stream de un trabajo pide **todas las
  filas** del relación base — también las que no tienen tiempo y las que el
  perfil CSV filtra — y el sumidero recibe **una fila por fila del archivo**
  (NaN donde el kernel no tiene nada que decir). Sin esto la unión posicional
  de la lectura (abajo) se desalinea. Es una opción nueva del stream
  (`allRows`), no un cambio del contrato de la fase 1.
- Solape y mirada hacia adelante son un **anillo** de filas anteriores y una
  lectura adelantada del trozo siguiente: el ejecutor entrega al kernel el
  trozo *k* recién cuando tiene el trozo *k+1* (o las filas que `until` pide).
- Emite las salidas en orden al sumidero, por trozos; un `AbortSignal` corta el
  stream y descarta el sumidero.
- **Progreso** por filas cuando el total se conoce (Parquet: `totalRows`) y por
  filas leídas cuando no (CSV), con el mismo overlay con botón de cancelar que
  la exportación de la fase 2.
- **Dos pasadas**: el trabajo de fase cero corre la ida con un sumidero de
  trabajo y la vuelta como un segundo stream que lee ese sumidero en orden
  inverso por rangos de `rn` (medido abajo: 11 ms por trozo de 262 144). El
  sumidero de trabajo se borra al terminar.
- **Encadenar**: un trabajo cuya fuente es una variable de sumidero (filtrar
  la señal ya suavizada) lee por el mismo `_fromSql` que todo lo demás: el
  stream ya lo usa desde la 3b.

#### Principio 3: el sumidero

Un resultado del tamaño del archivo vive en una **tabla de DuckDB** en la
memoria de wasm, `omv_sink_<archivo>_<n>(rn BIGINT, t DOUBLE, y DOUBLE, …)`,
escrita por trozos con `insertArrowTable` (medido: 20 M filas en 3,3 s) y
compactada con `CHECKPOINT` al terminar (369 → 221 MB; en una señal suave,
80 → 20 MB por 5 M filas). Lleva `rn` (la fila del archivo, para leerse por
rangos y al revés: los *zone maps* de DuckDB hacen que un trozo cueste 11 ms) y
`t` (la misma expresión de tiempo que el archivo, `timeValueSql`; en un eje
generado, la fila), para que el sumidero **se baste solo** en las lecturas más
frecuentes.

**Presupuesto.** Antes de empezar, `filas × 24 bytes` (medido: 18 B/fila antes
del `CHECKPOINT` y 11 después, para `(rn, t, y)` con un seno; mucho menos con
señales suaves) contra un ajuste nuevo, *Resultados en memoria (MB)*, por
defecto 1024, contando los sumideros ya vivos. El techo de wasm es 4 GiB
(`docs/file-size-limits.md`, addenda) y lo comparten los búferes de escaneo de
DuckDB (~300 MB en un CSV de 360 MB, medido). Con 1 GiB entran ~50 M filas de
salida. Por encima:

1. **Web, con la extensión Parquet disponible**: el sumidero se escribe en
   **OPFS** con `COPY … TO 'opfs://…' (FORMAT PARQUET)` (DuckDB-WASM 1.32 lo
   soporta: medido con CSV, 5 M filas en 6,2 s, releído en 3,7 s) y se lee con
   `read_parquet`, que poda *row groups* por estadísticas de `rn` como la
   tabla poda por *zone maps* (documentado por DuckDB; **no medido acá**,
   porque en este entorno de desarrollo la extensión no se puede bajar — ver
   §8; el build de CI sí la trae). Los archivos
   OPFS son de la app y se borran al cerrar el archivo.
2. **Escritorio**: los trozos van por IPC al proceso principal, que ya tiene
   DuckDB nativo (`csv-to-parquet-core.js`) y un directorio de Parquet
   temporales con limpieza al salir; el archivo resultante se registra en el
   renderer por el servidor HTTP de rangos local, como cualquier Parquet local.
3. **Ninguno de los dos**: el trabajo se rechaza antes de empezar, con el
   tamaño estimado y el ajuste que lo permitiría.

**Ciclo de vida.** Un sumidero se borra al eliminar la variable, al cerrar o
recargar el archivo, al cancelar el trabajo y al reemplazarlo por una nueva
edición. **No viaja en la sesión**: viaja la definición (como las `lazyStats`
de la 3b), y al restaurar, el trabajo se vuelve a correr en segundo plano con
el overlay — la variable existe desde el primer momento con el resumen vacío,
como una fórmula con `diff()` en la 3c. En escritorio, un Parquet temporal
podría reutilizarse si la huella de la fuente coincide (misma ruta, tamaño y
fecha): es una mejora de la 4b-4, no de la base.

**Actualización en vivo.** Los sumideros son *append-only* y los kernels con
estado guardan su estado final: cuando el archivo crece, el trabajo **sigue**
desde ahí sobre las filas nuevas y las agrega (medido: 100 k filas en 15 ms).
La familia sin estado recalcula la cola con solape. La fase cero recalcula
entera. Mientras tanto la variable se marca *desactualizada* en la tabla de
transformaciones.

#### Cómo lee la app una variable de sumidero

La variable lleva `_duckdbSink: { table, column, generation }`, y
`hasSqlValue` la acepta. Dos caminos, decididos en `_fromSql` como se decide
hoy la subconsulta de ventanas:

- **Solo variables de un mismo sumidero** (el zoom sobre la señal filtrada,
  su refresco del resumen, su exportación, su heatmap): la consulta lee **el
  sumidero solo**, `FROM omv_sink_…`, porque tiene `t` y `y`. Medido: 4 ms
  por zoom en una tabla de 20 M filas, contra 17 ms del archivo.
- **Mezcla de columnas del archivo y del sumidero** (una correlación entre la
  señal cruda y la filtrada, un diagrama de fase con una de cada, una
  exportación con las dos): `FROM archivo POSITIONAL JOIN sumidero1
  POSITIONAL JOIN sumidero2`. Medido en DuckDB-WASM sobre 20 M filas: cuando
  los dos lados son escaneos simples el plan es `POSITIONAL_SCAN` — fila a
  fila, **sin materializar nada** (la memoria residente no se mueve: 1148 MB
  contra 1149 del escaneo simple) — y cuesta 2,4–2,7 s contra 2,1 s del
  escaneo del CSV; sobre una tabla, un zoom pasa de 17 a 93 ms (la unión no
  deja empujar el filtro de tiempo al escaneo; es el mismo costo que las
  ventanas de la 3b), con dos sumideros 106 ms.

Una condición que la medición dejó clara: si un lado de la unión posicional
no es un escaneo simple — una vista con `WHERE` (el filtro de filas del
perfil CSV), un `UNION ALL` (la vista combinada de un archivo con
actualización en vivo) — el plan pasa a `POSITIONAL_JOIN`, que **materializa**
un lado (+155 MB y 4,1 s en la prueba). Por eso el sumidero se alinea con la
relación de lectura cruda (`readExpr`, que `meta` pasará a guardar) y no con
la vista: `_fromSql` compone `read_csv(…) POSITIONAL JOIN sumidero` y aplica
el filtro de la vista **después**. La vista combinada de la actualización en
vivo queda como el caso que materializa: son archivos chicos por naturaleza, y
se documenta como costo conocido.

El resto cae por su peso: `_dataToolCacheToken` incluye tabla y generación
del sumidero; una fórmula sobre una variable de sumidero lleva el sumidero
consigo (`_duckdbSinks`, como `_duckdbWindows`), y `_fromSql` mezcla ventanas
y sumideros; una herramienta SQL de la 3b sobre una variable de sumidero (la
derivada de la señal filtrada) no cambia nada.

#### Datasets nuevos: remuestreo y colapsar

Producen otro eje, y la app ya decidió (`docs/data-tool-sampling.md` §5) que
eso es **otro archivo**: un *derived dataset* con su receta, su fila en la
tabla de transformaciones y su lugar en el árbol. En lazy, ese archivo es un
archivo lazy cuya tabla **es** el sumidero (`t` + las columnas): un
`DuckDbSource.adoptTable(nombre, tabla, columnaDeTiempo)` construye la forma
`{variables, metadata}` con el `_overviewSql` que ya existe, y de ahí en
adelante es un archivo lazy más (zoom, exportación exacta, herramientas SQL,
sesión por receta). El botón *guardar a disco* del dataset escribe el CSV por
el stream de la fase 2, no por `syntheticBytes()`.

#### Global: correlación cruzada (y la FFT)

`computeCrossCorrelation` es una FFT de las dos series enteras: O(N) de memoria
por definición, y la ruta directa O(N·L) no se puede pagar (N = 20 M y
L = 5 M son 10¹⁴ productos). Igual que la FFT hoy, corre sobre **la selección
en memoria hasta un presupuesto** (`XCORR_MAX_ROWS`, propuesta 8 M filas por
serie), leída con `getRawColumnsRange`, y más allá lo dice con el mismo aviso
que la FFT. No es una herramienta por trozos y no se disfraza de una.

#### Hechos medidos para este diseño

DuckDB-WASM 1.32 (DuckDB 1.4.3); el CSV de 20 M filas / 360 MB de la 3b en
Node, y 5 M filas en Chromium con el bundle `eh` de la app:

| Qué | Medida |
|---|---|
| Escribir un sumidero `(rn, t, y)` por `insertArrowTable`, trozos de 262 144 | 20 M filas en 3,3 s (Node); 5 M en 1,0–1,4 s (Chromium) |
| Memoria del sumidero | 369 MB por 20 M filas, 221 MB tras `CHECKPOINT` (0,6 s); señal suave: 80 → 20 MB por 5 M |
| Leer un trozo por `rn` (*zone maps*) | 21 ms antes / 11 ms después del `CHECKPOINT`; 20 trozos al revés, 178 ms |
| Unión posicional CSV × sumidero, escaneo completo | `POSITIONAL_SCAN`; 2,4–2,7 s contra 2,1 s del escaneo simple; misma memoria |
| Unión posicional con una vista filtrada | `POSITIONAL_JOIN`: 4,1 s, +155 MB |
| Zoom sobre tabla × sumidero / dos sumideros / sumidero solo | 93 / 106 / 4 ms (archivo solo: 17 ms) |
| Agregar 100 k filas a un sumidero | 15 ms |
| OPFS desde DuckDB (`opfs://`, CSV) | escribir 5 M filas (126 MB) 6,2 s; releer 3,7 s |
| Kernels en JS, 20 M muestras | IIR adelante 1,3 s; fase cero 1,6 s; media móvil 0,4 s; picos 10,1 s; relleno 0,26 s |
| Extensión Parquet | **no viene en el bundle de DuckDB-WASM**: `duckdb_extensions()` la muestra `NOT_INSTALLED`; la app la sirve ella misma desde el build (§8) |

#### Plan por sub-fases

| Sub-fase | Qué | Costo |
|---|---|---|
| **4b-1** | El ejecutor, el sumidero en tabla con presupuesto y lectura por `_fromSql`, la forma incremental de la **media móvil** (y el detrend por media móvil), overlay con progreso y cancelación, sesión (re-ejecución), tests de borde de trozo, e2e | 2–3 días |
| **4b-2** | **Filtro IIR** hacia adelante (estado, huecos con el umbral de la 4a, avance) y de **fase cero** (sumidero de trabajo, vuelta al revés) | 1–2 días |
| **4b-3** | La familia sin estado en el pool de workers: **picos**, **rellenar faltantes**, reemplazo de outliers por interpolación, política *interpolar* de la integral; el tope de mirada hacia adelante | 2 días |
| **4b-4** | **Remuestreo** y **colapsar** como datasets lazy (`adoptTable`); correlación cruzada con presupuesto; los sumideros de desborde (OPFS en web, Parquet nativo en escritorio) con sus mediciones; actualización en vivo por continuación | 2–3 días |

Cada sub-fase es un PR con paridad bit a bit contra el kernel en memoria (el
mismo patrón que `scripts/test-lazy-data-tools.mjs`), y la 4b-1 deja la
infraestructura que las otras tres solo usan.

#### Riesgos propios de la 4b

- **Orden físico.** Todo — el stream, la alineación del sumidero, la unión
  posicional — asume que DuckDB devuelve las filas del archivo en su orden,
  como ya lo asumen la fase y las ventanas de la 3b (§8). En wasm sin hilos se
  cumple; `preserve_insertion_order=false` está puesto y no lo rompe hoy. Un
  test que compare `rn` con `ROW_NUMBER() OVER ()` tras la unión lo vigila.
- **Memoria de wasm.** Sumideros + búferes de DuckDB + el archivo que se
  escanea comparten 4 GiB. El presupuesto es una estimación; la 4b-1 tiene
  que medir el residente real en Chromium con un archivo grande y ajustar los
  24 B/fila.
- **Parquet y la red.** Los sumideros de desborde en web dependen de la
  extensión Parquet, que la app ya sirve ella misma (§8). En escritorio
  dependen de ella para *leer*, no para escribir.
- **Reescribir kernels.** Es la parte con más riesgo de regresión; la
  mitigación es que la forma incremental conduce también el camino eager, así
  que los tests existentes fallan si algo cambia.

## 8. Riesgos y decisiones abiertas

- **Parquet es una extensión que se descarga en tiempo de ejecución.
  Resuelto: la app la sirve ella misma.** Encontrado midiendo la 4b: en
  DuckDB-WASM 1.32 (DuckDB v1.4.3) el bundle no incluye el lector ni el
  escritor de Parquet; `duckdb_extensions()` lo muestra `NOT_INSTALLED`, y el
  primer `read_parquet` o `COPY … (FORMAT PARQUET)` bajaba
  `parquet.duckdb_extension.wasm` de `extensions.duckdb.org`. Sin acceso a ese
  host, **solo fallaban las operaciones con Parquet**, con errores crípticos:
  `read_parquet` daba `null function or function signature mismatch`, el
  `COPY` daba `table index is out of bounds`, y la conversión CSV → Parquet del
  navegador dejaba la página colgada. La misma instancia seguía leyendo CSV
  (medido en Chromium: un `COPY` a CSV después del fallo funciona). Una
  versión anterior de este documento decía que el motor caía entero; era
  incorrecto.

  Lo que se hizo:
  - `scripts/fetch-duckdb-extensions.mjs` baja el módulo en el build (lo
    llama `build:web`), para `wasm_eh` y `wasm_mvp`, con la versión que
    reporta el propio motor (`SELECT version()`), a
    `public/duckdb-extensions/<versión>/<plataforma>/`, con un
    `manifest.json` que lista archivo, tamaño y sha256. No se versiona en
    git. CI, Pages y el release de escritorio lo exigen
    (`OMV_REQUIRE_DUCKDB_EXTENSIONS=1`): sin módulo no hay deploy.
  - `DuckDbSource.ensureParquet()` corre antes de abrir un Parquet y antes de
    convertir: lee el manifiesto, y si lista el módulo para esta versión y
    plataforma, apunta `custom_extension_repository` a la copia de la app
    (URL absoluta: el motor pide desde su worker) solo durante el `LOAD
    parquet`, y lo restaura. Si no está o falla, prueba la descarga pública
    (así un checkout de desarrollo sin el módulo sigue como antes). Si
    también falla, lanza un error con `code =
    PARQUET_EXTENSION_UNAVAILABLE`, que el diálogo de carga traduce a los
    cuatro idiomas; el texto del motor queda en "Detalles técnicos".
  - La firma no se desactiva: el archivo servido es byte a byte el que
    publica DuckDB y el motor sigue rechazando módulos sin firma.
  - Pruebas: `test:fetch-duckdb-extensions` (servidor local en lugar de
    `extensions.duckdb.org`: ubicación, manifiesto, caché, versión vieja
    borrada, respuesta que no es wasm, fallo que corta un build exigente) y
    `e2e:parquet-offline` (Chromium con `extensions.duckdb.org` sin resolver:
    con el módulo, convertir y abrir Parquet sin pedir nada afuera; sin el
    módulo, el mensaje traducido y el CSV que sigue abriendo). En este
    entorno el módulo real no se puede bajar, así que acá se verificó el
    cableado (el motor pide exactamente
    `<app>/duckdb-extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm`) y
    el camino sin módulo; la carga real la verifica CI.

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
