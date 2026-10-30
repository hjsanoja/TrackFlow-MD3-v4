// Graba los videos de ayuda solos: abre cada pantalla con datos de EJEMPLO
// (demo/datos.js), la recorre con subtitulos y un cursor, y guarda el video
// en public/videos/<id>.webm. Para regenerarlos tras cambiar una pantalla:
//
//   cd web
//   npx vite --config demo/vite.demo.config.mjs   (en otra terminal)
//   node demo/grabar.mjs                          (necesita Playwright)
//
// Cada guion es una lista de pasos: un texto (subtitulo) y, si hace falta,
// una accion sobre la pantalla.
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node22/lib/node_modules/playwright'); }

const BASE = process.env.DEMO_URL || 'http://localhost:5198/demo/demo.html';
const SALIDA = path.resolve(import.meta.dirname, '..', 'public', 'videos');
const TAM = { width: 1280, height: 720 };
const pausa = (ms) => new Promise(r => setTimeout(r, ms));

// Subtitulo, cursor y recuadro dibujados sobre la pagina.
async function prepararCapas(page) {
  await page.addStyleTag({ content: `
    #tf-sub { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); z-index: 99999; max-width: 980px;
      background: rgba(15,44,89,.94); color: #fff; font: 600 20px/1.35 'Roboto Flex', Arial, sans-serif; padding: 12px 22px;
      border-radius: 14px; box-shadow: 0 6px 24px rgba(0,0,0,.25); text-align: center; transition: opacity .25s; }
    #tf-cursor { position: fixed; z-index: 99999; width: 22px; height: 22px; border-radius: 50%; pointer-events: none;
      background: rgba(46,196,166,.55); border: 2px solid #0F2C59; transition: left .6s ease, top .6s ease; left: 640px; top: 360px; }
    #tf-marco { position: fixed; z-index: 99998; pointer-events: none; border: 3px solid #2EC4A6; border-radius: 14px;
      box-shadow: 0 0 0 9999px rgba(15,44,89,.18); transition: all .4s ease; opacity: 0; }
    #tf-marca { position: fixed; right: 16px; top: 12px; z-index: 99999; font: 500 12px Arial; color: #5b6170;
      background: rgba(255,255,255,.85); padding: 3px 8px; border-radius: 6px; }` });
  await page.evaluate(() => {
    for (const id of ['tf-sub', 'tf-cursor', 'tf-marco', 'tf-marca']) {
      const d = document.createElement('div'); d.id = id; document.body.appendChild(d);
    }
    document.getElementById('tf-marca').textContent = 'Datos de ejemplo';
    document.getElementById('tf-sub').style.opacity = '0';
  });
}

async function decir(page, texto, ms = 3800) {
  await page.evaluate((t) => { const s = document.getElementById('tf-sub'); s.textContent = t; s.style.opacity = t ? '1' : '0'; }, texto);
  await pausa(ms);
}

async function senalar(page, locator, { clic = false, marco = true } = {}) {
  const el = page.locator(locator).first();
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await pausa(300);
  const caja = await el.boundingBox();
  if (!caja) return;
  await page.evaluate(({ c, marco }) => {
    const cur = document.getElementById('tf-cursor');
    cur.style.left = `${c.x + c.width / 2 - 11}px`; cur.style.top = `${c.y + c.height / 2 - 11}px`;
    const m = document.getElementById('tf-marco');
    Object.assign(m.style, { left: `${c.x - 6}px`, top: `${c.y - 6}px`, width: `${c.width + 12}px`, height: `${c.height + 12}px`, opacity: marco ? '1' : '0' });
  }, { c: caja, marco });
  await pausa(700);
  if (clic) await el.click();
}

async function sinMarco(page) {
  await page.evaluate(() => { document.getElementById('tf-marco').style.opacity = '0'; });
}

