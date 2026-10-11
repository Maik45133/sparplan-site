/* Sparplan. Drei Bereiche: Kaufen, Depot, Archiv.
   Liest data/app.json (öffentlich, sonntags neu) und data/depot_live.enc
   (verschlüsselt, entsperrt nur auf deinem Gerät). Kein Server, kein Tracking. */
'use strict';

const REPO = 'Maik45133/sparplan-site';
const $ = s => document.querySelector(s);
let APP = null, DEPOT = null, tab = 'kaufen', run = 0, last = null, gid = 0;
const AUF = new Set(); // aufgeklappte Listen (Größen, Trump)

/* ───────── Formate ───────── */
const nf = (n, d = 2) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const eur = (n, d = 2) => nf(n, d) + '\u00a0€';
const usd = n => nf(n) + '\u00a0$';
const sp = (n, d = 1) => n == null ? 'offen' : (n > 0 ? '+' : n < 0 ? '−' : '±') + nf(Math.abs(n), d) + '\u00a0%';
const MON = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const kurzDatum = iso => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.` : '';
const datum = iso => { if (!iso) return ''; const [, m, d] = iso.split('-'); return `${+d}. ${MON[+m - 1]}`; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ini = s => String(s).replace(/\.(DE|HK)$/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
const KORB = { klein: 'Wachstum', gross: 'Groß', frueh: '13F' };
function tageBis(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T12:00:00'), h = new Date(); h.setHours(12, 0, 0, 0);
  return Math.round((d - h) / 864e5);
}
function kalenderwoche() {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const w1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - w1) / 864e5 - 3 + (w1.getDay() + 6) % 7) / 7);
}
const veraenderung = s => s && s.length > 1 ? (s[s.length - 1][1] / s[0][1] - 1) * 100 : null;

/* ───────── Speicher am Gerät ───────── */
const lokal = {
  get(k, f) { try { return JSON.parse(localStorage.getItem(k)) ?? f; } catch (e) { return f; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* privat */ } }
};
const IDB = {
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('sparplan', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('k');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  },
  async run(mode, fn) {
    try {
      const db = await this.open();
      return await new Promise(res => {
        const t = db.transaction('k', mode), st = t.objectStore('k'), q = fn(st);
        t.oncomplete = () => res(q && q.result); t.onerror = () => res(null); t.onabort = () => res(null);
      });
    } catch (e) { return null; }
  },
  get(k) { return this.run('readonly', s => s.get(k)); },
  set(k, v) { return this.run('readwrite', s => s.put(v, k)); },
  clear() { return this.run('readwrite', s => s.clear()); }
};

/* ───────── Depot entschlüsseln ─────────
   Gleiches Salz in depot.enc und depot_live.enc. Der abgeleitete Schlüssel
   wird nicht exportierbar auf diesem Gerät gespeichert, das Passwort nie. */
const b64dec = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function depotBox() {
  for (const f of ['data/depot_live.enc', 'data/depot.enc']) {
    try { const r = await fetch(f, { cache: 'no-cache' }); if (r.ok) return await r.json(); } catch (e) { /* weiter */ }
  }
  return null;
}
async function ableiten(pw, salt, iter) {
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, raw,
    { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
}
async function oeffnen(box, key) {
  const klar = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64dec(box.iv) }, key, b64dec(box.ct));
  return JSON.parse(new TextDecoder().decode(klar));
}
function normalisieren(d) {
  if (d.positionen && d.positionen.length && 'wert' in d.positionen[0]) return d;
  if (d.version === 2) {
    const ps = d.positionen.map(p => ({
      k: p.symbol, name: p.name, art: p.art, isin: p.isin,
      ex: p.symbol.endsWith('.DE') ? 'XETRA' : p.symbol.endsWith('.HK') ? 'HK' : 'US',
      wert: p.wert_eur, einstand: p.wert_eur - p.gewinn_eur, gewinn: p.gewinn_eur,
      pct: p.gewinn_eur / (p.wert_eur - p.gewinn_eur) * 100, t3m: null, vomHoch: null, zahlen: null, serie: []
    }));
    const w = ps.reduce((a, p) => a + p.wert, 0), e = ps.reduce((a, p) => a + p.einstand, 0);
    ps.forEach(p => p.gewicht = p.wert / w * 100);
    return { statisch: true, bestand_stand: d.stand, kurse_stand: d.stand, wert: w, einstand: e, gewinn: w - e,
      seitKauf: (w / e - 1) * 100, serie: [], positionen: ps.sort((a, b) => b.wert - a.wert) };
  }
  return { alt: true, positionen: [] };
}
async function depotAuto() {
  const box = await depotBox(); if (!box || !window.crypto || !crypto.subtle) return;
  const key = await IDB.get('key:' + box.salt); if (!key) return;
  try { DEPOT = normalisieren(await oeffnen(box, key)); } catch (e) { await IDB.clear(); }
}
async function depotEntsperren(pw) {
  const box = await depotBox(); if (!box) throw new Error('fehlt');
  const key = await ableiten(pw, b64dec(box.salt), box.iter || 210000);
  DEPOT = normalisieren(await oeffnen(box, key));
  await IDB.set('key:' + box.salt, key);
}

/* ───────── Depot verstehen ───────── */
// Gewichte der Einzelwerte in den Fonds, Stand Sommer 2026, aus den Factsheets.
const ETF_GEWICHTE = [['Information Tech', { AAPL: 20.12, NVDA: 19.82, MSFT: 14.16 }],
  ['NASDAQ', { AAPL: 8.16, NVDA: 7.87, MSFT: 5.58, GOOGL: 6.27, TSLA: 3.0 }],
  ['MSCI World', { AAPL: 5.48, NVDA: 5.04, MSFT: 3.56, GOOGL: 3.91, TSLA: 1.28 }],
  ['EM IMI', { TSM: 13.04, '1810.HK': 0.44 }],
  ['S&P 500', { AAPL: 7.65, NVDA: 7.38, MSFT: 5.23, GOOGL: 5.52, TSLA: 1.42 }]];
const TECH_ETF = [['Information Tech', 1], ['NASDAQ', .6], ['MSCI World', .35], ['EM IMI', .3], ['S&P 500', .45]];
const TECH_AKTIE = { NVDA: 1, MSFT: 1, AAPL: 1, TSM: 1, GOOGL: 1, '1810.HK': 1, AMD: 1 };
const fonds = (name, tab) => { for (const [k, v] of tab) if ((name || '').includes(k)) return v; return null; };
const imDepot = sym => DEPOT && DEPOT.positionen.find(p => p.k === sym);
function durchschau(sym) {
  if (!DEPOT) return null;
  return DEPOT.positionen.reduce((s, p) => {
    if (p.art === 'ETF') { const g = fonds(p.name, ETF_GEWICHTE); return s + (g && g[sym] ? p.gewicht * g[sym] / 100 : 0); }
    return s + (p.k === sym ? p.gewicht : 0);
  }, 0);
}
function techAnteil() {
  if (!DEPOT) return null;
  return DEPOT.positionen.reduce((s, p) => s + p.gewicht * (p.art === 'ETF' ? (fonds(p.name, TECH_ETF) || 0) : (TECH_AKTIE[p.k] || 0)), 0);
}

/* ───────── Handelszeiten in deutscher Zeit ─────────
   Über die echten Zeitzonen gerechnet, damit die Wochen mit versetzter
   Zeitumstellung (Ende Oktober, Mitte März) stimmen. Feiertage fehlen. */
const inTz = (d, tz) => new Date(d.toLocaleString('en-US', { timeZone: tz }));
const hm = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
const versatz = (t, tz) => Math.round((inTz(t, 'Europe/Berlin') - inTz(t, tz)) / 36e5);
function handelstag() {
  const now = new Date(), b = inTz(now, 'Europe/Berlin'), mins = b.getHours() * 60 + b.getMinutes();
  const usFor = k => { const v = versatz(new Date(now.getTime() + k * 864e5), 'America/New_York'); return [570 + v * 60, 960 + v * 60]; };
  let add = 0, [uo, uc] = usFor(0), wd = b.getDay();
  while (wd === 0 || wd === 6 || (add === 0 && mins >= uc)) { add++; wd = (b.getDay() + add) % 7; [uo, uc] = usFor(add); }
  const live = add === 0, tag = new Date(b.getTime() + add * 864e5).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
  const best = [uo + 15, 1050];
  let titel, unter;
  if (!live) { titel = `${b.getDay() === 0 || b.getDay() === 6 ? 'Wochenende' : 'Börsen geschlossen'}. Nächster Handel ${tag}.`; unter = `US-Börse ${hm(uo)} bis ${hm(uc)} Uhr, Xetra 9:00 bis 17:30 Uhr.`; }
  else if (mins < 540) { titel = 'Vor Börsenstart.'; unter = `Xetra öffnet um 9:00, die US-Börse um ${hm(uo)} Uhr.`; }
  else if (mins < uo) { titel = 'Xetra ist offen.'; unter = `US-Börse öffnet um ${hm(uo)} Uhr. Gut für ETFs.`; }
  else if (mins < best[0]) { titel = 'US-Börse gerade eröffnet.'; unter = `Erste Viertelstunde abwarten, ab ${hm(best[0])} Uhr.`; }
  else if (mins < best[1]) { titel = 'Beste Zeit für US-Aktien.'; unter = 'Xetra und US-Börse gleichzeitig offen.'; }
  else { titel = 'US-Börse offen.'; unter = `Bis ${hm(uc)} Uhr. Limit-Order nutzen.`; }
  return { live, mins, uo, uc, best, titel, unter };
}
function timeline(h) {
  const A = 480, B = 1350, p = m => ((m - A) / (B - A) * 100).toFixed(2) + '%', w = (a, c) => ((c - a) / (B - A) * 100).toFixed(2) + '%';
  return `<div class="tl" role="img" aria-label="Xetra 9:00 bis 17:30, US-Börse ${hm(h.uo)} bis ${hm(h.uc)}, beste Zeit ${hm(h.best[0])} bis ${hm(h.best[1])}"><span class="x" style="left:${p(540)};width:${w(540, 1050)}"></span><span class="u" style="left:${p(h.uo)};width:${w(h.uo, h.uc)}"></span><span class="b" style="left:${p(h.best[0])};width:${w(h.best[0], h.best[1])}"></span>${h.live && h.mins >= A && h.mins <= B ? `<span class="now" style="left:${p(h.mins)}"></span>` : ''}</div>
  <div class="tlab num" aria-hidden="true"><span style="left:${p(540)}">9:00</span><span style="left:${p(h.uo)}">${hm(h.uo)}</span><span style="left:${p(1050)}">17:30</span><span style="left:${p(h.uc)}">${hm(h.uc)}</span></div>
  <div class="legend"><span><i style="background:rgba(108,208,208,.6)"></i>Xetra</span><span><i style="background:rgba(158,202,255,.6)"></i>US-Börse</span><span><i style="background:var(--primary)"></i>Beste Zeit ${hm(h.best[0])} bis ${hm(h.best[1])}</span></div>`;
}
function zeitfenster(ex, art = 'kauf') {
  const verb = art === 'kauf' ? 'Kaufen' : 'Verkaufen';
  if (ex === 'XETRA') return `${verb} zwischen 9:15 und 17:30 Uhr, wenn Xetra offen ist.${art === 'kauf' ? ' Für ETFs ist der Sparplan günstiger, er kostet keine Gebühr.' : ''}`;
  if (ex === 'HK') { const v = versatz(new Date(), 'Asia/Hong_Kong'); return `${verb} zwischen ${hm(570 + v * 60)} und ${hm(960 + v * 60)} Uhr deutscher Zeit, wenn Hongkong offen ist. Dann ist der Spread an den deutschen Handelsplätzen am engsten.`; }
  const h = handelstag();
  return `${verb} zwischen ${hm(h.best[0])} und ${hm(h.uc)} Uhr deutscher Zeit, wenn die US-Börse offen ist. Am besten bis 17:30, solange auch Xetra handelt. Limit-Order nutzen.`;
}

/* ───────── Bewertung ───────── */
function signal(x) {
  const t = tageBis(x.zahlenISO);
  if (imDepot(x.sym)) return ['Im Depot', 'neutral'];
  if (x.handel !== 'ja') return ['Prüfen', 'check'];
  if (t !== null && t >= 0 && t <= 14) return ['Nach den Zahlen', 'wait'];
  if ((x.spread && x.spread > 2) || (x.con || []).some(c => c.includes('Basiseffekt'))) return ['Vorsicht', 'check'];
  return ['Kaufbar', 'up'];
}
function dagegen(x) {
  const w = [], t = tageBis(x.zahlenISO), tech = techAnteil();
  if (imDepot(x.sym)) w.push(`Schon im Depot, durch die ETFs gerechnet rund ${nf(durchschau(x.sym), 0)} %`);
  if (x.handel === 'nein') w.push('Nicht an LS Exchange gefunden. In der Trade-Republic-App per ISIN suchen, eventuell nur per Direktpreis in New York (2 €)');
  if (x.handel == null) w.push('Handelbarkeit nicht geprüft. In der Trade-Republic-App per ISIN suchen');
  if (t !== null && t >= 0 && t <= 14) w.push(`Zahlen am ${x.zahlen}: Kurs kann stark springen, besser danach kaufen`);
  w.push(...(x.con || []));
  if (x.spread && x.spread > 2) w.push(`Spread zuletzt ${nf(x.spread, 1)} %, Kauf und Verkauf kosten viel`);
  if (x.vomHoch != null && x.vomHoch <= -30) w.push(`${nf(Math.abs(x.vomHoch), 0)} % unter dem Jahreshoch`);
  if (x.tech && tech != null && tech > 50 && !imDepot(x.sym)) w.push(`Noch mehr Tech: dein Depot ist schon zu rund ${nf(tech, 0)} % Technologie`);
  return w;
}
function datenlage(p) {
  if (p.art === 'ETF') return { label: 'Kern', ton: 'neutral', text: `Breiter ETF. Hier zählt der Anteil am Depot, nicht die einzelne Woche.${p.sparplan ? ` Läuft im Sparplan mit ${eur(p.sparplan, 0)} im Monat.` : ''}` };
  const g = [];
  if (p.t3m != null) g.push(`3 Monate: ${sp(p.t3m)}`);
  if (p.vomHoch != null) g.push(`Vom Jahreshoch: ${sp(p.vomHoch)}`);
  if (p.zahlen) g.push(`Nächste Zahlen: ${p.zahlen}`);
  if (p.t3m == null) return { label: 'Ohne Kurse', ton: 'neutral', gruende: g, text: 'Für diese Position liegen noch keine Kurse vor.' };
  let label = 'Gemischt', ton = 'wait';
  if (p.t3m > 5 && p.vomHoch > -10) { label = 'Rückenwind'; ton = 'up'; }
  else if (p.t3m < -5 || p.vomHoch < -25) { label = 'Gegenwind'; ton = 'down'; }
  return { label, ton, gruende: g };
}
function verkaufText(p, anteil) {
  const erloes = p.wert * anteil, gewinn = p.gewinn * anteil;
  const steuer = gewinn > 1000 ? (gewinn - 1000) * 0.26375 : 0;
  if (gewinn >= 0) return `Du bekommst rund ${eur(erloes, 0)}. Darin stecken ${eur(gewinn, 0)} Gewinn. ${steuer > 0 ? `Über dem Sparer-Pauschbetrag von 1.000 € fallen rund ${eur(steuer, 0)} Steuer an.` : 'Das passt in den Sparer-Pauschbetrag von 1.000 €, sofern er noch frei ist. Zinsen zählen mit.'} Dazu 1 € Gebühr.`;
  return `Du bekommst rund ${eur(erloes, 0)}. Darin stecken ${eur(Math.abs(gewinn), 0)} Verlust. Den kannst du mit Aktiengewinnen im selben Jahr verrechnen, zum Beispiel mit einem Teilverkauf von NVIDIA oder Microsoft.`;
}
const heuteKaufen = p => p.pct >= 0 ? '' : `Ehrliche Frage: Würdest du ${esc(p.name)} heute für ${eur(p.wert, 0)} neu kaufen? Wenn ja, halten. Wenn nein, ist Halten nur die Hoffnung, den Einstand zurückzubekommen. Der Einstand ist für die Zukunft egal.`;
const alleKandidaten = () => APP ? APP.groessen.flatMap(g => (APP.tiers[g.key] || []).map(x => ({ ...x, groesse: g.key }))) : [];
const findeKandidat = sym => alleKandidaten().find(x => x.sym === sym);
function termine() {
  const t = [];
  alleKandidaten().forEach(x => { if (x.zahlenISO && x.rang <= 3 && !imDepot(x.sym)) t.push({ name: x.name, sym: x.sym, iso: x.zahlenISO, zahlen: x.zahlen, depot: false }); });
  if (DEPOT) DEPOT.positionen.forEach(p => { if (p.zahlenISO) t.push({ name: p.name, sym: p.k, iso: p.zahlenISO, zahlen: p.zahlen, depot: true }); });
  return t.filter(x => tageBis(x.iso) >= 0 && tageBis(x.iso) <= 45).sort((a, b) => a.iso.localeCompare(b.iso));
}
function hinsehen() {
  if (!DEPOT) return [];
  return DEPOT.positionen.map((p, i) => ({ ...p, i })).filter(p => p.art !== 'ETF' && (p.pct >= 40 || p.pct <= -30 || (tageBis(p.zahlenISO) !== null && tageBis(p.zahlenISO) >= 0 && tageBis(p.zahlenISO) <= 14)))
    .map(p => ({ ...p, warum: tageBis(p.zahlenISO) !== null && tageBis(p.zahlenISO) >= 0 && tageBis(p.zahlenISO) <= 14 ? `Zahlen am ${p.zahlen}` : datenlage(p).label }));
}

/* ───────── Gekauft ───────── */
const ausstehend = () => lokal.get('sparplan-ausstehend', {});
function gekauftOffen(sym) { return APP && (APP.gekauft || []).find(g => g.sym === sym && g.status === 'offen'); }
function issueLink(sym, verkauft) {
  return `https://github.com/${REPO}/issues/new?template=gekauft.yml&title=${encodeURIComponent(verkauft ? sym + ' verkauft' : sym)}`;
}
function vormerken(sym, art) { const a = ausstehend(); a[sym] = { art, am: new Date().toISOString().slice(0, 10) }; lokal.set('sparplan-ausstehend', a); }
function aufraeumen() {
  const a = ausstehend(); let geaendert = false;
  for (const [sym, v] of Object.entries(a)) {
    const da = (APP.gekauft || []).some(g => g.sym === sym && (v.art === 'kauf' ? g.status === 'offen' : g.status === 'verkauft'));
    if (da || tageBis(v.am) < -7) { delete a[sym]; geaendert = true; }
  }
  if (geaendert) lokal.set('sparplan-ausstehend', a);
}

