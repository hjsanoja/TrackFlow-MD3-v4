"""
Correos de TrackFlow (fase 54): por SMTP (Gmail, Outlook o cualquier
servidor de correo) o por la API de Brevo.

  python scraper/correos.py alertas   -> despues de cada corrida del robot
  python scraper/correos.py resumen   -> lunes en la manana (resumen semanal)

Alertas: las reglas que cada usuario crea en Mi cuenta (alertas_usuario):
  - baja / sube: un competidor cambio su precio en dolares mas que el umbral
    frente a la lectura anterior (cada precio a la tasa de su dia).
  - mas_barato: un competidor quedo mas de umbral % por debajo de tu precio
    en esa misma cadena.
  Cada regla avisa una sola vez por enlace y por dia (alertas_enviadas).
  Solo a usuarios activos con «Alertas inmediatas» encendido en Mi cuenta.

Resumen semanal: por usuario con «Resumen semanal» encendido, los productos
donde mas perdio y mas gano frente a la competencia en 7 dias, cuantos
precios cambiaron y cuantos llevan mas de 15 dias sin actualizar.

Ambos respetan el alcance de cada usuario (laboratorios, unidades,
categorias) y no cuentan las cadenas de baja.

Variables de entorno:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (las mismas del robot)
  Por SMTP (se usa si esta SMTP_USUARIO):
    SMTP_USUARIO     la cuenta que envia (p. ej. tucuenta@gmail.com)
    SMTP_CLAVE       en Gmail, una «contrasena de aplicacion» (no la normal)
    SMTP_HOST        por defecto smtp.gmail.com (Outlook: smtp.office365.com)
    SMTP_PUERTO      por defecto 587 (STARTTLS); 465 = SSL
  Por Brevo: BREVO_API_KEY y BREVO_REMITENTE
  CORREO_NOMBRE      nombre del remitente (por defecto «TrackFlow»)
  PANEL_URL          enlace al panel que va en cada correo
Sin ninguno de los dos, solo se imprime lo que se enviaria.
"""

import html
import json
import os
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PANEL_URL = os.environ.get("PANEL_URL", "").strip()
TIPOS = {"baja": "bajó", "sube": "subió", "mas_barato": "quedó más barato que tú"}
TOP = 5


# ---------------------------------------------------------------------------
# Calculos (sin red: se prueban con datos de ejemplo)
# ---------------------------------------------------------------------------
def a_usd(bs, tasa):
    try:
        bs, tasa = float(bs), float(tasa)
    except (TypeError, ValueError):
        return None
    return bs / tasa if bs > 0 and tasa > 0 else None


def norm(texto):
    import unicodedata
    t = unicodedata.normalize("NFD", str(texto or "").lower())
    return "".join(c for c in t if unicodedata.category(c) != "Mn").strip()


def en_alcance(producto, alcance):
    """alcance = {laboratorios: [...], unidades_negocio: [...], categorias: [...]}; vacio = todo."""
    if not alcance:
        return True
    for clave, campo in (("laboratorios", "laboratorio"), ("unidades_negocio", "unidad_negocio"), ("categorias", "categoria")):
        lista = [norm(x) for x in (alcance.get(clave) or [])]
        if lista and norm(producto.get(campo)) not in lista:
            return False
    return True


def filas_utiles(variacion, cadenas_activas):
    """v_variacion sin cadenas de baja y con precios en dolares."""
    filas = []
    for v in variacion:
        if str(v.get("cadena_id") or "").lower() not in cadenas_activas:
            continue
        filas.append({
            **v,
            "ahora": a_usd(v.get("precio_actual_full_bs"), v.get("tasa_actual")),
            "antes1": a_usd(v.get("precio_1d_full_bs"), v.get("tasa_1d")),
            "antes7": a_usd(v.get("precio_7d_full_bs"), v.get("tasa_7d")),
        })
    return filas


