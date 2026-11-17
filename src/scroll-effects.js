export function updateScrollEffects(topbar) {
  const height = topbar.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--topbar-height', `${Math.ceil(height)}px`);
}

export function updatePanelFades(topbar, panels) {
  const bottom = Math.max(0, topbar.getBoundingClientRect().bottom);
  for (const panel of panels) {
    const bounds = panel.getBoundingClientRect();
    if (bounds.height && bounds.top < bottom && bounds.bottom > 0 && !panel.querySelector('.token-options[open]')) {
      panel.style.setProperty('--fade-under-bar', `${Math.round(bottom - bounds.top)}px`);
      panel.classList.add('under-topbar');
    } else {
      panel.classList.remove('under-topbar');
      panel.style.removeProperty('--fade-under-bar');
    }
  }
}

export function setupScrollEffects() {
  const topbar = document.querySelector('.topbar');
  const dashboard = document.querySelector('.dashboard');
  let scheduled = false;
  const update = () => {
    scheduled = false;
    updateScrollEffects(topbar);
    updatePanelFades(topbar, document.querySelectorAll('.dashboard > .panel, .dashboard > .wizard-dialog'));
  };
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(update);
    }
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, { passive: true });
  document.querySelectorAll('.token-options').forEach((options) => options.addEventListener('toggle', schedule));
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(schedule);
    observer.observe(topbar);
    observer.observe(dashboard);
  }
  update();
}
