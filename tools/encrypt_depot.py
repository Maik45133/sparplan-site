#!/usr/bin/env python3
"""Verschlüsselt data/depot.json zu data/depot.enc und baut gleich data/depot_live.enc.

Nur Chiffretext wird veröffentlicht. Das Passwort verlässt diesen Rechner nicht
und steht nirgends in diesem Repo. Für den Sonntagslauf liegt es zusätzlich als
GitHub-Secret DEPOT_PASSWORT bereit.

    python3 tools/encrypt_depot.py [pfad/zur/depot.json]

Format der Ausgabe, damit der Browser es ohne Bibliothek lesen kann:
    {"v":2,"kdf":"PBKDF2-SHA256","iter":210000,"salt":b64,"iv":b64,"ct":b64}
AES-256-GCM, das Authentifizierungs-Tag hängt hinten am Chiffretext, genau so
erwartet es WebCrypto.
"""
from __future__ import annotations

import base64
import getpass
import json
import os
import sys
from pathlib import Path

ITER = 210_000
HIER = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))


def main() -> None:
    try:
        import app_daten
        app_daten._aes()
    except ImportError:
        sys.exit("Fehlt: cryptography. Einmalig installieren mit:\n"
                 "  python3 -m pip install --user cryptography")

    quelle = Path(sys.argv[1]) if len(sys.argv) > 1 else HIER / "data" / "depot.json"
    if not quelle.exists():
        sys.exit(f"Nicht gefunden: {quelle}")
    daten = json.loads(quelle.read_text(encoding="utf-8"))
    print(f"Gelesen: {quelle}")
    print(f"  {len(daten.get('positionen', daten.get('holdings', [])))} Positionen, Stand {daten.get('stand', '?')}")

    pw = getpass.getpass("Passwort: ")
    if len(pw) < 5:
        sys.exit("Mindestens 5 Zeichen. Diese Seite ist öffentlich erreichbar.")
    if pw != getpass.getpass("Wiederholen: "):
        sys.exit("Stimmt nicht überein.")

    salt = base64.b64encode(os.urandom(16)).decode()
    box = app_daten.verschluesseln(daten, pw, salt, ITER)
    ziel = HIER / "data" / "depot.enc"
    ziel.write_text(json.dumps(box), encoding="utf-8")
    print(f"Geschrieben: {ziel}")

    print("Hole aktuelle Kurse für das Depot ...")
    latest = json.loads((HIER / "data" / "latest.json").read_text(encoding="utf-8"))
    if app_daten.depot_bauen(pw, latest):
        print("Geschrieben: data/depot_live.enc")
    print("Die Klartext-depot.json gehört NICHT ins Repo, .gitignore hält sie raus.")


if __name__ == "__main__":
    main()
