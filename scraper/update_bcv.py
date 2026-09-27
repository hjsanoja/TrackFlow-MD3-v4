"""
Obtiene la tasa BCV del dia y la guarda en Supabase (una fila por dia).

Se ejecuta antes del scraping de precios. Si pydolarve falla, intentamos
otra fuente. Si todo falla, no rompemos: el scraper sigue, solo no actualizamos
la tasa esa corrida.
"""

import sys
from datetime import datetime, timedelta, timezone
import urllib.request
import urllib.error
import json


def fetch_bcv_pydolarve():
    """Intenta pydolarve.org"""
    try:
        url = "https://pydolarve.org/api/v2/dollar?page=bcv"
        req = urllib.request.Request(url, headers={"User-Agent": "TrackFlow/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            value = data.get("monitors", {}).get("usd", {}).get("price")
            if value and value > 0:
                return float(value)
    except (urllib.error.URLError, json.JSONDecodeError, KeyError) as e:
        print(f"  pydolarve falló: {e}")
    return None


def fetch_bcv_dolarapi():
    """Backup: ve.dolarapi.com"""
    try:
        url = "https://ve.dolarapi.com/v1/dolares/oficial"
        req = urllib.request.Request(url, headers={"User-Agent": "TrackFlow/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            value = data.get("promedio") or data.get("price")
            if value and value > 0:
                return float(value)
    except (urllib.error.URLError, json.JSONDecodeError, KeyError) as e:
        print(f"  dolarapi falló: {e}")
    return None


def fecha_caracas():
    """Fecha de hoy en Venezuela (UTC-4): a las 9 p. m. ya es mañana en UTC."""
    return (datetime.now(timezone.utc) - timedelta(hours=4)).strftime("%Y-%m-%d")


def tasa_guardada_hoy():
    """La tasa de hoy si ya esta en dim_tasa_bcv (del robot o puesta a mano)."""
    try:
        from supabase_client import is_supabase_configured, select
        if not is_supabase_configured():
            return None
        filas = select("dim_tasa_bcv", f"select=tasa,fuente&fecha=eq.{fecha_caracas()}&limit=1")
        if filas and float(filas[0]["tasa"]) > 0:
            return float(filas[0]["tasa"]), filas[0].get("fuente")
    except Exception as e:
        print(f"  Aviso leyendo la tasa guardada: {e}")
    return None


def update_bcv_rate():
    """Deja la tasa de hoy en dim_tasa_bcv y la devuelve (o None).

    Una fila por dia: si la de hoy ya esta (de otra corrida o puesta a mano en
    el panel) no se busca en internet ni se escribe nada. Antes se buscaba en
    cada corrida y se intentaba insertar otra vez (el error 409 del log).
    """
    guardada = tasa_guardada_hoy()
    if guardada:
        print(f"Tasa BCV de hoy ya guardada: Bs {guardada[0]:,.4f} / USD ({guardada[1] or 'BCV'}). No se busca de nuevo.")
        return guardada[0]

    print("Obteniendo tasa BCV...")
    rate = fetch_bcv_dolarapi()
    if rate is None:
        rate = fetch_bcv_pydolarve()

    if rate is None:
        print("  No se pudo obtener tasa de ninguna fuente")
        return None

    print(f"  Tasa BCV: Bs {rate:,.4f} / USD")
    try:
        from supabase_client import is_supabase_configured, upsert
        if is_supabase_configured():
            upsert("dim_tasa_bcv", [{
                "fecha": fecha_caracas(),
                "tasa": round(rate, 4),
                "fuente": "BCV"
            }], on_conflict="fecha")
            print("  ✅ Tasa BCV guardada en Supabase (dim_tasa_bcv)")
    except Exception as e:
        print(f"  Aviso Supabase BCV: {e}")

    return rate


if __name__ == "__main__":
    rate = update_bcv_rate()
    sys.exit(0 if rate else 1)
