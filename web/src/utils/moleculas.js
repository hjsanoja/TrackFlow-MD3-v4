// Comparar la molecula de tu producto con la de un competidor, aunque esten
// escritas distinto («Donepezilo» / «Donepecilo», «Losartán Potásico» /
// «Losartan»). La clave de cada molecula es su primera palabra, sin acentos y
// con z->c, ph->f, th->t, y->i y sin la vocal final.
const sinAcentos = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function claveMolecula(nombre) {
  const palabra = sinAcentos(nombre).replace(/[^a-z\s]/g, ' ').trim().split(/\s+/)[0] || '';
  // La vocal final tampoco cuenta: «Amlodipino» y «Amlodipina» son la misma.
  return palabra.replace(/ph/g, 'f').replace(/th/g, 't').replace(/z/g, 'c').replace(/y/g, 'i').replace(/[aeo]$/, '');
}

// "Losartán + Hidroclorotiazida" -> ['losartan', 'hidroclorotiacida']
export function clavesDe(texto) {
  return [...new Set(String(texto || '').split(/\+|,|\/|;|\by\b/i).map(claveMolecula).filter(k => k.length >= 4))];
}

// Moleculas del catalogo que aparecen en un nombre comercial o generico.
export function moleculasEnNombre(nombre, catalogo) {
  const palabras = new Set(sinAcentos(nombre).replace(/[^a-z\s]/g, ' ').split(/\s+/).map(claveMolecula));
  const halladas = [];
  for (const m of catalogo) {
    const k = claveMolecula(m);
    if (k.length >= 4 && palabras.has(k) && !halladas.some(h => claveMolecula(h) === k)) halladas.push(m);
  }
  return halladas;
}

// 'coincide' | 'parcial' (combinacion con una parte en comun) | 'cruce' | 'sin_dato'
export function compararMoleculas(propia, competidor) {
  const a = clavesDe(propia);
  const b = clavesDe(competidor);
  if (!a.length || !b.length) return 'sin_dato';
  const comunes = a.filter(k => b.includes(k));
  if (!comunes.length) return 'cruce';
  return comunes.length === a.length && comunes.length === b.length ? 'coincide' : 'parcial';
}
