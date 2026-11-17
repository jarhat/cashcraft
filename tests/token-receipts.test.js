import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

function receiptHarness(stored = new Map(), wallet = 'wallet') {
  const elements = new Map([
    ['token-receipt-notifications', {
      notices: [], items: [], prepend(item) { this.notices.unshift(item.textContent); this.items.unshift(item); },
      replaceChildren() { this.notices = []; },
    }],
    ['notifications-empty', { hidden: false }],
    ['notification-indicator', { hidden: true }],
    ['gamba-sound-controls', { hidden: true }],
    ['gamba-art', { cloneNode: () => ({ removeAttribute() {} }) }],
  ]);
  let celebrations = 0;
  const category = 'b'.repeat(64);
  const localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  const script = source.slice(source.indexOf('let rewardCategory ='), source.indexOf('\nfunction report('));
  const context = {
    network: 'mainnet', API_BASE_URL: '', localStorage,
    addressFor: () => wallet, translate: (text) => text,
    $: (id) => elements.get(id), document: { createElement: () => ({
      children: [], append(...children) { this.children.push(...children); },
      get textContent() { return this.text || this.children.map((child) => child.textContent || '').join(''); },
      set textContent(value) { this.text = value; },
    }) },
    showGambaCelebration() { celebrations++; },
    fetch: async () => ({ ok: true, json: async () => ({ category }) }),
  };
  const api = runInNewContext(`${script}\n({ loadRewardCategory, notifyTokenReceipts, rememberSentTransaction })`, context);
  return { api, category, elements, stored, get celebrations() { return celebrations; } };
}

test('celebrates one GAMBA once per wallet, not other tokens or self-sent change', async () => {
  const h = receiptHarness();
  await h.api.loadRewardCategory();
  h.api.rememberSentTransaction('self');
  const other = { txid: 'other', token: { category: 'a'.repeat(64), amount: 1n } };
  const nft = { txid: 'nft', token: { category: h.category, amount: 1n, nft: {} } };
  const change = { txid: 'self', token: { category: h.category, amount: 1n } };
  const multiple = { txid: 'multiple', token: { category: h.category, amount: 2n } };
  h.api.notifyTokenReceipts([other, nft, change, multiple]);
  assert.equal(h.celebrations, 0);
  assert.deepEqual(h.elements.get('token-receipt-notifications').notices, []);

  const reward = { txid: 'reward', token: { category: h.category, amount: 1n } };
  h.api.notifyTokenReceipts([other, reward]);
  h.api.notifyTokenReceipts([reward, { ...reward, txid: 'another' }]);
  assert.equal(h.celebrations, 1);
  assert.deepEqual(h.elements.get('token-receipt-notifications').notices, ['1 GAMBA TOKEN']);
  const notice = h.elements.get('token-receipt-notifications').items[0];
  assert.equal(notice.className, 'notification-message gamba-notice');
  assert.equal(notice.children.length, 2);
  assert.equal(h.elements.get('notification-indicator').hidden, false);
  assert.equal(h.elements.get('gamba-sound-controls').hidden, false);
  assert.equal(notice.children[1].children.length, 1);

  const reload = receiptHarness(h.stored);
  await reload.api.loadRewardCategory();
  reload.api.notifyTokenReceipts([reward]);
  assert.equal(reload.celebrations, 0);
  assert.deepEqual(reload.elements.get('token-receipt-notifications').notices, ['1 GAMBA TOKEN']);

  const anotherWallet = receiptHarness(h.stored, 'another-wallet');
  await anotherWallet.api.loadRewardCategory();
  anotherWallet.api.notifyTokenReceipts([reward]);
  assert.equal(anotherWallet.celebrations, 1);
});

test('migrates existing notices without replaying GAMBA or showing other tokens', async () => {
  const stored = new Map([['ctf-token-receipts:mainnet:wallet', JSON.stringify({
    seen: [], sent: [], unread: true,
    messages: [
      'CashToken received: other.',
      'Welcome! Your GAMBA token has arrived: enjoy your special diamond perk.',
    ],
  })]]);
  const h = receiptHarness(stored);
  await h.api.loadRewardCategory();
  h.api.notifyTokenReceipts([{ txid: 'reward', token: { category: h.category, amount: 1n } }]);
  assert.equal(h.celebrations, 0);
  assert.deepEqual(h.elements.get('token-receipt-notifications').notices, ['1 GAMBA TOKEN']);
  assert.deepEqual(JSON.parse(stored.values().next().value).messages, ['Received 1 GAMBA']);
});

test('does not show an unrecorded celebration if browser storage fails', async () => {
  const stored = new Map();
  const h = receiptHarness(stored);
  await h.api.loadRewardCategory();
  stored.set = () => { throw new Error('Storage unavailable'); };
  assert.throws(
    () => h.api.notifyTokenReceipts([{ txid: 'reward', token: { category: h.category, amount: 1n } }]),
    /Storage unavailable/,
  );
  assert.equal(h.celebrations, 0);
});

test('refresh renders the new balance before announcing the reward', async () => {
  const calls = [];
  const elements = new Map([
    ['status', { textContent: '' }],
    ['log', { textContent: '' }],
  ]);
  const manager = {};
  const scanned = { addresses: [], utxos: [{ satoshis: 1000n }] };
  const start = source.indexOf('async function refreshBalances(');
  const end = source.indexOf('\nfunction validateRecipient', start);
  const context = {
    walletReady: true, manager, refreshPromise: null, scanAddressRecords: [],
    addresses: [], utxos: [], balanceSatoshis: null, emptyBalanceNotified: false,
    deriveScanAddresses: () => [], scanWallet: async () => scanned,
    renderBalances: () => calls.push('balance'),
    loadRewardCategory: async () => {},
    notifyTokenReceipts: () => calls.push('notification'),
    $: (id) => elements.get(id),
  };
  runInNewContext(source.slice(start, end), context);
  await context.refreshBalances({ quiet: true });
  assert.deepEqual(calls, ['balance', 'notification']);
  assert.equal(context.balanceSatoshis, 1000n);
});

