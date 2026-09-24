# TrackFlow — estado del proyecto

Documento de contexto para retomar el trabajo en una conversación nueva.
Última actualización: 2026-09-24.

---

## Qué es

Panel de inteligencia competitiva de precios de medicamentos en Venezuela.
Un scraper diario lee los precios de las farmacias online, los guarda en
Supabase y el panel los compara contra el PVP propio.

Los laboratorios propios son **La Santé** y **Pharmetique**.

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

### Vistas de compatibilidad

`productos_competencia`, `historico_precios`, `cadenas` y `bcv_rates` ya **no
son tablas**: son vistas de solo lectura sobre el esquema nuevo, creadas por
`fase5`. Escribir en ellas devuelve el error `55000`, que el cliente ignora a
propósito.

---

## Las 17 fases de SQL

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

---

## El hilo que domina las últimas sesiones

`fn_evaluar_calidad_historica` marcó **738 capturas sospechosas de 20.153**:
649 por nombre y 88 por precio. Perseguir esos 649 llevó a la causa raíz.

**No eran capturas malas.** Eran ~16 productos cuyo nombre de catálogo no se
parecía al título que publica la tienda, fallando todos los días. El scraper
lee bien; el catálogo estaba mal escrito.

**Por qué estaba mal escrito:** la molécula y la dosis nunca llegaban a la
base. `dbUpsertProducto` las recogía del formulario y del CSV pero solo las
escribía en la tabla legacy `productos`, que desde la fase 5 es una vista de
solo lectura. Y `fetchDimProductos` tampoco pedía `producto_principios`, así
que las columnas salían vacías en pantalla. Con los dos campos invisibles, el
único sitio donde la dosis sobrevivía era el nombre.

**La regla que quedó:**

```
"ACETAMINOFEN 500 MG TAB X 20"
 ^^^^^^^^^^^^  ^^^^^^  ^^^ ^^^^
 nombre        dosis   forma  empaque
```

El nombre es solo la identidad comercial. Excepción: en los genéricos sin
marca la molécula **sí** es el nombre (`Amlodipino La Santé`), pero la dosis y
el empaque siguen fuera.

### Dónde está eso ahora

Arreglado y fusionado (PR #18): el guardado escribe `producto_principios`, la
lectura lo pide, `parsearFicha.js` convierte el texto libre en filas atómicas,
y el PVP ya no se descarta en silencio al reimportar.

Pendiente de fusionar: **PR #19** (fase 16) y **PR #20** (fase 17).

**El siguiente paso concreto** es que Hernando fusione esas dos, corra los dos
SQL y haga la recarga del catálogo:

1. `SELECT * FROM v_csv_productos WHERE zz_revisar IS NOT NULL;` — revisar lo
   dudoso (eran 17 filas de ~215, y la fase 17 debería bajarlas a ~10).
2. Descargar el CSV sin las columnas `zz_*`.
3. Rellenar `principio_activo`, que sale vacía a propósito: de `ESOZ` no se
   puede deducir "Esomeprazol" sin inventar.
4. Subirlo por **Productos → Importar CSV**.
5. `SELECT count(*) FROM v_productos_sin_ficha WHERE es_propio;` debería bajar
   de ~200 a casi cero.

**Recargar no pierde historial**: el alta es un upsert por `id_interno` y no
toca `publicaciones` ni `fact_precios`. La plantilla tampoco lleva columna de
precio, así que los PVP no se tocan.

Sobre `fn_evaluar_calidad_historica`: **no aplicar el criterio de nombre**.
Marcaría 649 capturas buenas. Solo el de precio:
`SELECT jsonb_pretty(fn_evaluar_calidad_historica(TRUE, 0.40, 0));`

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

---

## Qué falta

**Funciones del bloque 5** (menú Experimental). Hechas: bandeja de revisión de
capturas y devaluación vs subida real. Faltan:

- Mapa de cobertura
- Precio efectivo de promoción
- Índice de precios por molécula
- Comparador de períodos
- Velocidad de reacción competitiva
- Alertas por correo
- Reporte semanal

**Limpieza del repo**: mover los `fase*.sql` a `sql/`, borrar `debug/`.

**Diseño (Material Design 3 Expressive)**: quedan 71 colores hex sueltos
(sobre todo gradientes y Recharts en `ProductDetailModal.jsx`), 33 tamaños de
texto arbitrarios y 2 `bg-white`. Falta aplicar `.m3-cell-clamp` tabla por
tabla para que el texto largo no descuadre la altura de las filas.

---

## Documentos del repo

- `DICCIONARIO_CAMPOS.md` — nomenclatura canónica de todos los campos
- `CARGA_CSV.md` — orden de carga y qué va en cada columna
- `ESQUEMA.md` — las tablas y sus relaciones
