"""Selbsttest fuer tools/register.py, ohne Netz.

Geprueft werden genau die Stellen, an denen ein Fehler sich nicht von selbst
zeigen wuerde: die Rangbildung bei Bindungen, das Vorzeichen und die Groesse
der Rangkorrelation, die Benchmarkbereinigung, die Zaehlung fehlender Kurse
und die Regel, dass ein Stichtagskurs nie von einem spaeteren Handelstag
genommen wird.
"""
import datetime as dt
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import register as R  # noqa: E402

FEHLER = []


def pruefe(name, ist, soll, tol=0.001):
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


print("Raenge mit Bindungen")
pruefe_gleich("ohne Bindung", R.raenge([10, 20, 30]), [1.0, 2.0, 3.0])
pruefe_gleich("mit Bindung", R.raenge([5, 5, 9, 9]), [1.5, 1.5, 3.5, 3.5])
pruefe_gleich("alle gleich", R.raenge([7, 7, 7]), [2.0, 2.0, 2.0])

print("Rangkorrelation")
auf = list(range(1, 11))
ab = list(range(10, 0, -1))
pruefe("perfekt gleichlaeufig", R.spearman(auf, auf), 1.0)
pruefe("perfekt gegenlaeufig", R.spearman(auf, ab), -1.0)
pruefe("alles gleich ergibt None", R.spearman(auf, [3.0] * 10), None)
pruefe("zu wenige Titel ergibt None", R.spearman([1, 2, 3], [1, 2, 3]), None)
# Monotone, aber nicht lineare Beziehung: Spearman muss 1 liefern, Pearson nicht.
quadrat = [x * x for x in auf]
pruefe("monoton nichtlinear", R.spearman(auf, quadrat), 1.0)

print("Terzil-Abstand")
# Neun Titel, Rendite steigt mit dem Schluessel: bestes Drittel 7,8,9,
# schlechtestes 1,2,3. Abstand der Mittelwerte: 8 minus 2 gleich 6.
pruefe("sauber sortiert", R.terzil_abstand(list(range(1, 10)), list(range(1, 10))), 6.0)
pruefe("zu wenige Titel", R.terzil_abstand([1, 2, 3], [1, 2, 3]), None)

print("t-Wert")
pruefe("konstante Reihe ergibt None", R.t_wert([0.1] * 5), None)
t = R.t_wert([0.1, 0.2, 0.15, 0.05, 0.1])
print(("  ok   " if t and t > 2 else "  FEHL ") + f"klar positive Reihe: t={t}")
if not (t and t > 2):
    FEHLER.append("t-Wert")

print("Auswertung eines Laufs")
R.heute = lambda: dt.date(2026, 10, 20)

# Zwoelf Titel. Der Score ist absichtlich genau umgekehrt zur spaeteren
# Rendite gebaut: die Auswertung muss einen stark negativen IC liefern.
# Ein Register, das hier null oder positiv meldet, rechnet falsch herum.
kandidaten = []
reihen = {"IWO": {"2026-09-01": 100.0, "2026-10-01": 110.0}}
for i in range(12):
    sym = f"T{i:02d}"
    kandidaten.append({
        "symbol": sym, "korb": "klein", "benchmark_symbol": "IWO",
        "score": float(i), "coverage": 100.0, "reliable": True,
        "preis_lauf": 100.0,
        "komponenten": {"momentum_12_1": float(i), "dilution": 50.0},
    })
    # Rendite faellt mit steigendem Score
    reihen[sym] = {"2026-09-01": 100.0, "2026-10-01": 100.0 + (11 - i)}

lauf = {"datenstand": "2026-09-01", "kandidaten": kandidaten, "auswertung": {}}
R.werte_lauf_aus(lauf, reihen)
a30 = lauf["auswertung"]["30"]
pruefe_gleich("Stichtag", a30["stichtag"], "2026-10-01")
pruefe_gleich("alle Titel bewertet", a30["n"], 12)
pruefe_gleich("keiner fehlt", a30["fehlend"], 0)
pruefe("IC stark negativ", a30["ic"], -1.0)
# Bereinigt: Titel 0 macht +11 %, Benchmark +10 %, also +1 Punkt.
pruefe("Benchmarkbereinigung", None if a30["median_ueberrendite"] is None
       else round(a30["median_ueberrendite"], 1), -4.5, tol=0.2)
pruefe_gleich("Komponente mit Streuung ausgewertet",
              "momentum_12_1" in a30["ic_komponenten"], True)
pruefe("Komponente ohne Streuung ergibt None",
       a30["ic_komponenten"]["dilution"]["ic"], None)
pruefe_gleich("90 Tage noch nicht faellig", lauf["auswertung"]["90"], None)

print("Fehlende Kurse werden gezaehlt, nicht verschwiegen")
reihen2 = dict(reihen)
for i in range(4):
    reihen2[f"T{i:02d}"] = {"2026-09-01": 100.0}  # delistet, kein Stichtagskurs
lauf2 = {"datenstand": "2026-09-01", "kandidaten": kandidaten, "auswertung": {}}
R.werte_lauf_aus(lauf2, reihen2)
pruefe_gleich("vier fehlen", lauf2["auswertung"]["30"]["fehlend"], 4)
pruefe_gleich("acht bewertet", lauf2["auswertung"]["30"]["n"], 8)

print("Kein Nachruecken auf einen spaeteren Handelstag")
reihe = {"2026-09-25": 100.0, "2026-10-05": 200.0}
pruefe("Stichtag ohne Handel nimmt den Tag davor", R.kurs_am(reihe, "2026-10-01"), 100.0)
pruefe("vor jedem Datum ergibt None", R.kurs_am(reihe, "2026-09-01"), None)
# Sechs Tage Abstand sind eine Feiertagspause, dreissig sind ein Delisting.
pruefe("kleine Luecke erlaubt", R.kurs_am_streng(reihe, "2026-10-01"), 100.0)
pruefe("grosse Luecke ergibt None", R.kurs_am_streng(reihe, "2026-10-25"), None)

print("Zusammenfassung")
reg = {"laeufe": [lauf], "zusammenfassung": {}}
R.zusammenfassen(reg)
z = reg["zusammenfassung"]["30"]
pruefe_gleich("ein Lauf gezaehlt", z["laeufe"], 1)
pruefe_gleich("eine Woche gezaehlt", z["wochen"], 1)
pruefe_gleich("noch nicht belastbar", z["belastbar"], False)
pruefe_gleich("elf Wochen fehlen", z["wochen_fehlend"], 11)

print("Laeufe derselben Woche zaehlen nur einmal")
# Drei aufeinanderfolgende Tage sind eine Kalenderwoche, keine drei
# Beobachtungen. Genau dieser Fehler hat das alte Register schon einmal
# schmeicheln lassen.
pruefe_gleich("KW-Schluessel", R.kalenderwoche("2026-08-21"), R.kalenderwoche("2026-08-23"))
pruefe_gleich("andere Woche", R.kalenderwoche("2026-08-29") != R.kalenderwoche("2026-08-21"), True)
verdichtet = R.je_woche([("2026-08-21", 0.2), ("2026-08-22", 0.4),
                         ("2026-08-23", 0.6), ("2026-08-29", 0.1)])
pruefe_gleich("aus vier Laeufen werden zwei Wochen", len(verdichtet), 2)
pruefe("erste Woche gemittelt", verdichtet[0], 0.4)
pruefe("zweite Woche unveraendert", verdichtet[1], 0.1)

print()
if FEHLER:
    print("FEHLGESCHLAGEN: " + ", ".join(FEHLER))
    raise SystemExit(1)
print("alle Pruefungen bestanden")
