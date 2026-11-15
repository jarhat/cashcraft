import './style.css';
import { setLanguage, translate } from './i18n.js';
import { submitCashAddress, API_BASE_URL } from './api.js';
import { initScrollEffects } from './scroll-effects.js';
import { fetchTokenLogo, drawTokenLogo } from './payment-qr.js';
import {
  SATOSHIS_PER_BCH,
  formatBch,
  normalizeUtxo,
  utxoKey,
  wait,
} from './utils.js';

const network = (import.meta.env.VITE_BCH_NETWORK || 'mainnet').toLowerCase();
initScrollEffects();

for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
  document.querySelector(selector).content = new URL('/icon-512.png', window.location.origin).href;
}

if (!['mainnet', 'chipnet'].includes(network)) {
  throw new Error(
    `Unsupported VITE_BCH_NETWORK "${network}". Use "mainnet" or "chipnet".`,
  );
}

function fillFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const sharedLink = {
    address: params.get('addr'),
    category: params.get('category'),
    amount: params.get('amount'),
  };
  const note = params.get('note')?.trim() || '';

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
    document.title = title;
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

const ADDRESS_SCAN_COUNT = 50;
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
let showPairingWhenReady = false;
let sending = false;
let refreshPromise = null;
let addresses = [];
let scanAddressRecords = [];
let utxos = [];
let bchUsd = null;

function report(error) {
  console.error(error);
  $('log').textContent = error?.message || String(error);
}

const savedTheme = localStorage.getItem('ctf-theme');
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('ctf-theme', theme);
  document.querySelector('meta[name="theme-color"]').content = {
    dark: '#080a10', blue: '#071528', green: '#071b15',
  }[theme];
  document.querySelectorAll('[data-theme-option]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.themeOption === theme));
  });
}
const migratedTheme = { bch: 'green', 'bch-sunrise': 'green' }[savedTheme] || savedTheme;
setTheme(['dark', 'blue', 'green'].includes(migratedTheme) ? migratedTheme : 'dark');

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
    else setLanguage(button.dataset.languageOption);
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
  $('dot').classList.toggle('online', connected);
  $('refresh').disabled = !connected;
  $('send').disabled = sending;
  $('copy-address').disabled = !connected;
  $('connect').disabled = connected || pairingInProgress;
}