def tu_precio(filas, producto_id, cadena=None, campo="ahora"):
    vals = [f[campo] for f in filas if f.get("es_propio") and str(f.get("id_producto_propio")) == producto_id
            and (cadena is None or f.get("cadena_id") == cadena) and f.get(campo)]
    return min(vals) if vals else None


def evaluar_alertas(alertas, filas, ya_enviadas, productos_visibles):
    """Devuelve [(alerta, fila, valor_%)] que hay que avisar hoy."""
    hits = []
    for a in alertas:
        umbral = float(a.get("umbral") or 0)
        for f in filas:
            if f.get("es_propio") or not f.get("ahora"):
                continue
            pid = str(f.get("id_producto_propio") or "")
            if pid not in productos_visibles:
                continue
            if a.get("producto_id") and pid != str(a["producto_id"]):
                continue
            if a.get("cadena_id") and str(f.get("cadena_id")).lower() != str(a["cadena_id"]).lower():
                continue
            if a.get("laboratorio") and norm(a["laboratorio"]) not in norm(f.get("laboratorio")):
                continue
            if (a["id"], f["publicacion_id"]) in ya_enviadas:
                continue
            valor = None
            if a["tipo"] in ("baja", "sube") and f.get("antes1"):
                cambio = (f["ahora"] / f["antes1"] - 1) * 100
                if (a["tipo"] == "baja" and cambio <= -umbral) or (a["tipo"] == "sube" and cambio >= umbral):
                    valor = cambio
            elif a["tipo"] == "mas_barato":
                mio = tu_precio(filas, pid, f.get("cadena_id"))
                if mio:
                    dif = (f["ahora"] / mio - 1) * 100
                    if dif <= -umbral:
                        valor = dif
            if valor is not None:
                hits.append((a, f, valor))
    return hits


def resumen_semanal(filas, productos):
    """Por producto: diferencia de tu precio con el competidor mas barato
    hoy y hace 7 dias. Devuelve (perdiste, ganaste, cambios, mas_barato)."""
    filas_por_prod = {}
    for f in filas:
        filas_por_prod.setdefault(str(f.get("id_producto_propio")), []).append(f)
    movimientos = []
    mas_barato = 0
    for pid, p in productos.items():
        fs = filas_por_prod.get(pid, [])
        def brecha(campo):
            mio = [f[campo] for f in fs if f.get("es_propio") and f.get(campo)]
            comp = [f[campo] for f in fs if not f.get("es_propio") and f.get(campo)]
            return (min(mio) / min(comp) - 1) * 100 if mio and comp else None
        hoy, antes = brecha("ahora"), brecha("antes7")
        if hoy is not None and hoy <= 0.5:
            mas_barato += 1
        if hoy is not None and antes is not None and abs(hoy - antes) >= 0.5:
            movimientos.append({"producto": p, "hoy": hoy, "antes": antes, "delta": hoy - antes})
    cambios = sum(1 for f in filas if str(f.get("id_producto_propio")) in productos and f.get("ahora") and f.get("antes7")
                  and abs(f["ahora"] / f["antes7"] - 1) * 100 > 0.5)
    perdiste = sorted([m for m in movimientos if m["delta"] > 0], key=lambda m: -m["delta"])[:TOP]
    ganaste = sorted([m for m in movimientos if m["delta"] < 0], key=lambda m: m["delta"])[:TOP]
    return perdiste, ganaste, cambios, mas_barato


# ---------------------------------------------------------------------------
# HTML de los correos
# ---------------------------------------------------------------------------
def pct(v):
    return f"{'+' if v > 0 else '−' if v < 0 else ''}{abs(v):.1f} %".replace(".", ",")


