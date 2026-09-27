"""
Robot buscador de enlaces (beta).

Toma los productos que ya estan en Competencia (v_buscar_enlaces, fase 36) y
busca ese mismo producto en las cadenas donde todavia no tiene enlace. Lo que
encuentra se guarda como SUGERENCIA (sugerencias_enlaces): el enlace solo se
crea cuando alguien la acepta en el panel (Experimental > Sugerencias de
enlaces).

No abre navegador: usa el buscador publico de cada tienda.
  - VTEX (Locatel, SAAS...):  /api/catalog_system/pub/products/search?ft=
  - WooCommerce:              /wp-json/wc/store/v1/products?search=
  - Shopify:                  /search/suggest.json?q=
  - Magento 2:                /graphql  (products(search: ...))
  - Cualquier otra:          un navegador (Playwright) que usa la direccion
                              de busqueda de la tienda o escribe en su campo
                              "Buscar" (plataforma 'navegador').
La plataforma de cada cadena se detecta sola y se guarda en
dim_cadenas.plataforma. Si ni el navegador logra buscar, queda como
'sin_buscador' con lo que se vio en su pagina.

Puntaje de cada candidato (0 a 100), como el script de Hernando:
  laboratorio 40 (20 si no se puede saber), dosis 30, tamano 30
  (10 si falta el dato en algun lado). Dosis o tamano DISTINTOS descartan el
  candidato. Se sugiere desde 70.

Variables de entorno (ademas de las de Supabase):
  SOLO_PRODUCTOS  ids de dim_productos separados por coma
  SOLO_CADENAS    ids de dim_cadenas separados por coma
  FORZAR          '1' = buscar aunque se haya buscado hace poco y volver a
                  detectar la plataforma
  MAX_PRODUCTOS   tope de productos por corrida (0 = todos)
  DIAGNOSTICO     '1' = imprime los candidatos de cada busqueda
"""

import html
import json
import os
import re
import signal
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
PAUSA = 0.8                 # segundos entre consultas a la misma tienda
MIN_PUNTAJE = 70            # desde aqui se guarda como sugerencia
BUENO = 90                  # con esto no hace falta probar otra consulta
DIAS_SIN_REPETIR = 7        # no repetir la busqueda de un par antes de esto
DIAS_PLATAFORMA = 30        # volver a detectar la plataforma cada tanto
MAX_SUGERENCIAS = 3         # por producto y cadena

DIAGNOSTICO = os.environ.get("DIAGNOSTICO") == "1"


# ---------------------------------------------------------------------------
# Texto
# ---------------------------------------------------------------------------
def normalizar(texto) -> str:
    s = unicodedata.normalize("NFD", html.unescape(str(texto or "")).lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9.,%/ ]", " ", s)).strip()


def _num(txt: str) -> float:
    return float(txt.replace(",", "."))


def leer_presentacion(texto):
    """Dosis en mg y tamano (unidades, ml o g) de un nombre.
    Misma regla que fn_leer_presentacion (fase 35/36)."""
    s = re.sub(r"(\d),(\d)", r"\1.\2", normalizar(texto))
    m = re.search(r"(\d+(?:\.\d+)?)\s*(mg|mcg|g)(?![a-wyz])", s)
    xv = re.search(r"(?:^|[^a-z]|mg|mcg)x\s*(\d+(?:\.\d+)?)\s*(ml|g)\b", s)
    xn = re.search(r"(?:^|[^a-z]|mg|mcg)x\s*(\d+)(?![\d.]*\s*(?:mg|mcg))", s)
    fn = re.search(r"(\d+)\s*(tabletas|tableta|tabs|tab|comprimidos|comprimido|capsulas|capsula|caps|"
                   r"grageas|sobres|ampollas|ampolla|ovulos|parches|unidades|und)\b", s)
    dosis = None
    if m:
        valor = _num(m.group(1))
        es_tamano = m.group(2) == "g" and re.search(r"x\s*" + re.escape(m.group(1)) + r"\s*g\b", s)
        if not es_tamano:
            dosis = valor / 1000 if m.group(2) == "mcg" else valor * 1000 if m.group(2) == "g" else valor
    if xv:
        return dosis, _num(xv.group(1)), xv.group(2)
    # "180mg/5ml 120ml": el volumen sin "x" (no el "/5ml" de la concentracion)
    ml = re.findall(r"(?<![/\d.])(\d+(?:\.\d+)?)\s*ml\b", s)
    if ml and _num(ml[-1]) > 5:
        return dosis, _num(ml[-1]), "ml"
    if xn:
        return dosis, _num(xn.group(1)), "unidad"
    if fn:
        return dosis, _num(fn.group(1)), "unidad"
    return dosis, None, None


RUIDO = {
    "caja", "tabletas", "tableta", "tabs", "tab", "comprimidos", "comprimido", "capsulas", "capsula",
    "caps", "recubiertas", "recubierta", "blister", "und", "unidades", "de", "con", "x", "mg", "ml",
    "mcg", "g", "por", "el", "la", "los", "las", "y", "en", "para",
}


