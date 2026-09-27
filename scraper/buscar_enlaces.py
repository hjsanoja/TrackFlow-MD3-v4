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
La plataforma de cada cadena se detecta sola y se guarda en
dim_cadenas.plataforma. Si una tienda no tiene ninguno de esos buscadores
queda como 'sin_buscador' con lo que se vio en su pagina (para programarla
despues).

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


BUSCADORES = {"vtex": buscar_vtex, "woocommerce": buscar_woo, "shopify": buscar_shopify, "magento": buscar_magento}
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
    return "sin_buscador", {"estado_web": status, "huellas": huellas,
                            "nota": "Ningun buscador publico conocido respondio."}


def moneda_vtex(base, datos) -> str | None:
    """Moneda de la tienda VTEX: la de la pagina de un producto (VES o USD)."""
    if not datos:
        return None
    link = datos[0].get("link") or f"{base}/{datos[0].get('linkText', '')}/p"
    status, pagina = pedir(link if link.startswith("http") else base + link, json_esperado=False)
    m = re.search(r'product:price:currency"\s+content="([A-Z]{3})"', pagina or "") if isinstance(pagina, str) else None
    return m.group(1) if m else None


# ---------------------------------------------------------------------------
# Busqueda de un producto en una cadena
# ---------------------------------------------------------------------------
def buscar_producto(prod: dict, cadena: dict) -> dict:
    buscar = BUSCADORES[cadena["plataforma"]]
    base = base_de(cadena["website"])
    ctx = cadena.get("plataforma_detalle") or {}
    consultas = construir_consultas(prod)
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

    corrida = db.insert("corridas_buscador", [{"estado": "corriendo", "url_github": url_github}], return_representation=True)
    corrida_id = corrida[0]["id"]
    print(f"Corrida {corrida_id}")

    try:
        # 1. Cadenas y su plataforma
        cadenas = [c for c in db.select("dim_cadenas", "select=id,nombre,website,activo,plataforma,plataforma_detalle,plataforma_revisada")
                   if c.get("activo") is not False and c.get("website")]
        if solo_cadenas:
            cadenas = [c for c in cadenas if c["id"] in solo_cadenas]
        limite_plat = datetime.now(timezone.utc) - timedelta(days=DIAS_PLATAFORMA)
        for c in cadenas:
            revisada = c.get("plataforma_revisada")
            vieja = not revisada or datetime.fromisoformat(revisada.replace("Z", "+00:00")) < limite_plat
            if forzar or not c.get("plataforma") or vieja:
                plataforma, detalle = detectar_plataforma(base_de(c["website"]))
                c["plataforma"], c["plataforma_detalle"] = plataforma, detalle
                db.update("dim_cadenas", "id", c["id"], {"plataforma": plataforma, "plataforma_detalle": detalle,
                                                         "plataforma_revisada": ahora_iso()})
            print(f"  {c['nombre']}: {c['plataforma']} {json.dumps(c.get('plataforma_detalle') or {}, ensure_ascii=False)}")
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
        pendientes = {(s["producto_id"], s["cadena_id"])
                      for s in db.select("sugerencias_enlaces", "select=producto_id,cadena_id&estado=eq.pendiente")}

        tareas = {c["id"]: [] for c in activas}
        for p in productos:
            ya = set(p.get("cadenas_con_enlace") or [])
            for c in activas:
                clave = (p["producto_id"], c["id"])
                if c["id"] in ya or clave in recientes or clave in pendientes:
                    continue
                tareas[c["id"]].append(p)
        total = sum(len(t) for t in tareas.values())
        db.update("corridas_buscador", "id", corrida_id, {"total": total})
        print(f"{len(productos)} productos, {total} busquedas en {len(activas)} cadenas")

        # 3. Buscar: una hebra por cadena (cada tienda de a una consulta)
        lock = threading.Lock()
        estado = {"procesados": 0}
        resumen = {c["id"]: {"nombre": c["nombre"], "plataforma": c["plataforma"], "buscados": 0,
                             "sugeridos": 0, "sin_resultado": 0, "errores": 0} for c in cadenas}

        def trabajar(cadena):
            r = resumen[cadena["id"]]
            for p in tareas[cadena["id"]]:
                fila = {"producto_id": p["producto_id"], "cadena_id": cadena["id"], "fecha": ahora_iso()}
                try:
                    res = buscar_producto(p, cadena)
                    sug = [{
                        "producto_id": p["producto_id"], "cadena_id": cadena["id"], "url": s["url"],
                        "nombre_tienda": s["nombre"][:500], "marca_tienda": (s.get("marca") or "")[:200] or None,
                        "precio": s.get("precio"), "moneda": s.get("moneda"), "disponible": s.get("disponible"),
                        "puntaje": s["puntaje"], "detalle": s["detalle"], "actualizado": ahora_iso(),
                    } for s in res["sugerencias"]]
                    if sug:
                        db.upsert("sugerencias_enlaces", sug, on_conflict="producto_id,cadena_id,url")
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
