import { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase, isSupabaseActive } from '../supabase';
import { registrarColoresCadenas } from '../utils/brandColors';
import { leerCache, guardarCache } from '../utils/cacheDatos';

const DataContext = createContext(null);

const DEFAULT_PRODUCTS = [
  { id: 'P001', id_interno: 'P001', nombre: 'Acetaminofén 650mg La Santé', laboratorio: 'La Sante', principio_activo: 'Acetaminofen', concentracion: '650mg', tamano: '650 mg x 10 tabletas', categoria: 'Analgésicos', pvp_propio_usd: 1.00, activo: true, market_type: 'MARCA', unidad_negocio: 'La Sante', unidosis: 10 },
  { id: 'P002', id_interno: 'P002', nombre: 'Diclofenac Potásico 50mg La Santé', laboratorio: 'La Sante', principio_activo: 'Diclofenac Potásico', concentracion: '50mg', tamano: '50 mg x 10 tabletas', categoria: 'Analgésicos', pvp_propio_usd: 1.20, activo: true, market_type: 'GENERICO', unidad_negocio: 'La Sante', unidosis: 10 },
  { id: 'P003', id_interno: 'P003', nombre: 'Tiocolfen Pharmetique Labs', laboratorio: 'Pharmetique', principio_activo: 'Ibuprofeno + Tiocolchicosido', concentracion: '600mg + 4mg', tamano: '600mg x 10 cápsulas', categoria: 'Analgésicos', pvp_propio_usd: 2.50, activo: true, market_type: 'MARCA', unidad_negocio: 'Pharmetique', unidosis: 10 },
  { id: 'P004', id_interno: 'P004', nombre: 'Ibuprofeno 800mg La Santé', laboratorio: 'La Sante', principio_activo: 'Ibuprofeno', concentracion: '800mg', tamano: '800 mg x 10 tabletas', categoria: 'Analgésicos', pvp_propio_usd: 1.50, activo: true, market_type: 'GENERICO', unidad_negocio: 'La Sante', unidosis: 10 },
  { id: 'P005', id_interno: 'P005', nombre: 'Vitamina C 500mg Naranja La Santé', laboratorio: 'La Sante', principio_activo: 'Vitamina C', concentracion: '500mg', tamano: '500 mg x 10 tabletas Naranja', categoria: 'Vitaminas', pvp_propio_usd: 1.10, activo: true, market_type: 'MARCA', unidad_negocio: 'OTC', unidosis: 10 },
  { id: 'P006', id_interno: 'P006', nombre: 'Losartán Potásico 50mg La Santé', laboratorio: 'La Sante', principio_activo: 'Losartán Potásico', concentracion: '50mg', tamano: '50 mg x 30 tabletas', categoria: 'Cardiovascular', pvp_propio_usd: 3.20, activo: true, market_type: 'GENERICO', unidad_negocio: 'La Sante', unidosis: 30 },
  { id: 'P007', id_interno: 'P007', nombre: 'Omeprazol 20mg La Santé', laboratorio: 'La Sante', principio_activo: 'Omeprazol', concentracion: '20mg', tamano: '20 mg x 14 cápsulas', categoria: 'Gastrointestinal', pvp_propio_usd: 2.10, activo: true, market_type: 'GENERICO', unidad_negocio: 'La Sante', unidosis: 14 },
  { id: 'P008', id_interno: 'P008', nombre: 'Amoxicilina 500mg La Santé', laboratorio: 'La Sante', principio_activo: 'Amoxicilina', concentracion: '500mg', tamano: '500 mg x 12 cápsulas', categoria: 'Antibióticos', pvp_propio_usd: 2.80, activo: true, market_type: 'GENERICO', unidad_negocio: 'La Sante', unidosis: 12 }
];

