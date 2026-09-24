# Carga de datos por CSV

Los cuatro CSV de la raíz del repositorio son **plantillas de ejemplo** con los
nombres de columna canónicos (ver `DICCIONARIO_CAMPOS.md`). No son tus datos
reales: son el formato que espera el panel. Descárgalos, reemplaza las filas y
súbelos desde la pantalla correspondiente.

Usan coma como separador y UTF-8. El lector del panel también acepta punto y
coma o tabulador, y reconoce los nombres de columna aunque cambien mayúsculas,
acentos o guiones.

## Orden de carga (no es opcional)

Las llaves foráneas son `ON DELETE RESTRICT`: cada paso exige que el anterior
exista.

1. `cadenas.csv` → pantalla **Cadenas**
2. `productos.csv` → pantalla **Productos**
3. PVP propio → pantalla **Dimensiones → PVP Propio Vigente**
4. `productos_competencia.csv` → pantalla **Competencia**
5. Scraper → pestaña **Actions** de GitHub, workflow *Scraper diario*

## productos.csv

Una fila por producto propio.

- **`id_interno`** es tu SKU y la llave de todo lo demás. El CSV de competencia
  lo referencia con ese mismo valor. Si se repite, la segunda fila actualiza a
  la primera.
- **`nombre` es solo la identidad comercial: sin dosis y sin empaque.** La
  concentración va en `concentracion` y el tamaño en `tamano`, y el panel los
  muestra en columnas propias. Si los repites en el nombre, salen dos veces en
  pantalla:

  | | `nombre` | `concentracion` | `tamano` | `forma_farmaceutica` |
  |---|---|---|---|---|
  | Mal | `BUMETIN 300MG TAB X 10` | | | |
  | Bien | `Bumetin` | `300 mg` | `10 tabletas` | `Tabletas` |

  En los genéricos sin marca la molécula **sí** es el nombre comercial
  (`Amlodipino La Santé`), pero la dosis y el empaque siguen fuera.

  El nombre también es lo que el scraper compara contra el título de la tienda
  para detectar capturas malas. Un nombre cargado con dosis y empaque no se
  parece al título publicado y hace saltar la alarma todos los días sobre un
  producto que en realidad se está leyendo bien.
- `laboratorio` se crea solo si no existe. `categoria` y `unidad_negocio` no:
  tienen que existir en **Dimensiones**. Si el nombre no coincide, el
  producto conserva la que ya tenía.
- `activo` admite `si` o `no`. Si el archivo no trae la columna, el estado
  guardado no se toca.
- **Una celda vacía no cambia nada** en un producto que ya existe. Para
  actualizar basta el `id_interno` y las columnas que cambian: un archivo con
  solo `id_interno,pvp_propio_usd` actualiza los PVP. El `nombre` solo es
  obligatorio en productos nuevos.
- Antes de importar, la revisión muestra **qué va a cambiar** en cada
  producto (antes → después) y cuáles son nuevos.
- Los archivos guardados con Excel (Windows-1252, o con los acentos ya rotos
  como `SuspensiÃ³n`) se leen y se corrigen solos.
- Los dos CSV que descarga la pantalla **Productos** tienen estas mismas
  columnas, en este orden, y se pueden volver a subir tal cual:
  `productos_plantilla_carga_AAAA-MM-DD.csv` (todo el catálogo, para editarlo)
  y `productos_reporte_AAAA-MM-DD.csv` (lo que se ve en pantalla, con los
  filtros aplicados). Ninguno lleva precio, así que no tocan los PVP.
- `pvp_propio_usd` es tu precio oficial en dólares; queda registrado con la
  fecha de carga como inicio de vigencia.
- `tamano` en texto libre basta: el sistema deduce la cantidad y la unidad.
  `120 ml` se guarda como volumen y `10 tabletas` como unidades, que es lo que
  distingue un jarabe de una caja para el cálculo de precio unidosis.
- `forma_farmaceutica` se crea sola si no existe, igual que el laboratorio.
  Ahí van `Tabletas`, `Jarabe`, `Crema`, `Solución oftálmica`… y **no** dentro
  del nombre.

## productos_competencia.csv

Una fila por URL monitoreada.

- **`id_producto_propio` debe coincidir con un `id_interno` ya cargado.** Es lo
  que construye la equivalencia entre tu producto y el del competidor. Si no
  coincide, la fila se rechaza con un mensaje que nombra el producto.
- **`tipo`**: `propio` si la URL es de **tu** producto en esa cadena;
  `alternativa` si es de un competidor.
- **`laboratorio`** es obligatorio en las filas `alternativa`: con él se crea el
  producto del competidor y se decide si cuenta como marca propia.
- `cadena` acepta el id (`farmatodo`) o el nombre comercial (`Farmatodo`). Si no
  existe, se registra.
- La clave real de un enlace es **cadena + URL**. Si repites esa combinación, la
  fila se descarta como duplicada y el resumen de importación te lo dice.

## cadenas.csv

- **`id`** es un código corto en minúsculas, sin espacios ni acentos. Es lo que
  referencia `productos_competencia.csv`.
- **`scraper_modulo`** debe coincidir con un módulo implementado en `scraper/`.
  Hoy: `farmatodo`, `locatel`, `farmadon`, `grupo_san_ignacio`, `xana`,
  `farmago`.
- `color_hex` es el color de la cadena en los gráficos.

## Nota sobre el scraper

`scraper/farmatodo.py` lee los enlaces desde Supabase. Solo si Supabase no está
configurado cae en `productos_competencia.csv` de la raíz. Por eso ese archivo
debe seguir siendo un CSV válido aunque solo tenga filas de ejemplo.
