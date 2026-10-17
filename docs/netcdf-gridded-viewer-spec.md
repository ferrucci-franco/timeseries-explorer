# Visor de datos grillados netCDF (ERA5 y afines): estado actual y especificación

Estado (2026-10-15): **Fase 0 y Fase 1 implementadas**, ver §11. Las fases 2–4
siguen siendo especificación.
Alcance: el lector netCDF *genérico* (`src/parsers/netcdf-parser.js`). Los
archivos **PyPSA quedan fuera** de este documento: su lector
(`pypsa-netcdf-parser.js`) funciona bien y no se toca. Cualquier cambio que salga
de aquí tiene que mantener intacta la detección PyPSA (`_looksLikePypsa`) que se
evalúa antes del camino genérico.

Motivo: varios colegas intentaron abrir archivos ERA5 descargados del Copernicus
Climate Data Store y "no anda nada". Este documento:

1. explica **por qué** no anda, con mediciones (§1);
2. compara con lo que existe hoy en línea y en escritorio (§2);
3. define la propuesta de valor: lo que ninguna herramienta ofrece hoy sin
   escribir código (§3);
4. especifica el visor ideal, que debe correr igual en la web y en Electron (§4–§7);
5. propone un orden de implementación por fases, empezando por un rescate rápido
   que haga funcionar ERA5 ya (§8).

---

## 0. Resumen ejecutivo

- El lector actual se diseñó para **series temporales guardadas en netCDF**
  (estaciones, sensores, PyPSA). Para eso funciona bien. Pero un archivo grillado
  (`[tiempo, lat, lon]` o `[tiempo, nivel, lat, lon]`) lo convierte en hasta
  **10.000 series sueltas**, una por punto de grilla, con nombres como
  `/t2m [latitude=72, longitude=-12]`. **No hay mapa, ni slider de tiempo, ni
  noción de geografía.**
- Con archivos sintéticos que copian el layout real del nuevo CDS, medimos:
  - Un recorte europeo de **3,6 MB** tarda **75 s** en abrir (≈ 10.000 lecturas
    punto a punto sobre datos comprimidos por bloques). Leer una variable entera
    con la misma librería tarda **15 ms**.
  - Un día global a 0,25° (110 MB) no termina en tiempo razonable (§1.2).
  - Un mes horario global (1–3 GB, el caso típico) **ni siquiera entra**: el límite
    es 250 MB en web y 1 GB en escritorio.
  - El ZIP que entrega el CDS cuando se mezclan variables instantáneas y acumuladas
    falla con un mensaje genérico.
  - GRIB, el formato nativo de ERA5, no se reconoce.
  - Un archivo de un solo instante (un "mapa") toma la **latitud como eje X**.
- Las bases técnicas para hacerlo bien ya están en el proyecto o a mano:
  - h5wasm puede leer un `File` local **por partes** dentro de un Worker
    (WORKERFS), sin cargarlo entero ni subirlo a ningún servidor.
  - Electron ya sirve archivos locales con soporte de `Range`.
  - `fflate` (para ZIP) ya es dependencia.
  - El explorador de series ya tiene FFT, integrales, mapas de calor y variables
    derivadas.
- **Propuesta:** un modo "Dataset grillado" con mapa 2D sobre costas offline,
  slider de tiempo, selector de nivel y herramientas dibujables (punto, línea,
  región). Cada herramienta produce una serie o un perfil que entra al explorador
  existente, que ya sabe analizarlo.
- **Lo que nadie ofrece junto** (ver §3): un archivo propio, local y privado, sin
  instalar nada ni escribir código, con:
  - medias por región dibujada **ponderadas por área**;
  - transectos y cortes verticales;
  - diagramas de Hovmöller;
  - climatologías y anomalías;
  - **FFT en tiempo y en espacio** (incluidos espectros de número de onda zonal y
    mapas de amplitud y fase del ciclo diurno).
  - Además, cada resultado puede mostrar el **código xarray equivalente**, como
    puente pedagógico hacia la investigación.

---

## 1. Estado actual

### 1.1 Cómo funciona hoy

Flujo (`file-methods.js` → `parse:netcdf` en el worker → `NetcdfParser.parse`):

1. **Límite de tamaño previo:** 250 MB en web y 1 GB en escritorio
   (`pypsa-netcdf-limits.js`). El archivo se lee **entero** en un `ArrayBuffer`.
2. **Detección por bytes mágicos:**
   - HDF5 (netCDF4) → h5wasm. El buffer se **copia** al FS en memoria de
     Emscripten, así que ocupa el doble de RAM.
   - CDF-1/CDF-2 (netCDF3) → `netcdfjs`, que también necesita el buffer completo.
   - CDF-5 → error explícito.
   - Cualquier otra cosa → "not a recognized netCDF3 or netCDF4/HDF5 file".
3. Si la raíz parece PyPSA → lector PyPSA (fuera de alcance).
4. **Camino genérico** (`_parseGeneric`):
   - Se elige **una sola coordenada X por archivo**, por puntaje. Pesan unidades CF
     `… since …`, `axis=T`, `standard_name=time` y nombres tipo `time`. Solo
     califican coordenadas 1-D de **longitud > 1**.
   - Cada variable numérica que comparte esa dimensión se "despliega": una serie
     por combinación de las demás dimensiones.
   - Tope global de **10.000 series por archivo**, más un presupuesto de 2 M de
     valores por variable. Si no entra, se toma una submuestra equiespaciada por eje
     (ver `docs/netcdf-gridded-subsampling.md`).
   - Cada serie se lee con un hyperslab **punto por punto** (`_readSeries`).
5. Se decodifica `scale_factor`/`add_offset`/`_FillValue`/`missing_value`. El
   tiempo CF se convierte a fecha, salvo los calendarios no estándar (`360_day`,
   `noleap`, …), que quedan numéricos.
6. El árbol de variables recibe una entrada por serie, más nodos de metadatos:
   atributos globales, coordenadas auxiliares, variables omitidas y parciales.

### 1.2 Pruebas con archivos tipo ERA5

Para las pruebas se generaron archivos sintéticos con el **layout exacto** documentado
para el nuevo CDS (desde 2024-09) y para el CDS legacy:

- **Nuevo CDS:** netCDF4 con zlib + shuffle. `valid_time` int64 en
  `seconds since 1970-01-01`, `pressure_level` float64 decreciente, `latitude`
  90→-90, `longitude` 0→359.75, datos float32 con `_FillValue=NaN`, `number`
  escalar int64 y `expver` string.
- **Legacy:** netCDF3 64-bit offset, `time` int32 en `hours since 1900-01-01`,
  int16 empaquetado.

Se pasaron por el parser actual en Node, con las mismas versiones de `h5wasm` y
`netcdfjs`.

| Archivo de prueba | Tamaño | Resultado actual | Tiempo |
|---|---:|---|---:|
| Legacy CDS, netCDF3, 24 h, Europa 0,25° (161×209) | 1,6 MB | Abre: 10.000 de 33.649 puntos como series sueltas | 0,3 s |
| Nuevo CDS, netCDF4, 24 h, Europa, 2 variables | 3,6 MB | Abre: 4.970 de 33.649 puntos por variable; omite `expver` y `number` | **75 s** |
| Nuevo CDS, niveles de presión (4 niveles), 24 h, Europa | 7,4 MB | Abre: 10.000 de 134.596 series (4 niveles × 50 lat × 50 lon) | **80 s** |
| Nuevo CDS, 24 h, **global** 0,25° (721×1440) | 110 MB | No termina en 25 min (ver nota) | > 25 min |
| Nuevo CDS, **1 solo instante**, Europa | 0,2 MB | Abre, pero con **la latitud como eje X**, una "serie" por longitud y etiquetas `valid_time=1704067200` sin decodificar | 0,3 s |
| ZIP del nuevo CDS (instant + accum) guardado como `.nc` | 7,3 MB | **Falla**: "not a recognized netCDF3 or netCDF4/HDF5 file" | — |
| Mes horario global, 1 variable (caso típico real) | 1–3 GB | **Rechazado** por el límite de tamaño, en web y en escritorio | — |
| GRIB (formato nativo de ERA5) | — | Extensión no aceptada | — |

Nota sobre el global: una sola serie de un punto cuesta ≈ 245 ms porque obliga a
descomprimir los 24 bloques completos. Con 10.000 puntos son ≈ 40 min.

Lectura directa con h5wasm sobre los mismos archivos, que da la cota de lo
alcanzable:

| Operación | Europa 3,6 MB | Global 110 MB |
|---|---:|---:|
| Abrir y leer metadatos | 10 ms | 11 ms |
| Un mapa (un instante, todos los puntos) | 14 ms | 50 ms |
| Variable completa (24 mapas, `Float32Array`) | 15 ms | 1,2 s |
| Serie temporal de **un** punto | 10 ms | 245 ms |

**Conclusión:** el cuello de botella no es la librería sino la estrategia de
lectura. Leer por bloques (por instante, en el orden en que está guardado el
archivo) es entre 1.000 y 5.000 veces más rápido que leer punto a punto.

### 1.3 Causas raíz

| # | Problema | Dónde | Efecto con ERA5 |
|---|---|---|---|
| R1 | **Paradigma:** la grilla se aplana en series sueltas, con un solo eje X por archivo | `_parseGeneric` | No hay mapa. Diez mil entradas en el árbol (~100.000 nodos DOM) inútiles para un climatólogo |
| R2 | **Carga ansiosa** del archivo completo y copia al FS de Emscripten | `parse()`, `_parseHdf5` | Un mes de ERA5 (1–3 GB) supera los límites. Pico de RAM ≈ 2× el archivo |
| R3 | **Lectura punto a punto** de datos con compresión por bloques | `_readSeries` | 75 s para 3,6 MB. Cada punto vuelve a descomprimir todos los bloques |
| R4 | `_descriptorIsNumeric` y `readFlat` leen **variables enteras como `Array` JS** (números en caja) solo para saber si son numéricas, y las cachean | `_descriptorIsNumeric`, `readFlat` | ~8–16× la memoria del `Float32Array` original. El tipo ya está en `dtype` |
| R5 | No se reconoce el **ZIP** del nuevo CDS | detección por magia | Error genérico. El usuario cree que el archivo está roto |
| R6 | **GRIB** no soportado | `RESULT_FILE_EXTENSIONS`, parser | El formato recomendado por ECMWF no abre |
| R7 | Coordenada X candidata exige longitud > 1 | `_coordinateAxisCandidate` | Un archivo de un instante elige `latitude` como X; el tiempo queda como entero crudo |
| R8 | Calendarios no estándar (`noleap`, `360_day`, `all_leap`) quedan numéricos | `_axisFromCoordinate` | CMIP y modelos climáticos sin fechas |
| R9 | netCDF3 sin lectura parcial (`netcdfjs` exige el buffer completo); CDF-5 sin soporte | `_parseNetcdf3` | Archivos legacy grandes y salidas de WRF/MPAS en CDF-5 |
| R10 | Un solo eje de tiempo por archivo | `_selectCoordinate` | Variables con otro eje (p. ej. `step`, otro `time`) quedan "no alineadas" |
| R11 | Sin noción de **geografía:** no detecta lat/lon (ni 1-D ni curvilíneas 2-D como `XLAT`/`XLONG` de WRF), ni límites de celda, ni áreas | — | Imposible mapear, ponderar por área o recortar por región |
| R12 | Las estadísticas sobre la submuestra **no son las del campo** (sin ponderación por área). Está documentado como limitación | `gridSample` | Medias espaciales engañosas si alguien las calcula con las series cargadas |
| R13 | Errores poco accionables | mensajes | "No anda nada" en lugar de "esto es un ZIP con 2 netCDF: ¿cuál abrimos?" |

