"""
TrackFlow Scraper - Motor de Monitoreo de Precios Farmacéuticos (Venezuela)
Soporta: Farmatodo, Locatel, FarmaDON, Grupo San Ignacio, Farmacias Xana y FarmaGo.
Ejecución: GitHub Actions & Local (Playwright Async + Python con Supabase).
"""

import asyncio
import time
import random
import json
import os
import sys
import csv
import io
import re
from pathlib import Path
from datetime import datetime, timezone
import urllib.parse
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

PROJECT_ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = PROJECT_ROOT / "productos_competencia.csv"
OUT_PATH = PROJECT_ROOT / "resultados.json"
DIAGNOSTICO = False  # se decide en main_async


def limpiar_nombre(nombre):
    """Normaliza el nombre capturado del sitio.

    El <h1> de Farmatodo arrastra un separador decorativo que se guardaba
    literal en la base de datos, produciendo nombres como
    "//Cefotas 250mg/5ml 100ml Suspension Oral".
    """
    if not nombre:
        return None
    limpio = re.sub(r"^[\s/|·•\-]+", "", str(nombre))
    limpio = re.sub(r"\s+", " ", limpio).strip()
    return limpio or None


def read_text_robust(path: Path) -> str:
    """Lee archivos de texto manejando codificaciones utf-8 y latin-1."""
    try:
        return path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        return path.read_text(encoding="latin-1")


def parse_price(text) -> float | None:
    """
    Convierte texto con formato de moneda venezolano (Bs.) a float.
    Maneja: 'Bs 18.655,00', 'Bs.18.655,00', '18.655,00', '18655.00'.
    """
    if not text:
        return None
    str_val = str(text).strip()
    if not str_val:
        return None

    cleaned = re.sub(r'(?i)\b(?:bs\.?s?|ves|bolivares?)\b', '', str_val)
    cleaned = cleaned.replace('\xa0', ' ').replace('\u202f', ' ').strip()

    if ',' in cleaned:
        cleaned = cleaned.replace('.', '').replace(',', '.')
    else:
        dots = cleaned.count('.')
        if dots == 1:
            parts = cleaned.split('.')
            if len(parts[1]) == 3:
                cleaned = cleaned.replace('.', '')
        elif dots > 1:
            cleaned = cleaned.replace('.', '')

    match = re.search(r'\d+(?:\.\d+)?', cleaned)
    if not match:
        return None
    try:
        val = float(match.group())
        return round(val, 2) if val > 0.01 else None
    except ValueError:
        return None


def extract_product_id_from_url(url: str) -> str | None:
    """Extrae el ID numérico del producto desde la URL (ej: /producto/111100011-trimebutina...)."""
    m = re.search(r'/producto/(\d+)', url) or re.search(r'[-_/](\d{5,12})(?:[-_.]|$)', url)
    return m.group(1) if m else None


def extract_unit_count(text: str) -> int | None:
    """Extrae la cantidad de unidades/tabletas/sobres del nombre o URL (ej: 'X 20', '10SOBRES', '20 TABLETAS')."""
    if not text:
        return None
    m = re.search(r'(?i)\bx\s*(\d{1,3})\b', text) or \
        re.search(r'(?i)\b(\d{1,3})\s*(?:tabletas?|capsulas?|sobres?|grageas?|comprimidos?|dosis|tabs?|caps?)\b', text) or \
        re.search(r'(?i)(\d{1,3})\s*(?:sobres|tabletas|capsulas)', text)
    if m:
        try:
            val = int(m.group(1))
            return val if 1 <= val <= 500 else None
        except ValueError:
            return None
    return None


async def get_bcv_rate() -> float:
    """Obtiene la tasa oficial BCV desde Supabase o API externa."""
    fallback = 775.34
    print("[BCV] Cargando tasa oficial...", flush=True)

    try:
        from supabase_client import is_supabase_configured, select
        if is_supabase_configured():
            rows = select("bcv_rates", "select=*&order=updated_at.desc&limit=1")
            if rows and len(rows) > 0:
                val = float(rows[0].get("value") or rows[0].get("valor") or 0)
                if val > 10.0:
                    print(f"[BCV] Tasa cargada desde Supabase: Bs {val:,.2f}", flush=True)
                    return val
    except Exception as e:
        print(f"[BCV] Supabase no disponible ({e})", flush=True)

    try:
        import urllib.request
        req = urllib.request.Request("https://pydolarve.org/api/v1/dollar?page=bcv", headers={"User-Agent": "TrackFlow/1.0"})
        with urllib.request.urlopen(req, timeout=5) as response:
            if response.status == 200:
                res_data = json.loads(response.read().decode("utf-8"))
                val = float(res_data.get("monitors", {}).get("usd", {}).get("price", 0))
                if val > 10.0:
                    print(f"[BCV] Tasa cargada desde API externa: Bs {val:,.2f}", flush=True)
                    return val
    except Exception:
        pass

    print(f"[BCV] Usando tasa de seguridad por defecto: Bs {fallback:,.2f}", flush=True)
    return fallback


def cargar_filas_de_db():
    """Lee productos_competencia desde Supabase y enriquece con publicacion_id del nuevo catálogo relacional."""
    try:
        from supabase_client import is_supabase_configured, select
        if is_supabase_configured():
            filas = select("productos_competencia", "select=*")
            if filas:
                try:
                    pubs = select("publicaciones", "select=id,cadena_id,url_normalizada")
                    pub_map = {(p["cadena_id"].lower(), p["url_normalizada"]): p["id"] for p in pubs}
                    url_map = {p["url_normalizada"]: p["id"] for p in pubs}
                    for f in filas:
                        url_norm = re.sub(r'\?.*$', '', (f.get("url") or "")).strip().lower()
                        cad = (f.get("cadena") or "").lower()
                        f["publicacion_id"] = pub_map.get((cad, url_norm)) or url_map.get(url_norm)
                except Exception as ex_pub:
                    print(f"Aviso mapeo publicaciones: {ex_pub}", flush=True)

                for f in filas:
                    f["_doc_id"] = str(f.get("id") or f.get("_doc_id") or "")
                print(f"Cargadas {len(filas)} filas desde Supabase (con mapeo a publicaciones)", flush=True)
                return filas
    except Exception as e:
        print(f"No se pudo cargar desde Supabase: {e}", flush=True)

    return None


def cargar_filas_de_csv():
    """Fallback local: lee productos desde el archivo CSV."""
    if not CSV_PATH.exists():
        return []
    text = read_text_robust(CSV_PATH)
    sample = text[:2048]
    delim = ";" if sample.count(";") > sample.count(",") else ","
    filas = [row for row in csv.DictReader(io.StringIO(text), delimiter=delim)]
    print(f"Cargadas {len(filas)} filas desde CSV local", flush=True)
    return filas


LAST_REQUEST_TIME = {}
DOMAIN_MIN_DELAY = {
    "farmatodo": 6.0,
    # Locatel y SAAS se leen por su API (una consulta liviana): basta 1 s.
    "locatel": 1.0,
    "saas": 1.0,
    "farmaciasaas": 1.0,
    "default": 1.5
}



# ---------------------------------------------------------------------------
# Tiendas VTEX (Locatel, Farmacia SAAS): via rapida por su API publica de
# catalogo. Una consulta liviana trae precio normal, precio con oferta y
# existencia, sin abrir la pagina en el navegador. Si algo falla se usa la
# pagina como antes (JSON-LD).
# ---------------------------------------------------------------------------
VTEX_DOMINIOS = {"locatel.com.ve", "farmaciasaas.com"}
MONEDA_VTEX: dict = {}  # dominio -> "VES" / "USD", se lee una vez por corrida
# Tiendas WooCommerce (Farmadon...): via rapida por su Store API publica.
WOO_DOMINIOS: set = set()


def dominio_de(url: str) -> str:
    m = re.match(r"^(?:https?://)?(?:www\.)?([^/]+)", (url or "").strip().lower())
    return m.group(1) if m else ""


