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

## Las 19 fases de SQL

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

**Todas corridas en Supabase, de la 1 a la 19.**

---

## ⏭️ DÓNDE ESTAMOS

| | |
|---|---|
| Código en `main` | PR #31, desplegado (GitHub Pages sale solo de `main`) |
| SQL corrido en Supabase | **Hasta la fase 19** |
| Módulo Productos | **Terminado en esta sesión** (ver abajo) |
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
forma_farmaceutica, laboratorio, categoria, unidad_negocio, tipo_mercado, activo
```

- **Plantilla de carga** (modal de Carga masiva): todo el catálogo,
  `productos_plantilla_carga_<fecha>.csv`. **Reporte** (botón Exportar): lo
  filtrado en pantalla, `productos_reporte_<fecha>.csv`. Los dos se pueden
  volver a subir tal cual. Ninguno lleva precio: no tocan el PVP.
- La carga es un **upsert por `id_interno`**: lo que no está en el archivo no
  se toca. No toca `publicaciones` ni `fact_precios`.
- **Varias moléculas:** `Losartán + Hidroclorotiazida` con `50 mg + 12.5 mg`,
  emparejadas por posición. Las dosis también se separan con ` - `. Una
  molécula sin dosis no se guarda (la columna es `NOT NULL > 0`).
- Laboratorio, forma farmacéutica y molécula **se crean solos** si no existen.
  Categoría y unidad de negocio **no**: la revisión previa avisa.

**⚠️ Celda vacía NO siempre es "no cambiar"** (Hernando decidió dejarlo así
por ahora; la plantilla descargada trae todo lleno, así que partir de ella es
seguro):

| Columna vacía | Qué pasa |
|---|---|
| `principio_activo`, `concentracion`, `forma_farmaceutica`, `tipo_mercado`, `activo` | Se conserva |
| `codigo_barra` | Lo borra |
| `laboratorio` | Pasa a LA SANTE |
| `categoria` | Pasa a Otros |
| `unidad_negocio` | Pasa a La Sante |
| `tamano` | Pasa a 1 unidad |

### Datos que Hernando tiene pendientes (no son bugs)

- **Código de barras:** hoy tiene el mismo valor que el ID, de relleno. Lo
  cargará más adelante; es opcional.
- **Categorías:** casi todo está en "Otros". No tiene lista todavía; las irá
  creando en Dimensiones.

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
- **`ilike` respeta las tildes**: `Analgésicos` ≠ `Analgesicos`.
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
  `vite.preview.config.mjs` dentro de `web/`) y Playwright para capturas.
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

**Limpieza del repo**: mover los `fase*.sql` (ya son 19) a `sql/`, borrar
`debug/`, y borrar `recarga/` cuando termine la recarga.

**Diseño (Material Design 3 Expressive)**: Productos ya está al día. En el
resto quedaban 71 colores hex sueltos (sobre todo gradientes y Recharts en
`ProductDetailModal.jsx`), 33 tamaños de texto arbitrarios y 2 `bg-white`
(cifras de antes de esta sesión, sin recontar). Las clases nuevas de
`index.css` (`m3-data-table`, `m3-filter-chip`, `m3-icon-btn`,
`m3-side-sheet`, `m3-banner`…) sirven para llevar el mismo diseño a
Competencia, Cadenas y Dimensiones.

**Ideas que quedaron sobre la mesa**
- Celda vacía = "no cambiar" en todas las columnas del CSV (hoy no; ver la
  tabla de arriba).
- Siglas de unidad de negocio (`PH`): la tabla no tiene columna `codigo`;
  haría falta SQL.

---

## Documentos del repo

- `DICCIONARIO_CAMPOS.md` — nomenclatura canónica de todos los campos
- `CARGA_CSV.md` — orden de carga y qué va en cada columna
- `ESQUEMA.md` — las tablas y sus relaciones
