import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('theme preferences migrate and select the correct palette', () => {
  for (const [saved, expected] of [['bch', 'aurora'], ['bch-sunrise', 'aurora'], ['green', 'aurora'], ['blue', 'frost'], ['dark', 'frost'], ['aurora', 'aurora'], ['frost', 'frost'], ['unknown', 'frost']]) {
    const buttons = ['frost', 'aurora'].map((themeOption) => ({
      dataset: { themeOption },
      setAttribute(name, value) { this[name] = value; },
    }));
    const document = {
      documentElement: { dataset: {} },
      querySelector() { return this.meta; },
      querySelectorAll() { return buttons; },
      meta: {},
    };
    const localStorage = {
      getItem() { return saved; },
      setItem(key, value) { this[key] = value; },
    };
    const start = source.indexOf('const savedTheme =');
    const end = source.indexOf("\nfor (const name of ['theme', 'language'])", start);
    runInNewContext(source.slice(start, end), { document, localStorage });
    assert.equal(document.documentElement.dataset.theme, expected);
    assert.equal(localStorage['ctf-theme'], expected);
    assert.equal(document.meta.content, '#080a10');
    assert.equal(buttons.find((button) => button.dataset.themeOption === expected)['aria-pressed'], 'true');
  }
});

test('wizard highlights and scrolls to each tutorial panel without moving the navigation', () => {
  const elements = new Map();
  const highlighted = new Set();
  let guidePosition = 'hero';
  let scrolled;
  const guide = { scrollIntoView() {}, contains() { return false; }, classList: { add() {}, remove() {} } };
  const target = (position) => ({ before(node) {
    assert.equal(node, guide);
    guidePosition = position;
  } });
  const grid = target('grid');
  const hero = { after(node) {
    assert.equal(node, guide);
    guidePosition = 'hero';
  } };
  for (const id of ['connection-section', 'balance-section', 'earn-section', 'transfer-section']) {
    const panel = {
      ...target(id),
      scrollIntoView() { scrolled = id; },
      closest(selector) {
        assert.equal(selector, '.grid');
        return id === 'connection-section' || id === 'balance-section' ? grid : null;
      },
      classList: {
        add() { highlighted.add(panel); },
        remove() { highlighted.delete(panel); },
      },
    };
    elements.set(id, panel);
  }
  for (const id of ['wizard-toggle', 'wizard-dialog', 'wizard-title', 'wizard-message', 'wizard-progress', 'wizard-prev', 'wizard-next', 'wallet-help']) {
    elements.set(id, {
      hidden: id === 'wizard-dialog',
      addEventListener(type, handler) { this[type] = handler; },
      setAttribute() {},
    });
  }
  const document = {
    querySelector(selector) { return selector === '.hero' ? hero : guide; },
    querySelectorAll() { return [...highlighted]; },
  };
  const start = source.indexOf('const tutorialSteps =');
  const end = source.indexOf('\n\nfetchBchUsd();', start);
  runInNewContext(source.slice(start, end), { document, $: (id) => elements.get(id) });

  elements.get('wizard-toggle').click();
  assert.equal(guidePosition, 'hero');
  assert.equal(scrolled, 'connection-section');
  assert.equal(elements.get('wizard-progress').textContent, '1 / 4');
  elements.get('wizard-next').click();
  assert.equal(scrolled, 'balance-section');
  elements.get('wizard-next').click();
  assert.equal(scrolled, 'transfer-section');
  elements.get('wizard-next').click();
  assert.equal(scrolled, 'earn-section');
  elements.get('wizard-prev').click();
  assert.equal(scrolled, 'transfer-section');
  elements.get('wizard-toggle').click();
  assert.equal(guidePosition, 'hero');
  assert.equal(elements.get('wizard-dialog').hidden, true);
  assert.equal(highlighted.size, 0);
});

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

