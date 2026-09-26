# Límites de tamaño de archivo: estudio y opciones

**Estado: estudio verificado; Opción A implementada, el resto no.** Este
documento describe los límites tal como estaban en el código al escribirlo, qué
hace cada uno realmente, y cuatro opciones de modificación con sus costos. La
sección 6.A dice qué cambió al implementarla; el resto del código sigue como se
describe.

Tuvo dos pasadas: una primera redacción a partir de la lectura del código, y una
segunda que verificó cada afirmación contra el código y, donde se pudo, contra el
comportamiento real (sección 9 lista lo que la segunda pasada corrigió).

La pregunta que lo origina: *¿el único límite necesario no es el que decide
entre lectura completa y lectura parcial? Los demás parecen impedir abrir un
archivo sin razón; lo mejor sería que el navegador abra el archivo más grande
que pueda, sin un tope artificial.*

La respuesta corta es que hay **seis** mecanismos distintos que la palabra
"límite" tapa, y solo uno de ellos es lo que la pregunta supone.

---

## 1. Inventario

### (A) Límites de conmutación — CSV y Parquet

`csvFullLoadMb` y `parquetFullLoadMb`. Por encima del valor, el archivo pasa al
camino lazy de DuckDB en lugar de materializarse. **No impiden abrir nada**:
eligen cómo se abre. Es el límite que la pregunta identifica como necesario, y
lo es.

Resueltos en `src/app/methods/file-methods.js` (`_csvFullLoadLimitBytes`,
`_parquetFullLoadLimitBytes`), con `DUCKDB_LAZY_THRESHOLD_BYTES` y
`PARQUET_LAZY_THRESHOLD_BYTES` como respaldo.

Hay un segundo umbral en esta familia que sí abre un diálogo:
`csvCompactHintMb` (500 MB). Por encima, `_offerLargeTextConversion` pregunta
**antes** de cargar un archivo de texto si se quiere convertir a Parquet, con
las respuestas *revisar la estructura*, *guardar convertido*, *convertir
temporalmente* (solo escritorio), *abrir tal cual* y *cancelar*. Cancelar
detiene la carga. Solo aparece cuando la conversión es posible
(`_canConvertTextFileToParquet`: nativa en escritorio, o vía DuckDB en el
navegador); si no lo es, queda el aviso no bloqueante de `_showLargeCsvParquetHint`
durante la carga. Como el aviso de (B), la respuesta *abrir tal cual* se
recuerda solo durante una carga (`_largeCsvRawApproved`).

### (B) Límites de aviso previo — MAT, Excel, pickle, netCDF

`EAGER_ONLY_FORMATS` en `src/app/file-size-limits.js`. Se comparan contra el
tamaño **en disco**, antes de leer el archivo.

**Ya no impiden abrir el archivo.** Eso cambió: hoy `_confirmOversizedFile`
(`src/app/methods/file-methods.js`) muestra un diálogo con *Cancelar* / *Abrir
igual*, y el "sí" viaja como `allowOversized` hasta el parser para que no lo
vete una segunda vez. La respuesta se recuerda por archivo durante una sola
carga —la pregunta se hace desde varios lugares— y se olvida al terminar; no hay
"no volver a preguntar", deliberadamente.

La comprobación (`_checkFullLoadLimit`) se hace desde seis puntos, todos en
`file-methods.js`, y todos antes de que los bytes entren en memoria:

| Dónde | Cuándo |
|---|---|
| `loadFile` | al abrir cualquier archivo |
| `_expandExcelEntries` | antes de leer el libro para listar sus hojas |
| `_expandMatEntries` | antes de leer el MAT para inspeccionarlo y elegir variables |
| `_readLatestBuffer` | al recargar desde un `FileSystemFileHandle` (el archivo pudo crecer) |
| `_readLocalResultPath`, rama `omvDesktop.readFile` | escritorio, antes de pedir los bytes al proceso principal |
| `_readLocalResultPath`, rama HTTP local | tras un `HEAD` para conocer el tamaño, antes del `fetch` |

### (C) Límite post-decodificación — audio

`audioFullLoadMb`, medido sobre las **muestras decodificadas**, no sobre el
archivo (`checkDecodedAudioLimit` + `decodedAudioBytes`). Audio es el único
formato donde el tamaño en disco no dice nada del costo en memoria: 5 MB de WAV
son ~1,3 M de muestras, 5 MB de MP3 son unas veinte veces más. Por eso audio
está fuera de `EAGER_ONLY_FORMATS` y se pregunta entre decodificar y construir
las columnas. También es aviso con override.

### (D) Techos duros, no anulables

Estos sí rechazan, y `allowOversized` **no** los alcanza:

