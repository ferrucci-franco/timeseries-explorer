# Paridad del parsing CSV: DuckDB vs. parser JS (legacy)

Análisis y plan por etapas. **Documento de diagnóstico: no se modificó código.**
Fecha: 2026-09-27. Base: rama `claude/ecstatic-feynman-bycmo0` (igual a `main` en
el momento del análisis).

## 0. Resumen

- Un CSV abierto en el navegador **pasa por DuckDB-WASM sea cual sea su tamaño**.
  El límite de 300 MB solo decide carga completa vs. lazy *dentro* de DuckDB. El
  parser JS se usa solo cuando DuckDB no está disponible o falla (y entonces el
  cambio de camino es silencioso).
- **Los dos caminos no producen el mismo resultado.** En la app real, 5 de los
  65 fixtures de `test-files/csv` y el CSV del usuario (`finanzas_unificadas_2016-2026.csv`)
  divergen. Hay columnas numéricas que se vuelven texto, filas perdidas y orden
  distinto.
- La causa principal del síntoma reportado es que DuckDB decide el tipo de cada
  columna **con las primeras ≤100 filas de datos**, mientras que el parser JS mira
  **la columna completa**. Una columna numérica vacía en esas 100 filas se
  vuelve `VARCHAR` → `string`.
- El parser JS tampoco es perfecto: su regla (>50 % de celdas numéricas) convierte
  en `string` columnas numéricas con mayoría de `N/A`.
- La vista previa CSV tiene dos problemas propios. "Hide preamble rows" no oculta
  las filas entre la cabecera y la primera fila de datos (su tooltip dice que sí).
  Y la vista previa solo carga las primeras N líneas, por lo que una primera fila
  de datos lejana (p. ej. 2000) no se puede ver ni aplicar con los valores por
  defecto.
- **Plan:** primero un test de paridad automatizado DuckDB vs. JS sobre todos los
  fixtures. Después, arreglos pequeños e independientes, cada uno validado contra
  ese test. **Objetivo: que los dos parsers funcionen de manera idéntica** (§7.0).
- Nuevas funciones propuestas:
  - **tipo por columna elegido por el usuario** (§10); la unidad por columna ya
    existe;
  - **una columna de texto como etiqueta del hover** en series temporales y 2D
    (§11). Hoy las columnas de texto se cargan, pero no se muestran en ninguna
    parte, y en el zoom lazy ni siquiera se consultan.

## 1. Método y niveles de evidencia

Cada afirmación lleva una etiqueta:

- **[app]**: reproducido en la app real. Servidor `vite` y Chromium (Playwright),
  archivo cargado por `#file-input`, comparando `window.app.plotManager.files`.
  Cada archivo se cargó **dos veces**: con DuckDB y con
  `localStorage.omv_disable_duckdb = '1'` (camino JS). Se comparó, por variable,
  `dataType`, longitud, número de NaN, suma de los finitos y los 3 primeros
  valores.
- **[código]**: leído en el código fuente, con referencia `archivo:línea`.
- **[DuckDB aislado]**: comportamiento SQL comprobado ejecutando DuckDB-WASM
  (`node_modules/@duckdb/duckdb-wasm`, motor v1.4.3) fuera de la app. **No
  reproducido en la app**; conviene que el verificador lo confirme.
- **[inferido]**: razonamiento no comprobado.

Limitación del entorno: `npm ci` falló por un 403 al descargar `xlsx` desde
`cdn.sheetjs.com`. Las dependencias se instalaron aparte y `xlsx` se sustituyó por
`xlsx@0.18.5` de npm, lo que no afecta al camino CSV.

## 2. Mapa de caminos de carga CSV

Punto de entrada: `_parseCsvResultBuffer` (`src/app/methods/file-methods.js:3741`).

1. **Perfil automático.** Si el llamador no trae perfil,
   `_inspectCsvSample` (`file-methods.js:2466`) ejecuta
   `CsvParser.inspectSample(..., { maxRows: 700 })` sobre el comienzo del archivo
   (`_readFileSampleBuffer`). El perfil incluye delimitador, cabecera,
   `dataStartIndex`, eje de tiempo detectado (`csv-time-detection.js`) y
   `sampleRows` = **primeras ≤100 filas de datos** (`src/parsers/csv-parser.js:266`).
2. **Camino DuckDB** (`file-methods.js:3765-3783`). Condiciones:
   - hay un objeto `File`;
   - `_canUseDuckDb()` (`file-methods.js:3828`): no es build portable
     (`__OMV_PORTABLE__`), no es `file://`, hay Worker y WebAssembly, y no está
     `omv_disable_duckdb`;
   - `csvProfile.encoding` es `utf-8`.

   `_loadWholeOrLazy` elige completo o lazy según
   `DUCKDB_LAZY_THRESHOLD_BYTES` = 300 MB (`file-methods.js:2309`).
   **El tamaño no decide si se usa DuckDB.**
3. **Caída a JS.** Ante cualquier error de DuckDB, si el archivo es menor que
   `LEGACY_CSV_FALLBACK_MAX_BYTES` = 450 MB (`file-methods.js:2317`), se usa el
   parser JS con un `console.warn`. **El usuario no ve ningún aviso.** Por encima
   de 450 MB, el error se propaga.