### 1.4 Lo que funciona y hay que conservar

- **Series temporales en netCDF** (estaciones, ARM `base_time`/`time_offset`,
  MADIS, archivos con `time` + `station`). Este camino es correcto y debe seguir
  igual para archivos que no son grillas geográficas.
- Decodificación de tiempo CF (unidades `… since …`, orígenes con zona, `_`
  entre fecha y hora), empaquetado y valores de relleno.
- Grupos HDF5, dimension scales, atributos.
- Detección y lector PyPSA, sin cambios.
- Los fixtures y tests existentes: `npm run test:netcdf`, `verify:netcdf-corpus` y
  `scripts/bench-netcdf-grid.mjs`.

---

## 2. Comparación con otras herramientas

Relevamiento a octubre de 2026. Algunas capacidades no pudieron verificarse a mano
y se marcan "?". Leyenda:

- **S** = sí
- **P** = parcial
- **N** = no
- **?** = no verificado

### 2.1 Acceso

| Herramienta | Tipo | ¿Instalar? | ¿Archivo propio, local, sin subirlo? | Formatos |
|---|---|---|---|---|
| Panoply 5.9 (NASA) | Escritorio, Java | Sí | S (escritorio) | netCDF3/4, HDF, GRIB, OPeNDAP |
| ncview | Escritorio, X11 | Sí | S (escritorio) | netCDF |
| IDV 6.3 (Unidata) | Escritorio, Java | Sí | S (escritorio) | netCDF, GRIB, THREDDS |
| QGIS + Crayfish | Escritorio | Sí | S (escritorio) | netCDF, GRIB, Zarr (GDAL/MDAL) |
| ArcGIS Pro | Escritorio, comercial | Sí | S (escritorio) | netCDF, GRIB, HDF, Zarr |
| NASA Giovanni | Web | No (cuenta) | **N**: solo su catálogo | — |
| Copernicus Climate Atlas / Climate Pulse / ERA Explorer | Web | No | **N**: solo sus datos | — |
| Climate Reanalyzer, NOAA PSL WRIT | Web | No | **N** | — |
| KNMI Climate Explorer | Web | No (registro) | **N**: el archivo se **sube** al servidor | netCDF, ASCII |
| Climate Engine, Google Earth Engine | Web | No (cuenta Google) | N (GEE además exige código) | Catálogo propio |
| earth.nullschool, Windy, Ventusky | Web | No | **N**: solo pronósticos propios | — |
| Godiva3 / ncWMS / THREDDS | Servidor + web | Un admin instala el servidor | N | CF-netCDF |
| xcube viewer | Web + servidor Python | Sí (`xcube serve`) | Solo con servidor local | Zarr, netCDF |
| myHDF5 / H5Web | Web | No | **S**, archivos de cualquier tamaño, lectura parcial en Worker | Solo HDF5/netCDF4 (sin netCDF3) |
| GribBox, demo grib-rs | Web | No | S (según sus autores) | GRIB2 / netCDF |
| Browzarr | Web (pre-1.0) | No | ? | Zarr, netCDF4 |
| Jupyter + xarray (Pangeo) | Código | Sí | S | Todos |
| CDO / NCO | Línea de comandos | Sí | S | netCDF, GRIB |

### 2.2 Análisis sin código

Columnas: mapa = mapa con costas; reg. = estadística por región dibujada;
transect. = transecto por línea; Hov. = Hovmöller; anom. = anomalías.

| Herramienta | Mapa | Slider | Niveles | Reg. (¿pond. área?) | Transect. | Serie en punto | Hov. | FFT | Anom. |
|---|---|---|---|---|---|---|---|---|---|
| Panoply | S (200+ proyecciones) | S | S | N (solo media zonal) | P (lat/lon const.) | S | S (tiempo-lat) | N | P |
| ncview | P | S | S | N | N | S | P | N | N |
| IDV | S (3D) | S | S | P (fórmulas) | **S** | S | S | N | P |
| QGIS + Crayfish | S | S | S | P (sin cos lat) | **S** | S | N | N | N |
| ArcGIS Pro | S | S | S | S (extensión paga) | P | S | N | N | S |
| Giovanni | S | S | S | S (caja) | P | S | S | N | P |
| KNMI Climate Explorer | S | N | P | S (caja) | N | S | ? | **S (solo series)** | S |
| NOAA PSL WRIT | S | N | S | S (caja) | P | S | S | N | S |
| Climate Atlas | S | P | N | S (regiones / GeoJSON) | N | S | N | N | S |
| Godiva3 / ncWMS | S | S | S | N | **S** | S | N | N | N |
| xcube viewer | S | S | ? | **S (polígono dibujado)** | ? | S | N | N | P |
| myHDF5 / H5Web | **N** (sin geografía) | P | P | N | N | S | P | N | N |
| Windy / nullschool | S (muy lindo) | S | S | N | N | P | N | N | P |
| xarray (código) | S | S | S | S (`weighted`) | S | S | S | S (xrft) | S |
| CDO (CLI) | N | N | S | S (`fldmean`) | P | S | S | P | S |

### 2.3 El hueco

Ninguna herramienta reúne, **sin instalar, sin subir el archivo y sin escribir
código**:

1. **Mapa geográfico del archivo propio** (ERA5, CMIP, WRF), con costas, slider de
   tiempo y selector de nivel.
   - Las web que mantienen el archivo local (myHDF5, GribBox) no tienen geografía.
   - Las web con mapa solo muestran su propio catálogo.
   - KNMI exige subir el archivo.
2. **Estadísticas en una región dibujada a mano, ponderadas por área.** Solo
   xcube, y requiere un servidor Python.
3. **Transecto por línea arbitraria y corte vertical a lo largo de ella.** Solo
   herramientas de escritorio (IDV, QGIS + Crayfish) o servidores (Godiva3).
4. **Hovmöller con promedio en la banda,** calculado en el cliente.
5. **Análisis espectral:**
   - En tiempo, solo KNMI (servidor, subiendo el archivo).
   - **En espacio** (número de onda zonal, espectro 2D, número de onda–frecuencia),
     **ninguna** herramienta sin código.
6. **Climatologías y anomalías sobre el archivo propio** (período base a elección).
   Solo con código o CLI.
7. **Privacidad + archivos grandes en el navegador.** myHDF5 demuestra que la lectura
   parcial de un archivo local de varios GB es viable, pero nadie la combinó con
   análisis geográfico.

---

## 3. Propuesta de valor

> **"Arrastrá tu ERA5 al navegador y en dos segundos tenés el mapa. Dibujá tu
> región: media ponderada, mínimo y máximo, serie temporal, espectro. Sin instalar,
> sin subir nada, sin una línea de código. Y si querés, te mostramos el código
> xarray que hace lo mismo."**

Diferenciadores concretos:

1. **Local-first y privado.** El archivo nunca sale de la máquina. Funciona igual
   en web (sin instalación) y en Electron, y offline con el build portable.
2. **ERA5 sin fricción.** El visor:
   - reconoce el ZIP del CDS y lo abre;
   - reconoce GRIB (fase posterior);
   - arma solo el eje de tiempo con `valid_time`;
   - ignora `expver` y `number`;
   - maneja la latitud descendente y la longitud 0–360;
   - convierte acumulados (J m⁻² → W m⁻², m → mm);
   - **concatena varios archivos mensuales**.
3. **Herramientas dibujables:** punto, línea y región. Cada una es una puerta a un
   análisis: cada herramienta produce series y perfiles que caen en el explorador
   existente, con su FFT, integrales, mapas de calor, cursores y exportación. Es
   la fortaleza única de esta app: ningún visor de mapas tiene detrás un
   explorador de series de este nivel, y ningún explorador de series tiene
   delante un mapa.
4. **Espectral en tiempo y en espacio, sin código:**
   - FFT de la serie de un punto o de una región;
   - mapas de amplitud y fase de un período (p. ej. el ciclo diurno de ERA5
     horario);
   - espectro de número de onda zonal;
   - espectro 2D;
   - diagrama número de onda–frecuencia.
5. **Honestidad numérica visible:**
   - toda estadística espacial declara su ponderación (cos φ o área de celda);
   - declara el número de celdas y la fracción de datos faltantes;
   - declara si se calculó a resolución completa o sobre una vista previa.
6. **Puente docencia → investigación.** Cada operación ofrece el fragmento
   **xarray/Python equivalente** (copiar con un clic). El estudiante explora sin
   código y después reproduce en Jupyter.
7. **Reproducible:** una "receta" exportable (JSON sin datos) guarda archivo,
   variable, región, período y operaciones, para compartir con colegas o
   estudiantes.

---

## 4. Especificación funcional

### 4.1 Principios

- **P1, local y sin servidor.** Todo cálculo corre en Workers del navegador o del
  renderer de Electron. Ningún byte del archivo sale de la máquina.
- **P2, lectura perezosa.** Al abrir se leen solo los metadatos. Los datos se
  leen por bloques, en el orden en que están guardados, cuando una vista los
  necesita. El límite práctico lo pone el resultado, no el archivo de entrada.
- **P3, sin código.** Todo se hace con clics y gestos. El código equivalente es
  opcional y solo informativo.
- **P4, el modo grillado complementa al explorador de series y no lo reemplaza.**
  Los archivos netCDF que *son* series (estaciones, PyPSA) siguen abriendo como
  hoy.
- **P5, estadísticas correctas por defecto:** ponderación por área, NaN excluidos
  y contados, unidades propagadas.
- **P6, mensajes accionables.** Cada fallo dice qué es el archivo, por qué no se
  puede y qué hacer.
- **P7, misma app en web y en Electron.** Las diferencias se limitan a la capa de
  E/S (§6.3).

### 4.2 Entrada y detección

**Detección por contenido, no por extensión** (bytes mágicos):