function sendFixture({ connected = false, balance = null } = {}) {
  const calls = [];
  let handler;
  const nodes = {
    send: { addEventListener(type, fn) { handler = fn; } },
  };
  const start = source.indexOf("$('send').addEventListener('click'");
  const end = source.indexOf('\nfunction showFundingDialog', start);
  runInNewContext(source.slice(start, end), {
    $: (id) => nodes[id], walletReady: connected, balanceSatoshis: balance,
    sendFungibleTokens: () => calls.push('send'),
    showFundingDialog: () => calls.push('funding'),
  });
  handler();
  return calls;
}

test('review offers funding or connection without sending a transaction', () => {
  assert.deepEqual(sendFixture(), ['funding']);
  assert.deepEqual(sendFixture({ connected: true, balance: 0n }), ['funding']);
});

test('review uses the normal send flow when connected', () => {
  assert.deepEqual(sendFixture({ connected: true }), ['send']);
});

test('connect during relay startup displays a fresh pairing after it is ready', async () => {
  let release;
  const dependencies = new Promise((resolve) => { release = resolve; });
  const calls = [];
  let connect;
  const nodes = {
    connect: { focus() {}, disabled: false },
    log: { textContent: '' },
    pairing: { classList: { add() {}, contains() { return true; } } },
    'open-wallet': { removeAttribute() {} },
    status: { textContent: '' },
    'funding-connect': { addEventListener(type, handler) { connect = handler; } },
    'funding-close': { addEventListener() {} },
    'funding-dialog': { close() {} },
    'connection-section': { scrollIntoView() {} },
  };
  const connectionStart = source.indexOf('async function startConnection(');
  const connectionEnd = source.indexOf('\nasync function fetchBchUsd', connectionStart);
  const sendStart = source.indexOf('function showFundingDialog');
  const sendEnd = source.indexOf('\nconst notificationsDialog', sendStart);
  const context = {
    $: (id) => nodes[id], relay: null, manager: null,
    walletReady: false, pairingInProgress: false, showPairingWhenReady: false,
    clearWalletDisplay() {}, setConnection() {},
    loadWalletDependencies: () => dependencies,
    loadSession: () => ({ walletPublicKey: 'saved' }),
    DappConnectionManager: class { on() {} attachRelay() {} updateConnection() {} clearStoredSession() {} },
    initiateDappRelay: () => ({ uri: 'wc:restored', cleanup() {}, client: {}, events: { on() {} } }),
    showPairingUri: async (uri) => { calls.push(uri); },
    sendFungibleTokens() { throw new Error('must not send'); },
    report(error) { throw error; },
    openTutorial() {},
  };
  runInNewContext(`${source.slice(connectionStart, connectionEnd)}\n${source.slice(sendStart, sendEnd)}`, context);
  const restoring = context.startConnection({ restoring: true });
  connect();
  release();
  await restoring;
  assert.deepEqual(calls, ['wc:restored']);
  assert.equal(context.pairingInProgress, false);
  assert.equal(context.showPairingWhenReady, false);
});

test('transfer selection is highlighted after an explicit selection', () => {
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      attributes: {}, classes: new Set(),
      setAttribute(name, value) { this.attributes[name] = value; },
      classList: {
        toggle(name, enabled) { enabled ? nodes.get(id).classes.add(name) : nodes.get(id).classes.delete(name); },
        remove(name) { nodes.get(id).classes.delete(name); },
      },
    });
    return nodes.get(id);
  };
  const start = source.indexOf('function setTransferTab(');
  const end = source.indexOf('\nfunction updateReceiveAddress', start);
  const context = { $: element, walletReady: false, transferInteracted: false };
  runInNewContext(source.slice(start, end), context);
  context.setTransferTab('send');
  assert.equal(element('send-tab').attributes['aria-selected'], 'true');
  assert.equal(element('send-tab').classes.has('active'), true);
  assert.equal(element('top-send').classes.has('active'), true);
  context.setTransferTab('receive');
  assert.equal(element('receive-tab').classes.has('active'), true);
  assert.equal(element('top-receive').classes.has('active'), true);
});

