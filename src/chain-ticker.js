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

export async function fetchMinaRewardsSent() {
  const response = await fetch('/api/mina-rewards-sent', {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`MINA payout total request failed (${response.status}).`);
  const data = await response.json();
  if (typeof data.sent !== 'string' || !/^(0|[1-9][0-9]*)$/.test(data.sent)) {
    throw new Error('Invalid MINA payout total.');
  }
  return BigInt(data.sent).toLocaleString();
}

export function setupChainTicker(container, logger = console) {
  let loading = false;
  async function refresh() {
    if (loading || document.hidden) return;
    loading = true;
    try {
      const [chain, rewards] = await Promise.allSettled([fetchChainStatus(), fetchMinaRewardsSent()]);
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
      if (rewards.status === 'fulfilled') {
        items.push(['MINA rewards sent', rewards.value]);
      } else {
        logger.warn('MINA payout total unavailable:', rewards.reason);
        items.push(['MINA rewards sent', 'Unavailable']);
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
