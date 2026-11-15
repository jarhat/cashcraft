import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

function sharedLinkFixture(search) {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '', readOnly: false, hidden: false, textContent: '',
        options: [{}], classList: { remove() {} },
        showModal() { this.open = true; },
      });
    }
    return elements.get(id);
  }
  const meta = new Map();
  const document = {
    getElementById: element,
    querySelector(selector) {
      if (!meta.has(selector)) meta.set(selector, {});
      return meta.get(selector);
    },
  };
  const body = source.slice(source.indexOf('function fillFromUrl()'), source.indexOf('\nconst mainnet'));
  runInNewContext(`${body}\nfillFromUrl();`, {
    URLSearchParams, Object, document, $: element, walletReady: false,
    window: { location: { search, href: `https://ctf.example/${search}` } },
  });
  return element;
}

test('a complete shared request opens an unread notification and locks its fields', () => {
  const category = 'a'.repeat(64);
  const element = sharedLinkFixture(`?addr=bitcoincash%3Aztest&category=${category}&amount=42`);
  assert.equal(element('notifications-dialog').open, true);
  assert.equal(element('notification-indicator').hidden, false);
  assert.equal(element('shared-link-amount').textContent, '42 token base units');
  assert.equal(element('shared-link-category').textContent, category);
  assert.equal(element('category').readOnly, true);
  assert.equal(element('category-selector').hidden, true);
  assert.equal(element('recipient').readOnly, true);
  assert.equal(element('amount').readOnly, true);
});

test('partial and empty links do not create a request notification', () => {
  const categoryOnly = sharedLinkFixture('?category=abc');
  assert.equal(categoryOnly('notifications-dialog').open, undefined);
  assert.equal(categoryOnly('category-selector').hidden, true);
  assert.equal(categoryOnly('amount').readOnly, false);
  const emptyCategory = sharedLinkFixture('?category=%20');
  assert.equal(emptyCategory('category-selector').hidden, false);
  assert.equal(emptyCategory('notifications-dialog').open, undefined);
});

test('notification can be dismissed outside and reopened with its request intact', () => {
  class Element {
    constructor() { this.listeners = {}; }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close(); }
    focus() {}
    getBoundingClientRect() { return { left: 10, right: 100, top: 10, bottom: 100 }; }
  }
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const start = source.indexOf("const notificationsDialog = $('notifications-dialog')");
  const end = source.indexOf("\nif (document.readyState", start);
  runInNewContext(source.slice(start, end), {
    $: element, setTransferTab() {},
  });
  const dialog = element('notifications-dialog');
  const indicator = element('notification-indicator');
  dialog.open = true;
  indicator.hidden = false;
  dialog.listeners.click({ clientX: 50, clientY: 50 });
  assert.equal(dialog.open, true);
  dialog.listeners.click({ clientX: 1, clientY: 50 });
  assert.equal(dialog.open, false);
  assert.equal(indicator.hidden, true);
  element('notifications-toggle').listeners.click();
  assert.equal(dialog.open, true);
  assert.equal(indicator.hidden, true);
});

function sendFixture({ connected = false, pairing = false, relay = null, inProgress = false } = {}) {
  const calls = [];
  let handler;
  const nodes = {
    send: { addEventListener(type, fn) { handler = fn; } },
    'connection-section': { scrollIntoView() { calls.push('scroll'); } },
    connect: { focus() { calls.push('focus'); } },
    pairing: { classList: { contains() { return !pairing; } } },
  };
  const start = source.indexOf("$('send').addEventListener('click'");
  const end = source.indexOf('\nconst notificationsDialog', start);
  runInNewContext(source.slice(start, end), {
    $: (id) => nodes[id], walletReady: connected, pairingInProgress: inProgress, relay,
    sendFungibleTokens: () => calls.push('send'),
    startConnection: () => calls.push('connect'),
    showPairingUri: (uri) => { calls.push(uri); return Promise.resolve(); },
    report: () => {},
  });
  handler();
  return calls;
}

