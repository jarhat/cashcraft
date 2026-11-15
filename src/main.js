import './style.css';
import QRCode from 'qrcode';
import {
  decodeCashAddress,
  encodeCashAddress,
} from '@bitauth/libauth';
import { hash160 } from '@cashscript/utils';
import { initiateDappRelay } from '@wizardconnect/core';
import { DappConnectionManager, loadSession } from '@wizardconnect/dapp';
import {
  sourceOutputToRelay,
  transactionToHex,
} from '@wizardconnect/core/hdwalletv1-serialize';
import {
  ElectrumNetworkProvider,
  TransactionBuilder,
  placeholderP2PKHUnlocker,
} from 'cashscript';

const network = (import.meta.env.VITE_BCH_NETWORK || 'chipnet').toLowerCase();

if (!['mainnet', 'chipnet'].includes(network)) {
  throw new Error(
    `Unsupported VITE_BCH_NETWORK "${network}". Use "mainnet" or "chipnet".`,
  );
}

const params = new URLSearchParams(window.location.search);

const value = params.get("category");     // first value, or null
const allValues = params.getAll("addr"); // all values for repeated keys
const hasParam = params.has("amount");

console.log(value)
console.log(allValues)
console.log(hasParam)

function fillFromUrl() {
  const params = new URLSearchParams(window.location.search);

  const fields = [
    ["addr", "recipient"],
    ["category", "category"],
    ["amount", "amount"]
  ];

  for (const [paramName, inputId] of fields) {
    const input = document.getElementById(inputId);
    const value = params.get(paramName);

    if (value !== null && value.trim() !== "") {
      input.value = value;
      input.readOnly = true;
    } else {
      input.readOnly = false;
    }
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", fillFromUrl);
} else {
  fillFromUrl();
}

const mainnet = network === 'mainnet';
const prefix = mainnet ? 'bitcoincash' : 'bchtest';
const provider = new ElectrumNetworkProvider(mainnet ? 'mainnet' : 'chipnet');
const $ = (id) => document.getElementById(id);

const ADDRESS_SCAN_COUNT = 50;
const SCAN_CONCURRENCY = 8;
const SCAN_RETRY_DELAYS_MS = [300, 700, 1500];
const SATOSHIS_PER_BCH = 100_000_000n;
const MAXIMUM_FEE_SATOSHIS = 10_000n;
const FEE_RESERVE_SATOSHIS = 10_000n;
const TOKEN_OUTPUT_SATOSHIS = 1_000n;

$('network').textContent = network.toUpperCase();

let manager = null;
let relay = null;
let walletReady = false;
let pairingInProgress = false;
let sending = false;
let refreshPromise = null;
let addresses = [];
let scanAddressRecords = [];
let utxos = [];
let bchUsd = null;

const API_BASE_URL = "https://auth.ctf.cash";

async function submitCashAddress(cashAddress) {
  if (typeof cashAddress !== "string" || !cashAddress.trim()) {
    throw new TypeError("A cash address is required.");
  }

  console.log(cashAddress.trim())

  const response = await fetch(`${API_BASE_URL}/api/cash-address`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      cash_address: cashAddress.trim(),
    }),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      result.detail ?? `Address API error (${response.status})`,
    );
  }
  return result.cash_address;
}


function report(error) {
  console.error(error);
  $('log').textContent = error?.message || String(error);
}

function setConnection(connected) {
  $('dot').classList.toggle('online', connected);
  $('refresh').disabled = !connected;
  $('send').disabled = !connected || sending;
  $('copy-address').disabled = !connected;
  $('connect').disabled = connected || pairingInProgress;
}

