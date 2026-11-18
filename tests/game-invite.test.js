import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupGameInvite } from '../src/game-invite.js';

test('invite shares the CashCraft link and shows the donation address', async (t) => {
  const original = { window: globalThis.window, navigator: globalThis.navigator, fetch: globalThis.fetch };
  t.after(() => {
    globalThis.window = original.window;
    Object.defineProperty(globalThis, 'navigator', { value: original.navigator, configurable: true, writable: true });
    globalThis.fetch = original.fetch;
  });
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
      showModal() { this.open = true; }, close() { this.open = false; }, focus() {},
    });
    return elements.get(id);
  };
  globalThis.window = { location: { origin: 'https://example.test' } };
  let shared;
  Object.defineProperty(globalThis, 'navigator', {
    value: { share: async (value) => { shared = value; } }, configurable: true, writable: true,
  });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ address: 'bitcoincash:test', network: 'mainnet' }) });
  let qrAddress;
  setupGameInvite($, 'mainnet', async () => ({
    QRCode: { toCanvas: async (_canvas, address) => { qrAddress = address; } },
    decodeCashAddress: () => ({ prefix: 'bitcoincash' }),
  }));
  await $('game-invite').listeners.click();
  await $('invite-share').listeners.click();
  assert.equal(qrAddress, 'bitcoincash:test');
  assert.equal($('donation-qr').hidden, false);
  assert.deepEqual(shared, {
    title: 'CashCraft', text: 'Come explore CashCraft with me!', url: 'https://example.test/craft',
  });
});
