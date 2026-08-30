/* Sparplan OS. Liest data/latest.json zur Laufzeit und baut daraus alle Ansichten.
   Kein Build, kein Framework, keine externe Abhängigkeit außer holo-core.js.
   Wechselkurse stammen aus dem Datenlauf selbst (fx_at_entry/fx_now je Position,
   fx_eur_je_usd fürs Ganze) und werden nur für ältere Einträge ohne diese Felder
   live von der EZB über api.frankfurter.dev nachgeladen.

   Stand 30.08.2026: von fünf auf drei Ansichten reduziert (Kandidaten, Verlauf,
   Depot), weil "Markt" und "Screening" denselben Inhalt zweimal zeigten und
   "Makro" ein Nebenschauplatz war. Rechtsakte, Notenbanken und Termine stehen
   jetzt als "Marktumfeld" am Fuß der Kandidatenansicht statt in einem eigenen
   Tab: unterstützender Kontext, keine eigene Bestimmung. */
(() => {
'use strict';

const CFG = {
  repo:'Maik45133/sparplan-site',
  data:'data/latest.json',
  depot:'data/depot.enc',
  fx:'https://api.frankfurter.dev/v1'
};

/* ───────── Werkzeug ───────── */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const nf = (v, d = 1) => v === null || v === undefined || Number.isNaN(v)
  ? '–' : Number(v).toLocaleString('de-DE', {minimumFractionDigits:d, maximumFractionDigits:d});
const pct  = (v, d = 1) => v === null || v === undefined ? '–' : (v > 0 ? '+' : '') + nf(v, d) + ' %';
const eur  = (v, d = 2) => v === null || v === undefined ? '–' : nf(v, d) + ' €';
const sign = v => v > 0.0001 ? 'up' : v < -0.0001 ? 'down' : '';

function mrd(v){
  if (v == null) return '–';
  if (v >= 1e12) return nf(v / 1e12, 2) + ' Bio';
  if (v >= 1e9)  return nf(v / 1e9, 1) + ' Mrd';
  if (v >= 1e6)  return nf(v / 1e6, 0) + ' Mio';
  return nf(v, 0);
}
function datum(s){
  if (!s) return '–';
  const d = new Date(s);
  if (Number.isNaN(+d)) return String(s).slice(0, 10);
  return d.toLocaleDateString('de-DE', {day:'2-digit', month:'2-digit', year:'numeric'});
}
const iso = s => String(s || '').slice(0, 10);
const alterTage = s => Math.floor((Date.now() - new Date(s)) / 864e5);

const KOMPONENTE = {
  revision_momentum:'Analystenrevisionen', growth_acceleration:'Wachstumsbeschleunigung',
  margin_trend:'Margentrend', fcf_trend:'Cashflow-Trend',
  insider_cluster:'Insiderkäufe', dilution:'Verwässerung'
};
const KURZ = {
  revision_momentum:'Revisionen', growth_acceleration:'Beschleunigung',
  margin_trend:'Margen', fcf_trend:'Cashflow',
  insider_cluster:'Insider', dilution:'kaum Verwässerung'
};
const GRUND = {
  mining_explorer:'Explorer ohne Produktion', no_revenue:'kein Umsatz', too_small:'zu klein',
  too_large:'zu groß', low_growth:'Wachstum zu schwach', low_margin:'Marge zu dünn',
  negative_fcf:'Cashflow negativ', illiquid:'zu wenig Handel', no_data:'keine Daten',
  market_cap_out_of_range:'Marktkapitalisierung passt nicht', crypto_treasury:'Krypto-Bestand statt Geschäft',
  mortgage_reit:'Hypotheken-REIT', mining_explorer_alt:'Rohstoff-Explorer',
  sector_not_allowed:'Sektor ausgeschlossen', growth_below_threshold:'Wachstum unter Schwelle'
};
const FELD = {
  handel_zoelle:'Handel und Zölle', geldpolitik:'Geldpolitik', energie:'Energie',
  finanzen_krypto:'Finanzen und Krypto', gesundheit:'Gesundheit', verteidigung:'Verteidigung',
  technologie:'Technologie', umwelt:'Umwelt', arbeitsmarkt:'Arbeitsmarkt',
  arbeitsmarkt_migration:'Arbeitsmarkt und Migration', infrastruktur:'Infrastruktur',
  bildung:'Bildung', landwirtschaft:'Landwirtschaft'
};
const QUELLE = {fed:'Fed', ecb:'EZB', bls_latest:'BLS', bls:'BLS'};
const label = (map, k) => map[k] || String(k).replace(/_/g, ' ');

/* ───────── Zustand ───────── */
let D = null, FX = null, policyField = '*', histRaster = 'woche';
const gezeigt = {klein:5, gross:5, frueh:5};

const KOERBE = {
  klein: {kurz:'K', chip:'1–20 Mrd', titel:'Wachstum', unter:'1 bis 20 Mrd',
          lang:'Wachstum, 1 bis 20 Mrd',
          d:'dossiers', r:'rejected', s:'screened', cls:''},
  gross: {kurz:'G', chip:'ab 20 Mrd', titel:'Große Werte', unter:'ab 20 Mrd',
          lang:'Große Werte, ab 20 Mrd',
          d:'dossiers_large_cap', r:'rejected_large_cap', s:'screened_large_cap', cls:'g'},
  frueh: {kurz:'F', chip:'13F', titel:'Frühphase', unter:'aus 13F-Meldungen',
          lang:'Frühphase aus 13F-Meldungen',
          d:'dossiers_early_bets', r:'rejected_early_bets', s:'screened_early_bets', cls:'f'}
};
const BENCHMARK_KURZ = {IWO:'IWO', '^GSPC':'S&P 500'};

function urteil(s){
  if (!s.reliable)   return {t:'Datenlücken', k:'warn'};
  if (s.total >= 65) return {t:'Kaufkandidat', k:'go'};
  if (s.total >= 55) return {t:'Beobachten',   k:'mid'};
  return {t:'Nachrangig', k:'low'};
}
const treiber = s => (s.components || [])
  .filter(k => k.normalized >= 70).sort((a, b) => b.normalized - a.normalized)
  .slice(0, 2).map(k => KURZ[k.name] || k.name);

const korbListe = id => (D[KOERBE[id].d] || []).map(d => ({...d, korb:id}))
  .sort((a, b) => b.scorecard.total - a.scorecard.total);
const alleKandidaten = () => Object.keys(KOERBE).flatMap(korbListe)
  .sort((a, b) => b.scorecard.total - a.scorecard.total);
const korbVon = sym => Object.keys(KOERBE)
  .find(id => (D[KOERBE[id].d] || []).some(d => d.candidate.symbol === sym));

/* ───────── Wechselkurse ─────────
   Der Einstand wurde in Dollar erfasst, gehandelt wird in Euro. Beides umzurechnen
   mischt Kursgewinn und Währungsgewinn, deshalb wird der Währungseffekt separat
   ausgewiesen statt versteckt. */
async function ladeFX(abDatum){
  try{
    const r = await fetch(`${CFG.fx}/${abDatum}..?base=USD&symbols=EUR`, {cache:'no-store'});
    if (!r.ok) throw new Error(r.status);
    const j = await r.json();
    const tage = Object.keys(j.rates || {}).sort();
    if (!tage.length) throw new Error('leer');
    FX = {tage, rate:Object.fromEntries(tage.map(t => [t, j.rates[t].EUR]))};
  }catch(e){ FX = null; }
}
function kursAm(d){
  if (!FX) return null;
  let best = null;
  for (const t of FX.tage){ if (t <= d) best = t; else break; }
  return FX.rate[best || FX.tage[0]];
}
const kursZuletzt = () => FX ? FX.rate[FX.tage[FX.tage.length - 1]] : null;
/* Der Lauf schreibt den Kurs inzwischen selbst (fx_eur_je_usd), das ist die
   verlässlichere Quelle. Die Live-EZB-Abfrage bleibt nur als Rückfallebene für
   einen Datenstand, der noch nicht neu gelaufen ist. */
const kursJetzt = () => D?.fx_eur_je_usd ?? kursZuletzt();

/* ───────── Navigation ─────────
   Drei Ziele statt fünf: "Kandidaten" trägt jetzt, was früher Markt und
   Screening getrennt zeigten, plus das frühere Makro als Abschnitt am Fuß. */
const TABS = [
  ['kandidaten','Kandidaten','<circle cx="10.5" cy="10.5" r="6.3"/><path d="M19.5 19.5 15 15"/><path d="M8 10.5h5M10.5 8v5" opacity=".55"/>'],
  ['verlauf',   'Verlauf',   '<path d="M3.5 19.5h17"/><path d="M6 19.5V13M10.5 19.5V8.5M15 19.5v-4.5M19.5 19.5V5.5"/>'],
  ['depot',     'Depot',     '<rect x="3" y="8.2" width="18" height="12" rx="2.2"/><path d="M8.2 8.2V6a3.8 3.8 0 0 1 7.6 0v2.2"/><path d="M12 13v2.4" opacity=".7"/>']
];
let aktiv = 0;

function buildTabs(){
  $('#tabbar').innerHTML = TABS.map(([id, txt, path], i) =>
    `<button data-go="${id}" class="${i === 0 ? 'on' : ''}" aria-label="${txt}">
       <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${path}</svg>
       <em>${txt}</em></button>`).join('');
  $$('#tabbar button').forEach(b => b.onclick = () => go(b.dataset.go));
}
function go(id){
  const neu = TABS.findIndex(t => t[0] === id);
  if (neu < 0) return;
  const rueck = neu < aktiv;
  aktiv = neu;
  $$('.view').forEach(v => {
    const an = v.id === 'v-' + id;
    v.classList.toggle('rueck', rueck);
    v.classList.toggle('on', an);
  });
  $$('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.go === id));
  location.hash = id;
  window.scrollTo({top:0, behavior:'instant'});
}

/* ───────── Detailblatt ───────── */
function sheet(html){
  $('#sheet-body').innerHTML = html;
  $('#sheet').classList.add('on');
  document.body.style.overflow = 'hidden';
}
function closeSheet(){
  $('#sheet').classList.remove('on');
  document.body.style.overflow = '';
}

/* Dieselbe Regel wie `pick_drivers` in position.py: nur Komponenten, die den
   Rang wirklich getragen haben, sortiert nach Beitrag statt nach Perzentil
   allein, hoechstens drei. Hier in JS verdoppelt, weil die Seite selbst kein
   Python ausfuehren kann; beide Stellen muessen bei einer Aenderung
   mitgezogen werden. */
function kaufTreiber(s){
  return (s.components || [])
    .filter(c => c.normalized != null && c.normalized >= 70)
    .sort((a, b) => b.normalized * b.weight - a.normalized * a.weight)
    .slice(0, 3)
    .map(c => ({name:c.name, percentile:c.normalized, weight:c.weight}));
}

/* ───────── Kandidatenzeile ───────── */
function zeile(d, rang){
  const s = d.scorecard, c = d.candidate, K = KOERBE[d.korb] || KOERBE.klein;
  const u = urteil(s), tr = treiber(s);
  return `<button class="row" data-sym="${esc(c.symbol)}">
    <span class="rhead">
      ${rang != null ? `<span class="rang">${rang + 1}</span>` : ''}
      <span class="korb ${K.cls}">${K.kurz}</span>
      <span class="sym">${esc(c.symbol)}</span>
      <span class="score">${nf(s.total, 1)}</span>
      <span class="chev">›</span>
    </span>
    <span class="nm">${esc(c.name)} · ${mrd(c.market_cap)} · ${esc(c.sector || '')}</span>
    <span class="bar"><i style="--w:${Math.max(2, Math.min(100, s.total))}%"></i></span>
    <span class="tags">
      <span class="tag ${u.k}">${u.t}</span>
      ${tr.map(t => `<span class="tag">${esc(t)}</span>`).join('')}
      ${d.trump_watch ? '<span class="tag trump">Trump-Depot</span>' : ''}
    </span>
  </button>`;
}
function bindRows(root, pool){
  $$('.row', root).forEach(b => b.onclick = () => {
    const d = pool.find(x => x.candidate.symbol === b.dataset.sym);
    if (d){ sheet(detail(d)); bindKaufFormular($('#sheet-body'), d); }
  });
}

function detail(d){
  const c = d.candidate, e = d.enrichment || {}, s = d.scorecard;
  const u = urteil(s), K = KOERBE[d.korb] || KOERBE.klein;
  const k = kursJetzt();

  const komp = (s.components || []).map(x => `
    <div style="padding:10px 0;border-bottom:1px solid var(--line)">
      <div style="display:flex;justify-content:space-between;font-size:14px">
        <span>${label(KOMPONENTE, x.name)} <span class="muted">${x.weight} %</span></span>
        <span class="mono">${nf(x.normalized, 0)}</span>
      </div>
      <div class="bar"><i style="--w:${Math.max(2, Math.min(100, x.normalized))}%"></i></div>
    </div>`).join('');

  const rows = [
    ['Korb', esc(K.lang)],
    ['Sektor', esc(c.sector)],
    ['Marktkapitalisierung', mrd(c.market_cap) + ' USD' +
      (k ? ` <span class="muted">≈ ${mrd(c.market_cap * k)} €</span>` : '')],
    ['Umsatzwachstum', pct(c.revenue_growth)],
    ['Bruttomarge', pct(c.gross_margin)],
    ['Freier Cashflow', mrd(c.fcf) + ' USD'],
    ['Handelsvolumen', mrd(c.avg_volume) + ' Stück'],
    ['ISIN', `<span class="code">${esc(c.isin)}</span>`],
    ['Revisionen, 30 Tage', `<span class="up">${e.up_revisions_30d ?? '–'} hoch</span> / <span class="down">${e.down_revisions_30d ?? '–'} runter</span>`],
    ['Wachstum, Quartalsvergleich', `${nf(e.revenue_growth_prior_q)} → ${nf(e.revenue_growth_recent_q)} %`],
    ['Insider, 90 Tage', `${e.insider_buyers_90d ?? '–'} kaufen / ${e.insider_sellers_90d ?? '–'} verkaufen`],
    ['Aktienzahl, Jahresänderung', pct(e.shares_growth_yoy, 2)],
    ['Leerverkaufsquote', e.short_pct_float == null ? '–' : nf(e.short_pct_float) + ' %'],
    ['Institutionell gehalten', e.institutional_pct == null ? '–' : nf(e.institutional_pct) + ' %'],
    ['Nächste Zahlen', datum(e.next_earnings)],
    ['Datenabdeckung', nf(s.coverage, 0) + ' %']
  ].map(([a, b]) => `<div class="kv"><span>${a}</span><span>${b}</span></div>`).join('');

  return `
    <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px">
      <div style="min-width:0">
        <div class="sym" style="font-size:25px">${esc(c.symbol)}</div>
        <div class="nm" style="white-space:normal">${esc(c.name)}</div>
        <div class="tags" style="margin-top:9px">
          <span class="tag ${u.k}">${u.t}</span>
          ${treiber(s).map(t => `<span class="tag">${esc(t)}</span>`).join('')}
        </div>
      </div>
      <div style="margin-left:auto;text-align:right;flex:none">
        <div class="mono" style="font-size:32px;font-weight:700;line-height:1;letter-spacing:-.02em">${nf(s.total, 1)}</div>
        <div class="muted" style="font-size:11px;margin-top:3px">Score</div>
      </div>
    </div>
    <h2 class="sec">Zusammensetzung</h2>${komp}
    <h2 class="sec">Kennzahlen</h2>${rows}
    ${zusatzsignale(d)}
    <h2 class="sec">Primärquellen</h2>
    <div class="kv"><span>SEC EDGAR</span><span><a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${esc(c.symbol)}&type=10-K" target="_blank" rel="noopener">Berichte ↗</a></span></div>
    <div class="kv"><span>Kurs und Termine</span><span><a href="https://finance.yahoo.com/quote/${esc(c.symbol)}" target="_blank" rel="noopener">Yahoo Finance ↗</a></span></div>
    <div style="height:10px"></div>
    ${kaufAbschnitt(d)}
    <button class="btn ghost" style="width:100%" data-close>Schließen</button>`;
}

/* Kaufen heißt hier: eine Positionsakte anlegen, keine Order auslösen. Die
   Seite kann nichts kaufen, sie hält nur fest, warum jemand gekauft hat, für
   die spätere Prüfung. Ohne entsperrtes Depot fehlt der Schlüssel zum
   Zurückschreiben, deshalb dann nur ein Hinweis statt eines Formulars. */
function kaufAbschnitt(d){
  const sym = d.candidate.symbol;
  if (!DEPOT){
    return `<div class="card"><p>Zum Anlegen einer Positionsakte zuerst im
      Depot-Reiter entsperren.</p></div>`;
  }
  const bereits = (DEPOT.positionen || []).some(p => p.symbol === sym && p.status !== 'geschlossen');
  if (bereits){
    return `<div class="card"><p>Für ${esc(sym)} liegt bereits eine offene
      Positionsakte im Depot.</p></div>`;
  }
  const preis = d.price != null ? nf(d.price, 2) : '';
  return `
    <h2 class="sec">Gekauft?</h2>
    <div class="card">
      <p style="margin-bottom:12px">Hält fest, warum gekauft wurde, damit die
      wöchentliche Prüfung später weiß, ob der Grund noch gilt.</p>
      <form data-kauf="${esc(sym)}">
        <div class="kv"><span>Kaufpreis</span>
          <span><input type="number" step="0.01" name="preis" value="${esc(preis)}"
            required style="width:110px;text-align:right;border:1px solid var(--line2);
            border-radius:8px;padding:6px 8px;font-size:14.5px;background:var(--bg);
            color:var(--ink)"> USD</span></div>
        <div class="kv"><span>Stückzahl</span>
          <span><input type="number" step="1" min="1" name="stueck" required
            style="width:110px;text-align:right;border:1px solid var(--line2);
            border-radius:8px;padding:6px 8px;font-size:14.5px;background:var(--bg);
            color:var(--ink)"></span></div>
        <div class="kv"><span>Datum</span>
          <span><input type="date" name="datum" value="${new Date().toISOString().slice(0,10)}"
            required style="border:1px solid var(--line2);border-radius:8px;
            padding:6px 8px;font-size:14.5px;background:var(--bg);color:var(--ink)"></span></div>
        <div style="height:6px"></div>
        <button class="btn" type="submit" style="width:100%">Positionsakte anlegen</button>
      </form>
    </div>`;
}
function bindKaufFormular(root, d){
  const f = root.querySelector(`form[data-kauf]`);
  if (!f) return;
  f.onsubmit = async ev => {
    ev.preventDefault();
    const fd = new FormData(f);
    const preis = parseFloat(fd.get('preis')), stueck = parseInt(fd.get('stueck'), 10);
    const datum = fd.get('datum');
    if (!(preis > 0) || !(stueck > 0)) return;
    const K = KOERBE[d.korb] || KOERBE.klein;
    DEPOT.positionen = DEPOT.positionen || [];
    DEPOT.positionen.push({
      symbol: d.candidate.symbol, name: d.candidate.name, korb: d.korb,
      opened: datum, entry_price_usd: preis, quantity: stueck,
      score_at_entry: d.scorecard.total,
      benchmark_symbol: K.d === 'dossiers_large_cap' ? '^GSPC' : 'IWO',
      drivers: kaufTreiber(d.scorecard),
      status: 'halten',
      summary: 'Angelegt, noch keine wöchentliche Prüfung gelaufen.'
    });
    await depotSpeichern();
    zeigeSpeicherHinweis();
  };
}

/* Trump-Beobachtungsliste, FDA-Rückrufe, Bundesaufträge: alle drei rein
   informativ, keiner davon fließt in den Score ein, siehe pipeline.py. Nur
   gerendert, wenn für den Titel tatsächlich etwas vorliegt. */
function zusatzsignale(d){
  const tw = d.trump_watch, fda = d.fda_signals, usa = d.usaspending_signals;
  if (!tw && !fda && !usa) return '';
  const teile = [];
  if (tw) teile.push(`<div class="kv"><span>Trump-Depot</span>
      <span>seit ${datum(tw.gemeldet)} · ${esc(tw.zeitraum || '')}</span></div>
    <div class="kv"><span>Quelle</span>
      <span><a href="${esc(tw.quelle_url)}" target="_blank" rel="noopener">${esc(tw.quelle || 'Offenlegung')} ↗</a></span></div>
    ${tw.hinweis ? `<p class="muted" style="font-size:12.5px;margin:6px 0 0">${esc(tw.hinweis)}</p>` : ''}`);
  if (fda) teile.push(`<div class="kv"><span>FDA-Rückrufe, 12 Monate</span><span>${fda.anzahl_12m}</span></div>
    ${fda.letzter ? `<p class="muted" style="font-size:12.5px;margin:6px 0 0">Jüngster: ${datum(fda.letzter.datum)},
      ${esc(fda.letzter.klasse || '')} (${esc(fda.letzter.art || '')}) · ${esc(fda.letzter.grund || '')}</p>` : ''}`);
  if (usa) teile.push(`<div class="kv"><span>Bundesaufträge, 12 Monate</span>
      <span>${usa.anzahl_12m} · ${mrd(usa.summe_12m)} USD</span></div>
    ${usa.letzter ? `<p class="muted" style="font-size:12.5px;margin:6px 0 0">Jüngster: ${datum(usa.letzter.datum)},
      ${esc(usa.letzter.agentur || '')}</p>` : ''}`);
  return `<h2 class="sec">Zusatzsignale</h2>${teile.join('')}`;
}

/* ═══════════ KANDIDATEN ═══════════ */
function renderKandidaten(){
  const alle = alleKandidaten();
  const gescreent = (D.screened || 0) + (D.screened_large_cap || 0) + (D.screened_early_bets || 0);
  const kauf = alle.filter(d => urteil(d.scorecard).k === 'go');
  const top10 = alle.slice(0, 10);
  const schnitt = top10.length ? top10.reduce((a, d) => a + d.scorecard.total, 0) / top10.length : null;

  $('#markt-big').textContent = alle.length;
  $('#markt-lbl').innerHTML = `Kandidaten aus <b>${gescreent}</b> geprüften`;

  const tage = alterTage(D.generated_at);
  $('#stamp').innerHTML = `<b><span class="dot"></span>${datum(D.generated_at)}</b>` +
    (tage > 9 ? `<span class="down">${tage} Tage alt</span>` : 'Datenstand');

  $('#markt-tiles').innerHTML = [
    [kauf.length, 'Kaufkandidaten'], [nf(schnitt, 1), 'Score Top 10'],
    [alle.length, 'im Register'], [gescreent, 'geprüft']
  ].map(([n, k]) => `<div class="tile"><div class="n">${n}</div><div class="k">${k}</div></div>`).join('');

  renderKatalog();

  const nok = D.news_sources_ok || {};
  const qz = [
    ['SEC EDGAR', D.edgar_used], ['Federal Register', (D.policy_acts || []).length > 0],
    ['Fed', nok.fed], ['EZB', nok.ecb], ['BLS', nok.bls_latest],
    ['BLS-Kalender', D.calendar_source_ok], ['EZB-Wechselkurse', !!FX]
  ].map(([n, ok]) => `<div class="kv"><span>${n}</span>
      <span class="${ok ? 'up' : 'down'}">${ok ? 'geliefert' : 'nicht erreichbar'}</span></div>`).join('');

  $('#markt-quellen').innerHTML = qz +
    `<div class="kv"><span>Lauf vom</span><span>${datum(D.generated_at)}, vor ${tage} Tagen</span></div>
     <div class="kv"><span>Neu laufen lassen</span>
       <span><span class="code">scroll.command</span> · <a href="https://github.com/${CFG.repo}" target="_blank" rel="noopener">Repo ↗</a></span></div>`;

  renderUmfeld();
}

/* Kategorien, App-Store-artig: Überschrift, fünf Plätze, alle anzeigen. */
function renderKatalog(){
  $('#katalog').innerHTML = Object.entries(KOERBE).map(([id, K]) => {
    const list = korbListe(id), n = gezeigt[id];
    const rest = list.length - n;
    const rej = D[K.r] || [];
    return `<section class="kat ${K.cls}">
      <div class="kat-kopf">
        <span class="kat-farbe"></span>
        <div>
          <h3>${esc(K.titel)}</h3>
          <p>${esc(K.unter)} · ${list.length} Kandidaten</p>
        </div>
        <button class="kat-alle" data-alle="${id}">Alle ›</button>
      </div>
      <div class="card" data-liste="${id}">${
        list.length ? list.slice(0, n).map((d, i) => zeile(d, i)).join('')
                    : '<p class="muted">Keine Kandidaten in diesem Korb.</p>'}</div>
      ${rest > 0 ? `<button class="mehr" data-mehr="${id}">Weitere ${Math.min(5, rest)} anzeigen
        <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
      </button>` : ''}
      ${rej.length ? `<button class="ausgeschieden" data-warum="${id}">
        <b>${rej.length}</b> ausgeschieden ›</button>` : ''}
    </section>`;
  }).join('');

  Object.keys(KOERBE).forEach(id =>
    bindRows($(`[data-liste="${id}"]`), korbListe(id)));
  $$('#katalog .mehr').forEach(b => b.onclick = () => {
    gezeigt[b.dataset.mehr] += 5; renderKatalog();
  });
  $$('#katalog .kat-alle').forEach(b => b.onclick = () => {
    gezeigt[b.dataset.alle] = korbListe(b.dataset.alle).length; renderKatalog();
  });
  $$('#katalog .ausgeschieden').forEach(b => b.onclick = () => warumSheet(b.dataset.warum));
}

/* Warum ein Titel im jeweiligen Korb ausgeschieden ist. Früher eine eigene
   Ansicht ("Screening"), jetzt ein Detailblatt, weil es Beleg ist und keine
   eigene Bestimmung. */
function warumSheet(id){
  const K = KOERBE[id], rej = D[K.r] || [];
  const g = {};
  rej.forEach(r => (g[r.reason] = (g[r.reason] || 0) + 1));
  const zeilen = Object.entries(g).sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `<div class="kv"><span>${esc(label(GRUND, k))}</span><span>${n}</span></div>`).join('');
  sheet(`<h2 class="sec">Ausgeschieden · ${esc(K.titel)}</h2>${zeilen || '<p class="muted">Nichts ausgeschieden.</p>'}
    <div style="height:10px"></div>
    <button class="btn ghost" style="width:100%" data-close>Schließen</button>`);
}

/* ═══════════ MARKTUMFELD (früher eigener Tab "Makro") ═══════════ */
function renderUmfeld(){
  const acts = D.policy_acts || [];
  const felder = [...new Set(acts.flatMap(a => a.fields || []))].sort();
  $('#policy-chips').innerHTML =
    `<button class="chip ${policyField === '*' ? 'on' : ''}" data-f="*">Alle ${acts.length}</button>` +
    felder.map(f => `<button class="chip ${policyField === f ? 'on' : ''}" data-f="${esc(f)}">${esc(label(FELD, f))}</button>`).join('');
  $$('#policy-chips .chip').forEach(b => b.onclick = () => { policyField = b.dataset.f; renderUmfeld(); });

  const shown = (policyField === '*' ? acts : acts.filter(a => (a.fields || []).includes(policyField)))
    .sort((a, b) => (b.publication_date || '').localeCompare(a.publication_date || '')).slice(0, 24);

  $('#policy-list').innerHTML = `<h3>Rechtsakte</h3>` + (shown.length ? shown.map(a => `
    <div class="row">
      <a href="${esc(a.url)}" target="_blank" rel="noopener"
         style="font-size:14.5px;line-height:1.4;display:block">${esc(a.title)}</a>
      <span class="nm" style="white-space:normal;margin-top:5px">${datum(a.publication_date)}${
        (a.countries || []).length ? ' · ' + esc(a.countries.join(', ')) : ''}</span>
      <span class="tags">${(a.sectors || []).slice(0, 4).map(s => `<span class="tag">${esc(s)}</span>`).join('')}</span>
    </div>`).join('') : '<p class="muted">Nichts in diesem Feld.</p>');

  const news = D.news_items || [];
  $('#news-list').innerHTML = `<h3>Notenbanken und Statistik</h3>` + (news.length ? news.slice(0, 16).map(n => `
    <div class="row">
      <a href="${esc(n.url)}" target="_blank" rel="noopener"
         style="font-size:14.5px;line-height:1.4;display:block">${esc(n.title)}</a>
      <span class="nm" style="margin-top:5px"><span class="acc">${esc(QUELLE[n.source] || n.source)}</span>
        · ${datum(n.published)}</span>
    </div>`).join('') : '<p class="muted">Keine Meldungen abrufbar.</p>');

  const cal = D.calendar_events || [];
  $('#cal-list').innerHTML = `<h3>Termine</h3>` + (cal.length
    ? cal.map(c => `<div class="kv"><span>${esc(c.title)}</span><span>${datum(c.start)}</span></div>`).join('')
    : '<p class="muted">Kalender nicht erreichbar.</p>');
}

/* ═══════════ VERLAUF ═══════════ */
function isoWoche(d){
  const t = new Date(d + 'T12:00:00Z');
  const tag = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - tag);
  const j0 = Date.UTC(t.getUTCFullYear(), 0, 1);
  return t.getUTCFullYear() * 100 + Math.ceil(((t - j0) / 864e5 + 1) / 7);
}
const monatKey = d => d.slice(0, 7);
const monatName = k => new Date(k + '-15T12:00:00Z')
  .toLocaleDateString('de-DE', {month:'long', year:'numeric'});

/* Rechnet einen Eintrag in Euro um und trennt Kurs- von Währungseffekt.
   Bevorzugt die im Lauf selbst gespeicherten Kurse (fx_at_entry/fx_now):
   die sind exakt der Stand des jeweiligen Laufs, keine Näherung über das
   Kalenderdatum. Nur Einträge von vor dieser Funktion haben diese Felder
   nicht, dafür bleibt die Live-EZB-Abfrage als Rückfallebene. */
function inEuro(e, standDatum){
  const kEin = e.fx_at_entry ?? kursAm(iso(e.date));
  const kJetzt = e.fx_now ?? kursJetzt() ?? kursAm(standDatum);
  if (!kEin || !kJetzt) return null;
  const ein = e.price_at_entry * kEin, jetzt = (e.price_now ?? e.price_at_entry) * kJetzt;
  return {
    ein, jetzt,
    rendite: (jetzt / ein - 1) * 100,
    fx: (kJetzt / kEin - 1) * 100
  };
}

function renderHistorie(){
  const ts = D.track_summary || {}, tr = D.track_record || [];
  const stand = iso(D.generated_at);
  const w = ts.weeks || 0, need = (ts.weeks_needed || 0) + w || 12;

  const euros = tr.map(e => inEuro(e, stand)).filter(Boolean);
  const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const medEur = med(euros.map(x => x.rendite));
  const medFx  = med(euros.map(x => x.fx));

  $('#hist-hero').innerHTML = `
    <div class="card">
      <div style="display:flex;align-items:flex-end;gap:16px">
        <div>
          <div class="mono ${sign(medEur)}" style="font-size:40px;font-weight:750;letter-spacing:-.02em;line-height:1">
            ${pct(medEur)}</div>
          <div class="muted" style="font-size:12px;margin-top:6px">Median in Euro</div>
        </div>
        <div style="margin-left:auto;text-align:right">
          <div class="mono ${sign(ts.median_excess_pct)}" style="font-size:21px;font-weight:650">${pct(ts.median_excess_pct)}</div>
          <div class="muted" style="font-size:11.5px">gegen ${esc(ts.benchmark_symbol || 'IWO')}</div>
        </div>
      </div>
      <div style="height:14px"></div>
      <div class="kv"><span>Positionen</span><span>${ts.entries ?? 0}</span></div>
      <div class="kv"><span>Trefferquote</span><span>${nf(ts.hit_rate_pct, 0)} %</span></div>
      <div class="kv"><span>davon Währungseffekt</span>
        <span class="${sign(medFx)}">${pct(medFx, 2)}</span></div>
      <div class="kv"><span>Wechselkurs am Stand</span>
        <span>${kursJetzt() ? '1 USD = ' + nf(kursJetzt(), 4) + ' €' : 'nicht geladen'}</span></div>
      <div class="kv"><span>Datenbasis</span>
        <span class="${ts.meaningful ? '' : 'gold'}">${w} von ${need} Kalenderwochen</span></div>
      <div class="bar" style="margin-top:12px"><i style="--w:${Math.min(100, w / need * 100)}%"></i></div>
    </div>
    <div class="card">
      <h3>Was hier gerechnet wird</h3>
      <p>Einstand und Stand werden mit dem EZB-Referenzkurs des jeweiligen Tages in Euro
      umgerechnet, weil in Euro gehandelt wird. Der Währungsanteil steht oben getrennt,
      sonst würde eine Dollarschwäche wie ein schlechter Pick aussehen. Der Vergleich
      gegen ${esc(ts.benchmark_name || 'IWO')} bleibt in Dollar, damit er den
      Währungseffekt nicht doppelt zählt. Unter ${need} Kalenderwochen ist die Kennzahl
      ausdrücklich Rauschen, keine Aussage.</p>
    </div>`;

  $('#hist-chips').innerHTML = [['woche', 'Wochen'], ['monat', 'Monate']]
    .map(([k, t]) => `<button class="chip ${histRaster === k ? 'on' : ''}" data-r="${k}">${t}</button>`).join('');
  $$('#hist-chips .chip').forEach(b => b.onclick = () => { histRaster = b.dataset.r; renderHistorie(); });

  if (!tr.length){ $('#hist-liste').innerHTML =
    '<div class="card"><p class="muted">Noch keine Positionen eingefroren.</p></div>'; return; }

  const gruppen = {};
  tr.forEach(e => {
    const d = iso(e.date);
    const k = histRaster === 'woche' ? isoWoche(d) : monatKey(d);
    (gruppen[k] ||= {key:k, von:d, bis:d, eintraege:[]});
    const g = gruppen[k];
    g.eintraege.push(e);
    if (d < g.von) g.von = d;
    if (d > g.bis) g.bis = d;
  });

  const sortiert = Object.values(gruppen).sort((a, b) => String(a.key).localeCompare(String(b.key)));

  $('#hist-liste').innerHTML = sortiert.map((g, i) => {
    const nachKorb = {};
    [...g.eintraege].sort((a, b) => (a.rank || 99) - (b.rank || 99)).forEach(e => {
      const kb = e.korb || korbVon(e.symbol) || 'klein';
      (nachKorb[kb] ||= []).push(e);
    });

    const koerbeHtml = Object.keys(KOERBE).filter(kb => nachKorb[kb]?.length).map(kb => {
      const K = KOERBE[kb], top = nachKorb[kb].slice(0, 3);
      const bmSym = top[0]?.benchmark_symbol || 'IWO';
      const bmEin = top[0]?.benchmark_at_entry;
      const bmRet = top[0]?.benchmark_return_pct;

      const posHtml = top.map(e => {
        const E = inEuro(e, stand);
        const jetzt = E ? eur(E.jetzt) : nf(e.price_now ?? e.price_at_entry, 2) + ' $';
        const ein   = E ? eur(E.ein)   : nf(e.price_at_entry, 2) + ' $';
        const delta = E ? E.rendite : e.return_pct;
        return `<div class="pos">
          <span class="pos-mitte">
            <span class="pos-top">
              <span class="sym">${esc(e.symbol)}</span>
              <span class="jetzt">${jetzt}</span>
            </span>
            <span class="pos-sub">
              <span class="nm">${esc(e.name || '')}</span>
              <span class="delta ${sign(delta)}">${pct(delta)}</span>
            </span>
            <span class="ein">Einstand ${ein} am ${datum(e.date)} · Score ${nf(e.score_at_entry, 1)}</span>
          </span>
        </div>`;
      }).join('');

      return `<div class="korb-block">
        <div class="korb-kopf">
          <span class="korb ${K.cls}">${K.kurz}</span>
          <span class="korb-titel">${esc(K.titel)}</span>
          <span class="korb-bm">${esc(BENCHMARK_KURZ[bmSym] || bmSym)}
            ${bmEin != null ? nf(bmEin, 2) : '–'}${bmRet != null ? ' · ' + pct(bmRet) : ''}</span>
        </div>
        ${posHtml}
      </div>`;
    }).join('');

    return `<div class="woche">
      <div class="woche-kopf">
        <span class="woche-nr">${histRaster === 'woche' ? 'WOCHE ' + (i + 1) : monatName(g.key).toUpperCase()}</span>
        <span class="woche-dat">${g.von === g.bis ? datum(g.von) : datum(g.von) + ' bis ' + datum(g.bis)}</span>
      </div>
      <div class="woche-koerper">${koerbeHtml}</div>
    </div>`;
  }).reverse().join('');
}

/* ═══════════ DEPOT ═══════════ */
const b64dec = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function schluessel(pw, salt, iter){
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2', salt, iterations:iter, hash:'SHA-256'},
    raw, {name:'AES-GCM', length:256}, false, ['decrypt', 'encrypt']);
}
const b64enc = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));