const DEFAULT_COMPETENCIA = [
  { id: 'PC001', id_producto_propio: 'P001', cadena: 'Farmatodo', tipo: 'propio', marca: 'La Sante', ultimo_precio_full_bs: 45.0, ultimo_precio_desc_bs: 40.5, url: 'https://www.farmatodo.com.ve', activo: true, unidosis: 10 },
  { id: 'PC002', id_producto_propio: 'P001', cadena: 'Farmatodo', tipo: 'alternativa', marca: 'Calox', ultimo_precio_full_bs: 42.0, ultimo_precio_desc_bs: 38.0, url: 'https://www.farmatodo.com.ve', activo: true, unidosis: 10 },
  { id: 'PC003', id_producto_propio: 'P001', cadena: 'Locatel', tipo: 'alternativa', marca: 'Atamel', ultimo_precio_full_bs: 48.0, ultimo_precio_desc_bs: 45.0, url: 'https://www.locatel.com.ve', activo: true, unidosis: 10 },
  { id: 'PC004', id_producto_propio: 'P002', cadena: 'Farmatodo', tipo: 'propio', marca: 'La Sante', ultimo_precio_full_bs: 54.0, ultimo_precio_desc_bs: 50.0, url: 'https://www.farmatodo.com.ve', activo: true, unidosis: 10 },
  { id: 'PC005', id_producto_propio: 'P002', cadena: 'Locatel', tipo: 'alternativa', marca: 'Genven', ultimo_precio_full_bs: 58.0, ultimo_precio_desc_bs: 54.0, url: 'https://www.locatel.com.ve', activo: true, unidosis: 10 },
  { id: 'PC006', id_producto_propio: 'P003', cadena: 'FarmaDON', tipo: 'propio', marca: 'Pharmetique', ultimo_precio_full_bs: 112.5, ultimo_precio_desc_bs: 100.0, url: 'https://www.farmadon.com', activo: true, unidosis: 10 },
  { id: 'PC007', id_producto_propio: 'P003', cadena: 'Farmatodo', tipo: 'alternativa', marca: 'Behrens', ultimo_precio_full_bs: 125.0, ultimo_precio_desc_bs: 118.0, url: 'https://www.farmatodo.com.ve', activo: true, unidosis: 10 },
  { id: 'PC008', id_producto_propio: 'P004', cadena: 'Farmatodo', tipo: 'propio', marca: 'La Sante', ultimo_precio_full_bs: 67.5, ultimo_precio_desc_bs: 60.0, url: 'https://www.farmatodo.com.ve', activo: true, unidosis: 10 },
  { id: 'PC009', id_producto_propio: 'P005', cadena: 'Farmatodo', tipo: 'propio', marca: 'La Sante', ultimo_precio_full_bs: 49.5, ultimo_precio_desc_bs: 45.0, url: 'https://www.farmatodo.com.ve', activo: true, unidosis: 10 },
  { id: 'PC010', id_producto_propio: 'P005', cadena: 'Locatel', tipo: 'alternativa', marca: 'Leti', ultimo_precio_full_bs: 52.0, ultimo_precio_desc_bs: 48.0, url: 'https://www.locatel.com.ve', activo: true, unidosis: 10 },
  { id: 'PC011', id_producto_propio: 'P006', cadena: 'Farmatodo', tipo: 'propio', marca: 'La Sante', ultimo_precio_full_bs: 144.0, ultimo_precio_desc_bs: 135.0, url: 'https://www.farmatodo.com.ve', activo: true, unidosis: 30 },
  { id: 'PC012', id_producto_propio: 'P006', cadena: 'Grupo San Ignacio', tipo: 'alternativa', marca: 'Merck', ultimo_precio_full_bs: 160.0, ultimo_precio_desc_bs: 150.0, url: 'https://www.gruposanignacio.com', activo: true, unidosis: 30 }
];

const DEFAULT_CADENAS = [
  { id: 'C001', nombre: 'Farmatodo', website: 'https://www.farmatodo.com.ve', modulo_scraper: 'farmatodo', activo: true },
  { id: 'C002', nombre: 'Locatel', website: 'https://www.locatel.com.ve', modulo_scraper: 'locatel', activo: true },
  { id: 'C003', nombre: 'FarmaDON', website: 'https://www.farmadon.com', modulo_scraper: 'farmadon', activo: true },
  { id: 'C004', nombre: 'Grupo San Ignacio', website: 'https://www.gruposanignacio.com', modulo_scraper: 'grupo_san_ignacio', activo: true },
  { id: 'C005', nombre: 'Farmacias Xana', website: 'https://www.farmaciasxana.com', modulo_scraper: 'xana', activo: true },
  { id: 'C006', nombre: 'FarmaGo', website: 'https://www.farmago.com', modulo_scraper: 'farmago', activo: true }
];