def plantilla(titulo, cuerpo):
    boton = (f'<p style="margin-top:24px"><a href="{html.escape(PANEL_URL)}" style="background:#0F2C59;color:#fff;padding:10px 18px;'
             f'border-radius:999px;text-decoration:none;font-weight:bold">Abrir TrackFlow</a></p>') if PANEL_URL else ""
    return f"""<!doctype html><html><body style="margin:0;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif;color:#1a1c22">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0"><tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;max-width:600px">
<tr><td style="background:#0F2C59;color:#ffffff;padding:20px 24px;font-size:20px;font-weight:bold">TrackFlow · {html.escape(titulo)}</td></tr>
<tr><td style="padding:24px;font-size:14px;line-height:1.5">{cuerpo}
{boton}
<p style="color:#5b6170;font-size:12px;margin-top:24px">Recibes este correo porque lo activaste en Mi cuenta. Puedes apagarlo allí cuando quieras.</p>
</td></tr></table></td></tr></table></body></html>"""


def tabla(encabezados, filas):
    th = "".join(f'<th align="left" style="padding:6px 8px;border-bottom:2px solid #0F2C59;font-size:12px;color:#0F2C59">{html.escape(h)}</th>' for h in encabezados)
    tr = "".join("<tr>" + "".join(f'<td style="padding:6px 8px;border-bottom:1px solid #e3e6ee">{c}</td>' for c in f) + "</tr>" for f in filas)
    return f'<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0 16px">{th and "<tr>" + th + "</tr>"}{tr}</table>'


def correo_alertas(nombre, hits, nombre_cadena, productos):
    filas = []
    for a, f, valor in hits:
        p = productos.get(str(f.get("id_producto_propio")), {})
        color = "#c62828" if a["tipo"] in ("baja", "mas_barato") else "#1565c0"
        filas.append([
            html.escape(p.get("nombre") or f.get("producto_nombre") or ""),
            html.escape(f"{f.get('laboratorio') or ''} · {nombre_cadena(f.get('cadena_id'))}"),
            f'<b style="color:{color}">{html.escape(TIPOS[a["tipo"]])} {pct(valor)}</b>',
            f"${f['ahora']:.2f}",
        ])
    cuerpo = (f"<p>Hola {html.escape(nombre or '')}:</p><p>Se cumplieron <b>{len(hits)}</b> de tus alertas de precio:</p>"
              + tabla(["Tu producto", "Competidor · cadena", "Qué pasó", "Precio hoy"], filas))
    return f"TrackFlow: {len(hits)} {'alerta' if len(hits) == 1 else 'alertas'} de precio", plantilla("Alertas de precio", cuerpo)


def correo_resumen(nombre, perdiste, ganaste, cambios, mas_barato, total, viejos):
    def lista(ms):
        return tabla(["Producto", "Hace 7 días", "Hoy", "Cambio"], [[
            html.escape(m["producto"].get("nombre") or ""), pct(m["antes"]), pct(m["hoy"]),
            f'<b style="color:{"#c62828" if m["delta"] > 0 else "#1565c0"}">{pct(m["delta"]).replace(" %", " pts")}</b>'] for m in ms]) if ms else "<p style='color:#5b6170'>Sin movimientos.</p>"
    cuerpo = f"""<p>Hola {html.escape(nombre or '')}, así te fue esta semana:</p>
<table width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="background:#eef2fa;border-radius:12px;padding:12px;text-align:center"><div style="font-size:22px;font-weight:bold;color:#0F2C59">{mas_barato} de {total}</div><div style="font-size:12px">productos donde eres el más barato</div></td>
<td width="8"></td>
<td style="background:#eef2fa;border-radius:12px;padding:12px;text-align:center"><div style="font-size:22px;font-weight:bold;color:#0F2C59">{cambios}</div><div style="font-size:12px">precios que cambiaron en 7 días</div></td>
<td width="8"></td>
<td style="background:#eef2fa;border-radius:12px;padding:12px;text-align:center"><div style="font-size:22px;font-weight:bold;color:{'#c62828' if viejos else '#0F2C59'}">{viejos}</div><div style="font-size:12px">precios sin actualizar (+15 días)</div></td>
</tr></table>
<h3 style="color:#c62828;margin:20px 0 4px">Donde más perdiste</h3>
<p style="color:#5b6170;font-size:12px;margin:0">Diferencia de tu precio con el competidor más barato (+ = estás más caro).</p>
{lista(perdiste)}
<h3 style="color:#1565c0;margin:20px 0 4px">Donde más ganaste</h3>
{lista(ganaste)}"""
    return "TrackFlow: tu resumen de la semana", plantilla("Resumen semanal", cuerpo)


