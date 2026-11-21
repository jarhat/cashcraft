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

export function setupChainTicker(container, logger = console, gameContainer = null) {
  const rendered = new WeakMap();
  function render(target, items) {
    const update = (detail, [, value, title]) => {
      detail.textContent = value;
      detail.title = title || '';
    };
    const previous = rendered.get(target);
    if (previous && previous.labels.length === items.length &&
        items.every(([label], index) => label === previous.labels[index])) {
      for (const details of previous.groups) details.forEach((detail, index) => update(detail, items[index]));
      return;
    }
    const track = document.createElement('div');
    track.className = 'market-ticker-track';
    const groups = [];
    for (let copy = 0; copy < 2; copy++) {
      const group = document.createElement('div');
      const details = [];
      group.className = 'market-ticker-group';
      if (copy) group.setAttribute('aria-hidden', 'true');
      for (const entry of items) {
        const [label] = entry;
        const item = document.createElement('span');
        item.className = 'market-ticker-item';
        const name = document.createElement('strong');
        name.textContent = label;
        if (label === 'MINA ore') name.className = 'mina-label';
        const detail = document.createElement('span');
        update(detail, entry);
        details.push(detail);
        item.append(name, detail);
        group.append(item);
      }
      track.append(group);
      groups.push(details);
    }
    target.replaceChildren(track);
    rendered.set(target, { labels: items.map(([label]) => label), groups });
  }
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
      render(container, items);
      if (gameContainer) {
        const detailed = [];
        if (chain.status === 'fulfilled') {
          const s = chain.value;
          detailed.push(
            ['BCHN', s.syncing ? 'Mainnet / syncing' : 'Mainnet / synced'],
            ['Height', s.blocks.toLocaleString()],
            ['Headers', s.headers.toLocaleString()],
            ['Header lag', (s.headers - s.blocks).toLocaleString()],
            ['Difficulty', s.difficulty.toLocaleString(undefined, { maximumSignificantDigits: 12 })],
            ['Tip hash', s.best_block_hash],
          );
          if (typeof s.verification_progress === 'number' && s.verification_progress >= 0 && s.verification_progress <= 1) {
            detailed.push(['Verification', `${(s.verification_progress * 100).toFixed(5)}%`]);
          }
          if (Number.isSafeInteger(s.median_time) && s.median_time >= 0 && s.median_time <= 8640000000000) {
            detailed.push(['Median block time', new Date(s.median_time * 1000).toISOString()]);
          }
          if (typeof s.chainwork === 'string' && /^[0-9a-f]{1,64}$/.test(s.chainwork)) {
            detailed.push(['Chainwork', `0x${s.chainwork}`]);
          }
          if (Number.isSafeInteger(s.size_on_disk) && s.size_on_disk >= 0) {
            detailed.push(['Block data', `${(s.size_on_disk / 2 ** 30).toFixed(2)} GiB`]);
          }
          if (typeof s.pruned === 'boolean') detailed.push(['Storage', s.pruned ? 'Pruned' : 'Unpruned']);
        } else {
          detailed.push(['BCHN', 'Unavailable']);
        }
        render(gameContainer, [...detailed, ...items.slice(-2)]);
      }
    } finally {
      loading = false;
    }
  }
  refresh();
  setInterval(refresh, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
