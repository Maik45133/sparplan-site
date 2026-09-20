#!/usr/bin/env python3
"""Virtuelles Depot: Motor fuer data/virtual_portfolio.json.

Laeuft woechentlich in GitHub Actions, nicht auf Maiks Mac und nicht in
Cowork. Grund: Beide Arbeitsumgebungen erreichen keine Kursquelle, die
Actions-Runner dagegen haben offenes Netz. Der Lauf enthaelt keinen KI-Aufruf,
verbraucht also keine Claude-Credits, und oeffentliche Repos haben unbegrenzte
Actions-Minuten.

Was der Lauf tut, in dieser Reihenfolge:

1. Offene GitHub-Issues mit Label `trump`, `kauf` oder `verkauf` einlesen.
2. Den besten Titel je Korb aus data/latest.json aufnehmen, sofern er unter
   der Marktkapitalisierungsgrenze liegt.
3. Fuer jede Position Einstandskurs, aktuellen Kurs, Benchmarkstand und
   Wechselkurs holen.
4. Den Volatilitaetsstop pruefen und ueberschrittene Positionen schliessen.
5. Rendite nach Kosten, Benchmarkrendite, Ueberrendite und Waehrungseffekt
   rechnen und alles zurueckschreiben.

Grundsaetze, die den Rest des Codes erklaeren
---------------------------------------------
**Ein fehlgeschlagener Abruf darf nie gute Daten ueberschreiben.** Kommt kein
Kurs, bleiben die Werte des letzten Laufs stehen und die Position wird als
`veraltet` markiert.

**Ueberrendite wird in Dollar gerechnet, nicht in Euro.** Der Benchmark
notiert in Dollar. Wer die eigene Euro-Rendite gegen eine Dollar-Rendite
haelt, misst zur Haelfte den Wechselkurs und nennt es Auswahlqualitaet. Der
Waehrungseffekt steht als eigene Zahl daneben.

**Gebuehren und Spread werden mitgerechnet.** Bei hundert Euro Ordergroesse
ist die Ordergebuehr der groesste einzelne Posten der ganzen Rechnung. Ein
virtuelles Depot ohne Kosten zeigt eine Zahl, die es in echt nie gibt, und
genau diese Zahl waere die Entscheidungsgrundlage fuer echtes Geld.

**Der Einstand wird nie zurueckdatiert, ausser auf ausdrueckliche Angabe.**
Wer heute mit heutigem Wissen auswaehlt, muss sich ab heute beweisen.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from kurse import UA, fx_eur_je_usd, kurs_am, kurs_zuletzt, kursreihe, log

ROOT = Path(__file__).resolve().parent.parent
PORTFOLIO_DATEI = ROOT / "data" / "virtual_portfolio.json"
LATEST_DATEI = ROOT / "data" / "latest.json"

# Einheitlich 1.000 Euro je Position, gleichgewichtet, damit die
# Gesamtrendite der ehrliche Durchschnitt der Auswahl ist und nicht das
# Ergebnis zufaelliger Stueckzahlen.
EINSATZ_EUR = 1000.0

# ── Kosten ───────────────────────────────────────────────────────────────
#
# Angenommen, nicht gemessen. Die drei Zahlen stehen hier oben, damit Maik sie
# gegen die echten Konditionen seines Brokers tauschen kann.
#
# Wichtig ist der Bezug: Die Kostenquote wird auf die Ordergroesse gerechnet,
# die er WIRKLICH handeln will, nicht auf die tausend Euro der virtuellen
# Position. Bei einer festen Ordergebuehr von einem Euro macht das den
# Unterschied zwischen 1,0 Prozent (bei 100 Euro) und 0,1 Prozent (bei 1.000
# Euro), also den Unterschied zwischen "Kosten entscheiden" und "Kosten sind
# eine Fussnote".
ECHTE_ORDERGROESSE_EUR = 100.0
ORDERGEBUEHR_EUR = 1.0
# Halbe Geld-Brief-Spanne je Seite. Fuer US-Nebenwerte an einem deutschen
# Handelsplatz ausserhalb der US-Handelszeit eher zu niedrig als zu hoch.
SPREAD_PCT_JE_SEITE = 0.25

KOSTEN_PCT_JE_SEITE = ORDERGEBUEHR_EUR / ECHTE_ORDERGROESSE_EUR * 100 + SPREAD_PCT_JE_SEITE
K = KOSTEN_PCT_JE_SEITE / 100  # Kurzform fuer die Rechnung

# ── Auswahl ──────────────────────────────────────────────────────────────
#
# Top 1 je Korb. Bewusst scharf: das Score-Register unter
# data/score_register.json haelt weiterhin ALLE Kandidaten fest, dort laesst
# sich die Qualitaet der Rangfolge messen, ohne dafuer Positionen zu brauchen.
NEU_JE_KORB = 1

# Obergrenze fuer die Kaufseite, je Korb.
#
# Eine einzige Grenze von zwanzig Milliarden fuer alle Koerbe war ein
# Denkfehler: Der Korb "Grosse Werte" faengt per Definition bei zwanzig
# Milliarden an und lag damit immer darueber. Kein Titel daraus konnte je
# gekauft werden, und der Korb produzierte jede Woche nur einen
# Uebersprungen-Hinweis. Eine Regel, die einen ganzen Korb stilllegt, gehoert
# nicht aus zwei Konstanten abgeleitet, sondern entschieden.
#
# Entschieden am 20.09.2026: Jeder Korb bekommt seine eigene Grenze.
#
# "klein" behaelt zwanzig Milliarden, das ist die Obergrenze der Korbdefinition
# selbst, die Grenze faengt dort also nur noch Datenfehler ab.
#
# "gross" und "frueh" bekommen eine Billion. Diese Zahl ist eine Setzung, keine
# Messung, und sie soll auch nicht als eine gelesen werden. Der Gedanke
# dahinter: Ueber einer Billion stehen die wenigen groessten Unternehmen der
# Welt. Dass ein Screening-Verfahren dort einen Vorsprung findet, ist
# unwahrscheinlich, und die erwartete Wachstumsrate faellt mit der Groesse, das
# ist einer der bestbelegten Zusammenhaenge am Aktienmarkt. Darunter bleibt
# alles kaufbar, was sich realistisch noch verdoppeln kann.
#
# Der Preis dieser Entscheidung, offen benannt: Titel wie NVDA oder GOOGL
# erscheinen weiter im Screening, koennen aber nie ins virtuelle Depot. Wer
# sie messen will, hebt die Grenze fuer den jeweiligen Korb an.
MAX_MARKTKAPITAL_KAUF = {
    "klein": 20e9,
    "gross": 1_000e9,
    "frueh": 1_000e9,
}
MAX_MARKTKAPITAL_KAUF_STANDARD = 20e9   # fuer einen Korb ohne eigenen Eintrag


def kaufgrenze(korb: str) -> float:
    """Obergrenze der Marktkapitalisierung fuer die Kaufseite dieses Korbs."""
    return MAX_MARKTKAPITAL_KAUF.get(korb, MAX_MARKTKAPITAL_KAUF_STANDARD)

KOERBE = {
    "klein": {"feld": "dossiers", "benchmark": "IWO", "titel": "Wachstum"},
    "gross": {"feld": "dossiers_large_cap", "benchmark": "^GSPC", "titel": "Grosse Werte"},
    "frueh": {"feld": "dossiers_early_bets", "benchmark": "IWO", "titel": "Fruehphase"},
}

# Trump-Titel sind fast ausnahmslos Standardwerte, deshalb S&P 500 als
# Messlatte. Der Russell 2000 Growth waere hier die falsche Vergleichsgroesse.
TRUMP_BENCHMARK = "^GSPC"

BENCHMARK_NAME = {"IWO": "Russell 2000 Growth", "^GSPC": "S&P 500"}

LABELS = {"trump": "trump", "kauf": "score", "verkauf": "verkauf"}

# ── Volatilitaetsstop ────────────────────────────────────────────────────
#
# Ein fester Zehn-Prozent-Stop ist bei sechzig Prozent Jahresvolatilitaet ein
# Zufallsgenerator: er feuert bei einem ruhigen Titel nie und bei einem
# unruhigen staendig. Der Abstand richtet sich deshalb nach der tatsaechlichen
# Schwankung des Titels.
#
# Gemessen wird die mittlere absolute Tagesveraenderung von Schluss zu
# Schluss, nicht die echte True Range: die Kursquelle hier liefert nur
# Schlusskurse. Das unterschaetzt die Schwankung leicht, der Stop sitzt damit
# etwas enger als ein ATR-Stop. Bewusst so gelassen, weil ein zu enger Stop
# nur Rendite kostet, ein zu weiter dagegen den Zweck verfehlt.
STOP_FAKTOR = 2.5
STOP_FENSTER = 20

# Groesste Luecke, die ein Kurs haben darf, um noch als aktuell zu gelten.
# Ein delisteter Titel behaelt in der Kursreihe fuer immer seinen letzten
# Kurs. Ohne diese Pruefung stuende eine eingefrorene Position mit einer
# sauberen Nullrendite im Depot, statt als das erkennbar zu sein, was sie ist.
MAX_KURSLUECKE_TAGE = 7


def heute() -> dt.date:
    return dt.date.today()


def kurs_frisch(reihe: dict[str, float]) -> tuple[str, float] | None:
    """Letzter Kurs, aber nur wenn er nicht aelter als MAX_KURSLUECKE_TAGE ist."""
    letzter = kurs_zuletzt(reihe)
    if letzter is None:
        return None
    tag, kurs = letzter
    try:
        alter = (heute() - dt.date.fromisoformat(tag)).days
    except ValueError:
        return None
    return None if alter > MAX_KURSLUECKE_TAGE else (tag, kurs)


# ── GitHub-Issues als Eingabekanal ───────────────────────────────────────

LABEL_FARBEN = {
    "trump": ("d73a4a", "Trump hat oeffentlich zu diesem Titel geraten"),
    "kauf": ("0e8a16", "Von Hand ins virtuelle Depot aufnehmen"),
    "verkauf": ("5319e7", "Offene Position im virtuellen Depot schliessen"),
}


def _gh_kopf() -> dict | None:
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        return None
    return {**UA, "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json"}


def labels_sicherstellen() -> None:
    """Die drei Label muessen im Repo existieren, sonst vergibt GitHub sie beim
    Anlegen eines Issues stillschweigend nicht und der Einwurf vom Handy landet
    nirgends."""
    kopf, repo = _gh_kopf(), os.environ.get("GITHUB_REPOSITORY")
    if not kopf or not repo:
        return
    for name, (farbe, text) in LABEL_FARBEN.items():
        nutzlast = json.dumps({"name": name, "color": farbe, "description": text})
        req = urllib.request.Request(
            f"https://api.github.com/repos/{repo}/labels",
            data=nutzlast.encode("utf-8"), headers=kopf, method="POST")
        try:
            urllib.request.urlopen(req, timeout=30).read()
            log(f"Label '{name}' angelegt.")
        except urllib.error.HTTPError as e:
            if e.code != 422:  # 422 heisst: gibt es schon
                log(f"Label '{name}': {e}")
        except Exception as e:  # noqa: BLE001
            log(f"Label '{name}': {e}")


def github_issues() -> list[dict]:
    kopf, repo = _gh_kopf(), os.environ.get("GITHUB_REPOSITORY")
    if not kopf or not repo:
        log("Kein GITHUB_TOKEN/GITHUB_REPOSITORY, Issues werden uebersprungen.")
        return []
    url = f"https://api.github.com/repos/{repo}/issues?state=open&per_page=100"
    try:
        with urllib.request.urlopen(
                urllib.request.Request(url, headers=kopf), timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        log(f"Issues nicht abrufbar: {e}")
        return []


def issue_schliessen(nummer: int, kommentar: str) -> None:
    kopf, repo = _gh_kopf(), os.environ.get("GITHUB_REPOSITORY")
    if not kopf or not repo:
        return
    try:
        urllib.request.urlopen(urllib.request.Request(
            f"https://api.github.com/repos/{repo}/issues/{nummer}/comments",
            data=json.dumps({"body": kommentar}).encode("utf-8"),
            headers=kopf, method="POST"), timeout=30).read()
        urllib.request.urlopen(urllib.request.Request(
            f"https://api.github.com/repos/{repo}/issues/{nummer}",
            data=json.dumps({"state": "closed"}).encode("utf-8"),
            headers=kopf, method="PATCH"), timeout=30).read()
    except Exception as e:  # noqa: BLE001
        log(f"Issue #{nummer} konnte nicht geschlossen werden: {e}")


def ticker_aus_titel(titel: str) -> str:
    """Erstes Wort, Buchstaben, Ziffern, Punkt und Bindestrich."""
    roh = (titel or "").strip().split()
    if not roh:
        return ""
    return "".join(c for c in roh[0] if c.isalnum() or c in ".-^").upper()


ISO_DATUM = re.compile(r"(\d{4}-\d{2}-\d{2})")


def datum_aus_text(text: str, spaetestens: str) -> str | None:
    """Sucht das Einstandsdatum im Issue-Text.

    Warum das noetig ist: Ohne Angabe wird der Einstand auf den Tag gesetzt, an
    dem das Issue entsteht. Bekommt Maik eine oeffentliche Aeusserung erst drei
    Tage spaeter mit, kauft er zu einem Kurs, der die Reaktion bereits enthaelt,
    und die Trump-Komponente sieht schlechter aus, als sie ist.

    Gesucht wird bewusst grosszuegig: GitHub rendert das Formularfeld als
    Ueberschrift plus Wert in zwei Zeilen, ein Muster wie "Datum: TT.MM." wuerde
    das nie treffen. Genommen wird das erste ISO-Datum nach dem Wort "Datum",
    sonst das erste ISO-Datum ueberhaupt.

    Andersherum waere ein frei waehlbares Datum ein Einfallstor fuer
    Rueckschau, deshalb zaehlt nur ein Datum in der Vergangenheit und
    hoechstens 30 Tage zurueck. Alles andere wird still verworfen und der Tag
    des Issues genommen.
    """
    if not text:
        return None
    start = 0
    stelle = text.lower().find("datum")
    if stelle >= 0:
        start = stelle
    treffer = ISO_DATUM.search(text, start) or ISO_DATUM.search(text)
    if not treffer:
        return None
    try:
        d = dt.date.fromisoformat(treffer.group(1))
        grenze = dt.date.fromisoformat(spaetestens)
    except ValueError:
        return None
    if d > grenze or (grenze - d).days > 30:
        return None
    return d.isoformat()


# ── Depot lesen und schreiben ────────────────────────────────────────────


def leeres_depot() -> dict:
    return {"updated_at": None, "einsatz_eur": EINSATZ_EUR, "positionen": [],
            "summe": {}, "hinweise": []}


def lade_depot() -> dict:
    if not PORTFOLIO_DATEI.exists():
        return leeres_depot()
    try:
        d = json.loads(PORTFOLIO_DATEI.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        log(f"virtual_portfolio.json unlesbar ({e}), es wird NICHT ueberschrieben.")
        raise SystemExit(1)
    d.setdefault("positionen", [])
    d.setdefault("einsatz_eur", EINSATZ_EUR)
    d.setdefault("hinweise", [])
    return d


def offene_symbole(depot: dict) -> set[str]:
    return {p["symbol"] for p in depot["positionen"] if p.get("status") == "offen"}


def neue_id(symbol: str, datum: str, quelle: str) -> str:
    return f"{datum}-{symbol}-{quelle}"


# ── Aufnahme ─────────────────────────────────────────────────────────────


def aus_issues(depot: dict) -> list[str]:
    meldungen: list[str] = []
    for issue in github_issues():
        if "pull_request" in issue:
            continue
        labels = {l["name"].lower() for l in issue.get("labels", [])}
        art = next((LABELS[l] for l in labels if l in LABELS), None)
        if art is None:
            continue
        symbol = ticker_aus_titel(issue.get("title", ""))
        nummer = issue.get("number")
        if not symbol:
            meldungen.append(f"Issue #{nummer}: kein Ticker im Titel erkannt.")
            continue

        angelegt = issue.get("created_at", "")[:10] or heute().isoformat()
        rumpf = (issue.get("body") or "").strip()

        if art == "verkauf":
            treffer = [p for p in depot["positionen"]
                       if p["symbol"] == symbol and p.get("status") == "offen"]
            if not treffer:
                meldungen.append(f"Issue #{nummer}: keine offene Position {symbol}.")
                issue_schliessen(nummer, f"Keine offene Position **{symbol}** im virtuellen Depot.")
                continue
            for p in treffer:
                p["status"] = "geschlossen"
                p["closed"] = angelegt
                p["schliessgrund"] = "von Hand"
            meldungen.append(f"{symbol} geschlossen (Issue #{nummer}).")
            issue_schliessen(nummer, f"**{symbol}** im virtuellen Depot geschlossen.")
            continue

        if symbol in offene_symbole(depot):
            meldungen.append(f"Issue #{nummer}: {symbol} liegt bereits offen im Depot.")
            issue_schliessen(nummer, f"**{symbol}** liegt bereits als offene Position im virtuellen Depot.")
            continue

        eroeffnet = datum_aus_text(rumpf, angelegt) or angelegt
        depot["positionen"].append({
            "id": neue_id(symbol, eroeffnet, art),
            "symbol": symbol, "name": symbol, "quelle": art, "korb": None,
            "opened": eroeffnet, "notiz": rumpf[:400],
            "issue": issue.get("html_url"),
            "benchmark_symbol": TRUMP_BENCHMARK if art == "trump" else "^GSPC",
            "branche": None, "score_at_entry": None, "status": "offen",
        })
        nachtrag = (" (nachgetragen zum angegebenen Datum)"
                    if eroeffnet != angelegt else "")
        meldungen.append(f"{symbol} aufgenommen als {art} zum {eroeffnet}{nachtrag}.")
        issue_schliessen(
            nummer,
            f"**{symbol}** ins virtuelle Depot aufgenommen, Einstand zum {eroeffnet}"
            f"{nachtrag}, {EINSATZ_EUR:.0f} Euro abzueglich "
            f"{KOSTEN_PCT_JE_SEITE:.2f} Prozent Kosten. Auswertung unter "
            f"https://maik45133.github.io/sparplan-site/#virtuell")
    return meldungen


def aus_screening(depot: dict) -> list[str]:
    """Besten Titel je Korb uebernehmen, sofern unter der Groessengrenze."""
    meldungen: list[str] = []
    if not LATEST_DATEI.exists():
        return ["data/latest.json fehlt, kein Screening uebernommen."]
    try:
        latest = json.loads(LATEST_DATEI.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        return [f"data/latest.json unlesbar: {e}"]

    stand = (latest.get("generated_at") or "")[:10] or heute().isoformat()
    eroeffnet = heute().isoformat()
    offen = offene_symbole(depot)
    # Ein Titel, der schon einmal drin war, kommt nicht erneut rein. Sonst
    # zaehlt derselbe Treffer mehrfach und das Register schmeichelt sich.
    jemals = {p["symbol"] for p in depot["positionen"] if p.get("quelle") == "score"}

    for korb, cfg in KOERBE.items():
        dossiers = latest.get(cfg["feld"]) or []
        gereiht = sorted(
            (d for d in dossiers if (d.get("scorecard") or {}).get("total") is not None),
            key=lambda d: d["scorecard"]["total"], reverse=True)
        genommen = 0
        for d in gereiht:
            if genommen >= NEU_JE_KORB:
                break
            card = d.get("scorecard") or {}
            kand = d.get("candidate") or {}
            sym = kand.get("symbol")
            if not sym:
                continue
            # Ein Score aus luekenhaften Daten ist keine Auswahl, sondern Rauschen.
            if card.get("reliable") is False:
                continue
            kap = kand.get("market_cap")
            grenze = kaufgrenze(korb)
            if kap is not None and kap > grenze:
                # Kein Nachruecken: ist der Beste des Korbs zu gross, bleibt
                # der Platz leer. Der zweitbeste ist nicht die Auswahl, die
                # das Verfahren getroffen hat.
                meldungen.append(
                    f"{sym} uebersprungen, {kap / 1e9:.1f} Mrd ueber der Kaufgrenze "
                    f"({grenze / 1e9:.0f} Mrd), Korb {korb}.")
                genommen += 1
                continue
            if sym in offen or sym in jemals:
                genommen += 1
                continue
            depot["positionen"].append({
                "id": neue_id(sym, eroeffnet, "score"),
                "symbol": sym, "name": kand.get("name") or sym,
                "quelle": "score", "korb": korb,
                "opened": eroeffnet, "datenstand": stand,
                "notiz": f"Bester Titel im Korb {cfg['titel']}, Datenstand {stand}",
                "issue": None, "benchmark_symbol": cfg["benchmark"],
                "branche": d.get("industry") or kand.get("sector"),
                "score_at_entry": card.get("total"), "status": "offen",
            })
            offen.add(sym)
            jemals.add(sym)
            genommen += 1
            meldungen.append(f"{sym} aufgenommen aus Korb {korb}, Score {card.get('total')}.")
    return meldungen


# ── Volatilitaetsstop ────────────────────────────────────────────────────


def mittlere_tagesschwankung(reihe: dict[str, float], bis: str,
                             fenster: int = STOP_FENSTER) -> float | None:
    """Mittlere absolute Tagesveraenderung der letzten `fenster` Handelstage."""
    tage = sorted(t for t in reihe if t <= bis)
    if len(tage) < 5:
        return None
    letzte = tage[-(fenster + 1):]
    diffs = [abs(reihe[b] - reihe[a]) for a, b in zip(letzte, letzte[1:])]
    return sum(diffs) / len(diffs) if diffs else None


def stop_pruefen(position: dict, reihe: dict[str, float]) -> dict | None:
    """Laeuft die Kursreihe ab dem Einstand Tag fuer Tag durch und schliesst
    beim ersten Unterschreiten des nachgezogenen Stops.

    Bewusst tagesgenau statt nur zum Laufzeitpunkt: Der Lauf ist woechentlich,
    ein Stop, der nur sonntags geprueft wird, ist kein Stop, sondern eine
    Wochenendmeinung. So haengt das Ergebnis nicht daran, wie oft der Lauf
    zufaellig stattfindet.
    """
    tage = sorted(t for t in reihe if t >= position["opened"])
    if len(tage) < 6:
        return None
    hoechster = None
    for tag in tage:
        kurs = reihe[tag]
        hoechster = kurs if hoechster is None else max(hoechster, kurs)
        schwankung = mittlere_tagesschwankung(reihe, tag)
        if schwankung is None or schwankung <= 0:
            continue
        stop = hoechster - STOP_FAKTOR * schwankung
        if kurs < stop:
            return {"tag": tag, "kurs": kurs, "stop": round(stop, 4),
                    "hoechster": round(hoechster, 4)}
    return None


# ── Bewerten ─────────────────────────────────────────────────────────────


def bewerte(depot: dict) -> list[str]:
    meldungen: list[str] = []
    if not depot["positionen"]:
        return meldungen
    frueheste = min(p["opened"] for p in depot["positionen"])
    start = dt.date.fromisoformat(frueheste) - dt.timedelta(days=40)
    ende = heute()
    fx_jetzt = fx_eur_je_usd(None)

    for p in depot["positionen"]:
        sym = p["symbol"]
        log(f"{sym} ({p['quelle']}, seit {p['opened']})")
        reihe = kursreihe(sym, start, ende)
        bench_reihe = kursreihe(p.get("benchmark_symbol") or "^GSPC", start, ende)

        einstand = kurs_am(reihe, p["opened"])
        bench_einstand = kurs_am(bench_reihe, p["opened"])

        # Stop nur fuer offene Positionen, und nur solange nicht von Hand
        # geschlossen wurde.
        if p.get("status") == "offen":
            treffer = stop_pruefen(p, reihe)
            if treffer:
                p["status"] = "geschlossen"
                p["closed"] = treffer["tag"]
                p["schliessgrund"] = "Volatilitaetsstop"
                p["stop_kurs"] = treffer["stop"]
                p["hoechster_kurs"] = treffer["hoechster"]
                meldungen.append(
                    f"{sym} am {treffer['tag']} durch den Volatilitaetsstop "
                    f"geschlossen, Kurs {treffer['kurs']:.2f} unter Stop {treffer['stop']:.2f}.")

        if p.get("status") == "geschlossen" and p.get("closed"):
            letzter = (p["closed"], kurs_am(reihe, p["closed"]))
            bench_letzter = (p["closed"], kurs_am(bench_reihe, p["closed"]))
            if letzter[1] is None:
                letzter = None
            if bench_letzter[1] is None:
                bench_letzter = None
        else:
            letzter = kurs_frisch(reihe)
            bench_letzter = kurs_frisch(bench_reihe)

        if einstand is None or letzter is None:
            p["veraltet"] = True
            p["fehler"] = "Kein aktueller Kurs"
            log("  -> kein Kurs, alte Werte bleiben stehen")
            continue

        fx_ein = p.get("fx_at_entry") or fx_eur_je_usd(p["opened"])
        if fx_ein is None or fx_jetzt is None:
            p["veraltet"] = True
            p["fehler"] = "Kein Wechselkurs abrufbar"
            log("  -> kein Wechselkurs, alte Werte bleiben stehen")
            continue

        kurs_datum, kurs_jetzt = letzter
        fx_stand = fx_jetzt if p.get("status") == "offen" else (
            fx_eur_je_usd(p["closed"]) or fx_jetzt)

        p["veraltet"] = False
        p["fehler"] = None
        p["entry_price_usd"] = round(einstand, 4)
        p["fx_at_entry"] = round(fx_ein, 6)
        p["fx_now"] = round(fx_stand, 6)
        p["einsatz_eur"] = EINSATZ_EUR
        p["kosten_pct_je_seite"] = round(KOSTEN_PCT_JE_SEITE, 3)

        # Kaufkosten fallen beim Einstieg an, Verkaufskosten beim Ausstieg.
        # Fuer eine offene Position wird trotzdem beides gerechnet: Die Zahl,
        # die zaehlt, ist der Betrag, den er bei sofortigem Verkauf haette.
        investiert = EINSATZ_EUR * (1 - K)
        stueck = investiert / (einstand * fx_ein)
        p["stueck"] = round(stueck, 6)
        p["price_now_usd"] = round(kurs_jetzt, 4)
        p["kurs_stand"] = kurs_datum

        brutto_eur = stueck * kurs_jetzt * fx_stand
        netto_eur = brutto_eur * (1 - K)
        p["brutto_wert_eur"] = round(brutto_eur, 2)
        p["wert_eur"] = round(netto_eur, 2)
        p["kosten_eur"] = round(EINSATZ_EUR * K + brutto_eur * K, 2)
        p["gewinn_eur"] = round(netto_eur - EINSATZ_EUR, 2)
        p["rendite_pct"] = round((netto_eur / EINSATZ_EUR - 1) * 100, 2)

        kurs_pct = (kurs_jetzt / einstand - 1) * 100
        p["kurs_pct"] = round(kurs_pct, 2)
        brutto_rendite = (brutto_eur / EINSATZ_EUR - 1) * 100
        p["brutto_rendite_pct"] = round(brutto_rendite, 2)
        p["waehrungseffekt_pct"] = round(brutto_rendite - kurs_pct, 2)
        p["kostenlast_pct"] = round(p["rendite_pct"] - brutto_rendite, 2)

        if bench_einstand and bench_letzter:
            bench_pct = (bench_letzter[1] / bench_einstand - 1) * 100
            p["benchmark_at_entry"] = round(bench_einstand, 4)
            p["benchmark_now"] = round(bench_letzter[1], 4)
            p["benchmark_pct"] = round(bench_pct, 2)
            # Brutto in Dollar gegen Dollar, siehe Modulkopf.
            p["excess_pct"] = round(kurs_pct - bench_pct, 2)
            # Und dieselbe Zahl nach Kosten, denn nur die entscheidet, ob sich
            # der Aufwand gegenueber einem Indexfonds gelohnt haette.
            netto_kurs_pct = ((1 - K) ** 2 * kurs_jetzt / einstand - 1) * 100
            p["excess_netto_pct"] = round(netto_kurs_pct - bench_pct, 2)
        else:
            p["benchmark_pct"] = None
            p["excess_pct"] = None
            p["excess_netto_pct"] = None

        bis = dt.date.fromisoformat(p["closed"]) if p.get("closed") else heute()
        p["tage"] = (bis - dt.date.fromisoformat(p["opened"])).days
        log(f"  {p['rendite_pct']:+.2f} % netto, Ueberrendite netto {p.get('excess_netto_pct')}")
    return meldungen


def median(werte: list[float]) -> float | None:
    if not werte:
        return None
    s = sorted(werte)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def summiere(depot: dict) -> None:
    """Gesamtstand, und derselbe Schnitt noch einmal je Quelle.

    Die Trennung ist der eigentliche Zweck: Datenauswahl und Trump-Komponente
    laufen im selben Depot, werden aber getrennt ausgewiesen, sonst laesst sich
    hinterher nicht sagen, welcher Teil getragen hat.
    """
    def block(positionen: list[dict]) -> dict:
        gueltig = [p for p in positionen if p.get("wert_eur") is not None]
        einsatz = sum(p.get("einsatz_eur", EINSATZ_EUR) for p in gueltig)
        wert = sum(p["wert_eur"] for p in gueltig)
        ex = [p["excess_netto_pct"] for p in gueltig if p.get("excess_netto_pct") is not None]
        return {
            "anzahl": len(gueltig),
            "offen": len([p for p in gueltig if p.get("status") == "offen"]),
            "einsatz_eur": round(einsatz, 2),
            "wert_eur": round(wert, 2),
            "gewinn_eur": round(wert - einsatz, 2),
            "rendite_pct": round((wert / einsatz - 1) * 100, 2) if einsatz else None,
            "median_excess_pct": round(median(ex), 2) if ex else None,
            "besser_als_benchmark": sum(1 for e in ex if e > 0),
            "mit_benchmark": len(ex),
            "kosten_eur": round(sum(p.get("kosten_eur") or 0 for p in gueltig), 2),
        }

    alle = depot["positionen"]
    depot["summe"] = {
        "gesamt": block(alle),
        "score": block([p for p in alle if p.get("quelle") == "score"]),
        "trump": block([p for p in alle if p.get("quelle") == "trump"]),
    }


def schreibe(depot: dict, meldungen: list[str]) -> None:
    depot["updated_at"] = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    depot["einsatz_eur"] = EINSATZ_EUR
    depot["hinweise"] = meldungen[-25:]
    depot["benchmark_namen"] = BENCHMARK_NAME
    depot["kosten"] = {
        "pct_je_seite": round(KOSTEN_PCT_JE_SEITE, 3),
        "pct_hin_und_zurueck": round((1 - (1 - K) ** 2) * 100, 3),
        "ordergebuehr_eur": ORDERGEBUEHR_EUR,
        "echte_ordergroesse_eur": ECHTE_ORDERGROESSE_EUR,
        "spread_pct_je_seite": SPREAD_PCT_JE_SEITE,
    }
    depot["stop"] = {"faktor": STOP_FAKTOR, "fenster": STOP_FENSTER}
    depot["max_marktkapital_kauf"] = dict(MAX_MARKTKAPITAL_KAUF)
    PORTFOLIO_DATEI.parent.mkdir(parents=True, exist_ok=True)
    PORTFOLIO_DATEI.write_text(
        json.dumps(depot, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    log(f"geschrieben: {PORTFOLIO_DATEI.relative_to(ROOT)}")


def main(argv: list[str]) -> int:
    nur_kurse = "--nur-kurse" in argv
    depot = lade_depot()
    meldungen: list[str] = []
    if not nur_kurse:
        labels_sicherstellen()
        meldungen += aus_issues(depot)
        meldungen += aus_screening(depot)
    meldungen += bewerte(depot)
    summiere(depot)
    schreibe(depot, meldungen)
    for m in meldungen:
        log("  * " + m)
    g = depot["summe"]["gesamt"]
    log(f"Gesamt: {g['anzahl']} Positionen, {g['wert_eur']} Euro, {g['rendite_pct']} % "
        f"(Kosten {KOSTEN_PCT_JE_SEITE:.2f} % je Seite)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
