export function groupMinaReceipts(receipts) {
  const grouped = new Map();
  let total = 0n;
  for (const entry of receipts) {
    if (!/^[0-9a-f]{64}$/i.test(entry.txid) || !/^[1-9]\d*$/.test(entry.amount)) continue;
    const txid = entry.txid.toLowerCase();
    const amount = BigInt(entry.amount);
    grouped.set(txid, (grouped.get(txid) || 0n) + amount);
    total += amount;
  }
  return { grouped, total };
}
