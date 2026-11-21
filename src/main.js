import './style.css';
import { setLanguage, translate } from './i18n.js';
import { createPaymentQrImage } from './payment-qr-image.js';
import { setupScrollEffects } from './scroll-effects.js';
import { setupSnow } from './snow.js';
import { setupMesh } from './mesh.js';
import { setupPairingReminder } from './pairing-reminder.js';
import { fetchTokenMetadata, fetchCauldronSpot } from './portfolio-data.js';
import { loadTokenLogo } from './token-logo.js';
import { updateCategoryIcon } from './category-icon.js';
import { inspectNft } from './nft-inspection.js';
import { setupMarketTicker } from './market-ticker.js';
import { setupChainTicker } from './chain-ticker.js';
import { setupWikiGlossary } from './wiki-glossary.js';
import { setupGames } from './games.js';
import { setupGameInvite, loadDonation } from './game-invite.js';
import { groupMinaReceipts } from './reward-receipts.js';
import { setupBrowserWallet } from './browser-wallet-ui.js';
import { setupMediaSlideshow } from './media-slideshow.js';
import { createLogger } from './logger.js';
import { submitCashAddress, API_BASE_URL, createShortLink, openShortLink } from './api.js';
import {
  SATOSHIS_PER_BCH,
  formatBch,
  normalizeUtxo,
  utxoKey,
  wait,
} from './utils.js';

const network = (import.meta.env.VITE_BCH_NETWORK || import.meta.env.BCH_NETWORK || 'mainnet').toLowerCase();
const logger = createLogger(
  import.meta.env.VITE_CONSOLE_LOG_LEVEL || (import.meta.env.DEV ? 'debug' : 'error'),
);
setupScrollEffects();
setupSnow(document.getElementById('snow-canvas'));
setupMesh(document.querySelector('.mesh-terrain'));

for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
  document.querySelector(selector).content = new URL('/api/craft-preview.png?v=5', window.location.origin).href;
}

if (!['mainnet', 'chipnet'].includes(network)) {
  throw new Error(
    `Unsupported BCH network "${network}". Use "mainnet" or "chipnet".`,
  );
}

function fillFromUrl(params = new URLSearchParams(window.location.search), note = '') {
  const sharedLink = {
    address: params.get('addr'),
    category: params.get('category'),
    amount: params.get('amount'),
  };

  const fields = [
    ['addr', 'recipient'],
    ['category', 'category'],
    ['amount', 'amount'],
  ];

  for (const [paramName, inputId] of fields) {
    const input = document.getElementById(inputId);
    const value = params.get(paramName);

    if (value !== null && value.trim() !== '') {
      input.value = value;
      input.readOnly = true;
    } else {
      input.readOnly = false;
    }
  }

  $('category-selector').hidden = $('category').readOnly;

  if (
    Object.values(sharedLink).every(
      (value) => value !== null && value.trim() !== '',
    )
  ) {
    $('shared-link-amount').textContent = `${sharedLink.amount} token base units`;
    $('shared-link-address').textContent = sharedLink.address;
    $('shared-link-category').textContent = sharedLink.category;
    $('shared-link-note').textContent = note;
    $('shared-link-note-row').hidden = !note;
    $('shared-link-preview').classList.remove('hidden');
    $('notifications-empty').hidden = true;
    $('notification-indicator').hidden = false;
    $('notifications-dialog').showModal();

    const title = `${sharedLink.amount} CashToken base units requested`;
    const description =
      `Send ${sharedLink.amount} token base units to ${sharedLink.address} ` +
      `for CashToken category ${sharedLink.category}.`;
    document.querySelector('meta[name="description"]').content = description;
    document.querySelector('meta[property="og:title"]').content = title;
    document.querySelector('meta[property="og:description"]').content = description;
    document.querySelector('meta[property="og:url"]').content = window.location.href;
  }

  $('category-select').disabled =
    !walletReady || $('category').readOnly || $('category-select').options.length < 2;
  refreshCategoryIcon('category');
}

const mainnet = network === 'mainnet';
// ParyonUSD mainnet category and precision: https://paryonusd.com
const PUSD_CATEGORY = '2469acc5afa4b10cb5b5c04afb89c3a3ffd61c5da9c01e26d00951cae2a02544';
const prefix = mainnet ? 'bitcoincash' : 'bchtest';
const $ = (id) => document.getElementById(id);
if (mainnet && !$('receive-category').value) $('receive-category').value = PUSD_CATEGORY;
setupMarketTicker($('market-ticker'), translate, logger);
setupChainTicker($('chain-ticker'), logger);
setupMediaSlideshow($);

const updateReceiveToken = () => {
  $('receive-pusd').hidden = !mainnet || $('receive-category').value.trim().toLowerCase() !== PUSD_CATEGORY;
  refreshCategoryIcon('receive-category');
};
const refreshCategoryIcon = (id) => updateCategoryIcon($(id), $(`${id}-icon`), { mainnet, loadTokenLogo, logger });
updateReceiveToken();
for (const field of ['receive-address', 'receive-category']) {
  $(`edit-${field}`).addEventListener('click', () => {
    $(field).readOnly = false;
    $(field).focus();
  });
}
let QRCode, decodeCashAddress, encodeCashAddress, hash160, initiateDappRelay;
let DappConnectionManager, loadSession, sourceOutputToRelay, transactionToHex;
let TransactionBuilder, placeholderP2PKHUnlocker, provider;
let dependenciesPromise;

function loadWalletDependencies() {
  if (!dependenciesPromise) {
    dependenciesPromise = import('./wallet-deps.js').then((deps) => {
      ({ QRCode, decodeCashAddress, encodeCashAddress, hash160, initiateDappRelay,
        DappConnectionManager, loadSession, sourceOutputToRelay, transactionToHex,
        TransactionBuilder, placeholderP2PKHUnlocker } = deps);
      provider = new deps.ElectrumNetworkProvider(mainnet ? 'mainnet' : 'chipnet');
    }).catch((error) => {
      dependenciesPromise = null;
      throw error;
    });
  }
  return dependenciesPromise;
}

const SCAN_CONCURRENCY = 8;
const SCAN_RETRY_DELAYS_MS = [300, 700, 1500];
const MAXIMUM_FEE_SATOSHIS = 10_000n;
const FEE_RESERVE_SATOSHIS = 10_000n;
const TOKEN_OUTPUT_SATOSHIS = 1_000n;

$('network').textContent = network.toUpperCase();

let manager = null;
let relay = null;
let walletReady = false;
let registeredRewardAddress = null;
let refreshBrowserWalletUI = () => {};
let pairingInProgress = false;
let walletTransitioning = false;
let sending = false;
let transferInteracted = false;
let refreshPromise = null;
let addresses = [];
let scanAddressRecords = [];
let utxos = [];
let bchUsd = null;
let balanceSatoshis = null;
let emptyBalanceNotified = false;
let portfolioVersion = 0;
let paymentGeneration = 0;
let paymentPriceSnapshot = null;
let walletReceiveAddress = null;
let walletPairingUri = null;
let tokenBalances = new Map();
let portfolioPage = 0;
const pairingReminder = setupPairingReminder({
  button: $('pairing-reminder-enable'),
  status: $('pairing-reminder-status'),
  openWallet: $('open-wallet'),
  pendingUri: () => walletReady ? null : walletPairingUri,
  translate,
  logger,
});
let rewardCategory = null;
let rewardCategoryPromise = null;
let receiptWallet = null;
let minaPickaxe = false;

async function loadRewardCategory() {
  if (!rewardCategoryPromise) {
    rewardCategoryPromise = fetch(`${API_BASE_URL}/api/token-reward`)
      .then((response) => {
        if (!response.ok) throw new Error(`Reward category API error (${response.status})`);
        return response.json();
      })
      .then(({ category }) => {
        if (typeof category !== 'string' || !/^[0-9a-f]{64}$/i.test(category)) {
          throw new Error('Invalid reward category returned by the API.');
        }
        rewardCategory = category.toLowerCase();
        return rewardCategory;
      })
      .catch((error) => {
        rewardCategoryPromise = null;
        throw error;
      });
  }
  return rewardCategoryPromise;
}

function receiptStorageKey() {
  return `ctf-token-receipts:${network}:${addressFor(0, 0)}`;
}

function readReceiptState() {
  const saved = localStorage.getItem(receiptStorageKey());
  if (!saved) return { seen: [], sent: [], messages: [], receipts: [], unread: false, pendingMiningRewards: 0 };
  const state = JSON.parse(saved);
  if (!Array.isArray(state.seen) || !Array.isArray(state.sent) || !Array.isArray(state.messages)) {
    throw new Error('Invalid saved token notification state.');
  }
  state.pendingMiningRewards = Number.isSafeInteger(state.pendingMiningRewards)
    ? Math.max(0, state.pendingMiningRewards)
    : 0;
  if (!Array.isArray(state.receipts)) state.receipts = [];
  return state;
}

function renderMinaReceiptHistory(state) {
  const { grouped, total } = groupMinaReceipts(state.receipts);
  $('mina-receipt-history').hidden = grouped.size === 0;
  $('mina-receipt-count').textContent = `${total} MINA received in ${grouped.size} transaction${grouped.size === 1 ? '' : 's'}`;
  const transactions = $('mina-receipt-transactions');
  transactions.replaceChildren();
  for (const [txid, amount] of [...grouped].reverse()) {
    const row = document.createElement('code');
    row.className = 'mina-label';
    row.textContent = `${amount} MINA · ${txid}`;
    transactions.append(row);
  }
  if (grouped.size) $('notifications-empty').hidden = true;
}

const miningPayoutFailure = 'MINA mining payout could not be confirmed. Contact the operator.';
function addMiningFailureNotice() {
  if ($('mining-payout-failure')) return;
  const notice = document.createElement('div');
  notice.id = 'mining-payout-failure';
  notice.className = 'notification-message';
  notice.textContent = miningPayoutFailure;
  $('token-receipt-notifications').prepend(notice);
  $('notifications-empty').hidden = true;
}

function renderQueuedMiningRewards(count) {
  const container = $('token-receipt-notifications');
  let notice = $('mining-reward-queue-notice');
  if (!count) {
    notice?.remove();
    $('notifications-empty').hidden = container.childElementCount > 0 || !$('mina-receipt-history').hidden;
    return;
  }
  if (!notice) {
    notice = document.createElement('div');
    notice.id = 'mining-reward-queue-notice';
    notice.className = 'notification-message mining-reward-notice';
    const label = document.createElement('strong');
    const details = document.createElement('span');
    notice.append(label, details);
    container.prepend(notice);
    $('notifications-empty').hidden = true;
  }
  notice.querySelector('strong').textContent = `${count} MINA mining payout${count === 1 ? '' : 's'} pending`;
  notice.querySelector('span').textContent = 'A payout was requested. The wallet will report the MINA token at zero confirmations once it is sent.';
}

function reportMinedRewardFailure(address) {
  if (!walletReady || addressFor(0, 0) !== address) return;
  try {
    const state = readReceiptState();
    state.unread = true;
    if (!state.messages.includes(miningPayoutFailure)) state.messages.push(miningPayoutFailure);
    state.messages = state.messages.slice(-100);
    localStorage.setItem(receiptStorageKey(), JSON.stringify(state));
    addMiningFailureNotice();
    $('notification-indicator').hidden = false;
    renderQueuedMiningRewards(state.pendingMiningRewards);
  } catch (error) {
    logger.warn('Could not save the mining payout failure:', error);
    $('status').textContent = 'MINA payout failed · contact the operator';
  }
}

function queueMinedRewardNotification(address) {
  if (!walletReady || addressFor(0, 0) !== address) return;
  try {
    const state = readReceiptState();
    state.pendingMiningRewards++;
    state.unread = true;
    localStorage.setItem(receiptStorageKey(), JSON.stringify(state));
    $('notification-indicator').hidden = false;
    renderQueuedMiningRewards(state.pendingMiningRewards);
    void playNotificationSound('mining');
    void refreshMinedRewardReceipts();
  } catch (error) {
    logger.warn('Could not show the queued mining reward:', error);
    $('status').textContent = 'MINA reward queued · wallet notification could not be saved';
  }
}