const DEFAULT_RATES = [
  { dayKey: '01/07/2026', fecha: '01 jul', valor: 712.40, source: 'oficial', rawDate: new Date('2026-07-01') },
  { dayKey: '05/07/2026', fecha: '05 jul', valor: 716.20, source: 'oficial', rawDate: new Date('2026-07-05') },
  { dayKey: '10/07/2026', fecha: '10 jul', valor: 720.10, source: 'oficial', rawDate: new Date('2026-07-10') },
  { dayKey: '15/07/2026', fecha: '15 jul', valor: 725.50, source: 'oficial', rawDate: new Date('2026-07-15') },
  { dayKey: '20/07/2026', fecha: '20 jul', valor: 731.80, source: 'oficial', rawDate: new Date('2026-07-20') },
  { dayKey: '25/07/2026', fecha: '25 jul', valor: 736.00, source: 'oficial', rawDate: new Date('2026-07-25') },
  { dayKey: '26/07/2026', fecha: '26 jul', valor: 738.20, source: 'oficial', rawDate: new Date('2026-07-26') },
  { dayKey: '27/07/2026', fecha: '27 jul', valor: 740.00, source: 'oficial', rawDate: new Date('2026-07-27') },
  { dayKey: '28/07/2026', fecha: '28 jul', valor: 741.50, source: 'oficial', rawDate: new Date('2026-07-28') },
  { dayKey: '29/07/2026', fecha: '29 jul', valor: 742.80, source: 'auto', rawDate: new Date('2026-07-29') },
  { dayKey: '30/07/2026', fecha: '30 jul', valor: 744.23, source: 'oficial', rawDate: new Date('2026-07-30') },
];

const DEFAULT_USUARIOS = [
  { id: 'admin_at_trackflow_com', email: 'admin@trackflow.com', nombre: 'Hernando Sanoja', rol: 'administrador', activo: true },
  { id: 'analista_at_trackflow_com', email: 'analista@trackflow.com', nombre: 'Analista de Precios', rol: 'analista', activo: true }
];

async function fetchAllSupabaseRows(tableName, pageSize = 1000, aplicarFiltros = null) {
  if (!isSupabaseActive() || !supabase) return [];
  let allRows = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    let consulta = supabase.from(tableName).select('*');
    // `aplicarFiltros` permite acotar por fecha u ordenar sin perder la
    // paginación, que es lo que evita el tope de filas de PostgREST.
    if (typeof aplicarFiltros === 'function') {
      consulta = aplicarFiltros(consulta);
    }
    const { data, error } = await consulta.range(from, to);

    if (error) {
      console.warn(`[Supabase fetchAll] Error consultando ${tableName} (página ${page}):`, error.message || error);
      break;
    }

    if (data && data.length > 0) {
      allRows = allRows.concat(data);
      if (data.length < pageSize) {
        hasMore = false;
      } else {
        page++;
      }
    } else {
      hasMore = false;
    }
  }

  return allRows;
}

// Cargar catálogo de productos propios desde dim_productos con soporte relacional
// Días de histórico que se traen al navegador. Con 506 publicaciones, el tope
// plano de 5.000 filas que había antes cubría apenas ~10 días, así que las
// comparaciones mes contra mes no tenían con qué comparar.
export const DIAS_HISTORICO = 180;

async function fetchHistorico() {
  if (!isSupabaseActive() || !supabase) return [];

  const desde = new Date();
  desde.setDate(desde.getDate() - DIAS_HISTORICO);
  const desdeIso = desde.toISOString();

  const filas = await fetchAllSupabaseRows('historico_precios', 1000, (q) =>
    q.gte('scraped_at', desdeIso).order('scraped_at', { ascending: false })
  );

  if (filas.length > 0) return filas;

  // Respaldo: proyectos donde la Fase 5 no se aplicó y la tabla legacy sigue
  // siendo la fuente. Si tampoco existe, se devuelve vacío sin romper nada.
  return fetchAllSupabaseRows('legacy_historico_precios', 1000, (q) =>
    q.gte('scraped_at', desdeIso).order('scraped_at', { ascending: false })
  );
}

// El <h1> de Farmatodo trae un separador decorativo que el scraper guardaba
// literal, de ahí nombres como "//Cefotas 250mg/5ml Suspensión Oral".
export function limpiarNombreCapturado(nombre) {
  if (!nombre) return '';
  return String(nombre).replace(/^[\s/|·•\-]+/, '').trim();
}

// La molecula y la concentracion viven en producto_principios, no en el nombre.
// Un producto puede tener varios principios (combinaciones), asi que se ordenan
// dejando el rector primero y se unen con " + ":
//   "Losartan + Hidroclorotiazida"  /  "50 mg + 12.5 mg"
// Cuando la concentracion es por volumen (jarabes, soluciones) se expresa como
// "250 mg/5 ml", que es como se lee en el empaque.
function ordenarPrincipios(filas) {
  return [...(filas || [])].sort((a, b) => {
    if (a.es_principal !== b.es_principal) return a.es_principal ? -1 : 1;
    const na = a.dim_principios_activos?.nombre || '';
    const nb = b.dim_principios_activos?.nombre || '';
    return na.localeCompare(nb, 'es');
  });
}

