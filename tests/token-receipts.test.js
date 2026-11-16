import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('new token outputs create persistent, deduplicated and GAMBA-specific notices', async () => {
  const elements = new Map([
    ['token-receipt-notifications', {
      notices: [], prepend(item) { this.notices.unshift(item.textContent); },
      replaceChildren() { this.notices = []; },
    }],
    ['notifications-empty', { hidden: false }],
    ['notification-indicator', { hidden: true }],
  ]);
  const stored = new Map();
  const localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  const category = 'b'.repeat(64);
  const script = source.slice(source.indexOf('let rewardCategory ='), source.indexOf('\nfunction report('));
  const context = {
    network: 'mainnet', API_BASE_URL: 'https://example.test', localStorage,
    addressFor: () => 'wallet', utxoKey: (utxo) => `${utxo.txid}:${utxo.vout}`,
    $: (id) => elements.get(id), document: { createElement: () => ({}) },
    fetch: async () => ({ ok: true, json: async () => ({ category }) }),
  };
  const api = runInNewContext(`${script}\n({ loadRewardCategory, notifyTokenReceipts, rememberSentTransaction })`, context);
  await api.loadRewardCategory();
  api.rememberSentTransaction('self');
  const reward = { txid: 'reward', vout: 0, token: { category, amount: 1n } };
  const other = { txid: 'other', vout: 1, token: { category: 'a'.repeat(64), nft: {} } };
  const change = { txid: 'self', vout: 1, token: { category, amount: 4n } };
  api.notifyTokenReceipts([reward, other, change]);
  api.notifyTokenReceipts([reward, other, change]);
  const notices = elements.get('token-receipt-notifications').notices;
  assert.equal(notices.length, 2);
  assert.match(notices[1], /GAMBA.*diamond perk/);
  assert.match(notices[0], /CashToken received:.*NFT/);
  assert.equal(elements.get('notification-indicator').hidden, false);
  const state = JSON.parse(stored.values().next().value);
  assert.equal(state.seen.length, 3);
  assert.equal(state.messages.length, 2);
  assert.equal(state.unread, true);
});
