"""Selbsttest fuer tools/virtuell.py, ohne Netz.

Kurse und Wechselkurse werden durch feste Werte ersetzt, damit jede
Rechnung von Hand nachpruefbar ist. Der Test prueft genau die Stellen, an
denen sich ein Denkfehler nicht von selbst zeigen wuerde: Stueckzahl,
Waehrungseffekt, Ueberrendite in Dollar statt in Euro, und dass ein
fehlgeschlagener Abruf alte Werte stehen laesst.
"""
import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import virtuell as V  # noqa: E402

FEHLER = []


def pruefe(name, ist, soll, tol=0.01):
    ok = (ist is None and soll is None) or (
        ist is not None and soll is not None and abs(ist - soll) <= tol)
    print(("  ok   " if ok else "  FEHL ") + f"{name}: ist={ist} soll={soll}")
    if not ok:
        FEHLER.append(name)


# ── feste Kurse ──────────────────────────────────────────────────────────
REIHEN = {
    "NVDA":  {"2026-09-01": 100.0, "2026-09-11": 130.0},
    "^GSPC": {"2026-09-01": 5000.0, "2026-09-11": 5500.0},
    "PLTR":  {},          # simuliert einen Abruf ohne Ergebnis
    "IWO":   {"2026-09-01": 400.0, "2026-09-11": 410.0},
}
FX = {"2026-09-01": 0.90, "latest": 1.00}

V.kursreihe = lambda sym, a, e: REIHEN.get(sym, {})
V.fx_eur_je_usd = lambda d=None: FX.get(d or "latest")
V.heute = lambda: dt.date(2026, 9, 11)

depot = {
    "einsatz_eur": 1000.0,
    "positionen": [
        {"id": "a", "symbol": "NVDA", "name": "Nvidia", "quelle": "trump",
         "korb": None, "opened": "2026-09-01", "benchmark_symbol": "^GSPC",
         "status": "offen"},
        {"id": "b", "symbol": "PLTR", "name": "Palantir", "quelle": "score",
         "korb": "gross", "opened": "2026-09-01", "benchmark_symbol": "^GSPC",
         "status": "offen",
         # Werte aus einem frueheren Lauf, die erhalten bleiben muessen
         "wert_eur": 1234.0, "rendite_pct": 23.4, "entry_price_usd": 50.0},
    ],
    "summe": {}, "hinweise": [],
}

print("Bewertung")
V.bewerte(depot)
a, b = depot["positionen"]

# Einsatz 1000 EUR, Einstand 100 USD, FX 0,90 EUR je USD
# -> 1000 / (100 * 0,90) = 11,1111 Stueck
pruefe("Stueckzahl", a["stueck"], 11.1111, 0.001)
# Wert jetzt: 11,1111 * 130 USD * 1,00 = 1444,44 EUR
pruefe("Wert in Euro", a["wert_eur"], 1444.44, 0.05)
pruefe("Rendite in Euro", a["rendite_pct"], 44.44, 0.05)
# Kurs allein: 130/100 - 1 = 30 %
pruefe("Kursrendite in Dollar", a["kurs_pct"], 30.0)
# Waehrungseffekt: 44,44 - 30 = 14,44 Punkte
pruefe("Waehrungseffekt", a["waehrungseffekt_pct"], 14.44, 0.05)
# Benchmark 5000 -> 5500 = 10 %; Ueberrendite 30 - 10 = 20 Punkte,
# ausdruecklich NICHT 44,44 - 10
pruefe("Benchmarkrendite", a["benchmark_pct"], 10.0)
pruefe("Ueberrendite in Dollar", a["excess_pct"], 20.0)
pruefe("Haltedauer in Tagen", float(a["tage"]), 10.0)

print("Ausfall eines Abrufs")
pruefe("alter Wert bleibt", b["wert_eur"], 1234.0)
pruefe("alte Rendite bleibt", b["rendite_pct"], 23.4)
print(("  ok   " if b.get("veraltet") else "  FEHL ") + "als veraltet markiert")
if not b.get("veraltet"):
    FEHLER.append("veraltet")

print("Summen")
V.summiere(depot)
s = depot["summe"]
# Nur NVDA hat gueltige Werte, PLTR zaehlt mit seinem alten Wert mit
pruefe("gesamt Einsatz", s["gesamt"]["einsatz_eur"], 2000.0)
pruefe("trump Rendite", s["trump"]["rendite_pct"], 44.44, 0.05)
pruefe("trump Ueberrendite Median", s["trump"]["median_excess_pct"], 20.0)
print(("  ok   " if s["trump"]["besser_als_benchmark"] == 1 else "  FEHL ")
      + "trump schlaegt Benchmark: " + str(s["trump"]["besser_als_benchmark"]))

print("Tickererkennung")
for titel, soll in [("NVDA kaufen laut Truth-Post", "NVDA"), ("  aapl  ", "AAPL"),
                    ("BRK.B", "BRK.B"), ("", "")]:
    ist = V.ticker_aus_titel(titel)
    print(("  ok   " if ist == soll else "  FEHL ") + f"{titel!r} -> {ist!r}")
    if ist != soll:
        FEHLER.append("ticker " + titel)

print("Kurs am Wochenende nimmt den Tag davor, nie danach")
pruefe("Sonntagseinstand", V.kurs_am(REIHEN["NVDA"], "2026-09-07"), 100.0)

print()
if FEHLER:
    print("FEHLGESCHLAGEN: " + ", ".join(FEHLER))
    raise SystemExit(1)
print("alle Pruefungen bestanden")
