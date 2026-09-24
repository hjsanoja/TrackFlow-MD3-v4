# Estructura de datos de TrackFlow

Modelo estrella (*star schema*) en PostgreSQL/Supabase. Una sola tabla de
hechos, `fact_precios`, rodeada de dimensiones que la describen.

## Cómo se relaciona todo

```
                    dim_laboratorios (es_propio)
                    dim_categorias
                    dim_unidades_negocio     ──┐
                    dim_formas_farmaceuticas   │
                    dim_marcas ────────────────┤
                                               ▼
   producto_equivalencias ◄──────────── dim_productos ──────► producto_principios
   (propio ↔ competidor)                      │                      │
                                              ▼                      ▼
                                        publicaciones      dim_principios_activos
                                     (una URL por cadena)
                                              │
                    dim_cadenas ──────────────┤
                                              ▼
                                        fact_precios ◄──── scrape_runs
                                     (una fila por captura)      │
                                              │            dim_cadenas
                                              ▼
                                     dim_tipos_promocion

   pvp_propio ──► dim_productos          dim_tasa_bcv (serie diaria, PK = fecha)
   (vigencia temporal)
```

**La cadena que hay que entender:** un producto vive en `dim_productos`. Cada
URL que monitoreas de ese producto en una cadena es una fila de
`publicaciones`. Cada vez que el scraper visita esa URL, escribe una fila en
`fact_precios`. Y la relación entre **tu** producto y el del competidor vive en
`producto_equivalencias`, no en el producto mismo.

## Tabla por tabla

### Dimensiones maestras

| Tabla | PK | Qué guarda | Notas |
|---|---|---|---|
| `dim_cadenas` | `id` (texto) | Las farmacias monitoreadas | `modulo_scraper` dice qué robot de Python la atiende |
| `dim_laboratorios` | `id` | Fabricantes | **`es_propio`** decide qué es Mi Marca y qué es Competidor |
| `dim_marcas` | `id` | Marcas comerciales | Cuelga de un laboratorio |
| `dim_categorias` | `id` | Categoría terapéutica | |
| `dim_unidades_negocio` | `id` | Líneas internas | La Santé, Pharmetique, OTC |
| `dim_formas_farmaceuticas` | `id` | Tabletas, jarabe, gotas… | |
| `dim_principios_activos` | `id` | Moléculas | `sinonimos` es un arreglo de texto |
| `dim_tipos_promocion` | `id` | 2x1, 3x2… | `unidades_lleva`/`unidades_paga` permiten calcular el precio efectivo |
| `dim_tasa_bcv` | **`fecha`** | Serie diaria del BCV | Sin `id`: la fecha es la llave natural |

### Catálogo y relaciones

| Tabla | Qué guarda | Relación |
|---|---|---|
| `dim_productos` | Propios **y** competidores | Los competidores llevan prefijo `COMP_` en `id_interno` |
| `producto_equivalencias` | Qué competidor equivale a qué producto tuyo | N:M sobre `dim_productos` |
| `producto_principios` | Moléculas de cada producto | Con concentración y unidad |
| `pvp_propio` | Tu precio oficial en USD | Con `vigente_desde`/`vigente_hasta`; una restricción impide solapes |
| `publicaciones` | Una URL monitoreada | Única por (`cadena_id`, `url_normalizada`) |

### Operación

| Tabla | Qué guarda |
|---|---|
| `fact_precios` | Una fila por captura: precios en Bs, tasa BCV del día, disponibilidad, banderas de calidad y promoción |
| `scrape_runs` | Bitácora de cada corrida del scraper |
| `audit_log` | Quién cambió qué y cuándo |
| `config_calidad` | Umbrales del control de calidad |

## Vistas

| Vista | Para qué | Parte de |
|---|---|---|
| `v_ultimo_precio_valido` | El precio vigente de cada publicación | `fact_precios` |
| `v_precio_diario` | Un precio por publicación y por día | `fact_precios` |
| `productos_competencia` | Compatibilidad: los enlaces como los lee el panel | **`publicaciones`** |
| `historico_precios` | Compatibilidad: el histórico como lo lee el panel | `fact_precios` |
| `cadenas`, `bcv_rates` | Compatibilidad con las tablas viejas | `dim_cadenas`, `dim_tasa_bcv` |

Las tres últimas son vistas de **solo lectura**. Escribir un enlace nuevo va a
`dim_productos` + `producto_equivalencias` + `publicaciones`, nunca a
`productos_competencia`.

`productos_competencia` parte de `publicaciones` y no de los precios: por eso un
enlace recién creado aparece de inmediato, marcado como `pendiente` hasta que el
scraper lo visite.

## Integridad

Todas las llaves foráneas son **`ON DELETE RESTRICT`**. No hay borrado en
cascada automático: para eliminar un producto hay que vaciar antes sus hijos, en
este orden.

```
fact_precios → publicaciones → pvp_propio → producto_equivalencias
             → producto_principios → dim_productos
```

La función `fn_eliminar_producto(id_interno)` hace exactamente eso en una sola
transacción.

## Seguridad (RLS)

RLS está activo en las 18 tablas. El rol `authenticated` (el panel) puede leer,
crear, modificar y borrar en catálogos y tablas de relación. Sobre las tablas de
hechos puede leer y borrar, pero **no escribir**: insertar capturas queda
reservado al scraper, que usa `service_role`.
