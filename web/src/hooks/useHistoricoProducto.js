import { useEffect, useState } from 'react';
import { supabase, isSupabaseActive } from '../supabase';

// Historia de precios de UN producto propio (sus enlaces y los de su
// competencia) de los ultimos `dias`, pedida al abrir la pantalla que la usa.
// Es mucho mas rapido que bajar el historico completo de todos los productos.
export function useHistoricoProducto(pId, dias, columnas = '*') {
  const [estado, setEstado] = useState({ cargando: true, filas: [] });

  useEffect(() => {
    if (!pId || !isSupabaseActive()) { setEstado({ cargando: false, filas: [] }); return undefined; }
    let vigente = true;
    setEstado(h => ({ ...h, cargando: true }));
    const desde = new Date(Date.now() - dias * 864e5).toISOString();
    (async () => {
      const filas = [];
      for (let pagina = 0; pagina < 10; pagina++) {
        const { data, error } = await supabase.from('historico_precios')
          .select(columnas)
          .eq('id_producto_propio', pId).gte('scraped_at', desde)
          .order('scraped_at', { ascending: true })
          .range(pagina * 1000, pagina * 1000 + 999);
        if (error || !data?.length) break;
        filas.push(...data);
        if (data.length < 1000) break;
      }
      if (vigente) setEstado({ cargando: false, filas });
    })().catch(() => { if (vigente) setEstado({ cargando: false, filas: [] }); });
    return () => { vigente = false; };
  }, [pId, dias, columnas]);

  return [estado, setEstado];
}