def cargar_plataformas():
    """Suma las tiendas VTEX y WooCommerce que detecto el robot buscador
    (dim_cadenas.plataforma, fase 36): asi una cadena nueva usa la via rapida
    sin tocar el codigo."""
    try:
        from supabase_client import is_supabase_configured, select
        if not is_supabase_configured():
            return
        for c in select("dim_cadenas", "select=website,plataforma&plataforma=in.(vtex,woocommerce)"):
            d = dominio_de(c.get("website"))
            if d:
                (VTEX_DOMINIOS if c["plataforma"] == "vtex" else WOO_DOMINIOS).add(d)
        print(f"Tiendas VTEX: {sorted(VTEX_DOMINIOS)} · WooCommerce: {sorted(WOO_DOMINIOS)}", flush=True)
    except Exception as e:
        print(f"Aviso: no se leyeron las plataformas de las cadenas ({e})", flush=True)


def es_vtex(url: str) -> bool:
    u = url.lower()
    return any(d in u for d in VTEX_DOMINIOS) and bool(re.search(r"/p/?(?:[?#].*)?$", u))


async def moneda_vtex(request, base: str, url: str) -> str | None:
    """Moneda en que la tienda publica sus precios (meta product:price:currency)."""
    if base in MONEDA_VTEX:
        return MONEDA_VTEX[base]
    try:
        r = await request.get(url, timeout=20000)
        if r.ok:
            html = await r.text()
            m = (re.search(r'product:price:currency"\s+content="([A-Za-z]{3})"', html)
                 or re.search(r'"priceCurrency"\s*:\s*"([A-Za-z]{3})"', html))
            if m:
                MONEDA_VTEX[base] = m.group(1).upper()
                return MONEDA_VTEX[base]
    except Exception:
        pass
    return None


async def leer_vtex(page, url: str, bcv_rate: float) -> dict | None:
    """Precio de una tienda VTEX por su API. None = usar la pagina."""
    m = re.match(r"^(https?://[^/]+)/(.+?)/p/?(?:[?#].*)?$", url.strip(), re.IGNORECASE)
    if not m:
        return None
    base, slug = m.group(1).lower(), m.group(2)
    request = page.context.request
    try:
        r = await request.get(f"{base}/api/catalog_system/pub/products/search/{slug}/p",
                              timeout=15000, headers={"Accept": "application/json"})
        if not r.ok:
            return None
        productos = await r.json()
    except Exception:
        return None
    if not isinstance(productos, list):
        return None
    if not productos:
        return {"error": "Enlace roto: la tienda ya no tiene este producto."}

    prod = productos[0]
    ofertas = []
    for item in prod.get("items") or []:
        for vendedor in item.get("sellers") or []:
            o = vendedor.get("commertialOffer") or {}
            if (o.get("Price") or 0) > 0:
                ofertas.append(o)
    if not ofertas:
        return {"error": "Producto agotado en la tienda.", "nombre": prod.get("productName")}
    o = next((x for x in ofertas if x.get("IsAvailable") or (x.get("AvailableQuantity") or 0) > 0), ofertas[0])
    if not (o.get("IsAvailable") or (o.get("AvailableQuantity") or 0) > 0):
        return {"error": "Producto agotado en la tienda.", "nombre": prod.get("productName")}

    moneda = await moneda_vtex(request, base, url)
    if not moneda:
        return None
    # Siempre en bolivares: si la tienda publica en dolares (Ref.) se pasa con
    # la tasa BCV del dia, que es la misma que usa la tienda para mostrar Bs.
    factor = 1.0 if moneda in ("VES", "VEF", "BS") else (bcv_rate if bcv_rate > 0 else 0)
    if not factor:
        return None
    venta = float(o["Price"]) * factor
    lista = float(o.get("ListPrice") or o.get("PriceWithoutDiscount") or 0) * factor
    return {
        "nombre": prod.get("productName"),
        "precio_lista": round(max(venta, lista), 2),
        "precio_oferta": round(venta, 2) if lista > venta + 0.01 else None,
        "moneda_tienda": moneda,
    }


def es_woo(url: str) -> bool:
    return dominio_de(url) in WOO_DOMINIOS


async def leer_woo(page, url: str, bcv_rate: float) -> dict | None:
    """Precio de una tienda WooCommerce por su Store API. None = usar la pagina."""
    m = re.match(r"^(https?://[^/]+)/(.*?)/?(?:[?#].*)?$", url.strip(), re.IGNORECASE)
    if not m:
        return None
    base = m.group(1).lower()
    slug = [x for x in m.group(2).split("/") if x][-1:] or [""]
    if not slug[0]:
        return None
    try:
        r = await page.context.request.get(f"{base}/wp-json/wc/store/v1/products?slug={urllib.parse.quote(slug[0])}",
                                           timeout=15000, headers={"Accept": "application/json"})
        if not r.ok:
            return None
        productos = await r.json()
    except Exception:
        return None
    if not isinstance(productos, list) or not productos:
        return None
    prod = productos[0]
    precios = prod.get("prices") or {}
    try:
        div = 10 ** int(precios.get("currency_minor_unit") or 0)
        venta = int(precios.get("price") or 0) / div
        regular = int(precios.get("regular_price") or 0) / div
    except (TypeError, ValueError):
        return None
    if venta <= 0:
        return None
    if prod.get("is_in_stock") is False:
        return {"error": "Producto agotado en la tienda.", "nombre": prod.get("name")}
    moneda = str(precios.get("currency_code") or "VES").upper()
    factor = 1.0 if moneda in ("VES", "VEF", "BS") else (bcv_rate if bcv_rate > 0 else 0)
    if not factor:
        return None
    return {
        "nombre": re.sub(r"<[^>]+>", "", prod.get("name") or ""),
        "precio_lista": round(max(venta, regular) * factor, 2),
        "precio_oferta": round(venta * factor, 2) if regular > venta + 0.001 else None,
        "moneda_tienda": moneda,
    }


def llenar_resultado(result: dict, lista_bs: float, oferta_bs: float | None, metodo: str, bcv_rate: float) -> dict:
    """Completa el resultado con precios ya en Bs (misma forma que la via de la pagina)."""
    tiene_desc = bool(oferta_bs and (lista_bs - oferta_bs) > 0.05)
    result["precio_full_bs"] = round(lista_bs, 2)
    result["precio_desc_bs"] = round(oferta_bs, 2) if tiene_desc else None
    result["precio_full_usd"] = round(lista_bs / bcv_rate, 2) if bcv_rate > 0 else None
    result["precio_desc_usd"] = round(oferta_bs / bcv_rate, 2) if (tiene_desc and bcv_rate > 0) else None
    result["tiene_descuento"] = tiene_desc
    result["porcentaje_descuento"] = round((lista_bs - oferta_bs) / lista_bs * 100, 1) if tiene_desc else None
    result["metodo_extraccion"] = metodo
    return result


async def wait_for_domain_rate_limit(url: str):
    domain = "default"
    url_lower = url.lower()
    for d in DOMAIN_MIN_DELAY:
        if d in url_lower:
            domain = d
            break

    min_delay = DOMAIN_MIN_DELAY.get(domain, 1.5)
    now = time.time()
    last_time = LAST_REQUEST_TIME.get(domain, 0.0)
    elapsed = now - last_time
    if elapsed < min_delay:
        sleep_time = (min_delay - elapsed) + random.uniform(0.1, 0.4)
        await asyncio.sleep(sleep_time)

    LAST_REQUEST_TIME[domain] = time.time()


def interleave_filas_por_producto(filas: list) -> list:
    """
    Agrupa las filas por id_producto_propio y las ordena por producto para rotación de cadenas.
    """
    por_producto = {}
    for f in filas:
        pid = str(f.get("id_producto_propio", "sin_id")).strip()
        if pid not in por_producto:
            por_producto[pid] = []
        por_producto[pid].append(f)

    pids_ordenados = sorted(por_producto.keys())
    interleaved = []
    for pid in pids_ordenados:
        filas_prod = por_producto[pid]
        filas_prod_ordenadas = sorted(filas_prod, key=lambda x: str(x.get("cadena", "")).lower())
        interleaved.extend(filas_prod_ordenadas)

    print(f"[Optimizador] Entrelazadas {len(interleaved)} URLs agrupadas por producto ({len(pids_ordenados)} productos únicos)", flush=True)
    return interleaved


