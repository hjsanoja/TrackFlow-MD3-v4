"""
TrackFlow - Sincronizador a Base de Datos Supabase.
Dual-Write:
- Modelo Legacy: productos_competencia, historico_precios
- Modelo Relacional: scrape_runs, fact_precios, dim_tasa_bcv
"""

import json
import os
import sys
import re
from pathlib import Path
from datetime import datetime, timezone
from collections import defaultdict
import uuid

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RESULTADOS_PATH = PROJECT_ROOT / "resultados.json"
CACHE_PATH = PROJECT_ROOT / ".scrape_cache.json"


def normalizar_cadena_id(cadena_str: str, cadenas_validas: list) -> str:
    cad_clean = (cadena_str or "").strip().lower()
    for cid in cadenas_validas:
        if cid.lower() == cad_clean:
            return cid
    if "farmatodo" in cad_clean:
        return "Farmatodo"
    if "locatel" in cad_clean:
        return "Locatel"
    if "saas" in cad_clean:
        return "Saas"
    if "farmadon" in cad_clean:
        return "FarmaDON"
    if "ignacio" in cad_clean:
        return "Grupo San Ignacio"
    if "xana" in cad_clean:
        return "Farmacias Xana"
    if "farmago" in cad_clean or "go" in cad_clean:
        return "FarmaGo"
    return cadenas_validas[0] if cadenas_validas else "Farmatodo"


def resolver_tipo_promocion_id(tipo_promo_str: str, promo_map: dict) -> int | None:
    if not tipo_promo_str:
        return promo_map.get("sin_promocion")
    tp = tipo_promo_str.lower()
    if "2x1" in tp:
        return promo_map.get("2x1")
    if "3x2" in tp:
        return promo_map.get("3x2")
    if "segunda" in tp or "2da" in tp:
        return promo_map.get("segunda_unidad_descuento")
    return promo_map.get("descuento_directo") or promo_map.get("sin_promocion")