def nombre_base(nombre: str) -> str:
    """El nombre sin dosis, tamano ni palabras de empaque: 'Losartan Genven'."""
    s = normalizar(nombre)
    s = re.sub(r"\d+(?:[.,]\d+)?\s*(mg|mcg|g|ml|%|ui)\b(\s*/\s*\d*(?:[.,]\d+)?\s*(ml|g))?", " ", s)
    s = re.sub(r"\bx\s*\d+(?:[.,]\d+)?\s*(ml|g)?\b", " ", s)
    s = re.sub(r"\b\d+\b", " ", s)
    palabras = [p for p in re.split(r"[\s/,.]+", s) if p and p not in RUIDO]
    return " ".join(palabras[:5])


def fmt_dosis(dosis) -> str:
    if dosis is None:
        return ""
    d = float(dosis)
    return f"{int(d) if d.is_integer() else d} mg"


def construir_consultas(prod: dict) -> list:
    base = nombre_base(prod.get("nombre") or "") or normalizar(prod.get("principio") or "")
    dosis = fmt_dosis(prod.get("dosis_mg"))
    lab = normalizar(prod.get("laboratorio") or "")
    lab = "" if lab in ("", "otro", "otros", "sin laboratorio") or lab in base else " ".join(lab.split(" ")[:2])
    principio = normalizar(prod.get("principio") or "")
    consultas = [
        " ".join(x for x in (base, dosis, lab) if x),
        " ".join(x for x in (base, dosis) if x),
    ]
    if principio and principio not in base:
        consultas.append(" ".join(x for x in (principio, dosis, lab) if x))
    vistas = []
    for q in consultas:
        q = re.sub(r"\s+", " ", q).strip()
        if q and q not in vistas:
            vistas.append(q)
    return vistas[:3]


def nombres_laboratorio(prod: dict) -> list:
    nombres = [prod.get("laboratorio"), prod.get("marca")] + list(prod.get("laboratorio_sinonimos") or [])
    salida = []
    for n in nombres:
        n = normalizar(n)
        if len(n) >= 3 and n not in ("otro", "otros") and n not in salida:
            salida.append(n)
    return salida


def puntuar(prod: dict, cand: dict):
    """(puntaje, detalle) o None si el candidato es otro producto."""
    texto = normalizar(f"{cand.get('nombre', '')} {cand.get('marca') or ''}")
    # Tiene que ser el mismo producto: alguna palabra del nombre o del principio.
    claves = {p for p in (nombre_base(prod.get("nombre") or "") + " " + normalizar(prod.get("principio") or "")).split()
              if len(p) >= 4}
    if claves and not any(re.search(r"\b" + re.escape(k), texto) for k in claves):
        return None

    detalle = {}
    puntaje = 0

    labs = nombres_laboratorio(prod)
    marca_tienda = normalizar(cand.get("marca") or "")
    if not labs:
        detalle["laboratorio"] = "?"
        puntaje += 20
    elif any(re.search(r"\b" + re.escape(l) + r"\b", texto) for l in labs):
        detalle["laboratorio"] = "si"
        puntaje += 40
    elif marca_tienda:
        detalle["laboratorio"] = "no"      # la tienda dice otra marca
    else:
        detalle["laboratorio"] = "?"
        puntaje += 20

    ld, lt, lu = leer_presentacion(cand.get("nombre", ""))
    rd = prod.get("dosis_mg")
    rt = prod.get("tamano")
    ru = prod.get("unidad") or "unidad"
    if ld is not None and rd is not None:
        if abs(float(ld) - float(rd)) > 0.001:
            return None
        detalle["dosis"] = "si"
        puntaje += 30
    else:
        detalle["dosis"] = "?"
        puntaje += 10
    if lt is not None and rt is not None and (lu or "unidad") == ru:
        if abs(float(lt) - float(rt)) > 0.001:
            return None
        detalle["tamano"] = "si"
        puntaje += 30
    else:
        detalle["tamano"] = "?"
        puntaje += 10
    return puntaje, detalle


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
def pedir(url: str, json_esperado: bool = True, timeout: int = 20):
    """(status, datos) con datos = JSON (o None) o texto si json_esperado=False."""
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json, text/plain, */*" if json_esperado else "text/html,*/*",
        "Accept-Language": "es-VE,es;q=0.9",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            cuerpo = r.read().decode("utf-8", errors="ignore")
            status = r.status
    except urllib.error.HTTPError as e:
        return e.code, None
    except Exception as e:  # red, timeout, SSL
        return 0, str(e)
    if not json_esperado:
        return status, cuerpo
    try:
        return status, json.loads(cuerpo)
    except ValueError:
        return status, None


def base_de(website: str) -> str:
    w = (website or "").strip().rstrip("/")
    if w and not w.startswith("http"):
        w = "https://" + w
    return w


# ---------------------------------------------------------------------------
# Plataformas: cada una sabe si la tienda la usa y como buscar en ella
# ---------------------------------------------------------------------------
def vtex_url(base, q, hasta=19):
    return f"{base}/api/catalog_system/pub/products/search?ft={urllib.parse.quote(q)}&_from=0&_to={hasta}"


