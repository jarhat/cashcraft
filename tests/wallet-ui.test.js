import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { inspectNft } from '../src/nft-inspection.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('theme preferences migrate and select the correct palette', () => {
  for (const [saved, expected] of [[null, 'aurora'], ['bch', 'aurora'], ['bch-sunrise', 'aurora'], ['green', 'aurora'], ['blue', 'frost'], ['dark', 'frost'], ['aurora', 'aurora'], ['frost', 'frost'], ['unknown', 'aurora']]) {
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
    assert.equal(node, elements.get('wizard-dialog'));
    node.parent = position;
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
      prepend(node) { assert.equal(node, elements.get('wizard-dialog')); node.parent = id; },
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
  for (const id of ['wizard-toggle', 'wizard-dialog', 'wizard-title', 'wizard-message', 'wizard-progress', 'wizard-prev', 'wizard-next', 'wizard-close', 'wallet-help']) {
    elements.set(id, {
      hidden: id === 'wizard-dialog',
      addEventListener(type, handler) { this[type] = handler; },
      setAttribute() {},
      contains() { return false; },
      scrollIntoView() {},
    });
  }
  const document = {
    querySelector(selector) { return selector === '.hero' ? hero : guide; },
    querySelectorAll() { return [...highlighted]; },
  };
  const start = source.indexOf('const tutorialSteps =');
  const end = source.indexOf('\n\nfetchBchUsd();', start);
  elements.set('connection-dialog', { open: false, close() { this.open = false; } });
  runInNewContext(source.slice(start, end), { document, $: (id) => elements.get(id), requestAnimationFrame: (fn) => fn(), openConnectionDialog() { elements.get('connection-dialog').open = true; } });

  elements.get('wizard-toggle').click();
  assert.equal(guidePosition, 'connection-section');
  assert.equal(elements.get('connection-dialog').open, true);
  assert.equal(elements.get('wizard-dialog').parent, 'connection-section');
  assert.equal(elements.get('wizard-progress').textContent, '1 / 4');
  elements.get('wizard-next').click();
  assert.equal(guidePosition, 'balance-section');
  assert.equal(elements.get('connection-dialog').open, false);
  assert.equal(elements.get('wizard-dialog').parent, 'balance-section');
  elements.get('wizard-next').click();
  assert.equal(guidePosition, 'transfer-section');
  elements.get('wizard-next').click();
  assert.equal(guidePosition, 'earn-section');
  elements.get('wizard-prev').click();
  assert.equal(guidePosition, 'transfer-section');
  elements.get('wizard-toggle').click();
  assert.equal(guidePosition, 'transfer-section');
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
    $: element, setTransferTab() {}, document: { addEventListener() {} },
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
    'pairing-help': { hidden: false },
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
    openTutorial() {}, openConnectionDialog() {},
  };
  runInNewContext(`${source.slice(connectionStart, connectionEnd)}\n${source.slice(sendStart, sendEnd)}`, context);
  const restoring = context.startConnection({ restoring: true });
  connect();
  release();
  await restoring;
  assert.deepEqual(calls, ['wc:restored']);
  assert.equal(context.pairingInProgress, false);
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

