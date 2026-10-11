#!/usr/bin/env python3
"""Baut die Daten fuer die App: data/app.json und, mit Passwort, data/depot_live.enc.

Laeuft sonntags im Wochenlauf und nach jedem Gekauft-Issue, beides auf GitHub.
Kein Sprachmodell, also keine Claude-Credits.

    python3 tools/app_daten.py              alles neu bauen
    python3 tools/app_daten.py --gekauft    nur Gekauft-Issues einlesen (schnell)
    python3 tools/app_daten.py --ohne-depot ohne verschluesseltes Depot

Oeffentlich (app.json): Top 3 je Groesse mit Gruenden, Indizes, Archiv in Euro,
virtuelles Depot, Gekauft-Liste.
Verschluesselt (depot_live.enc): dein Bestand mit aktuellen Kursen. Das Passwort
kommt aus dem GitHub-Secret DEPOT_PASSWORT oder wird am Mac abgefragt. Es steht
nirgends im Repo.
"""
from __future__ import annotations

import base64
import datetime as dt
import getpass
import hashlib
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import kurse  # noqa: E402  Rueckfall auf yfinance und Stooq

HIER = Path(__file__).resolve().parent.parent
DATA = HIER / "data"
APP_DATEI = DATA / "app.json"
GEKAUFT_DATEI = DATA / "gekauft.json"
DEPOT_ENC = DATA / "depot.enc"
DEPOT_LIVE = DATA / "depot_live.enc"
UA = {"User-Agent": "Mozilla/5.0 (sparplan-site; github.com/Maik45133/sparplan-site)"}
HEUTE = dt.date.today()


def log(*t) -> None:
    print(*t, flush=True)


def holen(url: str, timeout: int = 25):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ── Kurse ───────────────────────────────────────────────────────────────

_YC: dict = {}


def yahoo(symbol: str, tage: int = 400) -> dict | None:
    """Tagesschlusskurse plus Name, Waehrung und 52-Wochen-Hoch."""
    if symbol in _YC:
        return _YC[symbol]
    p2 = int(time.time())
    p1 = p2 - tage * 86400
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/"
           f"{urllib.parse.quote(symbol)}?interval=1d&period1={p1}&period2={p2}")
    out = None
    for _ in range(2):
        try:
            r = holen(url)["chart"]["result"][0]
            ts = r.get("timestamp") or []
            cl = r["indicators"]["quote"][0]["close"]
            reihe = {dt.datetime.utcfromtimestamp(t).strftime("%Y-%m-%d"): round(c, 4)
                     for t, c in zip(ts, cl) if c}
            m = r.get("meta", {})
            if reihe:
                out = {"reihe": reihe, "waehrung": m.get("currency"),
                       "hoch52": m.get("fiftyTwoWeekHigh"),
                       "name": m.get("longName") or m.get("shortName")}
            break
        except Exception as e:  # noqa: BLE001
            log(f"  yahoo {symbol}: {e}")
            time.sleep(2)
    if not out:
        reihe = kurse.kursreihe(symbol, HEUTE - dt.timedelta(days=tage), HEUTE)
        if reihe:
            out = {"reihe": reihe, "waehrung": None, "hoch52": None, "name": None}
    if out and not out.get("hoch52"):
        letzte = [out["reihe"][d] for d in sorted(out["reihe"])[-252:]]
        out["hoch52"] = max(letzte) if letzte else None
    _YC[symbol] = out
    time.sleep(0.3)
    return out


def letzter(reihe: dict) -> tuple[str, float] | None:
    if not reihe:
        return None
    d = max(reihe)
    return d, reihe[d]


def am(reihe: dict, datum: str) -> float | None:
    return kurse.kurs_am(reihe, datum)


def tm(datum: str) -> str:
    return f"{datum[8:10]}.{datum[5:7]}."


def serie(reihe: dict, tage: int = 63, punkte: int = 21) -> list:
    ds = sorted(reihe)[-tage:]
    if not ds:
        return []
    if len(ds) > punkte:
        schritt = (len(ds) - 1) / (punkte - 1)
        ds = [ds[round(i * schritt)] for i in range(punkte)]
    return [[tm(d), round(reihe[d], 2)] for d in ds]


_FX: dict = {}


def fx_reihe(paar: str) -> dict:
    """Euro je Fremdwaehrungseinheit als Datum -> Kurs. paar: USD oder HKD."""
    if paar in _FX:
        return _FX[paar]
    y = yahoo(f"EUR{paar}=X", 400)
    reihe = {d: round(1 / v, 6) for d, v in (y or {}).get("reihe", {}).items() if v}
    if not reihe and paar == "USD":
        w = kurse.fx_eur_je_usd()
        if w:
            reihe = {HEUTE.isoformat(): w}
    _FX[paar] = reihe
    return reihe


