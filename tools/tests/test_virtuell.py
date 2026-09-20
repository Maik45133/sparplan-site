"""Selbsttest fuer tools/virtuell.py, ohne Netz.

Kurse und Wechselkurse werden durch feste Werte ersetzt, damit jede Rechnung
von Hand nachpruefbar ist. Geprueft werden die Stellen, an denen sich ein
Denkfehler nicht von selbst zeigen wuerde: Stueckzahl nach Kosten,
Waehrungseffekt, Ueberrendite in Dollar statt in Euro, der Volatilitaetsstop,
das Datumsfeld im Issue, die Groessengrenze auf der Kaufseite und die Regel,
dass ein fehlgeschlagener Abruf alte Werte stehen laesst.
"""
import datetime as dt
import json
import sys
import tempfile
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


def pruefe_gleich(name, ist, soll):
    ok = ist == soll
    print(("  ok   " if ok else "  FEHL ") + f"{name}: ist={ist} soll={soll}")
    if not ok:
        FEHLER.append(name)


print(f"Kostensatz je Seite: {V.KOSTEN_PCT_JE_SEITE:.4f} %")
# 1 Euro Gebuehr auf 100 Euro Ordergroesse sind 1,00 %, plus 0,25 % Spread.
pruefe("Kostensatz je Seite", V.KOSTEN_PCT_JE_SEITE, 1.25)

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

print("Bewertung mit Kosten")
V.bewerte(depot)
a, b = depot["positionen"]

# Investiert werden 1000 minus 1,25 % Kaufkosten, also 987,50 Euro.
# 987,50 / (100 USD * 0,90) = 10,972222 Stueck.
pruefe("Stueckzahl nach Kaufkosten", a["stueck"], 10.9722, 0.001)
# Bruttowert: 10,972222 * 130 * 1,00 = 1426,39 Euro.
pruefe("Bruttowert", a["brutto_wert_eur"], 1426.39, 0.05)
# Nettowert nach Verkaufskosten: 1426,39 * 0,9875 = 1408,56 Euro.
pruefe("Wert nach allen Kosten", a["wert_eur"], 1408.56, 0.05)
pruefe("Rendite netto", a["rendite_pct"], 40.86, 0.05)
pruefe("Rendite brutto", a["brutto_rendite_pct"], 42.64, 0.05)
# Die Kosten kosten hier rund 1,8 Punkte Rendite.
pruefe("Kostenlast in Punkten", a["kostenlast_pct"], -1.78, 0.05)
pruefe("Kurs allein in Dollar", a["kurs_pct"], 30.0)
pruefe("Waehrungseffekt", a["waehrungseffekt_pct"], 12.64, 0.05)
pruefe("Benchmarkrendite", a["benchmark_pct"], 10.0)
# Brutto: 30 minus 10 gleich 20 Punkte, ausdruecklich nicht 42,6 minus 10.
pruefe("Ueberrendite brutto", a["excess_pct"], 20.0)
# Nach Kosten: (0,9875^2 * 1,3 - 1) = 26,77 %, minus 10 gleich 16,77.
pruefe("Ueberrendite nach Kosten", a["excess_netto_pct"], 16.77, 0.05)
pruefe("Haltedauer in Tagen", float(a["tage"]), 10.0)

print("Ausfall eines Abrufs")
pruefe("alter Wert bleibt", b["wert_eur"], 1234.0)
pruefe("alte Rendite bleibt", b["rendite_pct"], 23.4)
pruefe_gleich("als veraltet markiert", bool(b.get("veraltet")), True)

print("Delisteter Titel gilt nicht als aktuell")
# Letzter Kurs vier Wochen alt: kein eingefrorener Stand, sondern kein Kurs.
pruefe_gleich("alte Reihe ergibt None",
              V.kurs_frisch({"2026-08-10": 50.0}), None)
pruefe_gleich("frische Reihe ergibt Kurs",
              V.kurs_frisch({"2026-09-09": 50.0}), ("2026-09-09", 50.0))

print("Volatilitaetsstop")
# Zwanzig Tage gleichmaessig plus eins, danach ein Einbruch auf 80.
tage = [dt.date(2026, 9, 1) + dt.timedelta(days=i) for i in range(21)]
ruhig = {t.isoformat(): 100.0 + i for i, t in enumerate(tage)}
pruefe("mittlere Tagesschwankung", V.mittlere_tagesschwankung(ruhig, tage[-1].isoformat()), 1.0)
pruefe_gleich("steigende Reihe loest nicht aus",
              V.stop_pruefen({"opened": tage[0].isoformat()}, ruhig), None)

absturz = dict(ruhig)
absturz[(tage[-1] + dt.timedelta(days=1)).isoformat()] = 80.0
treffer = V.stop_pruefen({"opened": tage[0].isoformat()}, absturz)
pruefe_gleich("Einbruch loest aus", treffer is not None, True)
if treffer:
    pruefe_gleich("am Tag des Einbruchs", treffer["tag"], "2026-09-22")
    pruefe("zum Einbruchskurs", treffer["kurs"], 80.0)
    pruefe("Hoechststand gemerkt", treffer["hoechster"], 120.0)

