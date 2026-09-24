import { useState, useEffect } from 'react';
import { supabase, isSupabaseActive } from '../supabase';

/**
 * Catálogos de las tablas de dimensiones, para alimentar los desplegables de
 * los formularios.
 *
 * Por qué importa: los campos de laboratorio, categoría y unidad de negocio
 * eran texto libre, así que "Calox", "CALOX" y "Calox " acababan como tres
 * filas distintas en dim_laboratorios y partían los análisis en tres.
 *
 * Se usa <datalist> y no <select> cerrado a propósito: sugiere lo que ya
 * existe para evitar duplicados, pero deja escribir un valor nuevo cuando de
 * verdad hace falta. Con un select no se podría dar de alta un laboratorio
 * nuevo sin salir del formulario.
 */

// Caché a nivel de módulo: los catálogos cambian poco y varios formularios
// los piden a la vez.
let cache = null;
let enVuelo = null;

async function cargarDimensiones() {
  if (!isSupabaseActive()) return { laboratorios: [], categorias: [], unidadesNegocio: [], formasFarmaceuticas: [], principiosActivos: [] };

  const pedir = async (tabla, columna = 'nombre') => {
    const { data, error } = await supabase.from(tabla).select(columna).order(columna);
    if (error) {
      console.warn(`[useDimensiones] No se pudo leer ${tabla}:`, error.message);
      return [];
    }
    return (data || []).map(r => r[columna]).filter(Boolean);
  };

  const [laboratorios, categorias, unidadesNegocio, formasFarmaceuticas, principiosActivos] = await Promise.all([
    pedir('dim_laboratorios'),
    pedir('dim_categorias'),
    pedir('dim_unidades_negocio'),
    pedir('dim_formas_farmaceuticas'),
    pedir('dim_principios_activos'),
  ]);

  return { laboratorios, categorias, unidadesNegocio, formasFarmaceuticas, principiosActivos };
}

export function useDimensiones() {
  const [dimensiones, setDimensiones] = useState(cache || {
    laboratorios: [], categorias: [], unidadesNegocio: [],
    formasFarmaceuticas: [], principiosActivos: []
  });

  useEffect(() => {
    if (cache) return;
    if (!enVuelo) enVuelo = cargarDimensiones();
    let vigente = true;
    enVuelo.then(d => {
      cache = d;
      if (vigente) setDimensiones(d);
    });
    return () => { vigente = false; };
  }, []);

  // `cargado` distingue "todavia no llego" de "llego vacio".
  return { ...dimensiones, cargado: Boolean(cache) };
}

// Permite refrescar tras crear una dimensión nueva desde otra pantalla.
export function invalidarDimensiones() {
  cache = null;
  enVuelo = null;
}
