import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { setupGames } from '../src/games.js';

test('the combined wizard and wallet button leaves the other toolbar actions intact', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const toolbar = html.slice(html.indexOf('id="game-controls-right"'), html.indexOf('id="wizard-dialog"'));
  assert.match(toolbar, /id="game-notifications"[^>]*aria-controls="game-guide"[\s\S]*?src="\/wizard\.svg"[\s\S]*?src="\/mina-gem\.svg"/);
  assert.doesNotMatch(toolbar, /id="game-guide-open"/);
  for (const action of ['close', 'verify-wallet', 'crafting', 'ranking', 'invite', 'sound', 'send', 'receive', 'fullscreen']) {
    assert.ok(toolbar.includes(`id="game-${action}"`), action);
  }
  assert.match(html, /id="wiki-open"[^>]*>[\s\S]*?<\/button>\s*<button id="game-netcraft"[^>]*>\s*<img[^>]*>CashCraft\s*<\/button>/);
  assert.doesNotMatch(html, /id="games-menu"/);
});

test('toolbar initialization works without the removed game menu', () => {
  const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const handlers = {};
  const element = (id) => html.includes(`id="${id}"`) ? {
    hidden: true,
    addEventListener(type, handler) { handlers[`${id}:${type}`] = handler; },
    setAttribute(name, value) { this[name] = value; },
    focus() {},
  } : null;
  const elements = Object.fromEntries(['language-toggle', 'language-menu'].map(id => [id, element(id)]));
  const start = source.indexOf('\n}', source.indexOf('function report(')) + 2;
  const end = source.indexOf('\nlet updateGameRewardAddress', start);
  let language;
  runInNewContext(source.slice(start, end), {
    $: id => elements[id] ?? null,
    document: { addEventListener() {} },
    setLanguage: value => { language = value; },
    paymentPriceSnapshot: null,
  });
  handlers['language-toggle:click']();
  assert.equal(elements['language-menu'].hidden, false);
  handlers['language-menu:click']({ target: { closest: () => ({ dataset: { languageOption: 'es' } }) } });
  assert.equal(language, 'es');
  assert.equal(elements['language-menu'].hidden, true);
});