# ---------------------------------------------------------------------------
# Envio
# ---------------------------------------------------------------------------
def nombre_remitente():
    return os.environ.get("CORREO_NOMBRE", "").strip() or os.environ.get("BREVO_NOMBRE", "").strip() or "TrackFlow"


def enviar_smtp(para, nombre, asunto, contenido):
    import smtplib
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    from email.utils import formataddr
    usuario = os.environ.get("SMTP_USUARIO", "").strip()
    clave = os.environ.get("SMTP_CLAVE", "").replace(" ", "").strip()
    host = os.environ.get("SMTP_HOST", "").strip() or "smtp.gmail.com"
    puerto = int(os.environ.get("SMTP_PUERTO", "").strip() or 587)
    msg = MIMEMultipart("alternative")
    msg["Subject"] = asunto
    msg["From"] = formataddr((nombre_remitente(), usuario))
    msg["To"] = formataddr((nombre or "", para))
    msg.attach(MIMEText("Abre este correo en un lector que muestre HTML.", "plain", "utf-8"))
    msg.attach(MIMEText(contenido, "html", "utf-8"))
    try:
        if puerto == 465:
            with smtplib.SMTP_SSL(host, puerto, timeout=30) as s:
                s.login(usuario, clave)
                s.sendmail(usuario, [para], msg.as_string())
        else:
            with smtplib.SMTP(host, puerto, timeout=30) as s:
                s.starttls()
                s.login(usuario, clave)
                s.sendmail(usuario, [para], msg.as_string())
        return True, f"smtp {host}"
    except Exception as e:  # noqa: BLE001
        print(f"Error enviando a {para} por SMTP: {e}", flush=True)
        return False, str(e)[:300]


