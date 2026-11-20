import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCashAddress } from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import { setupGames } from '../src/games.js';
import { BrowserWallet } from '../src/browser-wallet.js';

test('game buttons minimize and restore without unloading the active game', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.document = originalDocument; });
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this[name] = value; },
      appendChild(child) { child.parentNode = this; },
      prepend(child) { child.parentNode = this; },
      insertBefore(child) { child.parentNode = this; },
      classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
      focus() { this.focused = true; },
      show() { this.open = true; }, close() { this.open = false; this.listeners.close(); },
      removeAttribute(name) { delete this[name]; },
    });

    return elements.get(id);
  };
  let url;
  globalThis.fetch = async (target, options) => {
    url = target;
    assert.equal(options.cache, 'no-cache');
    return { ok: true, headers: { get: () => 'text/html' }, text: async () => '<html>game</html>' };
  };
  const documentListeners = {};
  let gameToolbarSelected = false;
  globalThis.document = {
    body: { classList: { toggle() {} } }, fullscreenElement: null,
    querySelector(selector) { gameToolbarSelected = selector === '.game-toolbar'; return { after() {} }; },
    addEventListener(type, fn) { documentListeners[type] = fn; },
    async exitFullscreen() { this.fullscreenElement = null; documentListeners.fullscreenchange(); },
  };
  let address = 'bitcoincash:ztest';
  $('top-send').parentNode = $('quick-nav');
  $('top-receive').parentNode = $('quick-nav');
  $('game-ranking').parentNode = { insertBefore(child) { child.parentNode = this; } };
  setupGames($, { translate: (text) => text, getRewardAddress: () => address });
  assert.equal(gameToolbarSelected, true);
  let wallet = 0;
  $('connection-open').click = () => { wallet++; };
  $('notifications-toggle').click = () => {};
  await $('game-notifications').listeners.click();
  assert.equal(wallet, 0);
  $('game-stage').requestFullscreen = async () => { document.fullscreenElement = $('game-stage'); documentListeners.fullscreenchange(); };
  await $('game-fullscreen').listeners.click();
  assert.equal(document.fullscreenElement, $('game-stage'));
  assert.equal($('top-send').parentNode, $('quick-nav'));
  const parent = { insertBefore(child) { child.parentNode = this; } };
  $('invite-dialog').parentNode = parent;
  $('game-invite').listeners.click();
  assert.equal($('invite-dialog').parentNode, $('game-stage'));
  $('invite-dialog').listeners.close();
  assert.equal($('invite-dialog').parentNode, parent);
  assert.equal($('game-frame').focused, true);
  assert.equal($('game-fullscreen')['aria-label'], 'Exit fullscreen');
  assert.equal($('game-fullscreen')['aria-pressed'], 'true');
  await $('game-fullscreen').listeners.click();
  assert.equal(document.fullscreenElement, null);
  assert.equal($('game-fullscreen')['aria-label'], 'Enter fullscreen');
  assert.equal($('game-fullscreen')['aria-pressed'], 'false');
  $('game-stage').requestFullscreen = async () => { throw new Error('denied'); };
  await $('game-fullscreen').listeners.click();
  assert.match($('game-dialog-status').textContent, /unavailable/);
  await $('game-netcraft').listeners.click();
  assert.equal($('games-menu').hidden, true);
  assert.equal($('top-send').parentNode, $('quick-nav'));
  assert.equal(url, '/games/netcraft/craftw.html');
  const gameUrl = '/games/netcraft/craftw.html#-+4080+bitcoincash%3Aztest';
  assert.equal($('game-frame').src, gameUrl);
  assert.equal($('game-frame').title, 'CashCraft');
  assert.equal($('game-wallet-prompt').hidden, true);
  address = null;
  $('game-frame').listeners.load();
  $('game-notifications').click = $('game-notifications').listeners.click;
  $('game-wallet-prompt-connect').listeners.click();
  assert.equal($('browser-wallet-section').open, true);
  assert.equal(wallet, 1);
  address = 'bitcoincash:ztest';
  $('game-stage').requestFullscreen = async () => { document.fullscreenElement = $('game-stage'); };
  await $('game-fullscreen').listeners.click();
  await $('game-close').listeners.click();
  assert.equal(document.fullscreenElement, null);
  assert.equal($('game-frame').src, gameUrl);
  assert.equal($('game-dialog').hidden, true);
  assert.equal($('game-minimized-controls').hidden, false);
  assert.equal($('games-menu').hidden, true);
  assert.equal($('top-send').parentNode, $('quick-nav'));
  $('game-restore').listeners.click();
  assert.equal($('game-dialog').hidden, false);
  assert.equal($('top-send').parentNode, $('quick-nav'));
  assert.equal($('game-frame').src, gameUrl);
  address = 'bitcoincash:ztest';
  $('game-frame').listeners.load();
  assert.equal($('game-wallet-prompt').hidden, true);
  let notifications = 0;
  $('notifications-toggle').click = () => { notifications++; };
  await $('game-notifications').listeners.click();
  assert.equal($('game-dialog').hidden, false);
  assert.equal(notifications, 1);
  assert.equal($('game-frame').src, gameUrl);
  address = 'bitcoincash:ztest';
  $('game-restore').listeners.click();
  await $('game-pk2').listeners.click();
  assert.equal(url, '/games/pk2/index.html');
  assert.equal($('game-wallet-prompt').hidden, true);
  await $('switch-netcraft').listeners.click();
  assert.equal($('game-frame').src, gameUrl);
  assert.equal($('switch-netcraft')['aria-pressed'], 'true');
  assert.equal($('switch-pk2')['aria-pressed'], 'false');
  globalThis.fetch = async () => ({ ok: false, headers: { get: () => '' } });
  await $('switch-pk2').listeners.click();
  assert.equal($('game-frame').src, gameUrl);
  assert.match($('game-dialog-status').textContent, /unavailable/);
  let resolveSwitch;
  globalThis.fetch = () => new Promise((resolve) => { resolveSwitch = resolve; });
  const pendingSwitch = $('switch-pk2').listeners.click();
  await $('switch-netcraft').listeners.click();
  resolveSwitch({ ok: true, headers: { get: () => 'text/html' }, text: async () => '<html>game</html>' });
  await pendingSwitch;
  assert.equal($('game-frame').src, gameUrl);
  assert.equal($('game-dialog-status').textContent, '');
  $('game-dialog').close();
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

