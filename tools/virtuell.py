#!/usr/bin/env python3
"""Virtuelles Depot: Motor fuer data/virtual_portfolio.json.

Laeuft woechentlich in GitHub Actions, nicht auf Maiks Mac und nicht in
Cowork. Grund: Beide Arbeitsumgebungen erreichen keine Kursquelle, die
Actions-Runner dagegen haben offenes Netz. Der Lauf enthaelt keinen
KI-Aufruf, verbraucht also keine Claude-Credits, und oeffentliche Repos
haben unbegrenzte Actions-Minuten.

Was der Lauf tut, in dieser Reihenfolge:

1. Offene GitHub-Issues mit Label `trump`, `kauf` oder `verkauf` einlesen.
   Das ist der Einwurf vom Handy: Issue auf, Ticker in den Titel, fertig.
2. Top 1 je Korb aus data/latest.json aufnehmen, wenn der Titel noch nicht
   im virtuellen Depot liegt.
3. Fuer jede Position Einstandskurs (Schlusskurs des Eroeffnungstages),
   aktuellen Kurs, Benchmarkstand und Wechselkurs holen.
4. Rendite, Benchmarkrendite, Ueberrendite und Waehrungseffekt rechnen.
5. Alles zurueckschreiben.

Zwei Grundsaetze, die den Rest des Codes erklaeren:

**Ein fehlgeschlagener Abruf darf nie gute Daten ueberschreiben.** Kommt
kein Kurs, bleiben die Werte des letzten Laufs stehen und die Position
wird als `veraltet` markiert. Ein virtuelles Depot, das bei einer
Netzstoerung stillschweigend auf null springt, ist schlimmer als eines,
das offen sagt, dass es alt ist.

**Ueberrendite wird in Dollar gerechnet, nicht in Euro.** Der Benchmark
notiert in Dollar. Wer die eigene Euro-Rendite gegen eine Dollar-Rendite
haelt, misst zur Haelfte den Wechselkurs und nennt es Auswahlqualitaet.
Der Waehrungseffekt steht deshalb als eigene Zahl daneben.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORTFOLIO_DATEI = ROOT / "data" / "virtual_portfolio.json"
LATEST_DATEI = ROOT / "data" / "latest.json"

# Einheitlich 1.000 Euro je Position. Gleichgewichtet, damit die
# Gesamtrendite der ehrliche Durchschnitt der Auswahl ist und nicht das
# Ergebnis zufaelliger Stueckzahlen.
EINSATZ_EUR = 1000.0

# Top 1 je Korb. Bewusst scharf: das Register unter data/track_record.json
# haelt weiterhin Top 3 je Korb fest, dort laesst sich spaeter nachrechnen,
# ob eine breitere Auswahl besser gewesen waere.
NEU_JE_KORB = 1

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

UA = {"User-Agent": "sparplan-site/1.0 (virtuelles Depot; github.com/Maik45133/sparplan-site)"}


def heute() -> dt.date:
    return dt.date.today()


def log(*teile) -> None:
    print(*teile, flush=True)


# ── Kursabruf ────────────────────────────────────────────────────────────
#
# Zwei Quellen hintereinander, weil eine einzelne Gratisquelle fuer einen
# automatischen Lauf zu duenn ist: Yahoo ueber yfinance zuerst, Stooq als
# Rueckfall. Beide liefern dasselbe Format zurueck (Datum -> Schlusskurs),
# der Rest des Skripts merkt nicht, welche geantwortet hat.


def _yfinance_kurse(symbol: str, start: dt.date, ende: dt.date) -> dict[str, float]:
    try:
        import yfinance  # type: ignore
    except ImportError:
        return {}
    try:
        df = yfinance.Ticker(symbol).history(
            start=start.isoformat(),
            end=(ende + dt.timedelta(days=1)).isoformat(),
            auto_adjust=False,
        )
    except Exception as e:  # noqa: BLE001 - jede Ausnahme ist hier nur "keine Daten"
        log(f"  yfinance {symbol}: {e}")
        return {}
    out: dict[str, float] = {}
    try:
        for idx, zeile in df.iterrows():
            kurs = float(zeile["Close"])
            if kurs > 0:
                out[str(idx)[:10]] = kurs
    except Exception as e:  # noqa: BLE001
        log(f"  yfinance {symbol}, Auswertung: {e}")
        return {}
    return out


# Stooq kennt keine Yahoo-Schreibweise. Aktien brauchen das Suffix .us,
# Indizes eigene Kuerzel.
STOOQ_SPEZIAL = {"^GSPC": "^spx", "^IXIC": "^ndq", "EURUSD=X": "eurusd"}


def _stooq_symbol(symbol: str) -> str:
    if symbol in STOOQ_SPEZIAL:
        return STOOQ_SPEZIAL[symbol]
    if symbol.startswith("^"):
        return symbol.lower()
    return symbol.lower() + ".us"


def _stooq_kurse(symbol: str, start: dt.date, ende: dt.date) -> dict[str, float]:
    url = (
        "https://stooq.com/q/d/l/?s="
        + urllib.parse.quote(_stooq_symbol(symbol))
        + f"&d1={start.strftime('%Y%m%d')}&d2={ende.strftime('%Y%m%d')}&i=d"
    )
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        log(f"  stooq {symbol}: {e}")
        return {}
    out: dict[str, float] = {}
    for zeile in text.splitlines()[1:]:
        teile = zeile.split(",")
        if len(teile) < 5:
            continue
        try:
            kurs = float(teile[4])
        except ValueError:
            continue
        if kurs > 0:
            out[teile[0]] = kurs
    return out


_KURS_CACHE: dict[str, dict[str, float]] = {}


def kursreihe(symbol: str, start: dt.date, ende: dt.date) -> dict[str, float]:
    """Schlusskurse als Datum -> Kurs. Leeres Dict heisst: keine Daten."""
    schluessel = f"{symbol}|{start}|{ende}"
    if schluessel in _KURS_CACHE:
        return _KURS_CACHE[schluessel]
    reihe = _yfinance_kurse(symbol, start, ende)
    if not reihe:
        reihe = _stooq_kurse(symbol, start, ende)
    if not reihe:
        log(f"  KEIN KURS fuer {symbol}")
    _KURS_CACHE[schluessel] = reihe
    return reihe


def kurs_am(reihe: dict[str, float], datum: str) -> float | None:
    """Schlusskurs am Datum, sonst der letzte davor.

    Ein Einstand am Wochenende oder Feiertag hat keinen eigenen Kurs. Den
    naechsten Handelstag DANACH zu nehmen waere Rueckschau: der Kurs waere
    zum Zeitpunkt der Entscheidung noch nicht bekannt gewesen.
    """
    passende = [t for t in reihe if t <= datum]
    if not passende:
        return None
    return reihe[max(passende)]


def kurs_zuletzt(reihe: dict[str, float]) -> tuple[str, float] | None:
    if not reihe:
        return None
    t = max(reihe)
    return t, reihe[t]


# ── Wechselkurs ──────────────────────────────────────────────────────────
#
# Euro je Dollar, von der EZB ueber api.frankfurter.dev. Dieselbe Quelle,
# die die Seite als Rueckfall nutzt, hier aber serverseitig und damit ohne
# CORS-Sorgen.

_FX_CACHE: dict[str, float | None] = {}


def fx_eur_je_usd(datum: str | None = None) -> float | None:
    schluessel = datum or "latest"
    if schluessel in _FX_CACHE:
        return _FX_CACHE[schluessel]
    pfad = "latest" if datum is None else datum
    url = f"https://api.frankfurter.dev/v1/{pfad}?base=USD&symbols=EUR"
    wert: float | None = None
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=30) as r:
            j = json.loads(r.read().decode("utf-8"))
        wert = float(j["rates"]["EUR"])
    except Exception as e:  # noqa: BLE001
        log(f"  FX {schluessel}: {e}")
        wert = None
    _FX_CACHE[schluessel] = wert
    return wert


# ── GitHub-Issues als Eingabekanal ───────────────────────────────────────


# Die drei Label muessen im Repo existieren, sonst vergibt GitHub sie beim
# Anlegen eines Issues stillschweigend nicht und der Einwurf vom Handy
# landet nirgends. Deshalb legt jeder Lauf sie an, falls sie fehlen.
LABEL_FARBEN = {
    "trump": ("d73a4a", "Trump hat oeffentlich zu diesem Titel geraten"),
    "kauf": ("0e8a16", "Von Hand ins virtuelle Depot aufnehmen"),
    "verkauf": ("5319e7", "Offene Position im virtuellen Depot schliessen"),
}


def labels_sicherstellen() -> None:
    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not token or not repo:
        return
    kopf = {**UA, "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json"}
    for name, (farbe, text) in LABEL_FARBEN.items():
        nutzlast = json.dumps({"name": name, "color": farbe, "description": text})
        req = urllib.request.Request(
            f"https://api.github.com/repos/{repo}/labels",
            data=nutzlast.encode("utf-8"), headers=kopf, method="POST")
        try:
            urllib.request.urlopen(req, timeout=30).read()
            log(f"Label '{name}' angelegt.")
        except urllib.error.HTTPError as e:
            if e.code != 422:  # 422 heisst: gibt es schon, alles gut
                log(f"Label '{name}': {e}")
        except Exception as e:  # noqa: BLE001
            log(f"Label '{name}': {e}")


def github_issues() -> list[dict]:
    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not token or not repo:
        log("Kein GITHUB_TOKEN/GITHUB_REPOSITORY, Issues werden uebersprungen.")
        return []
    url = f"https://api.github.com/repos/{repo}/issues?state=open&per_page=100"
    req = urllib.request.Request(
        url,
        headers={**UA, "Authorization": f"Bearer {token}",
                 "Accept": "application/vnd.github+json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        log(f"Issues nicht abrufbar: {e}")
        return []


def issue_schliessen(nummer: int, kommentar: str) -> None:
    token = os.environ.get("GITHUB_TOKEN")
    repo = os.environ.get("GITHUB_REPOSITORY")
    if not token or not repo:
        return
    kopf = {**UA, "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json"}
    try:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{repo}/issues/{nummer}/comments",
            data=json.dumps({"body": kommentar}).encode("utf-8"),
            headers=kopf, method="POST")
        urllib.request.urlopen(req, timeout=30).read()
        req = urllib.request.Request(
            f"https://api.github.com/repos/{repo}/issues/{nummer}",
            data=json.dumps({"state": "closed"}).encode("utf-8"),
            headers=kopf, method="PATCH")
        urllib.request.urlopen(req, timeout=30).read()
    except Exception as e:  # noqa: BLE001
        log(f"Issue #{nummer} konnte nicht geschlossen werden: {e}")


def ticker_aus_titel(titel: str) -> str:
    """Erstes Wort, Buchstaben, Ziffern, Punkt und Bindestrich. Aus
    'NVDA kaufen laut Truth-Post' wird NVDA."""
    roh = (titel or "").strip().split()
    if not roh:
        return ""
    erlaubt = "".join(c for c in roh[0] if c.isalnum() or c in ".-^")
    return erlaubt.upper()


# ── Depot lesen und schreiben ────────────────────────────────────────────


def leeres_depot() -> dict:
    return {
        "updated_at": None,
        "einsatz_eur": EINSATZ_EUR,
        "positionen": [],
        "summe": {},
        "hinweise": [],
    }


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
    """Issues einlesen. Gibt die Meldungen fuer das Protokoll zurueck."""
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

        if art == "verkauf":
            treffer = [p for p in depot["positionen"]
                       if p["symbol"] == symbol and p.get("status") == "offen"]
            if not treffer:
                meldungen.append(f"Issue #{nummer}: keine offene Position {symbol}.")
                issue_schliessen(nummer, f"Keine offene Position **{symbol}** im virtuellen Depot.")
                continue
            for p in treffer:
                p["status"] = "geschlossen"
                p["closed"] = issue.get("created_at", "")[:10]
            meldungen.append(f"{symbol} geschlossen (Issue #{nummer}).")
            issue_schliessen(nummer, f"**{symbol}** im virtuellen Depot geschlossen.")
            continue

        if symbol in offene_symbole(depot):
            meldungen.append(f"Issue #{nummer}: {symbol} liegt bereits offen im Depot.")
            issue_schliessen(nummer, f"**{symbol}** liegt bereits als offene Position im virtuellen Depot.")
            continue

        eroeffnet = issue.get("created_at", "")[:10] or heute().isoformat()
        notiz = (issue.get("body") or "").strip()[:400]
        depot["positionen"].append({
            "id": neue_id(symbol, eroeffnet, art),
            "symbol": symbol,
            "name": symbol,
            "quelle": art,
            "korb": None,
            "opened": eroeffnet,
            "notiz": notiz,
            "issue": issue.get("html_url"),
            "benchmark_symbol": TRUMP_BENCHMARK if art == "trump" else "^GSPC",
            "score_at_entry": None,
            "status": "offen",
        })
        meldungen.append(f"{symbol} aufgenommen als {art} zum {eroeffnet} (Issue #{nummer}).")
        issue_schliessen(
            nummer,
            f"**{symbol}** ins virtuelle Depot aufgenommen, Einstand zum {eroeffnet}, "
            f"{EINSATZ_EUR:.0f} Euro. Auswertung unter "
            f"https://maik45133.github.io/sparplan-site/#virtuell",
        )
    return meldungen


def aus_screening(depot: dict) -> list[str]:
    """Top 1 je Korb aus dem letzten Datenlauf uebernehmen."""
    meldungen: list[str] = []
    if not LATEST_DATEI.exists():
        return ["data/latest.json fehlt, kein Screening uebernommen."]
    try:
        latest = json.loads(LATEST_DATEI.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        return [f"data/latest.json unlesbar: {e}"]

    stand = (latest.get("generated_at") or "")[:10] or heute().isoformat()
    # Eroeffnet wird IMMER heute, nie rueckwirkend zum Datenstand. Ein
    # rueckdatierter Einstand sieht harmlos aus, ist aber genau die Stelle,
    # an der sich ein Register unbemerkt schoenrechnet: die Auswahl faellt
    # heute, mit heutigem Wissen, und muss sich ab heute beweisen. Der
    # Datenstand des Laufs steht daneben, damit sichtbar bleibt, wie alt
    # die Zahlen hinter der Auswahl waren.
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
            sym = (d.get("candidate") or {}).get("symbol")
            if not sym:
                continue
            # Ein Score aus luckenhaften Daten ist keine Auswahl, sondern Rauschen.
            if card.get("reliable") is False:
                continue
            if sym in offen or sym in jemals:
                genommen += 1  # Platz gilt als vergeben, kein Nachruecken
                continue
            depot["positionen"].append({
                "id": neue_id(sym, eroeffnet, "score"),
                "symbol": sym,
                "name": (d.get("candidate") or {}).get("name") or sym,
                "quelle": "score",
                "korb": korb,
                "opened": eroeffnet,
                "datenstand": stand,
                "notiz": "Bester Titel im Korb " + cfg["titel"] + ", Datenstand " + stand,
                "issue": None,
                "benchmark_symbol": cfg["benchmark"],
                # Branche wandert mit, damit die Seite beim naechsten
                # Vorschlag warnen kann, wenn schon etwas aus derselben Ecke
                # offen liegt. Zwei Titel am selben Thema sind kein Depot,
                # sondern eine Wette in zwei Teilen.
                "branche": d.get("industry") or (d.get("candidate") or {}).get("sector"),
                "score_at_entry": card.get("total"),
                "status": "offen",
            })
            offen.add(sym)
            jemals.add(sym)
            genommen += 1
            meldungen.append(f"{sym} aufgenommen aus Korb {korb}, Score {card.get('total')}.")
    return meldungen


# ── Bewerten ─────────────────────────────────────────────────────────────


def bewerte(depot: dict) -> None:
    if not depot["positionen"]:
        return
    frueheste = min(p["opened"] for p in depot["positionen"])
    start = dt.date.fromisoformat(frueheste) - dt.timedelta(days=10)
    ende = heute()

    fx_jetzt = fx_eur_je_usd(None)

    for p in depot["positionen"]:
        sym = p["symbol"]
        log(f"{sym} ({p['quelle']}, seit {p['opened']})")
        reihe = kursreihe(sym, start, ende)
        bench_reihe = kursreihe(p.get("benchmark_symbol") or "^GSPC", start, ende)

        einstand = kurs_am(reihe, p["opened"])
        letzter = kurs_zuletzt(reihe)
        bench_einstand = kurs_am(bench_reihe, p["opened"])
        bench_letzter = kurs_zuletzt(bench_reihe)

        if einstand is None or letzter is None:
            # Nichts ueberschreiben, nur markieren.
            p["veraltet"] = True
            p["fehler"] = "Kein Kurs abrufbar"
            log("  -> kein Kurs, alte Werte bleiben stehen")
            continue

        fx_ein = p.get("fx_at_entry") or fx_eur_je_usd(p["opened"])
        if fx_ein is None or fx_jetzt is None:
            p["veraltet"] = True
            p["fehler"] = "Kein Wechselkurs abrufbar"
            log("  -> kein Wechselkurs, alte Werte bleiben stehen")
            continue

        p["veraltet"] = False
        p["fehler"] = None
        p["entry_price_usd"] = round(einstand, 4)
        p["fx_at_entry"] = round(fx_ein, 6)
        p["fx_now"] = round(fx_jetzt, 6)
        p["einsatz_eur"] = EINSATZ_EUR
        # Stueckzahl einmal festnageln: sie folgt aus Einsatz und Einstand
        # und darf sich spaeter nicht mehr bewegen.
        stueck = EINSATZ_EUR / (einstand * fx_ein)
        p["stueck"] = round(stueck, 6)

        kurs_datum, kurs_jetzt = letzter
        p["price_now_usd"] = round(kurs_jetzt, 4)
        p["kurs_stand"] = kurs_datum

        wert_eur = stueck * kurs_jetzt * fx_jetzt
        p["wert_eur"] = round(wert_eur, 2)
        p["gewinn_eur"] = round(wert_eur - EINSATZ_EUR, 2)
        p["rendite_pct"] = round((wert_eur / EINSATZ_EUR - 1) * 100, 2)

        kurs_pct = (kurs_jetzt / einstand - 1) * 100
        p["kurs_pct"] = round(kurs_pct, 2)
        p["waehrungseffekt_pct"] = round(p["rendite_pct"] - kurs_pct, 2)

        if bench_einstand and bench_letzter:
            bench_pct = (bench_letzter[1] / bench_einstand - 1) * 100
            p["benchmark_at_entry"] = round(bench_einstand, 4)
            p["benchmark_now"] = round(bench_letzter[1], 4)
            p["benchmark_pct"] = round(bench_pct, 2)
            # In Dollar gegen Dollar, siehe Modulkopf.
            p["excess_pct"] = round(kurs_pct - bench_pct, 2)
        else:
            p["benchmark_pct"] = None
            p["excess_pct"] = None

        p["tage"] = (heute() - dt.date.fromisoformat(p["opened"])).days
        log(f"  {p['rendite_pct']:+.2f} % in Euro, Ueberrendite {p.get('excess_pct')}")


def median(werte: list[float]) -> float | None:
    if not werte:
        return None
    s = sorted(werte)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def summiere(depot: dict) -> None:
    """Gesamtstand, und derselbe Schnitt noch einmal je Quelle.

    Die Trennung ist der eigentliche Zweck des Ganzen: Datenauswahl und
    Trump-Komponente laufen im selben Depot, werden aber getrennt
    ausgewiesen, sonst laesst sich hinterher nicht sagen, welcher Teil
    getragen hat.
    """
    def block(positionen: list[dict]) -> dict:
        gueltig = [p for p in positionen if p.get("wert_eur") is not None]
        offen = [p for p in gueltig if p.get("status") == "offen"]
        einsatz = sum(p.get("einsatz_eur", EINSATZ_EUR) for p in gueltig)
        wert = sum(p["wert_eur"] for p in gueltig)
        excess = [p["excess_pct"] for p in gueltig if p.get("excess_pct") is not None]
        return {
            "anzahl": len(gueltig),
            "offen": len(offen),
            "einsatz_eur": round(einsatz, 2),
            "wert_eur": round(wert, 2),
            "gewinn_eur": round(wert - einsatz, 2),
            "rendite_pct": round((wert / einsatz - 1) * 100, 2) if einsatz else None,
            "median_excess_pct": round(median(excess), 2) if excess else None,
            "besser_als_benchmark": sum(1 for e in excess if e > 0),
            "mit_benchmark": len(excess),
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
    depot["hinweise"] = meldungen[-20:]
    depot["benchmark_namen"] = BENCHMARK_NAME
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
    bewerte(depot)
    summiere(depot)
    schreibe(depot, meldungen)
    for m in meldungen:
        log("  * " + m)
    g = depot["summe"]["gesamt"]
    log(f"Gesamt: {g['anzahl']} Positionen, {g['wert_eur']} Euro, {g['rendite_pct']} %")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
