# Límites de tamaño de archivo: estudio y opciones

**Estado: estudio, sin implementar.** Este documento describe los límites tal
como están hoy en el código, qué hace cada uno realmente, y cuatro opciones de
modificación con sus costos. No se cambió nada todavía.

La pregunta que lo origina: *¿el único límite necesario no es el que decide
entre lectura completa y lectura parcial? Los demás parecen impedir abrir un
archivo sin razón; lo mejor sería que el navegador abra el archivo más grande
que pueda, sin un tope artificial.*

La respuesta corta es que hay **cinco** mecanismos distintos que la palabra
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

### (B) Límites de aviso previo — MAT, Excel, pickle, netCDF

`EAGER_ONLY_FORMATS` en `src/app/file-size-limits.js`. Se comparan contra el
tamaño **en disco**, antes de leer el archivo.

**Ya no impiden abrir el archivo.** Eso cambió: hoy `_confirmOversizedFile`
(`src/app/methods/file-methods.js`) muestra un diálogo con *Cancelar* / *Abrir
igual*, y el "sí" viaja como `allowOversized` hasta el parser para que no lo
vete una segunda vez. La respuesta se recuerda por archivo durante una sola
carga —la pregunta se hace desde dos lugares— y se olvida al terminar; no hay
"no volver a preguntar", deliberadamente.

La comprobación se hace desde tres puntos, todos en `file-methods.js`:
`loadFiles` (camino web), el lector de escritorio (`omvDesktop.readFile`, que
pregunta *antes* de traer los bytes) y el camino HTTP local (que hace un `HEAD`
para conocer el tamaño antes del `fetch`).

### (C) Límite post-decodificación — audio

`audioFullLoadMb`, medido sobre las **muestras decodificadas**, no sobre el
archivo (`checkDecodedAudioLimit` + `decodedAudioBytes`). Audio es el único
formato donde el tamaño en disco no dice nada del costo en memoria: 5 MB de WAV
son ~1,3 M de muestras, 5 MB de MP3 son unas veinte veces más. Por eso audio
está fuera de `EAGER_ONLY_FORMATS` y se pregunta entre decodificar y construir
las columnas. También es aviso con override.

### (D) Techos duros, no anulables

Estos sí rechazan, y `allowOversized` **no** los alcanza:

| Techo | Valor | Archivo | Qué protege |
|---|---|---|---|
| `MATLAB_MAT_MAX_INFLATED_BYTES` | 1536 MB | `src/parsers/matlab-mat-limits.js` | presupuesto total de inflado zlib |
| `MATLAB_MAT_MAX_DENSE_ELEMENTS` | 25 M | `src/parsers/matlab-mat-limits.js` | forma declarada de una matriz sparse |
| `PICKLE_DEFAULT_INTERNAL_LIMITS` | `maxArrayBytes` 512 MB, `maxArrayElements` 50 M, `maxFrameBytes` 128 MB, … | `src/parsers/pickle-limits.js` | tamaños declarados dentro del pickle |
| `LEGACY_CSV_FALLBACK_MAX_BYTES` | 450 MB | `src/app/methods/file-methods.js` | el parser JS antiguo decodifica todo a un solo string |

**Estos no son límites de tamaño: son "no le creas a la cabecera".** Un MAT de
pocos KB de ceros se expande ~1000:1; una matriz sparse que declara
`[2, 2^30]` es una longitud de array válida en JS y decenas de GB de relleno
desde unos cientos de bytes. Ninguno de los dos se puede detectar mirando el
tamaño del archivo, y ninguno se puede permitir "intentando a ver qué pasa",
porque el intento es precisamente lo que mata la pestaña.

`matlab-mat-limits.js` documenta además por qué es un techo absoluto y no un
ratio de compresión: medido sobre 8 MB de Float64, una señal constante comprime
683:1 y una de ceros 1022:1, mientras que una senoidal apenas 1,1:1. Un ratio no
distingue una bomba de un resultado de simulación legítimo —son la misma
cosa—, así que una regla de 20:1 rechazaba archivos Modelica/Dymola correctos.

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

Este es el único tope verdaderamente artificial del conjunto: no protege de
nada, solo impide que alguien que sabe lo que hace suba el número.

Los mismos valores por defecto están **duplicados** entre `viewer-app.js`
(`_defaultAdvancedSettings`) y las constantes `*_WEB_EAGER_LIMIT_BYTES` /
`*_DESKTOP_EAGER_LIMIT_BYTES` de `src/parsers/*-limits.js`. Hoy coinciden, pero
las constantes de los parsers son prácticamente código muerto: como
`_normalizeAdvancedSettings` siempre rellena todas las claves, el ajuste siempre
gana y el respaldo nunca se usa.

---

## 2. Lo que el camino eager consume de verdad

El argumento "que el navegador intente abrir lo más grande que pueda" supone
que abrir un archivo de N bytes cuesta del orden de N bytes. En el camino eager
no es así, y el costo además **no se devuelve**.

Para un `.mat`, `.xlsx`, `.pkl` o `.nc`, la secuencia en `file-methods.js` es:

1. `file.arrayBuffer()` (o `omvDesktop.readFile`, que además materializa el
   archivo entero en el proceso principal de Electron y lo pasa por IPC)
   → **1× archivo** en el renderer.
2. `detachedCopy(buffer)` → **2× archivo**: el worker recibe una copia propia,
   porque el original se conserva para recargar, reajustar el parseo y guardar
   sesión.
3. El worker infla o expande → los datos materializados.
4. El resultado vuelve por structured clone → las columnas en el renderer.
5. `this.files.set(fileId, { …, buffer, … })` → **el buffer crudo queda
   residente el resto de la sesión**. No hay ningún punto donde se libere.

Es decir: un MAT de 1 GB no son 1 GB. Son ~2 GB de bytes crudos en el pico, más
lo inflado, más las columnas, y ~1 GB que se queda ocupado para siempre. Para
los formatos streamables (CSV, Parquet) `buffer` queda en `null` y nada de esto
aplica.

Dos consecuencias:

- **El modo de fallo de "intentar y ver" es malo.** No falla rápido ni suave:
  falla tarde, después de minutos de reloj de arena, y con la memoria ya
  comprometida. En escritorio se lleva el renderer puesto —por eso existe el
  handler de `render-process-gone` en `electron/main.cjs`, que es la única
  forma de contarle al usuario lo que pasó cuando ya no queda JavaScript vivo
  para dibujar un diálogo.
- **El worker no aísla tanto como parece.** El comentario de
  `_confirmOversizedFile` dice que el aviso se degradó a advertencia porque, al
  mover el parseo a un worker, el worker muere y la pestaña sobrevive. Es cierto
  para la expansión, pero los bytes crudos y las columnas resultantes viven en
  el renderer igual. Y **audio decodifica en el hilo principal** (Web Audio no
  existe dentro de un Worker), así que ahí no hay aislamiento ninguno.

---

## 3. Web contra escritorio

Hoy la única diferencia entre ambos modos son **los valores por defecto**. El
código es idéntico: mismas comprobaciones, mismo diálogo, mismos techos duros.

Y la diferencia de valores no está justificada por el motor. `electron/main.cjs`
no pasa ningún flag de heap a V8 (solo `remote-debugging-port`,
`disable-renderer-backgrounding`, `disable-background-timer-throttling` y
`disable-features`), así que el renderer de escritorio tiene el mismo techo de
Chromium que una pestaña de Chrome. Lo único que cambia es la apuesta de que una
máquina de escritorio tiene más RAM libre que la que abre el visor en una
pestaña entre otras veinte.

Esa apuesta es razonable, pero es una apuesta, no una medición — y es la misma
apuesta para `excelFullLoadMb: 50` que para `matlabFullLoadMb: 250`, números que
no salen de ninguna medición registrada.

---

## 4. Incoherencias encontradas

**1. El aviso promete algo que el techo duro niega.** `matlabFullLoadMb` se
puede subir hasta 2048 MB en Ajustes, pero `MATLAB_MAT_MAX_INFLATED_BYTES` está
fijo en 1536 MB. Un MAT que el usuario aprueba explícitamente con "Abrir igual"
puede ser rechazado igual, con un mensaje que habla de descompresión y no del
límite que acaba de aceptar.

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

---

## 5. Conclusión

**De acuerdo con:** los números por formato de (B) y (C) son arbitrarios, están
duplicados en dos lugares, y la diferencia web/escritorio no la justifica el
motor. El tope de Ajustes (E) no protege de nada.

**En desacuerdo con:** eliminar el aviso por completo. El camino eager retiene
~2× el archivo en el pico y ~1× de por vida, y su modo de fallo es un renderer
muerto sin explicación tras varios minutos. Lo que sobra es **la tabla de
constantes**, no la advertencia.

**Sin discusión:** (A) se queda, y (D) se queda. (D) no son límites de tamaño;
son la única defensa contra un archivo que miente sobre lo que contiene, y no
existe forma de comprobarlo salvo negándose.

Lo que de verdad subiría el techo no es ninguna constante, sino bajar el pico
(sección 7).

---

## 6. Opciones de modificación

### Opción A — Destapar Ajustes y permitir "sin límite"

`checkFullLoadLimit` **ya trata `limitBytes <= 0` como "no comprobar"**, igual
que `checkDecodedAudioLimit`. Así que alcanza con dejar que el usuario escriba
`0`:

- `viewer-app.js` → `_normalizeAdvancedSettings`: mínimos a `0`, máximos fuera
  o mucho más altos.
- `ui-methods.js` → `makeNumberField`: `min="0"`, sin `max`.
- Textos de ayuda en los cuatro idiomas: "0 = sin aviso".

Costo: bajo. Riesgo: ninguno, la rama de "sin límite" ya existe y está probada
en `scripts/test-file-size-limits.mjs`. Deja los números arbitrarios como valor
por defecto, pero deja de pelear con quien sabe lo que hace.

### Opción B — Un solo aviso, sobre memoria estimada *(recomendada)*

Reemplazar las cinco constantes por formato por **un solo ajuste**
(`fullLoadWarnMb`) y un factor de expansión por formato en código:

```js
// src/app/file-size-limits.js
const EXPANSION = { mat: 3, excel: 15, pickle: 2.5, netcdf: 2.5 };
// coste estimado ≈ tamaño × factor × 2   (el ×2 es la copia del worker)
```

El aviso pasa a decir *"este archivo va a ocupar unos X GB"* en lugar de *"supera
el límite de Excel"*, que es la pregunta que el usuario necesita responder.
Ajustes baja de siete campos a tres: CSV lazy, Parquet lazy, avisar por encima
de.

Toca: `file-size-limits.js`, `viewer-app.js` (`_defaultAdvancedSettings`,
`_normalizeAdvancedSettings`), `ui-methods.js`, `src/i18n/translations.js` (en,
fr, es, it), y los `src/parsers/*-limits.js`, que se reducen a los techos duros
—que es a lo que pertenecen—. Arregla de paso la incoherencia 4.1, porque el
aviso deja de prometer un rango que el techo no honra.

**El costo escondido está en la ayuda.** `helpSec11Body` ("Archivos grandes y
uso de memoria") es una sección HTML de nueve apartados con una tabla de
límites, escrita en los cuatro idiomas, y `scripts/test-large-files-help.mjs`
fija sus afirmaciones contra el código: que la tabla existe, que abre explicando
qué *es* un límite, que dice explícitamente que superarlo no es un rechazo, y
que el límite de CSV es igual en web y escritorio. Cualquier opción que cambie
la forma de los límites obliga a reescribir esa sección cuatro veces y a
reajustar esa prueba. Es, con diferencia, la parte más laboriosa de B, C y D.

El factor de expansión de Excel (~10–20× según `excel-limits.js`) es el único
que está medido; los demás habría que calibrarlos contra los fixtures de
`test-files/` antes de fijarlos.

### Opción C — Presupuesto de memoria medido

La idea llevada hasta el final: nada de constantes, se le pregunta a la máquina.

- Web: `performance.memory.jsHeapSizeLimit` (solo Chromium), con
  `navigator.deviceMemory` como respaldo.
- Escritorio: un canal IPC nuevo que exponga `process.getSystemMemoryInfo()`
  desde `electron/main.cjs`.
- Avisar solo si `coste estimado > headroom × 0,7`.

Es lo más honesto, y hace que web y escritorio dejen de ser dos tablas distintas:
pasan a ser la misma regla sobre dos máquinas distintas. El problema es que
Firefox y Safari no exponen `performance.memory`, así que hace falta un camino de
respaldo igual — en la práctica termina siendo la Opción B con un techo dinámico
encima. **Después de B, no en lugar de B.**

### Opción D — Quitar (B) y (C) por completo

Borrar `EAGER_ONLY_FORMATS`, el diálogo, los cinco ajustes y las constantes.
Dejar solo (A) y (D). Es la lectura literal de la propuesta original.

No recomendada tal cual: sin el aviso, el modo de fallo de un `.xlsx` de 400 MB
es la pestaña muerta a los dos minutos, sin explicación. La versión defendible
es D **junto con** la sección 7, no antes.

---

## 7. Transversal: bajar el pico real

Independiente de la opción elegida, y probablemente más valioso que cualquiera
de ellas:

1. **Liberar `entry.buffer` después del parseo** para los formatos que no lo
   vuelven a leer. Hoy se conserva para recargar, reajustar el parseo y guardar
   sesión, pero para MAT y netCDF se podría releer desde `entry.file` o
   `entry.localPath` cuando haga falta, en vez de retener cientos de MB de por
   vida. Excel es el caso difícil: `_adoptExcelCsvCache` ya guarda el CSV
   convertido y `_hasExcelCsvCache` compara contra `entry.buffer`.
2. **Evitar `detachedCopy`** cuando el buffer no se vaya a retener: transferir
   el original al worker elimina el 2× del pico.

Con esas dos, los archivos que hoy rozan el límite dejan de rozarlo, y la
discusión sobre el número se vuelve mucho menos importante.

---

## 8. Qué tocaría cada opción en las pruebas

| Prueba | A | B | C | D |
|---|---|---|---|---|
| `npm run test:file-size-limits` | — | reescribir | reescribir | borrar la mayor parte |
| `npm run test:large-files-help` | — | reescribir (×4 idiomas) | reescribir (×4) | reescribir (×4) |
| `npm run test:settings-layout` | actualizar | actualizar | actualizar | actualizar |
| `npm run test:pickle` | — | — | — | — |
| `npm run test:matlab` | — | — | — | — |

`scripts/test-settings-layout.mjs` enumera los identificadores de los campos
uno por uno, así que cualquier fusión de campos pasa por ahí. (De paso: su lista
incluye seis de las siete claves `*FullLoadMb` más `csvCompactHintMb`, pero se
olvida de `audioFullLoadMb`. Es un hueco menor en la cobertura, no un fallo.)

`scripts/test-file-size-limits.mjs` también verifica que cada `limitKey` exista
realmente en `_defaultAdvancedSettings` —una errata ahí resolvería a 0 y
desactivaría el aviso en silencio—, así que cualquier renombrado de claves tiene
que pasar por ahí.
