"""
Cliente de Firebase compartido.

Lee la credencial desde la variable de entorno FIREBASE_SERVICE_ACCOUNT
(que contiene el JSON completo del service account).

En GitHub Actions y Codespaces esa variable la inyecta el secret
que creamos en Settings.
"""

import json
import os
import sys

import firebase_admin
from firebase_admin import credentials, firestore


_db = None


def get_db():
    """
    Devuelve un cliente Firestore listo para usar.
    La conexión se cachea: si llamas get_db() dos veces, no reconecta.
    """
    global _db
    if _db is not None:
        return _db

    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT")
    if not raw:
        print(
            "============================================================"
            "\nERROR: Faltan las credenciales de Firebase (FIREBASE_SERVICE_ACCOUNT).\n"
            "\nPara resolver esto en GitHub Actions:\n"
            "1. Ve a tu proyecto en Firebase Console -> Configuración de proyecto -> Cuentas de servicio.\n"
            "2. Haz clic en 'Generar nueva clave privada' (descargará un archivo .json).\n"
            "3. En tu repositorio de GitHub, ve a: Settings -> Secrets and variables -> Actions -> New repository secret.\n"
            "4. Nombre del Secret: FIREBASE_SERVICE_ACCOUNT\n"
            "5. Valor: Pega todo el contenido del archivo .json descargado.\n"
            "============================================================",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        service_account_info = json.loads(raw)
    except json.JSONDecodeError as e:
        print(f"ERROR: FIREBASE_SERVICE_ACCOUNT no es JSON válido: {e}", file=sys.stderr)
        sys.exit(1)

    cred = credentials.Certificate(service_account_info)
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    _db = firestore.client()
    return _db
