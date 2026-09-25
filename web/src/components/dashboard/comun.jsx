import { useCallback, useState } from 'react';

// Piezas que comparten el Dashboard y sus secciones.

// Un cambio de precio cuenta si se movio mas de 0,5 % (en dolares).
export const UMBRAL_CAMBIO = 0.5;
// Diferencia con el minimo por debajo de la cual se considera "empatado".
export const UMBRAL_EMPATE = 0.5;
// A menos de 1 % del precio meta se considera "en la meta".
export const UMBRAL_META = 1;

export const VENTANAS = { 1: 'últimas 24 horas', 7: 'últimos 7 días', 15: 'últimos 15 días' };

export const METAS = [
  [-15, 'Meta: 15 % bajo el promedio'],
  [-10, 'Meta: 10 % bajo el promedio'],
  [-5, 'Meta: 5 % bajo el promedio'],
  [0, 'Meta: el promedio'],
  [5, 'Meta: 5 % sobre el promedio'],
  [10, 'Meta: 10 % sobre el promedio'],
];
export const textoMeta = (meta) => (meta === 0 ? 'el promedio' : `${Math.abs(meta)} % ${meta < 0 ? 'bajo' : 'sobre'} el promedio`);

// Preferencias de vista que se recuerdan en el navegador.
export function usePreferencia(clave, inicial, validos) {
  const [valor, setValor] = useState(() => {
    try {
      const guardado = localStorage.getItem(clave);
      if (guardado == null) return inicial;
      const v = typeof inicial === 'number' ? Number(guardado) : guardado;
      return !validos || validos.includes(v) ? v : inicial;
    } catch { return inicial; }
  });
  const cambiar = useCallback((v) => {
    setValor(v);
    try { localStorage.setItem(clave, String(v)); } catch { /* sin almacenamiento */ }
  }, [clave]);
  return [valor, cambiar];
}

export function leerColor(token, respaldo) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(token).trim() || respaldo;
  } catch { return respaldo; }
}

export function mediana(valores) {
  if (!valores.length) return null;
  const o = [...valores].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return o.length % 2 ? o[m] : (o[m - 1] + o[m]) / 2;
}

// "−4,2 %" / "+3 %"
export function pct(v, decimales = 1) {
  if (v == null || isNaN(v)) return '—';
  const abs = Math.abs(v).toLocaleString('es-VE', { maximumFractionDigits: decimales });
  if (Math.abs(v) < 0.05) return '0 %';
  return `${v > 0 ? '+' : '−'}${abs} %`;
}

// Formato de precios en la moneda elegida. Los precios por unidad llevan mas
// decimales: una tableta de $0.012 no puede salir como $0.01.
export function crearFormato(moneda, tasa) {
  const enMoneda = (usd, dec) => {
    if (usd == null || isNaN(usd)) return '—';
    if (moneda === 'usd') return `$${usd.toFixed(dec)}`;
    if (!tasa) return '—';
    return `Bs ${(usd * tasa).toLocaleString('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
  return {
    fmt: (usd) => enMoneda(usd, 2),
    fmtUnidad: (usd) => enMoneda(usd, usd != null && Math.abs(usd) < 1 ? 3 : 2),
  };
}

// Diferencia con signo y color: azul si eres mas barato, rojo si mas caro.
export function Diferencia({ valor }) {
  if (valor == null || isNaN(valor)) return <span className="text-on-surface-variant">—</span>;
  const parejo = Math.abs(valor) < UMBRAL_EMPATE;
  return (
    <span className={`m3-diferencia ${parejo ? '' : valor > 0 ? 'is-caro' : 'is-barato'}`}>
      {!parejo && <span className="material-symbols-outlined" aria-hidden="true">{valor > 0 ? 'arrow_upward' : 'arrow_downward'}</span>}
      {pct(valor)}
    </span>
  );
}

// Cuanto subir o bajar tu precio para quedar en la meta (promedio ± X %).
export function calcularAjuste(tuPrecio, promedio, meta) {
  if (tuPrecio == null || !(tuPrecio > 0) || !(promedio > 0)) return null;
  const objetivo = promedio * (1 + meta / 100);
  const porcentaje = (objetivo / tuPrecio - 1) * 100;
  return {
    objetivo,
    usd: objetivo - tuPrecio,
    porcentaje,
    estado: Math.abs(porcentaje) < UMBRAL_META ? 'en_meta' : porcentaje < 0 ? 'bajar' : 'subir',
  };
}

export function AjusteMeta({ ajuste, fmt }) {
  if (!ajuste) return <span className="text-on-surface-variant">—</span>;
  if (ajuste.estado === 'en_meta') {
    return (
      <span className="m3-diferencia">
        <span className="material-symbols-outlined" aria-hidden="true">check</span>En la meta
      </span>
    );
  }
  const bajar = ajuste.estado === 'bajar';
  return (
    <span className="inline-flex flex-col items-end leading-tight" title={`Precio meta: ${fmt(ajuste.objetivo)}`}>
      <span className={`m3-diferencia ${bajar ? 'is-caro' : 'is-barato'}`}>
        {bajar ? 'Bajar' : 'Subir'} {fmt(Math.abs(ajuste.usd))}
      </span>
      <span className="m3-body-small text-on-surface-variant tabular-nums">{pct(ajuste.porcentaje)}</span>
    </span>
  );
}

// Grupos del grafico "Tu precio frente al promedio". Divergente: azul mas
// barato, gris parejo, rojo mas caro (tokens validados en m3-tokens.css).
export const GRUPOS = [
  { id: 'muy_barato', corto: '15 % o más barato', eje: '−15 %|o más', desde: -Infinity, hasta: -15, token: '--md-sys-color-data-div-cheap-2', respaldo: '#2a78d6' },
  { id: 'barato', corto: '5 a 15 % más barato', eje: '−5 a|−15 %', desde: -15, hasta: -5, token: '--md-sys-color-data-div-cheap-1', respaldo: '#6aa1e6' },
  { id: 'parejo', corto: 'Parejo (±5 %)', eje: '±5 %', desde: -5, hasta: 5, token: '--md-sys-color-data-div-mid', respaldo: '#a9a8a3' },
  { id: 'caro', corto: '5 a 15 % más caro', eje: '+5 a|+15 %', desde: 5, hasta: 15, token: '--md-sys-color-data-div-dear-1', respaldo: '#ec7a79' },
  { id: 'muy_caro', corto: '15 % o más caro', eje: '+15 %|o más', desde: 15, hasta: Infinity, token: '--md-sys-color-data-div-dear-2', respaldo: '#e34948' },
];
export const grupoDe = (dif) => GRUPOS.find(g => dif > g.desde && dif <= g.hasta) || (dif <= -15 ? GRUPOS[0] : GRUPOS[4]);