test('prefetches each token logo during the scan without waiting for other addresses', async () => {
  const category = 'a'.repeat(64);
  let finishSecondAddress;
  const logoRequests = [];
  const records = [{ index: 0 }, { index: 1 }];
  const start = source.indexOf('async function scanWallet()');
  const end = source.indexOf('\nfunction renderBalances', start);
  const context = {
    scanAddressRecords: records, SCAN_CONCURRENCY: 2, mainnet: true,
    fetchAddressUtxosWithRetry: (record) => record.index === 0
      ? Promise.resolve([{ token: { category, amount: 1n } }])
      : new Promise((resolve) => { finishSecondAddress = resolve; }),
    loadTokenLogo: (id) => { logoRequests.push(id); return new Promise(() => {}); },
    utxoKey: () => null, normalizeUtxo: (utxo) => utxo,
  };
  runInNewContext(source.slice(start, end), context);
  const scan = context.scanWallet();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logoRequests, [category]);
  finishSecondAddress([{ token: { category, amount: 2n } }]);
  const result = await scan;
  assert.equal(result.utxos.length, 2);
  assert.equal(result.prefetchedLogos.size, 1);
  assert.deepEqual(logoRequests, [category]);
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
    logger: { info() {}, warn() {}, error() {} },
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

test('stale wallet callbacks cannot disconnect a newer session', async () => {
  const managers = [];
  const relays = [];
  let submissions = 0;
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', hidden: false, disabled: false,
      classList: { add() {}, remove() {} }, removeAttribute() {},
    });
    return nodes.get(id);
  };
  class Manager {
    constructor() { this.handlers = {}; managers.push(this); }
    on(name, callback) { this.handlers[name] = callback; }
    attachRelay() {}
    updateConnection() {}
    clearStoredSession() {}
    async destroy() {}
  }
  const start = source.indexOf('async function startConnection(');
  const end = source.indexOf('\nasync function fetchBchUsd', start);
  const context = {
    $: element, relay: null, manager: null, walletReady: false,
    pairingInProgress: false, showPairingWhenReady: false,
    clearWalletDisplay() {}, setConnection() {}, updateReceiveAddress() {},
    addressFor: () => 'recipient', submitCashAddress: async () => { submissions++; },
    refreshBalances: async () => {}, loadWalletDependencies: async () => {},
    loadSession: () => null, DappConnectionManager: Manager,
    initiateDappRelay: (callback) => {
      const instance = { uri: 'wiz:test', client: {}, cleanupCount: 0,
        cleanup() { this.cleanupCount++; }, events: { on() {} }, callback };
      relays.push(instance);
      return instance;
    },
    showPairingUri: async () => {}, report(error) { throw error; },
    console: { info() {} },
  };
  runInNewContext(source.slice(start, end), context);
  await context.startConnection();
  await context.startConnection({ fresh: true });
  managers[0].handlers.disconnect('old connection');
  await managers[0].handlers.walletready({});
  relays[0].callback({ client: {}, status: { status: 'connected' } });
  assert.equal(relays[1].cleanupCount, 0);
  assert.equal(submissions, 0);
  await managers[1].handlers.walletready({ wallet_name: 'Selene' });
  assert.equal(submissions, 1);
  assert.equal(context.walletReady, true);
});

test('missing wallet public key reports failure instead of appearing connected', async () => {
  let managerInstance;
  let reported;
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', hidden: false, disabled: false,
      classList: { add() {}, remove() {} }, removeAttribute() {},
    });
    return nodes.get(id);
  };
  const start = source.indexOf('async function startConnection(');
  const end = source.indexOf('\nasync function fetchBchUsd', start);
  const context = {
    $: element, relay: null, manager: null, walletReady: false,
    pairingInProgress: false, showPairingWhenReady: false,
    clearWalletDisplay() {}, setConnection() {},
    addressFor() { throw new Error('Wallet public key is not available'); },
    loadWalletDependencies: async () => {}, loadSession: () => null,
    DappConnectionManager: class {
      constructor() { managerInstance = this; this.handlers = {}; }
      on(name, callback) { this.handlers[name] = callback; }
      attachRelay() {} updateConnection() {}
    },
    initiateDappRelay: () => ({ uri: 'wiz:test', client: {}, cleanup() {}, events: { on() {} } }),
    showPairingUri: async () => {}, report(error) { reported = error; },
  };
  runInNewContext(source.slice(start, end), context);
  await context.startConnection();
  await managerInstance.handlers.walletready({});
  assert.match(reported.message, /public key/);
  assert.equal(context.walletReady, false);
  assert.match(element('status').textContent, /could not derive address/);
});

test('forgetting a pairing notifies the wallet before tearing down the relay', async () => {
  const calls = [];
  let handler;
  const nodes = {
    forget: { addEventListener(_type, fn) { handler = fn; } },
    pairing: { classList: { add() {} } },
    'open-wallet': { disabled: false, hidden: false },
    'pairing-help': { hidden: false },
    status: { textContent: '' },
  };
  const start = source.indexOf("$('forget').addEventListener('click'");
  const end = source.indexOf("\n$('refresh').addEventListener", start);
  const context = {
    $: (id) => nodes[id], window: { confirm: () => true }, translate: (text) => text,
    walletReady: true,
    manager: {
      async sendDisconnect() { calls.push('notify'); },
      clearStoredSession() { calls.push('clear'); },
      async destroy() { calls.push('destroy'); },
    },
    relay: { cleanup() { calls.push('cleanup'); } },
    wait: () => new Promise(() => {}), clearWalletDisplay() {},
    async startConnection(options) { calls.push(options.fresh ? 'fresh' : 'restore'); },
    report(error) { throw error; },
  };
  runInNewContext(source.slice(start, end), context);
  await handler();
  assert.deepEqual(calls, ['notify', 'clear', 'destroy', 'cleanup', 'fresh']);
});

