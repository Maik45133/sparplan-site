# Sparplan OS, Seite

Die veröffentlichte Ansicht auf das Research-System. Der Datenlauf liegt getrennt im
privaten Repo `sparplan`. Dieses Repo ist öffentlich, weil GitHub Pages auf dem
kostenlosen Plan nur öffentliche Repos bedient, und enthält deshalb **keinen**
Klartext-Bestand.

    https://maik45133.github.io/sparplan-site/

## Die eine Frage, um die es geht

Welche Aktien lohnen sich. Alles hier ist entweder Teil der Antwort oder Beiwerk.
Die Reihenfolge der Ansichten spiegelt das:

| Reiter | Beantwortet |
|---|---|
| Kandidaten | Was steht gerade oben, und was wäre der eine Titel? |
| Virtuell | Was hätte ich verdient, nach Kosten? |
| Verlauf | **Taugt die Rangfolge überhaupt?** |
| Depot | Was liegt wirklich im Depot? |

Der Reiter Verlauf ist der wichtigste. Ein Depot aus wenigen Positionen braucht Jahre,
bis sich Können von Zufall trennen lässt. Die Messung über alle Kandidaten braucht
Wochen.

## Was hier liegt

    index.html                      Hülle, Navigation, vier Ansichten
    assets/app.js                   Rendert alles aus den JSON-Dateien zur Laufzeit
    assets/style.css                Oberfläche
    assets/holo-core.js             Hologramm-Renderer
    assets/szene.js                 Scroll-gesteuerte Kurs-Sequenz
    data/latest.json                Ergebnis des letzten Datenlaufs
    data/score_register.json        Alle Kandidaten je Lauf, eingefroren, plus IC
    data/backtest.json              Rückrechnung der kursbasierten Merkmale
    data/virtual_portfolio.json     Virtuelles Depot
    data/track_record.json          Eingefrorene Spitzenplätze aus dem Datenlauf
    data/depot.enc                  Echter Bestand, AES-256-GCM, ohne Passwort wertlos
    tools/kurse.py                  Kurs- und Wechselkursabruf, geteilt
    tools/register.py               Score-Register und Information Coefficient
    tools/backtest.py               Rückrechnung der kursbasierten Merkmale
    tools/virtuell.py               Virtuelles Depot
    tools/encrypt_depot.py          Erzeugt depot.enc aus einer lokalen depot.json
    tools/tests/                    Selbsttests, ohne Netz lauffähig
    .github/workflows/              Wochenlauf und Backtest

Es gibt keinen Build-Schritt. Was im Repo liegt, ist was der Browser lädt.
Gerechnet wird ausschließlich in Python, die Seite zeigt nur an: dieselbe Zahl soll
nicht an zwei Stellen in zwei Sprachen entstehen und auseinanderlaufen.

## Das Score-Register, der Kern der Messung

Bei jedem Datenlauf wird **jeder** bewertete Kandidat mit Score, Komponenten und Kurs
eingefroren, nicht nur die Spitze. 30, 60 und 90 Kalendertage später wird gerechnet:

- die **Rangkorrelation nach Spearman** zwischen Score und benchmarkbereinigter
  Folgerendite, also der Information Coefficient;
- dieselbe Rechnung **je Komponente einzeln**. Erst das beantwortet die Frage, welche
  Komponente etwas vorhersagt und welche nur Gewicht verbraucht. Ohne diese Zahl bleibt
  jede Änderung an den Gewichten geraten;
- der **Terzil-Abstand**: mittlere Überrendite des besten Drittels minus die des
  schlechtesten. Weniger elegant als der IC, dafür sofort verständlich.

Vier Dinge, die bewusst streng gehalten sind:

**Benchmarkbereinigt.** Die Körbe haben verschiedene Marktexposition. Ungefiltert in
einen Topf geworfen misst man zum Teil, welcher Korb gerade läuft, und nennt es
Auswahlqualität.

**Kalenderwochen, nicht Läufe.** Drei Läufe an drei aufeinanderfolgenden Tagen messen
fast dieselbe Kohorte im fast selben Markt. Sie werden zu einer Beobachtung gemittelt,
sonst wäre die t-Statistik systematisch zu groß.

**Kein Nachrücken beim Stichtag.** Ein Kurs wird am Stichtag oder am letzten Handelstag
davor genommen, nie danach.

**Delistete Titel fallen auf, statt still zu wirken.** Eine Kursreihe endet beim
Delisting und behält ihren letzten Kurs für immer. Wer den als Stichtagskurs nimmt,
rechnet eine saubere Nullrendite statt des Totalverlusts. Ein Kurs, der mehr als sieben
Tage vor dem Stichtag liegt, gilt deshalb als nicht vorhanden, und die Zahl der so
ausgefallenen Titel steht in jeder Auswertung.

Einordnung: Ein mittlerer IC von 0,03 bis 0,05, der über viele Wochen hält, ist in der
Praxis ein nutzbarer Vorsprung. Wer 0,3 misst, hat fast immer einen Fehler im Aufbau.

## Die Rückrechnung

`tools/backtest.py`, nur auf Knopfdruck. Rechnet die **kursbasierten** Merkmale über
fünf Jahre zurück, mit überlappungsfreien Stichtagen im Abstand der Haltedauer.

Das ist ausdrücklich **nicht** die Rückrechnung des ganzen Scores. Die bräuchte für
jeden Stichtag den Fundamentalstand, wie er an dem Tag bekannt war, und ein Teil davon
ist grundsätzlich nicht rekonstruierbar: Analystenrevisionen liefert yfinance nur im
heutigen Stand. Wer heutige Revisionen auf vergangene Kurse legt, misst die Zukunft.