def enviar(para, nombre, asunto, contenido):
    if os.environ.get("SMTP_USUARIO", "").strip():
        return enviar_smtp(para, nombre, asunto, contenido)
    clave = os.environ.get("BREVO_API_KEY", "").strip()
    remitente = os.environ.get("BREVO_REMITENTE", "").strip()
    if not clave or not remitente:
        print(f"[sin servicio de correo] {para}: {asunto}", flush=True)
        return False, "sin SMTP_USUARIO ni BREVO_API_KEY"
    datos = {
        "sender": {"name": nombre_remitente(), "email": remitente},
        "to": [{"email": para, "name": nombre or para}],
        "subject": asunto,
        "htmlContent": contenido,
    }
    req = urllib.request.Request("https://api.brevo.com/v3/smtp/email", data=json.dumps(datos).encode("utf-8"),
                                 headers={"api-key": clave, "Content-Type": "application/json", "Accept": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return True, r.read().decode("utf-8", "ignore")[:200]
    except Exception as e:  # noqa: BLE001
        detalle = e.read().decode("utf-8", "ignore")[:300] if hasattr(e, "read") else str(e)
        print(f"Error enviando a {para}: {detalle}", flush=True)
        return False, detalle


def usuario_vigente(u):
    activo = str(u.get("activo")).lower() in ("true", "t", "si", "sí", "1")
    vence = u.get("vence_el")
    if vence:
        try:
            if date.fromisoformat(str(vence)[:10]) < date.today():
                return False
        except ValueError:
            pass
    return activo and bool(u.get("email"))


def main():
    modo = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
    if modo not in ("alertas", "resumen"):
        print("Uso: python scraper/correos.py alertas|resumen")
        sys.exit(2)
    from supabase_client import is_supabase_configured, select, insert
    if not is_supabase_configured():
        print("Supabase no configurado.")
        return

    cadenas = select("dim_cadenas", "select=id,nombre,activo")
    activas = {str(c["id"]).lower() for c in cadenas if c.get("activo") is not False}
    nombres = {str(c["id"]).lower(): c.get("nombre") or c["id"] for c in cadenas}
    nombre_cadena = lambda cid: nombres.get(str(cid).lower(), cid)  # noqa: E731

    productos = {}
    for d in select("dim_productos", "select=id_interno,nombre,activo,dim_laboratorios(nombre,es_propio),dim_unidades_negocio(nombre),dim_categorias(nombre)"):
        if d.get("activo") is False or str(d.get("id_interno", "")).upper().startswith("COMP_"):
            continue
        if not (d.get("dim_laboratorios") or {}).get("es_propio"):
            continue
        productos[str(d["id_interno"])] = {
            "nombre": d.get("nombre"),
            "laboratorio": (d.get("dim_laboratorios") or {}).get("nombre"),
            "unidad_negocio": (d.get("dim_unidades_negocio") or {}).get("nombre"),
            "categoria": (d.get("dim_categorias") or {}).get("nombre"),
        }
    filas = filas_utiles(select("v_variacion", "select=*"), activas)
    usuarios = [u for u in select("usuarios", "select=*") if usuario_vigente(u)]
    hoy = (datetime.now(timezone.utc) - timedelta(hours=4)).date().isoformat()

    def visibles(u):
        alcance = u.get("alcance") if isinstance(u.get("alcance"), dict) else None
        return {pid: p for pid, p in productos.items() if en_alcance(p, alcance)}

    def anotar(u, tipo, asunto, ok, detalle):
        try:
            insert("correos_enviados", [{"email": u["email"], "tipo": tipo, "asunto": asunto, "ok": ok, "detalle": str(detalle)[:500]}])
        except Exception as e:  # noqa: BLE001
            print(f"No se anoto el correo: {e}", flush=True)

    enviados = 0
    if modo == "alertas":
        alertas = [a for a in select("alertas_usuario", "select=*&activa=eq.true")]
        previas = {(r["alerta_id"], r["publicacion_id"]) for r in select("alertas_enviadas", f"select=alerta_id,publicacion_id&fecha=eq.{hoy}")}
        for u in usuarios:
            if not u.get("recibe_alertas_inmediatas"):
                continue
            suyas = [a for a in alertas if norm(a.get("email")) == norm(u["email"])]
            if not suyas:
                continue
            vis = visibles(u)
            hits = evaluar_alertas(suyas, filas, previas, set(vis))
            if not hits:
                continue
            asunto, contenido = correo_alertas(u.get("nombre"), hits, nombre_cadena, vis)
            ok, detalle = enviar(u["email"], u.get("nombre"), asunto, contenido)
            anotar(u, "alertas", asunto, ok, detalle)
            if ok:
                enviados += 1
                insert("alertas_enviadas", [{"alerta_id": a["id"], "publicacion_id": f["publicacion_id"], "fecha": hoy} for a, f, _ in hits])
    else:
        viejos_por_prod = {}
        for v in select("v_precios_viejos", "select=id_producto_propio"):
            viejos_por_prod[str(v.get("id_producto_propio"))] = viejos_por_prod.get(str(v.get("id_producto_propio")), 0) + 1
        for u in usuarios:
            if not u.get("recibe_resumen_diario"):
                continue
            vis = visibles(u)
            perdiste, ganaste, cambios, mas_barato = resumen_semanal(filas, vis)
            viejos = sum(n for pid, n in viejos_por_prod.items() if pid in vis)
            asunto, contenido = correo_resumen(u.get("nombre"), perdiste, ganaste, cambios, mas_barato, len(vis), viejos)
            ok, detalle = enviar(u["email"], u.get("nombre"), asunto, contenido)
            anotar(u, "resumen", asunto, ok, detalle)
            enviados += int(ok)
    print(f"Correos de {modo} enviados: {enviados}", flush=True)


if __name__ == "__main__":
    main()
