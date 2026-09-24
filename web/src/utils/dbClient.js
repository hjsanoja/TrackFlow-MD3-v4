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

  const { data: existente } = await supabase
    .from('dim_laboratorios')
    .select('id')
    .ilike('nombre', labNombre)
    .limit(1)
    .maybeSingle();

  if (existente?.id) return existente.id;

  const { data: nuevo, error } = await supabase
    .from('dim_laboratorios')
    .insert({ nombre: labNombre, es_propio: LABS_PROPIOS.includes(labNombre) })
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`No se pudo crear el laboratorio "${labNombre}": ${error.message}`);
  return nuevo?.id ?? null;
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
export async function guardarEnlaceCompetencia(item) {
  const url = String(item.url || '').trim();
  if (!url) throw new Error('El enlace no tiene URL.');

  const cadenaId = await resolverCadenaId(item.cadena);
  const esPropio = String(item.tipo || '').toLowerCase() === 'propio';

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
async function guardarPrincipiosActivos(productoDbId, principioActivo, concentracion) {
  const filas = parsearPrincipios(principioActivo, concentracion);

  // Sin datos utiles no se toca lo que ya hubiera: un CSV sin la columna
  // `concentracion` no debe borrar fichas cargadas antes.
  if (filas.length === 0) return;

  const conIds = [];
  for (const fila of filas) {
    const nombre = fila.nombre.trim();

    const { data: existente } = await supabase
      .from('dim_principios_activos')
      .select('id')
      .ilike('nombre', nombre)
      .limit(1)
      .maybeSingle();

    let principioId = existente?.id ?? null;
    if (principioId === null) {
      const { data: nuevo, error } = await supabase
        .from('dim_principios_activos')
        .insert({ nombre })
        .select('id')
        .maybeSingle();
      if (error) throw error;
      principioId = nuevo?.id ?? null;
    }

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

export async function dbUpsertProducto(data) {
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
        const labNombre = cleanData.laboratorio.toUpperCase().trim();

        // Solo estos son marca propia. Antes se insertaba TODO laboratorio
        // nuevo con es_propio: true, así que Calox, Genven o Megalabs
        // terminaban contados como marca propia en los análisis.
        const LABS_PROPIOS = ['LA SANTE', 'LA SANTÉ', 'PHARMETIQUE', 'PHARMETIQUE LABS', 'PHARMETIQUELABS'];
        const esLabPropio = LABS_PROPIOS.includes(labNombre);

        // `.limit(1)` antes de maybeSingle(): si hay dos laboratorios con
        // nombres equivalentes, maybeSingle() devolvía error y se creaba un
        // duplicado más.
        const { data: labData } = await supabase
          .from('dim_laboratorios')
          .select('id')
          .ilike('nombre', labNombre)
          .limit(1)
          .maybeSingle();

        if (labData?.id) {
          labId = labData.id;
        } else {
          const { data: newLab } = await supabase
            .from('dim_laboratorios')
            .insert({ nombre: labNombre, es_propio: esLabPropio })
            .select('id')
            .maybeSingle();
          if (newLab?.id) labId = newLab.id;
        }

        const catNombre = cleanData.categoria.trim();
        if (catNombre) {
          const { data: catData } = await supabase.from('dim_categorias').select('id').ilike('nombre', catNombre).maybeSingle();
          if (catData?.id) catId = catData.id;
        }

        const unNombre = cleanData.unidad_negocio.trim();
        if (unNombre) {
          const { data: unData } = await supabase.from('dim_unidades_negocio').select('id').ilike('nombre', unNombre).maybeSingle();
          if (unData?.id) unId = unData.id;
        }

        // La forma farmaceutica SI se crea si no existe: el catalogo semilla
        // trae las habituales, pero cada laboratorio tiene las suyas y
        // obligar a darla de alta aparte rompe la importacion por CSV.
        const formaNombre = cleanData.forma_farmaceutica;
        if (formaNombre) {
          const { data: formaData } = await supabase
            .from('dim_formas_farmaceuticas')
            .select('id')
            .ilike('nombre', formaNombre)
            .limit(1)
            .maybeSingle();

          if (formaData?.id) {
            formaId = formaData.id;
          } else {
            const { data: nuevaForma } = await supabase
              .from('dim_formas_farmaceuticas')
              .insert({ nombre: formaNombre })
              .select('id')
              .maybeSingle();
            if (nuevaForma?.id) formaId = nuevaForma.id;
          }
        }
      } catch (refErr) {
        console.warn('[Supabase] Warning resolviendo dimensiones foráneas:', refErr);
      }

      // Red de seguridad: dim_productos.laboratorio_id es NOT NULL. Si no se
      // pudo resolver ni crear el laboratorio, se cuelga de 'OTRO' (creándolo
      // si hace falta) en vez de asumir un id fijo.
      if (labId === null) {
        const { data: otroLab } = await supabase
          .from('dim_laboratorios')
          .select('id')
          .ilike('nombre', 'OTRO')
          .limit(1)
          .maybeSingle();

        if (otroLab?.id) {
          labId = otroLab.id;
        } else {
          const { data: nuevoOtro } = await supabase
            .from('dim_laboratorios')
            .insert({ nombre: 'OTRO', es_propio: false })
            .select('id')
            .maybeSingle();
          if (nuevoOtro?.id) labId = nuevoOtro.id;
        }
      }

      // 2. Upsert en dim_productos
      // El empaque sale del texto de `tamano` ("120 ml" es volumen, no 120
      // tabletas). Antes se forzaba unidad_contenido a 'unidad' siempre, asi
      // que los jarabes y las cremas quedaban mal medidos para el unidosis.
      const contenido = parsearContenido(cleanData.tamano, cleanData.unidosis);

      const dimPayload = {
        id_interno: cleanData.id_interno,
        nombre: cleanData.nombre,
        codigo_barra: cleanData.codigo_barra || null,
        laboratorio_id: labId,
        categoria_id: catId,
        unidad_negocio_id: unId,
        cantidad_contenido: contenido.cantidad,
        unidad_contenido: contenido.unidad,
        activo: cleanData.activo
      };

      // Solo se manda la forma cuando se conoce. PostgREST arma el UPDATE del
      // upsert con las claves que recibe, asi que mandar null la borraria en
      // cada alta que no traiga la columna.
      if (formaId !== null) {
        dimPayload.forma_farmaceutica_id = formaId;
      }

      const { data: dimProd, error: dimErr } = await supabase
        .from('dim_productos')
        .upsert(dimPayload, { onConflict: 'id_interno' })
        .select('id')
        .maybeSingle();

      // 3. Ficha tecnica: molecula y dosis a producto_principios.
      // Sin esto el panel no tiene de donde sacar la concentracion y la unica
      // forma de verla vuelve a ser leerla dentro del nombre.
      if (!dimErr && dimProd?.id) {
        try {
          await guardarPrincipiosActivos(dimProd.id, cleanData.principio_activo, cleanData.concentracion);
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

      // También mantener tabla productos / legacy_productos para retrocompatibilidad
      try {
        await supabaseUpsertSafe('productos', cleanData);
      } catch (_) {
        try {
          await supabaseUpsertSafe('legacy_productos', cleanData);
        } catch (eLegacy) {
          // Si dim_productos tuvo éxito, no es bloqueante
          if (dimErr) console.warn('[Supabase] Error en legacy_productos:', eLegacy);
        }
      }

      if (!dimErr) {
        ok = true;
      } else {
        console.warn('[Supabase] Error en dim_productos upsert:', dimErr);
        // Si falló dim_productos pero funcionó legacy, marcar ok
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

export async function dbUpsertProductosBulk(prodsList) {
  if (!prodsList || prodsList.length === 0) return;

  for (const item of prodsList) {
    await dbUpsertProducto(item);
  }
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

export async function dbUpsertCompetenciaBulk(compList) {
  if (!compList || compList.length === 0) return;

  const cleanList = compList.map(data => ({
    id: data.id,
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
