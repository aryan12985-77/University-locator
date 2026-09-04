/* ================================================================
   Campus Navigator — "Compass Bloom" first-visit intro
   A short, mobile-friendly constellation animation that reveals the
   campus compass in 2.6 seconds. It runs once per browser tab session.
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
    /* Private browsing can block storage; play once for that page load. */
  }

  if (alreadySeen || reducedMotion) {
    finish();
    return;
  }

  const COLORS = {
    bg: '#07111f',
    indigo: '#818cf8',
    cyan: '#67e8f9',
    mint: '#6ee7b7',
    white: '#f8fafc',
    muted: '#94a3b8'
  };
  const duration = 2600;
  const start = performance.now();
  const points = [
    { angle: -Math.PI * 0.78, radius: 0.27, label: 'Learn' },
    { angle: -Math.PI * 0.08, radius: 0.31, label: 'Explore' },
    { angle: Math.PI * 0.55, radius: 0.28, label: 'Arrive' }
  ];

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
  function pointAt(cx, cy, radius, angle) {
    return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
  }
  function drawArc(cx, cy, radius, startAngle, endAngle, alpha, width) {
    ctx.save();
    ctx.strokeStyle = rgba(COLORS.cyan, alpha);
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, endAngle);
    ctx.stroke();
    ctx.restore();
  }

  function draw(now) {
    if (complete) return;
    const elapsed = now - start;
    const t = clamp(elapsed / duration, 0, 1);
    const W = window.innerWidth;
    const H = window.innerHeight;
    const cx = W / 2;
    const cy = H * 0.45;
    const radius = Math.min(W, H) * 0.31;
    const rotation = (t * Math.PI * 0.18) - Math.PI * 0.09;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);

    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.7);
    glow.addColorStop(0, rgba(COLORS.indigo, 0.18));
    glow.addColorStop(1, rgba(COLORS.bg, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    /* The bloom opens as three soft compass petals rather than a normal map route. */
    const bloom = ease(t / 0.68);
    for (let i = 0; i < 3; i++) {
      const angle = rotation + i * (Math.PI * 2 / 3);
      drawArc(cx, cy, radius * (0.62 + i * 0.15),
        angle - 0.7 * bloom, angle + 0.7 * bloom,
        0.23 + i * 0.06, 3.5);
    }

    const orbit = ease((t - 0.13) / 0.57);
    points.forEach(function (item, index) {
      const p = pointAt(cx, cy, radius * item.radius / 0.31,
        item.angle + rotation + orbit * 0.12);
      const appear = ease((t - index * 0.08) / 0.38);
      ctx.save();
      ctx.globalAlpha = appear;
      ctx.fillStyle = index === 1 ? COLORS.mint : COLORS.cyan;
      ctx.shadowBlur = 18;
      ctx.shadowColor = ctx.fillStyle;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.globalAlpha = appear * 0.72;
      ctx.fillStyle = COLORS.muted;
      ctx.font = '500 11px Poppins, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(item.label, p.x, p.y + 24);
      ctx.restore();
    });

    /* Center compass bloom settles into the app's location mark. */
    const centerIn = ease((t - 0.18) / 0.52);
    const centerPulse = 1 + Math.sin(t * Math.PI * 7) * 0.04;
    ctx.save();
    ctx.globalAlpha = centerIn;
    ctx.translate(cx, cy);
    ctx.rotate(rotation * 0.5);
    ctx.scale(centerPulse, centerPulse);
    ctx.fillStyle = COLORS.white;
    ctx.shadowBlur = 24;
    ctx.shadowColor = COLORS.cyan;
    ctx.beginPath();
    ctx.moveTo(0, -21);
    ctx.lineTo(8, 7);
    ctx.lineTo(0, 2);
    ctx.lineTo(-8, 7);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = COLORS.indigo;
    ctx.beginPath();
    ctx.arc(0, 0, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    const titleIn = ease((t - 0.52) / 0.35);
    const titleOut = 1 - ease((t - 0.84) / 0.16);
    ctx.save();
    ctx.globalAlpha = titleIn * titleOut;
    ctx.fillStyle = COLORS.white;
    ctx.font = '700 ' + Math.max(18, Math.min(25, W * 0.06)) + 'px Poppins, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = COLORS.muted;
    ctx.font = '500 10px Poppins, sans-serif';
    ctx.letterSpacing = '2px';
    ctx.fillText('FIND YOUR NEXT PLACE', cx, cy + radius * 0.82 + 22);
    ctx.restore();

    if (t < 1) requestAnimationFrame(draw);
    else finish();
  }

  requestAnimationFrame(draw);
})();