test('review opens pairing when disconnected without sending a transaction', () => {
  assert.deepEqual(sendFixture(), ['scroll', 'focus', 'connect']);
  assert.deepEqual(sendFixture({ relay: { uri: 'wc:test' } }), ['scroll', 'focus', 'wc:test']);
  assert.deepEqual(sendFixture({ pairing: true }), ['scroll', 'focus']);
  assert.deepEqual(sendFixture({ inProgress: true }), ['scroll', 'focus']);
});

test('review uses the normal send flow when connected', () => {
  assert.deepEqual(sendFixture({ connected: true }), ['send']);
});

test('review during session restoration displays pairing after the relay is ready', async () => {
  let release;
  const dependencies = new Promise((resolve) => { release = resolve; });
  const calls = [];
  let review;
  const nodes = {
    connect: { focus() {}, disabled: false },
    log: { textContent: '' },
    pairing: { classList: { add() {}, contains() { return true; } } },
    'open-wallet': { removeAttribute() {} },
    status: { textContent: '' },
    send: { addEventListener(type, handler) { review = handler; } },
    'connection-section': { scrollIntoView() {} },
  };
  const connectionStart = source.indexOf('async function startConnection(');
  const connectionEnd = source.indexOf('\nasync function fetchBchUsd', connectionStart);
  const sendStart = source.indexOf("$('send').addEventListener('click'");
  const sendEnd = source.indexOf('\nconst notificationsDialog', sendStart);
  const context = {
    $: (id) => nodes[id], relay: null, manager: null,
    walletReady: false, pairingInProgress: false, showPairingWhenReady: false,
    clearWalletDisplay() {}, setConnection() {},
    loadWalletDependencies: () => dependencies,
    loadSession: () => ({ walletPublicKey: 'saved' }),
    DappConnectionManager: class { on() {} attachRelay() {} },
    initiateDappRelay: () => ({ uri: 'wc:restored', cleanup() {} }),
    showPairingUri: async (uri) => { calls.push(uri); },
    sendFungibleTokens() { throw new Error('must not send'); },
    report(error) { throw error; },
  };
  runInNewContext(`${source.slice(connectionStart, connectionEnd)}\n${source.slice(sendStart, sendEnd)}`, context);
  const restoring = context.startConnection({ restoring: true });
  review();
  release();
  await restoring;
  assert.deepEqual(calls, ['wc:restored']);
  assert.equal(context.pairingInProgress, false);
  assert.equal(context.showPairingWhenReady, false);
});

test('portfolio abbreviates category IDs but copies the full ID', async () => {
  class Element {
    constructor() {
      this.children = [];
      this.classList = { add() {}, remove() {} };
      this.options = [];
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.options = children; }
    add(option) { this.options.push(option); }
    setAttribute() {}
    addEventListener(type, handler) { this.handler = handler; }
  }
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  element('category').value = '';
  let copied;
  const category = '0123456789abcdef'.repeat(4);
  const start = source.indexOf('function renderBalances(');
  const end = source.indexOf('\nasync function refreshBalances', start);
  runInNewContext(`${source.slice(start, end)}\nrenderBalances(utxos);`, {
    $: element, walletReady: true, bchUsd: null, SATOSHIS_PER_BCH: 100_000_000n,
    formatBch: () => '0.00001000', Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    document: { createElement: () => new Element() },
    navigator: { clipboard: { writeText: async (value) => { copied = value; } } },
    translate: (text) => text, setTimeout() {}, report(error) { throw error; },
    utxos: [{ satoshis: 1000n, token: { category, amount: 5n } }],
  });
  const summary = element('tokens').children[0].children[0];
  const categoryLine = summary.children[1].children[1];
  assert.equal(categoryLine.children[0].textContent, `${category.slice(0, 10)}…${category.slice(-8)}`);
  assert.match(categoryLine.children[1].innerHTML, /<svg/);
  await categoryLine.children[1].handler();
  assert.equal(copied, category);
});