4. **Camino JS (legacy)** (`file-methods.js:3790-3810`). Corre en el worker
   (`src/workers/parse-handlers.js`), o en el hilo principal si no hay worker.
   - Con perfil revisado por el usuario (`profileSource === 'user'`) usa
     `parseWithProfile`.
   - Si no, usa `parse()`, que **ignora el perfil automático** y vuelve a detectar
     todo sobre el texto completo.
5. **Otros consumidores del mismo perfil y de la misma lógica de tipos:**
   - live-append: DuckDB usa `appendCsvDelta`, JS usa `parseRowsWithProfile`;
   - conversión a Parquet: `duckdb-source.js` (navegador) y
     `src/data/csv-to-parquet-core.js` (escritorio, DuckDB nativo).

   Tanto `inferDuckDbCsvType` como `csvColumnSpecs` están **duplicados** en
   `csv-to-parquet-core.js:58-108`.

### 2.1 Cómo se decide el tipo de cada columna

| Camino | Filas usadas | Regla | Columna vacía en esas filas |
|---|---|---|---|
| DuckDB, perfil automático | `sampleRows` (≤100) con tiempo válido (`duckdb-source.js:3476-3484`) | `nonEmpty>0 && ratio>0.5` (`duckdb-source.js:3486-3500`) | **VARCHAR** |
| DuckDB, perfil del usuario | `numericColumnIndexes` del diálogo | calculado con las **líneas visibles de la vista previa** (`csv-parsing-preview-dialog.js:84-98`, llamado en `:1627`; `lineLimit` por defecto 10, `:710`) | **VARCHAR** |
| JS `parse()` / `parseWithProfile()` | **columna completa**, filas con tiempo válido | `isMostlyNumericColumn`: `finite/nonEmpty > 0.5` (`csv-parser.js:19-24`) | **numérica** |
| JS live-append | `profile.numericColumnIndexes`, si no los ≤100 `sampleRows` | `_numericColumnIndexSet` (`csv-parser.js:579`) | depende |
| Parquet (escritorio) | igual que DuckDB | `csv-to-parquet-core.js:96-108` | **VARCHAR** |

En DuckDB todas las columnas se leen como `VARCHAR` y luego se proyectan con
`try_cast(... AS DOUBLE)` (`_numericCastSql`, `duckdb-source.js:3852-3857`).
Por eso el tipo decidido en el perfil es definitivo.

[código] Según el análisis del código, `parseWithProfile` recalcula los tipos con
los datos completos e ignora `profile.numericColumnIndexes`. En cambio,
`attachCsvProfile` (`file-methods.js:3747-3749`) vuelve a colgar el perfil de
entrada en `metadata.csvProfile`, y el live-append usa los índices de ese perfil.
Consecuencia posible: **el tipo de una columna puede diferir entre la carga
inicial y las filas añadidas después.** [inferido: no reproducido]

## 3. ¿Por qué DuckDB también para archivos pequeños?

No hay ninguna razón específica para archivos pequeños en commits ni en
documentación. La historia:

- **`bfd5ef5`** (2026-05-23), *"phase1.A: drop-in DuckDB-WASM parser (CsvParser
  fallback)"*. DuckDB se introduce como camino por defecto: *"tries DuckDB when
  available … falls back transparently to the legacy CsvParser path on failure"*.
  En esa versión se usaba `read_csv_auto(..., sample_size=20000)`, es decir, el
  detector de DuckDB con 20 000 filas de muestra.
- El comentario en `file-methods.js:3765-3766` da los motivos generales: *"it
  bypasses the ~512 MB string ceiling of the legacy parser and returns
  typed-array columns"*. `docs/perf-optimization-results.md` mide un CSV de
  113 MB: 17,4 s → 1,6 s.
- **`1d65d80`** (2026-05-24), *"guide DuckDB with CSV time pre-scan"*, y
  **`a1bfbc4`** (2026-05-24), *"read profiled CSVs with explicit DuckDB schema"*.
  Se sustituye `read_csv_auto` por `read_csv(auto_detect=false, columns=...)` con
  el perfil de la app, para ganar su mejor detección de cabeceras, unidades y
  fechas localizadas. **Desde entonces el tipo sale de las ≤100 `sampleRows`.**
  Los commits no justifican el número 100.
- **`3274b5f`** *"Unify CSV numeric typing across parsers"* unificó la **regla**
  (>50 %), pero no **las filas sobre las que se aplica** (muestra vs. columna
  completa).

Conclusión: la decisión fue "DuckDB primero, siempre". El comportamiento en
archivos pequeños no se evaluó por separado. Hay ventajas reales incluso en
archivos pequeños: un solo camino, columnas tipadas y un worker propio. Pero hoy
"un solo camino" no se cumple, porque la caída silenciosa a JS mantiene dos
semánticas vivas.

## 4. Divergencias reproducidas en la app [app]

Se cargaron 66 archivos: los 65 de `test-files/csv/**` que no son `.md`, más el
CSV del usuario.

- **55 fixtures**: pasaron por DuckDB y dieron un resultado **idéntico** al
  camino JS.
- **4 fixtures**: **cayeron a JS en silencio** (tabla 4.2).
- **5 fixtures y el CSV del usuario**: **divergen** (tabla 4.1).

### 4.1 Archivos con resultados distintos

