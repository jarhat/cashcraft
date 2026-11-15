import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTokenMetadata } from './metadata.js';

test('reads token identity from the network-specific Paytaca indexer', async () => {
  const category = 'ab'.repeat(32);
  let url;
  const result = await fetchTokenMetadata(category, 'chipnet', async (value) => {
    url = value;
    return { ok: true, json: async () => ({
      name: 'Example', description: 'Details',
      token: { category, symbol: 'EX', decimals: 2 },
    }) };
  });
  assert.equal(url, `https://bcmr-chipnet.paytaca.com/api/tokens/${category}/`);
  assert.deepEqual(result, { name: 'Example', description: 'Details', symbol: 'EX', decimals: 2 });
});

test('rejects mismatched categories and HTTP failures', async () => {
  const category = 'ab'.repeat(32);
  await assert.rejects(fetchTokenMetadata(category, 'mainnet', async () => ({
    ok: true, json: async () => ({ token: { category: 'cd'.repeat(32) } }),
  })), /did not match/);
  await assert.rejects(fetchTokenMetadata(category, 'mainnet', async () => ({
    ok: false, status: 503,
  })), /503/);
});