def buscar_vtex(base, q, ctx):
    status, datos = pedir(vtex_url(base, q))
    if not isinstance(datos, list):
        raise RuntimeError(f"VTEX respondio {status}")
    if datos and not ctx.get("moneda"):
        ctx["moneda"] = moneda_vtex(base, datos)   # una vez por cadena
    salida = []
    for p in datos:
        try:
            oferta = p["items"][0]["sellers"][0]["commertialOffer"]
        except (KeyError, IndexError, TypeError):
            oferta = {}
        link = p.get("link") or f"{base}/{p.get('linkText', '')}/p"
        salida.append({
            "nombre": p.get("productName") or "",
            "marca": p.get("brand") or "",
            "url": link if link.startswith("http") else base + link,
            "precio": oferta.get("Price"),
            "moneda": ctx.get("moneda"),
            "disponible": oferta.get("IsAvailable"),
        })
    return salida


def buscar_woo(base, q, ctx):
    status, datos = pedir(f"{base}/wp-json/wc/store/v1/products?search={urllib.parse.quote(q)}&per_page=20")
    if not isinstance(datos, list):
        raise RuntimeError(f"WooCommerce respondio {status}")
    salida = []
    for p in datos:
        precios = p.get("prices") or {}
        precio = None
        try:
            precio = int(precios.get("price")) / (10 ** int(precios.get("currency_minor_unit") or 0))
        except (TypeError, ValueError):
            pass
        marcas = " ".join(b.get("name", "") for b in (p.get("brands") or []) if isinstance(b, dict))
        salida.append({
            "nombre": html.unescape(re.sub(r"<[^>]+>", "", p.get("name") or "")),
            "marca": marcas,
            "url": p.get("permalink") or "",
            "precio": precio,
            "moneda": precios.get("currency_code"),
            "disponible": p.get("is_in_stock"),
        })
    return salida


def buscar_shopify(base, q, ctx):
    status, datos = pedir(f"{base}/search/suggest.json?q={urllib.parse.quote(q)}"
                          f"&resources[type]=product&resources[limit]=10")
    productos = (((datos or {}).get("resources") or {}).get("results") or {}).get("products") if isinstance(datos, dict) else None
    if productos is None:
        raise RuntimeError(f"Shopify respondio {status}")
    salida = []
    for p in productos:
        url = p.get("url") or ""
        try:
            precio = float(p.get("price")) if p.get("price") is not None else None
        except (TypeError, ValueError):
            precio = None
        salida.append({
            "nombre": p.get("title") or "",
            "marca": p.get("vendor") or "",
            "url": (base + url.split("?")[0]) if url.startswith("/") else url,
            "precio": precio,
            "moneda": ctx.get("moneda"),
            "disponible": p.get("available"),
        })
    return salida


MAGENTO_Q = ('{products(search:%s,pageSize:20){items{name url_key url_suffix '
             'price_range{minimum_price{final_price{value currency}}}}}}')


def buscar_magento(base, q, ctx):
    consulta = MAGENTO_Q % json.dumps(q)
    status, datos = pedir(f"{base}/graphql?query={urllib.parse.quote(consulta)}")
    items = (((datos or {}).get("data") or {}).get("products") or {}).get("items") if isinstance(datos, dict) else None
    if items is None:
        raise RuntimeError(f"Magento respondio {status}")
    salida = []
    for p in items:
        final = (((p.get("price_range") or {}).get("minimum_price") or {}).get("final_price") or {})
        salida.append({
            "nombre": p.get("name") or "",
            "marca": "",
            "url": f"{base}/{p.get('url_key', '')}{p.get('url_suffix') or '.html'}",
            "precio": final.get("value"),
            "moneda": final.get("currency"),
            "disponible": None,
        })
    return salida



# ---------------------------------------------------------------------------
# Tiendas sin buscador publico conocido (Farmatodo, Farmabien...): se usa un
# navegador (Playwright), como haria una persona. La primera vez el robot
# aprende COMO busca la tienda: una direccion de busqueda (?s=, /search?q=...)
# o, si no, escribir en su campo "Buscar". Lo aprendido se guarda en
# dim_cadenas.plataforma_detalle y las siguientes corridas lo reutilizan.
# ---------------------------------------------------------------------------
PAUSA_NAVEGADOR = 1.5
PLANTILLAS = [
    "/?s={q}&post_type=product",        # WooCommerce / WordPress
    "/search?q={q}",                     # Shopify y muchas otras
    "/buscar?q={q}",
    "/busqueda?q={q}",
    "/catalogsearch/result/?q={q}",      # Magento
    "/search?text={q}",
    "/productos?search={q}",
    "/{q}?_q={q}&map=ft",                # VTEX sin API publica
    "/shop?search={q}",                  # Odoo
    "/tienda?s={q}",
    "/productos?q={q}",
    "/products?search={q}",
    "/catalogo?q={q}",
    "/search/{q}",
    "/buscar/{q}",
    "/busqueda/{q}",
    "/?q={q}",
]
CAMPOS_BUSQUEDA = [
    "input[type=search]", "input[name=q]", "input[name=s]", "input[name=search]", "input[name=text]",
    "input[placeholder*='usca' i]", "input[placeholder*='roducto' i]", "input[aria-label*='usca' i]",
]
BOTONES_BUSQUEDA = ["[aria-label*='usca' i]", "button[class*='search' i]", "[class*='search-icon' i]", "[class*='buscador' i]"]