def fx_am(waehrung: str | None, datum: str | None = None) -> float:
    if not waehrung or waehrung == "EUR":
        return 1.0
    if waehrung == "GBp":
        return fx_am("GBP", datum) / 100
    reihe = fx_reihe(waehrung)
    if not reihe:
        return 1.0
    if datum is None:
        return letzter(reihe)[1]
    return am(reihe, datum) or letzter(reihe)[1]


# ── Handelbarkeit bei Trade Republic ────────────────────────────────────


def ls_gelistet(isin: str | None) -> bool | None:
    """LS Exchange als Stellvertreter: dort gelistet heisst bei TR mit
    Bestpreis handelbar. Nicht gefunden heisst nicht unmoeglich, sondern:
    in der App suchen, eventuell nur per Direktpreis in New York."""
    if not isin:
        return None
    try:
        r = holen("https://www.ls-tc.de/_rpc/json/.lstc/instrument/search/main?localeId=2&q=" + isin)
        time.sleep(0.4)
        return any(x.get("isin") == isin for x in r)
    except Exception as e:  # noqa: BLE001
        log(f"  LS {isin}: {e}")
        return None


def spread_pct(isin: str | None) -> float | None:
    """Spread an LS Exchange, sonst gettex, aus dem letzten Geld- und Briefkurs."""
    if not isin:
        return None
    try:
        d = holen(f"https://api.onvista.de/api/v1/stocks/ISIN:{isin}/snapshot")
        time.sleep(0.8)
    except Exception as e:  # noqa: BLE001
        log(f"  onvista {isin}: {e}")
        return None
    maerkte = {q.get("market", {}).get("codeExchange"): q for q in d.get("quoteList", {}).get("list", [])}
    for code in ("LSX", "TRO"):
        q = maerkte.get(code)
        if q and q.get("bid") and q.get("ask"):
            mitte = (q["bid"] + q["ask"]) / 2
            return round((q["ask"] - q["bid"]) / mitte * 100, 2)
    return None


def isin_finden(isin: str | None, name: str) -> str | None:
    """Das Screening liefert manchmal die kanadische Hinterlegungsschein-ISIN
    (CA...) oder gar keine. Die taugt nicht fuer die Suche in Trade Republic."""
    if isin and len(isin) == 12 and not isin.startswith("CA"):
        return isin
    erstes = (name.split() or [""])[0].lower()
    for frage in dict.fromkeys([name, name.replace(" and ", " & "), name.split()[0] if name.split() else name]):
        try:
            r = holen("https://api.onvista.de/api/v1/instruments/query?limit=10&searchValue="
                      + urllib.parse.quote(frage))
            time.sleep(0.6)
        except Exception as e:  # noqa: BLE001
            log(f"  ISIN-Suche {frage}: {e}")
            continue
        kand = [(x.get("isin"), (x.get("name") or "").lower()) for x in r.get("list", [])
                if x.get("entityType") == "STOCK" and x.get("isin")]
        kand = [k for k in kand if k[1].startswith(erstes)] or kand
        for k, _ in kand:
            if k.startswith("US"):
                return k
        for k, _ in kand:
            if not k.startswith("CA"):
                return k
    return isin if isin and len(isin) == 12 else None


# ── Namen und Branchen ──────────────────────────────────────────────────