let miningRewardRefreshAddress = null;
async function refreshMinedRewardReceipts() {
  if (!walletReady) return;
  const address = addressFor(0, 0);
  if (miningRewardRefreshAddress === address) return;
  miningRewardRefreshAddress = address;
  try {
    while (walletReady && addressFor(0, 0) === address) {
      try {
        await refreshBalances({ quiet: true });
      } catch (error) {
        logger.warn('Could not refresh a queued MINA reward:', error);
      }
      if (!walletReady || addressFor(0, 0) !== address) return;
      try {
        if (!readReceiptState().pendingMiningRewards) return;
      } catch (error) {
        logger.warn('Could not check the queued MINA reward state:', error);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  } finally {
    if (miningRewardRefreshAddress === address) miningRewardRefreshAddress = null;
  }
}

function rememberSentTransaction(txid) {
  const state = readReceiptState();
  state.sent.push(txid.toLowerCase());
  localStorage.setItem(receiptStorageKey(), JSON.stringify(state));
}

function notifyTokenReceipts(scannedUtxos) {
  const state = readReceiptState();
  const wallet = receiptStorageKey();
  const previouslyNotified = !state.receiptTracking && state.messages.length > 0;
  state.messages = state.messages
    .filter((entry) => entry === miningPayoutFailure);
  const sent = new Set(state.sent);
  const seen = new Set(state.seen);
  const matching = scannedUtxos.filter((utxo) =>
    utxo.token &&
    String(utxo.token.category).toLowerCase() === rewardCategory &&
    BigInt(utxo.token.amount || 0) > 0n &&
    !sent.has(utxo.txid.toLowerCase()) && utxoKey(utxo),
  );
  const received = matching.filter((utxo) => !seen.has(utxoKey(utxo)));
  for (const utxo of matching) seen.add(utxoKey(utxo));
  state.seen = [...seen];
  state.receiptTracking = true;
  if (!previouslyNotified && received.length) {
    const singleUnitReceipts = received.filter((utxo) => BigInt(utxo.token.amount) === 1n).length;
    state.pendingMiningRewards = Math.max(0, state.pendingMiningRewards - singleUnitReceipts);
    if (!state.pendingMiningRewards) {
      state.messages = state.messages.filter((entry) => entry !== miningPayoutFailure);
      $('mining-payout-failure')?.remove();
    }
  }
  if (received.length && !previouslyNotified) {
    state.receipts.push(...received.map((utxo) => ({
      txid: utxo.txid.toLowerCase(), amount: String(BigInt(utxo.token.amount)),
    })));
    state.unread = true;
  } else if (!state.messages.length && !state.pendingMiningRewards && !state.receipts.length) {
    state.unread = false;
  }
  localStorage.setItem(wallet, JSON.stringify(state));
  renderMinaReceiptHistory(state);

  if (receiptWallet !== wallet) {
    $('token-receipt-notifications').replaceChildren();
    if (state.messages.includes(miningPayoutFailure)) addMiningFailureNotice();
    if (state.unread) $('notification-indicator').hidden = false;
    receiptWallet = wallet;
  }
  renderQueuedMiningRewards(state.pendingMiningRewards);
  if (state.pendingMiningRewards) void refreshMinedRewardReceipts();
  if (received.length && !previouslyNotified) {
    $('notification-indicator').hidden = false;
    showMinaCelebration(received.length);
  }
}

function report(error, { log = true } = {}) {
  if (log) logger.error(error);
  $('log').classList.add('error');
  $('log').textContent = `Action failed: ${error?.message || String(error)}\nCheck the status above, your inputs and wallet connection before retrying.`;
}

document.querySelector('.topbar-tools-left').append(
  $('games-toggle').parentElement,
  $('language-toggle').parentElement,
);
for (const name of ['language', 'games']) {
  const toggle = $(`${name}-toggle`);
  const menu = $(`${name}-menu`);
  const close = () => {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  };
  toggle.addEventListener('click', () => {
    const opening = menu.hidden;
    document.querySelectorAll('.tool-dropdown').forEach((other) => { other.hidden = true; });
    document.querySelectorAll('.tool-menu > button').forEach((other) => other.setAttribute('aria-expanded', 'false'));
    menu.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
  });
  menu.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (name === 'language') {
      setLanguage(button.dataset.languageOption);
      if (paymentPriceSnapshot) {
        $('payment-price').textContent = `${translate('Indicative token price')}: ${formatPaymentPrice()}`;
      }
    }
    close();
    toggle.focus();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.tool-menu') || !toggle.parentElement.contains(event.target)) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      close();
      toggle.focus();
    }
  });
}

let updateGameRewardAddress = () => {};
function setConnection(connected) {
  if (!connected) {
    registeredRewardAddress = null;
    minaPickaxe = false;
  }
  if (connected && !$('game-wallet-notice').hidden) {
    $('game-wallet-notice').hidden = true;
    if ($('shared-link-preview').classList.contains('hidden')) {
      $('notification-indicator').hidden = true;
    }
  }
  pairingReminder.cancel();
  if (!connected) $('connection-loading').hidden = true;
  document.querySelectorAll('[data-wallet-panel]').forEach((panel) => { panel.hidden = !connected; });
  $('advanced-settings').hidden = !connected;
  $('forget').hidden = !connected || !!manager?.isBrowserWallet;
  $('disconnect').hidden = !connected;
  $('logout').hidden = !connected;
  $('wizard-toggle').hidden = false;
  updateGameRewardAddress(connected && registeredRewardAddress === addressFor(0, 0) ? registeredRewardAddress : null);
  if (!connected) $('game-status').textContent = '';
  document.body.classList.toggle('wallet-connected', connected);
  $('network-wallet-status').textContent = translate(connected ? 'Wallet connected' : 'Not connected');
  if (!$('wizard-dialog').hidden) {
    if (connected) {
      if (tutorialStep === 0) {
        tutorialStep = 1;
        showTutorialStep();
      }
    } else {
      tutorialStep = 0;
      showTutorialStep();
    }
  }
  $('dot').classList.toggle('online', connected);
  $('refresh').disabled = !connected;
  $('send').disabled = sending;
  $('copy-address').disabled = !connected;
  $('connect').disabled = connected || pairingInProgress;
  const isSend = $('send-tab').getAttribute('aria-selected') === 'true';
  $('send-tab').classList.toggle('active', (connected || transferInteracted) && isSend);
  $('receive-tab').classList.toggle('active', (connected || transferInteracted) && !isSend);
  $('top-send').classList.toggle('active', (connected || transferInteracted) && isSend);
  $('top-receive').classList.toggle('active', (connected || transferInteracted) && !isSend);
  refreshBrowserWalletUI();
}

function clearWalletDisplay() {
  minaPickaxe = false;
  updateGameRewardAddress(null);
  balanceSatoshis = null;
  emptyBalanceNotified = false;
  portfolioVersion++;
  addresses = [];
  scanAddressRecords = [];
  utxos = [];
  refreshPromise = null;
  $('address').textContent = 'Connect wallet to derive address';
  $('bch').innerHTML = `— <small>BCH</small>`;
  $('usd').textContent = 'USD value unavailable';
  $('tokens-usd').textContent = 'USD value unavailable';
  $('mina-balance').textContent = 'Unavailable';
  $('wallet-notification-summary').hidden = true;
  $('mina-receipt-history').hidden = true;
  $('mina-receipt-transactions').replaceChildren();
  $('token-count').textContent = '—';
  $('tokens').innerHTML =
    '<div class="empty">Connect a wallet to view token balances.</div>';
  $('portfolio-chart-content').textContent = translate('Connect a wallet to view allocation.');
  $('portfolio-chart').hidden = true;
  $('portfolio-chart').open = false;
  tokenBalances = new Map();
  receiptWallet = null;
  $('token-receipt-notifications').replaceChildren();
  if ($('shared-link-preview').classList.contains('hidden')) {
    $('notifications-empty').hidden = false;
    $('notification-indicator').hidden = true;
  }
  portfolioPage = 0;
  $('amount-help').textContent = 'Enter whole base units. Select a token to see its decimals and available balance.';
  $('category-select').replaceChildren(new Option('Enter a category ID manually', ''));
  $('category-select').disabled = true;
  $('token-options').hidden = true;
  $('token-options-list').replaceChildren();
  if (walletReceiveAddress && $('receive-address').value === walletReceiveAddress) {
    $('receive-address').value = '';
    $('copy-receive-address').disabled = true;
    $('payment-result').classList.add('hidden');
  }
  walletReceiveAddress = null;
}

function publicKey(pathIndex, index) {
  const key = manager?.getPubkey(pathIndex, BigInt(index));

  if (!key) {
    throw new Error(
      `Wallet public key ${pathIndex}/${index} is not available. Wait for wallet_ready.`,
    );
  }

  return key;
}

function addressFor(pathIndex, index, type = 'p2pkhWithTokens') {
  const key = publicKey(pathIndex, index);
  const result = encodeCashAddress({
    payload: hash160(key),
    prefix,
    type,
    throwErrors: true,
  });

  return result.address;
}

function deriveScanAddresses() {
  const records = [];
  const count = Number($('scan-count').value);
  if (!Number.isInteger(count) || count < 1 || count > 1000) {
    throw new Error('Address scan count must be a whole number between 1 and 1000 per path.');
  }

  for (const [pathName, pathIndex] of [
    ['receive', 0],
    ['change', 1],
  ]) {
    for (let index = 0; index < count; index++) {
      records.push({
        pathName,
        pathIndex,
        index,
        tokenAddress: addressFor(pathIndex, index, 'p2pkhWithTokens'),
        spendAddress: addressFor(pathIndex, index, 'p2pkh'),
      });
    }
  }

  return records;
}

async function showPairingUri(uri) {
  if (!uri) {
    throw new Error('WizardConnect did not return a pairing URI.');
  }

  $('pair-uri').textContent = uri;
  walletPairingUri = uri;
  $('open-wallet').disabled = false;
  $('open-wallet').hidden = false;
  $('pairing-help').hidden = false;
  $('pairing').classList.remove('hidden');

  await QRCode.toCanvas($('qr'), uri, {
    width: 190,
    margin: 4,
    errorCorrectionLevel: 'H',
    color: { dark: '#07111b', light: '#ffffff' },
  });
  if (!walletReady && walletPairingUri === uri) pairingReminder.start();
  $('open-wallet').scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}