| Firma | Formato | Acción |
|---|---|---|
| `89 48 44 46 0D 0A 1A 0A` | netCDF4/HDF5 | h5wasm, lectura perezosa |
| `CDF\x01`, `CDF\x02` | netCDF3 classic / 64-bit offset | Lector netCDF3 perezoso propio (§6.2) |
| `CDF\x05` | CDF-5 | Lector netCDF3 perezoso (CDF-5 es el mismo layout con enteros de 64 bits) |
| `PK\x03\x04` | ZIP (típico del nuevo CDS) | Listar el contenido con `fflate`. Si son varios `.nc`, ofrecer abrir uno o todos como un dataset combinado (instant + accum comparten grilla y tiempo) |
| `GRIB` | GRIB1/2 | Fase 3: ecCodes compilado a WASM, cargado bajo demanda. Antes de eso, un mensaje claro: "Es GRIB; pedí netCDF en el CDS o convertilo con …" |
| `\x89PNG`, `%PDF`, HTML, etc. | No es un dato | Mensaje claro ("descargaste una página de error del CDS") |

- **Extensiones aceptadas:**
  - `.nc`, `.nc4`, `.netcdf`, `.cdf`, `.h5`/`.hdf5` (si tiene semántica netCDF);
  - `.zip`;
  - `.grib`, `.grb`, `.grib2`, `.grb2` (fase 3).
- **Varios archivos a la vez** (p. ej. 12 meses de ERA5): si comparten variables y
  grilla y difieren en el tiempo, se ofrece **concatenarlos en el eje temporal**,
  como un `open_mfdataset` sin código.
- **Fase 4:** directorio Zarr local (File System Access API en Chromium, `fs` en
  Electron) y URL remota con CORS (Zarr, netCDF por HTTP Range).

### 4.3 Interpretación CF: del archivo al modelo de dataset

El primer paso deja de ser "elegir la X". Pasa a ser construir un **modelo de
dataset**:

```
Dataset
 ├─ dims: {valid_time: 744, pressure_level: 4, latitude: 721, longitude: 1440}
 ├─ coords: tiempo (decodificado), nivel (unidades, positive=down), lat, lon (+ bounds si hay)
 ├─ data_vars: t2m, d2m, … (dtype, shape, chunks, packing, fill, units, long_name)
 └─ roles: qué dimensión es T, Z, Y, X; tipo de grilla; calendario
```

**Reglas de identificación de ejes,** en orden de prioridad:

1. Atributo `axis` (T/Z/Y/X).
2. `standard_name` (`time`, `latitude`, `longitude`, `air_pressure`,
   `altitude`, `height`, `depth`, `model_level_number`, `projection_x_coordinate`,
   etc.).
3. Unidades:
   - `degrees_north` / `degrees_east` y variantes;
   - `… since …`;
   - `Pa` / `hPa`, `m`, `level`.
4. Nombres conocidos:
   - `lat`/`latitude`/`nav_lat`/`XLAT`;
   - `lon`/`longitude`/`nav_lon`/`XLONG`;
   - `time`/`valid_time`/`Times`;
   - `level`/`pressure_level`/`plev`/`lev`/`isobaricInhPa`.

**Tipos de grilla:**

- **Regular lat/lon** (ERA5, CMIP regridded): lat y lon 1-D.
- **Curvilínea** (WRF, NEMO, ROMS): lat y lon 2-D (`XLAT[y,x]`). Se dibuja como
  malla y se proyecta por celda.
- **Proyectada** con `grid_mapping` (Lambert, polar estereográfica): se usan los
  parámetros CF del atributo `grid_mapping` cuando estén.
- **No geográfica:** cualquier grilla sin lat/lon. Se muestra como "imagen"
  (ejes índice / coordenada) sin costas. Sigue siendo útil.

**Tiempo:**

- Decodificación CF completa con **calendarios** `standard`/`gregorian`,
  `proleptic_gregorian`, `noleap`/`365_day`, `all_leap`/`366_day`, `360_day` y
  `julian`. Se implementa una aritmética de fechas tipo cftime en JS.
  - Los calendarios no estándar se muestran con su fecha nominal (p. ej.
    `2050-02-30` en `360_day`).
  - Internamente se guarda el instante en días desde el origen del calendario.
- Eje de longitud 1: un archivo de un solo instante **es un mapa**, no una serie.
- `valid_time` en int64 (BigInt64Array) convertido sin pérdida.
- Si hay `time` + `step` (pronósticos, GRIB vía cfgrib): `valid_time = time + step`.
  Se ofrece elegir entre "por fecha válida" y "por inicialización".

**Otras reglas:**

- **Variables auxiliares:**
  - `expver`, `number` (escalar) y `realization` de longitud 1 → metadato.
  - `number` de longitud > 1 → **dimensión de miembros de ensamble**, con selector
    y estadísticas de ensamble (media, dispersión) como fase posterior.
- **Orden y convenciones:**
  - Latitud descendente → se presenta ascendente sin copiar (el índice se invierte
    al dibujar).
  - Longitud 0–360 → centrado a elección (−180..180 o 0..360) en el mapa, con
    costura correcta en el antimeridiano.
- **Empaquetado y relleno:** `scale_factor`, `add_offset`, `_FillValue`,
  `missing_value`, `valid_min`/`valid_max`/`valid_range`, y `_Unsigned` para
  enteros sin signo en netCDF3.
- **Unidades:** se usa `units` como texto, con un conversor pequeño para los casos
  frecuentes (§4.5.9).

### 4.4 Interfaz: modo "Dataset grillado"

#### 4.4.0 Flujo de apertura

A diferencia del `.mat`, no hay un diálogo obligatorio de "qué importar". El
`.mat` lee el archivo **entero** y después pregunta qué variables convertir en
series. Con lectura perezosa elegir antes no ahorra nada, y obligaría a decidir
sin haber visto los datos. **El panel del dataset es el selector, y el mapa es lo
que dice qué extraer.**

Pasos al abrir (arrastrar, elegir o abrir por ruta en Electron):

1. **Detección por contenido** (§4.2). Si no es un dato utilizable (GRIB antes de
   la fase 3, HTML, PDF, imagen, archivo truncado), aparece un mensaje que dice qué
   es y qué hacer. No se intenta parsear.
2. **Lectura de la cabecera:** dimensiones, variables, atributos y chunks. Son
   unos KB, en menos de 1 s, cualquiera sea el tamaño del archivo. Todavía no se
   lee ningún dato.
3. **Clasificación** del contenido:
   - **Grilla geográfica:** al menos una variable de datos con dos ejes
     reconocidos como Y/X (lat/lon 1-D, lat/lon 2-D curvilíneas o `grid_mapping`).
     Se abre el **modo dataset grillado** (paso 4).
   - **Series:** estaciones, `time` + `station`, ARM, PyPSA. Se usa el camino
     actual del explorador, **sin cambios**.
   - **Ambiguo:** tiene lat/lon, pero todas las variables son 1-D a lo largo de
     una dimensión de estaciones o puntos (p. ej. `[time, station]` con
     `lat[station]`). Aparece un diálogo: "¿Abrir como mapa de estaciones o como
     series?".
4. **Modo dataset grillado:**
   - aparece el panel del dataset;
   - el mapa muestra la **primera variable de datos** (la de más dimensiones,
     excluyendo coordenadas y auxiliares como `expver` y `number`), en el **primer
     instante** y el **primer nivel**;
   - solo se lee ese mapa (≈ 50 ms en un global de 0,25°).
5. Desde ahí, **cada herramienta lee lo que necesita**:
   - clic en un punto → serie de esa celda;
   - caja → media, mín. y máx. ponderadas, recorriendo el tiempo con barra de
     progreso y botón de cancelar.

Diálogos solo cuando hay una decisión real:

| Situación | Diálogo |
|---|---|
| ZIP | Lista de entradas, con tamaño y variables de cada netCDF. Opciones: abrir una, o abrirlas todas **como un solo dataset** si comparten grilla y tiempo (caso instant + accum del CDS) |
| Varios archivos seleccionados juntos con las mismas variables y grilla | "¿Concatenarlos en el tiempo?" (sí: un dataset; no: un dataset por archivo) |
| Contenido ambiguo (paso 3) | "¿Mapa o series?" |
| Archivo que hoy no se puede leer por partes, y es grande (netCDF3 antes del lector perezoso, en web) | Igual que hoy: aviso de tamaño, con la opción de continuar |

> **Retirado tras la tercera prueba con datos reales.** Con el punto, la región
> y el envío de las series a los gráficos, "Abrir como series" no aportaba nada
> y confundía: se quitó del panel. Queda descrito abajo como estaba previsto.

**"Abrir como series"** está siempre disponible desde el panel del dataset. Abre
un diálogo con la misma lógica que el selector del `.mat`:

- variable, niveles, caja de lat/lon y período;
- el diálogo muestra cuántas series resultan y cuánta memoria ocupan **antes**
  de confirmar;
- genera un conjunto **acotado** de series en el explorador, que reemplaza las
  10.000 series elegidas a ciegas de hoy.

Al abrir un archivo grillado, la app **no** genera miles de series. Muestra un
**panel de dataset** y una **vista de mapa**:

```
┌──────────── barra: archivo · variable ▾ · nivel ▾ · tiempo ◀ ▶ ▶︎play · paleta ▾ ─────────────┐
│ Panel dataset        │                                                             │ Inspector   │
│  ▸ t2m  2 m temp (K) │                    MAPA 2D                                  │  valor bajo │
│  ▸ d2m               │        (costas, grilla lat/lon, barra de color)             │  el cursor  │
│  ▸ u10, v10 → |V|    │                                                             │  lat, lon,  │
│ Dimensiones          │      herramientas: ● punto  ╱ línea  ▭ caja  ⬠ polígono      │  tiempo,    │
│  valid_time 744      │                    ◯ círculo  🌐 región predefinida          │  nivel      │
│  latitude 721        │                                                             │             │
│  longitude 1440      ├──────── slider de tiempo con mini-serie de la media global ──┤             │
│ Atributos            │ 2024-01-01 00:00 ━━━━━━━━━━━●━━━━━━━━━━━━━ 2024-01-31 23:00  │             │
└──────────────────────┴─────────────────────────────────────────────────────────────┴─────────────┘
         ↓ cada herramienta crea "resultados": series, perfiles y mapas derivados
         → que se pueden enviar al explorador de series (FFT, integral, heatmap, …)
```

**Panel dataset:**

- Variables con `long_name`, unidades, forma, tamaño en disco y en memoria.
- Dimensiones y atributos.
- Las "variables derivadas" que define el usuario (§4.5.9).

**Mapa:**

- **Barra de color** con modos de rango:
  - automático por instante;
  - fijo para todo el período (calculado de forma incremental);
  - manual.
- **Paletas** perceptuales (viridis, cividis) y divergentes centradas en 0 (RdBu)
  para anomalías.