BRANCHEN = {
    "Semiconductors": "Halbleiter", "Semiconductor Equipment & Materials": "Halbleiter-Ausrüstung",
    "Biotechnology": "Biotechnologie", "Health Information Services": "Digitale Gesundheit",
    "Drug Manufacturers - Specialty & Generic": "Pharma", "Drug Manufacturers - General": "Pharma",
    "Software - Application": "Software", "Software - Infrastructure": "Software-Infrastruktur",
    "Internet Retail": "Onlinehandel", "Computer Hardware": "Hardware und Speicher",
    "Communication Equipment": "Netzwerktechnik", "Medical Instruments & Supplies": "Medizintechnik",
    "Medical Devices": "Medizintechnik", "Diagnostics & Research": "Diagnostik",
    "Aerospace & Defense": "Luft- und Raumfahrt", "Electronic Components": "Elektronikbauteile",
    "Internet Content & Information": "Internet", "Information Technology Services": "IT-Dienstleistungen",
    "Airlines": "Fluggesellschaft", "Beverages - Non-Alcoholic": "Getränke",
    "Residential Construction": "Wohnungsbau", "Entertainment": "Unterhaltung",
    "Credit Services": "Finanzdienstleister", "Consumer Electronics": "Unterhaltungselektronik",
    "Medical Care Facilities": "Gesundheitsdienste", "Grocery Stores": "Lebensmittelhandel",
    "Specialty Retail": "Einzelhandel", "Auto Manufacturers": "Autobauer",
    "Scientific & Technical Instruments": "Messtechnik", "Electrical Equipment & Parts": "Elektrotechnik",
    "Specialty Industrial Machinery": "Maschinenbau", "Banks - Regional": "Regionalbank",
    "Capital Markets": "Kapitalmarkt", "Insurance - Property & Casualty": "Versicherung",
    "Asset Management": "Vermögensverwaltung", "Telecom Services": "Telekommunikation",
    "Utilities - Renewable": "Erneuerbare Energie", "Solar": "Solar",
    "Furnishings, Fixtures & Appliances": "Einrichtung", "Leisure": "Freizeit",
    "Restaurants": "Gastronomie", "Packaged Foods": "Lebensmittel",
}
TECH_BRANCHEN = {"Semiconductors", "Semiconductor Equipment & Materials", "Software - Application",
                 "Software - Infrastructure", "Computer Hardware", "Communication Equipment",
                 "Electronic Components", "Information Technology Services", "Consumer Electronics",
                 "Scientific & Technical Instruments"}

ENDUNGEN = [", Inc.", ", Inc", " Inc.", " Inc", " Incorporated", " Corporation", " Corp.", " Corp",
            " Holdings plc", " Holdings PLC", " plc", " PLC", " N.V.", " Ltd.", " Ltd", " S.A.", " AG",
            " Co.", " Company", " Group Inc.", " Holdings Inc."]


def name_putzen(name: str) -> str:
    n = (name or "").strip()
    for _ in range(3):
        for e in ENDUNGEN:
            if n.endswith(e):
                n = n[: -len(e)].rstrip(" ,")
    if n.isupper() and len(n) > 4:
        n = n.title()
    return n.replace(" And ", " and ")


# ── Gruende dafuer und dagegen ──────────────────────────────────────────


def de(x: float, d: int = 0) -> str:
    s = f"{x:,.{d}f}"
    return s.replace(",", "X").replace(".", ",").replace("X", ".")


def gruende(dos: dict) -> tuple[list, list]:
    e = dos["enrichment"]
    c = {k["name"]: k for k in dos["scorecard"]["components"]}
    pro, con = [], []

    def n(name):
        return (c.get(name) or {}).get("normalized")

    def w(name):
        return (c.get(name) or {}).get("weight") or 0

    def raw(name):
        return (c.get(name) or {}).get("raw")

    m = n("momentum_12_1")
    if m is not None and m >= 60 and raw("momentum_12_1") is not None:
        pro.append((m * w("momentum_12_1"), f"Kurs in 12 Monaten {'+' if raw('momentum_12_1') >= 0 else ''}{de(raw('momentum_12_1'))} % (ohne letzten Monat), stärker als {de(m)} % der Vergleichsgruppe"))
    if m is not None and m < 35 and raw("momentum_12_1") is not None:
        con.append((100 - m, f"Schwaches Momentum: {de(raw('momentum_12_1'))} % in 12 Monaten"))
    up, dn = e.get("up_revisions_30d"), e.get("down_revisions_30d")
    r = n("revision_momentum")
    if up is not None and r is not None:
        if r >= 60:
            pro.append((r * w("revision_momentum"), f"Analysten heben an: {up} Anhebungen, {dn} Senkungen in 30 Tagen"))
        if r < 35:
            con.append((100 - r, f"Analysten senken: {dn} Senkungen, {up} Anhebungen in 30 Tagen"))
    g = n("growth_acceleration")
    g0, g1 = e.get("revenue_growth_prior_q"), e.get("revenue_growth_recent_q")
    if g is not None and g0 is not None and g1 is not None and not dos.get("base_effect"):
        if g >= 60:
            pro.append((g * w("growth_acceleration"), f"Umsatzwachstum beschleunigt von {de(g0)} auf {de(g1)} %"))
        if g < 35:
            con.append((100 - g, f"Wachstum bremst von {de(g0)} auf {de(g1)} %"))
    ed, er = n("earnings_drift"), e.get("earnings_reaktion")
    if ed is not None and er is not None:
        if ed >= 60:
            pro.append((ed * w("earnings_drift"), f"Positive Reaktion auf die letzten Zahlen: +{de(er, 1)} %"))
        if ed < 35:
            con.append((100 - ed, f"Schwache Reaktion auf die letzten Zahlen: {de(er, 1)} %"))
    mt = n("margin_trend")
    if mt is not None and mt >= 75:
        pro.append((mt * w("margin_trend"), "Bruttomarge steigt"))
    ft = n("fcf_trend")
    if ft is not None and ft >= 75:
        pro.append((ft * w("fcf_trend"), "Freier Cashflow verbessert sich"))
    if ft is not None and ft < 25:
        con.append((100 - ft, "Freier Cashflow wird schwächer"))
    dil = raw("dilution")
    if dil is not None and dil > 0.1:
        con.append((100 - (n("dilution") or 0), f"Verwässerung: {de(dil * 100)} % mehr Aktien als vor einem Jahr"))
    if e.get("insider_buyers_90d"):
        pro.append((90, f"Insider haben über die Börse gekauft ({e['insider_buyers_90d']})"))
    if dos.get("base_effect"):
        con.append((99, "Umsatzsprung ist ein Basiseffekt, kein echtes Wachstum"))
    sh = e.get("short_pct_float")
    if sh and sh >= 10:
        con.append((60, f"Leerverkaufsquote {de(sh, 1)} %"))
    pro = [t for _, t in sorted(pro, key=lambda x: -x[0])[:3]]
    con = [t for _, t in sorted(con, key=lambda x: -x[0])[:3]]
    return pro, con


