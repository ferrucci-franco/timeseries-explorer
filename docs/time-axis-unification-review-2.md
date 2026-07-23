# Revisión técnica adversarial 2 — Time-axis unification (v2)

Documento revisado: `docs/time-axis-unification-design.md` (v2)

Worktree: `worktree-feature+mixed-xaxis-plot`

## Veredicto: CON-FALLAS-SERIAS, aunque muy mejorado

La v2 resuelve correctamente gran parte de la revisión anterior, pero todavía no es implementable con seguridad. Quedan cuatro contradicciones estructurales que producirían doble conversión de fechas, configuraciones imposibles de expresar y fases intermedias con export/hover/cálculos incorrectos.

## Mejoras confirmadas

- La reformulación "una deficiencia de diseño, cuatro causas próximas" ahora coincide con el código.
- `unknown`/`coordinate` evita asumir que todo numeric es elapsed.
- La separación `renderSignature`/`operationCapabilities` es correcta: heatmap exige calendar (`heatmap-methods.js:339-365`), temporal-profile datetime (`temporal-profile-methods.js:576-590, 635-640`) y FFT monotonicidad/uniformidad (`utils/fft.js:254-299`).
- Phase 0 incluye ambos normalizadores y migración de sesión, corrigiendo el orden anterior (`data-methods.js:99-133`, `file-methods.js:2499-2533`, `session-methods.js:305-315`).
- La compatibilidad ampliada queda inicialmente limitada a timeseries/phase2dt.
- El tratamiento de tiempo negativo ya no se presenta incorrectamente como una carencia.

## Bloqueos residuales

### 1. `encoding` confunde formato de origen con representación almacenada

El modelo declara que `encoding` describe los valores que recibe `decode(encoding, v)` (`docs/time-axis-unification-design.md:56-62, 84-88`). Pero la matriz asigna:

- Excel/MATLAB → `excel-serial`/`matlab-datenum` (`:181`).
- NetCDF gregoriano → `cf-time` (`:184`).

Los parsers ya convierten esos valores antes de guardarlos:

- Excel serial y MATLAB datenum se convierten a epoch-ms en `csv-time-detection.js:1047-1058, 1362-1369`.
- NetCDF CF se materializa como `originMs + raw × scaleMs` en `netcdf-parser.js:512-523`.
- La variable CSV recibe esos `timeValues` ya convertidos (`csv-parser.js:139-154`).

Por lo tanto, el adapter de Phase 0 podría intentar decodificar como Excel/CF datos que ya son epoch-ms.

**Corrección necesaria:**

- `storageEncoding`: `epoch-ms | unix-s | raw-number | row-count`
- `sourceEncoding`: `excel-serial | matlab-datenum | cf-time | ...`
- `absoluteMs(v)` debe usar `storageEncoding`; `sourceEncoding` queda como procedencia.

Además, `originMs` mezcla dos conceptos diferentes:

- El origen necesario para decodificar CF/Unix.
- La referencia desde la cual mostrar elapsed.

Deben separarse en `decodeOrigin` y `elapsedReferenceMs`.

### 2. No existe un canal universal para convertir `unknown` en elapsed/absolute

La v2 declara simultáneamente:

- Los campos intrínsecos son inmutables y pertenecen al parser (`:56, 111-114`).
- El menú sólo modifica display (`:112`).
- Un `unknown` queda bloqueado "hasta que el usuario afirme la semántica" (`:93, 103, 203`).

Pero Phase 3 sólo añade esa afirmación al diálogo CSV (`:226-227`). No hay mecanismo equivalente para MAT genérico, Parquet, NetCDF raw o pickle.

Esto deja sin resolver parte del síntoma original: un numeric `.mat` no reconocido por heurística seguirá `unknown`/`raw` y el menú no podrá reclasificarlo.

Debe elegirse una de estas alternativas:

- Añadir `interpretationOverride` post-load al menú común.
- Ofrecer reparse/import settings equivalentes para todos los formatos.

Si existe override, la semántica ya no puede describirse simplemente como "intrínseca e inmutable".

### 3. Display, unidad y alineación son estado del panel, no sólo del archivo

La v2 pone `displayUnit` y `alignmentPolicy` dentro de cada `TimeAxisModel` de archivo (`:65-72`). Sin embargo, cuando varios archivos comparten un eje, estas decisiones deben ser únicas para el panel.

Ejemplos no resueltos:

- Una traza quiere duration y otra seconds.
- Dos trazas elapsed seleccionan distintas `displayUnit`.
- Dos archivos tienen diferentes `alignmentPolicy`.
- `shared-absolute-origin` necesita un origen común del panel, no uno independiente por archivo.

Además, `effectivePanelDisplay` se menciona, pero nunca se define el algoritmo que elige resultado, unidad y origen (`:18, 220-221`). Los tests exigen ambos órdenes de trazas (`:247`), pero no existe comportamiento normativo contra el cual probarlos.

