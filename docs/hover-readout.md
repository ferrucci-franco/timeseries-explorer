# Los números de los recuadros de hover

Cómo se escribe cada número dentro de un recuadro de hover (el recuadro azul
que Plotly dibuja al pasar el puntero sobre una curva, y el recuadro
sincronizado que repite la lectura en los otros paneles).

## 1. El problema

Cada recuadro formateaba a su manera: `.6g` en el espectro, `.4g` en la serie
temporal, `toPrecision(5)` o `(6)` en otros. El resultado, en un mismo
recuadro:

```
Frequency [Hz] = 1593.93
Period = 0.000627379 s
Amplitude = 0.00721255
```

Ceros a la izquierda que hay que contar, la notación `1.234e+4` para la
muestra 12345, `1.0000` para un uno, la unidad a veces entre corchetes en la
etiqueta y a veces después del número, y los `toPrecision` sin el separador
decimal elegido en Settings.

## 2. La regla

Una sola, en `src/utils/readout-format.js`:

| | |
|---|---|
| Cifras | **4 significativas**, sin ceros finales |
| Entre 0,01 y 10 000 | decimal plano: `0.1234 V`, `1594 Hz` |
| Fuera de ese rango | **prefijo SI**, nunca exponente: `627.4 µs`, `7.213 mV`, `12.35 kPa` |
| Unidad | después del número, pegada al prefijo: `7.213 mV`, no `Left [V] = 0.007213` |
| Unidad que no admite prefijo | `°C`, `%`, `dB`, `min`, o una que ya lo trae (`kg`, `ms`): `1.23×10⁻³ °C`, porque `1.23 m°C` o `1.23 mkg` están mal |
| Sin unidad | el prefijo solo: `Amplitude = 7.213 m` |
| Separador decimal | el de Settings (`627,4 µs`); nunca se agrupan miles |
| Signo | `−` (U+2212), como las marcas de eje de Plotly |

La **abscisa** (tiempo, frecuencia) conserva las cifras que exige su
resolución, para que dos muestras o dos bins vecinos nunca se lean igual:
`Frequency = 1593.9 Hz` en un espectro con bins de 0,26 Hz, `123.456 µs` en
un registro muestreado cada nanosegundo. Lo otro que el recuadro dice del
mismo punto (el período de un bin, el valor de una señal) va con cuatro.

Excepciones deliberadas:

- **Correlación**: r y r² con cuatro decimales fijos (`0.9877`). Un
  coeficiente acotado por ±1 con prefijo (`r = 5 m`) no tiene sentido.
- **Conteos** (histograma, N de la correlación): enteros, con el agrupado de
  miles del idioma.
- **Porcentajes**: la regla general con unidad `%` (`12.35 %`).
- **Fechas, duraciones e índices de fila**: su propio formato; no son
  cantidades con una unidad que prefijar.
- **El mapa de un archivo grillado** (NetCDF/GRIB) sigue con `.5~g` de d3: una
  grilla de un millón de celdas que cambia con cada paso de tiempo animado no
  puede llevar un texto preformateado por celda.

## 3. Cómo llega al recuadro

d3, que es lo que formatea un `hovertemplate`, no sabe decir "decimal plano
entre 0,01 y 10 000, prefijo pegado a la unidad fuera". Así que una traza
**declara** sus líneas numéricas en lugar de formatearlas
(`src/utils/hover-readout.js`):

```js
trace._hoverReadout = {
    lines: [
        { label: '<b>Time</b>', source: 'x', unit: 's', resolution: 5e-6 },
        { label: '<b>Left</b>', source: 'y', unit: 'V' },
    ],
    fallback: '<b>Time</b> = %{x:.6g} s<br><b>Left</b> = %{y:.4~g} V',
};
trace.hovertemplate = '%{hovertext}<extra></extra>';
```

y el wrapper de Plotly (`src/vendor/plotly.js`) escribe `hovertext` —un texto
por punto— cada vez que los `x`, `y`, `z` o `customdata` de la traza llegan a
Plotly: `newPlot`, `react`, `restyle`, `update` y `addTraces`. Está ahí y no
en cada constructor porque una serie temporal se redibuja en cada zoom por
media docena de caminos (en memoria, lazy, desde un worker, con cortes por
huecos…), y si uno solo se olvidara del recuadro, éste mostraría los números
de la ventana anterior al lado de la curva nueva.

Una traza dibujada **sin decimación** puede tener millones de puntos, y un
texto por punto costaría más que el dibujo. Por encima de
`HOVER_READOUT_POINT_LIMIT` (100 000 puntos) el wrapper reemplaza
`%{hovertext}` por el `fallback` de d3: el número correcto, con la notación
de antes.

En un archivo en modo de ahorro de memoria la resolución del eje de tiempo
sale de la cantidad de filas del archivo (`_duckdb.totalRows`), no de la
vista general que está en memoria: si no, el paso leído sería miles de veces
más grueso y el recuadro mostraría menos cifras que el mismo archivo abierto
en memoria.

## 4. Dónde se aplica

| Recuadro | Archivo |
|---|---|
| Serie temporal (y su constante de parámetro) | `src/plots/methods/data-methods.js` (`_buildTimeTrace`) |
| Fase 2D, 2D+t y 3D | `src/plots/methods/data-methods.js` (`_phaseHoverReadout`) |
| Espectro (frecuencia, período, amplitud) | `src/plots/methods/fft-methods.js` (`_fftSpectrumHoverReadout`) |
| Ajuste de curva, tendencia, residuos | `src/plots/methods/curve-fit-methods.js` (`_fitCurveHoverReadout`), `trend-methods.js` |
| Ajuste 2D | `src/plots/methods/phase2d-fit-methods.js` |
| Histograma | `src/plots/methods/histogram-methods.js` |
| Correlación | `src/plots/methods/correlation-methods.js` |
| Integral | `src/plots/methods/integral-methods.js` |
| Perfil temporal | `src/plots/methods/temporal-profile-methods.js` |
| Heatmap de calendario | `src/plots/methods/heatmap-methods.js` |
| Serie de un punto de la grilla | `src/app/methods/gridded-methods.js` |
| Recuadro sincronizado entre paneles, bandas de estado | `src/plots/plot-manager.js` (`_formatReadoutHTML`), `state-band-methods.js` |

El panel de **cursores de medición** no es un hover y conserva su formato
propio.

## 5. Tests

- `scripts/test-readout-format.mjs`: la regla, las unidades que no admiten
  prefijo, la coma decimal, la resolución de la abscisa, y que el texto siga
  a cada `restyle`.
- `scripts/test-hover-time-precision.mjs`: la resolución del eje de tiempo,
  también la de un archivo lazy.
- `scripts/e2e-hover-readout.mjs`: el recuadro que Plotly dibuja de verdad,
  en una serie temporal, después de un zoom, en el espectro y con coma
  decimal.