# ── Bausteine der app.json ──────────────────────────────────────────────

GROESSEN = [
    {"key": "klein", "titel": "Klein", "spanne": "1 bis 5 Mrd $ Börsenwert"},
    {"key": "mittel", "titel": "Mittel", "spanne": "5 bis 20 Mrd $ Börsenwert"},
    {"key": "gross", "titel": "Groß", "spanne": "über 20 Mrd $ Börsenwert"},
]


def brauchbar(d: dict) -> bool:
    return bool(d.get("scorecard", {}).get("reliable")) and not d.get("exclusion_reason")


def kandidat(dos: dict, rang: int, n: int, fx_now: float) -> dict:
    c = dos["candidate"]
    sym = c["symbol"]
    y = yahoo(sym) or {}
    reihe = y.get("reihe", {})
    jetzt = letzter(reihe)
    kurs = jetzt[1] if jetzt else dos.get("price")
    name = name_putzen(y.get("name") or c.get("name") or sym)
    isin = isin_finden(c.get("isin"), name)
    gelistet = ls_gelistet(isin)
    pro, con = gruende(dos)
    ind = dos.get("industry") or c.get("sector") or ""
    ne = dos["enrichment"].get("next_earnings")
    log(f"  {sym:6s} {name[:28]:28s} {isin}  LS={gelistet}")
    return {
        "sym": sym, "name": name, "branche": BRANCHEN.get(ind, ind), "rang": rang, "n": n,
        "score": round(dos["scorecard"]["total"], 1),
        "mcap": round((c.get("market_cap") or 0) / 1e9, 1),
        "kursUSD": round(kurs, 2) if kurs else None,
        "kursEUR": round(kurs * fx_now, 2) if kurs else None,
        "vomHoch": round((kurs / y["hoch52"] - 1) * 100, 1) if kurs and y.get("hoch52") else None,
        "zahlen": tm(ne) if ne else None, "zahlenISO": ne,
        "pro": pro, "con": con,
        "handel": None if gelistet is None else ("ja" if gelistet else "nein"),
        "spread": spread_pct(isin) if gelistet else None,
        "tech": ind in TECH_BRANCHEN, "isin": isin,
        "serie": serie(reihe),
    }


def tiers(latest: dict, fx_now: float) -> dict:
    w = sorted([d for d in latest.get("dossiers", []) if brauchbar(d)], key=lambda d: -d["scorecard"]["total"])
    g = sorted([d for d in latest.get("dossiers_large_cap", []) if brauchbar(d)], key=lambda d: -d["scorecard"]["total"])
    klein = [d for d in w if (d["candidate"].get("market_cap") or 0) < 5e9]
    mittel = [d for d in w if 5e9 <= (d["candidate"].get("market_cap") or 0) < 20e9]
    out = {}
    for key, liste in (("klein", klein), ("mittel", mittel), ("gross", g)):
        log(f"Korb {key}: {len(liste)} brauchbar")
        out[key] = [kandidat(d, i + 1, len(liste), fx_now) for i, d in enumerate(liste[:3])]
    return out


