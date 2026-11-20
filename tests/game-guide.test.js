import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupGames } from '../src/games.js';

test('CashCraft guide can be dismissed, reopened and used to access the wallet', async (t) => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, raf: globalThis.requestAnimationFrame, window: globalThis.window };
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.requestAnimationFrame = previous.raf;
    globalThis.window = previous.window;
  });
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, open: false,
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this[name] = value; },
      appendChild(child) { child.parentNode = this; },
      classList: { add() {}, remove() {}, toggle() {} },
      show() { this.open = true; },
      close() { this.open = false; this.listeners.close?.(); },
      focus() {},
    });
    return elements.get(id);
  };
  const toolbar = { after(child) { child.parentNode = this; } };
  globalThis.document = {
    documentElement: { classList: { remove() {} } },
    body: { classList: { toggle() {} } }, fullscreenElement: null,
    querySelector() { return toolbar; }, addEventListener() {},
  };
  globalThis.requestAnimationFrame = () => {};
  const handlers = {};
  globalThis.window = { addEventListener(type, fn) { handlers[type] = fn; } };
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'text/html' }, text: async () => '<html></html>' });
  let connected = false;
  let connections = 0;
  let notifications = 0;
  $('connection-open').click = () => { connections++; };
  $('notifications-toggle').click = () => { notifications++; };
  const guestId = 'a'.repeat(64);
  $('game-frame').contentWindow = { postMessage() {} };
  const update = setupGames($, { translate: (text) => text, isWalletConnected: () => connected, getGuestId: () => guestId });
  await $('game-netcraft').listeners.click();
  assert.equal($('game-guide').open, true);
  assert.equal($('game-notifications')['aria-controls'], 'connection-dialog');
  await $('game-close').listeners.click();
  assert.equal($('game-guide').open, true);
  assert.equal($('game-guide').parentNode, toolbar);
  $('game-restore').listeners.click();
  assert.equal($('game-guide').parentNode, $('game-stage'));
  $('game-guide-done').listeners.click();
  assert.equal($('game-guide').open, false);
  handlers.message({ source: $('game-frame').contentWindow, data: { type: 'netcraft-block-mined' } });
  assert.equal($('mining-prompt').open, true);
  assert.equal($('mining-prompt-title').textContent, 'First block mined!');
  $('mining-prompt-later').listeners.click();
  handlers.message({ source: $('game-frame').contentWindow, data: { type: 'netcraft-mining-progress', blocks: 9, unlocked: false } });
  assert.equal($('game-guide-progress').textContent, 'MINA ore progress: 9 / 10');
  handlers.message({ source: $('game-frame').contentWindow, data: { type: 'netcraft-mining-progress', blocks: 0, unlocked: true } });
  assert.equal($('mining-prompt').open, true);
  assert.equal($('mining-prompt-title').textContent, '1 MINA earned!');
  assert.match($('game-guide-progress').textContent, /Connect a wallet/);
  $('mining-prompt-later').listeners.click();
  $('game-notifications').listeners.click();
  assert.equal(connections, 1);
  $('game-guide-open').listeners.click();
  assert.equal($('game-guide').open, true);
  $('game-guide-wallet').listeners.click();
  assert.equal($('game-guide').open, true);
  assert.equal(connections, 2);
  connected = true;
  update(null);
  assert.equal($('game-guide-wallet').textContent, 'Wallet and notifications');
  $('game-notifications').listeners.click();
  $('game-guide-wallet').listeners.click();
  assert.equal(notifications, 2);
});
