import { useCallback, useMemo } from 'react';
import { parseUnidosisCount } from '../utils/unidosisUtils';
import { UMBRAL_CAMBIO } from '../components/dashboard/comun';
import { esMarca } from '../utils/tipoMercado';

// Precios de cada producto propio frente a la competencia, con el mismo
// criterio en el Dashboard y en el Mapa de Calor:
//   - "Tu precio": el mas bajo de tus enlaces; si no hay, el PVP de la ficha.
//   - Minimo: SOLO de la competencia. Promedio: del MERCADO (la competencia
//     mas tu precio); promedioComp es el de la competencia sola.
//   - Cambios: en dolares, cada precio a la tasa de su dia (v_variacion).
//   - Por unidad: el precio entre las unidades del empaque.
//   - tipoComp: comparar contra toda la competencia, solo genericos o solo
//     marcas (tipo_mercado de cada competidor, fase 29).
//   - cruce: tu generico cuesta mas que una marca de la competencia, o tu
//     marca cuesta menos que un generico (mismo empaque, o por unidad).
export function useAnalisisPrecios({
  productos = [], productosCompetencia = [], cadenas = [], variaciones = [], tasa,
  modoPrecio = 'lista', modoAnalisis = 'empaque', ventana = 1, cadenaComp = 'todos', tipoComp = 'todos',
}) {
  // Cadenas: los enlaces viejos traen el nombre en vez del id.
  const cadenaPorClave = useMemo(() => {
    const m = new Map();
    for (const c of cadenas || []) {
      m.set(String(c.id).toLowerCase(), c);
      m.set(String(c.nombre).toLowerCase(), c);
    }
    return m;
  }, [cadenas]);
  const idCadena = useCallback((v) => cadenaPorClave.get(String(v || '').toLowerCase())?.id || v, [cadenaPorClave]);
  const nombreCadena = useCallback((v) => cadenaPorClave.get(String(v || '').toLowerCase())?.nombre || v || '—', [cadenaPorClave]);

  const analizados = useMemo(() => {
    // v_variacion: por enlace, el precio actual y los de hace 1, 7 y 15 dias,
    // cada uno con la tasa de su dia.
    const mapaVariacion = new Map();
    (variaciones || []).forEach(v => { if (v.publicacion_id != null) mapaVariacion.set(v.publicacion_id, v); });
    const conDescuento = modoPrecio === 'descuento';
    const suf = ventana === 1 ? '1d' : ventana === 7 ? '7d' : '15d';
    const porUnidad = modoAnalisis === 'unidosis';

    const enlacesPorProducto = new Map();
    for (const e of productosCompetencia) {
      if (!e.activo || !e.id_producto_propio) continue;
      const id = String(e.id_producto_propio).trim();
      if (!enlacesPorProducto.has(id)) enlacesPorProducto.set(id, []);
      enlacesPorProducto.get(id).push(e);
    }

    return productos.filter(p => p.activo).map(p => {
      const pId = String(p.id_interno || p.id || '').trim();
      const competencia = enlacesPorProducto.get(pId) || [];
      const unidadesPropio = Math.max(parseUnidosisCount(p.tamano || p.presentacion, p.nombre, p.unidosis || p.unidades_empaque), 1);

      const todos = competencia.map(c => {
        const bs = conDescuento ? (c.ultimo_precio_desc_bs || c.ultimo_precio_full_bs) : c.ultimo_precio_full_bs;
        if (!bs || !tasa) return null;
        const tipo = String(c.tipo || '').toLowerCase();
        const cadena = idCadena(c.cadena);
        // Comparando contra una sola cadena, el resto de la competencia no cuenta.
        if (tipo !== 'propio' && cadenaComp !== 'todos' && cadena !== cadenaComp) return null;
        // Unidades del empaque: las de la ficha del enlace (fase 28). Un 1 es
        // el valor por defecto de los competidores ("no se sabe"), asi que
        // entonces tu enlace usa las de tu producto y el de un competidor las
        // que se leen en su nombre ("x 20 tabletas") o, si no dice, las tuyas.
        const leidas = Number(c.unidades_empaque || c.unidosis) > 1 ? Number(c.unidades_empaque || c.unidosis)
          : tipo === 'propio' ? unidadesPropio
            : parseUnidosisCount(c.tamano, c.marca, null);
        const unidades = Math.max(leidas > 1 ? leidas : unidadesPropio, 1);
        const factor = porUnidad ? unidades : 1;

        // Cambio en dolares, cada precio a la tasa de su dia: que el bolivar
        // suba no cuenta como cambio de precio.
        let cambio = 0;
        let antesUsd = null;
        const fila = c.publicacion_id != null ? mapaVariacion.get(c.publicacion_id) : null;
        if (fila) {
          const ahoraBs = conDescuento ? (fila.precio_actual_desc_bs ?? fila.precio_actual_full_bs) : fila.precio_actual_full_bs;
          const antesBs = conDescuento ? (fila[`precio_${suf}_desc_bs`] ?? fila[`precio_${suf}_full_bs`]) : fila[`precio_${suf}_full_bs`];
          const tasaAhora = Number(fila.tasa_actual) || tasa;
          const tasaAntes = Number(fila[`tasa_${suf}`]) || tasaAhora;
          if (ahoraBs != null && antesBs != null && Number(antesBs) > 0) {
            const ahoraUsd = Number(ahoraBs) / tasaAhora;
            antesUsd = Number(antesBs) / tasaAntes / factor;
            cambio = (ahoraUsd / (Number(antesBs) / tasaAntes) - 1) * 100;
          }
        }

        return {
          id: c.id,
          tipo,
          tipoMercado: esMarca(c) ? 'MARCA' : 'GENERICO',
          cadena,
          marca: c.marca,
          unidades,
          priceUsd: bs / factor / tasa,
          unitUsd: bs / unidades / tasa,
          antesUsd,
          cambio,
        };
      }).filter(v => v && v.priceUsd > 0);
      const precios = tipoComp === 'todos' ? todos : todos.filter(x => x.tipo === 'propio' || x.tipoMercado === tipoComp);

      const propios = precios.filter(x => x.tipo === 'propio');
      const competidores = precios.filter(x => x.tipo !== 'propio');
      const valores = competidores.map(x => x.priceUsd);
      const minimo = valores.length ? Math.min(...valores) : null;
      const promedioComp = valores.length ? valores.reduce((a, b) => a + b, 0) / valores.length : null;
      const cadenasMin = minimo == null ? [] : [...new Set(competidores.filter(x => Math.abs(x.priceUsd - minimo) < 0.0005).map(x => x.cadena))];

      const pvpUsd = Number(p.pvp_propio_usd || 0) > 0 ? Number(p.pvp_propio_usd) : null;
      const tuPrecio = propios.length ? Math.min(...propios.map(x => x.priceUsd)) : (pvpUsd != null ? pvpUsd / (porUnidad ? unidadesPropio : 1) : null);
      const tuUnidad = propios.length ? Math.min(...propios.map(x => x.unitUsd)) : (pvpUsd != null ? pvpUsd / unidadesPropio : null);
      const fuenteTuPrecio = propios.length ? 'enlace' : pvpUsd ? 'pvp' : null;
      // Promedio del mercado: la competencia mas tu precio (como el Mapa de Calor).
      const promedio = promedioComp == null ? null
        : tuPrecio != null ? (promedioComp * valores.length + tuPrecio) / (valores.length + 1) : promedioComp;
      const difMin = tuPrecio != null && minimo > 0 ? ((tuPrecio - minimo) / minimo) * 100 : null;
      const difProm = tuPrecio != null && promedio > 0 ? ((tuPrecio - promedio) / promedio) * 100 : null;
      // Posicion: el lugar de tu precio entre todas las ofertas (la tuya mas
      // las de la competencia), de la mas barata (1) a la mas cara.
      const posicion = tuPrecio != null && competidores.length
        ? { lugar: 1 + competidores.filter(x => x.priceUsd < tuPrecio - 0.0005).length, de: competidores.length + 1 }
        : null;

      // Precio de la competencia por cadena (el mas bajo si hay varios).
      const porCadena = new Map();
      for (const x of competidores) {
        const previo = porCadena.get(x.cadena);
        if (!previo || x.priceUsd < previo.priceUsd) porCadena.set(x.cadena, x);
      }

      // Cruce con el otro tipo de mercado (misma molecula por el vinculo; mismo
      // empaque salvo que se compare por unidad).
      let cruce = null;
      if (tuPrecio != null) {
        const soyMarca = esMarca(p);
        const opuestos = todos.filter(x => x.tipo !== 'propio' && x.tipoMercado !== (soyMarca ? 'MARCA' : 'GENERICO')
          && (porUnidad || x.unidades === unidadesPropio));
        if (opuestos.length) {
          const ref = soyMarca
            ? opuestos.reduce((a, b) => (b.priceUsd > a.priceUsd ? b : a))
            : opuestos.reduce((a, b) => (b.priceUsd < a.priceUsd ? b : a));
          const dif = (tuPrecio / ref.priceUsd - 1) * 100;
          if (soyMarca ? dif < -0.5 : dif > 0.5) cruce = { tipo: soyMarca ? 'marca_barata' : 'generico_caro', ref, dif };
        }
      }

      return {
        producto: p,
        cruce,
        competencia,
        precios,
        porCadena,
        minimo,
        promedio,
        promedioComp,
        cadenasMin,
        tuPrecio,
        tuUnidad,
        unidadesPropio,
        fuenteTuPrecio,
        difMin,
        difProm,
        posicion,
        cambios: precios.filter(x => Math.abs(x.cambio) > UMBRAL_CAMBIO),
        comparable: tuPrecio != null && minimo != null,
        sinPrecio: precios.length === 0 && tuPrecio == null,
      };
    });
  }, [productos, productosCompetencia, tasa, modoPrecio, modoAnalisis, ventana, variaciones, idCadena, cadenaComp, tipoComp]);

  return { analizados, idCadena, nombreCadena, cadenaPorClave };
}
