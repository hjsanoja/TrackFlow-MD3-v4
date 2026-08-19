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
    """Lee productos_competencia desde Supabase con fallback local CSV."""
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


async def extract_product_data_from_page(page, url: str, target_product_id: str | None) -> dict:
    """
    Motor de extracción con anclaje al ID de producto, resolución por especificidad,
    exclusión estricta de carruseles/productos relacionados y validación de precio unitario.
    """
    return await page.evaluate(r"""
        ({ target_product_id }) => {
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
                precio_unitario,
                promo_struct,
                metodo_extraccion
            };
        }
    """, {"target_product_id": target_product_id})


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

        api_captured_data = {}

        async def handle_response(response):
            """Intercepción de red con aislamiento de sub-objeto coincidente por ID."""
            try:
                content_type = response.headers.get("content-type", "").lower()
                resp_url = response.url.lower()
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
                await asyncio.sleep(2.2)
            else:
                await asyncio.sleep(0.8)

            data = await extract_product_data_from_page(page, url, target_product_id)

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
            if "404" in data["error"] or "disponible" in data["error"]:
                return result
            await asyncio.sleep(1.5)
            continue

        result["nombre"] = data.get("nombre")

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


async def main_async():
    inicio = time.time()
    bcv_rate = await get_bcv_rate()

    filas = cargar_filas_de_db()
    if not filas:
        filas = cargar_filas_de_csv()

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

    print(f"\nResultados guardados localmente en: {OUT_PATH}")
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
