import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchChainStatus, fetchMinaOreMined, fetchPayoutBalance, setupChainTicker } from '../src/chain-ticker.js';

const status = {
  network: 'mainnet', blocks: 800000, headers: 800002,
  best_block_hash: 'a'.repeat(64), difficulty: 123.5, syncing: true,
};

test('chain status rejects malformed or unavailable node responses', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await assert.rejects(fetchChainStatus(), /503/);
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ...status, blocks: -1 }) });
  await assert.rejects(fetchChainStatus(), /Invalid blockchain status/);
});

test('MINA totals require a nonnegative integer string', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ mined: '9007199254740993' }) });
  assert.equal(await fetchMinaOreMined(), 9007199254740993n.toLocaleString());
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ mined: '-1' }) });
  await assert.rejects(fetchMinaOreMined(), /Invalid MINA/);
});

test('payout balance preserves exact satoshis and rejects invalid values', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ satoshis: '100000001' }) });
  assert.equal(await fetchPayoutBalance(), '1.00000001 BCH');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ satoshis: '-1' }) });
  await assert.rejects(fetchPayoutBalance(), /Invalid payout balance/);
});

test('chain ticker renders node and payout data independently', async (t) => {
  const original = { fetch: globalThis.fetch, document: globalThis.document, setInterval: globalThis.setInterval };
  t.after(() => Object.assign(globalThis, original));
  class Element {
    constructor() { this.children = []; this.attributes = {}; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  let interval, refresh, visibility;
  globalThis.document = {
    hidden: false,
    createElement: () => new Element(),
    addEventListener(_type, callback) { visibility = callback; },
  };
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(url);
    return { ok: true, json: async () => url.includes('mina-ore') ? { mined: '5678' } : url.includes('payout-balance') ? { satoshis: '120000000' } : status };
  };
  globalThis.setInterval = (callback, delay) => { refresh = callback; interval = delay; };
  const container = new Element();
  setupChainTicker(container, { warn() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interval, 30000);
  const [first, duplicate] = container.children[0].children;
  assert.equal(first.children[1].children[1].textContent, (800000).toLocaleString());
  assert.equal(first.children[2].children[1].title, status.best_block_hash);
  assert.equal(first.children[4].children[1].textContent, 'Syncing');
  assert.equal(first.children[5].children[0].textContent, 'Headers');
  assert.equal(first.children[6].children[0].textContent, 'MINA ore');
  assert.equal(first.children[6].children[1].textContent, (5678).toLocaleString());
  assert.equal(first.children[7].children[1].textContent, '1.20000000 BCH');
  assert.ok(!requests.includes('/api/mina-rewards-sent'));
  assert.equal(duplicate.attributes['aria-hidden'], 'true');
  globalThis.fetch = async () => ({ ok: false, status: 503 });
  await refresh();
  assert.equal(container.children[0].children[0].children[0].children[1].textContent, 'Unavailable');
  assert.equal(container.children[0].children[0].children[1].children[1].textContent, 'Unavailable');
  globalThis.document.hidden = false;
  globalThis.fetch = async (url) => url.includes('mina-ore')
    ? { ok: false, status: 503 }
    : { ok: true, json: async () => ({ ...status, syncing: false, headers: status.blocks }) };
  visibility();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(container.children[0].children[0].children[4].children[1].textContent, 'Synced');
  assert.equal(container.children[0].children[0].children[5].children[1].textContent, 'Unavailable');
});
