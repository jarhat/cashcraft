import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTokenPrice, PUSD_CATEGORY } from './market.js';

test('estimates PUSD unit price from BCH pool reserves', async () => {
  const price = await fetchTokenPrice(PUSD_CATEGORY, 2, 400, async (url) => {
    assert.equal(url, `https://indexer.riften.net/cauldron/valuelocked/${PUSD_CATEGORY}`);
    return { ok: true, json: async () => ({ satoshis: 100_000_000, token_amount: 40_000 }) };
  });
  assert.equal(price, 1);
});

test('refuses illiquid pools and missing rates', async () => {
  await assert.rejects(fetchTokenPrice(PUSD_CATEGORY, 2, 400, async () => ({
    ok: true, json: async () => ({ satoshis: 100, token_amount: 1 }),
  })), /liquidity/);
  await assert.rejects(fetchTokenPrice(PUSD_CATEGORY, 2, null), /BCH price/);
});
