/**
 * Parser de CSV robusto con detección automática de delimitadores,
 * soporte para campos entre comillas con saltos de línea y normalización de encabezados.
 */
export function parseCSV(text) {
  if (!text) return [];

  // Eliminar BOM UTF-8 si existe
  let cleanText = text.replace(/^\uFEFF/, '').trim();
  if (!cleanText) return [];

  // 1. Detectar delimitador analizando la primera línea no vacía
  const firstLine = cleanText.split(/\r?\n/)[0] || '';
  let countComma = 0;
  let countSemicolon = 0;
  let countTab = 0;
  let inQ = false;

  for (let i = 0; i < firstLine.length; i++) {
    const char = firstLine[i];
    if (char === '"') {
      inQ = !inQ;
    } else if (!inQ) {
      if (char === ',') countComma++;
      if (char === ';') countSemicolon++;
      if (char === '\t') countTab++;
    }
  }

  let delimiter = ',';
  if (countSemicolon > countComma && countSemicolon >= countTab) {
    delimiter = ';';
  } else if (countTab > countComma && countTab > countSemicolon) {
    delimiter = '\t';
  }

  // 2. Autómata finito para dividir por filas y celdas respetando comillas
  const rows = [];
  let currentRow = [];
  let currentCell = '';
  inQ = false;

  for (let i = 0; i < cleanText.length; i++) {
    const char = cleanText[i];
    const nextChar = cleanText[i + 1];

    if (char === '"') {
      if (inQ && nextChar === '"') {
        // Comilla escapada ("")
        currentCell += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (char === delimiter && !inQ) {
      currentRow.push(currentCell.trim());
      currentCell = '';
    } else if ((char === '\r' || char === '\n') && !inQ) {
      if (char === '\r' && nextChar === '\n') {
        i++;
      }
      currentRow.push(currentCell.trim());
      if (currentRow.some(c => c !== '')) {
        rows.push(currentRow);
      }
      currentRow = [];
      currentCell = '';
    } else {
      currentCell += char;
    }
  }

  if (currentCell !== '' || currentRow.length > 0) {
    currentRow.push(currentCell.trim());
    if (currentRow.some(c => c !== '')) {
      rows.push(currentRow);
    }
  }

  if (rows.length < 2) return [];

  // 3. Encabezados
  const rawHeaders = rows[0];
  const headers = rawHeaders.map(h => h.replace(/^"|"$/g, '').trim());

  const result = [];
  for (let r = 1; r < rows.length; r++) {
    const rowCells = rows[r];
    const rowObj = {};
    let hasData = false;

    headers.forEach((header, colIdx) => {
      if (header) {
        const val = rowCells[colIdx] !== undefined ? rowCells[colIdx].replace(/^"|"$/g, '').trim() : '';
        rowObj[header] = val;
        if (val !== '') hasData = true;
      }
    });

    if (hasData) {
      result.push(rowObj);
    }
  }

  return result;
}

/**
 * Obtiene el valor de un campo probando múltiples alias y coincidencia flexible sin acentos/mayúsculas
 */
export function getRowValue(row, ...aliases) {
  if (!row) return '';

  const norm = str => String(str || '')
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");

  const rowKeys = Object.keys(row);

  // 1. Coincidencia directa por nombre exacto de columna
  for (const alias of aliases) {
    if (row[alias] !== undefined && String(row[alias]).trim() !== '') {
      return String(row[alias]).trim();
    }
  }

  // 2. Coincidencia normalizada exacta (ignora mayúsculas, acentos, espacios, guiones)
  for (const alias of aliases) {
    const targetNorm = norm(alias);
    if (!targetNorm) continue;
    const foundKey = rowKeys.find(rk => norm(rk) === targetNorm);
    if (foundKey && row[foundKey] !== undefined && String(row[foundKey]).trim() !== '') {
      return String(row[foundKey]).trim();
    }
  }

  // 3. Coincidencia por subcadena / prefijo normalizado (ej. "concentracion_mg" coincide con "concentracion")
  for (const alias of aliases) {
    const targetNorm = norm(alias);
    if (!targetNorm || targetNorm.length < 3) continue;
    // Al reves (la columna contenida en el alias) solo como prefijo y con al
    // menos 5 letras: con "contenida en cualquier parte", una columna
    // `activo` respondia por `principio_activo` y la molecula salia "si".
    const foundKey = rowKeys.find(rk => {
      const rkNorm = norm(rk);
      return rkNorm.includes(targetNorm) || (rkNorm.length >= 5 && targetNorm.startsWith(rkNorm));
    });
    if (foundKey && row[foundKey] !== undefined && String(row[foundKey]).trim() !== '') {
      return String(row[foundKey]).trim();
    }
  }

  return '';
}

// ---------------------------------------------------------------------------
// Lectura del archivo con la codificacion correcta.
//
// Excel guarda los CSV en Windows-1252 y, si se abre un CSV UTF-8 y se vuelve
// a guardar, deja los acentos convertidos en "SuspensiÃ³n". Asi entraban en
// la base formas farmaceuticas duplicadas. Aqui se prueba UTF-8, si no encaja
// se lee como Windows-1252, y luego se reparan las secuencias rotas.
// ---------------------------------------------------------------------------

// Caracteres que Windows-1252 pone en 0x80-0x9F, para devolverlos a su byte.
const CP1252_A_BYTE = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87,
  'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e, '‘': 0x91,
  '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98,
  '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
const CONT = `[\\u0080-\\u00BF${Object.keys(CP1252_A_BYTE).join('')}]`;
const RE_MOJIBAKE = new RegExp(`(?:[\\u00C2-\\u00DF]${CONT}|[\\u00E0-\\u00EF]${CONT}{2})+`, 'g');

export function repararMojibake(texto) {
  if (!/[ÂÃ]/.test(texto)) return texto;
  return texto.replace(RE_MOJIBAKE, (trozo) => {
    const bytes = Uint8Array.from([...trozo].map(c => CP1252_A_BYTE[c] ?? c.charCodeAt(0)));
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      return trozo;
    }
  });
}

export async function leerArchivoCsv(file) {
  const buffer = await file.arrayBuffer();
  let texto;
  let codificacion = 'UTF-8';
  try {
    texto = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    texto = new TextDecoder('windows-1252').decode(buffer);
    codificacion = 'Windows-1252';
  }
  const reparado = repararMojibake(texto);
  return { texto: reparado, codificacion, acentosReparados: reparado !== texto };
}
