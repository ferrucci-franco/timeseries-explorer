# Formato de números — separador decimal y de miles

> Estado: **implementado**.
> Motivación: un lector preguntó por qué veía `1.311` y si eso dependía del sistema operativo. No dependía — y resultó que tampoco se podía cambiar.

---

## 1. De dónde salía el formato, y de dónde sale ahora

**No depende del sistema operativo**, y nunca dependió. La app ignora `navigator.language` a propósito: el comentario en [`src/i18n/index.js`](../src/i18n/index.js) lo explica desde antes de este cambio — `toLocaleString()` a secas sigue al navegador, así que una app puesta en español en un navegador inglés imprimiría `16,777,216` dentro de una frase en español, con los separadores diciendo una cosa y las palabras otra.

El formato sale del **selector de idioma EN/ES/FR/IT**. Eso sigue igual y sigue siendo el default. Lo que se agrega es poder **sobrescribir cualquiera de los dos separadores** en Settings → Number format, porque la convención del idioma de la interfaz y la convención en la que trabaja el lector no siempre coinciden: un informe en español para un cliente que lee en inglés, una convención francesa sin querer la interfaz en francés, una captura que tiene que coincidir con un documento.

Ambos ajustes arrancan en `auto`, que es exactamente lo que el idioma hacía antes. **Quien no abra el ajuste no ve ningún cambio.**

## 2. Lo que hace cada opción

| Idioma (`auto`) | 1311 | 13110 | 1234567.25 |
|---|---|---|---|
| EN | `1,311` | `13,110` | `1,234,567.25` |
| ES | `1311` | `13.110` | `1.234.567,25` |
| FR | `1 311` | `13 110` | `1 234 567,25` |
| IT | `1311` | `13.110` | `1.234.567,25` |

Ojo con ES e IT: **no agrupan un número de cuatro cifras** y agrupan desde cinco. No es una decisión de la app, es la regla CLDR de esos idiomas, y `auto` la respeta. Una elección **explícita** agrupa desde cuatro cifras, porque elegir un separador es pedir verlo.

Opciones: decimal `punto` o `coma`; miles `ninguno`, `punto`, `coma`, `espacio` o `apóstrofo`.

El espacio es **U+202F** (espacio fino de no separación), el mismo carácter que emite `Intl` para francés: un blanco común podría partirse en un salto de línea y cortar el número al medio.

### Los dos nunca pueden ser el mismo carácter

`1.234.567.25` no dice nada. Si la elección colisiona con lo que el idioma usa del otro lado, **gana el decimal y la agrupación cede**: un número sin agrupar sigue siendo legible, uno con el decimal indistinguible no. En el panel, además, la opción que colisionaría aparece deshabilitada, así que la causa se ve en lugar de descubrirse después.

## 3. Alcance: qué toca y qué no

| | |
|---|---|
| **Sí** | Todo lo que la app escribe para leer: totales y tablas de los análisis, estado de los paneles, conteos en los mensajes ("61.368 puntos"), resúmenes |
| **Sí** | Lo que escribe **Plotly**: marcas de ejes y hovers, vía `layout.separators`, para que el eje coincida con el panel de al lado |
| **No** | La **exportación CSV** y cualquier salida que una máquina vuelva a leer |
| **No** | Los **campos de entrada numéricos**, que el navegador parsea con sus propias reglas |

Las dos exclusiones son deliberadas y están cubiertas por tests. Un CSV con decimales de coma al lado de delimitadores de coma es un archivo roto; las celdas salen crudas, con punto y sin agrupar. Y escribir un valor en una convención dentro de un campo que sólo acepta otra es cómo un ajuste se convierte en datos perdidos.

El mensaje de progreso que acompaña a una exportación **sí** se puntúa: "12.345 de 61.368 filas" es prosa para un lector, no una celda.

## 4. Arquitectura

| Capa | Archivo | Qué hace |
|---|---|---|
| Núcleo puro | `src/utils/number-format.js` | El catálogo de opciones, el resolutor idioma + ajustes → caracteres concretos, y el formateo |
| Formateador de la app | `src/i18n/index.js` | Guarda el formato resuelto (`numberFormat`) y lo aplica en `i18n.formatNumber` |
| Plotly | `src/vendor/plotly.js` | `setPlotNumberSeparators` inyecta `layout.separators` en el mismo punto donde ya se inyectan las fuentes |
| Ajustes | `src/app/viewer-app.js` | Persistencia, validación por tabla de opciones, y `_applyNumberFormat()` |
| Panel | `src/app/methods/ui-methods.js` | El tema "Number format" con sus dos selects y el ejemplo en vivo |

Dos decisiones de diseño que vale la pena nombrar:

**El resolutor devuelve caracteres concretos, no opciones.** `resolveNumberFormat(idioma, ajustes)` da `{ decimal, group, groupFrom }`, de modo que ningún sitio de formateo vuelve a saber qué es un idioma ni qué es un ajuste. Eso es lo que permitió enchufar el formato en `i18n` y en Plotly sin que ninguno de los dos importe el otro.

**Las convenciones del idioma se leen de `Intl`, no de una tabla propia.** Una tabla sería una cosa más que mantener al día con el navegador, y ya hay un caso (la regla de cuatro cifras de ES/IT) que nadie hubiera adivinado.

**Un punto de entrada por capa.** `layoutFor` en el wrapper de Plotly cubre los diecisiete `newPlot` y todos los `react` de la app; la alternativa era acordarse de `separators` en cada constructor de layout.

## 5. Un cambio que vino de arrastre

Los 24 sitios que llamaban a `toLocaleString()` pelado —conteos en mensajes: puntos, muestras, celdas, series— seguían al **navegador**, en contra de la política que el propio módulo de i18n documenta. Ahora pasan por `i18n.formatNumber`, así que siguen al idioma elegido y al ajuste como todo lo demás.

Quedan sin convertir los diagnósticos en inglés que viven en parsers y en la capa de datos (`netcdf-parser.js`, `duckdb-live-limits.js`): son cadenas no traducidas, producidas lejos de la interfaz, y meterles i18n sería invertir la dependencia entre capas por un separador de miles.

Tests: `scripts/test-number-format.mjs`.
