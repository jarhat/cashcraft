import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTopCoins, setupMarketTicker } from '../src/market-ticker.js';

test('requests and renders the top 20 coins twice for a continuous ticker', async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalInterval = globalThis.setInterval;
  const coins = Array.from({ length: 20 }, (_, i) => ({ symbol: `coin${i}`, current_price: i + 0.1 }));
  let url, interval;
  class Element {
    constructor() { this.children = []; this.attributes = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    querySelector() { return this.children[0]; }
  }
  globalThis.fetch = async (input) => { url = input; return { ok: true, json: async () => coins }; };
  globalThis.document = { createElement: () => new Element() };
  globalThis.setInterval = (_, delay) => { interval = delay; };
  try {
    const container = new Element();
    setupMarketTicker(container, (text) => text);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(url, /order=market_cap_desc&per_page=20/);
    assert.equal(interval, 300_000);
    const [first, duplicate] = container.children[0].children;
    assert.equal(first.children.length, 20);
    assert.equal(duplicate.children.length, 20);
    assert.equal(first.children[0].children[0].textContent, 'COIN0');
    assert.equal(duplicate.attributes['aria-hidden'], 'true');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.document = originalDocument;
    globalThis.setInterval = originalInterval;
  }
});

test('rejects incomplete or malformed market results', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => [{ symbol: 'btc', current_price: 1 }] });
  try {
    await assert.rejects(fetchTopCoins(), /20 valid coins/);
  } finally { globalThis.fetch = originalFetch; }
});
