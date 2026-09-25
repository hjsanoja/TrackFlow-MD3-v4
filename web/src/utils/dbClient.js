import { supabase, isSupabaseActive } from '../supabase';
import { parsearPrincipios, parsearContenido } from './parsearFicha';

export { isSupabaseActive };

// --- HELPER PARA MANEJAR COLUMNAS FALTANTES EN SUPABASE AUTOMÁTICAMENTE ---
export async function supabaseUpsertSafe(tableName, payload) {
  const isArray = Array.isArray(payload);
  let items = isArray ? payload.map(x => ({ ...x })) : [{ ...payload }];

  for (let attempt = 0; attempt < 15; attempt++) {
    const { error, data } = await supabase.from(tableName).upsert(isArray ? items : items[0]);
    if (!error) return { ok: true, data };

    const msg = error.message || '';
    if (error.code === 'PGRST204' || msg.includes('Could not find the') || msg.includes('column')) {
      const match = msg.match(/Could not find the ['"]?([a-zA-Z0-9_]+)['"]? column/i);
      if (match && match[1]) {
        const missingCol = match[1];
        items.forEach(item => {
          delete item[missingCol];
        });
        continue;
      }
    }
    throw error;
  }
}

export async function supabaseInsertSafe(tableName, payload) {
  const isArray = Array.isArray(payload);
  let items = isArray ? payload.map(x => ({ ...x })) : [{ ...payload }];

  for (let attempt = 0; attempt < 15; attempt++) {
    const { error, data } = await supabase.from(tableName).insert(isArray ? items : items[0]);
    if (!error) return { ok: true, data };

    const msg = error.message || '';
    if (error.code === 'PGRST204' || msg.includes('Could not find the') || msg.includes('column')) {
      const match = msg.match(/Could not find the ['"]?([a-zA-Z0-9_]+)['"]? column/i);
      if (match && match[1]) {
        const missingCol = match[1];
        items.forEach(item => {
          delete item[missingCol];
        });
        continue;
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// ESCRITURA EN EL MODELO DIMENSIONAL
// ---------------------------------------------------------------------------
// Tras fase5_archivo_deprecacion.sql, `productos_competencia` dejó de ser una
// tabla y pasó a ser una VISTA de solo lectura sobre v_ultimo_precio_valido.
// Cualquier INSERT/UPDATE contra ella falla con el código 55000. El destino
// real de un enlace de competencia son tres tablas:
//   dim_productos          -> el producto del competidor (id_interno COMP_*)
//   producto_equivalencias -> qué producto propio equivale a ese competidor
//   publicaciones          -> la URL monitoreada en una cadena
// Estos helpers concentran esa escritura.

// Los únicos laboratorios de marca propia. Debe coincidir con el bloque 5 de
// fase6_correcciones.sql.
export const LABS_PROPIOS = [
  'LA SANTE', 'LA SANTÉ', 'PHARMETIQUE', 'PHARMETIQUE LABS', 'PHARMETIQUELABS'
];

// Misma normalización que usa publicaciones.url_normalizada en el esquema:
// minúsculas y sin querystring.
export function normalizarUrl(url) {
  return String(url || '').replace(/\?.*$/, '').trim().toLowerCase();
}

// Devuelve el id de un laboratorio, creándolo si no existe.
async function resolverLaboratorioId(nombre) {
  const labNombre = String(nombre || '').toUpperCase().trim() || 'OTRO';
  // resolverDimension compara sin mayusculas ni tildes (ilike las respeta).
  const id = await resolverDimension(null, 'dim_laboratorios', labNombre, { es_propio: LABS_PROPIOS.includes(labNombre) });
  if (!id) throw new Error(`No se pudo crear el laboratorio "${labNombre}".`);
  return id;
}

// dim_cadenas.id es un VARCHAR elegido a mano (p.ej. 'farmatodo'), así que el
// CSV puede traer tanto el id como el nombre comercial.
async function resolverCadenaId(cadena) {
  const valor = String(cadena || '').trim();
  if (!valor) throw new Error('El enlace no indica a qué cadena pertenece.');

  const { data: porId } = await supabase
    .from('dim_cadenas')
    .select('id')
    .eq('id', valor)
    .maybeSingle();
  if (porId?.id) return porId.id;

  const { data: porNombre } = await supabase
    .from('dim_cadenas')
    .select('id')
    .ilike('nombre', valor)
    .limit(1)
    .maybeSingle();
  if (porNombre?.id) return porNombre.id;

  const nuevoId = valor.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 50);
  const { data: creada, error } = await supabase
    .from('dim_cadenas')
    .insert({ id: nuevoId, nombre: valor })
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`No se pudo registrar la cadena "${valor}": ${error.message}`);
  return creada?.id ?? nuevoId;
}

// Guarda un enlace de competencia en el modelo dimensional.
// `item` viene con la forma antigua de productos_competencia:
//   { id, id_producto_propio, cadena, tipo, marca, url, laboratorio, unidosis, activo }
// Id de la publicacion (la URL monitoreada) de un enlace del panel. La vista
// productos_competencia arma el id como "<publicacion>_<producto propio>".
export function publicacionIdDe(item) {
  if (item?.publicacion_id) return Number(item.publicacion_id);
  const m = /^(\d+)_\d+$/.exec(String(item?.id || ''));
  return m ? Number(m[1]) : null;
}

// Edicion de un enlace que ya existe. Antes se trataba como uno nuevo con id
// "COMP_<id de la vista>": cada edicion (o cada activar/desactivar) creaba otro
// producto competidor y le pasaba la URL, y el anterior quedaba huerfano.
// Ahora se actualizan la publicacion y SU competidor.
async function actualizarEnlaceExistente(pub, item, cadenaId, url) {
  const { data: prod } = await supabase
    .from('dim_productos')
    .select('id, id_interno, laboratorio_id')
    .eq('id', pub.producto_id)
    .maybeSingle();
  if (!prod) throw new Error('No se encontró el producto de este enlace. Recarga la página.');

  const esCompetidor = String(prod.id_interno || '').startsWith('COMP_');
  if (esCompetidor) {
    const cambios = {};
    const marca = String(item.marca || '').trim();
    if (marca) cambios.nombre = marca.slice(0, 255);
    if (String(item.laboratorio || '').trim()) cambios.laboratorio_id = await resolverLaboratorioId(item.laboratorio);
    if (Object.keys(cambios).length > 0) {
      const { error } = await supabase.from('dim_productos').update(cambios).eq('id', prod.id);
      if (error) throw new Error(`No se pudo actualizar el competidor: ${error.message}`);
    }

    // Con que producto propio se compara (puede haber cambiado).
    const idPropio = String(item.id_producto_propio || '').trim();
    if (idPropio) {
      const { data: propio } = await supabase.from('dim_productos').select('id').eq('id_interno', idPropio).maybeSingle();
      if (!propio?.id) throw new Error(`No existe el producto propio "${idPropio}".`);
      const labId = cambios.laboratorio_id ?? prod.laboratorio_id;
      const { data: lab } = await supabase.from('dim_laboratorios').select('es_propio').eq('id', labId).maybeSingle();
      const { error: errEq } = await supabase
        .from('producto_equivalencias')
        .upsert({
          producto_propio_id: propio.id,
          producto_competidor_id: prod.id,
          tipo_equivalencia: lab?.es_propio ? 'canibalizacion_interna' : 'bioequivalente',
          activo: true
        }, { onConflict: 'producto_propio_id,producto_competidor_id' });
      if (errEq) throw new Error(`No se pudo registrar la equivalencia con "${idPropio}": ${errEq.message}`);
      // Si se cambio de producto propio, la equivalencia vieja deja de contar.
      await supabase.from('producto_equivalencias')
        .update({ activo: false })
        .eq('producto_competidor_id', prod.id)
        .neq('producto_propio_id', propio.id);
    }
  }

  const pubCambios = { activo: item.activo !== false };
  if (normalizarUrl(url) !== normalizarUrl(pub.url) || cadenaId !== pub.cadena_id) {
    pubCambios.url = url;
    pubCambios.url_normalizada = normalizarUrl(url);
    pubCambios.cadena_id = cadenaId;
    pubCambios.sku_cadena = (url.match(/\/producto\/([0-9]+)/) || [])[1] || null;
  }
  const { data: actualizada, error: errPub } = await supabase
    .from('publicaciones')
    .update(pubCambios)
    .eq('id', pub.id)
    .select('id');
  if (errPub) {
    if (errPub.code === '23505') throw new Error('Esa URL ya está registrada en esa cadena.');
    throw new Error(`No se pudo guardar la publicación: ${errPub.message}`);
  }
  if (!actualizada || actualizada.length === 0) {
    throw new Error('No se actualizó el enlace. Revisa los permisos (RLS) de publicaciones.');
  }
  return { producto_id: prod.id, publicacion_id: pub.id, cadena_id: cadenaId };
}

export async function guardarEnlaceCompetencia(item) {
  const url = String(item.url || '').trim();
  if (!url) throw new Error('El enlace no tiene URL.');

  const cadenaId = await resolverCadenaId(item.cadena);
  const esPropio = String(item.tipo || '').toLowerCase() === 'propio';

  // 0. ¿Ya existe? Por su id de publicacion (edicion desde el panel) o por
  //    cadena + URL (una importacion que repite enlaces). Si existe se
  //    actualiza; crearlo de nuevo le cambiaba el producto competidor.
  const columnasPub = 'id, producto_id, cadena_id, url';
  let existente = null;
  const pubId = publicacionIdDe(item);
  if (pubId) {
    const { data } = await supabase.from('publicaciones').select(columnasPub).eq('id', pubId).maybeSingle();
    existente = data || null;
  }
  if (!existente) {
    const { data } = await supabase
      .from('publicaciones')
      .select(columnasPub)
      .eq('cadena_id', cadenaId)
      .eq('url_normalizada', normalizarUrl(url))
      .maybeSingle();
    existente = data || null;
  }
  if (existente) return actualizarEnlaceExistente(existente, item, cadenaId, url);

  // 1. ¿De qué producto cuelga esta publicación?
  let productoId = null;

  if (esPropio) {
    // Es una URL de nuestro propio producto en una cadena: no hay competidor
    // que crear ni equivalencia que registrar.
    const { data: propio } = await supabase
      .from('dim_productos')
      .select('id')
      .eq('id_interno', String(item.id_producto_propio || '').trim())
      .maybeSingle();

    if (!propio?.id) {
      throw new Error(`No existe el producto propio "${item.id_producto_propio}" en dim_productos. Cárgalo antes que sus enlaces.`);
    }
    productoId = propio.id;
  } else {
    // 2. Producto del competidor. Se conserva el prefijo COMP_ que usó la
    //    Fase 2 para que los datos migrados y los nuevos convivan.
    const idInterno = `COMP_${item.id}`.slice(0, 150);
    const labId = await resolverLaboratorioId(item.laboratorio);

    const { data: comp, error: errComp } = await supabase
      .from('dim_productos')
      .upsert({
        id_interno: idInterno,
        nombre: (item.marca || item.ultimo_nombre || 'Producto Competidor').trim().slice(0, 255),
        laboratorio_id: labId,
        // cantidad_contenido es NOT NULL con CHECK (> 0)
        cantidad_contenido: Number(item.unidosis) > 0 ? Number(item.unidosis) : 1,
        unidad_contenido: 'unidad',
        activo: item.activo !== false
      }, { onConflict: 'id_interno' })
      .select('id')
      .maybeSingle();

    if (errComp) throw new Error(`No se pudo guardar el producto competidor: ${errComp.message}`);
    productoId = comp?.id ?? null;

    // 3. Equivalencia con el producto propio.
    const idPropio = String(item.id_producto_propio || '').trim();
    if (idPropio && productoId) {
      const { data: propio } = await supabase
        .from('dim_productos')
        .select('id')
        .eq('id_interno', idPropio)
        .maybeSingle();

      if (propio?.id && propio.id !== productoId) {
        // El trigger fn_validar_equivalencia_comercial exige
        // 'canibalizacion_interna' cuando ambos lados son marca propia.
        const { data: lab } = await supabase
          .from('dim_laboratorios')
          .select('es_propio')
          .eq('id', labId)
          .maybeSingle();

        const { error: errEq } = await supabase
          .from('producto_equivalencias')
          .upsert({
            producto_propio_id: propio.id,
            producto_competidor_id: productoId,
            tipo_equivalencia: lab?.es_propio ? 'canibalizacion_interna' : 'bioequivalente',
            activo: true
          }, { onConflict: 'producto_propio_id,producto_competidor_id' });

        if (errEq) {
          throw new Error(`No se pudo registrar la equivalencia con "${idPropio}": ${errEq.message}`);
        }
      } else if (!propio?.id) {
        throw new Error(`No existe el producto propio "${idPropio}" en dim_productos. Sin él, este competidor no se puede comparar con nada.`);
      }
    }
  }

  // 4. La publicación (la URL monitoreada).
  const { data: pub, error: errPub } = await supabase
    .from('publicaciones')
    .upsert({
      producto_id: productoId,
      cadena_id: cadenaId,
      url,
      url_normalizada: normalizarUrl(url),
      sku_cadena: (url.match(/\/producto\/([0-9]+)/) || [])[1] || null,
      activo: item.activo !== false
    }, { onConflict: 'cadena_id,url_normalizada' })
    .select('id')
    .maybeSingle();

  if (errPub) throw new Error(`No se pudo guardar la publicación: ${errPub.message}`);

  return { producto_id: productoId, publicacion_id: pub?.id ?? null, cadena_id: cadenaId };
}

// --- PRODUCTOS ---
// Reemplaza la ficha tecnica de un producto: resuelve (o crea) cada molecula
// en dim_principios_activos y reescribe sus filas en producto_principios.
//
// Se borra y se vuelve a insertar en vez de actualizar porque el numero de
// moleculas puede cambiar (un producto simple que pasa a combinado) y porque
// el esquema tiene un indice unico parcial que solo admite una fila con
// es_principal por producto: un UPDATE parcial lo violaria a mitad de camino.
// Clave para comparar nombres: sin mayusculas, tildes ni signos. Con ilike
// (que respeta las tildes) "Acetaminofen" no encontraba "Acetaminofén" y se
// creaba otra molecula; lo mismo con "Analgésicos" / "Analgesicos".
export function claveNombre(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Como se escribe una molecula nueva (igual que fn_nombre_molecula, fase 20):
// sin tildes, espacios simples y la primera letra en mayuscula; si viene toda
// en mayusculas pasa a minusculas. "LOSARTÁN POTÁSICO" -> "Losartan potasico".
export function formatearMolecula(texto) {
  const t = String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return t;
  const resto = t === t.toUpperCase() ? t.slice(1).toLowerCase() : t.slice(1);
  return t.charAt(0).toUpperCase() + resto;
}

// Las tablas de dimensiones son pequenas (decenas o cientos de filas): se
// leen enteras una vez por importacion y se compara en el navegador.
function listarDimension(cache, tabla) {
  const clave = `${tabla}|*`;
  if (cache?.has(clave)) return cache.get(clave);
  const promesa = (async () => {
    const { data, error } = await supabase.from(tabla).select('*');
    if (error) throw error;
    return data || [];
  })();
  if (cache) {
    cache.set(clave, promesa);
    promesa.catch(() => cache.delete(clave));
  }
  return promesa;
}

// Busca una fila de dimension por nombre (sin mayusculas, tildes ni signos, y
// tambien entre los sinonimos de las moleculas) y, si se pasa `crear`, la da
// de alta cuando no existe. Devuelve el id o null.
//
// Con `cache` (una importacion masiva) cada nombre se resuelve una sola vez:
// 78 productos del mismo laboratorio eran 78 consultas identicas. Se guarda
// la promesa y no el resultado para que dos filas que se procesan a la vez no
// creen la misma molecula dos veces.
function resolverDimension(cache, tabla, nombre, crear = null) {
  const buscada = claveNombre(nombre);
  const clave = `${tabla}|${buscada}`;
  if (cache?.has(clave)) return cache.get(clave);

  const promesa = (async () => {
    const filas = await listarDimension(cache, tabla);
    const hallada = filas.find(f =>
      claveNombre(f.nombre) === buscada ||
      (Array.isArray(f.sinonimos) && f.sinonimos.some(sin => claveNombre(sin) === buscada)));
    if (hallada) return hallada.id;
    if (!crear) return null;

    const { data: nuevo, error } = await supabase
      .from(tabla)
      .insert({ nombre: tabla === 'dim_principios_activos' ? formatearMolecula(nombre) : nombre, ...crear })
      .select('id, nombre')
      .maybeSingle();
    if (error) throw error;
    if (nuevo) filas.push(nuevo);
    return nuevo?.id ?? null;
  })();

  if (cache) {
    cache.set(clave, promesa);
    // Un fallo no se queda en cache: la siguiente fila lo reintenta.
    promesa.catch(() => cache.delete(clave));
  }
  return promesa;
}

async function guardarPrincipiosActivos(productoDbId, principioActivo, concentracion, cache = null) {
  const filas = parsearPrincipios(principioActivo, concentracion);

  // Sin datos utiles no se toca lo que ya hubiera: un CSV sin la columna
  // `concentracion` no debe borrar fichas cargadas antes.
  if (filas.length === 0) return;

  const conIds = [];
  for (const fila of filas) {
    const nombre = fila.nombre.trim();

    const principioId = await resolverDimension(cache, 'dim_principios_activos', nombre, {});

    if (principioId !== null) {
      conIds.push({
        producto_id: productoDbId,
        principio_activo_id: principioId,
        concentracion_valor: fila.valor,
        concentracion_unidad: fila.unidad,
        por_cantidad: fila.porCantidad ?? 1,
        por_unidad: fila.porUnidad ?? null,
        es_principal: fila.esPrincipal
      });
    }
  }

  if (conIds.length === 0) return;

  await supabase.from('producto_principios').delete().eq('producto_id', productoDbId);

  const { error } = await supabase.from('producto_principios').insert(conIds);
  if (error) throw error;
}

// Registra un PVP nuevo cerrando el anterior, en vez de insertar a ciegas.
//
// pvp_propio tiene una restriccion de exclusion (excl_pvp_sin_solape) que
// prohibe dos rangos de vigencia solapados para el mismo producto. La fila
// vigente tiene vigente_hasta NULL, o sea que cubre "desde X hasta siempre":
// cualquier insercion posterior choca con ella y Postgres responde 23P01.
//
// El codigo anterior insertaba sin mirar y sin comprobar el error, asi que al
// reimportar el CSV el precio nuevo se perdia en silencio y el panel seguia
// mostrando el viejo.
async function guardarPvpPropio(productoDbId, pvpUsd) {
  const hoy = new Date().toISOString().slice(0, 10);

  const { data: vigente, error: errLectura } = await supabase
    .from('pvp_propio')
    .select('id, pvp_usd, vigente_desde')
    .eq('producto_id', productoDbId)
    .is('vigente_hasta', null)
    .maybeSingle();

  if (errLectura) throw errLectura;

  if (vigente) {
    // Mismo precio: no hay nada que historiar.
    if (Number(vigente.pvp_usd) === Number(pvpUsd)) return;

    // Correccion del mismo dia: se edita la fila en vez de cerrarla, porque
    // chk_pvp_rango_valido exige vigente_hasta > vigente_desde y un rango de
    // duracion cero no es valido.
    if (vigente.vigente_desde === hoy) {
      const { error } = await supabase
        .from('pvp_propio')
        .update({ pvp_usd: pvpUsd })
        .eq('id', vigente.id);
      if (error) throw error;
      return;
    }

    // Cambio real: se cierra el tramo anterior hoy y empieza el nuevo.
    const { error: errCierre } = await supabase
      .from('pvp_propio')
      .update({ vigente_hasta: hoy })
      .eq('id', vigente.id);
    if (errCierre) throw errCierre;
  }

  const { error } = await supabase.from('pvp_propio').insert({
    producto_id: productoDbId,
    pvp_usd: pvpUsd,
    vigente_desde: hoy
  });
  if (error) throw error;
}

export async function dbUpsertProducto(data, cache = null) {
  const targetId = (data.id_interno || data.id || '').trim();
  const cleanData = {
    id: targetId,
    id_interno: targetId,
    nombre: data.nombre || '',
    // Canonico: codigo_barra (ver DICCIONARIO_CAMPOS.md). Se sigue aceptando
    // 'codigo_barras' en la entrada por compatibilidad con CSV antiguos.
    codigo_barra: data.codigo_barra || data.codigo_barras || '',
    laboratorio: data.laboratorio || 'La Sante',
    forma_farmaceutica: (data.forma_farmaceutica || '').trim(),
    principio_activo: data.principio_activo || '',
    concentracion: data.concentracion || '',
    tamano: data.tamano || '',
    presentacion: data.presentacion || `${data.concentracion || ''} ${data.tamano || ''}`.trim(),
    categoria: data.categoria || 'Otros',
    pvp_propio_usd: typeof data.pvp_propio_usd === 'number' ? data.pvp_propio_usd : parseFloat(data.pvp_propio_usd) || 0,
    activo: data.activo ?? true,
    market_type: data.market_type || 'GENERICO',
    unidad_negocio: data.unidad_negocio || 'La Sante',
    unidosis: data.unidosis ? parseInt(data.unidosis, 10) : null
  };

  // CSV sobre un producto que ya existe: solo se escribe lo que trae el
  // archivo. Una celda vacia significa "no cambiar", no "poner el valor por
  // defecto" (antes un laboratorio vacio pasaba a La Sante, un empaque vacio
  // a 1 unidad, etc.). El formulario y las altas nuevas siguen igual.
  const soloLoQueViene = data.parcial === true && data.existe === true;
  const texto = (v) => String(v ?? '').trim();

  let ok = false;
  let lastErr = null;

  if (isSupabaseActive()) {
    try {
      // 1. Intentar resolver o crear referencias en tablas dimensionales
      // `null` en vez de 1: dim_productos.laboratorio_id es NOT NULL, así que
      // un fallo al resolver produce un error visible en vez de colgar el
      // producto del laboratorio que casualmente tenga id = 1.
      let labId = null;
      let catId = null;
      let unId = null;
      let formaId = null;

      try {
        const labNombre = (soloLoQueViene ? texto(data.laboratorio) : cleanData.laboratorio).toUpperCase().trim();

        // Solo estos son marca propia. Antes se insertaba TODO laboratorio
        // nuevo con es_propio: true, así que Calox, Genven o Megalabs
        // terminaban contados como marca propia en los análisis.
        const LABS_PROPIOS = ['LA SANTE', 'LA SANTÉ', 'PHARMETIQUE', 'PHARMETIQUE LABS', 'PHARMETIQUELABS'];
        const esLabPropio = LABS_PROPIOS.includes(labNombre);

        // Laboratorio y forma se crean si no existen; categoria y unidad de
        // negocio no, porque son catalogos cerrados.
        if (labNombre) labId = await resolverDimension(cache, 'dim_laboratorios', labNombre, { es_propio: esLabPropio });

        const catNombre = soloLoQueViene ? texto(data.categoria) : cleanData.categoria.trim();
        if (catNombre) catId = await resolverDimension(cache, 'dim_categorias', catNombre);

        const unNombre = soloLoQueViene ? texto(data.unidad_negocio) : cleanData.unidad_negocio.trim();
        if (unNombre) unId = await resolverDimension(cache, 'dim_unidades_negocio', unNombre);

        // La forma farmaceutica SI se crea si no existe: el catalogo semilla
        // trae las habituales, pero cada laboratorio tiene las suyas y
        // obligar a darla de alta aparte rompe la importacion por CSV.
        const formaNombre = cleanData.forma_farmaceutica;
        if (formaNombre) formaId = await resolverDimension(cache, 'dim_formas_farmaceuticas', formaNombre, {});
      } catch (refErr) {
        console.warn('[Supabase] Warning resolviendo dimensiones foráneas:', refErr);
      }

      // Red de seguridad: dim_productos.laboratorio_id es NOT NULL. Si no se
      // pudo resolver ni crear el laboratorio, se cuelga de 'OTRO' (creándolo
      // si hace falta) en vez de asumir un id fijo.
      if (labId === null && !soloLoQueViene) {
        labId = await resolverDimension(cache, 'dim_laboratorios', 'OTRO', { es_propio: false });
      }

      // 2. Upsert en dim_productos
      // El empaque sale del texto de `tamano` ("120 ml" es volumen, no 120
      // tabletas). Antes se forzaba unidad_contenido a 'unidad' siempre, asi
      // que los jarabes y las cremas quedaban mal medidos para el unidosis.
      const contenido = parsearContenido(cleanData.tamano, cleanData.unidosis);

      let dimPayload;
      if (soloLoQueViene) {
        dimPayload = {};
        if (texto(data.nombre)) dimPayload.nombre = cleanData.nombre;
        if (texto(data.codigo_barra)) dimPayload.codigo_barra = cleanData.codigo_barra;
        if (labId !== null) dimPayload.laboratorio_id = labId;
        if (texto(data.tamano)) {
          dimPayload.cantidad_contenido = contenido.cantidad;
          dimPayload.unidad_contenido = contenido.unidad;
        }
      } else {
        dimPayload = {
          id_interno: cleanData.id_interno,
          nombre: cleanData.nombre,
          codigo_barra: cleanData.codigo_barra || null,
          laboratorio_id: labId,
          cantidad_contenido: contenido.cantidad,
          unidad_contenido: contenido.unidad
        };
      }

      // Solo se manda lo que se conoce. PostgREST arma el UPDATE del upsert
      // con las claves que recibe, asi que mandar null borraria la forma, la
      // categoria o la unidad de negocio cada vez que el nombre no se
      // resolviera (una tilde de diferencia basta: 'Analgésicos' no es
      // 'Analgesicos'). Lo mismo con `activo`: si no viene, se conserva, y en
      // un alta nueva lo pone la base (DEFAULT TRUE).
      if (formaId !== null) {
        dimPayload.forma_farmaceutica_id = formaId;
      }
      if (catId !== null) {
        dimPayload.categoria_id = catId;
      }
      if (unId !== null) {
        dimPayload.unidad_negocio_id = unId;
      }
      if (data.activo !== undefined && data.activo !== null) {
        dimPayload.activo = cleanData.activo;
      }
      // Igual que activo: si no viene (CSV sin la columna) se conserva.
      if (data.market_type) {
        dimPayload.tipo_mercado = String(data.market_type).toUpperCase().includes('MARCA') ? 'MARCA' : 'GENERICO';
      }

      // Con soloLoQueViene es un UPDATE: un upsert (INSERT ... ON CONFLICT)
      // exige las columnas NOT NULL aunque la fila ya exista. Si no hay nada
      // que cambiar en dim_productos (p. ej. solo PVP) se lee el id.
      const upsertDim = payload => {
        const tabla = supabase.from('dim_productos');
        if (!soloLoQueViene) {
          return tabla.upsert(payload, { onConflict: 'id_interno' }).select('id').maybeSingle();
        }
        if (Object.keys(payload).length === 0) {
          return tabla.select('id').eq('id_interno', cleanData.id_interno).maybeSingle();
        }
        return tabla.update(payload).eq('id_interno', cleanData.id_interno).select('id').maybeSingle();
      };

      let { data: dimProd, error: dimErr } = await upsertDim(dimPayload);
      // Sin la fase 18 la columna no existe: se guarda todo lo demas.
      if (dimErr && 'tipo_mercado' in dimPayload && /tipo_mercado/.test(dimErr.message || '')) {
        const { tipo_mercado: _omitido, ...sinTipo } = dimPayload;
        ({ data: dimProd, error: dimErr } = await upsertDim(sinTipo));
      }

      // 3. Ficha tecnica: molecula y dosis a producto_principios.
      // Sin esto el panel no tiene de donde sacar la concentracion y la unica
      // forma de verla vuelve a ser leerla dentro del nombre.
      if (!dimErr && dimProd?.id) {
        try {
          await guardarPrincipiosActivos(dimProd.id, cleanData.principio_activo, cleanData.concentracion, cache);
        } catch (ePrin) {
          console.warn('[Supabase] No se pudo guardar la ficha tecnica:', ePrin?.message || String(ePrin));
        }
      }

      if (!dimErr && dimProd?.id && cleanData.pvp_propio_usd > 0) {
        try {
          await guardarPvpPropio(dimProd.id, cleanData.pvp_propio_usd);
        } catch (ePvp) {
          console.warn('[Supabase] No se pudo guardar el PVP propio:', ePvp?.message || String(ePvp));
        }
      }

      // Ya no se escribe en `productos` / `legacy_productos`: la primera es
      // una vista de solo lectura desde la fase 5 y la segunda solo se lee
      // si dim_productos esta vacia. Eran hasta 15 reintentos por producto
      // y, peor, marcaban como exito un alta que habia fallado en
      // dim_productos.
      if (dimErr) {
        lastErr = dimErr;
      } else {
        ok = true;
      }
    } catch (e) {
      console.warn('[Supabase] Error en upsertProducto:', e?.message || String(e));
      lastErr = e;
    }
  }

  if (!isSupabaseActive()) {
    ok = true; // Modo local / mock
  }

  if (!ok && lastErr && isSupabaseActive()) {
    throw lastErr;
  }
}

// Alta masiva. Antes iba de uno en uno y repetia las mismas busquedas de
// laboratorio, categoria y forma en cada fila: 78 productos tardaban varios
// minutos sin dar senales de vida. Ahora:
//  - las dimensiones se resuelven una vez por nombre (cache compartida),
//  - se procesan varios productos a la vez,
//  - `onProgreso(hechos, total)` permite mostrar el avance,
//  - un producto que falla no detiene al resto: se devuelve en `errores`.
const ALTAS_EN_PARALELO = 6;

export async function dbUpsertProductosBulk(prodsList, onProgreso = null) {
  const resultado = { total: prodsList?.length || 0, ok: 0, errores: [] };
  if (!prodsList || prodsList.length === 0) return resultado;

  const cache = new Map();
  let siguiente = 0;
  let hechos = 0;

  const trabajador = async () => {
    while (siguiente < prodsList.length) {
      const item = prodsList[siguiente++];
      try {
        await dbUpsertProducto(item, cache);
        resultado.ok++;
      } catch (e) {
        resultado.errores.push({ id: item.id_interno || item.id, mensaje: e?.message || String(e) });
      }
      hechos++;
      if (onProgreso) onProgreso(hechos, prodsList.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(ALTAS_EN_PARALELO, prodsList.length) }, trabajador));
  return resultado;
}

// Nombres actuales de categorias y unidades de negocio, leidos en el momento
// (sin la cache de useDimensiones, que no se entera si se dio de alta una
// en Dimensiones hace un minuto). Sirven para avisar antes de importar.
export async function dbNombresDimensionesCerradas() {
  if (!isSupabaseActive()) return null;
  const leer = async tabla => {
    const { data, error } = await supabase.from(tabla).select('nombre');
    if (error) throw error;
    return (data || []).map(r => r.nombre).filter(Boolean);
  };
  const [categorias, unidadesNegocio] = await Promise.all([
    leer('dim_categorias'),
    leer('dim_unidades_negocio'),
  ]);
  return { categorias, unidadesNegocio };
}

// Alta o baja de varios productos en una sola peticion. Solo toca `activo`:
// no reescribe la ficha ni el PVP como haria pasar por dbUpsertProducto.
// `.select()` para saber cuantos cambiaron de verdad (un UPDATE bloqueado por
// RLS responde sin error y sin filas).
export async function dbCambiarActivoProductos(idsInternos, activo) {
  if (!isSupabaseActive() || idsInternos.length === 0) return idsInternos.length;
  const { data, error } = await supabase
    .from('dim_productos')
    .update({ activo })
    .in('id_interno', idsInternos)
    .select('id');
  if (error) throw error;
  return (data || []).length;
}

// Vacía una tabla completa reportando el resultado real.
//
// Dos trampas que hacían que estos borrados fallaran en silencio:
//  1. `.neq('id', -999999)` / `.neq('id', '___none___')` revientan con error
//     de tipo cuando la PK es uuid (scrape_runs) o texto. `.not('id','is',null)`
//     funciona con cualquier tipo de PK.
//  2. Un DELETE sin `.select()` responde 204 No Content, así que un borrado
//     bloqueado por RLS es indistinguible de uno exitoso.
async function vaciarTablaCompleta(tabla) {
  const { data, error } = await supabase
    .from(tabla)
    .delete()
    .not('id', 'is', null)
    .select('id');

  // Errores esperados tras fase5_archivo_deprecacion.sql, que NO son fallos:
  //  42P01 = la tabla ya no existe (historico_precios, productos: renombradas
  //          a legacy_* por la Fase 5).
  //  55000 = es una vista de compatibilidad no actualizable
  //          (productos_competencia pasó a ser una vista sobre
  //          v_ultimo_precio_valido, que usa DISTINCT ON). No hay nada que
  //          borrar en ella: se vacía sola al limpiar fact_precios y
  //          publicaciones, que son sus tablas de origen.
  if (error && (error.code === '42P01' || error.code === '55000')) {
    return { data: [], error: null, omitida: true };
  }

  if (error) {
    console.warn(`[Supabase] No se pudo vaciar ${tabla}:`, error.message);
  }

  return { data: data || [], error: error || null };
}

export async function dbDeleteProducto(id, linksCompetencia = []) {
  let anyError = null;
  if (isSupabaseActive()) {
    try {
      // `id` es el id_interno (texto, p.ej. "P001" o "142748"), pero
      // publicaciones.producto_id, pvp_propio.producto_id y
      // producto_equivalencias.* son BIGINT que apuntan a dim_productos.id.
      // Pasarles el texto hacía que PostgREST devolviera 400 y no se borrara
      // nada; el error se descartaba en silencio.
      const { data: dimRow } = await supabase
        .from('dim_productos')
        .select('id')
        .eq('id_interno', id)
        .maybeSingle();

      const dbId = dimRow?.id ?? null;

      // Legacy: estas dos sí usan el id de texto.
      await supabase.from('historico_precios').delete().eq('id_producto_propio', id);
      await supabase.from('productos_competencia').delete().eq('id_producto_propio', id);

      if (dbId !== null) {
        // Orden obligatorio: las FK del esquema son ON DELETE RESTRICT.
        // fact_precios cuelga de publicaciones, así que va primero.
        const { data: pubs } = await supabase
          .from('publicaciones')
          .select('id')
          .eq('producto_id', dbId);

        const pubIds = (pubs || []).map(r => r.id);
        if (pubIds.length > 0) {
          await supabase.from('fact_precios').delete().in('publicacion_id', pubIds);
        }

        await supabase.from('publicaciones').delete().eq('producto_id', dbId);
        await supabase.from('pvp_propio').delete().eq('producto_id', dbId);

        // Equivalencias en ambos sentidos (el producto puede figurar como
        // propio en unas filas y como competidor en otras).
        await supabase.from('producto_equivalencias').delete().eq('producto_propio_id', dbId);
        await supabase.from('producto_equivalencias').delete().eq('producto_competidor_id', dbId);
        await supabase.from('producto_principios').delete().eq('producto_id', dbId);
      }

      // `.select()` para saber si realmente se borró: sin él, un DELETE
      // bloqueado por RLS responde 204 y parece exitoso.
      const resDim = await supabase
        .from('dim_productos')
        .delete()
        .eq('id_interno', id)
        .select('id');

      const resProd = await supabase.from('productos').delete().eq('id', id).select('id');
      await supabase.from('legacy_productos').delete().eq('id', id);

      const borradoDim = Array.isArray(resDim.data) && resDim.data.length > 0;
      const borradoProd = Array.isArray(resProd.data) && resProd.data.length > 0;

      if (resDim.error) {
        anyError = resDim.error;
      } else if (!borradoDim && !borradoProd) {
        anyError = new Error(
          dbId === null
            ? `El producto "${id}" no existe en dim_productos.`
            : `No se eliminó "${id}". Falta la política DELETE de RLS: ejecuta fase6_correcciones.sql en Supabase.`
        );
      }
    } catch (e) {
      console.warn('[Supabase] Error en deleteProducto:', e?.message || String(e));
      anyError = e;
    }
  }

  // Limpiar cache local de sesión para forzar render fresco
  try {
    sessionStorage.removeItem('trackflow_data_cache_v3');
  } catch (_) {}

  if (anyError && isSupabaseActive()) {
    throw anyError;
  }
}

export async function dbDeleteAllProductos() {
  let anyError = null;
  if (isSupabaseActive()) {
    try {
      // Orden obligatorio: las FK del esquema son ON DELETE RESTRICT.
      const tablas = [
        'historico_precios',
        'fact_precios',
        'scrape_runs',
        'productos_competencia',
        'publicaciones',
        'pvp_propio',
        'producto_equivalencias',
        'dim_productos',
        'productos',
        'legacy_productos'
      ];

      for (const tabla of tablas) {
        const { error } = await vaciarTablaCompleta(tabla);
        if (error && !anyError) anyError = error;
      }
    } catch (e) {
      console.warn('[Supabase] Error en deleteAllProductos:', e?.message || String(e));
      anyError = e;
    }
  }

  try {
    sessionStorage.removeItem('trackflow_data_cache_v3');
  } catch (_) {}

  if (anyError && isSupabaseActive()) {
    throw anyError;
  }
}

// --- PRODUCTOS COMPETENCIA ---
export async function dbUpsertProductoCompetencia(data) {
  const cleanData = {
    id: data.id,
    publicacion_id: data.publicacion_id ?? null,
    id_producto_propio: data.id_producto_propio,
    cadena: data.cadena,
    tipo: data.tipo || 'alternativa',
    marca: (data.marca || '').trim(),
    url: (data.url || '').trim(),
    activo: data.activo ?? true,
    laboratorio: data.laboratorio?.trim() || '',
    concentracion: data.concentracion?.trim() || '',
    tamano: data.tamano?.trim() || '',
    unidosis: data.unidosis ? parseInt(data.unidosis, 10) : null,
    ultimo_precio_full_bs: data.ultimo_precio_full_bs ?? null,
    ultimo_precio_desc_bs: data.ultimo_precio_desc_bs ?? null,
    ultimo_nombre: data.ultimo_nombre ?? null,
    ultimo_scrape: data.ultimo_scrape ? (data.ultimo_scrape instanceof Date ? data.ultimo_scrape.toISOString() : data.ultimo_scrape) : null,
    estado: data.estado || 'ok',
    ultimo_error: data.ultimo_error || null
  };

  let ok = false;
  let lastErr = null;
  // Se registra aparte del `ok` general: cuando Supabase está activo es la
  // fuente de verdad, y un fallo suyo NO puede quedar tapado porque la
  // escritura a Firestore sí funcione. Ese enmascaramiento era la razón de que
  // el panel dijera "URL de competencia creada con éxito" sin haber guardado
  // nada: getFirestore() devuelve un objeto válido aunque el proyecto sea el
  // de mentira, y setDoc() resuelve contra la caché local.
  let supabaseFallo = null;

  if (isSupabaseActive()) {
    try {
      // Destino real: dim_productos + producto_equivalencias + publicaciones.
      await guardarEnlaceCompetencia(cleanData);
      ok = true;
    } catch (e) {
      console.error('[Supabase] Error en upsertProductoCompetencia:', e);
      lastErr = e;
      supabaseFallo = e;
    }

    // Compatibilidad: si productos_competencia sigue siendo una tabla real
    // (proyectos sin la Fase 5 aplicada), se mantiene actualizada. Si ya es la
    // vista de solo lectura, Postgres responde 55000 y se ignora.
    try {
      await supabaseUpsertSafe('productos_competencia', cleanData);
    } catch (e) {
      if (e?.code !== '55000' && e?.code !== '42P01') {
        console.warn('[Supabase] Aviso escribiendo tabla legacy productos_competencia:', e?.message || String(e));
      }
    }
  }

  if (!isSupabaseActive()) {
    ok = true;
  }

  // Supabase manda: si falló, se reporta aunque Firestore haya aceptado.
  if (supabaseFallo) {
    throw supabaseFallo;
  }

  if (!ok && lastErr && isSupabaseActive()) {
    throw lastErr;
  }
}

// Activar o desactivar enlaces: solo cambia publicaciones.activo. Antes se
// reescribia el enlace entero (y eso creaba un competidor nuevo).
export async function dbCambiarActivoEnlaces(enlaces, activo) {
  const ids = enlaces.map(publicacionIdDe).filter(Boolean);
  if (!isSupabaseActive() || ids.length === 0) return ids.length;
  const { data, error } = await supabase
    .from('publicaciones')
    .update({ activo })
    .in('id', ids)
    .select('id');
  if (error) throw error;
  return (data || []).length;
}

// Precio cargado a mano cuando el robot falla. Lo escribe la funcion
// fn_registrar_precio_manual (fase 21): el panel no tiene permiso para
// insertar en fact_precios, que es del scraper. Antes se escribia en
// historico_precios, una vista de solo lectura desde la fase 5: el aviso
// decia "actualizado" y no se guardaba nada.
export async function dbRegistrarPrecioManual(enlace, precioBs, precioOfertaBs = null) {
  let pubId = publicacionIdDe(enlace);
  if (!pubId && enlace?.url) {
    const { data } = await supabase
      .from('publicaciones')
      .select('id')
      .eq('url_normalizada', normalizarUrl(enlace.url))
      .limit(1)
      .maybeSingle();
    pubId = data?.id ?? null;
  }
  if (!pubId) throw new Error('No se encontró la publicación de este enlace. Recarga la página.');

  const { error } = await supabase.rpc('fn_registrar_precio_manual', {
    p_publicacion_id: pubId,
    p_precio_full_bs: precioBs,
    p_precio_desc_bs: precioOfertaBs,
  });
  if (error) {
    if (/fn_registrar_precio_manual/.test(error.message || '') || error.code === 'PGRST202') {
      throw new Error('Falta correr fase21_competencia.sql en Supabase.');
    }
    throw error;
  }
}

export async function dbUpsertCompetenciaBulk(compList) {
  if (!compList || compList.length === 0) return;

  const cleanList = compList.map(data => ({
    id: data.id,
    publicacion_id: data.publicacion_id ?? null,
    id_producto_propio: data.id_producto_propio,
    cadena: data.cadena,
    tipo: data.tipo || 'alternativa',
    marca: (data.marca || '').trim(),
    url: (data.url || '').trim(),
    activo: data.activo ?? true,
    laboratorio: data.laboratorio?.trim() || '',
    concentracion: data.concentracion?.trim() || '',
    tamano: data.tamano?.trim() || '',
    unidosis: data.unidosis ? parseInt(data.unidosis, 10) : null,
    ultimo_precio_full_bs: data.ultimo_precio_full_bs ?? null,
    ultimo_precio_desc_bs: data.ultimo_precio_desc_bs ?? null,
    ultimo_nombre: data.ultimo_nombre ?? null,
    ultimo_scrape: data.ultimo_scrape ? (data.ultimo_scrape instanceof Date ? data.ultimo_scrape.toISOString() : data.ultimo_scrape) : null,
    estado: data.estado || 'ok',
    ultimo_error: data.ultimo_error || null
  }));

  if (isSupabaseActive()) {
    let supabaseErrors = [];

    // Uno por uno y no en lotes: cada enlace resuelve laboratorio, cadena,
    // producto competidor y equivalencia, y un fallo en una fila no debe
    // tumbar la importación completa.
    for (const item of cleanList) {
      try {
        await guardarEnlaceCompetencia(item);
      } catch (e) {
        const msg = e?.message || String(e);
        console.warn(`[Supabase] Enlace "${item.id}" no se pudo guardar:`, msg);
        supabaseErrors.push(`${item.marca || item.id}: ${msg}`);
      }
    }

    // Compatibilidad con proyectos sin la Fase 5 aplicada (ver comentario en
    // dbUpsertProductoCompetencia).
    for (let i = 0; i < cleanList.length; i += 50) {
      const chunk = cleanList.slice(i, i + 50);
      try {
        await supabaseUpsertSafe('productos_competencia', chunk);
      } catch (e) {
        if (e?.code !== '55000' && e?.code !== '42P01') {
          console.warn('[Supabase] Aviso escribiendo tabla legacy productos_competencia:', e?.message || String(e));
        }
      }
    }

    if (supabaseErrors.length > 0) {
      const detalle = supabaseErrors.slice(0, 3).join(' | ');
      const resto = supabaseErrors.length > 3 ? ` (y ${supabaseErrors.length - 3} más)` : '';
      throw new Error(
        `${supabaseErrors.length} de ${cleanList.length} enlaces no se guardaron. ${detalle}${resto}`
      );
    }
  }

}

// Acepta el enlace completo (recomendado) o solo su id, por compatibilidad.
export async function dbDeleteProductoCompetencia(enlace) {
  const link = (enlace && typeof enlace === 'object') ? enlace : { id: enlace };
  const id = String(link.id || '');
  let anyError = null;

  if (isSupabaseActive()) {
    try {
      // Lo que hay que borrar es la PUBLICACIÓN (la URL monitoreada) y sus
      // capturas de precio. El producto competidor en dim_productos se
      // conserva: puede estar publicado en otras cadenas.
      let publicacionId = link.publicacion_id ?? null;

      // Si el enlace no trae el id de publicación, se busca por cadena + URL,
      // que es la clave única real de la tabla.
      if (!publicacionId && link.url) {
        const { data: pub } = await supabase
          .from('publicaciones')
          .select('id')
          .eq('url_normalizada', normalizarUrl(link.url))
          .limit(1)
          .maybeSingle();
        publicacionId = pub?.id ?? null;
      }

      if (publicacionId) {
        await supabase.from('fact_precios').delete().eq('publicacion_id', publicacionId);

        const { data, error } = await supabase
          .from('publicaciones')
          .delete()
          .eq('id', publicacionId)
          .select('id');

        if (error) {
          anyError = error;
        } else if (!Array.isArray(data) || data.length === 0) {
          anyError = new Error(
            'No se eliminó la publicación. Falta la política DELETE de RLS: ejecuta fase6_correcciones.sql en Supabase.'
          );
        }
      } else {
        anyError = new Error(
          `No se encontró la publicación de "${link.marca || id}". Recarga la página e inténtalo de nuevo.`
        );
      }

      // Tablas legacy: no existen tras la Fase 5, los errores se ignoran.
      await supabase.from('historico_precios').delete().eq('id_producto_competencia', id);
      await supabase.from('productos_competencia').delete().eq('id', id);
    } catch (e) {
      console.warn('[Supabase] Error en deleteProductoCompetencia:', e?.message || String(e));
      anyError = e;
    }
  }

  if (db && id) {
    try {
      await deleteDoc(doc(db, 'productos_competencia', id));
    } catch (e) {
      console.warn('[Firestore] Error en deleteProductoCompetencia:', e?.message || String(e));
    }
  }

  try {
    sessionStorage.removeItem('trackflow_data_cache_v3');
  } catch (_) {}

  if (anyError && isSupabaseActive()) {
    throw anyError;
  }
}

export async function dbDeleteAllProductosCompetencia() {
  let anyError = null;
  if (isSupabaseActive()) {
    try {
      for (const tabla of ['historico_precios', 'fact_precios', 'scrape_runs']) {
        const { error } = await vaciarTablaCompleta(tabla);
        if (error && !anyError) anyError = error;
      }

      const res = await vaciarTablaCompleta('productos_competencia');
      if (res.error && !anyError) anyError = res.error;
    } catch (e) {
      console.warn('[Supabase] Error en deleteAllProductosCompetencia:', e?.message || String(e));
      anyError = e;
    }
  }

  try {
    sessionStorage.removeItem('trackflow_data_cache_v3');
  } catch (_) {}

  if (anyError && isSupabaseActive()) {
    throw anyError;
  }
}

// --- HISTORICO PRECIOS ---
export async function dbClearAllHistoricoPrecios() {
  if (isSupabaseActive() && supabase) {
    try {
      await supabase.from('historico_precios').delete().neq('id', '___none___');
      await supabase.from('scrape_runs').delete().neq('id', '___none___');
    } catch (e) {
      console.warn('[Supabase] Error en dbClearAllHistoricoPrecios:', e?.message || String(e));
    }
  }

}

export async function dbClearHistoricoPrecioForProduct(id_producto_propio) {
  if (!id_producto_propio) return;

  if (isSupabaseActive() && supabase) {
    try {
      await supabase.from('historico_precios').delete().eq('id_producto_propio', id_producto_propio);
    } catch (e) {
      console.warn('[Supabase] Error en dbClearHistoricoPrecioForProduct:', e?.message || String(e));
    }
  }

}

// --- HISTORICO PRECIOS ---
export async function dbAddHistoricoPrecio(data) {
  const isoDate = data.scraped_at instanceof Date ? data.scraped_at.toISOString() : (data.scraped_at || new Date().toISOString());

  if (isSupabaseActive()) {
    try {
      await supabaseInsertSafe('historico_precios', {
        prod_comp_id: data.prod_comp_id,
        id_producto_propio: data.id_producto_propio || '',
        cadena: data.cadena || '',
        marca: data.marca || '',
        nombre: data.nombre || data.marca || '',
        precio_full_bs: data.precio_full_bs,
        precio_desc_bs: data.precio_desc_bs || null,
        tiene_descuento: Boolean(data.tiene_descuento),
        scraped_at: isoDate,
        run_id: data.run_id || `run_${Date.now()}`
      });
    } catch (e) {
      console.warn('[Supabase] Error insertando historico_precios:', e?.message || String(e));
    }
  }

}

// --- SCRAPE RUNS ---
export async function dbAddScrapeRun(data) {
  const isoDate = data.started_at instanceof Date ? data.started_at.toISOString() : (data.started_at || new Date().toISOString());

  if (isSupabaseActive()) {
    try {
      await supabaseInsertSafe('scrape_runs', {
        run_id: data.run_id,
        started_at: isoDate,
        total: data.total || 0,
        ok: data.ok || 0,
        errores: data.errores || 0,
        status: data.status || 'exitosa',
        trigger: data.trigger || 'manual_app'
      });
    } catch (e) {
      console.warn('[Supabase] Error insertando scrape_runs:', e?.message || String(e));
    }
  }

}

// --- CADENAS ---
export async function dbUpsertCadena(data) {
  if (isSupabaseActive()) {
    try {
      await supabaseUpsertSafe('cadenas', data);
    } catch (e) {
      console.warn('[Supabase] Error upsertCadena:', e?.message || String(e));
    }
  }

}

// Cadenas: se escribe en dim_cadenas, no en la vista 'cadenas' (no tiene
// color_hex y los errores se perdian). Cada escritura pide .select() para
// notar si RLS la bloqueo sin decir nada.
export async function dbGuardarCadena(data, { nueva = false } = {}) {
  if (!isSupabaseActive()) return;
  const fila = {
    nombre: data.nombre,
    website: data.website || null,
    modulo_scraper: data.modulo_scraper || null,
    activo: data.activo !== false,
    color_hex: data.color_hex ? String(data.color_hex).toUpperCase() : null,
  };
  const escribir = (f) => (nueva
    ? supabase.from('dim_cadenas').insert({ id: data.id, ...f }).select('id')
    : supabase.from('dim_cadenas').update(f).eq('id', data.id).select('id'));
  let { data: filas, error } = await escribir(fila);
  // Sin la columna color_hex (base muy vieja) se guarda lo demas.
  if (error && /color_hex/.test(error.message || '')) {
    const { color_hex: _sinColor, ...resto } = fila;
    ({ data: filas, error } = await escribir(resto));
  }
  if (error) {
    if (error.code === '23505' && /color/i.test(error.message || '')) throw new Error('Ese color ya lo usa otra cadena. Elige otro.');
    if (error.code === '23505') throw new Error('Ya existe una cadena con ese nombre.');
    throw new Error(error.message);
  }
  if (!filas || filas.length === 0) throw new Error('La base de datos no aceptó el cambio (permisos). No se guardó nada.');
}

export async function dbCambiarActivoCadena(id, activo) {
  if (!isSupabaseActive()) return;
  const { data, error } = await supabase.from('dim_cadenas').update({ activo }).eq('id', id).select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error('La base de datos no aceptó el cambio (permisos).');
}

// Solo se borra una cadena sin enlaces; con enlaces se da de baja.
export async function dbEliminarCadena(id) {
  if (!isSupabaseActive()) return;
  const { count, error: errCount } = await supabase.from('publicaciones').select('id', { count: 'exact', head: true }).eq('cadena_id', id);
  if (errCount) throw new Error(errCount.message);
  if (count > 0) throw new Error(`Tiene ${count} enlaces: no se puede eliminar sin perder su historial. Dala de baja.`);
  const { data, error } = await supabase.from('dim_cadenas').delete().eq('id', id).select('id');
  if (error) throw new Error(error.message);
  if (!data || data.length === 0) throw new Error('La base de datos no permite eliminar cadenas (permisos). Dala de baja en su lugar.');
}

export async function dbDeleteCadena(id) {
  if (isSupabaseActive()) {
    try {
      await supabase.from('cadenas').delete().eq('id', id);
    } catch (e) {
      console.warn('[Supabase] Error deleteCadena:', e?.message || String(e));
    }
  }

}

// --- USUARIOS ---
export async function dbUpsertUsuario(data) {
  if (isSupabaseActive()) {
    try {
      await supabaseUpsertSafe('usuarios', data);
    } catch (e) {
      console.warn('[Supabase] Error upsertUsuario:', e?.message || String(e));
    }
  }

}

export async function dbDeleteUsuario(id) {
  if (isSupabaseActive()) {
    try {
      await supabase.from('usuarios').delete().eq('id', id);
    } catch (e) {
      console.warn('[Supabase] Error deleteUsuario:', e?.message || String(e));
    }
  }

}
