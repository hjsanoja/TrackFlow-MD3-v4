# Scraper de Competencia (Farmatodo, Locatel, Farmacias SAAS, etc.) - Version 6.1 Async Multi-Dominio
#
# Arquitectura y Mejoras Integradas:
# 1. Concurrencia Adaptativa por Dominio & Control Anti-429 para Farmatodo:
#    - Límite global (MAX_GLOBAL_CONCURRENCY=12) y límite por dominio (MAX_PER_DOMAIN_CONCURRENCY=3).
#    - Concurrencia específica baja para Farmatodo (FARMATODO_CONCURRENCY=1) con pausas previas aleatorias para prevenir HTTP 429.
# 2. Entrelazado Round-Robin por Cadena:
#    - Rotación de tiendas (Farmatodo -> Locatel -> SAAS -> Farmatodo) para espaciar
#      las peticiones de forma natural a miles de productos.
# 3. Motor de Extracción Universal O(1):
#    - Compatible con Next.js (__NEXT_DATA__ / bsPrice), VTEX (__STATE__ / cm), Schema.org JSON-LD y DOM.
# 4. Bloqueo Inteligente de Red y Headers Anti-Bot:
#    - Cancela recursos pesados (imágenes, fuentes, video, analítica) e inyecta headers de navegador real (Chrome 124, sec-ch-ua).
# 5. Obtención única de Tasa BCV al inicio para cero redundancia.

import asyncio
import csv
import io
import json
import os
import re
import sys
import time
import random
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeout

PROJECT_ROOT = Path(__file__).parent.parent if "__file__" in globals() else Path.cwd()
CSV_PATH = PROJECT_ROOT / "productos_competencia.csv"
RESULTS_PATH = PROJECT_ROOT / "resultados.json"

# Configuración de concurrencia adaptativa por dominio para escalar a miles de links
MAX_GLOBAL_CONCURRENCY = int(os.environ.get("MAX_GLOBAL_CONCURRENCY", "12"))
MAX_PER_DOMAIN_CONCURRENCY = int(os.environ.get("MAX_PER_DOMAIN_CONCURRENCY", "3"))
FARMATODO_CONCURRENCY = int(os.environ.get("FARMATODO_CONCURRENCY", "1"))  # Farmatodo requiere baja concurrencia para evitar HTTP 429


def read_text_robust(path: Path) -> str:
    """Lee un archivo local probando diferentes codificaciones de texto."""
    raw = path.read_bytes()
    for encoding in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise RuntimeError("No se pudo decodificar el archivo: " + path.name)


def parse_price(text: str):
    """Limpia y convierte cadenas de texto numéricas en formato de moneda (Bs)."""
    if not text:
        return None
    cleaned = str(text).replace("Bs.", "").replace("Bs", "").replace("VES", "").strip()
    cleaned = re.sub(r"[^\d.,]", "", cleaned)
    if not cleaned:
        return None
    
    if "," in cleaned:
        # Formato venezolano/hispano: punto para miles, coma para decimales
        cleaned = cleaned.replace(".", "").replace(",", ".")
    else:
        # Formato estándar con punto decimal
        if cleaned.count(".") == 1:
            parts = cleaned.split(".")
            if len(parts[1]) == 3:  # Formato de miles sin decimales
                cleaned = cleaned.replace(".", "")
        elif cleaned.count(".") > 1:
            cleaned = cleaned.replace(".", "")
            
    try:
        val = float(cleaned)
        return val if val > 0 else None
    except ValueError:
        return None


def parse_price_usd(text: str):
    """Extrae montos numéricos limpios etiquetados en divisas USD/Ref."""
    if not text:
        return None
    cleaned = str(text).replace("Ref.", "").replace("Ref", "").replace("$", "").replace("USD", "").replace(":", "").strip()
    cleaned = re.sub(r"[^\d.,]", "", cleaned)
    if not cleaned:
        return None
    if "," in cleaned:
        cleaned = cleaned.replace(".", "").replace(",", ".")
    try:
        val = float(cleaned)
        return val if val > 0 else None
    except ValueError:
        return None


def is_usd_text(text: str) -> bool:
    """Detecta si un texto contiene indicadores de precio en dólares."""
    if not text:
        return False
    t = str(text).lower()
    return "ref" in t or "$" in t or "usd" in t or "divisa" in t