async def block_unnecessary_resources(route):
    """Cancela recursos pesados permitiendo XHR/Fetch/JSON/CSS/JS."""
    req = route.request
    res_type = req.resource_type
    url_lower = req.url.lower()

    if res_type in ("image", "media", "font", "websocket"):
        await route.abort()
        return

    analytics_keywords = (
        "google-analytics", "analytics", "google-tag-manager", "googletagmanager",
        "facebook", "connect.facebook.net", "hotjar", "sentry", "datadog",
        "mixpanel", "doubleclick", "adservice", "amplitude"
    )
    if any(kw in url_lower for kw in analytics_keywords):
        await route.abort()
        return

    await route.continue_()


async def extract_product_data_from_page(page, url: str, target_product_id: str | None, diagnostico: bool = False, bcv_rate: float = 0) -> dict:
    """
    Motor de extracción con anclaje al ID de producto, resolución por especificidad,
    exclusión estricta de carruseles/productos relacionados y validación de precio unitario.
    """
    return await page.evaluate(r"""
        ({ target_product_id, diagnostico, bcv_rate }) => {
            const bodyText = document.body ? document.body.innerText || '' : '';
            const title = document.title || '';

            // 1. Detectar bloqueos anti-bot
            if (title.includes('Cloudflare') || title.includes('Just a moment') || 
                bodyText.includes('Checking your browser') || bodyText.includes('Access Denied') ||
                bodyText.includes('Too Many Requests') || title.includes('429')) {
                return { error: "HTTP 429" };
            }

            // 2. Pagina que no existe (enlace roto) o producto agotado. El
            //    texto "agotado" / "Enlace roto" lo usa la fase 46 para
            //    separar los agotados de las URL que fallan.
            if (title.includes('404') || bodyText.includes('No pudimos encontrar') || bodyText.includes('no encontrado')) {
                return { error: "Enlace roto: la página del producto no existe (404)." };
            }
            if (bodyText.includes('Producto no disponible')) {
                return { error: "Producto agotado o no disponible en la tienda." };
            }

            const isVisible = (el) => {
                if (!el) return false;
                try {
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                    return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
                } catch(e) {
                    return false;
                }
            };

            const isInsideCarouselOrRelated = (el) => {
                if (!el) return false;
                try {
                    const forbiddenAncestor = el.closest('app-carousel, app-product-card, .carousel, .related-products, .swiper, .slick, .product-list, app-other-presentations, app-related-products, [class*="carousel"], [class*="other-presentation"]');
                    return forbiddenAncestor !== null;
                } catch(e) {
                    return false;
                }
            };

            const parsePriceText = (str) => {
                if (!str) return null;
                let cleaned = str.replace(/[^\d.,]/g, '').trim();
                if (!cleaned) return null;
                if (cleaned.includes(',')) {
                    cleaned = cleaned.replace(/\./g, '').replace(/,/g, '.');
                } else {
                    const dots = (cleaned.match(/\./g) || []).length;
                    if (dots === 1) {
                        const parts = cleaned.split('.');
                        if (parts[1].length === 3) cleaned = cleaned.replace(/\./g, '');
                    } else if (dots > 1) {
                        cleaned = cleaned.replace(/\./g, '');
                    }
                }
                const val = parseFloat(cleaned);
                return isNaN(val) ? null : val;
            };

            let nombre = null;
            let precio_lista = null;
            let precio_oferta = null;
            let precio_unitario = null;
            let promo_struct = null;
            let metodo_extraccion = null;
            let precio_moneda = null;

            const isFarmatodo = window.location.hostname.includes('farmatodo');

            // 3. ESTRATEGIA FARMATODO (Anclaje estricto a ID del producto y resolución específica)
            if (isFarmatodo) {
                try {
                    const ftTitleEl = document.querySelector('h1, app-product-detail h1, [class*="product-detail__title"]');
                    if (ftTitleEl && isVisible(ftTitleEl)) {
                        nombre = (ftTitleEl.innerText || ftTitleEl.textContent || '').trim();
                    }

                    // A1. VÍA PRIORITARIA: Selectores con sufijo exacto del target_product_id
                    if (target_product_id) {
                        const exactNormalEl = document.querySelector(`[id="product-all-price-normal-${target_product_id}"], [id*="normal-${target_product_id}"]`);
                        const exactOfferEl = document.querySelector(`[id="product-all-price-offer-${target_product_id}"], [id*="offer-${target_product_id}"]`);

                        if (exactNormalEl && isVisible(exactNormalEl) && !isInsideCarouselOrRelated(exactNormalEl)) {
                            const val = parsePriceText(exactNormalEl.innerText || exactNormalEl.textContent || '');
                            if (val && val > 0.1) {
                                precio_lista = val;
                            }
                        }

                        if (exactOfferEl && isVisible(exactOfferEl) && !isInsideCarouselOrRelated(exactOfferEl)) {
                            const val = parsePriceText(exactOfferEl.innerText || exactOfferEl.textContent || '');
                            if (val && val > 0.1) {
                                precio_oferta = val;
                                metodo_extraccion = "dom";
                            }
                        }
                    }

                    // A2. RESOLUCIÓN POR ESPECIFICIDAD DEL CONTENEDOR (Uno por uno en orden de especificidad estricta)
                    let purchaseBox = null;
                    const specificSelectors = [
                        target_product_id ? `[id="product-all-price-${target_product_id}"]` : null,
                        target_product_id ? `app-product-all-price[id*="${target_product_id}"]` : null,
                        'app-product-all-price',
                        '.product-all-price',
                        '.product-purchase__price-section'
                    ].filter(Boolean);

                    for (const sel of specificSelectors) {
                        const elements = Array.from(document.querySelectorAll(sel)).filter(el => isVisible(el) && !isInsideCarouselOrRelated(el));
                        if (elements.length > 0) {
                            purchaseBox = elements[0];
                            break;
                        }
                    }

                    // Si no hay contenedor específico visible, abstenerse (NUNCA usar app-product-detail genérico)
                    if (purchaseBox) {
                        // Extraer precio unitario si está presente dentro del purchaseBox ("Tabletas a Bs. 536,30")
                        const unitEls = Array.from(purchaseBox.querySelectorAll('p, span, div')).filter(el => {
                            const txt = (el.innerText || el.textContent || '').toLowerCase();
                            return (txt.includes('a bs') || txt.includes('a ves') || txt.includes('tabletas a') || txt.includes('unidades a') || txt.includes('c/u')) && /\d/.test(txt);
                        });
                        if (unitEls.length > 0) {
                            precio_unitario = parsePriceText(unitEls[0].innerText || unitEls[0].textContent || '');
                        }

                        // A3. Badge de descuento dentro del purchaseBox específico
                        const badgeElements = Array.from(purchaseBox.querySelectorAll('.badge-discount, .discount-badge, [class*="badge"], [class*="discount"], [class*="dcto"], [class*="tag"], [class*="offer"], .badge, .tag')).filter(isVisible);
                        for (const badge of badgeElements) {
                            if (badge.children.length > 2) continue;
                            const txt = (badge.innerText || badge.textContent || '').replace(/\s+/g, ' ').trim();
                            if (!txt || txt.length > 90) continue;

                            const matchPct = txt.match(/\b(\d{1,2})\s*%\s*(?:dcto|descuento|off)?/i) || txt.match(/(\d{1,2})%/);
                            const matchMonto = txt.match(/(?:ahorra|dcto|descuento|menos)\s*(?:bs\.?s?|ves)?\s*([\d.,]+)/i);

                            if (matchPct) {
                                const pct = parseInt(matchPct[1], 10);
                                if (pct >= 2 && pct <= 90) {
                                    promo_struct = { tipo: "porcentaje", valor: pct, texto_literal: txt };
                                    break;
                                }
                            } else if (matchMonto) {
                                const monto = parsePriceText(matchMonto[1]);
                                if (monto && monto > 0) {
                                    promo_struct = { tipo: "monto_fijo", valor: monto, texto_literal: txt };
                                    break;
                                }
                            } else if (/delivery|1era|primera|app|promo|oferta|dcto|descuento/i.test(txt)) {
                                promo_struct = { tipo: "no_parseable", valor: null, texto_literal: txt };
                                break;
                            }
                        }

                        // A4. Inspección de elementos de precio dentro del purchaseBox con evidencia explícita
                        if (!precio_lista) {
                            const normalCandidate = purchaseBox.querySelector('[id^="product-all-price-normal-"], .product-all-price__normal, [class*="product-all-price__normal"]');
                            if (normalCandidate && isVisible(normalCandidate)) {
                                precio_lista = parsePriceText(normalCandidate.innerText || normalCandidate.textContent || '');
                            }
                        }

                        if (!precio_oferta) {
                            const offerCandidate = purchaseBox.querySelector('[id^="product-all-price-offer-"], .product-all-price__offer, [class*="product-all-price__offer"]');
                            if (offerCandidate && isVisible(offerCandidate)) {
                                precio_oferta = parsePriceText(offerCandidate.innerText || offerCandidate.textContent || '');
                                if (precio_oferta) metodo_extraccion = "dom";
                            }
                        }

                        // Inspección de tachados si aún falta precio_lista o precio_oferta
                        if (!precio_lista || !precio_oferta) {
                            const strikedEl = purchaseBox.querySelector('del, s, strike, [style*="line-through"]');
                            if (strikedEl && isVisible(strikedEl)) {
                                const valStriked = parsePriceText(strikedEl.innerText || strikedEl.textContent || '');
                                if (valStriked && valStriked > 0.1) {
                                    if (!precio_lista) precio_lista = valStriked;
                                }
                            }
                        }

                        // Si tenemos precio_lista y badge pero no precio_oferta explícito en el DOM
                        if (precio_lista && !precio_oferta && promo_struct) {
                            if (promo_struct.tipo === "porcentaje" && promo_struct.valor) {
                                precio_oferta = Math.round((precio_lista * (1 - (promo_struct.valor / 100))) * 100) / 100;
                                metodo_extraccion = "derivado";
                            } else if (promo_struct.tipo === "monto_fijo" && promo_struct.valor && precio_lista > promo_struct.valor) {
                                precio_oferta = Math.round((precio_lista - promo_struct.valor) * 100) / 100;
                                metodo_extraccion = "derivado";
                            } else if (promo_struct.tipo === "no_parseable") {
                                precio_oferta = null;
                                metodo_extraccion = "promo_no_resuelta";
                            }
                        }
                    }

                } catch(e) {}
            }

            // 4. ESTRATEGIA VTEX / NEXT / SCHEMA (Para otras cadenas)
            if (!precio_lista && window.__STATE__) {
                try {
                    const state = window.__STATE__;
                    for (const k in state) {
                        if (k.includes('Product:') || k.includes('Item:') || k.includes('commertialOffer')) {
                            const item = state[k];
                            if (!nombre && item.productName) nombre = item.productName;
                            const comm = item.commertialOffer || (item.sellers && item.sellers[0] && item.sellers[0].commertialOffer);
                            if (comm) {
                                const p = parseFloat(comm.Price);
                                const lp = parseFloat(comm.ListPrice || comm.PriceWithoutDiscount);
                                if (lp && p && lp > p) {
                                    precio_lista = lp;
                                    precio_oferta = p;
                                    metodo_extraccion = "dom";
                                } else if (p) {
                                    precio_lista = p;
                                    metodo_extraccion = "dom";
                                }
                                if (precio_lista) break;
                            }
                        }
                    }
                } catch(e) {}
            }

            if (!precio_lista) {
                // JSON-LD: tambien dentro de @graph (WooCommerce/Yoast) y con
                // @type en lista; la oferta puede traer priceSpecification.
                const aplanar = (x, out) => {
                    if (!x || typeof x !== 'object') return out;
                    if (Array.isArray(x)) { x.forEach(y => aplanar(y, out)); return out; }
                    out.push(x);
                    if (x['@graph']) aplanar(x['@graph'], out);
                    return out;
                };
                const esProducto = (it) => [].concat(it['@type'] || []).some(t => String(t).toLowerCase() === 'product');
                const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                for (const s of scripts) {
                    try {
                        const items = aplanar(JSON.parse(s.textContent || '{}'), []);
                        for (const it of items) {
                            if (esProducto(it) && it.offers) {
                                if (!nombre && it.name) nombre = it.name;
                                const ofertas = [].concat(it.offers);
                                let off = ofertas.find(o => o && (o.price || o.lowPrice || (o.priceSpecification && [].concat(o.priceSpecification)[0]?.price))) || ofertas[0];
                                if (off && !off.price && off.priceSpecification) {
                                    const ps = [].concat(off.priceSpecification)[0] || {};
                                    off = { ...off, price: ps.price, priceCurrency: off.priceCurrency || ps.priceCurrency };
                                }
                                // AggregateOffer (tiendas VTEX y similares) trae lowPrice
                                // en vez de price. La moneda se guarda: si es USD se pasa
                                // a Bs en Python con la tasa del dia.
                                if (off && !off.price && off.lowPrice) off.price = off.lowPrice;
                                if (off && off.priceCurrency) precio_moneda = String(off.priceCurrency).toUpperCase();
                                if (off && off.price) {
                                    precio_lista = parseFloat(String(off.price).replace(',', '.'));
                                    metodo_extraccion = metodo_extraccion || "jsonld";
                                    // En AggregateOffer high/low es el rango entre vendedores,
                                    // no un descuento: solo cuenta en una oferta simple.
                                    if (off['@type'] !== 'AggregateOffer' && off.highPrice && parseFloat(off.highPrice) > precio_lista) {
                                        precio_oferta = precio_lista;
                                        precio_lista = parseFloat(off.highPrice);
                                        metodo_extraccion = "dom";
                                    }
                                }
                                if (precio_lista) break;
                            }
                        }
                    } catch(e) {}
                    if (precio_lista) break;
                }
            }

            // Metadatos de producto (Open Graph / microdatos): muchas tiendas
            // los traen aunque no tengan JSON-LD.
            if (!precio_lista && !isFarmatodo) {
                try {
                    const meta = (sel) => {
                        const el = document.querySelector(sel);
                        return el ? (el.getAttribute('content') || el.textContent || '').trim() : '';
                    };
                    const monto = meta('meta[property="product:price:amount"]') || meta('meta[property="og:price:amount"]')
                        || meta('[itemprop="price"]');
                    const val = parsePriceText(monto);
                    if (val && val > 0.01) {
                        precio_lista = /^\d+(\.\d+)?$/.test(monto) ? parseFloat(monto) : val;
                        metodo_extraccion = "meta";
                        const mon = meta('meta[property="product:price:currency"]') || meta('meta[property="og:price:currency"]')
                            || meta('[itemprop="priceCurrency"]');
                        if (mon) precio_moneda = mon.toUpperCase();
                    }
                } catch(e) {}
            }

            // Primero bolivares (regla de Hernando): en otras tiendas, si lo leido
            // esta en dolares o no se leyo nada, manda el precio en Bs de la
            // ficha. Precio tachado = precio normal y el otro = oferta, como en
            // Farmatodo. Solo los primeros precios de la ficha (no relacionados).
            if (!isFarmatodo && (!precio_lista || precio_moneda === 'USD')) {
                try {
                    const previo = { lista: precio_lista, oferta: precio_oferta, moneda: precio_moneda, metodo: metodo_extraccion };
                    const reBs = /(bs\.?\s?s?\.?)[ \t]*(\d[\d.,]*)|(\d[\d.,]*)[ \t]*(bs\.?\s?s?\.?)(?![a-z])/i;
                    // La ficha: el bloque que contiene el TITULO del producto (h1)
                    // y un precio en Bs. Asi no se toma un monto que se repite en
                    // todas las paginas de la tienda (envio, carrito, banner),
                    // que dejaba a todos los productos con el mismo precio.
                    let zona = null;
                    const titulo = [...document.querySelectorAll('h1')].find(isVisible);
                    for (let n = titulo && titulo.parentElement, i = 0; n && n !== document.body && i < 6; n = n.parentElement, i++) {
                        if (reBs.test(n.innerText || '')) { zona = n; break; }
                    }
                    zona = zona || document.querySelector('#product_detail, .oe_website_sale #product_details, main .product, .product-detail, [class*="product-detail" i], [class*="productDetail" i], [class*="product_detail" i]');
                    if (!zona) throw new Error('sin ficha');
                    const esTachado = (el) => !!el.closest('del, s, strike, [class*="old" i], [class*="regular" i], [class*="before" i], [class*="default_price" i], [class*="list-price" i], [class*="listPrice" i], [class*="tachado" i]')
                        || (getComputedStyle(el).textDecorationLine || '').includes('line-through');
                    const reBsTodos = new RegExp(reBs.source, 'gi');
                    // valor -> tachado (si en algun lugar aparece tachado, lo es)
                    const porValor = new Map();
                    for (const el of zona.querySelectorAll('*')) {
                        if (el.children.length > 3 || !isVisible(el) || isInsideCarouselOrRelated(el)) continue;
                        const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
                        if (t.length > 60) continue;
                        // Un contenedor con dos precios (tachado + nuevo) no dice cual es cual.
                        if ((t.match(reBsTodos) || []).length !== 1) continue;
                        const m = t.match(reBs);
                        const valor = parsePriceText(m[2] || m[3]);
                        if (!valor || valor <= 0.5) continue;
                        if (!porValor.has(valor) && porValor.size >= 4) break;
                        porValor.set(valor, (porValor.get(valor) || false) || esTachado(el));
                    }
                    const hallados = [...porValor.entries()].map(([valor, tach]) => ({ valor, tach }));
                    const normales = hallados.filter(h => !h.tach);
                    const tachados = hallados.filter(h => h.tach);
                    if (normales.length || tachados.length) {
                        const actual = normales.length ? normales[0].valor : null;
                        const antes = tachados.length ? Math.max(...tachados.map(h => h.valor)) : null;
                        if (antes && actual && antes > actual) {
                            precio_lista = antes;
                            precio_oferta = actual;
                        } else {
                            precio_lista = actual || antes;
                            precio_oferta = null;
                        }
                        precio_moneda = 'VES';
                        metodo_extraccion = "dom_bs";
                        // Si la pagina ya daba el precio en dolares, el de Bs tiene
                        // que cuadrar con la tasa (±25 %); si no, manda el de dolares.
                        if (previo.moneda === 'USD' && previo.lista > 0 && bcv_rate > 0
                            && Math.abs(precio_lista / bcv_rate - previo.lista) / previo.lista > 0.25) {
                            precio_lista = previo.lista;
                            precio_oferta = previo.oferta;
                            precio_moneda = previo.moneda;
                            metodo_extraccion = previo.metodo;
                        }
                    }
                } catch(e) {}
            }

            // Ultimo recurso en otras tiendas: el primer precio visible de la
            // ficha (fuera de carruseles). Con precio tachado + precio nuevo
            // (WooCommerce: del / ins) se toma como oferta.
            if (!precio_lista && !isFarmatodo) {
                try {
                    const zona = document.querySelector('main .product, .product, [class*="product-detail" i], [class*="productDetail" i], main') || document.body;
                    const cands = [...zona.querySelectorAll('p.price, .price, .product-price, [class*="price" i]')]
                        .filter(el => isVisible(el) && !isInsideCarouselOrRelated(el) && /\d/.test(el.textContent || ''));
                    const el = cands[0];
                    if (el) {
                        const viejo = el.querySelector('del, s, [class*="old" i], [class*="regular" i], [class*="before" i]');
                        const nuevo = el.querySelector('ins, [class*="sale" i], [class*="special" i], [class*="offer" i]');
                        const txt = (x) => (x.innerText || x.textContent || '');
                        if (viejo && nuevo) {
                            const l = parsePriceText(txt(viejo));
                            const o = parsePriceText(txt(nuevo));
                            if (l && o && l > o) { precio_lista = l; precio_oferta = o; }
                        }
                        if (!precio_lista) precio_lista = parsePriceText(txt(el));
                        if (precio_lista) {
                            metodo_extraccion = "dom_generico";
                            if (/\$|USD|REF/i.test(txt(el))) precio_moneda = 'USD';
                        }
                    }
                } catch(e) {}
            }

            if (!nombre) {
                const h1El = document.querySelector('h1');
                nombre = h1El && isVisible(h1El) ? (h1El.innerText || h1El.textContent || '').trim() : document.title.split('|')[0].trim();
            }

            // Modo diagnostico: lo que se ve en la pagina, para ajustar el robot
            // a una cadena nueva (Locatel, SAAS...). Solo si se pide.
            let diag = null;
            if (diagnostico) {
                diag = {};
                try {
                    diag.titulo = (document.title || '').slice(0, 120);
                    const h1 = document.querySelector('h1');
                    diag.h1 = h1 ? (h1.innerText || '').trim().slice(0, 120) : null;
                    diag.jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')]
                        .map(s => (s.textContent || '').replace(/\s+/g, ' ').slice(0, 500));
                    diag.meta = [...document.querySelectorAll('meta[property*="price"], meta[itemprop*="price"], meta[property*="currency"], meta[itemprop*="Currency"]')]
                        .map(m => `${m.getAttribute('property') || m.getAttribute('itemprop')}=${m.getAttribute('content')}`);
                    diag.precios_visibles = [...document.querySelectorAll('body *')]
                        .filter(el => el.children.length === 0 && /(Bs\.?|\$|REF|USD)\s*[\d.,]+|[\d.,]+\s*(Bs|\$|USD)/i.test(el.textContent || '')
                            && isVisible(el) && !isInsideCarouselOrRelated(el))
                        .slice(0, 12)
                        .map(el => `${el.tagName.toLowerCase()}.${String(el.className || '').slice(0, 40)} = ${(el.textContent || '').trim().slice(0, 60)}`);
                } catch(e) { diag.error = String(e); }
            }

            return {
                nombre,
                precio_lista,
                precio_oferta,
                precio_unitario,
                promo_struct,
                metodo_extraccion,
                precio_moneda,
                diag
            };
        }
    """, {"target_product_id": target_product_id, "diagnostico": diagnostico, "bcv_rate": bcv_rate or 0})


