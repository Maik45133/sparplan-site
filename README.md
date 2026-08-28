# Sparplan OS, Seite

Die veröffentlichte Ansicht auf das Research-System. Der Quellcode des Datenlaufs liegt
getrennt im privaten Repo `sparplan`. Dieses Repo hier ist bewusst öffentlich, weil GitHub
Pages auf dem kostenlosen Plan nur öffentliche Repos bedient. Es enthält deshalb **keinen**
Klartext-Bestand.

## Was hier liegt

    index.html              Hülle, Navigation, fünf Ansichten
    assets/app.js           Rendert alles aus data/latest.json zur Laufzeit
    assets/style.css        Oberfläche
    assets/holo-core.js     Hologramm-Renderer
    data/latest.json        Ergebnis des letzten Laufs, öffentlich unkritisch
    data/depot.enc          Bestand, AES-256-GCM, ohne Passwort wertlos
    tools/encrypt_depot.py  Erzeugt depot.enc aus einer lokalen depot.json
    sw.js                   Service Worker: Hülle offline, Daten immer frisch

Es gibt keinen Build-Schritt. Was im Repo liegt, ist was der Browser lädt.

## Ansichten

| Bereich | Inhalt |
|---|---|
| Markt | Kennzahlen des Laufs, stärkste Signale über alle drei Körbe gemischt, Track Record, Quellenstatus |
| Screening | Ein Korb nach Wahl, alle Kandidaten mit Einordnung, ausgeschiedene Werte nach Grund |
| Historie | Überrendite gegen den Vergleichsindex, eingefrorene Positionen |
| Makro | Rechtsakte aus dem Federal Register, Meldungen von Fed, EZB und BLS, Termine |
| Depot | Verschlossen bis zur Passworteingabe |

Die Einordnung eines Kandidaten wird ausschließlich aus dem Score abgeleitet, es steckt
keine Meinung darin:

    Datenabdeckung unter 100 %   Datenlücken
    Score ab 65                  Kaufkandidat
    Score ab 55                  Beobachten
    darunter                     Nachrangig

## Aktualisieren

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
stattgefunden hat.
