import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('a browser wallet session is restored on refresh', async () => {
  const start = source.indexOf('const restoreSession =');
  const end = source.indexOf("\nif ('serviceWorker'", start);
  const restored = [];
  const context = {
    sessionStorage: { getItem: () => 'saved' }, network: 'mainnet',
    pairingInProgress: false, walletReady: false,
    connectBrowserWallet: async (phrase, isCurrent, session) => restored.push([phrase, isCurrent(), session]),
    logger: { warn() {} }, URLSearchParams, window: { location: { search: '' } },
  };
  runInNewContext(source.slice(start, end), context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(restored, [[null, true, 'saved']]);
});

test('a temporary restore failure does not erase the browser wallet session', async () => {
  const start = source.indexOf('const restoreSession =');
  const end = source.indexOf("\nif ('serviceWorker'", start);
  const removed = [];
  const status = {};
  const context = {
    sessionStorage: { getItem: () => 'saved', removeItem: (key) => removed.push(key) },
    network: 'mainnet', pairingInProgress: false, walletReady: false,
    connectBrowserWallet: async () => { throw new Error('temporary failure'); },
    logger: { warn() {} }, URLSearchParams, window: { location: { search: '' } },
    $: () => status,
  };
  runInNewContext(source.slice(start, end), context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(removed, []);
  assert.match(status.textContent, /could not be restored/);
});

test('game links open in the viewport while wallet restoration is still pending', async () => {
  const start = source.indexOf('const restoreSession =');
  const end = source.indexOf("\nif ('serviceWorker'", start);
  const events = [];
  const context = {
    sessionStorage: { getItem: () => null }, network: 'mainnet',
    loadWalletDependencies: () => new Promise(() => {}),
    logger: { warn() {} }, URLSearchParams, window: { location: { search: '?game=cashcraft' } },
    $: (id) => id === 'game-dialog'
      ? { classList: { add: (value) => events.push(value) } }
      : { click: () => events.push(id) },
  };
  runInNewContext(source.slice(start, end), context);
  assert.deepEqual(events, ['game-auto-open', 'game-netcraft']);
});
