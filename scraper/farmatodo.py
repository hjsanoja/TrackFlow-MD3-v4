"""
TrackFlow Scraper - Motor de Monitoreo de Precios Farmacéuticos (Venezuela)
Soporta: Farmatodo, Locatel, FarmaDON, Grupo San Ignacio, Farmacias Xana y FarmaGo.
Ejecución: GitHub Actions & Local (Playwright Async + Python).
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
    Evita falsos positivos con precios unitarios ('Unidades a...').
    """
    if not text:
        return None
    str_val = str(text).strip()
    if not str_val:
        return None

    # Limpiar prefijos de moneda y espacios especiales
    cleaned = re.sub(r'(?i)\b(?:bs\.?s?|ves|bolivares?)\b', '', str_val)
    cleaned = cleaned.replace('\xa0', ' ').replace('\u202f', ' ').strip()

    # Si contiene coma decimal (formato estándar venezolano: 18.655,00)
    if ',' in cleaned:
        cleaned = cleaned.replace('.', '').replace(',', '.')
    else:
        # Si contiene puntos, verificar si es separador de miles o decimal
        dots = cleaned.count('.')
        if dots == 1:
            parts = cleaned.split('.')
            if len(parts[1]) == 3:  # Ej: 18.655 -> miles
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


def parse_price_usd(text) -> float | None:
    """Convierte texto con formato de dólares ($ / USD / REF) a float."""
    if not text:
        return None
    str_val = str(text).strip()
    if not str_val:
        return None

    cleaned = re.sub(r'(?i)\b(?:usd|\$|ref|dolares?)\b', '', str_val)
    cleaned = cleaned.replace('\xa0', ' ').replace('\u202f', ' ').strip()

    if ',' in cleaned and '.' in cleaned:
        if cleaned.find(',') < cleaned.find('.'):
            cleaned = cleaned.replace(',', '')
        else:
            cleaned = cleaned.replace('.', '').replace(',', '.')
    elif ',' in cleaned:
        cleaned = cleaned.replace(',', '.')

    match = re.search(r'\d+(?:\.\d+)?', cleaned)
    if not match:
        return None
    try:
        val = float(match.group())
        return round(val, 2) if val > 0.01 else None
    except ValueError:
        return None


async def get_bcv_rate() -> float:
    """Obtiene la tasa oficial BCV desde Supabase, Firestore o API externa."""
    fallback = 775.34
    print("[BCV] Cargando tasa oficial...", flush=True)

    # 1. Supabase
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

    # 2. Firestore
    try:
        from firebase_client import get_db
        db = get_db()
        doc_snap = db.collection("bcv_rates").order_by("updated_at", direction="DESCENDING").limit(1).get()
        if doc_snap and len(doc_snap) > 0:
            data = doc_snap[0].to_dict()
            val = float(data.get("value") or data.get("valor") or 0)
            if val > 10.0:
                print(f"[BCV] Tasa cargada desde Firestore: Bs {val:,.2f}", flush=True)
                return val
    except Exception as e:
        print(f"[BCV] Firestore no disponible ({e})", flush=True)

    # 3. API Externa pydolarve / bcv
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
    """Lee productos_competencia desde Supabase o Firestore."""
    # 1. Supabase
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

    # 2. Firestore
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


