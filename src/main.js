import './style.css';
import { setLanguage, translate } from './i18n.js';
import { createPaymentQrImage } from './payment-qr-image.js';
import { setupScrollEffects } from './scroll-effects.js';
import { setupSnow } from './snow.js';
import { setupMesh } from './mesh.js';
import { setupPairingReminder } from './pairing-reminder.js';
import { fetchTokenMetadata, fetchCauldronSpot } from './portfolio-data.js';
import { loadTokenLogo } from './token-logo.js';
import { inspectNft } from './nft-inspection.js';
import { setupMarketTicker } from './market-ticker.js';
import { setupChainTicker } from './chain-ticker.js';
import { setupWikiGlossary } from './wiki-glossary.js';
import { setupGames } from './games.js';
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

const network = (import.meta.env.VITE_BCH_NETWORK || 'mainnet').toLowerCase();
const logger = createLogger(
  import.meta.env.VITE_CONSOLE_LOG_LEVEL || (import.meta.env.DEV ? 'debug' : 'error'),
);
setupScrollEffects();
setupSnow(document.getElementById('snow-canvas'));
setupMesh(document.querySelector('.mesh-terrain'));

for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
  document.querySelector(selector).content = new URL('/social-preview.png', window.location.origin).href;
}

if (!['mainnet', 'chipnet'].includes(network)) {
  throw new Error(
    `Unsupported VITE_BCH_NETWORK "${network}". Use "mainnet" or "chipnet".`,
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
}

const mainnet = network === 'mainnet';
const prefix = mainnet ? 'bitcoincash' : 'bchtest';
const $ = (id) => document.getElementById(id);
setupMarketTicker($('market-ticker'), translate, logger);
setupChainTicker($('chain-ticker'), logger);
setupMediaSlideshow($);
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
let pairingInProgress = false;
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
  if (!saved) return { seen: [], sent: [], messages: [], unread: false };
  const state = JSON.parse(saved);
  if (!Array.isArray(state.seen) || !Array.isArray(state.sent) || !Array.isArray(state.messages)) {
    throw new Error('Invalid saved token notification state.');
  }
  return state;
}

function addReceiptNotice() {
  const notice = document.createElement('div');
  notice.className = 'notification-message gamba-notice';
  const art = $('gamba-art').cloneNode(true);
  art.removeAttribute('id');
  const label = document.createElement('strong');
  const labelText = document.createElement('span');
  labelText.className = 'visually-hidden';
  labelText.textContent = '1 GAMBA TOKEN';
  const wordmark = document.createElement('img');
  wordmark.src = '/gamba-wordmark.svg';
  wordmark.alt = '';
  label.append(labelText, wordmark);
  const details = document.createElement('div');
  details.append(label);
  notice.append(art, details);
  $('token-receipt-notifications').prepend(notice);
  $('notifications-empty').hidden = true;
  $('gamba-sound-controls').hidden = false;
}

function rememberSentTransaction(txid) {
  const state = readReceiptState();
  state.sent.push(txid.toLowerCase());
  localStorage.setItem(receiptStorageKey(), JSON.stringify(state));
}

function notifyTokenReceipts(scannedUtxos) {
  const state = readReceiptState();
  const wallet = receiptStorageKey();
  const legacyMessage = 'Welcome! Your GAMBA token has arrived: enjoy your special diamond perk.';
  const message = 'Received 1 GAMBA';
  if (state.messages.includes(legacyMessage) || state.messages.includes(message)) {
    state.gambaNotified = true;
  }
  state.messages = state.gambaNotified ? [message] : [];
  const sent = new Set(state.sent);
  const received = !state.gambaNotified && scannedUtxos.some((utxo) =>
    utxo.token && !utxo.token.nft &&
    String(utxo.token.category).toLowerCase() === rewardCategory &&
    BigInt(utxo.token.amount || 0) === 1n &&
    !sent.has(utxo.txid.toLowerCase()),
  );
  if (received) {
    state.gambaNotified = true;
    state.messages = [message];
    state.unread = true;
  } else if (!state.messages.length && !state.beerNotified) {
    state.unread = false;
  }
  localStorage.setItem(wallet, JSON.stringify(state));

  if (receiptWallet !== wallet) {
    $('token-receipt-notifications').replaceChildren();
    $('gamba-sound-controls').hidden = true;
    if (state.messages.length) addReceiptNotice();
    if (state.beerNotified) addReceiptNotice();
    if (state.unread) $('notification-indicator').hidden = false;
    receiptWallet = wallet;
  } else if (received) {
    addReceiptNotice();
  }
  if (received) {
    $('notification-indicator').hidden = false;
    showGambaCelebration();
  }
}