/* ───────── Depot merken und zurückschreiben ─────────
   Die Seite hat keinen Server, sie kann selbst nichts dauerhaft speichern.
   Nach dem Entsperren bleiben Klartext und Schlüssel nur im Speicher dieser
   Sitzung. "Speichern" heißt hier: eine neue verschlüsselte Datei bauen und
   zum Download anbieten. Maik ersetzt data/depot.enc damit und committet wie
   bisher, nur ohne von Hand JSON zu bearbeiten oder ein Python-Skript
   aufzurufen. */
let DEPOT = null, DEPOT_KEY = null, DEPOT_SALT = null, DEPOT_ITER = null;

function zeigeSpeicherHinweis(){
  sheet(`<h2 class="sec">Heruntergeladen</h2>
    <div class="card">
      <p><span class="code">depot.enc</span> liegt jetzt im Downloads-Ordner. Ersetze
      damit die Datei unter <span class="code">data/depot.enc</span> im Repo und
      committe wie gewohnt:</p>
      <div style="height:8px"></div>
      <p class="code" style="display:block;white-space:pre-line;line-height:1.7">cd ~/Desktop/"Claude Cowork"/sparplan-site
mv ~/Downloads/depot.enc data/depot.enc
git add data/depot.enc && git commit -m "Depot aktualisiert" && git push</p>
      <p style="margin-top:10px">Bis dahin zeigt nur diese Sitzung den neuen Stand,
      die veroeffentlichte Seite noch den alten.</p>
    </div>
    <div style="height:10px"></div>
    <button class="btn ghost" style="width:100%" data-close>Verstanden</button>`);
}