# Productos de una pagina de resultados: enlaces de la misma tienda con un
# nombre legible (fuera del menu y el pie) y el precio que se vea en su tarjeta.
EXTRAER_JS = r"""(incluirCabecera) => {
  const origen = location.origin.replace('://www.', '://');
  const esPrecio = (t) => /^(bs\.?\s?s?\.?|\$|usd|ref\.?)?\s*[\d.,]+\s*(bs\.?\s?s?\.?|usd|ref\.?)?$/i.test(t.trim());
  const numero = (txt) => {
    let c = String(txt).replace(/[^\d.,]/g, '');
    if (c.includes(',')) c = c.replace(/\./g, '').replace(',', '.');
    else if ((c.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(c)) c = c.replace(/\./g, '');
    const v = parseFloat(c);
    return isNaN(v) ? null : v;
  };
  // Precios de un texto: con la moneda pegada ANTES o DESPUES del numero y
  // en la misma linea ("X 20" + salto + "Bs.S 8.737" no es un precio de 20).
  const precios = (texto) => {
    const out = [];
    const t = String(texto || '');
    for (const m of t.matchAll(/(bs\.?\s?s?\.?|\$|usd|ref\.?)[ \t]*(\d[\d.,]*)/gi)) out.push({ i: m.index, valor: numero(m[2]), moneda: /bs/i.test(m[1]) ? 'VES' : 'USD' });
    for (const m of t.matchAll(/(\d[\d.,]*)[ \t]*(bs\.?\s?s?\.?|usd|ref\.?)(?![a-z])/gi)) out.push({ i: m.index, valor: numero(m[1]), moneda: /bs/i.test(m[2]) ? 'VES' : 'USD' });
    return out.filter(p => p.valor && p.valor > 0).sort((x, y) => x.i - y.i);
  };
  const mapa = new Map();
  for (const a of document.querySelectorAll('a[href]')) {
    if (!incluirCabecera && a.closest('header, nav, footer, [role="navigation"]')) continue;
    let href;
    try { href = new URL(a.getAttribute('href'), location.href).href.split('#')[0]; } catch (e) { continue; }
    if (!href.replace('://www.', '://').startsWith(origen) || href.replace(/\/$/, '') === location.origin) continue;
    const textos = [a.getAttribute('title'), a.getAttribute('aria-label'), a.querySelector('img') && a.querySelector('img').getAttribute('alt'),
                    ...(a.innerText || '').split('\n')]
      .map(t => (t || '').replace(/\s+/g, ' ').trim())
      .filter(t => t.length >= 6 && t.length <= 220 && /[a-z]{3}/i.test(t) && !esPrecio(t));
    if (!textos.length) continue;
    const nombre = textos.sort((x, y) => y.length - x.length)[0];
    // La tarjeta: se sube desde el enlace hasta el primer contenedor con un
    // precio, sin llegar a la grilla (mas de 4 productos distintos).
    let precio = null;
    let nodo = a;
    for (let i = 0; i < 7 && nodo && nodo !== document.body; i++) {
      const lista = precios(nodo.innerText);
      if (lista.length) {
        const bs = lista.find(p => p.moneda === 'VES');
        precio = bs || lista[0];
        break;
      }
      nodo = nodo.parentElement;
      if (nodo && new Set([...nodo.querySelectorAll('a[href]')].map(x => x.href.split('#')[0])).size > 4) break;
    }
    const antes = mapa.get(href);
    if (!antes || nombre.length > antes.nombre.length) mapa.set(href, { nombre, url: href, precio: precio || (antes ? antes.precio : null) });
  }
  return [...mapa.values()].slice(0, 80);
}"""


# Lo que se ve en la pagina cuando no se encuentran productos: para ajustar
# la tienda sin tener que abrirla.
DIAG_JS = r"""() => ({
  url: location.href,
  titulo: (document.title || '').slice(0, 100),
  enlaces: document.querySelectorAll('a[href]').length,
  campos: [...document.querySelectorAll('input')].filter(i => i.offsetWidth > 0).map(i => i.name || i.placeholder || i.type).slice(0, 6),
  muestras: [...document.querySelectorAll('a[href]')].map(a => (a.innerText || '').replace(/\s+/g, ' ').trim())
    .filter(t => t.length > 8).slice(0, 8),
})"""


