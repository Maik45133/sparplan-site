#!/usr/bin/env python3
"""Kurs- und Wechselkursabruf, geteilt von virtuell.py und register.py.

Zwei Quellen hintereinander, weil eine einzelne Gratisquelle fuer einen
automatischen Lauf zu duenn ist: Yahoo ueber yfinance zuerst, Stooq als
Rueckfall. Beide liefern dasselbe Format zurueck (Datum -> Schlusskurs), der
aufrufende Code merkt nicht, welche geantwortet hat.

Laeuft ausschliesslich in GitHub Actions. Weder Maiks Mac-Sandbox noch die
Cowork-Cloud erreichen eine Kursquelle, beide laufen in einen 403 des
jeweiligen Proxys.
"""
from __future__ import annotations

import datetime as dt
import json
import urllib.error
import urllib.parse
import urllib.request

UA = {"User-Agent": "sparplan-site/1.0 (Research; github.com/Maik45133/sparplan-site)"}


def log(*teile) -> None:
    print(*teile, flush=True)


# ── Aktien und Indizes ───────────────────────────────────────────────────


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
    except Exception as e:  # noqa: BLE001 - jede Ausnahme heisst hier nur "keine Daten"
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


# Stooq kennt die Yahoo-Schreibweise nicht. Aktien brauchen das Suffix .us,
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
    """Schlusskurse als Datum -> Kurs. Leeres Dict heisst: keine Daten.

    Der Cache ist bewusst grob auf (Symbol, Start, Ende) geschluesselt: In
    einem Lauf werden dieselben Benchmarks dutzendfach gebraucht, und jede
    ersparte Abfrage senkt das Risiko, in eine Ratenbegrenzung zu laufen.
    """
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

    Ein Stichtag am Wochenende oder Feiertag hat keinen eigenen Kurs. Den
    naechsten Handelstag DANACH zu nehmen waere Rueckschau: der Kurs waere zum
    Zeitpunkt der Entscheidung noch nicht bekannt gewesen. Diese eine Zeile
    ist der Unterschied zwischen einer Messung und einer Schmeichelei.
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
# Euro je Dollar, von der EZB ueber api.frankfurter.dev.

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
