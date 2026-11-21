import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setupMediaSlideshow } from '../src/media-slideshow.js';

function fixture(reducedMotion = false, observeVisibility = false, withRails = false) {
  const createElement = () => ({
    listeners: {}, style: {}, children: [], attributes: {}, classList: { toggle() {} },
    get childElementCount() { return this.children.length; },
    addEventListener(type, handler) { this.listeners[type] = handler; },
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this.attributes[name] = value; },
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
  const wide = createElement();
  const rails = withRails ? [createElement(), createElement()] : [];
  const document = { ...createElement(), createElement, hidden: false, activeElement: null };
  const original = { window: globalThis.window, document: globalThis.document, setInterval: globalThis.setInterval, IntersectionObserver: globalThis.IntersectionObserver };
  let tick;
  let intersection;
  globalThis.window = { matchMedia: (query) => query.includes('min-width') ? wide : motion };
  if (observeVisibility) {
    globalThis.IntersectionObserver = class {
      constructor(callback) { intersection = callback; }
      observe() {}
    };
    globalThis.window.IntersectionObserver = globalThis.IntersectionObserver;
  }
  globalThis.document = document;
  globalThis.setInterval = (callback, delay) => { tick = callback; assert.equal(delay, 6000); };
  const elements = {
    'media-gallery': gallery, 'media-gallery-disclosure': disclosure,
    'media-strip': { querySelectorAll: () => cards },
    'media-rail-left': rails[0], 'media-rail-right': rails[1],
  };
  setupMediaSlideshow((id) => elements[id]);
  return { cards, gallery, disclosure, motion, document, rails, wide, tick, setVisible(value) { intersection([{ isIntersecting: value }]); }, restore() { Object.assign(globalThis, original); } };
}

test('wide rails split the artwork without duplicate keyboard stops', () => {
  const { rails, wide, restore } = fixture(false, false, true);
  try {
    assert.ok(rails.every((rail) => rail.childElementCount === 0));
    wide.matches = true;
    wide.listeners.change();
    const sources = new Set();
    for (const { children: [original, repeat] } of rails) {
      assert.equal(repeat.attributes['aria-hidden'], 'true');
      assert.deepEqual(repeat.children.map(({ href }) => href), original.children.map(({ href }) => href));
      assert.ok(repeat.children.every((link) => link.tabIndex === -1));
      for (const { href, children: [image] } of original.children) {
        assert.ok(image.alt);
        sources.add(href);
      }
    }
    assert.equal(sources.size, 16);
    const [image, fallback] = rails[0].children[0].children[0].children;
    image.listeners.error();
    assert.equal(image.hidden, true);
    assert.equal(fallback.hidden, false);
    wide.listeners.change();
    assert.ok(rails.every((rail) => rail.childElementCount === 2));
  } finally { restore(); }
});

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

test('the landing page shows the gallery above the footer without a wallet', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(html, /<aside id="media-gallery" class="media-gallery" aria-label="Bitcoin Cash media">\s*<details id="media-gallery-disclosure" open>[\s\S]*?<\/aside>\s*<footer>/);
  assert.match(html, /<\/details>\s*<p class="swap-note" data-wallet-panel hidden>Have BTC\?/);
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