async function startConnection({ fresh = false, restoring = false } = {}) {
  if (walletTransitioning || pairingInProgress || (walletReady && !fresh)) return;

  pairingInProgress = true;
  $('connect').disabled = true;
  $('connect').hidden = true;
  $('log').textContent = '';
  walletReady = false;
  clearWalletDisplay();
  $('pairing').classList.add('hidden');
  walletPairingUri = null;
  $('open-wallet').disabled = true;
  $('open-wallet').hidden = false;
  $('pairing-help').hidden = false;
  setConnection(false);

  try {
    await loadWalletDependencies();
    if (manager) {
      const previousManager = manager;
      manager = null;
      await previousManager.destroy();
    }
    if (relay) {
      try {
        relay.cleanup();
      } catch {
        // Cleanup is best-effort.
      }
      relay = null;
    }

    const saved = fresh ? null : loadSession();
    const stored = saved?.walletPublicKey && saved?.paths?.length ? saved : null;

    $('status').textContent = restoring
      ? 'Restoring saved WizardConnect session…'
      : fresh
        ? 'Starting a new WizardConnect pairing…'
        : stored?.walletPublicKey
          ? 'Reconnecting saved WizardConnect session…'
          : 'Starting WizardConnect pairing…';

    manager = new DappConnectionManager('CTF CashTokens');
    if (fresh || (saved && !stored)) manager.clearStoredSession();
    const connectionManager = manager;
    let connectedAt = 0;
    let relayConnected = false;
    let relayInterrupted = false;
    let readyGeneration = 0;

    manager.on('walletready', async (message) => {
      if (manager !== connectionManager) return;

      const currentReady = ++readyGeneration;
      let addressReady = false;
      try {
        walletReady = true;
        const address = addressFor(0, 0);
        updateReceiveAddress();
        $('forget').hidden = false;
        setConnection(true);
        $('pairing').classList.add('hidden');
        relayInterrupted = false;
        $('open-wallet').hidden = true;
        $('pairing-help').hidden = true;
        $('status').textContent =
          `Wallet handshake complete · ${
            message?.wallet_name || connectionManager.walletName || 'connected'
          }`;
        $('log').textContent = '';
        $('address').textContent = address;
        addressReady = true;
        if ($('connection-dialog').open) $('connection-dialog').close();
        $('connection-loading').hidden = false;
        const submission = registerRewardAddress(address, connectionManager).catch((error) => {
          if (walletReady && manager === connectionManager) {
            report(new Error(`Address submission failed: ${error?.message || error}`));
            $('status').textContent = 'Wallet connected · address submission failed';
          }
          throw error;
        });
        const [scanResult, submissionResult] = await Promise.allSettled([refreshBalances(), submission]);
        if (!walletReady || manager !== connectionManager) return;
        if (scanResult.status === 'rejected' && submissionResult.status === 'rejected') {
          report(new Error(
            `Address submission failed: ${submissionResult.reason?.message || submissionResult.reason}\n` +
            `Balance scan failed: ${scanResult.reason?.message || scanResult.reason}`,
          ), { log: false });
          $('status').textContent = 'Wallet connected · address submission and balance scan failed';
          return;
        }
        if (scanResult.status === 'rejected') throw scanResult.reason;
        if (submissionResult.status === 'rejected') {
          report(new Error(`Balances refreshed, but address submission failed: ${submissionResult.reason?.message || submissionResult.reason}`));
          $('status').textContent =
            'Wallet connected · balances refreshed; address submission failed';
        }
      } catch (error) {
        if (manager !== connectionManager) return;
        if (!addressReady) {
          walletReady = false;
          setConnection(false);
          $('open-wallet').hidden = false;
          $('pairing-help').hidden = false;
          $('status').textContent = 'Wallet connected · could not derive address';
          report(error);
          return;
        }
        report(error, { log: false });
        $('status').textContent = 'Wallet connected · balance scan failed';
      } finally {
        if (manager === connectionManager && currentReady === readyGeneration) {
          $('connection-loading').hidden = true;
        }
      }
    });

    manager.on('disconnect', (reason, message) => {
      if (manager !== connectionManager) return;
      walletReady = false;
      setConnection(false);
      clearWalletDisplay();
      $('pairing').classList.add('hidden');
      walletPairingUri = null;
      $('open-wallet').disabled = true;
      $('open-wallet').hidden = false;
      $('pairing-help').hidden = false;
      $('status').textContent =
        `Wallet disconnected · ${message || reason || 'connection closed'}`;
      report(
        new Error(
          `WizardConnect disconnect: ${message || reason || 'connection closed'}`,
        ),
      );

      try {
        relay?.cleanup();
      } catch {
        // Cleanup is best-effort.
      }
      relay = null;

      $('connect').disabled = false;
      $('connect').hidden = false;
    });

    manager.on('messagesent', (message) => {
      logger.info(
        '[WizardConnect] sent:',
        message?.action || 'protocol message',
      );
    });

    manager.on('messagereceived', (message) => {
      if (manager !== connectionManager) return;
      logger.info(
        '[WizardConnect] received:',
        message?.action || 'protocol message',
      );
      if (message?.action === 'pong' && walletReady && relayConnected) {
        relayInterrupted = false;
        $('open-wallet').hidden = true;
        $('pairing-help').hidden = true;
        $('status').textContent = 'Wallet connected · relay ready';
      }
    });

    const callback = (payload) => {
      if (manager !== connectionManager) return;
      logger.info(
        '[WizardConnect relay]',
        payload?.status?.status || 'unknown',
      );

      try {
        if (!payload?.client || !payload?.status) {
          throw new Error('WizardConnect relay returned an incomplete payload.');
        }

        connectionManager.updateConnection(payload.client, payload.status);
      } catch (error) {
        report(error);
        $('status').textContent = 'Relay update failed · see details below';
        return;
      }

      if (payload?.status?.status === 'connected') {
        relayConnected = true;
        if (walletReady) {
          if (!relayInterrupted) {
            $('open-wallet').hidden = true;
            $('pairing-help').hidden = true;
          }
          $('status').textContent = relayInterrupted
            ? 'Waiting for wallet to reconnect…'
            : 'Wallet connected · relay ready';
        } else {
          connectedAt = Date.now();
          $('status').textContent = 'Waiting for wallet approval and handshake…';
        }
      } else if (payload?.status?.status === 'reconnecting') {
        relayConnected = false;
        relayInterrupted = true;
        $('open-wallet').hidden = false;
        $('open-wallet').disabled = !walletPairingUri;
        $('pairing-help').hidden = false;
        $('status').textContent = 'Relay reconnecting · check your internet connection…';
        if (payload.status.error) logger.warn('[WizardConnect] relay reconnecting:', payload.status.error);
      } else if (payload?.status?.status === 'disconnected') {
        relayConnected = false;
        relayInterrupted = true;
        $('open-wallet').hidden = false;
        $('open-wallet').disabled = !walletPairingUri;
        $('pairing-help').hidden = false;
        $('status').textContent = 'Wallet connection paused · return to this browser to reconnect.';
      } else if (payload?.status?.status === 'error') {
        $('status').textContent = 'Relay error · see details below';
        report(new Error(`WizardConnect relay error: ${payload.status.message || 'Check your connection and reconnect.'}`));
      }
    };

    relay =
      stored?.walletPublicKey && !fresh
        ? initiateDappRelay(callback, { existingCredentials: stored })
        : initiateDappRelay(callback);

    manager.attachRelay(relay);
    // Attach before the relay reports connected so an early wallet_ready is not missed.
    connectionManager.updateConnection(relay.client, { status: 'connecting' });
    relay.events.on('keyexchangecomplete', () => {
      if (manager !== connectionManager) return;
      // The manager's initial handshake waits only 30 seconds for a scan.
      if (connectedAt && Date.now() - connectedAt >= 29_000) {
        connectionManager.updateConnection(relay.client, { status: 'connected' });
      }
    });

    if (!walletReady) {
      await showPairingUri(relay.uri);

      if (!walletReady) {
        $('status').textContent = stored
          ? 'Reconnecting saved session. Open your wallet and approve the connection if prompted.'
          : 'Open your wallet or scan the code, then approve and return here.';
      }
    }
  } catch (error) {
    $('status').textContent = 'Could not start WizardConnect';
    report(error);
    if (relay) {
      try {
        relay.cleanup();
      } catch (cleanupError) {
        logger.warn('Could not clean up the relay:', cleanupError);
      }
      relay = null;
    }
    walletPairingUri = null;
    $('open-wallet').disabled = true;
    $('connect').disabled = false;
    $('connect').hidden = false;
  } finally {
    pairingInProgress = false;
    $('connect').disabled = walletReady;
    refreshBrowserWalletUI();
  }
}

async function fetchBchUsd() {
  try {
    const response = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin-cash&vs_currencies=usd',
    );

    if (!response.ok) {
      throw new Error(`Price service returned HTTP ${response.status}`);
    }

    const data = await response.json();

    if (typeof data['bitcoin-cash']?.usd === 'number') {
      bchUsd = data['bitcoin-cash'].usd;
      if (walletReady && balanceSatoshis !== null) renderBalances(utxos);
      if (paymentPriceSnapshot) $('payment-price').textContent = `${translate('Indicative token price')}: ${formatPaymentPrice()}`;
    }
  } catch (error) {
    logger.warn('BCH/USD price unavailable:', error);
  }
}

function formatTokenAmount(amount, decimals) {
  const digits = amount.toString().padStart(decimals + 1, '0');
  if (!decimals) return digits;
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

function updateAmountHelp() {
  const token = tokenBalances.get($('category').value.trim().toLowerCase());
  const entered = $('amount').value.trim();
  const enteredDisplay = token?.metadata && /^[0-9]+$/.test(entered)
    ? ` · Entered: ${formatTokenAmount(BigInt(entered), token.metadata.decimals)} ${token.metadata.symbol || 'tokens'}`
    : '';
  $('amount-help').textContent = token
    ? `Enter whole base units · Available: ${token.amount} base units${token.metadata ? ` = ${formatTokenAmount(token.amount, token.metadata.decimals)} ${token.metadata.symbol || 'tokens'} · ${token.metadata.decimals} decimals${enteredDisplay}` : ' · decimals unavailable'}.`
    : 'Enter whole base units. Select a token to see its decimals and available balance.';
}

async function fetchAddressUtxosWithRetry(record) {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await provider.getUtxos(record.tokenAddress);

      if (!Array.isArray(result)) {
        throw new Error('Network provider returned a non-array UTXO result.');
      }

      return result;
    } catch (error) {
      if (attempt >= SCAN_RETRY_DELAYS_MS.length) {
        throw new Error(
          `UTXO scan failed for ${record.pathName}/${record.index}: ${
            error?.message || String(error)
          }`,
        );
      }

      await wait(SCAN_RETRY_DELAYS_MS[attempt]);
    }
  }
}

async function scanWallet() {
  const records = scanAddressRecords;
  if (!records.length) {
    throw new Error('No wallet addresses are available to scan.');
  }

  const results = new Array(records.length);
  const prefetchedLogos = new Map();
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= records.length) return;

      const record = records[index];
      results[index] = await fetchAddressUtxosWithRetry(record);
      if (mainnet) {
        for (const utxo of results[index]) {
          const category = String(utxo.token?.category || '').toLowerCase();
          const amount = String(utxo.token?.amount ?? '');
          if (!/^[\da-f]{64}$/.test(category) || !/^[0-9]+$/.test(amount) || /^0+$/.test(amount) || prefetchedLogos.has(category)) continue;
          prefetchedLogos.set(category, loadTokenLogo(category).then(
            (image) => ({ image }),
            (error) => ({ error }),
          ));
        }
      }
    }
  }

  const workerCount = Math.min(SCAN_CONCURRENCY, records.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const foundUtxos = [];
  const seen = new Set();

  for (let i = 0; i < records.length; i++) {
    const record = records[i];

    for (const utxo of results[i]) {
      const key = utxoKey(utxo);

      if (key && seen.has(key)) continue;
      if (key) seen.add(key);

      foundUtxos.push(normalizeUtxo(utxo, record));
    }
  }

  return { addresses: records, utxos: foundUtxos, prefetchedLogos };
}