**Inspector:**

- Valor exacto bajo el cursor: celda, índice y coordenadas.
- Copiar valor.

**Slider de tiempo:**

- Fecha legible según el calendario.
- Paso ±1 y saltos de día, mes y año.
- Play con velocidad ajustable.
- Mini-serie de fondo (media del dominio) para orientarse.

**Selector de nivel:**

- Slider vertical con valor y unidad (p. ej. 850 hPa).
- Opción "mosaico de niveles": un mapa por nivel, todos sincronizados.

**Teléfono:** solo lectura (mapa + slider + punto). Mismos patrones de hojas que
`phone-web-specification.md`. No es prioridad.

### 4.5 Vistas y operaciones

Cada operación declara qué lee, cuánto cuesta (estimado antes de lanzarla) y su
resultado. Las que recorren todo el tiempo **corren en streaming**, bloque a
bloque, con barra de progreso y botón de cancelar.

#### 4.5.1 Mapa 2D (V-MAP)

- **Raster por celda** (sin interpolar por defecto; interpolación bilineal
  opcional).
- **Costas, fronteras y graticula** de Natural Earth (dominio público), empaquetadas
  **offline**: 110m siempre y 50m al hacer zoom.
- **Proyecciones:**
  - Fase 1: Equirectangular (Plate Carrée).
  - Fase 3: Robinson, Mollweide, ortográfica (globo), estereográfica polar y
    Lambert cónica (WRF).
- **Superposiciones:**
  - Contornos (isolíneas) de la misma variable o de otra (p. ej. geopotencial sobre
    temperatura).
  - Flechas o líneas de corriente para pares u/v (fase 3).
- **Rendimiento:** los mapas grandes (0,1° de ERA5-Land, 6,5 M de celdas) se
  reducen a la resolución de pantalla en el Worker, con una pirámide de
  promedios. Al hacer zoom se lee la resolución completa del recorte visible.
- **Exportar:** PNG, SVG y "datos del mapa visible" como CSV o netCDF.

#### 4.5.2 Tiempo: slider y animación (V-TIME)

- Navegación con cache LRU de instantes decodificados y precarga del siguiente.
- **Animación:** exporta WebM/GIF (render en `OffscreenCanvas`).
- **Agregación temporal al vuelo:** mostrar el mapa de la media, mín., máx.,
  desvío o suma sobre un **intervalo elegido en el slider**, arrastrando un rango.

#### 4.5.3 Niveles verticales (V-LEV)

- Selector de nivel, mosaico de niveles y **perfil vertical en un punto** (eje en
  presión con escala logarítmica opcional, o en altura).
- **Corte vertical a lo largo de una línea dibujada** (distancia × nivel) en el
  instante actual. Casos particulares: corte zonal (lon × p) y meridional (lat × p).
- **Media zonal** (lat × p) del instante o del intervalo.
- Fase 4: render volumétrico 3D (con los tipos `isosurface`/`volume` de Plotly,
  que la app todavía no usa) para dominios chicos.

#### 4.5.4 Serie en un punto (V-PT)

- Clic en el mapa → serie temporal de esa celda en el nivel actual. Se pueden
  "fijar" varios puntos y compararlos.
- Opción "promedio de 3×3 celdas" o "radio de N km".
- El resultado entra al explorador como variable normal: nombre, unidades,
  coordenadas en la descripción.

#### 4.5.5 Estadísticas en zonas (V-REG)

**Definir la región:**

- caja, polígono o círculo dibujados;
- regiones predefinidas:
  - países y continentes de Natural Earth;
  - regiones de referencia del IPCC AR6 (fase 2);
  - hemisferios, trópicos y bandas de latitud;
- importar GeoJSON;
- máscara tierra/mar, opcional, a partir de Natural Earth o del `lsm` del propio
  archivo si viene.

**Estadísticas** (por instante → **serie temporal**, o sobre un intervalo →
número):

- Media **ponderada por área**, con pesos según lo que traiga el archivo:
  - límites de celda (`lat_bnds`) → área exacta de cada celda en la esfera;
  - si no, `cos φ`;
  - en grillas curvilíneas, el área de cada celda calculada a partir de sus
    vértices.