test('address scan count applies to both derivation paths and rejects invalid limits', () => {
  let count = '3';
  const start = source.indexOf('function deriveScanAddresses()');
  const end = source.indexOf('\nasync function showPairingUri', start);
  const context = {
    $: () => ({ value: count }),
    addressFor: (path, index, type) => `${path}/${index}/${type}`,
  };
  runInNewContext(source.slice(start, end), context);
  const records = context.deriveScanAddresses();
  assert.equal(records.length, 6);
  assert.equal(records[5].tokenAddress, '1/2/p2pkhWithTokens');
  count = '0';
  assert.throws(() => context.deriveScanAddresses(), /between 1 and 1000/);
  count = '1.5';
  assert.throws(() => context.deriveScanAddresses(), /whole number/);
});

test('token decimals are formatted exactly without losing large base units', () => {
  const start = source.indexOf('function formatTokenAmount(');
  const end = source.indexOf('\nfunction updateAmountHelp', start);
  const context = {};
  runInNewContext(source.slice(start, end), context);
  assert.equal(context.formatTokenAmount(1234567890123456789n, 8), '12345678901.23456789');
  assert.equal(context.formatTokenAmount(5n, 3), '0.005');
  assert.equal(context.formatTokenAmount(5n, 0), '5');
});

test('late scans restart the manager handshake and attach the listener immediately', async () => {
  let time = 1000;
  let keyExchange;
  let callback;
  const statuses = [];
  const element = () => ({
    classList: { add() {}, remove() {} },
    removeAttribute() {}, set textContent(value) {}, disabled: false, hidden: true,
  });
  const start = source.indexOf('async function startConnection(');
  const end = source.indexOf('\nasync function fetchBchUsd', start);
  const context = {
    $: element, relay: null, manager: null, walletReady: false,
    pairingInProgress: false, showPairingWhenReady: false,
    Date: { now: () => time }, clearWalletDisplay() {}, setConnection() {},
    loadWalletDependencies: async () => {}, loadSession: () => null,
    DappConnectionManager: class {
      on() {} attachRelay() {}
      updateConnection(client, status) { statuses.push(status.status); }
    },
    initiateDappRelay: (fn) => {
      callback = fn;
      return { uri: 'wiz:test', client: {}, cleanup() {}, events: { on(event, handler) { keyExchange = handler; } } };
    },
    showPairingUri: async () => {}, report(error) { throw error; },
  };
  runInNewContext(source.slice(start, end), context);
  await context.startConnection();
  assert.deepEqual(statuses, ['connecting']);
  callback({ client: {}, status: { status: 'connected' } });
  time += 31_000;
  keyExchange();
  assert.deepEqual(statuses, ['connecting', 'connected', 'connected']);
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
    $: element, walletReady: true, bchUsd: null, portfolioVersion: 0, mainnet: true, network: 'mainnet', SATOSHIS_PER_BCH: 100_000_000n,
    tokenBalances: new Map(), pricedPortfolioBch: 0, updateAmountHelp() {}, updateTotalValue() {},
    loadTokenLogo: () => new Promise(() => {}),
    fetchTokenMetadata: () => new Promise(() => {}), fetchCauldronSpot: () => new Promise(() => {}),
    formatBch: () => '0.00001000', Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    document: { createElement: () => new Element() },
    navigator: { clipboard: { writeText: async (value) => { copied = value; } } },
    translate: (text) => text, setTimeout() {}, report(error) { throw error; },
    utxos: [{ satoshis: 1000n, token: { category, amount: 5n } }],
  });
  const summary = element('tokens').children[0].children[0];
  const categoryLine = summary.children[1].children[1];
  assert.equal(categoryLine.children[1].textContent, `${category.slice(0, 10)}…${category.slice(-8)}`);
  assert.match(categoryLine.children[2].innerHTML, /<svg/);
  const metadata = summary.children[1].children[2];
  assert.equal(metadata.hidden, true);
  categoryLine.children[0].handler();
  assert.equal(metadata.hidden, false);
  assert.equal(summary.children[1].children[1], categoryLine);
  await categoryLine.children[2].handler();
  assert.equal(copied, category);
});

