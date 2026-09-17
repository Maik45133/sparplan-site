#!/usr/bin/env python3
"""Score-Register: misst, ob der Score ueberhaupt eine Kante hat.

Warum es das gibt
-----------------
Das virtuelle Depot misst Treffer unter sehr wenigen Picks. Um bei
Aktienauswahl Koennen von Zufall zu trennen, braucht man grob 30 bis 50
unabhaengige Beobachtungen. Bei einem Titel je Korb dauert das Jahre.

Gleichzeitig bewertet jeder Datenlauf rund siebzig Kandidaten und wirft alle
bis auf die Spitze weg. Die eigentliche Frage ist aber nicht "hat mein Pick
gewonnen", sondern **"korreliert der Score ueberhaupt mit der spaeteren
Rendite"**, und die laesst sich ueber alle siebzig gleichzeitig beantworten.

Ein Lauf liefert damit eine belastbare Beobachtung statt drei Muenzwuerfen.
Groessenordnung: rund zwanzigmal schneller als der Weg ueber die Picks, mit
Daten, die ohnehin schon erhoben werden.

Was gerechnet wird
------------------
Je Datenlauf und je Horizont (30, 60, 90 Kalendertage) die **Rangkorrelation
nach Spearman** zwischen Score und benchmarkbereinigter Folgerendite. Das ist
der Information Coefficient. Zusaetzlich:

- dieselbe Rechnung **je Score-Komponente einzeln**. Erst das beantwortet die
  Frage, welche der Komponenten ueberhaupt etwas vorhersagt und welche nur
  Gewicht verbraucht. Ohne diese Zahl bleibt jede Aenderung an den Gewichten
  geraten.
- der **Terzil-Abstand**: mittlere Ueberrendite des besten Drittels minus die
  des schlechtesten. Weniger elegant als der IC, dafuer sofort verstaendlich.

Drei Dinge, die hier bewusst streng gehalten sind
-------------------------------------------------
**Benchmarkbereinigt.** Die drei Koerbe haben verschiedene Marktexposition.
Wer sie ungefiltert in einen Topf wirft, misst zum Teil, welcher Korb gerade
laeuft, und nennt es Auswahlqualitaet. Gerechnet wird deshalb gegen den
Vergleichsindex des jeweiligen Korbs.

**Kein Nachruecken beim Stichtag.** Ein Kurs wird am Stichtag oder am letzten
Handelstag davor genommen, nie danach.

**Fehlende Kurse werden gezaehlt und ausgewiesen.** Ein Titel ohne Kurs am
Stichtag ist meist delistet, also ueberwiegend ein schlechter Fall. Faellt er
still aus der Rechnung, sieht der Score besser aus, als er ist. Die Zahl
`fehlend` steht deshalb in jeder Auswertung.
"""
from __future__ import annotations

import datetime as dt
import json
import math
import sys
import time
from pathlib import Path

from kurse import fx_eur_je_usd, kurs_am, kursreihe, log  # noqa: F401

ROOT = Path(__file__).resolve().parent.parent
REGISTER_DATEI = ROOT / "data" / "score_register.json"
LATEST_DATEI = ROOT / "data" / "latest.json"

HORIZONTE = (30, 60, 90)

KOERBE = {
    "klein": {"feld": "dossiers", "benchmark": "IWO", "titel": "Wachstum"},
    "gross": {"feld": "dossiers_large_cap", "benchmark": "^GSPC", "titel": "Grosse Werte"},
    "frueh": {"feld": "dossiers_early_bets", "benchmark": "IWO", "titel": "Fruehphase"},
}

# Unter dieser Zahl unabhaengiger Beobachtungen ist jede Aussage ueber die
# Kante Rauschen.
#
# Gezaehlt werden KALENDERWOCHEN, nicht Laeufe. Siebzig Titel derselben Woche
# bewegen sich weitgehend gemeinsam und sind keine siebzig Beobachtungen, und
# drei Laeufe an drei aufeinanderfolgenden Tagen sind keine drei Wochen. Genau
# diesen Fehler hatte das alte Register schon einmal (siehe
# Architektur-Entscheidung, Kalenderwochen-Fix), er soll hier nicht erneut
# entstehen: Laeufe derselben Woche werden zu einer Beobachtung gemittelt.
MIN_WOCHEN = 12