| Techo | Valor | Dónde | Qué protege |
|---|---|---|---|
| `MATLAB_MAT_MAX_INFLATED_BYTES` | 1536 MB | `src/parsers/matlab-mat-limits.js` | presupuesto total de inflado zlib |
| `MATLAB_MAT_MAX_DENSE_ELEMENTS` | 25 M | `src/parsers/matlab-mat-limits.js` | forma declarada de una matriz sparse |
| `PICKLE_DEFAULT_INTERNAL_LIMITS` | `maxArrayBytes` 512 MB, `maxArrayElements` 50 M, `maxFrameBytes` 128 MB, … | `src/parsers/pickle-limits.js` | tamaños declarados dentro del pickle |
| `fs.readFile` de Node | 2 GiB | `electron/main.cjs`, `omv:read-file` | ninguno: es un límite de Node (`ERR_FS_FILE_TOO_LARGE`) |
| `LEGACY_CSV_FALLBACK_MAX_BYTES` | 450 MB | `src/app/methods/file-methods.js` | el parser JS antiguo decodifica todo a un solo string (~512 MB de tope) |

**Los tres primeros no son límites de tamaño: son "no le creas a la
cabecera".** Un MAT de pocos KB de ceros se expande ~1000:1; una matriz sparse
que declara `[2, 2^30]` es una longitud de array válida en JS y decenas de GB de
relleno desde unos cientos de bytes. Ninguno de los dos se puede detectar
mirando el tamaño del archivo, y ninguno se puede permitir "intentando a ver qué
pasa", porque el intento es precisamente lo que mata la pestaña.

`matlab-mat-limits.js` documenta además por qué es un techo absoluto y no un
ratio de compresión: medido sobre 8 MB de Float64, una señal constante comprime
683:1 y una de ceros 1022:1, mientras que una senoidal apenas 1,1:1. Un ratio no
distingue una bomba de un resultado de simulación legítimo —son la misma
cosa—, así que una regla de 20:1 rechazaba archivos Modelica/Dymola correctos.

**El cuarto no estaba escrito en ningún lado.** En escritorio, los formatos no
streamables (MAT, Excel, pickle, netCDF, audio) se leen con `fsp.readFile` en el
proceso principal, y Node se niega a leer así un archivo mayor de 2 GiB
(`kIoMaxLength = 2^31 − 1`). Verificado en esta revisión con un archivo
disperso de 2,2 GB sobre Node 22: `ERR_FS_FILE_TOO_LARGE: File size
(2306867200) is greater than 2 GiB`. El error llega al renderer como
`NotReadableError` con ese texto, en inglés y sin traducir. CSV y Parquet no lo
sufren: van por el servidor HTTP local con rangos (`_createDesktopLocalHttpFile`)
o por `omv:read-file-slice`. Consecuencia directa: `matlabFullLoadMb` y
`pypsaNetcdfFullLoadMb` admiten hasta 2048 MiB en Ajustes, que es exactamente
un byte más de lo que esa ruta puede leer.

**El quinto no es un rechazo del archivo, sino del camino degradado.** Con
DuckDB disponible, un CSV de 600 MB se abre lazy sin más. `LEGACY_CSV_FALLBACK_MAX_BYTES`
solo actúa cuando DuckDB falla o no existe: bajo `file://`, sin WebAssembly,
con `omv_disable_duckdb` en localStorage, o en el **build portable**
(`__OMV_PORTABLE__`, que desactiva DuckDB por completo en `loadDuckDbSourceClass`
y `_canUseDuckDb`). En el portable, por tanto, no hay camino lazy para nada y
este techo es real.

### (E) Topes de Ajustes

`_normalizeAdvancedSettings` en `src/app/viewer-app.js` recorta lo que el
usuario puede escribir, y `makeNumberField` en `src/app/methods/ui-methods.js`
repite los mismos `min`/`max` en el campo numérico.

| Ajuste | Web | Escritorio | Rango permitido |
|---|---|---|---|
| `csvFullLoadMb` | 150 | 150 | 10 – 1000 |
| `parquetFullLoadMb` | 100 | 200 | 10 – 1000 |
| `matlabFullLoadMb` | 250 | 1024 | 10 – 2048 |
| `excelFullLoadMb` | 50 | 150 | 10 – 500 |
| `pickleFullLoadMb` | 80 | 200 | 10 – 1000 |
| `pypsaNetcdfFullLoadMb` | 250 | 1024 | 50 – 2048 |
| `audioFullLoadMb` (decodificado) | 400 | 1024 | 50 – 4096 |
| `csvCompactHintMb` | 500 | 500 | 100 – 4096 |

Este es el único tope verdaderamente artificial del conjunto: no protege de
nada, solo impide que alguien que sabe lo que hace suba el número.

