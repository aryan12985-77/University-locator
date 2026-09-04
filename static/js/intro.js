/* ================================================================
   Campus Navigator — "The Campus Comes Alive"
   A lightweight first-visit intro:
   GPS point → campus network → calculated route → CAMPUS NAVIGATOR.
   It runs once per browser tab session and completes in under 3 seconds.
================================================================ */
(function () {
  'use strict';

  const overlay = document.getElementById('introOverlay');
  const canvas = document.getElementById('introCanvas');
  if (!overlay || !canvas) return;

  const ctx = canvas.getContext('2d');
  const SESSION_KEY = 'vgu-campus-intro-seen';
  const reducedMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let complete = false;

  function finish() {
    if (complete) return;
    complete = true;
    window.__campusIntroComplete = true;
    overlay.style.opacity = '0';
    window.setTimeout(function () {
      overlay.style.display = 'none';
      document.dispatchEvent(new CustomEvent('introComplete'));
    }, 360);
  }

  let alreadySeen = false;
  try {
    alreadySeen = sessionStorage.getItem(SESSION_KEY) === '1';
    if (!alreadySeen) sessionStorage.setItem(SESSION_KEY, '1');
  } catch (error) {
    /* Some private browsing modes block storage; play for this load only. */
  }

  if (alreadySeen || reducedMotion) {
    finish();
    return;
  }

  const COLORS = {
    bg: '#06101f',
    blue: '#4f46e5',
    electric: '#60a5fa',
    cyan: '#67e8f9',
    mint: '#6ee7b7',
    white: '#f8fafc',
    muted: '#94a3b8',
    line: '#334a78'
  };
  const duration = 2800;
  const start = performance.now();

  /* A compact campus-shaped network, not a globe or generic particle field. */
  const nodes = [
    { x: 0, y: 0, center: true },
    { x: -0.31, y: -0.16 },
    { x: -0.12, y: -0.37 },
    { x: 0.22, y: -0.29 },
    { x: 0.39, y: -0.03, destination: true },
    { x: 0.19, y: 0.27 },
    { x: -0.16, y: 0.34 },
    { x: -0.40, y: 0.12 }
  ];
  const edges = [
    [0, 1], [0, 2], [0, 3], [0, 5], [0, 7],
    [1, 2], [1, 7], [2, 3], [3, 4], [3, 5],
    [4, 5], [5, 6], [6, 7], [7, 0]
  ];
  const route = [0, 3, 4];

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * ratio);
    canvas.height = Math.round(window.innerHeight * ratio);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
  function ease(value) {
    value = clamp(value, 0, 1);
    return 1 - Math.pow(1 - value, 3);
  }
  function rgba(hex, alpha) {
    const value = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((value >> 16) & 255) + ',' +
      ((value >> 8) & 255) + ',' + (value & 255) + ',' + alpha + ')';
  }
  function nodePoint(node, cx, cy, radius) {
    return { x: cx + node.x * radius, y: cy + node.y * radius };
  }
  function drawLine(a, b, progress, color, alpha, width) {
    const x = a.x + (b.x - a.x) * progress;
    const y = a.y + (b.y - a.y) * progress;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();
  }
  function drawArrow(from, to, progress, alpha) {
    const x = from.x + (to.x - from.x) * progress;
    const y = from.y + (to.y - from.y) * progress;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = COLORS.white;
    ctx.shadowBlur = 14;
    ctx.shadowColor = COLORS.cyan;
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(-7, -6);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-7, 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  function drawLocationPin(x, y, alpha, scale) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.fillStyle = COLORS.cyan;
    ctx.shadowBlur = 20;
    ctx.shadowColor = COLORS.cyan;
    ctx.beginPath();
    ctx.arc(0, -5, 10, Math.PI, 0);
    ctx.bezierCurveTo(10, 2, 3, 10, 0, 14);
    ctx.bezierCurveTo(-3, 10, -10, 2, -10, -5);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = COLORS.bg;
    ctx.beginPath();
    ctx.arc(0, -5, 3.3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function draw(now) {
    if (complete) return;
    const t = clamp((now - start) / duration, 0, 1);
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cx = W / 2;
    const cy = H * 0.43;
    const radius = Math.min(W, H) * 0.74;
    const dotIn = ease(t / 0.17);
    const networkIn = ease((t - 0.16) / 0.35);
    const routeIn = ease((t - 0.43) / 0.38);
    const routeOut = 1 - ease((t - 0.78) / 0.14);
    const brandIn = ease((t - 0.62) / 0.24);
    const fade = ease((t - 0.84) / 0.16);

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.8);
    glow.addColorStop(0, rgba(COLORS.blue, 0.2));
    glow.addColorStop(1, rgba(COLORS.bg, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    const points = nodes.map(function (node) {
      return nodePoint(node, cx, cy, radius);
    });

    /* 0.0–0.5s: current position appears as one GPS point and pulse. */
    if (dotIn > 0) {
      const pulse = (t * 3.2) % 1;
      ctx.save();
      ctx.globalAlpha = dotIn * (1 - pulse) * 0.42;
      ctx.strokeStyle = COLORS.cyan;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 13 + pulse * 30, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      drawLocationPin(cx, cy, dotIn, 0.72 + dotIn * 0.28);
    }

    /* 0.5–1.2s: surrounding nodes and thin campus-network roads appear. */
    if (networkIn > 0) {
      edges.forEach(function (edge, index) {
        const edgeIn = ease((t - 0.18 - index * 0.025) / 0.26);
        drawLine(points[edge[0]], points[edge[1]], edgeIn,
          COLORS.line, edgeIn * 0.85, 1.3);
      });
      points.forEach(function (point, index) {
        if (index === 0) return;
        const nodeIn = ease((t - 0.22 - index * 0.035) / 0.24);
        ctx.save();
        ctx.globalAlpha = nodeIn * 0.95;
        ctx.fillStyle = index === 4 ? COLORS.mint : COLORS.electric;
        ctx.shadowBlur = index === 4 ? 18 : 10;
        ctx.shadowColor = ctx.fillStyle;
        ctx.beginPath();
        ctx.arc(point.x, point.y, index === 4 ? 5.5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      });
    }

    /* 1.2–1.8s: route calculates from the current point to a destination. */
    if (routeIn > 0) {
      drawLine(points[0], points[3], routeIn, COLORS.cyan, routeOut, 3.8);
      drawLine(points[3], points[4], clamp((routeIn - 0.42) / 0.58, 0, 1),
        COLORS.cyan, routeOut, 3.8);
      const arrowProgress = (t * 2.1) % 1;
      if (routeIn > 0.35) {
        drawArrow(points[0], points[3], arrowProgress, routeOut);
        if (arrowProgress > 0.58) {
          drawArrow(points[3], points[4], (arrowProgress - 0.58) / 0.42, routeOut);
        }
      }
      drawLocationPin(points[4].x, points[4].y, routeIn * routeOut, 0.55);
    }

    /* 1.8–2.4s: the living network resolves into a universal product name. */
    if (brandIn > 0) {
      const scale = 0.88 + brandIn * 0.12;
      ctx.save();
      ctx.globalAlpha = brandIn;
      ctx.translate(cx, cy + radius * 0.56);
      ctx.scale(scale, scale);
      ctx.fillStyle = COLORS.white;
      ctx.font = '700 ' + Math.max(19, Math.min(28, W * 0.065)) +
        'px Poppins, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('CAMPUS NAVIGATOR', 0, 0);
      ctx.fillStyle = COLORS.muted;
      ctx.font = '500 10px Poppins, sans-serif';
      ctx.fillText('YOUR ROUTE IS READY', 0, 22);
      ctx.restore();
      drawLocationPin(cx, cy + radius * 0.56 - 25, brandIn, 0.43);
    }

    /* 2.4–2.8s: reveal the already-loaded homepage from bottom to top. */
    if (fade > 0) {
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, W, H * (1 - fade));
      ctx.restore();
    }

    if (t < 1) requestAnimationFrame(draw);
    else finish();
  }

  requestAnimationFrame(draw);
})();