def indizes() -> list:
    out = []
    for name, sym, stellen in (("S&P 500", "^GSPC", 2), ("Nasdaq 100", "^NDX", 2), ("DAX", "^GDAXI", 2),
                               ("Russell 2000", "^RUT", 2), ("EUR/USD", "EURUSD=X", 4)):
        y = yahoo(sym, 30)
        if not y or len(y["reihe"]) < 2:
            continue
        ds = sorted(y["reihe"])
        a, b = y["reihe"][ds[-2]], y["reihe"][ds[-1]]
        out.append({"name": name, "wert": round(b, stellen), "chg": round((b / a - 1) * 100, 2), "d": stellen})
    return out


def laeufe_waehlen(daten: list) -> list:
    """Ein Lauf je Kalenderwoche, der vom Samstag bevorzugt. Wiederholungslaeufe
    am Sonntag oder unter der Woche zaehlen sonst doppelt."""
    wochen: dict = {}
    for d in sorted(set(daten)):
        tag = dt.date.fromisoformat(d)
        wochen.setdefault(tag.isocalendar()[:2], []).append(tag)
    out = []
    for tage in wochen.values():
        sa = [t for t in tage if t.weekday() == 5]
        out.append((sa[0] if sa else max(tage)).isoformat())
    return sorted(out, reverse=True)


def archiv(tr: list, fx_now: float) -> dict:
    laeufe, namen, alle = [], {}, []
    for d in laeufe_waehlen([e["date"] for e in tr]):
        zeilen = []
        for e in [e for e in tr if e["date"] == d and e.get("rank", 99) <= 3]:
            y = yahoo(e["symbol"]) or {}
            j = letzter(y.get("reihe", {}))
            if not j or not e.get("price_at_entry"):
                continue
            fx_e = e.get("fx_at_entry") or fx_am("USD", d)
            usd = (j[1] / e["price_at_entry"] - 1) * 100
            eur = ((j[1] / e["price_at_entry"]) * (fx_now / fx_e) - 1) * 100
            zeilen.append([e["symbol"], e.get("korb") or "klein", round(usd, 1), round(eur, 1)])
            namen[e["symbol"]] = name_putzen(y.get("name") or e.get("name") or e["symbol"])
        if not zeilen:
            continue
        werte = [z[3] for z in zeilen]
        alle += werte
        laeufe.append({"d": d, "rows": zeilen, "median": round(statistics.median(werte), 1),
                       "plus": sum(v > 0 for v in werte), "n": len(werte)})
    return {"median": round(statistics.median(alle), 1) if alle else None,
            "plus": sum(v > 0 for v in alle), "n": len(alle), "laeufe": laeufe, "namen": namen}