# Ab so vielen Titeln je Lauf ist eine Rangkorrelation ueberhaupt rechenbar.
MIN_TITEL = 8


def heute() -> dt.date:
    return dt.date.today()


# Groesste Luecke, die ein Kurs zum Stichtag haben darf. Feiertage und
# Handelspausen sind selten laenger als ein paar Tage.
#
# Diese Zahl ist wichtiger, als sie aussieht. `kurs_am` nimmt den letzten Kurs
# vor dem Stichtag. Bei einem delisteten Titel steht dort auf ewig der letzte
# Kurs vor dem Delisting, und die Rechnung ergibt saubere null Prozent statt
# des Totalverlusts, der meistens dahintersteckt. Ein Register, das so rechnet,
# sieht systematisch besser aus als die Wirklichkeit, und zwar genau bei den
# Titeln, deren Ausfall die interessante Information waere.
MAX_KURSLUECKE_TAGE = 7


def kurs_am_streng(reihe: dict[str, float], datum: str,
                   max_luecke: int = MAX_KURSLUECKE_TAGE) -> float | None:
    """Wie kurs_am, aber nur wenn der gefundene Kurs nahe genug am Stichtag liegt.

    Sonst None, und der Titel faellt als fehlend aus der Auswertung, statt mit
    einem eingefrorenen Kurs eine Nullrendite vorzutaeuschen.
    """
    passende = [t for t in reihe if t <= datum]
    if not passende:
        return None
    letzter = max(passende)
    try:
        abstand = (dt.date.fromisoformat(datum) - dt.date.fromisoformat(letzter)).days
    except ValueError:
        return None
    if abstand > max_luecke:
        return None
    return reihe[letzter]


# ── Statistik, von Hand, damit keine Abhaengigkeit noetig ist ────────────


def raenge(werte: list[float]) -> list[float]:
    """Raenge mit Mittelwert bei Bindungen (Standardverfahren fuer Spearman).

    Ohne Bindungsbehandlung waere jede Komponente mit vielen gleichen
    Rohwerten, etwa insider_cluster mit lauter Nullen, systematisch verzerrt.
    """
    sortiert = sorted(range(len(werte)), key=lambda i: werte[i])
    out = [0.0] * len(werte)
    i = 0
    while i < len(sortiert):
        j = i
        while j + 1 < len(sortiert) and werte[sortiert[j + 1]] == werte[sortiert[i]]:
            j += 1
        mittel = (i + j) / 2 + 1
        for k in range(i, j + 1):
            out[sortiert[k]] = mittel
        i = j + 1
    return out


def pearson(a: list[float], b: list[float]) -> float | None:
    n = len(a)
    if n < 3:
        return None
    ma, mb = sum(a) / n, sum(b) / n
    za = [x - ma for x in a]
    zb = [x - mb for x in b]
    nenner = math.sqrt(sum(x * x for x in za) * sum(x * x for x in zb))
    if nenner == 0:
        return None
    return sum(x * y for x, y in zip(za, zb)) / nenner


def spearman(a: list[float], b: list[float]) -> float | None:
    """Rangkorrelation. None, wenn zu wenige Werte oder alles gleich."""
    if len(a) != len(b) or len(a) < MIN_TITEL:
        return None
    return pearson(raenge(a), raenge(b))


def terzil_abstand(schluessel: list[float], rendite: list[float]) -> float | None:
    """Mittlere Rendite des besten Drittels minus die des schlechtesten.

    Der IC sagt, ob ein Zusammenhang besteht. Diese Zahl sagt, wie viel er
    wert waere. Beides gehoert nebeneinander, weil ein statistisch sauberer
    Zusammenhang wirtschaftlich trotzdem zu klein sein kann, um Gebuehren zu
    tragen.
    """
    if len(schluessel) < 9:
        return None
    paare = sorted(zip(schluessel, rendite), key=lambda p: p[0])
    k = len(paare) // 3
    if k == 0:
        return None
    unten = [r for _, r in paare[:k]]
    oben = [r for _, r in paare[-k:]]
    return round(sum(oben) / len(oben) - sum(unten) / len(unten), 3)


