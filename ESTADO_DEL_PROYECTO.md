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
| Código en `main` | PR #50, desplegado (GitHub Pages sale solo de `main`) |
| SQL corrido en Supabase | **Hasta la fase 28** (el #48 no trae SQL) |
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

- Mapa de cobertura
- Precio efectivo de promoción
- Índice de precios por molécula
- Comparador de períodos
- Velocidad de reacción competitiva
- Alertas por correo
- Reporte semanal

**Competencia**, para luego: el historial de precios en la ficha del enlace y
el "Nombre en la tienda" de la ficha (la vista pone el nombre del competidor,
no el que lee el robot: `fact_precios.nombre_capturado`; es un SQL pequeño).

**Unidades por empaque de los competidores** (para comparar por unidad):
tras la fase 28 salen de la ficha del producto competidor
(`cantidad_contenido`). Al crear un competidor desde un enlace se guarda 1
si no se sabe, y el panel toma ese 1 como "no se sabe": lee las unidades del
nombre ("x 20 tabletas") o asume las de tu producto. Falta una forma de
cargar el contenido real de cada competidor (idea para Competencia).

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
- Productos: historial del PVP en la
  ficha, gestionar enlaces desde la ficha, filtros en la dirección web.
- Siglas de unidad de negocio (`PH`): la tabla no tiene columna `codigo`;
  haría falta SQL.

---

## Documentos del repo

- `DICCIONARIO_CAMPOS.md` — nomenclatura canónica de todos los campos
- `CARGA_CSV.md` — orden de carga y qué va en cada columna
- `ESQUEMA.md` — las tablas y sus relaciones