function clearWalletDisplay() {
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
  $('category-select').replaceChildren(new Option('Enter a category ID manually', ''));
  $('category-select').disabled = true;
  $('receive-address').textContent = 'Connect wallet to load your address';
  $('generate-payment').disabled = true;
  $('copy-receive-address').disabled = true;
  $('payment-result').classList.add('hidden');
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

  for (const [pathName, pathIndex] of [
    ['receive', 0],
    ['change', 1],
  ]) {
    for (let index = 0; index < ADDRESS_SCAN_COUNT; index++) {
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
  $('open-wallet').href = uri;
  $('pairing').classList.remove('hidden');

  await QRCode.toCanvas($('qr'), uri, {
    width: 190,
    margin: 0,
    errorCorrectionLevel: 'M',
    color: { dark: '#07111b', light: '#ffffff' },
  });
}

async function startConnection({ fresh = false, restoring = false } = {}) {
  if (pairingInProgress || (walletReady && !fresh)) return;

  pairingInProgress = true;
  $('connect').disabled = true;
  $('log').textContent = '';
  walletReady = false;
  clearWalletDisplay();
  $('pairing').classList.add('hidden');
  $('open-wallet').removeAttribute('href');
  setConnection(false);

  try {
    await loadWalletDependencies();
    if (relay) {
      try {
        relay.cleanup();
      } catch {
        // Cleanup is best-effort.
      }
      relay = null;
    }

    const stored = fresh ? null : loadSession();

    if (fresh && manager) {
      manager.clearStoredSession();
    }

    $('status').textContent = restoring
      ? 'Restoring saved WizardConnect session…'
      : fresh
        ? 'Starting a new WizardConnect pairing…'
        : stored?.walletPublicKey
          ? 'Reconnecting saved WizardConnect session…'
          : 'Starting WizardConnect pairing…';

    manager = new DappConnectionManager('CTF CashTokens');

    manager.on('walletready', async (message) => {
      const sessionManager = manager;
      walletReady = true;
      updateReceiveAddress();
      setConnection(true);
      $('pairing').classList.add('hidden');
      $('status').textContent =
        `Wallet handshake complete · ${
          message?.wallet_name || manager.walletName || 'connected'
        }`;
      $('log').textContent = '';

      try {
        scanAddressRecords = deriveScanAddresses();
        addresses = scanAddressRecords;
        $('address').textContent = addressFor(0, 0);
        let addressSubmissionError;
        try {
          await submitCashAddress(addressFor(0, 0));
        } catch (error) {
          addressSubmissionError = error;
          console.error('Could not submit the wallet address:', error);
        }
        await refreshBalances();
        if (addressSubmissionError) {
          report(addressSubmissionError);
          $('status').textContent =
            'Wallet connected · balances refreshed; address submission failed';
        }
      } catch (error) {
        if (!walletReady || manager !== sessionManager) return;
        report(error);
        $('status').textContent = 'Wallet connected · balance scan failed';
      }
    });

    manager.on('disconnect', (reason, message) => {
      walletReady = false;
      setConnection(false);
      clearWalletDisplay();
      $('pairing').classList.add('hidden');
      $('open-wallet').removeAttribute('href');
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
    });

    manager.on('messagesent', (message) => {
      console.info(
        '[WizardConnect] sent:',
        message?.action || 'protocol message',
      );
    });

    manager.on('messagereceived', (message) => {
      console.info(
        '[WizardConnect] received:',
        message?.action || 'protocol message',
      );
    });

    const callback = (payload) => {
      console.info(
        '[WizardConnect relay]',
        payload?.status?.status || payload?.status || payload,
      );

      try {
        if (!payload?.client || !payload?.status) {
          throw new Error('WizardConnect relay returned an incomplete payload.');
        }

        manager.updateConnection(payload.client, payload.status);
      } catch (error) {
        report(error);
        $('status').textContent = 'Relay update failed · see details below';
        return;
      }

      if (payload?.status?.status === 'connected' && !walletReady) {
        $('status').textContent =
          'Relay connected · waiting for wallet_ready handshake…';
      } else if (payload?.status?.status === 'error') {
        $('status').textContent = 'Relay error · see details below';
        $('log').textContent = JSON.stringify(payload.status);
      }
    };

    relay =
      stored?.walletPublicKey && !fresh
        ? initiateDappRelay(callback, { existingCredentials: stored })
        : initiateDappRelay(callback);

    manager.attachRelay(relay);

    if ((!restoring || showPairingWhenReady) && !walletReady) {
      await showPairingUri(relay.uri);

      if (!walletReady) {
        $('status').textContent =
          'Scan the QR in your BCH wallet and approve the pairing.';
      }
    } else {
      $('pairing').classList.add('hidden');
    }
  } catch (error) {
    $('status').textContent = 'Could not start WizardConnect';
    report(error);
    if (relay) {
      try {
        relay.cleanup();
      } catch (cleanupError) {
        console.warn('Could not clean up the relay:', cleanupError);
      }
      relay = null;
    }
    $('connect').disabled = false;
  } finally {
    pairingInProgress = false;
    showPairingWhenReady = false;
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
    }
  } catch (error) {
    console.warn('BCH/USD price unavailable:', error);
  }
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
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;
      if (index >= scanAddressRecords.length) return;

      const record = scanAddressRecords[index];
      results[index] = await fetchAddressUtxosWithRetry(record);
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

  return { addresses: scanAddressRecords, utxos: foundUtxos };
}

function renderBalances(scannedUtxos) {
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

  for (const utxo of scannedUtxos) {
    if (!utxo.token || utxo.token.nft || utxo.token.amount == null) continue;

    const amount = BigInt(utxo.token.amount);
    if (amount <= 0n) continue;

    const category = String(utxo.token.category).toLowerCase();
    balances.set(category, (balances.get(category) || 0n) + amount);
  }

  $('token-count').textContent =
    `${balances.size} fungible-token ${
      balances.size === 1 ? 'category' : 'categories'
    }`;

  const selector = $('category-select');
  const selectedCategory = $('category').value.trim().toLowerCase();
  selector.replaceChildren(new Option('Enter a category ID manually', ''));
  for (const [category, amount] of balances) {
    selector.add(new Option(`${category} (${amount} base units)`, category));
  }
  selector.value = balances.has(selectedCategory) ? selectedCategory : '';
  selector.disabled = !walletReady || $('category').readOnly || balances.size === 0;

  const tokens = $('tokens');
  tokens.replaceChildren();

  if (balances.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent =
      'No fungible-token balances found in the scanned addresses.';
    tokens.append(empty);
    return;
  }

  for (const [category, amount] of balances.entries()) {
    const row = document.createElement('div');
    row.className = 'token-row';

    const summary = document.createElement('div');
    summary.className = 'token-summary';
    const icon = document.createElement('span');
    icon.className = 'token-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '◆';
    const details = document.createElement('div');
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
    categoryLine.append(categoryElement, copyCategory);
    details.append(title, categoryLine);

    const amountElement = document.createElement('span');
    amountElement.className = 'token-amount';
    amountElement.textContent = `${amount} base units`;
    summary.append(icon, details, amountElement);
    row.append(summary);
    tokens.append(row);
  }
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

    const scanned = await scanWallet();

    if (!walletReady || manager !== scanManager) {
      throw new Error('Wallet disconnected during the balance scan.');
    }

    addresses = scanned.addresses;
    utxos = scanned.utxos;
    renderBalances(utxos);

    $('status').textContent = 'Wallet connected · balances refreshed';

    if (!quiet) {
      $('log').textContent = '';
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
  for (const delay of [1500, 3000]) {
    if (delay > 0) await wait(delay);

    try {
      await refreshBalances({ quiet: true });
      $('status').textContent =
        'Transaction broadcast · balances rescanned; indexing may lag';
      return;
    } catch (error) {
      console.warn('Balance refresh after broadcast failed:', error);
    }
  }

  $('status').textContent =
    'Transaction broadcast · balance scan failed; network indexing may lag';
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

    console.info('[WizardConnect signing request]', {
      inputCount: transactionInputCount,
      sourceOutputCount: relayTransaction.sourceOutputs.length,
      inputPaths,
      transactionHex: relayTransaction.transaction,
    });

    $('status').textContent =
      'Transaction built · waiting for wallet review and approval…';

    let signed;

    try {
      signed = await manager.signTransaction(signingRequest);
    } catch (error) {
      console.error('WizardConnect rejected the signing request', {
        message: error?.message,
        inputCount: transactionInputCount,
        sourceOutputCount: relayTransaction.sourceOutputs.length,
        inputPaths,
        outpoints: inputs.map((utxo) => `${utxo.txid}:${utxo.vout}`),
      });

      throw error;
    }

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

    $('log').textContent = `Transaction ID: ${txid}`;
    $('status').textContent =
      'Transaction broadcast · checking balances…';

    await refreshAfterApproval();

    try {
      const response = await fetch(`${API_BASE_URL}/api/tx-proof`, {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({
	  cash_address: addressFor(0,0),
	  txid: txid,
	  signed_transaction: signed.signedTransaction,
	}),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.detail?.message ?? data.detail ?? "Submission failed");

      console.log("Submitted BCH txid:", txid);
    } catch (error) {
      console.error('Could not send tx proof.');

      throw error;
    }
  } catch (error) {
    report(error);
    $('status').textContent = 'Transaction was not completed';
  } finally {
    sending = false;
    setConnection(walletReady);
  }
}

$('connect').addEventListener('click', () => startConnection());

$('forget').addEventListener('click', async () => {
  if (
    !window.confirm(
      translate('Forget this saved pairing and create a new WizardConnect session?'),
    )
  ) {
    return;
  }

  try {
    if (manager) {
      manager.clearStoredSession();
    }

    try {
      relay?.cleanup();
    } catch {
      // Cleanup is best-effort.
    }

    manager = null;
    relay = null;
    walletReady = false;

    $('pairing').classList.add('hidden');
    clearWalletDisplay();
    $('status').textContent = 'Saved session cleared';

    await startConnection({ fresh: true });
  } catch (error) {
    report(error);
  }
});

$('refresh').addEventListener('click', () => {
  refreshBalances().catch((error) => {
    report(error);
    $('status').textContent =
      'Balance refresh failed · previous balances retained';
  });
});

$('send').addEventListener('click', () => {
  if (walletReady) {
    sendFungibleTokens();
    return;
  }
  $('connection-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('connect').focus({ preventScroll: true });
  if ($('pairing').classList.contains('hidden')) {
    if (relay?.uri) {
      showPairingUri(relay.uri).catch(report);
    } else if (pairingInProgress) {
      showPairingWhenReady = true;
    } else if (!pairingInProgress) {
      startConnection();
    }
  }
});

const notificationsDialog = $('notifications-dialog');
function markNotificationsRead() {
  $('notification-indicator').hidden = true;
}
$('notifications-toggle').addEventListener('click', () => {
  if (!notificationsDialog.open) notificationsDialog.showModal();
  markNotificationsRead();
});
$('notifications-close').addEventListener('click', () => notificationsDialog.close());
notificationsDialog.addEventListener('click', (event) => {
  const rect = notificationsDialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right ||
      event.clientY < rect.top || event.clientY > rect.bottom) notificationsDialog.close();
});
notificationsDialog.addEventListener('close', () => {
  markNotificationsRead();
  $('notifications-toggle').focus({ preventScroll: true });
});
$('view-payment-request').addEventListener('click', () => {
  notificationsDialog.close();
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
});
$('category').addEventListener('input', () => {
  const value = $('category').value.trim().toLowerCase();
  $('category-select').value =
    [...$('category-select').options].some((option) => option.value === value)
      ? value
      : '';
});

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

  $('send-tab').classList.toggle('active', isSend);
  $('receive-tab').classList.toggle('active', !isSend);
  $('top-send').classList.toggle('active', isSend);
  $('top-receive').classList.toggle('active', !isSend);
  $('top-earn').classList.remove('active');
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
  $('receive-address').textContent = address;
  $('generate-payment').disabled = false;
  $('copy-receive-address').disabled = false;
}

$('send-tab').addEventListener('click', () => setTransferTab('send'));
$('receive-tab').addEventListener('click', () => setTransferTab('receive'));
$('top-send').addEventListener('click', () => {
  setTransferTab('send');
  $('transfer-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('top-receive').addEventListener('click', () => {
  setTransferTab('receive');
  $('transfer-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('top-earn').addEventListener('click', () => {
  $('top-send').classList.remove('active');
  $('top-receive').classList.remove('active');
  $('top-earn').classList.add('active');
  $('earn-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

let paymentGeneration = 0;
$('generate-payment').addEventListener('click', async () => {
  try {
    const generation = ++paymentGeneration;
    if (!walletReady) {
      throw new Error('Connect your wallet before creating a payment QR.');
    }

    const address = addressFor(0, 0, 'p2pkhWithTokens');
    const category = $('receive-category').value.trim().toLowerCase();
    const amount = $('receive-amount').value.trim();
    const note = $('receive-note').value.trim();

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
    if (note) paymentUrl.searchParams.set('note', note);

    const qr = document.createElement('canvas');
    await QRCode.toCanvas(qr, paymentUrl.toString(), {
      width: 512,
      margin: 4,
      errorCorrectionLevel: 'H',
      color: { dark: '#ffffff', light: '#000000' },
    });

    let logoStatus = mainnet ? 'No token logo found in the BCMR index.' : 'Token logos are available on mainnet only.';
    if (mainnet) {
      try {
        const logo = await fetchTokenLogo(category);
        if (logo) {
          await drawTokenLogo(qr, logo);
          logoStatus = 'Token logo from the BCMR index (not independently verified).';
        }
      } catch (error) {
        console.warn('Could not load the BCMR token logo:', error);
        logoStatus = 'Token logo unavailable; the QR code is still ready.';
      }
    }

    if (
      generation !== paymentGeneration || !walletReady ||
      addressFor(0, 0, 'p2pkhWithTokens') !== address ||
      $('receive-category').value.trim().toLowerCase() !== category ||
      $('receive-amount').value.trim() !== amount ||
      $('receive-note').value.trim() !== note
    ) return;

    $('receive-address').textContent = address;
    $('payment-url').textContent = paymentUrl.toString();
    const canvas = $('payment-qr');
    canvas.width = qr.width;
    canvas.height = qr.height;
    canvas.getContext('2d').drawImage(qr, 0, 0);
    $('payment-amount').textContent = `${amount} token base units`;
    $('payment-category').textContent = category;
    $('payment-note').textContent = note;
    $('payment-note').hidden = !note;
    $('payment-logo-status').textContent = translate(logoStatus);
    $('payment-result').classList.remove('hidden');
  } catch (error) {
    report(error);
  }
});

for (const id of ['receive-category', 'receive-amount', 'receive-note']) {
  $(id).addEventListener('input', () => {
    paymentGeneration++;
    $('payment-result').classList.add('hidden');
  });
}

$('copy-receive-address').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('receive-address').textContent);
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
      $('copy-payment-url').textContent = 'Copy link';
    }, 1200);
  } catch (error) {
    report(error);
  }
});