def mittel(werte: list[float]) -> float | None:
    return sum(werte) / len(werte) if werte else None


def median(werte: list[float]) -> float | None:
    if not werte:
        return None
    s = sorted(werte)
    m = len(s) // 2
    return s[m] if len(s) % 2 else (s[m - 1] + s[m]) / 2


def t_wert(werte: list[float]) -> float | None:
    """t-Statistik gegen null. Sagt, ob der mittlere IC von null zu trennen ist.

    Faustregel, keine exakte Schwelle: ab etwa 2 wird es interessant, darunter
    ist es mit einem Mittelwert von null vereinbar.
    """
    n = len(werte)
    if n < 3:
        return None
    m = sum(werte) / n
    var = sum((x - m) ** 2 for x in werte) / (n - 1)
    if var <= 0:
        return None
    return round(m / math.sqrt(var / n), 2)


# ── Register lesen und schreiben ─────────────────────────────────────────


def leeres_register() -> dict:
    return {"updated_at": None, "horizonte": list(HORIZONTE),
            "min_wochen": MIN_WOCHEN, "laeufe": [], "zusammenfassung": {},
            "hinweise": []}


def lade_register() -> dict:
    if not REGISTER_DATEI.exists():
        return leeres_register()
    try:
        d = json.loads(REGISTER_DATEI.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        log(f"score_register.json unlesbar ({e}), es wird NICHT ueberschrieben.")
        raise SystemExit(1)
    d.setdefault("laeufe", [])
    d.setdefault("hinweise", [])
    return d


# ── Einfrieren ───────────────────────────────────────────────────────────


def einfrieren(register: dict, quelle: Path | None = None) -> list[str]:
    """Alle Kandidaten eines Datenlaufs festhalten, einmal je Datenstand.

    `quelle` erlaubt das Nachtragen alter Laufdateien (data/universe/*.json aus
    dem privaten Repo). Das ist keine Rueckschau: Diese Dateien wurden damals
    geschrieben und seitdem nicht angefasst, die Scores darin sind genau die,
    die an dem Tag berechnet wurden. Die Kurse kommen ohnehin aus einer
    unabhaengigen Quelle.
    """
    pfad = quelle or LATEST_DATEI
    if not pfad.exists():
        return [f"{pfad.name} fehlt."]
    try:
        latest = json.loads(pfad.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        return [f"{pfad.name} unlesbar: {e}"]

    stand = (latest.get("generated_at") or "")[:10]
    if not stand:
        return ["latest.json ohne generated_at."]
    if any(l["datenstand"] == stand for l in register["laeufe"]):
        return [f"Datenstand {stand} liegt bereits im Register."]

    kandidaten = []
    gewichte: dict[str, int] = {}
    for korb, cfg in KOERBE.items():
        for d in latest.get(cfg["feld"]) or []:
            card = d.get("scorecard") or {}
            sym = (d.get("candidate") or {}).get("symbol")
            if not sym or card.get("total") is None:
                continue
            komp = {}
            for c in card.get("components") or []:
                if c.get("normalized") is not None:
                    komp[c["name"]] = c["normalized"]
                gewichte.setdefault(c.get("name"), c.get("weight"))
            kandidaten.append({
                "symbol": sym,
                "korb": korb,
                "benchmark_symbol": cfg["benchmark"],
                "score": card.get("total"),
                "coverage": card.get("coverage"),
                "reliable": card.get("reliable"),
                "preis_lauf": d.get("price"),
                "komponenten": komp,
            })

    if len(kandidaten) < MIN_TITEL:
        return [f"Nur {len(kandidaten)} Kandidaten im Lauf {stand}, nicht eingefroren."]

    register["laeufe"].append({
        "datenstand": stand,
        "eingefroren_am": heute().isoformat(),
        "gewichte": gewichte,
        "kandidaten": kandidaten,
        "auswertung": {},
    })
    return [f"Lauf {stand} eingefroren, {len(kandidaten)} Kandidaten."]


# ── Kurse fuer alle Symbole, einmal ──────────────────────────────────────


def alle_kursreihen(register: dict) -> dict[str, dict[str, float]]:
    """Ein Abruf je Symbol ueber das gesamte benoetigte Fenster.

    Symbolweise statt je Lauf und Horizont: sonst holt derselbe Titel seine
    Historie fuenfmal, was nur die Wahrscheinlichkeit erhoeht, in eine
    Ratenbegrenzung zu laufen.
    """
    if not register["laeufe"]:
        return {}
    frueheste = min(l["datenstand"] for l in register["laeufe"])
    start = dt.date.fromisoformat(frueheste) - dt.timedelta(days=10)
    ende = heute()

    symbole: set[str] = set()
    for l in register["laeufe"]:
        for k in l["kandidaten"]:
            symbole.add(k["symbol"])
            symbole.add(k["benchmark_symbol"])

    reihen: dict[str, dict[str, float]] = {}
    for i, sym in enumerate(sorted(symbole), start=1):
        reihen[sym] = kursreihe(sym, start, ende)
        if i % 25 == 0:
            log(f"  {i} von {len(symbole)} Symbolen geholt")
        time.sleep(0.15)  # hoeflich gegenueber der Quelle
    fehlend = [s for s, r in reihen.items() if not r]
    log(f"Kursreihen: {len(reihen) - len(fehlend)} von {len(reihen)} gefuellt")
    return reihen


# ── Auswerten ────────────────────────────────────────────────────────────


def werte_lauf_aus(lauf: dict, reihen: dict[str, dict[str, float]]) -> None:
    stand = lauf["datenstand"]
    for h in HORIZONTE:
        stichtag = (dt.date.fromisoformat(stand) + dt.timedelta(days=h))
        if stichtag > heute():
            lauf["auswertung"][str(h)] = None
            continue

        zeilen = []
        fehlend = 0
        for k in lauf["kandidaten"]:
            reihe = reihen.get(k["symbol"]) or {}
            bench = reihen.get(k["benchmark_symbol"]) or {}
            p0 = kurs_am_streng(reihe, stand)
            p1 = kurs_am_streng(reihe, stichtag.isoformat())
            b0 = kurs_am_streng(bench, stand)
            b1 = kurs_am_streng(bench, stichtag.isoformat())
            if not p0 or not p1 or not b0 or not b1:
                fehlend += 1
                continue
            # Benchmarkbereinigt, siehe Modulkopf.
            ueber = (p1 / p0 - 1) * 100 - (b1 / b0 - 1) * 100
            zeilen.append({"k": k, "ueber": ueber, "rendite": (p1 / p0 - 1) * 100})

        if len(zeilen) < MIN_TITEL:
            lauf["auswertung"][str(h)] = {
                "stichtag": stichtag.isoformat(), "n": len(zeilen),
                "fehlend": fehlend, "ic": None,
                "hinweis": "zu wenige Titel mit Kurs"}
            continue

        scores = [z["k"]["score"] for z in zeilen]
        ueber = [z["ueber"] for z in zeilen]

        # IC je Komponente: nur Titel, bei denen die Komponente belegt ist.
        ic_komp: dict[str, dict] = {}
        namen = {n for z in zeilen for n in z["k"]["komponenten"]}
        for name in sorted(namen):
            paare = [(z["k"]["komponenten"][name], z["ueber"])
                     for z in zeilen if name in z["k"]["komponenten"]]
            if len(paare) < MIN_TITEL:
                continue
            x = [p[0] for p in paare]
            y = [p[1] for p in paare]
            ic = spearman(x, y)
            ic_komp[name] = {
                "n": len(paare),
                "ic": round(ic, 3) if ic is not None else None,
                "terzil_abstand": terzil_abstand(x, y),
            }

        ic = spearman(scores, ueber)
        lauf["auswertung"][str(h)] = {
            "stichtag": stichtag.isoformat(),
            "n": len(zeilen),
            "fehlend": fehlend,
            "ic": round(ic, 3) if ic is not None else None,
            "terzil_abstand": terzil_abstand(scores, ueber),
            "median_ueberrendite": round(median(ueber), 2) if ueber else None,
            "ic_komponenten": ic_komp,
        }


def kalenderwoche(datum: str) -> str:
    j, w, _ = dt.date.fromisoformat(datum).isocalendar()
    return f"{j}-KW{w:02d}"


def je_woche(paare: list[tuple[str, float]]) -> list[float]:
    """Mittelt Werte aus derselben Kalenderwoche zu einer Beobachtung.

    Ohne diesen Schritt zaehlen drei Laeufe an drei aufeinanderfolgenden Tagen
    als drei unabhaengige Belege, obwohl sie fast dieselbe Kohorte in fast
    demselben Markt messen. Die t-Statistik waere dann systematisch zu gross,
    also genau dort geschoent, wo es auf Strenge ankommt.
    """
    nach_woche: dict[str, list[float]] = {}
    for datum, wert in paare:
        nach_woche.setdefault(kalenderwoche(datum), []).append(wert)
    return [sum(v) / len(v) for _, v in sorted(nach_woche.items())]


def zusammenfassen(register: dict) -> None:
    summe: dict[str, dict] = {}
    for h in HORIZONTE:
        roh = [(l["datenstand"], l["auswertung"][str(h)]["ic"])
               for l in register["laeufe"]
               if l["auswertung"].get(str(h))
               and l["auswertung"][str(h)].get("ic") is not None]
        ics = je_woche(roh)
        roh_spread = [(l["datenstand"], l["auswertung"][str(h)]["terzil_abstand"])
                      for l in register["laeufe"]
                      if l["auswertung"].get(str(h))
                      and l["auswertung"][str(h)].get("terzil_abstand") is not None]
        spreads = je_woche(roh_spread)

        # Je Komponente, ebenfalls auf Wochen verdichtet.
        komp: dict[str, list[tuple[str, float]]] = {}
        for l in register["laeufe"]:
            a = l["auswertung"].get(str(h))
            if not a:
                continue
            for name, w in (a.get("ic_komponenten") or {}).items():
                if w.get("ic") is not None:
                    komp.setdefault(name, []).append((l["datenstand"], w["ic"]))

        ausgewertet = sum(1 for l in register["laeufe"] if l["auswertung"].get(str(h))
                          and l["auswertung"][str(h)].get("ic") is not None)
        summe[str(h)] = {
            "laeufe": ausgewertet,
            "wochen": len(ics),
            "ic_mittel": round(mittel(ics), 3) if ics else None,
            "ic_median": round(median(ics), 3) if ics else None,
            "t": t_wert(ics),
            "positive_wochen": sum(1 for v in ics if v > 0),
            "terzil_abstand_mittel": round(mittel(spreads), 2) if spreads else None,
            "belastbar": len(ics) >= MIN_WOCHEN,
            "wochen_fehlend": max(0, MIN_WOCHEN - len(ics)),
            "komponenten": {
                name: {"wochen": len(je_woche(v)),
                       "ic_mittel": round(mittel(je_woche(v)), 3),
                       "t": t_wert(je_woche(v))}
                for name, v in sorted(komp.items())
            },
        }
    register["zusammenfassung"] = summe


def schreibe(register: dict, meldungen: list[str]) -> None:
    register["updated_at"] = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
    register["horizonte"] = list(HORIZONTE)
    register["min_wochen"] = MIN_WOCHEN
    register["hinweise"] = meldungen[-20:]
    REGISTER_DATEI.parent.mkdir(parents=True, exist_ok=True)
    REGISTER_DATEI.write_text(
        json.dumps(register, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    log(f"geschrieben: {REGISTER_DATEI.relative_to(ROOT)}")


def main(argv: list[str]) -> int:
    register = lade_register()
    quellen = [Path(a) for a in argv if a.endswith(".json")]
    meldungen: list[str] = []
    if quellen:
        for q in sorted(quellen):
            meldungen += einfrieren(register, q)
        register["laeufe"].sort(key=lambda l: l["datenstand"])
    else:
        meldungen += einfrieren(register)
    reihen = alle_kursreihen(register)
    for lauf in register["laeufe"]:
        werte_lauf_aus(lauf, reihen)
    zusammenfassen(register)
    schreibe(register, meldungen)
    for m in meldungen:
        log("  * " + m)
    for h in HORIZONTE:
        z = register["zusammenfassung"][str(h)]
        log(f"{h} Tage: {z['laeufe']} Laeufe in {z['wochen']} Wochen, "
            f"IC-Mittel {z['ic_mittel']}, t {z['t']}, belastbar {z['belastbar']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
