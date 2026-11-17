import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupScrollEffects, updatePanelFades, updateScrollEffects } from '../src/scroll-effects.js';

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
    menu: { open: false },
    querySelector(selector) { return selector === '.token-options[open]' && this.menu.open ? this.menu : null; },
    style: {
      setProperty(name, value) { this[name] = value; },
      getPropertyValue(name) { return this[name] || ''; },
      removeProperty(name) { delete this[name]; },
    },
    classList: {
      values: new Set(),
      add(name) { this.values.add(name); },
      remove(name) { this.values.delete(name); },
      contains(name) { return this.values.has(name); },
    },
  };
  updatePanelFades(bar, [panel]);
  assert.equal(panel.classList.values.has('under-topbar'), false);
  panel.bounds = { top: 132, bottom: 282, height: 150 };
  updatePanelFades(bar, [panel]);
  assert.equal(panel.style['--fade-under-bar'], '-12px');
  assert.equal(panel.classList.values.has('under-topbar'), true);
  panel.bounds = { top: 80.5, bottom: 230.5, height: 150 };
  updatePanelFades(bar, [panel]);
  assert.equal(panel.style['--fade-under-bar'], '39.5px');
  assert.equal(panel.classList.values.has('under-topbar'), true);
  panel.menu.open = true;
  updatePanelFades(bar, [panel]);
  assert.equal(panel.menu.open, false);
  assert.equal(panel.classList.values.has('under-topbar'), true);
  panel.bounds = { top: -160, bottom: -10, height: 150 };
  updatePanelFades(bar, [panel]);
  assert.equal(panel.classList.values.has('under-topbar'), false);
  assert.equal(panel.style['--fade-under-bar'], undefined);
});

test('scroll updates the fade immediately without scheduling another frame', () => {
  const original = { window: globalThis.window, document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame };
  const listeners = {};
  let frames = 0;
  const bar = { getBoundingClientRect: () => ({ height: 100, bottom: 100 }) };
  const panel = {
    top: 140,
    getBoundingClientRect() { return { top: this.top, bottom: this.top + 200, height: 200 }; },
    querySelector() { return null; },
    style: {
      setProperty(name, value) { this[name] = value; },
      getPropertyValue(name) { return this[name] || ''; },
      removeProperty(name) { delete this[name]; },
    },
    classList: {
      active: false,
      add() { this.active = true; },
      remove() { this.active = false; },
      contains(name) { return name === 'panel' || (name === 'under-topbar' && this.active); },
    },
  };
  globalThis.window = { addEventListener(type, handler) { listeners[type] = handler; } };
  globalThis.document = {
    documentElement: { style: { setProperty() {} } },
    querySelector(selector) { return selector === '.topbar' ? bar : selector === '#panel-outline-layer' ? { style: {}, append() {} } : {}; },
    createElement() { return { style: {}, remove() {} }; },
    querySelectorAll(selector) { return selector === '.token-options' ? [] : [panel]; },
  };
  globalThis.requestAnimationFrame = () => { frames++; };
  try {
    setupScrollEffects();
    panel.top = 40;
    listeners.scroll();
    assert.equal(panel.style['--fade-under-bar'], '60px');
    assert.equal(frames, 0);
  } finally {
    Object.assign(globalThis, original);
  }
});

test('outlines follow panels only while they cross the header and are removed when panels move', () => {
  const original = globalThis.document;
  const created = [];
  globalThis.document = {
    createElement() {
      const element = { style: {}, remove() { this.removed = true; } };
      created.push(element);
      return element;
    },
  };
  const layer = { style: {}, append() {} };
  const outlines = { layer, items: new Map() };
  const panel = {
    bounds: { left: 20, top: 50, width: 300, height: 200, bottom: 250 },
    getBoundingClientRect() { return this.bounds; },
    querySelector() { return null; },
    style: { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} },
    classList: { active: false, add() { this.active = true; }, remove() { this.active = false; }, contains(name) { return name === 'panel' || (name === 'under-topbar' && this.active); } },
  };
  const bar = { getBoundingClientRect: () => ({ bottom: 100 }) };
  try {
    updatePanelFades(bar, [panel], outlines);
    assert.equal(layer.style.height, '100px');
    assert.equal(created[0].style.transform, 'translate(20px, 50px)');
    assert.equal(created[0].style.width, '300px');
    panel.bounds.top = 20;
    updatePanelFades(bar, [panel], outlines);
    assert.equal(created.length, 1);
    assert.equal(created[0].style.transform, 'translate(20px, 20px)');
    updatePanelFades(bar, [], outlines);
    assert.equal(created[0].removed, true);
    assert.equal(outlines.items.size, 0);
    panel.classList.contains = (name) => name === 'under-topbar' && panel.classList.active;
    updatePanelFades(bar, [panel], outlines);
    assert.equal(outlines.items.size, 0);
  } finally { globalThis.document = original; }
});
