# Sparplan OS, Seite

Die veröffentlichte Ansicht auf das Research-System. Der Quellcode des Datenlaufs liegt
getrennt im privaten Repo `sparplan`. Dieses Repo hier ist bewusst öffentlich, weil GitHub
Pages auf dem kostenlosen Plan nur öffentliche Repos bedient. Es enthält deshalb **keinen**
Klartext-Bestand.

## Was hier liegt

    index.html                      Hülle, Navigation, vier Ansichten
    assets/app.js                   Rendert alles aus den JSON-Dateien zur Laufzeit
    assets/style.css                Oberfläche
    assets/holo-core.js             Hologramm-Renderer
    assets/szene.js                 Scroll-gesteuerte Kurs-Sequenz
    data/latest.json                Ergebnis des letzten Datenlaufs
    data/track_record.json          Eingefrorene Wochenpicks mit Einstandskurs
    data/virtual_portfolio.json     Virtuelles Depot, wird von GitHub Actions geschrieben
    data/depot.enc                  Echter Bestand, AES-256-GCM, ohne Passwort wertlos
    tools/encrypt_depot.py          Erzeugt depot.enc aus einer lokalen depot.json
    tools/virtuell.py               Motor des virtuellen Depots
    tools/tests/test_virtuell.py    Selbsttest dazu, ohne Netz
    .github/workflows/              Wöchentlicher Lauf des virtuellen Depots
    sw.js                           Service Worker: Hülle offline, Daten immer frisch

Es gibt keinen Build-Schritt. Was im Repo liegt, ist was der Browser lädt.

## Ansichten

| Reiter | Inhalt |
|---|---|
| Kandidaten | Kennzahlen des Laufs, Vorschlag des Laufs, drei Körbe mit Score-Ranking, Marktumfeld |
| Virtuell | Virtuelles Depot: Datenauswahl und Trump-Komponente getrennt ausgewiesen |
| Verlauf | Überrendite gegen den Vergleichsindex, eingefrorene Positionen |
| Depot | Echter Bestand, verschlossen bis zur Passworteingabe |

Die Einordnung eines Kandidaten wird ausschließlich aus dem Score abgeleitet, es steckt
keine Meinung darin:

    Datenabdeckung unter 100 %   Datenlücken
    Score ab 65                  Kaufkandidat
    Score ab 55                  Beobachten
    darunter                     Nachrangig

## Das virtuelle Depot

Papierhandel, um zu messen statt zu glauben. Jede Position bekommt **1.000 Euro**,
gleichgewichtet, damit die Gesamtrendite der Durchschnitt der Auswahl ist und nicht das
Ergebnis zufälliger Stückzahlen. Zwei Quellen laufen getrennt:

- **Datenauswahl** (`quelle: "score"`): der beste Titel je Korb aus `data/latest.json`,
  ausgeschlossen wird nur, was `reliable === false` ist. Liegt der Beste schon im Depot,
  rückt keiner nach. Das Depot wächst also nur, wenn sich die Rangfolge ändert.
- **Trump-Komponente** (`quelle: "trump"`): Titel, zu denen öffentlich geraten wurde.
  Es gibt dafür keinen legalen automatischen Feed, siehe unten.

Gerechnet wird in `tools/virtuell.py`, nicht im Browser. Die Seite zeigt nur an, was in
der Datei steht, damit dieselbe Zahl nicht an zwei Stellen in zwei Sprachen entsteht.
Die Überrendite wird **in Dollar** gegen den Vergleichsindex gerechnet (IWO für die
kleineren Körbe, S&P 500 für große Werte und Trump-Titel), der Währungseffekt steht
getrennt daneben.

### Einen Titel aufnehmen

Über ein GitHub-Issue, vom Handy aus rund zehn Sekunden:

| Was | Label | Vorlage |
|---|---|---|
| Trump hat zu einem Titel geraten | `trump` | `.github/ISSUE_TEMPLATE/trump.yml` |
| Eigener Titel ohne Screening | `kauf` | `.github/ISSUE_TEMPLATE/kauf.yml` |
| Position schließen | `verkauf` | `.github/ISSUE_TEMPLATE/verkauf.yml` |