Y hay una trampa debajo: **hoy no existe forma de expresar "sin límite"**.
`_advancedSettingMb` devuelve el valor guardado solo si es `> 0`; un `0` cae en
la constante de respaldo. Aunque `checkFullLoadLimit` y `checkDecodedAudioLimit`
tratan `limitBytes <= 0` como "no comprobar", ese `0` nunca les llega. Y los
parsers hacen lo mismo por su cuenta: `Number(options.maxFileBytes || DEFAULT)`
convierte un `0` en el límite por defecto de 80 MB (pickle) o 250 MB (netCDF).
Solo `Infinity` atraviesa las tres capas, y eso es lo que envía `allowOversized`.

Los valores por defecto están **duplicados** entre `viewer-app.js`
(`_defaultAdvancedSettings`) y las constantes `*_WEB_EAGER_LIMIT_BYTES` /
`*_DESKTOP_EAGER_LIMIT_BYTES` de `src/parsers/*-limits.js`. Hoy coinciden. En la
app las constantes son inalcanzables (`_normalizeAdvancedSettings` siempre
rellena todas las claves), pero **no son código muerto**: son lo que se aplica
cuando `advancedSettings` no existe —los tests las usan así, y
`scripts/test-desktop-streamable-file.mjs` importa esas constantes para fijar
que los valores por defecto de web y escritorio *difieren*— y las de los parsers
se aplican cuando se llama al parser sin `maxFileBytes` (bench, scripts).

### (F) Recorte por contenido — netCDF en malla

Este no aparece en Ajustes y no se mide en bytes. Una variable netCDF en malla
(tiempo × lat × lon × …) que no cabe se carga como un **subconjunto uniforme de
sus puntos espaciales**, y el archivo abre igual. En `src/parsers/netcdf-parser.js`:

- `SERIES_VALUE_BUDGET_PER_VARIABLE = 2 000 000` valores retenidos por variable
  (16 MB de Float64), dividido por la longitud del eje temporal para saber
  cuántas series caben;
- `MIN_SERIES_PER_VARIABLE = 64`, porque debajo de una malla de ~8 × 8 ya no hay
  un campo que mirar;
- `MAX_GENERATED_SERIES = 10 000` por archivo; una variable que lo excedería se
  omite con mensaje.

Es el único límite del conjunto **medido** (`scripts/bench-netcdf-grid.mjs`,
`docs/netcdf-gridded-subsampling.md`), y el único que decide *cuánto* cargar en
lugar de *si* cargar. Lo dice en voz alta: `_showNetcdfPartialLoadNotice`
avisa con cuántas variables llegaron recortadas. Vale la pena tenerlo presente
porque es la versión honesta de "abrir lo más grande que se pueda": un
presupuesto, una carga parcial y un aviso, en lugar de un número por formato.

Fuera de esta familia, y solo para que no se confundan con ella: Live Update
tiene un tope de 256 MB de datos anexados por sesión
(`src/app/methods/live-update-methods.js`), y el remuestreo se niega a
serializar más de 60 M de celdas (`resample-methods.js`). Ninguno de los dos
decide si un archivo se abre.

---

## 2. Lo que el camino eager consume de verdad

El argumento "que el navegador intente abrir lo más grande que pueda" supone
que abrir un archivo de N bytes cuesta del orden de N bytes. En el camino eager
no es así, y parte del costo **no se devuelve**.

### En el navegador

Para un `.mat`, `.xlsx`, `.pkl` o `.nc`, la secuencia en `file-methods.js` es:

1. `file.arrayBuffer()` → **1× archivo** en el renderer.
2. `detachedCopy(buffer)` → **2× archivo** en el pico: el worker recibe una copia
   propia, porque el original se conserva.
3. El worker infla o expande → los datos intermedios viven en el heap del
   worker (los `new Array(elements)` del relleno sparse, los objetos que
   construye SheetJS, el árbol del pickle).
4. Las columnas finales vuelven **por transferencia, no por copia**:
   `collectColumnBuffers` (`src/workers/parse-handlers.js`) mueve los
   `ArrayBuffer` de los `Float64Array` al renderer sin duplicarlos. Este paso
   cuesta cero.
5. `this.files.set(fileId, { …, buffer, … })` → **el buffer crudo queda
   residente** mientras el archivo esté abierto.

Es decir: un MAT de 1 GB son ~2 GB de bytes crudos en el pico, más lo que
infla el worker, y ~1 GB que se queda mientras el archivo esté abierto. Para
los formatos streamables (CSV, Parquet) `buffer` queda en `null` y nada de esto
aplica.

### En escritorio, es peor

La ruta `omvDesktop.readFile` (`omv:read-file` en `electron/main.cjs`) añade
copias antes de llegar al paso 1:

- `fsp.readFile` produce un `Buffer` en el proceso principal (**1×**), y
  `buffer.buffer.slice(...)` lo copia a un `ArrayBuffer` limpio para el IPC
  (**2× en el proceso principal**, transitorio).