async def scrape_url_async(page, url: str, marca: str, bcv_rate: float, task_id: str = "1") -> dict:
    """Ejecuta el ciclo de scraping con validación de coherencia unitaria."""
    intentos = 3
    is_farmatodo = "farmatodo" in url.lower()
    target_product_id = extract_product_id_from_url(url)
    unit_count = extract_unit_count(marca) or extract_unit_count(url)

    result = {
        "url": url,
        "marca": marca,
        "nombre": None,
        "precio_full_bs": None,       # precio_lista
        "precio_desc_bs": None,       # precio_oferta
        "precio_full_usd": None,
        "precio_desc_usd": None,
        "tipo_promo": None,
        "porcentaje_descuento": None,
        "promo_condicionada": False,
        "metodo_extraccion": None,
        "tiene_descuento": False,
        "descarte_motivo": None,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "error": None,
    }

    for int_num in range(1, intentos + 1):
        result["error"] = None
        result["precio_full_bs"] = None
        result["precio_desc_bs"] = None
        result["precio_full_usd"] = None
        result["precio_desc_usd"] = None
        result["tipo_promo"] = None
        result["porcentaje_descuento"] = None
        result["promo_condicionada"] = False
        result["metodo_extraccion"] = None
        result["tiene_descuento"] = False
        result["descarte_motivo"] = None

        await wait_for_domain_rate_limit(url)

        # Via rapida para tiendas VTEX (Locatel, SAAS): sin abrir la pagina.
        if es_vtex(url):
            rapido = await leer_vtex(page, url, bcv_rate)
            if rapido and rapido.get("error"):
                result["error"] = rapido["error"]
                result["nombre"] = limpiar_nombre(rapido.get("nombre"))
                return result
            if rapido and rapido.get("precio_lista"):
                result["nombre"] = limpiar_nombre(rapido.get("nombre"))
                if DIAGNOSTICO:
                    print(f"\n   🔎 [{task_id}] API VTEX {url}: lista={rapido['precio_lista']} oferta={rapido.get('precio_oferta')} (tienda en {rapido.get('moneda_tienda')})", flush=True)
                return llenar_resultado(result, rapido["precio_lista"], rapido.get("precio_oferta"), "vtex_api", bcv_rate)

        # Via rapida para tiendas WooCommerce (Farmadon...).
        if es_woo(url):
            rapido = await leer_woo(page, url, bcv_rate)
            if rapido and rapido.get("error"):
                result["error"] = rapido["error"]
                result["nombre"] = limpiar_nombre(rapido.get("nombre"))
                return result
            if rapido and rapido.get("precio_lista"):
                result["nombre"] = limpiar_nombre(rapido.get("nombre"))
                if DIAGNOSTICO:
                    print(f"\n   🔎 [{task_id}] API WooCommerce {url}: lista={rapido['precio_lista']} oferta={rapido.get('precio_oferta')} (tienda en {rapido.get('moneda_tienda')})", flush=True)
                return llenar_resultado(result, rapido["precio_lista"], rapido.get("precio_oferta"), "woo_api", bcv_rate)

        api_captured_data = {}
        api_urls_vistas = []

        async def handle_response(response):
            """Intercepción de red con aislamiento de sub-objeto coincidente por ID."""
            try:
                content_type = response.headers.get("content-type", "").lower()
                resp_url = response.url.lower()
                if DIAGNOSTICO and not is_farmatodo and "json" in content_type and len(api_urls_vistas) < 15:
                    api_urls_vistas.append(response.url[:140])
                if "json" in content_type and any(kw in resp_url for kw in ("product", "item", "articulo", "promotion", "promo", "pricing", "detail")):
                    if response.status == 200:
                        json_data = await response.json()

                        def find_target_product_object(obj, depth=0):
                            if not obj or depth > 5:
                                return None
                            if isinstance(obj, dict):
                                if target_product_id:
                                    for k in ("id", "productId", "itemCode", "sku", "code", "slug"):
                                        val = str(obj.get(k, "")).strip()
                                        if val and (val == target_product_id or target_product_id in val):
                                            return obj
                                if any(k in obj for k in ("fullPrice", "normalPrice", "offerPrice", "priceOffer", "precioBs", "bsPrice")):
                                    return obj
                                for v in obj.values():
                                    if isinstance(v, (dict, list)):
                                        found = find_target_product_object(v, depth + 1)
                                        if found is not None:
                                            return found
                            elif isinstance(obj, list):
                                for it in obj:
                                    found = find_target_product_object(it, depth + 1)
                                    if found is not None:
                                        return found
                            return None

                        matched_obj = find_target_product_object(json_data)
                        if matched_obj:
                            p_full = matched_obj.get("fullPrice") or matched_obj.get("normalPrice") or matched_obj.get("listPrice") or matched_obj.get("priceWithoutDiscount") or matched_obj.get("regularPrice")
                            p_offer = matched_obj.get("offerPrice") or matched_obj.get("specialPrice") or matched_obj.get("discountPrice") or matched_obj.get("priceOffer") or matched_obj.get("salePrice")
                            p_base = matched_obj.get("price") or matched_obj.get("bsPrice") or matched_obj.get("precioBs")

                            p_disc_pct = matched_obj.get("discountPercentage") or matched_obj.get("discount") or matched_obj.get("discountRate")
                            p_promo_name = matched_obj.get("promotionName") or matched_obj.get("promoTitle") or matched_obj.get("badgeText") or matched_obj.get("badge")

                            if p_full and not api_captured_data.get("precio_lista"):
                                api_captured_data["precio_lista"] = float(p_full)
                            if p_offer and not api_captured_data.get("precio_oferta"):
                                api_captured_data["precio_oferta"] = float(p_offer)
                            if p_base and not api_captured_data.get("precio_lista"):
                                api_captured_data["precio_lista"] = float(p_base)

                            if p_disc_pct and not api_captured_data.get("porcentaje_descuento"):
                                try:
                                    api_captured_data["porcentaje_descuento"] = float(p_disc_pct)
                                except Exception:
                                    pass
                            if p_promo_name and not api_captured_data.get("tipo_promo"):
                                api_captured_data["tipo_promo"] = str(p_promo_name).strip()

            except Exception:
                pass

        page.on("response", handle_response)

        try:
            timeout = 22000 + (int_num - 1) * 8000
            response = await page.goto(url, wait_until="domcontentloaded", timeout=timeout)

            if response and response.status >= 400:
                result["error"] = f"HTTP {response.status}"
                if response.status == 404:
                    result["error"] = "Enlace roto: la página del producto no existe (HTTP 404)."
                    return result
                if response.status in (429, 403, 500, 502, 503):
                    backoff = (6 * int_num) + random.uniform(2.5, 6.0)
                    print(f"   [{task_id}] ⚠️ HTTP {response.status} en {url[:40]}... Esperando {backoff:.1f}s (Intento {int_num}/{intentos})", flush=True)
                    await asyncio.sleep(backoff)
                    continue
                await asyncio.sleep(1.5)
                continue

            if is_farmatodo:
                try:
                    await page.wait_for_selector('app-product-all-price, .product-all-price, [id^="product-all-price-"]', timeout=6000)
                except Exception:
                    pass
                await asyncio.sleep(2.2)
            else:
                await asyncio.sleep(0.8)

            data = await extract_product_data_from_page(page, url, target_product_id, DIAGNOSTICO and not is_farmatodo, bcv_rate)

        except PlaywrightTimeout:
            result["error"] = "Timeout cargando la página"
            await asyncio.sleep(2)
            continue
        except Exception as e:
            result["error"] = f"Error de red/carga: {type(e).__name__}"
            await asyncio.sleep(2)
            continue
        finally:
            try:
                page.remove_listener("response", handle_response)
            except Exception:
                pass

        if data.get("error"):
            result["error"] = data["error"]
            if "HTTP 429" in data["error"]:
                backoff = (7 * int_num) + random.uniform(3.0, 5.0)
                print(f"   [{task_id}] ⚠️ Detectado bloqueo HTTP 429 en DOM. Esperando {backoff:.1f}s", flush=True)
                await asyncio.sleep(backoff)
                continue
            # Enlace roto o agotado: reintentar no cambia nada.
            if "Enlace roto" in data["error"] or "agotado" in data["error"].lower():
                return result
            await asyncio.sleep(1.5)
            continue

        result["nombre"] = limpiar_nombre(data.get("nombre"))

        # Precio en dolares en los datos de la pagina (JSON-LD): se pasa a Bs.
        if str(data.get("precio_moneda") or "").upper() in ("USD", "US$") and bcv_rate > 0:
            for k in ("precio_lista", "precio_oferta"):
                if data.get(k):
                    data[k] = round(float(data[k]) * bcv_rate, 2)

        if DIAGNOSTICO and not is_farmatodo:
            diag = data.get("diag") or {}
            print(f"\n   🔎 [{task_id}] DIAGNÓSTICO {url}", flush=True)
            print(f"      título: {diag.get('titulo')} | h1: {diag.get('h1')}", flush=True)
            print(f"      leído: lista={data.get('precio_lista')} oferta={data.get('precio_oferta')} moneda={data.get('precio_moneda')} método={data.get('metodo_extraccion')}", flush=True)
            print(f"      API interceptada: {api_captured_data or 'nada'}", flush=True)
            for j in diag.get("jsonld") or []:
                print(f"      JSON-LD: {j}", flush=True)
            for m in diag.get("meta") or []:
                print(f"      meta: {m}", flush=True)
            for t in diag.get("precios_visibles") or []:
                print(f"      en pantalla: {t}", flush=True)
            for u in api_urls_vistas:
                print(f"      JSON de la tienda: {u}", flush=True)

        # 1. Selección entre API validada y DOM anclado
        final_precio_lista = None
        final_precio_oferta = None
        final_tipo_promo = None
        final_pct_desc = None
        final_metodo = None
        promo_struct = data.get("promo_struct")
        precio_unitario = data.get("precio_unitario")

        if api_captured_data.get("precio_lista") and api_captured_data.get("precio_oferta") and api_captured_data["precio_lista"] > api_captured_data["precio_oferta"]:
            final_precio_lista = api_captured_data["precio_lista"]
            final_precio_oferta = api_captured_data["precio_oferta"]
            final_tipo_promo = api_captured_data.get("tipo_promo")
            final_pct_desc = api_captured_data.get("porcentaje_descuento")
            final_metodo = "api"
        elif api_captured_data.get("precio_lista") and not data.get("precio_lista"):
            final_precio_lista = api_captured_data["precio_lista"]
            final_metodo = "api"
        elif data.get("precio_lista"):
            final_precio_lista = data["precio_lista"]
            final_precio_oferta = data.get("precio_oferta")
            final_metodo = data.get("metodo_extraccion") or "dom"

            if promo_struct:
                final_tipo_promo = promo_struct.get("texto_literal")
                if promo_struct.get("tipo") == "porcentaje":
                    final_pct_desc = promo_struct.get("valor")

        # 2. VALIDACIÓN DE COHERENCIA UNITARIA (Red de Seguridad)
        # Si se detectó precio unitario y cantidad de unidades (ej: Bs. 536,30 x 20 = Bs. 10.726,00)
        if final_precio_lista and precio_unitario and unit_count:
            expected_full_price = round(precio_unitario * unit_count, 2)
            ratio_diff = abs(final_precio_lista - expected_full_price) / expected_full_price

            if ratio_diff > 0.08:
                # Discrepancia grave (ej: capturó caja de 40 en vez de 20)
                # Si el precio unitario x unidades da el valor esperado exacto de la presentación:
                if is_farmatodo:
                    print(f"   [{task_id}] ⚠️ Coherencia: Corrigiendo precio_lista ({final_precio_lista} -> {expected_full_price}) basado en precio unitario ({precio_unitario} x {unit_count})", flush=True)
                    final_precio_lista = expected_full_price
                    if final_pct_desc:
                        final_precio_oferta = round(final_precio_lista * (1 - (final_pct_desc / 100)), 2)
                        final_metodo = "derivado"
                    else:
                        final_precio_oferta = None

        if final_precio_lista:
            if final_precio_oferta and final_precio_oferta > final_precio_lista:
                final_precio_lista, final_precio_oferta = final_precio_oferta, final_precio_lista

            tiene_desc = bool(final_precio_oferta and (final_precio_lista - final_precio_oferta) > 0.05)
            
            texto_eval = (final_tipo_promo or "").lower()
            promo_cond = any(pattern in texto_eval for pattern in (
                "1era compra", "1ra compra", "primera compra", "primer pedido",
                "solo delivery", "solo app", "solo online", "exclusivo app", "exclusivo online"
            ))

            if tiene_desc:
                if not final_pct_desc and final_precio_lista > 0:
                    final_pct_desc = round(((final_precio_lista - final_precio_oferta) / final_precio_lista) * 100, 1)
            else:
                final_precio_oferta = None
                if final_metodo != "promo_no_resuelta":
                    final_pct_desc = None

            p_full_bs = round(final_precio_lista, 2)
            p_desc_bs = round(final_precio_oferta, 2) if final_precio_oferta else None

            result["precio_full_bs"] = p_full_bs
            result["precio_desc_bs"] = p_desc_bs
            result["precio_full_usd"] = round(p_full_bs / bcv_rate, 2) if bcv_rate > 0 else None
            result["precio_desc_usd"] = round(p_desc_bs / bcv_rate, 2) if (p_desc_bs and bcv_rate > 0) else None
            result["tipo_promo"] = final_tipo_promo
            result["porcentaje_descuento"] = final_pct_desc
            result["promo_condicionada"] = promo_cond
            result["metodo_extraccion"] = final_metodo
            result["tiene_descuento"] = tiene_desc
            break
        else:
            result["error"] = "Precio no encontrado en la estructura anclada al producto."
            result["descarte_motivo"] = "no_asociado_a_producto"
            await asyncio.sleep(1)

    return result


