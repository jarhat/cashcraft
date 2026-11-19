import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { utxoKey } from '../src/utils.js';
import { groupMinaReceipts } from '../src/reward-receipts.js';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

function receiptHarness(stored = new Map(), wallet = 'wallet') {
  const elements = new Map([
    ['token-receipt-notifications', {
      notices: [], items: [], childElementCount: 0,
      prepend(item) { this.notices.unshift(item.textContent); this.items.unshift(item); this.childElementCount++; },
      replaceChildren() { this.notices = []; },
    }],
    ['notifications-empty', { hidden: false }],
    ['notification-indicator', { hidden: true }],
    ['gamba-sound-controls', { hidden: true }],
    ['mina-receipt-history', { hidden: true }],
    ['mina-receipt-count', { textContent: '' }],
    ['mina-receipt-transactions', { items: [], replaceChildren() { this.items = []; }, append(item) { this.items.push(item); } }],
    ['gamba-art', { cloneNode: () => ({ removeAttribute() {} }) }],
    ['mining-reward-queue-notice', {
      querySelector(selector) { return selector === 'strong' ? this.label : this.details; },
      remove() {},
      label: { textContent: '' }, details: { textContent: '' },
    }],
  ]);
  let celebrations = 0;
  let queuedSounds = 0;
  const category = 'b'.repeat(64);
  const localStorage = {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  };
  const script = source.slice(source.indexOf('let rewardCategory ='), source.indexOf('\nfunction report('));
  const context = {
    network: 'mainnet', API_BASE_URL: '', localStorage, utxoKey, groupMinaReceipts, walletReady: true,
    addressFor: () => wallet, translate: (text) => text,
    $: (id) => elements.get(id), document: { createElement: () => ({
      children: [], append(...children) { this.children.push(...children); },
      get textContent() { return this.text || this.children.map((child) => child.textContent || '').join(''); },
      set textContent(value) { this.text = value; },
    }) },
    showMinaCelebration(count) { celebrations += count; },
    playNotificationSound(kind) { if (kind === 'mining') queuedSounds++; },
    logger: { warn() {} },
    refreshBalances: () => new Promise(() => {}),
    fetch: async () => ({ ok: true, json: async () => ({ category }) }),
  };
  const api = runInNewContext(`${script}\n({ loadRewardCategory, notifyTokenReceipts, rememberSentTransaction, queueMinedRewardNotification, reportMinedRewardFailure })`, context);
  return { api, category, elements, stored, get celebrations() { return celebrations; }, get queuedSounds() { return queuedSounds; } };
}

test('tracks received MINA amounts and transaction IDs across scans', async () => {
  const h = receiptHarness();
  await h.api.loadRewardCategory();
  const a = { txid: 'a'.repeat(64), vout: 0, token: { category: h.category, amount: 2n } };
  const b = { txid: 'b'.repeat(64), vout: 1, token: { category: h.category, amount: 1n } };
  h.api.notifyTokenReceipts([a, b]);
  h.api.notifyTokenReceipts([a, b]);
  assert.equal(h.elements.get('mina-receipt-count').textContent, '3 MINA received in 2 transactions');
  assert.deepEqual(h.elements.get('mina-receipt-transactions').items.map((item) => item.textContent),
    [`1 MINA · ${b.txid}`, `2 MINA · ${a.txid}`]);
});

test('bundles multiple wallet outputs from the same transaction', async () => {
  const h = receiptHarness();
  await h.api.loadRewardCategory();
  const txid = 'a'.repeat(64);
  h.api.notifyTokenReceipts([
    { txid, vout: 0, token: { category: h.category, amount: 2n } },
    { txid, vout: 1, token: { category: h.category, amount: 3n } },
  ]);
  assert.equal(h.elements.get('mina-receipt-count').textContent, '5 MINA received in 1 transaction');
  assert.deepEqual(h.elements.get('mina-receipt-transactions').items.map((item) => item.textContent),
    [`5 MINA · ${txid}`]);
});