function report(error, { log = true } = {}) {
  if (log) logger.error(error);
  $('log').classList.add('error');
  $('log').textContent = `Action failed: ${error?.message || String(error)}\nCheck the status above, your inputs and wallet connection before retrying.`;
}

const savedTheme = localStorage.getItem('ctf-theme');
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('ctf-theme', theme);
  document.querySelector('meta[name="theme-color"]').content = '#080a10';
  document.querySelectorAll('[data-theme-option]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.themeOption === theme));
  });
}
const migratedTheme = { dark: 'frost', blue: 'frost', green: 'aurora', bch: 'aurora', 'bch-sunrise': 'aurora' }[savedTheme] || savedTheme;
setTheme(['frost', 'aurora'].includes(migratedTheme) ? migratedTheme : 'aurora');

for (const name of ['theme', 'language']) {
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
    if (name === 'theme') setTheme(button.dataset.themeOption);
    else {
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

function setConnection(connected) {
  pairingReminder.cancel();
  if (!connected) $('connection-loading').hidden = true;
  document.querySelectorAll('[data-wallet-panel]').forEach((panel) => { panel.hidden = !connected; });
  $('advanced-settings').hidden = !connected;
  $('forget').hidden = !connected;
  $('disconnect').hidden = !connected;
  $('logout').hidden = !connected;
  if (!connected) {
    const gameDialog = $('game-dialog');
    if (gameDialog.open) gameDialog.close();
    $('game-status').textContent = '';
  }
  document.body.classList.toggle('wallet-connected', connected);
  $('network-wallet-status').textContent = translate(connected ? 'Wallet connected' : 'Not connected');
  if (!$('wizard-dialog').hidden) {
    if (connected) $('wizard-next').disabled = false;
    else {
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
}

function clearWalletDisplay() {
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
  $('token-count').textContent = '—';
  $('tokens').innerHTML =
    '<div class="empty">Connect a wallet to view token balances.</div>';
  $('portfolio-chart-content').textContent = translate('Connect a wallet to view allocation.');
  $('portfolio-chart').hidden = true;
  $('portfolio-chart').open = false;
  tokenBalances = new Map();
  receiptWallet = null;
  $('token-receipt-notifications').replaceChildren();
  $('gamba-sound-controls').hidden = true;
  $('gamba-sound-status').textContent = '';
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
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: '#07111b', light: '#ffffff' },
  });
  if (!walletReady && walletPairingUri === uri) pairingReminder.start();
  $('open-wallet').scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
}

async function startConnection({ fresh = false, restoring = false } = {}) {
  if (pairingInProgress || (walletReady && !fresh)) return;

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
        $('connection-loading').hidden = false;
        const submission = submitCashAddress(address).catch((error) => {
          if (walletReady && manager === connectionManager) {
            report(new Error(`Address submission failed: ${error?.message || error}`));
            $('status').textContent = 'Wallet connected · address submission failed';
          }
          throw error;
        });
        const [scanResult, submissionResult] = await Promise.allSettled([refreshBalances(), submission]);
        if (!walletReady || manager !== connectionManager) return;
        resumeBeerReward(address);
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
  if (!scanAddressRecords.length) {
    throw new Error('No wallet addresses are available to scan.');
  }

  const results = new Array(scanAddressRecords.length);
  const prefetchedLogos = new Map();
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= scanAddressRecords.length) return;

      const record = scanAddressRecords[index];
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

  const workerCount = Math.min(SCAN_CONCURRENCY, scanAddressRecords.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const foundUtxos = [];
  const seen = new Set();

  for (let i = 0; i < scanAddressRecords.length; i++) {
    const record = scanAddressRecords[i];

    for (const utxo of results[i]) {
      const key = utxoKey(utxo);

      if (key && seen.has(key)) continue;
      if (key) seen.add(key);

      foundUtxos.push(normalizeUtxo(utxo, record));
    }
  }

  return { addresses: scanAddressRecords, utxos: foundUtxos, prefetchedLogos };
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
      'No wallet handshake. Pair a compatible WizardConnect wallet first.',
    );
  }

  if (refreshPromise) return refreshPromise;

  const scanPromise = (async () => {
    const scanManager = manager;
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
      if (walletReady && manager === scanManager) notifyTokenReceipts(utxos);
    } catch (error) {
      receiptError = error;
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

  try {
    if (!walletReady) {
      throw new Error('Connect and approve the wallet handshake first.');
    }

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
      mainnet &&
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
      builder.addInput(
        utxo,
        placeholderP2PKHUnlocker(utxo.spendAddress),
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

    const signed = await manager.signTransaction(signingRequest);

    if (
      typeof signed?.signedTransaction !== 'string' ||
      signed.signedTransaction.length === 0
    ) {
      throw new Error(
        'Wallet rejected the transaction or did not return a signed transaction.',
      );
    }

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

async function endWalletSession() {
  const previousManager = manager;
  const previousRelay = relay;
  const wasReady = walletReady;
  manager = null;
  relay = null;
  walletReady = false;

  if (previousManager) {
    if (wasReady) {
      try {
        await Promise.race([
          previousManager.sendDisconnect(),
          wait(2000).then(() => { throw new Error('Wallet disconnect timed out.'); }),
        ]);
      } catch (error) {
        logger.warn('Could not notify wallet of disconnection:', error);
      }
    }
    previousManager.clearStoredSession();
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
  setConnection(false);
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
  if (!$('connection-dialog').open) $('connection-dialog').showModal();
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
setupWikiGlossary($('wiki-dialog'));

let beerPolling = null;
function beerKey(address) {
  return `ctf-beer-reward:${network}:${address.toLowerCase()}`;
}

function resumeBeerReward(address) {
  try {
    if (localStorage.getItem(beerKey(address)) === 'pending') void pollBeerReward(address);
  } catch (error) {
    $('game-status').textContent = error.message;
  }
}

async function pollBeerReward(address) {
  if (beerPolling === address || !walletReady || addressFor(0, 0) !== address) return;
  beerPolling = address;
  let retry = false;
  try {
    if (localStorage.getItem(beerKey(address)) !== 'pending') return;
    const response = await fetch(`${API_BASE_URL}/api/beer-reward`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cash_address: address }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 409) localStorage.removeItem(beerKey(address));
      throw new Error(translate(typeof data.detail === 'string' ? data.detail : `Reward request failed (${response.status}).`));
    }
    if (!walletReady || addressFor(0, 0) !== address) return;
    if (data.status === 'pending') {
      $('game-status').textContent = translate('Bonus queued. Waiting for the reward transaction…');
      retry = true;
      return;
    }
    if (data.status !== 'sent' || typeof data.txid !== 'string' || !/^[0-9a-f]{64}$/i.test(data.txid)) {
      throw new Error('Invalid reward response.');
    }
    const scan = await refreshBalances({ quiet: true });
    if (!walletReady || addressFor(0, 0) !== address) return;
    if (!scan.utxos.some((utxo) => utxo.txid?.toLowerCase() === data.txid.toLowerCase() &&
        utxo.token && !utxo.token.nft && String(utxo.token.category).toLowerCase() === rewardCategory &&
        BigInt(utxo.token.amount || 0) === 1n)) {
      $('game-status').textContent = translate('Bonus sent. Waiting for the wallet balance to update…');
      retry = true;
      return;
    }
    const state = readReceiptState();
    if (!state.beerNotified) {
      state.beerNotified = true;
      state.unread = true;
      localStorage.setItem(receiptStorageKey(), JSON.stringify(state));
      addReceiptNotice();
      $('notification-indicator').hidden = false;
      showGambaCelebration();
    }
    localStorage.setItem(beerKey(address), 'complete');
    $('game-status').textContent = translate('Your bonus GAMBA was sent.');
  } catch (error) {
    if (walletReady && addressFor(0, 0) === address) {
      $('game-status').textContent = error.message;
      try {
        retry = localStorage.getItem(beerKey(address)) === 'pending';
      } catch (storageError) {
        $('game-status').textContent = storageError.message;
      }
    }
  } finally {
    beerPolling = null;
    if (retry) setTimeout(() => { void pollBeerReward(address); }, 15000);
  }
}

function claimBeerReward() {
  try {
    if (!walletReady) {
      $('game-status').textContent = translate('Connect your wallet to claim the bonus.');
      return;
    }
    const address = addressFor(0, 0);
    if (localStorage.getItem(beerKey(address)) === 'complete') {
      $('game-status').textContent = translate('Your bonus GAMBA was already sent.');
      return;
    }
    localStorage.setItem(beerKey(address), 'pending');
    void pollBeerReward(address);
  } catch (error) {
    $('game-status').textContent = error.message;
  }
}

setupGames($, { claimBeer: claimBeerReward, translate });

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
for (const id of ['connection-dialog', 'wiki-dialog', 'funding-dialog', 'notifications-dialog', 'game-dialog']) {
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
$('notifications-toggle').addEventListener('click', () => {
  if (!notificationsDialog.open) notificationsDialog.showModal();
  markNotificationsRead();
});
$('notifications-close').addEventListener('click', () => notificationsDialog.close());
notificationsDialog.addEventListener('close', () => {
  markNotificationsRead();
  $('notifications-toggle').focus({ preventScroll: true });
});

let notificationAudio;

function prepareNotificationAudio() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) throw new Error('Audio is not supported.');
  if (!notificationAudio || notificationAudio.state === 'closed') notificationAudio = new AudioContext();
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

async function playGambaSound() {
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

    const start = audio.currentTime;
    [880, 1320, 1760].forEach((frequency, index) => {
      const tone = audio.createOscillator();
      const volume = audio.createGain();
      const time = start + index * 0.09;
      tone.type = 'triangle';
      tone.frequency.value = frequency;
      volume.gain.setValueAtTime(0.15, time);
      volume.gain.exponentialRampToValueAtTime(0.001, time + 0.16);
      tone.connect(volume);
      volume.connect(audio.destination);
      tone.start(time);
      tone.stop(time + 0.16);
    });
    $('gamba-sound-status').textContent = '';
  } catch (error) {
    logger.warn('Notification sound unavailable:', error);
    $('gamba-sound-status').textContent = translate('Sound unavailable. Tap Play sound to try again.');
  }
}

function showGambaCelebration() {
  if (!notificationsDialog.open) notificationsDialog.showModal();
  void playGambaSound();
}

$('gamba-sound').addEventListener('click', () => { void playGambaSound(); });

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
  updateAmountHelp();
});
$('category').addEventListener('input', () => {
  const value = $('category').value.trim().toLowerCase();
  $('category-select').value =
    [...$('category-select').options].some((option) => option.value === value)
      ? value
      : '';
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
const openedPaymentRequest = ['addr', 'category', 'amount'].every(
  (name) => new URLSearchParams(window.location.search).get(name)?.trim(),
) || Boolean(shortLinkId);
setTransferTab(openedPaymentRequest ? 'send' : 'receive');

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
$('generate-payment').addEventListener('click', async () => {
  const generation = ++paymentGeneration;
  try {
    $('payment-result').classList.add('hidden');
    resetShortLink();
    await loadWalletDependencies();
    const address = validateRecipient($('receive-address').value);
    const category = $('receive-category').value.trim().toLowerCase();
    const amount = $('receive-amount').value.trim();

    if (!/^[0-9a-f]{64}$/.test(category)) {
      throw new Error('Category ID must be exactly 64 hexadecimal characters.');
    }

    if (!/^[1-9][0-9]*$/.test(amount)) {
      throw new Error('Amount must be a positive whole number.');
    }

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
    fetchCauldronSpot(category, network).then((spot) => {
      if (!Number.isFinite(spot) || spot <= 0) throw new Error('Invalid Cauldron spot price.');
      if (!currentPayment()) return;
      const timestamp = new Date().toISOString();
      paymentPriceSnapshot = { spot, timestamp };
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
    $('payment-result').classList.add('hidden');
    if (id === 'receive-address') {
      walletReceiveAddress = null;
      $('copy-receive-address').disabled = !$(id).value.trim();
    }
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
  return `${paymentPriceSnapshot.spot.toPrecision(4)} BCH / ${translate('base unit')} · ${paymentPriceSnapshot.timestamp}`;
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
    message: 'Pair with WizardConnect using the QR code or open the pairing link in your wallet. Approve the connection there.',
  },
  {
    id: 'balance-section',
    title: 'Check your balance',
    message: 'Your BCH balance and first receive address appear here after connecting.',
  },
  {
    id: 'transfer-section',
    title: 'Send or receive',
    message: 'Select a token to send, or switch to Receive to create a payment QR. Amounts are whole base units; review every transaction in your wallet.',
  },
  {
    id: 'earn-section',
    title: 'Explore your portfolio',
    message: 'Your fungible token balances and category IDs appear here after the wallet scan.',
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
  panel.before(dialog);
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
  if (focused) ($('connection-dialog').open ? $('connection-close') : $('wizard-toggle')).focus({ preventScroll: true });
}

function openTutorial() {
  tutorialStep = 0;
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
    await loadWalletDependencies();
    const stored = loadSession();
    if (!pairingInProgress && !walletReady && stored?.walletPublicKey && stored?.paths?.length) {
      await startConnection({ restoring: true });
    }
  } catch (error) {
    logger.warn('Could not restore previous WizardConnect session:', error);
  }
};
void restoreSession();

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
  if (!walletReady || receiptWallet !== receiptStorageKey()) return;
  const state = readReceiptState();
  state.unread = false;
  localStorage.setItem(receiptStorageKey(), JSON.stringify(state));
}
$('notifications-toggle').addEventListener('click', markReceiptNotificationsRead);
notificationsDialog.addEventListener('close', markReceiptNotificationsRead);

setInterval(() => {
  if (!walletReady || refreshPromise) return;
  refreshBalances({ quiet: true }).catch((error) => {
    $('status').textContent = 'Automatic balance refresh failed · use Refresh balances to retry.';
    report(error, { log: false });
  });
}, 30_000);
