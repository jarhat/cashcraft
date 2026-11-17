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
  if (outlines && outlines.layer.style.height !== `${bottom}px`) outlines.layer.style.height = `${bottom}px`;
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
      const transform = `translate(${bounds.left}px, ${bounds.top}px)`;
      const width = `${bounds.width}px`;
      const height = `${bounds.height}px`;
      if (outline.style.transform !== transform) outline.style.transform = transform;
      if (outline.style.width !== width) outline.style.width = width;
      if (outline.style.height !== height) outline.style.height = height;
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
  let geometryDirty = false;
  const updateFades = () => updatePanelFades(topbar, document.querySelectorAll('.dashboard > .panel, .dashboard > .wizard-dialog, .media-gallery, #log, .chain-decoration, footer'), outlines);
  const update = () => {
    scheduled = false;
    if (geometryDirty) {
      geometryDirty = false;
      updateScrollEffects(topbar);
    }
    updateFades();
  };
  const schedule = () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(update);
    }
  };
  const scheduleGeometry = () => {
    geometryDirty = true;
    schedule();
  };
  window.addEventListener('resize', scheduleGeometry);
  window.addEventListener('scroll', schedule, { passive: true });
  document.querySelectorAll('.token-options').forEach((options) => options.addEventListener('toggle', scheduleGeometry));
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(scheduleGeometry);
    observer.observe(topbar);
    observer.observe(dashboard);
  }
  geometryDirty = true;
  update();
}
