/* Sparplan OS — liest data/latest.json zur Laufzeit und baut daraus alle Ansichten.
   Kein Build, kein Framework, keine externe Abhaengigkeit ausser holo-core.js. */
(() => {
'use strict';

const CFG = {
  repo: 'Maik45133/sparplan',
  workflow: 'wochenlauf.yml',
  data: 'data/latest.json',
  depot: 'data/depot.enc'
};

/* ─────────────── Werkzeug ─────────────── */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const nf = (v, d = 1) => v === null || v === undefined || Number.isNaN(v)
  ? '–' : Number(v).toLocaleString('de-DE', {minimumFractionDigits:d, maximumFractionDigits:d});
const pct  = (v, d = 1) => v === null || v === undefined ? '–' : (v > 0 ? '+' : '') + nf(v, d) + ' %';
const sign = v => v > 0.0001 ? 'up' : v < -0.0001 ? 'down' : '';

function mrd(v){
  if (v == null) return '–';
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
function datumZeit(s){
  const d = new Date(s);
  if (Number.isNaN(+d)) return String(s);
  return d.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit',year:'numeric'}) + ', ' +
         d.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'}) + ' Uhr';
}
const alterTage = s => Math.floor((Date.now() - new Date(s)) / 864e5);

const KOMPONENTE = {
  revision_momentum:   'Analystenrevisionen',
  growth_acceleration: 'Wachstumsbeschleunigung',
  margin_trend:        'Margentrend',
  fcf_trend:           'Cashflow-Trend',
  insider_cluster:     'Insiderkaeufe',
  dilution:            'Verwaesserung'
};
const GRUND = {
  mining_explorer:'Explorer ohne Produktion', no_revenue:'kein Umsatz', too_small:'zu klein',
  too_large:'zu gross', low_growth:'Wachstum zu schwach', low_margin:'Marge zu duenn',
  negative_fcf:'Cashflow negativ', illiquid:'zu wenig Handel', no_data:'keine Daten'
};
const FELD = {
  handel_zoelle:'Handel & Zoelle', geldpolitik:'Geldpolitik', energie:'Energie',
  finanzen_krypto:'Finanzen & Krypto', gesundheit:'Gesundheit', verteidigung:'Verteidigung',
  technologie:'Technologie', umwelt:'Umwelt', arbeitsmarkt:'Arbeitsmarkt', infrastruktur:'Infrastruktur'
};
const label = (map, k) => map[k] || String(k).replace(/_/g, ' ');

/* ─────────────── Zustand ─────────────── */
let D = null;                 // latest.json
let cohort = 'wachstum';
let policyField = '*';

const COHORTS = {
  wachstum:  {t:'Wachstum 1–20 Mrd', d:'dossiers',            r:'rejected',            s:'screened',
              note:'Der eigentliche Suchraum. Klein genug, dass eine Fehlbewertung noch existiert, gross genug, dass die Zahlen belastbar sind.'},
  gross:     {t:'Grosse Werte ab 20 Mrd', d:'dossiers_large_cap',  r:'rejected_large_cap',  s:'screened_large_cap',
              note:'Kontrollgruppe. Hier ist der Markt effizient, ein hoher Score heisst deshalb weniger als im kleinen Korb.'},
  fruehphase:{t:'Fruehphase 13F',         d:'dossiers_early_bets', r:'rejected_early_bets', s:'screened_early_bets',
              note:'Positionen ausgewaehlter Investoren aus den 13F-Meldungen. Die Meldung hinkt bis zu 45 Tage hinterher, das ist kein Echtzeitsignal.'}
};

/* ─────────────── Navigation ─────────────── */
const TABS = [
  ['lage',      'Lage',      '<circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16"/>'],
  ['screening', 'Screening', '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>'],
  ['archiv',    'Archiv',    '<path d="M4 8h16v11H4z"/><path d="M3 5h18v3H3zM10 12h4"/>'],
  ['umfeld',    'Umfeld',    '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 3 2.5 13 0 16M12 4c-2.5 3-2.5 13 0 16"/>'],
  ['depot',     'Depot',     '<path d="M3 8h18v11H3z"/><path d="M8 8V6a4 4 0 018 0v2"/>']
];

function buildTabs(){
  $('#tabbar').innerHTML = TABS.map(([id, txt, path], i) =>
    `<button data-go="${id}" class="${i === 0 ? 'on' : ''}" aria-label="${txt}">
       <svg viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">${path}</svg>
       <em>${txt}</em></button>`).join('');
  $$('#tabbar button').forEach(b => b.onclick = () => go(b.dataset.go));
}
function go(id){
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'v-' + id));
  $$('#tabbar button').forEach(b => b.classList.toggle('on', b.dataset.go === id));
  location.hash = id;
  window.scrollTo({top:0, behavior:'instant'});
}

/* ─────────────── Detail-Sheet ─────────────── */
function sheet(html){
  $('#sheet-body').innerHTML = html;
  $('#sheet').classList.add('on');
  document.body.style.overflow = 'hidden';
}
function closeSheet(){
  $('#sheet').classList.remove('on');
  document.body.style.overflow = '';
}

/* ═══════════════ LAGE ═══════════════ */
function renderLage(){
  const ts = D.track_summary || {};
  const gesamt = (D.kept || 0) + (D.kept_large_cap || 0) + (D.kept_early_bets || 0);
  $('#lage-big').textContent = gesamt;

  const tage = alterTage(D.generated_at);
  $('#stamp').innerHTML = `<span class="live">●</span> ${datum(D.generated_at)}` +
    (tage > 10 ? `<br><span class="down">${tage} Tage alt</span>` : '');

  $('#lage-tiles').innerHTML = [
    [(D.screened || 0) + (D.screened_large_cap || 0) + (D.screened_early_bets || 0), 'gescreent'],
    [D.kept || 0,                       'Dossiers klein'],
    [(D.policy_acts || []).length,      'Rechtsakte'],
    [(D.news_items  || []).length,      'Meldungen']
  ].map(([n, k]) => `<div class="tile"><div class="n">${n}</div><div class="k">${k}</div></div>`).join('');

  /* Einordnung: was bedeutet das, und was folgt daraus */
  const w = ts.weeks || 0, need = (ts.weeks_needed || 0) + w;
  let v;
  if (!ts.meaningful){
    v = `<div class="card warn">
      <h3 class="gold">Das Register sagt noch nichts</h3>
      <p>Erst ${w} von ${need || 12} Wochen erfasst. Jede Trefferquote unterhalb dieser Schwelle
      ist Rauschen, nicht Qualitaet. Bis dahin ist <b>nichts tun</b> das normale Ergebnis, kein Leerlauf.</p>
      <div class="bar" style="margin-top:12px"><i style="width:${Math.min(100, w / (need || 12) * 100)}%"></i></div>
    </div>`;
  } else {
    const me = ts.median_excess_pct;
    v = `<div class="card">
      <h3>Register belastbar ab jetzt</h3>
      <p>${w} Wochen, ${ts.entries} Picks. Median-Ueberrendite gegen ${esc(ts.benchmark_symbol)}:
      <b class="${sign(me)}">${pct(me)}</b>, Trefferquote ${nf(ts.hit_rate_pct, 0)} %.</p>
    </div>`;
  }
  v += `<div class="card">
    <h3>Kostenbremse</h3>
    <p>Bei 75 Euro Sparplan im Monat fressen Gebuehren und Spread schnell mehr, als eine gute
    Auswahl einbringt. Ein Pick lohnt sich nur, wenn er die Kosten des Umschichtens klar schlaegt.</p>
  </div>`;
  $('#lage-verdict').innerHTML = v;

  const top = [...(D.dossiers || [])].sort((a, b) => b.scorecard.total - a.scorecard.total).slice(0, 5);
  $('#lage-top').innerHTML = top.length ? top.map((d, i) => zeile(d, i)).join('')
    : '<p class="muted">Keine Kandidaten im letzten Lauf.</p>';
  bindRows($('#lage-top'), D.dossiers || []);

  $('#dispatch-link').href = `https://github.com/${CFG.repo}/actions/workflows/${CFG.workflow}`;
}

function zeile(d, i){
  const s = d.scorecard, c = d.candidate;
  return `<button class="row" data-sym="${esc(c.symbol)}">
    <span class="rank">${i + 1}</span>
    <span class="meta">
      <span class="sym">${esc(c.symbol)}</span>
      <span class="nm" style="display:block">${esc(c.name)} · ${mrd(c.market_cap)}</span>
      <span class="bar"><i style="width:${Math.max(2, Math.min(100, s.total))}%"></i></span>
    </span>
    <span class="score ${s.reliable ? '' : 'muted'}">${nf(s.total, 1)}</span>
    <span class="chev">›</span>
  </button>`;
}
function bindRows(root, pool){
  $$('.row', root).forEach(b => b.onclick = () => {
    const d = pool.find(x => x.candidate.symbol === b.dataset.sym);
    if (d) sheet(detail(d));
  });
}

function detail(d){
  const c = d.candidate, e = d.enrichment || {}, s = d.scorecard;
  const komp = (s.components || []).map(k => `
    <div style="padding:10px 0;border-bottom:1px solid rgba(29,155,240,.10)">
      <div style="display:flex;justify-content:space-between;font-size:13.5px">
        <span>${label(KOMPONENTE, k.name)} <span class="muted">${k.weight} %</span></span>
        <span class="mono">${nf(k.normalized, 0)}</span>
      </div>
      <div class="bar"><i style="width:${Math.max(2, Math.min(100, k.normalized))}%"></i></div>
    </div>`).join('');

  const rows = [
    ['Sektor', esc(c.sector)],
    ['Marktkapitalisierung', mrd(c.market_cap)],
    ['Umsatzwachstum', pct(c.revenue_growth)],
    ['Bruttomarge', pct(c.gross_margin)],
    ['Freier Cashflow', mrd(c.fcf)],
    ['ISIN', esc(c.isin)],
    ['Revisionen 30 Tage', `<span class="up">${e.up_revisions_30d ?? '–'}↑</span> / <span class="down">${e.down_revisions_30d ?? '–'}↓</span>`],
    ['Wachstum Quartal', `${nf(e.revenue_growth_prior_q)} → ${nf(e.revenue_growth_recent_q)} %`],
    ['Insider 90 Tage', `${e.insider_buyers_90d ?? '–'} kaufen / ${e.insider_sellers_90d ?? '–'} verkaufen`],
    ['Aktienzahl Jahr', pct(e.shares_growth_yoy, 2)],
    ['Leerverkauft', e.short_pct_float == null ? '–' : nf(e.short_pct_float) + ' %'],
    ['Institutionell', e.institutional_pct == null ? '–' : nf(e.institutional_pct) + ' %'],
    ['Naechste Zahlen', datum(e.next_earnings)]
  ].map(([k, v]) => `<div class="kv"><span>${k}</span><span>${v}</span></div>`).join('');

  const warn = s.reliable ? '' :
    `<div class="card warn" style="margin:12px 0"><p class="gold">Datenabdeckung nur
     ${nf(s.coverage, 0)} %. Der Score ist aus Luecken gerechnet und traegt nicht.</p></div>`;

  return `
    <div style="display:flex;align-items:flex-end;gap:12px;margin-bottom:4px">
      <div>
        <div class="sym" style="font-size:22px">${esc(c.symbol)}</div>
        <div class="nm">${esc(c.name)}</div>
      </div>
      <div style="margin-left:auto;text-align:right">
        <div class="mono" style="font-size:30px;font-weight:600">${nf(s.total, 1)}</div>
        <div class="k muted mono" style="font-size:9.5px;letter-spacing:.16em">SCORE</div>
      </div>
    </div>
    ${warn}
    <h2 class="sec">Woraus der Score entsteht</h2>${komp}
    <h2 class="sec">Kennzahlen</h2>${rows}
    <h2 class="sec">Extern</h2>
    <div class="kv"><span>SEC EDGAR</span><span><a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${esc(c.symbol)}&type=10-K" target="_blank" rel="noopener">Berichte ↗</a></span></div>
    <div class="kv"><span>Yahoo Finance</span><span><a href="https://finance.yahoo.com/quote/${esc(c.symbol)}" target="_blank" rel="noopener">Kurs ↗</a></span></div>
    <div style="height:8px"></div>
    <button class="btn ghost" style="width:100%" data-close>Schliessen</button>`;
}

/* ═══════════════ SCREENING ═══════════════ */
function renderScreening(){
  $('#cohort-chips').innerHTML = Object.entries(COHORTS).map(([k, v]) =>
    `<button class="chip ${k === cohort ? 'on' : ''}" data-c="${k}">${esc(v.t)}</button>`).join('');
  $$('#cohort-chips .chip').forEach(b => b.onclick = () => { cohort = b.dataset.c; renderScreening(); });

  const C = COHORTS[cohort];
  const list = [...(D[C.d] || [])].sort((a, b) => b.scorecard.total - a.scorecard.total);
  const rej  = D[C.r] || [];

  $('#cohort-note').innerHTML =
    `<p>${esc(C.note)}</p><div style="height:10px"></div>
     <div class="kv"><span>gescreent</span><span>${D[C.s] ?? '–'}</span></div>
     <div class="kv"><span>Dossiers</span><span>${list.length}</span></div>
     <div class="kv"><span>aussortiert</span><span>${rej.length}</span></div>`;

  $('#cohort-list').innerHTML = list.length
    ? list.map((d, i) => zeile(d, i)).join('')
    : '<p class="muted">Keine Kandidaten.</p>';
  bindRows($('#cohort-list'), list);

  const gruende = {};
  rej.forEach(r => (gruende[r.reason] = (gruende[r.reason] || 0) + 1));
  $('#cohort-rejected').innerHTML = Object.entries(gruende).sort((a, b) => b[1] - a[1])
    .map(([g, n]) => `<div class="kv"><span>${esc(label(GRUND, g))}</span><span>${n}</span></div>`).join('')
    || '<p class="muted">Nichts aussortiert.</p>';
}

/* ═══════════════ ARCHIV ═══════════════ */
function renderArchiv(){
  const ts = D.track_summary || {}, tr = D.track_record || [];
  $('#bm-name').textContent = ts.benchmark_symbol || 'IWO';
  const w = ts.weeks || 0, need = (ts.weeks_needed || 0) + w || 12;

  $('#arch-hero').innerHTML = `
    <div class="card ${ts.meaningful ? '' : 'warn'}">
      <div style="display:flex;align-items:flex-end;gap:16px">
        <div>
          <div class="mono ${sign(ts.median_excess_pct)}" style="font-size:38px;font-weight:600;line-height:1">
            ${pct(ts.median_excess_pct)}</div>
          <div class="k mono muted" style="font-size:9.5px;letter-spacing:.16em;margin-top:6px">
            MEDIAN-UEBERRENDITE</div>
        </div>
        <div style="margin-left:auto;text-align:right">
          <div class="mono" style="font-size:20px">${nf(ts.hit_rate_pct, 0)} %</div>
          <div class="k mono muted" style="font-size:9.5px;letter-spacing:.16em">TREFFERQUOTE</div>
        </div>
      </div>
      <div style="height:14px"></div>
      <div class="kv"><span>Picks eingefroren</span><span>${ts.entries ?? 0}</span></div>
      <div class="kv"><span>davon ueber Benchmark</span><span>${ts.beat_benchmark ?? 0}</span></div>
      <div class="kv"><span>Median absolut</span><span class="${sign(ts.median_return_pct)}">${pct(ts.median_return_pct)}</span></div>
      <div class="kv"><span>Vergleich</span><span>${esc(ts.benchmark_name || 'IWO')}</span></div>
      <div style="height:12px"></div>
      <div class="bar"><i style="width:${Math.min(100, w / need * 100)}%"></i></div>
      <p style="margin-top:8px" class="${ts.meaningful ? 'muted' : 'gold'}">
        ${w} von ${need} Kalenderwochen.
        ${ts.meaningful ? 'Die Zahlen tragen.' : 'Darunter ist alles oben Rauschen.'}</p>
    </div>`;

  const sorted = [...tr].sort((a, b) => (b.excess_pct ?? 0) - (a.excess_pct ?? 0));
  $('#arch-list').innerHTML = sorted.length ? sorted.map(e => `
    <div class="row">
      <span class="rank">${e.rank}</span>
      <span class="meta">
        <span class="sym">${esc(e.symbol)}</span>
        <span class="nm" style="display:block">${datum(e.date)} · Einstand ${nf(e.price_at_entry, 2)}</span>
      </span>
      <span style="text-align:right;flex:none">
        <span class="mono ${sign(e.excess_pct)}" style="font-size:15px;font-weight:600">${pct(e.excess_pct)}</span>
        <span class="muted mono" style="display:block;font-size:10.5px">abs ${pct(e.return_pct)}</span>
      </span>
    </div>`).join('') : '<p class="muted">Noch nichts eingefroren.</p>';
}

/* ═══════════════ UMFELD ═══════════════ */
function renderUmfeld(){
  const acts = D.policy_acts || [];
  const felder = [...new Set(acts.flatMap(a => a.fields || []))].sort();
  $('#policy-chips').innerHTML =
    `<button class="chip ${policyField === '*' ? 'on' : ''}" data-f="*">Alle ${acts.length}</button>` +
    felder.map(f => `<button class="chip ${policyField === f ? 'on' : ''}" data-f="${esc(f)}">${esc(label(FELD, f))}</button>`).join('');
  $$('#policy-chips .chip').forEach(b => b.onclick = () => { policyField = b.dataset.f; renderUmfeld(); });

  const shown = policyField === '*' ? acts : acts.filter(a => (a.fields || []).includes(policyField));
  $('#policy-list').innerHTML = shown.length ? shown
    .sort((a, b) => (b.publication_date || '').localeCompare(a.publication_date || ''))
    .slice(0, 40).map(a => `
      <div class="row" style="align-items:flex-start">
        <span class="meta">
          <a href="${esc(a.url)}" target="_blank" rel="noopener" style="font-size:13.5px;line-height:1.4">${esc(a.title)}</a>
          <span class="nm" style="display:block;margin-top:5px;white-space:normal">
            ${datum(a.publication_date)}
            ${(a.sectors || []).length ? ' · ' + esc((a.sectors || []).join(', ')) : ''}
            ${(a.countries || []).length ? ' · ' + esc((a.countries || []).join(', ')) : ''}
          </span>
        </span>
      </div>`).join('') : '<p class="muted">Nichts in diesem Feld.</p>';

  const news = D.news_items || [];
  const QUELLE = {fed:'Fed', ecb:'EZB', bls_latest:'BLS', bls:'BLS'};
  $('#news-list').innerHTML = news.length ? news.slice(0, 30).map(n => `
    <div class="row" style="align-items:flex-start">
      <span class="meta">
        <a href="${esc(n.url)}" target="_blank" rel="noopener" style="font-size:13.5px;line-height:1.4">${esc(n.title)}</a>
        <span class="nm" style="display:block;margin-top:5px">
          <span class="acc mono">${esc(QUELLE[n.source] || n.source)}</span> · ${datum(n.published)}</span>
      </span>
    </div>`).join('') : '<p class="muted">Keine Meldungen abrufbar.</p>';

  const cal = D.calendar_events || [];
  $('#cal-list').innerHTML = cal.length ? cal.map(c => `
    <div class="kv"><span>${esc(c.title)}</span><span>${datum(c.start)}</span></div>`).join('')
    : '<p class="muted">Kalender nicht erreichbar.</p>';
}

/* ═══════════════ DEPOT ═══════════════ */
const b64 = {
  dec: s => Uint8Array.from(atob(s), c => c.charCodeAt(0))
};
async function schluessel(pw, salt, iter){
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {name:'PBKDF2', salt, iterations:iter, hash:'SHA-256'},
    raw, {name:'AES-GCM', length:256}, false, ['decrypt']);
}