function formatearPrincipioActivo(filas) {
  const nombres = ordenarPrincipios(filas)
    .map(f => (f.dim_principios_activos?.nombre || '').trim())
    .filter(Boolean);
  return nombres.join(' + ');
}

function formatearConcentracion(filas) {
  const partes = ordenarPrincipios(filas).map(f => {
    const valor = Number(f.concentracion_valor);
    if (!Number.isFinite(valor) || valor <= 0) return '';
    // NUMERIC(10,2) llega como "300.00"; se muestra "300" y se conserva "12.5".
    const cantidad = String(Number(valor.toFixed(2)));
    const base = `${cantidad} ${f.concentracion_unidad || ''}`.trim();
    const porCantidad = Number(f.por_cantidad);
    if (f.por_unidad && Number.isFinite(porCantidad) && porCantidad > 0) {
      return `${base}/${String(Number(porCantidad.toFixed(2)))} ${f.por_unidad}`;
    }
    return base;
  }).filter(Boolean);
  return partes.join(' + ');
}

async function fetchDimProductos() {
  if (!isSupabaseActive() || !supabase) return [];
  try {
    // tipo_mercado lo crea fase18_tipo_mercado.sql. Si todavia no se corrio,
    // pedirlo haria fallar la consulta entera y el catalogo saldria vacio:
    // se reintenta sin esa columna y se calcula como antes.
    const columnas = (conTipo) => `
        id,
        id_interno,
        codigo_barra,
        nombre,
        activo,${conTipo ? '\n        tipo_mercado,' : ''}
        cantidad_contenido,
        unidad_contenido,
        laboratorio_id,
        dim_laboratorios ( id, nombre, es_propio ),
        dim_categorias ( nombre ),
        dim_unidades_negocio ( nombre ),
        dim_formas_farmaceuticas ( nombre ),
        producto_principios (
          concentracion_valor,
          concentracion_unidad,
          por_cantidad,
          por_unidad,
          es_principal,
          dim_principios_activos ( nombre )
        ),
        pvp_propio ( pvp_usd, vigente_desde, vigente_hasta )
      `;
    let { data, error } = await supabase.from('dim_productos').select(columnas(true));
    if (error && /tipo_mercado/.test(error.message || '')) {
      ({ data, error } = await supabase.from('dim_productos').select(columnas(false)));
    }

    if (!error && Array.isArray(data) && data.length > 0) {
      // Desde la Fase 2, dim_productos contiene TAMBIÉN los productos de la
      // competencia, migrados con el prefijo 'COMP_' en id_interno
      // (ver fase2_migracion_datos.sql, bloque 3). No son productos propios:
      // su relación con el catálogo propio vive en producto_equivalencias y sus
      // precios llegan por productos_competencia / v_ultimo_precio_valido.
      // Si no se filtran aquí, el Dashboard, Productos y Mapa de Calor los
      // pintan como filas propias (con el laboratorio del competidor y
      // "Rank: 1°/1", porque solo tienen una publicación).
      const esProductoCompetidor = (d) =>
        String(d.id_interno || '').toUpperCase().startsWith('COMP_');

      return data.filter(d => !esProductoCompetidor(d)).map(d => {
        // Encontrar PVP vigente actual
        let pvpUsd = 0;
        if (Array.isArray(d.pvp_propio) && d.pvp_propio.length > 0) {
          const sortedPvp = [...d.pvp_propio].sort((a, b) => new Date(b.vigente_desde) - new Date(a.vigente_desde));
          pvpUsd = Number(sortedPvp[0].pvp_usd) || 0;
        }

        const labNombre = d.dim_laboratorios?.nombre || 'La Sante';
        const unNombre = d.dim_unidades_negocio?.nombre || 'La Sante';
        // `!== false` daba true cuando el JOIN con dim_laboratorios venía vacío,
        // marcando como propio cualquier producto sin laboratorio resuelto.
        const isPropio = d.dim_laboratorios?.es_propio === true;

        return {
          id: d.id_interno || String(d.id),
          id_interno: d.id_interno || String(d.id),
          db_id: d.id,
          nombre: limpiarNombreCapturado(d.nombre),
          codigo_barra: d.codigo_barra || '',
          laboratorio: labNombre,
          es_propio: isPropio,
          categoria: d.dim_categorias?.nombre || 'Otros',
          unidad_negocio: unNombre,
          forma_farmaceutica: d.dim_formas_farmaceuticas?.nombre || '',
          principio_activo: formatearPrincipioActivo(d.producto_principios),
          concentracion: formatearConcentracion(d.producto_principios),
          tamano: d.cantidad_contenido ? `${Number(d.cantidad_contenido)} ${d.unidad_contenido || 'unidad'}` : '',
          unidosis: d.cantidad_contenido ? Number(d.cantidad_contenido) : null,
          pvp_propio_usd: pvpUsd,
          activo: d.activo !== false,
          market_type: d.tipo_mercado
            || ((unNombre.toLowerCase().includes('pharmetique') || labNombre.toLowerCase().includes('pharmetique')) ? 'MARCA' : 'GENERICO')
        };
      });
    }

    // Fallback: probar tabla productos o legacy_productos si dim_productos estuviese vacía
    const fallbackData = await fetchAllSupabaseRows('productos');
    if (fallbackData && fallbackData.length > 0) return fallbackData;

    const legacyData = await fetchAllSupabaseRows('legacy_productos');
    if (legacyData && legacyData.length > 0) return legacyData;

    return [];
  } catch (err) {
    console.warn('[Supabase] Error en fetchDimProductos, probando tabla fallback:', err);
    return fetchAllSupabaseRows('productos');
  }
}

