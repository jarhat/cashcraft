import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updatePanelFades, updateScrollEffects } from '../src/scroll-effects.js';

test('panel scroll offset tracks the actual navbar height', () => {
  const previous = globalThis.document;
  const properties = {};
  globalThis.document = { documentElement: { style: { setProperty: (name, value) => { properties[name] = value; } } } };
  try {
    const bar = { getBoundingClientRect: () => ({ height: 75.5 }) };
    updateScrollEffects(bar);
    assert.equal(properties['--topbar-height'], '76px');
    bar.getBoundingClientRect = () => ({ height: 120 });
    updateScrollEffects(bar);
    assert.equal(properties['--topbar-height'], '120px');
  } finally {
    globalThis.document = previous;
  }
});

test('only panels crossing the sticky header are masked and the mask follows its measured position', () => {
  const bar = { getBoundingClientRect: () => ({ bottom: 120 }) };
  const panel = {
    bounds: { top: 150, bottom: 300, height: 150 },
    getBoundingClientRect() { return this.bounds; },
    menuOpen: false,
    querySelector(selector) { return selector === '.token-options[open]' && this.menuOpen ? {} : null; },
    style: {
      setProperty(name, value) { this[name] = value; },
      removeProperty(name) { delete this[name]; },
    },
    classList: {
      values: new Set(),
      add(name) { this.values.add(name); },
      remove(name) { this.values.delete(name); },
    },
  };
  updatePanelFades(bar, [panel]);
  assert.equal(panel.classList.values.has('under-topbar'), false);
  panel.bounds = { top: 80, bottom: 230, height: 150 };
  updatePanelFades(bar, [panel]);
  assert.equal(panel.style['--fade-under-bar'], '40px');
  assert.equal(panel.classList.values.has('under-topbar'), true);
  panel.menuOpen = true;
  updatePanelFades(bar, [panel]);
  assert.equal(panel.classList.values.has('under-topbar'), false);
  assert.equal(panel.style['--fade-under-bar'], undefined);
  panel.menuOpen = false;
  updatePanelFades(bar, [panel]);
  assert.equal(panel.classList.values.has('under-topbar'), true);
  panel.bounds = { top: -160, bottom: -10, height: 150 };
  updatePanelFades(bar, [panel]);
  assert.equal(panel.classList.values.has('under-topbar'), false);
  assert.equal(panel.style['--fade-under-bar'], undefined);
});
