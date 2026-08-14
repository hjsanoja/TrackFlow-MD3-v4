import { dbUpsertProductoCompetencia, dbAddHistoricoPrecio, dbAddScrapeRun } from './dbClient';

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
    
    // Normalizar precios y detectar promociones/descuentos de forma robusta
    let precioFull = scrapedData.precio_full_bs ? Number(scrapedData.precio_full_bs) : null;
    let precioDesc = scrapedData.precio_desc_bs ? Number(scrapedData.precio_desc_bs) : null;

    if (precioFull && precioDesc && precioDesc >= precioFull) {
      // Si el precio de descuento resulta igual o mayor al full, normalizamos
      precioDesc = null;
    } else if (precioFull && !precioDesc && scrapedData.precio_oferta) {
      const oferta = Number(scrapedData.precio_oferta);
      if (oferta < precioFull) precioDesc = oferta;
    }

    const tieneDescuento = Boolean(precioDesc && precioDesc < precioFull);
    const hasError = Boolean(scrapedData.error || !precioFull);

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

    // Persistir resultado individual en Supabase & Firestore vía dbClient
    if (item.id) {
      try {
        await dbUpsertProductoCompetencia({
          ...item,
          ultimo_precio_full_bs: scrapedData.precio_full_bs || item.ultimo_precio_full_bs || null,
          ultimo_precio_desc_bs: scrapedData.precio_desc_bs || item.ultimo_precio_desc_bs || null,
          ultimo_nombre: scrapedData.nombre || item.ultimo_nombre || null,
          ultimo_scrape: now,
          estado: hasError ? 'error' : 'ok',
          ultimo_error: scrapedData.error || null
        });

        if (!hasError && scrapedData.precio_full_bs) {
          await dbAddHistoricoPrecio({
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
        console.warn(`No se pudo actualizar BD para ${item.id}:`, fErr?.message || String(fErr));
      }
    }
  }

  // Guardar registro de la corrida completa
  try {
    await dbAddScrapeRun({
      run_id: runId,
      started_at: now,
      total: items.length,
      ok: okCount,
      errores: errorCount,
      status: 'exitosa',
      trigger: 'manual_app'
    });
  } catch (rErr) {
    console.warn('Aviso guardando scrape_runs:', rErr?.message || String(rErr));
  }

  return {
    runId,
    total: items.length,
    ok: okCount,
    errores: errorCount,
    results
  };
}

