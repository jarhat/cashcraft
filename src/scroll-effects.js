export function updateScrollEffects(topbar) {
  const height = topbar.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--topbar-height', `${Math.ceil(height)}px`);
}

export function updatePanelFades(topbar, panels) {
  const bottom = Math.max(0, topbar.getBoundingClientRect().bottom);
  const updates = [...panels].map((panel) => {
    const bounds = panel.getBoundingClientRect();
    const fade = bounds.height && bounds.top < bottom + 16 && bounds.bottom > 0 ? `${bottom - bounds.top}px` : '';
    const openMenu = fade && bounds.top < bottom ? panel.querySelector('.token-options[open]') : null;
    return { panel, fade, openMenu };
  });
  for (const { panel, fade, openMenu } of updates) {
    if (openMenu) openMenu.open = false;
    if (fade) {
      if (panel.style.getPropertyValue('--fade-under-bar') !== fade) {
        panel.style.setProperty('--fade-under-bar', fade);
      }
      if (!panel.classList.contains('under-topbar')) panel.classList.add('under-topbar');
    } else if (panel.classList.contains('under-topbar')) {
      panel.classList.remove('under-topbar');
      panel.style.removeProperty('--fade-under-bar');
    }
  }
}

export function setupScrollEffects() {
  const topbar = document.querySelector('.topbar');
  const dashboard = document.querySelector('.dashboard');
  let scheduled = false;
  const updateFades = () => updatePanelFades(topbar, document.querySelectorAll('.dashboard > .panel, .dashboard > .wizard-dialog'));
  const update = () => {
    scheduled = false;
    updateScrollEffects(topbar);
    updateFades();
  };
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(update);
    }
  };
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', updateFades, { passive: true });
  document.querySelectorAll('.token-options').forEach((options) => options.addEventListener('toggle', schedule));
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(schedule);
    observer.observe(topbar);
    observer.observe(dashboard);
  }
  update();
}
