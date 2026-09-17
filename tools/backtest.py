#!/usr/bin/env python3
"""Rueckrechnung der kursbasierten Merkmale ueber mehrere Jahre.

Was das hier ist, und vor allem was es nicht ist
------------------------------------------------
Das ist **nicht** die Rueckrechnung des ganzen Scores. Die braeuchte fuer jeden
Stichtag den Fundamentalstand, wie er an diesem Tag bekannt war, also eine
Rekonstruktion aus EDGAR-Einreichungsdaten ueber Jahre. Das ist ein eigenes
Vorhaben, und ein Teil davon ist grundsaetzlich nicht loesbar:
Analystenrevisionen liefert yfinance nur im heutigen Stand, ohne Historie. Wer
heutige Revisionen auf vergangene Kurse legt, misst die Zukunft und bekommt
glaenzende, wertlose Zahlen.

Was hier geht, ist die Rueckrechnung der **kursbasierten** Merkmale. Kurse sind
die einzigen Daten, die ohne Weiteres punktgenau sind: ein Schlusskurs von
gestern war gestern bekannt. Damit laesst sich beantworten, ob das
Zwoelfmonatsmomentum in genau diesem Suchraum eine Kante hat, und zwar in
Minuten statt in Quartalen.

Die drei Fallen, und wie sie hier behandelt werden
--------------------------------------------------
**Ueberlappende Fenster.** Wer woechentlich einen Stichtag setzt und
Vierwochenrenditen misst, zaehlt dieselbe Kursbewegung viermal, und der t-Wert
sieht viermal so gut aus, wie er ist. Die Stichtage liegen deshalb genau einen
Haltezeitraum auseinander.

**Ueberlebensverzerrung.** Der Suchraum kommt aus den heutigen Laeufen, also
aus Firmen, die es heute noch gibt. Das ist eine echte Verzerrung, sie laesst
sich hier nicht beseitigen. Die Richtung ist aber benennbar: Titel, die
delistet wurden, haetten fast immer schwaches Momentum UND schwache
Folgerendite gehabt. Sie fehlen also ueberwiegend dort, wo das Merkmal recht
gehabt haette. Die gemessene Kante ist damit eher eine Untergrenze als eine
Schoenung. Sicher ist das nicht, deshalb steht es als Vorbehalt in der Ausgabe.

**Zu kleine Stichprobe.** Ein IC aus fuenf Stichtagen ist Rauschen, egal wie
gross er ist. Es wird deshalb immer die Zahl der Stichtage mit ausgegeben, und
unter MIN_STICHTAGE wird das Ergebnis ausdruecklich als nicht belastbar
gekennzeichnet.

Einordnung der Groessenordnung: Ein mittlerer IC von 0,03 bis 0,05, der ueber
viele Stichtage haelt, ist in der Praxis ein nutzbarer Vorsprung. Wer 0,3
misst, hat fast immer einen Fehler im Aufbau und keinen Goldesel.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
import time
from pathlib import Path

from kurse import kursreihe, log
from register import (MIN_TITEL, kurs_am_streng, mittel, median, spearman,
                      t_wert, terzil_abstand)

ROOT = Path(__file__).resolve().parent.parent
REGISTER_DATEI = ROOT / "data" / "score_register.json"
ERGEBNIS_DATEI = ROOT / "data" / "backtest.json"

JAHRE = 5
HALTEDAUER_TAGE = 28          # Stichtagsabstand = Haltedauer, siehe Modulkopf
MIN_STICHTAGE = 24            # darunter ausdruecklich Rauschen

MOMENTUM_START_TAGE = 365
MOMENTUM_ENDE_TAGE = 30
MAX_START_ABWEICHUNG_TAGE = 21
MAX_KURSLUECKE_TAGE = 7


def heute() -> dt.date:
    return dt.date.today()


def momentum(reihe: dict[str, float], stichtag: str) -> float | None:
    """Zwoelfmonatsmomentum ohne den letzten Monat, zum Stichtag.

    Identisch zur Definition in src/sparplan/kursmerkmale.py im privaten Repo.
    Bewusst hier verdoppelt statt importiert: Die beiden Repos sind getrennt,
    und eine stille Abweichung zwischen Rueckrechnung und Livebetrieb waere
    genau der Fehler, den eine Rueckrechnung aufdecken soll. Bei einer
    Aenderung muessen beide Stellen mitgezogen werden.
    """
    d = dt.date.fromisoformat(stichtag)
    start_soll = (d - dt.timedelta(days=MOMENTUM_START_TAGE)).isoformat()
    ende_soll = (d - dt.timedelta(days=MOMENTUM_ENDE_TAGE)).isoformat()
    aelteste = min(reihe) if reihe else None
    if aelteste is None:
        return None
    try:
        reicht = (dt.date.fromisoformat(start_soll)
                  - dt.date.fromisoformat(aelteste)).days >= -MAX_START_ABWEICHUNG_TAGE
    except ValueError:
        return None
    if not reicht:
        return None
    p0 = kurs_am_streng(reihe, start_soll, MAX_START_ABWEICHUNG_TAGE)
    p1 = kurs_am_streng(reihe, ende_soll, MAX_KURSLUECKE_TAGE)
    if not p0 or not p1 or p0 <= 0:
        return None
    return (p1 / p0 - 1) * 100


def umkehr_1m(reihe: dict[str, float], stichtag: str) -> float | None:
    """Rendite des letzten Monats, als Gegenprobe.

    In der Literatur laeuft dieses Merkmal auf kurze Sicht GEGEN die
    Folgerendite, waehrend das Zwoelfmonatsmomentum dafuer laeuft. Kommen hier
    beide mit demselben Vorzeichen heraus, misst der Aufbau nicht die Merkmale,
    sondern einen Fehler in der Mechanik.
    """
    d = dt.date.fromisoformat(stichtag)
    p0 = kurs_am_streng(reihe, (d - dt.timedelta(days=MOMENTUM_ENDE_TAGE)).isoformat())
    p1 = kurs_am_streng(reihe, stichtag)
    if not p0 or not p1 or p0 <= 0:
        return None
    return (p1 / p0 - 1) * 100


MERKMALE = {"momentum_12_1": momentum, "umkehr_1m": umkehr_1m}


def universum() -> list[tuple[str, str]]:
    """Symbole und ihr Vergleichsindex aus dem Score-Register."""
    if not REGISTER_DATEI.exists():
        return []
    reg = json.loads(REGISTER_DATEI.read_text(encoding="utf-8"))
    paare: dict[str, str] = {}
    for lauf in reg.get("laeufe", []):
        for k in lauf.get("kandidaten", []):
            paare.setdefault(k["symbol"], k.get("benchmark_symbol") or "IWO")
    return sorted(paare.items())


def stichtage(bis: dt.date, jahre: int) -> list[str]:
    """Stichtage rueckwaerts im Abstand der Haltedauer.

    Der letzte liegt eine volle Haltedauer in der Vergangenheit, sonst gaebe es
    fuer ihn noch keine Folgerendite.
    """
    ende = bis - dt.timedelta(days=HALTEDAUER_TAGE)
    anfang = bis - dt.timedelta(days=365 * jahre)
    out = []
    t = ende
    while t >= anfang + dt.timedelta(days=MOMENTUM_START_TAGE):
        out.append(t.isoformat())
        t -= dt.timedelta(days=HALTEDAUER_TAGE)
    return sorted(out)


def main(argv: list[str]) -> int:
    paare = universum()
    if not paare:
        log("Kein Universum im Score-Register, nichts zu rechnen.")
        return 1
    benchmarks = sorted({b for _, b in paare})
    log(f"{len(paare)} Titel, Benchmarks {benchmarks}, {JAHRE} Jahre Historie")

    start = heute() - dt.timedelta(days=365 * JAHRE + 40)
    reihen: dict[str, dict[str, float]] = {}
    for i, sym in enumerate([s for s, _ in paare] + benchmarks, start=1):
        reihen[sym] = kursreihe(sym, start, heute())
        if i % 25 == 0:
            log(f"  {i} Symbole geholt")
        time.sleep(0.15)
    gefuellt = sum(1 for r in reihen.values() if r)
    log(f"Kursreihen: {gefuellt} von {len(reihen)} gefuellt")

    tage = stichtage(heute(), JAHRE)
    log(f"{len(tage)} Stichtage im Abstand von {HALTEDAUER_TAGE} Tagen")

    ergebnis: dict[str, dict] = {}
    for merkmal, fn in MERKMALE.items():
        je_tag = []
        for tag in tage:
            zeilen = []
            fehlend = 0
            for sym, bench in paare:
                reihe, br = reihen.get(sym) or {}, reihen.get(bench) or {}
                wert = fn(reihe, tag) if reihe else None
                if wert is None:
                    fehlend += 1
                    continue
                ende = (dt.date.fromisoformat(tag)
                        + dt.timedelta(days=HALTEDAUER_TAGE)).isoformat()
                p0 = kurs_am_streng(reihe, tag)
                p1 = kurs_am_streng(reihe, ende)
                b0 = kurs_am_streng(br, tag)
                b1 = kurs_am_streng(br, ende)
                if not p0 or not p1 or not b0 or not b1:
                    fehlend += 1
                    continue
                ueber = (p1 / p0 - 1) * 100 - (b1 / b0 - 1) * 100
                zeilen.append((wert, ueber))
            if len(zeilen) < MIN_TITEL:
                continue
            x = [z[0] for z in zeilen]
            y = [z[1] for z in zeilen]
            ic = spearman(x, y)
            if ic is None:
                continue
            je_tag.append({"stichtag": tag, "n": len(zeilen), "fehlend": fehlend,
                           "ic": round(ic, 4),
                           "terzil_abstand": terzil_abstand(x, y)})

        ics = [t["ic"] for t in je_tag]
        spreads = [t["terzil_abstand"] for t in je_tag if t["terzil_abstand"] is not None]
        ergebnis[merkmal] = {
            "stichtage": len(je_tag),
            "ic_mittel": round(mittel(ics), 4) if ics else None,
            "ic_median": round(median(ics), 4) if ics else None,
            "t": t_wert(ics),
            "positive_stichtage": sum(1 for v in ics if v > 0),
            "terzil_abstand_mittel": round(mittel(spreads), 3) if spreads else None,
            "belastbar": len(je_tag) >= MIN_STICHTAGE,
            "je_stichtag": je_tag,
        }
        z = ergebnis[merkmal]
        log(f"{merkmal}: {z['stichtage']} Stichtage, IC {z['ic_mittel']}, "
            f"t {z['t']}, Terzil-Abstand {z['terzil_abstand_mittel']} Punkte")

    m = ergebnis.get("momentum_12_1", {})
    u = ergebnis.get("umkehr_1m", {})
    gegenprobe = None
    if m.get("ic_mittel") is not None and u.get("ic_mittel") is not None:
        gegenprobe = (m["ic_mittel"] > 0 and u["ic_mittel"] < 0)

    ERGEBNIS_DATEI.write_text(json.dumps({
        "updated_at": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
        "jahre": JAHRE,
        "haltedauer_tage": HALTEDAUER_TAGE,
        "min_stichtage": MIN_STICHTAGE,
        "titel": len(paare),
        "kursreihen_gefuellt": gefuellt,
        "merkmale": ergebnis,
        "gegenprobe_bestanden": gegenprobe,
        "vorbehalt": ("Suchraum aus heutigen Laeufen, delistete Firmen fehlen. "
                      "Nur kursbasierte Merkmale, der Fundamentalteil des Scores "
                      "ist hiermit nicht geprueft."),
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    log(f"geschrieben: {ERGEBNIS_DATEI.relative_to(ROOT)}")
    log(f"Gegenprobe (Momentum positiv, Umkehr negativ) bestanden: {gegenprobe}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
