import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupGames } from '../src/games.js';

test('wizard tips fade without blocking play and crafting appears after two rewards', async (t) => {
  const previous = { document: globalThis.document, fetch: globalThis.fetch, raf: globalThis.requestAnimationFrame, window: globalThis.window, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  t.after(() => {
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.requestAnimationFrame = previous.raf;
    globalThis.window = previous.window;
    globalThis.setTimeout = previous.setTimeout;
    globalThis.clearTimeout = previous.clearTimeout;
  });
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, open: false,
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this[name] = value; },
      appendChild(child) { child.parentNode = this; },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      classList: { add() {}, remove() {}, toggle() {} },
      style: { setProperty() {} },
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
    createElement() {
      return {
        children: [], style: {}, setAttribute() {},
        append(child) { this.children.push(child); },
        prepend(child) { this.children.unshift(child); },
      };
    },
  };
  globalThis.requestAnimationFrame = () => {};
  let dismiss;
  globalThis.setTimeout = (callback) => { dismiss = callback; return 1; };
  globalThis.clearTimeout = () => {};
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
  const transfers = [];
  const update = setupGames($, {
    translate: (text) => text, isWalletConnected: () => connected, getGuestId: () => guestId,
    openPlayerTransfer: (target) => transfers.push(target),
  });
  await $('game-netcraft').listeners.click();
  assert.equal($('game-guide').open, false);
  assert.equal($('game-wizard-speech').hidden, false);
  for (let step = 0; step < 5; step++) dismiss();
  assert.equal($('game-wizard-speech').hidden, true);
  assert.equal($('game-notifications')['aria-controls'], 'connection-dialog');
  await $('game-close').listeners.click();
  assert.equal($('game-guide').open, false);
  $('game-restore').listeners.click();
  assert.equal($('game-guide').open, false);
  const message = (data) => handlers.message({ source: $('game-frame').contentWindow, data });
  message({ type: 'netcraft-ore-progress', counts: [2, 3, 4] });
  message({ type: 'netcraft-block-mined', block: 73 });
  assert.equal($('game-wizard-ores').hidden, true);
  message({ type: 'netcraft-block-mined', block: 3 });
  assert.equal($('mining-prompt').open, false);
  assert.match($('game-wizard-message').textContent, /10 natural blocks/);
  assert.deepEqual($('game-wizard-ores').children.map(row => row.textContent),
    ['MINA ore: 2/10', 'Lapis ore: 3/10', 'Redstone ore: 4/10']);
  message({ type: 'netcraft-ore-progress', counts: [2, 4, 4] });
  assert.equal($('game-wizard-ores').children[1].children[1].value, 4);
  handlers.message({ source: $('game-frame').contentWindow, data: { type: 'netcraft-mining-progress', blocks: 9, unlocked: false } });
  assert.equal($('game-guide-progress').textContent, 'MINA ore progress: 9 / 10');
  assert.match($('game-wizard-message').textContent, /10 natural blocks/);
  dismiss();
  handlers.message({ source: $('game-frame').contentWindow, data: { type: 'netcraft-mining-progress', blocks: 0, unlocked: true } });
  assert.equal($('mining-prompt').open, false);
  assert.match($('game-wizard-message').textContent, /1 MINA earned/);
  assert.match($('game-guide-progress').textContent, /Connect a wallet/);
  handlers.message({ source: $('game-frame').contentWindow, data: { type: 'netcraft-mina-earned', rewards: 1 } });
  assert.equal($('game-crafting').hidden, true);
  handlers.message({ source: $('game-frame').contentWindow, data: { type: 'netcraft-mina-earned', rewards: 2 } });
  assert.equal($('game-crafting').hidden, false);
  $('game-notifications').listeners.click();
  assert.equal(connections, 1);
  $('game-guide-open').listeners.click();
  assert.equal($('game-wizard-speech').hidden, false);
  message({ type: 'netcraft-tutorial-control', control: 'mobile-mine' });
  assert.match($('game-wizard-message').textContent, /^Use WASD/);
  $('game-guide-wallet').listeners.click();
  assert.equal(connections, 2);
  connected = true;
  update(null);
  assert.equal($('game-guide-wallet').textContent, 'Wallet and notifications');
  $('game-notifications').listeners.click();
  $('game-guide-wallet').listeners.click();
  assert.equal(notifications, 2);
  const send = { type: 'netcraft-wallet-send', name: 'Miner', address: 'bitcoincash:ztest' };
  await handlers.message({ source: {}, data: send });
  await message({ ...send, address: 'https://example.org/' });
  assert.deepEqual(transfers, []);
  await message(send);
  assert.deepEqual(transfers, [{ name: 'Miner', address: 'bitcoincash:ztest' }]);
  assert.equal($('game-dialog').hidden, true);
  $('game-restore').listeners.click();
  await message({ type: 'netcraft-wallet-receive' });
  assert.equal(transfers[1], null);
});