test('NetCraft starts online without a wallet and accepts a registered address later', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.document = originalDocument; });
  globalThis.document = { body: { classList: { toggle() {} } }, addEventListener() {}, querySelector() { return { after() {} }; } };
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute() {}, appendChild() {}, classList: { add() {}, remove() {} },
      show() { this.open = true; },
    });
    return elements.get(id);
  };
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'text/html' }, text: async () => '<html></html>' });
  let address = null;
  const messages = [];
  $('game-frame').contentWindow = { postMessage: (message) => messages.push(message) };
  const update = setupGames($, {
    translate: (text) => text, getRewardAddress: () => address,
  });
  await $('game-netcraft').listeners.click();
  assert.equal($('game-frame').src, '/games/netcraft/craftw.html#-+4080');
  assert.equal($('game-wallet-prompt').hidden, false);
  address = 'bitcoincash:ztest';
  update(address);
  assert.deepEqual(messages.at(-1), { type: 'netcraft-reward-address', address });
  assert.equal($('game-wallet-prompt').hidden, true);
});

test('game gem opens connected wallet notifications even while reward registration is pending', (t) => {
  const originalDocument = globalThis.document;
  t.after(() => { globalThis.document = originalDocument; });
  globalThis.document = { body: { classList: { toggle() {} } }, addEventListener() {}, querySelector() { return { after() {} }; } };
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this[name] = value; }, appendChild() {},
      classList: { add() {}, remove() {} },
    });
    return elements.get(id);
  };
  let opened = 0;
  $('notifications-toggle').click = () => { opened++; };
  const update = setupGames($, {
    translate: (text) => text, getRewardAddress: () => null, isWalletConnected: () => true,
  });
  update(null);
  $('game-notifications').listeners.click();
  assert.equal(opened, 1);
  assert.equal($('game-notifications')['aria-controls'], 'notifications-dialog');
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
  const browserWallet = new BrowserWallet('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  t.after(() => browserWallet.destroy());
  const browserAddress = encodeCashAddress({
    prefix: 'bitcoincash', type: 'p2pkhWithTokens', payload: hash160(browserWallet.getPubkey(0, 0)),
  }).address;
  let address = browserAddress;
  const messages = [];
  $('game-frame').contentWindow = { postMessage: (message, origin) => messages.push({ message, origin }) };
  const update = setupGames($, { translate: (text) => text, getRewardAddress: () => address });
  await $('game-netcraft').listeners.click();
  assert.equal($('game-frame').src, `/games/netcraft/craftw.html#-+4080+${encodeURIComponent(browserAddress)}`);
  assert.equal($('game-wallet-prompt').hidden, true);
  address = null;
  update(address);
  $('game-frame').listeners.load();
  assert.equal($('game-notifications')['aria-label'], 'Connect wallet');
  assert.equal($('game-wallet-prompt').hidden, false);
  assert.deepEqual(messages, [
    { message: { type: 'netcraft-reward-address', address: browserAddress }, origin: '*' },
    { message: { type: 'netcraft-reward-address', address: '' }, origin: '*' },
    { message: { type: 'netcraft-reward-address', address: '' }, origin: '*' },
  ]);
  update('bitcoincash:zother');
  assert.equal(messages[3].message.address, 'bitcoincash:zother');
  assert.equal($('game-wallet-prompt').hidden, true);
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
  setupGames($, { translate: (text) => text, getRewardAddress: () => 'bitcoincash:ztest' });
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
