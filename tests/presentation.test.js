import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrollEffects } from '../src/scroll-effects.js';
import { fetchTokenLogo, logoUrl } from '../src/payment-qr.js';

test('hero text fades below the navbar and the navbar fades over panel sections', () => {
  const nav = { top: 0, bottom: 60 };
  assert.deepEqual(scrollEffects(nav, { top: 100 }, { top: 500 }, { bottom: 1200 }),
    { opacity: 1, cutoff: 0, fadeEnd: 0 });
  assert.deepEqual(scrollEffects(nav, { top: 40 }, { top: 30 }, { bottom: 1200 }),
    { opacity: .5, cutoff: 20, fadeEnd: 48 });
  assert.equal(scrollEffects(nav, { top: -300 }, { top: -20 }, { bottom: 500 }).opacity, 0);
  assert.equal(scrollEffects(nav, { top: -1300 }, { top: -800 }, { bottom: -1 }).opacity, 1);
});

test('BCMR logo URLs support HTTPS and IPFS but reject unsafe URLs', () => {
  assert.equal(logoUrl('ipfs://bafyexample/icon.png'), 'https://ipfs.io/ipfs/bafyexample/icon.png');
  assert.equal(logoUrl('https://example.com/icon.png'), 'https://example.com/icon.png');
  for (const uri of ['http://example.com/icon.png', 'javascript:alert(1)', 'https://user:pass@example.com/', null]) {
    assert.equal(logoUrl(uri), null);
  }
});

test('BCMR index lookup handles missing tokens and surfaces service errors', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      assert.equal(url, `https://bcmr.paytaca.com/api/tokens/${'a'.repeat(64)}/icon-symbol`);
      return { ok: true, json: async () => ({ icon_uri: 'https://example.com/logo.png' }) };
    };
    assert.equal(await fetchTokenLogo('a'.repeat(64)), 'https://example.com/logo.png');
    globalThis.fetch = async () => ({ status: 404 });
    assert.equal(await fetchTokenLogo('a'.repeat(64)), null);
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(fetchTokenLogo('a'.repeat(64)), /503/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