function renderBalances(scannedUtxos, prefetchedLogos = new Map()) {
  const version = ++portfolioVersion;
  const pricedTokens = [];
  $('portfolio-chart').hidden = true;
  $('portfolio-chart-content').textContent = translate('Loading Cauldron prices…');
  let satoshis = 0n;

  for (const utxo of scannedUtxos) {
    satoshis += BigInt(utxo.satoshis);
  }

  const bchText = formatBch(satoshis);
  const bch = Number(satoshis) / Number(SATOSHIS_PER_BCH);

  $('bch').innerHTML = `${bchText} <small>BCH</small>`;
  $('usd').textContent =
    bchUsd === null
      ? 'USD value unavailable'
      : `≈ $${(bch * bchUsd).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })} USD`;

  const balances = new Map();
  const spendableBalances = new Map();

  for (const utxo of scannedUtxos) {
    if (!utxo.token || utxo.token.amount == null) continue;

    const amount = BigInt(utxo.token.amount);
    if (amount <= 0n) continue;

    const category = String(utxo.token.category).toLowerCase();
    balances.set(category, (balances.get(category) || 0n) + amount);
    if (!utxo.token.nft) {
      spendableBalances.set(category, (spendableBalances.get(category) || 0n) + amount);
    }
  }

  const nfts = scannedUtxos.filter((utxo) => utxo.token?.nft);
  const minaAmount = rewardCategory ? (balances.get(rewardCategory) || 0n).toString() : 'Unavailable';
  $('mina-balance').textContent = minaAmount;
  $('notification-mina').textContent = minaAmount;
  $('notification-bch').textContent = `${bchText} BCH`;
  $('wallet-notification-summary').hidden = false;
  $('tokens-usd').textContent = balances.size ? 'Calculating…' : '≈ $0.00';
  $('token-count').textContent =
    `${balances.size} fungible-token ${
      balances.size === 1 ? 'category' : 'categories'
    } · ${nfts.length} NFTs`;
  tokenBalances = new Map([...spendableBalances].map(([category, amount]) => [category, { amount, metadata: null }]));
  updateAmountHelp();

  const selector = $('category-select');
  const optionList = $('token-options-list');
  optionList.replaceChildren();
  $('token-options').hidden = spendableBalances.size === 0;
  const selectedCategory = $('category').value.trim().toLowerCase();
  selector.replaceChildren(new Option('Enter a category ID manually', ''));
  for (const [category, amount] of spendableBalances) {
    selector.add(new Option(`${category} (${amount} base units)`, category));
  }
  selector.value = spendableBalances.has(selectedCategory) ? selectedCategory : '';
  selector.disabled = !walletReady || $('category').readOnly || spendableBalances.size === 0;

  const tokens = $('tokens');
  tokens.replaceChildren();

  if (balances.size === 0 && nfts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      'No fungible-token balances found in the scanned addresses.';
    tokens.append(empty);
    $('portfolio-chart-content').textContent = translate('No priced token balances available.');
    paginatePortfolio();
    return;
  }

  let remaining = balances.size;
  for (const [category, amount] of balances.entries()) {
    const spendableAmount = spendableBalances.get(category) || 0n;
    const row = document.createElement('div');
    row.className = 'token-row';

    const summary = document.createElement('div');
    summary.className = 'token-summary';
    const icon = document.createElement('span');
    icon.className = 'token-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '◆';
    const details = document.createElement('div');
    details.className = 'token-details';
    const title = document.createElement('strong');
    title.textContent = 'Fungible token';

    const categoryElement = document.createElement('code');
    categoryElement.textContent = `${category.slice(0, 10)}…${category.slice(-8)}`;
    categoryElement.title = category;

    const copyCategory = document.createElement('button');
    copyCategory.type = 'button';
    copyCategory.className = 'small-button category-copy';
    copyCategory.setAttribute('aria-label', 'Copy category ID');
    copyCategory.title = 'Copy category ID';
    copyCategory.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="13" height="16" rx="2"/><path d="M9 5V3h7v2M9 10h7M9 14h7"/></svg>';
    copyCategory.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(category);
        copyCategory.classList.add('copied');
        copyCategory.setAttribute('aria-label', translate('Copied'));
        setTimeout(() => {
          copyCategory.classList.remove('copied');
          copyCategory.setAttribute('aria-label', translate('Copy category ID'));
        }, 1200);
      } catch (error) {
        report(error);
      }
    });
    const categoryLine = document.createElement('div');
    categoryLine.className = 'category-line';
    const infoToggle = document.createElement('button');
    infoToggle.type = 'button';
    infoToggle.className = 'metadata-info-toggle';
    infoToggle.textContent = 'ⓘ';
    infoToggle.setAttribute('aria-label', translate('Token metadata'));
    infoToggle.setAttribute('aria-expanded', 'false');
    infoToggle.setAttribute('aria-controls', `metadata-${category}`);
    const infoText = document.createElement('p');
    infoText.id = `metadata-${category}`;
    infoText.className = 'metadata-info';
    infoText.hidden = true;
    infoText.textContent = translate('Loading token metadata…');
    infoToggle.addEventListener('click', () => {
      infoText.hidden = !infoText.hidden;
      if (!infoText.hidden) supplyInfo.open = false;
      infoToggle.setAttribute('aria-expanded', String(!infoText.hidden));
    });
    categoryLine.append(infoToggle, categoryElement, copyCategory);
    details.append(title, categoryLine, infoText);
    const price = document.createElement('div');
    price.className = 'token-metadata';
    price.textContent = translate('Loading Cauldron price…');
    details.append(price);

    const amountElement = document.createElement('span');
    amountElement.className = 'token-amount';
    amountElement.textContent = `${amount} base units`;
    const amountGroup = document.createElement('div');
    amountGroup.className = 'token-amount-group';
    const amountValues = document.createElement('span');
    const amountPrice = document.createElement('small');
    amountPrice.className = 'token-amount-price';
    amountValues.append(amountElement, amountPrice);
    const supplyInfo = document.createElement('details');
    supplyInfo.className = 'supply-info';
    const supplyToggle = document.createElement('summary');
    supplyToggle.textContent = 'ⓘ';
    supplyToggle.setAttribute('aria-label', translate('About circulating supply'));
    supplyToggle.addEventListener('click', () => {
      if (!supplyInfo.open) {
        infoText.hidden = true;
        infoToggle.setAttribute('aria-expanded', 'false');
      }
    });
    const supplyText = document.createElement('p');
    supplyText.textContent = translate('Circulating supply is not verified here. Estimates depend on identifying reserved and burned tokens.');
    const supplyPopover = document.createElement('div');
    supplyPopover.className = 'supply-popover';
    supplyPopover.append(supplyText);
    supplyInfo.append(supplyToggle, supplyPopover);
    if (mainnet) {
      const supplyLink = document.createElement('a');
      supplyLink.href = `https://tokenexplorer.cash/?tokenId=${category}`;
      supplyLink.target = '_blank';
      supplyLink.rel = 'noopener noreferrer';
      supplyLink.textContent = translate('Explore supply and verification ↗');
      supplyPopover.append(supplyLink);
    }
    if (spendableAmount < amount) {
      const attached = document.createElement('small');
      attached.className = 'token-amount-price';
      attached.textContent = `${amount - spendableAmount} base units attached to NFTs; unavailable for sending.`;
      amountValues.append(attached);
    }
    amountGroup.append(amountValues, supplyInfo);
    summary.append(icon, details, amountGroup);
    row.append(summary);
    tokens.append(row);

    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'token-option';
    const optionIcon = document.createElement('span');
    optionIcon.className = 'token-icon';
    optionIcon.textContent = '◆';
    const optionLabel = document.createElement('span');
    optionLabel.textContent = `${category.slice(0, 10)}… · ${spendableAmount} base units`;
    option.append(optionIcon, optionLabel);
    option.addEventListener('click', () => {
      $('category').value = category;
      selector.value = category;
      $('token-options').open = false;
      refreshCategoryIcon('category');
      updateAmountHelp();
    });
    if (spendableAmount > 0n) optionList.append(option);

    if (mainnet) {
      const logo = prefetchedLogos.get(category)?.then(({ image, error }) => {
        if (error) throw error;
        return image;
      }) ?? loadTokenLogo(category);
      logo.then((image) => {
        if (version !== portfolioVersion) return;
        image.alt = '';
        icon.replaceChildren(image);
        optionIcon.replaceChildren(image.cloneNode());
      }).catch((error) => logger.warn(`Token logo unavailable for ${category}:`, error));
    }
    const metadataPromise = (mainnet
      ? fetchTokenMetadata(category)
      : Promise.reject(new Error('BCMR metadata is only available for mainnet.'))).then((metadata) => {
        if (version !== portfolioVersion) return metadata;
        if (tokenBalances.has(category)) tokenBalances.get(category).metadata = metadata;
        title.textContent = metadata.name || metadata.symbol || translate('Fungible token');
        title.title = title.textContent;
        infoText.textContent = [metadata.name, metadata.symbol, metadata.description, `${metadata.decimals} decimals`,
          metadata.uris && `URIs: ${JSON.stringify(metadata.uris)}`,
          metadata.extensions && `Extensions: ${JSON.stringify(metadata.extensions)}`].filter(Boolean).join(' · ');
        amountElement.textContent = `${formatTokenAmount(amount, metadata.decimals)} ${metadata.symbol || 'tokens'} (${amount} base units)`;
        amountElement.title = amountElement.textContent;
        const available = `${formatTokenAmount(spendableAmount, metadata.decimals)} ${metadata.symbol || 'tokens'} (${spendableAmount} base units)`;
        optionLabel.textContent = `${metadata.name || metadata.symbol || 'Token'} · ${available} · loading price`;
        updateAmountHelp();
        return metadata;
      });
    Promise.allSettled([metadataPromise, fetchCauldronSpot(category, network)]).then(([metadataResult, priceResult]) => {
      if (version !== portfolioVersion) return;
      const metadata = metadataResult.status === 'fulfilled' ? metadataResult.value : null;
      if (!metadata) {
        infoText.textContent = translate('BCMR metadata unavailable.');
        logger.warn(`BCMR metadata unavailable for ${category}:`, metadataResult.reason);
      }
      if (priceResult.status === 'fulfilled') {
        const spot = priceResult.value;
        const value = Number(amount) * spot;
        if (Number.isFinite(value) && value > 0) {
          const unit = metadata ? spot * 10 ** metadata.decimals : spot;
          const denomination = metadata?.symbol || (metadata ? translate('token') : translate('base unit'));
          const usd = bchUsd === null ? '' : ` · ≈ $${(unit * bchUsd).toPrecision(4)} USD / ${denomination} · ≈ $${(value * bchUsd).toFixed(2)} USD`;
          price.textContent = `≈ ${unit.toPrecision(4)} BCH / ${denomination} · ≈ ${value.toPrecision(4)} BCH${usd}`;
          if (bchUsd !== null) amountPrice.textContent = `≈ $${(unit * bchUsd).toPrecision(4)} / ${denomination}`;
          if (metadata) optionLabel.textContent = `${metadata.name || denomination} (${denomination}) · ${formatTokenAmount(spendableAmount, metadata.decimals)} ${denomination} (${spendableAmount} base units)${bchUsd === null ? '' : ` · $${(unit * bchUsd).toPrecision(4)} / token`}`;
          pricedTokens.push({ category, name: metadata?.symbol || metadata?.name || `${category.slice(0, 10)}…`, value });
        } else price.textContent = translate('Cauldron price unavailable.');
      } else {
        price.textContent = translate('Cauldron price unavailable.');
        logger.warn(`Cauldron price unavailable for ${category}:`, priceResult.reason);
      }
      if (metadata && !pricedTokens.some((item) => item.category === category)) {
        optionLabel.textContent = `${metadata.name || metadata.symbol || 'Token'} · ${formatTokenAmount(spendableAmount, metadata.decimals)} ${metadata.symbol || 'tokens'} (${spendableAmount} base units) · price unavailable`;
      }
      if (--remaining === 0) {
        const total = pricedTokens.reduce((sum, token) => sum + token.value, 0);
        $('tokens-usd').textContent = bchUsd === null || !pricedTokens.length
          ? 'USD value unavailable'
          : `≈ $${(total * bchUsd).toFixed(2)}${pricedTokens.length < balances.size ? ' (partial)' : ''}`;
        renderPortfolioChart(pricedTokens);
        $('portfolio-chart').hidden = pricedTokens.length === 0;
      }
    });
  }
  for (const utxo of nfts) {
    const category = String(utxo.token.category).toLowerCase();
    const row = document.createElement('div');
    row.className = 'token-row nft-row';
    const heading = document.createElement('strong');
    heading.textContent = 'NFT';
    const categoryLine = document.createElement('div');
    categoryLine.className = 'category-line nft-category-line';
    const categoryElement = document.createElement('code');
    categoryElement.textContent = `${category.slice(0, 10)}…${category.slice(-8)}`;
    categoryElement.title = category;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'small-button category-copy';
    copy.setAttribute('aria-label', translate('Copy category ID'));
    copy.title = translate('Copy category ID');
    copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="13" height="16" rx="2"/><path d="M9 5V3h7v2M9 10h7M9 14h7"/></svg>';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(category);
        copy.setAttribute('aria-label', translate('Copied'));
        setTimeout(() => copy.setAttribute('aria-label', translate('Copy category ID')), 1200);
      } catch (error) {
        report(error);
      }
    });
    categoryLine.append(categoryElement, copy);
    const details = document.createElement('p');
    details.className = 'fine nft-details';
    const nft = utxo.token.nft;
    details.textContent = `Capability: ${nft.capability ?? 'unavailable'} · Commitment: ${nft.commitment === '' ? 'empty' : nft.commitment ?? 'unavailable'} · ${utxo.txid}:${utxo.vout}` +
      (BigInt(utxo.token.amount || 0) > 0n ? ` · ${utxo.token.amount} attached base units` : '');
    const inspection = inspectNft(nft);
    const advanced = document.createElement('details');
    advanced.className = 'advanced-nft';
    const summary = document.createElement('summary');
    summary.textContent = translate('Inspect NFT');
    const info = document.createElement('p');
    info.className = 'fine nft-inspection';
    const capabilities = {
      none: 'Immutable: ordinary continuation preserves the commitment.',
      mutable: 'Mutable: a valid successor may change the commitment.',
      minting: 'Minting: this NFT can authorize new NFTs in its category.',
    };
    const capabilityText = inspection.capability
      ? translate(capabilities[inspection.capability])
      : translate('Unrecognized NFT capability.');
    const commitmentText = inspection.commitmentBytes === null
      ? translate('Invalid or unavailable commitment.')
      : `${translate('Commitment bytes')}: ${inspection.commitmentBytes} / 40`;
    info.textContent = `${capabilityText} ${commitmentText} · ${translate('Output')}: ${utxo.txid}:${utxo.vout} · ${utxo.satoshis} satoshis. ${translate('This wallet view does not establish who controls other minting authorities.')}`;
    advanced.append(summary, info);
    row.append(heading, categoryLine, details, advanced);
    tokens.append(row);
  }
  if (balances.size === 0) $('portfolio-chart-content').textContent = translate('No priced token balances available.');
  paginatePortfolio();
}

function paginatePortfolio() {
  const showNfts = $('show-nfts').checked;
  const rows = [...$('tokens').children].filter((row) => row.classList.contains('token-row'));
  const visible = rows.filter((row) => showNfts || !row.classList.contains('nft-row'));
  const pages = Math.max(1, Math.ceil(visible.length / 6));
  portfolioPage = Math.min(Math.max(0, portfolioPage), pages - 1);
  for (const row of rows) row.hidden = true;
  for (const row of visible.slice(portfolioPage * 6, (portfolioPage + 1) * 6)) row.hidden = false;
  $('portfolio-pagination').hidden = pages <= 1;
  $('portfolio-prev').disabled = portfolioPage === 0;
  $('portfolio-next').disabled = portfolioPage >= pages - 1;
  $('portfolio-page').textContent = `${portfolioPage + 1} / ${pages}`;
  $('portfolio-empty-filter').hidden = visible.length > 0 || rows.length === 0;
}

function renderPortfolioChart(items) {
  const content = $('portfolio-chart-content');
  content.replaceChildren();
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!items.length || !Number.isFinite(total) || total <= 0) {
    content.textContent = translate('No priced token balances available.');
    return;
  }
  const colors = Array.from({ length: 6 }, (_, index) => `var(--chart-${index + 1})`);
  const wrapper = document.createElement('div');
  wrapper.className = 'allocation';
  const pie = document.createElement('div');
  pie.className = 'allocation-pie';
  pie.setAttribute('aria-hidden', 'true');
  const legend = document.createElement('ul');
  legend.className = 'allocation-legend';
  let offset = 0;
  const center = document.createElement('div');
  center.className = 'allocation-total';
  const totalLabel = document.createElement('span');
  totalLabel.textContent = translate('Priced tokens');
  const totalValue = document.createElement('strong');
  totalValue.textContent = `${total.toPrecision(4)} BCH`;
  center.append(totalLabel, totalValue);
  pie.append(center);
  const stops = [...items].sort((a, b) => b.value - a.value || a.category.localeCompare(b.category)).map((item, index) => {
    const start = offset;
    offset += item.value / total * 100;
    const color = colors[index % colors.length];
    const li = document.createElement('li');
    const swatch = document.createElement('span');
    swatch.className = 'allocation-swatch';
    swatch.style.backgroundColor = color;
    const name = document.createElement('span');
    name.className = 'allocation-name';
    name.textContent = item.name;
    name.title = `${item.name} · ${item.category}`;
    const value = document.createElement('span');
    value.className = 'allocation-value';
    value.textContent = `${(item.value / total * 100).toFixed(1)}% · ${item.value.toPrecision(4)} BCH`;
    li.append(swatch, name, value);
    legend.append(li);
    return `${color} ${start}% ${offset}%`;
  });
  pie.style.background = `conic-gradient(${stops.join(', ')})`;
  wrapper.append(pie, legend);
  content.append(wrapper);
}

