# Especificación: etiquetas de texto en el hover, tipo por columna y vista previa CSV

- **Estado:** borrador para revisión. No hay nada implementado.
- **Fecha:** 2026-09-27.
- **Documento de contexto:** [`csv-parsing-backend-parity.md`](csv-parsing-backend-parity.md)
  (análisis, divergencias entre parsers y plan por etapas). Esta especificación
  detalla **qué** deben hacer las funciones de sus §10 y §11. El análisis de
  **por qué** y la evidencia están allí.

Convenciones:

- Cada requisito tiene un identificador (`LBL-…`, `TYP-…`, `PRV-…`, `PAR-…`) para
  poder citarlo en PRs y tests.
- **DEBE** = obligatorio. **DEBERÍA** = recomendado, se puede omitir si se
  justifica. **PUEDE** = opcional.
- Los valores marcados **(provisional)** son propuestas pendientes de confirmar
  por el autor (§5).

---

## 1. Definiciones

| Término | Significado |
|---|---|
| **Columna de texto** | Variable de un archivo con `dataType === 'string'`. Aparece en la barra lateral con el icono 🔤. |
| **Etiqueta** | Columna de texto asociada a un gráfico para mostrar su valor en el hover. |
| **Fila fuente** | Fila del archivo de la que procede un punto dibujado. |
| **Modo completo** | Archivo cargado entero en memoria, con DuckDB o con el parser JS. |
| **Modo lazy** | Archivo por encima del límite de carga completa: vista general en memoria y consultas a DuckDB al hacer zoom. |
| **Punto sintético** | Punto dibujado que no es una fila fuente. Por ejemplo, el mín./máx. de una cubeta colocado en el borde de la cubeta (`_expandMinMaxBucketResult`). |
| **Parser JS** | `src/parsers/csv-parser.js`, en worker o en el hilo principal. |
| **Camino DuckDB** | `src/data/duckdb-source.js`, parte CSV. |

## 2. Prerrequisitos

Estas funciones **NO DEBEN** publicarse antes de:

1. **Etapa 0 del plan de paridad:** la batería de tests DuckDB vs. JS existe y
   pasa (ver PAR-1).
2. **Etapa 1:** los tipos de columna se deciden con la columna completa. Sin
   esto, columnas numéricas mal tipadas (p. ej. 17 en el CSV
   `finanzas_unificadas_2016-2026.csv`) aparecerían como columnas de texto
   candidatas a etiqueta.
3. **Solo para la parte lazy de las etiquetas (LBL-43 a LBL-47):** etapa 2,
   con orden estable entre filas del mismo timestamp.

---

## 3. Parte A: etiquetas de texto en el hover

### 3.1 Objetivo

Al analizar datos como gastos, el usuario quiere saber a qué corresponde un
punto (p. ej. la descripción del movimiento bancario). Hoy las columnas de texto
se cargan, pero no se muestran en ninguna parte.

Con esta función, el usuario arrastra una o varias columnas de texto sobre un
gráfico, y el hover de cada punto muestra el valor de esas columnas en la fila
fuente del punto.

### 3.2 Gráficos admitidos

**Decisión del autor: solo series temporales y 2D.**

| Modo (`mode`) | ¿Admite etiquetas? |
|---|---|
| `timeseries` | **sí** |
| `phase2d` | **sí** |
| `phase2dt` (2D+t) | **no** |
| `phase3d` | **no** |
| `fft`, `histogram`, `heatmap`, `correlation` | no: sus puntos no corresponden a filas fuente |

### 3.3 Arrastre

- **LBL-1** Las filas 🔤 de la barra lateral DEBEN ser arrastrables con ratón
  y con dedo. Hoy tienen `draggable=false` (`tree-methods.js:588-590`).
- **LBL-2** Las filas 🔤 DEBEN seguir distinguiéndose visualmente de las
  variables graficables (conservar `tree-item-nonplottable` o equivalente).
- **LBL-3** La selección múltiple DEBE poder incluir columnas de texto.
  `_selectedVariableNamesForDrag` (`tree-methods.js:~116`) hoy las excluye.
- **LBL-4** Si una selección mixta (numéricas + texto) se suelta en un gráfico
  admitido, las numéricas DEBEN añadirse como trazas (comportamiento actual) y
  las de texto como etiquetas, en una sola operación.
