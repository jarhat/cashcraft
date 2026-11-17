import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('beer reward waits for balance scan, alerts once and persists completion', async () => {
  const start = source.indexOf('let beerPolling = null;');
  const end = source.indexOf('\nsetupGames(', start);
  const values = new Map([['ctf-beer-reward:mainnet:address', 'pending']]);
  const nodes = {
    'game-status': { textContent: '' },
    'notification-indicator': { hidden: true },
  };
  const txid = 'a'.repeat(64), category = 'b'.repeat(64);
  let detected = false, notices = 0, celebrations = 0, refreshes = 0, timer;
  let state = { messages: [], seen: [], sent: [], unread: false };
  const localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) { values.set(key, value); if (key === 'receipt') state = JSON.parse(value); },
    removeItem: (key) => values.delete(key),
  };
  const context = {
    network: 'mainnet', walletReady: true, API_BASE_URL: '', rewardCategory: category,
    addressFor: () => 'address', localStorage, $: (id) => nodes[id],
    fetch: async () => ({ ok: true, json: async () => ({ status: 'sent', txid }) }),
    AbortSignal, translate: (text) => text,
    refreshBalances: async () => { refreshes++; return { utxos: detected ? [{ txid, token: { category, amount: 1n } }] : [] }; },
    readReceiptState: () => state, receiptStorageKey: () => 'receipt',
    addReceiptNotice: () => notices++, showGambaCelebration: () => celebrations++,
    setTimeout: (callback) => { timer = callback; },
  };
  runInNewContext(source.slice(start, end), context);
  await context.pollBeerReward('address');
  assert.equal(celebrations, 0);
  assert.match(nodes['game-status'].textContent, /Waiting for the wallet balance/);
  assert.ok(timer);
  detected = true;
  await context.pollBeerReward('address');
  assert.equal(refreshes, 2);
  assert.equal(notices, 1);
  assert.equal(celebrations, 1);
  assert.equal(nodes['notification-indicator'].hidden, false);
  assert.equal(values.get('ctf-beer-reward:mainnet:address'), 'complete');
  await context.pollBeerReward('address');
  assert.equal(celebrations, 1);
});