| Archivo | Síntoma | Causa |
|---|---|---|
| `finanzas_unificadas_2016-2026.csv` (usuario, 6706 filas) | **17 columnas numéricas → `string`** en DuckDB, `real` en JS. Ejemplos: `saldo_monabanq_eur`, `total_bancos_xpf/eur`, `dinero_total_estimado_xpf/eur`, `axa_*`, `variacion_marara_desde_aviso_previo_xpf`, `dias_desde_aviso_previo`. | Sin valores en las primeras 100 filas: el primer valor aparece en la fila 312 (`variacion_*`, `dias_*`), 3867, 4555 o más tarde. `debito_livret_eur` está vacía en todo el archivo. |
| `csv/BILAN.CSV` | 5 columnas (`column_9..13`) → `string` en DuckDB | igual (vacías en la muestra) |
| `csv/ecb_euro_exchange_rates_daily.csv` | **19 columnas, en ambos sentidos** (ver abajo) | muestra vs. columna completa, y la regla del 50 % |
| `date-parsing-options/06_italian_month_names.csv` | DuckDB **pierde 1 de 4 filas** (`10-Febbraio-2024`) | la tabla SQL de meses es más corta que la de JS |
| `date-parsing-options/07_portuguese_month_names.csv` | DuckDB **pierde 2 de 4 filas** (`Fev`, `Março`) | igual |
| `csv/07_iowa_electricity_long_format.csv` | mismo contenido, **orden distinto** entre filas con el mismo timestamp | `ORDER BY` de DuckDB no estable (`duckdb-source.js:2021`); JS conserva el orden del archivo |

Detalle del archivo del BCE. El archivo va del más reciente al más antiguo, y
varias monedas dejaron de cotizar o empezaron tarde.

- **DuckDB `string`, JS `real`** (7 columnas): `CYP, MTL, ROL, SIT, SKK, ISK, TRL`.
  Las primeras 100 filas son `N/A` porque la moneda ya no existe.
- **DuckDB `real`, JS `string`** (12 columnas): `RON, HRK, RUB, TRY, BRL, CNY, IDR,
  INR, MXN, MYR, PHP, THB`. En la columna completa hay más de 50 % de `N/A`
  (p. ej. `RON`: 1663 `N/A` y 1138 números), así que **el parser JS las declara
  texto**. DuckDB acierta aquí solo porque la muestra cae en la zona con datos.

Por eso "hacer que DuckDB imite al JS" **no basta**. La regla del JS también
falla con columnas numéricas que tienen muchos marcadores de "sin dato".

Meses: `_normalizedMonthNameSql` (`duckdb-source.js:3783`) solo traduce una lista
reducida (inglés, francés, español y parte de las demás), mientras que
`MONTH_LOOKUP` (`src/parsers/csv-time-detection.js:~71`) incluye italiano,
portugués y alemán completos. Las fechas no reconocidas dan NULL, y
`WHERE time IS NOT NULL` elimina la fila **sin aviso**.

### 4.2 Caídas silenciosas a JS

| Archivo | Mensaje en consola |
|---|---|
| `16_modelica_combitimetable_format.csv` | `DuckDB CSV path does not yet support variable-width whitespace delimiters.` |
| `Campbell_Total_10minutes.txt` | igual |
| `171205-095039_UG.CSV` | `windows-1252 text is handled by the legacy parser.` (se salta DuckDB a propósito) |
| `date-parsing-options/03_us_mdy_slash_datetime.csv` | `DuckDB CSV profile produced no valid time rows; falling back.` El formato es `01/31/2024 01:45 PM`: el SQL no reconoce AM/PM. |

Bajo 450 MB el resultado final es correcto, porque el parser JS lo resuelve. Por
encima de 450 MB estos archivos **fallarían**.

## 5. Otras divergencias (código y DuckDB aislado, no reproducidas en la app)

Ordenadas por impacto estimado. Pendientes de confirmar en la app con fixtures
nuevos (etapa 0).

1. **Fecha ISO con `CAST` en vez de `TRY_CAST`** (`duckdb-source.js:3620`).
   [código] Una sola celda ISO no vacía e inválida hace fallar toda la consulta.
   Por debajo de 450 MB hay caída silenciosa a JS; por encima, error.
   [DuckDB aislado]
2. **Desfase horario ISO** (`2024-01-01T10:00+02:00`): DuckDB ignora el `+02:00`
   (10:00Z) y JS lo aplica (08:00Z). [DuckDB aislado]
3. **Coma decimal.** En modo `auto`, DuckDB decide una sola vez para todo el
   archivo, con los `sampleRows` (`_csvUsesDecimalComma`, `duckdb-source.js:3508`),
   y reemplaza **todas** las comas. JS decide celda a celda y reemplaza solo la
   primera (`parseCsvNumber`, `csv-time-detection.js:90-115`). La opción
   `decimal_separator=','` de `read_csv` no tiene efecto, porque todo se lee
   como `VARCHAR`. [código + DuckDB aislado]
4. **Números.** `1d5` (exponente Fortran), `1 234` y `0x1F` dan NULL en DuckDB y
   un número en JS. `1_000` da 1000 en DuckDB y NaN en JS. En una columna de
   tiempo numérica, `inf`/`nan` se conservan en DuckDB y se descartan en JS.
   [DuckDB aislado]
5. **Formatos de fecha SQL más estrechos que los de JS**: AM/PM (confirmado en la
   app, ver 4.2), fracciones de segundo de más de 6 dígitos, y año `69` (1969 en
   DuckDB, 2069 en JS). [DuckDB aislado]