async function refreshBalances({ quiet = false } = {}) {
  if (!walletReady) {
    throw new Error(
      'No wallet connected. Connect a browser wallet or a compatible WizardConnect wallet first.',
    );
  }

  if (refreshPromise) return refreshPromise;

  const scanManager = manager;
  const scanPromise = (async () => {
    if (!quiet) {
      $('status').textContent = 'Scanning wallet addresses…';
    }

    scanAddressRecords = deriveScanAddresses();
    const scanned = await scanWallet();

    if (!walletReady || manager !== scanManager) {
      throw new Error('Wallet disconnected during the balance scan.');
    }

    addresses = scanned.addresses;
    utxos = scanned.utxos;
    balanceSatoshis = utxos.reduce((sum, utxo) => sum + BigInt(utxo.satoshis), 0n);
    renderBalances(utxos, scanned.prefetchedLogos);
    let receiptError;
    try {
      await loadRewardCategory();
      if (walletReady && manager === scanManager) {
        const mina = utxos.reduce((sum, utxo) => utxo.token &&
          String(utxo.token.category).toLowerCase() === rewardCategory
          ? sum + BigInt(utxo.token.amount || 0) : sum, 0n);
        $('mina-balance').textContent = mina.toString();
        $('notification-mina').textContent = mina.toString();
        const rewardAddress = registeredRewardAddress;
        if (!walletReady || manager !== scanManager || registeredRewardAddress !== rewardAddress) {
          throw new Error('Wallet or reward address changed during the balance scan.');
        }
        minaPickaxe = !!rewardAddress && mina >= 2n;
        updateGameRewardAddress(registeredRewardAddress);
        notifyTokenReceipts(utxos);
      }
    } catch (error) {
      if (walletReady && manager === scanManager) {
        minaPickaxe = false;
        updateGameRewardAddress(registeredRewardAddress);
      }
      receiptError = error;
    }
    if (!walletReady || manager !== scanManager) {
      throw new Error('Wallet disconnected during the balance scan.');
    }
    if (!quiet && balanceSatoshis === 0n && !emptyBalanceNotified) {
      const notice = () => {
        if (walletReady && balanceSatoshis === 0n && !emptyBalanceNotified) {
          emptyBalanceNotified = true;
          showFundingDialog('Your wallet has no BCH. You need BCH for transaction fees.');
        }
      };
      const openDialog = document.querySelector('dialog[open]');
      if (openDialog) openDialog.addEventListener('close', notice, { once: true });
      else notice();
    }

    $('status').textContent = 'Wallet connected · balances refreshed';

    if (!quiet) {
      $('log').textContent = '';
    }
    if (receiptError) {
      $('log').textContent += `${$('log').textContent ? '\n' : ''}Token receipt notifications could not be updated: ${receiptError?.message || String(receiptError)}`;
    }

    return { addresses, utxos };
  })();

  refreshPromise = scanPromise;

  try {
    return await scanPromise;
  } catch (error) {
    if (walletReady && manager === scanManager) {
      minaPickaxe = false;
      updateGameRewardAddress(registeredRewardAddress);
    }
    throw error;
  } finally {
    if (refreshPromise === scanPromise) {
      refreshPromise = null;
    }
  }
}

function validateRecipient(raw) {
  const address = raw.trim();
  const decoded = decodeCashAddress(address);

  if (typeof decoded === 'string') {
    throw new Error(`Invalid CashAddr: ${decoded}`);
  }

  if (decoded.prefix !== prefix) {
    throw new Error(`Recipient must use ${prefix}: for this network.`);
  }

  if (
    decoded.type !== 'p2pkhWithTokens' &&
    decoded.type !== 'p2shWithTokens'
  ) {
    throw new Error('Recipient must be a token-aware CashAddr.');
  }

  return address;
}

async function refreshAfterApproval() {
  let lastError;
  for (const delay of [1500, 3000]) {
    if (delay > 0) await wait(delay);

    try {
      await refreshBalances({ quiet: true });
      $('status').textContent =
        'Transaction broadcast · balances rescanned; indexing may lag';
      return;
    } catch (error) {
      lastError = error;
    }
  }

  $('status').textContent =
    'Transaction broadcast · balance scan failed; network indexing may lag';
  $('log').textContent += `\nBalance refresh failed: ${lastError?.message || String(lastError)}`;
}

async function sendFungibleTokens() {
  if (sending) return;

  sending = true;
  setConnection(walletReady);
  $('log').textContent = '';
  const localUnlockers = [];

  try {
    if (!walletReady) {
      throw new Error('Connect and approve the wallet handshake first.');
    }
    const signingManager = manager;

    const requestedCategory = $('category').value.trim().toLowerCase();

    if (!/^[0-9a-f]{64}$/.test(requestedCategory)) {
      throw new Error('Category ID must be exactly 64 hexadecimal characters.');
    }

    const recipient = validateRecipient($('recipient').value);
    const amountText = $('amount').value.trim();

    if (!/^[1-9][0-9]*$/.test(amountText)) {
      throw new Error('Amount must be a positive whole number.');
    }

    const amount = BigInt(amountText);

    if (
      mainnet && !manager?.isBrowserWallet &&
      !window.confirm(
        `${translate('MAINNET transaction')}\n\n` +
          `${translate(`Send ${amount.toString()} token units`)}\n` +
          `${translate('Category')}: ${requestedCategory}\n` +
          `${translate('To')}: ${recipient}\n\n` +
          translate('The wallet will ask you to approve and sign this transaction.'),
      )
    ) {
      $('status').textContent = 'Mainnet transaction cancelled';
      return;
    }

    $('status').textContent = 'Refreshing UTXOs before building transaction…';

    const scan = await refreshBalances({ quiet: true });

    if (!Array.isArray(scan?.utxos) || !Array.isArray(scan?.addresses)) {
      throw new Error('Balance scan did not return UTXOs and address records.');
    }
    if (!walletReady || manager !== signingManager) throw new Error('Wallet changed during transaction preparation.');

    const availableTokenInputs = scan.utxos.filter((utxo) => {
      if (
        !utxo.token ||
        utxo.token.nft ||
        typeof utxo.token.category !== 'string' ||
        utxo.token.amount == null
      ) {
        return false;
      }

      return (
        utxo.token.category.toLowerCase() === requestedCategory &&
        BigInt(utxo.token.amount) > 0n
      );
    });

    const availableTokenBalance = availableTokenInputs.reduce(
      (sum, utxo) => sum + BigInt(utxo.token.amount),
      0n,
    );

    if (availableTokenBalance < amount) {
      throw new Error(
        `Insufficient fungible tokens. Available: ${availableTokenBalance.toString()}.`,
      );
    }

    const tokenCategory =
      availableTokenInputs[0]?.token.category.toLowerCase();

    if (!tokenCategory) {
      throw new Error('No spendable fungible tokens found for that category.');
    }

    if (
      availableTokenInputs.some(
        (utxo) => utxo.token.category.toLowerCase() !== tokenCategory,
      )
    ) {
      throw new Error('Selected token inputs do not share one category.');
    }

    const sortedTokenInputs = [...availableTokenInputs].sort((a, b) => {
      const amountA = BigInt(a.token.amount);
      const amountB = BigInt(b.token.amount);
      return amountA === amountB ? 0 : amountA > amountB ? -1 : 1;
    });

    const tokenInputs = [];
    let selectedTokenBalance = 0n;

    for (const utxo of sortedTokenInputs) {
      if (selectedTokenBalance >= amount) break;

      tokenInputs.push(utxo);
      selectedTokenBalance += BigInt(utxo.token.amount);
    }

    if (selectedTokenBalance < amount) {
      throw new Error('Could not select enough token inputs.');
    }

    const tokenChangeNeeded = selectedTokenBalance > amount;
    const requiredBchSatoshis =
      TOKEN_OUTPUT_SATOSHIS +
      (tokenChangeNeeded ? TOKEN_OUTPUT_SATOSHIS : 0n) +
      FEE_RESERVE_SATOSHIS;

    let selectedBchSatoshis = tokenInputs.reduce(
      (sum, utxo) => sum + BigInt(utxo.satoshis),
      0n,
    );

    const availableBchInputs = scan.utxos
      .filter((utxo) => !utxo.token && BigInt(utxo.satoshis) > 0n)
      .sort((a, b) => {
        const valueA = BigInt(a.satoshis);
        const valueB = BigInt(b.satoshis);
        return valueA === valueB ? 0 : valueA > valueB ? -1 : 1;
      });

    const bchInputs = [];

    for (const utxo of availableBchInputs) {
      if (selectedBchSatoshis >= requiredBchSatoshis) break;

      bchInputs.push(utxo);
      selectedBchSatoshis += BigInt(utxo.satoshis);
    }

    if (selectedBchSatoshis < requiredBchSatoshis) {
      throw new Error(
        'Not enough BCH in the selected inputs to cover outputs and the fee reserve.',
      );
    }

    const inputs = [...tokenInputs, ...bchInputs];

    if (inputs.length === 0) {
      throw new Error('No spendable inputs found.');
    }

    const builder = new TransactionBuilder({
      provider,
      maximumFeeSatoshis: MAXIMUM_FEE_SATOSHIS,
      allowImplicitFungibleTokenBurn: false,
    });

    const inputPaths = inputs.map((utxo, inputIndex) => {
      const addressIndex = Number(utxo.addressIndex);

      if (!['receive', 'change'].includes(utxo.pathName)) {
        throw new Error(`Invalid wallet path for input ${inputIndex}.`);
      }

      if (!Number.isSafeInteger(addressIndex) || addressIndex < 0) {
        throw new Error(`Invalid derivation index for input ${inputIndex}.`);
      }

      if (!utxo.spendAddress) {
        throw new Error(`Missing spend address for input ${inputIndex}.`);
      }

      return [inputIndex, utxo.pathName, addressIndex];
    });

    for (const utxo of inputs) {
      if (manager?.isBrowserWallet &&
          addressFor(utxo.pathName === 'receive' ? 0 : 1, Number(utxo.addressIndex), 'p2pkh') !== utxo.spendAddress) {
        throw new Error('Transaction input does not match the browser wallet derivation path.');
      }
      const unlocker = manager?.isBrowserWallet
        ? manager.unlocker(utxo.pathName === 'receive' ? 0 : 1, Number(utxo.addressIndex))
        : placeholderP2PKHUnlocker(utxo.spendAddress);
      if (manager?.isBrowserWallet) localUnlockers.push(unlocker);
      builder.addInput(
        utxo,
        unlocker,
      );
    }

    builder
      .addOutput({
        to: recipient,
        amount: TOKEN_OUTPUT_SATOSHIS,
        token: {
          category: tokenCategory,
          amount,
        },
      })
      .addTokenChangeOutputIfNeeded({
        category: tokenCategory,
        to: addressFor(0, 0, 'p2pkhWithTokens'),
      })
      .addBchChangeOutputIfNeeded({
        to: addressFor(1, 0, 'p2pkh'),
        feeRate: 1.1,
      });

    let signed;
    if (manager?.isBrowserWallet) {
      const signedTransaction = builder.build();
      const { feeSats } = builder.calculateTransactionFee();
      if (!window.confirm(
        `${translate('Review browser wallet transaction')}\n\n` +
        `${translate(`Send ${amount.toString()} token units`)}\n` +
        `${translate('Category')}: ${tokenCategory}\n` +
        `${translate('To')}: ${recipient}\n` +
        `${translate('Network fee')}: ${feeSats.toString()} satoshis\n\n` +
        translate('Approve and broadcast this transaction?'),
      )) {
        $('status').textContent = 'Transaction cancelled';
        return;
      }
      signed = { signedTransaction };
    } else {
      const transaction = builder.generateWcTransactionObject({
        broadcast: false,
        userPrompt: translate(`Send ${amount.toString()} fungible token units`),
      });

      if (!Array.isArray(transaction?.sourceOutputs)) {
        throw new Error('Generated transaction is missing sourceOutputs.');
      }

      const transactionInputCount = transaction?.transaction?.inputs?.length;

      if (
        !Number.isInteger(transactionInputCount) ||
        transactionInputCount !== transaction.sourceOutputs.length
      ) {
        throw new Error(
          `Transaction/sourceOutputs mismatch: inputs=${transactionInputCount}, ` +
            `sourceOutputs=${transaction.sourceOutputs.length}.`,
        );
      }

      if (inputPaths.length !== transactionInputCount) {
        throw new Error(
          `Input path count mismatch: paths=${inputPaths.length}, inputs=${transactionInputCount}.`,
        );
      }

      // Convert the CashScript transaction to WizardConnect's relay format.
      // A hex transaction avoids JSON/BigInt problems in the transaction itself;
      // sourceOutputToRelay converts Uint8Array and BigInt fields in each UTXO.
      const relayTransaction = {
        transaction: transactionToHex(
          transaction.transaction.inputs,
          transaction.transaction.outputs,
          transaction.transaction.version,
          transaction.transaction.locktime,
        ),
        sourceOutputs: transaction.sourceOutputs.map(sourceOutputToRelay),
        broadcast: false,
        userPrompt: translate(`Send ${amount.toString()} fungible token units`),
      };

      if (relayTransaction.sourceOutputs.length !== inputPaths.length) {
        throw new Error(
          `Signing metadata mismatch: sourceOutputs=${relayTransaction.sourceOutputs.length}, ` +
            `inputPaths=${inputPaths.length}.`,
        );
      }

      const signingRequest = {
        transaction: relayTransaction,
        inputPaths,
      };

      $('status').textContent =
        'Transaction built · waiting for wallet review and approval…';

      signed = await manager.signTransaction(signingRequest);
    }

    if (
      typeof signed?.signedTransaction !== 'string' ||
      signed.signedTransaction.length === 0
    ) {
      throw new Error(
        'Wallet rejected the transaction or did not return a signed transaction.',
      );
    }
    if (!walletReady || manager !== signingManager) throw new Error('Wallet changed before the transaction could be broadcast.');

    $('status').textContent = 'Wallet approved · broadcasting transaction…';

    const txid = await provider.sendRawTransaction(
      signed.signedTransaction,
    );
    let receiptTrackingError = null;
    try {
      rememberSentTransaction(txid);
    } catch (error) {
      receiptTrackingError = error;
    }

    $('log').classList.remove('error');
    $('log').textContent = `Transaction ID: ${txid}`;
    $('status').textContent =
      'Transaction broadcast · checking balances…';

    await refreshAfterApproval();
    if (receiptTrackingError) {
      $('log').textContent += `\nTransaction was broadcast, but receipt tracking could not be saved: ${receiptTrackingError?.message || String(receiptTrackingError)}`;
    }
  } catch (error) {
    report(error, { log: false });
    $('status').textContent = 'Transaction was not completed';
  } finally {
    for (const unlocker of localUnlockers) unlocker.template.privateKey.fill(0);
    sending = false;
    setConnection(walletReady);
  }
}

