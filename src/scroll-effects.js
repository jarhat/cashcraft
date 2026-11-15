export function updateScrollEffects(topbar, hero, panels) {
  const bar = topbar.getBoundingClientRect();
  const copy = hero.getBoundingClientRect();
  const overlap = Math.max(0, ...panels.map((panel) => {
    const rect = panel.getBoundingClientRect();
    if (rect.right <= bar.left || rect.left >= bar.right) return 0;
    return Math.max(0, Math.min(rect.bottom, bar.bottom) - Math.max(rect.top, bar.top));
  }));
  const opacity = 1 - Math.min(1, overlap / Math.max(1, bar.height));
  topbar.style.setProperty('--navbar-opacity', opacity);
  topbar.classList.toggle('is-obscured', opacity < 0.05);
  hero.style.setProperty('--hero-mask-start', `${Math.max(0, bar.top - copy.top)}px`);
  hero.style.setProperty('--hero-mask-end', `${Math.max(0, bar.bottom - copy.top + 12)}px`);
}

export function setupScrollEffects() {
  const topbar = document.querySelector('.topbar');
  const hero = document.querySelector('.hero-copy');
  const panels = [...document.querySelectorAll('.panel')];
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      updateScrollEffects(topbar, hero, panels);
    });
  };
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(schedule);
    [topbar, hero, ...panels].forEach((element) => observer.observe(element));
  }
  schedule();
}
