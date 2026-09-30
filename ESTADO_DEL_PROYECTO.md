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

## Las 28 fases de SQL

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
| 23 | Vista `v_enlaces_fallidos`: lecturas fallidas seguidas por publicación (el panel marca "Revisar URL" desde 3) |
| 24 | Un color único por cadena en `dim_cadenas.color_hex` (marcas conocidas + paleta) e índice único `uq_dim_cadenas_color` |
| 27 | `sinonimos` en laboratorios, categorías, unidades y formas; vista `v_uso_dimensiones`; `fn_unir_dimension` (une dos elementos: mueve los productos y borra el viejo; solo admin) |
| 26 | `dim_cadenas.sigla` (FT, LC, SA… e iniciales para el resto) |
| 28 | `fn_posicion_productos` / `fn_tendencia_posicion` (tu precio vs mínimo y promedio, día a día, en dólares a la tasa de cada día), `fn_cambios_desde` (cambios de precio desde una fecha, en dólares) y `productos_competencia` suma `unidades_empaque` y `unidad_contenido` (conserva sus opciones de seguridad) |
| 25 | **Seguridad:** `usuarios` con RLS (cada quien su fila, el admin todas), políticas abiertas → solo usuarios activos (`fn_usuario_activo`, `fn_es_admin`), sin permisos para `anon`; tabla `accesos`, `fn_registrar_acceso`, `fn_actualizar_mi_cuenta`, `fn_eliminar_usuario` |

**Corridas en Supabase de la 1 a la 28** (la 25 dejó `usuarios` y `accesos`
con RLS y sin permisos públicos). La 28 dio, a la fecha, 140 productos
comparados, mediana +14,78 % (tus precios típicamente sobre el promedio),
34 más baratos y 106 más caros. La 22
dio 0 y 0; la 23, 0 enlaces para revisar. Tras la 21 quedaron **20** competidores `COMP_` sin URL: todos
tenían PVP en `pvp_propio` y la 21 no borra nada con PVP. Ese PVP era el
$1.00 base que la fase 2 le dio a todo lo que parecía propio por laboratorio
o unidad de negocio; un competidor no tiene PVP propio.

---

## ⏭️ DÓNDE ESTAMOS