function depotLock(){
  $('#depot-body').innerHTML = `
    <div class="lock">
      <div style="font-size:38px;line-height:1">\u{1F512}</div>
      <h3 style="margin:14px 0 4px">Depot verschlossen</h3>
      <p class="muted" style="max-width:340px;margin:0 auto">Dein Bestand liegt auf dieser
      oeffentlichen Seite nur als AES-GCM-Block. Ohne Passwort ist er Zeichensalat, auch fuer
      denjenigen, der den Link weitergereicht bekommt.</p>
      <form id="unlock">
        <input type="password" id="pw" placeholder="Passwort" autocomplete="current-password" inputmode="text">
        <div><button class="btn" type="submit">Entsperren</button></div>
        <div class="err" id="lockerr"></div>
      </form>
    </div>`;
  $('#unlock').onsubmit = async ev => {
    ev.preventDefault();
    const err = $('#lockerr'); err.textContent = '';
    try {
      const box = await (await fetch(CFG.depot, {cache:'no-store'})).json();
      const key = await schluessel($('#pw').value, b64.dec(box.salt), box.iter || 210000);
      const klar = await crypto.subtle.decrypt({name:'AES-GCM', iv:b64.dec(box.iv)}, key, b64.dec(box.ct));
      depotZeigen(JSON.parse(new TextDecoder().decode(klar)));
    } catch (e) {
      err.textContent = e instanceof SyntaxError || String(e).includes('JSON')
        ? 'Kein verschluesseltes Depot hinterlegt.' : 'Passwort passt nicht.';
    }
  };
}

