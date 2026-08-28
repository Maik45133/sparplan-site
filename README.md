# Sparplan OS, Seite

Die veroeffentlichte Ansicht auf das Research-System. Der Quellcode des Datenlaufs liegt
getrennt im privaten Repo `sparplan`. Dieses Repo hier ist bewusst oeffentlich, weil GitHub
Pages auf dem Free-Plan nur oeffentliche Repos bedient. Es enthaelt deshalb **keinen**
Klartext-Bestand.

## Was hier liegt

    index.html              Huelle, Navigation, fuenf Ansichten
    assets/app.js           Rendert alles aus data/latest.json zur Laufzeit
    assets/style.css        HUD
    assets/holo-core.js     Hologramm-Renderer
    data/latest.json        Ergebnis des letzten Laufs, oeffentlich unkritisch
    data/depot.enc          Bestand, AES-256-GCM, ohne Passwort wertlos
    tools/encrypt_depot.py  Erzeugt depot.enc aus einer lokalen depot.json
    sw.js                   Service Worker: Huelle offline, Daten immer frisch

Es gibt keinen Build-Schritt. Was im Repo liegt, ist was der Browser laedt.

## Aktualisieren

Der Lauf enthaelt keinen KI-Aufruf, er ist Python mit yfinance, SEC EDGAR, Federal Register
und den RSS-Feeds von Fed, EZB und BLS. Er kostet keine Claude-Credits.

    # im sparplan-Repo
    ./scroll.command                       # oder: uv run python -m sparplan 45
    cp data/latest.json           ../sparplan-site/data/
    cp data/journal/track_record.json ../sparplan-site/data/
    cd ../sparplan-site && git add -A && git commit -m "Lauf DD.MM." && git push

Nach dem Push baut Pages in etwa einer Minute. Bei sichtbaren Aenderungen an
`index.html`, `app.js` oder `style.css` in `sw.js` die Zeile `const V` hochzaehlen,
sonst haelt der Service Worker die alte Huelle fest.

## Depot verschluesseln

Einmalig, und immer wenn sich der Bestand aendert:

    cp ../sparplan/data/depot.json data/depot.json    # bleibt lokal, .gitignore
    python3 tools/encrypt_depot.py
    git add data/depot.enc && git commit -m "Depot" && git push

Das Passwort steht nirgends im Repo und ist niemandem sonst bekannt. Verloren heisst
neu verschluesseln, nicht wiederherstellen.

## Grenzen, die bleiben

Eine statische Seite hat keinen Serverteil. Sie kann Yahoo und die SEC nicht selbst
befragen und nichts speichern. Jede Zahl hier stammt aus einem Lauf, der woanders
stattgefunden hat. Das ist kein Mangel dieser Loesung, sondern der Grund, warum der
Lauf ueberhaupt getrennt existiert.