Hace falta algo equivalente a:

```
PanelTimeAxisState = {
  effectiveDisplay,
  effectiveUnit,
  alignmentPolicy,
  referenceOriginMs
}
```

Y definir expresamente:

- Todos los elapsed se convierten internamente a segundos.
- Todos duration → panel duration.
- Mezcla duration+seconds → panel seconds.
- La unidad presentada es una decisión única del panel.
- El resultado no depende del orden de las trazas.

### 4. Las fases todavía dejan estados rotos

Phase 1 habilita overlays y dice cubrir hover/export (`:220-221`), pero los arreglos necesarios quedan en Phase 4 (`:229-230`):

- Export sigue usando el tiempo de la primera traza para todas (`plot-manager.js:1938-1965`).
- Hover cross-file devuelve NaN para numeric↔elapsed (`data-methods.js:804-823`).
- Data tools sigue calculando deltas numeric en unidades raw (`data-tools-methods.js:1020-1043`).
- Live Update sigue comparando únicamente `metadata.timeKind` (`live-update-methods.js:726`).

Por tanto:

- Export y hover deben entrar en la misma fase que el primer overlay mixto.
- Data tools debe cambiar junto con la conversión de unidades de Phase 2.
- Live Update debe actualizarse cuando aparezcan los campos canónicos, o quedar temporalmente bloqueado para esos archivos.

## Otros huecos importantes

### Crop, shift y zoom siguen sin modelo canónico

La v2 conserva `timeShift`, `cropStart` y `cropEnd` "unchanged" (`:74-75`), pero hoy se interpretan en las unidades del display activo (`data-methods.js:550-575`) y se aplican contra `displayTime` (`:830-873`). El UI incluso los borra al cambiar de modo (`file-methods.js:2833-2837`).

Cambiar unidad, origen o source puede reinterpretar silenciosamente valores persistidos. Debe decidirse si crop/shift se almacenan en:

- dominio raw;
- segundos canónicos;
- epoch-ms;
- o una estructura etiquetada por dominio/unidad.

También faltan tests explícitos de crop, shift y restauración de zoom al cambiar unidades.

### CF no gregoriano está excesivamente bloqueado

La v2 deja `360_day`/`noleap` totalmente en raw, sin seconds, duration ni FFT-Hz (`:100, 185, 203`). El calendario gregoriano sí debe bloquearse, pero el parser conserva las unidades CF y los valores raw (`netcdf-parser.js:503-555`). Sus diferencias temporales siguen siendo convertibles a segundos.

Un CF `360_day` puede tener:

- `hasElapsed=true`;
- seconds/duration/FFT físico;
- `hasGregorianCalendar=false`.

Sólo calendar/heatmap temporal gregoriano necesitan quedar deshabilitados.

### La inferencia "header/unit says seconds → elapsed" no es segura

La matriz lo afirma en `:178`, pero `[s]` sólo establece escala, no distingue elapsed de Unix epoch seconds. CSV reconoce `timestamp` como candidato datetime (`csv-time-detection.js:27-33`) pero no tiene conversión Unix actual.

La inferencia automática debería exigir procedencia fuerte, por ejemplo OpenModelica + "Simulation time [s]". Para CSV/Parquet genérico debe mantenerse `unknown` salvo encoding explícito.

## Citas menores a corregir

| Cita v2 | Problema |
|---|---|
| `csv-time-detection.js:1248` para el literal `.` | El literal se escapa al construir el regex en `:1245`; `:1248` sólo ejecuta el match. |
| Fallback numeric `:432-445` | El cálculo/branch empieza en `:431`. |
| `plot-manager.js:2105` como evidencia del contrato histogram | Sólo define `usesTimeTraces`; el guard real está en `histogram-methods.js:110-113` y `plot-manager.js:2472-2474`. |
| "year/week no son fixed-length" (`:266`) | Week sí es fija: el código la convierte a siete días en `data-methods.js:604`; la propia v2 declara `week→604800` en `:82`. |
| "FFL/FFT" en el test 7 | Typo: debe decir FFT. |

## Resultado

La v2 está conceptualmente mucho más cerca, pero necesita una v3 antes de implementar. Los cambios mínimos son:

1. Separar `storageEncoding` de `sourceEncoding`.
2. Separar origen de decodificación de referencia elapsed.
3. Añadir un override de interpretación común a todos los formatos.
4. Mover display/unidad/alineación efectiva al panel.
5. Definir el algoritmo exacto de `effectivePanelDisplay`.
6. Mover export/hover/data-tools/live-update a las fases donde se habilitan overlays y unidades.
7. Canonicalizar crop/shift/zoom.
8. Permitir elapsed físico para CF no gregoriano, bloqueando sólo calendar gregoriano.

## Estado de la revisión

La revisión no modificó código del producto ni el documento de diseño. El worktree quedó limpio en el commit `b133bdf`. Este archivo se añadió únicamente para dejar el historial de iteración completo en el repo.