function depotZeigen(dp){
  const h = dp.holdings || [], p = dp.plan || {};
  const summe = h.reduce((a, x) => a + (x.value ?? 0), 0);
  const aktien = h.filter(x => x.kind === 'aktie'), etfs = h.filter(x => x.kind === 'etf');
  const anteil = arr => arr.reduce((a, x) => a + (x.weight || 0), 0);

  const liste = arr => arr.sort((a, b) => (b.weight || 0) - (a.weight || 0)).map(x => `
    <div class="row">
      <span class="meta">
        <span class="sym">${esc(x.symbol || x.name)}</span>
        ${x.symbol ? `<span class="nm" style="display:block">${esc(x.name)}</span>` : ''}
        <span class="bar"><i style="width:${Math.min(100, (x.weight || 0) * 3)}%"></i></span>
      </span>
      <span class="score">${nf(x.weight, 1)} %</span>
    </div>`).join('');

  $('#depot-body').innerHTML = `
    <h2 class="sec">Bestand</h2>
    <div class="card">
      <div class="kv"><span>Positionen</span><span>${h.length}</span></div>
      ${summe ? `<div class="kv"><span>Wert</span><span>${nf(summe, 2)} €</span></div>` : ''}
      <div class="kv"><span>Einzelaktien</span><span>${nf(anteil(aktien), 1)} %</span></div>
      <div class="kv"><span>ETF</span><span>${nf(anteil(etfs), 1)} %</span></div>
    </div>
    ${aktien.length ? `<h2 class="sec">Aktien</h2><div class="card">${liste(aktien)}</div>` : ''}
    ${etfs.length   ? `<h2 class="sec">ETF</h2><div class="card">${liste(etfs)}</div>` : ''}
    ${(p.positions || p.items || []).length ? `<h2 class="sec">Sparplan</h2><div class="card">
      ${(p.positions || p.items).map(x => `<div class="kv"><span>${esc(x.name || x.symbol)}</span>
        <span>${x.amount != null ? nf(x.amount, 2) + ' €' : nf(x.weight, 1) + ' %'}</span></div>`).join('')}
      ${p.monthly != null ? `<div class="kv"><span>Summe im Monat</span><span>${nf(p.monthly, 2)} €</span></div>` : ''}
    </div>` : ''}
    <div class="card warn">
      <h3 class="gold">Klumpen pruefen</h3>
      <p>Einzelaktien machen ${nf(anteil(aktien), 1)} % aus. Alles, was im Screening oben
      auftaucht und hier schon liegt, erhoeht das Klumpenrisiko statt es zu streuen.</p>
    </div>
    <div class="center" style="margin:18px 0">
      <button class="btn ghost" onclick="location.reload()">Wieder verschliessen</button>
    </div>`;
}

/* ═══════════════ Start ═══════════════ */
async function start(){
  buildTabs();
  $('#sheet').addEventListener('click', e => { if (e.target.closest('[data-close]')) closeSheet(); });
  document.addEventListener('click', e => { if (e.target.matches('[data-close]')) closeSheet(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

  try {
    const r = await fetch(CFG.data, {cache:'no-store'});
    if (!r.ok) throw new Error(r.status);
    D = await r.json();
  } catch (e) {
    $('#lage-verdict').innerHTML =
      `<div class="card warn"><h3 class="gold">Keine Daten geladen</h3>
       <p>${esc(CFG.data)} nicht erreichbar (${esc(e.message)}). Die Seite ist da, das Register nicht.</p></div>`;
    return;
  }

  renderLage(); renderScreening(); renderArchiv(); renderUmfeld(); depotLock();

  const h = location.hash.slice(1);
  if (TABS.some(t => t[0] === h)) go(h);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
start();

})();
