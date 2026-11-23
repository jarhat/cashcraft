import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCauldronSpot, fetchTokenMetadata } from '../src/portfolio-data.js';
import { authchainResponse, metadataResponse, registryResponse } from './bcmr-fixtures.js';

test('validates BCMR category and decimals', async () => {
  const original = globalThis.fetch;
  const category = 'a'.repeat(64);
  const mismatchedCategory = 'b'.repeat(64);
  const invalidDecimalsCategory = 'c'.repeat(64);
  const metadataByCategory = new Map([
    [category, metadataResponse(category)],
    [mismatchedCategory, metadataResponse('d'.repeat(64))],
    [invalidDecimalsCategory, metadataResponse(invalidDecimalsCategory, {
      token: { category: invalidDecimalsCategory, decimals: -1 },
    })],
  ]);
  globalThis.fetch = async (url, options) => {
    if (url === 'https://gql.chaingraph.pat.mn/v1/graphql') {
      const requestedCategory = JSON.parse(options.body).variables.tokenId.slice(2);
      return { ok: true, json: async () => authchainResponse(requestedCategory, `ipfs://registry/${requestedCategory}.json`, metadataByCategory.get(requestedCategory)) };
    }
    const requestedCategory = new URL(url).pathname.split('/').at(-1).replace('.json', '');
    return registryResponse(metadataByCategory.get(requestedCategory));
  };
  try {
    assert.deepEqual(await fetchTokenMetadata(category), {
      name: 'Example', description: undefined, symbol: 'EX', decimals: 2, uris: undefined, extensions: undefined,
    });
    await assert.rejects(fetchTokenMetadata(mismatchedCategory), /does not match/);
    await assert.rejects(fetchTokenMetadata(invalidDecimalsCategory), /decimals/);
  } finally { globalThis.fetch = original; }
});

test('accepts omitted BCMR decimals and preserves metadata for a previously issued category', async () => {
  const original = globalThis.fetch;
  const category = '2'.repeat(64);
  const nextCategory = '3'.repeat(64);
  const registry = {
    identities: {
      [category]: {
        '2020-01-01T00:00:00.000Z': { name: 'Original', token: { category, symbol: 'OLD' } },
        '2021-01-01T00:00:00.000Z': { name: 'Migrated', token: { category: nextCategory, symbol: 'NEW', decimals: 8 } },
      },
    },
  };
  globalThis.fetch = async (url) => url === 'https://gql.chaingraph.pat.mn/v1/graphql'
    ? { ok: true, json: async () => authchainResponse(category, undefined, registry) }
    : registryResponse(registry);
  try {
    const metadata = await fetchTokenMetadata(category);
    assert.equal(metadata.name, 'Original');
    assert.equal(metadata.symbol, 'OLD');
    assert.equal(metadata.decimals, 0);
  } finally { globalThis.fetch = original; }
});

test('selects the BCMR publication with the lowest output index', async () => {
  const original = globalThis.fetch;
  const category = '4'.repeat(64);
  const registry = metadataResponse(category, { name: 'First output' });
  const response = authchainResponse(category, undefined, registry);
  const outputs = response.data.transaction[0].authchains[0].migrations[0].transaction[0].outputs;
  const later = authchainResponse(category, undefined, metadataResponse(category, { name: 'Later output' }))
    .data.transaction[0].authchains[0].migrations[0].transaction[0].outputs[0];
  outputs.unshift({ ...later, output_index: 2 });
  globalThis.fetch = async (url) => url === 'https://gql.chaingraph.pat.mn/v1/graphql'
    ? { ok: true, json: async () => response }
    : registryResponse(registry);
  try {
    assert.equal((await fetchTokenMetadata(category)).name, 'First output');
  } finally { globalThis.fetch = original; }
});

test('uses the latest BCMR publication in the token authchain', async () => {
  const original = globalThis.fetch;
  const category = 'f'.repeat(64);
  const latestRegistry = metadataResponse(category, { name: 'Latest' });
  const latest = authchainResponse(category, 'ipfs://registry/latest.json', latestRegistry);
  const migrations = authchainResponse(category, 'ipfs://registry/old.json').data.transaction[0].authchains[0].migrations;
  migrations.push({
    transaction: [{
      hash: `\\x${'e'.repeat(64)}`,
      outputs: latest.data.transaction[0].authchains[0].migrations[0].transaction[0].outputs,
    }],
  });
  let metadataUrl;
  globalThis.fetch = async (url) => {
    if (url === 'https://gql.chaingraph.pat.mn/v1/graphql') {
      return { ok: true, json: async () => ({ data: { transaction: [{ authchains: [{ migrations }] }] } }) };
    }
    metadataUrl = url;
    return registryResponse(latestRegistry);
  };
  try {
    assert.equal((await fetchTokenMetadata(category)).name, 'Latest');
    assert.match(metadataUrl, /\/ipfs\/registry\/latest\.json$/);
  } finally { globalThis.fetch = original; }
});

