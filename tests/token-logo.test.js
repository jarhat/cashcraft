import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTokenLogo } from '../src/token-logo.js';

test('loads a BCMR icon with CORS enabled and converts IPFS URLs', async () => {
  const originalFetch = globalThis.fetch;
  const OriginalImage = globalThis.Image;
  const category = 'a'.repeat(64);
  let endpoint;
  globalThis.fetch = async (url) => {
    endpoint = url;
    return { ok: true, json: async () => ({ category, icon_uri: 'ipfs://cid/icon.png' }) };
  };
  globalThis.Image = class {
    set src(value) { this.url = value; this.onload(); }
  };
  try {
    const image = await loadTokenLogo(category);
    assert.equal(endpoint, `https://bcmr.paytaca.com/api/tokens/${category}/icon-symbol`);
    assert.equal(image.crossOrigin, 'anonymous');
    assert.equal(image.url, 'https://ipfs.io/ipfs/cid/icon.png');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Image = OriginalImage;
  }
});

test('rejects missing or insecure registry icons', async () => {
  const originalFetch = globalThis.fetch;
  const category = 'b'.repeat(64);
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ category }) });
    await assert.rejects(loadTokenLogo(category), /No BCMR token logo/);
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ category, icon_uri: 'http://example.com/icon.png' }) });
    await assert.rejects(loadTokenLogo(category), /must use HTTPS/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
