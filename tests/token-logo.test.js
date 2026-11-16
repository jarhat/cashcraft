import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTokenLogo, tokenIconUrls } from '../src/token-logo.js';
import { authchainResponse, metadataResponse } from './bcmr-fixtures.js';

test('loads a BCMR icon with CORS enabled and converts IPFS URLs', async () => {
  const originalFetch = globalThis.fetch;
  const OriginalImage = globalThis.Image;
  const category = 'a'.repeat(64);
  let endpoint;
  globalThis.fetch = async (url) => {
    endpoint = url;
    return {
      ok: true,
      json: async () => url === 'https://gql.chaingraph.pat.mn/v1/graphql'
        ? authchainResponse(category)
        : metadataResponse(category, { uris: { icon: 'ipfs://cid/icon.png' } }),
    };
  };
  globalThis.Image = class {
    set src(value) { this.url = value; this.onload?.(); }
  };
  try {
    const image = await loadTokenLogo(category);
    assert.equal(endpoint, 'https://ipfs.filebase.io/ipfs/registry/metadata.json');
    assert.equal(image.crossOrigin, 'anonymous');
    assert.equal(image.url, 'https://ipfs.filebase.io/ipfs/cid/icon.png');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Image = OriginalImage;
  }
});

test('rejects missing or insecure registry icons', async () => {
  const originalFetch = globalThis.fetch;
  const category = 'b'.repeat(64);
  try {
    globalThis.fetch = async (url) => ({
      ok: true,
      json: async () => url === 'https://gql.chaingraph.pat.mn/v1/graphql'
        ? authchainResponse(category)
        : metadataResponse(category),
    });
    await assert.rejects(loadTokenLogo(category), /No BCMR token logo/);
    const insecureCategory = 'd'.repeat(64);
    globalThis.fetch = async (url) => ({
      ok: true,
      json: async () => url === 'https://gql.chaingraph.pat.mn/v1/graphql'
        ? authchainResponse(insecureCategory)
        : metadataResponse(insecureCategory, { uris: { icon: 'http://example.com/icon.png' } }),
    });
    await assert.rejects(loadTokenLogo(insecureCategory), (error) => error.errors.some((cause) => /must use HTTPS/.test(cause.message)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back to full BCMR metadata and another IPFS gateway', async () => {
  const originalFetch = globalThis.fetch;
  const OriginalImage = globalThis.Image;
  const category = 'c'.repeat(64);
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return {
      ok: true,
      json: async () => url === 'https://gql.chaingraph.pat.mn/v1/graphql'
        ? authchainResponse(category)
        : metadataResponse(category, { uris: { icon: 'ipfs://ipfs/bafy123/logo.png' } }),
    };
  };
  globalThis.Image = class {
    set src(value) {
      this.url = value;
      if (value.includes('ipfs.io')) this.onerror?.();
      else this.onload?.();
    }
  };
  try {
    const image = await loadTokenLogo(category);
    assert.equal(requests.length, 2);
    assert.equal(image.url, 'https://ipfs.filebase.io/ipfs/bafy123/logo.png');
    assert.equal(image.crossOrigin, 'anonymous');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Image = OriginalImage;
  }
});

test('rejects invalid IPFS paths and untrusted registry categories', async () => {
  assert.throws(() => tokenIconUrls('ipfs://../other'), /Invalid IPFS/);
  assert.deepEqual(tokenIconUrls('https://gateway.example/ipfs/bafy123/logo.png').slice(0, 2), [
    'https://gateway.example/ipfs/bafy123/logo.png', 'https://ipfs.filebase.io/ipfs/bafy123/logo.png',
  ]);
  assert.equal(tokenIconUrls('https://bafy123.ipfs.example/logo.png')[1], 'https://ipfs.filebase.io/ipfs/bafy123/logo.png');
  const originalFetch = globalThis.fetch;
  const category = 'e'.repeat(64);
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => url === 'https://gql.chaingraph.pat.mn/v1/graphql'
      ? authchainResponse(category)
      : metadataResponse('b'.repeat(64), { uris: { icon: 'ipfs://cid/logo.png' } }),
  });

  try {
    await assert.rejects(loadTokenLogo(category), (error) =>
      error.errors.every((cause) => /does not match/.test(cause.message)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not wait for a stalled IPFS gateway before trying another', async () => {
  const originalFetch = globalThis.fetch;
  const OriginalImage = globalThis.Image;
  const category = '9'.repeat(64);
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => url === 'https://gql.chaingraph.pat.mn/v1/graphql'
      ? authchainResponse(category)
      : metadataResponse(category, { uris: { icon: 'ipfs://cid/icon.png' } }),
  });
  globalThis.Image = class {
    set src(value) {
      this.url = value;
      if (value.includes('ipfs.io')) queueMicrotask(() => this.onload?.());
    }
  };
  try {
    const image = await loadTokenLogo(category);
    assert.match(image.url, /ipfs\.io/);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.Image = OriginalImage;
  }
});