class Navegador:
    """Un navegador por hebra (Playwright sync no se comparte entre hebras)."""

    def __init__(self):
        from playwright.sync_api import sync_playwright
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=True, args=["--disable-blink-features=AutomationControlled"])
        self._ctx = self._browser.new_context(user_agent=UA, locale="es-VE", viewport={"width": 1366, "height": 900})
        self._ctx.route("**/*", lambda r: r.abort() if r.request.resource_type in ("image", "media", "font") else r.continue_())
        self.page = self._ctx.new_page()
        self.page.set_default_timeout(30000)

    def cerrar(self):
        for x in (self._ctx, self._browser):
            try:
                x.close()
            except Exception:
                pass
        try:
            self._pw.stop()
        except Exception:
            pass

    def _esperar(self):
        try:
            self.page.wait_for_load_state("networkidle", timeout=8000)
        except Exception:
            pass
        self.page.wait_for_timeout(1200)

    def resultados_url(self, url):
        self.page.goto(url, wait_until="domcontentloaded")
        self._esperar()
        return self.page.evaluate(EXTRAER_JS, False)

    def diagnostico(self):
        try:
            return self.page.evaluate(DIAG_JS)
        except Exception as e:
            return {"error": str(e)[:200]}

    def resultados_campo(self, base, q, selector=None):
        """Escribe en el campo de busqueda de la tienda. (candidatos, url final, selector)."""
        self.page.goto(base, wait_until="domcontentloaded")
        self._esperar()
        campo = self._campo(selector)
        if campo is None:
            for boton in BOTONES_BUSQUEDA:
                try:
                    b = self.page.locator(boton).first
                    if b.is_visible(timeout=800):
                        b.click()
                        self.page.wait_for_timeout(600)
                        campo = self._campo(selector)
                        if campo is not None:
                            break
                except Exception:
                    continue
        if campo is None:
            return [], self.page.url, None
        loc, sel = campo
        loc.click()
        loc.fill(q)
        # Muchas tiendas muestran productos mientras se escribe (desplegable).
        self.page.wait_for_timeout(2000)
        al_escribir = self.page.evaluate(EXTRAER_JS, True)
        loc.press("Enter")
        self._esperar()
        resultados = self.page.evaluate(EXTRAER_JS, False)
        vistos = {c["url"] for c in resultados}
        return resultados + [c for c in al_escribir if c["url"] not in vistos], self.page.url, sel

    def _campo(self, preferido=None):
        for sel in ([preferido] if preferido else []) + CAMPOS_BUSQUEDA:
            try:
                loc = self.page.locator(sel).first
                if loc.is_visible(timeout=800):
                    return loc, sel
            except Exception:
                continue
        return None


_hebra = threading.local()


def navegador() -> Navegador:
    if getattr(_hebra, "nav", None) is None:
        _hebra.nav = Navegador()
    return _hebra.nav


def cerrar_navegador():
    nav = getattr(_hebra, "nav", None)
    if nav is not None:
        nav.cerrar()
        _hebra.nav = None


def hay_playwright() -> bool:
    try:
        import playwright.sync_api  # noqa: F401
        return True
    except ImportError:
        return False


def _relevantes(cands, palabra):
    return [c for c in cands if palabra in normalizar(c.get("nombre"))]


def detectar_navegador(base: str) -> tuple:
    """Aprende como buscar en la tienda con el navegador. (plataforma, detalle)."""
    nav = navegador()
    for plantilla in PLANTILLAS:
        try:
            a = nav.resultados_url(base + plantilla.replace("{q}", "acetaminofen"))
            if len(_relevantes(a, "acetaminofen")) < 2:
                continue
            # La pagina tiene que cambiar con lo buscado (no ser la portada).
            b = nav.resultados_url(base + plantilla.replace("{q}", "ibuprofeno"))
            if _relevantes(b, "ibuprofeno"):
                return "navegador", {"modo": "url", "busqueda_url": base + plantilla}
        except Exception:
            continue
    try:
        cands, url_final, sel = nav.resultados_campo(base, "acetaminofen")
        if len(_relevantes(cands, "acetaminofen")) >= 1:
            if "acetaminofen" in url_final.lower():
                return "navegador", {"modo": "url", "busqueda_url": url_final.replace("acetaminofen", "{q}")}
            return "navegador", {"modo": "campo", "selector": sel}
        return None, {"nota": "El navegador no encontró productos al buscar en la tienda.", "selector": sel,
                      "diagnostico": nav.diagnostico()}
    except Exception as e:
        return None, {"nota": f"El navegador falló: {str(e)[:200]}"}


def buscar_navegador(base, q, ctx):
    nav = navegador()
    time.sleep(PAUSA_NAVEGADOR - PAUSA if PAUSA_NAVEGADOR > PAUSA else 0)
    if ctx.get("modo") == "url" and ctx.get("busqueda_url"):
        cands = nav.resultados_url(ctx["busqueda_url"].replace("{q}", urllib.parse.quote_plus(q)))
    else:
        cands = nav.resultados_campo(base, q, ctx.get("selector"))[0]
    salida = []
    for c in cands:
        p = c.get("precio") or {}
        precio, moneda = p.get("valor"), p.get("moneda")
        salida.append({"nombre": c["nombre"], "marca": "", "url": c["url"], "precio": precio,
                       "moneda": moneda, "disponible": None})
    return salida

