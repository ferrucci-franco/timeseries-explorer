# Revisión técnica adversarial 3 — Time-axis unification (v3)

Documento revisado: `docs/time-axis-unification-design.md` (v3)

Worktree: `worktree-feature+mixed-xaxis-plot`

Revisor: auto-revisión (Claude Code), en ausencia de un revisor externo. Ver la nota de sesgo al final. Toda afirmación se ancla a `archivo:línea`; **(v)** marca lo verificado directamente contra el código durante esta revisión.

## Veredicto: REQUIERE v4 (correcciones acotadas)

La arquitectura de v3 es sólida y resuelve correctamente las ocho observaciones de la revisión-2. **No** hay que rehacerla. Pero antes de implementar la Fase 0 hay que corregir **dos fallas críticas** —una regresión de compatibilidad y una omisión de derivación— y **cuatro** de severidad alta/media. Todas son ediciones locales del documento; ninguna invalida el modelo canónico.

## Mejoras confirmadas (v2 → v3)

- `storageEncoding` vs `sourceEncoding` elimina el riesgo de doble decodificación; los parsers efectivamente guardan epoch-ms (`csv-time-detection.js:1043-1058` **(v)**, `netcdf-parser.js:512-523` **(v)**).
- `decodeOrigin` vs `elapsedReferenceMs` separa dos conceptos que antes se mezclaban.
- `interpretationOverride` da un canal universal de reclasificación (aunque ver M7).
- El estado de panel (`PanelTimeAxisState`) es la ubicación correcta para display/unidad/alineación (aunque ver H3/H4).
- CF no gregoriano con elapsed físico y sólo calendar gregoriano bloqueado (aunque ver M8).
- Fases re-scopeadas: export/hover en Fase 1, data-tools en Fase 2, live-update en Fase 4.

## Bloqueos residuales

### Críticas

#### C1. Regresión: dos archivos numéricos genéricos que HOY se superponen dejarían de hacerlo

El guard actual es `sameKind && sameMode` (`plot-manager.js:2460-2462` **(v)**). Dos archivos numéricos genéricos devuelven ambos `_timeKind='numeric'` (`data-methods.js:152-155` **(v)**) y `_timeDisplayMode='numeric'` (`:236-242` **(v)**) → **hoy son compatibles y se superponen** (caso típico: dos corridas de OpenModelica en segundos).

v3 clasifica el numérico genérico como `unknown` → `display=raw` (§2.2) → `renderSignature='linear:raw:<unit?>'` (§4.1), y afirma que "unknown never auto-matches". Esto **rompe un overlay que hoy funciona**.

Además es una **contradicción interna** de v3: §4.1 dice que `raw` "matches only an identical `raw:<semantic+unit>`" (dos `unknown` idénticos deberían coincidir) pero al mismo tiempo "unknown never auto-matches". No se puede sostener ambas.

**Corrección necesaria:** definir explícitamente que dos ejes `raw` con la misma unidad nominal (incluida "sin unidad") **son** render-compatibles, preservando el comportamiento actual numeric↔numeric; reservar la incompatibilidad para `unknown` frente a semánticas distintas. Y agregar un test de no-regresión: dos numéricos genéricos siguen superponiéndose tras la migración.

#### C2. `absoluteMs` no cubre el caso `row-count → absolute` (calendario generado desde índice)

La fórmula de `absoluteMs` en §2.1 sólo maneja `epoch-ms | unix-s | raw-number`. Pero la matriz legacy (§6) mapea "index + calendar origin" a `count→absolute` con `storageEncoding='row-count'`, y el código actual produce fechas reales con `origin + fila×step×1000` (`_generatedIndexDisplayTime`, `data-methods.js:334-346` **(v)**).

Por lo tanto un eje de calendario generado desde índice —que hoy funciona— **no tiene derivación canónica** en v3.

**Corrección necesaria:** agregar la rama `storageEncoding='row-count'` con `deltaT`/`decodeOrigin` a `absoluteMs` (`absoluteMs = decodeOrigin + fila·deltaTs·1000`), y un test de que el calendario generado sub-ms conserva su valor.

### Altas

#### H3. `resolvePanelTimeAxis` reintroduce dependencia del orden y contradice su invariante 3

§5 fija `effectiveUnit = panel.unitChoice ?? primaryPreferredUnit ?? 's'` y menciona la "traza primaria". Pero el invariante 3 de la misma sección exige que el resultado "dependa sólo del conjunto de preferencias, nunca del orden de inserción". Si la unidad cae a la de la traza primaria (= primera/ancla), el resultado **sí** depende del orden.

**Corrección necesaria:** regla de unidad independiente del orden (p.ej. unidad explícita de panel; y como default determinista, la unidad más fina o más gruesa del conjunto, no la de la "primaria").

#### H4. `shared-absolute-origin` no define de dónde sale `referenceOriginMs`

§5 usa `panel.sharedOriginMs` pero nunca especifica cómo se elige (¿mínimo de los orígenes de las series? ¿fijado por el usuario? ¿el de la primaria?). Sin esa definición la política es inimplementable y vuelve a arriesgar dependencia del orden. El origen actual ya proviene de varios fallbacks (`data-methods.js:292-309` **(v)**), lo que agrava la ambigüedad.

**Corrección necesaria:** definir `referenceOriginMs` como decisión explícita de panel con default determinista (p.ej. el mínimo `originMs` entre las series absolutas), y persistirlo.

