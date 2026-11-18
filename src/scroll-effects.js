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
