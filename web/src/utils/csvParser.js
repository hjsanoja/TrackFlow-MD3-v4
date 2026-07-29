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
    const foundKey = rowKeys.find(rk => {
      const rkNorm = norm(rk);
      return rkNorm.includes(targetNorm) || targetNorm.includes(rkNorm);
    });
    if (foundKey && row[foundKey] !== undefined && String(row[foundKey]).trim() !== '') {
      return String(row[foundKey]).trim();
    }
  }

  return '';
}