| | |
|---|---|
| Código en `main` | PR #60, desplegado (GitHub Pages sale solo de `main`) |
| SQL corrido en Supabase | **Hasta la fase 33**. Todos los SQL están en `sql/` |
| Módulo Productos | **Terminado** (ver abajo) |
| Módulo Competencia | **Terminado** (#36 a #41); quedan ideas para luego |
| Módulo Cadenas | Color (#42) y rediseño con sigla, estado del robot, lector y enlaces de otra web (#44, fase 26) |
| Módulo Usuarios | Seguridad, recuperar contraseña, Mi cuenta, accesos, eliminar de verdad y rediseño (#43, fase 25). **Aparcado por Hernando:** Brevo/SMTP y los correos de alertas y resumen |
| Módulo Dimensiones | Rediseño, columna "En uso", **Unir** en vez de borrar lo que está en uso, sinónimos, pestaña Moléculas (#45, fase 27) |
| Dashboard | Rediseño (#46) y, en el #47: tendencia de tu posición, cambios desde tu última visita, meta (promedio ± X %), comparar contra una cadena y vista por molécula (fase 28) |
| Ficha del producto | Rehecha (#47): precios de hoy, indicadores, historia solo de ese producto, modo oscuro |
| Mapa de Calor | Rehecho (#47): productos × cadenas coloreado, y rango de precios |
| Experimental | Sin lo que ya está en el Dashboard (#47): quedan Revisión, Devaluación, Canibalización, Brechas USD y Simulador |
| Rendimiento | #47: una sola carga al entrar (antes dos), sin el histórico completo, copia local para pintar al instante, tasa BCV compartida |
| Recarga del catálogo | **A medias y aparcada por decisión de Hernando** |

Lo siguiente lo decide Hernando. Aparcado: el correo (Brevo/SMTP, sin él
tampoco llegan los de recuperar contraseña a otras personas) y los correos de
alertas y resumen; la recarga del catálogo; el rediseño de Mapa de Calor y
Experimental.

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
| #45 | Dimensiones: rediseño, En uso, Unir (fase 27), sinónimos, Moléculas |
| #44 | Cadenas: rediseño, sigla (fase 26), estado del robot y "Leer esta cadena", lector probado/sin probar, enlaces de otra web |
| #43 | Usuarios: seguridad (fase 25), recuperar contraseña, Mi cuenta, registro de accesos, eliminar de verdad, rediseño |
| #42 | Cadenas: color único por cadena en todo el panel (fase 24); guarda en `dim_cadenas` y muestra los errores |
| #41 | Formulario de enlace: muestra los enlaces que ya tiene el producto y avisa de URL o competidor repetidos antes de guardar |
| #40 | Competencia: URL que fallan (fase 23), posibles duplicados, filtro por laboratorio, robot para los seleccionados con avance, cobertura por cadena; "Vincular enlace" desde la ficha de Productos; columna ID en Productos. El robot ahora sí lee solo los enlaces pedidos |
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

**Funciones del PR #40**
- **Para revisar** (aviso sobre la tabla y chip "Revisar"): URL que fallan
  (`v_enlaces_fallidos`, 3+ lecturas fallidas seguidas; la celda Captura dice
  "Revisar" y la ficha muestra el último error), posibles duplicados (mismo
  producto + cadena + nombre del competidor sin mayúsculas ni signos, o dos
  enlaces propios en una cadena) y sin precio hace +7 días.
- **Filtro Laboratorio**: el laboratorio del competidor.
- **Robot** (`hooks/useRobot.js`): "Leer precios" en la barra de selección, el
  botón de la ficha y "Leer todos los precios" en el menú ⋮ (con
  confirmación y tiempo estimado). Manda `doc_ids` en el `client_payload` del
  `repository_dispatch`; `scraper/farmatodo.py` los lee del archivo del
  evento (`GITHUB_EVENT_PATH`) y solo procesa esos. **Antes el robot ignoraba
  el enlace pedido y leía todos**, por eso el botón de un enlace nunca
  terminaba a tiempo. El avance sale en un aviso azul: estado de la corrida
  en GitHub (si el token puede leer Actions) y tiempo transcurrido frente al
  estimado (4 min de arranque + ~10 s por enlace de Farmatodo, ~5 s en las
  demás). Termina cuando GitHub la da por completada o cuando aparecen en
  `fact_precios` las capturas pedidas. Se guarda en `localStorage`
  (`competencia.robot`), así sobrevive a recargar la página.
- **Cobertura por cadena** (menú ⋮, `components/CoberturaCadenas.jsx`): tabla
  producto × cadena con tu enlace (✓), el número de competidores y un botón
  para vincular tu enlace donde falta (abre el formulario con producto,
  cadena y "Mi producto" ya elegidos).
- **Desde Productos**: la ficha del producto tiene "Vincular enlace", que abre
  Competencia con `?producto=<id>&vincular=1`.
- **Columna ID** también en Productos (ordenable, como número).
- **Formulario "Vincular enlace"** (PR #41): al elegir el producto lista sus
  enlaces actuales (cadena, "Mi producto" o competidor · laboratorio, abrir
  URL) y resalta los de la cadena elegida. Avisa, sin bloquear, si tu
  producto ya tiene enlace en esa cadena, si el competidor ya está (mismo
  nombre sin mayúsculas ni signos) o si la URL ya está vinculada en la cadena
  (la misma regla que al guardar, que sí bloquea).

**Los 20 competidores `COMP_` sin URL que dejó la fase 21.** El diagnóstico
dio que los 20 tenían PVP (`tiene_pvp`), ninguno era producto propio en una
equivalencia y todos eran competidor en alguna. El PVP venía de la fase 2
($1.00 base). La fase 22 borra el PVP de todos los `COMP_` y repite la
limpieza de la 21.

---

## Usuarios y acceso (diagnóstico del 2026-09-25)

**Cómo funciona hoy**
- **Inicio de sesión:** correo y contraseña con Supabase Auth
  (`Login.jsx` → `signInWithPassword`). Después `App.jsx` busca el correo en
  la tabla `usuarios`: si no está o `activo` es falso, cierra la sesión.
- **Roles:** `administrador` (todo) o `consulta` (solo los menús de
  `menus_permitidos`; por defecto Dashboard y Mapa de Calor). El control es
  solo del panel: oculta menús y rutas.
- **Crear usuario:** el administrador pone correo, nombre y contraseña; la
  Edge Function `supabase/functions/crear-usuario` crea la cuenta con la
  service role (confirmada, sin correo) y la fila en `usuarios`.
- **Contraseña:** el botón "Clave" de Usuarios llama a
  `resetPasswordForEmail`. No hay "¿Olvidaste tu contraseña?" en el login ni
  pantalla para escribir la contraseña nueva.
- **Correos y alertas:** `recibe_alertas_inmediatas` y
  `recibe_resumen_diario` son solo casillas guardadas en `usuarios`. **Ningún
  código envía correos**: no hay SMTP, ni función, ni tarea programada.

**Problemas encontrados**
1. **Seguridad (lo más grave).** `supabase_setup_rls.sql` desactiva RLS en
   `usuarios` y `secrets` y da `GRANT ALL` a `anon` sobre `usuarios`. Ninguna
   fase posterior las vuelve a proteger. Si ese script se corrió, cualquiera
   con la clave pública (va dentro del panel) puede leer la tabla `usuarios`,
   hacerse administrador, y leer `secrets` (el token de GitHub). Además, las
   políticas de las tablas de datos permiten todo a cualquier `authenticated`:
   si en Supabase está activo "Allow new users to sign up", cualquiera puede
   crearse una cuenta por la API y leer o cambiar datos sin estar en
   `usuarios`. Un usuario borrado o inactivo conserva su cuenta de Auth y el
   mismo acceso por la API.
2. **Recuperar contraseña no funciona de punta a punta:** sin `redirectTo`,
   sin pantalla de contraseña nueva (el enlace entra directo al panel), y el
   SMTP de Supabase por defecto solo envía a miembros del equipo del proyecto
   y unos pocos correos por hora.
3. **Eliminar usuario** borra la fila de `usuarios` pero no la cuenta de Auth.
4. `dbUpsertUsuario` y `dbDeleteUsuario` esconden los errores: el panel dice
   "guardado" aunque no se haya guardado.
5. Desactivar a alguien no cierra su sesión abierta hasta que recargue.
6. No hay "Mi cuenta" (cambiar la propia contraseña) ni registro de accesos.
7. La lista de menús de Usuarios no incluye Dimensiones.

### Lo hecho en el PR #43 (fase 25)

- **Seguridad:** la consulta de Hernando confirmó `usuarios` sin RLS y con
  lectura y escritura para `anon`. La fase 25 lo cierra (ver la tabla de
  fases). Desactivar a alguien le corta los datos al instante; el panel
  además lo saca en menos de 5 minutos o al volver a la pestaña (`App.jsx`).
  Hernando ya desactivó "Allow new users to sign up" en Supabase.
- **Recuperar contraseña:** "¿Olvidaste tu contraseña?" en el login
  (`resetPasswordForEmail` con `redirectTo` = la dirección del panel) y la
  pantalla `components/NuevaContrasena.jsx`, que App muestra cuando la URL
  trae `type=recovery` o llega el evento `PASSWORD_RECOVERY`.
- **Mi cuenta** (`/mi-cuenta`, al pulsar la tarjeta del usuario en el menú):
  nombre y correos (`fn_actualizar_mi_cuenta`), cambiar contraseña
  (comprueba la actual antes) y últimos accesos.
- **Accesos:** `utils/accesos.js` → `fn_registrar_acceso` al entrar, salir y
  cambiar la contraseña. Usuarios muestra el último acceso de cada uno y la
  ficha lateral los últimos 20.
- **Eliminar de verdad** (`fn_eliminar_usuario`): borra la fila y la cuenta
  de `auth.users`. Nadie puede eliminarse ni quitarse el rol a sí mismo.
- **Rediseño de Usuarios** como Productos: buscador, chips (Rol, Estado,
  Correos), tabla con acciones fijas, ficha lateral, formulario por
  secciones con contraseña inicial generada. Dimensiones ya se puede asignar.
  Piezas comunes en `utils/usuarios.js`. Escrituras con errores visibles
  (`dbGuardarUsuario`, `dbEliminarUsuarioCompleto`).

### Correo (SMTP): lo configura Hernando

El servidor de correo de Supabase por defecto solo envía a los miembros del
proyecto y pocos correos por hora. Para que lleguen los de recuperar
contraseña (y luego las alertas) hace falta un SMTP propio. Se eligió
**Brevo** (gratis, 300 correos al día, no pide dominio propio: basta
verificar el correo remitente). Pasos:
1. Crear cuenta en brevo.com, verificar el remitente y sacar la clave SMTP
   (SMTP & API → SMTP).
2. Supabase → Authentication → Emails → SMTP Settings: host
   `smtp-relay.brevo.com`, puerto `587`, usuario y clave de Brevo, remitente
   verificado.
3. Supabase → Authentication → URL Configuration: Site URL = la dirección
   del panel, y la misma en Redirect URLs.
4. Traducir las plantillas de correo (Authentication → Emails → Templates).

## Cadenas (PR #42 y diagnóstico del 2026-09-25)

- **Color único por cadena** (fase 24): `dim_cadenas.color_hex`, editable en
  el formulario de Cadenas con muestras (las que ya usa otra cadena salen
  bloqueadas) y "otro color". `DataContext` los registra
  (`registrarColoresCadenas` en `utils/brandColors.js`) y `getChainColor`
  los usa primero, así el Dashboard, Análisis, Reportería y el detalle de
  producto pintan cada cadena igual. Antes había tres juegos de colores
  distintos (Locatel era rojo en uno y verde, el color de "mi producto", en
  otro) y el del Dashboard dependía del orden.
- **Arreglos:** Cadenas guardaba en la vista `cadenas` y escondía los
  errores; al editar recalculaba el id desde el nombre ("Farmacias_SAAS" en
  vez de "Saas") y el cambio no se guardaba. Ahora escribe en `dim_cadenas`
  (`dbGuardarCadena`, `dbCambiarActivoCadena`, `dbEliminarCadena`) y avisa
  si algo falla. Eliminar solo se permite sin enlaces. El contador de URL
  buscaba por nombre y SAAS salía con 0.
- **Rediseño (PR #44, fase 26)** con la estructura de Productos:
  - Insignia de cadena (`components/CadenaBadge.jsx`): círculo con su color
    y su **sigla** (`dim_cadenas.sigla`; `siglaCadena` en `brandColors.js`
    con la misma regla del SQL si falta). Sale en Cadenas, en la columna
    Cadena de Competencia, en Cobertura y en las fichas de producto y enlace.
  - **Robot por cadena:** última lectura desde `scrape_runs` (N de M bien,
    cuántas fallaron), historial de las 10 últimas en la ficha y botón "Leer
    esta cadena" (usa `useRobot`; el aviso de avance es
    `components/AvisoRobot.jsx`, compartido con Competencia).
  - **Lector:** "Lector probado" (Farmatodo, Locatel, SAAS: el robot tiene
    reglas propias) o "Sin probar" (lector genérico). `utils/cadenas.js`
    (`LECTORES`, `lectorDe`). El campo `modulo_scraper` no lo usa el robot:
    es informativo.
  - **Enlaces de otra web:** URL cuyo dominio no es el de la web de su
    cadena (`esDeOtraWeb`). Aviso "Para revisar", filtro, lista en la ficha y
    enlace a Competencia con `?cadena=<id>&revisar=otra_web` (nueva opción
    "URL de otra web" del chip Revisar).
  - El nombre de una cadena ya se puede cambiar (el id no cambia).

## Dimensiones (PR #45, fase 27)

**Por qué no se podía eliminar un laboratorio:** tenía permiso, pero la base
no deja borrar algo que usan productos (todas las FK son `ON DELETE
RESTRICT`), y casi todos los laboratorios los usan competidores. La pantalla
solo decía que no se podía. Ahora:
- Columna **En uso** (`v_uso_dimensiones`: productos propios y competidores)
  y aviso de los que no usa nadie (esos sí se eliminan).
- **Unir** (`fn_unir_dimension`, solo admin): los productos del elemento
  pasan a otro y el viejo se borra; su nombre queda en `sinonimos` del que
  queda, así `resolverDimension` (dbClient) lo reconoce en cargas futuras y
  no lo vuelve a crear. En laboratorios también mueve las marcas
  (`dim_marcas`) sin romper el trigger `fn_validar_laboratorio_marca`; en
  moléculas conserva la principal. Eliminar algo en uso abre Unir.
- Pestañas: Laboratorios, Categorías, Unidades de negocio, Formas
  farmacéuticas, **Moléculas** (nueva), Tasas BCV e Historial de PVP (solo
  lectura, con el producto; el PVP se cambia en Productos).
- Formulario por secciones con sinónimos; nombres repetidos (sin mayúsculas
  ni tildes) se rechazan sugiriendo Unir. Las moléculas se guardan sin tildes.
- "Limpiar datos de prueba" pasó al menú ⋮ y pide escribir BORRAR.

## Dashboard (PR #46, sin SQL)

Rehecho de cero en `pages/Dashboard.jsx` con el mismo patrón que las otras
pantallas. De arriba abajo:
- **Encabezado**: "Dashboard", cuándo fue la última lectura del robot (el
  `ultimo_scrape` más reciente de los enlaces), **Exportar** y el menú ⋮
  (solo admin): "Leer todos los precios" (el mismo `useRobot` y aviso que
  Competencia y Cadenas) y "Borrar historial de precios".
- **Una fila de filtros** que aplica a todo: Unidad, Tipo, Categoría. A la
  derecha los ajustes de vista (se recuerdan en el navegador): precio de
  lista u oferta, por empaque o por unidad, periodo de los cambios (24 h / 7
  / 15 días) y el switch $ / Bs.
- **6 indicadores, todos abren su detalle** (`components/DetalleLista.jsx`,
  una lista cuyas filas abren la ficha del producto; al cerrar la ficha se
  vuelve a la lista; "Ver en la tabla" filtra la tabla de abajo):
  Frente al promedio (mediana, para que un producto raro no lo mueva), Eres
  el más barato, **Más caros que el mínimo** (el filtro que pidió Hernando),
  Cambios de precio, Sin comparar (qué le falta a cada uno) y la Tasa BCV en
  pequeño con su tendencia de 30 días (abre su historia y el cambio manual).
- **Gráficos**: "¿Dónde está tu precio?" (divergente, azul más barato, gris
  parejo, rojo más caro; tokens `--md-sys-color-data-div-*` validados para
  daltonismo) y "¿Qué cadena tiene el precio más bajo?" (color de cada
  cadena). Cada barra abre su lista.
- **Tabla "Precios por cadena"**: el precio más bajo de la competencia en cada
  cadena (resaltado el mínimo, con flecha si cambió), Mínimo, Promedio, Tu
  precio (· PVP si sale del PVP y no de un enlace propio), Frente al mínimo y
  Frente al promedio. Ordenable, buscador, filtro "Mostrar", filas por
  página y tarjetas en el móvil.

Cambio de criterio: Mínimo y Promedio son **solo de la competencia** (antes
incluían tu propio enlace, y "frente al mínimo" daba 0 cuando eras el más
barato). Se quitaron el gráfico grande de la tasa, el bloque de paridad
marca/genérico que estaba comentado y el disparo del robot sin seguimiento.

## Dashboard, parte 2 (PR #47, fase 28)

- **Tendencia de tu posición** (`components/dashboard/TendenciaPosicion.jsx`):
  la mediana de "frente al promedio" día a día (30/90/180 días), calculada
  por `fn_tendencia_posicion`. Tocar un día abre cada producto ese día
  (`fn_posicion_productos`). Arrastra el último precio de cada enlace hasta
  7 días si un día no hubo lectura. Sin la fase 28 dice que falta correrla.
- **Desde tu última visita** (`hooks/useCambiosDesdeVisita.js`): la fecha de
  la visita anterior se guarda en el navegador por usuario (una visita nueva
  cuenta tras 30 min) y `fn_cambios_desde` devuelve solo los enlaces que
  cambiaron más de 0,5 % **en dólares**.
- **Meta** (ajuste "Meta: el promedio / X % bajo / X % sobre"): columna
  "Para la meta" (subir o bajar $ para quedar en la meta), filtro "Deben
  bajar / Pueden subir", en el indicador Frente al promedio, en la ficha, en
  la línea de la tendencia y en el CSV.
- **Comparar contra una cadena** (filtro "Competencia"): mínimo, promedio,
  indicadores, tendencia y tabla usan solo esa cadena.
- ~~Por molécula~~: se quitó en el #48 a pedido de Hernando (difícil de
  explicar); se puede recuperar del historial de git (`VistaMolecula.jsx`).
- **Los cambios de precio se miden en dólares** (cada precio a la tasa de su
  día, columnas `tasa_*` de `v_variacion`): la subida del bolívar ya no cuenta
  como cambio. Umbral 0,5 %.
- El cálculo por producto vive en `hooks/useAnalisisPrecios.js` (lo usan
  Dashboard y Mapa de Calor). Unidades del empaque: `unidades_empaque` de la
  vista (fase 28) si es mayor que 1; si no, tu enlace usa las de tu producto
  y el de un competidor las del nombre ("x 20 tabletas") o las tuyas.
- Encabezado: la última corrida completa del robot (todas las cadenas de
  `scrape_runs`: "21 de 24 enlaces leídos · 3 fallaron").

## Ajustes del PR #48 (sin SQL)

- **Dashboard**: filtros **fijos** bajo la barra de la app al bajar
  (`components/FiltrosFijos.jsx`; publica su alto en `--alto-filtros` y el
  buscador de cada tabla se queda debajo; la barra de la app publica
  `--alto-cabecera`; `main` pasó de `overflow-x-auto` a `overflow-x-clip`
  porque lo primero rompía lo "sticky"). Indicadores compactos en una fila
  (`StatCard compacto`). Tendencia 7/15/30/90 días (7 por defecto) en la misma
  fila que los otros dos gráficos. Tabla con presentación bajo el nombre
  (ID · tipo · concentración · empaque), columna **Posición** ("2 de 5": lugar
  de tu precio entre todas las ofertas, 1 = el más barato) y "Mostrar:
  Ocultar sin precio". "Desde tu última visita" aparece también sin cambios y
  usa el ingreso anterior de `accesos` si el navegador no tiene la visita.
  Por unidad los precios llevan 3 decimales. Nombres: "Tú frente al mínimo /
  al promedio" en todas partes.
- **Ficha**: filtros **Relación** (todas / solo tus enlaces / solo
  competencia) y **Cadena**; mínimo, promedio, máximo, gráficos y tabla se
  calculan sobre lo que dejan ver. Barras a columnas, los dos gráficos juntos,
  historia 7/15/30/90/180 (7 por defecto), leyenda con nombre corto y
  laboratorio (detalle al pasar el mouse). Sin columna "por unidad" (lo da el
  ajuste Por empaque / Por unidad).
- **Mapa de Calor**: vuelve el concepto anterior (espectro por producto:
  mínimo, promedio y máximo de la competencia y tu precio) con diseño nuevo:
  franja en tres zonas (barata azul, pareja ±5 % gris, cara roja), filtros
  fijos (incluye "Comparar contra" una cadena), indicadores clicables,
  paginación. El mapa productos × cadenas pasó a **Experimental → Mapa por
  cadena** (`components/MapaPorCadena.jsx`).
- **Competencia**: campo **Unidades por empaque** (y medida: unidades, ml, g)
  en el formulario del competidor y columna `unidades_empaque` en la
  plantilla CSV. Se guarda en `dim_productos.cantidad_contenido` del `COMP_`;
  vacío = se conserva lo guardado. Antes, al crear un competidor sin dato se
  guardaba 1 (sigue así; el panel lee 1 como "no se sabe").
- **Modal Tasa BCV** rehecho (indicadores, historia 7/30/90/todo, cambio a
  mano, tabla y Exportar).
- **Desplegables de filtro con ancho fijo** (`Select`, clases
  `m3-filter-chip` / `m3-rows-select`): miden lo que su opción más larga y no
  empujan a los de al lado al cambiar.

## Agotados, precio mínimo y revisión más clara (PR #75, fase 46)

- **Robot** (`farmatodo.py`): el mensaje de error ya no mezcla «no
  disponible o enlace roto (404 / Agotado)». Agotado = «Producto agotado en
  la tienda» (VTEX sin oferta con precio, WooCommerce sin existencia) o
  «Producto agotado o no disponible en la tienda» (la página lo dice);
  enlace roto = «Enlace roto: …» (HTTP 404, título 404, «No pudimos
  encontrar», VTEX sin el producto). Los dos cortan los reintentos.
- **SQL** `sql/fase46_agotados_y_precio_minimo.sql`:
  - `fn_es_agotado(texto)`: «agotad…» y no «enlace roto». El mensaje viejo
    mezclado NO cuenta como agotado (es ambiguo): los agotados salen desde
    la primera corrida con este robot.
  - `v_enlaces_fallidos`: una lectura agotado cuenta como buena (la página
    funciona), así un agotado no se marca «Revisar URL».
  - `v_disponibilidad`: por enlace activo, `agotado` (su última lectura con
    existencia conocida, desde cuándo) o `volvio` (hay de nuevo, desde hace
    menos de 7 días). Las lecturas que fallaron por otra cosa se saltan.
  - `precio_minimo` (producto_id PK, minimo_usd, actualizado, actualizado_por;
    leer/crear/cambiar usuario activo, borrar admin; «quitar» = dejarlo
    vacío) y `v_precio_minimo_alertas`: tus enlaces (tu producto en una
    cadena) cuyo precio de venta (oferta si hay, si no lista, a la tasa del
    día, sin lecturas dudosas) quedó < mínimo − 0,5 % en la última lectura,
    y desde cuándo. Independiente del PVP.
- **Experimental → Agotados** (`components/analisis/Agotados.jsx`): tus
  productos agotados, oportunidades (competidor agotado en una cadena donde
  tu producto tiene precio), competidores agotados y los que volvieron;
  agrupado por tu producto.
- **Experimental → Precio mínimo** (`components/analisis/PrecioMinimo.jsx`):
  alertas arriba; abajo cada producto con «Hoy lo más bajo» y el campo del
  mínimo (Enter guarda, vacío = no vigilar); Exportar / Cargar CSV
  (`id_interno`, `precio_minimo_usd`; celda vacía = no cambiar). En modo solo
  lectura se ve el valor (clase `solo-en-lectura`).
- **Revisión de capturas**: cada captura muestra tres filas alineadas
  (`Comparacion`): **Tu producto** (nombre · concentración · empaque ·
  laboratorio · ID, de `productos`), **Competidor** (nombre · laboratorio ·
  presentación registrada) o «Tu enlace», y **La tienda muestra** (nombre
  leído · presentación leída · % de parecido; en rojo lo que no coincide).
  Debajo, «Por qué está aquí» con los números y el umbral de
  `config_calidad` (`porQue`).
- Probado: fase 46 en Postgres local (agotado, volvió, timeout sigue en
  fallidos, alertas de mínimo con «desde»); las pestañas nuevas y la
  revisión con datos simulados, sin errores.

## Menús renombrados, tu posición por cadena y competidores sin unidad (PR #75, fase 45)

- **Nombres** (las rutas no cambian, así `menus_permitidos` sigue valiendo):
  - «Mapa de Calor» (`/mapa-calor`) → **Rango de precios**, icono
    `linear_scale`: es la franja mínimo–promedio–máximo por producto.
  - «Competencia» (`/competencia`) → **Relación**. El chip que se llamaba
    «Relación» (mis productos / competidores) pasa a «De quién es el
    enlace», y el chip Cadena va primero.
  - El mapa productos × cadenas de Experimental («Mapa por cadena») →
    **Mapa de calor**, que es lo que es.
- **Dashboard**: sin el indicador «Más caros que el mínimo», su lista ni la
  opción del filtro «Mostrar» (Hernando no se mide contra el mínimo); quedan
  5 indicadores. La **Tendencia de tu posición** pasó a Experimental →
  «Tendencia de tu posición» (`components/analisis/TendenciaExperimental.jsx`,
  reusa `TendenciaPosicion`; tocar un día lista cada producto debajo).
- **Cadenas**: la columna Robot ya no dice «Lector probado / Sin probar»
  según una lista fija (`LECTORES.probado`, borrado): dice cómo le fue a la
  cadena en su última lectura (`estadoRobot` en `pages/Cadenas.jsx`: «Lee
  bien» 80 %+ con precio, «Lee con fallas», «No leyó precios», «Sin
  lecturas»); filtro y ficha igual. El Lector del formulario es informativo.
- **Dimensiones → Unidades de negocio**: solo La Sante contaba productos de
  la competencia porque la fase 2 le puso `unidad_negocio_id` = La Sante a
  todos los competidores migrados (los creados desde el panel nacen sin
  unidad). La fase 45 se la quita a todo `COMP_`: la unidad de negocio es
  solo tuya.
- **Experimental → «Tu posición por cadena»**
  (`components/analisis/PosicionPorCadena.jsx`): dentro de CADA cadena, tu
  enlace frente a los competidores de esa misma cadena. Más barato = tu
  precio ≤ el más barato + 0,5 %; más caro = tu precio > el más caro +
  0,5 %; en medio = el resto. Hoy (tarjeta por cadena con barra y los tres
  números, que abren la lista de productos) con `useAnalisisPrecios`, y día a
  día con `fn_posicion_por_cadena(p_dias, p_con_descuento, p_por_unidad)`
  (fase 45: mismo criterio de precios que `fn_posicion_productos`, sin
  lecturas marcadas dudosas): una línea por cadena, «más caro» o «más
  barato», en cantidad o %.
- Probado en Postgres local: la fase 45 deja 0 competidores con unidad y no
  toca la unidad de los productos propios; `fn_posicion_por_cadena(30)` ≈ 1 s
  con 90 mil lecturas.

## Precios repetidos (PR #73, fase 44)

- Síntoma: en Farmabien varios productos distintos quedaban con el MISMO
  precio al centavo. El robot de precios, en tiendas sin vía rápida, tomaba
  el primer precio en Bs de una zona demasiado amplia (`main`/`body`): un
  monto que se repite en todas las páginas.
- **Robot** (`farmatodo.py`): la zona del precio en Bs (`dom_bs`) es ahora el
  bloque que contiene el título (h1) y un precio; si no hay, los selectores
  de ficha, y nunca `main`/`body`. Si la página ya daba precio en USD
  (JSON-LD/meta), el de Bs tiene que cuadrar con la tasa (±25 %) o manda el
  de USD (`bcv_rate` pasa al `evaluate`). Al final de cada corrida,
  `marcar_precios_repetidos`: 3+ enlaces distintos de la misma tienda (no
  Farmatodo) con el mismo precio y nombres distintos → `sospecha =
  'precio_repetido'`; `push_to_supabase` los guarda con `sospechoso` y ese
  motivo (sin la fase 44 reintenta con `variacion_precio`).
- **SQL** `sql/fase44_precios_repetidos.sql`: motivo `precio_repetido` en el
  CHECK; vista `v_precios_repetidos` (última lectura por enlace en 3 días,
  agrupada por cadena y precio exacto; grupos de 2+ enlaces de 2+ productos
  distintos; salen los ya revisados).
- **Panel**: Revisión de capturas → cuarta vista "Precios repetidos"
  (`components/revision/PreciosRepetidos.jsx`): grupos por cadena y precio,
  abrir cada enlace, Corregir enlace, Volver a leer, "Son erróneas"
  (`sospechoso`, `revisado_manual`, motivo) o "Son correctos"
  (`revisado_manual`: el grupo no vuelve a salir). Motivo "Precio repetido"
  en la lista de pendientes.

## Guardado roto por "precio repetido" (PR #74, sin SQL)

- Síntoma (corrida 36582439205, 1468 enlaces): `push_to_supabase` falló con
  `400 PGRST102 "All object keys must match"` y no guardó los precios de la
  corrida (solo los lotes de 100 anteriores al primero con un precio
  repetido).
- Causa: el #73 añadía `sospechoso` y `motivo_sospecha` SOLO a las filas con
  precio repetido. PostgREST exige que todas las filas de un insert en lote
  traigan las mismas columnas.
- Arreglo: las dos columnas van en todas las filas (`False` / `None`, los
  valores por defecto; el trigger de calidad sigue marcando las demás). El
  reintento sin fase 44 se conserva.
- **Regla para el futuro:** toda columna nueva de `fact_records` va en todas
  las filas, con su valor por defecto cuando no aplica.
- Además: el #73 se subió por la API de GitHub y cambió el escape `' '`
  de `parse_price` por el carácter literal (mismo efecto); vuelve al escape.

## El PVP no entra en ningún cálculo (PR #72, fase 43)

- Regla de Hernando: el PVP es un precio para otro cliente; solo sale en
  Productos y en los reportes. "Tu precio" es SOLO el de tus enlaces en las
  cadenas; sin enlace leído el producto queda sin tu precio (cae en "Sin
  comparar" y no cuenta en promedios, posiciones ni medianas).
- Quitado el respaldo al PVP en: `useAnalisisPrecios` (Dashboard, Mapa de
  Calor), `ProductDetailModal` (ficha), `BrechaHistoricaUsd` y
  `CanibalizacionInterna` (solo precios de anaquel; sin ellos no evalúa).
- `sql/fase43_sin_pvp_en_calculos.sql`: `fn_posicion_productos` sin el
  paso `con_pvp` (misma firma que la fase 31); arrastra a
  `fn_tendencia_posicion`, `fn_comparar_periodos` y `fn_indice_molecula`.

## Tabla usuarios completa (PR #71, fase 42)

- La tabla `usuarios` del proyecto viene de la migración de Firebase
  (`id`, `_doc_id`, `email`, `nombre`, `rol`, `recibe_*`, `activo`) y no
  tenía `menus_permitidos`: "Nuevo usuario" fallaba con `column
  "menus_permitidos" of relation "usuarios" does not exist` y los menús de
  los usuarios de consulta nunca se guardaban (el panel usaba los de
  siempre).
- `sql/fase42_usuarios_columnas.sql`: agrega las columnas que el panel usa
  si faltan (`menus_permitidos TEXT[]`, etc.); a los de consulta sin menús
  les pone Dashboard y Mapa de Calor (lo que ya veían); `fn_crear_usuario`
  inserta solo en las columnas que existan (incluye `_doc_id`), con
  `jsonb_populate_record` para los tipos. Probado con una tabla igual a la
  de Firebase: reproduce el error antes y crea el usuario después.

## Permisos de usuarios (PR #70, fase 41)

- **Consulta no borra** (regla de Hernando: puede crear y editar, nunca
  borrar). En la base: toda política DELETE de `public` (salvo usuarios,
  accesos y `producto_principios`, que se borra y se reescribe al editar un
  producto) exige `fn_es_admin()`; las políticas `ALL` se separan en leer /
  crear / cambiar (igual que antes) y borrar (admin). En el panel: los
  botones que borran llevan `data-borra` y se ocultan (`body.sin-borrar`).
- **Solo lectura por menú** (`usuarios.menus_solo_lectura`): los botones de
  crear/editar llevan `data-edita`; `Layout` pone `body.solo-lectura` según
  el menú abierto (`utils/permisos.js`) y un aviso. Es del panel (la base no
  distingue menús).
- **Acceso hasta** (`usuarios.vence_el`): vencido = inactivo en
  `fn_usuario_activo`/`fn_es_admin` y en `App` (mensaje "Tu acceso venció").
- **Ver solo su línea** (`usuarios.alcance` = {laboratorios,
  unidades_negocio, categorias}, por nombre): `DataProvider` filtra
  productos y todo lo que cuelga de ellos por `id_producto_propio` (Dashboard,
  Mapa, Productos, Competencia). Los análisis por RPC de Experimental no se
  filtran (se avisa en el formulario).
- **Contraseña sin correo**: `fn_admin_cambiar_clave(email, clave)` (admin,
  no a sí mismo); botón del candado → "Poner contraseña" o "Enviar enlace".
- **Mensaje listo para enviar** al crear o poner contraseña: copiar,
  WhatsApp (`wa.me`) o correo (`mailto`).
- **Cambio obligatorio en el primer ingreso** (`usuarios.debe_cambiar_clave`):
  lo pone un trigger al crear la fila y `fn_admin_cambiar_clave`; `App`
  muestra `NuevaContrasena` (obligatoria, "Salir" cierra sesión);
  `fn_registrar_acceso('clave_cambiada')` lo quita.
- **Sin entrar 30+ días**: aviso arriba, filtro de estado y marca en "Último
  acceso"; filtro "Acceso vencido". Etiquetas por usuario (vence, solo ver,
  su línea, cambia clave).

## Crear usuarios sin Edge Function (PR #69, fase 40)

- "Nuevo usuario" daba "Failed to send a request to the Edge Function": la
  función `crear-usuario` (supabase/functions) nunca se desplegó.
- `sql/fase40_crear_usuario.sql`: `fn_crear_usuario(email, clave, nombre,
  rol, menus, alertas, resumen, activo)`, SECURITY DEFINER como
  `fn_eliminar_usuario`; solo un administrador activo (`fn_es_admin`,
  NULL = no). Crea `auth.users` (correo confirmado, clave con
  `crypt(..., gen_salt('bf'))`, tokens en '' para que GoTrue no falle) y
  `auth.identities` (provider email, provider_id = id), y la fila en
  `usuarios` vía `jsonb_populate_record` (se adapta a los tipos reales de la
  tabla). Si la cuenta de acceso ya existía sin fila en usuarios, le pone la
  clave nueva y crea la fila. Todo o nada.
- `Usuarios.jsx`: llama primero al RPC; sin la fase 40 prueba la Edge
  Function y, si tampoco está, pide correr la fase 40.
- Probado en Postgres local con tablas `auth` simuladas (columnas de GoTrue).

## Buscador: señal de vida, Detener sin permiso de Actions y web de FarmaGo (PR #68, fase 39)

- `corridas_buscador.latido`: el robot lo actualiza cada 30 s en una hebra
  aparte y en la misma vuelta lee el estado de su corrida; si el panel la
  marcó `cancelada`, sale (`os._exit`). Así "Detener" funciona aunque el
  token de GitHub no tenga permiso de Actions (igual intenta cancelar en
  GitHub si puede).
- El panel da por muerta una corrida sin latido en 5 minutos (las viejas sin
  latido: más de 3 h) y la marca `interrumpida`; los botones de buscar se
  habilitan.
- `sql/fase39_latido_farmago.sql`: agrega `latido`, cierra las corridas que
  quedaron "corriendo" sin latido y corrige la web de FarmaGo
  (`https://www.farmago.com.ve`, estaba farmago.com) borrando su plataforma
  para que se vuelva a detectar (es Odoo: `/shop?search=`).

## Buscador: detener, reemplazar sugerencias y dirección manual (PR #67, fase 38)

- **Cancelar**: el robot atrapa la señal de GitHub (SIGINT/SIGTERM), marca la
  corrida `cancelada` y sale; al arrancar, las corridas viejas que quedaron
  `corriendo` pasan a `interrumpida`. El panel también las cierra: consulta
  la corrida en la API de GitHub (`/actions/runs/<id>`) y, si terminó y la
  fila sigue "corriendo", la marca cancelada/interrumpida; más de 3 h =
  interrumpida. Botón **Detener** (`POST .../cancel`; si el token no tiene
  permiso de Actions, avisa y remite a GitHub). `sql/fase38_corridas_buscador.sql`
  da permiso al panel de cambiar `estado` y `fin`.
- **"Buscar todo de nuevo" reemplaza**: busca primero los pares con
  sugerencia pendiente; lo encontrado actualiza precio y puntaje (upsert) y
  las pendientes de ese par que ya no aparecen se BORRAN (aceptadas y
  descartadas no se tocan). Pide confirmación. La lista se recarga cada
  minuto mientras avanza.
- **Tiendas difíciles (FarmaGo)**: más direcciones de búsqueda probadas
  (Odoo `/shop?search=`, `/tienda?s=`, `/search/<q>`, `/?q=`...); en modo
  campo también se leen los productos del desplegable al escribir; si no
  encuentra nada guarda `diagnostico` (url, título, enlaces, campos,
  muestras) que se ve al pasar el mouse. **Dirección a mano**: tocar la
  tienda en el panel permite pegar la página de resultados de "losartan";
  queda `plataforma = navegador`, `modo = url`, `manual = true` y el robot no
  la vuelve a detectar.

## Precios en Bs en todas las cadenas y tamaño "120ML" (PR #66, fase 37)

- **Buscador** (`buscar_enlaces.py`):
  - precio de cada resultado: se sube desde el enlace hasta el primer
    contenedor con un precio (sin llegar a la grilla); la moneda tiene que
    estar en la misma línea ("X 20" + salto + "Bs.S 8.737" ya no da 20); si la
    tarjeta tiene Bs y $ ref, manda Bs;
  - todo precio en dólares (VTEX de SAAS, WooCommerce, "$ ref") se guarda en
    Bs con la última tasa de `dim_tasa_bcv`;
  - moneda VTEX: más formas de leerla (meta en cualquier orden, JSON) y se
    calcula en la primera búsqueda si faltaba;
  - "Buscar todo de nuevo" (FORZAR) rebusca también lo que tiene sugerencia
    pendiente, para actualizar su precio y puntaje.
- **Tamaño sin "x"** ("180MG/5ML 120ML"): el último "N ml" que no sea el
  "/5ml" de la concentración (mayor que 5). En Python y en SQL
  (`sql/fase37_presentacion_ml.sql`, redefine `fn_leer_presentacion`).
- **Robot de precios** (`farmatodo.py`), otras tiendas: si lo leído está en
  dólares o no se leyó nada, manda el precio en Bs visible de la ficha
  (método `dom_bs`): elementos con un solo precio en Bs (fuera de
  carruseles), tachado = precio normal (del, s, clases old/regular/
  default_price, line-through) y el otro = oferta. Probado con páginas tipo
  Odoo (Farmatina), Farmabien y WooCommerce.

## Buscador y precios en todas las cadenas (PR #65, sin SQL)

- **Buscador con navegador** (`buscar_enlaces.py`, plataforma `navegador`):
  para las tiendas sin buscador público (Farmatodo, Farmabien, Farmago,
  Farmatina según la primera corrida):
  - aprende cómo busca la tienda: prueba direcciones de búsqueda conocidas
    (`/?s=`, `/search?q=`, `/buscar?q=`, `/catalogsearch/result/?q=`...)
    comprobando que los resultados cambien con lo buscado (no la portada);
    si no, escribe en su campo "Buscar" y pulsa Enter; lo aprendido queda en
    `plataforma_detalle` (`modo` url con `busqueda_url`, o campo con
    `selector`);
  - toma de la página de resultados los enlaces de la misma tienda con un
    nombre legible (fuera de menú y pie) y el precio de su tarjeta;
  - una instancia de Playwright por hebra; máx. 2 consultas por producto;
    las cadenas "sin_buscador" se vuelven a probar en cada corrida;
  - el workflow instala Playwright y Chromium (tiempo máximo 150 min).
- **Robot de precios** (`farmatodo.py`) para cadenas nuevas:
  - `cargar_plataformas()`: suma a la vía rápida las cadenas que el buscador
    marcó como VTEX o WooCommerce (`dim_cadenas.plataforma`);
  - vía rápida WooCommerce (`leer_woo`, Store API por slug): precio normal,
    oferta, moneda (USD → Bs con la tasa) y agotado; método `woo_api`;
  - página: JSON-LD dentro de `@graph`, `@type` en lista y
    `priceSpecification`; luego metadatos (`product:price:amount`,
    `itemprop=price`, método `meta`); por último, el primer precio visible
    de la ficha, con tachado/nuevo como oferta (método `dom_generico`).

## Sugerencias de enlaces: robot buscador (PR #64, fase 36, beta)

- **Qué hace**: busca los productos de Competencia (tuyos y de la
  competencia, con al menos un enlace activo) en las cadenas donde aún no
  tienen enlace, y deja SUGERENCIAS. Nada se vuelve enlace hasta aceptarlo.
- **Robot** `scraper/buscar_enlaces.py` (solo librería estándar, sin
  navegador), workflow `.github/workflows/buscar-enlaces.yml`
  (`repository_dispatch` tipo `buscar-enlaces` desde el panel, o "Run
  workflow" en GitHub con `forzar`):
  - detecta la plataforma de cada cadena y la guarda en
    `dim_cadenas.plataforma` (vtex, woocommerce, shopify, magento o
    sin_buscador con las "huellas" vistas en su web); se revisa cada 30 días;
  - consultas: nombre base + dosis + laboratorio, luego sin laboratorio, luego
    principio activo (máx. 3; para en cuanto hay un candidato de 90+);
  - puntaje: laboratorio 40 (20 si no se puede saber), dosis 30, tamaño 30
    (10 si falta el dato); dosis o tamaño distintos descartan; se sugiere
    desde 70, hasta 3 por producto y cadena; el nombre tiene que compartir
    alguna palabra con el producto o su principio activo;
  - no repite un par producto/cadena antes de 7 días ni si ya tiene una
    sugerencia pendiente (salvo `FORZAR=1`); una hebra por cadena, 0,8 s
    entre consultas a la misma tienda;
  - `leer_presentacion` = misma regla que `fn_leer_presentacion`.
- **SQL** `sql/fase36_sugerencias_enlaces.sql`:
  - columnas `plataforma`, `plataforma_detalle`, `plataforma_revisada` en
    `dim_cadenas`; cadenas nuevas Farmadon, Farmago, Farmabien y Farmatina
    (sin color; sigla FD/FG/FB/FN) y web de Farmatodo, Locatel y SAAS si
    faltaba;
  - tablas `sugerencias_enlaces` (pendiente / aceptada / descartada),
    `busquedas_enlaces` (última búsqueda por par) y `corridas_buscador`
    (avance y resumen);
  - vistas `v_buscar_enlaces` y `v_sugerencias_enlaces`;
  - `fn_aceptar_sugerencia(id)`: crea la publicación (activa) del mismo
    producto en esa cadena, rechaza una URL ya vinculada a otro producto y
    descarta las otras pendientes del par;
  - `fn_leer_presentacion` ajustada: "400mgx20" lee la dosis y la "x" de un
    nombre ("Dolex 500 x 10") ya no se toma como tamaño;
  - al final, bloque DESHACER comentado.
- **Pantalla** Experimental → "Sugerencias de enlaces"
  (`components/SugerenciasEnlaces.jsx`): tiendas con su plataforma,
  "Buscar enlaces" / "Buscar todo de nuevo", avance de la corrida,
  sugerencias agrupadas por producto con puntaje y lo que coincidió
  (laboratorio, dosis, tamaño), Aceptar / Descartar / Volver a revisar.
- **Pendiente de ver en la primera corrida real**: qué plataforma tiene cada
  cadena nueva (desde este entorno no se llega a las tiendas) y si el robot
  de precios lee bien las páginas de las cadenas nuevas.

## Revisión de capturas: dosis y tamaño, sensibilidad, lote y releer (PR #63, fase 35)

- **Arreglo "Corregir enlace"**: Competencia volvía a la bandeja en el mismo
  render en que abría el formulario (el efecto de "volver" veía `editing`
  todavía en null). Ahora vuelve solo cuando `editing` pasa de un id a null.
- **SQL** `sql/fase35_calidad_presentacion.sql`:
  - `fn_leer_presentacion(texto)`: dosis en mg y tamaño (unidades, ml o g)
    de un nombre; `fn_presentacion_registrada(producto)`: concentración
    principal (mg/mcg/g) y `cantidad_contenido`; `fn_presentacion_distinta`
    compara solo lo que hay en los dos lados;
  - el trigger `fn_control_calidad_precio` marca con motivo nuevo
    `presentacion` (CHECK ampliado); con más de un motivo, `ambos` ("Varios
    motivos"); se apaga con `config_calidad.validar_presentacion = 0`;
  - `fn_probar_sensibilidad(variacion, similitud, presentacion, dias,
    aplicar)`: cuántas capturas del robot se marcarían; con aplicar marca las
    nuevas (nunca desmarca ni toca las revisadas);
  - `v_capturas_revision` suma `leida_*` / `registrada_*` e `historial`
    (8 lecturas antes y 4 después, jsonb `{f, p, s, a}`);
  - índice parcial `idx_fact_precios_pendientes` para el contador.
- **Pantalla**:
  - casillas y barra de selección: "Son válidas / Son erróneas / Volver a
    revisar / Volver a leer" en lote; "N de este enlace" selecciona las del
    mismo enlace;
  - "Volver a leer" (icono sync): lanza el robot (`useRobot`) para esos
    enlaces y recarga al terminar;
  - "Sensibilidad" (`components/revision/Sensibilidad.jsx`): deslizadores de
    salto de precio y parecido del nombre, interruptor de dosis y tamaño,
    "Probar" con 7/30/90 días, "Guardar" y "Guardar y marcar N";
  - mini historial (línea con el punto de la captura y las marcadas en rojo)
    y pista de presentación ("La tienda muestra x 30 y el producto está
    registrado como x 10");
  - contador rojo de pendientes en el menú (Experimental, con punto si el
    menú está plegado y en la barra del móvil) y en la pestaña
    (`hooks/usePendientesRevision.js`; se recuenta cada 5 min y con
    `avisarCambioRevision()`).

## Revisión de capturas: corregir enlace y volver a revisar (PR #62, fase 34)

- **SQL** `sql/fase34_revision_capturas.sql` (solo vistas, no cambia datos):
  - `v_capturas_revision`: pendientes y ya revisadas, con `estado_revision`
    (pendiente / valida / erronea), la lectura anterior buena y la SIGUIENTE
    del mismo enlace, el producto propio con el que se compara y cuántas
    capturas pendientes tiene ese enlace;
  - revisada por la bandeja = `revisado_manual` con `motivo_sospecha`; los
    precios cargados a mano (también `revisado_manual`) no entran;
  - `v_calidad_datos`: `revisadas` ya no cuenta los precios manuales y suma
    `validas` al final.
- **Pantalla** (`RevisionCapturas.jsx`):
  - Pendientes / Válidas / Erróneas (segmentado); en Válidas y Erróneas,
    "Volver a revisar" la regresa a pendientes; toda decisión tiene
    "Deshacer" en el aviso;
  - "Corregir enlace" abre `/competencia?editar=<publicacion>&volver=revision`:
    Competencia abre el formulario de ese enlace y al cerrarlo vuelve a la
    bandeja;
  - pista por captura a partir de la lectura siguiente (±5 %): si vuelve al
    precio anterior, "parece un error de lectura"; si lo repite, "cambio
    real";
  - filtros Motivo, Cadena y Relación en `BarraFiltros`, buscador y
    "Mostrar más" (30 por página);
  - sin la fase 34 se ven solo las pendientes (de `v_capturas_sospechosas`)
    con un aviso.

## Mínimo del mercado y extremos por cadena (PR #61, sin SQL)

- **Mínimo del mercado** (`useAnalisisPrecios`):
  - `minimo` cuenta tu precio, como el promedio; `minimoComp` es el de la
    competencia sola;
  - sin competencia, mínimo y promedio son tu precio, y las diferencias y la
    meta muestran "—";
  - las columnas por cadena del Dashboard incluyen tu enlace en esa cadena
    (marcado "Tú"); si el más barato eres tú, el Mínimo también dice "Tú";
  - "Tu diferencia vs mín." es 0 % si el más barato eres tú; el detalle de
    "Eres el más barato" muestra cuánto más barato eres que la competencia;
  - el gráfico "¿Qué cadena tiene el precio más bajo?" sigue siendo solo de
    competencia.
- **Ficha, tabla Ofertas**:
  - el precio más bajo y el más alto de cada cadena, en color y con etiqueta
    ("Más bajo" / "Más alto"), cuando la cadena tiene al menos dos precios;
  - tu producto con nombre completo: nombre + concentración + unidades, como
    los competidores.

## Robot para Locatel y SAAS, fichas incompletas y "Relación" (PR #60, sin SQL)

- **Robot, tiendas VTEX** (Locatel y Farmacia SAAS, `es_vtex` / `leer_vtex`
  en `scraper/farmatodo.py`):
  - se leen por la API pública del catálogo
    (`/api/catalog_system/pub/products/search/<slug>/p`): precio de venta,
    precio de lista (oferta si es mayor) y existencia, sin abrir la página;
  - la moneda de la tienda se lee una vez por corrida (meta
    `product:price:currency`): Locatel publica en VES y SAAS en USD (Ref.).
    Todo se guarda en Bs; si la tienda publica en $ se pasa con la tasa BCV
    del día, que es la que usa SAAS para mostrar sus Bs (966,90 = 1,13 ×
    855,66);
  - si la API falla, se usa la página como antes (JSON-LD);
  - agotado o sin precio = error "no disponible";
  - la espera entre consultas a esas tiendas bajó de 2 s a 1 s.
- **Tasa BCV** (`scraper/update_bcv.py`):
  - si la de hoy (fecha de Caracas) ya está en `dim_tasa_bcv`, no se busca en
    internet ni se escribe nada;
  - ya no se inserta en `bcv_rates` (vista de `dim_tasa_bcv`: ese insert era
    el error 409) ni en Firestore;
  - no ocupaba espacio: siempre fue una fila por día.
- **Productos**: aviso "N productos activos tienen la ficha incompleta"
  (molécula, dosis, forma, tamaño, laboratorio o PVP; `camposFaltantes`) con
  "Ver cuáles" → filtro Ficha: incompletas. Los enlaces tienen su propio
  aviso.
- **Ficha del producto, tabla Ofertas**: Cadena va primero; se ordena por
  cadena, tu enlace primero en cada una y luego de mayor a menor precio.
- **"Relación" en todas partes**: el filtro de Competencia y el de la ficha
  dicen "Relación: todas / Mis productos / Competidores"; el campo del
  formulario se llama "Relación"; la columna de la plantilla pasa de `tipo` a
  `relacion` (se sigue aceptando `tipo`, buscado exacto para no confundirlo
  con `tipo_mercado`).

## Carga masiva rápida, marca/genérico en la revisión y robot para otras cadenas (PR #59, sin SQL)

- **Carga masiva de Competencia**: 497 filas eran unas 5.000 consultas una
  tras otra, sin avisar nada. Ahora:
  - se saltan las filas que no cambian nada (`sinCambios`);
  - se guardan 6 a la vez;
  - laboratorios, cadenas y moléculas se buscan una sola vez (`cache` en
    `guardarEnlaceCompetencia`);
  - `ImportPreview` muestra una barra de avance ("Guardando 120 de 497").
- **Revisar "Dosis, tamaño o tipo distinto al tuyo"**: suma marca contra
  genérico (el `tipo_mercado` de tu producto frente al del competidor). La
  etiqueta de la fila junta los motivos ("Otra dosis · Es marca").
- **Robot, otras cadenas** (`scraper/farmatodo.py`):
  - fuera de Farmatodo el precio sale de los datos estructurados (JSON-LD) y
    de las llamadas internas de la tienda;
  - ahora lee `priceCurrency` (si viene en USD se pasa a Bs con la tasa del
    día) y `lowPrice` de AggregateOffer (sin tomar el rango como descuento);
  - **modo diagnóstico**: con ≤ 10 enlaces y alguno que no sea de Farmatodo
    (o `TRACKFLOW_DIAGNOSTICO=1`), el log de Actions escribe por página el
    título, el h1, el JSON-LD, las meta de precio, los precios visibles y las
    llamadas JSON de la tienda. Sirve para ajustar Locatel y SAAS con datos
    reales (desde este entorno no se puede entrar a esas páginas).

## Competidor por campos, duplicados y mercados mal armados (PR #58, fase 33)

- **Misma barra de filtros en todos los menús**:
  - Competencia, Productos, Cadenas, Usuarios y Dimensiones usan
    `BarraFiltros` en su variante `integrada` (dentro de la tabla, sin
    borde), con "Filtrar" y "Limpiar" en su sitio fijo;
  - el $/Bs de Competencia pasa a segmentado;
  - los switches que quedan (activo, correos, "solo huecos") son de
    encender/apagar, que es su uso en M3.
- **Competidor por campos** (como un producto propio): nombre corto,
  concentración, laboratorio, unidades + medida y tipo.
  - La concentración se guarda en `producto_principios`, con la molécula del
    producto propio (`guardarConcentracionCompetidor` en dbClient).
  - **Fase 33**:
    - llena la concentración y las unidades que falten, leyéndolas del
      nombre;
    - la vista agrega `nombre_competidor` y `concentracion`, y arma `marca` =
      nombre + concentración + "x" unidades. Si el nombre ya trae números se
      deja igual, para no repetir. No cambia nombres: acortarlos lo hace
      Hernando.
  - El formulario muestra "Se verá como: …"; la plantilla tiene la columna
    `concentracion`.
  - `utils/competidor.js` lee dosis y unidades del nombre para los enlaces
    viejos.
- **Duplicados**:
  - un competidor es el mismo si coinciden nombre, laboratorio, concentración
    y tamaño, en la misma cadena y el mismo producto (`claveCompetidor`);
  - un **enlace (URL) solo puede estar una vez**: el formulario no guarda uno
    repetido, y la plantilla salta las filas cuya URL ya está en otro
    producto (antes la movía en silencio) y lo avisa;
  - "Posibles duplicados" también marca URLs que están en varios productos.
- **Mercados mal armados**: en Competencia, "Revisar: Dosis o tamaño distinto
  al tuyo" y una etiqueta "Otra dosis" / "Otro tamaño" en la fila, con el
  detalle al pasar el mouse. Solo cuenta si se saben los dos lados.

## Ajustes del PR #57 (sin SQL)

- **Barra de filtros**:
  - rótulo "Moneda" en $ | Bs, como los demás segmentados;
  - Precio, Por, Moneda y Cambios se recuerdan solo mientras la pestaña está
    abierta (`usePreferencia(..., { sesion: true })`, sessionStorage): al
    entrar se arranca en Lista, Empaque, $ y 24 h;
  - la meta y las filas por página se siguen recordando siempre.
- **Los dos filtros de tipo, con textos distintos**:
  - "Tus productos: todos / Tus genéricos / Tus marcas" filtra TUS
    productos (`tipo_mercado` del producto propio);
  - "Competidores: todos / genéricos / de marca" decide contra qué
    competidores se compara (`tipo_mercado` del competidor).
- **CSV de Competencia**:
  - la **plantilla de carga** lleva solo la relación: id_interno, nombre,
    cadena, tipo, competidor, laboratorio, unidades_empaque, **medida**
    (unidad/ml/g, nueva), tipo_mercado, url y activo;
  - el **reporte** agrega pvp_propio_usd, precio_usd, precio_bs,
    precio_oferta_bs y ultima_captura;
  - `laboratorio_competidor` pasa a llamarse `laboratorio` (se sigue
    aceptando el nombre viejo);
  - en las filas "propio", laboratorio, unidades, medida y tipo_mercado salen
    de Productos y al importar se ignoran (se cambian en Productos);
  - los precios manuales del formulario (normal y oferta) no van en la
    plantilla: son capturas, no relación.

## Barra de filtros con Material 3 (PR #56, sin SQL)

Dashboard, Mapa de Calor, ficha del producto y Mapa por cadena usan la misma
barra (`components/BarraFiltros.jsx`):
- **Dos filas alineadas con rótulo**:
  - "Filtrar": chips de filtro que acotan la lista;
  - "Comparar": cómo se calcula.
- **Botones segmentados de M3** (`components/Segmentado.jsx`, selección única,
  con check y flechas del teclado) para las opciones fijas: Precio
  Lista/Oferta, Por Empaque/Unidad, $/Bs y Cambios 24 h/7 d/15 d. El switch
  $/Bs se reemplazó: en M3 el switch es para encender/apagar, no para elegir
  entre dos valores. La meta (muchas opciones) sigue como menú.
- **"Limpiar"**: en pantalla ancha va al extremo derecho de la fila Filtrar,
  en un espacio reservado; en celular, junto al rótulo. Así nunca empuja los
  chips. `LimpiarFiltros` ya solo se usa en las tablas de Productos,
  Competencia, Cadenas y Usuarios.

## Promedio del mercado y tres análisis nuevos (PR #55, fases 31 y 32)

- **Promedio del mercado en todo el panel** (lo pidió Hernando): el promedio
  cuenta tu precio, (suma de la competencia + tu precio) ÷ (competidores + 1).
  El mínimo sigue siendo solo de la competencia ("Eres el más barato" no
  cambia).
  - `useAnalisisPrecios` devuelve `promedio` (mercado) y `promedioComp`.
  - La meta se despeja exacta, porque al mover tu precio también se mueve el
    promedio: t = (1 + m)·S / (n − m), en `calcularAjuste(..., competidores)`.
    Con meta 0 da el promedio de la competencia.
  - En la ficha, con "Relación: todas", el promedio y su línea en la historia
    son del mercado ("Promedio (mercado)").
  - **Fase 31**: `fn_posicion_productos` devuelve `promedio_usd` y
    `dif_promedio` del mercado, y con eso la tendencia. Misma firma que la
    fase 30.
- **Historial del PVP** en la ficha lateral de Productos (`FichaProducto`):
  cada tramo de `pvp_propio`, con fechas y el % frente al anterior. Sin SQL.
- **Fase 32** y tres pestañas nuevas en Experimental
  (`components/analisis/`, con `hooks/useRpc.js`):
  - **Comparador de períodos** (`fn_comparar_periodos`): tu posición en los
    últimos 7/15/30 días frente a los anteriores, por producto, y si el
    cambio vino de tu precio o del mercado.
  - **Índice por molécula** (`fn_indice_molecula`): índice base 100 del precio
    del mercado por unidad, en $ a la tasa de cada día. Promedia los índices
    de cada producto de la molécula, con una minilínea por molécula.
  - **Velocidad de reacción** (`fn_velocidad_reaccion`): un cambio es
    reacción si el cambio anterior en ese producto lo hizo otra cadena en los
    30 días previos. Por cadena muestra la mediana de días, las reacciones,
    cuántas van en la misma dirección y cuántas veces la siguieron. Se hace
    con una sola pasada ordenada: la primera versión (cruzando cada cambio con
    todos los demás) tardaba 75 s en la base de prueba; esta, 2 s.

## Ajustes del PR #54 (sin SQL)

- **Mapa de Calor con el MERCADO**: mínimo, promedio y máximo cuentan tu
  precio (competencia + tú). El globo, el estado (Más barato / Parejo / Más
  caro), los indicadores, el orden y el CSV usan ese promedio. Si el mínimo o
  el máximo eres tú, el rótulo dice "Tú". En el Dashboard el promedio sigue
  siendo solo de la competencia; la ayuda (i) del mapa lo advierte.
- **Filtros ordenados**:
  - misma secuencia en Dashboard y Mapa (Unidad, Tipo, Categoría, Cadenas,
    Marcas y genéricos, Posición);
  - nombres más cortos ("Cadenas: todas", "Marcas y genéricos");
  - en pantalla ancha los ajustes bajan enteros a su fila, a la derecha (CSS
    de `.m3-dash-filtros`), en vez de apilarse en una columna;
  - "Limpiar filtros" va al inicio del grupo de ajustes, así su espacio
    invisible no deja una fila vacía.
- **Ficha del enlace (Competencia)**: "Nombre en la tienda" muestra el nombre
  que leyó el robot (`fact_precios.nombre_capturado` de la última captura
  que lo tenga), no el del competidor. "Últimas capturas" ya existía; ahora
  marca las que tenían oferta.

## Ajustes del PR #53 (fase 30)

- **Fase 30** (`sql/fase30_tendencia_marca_generico.sql`):
  `fn_posicion_productos` y `fn_tendencia_posicion` reciben `p_tipo_mercado`
  al final. Se borran las versiones viejas antes, para que no haya dos. El
  panel solo lo manda si el filtro está puesto, así que sin la fase 30 todo
  sigue funcionando menos ese filtro en la tendencia.
- **Mapa de Calor**:
  - escala propia de cada fila, lineal por mitades: esquina izquierda =
    mínimo, centro = promedio, esquina derecha = máximo;
  - zonas con degradado (azul hacia la izquierda, rojo hacia la derecha) que
    crecen desde el centro al aparecer;
  - sin el tramo gris (siempre iba de esquina a esquina);
  - la leyenda pasó al botón (i) y el buscador recupera su ancho;
  - "Tu posición" con letra uniforme.
- **Experimental**:
  - cada pestaña carga su código solo al abrirse (`lazy`);
  - "Brechas USD" pide la historia solo del producto elegido, con el nuevo
    `hooks/useHistoricoProducto.js` (que ahora usa también la ficha).
    Simulador sigue bajando el histórico completo.
- **Diseño**: avisos emergentes (`.m3-toast`) y pantalla de error con tokens
  M3. En celular los avisos ya no se salen de la pantalla. Cadenas y
  Dimensiones ya tenían el diseño nuevo; lo que queda del estilo viejo está
  en Experimental (Simulador, Canibalización, Brechas).
- **Repositorio**: los `fase*.sql` y `supabase_setup_rls.sql` pasaron a
  `sql/`; se borró `debug/` (capturas viejas del scraper).

## Marca o genérico de cada competidor (PR #52, fase 29)

- **Fase 29** (`fase29_marca_generico_competencia.sql`):
  - clasifica una sola vez `dim_productos.tipo_mercado` de los `COMP_`: si el
    nombre empieza con la molécula del producto propio es GENERICO; si no,
    MARCA;
  - no toca nada si ya hay algún competidor en MARCA;
  - agrega `tipo_mercado` al final de la vista `productos_competencia`,
    conservando sus opciones.
- **Carga**: campo "Marca o genérico" en el formulario del competidor (sugerido
  por el nombre, se puede cambiar) y columna `tipo_mercado` en la plantilla
  (marca / generico; vacío = se conserva, o se deduce en uno nuevo).
  `utils/tipoMercado.js` tiene la regla, la lectura y `esMarca`.
- **Análisis** (`useAnalisisPrecios`):
  - parámetro `tipoComp` (todos / GENERICO / MARCA) para comparar solo contra
    un tipo;
  - `cruce` por producto: tu genérico cuesta más que una marca de la
    competencia, o tu marca cuesta menos que un genérico. Cuenta solo el mismo
    empaque (o todo si se compara por unidad); el mismo producto lo da el
    vínculo.
- **Dashboard**: filtro "Competidores: marcas y genéricos / solo genéricos /
  solo marcas" y aviso "Cruces genérico / marca" con su lista. La tendencia
  (SQL) todavía no aplica este filtro.
- **Ficha**: el mismo filtro, más la etiqueta Marca / Genérico en cada oferta.
- **Mapa de Calor**:
  - vuelve la escala común centrada en el promedio, con zonas de color;
  - tramo oscuro del mínimo al máximo de la competencia, con rótulos en su
    lugar real (se juntan con el promedio si están pegados);
  - sin puntos por competidor;
  - se quitaron "Tu precio" bajo el nombre y la columna "Tú frente al
    promedio"; ahora la columna dice **Tu posición** ("2.º de 5", ordenable),
    el estado y, si hay, el cruce con marca/genérico;
  - mismo filtro de competidores.
- Arreglo: borrar un enlace lanzaba "db is not defined" (restos de Firestore)
  después de borrar bien en Supabase.
- Pendiente anotado: Experimental tarda 5-10 s porque "Brechas USD" pide el
  histórico completo de todos los productos (`cargarHistorico`). No se tocó.

## Mapa de Calor: recta de precios (PR #51, sin SQL)

La franja con zonas (PR #49/#50) confundía: la escala no incluía tu precio,
los rótulos Mín/Máx quedaban en los bordes aunque la línea no llegara, y el
promedio parecía "mal" porque es solo de la competencia. Ahora cada fila es
una **recta de precios**:
- de izquierda (más barato) a derecha (más caro), **contando tu precio**;
- un punto pequeño por competidor, con el color de su cadena;
- raya del promedio de la competencia con su valor debajo;
- tu punto con un globo de color (azul más de 5 % bajo el promedio, gris
  ±5 %, rojo más de 5 % encima) que entra con una animación;
- abajo: el más barato y el más caro (dice "Tú" si eres tú).

## Ajustes del PR #50 (sin SQL)

- **Robot: los precios no se guardaban desde la fase 5.**
  `push_to_supabase.py` seguía escribiendo en `productos_competencia` e
  `historico_precios`, que desde la fase 5 son vistas de solo lectura. El
  error (55000) cortaba la sincronización antes de insertar en `fact_precios`,
  y el job terminaba en verde. Se quitó esa escritura (las vistas se calculan
  solas desde `fact_precios`). Si ahora falla el guardado, el job sale en rojo
  (`exit 1`). También avisa cuántos resultados no tienen publicación.
- **Dashboard**: "Tú frente al mínimo" y "Tú frente al promedio" pasan a una
  sola columna, **Tu diferencia** (vs mín. / vs prom.), que se ordena por
  cualquiera de las dos.
- **"Limpiar filtros" siempre ocupa su lugar** (`components/LimpiarFiltros.jsx`):
  cuando no hay filtros queda invisible, así los chips no saltan de fila al
  aplicar uno. Aplicado en las 8 pantallas que lo tenían.
- **Tablas de los modales sin scroll horizontal** en pantallas de menos de
  900 px (`.m3-table-apilada`, con `data-label` en cada celda): cada fila
  pasa a ser una tarjeta. Aplicado en DetalleLista, la ficha y Cobertura por
  cadena. La ficha además tiene `overflow-x: hidden`.
- **Ficha**:
  - la línea del promedio de "Precios de hoy" lleva su valor, en el margen
    derecho, para que no se monte sobre las columnas;
  - la lista de "Cambiar producto" muestra concentración y empaque.
- **Mapa de Calor**:
  - escala común centrada en el promedio (±límite %, entre 10 y 50 según los
    datos), así la raya del promedio siempre queda al centro y las zonas miden
    lo mismo en todas las filas;
  - un globo sobre el punto muestra tu precio y la diferencia con el promedio;
  - leyenda con los umbrales (±5 %).

## Ajustes del PR #49 (sin SQL)

- **Filtros fijos retirados**: a Hernando no le gustó que bajaran al hacer
  scroll. Se borró `components/FiltrosFijos.jsx`; los filtros del Dashboard y
  del Mapa de Calor vuelven a ser una barra normal. `main` vuelve a
  `overflow-x-auto`, la barra de la app ya no publica `--alto-cabecera` y el
  buscador de las tablas vuelve a `top: 0`.
- **Ficha del producto**: la tabla de ofertas va **primero** y los gráficos
  después. Nueva tarjeta **Tasa BCV** (la tasa con que se pasan los Bs a $,
  con su fecha); las tarjetas van en 3 columnas (6 solo en pantallas muy
  anchas). En la historia, el tooltip muestra la tasa BCV de ese día.
- **Explicación de los gráficos en un botón (i)** (`components/InfoGrafico.jsx`):
  el texto que iba fijo bajo cada título se movió a un panel que se abre al
  tocar el ícono, con qué muestra, la fórmula y cómo leerlo. Escape o tocar
  fuera lo cierra (sin cerrar la ficha o el modal). Está en: Tendencia de tu
  posición, ¿Dónde está tu precio?, ¿Qué cadena tiene el precio más bajo?,
  Precios de hoy e Historia de precios (ficha), Historia de la tasa (modal BCV)
  y la franja del Mapa de Calor.

## Rendimiento (PR #47)

Por qué tardaba: (1) `cargarTodo` dependía de `isLoadedOnce`; al terminar la
primera carga cambiaba y el efecto la lanzaba **otra vez** (todo se bajaba
dos veces); (2) al entrar se bajaban 180 días de histórico (~90 peticiones
seguidas) que solo usan la ficha y dos pantallas de Experimental; (3) la
copia en `sessionStorage` no servía (la segunda carga ponía el spinner) y no
duraba entre pestañas; (4) cada pantalla consultaba la tasa BCV (y a veces
dos páginas externas) y calculaba con 744,23 mientras tanto.

Ahora: una sola carga; el histórico se pide con `cargarHistorico()` solo
donde hace falta (Brechas USD, Simulador) y la ficha baja solo el de su
producto; copia local en `localStorage` por usuario (`utils/cacheDatos.js`,
máx. 3 días, se borra al cerrar sesión) que pinta al instante mientras llegan
los datos nuevos; tasa BCV compartida con una consulta cada 10 min y la
última conocida guardada.

## Ficha del producto, Mapa de Calor y Experimental (PR #47)

- **Ficha** (`ProductDetailModal.jsx`, de 1.600 a ~500 líneas): pantalla
  completa con barra superior (anterior/siguiente, cambiar producto, ⋮ borrar
  historia), ajustes, 4 indicadores (tu precio, mínimo, frente al mínimo,
  frente al promedio con la meta), "Precios de hoy" (barras por oferta con
  color de la cadena + tabla con unidades, precio por unidad, "Tú frente a
  esta", cambio 7 días, enlace) e "Historia de precios" (tuyo/mínimo/promedio
  o cada oferta, colores categóricos validados `--md-sys-color-data-cat-*`).
- **Mapa de Calor**: pestaña "Por cadena" (celda = tu precio frente al más
  bajo de la competencia en esa cadena, colores divergentes del Dashboard,
  con signo y precio) y "Rango de precios" (mínimo–máximo, raya en el
  promedio, punto con tu precio). Indicadores clicables, filtros estándar,
  paginación. Quitó el degradado rojo-verde-rojo.
- **Experimental**: se borraron Reportería, Análisis y Hallazgos (ya están en
  el Dashboard: tabla + Exportar, indicadores, "Más caros que el mínimo",
  vista por molécula). Las rutas viejas llevan al Dashboard.

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

- Mapa de cobertura (en parte: "Cobertura por cadena" en Competencia)
- Precio efectivo de promoción
- Alertas por correo (espera Brevo)
- Reporte semanal (espera Brevo)

Hechas en el #55: índice por molécula, comparador de períodos y velocidad
de reacción.

**Competencia**: historial y "Nombre en la tienda" de la ficha del enlace, hechos en el #54.

**Unidades por empaque de los competidores** (para comparar por unidad):
tras la fase 28 salen de la ficha del producto competidor
(`cantidad_contenido`). Al crear un competidor desde un enlace se guarda 1
si no se sabe, y el panel toma ese 1 como "no se sabe": lee las unidades del
nombre ("x 20 tabletas") o asume las de tu producto. Falta una forma de
cargar el contenido real de cada competidor (idea para Competencia).

**Limpieza del repo**: hecha en el #53 (SQL en `sql/`, sin `debug/`). Falta
borrar `recarga/` cuando termine la recarga.

**Diseño (Material Design 3 Expressive)**: Productos y Competencia ya están al día. En el
resto quedaban 71 colores hex sueltos (sobre todo gradientes y Recharts en
`ProductDetailModal.jsx`), 33 tamaños de texto arbitrarios y 2 `bg-white`
(cifras de antes de esta sesión, sin recontar). Las clases nuevas de
`index.css` (`m3-data-table`, `m3-filter-chip`, `m3-icon-btn`,
`m3-side-sheet`, `m3-banner`…) y las piezas compartidas sirven para llevar el
mismo diseño a Cadenas y Dimensiones.

**Ideas que quedaron sobre la mesa**
- Productos: historial del PVP en la
  ficha, gestionar enlaces desde la ficha, filtros en la dirección web.
- Siglas de unidad de negocio (`PH`): la tabla no tiene columna `codigo`;
  haría falta SQL.

---

## Documentos del repo

- `DICCIONARIO_CAMPOS.md` — nomenclatura canónica de todos los campos
- `CARGA_CSV.md` — orden de carga y qué va en cada columna
- `ESQUEMA.md` — las tablas y sus relaciones