const GUIONES = [
  {
    id: 'dashboard', pantalla: 'dashboard', titulo: 'Dashboard',
    pasos: async (p) => {
      await decir(p, 'Dashboard: cómo están tus precios frente a la competencia, cada día.');
      await senalar(p, 'text=Tú frente al promedio');
      await decir(p, 'Arriba, los indicadores. «Tú frente al promedio» dice si estás más caro o más barato que el mercado.');
      await senalar(p, 'text=Tú frente al promedio', { clic: true });
      await decir(p, 'Al tocar una tarjeta se abre la lista de productos de ese indicador.', 4200);
      await p.keyboard.press('Escape'); await sinMarco(p);
      await senalar(p, 'text=¿Dónde está tu precio?');
      await decir(p, '¿Dónde está tu precio? Azul: más barato que el mercado. Gris: parejo. Rojo: más caro.', 4500);
      await senalar(p, 'text=¿En qué cadena está más barato tu producto?');
      await decir(p, 'Y en qué cadena está más barato tu producto. Toca una barra para ver la lista.', 4200);
      await senalar(p, 'text=Precios por cadena');
      await decir(p, 'Abajo, la tabla: tu precio y el más bajo de cada cadena. Toca un producto para ver su ficha.', 4500);
      await p.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' })); await pausa(600);
      await senalar(p, 'button:has-text("Excel")');
      await decir(p, 'Descárgalo en Excel con los mismos colores, listo para compartir.', 4000);
    },
  },
  {
    id: 'rango', pantalla: 'rango', titulo: 'Rango de precios',
    pasos: async (p) => {
      await decir(p, 'Rango de precios: para cada producto, del más barato al más caro del mercado.');
      await senalar(p, '.m3-espectro-fila >> nth=0');
      await decir(p, 'La barra es el rango del mercado y el punto de color es tu precio.', 4500);
      await senalar(p, '[role=radio]:has-text("Bs")', { clic: true });
      await decir(p, 'Puedes verlo en dólares o en bolívares a la tasa del día.', 4000);
      await senalar(p, '[role=radio]:has-text("Unidad")', { clic: true });
      await decir(p, 'Y comparar por caja o por unidad, si las cajas son de distinto tamaño.', 4200);
    },
  },
  {
    id: 'mapa', pantalla: 'mapa', titulo: 'Mapa de calor',
    pasos: async (p) => {
      await decir(p, 'Mapa de calor: tu precio de cada producto en cada cadena.');
      await senalar(p, 'table tbody tr >> nth=0');
      await decir(p, 'Se lee por fila: azul es la cadena donde ese producto está más barato; rojo, donde está más caro.', 5000);
      await senalar(p, '[role=radio]:has-text("Competencia")', { clic: true });
      await decir(p, 'Con «Competencia», cada celda se compara con el competidor más barato de esa cadena.', 4800);
      await senalar(p, 'text=Donde más caro te venden');
      await decir(p, 'Arriba ves qué cadena te vende más barato y cuál te encarece.', 4200);
    },
  },
  {
    id: 'margen', pantalla: 'margen', titulo: 'Margen por cadena',
    pasos: async (p) => {
      await decir(p, 'Margen por cadena: tu PSL, el precio que debería tener la cadena y el real.');
      await senalar(p, 'th:has-text("Teórico")');
      await decir(p, 'Teórico = PSL × factor. Con 1,5, la cadena le suma 50 %.', 4200);
      await senalar(p, '[aria-label="Factor general"]', { clic: true });
      await p.keyboard.press('Control+A'); await p.keyboard.type('1,6'); await p.keyboard.press('Enter');
      await decir(p, 'Cambias el factor y todo se recalcula. Con el lápiz, solo el de un producto.', 4200);
      await senalar(p, '[aria-label="Cadena que analizas"]');
      await decir(p, 'Eliges la cadena y de 1 a 9 laboratorios para comparar.', 3800);
      await senalar(p, 'thead th >> nth=4');
      await decir(p, 'GAP: rojo es un competidor más barato que tú en esa cadena; azul, más caro.', 4500);
      await senalar(p, '[role=radio]:has-text("Cadenas")', { clic: true });
      await decir(p, 'En «Cadenas» comparas tu margen en todas las cadenas a la vez.', 4200);
      await senalar(p, 'button:has-text("Exportar a Excel")');
      await decir(p, 'Y lo exportas a Excel con el mismo formato de la pantalla.', 4000);
    },
  },
];

async function grabar(guion, navegador) {
  const tmp = path.join(SALIDA, `.tmp-${guion.id}`);
  const ctx = await navegador.newContext({ viewport: TAM, recordVideo: { dir: tmp, size: TAM }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto(`${BASE}?p=${guion.pantalla}`);
  await page.waitForTimeout(2500);
  await prepararCapas(page);
  await guion.pasos(page);
  await decir(page, '', 600);
  const video = page.video();
  await ctx.close();
  const archivo = await video.path();
  await rename(archivo, path.join(SALIDA, `${guion.id}.webm`));
  await rm(tmp, { recursive: true, force: true });
  console.log(`Listo: ${guion.titulo} -> public/videos/${guion.id}.webm`);
}

await mkdir(SALIDA, { recursive: true });
const navegador = await playwright.chromium.launch();
const solo = process.argv.slice(2);
for (const g of GUIONES.filter(x => !solo.length || solo.includes(x.id))) await grabar(g, navegador);
await navegador.close();