function clearWalletDisplay() {
  addresses = [];
  scanAddressRecords = [];
  utxos = [];
  $('address').textContent = 'Connect wallet to derive address';
  $('bch').innerHTML = `— <small>BCH</small>`;
  $('usd').textContent = 'USD value unavailable';
  $('token-count').textContent = '—';
  $('tokens').innerHTML =
    '<div class="empty">Connect a wallet to view token balances.</div>';
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

function formatBch(satoshis) {
  const whole = satoshis / SATOSHIS_PER_BCH;
  const fraction = (satoshis % SATOSHIS_PER_BCH)
    .toString()
    .padStart(8, '0');

  return `${whole.toString()}.${fraction}`;
}

function utxoKey(utxo) {
  const txid = utxo.txid ?? utxo.txHash;
  const outputIndex = utxo.vout ?? utxo.outputIndex ?? utxo.index;

  if (txid == null || outputIndex == null) return null;
  return `${String(txid).toLowerCase()}:${outputIndex}`;
}

function normalizeUtxo(utxo, record) {
  const txid = String(utxo.txid ?? utxo.txHash ?? '').toLowerCase();
  const vout = Number(utxo.vout ?? utxo.outputIndex ?? utxo.index);

  if (!/^[0-9a-f]{64}$/.test(txid)) {
    throw new Error(
      `Invalid transaction ID for ${record.pathName}/${record.index}.`,
    );
  }

  if (!Number.isSafeInteger(vout) || vout < 0) {
    throw new Error(
      `Invalid output index for ${record.pathName}/${record.index}.`,
    );
  }

  let satoshis;

  try {
    satoshis = BigInt(utxo.satoshis);
  } catch {
    throw new Error(`Invalid satoshi value for ${txid}:${vout}.`);
  }

  if (satoshis <= 0n) {
    throw new Error(`Non-positive UTXO value for ${txid}:${vout}.`);
  }

  const normalized = {
    ...utxo,
    txid,
    vout,
    satoshis,
    pathName: record.pathName,
    pathIndex: record.pathIndex,
    addressIndex: record.index,
    spendAddress: record.spendAddress,
  };

  if (normalized.token?.amount != null) {
    try {
      normalized.token = {
        ...normalized.token,
        amount: BigInt(normalized.token.amount),
      };
    } catch {
      throw new Error(`Invalid token amount for ${txid}:${vout}.`);
    }
  }

  return normalized;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function showPairingUri(uri) {
  if (!uri) {
    throw new Error('WizardConnect did not return a pairing URI.');
  }

  $('pair-uri').textContent = uri;
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
  setConnection(false);

  try {
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
	const acceptedAddress = await submitCashAddress(addressFor(0,0));
        await refreshBalances();
      } catch (error) {
        report(error);
        $('status').textContent = 'Wallet connected · balance scan failed';
      }
    });

    manager.on('disconnect', (reason, message) => {
      walletReady = false;
      setConnection(false);
      scanAddressRecords = [];
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

    if (!restoring) {
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
    $('connect').disabled = false;
  } finally {
    pairingInProgress = false;
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

    const details = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = 'Fungible token';

    const categoryElement = document.createElement('code');
    categoryElement.textContent = category;

    details.append(title, categoryElement);

    const amountElement = document.createElement('span');
    amountElement.className = 'token-amount';
    amountElement.textContent = amount.toString();

    row.append(details, amountElement);
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
    if (!quiet) {
      $('status').textContent = 'Scanning wallet addresses…';
    }

    const scanned = await scanWallet();

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
        `MAINNET transaction\n\n` +
          `Send ${amount.toString()} token units\n` +
          `Category: ${requestedCategory}\n` +
          `To: ${recipient}\n\n` +
          `The wallet will ask you to approve and sign this transaction.`,
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
      userPrompt: `Send ${amount.toString()} fungible token units`,
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
      userPrompt: `Send ${amount.toString()} fungible token units`,
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
      'Forget this saved pairing and create a new WizardConnect session?',
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

$('send').addEventListener('click', sendFungibleTokens);

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

$('generate-payment').addEventListener('click', async () => {
  try {
    if (!walletReady) {
      throw new Error('Connect your wallet before creating a payment QR.');
    }

    const address = addressFor(0, 0, 'p2pkhWithTokens');
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

    $('receive-address').textContent = address;
    $('payment-url').textContent = paymentUrl.toString();

    await QRCode.toCanvas($('payment-qr'), paymentUrl.toString(), {
      width: 190,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#07111b', light: '#ffffff' },
    });

    $('payment-result').classList.remove('hidden');
  } catch (error) {
    report(error);
  }
});

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


fetchBchUsd();

try {
  if (loadSession()?.walletPublicKey) {
    startConnection({ restoring: true }).catch(report);
  }
} catch (error) {
  console.warn('Could not restore previous WizardConnect session:', error);
}
