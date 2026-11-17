export function setupSnow(canvas) {
  const ctx = canvas?.getContext?.('2d');
  if (!ctx) return () => {};
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0;
  let height = 0;
  let flakes = [];
  let layers = [];
  let frame = 0;
  let last = 0;
  let lastScroll = -Infinity;

  const makeFlake = () => {
    const depth = Math.random() ** 1.6;
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      r: 0.6 + depth * 2.2,
      vy: 14 + depth * 56,
      alpha: 0.25 + depth * 0.6,
      phase: Math.random() * Math.PI * 2,
      sway: 6 + Math.random() * 16,
      freq: 0.4 + Math.random() * 0.8,
    };
  };

  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const count = Math.min(130, Math.round((width * height) / 11000));
    flakes = Array.from({ length: count }, makeFlake);
    layers = Array.from({ length: 8 }, () => []);
    for (const flake of flakes) layers[Math.min(7, Math.floor((flake.alpha - 0.25) / 0.6 * 8))].push(flake);
    if (motion.matches) render();
  };

  const render = () => {
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    for (const [index, layer] of layers.entries()) {
      ctx.globalAlpha = 0.25 + (index + 0.5) * 0.6 / 8;
      ctx.beginPath();
      for (const f of layer) {
        ctx.moveTo(f.x + f.r, f.y);
        ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  const draw = (time) => {
    const elapsed = time - last;
    if (elapsed < 1000 / (time - lastScroll < 200 ? 15 : 30)) {
      frame = requestAnimationFrame(draw);
      return;
    }
    const dt = Math.min(elapsed / 1000, 0.1);
    last = time;
    const wind = Math.sin(time / 7000) * 10;
    for (const f of flakes) {
      const flutter = Math.sin(time / 1000 * f.freq + f.phase);
      f.y += f.vy * (1 + flutter * 0.1) * dt;
      f.x += (wind * (0.4 + f.r / 3) + flutter * f.sway) * dt;
      if (f.y > height + 10) {
        f.x = Math.random() * width;
        f.y = -10;
      }
      if (f.x < -10) f.x = width + 10;
      else if (f.x > width + 10) f.x = -10;
    }
    render();
    frame = requestAnimationFrame(draw);
  };

  const start = () => {
    if (frame || motion.matches || document.hidden) return;
    last = performance.now();
    frame = requestAnimationFrame(draw);
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    frame = 0;
  };
  const onVisibility = () => (document.hidden ? stop() : start());
  const onScroll = () => { lastScroll = performance.now(); };
  const onMotionChange = () => {
    if (motion.matches) {
      stop();
      render();
    } else {
      start();
    }
  };

  resize();
  start();
  window.addEventListener('resize', resize);
  window.addEventListener('scroll', onScroll, { passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  if (motion.addEventListener) motion.addEventListener('change', onMotionChange);
  else motion.addListener(onMotionChange);
  return () => {
    stop();
    window.removeEventListener('resize', resize);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', onVisibility);
    if (motion.removeEventListener) motion.removeEventListener('change', onMotionChange);
    else motion.removeListener(onMotionChange);
  };
}