test('open in wallet remains available until an address is derived, including restored sessions', async () => {
  let instance;
  let relayCallback;
  let keyAvailable = false;
  let submissionFails = false;
  let scanFails = false;
  let scanPending = false;
  let resolveScan;
  let reported;
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', hidden: false, disabled: false,
      classList: { add() {}, remove() {} },
    });
    return elements.get(id);
  };
  const start = source.indexOf('async function showPairingUri(');
  const end = source.indexOf('\nasync function fetchBchUsd', start);
  const context = {
    $: element, relay: null, manager: null, walletPairingUri: null,
    walletReady: false, pairingInProgress: false, showPairingWhenReady: false,
    QRCode: { toCanvas: async () => {} }, clearWalletDisplay() {}, setConnection() {},
    updateReceiveAddress() {},
    addressFor() {
      if (!keyAvailable) throw new Error('Public key missing');
      return 'token-address';
    },
    submitCashAddress: async () => { if (submissionFails) throw new Error('registration unavailable'); },
    refreshBalances: async () => {
      if (scanFails) throw new Error('scan unavailable');
      if (scanPending) await new Promise((resolve) => { resolveScan = resolve; });
    },
    loadWalletDependencies: async () => {},
    loadSession: () => ({ walletPublicKey: 'saved', paths: ['receive'] }),
    DappConnectionManager: class {
      constructor() { instance = this; this.handlers = {}; }
      on(event, handler) { this.handlers[event] = handler; }
      attachRelay() {} updateConnection() {}
    },
    initiateDappRelay: (callback) => {
      relayCallback = callback;
      return { uri: 'wiz:restored', client: {}, cleanup() {}, events: { on() {} } };
    },
    report(error) { reported = error; }, logger: { info() {}, warn() {}, error() {} },
  };
  runInNewContext(source.slice(start, end), context);
  await context.startConnection({ restoring: true });
  assert.equal(element('connect').hidden, true);
  assert.equal(element('open-wallet').hidden, false);
  assert.equal(element('open-wallet').disabled, false);
  assert.equal(context.walletPairingUri, 'wiz:restored');
  await instance.handlers.walletready({});
  assert.equal(element('open-wallet').hidden, false);
  assert.equal(element('open-wallet').disabled, false);
  keyAvailable = true;
  await instance.handlers.walletready({});
  assert.equal(element('open-wallet').hidden, true);
  submissionFails = true;
  scanPending = true;
  const pendingReady = instance.handlers.walletready({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(reported.message, /registration unavailable/);
  assert.match(element('status').textContent, /address submission failed/);
  resolveScan();
  await pendingReady;
  scanPending = false;
  scanFails = true;
  await instance.handlers.walletready({});
  assert.match(reported.message, /registration unavailable/);
  assert.match(reported.message, /scan unavailable/);
  assert.match(element('status').textContent, /address submission and balance scan failed/);
  relayCallback({ client: {}, status: { status: 'reconnecting' } });
  assert.equal(element('open-wallet').hidden, false);
  relayCallback({ client: {}, status: { status: 'connected' } });
  assert.equal(element('open-wallet').hidden, false);
  instance.handlers.messagereceived({ action: 'pong' });
  assert.equal(element('open-wallet').hidden, true);
  instance.handlers.disconnect('closed');
  assert.equal(element('open-wallet').hidden, false);
  assert.equal(element('open-wallet').disabled, true);
  assert.equal(element('connect').hidden, false);
});

test('saved wallet sessions start restoring immediately on page load', async () => {
  const saved = { walletPublicKey: 'key', paths: ['receive'] };
  const events = [];
  const start = source.indexOf('const restoreSession =');
  const end = source.indexOf("\nif ('serviceWorker'", start);
  const context = {
    loadWalletDependencies: async () => events.push('dependencies'),
    loadSession: () => saved,
    pairingInProgress: false, walletReady: false,
    startConnection: async (options) => events.push(options.restoring ? 'restore' : 'new'),
    logger: { warn() {} },
  };
  runInNewContext(source.slice(start, end), context);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['dependencies', 'restore']);
});