async function depotSpeichern(){
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(DEPOT));
  const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv}, DEPOT_KEY, pt);
  const box = {salt: DEPOT_SALT, iv: b64enc(iv), iter: DEPOT_ITER, ct: b64enc(ct)};
  const blob = new Blob([JSON.stringify(box)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'depot.enc'; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
  depotZeigen(DEPOT);
}
function depotLock(){
  $('#depot-body').innerHTML = `
    <div class="lock">
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--acc)" stroke-width="1.5"
           stroke-linecap="round">
        <rect x="3.5" y="9.5" width="17" height="11" rx="2.2"/>
        <path d="M8 9.5V6.4a4 4 0 0 1 8 0v3.1"/><path d="M12 13.6v2.8"/>
      </svg>
      <h3 style="margin:16px 0 5px">Depot verschlossen</h3>
      <p class="muted" style="max-width:330px;margin:0 auto;font-size:14px">
        Der Bestand liegt auf dieser öffentlichen Seite nur als AES-256-GCM-Block.</p>
      <form id="unlock">
        <input type="password" id="pw" placeholder="Passwort" autocomplete="current-password">
        <div><button class="btn" type="submit">Entsperren</button></div>
        <div class="err" id="lockerr"></div>
      </form>
    </div>`;
  $('#unlock').onsubmit = async ev => {
    ev.preventDefault();
    const err = $('#lockerr'); err.textContent = '';
    try {
      const box = await (await fetch(CFG.depot, {cache:'no-store'})).json();
      const key = await schluessel($('#pw').value, b64dec(box.salt), box.iter || 210000);
      const klar = await crypto.subtle.decrypt({name:'AES-GCM', iv:b64dec(box.iv)}, key, b64dec(box.ct));
      DEPOT = JSON.parse(new TextDecoder().decode(klar));
      DEPOT_KEY = key; DEPOT_SALT = box.salt; DEPOT_ITER = box.iter || 210000;
      depotZeigen(DEPOT);
    } catch (e) {
      err.textContent = e instanceof SyntaxError || String(e).includes('JSON')
        ? 'Noch kein verschlüsseltes Depot hinterlegt.' : 'Passwort passt nicht.';
    }
  };
}

/* Näherungsweise Gewichtung einzelner Aktien INNERHALB der gehaltenen ETF.
   Keine Live-Quelle: aus bekannten Indexzusammensetzungen, Stand ungefähr
   Sommer 2026, gerundet. Muss ersetzt werden, sobald ein echter Datenlauf
   Fondsdurchschauwerte mitbringt (Fondsanbieter-Factsheet oder Index-API).
   Reihenfolge ist wichtig: "Information Tech" und "NASDAQ100" müssen vor
   dem allgemeinen "S&P 500" geprüft werden, weil ihr Fondsname diesen
   Teilstring ebenfalls enthalten kann. */
/* Stand der Fondsgewichte: 30. Juli - 15. August 2026, aus den offiziellen
   Kennzahlen der Fondsanbieter (justETF/iShares-Factsheets), keine
   Live-Abfrage. Google-Positionen fassen die A- und C-Aktie des jeweiligen
   Fonds zusammen, weil hier die Unternehmens-, nicht die Aktiengattungs-
   Exposure zaehlt. */
const ETF_GEWICHTE = new Map([
  ['Information Tech', {AAPL:20.12, NVDA:19.82, MSFT:14.16}],
  ['MSCI World',       {AAPL:5.48, NVDA:5.04, MSFT:3.56, GOOGL:3.91, TSLA:1.28}],
  ['MSCI EM IMI',      {TSM:13.04, '1810.HK':0.44}],
  ['NASDAQ100',        {AAPL:8.16, NVDA:7.87, MSFT:5.58, GOOGL:6.27, TSLA:3.0}],
  ['S&P 500',          {AAPL:7.65, NVDA:7.38, MSFT:5.23, GOOGL:5.52, TSLA:1.42}],
]);
function fondsFuer(name){
  for (const [schluessel, gewichte] of ETF_GEWICHTE)
    if ((name || '').includes(schluessel)) return gewichte;
  return null;
}
function durchschau(h){
  const etfs = h.filter(x => x.kind === 'etf');
  const aktien = h.filter(x => x.kind === 'aktie' && x.symbol);
  const symbole = new Set(aktien.map(a => a.symbol));
  ETF_GEWICHTE.forEach(g => Object.keys(g).forEach(s => symbole.add(s)));

  return [...symbole].map(sym => {
    const direkt = aktien.find(a => a.symbol === sym);
    let indirekt = 0;
    etfs.forEach(e => {
      const g = fondsFuer(e.name);
      if (g && g[sym] != null) indirekt += (e.weight || 0) / 100 * g[sym];
    });
    const brutto = direkt?.weight || 0;
    return {sym, name: direkt?.name || sym, direkt: brutto, indirekt,
             gesamt: brutto + indirekt};
  }).filter(r => r.gesamt >= 0.3).sort((a, b) => b.gesamt - a.gesamt);
}
function renderDurchschau(h){
  const rows = durchschau(h);
  if (!rows.length) return '';
  const top2 = rows.slice(0, 2).reduce((s, r) => s + r.gesamt, 0);
  const top2direkt = rows.slice(0, 2).reduce((s, r) => s + r.direkt, 0);
  return `
    <h2 class="sec">Durchschau durch die ETF</h2>
    <div class="card">
      <table class="durchschau">
        <tr><th>Titel</th><th>direkt</th><th>über ETF</th><th>gesamt</th></tr>
        ${rows.map(r => `<tr>
          <td>${esc(r.sym)}</td>
          <td class="brutto">${nf(r.direkt, 1)} %</td>
          <td class="brutto">${r.indirekt >= 0.05 ? '+' + nf(r.indirekt, 1) + ' %' : '–'}</td>
          <td class="netto">${nf(r.gesamt, 1)} %</td>
        </tr>`).join('')}
      </table>
      <p class="hinweis">Die direkte Gewichtung zeigt kein Depot vollständig: die beiden größten
      Positionen machen zusammen ${nf(top2direkt, 0)} % direkt aus, durchgerechnet mit den
      Fondsanteilen aber rund ${nf(top2, 0)} %. Die Fondsgewichte stammen aus den offiziellen
      Kennzahlen der Fondsanbieter (Stand Ende Juli/August 2026), keine Live-Abfrage. Nach
      groesseren Index-Umschichtungen der Fonds braucht diese Tabelle eine manuelle
      Aktualisierung.</p>
    </div>`;
}

/* Positionsakte: hält beim Kauf fest, welche Kennzahlen den Rang getragen
   haben, prüft wöchentlich, ob der Grund noch gilt. Baustein `position.py`
   ist fertig und getestet, aber noch nicht an einen Datenlauf angeschlossen,
   siehe Projektnotiz "Zielbild-Kauf-und-Verkauf". Sobald `dp.positionen`
   Einträge liefert, erscheinen sie hier mit Halten/Prüfen/Verkaufen; bis
   dahin steht nur die Erklärung. */
function renderPositionen(dp){
  const alle = dp.positionen || [];
  const offen = alle.filter(p => p.status !== 'geschlossen');
  const zu = alle.filter(p => p.status === 'geschlossen');
  if (!alle.length){
    return `<h2 class="sec">Kauf- und Verkaufslogik</h2>
      <div class="card">
        <h3>Noch keine Positionsakte</h3>
        <p>Für jeden Kauf hält die Seite künftig fest, welche Kennzahlen ihn begründet
        haben, und prüft wöchentlich, ob der Grund noch gilt. Ein Kauf lässt sich im
        Detailblatt eines Kandidaten anlegen ("Gekauft?"). Verkaufsvorschläge stützen
        sich dann auf echte Kennzahlen statt auf ein starres Kursziel, sobald ein
        Datenlauf die wöchentliche Prüfung mitbringt.</p>
      </div>`;
  }
  const FARBE = {verkaufen:'warn', pruefen:'mid', halten:'go'};
  const TEXT  = {verkaufen:'Verkaufen', pruefen:'Prüfen', halten:'Halten'};
  const offenHtml = offen.map(p => `<div class="row">
      <span class="rhead">
        <span class="sym">${esc(p.symbol)}</span>
        <span class="tag ${FARBE[p.status] || 'go'}" style="margin-left:auto">${esc(TEXT[p.status] || 'Halten')}</span>
      </span>
      <span class="nm" style="white-space:normal;margin-top:6px">${esc(p.summary || '')}</span>
      <span class="nm" style="margin-top:4px">${p.quantity} Stück · Einstand ${nf(p.entry_price_usd,2)} USD
        am ${datum(p.opened)} · Score ${nf(p.score_at_entry,1)}</span>
      ${(p.drivers || []).length ? `<span class="tags">${p.drivers.map(d =>
        `<span class="tag">${esc(KURZ[d.name] || d.name)}</span>`).join('')}</span>` : ''}
      <button class="mehr" style="margin-top:9px" data-verkauf="${esc(p.symbol)}">Verkauft markieren</button>
    </div>`).join('');
  const zuHtml = zu.length ? `<h2 class="sec">Geschlossen</h2><div class="card">${
    zu.map(p => `<div class="kv"><span>${esc(p.symbol)}, ${datum(p.closed)}</span>
      <span class="${sign(p.realized_pct)}">${pct(p.realized_pct)}</span></div>`).join('')}</div>` : '';
  return `<h2 class="sec">Kauf- und Verkaufslogik</h2><div class="card">${offenHtml}</div>${zuHtml}`;
}
function bindVerkaufen(root){
  $$('[data-verkauf]', root).forEach(b => b.onclick = () => {
    const sym = b.dataset.verkauf;
    const p = (DEPOT.positionen || []).find(x => x.symbol === sym && x.status !== 'geschlossen');
    if (!p) return;
    sheet(`<h2 class="sec">${esc(sym)} verkauft</h2>
      <div class="card">
        <form data-exit="${esc(sym)}">
          <div class="kv"><span>Verkaufspreis</span>
            <span><input type="number" step="0.01" name="preis" required
              style="width:110px;text-align:right;border:1px solid var(--line2);
              border-radius:8px;padding:6px 8px;font-size:14.5px;background:var(--bg);
              color:var(--ink)"> USD</span></div>
          <div class="kv"><span>Datum</span>
            <span><input type="date" name="datum" value="${new Date().toISOString().slice(0,10)}"
              required style="border:1px solid var(--line2);border-radius:8px;
              padding:6px 8px;font-size:14.5px;background:var(--bg);color:var(--ink)"></span></div>
          <div style="height:6px"></div>
          <button class="btn" type="submit" style="width:100%">Als verkauft eintragen</button>
        </form>
      </div>`);
    $('[data-exit]').onsubmit = async ev => {
      ev.preventDefault();
      const fd = new FormData(ev.target);
      const preis = parseFloat(fd.get('preis'));
      if (!(preis > 0)) return;
      p.status = 'geschlossen';
      p.closed = fd.get('datum');
      p.exit_price_usd = preis;
      p.realized_pct = Math.round((preis / p.entry_price_usd - 1) * 1000) / 10;
      await depotSpeichern();
      zeigeSpeicherHinweis();
    };
  });
}

function depotZeigen(dp){
  const h = dp.holdings || [], p = dp.plan || {};
  const aktien = h.filter(x => x.kind === 'aktie'), etfs = h.filter(x => x.kind === 'etf');
  const anteil = a => a.reduce((s, x) => s + (x.weight || 0), 0);
  const summe = h.reduce((s, x) => s + (x.value ?? 0), 0);
  const imDepot = new Set(h.map(x => (x.symbol || '').toUpperCase()).filter(Boolean));
  const doppelt = alleKandidaten().filter(d => imDepot.has(d.candidate.symbol.toUpperCase()));

  const liste = a => [...a].sort((x, y) => (y.weight || 0) - (x.weight || 0)).map(x => `
    <div class="row">
      <span class="rhead">
        <span class="sym">${esc(x.symbol || x.name)}</span>
        <span class="score">${nf(x.weight, 1)} %</span>
      </span>
      ${x.symbol ? `<span class="nm">${esc(x.name)}</span>` : ''}
      <span class="bar"><i style="--w:${Math.min(100, (x.weight || 0) * 3.5)}%"></i></span>
    </div>`).join('');
  const planPos = p.positions || p.items || [];

  $('#depot-body').innerHTML = `
    <h2 class="sec">Bestand</h2>
    <div class="tiles">
      <div class="tile"><div class="n">${h.length}</div><div class="k">Positionen</div></div>
      <div class="tile"><div class="n">${summe ? nf(summe, 0) : '–'}<small>€</small></div><div class="k">Wert</div></div>
      <div class="tile"><div class="n">${nf(anteil(aktien), 0)}<small>%</small></div><div class="k">Einzelaktien</div></div>
      <div class="tile"><div class="n">${nf(anteil(etfs), 0)}<small>%</small></div><div class="k">ETF</div></div>
    </div>
    ${renderDurchschau(h)}
    ${renderPositionen(dp)}
    ${doppelt.length ? `<h2 class="sec">Bereits im Bestand</h2><div class="card">
      <p>${doppelt.length} Wert${doppelt.length > 1 ? 'e' : ''} aus dem aktuellen Screening liegen schon im Depot.</p>
      <div style="height:8px"></div>${doppelt.map((d, i) => zeile(d, i)).join('')}</div>` : ''}
    ${aktien.length ? `<h2 class="sec">Aktien</h2><div class="card">${liste(aktien)}</div>` : ''}
    ${etfs.length ? `<h2 class="sec">ETF</h2><div class="card">${liste(etfs)}</div>` : ''}
    ${planPos.length ? `<h2 class="sec">Sparplan</h2><div class="card">
      ${planPos.map(x => `<div class="kv"><span>${esc(x.name || x.symbol)}</span>
        <span>${x.amount != null ? eur(x.amount) : nf(x.weight, 1) + ' %'}</span></div>`).join('')}
      ${p.monthly != null ? `<div class="kv"><span>Summe im Monat</span><span>${eur(p.monthly)}</span></div>` : ''}
    </div>` : ''}
    <div class="center" style="margin:20px 0">
      <button class="btn ghost" onclick="location.reload()">Wieder verschließen</button>
    </div>`;
  bindRows($('#depot-body'), alleKandidaten());
  bindVerkaufen($('#depot-body'));
}

/* ───────── Hologramm-Energie ───────── */
const kern = () => $('.holo-core')?.holo || null;
function puls(ms = 2600){
  const k = kern(); if (!k) return;
  k.setEnergy(1);
  setTimeout(() => k.setEnergy(null), ms);
}

/* ═══════════ Start ═══════════ */
async function start(){
  buildTabs();
  $('#stage')?.addEventListener('pointerdown', () => puls(1800));
  $('#sheet').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });
  document.addEventListener('click', e => { if (e.target.matches('[data-close]')) closeSheet(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

  try {
    const r = await fetch(CFG.data, {cache:'no-store'});
    if (!r.ok) throw new Error(r.status);
    D = await r.json();
  } catch (e) {
    $('#katalog').innerHTML =
      `<div class="card"><h3 class="gold">Keine Daten geladen</h3>
       <p class="muted">${esc(CFG.data)} nicht erreichbar (${esc(e.message)}).</p></div>`;
    return;
  }

  const fruehestes = (D.track_record || []).reduce((m, e) => {
    const d = iso(e.date); return !m || d < m ? d : m; }, null);
  if (fruehestes) await ladeFX(fruehestes);

  renderKandidaten(); renderHistorie(); depotLock();
  puls();

  const ausHash = () => {
    const h = location.hash.slice(1);
    if (TABS.some(t => t[0] === h)) go(h);
  };
  window.addEventListener('hashchange', ausHash);
  ausHash();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
start();

})();
