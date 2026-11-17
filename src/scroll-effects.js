export function updateScrollEffects(topbar) {
  const height = topbar.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--topbar-height', `${Math.ceil(height)}px`);
}

export function updatePanelFades(topbar, panels, outlines) {
  const bottom = Math.max(0, topbar.getBoundingClientRect().bottom);
  const updates = [...panels].map((panel) => {
    const bounds = panel.getBoundingClientRect();
    const fade = bounds.height && bounds.top < bottom + 16 && bounds.bottom > 0 ? `${bottom - bounds.top}px` : '';
    const openMenu = fade && bounds.top < bottom ? panel.querySelector('.token-options[open]') : null;
    const showOutline = bounds.height && bounds.top < bottom && bounds.bottom > 0
      && (panel.classList.contains('panel') || panel.classList.contains('wizard-dialog'));
    return { panel, bounds, fade, openMenu, showOutline };
  });
  if (outlines) outlines.layer.style.height = `${bottom}px`;
  const active = new Set();
  for (const { panel, bounds, fade, openMenu, showOutline } of updates) {
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
    if (outlines && showOutline) {
      active.add(panel);
      let outline = outlines.items.get(panel);
      if (!outline) {
        outline = document.createElement('div');
        outline.className = panel.classList.contains('wizard-dialog') ? 'panel-outline guide-outline' : 'panel-outline';
        outlines.layer.append(outline);
        outlines.items.set(panel, outline);
      }
      outline.style.transform = `translate(${bounds.left}px, ${bounds.top}px)`;
      outline.style.width = `${bounds.width}px`;
      outline.style.height = `${bounds.height}px`;
    }
  }
  if (outlines) {
    for (const [panel, outline] of outlines.items) {
      if (!active.has(panel)) {
        outline.remove();
        outlines.items.delete(panel);
      }
    }
  }
}

export function setupScrollEffects() {
  const topbar = document.querySelector('.topbar');
  const dashboard = document.querySelector('.dashboard');
  const outlines = { layer: document.querySelector('#panel-outline-layer'), items: new Map() };
  let scheduled = false;
  const updateFades = () => updatePanelFades(topbar, document.querySelectorAll('.dashboard > .panel, .dashboard > .wizard-dialog, .media-gallery, #log, .chain-decoration, footer'), outlines);
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