test('announces each distinct MINA output once, not other tokens or self-sent change', async () => {
  const h = receiptHarness();
  await h.api.loadRewardCategory();
  h.api.rememberSentTransaction('self');
  const other = { txid: 'other', token: { category: 'a'.repeat(64), amount: 1n } };
  const nft = { txid: 'nft', token: { category: h.category, amount: 0n, nft: {} } };
  const change = { txid: 'self', token: { category: h.category, amount: 1n } };
  h.api.notifyTokenReceipts([other, nft, change]);
  assert.equal(h.celebrations, 0);
  assert.deepEqual(h.elements.get('token-receipt-notifications').notices, []);

  const reward = { txid: 'reward', vout: 0, token: { category: h.category, amount: 1n } };
  h.api.notifyTokenReceipts([other, reward]);
  h.api.notifyTokenReceipts([reward, { ...reward, txid: 'another' }]);
  assert.equal(h.celebrations, 2);
  assert.deepEqual(h.elements.get('token-receipt-notifications').notices, []);
  assert.equal(h.elements.get('notification-indicator').hidden, false);

  const reload = receiptHarness(h.stored);
  await reload.api.loadRewardCategory();
  reload.api.notifyTokenReceipts([reward]);
  assert.equal(reload.celebrations, 0);
  assert.deepEqual(reload.elements.get('token-receipt-notifications').notices, []);

  const anotherWallet = receiptHarness(h.stored, 'another-wallet');
  await anotherWallet.api.loadRewardCategory();
  anotherWallet.api.notifyTokenReceipts([reward]);
  assert.equal(anotherWallet.celebrations, 1);
});

test('announces a MINA receipt with more than one token', async () => {
  const h = receiptHarness();
  await h.api.loadRewardCategory();
  h.api.notifyTokenReceipts([{ txid: 'a'.repeat(64), vout: 0, token: { category: h.category, amount: 2n } }]);
  assert.equal(h.celebrations, 1);
  assert.equal(h.elements.get('mina-receipt-count').textContent, '2 MINA received in 1 transaction');
  const reload = receiptHarness(h.stored);
  await reload.api.loadRewardCategory();
  reload.api.notifyTokenReceipts([]);
  assert.equal(reload.elements.get('mina-receipt-count').textContent, '2 MINA received in 1 transaction');
});

test('announces fungible MINA carried alongside an NFT', async () => {
  const h = receiptHarness();
  await h.api.loadRewardCategory();
  h.api.notifyTokenReceipts([{ txid: 'a'.repeat(64), vout: 0, token: { category: h.category, amount: 2n, nft: {} } }]);
  assert.equal(h.celebrations, 1);
  assert.equal(h.elements.get('mina-receipt-count').textContent, '2 MINA received in 1 transaction');
});

test('announces every new MINA output discovered in the same scan', async () => {
  const h = receiptHarness();
  await h.api.loadRewardCategory();
  const token = { category: h.category, amount: 1n };
  h.api.notifyTokenReceipts([{ txid: 'one', vout: 0, token }, { txid: 'two', vout: 0, token }]);
  assert.equal(h.celebrations, 2);
  h.api.notifyTokenReceipts([{ txid: 'one', vout: 0, token }, { txid: 'two', vout: 0, token }]);
  assert.equal(h.celebrations, 2);
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
  h.api.notifyTokenReceipts([{ txid: 'reward', vout: 0, token: { category: h.category, amount: 1n } }]);
  assert.equal(h.celebrations, 0);
  assert.deepEqual(h.elements.get('token-receipt-notifications').notices, []);
});

test('renames tracked GAMBA receipts without replaying them', async () => {
  const stored = new Map([['ctf-token-receipts:mainnet:wallet', JSON.stringify({
    seen: ['reward:0'], sent: [], unread: false, receiptTracking: true,
    gambaNotified: true, messages: ['Received 1 GAMBA'],
  })]]);
  const h = receiptHarness(stored);
  await h.api.loadRewardCategory();
  h.api.notifyTokenReceipts([{ txid: 'reward', vout: 0, token: { category: h.category, amount: 1n } }]);
  assert.equal(h.celebrations, 0);
  assert.deepEqual(h.elements.get('token-receipt-notifications').notices, []);
});

test('shows a pending mining payout immediately', () => {
  const h = receiptHarness();
  h.api.queueMinedRewardNotification('wallet');
  const state = JSON.parse(h.stored.get('ctf-token-receipts:mainnet:wallet'));
  assert.equal(state.pendingMiningRewards, 1);
  assert.equal(state.unread, true);
  assert.equal(h.elements.get('notification-indicator').hidden, false);
  assert.equal(h.elements.get('mining-reward-queue-notice').label.textContent, '1 MINA mining payout pending');
  assert.equal(h.queuedSounds, 1);
  h.api.queueMinedRewardNotification('another-wallet');
  assert.equal(h.queuedSounds, 1);
  h.api.queueMinedRewardNotification('wallet');
  assert.equal(h.queuedSounds, 2);
});

test('reports an unsuccessful payout while it remains pending for retry', () => {
  const h = receiptHarness();
  h.api.queueMinedRewardNotification('wallet');
  h.api.reportMinedRewardFailure('wallet');
  const state = JSON.parse(h.stored.get('ctf-token-receipts:mainnet:wallet'));
  assert.equal(state.pendingMiningRewards, 1);
  assert.equal(state.unread, true);
  assert.match(state.messages[0], /payout could not be confirmed/);
  assert.match(h.elements.get('token-receipt-notifications').notices[0], /payout could not be confirmed/);
});

