import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchCauldronSpot, fetchTokenMetadata } from '../src/portfolio-data.js';

test('validates BCMR category and decimals and converts IPFS icons', async () => {
  const original = globalThis.fetch;
  const category = 'a'.repeat(64);
  let data = { name: 'Example', token: { category, symbol: 'EX', decimals: 2 }, uris: { icon: 'ipfs://cid/icon.png' } };
  globalThis.fetch = async () => ({ ok: true, json: async () => data });
  try {
    assert.deepEqual(await fetchTokenMetadata(category), {
      name: 'Example', description: undefined, symbol: 'EX', decimals: 2, icon: 'https://ipfs.io/ipfs/cid/icon.png',
    });
    data = { token: { category: 'b'.repeat(64), decimals: 2 } };
    await assert.rejects(fetchTokenMetadata(category), /does not match/);
    data = { token: { category, decimals: -1 } };
    await assert.rejects(fetchTokenMetadata(category), /decimals/);
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
