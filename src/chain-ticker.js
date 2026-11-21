export async function fetchChainStatus() {
  const response = await fetch('/api/chain-status', {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Chain status request failed (${response.status}).`);
  const status = await response.json();
  if (status.network !== 'mainnet' ||
      !Number.isSafeInteger(status.blocks) || status.blocks < 0 ||
      !Number.isSafeInteger(status.headers) || status.headers < status.blocks ||
      typeof status.difficulty !== 'number' || !Number.isFinite(status.difficulty) || status.difficulty <= 0 ||
      typeof status.best_block_hash !== 'string' || !/^[0-9a-f]{64}$/.test(status.best_block_hash) ||
      typeof status.syncing !== 'boolean') {
    throw new Error('Invalid blockchain status.');
  }
  return status;
}

export async function fetchMinaOreMined() {
  const response = await fetch('/api/mina-ore-mined', {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`MINA ore total request failed (${response.status}).`);
  const data = await response.json();
  if (typeof data.mined !== 'string' || !/^(0|[1-9][0-9]*)$/.test(data.mined)) {
    throw new Error('Invalid MINA ore total.');
  }
  return BigInt(data.mined).toLocaleString();
}

export async function fetchPayoutBalance() {
  const response = await fetch('/api/payout-balance', {
    cache: 'no-store', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Payout balance request failed (${response.status}).`);
  const data = await response.json();
  if (typeof data.satoshis !== 'string' || !/^(0|[1-9][0-9]*)$/.test(data.satoshis)) {
    throw new Error('Invalid payout balance.');
  }
  const amount = BigInt(data.satoshis);
  return `${(amount / 100000000n).toLocaleString()}.${(amount % 100000000n).toString().padStart(8, '0')} BCH`;
}

export function setupChainTicker(container, logger = console) {
  let loading = false;
  async function refresh() {
    if (loading || document.hidden) return;
    loading = true;
    try {
      const [chain, mined, balance] = await Promise.allSettled([
        fetchChainStatus(), fetchMinaOreMined(), fetchPayoutBalance(),
      ]);
      const items = [];
      if (chain.status === 'fulfilled') {
        const status = chain.value;
        items.push(
        ['Network', 'Mainnet'],
        ['Block height', status.blocks.toLocaleString()],
        ['Latest block', `${status.best_block_hash.slice(0, 12)}…`, status.best_block_hash],
        ['Difficulty', status.difficulty.toLocaleString(undefined, { maximumFractionDigits: 2 })],
        ['Node status', status.syncing ? 'Syncing' : 'Synced']
        );
        if (status.syncing) items.push(['Headers', status.headers.toLocaleString()]);
      } else {
        logger.warn('Blockchain status unavailable:', chain.reason);
        items.push(['Blockchain status', 'Unavailable']);
      }
      if (mined.status !== 'fulfilled') logger.warn('MINA ore total unavailable:', mined.reason);
      items.push(['MINA ore', mined.status === 'fulfilled' ? mined.value : 'Unavailable', 'Ore blocks mined since tracking began']);
      if (balance.status === 'fulfilled') items.push(['Payout wallet', balance.value]);
      else {
        logger.warn('Payout wallet balance unavailable:', balance.reason);
        items.push(['Payout wallet', 'Unavailable']);
      }
      const track = document.createElement('div');
      track.className = 'market-ticker-track';
      for (let copy = 0; copy < 2; copy++) {
        const group = document.createElement('div');
        group.className = 'market-ticker-group';
        if (copy) group.setAttribute('aria-hidden', 'true');
        for (const [label, value, title] of items) {
          const item = document.createElement('span');
          item.className = 'market-ticker-item';
          const name = document.createElement('strong');
          name.textContent = label;
          if (label === 'MINA ore') name.className = 'mina-label';
          const detail = document.createElement('span');
          detail.textContent = value;
          if (title) detail.title = title;
          item.append(name, detail);
          group.append(item);
        }
        track.append(group);
      }
      container.replaceChildren(track);
    } finally {
      loading = false;
    }
  }
  refresh();
  setInterval(refresh, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