$('connect').addEventListener('click', () => {
  startConnection();
});

$('open-wallet').addEventListener('click', () => {
  if (walletPairingUri) window.location.href = walletPairingUri;
});

async function endWalletSession({ preserveWizardSession = false } = {}) {
  if (walletTransitioning) throw new Error('A wallet session change is already in progress.');
  walletTransitioning = true;
  try {
    const previousManager = manager;
    const previousRelay = relay;
    const wasReady = walletReady;
    manager = null;
    relay = null;
    walletReady = false;
    setConnection(false);

    if (previousManager) {
      if (previousManager.isBrowserWallet) {
        sessionStorage.removeItem(`cashcraft:browser-wallet-session:v1:${network}`);
      }
      if (wasReady && !previousManager.isBrowserWallet) {
        try {
          await Promise.race([
            previousManager.sendDisconnect(),
            wait(2000).then(() => { throw new Error('Wallet disconnect timed out.'); }),
          ]);
        } catch (error) {
          logger.warn('Could not notify wallet of disconnection:', error);
        }
      }
      if (!preserveWizardSession) previousManager.clearStoredSession();
      await previousManager.destroy();
    }

    try {
      previousRelay?.cleanup();
    } catch {
      // Cleanup is best-effort.
    }

    $('pairing').classList.add('hidden');
    walletPairingUri = null;
    $('open-wallet').disabled = true;
    $('open-wallet').hidden = false;
    $('pairing-help').hidden = false;
    clearWalletDisplay();
  } finally {
    walletTransitioning = false;
    refreshBrowserWalletUI();
  }
}

async function connectBrowserWallet(phrase, isCurrent = () => true, session = null) {
  if (walletReady || pairingInProgress || walletTransitioning) throw new Error('Disconnect the current wallet or finish pairing first.');
  const [{ BrowserWallet }] = await Promise.all([import('./browser-wallet.js'), loadWalletDependencies()]);
  if (!isCurrent()) return;
  if (walletReady || pairingInProgress || walletTransitioning) throw new Error('Another wallet connected. Disconnect it first.');
  if (manager || relay) await endWalletSession({ preserveWizardSession: true });
  if (!isCurrent()) return;
  if (walletReady || pairingInProgress || walletTransitioning || manager) throw new Error('Another wallet connected. Disconnect it first.');

  const vault = localStorage.getItem(`cashcraft:browser-wallet:v1:${network}`);
  const wallet = session ? BrowserWallet.fromSession(session, vault) : new BrowserWallet(phrase);
  let address;
  try {
    sessionStorage.setItem(`cashcraft:browser-wallet-session:v1:${network}`, wallet.exportSession(vault));
    manager = wallet;
    walletReady = true;
    address = addressFor(0, 0);
    updateReceiveAddress();
    setConnection(true);
    $('connect').hidden = true;
    $('open-wallet').hidden = true;
    $('pairing-help').hidden = true;
    $('pairing').classList.add('hidden');
    $('address').textContent = address;
    $('log').textContent = '';
    $('status').textContent = 'Browser wallet connected · checking balances…';
    if ($('connection-dialog').open) $('connection-dialog').close();
  } catch (error) {
    if (!session) sessionStorage.removeItem(`cashcraft:browser-wallet-session:v1:${network}`);
    manager = null;
    walletReady = false;
    await wallet.destroy();
    setConnection(false);
    throw error;
  }

  void (async () => {
    const [scan, submission] = await Promise.allSettled([refreshBalances(), registerRewardAddress(address, wallet)]);
    if (!walletReady || manager !== wallet) return;
    const failures = [];
    if (scan.status === 'rejected') failures.push(`Balance scan failed: ${scan.reason?.message || scan.reason}`);
    if (submission.status === 'rejected') failures.push(`Address submission failed: ${submission.reason?.message || submission.reason}`);
    if (failures.length) {
      report(new Error(failures.join('\n')), { log: false });
      $('status').textContent = 'Browser wallet connected · some services are unavailable';
    }
  })();
}

$('forget').addEventListener('click', async () => {
  if (
    !window.confirm(
      translate('Forget this saved pairing and create a new WizardConnect session?'),
    )
  ) {
    return;
  }

  try {
    await endWalletSession();
    $('status').textContent = 'Saved session cleared';
    await startConnection({ fresh: true });
  } catch (error) {
    report(error);
  }
});

async function disconnectWallet() {
  if (!window.confirm(translate('Disconnect this wallet from CTF Cash?'))) return;
  try {
    await endWalletSession();
    $('status').textContent = 'Wallet disconnected';
    $('connect').hidden = false;
    $('connect').disabled = false;
  } catch (error) {
    report(error);
  }
}
$('disconnect').addEventListener('click', disconnectWallet);
$('logout').addEventListener('click', disconnectWallet);

$('refresh').addEventListener('click', () => {
  refreshBalances().catch((error) => {
    report(error, { log: false });
    $('status').textContent =
      'Balance refresh failed · previous balances retained';
  });
});

function openConnectionDialog() {
  if (!walletReady && !$('game-wallet-notice').hidden &&
      $('shared-link-preview').classList.contains('hidden')) markNotificationsRead();
  if (!$('connection-dialog').open) $('connection-dialog').showModal();
}

async function refreshAfterRewardRegistration(wallet) {
  try {
    if (refreshPromise) {
      try {
        await refreshPromise;
      } catch (error) {
        logger.warn('Initial wallet scan failed before reward registration:', error);
      }
    }
    if (walletReady && manager === wallet) await refreshBalances({ quiet: true });
  } catch (error) {
    if (walletReady && manager === wallet) {
      $('status').textContent = 'Automatic balance refresh failed · use Refresh balances to retry.';
      report(error, { log: false });
    }
  }
}

let addressRegistration = null;
function registerRewardAddress(address, wallet) {
  if (addressRegistration?.address === address && addressRegistration.wallet === wallet) {
    return addressRegistration.promise;
  }
  const registration = { address, wallet, promise: null };
  registration.promise = (async () => {
    await submitCashAddress(address);
    if (!walletReady || manager !== wallet || addressFor(0, 0) !== address) return;
    registeredRewardAddress = address;
    updateGameRewardAddress(address);
    void refreshAfterRewardRegistration(wallet);
  })().finally(() => {
    if (addressRegistration === registration) addressRegistration = null;
  });
  addressRegistration = registration;
  return registration.promise;
}

document.querySelectorAll('[data-wallet-choice]').forEach((choice) => {
  choice.addEventListener('click', () => {
    document.querySelectorAll('[data-wallet-choice]').forEach((other) => {
      other.setAttribute('aria-pressed', String(other === choice));
    });
    openConnectionDialog();
    beginPairing();
  });
});

$('connection-open').addEventListener('click', openConnectionDialog);
$('landing-connect').addEventListener('click', openConnectionDialog);
$('connection-close').addEventListener('click', () => $('connection-dialog').close());
$('connection-dialog').addEventListener('close', () => {
  if (!$('connection-dialog').open && !$('wizard-dialog').hidden && tutorialStep === 0) closeTutorial();
});

$('wiki-open').addEventListener('click', () => {
  if (!$('wiki-dialog').open) $('wiki-dialog').showModal();
});
$('wiki-close').addEventListener('click', () => $('wiki-dialog').close());
$('wiki-language').addEventListener('change', (event) => setLanguage(event.target.value));
$('connection-language').addEventListener('change', (event) => setLanguage(event.target.value));
setupWikiGlossary($('wiki-dialog'));

refreshBrowserWalletUI = setupBrowserWallet($, {
  network,
  canConnect: () => !walletReady && !pairingInProgress && !walletTransitioning,
  onConnect: connectBrowserWallet,
});
updateGameRewardAddress = setupGames($, {
  translate,
  getRewardAddress: () => walletReady ? registeredRewardAddress : null,
  isWalletConnected: () => walletReady,
  hasMinaPickaxe: () => walletReady && minaPickaxe,
});
const donationDependencies = async () => {
  await loadWalletDependencies();
  return { QRCode, decodeCashAddress };
};
setupGameInvite($, network, donationDependencies);
$('donate-open').addEventListener('click', () => {
  if (!$('donate-dialog').open) $('donate-dialog').showModal();
  void loadDonation($, network, donationDependencies, 'donate');
});
$('donate-close').addEventListener('click', () => $('donate-dialog').close());
$('donate-dialog').addEventListener('close', () => $('donate-open').focus());

$('show-nfts').addEventListener('change', () => {
  portfolioPage = 0;
  paginatePortfolio();
});
$('portfolio-prev').addEventListener('click', () => {
  portfolioPage--;
  paginatePortfolio();
});
$('portfolio-next').addEventListener('click', () => {
  portfolioPage++;
  paginatePortfolio();
});

$('send').addEventListener('click', () => {
  if (walletReady) {
    if (balanceSatoshis === 0n) {
      showFundingDialog('Your wallet has no BCH. You need BCH for transaction fees.');
      return;
    }
    sendFungibleTokens();
    return;
  }
  showFundingDialog('Connect a compatible wallet before sending tokens.');
});

function showFundingDialog(message) {
  $('funding-message').textContent = message;
  $('funding-connect').hidden = walletReady;
  if (!$('funding-dialog').open && !document.querySelector('dialog[open]')) $('funding-dialog').showModal();
}
$('funding-close').addEventListener('click', () => $('funding-dialog').close());
function beginPairing() {
  if (walletReady) return;
  if (relay?.uri && !loadSession()?.paths?.length) showPairingUri(relay.uri).catch(report);
  else if (!relay && !pairingInProgress) $('connect').click();
}

$('funding-connect').addEventListener('click', () => {
  $('funding-dialog').close();
  openConnectionDialog();
  $('connect').focus({ preventScroll: true });
  if (pairingInProgress && !(relay?.uri && !loadSession()?.paths?.length)) openTutorial();
  else beginPairing();
});


const notificationsDialog = $('notifications-dialog');
for (const id of ['connection-dialog', 'wiki-dialog', 'funding-dialog', 'notifications-dialog']) {
  const dialog = $(id);
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}
function markNotificationsRead() {
  $('notification-indicator').hidden = true;
}
const gameNotificationIndicator = $('game-notification-indicator');
const syncGameNotificationIndicator = () => {
  gameNotificationIndicator.hidden = $('notification-indicator').hidden;
};
new MutationObserver(syncGameNotificationIndicator).observe($('notification-indicator'), { attributes: true, attributeFilter: ['hidden'] });
syncGameNotificationIndicator();
$('notifications-toggle').addEventListener('click', () => {
  if (!notificationsDialog.open) notificationsDialog.showModal();
  markNotificationsRead();
});
$('notifications-close').addEventListener('click', () => notificationsDialog.close());
notificationsDialog.addEventListener('close', () => {
  $('notifications-toggle').focus({ preventScroll: true });
});