- El IPC lo clona al renderer (**1× en el renderer**).
- El renderer lo envuelve en `new File([bytes], …)`, y `loadFile` le pide
  `arrayBuffer()`: el `File` guarda su propia copia en el almacén de blobs de
  Chromium y el `ArrayBuffer` es otra. A partir de ahí, la secuencia del
  navegador (copia para el worker, retención).

Por eso un OOM en escritorio no es "el worker se murió": puede caer el
renderer entero, y por eso existe el handler de `render-process-gone` en
`electron/main.cjs`, la única forma de contarle al usuario lo que pasó cuando ya
no queda JavaScript vivo para dibujar un diálogo.

### Guardar el proyecto vuelve a pagar

`_readProjectEntryBytes` (`src/app/methods/session-methods.js`) mete los bytes
crudos de cada archivo en el `.zip` del proyecto, y `zipSync` de fflate
comprime **en el hilo principal**, de forma síncrona. Guardar un proyecto con
un MAT de 1 GB abierto es otra pasada de ~1 GB de entrada más la salida
deflatada, con la interfaz congelada mientras tanto.

### La retención es una caché, no una dependencia

Esto importa para la sección 7. `entry.buffer` se conserva "para recargar,
reajustar el parseo y guardar sesión", pero ninguna de las tres lo usa como
primera opción:

- `_readLatestBuffer` relee **siempre** desde `entry.localPath`, luego desde
  `entry.fileHandle`, luego desde `entry.file.arrayBuffer()`, y solo si todo
  eso falla devuelve `entry.buffer` como instantánea de último recurso.
- `_readProjectEntryBytes` prueba `entry.buffer`, después
  `entry.file.arrayBuffer()`, después `_readLatestBuffer`.
- La única dependencia por identidad es `_hasExcelCsvCache`, que compara
  `entry.excelCsvSourceBuffer === entry.buffer` para saber si el CSV
  convertido sigue correspondiendo al libro; `entry.contentHash` ya existe y
  serviría igual.

### El aislamiento del worker, con precisión

El comentario de `_confirmOversizedFile` dice que el aviso se degradó a
advertencia porque, al mover el parseo a un worker, el worker muere y la
pestaña sobrevive. Es cierto **para la fase de expansión**, que es donde
ocurren las bombas de (D): el worker tiene su propio heap, y un `RangeError` o
una muerte del worker vuelven como error normal. No es cierto para los bytes
crudos (pasos 1, 2 y 5), que viven en el renderer.

Tres casos sin aislamiento ninguno:

- **Audio** decodifica en el hilo principal: Web Audio no existe dentro de un
  Worker.
- **Bajo `file://`** no hay workers (`canUseWorkers` en
  `src/core/worker-pool.js`) ni DuckDB: todo se parsea en el hilo principal.
- **El build portable** no tiene DuckDB, así que ningún CSV tiene camino lazy;
  el parser JS antiguo, que decodifica el archivo entero a un string, es el
  único que hay, y `LEGACY_CSV_FALLBACK_MAX_BYTES` deja de ser un respaldo para
  ser el límite.

El pool de parseo tiene tamaño 1 a propósito: el comentario de `getParsePool`
dice que dos workers decodificando un MAT de 500 MB cada uno duplicarían el
pico "contra un techo de pestaña de ~4 GB". Es decir, el código ya razona en
términos de pico, no de tamaño de archivo.

---

## 3. Web contra escritorio

Hoy la diferencia entre ambos modos son **los valores por defecto** y un techo
que solo tiene escritorio. El resto del código es idéntico: mismas
comprobaciones, mismo diálogo, mismos techos duros de (D).

La diferencia de valores no está justificada por el motor. `electron/main.cjs`
no pasa ningún flag de heap a V8 (solo `remote-debugging-port`,
`disable-renderer-backgrounding`, `disable-background-timer-throttling` y
`disable-features`; el único `--max-old-space-size` del repo es el de
`npm run bench:parse`). El renderer de escritorio tiene el mismo techo de
Chromium que una pestaña de Chrome. V8 dimensiona su heap según la RAM física
de la máquina, y los `ArrayBuffer` viven fuera de ese heap: ni uno ni otro
cambian por ser Electron. Lo único que cambia es la apuesta de que una máquina
de escritorio tiene más RAM libre que la que abre el visor en una pestaña entre
otras veinte.

Esa apuesta es razonable, pero es una apuesta, no una medición — y es la misma
apuesta para `excelFullLoadMb: 50` que para `matlabFullLoadMb: 250`, números que
no salen de ninguna medición registrada. El único factor con base escrita es el
de Excel: `excel-limits.js` anota que SheetJS expande el zip "unas 10–20 veces".

Y en un punto escritorio es **más** restrictivo que la web, no menos: el techo
de 2 GiB de `fs.readFile` en los formatos no streamables (sección 1.D). En el
navegador el equivalente es lo que el motor permita a un solo `ArrayBuffer`,
que no está documentado en el proyecto ni se comprobó aquí.

