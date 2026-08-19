"""
TrackFlow - Sincronizador a Base de Datos Supabase.
Lee resultados.json y persiste en las tablas:
- productos_competencia (upsert estado actual)
- historico_precios (insert registro histórico de cambios)
- scrape_runs (registro de ejecución)
"""

import json
import os
import sys
from pathlib import Path
from datetime import datetime, timezone
import uuid

PROJECT_ROOT = Path(__file__).resolve().parent.parent
RESULTADOS_PATH = PROJECT_ROOT / "resultados.json"
CACHE_PATH = PROJECT_ROOT / ".scrape_cache.json"


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
    try:
        from supabase_client import is_supabase_configured, upsert, insert
        if is_supabase_configured():
            print("\n[SUPABASE] Sincronizando datos con Supabase...")

            # 1. Upsert en productos_competencia
            records_to_upsert = []
            for item, es_err, r in cambios:
                records_to_upsert.append({
                    "id": item["id"],
                    "id_producto_propio": item.get("id_producto_propio") or r.get("id_producto_propio"),
                    "cadena": item.get("cadena") or r.get("cadena"),
                    "marca": item.get("marca") or r.get("marca"),
                    "tipo": item.get("tipo") or r.get("tipo", "alternativa"),
                    "url": item.get("url") or r.get("url"),
                    "laboratorio": r.get("laboratorio") or "",
                    "concentracion": r.get("concentracion") or "",
                    "tamano": r.get("tamano") or "",
                    "activo": r.get("activo", True) if isinstance(r.get("activo"), bool) else True,
                    "ultimo_scrape": item.get("ultimo_scrape"),
                    "estado": item.get("estado"),
                    "ultimo_error": item.get("ultimo_error"),
                    "ultimo_precio_full_bs": item.get("ultimo_precio_full_bs"),
                    "ultimo_precio_desc_bs": item.get("ultimo_precio_desc_bs"),
                    "ultimo_precio_full_usd": item.get("ultimo_precio_full_usd"),
                    "ultimo_precio_desc_usd": item.get("ultimo_precio_desc_usd"),
                    "ultimo_nombre": item.get("ultimo_nombre"),
                    "tiene_descuento": bool(item.get("tiene_descuento", False)),
                    "tipo_promo": item.get("tipo_promo"),
                    "porcentaje_descuento": item.get("porcentaje_descuento"),
                    "promo_condicionada": bool(item.get("promo_condicionada", False)),
                    "metodo_extraccion": item.get("metodo_extraccion"),
                })

            if records_to_upsert:
                for i in range(0, len(records_to_upsert), 100):
                    upsert("productos_competencia", records_to_upsert[i:i+100])
                print(f"[SUPABASE] ✅ Actualizados {len(records_to_upsert)} productos en productos_competencia.")

            # 2. Insertar en historico_precios
            supabase_historico = []
            for h in historico_items:
                supabase_historico.append({
                    "prod_comp_id": h.get("prod_comp_id"),
                    "id_producto_propio": h.get("id_producto_propio"),
                    "cadena": h.get("cadena"),
                    "marca": h.get("marca"),
                    "nombre": h.get("nombre"),
                    "precio_full_bs": h.get("precio_full_bs"),
                    "precio_desc_bs": h.get("precio_desc_bs"),
                    "precio_full_usd": h.get("precio_full_usd"),
                    "precio_desc_usd": h.get("precio_desc_usd"),
                    "tiene_descuento": bool(h.get("tiene_descuento", False)),
                    "tipo_promo": h.get("tipo_promo"),
                    "porcentaje_descuento": h.get("porcentaje_descuento"),
                    "promo_condicionada": bool(h.get("promo_condicionada", False)),
                    "metodo_extraccion": h.get("metodo_extraccion"),
                    "scraped_at": h.get("scraped_at"),
                    "run_id": h.get("run_id")
                })

            if supabase_historico:
                for i in range(0, len(supabase_historico), 100):
                    insert("historico_precios", supabase_historico[i:i+100])
                print(f"[SUPABASE] ✅ Insertados {len(supabase_historico)} registros en historico_precios.")

            # 3. Registrar scrape_run
            run_data = [{
                "run_id": run_id,
                "started_at": ahora_iso,
                "total": len(resultados),
                "ok": ok,
                "errores": errores,
                "trigger": trigger,
            }]
            try:
                insert("scrape_runs", run_data)
            except Exception:
                pass
            print("[SUPABASE] ✅ Sincronización con Supabase finalizada.")

    except Exception as e:
        print(f"[SUPABASE] Aviso: No se pudo completar la sincronización ({e})")

    # Actualizar caché local en disco
    try:
        CACHE_PATH.write_text(json.dumps(nuevo_cache, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        print(f"[CACHE] Error al escribir cache: {e}")

    print("\n" + "=" * 60)
    print(f"Sincronización completada | Total: {len(resultados)} | OK: {ok} | Errores: {errores}")
    print(f"Cambios procesados: {len(cambios)} | Ahorrados por delta: {len(resultados) - len(cambios)}")
    print("Trigger: " + trigger)
    print("Run ID: " + run_id)
    print("=" * 60)


if __name__ == "__main__":
    main()