- **Mín. y máx., con su ubicación y su fecha** ("el máximo de 312,4 K fue en
  (38,25 N; 5,5 W) el 2024-07-12 15:00").
- Desvío estándar, percentiles (p10, p50, p90), suma e integral espacial (p. ej.
  precipitación total en volumen).
- Fracción de área sobre o bajo un umbral.
- Cantidad de celdas y fracción de faltantes.
- **La fórmula usada se declara junto al resultado.**

**Visualización y regiones múltiples:**

- La región y su contorno se ven en el mapa.
- Varias regiones a la vez → varias series comparables.

#### 4.5.6 Medias zonales y meridionales (V-ZON)

- Media zonal → perfil por latitud. Media meridional en una banda → perfil por
  longitud.

#### 4.5.7 Transectos y Hovmöller (V-TRAN, V-HOV)

- **Transecto:** se dibuja una polilínea; se muestrean puntos sobre la **línea
  geodésica** (círculo máximo). El paso por defecto es la resolución de la grilla.
  Interpolación al vecino más cercano o bilineal.
  - Valor × distancia en el instante actual (perfil espacial).
  - Distancia × tiempo (Hovmöller a lo largo de la línea).
  - Distancia × nivel (corte vertical, ver V-LEV).
- **Hovmöller clásico:**
  - longitud × tiempo, promediando en una banda de latitud elegida;
  - latitud × tiempo, promediando en una banda de longitud.
- Estos resultados son **series espaciales** (función de la distancia o de la
  coordenada) y entran al explorador como señales con eje X espacial (el
  explorador ya soporta X numérico no temporal).

#### 4.5.8 Tiempo: climatología, anomalías y re-muestreo (V-CLIM)

- **Remuestreo:** horario → diario, mensual, estacional (DJF/MAM/JJA/SON) o anual.
  Media, mín., máx. o suma según la variable. Los acumulados se suman, no se
  promedian.
- **Climatología** sobre un período base elegido: ciclo anual mensual, día del
  año suavizado y **ciclo diurno medio** (ERA5 horario).
- **Anomalías** respecto de esa climatología, como mapa o como serie.
- **Mapas de estadísticos temporales** por celda: media, desvío, mín., máx.,
  **tendencia lineal** (pendiente por década, con significancia opcional) y
  percentiles.
- **Diferencias:** dos instantes, dos intervalos, dos archivos o dos variables con
  la misma grilla.

#### 4.5.9 Variables derivadas y unidades (V-DER)

- **Recetas de un clic** cuando se detectan las variables:
  - |V| a partir de u/v, a 10 m o a 100 m;
  - dirección del viento;
  - temperatura en °C;
  - humedad relativa a partir de T y Td;
  - precipitación en mm (desde `tp` en m);
  - flujos acumulados → W m⁻² (dividir J m⁻² por 3600 s en datos horarios);
  - densidad de potencia eólica ½ρV³ y otros indicadores de energía, en línea con
    el uso PyPSA del grupo.
- **Expresiones libres** reutilizando el motor de variables derivadas existente,
  aplicado celda a celda y de forma perezosa (se evalúa bloque a bloque).

#### 4.5.10 Espectral: FFT en tiempo y en espacio (V-SPEC)

**En tiempo:**

- **FFT de la serie de un punto o de una región:** reutiliza la vista FFT existente
  (ventanas, escalas, cursores). La serie solo se envía al explorador.
- **Mapa de amplitud y fase en un período elegido** (p. ej. 24 h, 12 h o 365 d).
  Se calcula por celda con un único coeficiente de Fourier (o un ajuste armónico
  por mínimos cuadrados, que tolera huecos):
  - en streaming, sin guardar el cubo;
  - muestra dónde es fuerte el ciclo diurno y a qué hora local llega al máximo.
- **Mapa de potencia en una banda de períodos** (p. ej. 2–7 días, sinóptica).

**En espacio:**

- **Espectro de número de onda zonal:** FFT a lo largo de cada círculo de latitud
  (periódico en una grilla global), promediado en una banda de latitudes y en el
  tiempo. Es un clásico para docencia (ondas planetarias vs. sinópticas).
- **Espectro 2D de un recorte regional:** con eliminación de tendencia y ventana
  (Tukey/Hann) para tratar la no periodicidad. Se muestra como espectro 2D y como
  espectro radial (isótropo) en función de la longitud de onda en km.
- **Espectro a lo largo de un transecto** (número de onda en ciclos por km).

**Espacio-tiempo:**

- **Diagrama número de onda–frecuencia** (tipo Wheeler–Kiladis) en una banda de
  latitud: FFT 2D lon × tiempo, con opción de separar componentes simétrica y
  antisimétrica en fase 4.

**Todos los espectros:**

- Ejes en período o longitud de onda además de en frecuencia o número de onda.
- Escalas log/lineal.
- Exportan CSV.

#### 4.5.11 Comparación (V-CMP)

- Dos mapas lado a lado, con cursor, zoom y tiempo sincronizados.
- Diferencia A−B, si las grillas coinciden. Si no coinciden, un regrid espacial
  simple, al vecino o bilineal. Es código nuevo: el kernel `regrid.js` existente
  re-muestrea series en el tiempo, no grillas.

### 4.6 Integración con el explorador de series

- Todo resultado 1-D (series de punto, de región o de banda; transectos; perfiles;
  espectros) se puede **"Enviar al explorador"**:
  - aparece en el árbol de variables bajo el archivo, en un nodo `Extracciones`;
  - lleva nombre, unidades y una descripción con la receta;
  - queda disponible para todas las vistas existentes: FFT, integral, heatmap
    calendario, histograma, correlación, cursores y exportación.
- Al revés: elegir un instante en una serie extraída mueve el slider del mapa a esa
  fecha (sincronización de tiempo).
- Los archivos netCDF que **no** tienen grilla geográfica (series de estaciones,
  PyPSA) siguen el camino actual. Si el archivo tiene grilla, el modo grillado es
  el predeterminado. Una opción permite forzar "abrir como series" para un recorte
  chico: es el comportamiento actual, acotado.

### 4.7 Exportación y reproducibilidad

- **Exportar:**
  - Imágenes PNG/SVG de cualquier vista.
  - CSV de series, perfiles y espectros.
  - **netCDF del recorte** (variable × región × período × niveles), escrito con
    h5wasm: un "subsetter" sin código.
- **Receta** JSON (sin datos):
  - qué archivo, con su huella (nombre, tamaño, hash de cabecera);
  - qué variable, región, período y operaciones.
  - Reabrir la receta con el mismo archivo reproduce el análisis.
- **"Ver código"** en cada resultado: fragmento xarray (y CDO cuando aplique)
  equivalente. Por ejemplo:

  ```python
  ds = xr.open_dataset("era5.nc")
  w = np.cos(np.deg2rad(ds.latitude))
  reg = ds.t2m.sel(latitude=slice(51, 42), longitude=slice(355, 368))
  serie = reg.weighted(w).mean(("latitude", "longitude"))
  ```

  Para docencia es el puente explícito entre la exploración sin código y el trabajo
  reproducible.

---

## 5. Requisitos no funcionales

### 5.1 Objetivos de rendimiento

Referencia: laptop de gama media y navegador Chromium actual. Los números de
lectura parten de las mediciones de §1.2.

| Operación | Objetivo |
|---|---|
| Abrir y mostrar metadatos, **cualquier tamaño** | < 1 s |
| Primer mapa, global 0,25° | < 1 s (lectura ≈ 50 ms + render) |
| Cambiar de instante (en cache / no en cache) | < 50 ms / < 300 ms |
| Serie de un punto, 744 pasos horarios, bloques `(1, lat, lon)` | < 5 s, con progreso. Es la peor disposición; se mitiga leyendo en tandas y cacheando |
| Media de región, 744 pasos, global 0,25° | < 60 s en streaming, con progreso y cancelación |
| Mapa de amplitud del ciclo diurno, 1 mes horario global | < 90 s en streaming |
| Pico de memoria | Independiente del tamaño del archivo; proporcional a resultados + cache (tope configurable, p. ej. 512 MB web y 2 GB Electron) |

**Lectura según la disposición de los bloques:** el motor elige el orden de
lectura según los *chunks* del archivo.

- Una operación que necesita "todas las fechas en una región" recorre los bloques
  de tiempo en orden y extrae la región de cada uno.
- **Nunca** pide punto por punto (el error R3).
- Los archivos del nuevo CDS traen bloques chicos en todas las dimensiones (los
  usuarios reportan lecturas 5–15× más lentas). El planificador agrupa varios
  bloques por lectura.

### 5.2 Robustez y mensajes

- Todo error de formato dice:
  - qué se detectó (ZIP, GRIB, HTML, netCDF4 con filtro no soportado…);
  - qué hacer (abrir el contenido del ZIP, pedir netCDF en el CDS, convertir con
    una herramienta concreta).
- **Filtros HDF5:** zlib, shuffle y fletcher32 incluidos. szip, zstd, blosc, lz4 y
  bitshuffle se cargan bajo demanda vía `h5wasm-plugins` (cada vez más productos
  usan compresores distintos de zlib).
- Si un filtro no está disponible, la variable se lista igual con su motivo; no
  falla el archivo entero.

### 5.3 Accesibilidad e idiomas

- **Idiomas:** las 4 de la app (es/en/fr/it).
- **Paletas** aptas para daltonismo por defecto.
- **Teclado:** el slider de tiempo y las herramientas funcionan con teclado
  (←/→ instante, ↑/↓ nivel, espacio = play).

---

## 6. Arquitectura propuesta

### 6.1 Módulos

```
src/gridded/
  io/
    sniff.js            detección por magia (HDF5, CDF1/2/5, ZIP, GRIB, basura)
    h5-lazy.js          h5wasm en Worker + WORKERFS (web) / lectura por rangos (Electron)
    nc3-lazy.js         lector netCDF3/CDF-5 perezoso (File.slice / Range), sin netcdfjs
    zip.js              listado/extracción con fflate (ya es dependencia)
    grib.js             (fase 3) ecCodes-WASM, carga diferida
    multi.js            concatenación de varios archivos por tiempo
  cf/
    axes.js             roles T/Z/Y/X, tipos de grilla, grid_mapping
    time.js             calendarios CF (cftime-like), int64, time+step
    decode.js           packing, fill, valid_range, _Unsigned
    units.js            conversiones frecuentes
  engine/
    planner.js          plan de lectura según chunks; estimación de costo
    cache.js            LRU de bloques/instantes decodificados (tope de memoria)
    reduce.js           reducciones en streaming (media ponderada, min/max+argmin, percentiles aprox.)
    spectral.js         FFT 1D/2D, armónicos por mínimos cuadrados, número de onda zonal
    regions.js          rasterizado de polígonos a máscara ponderada sobre la grilla
    geo.js              áreas de celda, geodésicas, distancias
  views/
    map-canvas.js       raster WebGL2/Canvas + proyecciones + costas
    hovmoller.js, transect.js, profile.js, spectra.js
  bridge/
    to-explorer.js      convierte resultados en variables del explorador
    recipe.js           receta JSON + generador de código xarray/CDO
public/geo/             Natural Earth 110m/50m (TopoJSON), regiones AR6
```

El camino de series actual (`netcdf-parser.js`) se conserva para archivos sin
grilla. El paso de clasificación ("¿es una grilla geográfica?") decide qué camino
tomar.

### 6.2 Decisiones técnicas recomendadas

**E/S HDF5.** Mantener **h5wasm** (ya es dependencia).

- En el Worker de parseo, montar el `File` con **WORKERFS** en lugar de
  `FS.writeFile`. Así h5wasm lee solo los bytes que necesita, vía `File.slice`, y
  desaparecen el límite de tamaño y la copia en memoria. myHDF5/H5Web usan este
  patrón con archivos de varios GB.
- En Workers con Firefox, usar el build IIFE de h5wasm (ESM en Workers ha tenido
  limitaciones).

**netCDF3.** Reemplazar `netcdfjs` por un **lector propio perezoso**. El formato
es simple: cabecera y offsets fijos, más el registro "unlimited" intercalado. Se
lee con `File.slice` / `Range` y suma **CDF-5** casi gratis.

**ZIP.** `fflate` en streaming: descomprimir una entrada a un `Blob` y abrirlo
como archivo. Los netCDF dentro del ZIP del CDS suelen pesar menos que el límite
de memoria del navegador. Para entradas enormes, avisar.

**GRIB (fase 3).** Evaluar `@meri-imperiumi/eccodes-wasm` (ecCodes 2.4x a WASM,
Apache-2.0) frente a `grib-rs` compilado a WASM.

- Hay que verificar el soporte de empaquetados (simple, complex, JPEG2000, CCSDS)
  que usa ERA5.
- Se carga solo al abrir un GRIB, para no engordar el bundle.

**Render del mapa:**

- **Fase 1 (MVP):** reutilizar **Plotly** (ya integrado, con exportación,
  cursores y temas): `heatmap` lon × lat con la costa de Natural Earth como traza
  de líneas. Es Equirectangular, que alcanza para el 80% de los usos. Hay que
  reducir la imagen a la resolución de pantalla antes de pasarla a Plotly.
- **Fase 3:** un canvas **WebGL2** propio con proyección inversa por píxel en
  shader (el dato como textura float). Da proyecciones arbitrarias, zoom fluido y
  grillas grandes. Las proyecciones se definen con `d3-geo` y
  `d3-geo-projection`, que son livianos y funcionan offline.
- **No usar MapLibre ni Leaflet con teselas de fondo:** dependen de servidores de
  teselas (rompe offline y privacidad) y fuerzan Mercator.

**Cálculo.** Workers dedicados (pool) con `Float32Array`/`Float64Array`
transferibles. Las reducciones largas reportan progreso y aceptan cancelación.
Los kernels FFT existentes (`fft-worker.js`) se extienden a 2D.

**Costas y regiones.**

- Natural Earth 110m + 50m en TopoJSON: algunos cientos de kB comprimidos,
  empaquetados en `public/` para que el build portable siga siendo offline.
- Regiones AR6 (CC-BY) con atribución en `THIRD_PARTY_LICENSES.md`.

### 6.3 Web vs. Electron

| Aspecto | Web | Electron |
|---|---|---|
| Abrir archivo | `<input>` / arrastrar → `File` → WORKERFS | Igual, más abrir por ruta: el servidor local `electron/local-file-http.cjs` **ya soporta `Range`**, así que se lee por rangos con XHR síncrono en el Worker (patrón `createLazyFile`) |
| Tamaño máximo de entrada | Sin límite práctico (lectura perezosa) | Ídem |
| Varios archivos / carpeta | Selección múltiple; carpeta con File System Access (Chromium) | Diálogo de carpeta nativo |
| Memoria para resultados | Tope menor (p. ej. 512 MB) | Tope mayor (p. ej. 2 GB), configurable |
| Extras posibles | — | Fase 4, opcional: helper nativo (netCDF-C/ecCodes) para GRIB grandes o filtros raros, siempre con el camino WASM como predeterminado |
| Privacidad | El archivo no sale del navegador | El archivo no sale de la máquina |

---

## 7. Flujos de ejemplo (criterios de aceptación)

1. **ERA5 de un mes, Europa, t2m horario (nuevo CDS, ~300 MB):**
   - arrastrar → mapa del primer instante en < 1 s;
   - mover el slider;
   - dibujar un polígono sobre Francia → serie de la media ponderada → "Enviar al
     explorador" → FFT con el pico de 24 h visible;
   - volver al mapa → mapa de amplitud y fase del ciclo diurno.
2. **ZIP del CDS con `t2m` (instant) y `tp` (accum):**
   - aviso "ZIP con 2 archivos netCDF del CDS" → abrir ambos como un dataset;
   - `tp` se ofrece en mm/h.
3. **Niveles de presión (u, v, t en 1000–250 hPa):**
   - mapa a 850 hPa;
   - línea dibujada sobre los Andes → corte vertical distancia × presión de t;
   - perfil vertical en un punto.
4. **Doce archivos mensuales:**
   - seleccionarlos juntos → concatenación → climatología mensual 1991–2020 (si
     el período lo permite) → mapa de anomalías de un mes.
5. **Un solo instante:** abre como mapa. Nunca toma la latitud como eje X.
6. **CMIP con `noleap`:** fechas correctas en el slider; anomalías respecto de un
   período base.
7. **WRF (curvilíneo, `XLAT`/`XLONG`, Lambert):** mapa sobre costas con la
   geometría correcta; serie en un punto.
8. **Archivo de estación (serie en netCDF) y PyPSA:** abren **exactamente como
   hoy**.
9. **GRIB (fase 3):** mismo flujo 1. Antes de la fase 3, un mensaje claro y
   accionable.

**Corpus de prueba a armar:**

- Los fixtures actuales.
- El corpus de 14 archivos de `netcdf-gridded-subsampling.md`.
- Un generador de archivos sintéticos tipo ERA5, nuevo y legacy (como el usado
  para §1.2): global y regional, de un instante, con niveles, ZIP instant + accum,
  `noleap` y curvilíneo.
- Al menos un ERA5 real chico por cada producto. Licencia CC-BY de Copernicus:
  pueden versionarse recortes pequeños con atribución.

---

## 8. Hoja de ruta por fases

### Fase 0: rescate (corto, alto impacto)

Hace que "no anda nada" pase a "anda" **sin** cambiar el paradigma todavía.

1. Detección de ZIP → abrir la entrada elegida (`fflate`). Detección de GRIB,
   HTML, PNG… → mensajes accionables (R5, R6, R13).
2. Leer cada variable **una vez, por bloques** (`object.value` o hyperslabs
   alineados a los chunks), y extraer las series desde ese `Float32Array` en
   memoria. Basta con eliminar la lectura punto a punto (R3): 75 s → < 1 s en el
   caso medido.
3. Comprobar si una variable es numérica con `dtype`, sin leerla (R4).
4. Eje de longitud 1: un archivo de un instante no toma lat/lon como X. Decodificar
   el tiempo también en las etiquetas de selectores (R7).
5. WORKERFS en lugar de `FS.writeFile` para netCDF4 (R2). Con eso, los archivos
   grandes al menos abren sus metadatos y una submuestra.

### Fase 1: visor de mapas MVP

- Clasificación "grilla geográfica"; modelo de dataset (§4.3) con calendarios.
- Panel dataset, mapa Equirectangular (Plotly + costas Natural Earth), slider de
  tiempo con play, selector de nivel, inspector.
- Serie en un punto y **media, mín. y máx. ponderadas en una caja** → "Enviar al
  explorador".
- Concatenación de varios archivos. Exportar PNG y CSV.

### Fase 2: análisis

- Polígono, círculo, regiones predefinidas, GeoJSON, máscara tierra/mar.
- Transectos, Hovmöller, cortes verticales, medias zonales.
- Remuestreo, climatología y anomalías; mapas de estadísticos y tendencia.
- Espectral temporal: FFT de región/punto (vista existente) y mapas de
  amplitud/fase de un período.
- Variables derivadas de un clic. "Ver código" xarray.

### Fase 3: espacio, formatos y proyecciones

- Espectro de número de onda zonal, espectro 2D y radial, espectro de transecto.
- Canvas WebGL con proyecciones; grillas curvilíneas (WRF); vectores de viento.
- GRIB vía WASM; filtros HDF5 extra; lector netCDF3/CDF-5 perezoso.

### Fase 4: extras

- Diagrama número de onda–frecuencia; ensambles (`number`).
- Exportar recorte a netCDF; recetas; animación a WebM/GIF.
- Zarr local y remoto; URL remotas; volumen 3D; vista de teléfono.

---

## 9. Preguntas abiertas

1. **Prioridad de GRIB:** ¿los colegas descargan netCDF o GRIB? Si es GRIB,
   conviene adelantarlo a la fase 1–2.
2. **¿Modo grillado siempre que haya lat/lon,** o preguntar al abrir? (Propuesta:
   automático, con un botón "abrir como series".)
3. **Render:** ¿alcanza con Plotly Equirectangular para la fase 1, o las
   proyecciones polares (Antártida/Ártico) son prioritarias para algún curso?
4. **Datos remotos:** ¿interesa leer ERA5 directamente de Earth Data Hub o ARCO
   (Zarr, requiere token y CORS) o se mantiene 100% local?
5. **Licencias:**
   - Natural Earth (dominio público) sin problema;
   - regiones AR6 y datos de ejemplo Copernicus requieren atribución;
   - ecCodes es Apache-2.0.
6. **Docencia:** ¿qué análisis espectrales usan hoy en clase? Eso ordena V-SPEC
   (zonal, 2D o número de onda–frecuencia primero).

---

## 10. Fuentes

**Formato ERA5 en el nuevo CDS** (algunas páginas de ECMWF se consultaron por
resumen de buscador):

- https://confluence.ecmwf.int/display/CKB/GRIB+to+netCDF+conversion+on+new+CDS+and+ADS+systems
- https://forum.ecmwf.int/t/forthcoming-update-to-the-format-of-netcdf-files-produced-by-the-conversion-of-grib-data-on-the-cds/7772
- https://forum.ecmwf.int/t/cdsapi-reanalysis-single-level-is-being-download-as-a-zip-when-asked-for-unarchived/10172
- https://forum.ecmwf.int/t/huge-performance-drop-when-reading-new-era5-netcdf4-format/12831
- https://forum.ecmwf.int/t/netcdf-variable-expver-not-cf-compliant-in-era5-new-converter/7148
- https://forum.ecmwf.int/t/netcdf-legacy-data-format/10616
- https://forum.ecmwf.int/t/limitation-change-on-netcdf-era5-requests/12477
- https://github.com/dbekaert/RAiDER/issues/689 (ejemplo real de `repr` del nuevo formato)
- https://github.com/tkschuler/ERA5-Utils (diferencias legacy ↔ nuevo)
- https://github.com/PyPSA/atlite/issues/413 (ZIP guardado como `.nc`)
- https://github.com/google-research/arco-era5 ; https://earthdatahub.destine.eu/collections/era5

**Herramientas comparadas:**

- Panoply: https://www.giss.nasa.gov/tools/panoply/
- IDV: https://docs.unidata.ucar.edu/idv/workshop/datadisplays/grid/CrossSections.html
- QGIS / Crayfish: https://www.lutraconsulting.co.uk/products/crayfish
- ArcGIS Pro: https://pro.arcgis.com/en/pro-app/3.4/tool-reference/image-analyst/zonal-statistics-as-table.htm
- Giovanni: https://giovanni.gsfc.nasa.gov/
- KNMI Climate Explorer: https://climexp.knmi.nl/start.cgi
- NOAA PSL WRIT: https://psl.noaa.gov/data/writ/
- Copernicus Interactive Climate Atlas: https://atlas.climate.copernicus.eu/
- ERA Explorer: https://climate.copernicus.eu/era-explorer-app-global-climate-data-made-accessible-all
- Climate Reanalyzer: https://climatereanalyzer.org/
- xcube viewer: https://xcube.readthedocs.io/en/latest/viewer.html
- Lexcube: https://github.com/msoechting/lexcube
- Climate Engine: https://www.climateengine.org/
- myHDF5: https://forum.hdfgroup.org/t/myhdf5-now-supports-opening-local-files-of-any-size/12236
- Browzarr: https://github.com/EarthyScience/Browzarr
- GribBox: https://gribbox.com/netcdf/viewer
- CDO, ponderación de `fldmean`: https://code.mpimet.mpg.de/boards/2/topics/9482

**Tecnología:**

- h5wasm (WORKERFS, filtros): https://github.com/usnistgov/h5wasm ; https://www.npmjs.com/package/h5wasm-plugins
- netcdfjs: https://github.com/cheminfo/netcdfjs
- zarrita.js: https://github.com/manzt/zarrita.js
- ecCodes WASM: https://www.jsdelivr.com/package/npm/@meri-imperiumi/eccodes-wasm
- grib-rs: https://docs.rs/crate/grib/latest
- d3-geo-projection: https://github.com/d3/d3-geo-projection
- Natural Earth: https://www.naturalearthdata.com/

**Documentos internos relacionados:**

- `docs/netcdf-gridded-subsampling.md`: submuestreo actual y sus mediciones.
- `docs/large-files.md`, `docs/file-size-limits.md`: límites actuales.
- `docs/phone-web-specification.md`: patrones de UI móvil.

---

## 11. Implementado (fases 0 y 1)

**Fase 0, lector de series** (`src/parsers/netcdf-parser.js`):

- Detección por contenido (`src/parsers/netcdf-sniff.js`): ZIP, GRIB, gzip,
  HTML/JSON, PDF e imágenes dan un mensaje traducido y accionable.
- Las series se recortan de lecturas completas o por bloques a lo largo del eje
  de muestras, nunca punto a punto. Medido con los archivos sintéticos de §1.2:

  | Archivo | Antes | Ahora |
  |---|---:|---:|
  | Europa, nuevo CDS (3,6 MB) | 75 s | 0,42 s |
  | Niveles de presión (7,4 MB) | 80 s | 0,44 s |
  | Global, 24 h (110 MB) | > 25 min | 3,6 s |

- Chequeo numérico por `dtype`, sin leer los datos.
- Un eje de tiempo de un solo paso sigue siendo el eje de tiempo.
- Etiquetas de tiempo decodificadas en los selectores.
- Escalares y variables de texto (`number`, `expver`) como metadatos, no como
  "no soportadas".
- **netCDF3 con un lector propio por partes** (`src/gridded/nc3-reader.js`), que
  también lee CDF-5. `netcdfjs` conservaba el relleno entre registros como si
  fueran datos y desplazaba un valor por registro en las variables de registro
  cuyo tamaño no es múltiplo de 4 bytes. Es exactamente el caso de los ERA5 del
  CDS legacy (int16 en grillas de tamaño impar): **la app mostraba valores
  corridos**.

**Fase 1, modo dataset grillado** (`src/gridded/`,
`src/app/methods/gridded-methods.js`, `src/workers/gridded-worker.js`):

- **Lectura en un Worker**, que mantiene abiertos los archivos por partes:
  - h5wasm sobre WORKERFS para netCDF4;
  - el lector propio para netCDF3.
  - Sin Worker (build portable en `file://`), las mismas operaciones corren en
    la página, sobre el archivo en memoria.
- **Modelo del dataset:**
  - roles de ejes (T/Z/Y/X) por `axis`, `standard_name`, unidades y nombre;
  - latitud descendente presentada ascendente;
  - longitud 0..360 rotada a −180..180 cuando la grilla lo permite;
  - calendarios CF (`noleap`, `all_leap`, `360_day`, `julian`).
- **Vista de mapa** sobre el área de gráficos:
  - Plotly `heatmap` con costas y fronteras Natural Earth 1:110m y 1:50m,
    empaquetadas offline en `public/geo/`;
  - variable, nivel y otras dimensiones;
  - paletas, y escala automática, fija o manual;
  - slider con reproducción y teclado (← → espacio);
  - decimación de dibujo por encima de 400.000 celdas (el zoom lee la
    resolución completa).
- **En el celular** (el layout compacto de la app): el mapa ocupa todo el
  ancho, sin títulos de ejes, con la barra de colores debajo cuando el mapa
  mide menos de 600 px de ancho (de costado vuelve al lado: falta alto, no
  ancho), y es tan alto como lo pide la grilla (un mapa del mundo, la mitad
  del ancho), entre 240 px y el 62 % de la pantalla. Debajo, en un mismo
  desplazamiento: barra de tiempo (botones arriba, el deslizador a todo el
  ancho), herramientas, extracciones y al final el inspector. La barra de
  arriba queda en dos filas (variable, exportar y cerrar; nivel y rango de
  colores) y los menús no se salen de la pantalla. Con un punto o un recuadro
  puesto, "Extraer" / "Calcular" flota sobre el mapa; mantener apretado un
  punto o un recuadro abre su menú (no hay botón derecho ni Supr), y
  seleccionar no desplaza la página (el mapa quedaría fuera de la vista). La
  ayuda de cada herramienta habla de dedos.
- **Panel de análisis** a la derecha del mapa, que se lee como el flujo de
  trabajo (rediseñado tras la primera prueba con datos reales):
  1. **Extraer una serie temporal.** Tres modos:
     - **Navegar:** arrastrar mueve el mapa (cursor de mano, que se cierra
       al apretar). En un trackpad, dos dedos hacia arriba o abajo hacen zoom
       y en cualquier otra dirección (de costado o en diagonal) mueven el
       mapa; un gesto que empieza de costado sigue moviendo hasta soltar los
       dedos, como en los gráficos de series.
     - **Punto:** un clic coloca un anillo naranja y llena latitud y
       longitud, que también se pueden escribir; el anillo se arrastra. El
       lugar sale del píxel del clic, no del hover de Plotly (que llega tarde
       en un clic rápido y falta sobre celdas sin dato). Nada se lee hasta
       pulsar "Extraer serie temporal" (o Enter). Se toma la celda más
       cercana.
     - **Región:** se dibuja un rectángulo o se escriben sus límites
       Norte/Oeste/Este/Sur, como en el formulario del CDS (Oeste > Este cruza el
       meridiano 180°). El recuadro naranja se puede arrastrar y redimensionar,
       y los campos lo siguen. "Calcular" da la media ponderada por área (cos φ,
       o área de celda si hay `lat_bnds`), el mínimo y el máximo en cada
       instante; las celdas faltantes se excluyen y se cuentan.

     En los modos Punto y Región el cursor es una cruz. Un recuadro de alcance
     dice qué se usa: la variable, el nivel elegido en la barra y todos los
     instantes.
  2. **Series extraídas:** una fila por punto (P1, P2…) o región (R1…), con el
     mismo color de su marcador o recuadro en el mapa y de sus curvas en la
     vista previa. Cada fila tiene una casilla para la vista previa y la
     exportación, y ✕ para quitarla junto con sus variables. "Abrir las series
     marcadas en los gráficos" cierra el mapa y las grafica en el explorador.
  3. **Selección y borrado en el mapa** (tras la segunda prueba):
     - un clic sobre un punto, el borde de un recuadro o su etiqueta lo
       selecciona (magenta, color que no está en ninguna paleta) y marca su
       fila; un clic en la fila lo marca en el mapa. Un clic dentro de un
       recuadro no lo selecciona, para poder poner un punto ahí;
     - el botón derecho abre un menú: "Extraer"/"Quitar" para lo naranja,
       "Quitar R1 y sus series" para lo extraído; Supr quita lo seleccionado
       y Escape lo suelta;
     - "Quitar punto"/"Quitar recuadro" quitan solo lo naranja; el ícono de
       papelera de la lista quita todas las extracciones, previa confirmación.

     Plotly "activa" una forma editable al tocarla y trata el rectángulo
     siguiente como un nuevo contorno de esa forma; la app nunca deja una
     forma activa. El anillo no es una forma de tamaño en píxeles: con una de
     esas en el mapa, Plotly convierte mal el rectángulo siguiente.
  4. **Tercera prueba:**
     - el mapa abre en **Navegar**: un clic no coloca nada hasta elegir
       herramienta;
     - el recuadro naranja ya no es "editable" para Plotly (cuya franja de
       redimensionado es un tercio del recuadro por lado): se mueve desde
       adentro y se redimensiona desde una franja de 6 px por borde (16 px
       con el dedo);
     - el **botón derecho arrastra** el mapa y la vista previa, como en los
       gráficos del explorador; un clic derecho sin arrastre abre el menú.
       En Linux y macOS el evento del menú llega al apretar, así que se
       espera a soltar; en Windows llega después, y un arrastre recién
       terminado lo descarta;
     - **pantallas táctiles:** un dedo mueve y dos hacen zoom (los gestos de
       todos los gráficos); un toque coloca el punto; el anillo y el recuadro
       se arrastran con el dedo; en Región se dibuja con el dedo;
     - "Abrir las series marcadas en los gráficos" **reutiliza el mismo
       panel** en los viajes siguientes: entran las nuevas y salen las
       desmarcadas o quitadas, sin tocar otras curvas;
     - "Volver al mapa" aparece solo después de enviar series a los
       gráficos, no tras "Cerrar mapa"; el botón "Mapa" de la fila del
       archivo es verde sobre la fila azul;
     - las series se nombran con el nombre largo y el corto:
       "2 metre temperature (t2m) · 45°N 90°E";
     - **unidades:** los exponentes se muestran como superíndices
       ("m s**-1" y "m s-1" → m s⁻¹). Un número sin `**` solo es exponente
       tras un símbolo de unidad conocido, así que "CO2 ppm" o "PM10" no se
       tocan. La grafía del archivo queda en `unitsRaw`;
     - "Escala" pasa a "Rango de colores"; el rango, la paleta y cada opción
       de Autoajustar tienen un tooltip que dice qué hacen y cuándo usarlas.
  5. **Cuarta prueba: lugares y niveles.**
     - **Un lugar es una carpeta.** P1 o R1 es un punto o un recuadro; lo que
       se extrae ahí (otra variable, otros niveles) se suma a ese lugar: la
       misma celda de grilla o el mismo recuadro van a la misma carpeta, en el
       panel y en el árbol (Extracciones › P1 · 45°N 90°E › Temperature (t) ·
       850 hPa). Una serie ya extraída no se lee dos veces.
     - "+" en la fila del lugar (o "Extraer otra variable u otro nivel acá"
       en su menú) lo vuelve a poner en el mapa como punto o recuadro
       naranja.
     - **Niveles:** en Punto y Región, el selector de niveles toma el del mapa
       por defecto, o varios, o todos. Se leen en una sola pasada (el rango
       contiguo del eje de niveles): los bloques comprimidos de un reanálisis
       suelen contener todos los niveles, así que leer nivel por nivel
       descomprimiría los mismos bloques una y otra vez. Una serie por nivel,
       cada una con su color.
     - Cada serie de un lugar tiene su casilla y su ✕; el ✕ del lugar quita
       todas.
     - Extraer, o quitar el punto o el recuadro naranja, vuelve a Navegar.
     - Sin cursor de texto en ningún lugar de la app salvo en los campos de
       texto (con la navegación por cursor del navegador, F7, aparecía en
       botones y menús).
     - "Ocultar / Mostrar" en "2 · Series extraídas" pliega la lista y la
       vista previa bajo el mapa, que toma todo el alto; el encabezado cuenta
       las series. Se recuerda para el próximo mapa (localStorage).
     - Todo lo de la escala bajo un solo botón **"Color range"** en la
       barra: los extremos escritos a mano, la paleta y los ajustes. El
       ajuste en uso (o los extremos escritos) se marca en azul al abrirlo.
- **Barra superior en una sola fila:** variable, nivel y escala a la izquierda;
  exportar y "Cerrar mapa" a la derecha. La barra de colores tiene el título
  arriba, un formato de etiquetas acotado y un margen fijo: cambiar de instante
  ya no cambia el ancho del mapa.
- **Escala de colores fija en el tiempo.** Al reproducir, un color significa el
  mismo valor en todos los instantes:
  - Al abrir, o al cambiar de variable o de nivel, la escala se ajusta a **todo
    el período** con una muestra de instantes. Si los bloques comprimidos del
    archivo agrupan varios instantes, se toman bloques enteros repartidos en el
    período, que cuestan lo mismo y ven más datos. Medido: 0,7 s en un día
    global a 0,25° y 0,5 s en un año 6-horario regional.
  - El mínimo y el máximo son editables a mano.
  - El menú **"Autoajustar"** reajusta a todo el período, exacto (lee todos los
    instantes, con progreso y cancelación), al instante en pantalla o a la zona
    visible. Tiene tres opciones:
    - ignorar extremos (percentiles 1–99);
    - centrar en cero;
    - "reajustar en cada instante" (el comportamiento anterior, desmarcado por
      defecto).
  - El menú también contiene la paleta y dice de dónde sale la escala actual.
- **Divisor arrastrable** entre el mapa y la vista previa de las series (mouse
  o flechas; doble clic vuelve al valor por defecto).
- **Volver al mapa:** con un archivo grillado activo y el mapa cerrado, aparece
  sobre los gráficos un botón verde "Volver al mapa · archivo". En la fila del
  archivo, el globo pasó a ser un botón con texto, "Mapa".
- **Encuadre:** grados iguales en ambos ejes. Una franja larga (una banda de
  latitudes) se muestra con la geografía de alrededor, sin pasar nunca de los
  polos.
- **Apertura** (§4.4.0): diálogo de ZIP con la opción de abrir como un solo
  dataset, y oferta de unir en el tiempo varios archivos compatibles. "Abrir
  como series" vuelve al comportamiento anterior.
- **Exportar:** el mismo diálogo que el botón de descarga de cada panel.
  - Mapa: CSV latitud × longitud a resolución completa, PNG o SVG, con calidad
    y tema.
  - Series extraídas: CSV de las marcadas, PNG o SVG de la vista previa.
- **Electron:** el netCDF abierto por ruta se pide al servidor local como Blob
  (sin la pregunta de tamaño ni la copia por IPC) y se lee por partes.
- **Inspector** (§4.4), arriba del panel: la celda bajo el puntero dicha
  exacta — dónde está, qué fila y qué columna de la grilla es, su valor con
  unidades, y el instante y el nivel que muestra el mapa. La lectura sigue al
  slider y queda fija cuando el puntero deja el mapa, así que "Copiar" la
  pone en el portapapeles como una sola línea.
- **Vista previa con unidades mezcladas.** Las curvas que no comparten unidad
  no comparten eje: la primera unidad se queda con el eje izquierdo y las
  demás pasan a un segundo eje a la derecha, cada uno titulado con las
  unidades que lleva, y la leyenda nombra la unidad de cada curva. Nunca se
  muestra una unidad equivocada (K y m s⁻¹ juntas, por ejemplo).
- **Costas dentro del recuadro.** Las costas y fronteras se dibujan como
  trazos SVG, que Plotly recorta al área de ejes (en pantalla y en una imagen
  exportada). Como trazos `scattergl` iban sobre un único lienzo de toda la
  figura y, con `constrain: 'domain'` (que achica el área de dibujo para
  mantener el grado cuadrado), quedaban unos píxeles afuera. Para que SVG
  salga barato, las líneas se recortan a una ventana alrededor de lo que se
  ve (el doble de ancha, nunca más allá de los polos): el juego 1:50m tiene
  80.000 puntos en todo el mundo. Un desplazamiento que sale de esa ventana
  vuelve a dibujar el mapa.
- **Sesiones** (`session-methods.js` + `_griddedSessionState` /
  `_griddedRestoreSession`): un proyecto guarda el mapa entero.
  - **Todos los archivos del dataset** y cómo se unieron (`entry.gridded.files`
    y `entry.gridded.options`): varios meses unidos en el tiempo
    (`mode: 'concat-time'`) o un ZIP del CDS leído como un solo dataset
    (`mode: 'merge-variables'`) van completos al ZIP del proyecto. Antes
    fallaba al guardar, porque la sesión buscaba los bytes de un único
    archivo y `entry.file` es null cuando hay varios.
  - **Cada lugar** (P1, R1…) con su tipo, su geometría, su tag, su color y su
    nota, y **cada set** con su variable y su nivel, sus roles (valor, media,
    mín., máx.), los nombres `grid:x…`, el nombre de cada hoja del árbol, si
    está marcado y **los valores**. Van en el JSON de la sesión, así que una
    sesión de vista (sin datos) también los restituye, y restaurar no vuelve
    a leer el archivo.
  - **El estado de la vista:** variable, nivel e instante, paleta, escala
    (rango, origen y opciones), zoom, los niveles elegidos para extraer, si
    la lista de series estaba plegada, y si el mapa estaba abierto.
  - **Los paneles** que mostraban esas series: las extracciones se reponen
    antes de rearmar los gráficos, así que las curvas vuelven a su panel.
    Una serie extraída no se busca en el archivo al restaurar (como las
    variables derivadas, viene con la sesión).
- **Panel dataset:** cada variable del árbol dice también cuántos valores
  tiene (744 × 721 × 1440 son 772 millones), además de su forma, su nombre
  largo y sus unidades.

**Tests:**

- `npm run test:gridded`: motor, lector netCDF3, ZIP, calendarios, regiones,
  cliente y la ventana de costas, sobre los fixtures que genera
  `scripts/generate-gridded-netcdf-fixtures.py`.
- `npm run e2e:gridded-netcdf`: en Chromium. Mapa, punto, caja, slider,
  graficar, ZIP del CDS, archivos de series sin cambios, mensaje de GRIB, el
  camino de escritorio contra `electron/local-file-http.cjs`, que nada del
  mapa se dibuje fuera de los ejes, y los dos proyectos: uno con
  extracciones y uno con un dataset de varios archivos.
- `npm run test:session-project` (`scripts/test-session-project-save.mjs`):
  un dataset de varios archivos entra entero en el ZIP del proyecto, con el
  modo de unión y el mapa; una serie extraída no se busca en el archivo al
  restaurar.

**Valor en un punto y ayuda de cálculo:**

- Punto: "Celda más cercana" (por defecto, como el CDS y CDO `remapnn`) o
  "Interpolación bilineal" entre las cuatro celdas alrededor del punto (como
  CDO `remapbil` o `xarray.interp`). Cruza el meridiano 0/360 de una grilla
  global; fuera de la grilla toma el borde; una vecina sin dato se deja afuera
  y las demás se vuelven a pesar. Varios niveles se interpolan en la misma
  lectura (`pointSeries(..., { method: 'bilinear', levels })`).
- Un lugar bilineal es el punto mismo ("30°N 22.5°E (bilineal)") y es otro
  lugar que uno de celda más cercana en las mismas coordenadas; el método se
  guarda con el lugar y en la sesión.
- En el mapa: bajo el anillo naranja, un contorno punteado muestra de dónde
  sale el valor (los bordes de la celda más cercana, o el cuadrado que une los
  centros de las cuatro vecinas, marcados con puntos); sigue al anillo al
  arrastrarlo y cambia con el método. Un punto extraído bilineal se dibuja
  como rombo, uno de celda más cercana como círculo.
- La región no cambia: media ponderada por área (cos φ o área de celda con
  `lat_bnds`), celdas enteras si su centro cae en el recuadro (como CDO
  `sellonlatbox` y `xarray.sel`), mínimo y máximo sin ponderar. Las fracciones
  de celda quedan para las regiones con forma de la fase 2.
- Un "?" junto a "1 · Extraer una serie temporal" abre un recuadro (fondo
  difuminado) que explica todo esto.

**Archivos grandes: una lectura por bloque de tiempo.**

- Las celdas de un punto bilineal se leen juntas, como la ventana que las
  contiene, en una sola pasada por el archivo (antes, una pasada por celda:
  cuatro veces el costo).
- Los tramos de columnas que caen en los mismos bloques comprimidos del
  archivo se leen como uno: un recuadro que cruza el meridiano 0 de una grilla
  0..360 (Europa en ERA5), o un punto bilineal sobre el meridiano, ya no
  descomprime dos veces el mismo bloque. Tramos en bloques propios (bloques
  chicos, o netCDF3 sin bloques) siguen separados y leen solo lo necesario
  (`_columnReads`).
- Medido en el navegador con un mes horario global a 0,25° (744 × 721 × 1440,
  1,67 GB, un bloque por instante como el nuevo CDS):

  | Operación | Antes | Ahora |
  |---|---:|---:|
  | Abrir hasta ver el mapa | 2,6 s | 2,6 s |
  | Cambiar de instante | 0,4 s | 0,4 s |
  | Punto, celda más cercana | 15 s | 15 s |
  | Punto, bilineal | 57 s | 14 s |
  | Región Europa (cruza el meridiano 0) | 28,5 s | 16–17 s |
  | Región sin cruzar (Sudamérica) | — | 15–16 s |
  | Región global | 38 s | 39–41 s |

  Memoria del navegador: unos 200–280 MB sobre la app vacía con el archivo
  abierto; el archivo no se carga entero. Valores verificados contra numpy
  (bilineal y medias ponderadas por cos φ: diferencias < 1e-10).
- **Varios Workers.** El piso de unos 15 s era descomprimir los 744 mapas en
  un solo Worker. Ahora una serie de punto o de región sobre un dataset
  grande (≥ 64 MB y ≥ 32 instantes) se reparte a lo largo del tiempo entre el
  Worker principal y hasta tres auxiliares (según los núcleos, máximo 4 en
  total). Cada auxiliar abre los mismos archivos por partes (no se copian),
  lee su tramo de instantes cortado en bordes de bloque (ningún bloque se
  descomprime dos veces) y el cliente une los tramos en orden. Cada instante
  se calcula igual en cualquier Worker: el resultado es idéntico, bit a bit,
  al de uno solo. El progreso suma los tramos y cancelar los cancela a todos;
  si un auxiliar falla, la serie se lee entera en el Worker principal.
- Los auxiliares arrancan y abren el dataset al elegir Punto o Región (antes
  de la primera serie) y se cierran cuando no queda ningún dataset abierto.
  Cuestan unos 350 MB de memoria mientras viven.
- Mismo mes, en 4 núcleos:

  | Operación | Un Worker | Varios Workers |
  |---|---:|---:|
  | Punto, celda más cercana | 15 s | 5 s |
  | Punto, bilineal | 14 s | 5 s |
  | Región Europa | 16–17 s | 6 s |
  | Región global | 39–41 s | 12,5–13 s |
  | Cambiar de instante (mapa) | 0,4 s | 0,2–0,4 s |

- Con archivos en bloques chicos las series son más rápidas todavía; el
  build portable (`file://`, sin Workers) sigue leyendo en la página.
- **Cambio de instante.** Medido con más precisión, un paso costaba 160–200 ms
  (leer el mapa 50–180 ms, dibujarlo ~100 ms; los 0,4 s de antes eran el
  primer paso en frío). Ahora el instante siguiente, en la dirección en que se
  movió el deslizador o el reproductor, se lee mientras se dibuja el actual,
  y los mapas leídos quedan en una caché de la vista (hasta 64 MB, el más
  viejo sale primero): un paso queda en ~140 ms (mediana) y la animación a 10
  pasos/s da ~8 cuadros por segundo (antes ~6,5). El resto es el dibujo de
  Plotly (~95 ms para 361 × 720 celdas aun cambiando solo `z`; `zsmooth:
  'fast'` no lo baja).

**Archivos de series (estaciones, PyPSA) por partes.**

- El lector de series ya no recibe el archivo entero copiado (antes: leído en
  la página, con hash, copiado al Worker y otra vez al sistema de archivos de
  h5wasm, cuatro copias). El Worker de parseo recibe el `File` y lo lee por
  partes: netCDF4 montado con WORKERFS (`src/gridded/hdf5-input.js`,
  compartido con los datasets grillados), netCDF3 con el lector propio.
- El límite de netCDF de Ajustes se aplica a lo que el archivo carga (las
  series que guarda, en Float64), no a su tamaño. Se calcula antes de leer
  ninguna serie; por encima, el Worker devuelve `NETCDF_OVER_LIMIT` con los
  bytes y la app hace la pregunta de siempre, con un texto que lo dice
  ("carga X de series"). PyPSA carga sus tablas dinámicas enteras: eso es lo
  que se pesa.
- Medido con un archivo de estaciones de 573 MB (150 000 instantes × 1000
  estaciones): antes, aviso por tamaño y, aceptando, 18 s y +2,1 GB de
  memoria; ahora, sin aviso (carga 64 series, 77 MB), 4,6 s y +350 MB.
- Sin Worker (build portable en `file://`) sigue el camino anterior.

**Pendiente de esta parte:**

- No probado dentro de Electron mismo: el camino del renderer sí, contra el
  servidor de archivos de Electron.
- "Abrir como series" se retiró del panel (§4.4.0); un archivo de grilla
  ya no se abre como series.
- Fase 0, punto 5 (WORKERFS en lugar de `FS.writeFile`) está hecho en el
  camino grillado (`src/gridded/dataset.js`), no en el lector de series
  (`src/parsers/netcdf-parser.js`), que sigue recibiendo el archivo entero en
  un `ArrayBuffer` y copiándolo al FS de Emscripten. Lo que motivaba R2 —los
  ERA5 grandes— ya no pasa por ahí: un archivo de grilla se abre en el
  worker y se lee por partes. Cambiarlo obligaría a mandar el `File` al
  worker de parseo y a tocar el camino PyPSA, que este documento deja fuera.
- Del detalle de §4.4, fuera de lo que pide la fase 1 en §8:
  - el slider de tiempo no tiene saltos de día, mes y año ni la mini-serie de
    fondo con la media del dominio;
  - el selector de nivel es una lista, no un slider vertical, y no hay
    "mosaico de niveles";
  - el panel dataset no dice el tamaño en disco (comprimido) de cada
    variable;
  - el diálogo "¿mapa de estaciones o series?" para archivos ambiguos
    (§4.4.0, paso 3) no existe: un archivo de estaciones va al lector de
    series sin preguntar, y el mapa de estaciones no está en la fase 1.
- La herramienta activa (Navegar / Punto / Región) y el punto o el recuadro
  naranja a medio poner no se guardan en la sesión: un mapa restaurado abre
  en Navegar, con lo ya extraído.

