/* ================================================================
   CAMPUS NAVIGATOR — Intro Animation
   "Signal Trace": GPS acquires, roads draw, buildings materialise,
   routing dots travel, then the home page reveals.
   Total runtime: ~9 s
   ================================================================ */
(function () {
  'use strict';

  const overlay = document.getElementById('introOverlay');
  const canvas  = document.getElementById('introCanvas');
  const ctx     = canvas.getContext('2d');

  /* ── resize canvas to fill screen ── */
  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  window.addEventListener('resize', resize);

  /* ── helpers ── */
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function prog(t, a, b)    { return clamp((t - a) / (b - a), 0, 1); }
  function eOut(t)  { return 1 - Math.pow(1 - t, 3); }
  function eIO(t)   { return t < .5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2; }
  function lerp(a,b,t){ return a + (b-a)*t; }

  /* ── colour helpers ── */
  function hex2rgb(h) {
    const v = parseInt(h.replace('#',''), 16);
    return [(v>>16)&255, (v>>8)&255, v&255];
  }
  function rgba(h, a) { const [r,g,b] = hex2rgb(h); return `rgba(${r},${g},${b},${a})`; }

  /* ── palette (matches app theme) ── */
  const C = {
    bg    : '#060d1a',
    indigo: '#4f46e5',
    violet: '#818cf8',
    cyan  : '#06b6d4',
    teal  : '#67e8f9',
    green : '#10b981',
    white : '#f1f5f9',
    muted : '#94a3b8',
  };

  /* ── campus "map" definition (angles in degrees, lengths relative) ── */
  const ROADS = [
    { angle:  10, frac: .28, label: 'Tech Block' },
    { angle:  60, frac: .22, label: 'Library'    },
    { angle: 100, frac: .32, label: 'Auditorium' },
    { angle: 145, frac: .24, label: 'Gate 1'     },
    { angle: 190, frac: .27, label: 'Admin Block' },
    { angle: 235, frac: .21, label: 'Hostel'     },
    { angle: 275, frac: .30, label: 'Sports'     },
    { angle: 325, frac: .23, label: 'Mess'       },
  ];

  /* ── routing dots that will travel roads after they appear ── */
  const DOT_DEFS = [
    { ri: 0, phase: 0.00, speed: 0.32, col: C.indigo },
    { ri: 2, phase: 0.40, speed: 0.26, col: C.cyan   },
    { ri: 4, phase: 0.15, speed: 0.38, col: C.green  },
    { ri: 6, phase: 0.65, speed: 0.29, col: C.violet },
  ];
  /* mutable dot state */
  const dotState = DOT_DEFS.map(d => ({ ...d, t: d.phase }));

  /* ── timing (seconds) ── */
  const T = {
    bgFade   : [0.0,  0.6],
    pinDrop  : [0.6,  1.8],
    rings    : [1.6,  9.0],   // ongoing pulses
    roads    : [2.0,  5.2],   // staggered; each road takes 0.7 s to draw
    buildings: [2.5,  5.8],   // appear after their road finishes
    dots     : [4.5,  8.2],
    text     : [5.8,  7.4],
    radar    : [7.2,  8.2],
    fadeOut  : [8.4,  9.4],
  };

  /* ── computed road endpoints (recalculated each frame) ── */
  function buildRoads(cx, cy, base) {
    return ROADS.map(r => {
      const rad = r.angle * Math.PI / 180;
      const len = r.frac * base;
      return {
        x1: cx, y1: cy,
        x2: cx + Math.cos(rad) * len,
        y2: cy - Math.sin(rad) * len,
        len, label: r.label,
      };
    });
  }

  /* ── pin teardrop path ── */
  function drawPin(x, y, size, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;

    /* glow halo */
    const grd = ctx.createRadialGradient(x, y+size*0.5, 2, x, y+size*0.5, size*1.8);
    grd.addColorStop(0, rgba(C.indigo, 0.45));
    grd.addColorStop(1, rgba(C.indigo, 0));
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.ellipse(x, y+size*0.6, size*1.5, size*0.7, 0, 0, Math.PI*2);
    ctx.fill();

    /* teardrop body */
    ctx.shadowBlur = 18;
    ctx.shadowColor = C.indigo;
    const gBody = ctx.createLinearGradient(x-size, y-size, x+size, y+size);
    gBody.addColorStop(0, C.violet);
    gBody.addColorStop(1, C.cyan);
    ctx.fillStyle = gBody;
    ctx.beginPath();
    ctx.arc(x, y - size*0.15, size, Math.PI, 0);
    ctx.bezierCurveTo(x + size, y - size*0.15, x + size*0.35, y + size*1.1, x, y + size*1.5);
    ctx.bezierCurveTo(x - size*0.35, y + size*1.1, x - size, y - size*0.15, x, y - size*0.15);
    ctx.fill();

    /* inner white dot */
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'white';
    ctx.beginPath();
    ctx.arc(x, y - size*0.15, size*0.38, 0, Math.PI*2);
    ctx.fill();
    ctx.restore();
  }

  /* ── glowing road line ── */
  function drawRoad(x1, y1, x2, y2, p, alpha) {
    const ex = lerp(x1, x2, p), ey = lerp(y1, y2, p);

    /* outer glow */
    ctx.save();
    ctx.globalAlpha = alpha * 0.35;
    ctx.strokeStyle = C.indigo;
    ctx.lineWidth   = 7;
    ctx.shadowBlur  = 14;
    ctx.shadowColor = C.indigo;
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(ex,ey); ctx.stroke();
    ctx.restore();

    /* dashed core */
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = C.violet;
    ctx.lineWidth   = 1.8;
    ctx.setLineDash([7, 5]);
    ctx.lineDashOffset = -performance.now() * 0.03;
    ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(ex,ey); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    /* leading bright spark */
    if (p < 0.98) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle  = C.teal;
      ctx.shadowBlur = 14; ctx.shadowColor = C.teal;
      ctx.beginPath(); ctx.arc(ex, ey, 3.5, 0, Math.PI*2); ctx.fill();
      ctx.restore();
    }
  }

  /* ── building block at road endpoint ── */
  function drawBuilding(x, y, p, label) {
    if (p <= 0) return;
    const bw = 34, bh = 20;
    ctx.save();
    ctx.globalAlpha = eOut(p);
    ctx.shadowBlur  = 12;
    ctx.shadowColor = C.indigo;

    /* fill */
    ctx.fillStyle   = rgba('#1e293b', 0.92);
    ctx.strokeStyle = rgba(C.indigo, 0.9);
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.roundRect(x - bw/2, y - bh/2, bw, bh, 4);
    ctx.fill(); ctx.stroke();

    /* top accent line */
    ctx.strokeStyle = rgba(C.cyan, 0.85);
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.moveTo(x - bw/2 + 3, y - bh/2 + 1);
    ctx.lineTo(x + bw/2 - 3, y - bh/2 + 1);
    ctx.stroke();

    /* label */
    ctx.shadowBlur  = 0;
    ctx.fillStyle   = rgba(C.white, Math.min(p * 2, 1));
    const fs = Math.max(8, Math.round(bw * 0.28));
    ctx.font        = `600 ${fs}px Poppins,sans-serif`;
    ctx.textAlign   = 'center';
    ctx.fillText(label, x, y + bh/2 + 12);
    ctx.restore();
  }

  /* ── routing dot ── */
  function drawDot(px, py, col, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle   = col;
    ctx.shadowBlur  = 16; ctx.shadowColor = col;
    ctx.beginPath(); ctx.arc(px, py, 5.5, 0, Math.PI*2); ctx.fill();

    /* inner white highlight */
    ctx.shadowBlur  = 0;
    ctx.fillStyle   = 'rgba(255,255,255,0.7)';
    ctx.beginPath(); ctx.arc(px-1.5, py-1.5, 1.5, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }

  /* ── main draw loop ── */
  let startTime = null;
  let done = false;
  let lastT = 0;

  function draw(now) {
    if (done) return;
    if (!startTime) startTime = now;
    const t  = (now - startTime) / 1000;   /* elapsed seconds */
    const dt = t - lastT; lastT = t;

    const W  = canvas.width, H = canvas.height;
    const CX = W / 2, CY = H / 2;
    const BASE = Math.min(W, H) * 0.85;

    ctx.clearRect(0, 0, W, H);

    /* ── 1. BACKGROUND ── */
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    /* subtle grid */
    {
      const ga = prog(t, ...T.bgFade) * 0.055;
      if (ga > 0) {
        const gs = 44;
        ctx.strokeStyle = rgba(C.indigo, ga);
        ctx.lineWidth   = 0.5;
        ctx.beginPath();
        for (let x = 0; x < W; x += gs) { ctx.moveTo(x,0); ctx.lineTo(x,H); }
        for (let y = 0; y < H; y += gs) { ctx.moveTo(0,y); ctx.lineTo(W,y); }
        ctx.stroke();
      }
    }

    /* ── 2. GPS PIN ── */
    {
      const pp = eOut(prog(t, ...T.pinDrop));
      if (pp > 0) {
        const startY = CY - 90;
        const pinY   = lerp(startY, CY - 20, pp);
        drawPin(CX, pinY, 14 * Math.min(W,H) / 600, pp);
      }
    }

    /* ── 3. PULSE RINGS ── */
    if (t > T.rings[0]) {
      const ringElapsed = t - 1.6;
      for (let i = 0; i < 4; i++) {
        const rt = ((ringElapsed - i * 0.55) % 2.5) / 2.5;
        if (rt < 0) continue;
        const r  = rt * Math.min(W, H) * 0.18;
        const ra = (1 - rt) * 0.45;
        ctx.strokeStyle = rgba(C.indigo, ra);
        ctx.lineWidth   = 1.8;
        ctx.beginPath(); ctx.arc(CX, CY - 20, r, 0, Math.PI*2); ctx.stroke();
      }
    }

    /* ── 4. ROADS + BUILDINGS ── */
    const roads = buildRoads(CX, CY - 20, BASE / 2);
    roads.forEach((r, i) => {
      const roadStart = T.roads[0] + i * 0.35;
      const roadEnd   = roadStart + 0.7;
      const rp = prog(t, roadStart, roadEnd);
      if (rp <= 0) return;

      drawRoad(r.x1, r.y1, r.x2, r.y2, eOut(rp), Math.min(rp * 3, 1));

      const bp = prog(t, roadEnd, roadEnd + 0.55);
      drawBuilding(r.x2, r.y2, bp, r.label);
    });

    /* ── 5. ROUTING DOTS ── */
    {
      const dotAlpha = prog(t, ...T.dots);
      if (dotAlpha > 0) {
        dotState.forEach((d, i) => {
          const r = roads[d.ri];
          if (!r) return;

          /* advance position */
          d.t += d.speed * dt;
          const norm = d.t % 2.0;           /* ping-pong 0→1→0 */
          const fwd  = norm < 1.0;
          const tp   = eIO(fwd ? norm : 2 - norm);

          const px = lerp(r.x1, r.x2, tp);
          const py = lerp(r.y1, r.y2, tp);

          /* trail */
          for (let j = 1; j <= 5; j++) {
            const trailTP = clamp(tp - (fwd ? j : -j) * 0.07, 0, 1);
            const tx = lerp(r.x1, r.x2, trailTP);
            const ty = lerp(r.y1, r.y2, trailTP);
            ctx.save();
            ctx.globalAlpha = dotAlpha * (0.4 - j * 0.07);
            ctx.fillStyle   = d.col;
            ctx.beginPath(); ctx.arc(tx, ty, 4 - j*0.4, 0, Math.PI*2); ctx.fill();
            ctx.restore();
          }

          drawDot(px, py, d.col, dotAlpha);
        });
      }
    }

    /* ── 6. TITLE TEXT ── */
    {
      const textP = prog(t, ...T.text);
      if (textP > 0) {
        /* dark pill behind text */
        const pillW = Math.min(W * 0.7, 480), pillH = 110;
        ctx.save();
        ctx.globalAlpha = eIO(textP) * 0.85;
        ctx.fillStyle   = rgba('#060d1a', 0.9);
        ctx.beginPath();
        ctx.roundRect(CX - pillW/2, CY - pillH/2 - 10, pillW, pillH, 18);
        ctx.fill();
        ctx.restore();

        /* CAMPUS NAVIGATOR */
        const fs = clamp(Math.round(W * 0.055), 20, 52);
        ctx.save();
        ctx.globalAlpha = eIO(textP);
        ctx.textAlign   = 'center';

        const tGrad = ctx.createLinearGradient(CX - 200, 0, CX + 200, 0);
        tGrad.addColorStop(0,   '#ffffff');
        tGrad.addColorStop(0.4, '#c7d2fe');
        tGrad.addColorStop(0.8, '#67e8f9');
        tGrad.addColorStop(1,   '#818cf8');

        ctx.font        = `800 ${fs}px Poppins,sans-serif`;
        ctx.shadowBlur  = 22; ctx.shadowColor = rgba(C.indigo, 0.8);
        ctx.fillStyle   = tGrad;
        ctx.fillText('CAMPUS NAVIGATOR', CX, CY + fs * 0.35);
        ctx.shadowBlur  = 0;

        /* VGU sub-line */
        const subP = prog(t, T.text[0] + 0.6, T.text[1]);
        if (subP > 0) {
          ctx.globalAlpha = eIO(subP);
          ctx.font        = `500 ${Math.round(fs * 0.36)}px Poppins,sans-serif`;
          ctx.fillStyle   = C.muted;
          ctx.fillText('VGU, JAIPUR  ·  Smart Campus Guide', CX, CY + fs * 1.1);
        }

        /* scanning underline */
        const lineP = prog(t, T.text[0], T.text[1]);
        const lineW = fs * 9.2;
        ctx.globalAlpha = 0.7 * eIO(lineP);
        const lineGrd   = ctx.createLinearGradient(CX - lineW/2, 0, CX + lineW/2, 0);
        lineGrd.addColorStop(0, 'transparent');
        lineGrd.addColorStop(0.5, C.cyan);
        lineGrd.addColorStop(1, 'transparent');
        ctx.strokeStyle = lineGrd;
        ctx.lineWidth   = 1.5;
        ctx.beginPath();
        ctx.moveTo(CX - lineW/2, CY + fs * 0.6);
        ctx.lineTo(CX + lineW/2, CY + fs * 0.6);
        ctx.stroke();

        ctx.restore();
      }
    }

    /* ── 7. RADAR SWEEP ── */
    {
      const rp = prog(t, ...T.radar);
      if (rp > 0) {
        const sweepAngle = -Math.PI/2 + rp * Math.PI * 2;
        const maxR       = Math.sqrt(W*W + H*H) / 2;

        ctx.save();
        ctx.translate(CX, CY - 20);

        /* sweep sector */
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, maxR, sweepAngle - 0.45, sweepAngle);
        ctx.closePath();
        const sGrd = ctx.createRadialGradient(0,0,0, 0,0,maxR);
        sGrd.addColorStop(0,   rgba(C.cyan, 0.18));
        sGrd.addColorStop(0.7, rgba(C.cyan, 0.06));
        sGrd.addColorStop(1,   rgba(C.cyan, 0));
        ctx.fillStyle = sGrd;
        ctx.fill();

        /* sweep arm */
        ctx.strokeStyle = rgba(C.teal, 0.85);
        ctx.lineWidth   = 1.8;
        ctx.shadowBlur  = 10; ctx.shadowColor = C.cyan;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(sweepAngle)*maxR, Math.sin(sweepAngle)*maxR);
        ctx.stroke();
        ctx.shadowBlur = 0;

        /* radar centre dot */
        ctx.fillStyle  = C.teal;
        ctx.shadowBlur = 8; ctx.shadowColor = C.cyan;
        ctx.beginPath(); ctx.arc(0, 0, 4, 0, Math.PI*2); ctx.fill();
        ctx.shadowBlur = 0;

        ctx.restore();
      }
    }

    /* ── 8. FADE OUT ── */
    {
      const fo = prog(t, ...T.fadeOut);
      if (fo > 0) {
        overlay.style.opacity = String(1 - fo);
        if (fo >= 1) {
          overlay.style.display = 'none';
          done = true;
          return;
        }
      }
    }

    requestAnimationFrame(draw);
  }

  requestAnimationFrame(draw);
})();