test('priced metadata updates balances, token choices and allocation', async () => {
  class Element {
    constructor() { this.children = []; this.options = []; this.style = {}; this.value = ''; this.classList = { add() {}, remove() {} }; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.options = children; }
    add(option) { this.options.push(option); }
    setAttribute() {}
    addEventListener(type, handler) { this[type] = handler; }
  }
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const category = '1'.repeat(64);
  element('category').value = category;
  element('amount').value = '125';
  const helpers = source.slice(source.indexOf('function updateTotalValue()'), source.indexOf('\nasync function fetchAddressUtxosWithRetry'));
  const render = source.slice(source.indexOf('function renderBalances('), source.indexOf('\nasync function refreshBalances'));
  const context = {
    $: element, walletReady: true, bchUsd: 200, balanceSatoshis: 100_000_000n,
    portfolioVersion: 0, tokenBalances: new Map(), pricedPortfolioBch: 0, mainnet: true, network: 'mainnet',
    SATOSHIS_PER_BCH: 100_000_000n, formatBch: () => '1.00000000',
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    document: { createElement: () => new Element(), createTextNode: (text) => ({ textContent: text }) },
    fetchTokenMetadata: async () => ({ name: 'Example', symbol: 'EX', decimals: 2, description: 'Example token', uris: { web: 'https://example.com' } }),
    fetchCauldronSpot: async () => 0.0001,
    loadTokenLogo: () => new Promise(() => {}), translate: (text) => text,
    console, navigator: {}, setTimeout() {}, report(error) { throw error; },
  };
  runInNewContext(`${helpers}\n${render}`, context);
  context.renderBalances([{ satoshis: 100_000_000n, token: { category, amount: 125n } }]);
  assert.equal(element('portfolio-chart').hidden, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element('portfolio-chart').hidden, false);
  assert.match(element('balance-tokens').children[0].textContent, /1\.25 EX.*\$2\.50/);
  assert.match(element('token-options-list').children[0].children[1].textContent, /Example.*\$2\.000/);
  assert.match(element('amount-help').textContent, /2 decimals.*Entered: 1\.25 EX/);
  assert.match(element('total-value').textContent, /202\.50/);
  const metadata = element('tokens').children[0].children[0].children[1].children[2];
  assert.match(metadata.textContent, /Example token.*example\.com/);
});

