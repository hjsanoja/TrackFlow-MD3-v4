// Ayuda de cada pantalla (boton "Ayuda" de la barra de arriba). Mismo
// contenido que el Manual de TrackFlow, en corto. Clave = primer tramo de la
// ruta ("/mapa-cadenas").
export const AYUDA_MENUS = {
  '/': {
    titulo: 'Dashboard',
    para: 'La foto del día: cómo está tu precio frente al mercado y qué cambió desde tu última visita.',
    pasos: [
      'Mira las tarjetas de arriba: cuántos productos están más baratos, parejos o más caros que el promedio. Toca una para filtrar.',
      'Revisa «Cambios desde tu última visita».',
      'En la tabla, toca un producto para ver su ficha e historial.',
      '«Exportar» descarga la tabla en CSV.',
    ],
    pregunta: '¿En qué productos estoy más caro hoy? → toca la tarjeta roja.',
  },
  '/mapa-calor': {
    titulo: 'Rango de precios',
    para: 'Por cada producto, todos los precios del mercado del más barato al más caro, y un punto con el tuyo.',
    pasos: [
      'La barra va de azul (barato) a gris (parejo) a rojo (caro).',
      'El punto es tu precio: cuanto más a la izquierda, más competitivo.',
      'Filtra por posición para ir directo a los más caros o más baratos.',
    ],
    pregunta: '¿Qué tan lejos estoy del más barato? → compara el punto con el inicio de la barra.',
  },
  '/mapa-cadenas': {
    titulo: 'Mapa de calor',
    para: 'Tu precio de cada producto (filas) en cada cadena (columnas).',
    pasos: [
      'El color se lee por fila: azul = la cadena donde ese producto está más barato.',
      'Gris = hasta 5 % más caro; rojo claro = 5 a 15 %; rojo = 15 % o más.',
      'En «Color» puedes comparar contra la competencia de cada cadena.',
    ],
    pregunta: '¿Qué cadena encarece mis productos? → busca la columna con más rojos.',
  },
  '/margen-cadena': {
    titulo: 'Margen por cadena',
    para: 'Tu PSL frente al precio al que lo vende la cadena, y ese precio frente a los laboratorios que elijas.',
    pasos: [
      'Elige la cadena y de 1 a 9 laboratorios; las columnas salen en el orden en que los eliges.',
      'Teórico = PSL × factor (1,5 = 50 %). El lápiz cambia el factor solo de un producto.',
      'Margen real = precio en la cadena ÷ PSL − 1. GAP = competidor ÷ tu precio en la cadena − 1: rojo es un competidor más barato.',
      'En «Ver: Cadenas» comparas tu margen en todas las cadenas a la vez. Lo que eliges queda guardado para ti.',
    ],
    pregunta: '¿Quién me gana en Farmatodo? → elige Farmatodo y filtra «Algún competidor más barato».',
  },
  '/productos': {
    titulo: 'Productos',
    para: 'Tu catálogo: molécula, dosis, forma, tamaño, laboratorio y PSL de cada producto.',
    pasos: [
      'Si sale el aviso de ficha incompleta, toca «Ver cuáles» y completa lo que falta.',
      '«Cargar CSV» agrega varios a la vez (descarga antes la plantilla).',
      'El PSL (precio de salida del laboratorio) solo entra en Margen por cadena.',
    ],
    pregunta: '¿Qué productos tienen datos incompletos? → filtro «Ficha: Incompletas».',
  },
  '/competencia': {
    titulo: 'Relación',
    para: 'Los enlaces que lee el robot: tu producto en cada cadena y sus competidores.',
    pasos: [
      '«Vincular enlace»: pega la dirección del producto en la tienda.',
      'El aviso «Para revisar» lista enlaces que fallan, duplicados y competidores sin unidades.',
      'Toca un enlace para ver su precio, su historial y si tiene promoción (2x1, 3x2).',
    ],
    pregunta: '¿Qué enlaces ya no traen precio? → Revisar: «Sin precio hace +7 días».',
  },
  '/cadenas': {
    titulo: 'Cadenas',
    para: 'Las farmacias que vigila el robot y cómo le fue en la última lectura.',
    pasos: ['«Lee bien», «Lee con fallas» o «No leyó precios» resume la última corrida.', 'Si una cadena falla varios días, avísale al administrador.'],
    pregunta: '¿El robot leyó todo hoy? → mira la columna Robot.',
  },
  '/dimensiones': {
    titulo: 'Dimensiones',
    para: 'Las listas que usan los productos: laboratorios, categorías, unidades, formas, moléculas y tasa BCV.',
    pasos: ['Corrige nombres o une duplicados (por ejemplo «Calox» y «Calox S.A.»).', 'El aviso de arriba dice qué elementos no usa ningún producto.'],
    pregunta: '¿Hay laboratorios repetidos? → busca el nombre y usa «Unir».',
  },
  '/experimental': {
    titulo: 'Experimental',
    para: 'Herramientas en prueba: limpieza de datos (Revisión de capturas, Sugerencias) y análisis.',
    pasos: [
      'Revisión de capturas: compara lo registrado con lo leído en la tienda y marca válida o errónea.',
      'Sugerencias de enlaces: acepta o descarta enlaces propuestos, uno o varios a la vez.',
      'Simulador: mueve el control para ver tu posición si subes o bajas tus precios.',
    ],
    pregunta: '¿Hay precios raros por revisar? → la campana o la pestaña Revisión de capturas.',
  },
  '/usuarios': {
    titulo: 'Usuarios',
    para: 'Quién entra al panel, qué ve y qué puede cambiar.',
    pasos: [
      '«Nuevo usuario»: elige un perfil y ajusta lo que haga falta.',
      'Marca varios usuarios para aplicarles un perfil de una vez.',
      'En la ficha: actividad por menú e historial de permisos.',
    ],
    pregunta: '¿Quién no usa el panel? → filtro Estado: «Sin entrar 30+ días».',
  },
  '/mi-cuenta': {
    titulo: 'Mi cuenta',
    para: 'Tu nombre, tu contraseña y los correos que recibes.',
    pasos: ['Cambia tu contraseña cuando quieras.', 'Desde aquí puedes volver a ver el recorrido de bienvenida.'],
    pregunta: '',
  },
};

export const GLOSARIO = [
  ['Lista / Oferta', 'Lista = precio normal. Oferta = lo que pagas: con descuento y, con 2x1 o 3x2, el precio de cada caja con la promoción.'],
  ['Empaque / Unidad', 'Precio de la caja, o por tableta, ml o g para comparar cajas de distinto tamaño.'],
  ['Promedio del mercado', 'Promedio de la competencia más tu precio.'],
  ['Parejo', 'A menos de 5 % del valor con que se compara.'],
  ['Botón i', 'Explica cada gráfico: qué es, cómo se calcula, cómo leerlo y un ejemplo.'],
];

// Guia visual (pagina con dibujos de las pantallas principales). Para que
// otros la abran, debe estar compartida desde claude.ai.
export const GUIA_VISUAL_URL = 'https://claude.ai/artifact/GRTMK9pfrzu2zdrxJeVJcP';

export const ayudaDe = (ruta) => AYUDA_MENUS[`/${String(ruta || '/').split(/[?#]/)[0].split('/')[1] || ''}`] || AYUDA_MENUS['/'];