6. **Ancho de fila.** DuckDB (`ignore_errors=true`, sin `null_padding`) conserva
   las filas con campos vacíos extra al final (`1,5,,`). JS descarta toda fila
   cuyo ancho difiera de la cabecera (`csv-parser.js:78`). [DuckDB aislado]
7. **Filtro de filas con celda vacía.** En DuckDB `NULL = ''` y `NULL <> 'x'` son
   NULL, así que la fila se excluye. JS la conserva (`duckdb-source.js:3424-3434`).
   [código + DuckDB aislado]
8. **Textos.** DuckDB no les quita los espacios iniciales y finales; JS sí.
   [DuckDB aislado]
9. **`dataType`.** Una columna solo con 0 y 1 es `boolean` en JS
   (`_detectDataType`) y siempre `real` en DuckDB. [código]
10. **Metadatos.** El resultado de DuckDB no trae `reorderedRows`,
    `skippedInvalidTimeRows` ni `numericColumnIndexes`. [código]
11. **Comilla suelta dentro de un campo** (`12"pipe`): en JS abre un bloque
    entrecomillado que se traga el resto del archivo; DuckDB la toma literal.
    [DuckDB aislado]
12. **Nombres de columna que solo difieren en mayúsculas**: DuckDB falla por
    duplicados y se cae a JS. [DuckDB aislado]
13. **Muestra que corta un carácter UTF-8 multibyte a la mitad**: el decodificador
    estricto falla, se reinterpreta como windows-1252 y **se salta DuckDB**.
    [mecanismo comprobado aislado; frecuencia inferida]

## 6. Vista previa CSV (`src/ui/csv-parsing-preview-dialog.js`)

### 6.1 Filas omitidas visibles

- `entry.isPreamble = ... logicalIndex < structureStart`, donde
  `structureStart = headerIndex` si hay cabecera (`:1283-1287`). "Hide preamble
  rows" (`state.hidePreambleRows`, activada por defecto, `:713`) solo oculta lo
  que está **encima de la cabecera**.
- Las filas **entre la cabecera y la primera fila de datos** se muestran en gris
  (`tr.is-skipped`, estilo en `src/styles/overlays.css:~2158`) y ninguna casilla
  las oculta.
- El tooltip de esa casilla dice *"Hide initial source rows before the first data
  row in this preview only."* (`src/i18n/translations.js:756`). **El
  comportamiento no coincide con lo que promete.**
- "Hide invalid lines" (`:714`, filtro en `:1272`) solo afecta a filas de datos
  (`logicalIndex >= dataStart`) con filtro no cumplido, ancho incorrecto o tiempo
  inválido (`:1303`). Por diseño, nunca oculta filas anteriores a los datos.

### 6.2 La vista previa solo contiene las primeras N líneas

- `inspectPreview` devuelve las primeras `lineLimit` filas del archivo: 10 por
  defecto (`:710`), máximo `MAX_PREVIEW_LINES = 5000` (`:7`). No hay paginación
  ni ventana.
- Cambiar "First data row" no amplía lo cargado. Solo cambiar "Lines shown"
  dispara `_ensurePreviewSampleForLineLimit`.
- Resultado con primera fila de datos = 2000 y 10 líneas (según el análisis del
  código y una prueba de la clase del diálogo en Node):
  - las filas de datos **no están cargadas**;
  - la validación falla ("No visible data rows match the header width." /
    "Selected time column is empty.");
  - **Apply queda desactivado**, y nada indica que haya que subir "Lines shown"
    por encima de 2000.
- Con 2100 líneas funciona, pero se renderizan unas 2000 filas grises antes de
  los datos.
- Una primera fila de datos por encima de 5000 **no se puede aplicar**.
- Los tipos del perfil del usuario (`numericColumnIndexes`) salen de esas filas
  visibles (§2.1). Con los valores por defecto son unas 9 filas.

## 7. Plan por etapas

Principio: **ningún cambio de comportamiento sin un test que lo fije antes.**
Cada etapa es un PR independiente y reversible. El test de la etapa 0 debe
seguir pasando, o su lista de diferencias esperadas debe cambiar
explícitamente en el PR.

### 7.0 Requisito transversal: tests de paridad entre los dos parsers

**Objetivo final: que ambos parsers funcionen de manera idéntica.** Para el
mismo archivo y el mismo perfil, DuckDB y el parser JS deben producir las mismas
variables, los mismos tipos, las mismas unidades, los mismos valores (NaN
incluidos) y el mismo orden. Los tests que lo verifican son obligatorios y
cubren **todos los modos**, no solo la carga inicial:

| Modo | Qué se compara |
|---|---|
| DuckDB carga completa vs. JS (worker) | todas las variables: `dataType`, longitud, valores (hash exacto, NaN por posición), orden, nombre, unidad, descripción |
| DuckDB lazy vs. JS | vista general + una consulta de zoom sobre una ventana fija: mismos valores en esa ventana |
| JS en worker vs. JS en hilo principal | resultado idéntico (hoy se asume) |
| Perfil automático vs. perfil revisado por el usuario sin cambios | resultado idéntico |
| Perfil del usuario con cambios (nombre, filtro, primera fila, y tipo/unidad de la §10) | ambos parsers respetan el perfil del mismo modo |
| Live-append (DuckDB `appendCsvDelta` vs. JS `parseRowsWithProfile`) | las filas añadidas tienen el mismo tipo y valor que en una carga completa del archivo final |
| Recarga (Reload) | igual a una carga nueva |
| Conversión a Parquet (navegador y escritorio) → carga del Parquet | igual a la carga del CSV |