BUSCADORES = {"vtex": buscar_vtex, "woocommerce": buscar_woo, "shopify": buscar_shopify, "magento": buscar_magento}
BUSCADORES["navegador"] = buscar_navegador
HUELLAS = ["vtex", "shopify", "woocommerce", "wp-content", "magento", "prestashop", "algolia",
           "__next_data__", "nuxt", "ng-version", "wix", "odoo", "jumpseller", "tiendanube"]


def detectar_plataforma(base: str) -> tuple:
    """(plataforma, detalle)."""
    prueba = "acetaminofen"
    status, datos = pedir(vtex_url(base, prueba, 0))
    if isinstance(datos, list):
        return "vtex", {"moneda": moneda_vtex(base, datos)}
    status, datos = pedir(f"{base}/wp-json/wc/store/v1/products?search={prueba}&per_page=1")
    if isinstance(datos, list):
        moneda = (datos[0].get("prices") or {}).get("currency_code") if datos else None
        return "woocommerce", {"moneda": moneda}
    status, datos = pedir(f"{base}/search/suggest.json?q={prueba}&resources[type]=product")
    if isinstance(datos, dict) and "resources" in datos:
        return "shopify", {}
    status, datos = pedir(f"{base}/graphql?query={urllib.parse.quote(MAGENTO_Q % json.dumps(prueba))}")
    if isinstance(datos, dict) and isinstance((datos.get("data") or {}).get("products"), dict):
        return "magento", {}
    status, pagina = pedir(base, json_esperado=False)
    texto = (pagina or "").lower() if isinstance(pagina, str) else ""
    huellas = [h for h in HUELLAS if h in texto]
    detalle = {"estado_web": status, "huellas": huellas, "nota": "Ningún buscador público conocido respondió."}
    if hay_playwright():
        plataforma, extra = detectar_navegador(base)
        if plataforma:
            return plataforma, {**extra, "huellas": huellas}
        detalle.update(extra)
    return "sin_buscador", detalle


def moneda_vtex(base, datos) -> str | None:
    """Moneda de la tienda VTEX: la de la pagina de un producto (VES o USD)."""
    if not datos:
        return None
    link = datos[0].get("link") or f"{base}/{datos[0].get('linkText', '')}/p"
    status, pagina = pedir(link if link.startswith("http") else base + link, json_esperado=False)
    if not isinstance(pagina, str):
        return None
    m = (re.search(r'product:price:currency"\s+content="([A-Za-z]{3})"', pagina)
         or re.search(r'content="([A-Za-z]{3})"\s+property="product:price:currency"', pagina)
         or re.search(r'"priceCurrency"\s*:\s*"([A-Za-z]{3})"', pagina)
         or re.search(r'"currencyCode"\s*:\s*"([A-Za-z]{3})"', pagina))
    return m.group(1).upper() if m else None


# ---------------------------------------------------------------------------
# Busqueda de un producto en una cadena
# ---------------------------------------------------------------------------
def buscar_producto(prod: dict, cadena: dict) -> dict:
    buscar = BUSCADORES[cadena["plataforma"]]
    base = base_de(cadena["website"])
    ctx = cadena.get("plataforma_detalle") or {}
    consultas = construir_consultas(prod)
    if cadena["plataforma"] == "navegador":
        consultas = consultas[:2]       # cada consulta abre una pagina: mas lento
    vistos = {}
    candidatos = 0
    for q in consultas:
        time.sleep(PAUSA)
        for cand in buscar(base, q, ctx):
            if not cand.get("url") or cand["url"] in vistos:
                continue
            candidatos += 1
            res = puntuar(prod, cand)
            if DIAGNOSTICO:
                print(f"    [{cadena['id']}] '{q}' -> {cand['nombre']} | {cand.get('marca')} | {res}")
            if res:
                cand["puntaje"], cand["detalle"] = res
                cand["detalle"]["consulta"] = q
                vistos[cand["url"]] = cand
        if any(c["puntaje"] >= BUENO for c in vistos.values()):
            break
    mejores = sorted(vistos.values(), key=lambda c: (-c["puntaje"], c.get("disponible") is False, len(c["nombre"])))
    return {
        "consultas": consultas,
        "candidatos": candidatos,
        "sugerencias": [c for c in mejores if c["puntaje"] >= MIN_PUNTAJE][:MAX_SUGERENCIAS],
        "mejor": mejores[0]["puntaje"] if mejores else None,
    }


# ---------------------------------------------------------------------------
# Corrida
# ---------------------------------------------------------------------------
TASA_BCV = {"valor": None}


def en_bolivares(precio, moneda):
    """Precio en Bs: si la tienda lo da en dolares se pasa con la tasa BCV."""
    if precio is None:
        return None, moneda
    if (moneda or "").upper() in ("USD", "US$") and TASA_BCV["valor"]:
        return round(float(precio) * TASA_BCV["valor"], 2), "VES"
    return round(float(precio), 2), moneda


