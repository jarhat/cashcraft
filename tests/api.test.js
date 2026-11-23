import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitCashAddress } from '../src/api.js';

test('registers the address with the same-origin API and requires confirmation', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  try {
    globalThis.fetch = async (...args) => {
      calls.push(args);
      return { ok: true, status: 200, json: async () => ({ cash_address: 'bitcoincash:ztest', reward_status: 'pending' }) };
    };
    assert.deepEqual(await submitCashAddress('bitcoincash:ztest'), { cash_address: 'bitcoincash:ztest', reward_status: 'pending' });
    assert.equal(calls[0][0], '/api/cash-address');
    assert.deepEqual(JSON.parse(calls[0][1].body), { cash_address: 'bitcoincash:ztest' });

    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
    await assert.rejects(submitCashAddress('bitcoincash:ztest'), /did not confirm/);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ cash_address: 'bitcoincash:ztest' }) });
    await assert.rejects(submitCashAddress('bitcoincash:ztest'), /reward status/);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError(); } });
    await assert.rejects(submitCashAddress('bitcoincash:ztest'), /invalid response/);
    globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({ detail: 'Address database unavailable.' }) });
    await assert.rejects(submitCashAddress('bitcoincash:ztest'), /Address database unavailable/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