Reglas:

- Cada fixture nuevo (§5, etapa 0) entra en la batería. **Cada bug de parsing
  corregido añade un fixture que lo reproduce.**
- Las diferencias conocidas y aceptadas quedan en una lista explícita
  (`backend-parity-expected.json`) con su motivo. El objetivo es que esa lista
  quede vacía.
- Un PR que toque `csv-parser.js`, `csv-time-detection.js`, `duckdb-source.js`
  (parte CSV), `csv-to-parquet-core.js` o el diálogo de vista previa debe
  ejecutar la batería y no puede introducir diferencias nuevas.
- Se comprueban además, sin comparar entre parsers, los casos que hoy solo
  existen en un camino: separador de espacios variables y windows-1252 (solo
  JS). El test verifica que la caída a JS ocurre y queda visible.

### Etapa 0: test de paridad DuckDB vs. JS (sin cambiar comportamiento)

- Script `scripts/e2e-csv-backend-parity.mjs`, con el patrón de
  `scripts/e2e-*.mjs` (`vite` `createServer` + Playwright):
  - carga cada fixture de `test-files/csv/**` con y sin DuckDB;
  - compara, por variable, `dataType`, longitud, NaN, suma y un hash de los
    valores, más el backend usado.
- Un archivo `test-files/csv/backend-parity-expected.json` registra las
  diferencias **conocidas** (las de §4) con su explicación. El test falla ante
  cualquier diferencia nueva o ante una conocida que desaparezca, obligando a
  actualizar la lista a conciencia.
- Añadir fixtures mínimos para cada caso de §5:
  - columna numérica dispersa (primer valor en la fila 150);
  - columna con mayoría de `N/A`;
  - ISO con desfase horario;
  - ISO con una celda mala;
  - AM/PM;
  - coma decimal tardía;
  - `1d5` y `1 234`;
  - filas `1,5,,`;
  - filtro sobre celda vacía;
  - textos con espacios.
- Hacer **visible la caída a JS**: por ejemplo `metadata.backend` más un motivo,
  y como mínimo un registro accesible desde el test.
- Riesgo: nulo (solo tests e instrumentación).
- Aceptación: el test pasa en `main` con exactamente las diferencias de §4 y §5
  documentadas.

### Etapa 1: tipos de columna (el problema reportado)

- Objetivo: un único criterio de tipo para todos los caminos, basado en **la
  columna completa** y no en una muestra.
- Propuesta para DuckDB:
  - mantener la lectura como `VARCHAR`;
  - para las columnas **no decididas** por la muestra (sin valores en ella), o
    para todas si el costo lo permite, calcular en DuckDB, sobre la tabla
    completa, `count(nonEmpty)` y `count(try_cast IS NOT NULL)`;
  - aplicar la misma regla que JS.

  Es una sola consulta agregada. En modo lazy (>300 MB) medir el costo antes de
  activarla; alternativa: muestreo repartido por todo el archivo.
- Revisar la regla en sí (decisión del autor, §8):
  - tratar tokens de "sin dato" (`N/A`, `NA`, `-`, `null`, `#N/A`…) como vacíos
    y no como no-numéricos;
  - así `RON`/`HRK` del BCE pasan a numéricas en ambos caminos.
- Perfil del usuario:
  - dejar de derivar `numericColumnIndexes` solo de las líneas visibles;
  - o bien que el diálogo solo *fuerce* tipos que el usuario haya cambiado a mano
    y deje el resto a la inferencia completa.
- Unificar la copia duplicada de `csv-to-parquet-core.js` con la de
  `duckdb-source.js`.
- Riesgo: medio. Cambia tipos de columnas existentes, y con ello variables
  guardadas en sesiones o layouts.
- Aceptación:
  - `finanzas`, `BILAN.CSV` y las 7 columnas del BCE pasan a numéricas en
    DuckDB, idénticas a JS;
  - ningún otro fixture cambia.

### Etapa 2: tiempo en SQL a la par con JS

- Completar la tabla SQL de meses con toda `MONTH_LOOKUP`, idealmente
  **generándola desde la misma constante** para que no vuelvan a divergir.
- AM/PM, más de 6 dígitos de fracción, año de 2 dígitos con el mismo pivote que JS.
- ISO: `TRY_CAST` en lugar de `CAST`, y soporte de desfase horario (o, si no se
  puede en SQL, una caída explícita a JS).
- Orden estable: `ORDER BY time, <número de fila del archivo>`. Hay que obtener
  ese número; `read_csv` tiene `file_row_number`, pero ya se descartó una vez por
  costo (comentario en `duckdb-source.js:~2702`), así que medir.
- Riesgo: bajo a medio.
- Aceptación: `06_italian`, `07_portuguese`, `03_us_mdy` e `iowa` idénticos entre
  caminos.

### Etapa 3: vista previa

- 3a. "Hide preamble rows" oculta **todo lo anterior a la primera fila de datos,
  salvo la cabecera y la fila de unidades**, como dice su tooltip
  (`_annotatePreviewRowEntry`, `:1283`). Revisar los mensajes
  `_onlyPreambleLoadedMessageInfo` / `_hiddenRowsMessage`. No se recomienda
  mezclarlo con "Hide invalid lines": esas filas no son inválidas, y se
  ocultaría la cabecera.
