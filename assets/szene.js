/* ═══════════ Kurs-Szene ═══════════
   Eine scroll-gesteuerte Sequenz nach dem Vorbild großer Produktseiten
   (apple.com/macbook-pro): eine hohe Sektion, in der ein Canvas festklebt,
   und der Scrollfortschritt steuert die Animation Bild für Bild, vorwärts
   wie rückwärts. Apple spult dort eine vorgerenderte Bildfolge durch; hier
   wird stattdessen live gezeichnet, das spart hundert JPEGs und bleibt in
   jeder Auflösung scharf.

   Inhaltlich: eine Zeitreihe entsteht, ein gleitender Durchschnitt legt
   sich darüber, am Ende steht die Zahl. Das ist die Kurzfassung dessen,
   was der Datenlauf tut. Die Kerzen sind ausdrücklich schematisch, keine
   echten Kursdaten, und die Sektion sagt das auch. Diese Datei rechnet
   nichts, sie zeichnet nur.

   Verhalten bei prefers-reduced-motion: keine Scrollstrecke, kein Scrub,
   der Endzustand wird einmal gezeichnet. */
(() => {
  'use strict';

  const REDUZIERT = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
  /* Weiches Ein- und Ausblenden innerhalb eines Fensters [a,b] mit Rampen. */
  const fenster = (p, a, b, rampe = .08) =>
    clamp((p - a) / rampe) * clamp((b - p) / rampe);
  const easeInOut = x => x * x * (3 - 2 * x);   // smoothstep
  const lerp = (a, b, t) => a + (b - a) * t;

  /* ── Zeitreihe ──
     Deterministisch erzeugt, damit die Szene bei jedem Laden identisch
     aussieht. Bewusst mit zwei Rücksetzern: eine Kurve, die nur steigt,
     sieht aus wie Werbung und nicht wie ein Markt. */
  function reihe(n = 46){
    let s = 20260830;
    const rnd = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
    const kerzen = [];
    let kurs = 100;
    for (let i = 0; i < n; i++){
      let drift = 0.011;
      if (i > 12 && i < 19) drift = -0.021;        // erster Rücksetzer
      else if (i > 29 && i < 34) drift = -0.016;   // zweiter, flacher
      else if (i > 36) drift = 0.019;              // Ausbruch zum Schluss
      const offen = kurs;
      const schwung = (rnd() - .46) * 0.032 + drift;
      kurs = kurs * (1 + schwung);
      const hoch = Math.max(offen, kurs) * (1 + rnd() * 0.011);
      const tief = Math.min(offen, kurs) * (1 - rnd() * 0.011);
      kerzen.push({offen, schluss:kurs, hoch, tief});
    }
    /* Gleitender Durchschnitt über sieben Schritte, die ruhige Linie über
       dem Rauschen. Am Anfang über weniger Werte, damit sie sofort da ist. */
    kerzen.forEach((k, i) => {
      const von = Math.max(0, i - 6);
      let sum = 0;
      for (let j = von; j <= i; j++) sum += kerzen[j].schluss;
      k.gd = sum / (i - von + 1);
    });
    return kerzen;
  }

  const KERZEN = reihe();
  const N = KERZEN.length;
  const ENDWERT = KERZEN[N - 1].schluss;
  const STARTWERT = KERZEN[0].offen;

  /* ── Aufbau des Markups ──
     Wird hier erzeugt statt in index.html, damit die Sektion ohne diese
     Datei gar nicht erst als leerer Block herumsteht. */
  function baue(host){
    host.classList.add('szene', 'fullbleed');
    host.innerHTML = `
      <div class="szene-sticky">
        <canvas class="szene-canvas"></canvas>
        <div class="szene-text">
          <div class="szene-schritt" data-schritt="0">
            <p class="kicker">Schritt eins</p>
            <h2>Aus Kursen wird<br>eine Zeitreihe.</h2>
            <p class="szene-p">Täglich Eröffnung, Hoch, Tief, Schluss. Für jeden Wert,
              über Jahre zurück, ohne Auswahl nach Gefühl.</p>
          </div>
          <div class="szene-schritt" data-schritt="1">
            <p class="kicker">Schritt zwei</p>
            <h2>Aus der Zeitreihe<br>werden Kennzahlen.</h2>
            <p class="szene-p">Analystenrevisionen, Wachstumsbeschleunigung, Margentrend,
              Cashflow-Trend, Insiderkäufe, Verwässerung. Sechs Größen, alle messbar.</p>
          </div>
          <div class="szene-schritt" data-schritt="2">
            <p class="kicker">Schritt drei</p>
            <h2>Aus Kennzahlen<br>wird ein Score.</h2>
            <p class="szene-p">Eine Zahl je Kandidat, gleiche Regel für alle. Was danach
              damit geschieht, entscheidet kein Modell.</p>
          </div>
        </div>
        <p class="szene-fuss">Schematische Darstellung des Ablaufs, keine echten Kursdaten.</p>
      </div>`;
    return {
      sticky: host.querySelector('.szene-sticky'),
      canvas: host.querySelector('.szene-canvas'),
      schritte: [...host.querySelectorAll('.szene-schritt')]
    };
  }

  /* ── Zeichnen ──
     p läuft von 0 bis 1 über die gesamte Scrollstrecke der Sektion. */
  function zeichner(canvas){
    const ctx = canvas.getContext('2d');
    let W = 0, H = 0, dpr = 1;

    function messen(){
      dpr = Math.min(2, window.devicePixelRatio || 1);
      const r = canvas.getBoundingClientRect();
      W = r.width; H = r.height;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function zeichne(p){
      if (!W || !H) return;
      ctx.clearRect(0, 0, W, H);

      const schmal = W < 760;
      /* Auf breiten Bildschirmen steht der Text links, das Diagramm nimmt
         die rechten zwei Drittel. Auf schmalen liegt es unter dem Text. */
      const links  = schmal ? W * 0.07 : Math.max(W * 0.46, W / 2 - 150);
      const rechts = W * (schmal ? 0.93 : 0.93);
      const oben   = schmal ? H * 0.46 : H * 0.20;
      const unten  = schmal ? H * 0.84 : H * 0.80;
      const breite = rechts - links, hoehe = unten - oben;
      if (breite <= 0 || hoehe <= 0) return;

      /* Wie weit ist die Reihe aufgebaut. Die Kerzen laufen über den
         mittleren Teil der Strecke, davor fährt das Gitter ein, danach
         steht das Bild still und die Kennzahl setzt sich. */
      const bau = easeInOut(clamp((p - 0.02) / 0.66));
      /* Die Reihe steht nie bei null: schon beim Betreten der Sektion sind
         ein paar Kerzen da, sonst blickt man auf eine leere Fläche und weiß
         nicht, worauf man wartet. */
      const START = 5;
      const sichtbar = START + bau * (N - START);
      const ganz = Math.floor(sichtbar);
      const teil = sichtbar - ganz;

      /* Kamerafahrt: die Skala umfasst zuerst nur den Anfang der Reihe und
         weitet sich mit dem Aufbau auf das Ganze. Dadurch bleibt die
         aktuelle Kerze immer groß im Bild, statt zum Strich zu schrumpfen,
         und man hat das Gefühl mitzufahren. */
      const fensterAb = Math.max(0, ganz - Math.round(lerp(11, N, bau)) + 1);
      const bis = Math.min(N - 1, ganz);
      let lo = Infinity, hi = -Infinity;
      for (let i = fensterAb; i <= bis; i++){
        if (KERZEN[i].tief < lo) lo = KERZEN[i].tief;
        if (KERZEN[i].hoch > hi) hi = KERZEN[i].hoch;
      }
      if (!isFinite(lo)){ lo = STARTWERT * .98; hi = STARTWERT * 1.02; }
      const luft = (hi - lo) * 0.16 || 1;
      lo -= luft; hi += luft;

      /* Die x-Achse dehnt sich mit: solange wenige Kerzen da sind, stehen
         sie weit auseinander, am Ende füllen alle die Breite. */
      const spanne = Math.max(6, lerp(12, N, bau));
      const ab = Math.max(0, Math.min(N - spanne, sichtbar - spanne));
      const px = i => links + (i - ab + .5) / spanne * breite;
      const py = v => unten - (v - lo) / (hi - lo) * hoehe;
      const kbreite = Math.max(2, Math.min(14, breite / spanne * 0.52));

      /* ── Gitter ── */
      const gitter = clamp(p / 0.05);
      if (gitter > 0){
        ctx.save();
        ctx.globalAlpha = gitter * 0.85;
        ctx.strokeStyle = 'rgba(255,255,255,.10)';
        ctx.lineWidth = 1;
        for (let l = 0; l <= 4; l++){
          const yy = Math.round(oben + hoehe * l / 4) + .5;
          const w = breite * gitter;
          ctx.beginPath(); ctx.moveTo(links, yy); ctx.lineTo(links + w, yy); ctx.stroke();
        }
        ctx.restore();
      }

      /* ── Kerzen ── */
      for (let i = 0; i <= Math.min(ganz, N - 1); i++){
        const k = KERZEN[i];
        const xx = px(i);
        if (xx < links - 20 || xx > rechts + 20) continue;
        /* Die vorderste Kerze wächst aus ihrem Eröffnungskurs heraus. */
        const w = i === ganz ? teil : 1;
        if (w <= 0) continue;
        const schluss = lerp(k.offen, k.schluss, easeInOut(w));
        const hoch    = lerp(k.offen, k.hoch, easeInOut(w));
        const tief    = lerp(k.offen, k.tief, easeInOut(w));
        const steigt  = schluss >= k.offen;
        const farbe = steigt ? '#32D74B' : '#FF453A';
        /* Ältere Kerzen treten leicht zurück, damit vorne der Blick hängt. */
        const alter = clamp((ganz - i) / Math.max(8, spanne * .8));
        ctx.globalAlpha = lerp(1, 0.42, alter);

        ctx.strokeStyle = farbe;
        ctx.lineWidth = Math.max(1, kbreite * 0.16);
        ctx.beginPath();
        ctx.moveTo(Math.round(xx) + .5, py(hoch));
        ctx.lineTo(Math.round(xx) + .5, py(tief));
        ctx.stroke();

        const y0 = py(Math.max(k.offen, schluss));
        const y1 = py(Math.min(k.offen, schluss));
        ctx.fillStyle = farbe;
        ctx.fillRect(xx - kbreite / 2, y0, kbreite, Math.max(1.5, y1 - y0));
      }
      ctx.globalAlpha = 1;

      /* ── Gleitender Durchschnitt ──
         Setzt in der zweiten Hälfte des Aufbaus ein: erst die Rohdaten,
         dann die Ordnung darüber. */
      const gdAuf = clamp((bau - 0.30) / 0.35);
      if (gdAuf > 0 && ganz > 1){
        const letzte = Math.min(ganz, N - 1);
        ctx.save();
        ctx.strokeStyle = '#409CFF';
        ctx.lineWidth = 2.2;
        ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.shadowColor = 'rgba(64,156,255,.55)';
        ctx.shadowBlur = 14;
        ctx.globalAlpha = gdAuf;
        ctx.beginPath();
        let erster = true;
        for (let i = 0; i <= letzte; i++){
          const xx = px(i), yy = py(KERZEN[i].gd);
          if (erster){ ctx.moveTo(xx, yy); erster = false; } else ctx.lineTo(xx, yy);
        }
        ctx.stroke();
        ctx.restore();
      }

      /* ── Kopf der Reihe ──
         Punkt mit Ring, der erst am Ende der Strecke auftaucht und atmet. */
      const kopf = clamp((p - 0.66) / 0.10);
      if (kopf > 0){
        const i = Math.min(ganz, N - 1);
        const xx = px(i), yy = py(KERZEN[i].gd);
        const puls = 0.5 + 0.5 * Math.sin(performance.now() / 620);
        ctx.save();
        ctx.globalAlpha = kopf * (0.30 + 0.30 * puls);
        ctx.beginPath();
        ctx.arc(xx, yy, 9 + 9 * puls, 0, Math.PI * 2);
        ctx.fillStyle = '#409CFF';
        ctx.fill();
        ctx.globalAlpha = kopf;
        ctx.beginPath();
        ctx.arc(xx, yy, 4.2, 0, Math.PI * 2);
        ctx.fillStyle = '#409CFF';
        ctx.fill();
        ctx.restore();
      }

      /* ── Kennzahl ──
         Der Zuwachs der schematischen Reihe, groß gesetzt, zählt mit dem
         Aufbau hoch statt am Ende zu erscheinen. */
      const zahlAuf = fenster(p, 0.70, 1.40, 0.09);
      if (zahlAuf > 0.01){
        const wert = (ENDWERT / STARTWERT - 1) * 100 * bau;
        const gross = schmal ? 46 : Math.min(96, W * 0.075);
        ctx.save();
        ctx.globalAlpha = zahlAuf;
        ctx.textAlign = schmal ? 'center' : 'right';
        ctx.textBaseline = 'alphabetic';
        const zx = schmal ? W / 2 : rechts;
        const zy = schmal ? H * 0.90 : oben - 26;
        ctx.fillStyle = '#32D74B';
        ctx.font = `800 ${gross}px -apple-system, BlinkMacSystemFont, "SF Pro Display", Segoe UI, Roboto, sans-serif`;
        ctx.fillText('+' + wert.toFixed(1).replace('.', ',') + ' %', zx, zy);
        ctx.globalAlpha = zahlAuf * 0.75;
        ctx.fillStyle = '#98989D';
        ctx.font = `500 ${schmal ? 12 : 14}px -apple-system, BlinkMacSystemFont, "SF Pro Text", Segoe UI, Roboto, sans-serif`;
        ctx.fillText('über den dargestellten Zeitraum', zx, zy + (schmal ? 20 : 24));
        ctx.restore();
      }
    }

    return {messen, zeichne, hat: () => W > 0};
  }

  /* ── Verdrahtung ── */
  function start(){
    const host = document.getElementById('kurs-szene');
    if (!host) return;
    const {sticky, canvas, schritte} = baue(host);
    const maler = zeichner(canvas);

    if (REDUZIERT){
      host.classList.add('statisch');
      requestAnimationFrame(() => { maler.messen(); maler.zeichne(1); });
      /* Im statischen Fall stehen die Blöcke im normalen Fluss, ein auf
         opacity:0 gesetzter Block würde eine Lücke hinterlassen. Deshalb
         hier ausblenden statt durchsichtig machen. */
      schritte.forEach((s, i) => { if (i !== 2) s.hidden = true; });
      addEventListener('resize', () => { maler.messen(); maler.zeichne(1); });
      return;
    }

    let ziel = 0, ist = 0, laeuft = false, sichtbar = false;

    function fortschritt(){
      const r = host.getBoundingClientRect();
      const strecke = r.height - innerHeight;
      if (strecke <= 0) return 0;
      return clamp(-r.top / strecke);
    }

    /* Die Textblöcke blenden nacheinander ein und wieder aus, jeder mit
       einer kleinen Bewegung, wie die Absätze neben Apples Gerät. */
    const FENSTER = [[0.00, 0.32], [0.30, 0.64], [0.62, 1.40]];
    function text(p){
      schritte.forEach((el, i) => {
        const [a, b] = FENSTER[i];
        const o = fenster(p, a, b, 0.10);
        el.style.opacity = o.toFixed(3);
        el.style.transform = `translateY(${((1 - o) * 26).toFixed(1)}px)`;
        el.style.pointerEvents = o > .5 ? 'auto' : 'none';
      });
    }

    function schleife(){
      /* Der Scrollwert wird nachgezogen statt hart gesetzt. Das gibt der
         Sequenz das schwere, geführte Gefühl, statt am Finger zu kleben. */
      const ruht = Math.abs(ziel - ist) < 0.0004;
      if (ruht) ist = ziel; else ist += (ziel - ist) * 0.14;
      maler.zeichne(ist);
      text(ist);
      /* Weiterzeichnen nur, solange es etwas zu zeichnen gibt: entweder der
         Scrollwert läuft noch nach, oder der Ring am Kopf der Reihe pulst
         gerade. Steht beides still, hält auch die Schleife an und wartet
         auf das nächste Scrollereignis, statt Strom zu verbrauchen. */
      if (sichtbar && (!ruht || ist > 0.62)) requestAnimationFrame(schleife);
      else laeuft = false;
    }
    function anstoss(){
      ziel = fortschritt();
      if (!laeuft && sichtbar){ laeuft = true; requestAnimationFrame(schleife); }
    }

    const beobachter = new IntersectionObserver(([e]) => {
      sichtbar = e.isIntersecting;
      if (sichtbar) anstoss();
    }, {rootMargin: '120px 0px'});
    beobachter.observe(host);

    addEventListener('scroll', anstoss, {passive: true});
    addEventListener('resize', () => { maler.messen(); anstoss(); });

    requestAnimationFrame(() => {
      maler.messen();
      ziel = ist = fortschritt();
      text(ist); maler.zeichne(ist);
      anstoss();
    });
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', start);
  else start();
})();