Ticker in den Titel des Issues, alles danach wird ignoriert. **Einstand ist der
Schlusskurs des Tages, an dem das Issue entsteht**, nicht der des Laufs. Der Lauf
sammelt sonntags ein, holt den Kurs nach und schließt das Issue mit einer Bestätigung.

### Der Lauf

`.github/workflows/virtuelles-depot.yml`, sonntags 17:30 UTC, dazu ein Knopf
(`workflow_dispatch`) für sofort. Er läuft auf GitHub, weil weder Maiks Mac-Sandbox noch
die Cowork-Cloud eine Kursquelle erreichen. Öffentliche Repos haben unbegrenzte
Actions-Minuten, und in der Kette steckt kein Sprachmodell: der Lauf kostet weder Geld
noch Claude-Credits.

Kursquellen: yfinance zuerst, Stooq als Rückfall, EZB über frankfurter.dev für den
Wechselkurs. **Schlägt ein Abruf fehl, bleiben die Werte des letzten Laufs stehen** und
die Position wird als `veraltet` markiert. Ein Depot, das bei einer Netzstörung stumm auf
null springt, wäre schlimmer als eines, das offen sagt, dass es alt ist.

Zwei Dinge im Auge behalten:

- GitHub schaltet geplante Läufe ab, wenn ein Repo 60 Tage lang keine Aktivität hat.
- Der Lauf liest `data/latest.json` so, wie es im Repo liegt. Ohne neuen Datenlauf
  bleibt die Auswahl auf dem alten Stand, sichtbar am Feld `datenstand`.

Selbsttest ohne Netz:

    python3 tools/tests/test_virtuell.py

## Aktualisieren des Datenlaufs

Der Lauf enthält keinen KI-Aufruf, er ist Python mit yfinance, SEC EDGAR, Federal Register
und den RSS-Feeds von Fed, EZB und BLS. Er kostet keine Claude-Credits.

    # im sparplan-Repo
    ./scroll.command                                   # oder: uv run python -m sparplan 45
    cp data/latest.json               ../sparplan-site/data/
    cp data/journal/track_record.json ../sparplan-site/data/
    cd ../sparplan-site && git add -A && git commit -m "Lauf" && git push

Nach dem Push baut Pages in etwa einer Minute. Bei Änderungen an `index.html`, `app.js`
oder `style.css` in `sw.js` die Zeile `const V` hochzählen, sonst hält der Service Worker
die alte Hülle fest.

## Depot verschlüsseln

Einmalig, und immer wenn sich der Bestand ändert:

    cp ../sparplan/data/depot.json data/depot.json    # bleibt lokal, .gitignore
    python3 tools/encrypt_depot.py
    git add data/depot.enc && git commit -m "Depot" && git push

Das Passwort steht nirgends im Repo. Verloren heißt neu verschlüsseln, nicht wiederherstellen.

## Grenzen

Eine statische Seite hat keinen Serverteil. Sie kann Yahoo und die SEC nicht selbst
befragen und nichts speichern. Jede Zahl hier stammt aus einem Lauf, der woanders
stattgefunden hat, entweder auf dem Mac oder in GitHub Actions.

Im virtuellen Depot fehlen Gebühren, Spread und Steuern. Die Zahlen sind deshalb
freundlicher als ein echtes Depot, und bei wenigen Positionen über wenige Wochen sind
sie ohnehin Rauschen.

## Truth Social

Es gibt keinen zulässigen automatischen Weg, Trumps Posts auszulesen. Die
Nutzungsbedingungen verbieten systematisches Scraping, die im August 2026 gestartete
lizenzierte Truth API richtet sich an Handelshäuser und hat keine öffentliche Preisliste,
und das größte offene Archiv hat seinen Scraper 2025 selbst abgeschaltet. Deshalb der
Handgriff über das Issue: das Erkennen bleibt beim Menschen, das Messen macht die Maschine.
