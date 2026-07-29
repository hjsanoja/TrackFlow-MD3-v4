import { collection, doc, setDoc, addDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';

export async function scrapeSingleUrl(url) {
  try {
    const res = await fetch(`/api/scrape-url?url=${encodeURIComponent(url)}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    return data;
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

export async function executeLiveBatchScrape(items, onProgress) {
  if (!Array.isArray(items) || items.length === 0) {
    return { total: 0, ok: 0, errores: 0, results: [] };
  }

  const runId = `run_${Date.now()}`;
  const now = new Date();
  let okCount = 0;
  let errorCount = 0;
  const results = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (onProgress) {
      onProgress({
        index: i + 1,
        total: items.length,
        item,
        status: `Extrayendo enlace ${i + 1}/${items.length}: [${item.cadena || 'Competencia'}] ${item.marca || ''}...`
      });
    }

    if (!item.url || !item.url.startsWith('http')) {
      errorCount++;
      results.push({ ...item, error: 'URL no válida o vacía' });
      continue;
    }

    const scrapedData = await scrapeSingleUrl(item.url);
    const hasError = Boolean(scrapedData.error || !scrapedData.precio_full_bs);

    if (hasError) {
      errorCount++;
    } else {
      okCount++;
    }

    const resultItem = {
      ...item,
      ...scrapedData,
      ultimo_scrape: now,
      estado: hasError ? 'error' : 'ok',
      ultimo_error: scrapedData.error || (hasError ? 'Precio no encontrado en la página' : null)
    };

    results.push(resultItem);

    // Persistir resultado individual en Firestore si db está configurado
    if (db && item.id) {
      try {
        const itemRef = doc(db, 'productos_competencia', item.id);
        await setDoc(itemRef, {
          ultimo_precio_full_bs: scrapedData.precio_full_bs || item.ultimo_precio_full_bs || null,
          ultimo_precio_desc_bs: scrapedData.precio_desc_bs || item.ultimo_precio_desc_bs || null,
          ultimo_nombre: scrapedData.nombre || item.ultimo_nombre || null,
          ultimo_scrape: now,
          estado: hasError ? 'error' : 'ok',
          ultimo_error: scrapedData.error || null
        }, { merge: true });

        if (!hasError && scrapedData.precio_full_bs) {
          await addDoc(collection(db, 'historico_precios'), {
            prod_comp_id: item.id,
            id_producto_propio: item.id_producto_propio || '',
            cadena: item.cadena || '',
            marca: item.marca || '',
            nombre: scrapedData.nombre || item.marca || '',
            precio_full_bs: scrapedData.precio_full_bs,
            precio_desc_bs: scrapedData.precio_desc_bs || null,
            tiene_descuento: Boolean(scrapedData.tiene_descuento),
            scraped_at: now,
            run_id: runId
          });
        }
      } catch (fErr) {
        console.warn(`No se pudo actualizar Firestore para ${item.id}:`, fErr?.message || String(fErr));
      }
    }
  }

  // Guardar registro de la corrida completa
  if (db) {
    try {
      await setDoc(doc(db, 'scrape_runs', runId), {
        run_id: runId,
        started_at: now,
        total: items.length,
        ok: okCount,
        errores: errorCount,
        status: 'exitosa'
      });
    } catch (rErr) {
      console.warn('Aviso guardando scrape_runs:', rErr?.message || String(rErr));
    }
  }

  return {
    runId,
    total: items.length,
    ok: okCount,
    errores: errorCount,
    results
  };
}
