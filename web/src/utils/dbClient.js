import { supabase, isSupabaseActive } from '../supabase';
import { db } from '../firebase';
import { collection, doc, setDoc, deleteDoc, getDocs, writeBatch, addDoc, query, where } from 'firebase/firestore';

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

// --- PRODUCTOS ---
export async function dbUpsertProducto(data) {
  const targetId = (data.id_interno || data.id || '').trim();
  const cleanData = {
    id: targetId,
    id_interno: targetId,
    nombre: data.nombre || '',
    codigo_barra: data.codigo_barra || data.codigo_barras || '',
    laboratorio: data.laboratorio || 'La Sante',
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
      let labId = 1;
      let catId = null;
      let unId = null;

      try {
        const labNombre = cleanData.laboratorio.toUpperCase().trim();
        const { data: labData } = await supabase.from('dim_laboratorios').select('id').ilike('nombre', labNombre).maybeSingle();
        if (labData?.id) {
          labId = labData.id;
        } else {
          const { data: newLab } = await supabase.from('dim_laboratorios').insert({ nombre: labNombre, es_propio: true }).select('id').maybeSingle();
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
      } catch (refErr) {
        console.warn('[Supabase] Warning resolviendo dimensiones foráneas:', refErr);
      }

      // 2. Upsert en dim_productos
      const dimPayload = {
        id_interno: cleanData.id_interno,
        nombre: cleanData.nombre,
        codigo_barra: cleanData.codigo_barra || null,
        laboratorio_id: labId,
        categoria_id: catId,
        unidad_negocio_id: unId,
        cantidad_contenido: cleanData.unidosis || 1,
        unidad_contenido: 'unidad',
        activo: cleanData.activo
      };

      const { data: dimProd, error: dimErr } = await supabase
        .from('dim_productos')
        .upsert(dimPayload, { onConflict: 'id_interno' })
        .select('id')
        .maybeSingle();

      if (!dimErr && dimProd?.id && cleanData.pvp_propio_usd > 0) {
        // Upsert en pvp_propio
        await supabase.from('pvp_propio').insert({
          producto_id: dimProd.id,
          pvp_usd: cleanData.pvp_propio_usd,
          vigente_desde: new Date().toISOString().slice(0, 10)
        });
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

  if (db) {
    try {
      await setDoc(doc(db, 'productos', cleanData.id), cleanData, { merge: true });
      ok = true;
    } catch (e) {
      console.warn('[Firestore] Error en upsertProducto:', e?.message || String(e));
      if (!lastErr) lastErr = e;
    }
  }

  if (!isSupabaseActive() && !db) {
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

export async function dbDeleteProducto(id, linksCompetencia = []) {
  let anyError = null;
  if (isSupabaseActive()) {
    try {
      // Eliminar dependencias primero en orden de integridad referencial
      await supabase.from('historico_precios').delete().eq('id_producto_propio', id);
      await supabase.from('productos_competencia').delete().eq('id_producto_propio', id);
      await supabase.from('publicaciones').delete().eq('producto_id', id);
      
      // Eliminar pvp propio si tiene db_id numérico o id_interno
      await supabase.from('pvp_propio').delete().eq('producto_id', id);

      const resDim = await supabase.from('dim_productos').delete().or(`id_interno.eq.${id},id.eq.${id}`);
      const resProd = await supabase.from('productos').delete().eq('id', id);
      await supabase.from('legacy_productos').delete().eq('id', id);

      if (resDim.error && resProd.error) {
        anyError = resDim.error;
      }
    } catch (e) {
      console.warn('[Supabase] Error en deleteProducto:', e?.message || String(e));
      anyError = e;
    }
  }

  if (db) {
    try {
      await deleteDoc(doc(db, 'productos', id));
      if (linksCompetencia.length > 0) {
        const batch = writeBatch(db);
        linksCompetencia.forEach(l => batch.delete(doc(db, 'productos_competencia', l.id)));
        await batch.commit();
      }
    } catch (e) {
      console.warn('[Firestore] Error en deleteProducto:', e?.message || String(e));
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
      await supabase.from('historico_precios').delete().neq('id', '___none___');
      await supabase.from('fact_precios').delete().neq('id', -999999);
      await supabase.from('scrape_runs').delete().neq('id', '___none___');
      await supabase.from('productos_competencia').delete().neq('id', '___none___');
      await supabase.from('publicaciones').delete().neq('id', -999999);
      await supabase.from('pvp_propio').delete().neq('id', -999999);
      await supabase.from('producto_equivalencias').delete().neq('id', -999999);
      await supabase.from('dim_productos').delete().neq('id', -999999);
      await supabase.from('productos').delete().neq('id', '___none___');
      await supabase.from('legacy_productos').delete().neq('id', '___none___');
    } catch (e) {
      console.warn('[Supabase] Error en deleteAllProductos:', e?.message || String(e));
      anyError = e;
    }
  }

  if (db) {
    try {
      const collections = ['productos', 'productos_competencia', 'historico_precios', 'scrape_runs'];
      for (const colName of collections) {
        const snap = await getDocs(collection(db, colName));
        const docs = snap.docs;
        for (let i = 0; i < docs.length; i += 500) {
          const chunk = docs.slice(i, i + 500);
          const batch = writeBatch(db);
          chunk.forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      }
    } catch (e) {
      console.warn('[Firestore] Aviso en deleteAllProductos (Firestore omitido):', e?.message || String(e));
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

  if (isSupabaseActive()) {
    try {
      await supabaseUpsertSafe('productos_competencia', cleanData);
      ok = true;
    } catch (e) {
      console.warn('[Supabase] Error en upsertProductoCompetencia:', e?.message || String(e));
      lastErr = e;
    }
  }

  if (db) {
    try {
      await setDoc(doc(db, 'productos_competencia', cleanData.id), cleanData, { merge: true });
      ok = true;
    } catch (e) {
      console.warn('[Firestore] Error en upsertProductoCompetencia:', e?.message || String(e));
      if (!lastErr) lastErr = e;
    }
  }

  if (!isSupabaseActive() && !db) {
    ok = true;
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
    for (let i = 0; i < cleanList.length; i += 50) {
      const chunk = cleanList.slice(i, i + 50);
      try {
        await supabaseUpsertSafe('productos_competencia', chunk);
      } catch (e) {
        console.warn('[Supabase] Error en dbUpsertCompetenciaBulk chunk:', e?.message || String(e));
        supabaseErrors.push(e?.message || String(e));
      }
    }
    if (supabaseErrors.length > 0 && !db) {
      throw new Error(`Error al guardar competencia en Supabase: ${supabaseErrors[0]}`);
    }
  }

  if (db) {
    for (let i = 0; i < cleanList.length; i += 500) {
      const chunk = cleanList.slice(i, i + 500);
      try {
        const batch = writeBatch(db);
        chunk.forEach(c => {
          batch.set(doc(db, 'productos_competencia', c.id), c, { merge: true });
        });
        await batch.commit();
      } catch (e) {
        console.warn('[Firestore] Error en dbUpsertCompetenciaBulk chunk:', e?.message || String(e));
      }
    }
  }
}

export async function dbDeleteProductoCompetencia(id) {
  let anyError = null;
  if (isSupabaseActive()) {
    try {
      await supabase.from('historico_precios').delete().eq('id_producto_competencia', id);
      const res = await supabase.from('productos_competencia').delete().eq('id', id);
      if (res.error) anyError = res.error;
    } catch (e) {
      console.warn('[Supabase] Error en deleteProductoCompetencia:', e?.message || String(e));
      anyError = e;
    }
  }

  if (db) {
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
      await supabase.from('historico_precios').delete().neq('id', '___none___');
      await supabase.from('scrape_runs').delete().neq('id', '___none___');
      const res = await supabase.from('productos_competencia').delete().neq('id', '___none___');
      if (res.error) anyError = res.error;
    } catch (e) {
      console.warn('[Supabase] Error en deleteAllProductosCompetencia:', e?.message || String(e));
      anyError = e;
    }
  }

  if (db) {
    try {
      const collections = ['productos_competencia', 'historico_precios', 'scrape_runs'];
      for (const colName of collections) {
        try {
          const snap = await getDocs(collection(db, colName));
          const docs = snap.docs;
          for (let i = 0; i < docs.length; i += 500) {
            const chunk = docs.slice(i, i + 500);
            const batch = writeBatch(db);
            chunk.forEach(d => batch.delete(d.ref));
            await batch.commit();
          }
        } catch (_) {}
      }
    } catch (e) {
      console.warn('[Firestore] Aviso en deleteAllProductosCompetencia:', e?.message || String(e));
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

  if (db) {
    try {
      const collections = ['historico_precios', 'scrape_runs'];
      for (const colName of collections) {
        try {
          const snap = await getDocs(collection(db, colName));
          const docs = snap.docs;
          for (let i = 0; i < docs.length; i += 500) {
            const chunk = docs.slice(i, i + 500);
            const batch = writeBatch(db);
            chunk.forEach(d => batch.delete(d.ref));
            await batch.commit();
          }
        } catch (innerErr) {
          console.warn(`[Firestore] Permiso o error al vaciar colección ${colName}:`, innerErr?.message || String(innerErr));
        }
      }
    } catch (e) {
      console.warn('[Firestore] Aviso en dbClearAllHistoricoPrecios:', e?.message || String(e));
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

  if (db) {
    try {
      const q = query(
        collection(db, 'historico_precios'),
        where('id_producto_propio', '==', id_producto_propio)
      );
      const snap = await getDocs(q);
      const docs = snap.docs;
      for (let i = 0; i < docs.length; i += 500) {
        const chunk = docs.slice(i, i + 500);
        const batch = writeBatch(db);
        chunk.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    } catch (e) {
      console.warn('[Firestore] Permiso o aviso en dbClearHistoricoPrecioForProduct:', e?.message || String(e));
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

  if (db) {
    try {
      await addDoc(collection(db, 'historico_precios'), {
        prod_comp_id: data.prod_comp_id,
        id_producto_propio: data.id_producto_propio || '',
        cadena: data.cadena || '',
        marca: data.marca || '',
        nombre: data.nombre || data.marca || '',
        precio_full_bs: data.precio_full_bs,
        precio_desc_bs: data.precio_desc_bs || null,
        tiene_descuento: Boolean(data.tiene_descuento),
        scraped_at: data.scraped_at instanceof Date ? data.scraped_at : new Date(isoDate),
        run_id: data.run_id || `run_${Date.now()}`
      });
    } catch (e) {
      console.warn('[Firestore] Error insertando historico_precios:', e?.message || String(e));
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

  if (db) {
    try {
      await setDoc(doc(db, 'scrape_runs', data.run_id), {
        run_id: data.run_id,
        started_at: data.started_at instanceof Date ? data.started_at : new Date(isoDate),
        total: data.total || 0,
        ok: data.ok || 0,
        errores: data.errores || 0,
        status: data.status || 'exitosa',
        trigger: data.trigger || 'manual_app'
      });
    } catch (e) {
      console.warn('[Firestore] Error insertando scrape_runs:', e?.message || String(e));
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

  if (db) {
    try {
      await setDoc(doc(db, 'cadenas', data.id), data, { merge: true });
    } catch (e) {
      console.warn('[Firestore] Error upsertCadena:', e?.message || String(e));
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

  if (db) {
    try {
      await deleteDoc(doc(db, 'cadenas', id));
    } catch (e) {
      console.warn('[Firestore] Error deleteCadena:', e?.message || String(e));
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

  if (db) {
    try {
      await setDoc(doc(db, 'usuarios', data.id), data, { merge: true });
    } catch (e) {
      console.warn('[Firestore] Error upsertUsuario:', e?.message || String(e));
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

  if (db) {
    try {
      await deleteDoc(doc(db, 'usuarios', id));
    } catch (e) {
      console.warn('[Firestore] Error deleteUsuario:', e?.message || String(e));
    }
  }
}