/* ───────── Grafik ───────── */
function sparkPath(s, w, h, pad = 3) {
  const v = s.map(p => p[1]), mn = Math.min(...v), mx = Math.max(...v);
  return v.map((y, i) => [i * (w / (v.length - 1)), h - pad - ((y - mn) / ((mx - mn) || 1)) * (h - 2 * pad)]);
}
function spark(s) {
  if (!s || s.length < 2) return '<span></span>';
  const c = veraenderung(s) >= 0 ? 'var(--up)' : 'var(--down)';
  return `<svg class="sp" viewBox="0 0 56 26" aria-hidden="true"><polyline fill="none" stroke="${c}" stroke-width="1.7" stroke-linejoin="round" points="${sparkPath(s, 56, 26).map(p => p.map(n => n.toFixed(1)).join(',')).join(' ')}"/></svg>`;
}
function chart(s, fmt = v => nf(v)) {
  if (!s || s.length < 2) return '';
  const W = 340, H = 180, R = 54, T = 10, Bm = 22, v = s.map(p => p[1]), mn = Math.min(...v), mx = Math.max(...v);
  const x = i => i * ((W - R) / (v.length - 1)), y = a => T + (1 - (a - mn) / ((mx - mn) || 1)) * (H - T - Bm);
  const c = v[v.length - 1] >= v[0] ? 'var(--up)' : 'var(--down)', id = 'g' + (++gid);
  const line = v.map((a, i) => `${x(i).toFixed(1)},${y(a).toFixed(1)}`).join(' ');
  const grid = [mx, (mn + mx) / 2, mn].map(g => `<line x1="0" x2="${W - R}" y1="${y(g)}" y2="${y(g)}" stroke="var(--sc-highest)" stroke-dasharray="3 4"/><text x="${W}" y="${y(g) + 4}" fill="var(--on-var)" font-size="11" text-anchor="end">${fmt(g)}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Verlauf von ${s[0][0]} bis ${s[s.length - 1][0]}"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${c};stop-opacity:.32"/><stop offset="1" style="stop-color:${c};stop-opacity:0"/></linearGradient></defs>${grid}<polygon points="0,${H - Bm} ${line} ${x(v.length - 1)},${H - Bm}" fill="url(#${id})"/><polyline points="${line}" fill="none" stroke="${c}" stroke-width="2.4" stroke-linejoin="round"/><circle cx="${x(v.length - 1)}" cy="${y(v[v.length - 1])}" r="4" fill="${c}"/><text x="0" y="${H - 4}" fill="var(--on-var)" font-size="11">${s[0][0]}</text><text x="${W - R}" y="${H - 4}" fill="var(--on-var)" font-size="11" text-anchor="end">${s[s.length - 1][0]}</text></svg>`;
}
const chip = (l, t) => `<span class="chip c-${t}">${l}</span>`;
const profil = sym => (APP && APP.profile || {})[sym] || null;
function profilBox(sym, en) {
  const p = profil(sym);
  if (p) return `<div class="box"><h3>Was die machen</h3><p>${esc(p.was)}</p></div>`;
  if (en) return `<div class="box"><h3>Was die machen</h3><p lang="en">${esc(en)}</p><p class="t2" style="margin-top:6px;font-size:13px">Kurzbeschreibung von Yahoo, noch ohne deutsche Fassung.</p></div>`;
  return '';
}
const mehrKnopf = (key, n, sichtbar) => n > sichtbar || AUF.has(key) ? `<button class="mehr" data-mehr="${key}" aria-expanded="${AUF.has(key)}">${AUF.has(key) ? 'Weniger anzeigen' : `Alle ${n} anzeigen`}</button>` : '';
const tape = () => APP && APP.indizes ? `<div class="tape num" aria-label="Indizes, Schluss vom ${datum(APP.kurse_stand)}">${APP.indizes.map(i => `<span><b>${esc(i.name)}</b><span class="v">${nf(i.wert, i.d)}</span><span class="c ${i.chg >= 0 ? 'up' : 'down'}">${sp(i.chg, 2)}</span></span>`).join('')}</div>` : '';

/* ───────── Kaufen ───────── */
function kaufen() {
  const h = handelstag(), T = termine(), a = ausstehend();
  return `${tape()}<div class="display">Kaufen</div><p class="lead">Woche ${kalenderwoche()}, Top 3 je Größe aus dem Lauf vom ${datum(APP.lauf)}, aufklappbar bis 10. Gedacht zum Halten über 3 bis 12 Monate.</p>
  <div class="card pri"><div class="status">${h.titel}<small>${h.unter}</small></div>${timeline(h)}</div>
  ${T.length ? `<h2>Quartalszahlen<small>nächste 45 Tage</small></h2><div class="carousel">${T.map(t => `<button class="mini ${t.depot ? 'dep' : ''}" ${t.depot ? `data-pos="${esc(t.sym)}"` : `data-k="${esc(t.sym)}"`}><div class="d num">${t.zahlen}</div><div class="n">${esc(t.name)}</div><div class="q">${t.depot ? 'im Depot' : 'Vorschlag'}</div></button>`).join('')}</div>` : ''}
  ${APP.groessen.map(g => { const A = APP.tiers[g.key] || [], L = AUF.has(g.key) ? A : A.slice(0, 3); return `<h2>${g.titel}<small>${g.spanne}</small></h2>${L.length ? `<div class="group">${L.map(x => { const [l, t] = signal(x), ch = veraenderung(x.serie); return `<button class="item" data-k="${esc(x.sym)}"><span class="tk">${ini(x.sym)}</span><span style="min-width:0"><div class="t1">${x.rang > 3 ? `<span class="rg num">${x.rang}</span>` : ''}${esc(x.name)}</div>${chip(l, t)}${gekauftOffen(x.sym) ? chip('Gekauft', 'got') : a[x.sym] ? chip('Wird eingetragen', 'neutral') : ''}${x.ziel && x.ziel.pct != null ? `<span class="zl num ${x.ziel.pct >= 0 ? 'up' : 'down'}">Ziel ${sp(x.ziel.pct, 0)}</span>` : ''}</span>${spark(x.serie)}<span class="rt"><div class="v1 num">${x.kursEUR != null ? eur(x.kursEUR) : ''}</div><div class="v2 num ${ch >= 0 ? 'up' : 'down'}">${ch != null ? sp(ch) : ''}</div></span></button>`; }).join('')}</div>${mehrKnopf(g.key, A.length, 3)}` : '<p class="empty">Diese Woche kein brauchbarer Kandidat.</p>'}`; }).join('')}
  <p class="fine">Prozent: Kursveränderung der letzten drei Monate. Kurse vom ${datum(APP.kurse_stand)}, Daten vom ${datum(APP.erstellt.slice(0, 10))}. Feiertage sind im Handelsfenster nicht berücksichtigt. Die Rangfolge ist ein Datenfilter und noch nicht belegt. Keine Anlageberatung.</p>`;
}

/* ───────── Depot ───────── */
const FARBEN = ['#8ab4ff', '#c0a8ff', '#6cd0d0', '#f0c36d', '#f5a3c0', '#9aa7bb', '#4a5160'];
const KURZ = { 'S&P 500 Information Tech': 'Tech-ETF', 'Core MSCI World': 'World', 'Core S&P 500': 'S&P 500', 'Core MSCI EM IMI': 'Schwellenl.' };
function depotGesperrt() {
  return `${tape()}<div class="display">Depot</div><p class="lead">Dein Bestand liegt hier nur verschlüsselt.</p>
  <div class="card lock"><div class="status">Depot entsperren<small>Einmal pro Gerät. Danach merkt sich dieses Gerät den Schlüssel, nicht das Passwort.</small></div>
  <form id="unlock"><input type="password" id="pw" placeholder="Passwort" autocomplete="current-password" aria-label="Passwort">
  <div class="row"><button class="btn" type="submit">Entsperren</button></div><div class="err" id="lockerr" role="alert"></div></form></div>
  <p class="fine">Ohne Entsperren siehst du Kaufen und Archiv trotzdem vollständig. Nur „Im Depot“ und der Tech-Anteil fehlen dann.</p>`;
}
function depot() {
  if (!DEPOT) return depotGesperrt();
  if (DEPOT.alt) return `${tape()}<div class="display">Depot</div><div class="card"><div class="status">Altes Format<small>Die verschlüsselte Datei enthält nur Gewichte. Einmal am Mac neu verschlüsseln: python3 tools/encrypt_depot.py</small></div></div>`;
  const P = DEPOT, H = hinsehen(), ps = P.positionen, d3 = veraenderung(P.serie), tech = techAnteil();
  const top = ps.slice(0, 6), rest = Math.max(0, 100 - top.reduce((a, p) => a + p.gewicht, 0));
  return `${tape()}<div class="display">Depot</div><p class="lead">Kurse vom ${datum(P.kurse_stand)}, Bestand vom ${datum(P.bestand_stand)}</p>
  <div class="card"><div class="bigv num">${eur(P.wert)}</div><div class="v2 num ${P.seitKauf >= 0 ? 'up' : 'down'}" style="font-size:15px;margin-top:4px;white-space:normal">${sp(P.seitKauf)} seit Kauf, ${P.gewinn >= 0 ? '+' : '−'}${eur(Math.abs(P.gewinn), 0)}${d3 != null ? `, ${sp(d3)} in 3 Monaten` : ''}</div>
  ${chart(P.serie, v => nf(v / 1000, 1) + 'k')}
  <div class="stack" aria-hidden="true">${top.map((p, i) => `<span style="flex:${p.gewicht};background:${FARBEN[i]}"></span>`).join('')}<span style="flex:${rest};background:${FARBEN[6]}"></span></div>
  <div class="legend num">${top.map((p, i) => `<span><i style="background:${FARBEN[i]}"></i>${esc(KURZ[p.name] || p.name)} ${nf(p.gewicht, 0)} %</span>`).join('')}<span><i style="background:${FARBEN[6]}"></i>Rest ${nf(rest, 0)} %</span></div>
  ${tech != null ? `<p class="t2" style="margin-top:10px;white-space:normal">Technologie rund ${nf(tech, 0)} %. NVIDIA durchgerechnet ${nf(durchschau('NVDA'), 0)} %, Microsoft ${nf(durchschau('MSFT'), 0)} %.</p>` : ''}</div>
  ${H.length ? `<h2>Diese Woche ansehen</h2><div class="carousel">${H.map(p => `<button class="mini ${p.pct < 0 ? 'neg' : ''}" style="flex-basis:150px" data-pos="${esc(p.k)}"><div class="d num ${p.pct >= 0 ? 'up' : ''}">${sp(p.pct, 0)}</div><div class="n">${esc(p.name)}</div><div class="q">${p.warum}</div></button>`).join('')}</div>` : ''}
  <h2>Alle Positionen<small>seit Kauf</small></h2>
  <div class="group">${ps.map(p => { const dl = datenlage(p); return `<button class="item" data-pos="${esc(p.k)}"><span class="tk">${p.art === 'ETF' ? 'ETF' : ini(p.k)}</span><span style="min-width:0"><div class="t1">${esc(p.name)}</div>${chip(dl.label, dl.ton)}</span>${spark(p.serie)}<span class="rt"><div class="v1 num">${eur(p.wert)}</div><div class="v2 num ${p.pct >= 0 ? 'up' : 'down'}">${sp(p.pct)}</div></span></button>`; }).join('')}</div>
  ${(P.sparplan || []).length ? `<h2>Sparplan<small>${eur(P.sparplan.reduce((a, s) => a + s.rate_eur, 0), 0)} im Monat</small></h2><div class="group">${P.sparplan.map(s => `<div class="item static k3"><span class="tk">ETF</span><span style="min-width:0"><div class="t1">${esc(s.name)}</div><div class="t2">am ${s.tag}. jeden Monats</div></span><span class="rt v1 num">${eur(s.rate_eur, 0)}</span></div>`).join('')}</div>` : ''}
  <p class="fine">${P.statisch ? 'Stand der Screenshots, noch ohne aktuelle Kurse. ' : `Wert aus dem Bestand vom ${datum(P.bestand_stand)} mit aktuellen Kursen und Wechselkursen${P.sparraten_seit_stand ? `, plus ${eur(P.sparraten_seit_stand, 0)} Sparraten seitdem` : ''}. `}Verlauf: heutiger Bestand mit den Kursen der letzten drei Monate. Datenlage heißt Trend und Abstand zum Hoch, keine Vorhersage. Weicht etwas von Trade Republic ab, schick einfach neue Screenshots.</p>
  <p style="margin-top:14px"><button class="btn ghost" id="sperren">Auf diesem Gerät sperren</button></p>`;
}

/* ───────── Archiv ───────── */
function archiv() {
  const A = APP.archiv, L = A.laeufe || [], chron = L.slice(0, 8).map((x, i) => ({ ...x, i })).reverse();
  if (run >= L.length) run = 0;
  const r = L[run], aus = ausstehend(), gek = APP.gekauft || [], T = APP.trump, neu = T ? (T.meldungen || []).filter(m => !m.eingepflegt) : [];
  const P = Math.max(0, ...chron.map(x => x.median)), N = Math.min(0, ...chron.map(x => x.median)), RR = (P - N) || 1, AV = 92, z0 = 24 + (-N) / RR * AV;
  const offen = Object.entries(aus).filter(([s]) => !gek.some(g => g.sym === s));
  const zeile = (sym, name, unter, rechts, attrs = '') => `<${attrs ? 'button' : 'div'} class="item k3 ${attrs ? '' : 'static'}" ${attrs}><span class="tk">${ini(sym)}</span><span style="min-width:0"><div class="t1">${esc(name)}</div><div class="t2">${unter}</div></span><span class="rt">${rechts}</span></${attrs ? 'button' : 'div'}>`;
  const pct = v => v == null ? '<span class="t2">Kurs folgt</span>' : `<span class="v1 num ${v >= 0 ? 'up' : 'down'}">${sp(v)}</span>`;
  return `${tape()}<div class="display">Archiv</div><p class="lead">Wie sich die Vorschläge seit dem virtuellen Kauf entwickelt haben, in Euro.</p>
  <div class="card"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px"><span class="bigv num ${A.median >= 0 ? 'up' : 'down'}">${sp(A.median)}</span><span class="t2" style="font-size:14px">${A.plus} von ${A.n} im Plus</span></div><div class="t2">Median aller Vorschläge, je Lauf:</div>
  <div class="bars" style="--n:${chron.length};--zero:${z0.toFixed(1)}px" role="group" aria-label="Median je Lauf, antippen zum Auswählen">${chron.map(x => { const hh = Math.abs(x.median) / RR * AV, pos = x.median >= 0, b = pos ? z0 : z0 - hh; return `<button data-run="${x.i}" aria-pressed="${x.i === run}" aria-label="${datum(x.d)}: Median ${sp(x.median)}"><span class="bar" style="bottom:${b.toFixed(1)}px;height:${Math.max(hh, 2).toFixed(1)}px;background:${pos ? 'var(--up)' : 'var(--down)'}"></span><span class="lbl num ${pos ? 'up' : 'down'}" style="bottom:${(pos ? z0 + hh + 4 : b - 18).toFixed(1)}px">${sp(x.median)}</span></button>`; }).join('')}</div>
  <div class="bdates" style="--n:${chron.length}">${chron.map(x => `<span>${kurzDatum(x.d)}</span>`).join('')}</div></div>
  ${r ? `<h2>Lauf vom ${kurzDatum(r.d)}<small>${r.plus} von ${r.n} im Plus</small></h2><div class="group">${r.rows.map(p => zeile(p[0], A.namen[p[0]] || p[0], KORB[p[1]] || p[1], pct(p[3]), `data-t="${esc(p[0])}"`)).join('')}</div>` : ''}
  <h2>Deine Käufe</h2>${gek.length || offen.length ? `<div class="group">${offen.map(([s, v]) => zeile(s, (findeKandidat(s) || {}).name || s, v.art === 'kauf' ? 'wird eingetragen, dauert ein bis zwei Minuten' : 'Verkauf wird eingetragen', '<span class="t2">gleich da</span>')).join('')}${gek.map(g => zeile(g.sym, g.name, g.status === 'verkauft' ? `${g.seit} bis ${g.bis}, verkauft` : `seit ${g.seit}${g.kaufkurs ? `, zu ${eur(g.kaufkurs)}` : ''}${g.betrag ? `, ${eur(g.betrag, 0)}` : ''}`, pct(g.pct), `data-g="${esc(g.sym)}"`)).join('')}</div>` : `<p class="empty">Noch nichts eingetragen. Öffne unter Kaufen einen Vorschlag und tippe auf „Als gekauft eintragen“.</p>`}
  ${(APP.virtuell || []).length ? `<h2>Virtuelles Depot<small>je 1.000 €, nach Kosten</small></h2><div class="group">${APP.virtuell.map(v => zeile(v.sym, v.name, `seit ${v.seit}${v.quelle === 'trump' ? ', Trump-Komponente' : v.quelle === 'kauf' ? ', von Hand' : ''}${v.status !== 'offen' ? ', geschlossen' : ''}`, pct(v.pct))).join('')}</div>` : ''}
  ${T && T.titel.length ? `<h2>Trump<small>gemeldete Käufe, in Euro</small></h2>
  <div class="card" style="margin-top:0"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px"><span class="bigv num ${T.median >= 0 ? 'up' : 'down'}">${sp(T.median)}</span><span class="t2" style="font-size:14px">${T.plus} von ${T.n} im Plus</span></div>
  <div class="t2" style="white-space:normal">Median seit der Meldung am ${datum(T.titel[0].gemeldet)}.${T.sp500 != null ? ` Der S&P 500 hat im selben Zeitraum ${sp(T.sp500)} gemacht.` : ''}</div></div>
  <div class="group" style="margin-top:10px">${(AUF.has('trump') ? T.titel : T.titel.slice(0, 5)).map(t => zeile(t.sym, t.name, t.band ? `Kauf ${t.band.replace('-', ' bis ')}` : `gemeldet ${kurzDatum(t.gemeldet)}`, pct(t.pct), `data-t="${esc(t.sym)}"`)).join('')}</div>${mehrKnopf('trump', T.titel.length, 5)}
  ${neu.length ? `<p class="fine">Seitdem ${neu.length === 1 ? 'eine neue Meldung' : `${neu.length} neue Meldungen`} (${neu.map(m => kurzDatum(m.datum)).join(', ')}), noch nicht eingepflegt: ${esc(neu[neu.length - 1].kurz)}</p>` : ''}
  <p class="fine">${esc(T.hinweis || '')}</p>` : ''}
  <h2>Pflege</h2><div class="card" style="margin-top:0">
    <div class="linkzeile"><span>Trump hat zu einem Titel geraten</span><a href="https://github.com/${REPO}/issues/new?template=trump.yml" target="_blank" rel="noopener">Eintragen</a></div>
    <div class="linkzeile"><span>Titel von Hand ins virtuelle Depot</span><a href="https://github.com/${REPO}/issues/new?template=kauf.yml" target="_blank" rel="noopener">Eintragen</a></div>
    <div class="linkzeile"><span>Virtuelle Position schließen</span><a href="https://github.com/${REPO}/issues/new?template=verkauf.yml" target="_blank" rel="noopener">Eintragen</a></div>
    <div class="linkzeile"><span>Alles sofort neu rechnen</span><a href="https://github.com/${REPO}/actions/workflows/virtuelles-depot.yml" target="_blank" rel="noopener">Wochenlauf starten</a></div></div>
  <p class="fine">Seit dem Lauftag, ohne Gebühren. Ein Titel kann in mehreren Läufen stehen. Kurse vom ${datum(APP.kurse_stand)}.</p>`;
}

/* ───────── Detailblätter ───────── */
const view = $('#view'), root = $('#root'), sheet = $('#sheet'), fab = $('#fabslot');
function oeffne(html, fabHtml) {
  last = document.activeElement; sheet.innerHTML = `<div class="handle"></div>` + html; sheet.scrollTop = 0;
  root.classList.add('open'); fab.innerHTML = fabHtml || '';
  sheet.querySelector('.xbtn').onclick = schliesse; sheet.querySelector('.xbtn').focus();
  const f = fab.querySelector('[data-merk]'); if (f) f.addEventListener('click', () => { vormerken(f.dataset.merk, f.dataset.art); setTimeout(schliesse, 300); });
}
function schliesse() { root.classList.remove('open'); fab.innerHTML = ''; render(); if (last && last.focus) last.focus(); }
$('#scrim').onclick = schliesse;
document.addEventListener('keydown', e => { if (e.key === 'Escape' && root.classList.contains('open')) schliesse(); });
const kopf = (ober, titel) => `<div class="sh-top"><div><div class="t2">${ober}</div><div class="display" id="shT" style="font-size:32px;margin-top:2px">${esc(titel)}</div></div><button class="xbtn" aria-label="Schließen">✕</button></div>`;
function gekauftFab(sym) {
  const g = gekauftOffen(sym), a = ausstehend()[sym];
  if (a) return `<span class="fab done">Wird eingetragen</span>`;
  return g ? `<a class="fab" href="${issueLink(sym, true)}" target="_blank" rel="noopener" data-merk="${esc(sym)}" data-art="verkauf">Als verkauft eintragen</a>`
    : `<a class="fab" href="${issueLink(sym, false)}" target="_blank" rel="noopener" data-merk="${esc(sym)}" data-art="kauf">Als gekauft eintragen</a>`;
}
function kandidat(sym) {
  const x = findeKandidat(sym); if (!x) return gekauftBlatt(sym);
  const [l, t] = signal(x), h = handelstag(), ch = veraenderung(x.serie), g = gekauftOffen(sym), pf = profil(sym);
  const pro = [...(pf && pf.treiber ? [pf.treiber] : []), ...(x.pro.length ? x.pro : pf ? [] : ['Kein einzelner Faktor sticht heraus, der Rang kommt aus der Summe.'])];
  const dg = [...(pf && pf.risiko ? [pf.risiko] : []), ...dagegen(x)];
  oeffne(`${kopf(`${esc(x.sym)}, ${esc(x.branche)}, Rang ${x.rang} von ${x.n} bei ${({ klein: 'Klein', mittel: 'Mittel', gross: 'Groß' })[x.groesse] || ''}`, x.name)}
  <div style="display:flex;gap:10px;align-items:baseline;margin-top:8px;flex-wrap:wrap"><span class="bigv num" style="font-size:30px">${x.kursEUR != null ? eur(x.kursEUR) : ''}</span>${ch != null ? `<span class="v2 num ${ch >= 0 ? 'up' : 'down'}" style="font-size:15px">${sp(ch)} seit ${x.serie[0][0]}</span>` : ''}${chip(l, t)}${g ? chip(`Gekauft am ${g.seit}`, 'got') : ''}</div>
  ${chart(x.serie, v => nf(v, v < 100 ? 2 : 0) + ' $')}
  ${profilBox(sym, x.profilEN)}
  <div class="box b-pro"><h3>Warum kaufen</h3><ul class="pts">${pro.map(p => `<li><span>✓</span><span>${esc(p)}</span></li>`).join('')}</ul></div>
  <div class="box b-con"><h3>Was dagegen spricht</h3><ul class="pts">${dg.length ? dg.map(p => `<li><span>!</span><span>${esc(p)}</span></li>`).join('') : '<li><span></span><span>Nichts Auffälliges in den Daten.</span></li>'}</ul></div>
  ${erwartungBox(x)}
  <div class="box card pri" style="margin-top:10px"><h3>Wann kaufen</h3><div class="status" style="font-size:15px">${h.titel}<small>${h.unter}</small></div>${timeline(h)}<p style="margin-top:10px;opacity:.9">Limit-Order knapp über dem Briefkurs. Ab rund 500 € pro Kauf bleiben Gebühr und Spread zusammen unter 0,5 %.</p></div>
  <div class="stats"><div class="st"><div class="l">Börsenwert</div><div class="v num">${nf(x.mcap, 1)} Mrd $</div></div><div class="st"><div class="l">Vom Jahreshoch</div><div class="v num">${sp(x.vomHoch)}</div></div><div class="st"><div class="l">Nächste Zahlen</div><div class="v num">${x.zahlen || 'offen'}</div></div><div class="st"><div class="l">Spread zuletzt</div><div class="v num">${x.spread ? nf(x.spread) + ' %' : 'offen'}</div></div><div class="st"><div class="l">Kurs in Dollar</div><div class="v num">${x.kursUSD != null ? usd(x.kursUSD) : 'offen'}</div></div><div class="st"><div class="l">Score</div><div class="v num">${nf(x.score, 1)}</div></div><div class="st wide"><div class="l">ISIN für die Suche in Trade Republic</div><div class="v num">${esc(x.isin || 'offen')}</div></div></div>
  <p class="fine">„Als gekauft eintragen“ öffnet ein vorausgefülltes GitHub-Issue. Absenden, nach ein bis zwei Minuten steht der Kauf auf allen Geräten im Archiv. Keine Anlageberatung, Score und Rangfolge sind noch nicht belegt.</p>`, gekauftFab(sym));
}
function erwartungBox(x) {
  const z = x.ziel, pruef = x.zahlen ? `nach den Zahlen am ${x.zahlen}` : 'nach den nächsten Quartalszahlen';
  const zt = !z ? '<p>Für diesen Titel gibt es kein Kursziel von mindestens drei Analysten.</p>'
    : `<div class="stats" style="margin-top:4px"><div class="st"><div class="l">Analysten-Ziel, 12 Monate</div><div class="v num ${z.pct >= 0 ? 'up' : 'down'}">${sp(z.pct, 0)}</div></div><div class="st"><div class="l">Spanne</div><div class="v num">${z.tief != null && z.hoch != null ? `${sp(z.tief, 0)} bis ${sp(z.hoch, 0)}` : 'offen'}</div></div></div>
      <p style="margin-top:8px">Durchschnitt von ${z.n} Analysten.${z.pct < 0 ? ' Der Kurs liegt schon über ihrem Ziel, sie sind dem Anstieg nicht gefolgt.' : ''} Kursziele sind Meinungen, keine Prognose dieser App, und liegen im Schnitt eher zu hoch.</p>`;
  return `<div class="box"><h3>Was drin sein könnte</h3>${zt}
  <h3 style="margin-top:14px">Wie lange halten</h3><p><b>3 bis 12 Monate.</b> Der Score setzt vor allem auf Momentum, und das wirkt laut Forschung über diesen Zeitraum. Kürzer lohnt kaum: Bei 100 € pro Order kosten Kauf und Verkauf zusammen rund 2,5 %, das frisst etwa drei Monate des erhofften Vorsprungs. Neu prüfen ${pruef} oder wenn der Titel aus den Top 10 fällt.</p>
  <p class="t2" style="margin-top:6px;font-size:13px;white-space:normal">Eigener Backtest über 5 Jahre: rund 0,8 Prozentpunkte Vorsprung pro Monat, statistisch noch nicht belegt.</p></div>`;
}
function titelBlatt(sym) {
  if (findeKandidat(sym)) return kandidat(sym);
  if ((APP.gekauft || []).some(g => g.sym === sym)) return gekauftBlatt(sym);
  const A = APP.archiv || {}, t = APP.trump && APP.trump.titel.find(x => x.sym === sym), pf = profil(sym);
  const laeufe = (A.laeufe || []).flatMap(l => l.rows.filter(r => r[0] === sym).map(r => ({ d: l.d, korb: r[1], pct: r[3] })));
  const name = A.namen && A.namen[sym] || (t && t.name) || sym;
  const pc = v => `<span class="num ${v >= 0 ? 'up' : 'down'}">${sp(v)}</span>`;
  oeffne(`${kopf(esc(sym), name)}
  ${pf ? `<div class="box"><h3>Was die machen</h3><p>${esc(pf.was)}</p><ul class="pts" style="margin-top:6px"><li><span>↗</span><span>${esc(pf.treiber)}</span></li><li><span>!</span><span>${esc(pf.risiko)}</span></li></ul></div>` : ''}
  ${laeufe.length ? `<div class="box"><h3>In den Vorschlägen</h3><ul class="pts">${laeufe.map(l => `<li><span>•</span><span>Lauf vom ${datum(l.d)}, ${KORB[l.korb] || l.korb}: seitdem ${pc(l.pct)}</span></li>`).join('')}</ul></div>` : ''}
  ${t ? `<div class="box"><h3>In Trumps Meldung</h3><p>Gemeldet am ${datum(t.gemeldet)} für ${esc(t.zeitraum || 'das Quartal davor')}${t.band ? `, Kauf ${esc(t.band.replace('-', ' bis '))}` : ''}. Seit der Meldung ${t.pct != null ? pc(t.pct) : 'noch ohne Kurs'} in Euro.</p></div>` : ''}
  <p class="fine">Steht diese Woche nicht in den Top 10. Prozent seit dem jeweiligen Tag, in Euro, ohne Gebühren.</p>`);
}
function gekauftBlatt(sym) {
  const g = (APP.gekauft || []).find(x => x.sym === sym); if (!g) return;
  oeffne(`${kopf(esc(g.sym), g.name)}
  <div class="stats" style="margin-top:12px"><div class="st"><div class="l">Gekauft am</div><div class="v num">${g.seit}</div></div><div class="st"><div class="l">Kaufkurs</div><div class="v num">${g.kaufkurs ? eur(g.kaufkurs) : 'folgt'}</div></div><div class="st"><div class="l">${g.status === 'verkauft' ? 'Ergebnis' : 'Seit Kauf'}</div><div class="v num ${g.pct >= 0 ? 'up' : 'down'}">${sp(g.pct)}</div></div><div class="st"><div class="l">Betrag</div><div class="v num">${g.betrag ? eur(g.betrag, 0) : 'offen'}</div></div></div>
  <p class="fine">Der Titel steht diese Woche nicht in den Top 3. Ob du hältst, entscheidest du, die Datenlage findest du nach dem nächsten Lauf im Depot, sobald er dort auftaucht.</p>`, g.status === 'offen' ? gekauftFab(sym) : '');
}
function position(sym) {
  if (!DEPOT) return;
  const p = DEPOT.positionen.find(x => x.k === sym); if (!p) return;
  const dl = datenlage(p), ds = durchschau(p.k); let ant = p.pct >= 0 ? .25 : 1;
  const calc = () => `<div class="seg2" role="group" aria-label="Anteil">${[.25, .5, 1].map(a => `<button data-a="${a}" aria-pressed="${a === ant}">${a === 1 ? 'Alles' : nf(a * 100, 0) + ' %'}</button>`).join('')}</div><p>${verkaufText(p, ant)}</p>`;
  const cur = p.waehrung === 'USD' ? ' $' : p.waehrung === 'HKD' ? ' HK$' : ' €';
  oeffne(`${kopf(`${p.art}, ${nf(p.gewicht, 1)} % des Depots`, p.name)}
  <div style="display:flex;gap:10px;align-items:baseline;margin-top:8px;flex-wrap:wrap"><span class="bigv num" style="font-size:30px">${eur(p.wert)}</span><span class="v2 num ${p.pct >= 0 ? 'up' : 'down'}" style="font-size:15px">${sp(p.pct)} seit Kauf, ${p.gewinn >= 0 ? '+' : '−'}${eur(Math.abs(p.gewinn), 0)}</span></div>
  ${chart(p.serie, v => nf(v, v < 100 ? 2 : 0) + cur)}
  <div class="box ${dl.ton === 'up' ? 'b-pro' : dl.ton === 'down' || dl.ton === 'wait' ? 'b-con' : ''}"><h3>Datenlage: ${dl.label}</h3>${dl.gruende && dl.gruende.length ? `<ul class="pts">${dl.gruende.map(g => `<li><span>•</span><span>${g}</span></li>`).join('')}</ul>` : `<p>${dl.text}</p>`}${p.art !== 'ETF' && ds && ds - p.gewicht > 0.5 ? `<p style="margin-top:6px">Durch deine ETFs gerechnet hältst du ${esc(p.name)} zu rund ${nf(ds, 0)} %.</p>` : ''}</div>
  ${(pf => pf ? `<div class="box"><h3>Was die machen</h3><p>${esc(pf.was)}</p><ul class="pts" style="margin-top:6px"><li><span>↗</span><span>${esc(pf.treiber)}</span></li><li><span>!</span><span>${esc(pf.risiko)}</span></li></ul></div>` : '')(profil(p.k))}
  ${heuteKaufen(p) ? `<div class="box"><h3>Halten oder nicht?</h3><p>${heuteKaufen(p)}</p></div>` : ''}
  ${p.art !== 'ETF' ? `<div class="box"><h3>${p.pct >= 0 ? 'Gewinn mitnehmen' : 'Verlust realisieren'}</h3><div id="calc">${calc()}</div></div>` : ''}
  <div class="box"><h3>Wann verkaufen</h3><p>${zeitfenster(p.ex, 'verkauf')}</p></div>
  ${p.isin ? `<div class="stats"><div class="st wide"><div class="l">ISIN</div><div class="v num">${esc(p.isin)}</div></div></div>` : ''}
  <p class="fine">Keine Anlageberatung. Steuer vereinfacht mit 26,375 % ohne Kirchensteuer.</p>`);
  const c = $('#calc'); if (c) c.addEventListener('click', e => { const b = e.target.closest('[data-a]'); if (!b) return; ant = +b.dataset.a; c.innerHTML = calc(); });
}

/* ───────── Ablauf ───────── */
function render() {
  if (!APP) {
    view.innerHTML = `<div class="display">Sparplan</div><div class="card"><div class="status">Daten nicht erreichbar<small>Kein Netz oder data/app.json fehlt noch. Der Sonntagslauf legt sie an.</small></div><p style="margin-top:12px"><button class="btn" id="neu">Erneut laden</button></p></div>`;
    $('#neu').onclick = start; return;
  }
  view.innerHTML = tab === 'kaufen' ? kaufen() : tab === 'depot' ? depot() : archiv();
  document.querySelectorAll('.nav button').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tab));
  const f = $('#unlock');
  if (f) f.onsubmit = async ev => {
    ev.preventDefault(); const err = $('#lockerr'); err.textContent = 'Prüfe …';
    try { await depotEntsperren($('#pw').value); render(); }
    catch (e) { err.textContent = String(e.message) === 'fehlt' ? 'Noch kein verschlüsseltes Depot hinterlegt.' : 'Passwort passt nicht.'; }
  };
  const s = $('#sperren'); if (s) s.onclick = async () => { await IDB.clear(); DEPOT = null; render(); };
}
function zuTab(t, oben = true) {
  tab = ['kaufen', 'depot', 'archiv'].includes(t) ? t : 'kaufen';
  try { history.replaceState(null, '', '#' + tab); } catch (e) { /* egal */ }
  render(); if (oben) scrollTo(0, 0);
}
document.querySelector('.nav').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) zuTab(b.dataset.tab); });
view.addEventListener('click', e => {
  const r = e.target.closest('[data-run]'); if (r) { run = +r.dataset.run; render(); return; }
  const m = e.target.closest('[data-mehr]'); if (m) { const key = m.dataset.mehr; AUF.has(key) ? AUF.delete(key) : AUF.add(key); render(); if (!AUF.has(key)) { const z = document.querySelector(`[data-mehr="${key}"]`); if (z) z.scrollIntoView({ block: 'center' }); } return; }
  const tt = e.target.closest('[data-t]'); if (tt) { titelBlatt(tt.dataset.t); return; }
  const k = e.target.closest('[data-k]'); if (k) { kandidat(k.dataset.k); return; }
  const g = e.target.closest('[data-g]'); if (g) { kandidat(g.dataset.g); return; }
  const p = e.target.closest('[data-pos]'); if (p) position(p.dataset.pos);
});
async function start() {
  try { const r = await fetch('data/app.json', { cache: 'no-cache' }); APP = r.ok ? await r.json() : null; } catch (e) { APP = null; }
  if (APP) aufraeumen();
  await depotAuto();
  const h = (location.hash || '').slice(1);
  zuTab(h === 'virtuell' ? 'archiv' : h, false);
}
// Zurück in die App geholt: frische Daten, damit Mac und iPhone gleich aussehen.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !root.classList.contains('open')) start(); });
start();