def enlaces_pedidos() -> set:
    """Ids de enlace (los de la vista productos_competencia) que pidio el panel.

    Llegan en el client_payload del repository_dispatch: `doc_ids` (lista o
    texto separado por comas) o `doc_id` (uno). GitHub Actions deja el evento
    en el archivo GITHUB_EVENT_PATH; ONLY_DOC_ID(S) sirven para probar a mano.
    Vacio = todos los enlaces activos (la corrida diaria).
    """
    valores = []
    ruta = os.environ.get("GITHUB_EVENT_PATH")
    if ruta and Path(ruta).exists():
        try:
            evento = json.loads(Path(ruta).read_text(encoding="utf-8"))
            payload = evento.get("client_payload") or {}
            valores += [payload.get("doc_ids"), payload.get("doc_id")]
        except Exception as ex:
            print(f"Aviso: no se pudo leer el evento de GitHub ({ex})", flush=True)
    valores += [os.environ.get("ONLY_DOC_IDS"), os.environ.get("ONLY_DOC_ID")]

    ids = set()
    for v in valores:
        if isinstance(v, list):
            ids.update(str(x).strip() for x in v if str(x).strip())
        elif v:
            ids.update(x.strip() for x in str(v).split(",") if x.strip())
    return ids


async def main_async():
    inicio = time.time()
    bcv_rate = await get_bcv_rate()

    filas = cargar_filas_de_db()
    if not filas:
        filas = cargar_filas_de_csv()
    cargar_plataformas()

    if not filas:
        print("❌ No hay enlaces para procesar.", flush=True)
        sys.exit(1)

    filas_activas = []
    for f in filas:
        activo_val = f.get("activo")
        if isinstance(activo_val, str):
            es_activo = activo_val.lower() in ("si", "true", "1", "t")
        elif isinstance(activo_val, bool):
            es_activo = activo_val
        else:
            es_activo = True

        if es_activo and (f.get("url") or "").strip():
            filas_activas.append(f)

    ids_pedidos = enlaces_pedidos()
    if ids_pedidos:
        # El panel pidio enlaces concretos (boton Robot de un enlace o de una
        # seleccion): solo esos. Si ninguno esta activo no se lee nada; leer
        # todos tarda mucho y no es lo que se pidio.
        filas_procesar = [f for f in filas_activas
                          if str(f.get("_doc_id") or f.get("id") or "") in ids_pedidos]
        print(f"Pedidos {len(ids_pedidos)} enlaces desde el panel; activos entre ellos: {len(filas_procesar)}.", flush=True)
        if not filas_procesar:
            OUT_PATH.write_text("[]", encoding="utf-8")
            return
    elif len(sys.argv) > 1:
        arg_target = sys.argv[1].strip()
        filas_procesar = [f for f in filas_activas if f.get("id_producto_propio") == arg_target or f.get("_doc_id") == arg_target or f.get("id") == arg_target]
        if not filas_procesar:
            print(f"Aviso: No se encontró producto con ID o doc_id '{arg_target}', procesando todas las activas.")
            filas_procesar = filas_activas
    else:
        filas_procesar = filas_activas

    # Modo diagnostico: con pocos enlaces de cadenas que no son Farmatodo (o
    # con TRACKFLOW_DIAGNOSTICO=1) se escribe en el log lo que se ve en cada
    # pagina, para ajustar el robot a una cadena nueva.
    global DIAGNOSTICO
    otras = [f for f in filas_procesar if "farmatodo" not in (str(f.get("cadena") or "") + str(f.get("url") or "")).lower()]
    DIAGNOSTICO = os.environ.get("TRACKFLOW_DIAGNOSTICO") == "1" or (0 < len(otras) and len(filas_procesar) <= 10)
    if DIAGNOSTICO:
        print("🔎 Modo diagnóstico activo: se escribe lo que se ve en cada página que no es de Farmatodo.", flush=True)

    filas_procesar = interleave_filas_por_producto(filas_procesar)
    print(f"\nIniciando scraping de {len(filas_procesar)} URLs (Concurrencia Máx: 12, Farmatodo Concurrencia: 1)...\n", flush=True)

    resultados = []
    sem_general = asyncio.Semaphore(12)
    sem_farmatodo = asyncio.Semaphore(1)

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--disable-dev-shm-usage",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-blink-features=AutomationControlled",
            ]
        )

        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
            locale="es-VE",
            timezone_id="America/Caracas"
        )

        await context.route("**/*", block_unnecessary_resources)

        async def execute_task(fila, idx):
            cadena = fila.get("cadena", "").strip()
            url = fila.get("url", "").strip()
            marca = fila.get("marca", "").strip()
            id_prod = fila.get("id_producto_propio", "").strip()

            page = await context.new_page()
            if not url:
                res = {
                    "url": "", "marca": marca, "nombre": None,
                    "precio_full_bs": None, "precio_desc_bs": None,
                    "precio_full_usd": None, "precio_desc_usd": None,
                    "tipo_promo": None, "porcentaje_descuento": None, "promo_condicionada": False,
                    "metodo_extraccion": None, "tiene_descuento": False,
                    "scraped_at": datetime.now(timezone.utc).isoformat(),
                    "error": "URL vacia"
                }
            else:
                await asyncio.sleep(random.uniform(0.1, 0.3))
                res = await scrape_url_async(page, url, marca, bcv_rate, task_id=f"{idx}")

            res["id_producto_propio"] = id_prod
            res["cadena"] = cadena
            res["tipo"] = fila.get("tipo", "")
            res["laboratorio"] = fila.get("laboratorio", "")
            res["concentracion"] = fila.get("concentracion", "")
            res["tamano"] = fila.get("tamano", "")
            res["activo"] = fila.get("activo", True)
            res["_doc_id"] = fila.get("_doc_id")
            res["publicacion_id"] = fila.get("publicacion_id")

            await page.close()

            if res.get("error"):
                print(f"[{idx}/{len(filas_procesar)}] ❌ [{cadena}] {marca} - {res['error']}", flush=True)
            else:
                status = f"Bs {res['precio_full_bs']:,.2f}"
                if res.get('tiene_descuento'):
                    cond_tag = " [CONDICIONADA]" if res.get('promo_condicionada') else ""
                    status += f" -> Oferta: Bs {res['precio_desc_bs']:,.2f} ({res.get('tipo_promo') or (str(res.get('porcentaje_descuento')) + '%')}){cond_tag} [{res.get('metodo_extraccion')}]"
                elif res.get('metodo_extraccion') == "promo_no_resuelta":
                    status += f" (Promo no resuelta: '{res.get('tipo_promo')}') [promo_no_resuelta]"
                else:
                    status += f" [{res.get('metodo_extraccion')}]"
                print(f"[{idx}/{len(filas_procesar)}] ✅ [{cadena}] {marca} ({id_prod}): {status}", flush=True)

            return res

        async def worker(fila, idx):
            cadena = fila.get("cadena", "").strip()
            url = fila.get("url", "").strip()
            is_ft = "farmatodo" in cadena.lower() or "farmatodo" in url.lower()

            if is_ft:
                async with sem_farmatodo:
                    async with sem_general:
                        return await execute_task(fila, idx)
            else:
                async with sem_general:
                    return await execute_task(fila, idx)

        tasks = [worker(fila, i + 1) for i, fila in enumerate(filas_procesar)]
        resultados = await asyncio.gather(*tasks)

        await context.close()
        await browser.close()

    duracion = time.time() - inicio
    ok_count = sum(1 for r in resultados if not r.get("error"))

    # Telemetría de métodos de extracción, promociones y descartes
    stats_metodo = {}
    ft_total = 0
    ft_api = 0
    descartados_no_asociados = 0
    promos_no_resueltas = []

    for r in resultados:
        if r.get("descarte_motivo") == "no_asociado_a_producto":
            descartados_no_asociados += 1

        if not r.get("error"):
            m = r.get("metodo_extraccion") or "sin_metodo"
            stats_metodo[m] = stats_metodo.get(m, 0) + 1

            is_ft_prod = "farmatodo" in (r.get("cadena") or "").lower() or "farmatodo" in (r.get("url") or "").lower()
            if is_ft_prod:
                ft_total += 1
                if m == "api":
                    ft_api += 1

            if m == "promo_no_resuelta":
                promos_no_resueltas.append(f"{r.get('cadena')} ({r.get('marca')}): '{r.get('tipo_promo')}'")

    print("\n" + "=" * 60)
    print(f"COMPLETADO en {duracion:.1f}s ({duracion/60:.1f} min) | Éxito: {ok_count}/{len(resultados)} OK")
    print("\n📊 TELEMETRÍA DE EXTRACCIÓN:")
    for met, count in sorted(stats_metodo.items()):
        print(f"  • {met}: {count} productos ({count/max(ok_count,1)*100:.1f}%)")

    if descartados_no_asociados > 0:
        print(f"  • Descartados por no poder asociarse al ID de producto: {descartados_no_asociados}")

    if ft_total > 0 and ft_api == 0:
        print("\n⚠️  ADVERTENCIA TELEMETRÍA [Farmatodo]: 0 productos resueltos por vía 'api'. Verificar si los endpoints JSON de Farmatodo han cambiado su estructura o encabezados.")

    if promos_no_resueltas:
        print("\n🔍 PROMOCIONES NO RESUELTAS (Para análisis y nuevos patrones):")
        for p in promos_no_resueltas[:10]:
            print(f"  - {p}")

    repetidos = marcar_precios_repetidos(resultados)
    if repetidos:
        print(f"\n⚠️  PRECIO REPETIDO: {repetidos} lecturas con el mismo precio exacto que otros productos de la misma tienda. Se guardan como dudosas (Revisión de capturas).")

    print(f"\nResultados guardados localmente en: {OUT_PATH}")
    print("=" * 60 + "\n")

    OUT_PATH.write_text(json.dumps(resultados, ensure_ascii=False, indent=2), encoding="utf-8")