def main():
    if not RESULTADOS_PATH.exists():
        print(f"No se encontró el archivo de resultados en {RESULTADOS_PATH}")
        sys.exit(1)

    try:
        resultados = json.loads(RESULTADOS_PATH.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"Error al leer {RESULTADOS_PATH}: {e}")
        sys.exit(1)

    if not isinstance(resultados, list) or len(resultados) == 0:
        print("resultados.json está vacío o no es una lista válida.")
        sys.exit(0)

    print(f"Cargados {len(resultados)} resultados para sincronizar...")

    # Cargar caché previo para delta-sync
    cache_previo = {}
    if CACHE_PATH.exists():
        try:
            cache_previo = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
        except Exception:
            cache_previo = {}

    ahora = datetime.now(timezone.utc)
    ahora_iso = ahora.isoformat()
    run_id = os.environ.get("GITHUB_RUN_ID") or f"local_{int(ahora.timestamp())}"
    trigger = os.environ.get("GITHUB_EVENT_NAME") or "manual"
    if trigger not in ("cron", "manual", "dispatch"):
        trigger = "manual"

    nuevo_cache = {}
    cambios = []
    historico_items = []
    ok = 0
    errores = 0

    for r in resultados:
        # Generar ID canónico determinista si no viene en el registro
        prod_comp_id = r.get("_doc_id") or r.get("id")
        if not prod_comp_id:
            cadena = str(r.get("cadena", "")).lower().strip()
            marca = str(r.get("marca", "")).lower().strip()
            id_propio = str(r.get("id_producto_propio", "")).lower().strip()
            tamano = str(r.get("tamano", "")).lower().strip()
            concentracion = str(r.get("concentracion", "")).lower().strip()
            laboratorio = str(r.get("laboratorio", "")).lower().strip()

            parts = [id_propio, cadena, marca]
            if concentracion:
                parts.append(str(concentracion))
            if tamano:
                parts.append(str(tamano))
            if laboratorio:
                parts.append(str(laboratorio))
            prod_comp_id = "_".join(parts).replace(" ", "_").replace("/", "_").replace("\\", "_")

        es_error = False
        error_msg = ""
        if r.get("error"):
            es_error = True
            error_msg = r["error"]
        elif r.get("precio_full_bs") is None or r.get("precio_full_bs") <= 0.01:
            es_error = True
            error_msg = "Precio no encontrado en la página (agotado o sin precio visible)."

        if es_error:
            errores += 1
        else:
            ok += 1

        p_full_bs = r.get("precio_full_bs")
        p_desc_bs = r.get("precio_desc_bs")
        p_full_usd = r.get("precio_full_usd")
        p_desc_usd = r.get("precio_desc_usd")
        estado_str = "error" if es_error else "ok"

        estado_actual = f"{estado_str}|{p_full_bs}|{p_desc_bs}|{error_msg}"
        nuevo_cache[prod_comp_id] = {
            "estado": estado_actual,
            "precio_full_bs": p_full_bs,
            "precio_desc_bs": p_desc_bs,
            "error": error_msg
        }

        estado_previo = cache_previo.get(prod_comp_id, {}).get("estado")

        item_data = {
            "id": prod_comp_id,
            "_doc_id": prod_comp_id,
            "id_producto_propio": r.get("id_producto_propio"),
            "cadena": r.get("cadena"),
            "marca": r.get("marca"),
            "tipo": r.get("tipo"),
            "url": r.get("url"),
            "ultimo_scrape": ahora_iso,
            "estado": estado_str,
            "ultimo_error": error_msg if es_error else None,
            "precio_full_bs": p_full_bs,
            "precio_desc_bs": p_desc_bs,
            "precio_full_usd": p_full_usd,
            "precio_desc_usd": p_desc_usd,
            "ultimo_precio_full_bs": p_full_bs,
            "ultimo_precio_desc_bs": p_desc_bs,
            "ultimo_precio_full_usd": p_full_usd,
            "ultimo_precio_desc_usd": p_desc_usd,
            "ultimo_nombre": r.get("nombre"),
            "tiene_descuento": bool(r.get("tiene_descuento", False)),
            "tipo_promo": r.get("tipo_promo"),
            "porcentaje_descuento": r.get("porcentaje_descuento"),
            "promo_condicionada": bool(r.get("promo_condicionada", False)),
            "metodo_extraccion": r.get("metodo_extraccion"),
        }

        if estado_actual != estado_previo:
            cambios.append((item_data, es_error, r))
            if not es_error:
                historico_items.append({
                    "prod_comp_id": prod_comp_id,
                    "id_producto_propio": r.get("id_producto_propio"),
                    "cadena": r.get("cadena"),
                    "marca": r.get("marca"),
                    "tipo": r.get("tipo"),
                    "nombre": r.get("nombre"),
                    "precio_full_bs": p_full_bs,
                    "precio_desc_bs": p_desc_bs,
                    "precio_full_usd": p_full_usd,
                    "precio_desc_usd": p_desc_usd,
                    "tiene_descuento": bool(r.get("tiene_descuento", False)),
                    "tipo_promo": r.get("tipo_promo"),
                    "porcentaje_descuento": r.get("porcentaje_descuento"),
                    "promo_condicionada": bool(r.get("promo_condicionada", False)),
                    "metodo_extraccion": r.get("metodo_extraccion"),
                    "scraped_at": ahora_iso,
                    "run_id": run_id
                })

    # SINCRONIZAR A SUPABASE
    fallo_guardado = False
    try:
        from supabase_client import is_supabase_configured, upsert, insert, select
        if is_supabase_configured():
            print("\n[SUPABASE] Sincronizando datos con Supabase...")

            # productos_competencia e historico_precios son VISTAS de solo
            # lectura sobre fact_precios desde la fase 5: no se escribe en
            # ellas. Antes se intentaba y el error cortaba todo antes de
            # guardar en fact_precios, asi que los precios no se guardaban.

            # -----------------------------------------------------------------
            # ACTUALIZAR MODELO RELACIONAL (scrape_runs y fact_precios)
            # -----------------------------------------------------------------
            try:
                # A. Cargar catálogos auxiliares
                cadenas_db = select("dim_cadenas", "select=id")
                cadenas_validas = [c["id"] for c in cadenas_db] if cadenas_db else ["Farmatodo"]

                promos_db = select("dim_tipos_promocion", "select=id,codigo")
                promo_map = {p["codigo"]: p["id"] for p in promos_db} if promos_db else {}

                tasa_db = select("dim_tasa_bcv", "order=fecha.desc&limit=1")
                tasa_bcv_actual = float(tasa_db[0]["tasa"]) if tasa_db else 850.0

                pubs_db = select("publicaciones", "select=id,cadena_id,url_normalizada")
                map_pubs = {(p["cadena_id"].lower(), p["url_normalizada"]): p["id"] for p in pubs_db}
                map_urls = {p["url_normalizada"]: p["id"] for p in pubs_db}

                # B. Agrupar resultados por cadena para registrar runs
                por_cadena = defaultdict(list)
                for r in resultados:
                    c_id = normalizar_cadena_id(r.get("cadena", ""), cadenas_validas)
                    por_cadena[c_id].append(r)

                cadena_run_uuids = {}
                for cid, items_c in por_cadena.items():
                    c_tot = len(items_c)
                    c_err = sum(1 for it in items_c if it.get("error") or not it.get("precio_full_bs"))
                    c_ok = c_tot - c_err
                    c_estado = "completada" if c_err == 0 else ("parcial" if c_ok > 0 else "fallida")

                    run_rec = {
                        "github_run_id": str(run_id)[:100],
                        "cadena_id": cid,
                        "started_at": ahora_iso,
                        "finished_at": ahora_iso,
                        "total_urls": c_tot,
                        "exitosos": c_ok,
                        "fallidos": c_err,
                        "estado": c_estado,
                        "tipo_trigger": trigger
                    }
                    try:
                        run_res = insert("scrape_runs", [run_rec], return_representation=True)
                        if run_res and isinstance(run_res, list) and len(run_res) > 0:
                            cadena_run_uuids[cid] = run_res[0].get("id")
                    except Exception as ex_run:
                        print(f"[RELACIONAL] Aviso al registrar run para {cid}: {ex_run}")

                # C. Preparar e insertar hechos en fact_precios
                fact_records = []
                sin_publicacion = 0
                for r in resultados:
                    url_raw = r.get("url") or ""
                    url_norm = re.sub(r'\?.*$', '', url_raw).strip().lower()
                    c_id = normalizar_cadena_id(r.get("cadena", ""), cadenas_validas)

                    pub_id = r.get("publicacion_id") or map_pubs.get((c_id.lower(), url_norm)) or map_urls.get(url_norm)
                    if not pub_id:
                        sin_publicacion += 1
                        continue

                    es_err = bool(r.get("error") or not r.get("precio_full_bs") or r.get("precio_full_bs") <= 0.01)
                    error_msg_item = r.get("error") or ("Sin precio visible" if es_err else None)

                    promo_id = resolver_tipo_promocion_id(r.get("tipo_promo"), promo_map)

                    fact_records.append({
                        "publicacion_id": pub_id,
                        "scrape_run_id": cadena_run_uuids.get(c_id),
                        "fecha_captura": r.get("scraped_at") or ahora_iso,
                        "precio_full_bs": r.get("precio_full_bs"),
                        "precio_desc_bs": r.get("precio_desc_bs"),
                        "tasa_bcv": tasa_bcv_actual,
                        "tasa_origen": "bcv_del_dia",
                        "disponible": not es_err,
                        "estado": "error" if es_err else "ok",
                        "error_mensaje": (error_msg_item[:500] if error_msg_item else None),
                        "nombre_capturado": (r.get("nombre") or r.get("marca") or "")[:255] or None,
                        "tiene_promocion": bool(r.get("tiene_descuento", False)),
                        "tipo_promocion_id": promo_id,
                        "promo_texto_raw": r.get("tipo_promo"),
                        "origen": "scraper"
                    })

                if fact_records:
                    for i in range(0, len(fact_records), 100):
                        insert("fact_precios", fact_records[i:i+100])
                    print(f"[RELACIONAL] ✅ Insertados {len(fact_records)} hechos de precios en fact_precios.")
                if sin_publicacion:
                    print(f"[RELACIONAL] ⚠️  {sin_publicacion} resultados sin enlace (publicación) en Supabase: no se guardaron.")

            except Exception as ex_rel:
                print(f"[RELACIONAL] ❌ No se pudieron guardar los precios: {ex_rel}")
                fallo_guardado = True

            if not fallo_guardado:
                print("[SUPABASE] ✅ Precios guardados.")

    except Exception as e:
        print(f"[SUPABASE] ❌ No se pudo completar la sincronización ({e})")
        fallo_guardado = True

    # Actualizar caché local en disco
    try:
        CACHE_PATH.write_text(json.dumps(nuevo_cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[CACHE] Error al escribir cache: {e}")

    print("\n" + "=" * 60)
    print(f"Sincronización completada | Total: {len(resultados)} | OK: {ok} | Errores: {errores}")
    print(f"Cambios procesados: {len(cambios)} | Ahorrados por delta: {len(resultados) - len(cambios)}")
    print("Trigger: " + trigger)
    print("Run ID: " + str(run_id))
    print("=" * 60)

    # Si no se guardo en Supabase, la corrida debe salir en rojo en Actions
    # (antes decia "OK" aunque no se hubiera guardado nada).
    if fallo_guardado:
        sys.exit(1)


if __name__ == "__main__":
    main()