test('uses a responsive gateway and rejects metadata with a mismatched on-chain hash', async () => {
  const original = globalThis.fetch;
  const category = '8'.repeat(64);
  const registry = metadataResponse(category, { name: 'Verified' });
  let mode = 'fallback';
  const requests = [];
  globalThis.fetch = async (url, options) => {
    if (url === 'https://gql.chaingraph.pat.mn/v1/graphql') {
      return { ok: true, json: async () => authchainResponse(category, undefined, registry) };
    }
    requests.push(url);
    if (mode === 'fallback' && url.includes('filebase')) {
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    return registryResponse(mode === 'fallback' ? registry : metadataResponse(category, { name: 'Tampered' }));
  };
  try {
    assert.equal((await fetchTokenMetadata(category)).name, 'Verified');
    assert.ok(requests.some((url) => url.includes('ipfs.io')));
    const badCategory = '7'.repeat(64);
    mode = 'mismatch';
    globalThis.fetch = async (url) => url === 'https://gql.chaingraph.pat.mn/v1/graphql'
      ? { ok: true, json: async () => authchainResponse(badCategory) }
      : registryResponse(metadataResponse(badCategory, { name: 'Tampered' }));
    await assert.rejects(fetchTokenMetadata(badCategory), /on-chain hash/);
  } finally { globalThis.fetch = original; }
});

test('tries alternative IPFS gateways for an HTTPS publication', async () => {
  const original = globalThis.fetch;
  const category = '5'.repeat(64);
  const registry = metadataResponse(category);
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    if (url === 'https://gql.chaingraph.pat.mn/v1/graphql') {
      return { ok: true, json: async () => authchainResponse(category, 'https://gateway.example/ipfs/cid/registry.json', registry) };
    }
    return url.includes('gateway.example') ? { ok: false, status: 503 } : registryResponse(registry);
  };
  try {
    assert.equal((await fetchTokenMetadata(category)).name, 'Example');
    assert.ok(requests.includes('https://ipfs.io/ipfs/cid/registry.json'));
  } finally { globalThis.fetch = original; }
});

test('shares metadata lookups and refreshes them after the cache expires', async () => {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const category = '6'.repeat(64);
  const registry = metadataResponse(category);
  let now = 1_800_000_000_000;
  let queries = 0;
  Date.now = () => now;
  globalThis.fetch = async (url) => {
    if (url === 'https://gql.chaingraph.pat.mn/v1/graphql') {
      queries++;
      return { ok: true, json: async () => authchainResponse(category, undefined, registry) };
    }
    return registryResponse(registry);
  };
  try {
    await Promise.all([fetchTokenMetadata(category), fetchTokenMetadata(category)]);
    assert.equal(queries, 1);
    now += 5 * 60 * 1000;
    await fetchTokenMetadata(category);
    assert.equal(queries, 2);
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
  }
});

test('prices from the deepest valid matching Cauldron pool in BCH per base unit', async () => {
  const original = globalThis.fetch;
  const category = 'a'.repeat(64);
  let data = { active: [
    { token_id: category, sats: 100_000_000, tokens: 100 },
    { token_id: category, sats: 200_000_000, tokens: 100 },
    { token_id: 'b'.repeat(64), sats: 900_000_000, tokens: 1 },
    { token_id: category, sats: 300_000_000, tokens: 0 },
  ] };
  let url;
  globalThis.fetch = async (input) => { url = input; return { ok: true, json: async () => data }; };
  try {
    assert.equal(await fetchCauldronSpot(category, 'mainnet'), 0.02);
    assert.equal(url, `https://indexer.cauldron.quest/cauldron/pool/active?token=${category}`);
    data = { active: [] };
    await assert.rejects(fetchCauldronSpot(category, 'chipnet'), /No priced/);
    assert.match(url, /indexer-chipnet/);
  } finally { globalThis.fetch = original; }
});
