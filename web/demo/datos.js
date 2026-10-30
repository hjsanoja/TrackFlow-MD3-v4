// Datos de EJEMPLO para grabar los videos de ayuda (no son precios reales).
const TASA = 875.65;
const hoy = new Date().toISOString();
const CADENAS = [
  { id: 'farmatodo', nombre: 'Farmatodo', activo: true, website: 'farmatodo.com.ve' },
  { id: 'locatel', nombre: 'Locatel', activo: true, website: 'locatel.com.ve' },
  { id: 'Saas', nombre: 'Farmacias SAAS', activo: true, website: 'farmaciasaas.com' },
  { id: 'FarmaGo', nombre: 'FarmaGo', activo: true, website: 'farmago.com.ve' },
];
const PRODUCTOS = [
  ['P01', 'Clopidogrel 75 mg x 30', 'Clopidogrel', 6.4],
  ['P02', 'Valsartán 80 mg x 30', 'Valsartán', 5.68],
  ['P03', 'Olmesartán 20 mg x 30', 'Olmesartán', 6.25],
  ['P04', 'Atorvastatina 20 mg x 30', 'Atorvastatina', 5.78],
  ['P05', 'Irbesartán 150 mg x 30', 'Irbesartán', 9.64],
  ['P06', 'Rosuvastatina 20 mg x 30', 'Rosuvastatina', 15.17],
  ['P07', 'Losartán 50 mg x 30', 'Losartán', 1.35],
  ['P08', 'Candesartán 16 mg x 30', 'Candesartán', 7.53],
  ['P09', 'Amlodipino 5 mg x 30', 'Amlodipino', 2.62],
  ['P10', 'Carvedilol 12,5 mg x 30', 'Carvedilol', 5.11],
];
const LABS = ['Genven', 'Calox', 'Leti', 'Elter'];
// Numeros pseudoaleatorios fijos: el video sale igual cada vez.
let semilla = 7;
const azar = () => { semilla = (semilla * 9301 + 49297) % 233280; return semilla / 233280; };

export const productos = PRODUCTOS.map(([id, nombre, molecula, psl]) => ({
  id, id_interno: id, nombre, activo: true, pvp_propio_usd: psl, unidosis: 30, tamano: '30 unidad',
  categoria: 'Cardiovascular', unidad_negocio: 'La Sante', laboratorio: 'La Sante', market_type: 'GENERICO',
  principio_activo: molecula, concentracion: '', forma_farmaceutica: 'Tabletas',
}));

let n = 0;
export const productosCompetencia = [];
for (const p of productos) {
  for (const c of CADENAS) {
    if (azar() < 0.15) continue;
    const mio = p.pvp_propio_usd * (1.38 + azar() * 0.3) * TASA;
    productosCompetencia.push({ id: `E${++n}`, id_producto_propio: p.id, cadena: c.id, tipo: 'propio', marca: 'La Sante', laboratorio: 'La Sante',
      ultimo_precio_full_bs: Math.round(mio), ultimo_precio_desc_bs: null, activo: true, unidosis: 30, unidades_empaque: 30, ultimo_scrape: hoy, publicacion_id: n });
    for (const lab of LABS) {
      if (azar() < 0.45) continue;
      const comp = mio * (0.75 + azar() * 0.45);
      productosCompetencia.push({ id: `E${++n}`, id_producto_propio: p.id, cadena: c.id, tipo: 'alternativa', marca: `${p.principio_activo} ${lab}`, laboratorio: lab,
        ultimo_precio_full_bs: Math.round(comp), ultimo_precio_desc_bs: azar() < 0.2 ? Math.round(comp * 0.9) : null,
        activo: true, unidosis: 30, unidades_empaque: 30, ultimo_scrape: hoy, publicacion_id: n });
    }
  }
}

export const variaciones = productosCompetencia.map(e => ({
  publicacion_id: e.publicacion_id, precio_actual_full_bs: e.ultimo_precio_full_bs, tasa_actual: TASA,
  precio_1d_full_bs: azar() < 0.12 ? Math.round(e.ultimo_precio_full_bs * (0.9 + azar() * 0.2)) : e.ultimo_precio_full_bs, tasa_1d: TASA,
}));

const dias = Array.from({ length: 30 }, (_, i) => {
  const d = new Date(Date.now() - (29 - i) * 864e5);
  return { dayKey: d.toLocaleDateString('es-VE'), fecha: d.toLocaleDateString('es-VE', { month: 'short', day: 'numeric' }), valor: TASA * (0.95 + i * 0.0017), source: 'oficial', rawDate: d };
});

export const datos = {
  productos, productosCompetencia, cadenas: CADENAS, variaciones, bcvRates: dias,
  ultimaCorrida: { started_at: hoy, finished_at: hoy, estado: 'terminada' },
  loadingInitial: false, isRefreshing: false, usuarios: [],
  refreshData: () => {}, refreshCompetencia: () => {}, vaciarHistorico: () => {},
};
export { TASA };