test('wizard tips fade without blocking play and crafting requires two spendable MINA', async (t) => {
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
      classList: { add() {}, remove() {}, toggle() {}, contains: (name) => id === 'game-dialog' && name === 'game-auto-open' },
      style: { setProperty() {} },
      show() { this.open = true; },
      showModal() { this.open = true; },
      close() { this.open = false; this.listeners.close?.(); },
      focus() {},
    });
    return elements.get(id);
  };
  const toolbar = {
    after(child) { child.parentNode = this; },
    appendChild(child) { child.parentNode = this; },
  };
  const documentListeners = {};
  globalThis.document = {
    documentElement: { classList: { remove() {} } },
    body: { classList: { toggle() {} } }, fullscreenElement: null,
    querySelector() { return toolbar; },
    addEventListener(type, fn) { documentListeners[type] = fn; },
    async exitFullscreen() {
      this.fullscreenElement = null;
      documentListeners.fullscreenchange();
    },
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
  let minaBalance = 0n;
  let pickaxeUnlocked = false;
  let connections = 0;
  let notifications = 0;
  $('connection-open').click = () => { connections++; };
  $('notifications-toggle').click = () => { notifications++; };
  const guestId = 'a'.repeat(64);
  $('game-frame').contentWindow = { postMessage() {} };
  const transfers = [];
  const update = setupGames($, {
    translate: (text) => text, isWalletConnected: () => connected, getGuestId: () => guestId,
    getMinaBalance: () => minaBalance, hasMinaPickaxe: () => pickaxeUnlocked,
    openPlayerTransfer: (target) => transfers.push(target),
  });
  const fetchGame = globalThis.fetch;
  const launchOrder = [];
  $('game-stage').requestFullscreen = async () => {
    launchOrder.push('fullscreen');
    throw new Error('Browser denied fullscreen');
  };
  $('game-frame').removeAttribute = () => {};
  globalThis.fetch = async () => {
    launchOrder.push('fetch');
    return { ok: false };
  };
  await $('game-netcraft').listeners.click({ isTrusted: true });
  assert.deepEqual(launchOrder, ['fullscreen', 'fetch']);
  assert.equal($('game-dialog').open, false);
  assert.match($('game-status').textContent, /unavailable/);
  globalThis.fetch = fetchGame;
  await $('game-netcraft').listeners.click();
  assert.equal($('game-guide').open, false);
  assert.equal($('game-wizard-message').textContent, undefined);
  $('game-frame').listeners.load();
  assert.equal($('game-wizard-speech').hidden, false);
  assert.match($('game-wizard-message').textContent, /bottom left to walk.*game view to look around/);
  $('game-wizard-next').listeners.click();
  assert.match($('game-wizard-step').textContent, /2\/5.*Mine ore/);
  assert.equal($('game-wizard-ores').children.length, 3);
  $('game-wizard-next').listeners.click();
  assert.equal($('game-wizard-wallet').hidden, false);
  assert.match($('game-wizard-message').textContent, /scan the QR.*approve/);
  $('game-wizard-next').listeners.click();
  $('game-wizard-next').listeners.click();
  assert.equal($('game-wizard-table').hidden, false);
  assert.equal($('game-wizard-craft').hidden, true);
  assert.match($('game-wizard-message').textContent, /20 natural MINA ore blocks.*review/);
  dismiss();
  assert.equal($('game-wizard-speech').hidden, true);
  assert.equal($('game-guide-wallet').textContent, 'Connect wallet');
  await $('game-close').listeners.click();
  assert.equal($('game-guide').open, false);
  $('game-controls-toggle').listeners.click();
  assert.equal($('game-extra-controls').hidden, true);
  $('game-stage').requestFullscreen = async () => {
    document.fullscreenElement = $('game-stage');
    documentListeners.fullscreenchange();
  };
  await $('game-netcraft').listeners.click({ isTrusted: true });
  assert.equal(document.fullscreenElement, $('game-stage'));
  assert.equal($('game-controls-right').parentNode, $('game-fullscreen-toolbar'));
  assert.equal($('game-fullscreen')['aria-label'], 'Minimize CashCraft');
  const gameUrl = $('game-frame').src;
  await $('game-fullscreen').listeners.click();
  assert.equal(document.fullscreenElement, null);
  assert.equal($('game-dialog').hidden, true);
  assert.equal($('game-frame').src, gameUrl);
  $('game-restore').listeners.click();
  assert.equal($('game-extra-controls').hidden, true);
  $('game-controls-toggle').listeners.click();
  assert.equal($('game-extra-controls').hidden, false);
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
  assert.equal($('game-crafting').hidden, true);
  const rewardAddress = 'bitcoincash:ztest';
  connected = true;
  minaBalance = 1n;
  update(rewardAddress);
  assert.equal($('game-crafting').hidden, true);
  minaBalance = 2n;
  update(rewardAddress);
  assert.equal($('game-crafting').hidden, false);
  assert.equal($('game-wizard-craft').hidden, false);
  pickaxeUnlocked = true;
  update(rewardAddress);
  assert.equal($('game-crafting').hidden, true);
  pickaxeUnlocked = false;
  connected = false;
  update(null);
  assert.equal($('game-crafting').hidden, true);
  $('game-notifications').listeners.click();
  assert.equal($('game-guide').open, true);
  $('game-guide-wallet').listeners.click();
  assert.equal($('game-guide').open, false);
  assert.equal(connections, 1);
  $('game-guide-open').listeners.click();
  assert.equal($('game-wizard-speech').hidden, false);
  message({ type: 'netcraft-tutorial-control', control: 'mobile-mine' });
  assert.match($('game-wizard-message').textContent, /^On a touchscreen/);
  $('game-guide-wallet').listeners.click();
  assert.equal(connections, 2);
  connected = true;
  update(null);
  assert.equal($('game-guide-wallet').textContent, 'Wallet and notifications');
  $('game-notifications').listeners.click();
  $('game-guide-wallet').listeners.click();
  assert.equal(notifications, 1);
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
  await $('game-netcraft').listeners.click();
  connected = false;
  let pairings = 0;
  $('connect').click = () => { pairings++; };
  $('game-wizard-next').listeners.click();
  $('game-wizard-next').listeners.click();
  $('game-wizard-next').listeners.click();
  $('game-wizard-wallet').listeners.click();
  assert.equal(connections, 3);
  assert.equal(pairings, 1);
  assert.equal($('game-wizard-speech').hidden, true);
  $('game-dialog').close();
  await $('game-netcraft').listeners.click({ isTrusted: true });
  assert.equal(document.fullscreenElement, $('game-stage'));
  assert.equal($('game-frame').src, '/games/netcraft/craftw.html#-+4080');
  assert.equal($('game-dialog').open, true);
});
