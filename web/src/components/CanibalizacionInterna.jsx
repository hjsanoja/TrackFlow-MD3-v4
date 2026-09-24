import { useState, useMemo } from 'react';
import StatCard from './StatCard';
import { useData } from '../context/DataContext';
import { useBcvRate } from '../hooks/useBcvRate';

export default function CanibalizacionInterna({ user, userDoc }) {
  const { productos = [], productosCompetencia = [], ultimosPreciosValidos = [] } = useData();
  const bcv = useBcvRate();
  const currentBcv = bcv.rate || 853.5;

  const [filtroCategoria, setFiltroCategoria] = useState('todas');
  const [filtroNivelAlerta, setFiltroNivelAlerta] = useState('todos'); // 'todos', 'critico', 'moderado', 'saludable'
  const [busqueda, setBusqueda] = useState('');
  const [cadenaFiltro, setCadenaFiltro] = useState('todas');

  // Obtener lista de categorías únicas
  const categorias = useMemo(() => {
    const cats = new Set();
    productos.forEach(p => {
      if (p.categoria) cats.add(p.categoria);
    });
    return Array.from(cats).sort();
  }, [productos]);

  // Obtener cadenas únicas
  const cadenas = useMemo(() => {
    const cads = new Set();
    productosCompetencia.forEach(pc => {
      if (pc.cadena) cads.add(pc.cadena);
    });
    return Array.from(cads).sort();
  }, [productosCompetencia]);

  // Construir mapa de precios de anaquel digital en farmacias para productos propios
  // Un producto propio puede tener presencia en Farmatodo, Locatel, etc.
  const preciosAnaquelMap = useMemo(() => {
    const map = new Map(); // key: `${id_interno}_${cadena}` -> { p_bs, p_usd, url, promo, cadena }
    
    // Primero desde ultimosPreciosValidos
    ultimosPreciosValidos.forEach(v => {
      if (v.es_propio && v.id_interno) {
        const key = `${v.id_interno}_${v.cadena_id}`;
        const pBs = v.precio_desc_bs || v.precio_full_bs;
        const pUsd = v.precio_vigente_usd || (pBs && v.tasa_bcv ? pBs / v.tasa_bcv : null);
        map.set(key, {
          precio_bs: pBs,
          precio_usd: pUsd,
          tasa_bcv: v.tasa_bcv,
          cadena: v.cadena_id,
          tiene_promo: v.tiene_promocion,
          url: v.url
        });
      }
    });

    // Complementar con productosCompetencia tipo 'propio'
    productosCompetencia.forEach(pc => {
      if (pc.tipo === 'propio' && pc.id_producto_propio) {
        const key = `${pc.id_producto_propio}_${pc.cadena}`;
        if (!map.has(key)) {
          const pBs = pc.ultimo_precio_desc_bs || pc.ultimo_precio_full_bs;
          const pUsd = pc.ultimo_precio_desc_usd || (pBs && currentBcv ? pBs / currentBcv : null);
          map.set(key, {
            precio_bs: pBs,
            precio_usd: pUsd,
            tasa_bcv: currentBcv,
            cadena: pc.cadena,
            tiene_promo: pc.tiene_descuento,
            url: pc.url
          });
        }
      }
    });

    return map;
  }, [ultimosPreciosValidos, productosCompetencia, currentBcv]);

  // Agrupar productos propios por Principio Activo o Molécula para detectar pares en conflicto
  const paresCanibalizacion = useMemo(() => {
    // 1. Indexar productos propios por principio_activo normalizado
    const gruposMol = new Map();
    productos.forEach(p => {
      const mol = (p.principio_activo || p.nombre || '').trim().toLowerCase();
      if (!mol || mol.length < 3) return;
      if (!gruposMol.has(mol)) gruposMol.set(mol, []);
      gruposMol.get(mol).push(p);
    });

    const listaPares = [];

    gruposMol.forEach((items, mol) => {
      if (items.length < 2) return;

      // Buscar combinaciones de pares dentro de la misma molécula
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const pA = items[i];
          const pB = items[j];

          // Determinar cuál es marca y cuál es genérico, o compararlos
          const esMarcaA = pA.market_type === 'MARCA' || (pA.laboratorio || '').toUpperCase().includes('PHARMETIQUE');
          const esMarcaB = pB.market_type === 'MARCA' || (pB.laboratorio || '').toUpperCase().includes('PHARMETIQUE');

          let prodGenerico = pA;
          let prodMarca = pB;

          if (esMarcaA && !esMarcaB) {
            prodMarca = pA;
            prodGenerico = pB;
          } else if (!esMarcaA && esMarcaB) {
            prodMarca = pB;
            prodGenerico = pA;
          }

          // Unidosis (tabletas o ml)
          const unidosisGen = Number(prodGenerico.unidosis || 10);
          const unidosisMar = Number(prodMarca.unidosis || 10);

          // Evaluar precio base de lista (PVP Propio USD)
          const pvpGen = Number(prodGenerico.pvp_propio_usd || 0);
          const pvpMar = Number(prodMarca.pvp_propio_usd || 0);

          const costUnidosisGen = unidosisGen > 0 ? pvpGen / unidosisGen : 0;
          const costUnidosisMar = unidosisMar > 0 ? pvpMar / unidosisMar : 0;

          // Evaluar en anaquel por cadena si está disponible
          const cadenasAEvaluar = cadenaFiltro === 'todas' ? ['Farmatodo', 'Locatel', 'Saas'] : [cadenaFiltro];
          
          cadenasAEvaluar.forEach(cad => {
            const retailGen = preciosAnaquelMap.get(`${prodGenerico.id_interno || prodGenerico.id}_${cad}`);
            const retailMar = preciosAnaquelMap.get(`${prodMarca.id_interno || prodMarca.id}_${cad}`);

            // Precios a usar para el análisis
            const precioEfectivoGen = retailGen?.precio_usd || pvpGen;
            const precioEfectivoMar = retailMar?.precio_usd || pvpMar;

            if (precioEfectivoGen <= 0 || precioEfectivoMar <= 0) return;

            const unidosisEffGen = unidosisGen > 0 ? precioEfectivoGen / unidosisGen : 0;
            const unidosisEffMar = unidosisMar > 0 ? precioEfectivoMar / unidosisMar : 0;

            // Brecha de precio (%) = (Marca - Genérico) / Genérico
            const brechaAbsUsd = precioEfectivoMar - precioEfectivoGen;
            const brechaPct = ((precioEfectivoMar - precioEfectivoGen) / precioEfectivoGen) * 100;
            const brechaUnidosisPct = costUnidosisGen > 0 ? ((unidosisEffMar - unidosisEffGen) / unidosisEffGen) * 100 : 0;

            // Clasificación de Alerta de Canibalización
            let nivelAlerta = 'saludable'; // saludable: Marca es 15% - 40% más cara que el genérico
            let tipoConflicto = 'Normal';
            let severidad = 1;
            let diagnostico = '';
            let recomendacion = '';

            if (precioEfectivoMar < precioEfectivoGen) {
              nivelAlerta = 'critico';
              tipoConflicto = 'Inversión de Precio (Marca < Genérico)';
              severidad = 3;
              diagnostico = `La marca comercial (${prodMarca.nombre}) se está vendiendo a $${precioEfectivoMar.toFixed(2)}, por debajo del genérico (${prodGenerico.nombre} a $${precioEfectivoGen.toFixed(2)}).`;
              recomendacion = `Aumentar el precio de ${prodMarca.nombre} o revisar descuentos de anaquel para que mantenga al menos un 20% de prima sobre el genérico.`;
            } else if (unidosisEffGen > 0 && unidosisEffMar < unidosisEffGen) {
              nivelAlerta = 'critico';
              tipoConflicto = 'Canibalización por Unidosis Invertida';
              severidad = 3;
              diagnostico = `El costo por unidad en la marca (${unidosisEffMar.toFixed(3)} $/dosis) es menor que en el genérico (${unidosisEffGen.toFixed(3)} $/dosis). Destruye la venta del genérico.`;
              recomendacion = `Rebalancear el PVP por unidad de la presentación familiar/marca para proteger el margen del portafolio.`;
            } else if (brechaPct >= 0 && brechaPct < 12) {
              nivelAlerta = 'moderado';
              tipoConflicto = 'Brecha Estrecha (<12%)';
              severidad = 2;
              diagnostico = `La diferencia entre la marca ($${precioEfectivoMar.toFixed(2)}) y el genérico ($${precioEfectivoGen.toFixed(2)}) es de apenas ${brechaPct.toFixed(1)}%. Canibaliza las ventas del genérico sin capturar el valor de la marca.`;
              recomendacion = `Ampliar la brecha al 18%-25% para diferenciar claramente el posicionamiento ético/premium del producto genérico.`;
            } else if (brechaPct > 65) {
              nivelAlerta = 'moderado';
              tipoConflicto = 'Brecha Excesiva (>65%)';
              severidad = 2;
              diagnostico = `La marca es ${brechaPct.toFixed(1)}% más cara que el genérico. Esto puede empujar al paciente hacia competidores externos en lugar de quedarse en el portafolio propio.`;
              recomendacion = `Revisar si el competidor líder está capturando el segmento medio entre ambos productos propios.`;
            } else {
              nivelAlerta = 'saludable';
              tipoConflicto = 'Posicionamiento Armónico';
              severidad = 1;
              diagnostico = `Diferencial saludable de ${brechaPct.toFixed(1)}% entre la línea genérica y la línea de marca.`;
              recomendacion = `Mantener el monitoreo continuo en anaqueles digitales.`;
            }

            listaPares.push({
              id: `${prodGenerico.id}_${prodMarca.id}_${cad}`,
              molecula: prodGenerico.principio_activo || prodGenerico.nombre,
              categoria: prodGenerico.categoria || 'Sin categoría',
              cadena: cad,
              esDatoAnaquel: Boolean(retailGen || retailMar),
              generico: {
                id: prodGenerico.id,
                id_interno: prodGenerico.id_interno,
                nombre: prodGenerico.nombre,
                laboratorio: prodGenerico.laboratorio,
                concentracion: prodGenerico.concentracion,
                tamano: prodGenerico.tamano,
                unidosis: unidosisGen,
                precio_usd: precioEfectivoGen,
                costo_unidosis: unidosisEffGen,
                tiene_promo: retailGen?.tiene_promo || false,
                url: retailGen?.url
              },
              marca: {
                id: prodMarca.id,
                id_interno: prodMarca.id_interno,
                nombre: prodMarca.nombre,
                laboratorio: prodMarca.laboratorio,
                concentracion: prodMarca.concentracion,
                tamano: prodMarca.tamano,
                unidosis: unidosisMar,
                precio_usd: precioEfectivoMar,
                costo_unidosis: unidosisEffMar,
                tiene_promo: retailMar?.tiene_promo || false,
                url: retailMar?.url
              },
              brechaPct,
              brechaAbsUsd,
              brechaUnidosisPct,
              nivelAlerta,
              tipoConflicto,
              severidad,
              diagnostico,
              recomendacion
            });
          });
        }
      }
    });

    // Ordenar por severidad descendente (Críticos primero) y luego por brecha
    return listaPares.sort((a, b) => b.severidad - a.severidad || a.brechaPct - b.brechaPct);
  }, [productos, preciosAnaquelMap, cadenaFiltro]);

  // Filtrado final de la lista
  const paresFiltrados = useMemo(() => {
    return paresCanibalizacion.filter(par => {
      // Filtro de categoría
      if (filtroCategoria !== 'todas' && par.categoria !== filtroCategoria) return false;

      // Filtro de alerta
      if (filtroNivelAlerta !== 'todos' && par.nivelAlerta !== filtroNivelAlerta) return false;

      // Búsqueda por texto
      if (busqueda.trim()) {
        const q = busqueda.toLowerCase().trim();
        const coincideMolecula = par.molecula.toLowerCase().includes(q);
        const coincideGen = par.generico.nombre.toLowerCase().includes(q);
        const coincideMar = par.marca.nombre.toLowerCase().includes(q);
        if (!coincideMolecula && !coincideGen && !coincideMar) return false;
      }

      return true;
    });
  }, [paresCanibalizacion, filtroCategoria, filtroNivelAlerta, busqueda]);

  // KPIs
  const conteoCriticos = useMemo(() => paresCanibalizacion.filter(p => p.nivelAlerta === 'critico').length, [paresCanibalizacion]);
  const conteoModerados = useMemo(() => paresCanibalizacion.filter(p => p.nivelAlerta === 'moderado').length, [paresCanibalizacion]);
  const conteoSaludables = useMemo(() => paresCanibalizacion.filter(p => p.nivelAlerta === 'saludable').length, [paresCanibalizacion]);

  // Exportar a CSV
  const exportarCSV = () => {
    if (!paresFiltrados.length) return;
    const encabezados = [
      'Molécula',
      'Categoría',
      'Cadena',
      'Producto Genérico (La Santé)',
      'Precio Genérico USD',
      '$/Dosis Genérico',
      'Producto Marca (Pharmetique)',
      'Precio Marca USD',
      '$/Dosis Marca',
      'Brecha % (Marca vs Genérico)',
      'Nivel Alerta',
      'Tipo de Conflicto',
      'Diagnóstico',
      'Recomendación'
    ];

    const filas = paresFiltrados.map(p => [
      `"${p.molecula}"`,
      `"${p.categoria}"`,
      `"${p.cadena}"`,
      `"${p.generico.nombre}"`,
      p.generico.precio_usd.toFixed(2),
      p.generico.costo_unidosis.toFixed(4),
      `"${p.marca.nombre}"`,
      p.marca.precio_usd.toFixed(2),
      p.marca.costo_unidosis.toFixed(4),
      p.brechaPct.toFixed(1) + '%',
      `"${p.nivelAlerta.toUpperCase()}"`,
      `"${p.tipoConflicto}"`,
      `"${p.diagnostico.replace(/"/g, '""')}"`,
      `"${p.recomendacion.replace(/"/g, '""')}"`
    ]);

    const csvContent = '\uFEFF' + [encabezados.join(';'), ...filas.map(f => f.join(';'))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `Canibalizacion_Marcas_TrackFlow_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      {/* Header y Descripción Ejecutiva */}
      <div className="bg-surface-container-low border border-outline-variant/60 rounded-3xl p-6 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-primary text-2xl">
                compare_arrows
              </span>
              <h2 className="text-xl font-display font-extrabold text-on-surface">
                Detección de Canibalización Interna de Marcas
              </h2>
              <span className="text-label-sm font-mono font-bold bg-primary/10 text-primary px-2 py-0.5 rounded-full uppercase">
                La Santé vs Pharmetique
              </span>
            </div>
            <p className="text-xs text-on-surface-variant max-w-3xl leading-relaxed">
              Monitorea el posicionamiento cruzado entre tus líneas genéricas y de marca con el mismo principio activo. Identifica inversiones de precio en anaquel digital y destrucciones de valor antes de que afecten la rentabilidad global del portafolio.
            </p>
          </div>

          <button
            onClick={exportarCSV}
            className="flex items-center gap-2 px-4 py-2.5 bg-primary text-on-primary rounded-xl text-xs font-semibold hover:bg-primary/90 transition-all shadow-xs self-start md:self-auto cursor-pointer"
          >
            <span className="material-symbols-outlined text-[18px]">download</span>
            Exportar Auditoría CSV
          </button>
        </div>

        {/* Tarjetas de Resumen KPI — todas con el mismo componente, para que
            compartan forma, elevación y espaciado. El tono solo cambia color. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mt-6">
          <StatCard
            label="Pares Analizados"
            value={paresCanibalizacion.length}
            hint="Moléculas con oferta dual"
            icon="alt_route"
          />
          <StatCard
            label="Margen Invertido"
            value={conteoCriticos}
            hint="Marca ≤ Genérico o dosis invertida"
            icon="warning"
            tono="negative"
          />
          <StatCard
            label="Brecha Estrecha"
            value={conteoModerados}
            hint="Diferencial menor al 12%"
            icon="sync_problem"
            tono="warning"
          />
          <StatCard
            label="Brecha Armónica"
            value={conteoSaludables}
            hint="Prima de marca óptima (15-40%)"
            icon="check_circle"
            tono="positive"
          />
        </div>
      </div>

      {/* Barra de Filtros */}
      <div className="flex flex-wrap items-center justify-between gap-3 m3-card-outlined p-4">
        <div className="flex flex-wrap items-center gap-3 w-full md:w-auto">
          {/* Búsqueda */}
          <div className="relative min-w-[240px] flex-1 md:flex-none">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-lg">
              search
            </span>
            <input
              type="text"
              value={busqueda}
              onChange={e => setBusqueda(e.target.value)}
              placeholder="Buscar por molécula o producto..."
              className="w-full pl-9 pr-3 py-1.5 text-xs rounded-xl bg-surface-container-lowest border border-outline-variant text-on-surface placeholder:text-on-surface-variant/60 focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>

          {/* Filtro Categoría */}
          <select
            value={filtroCategoria}
            onChange={e => setFiltroCategoria(e.target.value)}
            className="m3-select m3-select-dense"
          >
            <option value="todas">Todas las categorías ({categorias.length})</option>
            {categorias.map(cat => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>

          {/* Filtro Cadena */}
          <select
            value={cadenaFiltro}
            onChange={e => setCadenaFiltro(e.target.value)}
            className="m3-select m3-select-dense"
          >
            <option value="todas">Todas las cadenas</option>
            {cadenas.map(cad => (
              <option key={cad} value={cad}>{cad}</option>
            ))}
          </select>

          {/* Filtro Nivel de Alerta */}
          <select
            value={filtroNivelAlerta}
            onChange={e => setFiltroNivelAlerta(e.target.value)}
            className="m3-select m3-select-dense"
          >
            <option value="todos">Todos los niveles</option>
            <option value="critico">🚨 Solo Críticos ({conteoCriticos})</option>
            <option value="moderado">⚠️ Brecha Estrecha ({conteoModerados})</option>
            <option value="saludable">✅ Saludables ({conteoSaludables})</option>
          </select>
        </div>

        <div className="text-xs text-on-surface-variant font-mono">
          Mostrando {paresFiltrados.length} de {paresCanibalizacion.length} pares
        </div>
      </div>

      {/* Matriz de Pares de Canibalización */}
      {paresFiltrados.length === 0 ? (
        <div className="bg-surface-container-low border border-dashed border-outline-variant rounded-3xl p-12 text-center">
          <span className="material-symbols-outlined text-4xl text-on-surface-variant mb-2">
            check_circle
          </span>
          <h3 className="text-base font-bold text-on-surface">No se encontraron pares con este criterio</h3>
          <p className="text-xs text-on-surface-variant mt-1">
            Prueba relajando los filtros de búsqueda o categoría.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {paresFiltrados.map((par) => {
            const esCritico = par.nivelAlerta === 'critico';
            const esModerado = par.nivelAlerta === 'moderado';

            return (
              <div
                key={par.id}
                className={`bg-surface-container-lowest rounded-2xl border p-5 transition-all shadow-xs hover:shadow-md ${
                  esCritico
                    ? 'border-red-500/40 dark:border-red-500/30 ring-1 ring-red-500/20'
                    : esModerado
                    ? 'border-amber-500/40 dark:border-amber-500/30'
                    : 'border-outline-variant/60'
                }`}
              >
                {/* Cabecera del Par */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-3 mb-3 border-b border-outline-variant/40">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-mono font-bold uppercase px-2.5 py-0.5 rounded-md bg-surface-container text-on-surface">
                      {par.molecula}
                    </span>
                    <span className="text-label-md text-on-surface-variant">
                      • {par.categoria}
                    </span>
                    <span className="text-label-md font-mono text-primary font-semibold">
                      • Cadena: {par.cadena}
                    </span>
                    {par.esDatoAnaquel && (
                      <span className="text-label-sm font-mono bg-blue-500/10 text-blue-700 dark:text-blue-300 border border-blue-500/20 px-1.5 py-0.2 rounded">
                        Anaquel Digital Validado
                      </span>
                    )}
                  </div>

                  {/* Badge de Alerta */}
                  <div className="flex items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold font-mono uppercase ${
                        esCritico
                          ? 'bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30'
                          : esModerado
                          ? 'bg-amber-500/15 text-amber-800 dark:text-amber-300 border border-amber-500/30'
                          : 'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300 border border-emerald-500/30'
                      }`}
                    >
                      <span className="material-symbols-outlined text-body-md">
                        {esCritico ? 'dangerous' : esModerado ? 'warning' : 'verified'}
                      </span>
                      {par.tipoConflicto}
                    </span>
                  </div>
                </div>

                {/* Comparativa Cara a Cara de los dos Productos */}
                <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
                  {/* Producto 1: Genérico (La Santé) */}
                  <div className="md:col-span-5 bg-surface-container-low/60 p-3.5 rounded-xl border border-outline-variant/40">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-label-sm font-mono font-bold uppercase tracking-wider text-blue-700 dark:text-blue-400 bg-blue-500/10 px-1.5 py-0.5 rounded">
                        Línea Genérica
                      </span>
                      <span className="text-label-sm font-mono text-on-surface-variant">
                        {par.generico.laboratorio || 'La Santé'}
                      </span>
                    </div>
                    <h4 className="text-xs font-bold text-on-surface line-clamp-1">
                      {par.generico.nombre}
                    </h4>
                    <div className="text-label-md text-on-surface-variant mt-0.5">
                      {par.generico.concentracion} • {par.generico.tamano || `${par.generico.unidosis} tabletas`}
                    </div>

                    <div className="mt-3 flex items-baseline justify-between pt-2 border-t border-outline-variant/30">
                      <div>
                        <span className="text-label-sm text-on-surface-variant block">Precio Anaquel USD</span>
                        <span className="text-base font-display font-black text-on-surface">
                          ${par.generico.precio_usd.toFixed(2)}
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="text-label-sm text-on-surface-variant block">Costo por Unidad</span>
                        <span className="text-xs font-mono font-semibold text-on-surface-variant">
                          ${par.generico.costo_unidosis.toFixed(3)}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Indicador de Brecha Central */}
                  <div className="md:col-span-2 flex flex-col items-center justify-center p-2 text-center">
                    <span className="text-label-sm font-mono uppercase text-on-surface-variant">
                      Brecha Prima
                    </span>
                    <span
                      className={`text-lg font-display font-black my-0.5 ${
                        esCritico
                          ? 'text-red-600'
                          : esModerado
                          ? 'text-amber-600'
                          : 'text-emerald-600'
                      }`}
                    >
                      {par.brechaPct > 0 ? `+${par.brechaPct.toFixed(1)}%` : `${par.brechaPct.toFixed(1)}%`}
                    </span>
                    <span className="text-label-sm font-mono text-on-surface-variant">
                      ({par.brechaAbsUsd >= 0 ? `+$${par.brechaAbsUsd.toFixed(2)}` : `-$${Math.abs(par.brechaAbsUsd).toFixed(2)}`})
                    </span>
                  </div>

                  {/* Producto 2: Marca (Pharmetique) */}
                  <div className="md:col-span-5 bg-surface-container-low/60 p-3.5 rounded-xl border border-outline-variant/40">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-label-sm font-mono font-bold uppercase tracking-wider text-purple-700 dark:text-purple-400 bg-purple-500/10 px-1.5 py-0.5 rounded">
                        Línea de Marca / Premium
                      </span>
                      <span className="text-label-sm font-mono text-on-surface-variant">
                        {par.marca.laboratorio || 'Pharmetique'}
                      </span>
                    </div>
                    <h4 className="text-xs font-bold text-on-surface line-clamp-1">
                      {par.marca.nombre}
                    </h4>
                    <div className="text-label-md text-on-surface-variant mt-0.5">
                      {par.marca.concentracion} • {par.marca.tamano || `${par.marca.unidosis} tabletas`}
                    </div>

                    <div className="mt-3 flex items-baseline justify-between pt-2 border-t border-outline-variant/30">
                      <div>
                        <span className="text-label-sm text-on-surface-variant block">Precio Anaquel USD</span>
                        <span className="text-base font-display font-black text-on-surface">
                          ${par.marca.precio_usd.toFixed(2)}
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="text-label-sm text-on-surface-variant block">Costo por Unidad</span>
                        <span className="text-xs font-mono font-semibold text-on-surface-variant">
                          ${par.marca.costo_unidosis.toFixed(3)}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Diagnóstico y Recomendación de Pricing */}
                <div
                  className={`mt-3 p-3 rounded-xl text-xs flex items-start gap-2.5 ${
                    esCritico
                      ? 'bg-red-500/10 text-red-900 dark:text-red-200 border border-red-500/20'
                      : esModerado
                      ? 'bg-amber-500/10 text-amber-900 dark:text-amber-200 border border-amber-500/20'
                      : 'bg-surface-container text-on-surface-variant border border-outline-variant/40'
                  }`}
                >
                  <span className="material-symbols-outlined text-[18px] shrink-0 mt-0.5">
                    {esCritico ? 'crisis_alert' : esModerado ? 'psychology_alt' : 'insights'}
                  </span>
                  <div className="space-y-1 leading-relaxed">
                    <p>
                      <strong>Diagnóstico:</strong> {par.diagnostico}
                    </p>
                    <p className="font-semibold">
                      <strong>Recomendación:</strong> {par.recomendacion}
                    </p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