---

## 4. Incoherencias encontradas

**1. El aviso promete algo que el techo duro niega.** `matlabFullLoadMb` se
puede subir hasta 2048 MB en Ajustes, pero `MATLAB_MAT_MAX_INFLATED_BYTES` está
fijo en 1536 MB. Un MAT que el usuario aprueba explícitamente con "Abrir igual"
puede ser rechazado igual, con un mensaje que habla de descompresión y no del
límite que acaba de aceptar. Y en escritorio, ese mismo 2048 está por encima de
lo que `omv:read-file` puede leer.

**2. `allowOversized` solo llega a medio camino en pickle.** `_parsePickleResultBuffer`
pasa `maxFileBytes: Infinity`, pero no toca `internalLimits`; el parser hace
`{ ...PICKLE_DEFAULT_INTERNAL_LIMITS, ...(options.internalLimits || {}) }`, así
que `maxArrayBytes` (512 MB) sigue vigente. Se puede aprobar un pickle de 600 MB
y que lo corte igual un array de 600 MB adentro. Lo mismo vale en el worker:
`parse:pickle` en `src/workers/parse-handlers.js` solo reenvía `maxFileBytes`.

Nota: en el caso del MAT esto es defendible (el techo de inflado protege de algo
que el usuario no puede evaluar), pero entonces el aviso previo no debería
ofrecer un rango que el techo no honra. En el caso del pickle es simplemente una
opción que no se propagó.

**3. MAT no tiene compuerta de tamaño del lado del parser.** `parse:mat` ni
siquiera recibe `maxFileBytes`. Su única defensa son (D) y el aviso previo.

**4. "Sin límite" no se puede expresar** (sección 1.E): tres capas convierten
un `0` en el valor por defecto, cada una por su cuenta.

**5. La ayuda de la app afirma dos cosas que no se cumplen en los bordes.**
`helpSec11Body` ("Archivos grandes y uso de memoria", en `src/i18n/translations.js`,
cuatro idiomas) dice que *nothing is refused outright* y que el comportamiento
*no depende de la versión*. Lo primero es falso para (D): un MAT que infle más de
1536 MB, un pickle con un array de más de 512 MB, y cualquier formato no
streamable de más de 2 GiB en escritorio. Lo segundo es falso por ese techo de
2 GiB y por el portable, que no tiene camino lazy. Esto es deuda de
documentación independiente de la opción que se elija.

**6. Un hueco menor de cobertura.** `scripts/test-settings-layout.mjs` enumera
los campos de Ajustes uno por uno, pero se olvida de `audioFullLoadMb`.

---

## 5. Conclusión

**De acuerdo con:** los números por formato de (B) y (C) son arbitrarios, están
duplicados en dos lugares, y la diferencia web/escritorio no la justifica el
motor. El tope de Ajustes (E) no protege de nada, y ni siquiera permite
desactivar el aviso.

**En desacuerdo con:** eliminar el aviso por completo. El camino eager retiene
~2× el archivo en el pico (más en escritorio) y ~1× mientras el archivo esté
abierto, y su modo de fallo es un renderer muerto sin explicación tras varios
minutos. Lo que sobra es **la tabla de constantes**, no la advertencia.

**Sin discusión:** (A) se queda, (D) se queda y (F) es el modelo a imitar. (D)
no son límites de tamaño; son la única defensa contra un archivo que miente
sobre lo que contiene, y no existe forma de comprobarlo salvo negándose. (F)
muestra cómo se hace un límite honesto: un presupuesto medido, una carga
parcial y un aviso.

Lo que de verdad subiría el techo no es ninguna constante, sino bajar el pico
(sección 7) — y en escritorio, cambiar por dónde entran los bytes.

---

## 6. Opciones de modificación

### Opción A — Destapar Ajustes y permitir "sin límite"

Es la opción pequeña, pero **no es una línea**: hay que hacer que las tres
capas de la sección 1.E dejen pasar el `0`, o el resultado es peor que hoy.

1. `viewer-app.js` → `_normalizeAdvancedSettings`: mínimos a `0` para las claves
   de aviso (B y C); máximos fuera o mucho más altos. Para `csvFullLoadMb` y
   `parquetFullLoadMb` un `0` no significa nada útil (¿"siempre lazy"?), así
   que o conservan su mínimo positivo o se les define ese significado.
2. `file-methods.js` → `_advancedSettingMb`: hoy `raw > 0 ? raw : fallback`.
   Tiene que distinguir "no configurado" de "configurado en 0", al menos para
   las claves de aviso.
