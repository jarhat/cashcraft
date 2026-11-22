import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCashAddress } from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import { setupGames } from '../src/games.js';
import { BrowserWallet } from '../src/browser-wallet.js';

const guestId = 'a'.repeat(64);
globalThis.window = { addEventListener() {} };
globalThis.localStorage = { getItem: () => guestId };

test('game buttons minimize and restore without unloading the active game', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const originalRaf = globalThis.requestAnimationFrame;
  const originalWindow = globalThis.window;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.document = originalDocument; globalThis.requestAnimationFrame = originalRaf; globalThis.window = originalWindow; });
  globalThis.requestAnimationFrame = () => {};
  const elements = new Map();
  const classes = new Map();
  const $ = (id) => {
    if (!classes.has(id)) classes.set(id, new Set());
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this[name] = value; },
      appendChild(child) { child.parentNode = this; },
      prepend(child) { child.parentNode = this; },
      insertBefore(child) { child.parentNode = this; },
      classList: {
        add: (name) => classes.get(id).add(name),
        remove: (name) => classes.get(id).delete(name),
        contains: (name) => classes.get(id).has(name),
        toggle() {},
      },
      style: { setProperty(name, value) { this[name] = value; } },
      children: [],
      replaceChildren() { this.children = []; },
      append(child) { this.children.push(child); },
      focus() { this.focused = true; },
      show() { this.open = true; }, close() { this.open = false; this.listeners.close(); },
      showModal() { this.open = true; },
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
  const toolbar = { after() {}, appendChild(child) { child.parentNode = this; } };
  let gameToolbarSelected = false;
  globalThis.document = {
    documentElement: { classList: { remove() {} } }, body: { classList: { toggle() {} } }, fullscreenElement: null,
    querySelector(selector) { gameToolbarSelected = selector === '.game-toolbar'; return toolbar; },
    createElement() {
      return { children: [], style: {}, setAttribute() {},
        append(child) { this.children.push(child); },
        prepend(child) { this.children.unshift(child); } };
    },
    addEventListener(type, fn) { documentListeners[type] = fn; },
    async exitFullscreen() { this.fullscreenElement = null; documentListeners.fullscreenchange(); },
  };
  let address = 'bitcoincash:ztest';
  $('top-send').parentNode = $('quick-nav');
  $('top-receive').parentNode = $('quick-nav');
  $('game-controls-right').parentNode = toolbar;
  $('game-ranking').parentNode = { insertBefore(child) { child.parentNode = this; } };
  let receiveGameEvent;
  globalThis.window = { addEventListener(type, listener) { if (type === 'message') receiveGameEvent = listener; } };
  const postedMessages = [];
  const gameWindow = { postMessage(message) { postedMessages.push(message); } };
  $('game-frame').contentWindow = gameWindow;
  $('game-restore').click = () => $('game-restore').listeners.click();
  let reviewed;
  let reviewPayment;
  setupGames($, {
    translate: (text) => text,
    getRewardAddress: () => address,
    openPlayerTransfer: async (target, show, share, leaveFullscreenGame) => {
      assert.equal(target, null);
      assert.equal(typeof leaveFullscreenGame, 'function');
      const popup = $('token-qr-dialog');
      popup.parentNode = $('quick-nav');
      assert.equal(show(popup, () => popup.show()), true);
      assert.equal(document.fullscreenElement, $('game-stage'));
      assert.equal(popup.parentNode, $('game-stage'));
      popup.close();
      share('mine12345678');
    },
    openGamePaymentRequest: async (request, show, leave) => {
      const popup = $('token-qr-dialog');
      assert.equal(show(popup, () => popup.show()), true);
      assert.equal(popup.parentNode, $('game-stage'));
      reviewPayment = async () => {
        popup.close();
        assert.equal(await leave(), true);
        reviewed = request.id;
      };
    },
  });
  assert.equal(gameToolbarSelected, true);
  let wallet = 0;
  $('connection-open').click = () => { wallet++; };
  $('notifications-toggle').click = () => {};
  await $('game-guide-wallet').listeners.click();
  assert.equal(wallet, 0);
  $('game-stage').requestFullscreen = async () => { document.fullscreenElement = $('game-stage'); documentListeners.fullscreenchange(); };
  await $('game-fullscreen').listeners.click();
  assert.equal(document.fullscreenElement, $('game-stage'));
  assert.equal($('game-controls-right').parentNode, $('game-fullscreen-toolbar'));
  assert.equal($('top-send').parentNode, $('quick-nav'));
  const parent = { insertBefore(child) { child.parentNode = this; } };
  $('invite-dialog').parentNode = parent;
  $('game-invite').listeners.click();
  assert.equal($('invite-dialog').parentNode, $('game-stage'));
  $('invite-dialog').listeners.close();
  assert.equal($('invite-dialog').parentNode, parent);
  assert.equal($('game-frame').focused, true);
  assert.equal($('game-fullscreen')['aria-label'], 'Minimize CashCraft');
  assert.equal($('game-fullscreen')['aria-pressed'], 'true');
  await $('game-fullscreen').listeners.click();
  assert.equal(document.fullscreenElement, null);
  assert.equal($('game-dialog').hidden, true);
  assert.equal($('game-controls-right').parentNode, toolbar);
  assert.equal($('game-fullscreen')['aria-label'], 'Enter fullscreen');
  assert.equal($('game-fullscreen')['aria-pressed'], 'false');
  $('game-stage').requestFullscreen = async () => { throw new Error('denied'); };
  await $('game-fullscreen').listeners.click();
  assert.match($('game-dialog-status').textContent, /unavailable/);
  await $('game-netcraft').listeners.click();
  assert.equal($('top-send').parentNode, $('quick-nav'));
  assert.equal(url, '/games/netcraft/craftw.html');
  const gameUrl = '/games/netcraft/craftw.html#-+4080+bitcoincash%3Aztest';
  assert.equal($('game-frame').src, gameUrl);
  assert.equal($('game-frame').title, 'CashCraft');
  const wizard = $('game-notifications');
  assert.equal(wizard.classList.contains('tutorial-active'), true);
  assert.match($('game-wizard-message').textContent, /^Use WASD/);
  const readingTime = Number.parseInt($('game-wizard-speech').style['--wizard-tip-duration']);
  assert.ok(readingTime >= 7000);
  t.mock.timers.tick(readingTime - 1);
  assert.match($('game-wizard-message').textContent, /^Use WASD/);
  t.mock.timers.tick(1);
  assert.match($('game-wizard-message').textContent, /^Mine 10 natural green MINA ore blocks/);
  await receiveGameEvent({ source: gameWindow, data: { type: 'netcraft-ore-progress', counts: [4, 2, 1] } });
  const rows = $('game-wizard-ores').children;
  assert.deepEqual(rows.map((row) => row.textContent), ['MINA ore: 4/10', 'Lapis ore: 2/10', 'Redstone ore: 1/10']);
  assert.ok(rows.every((row) => row.children[0].className === 'wizard-ore-texture'));
  for (let step = 0; step < 5; step++) {
    t.mock.timers.tick(Number.parseInt($('game-wizard-speech').style['--wizard-tip-duration']));
  }
  assert.equal(wizard.classList.contains('tutorial-active'), false);
  assert.equal($('game-wizard-speech').hidden, true);
  $('game-stage').requestFullscreen = async () => { document.fullscreenElement = $('game-stage'); documentListeners.fullscreenchange(); };
  await $('game-fullscreen').listeners.click();
  await $('game-receive').listeners.click();
  assert.equal(document.fullscreenElement, $('game-stage'));
  assert.deepEqual(postedMessages.at(-1), { type: 'netcraft-share-payment', id: 'mine12345678' });
  const payment = { type: 'netcraft-payment-request', name: 'Miner', id: 'abc123456789' };
  await receiveGameEvent({ source: {}, data: payment });
  await receiveGameEvent({ source: gameWindow, data: { ...payment, id: '../malicious' } });
  assert.equal($('game-payment-bubble').hidden, true);
  await receiveGameEvent({ source: gameWindow, data: payment });
  assert.equal($('game-payment-bubble').hidden, false);
  assert.equal($('game-payment-qr').src, '/api/qr.png?s=abc123456789');
  assert.equal($('game-payment-link').href, '/s/abc123456789');
  await $('game-payment-link').listeners.click({ preventDefault() {} });
  assert.equal(document.fullscreenElement, $('game-stage'));
  assert.equal($('game-dialog').hidden, false);
  await reviewPayment();
  assert.equal(reviewed, payment.id);
  assert.equal($('game-payment-bubble').hidden, true);
  assert.equal($('game-dialog').hidden, true);
  $('game-restore').click();
  address = null;
  $('game-frame').listeners.load();
  $('game-guide-wallet').listeners.click();
  assert.equal(wallet, 1);
  address = 'bitcoincash:ztest';
  $('game-stage').requestFullscreen = async () => { document.fullscreenElement = $('game-stage'); };
  await $('game-fullscreen').listeners.click();
  await $('game-close').listeners.click();
  assert.equal(document.fullscreenElement, null);
  assert.equal($('game-frame').src, gameUrl);
  assert.equal($('game-dialog').hidden, true);
  assert.equal($('game-minimized-controls').hidden, false);
  assert.equal($('top-send').parentNode, $('quick-nav'));
  $('game-restore').listeners.click();
  assert.equal($('game-dialog').hidden, false);
  assert.equal($('top-send').parentNode, $('quick-nav'));
  assert.equal($('game-frame').src, gameUrl);
  address = 'bitcoincash:ztest';
  $('game-frame').listeners.load();
  let notifications = 0;
  $('notifications-toggle').click = () => { notifications++; };
  await $('game-guide-wallet').listeners.click();
  assert.equal($('game-dialog').hidden, false);
  assert.equal(notifications, 1);
  assert.equal($('game-frame').src, gameUrl);
  address = 'bitcoincash:ztest';
  $('game-restore').listeners.click();
  await $('game-pk2').listeners.click();
  assert.equal(url, '/games/pk2/index.html');
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
  globalThis.document = { documentElement: { classList: { remove() {} } }, body: { classList: { toggle() {} } }, addEventListener() {}, querySelector() { return { after() {} }; } };
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
  let pickaxe = false;
  const messages = [];
  $('game-frame').contentWindow = { postMessage: (message) => messages.push(message) };
  const update = setupGames($, {
    translate: (text) => text, getRewardAddress: () => address, hasMinaPickaxe: () => pickaxe,
  });
  await $('game-netcraft').listeners.click();
  assert.equal($('game-frame').src, '/games/netcraft/craftw.html#-+4080');
  address = 'bitcoincash:ztest';
  update(address);
  assert.deepEqual(messages.at(-1), { type: 'netcraft-reward-address', address, pickaxe: false, connected: true, guestId, embeddedSound: true });
  pickaxe = true;
  update(address);
  assert.equal(messages.at(-1).pickaxe, true);
  address = null;
  update(address);
  assert.equal(messages.at(-1).pickaxe, false);
});