test('payment QR draws the loaded token logo and ignores a stale result', async () => {
  const nodes = new Map();
  const canvasDraws = [];
  let handler;
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: '', textContent: '',
      classList: {
        hidden: false,
        add() { this.hidden = true; },
        remove() { this.hidden = false; },
        contains() { return this.hidden; },
      },
      addEventListener(type, fn) { if (id === 'generate-payment') handler = fn; },
      replaceChildren(child) { this.child = child; },
      getContext() { return { drawImage: (...args) => canvasDraws.push(args), fillRect() {} }; },
    });
    return nodes.get(id);
  };
  const category = 'a'.repeat(64);
  element('receive-category').value = category;
  element('receive-amount').value = '2';
  element('receive-address').value = 'bitcoincash:ztest';
  let resolveLogo, rejectLogo, failPrice = false;
  const logo = { cloneNode: () => ({}) };
  const start = source.indexOf("$('generate-payment').addEventListener('click'");
  const end = source.indexOf("\nfor (const id of ['receive-address'", start);
  const helpers = source.slice(source.indexOf('function paymentQrImage()'), source.indexOf("\n$('download-payment-qr')"));
  runInNewContext(`${source.slice(start, end)}\n${helpers}`, {
    $: element, walletReady: false, mainnet: true, loadWalletDependencies: async () => {},
    validateRecipient: (address) => address,
    network: 'mainnet', paymentGeneration: 0, paymentPriceSnapshot: null,
    window: { location: { href: 'https://ctf.example/' } }, URL,
    document: { createElement: () => ({ width: 512, getContext: () => ({ fillRect() {} }) }) },
    QRCode: { toCanvas: async () => {} },
    loadTokenLogo: () => new Promise((resolve, reject) => { resolveLogo = resolve; rejectLogo = reject; }),
    fetchCauldronSpot: async () => { if (failPrice) throw new Error('offline'); return 0.001; },
    translate: (text) => text, console: { warn() {} }, report(error) { throw error; },
  });
  await handler();
  assert.equal(element('download-payment-qr').disabled, false);
  resolveLogo(logo);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(canvasDraws.some(([image]) => image === logo));
  assert.ok(element('payment-token-icon').child);
  assert.equal(element('download-payment-qr').disabled, false);
  assert.match(element('payment-price').textContent, /0\.001000 BCH \/ base unit · \d{4}-\d\d-\d\dT/);

  await handler();
  element('payment-result').classList.add('hidden');
  const previousDraws = canvasDraws.length;
  resolveLogo(logo);
  await Promise.resolve();
  assert.equal(canvasDraws.length, previousDraws);

  failPrice = true;
  await handler();
  rejectLogo(new Error('offline'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element('payment-logo-status').textContent, 'Token logo unavailable.');
  assert.equal(element('payment-price').textContent, 'Cauldron price unavailable.');
  assert.equal(element('download-payment-qr').disabled, false);
});

test('wizard follows the panels in reading order and resets when closed', () => {
  const highlighted = new Set();
  const nodes = new Map();
  let guidePosition = 'hero';
  let walking = false;
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: id === 'wizard-dialog', listeners: {},
      style: { removeProperty(name) { delete this[name]; } },
      classList: {
        add(name) { if (name === 'tutorial-highlight') highlighted.add(id); if (name === 'walking') walking = true; },
        remove(name) { if (name === 'tutorial-highlight') highlighted.delete(id); if (name === 'walking') walking = false; },
      },
      setAttribute() {},
      addEventListener(type, handler) { this.listeners[type] = handler; },
      scrollIntoView() { guidePosition = id; },
      contains() { return false; },
      before() { guidePosition = id; },
      closest(selector) {
        assert.equal(selector, '.grid');
        return id === 'connection-section' || id === 'balance-section' ? element('grid') : null;
      },
    });
    return nodes.get(id);
  };
  const guide = element('guide');
  element('connection-section').parentElement = element('grid');
  element('balance-section').parentElement = element('grid');
  const document = {
    querySelector(selector) {
      return selector === '.wizard-guide' ? guide : { after() { guidePosition = 'hero'; } };
    },
    querySelectorAll() { return [...highlighted].map(element); },
  };
  const start = source.indexOf('const tutorialSteps =');
  const end = source.indexOf('\n\nfetchBchUsd();', start);
  runInNewContext(source.slice(start, end), { $, document });
  function $ (id) { return element(id); }
  element('wizard-toggle').listeners.click();
  assert.deepEqual([...highlighted], ['connection-section']);
  assert.equal(guidePosition, 'connection-section');
  assert.equal(walking, true);
  element('wizard-next').listeners.click();
  assert.deepEqual([...highlighted], ['balance-section']);
  assert.equal(guidePosition, 'balance-section');
  element('wizard-next').listeners.click();
  assert.deepEqual([...highlighted], ['transfer-section']);
  assert.equal(guidePosition, 'transfer-section');
  element('wizard-next').listeners.click();
  assert.deepEqual([...highlighted], ['earn-section']);
  assert.equal(guidePosition, 'earn-section');
  element('wizard-next').listeners.click();
  assert.equal(element('wizard-dialog').hidden, true);
  assert.equal(highlighted.size, 0);
  assert.equal(guidePosition, 'earn-section');
  assert.equal(walking, false);
});
