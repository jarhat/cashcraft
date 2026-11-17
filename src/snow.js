// Lightweight canvas snowfall: depth-based size/speed, gentle wind sway, pauses when hidden.
export function setupSnow(canvas) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return () => {};
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let width = 0;
  let height = 0;
  let flakes = [];
  let frame = 0;
  let last = 0;
  let wind = 0;

  const makeFlake = (initial) => {
    const depth = Math.random() ** 1.6; // 0 = far, 1 = near
    return {
      x: Math.random() * width,
      y: initial ? Math.random() * height : -10,
      r: 0.6 + depth * 2.2,
      vy: 14 + depth * 56,
      alpha: 0.25 + depth * 0.6,
      phase: Math.random() * Math.PI * 2,
      sway: 6 + Math.random() * 16,
      freq: 0.4 + Math.random() * 0.8,
    };
  };

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.min(130, Math.round((width * height) / 11000));
    flakes = Array.from({ length: count }, () => makeFlake(true));
  };

  const draw = (time) => {
    const dt = Math.min((time - last) / 1000 || 0, 0.05);
    last = time;
    wind = Math.sin(time / 7000) * 10;
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    for (const f of flakes) {
      f.y += f.vy * dt;
      f.x += (wind * (0.4 + f.r / 3) + Math.sin(time / 1000 * f.freq + f.phase) * f.sway) * dt;
      if (f.y > height + 10) Object.assign(f, makeFlake(false), { x: Math.random() * width });
      if (f.x < -10) f.x = width + 10;
      else if (f.x > width + 10) f.x = -10;
      ctx.globalAlpha = f.alpha;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    frame = requestAnimationFrame(draw);
  };

  const start = () => {
    if (frame || reduced) return;
    last = performance.now();
    frame = requestAnimationFrame(draw);
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const onVisibility = () => (document.hidden ? stop() : start());

  resize();
  if (reduced) {
    // Static flakes for reduced-motion users.
    ctx.fillStyle = '#fff';
    for (const f of flakes) {
      ctx.globalAlpha = f.alpha * 0.7;
      ctx.beginPath();
      ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    start();
  }
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    stop();
    window.removeEventListener('resize', resize);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