test('combined guide and wallet control keeps notifications available during reward registration', (t) => {
  const originalDocument = globalThis.document;
  t.after(() => { globalThis.document = originalDocument; });
  globalThis.document = { documentElement: { classList: { remove() {} } }, body: { classList: { toggle() {} } }, addEventListener() {}, querySelector() { return { after() {} }; } };
  const elements = new Map();
  const $ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this[name] = value; }, appendChild() {},
      classList: { add() {}, remove() {} },
      showModal() { this.open = true; },
      close() { this.open = false; },
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
  assert.equal($('game-guide').open, true);
  assert.equal(opened, 0);
  $('game-guide-wallet').listeners.click();
  assert.equal($('game-guide').open, false);
  assert.equal(opened, 1);
});

test('NetCraft receives the connected token address when launched', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  t.after(() => { globalThis.fetch = originalFetch; globalThis.document = originalDocument; });
  globalThis.document = { documentElement: { classList: { remove() {} } }, body: { classList: { toggle() {} } }, addEventListener() {}, querySelector() { return { after() {} }; } };
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
  address = null;
  update(address);
  $('game-frame').listeners.load();
  assert.equal($('game-guide-wallet').textContent, 'Connect wallet');
  assert.deepEqual(messages, [
    { message: { type: 'netcraft-reward-address', address: browserAddress, pickaxe: false, connected: true, guestId, embeddedSound: true }, origin: '*' },
    { message: { type: 'netcraft-reward-address', address: '', pickaxe: false, connected: false, guestId, embeddedSound: true }, origin: '*' },
    { message: { type: 'netcraft-reward-address', address: '', pickaxe: false, connected: false, guestId, embeddedSound: true }, origin: '*' },
  ]);
  update('bitcoincash:zother');
  assert.equal(messages[3].message.address, 'bitcoincash:zother');
  assert.equal($('game-guide-wallet').textContent, 'Wallet and notifications');
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
        close() { this.open = false; this.listeners.close(); },
        focus() { document.activeElement = this; },
      });
    }
    return elements.get(id);
  };
  globalThis.fetch = async () => ({ ok: true, headers: { get: () => 'text/html' }, text: async () => '<html></html>' });
  globalThis.document = { documentElement: { classList: { remove() {} } }, body: { classList: { toggle() {} } }, fullscreenElement: null, activeElement: null, addEventListener() {}, querySelector() { return { after() {} }; } };
  globalThis.requestAnimationFrame = (fn) => callbacks.push(fn);
  setupGames($, { translate: (text) => text, getRewardAddress: () => 'bitcoincash:ztest' });
  $('game-dialog').classList.add('game-auto-open');
  await $('game-netcraft').listeners.click();
  $('game-guide').close();
  callbacks.length = 0;
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
