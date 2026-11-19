import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setupGames } from '../src/games.js';

test('game buttons open mounted shells and unload them on close', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this[name] = value; },
      classList: { add() {}, remove() {} },
      showModal() { this.open = true; }, close() { this.open = false; this.listeners.close(); },
      removeAttribute(name) { delete this[name]; },
    });
    return elements.get(id);
  };
  let url, beer = 0;
  globalThis.fetch = async (target) => {
    url = target;
    return { ok: true, headers: { get: () => 'text/html' }, text: async () => '<html>game</html>' };
  };
  setupGames($, { claimBeer: () => { beer++; }, translate: (text) => text });
  await $('game-netcraft').listeners.click();
  assert.equal(url, '/games/netcraft/craft.html');
  assert.equal($('game-frame').src, url);
  $('game-close').listeners.click();
  assert.equal($('game-frame').src, undefined);
  await $('game-pk2').listeners.click();
  assert.equal(url, '/games/pk2/index.html');
  await $('switch-netcraft').listeners.click();
  assert.equal($('game-frame').src, '/games/netcraft/craft.html');
  assert.equal($('switch-netcraft')['aria-pressed'], 'true');
  assert.equal($('switch-pk2')['aria-pressed'], 'false');
  $('game-minimize').listeners.click();
  assert.equal($('game-dialog').open, false);
  assert.equal($('game-frame').src, '/games/netcraft/craftw.html');
  assert.equal($('game-restore').hidden, false);
  $('game-restore').listeners.click();
  assert.equal($('game-dialog').open, true);
  assert.equal($('game-frame').src, '/games/netcraft/craftw.html');
  globalThis.fetch = async () => ({ ok: false, headers: { get: () => '' } });
  await $('switch-pk2').listeners.click();
  assert.equal($('game-frame').src, '/games/netcraft/craft.html');
  assert.match($('game-dialog-status').textContent, /unavailable/);
  let resolveSwitch;
  globalThis.fetch = () => new Promise((resolve) => { resolveSwitch = resolve; });
  const pendingSwitch = $('switch-pk2').listeners.click();
  await $('switch-netcraft').listeners.click();
  resolveSwitch({ ok: true, headers: { get: () => 'text/html' }, text: async () => '<html>game</html>' });
  await pendingSwitch;
  assert.equal($('game-frame').src, '/games/netcraft/craft.html');
  assert.equal($('game-dialog-status').textContent, '');
  $('game-beer').listeners.click();
  assert.equal(beer, 1);
  $('game-close').listeners.click();
  globalThis.fetch = async () => ({ ok: false, headers: { get: () => '' } });
  await $('game-pk2').listeners.click();
  assert.match($('game-status').textContent, /unavailable/);
  assert.equal($('game-dialog').open, false);
  globalThis.fetch = async () => ({
    ok: true, headers: { get: () => 'text/html' },
    text: async () => '<button id="game-netcraft">fallback</button>',
  });
  await $('game-netcraft').listeners.click();
  assert.match($('game-status').textContent, /unavailable/);
  assert.equal($('game-dialog').open, false);
});

test('NetCraft receives the connected token address when launched', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.document = originalDocument; });
  globalThis.document = { body: { classList: { toggle() {} } }, addEventListener() {}, querySelector() { return { after() {} }; } };
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this[name] = value; }, removeAttribute(name) { delete this[name]; },
      appendChild(child) { child.parentNode = this; }, insertBefore(child) { child.parentNode = this; },
      focus() {}, classList: { add() {}, remove() {}, contains() { return false; } },
      show() { this.open = true; },
    });
    return elements.get(id);
  };
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'text/html' }, text: async () => '<html></html>' });
  let address = 'bitcoincash:ztest';
  const messages = [];
  $('game-frame').contentWindow = { postMessage: (message, origin) => messages.push({ message, origin }) };
  const update = setupGames($, { translate: (text) => text, getRewardAddress: () => address });
  await $('game-netcraft').listeners.click();
  assert.equal($('game-frame').src, '/games/netcraft/craft.html#-+4080+bitcoincash%3Aztest');
  address = null;
  update(address);
  $('game-frame').listeners.load();
  assert.equal($('game-notifications')['aria-label'], 'Connect wallet');
  assert.deepEqual(messages, [
    { message: { type: 'netcraft-reward-address', address: '' }, origin: '*' },
    { message: { type: 'netcraft-reward-address', address: '' }, origin: '*' },
  ]);
  update('bitcoincash:zother');
  assert.equal(messages[2].message.address, 'bitcoincash:zother');
  assert.equal($('game-notifications')['aria-label'], 'Wallet and notifications');
  assert.equal($('game-notifications')['aria-controls'], 'notifications-dialog');
});

test('fullscreen game regains keyboard focus without stealing focus from other dialogs', async (t) => {
  const previous = { fetch: globalThis.fetch, document: globalThis.document, raf: globalThis.requestAnimationFrame };
  t.after(() => {
    globalThis.fetch = previous.fetch;
    globalThis.document = previous.document;
    globalThis.requestAnimationFrame = previous.raf;
  });
  const elements = new Map();
  const callbacks = [];
  const $ = (id) => {
    if (!elements.has(id)) {
      const classes = new Set();
      elements.set(id, {
        listeners: {}, open: false,
        addEventListener(type, fn) { this.listeners[type] = fn; },
        setAttribute() {},
        appendChild(child) { child.parentNode = this; }, insertBefore(child) { child.parentNode = this; },
        classList: { add: (value) => classes.add(value), remove: (value) => classes.delete(value), contains: (value) => classes.has(value), toggle: (value, force) => force ? classes.add(value) : classes.delete(value) },
        show() { this.open = true; document.activeElement = $('game-close'); },
        focus() { document.activeElement = this; },
      });
    }
    return elements.get(id);
  };
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'text/html' }, text: async () => '<html></html>' });
  globalThis.document = { body: { classList: { toggle() {} } }, fullscreenElement: null, activeElement: null, addEventListener() {}, querySelector() { return { after() {} }; } };
  globalThis.requestAnimationFrame = (fn) => callbacks.push(fn);
  setupGames($, { translate: (text) => text });
  $('game-dialog').classList.add('game-auto-open');
  await $('game-netcraft').listeners.click();
  assert.equal(document.activeElement, $('game-close'));
  $('game-frame').listeners.load();
  assert.equal(document.activeElement, $('game-frame'));

  document.activeElement = $('game-notifications');
  $('connection-dialog').open = true;
  $('game-frame').listeners.load();
  assert.equal(document.activeElement, $('game-notifications'));
  $('connection-dialog').open = false;
  $('connection-dialog').listeners.close();
  callbacks.shift()();
  assert.equal(document.activeElement, $('game-frame'));

  document.activeElement = $('game-notifications');
  $('notifications-dialog').listeners.close();
  $('connection-dialog').open = true;
  callbacks.shift()();
  assert.equal(document.activeElement, $('game-notifications'));
  $('connection-dialog').open = false;
  document.activeElement = $('game-close');
  $('notifications-dialog').listeners.close();
  callbacks.shift()();
  assert.equal(document.activeElement, $('game-close'));

  $('game-dialog').classList.remove('game-auto-open');
  document.fullscreenElement = $('game-stage');
  document.activeElement = $('game-notifications');
  $('notifications-dialog').listeners.close();
  callbacks.shift()();
  assert.equal(document.activeElement, $('game-frame'));
});
>>>>>>> Stashed changes