3. `file-methods.js` → `_parsePickleResultBuffer` y `_parsePypsaNetcdfResultBuffer`:
   con límite 0 el aviso no salta, `allowOversized` queda `false`, y el parser
   recibe `maxFileBytes: 0`, que su `Number(options.maxFileBytes || DEFAULT)`
   convierte en 80 MB / 250 MB. **Sin este paso, poner 0 reintroduce el rechazo
   dentro del parser, con un mensaje que no menciona ningún ajuste.** Enviar
   `Infinity` cuando el límite configurado es 0 basta.
4. `ui-methods.js` → `makeNumberField`: `min="0"`, sin `max`.
5. Textos de ayuda en los cuatro idiomas: "0 = sin aviso".

Costo: bajo, un par de horas con pruebas. Riesgo: bajo —
`scripts/test-file-size-limits.mjs` ya cubre que un límite 0 desactiva la
comprobación—. Deja los números arbitrarios como valor por defecto, pero deja de
pelear con quien sabe lo que hace.

**Implementada.** Lo que quedó en el código, por capa:

1. `viewer-app.js` → `_advancedSettingRanges()`, una sola tabla de rangos que
   leen tanto `_normalizeAdvancedSettings` como el panel de Ajustes (antes los
   mismos números estaban copiados en `ui-methods.js`). Los cinco límites de
   aviso pasan a `[0, Infinity]`; CSV, Parquet y el umbral de conversión
   conservan su piso.
2. `file-methods.js` → `_optionalLimitBytes`, que devuelve 0 cuando el ajuste
   es exactamente 0 y delega en `_advancedSettingBytes` en cualquier otro caso.
   Los cinco resolutores (`_matlabEagerLimitBytes`, `_excelEagerLimitBytes`,
   `_pickleEagerLimitBytes`, `_pypsaNetcdfEagerLimitBytes`,
   `_audioDecodedLimitBytes`) pasan por ahí.
3. `file-methods.js` → `readerFileCeiling(limitBytes, options)`, exportada:
   `Infinity` tanto si el usuario aprobó el archivo como si no hay límite, para
   que el `maxFileBytes || DEFAULT` de los lectores de pickle y netCDF nunca
   reciba un 0.
4. `ui-methods.js` → los campos toman `min`/`max` de la tabla compartida, y un
   campo sin techo no lleva atributo `max`.
5. `translations.js` → una frase al final de los cinco textos de ayuda de los
   campos ("0 = no avisar nunca") y una frase en `helpSec11Body`, en los cuatro
   idiomas. El resto de esa sección de ayuda no se tocó.

`scripts/test-file-size-limits.mjs` fija las tres capas: un 0 no pregunta para
ninguno de los cinco formatos, un valor positivo sí, y el lector recibe
`Infinity`; y verifica por fuente que solo esas cinco claves admiten 0 y que el
panel ya no lleva su propia copia de los rangos.

### Opción B — Un solo aviso, sobre memoria estimada *(recomendada)*

Reemplazar las cinco constantes por formato por **un solo ajuste**
(`fullLoadWarnMb`) y un factor de expansión por formato en código:

```js
// src/app/file-size-limits.js
const EXPANSION = { mat: 3, excel: 15, pickle: 2.5, netcdf: 2.5 };
// coste estimado ≈ tamaño × factor + 2 × tamaño   (las dos copias crudas del pico)
```

El aviso pasa a decir *"este archivo va a ocupar unos X GB"* en lugar de *"supera
el límite de Excel"*, que es la pregunta que el usuario necesita responder.
Ajustes baja de ocho campos a cuatro: CSV lazy, Parquet lazy, sugerir
conversión, avisar por encima de.

Toca: `file-size-limits.js`, `viewer-app.js` (`_defaultAdvancedSettings`,
`_normalizeAdvancedSettings`), `ui-methods.js`, `src/i18n/translations.js` (en,
fr, es, it), y los `src/parsers/*-limits.js`, que se reducen a los techos duros
—que es a lo que pertenecen—. Arregla de paso la incoherencia 4.1, porque el
aviso deja de prometer un rango que el techo no honra.

Dos cosas que calibrar antes de fijar los factores: los de MAT, pickle y
netCDF no están medidos (solo el de Excel tiene una nota), y en escritorio el
pico crudo es mayor que 2× (sección 2), así que el factor debería depender del
runtime o el término crudo debería ser 3× allí.

**El costo escondido está en la ayuda.** `helpSec11Body` es una sección HTML
de nueve apartados con una tabla de límites, escrita en los cuatro idiomas, y
`scripts/test-large-files-help.mjs` fija sus afirmaciones contra el código: que
la tabla existe, que abre explicando qué *es* un límite, que dice
explícitamente que superarlo no es un rechazo, y que el límite de CSV es igual
en web y escritorio. Cualquier opción que cambie la forma de los límites obliga
a reescribir esa sección cuatro veces y a reajustar esa prueba. Es, con
diferencia, la parte más laboriosa de B, C y D. A cambio, es la ocasión de
corregir la incoherencia 4.5.

### Opción C — Presupuesto de memoria medido

