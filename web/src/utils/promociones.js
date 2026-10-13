// Promociones de varias unidades que detecta el robot (dim_tipos_promocion):
// el precio real de cada caja llevando la promocion. 2x1 = la mitad; 3x2 =
// dos tercios; segunda unidad con descuento = se asume 50 % en la segunda
// (unidades_paga 1,5 de 2, como en la base).
export const PROMOCIONES = {
  '2x1': { factor: 1 / 2, texto: '2x1' },
  '3x2': { factor: 2 / 3, texto: '3x2' },
  segunda_unidad_descuento: { factor: 0.75, texto: '2.ª unidad con descuento' },
};

// Factor por el que se multiplica el precio de la caja (1 = sin promocion).
export const factorPromo = (codigo) => PROMOCIONES[codigo]?.factor ?? 1;
export const textoPromo = (codigo) => PROMOCIONES[codigo]?.texto || null;

export const AYUDA_OFERTA = 'Precio con oferta. Con 2x1, 3x2 o 2.ª unidad con descuento, lo que cuesta cada caja llevando la promoción.';