let walletMiningReminderShown = false;
window.addEventListener('message', (event) => {
  if (event.source !== $('game-frame').contentWindow) return;
  if ($('game-dialog').open && event.data?.type === 'netcraft-user-gesture' &&
      notificationAudio?.state !== 'running') {
    unlockNotificationAudio();
  }
  if ($('game-dialog').open && $('game-frame').src.includes('/games/netcraft/') &&
      event.data?.type === 'netcraft-block-mined' && !walletReady && !walletMiningReminderShown) {
    walletMiningReminderShown = true;
    $('game-wallet-notice').hidden = false;
    $('notification-indicator').hidden = false;
  }
  if ($('game-dialog').open && $('game-frame').src.includes('/games/netcraft/') &&
      event.data?.type === 'netcraft-mina-reward' &&
      typeof event.data.address === 'string') {
    queueMinedRewardNotification(event.data.address);
  }
  if ($('game-dialog').open && $('game-frame').src.includes('/games/netcraft/') &&
      event.data?.type === 'netcraft-mina-reward-failed' &&
      typeof event.data.address === 'string') {
    reportMinedRewardFailure(event.data.address);
  }
});

let notificationAudio;
let nextNotificationSoundAt = 0;

function prepareNotificationAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) throw new Error('Audio is not supported.');
  if (!notificationAudio || notificationAudio.state === 'closed') {
    notificationAudio = new AudioContext();
    nextNotificationSoundAt = 0;
  }
  return notificationAudio;
}

function unlockNotificationAudio() {
  try {
    const audio = prepareNotificationAudio();
    const unlocked = () => {
      if (audio.state !== 'running') return;
      document.removeEventListener('pointerdown', unlockNotificationAudio);
      document.removeEventListener('keydown', unlockNotificationAudio);
    };
    if (audio.state === 'running') unlocked();
    else audio.resume().then(unlocked).catch((error) => logger.warn('Could not enable notification sound:', error));
  } catch (error) {
    logger.warn('Could not enable notification sound:', error);
  }
}

document.addEventListener('pointerdown', unlockNotificationAudio);
document.addEventListener('keydown', unlockNotificationAudio);

async function playNotificationSound(kind, count = 1) {
  try {
    const audio = prepareNotificationAudio();
    if (audio.state !== 'running') {
      let timeout;
      try {
        await Promise.race([
          audio.resume(),
          new Promise((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Audio playback requires a user gesture.')), 750);
          }),
        ]);
      } finally {
        clearTimeout(timeout);
      }
    }
    if (audio.state !== 'running') throw new Error('Audio playback requires a user gesture.');

    const start = Math.max(audio.currentTime, nextNotificationSoundAt);
    for (let receipt = 0; receipt < count; receipt++) {
      (kind === 'mining' ? [880, 1320, 1760] : [523, 659, 784]).forEach((frequency, index) => {
        const tone = audio.createOscillator();
        const volume = audio.createGain();
        const time = start + receipt * 0.4 + index * 0.09;
        tone.type = 'triangle';
        tone.frequency.value = frequency;
        volume.gain.setValueAtTime(0.15, time);
        volume.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
        tone.connect(volume);
        volume.connect(audio.destination);
        tone.start(time);
        tone.stop(time + 0.16);
      });
    }
    nextNotificationSoundAt = start + count * 0.4;
  } catch (error) {
    logger.warn('Notification sound unavailable:', error);
  }
}

function showMinaCelebration(count = 1) {
  void playNotificationSound('receipt', count);
}

$('view-payment-request').addEventListener('click', () => {
  notificationsDialog.close();
  if (!walletReady) {
    openConnectionDialog();
    $('connect').focus({ preventScroll: true });
    return;
  }
  setTransferTab('send');
  $('transfer-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', fillFromUrl);
} else {
  fillFromUrl();
}
$('category-select').addEventListener('change', () => {
  if (!$('category').readOnly) $('category').value = $('category-select').value;
  refreshCategoryIcon('category');
  updateAmountHelp();
});
$('category').addEventListener('input', () => {
  const value = $('category').value.trim().toLowerCase();
  $('category-select').value =
    [...$('category-select').options].some((option) => option.value === value)
      ? value
      : '';
  refreshCategoryIcon('category');
  updateAmountHelp();
});
$('amount').addEventListener('input', updateAmountHelp);

$('copy-address').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('address').textContent);
    $('copy-address').textContent = 'Copied';

    setTimeout(() => {
      $('copy-address').textContent = 'Copy';
    }, 1200);
  } catch (error) {
    report(error);
  }
});

$('copy-uri').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('pair-uri').textContent);
    $('copy-uri').textContent = 'Copied';

    setTimeout(() => {
      $('copy-uri').textContent = 'Copy';
    }, 1200);
  } catch (error) {
    report(error);
  }
});

function setTransferTab(tabName) {
  const isSend = tabName === 'send';
  transferInteracted = true;

  $('send-tab').classList.toggle('active', isSend);
  $('receive-tab').classList.toggle('active', !isSend);
  $('top-send').classList.toggle('active', isSend);
  $('top-receive').classList.toggle('active', !isSend);
  $('send-tab').setAttribute('aria-selected', String(isSend));
  $('receive-tab').setAttribute('aria-selected', String(!isSend));

  $('send-panel').hidden = !isSend;
  $('send-panel').classList.toggle('hidden', !isSend);
  $('receive-panel').hidden = isSend;
  $('receive-panel').classList.toggle('hidden', isSend);
}

function updateReceiveAddress() {
  if (!walletReady) return;

  const address = addressFor(0, 0, 'p2pkhWithTokens');
  if (!$('receive-address').value.trim() || $('receive-address').value === walletReceiveAddress) {
    $('receive-address').value = address;
    walletReceiveAddress = address;
  }
  $('copy-receive-address').disabled = false;
}

const shortLinkId = /^\/s\/([A-Za-z0-9_-]{8,32})\/?$/.exec(window.location.pathname)?.[1];
setTransferTab('send');

if (shortLinkId) {
  openShortLink(shortLinkId).then((link) => {
    const params = new URLSearchParams({ addr: link.address, category: link.category, amount: link.amount });
    // Replace the short path so reloading keeps the request after a one-time link is consumed.
    window.history.replaceState(null, '', `/?${params}`);
    fillFromUrl(params, link.note);
    setTransferTab('send');
  }).catch((error) => {
    report(new Error(translate(/unavailable/i.test(error.message)
      ? 'This payment link has expired or was already opened.'
      : error.message)));
  });
}

$('send-tab').addEventListener('click', () => setTransferTab('send'));
$('receive-tab').addEventListener('click', () => setTransferTab('receive'));
$('top-send').addEventListener('click', () => {
  setTransferTab('send');
  $('transfer-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!walletReady) showFundingDialog('Connect a compatible wallet before sending tokens.');
});
$('top-receive').addEventListener('click', () => {
  setTransferTab('receive');
  $('transfer-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
let craftingConfigPromise = null;
function loadCraftingConfig() {
  craftingConfigPromise ??= fetch(`${API_BASE_URL}/api/crafting`)
    .then((response) => {
      if (!response.ok) throw new Error(`Crafting API error (${response.status})`);
      return response.json();
    })
    .catch((error) => {
      craftingConfigPromise = null;
      throw error;
    });
  return craftingConfigPromise;
}
loadCraftingConfig().then(({ address }) => {
  $('game-crafting').hidden = !address;
  $('mining-prompt-craft').hidden = !address;
}).catch(() => {});
$('mining-prompt-craft').addEventListener('click', () => {
  $('mining-prompt').close();
  $('game-crafting').click();
});
$('game-crafting').addEventListener('click', async () => {
  try {
    const [{ address, returnCategory }, category] = await Promise.all([loadCraftingConfig(), loadRewardCategory()]);
    $('game-close').click();
    setTransferTab('send');
    for (const [id, value] of [['recipient', address], ['category', category], ['amount', '10']]) {
      $(id).value = value;
      $(id).dispatchEvent(new Event('input', { bubbles: true }));
    }
    $('crafting-note').textContent = translate('Review the 10 MINA transfer and crafting terms before approving. Returns depend on the crafting service.') +
      (returnCategory ? ` ${returnCategory}` : '');
    $('crafting-note').hidden = false;
    $('transfer-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!walletReady) showFundingDialog('Connect a compatible wallet before crafting.');
  } catch (error) {
    report(error);
  }
});
$('generate-payment').addEventListener('click', async () => {
  const generation = ++paymentGeneration;
  try {
    $('payment-result').classList.add('hidden');
    resetShortLink();
    const category = $('receive-category').value.trim().toLowerCase();
    const amount = $('receive-amount').value.trim();
    if (!/^[0-9a-f]{64}$/.test(category)) {
      $('payment-input-status').textContent = translate('Enter a token category ID with exactly 64 hexadecimal characters.');
      $('receive-category').focus();
      return;
    }
    if (!/^[1-9][0-9]*$/.test(amount)) {
      $('payment-input-status').textContent = translate('Enter a positive whole number of token base units.');
      $('receive-amount').focus();
      return;
    }
    $('payment-input-status').textContent = '';
    await loadWalletDependencies();
    const address = validateRecipient($('receive-address').value);

    // Keep the current site and path, replacing any existing query parameters.
    const paymentUrl = new URL(window.location.href);
    paymentUrl.search = '';
    paymentUrl.hash = '';
    paymentUrl.searchParams.set('addr', address);
    paymentUrl.searchParams.set('amount', amount);
    paymentUrl.searchParams.set('category', category);

    $('payment-url').textContent = paymentUrl.toString();

    const qr = document.createElement('canvas');
    await QRCode.toCanvas(qr, paymentUrl.toString(), {
      width: 512,
      margin: 4,
      errorCorrectionLevel: 'H',
      color: { dark: '#07111b', light: '#ffffff' },
    });
    const context = qr.getContext('2d');
    const center = qr.width / 2;
    const size = qr.width * 0.09;
    context.fillStyle = '#ffffff';
    context.fillRect(center - size / 2 - 4, center - size / 2 - 4, size + 8, size + 8);
    context.fillStyle = '#0879c9';
    context.fillRect(center - size * 0.1, center - size * 0.4, size * 0.2, size * 0.8);
    context.fillRect(center - size * 0.4, center - size * 0.1, size * 0.8, size * 0.2);
    for (const x of [-1, 1]) for (const y of [-1, 1]) {
      context.fillRect(center + x * size * 0.25 - size * 0.08, center + y * size * 0.25 - size * 0.08, size * 0.16, size * 0.16);
    }

    if (
      generation !== paymentGeneration ||
      $('receive-address').value.trim() !== address ||
      $('receive-category').value.trim().toLowerCase() !== category ||
      $('receive-amount').value.trim() !== amount
    ) return;

    const canvas = $('payment-qr');
    originalPaymentQr = qr;
    canvas.width = qr.width;
    canvas.height = qr.height;
    canvas.getContext('2d').drawImage(qr, 0, 0);
    $('payment-amount').textContent = `${amount} token base units`;
    $('payment-category').textContent = category;
    $('payment-token-icon').textContent = '◆';
    $('payment-logo-status').textContent = translate(mainnet ? 'Loading token logo…' : 'Token logo unavailable.');
    paymentPriceSnapshot = null;
    $('payment-price').textContent = translate('Loading Cauldron price…');
    $('share-payment-qr').disabled = false;
    $('download-payment-qr').disabled = false;
    $('payment-result').classList.remove('hidden');

    const currentPayment = () => generation === paymentGeneration &&
      !$('payment-result').classList.contains('hidden') &&
      $('payment-url').textContent === paymentUrl.toString() &&
      $('receive-address').value.trim() === address;
    const metadata = mainnet ? fetchTokenMetadata(category).catch((error) => {
      logger.warn(`Token metadata unavailable for ${category}:`, error);
      return category === PUSD_CATEGORY ? { decimals: 2, symbol: 'PUSD' } : null;
    }) : Promise.resolve(null);
    Promise.all([fetchCauldronSpot(category, network), metadata]).then(([spot, token]) => {
      if (!Number.isFinite(spot) || spot <= 0) throw new Error('Invalid Cauldron spot price.');
      if (!currentPayment()) return;
      const timestamp = new Date().toISOString();
      paymentPriceSnapshot = { spot, timestamp, decimals: token?.decimals, symbol: token?.symbol };
      $('payment-price').textContent = `${translate('Indicative token price')}: ${formatPaymentPrice()}`;
    }).catch((error) => {
      logger.warn(`Cauldron price unavailable for ${category}:`, error);
      if (currentPayment()) $('payment-price').textContent = translate('Cauldron price unavailable.');
    });

    if (mainnet) {
      loadTokenLogo(category, { requireCors: true }).then((logo) => {
        if (!currentPayment()) return;
        const size = canvas.width * 0.09;
        const start = (canvas.width - size) / 2;
        for (const target of [canvas, qr]) {
          const context = target.getContext('2d');
          context.fillStyle = '#ffffff';
          context.fillRect(start - 4, start - 4, size + 8, size + 8);
          context.drawImage(logo, start, start, size, size);
        }
        const image = logo.cloneNode();
        image.alt = '';
        $('payment-token-icon').replaceChildren(image);
        $('payment-logo-status').textContent = '';
      }).catch((error) => {
        logger.warn(`Token logo unavailable for ${category}:`, error);
        if (currentPayment()) $('payment-logo-status').textContent = translate('Token logo unavailable.');
      });
    }
  } catch (error) {
    report(error);
  }
});

let originalPaymentQr = null;
let shortLinkGeneration = 0;
function resetShortLink() {
  shortLinkGeneration++;
  if (originalPaymentQr) $('payment-qr').getContext('2d').drawImage(originalPaymentQr, 0, 0);
  $('short-link-result').hidden = true;
  $('short-link-url').textContent = '';
  $('short-link-status').textContent = '';
}

$('short-link-type').addEventListener('change', () => {
  const oneTime = $('short-link-type').value === 'one-time';
  $('short-link-expiry').disabled = oneTime;
  $('one-time-expiry-hint').hidden = !oneTime;
  resetShortLink();
});
$('short-link-expiry').addEventListener('change', resetShortLink);

$('create-short-link').addEventListener('click', async () => {
  const button = $('create-short-link');
  const generation = ++shortLinkGeneration;
  const note = $('receive-note').value.trim();
  const oneTime = $('short-link-type').value === 'one-time';
  const expiresIn = oneTime ? '1w' : $('short-link-expiry').value;
  const sourceUrl = $('payment-url').textContent;
  button.disabled = true;
  if (originalPaymentQr) $('payment-qr').getContext('2d').drawImage(originalPaymentQr, 0, 0);
  $('short-link-result').hidden = true;
  $('short-link-status').textContent = translate('Creating short link…');
  try {
    const url = new URL(sourceUrl);
    const link = await createShortLink({
      address: url.searchParams.get('addr'),
      category: url.searchParams.get('category'),
      amount: url.searchParams.get('amount'),
      note,
      one_time: oneTime,
      expires_in: expiresIn,
    });
    if (generation !== shortLinkGeneration || $('payment-result').classList.contains('hidden')) return;
    if (typeof link.id !== 'string' || !/^[A-Za-z0-9_-]{8,32}$/.test(link.id) || link.one_time !== oneTime) {
      throw new Error('Invalid short link response.');
    }
    const shortUrl = `${url.origin}/s/${link.id}`;
    const qr = document.createElement('canvas');
    await QRCode.toCanvas(qr, shortUrl, {
      width: 512, margin: 4, errorCorrectionLevel: 'H',
      color: { dark: '#07111b', light: '#ffffff' },
    });
    if (generation !== shortLinkGeneration || $('payment-result').classList.contains('hidden')) return;
    const canvas = $('payment-qr');
    canvas.getContext('2d').drawImage(qr, 0, 0);
    const logo = $('payment-token-icon').querySelector('img');
    if (logo) {
      const size = canvas.width * 0.09;
      const start = (canvas.width - size) / 2;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ffffff';
      context.fillRect(start - 4, start - 4, size + 8, size + 8);
      context.drawImage(logo, start, start, size, size);
    }
    $('short-link-url').textContent = shortUrl;
    $('short-link-result').hidden = false;
    $('short-link-status').textContent = translate(link.one_time
      ? 'One-time link: it is deleted after the first time it is opened or after 1 week.'
      : 'Persistent link: it can be opened repeatedly until it is removed.');
  } catch (error) {
    if (generation === shortLinkGeneration) $('short-link-status').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('copy-short-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('short-link-url').textContent);
    $('copy-short-link').textContent = 'Copied';
    setTimeout(() => { $('copy-short-link').textContent = 'Copy link'; }, 1200);
  } catch (error) {
    report(error);
  }
});

$('receive-note').addEventListener('input', resetShortLink);

for (const id of ['receive-address', 'receive-category', 'receive-amount']) {
  $(id).addEventListener('input', () => {
    resetShortLink();
    paymentPriceSnapshot = null;
    $('payment-input-status').textContent = '';
    $('payment-result').classList.add('hidden');
    if (id === 'receive-address') {
      walletReceiveAddress = null;
      $('copy-receive-address').disabled = !$(id).value.trim();
    }
    if (id === 'receive-category') updateReceiveToken();
  });
}

$('copy-receive-address').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('receive-address').value.trim());
    $('copy-receive-address').textContent = 'Copied';

    setTimeout(() => {
      $('copy-receive-address').textContent = 'Copy';
    }, 1200);
  } catch (error) {
    report(error);
  }
});

$('copy-payment-url').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('payment-url').textContent);
    $('copy-payment-url').textContent = 'Copied';

    setTimeout(() => {
      $('copy-payment-url').textContent = 'Copy original link';
    }, 1200);
  } catch (error) {
    report(error);
  }
});