test('open in wallet works when a connected session needs relay reconnection', () => {
  let handler;
  const start = source.indexOf("$('open-wallet').addEventListener('click'");
  const end = source.indexOf("\n$('forget').addEventListener", start);
  const context = {
    $: () => ({ addEventListener(_name, fn) { handler = fn; } }),
    walletPairingUri: 'wiz:reconnect', walletReady: true,
    window: { location: { href: '' } },
  };
  runInNewContext(source.slice(start, end), context);
  handler();
  assert.equal(context.window.location.href, 'wiz:reconnect');
});

test('token send signs and broadcasts without submitting a payment proof', async () => {
  const category = 'a'.repeat(64);
  const events = [];
  const elements = new Map([
    ['category', { value: category }], ['recipient', { value: 'recipient' }],
    ['amount', { value: '3' }], ['status', { textContent: '' }],
    ['log', { textContent: '', classList: { remove() {} } }],
  ]);
  const input = {
    txid: 'b'.repeat(64), vout: 0, token: { category, amount: 5n },
    satoshis: 20_000n, pathName: 'receive', addressIndex: 0, spendAddress: 'source',
  };
  class Builder {
    addInput(utxo) { assert.equal(utxo, input); return this; }
    addOutput(output) { events.push(['output', output.token.amount]); return this; }
    addTokenChangeOutputIfNeeded() { return this; }
    addBchChangeOutputIfNeeded() { return this; }
    generateWcTransactionObject() {
      return { transaction: { inputs: [{}], outputs: [], version: 2, locktime: 0 }, sourceOutputs: [{}] };
    }
  }
  const start = source.indexOf('async function sendFungibleTokens()');
  const end = source.indexOf("\n$('connect').addEventListener", start);
  const context = {
    $: (id) => elements.get(id), sending: false, walletReady: true, mainnet: false,
    setConnection() {}, validateRecipient: (value) => value, translate: (text) => text,
    refreshBalances: async () => ({ utxos: [input], addresses: [{}] }),
    TOKEN_OUTPUT_SATOSHIS: 1000n, FEE_RESERVE_SATOSHIS: 10000n,
    MAXIMUM_FEE_SATOSHIS: 10000n, TransactionBuilder: Builder,
    placeholderP2PKHUnlocker: () => ({}), addressFor: () => 'change',
    transactionToHex: () => 'unsigned', sourceOutputToRelay: (output) => output,
    manager: { async signTransaction() { events.push('sign'); return { signedTransaction: 'signed' }; } },
    provider: { async sendRawTransaction(hex) { events.push(['broadcast', hex]); return 'txid'; } },
    rememberSentTransaction: (txid) => events.push(['remember', txid]),
    refreshAfterApproval: async () => events.push('refresh'),
    fetch() { throw new Error('Proof endpoint must not be called'); },
    report(error) { throw error; }, console: { info() {}, error() {} },
  };
  runInNewContext(source.slice(start, end), context);
  await context.sendFungibleTokens();
  assert.deepEqual(events, [['output', 3n], 'sign', ['broadcast', 'signed'], ['remember', 'txid'], 'refresh']);
  assert.equal(elements.get('log').textContent, 'Transaction ID: txid');

  context.rememberSentTransaction = () => { throw new Error('Storage unavailable'); };
  await context.sendFungibleTokens();
  assert.match(elements.get('log').textContent, /Transaction ID: txid/);
  assert.match(elements.get('log').textContent, /broadcast.*Storage unavailable/);

  let reported;
  context.report = (error, options) => { reported = { error, options }; };
  context.manager.signTransaction = async () => { throw new Error('Wallet declined signing'); };
  await context.sendFungibleTokens();
  assert.equal(reported.error.message, 'Wallet declined signing');
  assert.equal(reported.options.log, false);
});

