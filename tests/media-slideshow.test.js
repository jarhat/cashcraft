import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupMediaSlideshow } from '../src/media-slideshow.js';

function fixture(reducedMotion = false) {
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {},
      style: {},
      addEventListener(type, handler) { this.listeners[type] = handler; },
      matches() { return this.hovered || false; },
      contains(element) { return element === this.focused; },
    });
    return elements.get(id);
  };
  const motion = { matches: reducedMotion };
  const document = { hidden: false, activeElement: null };
  const original = { window: globalThis.window, document: globalThis.document, setInterval: globalThis.setInterval };
  let tick;
  globalThis.window = { matchMedia: () => motion };
  globalThis.document = document;
  globalThis.setInterval = (callback, delay) => { tick = callback; assert.equal(delay, 6000); };
  setupMediaSlideshow($);
  return { $, tick, motion, document, restore() { Object.assign(globalThis, original); } };
}

test('slideshow automatically cycles through all supplied images and wraps', () => {
  const { $, tick, restore } = fixture();
  try {
    const links = new Set(['https://bch.now/media/private-shadow']);
    for (let i = 0; i < 15; i++) {
      tick();
      links.add($('media-link').href);
      assert.match($('media-image').src, /\/[0-9a-f]{10}\/thumb\.webp$/);
      assert.ok($('media-image').alt);
    }
    assert.equal(links.size, 16);
    assert.equal($('media-position').textContent, '16 / 16');
    tick();
    assert.equal($('media-link').href, 'https://bch.now/media/private-shadow');
    assert.equal($('media-position').textContent, '1 / 16');
    $('media-image').listeners.error();
    assert.equal($('media-unavailable').hidden, false);
    tick();
    assert.equal($('media-image').hidden, false);
    assert.equal($('media-unavailable').hidden, true);
  } finally { restore(); }
});

test('slideshow stops while hidden, hovered, focused or reduced motion is requested', () => {
  const { $, tick, motion, document, restore } = fixture(true);
  try {
    tick();
    assert.equal($('media-title').textContent, undefined);
    motion.matches = false;
    $('media-gallery').hovered = true;
    tick();
    $('media-gallery').hovered = false;
    document.activeElement = $('media-link');
    $('media-gallery').focused = $('media-link');
    tick();
    document.activeElement = null;
    document.hidden = true;
    tick();
    assert.equal($('media-title').textContent, undefined);
    document.hidden = false;
    tick();
    assert.equal($('media-title').textContent, 'Get BCH Now: Level Clear');
  } finally { restore(); }
});
