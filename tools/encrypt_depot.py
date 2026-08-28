#!/usr/bin/env python3
"""Verschlüsselt data/depot.json zu data/depot.enc.

Nur der Chiffretext wird veröffentlicht. Das Passwort verlässt diesen Rechner nicht
und steht nirgends in diesem Repo. Wer es verliert, verschlüsselt neu, mehr nicht.

    python3 tools/encrypt_depot.py [pfad/zur/depot.json]

Format der Ausgabe, damit der Browser es ohne Bibliothek lesen kann:
    {"v":1,"kdf":"PBKDF2-SHA256","iter":210000,"salt":b64,"iv":b64,"ct":b64}
AES-256-GCM, das Authentifizierungs-Tag hängt hinten am Chiffretext, genau so
erwartet es WebCrypto.
"""
from __future__ import annotations

import base64
import getpass
import hashlib
import json
import os
import sys
from pathlib import Path

ITER = 210_000
HIER = Path(__file__).resolve().parent.parent


def aes_gcm(key: bytes, iv: bytes, klartext: bytes) -> bytes:
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:
        sys.exit("Fehlt: cryptography. Einmalig installieren mit:\n"
                 "  python3 -m pip install --user cryptography")
    return AESGCM(key).encrypt(iv, klartext, None)


def main() -> None:
    quelle = Path(sys.argv[1]) if len(sys.argv) > 1 else HIER / "data" / "depot.json"
    if not quelle.exists():
        sys.exit(f"Nicht gefunden: {quelle}\n"
                 f"Kopiere die depot.json aus dem sparplan-Repo hierher oder gib den Pfad an.")

    daten = json.loads(quelle.read_text(encoding="utf-8"))
    print(f"Gelesen: {quelle}")
    print(f"  {len(daten.get('holdings', []))} Positionen")

    pw = getpass.getpass("Passwort: ")
    if len(pw) < 8:
        sys.exit("Mindestens 8 Zeichen. Diese Seite ist öffentlich erreichbar.")
    if pw != getpass.getpass("Wiederholen: "):
        sys.exit("Stimmt nicht überein.")

    salt = os.urandom(16)
    iv = os.urandom(12)
    key = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, ITER, dklen=32)
    ct = aes_gcm(key, iv, json.dumps(daten, ensure_ascii=False).encode())

    b = lambda x: base64.b64encode(x).decode()
    ziel = HIER / "data" / "depot.enc"
    ziel.write_text(json.dumps({
        "v": 1, "kdf": "PBKDF2-SHA256", "iter": ITER,
        "salt": b(salt), "iv": b(iv), "ct": b(ct),
    }), encoding="utf-8")

    print(f"Geschrieben: {ziel} ({ziel.stat().st_size} Bytes)")
    print("Die Klartext-depot.json gehört NICHT in dieses Repo, .gitignore hält sie raus.")


if __name__ == "__main__":
    main()
