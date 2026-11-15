export function scrollEffects(nav, hero, firstPanel, lastPanel) {
  const height = Math.max(nav.bottom - nav.top, 1);
  const overlap = Math.max(0, Math.min(1,
    (nav.bottom - firstPanel.top) / height,
    (lastPanel.bottom - nav.top) / height,
  ));
  const cutoff = Math.max(0, nav.bottom - hero.top);
  return { opacity: 1 - overlap, cutoff, fadeEnd: cutoff ? cutoff + 28 : 0 };
}

export function initScrollEffects() {
  const nav = document.querySelector('.topbar');
  const fadeTargets = document.querySelectorAll('.hero-copy, .wizard-guide, .learn-section, footer, #log');
  const firstPanel = document.querySelector('#connection-section');
  const lastPanel = document.querySelector('#earn-section');
  let scheduled = false;

  function update() {
    scheduled = false;
    const navBounds = nav.getBoundingClientRect();
    const firstBounds = firstPanel.getBoundingClientRect();
    const lastBounds = lastPanel.getBoundingClientRect();
    const effect = scrollEffects(navBounds, fadeTargets[0].getBoundingClientRect(),
      firstBounds, lastBounds);
    nav.style.setProperty('--topbar-opacity', effect.opacity);
    nav.classList.toggle('over-panels', effect.opacity === 0);
    for (const target of fadeTargets) {
      const fade = scrollEffects(navBounds, target.getBoundingClientRect(), firstBounds, lastBounds);
      target.style.setProperty('--content-fade-start', `${effect.opacity ? fade.cutoff : 0}px`);
      target.style.setProperty('--content-fade-end', `${effect.opacity ? fade.fadeEnd : 0}px`);
    }
  }

  function schedule() {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(update);
    }
  }
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  update();
}