MIN_REPETIDOS = 3


def marcar_precios_repetidos(resultados: list) -> int:
    """Si 3 o mas enlaces DISTINTOS de la misma tienda leen el mismo precio al
    centavo en una corrida, casi seguro el robot tomo un monto que se repite
    en todas las paginas (envio, carrito, banner) y no el del producto. Esas
    lecturas se marcan sospecha='precio_repetido': se guardan como dudosas y
    no entran en los calculos hasta revisarlas. Farmatodo no se marca: se lee
    anclado al ID del producto. Devuelve cuantas se marcaron."""
    grupos: dict = {}
    for r in resultados:
        url = (r.get("url") or "").lower()
        precio = r.get("precio_full_bs")
        if r.get("error") or not precio or "farmatodo" in url:
            continue
        dominio = re.sub(r"^https?://(www\.)?", "", url).split("/")[0]
        grupos.setdefault((dominio, round(float(precio), 2)), []).append(r)
    marcadas = 0
    for (dominio, precio), lista in grupos.items():
        urls = {re.sub(r"[?#].*$", "", (r.get("url") or "").lower()) for r in lista}
        nombres = {(r.get("marca") or r.get("nombre") or "").strip().lower() for r in lista}
        if len(urls) >= MIN_REPETIDOS and len(nombres) >= 2:
            print(f"   • {dominio}: {len(urls)} enlaces con Bs {precio}", flush=True)
            for r in lista:
                r["sospecha"] = "precio_repetido"
                marcadas += 1
    return marcadas


def main():
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        print("\nScraper cancelado por el usuario.")
        sys.exit(0)


if __name__ == "__main__":
    main()