def virtuell() -> list:
    try:
        vp = json.loads((DATA / "virtual_portfolio.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    out = []
    for p in vp.get("positionen", []):
        if p.get("rendite_pct") is None:
            continue
        out.append({"sym": p["symbol"], "name": name_putzen(p.get("name") or p["symbol"]),
                    "seit": tm(p["opened"]), "pct": round(p["rendite_pct"], 1),
                    "quelle": p.get("quelle"), "status": p.get("status")})
    return out


# ── Gekauft: Issues einlesen und auswerten ──────────────────────────────


def _gh_kopf() -> dict | None:
    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        return None
    return {**UA, "Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"}


def gh(methode: str, pfad: str, daten: dict | None = None):
    kopf, repo = _gh_kopf(), os.environ.get("GITHUB_REPOSITORY")
    if not kopf or not repo:
        return None
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}{pfad}", headers=kopf, method=methode,
                                 data=json.dumps(daten).encode("utf-8") if daten is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            text = r.read().decode("utf-8")
            return json.loads(text) if text else {}
    except urllib.error.HTTPError as e:
        if not (methode == "POST" and pfad == "/labels" and e.code == 422):
            log(f"  GitHub {methode} {pfad}: {e}")
    except Exception as e:  # noqa: BLE001
        log(f"  GitHub {methode} {pfad}: {e}")
    return None


def feld(text: str, ueberschrift: str) -> str | None:
    """Wert unter einer Formular-Ueberschrift, so wie GitHub Issue-Formulare ihn rendern."""
    m = re.search(r"###\s*" + re.escape(ueberschrift) + r"\s*\n+(.+?)(?:\n###|\Z)", text or "", re.S | re.I)
    if not m:
        return None
    wert = m.group(1).strip()
    return None if not wert or wert.startswith("_No response") else wert


def zahl(text: str | None) -> float | None:
    if not text:
        return None
    m = re.search(r"\d[\d.,]*", text)
    if not m:
        return None
    s = m.group(0)
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def gekauft_laden() -> list:
    try:
        return json.loads(GEKAUFT_DATEI.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


def gekauft_issues(liste: list) -> list[str]:
    meldungen = []
    gh("POST", "/labels", {"name": "gekauft", "color": "1f6feb",
                           "description": "Echter Kauf oder Verkauf, aus der App"})
    issues = gh("GET", "/issues?state=open&labels=gekauft&per_page=100") or []
    for i in issues:
        if "pull_request" in i:
            continue
        titel = (i.get("title") or "").strip()
        sym = "".join(ch for ch in (titel.split() or [""])[0] if ch.isalnum() or ch in ".-^").upper()
        nummer, rumpf = i["number"], i.get("body") or ""
        datum = i.get("created_at", "")[:10] or HEUTE.isoformat()
        iso = re.search(r"(\d{4}-\d{2}-\d{2})", feld(rumpf, "Datum") or "")
        if iso and iso.group(1) <= datum:
            datum = iso.group(1)
        kurs = zahl(feld(rumpf, "Kurs in Euro"))
        if not sym:
            gh("POST", f"/issues/{nummer}/comments", {"body": "Kein Ticker im Titel erkannt."})
            continue
        if "verkauft" in titel.lower():
            offen = [g for g in liste if g["sym"] == sym and g.get("status") == "offen"]
            for g in offen:
                g.update(status="verkauft", verkauft_datum=datum, verkauft_kurs_eur=kurs)
            text = (f"**{sym}** als verkauft eingetragen zum {datum}." if offen
                    else f"Kein offener Kauf von **{sym}** gefunden.")
        else:
            liste.append({"sym": sym, "datum": datum, "kaufkurs_eur": kurs,
                          "betrag_eur": zahl(feld(rumpf, "Betrag in Euro")),
                          "status": "offen", "issue": i.get("html_url")})
            text = (f"**{sym}** als gekauft eingetragen zum {datum}"
                    + (f" zu {de(kurs, 2)} €." if kurs else ", Kurs ist der Schlusskurs des Tages.")
                    + " In ein bis zwei Minuten steht es in der App unter Archiv.")
        meldungen.append(text)
        gh("POST", f"/issues/{nummer}/comments", {"body": text})
        gh("PATCH", f"/issues/{nummer}", {"state": "closed"})
    return meldungen


def gekauft_auswerten(liste: list) -> list:
    out = []
    for g in liste:
        y = yahoo(g["sym"]) or {}
        reihe, w = y.get("reihe", {}), y.get("waehrung") or "USD"
        if not g.get("name"):
            g["name"] = name_putzen(y.get("name") or g["sym"])
        if g.get("kaufkurs_eur") is None and reihe and g["datum"] in reihe:
            g["kaufkurs_eur"] = round(reihe[g["datum"]] * fx_am(w, g["datum"]), 4)
        if g.get("status") == "verkauft" and g.get("verkauft_kurs_eur") is None and reihe \
                and g.get("verkauft_datum") in reihe:
            g["verkauft_kurs_eur"] = round(reihe[g["verkauft_datum"]] * fx_am(w, g["verkauft_datum"]), 4)
        j = letzter(reihe)
        ende = g.get("verkauft_kurs_eur") if g.get("status") == "verkauft" else (j[1] * fx_am(w) if j else None)
        pct = (ende / g["kaufkurs_eur"] - 1) * 100 if ende and g.get("kaufkurs_eur") else None
        out.append({"sym": g["sym"], "name": g["name"], "seit": tm(g["datum"]), "status": g.get("status", "offen"),
                    "kaufkurs": g.get("kaufkurs_eur"), "betrag": g.get("betrag_eur"),
                    "pct": round(pct, 1) if pct is not None else None,
                    "bis": tm(g["verkauft_datum"]) if g.get("verkauft_datum") else None})
    return out


# ── Depot, verschluesselt ───────────────────────────────────────────────


def _aes():
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    return AESGCM


def entschluesseln(box: dict, passwort: str) -> dict:
    key = hashlib.pbkdf2_hmac("sha256", passwort.encode(), base64.b64decode(box["salt"]), box.get("iter", 210000), dklen=32)
    klar = _aes()(key).decrypt(base64.b64decode(box["iv"]), base64.b64decode(box["ct"]), None)
    return json.loads(klar.decode("utf-8"))


def verschluesseln(daten: dict, passwort: str, salt_b64: str, iterationen: int) -> dict:
    """Gleiches Salz wie depot.enc, neuer Zufalls-IV. So passt ein einmal am
    Geraet abgeleiteter Schluessel auch zur woechentlich erneuerten Datei."""
    key = hashlib.pbkdf2_hmac("sha256", passwort.encode(), base64.b64decode(salt_b64), iterationen, dklen=32)
    iv = os.urandom(12)
    ct = _aes()(key).encrypt(iv, json.dumps(daten, ensure_ascii=False).encode("utf-8"), None)
    return {"v": 2, "kdf": "PBKDF2-SHA256", "iter": iterationen, "salt": salt_b64,
            "iv": base64.b64encode(iv).decode(), "ct": base64.b64encode(ct).decode()}


def termine_fuer(symbol: str, latest: dict) -> str | None:
    for key in ("dossiers", "dossiers_large_cap", "dossiers_early_bets"):
        for d in latest.get(key, []):
            if d["candidate"]["symbol"] == symbol and d["enrichment"].get("next_earnings"):
                return d["enrichment"]["next_earnings"]
    try:
        import yfinance  # type: ignore
        cal = yfinance.Ticker(symbol).calendar
        ed = cal.get("Earnings Date") if isinstance(cal, dict) else None
        if ed:
            d = ed[0] if isinstance(ed, (list, tuple)) else ed
            return str(d)[:10]
    except Exception:  # noqa: BLE001
        pass
    return None


def sparplan_tage(tag: int, nach: str, bis: str) -> list[str]:
    """Ausfuehrungstage eines Monatsplans nach dem Bestandsdatum."""
    out, d = [], dt.date.fromisoformat(nach).replace(day=1)
    ende = dt.date.fromisoformat(bis)
    while d <= ende:
        try:
            t = d.replace(day=tag)
        except ValueError:
            t = (d.replace(day=28))
        if nach < t.isoformat() <= bis:
            out.append(t.isoformat())
        d = (d.replace(day=28) + dt.timedelta(days=4)).replace(day=1)
    return out


def depot_live(bestand: dict, latest: dict) -> dict | None:
    """Bestand vom Screenshot plus Kurse seitdem plus ausgefuehrte Sparplanraten."""
    if bestand.get("version") != 2:
        log("depot.enc ist noch im alten Format (nur Gewichte). Bitte einmal neu verschluesseln.")
        return None
    stand = bestand["stand"]
    plan = {s["symbol"]: s for s in bestand.get("sparplan", [])}
    poss, reihen, raten = [], {}, 0.0
    for p in bestand["positionen"]:
        y = yahoo(p["symbol"], 400)
        reihe = (y or {}).get("reihe", {})
        w = (y or {}).get("waehrung") or p.get("waehrung") or "EUR"
        k0 = am(reihe, stand) if reihe else None
        stueck = p["wert_eur"] / (k0 * fx_am(w, stand)) if k0 else None
        einstand = p["wert_eur"] - p["gewinn_eur"]
        j = letzter(reihe)
        if stueck and j and p["symbol"] in plan:
            for t in sparplan_tage(plan[p["symbol"]]["tag"], stand, j[0]):
                kt = am(reihe, t)
                if kt:
                    rate = plan[p["symbol"]]["rate_eur"]
                    stueck += rate / (kt * fx_am(w, t))
                    einstand += rate
                    raten += rate
        if not stueck:
            log(f"  Depot: keine Kurse fuer {p['symbol']}, Wert vom {stand} bleibt stehen.")
        wert = stueck * j[1] * fx_am(w) if stueck and j else p["wert_eur"]
        ds = sorted(reihe)
        t3m = (reihe[ds[-1]] / reihe[ds[-64]] - 1) * 100 if len(ds) > 64 else None
        ne = termine_fuer(p["symbol"], latest) if p["art"] == "Aktie" else None
        if stueck:
            reihen[p["symbol"]] = (stueck, reihe, w)
        poss.append({"k": p["symbol"], "name": p["name"], "art": p["art"], "isin": p.get("isin"),
                     "ex": {"USD": "US", "HKD": "HK"}.get(w, "XETRA"), "waehrung": w,
                     "sparplan": plan.get(p["symbol"], {}).get("rate_eur"),
                     "wert": round(wert, 2), "einstand": round(einstand, 2),
                     "gewinn": round(wert - einstand, 2), "pct": round((wert / einstand - 1) * 100, 2),
                     "t3m": round(t3m, 1) if t3m is not None else None,
                     "vomHoch": round((j[1] / y["hoch52"] - 1) * 100, 1) if j and y and y.get("hoch52") else None,
                     "zahlen": tm(ne) if ne else None, "zahlenISO": ne, "serie": serie(reihe)})
    gesamt = sum(p["wert"] for p in poss)
    einstand = sum(p["einstand"] for p in poss)
    for p in poss:
        p["gewicht"] = round(p["wert"] / gesamt * 100, 2) if gesamt else 0
    # Verlauf: heutiger Bestand mit Tageskursen und Tageswechselkurs, ohne Sparraten
    tage = sorted({d for _, r, _ in reihen.values() for d in r})[-66:]
    verlauf = []
    for d in tage:
        summe = sum(st * (am(r, d) or 0) * fx_am(w, d) for st, r, w in reihen.values())
        summe += sum(p["wert"] for p in poss if p["k"] not in reihen)
        verlauf.append([tm(d), round(summe, 2)])
    if len(verlauf) > 45:
        s = (len(verlauf) - 1) / 44
        verlauf = [verlauf[round(i * s)] for i in range(45)]
    kurse_stand = max((max(r) for _, r, _ in reihen.values()), default=stand)
    return {"version": 2, "bestand_stand": stand, "kurse_stand": kurse_stand,
            "erstellt": dt.datetime.utcnow().isoformat(timespec="minutes"),
            "wert": round(gesamt, 2), "einstand": round(einstand, 2),
            "gewinn": round(gesamt - einstand, 2), "sparraten_seit_stand": round(raten, 2),
            "sparplan": [{"name": next((p["name"] for p in bestand["positionen"] if p["symbol"] == s), s),
                          "rate_eur": v["rate_eur"], "tag": v["tag"]} for s, v in plan.items()],
            "seitKauf": round((gesamt / einstand - 1) * 100, 2) if einstand else None,
            "serie": verlauf, "positionen": sorted(poss, key=lambda p: -p["wert"])}


def depot_bauen(passwort: str | None, latest: dict) -> bool:
    if not passwort:
        log("Kein DEPOT_PASSWORT, verschluesseltes Depot wird uebersprungen.")
        return False
    if not DEPOT_ENC.exists():
        log("data/depot.enc fehlt.")
        return False
    box = json.loads(DEPOT_ENC.read_text(encoding="utf-8"))
    try:
        bestand = entschluesseln(box, passwort)
    except Exception:  # noqa: BLE001
        log("Passwort passt nicht zu data/depot.enc, Depot wird uebersprungen.")
        return False
    live = depot_live(bestand, latest)
    if not live:
        return False
    DEPOT_LIVE.write_text(json.dumps(verschluesseln(live, passwort, box["salt"], box.get("iter", 210000))),
                          encoding="utf-8")
    log(f"Depot: {len(live['positionen'])} Positionen, {live['wert']:.2f} EUR, verschluesselt geschrieben.")
    return True


# ── Ablauf ──────────────────────────────────────────────────────────────


def main(argv: list) -> int:
    nur_gekauft = "--gekauft" in argv
    liste = gekauft_laden()
    meldungen = gekauft_issues(liste)
    for m in meldungen:
        log(m)

    if nur_gekauft and APP_DATEI.exists():
        app = json.loads(APP_DATEI.read_text(encoding="utf-8"))
        app["gekauft"] = gekauft_auswerten(liste)
        GEKAUFT_DATEI.write_text(json.dumps(liste, ensure_ascii=False, indent=1), encoding="utf-8")
        APP_DATEI.write_text(json.dumps(app, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        log(f"Gekauft aktualisiert: {len(liste)} Eintraege.")
        return 0

    latest = json.loads((DATA / "latest.json").read_text(encoding="utf-8"))
    tr = json.loads((DATA / "track_record.json").read_text(encoding="utf-8"))
    fx_now = fx_am("USD")
    log(f"EUR je USD: {fx_now:.4f}")
    idx = indizes()
    spx = yahoo("^GSPC", 30)
    kurse_stand = letzter(spx["reihe"])[0] if spx else HEUTE.isoformat()
    app = {
        "erstellt": dt.datetime.utcnow().isoformat(timespec="minutes"),
        "lauf": (latest.get("generated_at") or "")[:10],
        "kurse_stand": kurse_stand,
        "fx_eur_je_usd": round(fx_now, 4),
        "indizes": idx,
        "groessen": GROESSEN,
        "tiers": tiers(latest, fx_now),
        "archiv": archiv(tr, fx_now),
        "virtuell": virtuell(),
        "gekauft": gekauft_auswerten(liste),
    }
    GEKAUFT_DATEI.write_text(json.dumps(liste, ensure_ascii=False, indent=1), encoding="utf-8")
    APP_DATEI.write_text(json.dumps(app, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    log(f"app.json geschrieben, Lauf {app['lauf']}, Kurse {kurse_stand}.")

    if "--ohne-depot" not in argv:
        pw = os.environ.get("DEPOT_PASSWORT")
        if not pw and sys.stdin.isatty():
            pw = getpass.getpass("Depot-Passwort (leer lassen zum Ueberspringen): ") or None
        depot_bauen(pw, latest)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
