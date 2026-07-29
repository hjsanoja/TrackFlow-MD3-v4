"""
Cliente Supabase optimizado para scrapers y automatizaciones.
Permite realizar operaciones CRUD sobre las tablas de Supabase utilizando la API PostgREST.
Usa las variables de entorno:
  - SUPABASE_URL (o VITE_SUPABASE_URL)
  - SUPABASE_SERVICE_ROLE_KEY (o SUPABASE_KEY / VITE_SUPABASE_ANON_KEY)
"""

import json
import os
import sys
import re
import urllib.request
import urllib.parse
from typing import List, Dict, Any, Optional

def get_supabase_config():
    url = os.environ.get("SUPABASE_URL") or os.environ.get("VITE_SUPABASE_URL") or ""
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY") or os.environ.get("VITE_SUPABASE_ANON_KEY") or ""
    
    url = url.strip().rstrip('/')
    if url.endswith('/rest/v1'):
        url = url[:-8].rstrip('/')
    return url, key

def is_supabase_configured() -> bool:
    url, key = get_supabase_config()
    return bool(url and key)

def _request(endpoint: str, method: str = "GET", data: Optional[Any] = None, headers_extra: Optional[Dict[str, str]] = None) -> Any:
    url, key = get_supabase_config()
    if not url or not key:
        raise ValueError("Supabase URL o Key no configurada en variables de entorno.")

    full_url = f"{url}/rest/v1/{endpoint.lstrip('/')}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Accept": "application/json"
    }
    if headers_extra:
        headers.update(headers_extra)

    current_data = data
    for attempt in range(15):
        body = None
        if current_data is not None:
            body = json.dumps(current_data, ensure_ascii=False).encode("utf-8")

        req = urllib.request.Request(full_url, data=body, headers=headers, method=method)
        
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                resp_bytes = resp.read()
                if not resp_bytes:
                    return None
                return json.loads(resp_bytes.decode("utf-8"))
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            # Auto-eliminar columna si no existe en la tabla de Supabase (PGRST204)
            if "PGRST204" in err_body or ("Could not find the" in err_body and "column" in err_body):
                match = re.search(r"Could not find the ['\"]?([a-zA-Z0-9_]+)['\"]? column", err_body, re.IGNORECASE)
                if match and match.group(1):
                    missing_col = match.group(1)
                    if isinstance(current_data, list):
                        for item in current_data:
                            if isinstance(item, dict):
                                item.pop(missing_col, None)
                    elif isinstance(current_data, dict):
                        current_data.pop(missing_col, None)
                    continue
            print(f"[Supabase API Error] {e.code} {e.reason}: {err_body}", file=sys.stderr)
            raise

def select(table: str, query_params: str = "select=*") -> List[Dict[str, Any]]:
    endpoint = f"{table}?{query_params}" if query_params else table
    res = _request(endpoint, method="GET")
    return res if isinstance(res, list) else []

def upsert(table: str, records: List[Dict[str, Any]], on_conflict: str = "") -> Any:
    if not records:
        return None
    headers = {
        "Prefer": "resolution=merge-duplicates,return=representation"
    }
    endpoint = table
    if on_conflict:
        endpoint = f"{table}?on_conflict={on_conflict}"
    return _request(endpoint, method="POST", data=records, headers_extra=headers)

def insert(table: str, records: List[Dict[str, Any]]) -> Any:
    if not records:
        return None
    headers = {
        "Prefer": "return=minimal"
    }
    return _request(endpoint=table, method="POST", data=records, headers_extra=headers)

def update(table: str, match_col: str, match_val: str, payload: Dict[str, Any]) -> Any:
    endpoint = f"{table}?{match_col}=eq.{urllib.parse.quote(str(match_val))}"
    return _request(endpoint, method="PATCH", data=payload)