- 3b. Al cambiar "First data row" más allá de lo cargado:
  - como mínimo, un mensaje claro;
  - mejor, cargar una **ventana** alrededor de la primera fila de datos
    (cabecera + unidades + `dataStart − k … dataStart + lineLimit`) en lugar de
    las primeras N líneas, lo que elimina el límite de 5000 y las miles de
    filas grises.

  Las entradas ya distinguen `logicalIndex` / `sourceIndex`.
- Riesgo: bajo (solo UI del diálogo), salvo 3b, que toca `inspectPreview`.
- Aceptación: con primera fila de datos = 2000 en `finanzas`, con los valores
  por defecto, se ven las filas de datos y Apply se habilita.

### Etapa 4: detalles de números y textos (§5.3–5.13)

- Decidir caso por caso qué semántica es la correcta (coma decimal por celda,
  `1d5`, espacios en textos, `boolean`, filas `1,5,,`, filtro con NULL, comilla
  suelta) y alinear ambos caminos.
- Cada punto entra en el test de paridad.
- Riesgo: bajo por punto, pero son muchos puntos pequeños.

### Etapa 5 (opcional, decisión de diseño): política de backend

Evaluar con datos del test de paridad y tiempos medidos:

- (a) mantener "DuckDB siempre";
- (b) usar JS por debajo de cierto tamaño, pagando dos semánticas vivas;
- (c) mantener DuckDB, pero avisar en la UI cuando se cae a JS.

Con las etapas 1 y 2 hechas, (a) o (c) parecen suficientes.

### Etapa 6: tipo de columna elegido por el usuario (ver §10)

Depende de la etapa 1. Añade el campo `type` a `columnOverrides` y un helper
compartido que respeten todos los caminos.

### Etapa 7: columna de texto como etiqueta del hover (ver §11)

Independiente de las etapas 2–6. La etapa 7a (modo completo y cursores) puede
hacerse pronto. La 7b (modo lazy) depende del orden estable de la etapa 2.

## 8. Decisiones pendientes para el autor

1. ¿Qué debe pasar con una columna numérica con mayoría de `N/A`? Hoy es
   `string` en JS y depende de la muestra en DuckDB.
2. ¿Una columna **totalmente vacía** es numérica (hoy en JS) o texto (hoy en
   DuckDB)?
3. En modo lazy, ¿se acepta una consulta extra sobre todo el archivo para decidir
   tipos, o se prefiere un muestreo repartido?
4. ¿Coma decimal por celda (JS) o por archivo (DuckDB)?
5. ¿La caída a JS debe mostrarse al usuario?
6. Tipo por columna (§10): ¿solo Numérico/Texto, o también Booleano?
7. Etiqueta de hover (§11): ¿por archivo (propuesto) o por traza? ¿Largo máximo
   de la etiqueta?

## 9. Guía para verificar este documento

- **Reproducir §4:** instalar dependencias, lanzar `npx vite --port 8000` y cargar
  cada archivo con y sin `localStorage.omv_disable_duckdb = '1'`. Comparar
  `Object.values(app.plotManager.files)[0].data.variables[*].dataType` y
  `data.metadata.backend`. Ojo: `data._duckdb` solo existe en modo lazy; para
  saber si se usó DuckDB hay que mirar `metadata.backend`.
- **Muestra de 100 filas:** `csv-parser.js:266`. **Inferencia DuckDB:**
  `duckdb-source.js:3443-3500`. **Regla JS:** `csv-parser.js:19-24`.
- **Posición del primer valor por columna en el CSV del usuario**, con Python:
  `csv.reader`, índice de la primera celda no vacía por columna.
- **Historia:** `git show -s bfd5ef5 1d65d80 a1bfbc4 3274b5f`. Si el clon es
  superficial, hacer antes `git fetch --unshallow`.
- **Puntos a confirmar en la app antes de actuar:** los marcados
  **[DuckDB aislado]** e **[inferido]** en §2.1 y §5.

## 10. Nueva función: tipo y unidad por columna

### 10.1 Lo que ya existe

