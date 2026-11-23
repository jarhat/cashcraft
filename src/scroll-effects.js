export function scrollEffects(nav, hero, firstPanel, lastPanel) {
  const height = Math.max(nav.bottom - nav.top, 1);
  const overlap = Math.max(0, Math.min(1,
    (nav.bottom - firstPanel.top) / height,
    (lastPanel.bottom - nav.top) / height,
  ));
  const cutoff = Math.max(0, nav.bottom - hero.top);
  return { opacity: 1 - overlap, cutoff, fadeEnd: cutoff ? cutoff + 28 : 0 };
}

export function updateScrollEffects(topbar) {
  const height = topbar.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--topbar-height', `${Math.ceil(height)}px`);
}

export function setupScrollEffects() {
  const topbar = document.querySelector('.topbar');
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      updateScrollEffects(topbar);
    });
  };
  window.addEventListener('resize', schedule);
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(schedule);
    observer.observe(topbar);
  }
  updateScrollEffects(topbar);
}