print("Datumsfeld im Issue")
pruefe_gleich("gueltiges Datum", V.datum_aus_text("Datum: 2026-09-11", "2026-09-13"), "2026-09-11")
pruefe_gleich("Kleinschreibung", V.datum_aus_text("datum 2026-09-11", "2026-09-13"), "2026-09-11")
# So rendert GitHub ein Formularfeld: Ueberschrift, Leerzeile, Wert.
pruefe_gleich("GitHub-Formular", V.datum_aus_text(
    "### Datum der Aeusserung\n\n2026-09-11\n\n### Notiz\n\nTruth-Post", "2026-09-13"),
    "2026-09-11")
# Ohne Feldangabe wird das erste Datum im Text genommen.
pruefe_gleich("Datum nur im Fliesstext", V.datum_aus_text(
    "### Datum\n\n_No response_\n\n### Notiz\n\nPost vom 2026-09-12", "2026-09-13"),
    "2026-09-12")
pruefe_gleich("kein Datum", V.datum_aus_text("Truth-Post heute morgen", "2026-09-13"), None)
# Ein Datum in der Zukunft waere Rueckschau, eines vor 40 Tagen ein Nachtrag,
# der nicht mehr zu der Aeusserung gehoert.
pruefe_gleich("Zukunft abgelehnt", V.datum_aus_text("Datum: 2026-09-20", "2026-09-13"), None)
pruefe_gleich("zu weit zurueck abgelehnt", V.datum_aus_text("Datum: 2026-07-01", "2026-09-13"), None)

print("Groessengrenze auf der Kaufseite")
def dossier(sym, score, cap, name=None):
    return {"candidate": {"symbol": sym, "name": name or sym, "sector": "Tech",
                          "market_cap": cap},
            "scorecard": {"total": score, "reliable": True}, "price": 10.0,
            "industry": "Semiconductors"}

print("Kaufgrenzen je Korb")
pruefe_gleich("klein bleibt bei 20 Mrd", V.kaufgrenze("klein"), 20e9)
pruefe_gleich("gross erlaubt bis 1 Bio", V.kaufgrenze("gross"), 1_000e9)
pruefe_gleich("frueh erlaubt bis 1 Bio", V.kaufgrenze("frueh"), 1_000e9)
# Ein unbekannter Korb faellt auf den vorsichtigen Wert zurueck, nicht auf
# den groesszuegigsten. Ein Tippfehler im Korbnamen soll nichts freigeben.
pruefe_gleich("unbekannter Korb faellt vorsichtig zurueck",
              V.kaufgrenze("tippfehler"), 20e9)

with tempfile.TemporaryDirectory() as tmp:
    pfad = Path(tmp) / "latest.json"
    pfad.write_text(json.dumps({
        "generated_at": "2026-09-10T09:00:00",
        # MID hat 400 Mrd. Im Korb "frueh" ist das erlaubt, im Korb "klein"
        # waere es das nicht. Genau daran haengt die Entscheidung vom
        # 20.09.2026: die Grenze gehoert zum Korb, nicht zum ganzen Verfahren.
        "dossiers": [dossier("SMALL", 70.0, 5e9)],
        "dossiers_large_cap": [dossier("MEGA", 80.0, 2_000e9), dossier("NEXT", 75.0, 3e9)],
        "dossiers_early_bets": [dossier("MID", 64.0, 400e9)],
    }), encoding="utf-8")
    V.LATEST_DATEI = pfad
    d2 = {"positionen": [], "einsatz_eur": 1000.0, "hinweise": []}
    meldungen = V.aus_screening(d2)
    syms = [p["symbol"] for p in d2["positionen"]]
    pruefe_gleich("jeder Korb kauft nach seiner eigenen Grenze",
                  sorted(syms), ["MID", "SMALL"])
    pruefe_gleich("ueber der eigenen Korbgrenze wird uebersprungen",
                  "MEGA" in syms, False)
    pruefe_gleich("kein Nachruecken auf den Zweitbesten", "NEXT" in syms, False)
    pruefe_gleich("Grund steht im Protokoll",
                  any("ueber der Kaufgrenze" in m for m in meldungen), True)
    pruefe_gleich("Branche wandert mit", d2["positionen"][0]["branche"], "Semiconductors")
    pruefe_gleich("Eroeffnung ist heute, nicht der Datenstand",
                  d2["positionen"][0]["opened"], "2026-09-11")
    pruefe_gleich("Datenstand separat vermerkt",
                  d2["positionen"][0]["datenstand"], "2026-09-10")

print("Summen")
V.summiere(depot)
s = depot["summe"]
pruefe("gesamt Einsatz", s["gesamt"]["einsatz_eur"], 2000.0)
pruefe("trump Rendite", s["trump"]["rendite_pct"], 40.86, 0.05)
pruefe("trump Ueberrendite nach Kosten", s["trump"]["median_excess_pct"], 16.77, 0.05)
pruefe_gleich("trump schlaegt Benchmark", s["trump"]["besser_als_benchmark"], 1)

print("Tickererkennung")
for titel, soll in [("NVDA kaufen laut Truth-Post", "NVDA"), ("  aapl  ", "AAPL"),
                    ("BRK.B", "BRK.B"), ("", "")]:
    pruefe_gleich(f"{titel!r}", V.ticker_aus_titel(titel), soll)

print("Kurs am Wochenende nimmt den Tag davor, nie danach")
pruefe("Sonntagseinstand", V.kurs_am(REIHEN["NVDA"], "2026-09-07"), 100.0)

print()
if FEHLER:
    print("FEHLGESCHLAGEN: " + ", ".join(FEHLER))
    raise SystemExit(1)
print("alle Pruefungen bestanden")
