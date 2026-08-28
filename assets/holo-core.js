/* ══════════════════════════════════════════════════════════════
   VODAFONE JARVIS CORE  ·  v2
   Holografisches 3D-Diagramm als Canvas-Hintergrund.
   Zwei Themes:
     data-theme="dark"   additive Komposition, weiss-heisse Kerne,
                         fuer die dunklen Folien (Titel / Ende)
     data-theme="light"  normale Komposition in Vodafone-Rot,
                         fuer die hellen Anruf-Folien
   Optionen je Canvas:
     data-logo="1|0"     Vodafone-Zeichen als Hologramm im Kern
     data-reactive="1"   reagiert auf die Zustandsklassen der Folie
                         (st-ai*, st-wake, play, armed)
     data-r="0.30"       Kugelradius als Anteil der Canvasbreite
   ══════════════════════════════════════════════════════════════ */
(function(){
'use strict';
var DEG=Math.PI/180, TAU=Math.PI*2;

/* Ein beliebiger SVG-Pfad als Zeichen im Kern. Die Bounding-Box
   wird einmalig ueber ein unsichtbares SVG ermittelt, damit man
   nur den Pfad angeben muss und nichts von Hand zentrieren.      */
function measurePath(d){
  try{
    var svg=document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('width','0'); svg.setAttribute('height','0');
    svg.style.cssText='position:absolute;left:-9999px;top:-9999px;opacity:0;';
    var p=document.createElementNS('http://www.w3.org/2000/svg','path');
    p.setAttribute('d',d); svg.appendChild(p); document.body.appendChild(svg);
    var b=p.getBBox(); document.body.removeChild(svg);
    if(!b.width||!b.height) return null;
    return {cx:b.x+b.width/2, cy:b.y+b.height/2, h:b.height, w:b.width};
  }catch(e){ return null; }
}

function vec(lon,lat){var a=lat*DEG,o=lon*DEG,c=Math.cos(a);return [c*Math.cos(o),Math.sin(a),c*Math.sin(o)];}
function norm(v){var l=Math.hypot(v[0],v[1],v[2])||1;return [v[0]/l,v[1]/l,v[2]/l];}
function cross(a,b){return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}

/* ---------- Punkt-Schale ---------- */
var SHELL=(function(){
  var N=1500,golden=Math.PI*(3-Math.sqrt(5)),X=[],Y=[],Z=[],S=[],T=[],H=[];
  for(var i=0;i<N;i++){
    var y=1-(i/(N-1))*2, r=Math.sqrt(Math.max(0,1-y*y)), th=golden*i;
    X.push(Math.cos(th)*r); Y.push(y); Z.push(Math.sin(th)*r);
    S.push(0.85+Math.random()*0.75); T.push(Math.random()*TAU); H.push(i%53===7?1:0);
  }
  return {x:new Float32Array(X),y:new Float32Array(Y),z:new Float32Array(Z),
          s:new Float32Array(S),t:new Float32Array(T),h:new Uint8Array(H),n:N};
})();

/* ---------- Gitterpunkte ---------- */
var GRIDP=(function(){
  var X=[],Y=[],Z=[],W=[];
  for(var lat=-75;lat<=75;lat+=15){
    var w=(lat===0)?1:0, step=(Math.abs(lat)>=60)?3.0:1.5;
    for(var lo=0;lo<360;lo+=step){var v=vec(lo,lat);X.push(v[0]);Y.push(v[1]);Z.push(v[2]);W.push(w);}
  }
  for(var lon=0;lon<360;lon+=15){
    var w2=(lon%90===0)?1:0;
    for(var la=-84;la<=84;la+=1.5){var v2=vec(lon,la);X.push(v2[0]);Y.push(v2[1]);Z.push(v2[2]);W.push(w2);}
  }
  return {x:new Float32Array(X),y:new Float32Array(Y),z:new Float32Array(Z),w:new Uint8Array(W),n:X.length};
})();

/* ---------- Strukturkreise ---------- */
var RINGS3D=(function(){
  function circle(axis,rad,seg){
    axis=norm(axis);
    var tmp=Math.abs(axis[1])>0.9?[1,0,0]:[0,1,0];
    var u=norm(cross(axis,tmp)), v=cross(axis,u), p=new Float32Array(seg*3);
    for(var i=0;i<seg;i++){
      var a=i/seg*TAU,c=Math.cos(a),s=Math.sin(a);
      p[i*3]=(u[0]*c+v[0]*s)*rad; p[i*3+1]=(u[1]*c+v[1]*s)*rad; p[i*3+2]=(u[2]*c+v[2]*s)*rad;
    }
    return p;
  }
  return [{p:circle([0,1,0],1,120),seg:120,a:0.44,w:1.3},
          {p:circle([1,0,0],1,120),seg:120,a:0.26,w:1.0},
          {p:circle([0,0,1],1,120),seg:120,a:0.26,w:1.0}];
})();

/* ---------- Gyro-Ringe ---------- */
var GYRO=[
  {base:[0.25,1,0.10],   rad:1.16, seg:132, prec:0.055,  spin:0.30, a:0.52, ticks:36, lw:1.6},
  {base:[1,0.28,-0.22],  rad:1.30, seg:132, prec:-0.038, spin:-0.20,a:0.36, ticks:24, lw:1.3},
  {base:[-0.35,0.55,1],  rad:1.05, seg:120, prec:0.072,  spin:0.42, a:0.30, ticks:0,  lw:1.1},
  {base:[0.65,-0.30,0.62],rad:1.44,seg:120, prec:-0.026, spin:0.16, a:0.24, ticks:60, lw:1.1}
];

/* ---------- Datenbögen ---------- */
var ARCS=(function(){
  var nodes=[[6.8,51.2],[-0.1,51.5],[-74,40.7],[139.7,35.7],[103.8,1.3],[151.2,-33.9],
             [-46.6,-23.5],[31.2,30],[72.8,19.1],[18.4,-33.9],[-118.2,34.1],[29,41],[36.8,-1.3]];
  var A=vec(nodes[0][0],nodes[0][1]), out=[];
  for(var k=1;k<nodes.length;k++){
    var B=vec(nodes[k][0],nodes[k][1]);
    var d=Math.acos(Math.max(-1,Math.min(1,A[0]*B[0]+A[1]*B[1]+A[2]*B[2])));
    var lift=0.09+0.17*(d/Math.PI), N=44, p=new Float32Array(N*3), s=Math.sin(d);
    for(var i=0;i<N;i++){
      var tt=i/(N-1);
      var w1=s<1e-6?1-tt:Math.sin((1-tt)*d)/s, w2=s<1e-6?tt:Math.sin(tt*d)/s;
      var x=A[0]*w1+B[0]*w2, y=A[1]*w1+B[1]*w2, z=A[2]*w1+B[2]*w2;
      var L=Math.hypot(x,y,z)||1, RR=1+lift*Math.sin(Math.PI*tt);
      p[i*3]=x/L*RR; p[i*3+1]=y/L*RR; p[i*3+2]=z/L*RR;
    }
    out.push({p:p,n:N,ph:(k*0.137)%1,sp:0.14+((k*29)%13)/80});
  }
  return out;
})();

/* ══════════════════ Renderer ══════════════════ */
function initHoloCore(canvas){
  var LIGHT   = canvas.getAttribute('data-theme')==='light';
  var MARK_D  = canvas.getAttribute('data-logo-path')||'';
  var markPath=null, MARK_CX=0, MARK_CY=0, MARK_H=1;
  if(MARK_D && typeof Path2D!=='undefined'){
    var mb=measurePath(MARK_D);
    if(mb){ markPath=new Path2D(MARK_D); MARK_CX=mb.cx; MARK_CY=mb.cy; MARK_H=mb.h; }
  }
  var HASLOGO = canvas.getAttribute('data-logo')!=='0' && !!markPath;
  var RFRAC   = parseFloat(canvas.getAttribute('data-r')||'0.300');
  var INT     = parseFloat(canvas.getAttribute('data-intensity')||'1');
  if(!(INT>0)) INT=1;
  var LOGO_SC = parseFloat(canvas.getAttribute('data-logoscale')||'1.55');

  /* ---------- Farbpalette aus einer einzigen Markenfarbe ---------- */
  function hex2rgb(h){
    h=(h||'').trim().replace('#','');
    if(h.length===3) h=h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    var n=parseInt(h,16);
    if(isNaN(n)||h.length!==6) return [230,0,0];
    return [(n>>16)&255,(n>>8)&255,n&255];
  }
  var BASE=hex2rgb(canvas.getAttribute('data-color')||'#E60000');
  function mix(a,b,t){return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];}
  function T(t){return mix(BASE,[255,255,255],t);}   // Richtung Weiss: heisser Kern
  function D(t){return mix(BASE,[0,0,0],t);}         // Richtung Schwarz: Tiefe
  function rgba(c,a){ if(a<0)a=0; if(a>1)a=1;
    return 'rgba('+(c[0]|0)+','+(c[1]|0)+','+(c[2]|0)+','+(+a).toFixed(3)+')'; }
  var CLEAR='rgba(0,0,0,0)';
  var P={
    base:T(0), glow:T(0.10), deep:D(0.09), deeper:D(0.30),
    node:D(0.07), pulse:D(0.13), soft:T(0.08),
    t16:T(0.16), t19:T(0.19), t23:T(0.235), t28:T(0.275), t31:T(0.31),
    t47:T(0.47), t55:T(0.55), t59:T(0.59), t84:T(0.84), t91:T(0.91),
    t94:T(0.94), t96:T(0.96),
    grid:T(0.17), shell:T(0.19), hub:T(0.72), hot:T(0.90),
    lnD0:T(0.17), lnD1:T(0.66), lnW0:T(0.42), lnW1:T(0.92),
    lnL0:T(0.28), lnL1:D(0.17)
  };

  var dpr=Math.min(window.devicePixelRatio||1,1.5);
  var ctx=canvas.getContext('2d');
  var mA=document.createElement('canvas'), xA=mA.getContext('2d');
  var iA=null,uA=null;
  var COL_FLAT=(0<<16)|(0<<8)|214;      // #D60000, little-endian RGBA fuer das helle Theme

  function mkGlow(blur,op){
    var g=document.createElement('canvas');
    g.className=canvas.className+' hc-glow';
    g.setAttribute('aria-hidden','true');
    g.style.filter='blur('+blur+'px)'; g.style.opacity=op; g.style.pointerEvents='none';
    canvas.parentNode.insertBefore(g,canvas);
    return {c:g,x:g.getContext('2d')};
  }
  var glowA = LIGHT ? mkGlow(6,'0.42') : mkGlow(7,'0.92');
  var glowB = LIGHT ? mkGlow(20,'0.26') : mkGlow(26,'0.50');
  canvas.__glows=[glowA.c,glowB.c];

  var size=0,R=0,cx=0,cy=0,ready=false;
  var TILT=-17*DEG, ct=Math.cos(TILT), st=Math.sin(TILT);
  // Zeiger-Parallaxe: das Hologramm neigt sich leicht zum Cursor.
  var pxT=0, pyT=0, pxC=0, pyC=0;
  window.addEventListener('pointermove', function(ev){
    var r=canvas.getBoundingClientRect(); if(!r.width) return;
    pxT=Math.max(-1,Math.min(1,(ev.clientX-(r.left+r.width/2))/(r.width*1.35)));
    pyT=Math.max(-1,Math.min(1,(ev.clientY-(r.top+r.height/2))/(r.height*1.35)));
  }, {passive:true});
  var rotY=0.9, baseSpin=0.00105, spinMul=1, heat=0, sweep=-1.3, last=0;
  var stride=1, wideGlow=true, fCount=0, fSum=0, tuned=false;
  if(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) baseSpin=0.00030;

  function resize(){
    var rect=canvas.getBoundingClientRect();
    var s=Math.max(rect.width,rect.height); if(!s) return;
    size=Math.round(s*dpr);
    canvas.width=size; canvas.height=size;
    var g1=Math.max(8,size>>2), g2=Math.max(8,size>>3);
    glowA.c.width=g1; glowA.c.height=g1; glowB.c.width=g2; glowB.c.height=g2;
    mA.width=size; mA.height=size;
    iA=xA.createImageData(size,size); uA=new Uint32Array(iA.data.buffer);
    R=size*RFRAC; cx=size/2; cy=size/2; ready=true;
  }
  resize();
  if(window.ResizeObserver) new ResizeObserver(resize).observe(canvas);
  else window.addEventListener('resize',resize);

  var cY=1,sY=0;
  function px_(x,z){return x*cY-z*sY;}
  function pz_(x,z){return x*sY+z*cY;}

  /* Linienfarbe je Theme und Tiefe */
  function lineCol(depth,alpha,warm){
    alpha*=INT;
    if(alpha<=0.005) return null;
    // Auf Dunkel wird die Linie nach vorn heisser, auf Hell nach vorn satter.
    if(LIGHT) return rgba(mix(P.lnL0,P.lnL1,depth), alpha);
    return rgba(mix(warm?P.lnW0:P.lnD0, warm?P.lnW1:P.lnD1, depth), alpha);
  }

  function splat(fx,fy,rad,inten,cr,cg,cb){
    if(inten<=0.010) return;
    if(inten>1) inten=1;
    var SZ=size;
    var xa=(fx-rad)|0, xb=(fx+rad)|0, ya=(fy-rad)|0, yb=(fy+rad)|0;
    if(xa<0)xa=0; if(ya<0)ya=0; if(xb>=SZ)xb=SZ-1; if(yb>=SZ)yb=SZ-1;
    var rr=rad*rad, inv=1/(rr+1e-6);
    for(var yy=ya;yy<=yb;yy++){
      var dy=yy+0.5-fy, dy2=dy*dy, row=yy*SZ;
      for(var xx=xa;xx<=xb;xx++){
        var dx=xx+0.5-fx, d2=dx*dx+dy2;
        if(d2>rr) continue;
        var w=1-d2*inv; w=w*w*inten;
        var ix=row+xx, v=uA[ix];
        if(LIGHT){
          // Alpha akkumulieren, Farbe fest -> korrektes source-over auf Weiss
          var va=(v>>>24)+w*255; if(va>255)va=255;
          uA[ix]=((va|0)<<24)|COL_FLAT;
        } else {
          var nr=(v&255)+cr*w, ng=((v>>8)&255)+cg*w, nb=((v>>16)&255)+cb*w;
          if(nr>255)nr=255; if(ng>255)ng=255; if(nb>255)nb=255;
          uA[ix]=0xFF000000|((nb|0)<<16)|((ng|0)<<8)|(nr|0);
        }
      }
    }
  }

  /* Energie 0..1 steuert Drehzahl, Helligkeit, Ringtempo und Sweep.
     Drei Wege, sie zu setzen, von einfach nach flexibel:
       1. canvas.holo.setEnergy(v)          - direkt aus deinem Code
       2. data-reactive="hover"             - Zeiger ueber dem Element
       3. data-energy-from / -classes       - Klassen an einem Element  */
  var apiEnergy=null, hoverEnergy=0;
  var srcEl=null, classMap=[];
  var srcSel=canvas.getAttribute('data-energy-from');
  if(srcSel) srcEl=document.querySelector(srcSel);
  var cmRaw=canvas.getAttribute('data-energy-classes');
  if(cmRaw){
    cmRaw.split(',').forEach(function(pair){
      var kv=pair.split(':');
      if(kv.length===2){
        var k=kv[0].trim(), v=parseFloat(kv[1]);
        if(k && !isNaN(v)) classMap.push({cls:k, val:v, pre:k.slice(-1)==='*'});
      }
    });
  }
  if(canvas.getAttribute('data-reactive')==='hover'){
    var hoverHost=canvas.parentNode||canvas;
    hoverHost.addEventListener('pointerenter',function(){hoverEnergy=1;},{passive:true});
    hoverHost.addEventListener('pointerleave',function(){hoverEnergy=0;},{passive:true});
  }
  function readState(){
    var e=0.05;
    if(apiEnergy!==null) e=apiEnergy;
    else if(hoverEnergy) e=hoverEnergy;
    else if(srcEl&&classMap.length){
      var cl=srcEl.classList, best=0;
      for(var i=0;i<classMap.length;i++){
        var m=classMap[i];
        if(m.pre){ var p=m.cls.slice(0,-1);
          for(var j=0;j<cl.length;j++) if(cl[j].indexOf(p)===0 && m.val>best) best=m.val;
        } else if(cl.contains(m.cls) && m.val>best) best=m.val;
      }
      if(best) e=best;
    }
    return {spin:1+4.2*e, heat:e};
  }

  function frame(time){
    requestAnimationFrame(frame);
    if(canvas.__hcOff) return;
    if(!ready){ resize(); return; }
    var dt=last?Math.min(0.05,(time-last)/1000):0.016; last=time;
    var t=time*0.001;
    var tgt=readState();
    spinMul += (tgt.spin-spinMul)*0.05;
    heat    += (tgt.heat-heat)*0.045;
    rotY += baseSpin*spinMul*(dt/0.016);
    sweep += (0.0042+0.0060*heat)*(dt/0.016); if(sweep>1.32) sweep=-1.32;
    pxC += (pxT-pxC)*0.06; pyC += (pyT-pyC)*0.06;
    var tl=TILT - pyC*0.20;
    ct=Math.cos(tl); st=Math.sin(tl);
    var ry=rotY + pxC*0.34;
    cY=Math.cos(ry); sY=Math.sin(ry);
    var W=size, i,x0,y0,z0,x,y,z,d,dd,a,rad;
    ctx.clearRect(0,0,W,W);

    /* ── Kernglühen ── */
    if(!LIGHT){
      var core=ctx.createRadialGradient(cx,cy,R*0.02,cx,cy,R*1.45);
      core.addColorStop(0,rgba(P.glow,0.035+0.05*heat));
      core.addColorStop(0.42,rgba(P.deep,0.050+0.04*heat));
      core.addColorStop(0.78,rgba(P.deeper,0.030));
      core.addColorStop(1,CLEAR);
      ctx.fillStyle=core; ctx.beginPath(); ctx.arc(cx,cy,R*1.45,0,TAU); ctx.fill();
    } else {
      var core2=ctx.createRadialGradient(cx,cy,R*0.05,cx,cy,R*1.30);
      core2.addColorStop(0,rgba(P.base,0.045+0.05*heat));
      core2.addColorStop(0.60,rgba(P.base,0.022+0.03*heat));
      core2.addColorStop(1,CLEAR);
      ctx.fillStyle=core2; ctx.beginPath(); ctx.arc(cx,cy,R*1.30,0,TAU); ctx.fill();
    }

    /* ── Punkte ── */
    var dy0=(cy-R*1.08)|0, dy1=(cy+R*1.08)|0;
    if(dy0<0)dy0=0; if(dy1>W-1)dy1=W-1;
    uA.fill(0, dy0*W, (dy1+1)*W);
    var AMP = (LIGHT ? 0.62 : 1) * INT;                       // auf Weiss deutlich zurueckhaltender

    for(i=0;i<GRIDP.n;i+=stride){
      x0=GRIDP.x[i]; y0=GRIDP.y[i]; z0=GRIDP.z[i];
      x=px_(x0,z0); z=pz_(x0,z0); y=y0*ct-z*st; z=y0*st+z*ct;
      if(z<-0.55) continue;
      d=(z+1)*0.5; dd=d*d;
      var rim=1-Math.abs(z); rim=0.34+0.66*rim*rim;
      a=((GRIDP.w[i]?0.20:0.10)+(GRIDP.w[i]?1.45:0.95)*dd)*rim;
      var dsw=Math.abs(y-sweep);
      if(dsw<0.12&&z>0){ var b=1-dsw/0.12; a+=b*b*(0.60+0.5*heat)*d; }
      rad=(GRIDP.w[i]?1.05:0.85)*dpr*(0.5+0.55*d);
      splat(cx+x*R, cy-y*R, rad<0.6?0.6:rad, a*AMP*(0.85+0.5*heat), P.grid[0],P.grid[1],P.grid[2]);
    }
    for(i=0;i<SHELL.n;i+=stride){
      x0=SHELL.x[i]; y0=SHELL.y[i]; z0=SHELL.z[i];
      x=px_(x0,z0); z=pz_(x0,z0); y=y0*ct-z*st; z=y0*st+z*ct;
      if(z<-0.55) continue;
      d=(z+1)*0.5; dd=d*d;
      var wave=0.5+0.5*Math.sin(y0*4.2-t*(1.25+2.2*heat)+SHELL.t[i]*0.35);
      var tw=0.55+0.45*Math.sin(t*2.4+SHELL.t[i]);
      var hub=SHELL.h[i];
      var rim2=1-Math.abs(z); rim2=0.10+0.90*rim2*rim2*rim2;
      a=(0.08+0.80*dd)*(0.45+0.85*wave)*tw*rim2*(0.85+0.5*heat);
      var CC=P.shell;
      if(hub){ a=(0.22+1.30*dd)*(0.6+0.6*tw)*(0.35+0.65*rim2); CC=P.hub; }
      var cr=CC[0],cg=CC[1],cb=CC[2];
      var ds2=Math.abs(y-sweep);
      if(ds2<0.12&&z>0){
        var b2=1-ds2/0.12; b2=b2*b2*d;
        a+=b2*(0.95+0.6*heat);
        // Der Scan-Sweep zieht den Punkt Richtung Weissglut
        cr+=(P.hot[0]-cr)*b2; cg+=(P.hot[1]-cg)*b2; cb+=(P.hot[2]-cb)*b2;
      }
      rad=SHELL.s[i]*dpr*(0.55+0.65*d)*(hub?1.35:1);
      splat(cx+x*R, cy-y*R, rad<0.6?0.6:rad, a*AMP, cr,cg,cb);
    }
    xA.putImageData(iA,0,0,0,dy0,W,dy1-dy0+1);
    if(!LIGHT) ctx.globalCompositeOperation='lighter';
    ctx.drawImage(mA,0,0);
    ctx.globalCompositeOperation='source-over';

    /* ── Strukturkreise ── */
    for(i=0;i<RINGS3D.length;i++){
      var RC=RINGS3D[i], p0=RC.p, sg=RC.seg, pX=0,pY=0,pZ=0,first=true;
      ctx.lineWidth=RC.w*dpr;
      for(var j=0;j<=sg;j++){
        var jj=(j%sg)*3, ax=p0[jj],ay=p0[jj+1],az=p0[jj+2];
        var qx=px_(ax,az), qz=pz_(ax,az), qy=ay*ct-qz*st; qz=ay*st+qz*ct;
        var SX=cx+qx*R, SY=cy-qy*R;
        if(!first){
          var dep=((qz+pZ)*0.5+1)*0.5;
          var col=lineCol(dep, RC.a*(0.14+0.86*dep*dep)*(0.8+0.5*heat)*(LIGHT?0.55:1), false);
          if(col){ ctx.strokeStyle=col; ctx.beginPath(); ctx.moveTo(pX,pY); ctx.lineTo(SX,SY); ctx.stroke(); }
        }
        pX=SX;pY=SY;pZ=qz;first=false;
      }
    }

    /* ── Gyro-Ringe ── */
    for(i=0;i<GYRO.length;i++){
      var G=GYRO[i];
      var pa=t*G.prec*(1+heat*1.8), ca=Math.cos(pa), sa=Math.sin(pa);
      var ax2=norm([G.base[0]*ca-G.base[2]*sa, G.base[1], G.base[0]*sa+G.base[2]*ca]);
      var tmp=Math.abs(ax2[1])>0.9?[1,0,0]:[0,1,0];
      var u=norm(cross(ax2,tmp)), v=cross(ax2,u);
      var ph=t*G.spin*(1+heat*1.6), seg=G.seg, pX2=0,pY2=0,pZ2=0;
      ctx.lineWidth=G.lw*dpr;
      for(var k=0;k<=seg;k++){
        var an=(k%seg)/seg*TAU+ph, c1=Math.cos(an), s1=Math.sin(an);
        var wx=(u[0]*c1+v[0]*s1)*G.rad, wy=(u[1]*c1+v[1]*s1)*G.rad, wz=(u[2]*c1+v[2]*s1)*G.rad;
        var rx=px_(wx,wz), rz=pz_(wx,wz), ry=wy*ct-rz*st; rz=wy*st+rz*ct;
        var SX2=cx+rx*R, SY2=cy-ry*R;
        if(k>0){
          var dep2=((rz+pZ2)*0.5+1)*0.5;
          var col2=lineCol(dep2, G.a*(0.10+0.90*dep2*dep2)*(0.85+0.4*heat)*(LIGHT?0.48:1), true);
          if(col2){ ctx.strokeStyle=col2; ctx.beginPath(); ctx.moveTo(pX2,pY2); ctx.lineTo(SX2,SY2); ctx.stroke(); }
        }
        pX2=SX2;pY2=SY2;pZ2=rz;
      }
      if(G.ticks){
        ctx.lineWidth=1*dpr;
        for(var q=0;q<G.ticks;q++){
          var aq=q/G.ticks*TAU+ph, cq=Math.cos(aq), sq=Math.sin(aq);
          var big=(q%6===0), r2=G.rad+(big?0.10:0.05);
          var ox=(u[0]*cq+v[0]*sq), oy=(u[1]*cq+v[1]*sq), oz=(u[2]*cq+v[2]*sq);
          var t1x=ox*G.rad,t1y=oy*G.rad,t1z=oz*G.rad, t2x=ox*r2,t2y=oy*r2,t2z=oz*r2;
          var e1x=px_(t1x,t1z), e1z=pz_(t1x,t1z), e1y=t1y*ct-e1z*st; e1z=t1y*st+e1z*ct;
          var e2x=px_(t2x,t2z), e2z=pz_(t2x,t2z), e2y=t2y*ct-e2z*st; e2z=t2y*st+e2z*ct;
          var dep3=(e1z+1)*0.5;
          var col3=lineCol(dep3, G.a*1.5*(0.08+0.92*dep3*dep3)*(LIGHT?0.36:1), true);
          if(!col3) continue;
          ctx.strokeStyle=col3; ctx.beginPath();
          ctx.moveTo(cx+e1x*R,cy-e1y*R); ctx.lineTo(cx+e2x*R,cy-e2y*R); ctx.stroke();
        }
      }
      var na=t*(G.spin*1.9+0.35)*(1+heat)+i*1.7, nc=Math.cos(na), ns=Math.sin(na);
      var nx=(u[0]*nc+v[0]*ns)*G.rad, ny=(u[1]*nc+v[1]*ns)*G.rad, nz=(u[2]*nc+v[2]*ns)*G.rad;
      var mx=px_(nx,nz), mz=pz_(nx,nz), my=ny*ct-mz*st; mz=ny*st+mz*ct;
      if(mz>-0.2){
        var NX=cx+mx*R, NY=cy-my*R, nd=(mz+1)*0.5, rr9=9*dpr;
        var gr=ctx.createRadialGradient(NX,NY,0,NX,NY,rr9);
        if(LIGHT){
          gr.addColorStop(0,rgba(P.node,0.80*nd));
          gr.addColorStop(0.35,rgba(P.soft,0.28*nd));
        } else {
          gr.addColorStop(0,rgba(P.t94,0.85*nd));
          gr.addColorStop(0.3,rgba(P.t28,0.45*nd));
        }
        gr.addColorStop(1,CLEAR);
        ctx.fillStyle=gr; ctx.beginPath(); ctx.arc(NX,NY,rr9,0,TAU); ctx.fill();
      }
    }

    /* ── Datenbögen ── */
    for(i=0;i<ARCS.length;i++){
      var A2=ARCS[i], pp0=A2.p, N2=A2.n, qx2=0,qy2=0,qv=false;
      ctx.lineWidth=1.2*dpr;
      for(var m=0;m<N2;m++){
        var bx1=pp0[m*3],by1=pp0[m*3+1],bz1=pp0[m*3+2];
        var cx1=px_(bx1,bz1), cz1=pz_(bx1,bz1), cy1=by1*ct-cz1*st; cz1=by1*st+cz1*ct;
        var SX3=cx+cx1*R, SY3=cy-cy1*R, vis=cz1>-0.12;
        if(m>0&&vis&&qv){
          var dp=(cz1+1)*0.5;
          var col4=lineCol(dp,(0.05+0.46*dp*dp*(0.7+0.6*heat))*(LIGHT?0.34:1),true);
          if(col4){ ctx.strokeStyle=col4; ctx.beginPath(); ctx.moveTo(qx2,qy2); ctx.lineTo(SX3,SY3); ctx.stroke(); }
        }
        qx2=SX3; qy2=SY3; qv=vis;
      }
      var pp=(t*A2.sp*(1+heat*1.4)+A2.ph)%1, idx=pp*(N2-1), i0=idx|0, fr=idx-i0, i1=Math.min(N2-1,i0+1);
      var ex=pp0[i0*3]+(pp0[i1*3]-pp0[i0*3])*fr, ey=pp0[i0*3+1]+(pp0[i1*3+1]-pp0[i0*3+1])*fr, ez=pp0[i0*3+2]+(pp0[i1*3+2]-pp0[i0*3+2])*fr;
      var fx2=px_(ex,ez), fz2=pz_(ex,ez), fy2=ey*ct-fz2*st; fz2=ey*st+fz2*ct;
      if(fz2>-0.05){
        var PX=cx+fx2*R, PY=cy-fy2*R, fd=Math.sin(Math.PI*pp)*(0.4+0.6*(fz2+1)*0.5), r8=8*dpr;
        var g2=ctx.createRadialGradient(PX,PY,0,PX,PY,r8);
        if(LIGHT){
          g2.addColorStop(0,rgba(P.pulse,0.85*fd));
          g2.addColorStop(0.3,rgba(P.soft,0.32*fd));
        } else {
          g2.addColorStop(0,rgba(P.t96,0.95*fd));
          g2.addColorStop(0.3,rgba(P.t31,0.5*fd));
        }
        g2.addColorStop(1,CLEAR);
        ctx.fillStyle=g2; ctx.beginPath(); ctx.arc(PX,PY,r8,0,TAU); ctx.fill();
      }
    }

    /* ── Silhouette ── */
    if(!LIGHT){
      var limb=ctx.createRadialGradient(cx,cy,R*0.90,cx,cy,R*1.05);
      limb.addColorStop(0,CLEAR);
      limb.addColorStop(0.78,rgba(P.t19,0.13+0.09*heat));
      limb.addColorStop(0.95,rgba(P.t55,0.34+0.16*heat));
      limb.addColorStop(1,CLEAR);
      ctx.fillStyle=limb; ctx.beginPath(); ctx.arc(cx,cy,R*1.05,0,TAU); ctx.fill();
      ctx.strokeStyle=rgba(P.t47,0.40+0.20*heat);
    } else {
      ctx.strokeStyle=rgba(P.base,0.20+0.16*heat);
    }
    ctx.lineWidth=1.3*dpr; ctx.beginPath(); ctx.arc(cx,cy,R,0,TAU); ctx.stroke();

    /* ── Arc-Reactor-Platte ── */
    (function(){
      var A0=LIGHT?0.55:1, rot=t*0.16*(1+heat);
      ctx.save(); ctx.translate(cx,cy);
      ctx.strokeStyle=lineCol(0.85,(0.20+0.10*heat)*A0,true)||CLEAR; ctx.lineWidth=1.1*dpr;
      ctx.beginPath(); ctx.arc(0,0,R*0.74,0,TAU); ctx.stroke();
      ctx.strokeStyle=lineCol(0.8,(0.13+0.08*heat)*A0,true)||CLEAR; ctx.lineWidth=0.9*dpr;
      ctx.beginPath(); ctx.arc(0,0,R*0.86,0,TAU); ctx.stroke();
      ctx.strokeStyle=lineCol(0.95,(0.26+0.12*heat)*A0,true)||CLEAR; ctx.lineWidth=2.4*dpr;
      for(var k=0;k<4;k++){var a0=k*1.5708+rot; ctx.beginPath(); ctx.arc(0,0,R*0.80,a0,a0+0.72); ctx.stroke();}
      ctx.strokeStyle=lineCol(0.9,(0.18+0.10*heat)*A0,true)||CLEAR; ctx.lineWidth=1.6*dpr;
      for(var k2=0;k2<6;k2++){var a1=k2*1.0472-rot*1.6; ctx.beginPath(); ctx.arc(0,0,R*0.92,a1,a1+0.42); ctx.stroke();}
      ctx.strokeStyle=lineCol(0.9,(0.15+0.10*heat)*A0,true)||CLEAR; ctx.lineWidth=1*dpr;
      ctx.beginPath();
      for(var q=0;q<36;q++){
        var an=q/36*TAU+rot*0.5, big=(q%3===0), r1=R*(big?0.95:0.965), r2=R;
        ctx.moveTo(Math.cos(an)*r1,Math.sin(an)*r1); ctx.lineTo(Math.cos(an)*r2,Math.sin(an)*r2);
      }
      ctx.stroke(); ctx.restore();
    })();

    /* ── Vodafone-Zeichen als Hologramm ── */
    if(HASLOGO){
      var pulse=0.5+0.5*Math.sin(t*1.15);
      var flick=(Math.sin(t*37)>0.985)?0.55:1;
      var hh=R*LOGO_SC, sc=hh/MARK_H;
      ctx.save();
      ctx.translate(cx, cy+Math.sin(t*0.7)*R*0.012);
      ctx.scale(sc,sc); ctx.translate(-MARK_CX,-MARK_CY);
      var gf=ctx.createLinearGradient(0,MARK_CY-MARK_H*0.5,0,MARK_CY+MARK_H*0.5);
      if(LIGHT){
        gf.addColorStop(0,rgba(P.base,0.10*flick));
        gf.addColorStop(0.5,rgba(P.base,0.05*flick));
        gf.addColorStop(1,rgba(P.base,0.09*flick));
      } else {
        gf.addColorStop(0,rgba(P.t16,0.155*flick));
        gf.addColorStop(0.5,rgba(P.base,0.075*flick));
        gf.addColorStop(1,rgba(P.t23,0.125*flick));
      }
      ctx.fillStyle=gf; ctx.fill(markPath);
      ctx.save(); ctx.clip(markPath);
      ctx.fillStyle=rgba(LIGHT?P.deep:P.t59, (LIGHT?0.11:0.075)*flick);
      var off=(t*26)%9;
      for(var sl=MARK_CY-MARK_H; sl<MARK_CY+MARK_H; sl+=9) ctx.fillRect(MARK_CX-140,sl+off,280,2.2);
      var swy=MARK_CY-MARK_H*0.6+((t*0.33)%1)*MARK_H*1.2;
      var gsw=ctx.createLinearGradient(0,swy-26,0,swy+26);
      gsw.addColorStop(0,CLEAR);
      gsw.addColorStop(0.5,rgba(LIGHT?P.t59:P.t84,(LIGHT?0.30:0.20)*flick));
      gsw.addColorStop(1,CLEAR);
      ctx.fillStyle=gsw; ctx.fillRect(MARK_CX-150,swy-26,300,52);
      ctx.restore();
      ctx.lineJoin='round';
      ctx.strokeStyle=rgba(LIGHT?P.t47:P.t31,(0.42+0.14*pulse)*flick);
      ctx.lineWidth=8/sc; ctx.stroke(markPath);
      // Auf Hell muss die Kontur satt sein, auf Dunkel weissgluehend
      ctx.strokeStyle=rgba(LIGHT?D(0.12):P.t91,(0.86+0.14*pulse)*flick);
      ctx.lineWidth=2.4/sc; ctx.stroke(markPath);
      ctx.restore();
    }

    /* ── HUD ── */
    (function(){
      var A0=LIGHT?0.38:1;
      ctx.save(); ctx.translate(cx,cy); ctx.rotate(-t*0.10*(1+heat*0.8));
      ctx.strokeStyle=lineCol(0.95,(0.26+0.14*heat)*A0,true)||CLEAR; ctx.lineWidth=1.9*dpr;
      for(var k=0;k<3;k++){var a0=k*2.0944; ctx.beginPath(); ctx.arc(0,0,R*1.49,a0,a0+0.58); ctx.stroke();}
      ctx.restore();
      ctx.save(); ctx.translate(cx,cy); ctx.rotate(t*0.055*(1+heat));
      ctx.strokeStyle=lineCol(0.9,(0.20+0.12*heat)*A0,true)||CLEAR; ctx.lineWidth=1*dpr;
      for(var q=0;q<90;q++){
        var an=q/90*TAU, big=(q%9===0), l=(big?11:5)*dpr, rr2=R*1.50;
        ctx.beginPath(); ctx.moveTo(Math.cos(an)*rr2,Math.sin(an)*rr2);
        ctx.lineTo(Math.cos(an)*(rr2+l),Math.sin(an)*(rr2+l)); ctx.stroke();
      }
      ctx.restore();
      if(!LIGHT){
        var bb=R*1.72, L=R*0.17;
        ctx.strokeStyle=lineCol(0.92,0.30+0.15*heat,true)||CLEAR; ctx.lineWidth=2*dpr;
        var co=[[-1,-1],[1,-1],[-1,1],[1,1]];
        for(var c2=0;c2<4;c2++){
          var sx2=co[c2][0], sy2=co[c2][1], X=cx+sx2*bb, Y=cy+sy2*bb;
          ctx.beginPath(); ctx.moveTo(X-sx2*L,Y); ctx.lineTo(X,Y); ctx.lineTo(X,Y-sy2*L); ctx.stroke();
        }
      }
    })();

    /* ── Glow-Ebenen ── */
    var ga=glowA.c.width, gb=glowB.c.width;
    glowA.x.clearRect(0,0,ga,ga); glowA.x.drawImage(canvas,0,0,ga,ga);
    if(wideGlow){ glowB.x.clearRect(0,0,gb,gb); glowB.x.drawImage(glowA.c,0,0,gb,gb); }

    if(!tuned){
      fCount++;
      if(fCount>45) fSum+=dt;
      if(fCount===165){
        tuned=true;
        var avg=fSum/120;
        if(avg>0.055){ stride=2; wideGlow=false; glowB.c.style.display='none'; }
        else if(avg>0.038){ wideGlow=false; glowB.c.style.display='none'; }
      }
    }
  }
  /* Oeffentliche API am Canvas: canvas.holo.setEnergy(0..1) / .setColor('#hex') */
  function buildPalette(){
    P.base=T(0); P.glow=T(0.10); P.deep=D(0.09); P.deeper=D(0.30);
    P.node=D(0.07); P.pulse=D(0.13); P.soft=T(0.08);
    P.t16=T(0.16); P.t19=T(0.19); P.t23=T(0.235); P.t28=T(0.275); P.t31=T(0.31);
    P.t47=T(0.47); P.t55=T(0.55); P.t59=T(0.59); P.t84=T(0.84); P.t91=T(0.91);
    P.t94=T(0.94); P.t96=T(0.96);
    P.grid=T(0.17); P.shell=T(0.19); P.hub=T(0.72); P.hot=T(0.90);
    P.lnD0=T(0.17); P.lnD1=T(0.66); P.lnW0=T(0.42); P.lnW1=T(0.92);
    P.lnL0=T(0.28); P.lnL1=D(0.17);
  }
  canvas.holo={
    setEnergy:function(v){ apiEnergy=(v===null||v===undefined)?null:Math.max(0,Math.min(1,+v)); },
    setColor:function(hex){ BASE=hex2rgb(hex); buildPalette(); },
    element:canvas
  };
  requestAnimationFrame(frame);
}

window.initHoloCore=initHoloCore;
document.querySelectorAll('canvas.holo-core:not(.hc-glow)').forEach(initHoloCore);

/* Sichtbarkeits-Gate: Kerne auf nicht sichtbaren Folien pausieren. */
(function(){
  if(!window.IntersectionObserver) return;
  var io=new IntersectionObserver(function(es){
    for(var i=0;i<es.length;i++){
      var c=es[i].target, off=!es[i].isIntersecting;
      c.__hcOff=off;
      // Glow-Ebenen mit ausblenden: sonst kostet ihr CSS-Blur auch
      // auf unsichtbaren Folien dauerhaft Compositing-Zeit.
      if(c.__glows) for(var k=0;k<c.__glows.length;k++) c.__glows[k].style.display = off ? 'none' : '';
    }
  },{root:null,threshold:0});
  document.querySelectorAll('canvas.holo-core:not(.hc-glow)').forEach(function(c){ io.observe(c); });
})();
})();
