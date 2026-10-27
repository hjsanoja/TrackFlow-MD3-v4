// Exporta una tabla a Excel (.xlsx) con el mismo aspecto de la pantalla:
// titulo, detalle de lo elegido, encabezados agrupados (p. ej. «Farmatodo» con
// «Precio» y «Margen» debajo), celdas con el color del mapa, fila de promedios
// y leyenda. exceljs se carga solo al exportar (no pesa en el panel).
//
//   grupos: [{ titulo, columnas: [{ titulo, ancho }] }]
//   filas / pie: arreglos de celdas { v, formato, color, nota, negrita } (null = en blanco)
//     formato: 'moneda' | 'pct' | 'factor' | 'texto'; v en % para 'pct' (42 = 42 %)
//     color: id de tramo (muy_barato, barato, parejo, caro, muy_caro)
//   leyenda: [{ color, texto }]
//   decimales: de los precios (3 para precios por unidad en dolares)

// Mismos colores que las celdas del mapa (tokens data-div mezclados con blanco).
const COLORES = {
  muy_barato: ['2a78d6', 0.42],
  barato: ['6aa1e6', 0.30],
  parejo: ['a9a8a3', 0.22],
  caro: ['ec7a79', 0.30],
  muy_caro: ['e34948', 0.42],
};
const mezclar = ([hex, p]) => 'FF' + [0, 2, 4]
  .map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * p + 255 * (1 - p)).toString(16).padStart(2, '0'))
  .join('').toUpperCase();
const relleno = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

const PRIMARIO = 'FF0F2C59';
const TONAL = 'FFD6E3FF';
const GRIS = 'FFF1F3F8';
const TEXTO_SUAVE = 'FF5B6170';
const BORDE = { style: 'thin', color: { argb: 'FFD9DDE6' } };

export async function exportarExcel({ archivo, hoja = 'Datos', titulo, detalle = [], grupos, filas, pie, leyenda = [], moneda = 'bs', decimales = 2 }) {
  const { default: ExcelJS } = await import('exceljs');
  const libro = new ExcelJS.Workbook();
  libro.creator = 'TrackFlow';
  const ws = libro.addWorksheet(String(hoja).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31), { views: [{ showGridLines: false }] });

  const columnas = grupos.flatMap(g => g.columnas);
  const total = columnas.length;
  ws.columns = columnas.map(c => ({ width: c.ancho || 14 }));
  const dec = `0.${'0'.repeat(decimales)}`;
  const formatoMoneda = moneda === 'usd' ? `"$"#,##${dec}` : `"Bs" #,##${dec}`;
  const formatos = { moneda: formatoMoneda, pct: '0%', factor: '"×"0.00', texto: '@' };

  // Titulo y detalle
  let r = 1;
  ws.mergeCells(r, 1, r, total);
  Object.assign(ws.getCell(r, 1), { value: titulo });
  ws.getCell(r, 1).font = { bold: true, size: 16, color: { argb: PRIMARIO } };
  ws.getRow(r).height = 24;
  for (const linea of detalle) {
    r += 1;
    ws.mergeCells(r, 1, r, total);
    ws.getCell(r, 1).value = linea;
    ws.getCell(r, 1).font = { size: 10, color: { argb: TEXTO_SUAVE } };
  }
  r += 2;

  // Encabezado en dos filas: grupo arriba, columnas abajo.
  const filaGrupo = r;
  const filaSub = r + 1;
  let col = 1;
  grupos.forEach((g, i) => {
    const n = g.columnas.length;
    const fondo = i % 2 ? PRIMARIO : 'FF1E3F73';
    const sola = n === 1 && !g.columnas[0].titulo;
    const celda = ws.getCell(filaGrupo, col);
    celda.value = g.titulo;
    for (let k = 0; k < n; k += 1) {
      const arriba = ws.getCell(filaGrupo, col + k);
      arriba.fill = relleno(fondo);
      arriba.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      arriba.alignment = { horizontal: k === 0 && i === 0 ? 'left' : 'center', vertical: 'middle', wrapText: true };
      if (sola) continue;
      const abajo = ws.getCell(filaSub, col + k);
      abajo.value = g.columnas[k].titulo;
      abajo.fill = relleno(TONAL);
      abajo.font = { bold: true, size: 10, color: { argb: PRIMARIO } };
      abajo.alignment = { horizontal: 'center', vertical: 'middle' };
      abajo.border = { bottom: BORDE };
    }
    // Las celdas se combinan al final, ya con su estilo.
    if (sola) ws.mergeCells(filaGrupo, col, filaSub, col);
    else if (n > 1) ws.mergeCells(filaGrupo, col, filaGrupo, col + n - 1);
    col += n;
  });
  ws.getRow(filaGrupo).height = 22;
  r = filaSub + 1;

  const escribir = (celdas, extra = {}) => {
    celdas.forEach((c, i) => {
      const cell = ws.getCell(r, i + 1);
      const vacio = c?.v == null || c.v === '';
      if (c == null) {
        // celda en blanco (p. ej. en la fila de promedios)
      } else if (vacio) {
        cell.value = '—';
        cell.alignment = { horizontal: 'center' };
        cell.font = { color: { argb: TEXTO_SUAVE } };
      } else {
        cell.value = c.formato === 'pct' ? c.v / 100 : c.v;
        if (c.formato) cell.numFmt = formatos[c.formato];
        cell.alignment = { horizontal: c.formato && c.formato !== 'texto' ? 'right' : 'left', vertical: 'middle', wrapText: c.formato === 'texto' || !c.formato };
        if (c.negrita) cell.font = { bold: true };
        if (c.suave) cell.font = { size: 9, color: { argb: TEXTO_SUAVE } };
      }
      if (c?.color && COLORES[c.color]) cell.fill = relleno(mezclar(COLORES[c.color]));
      if (c?.nota) cell.note = c.nota;
      cell.border = { bottom: BORDE };
      if (extra.fondo && !c?.color) cell.fill = relleno(extra.fondo);
      if (extra.negrita) cell.font = { ...(cell.font || {}), bold: true };
    });
    r += 1;
  };
  filas.forEach(f => escribir(f));
  if (pie) {
    escribir(pie, { fondo: GRIS, negrita: true });
    for (let i = 1; i <= total; i += 1) ws.getCell(r - 1, i).border = { top: { style: 'medium', color: { argb: PRIMARIO } }, bottom: BORDE };
  }

  // Leyenda
  if (leyenda.length) {
    r += 1;
    ws.getCell(r, 1).value = 'Colores';
    ws.getCell(r, 1).font = { bold: true, size: 10 };
    leyenda.forEach(l => {
      r += 1;
      const muestra = ws.getCell(r, 1);
      muestra.fill = relleno(mezclar(COLORES[l.color]));
      ws.mergeCells(r, 2, r, Math.min(total, 6));
      ws.getCell(r, 2).value = l.texto;
      ws.getCell(r, 2).font = { size: 10 };
    });
  }

  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 } };
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: filaSub, showGridLines: false }];

  const datos = await libro.xlsx.writeBuffer();
  const blob = new Blob([datos], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${archivo}_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