- En el diálogo de vista previa, la casilla **"Show column options"**
  (`state.showColumnTools`, `csv-parsing-preview-dialog.js:1919-1930`) despliega
  un editor por columna (`_renderColumnControls`, `:2009-2092`) con:
  - "usar columna" (`ignoredColumns`);
  - **nombre**;
  - **unidad**. Ya existe desde `8bdf036` (2026-09-20, *"Say what a time column
    measures, and let it be corrected"*), también para la columna de tiempo.
- Todo se guarda en `state.columnOverrides[index] = { name?, description? }`.
  La unidad se guarda como `description: "[unidad]"`, que es lo que leen los
  ejes y el hover mediante `_extractUnit` (`plot-manager.js:~4750`). [código]
- El perfil del usuario (`metadata.csvProfile`) persiste en sesiones, recarga y
  live-update. [código]

**Por lo tanto, lo que falta es solo el tipo.** La unidad ya se puede cambiar.

### 10.2 El tipo hoy

- El diálogo no muestra qué tipo detectó para cada columna. `numericColumnIndexes`
  solo se usa para marcar en rojo las celdas inválidas (`:1297`, `:2245-2251`).
  [código]
- ¿Cada camino respeta el tipo del perfil? [código]

| Camino | ¿Respeta el tipo del perfil? |
|---|---|
| DuckDB completo y lazy (`_csvColumnSpecs`) | sí |
| DuckDB live-append | sí |
| JS `parse` / `parseWithProfile` / worker | **no**: recalcula con la columna completa (`csv-parser.js:173`, `:468`) |
| JS live-append (`_numericColumnIndexSet`) | sí |
| Conversión a Parquet | sí |

Esto confirma la inconsistencia de §2.1. En el camino JS, la carga inicial usa
tipos de la columna completa, y la recarga y el live-append usan los del diálogo.

### 10.3 Diseño propuesto

- **Modelo.** Extender `columnOverrides[index]` con `type?: 'numeric' | 'string'`.
  Si el campo no existe, el tipo es "auto". Los perfiles guardados sin `type`
  siguen funcionando como hoy.
- **Un solo helper compartido**, por ejemplo
  `resolveCsvColumnType(profile, index, autoType)`, usado por:
  - `_csvColumnSpecs` y `csvColumnSpecs`, que conviene fusionar antes porque hoy
    están duplicados;
  - `parse` / `parseWithProfile`;
  - `_numericColumnIndexSet`;
  - el marcado rojo del diálogo.

  El tipo forzado gana siempre. "Auto" queda como hoy, o como defina la etapa 1.
  La columna de tiempo no admite forzar el tipo.
- **Interfaz.** El editor existente se convierte en una tabla por columna:
  usar | nombre | **tipo** | unidad.
  - El selector de tipo ofrece "Auto (numérico)" (mostrando lo detectado),
    "Numérico" y "Texto".
  - Si se fuerza "Numérico" sobre una columna con texto, se avisa: "N de M celdas
    de la muestra quedarán vacías (NaN)".
  - Se añade una fila de tipo en la cuadrícula, junto a "Detected units".
- **Semántica.**
  - Numérico forzado: se aplica `parseCsvNumber`, y lo que no se pueda convertir
    queda NaN (`try_cast` → NULL → NaN en DuckDB; verificar
    `_extractColumnAsFloat64`).
  - Texto forzado: texto crudo sin espacios en los extremos, igual en los dos
    caminos (ver §5.8).
  - Una unidad en una columna de texto se permite, pero no tiene efecto.
- **Otros tipos.**
  - Booleano: posible, porque `dataType: 'boolean'` ya existe aguas abajo
    (true/false/sí/no → 1/0).
  - Categórico: innecesario; lo cubre Texto.
  - Fecha como columna secundaria: aplazar, requiere soporte propio.
- **Validación.** El diálogo debe impedir nombres duplicados tras renombrar:
  hoy DuckDB no deduplica y los nombres chocarían en `columns=`. [código]

### 10.4 Riesgos

- Cambiar el tipo cambia `dataType`. Una sesión o layout que tenía la variable
  graficada como numérica puede quedar con una variable no graficable.
- Si el archivo cambia, la recarga con el perfil guardado puede convertir en NaN
  toda una columna forzada a numérica sin avisar.

### 10.5 Tests

- Batería de paridad (§7.0), con fixtures y perfiles que:
  - fuerzan Numérico sobre texto;
  - fuerzan Texto sobre números;
  - dejan Auto.

  JS (`parseWithProfile` y worker), DuckDB completo y lazy, live-append de ambos
  y Parquet deben dar el mismo `dataType` y NaN en las mismas posiciones.
- Sesión: ida y vuelta conserva `type`, y un perfil antiguo sin `type` se
  comporta como hoy.
- i18n: claves nuevas en EN/FR/ES (`test-i18n-consistency`).

## 11. Columnas de texto y etiqueta en el hover

### 11.1 ¿Se cargan o se descartan las columnas de texto?

**Se cargan en todos los modos, pero no se usan en casi ninguna parte.**
Verificado con el CSV del usuario (6706 filas) en DuckDB completo, DuckDB lazy
(forzado con `csvFullLoadMb = 0.001`) y JS. [app]

| Modo | ¿Se cargan? | Detalle |
|---|---|---|
| JS (hilo principal o worker) | sí, arreglo completo | se reordenan junto con los números al ordenar por tiempo (`csv-parser.js:755-783`) [app] |
| DuckDB completo | sí, arreglo completo | `_extractColumnAsStrings` (`duckdb-source.js:4185`), NULL → `''` [app] |
| DuckDB lazy, vista general | sí, alineadas con las filas de la vista general | filas completas cada N (`_overviewSql`, `:3944-3961`) [app] |
| DuckDB lazy, **zoom y consultas en bruto** | **no** | todas las consultas usan `try_cast(... AS DOUBLE)` (`_valueExpressionSql` con `castDouble: true`, p. ej. `:745`, `:1091`); pedir `descripcion` devuelve `null` [app] |
| Parquet | sí | mismo `_buildLegacyFromArrow` [código] |

Qué hace la interfaz con ellas:

- **Barra lateral:** aparecen con el icono 🔤 y la etiqueta `(string)`, no son
  arrastrables (`tree-methods.js:588-590`).
- **Gráficos:** `addTrace` las rechaza (`plot-manager.js:1389`). También las
  rechazan las variables derivadas y Data Tools.
- **Único uso actual:** el filtro de filas del diálogo CSV (p. ej.
  `tipo_fila == movimiento`).
- **Ninguna parte de la app muestra el valor de un texto** (ni tabla, ni
  inspector, ni tooltip).

Efecto colateral del bug de §4: en DuckDB el archivo del usuario tiene 27
columnas "de texto" y en JS 10. Las 17 de diferencia son numéricas mal tipadas.

### 11.2 Cómo funciona hoy el hover

- **Series temporales** (`_buildTimeTrace`, `data-methods.js:1915-2102`):
  - `hovertemplate` = tiempo + `<b>nombre</b> = %{y:.4g}`;
  - `customdata` ya se usa para el tiempo formateado (ejes de calendario de alta
    resolución o duración);
  - `text` ya se usa para la decoración "Repeated".
  - **`hovertext` no se usa en ningún sitio** (verificado con `grep`), así que
    queda libre.
- **2D / fase** (`_buildPhase2DTraces`, `:2264-2289`): sin `hovertemplate`, se
  usa el hover por defecto de Plotly.
- **Qué puntos hay en pantalla:**
  - modo completo: `decimateRangeIndexes` (`src/compute/kernels/resample.js`),
    que ya trabaja con **índices** (mín./máx. por cubeta), así que alinear un
    tercer arreglo es directo;
  - transformaciones (recorte, desplazamiento de tiempo, inversión) mediante
    `indexes`;
  - cortes de línea con NaN insertados (`_insertTraceGapBreaks`,
    `interaction-methods.js:1133`), que arrastran `customdata` pero **no
    `text`** (posible desalineación latente de "Repeated"; no reproducida);
  - modo lazy: al hacer zoom, cuando hay muchas filas en la ventana, DuckDB
    devuelve `MIN`/`MAX` por cubeta, colocados en los bordes de la cubeta
    (`duckdb-source.js:~1218`, `_expandMinMaxBucketResult`). **Son puntos
    sintéticos, no filas reales.**
- **Cursores A|B** (`interaction-methods.js:2290+`): interpolan el valor en la x
  del cursor. En modo completo usan la serie fuente sin diezmar.

### 11.3 Diseño propuesto: "Usar como etiqueta del hover"

- **Dónde vive:** por archivo. Se guarda como `fileEntry.hoverLabelVar` (nombre
  de una columna de texto, o `null`) y se persiste en la sesión. Se activa desde
  el menú contextual de una fila 🔤 de la barra lateral. Todas las trazas de ese
  archivo, en series temporales y en 2D, muestran la etiqueta. Hacerlo por
  gráfico no sirve, porque un gráfico puede mezclar archivos.
- **Cómo mostrarla:** en `hovertext`, añadiendo al `hovertemplate` una línea
  `%{hovertext}`. No toca `customdata` ni `text`. Truncar a unos 80 caracteres y
  escapar HTML. Si la etiqueta está vacía, no se muestra la línea.
- **Cómo mantener una etiqueta por punto dibujado:**
  - modo completo, series temporales:
    - que el diezmado devuelva los índices elegidos;
    - aplicar los mismos índices de transformación;
    - arrastrar `hovertext` en los cortes de línea (`''` en los huecos), en el
      relleno de pilas y en los dos caminos de *restyle*.

    Con mín./máx. por cubeta, la etiqueta es la de la fila que produjo el
    mín./máx.: justo lo que se busca ("¿qué gasto es este pico?").
  - modo completo, 2D: mismos índices de paso.
  - modo lazy:
    - vista general: las etiquetas ya están en memoria y alineadas;
    - zoom en bruto: añadir `CAST("col" AS VARCHAR) AS lbl` al mismo SELECT;
    - zoom agregado: usar `arg_min(lbl, v)` / `arg_max(lbl, v)` por cubeta, y
      mejor también `arg_min(t, v)` / `arg_max(t, v)` para que el punto quede en
      su tiempo real;
    - la columna de etiqueta debe entrar en las claves de caché (`_rangeCacheKey`)
      y en la vista previa re-diezmada (`_renderedTracePreview`).
- **Costo:** despreciable en pantalla (unos 2000 puntos por traza). La memoria
  real es la columna de texto completa, que en modo completo ya está cargada.
- **Primer paso barato (7a):** mostrar en el cursor A|B la etiqueta de la fila
  más cercana. En modo completo no depende del diezmado: búsqueda binaria en los
  tiempos fuente, y luego `labels[idx]`.

### 11.4 Riesgos

1. Sin `arg_min` / `arg_max`, en lazy la etiqueta describiría otra fila.
2. Hay al menos 4 caminos que construyen o re-estilan trazas; olvidar uno deja
   etiquetas desalineadas tras el zoom. Mitigación: un test que compare, para un
   punto dado, su etiqueta con la fila fuente.
3. Filas con el mismo timestamp: su orden no es estable entre DuckDB completo,
   lazy y JS (§4, etapa 2), así que en una fecha repetida puede mostrarse otra
   fila. [app: la fila 96 muestra una descripción distinta en lazy y en
   completo]
4. Las columnas numéricas mal tipadas de §4 aparecerían como candidatas a
   etiqueta. Resolver antes la etapa 1.
5. Las variables derivadas y de Data Tools no tienen índice de fila en lazy, así
   que quedan sin etiqueta.

### 11.5 Tests

- Para trazas diezmadas, con cortes de línea, transformadas y en lazy (vista
  general, zoom en bruto y zoom agregado): la etiqueta de cada punto dibujado
  coincide con la columna de texto en la fila fuente de ese punto.
- Mismo resultado con DuckDB y con JS (§7.0).