test('celebration opens notifications and offers sound when autoplay is blocked', async () => {
  const calls = [];
  let canPlay = false;
  class AudioContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    async resume() { if (canPlay) { this.state = 'running'; calls.push('resumed'); } }
    async close() { this.state = 'closed'; calls.push('closed'); }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
    createOscillator() {
      return { frequency: {}, connect() {}, start() { calls.push('tone'); }, stop() {} };
    }
  }
  const elements = new Map([
    ['notifications-dialog', { open: false, showModal() { this.open = true; }, close() { this.open = false; } }],
    ['gamba-sound-status', { textContent: '' }],
    ['gamba-sound', { addEventListener(_type, fn) { this.click = fn; } }],
  ]);
  const start = source.indexOf('let notificationAudio;');
  const end = source.indexOf("\n$('view-payment-request')", start);
  const context = {
    window: { AudioContext }, $: (id) => elements.get(id),
    translate: (text) => text, logger: { warn() {} },
    document: { addEventListener() {} }, setTimeout, clearTimeout,
    notificationsDialog: elements.get('notifications-dialog'),
  };
  runInNewContext(source.slice(start, end), context);
  context.showGambaCelebration();
  assert.equal(elements.get('notifications-dialog').open, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(elements.get('gamba-sound-status').textContent, /Tap Play sound/);
  canPlay = true;
  elements.get('gamba-sound').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call === 'tone').length, 3);
  assert.equal(elements.get('gamba-sound-status').textContent, '');
});

test('a prior user gesture unlocks sound before a later GAMBA receipt', async () => {
  const calls = [];
  class AudioContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; calls.push('created'); }
    async resume() { this.state = 'running'; calls.push('resumed'); }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() { return { frequency: {}, connect() {}, start() { calls.push('tone'); }, stop() {} }; }
  }
  const listeners = {};
  const elements = new Map([
    ['notifications-dialog', { open: false, showModal() { this.open = true; }, close() {} }],
    ['gamba-sound-status', { textContent: '' }],
    ['gamba-sound', { addEventListener() {} }],
  ]);
  const start = source.indexOf('let notificationAudio;');
  const end = source.indexOf("\n$('view-payment-request')", start);
  const context = {
    window: { AudioContext }, $: (id) => elements.get(id),
    document: {
      addEventListener(type, handler) { listeners[type] = handler; },
      removeEventListener(type) { delete listeners[type]; },
    },
    translate: (text) => text, logger: { warn() {} },
    notificationsDialog: elements.get('notifications-dialog'), setTimeout, clearTimeout,
  };
  runInNewContext(source.slice(start, end), context);
  listeners.pointerdown();
  await new Promise((resolve) => setImmediate(resolve));
  context.showGambaCelebration();
  assert.equal(calls.filter((call) => call === 'created').length, 1);
  assert.equal(calls.filter((call) => call === 'tone').length, 3);
  assert.equal(elements.get('gamba-sound-status').textContent, '');
});

test('a later gesture retries audio unlock after an earlier failure', async () => {
  let attempts = 0;
  const calls = [];
  class AudioContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    async resume() {
      if (++attempts === 1) throw new Error('Blocked');
      this.state = 'running';
    }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() { return { frequency: {}, connect() {}, start() { calls.push('tone'); }, stop() {} }; }
  }
  const listeners = {};
  const elements = new Map([
    ['notifications-dialog', { open: false, showModal() { this.open = true; } }],
    ['gamba-sound-status', { textContent: '' }],
    ['gamba-sound', { addEventListener() {} }],
  ]);
  const start = source.indexOf('let notificationAudio;');
  const end = source.indexOf("\n$('view-payment-request')", start);
  const context = {
    window: { AudioContext }, $: (id) => elements.get(id),
    document: {
      addEventListener(type, handler) { listeners[type] = handler; },
      removeEventListener(type) { delete listeners[type]; },
    },
    notificationsDialog: elements.get('notifications-dialog'),
    translate: (text) => text, logger: { warn() {} }, setTimeout, clearTimeout,
  };
  runInNewContext(source.slice(start, end), context);
  listeners.pointerdown();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof listeners.keydown, 'function');
  listeners.keydown();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(listeners.pointerdown, undefined);
  context.showGambaCelebration();
  assert.equal(calls.length, 3);
});

test('a suspended audio context is resumed when a receipt arrives', async () => {
  const calls = [];
  class AudioContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; }
    async resume() { this.state = 'running'; calls.push('resume'); }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() { return { frequency: {}, connect() {}, start() { calls.push('tone'); }, stop() {} }; }
  }
  const elements = new Map([
    ['notifications-dialog', { open: false, showModal() { this.open = true; } }],
    ['gamba-sound-status', { textContent: '' }],
    ['gamba-sound', { addEventListener() {} }],
  ]);
  const start = source.indexOf('let notificationAudio;');
  const end = source.indexOf("\n$('view-payment-request')", start);
  const context = {
    window: { AudioContext }, $: (id) => elements.get(id),
    document: { addEventListener() {} },
    notificationsDialog: elements.get('notifications-dialog'),
    translate: (text) => text, logger: { warn() {} }, setTimeout, clearTimeout,
  };
  runInNewContext(source.slice(start, end), context);
  context.showGambaCelebration();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['resume', 'tone', 'tone', 'tone']);
  assert.equal(elements.get('gamba-sound-status').textContent, '');
});