test('portfolio abbreviates category IDs but copies the full ID', async () => {
  class Element {
    constructor() {
      this.children = [];
      this.classList = { add() {}, remove() {}, contains: (name) => (this.className || '').split(' ').includes(name) };
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
    tokenBalances: new Map(), portfolioPage: 0, updateAmountHelp() {},
    loadTokenLogo: () => new Promise(() => {}),
    fetchTokenMetadata: () => new Promise(() => {}), fetchCauldronSpot: () => new Promise(() => {}),
    formatBch: () => '0.00001000', Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    document: { createElement: () => new Element() },
    inspectNft,
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

test('portfolio paginates fungible tokens and optionally includes each NFT', async () => {
  class Element {
    constructor() {
      this.children = []; this.options = []; this.value = ''; this.style = {};
      this.classList = { add() {}, remove() {}, contains: (name) => (this.className || '').split(' ').includes(name) };
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; this.options = children; }
    add(option) { this.options.push(option); }
    setAttribute() {}
    addEventListener(type, handler) { this[type] = handler; }
  }
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  const start = source.indexOf('function renderBalances(');
  const end = source.indexOf('\nasync function refreshBalances', start);
  let copied;
  const context = {
    $, walletReady: true, bchUsd: null, portfolioVersion: 0, portfolioPage: 0,
    mainnet: false, network: 'chipnet', SATOSHIS_PER_BCH: 100_000_000n,
    tokenBalances: new Map(), updateAmountHelp() {}, formatBch: () => '0',
    Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    document: { createElement: () => new Element() },
    inspectNft,
    navigator: { clipboard: { writeText: async (value) => { copied = value; } } },
    translate: (text) => text, setTimeout() {}, report(error) { throw error; },
    fetchCauldronSpot: () => new Promise(() => {}), logger: { warn() {} },
  };
  runInNewContext(source.slice(start, end), context);
  const fungibles = Array.from({ length: 8 }, (_, i) => ({
    satoshis: 1000n, token: { category: i.toString(16).repeat(64), amount: 1n },
  }));
  const nft = { txid: 'f'.repeat(64), vout: 2, satoshis: 1000n,
    token: { category: 'e'.repeat(64), amount: 0n, nft: { capability: 'mutable', commitment: 'abcd' } } };
  context.renderBalances([...fungibles, nft]);
  const rows = $('tokens').children;
  assert.equal(rows.filter((row) => !row.hidden).length, 6);
  assert.equal($('portfolio-page').textContent, '1 / 2');
  context.portfolioPage = 1;
  context.paginatePortfolio();
  assert.equal(rows.filter((row) => !row.hidden).length, 2);
  assert.equal(rows[8].hidden, true);
  $('show-nfts').checked = true;
  context.paginatePortfolio();
  assert.equal(rows.filter((row) => !row.hidden).length, 3);
  assert.match(rows[8].children[2].textContent, /mutable.*abcd/);
  await rows[8].children[1].children[1].click();
  assert.equal(copied, nft.token.category);
  $('show-nfts').checked = false;
  context.renderBalances([nft]);
  assert.equal($('portfolio-empty-filter').hidden, false);
  $('show-nfts').checked = true;
  context.paginatePortfolio();
  assert.equal($('portfolio-empty-filter').hidden, true);
  assert.equal($('tokens').children[0].hidden, false);
  context.renderBalances([{ ...nft, token: { ...nft.token, amount: 3n } }]);
  const amountValues = $('tokens').children[0].children[0].children[2].children[0];
  assert.match(amountValues.children[0].textContent, /3 base units/);
  assert.match(amountValues.children[2].textContent, /3 base units attached to NFTs; unavailable for sending/);
  assert.equal($('token-options').hidden, true);
  context.renderBalances([
    { ...nft, token: { ...nft.token, amount: 3n } },
    { satoshis: 1000n, token: { category: nft.token.category, amount: 5n } },
  ]);
  assert.equal(context.tokenBalances.get(nft.token.category).amount, 5n);
  const total = $('tokens').children[0].children[0].children[2].children[0];
  assert.match(total.children[0].textContent, /8 base units/);
  assert.match(total.children[2].textContent, /3 base units attached/);
  assert.match($('token-options-list').children[0].children[1].textContent, /5 base units/);
});

test('connected panels reveal only after a wallet connection and hide on disconnect', () => {
  const panels = Array.from({ length: 4 }, () => ({ hidden: true }));
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: id === 'wizard-dialog',
      classList: { toggle() {} },
      getAttribute: () => 'true',
    });
    return nodes.get(id);
  };
  const start = source.indexOf('function setConnection(');
  const end = source.indexOf('\nfunction clearWalletDisplay', start);
  const context = {
    $, document: { querySelectorAll: () => panels, body: { classList: { toggle() {} } } }, sending: false,
    pairingInProgress: false, transferInteracted: false, tutorialStep: 2,
    translate: (text) => text,
    showTutorialStep() { context.tutorialUpdated = true; },
  };
  runInNewContext(source.slice(start, end), context);
  context.setConnection(true);
  assert.ok(panels.every((panel) => !panel.hidden));
  assert.equal($('network-wallet-status').textContent, 'Wallet connected');
  assert.equal($('wizard-guide').hidden, false);
  assert.equal($('advanced-settings').hidden, false);
  $('wizard-dialog').hidden = false;
  $('wizard-next').disabled = true;
  context.setConnection(true);
  assert.equal($('wizard-dialog').hidden, false);
  assert.equal($('wizard-next').disabled, false);
  assert.equal(context.tutorialUpdated, undefined);
  context.setConnection(false);
  assert.ok(panels.every((panel) => panel.hidden));
  assert.equal($('network-wallet-status').textContent, 'Not connected');
  assert.equal($('wizard-guide').hidden, false);
  assert.equal($('advanced-settings').hidden, true);
  assert.equal(context.tutorialStep, 0);
  assert.equal(context.tutorialUpdated, true);
});

test('NFT inspection validates capabilities and commitment bytes', () => {
  assert.deepEqual(inspectNft({ capability: 'mutable', commitment: 'Ab01' }), {
    capability: 'mutable', commitment: 'ab01', commitmentBytes: 2,
  });
  assert.equal(inspectNft({ capability: 'none', commitment: '' }).commitmentBytes, 0);
  assert.equal(inspectNft({ capability: 'minting', commitment: 'ff'.repeat(40) }).commitmentBytes, 40);
  assert.equal(inspectNft({ capability: 'other', commitment: 'abc' }).capability, null);
  assert.equal(inspectNft({ capability: 'none', commitment: 'abc' }).commitmentBytes, null);
  assert.equal(inspectNft({ capability: 'none', commitment: 'ff'.repeat(41) }).commitmentBytes, null);
  assert.equal(inspectNft({}).commitmentBytes, null);
});

test('priced metadata updates balances, token choices and allocation', async () => {
  class Element {
    constructor() { this.children = []; this.options = []; this.style = {}; this.value = ''; this.classList = { add() {}, remove() {}, contains: (name) => (this.className || '').split(' ').includes(name) }; }
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
  const helpers = source.slice(source.indexOf('function formatTokenAmount('), source.indexOf('\nasync function fetchAddressUtxosWithRetry'));
  const render = source.slice(source.indexOf('function renderBalances('), source.indexOf('\nasync function refreshBalances'));
  const context = {
    $: element, walletReady: true, bchUsd: 200, balanceSatoshis: 100_000_000n,
    portfolioVersion: 0, tokenBalances: new Map(), portfolioPage: 0, mainnet: true, network: 'mainnet',
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
  assert.match(element('tokens').children[0].children[0].children[2].children[0].children[0].textContent, /1\.25 EX/);
  const supply = element('tokens').children[0].children[0].children[2].children[1];
  assert.match(supply.children[1].textContent, /not verified/);
  assert.equal(supply.children[2].href, `https://tokenexplorer.cash/?tokenId=${category}`);
  assert.match(element('token-options-list').children[0].children[1].textContent, /Example.*\$2\.000/);
  assert.match(element('amount-help').textContent, /2 decimals.*Entered: 1\.25 EX/);
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
    translate: (text) => text, logger: { warn() {} }, report(error) { throw error; },
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
      scrollIntoView() {},
      prepend(node) { node.parent = id; },
      contains() { return false; },
      before(node) { node.parent = id; guidePosition = id; },
      close() { this.open = false; },
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
  runInNewContext(source.slice(start, end), { $, document, requestAnimationFrame: (fn) => fn(), openConnectionDialog() { element('connection-dialog').open = true; } });
  function $ (id) { return element(id); }
  element('wizard-toggle').listeners.click();
  assert.deepEqual([...highlighted], ['connection-section']);
  assert.equal(guidePosition, 'connection-section');
  assert.equal(element('wizard-dialog').parent, 'connection-section');
  assert.equal(walking, true);
  element('wizard-next').listeners.click();
  assert.deepEqual([...highlighted], ['balance-section']);
  assert.equal(guidePosition, 'balance-section');
  assert.equal(element('wizard-dialog').parent, 'balance-section');
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
