import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupMediaSlideshow } from '../src/media-slideshow.js';

function fixture(reducedMotion = false) {
  const createElement = () => ({
    listeners: {}, style: {},
    addEventListener(type, handler) { this.listeners[type] = handler; },
  });
  const cards = Array.from({ length: 3 }, () => {
    const nodes = {
      img: createElement(), '.media-unavailable': createElement(),
      a: createElement(), strong: createElement(), '.media-caption span': createElement(),
    };
    return { nodes, querySelector(selector) { return nodes[selector]; } };
  });
  const gallery = { matches: () => false, contains: () => false };
  const motion = { matches: reducedMotion };
  const document = { hidden: false, activeElement: null };
  const original = { window: globalThis.window, document: globalThis.document, setInterval: globalThis.setInterval };
  let tick;
  globalThis.window = { matchMedia: () => motion };
  globalThis.document = document;
  globalThis.setInterval = (callback, delay) => { tick = callback; assert.equal(delay, 6000); };
  setupMediaSlideshow((id) => id === 'media-gallery' ? gallery : { querySelectorAll: () => cards });
  return { cards, gallery, motion, document, tick, restore() { Object.assign(globalThis, original); } };
}

test('slideshow shows multiple uncropped sources and cycles through all artwork', () => {
  const { cards, tick, restore } = fixture();
  try {
    const links = new Set();
    for (let i = 0; i < 16; i++) {
      tick();
      for (const { nodes } of cards) {
        links.add(nodes.a.href);
        assert.match(nodes.img.src, /\/[0-9a-f]{10}\/thumb\.webp$/);
        assert.ok(nodes.img.alt);
      }
    }
    assert.equal(links.size, 16);
    assert.equal(cards[0].nodes.strong.textContent, 'Private Shadow');
    cards[0].nodes.img.listeners.error();
    assert.equal(cards[0].nodes['.media-unavailable'].hidden, false);
    tick();
    assert.equal(cards[0].nodes.img.hidden, false);
    assert.equal(cards[0].nodes['.media-unavailable'].hidden, true);
  } finally { restore(); }
});

test('slideshow pauses for reduced motion, hidden pages, hover and keyboard focus', () => {
  const { cards, gallery, motion, document, tick, restore } = fixture(true);
  try {
    tick();
    motion.matches = false;
    gallery.matches = () => true;
    tick();
    gallery.matches = () => false;
    gallery.contains = () => true;
    tick();
    gallery.contains = () => false;
    document.hidden = true;
    tick();
    assert.equal(cards[0].nodes.strong.textContent, undefined);
    document.hidden = false;
    tick();
    assert.equal(cards[0].nodes.strong.textContent, 'Get BCH Now: Level Clear');
  } finally { restore(); }
});
