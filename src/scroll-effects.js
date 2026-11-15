export function updateScrollEffects(topbar) {
  const height = topbar.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--topbar-height', `${Math.ceil(height)}px`);
}

export function setupScrollEffects() {
  const topbar = document.querySelector('.topbar');
  const update = () => updateScrollEffects(topbar);
  window.addEventListener('resize', update);
  if ('ResizeObserver' in window) new ResizeObserver(update).observe(topbar);
  update();
}
