import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupBrowserWallet } from '../src/browser-wallet-ui.js';

test('create requires a confirmed backup, encrypts locally, and can unlock and reveal it', async (t) => {
  const oldStorage = globalThis.localStorage;
  const oldWindow = globalThis.window;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  globalThis.window = { confirm: () => true, prompt: () => 'DELETE' };
  t.after(() => { globalThis.localStorage = oldStorage; globalThis.window = oldWindow; });
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      listeners: {}, value: '', hidden: false, disabled: false,
      addEventListener(type, handler) { this.listeners[type] = handler; },
    });
    return nodes.get(id);
  };
  let connected = false;
  let connectedPhrase;
  const refresh = setupBrowserWallet($, {
    network: 'chipnet',
    canConnect: () => !connected,
    onConnect: async (phrase) => { connectedPhrase = phrase; connected = true; },
  });
  await $('browser-wallet-create').listeners.click();
  const phrase = $('browser-wallet-phrase').value;
  assert.equal(phrase.split(' ').length, 12);
  $('browser-wallet-password').value = 'strong test password';
  $('browser-wallet-password-confirm').value = 'strong test password';
  $('browser-wallet-confirm').value = '';
  await $('browser-wallet-form').listeners.submit({ preventDefault() {} });
  assert.equal(storage.size, 0);
  assert.match($('browser-wallet-status').textContent, /phrase/i);
  $('browser-wallet-confirm').value = phrase;
  await $('browser-wallet-form').listeners.submit({ preventDefault() {} });
  assert.equal(storage.size, 1);
  assert.ok(connectedPhrase === phrase);
  assert.equal([...storage.values()][0].includes(phrase), false);
  assert.equal($('browser-wallet-phrase').value, '');
  assert.equal($('browser-wallet-password').value, '');

  connected = false;
  refresh();
  await $('browser-wallet-unlock').listeners.click();
  $('browser-wallet-password').value = 'wrong test password';
  await $('browser-wallet-form').listeners.submit({ preventDefault() {} });
  assert.match($('browser-wallet-status').textContent, /Incorrect password/);
  $('browser-wallet-password').value = 'strong test password';
  await $('browser-wallet-form').listeners.submit({ preventDefault() {} });
  assert.equal(connected, true);

  await $('browser-wallet-backup').listeners.click();
  $('browser-wallet-password').value = 'strong test password';
  await $('browser-wallet-form').listeners.submit({ preventDefault() {} });
  assert.ok($('browser-wallet-phrase').value === phrase);
  $('connection-dialog').listeners.close();
  assert.equal($('browser-wallet-phrase').value, '');
  assert.equal($('browser-wallet-form').hidden, true);

  connected = false;
  refresh();
  $('browser-wallet-remove').listeners.click();
  assert.equal(storage.size, 0);
  await $('browser-wallet-restore').listeners.click();
  $('browser-wallet-phrase').value = phrase;
  $('browser-wallet-password').value = 'another test password';
  $('browser-wallet-password-confirm').value = 'another test password';
  await $('browser-wallet-form').listeners.submit({ preventDefault() {} });
  assert.equal(connected, true);
  assert.equal(connectedPhrase, phrase);
  assert.equal(storage.size, 1);
});