$('download-payment-qr').addEventListener('click', () => {
  try {
    const link = document.createElement('a');
    link.download = 'cashtoken-payment-qr.png';
    link.href = $('payment-qr').toDataURL('image/png');
    link.click();
  } catch (error) {
    report(error);
  }
});

$('share-payment-qr').addEventListener('click', async () => {
  try {
    const url = $('payment-url').textContent;
    if (!navigator.share) {
      await navigator.clipboard.writeText(url);
      $('share-payment-qr').querySelector('span').textContent = 'Copied';
      setTimeout(() => { $('share-payment-qr').querySelector('span').textContent = 'Share QR'; }, 1200);
      return;
    }
    const encoded = $('payment-qr').toDataURL('image/png').split(',')[1];
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const file = new File([bytes], 'cashtoken-payment-qr.png', { type: 'image/png' });
    const data = { title: 'CTF Cash', url };
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
  const guide = document.querySelector('.wizard-guide');
  const focused = guide.contains(document.activeElement) ? document.activeElement : null;
  (step.id === 'connection-section' ? panel.parentElement : panel).before(guide);
  focused?.focus({ preventScroll: true });
  panel.classList.add('tutorial-highlight');
  $('wizard-title').textContent = step.title;
  $('wizard-message').textContent = step.message;
  $('wizard-progress').textContent = `${tutorialStep + 1} / ${tutorialSteps.length}`;
  $('wizard-prev').disabled = tutorialStep === 0;
  $('wizard-next').textContent = tutorialStep === tutorialSteps.length - 1 ? 'Done' : 'Next';
  guide.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeTutorial() {
  const guide = document.querySelector('.wizard-guide');
  const focused = guide.contains(document.activeElement);
  $('wizard-dialog').hidden = true;
  $('wizard-toggle').setAttribute('aria-expanded', 'false');
  guide.classList.remove('walking');
  document.querySelectorAll('.tutorial-highlight').forEach((panel) => panel.classList.remove('tutorial-highlight'));
  document.querySelector('.hero').after(guide);
  if (focused) $('wizard-toggle').focus({ preventScroll: true });
}

$('wizard-toggle').addEventListener('click', () => {
  if (!$('wizard-dialog').hidden) {
    closeTutorial();
    return;
  }
  tutorialStep = 0;
  $('wizard-dialog').hidden = false;
  document.querySelector('.wizard-guide').classList.add('walking');
  $('wizard-toggle').setAttribute('aria-expanded', 'true');
  showTutorialStep();
});
$('wizard-prev').addEventListener('click', () => {
  if (tutorialStep > 0) {
    tutorialStep--;
    showTutorialStep();
  }
});
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
    if (!pairingInProgress && !walletReady && loadSession()?.walletPublicKey) {
      await startConnection({ restoring: true });
    }
  } catch (error) {
    console.warn('Could not restore previous WizardConnect session:', error);
  }
};
if ('requestIdleCallback' in window) {
  window.requestIdleCallback(restoreSession, { timeout: 3000 });
} else {
  setTimeout(restoreSession, 1000);
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('Could not register the offline page:', error);
    });
  });
}