La idea llevada hasta el final: nada de constantes, se le pregunta a la máquina.

- Web: `performance.memory.jsHeapSizeLimit` (solo Chromium, y obsoleto), con
  `navigator.deviceMemory` como respaldo (grueso: valores discretos, tope en 8).
  `performance.measureUserAgentSpecificMemory()` mide de verdad pero exige
  aislamiento cross-origin (COOP/COEP), que habría que comprobar contra el
  despliegue en GitHub Pages.
- Escritorio: un canal IPC nuevo que exponga `process.getSystemMemoryInfo()`
  desde `electron/main.cjs`. Aquí sí es directo.
- Avisar solo si `coste estimado > headroom × 0,7`.

Es lo más honesto, y hace que web y escritorio dejen de ser dos tablas
distintas: pasan a ser la misma regla sobre dos máquinas distintas. El problema
es que Firefox y Safari no exponen nada útil, así que hace falta un camino de
respaldo igual — en la práctica termina siendo la Opción B con un techo dinámico
encima. **Después de B, no en lugar de B.**

### Opción D — Quitar (B) y (C) por completo

Borrar `EAGER_ONLY_FORMATS`, el diálogo, los cinco ajustes y las constantes.
Dejar solo (A), (D) y (F). Es la lectura literal de la propuesta original.

No recomendada tal cual: sin el aviso, el modo de fallo de un `.xlsx` de 400 MB
es la pestaña muerta a los dos minutos, sin explicación — y en escritorio, el
renderer entero. La versión defendible es D **junto con** la sección 7, no
antes.

---

## 7. Transversal: bajar el pico real

Independiente de la opción elegida, y probablemente más valioso que cualquiera
de ellas. En orden de rendimiento por esfuerzo:

1. **Escritorio: dejar de usar `omv:read-file` para los formatos no
   streamables.** `_createDesktopLocalHttpFile` ya sabe leer por rangos desde el
   servidor HTTP local, y `omv:read-file-slice` existe. Extender
   `_isDesktopStreamablePath` a todas las extensiones —o leer en trozos
   directamente a un único `ArrayBuffer`— elimina las dos copias del proceso
   principal, la copia del IPC y la del `File` intermedio, **y esquiva el techo
   de 2 GiB de `fs.readFile`**. Es el cambio con mejor relación
   costo/beneficio del documento, y no toca ningún límite.

2. **Liberar `entry.buffer` después del parseo.** Más barato de lo que parece:
   las rutas de relectura ya existen (sección 2, "la retención es una caché").
   Lo que hay que cambiar es `_hasExcelCsvCache`, que compara por identidad de
   buffer y pasaría a comparar por `contentHash`. Efecto de segundo orden a
   tener en cuenta: en Chrome/Edge un archivo arrastrado sin
   `FileSystemFileHandle` se relee desde el `File` original
   (`entry.file.arrayBuffer()`), que en Chromium puede ser una instantánea; es
   exactamente lo que `_readLatestBuffer` ya hace hoy cuando no hay handle.

3. **Evitar `detachedCopy`** cuando el buffer no se vaya a retener (es decir,
   una vez hecho el punto 2): transferir el original al worker elimina el 2×
   del pico. Cuidado con `_expandMatEntries`, que reutiliza el buffer de la
   inspección como `options.matBuffer` para no leer el MAT dos veces.

4. **Guardar el proyecto sin congelar la interfaz**: mover `zipSync` a un
   worker o usar la API de streaming de fflate. Es ortogonal a los límites,
   pero es la otra vez que se paga el tamaño del archivo entero en el hilo
   principal.

Con 1–3, los archivos que hoy rozan el límite dejan de rozarlo, y la discusión
sobre el número se vuelve mucho menos importante.

---

## 8. Qué tocaría cada opción en las pruebas

| Prueba | Qué fija hoy | A | B | C | D |
|---|---|---|---|---|---|
| `test:file-size-limits` | frontera exacta, límite 0 desactiva, claves reales, decisión dura una carga | — | reescribir | reescribir | borrar casi todo |
| `test:large-files-help` | `helpSec11Body` ×4: tabla, "no es un rechazo", CSV igual en ambos | — | reescribir ×4 | reescribir ×4 | reescribir ×4 |
| `test:desktop-streamable-file` | los valores por defecto web ≠ escritorio, vía las constantes de `*-limits.js` | — | reescribir | reescribir | borrar esa parte |
| `test:settings-layout` | que cada campo de Ajustes exista | actualizar | actualizar | actualizar | actualizar |
| `test:matlab` | `matlabFullLoadMb` en el harness; `fileOverLimitBody` en las traducciones | — | actualizar | actualizar | actualizar |
| `test:parquet-loading-mode` | `parquetFullLoadMb` decide lazy | — | — | — | — |
| `test:session-state-roundtrip` | `matlabFullLoadMb: 777` sobrevive al guardar/cargar | — | actualizar clave | actualizar clave | actualizar clave |
| `test:pickle` | códigos `PICKLE_TOO_LARGE` y `PICKLE_LIMIT_EXCEEDED` | — | — | — | — |

