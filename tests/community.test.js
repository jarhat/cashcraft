import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupCommunity } from '../src/community.js';

function fixture(fetchImpl) {
  const nodes = new Map();
  const makeNode = () => ({
    children: [],
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
  });
  globalThis.document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, makeNode());
      return nodes.get(id);
    },
    createElement: makeNode,
  };
  globalThis.fetch = fetchImpl;
  globalThis.setInterval = () => {};
  return (id) => nodes.get(id);
}

test('renders up to 20 prices and only safe configured gallery and social links', async () => {
  const coins = Array.from({ length: 25 }, (_, i) => ({ symbol: `c${i}`, current_price: i + 1 }));
  const node = fixture(async (url) => ({
    ok: true,
    json: async () => url.includes('coingecko') ? coins : [
      { title: 'Artwork', image: 'https://example.com/image.png', url: 'https://bch.now/art' },
      { title: 'Unsafe', image: 'javascript:alert(1)', url: 'https://bch.now' },
    ],
  }));
  await setupCommunity({
    VITE_GITHUB_URL: 'https://github.com/jarhat/cashcraft',
    VITE_TELEGRAM_URL: 'javascript:alert(1)',
    VITE_GALLERY_FEED_URL: 'https://example.com/feed',
  });
  assert.equal(node('market-ticker').children.length, 20);
  assert.equal(node('gallery-feed').children.length, 1);
  assert.equal(node('gallery-feed').children[0].children[1].textContent, 'Artwork');
  assert.equal(node('social-github').hidden, false);
  assert.equal(node('social-telegram').href, undefined);
});

test('failed feeds display an explicit unavailable message', async () => {
  const node = fixture(async () => ({ ok: false, status: 503 }));
  await setupCommunity({ VITE_GALLERY_FEED_URL: 'https://example.com/feed' });
  assert.match(node('market-ticker').textContent, /unavailable/);
  assert.match(node('gallery-feed').textContent, /unavailable/);
});
