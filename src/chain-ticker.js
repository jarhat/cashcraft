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

export function setupChainTicker(container, logger = console) {
  let loading = false;
  async function refresh() {
    if (loading || document.hidden) return;
    loading = true;
    try {
      const status = await fetchChainStatus();
      const items = [
        ['Network', 'Mainnet'],
        ['Block height', status.blocks.toLocaleString()],
        ['Latest block', `${status.best_block_hash.slice(0, 12)}…`, status.best_block_hash],
        ['Difficulty', status.difficulty.toLocaleString(undefined, { maximumFractionDigits: 2 })],
        ['Node status', status.syncing ? 'Syncing' : 'Synced'],
      ];
      if (status.syncing) items.push(['Headers', status.headers.toLocaleString()]);
      try {
        const response = await fetch('/api/donation', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`Donation status request failed (${response.status}).`);
        const donation = await response.json();
        if (typeof donation.balance_bch !== 'number' || !Number.isFinite(donation.balance_bch) || donation.balance_bch < 0) {
          throw new Error('Invalid server balance.');
        }
        items.push(['Server balance', `${donation.balance_bch.toLocaleString(undefined, { maximumFractionDigits: 8 })} BCH`]);
      } catch (error) {
        logger.warn('Server balance unavailable:', error);
        items.push(['Server balance', 'Unavailable']);
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
    } catch (error) {
      logger.warn('Blockchain status unavailable:', error);
      container.textContent = 'Blockchain status unavailable.';
    } finally {
      loading = false;
    }
  }
  refresh();
  setInterval(refresh, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}
