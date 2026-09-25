# TrackFlow — estado del proyecto

Documento de contexto para retomar el trabajo en una conversación nueva.
Última actualización: 2026-09-24 (fin de la sesión de las PR #23 a #31).

---

## Qué es

Panel de inteligencia competitiva de precios de medicamentos en Venezuela.
Un scraper diario lee los precios de las farmacias online, los guarda en
Supabase y el panel los compara contra el PVP propio.

**El único laboratorio propio es `LA SANTE`** (sin acento, en mayúsculas como
todos los laboratorios). Dentro de él hay **unidades de negocio**, que no son
laboratorios:

| Unidad de negocio | Qué lleva |
|---|---|
| La Sante | Genéricos |
| Pharmetique | Marcas |
| OTC | Venta libre |

No confundir "La Sante" laboratorio (el fabricante) con "La Sante" unidad de
negocio (la línea de genéricos). Desde la fase 19 todos los productos propios
cuelgan del laboratorio `LA SANTE`.

## Cómo trabaja Hernando (importante)

- **No usa git localmente.** Edita el código en Google AI Studio.
- Fusiona los pull requests **desde el navegador**, en GitHub.
- Corre el SQL **a mano**, en el SQL Editor de Supabase.
- Google AI Studio no se entera de los merges: hay que reimportar el repo.

Así que el flujo es: Claude hace el cambio → abre una PR → él la fusiona →
corre el SQL si lo hay. **Nunca dar por hecho que tiene terminal.**

---

## Arquitectura

Esquema en estrella sobre PostgreSQL/Supabase.

```
                    dim_productos
                         │
    dim_laboratorios ────┤
    dim_categorias  ─────┤       producto_principios ── dim_principios_activos
    dim_unidades_negocio ┤            (molécula + dosis)
    dim_formas_farmaceuticas         pvp_propio (precio propio, con vigencia)
                         │
                   publicaciones ──── dim_cadenas
                         │            (una fila por URL monitoreada)
                    fact_precios ──── scrape_runs
                    (una captura por día y publicación)

    producto_equivalencias   relaciona producto propio ↔ producto competidor
    dim_tasa_bcv             tasa oficial diaria
```

**Los productos de la competencia viven en `dim_productos` también**, con
`id_interno` que empieza por `COMP_`. Los creó `fase2` a partir de la tabla
vieja. El frontend los filtra (`DataContext.jsx`). No son catálogo propio y no
se cargan por CSV.

Los SKU propios son numéricos de 6 dígitos que empiezan por 1 (`140216`).

**Tipo de mercado** (`MARCA` / `GENERICO`) se guarda en
`dim_productos.tipo_mercado` desde la fase 18. Antes se calculaba al leer
("Pharmetique" = MARCA) y no se podía corregir. En el frontend se sigue
llamando `market_type`.

### Vistas de compatibilidad

`productos_competencia`, `historico_precios`, `cadenas` y `bcv_rates` ya **no
son tablas**: son vistas de solo lectura sobre el esquema nuevo, creadas por
`fase5`. Escribir en ellas devuelve el error `55000`, que el cliente ignora a
propósito.

---

## Las 22 fases de SQL

Se corren en orden en el SQL Editor de Supabase. Todas son idempotentes.

| Fase | Qué hace |
|---|---|
| 1 | Esquema y RLS |
| 2 | Migración de los datos viejos |
| 5 | Las tablas legacy pasan a ser vistas |
| 6 | **17 políticas DELETE** que faltaban, `fn_eliminar_producto` |
| 7 | Recrea `historico_precios`, añade `v_precio_diario` |
| 8, 10 | Unificación de nomenclatura |
| 9 | `productos_competencia` desde `publicaciones` (enlaces sin precio) |
| 11 | `v_variacion`: precios a 1/7/15 días por publicación |
| 12 | `v_capturas_sospechosas`, `v_calidad_datos`, bandeja de revisión |
| 13 | `fn_evaluar_calidad_historica` + diagnósticos D1/D2/D3 |
| 14 | `v_descomposicion_precio`: separa devaluación de subida real |
| 15 | `v_nombres_a_revisar`, `v_nombres_redundantes`, `v_productos_sin_ficha` |
| 16 | `v_csv_productos`: el CSV de limpieza del catálogo |
| 17 | Forma farmacéutica + abreviaturas de envase (`CJAX30`, `FCOX15ML`) |
| 18 | `dim_productos.tipo_mercado` (MARCA/GENERICO), rellenado con la regla vieja |
| 19 | Un solo laboratorio propio `LA SANTE`; borra PHARMETIQUE*, BIOQU* y duplicados |
| 20 | Une moléculas duplicadas (`Acetaminofen` / `Acetaminofén`…) y deja **todas sin tildes** ("Losartan potasico"); los nombres anteriores quedan como `sinonimos`. `fn_clave_molecula`, `fn_nombre_molecula` |
| 21 | Competencia: borra competidores `COMP_` sin URL (huérfanos) y crea `fn_registrar_precio_manual` (SECURITY DEFINER: el panel no puede insertar en `fact_precios`) |
| 22 | Borra el PVP de todos los `COMP_` (el $1.00 que puso la fase 2) y los 20 competidores sin URL que la 21 no pudo borrar por ese PVP |

**Corridas en Supabase de la 1 a la 22.** La comprobación de la 22 dio 0 y 0. Tras la 21 quedaron **20** competidores `COMP_` sin URL: todos
tenían PVP en `pvp_propio` y la 21 no borra nada con PVP. Ese PVP era el
$1.00 base que la fase 2 le dio a todo lo que parecía propio por laboratorio
o unidad de negocio; un competidor no tiene PVP propio.

---

## ⏭️ DÓNDE ESTAMOS

| | |
|---|---|
| Código en `main` | PR #36, desplegado (GitHub Pages sale solo de `main`); etapa B de Competencia en el PR #37 |
| SQL corrido en Supabase | **Hasta la fase 22** |
| Módulo Productos | **Terminado** (ver abajo) |
| Módulo Competencia | **Etapas A (#36) y B (#37), limpieza (#38, fase 22) y ajustes (#39)** |
| Recarga del catálogo | **A medias y aparcada por decisión de Hernando** |

Lo siguiente lo decide Hernando. Candidatos, en el orden en que salieron:
terminar la recarga, las 7 funciones del bloque 5, o el siguiente módulo.

---

## El módulo Productos (sesión del 2026-09-24)

### Lo que se hizo, PR por PR

| PR | Qué |
|---|---|
| #23 | El importador pisaba datos: categoría a "Otros" por una lista fija, `null` en categoría/unidad si el nombre no casaba, reactivaba productos de baja |
| #24 | `'10 unidad'` (singular) se leía como 1 unidad |
| #25 | Dosis combinadas con guion (`5MG - 10MG`) se descartaban |
| #26 | Importación en paralelo (6 a la vez, caché de dimensiones, ~4 peticiones por producto) con avance "Importando 23 de 78…"; deja de escribir en `legacy_productos`; quita el campo `codigo` inexistente del editor de Unidades de Negocio |
| #27 | Un solo formato de CSV para exportar, plantilla e importar |
| #28 | Selección múltiple (dar de baja, reactivar, eliminar) y aviso de categorías/unidades que no existen |
| #29 | `tipo_mercado` guardado (fase 18) y en los CSV |
| #30 | Rediseño M3 de la tabla: 8 columnas uniformes, acciones fijas a la derecha, barra contextual de selección, buscador grande con atajo `/`, filtros como chips |
| #31 | Ficha lateral del producto, columna PVP, filas por página (10 por defecto), laboratorio único (fase 19) |
| #33 | Formulario rediseñado: secciones, unidad y tipo como chips obligatorios sin valor por defecto, LA SANTE por defecto, listas que muestran todas las opciones (`ComboField`), PVP, validación en línea |
| #36 | Competencia, etapa A: editar/activar un enlace ya no crea competidores nuevos, un 2.º competidor en la misma cadena no pisa al primero, precio manual que sí se guarda (fase 21), filtro de cadena por id, KPI "Enlaces con precio" |
| #35 | Fase 20 (moléculas duplicadas) y comparación de nombres sin tildes al guardar |
| #37 | Competencia, etapa B: misma tabla que Productos (ver "El módulo Competencia") |
| #38 | Fase 22: PVP falsos de competidores y los 20 `COMP_` sin URL |
| #39 | Competencia: columna ID para ordenar por bloques, interruptor $/Bs, CSV con los nombres de Productos |
| #34 | Menús desplegables M3 en toda la app (`components/Select.jsx`, 31 `<select>`), deshacer al eliminar (borrado diferido 8 s), ordenar por columna, filtro de ficha incompleta, enlaces sin precio +7 días, aviso de duplicados, duplicar producto, celda vacía = no cambiar, revisión antes → después, CSV de Excel, deshacer la baja, tarjetas en celular |

### Cómo queda la pantalla

- **Tabla:** Producto (nombre / ID · molécula) · Presentación (dosis /
  empaque) · Línea (unidad / tipo) · Laboratorio (lab / categoría) · PVP
  (propio / competencia más baja, en rojo si el propio es más caro) ·
  Enlaces · Estado · acciones (editar, baja, eliminar) en columna fija.
- **Empaque legible:** `20 tabletas`, `120 ml · Jarabe`, `30 g · Crema`
  (`describirPresentacion` en `Productos.jsx`).
- **Ficha lateral** (`components/FichaProducto.jsx`) al pulsar el nombre:
  PVP vs competencia, datos, enlaces con último precio; botón a
  `ProductDetailModal` para el análisis con gráficos.
- **Selección:** barra contextual en el sitio del buscador. "Dar de baja" es
  un solo `UPDATE` de `activo` y conserva historial; "Eliminar" borra
  también historial y URLs (se desaconseja en el propio diálogo).
- **"Vaciar catálogo"** está en el menú ⋮ de la cabecera.

### El CSV de productos (plantilla = reporte = importación)

```
id_interno, nombre, codigo_barra, principio_activo, concentracion, tamano,
forma_farmaceutica, laboratorio, categoria, unidad_negocio, tipo_mercado,
activo, pvp_propio_usd
```

- **Plantilla de carga** (modal de Carga masiva): todo el catálogo,
  `productos_plantilla_carga_<fecha>.csv`. **Reporte** (botón Exportar): lo
  filtrado en pantalla, `productos_reporte_<fecha>.csv`. Los dos se pueden
  volver a subir tal cual.
- **Celda vacía = no cambiar** (PR #34). Un producto que ya existe se
  actualiza con un `UPDATE` de solo las columnas con valor
  (`dbUpsertProducto` con `parcial` + `existe`). El `nombre` solo es
  obligatorio en productos nuevos, así que `id_interno,pvp_propio_usd` basta
  para actualizar PVP en masa. Un PVP igual al vigente no crea historial.
  Contrapartida: por CSV no se puede *borrar* un valor (vaciar el código de
  barras, p. ej.); eso se hace en el formulario.
- **Revisión previa "antes → después"** por producto
  (`utils/filaProductoCsv.js`: `leerFilaProducto` + `calcularCambios`, que
  usan el importador y la revisión, así leen el archivo igual).
- **Archivos de Excel**: `leerArchivoCsv` prueba UTF-8, si no Windows-1252, y
  repara acentos ya rotos (`SuspensiÃ³n` → `Suspensión`).
- La carga es por `id_interno`: lo que no está en el archivo no se toca. No
  toca `publicaciones` ni `fact_precios`.
- **Varias moléculas:** `Losartán + Hidroclorotiazida` con `50 mg + 12.5 mg`,
  emparejadas por posición. Las dosis también se separan con ` - `. Una
  molécula sin dosis no se guarda (la columna es `NOT NULL > 0`).
- Laboratorio, forma farmacéutica y molécula **se crean solos** si no existen.
  Categoría y unidad de negocio **no**: la revisión previa avisa.

### Piezas compartidas entre Productos y Competencia

Para que las dos pantallas sean iguales salieron de `Productos.jsx`:
`components/FiltroChip.jsx` (chip de filtro con menú M3),
`components/formulario.jsx` (`FormSection`, `Field`, `ChoiceChips`,
`ComboField`, `normalizar`) y `utils/presentacion.js`
(`describirPresentacion`, `enlaceCaido`, `DIAS_ENLACE_CAIDO`). Una pantalla
nueva con tabla debería partir de estas piezas y de las clases `m3-*` de
`index.css`.

### Datos que Hernando tiene pendientes (no son bugs)

- **Código de barras:** hoy tiene el mismo valor que el ID, de relleno. Lo
  cargará más adelante; es opcional.
- **Categorías:** casi todo está en "Otros". No tiene lista todavía; las irá
  creando en Dimensiones.

---

## El módulo Competencia

**Etapa A (#36)**: bugs de datos (editar creaba competidores, precio manual que
no se guardaba, filtro de cadena) y fase 21.

**Etapa B (#37)**: la pantalla copia la estructura de Productos, con los mismos
nombres de campo donde son el mismo dato.

- **Cabecera:** Exportar · Carga masiva · **Vincular enlace** · menú ⋮
  (Ejecutar robot en todos, Vaciar enlaces). Los KPI de antes se cambiaron por
  avisos (`m3-banner`): productos activos sin ningún enlace y enlaces activos
  sin precio hace más de 7 días, cada uno con "Ver cuáles".
- **Barra:** buscador con `/` y contador; chips de Producto, Cadena, Tipo
  (Competidores / Mis productos), Precio (con precio / sin captura / sin
  precio +7 días) y Estado.
- **Tabla** (`m3-table-productos`, mín. 1040 px como Productos): ID (aparte,
  para ordenar: tu producto y sus competidores quedan juntos) · Producto
  (nombre / dosis · empaque) · Competidor (nombre + abrir URL / laboratorio; "Mi producto" si es
  propio) · Cadena (nombre / Propio o Competidor) · Captura (Hoy, Ayer, N días
  / fecha; naranja si pasa de 7 días) · Precio (en $ o en Bs según el
  interruptor de la barra, `competencia.moneda`; el precio normal tachado si
  hay oferta) · Dif. (PVP propio
  frente a ese precio) · Estado · acciones fijas (editar, baja, eliminar).
  Ordenable por columna; sin orden (o por ID), por ID con tu enlace primero y
  luego las cadenas; en cualquier otro orden, los empates siguen ese bloque. 10
  filas por página, ajustable (`competencia.filasPorPagina`). Tarjetas en
  celular.
- **Selección múltiple:** dar de baja / reactivar (con deshacer) y eliminar
  (diferido 8 s, con deshacer).
- **Ficha lateral** (`components/FichaEnlace.jsx`) al pulsar el producto:
  precio en tienda, tu PVP y diferencia; datos; las últimas 15 capturas de
  `fact_precios`; botones Dar de baja, Robot, Precio manual y Editar.
- **Formulario "Vincular enlace"** con las secciones de Productos: producto y
  cadena (chips), enlace (con aviso si el dominio no es el de la cadena) y
  competidor. Rechaza la misma URL dos veces en la misma cadena.
- **CSV:** ver `CARGA_CSV.md`. Mismo archivo para exportar, plantilla e
  importar; un enlace existente (cadena + URL) se actualiza.

**Los 20 competidores `COMP_` sin URL que dejó la fase 21.** El diagnóstico
dio que los 20 tenían PVP (`tiene_pvp`), ninguno era producto propio en una
equivalencia y todos eran competidor en alguna. El PVP venía de la fase 2
($1.00 base). La fase 22 borra el PVP de todos los `COMP_` y repite la
limpieza de la 21.

---

## La recarga del catálogo (aparcada)

**Objetivo:** que dosis, forma y empaque salgan del nombre y vivan en sus
columnas (el hilo de las sesiones anteriores, ver "Por qué" abajo).

**Estado:**
- Parte 1: **78 productos** preparados en `recarga/recarga_parte1_LISTO.csv`
  (genéricos con molécula y marcas sin dosis). Hernando la subió; confirmar
  con la consulta de abajo que entró entera.
- **22 marcas con dosis** esperan que confirme la molécula
  (`recarga/pendientes_marcas.csv`). Propuestas hechas: ESOZ → Esomeprazol,
  DESLER M → Desloratadina + Montelukast, TIOCOLFEN → Ibuprofeno +
  Tiocolchicósido, MONUKAST → Montelukast, GLIMERID → Glimepirida, XEROGRAX →
  Orlistat, TRIPUR → Trimetoprim + Sulfametoxazol, LORACERT → Loratadina +
  Pseudoefedrina. Sin propuesta: BUMETIN RETARD, DAKSOL, LEPRIT, ANALPER
  PLUS, BROXOL AD SIN AZÚCAR, FLUDIL, KLAFENAC RAPILENT, NOGINOX VAG.
- **~145 productos** sin procesar (los que no cupieron en la primera copia).
  Sacarlos con la **plantilla de carga del panel**, no con el SQL Editor
  (que corta en 100 filas).
- **Confirmar con la caja:** LOSARTAN 140463 (14 vs 10), DESLER M 142730 (30
  vs 10), CIPROFLOXACINA 143762 (10 vs 12), MOMETASONA 146166 (18 g vs 140
  dosis), ALBENDAZOL 140226 (¿20 ml?). Y las dosis de CLOTRIM+NEOMIC+DEXAMETA
  (sin dosis no se guarda ninguna de sus 3 moléculas).
- `recarga/preparar.py` rehace los archivos a partir de lo descargado.

**Para saber cuánto falta:**

```sql
SELECT count(*) FROM v_productos_sin_ficha WHERE es_propio;
```

Al empezar la sesión daba 248. Debería bajar a casi cero al terminar.

Sobre `fn_evaluar_calidad_historica`: **no aplicar el criterio de nombre**.
Marcaría 649 capturas buenas. Solo el de precio:
`SELECT jsonb_pretty(fn_evaluar_calidad_historica(TRUE, 0.40, 0));`

### Por qué hacía falta

`fn_evaluar_calidad_historica` marcó 738 capturas sospechosas de 20.153, 649
por nombre. No eran capturas malas: ~16 productos cuyo nombre de catálogo no
se parecía al título de la tienda. La molécula y la dosis nunca llegaban a la
base (se escribían en la vista legacy `productos`), así que el único sitio
donde sobrevivía la dosis era el nombre. La regla que quedó:

```
"ACETAMINOFEN 500 MG TAB X 20"
 ^^^^^^^^^^^^  ^^^^^^  ^^^ ^^^^
 nombre        dosis   forma  empaque
```

El nombre es solo la identidad comercial. En los genéricos sin marca la
molécula sí es el nombre, pero la dosis y el empaque siguen fuera.

---

## Trampas que ya costaron tiempo

No volver a tropezar con estas:

**PostgREST**
- Un `DELETE` sin política RLS devuelve **204 y 0 filas, sin error**. Hay que
  encadenar `.select()` para saber si borró de verdad.
- El `UPDATE` de un upsert se arma con **las claves que recibe**: mandar
  `null` en una columna la borra; omitirla la conserva.
- Todas las FK son `ON DELETE RESTRICT`, así que el orden de borrado importa.

**Postgres**
- El límite de palabra es `\y`, **no `\b`** (que es un retroceso).
- Las alternancias se resuelven por la **primera** que encaja, no por la más
  larga: con `oft` delante de `oftalmica`, `SOLUCIÓN OFTÁLMICA` acaba como
  `SOLUCIÓN ÁLMICA`.
- `regexp_split_to_array` necesita el flag `'i'` explícito.
- `TRIM(TRAILING '.0' FROM ...)` recorta un **conjunto de caracteres**:
  `'300.00'` acaba en `'3'`.
- `CREATE OR REPLACE VIEW` no puede renombrar ni insertar columnas: hace falta
  `DROP VIEW` antes.
- Renombrar una columna **no** renombra la salida de una vista que la expone.
- `pvp_propio` tiene una restricción de exclusión: la fila vigente cubre
  "desde X hasta siempre", así que hay que cerrarla antes de insertar la nueva.

**Entorno de pruebas**
- Crear la base local **con locale UTF-8** (`C.UTF-8`). Sin locale, el plegado
  de mayúsculas de los acentos no funciona igual que en Supabase y los fallos
  se ven donde no son, o peor, quedan tapados.

**Competencia**
- La vista `productos_competencia` arma el `id` como `<publicacion>_<producto
  propio>` (`publicacionIdDe` en dbClient lo descompone). **No es** el id del
  competidor: tratarlo como tal (`COMP_<id>`) creaba un competidor nuevo en
  cada edición. Editar va por `actualizarEnlaceExistente` (publicación + su
  competidor); `guardarEnlaceCompetencia` busca primero por publicación y por
  cadena + URL.
- Los enlaces traen el **id** de la cadena (`Saas`), no su nombre (`Farmacias
  SAAS`): filtros y formularios usan el id y la pantalla muestra el nombre.
- El panel no puede escribir en `fact_precios` (RLS): el precio manual va por
  `fn_registrar_precio_manual`. `historico_precios` es una vista: escribir ahí
  no guarda nada.

**Frontend**
- **Un ancestro con `transform` rompe `position: fixed`**: el hijo queda fijo
  respecto al ancestro, no a la ventana. La página de Productos tiene
  `animate-fade-in-slide` y `.neural-card:hover` hace `translateY(-2px)`.
  Todo lo flotante (modales, side sheets) va con `createPortal` a
  `document.body`, como `ModalWrapper`.
- **`overflow: hidden` rompe `position: sticky`** de los hijos. Para recortar
  esquinas y mantener lo sticky, `overflow: clip`.
- **`getRowValue` acepta subcadenas**: `'activo'` encaja con
  `principio_activo`. Para columnas cortas y ambiguas, búsqueda exacta.
- **`ilike` respeta las tildes**: `Analgésicos` ≠ `Analgesicos`. Por eso
  `resolverDimension` (dbClient) ya no usa `ilike`: lee la tabla entera y
  compara con `claveNombre` (sin mayúsculas, tildes ni signos, y también contra
  `sinonimos`). Así se crearon las moléculas duplicadas que une la fase 20.
- **Regla de escritura: moléculas sin tildes**, como "La Sante" (decisión de
  Hernando: evita diferencias y que Excel rompa las tildes). Las nuevas se
  guardan así (`formatearMolecula` en dbClient = `fn_nombre_molecula`).
- En Tailwind, `bg-x/40` **no funciona** con colores definidos como
  `var(--...)`: no genera nada. Usar `color-mix()` en CSS.

**Herramientas de Hernando**
- El **SQL Editor de Supabase corta en 100 filas** por defecto (desplegable
  junto a Run). Para exportar el catálogo, la plantilla del panel.
- **Excel rompe los acentos** al abrir y guardar un CSV (`Suspensión` →
  `SuspensiÃ³n`), y el importador crearía formas farmacéuticas duplicadas.
  Subir el archivo sin abrirlo en Excel, o guardarlo como CSV UTF-8.

**Probar sin Supabase**
- Para ver una pantalla: un harness temporal con Vite que sustituye
  `../context/DataContext` y `../context/ToastContext` por mocks (alias en un
  `vite.preview.config.mjs` dentro de `web/`; para Competencia también
  `../hooks/useDimensiones`) y Playwright para capturas.
  Borrarlo antes de hacer commit.
- Para el SQL: Postgres 16 local (`/usr/lib/postgresql/16/bin`), con
  `--locale=C.UTF-8`.

---

## Qué falta

**Recarga del catálogo**: ver su sección. Aparcada.

**Funciones del bloque 5** (menú Experimental). Hechas: bandeja de revisión de
capturas y devaluación vs subida real. Faltan:

- Mapa de cobertura
- Precio efectivo de promoción
- Índice de precios por molécula
- Comparador de períodos
- Velocidad de reacción competitiva
- Alertas por correo
- Reporte semanal

**Competencia**: ver la lista de propuestas del 2026-09-25 en el chat (PR #39).

**Limpieza del repo**: mover los `fase*.sql` (ya son 22) a `sql/`, borrar
`debug/`, y borrar `recarga/` cuando termine la recarga.

**Diseño (Material Design 3 Expressive)**: Productos y Competencia ya están al día. En el
resto quedaban 71 colores hex sueltos (sobre todo gradientes y Recharts en
`ProductDetailModal.jsx`), 33 tamaños de texto arbitrarios y 2 `bg-white`
(cifras de antes de esta sesión, sin recontar). Las clases nuevas de
`index.css` (`m3-data-table`, `m3-filter-chip`, `m3-icon-btn`,
`m3-side-sheet`, `m3-banner`…) y las piezas compartidas sirven para llevar el
mismo diseño a Cadenas y Dimensiones.

**Ideas que quedaron sobre la mesa**
- Productos: filtro "más caro que la competencia", historial del PVP en la
  ficha, gestionar enlaces desde la ficha, filtros en la dirección web.
- Siglas de unidad de negocio (`PH`): la tabla no tiene columna `codigo`;
  haría falta SQL.

---

## Documentos del repo

- `DICCIONARIO_CAMPOS.md` — nomenclatura canónica de todos los campos
- `CARGA_CSV.md` — orden de carga y qué va en cada columna
- `ESQUEMA.md` — las tablas y sus relaciones
