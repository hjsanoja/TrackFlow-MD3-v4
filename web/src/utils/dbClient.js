import { supabase, isSupabaseActive } from '../supabase';
import { db } from '../firebase';
import { collection, doc, setDoc, deleteDoc, getDocs, writeBatch, addDoc } from 'firebase/firestore';

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
      await supabaseUpsertSafe('productos', cleanData);
      ok = true;
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

  const cleanList = prodsList.map(data => {
    const targetId = (data.id_interno || data.id || '').trim();
    return {
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
  });

  if (isSupabaseActive()) {
    let supabaseErrors = [];
    for (let i = 0; i < cleanList.length; i += 50) {
      const chunk = cleanList.slice(i, i + 50);
      try {
        await supabaseUpsertSafe('productos', chunk);
      } catch (e) {
        console.warn('[Supabase] Error en dbUpsertProductosBulk chunk:', e?.message || String(e));
        supabaseErrors.push(e?.message || String(e));
      }
    }
    if (supabaseErrors.length > 0 && !db) {
      throw new Error(`Error al guardar en Supabase: ${supabaseErrors[0]}`);
    }
  }

  if (db) {
    for (let i = 0; i < cleanList.length; i += 500) {
      const chunk = cleanList.slice(i, i + 500);
      try {
        const batch = writeBatch(db);
        chunk.forEach(p => {
          batch.set(doc(db, 'productos', p.id), p, { merge: true });
        });
        await batch.commit();
      } catch (e) {
        console.warn('[Firestore] Error en dbUpsertProductosBulk chunk:', e?.message || String(e));
      }
    }
  }
}

export async function dbDeleteProducto(id, linksCompetencia = []) {
  if (isSupabaseActive()) {
    try {
      await supabase.from('productos_competencia').delete().eq('id_producto_propio', id);
      await supabase.from('productos').delete().eq('id', id);
    } catch (e) {
      console.warn('[Supabase] Error en deleteProducto:', e?.message || String(e));
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
}

export async function dbDeleteAllProductos() {
  if (isSupabaseActive()) {
    try {
      await supabase.from('historico_precios').delete().neq('id', '___none___');
      await supabase.from('scrape_runs').delete().neq('id', '___none___');
      await supabase.from('productos_competencia').delete().neq('id', '___none___');
      await supabase.from('productos').delete().neq('id', '___none___');
    } catch (e) {
      console.warn('[Supabase] Error en deleteAllProductos:', e?.message || String(e));
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
  if (isSupabaseActive()) {
    try {
      await supabase.from('productos_competencia').delete().eq('id', id);
    } catch (e) {
      console.warn('[Supabase] Error en deleteProductoCompetencia:', e?.message || String(e));
    }
  }

  if (db) {
    try {
      await deleteDoc(doc(db, 'productos_competencia', id));
    } catch (e) {
      console.warn('[Firestore] Error en deleteProductoCompetencia:', e?.message || String(e));
    }
  }
}

export async function dbDeleteAllProductosCompetencia() {
  if (isSupabaseActive()) {
    try {
      await supabase.from('historico_precios').delete().neq('id', '___none___');
      await supabase.from('scrape_runs').delete().neq('id', '___none___');
      await supabase.from('productos_competencia').delete().neq('id', '___none___');
    } catch (e) {
      console.warn('[Supabase] Error en deleteAllProductosCompetencia:', e?.message || String(e));
    }
  }

  if (db) {
    try {
      const collections = ['productos_competencia', 'historico_precios', 'scrape_runs'];
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
      console.warn('[Firestore] Aviso en deleteAllProductosCompetencia:', e?.message || String(e));
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
