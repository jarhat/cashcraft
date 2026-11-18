import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setupMediaSlideshow } from '../src/media-slideshow.js';

function fixture(reducedMotion = false, observeVisibility = false) {
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
  const disclosure = { open: true };
  const motion = { matches: reducedMotion };
  const document = { hidden: false, activeElement: null };
  const original = { window: globalThis.window, document: globalThis.document, setInterval: globalThis.setInterval, IntersectionObserver: globalThis.IntersectionObserver };
  let tick;
  let intersection;
  globalThis.window = { matchMedia: () => motion };
  if (observeVisibility) {
    globalThis.IntersectionObserver = class {
      constructor(callback) { intersection = callback; }
      observe() {}
    };
    globalThis.window.IntersectionObserver = globalThis.IntersectionObserver;
  }
  globalThis.document = document;
  globalThis.setInterval = (callback, delay) => { tick = callback; assert.equal(delay, 6000); };
  setupMediaSlideshow((id) => id === 'media-gallery' ? gallery : id === 'media-gallery-disclosure' ? disclosure : { querySelectorAll: () => cards });
  return { cards, gallery, disclosure, motion, document, tick, setVisible(value) { intersection([{ isIntersecting: value }]); }, restore() { Object.assign(globalThis, original); } };
}

test('the slideshow stays paused while the gallery is collapsed', () => {
  const { cards, disclosure, tick, restore } = fixture();
  try {
    disclosure.open = false;
    tick();
    assert.equal(cards[0].nodes.strong.textContent, undefined);
    disclosure.open = true;
    tick();
    assert.equal(cards[0].nodes.strong.textContent, 'Get BCH Now: Level Clear');
  } finally { restore(); }
});

test('gallery starts collapsed and keeps the swap information visible outside it', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<details id="media-gallery-disclosure">/);
  assert.match(html, /<\/details>\s*<p class="swap-note">Have BTC\?/);
});

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

test('slideshow avoids fetching new images while the gallery is offscreen', () => {
  const { cards, tick, setVisible, restore } = fixture(false, true);
  try {
    tick();
    assert.equal(cards[0].nodes.strong.textContent, undefined);
    setVisible(true);
    tick();
    assert.equal(cards[0].nodes.strong.textContent, 'Get BCH Now: Level Clear');
    setVisible(false);
    tick();
    assert.equal(cards[0].nodes.strong.textContent, 'Get BCH Now: Level Clear');
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
