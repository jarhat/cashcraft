import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCauldronSpot, fetchTokenMetadata } from '../src/portfolio-data.js';
import { authchainResponse, metadataResponse } from './bcmr-fixtures.js';

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
  globalThis.fetch = async (url, options) => ({
    ok: true,
    json: async () => {
      if (url === 'https://gql.chaingraph.pat.mn/v1/graphql') {
        const requestedCategory = JSON.parse(options.body).variables.tokenId.slice(2);
        return authchainResponse(requestedCategory, `ipfs://registry/${requestedCategory}.json`);
      }
      const requestedCategory = new URL(url).pathname.split('/').at(-1).replace('.json', '');
      return metadataByCategory.get(requestedCategory);
    },
  });
  try {
    assert.deepEqual(await fetchTokenMetadata(category), {
      name: 'Example', description: undefined, symbol: 'EX', decimals: 2,
    });
    await assert.rejects(fetchTokenMetadata(mismatchedCategory), /does not match/);
    await assert.rejects(fetchTokenMetadata(invalidDecimalsCategory), /decimals/);
  } finally { globalThis.fetch = original; }
});

test('uses the latest BCMR publication in the token authchain', async () => {
  const original = globalThis.fetch;
  const category = 'f'.repeat(64);
  const latest = authchainResponse(category, 'ipfs://registry/latest.json');
  const migrations = authchainResponse(category, 'ipfs://registry/old.json').data.transaction[0].authchains[0].migrations;
  migrations.push({
    transaction: [{
      hash: `\\x${'e'.repeat(64)}`,
      outputs: latest.data.transaction[0].authchains[0].migrations[0].transaction[0].outputs,
    }],
  });
  let metadataUrl;
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => {
      if (url === 'https://gql.chaingraph.pat.mn/v1/graphql') {
        return { data: { transaction: [{ authchains: [{ migrations }] }] } };
      }
      metadataUrl = url;
      return metadataResponse(category, { name: url.endsWith('/latest.json') ? 'Latest' : 'Old' });
    },
  });
  try {
    assert.equal((await fetchTokenMetadata(category)).name, 'Latest');
    assert.equal(metadataUrl, 'https://ipfs.filebase.io/ipfs/registry/latest.json');
  } finally { globalThis.fetch = original; }
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