def ahora_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def lista_env(nombre: str) -> set:
    return {x.strip() for x in (os.environ.get(nombre) or "").split(",") if x.strip()}


def main():
    import supabase_client as db

    if not db.is_supabase_configured():
        print("Falta SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.")
        sys.exit(1)

    forzar = os.environ.get("FORZAR") == "1"
    solo_productos = lista_env("SOLO_PRODUCTOS")
    solo_cadenas = lista_env("SOLO_CADENAS")
    max_productos = int(os.environ.get("MAX_PRODUCTOS") or 0)
    url_github = None
    if os.environ.get("GITHUB_RUN_ID"):
        url_github = f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/{os.environ.get('GITHUB_REPOSITORY')}/actions/runs/{os.environ['GITHUB_RUN_ID']}"

    try:
        t = db.select("dim_tasa_bcv", "select=tasa&order=fecha.desc&limit=1")
        TASA_BCV["valor"] = float(t[0]["tasa"]) if t else None
    except Exception as e:
        print(f"Aviso: sin tasa BCV ({e}); los precios en dolares quedan en dolares.")

    corrida = db.insert("corridas_buscador", [{"estado": "corriendo", "url_github": url_github}], return_representation=True)
    corrida_id = corrida[0]["id"]
    print(f"Corrida {corrida_id}")

    # Corridas anteriores que quedaron "corriendo" (cortadas sin avisar).
    try:
        db._request(f"corridas_buscador?estado=eq.corriendo&id=lt.{corrida_id}", method="PATCH",
                    data={"estado": "interrumpida", "fin": ahora_iso()})
    except Exception as e:
        print(f"Aviso: no se cerraron corridas viejas ({e})")

    # Cancelar en GitHub manda una senal: se marca la corrida y se sale ya
    # (las hebras no se esperan), para que el panel no se quede "Buscando".
    def al_cancelar(signum, _frame):
        print(f"Corrida cancelada (senal {signum}).", flush=True)
        try:
            db.update("corridas_buscador", "id", corrida_id, {"estado": "cancelada", "fin": ahora_iso()})
        finally:
            os._exit(1)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, al_cancelar)

    # Senal de vida cada 30 s (fase 39). Si el panel marco la corrida como
    # cancelada ("Detener"), el robot se detiene aqui mismo.
    def latir():
        while True:
            try:
                db.update("corridas_buscador", "id", corrida_id, {"latido": ahora_iso()})
                fila = db.select("corridas_buscador", f"select=estado&id=eq.{corrida_id}&limit=1")
                if fila and fila[0].get("estado") == "cancelada":
                    print("Detenida desde el panel.", flush=True)
                    os._exit(0)
            except Exception as e:
                print(f"Aviso latido: {e}", flush=True)
            time.sleep(30)
    threading.Thread(target=latir, daemon=True).start()

    try:
        # 1. Cadenas y su plataforma
        cadenas = [c for c in db.select("dim_cadenas", "select=id,nombre,website,activo,plataforma,plataforma_detalle,plataforma_revisada")
                   if c.get("activo") is not False and c.get("website")]
        if solo_cadenas:
            cadenas = [c for c in cadenas if c["id"] in solo_cadenas]
        limite_plat = datetime.now(timezone.utc) - timedelta(days=DIAS_PLATAFORMA)

        def revisar(c):
            revisada = c.get("plataforma_revisada")
            vieja = not revisada or datetime.fromisoformat(revisada.replace("Z", "+00:00")) < limite_plat
            # Las que no tenian buscador se vuelven a probar (quizas ahora con navegador).
            manual = (c.get("plataforma_detalle") or {}).get("manual")
            if not manual and (forzar or vieja or c.get("plataforma") not in BUSCADORES):
                try:
                    plataforma, detalle = detectar_plataforma(base_de(c["website"]))
                finally:
                    cerrar_navegador()
                c["plataforma"], c["plataforma_detalle"] = plataforma, detalle
                db.update("dim_cadenas", "id", c["id"], {"plataforma": plataforma, "plataforma_detalle": detalle,
                                                         "plataforma_revisada": ahora_iso()})
            print(f"  {c['nombre']}: {c['plataforma']} {json.dumps(c.get('plataforma_detalle') or {}, ensure_ascii=False)}")

        with ThreadPoolExecutor(max_workers=max(1, len(cadenas))) as ex:
            list(ex.map(revisar, cadenas))
        activas = [c for c in cadenas if c["plataforma"] in BUSCADORES]

        # 2. Que buscar
        productos = db.select("v_buscar_enlaces", "select=*")
        if solo_productos:
            productos = [p for p in productos if str(p["producto_id"]) in solo_productos]
        if max_productos:
            productos = productos[:max_productos]
        recientes = {}
        if not forzar and not solo_productos:
            limite = datetime.now(timezone.utc) - timedelta(days=DIAS_SIN_REPETIR)
            for b in db.select("busquedas_enlaces", "select=producto_id,cadena_id,fecha"):
                if datetime.fromisoformat(b["fecha"].replace("Z", "+00:00")) >= limite:
                    recientes[(b["producto_id"], b["cadena_id"])] = True
        # Sugerencias pendientes de cada par. Sin FORZAR, un par con sugerencia
        # pendiente no se busca. Con FORZAR se busca primero y su resultado
        # REEMPLAZA las pendientes: lo que ya no aparece se borra.
        pendientes = {}
        for sp in db.select("sugerencias_enlaces", "select=id,producto_id,cadena_id,url&estado=eq.pendiente"):
            pendientes.setdefault((sp["producto_id"], sp["cadena_id"]), {})[sp["url"]] = sp["id"]

        tareas = {c["id"]: [] for c in activas}
        for p in productos:
            ya = set(p.get("cadenas_con_enlace") or [])
            for c in activas:
                clave = (p["producto_id"], c["id"])
                if c["id"] in ya or clave in recientes or (clave in pendientes and not forzar):
                    continue
                tareas[c["id"]].append(p)
        for cid in tareas:
            tareas[cid].sort(key=lambda p, cid=cid: (p["producto_id"], cid) not in pendientes)
        total = sum(len(t) for t in tareas.values())
        db.update("corridas_buscador", "id", corrida_id, {"total": total})
        print(f"{len(productos)} productos, {total} busquedas en {len(activas)} cadenas")

        # 3. Buscar: una hebra por cadena (cada tienda de a una consulta)
        lock = threading.Lock()
        estado = {"procesados": 0}
        resumen = {c["id"]: {"nombre": c["nombre"], "plataforma": c["plataforma"], "buscados": 0,
                             "sugeridos": 0, "sin_resultado": 0, "errores": 0} for c in cadenas}

        def trabajar(cadena):
            try:
                buscar_en(cadena)
            finally:
                cerrar_navegador()

        def buscar_en(cadena):
            r = resumen[cadena["id"]]
            for p in tareas[cadena["id"]]:
                fila = {"producto_id": p["producto_id"], "cadena_id": cadena["id"], "fecha": ahora_iso()}
                try:
                    res = buscar_producto(p, cadena)
                    sug = [{
                        "producto_id": p["producto_id"], "cadena_id": cadena["id"], "url": s["url"],
                        "nombre_tienda": s["nombre"][:500], "marca_tienda": (s.get("marca") or "")[:200] or None,
                        "precio": en_bolivares(s.get("precio"), s.get("moneda"))[0],
                        "moneda": en_bolivares(s.get("precio"), s.get("moneda"))[1], "disponible": s.get("disponible"),
                        "puntaje": s["puntaje"], "detalle": s["detalle"], "actualizado": ahora_iso(),
                    } for s in res["sugerencias"]]
                    if sug:
                        db.upsert("sugerencias_enlaces", sug, on_conflict="producto_id,cadena_id,url")
                    viejas = pendientes.get((p["producto_id"], cadena["id"])) or {}
                    sobran = [str(i) for u, i in viejas.items() if u not in {x["url"] for x in sug}]
                    if sobran:
                        db._request(f"sugerencias_enlaces?estado=eq.pendiente&id=in.({','.join(sobran)})", method="DELETE")
                        r["reemplazadas"] = r.get("reemplazadas", 0) + len(sobran)
                    fila.update({"resultado": "sugerido" if sug else "sin_resultado", "consultas": res["consultas"],
                                 "candidatos": res["candidatos"], "mejor_puntaje": res["mejor"], "error": None})
                    r["sugeridos" if sug else "sin_resultado"] += 1
                except Exception as e:
                    fila.update({"resultado": "error", "error": str(e)[:500]})
                    r["errores"] += 1
                    print(f"  [{cadena['id']}] {p['nombre']}: {e}")
                r["buscados"] += 1
                try:
                    db.upsert("busquedas_enlaces", [fila], on_conflict="producto_id,cadena_id")
                except Exception as e:
                    print(f"  No se guardo la busqueda: {e}")
                with lock:
                    estado["procesados"] += 1
                    n = estado["procesados"]
                if n % 20 == 0:
                    db.update("corridas_buscador", "id", corrida_id, {"procesados": n})
                    print(f"  {n}/{total}")

        with ThreadPoolExecutor(max_workers=max(1, len(activas))) as ex:
            list(ex.map(trabajar, activas))

        nuevas = sum(r["sugeridos"] for r in resumen.values())
        db.update("corridas_buscador", "id", corrida_id, {
            "estado": "terminada", "fin": ahora_iso(), "procesados": estado["procesados"],
            "resumen": {"cadenas": resumen, "productos": len(productos), "con_sugerencia": nuevas},
        })
        print(f"Listo: {estado['procesados']} busquedas, {nuevas} con sugerencia.")
    except Exception as e:
        db.update("corridas_buscador", "id", corrida_id, {"estado": "fallida", "fin": ahora_iso(),
                                                         "resumen": {"error": str(e)[:1000]}})
        raise


if __name__ == "__main__":
    main()