`scripts/test-file-size-limits.mjs` también verifica que cada `limitKey` exista
realmente en `_defaultAdvancedSettings` —una errata ahí resolvería a 0 y
desactivaría el aviso en silencio—, así que cualquier renombrado de claves tiene
que pasar por ahí.

---

## 9. Qué corrigió la segunda pasada

Para que quede claro qué parte de la primera redacción no resistió la
verificación:

- **La Opción A estaba mal descrita.** Decía que bastaba con destapar los
  rangos de Ajustes porque `checkFullLoadLimit` ya trata `0` como "sin
  comprobar". Es cierto, pero el `0` nunca le llega: `_advancedSettingMb` lo
  convierte en la constante de respaldo, y los parsers de pickle y netCDF harían
  lo mismo por su cuenta. Sin los tres cambios, poner 0 produce un rechazo
  dentro del parser sin mención a ningún ajuste.
- **El resultado del worker no se copia.** La primera versión contaba una
  tercera materialización "por structured clone". `collectColumnBuffers`
  transfiere los `ArrayBuffer` de las columnas; ese paso cuesta cero. El pico
  de 2× y la retención se mantienen.
- **La retención de `entry.buffer` es una caché con rutas de relectura ya
  hechas**, no una dependencia dura. Eso abarata la sección 7.2 y reduce el
  bloqueo a una comparación por identidad en `_hasExcelCsvCache`.
- **`LEGACY_CSV_FALLBACK_MAX_BYTES` no rechaza archivos**, rechaza el camino
  de respaldo. Solo es un límite real donde no hay DuckDB: `file://` y el build
  portable.
- **Faltaba un techo duro**: los 2 GiB de `fs.readFile` en escritorio,
  verificados empíricamente. Y faltaban dos mecanismos: el diálogo de
  conversión de CSV en 500 MB (A) y el recorte por contenido de netCDF (F).
- **Eran seis puntos de comprobación, no tres.**
- **Las constantes de `*-limits.js` no son código muerto**: son el respaldo sin
  Ajustes, y `test-desktop-streamable-file.mjs` depende de ellas.
- **La ayuda de la app contradice al código en dos frases** (4.5); no estaba
  señalado.
- Se añadieron la ruta de escritorio con sus copias extra (2), el costo de
  guardar el proyecto (2), y la opción 7.1, que es nueva.

---

## Addenda (tras implementar la Opción A)

Hechos medidos después de cerrar el estudio, que corrigen o completan lo de
arriba. Ninguno cambia las conclusiones; dos cambian justificaciones escritas
en el código.

- **Los dos motores wasm tienen techo de 4 GiB, en escritorio igual que en
  Chrome.** Leído del binario: `duckdb-mvp.wasm` declara memoria máxima de
  4,00 GiB y `duckdb-eh.wasm` (el que Chromium elige) no declara máximo, es
  decir, el tope de wasm32. Los "3 GiB" de `docs/large-files.md` son de
  Firefox y no aplican a Electron. h5wasm (netCDF) comparte el techo de
  wasm32.
- **netCDF paga una copia más que no estaba en la sección 2.** Tanto
  `pypsa-netcdf-parser.js` como `netcdf-parser.js` copian el buffer entero al
  sistema de archivos de WASM (`FS.writeFile`) antes de abrirlo, porque h5wasm
  no lee rangos. Un netCDF tiene que caber en esos 4 GiB junto con la memoria
  de trabajo del lector.
- **El comentario de `matlab-mat-limits.js` sobre "el tope de ~2 GiB de un
  array de JS" está desactualizado.** En el V8 de Node 22 se crean
  `ArrayBuffer` de 3, 5 y 9 GiB sin error (con RAM para respaldarlos). El tope
  sigue existiendo para arrays *planos* (`new Array(n)`, 2³²−1 elementos y el
  heap), que es lo que usa el relleno de matrices sparse. El techo de 1536 MB
  sigue siendo defendible como freno a bombas; su justificación escrita, no.
- **El parser CSV antiguo está limitado por el string de V8**: 536 870 888
  caracteres (~512 MiB), medido. `LEGACY_CSV_FALLBACK_MAX_BYTES` (450 MB) lo
  frena antes, correctamente.
- **Un CSV de 5 GB no se puede abrir eager hoy** por tres barreras en cascada
  (el techo de 1000 MB de `csvFullLoadMb`, el `CREATE TABLE` dentro de los
  4 GiB de WASM, y el string de 512 MiB del respaldo), y no conviene que se
  pueda: ver `docs/any-size-files.md`, que continúa este estudio por el lado
  que sí escala.