# Rate limiting por dominio para prevenir 403 / 429
LAST_REQUEST_TIME = {}
DOMAIN_MIN_DELAY = {
    "farmatodo": 6.0,
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
        sleep_time = (min_delay - elapsed) + random.uniform(0.1, 0.4)
        await asyncio.sleep(sleep_time)

    LAST_REQUEST_TIME[domain] = time.time()


def interleave_filas_por_producto(filas: list) -> list:
    """
    Agrupa las filas por id_producto_propio y las ordena por producto para que el scraper
    procese los enlaces de un mismo producto en secuencia rotando de cadena en cadena.
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
    """
    Cancela recursos pesados (imágenes, fuentes, analíticas) pero permite XHR/Fetch/JSON/CSS/JS.
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
    Motor universal de extracción del DOM con discriminación de visibilidad efectiva,
    soporte Angular SPA, Next.js, VTEX y Schema.org.
    """
    return await page.evaluate(r"""
        () => {
            const bodyText = document.body ? document.body.innerText || '' : '';
            const title = document.title || '';

            // 1. Detectar bloqueos anti-bot
            if (title.includes('Cloudflare') || title.includes('Just a moment') || 
                bodyText.includes('Checking your browser') || bodyText.includes('Access Denied') ||
                bodyText.includes('Too Many Requests') || title.includes('429')) {
                return { error: "HTTP 429" };
            }

            // 2. Detectar páginas agotadas / 404
            if (title.includes('404') || bodyText.includes('Producto no disponible') || 
                bodyText.includes('No pudimos encontrar') || bodyText.includes('no encontrado')) {
                return { error: "Producto no disponible o enlace roto (404 / Agotado)." };
            }

            const isVisible = (el) => {
                if (!el) return false;
                try {
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                    return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
                } catch(e) {
                    return true;
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
            let tipo_promo = null;
            let porcentaje_descuento = null;
            let metodo_extraccion = null;

            const isFarmatodo = window.location.hostname.includes('farmatodo');

            // 3. ESTRATEGIA FARMATODO (Angular Componentes + Promociones)
            if (isFarmatodo) {
                try {
                    const ftTitleEl = document.querySelector('h1, app-product-detail h1, .product-purchase h1, [class*="product-detail__title"]');
                    if (ftTitleEl && isVisible(ftTitleEl)) {
                        nombre = (ftTitleEl.innerText || ftTitleEl.textContent || '').trim();
                    }

                    // A1. Detectar Badges de Descuento visibles (ej: 'Solo DELIVERY - 15% Dcto. 1era Compra', '15% OFF')
                    const badgeElements = Array.from(document.querySelectorAll('.badge-discount, .discount-badge, [class*="badge"], [class*="discount"], [class*="dcto"], [class*="tag"], [class*="offer"], .tag'));
                    for (const badge of badgeElements) {
                        if (!isVisible(badge)) continue;
                        if (badge.children.length > 2) continue;
                        const txt = (badge.innerText || badge.textContent || '').replace(/\s+/g, ' ').trim();
                        if (!txt || txt.length > 90) continue;

                        const m = txt.match(/\b(\d{1,2})\s*%\s*(?:dcto|descuento|off)?/i) || txt.match(/(\d{1,2})%/);
                        if (m) {
                            const pct = parseInt(m[1], 10);
                            if (pct >= 3 && pct <= 90) {
                                porcentaje_descuento = pct;
                                tipo_promo = txt;
                                break;
                            }
                        }
                    }

                    // A2. Selectores específicos de componentes de precios visibles
                    const offerEls = Array.from(document.querySelectorAll('[id^="product-all-price-offer-"], .product-all-price__offer, [class*="product-all-price__offer"]')).filter(isVisible);
                    for (const el of offerEls) {
                        const val = parsePriceText(el.innerText || el.textContent || '');
                        if (val && val > 0.1) {
                            precio_oferta = val;
                            metodo_extraccion = "dom";
                            break;
                        }
                    }

                    const normalEls = Array.from(document.querySelectorAll('[id^="product-all-price-normal-"], .product-all-price__normal, [class*="product-all-price__normal"]')).filter(isVisible);
                    for (const el of normalEls) {
                        const val = parsePriceText(el.innerText || el.textContent || '');
                        if (val && val > 0.1) {
                            precio_lista = val;
                            break;
                        }
                    }

                    // A3. Inspección del bloque contenedor de precios visible
                    const visibleBoxes = Array.from(document.querySelectorAll('app-product-all-price, .product-all-price, .product-purchase__price-section, .product-purchase')).filter(isVisible);
                    if (visibleBoxes.length > 0) {
                        const box = visibleBoxes[0];
                        const priceEls = Array.from(box.querySelectorAll('span, p, div, del, s, b, strong')).filter(el => {
                            if (!isVisible(el) || el.children.length > 2) return false;
                            const txt = (el.innerText || el.textContent || '').trim();
                            return (txt.includes('Bs') || txt.includes('VES')) && /\d/.test(txt) &&
                                   !txt.toLowerCase().includes('unidades a') &&
                                   !txt.toLowerCase().includes('c/u');
                        });

                        const parsedList = [];
                        for (const el of priceEls) {
                            const val = parsePriceText(el.innerText || el.textContent || '');
                            if (!val || val <= 0.1) continue;

                            let isStrikethrough = false;
                            try {
                                const style = window.getComputedStyle(el);
                                const td = style.textDecoration || style.textDecorationLine || '';
                                if (td.includes('line-through') || el.matches('del, s, strike') || el.closest('del, s, strike')) {
                                    isStrikethrough = true;
                                }
                            } catch(e) {}

                            const isOffer = (el.className || '').includes('offer') || (el.id || '').includes('offer');
                            parsedList.push({ val, isStrikethrough, isOffer });
                        }

                        const striked = parsedList.filter(p => p.isStrikethrough);
                        const offers = parsedList.filter(p => p.isOffer);

                        if (striked.length > 0 && !precio_lista) precio_lista = striked[0].val;
                        if (offers.length > 0 && !precio_oferta) {
                            precio_oferta = offers[0].val;
                            metodo_extraccion = "dom";
                        }

                        const uniqueVals = Array.from(new Set(parsedList.map(p => p.val))).sort((a, b) => b - a);
                        if (uniqueVals.length >= 2) {
                            if (!precio_lista) precio_lista = uniqueVals[0];
                            if (!precio_oferta) {
                                precio_oferta = uniqueVals[1];
                                metodo_extraccion = "dom";
                            }
                        } else if (uniqueVals.length === 1 && !precio_lista && !precio_oferta) {
                            precio_lista = uniqueVals[0];
                        }
                    }

                    // A4. Derivación matemática desde el porcentaje del badge si solo está presente el precio de lista
                    if (precio_lista && !precio_oferta && porcentaje_descuento) {
                        precio_oferta = Math.round((precio_lista * (1 - (porcentaje_descuento / 100))) * 100) / 100;
                        metodo_extraccion = "derivado";
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

            // Schema.org JSON-LD fallback
            if (!precio_lista) {
                const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                for (const s of scripts) {
                    try {
                        const parsed = JSON.parse(s.textContent || '{}');
                        const items = Array.isArray(parsed) ? parsed : [parsed];
                        for (const it of items) {
                            if (it['@type'] === 'Product' && it.offers) {
                                if (!nombre && it.name) nombre = it.name;
                                const off = Array.isArray(it.offers) ? it.offers[0] : it.offers;
                                if (off && off.price) {
                                    precio_lista = parseFloat(off.price);
                                    if (off.highPrice && parseFloat(off.highPrice) > precio_lista) {
                                        precio_oferta = precio_lista;
                                        precio_lista = parseFloat(off.highPrice);
                                        metodo_extraccion = "dom";
                                    }
                                }
                            }
                        }
                    } catch(e) {}
                }
            }

            if (!nombre) {
                const h1El = document.querySelector('h1');
                nombre = h1El && isVisible(h1El) ? (h1El.innerText || h1El.textContent || '').trim() : document.title.split('|')[0].trim();
            }

            return {
                nombre,
                precio_lista,
                precio_oferta,
                tipo_promo,
                porcentaje_descuento,
                metodo_extraccion
            };
        }
    """)


async def scrape_url_async(page, url: str, marca: str, bcv_rate: float, task_id: str = "1") -> dict:
    """Ejecuta el ciclo de scraping con intercepción de red y fallback híbrido."""
    intentos = 3
    is_farmatodo = "farmatodo" in url.lower()

    result = {
        "url": url,
        "marca": marca,
        "nombre": None,
        "precio_full_bs": None,       # precio_lista
        "precio_desc_bs": None,       # precio_oferta
        "tipo_promo": None,
        "porcentaje_descuento": None,
        "metodo_extraccion": None,
        "tiene_descuento": False,
        "scraped_at": datetime.now(timezone.utc).isoformat(),
        "error": None,
    }

    for int_num in range(1, intentos + 1):
        result["error"] = None
        result["precio_full_bs"] = None
        result["precio_desc_bs"] = None
        result["tipo_promo"] = None
        result["porcentaje_descuento"] = None
        result["metodo_extraccion"] = None
        result["tiene_descuento"] = False

        # Respetar rate limiting por dominio
        await wait_for_domain_rate_limit(url)

        api_captured_data = {}

        async def handle_response(response):
            """Intercepción de red para endpoints JSON de productos y promociones."""
            try:
                content_type = response.headers.get("content-type", "").lower()
                resp_url = response.url.lower()
                if "json" in content_type and any(kw in resp_url for kw in ("product", "item", "articulo", "promotion", "promo", "pricing", "detail")):
                    if response.status == 200:
                        json_data = await response.json()
                        if isinstance(json_data, dict):
                            # Buscar recursivamente datos de precio y promociones
                            def search_json(obj, depth=0):
                                if not obj or depth > 5:
                                    return
                                if isinstance(obj, dict):
                                    p_full = obj.get("fullPrice") or obj.get("normalPrice") or obj.get("listPrice") or obj.get("priceWithoutDiscount") or obj.get("regularPrice")
                                    p_offer = obj.get("offerPrice") or obj.get("specialPrice") or obj.get("discountPrice") or obj.get("priceOffer") or obj.get("salePrice")
                                    p_base = obj.get("price") or obj.get("bsPrice") or obj.get("precioBs")

                                    p_disc_pct = obj.get("discountPercentage") or obj.get("discount") or obj.get("discountRate")
                                    p_promo_name = obj.get("promotionName") or obj.get("promoTitle") or obj.get("badgeText") or obj.get("badge")

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

                                    for v in obj.values():
                                        if isinstance(v, (dict, list)):
                                            search_json(v, depth + 1)
                                elif isinstance(obj, list):
                                    for item in obj[:10]:
                                        search_json(item, depth + 1)

                            search_json(json_data)
            except Exception:
                pass

        page.on("response", handle_response)

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

            if is_farmatodo:
                try:
                    await page.wait_for_selector('app-product-all-price, .product-all-price, [id^="product-all-price-"]', timeout=6000)
                except Exception:
                    pass
                await asyncio.sleep(1.5)
            else:
                await asyncio.sleep(0.8)

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

        # Priorización de Fuentes: 1. API Interceptada -> 2. DOM / Derivado
        final_precio_lista = None
        final_precio_oferta = None
        final_tipo_promo = None
        final_pct_desc = None
        final_metodo = None

        if api_captured_data.get("precio_lista") and api_captured_data.get("precio_oferta") and api_captured_data["precio_lista"] > api_captured_data["precio_oferta"]:
            final_precio_lista = api_captured_data["precio_lista"]
            final_precio_oferta = api_captured_data["precio_oferta"]
            final_tipo_promo = api_captured_data.get("tipo_promo")
            final_pct_desc = api_captured_data.get("porcentaje_descuento")
            final_metodo = "api"
        elif data.get("precio_lista"):
            final_precio_lista = data["precio_lista"]
            final_precio_oferta = data.get("precio_oferta")
            final_tipo_promo = data.get("tipo_promo")
            final_pct_desc = data.get("porcentaje_descuento")
            final_metodo = data.get("metodo_extraccion") or "dom"

        if final_precio_lista:
            # Reconciliación si vinieron invertidos
            if final_precio_oferta and final_precio_oferta > final_precio_lista:
                final_precio_lista, final_precio_oferta = final_precio_oferta, final_precio_lista

            tiene_desc = bool(final_precio_oferta and (final_precio_lista - final_precio_oferta) > 0.05)
            if not tiene_desc:
                final_precio_oferta = None
                final_tipo_promo = None
                final_pct_desc = None

            if tiene_desc and not final_pct_desc and final_precio_lista > 0:
                final_pct_desc = round(((final_precio_lista - final_precio_oferta) / final_precio_lista) * 100, 1)

            result["precio_full_bs"] = round(final_precio_lista, 2)
            result["precio_desc_bs"] = round(final_precio_oferta, 2) if final_precio_oferta else None
            result["tipo_promo"] = final_tipo_promo
            result["porcentaje_descuento"] = final_pct_desc
            result["metodo_extraccion"] = final_metodo if tiene_desc else ("dom" if final_metodo else None)
            result["tiene_descuento"] = tiene_desc
            break
        else:
            result["error"] = "Precio no encontrado en la estructura de la página."
            await asyncio.sleep(1)

    return result


async def main_async():
    inicio = time.time()
    bcv_rate = await get_bcv_rate()

    # Cargar filas desde DB o CSV local
    filas = cargar_filas_de_db()
    if not filas:
        filas = cargar_filas_de_csv()

    if not filas:
        print("❌ No hay enlaces para procesar.", flush=True)
        sys.exit(1)

    # Filtrar enlaces vacíos o inactivos
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

    # Soporte para filtrado por argumento CLI o payload de GitHub Actions
    if len(sys.argv) > 1:
        arg_target = sys.argv[1].strip()
        filas_procesar = [f for f in filas_activas if f.get("id_producto_propio") == arg_target or f.get("_doc_id") == arg_target or f.get("id") == arg_target]
        if not filas_procesar:
            print(f"Aviso: No se encontró producto con ID o doc_id '{arg_target}', procesando todas las activas.")
            filas_procesar = filas_activas
    else:
        filas_procesar = filas_activas

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

        # Configurar enrutamiento para cancelar recursos pesados
        await context.route("**/*", block_unnecessary_resources)

        async def worker(fila, idx):
            cadena = fila.get("cadena", "").strip()
            url = fila.get("url", "").strip()
            marca = fila.get("marca", "").strip()
            id_prod = fila.get("id_producto_propio", "").strip()

            sem_cadena = sem_farmatodo if "farmatodo" in cadena.lower() or "farmatodo" in url.lower() else sem_general

            async with sem_general:
                async with sem_cadena:
                    page = await context.new_page()
                    if not url:
                        res = {
                            "url": "", "marca": marca, "nombre": None,
                            "precio_full_bs": None, "precio_desc_bs": None,
                            "tipo_promo": None, "porcentaje_descuento": None, "metodo_extraccion": None,
                            "tiene_descuento": False, "scraped_at": datetime.now(timezone.utc).isoformat(),
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

                    await page.close()

                    if res.get("error"):
                        print(f"[{idx}/{len(filas_procesar)}] ❌ [{cadena}] {marca} - {res['error']}", flush=True)
                    else:
                        status = f"Bs {res['precio_full_bs']:,.2f}"
                        if res.get('tiene_descuento'):
                            status += f" -> Oferta: Bs {res['precio_desc_bs']:,.2f} ({res.get('tipo_promo') or (str(res.get('porcentaje_descuento')) + '%')}) [{res.get('metodo_extraccion')}]"
                        print(f"[{idx}/{len(filas_procesar)}] ✅ [{cadena}] {marca} ({id_prod}): {status}", flush=True)

                    return res

        tasks = [worker(fila, i + 1) for i, fila in enumerate(filas_procesar)]
        resultados = await asyncio.gather(*tasks)

        await context.close()
        await browser.close()

    duracion = time.time() - inicio
    ok_count = sum(1 for r in resultados if not r.get("error"))
    err_count = len(resultados) - ok_count

    print("\n" + "=" * 60)
    print(f"COMPLETADO en {duracion:.1f}s ({duracion/60:.1f} min) | Éxito: {ok_count}/{len(resultados)} OK")
    print(f"Resultados guardados localmente en: {OUT_PATH}")
    print("=" * 60 + "\n")

    OUT_PATH.write_text(json.dumps(resultados, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        print("\nScraper cancelado por el usuario.")
        sys.exit(0)


if __name__ == "__main__":
    main()
