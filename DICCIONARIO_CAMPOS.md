# Diccionario de campos de TrackFlow

Nomenclatura única para la base de datos, las plantillas CSV, el panel y el
scraper. Cuando agregues un campo nuevo, sigue estas reglas antes de inventar
un nombre.

## Reglas de nomenclatura

1. **`snake_case` y en español.** `precio_full_bs`, no `precioFullBs` ni
   `full_price`.
2. **Toda dimensión se describe con `nombre`.** No `titulo`, no `descripcion`,
   no `nombre_dci`. `descripcion` queda para el texto largo opcional.
   En `dim_productos` el `nombre` es **solo la identidad comercial**: la dosis
   vive en `producto_principios.concentracion_valor` y el empaque en
   `cantidad_contenido`, así que meterlos en el nombre los duplica en pantalla
   y además rompe la comparación contra el título de la tienda. `Bumetin`, no
   `Bumetin 300mg x 10tab` (ver `fase15_catalogo_nombres.sql`).
3. **Las llaves foráneas terminan en `_id`** y se llaman como la tabla a la que
   apuntan en singular: `laboratorio_id` → `dim_laboratorios.id`.
4. **Sustantivo primero, calificador después:** `unidad_contenido`,
   `tipo_equivalencia`, `codigo_barra`.
5. **El monto lleva su moneda al final:** `_bs` o `_usd`. `precio_full_bs`,
   `pvp_usd`.
6. **Las fechas de evento terminan en `_at`** y se guardan en UTC:
   `created_at`, `fecha_captura`. Las fechas de calendario van sin sufijo:
   `fecha`, `vigente_desde`.

## Los campos que más se confunden

| Concepto | Nombre canónico | Dónde vive | Se aceptan como alias al importar |
|---|---|---|---|
| SKU / código interno de tu producto | **`id_interno`** | `dim_productos.id_interno` | `codigo`, `sku`, `id`, `codigo_interno` |
| Producto propio al que se compara un enlace | **`id_producto_propio`** | columna del CSV de competencia; debe coincidir con un `id_interno` existente | `producto_propio`, `sku_propio` |
| Código de barras | **`codigo_barra`** | `dim_productos.codigo_barra` | `codigo_barras`, `ean`, `barras` |
| Módulo de scraping de una cadena | **`scraper_modulo`** | `dim_cadenas.scraper_modulo` | `modulo_scraper`, `modulo` |
| Principio activo | **`nombre`** | `dim_principios_activos.nombre` | `nombre_dci`, `dci` |
| Cantidad de unidades del empaque | **`cantidad_contenido`** + `unidad_contenido` | `dim_productos` | `tamano`, `presentacion`, `unidosis`, `unidades_empaque` |
| PVP oficial propio (en CSV) | **`pvp_propio_usd`** | columna del CSV de productos → `pvp_propio.pvp_usd` | `pvp`, `pvp_usd`, `precio_usd` |
| Precio de lista capturado | **`precio_full_bs`** | `fact_precios` | `precio`, `precio_lista` |
| Precio con descuento capturado | **`precio_desc_bs`** | `fact_precios` | `precio_oferta`, `precio_descuento` |

Los alias los resuelve `getRowValue()` en `web/src/utils/csvParser.js`, que
ignora mayúsculas, acentos, espacios y guiones. Por eso una columna llamada
`Código de Barras` entra igual que `codigo_barra`. **Escribe los nombres
canónicos en tus plantillas nuevas**; los alias existen para que los CSV viejos
sigan funcionando, no como estilo a seguir.

## Sobre el tamaño del empaque

Es el punto más confuso del sistema porque conviven cuatro nombres para ideas
parecidas:

- **`cantidad_contenido` + `unidad_contenido`** es lo único que guarda la base
  (`120` + `ml`, o `10` + `unidad`). `unidad_contenido` solo acepta
  `unidad`, `ml` o `g`.
- **`concentracion`** (`650mg`) es otra cosa: la dosis del principio activo, no
  el tamaño del empaque.
- **`tamano`** y **`presentacion`** son texto libre heredado (`650 mg x 10
  tabletas`). El panel los usa para mostrar y para deducir la unidosis.
- **`unidosis`** es el número de unidades por empaque, que se usa para comparar
  precio por tableta.

Al cargar por CSV puedes mandar `tamano` en texto libre: el sistema deduce la
unidosis. Si quieres control exacto, manda `unidosis` con el número.

## Cambios aplicados (fase8_nomenclatura.sql)

| Antes | Ahora | Por qué |
|---|---|---|
| `dim_cadenas.modulo_scraper` | `dim_cadenas.scraper_modulo` | El frontend, el scraper y `cadenas.csv` ya escribían `scraper_modulo`. La columna tenía otro nombre, así que **ese dato nunca se guardaba**. |
| `dim_principios_activos.nombre_dci` | `dim_principios_activos.nombre` | Era la única dimensión que no usaba `nombre`. |

### Lo que deliberadamente NO se renombró

- **`dim_productos.id_interno`**: ya es el nombre canónico y tiene 205
  referencias en 4 vistas analíticas, el scraper, la migración de la Fase 2 y
  13 archivos del frontend. Renombrarlo no aporta nada funcional y rompe todo
  a la vez. Lo que se corrigió fue el otro lado: las plantillas CSV y las
  etiquetas de pantalla ahora dicen `id_interno`.
- **`dim_productos.codigo_barra`**: 31 referencias contra 4 de `codigo_barras`.
  Se conservó el nombre de la base y se alineó el frontend.
- **`dim_tipos_promocion.codigo`** y **`dim_cadenas.id`**: no son
  inconsistencias, son claves de negocio en texto que conviven con `nombre`.