test('schedules a separate notification sound for each simultaneous receipt', async () => {
  const starts = [];
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 10; this.destination = {}; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() {
      return { frequency: {}, connect() {}, start(time) { starts.push(time); }, stop() {} };
    }
  }
  const start = source.indexOf('let notificationAudio;');
  const end = source.indexOf("\n$('view-payment-request')", start);
  const context = {
    window: { AudioContext }, $: () => ({ textContent: '', open: false, addEventListener() {} }),
    document: { addEventListener() {} }, notificationsDialog: { open: true },
    translate: (text) => text, logger: { warn() {} }, setTimeout, clearTimeout,
  };
  runInNewContext(source.slice(start, end), context);
  context.showMinaCelebration(2);
  await new Promise(setImmediate);
  assert.equal(starts.length, 6);
  assert.ok(starts[3] > starts[2]);
});

test('mining and wallet receipt use different tones', async () => {
  const frequencies = [];
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() {
      const tone = { frequency: {}, connect() {}, stop() {}, start() { frequencies.push(tone.frequency.value); } };
      return tone;
    }
  }
  const start = source.indexOf('let notificationAudio;');
  const end = source.indexOf("\n$('view-payment-request')", start);
  const context = {
    window: { AudioContext }, $: () => ({ open: false }), document: { addEventListener() {} },
    notificationsDialog: { open: true }, logger: { warn() {} }, setTimeout, clearTimeout,
  };
  runInNewContext(source.slice(start, end), context);
  await context.playNotificationSound('mining');
  await context.playNotificationSound('receipt');
  assert.notDeepEqual(frequencies.slice(0, 3), frequencies.slice(3, 6));
});

test('does not show an unrecorded celebration if browser storage fails', async () => {
  const stored = new Map();
  const h = receiptHarness(stored);
  await h.api.loadRewardCategory();
  stored.set = () => { throw new Error('Storage unavailable'); };
  assert.throws(
    () => h.api.notifyTokenReceipts([{ txid: 'reward', vout: 0, token: { category: h.category, amount: 1n } }]),
    /Storage unavailable/,
  );
  assert.equal(h.celebrations, 0);
});

test('refresh renders the new balance before announcing the reward', async () => {
  const calls = [];
  const elements = new Map([
    ['status', { textContent: '' }],
    ['mina-balance', {}],
    ['notification-mina', {}],
    ['log', { textContent: '' }],
  ]);
  const manager = {};
  const scanned = { addresses: [], utxos: [{ satoshis: 1000n }] };
  const start = source.indexOf('async function refreshBalances(');
  const end = source.indexOf('\nfunction validateRecipient', start);
  const context = {
    walletReady: true, manager, rewardCategory: 'a'.repeat(64), refreshPromise: null, scanAddressRecords: [],
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

test('celebration opens notifications even when autoplay is blocked', async () => {
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
  context.showMinaCelebration();
  assert.equal(elements.get('notifications-dialog').open, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call === 'tone').length, 0);
  canPlay = true;
  context.showMinaCelebration();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((call) => call === 'tone').length, 3);
  assert.equal(elements.get('gamba-sound-status').textContent, '');
});

test('a prior user gesture unlocks sound before a later MINA receipt', async () => {
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
  context.showMinaCelebration();
  assert.equal(calls.filter((call) => call === 'created').length, 1);
  assert.equal(calls.filter((call) => call === 'tone').length, 3);
  assert.equal(elements.get('gamba-sound-status').textContent, '');
});

test('only the open game frame can request notification audio unlock', () => {
  const start = source.indexOf("window.addEventListener('message', (event) => {");
  const end = source.indexOf('\nlet notificationAudio;', start);
  let handler;
  let unlocks = 0;
  const frame = {};
  const game = { open: true };
  const context = {
    window: { addEventListener: (_type, callback) => { handler = callback; } },
    $: (id) => id === 'game-dialog' ? game : { contentWindow: frame, src: '/games/netcraft/craftw.html' },
    notificationAudio: null,
    unlockNotificationAudio: () => { unlocks++; },
  };
  runInNewContext(source.slice(start, end), context);
  handler({ source: {}, data: { type: 'netcraft-user-gesture' } });
  handler({ source: frame, data: { type: 'other' } });
  game.open = false;
  handler({ source: frame, data: { type: 'netcraft-user-gesture' } });
  game.open = true;
  handler({ source: frame, data: { type: 'netcraft-user-gesture' } });
  assert.equal(unlocks, 1);
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
  context.showMinaCelebration();
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
  context.showMinaCelebration();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['resume', 'tone', 'tone', 'tone']);
  assert.equal(elements.get('gamba-sound-status').textContent, '');
});
