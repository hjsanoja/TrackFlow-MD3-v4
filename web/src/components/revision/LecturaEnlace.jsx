import { normalizar } from '../formulario';
import { textoDosis, textoTamano } from '../../utils/leerPresentacion';

// Lectura de un enlace para revisar lecturas del robot. La usan Revision de
// capturas, Precios repetidos y Sugerencias de enlaces, para que se lean
// igual en los tres lugares:
//   1. Que producto es el enlace y con cual de TUS productos se relaciona.
//   2. Una tabla «Registrado» (lo que dice el panel) frente a «Leído en la
//      tienda» (lo que vio el robot), fila por fila: nombre, laboratorio,
//      dosis y tamaño. Lo que no coincide va en rojo con una ✗.
//
// enlace: { nombre, laboratorio, dosis_mg, tamano, unidad }   (registrado)
// propio: { nombre, id, laboratorio, presentacion }            (tu producto)
// leido:  { nombre, parecido, parecidoBajo, dosis_mg, tamano, unidad, marca }
// estados (opcional): { laboratorio, dosis, tamano } = 'si' | 'no' | null,
//   cuando quien llama ya los sabe (el buscador los calcula).

const num = (v) => (v == null || v === '' ? null : Number(v));

// El laboratorio "aparece" si todas sus palabras de 3 letras o mas estan en el nombre.
function laboratorioEnNombre(lab, nombre) {
  const palabras = normalizar(lab || '').split(/\s+/).filter(p => p.length >= 3);
  if (!palabras.length || !nombre) return null;
  const texto = ` ${normalizar(nombre)} `;
  return palabras.every(p => texto.includes(p)) ? 'si' : null;
}

function compararDosis(a, b) {
  const x = num(a); const y = num(b);
  if (x == null || y == null) return null;
  return Math.abs(x - y) < 0.001 ? 'si' : 'no';
}

function compararTamano(enlace, leido) {
  const x = num(enlace.tamano); const y = num(leido.tamano);
  if (x == null || y == null) return null;
  if ((enlace.unidad || 'unidad') !== (leido.unidad || 'unidad')) return null;
  return Math.abs(x - y) < 0.001 ? 'si' : 'no';
}

function Estado({ valor }) {
  if (valor === 'si') return <span className="material-symbols-outlined m3-ficha-icono is-si" aria-label="coincide">check_circle</span>;
  if (valor === 'no') return <span className="material-symbols-outlined m3-ficha-icono is-no" aria-label="no coincide">cancel</span>;
  return null;
}

// Que producto es y de cual de tus productos es competidor.
export function IdentidadEnlace({ esPropio, enlace, propio }) {
  const detallePropio = [propio?.id ? `ID ${propio.id}` : null, propio?.laboratorio, propio?.presentacion].filter(Boolean).join(' · ');
  return (
    <div className="m3-ficha-identidad">
      <div className="m3-ficha-titulo">
        {esPropio && <span className="m3-chip-propio">Tú</span>}
        <span>{enlace.nombre}</span>
        {enlace.laboratorio && <span className="m3-ficha-lab">{enlace.laboratorio}</span>}
      </div>
      <div className="m3-ficha-relacion">
        <span className="material-symbols-outlined" aria-hidden="true">{esPropio ? 'inventory_2' : 'link'}</span>
        {esPropio ? (
          <span>Tu producto{detallePropio ? ` · ${detallePropio}` : ''}</span>
        ) : (
          <span>Competidor de tu producto <strong className="text-on-surface font-medium">{propio?.nombre || 'sin relación'}</strong>{detallePropio ? ` · ${detallePropio}` : ''}</span>
        )}
      </div>
    </div>
  );
}

// Registrado frente a leido en la tienda.
export function TablaLectura({ enlace, leido, estados }) {
  const hayLectura = Boolean(leido?.nombre);
  const est = {
    laboratorio: estados?.laboratorio !== undefined ? estados.laboratorio : laboratorioEnNombre(enlace.laboratorio, leido?.nombre),
    dosis: estados?.dosis !== undefined ? estados.dosis : compararDosis(enlace.dosis_mg, leido?.dosis_mg),
    tamano: estados?.tamano !== undefined ? estados.tamano : compararTamano(enlace, leido || {}),
  };
  const leidoLab = !hayLectura ? '—'
    : est.laboratorio === 'si' ? 'Aparece en el nombre'
    : est.laboratorio === 'no' ? (leido.marca || 'Otro laboratorio')
    : leido.marca || 'No aparece en el nombre';
  const filas = [
    {
      rotulo: 'Nombre',
      registrado: enlace.nombre,
      leido: hayLectura ? (
        <>
          «{leido.nombre}»
          {leido.parecido != null && (
            <span className={`m3-ficha-parecido ${leido.parecidoBajo ? 'is-no' : ''}`}>{Math.round(Number(leido.parecido) * 100)} % parecido</span>
          )}
        </>
      ) : 'El robot no guardó el nombre',
      estado: leido?.parecidoBajo ? 'no' : null,
    },
    { rotulo: 'Laboratorio', registrado: enlace.laboratorio || 'Sin registrar', leido: leidoLab, estado: est.laboratorio },
    { rotulo: 'Dosis', registrado: textoDosis(enlace.dosis_mg) || 'Sin registrar', leido: hayLectura ? textoDosis(leido.dosis_mg) || 'No la dice' : '—', estado: est.dosis },
    { rotulo: 'Tamaño', registrado: textoTamano(enlace.tamano, enlace.unidad) || 'Sin registrar', leido: hayLectura ? textoTamano(leido.tamano, leido.unidad) || 'No lo dice' : '—', estado: est.tamano },
  ];
  return (
    <table className="m3-ficha-tabla">
      <thead>
        <tr><th scope="col"><span className="sr-only">Dato</span></th><th scope="col">Registrado en el panel</th><th scope="col">Leído en la tienda</th></tr>
      </thead>
      <tbody>
        {filas.map(f => (
          <tr key={f.rotulo}>
            <th scope="row">{f.rotulo}</th>
            <td>{f.registrado}</td>
            <td className={f.estado ? `is-${f.estado}` : ''}><Estado valor={f.estado} />{f.leido}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function LecturaEnlace({ esPropio, enlace, propio, leido, estados }) {
  return (
    <div className="m3-ficha">
      <IdentidadEnlace esPropio={esPropio} enlace={enlace} propio={propio} />
      <TablaLectura enlace={enlace} leido={leido} estados={estados} />
    </div>
  );
}