function paymentQrImage() {
  const url = new URL($('payment-url').textContent);
  return createPaymentQrImage(
    $('payment-qr'),
    { amount: url.searchParams.get('amount'), category: url.searchParams.get('category'),
      address: url.searchParams.get('addr'), price: formatPaymentPrice(),
      note: $('receive-note').value.trim(), logo: $('payment-token-icon').querySelector('img') },
    translate,
  );
}

function formatPaymentPrice() {
  if (!paymentPriceSnapshot) return null;
  const { spot, timestamp, decimals, symbol } = paymentPriceSnapshot;
  const usd = Number.isFinite(bchUsd) && bchUsd > 0 && Number.isInteger(decimals)
    ? `≈ $${(spot * 10 ** decimals * bchUsd).toPrecision(4)} USD / 1 ${symbol || translate('token')}`
    : translate('USD price per token unavailable');
  return `${usd} · ${spot.toPrecision(4)} BCH / ${translate('base unit')} · ${timestamp}`;
}

$('download-payment-qr').addEventListener('click', () => {
  try {
    const link = document.createElement('a');
    link.download = 'cashtoken-payment-qr.png';
    link.href = paymentQrImage().toDataURL('image/png');
    link.click();
  } catch (error) {
    report(error);
  }
});

$('share-payment-qr').addEventListener('click', async () => {
  try {
    const paymentUrl = new URL($('payment-url').textContent);
    const url = $('short-link-result').hidden ? paymentUrl.toString() : $('short-link-url').textContent;
    const note = $('receive-note').value.trim();
    const text = `${translate('Amount')}: ${translate(`${paymentUrl.searchParams.get('amount')} token base units`)}\n` +
      `${translate('Recipient address')}: ${paymentUrl.searchParams.get('addr')}` +
      (paymentPriceSnapshot ? `\n${translate('Indicative token price')}: ${formatPaymentPrice()}` : '') +
      (note ? `\n${translate('Sharing note')}: ${note}` : '');
    if (!navigator.share) {
      await navigator.clipboard.writeText(`${text}\n${url}`);
      $('share-payment-qr').querySelector('span').textContent = 'Copied';
      setTimeout(() => { $('share-payment-qr').querySelector('span').textContent = 'Share'; }, 1200);
      return;
    }
    const encoded = paymentQrImage().toDataURL('image/png').split(',')[1];
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const file = new File([bytes], 'cashtoken-payment-qr.png', { type: 'image/png' });
    const data = { title: 'CTF Cash', url, text };
    if (navigator.canShare?.({ files: [file] })) data.files = [file];
    await navigator.share(data);
  } catch (error) {
    if (error.name !== 'AbortError') report(error);
  }
});

const tutorialSteps = [
  {
    id: 'connection-section',
    title: 'Connect your wallet',
    message: 'Create or restore an encrypted browser wallet, or pair an existing wallet with WizardConnect. Back up your recovery phrase privately.',
  },
  {
    id: 'balance-section',
    title: 'Check your balance',
    message: 'Your BCH balance and first receive address appear here after connecting.',
  },
  {
    id: 'earn-section',
    title: 'Explore your portfolio',
    message: 'Your fungible token balances and category IDs appear here after the wallet scan.',
  },
  {
    id: 'transfer-section',
    title: 'Crafting table',
    message: 'Select a token to send, or switch to Receive to create a payment QR. Amounts are whole base units; review every transaction in your wallet.',
  },
  {
    id: 'games-toggle',
    title: 'Play CashCraft',
    message: 'Open the game menu to launch CashCraft. Use the gem in the game to see your wallet and rewards, and Ranking to compare mining rewards.',
  },
];
let tutorialStep = 0;

function showTutorialStep() {
  document.querySelectorAll('.tutorial-highlight').forEach((panel) => panel.classList.remove('tutorial-highlight'));
  const step = tutorialSteps[tutorialStep];
  const panel = $(step.id);
  const dialog = $('wizard-dialog');
  const focused = dialog.contains(document.activeElement) ? document.activeElement : null;
  panel.classList.add('tutorial-highlight');
  if (tutorialStep === 0) openConnectionDialog();
  if (step.id === 'games-toggle') (panel.closest('.topbar') || panel.closest('.game-toolbar')).after(dialog);
  else panel.before(dialog);
  if (tutorialStep !== 0 && $('connection-dialog').open) $('connection-dialog').close();
  $('wizard-title').textContent = step.title;
  $('wizard-message').textContent = step.message;
  $('wallet-help').hidden = tutorialStep !== 0;
  $('wizard-progress').textContent = `${tutorialStep + 1} / ${tutorialSteps.length}`;
  $('wizard-prev').disabled = tutorialStep === 0;
  $('wizard-next').disabled = tutorialStep === 0 && $('balance-section').hidden;
  $('wizard-next').textContent = tutorialStep === tutorialSteps.length - 1 ? 'Done' : 'Next';
  if (focused) (focused.disabled ? $('wizard-next') : focused).focus({ preventScroll: true });
  requestAnimationFrame(() => {
    if (!dialog.hidden) dialog.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function closeTutorial() {
  const guide = document.querySelector('.wizard-guide');
  const focused = guide.contains(document.activeElement) || $('wizard-dialog').contains(document.activeElement);
  $('wizard-dialog').hidden = true;
  $('wizard-toggle').setAttribute('aria-expanded', 'false');
  guide.classList.remove('walking');
  document.querySelectorAll('.tutorial-highlight').forEach((panel) => panel.classList.remove('tutorial-highlight'));
  if (focused) ($('connection-dialog').open ? $('connection-close') : walletReady ? $('logout') : $('wizard-toggle')).focus({ preventScroll: true });
}

function openTutorial() {
  tutorialStep = walletReady ? 1 : 0;
  $('wizard-dialog').hidden = false;
  document.querySelector('.wizard-guide').classList.add('walking');
  $('wizard-toggle').setAttribute('aria-expanded', 'true');
  showTutorialStep();
}

$('wizard-toggle').addEventListener('click', () => {
  if (!$('wizard-dialog').hidden) {
    closeTutorial();
    return;
  }
  openTutorial();
});
$('wizard-prev').addEventListener('click', () => {
  if (tutorialStep > 0) {
    tutorialStep--;
    showTutorialStep();
  }
});
$('wizard-close').addEventListener('click', closeTutorial);
$('wizard-next').addEventListener('click', () => {
  if (tutorialStep === tutorialSteps.length - 1) {
    closeTutorial();
  } else {
    tutorialStep++;
    showTutorialStep();
  }
});


fetchBchUsd();

const restoreSession = async () => {
  try {
    const browserSession = sessionStorage.getItem(`cashcraft:browser-wallet-session:v1:${network}`);
    if (browserSession) {
      await connectBrowserWallet(null, () => !pairingInProgress && !walletReady, browserSession);
      return;
    }
    await loadWalletDependencies();
    const stored = loadSession();
    if (!pairingInProgress && !walletReady && stored?.walletPublicKey && stored?.paths?.length) {
      await startConnection({ restoring: true });
    }
  } catch (error) {
    logger.warn('Could not restore previous wallet session:', error);
    $('status').textContent = 'Wallet session could not be restored. Open the wallet dialog to reconnect.';
  }
};
void restoreSession();
const gameLink = new URLSearchParams(window.location.search).get('game');
if (gameLink === 'pk2' || gameLink === 'cashcraft') {
  $('game-dialog').classList.add('game-auto-open');
  $(gameLink === 'pk2' ? 'game-pk2' : 'game-netcraft').click();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      logger.warn('Could not register the offline page:', error);
    });
  });
}

document.querySelectorAll('.wallet-icon').forEach((image) => {
  const hideFailedImage = () => { image.hidden = true; };
  image.addEventListener('error', hideFailedImage, { once: true });
  if (image.complete && !image.naturalWidth) hideFailedImage();
});

function markReceiptNotificationsRead() {
  if (!walletReady) return;
  const state = readReceiptState();
  state.unread = false;
  localStorage.setItem(receiptStorageKey(), JSON.stringify(state));
}
$('notifications-toggle').addEventListener('click', markReceiptNotificationsRead);

setInterval(() => {
  if (!walletReady) return;
  if (!registeredRewardAddress && !addressRegistration) {
    const wallet = manager;
    Promise.resolve().then(() => {
      if (walletReady && manager === wallet) return registerRewardAddress(addressFor(0, 0), wallet);
    }).catch((error) => {
      if (walletReady && manager === wallet) {
        $('status').textContent = 'Wallet connected · address submission failed';
        report(error, { log: false });
      }
    });
  }
  if (refreshPromise) return;
  refreshBalances({ quiet: true }).catch((error) => {
    $('status').textContent = 'Automatic balance refresh failed · use Refresh balances to retry.';
    report(error, { log: false });
  });
}, 30_000);