// Enlaces con su ultimo precio valido (v_ultimo_precio_valido) mezclado.
function unirPrecios(pcData, validPricesData) {
  const validMapByUrl = new Map();
  const validMapById = new Map();
  (Array.isArray(validPricesData) ? validPricesData : []).forEach(v => {
    if (v.url) validMapByUrl.set(String(v.url).replace(/\?.*$/, '').trim().toLowerCase(), v);
    if (v.id_interno) validMapById.set(String(v.id_interno).trim(), v);
  });
  return (Array.isArray(pcData) ? pcData : []).map(p => {
    const urlNorm = String(p.url || '').replace(/\?.*$/, '').trim().toLowerCase();
    const vm = validMapByUrl.get(urlNorm) || validMapById.get(String(p.id).trim());
    if (!vm) return { ...p, id: p.id || '', id_producto_propio: p.id_producto_propio || '' };
    return {
      ...p,
      id: p.id || '',
      id_producto_propio: p.id_producto_propio || vm.id_interno || '',
      cadena: p.cadena || vm.cadena_id,
      ultimo_precio_full_bs: vm.precio_full_bs ?? p.ultimo_precio_full_bs,
      ultimo_precio_desc_bs: vm.precio_desc_bs ?? p.ultimo_precio_desc_bs,
      ultimo_precio_full_usd: (vm.precio_full_bs && vm.tasa_bcv)
        ? Number((vm.precio_full_bs / vm.tasa_bcv).toFixed(2))
        : p.ultimo_precio_full_usd,
      ultimo_precio_desc_usd: (vm.precio_desc_bs && vm.tasa_bcv)
        ? Number((vm.precio_desc_bs / vm.tasa_bcv).toFixed(2))
        : p.ultimo_precio_desc_usd,
      ultimo_nombre: limpiarNombreCapturado(vm.producto_nombre || p.ultimo_nombre),
      ultimo_scrape: vm.fecha_captura || p.ultimo_scrape,
      tiene_descuento: Boolean(vm.tiene_promocion ?? p.tiene_descuento),
      tipo_promo: vm.promo_texto_raw || vm.tipo_promocion_codigo || p.tipo_promo,
      precio_efectivo_unidad_usd: vm.precio_efectivo_unidad_usd,
      laboratorio: vm.laboratorio_nombre || p.laboratorio,
      es_propio: vm.es_propio,
      publicacion_id: vm.publicacion_id
    };
  });
}

function ordenarProductos(pData) {
  return (Array.isArray(pData) ? pData : []).map(p => ({
    ...p,
    id: p.id || p.id_interno || p.ID || '',
    id_interno: p.id_interno || p.id || p.ID || ''
  })).sort((a, b) => (a.id_interno || a.id || '').localeCompare(b.id_interno || b.id || ''));
}

function ordenarCadenas(cData) {
  return [...(Array.isArray(cData) ? cData : [])].map(c => ({
    id: c.id,
    nombre: c.nombre || c.id,
    website: c.website || '',
    color_hex: c.color_hex || '',
    sigla: c.sigla || '',
    modulo_scraper: c.modulo_scraper || c.scraper_modulo || '',
    activo: c.activo !== false
  })).sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
}