Eingebaute Gegenprobe: Die Kurzfrist-Umkehr über einen Monat muss in der Literatur das
umgekehrte Vorzeichen haben wie das Zwölfmonatsmomentum. Kommen beide mit demselben
Vorzeichen heraus, misst der Aufbau einen Fehler in der Mechanik und nicht die Merkmale.

## Das virtuelle Depot

Papierhandel, um zu messen statt zu glauben. Jede Position bekommt **1.000 Euro**,
gleichgewichtet. Zwei Quellen laufen getrennt ausgewiesen:

- **Datenauswahl** (`quelle: "score"`): der beste Titel je Korb aus `data/latest.json`,
  sofern `reliable` und **unter 20 Mrd Marktkapitalisierung**. Bei Standardwerten
  darüber hat ein wöchentliches Skript keine Aussicht auf einen Vorsprung, und das
  echte Depot besteht durch die ETF hindurch bereits zu rund 45 Prozent aus zwei Titeln
  dieses Segments. Liegt der Beste eines Korbs über der Grenze, bleibt der Platz leer;
  der Zweitbeste ist nicht die Auswahl, die das Verfahren getroffen hat.
- **Trump-Komponente** (`quelle: "trump"`): Titel, zu denen öffentlich geraten wurde.

**Kosten sind eingerechnet**, und zwar auf die Ordergröße, die wirklich gehandelt werden
soll (100 Euro), nicht auf die 1.000 Euro der virtuellen Position. Bei einer festen
Ordergebühr ist das der Unterschied zwischen 1,0 und 0,1 Prozent, also zwischen "Kosten
entscheiden" und "Kosten sind eine Fußnote". Die Annahmen stehen oben in
`tools/virtuell.py` und gehören gegen die echten Konditionen getauscht.

**Positionen schließen sich selbst**, wenn der Kurs mehr als das 2,5-fache der mittleren
Tagesschwankung unter den höchsten Stand seit Einstand fällt. Geprüft wird tagesgenau
über die ganze Kursreihe, nicht nur zum Laufzeitpunkt: ein Stop, der nur sonntags
greift, ist kein Stop, sondern eine Wochenendmeinung.

### Einen Titel aufnehmen

Über ein GitHub-Issue, vom Handy aus rund zehn Sekunden:

| Was | Label |
|---|---|
| Trump hat zu einem Titel geraten | `trump` |
| Eigener Titel ohne Screening | `kauf` |
| Position schließen | `verkauf` |

Ticker in den Titel, alles danach wird ignoriert. Ohne Angabe ist der Einstand der
Schlusskurs des Tages, an dem das Issue entsteht; mit einer Zeile `Datum: 2026-09-11`
im Text der Schlusskurs dieses Tages, höchstens 30 Tage zurück und nie in der Zukunft.

**Jeden Fall eintragen, auch die langweiligen.** Wer nur die auffällig gestiegenen
einträgt, bekommt am Ende zuverlässig ein gutes Ergebnis, ganz unabhängig davon, ob
eines existiert.

## Die Läufe

| Workflow | Wann | Was |
|---|---|---|
| Wochenlauf | sonntags 17:30 UTC, plus Knopf | Register einfrieren und auswerten, Depot bewerten, Issues einlesen |
| Backtest | nur auf Knopfdruck | Rückrechnung der kursbasierten Merkmale |

Beides läuft auf GitHub, weil weder Maiks Mac-Sandbox noch die Cowork-Cloud eine
Kursquelle erreichen. Öffentliche Repos haben unbegrenzte Actions-Minuten, und in der
Kette steckt kein Sprachmodell: die Läufe kosten weder Geld noch Claude-Credits.

Kursquellen: yfinance zuerst, Stooq als Rückfall, EZB über frankfurter.dev für den
Wechselkurs. **Schlägt ein Abruf fehl, bleiben die Werte des letzten Laufs stehen** und
die Position wird als `veraltet` markiert.

Zwei Dinge im Auge behalten: GitHub schaltet geplante Läufe ab, wenn ein Repo 60 Tage
keine Aktivität hat. Und der Lauf liest `data/latest.json` so, wie es im Repo liegt;
ohne neuen Datenlauf bleibt die Auswahl auf dem alten Stand, sichtbar am Feld
`datenstand`.

Selbsttests, ohne Netz:

    python3 tools/tests/test_virtuell.py
    python3 tools/tests/test_register.py

## Depot verschlüsseln

Einmalig, und immer wenn sich der Bestand ändert:

    cp ../sparplan/data/depot.json data/depot.json    # bleibt lokal, .gitignore
    python3 tools/encrypt_depot.py
    git add data/depot.enc && git commit -m "Depot" && git push

Das Passwort steht nirgends im Repo. Verloren heißt neu verschlüsseln.

## Grenzen, offen benannt

- Der **Fundamentalteil des Scores ist unvalidiert**. Das Register beantwortet das
  vorwärts, die Rückrechnung deckt nur den Kursteil ab.
- Der Suchraum der Rückrechnung stammt aus heutigen Läufen, **delistete Firmen fehlen**.
- Steuern sind nirgends abgebildet.
- Bei wenigen Positionen über wenige Wochen ist jede Kennzahl im virtuellen Depot
  Rauschen. Die Seite sagt das selbst.

## Truth Social

Es gibt keinen zulässigen automatischen Weg, Trumps Posts auszulesen. Die
Nutzungsbedingungen verbieten systematisches Scraping, die lizenzierte Truth API
richtet sich an Handelshäuser, und das größte offene Archiv hat seinen Scraper 2025
selbst abgeschaltet. Deshalb der Handgriff über das Issue: das Erkennen bleibt beim
Menschen, das Messen macht die Maschine.