- **LBL-5** Si una selección mixta se suelta en un gráfico **no** admitido, las
  numéricas DEBEN comportarse como hoy y las de texto DEBEN ignorarse, con el
  aviso de LBL-11.
- **LBL-6** Soltar una columna de texto en un espacio vacío del layout DEBE
  mantener el comportamiento actual para ese caso. No DEBE crear un gráfico
  solo con etiquetas.
- **LBL-7** El camino táctil (`dropVariablesAtPoint`, `showTouchDropHint`) DEBE
  comportarse exactamente igual que el del ratón.

### 3.4 Texto indicativo durante el arrastre

- **LBL-10** Mientras se arrastra una columna de texto sobre un gráfico
  admitido, el aviso del panel (`showDragHint`, `plot-manager.js:~1049`) DEBE
  mostrar un texto indicativo:
  - una columna: *"Soltar para mostrar «descripcion» en el hover"*;
  - varias: *"Soltar para mostrar 3 columnas de texto en el hover"*;
  - selección mixta: *"Soltar para graficar 2 variables y mostrar 1 columna de
    texto en el hover"*.
- **LBL-11** Sobre un gráfico no admitido, el aviso DEBE explicar por qué: *"Las
  columnas de texto solo se pueden usar como etiqueta en series temporales y
  gráficos 2D"*.
- **LBL-12** Si todas las columnas arrastradas ya son etiquetas de ese gráfico,
  el aviso DEBE decirlo (*"«descripcion» ya está en el hover"*).