// Una tasa por dia (la ultima del dia), en orden de fecha.
function procesarTasas(bData) {
  if (!Array.isArray(bData) || bData.length === 0) return [];
  const porDia = {};
  for (const d of bData) {
    const fechaStr = d.fecha || d.updated_at;
    const rawDate = fechaStr ? new Date(fechaStr) : new Date();
    const dayKey = rawDate.toLocaleDateString('es-VE', { year: 'numeric', month: '2-digit', day: '2-digit' });
    const tasa = {
      dayKey,
      fecha: rawDate.toLocaleDateString('es-VE', { month: 'short', day: 'numeric' }) || '—',
      valor: Number(d.tasa ?? d.value ?? d.valor ?? 0),
      source: d.fuente || d.source || 'oficial',
      rawDate,
    };
    if (!porDia[dayKey] || tasa.rawDate > porDia[dayKey].rawDate) porDia[dayKey] = tasa;
  }
  return Object.values(porDia).sort((a, b) => a.rawDate - b.rawDate);
}

// La ultima corrida del robot: scrape_runs guarda UNA fila por cadena, asi
// que se juntan las de la misma corrida (mismo github_run_id o, si falta,
// las que empezaron en las 3 horas anteriores a la mas reciente).
export function resumirCorrida(filas) {
  const orden = (Array.isArray(filas) ? filas : [])
    .filter(r => r.started_at)
    .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
  if (orden.length === 0) return null;
  const primera = orden[0];
  const inicio = new Date(primera.started_at).getTime();
  const misma = (r) => (primera.github_run_id && r.github_run_id
    ? r.github_run_id === primera.github_run_id
    : new Date(r.started_at).getTime() >= inicio - 3 * 3600 * 1000);
  const porCadena = new Map();
  for (const r of orden) {
    if (!misma(r) || porCadena.has(r.cadena_id)) continue;
    porCadena.set(r.cadena_id, r);
  }
  const cadenas = [...porCadena.values()];
  const suma = (k) => cadenas.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const fines = cadenas.map(r => r.finished_at).filter(Boolean).map(f => new Date(f).getTime());
  return {
    started_at: new Date(Math.min(...cadenas.map(r => new Date(r.started_at).getTime()))),
    finished_at: fines.length === cadenas.length && fines.length ? new Date(Math.max(...fines)) : null,
    total: suma('total_urls'),
    exitosos: suma('exitosos'),
    fallidos: suma('fallidos'),
    en_proceso: cadenas.some(r => r.estado === 'en_proceso'),
    tipo_trigger: primera.tipo_trigger,
    cadenas,
  };
}

// Las fechas vuelven del almacenamiento local como texto.
function revivirCorrida(c) {
  if (!c) return null;
  return { ...c, started_at: c.started_at ? new Date(c.started_at) : null, finished_at: c.finished_at ? new Date(c.finished_at) : null };
}
function revivirTasas(t) {
  return (Array.isArray(t) ? t : []).map(r => ({ ...r, rawDate: new Date(r.rawDate) }));
}

