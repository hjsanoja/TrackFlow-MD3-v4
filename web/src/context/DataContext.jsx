import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { collection, getDocs, query, orderBy, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { supabase, isSupabaseActive } from '../supabase';

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
  { id: 'C001', nombre: 'Farmatodo', website: 'https://www.farmatodo.com.ve', scraper_modulo: 'farmatodo', activo: true },
  { id: 'C002', nombre: 'Locatel', website: 'https://www.locatel.com.ve', scraper_modulo: 'locatel', activo: true },
  { id: 'C003', nombre: 'FarmaDON', website: 'https://www.farmadon.com', scraper_modulo: 'farmadon', activo: true },
  { id: 'C004', nombre: 'Grupo San Ignacio', website: 'https://www.gruposanignacio.com', scraper_modulo: 'grupo_san_ignacio', activo: true },
  { id: 'C005', nombre: 'Farmacias Xana', website: 'https://www.farmaciasxana.com', scraper_modulo: 'xana', activo: true },
  { id: 'C006', nombre: 'FarmaGo', website: 'https://www.farmago.com', scraper_modulo: 'farmago', activo: true }
];

const DEFAULT_HISTORICO = [
  { id: 'H001', id_producto_propio: 'P001', cadena: 'Farmatodo', marca: 'La Sante', precio_full_bs: 45.0, precio_desc_bs: 40.5, run_id: 'run_1', scraped_at: new Date(Date.now() - 3600000 * 2) },
  { id: 'H002', id_producto_propio: 'P001', cadena: 'Farmatodo', marca: 'Calox', precio_full_bs: 42.0, precio_desc_bs: 38.0, run_id: 'run_1', scraped_at: new Date(Date.now() - 3600000 * 2) },
  { id: 'H003', id_producto_propio: 'P002', cadena: 'Farmatodo', marca: 'La Sante', precio_full_bs: 54.0, precio_desc_bs: 50.0, run_id: 'run_1', scraped_at: new Date(Date.now() - 3600000 * 2) }
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

const DEFAULT_RUN = {
  started_at: new Date(),
  ok: 35,
  errores: 0,
  total: 35,
  status: 'exitosa'
};

const DEFAULT_USUARIOS = [
  { id: 'admin_at_trackflow_com', email: 'admin@trackflow.com', nombre: 'Hernando Sanoja', rol: 'administrador', activo: true },
  { id: 'analista_at_trackflow_com', email: 'analista@trackflow.com', nombre: 'Analista de Precios', rol: 'analista', activo: true }
];

async function fetchAllSupabaseRows(tableName, pageSize = 1000) {
  if (!isSupabaseActive() || !supabase) return [];
  let allRows = [];
  let page = 0;
  let hasMore = true;

  while (hasMore) {
    const from = page * pageSize;
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from(tableName)
      .select('*')
      .range(from, to);

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

export function DataProvider({ children, user }) {
  const [productos, setProductos] = useState([]);
  const [productosCompetencia, setProductosCompetencia] = useState([]);
  const [cadenas, setCadenas] = useState([]);
  const [historicoPrecios, setHistoricoPrecios] = useState([]);
  const [bcvRates, setBcvRates] = useState([]);
  const [ultimaCorrida, setUltimaCorrida] = useState(null);
  const [usuarios, setUsuarios] = useState([]);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLoadedOnce, setIsLoadedOnce] = useState(false);

  const CACHE_KEY = 'trackflow_data_cache_v2';
  const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

  const applyDefaultSeed = useCallback(() => {
    setProductos(DEFAULT_PRODUCTS);
    setProductosCompetencia(DEFAULT_COMPETENCIA);
    setCadenas(DEFAULT_CADENAS);
    setHistoricoPrecios(DEFAULT_HISTORICO);
    setBcvRates(DEFAULT_RATES);
    setUltimaCorrida(DEFAULT_RUN);
    setUsuarios(DEFAULT_USUARIOS);
    setIsLoadedOnce(true);
    setLoadingInitial(false);
    setIsRefreshing(false);
  }, []);

  // Intentar cargar desde caché de sesión para agilizar el arranque
  useEffect(() => {
    try {
      const cachedStr = sessionStorage.getItem(CACHE_KEY);
      if (cachedStr) {
        const cached = JSON.parse(cachedStr);
        if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
          if (cached.productos?.length) setProductos(cached.productos);
          if (cached.productosCompetencia?.length) setProductosCompetencia(cached.productosCompetencia);
          if (cached.cadenas?.length) setCadenas(cached.cadenas);
          if (cached.historicoPrecios?.length) setHistoricoPrecios(cached.historicoPrecios);
          if (cached.bcvRates?.length) setBcvRates(cached.bcvRates);
          if (cached.ultimaCorrida) setUltimaCorrida(cached.ultimaCorrida);
          if (cached.usuarios?.length) setUsuarios(cached.usuarios);
          setIsLoadedOnce(true);
          setLoadingInitial(false);
        }
      }
    } catch (e) {
      console.warn('Error leyendo cache:', e);
    }
  }, []);

  const saveCache = useCallback((dataToCache) => {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        timestamp: Date.now(),
        ...dataToCache
      }));
    } catch (e) {
      console.warn('No se pudo guardar en sessionStorage cache:', e);
    }
  }, []);

  const cargarTodo = useCallback(async (showSilently = false) => {
    if (!showSilently && !isLoadedOnce) {
      setLoadingInitial(true);
    } else {
      setIsRefreshing(true);
    }

    const hasSupabase = isSupabaseActive();

    if (hasSupabase) {
      try {
        const [
          pData,
          pcData,
          cData,
          uData,
          { data: hData, error: hErr },
          { data: rData, error: rErr },
          { data: bData, error: bErr }
        ] = await Promise.all([
          fetchAllSupabaseRows('productos'),
          fetchAllSupabaseRows('productos_competencia'),
          fetchAllSupabaseRows('cadenas'),
          fetchAllSupabaseRows('usuarios'),
          supabase.from('historico_precios').select('*').order('scraped_at', { ascending: false }).limit(5000),
          supabase.from('scrape_runs').select('*').order('started_at', { ascending: false }).limit(1),
          supabase.from('bcv_rates').select('*').order('updated_at', { ascending: true })
        ]);

        if (Array.isArray(pData)) {
          const prods = pData.map(p => ({
            ...p,
            id: p.id || p.id_interno || p.ID || '',
            id_interno: p.id_interno || p.id || p.ID || ''
          })).sort((a, b) => (a.id_interno || a.id || '').localeCompare(b.id_interno || b.id || ''));
          setProductos(prods);

          const pc = (Array.isArray(pcData) ? pcData : []).map(p => ({
            ...p,
            id: p.id || '',
            id_producto_propio: p.id_producto_propio || ''
          }));
          setProductosCompetencia(pc);

          const cSorted = [...(Array.isArray(cData) ? cData : [])].sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
          setCadenas(cSorted);

          if (hData && hData.length > 0) {
            setHistoricoPrecios(hData.map(d => ({
              ...d,
              scraped_at: d.scraped_at ? new Date(d.scraped_at) : null
            })));
          } else {
            setHistoricoPrecios([]);
          }

          if (rData && rData.length > 0) {
            setUltimaCorrida({
              ...rData[0],
              started_at: rData[0].started_at ? new Date(rData[0].started_at) : null
            });
          } else {
            setUltimaCorrida(null);
          }

          if (bData && bData.length > 0) {
            const rawRates = bData.map(d => {
              const dateObj = d.updated_at ? new Date(d.updated_at) : new Date();
              return {
                dayKey: dateObj.toLocaleDateString('es-VE', { year: 'numeric', month: '2-digit', day: '2-digit' }),
                fecha: dateObj.toLocaleDateString('es-VE', { month: 'short', day: 'numeric' }) || '—',
                valor: Number(d.value || d.valor || 0),
                source: d.source || 'oficial',
                rawDate: dateObj
              };
            });

            const ratesByDay = {};
            rawRates.forEach(rate => {
              const existing = ratesByDay[rate.dayKey];
              if (!existing || rate.rawDate > existing.rawDate) {
                ratesByDay[rate.dayKey] = rate;
              }
            });

            const uniqueDaysRates = Object.values(ratesByDay)
              .sort((a, b) => a.rawDate - b.rawDate);

            setBcvRates(uniqueDaysRates.map(({ dayKey, fecha, valor, source, rawDate }) => ({ dayKey, fecha, valor, source, rawDate })));
          } else {
            setBcvRates(DEFAULT_RATES);
          }

          const uSorted = [...(Array.isArray(uData) ? uData : [])].sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
          setUsuarios(uSorted);

          saveCache({
            productos: prods,
            productosCompetencia: pc,
            cadenas: cSorted,
            historicoPrecios: hData || [],
            bcvRates: bData || [],
            ultimaCorrida: rData?.[0] || null,
            usuarios: uSorted
          });

          setIsLoadedOnce(true);
          setLoadingInitial(false);
          setIsRefreshing(false);
          return;
        } else {
          console.warn('[Supabase] Error al leer tabla productos:', pErr?.message || pErr);
          setProductos([]);
          setIsLoadedOnce(true);
          setLoadingInitial(false);
          setIsRefreshing(false);
          return;
        }
      } catch (sbErr) {
        console.warn('Supabase no devolvió datos:', sbErr);
      }
    }

    // Fallback Firebase
    try {
      if (!db) {
        applyDefaultSeed();
        return;
      }

      const [pSnap, pcSnap, cSnap, hSnap, rSnap, bSnap, uSnap] = await Promise.all([
        getDocs(collection(db, 'productos')),
        getDocs(collection(db, 'productos_competencia')),
        getDocs(collection(db, 'cadenas')),
        getDocs(query(collection(db, 'historico_precios'), orderBy('scraped_at', 'desc'), limit(1500))),
        getDocs(query(collection(db, 'scrape_runs'), orderBy('started_at', 'desc'), limit(1))),
        getDocs(query(collection(db, 'bcv_rates'), orderBy('updated_at', 'asc'))),
        getDocs(collection(db, 'usuarios')),
      ]);

      if (pSnap.empty) {
        applyDefaultSeed();
        return;
      }

      const prods = pSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      prods.sort((a, b) => (a.id_interno || '').localeCompare(b.id_interno || ''));
      setProductos(prods);

      setProductosCompetencia(pcSnap.docs.map(d => ({ id: d.id, ...d.data() })));

      const cDocs = cSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      cDocs.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      setCadenas(cDocs);

      setHistoricoPrecios(
        hSnap.docs.map(d => ({
          id: d.id,
          ...d.data(),
          scraped_at: d.data().scraped_at?.toDate?.() || null
        }))
      );

      if (!rSnap.empty) {
        const data = rSnap.docs[0].data();
        setUltimaCorrida({ ...data, started_at: data.started_at?.toDate?.() || null });
      }

      const rawRates = bSnap.docs.map(d => {
        const data = d.data();
        const dateObj = data.updated_at?.toDate?.() || (data.updated_at ? new Date(data.updated_at) : new Date());
        return {
          dayKey: dateObj.toLocaleDateString('es-VE', { year: 'numeric', month: '2-digit', day: '2-digit' }),
          fecha: dateObj.toLocaleDateString('es-VE', { month: 'short', day: 'numeric' }) || '—',
          valor: Number(data.value || data.valor || 0),
          source: data.source || 'oficial',
          rawDate: dateObj
        };
      });

      const ratesByDay = {};
      rawRates.forEach(rate => {
        const existing = ratesByDay[rate.dayKey];
        if (!existing || rate.rawDate > existing.rawDate) {
          ratesByDay[rate.dayKey] = rate;
        }
      });

      const uniqueDaysRates = Object.values(ratesByDay)
        .sort((a, b) => a.rawDate - b.rawDate);

      setBcvRates(uniqueDaysRates.map(({ dayKey, fecha, valor, source, rawDate }) => ({ dayKey, fecha, valor, source, rawDate })));

      const uDocs = uSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      uDocs.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      setUsuarios(uDocs);

      setIsLoadedOnce(true);
    } catch (err) {
      console.warn('Error cargando datos globales, aplicando datos semilla por defecto:', err?.message || String(err));
      applyDefaultSeed();
    } finally {
      setLoadingInitial(false);
      setIsRefreshing(false);
    }
  }, [isLoadedOnce, applyDefaultSeed]);

  useEffect(() => {
    cargarTodo(false);
  }, [cargarTodo]);

  const refreshProductos = useCallback(async () => {
    try {
      if (isSupabaseActive()) {
        const data = await fetchAllSupabaseRows('productos');
        if (Array.isArray(data)) {
          const prods = data.map(p => ({
            ...p,
            id: p.id || p.id_interno || p.ID || '',
            id_interno: p.id_interno || p.id || p.ID || ''
          })).sort((a, b) => (a.id_interno || a.id || '').localeCompare(b.id_interno || b.id || ''));
          setProductos(prods);
          return;
        }
      }
      if (!db) return;
      const snap = await getDocs(collection(db, 'productos'));
      if (!snap.empty) {
        const prods = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        prods.sort((a, b) => (a.id_interno || '').localeCompare(b.id_interno || ''));
        setProductos(prods);
      }
    } catch (e) {
      console.warn('Aviso actualizando productos:', e?.message || String(e));
    }
  }, []);

  const refreshCompetencia = useCallback(async () => {
    try {
      if (isSupabaseActive()) {
        const data = await fetchAllSupabaseRows('productos_competencia');
        if (Array.isArray(data)) {
          setProductosCompetencia(data.map(p => ({
            ...p,
            id: p.id || '',
            id_producto_propio: p.id_producto_propio || ''
          })));
          return;
        }
      }
      if (!db) return;
      const snap = await getDocs(collection(db, 'productos_competencia'));
      if (!snap.empty) {
        setProductosCompetencia(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      }
    } catch (e) {
      console.warn('Aviso actualizando competencia:', e?.message || String(e));
    }
  }, []);

  const refreshCadenas = useCallback(async () => {
    try {
      if (isSupabaseActive()) {
        const data = await fetchAllSupabaseRows('cadenas');
        if (Array.isArray(data)) {
          const cDocs = [...data].sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
          setCadenas(cDocs);
          return;
        }
      }
      if (!db) return;
      const snap = await getDocs(collection(db, 'cadenas'));
      if (!snap.empty) {
        const cDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        cDocs.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
        setCadenas(cDocs);
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
      if (!db) return;
      const snap = await getDocs(collection(db, 'usuarios'));
      if (!snap.empty) {
        const uDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        uDocs.sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
        setUsuarios(uDocs);
      }
    } catch (e) {
      console.warn('Aviso actualizando usuarios:', e?.message || String(e));
    }
  }, []);

  const value = useMemo(() => ({
    productos,
    productosCompetencia,
    cadenas,
    historicoPrecios,
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
    setProductosCompetencia
  }), [
    productos,
    productosCompetencia,
    cadenas,
    historicoPrecios,
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
    refreshUsuarios
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