- **LBL-13** Si el gráfico no tiene ninguna traza del archivo de origen de la
  columna, el aviso DEBE advertirlo (*"Este gráfico no tiene trazas de
  «archivo.csv»; la etiqueta se aplicará cuando las tenga"*). Soltar DEBE
  estar permitido igualmente (ver LBL-21).
- **LBL-14** Tras soltar, DEBE aparecer una confirmación breve (toast o el
  mecanismo de avisos que ya use la app) con lo que ocurrió.
- **LBL-15** Todos los textos DEBEN existir en EN, FR y ES
  (`src/i18n/translations.js`) y pasar `test-i18n-consistency`.

### 3.5 Modelo de datos y persistencia

- **LBL-20** Cada gráfico DEBE guardar sus etiquetas como una lista ordenada:
  `plot.hoverLabels = [{ fileId, varName }, …]`. El orden es el de inserción.
- **LBL-21** Una etiqueta DEBE aplicarse solo a las trazas cuyo archivo de
  origen sea `fileId`. Las trazas de otros archivos del mismo gráfico no la
  muestran.
- **LBL-22** Soltar una columna que ya está en la lista NO DEBE duplicarla.
- **LBL-23** Máximo **5** etiquetas por gráfico **(provisional)**. Al superar
  el máximo, el aviso DEBE indicarlo y las columnas sobrantes no se añaden.
- **LBL-24** `hoverLabels` DEBE persistir en layout y sesión (guardar,
  restaurar, duplicar gráfico) de la misma forma que el resto del estado del
  gráfico.
- **LBL-25** Si al restaurar una sesión, o al recargar un archivo, la columna ya
  no existe o ya no es de texto (p. ej. porque el usuario cambió su tipo, ver
  Parte B), la etiqueta DEBE descartarse sin error, y DEBERÍA registrarse un
  aviso no bloqueante.
- **LBL-26** Al cerrar un archivo, sus etiquetas DEBEN quitarse de todos los
  gráficos.
- **LBL-27** Una sesión antigua sin `hoverLabels` DEBE cargarse como hoy (lista
  vacía).

### 3.6 Presentación en el gráfico

- **LBL-30** Cada etiqueta activa DEBE mostrarse como un chip `🔤 nombre ×` en
  la cabecera o zona de leyenda del gráfico.
- **LBL-31** La × del chip DEBE quitar la etiqueta. El menú contextual del
  gráfico DEBERÍA ofrecer también "Quitar etiquetas de texto".
- **LBL-32** Si hay trazas de varios archivos, el chip DEBERÍA indicar el
  archivo (tooltip o sufijo), para distinguir dos columnas homónimas de
  archivos distintos.
- **LBL-33** Los chips PUEDEN reordenarse arrastrándolos. Si no se implementa,
  el orden es el de inserción.

### 3.7 Contenido del hover

- **LBL-34** Las etiquetas DEBEN ir en el campo `hovertext` de la traza e
  incluirse en el `hovertemplate` mediante `%{hovertext}`. NO DEBEN usar
  `customdata` (ya usado para el tiempo formateado) ni `text` (ya usado por
  "Repeated").
- **LBL-35** Formato: una línea por etiqueta, en el orden de la lista, debajo de
  la línea del valor:
  ```
  Time = 2016-01-29
  debito_marara_xpf = 2500
  descripcion: VERSEMENT ESPECES VERS 625318 PUNAAUIA…
  cuenta: marara
  ```
  El nombre va en negrita, como el de la variable.
- **LBL-36** Cada valor DEBE truncarse a **80** caracteres **(provisional)**,
  añadiendo `…`, y DEBE escaparse el HTML (`<`, `>`, `&`), porque Plotly
  interpreta HTML en el hover.
- **LBL-37** Una etiqueta vacía en esa fila (celda vacía, NULL o `''`) NO DEBE
  generar línea. Si todas están vacías, el hover queda igual que hoy.
- **LBL-38** En puntos sintéticos que no se puedan atribuir a una fila, NO DEBE
  mostrarse ninguna etiqueta. Mostrar la de otra fila está prohibido (ver
  LBL-45).

### 3.8 Correspondencia punto ↔ fila fuente

Invariante: **la etiqueta mostrada en un punto DEBE ser el valor de la columna
de texto en la fila fuente de ese punto.** Todos los requisitos de esta sección
se derivan de ella.

**Modo completo:**

- **LBL-39** El diezmado (`decimateRangeIndexes`, `src/compute/kernels/resample.js`)
  DEBE exponer los índices elegidos. Las etiquetas se toman con esos mismos
  índices. Con mín./máx. por cubeta, la etiqueta es la de la fila que produjo el
  mín. o el máx.
- **LBL-40** Las transformaciones de traza (recorte, desplazamiento de tiempo,
  ganancia, inversión, remapeo de índices: `_getTransformIndexData`,
  `_getTransformedVariableData`) DEBEN aplicarse con los mismos índices a las
  etiquetas.
- **LBL-41** Toda operación que inserte o quite puntos DEBE hacer lo mismo en
  `hovertext`, con `''` en los puntos insertados:
  - cortes de línea: `_applyLineBreaks`, `_insertTraceGapBreaks`;
  - relleno de pilas: `_applyTimeseriesStackZeroPadding`;
  - datos dispersos: `_buildSparseVisualData`.
- **LBL-42** Los caminos de *restyle*, tanto el de modo completo
  (`interaction-methods.js:~323-390`) como el por lotes
  (`_applyBatchedTimeseriesRestyle`, `~1036-1082`), DEBEN enviar `hovertext` y
  `hovertemplate` cuando haya etiquetas, y limpiarlos cuando se quiten.
- **2D (`phase2d`):** mismos índices de paso que los puntos
  (`_downsampleStrideIndexes` / `_pickIndexed`).

**Modo lazy:**

- **LBL-43** Vista general: las etiquetas DEBEN tomarse de las columnas de texto
  ya cargadas en la vista general, que están alineadas fila a fila.
- **LBL-44** Zoom en bruto (filas reales): la consulta DEBE incluir cada
  columna de etiqueta como `CAST("col" AS VARCHAR)` en el mismo `SELECT`. Hoy
  todas las consultas de zoom usan `try_cast(... AS DOUBLE)` y devuelven `null`
  para el texto.
- **LBL-45** Zoom agregado (mín./máx. por cubeta): la consulta DEBE usar
  `arg_min(col, v)` y `arg_max(col, v)` por columna de etiqueta y por variable.
  DEBERÍA usar además `arg_min(t, v)` / `arg_max(t, v)` para que el punto quede
  en su tiempo real y deje de ser sintético. Si no se hace, rige LBL-38.
- **LBL-46** La lista de etiquetas DEBE formar parte de las claves de caché
  (`_rangeCacheKey`, caché de trayectorias de fase) y del re-diezmado de la
  vista previa (`_renderedTracePreview`).
- **LBL-47** Trayectorias 2D en lazy (`getPhaseTrajectory`): añadir las
  columnas de etiqueta a la misma consulta.

**Casos sin fila fuente:**

- **LBL-48** Las variables derivadas y las de Data Tools **no** muestran
  etiquetas, salvo que conserven un índice de fila fuente fiable (hoy solo en
  modo completo). Las trazas sin etiqueta en un gráfico con etiquetas NO DEBEN
  mostrar líneas vacías.

### 3.9 Cursores A|B (entrega temprana, opcional)

- **LBL-50** En modo completo, la lectura del cursor PUEDE mostrar, para cada
  etiqueta del gráfico, el valor en la fila fuente más cercana a la x del
  cursor. La búsqueda es binaria sobre los tiempos fuente, sin depender del
  diezmado.
- **LBL-51** Si se implementa, en modo lazy DEBE mostrarse solo cuando el punto
  dibujado sea una fila real.

### 3.10 Rendimiento

- **LBL-60** Con etiquetas, el tiempo de dibujo de un gráfico con 1 M de filas en
  modo completo NO DEBE empeorar más de un 10 % respecto del mismo gráfico sin
  etiquetas (medido con `bench/`).
- **LBL-61** En modo lazy, una consulta de zoom con 5 etiquetas NO DEBERÍA tardar
  más del doble que sin etiquetas. Medir antes de fijar el límite de LBL-23.
- **LBL-62** No se copian columnas de texto completas a Plotly: solo el
  `hovertext` de los puntos dibujados.

### 3.11 Fuera de alcance

- Graficar columnas de texto como trazas (categóricas).
- Filtrar o colorear puntos por el valor de una columna de texto.
- Etiquetas en `phase2dt`, `phase3d`, `fft`, `histogram`, `heatmap` y `correlation`.
- Una tabla de datos o inspector de filas.

### 3.12 Criterios de aceptación

Con `finanzas_unificadas_2016-2026.csv` y un gráfico de `debito_marara_xpf`:

1. **Arrastre simple.** Arrastrar `descripcion` sobre el gráfico muestra el
   aviso de LBL-10. Al soltar aparecen el chip y la confirmación. El hover del
   punto del 2016-01-29 muestra `VERSEMENT ESPECES VERS 625318 PUNAAUIA PUNAVAI`.
2. **Varias columnas.** Arrastrar además `cuenta` añade una segunda línea en el
   orden de inserción. Quitar el chip `descripcion` deja solo `cuenta`.
3. **Selección mixta.** Seleccionar `saldo_marara_xpf` + `fuente` y soltar crea
   la traza y añade la etiqueta.
4. **Gráfico no admitido.** Sobre un histograma, el aviso explica LBL-11 y soltar
   no añade etiquetas.
5. **Correspondencia.** En los tres modos (DuckDB completo, DuckDB lazy forzado
   con `csvFullLoadMb`, parser JS), para 50 puntos dibujados elegidos al azar
   tras varios zooms, la etiqueta coincide con la fila fuente del punto.
6. **Persistencia.** Guardar y restaurar la sesión conserva las etiquetas y su
   orden.
7. **Varios archivos.** En un gráfico con trazas de dos archivos, la etiqueta
   del archivo A no aparece en las trazas del archivo B.

---

## 4. Parte B: tipo por columna en el diálogo de importación

### 4.1 Estado actual

- En el diálogo de vista previa CSV, la casilla **"Show column options"**
  (`csvPreviewColumnTools`, `csv-parsing-preview-dialog.js:1919-1930`)
  despliega, por columna: usar sí/no, **nombre** y **unidad**. La unidad existe
  desde `8bdf036`.
- Todo se guarda en `columnOverrides[index] = { name?, description? }`.
- **Falta elegir el tipo.** Además, el diálogo no muestra qué tipo detectó.

### 4.2 Requisitos

**Modelo:**

- **TYP-1** `columnOverrides[index]` DEBE admitir `type: 'numeric' | 'string'`.
  Si `type` no existe, el tipo es "auto".
- **TYP-2** Un perfil guardado sin `type` DEBE comportarse exactamente como hoy
  (compatibilidad con sesiones y perfiles existentes).
- **TYP-3** El tipo final de cada columna DEBE resolverse en **una sola función
  compartida**, p. ej. `resolveCsvColumnType(profile, index, autoType)`. El tipo
  forzado gana siempre sobre el automático.
- **TYP-4** Esa función DEBE ser la única fuente del tipo en todos los caminos:
  - DuckDB completo y lazy (`_csvColumnSpecs`);
  - conversión a Parquet (`csvColumnSpecs` en `csv-to-parquet-core.js`), que se
    DEBERÍA fusionar antes con la copia de `duckdb-source.js`;
  - parser JS `parse` / `parseWithProfile`, en worker y en el hilo principal
    (hoy `csv-parser.js:173` y `:468` ignoran el perfil);
  - live-append de ambos caminos (`_numericColumnIndexSet`, especificaciones de
    `appendCsvDelta`);
  - el marcado de celdas inválidas del propio diálogo.

**Interfaz:**

- **TYP-10** El panel de "Show column options" DEBE convertirse en una tabla con
  una fila por columna: **usar | nombre | tipo | unidad**.
- **TYP-11** El selector de tipo DEBE ofrecer:
  - `Auto (numérico)` / `Auto (texto)`: muestra lo detectado;
  - `Numérico`;
  - `Texto`.
- **TYP-12** El tipo detectado en "Auto" DEBE calcularse con el mismo criterio
  que usará la carga (etapa 1: columna completa o la muestra ampliada que se
  decida). No DEBE calcularse solo con las líneas visibles de la vista previa.
- **TYP-13** Al elegir `Numérico` en una columna detectada como texto, el diálogo
  DEBE mostrar cuántas celdas no vacías de la muestra quedarán como NaN: *"12 de
  40 celdas no son números y quedarán vacías"*.
- **TYP-14** La cuadrícula de vista previa DEBERÍA mostrar una fila de tipo
  (`123` / `Aa`) junto a "Detected units", y marcar las columnas forzadas.
- **TYP-15** La columna de tiempo NO DEBE permitir forzar el tipo: el selector
  aparece desactivado, con un tooltip que lo explica.
- **TYP-16** La unidad de una columna `Texto` PUEDE editarse, pero no tiene
  efecto. El campo DEBERÍA mostrarse atenuado.
- **TYP-17** El diálogo DEBE impedir aplicar dos columnas con el mismo nombre
  final (hoy DuckDB no deduplica y chocarían en `columns=`). Muestra el error
  junto al nombre y desactiva Apply.
- **TYP-18** Los textos nuevos DEBEN existir en EN, FR y ES.

**Semántica:**

- **TYP-20** `Numérico` forzado: cada celda se convierte con `parseCsvNumber`
  (o su equivalente SQL exacto, ver PAR-3), y lo que no se pueda convertir queda
  NaN. El resultado DEBE ser idéntico en los dos parsers.
- **TYP-21** `Texto` forzado: se conserva el texto de la celda sin espacios en
  los extremos, igual en los dos parsers (hoy DuckDB no los quita). Una celda
  vacía es `''`.
- **TYP-22** Una columna pasada a `Texto` deja de ser graficable. Pasa a
  poder usarse como etiqueta (Parte A).
- **TYP-23** Si al restaurar una sesión una traza apunta a una variable que ahora
  es `Texto`, la traza DEBE quitarse sin error y DEBE avisarse al usuario.
- **TYP-24** Al recargar un archivo que cambió, si una columna forzada a
  `Numérico` resulta 100 % NaN, DEBE avisarse al usuario.

**Tipos adicionales (fuera de esta versión):**

- **Booleano:** PUEDE añadirse después (true/false/sí/no/1/0 → 1/0, con
  `dataType: 'boolean'`, que ya existe aguas abajo).
- **Categórico y fecha secundaria:** fuera de alcance.

### 4.3 Criterios de aceptación

1. En el archivo del BCE (`test-files/csv/ecb_euro_exchange_rates_daily.csv`),
   forzar `RON` a `Numérico` produce una columna numérica con NaN donde había
   `N/A`, **idéntica con DuckDB y con JS**, en carga completa, lazy, recarga y
   live-append.
2. Forzar `debito_marara_xpf` a `Texto` en el CSV del usuario la vuelve no
   graficable y disponible como etiqueta. La sesión guardada y restaurada
   conserva el tipo.
3. Un perfil guardado antes de esta función se carga sin cambios.
4. Renombrar dos columnas con el mismo nombre desactiva Apply.

---

## 4bis. Parte D: fijar la fila de títulos en la vista previa CSV

### 4bis.1 Estado actual [código]

En la tabla de la vista previa (`_renderGrid`, `csv-parsing-preview-dialog.js:~2176`;
estilos en `src/styles/overlays.css:2106-2160`):

| Elemento | ¿Fijo al desplazar? |
|---|---|
| Cabecera de la tabla (`thead`: letras de columna, "Fila", "DateTime parsed") | **sí**, arriba, siempre |
| Columna de número de fila (`.csv-preview-row-head`) | **sí**, a la izquierda, siempre |
| Columna **"DateTime parsed"** (`.csv-preview-parsed-cell`) | **sí**, a la izquierda, **siempre, sin casilla** |
| **Fila de títulos del archivo** (`tr.is-header-row`) | **no**: está en `tbody` y se desplaza con los datos |
| Fila de unidades (`is-units-row`), "Detected units", "New names" | **no** |
| Columna(s) de tiempo de origen (`td.is-time-column`) | **no** |

Consecuencia: al desplazarse hacia los datos (o con la ventana de la etapa 3b,
que empieza lejos de la cabecera), se pierde de vista qué es cada columna.

### 4bis.2 Requisitos

- **PRV-1** El panel de opciones del diálogo DEBE ofrecer una casilla **"Fijar
  fila de títulos"**. Activada, la fila de títulos del archivo queda fija
  arriba, justo debajo de la cabecera de la tabla, al desplazarse
  verticalmente.
- **PRV-2** Con PRV-1 activa, también DEBEN quedar fijas, en este orden, las
  filas que describen columnas y que existan: fila de unidades del archivo,
  "Detected units" y "New names". Sin ellas, el título fijo no dice la unidad
  ni el nombre final.
- **PRV-3** La fila de títulos fija DEBE mostrarse aunque no esté entre las
  filas cargadas o visibles:
  - con la ventana de la etapa 3b;
  - con "Hide preamble rows";
  - con "Hide invalid lines".

  Es la forma de ver las columnas cuando los datos empiezan en la fila 2000.
- **PRV-4** Si el archivo no tiene fila de títulos (`hasHeader = false`), la
  casilla DEBE aparecer desactivada, con un tooltip que lo explique.
- **PRV-5** La columna "DateTime parsed" DEBE seguir fija a la izquierda
  **siempre**, como hoy, sin casilla (decisión del autor). Las columnas de
  tiempo de origen (`is-time-column`) no se fijan.
- **PRV-6** Valor por defecto de la casilla "Fijar fila de títulos":
  **activada (provisional)**. DEBE recordarse entre aperturas del diálogo como
  preferencia del usuario (no por archivo). NO DEBE guardarse en el perfil CSV,
  porque no afecta al parsing.
- **PRV-7** Las filas y columnas fijas DEBEN conservar sus colores actuales
  (título azul, unidades verde, "DateTime parsed" azul claro). La esquina
  (intersección de fila fija y columna fija) DEBE quedar por encima de ambas,
  como ya se hace hoy con la esquina de la cabecera (`z-index`).
- **PRV-8** El texto de la casilla y su tooltip DEBEN existir en EN, FR y ES.

Nota de implementación (no normativa):

- Varias filas fijas apiladas necesitan desplazamientos `top` acumulados.
- La forma más simple es renderizar esas filas dentro de `thead`, que ya es
  fijo, en lugar de calcular `top` a mano.
- PRV-3 sale casi gratis así: la fila de títulos se toma de
  `state.headerIndex`, no de las filas visibles.

### 4bis.3 Criterios de aceptación

1. Con "Fijar fila de títulos" activa, al desplazarse hasta el final de la
   tabla, los títulos `fecha, tipo_fila, …` del CSV del usuario siguen
   visibles.
2. Con la primera fila de datos en 2000 (etapa 3b), la fila de títulos aparece
   fija sobre las filas de datos.
3. Con la casilla desactivada, la fila de títulos se desplaza como hoy. Al
   reabrir el diálogo, la casilla sigue desactivada.
4. Un archivo sin fila de títulos muestra la casilla desactivada.
5. "DateTime parsed" sigue fija a la izquierda en todos los casos.

---

## 5. Parte C: paridad y tests

- **PAR-1** Antes de cualquier cambio de Parte A o B DEBE existir la batería de
  paridad de la etapa 0: cada fixture de `test-files/csv/**` se carga con DuckDB
  y con el parser JS en la app real, y se compara por variable:
  - `dataType`;
  - longitud;
  - valores (hash exacto, NaN por posición);
  - orden;
  - nombre;
  - unidad.

  Las diferencias aceptadas quedan en una lista explícita
  (`backend-parity-expected.json`) con su motivo. El objetivo es que la lista
  quede vacía.
- **PAR-2** La batería DEBE cubrir todos los modos:
  - carga completa;
  - lazy (vista general + zoom sobre una ventana fija);
  - worker vs. hilo principal;
  - perfil automático vs. perfil del usuario sin cambios;
  - perfil con overrides (nombre, unidad, **tipo**);
  - live-append;
  - recarga;
  - CSV → Parquet → carga.
- **PAR-3** Para TYP-20, la conversión numérica en SQL DEBE producir el mismo
  resultado que `parseCsvNumber`. Si algún caso no se puede reproducir en SQL,
  queda documentado en la lista de PAR-1 y se decide explícitamente qué
  semántica gana.
- **PAR-4** Todo PR que toque:
  - `csv-parser.js`;
  - `csv-time-detection.js`;
  - la parte CSV de `duckdb-source.js`;
  - `csv-to-parquet-core.js`;
  - el diálogo de vista previa;
  - la construcción o el *restyle* de trazas (Parte A),

  DEBE ejecutar la batería y no puede introducir diferencias nuevas.
- **PAR-5** Tests específicos de la Parte A:
  - correspondencia punto ↔ fila fuente (criterio 3.12.5) en los tres modos,
    con diezmado, cortes de línea, transformaciones y zoom lazy en bruto y
    agregado;
  - arrastre con ratón y con dedo, selección mixta y avisos;
  - persistencia de `hoverLabels`.
- **PAR-6** Tests específicos de la Parte B:
  - `type` forzado en ambos sentidos y "auto";
  - ida y vuelta de sesión;
  - perfil antiguo sin `type`;
  - nombres duplicados;
  - claves i18n.
- **PAR-7** Cada bug encontrado durante la implementación DEBE añadir un fixture
  que lo reproduzca.

---

## 6. Orden de entrega

| Paso | Contenido | Depende de |
|---|---|---|
| 1 | Etapa 0: batería de paridad (PAR-1, PAR-2) | — |
| 2 | Etapa 1: tipos con la columna completa | 1 |
| 3 | Parte B: tipo por columna (TYP-*) | 2 |
| 4 | Parte A, modo completo: arrastre, avisos, chips, hover (LBL-1…42, LBL-48) | 2 |
| 5 | Parte A, cursores (LBL-50) | 4 |
| 6 | Etapa 2: orden estable y fechas SQL | 1 |
| 7 | Parte A, modo lazy (LBL-43…47) | 4, 6 |
| 8 | Parte D: fijar la fila de títulos (PRV-*), junto con la etapa 3 del plan | — (PRV-3 se completa con la etapa 3b) |

Cada paso es un PR independiente, con su test y su criterio de aceptación.

## 7. Decisiones pendientes

| # | Pregunta | Propuesta provisional |
|---|---|---|
| 1 | Largo máximo de cada valor en el hover | 80 caracteres |
| 2 | Máximo de etiquetas por gráfico | 5 (confirmar con la medición de LBL-61) |
| 3 | ¿En qué gráficos? | **Decidido:** solo `timeseries` y `phase2d` |
| 4 | ¿Tipo Booleano en el selector? | No en esta versión |
| 5 | Criterio "auto" de la etapa 1 para columnas con mayoría de `N/A` | Tratar `N/A`, `NA`, `-`, `null` y `#N/A` como vacíos, y no como texto |
| 6 | ¿Chips reordenables? | No en esta versión (orden de inserción) |
| 7 | Vista previa: valor por defecto de "Fijar fila de títulos" | Activada |