export function DataProvider({ children, user }) {
  // La copia local (utils/cacheDatos) se lee ANTES del primer pintado: si hay
  // una, el panel aparece al instante y los datos frescos llegan despues.
  const [cache] = useState(() => leerCache(user?.email));

  const [productos, setProductos] = useState(() => cache?.productos || []);
  const [productosCompetencia, setProductosCompetencia] = useState(() => cache?.productosCompetencia || []);
  const [ultimosPreciosValidos, setUltimosPreciosValidos] = useState([]);
  // Precio actual y de referencia a 1, 7 y 15 días, calculado por Postgres.
  const [variaciones, setVariaciones] = useState(() => cache?.variaciones || []);
  const [cadenas, setCadenas] = useState(() => cache?.cadenas || []);
  // El historico completo NO se baja al abrir (eran ~90 peticiones): lo pide
  // quien lo necesita con cargarHistorico().
  const [historicoPrecios, setHistoricoPrecios] = useState([]);
  const [historicoEstado, setHistoricoEstado] = useState('sin_cargar'); // sin_cargar | cargando | listo
  const [bcvRates, setBcvRates] = useState(() => revivirTasas(cache?.bcvRates));
  const [ultimaCorrida, setUltimaCorrida] = useState(() => revivirCorrida(cache?.ultimaCorrida));
  const [usuarios, setUsuarios] = useState(() => cache?.usuarios || []);
  // Los colores de las cadenas se registran durante el render (no en un
  // efecto) para que los graficos hijos ya los encuentren al pintarse.
  useMemo(() => registrarColoresCadenas(cadenas), [cadenas]);
  const [loadingInitial, setLoadingInitial] = useState(!cache);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadedOnce, setIsLoadedOnce] = useState(Boolean(cache));
  // En una ref y no en el estado: si cargarTodo dependiera de isLoadedOnce,
  // cambiaria al terminar la primera carga y el efecto la lanzaria OTRA vez
  // (asi pasaba: todo se descargaba dos veces al abrir).
  const cargadoRef = useRef(Boolean(cache));
  const historicoRef = useRef(null);
  const email = user?.email || '';

  // Si la app está en blanco, no inyectar mock data por defecto
  const applyDefaultSeed = useCallback(() => {
    setProductos([]);
    setProductosCompetencia([]);
    setCadenas(DEFAULT_CADENAS);
    setHistoricoPrecios([]);
    setBcvRates(DEFAULT_RATES);
    setUltimaCorrida(null);
    setUsuarios(DEFAULT_USUARIOS);
    setIsLoadedOnce(true);
    setLoadingInitial(false);
    setIsRefreshing(false);
  }, []);

  const cargarTodo = useCallback(async (showSilently = false) => {
    if (!showSilently && !cargadoRef.current) {
      setLoadingInitial(true);
    } else {
      setIsRefreshing(true);
    }

    if (!isSupabaseActive()) {
      // Sin Supabase configurado no hay de dónde leer: estado vacío y listo.
      applyDefaultSeed();
      return;
    }

    try {
      const [
        pData,
        pcData,
        validPricesData,
        cData,
        uData,
        variacionData,
        { data: rData },
        { data: bData }
      ] = await Promise.all([
        fetchDimProductos(),
        fetchAllSupabaseRows('productos_competencia'),
        fetchAllSupabaseRows('v_ultimo_precio_valido'),
        fetchAllSupabaseRows('dim_cadenas').then(res => (res && res.length > 0) ? res : fetchAllSupabaseRows('cadenas')),
        fetchAllSupabaseRows('usuarios'),
        // ~506 filas con el precio actual y los de hace 1, 7 y 15 días ya
        // resueltos por Postgres (fase 11).
        fetchAllSupabaseRows('v_variacion'),
        // Una fila por cadena y corrida: con 60 alcanza para la ultima.
        supabase.from('scrape_runs').select('*').order('started_at', { ascending: false }).limit(60),
        supabase.from('dim_tasa_bcv').select('*').order('fecha', { ascending: true })
          .then(res => (res.data && res.data.length > 0) ? res : supabase.from('bcv_rates').select('*').order('updated_at', { ascending: true }))
      ]);

      const prods = ordenarProductos(pData);
      const pc = unirPrecios(pcData, validPricesData);
      const cSorted = ordenarCadenas(cData);
      const tasas = procesarTasas(bData);
      const corrida = resumirCorrida(rData);
      const uSorted = [...(Array.isArray(uData) ? uData : [])].sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      const vars = Array.isArray(variacionData) ? variacionData : [];

      setProductos(prods);
      setProductosCompetencia(pc);
      setUltimosPreciosValidos(Array.isArray(validPricesData) ? validPricesData : []);
      setVariaciones(vars);
      setCadenas(cSorted);
      setUltimaCorrida(corrida);
      setBcvRates(tasas.length ? tasas : DEFAULT_RATES);
      setUsuarios(uSorted);

      guardarCache(email, {
        productos: prods,
        productosCompetencia: pc,
        variaciones: vars,
        cadenas: cSorted,
        bcvRates: tasas,
        ultimaCorrida: corrida,
        usuarios: uSorted,
      });

      // Si alguien ya pidio el historico, se refresca tambien.
      if (historicoRef.current) {
        historicoRef.current = null;
        cargarHistoricoRef.current?.();
      }
    } catch (sbErr) {
      console.warn('Supabase retornó error o estado vacío:', sbErr);
      // Con una copia local a la vista, mejor dejarla que vaciar la pantalla.
      if (!cargadoRef.current) {
        setProductos([]);
        setProductosCompetencia([]);
      }
    } finally {
      cargadoRef.current = true;
      setIsLoadedOnce(true);
      setLoadingInitial(false);
      setIsRefreshing(false);
    }
  }, [applyDefaultSeed, email]);

  // Historico de precios (180 dias) bajo demanda: la ficha del producto y
  // algunas pantallas de Experimental. Una sola descarga aunque lo pidan varias.
  const cargarHistorico = useCallback(() => {
    if (historicoRef.current) return historicoRef.current;
    setHistoricoEstado('cargando');
    historicoRef.current = fetchHistorico()
      .then(filas => {
        setHistoricoPrecios((filas || []).map(d => ({ ...d, scraped_at: d.scraped_at ? new Date(d.scraped_at) : null })));
        setHistoricoEstado('listo');
      })
      .catch(e => {
        console.warn('Aviso cargando histórico:', e?.message || String(e));
        historicoRef.current = null;
        setHistoricoEstado('sin_cargar');
      });
    return historicoRef.current;
  }, []);
  const cargarHistoricoRef = useRef(cargarHistorico);
  cargarHistoricoRef.current = cargarHistorico;

  // Una sola carga al entrar (con copia local, en segundo plano).
  useEffect(() => {
    cargarTodo(Boolean(cache));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshProductos = useCallback(async () => {
    try {
      if (isSupabaseActive()) {
        const data = await fetchDimProductos();
        if (Array.isArray(data)) {
          setProductos(ordenarProductos(data));
          return;
        }
      }
      setProductos([]);
    } catch (e) {
      console.warn('Aviso actualizando productos:', e?.message || String(e));
    }
  }, []);

  const refreshCompetencia = useCallback(async () => {
    try {
      if (isSupabaseActive()) {
        const [data, validData] = await Promise.all([
          fetchAllSupabaseRows('productos_competencia'),
          fetchAllSupabaseRows('v_ultimo_precio_valido')
        ]);
        if (Array.isArray(data)) {
          setProductosCompetencia(unirPrecios(data, validData));
          return;
        }
      }
      setProductosCompetencia([]);
    } catch (e) {
      console.warn('Aviso actualizando competencia:', e?.message || String(e));
    }
  }, []);

  const refreshCadenas = useCallback(async () => {
    try {
      if (isSupabaseActive()) {
        let data = await fetchAllSupabaseRows('dim_cadenas');
        if (!data || !data.length) {
          data = await fetchAllSupabaseRows('cadenas');
        }
        if (Array.isArray(data)) {
          setCadenas(ordenarCadenas(data));
          return;
        }
      }
    } catch (e) {
      console.warn('Aviso actualizando cadenas:', e?.message || String(e));
    }
  }, []);

  const refreshUsuarios = useCallback(async () => {
    try {
      if (isSupabaseActive()) {
        const data = await fetchAllSupabaseRows('usuarios');
        if (Array.isArray(data)) {
          const uDocs = [...data].sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
          setUsuarios(uDocs);
          return;
        }
      }
    } catch (e) {
      console.warn('Aviso actualizando usuarios:', e?.message || String(e));
    }
  }, []);

  const vaciarHistorico = useCallback(() => {
    setHistoricoPrecios([]);
    setUltimaCorrida(null);
  }, []);

  const value = useMemo(() => ({
    productos,
    productosCompetencia,
    ultimosPreciosValidos,
    variaciones,
    cadenas,
    historicoPrecios,
    historicoEstado,
    cargarHistorico,
    bcvRates,
    ultimaCorrida,
    usuarios,
    loadingInitial,
    isRefreshing,
    isLoadedOnce,
    refreshData: cargarTodo,
    refreshProductos,
    refreshCompetencia,
    refreshCadenas,
    refreshUsuarios,
    setProductos,
    setProductosCompetencia,
    setUltimosPreciosValidos,
    setHistoricoPrecios,
    setUltimaCorrida,
    vaciarHistorico
  }), [
    productos,
    productosCompetencia,
    ultimosPreciosValidos,
    variaciones,
    cadenas,
    historicoPrecios,
    historicoEstado,
    cargarHistorico,
    bcvRates,
    ultimaCorrida,
    usuarios,
    loadingInitial,
    isRefreshing,
    isLoadedOnce,
    cargarTodo,
    refreshProductos,
    refreshCompetencia,
    refreshCadenas,
    refreshUsuarios,
    vaciarHistorico
  ]);

  return (
    <DataContext.Provider value={value}>
      {children}
    </DataContext.Provider>
  );
}

export function useData() {
  const ctx = useContext(DataContext);
  if (!ctx) {
    throw new Error('useData debe ser usado dentro de un DataProvider');
  }
  return ctx;
}