- **`dim_tasa_bcv.fecha`** y **`config_calidad.clave`**: son llaves primarias
  naturales a propósito, no un `id` que falte.

## Etiquetas visibles del panel

Las etiquetas que ve el usuario viven en `web/src/utils/etiquetas.js`. La regla
es: **un campo se llama igual en la tabla, en el formulario, en el filtro, en el
desplegable, en el eje del gráfico y en el CSV exportado.**

Cuando necesites el texto de un campo, impórtalo de `ETIQUETAS` en vez de
escribirlo a mano. Así no vuelven a aparecer tres nombres para el mismo dato.

### Variantes unificadas

| Se llamaba | Dónde | Ahora |
|---|---|---|
| `Nombre / Molécula` | tabla de Productos | **Nombre del Producto** |
| `Nombre Comercial *` | formulario de Productos | **Nombre del Producto** |
| `Nombre Comercial / Marca *` | formulario de Competencia | **Nombre del Producto** |
| `Laboratorio / Fabricante` | Competencia y Reportería (8 sitios) | **Laboratorio** |
| `Identificador Técnico Scraper` | tabla de Cadenas | **Módulo de Scraping** |
| `Identificador Técnico Robot` | formulario de Cadenas | **Módulo de Scraping** |
| `Nombre Comercial *` | formulario de Cadenas | **Nombre de la Cadena** |
| `Código ID` | Dimensiones → Cadenas | **ID de la Cadena** |
| `ID Numérico Producto (dim_productos)` | Dimensiones → PVP Propio | **ID Interno del Producto** |

### Alias con barra eliminados

Una barra que significa *"o dicho de otra forma"* es un alias y se elimina. Una
barra que significa *división* se conserva.

| Se llamaba | Dónde | Ahora |
|---|---|---|
| `Cadena Farmacia` | tabla de Competencia (2 sitios) | **Cadena** |
| `Cadena / Competidor` | Reportería | **Cadena** |
| `Medicamento / Producto` | Mapa de Calor | **Producto** |
| `Concentración / Tamaño` | tabla de Productos | **Presentación** |
| `Tamaño / Presentación` | formulario de Competencia | **Presentación** |
| `Tamaño / Unidades` | formulario de Productos | **Presentación** |
| `Molécula / Principio Activo` | Simulador | **Principio Activo** |
| `Molécula / Principio` | formulario de Productos | **Principio Activo** |
| `Marca / Línea` | Reportería | **Marca** |
| `Marca / Variante` | detalle de Producto | **Marca** |
| `Costo / Pastilla` | Canibalización | **Costo por Unidad** |

`Bs / USD Oficial` se conserva: ahí la barra es una división real (bolívares
por dólar), no un alias.

### Terminología de negocio: Cadena ≠ Competidor

Son dos cosas distintas y se habían mezclado en una sola etiqueta
(`Cadena / Competidor`):

- **Cadena**: la farmacia donde se publica un producto (Farmatodo, Locatel,
  FarmaDON…). Vive en `dim_cadenas`. Toda etiqueta que decía "Farmacia" o
  "Cadena Farmacia" ahora dice **Cadena**.
- **Competidor**: todo producto cuyo laboratorio **no** está marcado como
  propio, es decir `dim_laboratorios.es_propio = false`. Lo contrario es
  **Mi Marca**.

Un mismo competidor puede estar en varias cadenas, y una cadena vende tanto
productos de Mi Marca como de Competidores. Por eso no pueden compartir columna
ni etiqueta.

Variantes unificadas: `Alternativa`, `COMPETENCIA` y `Competidor` →
**Competidor** / **COMPETIDOR**. `Mi marca`, `MI MARCA` y `Mi Marca` →
**Mi Marca** / **MI MARCA**.

## Estado de la estandarización de la base

Auditoría de `fase1_esquema.sql` contra las reglas de arriba.

**Cumplen:**

- Regla 2 (cada dimensión expone `nombre`): las 9 dimensiones con descripción.
  `dim_tasa_bcv` no tiene `nombre` porque su PK natural es `fecha`, que es
  deliberado.
- Regla 3 (las llaves foráneas terminan en `_id`): sin excepciones.
- Regla 5 (los montos llevan su moneda): `precio_full_bs`, `pvp_usd`, etc.

**Pendientes:** solo uno, y es deliberado.

| Columna | Situación |
|---|---|
| `fact_precios.fecha_captura` | Viola la regla 6 en sentido estricto (es un evento y no termina en `_at`). **Se conserva a propósito**: aparece en las 4 vistas analíticas, el scraper y buena parte del frontend, y renombrarla solo compraría coherencia cosmética a cambio de un riesgo alto. |

**Cerrados en la Fase 10:**

| Columna | Antes | Ahora |
|---|---|---|
| `dim_cadenas` | `scraper_modulo` | **`modulo_scraper`** (regla 4: es el módulo *del* scraper) |
| `scrape_runs` | `trigger_tipo` | **`tipo_trigger`** (regla 4) |
| `audit_log` | `fecha` | **`created_at`** (regla 6) |

La Fase 8 había dejado `scraper_modulo` por una decisión de coste, eligiendo el
nombre que ya usaban la mayoría de los consumidores. Contradecía la regla 4, así
que la Fase 10 le da la vuelta y alinea los 29 puntos de uso: esquema, migración
de la Fase 2, vista de compatibilidad, los dos scripts del scraper, el frontend
y `cadenas.csv`.

Un detalle que costó encontrar: al renombrar una columna, Postgres actualiza la
referencia interna de las vistas que dependen de ella, pero **no** cambia el
nombre de la columna que la vista expone. Por eso la vista `cadenas` hay que
recrearla a mano, y la Fase 10 lo hace en los dos escenarios posibles.