#### H5. La superficie de "lectores de semántica" está subestimada: existe `_fftTimeKind`

v3 afirma que `_timeAxisModel` será "the only reader of time semantics" (§3). Pero hay un segundo lector paralelo, `_fftTimeKind`, usado por **todos** los modos de análisis: correlation (`correlation-methods.js:1167`), heatmap (`heatmap-methods.js:358`), histogram (`histogram-methods.js:397`), temporal-profile (`temporal-profile-methods.js:577, 583, 638`) e interaction (`interaction-methods.js:3217`). **No se encontró su definición** por búsqueda en `src/**` (6 archivos lo usan, ninguno lo define); además 2 de 8 llamadas usan encadenamiento defensivo `?.`, señal de incertidumbre. También `metadata.timeKind` se lee directamente en data-tools (`data-tools-methods.js:1028-1031` **(v)**) y live-update (`live-update-methods.js:726` **(v)**).

**Corrección necesaria:** la Fase 0 debe enumerar y migrar **todos** los lectores (`_timeKind`, `_fftTimeKind`, `metadata.timeKind`), y localizar/definir `_fftTimeKind` (posible bug latente a investigar aparte, fuera del alcance del diseño).

#### H6. El dominio canónico de crop/shift omite `count`/índice

Hoy existen **cuatro** dominios de crop: calendar, índice en filas (`usesIndexCrop`), duration/seconds y numérico (`file-methods.js:3034-3045` **(v)**). v3 propone sólo dos dominios canónicos: `canonical-seconds | epoch-ms` (§8). El crop de índice (en número de fila) y el de numérico/`raw` no encajan en ninguno.

**Corrección necesaria:** el valor etiquetado de crop/shift debe incluir al menos `row-index` (filas) y `raw:<unit>`, además de `canonical-seconds`/`epoch-ms`; y tests de crop en ejes índice y `raw`.

### Medias

#### M7. `interpretationOverride` rompe la "regla de oro" de §3 sin señalarlo

§3 afirma: "Parse decides what the value is; the menu decides how it looks". Pero §4.3 permite que el menú cambie `semantic/storageEncoding` — es decir, el menú **también** decide qué es el valor. Es defendible (un solo campo, misma fuente de verdad), pero contradice la regla tal como está escrita —justo la preocupación original del usuario (tarea c)—.

**Corrección necesaria:** reformular la regla: "el parse **siembra** el significado; el usuario puede **overridearlo** mediante un único campo compartido; el menú nunca decide *presentación* y *significado* con lógicas separadas".

#### M8. CF no gregoriano con unidades no fijas queda sin especificar

§2.2/§4.2 conceden elapsed a CF `360_day` vía la unidad CF. Pero las unidades CF pueden ser "months since"/"years since", no fijas. El enum `storageUnit` de v3 no incluye `month`, y `year` está marcado como no fijo. Entonces "elapsed para CF no gregoriano" sólo vale para sub-unidades fijas (s/min/h/d/week); los ejes CF en meses/años quedan sin representación.

**Corrección necesaria:** acotar explícitamente que el elapsed físico de CF no gregoriano aplica sólo a unidades fijas; meses/años CF caen a `coordinate/raw` con aviso.

#### M9. Redacción imprecisa de la capability de temporal-profile

§4.2 dice que temporal-profile "requires datetime/calendar traces", pero el código chequea `_fftTimeKind==='datetime'` (kind), no `display=calendar` (`temporal-profile-methods.js:577, 583` **(v)**). Corregir a "requiere kind datetime".

## Citas a revisar

| Cita v3 | Problema |
|---|---|
| §3 "the only reader of time semantics" | Falso: existe `_fftTimeKind` (6 archivos) además de lecturas directas de `metadata.timeKind`. |
| §4.2 temporal-profile "datetime/calendar" | El chequeo real es por kind (`_fftTimeKind==='datetime'`), no por display=calendar. |
| §5 "primaryPreferredUnit" | Reintroduce orden; contradice el invariante 3 de la misma sección. |

## Resultado

v3 está muy cerca. Cambios mínimos para llegar a v4 implementable:

1. **C1** — definir compatibilidad de `raw`/`unknown` de forma que numeric↔numeric siga funcionando; resolver la contradicción "raw idéntico coincide" vs "unknown nunca coincide"; test de no-regresión.
2. **C2** — agregar la rama `row-count → absolute` a `absoluteMs`.
3. **H3** — regla de `effectiveUnit` independiente del orden.
4. **H4** — definir y persistir `referenceOriginMs`.
5. **H5** — enumerar y migrar todos los lectores (`_timeKind`, `_fftTimeKind`, `metadata.timeKind`) en Fase 0; localizar `_fftTimeKind`.
6. **H6** — extender el dominio de crop/shift a `row-index` y `raw`.
7. **M7/M8/M9** — reformular la regla de oro, acotar CF unidades fijas, corregir la capability de temporal-profile.

## Nota de sesgo (auto-revisión)

Esta revisión la produjo el mismo agente que escribió el diseño, de modo que carece de la independencia de un segundo modelo. Se mitigó exigiendo evidencia `archivo:línea` y buscando activamente regresiones y contradicciones internas (C1, C2, H3 son hallazgos nuevos que las revisiones 1 y 2 no cubrieron). Aun así, conviene una ronda externa antes de mergear código de producto.

## Estado

No se modificó código de producto. Este archivo se añadió sólo para dejar el historial de iteración completo en el repo.