def fetch_bcv_rate_once() -> float:
    """
    Obtiene la tasa oficial del BCV una sola vez al inicio del programa.
    Consulta Supabase primeramente, luego Firestore, luego DolarAPI.
    """
    print("[BCV] Cargando tasa oficial...", flush=True)
    
    # 1. Intentar cargar desde Supabase
    try:
        from supabase_client import is_supabase_configured, select
        if is_supabase_configured():
            res = select("bcv_rates", "order=updated_at.desc&limit=1")
            if res and len(res) > 0 and res[0].get("value"):
                rate = float(res[0]["value"])
                print(f"[BCV] Tasa cargada desde Supabase: Bs {rate:,.2f}", flush=True)
                return rate
    except Exception as e:
        print(f"[BCV] Aviso Supabase: {e}", flush=True)

    # 2. Intentar cargar desde Firestore
    try:
        from firebase_client import get_db
        db = get_db()
        docs = list(db.collection("bcv_rates").order_by("updated_at", direction="DESCENDING").limit(1).stream())
        if docs:
            rate = float(docs[0].to_dict().get("value"))
            print(f"[BCV] Tasa cargada desde Firestore: Bs {rate:,.2f}", flush=True)
            return rate
    except Exception as e:
        print(f"[BCV] Aviso Firestore: {e}", flush=True)

    # 3. Fallback a DolarAPI
    try:
        url = "https://ve.dolarapi.com/v1/dolares/oficial"
        req = urllib.request.Request(url, headers={"User-Agent": "TrackFlow/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode())
            rate = data.get("promedio") or data.get("price")
            if rate:
                rate = float(rate)
                print(f"[BCV] Tasa obtenida desde DolarAPI: Bs {rate:,.2f}", flush=True)
                return rate
    except Exception as e:
        print(f"[BCV] Aviso DolarAPI: {e}", flush=True)

    fallback = 744.23
    print(f"[BCV] Usando tasa de seguridad por defecto: Bs {fallback:,.2f}", flush=True)
    return fallback


def cargar_filas_de_db():
    """Lee productos_competencia desde Supabase o Firestore."""
    # 1. Probar Supabase
    try:
        from supabase_client import is_supabase_configured, select
        if is_supabase_configured():
            filas = select("productos_competencia", "select=*")
            if filas:
                for f in filas:
                    f["_doc_id"] = str(f.get("id") or f.get("_doc_id") or "")
                print(f"Cargadas {len(filas)} filas desde Supabase", flush=True)
                return filas
    except Exception as e:
        print(f"No se pudo cargar desde Supabase: {e}", flush=True)

    # 2. Probar Firestore
    try:
        from firebase_client import get_db
        db = get_db()
        snap = db.collection("productos_competencia").stream()
        filas = []
        for doc in snap:
            data = doc.to_dict()
            data["_doc_id"] = doc.id
            filas.append(data)
        print(f"Cargadas {len(filas)} filas desde Firestore", flush=True)
        return filas
    except Exception as e:
        print(f"No se pudo cargar desde Firestore: {e}", flush=True)
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


# Rate limiting per domain to prevent HTTP 403/429
LAST_REQUEST_TIME = {}
DOMAIN_MIN_DELAY = {
    "farmatodo": 7.0,  # 7 seconds minimum between Farmatodo requests
    "locatel": 2.0,
    "saas": 2.0,
    "farmaciasaas": 2.0,
    "default": 1.5
}

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
        sleep_time = min_delay - elapsed
        sleep_time += random.uniform(0.1, 0.5)
        await asyncio.sleep(sleep_time)
        
    LAST_REQUEST_TIME[domain] = time.time()


def interleave_filas_por_producto(filas: list) -> list:
    """
    Agrupa las filas por id_producto_propio y las ordena por producto para que el scraper
    procese los enlaces de un mismo producto en secuencia rotando de cadena en cadena.
    Ejemplo: Producto A (Farmatodo) -> Producto A (Locatel) -> Producto A (SAAS) -> Producto B (Farmatodo)...
    Esto rota de forma natural los dominios y espacia las peticiones por dominio.
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
        # Ordenamos las filas de este producto por cadena (farmatodo, locatel, saas) de forma consistente
        filas_prod_ordenadas = sorted(filas_prod, key=lambda x: str(x.get("cadena", "")).lower())
        interleaved.extend(filas_prod_ordenadas)

    print(f"[Optimizador] Entrelazadas {len(interleaved)} URLs agrupadas por producto ({len(pids_ordenados)} productos únicos)", flush=True)
    return interleaved


async def block_unnecessary_resources(route):
    """
    Bloqueador inteligente de red:
    Cancela recursos pesados (imágenes, video, fuentes, analíticas) para maximizar la velocidad.
    Permite CSS/JS necesarios para hidratación VTEX/React.
    """
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


async def extract_product_data_from_page(page, url: str, bcv_rate: float) -> dict:
    """
    Motor universal de extracción de e-commerce.
    Soporta Next.js (__NEXT_DATA__), VTEX (__STATE__ / commertialOffer)
    y Schema.org JSON-LD con extracción complementaria del DOM.
    """
    return await page.evaluate(r"""
        () => {
            const bodyText = document.body ? document.body.innerText || '' : '';
            const title = document.title || '';

            // 1. Detectar bloqueos de seguridad anti-bot
            if (title.includes('Cloudflare') || title.includes('Just a moment') || 
                bodyText.includes('Checking your browser') || bodyText.includes('Access Denied') ||
                bodyText.includes('Too Many Requests') || title.includes('429')) {
                return { error: "HTTP 429" };
            }

            // 2. Detectar páginas no encontradas o agotadas
            if (title.includes('404') || bodyText.includes('Producto no disponible') || 
                bodyText.includes('No pudimos encontrar') || bodyText.includes('no encontrado')) {
                return { error: "Producto no disponible o enlace roto (404 / Agotado)." };
            }

            let nombre = null;
            let active_price = null;
            let original_price = null;

            // 3. ESTRATEGIA A: Next.js __NEXT_DATA__ (Farmatodo)
            const nextDataEl = document.querySelector('script#__NEXT_DATA__');
            if (nextDataEl) {
                try {
                    const json = JSON.parse(nextDataEl.textContent || '{}');
                    const pageProps = json?.props?.pageProps;
                    
                    const findProduct = (obj, depth = 0) => {
                        if (!obj || depth > 6) return null;
                        if (obj.product && typeof obj.product === 'object' && (obj.product.price || obj.product.name || obj.product.bsPrice)) return obj.product;
                        if (obj.productDetail && typeof obj.productDetail === 'object') return obj.productDetail;
                        if (obj.productData && typeof obj.productData === 'object') return obj.productData;
                        
                        for (const k in obj) {
                            if (k === 'product' || k === 'productDetail' || k === 'productData') {
                                if (obj[k] && typeof obj[k] === 'object') return obj[k];
                            }
                            if (typeof obj[k] === 'object' && obj[k] !== null && !Array.isArray(obj[k])) {
                                const res = findProduct(obj[k], depth + 1);
                                if (res) return res;
                            }
                        }
                        return null;
                    };

                    const product = findProduct(pageProps) || pageProps?.initialState?.product?.productDetail;
                    if (product) {
                        nombre = product.name || product.description || product.title || product.productName;
                        
                        // Extraer precios específicos de Farmatodo
                        const pBs = parseFloat(product.bsPrice || product.precioBs || product.priceBs);
                        const p1 = parseFloat(product.price);
                        const p2 = parseFloat(product.originalPrice || product.regularPrice || product.listPrice || product.fullPrice || product.normalPrice || product.basePrice);
                        const p3 = parseFloat(product.priceOffer || product.offerPrice || product.priceWithOffer || product.discountPrice || product.salePrice);

                        // Si Farmatodo expone el precio en Bs directo
                        if (pBs && pBs > 0) {
                            active_price = pBs;
                        } else if (p3 && p3 > 0) {
                            active_price = p3;
                            if (p1 && p1 > p3) original_price = p1;
                            if (p2 && p2 > p3) original_price = p2;
                        } else if (p1 && p1 > 0) {
                            active_price = p1;
                            if (p2 && p2 > p1) original_price = p2;
                        } else if (p2 && p2 > 0) {
                            active_price = p2;
                        }
                    }
                } catch(e) {}
            }

            // 4. ESTRATEGIA B: VTEX __STATE__ (Locatel, Farmacias SAAS)
            if (window.__STATE__) {
                try {
                    const state = window.__STATE__;
                    for (const k in state) {
                        if (k.includes('Product:') || k.includes('Item:') || k.includes('commertialOffer')) {
                            const item = state[k];
                            if (!nombre && item.productName) nombre = item.productName;
                            
                            const comm = item.commertialOffer || (item.sellers && item.sellers[0] && item.sellers[0].commertialOffer);
                            if (comm) {
                                if (comm.Price && parseFloat(comm.Price) > 0) {
                                    active_price = parseFloat(comm.Price);
                                }
                                if (comm.ListPrice && parseFloat(comm.ListPrice) > 0) {
                                    original_price = parseFloat(comm.ListPrice);
                                } else if (comm.PriceWithoutDiscount && parseFloat(comm.PriceWithoutDiscount) > 0) {
                                    original_price = parseFloat(comm.PriceWithoutDiscount);
                                }
                                if (active_price) break;
                            }
                        }
                    }
                } catch(e) {}
            }

            // 5. ESTRATEGIA C: Schema.org JSON-LD
            if (!active_price || !original_price) {
                const jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
                for (const script of jsonLdScripts) {
                    try {
                        const parsed = JSON.parse(script.textContent || '');
                        const items = Array.isArray(parsed) ? parsed : [parsed];
                        for (const item of items) {
                            if (item['@type'] === 'Product' || item.offers) {
                                if (!nombre && item.name) nombre = item.name;
                                const offers = Array.isArray(item.offers) ? item.offers : [item.offers];
                                for (const offer of offers) {
                                    if (!offer) continue;
                                    if (offer.price && !active_price) active_price = parseFloat(offer.price);
                                    if (offer.highPrice && parseFloat(offer.highPrice) > 0) {
                                        const hp = parseFloat(offer.highPrice);
                                        if (!original_price || hp > original_price) original_price = hp;
                                    }
                                }
                            }
                        }
                    } catch(e) {}
                }
            }

            // 6. ESTRATEGIA D: DOM EXTRACTION
            const h1El = document.querySelector('h1');
            if (!nombre) {
                nombre = h1El ? (h1El.innerText || h1El.textContent || '').trim() : document.title.split('|')[0].trim();
            }

            let dom_bs_active_text = '';
            let dom_bs_original_text = '';
            let dom_usd_active_text = '';
            let dom_usd_original_text = '';
            let dom_active_text = '';
            let dom_original_text = '';

            // A. Buscar precios tachados en DOM (originales)
            const origEls = document.querySelectorAll(
                'del, s, strike, .line-through, [class*="line-through"], ' +
                '[class*="price--original"], [class*="original-price"], [class*="originalPrice"], ' +
                '[class*="listPrice"], [class*="list-price"], [class*="oldPrice"], [class*="old-price"], ' +
                '[class*="was-price"], [class*="before-price"], [class*="precio-anterior"], [class*="strikethrough"]'
            );
            for (const el of origEls) {
                const txt = (el.innerText || el.textContent || '').trim();
                if (txt && !/tableta|unidad\s+a|c\/u|dosis|%\s*OFF|ahorra/i.test(txt) && /\d/.test(txt)) {
                    const lower = txt.toLowerCase();
                    const isUsd = lower.includes('ref') || lower.includes('usd') || lower.includes('$');
                    const hasBs = lower.includes('bs') || lower.includes('ves');
                    
                    if (hasBs && !isUsd) {
                        if (!dom_bs_original_text) dom_bs_original_text = txt;
                    } else if (isUsd) {
                        if (!dom_usd_original_text) dom_usd_original_text = txt;
                    } else {
                        if (!dom_original_text) dom_original_text = txt;
                    }
                }
            }

            // B. Buscar precio activo principal en DOM
            const activeEls = document.querySelectorAll(
                '.product-purchase__price--active, [class*="price--active"], .product-purchase__price, ' +
                '[class*="sellingPrice"], [class*="bestPrice"], [class*="best-price"], [class*="offer-price"], ' +
                '[class*="product-price"], [class*="vtex-product-price"], [class*="current-price"]'
            );
            for (const el of activeEls) {
                if (!el.matches('del, s, strike, .line-through, [class*="original"], [class*="old"], [class*="listPrice"]')) {
                    const txt = (el.innerText || el.textContent || '').trim();
                    if (txt && !/tableta|unidad\s+a|c\/u|dosis|%\s*OFF/i.test(txt) && /\d/.test(txt)) {
                        const lower = txt.toLowerCase();
                        const isUsd = lower.includes('ref') || lower.includes('usd') || lower.includes('$');
                        const hasBs = lower.includes('bs') || lower.includes('ves');
                        
                        if (hasBs && !isUsd) {
                            if (!dom_bs_active_text) dom_bs_active_text = txt;
                        } else if (isUsd) {
                            if (!dom_usd_active_text) dom_usd_active_text = txt;
                        } else {
                            if (!dom_active_text) dom_active_text = txt;
                        }
                    }
                }
            }

            return {
                nombre: nombre,
                active_price_direct: active_price,
                original_price_direct: original_price,
                dom_bs_active_text: dom_bs_active_text,
                dom_bs_original_text: dom_bs_original_text,
                dom_usd_active_text: dom_usd_active_text,
                dom_usd_original_text: dom_usd_original_text,
                dom_active_text: dom_active_text,
                dom_original_text: dom_original_text
            };
        }
    """)


async def scrape_url_async(page, url: str, marca: str, bcv_rate: float, task_id: str = "1") -> dict:
    """Ejecuta el ciclo de scraping de una URL con reintentos y retroceso exponencial."""
    intentos = 3
    is_farmatodo = "farmatodo" in url.lower()
    
    result = {
        "url": url,
        "marca": marca,
        "nombre": None,
        "precio_full_bs": None,
        "precio_desc_bs": None,
        "tiene_descuento": False,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "error": None,
    }

    for int_num in range(1, intentos + 1):
        result["error"] = None
        result["precio_full_bs"] = None
        result["precio_desc_bs"] = None
        result["tiene_descuento"] = False

        # Wait for domain rate limit to be respected (e.g. 7s minimum for Farmatodo)
        await wait_for_domain_rate_limit(url)

        try:
            timeout = 22000 + (int_num - 1) * 8000
            response = await page.goto(url, wait_until="domcontentloaded", timeout=timeout)

            if response and response.status >= 400:
                result["error"] = f"HTTP {response.status}"
                if response.status == 404:
                    result["error"] = "Producto no disponible o enlace roto (404 / Agotado)."
                    return result
                if response.status in (429, 403, 500, 502, 503):
                    backoff = (6 * int_num) + random.uniform(2.5, 6.0)
                    print(f"   [{task_id}] ⚠️ HTTP {response.status} en {url[:40]}... Esperando {backoff:.1f}s (Intento {int_num}/{intentos})", flush=True)
                    await asyncio.sleep(backoff)
                    continue
                await asyncio.sleep(1.5)
                continue

        except PlaywrightTimeout:
            result["error"] = "Timeout cargando la página"
            await asyncio.sleep(2)
            continue
        except Exception as e:
            result["error"] = f"Error de red/carga: {type(e).__name__}"
            await asyncio.sleep(2)
            continue

        await asyncio.sleep(0.5)
        data = await extract_product_data_from_page(page, url, bcv_rate)

        if data.get("error"):
            result["error"] = data["error"]
            if "HTTP 429" in data["error"]:
                backoff = (7 * int_num) + random.uniform(3.0, 5.0)
                print(f"   [{task_id}] ⚠️ Detectado bloqueo HTTP 429 en DOM. Esperando {backoff:.1f}s", flush=True)
                await asyncio.sleep(backoff)
                continue
            if "404" in data["error"] or "disponible" in data["error"]:
                return result
            await asyncio.sleep(1.5)
            continue

        result["nombre"] = data.get("nombre")

        # 1. Candidatos directos de JSON/DataLayers
        p_act_direct = data.get("active_price_direct")
        p_orig_direct = data.get("original_price_direct")

        # 2. Candidatos del DOM (Bolívares directos)
        p_bs_active_dom = parse_price(data.get("dom_bs_active_text"))
        p_bs_orig_dom = parse_price(data.get("dom_bs_original_text"))

        # 3. Candidatos del DOM (USD directos)
        p_usd_active_dom = parse_price_usd(data.get("dom_usd_active_text"))
        p_usd_orig_dom = parse_price_usd(data.get("dom_usd_original_text"))

        # 4. Candidatos del DOM (Fallback sin moneda explícita)
        p_fallback_active_dom = parse_price(data.get("dom_active_text"))
        p_fallback_orig_dom = parse_price(data.get("dom_original_text"))

        # Convertir cualquier precio detectado en USD a Bolívares
        p_usd_active_in_bs = round(p_usd_active_dom * bcv_rate, 2) if p_usd_active_dom else None
        p_usd_orig_in_bs = round(p_usd_orig_dom * bcv_rate, 2) if p_usd_orig_dom else None

        # Si los precios directos de VTEX/NextJS parecen estar en USD (ej: < 120.0 en SAAS o Locatel)
        # convertirlos a Bolívares usando la tasa BCV
        is_saas_or_locatel = any(x in url.lower() for x in ("saas", "locatel", "farmaciasaas"))
        
        if p_act_direct and is_saas_or_locatel and p_act_direct < 120.0:
            p_act_direct = round(p_act_direct * bcv_rate, 2)
            
        if p_orig_direct and is_saas_or_locatel and p_orig_direct < 120.0:
            p_orig_direct = round(p_orig_direct * bcv_rate, 2)

        # Selección inteligente del precio ACTIVO (Bolívares)
        final_active_bs = None
        if p_bs_active_dom:
            final_active_bs = p_bs_active_dom
        elif p_usd_active_in_bs:
            final_active_bs = p_usd_active_in_bs
        elif p_act_direct:
            final_active_bs = p_act_direct
        elif p_fallback_active_dom:
            final_active_bs = p_fallback_active_dom

        # Selección inteligente del precio ORIGINAL (Bolívares)
        final_original_bs = None
        if p_bs_orig_dom:
            final_original_bs = p_bs_orig_dom
        elif p_usd_orig_in_bs:
            final_original_bs = p_usd_orig_in_bs
        elif p_orig_direct:
            final_original_bs = p_orig_direct
        elif p_fallback_orig_dom:
            final_original_bs = p_fallback_orig_dom

        precio_full = None
        precio_desc = None
        tiene_descuento = False

        if final_original_bs and final_active_bs:
            if final_original_bs > final_active_bs and (final_original_bs - final_active_bs) > 0.1:
                precio_full = final_original_bs
                precio_desc = final_active_bs
                tiene_descuento = True
            elif final_active_bs > final_original_bs and (final_active_bs - final_original_bs) > 0.1:
                # Si vinieron invertidos, los corregimos
                precio_full = final_active_bs
                precio_desc = final_original_bs
                tiene_descuento = True
            else:
                precio_full = final_active_bs
        elif final_active_bs:
            precio_full = final_active_bs
        elif final_original_bs:
            precio_full = final_original_bs

        if precio_full:
            result["precio_full_bs"] = round(precio_full, 2)
            result["precio_desc_bs"] = round(precio_desc, 2) if precio_desc else None
            result["tiene_descuento"] = tiene_descuento
            break
        else:
            result["error"] = "Precio no encontrado en la estructura de la página."
            await asyncio.sleep(1)

    return result


async def main_async():
    inicio = time.time()

    # 1. Cargar Tasa Oficial BCV una sola vez
    bcv_rate = fetch_bcv_rate_once()

    # 2. Cargar lista de productos desde Supabase/Firestore o CSV local
    filas_todas = cargar_filas_de_db() or cargar_filas_de_csv()
    if not filas_todas:
        print("ERROR: No se encontraron filas de productos para procesar.")
        sys.exit(1)

    # 3. Filtrar enlaces activos
    only_prod = os.environ.get("ONLY_PRODUCT_ID")
    only_doc = os.environ.get("ONLY_DOC_ID")

    filas_activas = []
    for fila in filas_todas:
        activo = fila.get("activo")
        es_activa = activo if isinstance(activo, bool) else str(activo).strip().lower() in ("si", "sí", "true", "1", "yes")

        if not es_activa:
            continue

        if only_doc and str(fila.get("_doc_id")).strip() != only_doc.strip():
            continue

        if only_prod and str(fila.get("id_producto_propio")).strip() != only_prod.strip():
            continue

        filas_activas.append(fila)

    if not filas_activas:
        print("No hay enlaces de productos activos para procesar.")
        sys.exit(0)

    # 4. Entrelazar filas por producto para procesar enlace por enlace de cada competidor rotando cadenas de forma natural
    filas_procesar = interleave_filas_por_producto(filas_activas)

    # 5. Crear semáforos de concurrencia globales y por dominio
    # Farmatodo usa concurrencia reducida (FARMATODO_CONCURRENCY=1) para prevenir HTTP 429
    global_semaphore = asyncio.Semaphore(MAX_GLOBAL_CONCURRENCY)
    domain_semaphores = {
        "farmatodo": asyncio.Semaphore(FARMATODO_CONCURRENCY),
        "locatel": asyncio.Semaphore(MAX_PER_DOMAIN_CONCURRENCY),
        "farmaciasaas": asyncio.Semaphore(MAX_PER_DOMAIN_CONCURRENCY),
        "saas": asyncio.Semaphore(MAX_PER_DOMAIN_CONCURRENCY),
        "default": asyncio.Semaphore(MAX_PER_DOMAIN_CONCURRENCY)
    }

    def get_domain_semaphore(cadena_str: str):
        cad = str(cadena_str).lower()
        for k in domain_semaphores:
            if k in cad:
                return domain_semaphores[k]
        return domain_semaphores["default"]

    print(f"\nIniciando scraping de {len(filas_procesar)} URLs (Concurrencia Máx: {MAX_GLOBAL_CONCURRENCY}, Farmatodo Concurrencia: {FARMATODO_CONCURRENCY})...\n", flush=True)

    # 6. Lanzar un único navegador Chromium con opciones anti-detección
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-setuid-sandbox"
            ]
        )
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1366, "height": 768},
            locale="es-VE",
            extra_http_headers={
                "Accept-Language": "es-VE,es;q=0.9,en-US;q=0.8,en;q=0.7",
                "Sec-Ch-Ua": '"Not-A.Brand";v="99", "Chromium";v="124", "Google Chrome";v="124"',
                "Sec-Ch-Ua-Mobile": "?0",
                "Sec-Ch-Ua-Platform": '"Windows"',
            }
        )
        await context.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined});")

        async def worker(idx, fila):
            cadena = str(fila.get("cadena", "Farmatodo")).strip()
            dom_sem = get_domain_semaphore(cadena)

            async with global_semaphore:
                async with dom_sem:
                    page = await context.new_page()
                    await page.route("**/*", block_unnecessary_resources)

                    marca = str(fila.get("marca", "")).strip() or "?"
                    url = str(fila.get("url", "")).strip()
                    id_prod = str(fila.get("id_producto_propio", "")).strip()

                    if not url:
                        res = {
                            "url": "", "marca": marca, "nombre": None,
                            "precio_full_bs": None, "precio_desc_bs": None,
                            "tiene_descuento": False, "scraped_at": datetime.now(timezone.utc).isoformat(),
                            "error": "URL vacia"
                        }
                    else:
                        await asyncio.sleep(random.uniform(0.1, 0.4))
                        res = await scrape_url_async(page, url, marca, bcv_rate, task_id=f"{idx}")

                    res["id_producto_propio"] = id_prod
                    res["cadena"] = cadena
                    res["tipo"] = fila.get("tipo", "")
                    res["laboratorio"] = fila.get("laboratorio", "")
                    res["_doc_id"] = fila.get("_doc_id")

                    await page.close()

                    if res.get("error"):
                        print(f"[{idx}/{len(filas_procesar)}] ❌ [{cadena}] {marca} - {res['error']}", flush=True)
                    else:
                        status = f"Bs {res['precio_full_bs']:,.2f}"
                        if res['tiene_descuento']:
                            status += f" -> Bs {res['precio_desc_bs']:,.2f}"
                        print(f"[{idx}/{len(filas_procesar)}] ✅ [{cadena}] {marca} ({id_prod}): {status}", flush=True)

                    return res

        tasks = [worker(i + 1, fila) for i, fila in enumerate(filas_procesar)]
        resultados = await asyncio.gather(*tasks)

        await browser.close()

    # 7. Guardar resultados localmente
    with open(RESULTS_PATH, "w", encoding="utf-8") as f:
        json.dump(resultados, f, ensure_ascii=False, indent=2, default=str)

    duracion = time.time() - inicio
    ok_count = sum(1 for r in resultados if not r.get("error"))
    print("\n" + "=" * 60)
    print(f"COMPLETADO en {duracion:.1f}s ({duracion/60:.1f} min) | Éxito: {ok_count}/{len(resultados)} OK")
    print(f"Resultados guardados localmente en: {RESULTS_PATH}")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main_async())
