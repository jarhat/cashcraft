export const SATOSHIS_PER_BCH = 100_000_000n;

export function formatBch(satoshis) {
  const whole = satoshis / SATOSHIS_PER_BCH;
  const fraction = (satoshis % SATOSHIS_PER_BCH)
    .toString()
    .padStart(8, '0');

  return `${whole.toString()}.${fraction}`;
}

export function utxoKey(utxo) {
  const txid = utxo.txid ?? utxo.txHash;
  const outputIndex = utxo.vout ?? utxo.outputIndex ?? utxo.index;

  if (txid == null || outputIndex == null) return null;
  return `${String(txid).toLowerCase()}:${outputIndex}`;
}

export function normalizeUtxo(utxo, record) {
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

export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
