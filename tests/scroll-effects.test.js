import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupScrollEffects, updateScrollEffects } from '../src/scroll-effects.js';

test('panel scroll offset tracks the actual navbar height', () => {
  const previous = globalThis.document;
  const properties = {};
  globalThis.document = { documentElement: { style: { setProperty: (name, value) => { properties[name] = value; } } } };
  try {
    const bar = { getBoundingClientRect: () => ({ height: 75.5 }) };
    updateScrollEffects(bar);
    assert.equal(properties['--topbar-height'], '76px');
  } finally { globalThis.document = previous; }
});

test('header height updates are coalesced on resize without scroll-time layout work', () => {
  const original = { window: globalThis.window, document: globalThis.document, requestAnimationFrame: globalThis.requestAnimationFrame };
  const listeners = {};
  const frames = [];
  let height = 100;
  const properties = {};
  globalThis.window = { addEventListener(type, handler) { listeners[type] = handler; } };
  globalThis.document = {
    documentElement: { style: { setProperty(name, value) { properties[name] = value; } } },
    querySelector: () => ({ getBoundingClientRect: () => ({ height }) }),
  };
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  try {
    setupScrollEffects();
    assert.equal(listeners.scroll, undefined);
    height = 120;
    listeners.resize();
    listeners.resize();
    assert.equal(frames.length, 1);
    frames[0]();
    assert.equal(properties['--topbar-height'], '120px');
  } finally { Object.assign(globalThis, original); }
});
